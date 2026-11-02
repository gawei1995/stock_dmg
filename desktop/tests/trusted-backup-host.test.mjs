import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { AuthorizationGenerationGate } from "../src/data/authorization-generation.mjs";

// Execute the actual host restore handler and identity/summary/flush helpers.
// Every dialog, store, account and file operation is an isolated test double.
const source = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
function between(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, start);
  return source.slice(first, last);
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const defaultOperations = [
  { name: "review-data.bin", operation: "replace" },
  { name: "market-history.bin", operation: "delete" },
  { name: "portfolio-snapshots.bin", operation: "unchanged" },
  { name: "technical-radar.bin", operation: "create" },
  { name: "business-state.bin", operation: "preserve" },
];

test("restore confirmation summarizes many immutable segments instead of rendering every hash as business data", () => {
  const context = vm.createContext({});
  vm.runInContext(between("function describeTrustedRestoreOperations(", "\nasync function flushTrustedBackupStores("), context);
  const segments = Array.from({ length: 2_000 }, (_, index) => ({
    name: `ledger-segment-${index.toString(16).padStart(64, "0")}.bin`, operation: index < 1_500 ? "create" : "unchanged",
  }));
  const description = context.describeTrustedRestoreOperations([...defaultOperations, ...segments]);
  assert.match(description, /覆盖：复盘与验证/);
  assert.match(description, /历史分段：新增 1500 段、不变 500 段/);
  assert.ok(description.length < 250);
  assert.ok(!description.includes("ledger-segment-"));
});

function fixture({ operations = defaultOperations, confirmation = 1, selectionCanceled = false,
  onConfirmation, onApply, onStage, relaunchError = null, cleanupError = null } = {}) {
  const handlers = new Map(), events = [], timers = [], confirmations = [];
  const gate = new AuthorizationGenerationGate();
  let scope = "scope-a";
  const state = { stageCalls: 0, applyCalls: 0, committed: 0, discardCalls: 0, relaunchCalls: 0, exitCalls: 0 };
  let context;
  const lockState = () => [context.trustedRestoreInProgress, context.trustedRestoreFilesFrozen];
  const store = (id) => ({
    flush: async () => { events.push(["flush", id, ...lockState()]); },
    drain: async () => { events.push(["drain", id, ...lockState()]); },
  });
  context = vm.createContext({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    assertTrustedSender() {}, BrowserWindow: { fromWebContents: () => null }, mainWindow: null,
    dialog: {
      showOpenDialog: async () => ({ canceled: selectionCanceled, filePaths: selectionCanceled ? [] : ["/isolated/backup"] }),
      showMessageBox: async (_owner, options) => {
        confirmations.push(options); events.push(["confirm", ...lockState()]);
        if (onConfirmation) await onConfirmation({ context, state, setScope: (value) => { scope = value; }, gate });
        return { response: confirmation };
      },
    },
    app: {
      getPath: () => "/isolated/profile",
      relaunch: () => { state.relaunchCalls++; events.push(["relaunch", ...lockState()]); if (relaunchError) throw relaunchError; },
      exit: () => { state.exitCalls++; events.push(["exit", ...lockState()]); },
    },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    trustedRestoreInProgress: false, trustedRestoreFilesFrozen: false,
    technicalRadarRunPromise: null, tradeHistoryService: { busy: false },
    activeAgentOperations: new Map(), longbridge: { connecting: false },
    longbridgeAuthorizationLifecycle: gate, portfolioSnapshotSweep: null,
    portfolioSnapshotCaptureQueue: Promise.resolve(), portfolioSnapshotCoverageWriteQueue: Promise.resolve(), reviewLearningMutationQueue: Promise.resolve(),
    currentPortfolioLedgerScopeId: () => scope,
    currentPortfolioAccountScopeStatus: () => ({ verified: true, identity: { scopeId: scope, verified: true } }),
    stalePortfolioAccountScopeError: () => Object.assign(new Error("scope changed"), { code: "STALE_SCOPE" }),
    stageTrustedBackupRestore: async (input) => {
      state.stageCalls++; events.push(["stage", ...lockState()]);
      assert.equal(input.expectedAccountScope.scopeId, scope);
      assert.equal(typeof input.validatePayload, "function");
      if (onStage) await onStage({ context, state });
      return { plan: { operations }, marker: "isolated-stage" };
    },
    validateTrustedBackupPayload: async () => true,
    applyStagedTrustedBackupRestore: async (staged, options) => {
      state.applyCalls++; events.push(["apply", ...lockState()]);
      assert.equal(staged.marker, "isolated-stage");
      assert.equal(typeof options.commitGuard, "function");
      if (onApply) await onApply({ context, state, setScope: (value) => { scope = value; }, gate });
      options.commitGuard();
      state.committed++;
      return { ok: true, changed: true };
    },
    discardStagedTrustedBackupRestore: async () => { state.discardCalls++; events.push(["discard", ...lockState()]); if (cleanupError) throw cleanupError; },
    agentResults: { mutationQueue: Promise.resolve() },
    businessStateStore: store("business"), reviewDataStore: store("review"), marketHistoryDataStore: store("market"), portfolioSnapshotDataStore: store("portfolio"), technicalRadarDataStore: store("radar"),
  });
  for (const [start, end] of [
    ["function currentVerifiedBackupScope(", "\nasync function validateTrustedBackupPayload("],
    ["function captureReviewAccountOperation(", "\nfunction invalidateLongbridgeAuthorizationLifecycle("],
    ['  ipcMain.handle("review:backup:restore"', '\n  ipcMain.handle("review:snapshot-background:update"'],
  ]) vm.runInContext(between(start, end), context);
  return { context, state, events, timers, confirmations, gate, setScope: (value) => { scope = value; },
    invoke: () => handlers.get("review:backup:restore")({ sender: {} }) };
}

