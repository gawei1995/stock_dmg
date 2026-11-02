import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createObservedFact } from "../src/engine/numeric-evidence.mjs";
import {
  applyCodexWorkspaceAnalysis,
  buildCodexEvidence,
  buildReadOnlyToolGuard,
  buildWorkspaceAdditionalContext,
  buildWorkspacePrompt,
  compareSkillVersions,
  CodexAppServerRpc,
  CodexWorkspaceError,
  CodexWorkspaceService,
  expandAgentCommand,
  extractThreadTranscript,
  findRequestedApps,
  findRequestedSkills,
  workspaceContextDiagnostics,
  validateWorkspaceEvidenceDelivery,
} from "../src/engine/codex-workspace.mjs";

test("review evidence works without a live portfolio and enforces the order-first skill boundary", () => {
  const evidence = buildCodexEvidence({
    portfolio: null,
    task: "$review-earnings-decisions 复盘所选财报交易",
    run: {
      context: {
        scope: "review",
        reviewCaseIds: ["case-1"],
        snapshotAt: "2026-08-10T00:00:00.000Z",
      },
      analysisContext: {
        scope: "review",
        cases: [{ id: "case-1", symbol: "NVDA.US", fiscalQuarter: "FY2027 Q2" }],
        brokerRecords: [{ kind: "execution", recordId: "trade-1" }],
      },
      evidence: [],
      plan: { available: false },
    },
  });
  const prompt = buildWorkspacePrompt(evidence);

  assert.equal(evidence.analysisScope, "review");
  assert.equal(evidence.dataQuality.portfolioStatus, "not_required_for_review");
  assert.equal(evidence.technical, null);
  assert.match(prompt, /review-earnings-decisions/);
  assert.match(prompt, /不要从订单日期猜财季/);
});

test("large non-review evidence is delivered as bounded independently valid JSON blocks", () => {
  const priceBars = Array.from({ length: 260 }, (_, index) => ({
    barId: `bar-${index}`,
    time: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    tradeDate: null,
    open: 100 + index,
    high: 102 + index,
    low: 98 + index,
    close: 101 + index,
    volume: 1_000 + index,
  }));
  const evidence = {
    userTask: "分析大样本候选",
    project: { mode: "persistent_codex_workspace" },
    analysisScope: "candidate",
    context: { scope: "candidate", symbol: "AAPL.US" },
    scopedContext: {
      portfolioSummary: { cashRatioPercent: 20 },
      target: { symbol: "AAPL.US", weightPercent: 0 },
      technical: { priceBars, ema: { 21: 123.45 } },
      risk: { hardMaxTotalWeightPercent: 10 },
      numericEvidence: { facts: [] },
    },
    candidateTarget: { symbol: "AAPL.US" },
    portfolioRisk: { cashRatioPercent: 20 },
    technical: { ema: { 21: 123.45 } },
    locallyVerifiedConditionalPlan: { available: true },
    dataQuality: { portfolioStatus: "live" },
    localEvidenceTrace: [],
  };
  const contexts = buildWorkspaceAdditionalContext(evidence, "bounded prompt");
  const blocks = Object.entries(contexts)
    .filter(([key]) => key.startsWith("trading-cockpit-evidence"));

  assert.ok(blocks.length > 10);
  for (const [, block] of blocks) {
    assert.equal(block.kind, "application");
    assert.ok(block.value.length <= 3_000);
    assert.doesNotThrow(() => JSON.parse(block.value));
  }
  assert.ok(blocks.some(([key]) => key.startsWith("trading-cockpit-evidence-price-bars")));
});

test("portfolio source-to-wire contract delivers every radar card and rejects a missing card block", () => {
  const cards = Array.from({ length: 18 }, (_, index) => ({
    symbol: `RADAR${index}.US`,
    dailySequence: { status: index % 2 ? "bullish" : "bearish", note: "结构变化".repeat(40) },
  }));
  const evidence = {
    analysisScope: "portfolio", context: { scope: "portfolio", snapshotAt: "2026-09-17T20:00:00Z" },
    scopedContext: { portfolioSummary: {}, positions: [], risk: {},
      technicalRadar: { available: true, cards, batchId: "radar-source-sentinel", tradingDate: "2026-09-17" },
      groupExposure: [{ group: "科技", weight: 42 }],
    },
  };
  const contexts = buildWorkspaceAdditionalContext(evidence, "audit");
  const serialized = JSON.stringify(contexts);
  assert.ok(serialized.includes("radar-source-sentinel"));
  for (const card of cards) assert.ok(serialized.includes(card.symbol));
  assert.equal(workspaceContextDiagnostics(contexts).requiredFieldCoverage
    .find((item) => item.sourcePath === "scopedContext.technicalRadar")?.status, "verified");
  assert.doesNotThrow(() => validateWorkspaceEvidenceDelivery(evidence, contexts));
  const broken = { ...contexts };
  const cardKey = Object.keys(broken).find((key) => key.startsWith("trading-cockpit-evidence-radar-cards"));
  delete broken[cardKey];
  assert.throws(() => validateWorkspaceEvidenceDelivery(evidence, broken), /technicalRadar|分片不完整/);
  const changedSource = { ...evidence, scopedContext: { ...evidence.scopedContext,
    technicalRadar: { ...evidence.scopedContext.technicalRadar, batchId: "different-radar-version" } } };
  assert.throws(() => validateWorkspaceEvidenceDelivery(changedSource, contexts), /technicalRadar/);
});

test("portfolio evidence without a radar explicitly delivers an unavailable reason", () => {
  const contexts = buildWorkspaceAdditionalContext({ analysisScope: "portfolio", scopedContext: {} }, "audit");
  assert.match(JSON.stringify(contexts), /technical_radar_not_supplied/);
  assert.equal(workspaceContextDiagnostics(contexts).requiredFieldCoverage
    .find((item) => item.sourcePath === "scopedContext.technicalRadar")?.status, "verified");
});

test("large review evidence keeps linked broker facts in valid bounded application blocks", () => {
  const evidence = buildCodexEvidence({
    portfolio: null,
    task: "$review-earnings-decisions 复盘 AAOI 财报交易",
    run: {
      context: { scope: "review", reviewCaseIds: ["case-aaoi"] },
      analysisContext: {
        scope: "review",
        cases: [{
          id: "case-aaoi",
          symbol: "AAOI.US",
          fiscalQuarter: "FY2026 Q2",
          event: { eventAt: "2026-08-06T00:00:00.000Z", session: "amc" },
          brokerAssociation: { linkedOrderCount: 2, linkedExecutionCount: 0 },
          orders: [
            { kind: "order", recordRef: "order-1", side: "Buy", quantity: 100, executedQuantity: 100, executedPrice: 124, submittedAt: "2026-08-06T13:54:46Z" },
            { kind: "order", recordRef: "order-2", side: "Sell", quantity: 20, executedQuantity: 20, executedPrice: 140, submittedAt: "2026-08-07T11:20:27Z" },
          ],
          executions: [],
          exAnteDraft: { myView: "A".repeat(7_000), invalidation: "-5%" },
          exAnteVersions: [],
          outcome: null,
          review: null,
          ruleIds: [],
        }],
        tests: [],
        rules: [],
      },
      evidence: [],
      plan: { available: false },
    },
  });
  const contexts = buildWorkspaceAdditionalContext(evidence, "复盘指令");
  const reviewBlocks = Object.entries(contexts)
    .filter(([key]) => key.startsWith("trading-cockpit-review-"));
  const brokerText = reviewBlocks
    .filter(([key]) => key.includes("-broker-"))
    .map(([, value]) => value.value)
    .join("\n");

  assert.match(brokerText, /"side":"Buy"/);
  assert.match(brokerText, /"quantity":100/);
  assert.match(brokerText, /"executedPrice":124/);
  assert.match(brokerText, /"side":"Sell"/);
  assert.match(brokerText, /"executedPrice":140/);
  for (const [, block] of reviewBlocks) {
    assert.equal(block.kind, "application");
    assert.equal(block.value.length <= 3_000, true);
    assert.doesNotThrow(() => JSON.parse(block.value));
    assert.doesNotMatch(block.value, /tokens truncated/);
  }
});

test("large validation ledgers keep complete host metrics and declare the raw-row projection", () => {
  const tests = Array.from({ length: 50 }, (_, index) => ({
    id: `test-${index + 1}`,
    caseId: "case-aaoi",
    outcomeR: index / 10,
    outcomeVerified: true,
  }));
  const evidence = buildCodexEvidence({
    portfolio: null,
    task: "复盘验证样本",
    run: {
      context: { scope: "review", reviewCaseIds: ["case-aaoi"] },
      analysisContext: {
        scope: "review",
        cases: [{ id: "case-aaoi", symbol: "AAOI.US", orders: [], executions: [] }],
        tests,
        rules: [],
        reviewSetMetrics: {
          status: "available",
          sampleFunnel: { verifiedUniqueSampleCount: 50 },
          facts: { expectancyR: { availability: "known", value: 2.45, unit: { label: "R_multiple" } } },
        },
      },
      evidence: [],
      plan: { available: false },
    },
  });
  const contexts = buildWorkspaceAdditionalContext(evidence, "复盘验证样本");
  const deliveredTests = Object.entries(contexts)
    .filter(([key]) => key.startsWith("trading-cockpit-review-tests"))
    .flatMap(([, block]) => JSON.parse(block.value).tests ?? []);
  const diagnostics = workspaceContextDiagnostics(contexts);
  assert.equal(deliveredTests.length, 36);
  assert.equal(diagnostics.deliveryStatus, "complete_with_declared_omissions");
  assert.deepEqual(diagnostics.semanticOmissions[0], {
    path: "review.tests",
    sourceCount: 50,
    deliveredCount: 36,
    omittedCount: 14,
    deliveryPolicy: "bounded_head_and_tail_preserving_window_boundaries",
    reason: "Complete verified statistics remain in reviewSetMetrics; raw test rows are a declared head/tail qualitative projection.",
  });
  const overview = reconstructedContextJson(contexts, "trading-cockpit-evidence");
  assert.equal(overview.scopedContext.reviewSetMetrics.sampleFunnel.verifiedUniqueSampleCount, 50);
});

test("decision-cycle blind evidence is semantically chunked, bounded, and keeps the time firewall explicit", () => {
  const evidence = buildCodexEvidence({
    portfolio: null,
    task: "$review-decision-cycles 阶段一盲态重放",
    run: {
      context: {
        scope: "review",
        reviewProtocol: "decision_cycle",
        reviewCycleId: "cycle-1",
        reviewPhase: "blind",
      },
      analysisContext: {
        scope: "review",
        reviewProtocol: "decision_cycle",
        phase: "blind",
        timeFirewall: {
          cutoffAt: "2026-08-10T00:00:00.000Z",
          futureEvidencePhysicallyExcluded: true,
        },
        pointInTimeTechnical: {
          status: "complete",
          asOf: "2026-08-10T00:00:00.000Z",
          cutoffPolicy: "截止日整根 K 线排除",
          requestedSymbols: ["NVDA.US", "QQQ.US"],
          omittedSymbols: [],
          warnings: [],
          snapshots: [{ symbol: "NVDA.US", ema: { 21: 170 }, shortStructure: "交错 / 过渡" }],
        },
        cycle: {
          id: "cycle-1",
          type: "position_lifecycle",
          evidenceGrade: "prospective",
          sealedExAnte: { userOriginal: { myView: "A".repeat(7_000) } },
          orders: [{ side: "Buy", quantity: 100, executedPrice: 124 }],
          executions: [{ side: "Buy", quantity: 100, price: 124 }],
          checkpoints: [{ id: "cp-1", action: "首次建仓" }],
          outcome: null,
          blindAssessment: null,
        },
      },
      evidence: [],
      plan: { available: false },
    },
  });
  const contexts = buildWorkspaceAdditionalContext(evidence, "盲态复盘指令");
  const values = Object.values(contexts).map((item) => item.value);
  assert.equal(Object.keys(contexts).some((key) => key.includes("review-cycle-sealed")), true);
  assert.equal(Object.keys(contexts).some((key) => key.includes("review-cycle-broker")), true);
  assert.equal(Object.keys(contexts).some((key) => key.includes("review-cycle-checkpoints")), true);
  assert.equal(Object.keys(contexts).some((key) => key.includes("review-cycle-technical")), true);
  assert.equal(Object.keys(contexts).some((key) => key.includes("review-cycle-outcome")), false);
  assert.match(values.join("\n"), /futureEvidencePhysicallyExcluded/);
  assert.match(values.join("\n"), /"side":"Buy"/);
  assert.match(values.join("\n"), /"21":170/);
  for (const [key, block] of Object.entries(contexts)) {
    assert.equal(block.kind, "application");
    assert.equal(block.value.length <= 3_000, true);
    if (key !== "trading-cockpit-instructions") assert.doesNotThrow(() => JSON.parse(block.value));
    assert.doesNotMatch(block.value, /tokens truncated/);
  }
  const prompt = buildWorkspacePrompt(evidence);
  assert.match(prompt, /review-decision-cycles/);
  assert.match(prompt, /不得调用网页、MCP、近期历史/);
});

test("decision timeline is delivered as ordered bounded node capsules without backflow", () => {
  const evidence = buildCodexEvidence({
    portfolio: null,
    task: "$review-decision-cycles 按节点盲态重放",
    run: {
      context: {
        scope: "review",
        reviewProtocol: "decision_cycle",
        reviewCycleId: "cycle-timeline",
        reviewPhase: "blind",
      },
      analysisContext: {
        scope: "review",
        reviewProtocol: "decision_cycle",
        phase: "blind",
        timeFirewall: { futureEvidencePhysicallyExcluded: true },
        pointInTimeTechnical: { status: "complete", nodes: [] },
        cycle: {
          id: "cycle-timeline",
          type: "position_lifecycle",
          sealedExAnte: { userOriginal: { myView: "初始判断" } },
          orders: [{ orderId: "early", side: "Buy", quantity: 100, submittedPrice: 100 }],
          executions: [{ tradeId: "later", side: "Sell", quantity: 20, price: 112 }],
          checkpoints: [],
          decisionTimeline: [
            {
              nodeId: "initial",
              timelineIndex: 0,
              knowledgeCutoffAt: "2026-08-02T00:00:00.000Z",
              action: "初始建仓",
              brokerFactsIntroduced: {
                records: [{ recordRef: "order:early", side: "Buy", quantity: 100, submittedPrice: 100 }],
                missingRecordIds: [],
              },
              pointInTimeTechnical: {
                asOf: "2026-08-02T00:00:00.000Z",
                snapshots: [{ symbol: "NVDA.US", lastPrice: 100 }],
              },
            },
            {
              nodeId: "checkpoint-1",
              timelineIndex: 1,
              knowledgeCutoffAt: "2026-08-05T00:00:00.000Z",
              action: "后续减仓",
              brokerFactsIntroduced: {
                records: [{ recordRef: "execution:later", side: "Sell", quantity: 20, price: 112 }],
                missingRecordIds: [],
              },
              pointInTimeTechnical: {
                asOf: "2026-08-05T00:00:00.000Z",
                snapshots: [{ symbol: "NVDA.US", lastPrice: 111 }],
              },
            },
          ],
          outcome: null,
          blindAssessment: null,
        },
      },
      evidence: [],
      plan: { available: false },
    },
  });
  const contexts = buildWorkspaceAdditionalContext(evidence, "按时间线复盘");
  const earlyBlocks = Object.entries(contexts)
    .filter(([key]) => key.includes("timeline-node-001"))
    .map(([, value]) => value.value)
    .join("\n");
  const laterBlocks = Object.entries(contexts)
    .filter(([key]) => key.includes("timeline-node-002"))
    .map(([, value]) => value.value)
    .join("\n");
  assert.match(earlyBlocks, /初始建仓/);
  assert.match(earlyBlocks, /order:early/);
  assert.match(earlyBlocks, /"lastPrice":100/);
  assert.doesNotMatch(earlyBlocks, /后续减仓|execution:later|"lastPrice":111/);
  assert.match(laterBlocks, /后续减仓/);
  assert.match(laterBlocks, /execution:later/);
  assert.match(laterBlocks, /"lastPrice":111/);
  assert.equal(Object.keys(contexts).some((key) => key.includes("review-cycle-broker")), false);
  assert.equal(Object.keys(contexts).some((key) => key.includes("review-cycle-checkpoints")), false);
  assert.equal(Object.keys(contexts).some((key) => key.includes("review-cycle-technical")), false);
  for (const [key, block] of Object.entries(contexts)) {
    assert.equal(block.value.length <= 3_000, true);
    if (key !== "trading-cockpit-instructions") assert.doesNotThrow(() => JSON.parse(block.value));
  }
  const prompt = buildWorkspacePrompt(evidence);
  assert.match(prompt, /节点证据胶囊/);
  assert.match(prompt, /不得声称模型在物理上看不到后续胶囊/);
  assert.match(prompt, /严禁把晚节点行动、券商事实或技术快照倒灌到早节点/);
});

test("fragmented decision node contexts reconstruct byte-for-byte without silent loss", () => {
  const longAction = `ACTION-BEGIN-${"节点证据".repeat(2_000)}-ACTION-END`;
  const evidence = buildCodexEvidence({
    portfolio: null,
    task: "$review-decision-cycles 校验大节点",
    run: {
      context: {
        scope: "review",
        reviewProtocol: "decision_cycle",
        reviewCycleId: "cycle-large-node",
        reviewPhase: "blind",
      },
      analysisContext: {
        scope: "review",
        reviewProtocol: "decision_cycle",
        phase: "blind",
        timeFirewall: { futureEvidencePhysicallyExcluded: true },
        pointInTimeTechnical: { status: "unavailable", nodes: [] },
        cycle: {
          id: "cycle-large-node",
          type: "position_lifecycle",
          sealedExAnte: { userOriginal: { myView: "初始" } },
          orders: [],
          executions: [],
          checkpoints: [],
          decisionTimeline: [{
            nodeId: "large-node",
            timelineIndex: 0,
            knowledgeCutoffAt: "2026-08-02T00:00:00.000Z",
            action: longAction,
            brokerFactsIntroduced: { records: [], missingRecordIds: [] },
            pointInTimeTechnical: { status: "unavailable", snapshots: [] },
          }],
        },
      },
      evidence: [],
      plan: { available: false },
    },
  });
  const contexts = buildWorkspaceAdditionalContext(evidence, "大节点校验");
  const fragments = Object.entries(contexts)
    .filter(([key]) => key.startsWith("trading-cockpit-review-cycle-timeline-node-001"))
    .map(([, block]) => JSON.parse(block.value))
    .sort((left, right) => left.part - right.part);
  assert.equal(fragments.length > 1, true);
  assert.equal(fragments.every((item) => item.encoding === "json-fragment"), true);
  assert.deepEqual(fragments.map((item) => item.part), Array.from({ length: fragments.length }, (_, index) => index + 1));
  assert.equal(fragments.every((item) => item.parts === fragments.length), true);
  const reconstructed = JSON.parse(fragments.map((item) => item.fragment).join(""));
  assert.equal(reconstructed.node.action, longAction);
  assert.equal(reconstructed.node.nodeId, "large-node");
});

test("decision-cycle outcome evidence carries the frozen blind assessment in a separate block", () => {
  const evidence = buildCodexEvidence({
    portfolio: null,
    task: "$review-decision-cycles 阶段二结果归因",
    run: {
      context: {
        scope: "review",
        reviewProtocol: "decision_cycle",
        reviewCycleId: "cycle-2",
        reviewPhase: "outcome",
      },
      analysisContext: {
        scope: "review",
        reviewProtocol: "decision_cycle",
        phase: "outcome",
        deterministicOutcomeMetrics: {
          status: "partial",
          executionPnl: {
            linkedRoundTripGrossPnl: 320,
            accountRealizedGrossPnl: null,
            reason: "starting_inventory_not_proven_zero_linked_round_trip_only",
          },
          pricePath: {
            symbols: [{ symbol: "AAOI.US", periodReturnPercent: 8 }],
            benchmarkMetrics: { symbol: "QQQ.US", periodReturnPercent: 3 },
            excessReturns: [{ symbol: "AAOI.US", valuePercent: 5 }],
          },
          coverage: { reasons: [] },
          provenance: { deterministicHostCalculation: true, modelLookupAllowedAsMetricSubstitute: false },
        },
        cycle: {
          id: "cycle-2",
          orders: [],
          executions: [],
          checkpoints: [],
          blindAssessment: { assessmentId: "blind-1", summary: "当时判断冻结", frozen: true },
          outcome: { pnl: 320 },
        },
      },
      evidence: [],
      plan: { available: false },
    },
  });
  const contexts = buildWorkspaceAdditionalContext(evidence, "结果复盘指令");
  const outcome = Object.entries(contexts).find(([key]) => key.includes("review-cycle-outcome") && !key.includes("outcome-metrics"));
  assert.ok(outcome);
  assert.match(outcome[1].value, /当时判断冻结/);
  assert.match(outcome[1].value, /"pnl":320/);
  const metrics = Object.entries(contexts).find(([key]) => key.includes("review-cycle-outcome-metrics"));
  assert.ok(metrics);
  assert.match(metrics[1].value, /linkedRoundTripGrossPnl/);
  assert.match(metrics[1].value, /modelLookupAllowedAsMetricSubstitute/);
  assert.match(buildWorkspacePrompt(evidence), /先核对已冻结 blindAssessment 的 resultHash、summaryHash 与 truncated/);
  assert.match(buildWorkspacePrompt(evidence), /truncated=false 才能把 summary 作为完整原文引用/);
  assert.match(buildWorkspacePrompt(evidence), /禁止用网页、MCP 临时查询或当前持仓补成确定性指标/);
});

test("explicit Buy-to-Sell trade paths reach Codex as bounded semantic blocks without duplicating long segments", () => {
  const segments = Array.from({ length: 220 }, (_, index) => ({
    index: index + 1,
    startTradeDate: `2026-06-${String((index % 28) + 1).padStart(2, "0")}`,
    endTradeDate: `2026-06-${String((index % 28) + 1).padStart(2, "0")}`,
    tradingDayCount: 3,
    firstClose: 100 + index,
    lastClose: 101 + index,
    closeReturnPercent: 1,
    direction: "up",
  }));
  const evidence = buildCodexEvidence({
    portfolio: null,
    task: "$review-decision-cycles 复盘框选交易价格路径",
    run: {
      context: {
        scope: "review",
        reviewProtocol: "decision_cycle",
        reviewCycleId: "cycle-trade-path",
        reviewPhase: "retrospective",
      },
      analysisContext: {
        scope: "review",
        reviewProtocol: "decision_cycle",
        phase: "retrospective",
        deterministicOutcomeMetrics: {
          status: "partial",
          executionPnl: { status: "partial", linkedRoundTripGrossPnl: 120 },
          tradePricePath: {
            schemaVersion: 1,
            status: "partial",
            reason: "selected_position_remains_open",
            symbol: "AAOI.US",
            positionStatus: "partially_closed",
            window: {
              startAt: "2026-06-01T14:00:00.000Z",
              endAt: "2026-08-01T21:00:00.000Z",
              boundaryPolicy: "earliest_selected_buy_to_latest_selected_sell",
            },
            activities: [
              { id: "execution:buy", side: "buy", quantity: 100, price: 100, at: "2026-06-01T14:00:00.000Z" },
              { id: "execution:sell", side: "sell", quantity: 20, price: 106, at: "2026-08-01T21:00:00.000Z" },
            ],
            lots: [{ id: "lot-1", originalQuantity: 100, matchedQuantity: 20, openQuantity: 80 }],
            cycles: [{ id: "cycle-1", quantity: 20, grossPnl: 120, pricePath: { status: "available", trend: { segments } } }],
            metrics: { realizedQuantity: 20, openQuantity: 80, linkedSelectionGrossPnl: 120 },
            pricePath: {
              status: "available",
              periodReturnPercent: 6,
              trend: { granularity: "3_trading_days", segmentTradingDays: 3, segmentCount: segments.length, segments },
            },
            coverage: { selectedOnly: true, timezone: "America/New_York" },
          },
          coverage: { reasons: [] },
        },
        cycle: {
          id: "cycle-trade-path",
          type: "trade_window",
          evidenceRevision: 3,
          brokerAssociation: { evidenceRevision: 3 },
          orders: [],
          executions: [],
          checkpoints: [],
        },
      },
      evidence: [],
      plan: { available: false },
    },
  });

  const contexts = buildWorkspaceAdditionalContext(evidence, buildWorkspacePrompt(evidence));
  const segmentBlocks = Object.entries(contexts)
    .filter(([key]) => key.startsWith("trading-cockpit-review-cycle-trade-path-segments-"))
    .map(([, block]) => JSON.parse(block.value))
    .sort((left, right) => left.part - right.part);
  assert.equal(segmentBlocks.length > 1, true);
  const deliveredSegments = segmentBlocks.flatMap((item) => item.segments);
  assert.equal(deliveredSegments.length, 180);
  assert.deepEqual(deliveredSegments.slice(0, 90), segments.slice(0, 90));
  assert.deepEqual(deliveredSegments.slice(-90), segments.slice(-90));
  assert.equal(segmentBlocks.every((item) => item.sourceCount === 220), true);
  assert.equal(segmentBlocks.every((item) => item.deliveredCount === 180), true);
  assert.equal(segmentBlocks.every((item) => item.omittedCount === 40), true);
  assert.equal(segmentBlocks.every((item) => item.deliveryPolicy === "bounded_head_and_tail_preserving_window_boundaries"), true);
  assert.equal(segmentBlocks.every((item) => item.segmentTradingDays === 3), true);
  const fifoSegmentBlocks = Object.entries(contexts)
    .filter(([key]) => key.startsWith("trading-cockpit-review-cycle-trade-path-fifo-cycle-segments-"))
    .map(([, block]) => JSON.parse(block.value))
    .sort((left, right) => left.part - right.part);
  assert.equal(fifoSegmentBlocks.length, 0, "duplicate FIFO segment rows are not retransmitted");
  const meta = Object.entries(contexts).find(([key]) => key === "trading-cockpit-review-cycle-trade-path-meta");
  assert.ok(meta);
  assert.match(meta[1].value, /earliest_selected_buy_to_latest_selected_sell/);
  assert.match(meta[1].value, /"omittedCount":40/);
  assert.match(meta[1].value, /"deliveryPolicy":"omitted_duplicate_detail"/);
  assert.doesNotMatch(meta[1].value, /"segments"/);
  const outcomeMetricText = Object.entries(contexts)
    .filter(([key]) => key.startsWith("trading-cockpit-review-cycle-outcome-metrics"))
    .map(([, block]) => block.value)
    .join("\n");
  assert.doesNotMatch(outcomeMetricText, /tradePricePath|"segments"/);
  for (const [key, block] of Object.entries(contexts)) {
    assert.equal(block.value.length <= 3_000, true, key);
    if (key !== "trading-cockpit-instructions") assert.doesNotThrow(() => JSON.parse(block.value), key);
  }
  const prompt = buildWorkspacePrompt(evidence);
  assert.match(prompt, /明确框选订单\/成交所定义 Buy→Sell 窗口/);
  assert.match(prompt, /系统补充的父订单或同单成交不得扩窗/);
  assert.match(prompt, /连续 3 交易日分段/);
  assert.match(prompt, /禁止另查历史首笔交易或替代窗口/);
  const diagnostics = workspaceContextDiagnostics(contexts);
  const manifest = reconstructedContextJson(contexts, "trading-cockpit-context-manifest");
  assert.equal(diagnostics.deliveryStatus, "complete_with_declared_omissions");
  assert.equal(diagnostics.silentlyTruncated, false);
  assert.equal(manifest.budget.totalCharacters, Object.values(contexts)
    .reduce((sum, block) => sum + block.value.length, 0));
  assert.equal(manifest.budget.totalBlockCount, Object.keys(contexts).length);
  assert.deepEqual(manifest.semanticOmissions, diagnostics.semanticOmissions);
  assert.ok(diagnostics.semanticOmissions.some((item) => (
    item.path === "tradePricePath.cycles[].pricePath.trend.segments"
      && item.deliveryPolicy === "omitted_duplicate_detail"
      && item.omittedCount === 220
  )));
});

test("workspace context manifest deterministically covers every transported payload block", () => {
  const evidence = {
    userTask: "检查组合上下文 manifest",
    project: { mode: "persistent_codex_workspace" },
    analysisScope: "portfolio",
    context: { scope: "portfolio" },
    scopedContext: {
      portfolioSummary: { cashRatioPercent: 20 },
      positions: [
        { symbol: "AAPL.US", quantity: 10, weightPercent: 12 },
        { symbol: "NVDA.US", quantity: 8, weightPercent: 9 },
      ],
      technical: null,
      risk: { grossExposurePercent: 80 },
      numericEvidence: { facts: [] },
    },
    portfolioRisk: { cashRatioPercent: 20 },
    technical: null,
    locallyVerifiedConditionalPlan: { available: false },
    dataQuality: { portfolioStatus: "live" },
    localEvidenceTrace: [],
  };
  const first = buildWorkspaceAdditionalContext(evidence, "manifest prompt");
  const second = buildWorkspaceAdditionalContext(evidence, "manifest prompt");
  const manifest = reconstructedContextJson(first, "trading-cockpit-context-manifest");
  const diagnostics = workspaceContextDiagnostics(first);
  const payload = Object.entries(first)
    .filter(([key]) => !key.startsWith("trading-cockpit-context-manifest"))
    .sort(([left], [right]) => left.localeCompare(right));

  assert.equal(manifest.schemaVersion, "trading-cockpit-context-manifest/v1");
  assert.equal(manifest.deliveryStatus, "complete");
  assert.equal(manifest.silentlyTruncated, false);
  assert.equal(manifest.bundleHash, workspaceContextDiagnostics(second).bundleHash);
  assert.equal(manifest.bundleHash, diagnostics.bundleHash);
  assert.equal(manifest.blocks.length, payload.length);
  assert.equal(manifest.budget.totalCharacters, Object.values(first)
    .reduce((sum, block) => sum + block.value.length, 0));
  assert.equal(manifest.budget.totalBlockCount, Object.keys(first).length);
  for (const descriptor of manifest.blocks) {
    const block = first[descriptor.key];
    assert.ok(block, `manifest block ${descriptor.key} exists`);
    assert.equal(descriptor.characters, block.value.length);
    assert.equal(
      descriptor.sha256,
      `sha256:${createHash("sha256").update(block.value).digest("hex")}`,
    );
  }
  const index = reconstructedContextJson(first, "trading-cockpit-evidence");
  assert.equal(index.blockIndex.includes("positions"), true);
});

