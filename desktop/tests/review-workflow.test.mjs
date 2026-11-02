import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { buildEarningsOrderFirstCycle, catalystSelectionRange, legacyCaseBrokerMatches, legacyReviewWriteError } from "../src/review/review-workflow.mjs";
import { reviewDayRange } from "../src/review/review-calendar.mjs";

const source = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
function between(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}
function selection(precision = "exact") {
  return {
    recordIds: ["order:buy", "execution:fill"], requestedRecordIds: ["order:buy"],
    relatedSymbols: ["AAPL.US"], orderIds: ["buy"], executionIds: ["fill"],
    activityStartAt: "2026-08-20T19:00:00Z", activityEndAt: "2026-08-20T19:01:00Z",
    records: [{ recordId: "order:buy", kind: "order", activityAt: "2026-08-20T19:00:00Z", symbol: "AAPL.US" }],
    event: { eventCandidateId: "earnings-a", symbol: "AAPL.US", eventDate: "2026-08-20", eventAt: "2026-08-20T20:05:00Z", eventTimePrecision: precision, eventSession: "amc", fiscalQuarter: "FY2026 Q3", timezone: "America/New_York", source: "Longbridge finance_calendar" },
  };
}

test("new earnings reviews use only selected broker activities and the confirmed event", () => {
  const cycle = buildEarningsOrderFirstCycle({ selection: selection() });
  assert.equal(cycle.type, "catalyst");
  assert.equal(cycle.reviewMode, "lightweight");
  assert.equal(cycle.startAt, "2026-08-20T19:00:00.000Z");
  assert.equal(cycle.endAt, "2026-08-20T20:05:00.000Z");
  assert.equal(cycle.catalystAt, cycle.endAt);
  assert.equal(cycle.eventMetadata.fiscalQuarter, "FY2026 Q3");
  assert.equal(cycle.exAnte, undefined);
  assert.equal(cycle.startingPortfolio, undefined);
  assert.throws(() => buildEarningsOrderFirstCycle({ selection: { ...selection(), event: null } }), /选择/);
});

test("date and session precision preserve uncertainty instead of creating an event timestamp", () => {
  for (const precision of ["date", "session"]) {
    const cycle = buildEarningsOrderFirstCycle({ selection: selection(precision) });
    assert.equal(cycle.catalystAt, null);
    assert.equal(cycle.eventMetadata.eventAt, null);
    assert.equal(cycle.eventMetadata.timePrecision, precision);
    assert.equal(cycle.eventMetadata.session, "amc");
    assert.equal(cycle.startAt, "2026-08-20T04:00:00.000Z");
    assert.equal(cycle.endAt, "2026-08-21T03:59:59.999Z");
    assert.match(cycle.description, /不代表财报发生时间/);
  }
});

test("catalyst re-selection uses the stored event, without changing its precision or looking up new facts", () => {
  const cycle = buildEarningsOrderFirstCycle({ selection: selection("session") });
  const original = structuredClone(cycle);
  assert.deepEqual(catalystSelectionRange({
    activityStartAt: "2026-08-19T18:00:00Z", activityEndAt: "2026-08-23T19:00:00Z",
    eventMetadata: cycle.eventMetadata, catalystAt: cycle.catalystAt,
  }), { startAt: "2026-08-19T18:00:00.000Z", endAt: "2026-08-23T19:00:00.000Z", timezone: "America/New_York" });
  assert.deepEqual(catalystSelectionRange({
    activityStartAt: "2026-08-20T18:00:00Z", activityEndAt: "2026-08-20T19:00:00Z",
    eventMetadata: cycle.eventMetadata, catalystAt: "2026-08-20T20:05:00Z",
  }), { startAt: "2026-08-20T04:00:00.000Z", endAt: "2026-08-21T03:59:59.999Z", timezone: "America/New_York" });
  assert.deepEqual(cycle, original);
});

