import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { AuthorizationGenerationGate } from "../src/data/authorization-generation.mjs";
import { createSnapshotCoverageLedger, deserializeSnapshotCoverage, snapshotCoverageEntry, transitionSnapshotCoverage } from "../src/data/snapshot-coverage.mjs";
import { reconcileDurableSnapshotCoverage } from "../src/data/snapshot-coverage-reconcile.mjs";
import { deriveExpiredSnapshotGaps, listExpiredSnapshotCaptureAlerts } from "../src/data/snapshot-background-reliability.mjs";
import { isCurrentRegularCloseSnapshot } from "../src/data/portfolio-snapshot-store.mjs";

const source = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
function extract(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}

test("completed background Agent capability checks push readiness without a second discovery request", () => {
  let options;
  const messages = [];
  const context = vm.createContext({
    codexPath: "/test/codex", workspaceDirectory: "/test/workspace", businessStateStore: {},
    effectiveAgentNetworkMode: "inherit",
    app: { getVersion: () => "test" },
    CodexWorkspaceService: class { constructor(value) { options = value; } },
    safeSend: (channel, payload) => messages.push({ channel, payload }),
  });
  vm.runInContext(extract("codexAnalysis = new CodexWorkspaceService({", "\n\n  registerIpc();"), context);
  assert.equal(typeof options.onCapabilities, "function");
  const pending = { threadId: "thread-b", readOnlyGuardReady: false };
  const ready = { threadId: "thread-b", readOnlyGuardReady: true };
  options.onCapabilities(pending);
  options.onCapabilities(ready);
  assert.deepEqual(messages, [
    { channel: "cockpit:agent-capabilities", payload: pending },
    { channel: "cockpit:agent-capabilities", payload: ready },
  ]);
  assert.doesNotMatch(String(options.onCapabilities), /refreshInventory|prepare\(/);
});

test("review snapshot projection preserves unknown concentration and valuation provenance", () => {
  const context = vm.createContext({
    inspectPersistedAccountScope: () => ({ verified: true }),
    finiteOrNull: value => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value),
  });
  vm.runInContext(extract("function ledgerSnapshotForReview(", "\nasync function portfolioSnapshotLedgerStatus("), context);
  const snapshot = { summary: { reportingCurrency: "USD" }, accountScope: { scopeId: "test" },
    valuation: { methodVersion: "regular-close-v2" }, fx: { status: "partial" }, dataQuality: { status: "partial" } };
  for (const weights of [[null, undefined], [0.4, null], []]) {
    const result = context.ledgerSnapshotForReview({ ...snapshot, holdings: weights.map(weight => ({ weight })) });
    assert.equal(result.top1WeightPercent, null);
    assert.deepEqual(result.valuation, snapshot.valuation);
    assert.deepEqual(result.fx, snapshot.fx);
    assert.deepEqual(result.accountScope, snapshot.accountScope);
    assert.deepEqual(result.dataQuality, snapshot.dataQuality);
  }
  for (const [weights, expected] of [[[0, 0], 0], [[0.1, -0.4], 40]]) {
    assert.equal(context.ledgerSnapshotForReview({ ...snapshot, holdings: weights.map(weight => ({ weight })) }).top1WeightPercent, expected);
  }
});

test("main snapshot coverage publishes only successfully committed revisions", async () => {
  let rejectFirst = true;
  const writes = [], errors = [];
  let refreshes = 0;
  const context = vm.createContext({
    portfolioSnapshotCoverageLedger: { revision: 0, events: [] },
    portfolioSnapshotCoverageWriteQueue: Promise.resolve(),
    PORTFOLIO_SNAPSHOT_COVERAGE_STORE_KEY: "coverage",
    transitionSnapshotCoverage: (ledger, event) => ({ revision: ledger.revision + 1, events: [...ledger.events, event] }),
    portfolioSnapshotCoverageStore: { set: async (key, ledger) => {
      if (rejectFirst) { rejectFirst = false; throw new Error("disk unavailable"); }
      writes.push(structuredClone(ledger));
    } },
    reviewSnapshotPublisher: { schedule: () => { refreshes++; } },
    safeError: error => error.message,
    sendStatus: event => errors.push(event),
  });
  vm.runInContext(extract("function recordSnapshotCoverageTransition(", "\nasync function reconcileSnapshotCoverageFromSnapshots("), context);
  context.recordSnapshotCoverageTransition("failed-save");
  context.recordSnapshotCoverageTransition("saved");
  await context.portfolioSnapshotCoverageWriteQueue;
  assert.deepEqual(context.portfolioSnapshotCoverageLedger.events, ["saved"]);
  assert.equal(context.portfolioSnapshotCoverageLedger.revision, 1);
  assert.equal(writes.length, 1);
  assert.equal(refreshes, 1);
  assert.equal(errors.length, 1);
});