test("workspace context fails closed when the complete evidence bundle exceeds its hard budget", () => {
  const decisionTimeline = Array.from({ length: 12 }, (_, index) => ({
    nodeId: `node-${index}`,
    timelineIndex: index,
    knowledgeCutoffAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    decision: `decision-${index}-${"证据".repeat(4_000)}`,
    action: `action-${index}-${"动作".repeat(4_000)}`,
    brokerFactsIntroduced: { records: [], missingRecordIds: [] },
    pointInTimeTechnical: { status: "unavailable", snapshots: [] },
  }));
  const evidence = {
    analysisScope: "review",
    userTask: "压力测试复盘上下文",
    project: { mode: "persistent_codex_workspace" },
    context: {
      scope: "review",
      reviewProtocol: "decision_cycle",
      reviewPhase: "blind",
    },
    scopedContext: {
      scope: "review",
      reviewProtocol: "decision_cycle",
      phase: "blind",
      timeFirewall: { futureEvidencePhysicallyExcluded: true },
      pointInTimeTechnical: { status: "unavailable", nodes: [] },
      cycle: {
        id: "cycle-over-budget",
        orders: [],
        executions: [],
        checkpoints: [],
        decisionTimeline,
      },
    },
    localEvidenceTrace: [],
  };

  assert.throws(
    () => buildWorkspaceAdditionalContext(evidence, "bounded review prompt"),
    (error) => {
      assert.equal(error.kind, "context_budget");
      assert.match(error.message, /拒绝发送且没有静默截断/);
      assert.equal(error.contextDiagnostics.deliveryStatus, "rejected_budget");
      assert.equal(error.contextDiagnostics.silentlyTruncated, false);
      assert.ok(error.contextDiagnostics.totalCharacters > error.contextDiagnostics.maximumCharacters);
      return true;
    },
  );
});

test("order-first retrospective evidence exposes metrics without claiming a blind cutoff or baseline", () => {
  const evidence = buildCodexEvidence({
    portfolio: null,
    task: "$review-decision-cycles 直接事后复盘",
    run: {
      context: {
        scope: "review",
        reviewProtocol: "decision_cycle",
        reviewCycleId: "cycle-retro",
        reviewPhase: "retrospective",
      },
      analysisContext: {
        scope: "review",
        reviewProtocol: "decision_cycle",
        phase: "retrospective",
        timeFirewall: {
          cutoffAt: null,
          cycleEvidenceEndAt: "2026-08-10T23:59:59.000Z",
          retrospectiveHasNoKnowledgeCutoff: true,
        },
        deterministicOutcomeMetrics: {
          status: "available",
          executionPnl: { linkedRoundTripGrossPnl: 200 },
          coverage: { loadedSymbols: [{ symbol: "NVDA.US" }] },
        },
        cycle: {
          id: "cycle-retro",
          type: "trade_window",
          reviewMode: "lightweight",
          evidenceGrade: "retrospective",
          sealedExAnte: null,
          blindAssessment: null,
          orders: [{ side: "Buy", quantity: 100, submittedAt: "2026-08-01T12:00:00Z" }],
          executions: [{ side: "Buy", quantity: 100, price: 100, doneAt: "2026-08-01T12:01:00Z" }],
          checkpoints: [],
          outcome: null,
        },
      },
      evidence: [],
      plan: { available: false },
    },
  });
  const contexts = buildWorkspaceAdditionalContext(evidence, "订单优先复盘");
  const all = Object.values(contexts).map((item) => item.value).join("\n");
  assert.match(all, /cycleEvidenceEndAt/);
  assert.match(all, /linkedRoundTripGrossPnl/);
  assert.match(all, /"evidenceGrade":"retrospective"/);
  assert.doesNotMatch(all, /"cutoffAt":"2026-08-10/);
  const prompt = buildWorkspacePrompt(evidence);
  assert.match(prompt, /订单优先的直接事后复盘/);
  assert.match(prompt, /没有 knowledge cutoff、冻结事前基线或 blindAssessment/);
  assert.match(prompt, /不得把事后解释改写成当时判断/);
});

test("history exposes one aggregated assistant answer and hides commentary segments", () => {
  const transcript = extractThreadTranscript([{ items: [
    { type: "userMessage", content: [{ type: "text", text: "分析 Google" }] },
    { type: "agentMessage", id: "commentary", phase: "commentary", text: "正在查资料" },
    { type: "agentMessage", id: "final-1", phase: "final_answer", text: "最终结论" },
    { type: "agentMessage", id: "final-2", phase: "final_answer", text: "风险计划" },
  ] }]);
  assert.deepEqual(transcript, [
    { role: "user", text: "分析 Google" },
    { role: "assistant", text: "最终结论\n\n风险计划" },
  ]);
});

test("read-only thread config targets Longbridge execution tools without limiting ordinary MCP analysis", () => {
  const guard = buildReadOnlyToolGuard({
    effectiveConfig: {
      mcp_servers: {
        broker_data: {
          url: "https://mcp.longbridge.com/v2",
          disabled_tools: ["user_disabled_tool"],
        },
        commerce: {
          url: "https://example.com/mcp",
          disabled_tools: ["catalog_delete"],
        },
      },
      apps: {
        _default: { default_tools_enabled: false, approval_mode: "always" },
        longbridge: { enabled: true },
        research: { enabled: true, destructive_enabled: true },
        disabled_app: { enabled: false, tools: { protected_tool: { enabled: false } } },
      },
    },
  });

  const disabled = guard.config.mcp_servers.broker_data.disabled_tools;
  assert.equal(disabled.includes("user_disabled_tool"), true);
  for (const tool of [
    "submit_order",
    "replace_order",
    "cancel_order",
    "dca_create",
    "dca_pause",
    "dca_resume",
  ]) assert.equal(disabled.includes(tool), true);
  for (const queryTool of [
    "today_orders",
    "history_orders",
    "order_detail",
    "stock_positions",
    "quote",
    "dca_list",
  ]) assert.equal(disabled.includes(queryTool), false);
  assert.equal("commerce" in guard.config.mcp_servers, false);
  assert.deepEqual(guard.config.apps, {
    _default: { default_tools_enabled: false, approval_mode: "always", destructive_enabled: false },
    longbridge: { enabled: true },
    research: { enabled: true, destructive_enabled: false },
    disabled_app: { enabled: false, tools: { protected_tool: { enabled: false } } },
  });
});

test("transaction deny-list also applies to IBKR direct and plugin servers without disabling queries", () => {
  const guard = buildReadOnlyToolGuard({ effectiveConfig: {
    mcp_servers: {
      ibkr_tws: { command: "node", args: ["ibkr-server.mjs"], disabled_tools: ["user_disabled"] },
      account_data: { url: "https://api.interactivebrokers.com/v1/api" },
      research: { url: "https://research.example.com/mcp" },
    },
    plugins: { "interactive-brokers": { mcp_servers: { gateway: { command: "gateway" } } } },
  } });
  const entries = [guard.config.mcp_servers.ibkr_tws,
    guard.config.mcp_servers.account_data, guard.config.plugins["interactive-brokers"].mcp_servers.gateway];
  for (const entry of entries) {
    for (const name of ["placeOrder", "cancelOrder", "exerciseOptions", "transfer_funds", "transfer_securities"])
      assert.ok(entry.disabled_tools.includes(name), name);
    for (const name of ["reqPositions", "get_option_chain", "account_summary"])
      assert.ok(!entry.disabled_tools.includes(name), name);
  }
  assert.ok(entries[0].disabled_tools.includes("user_disabled"));
  assert.equal(guard.config.mcp_servers.research, undefined);
});

test("TV native thread allowlist is verified per inventory and never advertises escaped or failed tools", async () => {
  for (const fixture of [
    { names: ["get_ohlcv"], status: "connected", ready: true },
    { names: ["get_ohlcv", "get_active_watchlist", "create_alert", "future_tool"], status: "connected", ready: true },
    { names: ["get_ohlcv"], status: "connected", ready: false, declaredWrite: true },
    { names: [], status: "failed", ready: true },
  ]) {
    let rpc;
    class TradingViewRpc extends FakeRpc {
      async request(method, params) {
        if (method === "config/read") return { config: { mcp_servers: { tradingview: {
          url: "https://mcp.tradingview.com/mcp", enabled_tools: ["get_ohlcv"], required: false,
        } } } };
        if (method === "mcpServerStatus/list") return { data: [{ name: "tradingview",
          authStatus: fixture.status === "failed" ? "notLoggedIn" : "oAuth", runtimeStatus: fixture.status,
          toolsError: fixture.status === "failed" ? "synthetic upstream 503" : null,
          tools: Object.fromEntries(fixture.names.map(name => [name, { name, annotations: { readOnlyHint: !fixture.declaredWrite } }])),
        }] };
        return super.request(method, params);
      }
    }
    const service = new CodexWorkspaceService({ codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace",
      store: new MemoryStore(), rpcFactory: options => (rpc = new TradingViewRpc(options)),
    });
    try {
      await service.prepare();
      await service.refreshInventory();
      const start = rpc.calls.find(call => call.method === "thread/start");
      assert.deepEqual(start.params.config.mcp_servers.tradingview.enabled_tools, ["get_ohlcv"]);
      assert.equal(service.status().readOnlyGuardReady, fixture.ready);
      const cap = service.capabilities().mcpServers[0];
      assert.deepEqual(cap.tools.map(tool => tool.name), fixture.names.includes("get_ohlcv") && !fixture.declaredWrite ? ["get_ohlcv"] : []);
      assert.equal(cap.runtimeStatus, fixture.status);
      assert.equal(cap.toolsUnavailable, fixture.status === "failed");
      if (fixture.names.includes("create_alert")) {
        assert.deepEqual(service.capabilities().readOnlyGuard.configuredMcpDenials.map(t => t.tool), ["get_active_watchlist", "create_alert", "future_tool"]);
        assert.deepEqual(service.capabilities().readOnlyGuard.rawResidualTools.map(t => t.tool), ["get_active_watchlist", "create_alert", "future_tool"]);
      }
      if (!fixture.ready) assert.deepEqual(service.capabilities().readOnlyGuard.residualTools.map(t => t.tool), ["get_ohlcv"]);
    } finally { service.dispose(); }
  }
});

test("Codex workspace starts a persistent unrestricted project thread with real capability inventory", async () => {
  const store = new MemoryStore();
  const rpcInstances = [];
  const service = createService({ store, rpcInstances });
  await service.prepare();
  await service.refreshInventory();

  const rpc = rpcInstances[0];
  const start = rpc.calls.find((call) => call.method === "thread/start");
  assert.equal(start.params.cwd, "/tmp/stock-agent-workspace");
  assert.equal(start.params.ephemeral, false);
  assert.equal(start.params.sandbox, "danger-full-access");
  assert.equal(start.params.approvalPolicy, "on-request");
  assert.equal(start.params.approvalsReviewer, "auto_review");
  assert.equal(start.params.dynamicTools[0].name, "query_recent_history");
  assert.equal(service.status().persistent, true);
  assert.equal(service.status().toolsEnabled, true);
  assert.equal(service.capabilities().skills[0].name, "technical-structure");
  assert.equal(service.capabilities().mcpServers[0].tools[0].name, "quote");
  assert.deepEqual(service.capabilities().apps.map((app) => app.id), ["research-app"]);
});

test("session startup and local listing do not wait for slow capability inventory", async () => {
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => {
      rpc = new HangingInventoryRpc(options);
      return rpc;
    },
  });
  await Promise.race([
    service.prepare(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("prepare blocked")), 100)),
  ]);
  rpc.calls.length = 0;
  const listing = await Promise.race([
    service.listSessions(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("list blocked")), 100)),
  ]);
  assert.equal(listing.sessions.length, 1);
  assert.equal(rpc.calls.some((call) => call.method === "thread/list"), false);
  service.dispose();
});

test("capability discovery is single-flight while each new thread gets its own MCP proof", async () => {
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => {
      rpc = new MultiSessionRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  await Promise.all([
    service.refreshInventory(),
    service.refreshInventory(),
    service.refreshInventory(),
  ]);
  const firstThreadId = service.status().threadId;
  await service.createSession({ name: "能力缓存会话" });
  await service.refreshInventory();
  const secondThreadId = service.status().threadId;
  assert.notEqual(firstThreadId, secondThreadId);
  for (const method of ["skills/list", "app/list"]) {
    assert.equal(rpc.calls.filter((call) => call.method === method).length, 1);
  }
  assert.deepEqual(rpc.calls.filter((call) => call.method === "mcpServerStatus/list")
    .map((call) => call.params.threadId), [firstThreadId, secondThreadId]);
  service.dispose();
});

test("App update notifications deliver directory data without refetching or certifying a partial load", async () => {
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => {
      rpc = new IndependentInventoryRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  await waitUntil(() => service.capabilities().inventory.mcp.fresh === true);
  assert.equal(service.capabilities().inventory.skills.fresh, true);
  assert.equal(service.capabilities().inventory.apps.fresh, false);

  const data = [{ id: "updated-app", name: "Updated research", isAccessible: true, isEnabled: true }];
  rpc.options.onNotification({ method: "app/list/updated", params: { data } });
  assert.deepEqual(service.capabilities().apps.map(app => app.id), ["updated-app"]);
  assert.equal(service.capabilities().inventory.apps.fresh, false);
  assert.equal(service.inventoryQueuedResources.has("apps"), false);
  rpc.resolveFirstAppList();
  await waitUntil(() => service.capabilities().inventory.apps.fresh === true);
  assert.deepEqual(service.capabilities().apps, []);
  assert.equal(rpc.calls.filter((call) => call.method === "app/list").length, 1);
  assert.equal(rpc.calls.filter((call) => call.method === "skills/list").length, 1);
  assert.equal(rpc.calls.filter((call) => call.method === "mcpServerStatus/list").length, 1);

  service.inventoryState.apps.error = "a prior full directory refresh failed";
  const verifiedAt = service.inventoryState.apps.updatedAt;
  const guardBeforeNotification = structuredClone(service.capabilities().readOnlyGuard);
  rpc.options.onNotification({ method: "app/list/updated", params: { data: [...data,
    { id: "disabled-app", name: "Disabled", isAccessible: true, isEnabled: false },
    { id: "private-app", name: "Private", isAccessible: false, isEnabled: true },
  ] } });
  assert.deepEqual(service.capabilities().apps.map(app => app.id), ["updated-app"]);
  assert.equal(service.inventoryState.apps.updatedAt, verifiedAt);
  assert.equal(service.capabilities().inventory.apps.error, "a prior full directory refresh failed");
  assert.deepEqual(service.capabilities().readOnlyGuard, guardBeforeNotification);
  rpc.options.onNotification({ method: "app/list/updated", params: {} });
  assert.deepEqual(service.capabilities().apps.map(app => app.id), ["updated-app"]);
  assert.equal(service.inventoryRefreshTimer, null);
  service.dispose();
});

test("self-emitting App list reads never create a forced refresh feedback loop", async () => {
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => {
      rpc = new SelfUpdatingAppInventoryRpc(options);
      return rpc;
    },
  });
  try {
    await service.prepare();
    await service.refreshInventory();
    // The old loop scheduled another forced read 1.5 seconds after every
    // successful response, even when its notification already held the data.
    await new Promise(resolve => setTimeout(resolve, 1_650));
    assert.equal(rpc.calls.filter(call => call.method === "app/list").length, 1);
    assert.equal(service.inventoryQueuedResources.has("apps"), false);
    assert.equal(service.inventoryRefreshTimer, null);
    await service.refreshInventory({ forceReload: true, resources: ["apps"] });
    assert.equal(rpc.calls.filter(call => call.method === "app/list").length, 2);
    assert.equal(rpc.calls.filter(call => call.method === "app/list")[1].params.forceRefetch, true);
    assert.equal(service.inventoryQueuedResources.has("apps"), false);
    assert.equal(service.inventoryRefreshTimer, null);
  } finally { service.dispose(); }
});

test("capability publications report settled guard readiness without waiting for the App directory", async () => {
  let rpc;
  const publications = [];
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    rpcFactory: options => (rpc = new IndependentInventoryRpc(options)),
    onCapabilities: capabilities => publications.push({ capabilities,
      mcpPending: Boolean(service.inventoryPromises.mcp),
      threadProofPending: service.threadBrokerGuardPromises.has(capabilities.threadId),
      appsPending: Boolean(service.inventoryPromises.apps) }),
  });
  try {
    await service.prepare();
    await waitUntil(() => publications.some(item => item.capabilities.readOnlyGuardReady));
    const ready = publications.find(item => item.capabilities.readOnlyGuardReady);
    assert.equal(ready.mcpPending, false);
    assert.equal(ready.threadProofPending, false);
    assert.equal(ready.appsPending, true);
    assert.equal(ready.capabilities.inventory.apps.fresh, false);
    rpc.options.onNotification({ method: "app/list/updated", params: { data: [
      { id: "live-directory-app", name: "Live directory", isAccessible: true, isEnabled: true },
    ] } });
    await waitUntil(() => publications.some(item => item.capabilities.apps.some(app => app.id === "live-directory-app")));
    assert.equal(rpc.calls.filter(call => call.method === "app/list").length, 1);
    rpc.resolveFirstAppList();
    await waitUntil(() => publications.some(item => item.capabilities.inventory.apps.fresh));
    assert.equal(publications.at(-1).appsPending, false);
  } finally { service.dispose(); }
});

test("failed capability reads are published and callback failures never block inventory", async () => {
  let rpc, callbackMode = "record";
  const publications = [];
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    rpcFactory: options => (rpc = new FakeRpc(options)),
    onCapabilities: capabilities => {
      publications.push(capabilities);
      if (callbackMode === "throw") throw new Error("UI disconnected");
      if (callbackMode === "reject") return Promise.reject(new Error("asynchronous UI failure"));
      if (callbackMode === "pending") return new Promise(() => {});
    },
  });
  try {
    await service.prepare();
    await service.refreshInventory();
    await waitUntil(() => publications.length > 0);
    const request = rpc.request.bind(rpc);
    rpc.request = async (method, params) => {
      if (method === "app/list") throw new Error("directory refresh unavailable");
      return request(method, params);
    };
    for (const mode of ["throw", "reject", "pending"]) {
      callbackMode = mode;
      const previous = publications.length;
      await service.refreshInventory({ forceReload: true, resources: ["apps"] });
      await waitUntil(() => publications.length > previous);
      assert.match(publications.at(-1).inventory.apps.error, /directory refresh unavailable/);
      assert.equal(service.inventoryPromises.apps, null);
    }
  } finally { service.dispose(); }
});

test("late capability results and notifications from disposed RPC generations cannot publish", async () => {
  const rpcs = [], publications = [];
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    rpcFactory: options => {
      const rpc = new IndependentInventoryRpc(options);
      rpcs.push(rpc);
      return rpc;
    },
    onCapabilities: capabilities => publications.push(capabilities),
  });
  try {
    await service.prepare();
    await waitUntil(() => publications.length > 0);
    service.dispose();
    await service.prepare();
    rpcs[1].resolveFirstAppList();
    await service.refreshInventory();
    await new Promise(resolve => setImmediate(resolve));
    const count = publications.length;
    rpcs[0].resolveFirstAppList();
    rpcs[0].options.onNotification({ method: "app/list/updated", params: { data: [
      { id: "old-app", name: "Disposed app", isAccessible: true, isEnabled: true },
    ] } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(publications.length, count);
    assert.equal(service.capabilities().apps.some(app => app.id === "old-app"), false);
  } finally { service.dispose(); }
});

test("MCP inventory follows every nextCursor before the read-only guard is verified", async () => {
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => {
      rpc = new PaginatedMcpInventoryRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  await waitUntil(() => rpc.calls.filter((call) => call.method === "mcpServerStatus/list").length === 2);

  const pageCalls = rpc.calls.filter((call) => call.method === "mcpServerStatus/list");
  assert.equal(pageCalls[0].params.cursor, undefined);
  assert.equal(pageCalls[1].params.cursor, "mcp-page-2");
  assert.equal(service.status().readOnlyGuardReady, false);
  assert.equal(service.capabilities().inventory.mcp.fresh, false);

  rpc.resolveSecondPage();
  await waitUntil(() => service.capabilities().inventory.mcp.fresh === true);
  assert.deepEqual(service.capabilities().mcpServers.map((server) => server.name), [
    "market",
    "broker_data",
  ]);
  assert.equal(service.status().readOnlyGuardReady, false);
  assert.deepEqual(service.capabilities().readOnlyGuard.residualTools, [{
    server: "broker_data",
    tool: "submit_bracket_order",
  }]);
  await assert.rejects(service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "验证分页后的只读保护",
  }), /尚未被线程配置禁用的交易写能力/);
  assert.equal(rpc.calls.some((call) => call.method === "turn/start"), false);
  service.dispose();
});

test("persistent App Server threads apply the Longbridge write deny-list before model turns", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new GuardedLongbridgeRpc(options),
  });
  await service.prepare();
  await service.refreshInventory();

  const rpc = service.rpc;
  const start = rpc.calls.find((call) => call.method === "thread/start");
  const disabled = start.params.config.mcp_servers.broker_data.disabled_tools;
  assert.equal(disabled.includes("existing_disabled"), true);
  assert.equal(disabled.includes("submit_order"), true);
  assert.equal(start.params.config.apps._default.destructive_enabled, false);
  assert.equal(service.status().readOnlyGuardReady, true);
  assert.deepEqual(
    service.capabilities().mcpServers[0].tools.map((tool) => tool.name),
    ["quote", "stock_positions"],
  );

  await service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "$technical-structure 只读分析",
  });
  assert.equal(rpc.calls.some((call) => call.method === "turn/start"), true);
  service.dispose();
});

test("analyze fails closed only when an unguarded Longbridge write tool remains visible", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new UnguardedLongbridgeRpc(options),
  });
  await service.prepare();
  assert.equal(service.status().readOnlyGuardReady, false);
  await assert.rejects(service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "只读分析",
  }), /尚未被线程配置禁用的交易写能力/);
  assert.equal(service.rpc.calls.some((call) => call.method === "turn/start"), false);
  service.dispose();
});

test("shared IBKR App raw catalog retains writes while its cold-start exact deny receipt permits research", async () => {
  const { service, rpc } = brokerAppFixture();
  try {
    await service.prepare();
    await service.refreshInventory();
    const start = rpc.calls.find(call => call.method === "thread/start");
    assertBrokerAppOverrides(start.params.config);
    assert.equal(rpc.calls.some(call => call.method === "thread/resume"), false);
    assert.equal(rpc.calls.filter(call => call.method === "mcpServerStatus/list").length, 2);
    assert.equal(service.status().readOnlyGuardReady, true);
    assert.deepEqual(service.capabilities().readOnlyGuard.residualTools, []);
    assert.equal(service.capabilities().readOnlyGuard.rawResidualTools.length, 2);
    assert.equal(service.capabilities().readOnlyGuard.configuredAppDenials.length, 2);
    assert.equal(service.capabilities().readOnlyGuard.configurationReceipt.origin, "start");
    assert.deepEqual(service.capabilities().mcpServers[0].tools.map(tool => tool.name), [
      "interactive_brokers_ibkr.get_positions", "interactive_brokers_ibkr.get_order_cancel_status", "tasks.cancel_task",
    ]);
    assert.equal(rpc.calls.some(call => /config\/.*write/.test(call.method)), false);
    const analysis = service.analyze({ portfolio: portfolioFixture(), run: runFixture(), task: "只读研究" });
    await waitUntil(() => rpc.calls.some(call => call.method === "turn/start"));
    rpc.completeThread(service.threadId, "只读研究结果");
    assert.equal((await analysis).text, "只读研究结果");
  } finally { service.dispose(); }
});

test("shared broker App writes fail preflight for missing or ambiguous discovered identities", async () => {
  for (const options of [
    { apps: [], installedApps: [{ id: "unknown", runtimeName: null }] },
    { apps: [brokerAppIdentity(), { ...brokerAppIdentity(), id: "asdk_app_second" }] },
    { appsError: true, installedApps: [{ id: "unknown", runtimeName: null }] },
  ]) {
    const { service, rpc } = brokerAppFixture(options);
    try {
      await assert.rejects(service.prepare(), { kind: "read_only_guard" });
      assert.equal(service.status().readOnlyGuardReady, false);
      assert.equal(rpc.calls.some(call => call.method === "thread/resume"), false);
      assert.equal(rpc.calls.some(call => call.method === "thread/start"), false);
      assert.equal(rpc.calls.some(call => call.method === "turn/start"), false);
    } finally { service.dispose(); }
  }
});

test("installed runtime identity establishes deny configuration even when public App listing returns 403", async () => {
  const { service, rpc } = brokerAppFixture({ appsError: true });
  try {
    await service.prepare();
    await service.refreshInventory();
    assert.equal(service.status().readOnlyGuardReady, true);
    assert.match(service.capabilities().inventory.apps.error, /403 Forbidden/);
    assertBrokerAppOverrides(rpc.calls.find(call => call.method === "thread/start").params.config);
    assert.deepEqual(service.capabilities().readOnlyGuard.residualTools, []);
  } finally { service.dispose(); }
});

test("failed per-thread catalog reads remain fail-closed despite a valid cold configuration receipt", async () => {
  for (const options of [{ verificationError: true }]) {
    const { service, rpc } = brokerAppFixture(options);
    try {
      await service.prepare();
      await service.refreshInventory();
      assert.equal(service.status().readOnlyGuardReady, false);
      assert.ok(service.capabilities().readOnlyGuard.configurationReceipt);
      await assert.rejects(service.analyze({ portfolio: portfolioFixture(), run: runFixture(), task: "不可绕过服务端回读" }), { kind: "read_only_guard" });
      assert.equal(rpc.calls.some(call => call.method === "turn/start"), false);
      assert.equal(rpc.calls.some(call => call.method === "turn/interrupt"), false);
    } finally { service.dispose(); }
  }
});

test("a new broker write discovered during Skill preparation blocks the turn without hot resume", async () => {
  const { service, rpc } = brokerAppFixture({ exposeWrites: false });
  try {
    await service.prepare();
    await service.refreshInventory();
    let releaseFingerprint;
    service.fingerprintSkills = () => new Promise(resolve => { releaseFingerprint = () => resolve([]); });
    const analysis = service.analyze({ portfolio: portfolioFixture(), run: runFixture(), task: "等待本地 Skill 元数据" });
    await waitUntil(() => Boolean(releaseFingerprint));
    rpc.fixture.exposeWrites = true;
    await service.refreshInventory({ forceReload: true });
    releaseFingerprint();
    await assert.rejects(analysis, { kind: "read_only_guard" });
    assert.equal(rpc.calls.some(call => call.method === "turn/start"), false);
    assert.equal(service.status().readOnlyGuardReady, false);
    assert.equal(rpc.calls.some(call => call.method === "thread/resume"), false);
    assert.equal(rpc.calls.some(call => call.method === "turn/interrupt"), false);
  } finally { service.dispose(); }
});

test("restarting the App Server invalidates former App policy proofs and re-verifies new configuration", async () => {
  const { service, rpc } = brokerAppFixture();
  try {
    await service.prepare();
    await service.refreshInventory();
    assert.equal(service.status().readOnlyGuardReady, true);
    const oldGeneration = service.rpcGeneration;
    rpc.ready = false;
    await service.prepare();
    await service.refreshInventory();
    assert.ok(service.rpcGeneration > oldGeneration);
    assert.equal(service.status().readOnlyGuardReady, true);
    assert.equal(service.capabilities().readOnlyGuard.configurationReceipt.origin, "cold_resume");
    assert.equal(service.capabilities().readOnlyGuard.configurationReceipt.generation, service.rpcGeneration);
    assert.equal(rpc.calls.some(call => call.method === "turn/start"), false);
  } finally { service.dispose(); }
});