test("restore rejects an account-scope change while confirmation is open, before any apply", async () => {
  const entered = deferred(), finish = deferred();
  const item = fixture({ onConfirmation: async () => { entered.resolve(); await finish.promise; } });
  const invocation = item.invoke();
  await entered.promise;
  assert.equal(item.context.trustedRestoreInProgress, true);
  assert.equal(item.context.trustedRestoreFilesFrozen, true);
  item.setScope("scope-b"); finish.resolve();
  await assert.rejects(invocation, { code: "STALE_SCOPE" });
  assert.equal(item.state.applyCalls, 0);
  assert.equal(item.state.discardCalls, 1);
  assert.equal(item.context.trustedRestoreInProgress, false);
  assert.equal(item.context.trustedRestoreFilesFrozen, false);
});

test("restore rejects reauthorization of the same account during confirmation", async () => {
  const item = fixture({ onConfirmation: ({ gate }) => gate.advance() });
  await assert.rejects(item.invoke(), { code: "STALE_LONGBRIDGE_AUTHORIZATION_GENERATION" });
  assert.equal(item.state.applyCalls, 0);
  assert.equal(item.state.committed, 0);
  assert.equal(item.context.trustedRestoreFilesFrozen, false);
});

test("restore passes the real captured identity guard through the last apply boundary", async () => {
  const item = fixture({ onApply: ({ setScope }) => setScope("scope-b") });
  await assert.rejects(item.invoke(), { code: "STALE_SCOPE" });
  assert.equal(item.state.applyCalls, 1);
  assert.equal(item.state.committed, 0);
  assert.equal(item.context.trustedRestoreFilesFrozen, false);
});

