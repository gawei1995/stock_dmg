import assert from "node:assert/strict";
import test from "node:test";
import { ReviewCycleStore } from "../src/data/review-cycle-store.mjs";
import {
  buildReviewCycleAnalysisRun,
  filterCandlesBeforeReviewCutoff,
  selectCycleRecordIds,
} from "../src/review/review-cycle-analysis.mjs";

function cycleFixture(overrides = {}) {
  return {
    id: "cycle-1",
    type: "catalyst",
    title: "NVDA 财报",
    symbol: "NVDA.US",
    scope: "symbol",
    benchmark: "QQQ.US",
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-20T23:59:59.000Z",
    eventKind: "earnings",
    eventAt: "2026-08-15T20:00:00.000Z",
    status: "sealed",
    brokerLinks: {
      revision: 1,
      evidenceRevision: 1,
      orderIds: ["before", "after"],
      executionIds: ["fill-before", "fill-after"],
      confirmedAt: "2026-08-10T00:00:00.000Z",
    },
    exAnteVersions: [{
      version: 1,
      sealedAt: "2026-08-10T00:00:00.000Z",
      cutoffAt: "2026-08-10T00:00:00.000Z",
      timing: "prospective",
      eligibleForFormalStats: true,
      hash: "hash-1",
      snapshot: { exAnte: {
        myView: "需求强",
        marketView: "市场预期偏高",
        plannedAction: "只在确认后加仓",
        invalidation: "指引下修",
      } },
    }],
    checkpoints: [
      { id: "cp-before", at: "2026-08-09T12:00:00.000Z", kind: "buy", action: "试仓" },
      { id: "cp-after", at: "2026-08-16T12:00:00.000Z", kind: "reduce", action: "减仓" },
    ],
    phaseRuns: { blind: [], outcome: [] },
    outcome: { summary: "指引超过预期", pnl: 500 },
    ...overrides,
  };
}

function archiveFixture() {
  return {
    source: "Longbridge MCP · read only",
    syncedAt: "2026-08-21T00:00:00.000Z",
    completeness: { orders: "complete", executions: "complete" },
    warnings: [],
    orders: [
      { orderId: "before", symbol: "NVDA.US", side: "Buy", quantity: 10, submittedAt: "2026-08-09T12:00:00.000Z" },
      { orderId: "after", symbol: "NVDA.US", side: "Sell", quantity: 5, submittedAt: "2026-08-16T12:00:00.000Z" },
    ],
    executions: [
      { tradeId: "fill-before", orderId: "before", symbol: "NVDA.US", side: "Buy", quantity: 10, price: 100, doneAt: "2026-08-09T12:01:00.000Z" },
      { tradeId: "fill-after", orderId: "after", symbol: "NVDA.US", side: "Sell", quantity: 5, price: 120, doneAt: "2026-08-16T12:01:00.000Z" },
    ],
  };
}

class MemoryReviewStore {
  constructor() { this.values = new Map(); }
  async get(key) { return structuredClone(this.values.get(key)); }
  async set(key, value) { this.values.set(key, structuredClone(value)); }
}

test("blind review physically excludes every post-cutoff broker fact, checkpoint, and outcome", () => {
  const run = buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycleFixture()] },
    archive: archiveFixture(),
    cycleId: "cycle-1",
    phase: "blind",
    now: () => new Date("2026-08-10T01:00:00.000Z"),
  });

  assert.equal(run.context.reviewProtocol, "decision_cycle");
  assert.equal(run.context.reviewPhase, "blind");
  assert.deepEqual(run.analysisContext.cycle.orders.map((item) => item.side), ["Buy"]);
  assert.deepEqual(run.analysisContext.cycle.executions.map((item) => item.price), [100]);
  assert.deepEqual(run.analysisContext.cycle.checkpoints.map((item) => item.id), ["cp-before"]);
  assert.equal(run.analysisContext.cycle.outcome, null);
  assert.equal(run.analysisContext.timeFirewall.hiddenOrderCount, 1);
  assert.equal(run.analysisContext.timeFirewall.hiddenExecutionCount, 1);
  assert.equal(run.analysisContext.timeFirewall.hiddenCheckpointCount, 1);
  assert.doesNotMatch(JSON.stringify(run), /指引超过预期|"pnl":500|"price":120|cp-after/);
  assert.match(run.task, /\$review-decision-cycles/);
});