test("a reconnect that is transport-ready still gates analysis until thread configuration finishes", async () => {
  const { service, rpc } = brokerAppFixture();
  try {
    await service.prepare();
    await service.refreshInventory();
    rpc.ready = false;
    rpc.fixture.verificationError = true;
    rpc.fixture.deferConfig = true;
    const restart = service.prepare();
    await waitUntil(() => Boolean(rpc.releaseConfig));
    assert.equal(rpc.ready, true);
    assert.equal(service.status().readOnlyGuardReady, false);
    const rejected = assert.rejects(service.analyze({ portfolio: portfolioFixture(), run: runFixture(), task: "重连中不得抢跑" }), { kind: "read_only_guard" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(rpc.calls.some(call => call.method === "turn/start"), false);
    rpc.releaseConfig();
    await restart;
    await rejected;
    assert.equal(service.status().readOnlyGuardReady, false);
  } finally { service.dispose(); }
});

test("broker App policy discovery never resumes or interrupts an already active turn", async () => {
  const { service, rpc } = brokerAppFixture({ exposeWrites: false });
  try {
    await service.prepare();
    await service.refreshInventory();
    const threadId = service.threadId;
    const analysis = service.analyze({ portfolio: portfolioFixture(), run: runFixture(), task: "已有研究" });
    await waitUntil(() => rpc.calls.some(call => call.method === "turn/start"));
    rpc.fixture.exposeWrites = true;
    await service.refreshInventory({ forceReload: true });
    assert.equal(service.status().readOnlyGuardReady, false);
    assert.equal(rpc.calls.some(call => call.method === "thread/resume" || call.method === "turn/interrupt"), false);
    rpc.completeThread(threadId, "原轮正常结束");
    assert.equal((await analysis).text, "原轮正常结束");
    await service.refreshInventory({ forceReload: true });
    assert.equal(service.status().readOnlyGuardReady, false);
    assert.equal(rpc.calls.filter(call => call.method === "thread/resume").length, 0);
  } finally { service.dispose(); }
});

test("new sessions get fresh own-thread proofs while hot resume cannot bless a previously unguarded loaded thread", async () => {
  const { service, rpc } = brokerAppFixture({ exposeWrites: false });
  try {
    await service.prepare();
    await service.refreshInventory();
    const oldThread = service.threadId;
    const other = await service.createSession({ name: "第二个研究" });
    await service.refreshInventory({ threadId: other.id });
    rpc.fixture.exposeWrites = true;
    await service.refreshInventory({ forceReload: true, threadId: other.id });
    assert.equal(service.status().readOnlyGuardReady, false);
    assert.equal(rpc.configs.get(oldThread).apps.asdk_app_fixture_ibkr, undefined);
    await assert.rejects(service.analyze({ portfolio: portfolioFixture(), run: runFixture(), task: "旧线程也需隔离", threadId: oldThread }), { kind: "read_only_guard" });
    const created = await service.createSession({ name: "新研究继承约束" });
    assertBrokerAppOverrides(rpc.configs.get(created.id));
    await service.refreshInventory({ threadId: created.id });
    assert.equal(service.status().readOnlyGuardReady, true);
    assert.equal(service.capabilities().readOnlyGuard.configurationReceipt.origin, "start");
    await service.switchSession(other.id);
    const resumed = rpc.calls.filter(call => call.method === "thread/resume" && call.params.threadId === other.id).at(-1);
    assertBrokerAppOverrides(resumed.params.config);
    await service.refreshInventory({ threadId: other.id });
    assert.equal(service.status().readOnlyGuardReady, false);
    assert.equal(rpc.configs.get(other.id).apps.asdk_app_fixture_ibkr, undefined, "upstream hot resume ignores the new config");
    assert.equal(rpc.calls.some(call => call.method === "turn/start"), false);
  } finally { service.dispose(); }
});

test("new App writes and opaque broker operations fail closed in the fresh pre-turn scan", async () => {
  for (const operation of ["place_bracket_order", "dispatch"]) {
    const { service, rpc } = brokerAppFixture();
    try {
      await service.prepare();
      await service.refreshInventory();
      assert.equal(service.status().readOnlyGuardReady, true);
      rpc.fixture.extraWrites = [operation];
      await assert.rejects(service.analyze({ portfolio: portfolioFixture(), run: runFixture(), task: "不得借用缓存" }), { kind: "read_only_guard" });
      assert.deepEqual(service.capabilities().readOnlyGuard.residualTools, [{ server: "codex_apps", tool: `interactive_brokers_ibkr.${operation}` }]);
      assert.equal(rpc.calls.some(call => call.method === "turn/start" || call.method === "thread/resume"), false);
    } finally { service.dispose(); }
  }
});

test("a late thread/start response only receipts its immutable submitted policy, not a newer parallel policy", async () => {
  const { service, rpc } = brokerAppFixture();
  try {
    await service.prepare();
    await service.refreshInventory();
    const firstRevision = service.brokerAppGuardRevision;
    rpc.fixture.deferNextStart = true;
    const olderStart = service.createSession({ name: "先发出的对话" });
    await waitUntil(() => Boolean(rpc.releaseStart));
    rpc.fixture.extraWrites = ["place_bracket_order"];
    const newer = await service.createSession({ name: "更新后的对话" });
    await service.refreshInventory({ threadId: newer.id });
    assert.equal(service.status().readOnlyGuardReady, true);
    rpc.releaseStart();
    const older = await olderStart;
    await service.refreshInventory({ threadId: older.id });
    assert.equal(service.threadBrokerConfigReceipts.get(older.id).revision, firstRevision);
    assert.ok(service.threadBrokerConfigReceipts.get(newer.id).revision > firstRevision);
    assert.equal(rpc.configs.get(older.id).apps.asdk_app_fixture_ibkr.tools.place_bracket_order, undefined);
    assert.equal(service.status().readOnlyGuardReady, false);
    await assert.rejects(service.analyze({ portfolio: portfolioFixture(), run: runFixture(), task: "旧配置不能冒充新配置" }), { kind: "read_only_guard" });
  } finally { service.dispose(); }
});

test("an actually unloaded owned thread gets a new cold-resume receipt and its own fresh catalog scan", async () => {
  const { service, rpc } = brokerAppFixture();
  try {
    await service.prepare();
    await service.refreshInventory();
    const old = service.threadId;
    await service.createSession({ name: "旁边的对话" });
    rpc.loaded.delete(old);
    rpc.options.onNotification({ method: "thread/closed", params: { threadId: old } });
    assert.equal(service.threadBrokerConfigReceipts.has(old), false);
    await service.switchSession(old);
    await service.refreshInventory({ threadId: old });
    assert.equal(service.status().readOnlyGuardReady, true);
    assert.equal(service.capabilities().readOnlyGuard.configurationReceipt.origin, "cold_resume");
    assertBrokerAppOverrides(rpc.configs.get(old));
  } finally { service.dispose(); }
});

test("a newly named Longbridge order-write tool fails closed even on a configured guarded server", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new GuardedNovelWriteRpc(options),
  });
  await service.prepare();
  await service.refreshInventory();

  assert.equal(service.status().readOnlyGuardReady, false);
  assert.deepEqual(service.capabilities().readOnlyGuard.residualTools, [{
    server: "broker_data",
    tool: "submit_bracket_order",
  }]);
  await assert.rejects(service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "只读分析",
  }), /尚未被线程配置禁用的交易写能力/);
  service.dispose();
});

test("an unknown Longbridge tool fails closed even when the server labels it read-only", async () => {
  const blocked = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new GuardedUnknownToolRpc(options),
  });
  await blocked.prepare();
  await blocked.refreshInventory();
  assert.equal(blocked.status().readOnlyGuardReady, false);
  assert.deepEqual(blocked.capabilities().readOnlyGuard.residualTools, [{
    server: "broker_data",
    tool: "buy_stock",
  }]);
  await assert.rejects(blocked.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "只读分析",
  }), /尚未被线程配置禁用的交易写能力/);
  blocked.dispose();
});

test("guarded IBKR execution tools stay hidden while position and option queries run", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    rpcFactory: (options) => new ConfigurableBrokerRpc(options, { name: "ibkr", guarded: true,
      tools: ["reqPositions", "get_option_chain", "account_summary", "placeOrder", "exerciseOptions", "transfer_funds"] }),
  });
  try {
    await service.prepare();
    await service.refreshInventory();
    assert.equal(service.status().readOnlyGuardReady, true);
    assert.deepEqual(service.capabilities().mcpServers[0].tools.map((item) => item.name),
      ["reqPositions", "get_option_chain", "account_summary"]);
    const analysis = await service.analyze({ portfolio: portfolioFixture(), run: runFixture(), task: "研究期权与持仓" });
    assert.equal(analysis.text, "持久 Codex 已结合 MCP 完成分析。");
    assert.match(service.capabilities().readOnlyGuard.limitations.join(" "), /Not a universal/);
  } finally { service.dispose(); }
});

test("unknown transaction MCPs and unlisted broker aliases fail closed before a turn starts", async () => {
  for (const fixture of [
    { name: "unknown-venue", guarded: false, tools: ["submit_order", "place_order", "modify_order", "cancel_order", "exercise_option", "transfer_funds"] },
    { name: "ibkr", guarded: true, tools: ["SubmitOrder"] },
  ]) {
    const service = new CodexWorkspaceService({
      codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
      rpcFactory: (options) => new ConfigurableBrokerRpc(options, fixture),
    });
    try {
      await service.prepare();
      await service.refreshInventory();
      assert.equal(service.status().readOnlyGuardReady, false);
      assert.equal(service.capabilities().readOnlyGuard.residualTools.length, fixture.tools.length);
      await assert.rejects(service.analyze({ portfolio: portfolioFixture(), run: runFixture(), task: "只读研究" }),
        (error) => error.kind === "read_only_guard");
      assert.equal(service.rpc.calls.some((call) => call.method === "turn/start"), false);
    } finally { service.dispose(); }
  }
});

test("ordinary research task cancellation is not mistaken for brokerage execution", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    rpcFactory: (options) => new ConfigurableBrokerRpc(options, { name: "research", guarded: false,
      tools: ["cancel_task", "create_note", "transfer_file", "search_web"] }),
  });
  try {
    await service.prepare();
    const analysis = await service.analyze({ portfolio: portfolioFixture(), run: runFixture(), task: "研究资料" });
    assert.ok(analysis.text);
    assert.equal(service.capabilities().mcpServers[0].tools.length, 4);
  } finally { service.dispose(); }
});

test("Codex workspace resumes the saved project thread after an app restart", async () => {
  const store = new MemoryStore();
  const firstInstances = [];
  const first = createService({ store, rpcInstances: firstInstances });
  await first.prepare();
  first.dispose();

  const secondInstances = [];
  const second = createService({ store, rpcInstances: secondInstances });
  await second.prepare();
  assert.equal(secondInstances[0].calls.some((call) => call.method === "thread/resume"), true);
  assert.equal(secondInstances[0].calls.some((call) => call.method === "thread/start"), false);
  assert.equal(second.status().threadId, "thr-persistent-1");
});

test("App-owned Codex sessions can be created, listed, switched, and persist the active pointer", async () => {
  const store = new MemoryStore();
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new MultiSessionRpc(options);
      return rpc;
    },
  });
  await service.prepare();

  const created = await service.createSession({ name: "候选股计划" });
  assert.equal(created.id, "thr-session-2");
  assert.equal(created.name, "候选股计划");
  assert.equal(created.current, true);
  assert.equal(rpc.calls.some((call) => call.method === "thread/name/set"
    && call.params.threadId === "thr-session-2"
    && call.params.name === "候选股计划"), true);

  const listed = await service.listSessions();
  assert.equal(listed.currentThreadId, "thr-session-2");
  assert.deepEqual(listed.sessions.map((session) => session.id), [
    "thr-session-2",
    "thr-session-1",
  ]);
  assert.deepEqual(Object.keys(listed.sessions[0]).sort(), [
    "createdAt",
    "current",
    "id",
    "name",
    "operationId",
    "preview",
    "researchBinding",
    "researchContext",
    "reviewBinding",
    "reviewContext",
    "runState",
    "toolMode",
    "updatedAt",
  ]);

  rpc.turns.set("thr-session-1", [historyTurn(
    "turn-opened",
    Math.floor(Date.now() / 1_000),
    "继续分析这段原对话",
  )]);
  const switched = await service.openSession("thr-session-1");
  assert.equal(switched.id, "thr-session-1");
  assert.match(JSON.stringify(switched.transcript), /继续分析这段原对话/);
  assert.equal(rpc.calls.some((call) => call.method === "thread/turns/list"
    && call.params.threadId === "thr-session-1"), false);
  assert.equal(rpc.calls.some((call) => call.method === "thread/resume"
    && call.params.threadId === "thr-session-1"
    && call.params.initialTurnsPage.itemsView === "summary"
    && call.params.dynamicTools[0].name === "query_recent_history"), true);
  assert.equal((await store.get("codexWorkspaceThread")).threadId, "thr-session-1");
  assert.equal(service.status().threadName, "交易驾驶舱 Agent");
  service.dispose();
});

test("opening an exact session falls back to the encrypted local transcript when live hydration fails", async () => {
  const store = new MemoryStore();
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new HistoryHydrationFailureRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  await service.createSession({ name: "另一个会话" });
  const now = Math.floor(Date.now() / 1_000);
  await store.set("codexWorkspaceRecentHistoryIndex", {
    version: 1,
    updatedAt: new Date().toISOString(),
    threads: [{
      id: "thr-session-1",
      name: "交易驾驶舱 Agent",
      createdAt: new Date((now - 60) * 1_000).toISOString(),
      updatedAt: new Date(now * 1_000).toISOString(),
      recencyAt: new Date(now * 1_000).toISOString(),
      turns: [historyTurn("cached-turn", now, "缓存中的原问题", "缓存中的原回答")],
    }],
  });

  const opened = await service.openSession("thr-session-1");
  assert.equal(opened.id, "thr-session-1");
  assert.match(JSON.stringify(opened.transcript), /缓存中的原问题/);
  assert.match(JSON.stringify(opened.transcript), /缓存中的原回答/);
  assert.equal(rpc.calls.some((call) => call.method === "thread/turns/list"
    && call.params.itemsView === "summary"
    && call.params.limit === 30), true);
  service.dispose();
});

test("pre-analysis work persists the user question before an App Server turn exists", async () => {
  const store = new MemoryStore();
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new MultiSessionRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  await service.createSession({ name: "前置计算会话" });
  await service.cachePendingUserMessage({
    threadId: "thr-session-1",
    operationId: "operation-preflight",
    text: "刷新持仓前就要保存这条问题",
  });
  assert.equal(service.status().activeCount, 0);
  const listing = await service.listSessions();
  assert.equal(listing.sessions.find((item) => item.id === "thr-session-1").runState, "running");
  const opened = await service.openSession("thr-session-1");
  assert.match(JSON.stringify(opened.transcript), /刷新持仓前就要保存这条问题/);
  assert.equal(rpc.calls.some((call) => call.method === "thread/turns/list"
    && call.params.threadId === "thr-session-1"), false);
  assert.equal(service.clearPendingOperation({
    threadId: "thr-session-1",
    operationId: "operation-preflight",
  }), true);
  service.dispose();
});

test("session switching accepts only the encrypted app registry and remains available during a turn", async () => {
  const store = new MemoryStore();
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new MultiSessionRpc(options, { hangingTurns: true });
      return rpc;
    },
  });
  await service.prepare();

  await assert.rejects(service.switchSession("thr-unregistered"), /不属于交易驾驶舱/);
  assert.equal(rpc.calls.some((call) => call.method === "thread/resume"
    && call.params.threadId === "thr-unregistered"), false);

  const analysis = service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "保持运行以验证会话锁",
  });
  await waitUntil(() => rpc.calls.some((call) => call.method === "turn/start"));
  const created = await service.createSession({ name: "并行会话" });
  assert.equal(created.id, "thr-session-2");
  const switched = await service.openSession("thr-session-1");
  assert.equal(switched.id, "thr-session-1");
  assert.match(JSON.stringify(switched.transcript), /保持运行以验证会话锁/);
  assert.equal(rpc.calls.some((call) => call.method === "thread/turns/list"
    && call.params.threadId === "thr-session-1"), false);
  assert.equal(rpc.calls.filter((call) => call.method === "thread/start").length, 2);
  await service.cancel({ threadId: "thr-session-1" });
  await assert.rejects(analysis, /已取消/);
  service.dispose();
});

test("one App Server connection runs different Codex threads concurrently and settles each independently", async () => {
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => {
      rpc = new MultiSessionRpc(options, { hangingTurns: true });
      return rpc;
    },
  });
  await service.prepare();
  await service.createSession({ name: "第二会话" });

  const first = service.analyze({
    portfolio: portfolioFixture(), run: runFixture(), task: "第一条并发分析",
    threadId: "thr-session-1", operationId: "operation-first",
  });
  const second = service.analyze({
    portfolio: portfolioFixture(), run: runFixture(), task: "第二条并发分析",
    threadId: "thr-session-2", operationId: "operation-second",
  });
  await waitUntil(() => rpc.calls.filter((call) => call.method === "turn/start").length === 2);
  assert.equal(service.status().activeCount, 2);
  assert.deepEqual(new Set(service.status().activeThreads.map((item) => item.threadId)), new Set([
    "thr-session-1", "thr-session-2",
  ]));
  const listed = await service.listSessions();
  assert.equal(listed.sessions.every((session) => session.runState === "running"), true);

  rpc.completeThread("thr-session-1", "第一条完成");
  assert.equal((await first).text, "第一条完成");
  assert.equal(service.status().activeCount, 1);
  assert.equal(service.status().activeThreads[0].threadId, "thr-session-2");

  rpc.completeThread("thr-session-2", "第二条完成");
  assert.equal((await second).text, "第二条完成");
  assert.equal(service.status().activeCount, 0);
  service.dispose();
});

test("turn input attaches real Skill and App references while MCP and tool events remain enabled", async () => {
  const store = new MemoryStore();
  const rpcInstances = [];
  const stream = [];
  const service = createService({ store, rpcInstances, onStream: (event) => stream.push(event) });
  await service.prepare();
  const analysis = await service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "$technical-structure $research-app @market/quote 完整分析",
  });

  const turn = rpcInstances[0].calls.find((call) => call.method === "turn/start");
  assert.equal("outputSchema" in turn.params, false);
  assert.equal(turn.params.input.some((item) => item.type === "skill"
    && item.name === "technical-structure"), true);
  assert.equal(turn.params.input.some((item) => item.type === "mention"
    && item.path === "app://research-app"), true);
  assert.equal(turn.params.additionalContext["trading-cockpit-evidence"].kind, "application");
  const cockpitContexts = Object.entries(turn.params.additionalContext)
    .filter(([key]) => key.startsWith("trading-cockpit-evidence"));
  const cockpitPayload = cockpitContexts.map(([, value]) => value.value).join("\n");
  assert.match(cockpitPayload, /"weightPercent":12/);
  assert.doesNotMatch(
    cockpitPayload,
    /netAssets|accountId|oauth|accessToken/i,
  );
  assert.ok(cockpitContexts.length > 4);
  assert.ok(cockpitContexts.every(([, value]) => value.value.length <= 3_000));
  assert.ok(cockpitContexts.some(([key]) => key.startsWith("trading-cockpit-evidence-price-bars")));
  assert.ok(Object.keys(turn.params.additionalContext)
    .some((key) => /^trading-cockpit-context-manifest(?:-\d+)?$/.test(key)));
  assert.equal(analysis.contextDiagnostics.deliveryStatus, "complete");
  assert.equal(analysis.contextDiagnostics.totalBlockCount, Object.keys(turn.params.additionalContext).length);
  assert.equal(analysis.persistent, true);
  assert.equal(analysis.ephemeral, false);
  assert.equal(analysis.toolsUsed, true);
  assert.equal(analysis.text, "持久 Codex 已结合 MCP 完成分析。");
  assert.equal(Number.isFinite(analysis.firstActivityMs), true);
  assert.equal(stream.some((event) => event.kind === "text_delta"), true);
  assert.equal(stream.some((event) => event.kind === "tool" && /market\.quote/.test(event.label)), true);
});

test("workspace analysis replaces local narration but preserves deterministic numeric cards", () => {
  const run = runFixture();
  const enriched = applyCodexWorkspaceAnalysis(run, {
    text: "# 结构需要确认\n\n结合持仓与工具数据，先观察确认条件。",
    provider: "Codex App Server",
    elapsedMs: 1_200,
    persistent: true,
    ephemeral: false,
    threadId: "thr-persistent-1",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    requestedSkills: [],
    requestedApps: [],
    toolEvents: [],
    toolsUsed: false,
    skillCount: 1,
    mcpServerCount: 1,
    appCount: 1,
    tokenUsage: null,
    contextDiagnostics: {
      deliveryStatus: "complete",
      silentlyTruncated: false,
      bundleHash: "sha256:test",
      totalBlockCount: 12,
      totalUtf8Bytes: 24_000,
      semanticOmissions: [],
    },
    additionalContextContract: { status: "verified" },
    serverUserAgent: "codex-test/1.0",
  });
  assert.equal(enriched.conclusion.headline, "结构需要确认");
  assert.equal(enriched.technical.ema[21], 98);
  assert.equal(enriched.plan.scenarios[0].if, "收复 EMA21");
  assert.equal(enriched.safeguards.modelSession, "persistent");
  assert.equal(enriched.safeguards.modelTools, true);
  assert.equal(enriched.modelAnalysis.contextDiagnostics.silentlyTruncated, false);
  assert.equal(enriched.modelAnalysis.additionalContextContract.status, "verified");
  assert.equal(enriched.modelAnalysis.serverUserAgent, "codex-test/1.0");
  assert.match(enriched.evidence.at(-1).summary, /上下文 12 块\/24000 bytes/);
});

test("skill reproducibility distinguishes stable, changed, and unverified local snapshots", () => {
  const before = [{ name: "test-skill", contentHash: "sha256:one", entrypointHash: "sha256:entry", status: "verified" }];
  assert.equal(compareSkillVersions(before, structuredClone(before)).status, "verified");
  const changed = compareSkillVersions(before, [{ ...before[0], contentHash: "sha256:two" }]);
  assert.equal(changed.status, "changed_during_run");
  assert.deepEqual(changed.changedSkills, ["test-skill"]);
  assert.equal(compareSkillVersions([{ name: "test-skill", status: "unavailable" }],
    [{ name: "test-skill", status: "unavailable" }]).status, "unverified");
});

test("a skill change during analysis preserves the answer and records both versions without adding file contents", async () => {
  let fingerprintCount = 0;
  const statuses = [];
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    rpcFactory: (options) => new FakeRpc(options),
    onStatus: (event) => statuses.push(event),
    fingerprintSkills: async (skills) => {
      fingerprintCount += 1;
      return skills.map((skill) => ({ name: skill.name, status: "verified",
        contentHash: `sha256:version-${fingerprintCount}`, entrypointHash: "sha256:entry",
        files: [{ path: "references/rule.md", sha256: `sha256:version-${fingerprintCount}` }],
      }));
    },
  });
  try {
    await service.prepare();
    const analysis = await service.analyze({ portfolio: portfolioFixture(), run: runFixture(), task: "分析持仓" });
    assert.equal(fingerprintCount, 2);
    assert.ok(analysis.text);
    assert.equal(analysis.skillReproducibility.status, "changed_during_run");
    assert.ok(statuses.some((event) => event.phase === "codex_skill_version_changed"));
    assert.equal(analysis.actualSkillVersions[0].contentHash, "sha256:version-1");
    assert.equal(analysis.postRunSkillVersions[0].contentHash, "sha256:version-2");
    const turn = service.rpc.calls.find((call) => call.method === "turn/start");
    const sent = JSON.stringify(turn.params.additionalContext);
    assert.ok(sent.includes("sha256:version-1"));
    assert.ok(!sent.includes("sha256:version-2"));
    assert.ok(!sent.includes("references/rule.md"), "only compact hashes enter model context");
    const enriched = applyCodexWorkspaceAnalysis(runFixture(), analysis);
    assert.deepEqual(enriched.modelAnalysis.actualSkillVersions, analysis.actualSkillVersions);
    assert.deepEqual(enriched.modelAnalysis.postRunSkillVersions, analysis.postRunSkillVersions);
    assert.equal(enriched.modelAnalysis.skillReproducibility.status, "changed_during_run");
    assert.equal(enriched.evidence.at(-1).skillVersions[0].contentHash, "sha256:version-1");
  } finally { service.dispose(); }
});

test("candidate LLM sizing is accepted subject only to validated risk envelopes", () => {
  const run = candidateRunFixture();
  const enriched = applyCodexWorkspaceAnalysis(run, {
    text: "# 候选复核\n\n半导体主题接近上限，初始只允许 1%。",
    candidateSizing: {
      candidateGroupKey: "半导体",
      classificationConfidence: "high",
      narrativeStage: "stage_2",
      fibReview: {
        decision: "ignore",
        direction: "none",
        anchors: { a: null, b: null, c: null },
        emphasizedRatios: [],
        confidence: "medium",
        rationale: "本轮失效依据使用 EMA21，不采用自动 Fib。",
      },
      invalidation: {
        kind: "ema",
        barId: null,
        field: null,
        emaPeriod: 21,
        rangeKey: null,
        fibRatio: null,
        confirmation: "日线收盘",
        rationale: "EMA21 为结构失效位。",
      },
      holdingHorizon: "swing",
      stressTest: {
        kind: "gap_down",
        lossPercent: 12,
        slippagePercent: 0.5,
        rationale: "按隔夜跳空与退出滑点压力测试。",
      },
      recommendedInitialAdditionalWeightPercent: 2,
      recommendedMaxTotalWeightPercent: 9,
      sizingConfidence: "high",
      leverageDecision: "cash_only",
      rationale: "半导体主题现有 29%，主题预警线为 30%。",
    },
    provider: "Codex App Server",
    elapsedMs: 100,
    threadId: "thr-persistent-1",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    requestedSkills: ["analyze-market-narratives"],
    requestedApps: [],
    toolEvents: [{ type: "mcpToolCall" }],
    toolsUsed: true,
    skillCount: 2,
    mcpServerCount: 1,
    appCount: 0,
    tokenUsage: null,
  });

  assert.equal(enriched.risk.sizingReview.status, "bounded");
  assert.equal(enriched.risk.group, "半导体");
  assert.equal(enriched.risk.recommendedInitialAdditionalWeightPercent, 1);
  assert.equal(enriched.risk.recommendedMaxWeightPercent, 1);
  assert.equal(enriched.risk.recommendedInitialNotionalBase, 1_000);
  assert.equal(enriched.risk.recommendedMaxAdditionalNotionalBase, 1_000);
  assert.equal(enriched.risk.leverage.decision, "cash_only");
  assert.equal(enriched.risk.referenceLabel, "EMA21");
  assert.deepEqual(enriched.risk.sizingReview.limitBindings, [
    "group_exposure",
    "stress_risk_budget",
    "initial_additional",
  ]);
  assert.equal(enriched.risk.stressRiskLossPercent, 12);
  assert.equal(enriched.risk.sizingReview.accepted.stressRiskLossPercent, 12);
  assert.equal(enriched.risk.sizingReview.modelProposal.maxTotalWeightPercent, 9);
  assert.equal(enriched.risk.sizingReview.accepted.maxTotalWeightPercent, 1);
  assert.equal(enriched.risk.sizingReview.numericClaimAuditStatus, "verified");
  assert.equal(enriched.risk.sizingReview.executionAuthorized, true);
  assert.equal(enriched.analysisContext.numericClaimAudit.status, "verified");
  assert.equal(enriched.analysisContext.numericClaimAudit.naturalLanguageInspected, false);
  assert.match(enriched.conclusion.body, /NUMERIC AUTHORITY · VERIFIED/);
  assert.match(enriched.conclusion.body, /LLM PROPOSAL：初始 2% · 最大 9%/);
  assert.match(enriched.conclusion.body, /HOST ACCEPTED：初始 1% · 最大 1%/);
  assert.match(enriched.conclusion.body, /Codex 分析 · NARRATIVE ONLY/);
  assert.equal(enriched.plan.sizing.maxTotalWeightPercent, 1);
  assert.match(enriched.plan.scenarios[0].then, /初始新增 1%/);
  const sizingFacts = enriched.analysisContext.numericEvidence.facts.filter((fact) => (
    fact.metric.startsWith("candidate.sizing.")
  ));
  assert.ok(sizingFacts.some((fact) => fact.kind === "model_proposal"
    && fact.metric === "candidate.sizing.model_max_total_weight_percent"
    && fact.value === "9"));
  const acceptedMax = sizingFacts.find((fact) => (
    fact.metric === "candidate.sizing.accepted_max_total_weight_percent"
  ));
  assert.equal(acceptedMax.kind, "host_decision");
  assert.equal(acceptedMax.value, "1");
  assert.ok(acceptedMax.provenance.inputRefs.some((ref) => (
    ref.factId.includes("candidate.sizing.model_max_total_weight_percent")
  )));
  const factFor = (metric) => sizingFacts.find((fact) => fact.metric === metric);
  const references = (fact, input) => fact.provenance.inputRefs.some((ref) => (
    ref.factId === input.factId && ref.hash === input.hash
  ));
  const marketClose = enriched.analysisContext.numericEvidence.facts.find((fact) => (
    fact.metric === "market.last_completed_close"
  ));
  const modelSlippage = factFor("candidate.sizing.model_exit_slippage_percent");
  const modelStress = factFor("candidate.sizing.model_stress_loss_percent");
  const acceptedReference = factFor(
    "candidate.sizing.accepted_invalidation_reference_price",
  );
  const riskDistance = factFor(
    "candidate.sizing.validated_invalidation_distance_percent",
  );
  const plannedRisk = factFor("candidate.sizing.accepted_planned_risk_loss_percent");
  const stressRisk = factFor("candidate.sizing.accepted_stress_risk_loss_percent");
  const acceptedInitial = factFor(
    "candidate.sizing.accepted_initial_additional_weight_percent",
  );
  assert.equal(modelSlippage.value, "0.5");
  assert.ok(references(acceptedReference, marketClose));
  assert.ok(references(riskDistance, marketClose));
  assert.ok(references(riskDistance, acceptedReference));
  assert.ok(references(plannedRisk, riskDistance));
  assert.ok(references(plannedRisk, modelSlippage));
  assert.ok(references(stressRisk, plannedRisk));
  assert.ok(references(stressRisk, modelStress));
  assert.ok(references(acceptedMax, stressRisk));
  assert.ok(references(acceptedInitial, acceptedMax));
});

test("candidate Markdown cannot override the audited host sizing decision", () => {
  const analysis = candidateWorkspaceAnalysis();
  analysis.text = [
    "# 候选结论",
    "",
    "HOST ACCEPTED 99%，立即满仓。",
  ].join("\n");
  const enriched = applyCodexWorkspaceAnalysis(candidateRunFixture(), analysis);

  assert.equal(enriched.analysisContext.numericClaimAudit.status, "verified");
  assert.equal(enriched.analysisContext.numericClaimAudit.naturalLanguageInspected, false);
  assert.equal(enriched.risk.recommendedInitialAdditionalWeightPercent, 1);
  assert.equal(enriched.risk.recommendedMaxWeightPercent, 1);
  assert.equal(enriched.risk.sizingReview.executionAuthorized, true);
  assert.doesNotMatch(enriched.conclusion.body, /HOST ACCEPTED 99%/);
  assert.match(enriched.conclusion.body, /MODEL NARRATIVE 99%/);
  assert.ok(enriched.conclusion.body.indexOf("NUMERIC AUTHORITY · VERIFIED")
    < enriched.conclusion.body.indexOf("MODEL NARRATIVE 99%"));
  assert.match(enriched.conclusion.body, /Codex 分析 · NARRATIVE ONLY/);
});

test("a failed numeric claim audit closes sizing and the candidate plan", () => {
  const run = candidateRunFixture();
  run.analysisContext.numericEvidence = {
    ...run.analysisContext.numericEvidence,
    facts: run.analysisContext.numericEvidence.facts.map((fact) => ({
      ...fact,
      hash: `sha256:${"0".repeat(64)}`,
    })),
  };
  const enriched = applyCodexWorkspaceAnalysis(run, candidateWorkspaceAnalysis());

  assert.equal(enriched.analysisContext.numericClaimAudit.status, "failed");
  assert.equal(enriched.analysisContext.numericClaimAudit.executionAuthorized, false);
  assert.equal(enriched.risk.entryAllowed, false);
  assert.equal(enriched.risk.recommendedInitialAdditionalWeightPercent, 0);
  assert.equal(enriched.risk.recommendedMaxAdditionalWeightPercent, 0);
  assert.equal(enriched.risk.recommendedMaxWeightPercent, 0);
  assert.equal(enriched.risk.sizingReview.accepted.initialAdditionalWeightPercent, 0);
  assert.equal(enriched.risk.sizingReview.accepted.maxTotalWeightPercent, 0);
  assert.equal(enriched.risk.leverage.decision, "disabled");
  assert.equal(enriched.risk.sizingReview.status, "blocked");
  assert.equal(enriched.risk.sizingReview.preNumericAuditStatus, "llm_reviewed");
  assert.equal(enriched.risk.sizingReview.executionAuthorized, false);
  assert.equal(enriched.plan.state, "candidate_blocked");
  assert.equal(enriched.plan.riskSizingAvailable, false);
  assert.equal(enriched.plan.sizing.initialAdditionalWeightPercent, 0);
  assert.equal(enriched.plan.sizing.maxAdditionalWeightPercent, 0);
  assert.match(enriched.conclusion.body, /NUMERIC AUTHORITY · FAILED/);
  assert.match(enriched.risk.entryBlockReasons.join(" "), /Numeric Evidence 审计未通过/);
});

