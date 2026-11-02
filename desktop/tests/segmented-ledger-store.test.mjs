import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EncryptedStore } from "../src/security/encrypted-store.mjs";
import { SegmentedLedgerStore, SEGMENTED_LEDGER_POLICIES, SEGMENTED_LEDGER_SCHEMA_VERSION,
  LEDGER_SEGMENT_NAME_PATTERN, inspectSegmentedLedgerReferences } from "../src/security/segmented-ledger-store.mjs";
import { PortfolioSnapshotStore } from "../src/data/portfolio-snapshot-store.mjs";
import { TechnicalRadarStore } from "../src/data/technical-radar-store.mjs";
import { assessArchiveBackupCapacity } from "../src/security/archive-backup-capacity.mjs";
import { TRUSTED_BACKUP_LIMITS, TRUSTED_BACKUP_SCHEMA_VERSION } from "../src/security/trusted-backup-bundle.mjs";

// Deliberately reversible isolated test cipher. No macOS keychain, profile,
// real account or network is consulted by these tests.
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`isolated-cipher:${Buffer.from(value).toString("base64")}`),
  decryptString: value => {
    const text = value.toString();
    if (!text.startsWith("isolated-cipher:")) throw new Error("invalid fixture ciphertext");
    return Buffer.from(text.slice("isolated-cipher:".length), "base64").toString();
  },
};
const hash = value => createHash("sha256").update(String(value)).digest("hex");