test("blind review excludes a checkpoint backfilled after the cutoff even when occurredAt is earlier", () => {
  const run = buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycleFixture({
      checkpoints: [
        {
          id: "known-before",
          occurredAt: "2026-08-09T09:00:00.000Z",
          recordedAt: "2026-08-09T09:01:00.000Z",
          note: "事前已记录",
          fundamental: "当时基本面证据",
          technical: "当时技术证据",
          evidence: [
            { id: "known-evidence", observedAt: "2026-08-09T08:00:00.000Z", summary: "已知资料" },
            { id: "future-evidence", observedAt: "2026-08-11T08:00:00.000Z", summary: "未来资料" },
          ],
        },
        {
          id: "backfilled-later",
          occurredAt: "2026-08-09T10:00:00.000Z",
          recordedAt: "2026-08-12T10:00:00.000Z",
          note: "事后补写",
        },
      ],
    })] },
    archive: archiveFixture(),
    cycleId: "cycle-1",
    phase: "blind",
    now: () => new Date("2026-08-20T00:00:00.000Z"),
  });
  assert.deepEqual(run.analysisContext.cycle.checkpoints.map((item) => item.id), ["known-before"]);
  assert.equal(run.analysisContext.cycle.checkpoints[0].fundamental, "当时基本面证据");
  assert.equal(run.analysisContext.cycle.checkpoints[0].technical, "当时技术证据");
  assert.deepEqual(run.analysisContext.cycle.checkpoints[0].evidence.map((item) => item.id), ["known-evidence"]);
  assert.doesNotMatch(JSON.stringify(run), /事后补写/);
  assert.doesNotMatch(JSON.stringify(run), /未来资料/);
});

test("blind review excludes facts stamped exactly at the knowledge cutoff", () => {
  const archive = archiveFixture();
  archive.orders.push({
    orderId: "at-cutoff",
    symbol: "NVDA.US",
    side: "Buy",
    submittedAt: "2026-08-10T00:00:00.000Z",
  });
  const cycle = cycleFixture({
    brokerLinks: {
      orderIds: ["before", "at-cutoff"],
      executionIds: [],
    },
    checkpoints: [{
      id: "cp-at-cutoff",
      occurredAt: "2026-08-09T23:59:00.000Z",
      recordedAt: "2026-08-10T00:00:00.000Z",
      note: "边界信息",
    }],
  });
  const run = buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycle] },
    archive,
    cycleId: cycle.id,
    phase: "blind",
  });
  assert.equal(run.analysisContext.cycle.orders.length, 1);
  assert.deepEqual(run.analysisContext.cycle.orders.map((item) => item.side), ["Buy"]);
  assert.equal(run.analysisContext.cycle.checkpoints.length, 0);
  assert.doesNotMatch(JSON.stringify(run), /边界信息/);
});

test("review evidence hides an excluded Longbridge execution while preserving auditable exclusion counts", () => {
  const archive = archiveFixture();
  archive.executions = [{
    tradeId: "unverified-fill",
    orderId: "missing-parent",
    symbol: "TSLA.US",
    side: null,
    quantity: 1,
    price: null,
    reportedPrice: 5.36,
    currency: null,
    doneAt: "2026-08-09T12:01:00.000Z",
    priceAudit: {
      status: "excluded",
      sourceField: "Longbridge history_executions.price",
      reportedValue: 5.36,
      reason: "orphan_equity_execution_missing_parent_side_currency",
      instrumentType: "equity",
      parentOrderMatched: false,
      sideResolved: false,
      currencyResolved: false,
    },
  }];
  const cycle = cycleFixture({
    brokerLinks: { orderIds: [], executionIds: ["unverified-fill"] },
  });
  const run = buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycle] },
    archive,
    cycleId: cycle.id,
    phase: "blind",
  });
  assert.equal(run.analysisContext.cycle.executions.length, 0);
  assert.equal(run.analysisContext.cycle.brokerAssociation.excludedAuditExecutionCount, 1);
  assert.equal(run.analysisContext.cycle.brokerAssociation.excludedAuditExecutionReasons.side_unverified, 1);
  assert.equal(run.analysisContext.cycle.brokerAssociation.requestedRecordCount, 0);
});

test("outcome review is gated by a completed blind assessment and then reveals the result", () => {
  const noBlind = cycleFixture({ status: "outcome_ready" });
  assert.throws(() => buildReviewCycleAnalysisRun({
    workspace: { cycles: [noBlind] },
    archive: archiveFixture(),
    cycleId: "cycle-1",
    phase: "outcome",
  }), /必须引用已经完成的阶段一/);

  const cycle = cycleFixture({
    status: "outcome_ready",
    phaseRuns: { blind: [{
      id: "blind-1",
      threadId: "thread-blind",
      status: "completed",
      completedAt: "2026-08-10T01:00:00.000Z",
      inputSnapshotHash: "evidence-hash",
      resultHash: "result-hash",
      result: { conclusion: { body: "事前计划自洽" } },
    }], outcome: [] },
  });
  const run = buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycle] },
    archive: archiveFixture(),
    cycleId: "cycle-1",
    phase: "outcome",
    now: () => new Date("2026-08-21T00:00:00.000Z"),
  });
  assert.equal(run.context.blindAssessmentId, "blind-1");
  assert.equal(run.analysisContext.cycle.blindAssessment.frozen, true);
  assert.equal(run.analysisContext.cycle.blindAssessment.summary, "事前计划自洽");
  assert.equal(run.analysisContext.cycle.blindAssessment.evidenceHash, "evidence-hash");
  assert.equal(run.analysisContext.cycle.outcome.pnl, 500);
  assert.equal(run.analysisContext.cycle.orders.length, 2);
  assert.equal(run.analysisContext.timeFirewall.outcomeAvailable, true);
});