test("successful restore keeps both locks through stage cleanup, reply, relaunch and process exit", async () => {
  const item = fixture({ cleanupError: new Error("isolated cleanup failure") });
  const result = await item.invoke();
  assert.equal(result.restarting, true);
  assert.equal(item.state.committed, 1);
  assert.equal(item.context.trustedRestoreInProgress, true);
  assert.equal(item.context.trustedRestoreFilesFrozen, true);
  assert.ok(item.events.filter(([name]) => ["stage", "confirm", "apply", "relaunch", "discard"].includes(name)).every((event) => event.at(-2) === true && event.at(-1) === true));
  assert.ok(item.events.filter(([name, id]) => name === "flush" && id !== "business").every((event) => event.at(-1) === false), "no EncryptedStore flush rewrite is requested after files freeze");
  assert.ok(item.events.some(([name, id, inProgress, frozen]) => name === "flush" && id === "business" && inProgress && frozen), "BusinessStateStore.flush is its read-only drain/verify barrier");
  assert.equal(item.events.filter(([name, , inProgress, frozen]) => name === "drain" && inProgress && frozen).length, 4, "all four other encrypted stores use the non-writing drain path");
  assert.equal(item.state.exitCalls, 0);
  assert.equal(item.timers.length, 1);
  assert.equal(item.timers[0].delay, 50);
  item.timers[0].callback();
  assert.equal(item.state.exitCalls, 1);
  assert.deepEqual(item.events.at(-1), ["exit", true, true]);
});

test("canceling restore confirmation discards staging and unlocks without replacement or restart", async () => {
  const item = fixture({ confirmation: 0 });
  const result = await item.invoke();
  assert.equal(result.canceled, true);
  assert.equal(item.state.applyCalls, 0);
  assert.equal(item.state.discardCalls, 1);
  assert.equal(item.state.relaunchCalls, 0);
  assert.equal(item.context.trustedRestoreInProgress, false);
  assert.equal(item.context.trustedRestoreFilesFrozen, false);
});

test("unchanged and legacy-preserve-only plans never replace current business indexes", async () => {
  const item = fixture({ operations: [{ name: "business-state.bin", operation: "preserve" }, { name: "review-data.bin", operation: "unchanged" }] });
  const result = await item.invoke();
  assert.equal(result.unchanged, true);
  assert.equal(result.canceled, false);
  assert.equal(item.state.applyCalls, 0);
  assert.deepEqual(Array.from(item.confirmations[0].buttons), ["关闭"]);
  assert.equal(item.context.trustedRestoreInProgress, false);
  assert.equal(item.context.trustedRestoreFilesFrozen, false);
});

test("confirmation explicitly distinguishes create, overwrite, delete, unchanged and preserve operations", async () => {
  const item = fixture({ confirmation: 0 });
  await item.invoke();
  const message = item.confirmations[0].message;
  for (const expected of ["覆盖：复盘与验证", "删除：行情缓存", "不变：组合快照", "新增：技术雷达", "保留：应用索引"]) assert.ok(message.includes(expected), expected);
  assert.match(item.confirmations[0].detail, /按文件整体替换，不自动合并.*旧版包未包含的对话索引保持不变/s);
  assert.match(item.confirmations[0].detail, /不含登录凭证或 Codex 外部完整对话.*后台开关与账户授权沿用本机/s);
  assert.equal(item.confirmations[0].defaultId, 0);
  assert.equal(item.confirmations[0].cancelId, 0);
});

test("restore drains pending business writes before freezing files, without mutating stores during flush", async () => {
  const pending = deferred();
  const item = fixture({ confirmation: 0 });
  item.context.agentResults.mutationQueue = pending.promise;
  const invocation = item.invoke();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(item.context.trustedRestoreInProgress, true);
  assert.equal(item.context.trustedRestoreFilesFrozen, false);
  assert.equal(item.state.stageCalls, 0);
  pending.resolve(); await invocation;
  const flushes = item.events.filter(([name]) => name === "flush");
  assert.deepEqual(flushes.map(([, id]) => id).sort(), ["business", "market", "portfolio", "radar", "review"]);
  assert.ok(flushes.every((event) => event.at(-2) === true && event.at(-1) === false));
});

