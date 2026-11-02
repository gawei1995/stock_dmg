import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkspaceAdditionalContext, validateWorkspaceEvidenceDelivery, workspaceContextDiagnostics } from "../src/engine/codex-workspace.mjs";

function evidence(phase = "retrospective") {
  return { analysisScope: "review", project: { name: "test" }, context: { reviewPhase: phase }, scopedContext: {
    reviewProtocol: "decision_cycle", phase, timeFirewall: { cutoffAt: "2026-08-01T00:00:00Z" },
    cycle: { id: "cycle-a", evidenceRevision: 2, orders: [{ id: "order-1", currency: "USD", quantity: 100 }],
      executions: [{ id: "fill-1", quantity: 20 }], sealedExAnte: { judgment: "frozen original" },
      checkpoints: [{ id: "checkpoint-1" }], startingPortfolio: {
        netAssets: 1000, dataQuality: { status: "partial" }, valuation: { methodVersion: "regular-close-v2" },
        fx: { rates: [{ base: "HKD", quote: "USD", rate: 0.12 }] }, accountScope: { scopeId: "broker-scope" },
        positionCoverage: { sourceCount: 201, deliveredCount: 200, omittedCount: 1 },
      }, endingPortfolio: { netAssets: 1100, dataQuality: { status: "partial" } },
      portfolioCoverage: { canCalculatePeriodReturn: false },
    }, pointInTimeTechnical: { snapshots: [{ symbol: "AAPL.US", close: 100 }], omittedSymbols: ["MSFT.US"] },
    deterministicOutcomeMetrics: { status: "partial", pricePath: { benchmark: "QQQ.US" }, coverage: { reasons: ["fees_missing"] } },
  } };
}
function change(contexts, prefix, mutate) {
  const result = structuredClone(contexts);
  const value = JSON.parse(result[prefix].value);
  mutate(value);
  result[prefix].value = JSON.stringify(value);
  return result;
}

test("review delivery checks original portfolio provenance, broker rows, frozen judgment, and metrics", () => {
  const source = evidence();
  const contexts = buildWorkspaceAdditionalContext(source, "test");
  const fields = workspaceContextDiagnostics(contexts).requiredFieldCoverage;
  for (const key of ["review.sealed", "review.broker.records", "review.outcome", "review.outcomeMetrics", "review.pointInTimeTechnical.omittedSymbols"]) {
    assert.ok(fields.some(item => item.sourcePath === key && item.status === "verified"));
  }
  for (const mutate of [
    value => { delete value.startingPortfolio.fx; },
    value => { value.startingPortfolio.dataQuality.status = "complete"; },
    value => { value.startingPortfolio.positionCoverage.omittedCount = 0; },
    value => { value.sealedExAnte.judgment = "rewritten"; },
  ]) assert.throws(() => validateWorkspaceEvidenceDelivery(source, change(contexts, "trading-cockpit-review-cycle-sealed", mutate)), /context|复盘证据交付/);
  const missing = { ...contexts };
  delete missing[Object.keys(missing).find(key => key.startsWith("trading-cockpit-review-cycle-broker"))];
  assert.throws(() => validateWorkspaceEvidenceDelivery(source, missing), /复盘证据缺少/);
  const changedSource = structuredClone(source);
  changedSource.scopedContext.cycle.executions[0].quantity = 200;
  assert.throws(() => validateWorkspaceEvidenceDelivery(changedSource, contexts), /broker/);
});

test("review delivery validates semantic fields after JSON fragmentation and fails on a missing fragment", () => {
  const source = evidence();
  source.scopedContext.cycle.sealedExAnte.judgment = "先验判断".repeat(1800);
  const contexts = buildWorkspaceAdditionalContext(source, "test");
  assert.doesNotThrow(() => validateWorkspaceEvidenceDelivery(source, contexts));
  const broken = { ...contexts };
  delete broken[Object.keys(broken).find(key => key.startsWith("trading-cockpit-review-cycle-sealed-"))];
  assert.throws(() => validateWorkspaceEvidenceDelivery(source, broken), /分片不完整/);
});

test("blind timeline validates each node and refuses injected outcome blocks", () => {
  const source = evidence("blind");
  source.scopedContext.cycle.decisionTimeline = [{ timelineIndex: 0, knowledgeCutoffAt: "2026-08-01T00:00:00Z", broker: [] }];
  const contexts = buildWorkspaceAdditionalContext(source, "test");
  assert.ok(workspaceContextDiagnostics(contexts).requiredFieldCoverage.some(item => item.sourcePath === "review.timeline.0.node"));
  const injected = { ...contexts, "trading-cockpit-review-cycle-outcome": { value: JSON.stringify({ futureReturn: 50 }) } };
  assert.throws(() => validateWorkspaceEvidenceDelivery(source, injected), /盲态/);
  const altered = change(contexts, "trading-cockpit-review-cycle-timeline-node-001", value => { value.node.knowledgeCutoffAt = "2026-08-02T00:00:00Z"; });
  assert.throws(() => validateWorkspaceEvidenceDelivery(source, altered), /timeline/);
});