test("deterministic outcome metrics are delivered only in outcome phase with provenance intact", () => {
  const metrics = {
    status: "partial",
    generatedAt: "2026-08-21T00:00:00.000Z",
    executionPnl: { linkedRoundTripGrossPnl: 40, accountRealizedGrossPnl: null, currency: "USD", netPnl: null, netPnlReason: "execution_fees_and_taxes_unavailable" },
    pricePath: { symbols: [{ symbol: "NVDA.US", periodReturnPercent: 12 }], benchmarkMetrics: { periodReturnPercent: 5 } },
    coverage: { reasons: ["some_candles_unavailable"], loadedSymbols: [{ symbol: "NVDA.US" }] },
    provenance: { deterministicHostCalculation: true, modelLookupAllowedAsMetricSubstitute: true },
  };
  const outcomeCycle = cycleFixture({
    phaseRuns: { blind: [{ id: "blind-1", threadId: "thread-blind", status: "completed" }], outcome: [] },
  });
  const outcome = buildReviewCycleAnalysisRun({
    workspace: { cycles: [outcomeCycle] },
    archive: archiveFixture(),
    cycleId: outcomeCycle.id,
    phase: "outcome",
    deterministicOutcomeMetrics: metrics,
    now: () => new Date("2026-08-21T00:00:00.000Z"),
  });
  assert.equal(outcome.analysisContext.deterministicOutcomeMetrics.executionPnl.linkedRoundTripGrossPnl, 40);
  assert.equal(outcome.analysisContext.deterministicOutcomeMetrics.provenance.modelLookupAllowedAsMetricSubstitute, false);
  assert.equal(outcome.evidence.at(-1).tool, "review:decision-cycle:outcome-metrics");
  assert.equal(outcome.evidence.at(-1).status, "degraded");

  const blind = buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycleFixture()] },
    archive: archiveFixture(),
    cycleId: "cycle-1",
    phase: "blind",
    deterministicOutcomeMetrics: metrics,
  });
  assert.equal(blind.analysisContext.deterministicOutcomeMetrics, null);
  assert.doesNotMatch(JSON.stringify(blind), /linkedRoundTripGrossPnl/);
});

test("a current portfolio observed after the cycle is never mislabeled as the ending portfolio", () => {
  const cycle = cycleFixture({
    status: "outcome_ready",
    phaseRuns: { blind: [{
      id: "blind-1",
      threadId: "thread-blind",
      status: "completed",
      result: { conclusion: { body: "冻结判断" } },
    }] },
  });
  const run = buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycle] },
    archive: archiveFixture(),
    cycleId: cycle.id,
    phase: "outcome",
    portfolio: {
      syncedAt: "2026-08-21T12:00:00.000Z",
      account: { baseCurrency: "USD" },
      totals: { netAssets: 125_000 },
      positions: [{ symbol: "NVDA.US", quantity: 20, weight: 18 }],
    },
    now: () => new Date("2026-08-21T12:00:00.000Z"),
  });
  assert.equal(run.analysisContext.cycle.endingPortfolio, null);
  assert.equal(run.analysisContext.cycle.currentPortfolioContext.snapshotAt, "2026-08-21T12:00:00.000Z");
  assert.equal(run.analysisContext.cycle.portfolioCoverage.currentPortfolioRelation, "after_cycle_end");
  assert.match(run.analysisContext.cycle.portfolioCoverage.note, /不得替代周期末仓位/);
});

test("only an in-cycle historical portfolio snapshot may be labeled as ending evidence", () => {
  const cycle = cycleFixture({
    status: "outcome_ready",
    endingPortfolio: {
      snapshotAt: "2026-08-20T20:00:00.000Z",
      baseCurrency: "USD",
      netAssets: 120_000,
      positions: [{ symbol: "NVDA.US", quantity: 15, weightPercent: 12 }],
    },
    phaseRuns: { blind: [{
      id: "blind-1",
      threadId: "thread-blind",
      status: "completed",
      result: { conclusion: { body: "冻结判断" } },
    }] },
  });
  const run = buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycle] },
    archive: archiveFixture(),
    cycleId: cycle.id,
    phase: "outcome",
    now: () => new Date("2026-08-21T12:00:00.000Z"),
  });
  assert.equal(run.analysisContext.cycle.endingPortfolio.snapshotAt, "2026-08-20T20:00:00.000Z");
  assert.equal(run.analysisContext.cycle.portfolioCoverage.endingPortfolioAvailable, true);
});

