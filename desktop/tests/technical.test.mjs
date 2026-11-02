import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateFib,
  calculateTechnical,
  classifyLastDailyBar,
  emaSeries,
} from "../src/engine/technical.mjs";
import {
  buildConditionalPlan,
  calculatePositionRisk,
  classifyIntent,
  selectDownsideReference,
} from "../src/engine/agent.mjs";
import { normalizeCandles } from "../src/data/normalize.mjs";

test("EMA uses an SMA seed and exponential updates", () => {
  const result = emaSeries([1, 2, 3, 4, 5], 3);
  assert.deepEqual(result.slice(0, 2), [null, null]);
  assert.equal(result[2], 2);
  assert.equal(result[3], 3);
  assert.equal(result[4], 4);
});

test("technical engine keeps computable long EMAs partial until 3x-period maturity", () => {
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
  assert.equal(technical.status, "partial");
  assert.equal(technical.shortStructure, "完整多头");
  assert.equal(technical.longStructure, "长周期多头");
  assert.ok(technical.ema[3] > technical.ema[21]);
  assert.ok(technical.ema[144] > technical.ema[169]);
  assert.equal(technical.emaMaturity[169].status, "warming");
  assert.equal(technical.emaMaturity[169].requiredBarCount, 507);
  assert.equal(technical.capabilities.longEma, true);
  assert.equal(technical.capabilities.longEmaMature, false);
});

test("technical engine reports complete only after EMA169 receives a 3x-period history", () => {
  const candles = Array.from({ length: 507 }, (_, index) => {
    const close = 100 + index;
    return {
      timestamp: new Date(Date.UTC(2024, 0, index + 1)).toISOString(),
      open: close - 1,
      high: close + 2,
      low: close - 2,
      close,
      volume: 1000 + index,
    };
  });
  const technical = calculateTechnical(candles, {
    analysisTime: "2026-07-26T00:00:00.000Z",
  });
  assert.equal(technical.status, "complete");
  assert.equal(technical.emaMaturity[144].status, "mature");
  assert.equal(technical.emaMaturity[169].status, "mature");
  assert.equal(technical.capabilities.longEmaMature, true);
});

test("technical output publishes close input, SMA seed, and completed-bar provenance", () => {
  const candles = Array.from({ length: 70 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    open: 100 + index,
    high: 102 + index,
    low: 98 + index,
    close: 101 + index,
    volume: 1000,
  }));
  const technical = calculateTechnical(candles, {
    analysisTime: "2026-07-26T00:00:00.000Z",
  });
  assert.deepEqual(technical.emaMethod, {
    inputSource: "close",
    seed: "SMA",
    multiplier: "2 / (period + 1)",
  });
  assert.equal(technical.calculation.inputSource, "close");
  assert.equal(technical.calculation.emaSeed, "SMA");
  assert.equal(technical.calculation.inputBarCount, 70);
  assert.equal(technical.calculation.completedBarCount, 70);
  assert.equal(technical.emaMaturity[21].barCount, 70);
  assert.equal(technical.emaMaturity[21].status, "mature");
});

test("forming daily bar is exposed as provisional and excluded from official EMA structure", () => {
  const candles = Array.from({ length: 30 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 6, index + 1)).toISOString(),
    open: 100 + index,
    high: 102 + index,
    low: 98 + index,
    close: index === 29 ? 1 : 101 + index,
    volume: 1000,
    ...(index === 29 ? { isClosed: false } : {}),
  }));
  const official = calculateTechnical(candles);
  const withoutForming = calculateTechnical(candles.slice(0, -1), {
    analysisTime: "2026-08-01T00:00:00.000Z",
  });
  assert.equal(official.lastBar.status, "FORMING");
  assert.equal(official.lastBar.basis, "bar_metadata.isClosed");
  assert.equal(official.candleCount, 30);
  assert.equal(official.calculationBarCount, 29);
  assert.equal(official.asOf, candles[28].timestamp);
  assert.equal(official.lastPrice, candles[28].close);
  assert.equal(official.ema[21], withoutForming.ema[21]);
  assert.deepEqual(official.provisional, {
    available: true,
    status: "FORMING",
    excludedFromOfficial: true,
    asOf: candles[29].timestamp,
    close: 1,
    basis: "bar_metadata.isClosed",
  });
});

test("US daily bar uses exchange time and a finalization buffer when analysis time is provided", () => {
  // Midnight on July 24 ET identifies the July 24 Longbridge daily candle.
  const bar = { timestamp: "2026-07-24T04:00:00.000Z", close: 100 };
  assert.equal(classifyLastDailyBar(bar, {
    market: "US",
    analysisTime: "2026-07-24T19:59:00.000Z",
  }).status, "FORMING");
  assert.equal(classifyLastDailyBar(bar, {
    symbol: "AAPL.US",
    analysisTime: "2026-07-24T20:06:00.000Z",
  }).status, "CLOSED");
});