test("explicit margin_within_cap can use buying power but never exceed 150 percent gross", () => {
  const run = candidateRunFixture();
  run.risk.cashConstrainedWeightPercent = 0;
  run.risk.hardMaxAdditionalWeightPercent = 1;
  run.risk.hardMaxTotalWeightPercent = 1;
  run.risk.portfolioConstraints.grossExposurePercent = 149;
  run.risk.portfolioConstraints.groupExposure.push({ key: "新主题", weight: 0 });
  const enriched = applyCodexWorkspaceAnalysis(
    run,
    candidateWorkspaceAnalysis({
      candidateGroupKey: "新主题",
      recommendedInitialAdditionalWeightPercent: 2,
      recommendedMaxTotalWeightPercent: 5,
      leverageDecision: "margin_within_cap",
    }),
  );

  assert.equal(enriched.risk.sizingReview.status, "bounded");
  assert.equal(enriched.risk.recommendedInitialAdditionalWeightPercent, 1);
  assert.equal(enriched.risk.recommendedMaxWeightPercent, 1);
  assert.equal(enriched.risk.leverage.decision, "margin_within_cap");
  assert.equal(enriched.risk.leverage.additionalLeverageAllowed, true);
  assert.equal(enriched.risk.leverage.maxAdditionalBorrowedWeightPercent, 1);
  assert.equal(enriched.risk.leverage.projectedGrossAtMaxPercent, 150);
  assert.ok(enriched.risk.sizingReview.limitBindings.includes("gross_exposure"));
});

test("candidate sizing remains research-only without an explicit stress path", () => {
  const run = candidateRunFixture();
  const enriched = applyCodexWorkspaceAnalysis(
    run,
    candidateWorkspaceAnalysis({
      holdingHorizon: "unknown",
      stressTest: {
        kind: "none",
        lossPercent: null,
        slippagePercent: null,
        rationale: "没有足够证据。",
      },
    }),
  );

  assert.equal(enriched.risk.sizingReview.status, "blocked");
  assert.equal(enriched.risk.entryAllowed, false);
  assert.equal(enriched.risk.recommendedInitialAdditionalWeightPercent, 0);
  assert.match(enriched.risk.sizingReview.rationale, /持有周期|压力损失|stress risk/);
});

test("margin_within_cap fails closed when buying power is not verifiable", () => {
  const run = candidateRunFixture();
  run.risk.cashConstrainedWeightPercent = 0;
  run.risk.buyPowerValid = false;
  run.risk.buyPowerWeightPercent = null;
  run.risk.leverage.marginEligible = false;
  run.risk.portfolioConstraints.groupExposure.push({ key: "新主题", weight: 0 });
  const enriched = applyCodexWorkspaceAnalysis(
    run,
    candidateWorkspaceAnalysis({
      candidateGroupKey: "新主题",
      recommendedInitialAdditionalWeightPercent: 2,
      recommendedMaxTotalWeightPercent: 5,
      leverageDecision: "margin_within_cap",
    }),
  );

  assert.equal(enriched.risk.sizingReview.status, "blocked");
  assert.equal(enriched.risk.leverage.additionalLeverageAllowed, false);
  assert.match(enriched.risk.sizingReview.rationale, /购买力/);
});

test("unmatched candidate themes use the worst existing theme exposure instead of zero", () => {
  const enriched = applyCodexWorkspaceAnalysis(
    candidateRunFixture(),
    candidateWorkspaceAnalysis({
      candidateGroupKey: "AI 芯片",
      recommendedInitialAdditionalWeightPercent: 2,
      recommendedMaxTotalWeightPercent: 9,
    }),
  );

  assert.equal(enriched.risk.candidateGroupKnown, false);
  assert.equal(enriched.risk.groupWeight, null);
  assert.equal(enriched.risk.sizingReview.groupMappingStatus, "unmatched_worst_case");
  assert.equal(enriched.risk.sizingReview.groupGuardrailWeightPercent, 29);
  assert.equal(enriched.risk.sizingReview.hardLimits.groupTotalWeightPercent, 1);
  assert.equal(enriched.risk.recommendedInitialAdditionalWeightPercent, 1);
  assert.equal(enriched.risk.recommendedMaxWeightPercent, 1);
  assert.equal(
    enriched.risk.sizingReview.limitBindings.includes("group_mapping_worst_case"),
    true,
  );
  assert.equal(
    enriched.risk.sizingReview.limitBindings.includes("group_exposure"),
    true,
  );
});

test("candidate sizing percentages reject coercion and out-of-range model values", () => {
  const invalidProposals = [
    { recommendedInitialAdditionalWeightPercent: "1" },
    { recommendedInitialAdditionalWeightPercent: true },
    { recommendedInitialAdditionalWeightPercent: [1] },
    { recommendedMaxTotalWeightPercent: 101 },
    { recommendedMaxTotalWeightPercent: -1 },
    { recommendedMaxTotalWeightPercent: Number.POSITIVE_INFINITY },
  ];

  for (const proposal of invalidProposals) {
    const enriched = applyCodexWorkspaceAnalysis(
      candidateRunFixture(),
      candidateWorkspaceAnalysis(proposal),
    );
    assert.equal(enriched.risk.sizingReview.status, "blocked");
    assert.equal(enriched.risk.sizingReview.accepted.initialAdditionalWeightPercent, 0);
    assert.match(enriched.risk.sizingReview.rationale, /完整有效/);
    for (const [key, value] of Object.entries(proposal)) {
      assert.equal(
        enriched.risk.sizingReview.modelProposal[
          key === "recommendedInitialAdditionalWeightPercent"
            ? "initialAdditionalWeightPercent"
            : "maxTotalWeightPercent"
        ],
        null,
        `${key}=${String(value)} must not be coerced or clamped`,
      );
    }
  }
});

test("candidate numeric evidence never coerces missing stress or invalidation values to zero", () => {
  for (const missing of [null, "", true, false]) {
    const run = candidateRunFixture();
    run.risk.riskBudgetPercent = missing;
    const analysis = candidateWorkspaceAnalysis({
      invalidation: {
        kind: "none",
        barId: null,
        field: null,
        emaPeriod: null,
        rangeKey: null,
        fibRatio: null,
        confirmation: "",
        rationale: "证据不足",
      },
      stressTest: {
        kind: "gap_down",
        lossPercent: missing,
        slippagePercent: missing,
        rationale: "缺少可核验压力参数",
      },
    });
    const enriched = applyCodexWorkspaceAnalysis(run, analysis);
    const sizingFacts = enriched.analysisContext.numericEvidence.facts.filter((fact) => (
      fact.metric.startsWith("candidate.sizing.")
    ));
    const metrics = new Map(sizingFacts.map((fact) => [fact.metric, fact]));

    assert.equal(metrics.has("candidate.sizing.model_stress_loss_percent"), false);
    assert.equal(metrics.has("candidate.sizing.model_exit_slippage_percent"), false);
    assert.equal(metrics.has("candidate.sizing.accepted_invalidation_reference_price"), false);
    assert.equal(metrics.has("candidate.sizing.validated_invalidation_distance_percent"), false);
    assert.equal(enriched.risk.sizingReview.hardLimits.riskBudgetTotalWeightPercent, null);
    assert.equal(enriched.risk.referenceLevel, null);
    assert.equal(enriched.risk.riskDistancePercent, null);
    assert.equal(enriched.risk.sizingReview.status, "blocked");
    assert.match(enriched.risk.sizingReview.rationale, /风险预算|压力损失|失效依据/);
  }
});

test("unknown narrative Stage blocks structured candidate sizing", () => {
  const enriched = applyCodexWorkspaceAnalysis(
    candidateRunFixture(),
    candidateWorkspaceAnalysis({ narrativeStage: "unknown" }),
  );

  assert.equal(enriched.risk.sizingReview.status, "blocked");
  assert.equal(enriched.risk.recommendedInitialAdditionalWeightPercent, 0);
  assert.match(enriched.risk.sizingReview.rationale, /叙事 Stage/);
});

test("Fib invalidation requires a selected Fib with medium or high confidence", () => {
  const unselected = applyCodexWorkspaceAnalysis(
    candidateRunFixture(),
    candidateWorkspaceAnalysis({
      invalidation: {
        kind: "fib",
        barId: null,
        field: null,
        emaPeriod: null,
        rangeKey: null,
        fibRatio: 0.618,
        confirmation: "日线收盘",
        rationale: "使用 Fib。",
      },
    }),
  );
  assert.equal(unselected.risk.sizingReview.status, "blocked");
  assert.match(unselected.risk.sizingReview.rationale, /先选择并通过宿主校验/);

  const lowConfidenceRun = candidateRunFixture();
  lowConfidenceRun.technical.fib = {
    direction: "up",
    anchors: {
      a: { date: "2026-06-01", price: 80 },
      b: { date: "2026-06-15", price: 110 },
      c: { date: "2026-07-01", price: 85 },
    },
    levels: { "0.382": 96.46, "0.618": 103.54, 1: 115, "1.618": 133.54 },
  };
  const lowConfidence = applyCodexWorkspaceAnalysis(
    lowConfidenceRun,
    candidateWorkspaceAnalysis({
      fibReview: {
        decision: "use_auto",
        direction: "up",
        anchors: { a: null, b: null, c: null },
        emphasizedRatios: [0.382],
        confidence: "low",
        rationale: "自动锚点只有低置信度。",
      },
      invalidation: {
        kind: "fib",
        barId: null,
        field: null,
        emaPeriod: null,
        rangeKey: null,
        fibRatio: 0.382,
        confirmation: "日线收盘",
        rationale: "使用 Fib。",
      },
    }),
  );
  assert.equal(lowConfidence.risk.sizingReview.status, "blocked");
  assert.match(lowConfidence.risk.sizingReview.rationale, /置信度不足/);
});

test("EMA144 and EMA169 invalidation require mature samples", () => {
  for (const period of [144, 169]) {
    const warmingRun = candidateRunFixture();
    warmingRun.technical.ema[period] = 90;
    warmingRun.technical.emaMaturity = {
      [period]: { mature: false, status: "warming" },
    };
    const warming = applyCodexWorkspaceAnalysis(
      warmingRun,
      candidateWorkspaceAnalysis({
        invalidation: {
          kind: "ema",
          barId: null,
          field: null,
          emaPeriod: period,
          rangeKey: null,
          fibRatio: null,
          confirmation: "日线收盘",
          rationale: `使用 EMA${period}。`,
        },
      }),
    );
    assert.equal(warming.risk.sizingReview.status, "blocked");
    assert.match(warming.risk.sizingReview.rationale, /尚未达到成熟样本要求/);

    const matureRun = candidateRunFixture();
    matureRun.technical.ema[period] = 90;
    matureRun.technical.emaMaturity = {
      [period]: { mature: true, status: "mature" },
    };
    const mature = applyCodexWorkspaceAnalysis(
      matureRun,
      candidateWorkspaceAnalysis({
        invalidation: {
          kind: "ema",
          barId: null,
          field: null,
          emaPeriod: period,
          rangeKey: null,
          fibRatio: null,
          confirmation: "日线收盘",
          rationale: `使用 EMA${period}。`,
        },
      }),
    );
    assert.notEqual(mature.risk.sizingReview.status, "blocked");
    assert.equal(mature.risk.referenceLabel, `EMA${period}`);
  }
});

test("candidate LLM can choose Fib anchors and sizing without a local 2/4 preset", () => {
  const run = candidateRunFixture();
  run.risk.portfolioConstraints.groupExposure.push({ key: "新主题", weight: 0 });
  run.analysisContext.technical.priceBars = [
    {
      barId: "2026-07-16T00:00:00.000Z",
      time: "2026-07-16T00:00:00.000Z",
      open: 83,
      high: 85,
      low: 80,
      close: 84,
      volume: 1_000,
    },
    {
      barId: "2026-07-17T00:00:00.000Z",
      time: "2026-07-17T00:00:00.000Z",
      open: 102,
      high: 120,
      low: 100,
      close: 115,
      volume: 2_000,
    },
    {
      barId: "2026-07-18T00:00:00.000Z",
      time: "2026-07-18T00:00:00.000Z",
      open: 98,
      high: 105,
      low: 90,
      close: 100,
      volume: 1_500,
    },
  ];
  const enriched = applyCodexWorkspaceAnalysis(run, {
    text: "# LLM 策略\n\n使用人工复核锚点，建议初始 3%、最大 8%。",
    candidateSizing: {
      candidateGroupKey: "新主题",
      classificationConfidence: "high",
      narrativeStage: "stage_2",
      fibReview: {
        decision: "override",
        direction: "up",
        anchors: {
          a: { barId: "2026-07-16T00:00:00.000Z", field: "low" },
          b: { barId: "2026-07-17T00:00:00.000Z", field: "high" },
          c: { barId: "2026-07-18T00:00:00.000Z", field: "low" },
        },
        emphasizedRatios: [0.382, 0.618, 1, 1.618],
        confidence: "high",
        rationale: "A/B/C 顺序与回撤关系成立。",
      },
      invalidation: {
        kind: "ema",
        barId: null,
        field: null,
        emaPeriod: 21,
        rangeKey: null,
        fibRatio: null,
        confirmation: "日线收盘",
        rationale: "EMA21 作为风险失效位。",
      },
      holdingHorizon: "swing",
      stressTest: {
        kind: "gap_down",
        lossPercent: 10,
        slippagePercent: 0.5,
        rationale: "按隔夜跳空与退出滑点压力测试。",
      },
      recommendedInitialAdditionalWeightPercent: 3,
      recommendedMaxTotalWeightPercent: 8,
      sizingConfidence: "high",
      leverageDecision: "cash_only",
      rationale: "由模型结合 Stage 与结构提出，不采用本地预设。",
    },
    provider: "Codex App Server",
    elapsedMs: 100,
    threadId: "thr-persistent-1",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    requestedSkills: ["analyze-technical-structure"],
    requestedApps: [],
    toolEvents: [],
    toolsUsed: false,
    skillCount: 2,
    mcpServerCount: 1,
    appCount: 0,
    tokenUsage: null,
  });

  assert.equal(enriched.risk.sizingReview.status, "llm_reviewed");
  assert.equal(enriched.risk.recommendedInitialAdditionalWeightPercent, 3);
  assert.equal(enriched.risk.recommendedMaxWeightPercent, 8);
  assert.equal(enriched.risk.fibonacciReview.selected.method, "llm_override");
  assert.equal(enriched.risk.fibonacciReview.selected.levels["0.382"], 105.28);
});

test("candidate LLM may select one official AVWAP anchor and the host recomputes it", () => {
  const run = candidateRunFixture();
  const priceBars = [
    { barId: "b1", time: "2026-07-15T20:00:00.000Z", tradeDate: "2026-07-15", open: 90, high: 91, low: 89, close: 90, volume: 100 },
    { barId: "b2", time: "2026-07-16T20:00:00.000Z", tradeDate: "2026-07-16", open: 95, high: 96, low: 94, close: 95, volume: 200 },
    { barId: "b3", time: "2026-07-17T20:00:00.000Z", tradeDate: "2026-07-17", open: 100, high: 101, low: 99, close: 100, volume: 300 },
  ];
  run.analysisContext.technical.priceBars = priceBars;
  run.technical.technicalV2 = {
    schemaVersion: "technical-v2/v2",
    status: "partial",
    capabilityMatrix: {
      schemaVersion: "technical-v2/v2",
      anchoredVwap: {
        status: "unavailable",
        reasonCodes: ["awaiting_explicit_llm_anchor"],
      },
    },
    limitations: [{
      layer: "anchoredVwap",
      status: "unavailable",
      reasonCodes: ["awaiting_explicit_llm_anchor"],
    }],
  };
  run.analysisContext.technical.technicalV2 = run.technical.technicalV2;
  const enriched = applyCodexWorkspaceAnalysis(
    run,
    candidateWorkspaceAnalysis({
      anchoredVwapReview: {
        decision: "select",
        anchorBarId: "b2",
        anchorReason: "财报缺口后的首个完整交易日",
        confidence: "medium",
        rationale: "用于观察缺口后的平均成交价格接受度。",
      },
    }),
  );

  const review = enriched.technical.technicalV2.anchoredVwap;
  assert.equal(review.status, "selected");
  assert.equal(review.hostVerified, true);
  assert.equal(review.sizingAuthority, false);
  assert.equal(review.evidence.vwap, 98);
  assert.equal(review.evidence.anchor.barId, "b2");
  assert.equal(review.evidence.method.typicalPrice, "HLC3");
  assert.match(review.evidence.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(
    enriched.technical.technicalV2.capabilityMatrix.anchoredVwap.status,
    "complete",
  );
  assert.equal(enriched.risk.anchoredVwapReview.hostVerified, true);
  assert.equal(enriched.risk.sizingReview.anchoredVwapReview.hostVerified, true);
  assert.equal(enriched.risk.recommendedInitialAdditionalWeightPercent, 1);
  const avwapFact = enriched.analysisContext.numericEvidence.facts.find((fact) => (
    fact.metric === "technical.host_verified_anchored_vwap_price"
  ));
  assert.equal(avwapFact.value, "98");
  assert.ok(avwapFact.quality.reasonCodes.includes("no_sizing_authority"));
  assert.ok(enriched.evidence.some((item) => (
    item.tool === "local:anchored-vwap" && item.status === "succeeded"
  )));
});

test("an invalid AVWAP anchor is rejected without silently changing sizing", () => {
  const run = candidateRunFixture();
  run.technical.technicalV2 = {
    schemaVersion: "technical-v2/v2",
    status: "partial",
    capabilityMatrix: { anchoredVwap: { status: "unavailable", reasonCodes: [] } },
    limitations: [],
  };
  run.analysisContext.technical.technicalV2 = run.technical.technicalV2;
  const enriched = applyCodexWorkspaceAnalysis(
    run,
    candidateWorkspaceAnalysis({
      anchoredVwapReview: {
        decision: "select",
        anchorBarId: "fabricated-bar",
        anchorReason: "不存在的锚点",
        confidence: "high",
        rationale: "应被拒绝。",
      },
    }),
  );
  assert.equal(enriched.technical.technicalV2.anchoredVwap.status, "invalid");
  assert.equal(enriched.technical.technicalV2.anchoredVwap.hostVerified, false);
  assert.equal(enriched.risk.recommendedInitialAdditionalWeightPercent, 1);
  assert.ok(enriched.evidence.some((item) => (
    item.tool === "local:anchored-vwap" && item.status === "degraded"
  )));
});

test("candidate sizing expires while a long LLM turn is still allowed to return prose", () => {
  const run = candidateRunFixture();
  run.risk.sizingValidUntil = "2020-01-01T00:00:00.000Z";
  const enriched = applyCodexWorkspaceAnalysis(run, {
    text: "# 研究结论仍保留\n\n快照已过期，因此不输出可执行仓位。",
    candidateSizing: {
      candidateGroupKey: "半导体",
      classificationConfidence: "high",
      narrativeStage: "stage_2",
      fibReview: {
        decision: "ignore",
        direction: "none",
        anchors: { a: null, b: null, c: null },
        emphasizedRatios: [],
        confidence: "medium",
        rationale: "本轮不使用 Fib。",
      },
      anchoredVwapReview: {
        decision: "ignore",
        anchorBarId: null,
        anchorReason: "",
        confidence: "medium",
        rationale: "本轮没有具有增量信息的显式 AVWAP 锚点。",
      },
      invalidation: {
        kind: "ema",
        barId: null,
        field: null,
        emaPeriod: 21,
        rangeKey: null,
        fibRatio: null,
        confirmation: "日线收盘",
        rationale: "EMA21。",
      },
      holdingHorizon: "swing",
      stressTest: {
        kind: "gap_down",
        lossPercent: 10,
        slippagePercent: 0.5,
        rationale: "按隔夜跳空与退出滑点压力测试。",
      },
      recommendedInitialAdditionalWeightPercent: 3,
      recommendedMaxTotalWeightPercent: 8,
      sizingConfidence: "high",
      leverageDecision: "cash_only",
      rationale: "模型建议。",
    },
    provider: "Codex App Server",
    elapsedMs: 180_000,
    threadId: "thr-persistent-1",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    requestedSkills: [],
    requestedApps: [],
    toolEvents: [],
    toolsUsed: false,
    skillCount: 2,
    mcpServerCount: 1,
    appCount: 0,
    tokenUsage: null,
  });

  assert.equal(enriched.risk.sizingReview.status, "blocked");
  assert.equal(enriched.risk.sizingReview.accepted.initialAdditionalWeightPercent, 0);
  assert.match(enriched.risk.sizingReview.rationale, /超过 2 分钟/);
  assert.match(enriched.conclusion.body, /研究结论仍保留/);
});

test("candidate turns request structured Markdown plus a bounded sizing review", async () => {
  const store = new MemoryStore();
  const rpcInstances = [];
  const service = createService({ store, rpcInstances });
  await service.prepare();
  await service.analyze({
    portfolio: portfolioFixture(),
    run: candidateRunFixture(),
    task: "$technical-structure 评估候选仓位",
  });
  const turn = rpcInstances[0].calls.find((call) => call.method === "turn/start");
  assert.equal(turn.params.outputSchema.properties.analysisMarkdown.type, "string");
  assert.deepEqual(
    turn.params.outputSchema.properties.candidateSizing.properties.leverageDecision.enum,
    ["cash_only", "margin_within_cap", "disabled"],
  );
  assert.deepEqual(
    turn.params.outputSchema.properties.candidateSizing.properties.fibReview
      .anyOf[0].properties.decision.enum,
    ["use_auto", "override", "ignore", "insufficient_evidence"],
  );
  assert.equal(
    turn.params.outputSchema.properties.candidateSizing.properties.fibReview.anyOf[1].type,
    "null",
  );
  assert.deepEqual(
    turn.params.outputSchema.properties.candidateSizing.properties.anchoredVwapReview
      .anyOf[0].properties.decision.enum,
    ["select", "ignore", "insufficient_evidence"],
  );
  assert.ok(
    turn.params.outputSchema.properties.candidateSizing.required.includes("anchoredVwapReview"),
  );
  assert.equal(turn.params.input.some((item) => item.type === "skill"
    && item.name === "analyze-market-narratives"), true);
  assert.equal(turn.params.input.some((item) => item.type === "skill"
    && item.name === "analyze-technical-structure"), true);
  service.dispose();
});

test("review turns automatically attach only the protocol review skill", async () => {
  const store = new MemoryStore();
  const rpcInstances = [];
  const service = createService({ store, rpcInstances });
  await service.prepare();
  await service.analyze({
    portfolio: null,
    task: "复盘已选择的财报订单",
    run: {
      id: "review-run-1",
      state: "REVIEW_READY",
      context: { scope: "review", reviewCaseIds: ["case-1"] },
      analysisContext: {
        scope: "review",
        cases: [{ id: "case-1", symbol: "NVDA.US" }],
        brokerRecords: [{ kind: "execution", recordId: "trade-1" }],
      },
      evidence: [],
      safeguards: { orderWrite: false },
      capabilities: {},
      plan: { available: false },
      sections: ["conclusion", "evidence"],
    },
  });
  const turn = rpcInstances[0].calls.find((call) => call.method === "turn/start");
  assert.equal(turn.params.outputSchema, undefined);
  assert.equal(turn.params.input.some((item) => item.type === "skill"
    && item.name === "review-earnings-decisions"), true);
  assert.equal(turn.params.input.some((item) => item.type === "skill"
    && item.name === "analyze-market-narratives"), false);
  assert.equal(turn.params.input.some((item) => item.type === "skill"
    && item.name === "analyze-technical-structure"), false);
  service.dispose();
});

test("decision-cycle turns automatically attach the cycle review skill instead of the legacy earnings skill", async () => {
  const store = new MemoryStore();
  const rpcInstances = [];
  const service = createService({ store, rpcInstances });
  await service.prepare();
  await service.analyze({
    portfolio: null,
    task: "继续盲态复盘",
    run: {
      id: "cycle-run-1",
      state: "REVIEW_CYCLE_BLIND_READY",
      context: {
        scope: "review",
        reviewProtocol: "decision_cycle",
        reviewCycleId: "cycle-1",
        reviewPhase: "blind",
      },
      analysisContext: {
        scope: "review",
        reviewProtocol: "decision_cycle",
        phase: "blind",
        cycle: { id: "cycle-1", orders: [], executions: [], checkpoints: [] },
      },
      evidence: [],
      safeguards: { orderWrite: false },
      capabilities: {},
      plan: { available: false },
      sections: ["conclusion", "evidence"],
    },
  });
  const turn = rpcInstances[0].calls.find((call) => call.method === "turn/start");
  assert.equal(turn.params.input.some((item) => item.type === "skill"
    && item.name === "review-decision-cycles"), true);
  assert.equal(turn.params.input.some((item) => item.type === "skill"
    && item.name === "review-earnings-decisions"), false);
  service.dispose();
});

test("a review thread is immutably bound to one cycle phase and blind history lookup is blocked", async () => {
  const store = new MemoryStore();
  const rpcInstances = [];
  const service = createService({ store, rpcInstances });
  await service.prepare();
  const blind = decisionCycleRunFixture("blind");
  blind.context.reviewCycleId = "cycle-bound";
  blind.context.reviewEvidenceRevision = 3;
  blind.context.reviewInputSnapshotHash = "snapshot-v3";
  blind.analysisContext.cycle.id = "cycle-bound";
  await service.analyze({ portfolio: null, task: "盲态复盘", run: blind });

  const rpc = rpcInstances[0];
  rpc.options.onServerRequest({
    id: 811,
    method: "item/tool/call",
    params: {
      threadId: "thr-persistent-1",
      turnId: "turn-after-blind",
      callId: "call-811",
      tool: "query_recent_history",
      arguments: { query: "结果" },
    },
  });
  await waitUntil(() => rpc.results?.some((item) => item.id === 811));
  const historyResult = rpc.results.find((item) => item.id === 811).result;
  assert.equal(historyResult.success, false);
  assert.match(historyResult.contentItems[0].text, /盲态复盘已禁用近期对话查询/);

  const outcome = decisionCycleRunFixture("outcome");
  outcome.context.reviewCycleId = "cycle-bound";
  outcome.context.reviewEvidenceRevision = 3;
  outcome.context.reviewInputSnapshotHash = "snapshot-v3";
  outcome.analysisContext.cycle.id = "cycle-bound";
  await assert.rejects(
    service.analyze({ portfolio: null, task: "结果复盘", run: outcome }),
    (error) => error instanceof CodexWorkspaceError
      && error.kind === "review_thread_binding"
      && /已绑定/.test(error.message),
  );
  service.dispose();
});

test("a blind review turn fails closed before an external tool result can enter context", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new BlindToolStartRpc(options),
  });
  await service.prepare();
  await assert.rejects(
    service.analyze({
      portfolio: null,
      task: "阶段一盲态重放",
      run: decisionCycleRunFixture("blind"),
    }),
    (error) => error instanceof CodexWorkspaceError
      && error.kind === "blind_time_firewall"
      && /外部工具/.test(error.message),
  );
  service.dispose();
});

test("a completed-only blind tool event is quarantined even when item/started was lost", async () => {
  const store = new MemoryStore();
  const stream = [];
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    onStream: (event) => stream.push(event),
    rpcFactory: (options) => new BlindCompletedOnlyRpc(options),
  });
  await service.prepare();
  await assert.rejects(
    service.analyze({
      portfolio: null,
      task: "阶段一盲态重放",
      run: decisionCycleRunFixture("blind"),
    }),
    (error) => error instanceof CodexWorkspaceError
      && error.kind === "blind_time_firewall",
  );
  assert.equal(stream.some((event) => JSON.stringify(event).includes("COMPLETED_SECRET")), false);
  const registry = await store.get("codexWorkspaceThreadRegistry");
  assert.equal(
    registry.threads.find((entry) => entry.threadId === "thr-persistent-1")
      .reviewQuarantine.reason,
    "blind_external_tool_started",
  );
  service.dispose();
});

test("a persisted blind tool recovered after disconnect is discarded and quarantined", async () => {
  const store = new MemoryStore();
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new BlindRecoveredToolRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  const analysis = service.analyze({
    portfolio: null,
    task: "阶段一盲态重放",
    operationId: "recover-blind-tool",
    run: decisionCycleRunFixture("blind"),
  });
  const rejected = assert.rejects(
    analysis,
    (error) => error instanceof CodexWorkspaceError
      && error.kind === "blind_time_firewall",
  );
  await waitUntil(() => service.status().activeThreads[0]?.turnId === "blind-recovered-turn");
  rpc.exposeRecoveredTurn = true;
  await service.reconcileActiveTurn({
    threadId: "thr-persistent-1",
    operationId: "recover-blind-tool",
  });
  await rejected;
  assert.equal((await store.get("codexWorkspaceThreadRegistry")).threads
    .find((entry) => entry.threadId === "thr-persistent-1")
    .reviewQuarantine.reason, "blind_external_tool_started");
  service.dispose();
});

test("an existing unbound conversation cannot be repurposed as a blind review thread", async () => {
  const store = new MemoryStore();
  const rpcInstances = [];
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      const rpc = new PriorHistoryRpc(options);
      rpcInstances.push(rpc);
      return rpc;
    },
  });
  await service.prepare();
  await assert.rejects(
    service.analyze({
      portfolio: null,
      task: "在旧对话中开始盲态复盘",
      run: decisionCycleRunFixture("blind"),
    }),
    (error) => error instanceof CodexWorkspaceError
      && error.kind === "review_thread_binding"
      && /已有历史/.test(error.message),
  );
  assert.equal(rpcInstances[0].calls.some((call) => call.method === "turn/start"), false);
  service.dispose();
});