test("outcome broker facts remain bounded by the declared cycle end", () => {
  const archive = archiveFixture();
  archive.orders.push({
    orderId: "post-cycle",
    symbol: "NVDA.US",
    side: "Sell",
    quantity: 1,
    submittedAt: "2026-08-21T12:00:00.000Z",
  });
  const cycle = cycleFixture({
    status: "blind_reviewed",
    brokerLinks: { orderIds: ["before", "after", "post-cycle"], executionIds: [] },
    phaseRuns: { blind: [{ id: "blind-1", threadId: "thread-blind", status: "completed" }], outcome: [] },
  });
  const run = buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycle] },
    archive,
    cycleId: cycle.id,
    phase: "outcome",
    now: () => new Date("2026-08-22T00:00:00.000Z"),
  });
  assert.equal(run.analysisContext.cycle.orders.length, 2);
  assert.equal(run.analysisContext.timeFirewall.postCycleOrderCount, 0);
  assert.equal(run.analysisContext.cycle.brokerAssociation.excludedAuditOrderCount, 1);
  assert.doesNotMatch(JSON.stringify(run), /post-cycle/);
});

test("a pre-cycle parent order kept by broker closure is labeled as context, not cycle execution", () => {
  const archive = archiveFixture();
  archive.orders.push({
    orderId: "parent-before-cycle",
    symbol: "NVDA.US",
    side: "Buy",
    quantity: 10,
    status: "FilledStatus",
    executedQuantity: 10,
    submittedAt: "2026-07-31T23:00:00.000Z",
  });
  const cycle = cycleFixture({
    brokerLinks: {
      orderIds: ["parent-before-cycle", "before"],
      executionIds: ["fill-before"],
    },
  });
  const run = buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycle] },
    archive,
    cycleId: cycle.id,
    phase: "blind",
  });
  const parent = run.analysisContext.cycle.orders.find((item) => item.submittedAt === "2026-07-31T23:00:00.000Z");
  assert.equal(parent.relationshipContext, "pre_cycle_context");
  assert.equal(run.analysisContext.timeFirewall.preCycleOrderCount, 1);
  assert.equal(run.analysisContext.cycle.executions[0].relationshipContext, "in_cycle");
});

test("retrospective cycles remain reviewable but never masquerade as prospective evidence", () => {
  const cycle = cycleFixture({
    exAnteVersions: [{
      version: 1,
      sealedAt: "2026-08-18T00:00:00.000Z",
      cutoffAt: "2026-08-18T00:00:00.000Z",
      timing: "retrospective",
      eligibleForFormalStats: false,
      snapshot: { exAnte: { myView: "补写", marketView: "补写", plannedAction: "补写", invalidation: "补写" } },
    }],
  });
  const run = buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycle] },
    archive: archiveFixture(),
    cycleId: "cycle-1",
    phase: "blind",
  });
  assert.equal(run.analysisContext.cycle.evidenceGrade, "retrospective");
  assert.equal(run.analysisContext.cycle.sealedExAnte.eligibleForFormalStats, false);
  assert.match(run.evidence[1].summary, /retrospective/);
});

test("all three cycle types produce stable protocol metadata", () => {
  for (const type of ["catalyst", "position_lifecycle", "monthly_portfolio"]) {
    const cycle = cycleFixture({
      type,
      symbol: type === "monthly_portfolio" ? null : "NVDA.US",
      symbols: type === "monthly_portfolio" ? ["AAPL.US", "NVDA.US"] : undefined,
    });
    const run = buildReviewCycleAnalysisRun({
      workspace: { cycles: [cycle] },
      archive: archiveFixture(),
      cycleId: "cycle-1",
      phase: "blind",
    });
    assert.equal(run.context.cycleType, type);
    assert.equal(run.analysisContext.evidencePolicy.emaOrFibRequired, false);
    assert.equal(run.analysisContext.evidencePolicy.narrativeStageIndependentFromTechnicalTemperature, true);
  }
});

test("point-in-time technical snapshots stay explicitly optional and cutoff-labelled", () => {
  const run = buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycleFixture()] },
    archive: archiveFixture(),
    cycleId: "cycle-1",
    phase: "blind",
    pointInTimeTechnical: {
      status: "complete",
      asOf: "2026-08-10T00:00:00.000Z",
      cutoffPolicy: "严格排除截止日",
      requestedSymbols: ["NVDA.US", "QQQ.US"],
      omittedSymbols: [],
      warnings: [],
      snapshots: [{
        symbol: "NVDA.US",
        source: "Longbridge daily candles",
        asOf: "2026-08-09T00:00:00.000Z",
        ema: { 3: 100, 21: 95, 144: null, 169: null },
        shortStructure: "完整多头",
        fib: null,
      }],
    },
  });
  assert.equal(run.analysisContext.pointInTimeTechnical.snapshots[0].ema[21], 95);
  assert.equal(run.analysisContext.evidencePolicy.emaOrFibRequired, false);
  assert.match(run.analysisContext.pointInTimeTechnical.cutoffPolicy, /排除截止日/);
});

