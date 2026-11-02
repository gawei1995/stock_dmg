import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { AuthorizationGenerationGate } from "../src/data/authorization-generation.mjs";
import { assessArchiveBackupCapacity } from "../src/security/archive-backup-capacity.mjs";
import { describeTrustedBackupSource } from "../src/security/trusted-backup-bundle.mjs";
import { EncryptedStore } from "../src/security/encrypted-store.mjs";
import { SegmentedLedgerStore } from "../src/security/segmented-ledger-store.mjs";
import { PortfolioSnapshotStore } from "../src/data/portfolio-snapshot-store.mjs";

const source = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
function between(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, start);
  return source.slice(first, last);
}
const sha = character => character.repeat(64);
function fixture({ kind = "portfolio", activeCount = 8, archivedCount = 2, confirmation = 1,
  rootBytes = 1024, actualRootBytes = rootBytes, onConfirm, onDrain, onEstimate, onPublish,
  corruptAfter = false, sourceError = false, postSourceError = false } = {}) {
  const calls = [], gate = new AuthorizationGenerationGate();
  let context, changed = false, sourceReads = 0, drainCalls = 0, notices = 0;
  const file = kind === "portfolio" ? "portfolio-snapshots.bin" : "technical-radar.bin";
  const role = kind === "portfolio" ? "portfolio_snapshot_ledger" : "technical_radar";
  const plan = { kind, revision: 1, contentHash: sha("a"), planHash: sha("c"), archiveCount: activeCount - 3,
    retainActiveCount: 3, archivedCount, before: { activeCount },
    after: { activeCount: 3, archivedCount: archivedCount + activeCount - 3 } };
  const publication = bytes => ({ kind, revision: 1, planHash: plan.planHash, root: { name: file, bytes, sha256: sha("d") },
    segment: { name: `ledger-segment-${sha("b")}.bin`, bytes: 2048, sha256: sha("b"), kind } });
  const domain = {
    maxSnapshots: 12000, maxBatches: 400, queue: Promise.resolve(), writeQueue: Promise.resolve(),
    verifyIntegrity: async () => ({ valid: !(changed && corruptAfter), headHash: sha("e") }),
    capacity: async () => ({ activeCount, archivedCount, snapshotCount: activeCount + archivedCount, batchCount: activeCount + archivedCount }),
  };
  const store = {
    planArchive: async input => { calls.push("plan"); assert.equal(input.retainActiveCount, 3); return structuredClone(plan); },
    estimateArchivePublication: async () => { calls.push("estimate"); if (onEstimate) await onEstimate({ context, gate }); return publication(rootBytes); },
    archive: async options => {
      calls.push("archive");
      assert.equal(context.trustedRestoreInProgress, true);
      assert.equal(context.trustedRestoreFilesFrozen, true);
      assert.equal(context.canWriteLedgerStore(kind), false);
      assert.equal(context.canWriteLedgerStore(kind, { writePermit: { kind } }), false);
      assert.equal(context.canWriteLedgerStore(kind, options), true);
      assert.equal(context.canWriteLedgerStore(kind === "portfolio" ? "radar" : "portfolio", options), false);
      options.commitGuard();
      options.publicationGuard({ ...publication(rootBytes), phase: "segment_prepublication" });
      if (onPublish) await onPublish({ context, gate, options });
      options.publicationGuard({ ...publication(actualRootBytes), phase: "root_ciphertext" });
      options.commitGuard();
      changed = true;
      return { archived: true, archiveCount: plan.archiveCount };
    },
    describe: async () => ({ contentHash: plan.contentHash, totalCount: activeCount + archivedCount,
      activeCount: 3, archivedCount: plan.after.archivedCount }),
  };
  context = vm.createContext({
    assessArchiveBackupCapacity, trustedRestoreInProgress: false, trustedRestoreFilesFrozen: false, trustedLedgerArchivePermit: null,
    portfolioSnapshotStore: domain, technicalRadarStore: domain, portfolioSnapshotDataStore: store, technicalRadarDataStore: store,
    currentVerifiedBackupScope: () => ({ scopeId: "fixture" }),
    captureReviewAccountOperation: () => gate.capture(), assertReviewAccountOperation: identity => gate.assertCurrent(identity),
    assertTrustedBackupQuiescent: () => { calls.push("quiescent"); },
    portfolioSnapshotCaptureQueue: Promise.resolve(), portfolioSnapshotCoverageWriteQueue: Promise.resolve(), reviewLearningMutationQueue: Promise.resolve(),
    drainTrustedBackupStores: async () => { drainCalls++; calls.push("drain"); if (onDrain) await onDrain({ context, gate, drainCalls }); },
    describeTrustedBackupSource: async request => {
      sourceReads++; calls.push("source");
      assert.equal(context.trustedRestoreFilesFrozen, true);
      assert.equal(typeof request.validatePayload, "function");
      if (sourceError || (postSourceError && changed)) throw new Error("source unavailable");
      return { schemaVersion: "trading-cockpit-trusted-backup/v4", files: [{ name: file, role, bytes: 4096, sha256: sha("f") }] };
    },
    validateTrustedBackupPayload: async () => ({ document: {} }),
    app: { getPath: () => "/isolated/profile" }, BrowserWindow: { fromWebContents: () => null }, mainWindow: null,
    dialog: { showMessageBox: async (_owner, options) => {
      calls.push("confirm");
      assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0);
      assert.match(options.detail, /全部账户历史/); assert.match(options.detail, /不保证减少总磁盘占用/);
      assert.equal(context.trustedRestoreFilesFrozen, true);
      assert.equal(context.trustedLedgerArchivePermit, null);
      if (onConfirm) await onConfirm({ context, gate, options });
      return { response: confirmation };
    } },
    safeError: error => error.message, publishStorageHealth: () => { notices++; }, reviewSnapshotPublisher: { schedule: () => calls.push("publish") },
  });
  vm.runInContext(between("function canWriteLedgerStore(", "\nfunction describeTrustedRestoreOperations("), context);
  vm.runInContext(between("function assertTrustedRestoreIdle(", "\nfunction isTrustedSender("), context);
  return { context, calls, gate, get changed() { return changed; }, get sourceReads() { return sourceReads; }, get notices() { return notices; },
    invoke: request => context.archiveLedgerWithConfirmation({ sender: {} }, request ?? { kind, retainActiveCount: 3 }) };
}

