import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewAnalysisRun,
  selectReviewCaseIds,
} from "../src/review/review-analysis.mjs";

test("review analysis contains only broker records explicitly linked to selected cases", () => {
  const workspace = {
    updatedAt: "2026-08-10T00:00:00.000Z",
    cases: [{
      id: "case-1",
      symbol: "NVDA.US",
      fiscalQuarter: "FY2027 Q2",
      eventAt: "2026-08-26T20:00:00.000Z",
      eventSession: "amc",
      brokerLinks: {
        revision: 3,
        accountScopeId: "scope-primary",
        orderIds: ["order-selected"],
        executionIds: ["trade-selected"],
        confirmedAt: "2026-08-10T00:00:00.000Z",
      },
      exAnteDraft: { myView: "增长继续", marketView: "预期较高" },
      exAnteVersions: [],
      ruleIds: [],
    }],
    tests: [],
    rules: [],
  };
  const archive = {
    accountScopeId: "scope-primary",
    source: "Longbridge MCP · read only",
    syncedAt: "2026-08-10T00:00:00.000Z",
    orders: [
      { orderId: "order-selected", symbol: "NVDA.US", side: "Buy", quantity: 2 },
      { orderId: "order-not-selected", symbol: "NVDA.US", side: "Sell", quantity: 99 },
    ],
    executions: [
      { tradeId: "trade-selected", orderId: "order-selected", symbol: "NVDA.US", price: 180 },
      { tradeId: "trade-not-selected", orderId: "order-not-selected", symbol: "NVDA.US", price: 190 },
    ],
  };
  const run = buildReviewAnalysisRun({
    workspace,
    archive,
    caseIds: ["case-1"],
    runId: "run-1",
    portfolio: {
      syncedAt: "2026-08-10T00:00:00.000Z",
      account: { baseCurrency: "USD", netAssets: 125_000 },
      totals: { positionsGrossMarketValueBase: 100_000 },
    },
  });

  assert.equal(run.context.scope, "review");
  assert.equal(run.context.reviewMode, "single_event");
  assert.deepEqual(run.context.reviewEvidenceRevisions, [{ caseId: "case-1", revision: 3 }]);
  assert.deepEqual(run.analysisContext.basedOnEvidenceRevisions, [{ caseId: "case-1", revision: 3 }]);
  assert.deepEqual(run.analysisContext.cases[0].orders.map((item) => item.recordRef), ["order-1"]);
  assert.deepEqual(run.analysisContext.cases[0].executions.map((item) => item.recordRef), ["execution-1"]);
  assert.equal(run.analysisContext.cases[0].brokerAssociation.revision, 3);
  assert.equal(run.analysisContext.portfolioSummary.netAssets, 125_000);
  assert.equal(run.analysisContext.portfolioSummary.grossExposurePercent, 80);
  assert.doesNotMatch(JSON.stringify(run), /order-not-selected|trade-not-selected/);
  assert.doesNotMatch(JSON.stringify(run), /order-selected|trade-selected/);
  assert.match(run.task, /\$review-earnings-decisions/);
  assert.deepEqual(run.sections, ["conclusion", "evidence"]);
});

test("multi-case review is always an explicitly selected case set", () => {
  const workspace = {
    cases: [
      { id: "a", symbol: "AAPL.US", fiscalQuarter: "2026 Q2", brokerLinks: { accountScopeId: "scope-primary", orderIds: ["oa"], confirmedAt: "2026-01-01T00:00:00Z" } },
      { id: "b", symbol: "MSFT.US", fiscalQuarter: "2026 Q2", brokerLinks: { accountScopeId: "scope-primary", orderIds: ["ob"], confirmedAt: "2026-01-01T00:00:00Z" } },
      { id: "c", symbol: "AAPL.US", fiscalQuarter: "2026 Q3", brokerLinks: { accountScopeId: "scope-primary", orderIds: ["oc"], confirmedAt: "2026-01-01T00:00:00Z" } },
    ],
    tests: [],
    rules: [],
  };
  const archive = { accountScopeId: "scope-primary", orders: [], executions: [] };
  assert.equal(buildReviewAnalysisRun({ workspace, archive, caseIds: ["a", "b"] }).context.reviewMode, "selected_case_set");
  assert.equal(buildReviewAnalysisRun({ workspace, archive, caseIds: ["a", "c"] }).context.reviewMode, "selected_case_set");
  assert.deepEqual(selectReviewCaseIds(workspace, { fiscalQuarter: "2026 Q2" }), []);
  assert.deepEqual(selectReviewCaseIds(workspace, { caseIds: ["a", "b"] }), ["a", "b"]);
});