test("review outer identity guard rejects scope and authorization changes after service returns", () => {
  const lifecycle = new AuthorizationGenerationGate();
  let scope = "account-a";
  const context = vm.createContext({
    longbridgeAuthorizationLifecycle: lifecycle,
    currentPortfolioLedgerScopeId: () => scope,
    stalePortfolioAccountScopeError: () => Object.assign(new Error("scope changed"), { code: "STALE_SCOPE" }),
  });
  vm.runInContext(extract("function captureReviewAccountOperation(", "\nfunction invalidateLongbridgeAuthorizationLifecycle("), context);
  const identity = context.captureReviewAccountOperation();
  assert.equal(context.assertReviewAccountOperation(identity), true);
  scope = "account-b";
  assert.throws(() => context.assertReviewAccountOperation(identity), { code: "STALE_SCOPE" });
  scope = "account-a";
  lifecycle.advance();
  assert.throws(() => context.assertReviewAccountOperation(identity), { code: "STALE_LONGBRIDGE_AUTHORIZATION_GENERATION" });
});

test("partial agent delivery remains an error envelope and retains recoverable text", () => {
  const context = vm.createContext({ safeError: error => error.message });
  vm.runInContext(extract("function agentFailureEnvelope(", "\nfunction longbridgeFailureStatus("), context);
  for (const kind of ["terminal_unverified", "history_incomplete"]) {
    const result = context.agentFailureEnvelope({
      kind, message: "终态未核验", partialText: "已收到的第一段", threadId: "thread-a", turnId: "turn-a", operationId: "operation-a",
    });
    assert.equal(result.errorCode, kind);
    assert.equal(result.complete, false);
    assert.equal(result.partial, true);
    assert.equal(result.partialText, "已收到的第一段");
    assert.equal(result.run, undefined);
  }
  const ordinary = context.agentFailureEnvelope({ message: "普通错误", partialText: "not a valid partial" });
  assert.equal(ordinary.partialText, undefined);
});

test("main wiring uses one summary and an independent scoped intake with automatic view updates", () => {
  const snapshot = extract('ipcMain.handle("review:snapshot"', '\n  ipcMain.handle("review:backup:export"');
  assert.match(snapshot, /buildReviewSnapshot\(request\)/);
  const intake = extract('ipcMain.handle("review:intake:snapshot"', '\n  ipcMain.handle("review:intake:events"');
  assert.match(intake, /tradeHistoryService.intake\(request\)/);
  assert.doesNotMatch(intake, /buildReviewSnapshot/);
  assert.match(intake, /assertReviewAccountOperation\(identity\)/);
  assert.match(source, /cockpit:review-snapshot-updated/);
  assert.match(source, /authorizationLifecycle: longbridgeAuthorizationLifecycle/);
  assert.match(source, /tradeHistoryService\?\.busy/);
  assert.match(source, /recoveryFailure = agentFailureEnvelope\(error\)/);
});

const coverageScope = "account-a";
const restartAt = new Date("2026-08-21T01:00:00.000Z");
function attemptingLedger() {
  return transitionSnapshotCoverage(createSnapshotCoverageLedger({ createdAt: "2026-08-20T19:00:00Z" }), {
    eventId: "capture-attempt", accountScopeId: coverageScope, tradingDate: "2026-08-20",
    toStatus: "attempting", at: "2026-08-20T20:11:00Z",
  });
}
const durableEod = {
  snapshotId: "persisted-eod", accountScope: { scopeId: coverageScope },
  tradingDate: "2026-08-20", recordedAt: "2026-08-20T20:11:05Z", kind: "eod",
  valuation: { session: "regular_close", afterHoursMarksExcluded: true, methodVersion: "regular-close-v2" },
};
function coverageContext({ ledger = attemptingLedger(), snapshots = [durableEod], readError = null, writeError = null } = {}) {
  const writes = [], notices = [];
  let reads = 0;
  const store = {
    get: async () => ledger,
    set: async (key, value) => { if (writeError) throw writeError; writes.push(structuredClone(value)); },
  };
  const snapshotStore = { listSnapshots: async () => { reads++; if (readError) throw readError; return structuredClone(snapshots); } };
  const context = vm.createContext({
    Date, createSnapshotCoverageLedger, deserializeSnapshotCoverage, transitionSnapshotCoverage,
    reconcileDurableSnapshotCoverage, isCurrentRegularCloseSnapshot, deriveExpiredSnapshotGaps, listExpiredSnapshotCaptureAlerts,
    portfolioSnapshotCoverageLedger: ledger, portfolioSnapshotCoverageWriteQueue: Promise.resolve(),
    portfolioSnapshotCoverageStore: store, portfolioSnapshotStore: snapshotStore,
    PORTFOLIO_SNAPSHOT_COVERAGE_STORE_KEY: "coverage", PORTFOLIO_LEDGER_TIMEZONE: "America/New_York",
    portfolioSnapshotBackgroundPreferences: { enabled: true, monitoringStartedAt: "2026-08-20T19:00:00Z" },
    snapshotMonitoringStartedAtForScope: preferences => preferences.monitoringStartedAt,
    currentPortfolioLedgerScopeId: () => coverageScope,
    captureReviewAccountOperation: () => ({ scopeId: coverageScope }), assertReviewAccountOperation: () => true,
    localDateInTimezone: () => "2026-08-20", recentUsTradingDates: () => ["2026-08-20"],
    snapshotBackgroundRuntimeIntent: () => ({ notifyOnMissedCapture: false }),
    reviewSnapshotPublisher: { schedule() {} }, safeError: error => error.message, sendStatus: event => notices.push(event),
  });
  vm.runInContext(extract("async function initializeSnapshotCoverageLedger(", "\nfunction resumeAutomaticPortfolioEvidence("), context);
  vm.runInContext(extract("async function reconcileExpiredPortfolioSnapshotGaps(", "\nasync function rotatePortfolioLedgerScope("), context);
  return { context, store, snapshotStore, writes, notices, readCount: () => reads };
}