test("preflight failure or canceled selection does not leave a hidden recovery lock", async () => {
  const canceled = fixture({ selectionCanceled: true });
  assert.equal((await canceled.invoke()).canceled, true);
  assert.equal(canceled.state.stageCalls, 0);
  assert.equal(canceled.context.trustedRestoreInProgress, false);
  const failed = fixture({ onStage: () => { throw new Error("isolated validation failure"); } });
  await assert.rejects(failed.invoke(), /isolated validation failure/);
  assert.equal(failed.context.trustedRestoreInProgress, false);
  assert.equal(failed.context.trustedRestoreFilesFrozen, false);
});

test("restore refuses pre-existing broker, Agent and snapshot work before freezing any files", async () => {
  for (const configure of [
    (context) => { context.longbridge.connecting = true; },
    (context) => { context.longbridgeAuthorizationLifecycle.inFlight.set(0, new Set([Promise.resolve()])); },
    (context) => { context.portfolioSnapshotSweep = Promise.resolve(); },
    (context) => { context.activeAgentOperations.set("fixture-agent", {}); },
    (context) => { context.tradeHistoryService.busy = true; },
    (context) => { context.technicalRadarRunPromise = Promise.resolve(); },
  ]) {
    const item = fixture(); configure(item.context);
    await assert.rejects(item.invoke(), /正在|仍在|仍有/);
    assert.equal(item.state.stageCalls, 0);
    assert.equal(item.state.applyCalls, 0);
    assert.equal(item.context.trustedRestoreInProgress, false);
    assert.equal(item.context.trustedRestoreFilesFrozen, false);
  }
});

test("a relaunch failure after restored files commit must not re-enable stale in-memory writers", async () => {
  const item = fixture({ relaunchError: new Error("isolated relaunch failure") });
  await assert.rejects(item.invoke(), (error) => {
    assert.match(error.message, /数据已恢复.*写入仍暂停.*退出.*重新打开/);
    assert.match(error.cause?.message ?? "", /isolated relaunch failure/);
    return true;
  });
  assert.equal(item.state.committed, 1);
  assert.equal(item.context.trustedRestoreInProgress, true, "committed files require restart even if relaunch scheduling fails");
  assert.equal(item.context.trustedRestoreFilesFrozen, true, "old in-memory indexes must not overwrite restored files");
});

test("failed restore rollback retains both barriers and original recovery evidence without relaunch", async () => {
  const error = Object.assign(new Error("isolated rollback failure"), {
    code: "RESTORE_ROLLBACK_FAILED", details: { recovery: [{ name: "review-data.bin", recoveryPath: "/isolated/.restore-original" }] },
  });
  const item = fixture({ onApply: () => { throw error; } });
  await assert.rejects(item.invoke(), (actual) => {
    assert.equal(actual, error, "the original recovery paths must not be swallowed or replaced");
    assert.equal(actual.details.recovery[0].recoveryPath, "/isolated/.restore-original");
    return true;
  });
  assert.equal(item.context.trustedRestoreInProgress, true);
  assert.equal(item.context.trustedRestoreFilesFrozen, true);
  assert.equal(item.state.relaunchCalls, 0);
  assert.equal(item.timers.length, 0);
  assert.equal(item.state.discardCalls, 1, "isolated staging can close; original recovery copies remain owned by the bundle error");
});

test("a commit failure with completed rollback unlocks the unchanged original application", async () => {
  const error = Object.assign(new Error("isolated commit failure; rolled back"), { code: "RESTORE_COMMIT_FAILED" });
  const item = fixture({ onApply: () => { throw error; } });
  await assert.rejects(item.invoke(), (actual) => actual === error);
  assert.equal(item.context.trustedRestoreInProgress, false);
  assert.equal(item.context.trustedRestoreFilesFrozen, false);
  assert.equal(item.state.relaunchCalls, 0);
  assert.equal(item.timers.length, 0);
  assert.equal(item.state.discardCalls, 1);
});