test("daily candles from the cutoff date and later are physically excluded before technical calculation", () => {
  const bars = [
    { tradeDate: "2026-08-08", timestamp: "2026-08-08T04:00:00Z", close: 100 },
    { tradeDate: "2026-08-09", timestamp: "2026-08-09T04:00:00Z", close: 101 },
    { tradeDate: "2026-08-10", timestamp: "2026-08-10T04:00:00Z", close: 200 },
    { tradeDate: "2026-08-11", timestamp: "2026-08-11T04:00:00Z", close: 300 },
  ];
  const filtered = filterCandlesBeforeReviewCutoff(bars, "2026-08-10T20:00:00Z");
  assert.deepEqual(filtered.map((bar) => bar.tradeDate), ["2026-08-08", "2026-08-09"]);
  assert.doesNotMatch(JSON.stringify(filtered), /200|300/);
});

test("cycle auto-link selection respects symbol boundaries but monthly portfolio includes every symbol", () => {
  const archive = archiveFixture();
  archive.orders.push({ orderId: "aapl", symbol: "AAPL.US", status: "FilledStatus", executedQuantity: 1, submittedAt: "2026-08-05T12:00:00.000Z" });
  archive.orders.push({ orderId: "cancelled-aapl", symbol: "AAPL.US", status: "CanceledStatus", executedQuantity: 0, submittedAt: "2026-08-06T12:00:00.000Z" });
  const position = selectCycleRecordIds(archive, cycleFixture({ type: "position_lifecycle" }));
  assert.equal(position.includes("order:aapl"), false);
  const monthly = selectCycleRecordIds(archive, cycleFixture({ type: "monthly_portfolio", symbol: null, symbols: [] }));
  assert.equal(monthly.includes("order:aapl"), true);
  assert.equal(monthly.includes("order:cancelled-aapl"), false);
});

test("monthly portfolio selection uses its declared market timezone instead of truncating the final US session", () => {
  const archive = archiveFixture();
  archive.orders.push(
    { orderId: "last-us-session", symbol: "AAPL.US", status: "FilledStatus", executedQuantity: 1, submittedAt: "2026-08-01T00:30:00.000Z" },
    { orderId: "next-us-month", symbol: "AAPL.US", status: "FilledStatus", executedQuantity: 1, submittedAt: "2026-08-01T04:00:00.000Z" },
  );
  const ids = selectCycleRecordIds(archive, cycleFixture({
    type: "monthly_portfolio",
    symbol: null,
    symbols: [],
    month: "2026-07",
    timezone: "America/New_York",
    startAt: "2026-07-01T04:00:00.000Z",
    endAt: "2026-08-01T03:59:59.999Z",
  }));
  assert.equal(ids.includes("order:last-us-session"), true);
  assert.equal(ids.includes("order:next-us-month"), false);
});

test("outcome phase refuses an active lifecycle without an explicit ending", () => {
  const cycle = cycleFixture({
    type: "position_lifecycle",
    endAt: null,
    status: "blind_reviewed",
    phaseRuns: { blind: [{ assessmentId: "blind-1", threadId: "thread-blind", status: "completed" }] },
  });
  assert.throws(() => buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycle] },
    archive: archiveFixture(),
    cycleId: "cycle-1",
    phase: "outcome",
    now: () => new Date("2026-09-01T00:00:00.000Z"),
  }), /尚未结束/);
});

test("a forged completed status cannot bypass an absent cycle end time", () => {
  const cycle = cycleFixture({
    type: "position_lifecycle",
    endAt: null,
    status: "completed",
    phaseRuns: { blind: [{ id: "blind-1", threadId: "thread-blind", status: "completed" }] },
  });
  assert.throws(() => buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycle] },
    archive: archiveFixture(),
    cycleId: "cycle-1",
    phase: "outcome",
    now: () => new Date("2026-09-01T00:00:00.000Z"),
  }), /尚未结束/);
});

