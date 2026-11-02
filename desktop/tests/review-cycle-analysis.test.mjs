import assert from "node:assert/strict";
import test from "node:test";
import { ReviewCycleStore } from "../src/data/review-cycle-store.mjs";
import { buildReviewReconciliation, summarizeReviewReconciliation } from "../src/review/review-reconciliation.mjs";
import { buildCodexEvidence, buildWorkspaceAdditionalContext } from "../src/engine/codex-workspace.mjs";
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

test("reconciliation metadata travels in outcome evidence, is detached, and never enters blind context", () => {
  const cycle = cycleFixture({ brokerLinks: { ...cycleFixture().brokerLinks, accountScopeId: "scope-a" },
    phaseRuns: { blind: [{ id: "blind-1", status: "completed", threadId: "thread-1" }] } });
  const reconciliation = summarizeReviewReconciliation(buildReviewReconciliation({ cycle }));
  const build = (phase, override = reconciliation) => buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycle] }, archive: archiveFixture(), cycleId: cycle.id, phase, reconciliation: override,
    now: () => new Date("2026-09-01T00:00:00Z"),
  });
  const outcome = build("outcome");
  assert.deepEqual(outcome.analysisContext.reconciliation, reconciliation);
  assert.notEqual(outcome.analysisContext.reconciliation, reconciliation);
  const evidence = buildCodexEvidence({ portfolio: null, run: outcome, task: "核验收益对账" });
  const serialized = JSON.stringify(buildWorkspaceAdditionalContext(evidence, "test"));
  assert.ok(serialized.includes(reconciliation.evidenceHash));
  assert.ok(serialized.includes("net_asset_change_is_not_investment_return"));
  const blind = build("blind");
  assert.equal(blind.analysisContext.reconciliation, null);
  const blindWire = JSON.stringify(buildWorkspaceAdditionalContext(buildCodexEvidence({ portfolio: null, run: blind, task: "盲态" }), "test"));
  assert.ok(!blindWire.includes(reconciliation.evidenceHash));
  for (const change of [
    { schemaVersion: "unknown" }, { cycleId: "another-cycle" }, { cycleEvidenceRevision: 999 },
    { accountScopeId: "scope-b" }, { window: { ...reconciliation.window, endAt: "2026-09-30T20:00:00.000Z" } },
  ]) assert.throws(() => build("outcome", { ...reconciliation, ...change }), /对账状态与本次/);
  const retrospectiveCycle = migratedCycleFixture();
  const retrospective = buildReviewCycleAnalysisRun({ workspace: { cycles: [retrospectiveCycle] },
    archive: { ...archiveFixture(), accountScopeId: "scope-a" }, cycleId: retrospectiveCycle.id, phase: "retrospective",
    reconciliation: summarizeReviewReconciliation(buildReviewReconciliation({ cycle: retrospectiveCycle })),
    now: () => new Date("2026-09-01T00:00:00Z") });
  assert.equal(retrospective.analysisContext.reconciliation.cycleId, retrospectiveCycle.id);
});

function migratedCycleFixture() {
  const original = cycleFixture();
  return cycleFixture({
    reviewMode: "lightweight", status: "draft", catalystAt: null, eventAt: null,
    eventMetadata: { eventDate: "2026-08-15", timePrecision: "date", session: "amc", fiscalQuarter: "FY2027 Q2",
      timezone: "America/New_York", source: "confirmed_event_calendar", eventCandidateId: "event-1", symbol: "NVDA.US" },
    exAnteVersions: [], outcome: null,
    brokerLinks: { ...original.brokerLinks, accountScopeId: "scope-a", recordIds: ["order:before", "order:after"] },
    legacySource: { sourceCaseId: "legacy-case-1", sourceHash: "source-hash", accountScopeId: "scope-a",
      migratedAt: "2026-08-21T00:00:00Z",
      originalJudgment: { myView: "旧判断原文", marketView: "旧市场预期", riskBudgetR: 1, unexpectedOutcome: "DO_NOT_IMPORT_OUTCOME" },
      associationVersions: [{ revision: 1, hash: "old-link-hash" }],
      sealedVersionReferences: [{ version: 1, hash: "old-seal-hash", sealedAt: "2026-08-10T00:00:00Z" }],
      resultReferences: [{ kind: "review", sourceCaseId: "legacy-case-1", hash: "old-result-hash", text: "DO_NOT_IMPORT_RESULT" }],
    },
    phaseRuns: { blind: [], outcome: [], retrospective: [] },
    retrospectiveVersions: [{ version: 1, integrityStatus: "valid", savedAt: "2026-08-21T01:00:00Z",
      snapshot: { recalledJudgment: "我的回顾", lesson: "我的感悟", forwardHypothesis: "未来需要验证的假设" } }],
  });
}