test("broker re-selection expands lightweight catalyst bounds and rejects account changes before commit", async () => {
  const handlers = new Map();
  const cycle = { ...buildEarningsOrderFirstCycle({ selection: selection("session") }), id: "c1", brokerLinks: { accountScopeId: "a" } };
  const resolved = { ...selection(), activityStartAt: "2026-08-18T19:00:00Z", activityEndAt: "2026-08-23T19:00:00Z" };
  let currentScope = "a", switchOnResolve = false, stored;
  const stale = () => Object.assign(new Error("scope changed"), { code: "STALE_SCOPE" });
  const context = vm.createContext({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    assertTrustedSender() {}, assertTrustedRestoreIdle() {},
    captureReviewAccountOperation: () => ({ scopeId: currentScope }),
    assertReviewAccountOperation: identity => { if (identity.scopeId !== currentScope) throw stale(); return true; },
    stalePortfolioAccountScopeError: stale,
    withReviewLearningMutation: operation => operation(),
    reviewCycleStore: {
      snapshot: async () => ({ cycles: [cycle] }),
      replaceCycleBrokerRecords: async input => { input.commitGuard(); stored = input; return { recordIds: input.recordIds }; },
    },
    tradeHistoryService: {
      cached: async () => ({ accountScopeId: "a" }),
      resolveBrokerRecords: async () => { if (switchOnResolve) currentScope = "b"; return resolved; },
    },
    typedBrokerRecordIds: (_archive, ids) => ids, catalystSelectionRange,
    assertCycleBrokerSymbols: (item, input) => assert.equal(item.symbols[0], input.relatedSymbols[0]),
    assertCycleBrokerSelection: () => { throw new Error("fixed bounds must not be used"); },
    buildReviewSnapshot: async () => ({}),
  });
  vm.runInContext(between('  ipcMain.handle("review:cycle:link-broker"', '\n  ipcMain.handle("review:cycle:checkpoint"'), context);
  const invoke = () => handlers.get("review:cycle:link-broker")({}, { cycleId: "c1", replace: true, recordIds: ["order:buy"] });
  await invoke();
  assert.equal(stored.activityStartAt, "2026-08-18T19:00:00.000Z");
  assert.equal(stored.activityEndAt, "2026-08-23T19:00:00.000Z");
  assert.equal(stored.accountScopeId, "a");
  stored = null;
  switchOnResolve = true;
  await assert.rejects(invoke(), { code: "STALE_SCOPE" });
  assert.equal(stored, null);
});

test("event-date intervals respect DST and reject impossible dates", () => {
  const spring = reviewDayRange("2026-03-08", "America/New_York");
  const fall = reviewDayRange("2026-11-01", "America/New_York");
  assert.equal(Date.parse(spring.endAt) - Date.parse(spring.startAt) + 1, 23 * 3600000);
  assert.equal(Date.parse(fall.endAt) - Date.parse(fall.startAt) + 1, 25 * 3600000);
  assert.throws(() => reviewDayRange("2026-02-30"), /无效/);
  assert.throws(() => reviewDayRange("2026-08-20", "Bad/Timezone"), /时区无效/);
  assert.equal(reviewDayRange("2026-08-20", "UTC").startAt, "2026-08-20T00:00:00.000Z");
});

test("legacy broker matches never infer a missing binding or borrow identically named foreign orders", () => {
  const archive = { accountScopeId: "b", orders: [{ orderId: "1" }], executions: [{ tradeId: "2" }] };
  const reviewCase = { brokerLinks: { accountScopeId: "a", confirmedAt: "2026-08-20", orderIds: ["1"], executionIds: ["2"] } };
  assert.deepEqual(legacyCaseBrokerMatches(reviewCase, archive).orders, []);
  assert.equal(legacyCaseBrokerMatches(reviewCase, archive).accountScopeStatus, "mismatch");
  assert.equal(legacyCaseBrokerMatches({ ...reviewCase, brokerLinks: { ...reviewCase.brokerLinks, accountScopeId: null } }, archive).accountScopeStatus, "legacy_unbound");
  const matched = legacyCaseBrokerMatches(reviewCase, { ...archive, accountScopeId: "a" });
  assert.equal(matched.orders.length, 1);
  assert.equal(matched.executions.length, 1);
  assert.equal(matched.readOnly, true);
});

test("every retired app write route rejects before any legacy store write", async () => {
  const handlers = new Map();
  let calls = 0;
  const context = vm.createContext({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    assertTrustedSender() {}, assertTrustedRestoreIdle() {}, legacyReviewWriteError,
    reviewStore: new Proxy({}, { get: () => () => { calls++; throw new Error("unexpected mutation"); } }),
  });
  for (const channel of ["case:create", "case:create-from-records", "case:update", "case:freeze", "case:link-broker", "test:register", "rule:create"]) {
    vm.runInContext(between(`  ipcMain.handle("review:${channel}"`, '\n  ipcMain.handle('), context);
    await assert.rejects(handlers.get(`review:${channel}`)({}, {}), { code: "LEGACY_REVIEW_READ_ONLY" });
  }
  assert.equal(calls, 0);
});

test("legacy standalone learning writes are rejected while unified protocols retain their source check", async () => {
  let asserted = 0;
  const workspace = { tests: [{ id: "old-test" }, { id: "protocol", testKind: "protocol", ruleId: "linked-rule" }], rules: [{ id: "old-rule" }, { id: "linked-rule", testIds: ["protocol"] }], validationPackages: [] };
  const context = vm.createContext({
    reviewStore: { snapshot: async () => workspace }, reviewCycleStore: { snapshot: async () => ({ cycles: [] }) },
    assertLearningSourceCurrent: () => { asserted++; }, legacyReviewWriteError,
  });
  vm.runInContext(between("async function assertReviewLearningMutationSource(", "\nasync function assertReviewObservationCycle("), context);
  await assert.rejects(context.assertReviewLearningMutationSource({ testId: "old-test" }), { code: "LEGACY_REVIEW_READ_ONLY" });
  await assert.rejects(context.assertReviewLearningMutationSource({ ruleId: "old-rule" }), { code: "LEGACY_REVIEW_READ_ONLY" });
  assert.equal((await context.assertReviewLearningMutationSource({ ruleId: "linked-rule" })).workspace, workspace);
  assert.equal(asserted, 1, "even a source with missing IDs must pass the source-status policy");
});