test("sealed store snapshot, late history linking, blind run, and outcome form one end-to-end temporal chain", async () => {
  let now = "2026-08-01T00:00:00.000Z";
  let id = 0;
  const store = new ReviewCycleStore({
    store: new MemoryReviewStore(),
    now: () => new Date(now),
    idFactory: () => `cycle-e2e-${++id}`,
  });
  const cycle = await store.createCycle({
    type: "catalyst",
    symbol: "NVDA.US",
    startAt: "2026-08-01T00:00:00.000Z",
    catalystAt: "2026-08-05T20:00:00.000Z",
    endAt: "2026-08-10T23:59:59.000Z",
    exAnte: {
      myView: "需求仍强",
      marketView: "市场预期偏高",
      plannedAction: "确认后小仓参与",
      invalidation: "指引下修",
      fundamentalView: "封存前基本面证据",
      technicalView: "封存前技术证据",
    },
  });
  now = "2026-08-03T00:00:00.000Z";
  await store.sealCycle({ cycleId: cycle.id });
  now = "2026-08-11T00:00:00.000Z";
  await store.linkCycleRecords({
    cycleId: cycle.id,
    recordIds: ["order:known", "order:future"],
    orderIds: ["known", "future"],
    records: [
      { id: "order:known", kind: "order", occurredAt: "2026-08-02T12:00:00.000Z", symbol: "NVDA.US" },
      { id: "order:future", kind: "order", occurredAt: "2026-08-06T12:00:00.000Z", symbol: "NVDA.US" },
    ],
  });
  const archive = {
    source: "Longbridge MCP · read only",
    syncedAt: now,
    orders: [
      { orderId: "known", symbol: "NVDA.US", side: "Buy", status: "FilledStatus", quantity: 10, executedQuantity: 10, submittedAt: "2026-08-02T12:00:00.000Z" },
      { orderId: "future", symbol: "NVDA.US", side: "Sell", status: "FilledStatus", quantity: 5, executedQuantity: 5, submittedAt: "2026-08-06T12:00:00.000Z" },
    ],
    executions: [],
  };
  const blindWorkspace = await store.snapshot({ cycleId: cycle.id, phase: "blind" });
  const blindRun = buildReviewCycleAnalysisRun({
    workspace: blindWorkspace,
    archive,
    cycleId: cycle.id,
    phase: "blind",
    now: () => new Date(now),
  });
  assert.equal(blindRun.analysisContext.cycle.orders.length, 1);
  assert.equal(blindRun.analysisContext.cycle.orders[0].side, "Buy");
  assert.equal(
    blindRun.analysisContext.cycle.sealedExAnte.userOriginal.fundamentalView,
    "封存前基本面证据",
  );
  await store.recordPhaseRun({
    cycleId: cycle.id,
    phase: "blind",
    threadId: "thread-blind-e2e",
    result: { conclusion: { body: "冻结的盲态判断" } },
  });
  const outcomeWorkspace = await store.snapshot({ cycleId: cycle.id, phase: "outcome" });
  const outcomeRun = buildReviewCycleAnalysisRun({
    workspace: outcomeWorkspace,
    archive,
    cycleId: cycle.id,
    phase: "outcome",
    now: () => new Date(now),
  });
  assert.equal(outcomeRun.analysisContext.cycle.orders.length, 2);
  assert.equal(outcomeRun.analysisContext.cycle.blindAssessment.summary, "冻结的盲态判断");
});

test("blind decision timeline hydrates each node with only its broker facts and point-in-time technical capsule", async () => {
  let now = "2026-08-01T00:00:00.000Z";
  let id = 0;
  const store = new ReviewCycleStore({
    store: new MemoryReviewStore(),
    now: () => new Date(now),
    idFactory: () => `timeline-e2e-${++id}`,
  });
  const cycle = await store.createCycle({
    type: "catalyst",
    symbol: "NVDA.US",
    title: "NVDA 决策时间线",
    startAt: "2026-08-01T00:00:00.000Z",
    catalystAt: "2026-08-06T20:00:00.000Z",
    endAt: "2026-08-10T23:59:59.000Z",
    exAnte: {
      myView: "初始判断",
      marketView: "初始市场预期",
      plannedAction: "先建小仓",
      invalidation: "需求转弱",
    },
  });
  now = "2026-08-02T00:00:00.000Z";
  await store.sealCycle({ cycleId: cycle.id });
  await store.linkCycleRecords({
    cycleId: cycle.id,
    records: [{ recordId: "order:initial-buy", kind: "order", occurredAt: "2026-08-01T12:00:00.000Z" }],
  });
  now = "2026-08-05T00:00:00.000Z";
  await store.addCycleCheckpoint({
    cycleId: cycle.id,
    at: now,
    action: "检查点减仓",
    decision: "技术结构转弱",
  });
  await store.linkCycleRecords({
    cycleId: cycle.id,
    records: [
      { recordId: "execution:checkpoint-sell", kind: "execution", occurredAt: "2026-08-04T20:00:00.000Z" },
      { recordId: "order:future-sell", kind: "order", occurredAt: "2026-08-07T12:00:00.000Z" },
    ],
  });
  const workspace = await store.snapshot({ cycleId: cycle.id, phase: "blind" });
  const timeline = workspace.cycles[0].decisionTimeline;
  const archive = {
    source: "Longbridge MCP · read only",
    syncedAt: "2026-08-11T00:00:00.000Z",
    orders: [
      { orderId: "initial-buy", symbol: "NVDA.US", side: "Buy", status: "FilledStatus", quantity: 100, executedQuantity: 100, submittedPrice: 100, submittedAt: "2026-08-01T12:00:00.000Z" },
      { orderId: "future-sell", symbol: "NVDA.US", side: "Sell", status: "FilledStatus", quantity: 80, executedQuantity: 80, submittedPrice: 130, submittedAt: "2026-08-07T12:00:00.000Z" },
    ],
    executions: [
      { tradeId: "checkpoint-sell", symbol: "NVDA.US", side: "Sell", quantity: 20, price: 112, doneAt: "2026-08-04T20:00:00.000Z" },
    ],
  };
  const run = buildReviewCycleAnalysisRun({
    workspace,
    archive,
    cycleId: cycle.id,
    phase: "blind",
    pointInTimeTechnical: {
      status: "complete",
      asOf: timeline.at(-1).knowledgeCutoffAt,
      requestedSymbols: ["NVDA.US"],
      nodes: timeline.map((node, index) => ({
        nodeId: node.nodeId,
        timelineIndex: node.timelineIndex,
        knowledgeCutoffAt: node.knowledgeCutoffAt,
        asOf: node.knowledgeCutoffAt,
        status: "complete",
        snapshots: [{
          symbol: "NVDA.US",
          source: "Longbridge daily candles",
          asOf: index === 0 ? "2026-08-01T00:00:00.000Z" : "2026-08-04T00:00:00.000Z",
          lastPrice: index === 0 ? 100 : 111,
          ema: { 3: index === 0 ? 99 : 109, 21: 95 },
        }],
      })),
    },
    deterministicOutcomeMetrics: { status: "available", executionPnl: { linkedRoundTripGrossPnl: 999 } },
  });
  const [initial, checkpoint] = run.analysisContext.cycle.decisionTimeline;
  assert.equal(initial.action, "先建小仓");
  assert.deepEqual(initial.brokerFactsIntroduced.records.map((item) => item.recordRef), ["order:initial-buy"]);
  assert.equal(initial.pointInTimeTechnical.asOf, timeline[0].knowledgeCutoffAt);
  assert.doesNotMatch(JSON.stringify(initial), /检查点减仓|checkpoint-sell|future-sell|"lastPrice":111/);
  assert.equal(checkpoint.action, "检查点减仓");
  assert.deepEqual(checkpoint.brokerFactsIntroduced.records.map((item) => ({
    side: item.side,
    quantity: item.quantity,
    price: item.price,
  })), [{ side: "Sell", quantity: 20, price: 112 }]);
  assert.equal(checkpoint.pointInTimeTechnical.asOf, timeline[1].knowledgeCutoffAt);
  assert.equal(checkpoint.pointInTimeTechnical.snapshots[0].lastPrice, 111);
  assert.doesNotMatch(JSON.stringify(run), /future-sell|linkedRoundTripGrossPnl/);
  assert.equal(run.analysisContext.deterministicOutcomeMetrics, null);
});