test("US early-close daily classification uses 13:00 ET and preserves the five-minute finalization boundary", () => {
  const bar = { tradeDate: "2026-11-27", timestamp: "2026-11-27T05:00:00Z", close: 100 };
  const forming = classifyLastDailyBar(bar, { symbol: "AAPL.US", analysisTime: "2026-11-27T18:04:59Z" });
  const closed = classifyLastDailyBar(bar, { symbol: "AAPL.US", analysisTime: "2026-11-27T18:05:00Z" });
  assert.equal(forming.status, "FORMING");
  assert.equal(forming.sessionClose, "13:00 ET");
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.sessionClose, "13:00 ET");
  assert.equal(closed.basis, "exchange_session_finalized");
});

test("normal US sessions still use 16:00 ET after an early-close classification", () => {
  classifyLastDailyBar({ tradeDate: "2026-11-27", close: 100 }, { symbol: "AAPL.US", analysisTime: "2026-11-27T18:05:00Z" });
  for (const [tradeDate, formingAt, closedAt] of [
    ["2026-03-06", "2026-03-06T21:04:59Z", "2026-03-06T21:05:00Z"],
    ["2026-03-09", "2026-03-09T20:04:59Z", "2026-03-09T20:05:00Z"],
  ]) {
    const bar = { tradeDate, close: 100 };
    const forming = classifyLastDailyBar(bar, { symbol: "AAPL.US", analysisTime: formingAt });
    const closed = classifyLastDailyBar(bar, { symbol: "AAPL.US", analysisTime: closedAt });
    assert.equal(forming.status, "FORMING");
    assert.equal(closed.status, "CLOSED");
    assert.equal(forming.sessionClose, "16:00 ET");
    assert.equal(closed.sessionClose, "16:00 ET");
  }
});

test("official 700.HK daily timestamp is CLOSED after its trading-day close", () => {
  const [bar] = normalizeCandles({
    symbol: "700.HK",
    candlesticks: [{
      timestamp: "1650384000",
      open: "364.600",
      high: "368.800",
      low: "361.600",
      close: "362.000",
    }],
  });
  const classification = classifyLastDailyBar(bar, {
    symbol: "700.HK",
    // 2022-04-20 16:06 HKT: the represented trading day is finalized.
    analysisTime: "2022-04-20T08:06:00.000Z",
  });
  assert.equal(classifyLastDailyBar(bar, {
    symbol: "700.HK",
    analysisTime: "2022-04-20T07:59:00.000Z",
  }).status, "FORMING");
  assert.equal(classification.status, "CLOSED");
  assert.equal(classification.basis, "exchange_session_finalized");
  assert.equal(classification.tradingDate, "2022-04-20");
  assert.equal(classification.timestampBasis, "provider_exchange_date");

  const technical = calculateTechnical([bar], {
    symbol: "700.HK",
    analysisTime: "2022-04-20T08:06:00.000Z",
  });
  assert.equal(technical.calculationBarCount, 1);
  assert.equal(technical.asOf, "2022-04-19T16:00:00.000Z");
  assert.equal(technical.asOfTradingDate, "2022-04-20");
});

test("same-date daily bar without market or explicit metadata stays unknown", () => {
  const result = classifyLastDailyBar(
    { timestamp: "2026-07-24T04:00:00.000Z", close: 100 },
    { analysisTime: "2026-07-24T22:00:00.000Z" },
  );
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.basis, "same_date_without_market_metadata");
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
      tradeDate: new Date(Date.UTC(2025, 11, index + 31)).toISOString().slice(0, 10),
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
  assert.equal(fib.method, "automated");
  assert.equal(fib.role, "advisory");
  assert.equal(fib.decisionAuthority, "LLM");
  assert.equal(fib.anchors.a.date, "2025-12-31");
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

test("deterministic downside guard ignores advisory Fib and never selects a level above price", () => {
  const technical = {
    ema: { 21: 110, 144: 90, 169: 85 },
    range20: { priorLow: 94 },
    fib: { levels: { "0.382": 105, "0.618": 96, "1": 80, "1.618": 60 } },
  };
  assert.deepEqual(selectDownsideReference(100, technical), {
    label: "前20日低点",
    level: 94,
  });
  const portfolio = {
    groupExposure: { 半导体: 12 },
    totals: { top1Weight: 12, top5Weight: 40, cashRatio: 20 },
    account: { marginCall: 0 },
  };
  const position = { lastPrice: 100, weight: 12, group: "半导体", pnlPercent: 5 };
  const risk = calculatePositionRisk(portfolio, position, technical, 0.8);
  assert.equal(risk.referenceLevel, 94);
  assert.equal(risk.moveToReferencePercent, -6);
  assert.equal(risk.portfolioImpactAtReferencePercent, -0.72);
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