test("observation requires an explicit cycle and a current protocol candidate", async () => {
  let reads = 0;
  const context = vm.createContext({
    buildReviewSnapshot: async () => { reads++; return { tests: [{ id: "old" }], validationCandidates: {} }; },
    legacyReviewWriteError,
  });
  vm.runInContext(between("async function assertReviewObservationCycle(", "\nasync function resolveVerifiedProtocolSample("), context);
  await assert.rejects(context.assertReviewObservationCycle({ testId: "old" }), /明确选择/);
  assert.equal(reads, 0);
  await assert.rejects(context.assertReviewObservationCycle({ testId: "old", reviewCycleId: "cycle" }), { code: "LEGACY_REVIEW_READ_ONLY" });
});

test("old review analysis is rejected before starting an operation or persisting a new user turn", async () => {
  const handlers = new Map();
  const context = vm.createContext({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    assertTrustedSender() {}, assertTrustedRestoreIdle() {}, validateAnalysisScope: () => "review", portfolio: null,
    ibkr: { generation: 1 }, legacyReviewWriteError,
  });
  vm.runInContext(between('  ipcMain.handle("agent:run"', '\n  ipcMain.handle("agent:cancel"'), context);
  await assert.rejects(handlers.get("agent:run")({}, { scope: "review", caseId: "old" }), { code: "LEGACY_REVIEW_READ_ONLY" });
});

test("host earnings creation ignores renderer event facts and verifies identity at commit", async () => {
  const handlers = new Map();
  const resolved = selection("session");
  let created, guards = 0;
  const context = vm.createContext({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    assertTrustedSender() {}, assertTrustedRestoreIdle() {}, captureReviewAccountOperation: () => ({ scopeId: "a" }),
    assertReviewAccountOperation: () => { guards++; return true; },
    tradeHistoryService: { cached: async () => ({ accountScopeId: "a" }), resolveReviewSelection: async input => { assert.equal(input.eventCandidateId, "earnings-a"); return resolved; } },
    typedBrokerRecordIds: (_archive, ids) => ids, buildEarningsOrderFirstCycle,
    brokerLinksFromSelection: (chosen, accountScopeId) => ({ recordIds: chosen.recordIds, accountScopeId }),
    reviewStartingPortfolioSnapshot: () => null, portfolio: null,
    reviewCycleStore: { createLinkedCycle: async input => { assert.equal(input.commitGuard(), true); created = input; return { id: "cycle-1" }; } },
    buildReviewSnapshot: async () => ({}),
  });
  vm.runInContext(between('  ipcMain.handle("review:cycle:create-order-first"', '\n  ipcMain.handle("review:cycle:update"'), context);
  const result = await handlers.get("review:cycle:create-order-first")({}, {
    flow: "earnings", recordIds: ["order:buy"], eventCandidateId: "earnings-a", symbol: "WRONG.US", eventAt: "1999-01-01",
    retrospectiveNote: { recalledJudgment: "记忆", lesson: "感悟", forwardHypothesis: "待验证" },
  });
  assert.equal(result.cycle.id, "cycle-1");
  assert.equal(created.cycle.symbols[0], "AAPL.US");
  assert.equal(created.cycle.catalystAt, null);
  assert.equal(created.links.accountScopeId, "a");
  assert.ok(guards >= 4);
});

test("migration host resolves exactly legacy linked IDs and can reopen an existing migration offline", async () => {
  const reviewCase = { id: "legacy-1", brokerLinks: { accountScopeId: "a", orderIds: ["1"], executionIds: ["2"] } };
  let reads = 0, existing = false, forwarded;
  const context = vm.createContext({
    reviewStore: { snapshot: async () => ({ cases: [reviewCase] }) },
    reviewCycleStore: { snapshot: async () => ({ cycles: existing ? [{ id: "cycle-1", legacySource: { sourceCaseId: "legacy-1", accountScopeId: "a" } }] : [] }) },
    assertReviewAccountOperation: () => true,
    tradeHistoryService: { cached: async () => { reads++; return { accountScopeId: "a" }; }, resolveBrokerRecords: async request => { assert.deepEqual(Array.from(request.recordIds), ["order:1", "execution:2"]); return selection(); } },
    buildLegacyCaseMigration: input => { forwarded = input; return { preview: {} }; },
    stalePortfolioAccountScopeError: () => Object.assign(new Error("scope mismatch"), { code: "STALE_SCOPE" }),
  });
  vm.runInContext(between("async function prepareLegacyCaseMigration(", "\nfunction positiveMainInteger("), context);
  await context.prepareLegacyCaseMigration("legacy-1", { scopeId: "a" });
  assert.equal(forwarded.selection.accountScopeId, "a");
  existing = true;
  await context.prepareLegacyCaseMigration("legacy-1", { scopeId: "a" });
  assert.equal(reads, 1);
  assert.equal(forwarded.selection, null);
  await assert.rejects(context.prepareLegacyCaseMigration("legacy-1", { scopeId: "b" }), { code: "STALE_SCOPE" });
});