test("a blind tool start quarantines the thread and synchronously rejects late approvals", async () => {
  const store = new MemoryStore();
  const stream = [];
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    onStream: (event) => stream.push(event),
    rpcFactory: (options) => {
      rpc = new BlindLateLeakRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  await assert.rejects(
    service.analyze({
      portfolio: null,
      task: "阶段一盲态重放",
      run: decisionCycleRunFixture("blind"),
    }),
    (error) => error instanceof CodexWorkspaceError
      && error.kind === "blind_time_firewall",
  );

  await waitUntil(() => (rpc.results ?? []).length === 5);
  assert.deepEqual(rpc.results.find((entry) => entry.id === 901)?.result, {
    decision: "decline",
  });
  assert.deepEqual(rpc.results.find((entry) => entry.id === 902)?.result, {
    decision: "decline",
  });
  assert.deepEqual(rpc.results.find((entry) => entry.id === 903)?.result, {
    permissions: {},
    scope: "turn",
    strictAutoReview: false,
  });
  assert.match(
    rpc.results.find((entry) => entry.id === 904)?.result.decision.denied.rejection,
    /盲态复盘/,
  );
  assert.equal(rpc.results.find((entry) => entry.id === 905)?.result.success, false);
  assert.equal(stream.some((event) => JSON.stringify(event).includes("LATE_SECRET")), false);

  const registry = await store.get("codexWorkspaceThreadRegistry");
  const quarantined = registry.threads.find((entry) => (
    entry.threadId === "thr-persistent-1"
  ));
  assert.equal(quarantined.reviewQuarantine.reason, "blind_external_tool_started");
  assert.equal(await store.get("codexWorkspaceThread"), null);
  await assert.rejects(
    service.analyze({
      portfolio: null,
      task: "再次运行同一盲态证据",
      run: decisionCycleRunFixture("blind"),
    }),
    (error) => error instanceof CodexWorkspaceError
      && error.kind === "review_thread_quarantine",
  );
  service.dispose();
});

test("review analysis fails closed when its protocol skill is unavailable", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new MissingReviewSkillRpc(options),
  });
  await service.prepare();
  await assert.rejects(
    service.analyze({
      portfolio: null,
      task: "复盘订单",
      run: {
        ...decisionCycleRunFixture("blind"),
        context: { scope: "review", reviewCaseIds: ["case-1"] },
        analysisContext: {
          scope: "review",
          cases: [{ id: "case-1", symbol: "AAPL.US" }],
          brokerRecords: [],
        },
      },
    }),
    (error) => error instanceof CodexWorkspaceError
      && error.kind === "review_skill_missing",
  );
  service.dispose();
});

test("retrospective and outcome review turns request an optional structured learning proposal while blind stays unstructured", async () => {
  for (const phase of ["retrospective", "outcome", "blind"]) {
    const store = new MemoryStore();
    const rpcInstances = [];
    const service = createService({ store, rpcInstances });
    await service.prepare();
    const analysis = await service.analyze({
      portfolio: null,
      task: `${phase} 复盘`,
      run: decisionCycleRunFixture(phase),
    });
    const turn = rpcInstances[0].calls.find((call) => call.method === "turn/start");
    if (phase === "blind") {
      assert.equal(turn.params.outputSchema, undefined);
    } else {
      const schema = turn.params.outputSchema;
      assert.equal(schema.properties.analysisMarkdown.type, "string");
      assert.deepEqual(schema.required, ["analysisMarkdown", "learningProposal"]);
      const proposal = schema.properties.learningProposal.anyOf[0];
      assert.deepEqual(proposal.required, [
        "hypothesis",
        "evidenceSummary",
        "testDesign",
        "candidateRule",
        "confidence",
        "caveats",
        "evidencePosture",
      ]);
      assert.deepEqual(proposal.properties.testDesign.required, [
        "metric", "window", "minCases", "inclusion", "exclusion", "successCriteria",
        "successOperator", "successThreshold",
      ]);
      assert.deepEqual(proposal.properties.testDesign.properties.metric.enum, [
        "net_r", "expectancy_r", "win_rate", "payoff_ratio",
      ]);
      assert.equal(Object.hasOwn(proposal.properties.testDesign.properties, "passed"), false);
      assert.match(proposal.properties.testDesign.properties.successThreshold.description, /55%/);
      assert.deepEqual(proposal.properties.candidateRule.required, [
        "title", "action", "invalidation", "scope",
      ]);
      assert.deepEqual(proposal.properties.evidencePosture.enum, ["retrospective_not_ex_ante"]);
      assert.match(turn.params.additionalContext["trading-cockpit-instructions"].value, /learningProposal/);
      assert.match(turn.params.additionalContext["trading-cockpit-instructions"].value, /不能冒充或回写为事前判断/);
      assert.equal(analysis.learningProposal, null, "plain Markdown remains a backward-compatible response");
    }
    service.dispose();
  }
});

test("structured review learning proposals are normalized and remain explicitly retrospective", async () => {
  const response = JSON.stringify({
    analysisMarkdown: "# 复盘结论\n\n动作需要通过更多样本验证。",
    learningProposal: {
      hypothesis: "财报后首日不追高可改善赔率",
      evidenceSummary: "当前案例的追高仓位出现较大不利路径。",
      testDesign: {
        metric: "expectancy_r",
        window: "财报后 T+1 至 T+5",
        minCases: 12,
        inclusion: "存在已关联订单和完整日线的财报交易",
        exclusion: "停牌或行情覆盖不完整",
        successCriteria: "中位超额收益提高且 MAE 下降",
        successOperator: "gt",
        successThreshold: 0,
      },
      candidateRule: {
        title: "财报首日追高冷静期",
        action: "首日不新增战术仓",
        invalidation: "次日放量站稳事件高点",
        scope: "美股财报催化交易",
      },
      confidence: "medium",
      caveats: ["当前仅有单案例"],
      evidencePosture: "prospective",
    },
  });
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new StructuredReviewRpc(options, response),
  });
  await service.prepare();
  const run = decisionCycleRunFixture("retrospective");
  const analysis = await service.analyze({ portfolio: null, run, task: "直接事后复盘" });
  assert.match(analysis.text, /动作需要通过更多样本验证/);
  assert.equal(analysis.learningProposal.testDesign.minCases, 12);
  assert.equal(analysis.learningProposal.testDesign.successOperator, "gt");
  assert.equal(analysis.learningProposal.testDesign.successThreshold, 0);
  assert.equal(analysis.learningProposal.evidencePosture, "retrospective_not_ex_ante");
  assert.match(analysis.learningProposal.caveats.at(-1), /不得冒充、覆盖或回写为事前判断/);

  const enriched = applyCodexWorkspaceAnalysis(run, analysis);
  assert.equal(enriched.learningProposal.candidateRule.title, "财报首日追高冷静期");
  assert.equal(enriched.learningProposal.evidencePosture, "retrospective_not_ex_ante");
  assert.equal(enriched.conclusion.headline, "复盘结论");

  const blind = applyCodexWorkspaceAnalysis(decisionCycleRunFixture("blind"), analysis);
  assert.equal(Object.hasOwn(blind, "learningProposal"), false, "blind review cannot receive retrospective learning output");
  const malformed = applyCodexWorkspaceAnalysis(run, {
    ...analysis,
    learningProposal: {
      ...analysis.learningProposal,
      testDesign: { ...analysis.learningProposal.testDesign, minCases: 0 },
    },
  });
  assert.equal(Object.hasOwn(malformed, "learningProposal"), false, "invalid test design is rejected instead of silently repaired");
  const booleanNumbers = applyCodexWorkspaceAnalysis(run, {
    ...analysis,
    learningProposal: {
      ...analysis.learningProposal,
      testDesign: {
        ...analysis.learningProposal.testDesign,
        minCases: true,
        successThreshold: false,
      },
    },
  });
  assert.equal(
    Object.hasOwn(booleanNumbers, "learningProposal"),
    false,
    "boolean values cannot masquerade as numeric review thresholds",
  );
  service.dispose();
});

function reconstructedContextJson(contexts, prefix) {
  const escapedPrefix = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyPattern = new RegExp(`^${escapedPrefix}(?:-\\d+)?$`);
  const blocks = Object.entries(contexts)
    .filter(([key]) => keyPattern.test(key))
    .map(([, block]) => JSON.parse(block.value));
  assert.ok(blocks.length > 0, `context ${prefix} exists`);
  if (blocks.length === 1 && blocks[0]?.encoding !== "json-fragment") return blocks[0];
  assert.equal(blocks.every((block) => block?.encoding === "json-fragment"), true);
  const ordered = blocks.slice().sort((left, right) => left.part - right.part);
  assert.deepEqual(ordered.map((block) => block.part), Array.from(
    { length: ordered.length },
    (_, index) => index + 1,
  ));
  assert.equal(ordered.every((block) => block.parts === ordered.length), true);
  return JSON.parse(ordered.map((block) => block.fragment).join(""));
}

function decisionCycleRunFixture(phase) {
  return {
    id: `cycle-${phase}`,
    state: `REVIEW_CYCLE_${phase.toUpperCase()}_READY`,
    context: {
      scope: "review",
      reviewProtocol: "decision_cycle",
      reviewCycleId: `cycle-${phase}`,
      reviewPhase: phase,
    },
    analysisContext: {
      scope: "review",
      reviewProtocol: "decision_cycle",
      phase,
      cycle: {
        id: `cycle-${phase}`,
        evidenceGrade: phase === "retrospective" ? "retrospective" : "prospective",
        orders: [],
        executions: [],
        checkpoints: [],
        blindAssessment: phase === "outcome" ? { summary: "冻结判断", frozen: true } : null,
      },
    },
    evidence: [],
    safeguards: { orderWrite: false },
    capabilities: {},
    plan: { available: false },
    sections: ["conclusion", "evidence"],
  };
}

test("composer markers map only to discovered Skills and accessible Apps", () => {
  const skills = [{ name: "risk", path: "/skills/risk/SKILL.md" }];
  const apps = [{ id: "research-app", name: "Research" }];
  assert.deepEqual(findRequestedSkills("$risk $missing", skills), [skills[0]]);
  assert.deepEqual(findRequestedApps("$research-app $missing", apps), [apps[0]]);
  assert.match(expandAgentCommand("/technical 看日线"), /相对强弱|筹码/);
});

test("remaining context below two percent triggers persistent thread compaction", async () => {
  const store = new MemoryStore();
  const rpcInstances = [];
  const service = createService({ store, rpcInstances });
  await service.prepare();
  const rpc = rpcInstances[0];
  rpc.options.onNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thr-persistent-1",
      tokenUsage: {
        modelContextWindow: 1_000,
        last: { inputTokens: 1, totalTokens: 981 },
        total: { inputTokens: 1, totalTokens: 981 },
      },
    },
  });
  await service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "完整分析",
  });
  assert.equal(rpc.calls.some((call) => call.method === "thread/compact/start"), true);
  assert.equal(
    rpc.calls.findIndex((call) => call.method === "thread/compact/start")
      < rpc.calls.findIndex((call) => call.method === "turn/start"),
    true,
    "compaction must complete before adding a large evidence turn",
  );
});

test("cancel ends a disconnected turn locally without waiting for remote confirmation", async () => {
  const store = new MemoryStore();
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new HangingTurnRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  const analysis = service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "完整分析",
  });
  await waitUntil(() => rpc.calls.some((call) => call.method === "turn/start"));
  assert.equal(await service.cancel(), true);
  await assert.rejects(
    Promise.race([
      analysis,
      new Promise((_, reject) => setTimeout(() => reject(new Error("local cancel timed out")), 100)),
    ]),
    /已取消/,
  );
  assert.equal(rpc.calls.some((call) => call.method === "turn/interrupt"), true);
  service.dispose();
});

test("cancel settles locally while turn/start is still pending and interrupts a late turn", async () => {
  const store = new MemoryStore();
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new PendingTurnStartRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  const analysis = service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "在 turn/start 返回前取消",
    operationId: "operation-pending-start",
  });
  await waitUntil(() => rpc.calls.some((call) => call.method === "turn/start"));

  assert.equal(await service.cancel({
    threadId: "thr-persistent-1",
    operationId: "operation-pending-start",
  }), true);
  await assert.rejects(
    Promise.race([
      analysis,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("pending turn/start cancellation timed out")),
        250,
      )),
    ]),
    /已取消/,
  );
  assert.equal(service.status().active, false);

  rpc.resolveTurnStart();
  await waitUntil(() => rpc.calls.some((call) => call.method === "turn/interrupt"
    && call.params.turnId === "turn-started-late"));
  service.dispose();
});

test("cancelled remote turns fence only their own thread and cannot contaminate its next pending turn", async () => {
  let rpc;
  const stream = [];
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    onStream: event => stream.push(event),
    rpcFactory: options => (rpc = new LifecycleRaceRpc(options)),
  });
  const args = { portfolio: portfolioFixture(), run: runFixture() };
  await service.prepare();
  const old = service.analyze({ ...args, task: "old", operationId: "operation-old" });
  const oldRejected = assert.rejects(old, error => error.kind === "cancelled");
  await waitUntil(() => rpc.starts.length === 1);
  rpc.acceptStart(0, "turn-old");
  await waitUntil(() => service.status().activeThreads[0]?.turnId === "turn-old");
  assert.equal(await service.cancel(), true);
  await oldRejected;
  await assert.rejects(service.analyze({ ...args, task: "retry too early", threadId: "thr-session-1" }),
    error => error.kind === "remote_turn_pending");
  assert.equal(rpc.starts.length, 1, "interrupt acceptance is not remote termination");

  const other = await service.createSession();
  const parallel = service.analyze({ ...args, task: "other", threadId: other.id });
  await waitUntil(() => rpc.starts.length === 2);
  rpc.finish(other.id, "turn-other", "OTHER ANSWER");
  rpc.acceptStart(1, "turn-other");
  assert.equal((await parallel).text, "OTHER ANSWER");
  rpc.finish("thr-session-1", "turn-old", "OLD TURN ANSWER");
  const next = service.analyze({ ...args, task: "new", threadId: "thr-session-1", operationId: "operation-new" });
  await waitUntil(() => rpc.starts.length === 3);
  rpc.finish("thr-session-1", "turn-old", "LATE OLD ANSWER");
  assert.equal(service.status().activeThreads.find(item => item.threadId === "thr-session-1").turnId, null);
  rpc.finish("thr-session-1", "turn-new", "NEW ANSWER");
  rpc.acceptStart(2, "turn-new");
  assert.equal((await next).text, "NEW ANSWER");
  assert.equal(stream.some(item => item.operationId === "operation-new" && /OLD/.test(item.text ?? "")), false);
  service.dispose();
});

test("cancel before start response learns and interrupts the old ID without letting retry claim it", async () => {
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    rpcFactory: options => (rpc = new LifecycleRaceRpc(options)),
  });
  const args = { portfolio: portfolioFixture(), run: runFixture() };
  const old = service.analyze({ ...args, task: "cancel pending" });
  const rejected = assert.rejects(old, error => error.kind === "cancelled");
  await waitUntil(() => rpc?.starts.length === 1);
  await service.cancel();
  await rejected;
  await assert.rejects(service.analyze({ ...args, task: "retry unknown ID" }), error => error.kind === "remote_turn_pending");
  rpc.options.onNotification({ method: "item/started", params: {
    threadId: "thr-session-1", turnId: "late-old", item: { id: "old-text", type: "agentMessage" },
  } });
  await waitUntil(() => rpc.calls.some(call => call.method === "turn/interrupt" && call.params.turnId === "late-old"));
  rpc.acceptStart(0, "late-old");
  await assert.rejects(service.analyze({ ...args, task: "still active" }), error => error.kind === "remote_turn_pending");
  rpc.turns.set("thr-session-1", [{ id: "late-old", status: "interrupted", items: [] }]);
  const next = service.analyze({ ...args, task: "terminal via history" });
  await waitUntil(() => rpc.starts.length === 2);
  rpc.finish("thr-session-1", "new-id", "RECOVERED");
  rpc.acceptStart(1, "new-id");
  assert.equal((await next).text, "RECOVERED");
  assert.equal(service.abandonedTurns.size, 0);
  service.dispose();
  assert.equal(service.settledTurnIds.size, 0);
});

test("pre-turn compaction waits for its actual terminal and ignores its late duplicates", async () => {
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    rpcFactory: options => (rpc = new LifecycleRaceRpc(options)),
  });
  await service.prepare();
  service.tokenUsageByThread.set("thr-session-1", { modelContextWindow: 1_000, last: { totalTokens: 981 } });
  const analysis = service.analyze({ portfolio: portfolioFixture(), run: runFixture(), task: "compact first" });
  await waitUntil(() => rpc.calls.some(call => call.method === "thread/compact/start"));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(rpc.starts.length, 0, "the {} response must not release pre-compaction");
  rpc.options.onNotification({ method: "item/completed", params: {
    threadId: "thr-session-1", turnId: "compact-1", item: { type: "contextCompaction", id: "compact-item" },
  } });
  assert.equal(rpc.starts.length, 0, "an item is not the completed turn");
  service.tokenUsageByThread.clear();
  rpc.finish("thr-session-1", "compact-1", null);
  await waitUntil(() => rpc.starts.length === 1);
  rpc.finish("thr-session-1", "compact-1", null);
  assert.equal(service.status().activeThreads[0].turnId, null);
  rpc.finish("thr-session-1", "analysis-1", "AFTER COMPACTION");
  rpc.acceptStart(0, "analysis-1");
  assert.equal((await analysis).text, "AFTER COMPACTION");
  service.dispose();
});

test("compaction timeout remains fenced until a real terminal, and an exit settles its waiter", async () => {
  for (const mode of ["timeout", "exit", "interrupted"]) {
    let rpc;
    const service = new CodexWorkspaceService({
      codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
      compactionTimeoutMs: mode === "timeout" ? 15 : 5_000,
      rpcFactory: options => (rpc = new LifecycleRaceRpc(options)),
    });
    await service.prepare();
    service.tokenUsageByThread.set("thr-session-1", { modelContextWindow: 1_000, last: { totalTokens: 981 } });
    const args = { portfolio: portfolioFixture(), run: runFixture(), task: "wait compact" };
    const analysis = service.analyze(args);
    const rejected = assert.rejects(analysis, /压缩|退出|closed|context/i);
    await waitUntil(() => rpc.calls.some(call => call.method === "thread/compact/start"));
    if (mode === "exit") rpc.options.onExit(new Error("closed"));
    if (mode === "interrupted") rpc.finish("thr-session-1", "compact-failed", null, "interrupted");
    await rejected;
    assert.equal(rpc.starts.length, 0);
    if (mode === "timeout") {
      await assert.rejects(service.analyze(args), /压缩/);
      assert.equal(rpc.starts.length, 0);
      rpc.finish("thr-session-1", "compact-late", null);
      assert.equal(service.compactionPromises.size, 0);
    } else {
      assert.equal(service.compactionPromises.size, 0);
    }
    service.dispose();
  }
});

test("cancelling a compaction waiter does not launch analysis or falsely finish shared compaction", async () => {
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    rpcFactory: options => (rpc = new LifecycleRaceRpc(options)),
  });
  await service.prepare();
  service.tokenUsageByThread.set("thr-session-1", { modelContextWindow: 1_000, last: { totalTokens: 981 } });
  const controller = new AbortController();
  const args = { portfolio: portfolioFixture(), run: runFixture(), task: "wait compact" };
  const analysis = service.analyze({ ...args, signal: controller.signal });
  const rejected = assert.rejects(analysis, /cancelled waiter/);
  await waitUntil(() => rpc.calls.some(call => call.method === "thread/compact/start"));
  controller.abort(new Error("cancelled waiter"));
  await rejected;
  assert.equal(rpc.starts.length, 0);
  assert.equal(service.compactionPromises.size, 1);
  service.tokenUsageByThread.clear();
  const next = service.analyze(args);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(rpc.starts.length, 0, "a low new token estimate cannot skip an existing compact");
  rpc.finish("thr-session-1", "compact-after-cancel", null);
  await waitUntil(() => rpc.starts.length === 1);
  rpc.finish("thr-session-1", "analysis-after-cancel", "NEXT ANSWER");
  rpc.acceptStart(0, "analysis-after-cancel");
  assert.equal((await next).text, "NEXT ANSWER");
  service.dispose();
});

test("abort during compaction request setup handles its later rejection without changing shared failure", async () => {
  const controller = new AbortController();
  const cancelled = new Error("cancelled while compact request was being created");
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    compactionTimeoutMs: 15,
    rpcFactory: options => (rpc = new class extends LifecycleRaceRpc {
      async request(method, params) {
        if (method === "thread/compact/start") controller.abort(cancelled);
        return super.request(method, params);
      }
    }(options)),
  });
  try {
    await service.prepare();
    service.tokenUsageByThread.set("thr-session-1", { modelContextWindow: 1_000, last: { totalTokens: 981 } });
    await assert.rejects(service.analyze({
      portfolio: portfolioFixture(), run: runFixture(), task: "abort compact setup", signal: controller.signal,
    }), error => error === cancelled);
    assert.equal(rpc.starts.length, 0);
    // Wait past the shared timeout before attaching another consumer. An
    // abandoned waiter must already have a rejection handler installed.
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(service.compactionRuns.get("thr-session-1").timedOut, true);
    await assert.rejects(service.compactionPromises.get("thr-session-1"),
      error => error.kind === "context_budget" && /压缩尚未确认完成/.test(error.message));
  } finally {
    service.dispose();
  }
});

test("a lost compaction terminal is recovered on retry from its exact persisted turn", async () => {
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    compactionTimeoutMs: 15,
    rpcFactory: options => (rpc = new LifecycleRaceRpc(options)),
  });
  await service.prepare();
  service.tokenUsageByThread.set("thr-session-1", { modelContextWindow: 1_000, last: { totalTokens: 981 } });
  const args = { portfolio: portfolioFixture(), run: runFixture(), task: "recover compact" };
  const first = service.analyze(args);
  const rejected = assert.rejects(first, /压缩/);
  await waitUntil(() => rpc.calls.some(call => call.method === "thread/compact/start"));
  rpc.options.onNotification({ method: "turn/started", params: {
    threadId: "thr-session-1", turn: { id: "compact-lost-terminal", status: "inProgress", items: [] },
  } });
  await rejected;
  rpc.turns.set("thr-session-1", [{ id: "compact-lost-terminal", status: "completed", items: [] }]);
  const retry = service.analyze(args);
  await waitUntil(() => rpc.starts.length === 1);
  assert.equal(rpc.calls.filter(call => call.method === "thread/compact/start").length, 1);
  assert.equal(service.compactionRuns.size, 0);
  service.tokenUsageByThread.clear();
  rpc.finish("thr-session-1", "after-recovered-compact", "RECOVERED COMPACTION");
  rpc.acceptStart(0, "after-recovered-compact");
  assert.equal((await retry).text, "RECOVERED COMPACTION");
  service.dispose();
});

test("settled-turn tombstones are bounded, cannot claim a cancelled unknown start, and reset with the RPC", async () => {
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    rpcFactory: options => (rpc = new LifecycleRaceRpc(options)),
  });
  await service.prepare();
  for (let index = 0; index < 256; index += 1) service.settledTurnIds.set(`thr-session-1:ancient-${index}`, true);
  const args = { portfolio: portfolioFixture(), run: runFixture(), task: "bounded" };
  const first = service.analyze(args);
  await waitUntil(() => rpc.starts.length === 1);
  rpc.finish("thr-session-1", "completed-before-cancel", "DONE");
  rpc.acceptStart(0, "completed-before-cancel");
  await first;
  assert.equal(service.settledTurnIds.size, 256);
  assert.equal(service.settledTurnIds.has("thr-session-1:ancient-0"), false);
  const next = service.analyze(args);
  const rejected = assert.rejects(next, /已取消/);
  await waitUntil(() => rpc.starts.length === 2);
  await service.cancel();
  await rejected;
  rpc.finish("thr-session-1", "completed-before-cancel", "DUPLICATE");
  assert.equal(service.abandonedTurns.get("thr-session-1").turnId, "pending");
  service.dispose();
  await service.prepare();
  assert.equal(service.abandonedTurns.size, 0);
  assert.equal(service.settledTurnIds.size, 0);
  service.dispose();
});

test("recent history searches only registered App Server threads with full text and a per-turn 30-day cutoff", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const store = new MemoryStore();
  await store.set("codexWorkspaceThread", {
    threadId: "thr-current",
    cwd: "/tmp/stock-agent-workspace",
    createdAt: now - 60,
  });
  await store.set("codexWorkspaceThreadRegistry", {
    version: 1,
    threads: ["thr-current", "thr-no-match", "thr-match"].map((threadId) => ({
      threadId,
      cwd: "/tmp/stock-agent-workspace",
      createdAt: new Date((now - 3_600) * 1_000).toISOString(),
    })),
  });
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new HistoryRpc(options, {
        currentThreadId: "thr-current",
        liveThreads: [
          historyThread("thr-current", now - 10),
          historyThread("thr-no-match", now - 20),
          historyThread("thr-match", now - 30),
          { ...historyThread("thr-stranger", now - 5), name: "交易驾驶舱 Agent" },
        ],
        turns: {
          "thr-current": [historyTurn("turn-current", now - 10, "current discussion")],
          "thr-no-match": [historyTurn("turn-no-match", now - 20, "unrelated")],
          "thr-match": [
            historyTurn("turn-recent", now - 30, "target recent"),
            historyTurn("turn-expired", now - (31 * 86_400), "target ancient"),
          ],
          "thr-stranger": [historyTurn("turn-private", now - 5, "target private")],
        },
      });
      return rpc;
    },
  });
  await service.prepare();

  const history = await service.recentHistory({ query: "target", limit: 1, includeTurns: true });
  assert.equal(history.threads.length, 1);
  assert.equal(history.threads[0].id, "thr-match");
  assert.match(JSON.stringify(history.threads[0].transcript), /target recent/);
  assert.doesNotMatch(JSON.stringify(history.threads[0].transcript), /target ancient|target private/);
  assert.equal(rpc.calls.some((call) => call.method === "thread/read"), false);
  assert.equal(rpc.calls.filter((call) => call.method === "thread/turns/list")
    .every((call) => call.params.itemsView === "full"), true);
  assert.equal(rpc.calls.some((call) => call.method === "thread/turns/list"
    && call.params.threadId === "thr-no-match"), true);
  assert.equal(rpc.calls.some((call) => call.method === "thread/turns/list"
    && call.params.threadId === "thr-stranger"), false);
  const listCall = rpc.calls.find((call) => call.method === "thread/list");
  assert.equal(listCall.params.useStateDbOnly, true);
  assert.equal(listCall.params.sourceKinds.includes("exec"), true);
  assert.equal(listCall.params.sourceKinds.includes("unknown"), true);
  service.dispose();
});

test("recent history rechecks truncated cached answers and returns a bounded matching excerpt without replacing its prefix", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const at = new Date((now - 10) * 1_000).toISOString();
  const store = new MemoryStore();
  await store.set("codexWorkspaceThread", { threadId: "thr-long", cwd: "/tmp/stock-agent-workspace", createdAt: now - 60 });
  await store.set("codexWorkspaceThreadRegistry", { threads: [{ threadId: "thr-long", cwd: "/tmp/stock-agent-workspace", createdAt: at }] });
  await store.set("codexWorkspaceRecentHistoryIndex", { threads: [{ id: "thr-long", updatedAt: at,
    turns: [{ id: "turn-long", completedAt: at, entries: [{ role: "assistant", text: "a".repeat(12_000) }] }] }] });
  let rpc;
  const service = new CodexWorkspaceService({ codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store,
    rpcFactory: options => (rpc = new HistoryRpc(options, { currentThreadId: "thr-long",
      liveThreads: [historyThread("thr-long", now - 10)],
      turns: { "thr-long": [historyTurn("turn-long", now - 10, "a".repeat(12_010) + "unique-tail-needle" + "z".repeat(20_000))] } })) });
  await service.prepare();
  const result = await service.recentHistory({ query: "unique-tail-needle", includeTurns: true });
  assert.equal(result.threads.length, 1);
  assert.match(JSON.stringify(result.threads[0].transcript), /unique-tail-needle/);
  assert.equal(result.partial, true);
  assert.ok(result.partialReasons.includes("history_content_incomplete"));
  assert.equal(result.threads[0].transcriptPartial, true);
  assert.ok(rpc.calls.some(call => call.method === "thread/turns/list" && call.params.itemsView === "full"));
  assert.doesNotMatch(JSON.stringify(await store.get("codexWorkspaceRecentHistoryIndex")), /unique-tail-needle/);
  service.dispose();
});

test("recent history excludes undated turns and reports incomplete time-range evidence without repeatedly loading summaries", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const undated = historyTurn("undated", now - 10, "undated-secret-needle");
  delete undated.startedAt;
  delete undated.completedAt;
  const { service, rpc, store } = await createHistoryCoverageFixture({ now, turns: [
    historyTurn("dated", now - 10, "verified recent discussion"),
    undated,
    historyTurn("expired", now - 31 * 86_400, "expired-secret-needle"),
  ] });
  try {
    const result = await service.recentHistory({ query: "undated-secret-needle", includeTurns: true });
    assert.equal(result.requestedContentView, "full_text_search");
    assert.equal(result.threads.length, 0);
    assert.equal(result.partial, true);
    assert.ok(result.partialReasons.includes("undated_turns_excluded"));
    assert.ok(result.partialReasons.includes("history_content_incomplete"));
    await service.historyMutationQueue;
    const record = (await store.get("codexWorkspaceRecentHistoryIndex")).threads[0];
    assert.equal(record.coverage.undatedTurnCount, 1);
    assert.equal(record.coverage.paginationComplete, true);
    assert.equal(record.coverage.rangeComplete, false);
    assert.doesNotMatch(JSON.stringify(record), /undated-secret-needle|expired-secret-needle/);
    const before = rpc.calls.filter(call => call.method === "thread/turns/list").length;
    const summary = await service.recentHistory({ includeTurns: true });
    assert.equal(rpc.calls.filter(call => call.method === "thread/turns/list").length, before);
    assert.equal(summary.partial, true);
    assert.ok(summary.partialReasons.includes("undated_turns_excluded"));
    assert.equal(summary.threads[0].partial, true);
    assert.doesNotMatch(JSON.stringify(summary), /undated-secret-needle|expired-secret-needle/);
  } finally { service.dispose(); }
});

