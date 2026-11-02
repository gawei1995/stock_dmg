import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const renderer = await readFile(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const review = await readFile(new URL("../renderer/review.js", import.meta.url), "utf8");
function implementation(source, name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = source.slice(start);
  const end = tail.slice(1).search(/\n(?:  )?(?:async )?function \w+\(/);
  return end < 0 ? tail : tail.slice(0, end + 1);
}
function runFunctions(source, names, context) {
  vm.createContext(context);
  vm.runInContext(names.map((name) => implementation(source, name)).join("\n"), context);
  return context;
}

test("business status updates cannot change Longbridge connection or reauthorization state", () => {
  const context = runFunctions(renderer, ["isLongbridgeConnectionStatus", "setLongbridgeStatus"], {
    state: {}, elements: { longbridgeChip: {}, connect: {} }, esc: String,
  });
  context.setLongbridgeStatus({ domain: "longbridge", state: "connected", message: "长桥已连接" });
  for (const status of [
    { state: "technical_radar_ready", message: "扫描完成" },
    { state: "snapshot_gap", message: "捕获缺口" },
    { domain: "snapshot", state: "error", message: "错误" },
    { domain: "ibkr", state: "disconnected" },
  ]) context.setLongbridgeStatus(status);
  assert.equal(context.elements.connect.textContent, "长桥已连接");
  assert.match(context.elements.longbridgeChip.className, /connected/);
  context.setLongbridgeStatus({ state: "reauth_required" });
  context.setLongbridgeStatus({ state: "technical_radar_running" });
  assert.equal(context.state.longbridgeReauthRequired, true);
  assert.equal(context.elements.connect.textContent, "升级只读授权");
});

test("FX labels retain each broker's reference/cache provenance, not a combined live claim", () => {
  const context = runFunctions(renderer, ["brokerName", "portfolioFxLabel"], { state: { brokerScope: "all" } });
  const label = context.portfolioFxLabel({ dataQuality: { fxStatus: "live" }, fx: { sources: [
    { broker: "longbridge", status: "reference_cached", providerCode: "ECB", asOf: "2026-09-17" },
    { broker: "ibkr", status: "not_required" },
  ] } });
  assert.match(label, /长桥 ECB 2026-09-17 参考汇率（缓存）/);
  assert.match(label, /IBKR USD 单币种/);
  assert.doesNotMatch(label, /实时|全部账户账户汇率/);
});

test("runtime storage degradation stays visible independently of broker connection status", () => {
  let chip = null;
  const messages = [];
  const context = runFunctions(renderer, ["renderStorageHealth"], {
    state: {},
    document: { querySelector: () => chip, createElement: () => ({ style: {}, setAttribute() {} }) },
    elements: { longbridgeChip: { after: (value) => { chip = value; } } },
    setSystemMessage: (text) => messages.push(text),
  });
  const healthy = { encrypted: true, state: "healthy", stores: [] };
  context.renderStorageHealth(healthy);
  assert.equal(chip.hidden, true);
  const degraded = { encrypted: true, state: "degraded", stores: [{ file: "review.bin", state: "degraded", errorCode: "STORAGE_WRITE_FAILED", recoveryAvailable: true }] };
  context.renderStorageHealth(degraded);
  context.renderStorageHealth(degraded);
  assert.equal(chip.hidden, false);
  assert.match(chip.title, /review.bin.*STORAGE_WRITE_FAILED/);
  assert.equal(messages.length, 1, "repeated status messages must not repeat the same warning");
  context.renderStorageHealth(healthy);
  assert.equal(chip.hidden, true);
});

test("repeated portfolio refresh invalidations update one notice without weakening save or active-operation guards", () => {
  let notice = null, inserts = 0;
  const button = {};
  const context = runFunctions(renderer, ["invalidateAgentRuns"], {
    state: { currentRun: {}, activeRequestId: "active-request", activeSessionId: "thread-A", runsById: new Map([["run", {}]]) },
    activeOperationForThread: () => ({ operationId: "active" }), esc: String,
    elements: { agentThread: {
      querySelectorAll: () => [button],
      querySelector: () => notice,
      insertAdjacentHTML: (_position, html) => {
        assert.match(html, /data-agent-invalidation/);
        inserts++;
        const message = { textContent: html.match(/data-invalidation-message>(.*?)<\/span>/)?.[1] };
        notice = { querySelector: () => message };
      },
    } },
  });
  for (let i = 0; i < 10; i++) context.invalidateAgentRuns("账户快照已更新", { preserveActiveRequest: true });
  assert.equal(inserts, 1);
  assert.equal(context.state.currentRun, null);
  assert.equal(button.disabled, true);
  assert.equal(context.state.activeRequestId, "active-request");
  context.invalidateAgentRuns("账户范围已切换");
  assert.equal(inserts, 1);
  assert.equal(notice.querySelector().textContent, "账户范围已切换");
  notice = null; // Normal session/result repaint removes the prior notice.
  context.invalidateAgentRuns("新会话中的快照已更新");
  assert.equal(inserts, 2);
});

test("a broker guard blocks launch with a visible explanation and clears only when the actual guard is ready", () => {
  let submitUpdates = 0;
  const context = runFunctions(renderer, ["agentNetworkRuntimeView", "setCodexStatus"], {
    state: {}, elements: { codexBadge: { classList: { toggle() {} } }, agentAvailability: {} },
    updateAgentSubmitState: () => submitUpdates++, renderAgentSessions() {}, renderAgentNetworkPreferences() {},
  });
  context.setCodexStatus({ available: true, ready: true, readOnlyGuardReady: false });
  assert.equal(context.state.codexAvailable, false);
  assert.equal(context.elements.agentAvailability.hidden, false);
  assert.match(context.elements.agentAvailability.textContent, /券商写工具只读隔离尚未通过/);
  assert.doesNotMatch(context.elements.codexBadge.title, /长桥/);
  context.setCodexStatus({ available: true, ready: true, readOnlyGuardReady: true });
  assert.equal(context.state.codexAvailable, true);
  assert.equal(context.elements.agentAvailability.hidden, true);
  assert.equal(context.elements.agentAvailability.textContent, "");
  assert.equal(submitUpdates, 2);
});

function fakeReviewState() {
  return {
    accountScopeId: "account-A", snapshotUpdateSequence: 1, mode: "review",
    validationDrafts: new Map(), caseDrafts: new Map(), cycleDrafts: new Map(),
    selectedRecordIds: new Set(), selectedRecordCache: new Map(), selectedBatchCaseIds: new Set(),
    snapshot: { portfolioSnapshots: { snapshotCount: 0 }, cycles: [], cases: [], intake: {} },
    snapshotRequestToken: 0, intakePageToken: 0, snapshotLoaded: true,
    intakeSearch: "AAPL", intakeKind: "", loading: false,
  };
}

test("background ledger events update only metadata and discard out-of-order/account-stale updates", () => {
  const state = fakeReviewState();
  state.validationDrafts.set("draft", "keep me");
  const calls = { summary: 0, all: 0, load: 0, clear: 0 };
  const context = runFunctions(review, ["reviewSnapshotSequence", "adoptReviewAccountScope", "handleReviewSnapshotUpdate"], {
    state, elements: { testList: { replaceChildren: () => calls.clear++ } },
    emptySnapshot: () => ({ portfolioSnapshots: {} }),
    renderSummary: () => calls.summary++, renderAll: () => calls.all++, loadSnapshot: () => calls.load++,
  });
  context.handleReviewSnapshotUpdate({ accountScopeId: "account-A", snapshotUpdateSequence: 2, portfolioSnapshots: { snapshotCount: 1 } });
  assert.equal(state.snapshot.portfolioSnapshots.snapshotCount, 1);
  assert.equal(state.validationDrafts.get("draft"), "keep me");
  assert.deepEqual(calls, { summary: 1, all: 0, load: 0, clear: 0 });
  context.handleReviewSnapshotUpdate({ accountScopeId: "account-A", snapshotUpdateSequence: 1, portfolioSnapshots: { snapshotCount: 0 } });
  assert.equal(state.snapshot.portfolioSnapshots.snapshotCount, 1);
  context.handleReviewSnapshotUpdate({ accountScopeId: "account-B", snapshotUpdateSequence: 3, portfolioSnapshots: { snapshotCount: 4 } });
  assert.equal(state.accountScopeId, "account-B");
  assert.equal(state.validationDrafts.size, 0);
  assert.deepEqual(calls, { summary: 1, all: 1, load: 1, clear: 1 });
  context.handleReviewSnapshotUpdate({ accountScopeId: "account-A", snapshotUpdateSequence: 2, portfolioSnapshots: {} });
  assert.equal(state.accountScopeId, "account-B");
});

test("review summary loads once without acquiring the write lock and preserves a newer ledger event", async () => {
  const state = fakeReviewState();
  let resolve;
  const calls = [];
  const context = runFunctions(review, ["loadSnapshot", "reviewSnapshotSequence"], {
    state, INTAKE_PAGE_LIMIT: 250,
    elements: { workspace: { setAttribute() {} } },
    callReview: (method, request) => { calls.push({ method, request }); return new Promise((r) => { resolve = r; }); },
    adoptReviewAccountScope() {}, rememberValidationDrafts() {}, publishReviewEvidenceRevisions() {},
    normalizeSnapshot: (value) => value, cycleId: (x) => x.id, caseId: (x) => x.id,
    pruneIntakeSelection() {}, renderAll() {}, clearNotice() {}, showNotice() {},
    setLoading() { throw new Error("Read must not acquire the global write lock"); },
  });
  const pending = context.loadSnapshot();
  assert.equal(state.loading, false);
  assert.equal(state.snapshotLoading, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "snapshot");
  assert.equal(calls[0].request.query, "AAPL");
  state.snapshotUpdateSequence = 3;
  state.snapshot.portfolioSnapshots = { snapshotCount: 3 };
  resolve({ accountScopeId: "account-A", snapshotUpdateSequence: 2, portfolioSnapshots: { snapshotCount: 2 }, cycles: [], cases: [] });
  await pending;
  assert.equal(state.snapshot.portfolioSnapshots.snapshotCount, 3);
  assert.equal(state.snapshotLoading, false);
  assert.equal(state.loading, false);
});

function field(attribute, value, options = null) {
  return {
    type: "text", tagName: options ? "SELECT" : "INPUT", value, options,
    getAttributeNames: () => [attribute],
  };
}
function card(fields, key = null) {
  const version = { open: true };
  return { dataset: { validationDraftKey: key }, querySelectorAll: () => fields, querySelector: () => version };
}

test("validation drafts survive refresh only for the same account and frozen protocol revision", () => {
  const state = fakeReviewState();
  let cards = [];
  const context = runFunctions(review, ["validationDraftKey", "validationFieldKey", "rememberValidationDrafts", "restoreValidationDraft"], {
    state, elements: { testList: { querySelectorAll: () => cards } },
  });
  const protocol = { id: "test-1", protocolRevision: 1, primaryMetric: "net_r" };
  const key = context.validationDraftKey(protocol);
  cards = [card([field("data-test-result-notes", "不要丢我的观察"), field("data-v2-title", "第二版草稿")], key)];
  context.rememberValidationDrafts();
  const fields = [field("data-test-result-notes", ""), field("data-v2-title", "default")];
  context.restoreValidationDraft(card(fields), protocol);
  assert.equal(fields[0].value, "不要丢我的观察");
  assert.equal(fields[1].value, "第二版草稿");
  const nextRevision = [field("data-test-result-notes", "")];
  context.restoreValidationDraft(card(nextRevision), { ...protocol, protocolRevision: 2 });
  assert.equal(nextRevision[0].value, "");
  state.accountScopeId = "account-B";
  const nextAccount = [field("data-test-result-notes", "")];
  context.restoreValidationDraft(card(nextAccount), protocol);
  assert.equal(nextAccount[0].value, "");
  state.accountScopeId = null;
  assert.equal(context.validationDraftKey(protocol), null);
});

test("draft restore never resurrects a candidate removed from the host's eligible set", () => {
  const state = fakeReviewState();
  const context = runFunctions(review, ["validationDraftKey", "validationFieldKey", "restoreValidationDraft"], { state });
  const protocol = { id: "test-1", protocolRevision: 1 };
  state.validationDrafts.set(context.validationDraftKey(protocol), { fields: { "data-test-review-cycle": "removed-cycle" } });
  const select = field("data-test-review-cycle", "", [{ value: "" }, { value: "new-cycle" }]);
  context.restoreValidationDraft(card([select]), protocol);
  assert.equal(select.value, "");
});

for (const code of ["terminal_unverified", "history_incomplete"]) test(`${code} shows partial text without creating a completed result or plan`, () => {
  const operation = { operationId: "op-1", threadId: "thread-1", finalText: "暂存正文" };
  const state = { activeSessionId: "thread-1", operations: new Map([["op-1", operation]]), settledOperationIds: new Set(), agentSessions: [{ id: "thread-1" }] };
  const view = {};
  const rendered = [];
  const context = runFunctions(renderer, ["failAgentOperation"], {
    state, POST_TERMINAL_RECOVERY_WINDOW_MS: 60000, CSS: { escape: String }, clearTimeout() {},
    elements: { agentThread: { querySelector: () => null }, agentLiveStatus: {}, historyPanel: { hidden: true } },
    ensureSessionView: () => view, renderUnverifiedAgentPartial: (p) => rendered.push(p),
    finishActiveAgentUi() {}, renderAgentSessions() {}, setSystemMessage() {},
    scheduleAgentResultRecovery() { throw new Error("Unverified terminal must not spin indefinitely"); },
    stopAgentResultRecovery: (op) => state.operations.delete(op.operationId),
  });
  context.failAgentOperation(operation, "断连", { failure: { errorCode: code, partialText: "已收到的正文", turnId: "turn-1" } });
  assert.equal(rendered[0].text, "已收到的正文");
  assert.match(rendered[0].message, /终态未核验|历史正文尚未完整取回/);
  assert.equal(view.lastAgentResult, undefined);
  assert.equal(state.operations.size, 0);
});