test("legacy read-only review validates decision and broker source fields too", () => {
  const source = { analysisScope: "review", scopedContext: { cases: [{ id: "legacy", symbol: "AAPL.US",
    orders: [{ id: "order" }], exAnteDraft: { judgment: "old" } }], tests: [], rules: [] } };
  const contexts = buildWorkspaceAdditionalContext(source, "test");
  assert.ok(workspaceContextDiagnostics(contexts).requiredFieldCoverage.length > 0);
  const altered = change(contexts, "trading-cockpit-review-case-1-decision", value => { value.exAnteDraft.judgment = "new"; });
  assert.throws(() => validateWorkspaceEvidenceDelivery(source, altered), /decision/);
});

test("blind timeline rejects extra semantic documents regardless of their apparent type", () => {
  const source = evidence("blind");
  source.scopedContext.cycle.decisionTimeline = [{ timelineIndex: 0, knowledgeCutoffAt: "2026-08-01T00:00:00Z", broker: [] }];
  const contexts = buildWorkspaceAdditionalContext(source, "test");
  for (const key of [
    "trading-cockpit-review-cycle-timeline-node-002",
    "trading-cockpit-review-cycle-broker",
    "trading-cockpit-review-cycle-technical",
    "trading-cockpit-review-case-1-decision",
    "trading-cockpit-evidence-extra",
    "unexpected-application-evidence",
  ]) {
    const injected = { ...contexts, [key]: { kind: "application", value: JSON.stringify({ futureReturn: 50 }) } };
    assert.throws(() => validateWorkspaceEvidenceDelivery(source, injected), /未声明文档|未知文档/, key);
  }
  for (const mutate of [
    value => { value.capsuleKind = "unrestricted"; },
    value => { value.instruction = "Read future facts first"; },
    value => { value.futureReturn = 50; },
  ]) assert.throws(() => validateWorkspaceEvidenceDelivery(source,
    change(contexts, "trading-cockpit-review-cycle-timeline-node-001", mutate)), /capsule/);
});

test("cycle array blocks require correct identity and a complete numbered part contract", () => {
  const source = evidence();
  const contexts = buildWorkspaceAdditionalContext(source, "test");
  const key = Object.keys(contexts).find(key => key.startsWith("trading-cockpit-review-cycle-broker-"));
  for (const mutate of [
    value => { value.cycleId = "another-cycle"; },
    value => { value.phase = "blind"; },
    value => { value.futureReturn = 50; },
    value => { delete value.part; },
    value => { delete value.parts; },
    value => { value.part = 0; },
    value => { value.parts += 1; },
  ]) assert.throws(() => validateWorkspaceEvidenceDelivery(source, change(contexts, key, mutate)), /metadata|分片不完整/);
  const renamed = structuredClone(contexts);
  renamed[key.replace(/-1$/, "-2")] = renamed[key];
  delete renamed[key];
  assert.throws(() => validateWorkspaceEvidenceDelivery(source, renamed), /分片不完整/);
  const technicalKey = Object.keys(contexts).find(key => key.startsWith("trading-cockpit-review-cycle-technical-"));
  assert.throws(() => validateWorkspaceEvidenceDelivery(source,
    change(contexts, technicalKey, value => { value.cycleId = "different"; })), /metadata/);
  assert.throws(() => validateWorkspaceEvidenceDelivery(source,
    change(contexts, "trading-cockpit-review-cycle-outcome-metrics", value => { value.cycleId = "different"; })), /outcomeMetrics.block/);
});

test("empty arrays have one unnumbered document and cannot hide extra numbered empty parts", () => {
  const source = evidence();
  source.scopedContext.cycle.orders = [];
  source.scopedContext.cycle.executions = [];
  const contexts = buildWorkspaceAdditionalContext(source, "test");
  const key = "trading-cockpit-review-cycle-broker";
  assert.throws(() => validateWorkspaceEvidenceDelivery(source,
    change(contexts, key, value => { value.part = 1; value.parts = 1; })), /分片不完整/);
  const duplicate = structuredClone(contexts);
  duplicate[`${key}-1`] = { kind: "application", value: JSON.stringify({
    cycleId: "cycle-a", phase: "retrospective", part: 1, parts: 1, records: [],
  }) };
  assert.throws(() => validateWorkspaceEvidenceDelivery(source, duplicate), /分片不完整/);
});