test("resume initial-page history preserves undated exclusions in the reusable summary index", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const undated = historyTurn("initial-undated", now - 10, "initial-undated-secret");
  delete undated.startedAt;
  delete undated.completedAt;
  class InitialHistoryPageRpc extends HistoryRpc {
    async request(method, params) {
      const response = await super.request(method, params);
      if (["thread/start", "thread/resume"].includes(method)) response.initialTurnsPage = {
        data: this.config.turns[this.config.currentThreadId], nextCursor: null,
      };
      return response;
    }
  }
  const { service, rpc, store } = await createHistoryCoverageFixture({ now, Rpc: InitialHistoryPageRpc, turns: [
    historyTurn("initial-dated", now - 10, "visible dated discussion"), undated,
  ] });
  try {
    const opened = await service.openSession("thr-coverage");
    assert.doesNotMatch(JSON.stringify(opened.transcript), /initial-undated-secret/);
    await service.historyMutationQueue;
    const record = (await store.get("codexWorkspaceRecentHistoryIndex")).threads[0];
    assert.equal(record.coverage.undatedTurnCount, 1);
    assert.equal(record.coverage.paginationComplete, true);
    assert.equal(record.coverage.rangeComplete, false);
    const before = rpc.calls.filter(call => call.method === "thread/turns/list").length;
    const history = await service.recentHistory({ includeTurns: true });
    assert.equal(rpc.calls.filter(call => call.method === "thread/turns/list").length, before);
    assert.equal(history.partial, true);
    assert.ok(history.partialReasons.includes("undated_turns_excluded"));
    assert.equal(history.threads[0].transcriptView, "summary");
    assert.equal(history.threads[0].transcriptPartial, true);
  } finally { service.dispose(); }
});

test("truncated non-query summary is reused while a full-text tail search never overwrites the prefix index", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const longAnswer = "a".repeat(12_010) + "summary-tail-needle" + "z".repeat(20_000);
  const { service, rpc, store } = await createHistoryCoverageFixture({ now, turns: [
    historyTurn("long-answer", now - 10, "long response question", longAnswer),
  ] });
  try {
    const first = await service.recentHistory({ includeTurns: true });
    await service.historyMutationQueue;
    const prefixIndex = await store.get("codexWorkspaceRecentHistoryIndex");
    const cachedAnswer = prefixIndex.threads[0].turns[0].entries.find(entry => entry.role === "assistant");
    assert.equal(first.requestedContentView, "summary");
    assert.equal(first.partial, true);
    assert.equal(first.threads[0].transcriptPartial, true);
    assert.equal(cachedAnswer.text.length, 12_000);
    assert.equal(cachedAnswer.textComplete, false);
    assert.equal(cachedAnswer.sourceCharacters, longAnswer.length);
    assert.equal(prefixIndex.threads[0].coverage.rangeComplete, true);
    assert.equal(prefixIndex.threads[0].coverage.paginationComplete, true);
    assert.equal(prefixIndex.threads[0].coverage.itemsView, "summary");
    const reads = () => rpc.calls.filter(call => call.method === "thread/turns/list");
    assert.deepEqual(reads().map(call => call.params.itemsView), ["summary"]);
    const second = await service.recentHistory({ includeTurns: true });
    assert.equal(second.hydratedThreadCount, 0);
    assert.equal(second.partial, true);
    assert.deepEqual(reads().map(call => call.params.itemsView), ["summary"]);
    const search = await service.recentHistory({ query: "summary-tail-needle", includeTurns: true });
    assert.equal(search.requestedContentView, "full_text_search");
    assert.equal(search.threads.length, 1);
    assert.match(JSON.stringify(search.threads[0].transcript), /summary-tail-needle/);
    assert.equal(search.threads[0].transcriptView, "full");
    assert.equal(search.threads[0].transcriptPartial, true);
    assert.deepEqual(reads().map(call => call.params.itemsView), ["summary", "full"]);
    await service.historyMutationQueue;
    assert.deepEqual(await store.get("codexWorkspaceRecentHistoryIndex"), prefixIndex);
    await service.recentHistory({ includeTurns: true });
    assert.deepEqual(reads().map(call => call.params.itemsView), ["summary", "full"]);
  } finally { service.dispose(); }
});

test("a history turn-limit prefix cannot claim complete pagination or suppress subsequent summary hydration", async () => {
  const now = Math.floor(Date.now() / 1_000);
  class CappedHistoryPageRpc extends HistoryRpc {
    async request(method, params) {
      if (method !== "thread/turns/list") return super.request(method, params);
      this.calls.push({ method, params });
      const offset = Number(params.cursor ?? 0);
      const data = this.config.turns[params.threadId].slice(offset, offset + params.limit);
      return { data, nextCursor: String(offset + data.length) };
    }
  }
  const { service, rpc, store } = await createHistoryCoverageFixture({ now, Rpc: CappedHistoryPageRpc,
    turns: Array.from({ length: 241 }, (_, index) => historyTurn(`page-turn-${index}`, now - 10 - index, `question ${index}`)),
  });
  try {
    const first = await service.recentHistory({ includeTurns: true });
    assert.equal(first.partial, true);
    assert.ok(first.partialReasons.includes("history_content_incomplete"));
    await service.historyMutationQueue;
    const record = (await store.get("codexWorkspaceRecentHistoryIndex")).threads[0];
    assert.equal(record.turns.length, 240);
    assert.equal(record.coverage.paginationComplete, false);
    assert.equal(record.coverage.rangeComplete, false);
    const before = rpc.calls.filter(call => call.method === "thread/turns/list").length;
    assert.equal(before, 3);
    const second = await service.recentHistory({ includeTurns: true });
    assert.equal(second.partial, true);
    assert.equal(second.hydratedThreadCount, 1);
    assert.equal(rpc.calls.filter(call => call.method === "thread/turns/list").length, before + 3);
  } finally { service.dispose(); }
});

async function createHistoryCoverageFixture({ now, turns, Rpc = HistoryRpc }) {
  const store = new MemoryStore();
  const at = new Date((now - 10) * 1_000).toISOString();
  await store.set("codexWorkspaceThread", { threadId: "thr-coverage", cwd: "/tmp/stock-agent-workspace", createdAt: now - 60 });
  await store.set("codexWorkspaceThreadRegistry", { threads: [{ threadId: "thr-coverage", cwd: "/tmp/stock-agent-workspace", createdAt: at }] });
  let rpc;
  const service = new CodexWorkspaceService({ codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store,
    rpcFactory: options => (rpc = new Rpc(options, { currentThreadId: "thr-coverage",
      liveThreads: [historyThread("thr-coverage", now - 10)], turns: { "thr-coverage": turns },
    })),
  });
  await service.prepare();
  return { service, rpc, store };
}

test("recent history bounds transcript hydration before searching a large owned registry", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const threadIds = Array.from({ length: 60 }, (_, index) => `thr-bounded-${index}`);
  const store = new MemoryStore();
  await store.set("codexWorkspaceThread", {
    threadId: threadIds[0],
    cwd: "/tmp/stock-agent-workspace",
    createdAt: now - 60,
  });
  await store.set("codexWorkspaceThreadRegistry", {
    version: 1,
    threads: threadIds.map((threadId, index) => ({
      threadId,
      cwd: "/tmp/stock-agent-workspace",
      createdAt: new Date((now - index - 60) * 1_000).toISOString(),
    })),
  });
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new HistoryRpc(options, {
        currentThreadId: threadIds[0],
        liveThreads: threadIds.map((threadId, index) => historyThread(threadId, now - index - 1)),
        turns: Object.fromEntries(threadIds.map((threadId, index) => [
          threadId,
          [historyTurn(`turn-${index}`, now - index - 1, `ordinary discussion ${index}`)],
        ])),
      });
      return rpc;
    },
  });
  await service.prepare();
  const history = await service.recentHistory({
    query: "not present in metadata or index",
    limit: 8,
    includeTurns: true,
  });
  const hydratedCalls = rpc.calls.filter((call) => call.method === "thread/turns/list");
  assert.equal(hydratedCalls.length <= 20, true);
  assert.equal(history.partial, true);
  assert.equal(history.partialReasons.includes("candidate_limit"), true);
  service.dispose();
});

test("startup keeps a stale local pointer when App Server reports recent thread activity", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const oldCreatedAt = now - (40 * 86_400);
  const store = new MemoryStore();
  await store.set("codexWorkspaceThread", {
    threadId: "thr-old",
    cwd: "/tmp/stock-agent-workspace",
    createdAt: oldCreatedAt,
  });
  await store.set("codexWorkspaceThreadRegistry", {
    version: 1,
    threads: [{
      threadId: "thr-old",
      cwd: "/tmp/stock-agent-workspace",
      createdAt: new Date(oldCreatedAt * 1_000).toISOString(),
    }],
  });
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new HistoryRpc(options, {
        currentThreadId: "thr-old",
        liveThreads: [historyThread("thr-old", now - 60)],
        turns: {
          "thr-old": [
            historyTurn("turn-carry", now - 60, "carry recent decision"),
            historyTurn("turn-too-old", now - (35 * 86_400), "carry expired decision"),
          ],
        },
      });
      return rpc;
    },
  });
  await service.prepare();

  assert.equal(rpc.calls.some((call) => call.method === "thread/read"
    && call.params.threadId === "thr-old"), true);
  assert.equal(rpc.calls.some((call) => call.method === "thread/archive"), false);
  assert.equal(rpc.calls.some((call) => call.method === "thread/start"), false);
  assert.equal(rpc.calls.some((call) => call.method === "thread/resume"
    && call.params.threadId === "thr-old"), true);
  assert.equal((await store.get("codexWorkspaceThread")).threadId, "thr-old");
  service.dispose();
});

test("startup archives only after exact metadata and persisted turns confirm inactivity", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const oldActivity = now - (40 * 86_400);
  const store = new MemoryStore();
  await store.set("codexWorkspaceThread", {
    threadId: "thr-old",
    cwd: "/tmp/stock-agent-workspace",
    createdAt: oldActivity,
    updatedAt: oldActivity,
  });
  await store.set("codexWorkspaceThreadRegistry", {
    version: 1,
    threads: [{
      threadId: "thr-old",
      cwd: "/tmp/stock-agent-workspace",
      createdAt: new Date(oldActivity * 1_000).toISOString(),
      updatedAt: new Date(oldActivity * 1_000).toISOString(),
    }],
  });
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new HistoryRpc(options, {
        currentThreadId: "thr-new",
        liveThreads: [historyThread("thr-old", oldActivity)],
        turns: {
          "thr-old": [historyTurn(
            "turn-expired",
            now - (35 * 86_400),
            "expired decision",
          )],
          "thr-new": [],
        },
      });
      return rpc;
    },
  });
  await service.prepare();

  const snapshotIndex = rpc.calls.findIndex((call) => call.method === "thread/turns/list"
    && call.params.threadId === "thr-old");
  const archiveIndex = rpc.calls.findIndex((call) => call.method === "thread/archive"
    && call.params.threadId === "thr-old");
  assert.equal(snapshotIndex >= 0, true);
  assert.equal(archiveIndex > snapshotIndex, true);
  assert.equal(rpc.calls.some((call) => call.method === "thread/start"), true);
  assert.equal((await store.get("codexWorkspaceThread")).threadId, "thr-new");
  service.dispose();
});

test("a conversation older than 30 days remains active when it has recent activity", async () => {
  const now = Date.now();
  const store = new MemoryStore();
  await store.set("codexWorkspaceThread", {
    threadId: "thr-long-lived",
    cwd: "/tmp/stock-agent-workspace",
    createdAt: new Date(now - (45 * 86_400_000)).toISOString(),
    updatedAt: new Date(now - 60_000).toISOString(),
  });
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new HistoryRpc(options, {
        currentThreadId: "thr-long-lived",
        liveThreads: [historyThread("thr-long-lived", Math.floor(now / 1_000) - 60)],
        turns: { "thr-long-lived": [] },
      });
      return rpc;
    },
  });
  await service.prepare();
  assert.equal(rpc.calls.some((call) => call.method === "thread/resume"), true);
  assert.equal(rpc.calls.some((call) => call.method === "thread/archive"), false);
  assert.equal(rpc.calls.some((call) => call.method === "thread/start"), false);
  service.dispose();
});

test("query_recent_history is a native dynamic tool and rejects cross-thread calls", async () => {
  const store = new MemoryStore();
  const rpcInstances = [];
  const service = createService({ store, rpcInstances });
  await service.prepare();
  const rpc = rpcInstances[0];

  rpc.options.onServerRequest({
    id: 70,
    method: "item/tool/call",
    params: {
      threadId: "thr-not-owned",
      turnId: "turn-1",
      callId: "call-70",
      tool: "query_recent_history",
      arguments: { query: "risk" },
    },
  });
  await waitUntil(() => rpc.results?.length === 1);
  assert.equal(rpc.results[0].result.success, false);
  assert.match(rpc.results[0].result.contentItems[0].text, /非交易驾驶舱线程/);

  rpc.options.onServerRequest({
    id: 71,
    method: "item/tool/call",
    params: {
      threadId: "thr-persistent-1",
      turnId: "turn-1",
      callId: "call-71",
      tool: "query_recent_history",
      arguments: "{\"query\":\"risk\",\"limit\":2}",
    },
  });
  await waitUntil(() => rpc.results?.length === 2);
  assert.equal(rpc.results[1].result.success, true);
  assert.equal(JSON.parse(rpc.results[1].result.contentItems[0].text).retentionDays, 30);
  service.dispose();
});

test("uncompleted message deltas are retained as partial text instead of a verified final answer", async () => {
  const store = new MemoryStore();
  const stream = [];
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    onStream: (event) => stream.push(event),
    rpcFactory: (options) => {
      rpc = new StreamFallbackRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  await assert.rejects(service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "完整分析",
  }), (error) => error.kind === "history_incomplete"
    && error.partialText === "only streamed answer" && error.complete === false);
  assert.equal(stream.filter((event) => event.kind === "tool").at(-1)?.itemId, "tool-stable");
  assert.equal(stream.filter((event) => event.kind === "tool").at(-1)?.lifecycle, "completed");
  service.dispose();
});

test("a persisted completed turn is recovered when the terminal notification is lost", async () => {
  const store = new MemoryStore();
  const stream = [];
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    onStream: (event) => stream.push(event),
    rpcFactory: (options) => {
      rpc = new LostCompletionRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  const analysis = await Promise.race([
    service.analyze({
      portfolio: portfolioFixture(),
      run: runFixture(),
      task: "恢复丢失的终态",
    }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("persisted turn reconciliation timed out")),
      1_000,
    )),
  ]);
  assert.equal(analysis.text, "recovered final answer");
  assert.equal(stream.some((event) => event.kind === "final_message"
    && event.text === "recovered final answer"), true);
  assert.equal(rpc.calls.some((call) => call.method === "thread/turns/list"
    && call.params.itemsView === "summary"), true);
  assert.equal(await service.cancel(), false);
  service.dispose();
});

test("one turn aggregates every final_answer item in order and excludes commentary", async () => {
  let rpc;
  const stream = [];
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    onStream: (event) => stream.push(event),
    rpcFactory: (options) => {
      rpc = new SplitFinalAnswerRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  const analysis = await service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "聚合分段最终结论",
  });

  assert.equal(analysis.text, "第一段最终结论\n\n第二段执行计划");
  assert.equal(analysis.text.includes("运行中说明"), false);
  assert.equal(stream.filter((event) => event.kind === "final_message").at(-1)?.text,
    "第一段最终结论\n\n第二段执行计划");
  assert.equal(rpc.calls.some((call) => call.method === "turn/interrupt"), false);
  service.dispose();
});

test("a second final segment after 6.5 seconds is delivered without interrupting the live turn", async () => {
  let rpc;
  const statuses = [];
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    onStatus: (event) => statuses.push(event),
    rpcFactory: (options) => (rpc = new SlowSegmentRpc(options)),
  });
  await service.prepare();
  try {
    const analysis = await service.analyze({ portfolio: portfolioFixture(), run: runFixture(),
      task: "慢分段完整性", operationId: "slow-final-regression" });
    assert.equal(analysis.text, "第一段：判断\n\n第二段：风险与限制");
    assert.equal(rpc.calls.some((call) => call.method === "turn/interrupt"), false);
    assert.equal(statuses.some((event) => event.phase === "codex_final_pending_terminal"), true);
    assert.equal(analysis.resultDelivery.terminalStatus, "completed");
    assert.equal(analysis.resultDelivery.complete, true);
  } finally { service.dispose(); }
});

test("a paginated prefix exhausting the shared history budget returns partial evidence, not success", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    turnHistoryBudgetMs: 30,
    rpcFactory: (options) => new IncompleteHistoryRpc(options),
  });
  await service.prepare();
  try {
    await assert.rejects(service.analyze({ portfolio: portfolioFixture(), run: runFixture(),
      task: "分页缺失", operationId: "history-budget-regression" }), (error) => {
      assert.equal(error.kind, "history_incomplete");
      assert.equal(error.complete, false);
      assert.equal(error.partial, true);
      assert.match(error.partialText, /第一段/);
      assert.match(error.partialText, /第二段/);
      assert.equal(error.operationId, "history-budget-regression");
      return true;
    });
    assert.equal(service.status().active, false);
  } finally { service.dispose(); }
});

test("summary-only recovery never certifies a complete result when full history is unavailable", async () => {
  class SummaryOnlyRpc extends LostCompletionRpc {
    async request(method, params) {
      if (method === "thread/items/list" || (method === "thread/turns/list" && params.itemsView === "full")) {
        this.calls.push({ method, params });
        throw new Error("full item history temporarily unavailable");
      }
      return super.request(method, params);
    }
  }
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    rpcFactory: (options) => new SummaryOnlyRpc(options),
  });
  try {
    await service.prepare();
    await assert.rejects(service.recoverLatestTurn({ threadId: "thr-persistent-1" }),
      (error) => error.kind === "history_incomplete" && error.complete === false
        && error.partialText === "recovered final answer");
    // The live item/completed stream is a separate source of full message text;
    // an unavailable archive must not discard those already received items.
    const analysis = await service.analyze({ portfolio: portfolioFixture(), run: runFixture(), task: "有完整流的分析" });
    assert.equal(analysis.text, "recovered final answer");
    assert.equal(analysis.resultDelivery.historyStatus, "streamed_unverified");
  } finally { service.dispose(); }
});

test("terminal notification and reconciler share one in-flight history read and deadline", async () => {
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    rpcFactory: (options) => (rpc = new ConcurrentTerminalHistoryRpc(options)),
  });
  await service.prepare();
  try {
    const result = await service.analyze({ portfolio: portfolioFixture(), run: runFixture(), task: "终态与分页并发" });
    assert.equal(result.text, "final answer without turn completed");
    assert.equal(rpc.historyReads, 1);
  } finally { service.dispose(); }
});

test("terminal item history restores missing final segments in persisted order", async () => {
  let rpc;
  const stream = [];
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    onStream: (event) => stream.push(event),
    rpcFactory: (options) => {
      rpc = new PersistedSplitFinalRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  const analysis = await Promise.race([
    service.analyze({
      portfolio: portfolioFixture(),
      run: runFixture(),
      task: "回收全部分段",
      operationId: "operation-persisted-split",
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("split recovery timed out")), 2_000)),
  ]);

  assert.equal(analysis.text, "第一段\n\n第二段");
  assert.equal(stream.filter((event) => event.kind === "final_message").at(-1)?.text,
    "第一段\n\n第二段");
  assert.equal(rpc.calls.some((call) => call.method === "thread/items/list"), true);
  assert.equal(rpc.calls.find((call) => call.method === "turn/start")?.params.clientUserMessageId,
    "operation-persisted-split");
  service.dispose();
});

test("historical recovery matches the exact client operation before repeated task text", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new RepeatedTaskHistoryRpc(options),
  });
  await service.prepare();
  const recovered = await service.recoverLatestTurn({
    threadId: "thr-persistent-1",
    operationId: "operation-newer",
    task: "分析全部持仓",
  });
  assert.equal(recovered.turnId, "turn-newer");
  assert.equal(recovered.text, "较新的组合结论");
  service.dispose();
});

test("an item notification adopts a lost turn/start response and history closes the turn", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new LostTurnStartResponseRpc(options),
  });
  await service.prepare();
  const analysis = await Promise.race([
    service.analyze({
      portfolio: portfolioFixture(),
      run: runFixture(),
      task: "turn start 响应丢失后恢复",
    }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("lost turn/start recovery timed out")),
      2_000,
    )),
  ]);
  assert.equal(analysis.text, "从持久 turn 恢复的最终结论");
  assert.equal(service.status().active, false);
  service.dispose();
});

test("an in-progress turn stays cancellable after a quiet final message and is never locally completed", async () => {
  const stream = [];
  const statuses = [];
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    onStream: (event) => stream.push(event),
    onStatus: (event) => statuses.push(event),
    rpcFactory: (options) => (rpc = new FinalAnswerWithoutTurnCompletionRpc(options)),
  });
  await service.prepare();
  const analysis = service.analyze({
      portfolio: portfolioFixture(),
      run: runFixture(),
      task: "最终文本已经完成，不应永久等待终态通知",
      operationId: "operation-final-grace",
    });
  const rejected = assert.rejects(analysis, (error) => error.kind === "cancelled");
  await waitUntil(() => statuses.some((event) => event.phase === "codex_final_pending_terminal"), 8_000);
  assert.equal(stream.some((event) => event.kind === "final_message"
    && event.text === "final answer without turn completed"), true);
  assert.equal(service.status().active, true);
  assert.equal(rpc.calls.some((call) => call.method === "turn/interrupt"), false);
  assert.equal(await service.cancel(), true);
  await rejected;
  assert.equal(service.status().active, false);
  service.dispose();
});

test("a late turn/start response still allows a real persisted terminal to close the turn", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new DelayedTurnStartStableFinalRpc(options),
  });
  await service.prepare();
  const analysis = await Promise.race([
    service.analyze({
      portfolio: portfolioFixture(),
      run: runFixture(),
      task: "迟到 start 响应也要交付 final",
      operationId: "operation-late-start-final",
    }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("late start terminal recovery timed out")), 15_000);
      timer.unref?.();
    }),
  ]);
  assert.equal(analysis.text, "late start stable final");
  service.dispose();
});

test("a real persisted terminal settles when turn/start and turn/completed responses are both lost", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new MissingTurnStartStableFinalRpc(options),
  });
  await service.prepare();
  const analysis = await Promise.race([
    service.analyze({
      portfolio: portfolioFixture(),
      run: runFixture(),
      task: "start 和 terminal 都丢失也要交付 final",
      operationId: "operation-missing-start-final",
    }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("missing start terminal recovery timed out")), 7_000);
      timer.unref?.();
    }),
  ]);
  assert.equal(analysis.text, "missing start stable final");
  service.dispose();
});

test("a new session is untitled until its first real task persists a summary title", async () => {
  const store = new MemoryStore();
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new MultiSessionRpc(options);
      return rpc;
    },
  });
  await service.prepare();

  const created = await service.createSession();
  assert.equal(created.name, "新对话");

  await service.cachePendingUserMessage({
    threadId: created.id,
    operationId: "operation-first-real-task",
    text: "$analyze-technical-structure 请分析 NVDA 候选买入计划与组合风险",
  });
  await waitUntil(() => rpc.calls.some((call) => call.method === "thread/name/set"
    && call.params.threadId === created.id
    && call.params.name !== "新对话"));
  await waitUntil(() => store.values.get("codexWorkspaceThreadRegistry")?.threads
    ?.some((thread) => thread.threadId === created.id && thread.name !== "新对话"));
  const registry = await store.get("codexWorkspaceThreadRegistry");
  const persisted = registry.threads.find((thread) => thread.threadId === created.id);
  assert.ok(persisted?.name);
  assert.notEqual(persisted.name, "新对话");
  assert.match(persisted.name, /NVDA|候选买入|组合风险/);
  assert.doesNotMatch(persisted.name, /\b\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}\b/);
  const current = await store.get("codexWorkspaceThread");
  assert.equal(current.name, persisted.name);
  assert.equal(rpc.calls.some((call) => call.method === "thread/name/set"
    && call.params.threadId === created.id
    && call.params.name === persisted.name), true);

  const renameCount = rpc.calls.filter((call) => call.method === "thread/name/set"
    && call.params.threadId === created.id).length;
  await service.cachePendingUserMessage({
    threadId: created.id,
    operationId: "operation-second-task",
    text: "再分析一次别的标的",
  });
  assert.equal(rpc.calls.filter((call) => call.method === "thread/name/set"
    && call.params.threadId === created.id).length, renameCount);
  service.dispose();
});

test("turn completion received before turn/start responds is queued by params.turn.id", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new EarlyCompletionRpc(options),
  });
  await service.prepare();
  const analysis = await service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "验证提前完成通知",
  });
  assert.equal(analysis.text, "early completed answer");
  assert.equal(service.status().active, false);
  service.dispose();
});

test("a malformed turn/start response always clears the local busy state", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new MissingTurnIdRpc(options),
  });
  await service.prepare();
  await assert.rejects(service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "验证协议错误清理",
  }), /没有返回 turn ID/);
  assert.equal(service.status().active, false);
  assert.equal(await service.cancel(), false);
  service.dispose();
});

test("unsupported additionalContext fails closed without retrying as ordinary text", async () => {
  const statuses = [];
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    onStatus: (status) => statuses.push(status),
    rpcFactory: (options) => new UnsupportedAdditionalContextRpc(options),
  });
  await service.prepare();
  await assert.rejects(service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "验证安全上下文协议",
  }), (error) => {
    assert.equal(error.kind, "protocol");
    assert.equal(error.rpcCode, -32602);
    assert.equal(error.rpcMethod, "turn/start");
    assert.match(error.message, /additionalContext/);
    assert.match(error.message, /不会|避免.*降级|不.*降级/);
    return true;
  });

  const starts = service.rpc.calls.filter((call) => call.method === "turn/start");
  assert.equal(starts.length, 1);
  assert.ok(starts[0].params.additionalContext);
  assert.equal(starts[0].params.input.some((item) => (
    item.type === "text" && /trading-cockpit-evidence/.test(item.text)
  )), false);
  assert.equal(service.status().additionalContextContract.mode,
    "experimental_required_fail_closed");
  assert.equal(service.status().additionalContextContract.status, "unsupported");
  assert.equal(service.status().additionalContextContract.serverUserAgent, null);
  assert.match(service.status().additionalContextContract.error, /additionalContext/);
  assert.equal(statuses.some((status) => status.phase === "codex_context_protocol_error"), true);
  assert.equal(service.status().active, false);
  service.dispose();
});

test("a disposed RPC generation cannot clear the replacement App Server", async () => {
  const instances = [];
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => {
      const rpc = new FakeRpc(options);
      instances.push(rpc);
      return rpc;
    },
  });
  await service.prepare();
  const oldRpc = instances[0];
  service.dispose();
  await service.prepare();
  const replacement = instances[1];

  oldRpc.options.onExit(new Error("late close from old child"));

  assert.equal(service.rpc, replacement);
  assert.equal(service.status().ready, true);
  assert.equal(service.status().threadId, "thr-persistent-1");
  service.dispose();
});

test("current App Server requests receive schema-valid decisions and brokerage writes are declined", async () => {
  const rpcInstances = [];
  const service = createService({ store: new MemoryStore(), rpcInstances });
  await service.prepare();
  const rpc = rpcInstances[0];
  const send = (id, method, params = {}) => rpc.options.onServerRequest({ id, method, params });

  send(201, "item/tool/requestUserInput", {
    threadId: "thr-persistent-1",
    turnId: "turn-approval",
    questions: [{ id: "choice", question: "继续？", options: null }],
  });
  send(202, "item/commandExecution/requestApproval", {
    threadId: "thr-persistent-1",
    command: "node local-analysis.mjs",
  });
  send(203, "item/commandExecution/requestApproval", {
    threadId: "thr-persistent-1",
    command: "curl https://mcp.longbridge.com/submit_order",
  });
  send(204, "item/fileChange/requestApproval", { threadId: "thr-persistent-1" });
  send(205, "item/permissions/requestApproval", {
    threadId: "thr-persistent-1",
    permissions: { network: { enabled: true }, fileSystem: null },
  });
  send(206, "mcpServer/elicitation/request", { threadId: "thr-persistent-1" });
  send(207, "item/commandExecution/requestApproval", {
    threadId: "thr-persistent-1", command: ["python", "-c", "ib.placeOrder(contract, order)"],
  });
  send(208, "item/commandExecution/requestApproval", {
    threadId: "thr-persistent-1", command: "curl -X POST https://unknown.example/v1/transfers",
  });
  send(209, "execCommandApproval", {
    threadId: "thr-persistent-1", command: "ibkr cancel_order",
  });

  assert.deepEqual(rpc.results.find((entry) => entry.id === 201)?.result, { answers: {} });
  assert.deepEqual(rpc.results.find((entry) => entry.id === 202)?.result, { decision: "accept" });
  assert.deepEqual(rpc.results.find((entry) => entry.id === 203)?.result, { decision: "decline" });
  assert.deepEqual(rpc.results.find((entry) => entry.id === 204)?.result, { decision: "accept" });
  assert.deepEqual(rpc.results.find((entry) => entry.id === 205)?.result, {
    permissions: { network: { enabled: true } },
    scope: "turn",
    strictAutoReview: false,
  });
  assert.deepEqual(rpc.results.find((entry) => entry.id === 206)?.result, {
    action: "decline",
    content: null,
    _meta: null,
  });
  assert.deepEqual(rpc.results.find((entry) => entry.id === 207)?.result, { decision: "decline" });
  assert.deepEqual(rpc.results.find((entry) => entry.id === 208)?.result, { decision: "decline" });
  assert.deepEqual(rpc.results.find((entry) => entry.id === 209)?.result,
    { decision: { denied: { rejection: "Brokerage transaction writes are disabled in this cockpit." } } });
  service.dispose();
});

test("consecutive reconciler transport failures end in a retryable terminal state", async () => {
  const statuses = [];
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    onStatus: (status) => statuses.push(status),
    rpcFactory: (options) => new TransportFailureReconcileRpc(options),
  });
  await service.prepare();
  const analysis = service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "验证终态传输断路器",
    operationId: "operation-transport-failure",
  });
  const rejected = assert.rejects(analysis, /连续 4 次无法读取持久终态/);
  await waitUntil(() => service.status().activeThreads[0]?.turnId === "turn-transport-failure");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await service.reconcileActiveTurn({
      threadId: "thr-persistent-1",
      operationId: "operation-transport-failure",
    });
  }
  assert.equal(statuses.some((status) => status.phase === "codex_transport_terminal"), true);
  await rejected;
  assert.equal(service.status().active, false);
  service.dispose();
});

