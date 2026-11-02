import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { AuthorizationGenerationGate } from "../src/data/authorization-generation.mjs";
import { validateBusinessStateDocument } from "../src/security/business-state-store.mjs";
import { RESEARCH_THESIS_STORE_KEY, validateResearchThesisState } from "../src/data/research-thesis-store.mjs";

// Real host handler/helpers, in-memory native dialogs, cipher and store doubles.
// Reading the repository source is the only filesystem access in these tests.
const source = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
function between(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, start);
  return source.slice(first, last);
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const detached = value => JSON.parse(JSON.stringify(value));

function fixture({ canceled = false, filePath = "/isolated/result.tcbackup", onDialog, onExport,
  onFlush, onDrain, exported = null } = {}) {
  const handlers = new Map(), events = [], gate = new AuthorizationGenerationGate();
  const state = { dialogCalls: 0, exportCalls: 0, published: 0, decryptCalls: 0, encryptionAvailable: true, inputs: [] };
  let scope = "scope-a", verified = true, context;
  const lockState = () => [context.trustedRestoreInProgress, context.trustedRestoreFilesFrozen];
  const controls = () => ({ context, state, gate, setScope: value => { scope = value; } });
  const store = name => ({
    flush: async () => { events.push(["flush", name, ...lockState()]); await onFlush?.({ name, ...controls() }); },
    drain: async () => { events.push(["drain", name, ...lockState()]); await onDrain?.({ name, ...controls() }); },
  });
  context = vm.createContext({
    path, Buffer, Date,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    assertTrustedSender() {}, BrowserWindow: { fromWebContents: () => null }, mainWindow: null,
    localDateInTimezone: () => "2026-09-18",
    dialog: { showSaveDialog: async (_owner, options) => {
      state.dialogCalls++; events.push(["dialog", ...lockState()]);
      assert.match(options.defaultPath, /交易驾驶舱备份-2026-09-18\.tcbackup$/);
      await onDialog?.(controls());
      return { canceled, filePath };
    } },
    app: { getPath: name => `/isolated/${name}`, getVersion: () => "0.24.5-test" },
    trustedRestoreInProgress: false, trustedRestoreFilesFrozen: false,
    technicalRadarRunPromise: null, tradeHistoryService: { busy: false }, activeAgentOperations: new Map(),
    longbridge: { connecting: false }, longbridgeAuthorizationLifecycle: gate, portfolioSnapshotSweep: null,
    portfolioSnapshotCaptureQueue: Promise.resolve(), portfolioSnapshotCoverageWriteQueue: Promise.resolve(), reviewLearningMutationQueue: Promise.resolve(),
    agentResults: { mutationQueue: Promise.resolve() },
    businessStateStore: store("business"), reviewDataStore: store("review"), marketHistoryDataStore: store("market"),
    portfolioSnapshotDataStore: store("portfolio"), technicalRadarDataStore: store("radar"),
    currentPortfolioLedgerScopeId: () => scope,
    currentPortfolioAccountScopeStatus: () => ({ verified, identity: verified ? { scopeId: scope, verified: true } : null }),
    stalePortfolioAccountScopeError: () => Object.assign(new Error("isolated scope changed"), { code: "STALE_SCOPE" }),
    safeStorage: {
      isEncryptionAvailable: () => state.encryptionAvailable,
      decryptString: bytes => { state.decryptCalls++; return bytes.toString("utf8"); },
    },
    codexAnalysis: { workspaceDirectory: "/isolated/workspace" },
    // Convert only the VM realm prototype; run the real semantic validator.
    validateBusinessStateDocument: (value, options) => validateBusinessStateDocument(detached(value), options),
    RESEARCH_THESIS_STORE_KEY,
    validateResearchThesisState: value => validateResearchThesisState(detached(value)),
    createTrustedBackupBundle: async input => {
      state.exportCalls++; state.inputs.push(input); events.push(["export", ...lockState()]);
      assert.equal(input.validatePayload, context.validateTrustedBackupPayload, "uses the real document-returning host callback");
      assert.equal(typeof input.commitGuard, "function", "identity is checked before native bundle publication");
      input.commitGuard();
      await onExport?.({ input, ...controls() });
      input.commitGuard(); state.published++;
      return exported ?? { bundleDirectory: filePath, created: true, idempotent: false,
        files: [{ name: "review-data.bin" }, { name: "ledger-segment-fixture.bin" }] };
    },
  });
  for (const [start, end] of [
    ["function assertTrustedRestoreIdle(", "\nfunction isTrustedSender("],
    ["function currentVerifiedBackupScope(", "\nasync function technicalRadarUiSnapshot("],
    ["function captureReviewAccountOperation(", "\nfunction invalidateLongbridgeAuthorizationLifecycle("],
    ['  ipcMain.handle("review:backup:export"', '\n  ipcMain.handle("review:backup:restore"'],
  ]) vm.runInContext(between(start, end), context);
  return { context, state, events, gate, setScope: value => { scope = value; }, setVerified: value => { verified = value; },
    invoke: () => handlers.get("review:backup:export")({ sender: {} }) };
}
function assertUnlocked(item) {
  assert.equal(item.context.trustedRestoreInProgress, false);
  assert.equal(item.context.trustedRestoreFilesFrozen, false);
}