test("review analysis surfaces missing linked records instead of reconstructing them from current holdings", () => {
  const run = buildReviewAnalysisRun({
    workspace: {
      cases: [{
        id: "case-1",
        symbol: "MU.US",
        fiscalQuarter: "待确认季度",
        brokerLinks: {
          accountScopeId: "scope-primary",
          orderIds: ["missing-order"],
          executionIds: ["missing-trade"],
          confirmedAt: "2026-01-01T00:00:00Z",
        },
        ruleIds: [],
      }],
      tests: [],
      rules: [],
    },
    archive: { accountScopeId: "scope-primary", orders: [], executions: [] },
    caseIds: ["case-1"],
    portfolio: { positions: [{ symbol: "MU.US", quantity: 500 }] },
  });

  assert.deepEqual(run.analysisContext.cases[0].orders, []);
  assert.deepEqual(run.analysisContext.cases[0].executions, []);
  assert.equal(run.analysisContext.cases[0].brokerAssociation.missingOrderCount, 1);
  assert.equal(run.analysisContext.cases[0].brokerAssociation.missingExecutionCount, 1);
  assert.doesNotMatch(JSON.stringify(run.analysisContext.cases[0]), /500/);
});

test("broker warnings downgrade review evidence even when legacy completeness says complete", () => {
  const run = buildReviewAnalysisRun({
    workspace: {
      updatedAt: "2026-08-10T00:00:00.000Z",
      cases: [{
        id: "case-warning",
        symbol: "AAPL.US",
        fiscalQuarter: "FY2026 Q3",
        brokerLinks: {
          accountScopeId: "scope-primary",
          orderIds: ["o-warning"],
          executionIds: [],
          confirmedAt: "2026-08-10T00:00:00.000Z",
        },
        ruleIds: [],
      }],
      tests: [],
      rules: [],
    },
    archive: {
      accountScopeId: "scope-primary",
      source: "Longbridge MCP · read only",
      syncedAt: "2026-08-10T00:00:00.000Z",
      completeness: { orders: "complete", executions: "windowed" },
      warnings: ["today_orders: current-day endpoint unavailable"],
      orders: [{
        orderId: "o-warning",
        symbol: "AAPL.US",
        submittedAt: "2026-08-10T14:00:00.000Z",
      }],
      executions: [],
    },
    caseIds: ["case-warning"],
  });

  const brokerEvidence = run.evidence.find((item) => item.tool === "review:broker-history");
  assert.equal(brokerEvidence.status, "degraded");
  assert.deepEqual(run.analysisContext.dataCoverage.warnings, [
    "today_orders: current-day endpoint unavailable",
  ]);
});

test("single-case evidence excludes tests from another quarter that merely share the same rule", () => {
  const run = buildReviewAnalysisRun({
    workspace: {
      cases: [{
        id: "selected-q2",
        symbol: "NVDA.US",
        fiscalQuarter: "FY2026 Q2",
        brokerLinks: { accountScopeId: "scope-primary", orderIds: ["o1"], confirmedAt: "2026-01-01T00:00:00Z" },
        ruleIds: ["rule-1"],
      }],
      tests: [
        { id: "selected-test", caseId: "selected-q2", ruleId: "rule-1", outcomeR: 2 },
        { id: "foreign-test", caseId: "other-q1", ruleId: "rule-1", outcomeR: -4 },
        { id: "rule-level-test", caseId: null, ruleId: "rule-1", outcomeR: 0.5 },
      ],
      rules: [{ id: "rule-1", title: "候选规则" }],
    },
    archive: { accountScopeId: "scope-primary", orders: [], executions: [] },
    caseIds: ["selected-q2"],
  });

  assert.deepEqual(run.analysisContext.tests.map((item) => item.id), ["selected-test", "rule-level-test"]);
  assert.doesNotMatch(JSON.stringify(run), /foreign-test|-4/);
});

test("review analysis rejects unconfirmed cases and never silently truncates over one hundred", () => {
  assert.throws(() => buildReviewAnalysisRun({
    workspace: { cases: [{ id: "manual", symbol: "AAPL.US", brokerLinks: {} }] },
    archive: { orders: [], executions: [] },
    caseIds: ["manual"],
  }), /确认关联/);

  assert.throws(() => selectReviewCaseIds({}, {
    caseIds: Array.from({ length: 101 }, (_, index) => `case-${index}`),
  }), /最多分析 100/);
});

test("review analysis rejects legacy-unbound and cross-account broker links", () => {
  const baseCase = {
    id: "scoped-case",
    symbol: "AAPL.US",
    brokerLinks: {
      orderIds: ["order-1"],
      confirmedAt: "2026-08-01T00:00:00.000Z",
    },
    ruleIds: [],
  };
  assert.throws(() => buildReviewAnalysisRun({
    workspace: { cases: [baseCase], tests: [], rules: [] },
    archive: { accountScopeId: "scope-current", orders: [], executions: [] },
    caseIds: ["scoped-case"],
  }), /缺少匿名账户作用域/);
  assert.throws(() => buildReviewAnalysisRun({
    workspace: {
      cases: [{
        ...baseCase,
        brokerLinks: { ...baseCase.brokerLinks, accountScopeId: "scope-old" },
      }],
      tests: [],
      rules: [],
    },
    archive: { accountScopeId: "scope-current", orders: [], executions: [] },
    caseIds: ["scoped-case"],
  }), /不同匿名账户作用域/);
});