test("timeline broker hydration preserves missing archive coverage instead of inventing facts", () => {
  const cycle = cycleFixture({
    decisionTimeline: [{
      nodeId: "initial_plan:ex-ante:1",
      timelineIndex: 0,
      nodeType: "initial_plan",
      knowledgeCutoffAt: "2026-08-10T00:00:00.000Z",
      action: "试仓",
      brokerFactsIntroduced: { recordIds: ["order:not-in-cache"] },
    }],
  });
  const run = buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycle] },
    archive: archiveFixture(),
    cycleId: cycle.id,
    phase: "blind",
  });
  const facts = run.analysisContext.cycle.decisionTimeline[0].brokerFactsIntroduced;
  assert.deepEqual(facts.records, []);
  assert.deepEqual(facts.missingRecordIds, ["order:not-in-cache"]);
  assert.equal(facts.coverage.status, "unavailable");
});

test("blind review fails closed instead of silently truncating an oversized decision timeline", () => {
  const decisionTimeline = Array.from({ length: 101 }, (_, index) => ({
    nodeId: `node-${index}`,
    timelineIndex: index,
    nodeType: index === 0 ? "initial_plan" : "decision_checkpoint",
    knowledgeCutoffAt: new Date(Date.parse("2026-08-01T00:00:00.000Z") + index * 60_000).toISOString(),
    action: `action-${index}`,
    brokerFactsIntroduced: { recordIds: [] },
  }));
  const cycle = cycleFixture({ decisionTimeline });
  assert.throws(() => buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycle] },
    archive: archiveFixture(),
    cycleId: cycle.id,
    phase: "blind",
  }), /超过 100 个节点|拆分复盘周期/);
});

test("blind review rejects technical nodes that do not map one-to-one to the delivered timeline", () => {
  const cycle = cycleFixture({
    decisionTimeline: [{
      nodeId: "initial-node",
      timelineIndex: 0,
      nodeType: "initial_plan",
      knowledgeCutoffAt: "2026-08-10T00:00:00.000Z",
      action: "试仓",
      brokerFactsIntroduced: { recordIds: [] },
    }],
  });
  assert.throws(() => buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycle] },
    archive: archiveFixture(),
    cycleId: cycle.id,
    phase: "blind",
    pointInTimeTechnical: {
      status: "complete",
      nodes: [{
        nodeId: "wrong-node",
        knowledgeCutoffAt: "2026-08-10T00:00:00.000Z",
        snapshots: [],
      }],
    },
  }), /不一一对应/);
});