for (const kind of ["portfolio", "radar"]) test(`${kind}: archive previews, freezes ordinary writers, grants one private permit and verifies before success`, async () => {
  const item = fixture({ kind });
  const result = await item.invoke();
  assert.equal(result.ok, true); assert.equal(result.archived, true); assert.equal(result.canceled, false);
  assert.equal(result.archiveCount, 5); assert.equal(result.activeCount, 3); assert.equal(result.archivedCount, 7); assert.equal(result.totalCount, 10);
  assert.ok(item.calls.indexOf("source") < item.calls.indexOf("confirm"));
  assert.ok(item.calls.indexOf("confirm") < item.calls.indexOf("archive"));
  assert.equal(item.sourceReads, 2);
  assert.equal(item.context.trustedRestoreFilesFrozen, false);
  assert.equal(item.context.trustedRestoreInProgress, false);
  assert.equal(item.context.trustedLedgerArchivePermit, null);
  assert.equal(item.calls.at(-1), "publish");
});

test("archive cancel and no-work preview never publish records, allocate permits or run model/broker tools", async () => {
  for (const options of [{ confirmation: 0 }, { activeCount: 2 }, { activeCount: 0, archivedCount: 0 }]) {
    const item = fixture(options), result = await item.invoke();
    assert.equal(result.archived, false); assert.equal(item.changed, false);
    assert.ok(!item.calls.includes("archive")); assert.ok(!item.calls.includes("publish"));
    assert.equal(item.context.trustedRestoreInProgress, false); assert.equal(item.context.trustedRestoreFilesFrozen, false);
    assert.equal(item.context.trustedLedgerArchivePermit, null);
    if (options.activeCount != null) { assert.ok(!item.calls.includes("confirm")); assert.equal(item.sourceReads, 0); }
  }
});