test("native export cancellation or an empty destination never freezes or touches business stores", async () => {
  for (const options of [{ canceled: true }, { filePath: "" }]) {
    const item = fixture(options), result = await item.invoke();
    assert.deepEqual(detached(result), { ok: false, canceled: true });
    assert.deepEqual(item.events, [["dialog", false, false]]);
    assert.equal(item.state.exportCalls, 0);
    assertUnlocked(item);
  }
});

test("native dialog errors do not create a hidden export lock", async () => {
  const failure = new Error("isolated native dialog failure");
  const item = fixture({ onDialog: () => { throw failure; } });
  await assert.rejects(item.invoke(), error => error === failure);
  assert.equal(item.state.exportCalls, 0); assertUnlocked(item);
});

test("export refuses all in-flight analysis, broker and snapshot work before starting a freeze", async () => {
  for (const configure of [
    context => { context.technicalRadarRunPromise = Promise.resolve(); },
    context => { context.tradeHistoryService.busy = true; },
    context => { context.activeAgentOperations.set("fixture-agent", {}); },
    context => { context.longbridge.connecting = true; },
    context => { context.longbridgeAuthorizationLifecycle.inFlight.set(0, new Set([Promise.resolve()])); },
    context => { context.portfolioSnapshotSweep = Promise.resolve(); },
  ]) {
    const item = fixture(); configure(item.context);
    await assert.rejects(item.invoke(), /仍有分析、同步或采集任务/);
    assert.equal(item.state.exportCalls, 0);
    assert.equal(item.events.some(([type]) => type === "flush"), false);
    assertUnlocked(item);
  }
});

test("existing restore locks are preserved before and after a native destination dialog", async () => {
  const locked = fixture();
  locked.context.trustedRestoreInProgress = true; locked.context.trustedRestoreFilesFrozen = true;
  await assert.rejects(locked.invoke(), { code: "trusted_restore_in_progress" });
  assert.equal(locked.state.dialogCalls, 0);
  assert.equal(locked.context.trustedRestoreFilesFrozen, true);
  const item = fixture({ onDialog: ({ context }) => {
    context.trustedRestoreInProgress = true; context.trustedRestoreFilesFrozen = true;
  } });
  await assert.rejects(item.invoke(), { code: "trusted_restore_in_progress" });
  assert.equal(item.state.exportCalls, 0);
  assert.equal(item.context.trustedRestoreInProgress, true);
  assert.equal(item.context.trustedRestoreFilesFrozen, true);
});

test("export freezes the actual file-copy interval, drains without rewriting frozen roots, and unlocks on success", async () => {
  const entered = deferred(), finish = deferred();
  const item = fixture({ onExport: async ({ input, context }) => {
    assert.equal(context.trustedRestoreInProgress, true); assert.equal(context.trustedRestoreFilesFrozen, true);
    assert.equal(input.sourceDirectory, "/isolated/userData");
    assert.equal(input.destinationDirectory, "/isolated/result.tcbackup");
    assert.equal(input.accountScope.scopeId, "scope-a");
    const result = await input.validatePayload({ name: "portfolio-snapshots.bin", payload: Buffer.from('{"ledger":"fixture"}') });
    assert.deepEqual(detached(result), { document: { ledger: "fixture" } });
    entered.resolve(); await finish.promise;
  } });
  const pending = item.invoke(); await entered.promise;
  assert.equal(item.context.trustedRestoreFilesFrozen, true);
  assert.ok(item.events.filter(([type, name]) => type === "flush" && name !== "business").every(event => event.at(-1) === false));
  assert.equal(item.events.filter(([type, , inProgress, frozen]) => type === "drain" && inProgress && frozen).length, 4);
  finish.resolve();
  assert.deepEqual(detached(await pending), { ok: true, canceled: false, path: "/isolated/result.tcbackup",
    created: true, idempotent: false, fileCount: 2, portability: "same-safe-storage-identity-required", credentialsIncluded: false });
  assertUnlocked(item);
});

