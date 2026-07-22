import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateFib,
  calculateTechnical,
  emaSeries,
} from "../src/engine/technical.mjs";
import {
  buildConditionalPlan,
  calculatePositionRisk,
  classifyIntent,
  selectDownsideReference,
} from "../src/engine/agent.mjs";

test("EMA uses an SMA seed and exponential updates", () => {
  const result = emaSeries([1, 2, 3, 4, 5], 3);
  assert.deepEqual(result.slice(0, 2), [null, null]);
  assert.equal(result[2], 2);
  assert.equal(result[3], 3);
  assert.equal(result[4], 4);
});

test("technical engine reports complete bullish fast and long structures", () => {
  const candles = Array.from({ length: 220 }, (_, index) => {
    const close = 100 + index;
    return {
      timestamp: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
      open: close - 1,
      high: close + 2,
      low: close - 2,
      close,
      volume: 1000 + index,
    };
  });
  const technical = calculateTechnical(candles);
  assert.equal(technical.status, "complete");
  assert.equal(technical.shortStructure, "完整多头");
  assert.equal(technical.longStructure, "长周期多头");
  assert.ok(technical.ema[3] > technical.ema[21]);
  assert.ok(technical.ema[144] > technical.ema[169]);
});

test("Fib extension always returns the four required ratios and three dated anchors", () => {
  const candles = Array.from({ length: 60 }, (_, index) => {
    const close = index <= 30
      ? 101 + index * 2
      : index <= 45
        ? 159 - (index - 31) * 2
        : 132 + (index - 46) * 1.5;
    return {
      timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      open: close - 1,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
    };
  });
  const fib = calculateFib(candles);
  assert.deepEqual(Object.keys(fib.levels).sort(), ["0.382", "0.618", "1", "1.618"]);
  assert.ok(fib.anchors.a.date);
  assert.ok(fib.anchors.b.date);
  assert.ok(fib.anchors.c.date);
  assert.equal(fib.formula, "C + (B - A) × ratio");
});

test("Fib skips an unconfirmed impulse instead of reusing the B bar as C", () => {
  const candles = Array.from({ length: 60 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    open: 100 + index,
    high: 102 + index,
    low: 98 + index,
    close: 101 + index,
    volume: 1000,
  }));
  assert.equal(calculateFib(candles), null);
});

test("downside risk never selects an EMA or Fib level above the current price", () => {
  const technical = {
    ema: { 21: 110, 144: 90, 169: 85 },
    range20: { priorLow: 94 },
    fib: { levels: { "0.382": 105, "0.618": 96, "1": 80, "1.618": 60 } },
  };
  assert.deepEqual(selectDownsideReference(100, technical), {
    label: "Fib 0.618",
    level: 96,
  });
  const portfolio = {
    groupExposure: { 半导体: 12 },
    totals: { top1Weight: 12, top5Weight: 40, cashRatio: 20 },
    account: { marginCall: 0 },
  };
  const position = { lastPrice: 100, weight: 12, group: "半导体", pnlPercent: 5 };
  const risk = calculatePositionRisk(portfolio, position, technical, 0.8);
  assert.equal(risk.referenceLevel, 96);
  assert.equal(risk.moveToReferencePercent, -4);
  assert.equal(risk.portfolioImpactAtReferencePercent, -0.48);
});

test("conditional plans do not ask a fully bullish chart to reclaim a level already below price", () => {
  const technical = {
    lastPrice: 120,
    ema: { 3: 118, 5: 116, 8: 114, 13: 110, 21: 105, 144: 90, 169: 80 },
    emaSlope5d: { 3: 2, 5: 1 },
    shortStructure: "完整多头",
    range20: { priorLow: 100 },
    fib: { levels: {} },
  };
  const risk = {
    supported: true,
    portfolioValuationComplete: true,
    riskBudgetPercent: 0.8,
    positionWeight: 10,
    referenceLevel: 114,
    referenceLabel: "EMA8",
    portfolioImpactAtReferencePercent: -0.5,
  };
  const plan = buildConditionalPlan({ lastPrice: 120 }, technical, risk);
  assert.match(plan.scenarios[0].if, /回踩 EMA8/);
  assert.doesNotMatch(plan.scenarios[0].if, /重新站上/);
});

test("incomplete portfolio valuation keeps technical evidence but blocks risk-budget plans", () => {
  const technical = {
    lastPrice: 120,
    ema: { 3: 118, 5: 116, 8: 114, 13: 110, 21: 105 },
  };
  const plan = buildConditionalPlan(
    { lastPrice: 120 },
    { ...technical, range20: {}, fib: { levels: {} } },
    {
      supported: true,
      portfolioValuationComplete: false,
      riskBudgetPercent: 0.8,
      positionWeight: 10,
    },
  );
  assert.equal(plan.available, false);
  assert.equal(plan.state, "valuation_incomplete");
  assert.match(plan.reason, /EMA\/Fib 技术观察仍可用/);
});

test("Agent task text routes risk, technical, plan, and combined reviews explicitly", () => {
  assert.equal(classifyIntent("检查组合集中度和风险预算"), "risk_review");
  assert.equal(classifyIntent("只看 EMA 和斐波那契结构"), "technical_timing");
  assert.equal(classifyIntent("生成牛、基准、熊条件计划"), "conditional_plan");
  assert.equal(classifyIntent("分析技术结构与仓位风险"), "full_review");
});

test("option positions never receive equity-linear downside impact", () => {
  const portfolio = {
    groupExposure: { 期权: 5 },
    totals: { top1Weight: 5, top5Weight: 5, cashRatio: 30 },
    account: { marginCall: 0 },
  };
  const position = {
    lastPrice: 10,
    weight: 5,
    group: "期权",
    instrumentType: "option",
    pnlPercent: -2,
  };
  const risk = calculatePositionRisk(portfolio, position, { ema: { 21: 8 } }, 0.8);
  assert.equal(risk.supported, false);
  assert.equal(risk.referenceLevel, null);
  assert.equal(risk.portfolioImpactAtReferencePercent, null);
});