test("invalid archive input or concurrent maintenance is rejected before reads or dialogs", async () => {
  for (const request of [{ kind: "unknown", retainActiveCount: 3 }, ...[0, -1, 1.5, "3", null, 12001].map(retainActiveCount => ({ kind: "portfolio", retainActiveCount }))]) {
    const item = fixture(); await assert.rejects(item.invoke(request)); assert.deepEqual(item.calls, []);
  }
  const item = fixture(); item.context.trustedRestoreInProgress = true;
  await assert.rejects(item.invoke(), { code: "trusted_restore_in_progress" }); assert.deepEqual(item.calls, []);
});

test("busy analysis and unverified account refuse archive without allocating a write permit", async () => {
  for (const hook of ["assertTrustedBackupQuiescent", "currentVerifiedBackupScope"]) {
    const item = fixture(); item.context[hook] = () => { throw new Error("not ready"); };
    await assert.rejects(item.invoke(), /not ready/);
    assert.equal(item.context.trustedRestoreInProgress, false); assert.equal(item.context.trustedLedgerArchivePermit, null);
    assert.ok(!item.calls.includes("drain"));
  }
});

test("reauthorization during drain, estimate, confirmation or publication stops the old archive", async () => {
  for (const options of [
    { onDrain: ({ gate, drainCalls }) => { if (drainCalls === 2) gate.advance(); } },
    { onEstimate: ({ gate }) => gate.advance() }, { onConfirm: ({ gate }) => gate.advance() },
    { onPublish: ({ gate }) => gate.advance() },
  ]) {
    const item = fixture(options);
    await assert.rejects(item.invoke(), { code: "STALE_LONGBRIDGE_AUTHORIZATION_GENERATION" });
    assert.equal(item.changed, false); assert.equal(item.context.trustedRestoreFilesFrozen, false);
    assert.equal(item.context.trustedRestoreInProgress, false); assert.equal(item.context.trustedLedgerArchivePermit, null);
  }
});

test("backup-capacity failure before preview or at actual root encryption never claims archive success", async () => {
  for (const options of [{ rootBytes: 129 * 1024 * 1024 }, { actualRootBytes: 129 * 1024 * 1024 }, { sourceError: true }]) {
    const item = fixture(options);
    await assert.rejects(item.invoke(), options.sourceError ? /source unavailable/ : { code: "ARCHIVE_BACKUP_FILE_SIZE_LIMIT" });
    assert.equal(item.changed, false); assert.equal(item.context.trustedRestoreFilesFrozen, false);
    assert.equal(item.context.trustedRestoreInProgress, false); assert.equal(item.context.trustedLedgerArchivePermit, null);
    if (options.rootBytes) assert.ok(!item.calls.includes("confirm"));
  }
});

test("a post-commit verification failure retains the write barrier and does not show a successful UI update", async () => {
  for (const options of [{ corruptAfter: true }, { postSourceError: true }]) {
    const item = fixture(options);
    await assert.rejects(item.invoke(), { code: "ARCHIVE_POSTCOMMIT_UNVERIFIED" });
    assert.equal(item.changed, true); assert.equal(item.context.trustedRestoreFilesFrozen, true);
    assert.equal(item.context.trustedRestoreInProgress, true); assert.equal(item.context.trustedLedgerArchivePermit, null);
    assert.equal(item.context.canWriteLedgerStore("portfolio"), false);
    assert.ok(!item.calls.includes("publish"));
  }
});