test("export waits for pending business writes before freezing any file", async () => {
  const pendingWrite = deferred(), item = fixture();
  item.context.agentResults.mutationQueue = pendingWrite.promise;
  const run = item.invoke(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(item.context.trustedRestoreInProgress, true);
  assert.equal(item.context.trustedRestoreFilesFrozen, false);
  assert.equal(item.state.exportCalls, 0);
  pendingWrite.resolve(); await run; assertUnlocked(item);
});

test("export and flush failures propagate rather than returning a successful backup and always unlock", async () => {
  for (const phase of ["flush", "drain", "export"]) {
    const failure = new Error(`isolated ${phase} failure`);
    const fail = () => { throw failure; };
    const item = fixture(phase === "flush" ? { onFlush: fail } : phase === "drain" ? { onDrain: fail } : { onExport: fail });
    await assert.rejects(item.invoke(), error => error === failure);
    assert.equal(item.state.exportCalls, phase === "export" ? 1 : 0);
    assertUnlocked(item);
  }
});

test("an unverified account refuses export and unlocks without invoking the bundle writer", async () => {
  const item = fixture(); item.setVerified(false);
  await assert.rejects(item.invoke(), { code: "backup_account_scope_unverified" });
  assert.equal(item.state.exportCalls, 0); assertUnlocked(item);
});

test("account or authorization changes during export never return success and leave no busy lock", async () => {
  for (const mode of ["scope", "generation"]) {
    const item = fixture({ onExport: ({ setScope, gate }) => { if (mode === "scope") setScope("scope-b"); else gate.advance(); } });
    await assert.rejects(item.invoke(), { code: mode === "scope" ? "STALE_SCOPE" : "STALE_LONGBRIDGE_AUTHORIZATION_GENERATION" });
    assert.equal(item.state.exportCalls, 1);
    assert.equal(item.state.published, 0);
    assertUnlocked(item);
  }
});

test("an identity change while flushing aborts before the bundle writer runs", async () => {
  const item = fixture({ onFlush: ({ name, setScope }) => { if (name === "review") setScope("scope-b"); } });
  await assert.rejects(item.invoke(), { code: "STALE_SCOPE" });
  assert.equal(item.state.exportCalls, 0); assertUnlocked(item);
});

test("an identity change during the final drain aborts before creating a backup under the wrong scope", async () => {
  const item = fixture({ onDrain: ({ name, setScope }) => { if (name === "review") setScope("scope-b"); } });
  await assert.rejects(item.invoke(), { code: "STALE_SCOPE" });
  assert.equal(item.state.exportCalls, 0); assert.equal(item.state.published, 0); assertUnlocked(item);
});

test("the host payload validator returns parsed documents for roots and immutable segment files", async () => {
  const item = fixture();
  for (const name of ["review-data.bin", "portfolio-snapshots.bin", "technical-radar.bin", `ledger-segment-${"a".repeat(64)}.bin`]) {
    const result = await item.context.validateTrustedBackupPayload({ name, payload: Buffer.from('{"test":1}') });
    assert.deepEqual(detached(result), { document: { test: 1 } });
  }
  assert.equal(item.state.decryptCalls, 4);
});

test("host payload validation rejects unavailable encryption, invalid JSON, non-object roots and wrong-workspace business indexes", async () => {
  const item = fixture();
  item.state.encryptionAvailable = false;
  await assert.rejects(item.context.validateTrustedBackupPayload({ name: "review-data.bin", payload: Buffer.from("{}") }), /安全存储不可用/);
  assert.equal(item.state.decryptCalls, 0);
  item.state.encryptionAvailable = true;
  for (const text of ["invalid JSON", "[]", "null", "42"]) {
    await assert.rejects(item.context.validateTrustedBackupPayload({ name: "review-data.bin", payload: Buffer.from(text) }), /JSON|根结构/);
  }
  const document = { schemaVersion: "trading-cockpit-business-state/v1",
    workspace: { kind: "trading-cockpit", directory: "/isolated/workspace" },
    migration: { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", source: "secure-state.bin", completedAt: "2026-09-18T00:00:00.000Z", migratedKeys: [] },
    updatedAt: "2026-09-18T00:00:00.000Z", values: {} };
  assert.deepEqual(detached(await item.context.validateTrustedBackupPayload({ name: "business-state.bin", payload: Buffer.from(JSON.stringify(document)) })), { document });
  document.workspace.directory = "/isolated/other-workspace";
  await assert.rejects(item.context.validateTrustedBackupPayload({ name: "business-state.bin", payload: Buffer.from(JSON.stringify(document)) }), { code: "BUSINESS_STATE_WORKSPACE_MISMATCH" });
});

test("a payload validation failure within export propagates and releases the host freeze", async () => {
  const item = fixture({ onExport: ({ input }) => input.validatePayload({ name: "review-data.bin", payload: Buffer.from("bad JSON") }) });
  await assert.rejects(item.invoke(), /不是有效 JSON/);
  assertUnlocked(item);
});