test("business-writing IPC routes reject a restore lock before touching their service dependencies", async () => {
  const names = [
    "ibkr:configure", "brokers:refresh", "technical:watchlist:add", "technical:watchlist:remove",
    "technical:linkage:confirm", "technical:linkage:remove", "review:backup:export",
    "review:snapshot-background:update", "review:portfolio-snapshot:capture", "review:intake:events", "review:intake:recent-events",
    "review:case:migrate", "review:cycle:create", "review:cycle:create-order-first", "review:cycle:update", "review:cycle:retrospective-note",
    "review:cycle:seal", "review:cycle:link-broker", "review:cycle:checkpoint", "review:trade-history:sync", "review:intake:sync",
    "review:test:complete", "review:test:record-verified-sample", "review:test:evaluate-protocol", "review:rule:transition", "review:rule:review",
    "review:validation:create-version", "review:validation:archive", "review:learning:accept",
    "agent:capabilities", "agent:history:list", "agent:sessions:list", "agent:sessions:create", "agent:sessions:switch", "agent:sessions:open",
    "agent:result:recover", "agent:run", "agent:save-plan", "longbridge:connect", "longbridge:refresh", "longbridge:forget",
  ];
  const handlers = new Map();
  const context = vm.createContext({ ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
    assertTrustedSender() {}, trustedRestoreInProgress: true });
  vm.runInContext(between("function assertTrustedRestoreIdle(", "\nfunction isTrustedSender("), context);
  for (const name of names) {
    vm.runInContext(between(`  ipcMain.handle("${name}"`, '\n  ipcMain.handle('), context);
    await assert.rejects(handlers.get(name)({ sender: {} }, {}), { code: "trusted_restore_in_progress" }, name);
  }
  vm.runInContext(between('  ipcMain.handle("review:intake:snapshot"', '\n  ipcMain.handle('), context);
  await assert.rejects(handlers.get("review:intake:snapshot")({ sender: {} }, { recordIds: ["order:1"] }), { code: "trusted_restore_in_progress" });
});

test("reauthorize and forget confirmations re-check a restore lock before invalidating credentials", async () => {
  for (const name of ["longbridge:connect", "longbridge:forget"]) {
    const handlers = new Map(), mutations = [];
    let context;
    context = vm.createContext({
      ipcMain: { handle: (route, handler) => handlers.set(route, handler) }, assertTrustedSender() {}, trustedRestoreInProgress: false,
      BrowserWindow: { fromWebContents: () => null },
      dialog: { showMessageBox: async () => { context.trustedRestoreInProgress = true; return { response: 1 }; } },
      invalidateLongbridgeAuthorizationLifecycle: () => mutations.push("invalidate"),
      longbridge: { disconnect: async () => mutations.push("disconnect"), connect: async () => mutations.push("connect") },
      secureStore: { delete: async () => mutations.push("delete") },
      settleSupersededLongbridgeAuthorizationWork: async () => mutations.push("settle"),
      rotatePortfolioLedgerScope: async () => mutations.push("scope"), safeSend: () => mutations.push("publish"),
      isStaleLongbridgeAuthorizationError: () => false, markCurrentPortfolioStale() {}, safeError: error => error.message,
      longbridgeFailureStatus: error => ({ state: "error", message: error.message }), sendStatus() {},
    });
    vm.runInContext(between("function assertTrustedRestoreIdle(", "\nfunction isTrustedSender("), context);
    vm.runInContext(between(`  ipcMain.handle("${name}"`, '\n  ipcMain.handle('), context);
    if (name === "longbridge:forget") {
      await assert.rejects(handlers.get(name)({ sender: {} }), { code: "trusted_restore_in_progress" });
    } else {
      const result = await handlers.get(name)({ sender: {} }, { forceReauthorize: true });
      assert.equal(result.ok, false);
      assert.match(result.error, /恢复预检/);
    }
    assert.deepEqual(mutations, [], name);
  }
});