test("archive IPC accepts only a trusted renderer and startup binds both store layers to the permit gate", () => {
  assert.match(between('ipcMain.handle("review:ledger:archive"', '\n  ipcMain.handle('), /assertTrustedSender\(event\)/);
  assert.equal((source.match(/canWrite: options => canWriteLedgerStore\("portfolio", options\)/g) ?? []).length, 2);
  assert.equal((source.match(/canWrite: options => canWriteLedgerStore\("radar", options\)/g) ?? []).length, 2);
});

test("actual host + encrypted adapter archive preserves the full chain across restart; canceled preview is byte-identical", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cockpit-host-archive-"));
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`fixture:${Buffer.from(value).toString("base64")}`),
    decryptString: bytes => {
      assert.ok(bytes.toString().startsWith("fixture:"));
      return Buffer.from(bytes.toString().slice(8), "base64").toString();
    } };
  let sequence = 0;
  try {
    const item = fixture();
    const create = () => {
      const canWrite = options => item.context.canWriteLedgerStore("portfolio", options);
      const raw = new EncryptedStore({ directory, safeStorage, fileName: "portfolio-snapshots.bin", canWrite });
      const adapter = new SegmentedLedgerStore({ store: raw, kind: "portfolio", canWrite });
      const domain = new PortfolioSnapshotStore({ store: adapter,
        now: () => new Date("2026-09-18T00:00:00Z"), idFactory: () => `fixture-${++sequence}` });
      return { raw, adapter, domain };
    };
    const initial = create();
    for (let index = 0; index < 6; index++) {
      const at = `2026-09-0${index + 1}T21:30:00.000Z`;
      await initial.domain.appendSnapshot({ idempotencyKey: `fixture-${index}`, kind: "manual", capturedAt: at,
        timezone: "America/New_York", accountScope: { scopeId: "fixture", broker: "longbridge",
          accounts: [{ accountRef: "fixture-only", accountType: "margin", baseCurrency: "USD" }] },
        summary: { reportingCurrency: "USD", totalAssets: 1000, cash: 1000, grossExposure: 0, netExposure: 0, longExposure: 0, shortExposure: 0 },
        holdings: [], dataQuality: { status: "complete", completeForPeriodReturn: true, issues: [] },
        fx: { status: "not_required", rates: [] },
        provenance: { provider: "longbridge", transport: "fixture", fetchedAt: at, sourceSnapshotId: `raw-${index}`, freshness: "live" } });
    }
    const expected = await initial.domain.listSnapshots({ limit: null, order: "asc" });
    const before = await readFile(initial.raw.filePath);
    Object.assign(item.context, {
      portfolioSnapshotStore: initial.domain, portfolioSnapshotDataStore: initial.adapter,
      app: { getPath: () => directory }, describeTrustedBackupSource,
      validateTrustedBackupPayload: async ({ payload }) => ({ document: JSON.parse(safeStorage.decryptString(payload)) }),
      drainTrustedBackupStores: () => initial.adapter.drain(),
    });
    item.context.dialog.showMessageBox = async () => ({ response: 0 });
    const canceled = await item.invoke();
    assert.equal(canceled.canceled, true);
    assert.deepEqual(await readFile(initial.raw.filePath), before);
    assert.equal((await readdir(directory)).length, 1);
    item.context.dialog.showMessageBox = async () => ({ response: 1 });
    const result = await item.invoke();
    assert.equal(result.archived, true); assert.equal(result.archiveCount, 3);
    assert.equal(result.totalCount, 6); assert.equal(result.activeCount, 3);
    const restarted = create();
    assert.deepEqual(await restarted.domain.listSnapshots({ limit: null, order: "asc" }), expected);
    assert.equal((await restarted.domain.verifyIntegrity()).valid, true);
    assert.equal((await restarted.domain.capacity()).archivedCount, 3);
    assert.equal((await readdir(directory)).length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