async function withFixture(kind, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cockpit-segments-test-"));
  const policy = SEGMENTED_LEDGER_POLICIES[kind];
  const state = { writable: true, available: true, sequence: 0 };
  const cipher = { ...safeStorage, isEncryptionAvailable: () => state.available };
  const restart = () => {
    const base = new EncryptedStore({ directory, safeStorage: cipher, fileName: policy.fileName,
      canWrite: () => state.writable });
    const store = new SegmentedLedgerStore({ store: base, kind, canWrite: () => state.writable });
    const domain = kind === "portfolio"
      ? new PortfolioSnapshotStore({ store, now: () => new Date("2026-09-18T00:00:00.000Z"), idFactory: () => `snapshot-${++state.sequence}` })
      : new TechnicalRadarStore({ store });
    return { base, store, domain };
  };
  try { await run({ directory, kind, policy, state, restart, ...restart() }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function input(index, kind, scope = "scope-a") {
  const date = `2026-09-${String(1 + index).padStart(2, "0")}`;
  if (kind === "radar") return {
    accountScopeId: `lb-account:${scope}`, tradingDate: date,
    computedAt: `${date}T21:05:00.000Z`, recordedAt: `${date}T21:06:00.000Z`,
    inputHash: hash(`batch-${index}`), scannerVersion: "tier-a/test",
    summary: { symbolCount: 1 }, items: [{ symbol: "AAPL.US", observation: "historical evidence ".repeat(40) }], limitations: [],
  };
  return {
    idempotencyKey: `manual:${scope}:${date}`, kind: "manual", capturedAt: `${date}T21:30:00.000Z`,
    timezone: "America/New_York", accountScope: { scopeId: scope, broker: "longbridge",
      accounts: [{ accountRef: "test-account-us", accountType: "margin", baseCurrency: "USD" }] },
    summary: { reportingCurrency: "USD", totalAssets: 100_000, cash: 20_000,
      grossExposure: 80_000, netExposure: 80_000, longExposure: 80_000, shortExposure: 0 },
    holdings: [{ accountRef: "test-account-us", symbol: "AAPL.US", assetType: "equity", currency: "USD",
      quantity: 100, marketPrice: 200, marketValue: 20_000, valueInReportingCurrency: 20_000, weight: 0.2 }],
    dataQuality: { status: "complete", completeForPeriodReturn: true, issues: [] },
    fx: { status: "not_required", rates: [] },
    provenance: { provider: "longbridge", transport: "openapi", fetchedAt: `${date}T21:30:00.000Z`,
      sourceSnapshotId: `source-${index}`, freshness: "live" },
  };
}
async function append(item, index, scope) {
  return item.kind === "portfolio" ? item.domain.appendSnapshot(input(index, item.kind, scope))
    : item.domain.appendBatch(input(index, item.kind, scope));
}
async function seed(item, count = 5) { for (let i = 0; i < count; i++) await append(item, i, i % 2 ? "scope-b" : "scope-a"); }
const segmentNames = async directory => (await readdir(directory)).filter(name => LEDGER_SEGMENT_NAME_PATTERN.test(name));

for (const kind of ["portfolio", "radar"]) {
  test(`${kind}: explicit prefix archival reconstructs every original record and preserves domain hashes across restart`, async () => {
    await withFixture(kind, async item => {
      const { store, base, policy, directory, restart } = item;
      await seed(item);
      await store.set("sidecar", { coverage: ["unchanged"], watchlist: ["AAPL.US"] });
      const before = await store.get(policy.key);
      const fullBytes = Buffer.byteLength(JSON.stringify(before));
      assert.equal((await store.measureLedger(before)).activeBytes, fullBytes, "unsegmented capacity semantics stay identical");
      const plan = await store.planArchive({ retainActiveCount: 2 });
      assert.equal(plan.archiveCount, 3);
      assert.equal(plan.revision, 0);
      const result = await store.archive({ plan, confirmed: true });
      assert.equal(result.archived, true);
      const envelope = await base.get(policy.key);
      assert.equal(envelope.schemaVersion, SEGMENTED_LEDGER_SCHEMA_VERSION);
      assert.equal(envelope.archivedCount, 3);
      assert.equal(envelope.activeRecords.length, 2);
      assert.deepEqual(await store.get(policy.key), before);
      assert.deepEqual((await store.readAll())[policy.key], before);
      assert.deepEqual(await store.get("sidecar"), { coverage: ["unchanged"], watchlist: ["AAPL.US"] });
      assert.equal((await item.domain.verifyIntegrity()).valid, true);
      const later = restart();
      assert.deepEqual(await later.store.get(policy.key), before);
      assert.equal((await later.domain.verifyIntegrity()).valid, true);
      const description = await later.store.describe();
      assert.equal(description.archivedCount, 3);
      assert.equal(description.activeCount, 2);
      assert.equal(description.totalCount, 5);
      assert.equal(description.totalBytes, fullBytes);
      assert.ok(description.activeBytes < description.totalBytes);
      assert.equal(description.ciphertextFiles.length, 2);
      const usage = await later.store.diskUsage();
      assert.equal(usage.bytes, description.ciphertextBytes);
      assert.equal(usage.fileCount, 2);
      assert.equal(usage.basis, "encrypted_root_and_referenced_segments");
      const references = inspectSegmentedLedgerReferences(await base.readAll(), { kind });
      assert.equal(references.length, 1);
      assert.equal(references[0].recordCount, 3);
      assert.equal(references[0].startIndex, 0);
      assert.match(references[0].chain.firstRecordHash, /^[a-f0-9]{64}$/);
      const bytes = await readFile(path.join(directory, references[0].name));
      assert.equal(hash(bytes.toString()), references[0].sha256);
      assert.doesNotMatch(bytes.toString(), /AAPL|scope-a|account-us/);
    });
  });

  test(`${kind}: appends and a second archive extend the same chain without hiding earlier scopes`, async () => {
    await withFixture(kind, async item => {
      await seed(item, 4);
      const firstPlan = await item.store.planArchive({ retainActiveCount: 1 });
      await item.store.archive({ plan: firstPlan, confirmed: true });
      await append(item, 4, "scope-a");
      const before = await item.store.get(item.policy.key);
      assert.equal((await item.store.measureLedger(before)).archivedCount, 3);
      const secondPlan = await item.store.planArchive({ retainActiveCount: 1 });
      assert.equal(secondPlan.archiveCount, 1);
      await item.store.archive({ plan: secondPlan, confirmed: true });
      const later = item.restart();
      assert.deepEqual(await later.store.get(item.policy.key), before);
      const summary = await later.store.describe();
      assert.equal(summary.archivedCount, 4);
      assert.equal(summary.ciphertextFiles.length, 3);
      assert.equal((await later.domain.verifyIntegrity()).valid, true);
      if (kind === "portfolio") {
        const month = await later.domain.queryTradingPeriod({ startTradingDate: "2026-09-01", endTradingDate: "2026-09-30", scopeId: "scope-a" });
        assert.equal(month.snapshots.length, 3);
        const nearest = await later.domain.findNearestSnapshot({ scopeId: "scope-a", at: "2026-09-01T22:00:00.000Z" });
        assert.equal(nearest.capturedAt, "2026-09-01T21:30:00.000Z");
      } else {
        assert.equal((await later.domain.listBatches({ accountScopeId: "lb-account:scope-a" })).length, 3);
        assert.equal((await later.domain.listBatches({ toTradingDate: "2026-09-02" })).length, 2);
      }
    });
  });
}

test("archive requires explicit confirmation and rejects stale revision/content approvals without creating files", async () => {
  await withFixture("radar", async item => {
    await seed(item, 3);
    const plan = await item.store.planArchive({ retainActiveCount: 1 });
    await assert.rejects(item.store.archive({ plan }), { code: "ARCHIVE_CONFIRMATION_REQUIRED" });
    await append(item, 3);
    await assert.rejects(item.store.archive({ plan, confirmed: true }), { code: "ARCHIVE_PLAN_STALE" });
    assert.deepEqual(await segmentNames(item.directory), []);
    const current = await item.store.planArchive({ retainActiveCount: 1 });
    await item.store.archive({ plan: current, confirmed: true });
    const names = await segmentNames(item.directory);
    await assert.rejects(item.store.archive({ plan: current, confirmed: true }), { code: "ARCHIVE_PLAN_STALE" });
    assert.deepEqual(await segmentNames(item.directory), names);
  });
});

test("capacity refuses a root layout changed after loading, even when the full ledger hash is unchanged", async () => {
  await withFixture("portfolio", async item => {
    await seed(item, 4);
    const stale = item.store;
    await stale.get(item.policy.key);
    const concurrent = item.restart();
    const plan = await concurrent.store.planArchive({ retainActiveCount: 1 });
    await concurrent.store.archive({ plan, confirmed: true });
    await assert.rejects(stale.describe(), { code: "SEGMENT_MEASUREMENT_CHANGED" });
    const unknown = await stale.diskUsage();
    assert.equal(unknown.bytes, null);
    assert.equal(unknown.exists, null);
    assert.equal(stale.health().state, "degraded");
    const fresh = await item.restart().store.diskUsage();
    assert.equal(fresh.fileCount, 2);
    assert.ok(fresh.bytes > 0);
  });
});

test("set/update/delete reject changing archived prefixes while preserving unrelated keys atomically", async () => {
  await withFixture("portfolio", async item => {
    await seed(item, 3);
    const original = await item.store.get(item.policy.key);
    await item.store.archive({ plan: await item.store.planArchive({ retainActiveCount: 1 }), confirmed: true });
    const beforeBytes = await readFile(item.base.filePath);
    const modified = structuredClone(original);
    modified.snapshots[0].summary.cash++;
    await assert.rejects(item.store.set(item.policy.key, modified), { code: "SEGMENT_HISTORY_IMMUTABLE" });
    await assert.rejects(item.store.measureLedger(modified), { code: "SEGMENT_HISTORY_IMMUTABLE" });
    await assert.rejects(item.store.update({ [item.policy.key]: modified, sidecar: "must-not-save" }), { code: "SEGMENT_HISTORY_IMMUTABLE" });
    await assert.rejects(item.store.delete(item.policy.key), { code: "SEGMENT_HISTORY_IMMUTABLE" });
    assert.equal(await item.store.get("sidecar"), undefined);
    assert.deepEqual(await readFile(item.base.filePath), beforeBytes);
    await item.store.update({ coverage: { revision: 2 }, watchlist: ["AAPL.US"] });
    await item.store.delete("watchlist");
    assert.deepEqual(await item.store.get("coverage"), { revision: 2 });
    assert.equal(await item.store.get("watchlist"), undefined);
    assert.deepEqual(await item.store.get(item.policy.key), original);
  });
});

test("failed root commit leaves an unreferenced encrypted segment, never a partial logical archive", async () => {
  await withFixture("radar", async item => {
    await seed(item, 3);
    const before = await item.store.get(item.policy.key), rootBytes = await readFile(item.base.filePath);
    const plan = await item.store.planArchive({ retainActiveCount: 1 });
    item.base.fileIO.renameSync = () => { throw new Error("isolated root commit failure"); };
    await assert.rejects(item.store.archive({ plan, confirmed: true }), { code: "STORAGE_WRITE_FAILED" });
    assert.deepEqual(await readFile(item.base.filePath), rootBytes);
    assert.deepEqual(await item.store.get(item.policy.key), before);
    assert.equal((await segmentNames(item.directory)).length, 1, "unreferenced ciphertext is retained, not mistaken for history");
    const restarted = item.restart();
    assert.equal((await restarted.store.describe()).archivedCount, 0);
    assert.equal((await restarted.store.describe()).ciphertextFiles.length, 1);
    await restarted.store.archive({ plan, confirmed: true });
    assert.equal((await restarted.store.describe()).archivedCount, 2);
    assert.equal((await segmentNames(item.directory)).length, 1, "identical immutable ciphertext is reused without overwrite");
  });
});

for (const failure of ["write", "sync", "readback", "publish"]) {
  test(`${failure} failure before segment publication cannot change the root or remove records`, async () => {
    await withFixture("radar", async item => {
      await seed(item, 3);
      const before = await item.store.get(item.policy.key), bytes = await readFile(item.base.filePath);
      const plan = await item.store.planArchive({ retainActiveCount: 1 });
      if (failure === "publish") item.store.fileIO.linkSync = () => { throw new Error("isolated publication failure"); };
      else if (failure === "readback") item.store.fileIO.readFile = async () => Buffer.from("corrupt readback");
      else {
        const actualOpen = item.store.fileIO.open;
        item.store.fileIO.open = async (...args) => {
          const handle = await actualOpen(...args);
          const operation = failure === "write" ? "writeFile" : "sync";
          handle[operation] = async () => { throw new Error(`isolated ${failure} failure`); };
          return handle;
        };
      }
      await assert.rejects(item.store.archive({ plan, confirmed: true }));
      assert.deepEqual(await readFile(item.base.filePath), bytes);
      assert.deepEqual(await item.store.get(item.policy.key), before);
      assert.deepEqual(await segmentNames(item.directory), []);
      assert.ok((await readdir(item.directory)).every(name => !name.endsWith(".tmp")));
    });
  });
}

test("restore freeze and caller identity changes are checked at the root's final atomic commit", async () => {
  for (const mode of ["freeze", "identity"]) await withFixture("portfolio", async item => {
    await seed(item, 3);
    const bytes = await readFile(item.base.filePath), before = await item.store.get(item.policy.key);
    let current = true;
    const actualOpen = item.base.fileIO.open;
    item.base.fileIO.open = async (...args) => {
      const handle = await actualOpen(...args), sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); if (mode === "freeze") item.state.writable = false; else current = false; };
      return handle;
    };
    await assert.rejects(item.store.archive({ plan: await item.store.planArchive({ retainActiveCount: 1 }),
      confirmed: true, commitGuard: () => current }), error => ["STALE_STORAGE_COMMIT", "STALE_SEGMENT_COMMIT"].includes(error.code));
    assert.deepEqual(await readFile(item.base.filePath), bytes);
    assert.deepEqual(await item.store.get(item.policy.key), before);
    const disk = item.restart();
    assert.equal((await disk.store.describe()).archivedCount, 0);
  });
});

test("missing, corrupt and symlink segments fail closed instead of returning only the active tail", async () => {
  for (const mode of ["missing", "corrupt", "symlink"]) await withFixture("radar", async item => {
    await seed(item, 3);
    await item.store.archive({ plan: await item.store.planArchive({ retainActiveCount: 1 }), confirmed: true });
    const ref = (await item.base.get(item.policy.key)).segments[0];
    const filename = path.join(item.directory, ref.name);
    if (mode === "missing") await rm(filename);
    else if (mode === "corrupt") await writeFile(filename, Buffer.from("changed"));
    else {
      const duplicate = path.join(item.directory, "isolated-duplicate.bin");
      await writeFile(duplicate, await readFile(filename));
      await rm(filename); await symlink(duplicate, filename);
    }
    const restarted = item.restart();
    await assert.rejects(restarted.store.get(item.policy.key), error => error.code.startsWith("SEGMENT_"));
    assert.equal((await restarted.domain.verifyIntegrity()).valid, false);
    await assert.rejects(restarted.store.flush());
    assert.equal(restarted.store.health().state, "degraded");
  });
});

test("pure backup reference inspection rejects unknown schemas, cross-kind refs and path traversal", async () => {
  await withFixture("radar", async item => {
    await seed(item, 3);
    await item.store.archive({ plan: await item.store.planArchive({ retainActiveCount: 1 }), confirmed: true });
    const root = await item.base.readAll();
    for (const mutate of [
      envelope => { envelope.schemaVersion = "segmented-encrypted-ledger/v999"; },
      envelope => { envelope.kind = "portfolio"; },
      envelope => { envelope.segments[0].name = "../secure-state.bin"; },
      envelope => { envelope.segments[0].startIndex = 1; },
      envelope => { envelope.segments[0].chain.lastRecordHash = "0".repeat(64); },
    ]) {
      const tampered = structuredClone(root); mutate(tampered[item.policy.key]);
      assert.throws(() => inspectSegmentedLedgerReferences(tampered, { kind: "radar" }));
    }
    assert.deepEqual(inspectSegmentedLedgerReferences({ [item.policy.key]: { batches: [] } }, { kind: "radar" }), []);
    const rawEnvelope = await item.base.get(item.policy.key);
    const other = item.restart();
    await assert.rejects(other.store.set(item.policy.key, rawEnvelope));
  });
});

test("initial restore barrier and unavailable encryption never create a segment or plaintext fallback", async () => {
  await withFixture("radar", async item => {
    await seed(item, 3);
    const plan = await item.store.planArchive({ retainActiveCount: 1 });
    item.state.writable = false;
    await assert.rejects(item.store.archive({ plan, confirmed: true }), { code: "STALE_SEGMENT_COMMIT" });
    item.state.writable = true; item.state.available = false;
    await assert.rejects(item.store.archive({ plan, confirmed: true }), { code: "STORAGE_ENCRYPTION_UNAVAILABLE" });
    assert.deepEqual(await segmentNames(item.directory), []);
    assert.equal(item.store.persistent, false);
  });
});

test("sidecar writes remain serialized with archival, and drain never rewrites committed root bytes", async () => {
  await withFixture("radar", async item => {
    await seed(item, 3);
    const before = await item.store.get(item.policy.key), plan = await item.store.planArchive({ retainActiveCount: 0 });
    await Promise.all([
      item.store.archive({ plan, confirmed: true }),
      item.store.set("watchlist", { revision: 7 }),
      item.store.set("linkage", { revision: 8 }),
    ]);
    assert.deepEqual(await item.store.get(item.policy.key), before);
    assert.deepEqual(await item.store.get("watchlist"), { revision: 7 });
    assert.deepEqual(await item.store.get("linkage"), { revision: 8 });
    const bytes = await readFile(item.base.filePath);
    item.state.writable = false; await item.store.drain();
    assert.deepEqual(await readFile(item.base.filePath), bytes);
    const summary = await item.store.describe();
    assert.equal(summary.archivedCount, 3); assert.equal(summary.activeCount, 0);
  });
});

test("archive publication preview is read-only, includes sidecars, and keeps randomized ciphertext out of approval identity", async () => {
  await withFixture("portfolio", async item => {
    await seed(item, 4);
    await item.store.set("coverage", { notes: "retained sidecar ".repeat(400) });
    const plan = await item.store.planArchive({ retainActiveCount: 1 });
    const rootBytes = await readFile(item.base.filePath), names = await readdir(item.directory);
    let nonce = 0;
    const cipher = { ...safeStorage, encryptString: value => safeStorage.encryptString(`${value}${" ".repeat(++nonce * 64)}`) };
    item.base.safeStorage = cipher; item.store.safeStorage = cipher;
    const first = await item.store.estimateArchivePublication({ plan });
    const second = await item.store.estimateArchivePublication({ plan });
    assert.equal(first.planHash, plan.planHash); assert.equal(second.planHash, plan.planHash);
    assert.notEqual(first.segment.sha256, second.segment.sha256);
    assert.notEqual(first.root.sha256, second.root.sha256);
    assert.equal(first.segment.recordCount, 3);
    assert.ok(first.root.bytes > 4000, "root estimate includes non-ledger sidecars");
    assert.deepEqual(await item.store.planArchive({ retainActiveCount: 1 }), plan);
    assert.deepEqual(await readFile(item.base.filePath), rootBytes);
    assert.deepEqual(await readdir(item.directory), names);
    const publications = [];
    await item.store.archive({ plan, confirmed: true, publicationGuard: publication => { publications.push(publication); return true; } });
    assert.deepEqual(publications.map(item => item.phase), ["segment_prepublication", "segment_prepublication", "root_ciphertext", "root_ciphertext"]);
    assert.deepEqual(publications.slice(2).map(item => item.rootCommitPhase), ["before_write", "before_commit"]);
    const final = publications.at(-1), actualRoot = await readFile(item.base.filePath);
    assert.equal(final.root.bytes, actualRoot.length); assert.equal(final.root.sha256, hash(actualRoot));
    assert.equal(final.basis, "actual_root_ciphertext");
    const actualSegment = await readFile(path.join(item.directory, final.segment.name));
    assert.equal(final.segment.bytes, actualSegment.length);
    assert.equal(final.segment.sha256, hash(actualSegment));
    assert.ok(final.root.bytes > publications[0].root.bytes, "actual root size is rechecked even when encryption size changes");
  });
});

test("publication rejection before a segment writes nothing; actual root rejection leaves only an unreferenced segment", async () => {
  for (const phase of ["segment_prepublication", "root_ciphertext"]) await withFixture("radar", async item => {
    await seed(item, 3);
    const plan = await item.store.planArchive({ retainActiveCount: 1 });
    const before = await readFile(item.base.filePath), ledger = await item.store.get(item.policy.key);
    await assert.rejects(item.store.archive({ plan, confirmed: true,
      publicationGuard: publication => publication.phase !== phase }), { code: "ARCHIVE_PUBLICATION_REJECTED" });
    assert.deepEqual(await readFile(item.base.filePath), before);
    assert.deepEqual(await item.store.get(item.policy.key), ledger);
    assert.equal((await segmentNames(item.directory)).length, phase === "segment_prepublication" ? 0 : 1);
    assert.equal((await item.restart().store.describe()).archivedCount, 0);
  });
});

test("final publication budget is rechecked after root fsync and async guards are rejected", async () => {
  await withFixture("radar", async item => {
    await seed(item, 3);
    const plan = await item.store.planArchive({ retainActiveCount: 1 }), original = await readFile(item.base.filePath);
    await assert.rejects(item.store.archive({ plan, confirmed: true,
      publicationGuard: publication => publication.rootCommitPhase !== "before_commit" }), { code: "ARCHIVE_PUBLICATION_REJECTED" });
    assert.deepEqual(await readFile(item.base.filePath), original);
    for (const publicationGuard of [async () => true, () => Promise.resolve(true)]) {
      await assert.rejects(item.store.archive({ plan, confirmed: true, publicationGuard }), TypeError);
      assert.deepEqual(await readFile(item.base.filePath), original);
    }
  });
});

test("frozen archive permits are identity checked in adapter and base without opening ordinary writes", async () => {
  await withFixture("radar", async item => {
    await seed(item, 3);
    const permit = {}, fakePermit = {}; let permitValid = true;
    item.state.writable = false;
    const canWrite = ({ writePermit }) => permitValid && writePermit === permit;
    item.store.canWrite = canWrite; item.base.canWrite = canWrite;
    const plan = await item.store.planArchive({ retainActiveCount: 1 });
    await item.store.estimateArchivePublication({ plan });
    await assert.rejects(item.store.set("sidecar", 1));
    await assert.rejects(item.store.archive({ plan, confirmed: true, writePermit: fakePermit }));
    await item.store.archive({ plan, confirmed: true, writePermit: permit, publicationGuard: () => true });
    assert.equal((await item.store.describe()).archivedCount, 2);
    await assert.rejects(item.store.set("sidecar", 1));
    await item.store.flush({ writePermit: permit });
    permitValid = false;
    await assert.rejects(item.store.flush({ writePermit: permit }));
    assert.equal(await item.store.get("sidecar"), undefined);
  });
});

test("the actual root ciphertext can exceed a preview budget and is rejected without committing the logical archive", async () => {
  await withFixture("radar", async item => {
    await seed(item, 3);
    const original = await readFile(item.base.filePath), plan = await item.store.planArchive({ retainActiveCount: 1 });
    let nonce = 0;
    const cipher = { ...safeStorage, encryptString: value => safeStorage.encryptString(`${value}${" ".repeat(++nonce * 1024)}`) };
    item.base.safeStorage = cipher; item.store.safeStorage = cipher;
    const preview = await item.store.estimateArchivePublication({ plan });
    // This is a pure synthetic frozen capacity baseline: descriptors represent
    // other verified immutable files; no large allocation or file is created.
    const files = [{ name: item.policy.fileName, role: "technical_radar", bytes: original.length, sha256: hash(original) }];
    let remaining = TRUSTED_BACKUP_LIMITS.maxTotalBytes - preview.root.bytes - preview.segment.bytes - 128;
    for (let index = 1; remaining > 0; index++) {
      const bytes = Math.min(remaining, TRUSTED_BACKUP_LIMITS.maxFileBytes), digest = hash(`other-${index}`);
      files.push({ name: `ledger-segment-${digest}.bin`, role: "immutable_ledger_segment", bytes, sha256: digest });
      remaining -= bytes;
    }
    const sourceDescription = { schemaVersion: TRUSTED_BACKUP_SCHEMA_VERSION, files };
    assert.equal(assessArchiveBackupCapacity({ sourceDescription, publication: preview }).allowed, true);
    nonce = 0;
    const phases = [];
    await assert.rejects(item.store.archive({ plan, confirmed: true, publicationGuard: publication => {
      phases.push(publication.phase);
      assessArchiveBackupCapacity({ sourceDescription, publication }); return true;
    } }), { code: "ARCHIVE_BACKUP_TOTAL_SIZE_LIMIT" });
    assert.deepEqual(phases, ["segment_prepublication", "segment_prepublication", "root_ciphertext"]);
    assert.deepEqual(await readFile(item.base.filePath), original);
    assert.equal((await item.restart().store.describe()).archivedCount, 0);
    assert.equal((await segmentNames(item.directory)).length, 1, "only an unreferenced encrypted segment can remain");
  });
});