test("existing coverage initialization reconciles real snapshots rather than returning a stale index", async () => {
  const fixture = coverageContext();
  const ledger = await fixture.context.initializeSnapshotCoverageLedger({ store: fixture.store, snapshotStore: fixture.snapshotStore, scopeId: coverageScope });
  assert.equal(fixture.readCount(), 1);
  assert.equal(snapshotCoverageEntry(ledger, { accountScopeId: coverageScope, tradingDate: durableEod.tradingDate }).status, "confirmed");
  assert.equal(fixture.writes.length, 1);
});

test("expired gap sweep first commits durable captures and never labels their date missing", async () => {
  const fixture = coverageContext();
  const transitions = await fixture.context.reconcileExpiredPortfolioSnapshotGaps(restartAt);
  assert.equal(transitions.length, 0);
  assert.equal(fixture.writes.length, 1);
  assert.equal(snapshotCoverageEntry(fixture.context.portfolioSnapshotCoverageLedger, { accountScopeId: coverageScope, tradingDate: durableEod.tradingDate }).status, "confirmed");
  assert.equal(fixture.notices.some(event => event.state === "snapshot_gap"), false);
});

test("unreadable snapshots or an uncommitted coverage repair abort gap sealing", async () => {
  for (const failure of [{ readError: new Error("read failed") }, { writeError: new Error("write failed") }]) {
    const fixture = coverageContext(failure);
    await assert.rejects(fixture.context.reconcileExpiredPortfolioSnapshotGaps(restartAt), /failed/);
    assert.equal(fixture.context.portfolioSnapshotCoverageLedger.revision, 1);
    assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.notices.some(event => event.state === "snapshot_gap"), false);
  }
});

test("historical terminal gaps are preserved and conflicts block further gap sealing", async () => {
  const ledger = transitionSnapshotCoverage(attemptingLedger(), {
    eventId: "old-gap", accountScopeId: coverageScope, tradingDate: durableEod.tradingDate,
    toStatus: "gap", at: restartAt, reason: "previous capture not confirmed",
  });
  const fixture = coverageContext({ ledger });
  assert.deepEqual(await fixture.context.initializeSnapshotCoverageLedger({ store: fixture.store, snapshotStore: fixture.snapshotStore, scopeId: coverageScope }), ledger);
  assert.equal(fixture.notices.length, 1);
  await assert.rejects(fixture.context.reconcileExpiredPortfolioSnapshotGaps(restartAt), { code: "SNAPSHOT_COVERAGE_DURABLE_CONFLICT" });
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.context.portfolioSnapshotCoverageLedger.entries[0].status, "gap");
});

test("coverage initialization does not replace an unreadable or invalid index with an empty ledger", async () => {
  const fixture = coverageContext();
  const failingStore = { ...fixture.store, get: async () => { throw new Error("cannot decrypt"); } };
  await assert.rejects(fixture.context.initializeSnapshotCoverageLedger({ store: failingStore, snapshotStore: fixture.snapshotStore, scopeId: coverageScope }), /cannot decrypt/);
  await assert.rejects(fixture.context.initializeSnapshotCoverageLedger({ store: { ...fixture.store, get: async () => ({ schemaVersion: 999 }) }, snapshotStore: fixture.snapshotStore, scopeId: coverageScope }), { code: "SNAPSHOT_COVERAGE_SCHEMA_UNSUPPORTED" });
  assert.equal(fixture.writes.length, 0);
});

test("success notifications remain idempotent after a later durable reconciliation", async () => {
  const fixture = coverageContext();
  await fixture.context.reconcileSnapshotCoverageFromSnapshots([durableEod], coverageScope, restartAt);
  fixture.context.portfolioSnapshotCaptureRuntime = {};
  fixture.context.scheduleAutomaticTechnicalRadar = async () => {};
  vm.runInContext(extract("function recordPortfolioSnapshotCaptureSuccess(", "\nfunction uniqueRecentExecutions("), fixture.context);
  fixture.context.recordPortfolioSnapshotCaptureSuccess(durableEod);
  await fixture.context.portfolioSnapshotCoverageWriteQueue;
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.notices.length, 0);
  assert.equal(fixture.context.portfolioSnapshotCaptureRuntime.outcome, "confirmed");
});
