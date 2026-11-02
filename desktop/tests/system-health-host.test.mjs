import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
function between(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}

test("system-health reads local facts without triggering coverage repair or external refresh", async () => {
  let guards = 0, calls = 0;
  const context = vm.createContext({
    captureReviewAccountOperation: () => ({ scopeId: "a" }),
    assertReviewAccountOperation: () => { guards++; }, ibkr: { generation: 1 },
    codexAnalysis: { status: () => ({ available: true, threadId: "thread-a" }) },
    portfolioSnapshotLedgerStatus: async options => { assert.equal(options.reconcile, false); return { integrity: { valid: true, ledgerRecordCount: 12 } }; },
    technicalRadarStore: { verifyIntegrity: async () => ({ valid: true, batchCount: 3 }), capacity: async () => ({ activeCount: 3, batchCount: 3, archivedCount: 0, serializedBytes: 1234, totalSerializedBytes: 1234 }), maxBatches: 400, maxBytes: 96 * 1024 * 1024 },
    portfolioSnapshotStore: { capacity: async () => ({ activeCount: 12, snapshotCount: 24, archivedCount: 12, serializedBytes: 3456, totalSerializedBytes: 6789 }), maxSnapshots: 12000, maxSerializedBytes: 64 * 1024 * 1024 },
    agentResults: { peek: () => ({ id: "local-result" }), latest: () => { throw new Error("unnecessary disk load"); } },
    app: { getVersion: () => "test" }, secureStore: {}, businessStateStore: {}, reviewDataStore: {}, marketHistoryDataStore: {}, portfolioSnapshotDataStore: {}, technicalRadarDataStore: {},
    storageHealthSnapshot: stores => ({ count: stores.length }),
    longbridge: { status: () => ({ connected: false }), refresh: () => { throw new Error("must not fetch"); } },
    brokerUiSnapshot: () => ({}), activeAgentSnapshot: () => [],
    buildSystemHealthSnapshot: input => { calls++; return input; },
  });
  vm.runInContext(between("async function readSystemHealthSnapshot(", "\nfunction brokerUiSnapshot("), context);
  const result = await context.readSystemHealthSnapshot();
  assert.equal(guards, 1); assert.equal(calls, 1);
  assert.equal(result.storage.count, 6);
  assert.equal(result.lastAgentResult.id, "local-result");
  assert.equal(result.capacities[0].count, 12);
  assert.equal(result.capacities[1].count, 3);
  assert.equal(result.capacities[0].bytes, 3456);
  assert.equal(result.capacities[0].totalCount, 24);
  assert.equal(result.capacities[0].archivedCount, 12);
  assert.equal(result.capacities[1].bytes, 1234);
  assert.ok(result.capacities.every(item => item.diskBytes === null), "unmeasured ciphertext bytes are not zero");
});

test("health overlay visibility and workspace mode remain independent", async () => {
  const handlers = new Map(), visibility = [];
  let bounds = 0;
  const context = vm.createContext({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    assertTrustedSender() {}, workspaceMode: "cockpit", systemHealthOpen: false,
    tvView: { setVisible: visible => visibility.push(visible) }, requestTvBounds: () => { bounds++; },
  });
  vm.runInContext(between('  ipcMain.handle("health:set-open"', '\n  ipcMain.handle('), context);
  vm.runInContext(between('  ipcMain.handle("workspace:set-mode"', '\n  ipcMain.handle('), context);
  await handlers.get("health:set-open")({}, { open: true });
  assert.equal(context.workspaceMode, "cockpit");
  await handlers.get("workspace:set-mode")({}, { mode: "review" });
  await handlers.get("health:set-open")({}, { open: false });
  assert.deepEqual(visibility, [false, false, false]);
  assert.equal(bounds, 0);
  await handlers.get("workspace:set-mode")({}, { mode: "cockpit" });
  assert.equal(visibility.at(-1), true);
  await handlers.get("health:set-open")({}, { open: true });
  await handlers.get("workspace:set-mode")({}, { mode: "cockpit" });
  assert.equal(visibility.at(-1), false);
  await handlers.get("health:set-open")({}, { open: false });
  assert.equal(visibility.at(-1), true);
});

test("health snapshot drops a mixed-connection asynchronous result", async () => {
  const ibkr = { generation: 1 };
  const context = vm.createContext({
    captureReviewAccountOperation: () => ({}), assertReviewAccountOperation() {}, ibkr,
    codexAnalysis: { status: () => ({}) },
    portfolioSnapshotLedgerStatus: async () => { ibkr.generation++; return {}; },
    technicalRadarStore: null, portfolioSnapshotStore: null, portfolioSnapshotDataStore: null, technicalRadarDataStore: null,
    buildSystemHealthSnapshot: () => { throw new Error("mixed state must never reach UI"); },
  });
  vm.runInContext(between("async function readSystemHealthSnapshot(", "\nfunction brokerUiSnapshot("), context);
  await assert.rejects(context.readSystemHealthSnapshot(), /IBKR 连接已变化/);
});