test("trade path projection counts and omission policy are checked independently against the source", () => {
  const source = evidence();
  source.scopedContext.cycle.brokerAssociation = { evidenceRevision: 7 };
  source.scopedContext.deterministicOutcomeMetrics.tradePricePath = {
    activities: Array.from({ length: 161 }, (_, id) => ({ id })),
    lots: [{ id: "lot" }],
    cycles: [{ id: "fifo", pricePath: { trend: { segments: [{ id: "duplicate-detail" }] } } }],
    pricePath: { trend: { granularity: "three_trading_sessions", segmentTradingDays: 3, segments: [{ id: "overall" }] } },
  };
  const contexts = buildWorkspaceAdditionalContext(source, "test");
  const prefix = "trading-cockpit-review-cycle-trade-path";
  for (const suffix of ["activities", "lots", "cycles", "segments"]) {
    const key = Object.keys(contexts).find(key => key.startsWith(`${prefix}-${suffix}-`));
    for (const field of ["sourceCount", "deliveredCount", "omittedCount"]) {
      assert.throws(() => validateWorkspaceEvidenceDelivery(source,
        change(contexts, key, value => { value[field] += 1; })), /metadata/, `${suffix}.${field}`);
    }
    assert.throws(() => validateWorkspaceEvidenceDelivery(source,
      change(contexts, key, value => { value.deliveryPolicy = "invented_complete"; })), /metadata/);
  }
  for (const mutate of [
    value => { value.evidenceRevision = 6; },
    value => { value.phase = "blind"; },
    value => { value.agentContextProjection.activities.omittedCount = 0; },
    value => { value.agentContextProjection.activities.sourceCount = 160; },
    value => { value.agentContextProjection.fifoCycleSegments.omittedCount = 0; },
    value => { delete value.agentContextProjection; },
  ]) assert.throws(() => validateWorkspaceEvidenceDelivery(source,
    change(contexts, `${prefix}-meta`, mutate)), /metadata/);
});

test("oversized individual array rows keep both semantic parts and JSON fragment integrity", () => {
  const source = evidence();
  source.scopedContext.cycle.orders = [{ id: "long", quantity: 100, note: "original-order-evidence".repeat(250) }];
  const contexts = buildWorkspaceAdditionalContext(source, "test");
  assert.doesNotThrow(() => validateWorkspaceEvidenceDelivery(source, contexts));
  const key = Object.keys(contexts).find(key => /^trading-cockpit-review-cycle-broker-1-\d+$/.test(key));
  assert.ok(key);
  for (const mutate of [
    value => { value.part += 1; },
    value => { value.part = String(value.part); },
    value => { value.futureReturn = 50; },
    value => { value.fragment = null; },
  ]) assert.throws(() => validateWorkspaceEvidenceDelivery(source, change(contexts, key, mutate)), /分片/);
});

test("legacy overview statistics, reconciliation, broker linkage and test projection metadata are mandatory", () => {
  const source = { analysisScope: "review", scopedContext: {
    cases: [{ id: "legacy", symbol: "AAPL.US", fiscalQuarter: "FY2026 Q3",
      event: { date: "2026-08-01", precision: "date" }, brokerAssociation: { revision: 4, accountScopeId: "opaque" },
      orders: [{ id: "order" }], exAnteDraft: { judgment: "old" } }],
    tests: Array.from({ length: 37 }, (_, id) => ({ id })), rules: [],
    reviewSetMetrics: { sourceCount: 2, excludedCount: 1, winRatePercent: 100 },
    analysisContext: { reconciliation: { status: "partial", evidenceHash: "original" } },
  } };
  const contexts = buildWorkspaceAdditionalContext(source, "test");
  for (const mutate of [
    value => { value.scopedContext.reviewSetMetrics.winRatePercent = 0; },
    value => { delete value.scopedContext.analysisContext; },
    value => { value.scopedContext.analysisContext.reconciliation.status = "reconciled"; },
  ]) assert.throws(() => validateWorkspaceEvidenceDelivery(source,
    change(contexts, "trading-cockpit-evidence", mutate)), /review.overview/);
  const brokerKey = Object.keys(contexts).find(key => key.startsWith("trading-cockpit-review-case-1-broker-"));
  for (const mutate of [
    value => { value.caseRef = "case-2"; },
    value => { value.symbol = "MSFT.US"; },
    value => { delete value.event; },
    value => { value.brokerAssociation.accountScopeId = "other"; },
  ]) assert.throws(() => validateWorkspaceEvidenceDelivery(source, change(contexts, brokerKey, mutate)), /metadata/);
  const testsKey = Object.keys(contexts).find(key => key.startsWith("trading-cockpit-review-tests-"));
  assert.throws(() => validateWorkspaceEvidenceDelivery(source,
    change(contexts, testsKey, value => { value.omittedCount = 0; })), /metadata/);
});

test("cycle overview also verifies new reconciliation semantics without a separate field list", () => {
  const source = evidence();
  source.scopedContext.analysisContext = { reconciliation: { status: "partial", accountScopeId: "opaque", evidenceRevision: 2 } };
  const contexts = buildWorkspaceAdditionalContext(source, "test");
  assert.doesNotThrow(() => validateWorkspaceEvidenceDelivery(source, contexts));
  assert.throws(() => validateWorkspaceEvidenceDelivery(source,
    change(contexts, "trading-cockpit-evidence", value => { value.scopedContext.analysisContext.reconciliation.status = "reconciled"; })), /review.overview/);
});