test("transport failure after one final segment returns terminal_unverified with preserved partial text", async () => {
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    rpcFactory: (options) => (rpc = new TransportFailureReconcileRpc(options)),
  });
  await service.prepare();
  try {
    const analysis = service.analyze({ portfolio: portfolioFixture(), run: runFixture(),
      task: "断连保留片段", operationId: "partial-transport-operation" });
    const rejection = assert.rejects(analysis, (error) => error.kind === "terminal_unverified"
      && error.deliveryStatus === "terminal_unverified" && error.partialText === "收到的第一段"
      && error.partial === true && error.complete === false
      && error.turnId === "turn-transport-failure");
    await waitUntil(() => service.status().activeThreads[0]?.turnId === "turn-transport-failure");
    rpc.options.onNotification({ method: "item/completed", params: {
      threadId: "thr-persistent-1", turnId: "turn-transport-failure",
      item: { type: "agentMessage", id: "partial-final", phase: "final_answer", text: "收到的第一段" },
    } });
    for (let index = 0; index < 4; index += 1) await service.reconcileActiveTurn({
      threadId: "thr-persistent-1", operationId: "partial-transport-operation",
    });
    await rejection;
    assert.equal(rpc.calls.some((call) => call.method === "turn/interrupt"), false);
  } finally { service.dispose(); }
});

test("App Server exit after a final segment preserves it without certifying completion", async () => {
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    rpcFactory: (options) => (rpc = new FinalAnswerWithoutTurnCompletionRpc(options)),
  });
  await service.prepare();
  try {
    const analysis = service.analyze({ portfolio: portfolioFixture(), run: runFixture(), task: "连接退出时保留片段" });
    const rejection = assert.rejects(analysis, (error) => error.kind === "terminal_unverified"
      && error.partialText === "final answer without turn completed" && error.complete === false);
    await waitUntil(() => service.status().activeThreads[0]?.turnId === "turn-final-only");
    rpc.options.onExit(new Error("simulated connection exit"));
    await rejection;
  } finally { service.dispose(); }
});

test("App Server RPC uses the official persistent stdio protocol without exec restriction flags", async () => {
  const sent = [];
  let spawnArgs;
  const child = scriptedChild(sent);
  const rpc = new CodexAppServerRpc({
    codexPath: "/fake/codex",
    cwd: "/tmp/stock-agent-workspace",
    clientVersion: "0.5.0",
    inspectFeatures: () => assert.fail("inherit mode must not inspect features"),
    spawnImpl: (_path, args, options) => {
      spawnArgs = { args, options };
      return child;
    },
  });
  await rpc.start();
  assert.deepEqual(spawnArgs.args, ["app-server", "--stdio"]);
  assert.equal(spawnArgs.args.includes("--ephemeral"), false);
  assert.equal(spawnArgs.args.includes("--ignore-user-config"), false);
  assert.equal(spawnArgs.options.cwd, "/tmp/stock-agent-workspace");
  assert.deepEqual(spawnArgs.options.env, { ...process.env });
  assert.equal(sent[0].method, "initialize");
  assert.equal(sent[1].method, "initialized");
  rpc.dispose();
});

test("App Server system network mode validates native capability and preserves every environment variable", async () => {
  const environment = Object.freeze({ HTTPS_PROXY: "", https_proxy: "http://private:secret@proxy.test:7", NO_PROXY: "<local>,localhost", no_proxy: "unchanged", OTHER: "sentinel" });
  const states = [];
  let inspection;
  let spawnCall;
  const child = scriptedChild([]);
  const rpc = new CodexAppServerRpc({
    codexPath: "/fake/codex", cwd: "/tmp/network-workspace", clientVersion: "test",
    networkMode: "system", environment,
    inspectFeatures: async options => { inspection = options; return "respect_system_proxy under development false"; },
    onNetworkState: state => states.push(state),
    spawnImpl: (binary, args, options) => { spawnCall = { binary, args, options }; return child; },
  });
  try {
    await rpc.start();
    assert.deepEqual(spawnCall.args, ["app-server", "--stdio", "--enable", "respect_system_proxy"]);
    assert.deepEqual(spawnCall.options.env, environment);
    assert.notEqual(spawnCall.options.env, environment);
    assert.equal(inspection.env, spawnCall.options.env);
    assert.deepEqual(states.map(state => state.status), ["checking", "ready"]);
    assert.equal(rpc.networkState.stage, "under development");
    assert.equal(rpc.networkState.experimental, true);
    assert.doesNotMatch(JSON.stringify(states), /private|secret|proxy\.test|sentinel/);
  } finally { rpc.dispose(); }
});

test("unsupported, failed, and timed-out system feature checks never launch App Server", async () => {
  for (const [inspectFeatures, code] of [
    [async () => "respect_system_proxy removed false", "unsupported"],
    [async () => "unrelated stable true", "unsupported"],
    [async () => { throw new Error("private token error"); }, "inspection_failed"],
    [() => new Promise(() => {}), "inspection_timeout"],
  ]) {
    const rpc = new CodexAppServerRpc({
      codexPath: "/fake/codex", networkMode: "system", networkInspectionTimeoutMs: 10, inspectFeatures,
      spawnImpl: () => assert.fail("App Server must not launch"),
    });
    await assert.rejects(rpc.start(), error => error.code === code && !error.message.includes("private"));
    assert.equal(rpc.networkState.status, "failed");
    assert.equal(rpc.networkState.errorCode, code);
    assert.equal(rpc.ready, false);
    rpc.dispose();
  }
});

test("invalid stored network mode is recoverable UI state but cannot spawn a process", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    networkMode: "system --disable apps;private-token",
    rpcFactory: options => new CodexAppServerRpc({ ...options, spawnImpl: () => assert.fail("invalid mode must not spawn") }),
  });
  try {
    assert.equal(service.status().network.mode, "unsupported");
    assert.equal(service.capabilities().network.errorCode, "invalid_mode");
    assert.doesNotMatch(JSON.stringify(service.status().network), /private-token|disable apps/);
    await assert.rejects(service.prepare(), error => error.code === "invalid_mode");
  } finally { service.dispose(); }
});

test("disposing during system capability inspection prevents a late background spawn", async () => {
  let finishInspection;
  const rpc = new CodexAppServerRpc({
    codexPath: "/fake/codex", networkMode: "system",
    inspectFeatures: () => new Promise(resolve => { finishInspection = resolve; }),
    spawnImpl: () => assert.fail("disposed startup must not spawn"),
  });
  const starting = rpc.start();
  await waitUntil(() => finishInspection);
  rpc.dispose();
  finishInspection("respect_system_proxy under development false");
  await assert.rejects(starting, /启动已取消/);
  assert.equal(rpc.ready, false);
});

test("concurrent RPC starts share one native capability inspection and one process", async () => {
  let finishInspection;
  let inspections = 0;
  let spawns = 0;
  const rpc = new CodexAppServerRpc({
    codexPath: "/fake/codex", networkMode: "system",
    inspectFeatures: () => { inspections += 1; return new Promise(resolve => { finishInspection = resolve; }); },
    spawnImpl: () => { spawns += 1; return scriptedChild([]); },
  });
  try {
    const first = rpc.start();
    const second = rpc.start();
    await waitUntil(() => finishInspection);
    finishInspection("respect_system_proxy under development false");
    await Promise.all([first, second]);
    assert.equal(inspections, 1);
    assert.equal(spawns, 1);
  } finally { rpc.dispose(); }
});

test("workspace forwards network mode and publishes sanitized runtime stage in status and capabilities", async () => {
  let rpc;
  const statuses = [];
  const capabilities = [];
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    networkMode: "system", onStatus: status => statuses.push(status), onCapabilities: value => capabilities.push(value),
    rpcFactory: options => (rpc = new class extends FakeRpc {
      async start() {
        await super.start();
        this.options.onNetworkState({ status: "ready", stage: "under development", url: "private" });
      }
    }(options)),
  });
  try {
    await service.prepare();
    await waitUntil(() => capabilities.length);
    assert.equal(rpc.options.networkMode, "system");
    assert.equal(service.status().network.stage, "under development");
    assert.equal(service.capabilities().network.experimental, true);
    assert.ok(statuses.some(status => status.phase === "codex_network_ready"));
    assert.doesNotMatch(JSON.stringify(service.capabilities().network), /private/);
    const staleCallback = rpc.options.onNetworkState;
    service.dispose();
    staleCallback({ status: "failed", errorCode: "inspection_failed" });
    assert.equal(service.status().network.status, "ready");
  } finally { service.dispose(); }
});

test("App Server RPC preserves JSON-RPC diagnostics for turn contract failures", async () => {
  const sent = [];
  const child = scriptedChild(sent);
  const rpc = new CodexAppServerRpc({
    codexPath: "/fake/codex",
    cwd: "/tmp/stock-agent-workspace",
    clientVersion: "0.5.0",
    spawnImpl: () => child,
  });
  await rpc.start();
  const pending = rpc.request("turn/start", {
    threadId: "thr-contract",
    input: [{ type: "text", text: "contract check" }],
    additionalContext: {
      evidence: { kind: "application", value: "{}" },
    },
  });
  const request = sent.find((message) => message.method === "turn/start");
  child.stdout.write(`${JSON.stringify({
    id: request.id,
    error: {
      code: -32602,
      message: "Invalid params: unknown field additionalContext",
      data: { field: "additionalContext" },
    },
  })}\n`);
  await assert.rejects(pending, (error) => {
    assert.equal(error.kind, "rpc");
    assert.equal(error.rpcCode, -32602);
    assert.equal(error.rpcMethod, "turn/start");
    assert.deepEqual(error.rpcData, { field: "additionalContext" });
    return true;
  });
  rpc.dispose();
});

test("App Server initialization fails clearly when experimentalApi is unsupported", async () => {
  const sent = [];
  const child = scriptedChild(sent, {
    initializeError: {
      code: -32602,
      message: "Invalid params: unknown field experimentalApi",
      data: { field: "experimentalApi" },
    },
  });
  const rpc = new CodexAppServerRpc({
    codexPath: "/fake/codex",
    cwd: "/tmp/stock-agent-workspace",
    clientVersion: "0.5.0",
    spawnImpl: () => child,
  });
  await assert.rejects(rpc.start(), (error) => {
    assert.equal(error.kind, "protocol");
    assert.equal(error.rpcCode, -32602);
    assert.equal(error.rpcMethod, "initialize");
    assert.match(error.message, /experimentalApi/);
    assert.match(error.message, /additionalContext/);
    assert.match(error.message, /不会.*普通 text/);
    return true;
  });
  assert.equal(sent.filter((message) => message.method === "initialize").length, 1);
  assert.equal(sent.some((message) => message.method === "initialized"), false);
  rpc.dispose();
});

function createService({ store, rpcInstances, onStream = () => {} }) {
  return new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    clientVersion: "0.5.0",
    onStream,
    rpcFactory: (options) => {
      const rpc = new FakeRpc(options);
      rpcInstances.push(rpc);
      return rpc;
    },
  });
}

class MemoryStore {
  constructor() {
    this.values = new Map();
  }
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async set(key, value) {
    this.values.set(key, structuredClone(value));
  }
}

class FakeRpc {
  constructor(options) {
    this.options = options;
    this.calls = [];
    this.ready = false;
  }
  async start() {
    this.ready = true;
  }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "config/read") return { config: {} };
    if (method === "app/installed") return { apps: [] };
    if (method === "thread/loaded/list") return { data: [], nextCursor: null };
    if (method === "thread/start" || method === "thread/resume") {
      return {
        thread: {
          id: "thr-persistent-1",
          ephemeral: false,
          createdAt: Math.floor(Date.now() / 1_000),
        },
        cwd: "/tmp/stock-agent-workspace",
        model: "test-model",
        modelProvider: "openai",
        instructionSources: ["/tmp/stock-agent-workspace/AGENTS.md"],
      };
    }
    if (method === "skills/list") {
      return { data: [{ cwd: params.cwds[0], errors: [], skills: [
        {
          name: "technical-structure",
          path: "/skills/technical-structure/SKILL.md",
          description: "Technical analysis",
          enabled: true,
          scope: "user",
        },
        {
          name: "analyze-market-narratives",
          path: "/skills/analyze-market-narratives/SKILL.md",
          description: "Narrative and exposure analysis",
          enabled: true,
          scope: "user",
        },
        {
          name: "analyze-technical-structure",
          path: "/skills/analyze-technical-structure/SKILL.md",
          description: "EMA, Fib, and timing analysis",
          enabled: true,
          scope: "user",
        },
        {
          name: "review-earnings-decisions",
          path: "/skills/review-earnings-decisions/SKILL.md",
          description: "Review selected earnings orders and validate rules",
          enabled: true,
          scope: "repo",
        },
        {
          name: "review-decision-cycles",
          path: "/skills/review-decision-cycles/SKILL.md",
          description: "Review catalyst, position lifecycle, and monthly decision cycles",
          enabled: true,
          scope: "repo",
        },
      ] }] };
    }
    if (method === "mcpServerStatus/list") {
      return { data: [{
        name: "market",
        authStatus: "oAuth",
        tools: { quote: { name: "quote", title: "Quote", description: "Latest quote" } },
      }] };
    }
    if (method === "app/list") {
      return { data: [
        { id: "research-app", name: "Research", description: "Research data", isAccessible: true, isEnabled: true },
        { id: "hidden-app", name: "Hidden", isAccessible: false, isEnabled: true },
      ] };
    }
    if (method === "thread/turns/list") {
      return { data: [], nextCursor: null };
    }
    if (method === "thread/compact/start") {
      setImmediate(() => {
        this.options.onNotification({ method: "thread/tokenUsage/updated", params: {
          threadId: params.threadId,
          tokenUsage: { modelContextWindow: 100_000, last: { totalTokens: 100 } },
        } });
        this.options.onNotification({ method: "turn/completed", params: {
          threadId: params.threadId, turn: { id: "compact-fixture", status: "completed", items: [] },
        } });
      });
      return {};
    }
    if (method === "turn/start") {
      setImmediate(() => {
        const blindReview = JSON.stringify(params.additionalContext ?? {})
          .includes('\\"reviewPhase\\":\\"blind\\"');
        this.options.onNotification({ method: "item/agentMessage/delta", params: {
          threadId: "thr-persistent-1", turnId: "turn-1", itemId: "msg-1", delta: "持久 Codex ",
        } });
        const tool = {
          type: "mcpToolCall", id: "tool-1", server: "market", tool: "quote",
          arguments: {}, status: "completed",
        };
        if (!blindReview) {
          this.options.onNotification({ method: "item/completed", params: {
            threadId: "thr-persistent-1", turnId: "turn-1", item: tool,
          } });
        }
        this.options.onNotification({ method: "item/completed", params: {
          threadId: "thr-persistent-1", turnId: "turn-1",
          item: { type: "agentMessage", id: "msg-1", text: "持久 Codex 已结合 MCP 完成分析。" },
        } });
        this.options.onNotification({ method: "turn/completed", params: {
          threadId: "thr-persistent-1",
          turn: {
            id: "turn-1", status: "completed",
            items: [{ type: "agentMessage", id: "msg-1", text: "持久 Codex 已结合 MCP 完成分析。" }],
          },
        } });
      });
      return { turn: { id: "turn-1", status: "inProgress", items: [] } };
    }
    return {};
  }
  respondResult(id, result) {
    this.results ??= [];
    this.results.push({ id, result });
  }
  respondError() {}
  dispose() {
    this.ready = false;
  }
}

class StructuredReviewRpc extends FakeRpc {
  constructor(options, response) {
    super(options);
    this.response = response;
  }
  async request(method, params) {
    if (method !== "turn/start") return super.request(method, params);
    this.calls.push({ method, params });
    setImmediate(() => {
      const item = {
        type: "agentMessage",
        id: "structured-review-message",
        phase: "final_answer",
        text: this.response,
      };
      this.options.onNotification({
        method: "item/completed",
        params: { threadId: "thr-persistent-1", turnId: "structured-review-turn", item },
      });
      this.options.onNotification({
        method: "turn/completed",
        params: {
          threadId: "thr-persistent-1",
          turn: { id: "structured-review-turn", status: "completed", items: [item] },
        },
      });
    });
    return { turn: { id: "structured-review-turn", status: "inProgress", items: [] } };
  }
}

class BlindToolStartRpc extends FakeRpc {
  async request(method, params) {
    if (method !== "turn/start") return super.request(method, params);
    this.calls.push({ method, params });
    setImmediate(() => {
      this.options.onNotification({
        method: "item/started",
        params: {
          threadId: "thr-persistent-1",
          turnId: "blind-tool-turn",
          item: {
            type: "mcpToolCall",
            id: "blind-tool",
            server: "market",
            tool: "quote",
            status: "inProgress",
          },
        },
      });
    });
    return { turn: { id: "blind-tool-turn", status: "inProgress", items: [] } };
  }
}

class BlindCompletedOnlyRpc extends FakeRpc {
  async request(method, params) {
    if (method !== "turn/start") return super.request(method, params);
    this.calls.push({ method, params });
    setImmediate(() => {
      this.options.onNotification({
        method: "item/completed",
        params: {
          threadId: "thr-persistent-1",
          turnId: "blind-completed-only-turn",
          item: {
            type: "mcpToolCall",
            id: "blind-completed-only-tool",
            server: "market",
            tool: "quote",
            status: "completed",
            result: "COMPLETED_SECRET",
          },
        },
      });
    });
    return { turn: { id: "blind-completed-only-turn", status: "inProgress", items: [] } };
  }
}

class BlindRecoveredToolRpc extends FakeRpc {
  constructor(options) {
    super(options);
    this.turnStarted = false;
    this.exposeRecoveredTurn = false;
  }
  async request(method, params) {
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      if (!this.turnStarted || !this.exposeRecoveredTurn) {
        return { data: [], nextCursor: null };
      }
      return {
        data: [{
          id: "blind-recovered-turn",
          status: "completed",
          items: [
            {
              type: "mcpToolCall",
              id: "blind-recovered-tool",
              server: "market",
              tool: "quote",
              status: "completed",
              result: "RECOVERED_SECRET",
            },
            {
              type: "agentMessage",
              id: "blind-recovered-answer",
              phase: "final_answer",
              text: "RECOVERED_SECRET",
            },
          ],
        }],
        nextCursor: null,
      };
    }
    if (method === "turn/start") {
      this.calls.push({ method, params });
      this.turnStarted = true;
      return { turn: { id: "blind-recovered-turn", status: "inProgress", items: [] } };
    }
    return super.request(method, params);
  }
}

class PriorHistoryRpc extends FakeRpc {
  async request(method, params) {
    if (method !== "thread/turns/list") return super.request(method, params);
    this.calls.push({ method, params });
    return {
      data: [{
        id: "ordinary-prior-turn",
        status: "completed",
        items: [{ type: "agentMessage", id: "prior", text: "既有普通分析" }],
      }],
      nextCursor: null,
    };
  }
}

class BlindLateLeakRpc extends FakeRpc {
  async request(method, params) {
    if (method === "turn/interrupt") {
      this.calls.push({ method, params });
      throw new Error("interrupt acknowledgement lost");
    }
    if (method !== "turn/start") return super.request(method, params);
    this.calls.push({ method, params });
    setImmediate(() => {
      const envelope = { threadId: "thr-persistent-1", turnId: "blind-late-turn" };
      this.options.onNotification({
        method: "item/started",
        params: {
          ...envelope,
          item: {
            type: "mcpToolCall",
            id: "blind-late-tool",
            server: "market",
            tool: "quote",
            status: "inProgress",
          },
        },
      });
      this.options.onServerRequest({
        id: 901,
        method: "item/commandExecution/requestApproval",
        params: { ...envelope, command: "node leaked.mjs" },
      });
      this.options.onServerRequest({
        id: 902,
        method: "item/fileChange/requestApproval",
        params: envelope,
      });
      this.options.onServerRequest({
        id: 903,
        method: "item/permissions/requestApproval",
        params: { ...envelope, permissions: { network: { enabled: true } } },
      });
      this.options.onServerRequest({
        id: 904,
        method: "execCommandApproval",
        params: { turnId: envelope.turnId, command: "node leaked.mjs" },
      });
      this.options.onServerRequest({
        id: 905,
        method: "item/tool/call",
        params: {
          ...envelope,
          tool: "query_recent_history",
          arguments: { query: "future" },
        },
      });
      this.options.onNotification({
        method: "item/completed",
        params: {
          ...envelope,
          item: {
            type: "mcpToolCall",
            id: "blind-late-tool",
            server: "market",
            tool: "quote",
            status: "completed",
            result: "LATE_SECRET",
          },
        },
      });
      this.options.onNotification({
        method: "item/agentMessage/delta",
        params: { ...envelope, itemId: "late-message", delta: "LATE_SECRET" },
      });
      this.options.onNotification({
        method: "turn/completed",
        params: {
          threadId: envelope.threadId,
          turn: {
            id: envelope.turnId,
            status: "completed",
            items: [{
              type: "agentMessage",
              id: "late-message",
              phase: "final_answer",
              text: "LATE_SECRET",
            }],
          },
        },
      });
    });
    return { turn: { id: "blind-late-turn", status: "inProgress", items: [] } };
  }
}

class MissingReviewSkillRpc extends FakeRpc {
  async request(method, params) {
    if (method !== "skills/list") return super.request(method, params);
    this.calls.push({ method, params });
    return { data: [{ cwd: params.cwds[0], errors: [], skills: [{
      name: "analyze-market-narratives",
      path: "/skills/analyze-market-narratives/SKILL.md",
      description: "Narrative analysis",
      enabled: true,
      scope: "user",
    }] }] };
  }
}

class HangingInventoryRpc extends FakeRpc {
  async request(method, params) {
    if (["skills/list", "mcpServerStatus/list", "app/list"].includes(method)) {
      this.calls.push({ method, params });
      return new Promise(() => {});
    }
    return super.request(method, params);
  }
}

class IndependentInventoryRpc extends FakeRpc {
  constructor(options) {
    super(options);
    this.firstAppList = new Promise((resolve) => {
      this.resolveFirstAppListRequest = resolve;
    });
    this.appListCalls = 0;
  }
  async request(method, params) {
    if (method === "app/list") {
      this.calls.push({ method, params });
      this.appListCalls += 1;
      if (this.appListCalls === 1) return this.firstAppList;
      return { data: [{
        id: "research-app",
        name: "Research",
        description: "Research data",
        isAccessible: true,
        isEnabled: true,
      }] };
    }
    return super.request(method, params);
  }
  resolveFirstAppList() {
    this.resolveFirstAppListRequest({ data: [] });
  }
}

class SelfUpdatingAppInventoryRpc extends FakeRpc {
  async request(method, params) {
    const result = await super.request(method, params);
    if (method === "app/list") {
      // Accessible and directory source loading each emit the latest merged
      // snapshot; every forceRefetch does this again in the real protocol.
      for (let source = 0; source < 2; source++) {
        this.options.onNotification({ method: "app/list/updated", params: { data: result.data } });
      }
    }
    return result;
  }
}

class PaginatedMcpInventoryRpc extends FakeRpc {
  constructor(options) {
    super(options);
    this.secondPage = new Promise((resolve) => {
      this.resolveSecondPageRequest = resolve;
    });
  }
  async request(method, params) {
    if (method !== "mcpServerStatus/list") return super.request(method, params);
    this.calls.push({ method, params });
    if (params.cursor == null) {
      return {
        data: [{
          name: "market",
          authStatus: "oAuth",
          tools: { quote: { name: "quote", title: "Quote", description: "Latest quote" } },
        }],
        nextCursor: "mcp-page-2",
      };
    }
    assert.equal(params.cursor, "mcp-page-2");
    return this.secondPage;
  }
  resolveSecondPage() {
    this.resolveSecondPageRequest({
      data: [{
        name: "broker_data",
        serverInfo: { title: "Broker data", websiteUrl: "https://mcp.longbridge.com" },
        authStatus: "oAuth",
        tools: {
          quote: { name: "quote", title: "Quote", description: "Latest quote" },
          submit_bracket_order: {
            name: "submit_bracket_order",
            title: "Submit bracket order",
            description: "Place a bracket order",
          },
        },
      }],
      nextCursor: null,
    });
  }
}

class ConfigurableBrokerRpc extends FakeRpc {
  constructor(options, fixture) {
    super(options);
    this.fixture = fixture;
  }
  async request(method, params) {
    if (method === "config/read") {
      this.calls.push({ method, params });
      return { config: this.fixture.guarded ? { mcp_servers: { [this.fixture.name]: {
        url: "https://api.interactivebrokers.com/v1/api",
      } } } : {} };
    }
    if (method === "mcpServerStatus/list") {
      this.calls.push({ method, params });
      return { data: [{ name: this.fixture.name, authStatus: "oAuth",
        tools: Object.fromEntries(this.fixture.tools.map((name) => [name, {
          name, description: name, annotations: { readOnlyHint: true },
        }])),
      }] };
    }
    return super.request(method, params);
  }
}

class GuardedLongbridgeRpc extends FakeRpc {
  async request(method, params) {
    if (method === "config/read") {
      this.calls.push({ method, params });
      return {
        config: {
          mcp_servers: {
            broker_data: {
              url: "https://mcp.longbridge.com/v2",
              disabled_tools: ["existing_disabled"],
            },
          },
          apps: { longbridge: { enabled: true } },
        },
      };
    }
    if (method === "app/list") {
      this.calls.push({ method, params });
      return { data: [
        { id: "longbridge", name: "Longbridge", isAccessible: true, isEnabled: true },
        { id: "research-app", name: "Research", isAccessible: true, isEnabled: true },
      ] };
    }
    if (method === "mcpServerStatus/list") {
      this.calls.push({ method, params });
      return { data: [{
        name: "broker_data",
        serverInfo: { title: "Broker data", websiteUrl: "https://mcp.longbridge.com" },
        authStatus: "oAuth",
        tools: {
          quote: { name: "quote", title: "Quote", description: "Latest quote" },
          stock_positions: { name: "stock_positions", title: "Positions", description: "Positions" },
          submit_order: { name: "submit_order", title: "Submit order", description: "Place an order" },
        },
      }] };
    }
    return super.request(method, params);
  }
}

class UnguardedLongbridgeRpc extends FakeRpc {
  async request(method, params) {
    if (method === "config/read") {
      this.calls.push({ method, params });
      return { config: {} };
    }
    if (method === "app/list") {
      this.calls.push({ method, params });
      return { data: [] };
    }
    if (method === "mcpServerStatus/list") {
      this.calls.push({ method, params });
      return { data: [{
        name: "longbridge-proxy",
        authStatus: "oAuth",
        tools: {
          quote: { name: "quote", title: "Quote", description: "Latest quote" },
          submit_order: { name: "submit_order", title: "Submit order", description: "Place an order" },
        },
      }] };
    }
    return super.request(method, params);
  }
}

class GuardedNovelWriteRpc extends GuardedLongbridgeRpc {
  async request(method, params) {
    const result = await super.request(method, params);
    if (method === "mcpServerStatus/list") {
      result.data[0].tools.submit_bracket_order = {
        name: "submit_bracket_order",
        title: "Submit bracket order",
        description: "Place a bracket order",
      };
    }
    return result;
  }
}

class GuardedUnknownToolRpc extends GuardedLongbridgeRpc {
  async request(method, params) {
    const result = await super.request(method, params);
    if (method === "mcpServerStatus/list") {
      result.data[0].tools.buy_stock = {
        name: "buy_stock",
        title: "Buy stock",
        description: "Buy a stock",
        annotations: { readOnlyHint: true, destructiveHint: false },
      };
    }
    return result;
  }
}

class MultiSessionRpc extends FakeRpc {
  constructor(options, { hangingTurns = false } = {}) {
    super(options);
    this.hangingTurns = hangingTurns;
    this.nextThreadNumber = 1;
    this.threads = new Map();
    this.turns = new Map();
  }
  async request(method, params) {
    if (method === "thread/start") {
      this.calls.push({ method, params });
      const id = `thr-session-${this.nextThreadNumber++}`;
      const now = new Date().toISOString();
      this.threads.set(id, {
        id,
        name: "交易驾驶舱 Agent",
        preview: "",
        createdAt: now,
        updatedAt: now,
        recencyAt: now,
      });
      return this.#threadResponse(id);
    }
    if (method === "thread/resume") {
      this.calls.push({ method, params });
      if (!this.threads.has(params.threadId)) throw new Error("missing thread");
      return this.#threadResponse(params.threadId);
    }
    if (method === "thread/name/set") {
      this.calls.push({ method, params });
      const thread = this.threads.get(params.threadId);
      if (thread) thread.name = params.name;
      return {};
    }
    if (method === "thread/list") {
      this.calls.push({ method, params });
      return { data: [...this.threads.values()], nextCursor: null };
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      return { data: this.turns.get(params.threadId) ?? [], nextCursor: null };
    }
    if (method === "turn/start" && this.hangingTurns) {
      this.calls.push({ method, params });
      return { turn: { id: "turn-session-hanging", status: "inProgress", items: [] } };
    }
    if (method === "turn/interrupt" && this.hangingTurns) {
      this.calls.push({ method, params });
      return {};
    }
    return super.request(method, params);
  }
  completeThread(threadId, text) {
    const turn = {
      id: "turn-session-hanging",
      status: "completed",
      items: [{ type: "agentMessage", id: `message-${threadId}`, phase: "final_answer", text }],
    };
    this.turns.set(threadId, [turn]);
    this.options.onNotification({
      method: "turn/completed",
      params: { threadId, turn },
    });
  }
  #threadResponse(id) {
    const thread = this.threads.get(id);
    return {
      thread: {
        id,
        ephemeral: false,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      },
      cwd: "/tmp/stock-agent-workspace",
      model: "test-model",
      modelProvider: "openai",
      instructionSources: ["/tmp/stock-agent-workspace/AGENTS.md"],
      initialTurnsPage: {
        data: this.turns.get(id) ?? [],
        nextCursor: null,
      },
    };
  }
}

class LifecycleRaceRpc extends MultiSessionRpc {
  constructor(options) {
    super(options);
    this.starts = [];
  }
  async request(method, params) {
    if (method === "turn/start") {
      this.calls.push({ method, params });
      return new Promise(resolve => this.starts.push({ params, resolve }));
    }
    if (method === "turn/interrupt" || method === "thread/compact/start") {
      this.calls.push({ method, params });
      return {};
    }
    if (method === "thread/items/list") return { data: [], nextCursor: null };
    return super.request(method, params);
  }
  acceptStart(index, turnId) {
    this.starts[index].resolve({ turn: { id: turnId, status: "inProgress", items: [] } });
  }
  finish(threadId, turnId, text, status = "completed") {
    const items = text ? [{ type: "agentMessage", id: `message-${turnId}`, phase: "final_answer", text }] : [];
    if (items.length) this.options.onNotification({ method: "item/completed", params: { threadId, turnId, item: items[0] } });
    this.options.onNotification({ method: "turn/completed", params: { threadId, turn: { id: turnId, status, items } } });
  }
}