test("migrated case context preserves date precision and historical origin without inheriting old completion", () => {
  const cycle = migratedCycleFixture();
  const run = buildReviewCycleAnalysisRun({ workspace: { cycles: [cycle] }, archive: { ...archiveFixture(), accountScopeId: "scope-a" },
    cycleId: cycle.id, phase: "retrospective", now: () => new Date("2026-08-22T00:00:00Z") });
  const context = run.analysisContext.cycle;
  assert.equal(context.eventMetadata.eventDate, "2026-08-15");
  assert.equal(context.eventMetadata.timePrecision, "date");
  assert.equal(context.eventMetadata.eventAt, null);
  assert.equal(context.catalyst.eventAt, null);
  assert.equal(context.eventMetadata.fiscalQuarter, "FY2027 Q2");
  assert.equal(context.legacySource.originalJudgment.myView, "旧判断原文");
  assert.equal(context.legacySource.eligibleAsExAnteEvidence, false);
  assert.equal(context.legacySource.resultsAreCurrentPhaseRuns, false);
  assert.equal(context.sealedExAnte, null);
  assert.equal(context.blindAssessment, null);
  assert.equal(context.evidenceGrade, "retrospective");
  assert.equal(context.canonicalEvidenceIdentity.sourceCaseId, "legacy-case-1");
  const evidence = buildCodexEvidence({ portfolio: null, run, task: "复盘迁移案例" });
  const payload = JSON.stringify(buildWorkspaceAdditionalContext(evidence, "迁移来源核验"));
  for (const text of ["historical_legacy_source_not_new_ex_ante", "旧判断原文", "old-result-hash", "FY2027 Q2", "canonicalEvidenceIdentity"])
    assert.ok(payload.includes(text), text);
  assert.ok(!payload.includes("DO_NOT_IMPORT_RESULT"));
  assert.ok(!payload.includes("DO_NOT_IMPORT_OUTCOME"));
});

test("date-only migration cannot run blind review or skip user retrospective notes", () => {
  const cycle = migratedCycleFixture();
  const build = (phase) => buildReviewCycleAnalysisRun({ workspace: { cycles: [cycle] }, archive: archiveFixture(),
    cycleId: cycle.id, phase, now: () => new Date("2026-08-22T00:00:00Z") });
  assert.throws(() => build("blind"), /只能进行轻量事后复盘/);
  cycle.retrospectiveVersions = [];
  assert.throws(() => build("retrospective"), /先保存判断、感悟与未来预判/);
});

test("blind projection never receives migrated original text, result references, or migration timestamp", () => {
  const cycle = cycleFixture({ legacySource: migratedCycleFixture().legacySource,
    brokerLinks: { ...cycleFixture().brokerLinks, accountScopeId: "scope-a" } });
  const run = buildReviewCycleAnalysisRun({ workspace: { cycles: [cycle] }, archive: archiveFixture(),
    cycleId: cycle.id, phase: "blind", now: () => new Date("2026-08-22T00:00:00Z") });
  assert.equal(run.analysisContext.cycle.legacySource.contentsWithheldForBlind, true);
  assert.equal(run.analysisContext.cycle.legacySource.eligibleAsExAnteEvidence, false);
  const all = JSON.stringify(run);
  for (const hidden of ["旧判断原文", "old-result-hash", "source-hash", "2026-08-21T00:00:00Z"])
    assert.ok(!all.includes(hidden), hidden);
});