test("blind review rejects a node technical snapshot stamped at or after that node cutoff", () => {
  const cycle = cycleFixture({
    decisionTimeline: [{
      nodeId: "initial-node",
      timelineIndex: 0,
      nodeType: "initial_plan",
      knowledgeCutoffAt: "2026-08-10T00:00:00.000Z",
      action: "试仓",
      brokerFactsIntroduced: { recordIds: [] },
    }],
  });
  assert.throws(() => buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycle] },
    archive: archiveFixture(),
    cycleId: cycle.id,
    phase: "blind",
    pointInTimeTechnical: {
      status: "complete",
      nodes: [{
        nodeId: "initial-node",
        knowledgeCutoffAt: "2026-08-10T00:00:00.000Z",
        snapshots: [{ symbol: "NVDA.US", asOf: "2026-08-10T00:00:00.000Z", lastPrice: 999 }],
      }],
    },
  }), /cutoff 当时或之后/);
});

test("order-first retrospective review has an evidence end but never invents a knowledge cutoff or blind baseline", () => {
  const archive = archiveFixture();
  archive.orders.push({
    orderId: "post-cycle",
    symbol: "NVDA.US",
    side: "Sell",
    quantity: 1,
    submittedAt: "2026-08-21T12:00:00.000Z",
  });
  const cycle = cycleFixture({
    type: "trade_window",
    reviewMode: "lightweight",
    exAnteVersions: [],
    checkpoints: [],
    brokerLinks: {
      revision: 2,
      evidenceRevision: 2,
      recordIds: ["order:before", "order:after", "order:post-cycle"],
      requestedRecordIds: ["order:before", "execution:fill-after"],
      orderIds: ["before", "after", "post-cycle"],
      executionIds: ["fill-before", "fill-after"],
    },
    phaseRuns: { blind: [], outcome: [], retrospective: [] },
    retrospectiveVersions: [{
      version: 1,
      savedAt: "2026-08-20T12:00:00.000Z",
      forwardEffectiveAt: "2026-08-20T12:00:00.000Z",
      evidenceTiming: "retrospective",
      integrityStatus: "valid",
      snapshot: {
        recalledJudgment: "当时认为突破会延续",
        lesson: "执行节奏影响路径风险",
        forwardHypothesis: "下一次等待确认后行动",
      },
    }],
  });
  const run = buildReviewCycleAnalysisRun({
    workspace: { snapshotHash: "a".repeat(64), cycles: [cycle] },
    archive,
    cycleId: cycle.id,
    phase: "retrospective",
    deterministicOutcomeMetrics: {
      status: "available",
      generatedAt: "2026-08-21T00:00:00.000Z",
      executionPnl: { linkedRoundTripGrossPnl: 200 },
      coverage: { loadedSymbols: [{ symbol: "NVDA.US" }] },
    },
    now: () => new Date("2026-08-21T00:00:00.000Z"),
  });
  assert.equal(run.context.reviewPhase, "retrospective");
  assert.equal(run.context.reviewRetrospectiveVersion, 1);
  assert.equal(run.context.reviewEvidenceRevision, 2);
  assert.equal(run.context.reviewInputSnapshotHash, "a".repeat(64));
  assert.equal(run.analysisContext.timeFirewall.cutoffAt, null);
  assert.equal(run.analysisContext.timeFirewall.retrospectiveHasNoKnowledgeCutoff, true);
  assert.equal(run.analysisContext.timeFirewall.cycleEvidenceEndAt, cycle.endAt);
  assert.equal(run.analysisContext.cycle.evidenceGrade, "retrospective");
  assert.equal(run.analysisContext.cycle.sealedExAnte, null);
  assert.equal(run.analysisContext.cycle.blindAssessment, null);
  assert.equal(run.analysisContext.cycle.userRetrospectiveNote.version, 1);
  assert.equal(run.analysisContext.cycle.brokerAssociation.evidenceRevision, 2);
  assert.deepEqual(run.analysisContext.cycle.brokerAssociation.requestedRecordIds, ["order:before", "execution:fill-after"]);
  assert.equal(run.analysisContext.cycle.brokerAssociation.requestedRecordCount, 2);
  assert.equal(run.analysisContext.cycle.brokerAssociation.resolvedRecordCount, 5);
  assert.equal(run.analysisContext.cycle.brokerAssociation.supplementalRecordCount, 3);
  assert.deepEqual(run.analysisContext.cycle.orders.map((item) => [item.recordRef, item.selectionRole]), [
    ["order:before", "user_selected_order"],
    ["order:after", "supplemental_parent_order"],
  ]);
  assert.deepEqual(run.analysisContext.cycle.executions.map((item) => [item.recordRef, item.parentOrderRef, item.selectionRole]), [
    ["execution:fill-before", "order:before", "selected_order_fill"],
    ["execution:fill-after", "order:after", "user_selected_execution"],
  ]);
  assert.equal(run.analysisContext.cycle.userRetrospectiveNote.recalledJudgment.eligibleAsExAnteEvidence, false);
  assert.equal(run.analysisContext.cycle.userRetrospectiveNote.forwardHypothesis.effectiveFrom, "2026-08-20T12:00:00.000Z");
  assert.equal(run.analysisContext.deterministicOutcomeMetrics.executionPnl.linkedRoundTripGrossPnl, 200);
  assert.equal(run.analysisContext.cycle.orders.length, 2);
  assert.doesNotMatch(JSON.stringify(run), /post-cycle/);
});