function brokerAppIdentity() {
  return { id: "asdk_app_fixture_ibkr", name: "Interactive Brokers (IBKR)", description: "Analyze global markets", isAccessible: true, isEnabled: true };
}

function assertBrokerAppOverrides(config) {
  assert.equal(config.apps._default.destructive_enabled, false);
  for (const operation of ["create_order_instruction", "delete_order_instruction"]) {
    assert.equal(config.apps.asdk_app_fixture_ibkr.tools[operation].enabled, false);
    assert.equal(config.apps.asdk_app_fixture_ibkr.tools[`interactive_brokers_ibkr.${operation}`].enabled, false);
  }
}

function brokerAppFixture(options = {}) {
  const rpc = new SharedBrokerAppRpc({}, options);
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex", workspaceDirectory: "/tmp/stock-agent-workspace", store: new MemoryStore(),
    rpcFactory: callbacks => { rpc.options = callbacks; return rpc; },
  });
  return { service, rpc };
}

class SharedBrokerAppRpc extends MultiSessionRpc {
  constructor(options, fixture = {}) {
    super(options, { hangingTurns: true });
    this.fixture = { exposeWrites: true, apps: [brokerAppIdentity()], ...fixture };
    this.configs = new Map();
    this.loaded = new Set();
  }
  async start() { await super.start(); this.loaded.clear(); }
  async request(method, params) {
    if (method === "app/installed") {
      this.calls.push({ method, params });
      return { apps: this.fixture.installedApps ?? this.fixture.apps.map(app => ({ id: app.id, runtimeName: app.name, enabled: true, callable: true })) };
    }
    if (method === "thread/loaded/list") {
      this.calls.push({ method, params });
      return { data: [...this.loaded], nextCursor: null };
    }
    if (method === "config/read" && this.fixture.deferConfig) {
      this.calls.push({ method, params });
      await new Promise(resolve => { this.releaseConfig = resolve; });
      return { config: {} };
    }
    if (method === "thread/start" || method === "thread/resume") {
      if (method === "thread/resume" && this.fixture.resumeError) {
        this.calls.push({ method, params });
        throw new CodexWorkspaceError("read_only_guard", "thread/resume fixture rejected");
      }
      const hot = method === "thread/resume" && this.loaded.has(params.threadId);
      if (method === "thread/start" && this.fixture.deferNextStart) {
        this.fixture.deferNextStart = false;
        await new Promise(resolve => { this.releaseStart = resolve; });
      }
      const response = await super.request(method, params);
      if (!hot) this.configs.set(response.thread.id, structuredClone(params.config));
      this.loaded.add(response.thread.id);
      return response;
    }
    if (method === "app/list") {
      this.calls.push({ method, params });
      if (this.fixture.appsError) throw new Error("403 Forbidden");
      return { data: structuredClone(this.fixture.apps), nextCursor: null };
    }
    if (method === "mcpServerStatus/list") {
      this.calls.push({ method, params });
      const policies = this.configs.get(params.threadId)?.apps?.asdk_app_fixture_ibkr?.tools ?? {};
      if (this.fixture.verificationError && Object.keys(policies).length) {
        throw new Error("fixture post-config inventory unavailable");
      }
      const operations = ["get_positions", "get_order_cancel_status", ...(this.fixture.exposeWrites
        ? ["create_order_instruction", "delete_order_instruction"] : []), ...(this.fixture.extraWrites ?? [])];
      const entries = operations.map(operation => {
        const name = `interactive_brokers_ibkr.${operation}`;
        return [name, { name, description: operation.includes("instruction") ? "Manage an order instruction, not a live order" : "Query account data",
          annotations: { destructiveHint: false, readOnlyHint: !operation.includes("instruction") } }];
      }); // Real runtime: raw catalog retains entries disabled by App policy.
      entries.push(["tasks.cancel_task", { name: "tasks.cancel_task", description: "Cancel a research task" }]);
      return { data: [{ name: "codex_apps", authStatus: "bearerToken", tools: Object.fromEntries(entries) }], nextCursor: null };
    }
    return super.request(method, params);
  }
}

class HistoryHydrationFailureRpc extends MultiSessionRpc {
  async request(method, params) {
    if (method === "thread/resume") {
      const response = await super.request(method, params);
      delete response.initialTurnsPage;
      return response;
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      throw new CodexWorkspaceError("timeout", "thread/turns/list 请求超时。");
    }
    return super.request(method, params);
  }
}

class HangingTurnRpc extends FakeRpc {
  async request(method, params) {
    if (method === "turn/start") {
      this.calls.push({ method, params });
      return { turn: { id: "turn-hanging", status: "inProgress", items: [] } };
    }
    if (method === "turn/interrupt") {
      this.calls.push({ method, params });
      return new Promise(() => {});
    }
    return super.request(method, params);
  }
}

class TransportFailureReconcileRpc extends FakeRpc {
  async request(method, params) {
    if (method === "turn/start") {
      this.calls.push({ method, params });
      return { turn: { id: "turn-transport-failure", status: "inProgress", items: [] } };
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      throw new CodexWorkspaceError("timeout", "thread/turns/list 请求超时。");
    }
    return super.request(method, params);
  }
}

class PendingTurnStartRpc extends FakeRpc {
  constructor(options) {
    super(options);
    this.turnStartPromise = new Promise((resolve) => {
      this.resolvePendingTurnStart = resolve;
    });
  }
  async request(method, params) {
    if (method === "turn/start") {
      this.calls.push({ method, params });
      return this.turnStartPromise;
    }
    if (method === "turn/interrupt") {
      this.calls.push({ method, params });
      return {};
    }
    return super.request(method, params);
  }
  resolveTurnStart() {
    this.resolvePendingTurnStart({
      turn: { id: "turn-started-late", status: "inProgress", items: [] },
    });
  }
}

class HistoryRpc extends FakeRpc {
  constructor(options, config) {
    super(options);
    this.config = config;
    this.archived = new Set();
  }
  async request(method, params) {
    if (method === "thread/start" || method === "thread/resume") {
      this.calls.push({ method, params });
      return {
        thread: {
          id: this.config.currentThreadId,
          ephemeral: false,
          createdAt: Math.floor(Date.now() / 1_000),
        },
        cwd: "/tmp/stock-agent-workspace",
        model: "test-model",
        modelProvider: "openai",
        instructionSources: [],
      };
    }
    if (method === "thread/list") {
      this.calls.push({ method, params });
      return {
        data: this.config.liveThreads.filter((thread) => !this.archived.has(thread.id)),
        nextCursor: null,
      };
    }
    if (method === "thread/read") {
      this.calls.push({ method, params });
      const thread = this.config.liveThreads.find((entry) => entry.id === params.threadId);
      return thread ? { thread } : {};
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      return { data: this.config.turns[params.threadId] ?? [], nextCursor: null };
    }
    if (method === "thread/archive") {
      this.calls.push({ method, params });
      this.archived.add(params.threadId);
      return {};
    }
    return super.request(method, params);
  }
}

class StreamFallbackRpc extends FakeRpc {
  async request(method, params) {
    if (method !== "turn/start") return super.request(method, params);
    this.calls.push({ method, params });
    setImmediate(() => {
      const startedTool = {
        type: "mcpToolCall",
        id: "tool-stable",
        server: "market",
        tool: "quote",
        status: "inProgress",
      };
      const completedTool = { ...startedTool, status: "completed" };
      this.options.onNotification({
        method: "item/started",
        params: { threadId: "thr-persistent-1", turnId: "turn-stream", item: startedTool },
      });
      this.options.onNotification({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thr-persistent-1",
          turnId: "turn-stream",
          itemId: "message-stable",
          delta: "only streamed answer",
        },
      });
      this.options.onNotification({
        method: "item/completed",
        params: { threadId: "thr-persistent-1", turnId: "turn-stream", item: completedTool },
      });
      this.options.onNotification({
        method: "turn/completed",
        params: {
          threadId: "thr-persistent-1",
          turn: { id: "turn-stream", status: "completed", items: [] },
        },
      });
    });
    return { turn: { id: "turn-stream", status: "inProgress", items: [] } };
  }
}

class LostCompletionRpc extends FakeRpc {
  async request(method, params) {
    if (method === "turn/start") {
      this.calls.push({ method, params });
      setImmediate(() => {
        this.options.onNotification({
          method: "item/completed",
          params: {
            threadId: "thr-persistent-1",
            turnId: "turn-lost-terminal",
            item: {
              type: "agentMessage",
              id: "commentary-1",
              phase: "commentary",
              text: "intermediate commentary",
            },
          },
        });
        this.options.onNotification({
          method: "item/completed",
          params: {
            threadId: "thr-persistent-1",
            turnId: "turn-lost-terminal",
            item: {
              type: "agentMessage",
              id: "final-1",
              phase: "final_answer",
              text: "recovered final answer",
            },
          },
        });
        this.options.onNotification({
          method: "turn/completed",
          params: {
            threadId: "unrelated-thread",
            turn: { id: "turn-lost-terminal", status: "failed", items: [] },
          },
        });
        this.options.onNotification({
          method: "thread/status/changed",
          params: { threadId: "thr-persistent-1", status: { type: "idle" } },
        });
      });
      return { turn: { id: "turn-lost-terminal", status: "inProgress", items: [] } };
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      return {
        data: [{
          id: "turn-lost-terminal",
          status: "completed",
          error: null,
          items: [
            { type: "agentMessage", id: "commentary-1", phase: "commentary", text: "intermediate commentary" },
            { type: "agentMessage", id: "final-1", phase: "final_answer", text: "recovered final answer" },
          ],
        }],
        nextCursor: null,
      };
    }
    return super.request(method, params);
  }
}

class SplitFinalAnswerRpc extends FakeRpc {
  async request(method, params) {
    if (method !== "turn/start") return super.request(method, params);
    this.calls.push({ method, params });
    setImmediate(() => {
      const notifyItem = (item) => this.options.onNotification({
        method: "item/completed",
        params: { threadId: "thr-persistent-1", turnId: "turn-split-final", item },
      });
      notifyItem({
        type: "agentMessage", id: "commentary-split", phase: "commentary", text: "运行中说明",
      });
      notifyItem({
        type: "agentMessage", id: "final-split-1", phase: "final_answer", text: "第一段最终结论",
      });
      notifyItem({
        type: "agentMessage", id: "final-split-2", phase: "final_answer", text: "第二段执行计划",
      });
      this.options.onNotification({
        method: "turn/completed",
        params: {
          threadId: "thr-persistent-1",
          turn: {
            id: "turn-split-final",
            status: "completed",
            items: [
              { type: "agentMessage", id: "commentary-split", phase: "commentary", text: "运行中说明" },
              { type: "agentMessage", id: "final-split-1", phase: "final_answer", text: "第一段最终结论" },
              { type: "agentMessage", id: "final-split-2", phase: "final_answer", text: "第二段执行计划" },
            ],
          },
        },
      });
    });
    return { turn: { id: "turn-split-final", status: "inProgress", items: [] } };
  }
}

class PersistedSplitFinalRpc extends FakeRpc {
  async request(method, params) {
    if (method === "turn/start") {
      this.calls.push({ method, params });
      setImmediate(() => {
        this.options.onNotification({
          method: "item/completed",
          params: {
            threadId: "thr-persistent-1",
            turnId: "turn-persisted-split",
            item: { type: "agentMessage", id: "final-2", phase: "final_answer", text: "第二段" },
          },
        });
        this.options.onNotification({
          method: "thread/status/changed",
          params: { threadId: "thr-persistent-1", status: { type: "idle" } },
        });
      });
      return { turn: { id: "turn-persisted-split", status: "inProgress", items: [] } };
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      return {
        data: [{
          id: "turn-persisted-split",
          status: "completed",
          items: [{ type: "agentMessage", id: "final-2", phase: "final_answer", text: "第二段" }],
        }],
        nextCursor: null,
      };
    }
    if (method === "thread/items/list") {
      this.calls.push({ method, params });
      return {
        data: [
          { turnId: "turn-persisted-split", item: { type: "agentMessage", id: "final-1", phase: "final_answer", text: "第一段" } },
          { turnId: "turn-persisted-split", item: { type: "agentMessage", id: "final-2", phase: "final_answer", text: "第二段" } },
        ],
        nextCursor: null,
      };
    }
    return super.request(method, params);
  }
}

class RepeatedTaskHistoryRpc extends FakeRpc {
  async request(method, params) {
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      return {
        data: [
          repeatedTaskTurn("turn-older", "operation-older", "较旧的组合结论"),
          repeatedTaskTurn("turn-newer", "operation-newer", "较新的组合结论"),
        ],
        nextCursor: null,
      };
    }
    if (method === "thread/items/list") {
      this.calls.push({ method, params });
      const turn = params.turnId === "turn-newer"
        ? repeatedTaskTurn("turn-newer", "operation-newer", "较新的组合结论")
        : repeatedTaskTurn("turn-older", "operation-older", "较旧的组合结论");
      return {
        data: turn.items.map((item) => ({ turnId: turn.id, item })),
        nextCursor: null,
      };
    }
    return super.request(method, params);
  }
}

function repeatedTaskTurn(id, clientId, text) {
  return {
    id,
    status: "completed",
    items: [
      { type: "userMessage", id: `${id}-user`, clientId, content: [{ type: "text", text: "分析全部持仓" }] },
      { type: "agentMessage", id: `${id}-final`, phase: "final_answer", text },
    ],
  };
}

class LostTurnStartResponseRpc extends FakeRpc {
  constructor(options) {
    super(options);
    this.persisted = false;
  }
  async request(method, params) {
    if (method === "turn/start") {
      this.calls.push({ method, params });
      setImmediate(() => {
        this.persisted = true;
        this.options.onNotification({
          method: "item/completed",
          params: {
            threadId: "thr-persistent-1",
            turnId: "turn-start-response-lost",
            item: {
              type: "agentMessage",
              id: "lost-start-final",
              phase: "final_answer",
              text: "从持久 turn 恢复的最终结论",
            },
          },
        });
      });
      return new Promise(() => {});
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      return {
        data: this.persisted ? [{
          id: "turn-start-response-lost",
          status: "completed",
          items: [{
            type: "agentMessage",
            id: "lost-start-final",
            phase: "final_answer",
            text: "从持久 turn 恢复的最终结论",
          }],
        }] : [],
        nextCursor: null,
      };
    }
    return super.request(method, params);
  }
}

class FinalAnswerWithoutTurnCompletionRpc extends FakeRpc {
  async request(method, params) {
    if (method === "turn/start") {
      this.calls.push({ method, params });
      setImmediate(() => {
        this.options.onNotification({
          method: "item/completed",
          params: {
            threadId: "thr-persistent-1",
            turnId: "turn-final-only",
            item: {
              type: "agentMessage",
              id: "final-only-message",
              phase: "final_answer",
              text: "final answer without turn completed",
            },
          },
        });
      });
      return { turn: { id: "turn-final-only", status: "inProgress", items: [] } };
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      return {
        data: [{
          id: "turn-final-only",
          status: "inProgress",
          items: [{
            type: "agentMessage",
            id: "final-only-message",
            phase: "final_answer",
            text: "final answer without turn completed",
          }],
        }],
        nextCursor: null,
      };
    }
    return super.request(method, params);
  }
}

class SlowSegmentRpc extends FakeRpc {
  constructor(options) { super(options); this.items = []; this.remoteStatus = "inProgress"; }
  async request(method, params) {
    if (method === "turn/start") {
      this.calls.push({ method, params });
      const emit = (id, text) => {
        const item = { type: "agentMessage", id, phase: "final_answer", text };
        this.items.push(item);
        this.options.onNotification({ method: "item/completed", params: {
          threadId: "thr-persistent-1", turnId: "slow-segment-turn", item,
        } });
      };
      setImmediate(() => emit("first", "第一段：判断"));
      this.timer = setTimeout(() => {
        emit("second", "第二段：风险与限制");
        this.remoteStatus = "completed";
        this.options.onNotification({ method: "turn/completed", params: {
          threadId: "thr-persistent-1", turn: { id: "slow-segment-turn", status: "completed", items: this.items },
        } });
      }, 6_500);
      return { turn: { id: "slow-segment-turn", status: "inProgress", items: [] } };
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      return { data: this.items.length ? [{ id: "slow-segment-turn", status: this.remoteStatus, items: this.items }] : [], nextCursor: null };
    }
    return super.request(method, params);
  }
  dispose() { clearTimeout(this.timer); super.dispose(); }
}

class ConcurrentTerminalHistoryRpc extends FinalAnswerWithoutTurnCompletionRpc {
  async request(method, params) {
    if (method === "thread/items/list") {
      this.historyReads = (this.historyReads ?? 0) + 1;
      const item = { type: "agentMessage", id: "final-only-message", phase: "final_answer", text: "final answer without turn completed" };
      this.options.onNotification({ method: "turn/completed", params: {
        threadId: "thr-persistent-1", turn: { id: "turn-final-only", status: "completed", items: [item] },
      } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { data: [{ turnId: "turn-final-only", item }], nextCursor: null };
    }
    const response = await super.request(method, params);
    if (method === "thread/turns/list") {
      for (const turn of response.data ?? []) turn.status = "completed";
    }
    return response;
  }
}

class IncompleteHistoryRpc extends PersistedSplitFinalRpc {
  async request(method, params) {
    if (method !== "thread/items/list") return super.request(method, params);
    this.calls.push({ method, params });
    if (params.cursor) return new Promise(() => {});
    return { data: [{ turnId: "turn-persisted-split", item: {
      type: "agentMessage", id: "final-1", phase: "final_answer", text: "第一段",
    } }], nextCursor: "remaining-unavailable" };
  }
}

class DelayedTurnStartStableFinalRpc extends FakeRpc {
  async request(method, params) {
    if (method === "turn/start") {
      this.calls.push({ method, params });
      return new Promise((resolve) => {
        setImmediate(() => this.options.onNotification({
          method: "item/completed",
          params: {
            threadId: "thr-persistent-1",
            turnId: "turn-late-start-final",
            item: { type: "agentMessage", id: "late-final", phase: "final_answer", text: "late start stable final" },
          },
        }));
        setTimeout(() => resolve({
          turn: { id: "turn-late-start-final", status: "inProgress", items: [] },
        }), 80);
      });
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      return {
        data: [{ id: "turn-late-start-final", status: "completed", items: [] }],
        nextCursor: null,
      };
    }
    return super.request(method, params);
  }
}

class MissingTurnStartStableFinalRpc extends FakeRpc {
  async request(method, params) {
    if (method === "turn/start") {
      this.calls.push({ method, params });
      setImmediate(() => this.options.onNotification({
        method: "item/completed",
        params: {
          threadId: "thr-persistent-1",
          turnId: "turn-missing-start-final",
          item: { type: "agentMessage", id: "missing-start-final", phase: "final_answer", text: "missing start stable final" },
        },
      }));
      return new Promise(() => {});
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      return {
        data: [{ id: "turn-missing-start-final", status: "completed", items: [] }],
        nextCursor: null,
      };
    }
    return super.request(method, params);
  }
}

class EarlyCompletionRpc extends FakeRpc {
  async request(method, params) {
    if (method !== "turn/start") return super.request(method, params);
    this.calls.push({ method, params });
    this.options.onNotification({
      method: "turn/completed",
      params: {
        threadId: "thr-persistent-1",
        turn: {
          id: "turn-early",
          status: "completed",
          items: [{
            type: "agentMessage",
            id: "early-final",
            phase: "final_answer",
            text: "early completed answer",
          }],
        },
      },
    });
    return { turn: { id: "turn-early", status: "inProgress", items: [] } };
  }
}

class MissingTurnIdRpc extends FakeRpc {
  async request(method, params) {
    if (method !== "turn/start") return super.request(method, params);
    this.calls.push({ method, params });
    return { turn: { status: "inProgress", items: [] } };
  }
}

class UnsupportedAdditionalContextRpc extends FakeRpc {
  async request(method, params) {
    if (method !== "turn/start") return super.request(method, params);
    this.calls.push({ method, params });
    throw new CodexWorkspaceError(
      "rpc",
      "Invalid params: unknown field additionalContext (-32602)",
      {
        rpcCode: -32602,
        rpcMethod: "turn/start",
        rpcData: { field: "additionalContext" },
      },
    );
  }
}

function historyThread(id, recencyAt) {
  return {
    id,
    name: "交易驾驶舱 Agent",
    preview: "",
    createdAt: recencyAt - 60,
    updatedAt: recencyAt,
    recencyAt,
  };
}

function historyTurn(id, completedAt, userText, assistantText = "assistant response") {
  return {
    id,
    startedAt: completedAt - 1,
    completedAt,
    items: [
      { type: "userMessage", content: [{ type: "inputText", text: userText }] },
      { type: "agentMessage", text: assistantText },
    ],
  };
}

async function waitUntil(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function scriptedChild(sent, { initializeError = null } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  let buffer = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      sent.push(message);
      if (message.method === "initialize") {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify(initializeError
          ? { id: message.id, error: initializeError }
          : {
            id: message.id,
            result: { userAgent: "test", platformFamily: "unix", platformOs: "macos" },
          })}\n`));
      }
    }
  });
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit("close", 0, "SIGTERM"));
    return true;
  };
  return child;
}

function portfolioFixture() {
  return {
    status: "live",
    account: { baseCurrency: "USD" },
    totals: { cashRatio: 20, top1Weight: 12, top5Weight: 42 },
    dataQuality: { valuationComplete: true, fxStatus: "reference" },
    fx: { provider: "European Central Bank", asOf: "2026-07-17" },
    positions: [{
      symbol: "AAPL.US", ticker: "AAPL", name: "Apple", group: "科技",
      instrumentType: "equity", currency: "USD", quantity: 10,
      availableQuantity: 10, costPrice: 95, lastPrice: 100, weight: 12, pnlPercent: 5.26,
    }],
  };
}

function runFixture() {
  return {
    id: "run-1", elapsedMs: 200, task: "分析", state: "REVIEW_READY",
    context: {
      symbol: "AAPL.US", ticker: "AAPL", timeframe: "1D",
      snapshotAt: "2026-07-19T00:00:00.000Z", marketDataAsOf: "2026-07-18T00:00:00.000Z",
    },
    technical: { ema: { 21: 98 }, shortStructure: "交错", longStructure: "长周期多头" },
    risk: {
      groupWeight: 18, riskBudgetPercent: 0.8, referenceLabel: "EMA21",
      referenceLevel: 98, portfolioImpactAtReferencePercent: -0.24, limitation: null,
    },
    plan: {
      available: true,
      scenarios: [
        { name: "牛", tone: "bull", if: "收复 EMA21", then: "观察", invalidation: "跌破", impact: "重算" },
        { name: "基准", tone: "base", if: "震荡", then: "等待", invalidation: "离开区间", impact: "不变" },
        { name: "熊", tone: "bear", if: "破位", then: "评估保护", invalidation: "收回", impact: "重算" },
      ],
    },
    conclusion: { headline: "本地结论", body: "本地规则文本", posture: "等待" },
    evidence: [], safeguards: { orderWrite: false, modelNarration: false }, capabilities: {},
  };
}

function candidateRunFixture() {
  const snapshotAt = new Date().toISOString();
  const riskBudgetFact = createObservedFact({
    factId: `policy.risk_budget_percent@${snapshotAt}`,
    metric: "policy.risk_budget_percent",
    value: 0.8,
    availability: "known",
    unit: { kind: "percent_point", basis: "portfolio_net_assets" },
    asOf: {
      effectiveAt: snapshotAt,
      retrievedAt: snapshotAt,
      tradingDate: null,
      session: "not_applicable",
      timeZone: "UTC",
    },
    provenance: {
      source: "test risk policy",
      tool: "local:test",
      sourceRecordId: null,
      rawFields: ["risk.riskBudgetPercent"],
      inputRefs: [],
      formula: null,
      methodVersion: "test-risk-policy/v1",
    },
    quality: {
      freshness: "fresh",
      ageMs: 0,
      complete: true,
      confidence: "not_applicable",
      reasonCodes: [],
    },
    display: { precision: 2, label: "单笔风险预算" },
  });
  const marketCloseFact = createObservedFact({
    factId: `market.last_completed_close.nvda.us@${snapshotAt}`,
    metric: "market.last_completed_close",
    value: 100,
    availability: "known",
    unit: {
      kind: "price",
      currency: "USD",
      symbol: "NVDA.US",
      tickSize: null,
    },
    asOf: {
      effectiveAt: snapshotAt,
      retrievedAt: snapshotAt,
      tradingDate: "2026-07-17",
      session: "regular",
      timeZone: "UTC",
    },
    provenance: {
      source: "test market evidence",
      tool: "local:test",
      sourceRecordId: null,
      rawFields: ["technical.lastPrice"],
      inputRefs: [],
      formula: null,
      methodVersion: "test-market/v1",
    },
    quality: {
      freshness: "fresh",
      ageMs: 0,
      complete: true,
      confidence: "not_applicable",
      reasonCodes: [],
    },
    display: { precision: 2, label: "NVDA 最近完成收盘价" },
  });
  return {
    id: "candidate-run-1",
    elapsedMs: 200,
    task: "评估候选仓位",
    state: "REVIEW_READY",
    context: {
      scope: "candidate",
      symbol: "NVDA.US",
      ticker: "NVDA",
      snapshotAt,
      marketDataAsOf: "2026-07-18T00:00:00.000Z",
    },
    analysisContext: {
      scope: "candidate",
      portfolioSummary: { netAssets: 100_000, cashRatioPercent: 20 },
      target: { symbol: "NVDA.US", ticker: "NVDA", isHeld: false },
      technical: { priceBars: [] },
      numericEvidence: {
        packageVersion: "core-numeric-evidence/v1",
        schemaVersion: "numeric-evidence/v1",
        status: "complete",
        facts: [riskBudgetFact, marketCloseFact],
        factCount: 2,
        knownCount: 2,
        invariants: {
          unknownIsNeverZero: true,
          percentageUnit: "percent_point",
          modelMayCreateHostDecision: false,
        },
      },
    },
    technical: {
      asOf: "2026-07-18T00:00:00.000Z",
      lastPrice: 100,
      ema: { 21: 98 },
      range20: { priorLow: 90, priorHigh: 105 },
      shortStructure: "交错",
      longStructure: "长周期多头",
    },
    risk: {
      scope: "candidate",
      supported: true,
      entryAllowed: false,
      awaitingModelReview: true,
      snapshotFresh: true,
      snapshotAt,
      sizingValidUntil: new Date(Date.parse(snapshotAt) + 2 * 60 * 1000).toISOString(),
      entryBlockReasons: [],
      existingPositionWeight: 0,
      group: "候选标的",
      groupWeight: null,
      candidateGroupKnown: false,
      baseCurrency: "USD",
      riskBudgetPercent: 0.8,
      cashConstrainedWeightPercent: 20,
      buyPowerValid: true,
      buyPowerWeightPercent: 200,
      hardMaxAdditionalWeightPercent: 10,
      hardMaxTotalWeightPercent: 10,
      recommendedInitialAdditionalWeightPercent: null,
      recommendedInitialTotalWeightPercent: null,
      recommendedInitialNotionalBase: null,
      recommendedMaxAdditionalWeightPercent: null,
      recommendedMaxWeightPercent: null,
      recommendedMaxAdditionalNotionalBase: null,
      moveToReferencePercent: null,
      portfolioImpactAtReferencePercent: null,
      leverage: {
        decision: "cash_only",
        additionalLeverageAllowed: false,
        maxAdditionalBorrowedWeightPercent: 0,
        maxLeverageMultiple: 1.5,
        marginEligible: true,
        disabledReasons: [],
      },
      portfolioConstraints: {
        groupExposure: [{ key: "半导体", weight: 29 }],
        grossExposurePercent: 32,
        policyThresholds: {
          groupWarningPercent: 30,
          grossWarningPercent: 120,
          grossHardMaxPercent: 150,
        },
      },
    },
    plan: {
      available: true,
      state: "awaiting_codex_strategy",
      riskSizingAvailable: false,
      sizing: {},
      scenarios: [
        { name: "允许试探", tone: "bull", if: "站回 EMA21", then: "初始 2%", invalidation: "破位", impact: "-0.32%" },
        { name: "等待", tone: "base", if: "交错", then: "等待", invalidation: "脱离", impact: "0" },
      ],
    },
    conclusion: { headline: "本地候选结论", body: "本地规则文本", posture: "等待" },
    evidence: [],
    safeguards: { orderWrite: false, modelNarration: false },
    capabilities: {},
  };
}

function candidateWorkspaceAnalysis(candidateSizing = {}) {
  return {
    text: "# 候选可信度复核\n\n模型结论仅在通过宿主硬边界后生效。",
    candidateSizing: {
      candidateGroupKey: "半导体",
      classificationConfidence: "high",
      narrativeStage: "stage_2",
      fibReview: {
        decision: "ignore",
        direction: "none",
        anchors: { a: null, b: null, c: null },
        emphasizedRatios: [],
        confidence: "medium",
        rationale: "本轮不使用 Fib。",
      },
      invalidation: {
        kind: "ema",
        barId: null,
        field: null,
        emaPeriod: 21,
        rangeKey: null,
        fibRatio: null,
        confirmation: "日线收盘",
        rationale: "EMA21 为失效依据。",
      },
      holdingHorizon: "swing",
      stressTest: {
        kind: "gap_down",
        lossPercent: 10,
        slippagePercent: 0.5,
        rationale: "按隔夜跳空与退出滑点压力测试。",
      },
      recommendedInitialAdditionalWeightPercent: 1,
      recommendedMaxTotalWeightPercent: 1,
      sizingConfidence: "high",
      leverageDecision: "cash_only",
      rationale: "等待宿主校验。",
      ...candidateSizing,
    },
    provider: "Codex App Server",
    elapsedMs: 100,
    threadId: "thr-persistent-1",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    requestedSkills: [],
    requestedApps: [],
    toolEvents: [],
    toolsUsed: false,
    skillCount: 2,
    mcpServerCount: 1,
    appCount: 0,
    tokenUsage: null,
  };
}