test("blind review physically excludes every post-cutoff broker fact, checkpoint, and outcome", () => {
  const run = buildReviewCycleAnalysisRun({
    workspace: {
      updatedAt: "2026-08-22T00:00:00.000Z",
      cycles: [cycleFixture()],
    },
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
  assert.equal(run.analysisContext.timeFirewall.hiddenOrderCount, undefined);
  assert.equal(run.analysisContext.timeFirewall.hiddenExecutionCount, undefined);
  assert.equal(run.analysisContext.timeFirewall.hiddenCheckpointCount, undefined);
  assert.equal(run.analysisContext.timeFirewall.externalToolsHostBlocked, true);
  assert.equal(run.createdAt, null);
  assert.equal(run.context.knowledgeCutoffAt, "2026-08-10T00:00:00.000Z");
  assert.equal(run.context.snapshotAt, "2026-08-10T00:00:00.000Z");
  assert.equal(run.evidence[0].asOf, "2026-08-10T00:00:00.000Z");
  assert.equal(run.evidence[1].asOf, "2026-08-10T00:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(run), /指引超过预期|"pnl":500|"price":120|cp-after/);
  assert.doesNotMatch(JSON.stringify(run), /2026-08-21T00:00:00\.000Z|2026-08-22T00:00:00\.000Z/);
  assert.match(run.task, /\$review-decision-cycles/);
});

test("review analysis rejects broker facts from another opaque account scope", () => {
  const cycle = cycleFixture({
    brokerLinks: {
      ...cycleFixture().brokerLinks,
      accountScopeId: "scope-account-a",
      recordIds: ["order:before", "execution:fill-before"],
    },
  });
  assert.throws(() => buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycle] },
    archive: { ...archiveFixture(), accountScopeId: "scope-account-b" },
    cycleId: cycle.id,
    phase: "blind",
    now: () => new Date("2026-08-10T01:00:00.000Z"),
  }), /不同匿名账户作用域/);
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

test("blind evidence hides an excluded Longbridge execution and its future-sensitive audit counts", () => {
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
  assert.equal(run.analysisContext.cycle.brokerAssociation.excludedAuditExecutionCount, undefined);
  assert.equal(run.analysisContext.cycle.brokerAssociation.excludedAuditExecutionReasons, undefined);
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

test("outcome review preserves a long frozen blind assessment with explicit integrity metadata", () => {
  const frozenText = `# 盲态判断\n\n${"只按事前证据判断；".repeat(2_000)}`;
  const cycle = cycleFixture({
    status: "outcome_ready",
    phaseRuns: { blind: [{
      id: "blind-long",
      threadId: "thread-blind-long",
      status: "completed",
      completedAt: "2026-08-10T01:00:00.000Z",
      inputSnapshotHash: "evidence-long",
      resultHash: "result-long",
      result: { conclusion: { body: frozenText } },
    }], outcome: [] },
  });
  const run = buildReviewCycleAnalysisRun({
    workspace: { cycles: [cycle] },
    archive: archiveFixture(),
    cycleId: cycle.id,
    phase: "outcome",
    now: () => new Date("2026-08-21T00:00:00.000Z"),
  });
  const assessment = run.analysisContext.cycle.blindAssessment;
  assert.equal(assessment.summary, frozenText);
  assert.equal(assessment.sourceCharacterCount, frozenText.length);
  assert.equal(assessment.deliveredCharacterCount, frozenText.length);
  assert.equal(assessment.truncated, false);
  assert.match(assessment.summaryHash, /^sha256:/);
  assert.equal(assessment.resultHash, "result-long");
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
      account: { baseCurrency: "USD", netAssets: 125_000 },
      totals: { positionsGrossMarketValueBase: 100_000 },
      positions: [{ symbol: "NVDA.US", quantity: 20, weight: 18 }],
    },
    now: () => new Date("2026-08-21T12:00:00.000Z"),
  });
  assert.equal(run.analysisContext.cycle.endingPortfolio, null);
  assert.equal(run.analysisContext.cycle.currentPortfolioContext.snapshotAt, "2026-08-21T12:00:00.000Z");
  assert.equal(run.analysisContext.cycle.currentPortfolioContext.netAssets, 125_000);
  assert.equal(run.analysisContext.cycle.currentPortfolioContext.grossExposurePercent, 80);
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

function outcomePortfolioRun(snapshot) {
  const cycle = cycleFixture({ status: "outcome_ready", endingPortfolio: snapshot,
    phaseRuns: { blind: [{ id: "blind-1", threadId: "thread-blind", status: "completed", result: { conclusion: { body: "冻结判断" } } }] } });
  return buildReviewCycleAnalysisRun({ workspace: { cycles: [cycle] }, archive: archiveFixture(),
    cycleId: cycle.id, phase: "outcome", now: () => new Date("2026-08-21T12:00:00Z") });
}

test("raw ledger snapshot keeps compact valuation, FX, quality and opaque scope through actual Agent context delivery", () => {
  const snapshot = {
    capturedAt: "2026-08-20T20:00:00Z", snapshotId: "snapshot-source-sentinel", kind: "eod",
    summary: { reportingCurrency: "USD", totalAssets: 1000, cash: -25, grossExposure: 1025 },
    holdings: [{ symbol: "0700.HK", quantity: 10, weight: 0.05, marketValue: 780, valueInReportingCurrency: 100, currency: "HKD", apiKey: "do-not-deliver-secret" }],
    valuation: { session: "regular_close", methodVersion: "regular-close-v2", observedAt: "2026-08-20T20:10:00Z",
      quoteAsOf: "2026-08-20T20:00:00Z", quoteLatestAsOf: "2026-08-20T20:00:00Z", afterHoursMarksExcluded: true,
      totalAssetsBasis: "capture_cash_plus_regular_close_positions", brokerObservedNetAssets: 1020, token: "do-not-deliver-secret" },
    dataQuality: { status: "complete", completeForPeriodReturn: true, issues: [{ code: "inventory_capture_after_close", field: "holdings", message: "数量并非收盘库存" }] },
    fx: { status: "complete", source: "fx-source-sentinel", retrievedAt: "2026-08-20T20:10:00Z",
      rates: [{ base: "USD", quote: "HKD", rate: 7.8, asOf: "2026-08-20T20:00:00Z", source: "fx-rate-source", accessToken: "do-not-deliver-secret" }] },
    accountScope: { scopeId: `broker-scope-v1-${"a".repeat(64)}`, broker: "Longbridge", environment: "production", status: "verified",
      accounts: [{ accountRef: "raw-account-do-not-deliver" }], accountIdentifiers: [{ value: "raw-account-do-not-deliver" }] },
    provenance: { provider: "Longbridge", transport: "MCP readonly", fetchedAt: "2026-08-20T20:10:00Z", recordedAt: "2026-08-20T20:10:02Z",
      integrityStatus: "verified_on_read", accountScopeVerified: true, accessToken: "do-not-deliver-secret" },
    integrity: { contentHash: "c".repeat(64), entryHash: "e".repeat(64) },
  };
  const run = outcomePortfolioRun(snapshot);
  const delivered = run.analysisContext.cycle.endingPortfolio;
  assert.equal(delivered.snapshotAt, "2026-08-20T20:00:00.000Z");
  assert.equal(delivered.netAssets, 1000);
  assert.equal(delivered.cash, -25);
  assert.equal(delivered.cashRatioPercent, -2.5);
  assert.equal(delivered.positions[0].weightPercent, 5);
  assert.equal(delivered.units.weightPercent, "percent_of_net_assets", "a level weight of 5 means 5% of net assets, not a difference in percentage points");
  assert.equal(delivered.positions[0].marketValue, 780);
  assert.equal(delivered.positions[0].currency, "HKD");
  assert.equal(delivered.positions[0].marketValueInReportingCurrency, 100);
  assert.equal(delivered.units.marketValueInReportingCurrency, "USD");
  assert.equal(delivered.valuation.pricesOnlyNotReconciledInventory, true);
  assert.equal(delivered.dataQuality.status, "partial");
  assert.equal(delivered.dataQuality.sourceStatus, "complete");
  assert.equal(delivered.dataQuality.completeForPeriodReturn, false);
  assert.equal(delivered.provenance.entryHash, "e".repeat(64));
  assert.equal(delivered.accountScope.accountCount, 1);
  assert.equal(delivered.fx.rates[0].rate, 7.8);
  const wire = JSON.stringify(buildWorkspaceAdditionalContext(buildCodexEvidence({ portfolio: null, run, task: "复盘组合" }), "审计"));
  assert.match(wire, /snapshot-source-sentinel/);
  assert.match(wire, /regular-close-v2/);
  assert.match(wire, /fx-source-sentinel/);
  assert.match(wire, new RegExp("e".repeat(64)));
  assert.doesNotMatch(wire, /do-not-deliver-secret|raw-account-do-not-deliver/);
});

test("snapshot projection reports every capped collection rather than claiming complete delivery", () => {
  const run = outcomePortfolioRun({ snapshotAt: "2026-08-20T20:00:00Z", baseCurrency: "USD", netAssets: 1000,
    positions: Array.from({ length: 205 }, (_, index) => ({ symbol: `T${index}.US`, quantity: index, weight: null, currency: "USD" })),
    fx: { status: "partial", rates: Array.from({ length: 23 }, (_, index) => ({ base: "USD", quote: "HKD", rate: 7 + index / 100 })) },
    dataQuality: { status: "partial", issues: Array.from({ length: 24 }, (_, index) => ({ code: `issue-${index}`, message: "x".repeat(1000) })) } });
  const snapshot = run.analysisContext.cycle.endingPortfolio;
  assert.equal(snapshot.positions.length, 200);
  assert.deepEqual(snapshot.positionCoverage, { sourceCount: 205, deliveredCount: 200, omittedCount: 5, status: "partial" });
  assert.deepEqual(snapshot.fx.rateCoverage, { sourceCount: 23, deliveredCount: 20, omittedCount: 3, status: "partial" });
  assert.deepEqual(snapshot.dataQuality.issueCoverage, { sourceCount: 24, deliveredCount: 20, omittedCount: 4, status: "partial" });
  assert.equal(snapshot.dataQuality.issues[0].message.length, 300);
  assert.equal(snapshot.positions[0].quantity, 0);
  assert.equal(snapshot.positions[0].weightPercent, null);
  assert.ok(JSON.stringify(snapshot).length < 50_000);
});

test("unknown snapshot metadata remains null and existing percentage weights are not multiplied again", () => {
  const snapshot = outcomePortfolioRun({ snapshotAt: "2026-08-20T20:00:00Z", baseCurrency: "USD", netAssets: 0, cash: 0,
    positions: [{ symbol: "AAPL.US", quantity: null, marketValue: "", weight: 5 }] }).analysisContext.cycle.endingPortfolio;
  assert.equal(snapshot.netAssets, 0);
  assert.equal(snapshot.cash, 0);
  assert.equal(snapshot.cashRatioPercent, null);
  assert.equal(snapshot.top1WeightPercent, null);
  assert.equal(snapshot.positions[0].quantity, null);
  assert.equal(snapshot.positions[0].marketValue, null);
  assert.equal(snapshot.positions[0].weightPercent, 5);
  assert.equal(snapshot.valuation, null);
  assert.equal(snapshot.fx, null);
  assert.equal(snapshot.dataQuality, null);
  assert.equal(snapshot.accountScope, null);
  assert.equal(snapshot.provenance, null);
  const absent = outcomePortfolioRun({ snapshotAt: "2026-08-20T20:00:00Z" }).analysisContext.cycle.endingPortfolio;
  assert.deepEqual(absent.positionCoverage, { sourceCount: null, deliveredCount: 0, omittedCount: null, status: "missing" });
});

test("new outcome snapshot metadata cannot leak later retrieval time or quality narrative into blind replay", () => {
  const cycle = cycleFixture({ startingPortfolio: {
    snapshotAt: "2026-07-31T20:00:00Z", baseCurrency: "USD", netAssets: 1000, positions: [],
    provenance: { recordedAt: "2026-08-25T01:00:00Z", source: "future-source-sentinel" },
    dataQuality: { status: "partial", issues: [{ code: "future", message: "future-quality-sentinel" }] },
    fx: { source: "future-fx-sentinel", rates: [] },
  } });
  const run = buildReviewCycleAnalysisRun({ workspace: { cycles: [cycle] }, archive: archiveFixture(),
    cycleId: cycle.id, phase: "blind", now: () => new Date("2026-08-21T12:00:00Z") });
  assert.equal(run.analysisContext.cycle.startingPortfolio.netAssets, 1000);
  assert.equal(run.analysisContext.cycle.startingPortfolio.provenanceQualification, "metadata_not_verified_at_knowledge_cutoff");
  assert.equal(run.analysisContext.cycle.startingPortfolio.units.weightPercent, "percent_of_net_assets");
  assert.equal(Object.hasOwn(run.analysisContext.cycle.startingPortfolio, "provenance"), false);
  assert.doesNotMatch(JSON.stringify(run), /future-source-sentinel|future-quality-sentinel|future-fx-sentinel|2026-08-25/);
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
  assert.equal(run.analysisContext.timeFirewall.preCycleOrderCount, undefined);
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
    technicalValidation: {
      status: "complete",
      reasonCodes: [],
      entrySnapshot: {
        batch: { batchId: "radar-before-entry", recordedAt: "2026-08-08T21:01:00.000Z" },
      },
      sampleCandidate: { status: "available", eligibleForFormalStatistics: false },
      validationMode: { classification: "historical_calibration" },
      provenance: { deterministic: true },
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
  assert.equal(run.analysisContext.technicalValidation.entrySnapshot.batch.batchId, "radar-before-entry");
  assert.equal(run.analysisContext.technicalValidation.provenance.currentPortfolioLookupAllowed, false);
  assert.equal(run.safeguards.technicalValidationAutomaticPromotion, false);
  assert.equal(run.capabilities.technicalValidation, true);
  assert.ok(run.evidence.some((item) => item.tool === "review:technical-validation-sample"));
  assert.equal(run.analysisContext.cycle.orders.length, 2);
  assert.doesNotMatch(JSON.stringify(run), /post-cycle/);
});
