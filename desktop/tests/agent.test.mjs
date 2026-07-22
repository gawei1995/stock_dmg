import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnalysisEvidence,
  buildTradingEvidence,
  calculatePortfolioRisk,
} from "../src/engine/agent.mjs";

test("a candle timeout degrades technical analysis instead of hanging the Agent", async () => {
  const timestamp = "2026-07-19T02:00:00.000Z";
  const portfolio = {
    status: "live",
    syncedAt: timestamp,
    positions: [{
      symbol: "AAPL.US",
      ticker: "AAPL",
      instrumentType: "equity",
      quantity: 10,
      lastPrice: 200,
      quoteTimestamp: timestamp,
      quoteSession: "intraday",
      weight: 20,
      group: "Technology",
      pnlPercent: 10,
    }],
    account: { netAssets: 10_000, marginCall: null },
    dataQuality: { fxStatus: "live", sourceErrors: [], valuationComplete: true },
    fx: { currencyCount: 1 },
    groupExposure: { Technology: 20 },
    totals: { top1Weight: 20, top5Weight: 20, cashRatio: 50 },
  };
  const stages = [];

  const run = await buildTradingEvidence({
    portfolio,
    symbol: "AAPL.US",
    loadCandles: async () => {
      const error = new Error("Longbridge candlesticks: Request timed out");
      error.kind = "timeout";
      throw error;
    },
    onStage: (stage) => stages.push(stage),
  });

  assert.equal(run.state, "DEGRADED");
  assert.equal(run.technical.candleCount, 0);
  assert.equal(run.capabilities.conditionalPlan, false);
  assert.match(
    run.evidence.find((item) => item.tool === "candlesticks").summary,
    /timed out/,
  );
  assert.deepEqual(stages.map((stage) => stage.phase), ["candles", "risk_plan"]);
});

test("an aborted Agent stops instead of returning a degraded rule result", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    buildTradingEvidence({
      portfolio: {
        positions: [{ symbol: "AAPL.US" }],
      },
      symbol: "AAPL.US",
      loadCandles: async () => [],
      signal: controller.signal,
    }),
    (error) => error.name === "AbortError" && /已取消/.test(error.message),
  );
});

test("candidate scope analyzes an unheld bare US ticker and builds an entry plan", async () => {
  const portfolio = portfolioFixture();
  let requestedSymbol = null;
  const run = await buildAnalysisEvidence({
    scope: "candidate",
    portfolio,
    symbol: "msft",
    task: "为未持有的 MSFT 准备买入计划",
    loadCandles: async (symbol) => {
      requestedSymbol = symbol;
      return risingCandles(220);
    },
  });

  assert.equal(requestedSymbol, "MSFT.US");
  assert.equal(run.context.scope, "candidate");
  assert.equal(run.context.symbol, "MSFT.US");
  assert.equal(run.context.isHeld, false);
  assert.equal(run.technical.capabilities.longEma, true);
  assert.equal(run.plan.available, true);
  assert.equal(run.plan.riskSizingAvailable, true);
  assert.ok(run.risk.provisionalMaxWeightPercent > 0);
  assert.equal(run.risk.entryAllowed, true);
  assert.equal(run.risk.stageAssumption, "stage_1_unvalidated");
  assert.equal(run.risk.recommendedInitialAdditionalWeightPercent, 2);
  assert.equal(run.risk.recommendedInitialTotalWeightPercent, 2);
  assert.equal(run.risk.recommendedInitialNotionalBase, 200);
  assert.equal(run.risk.recommendedMaxWeightPercent, 4);
  assert.equal(run.risk.recommendedMaxAdditionalWeightPercent, 4);
  assert.equal(run.risk.recommendedMaxAdditionalNotionalBase, 400);
  assert.equal(run.risk.cashBufferFloorPercent, 5);
  assert.equal(run.risk.concentrationHeadroom.cashFundedPercent, 35);
  assert.equal(run.risk.portfolioConstraints.grossExposurePercent, 32);
  assert.equal(run.risk.portfolioConstraints.netExposurePercent, 32);
  assert.equal(run.risk.portfolioConstraints.maintenanceMarginRatioPercent, 5);
  assert.equal(run.risk.portfolioConstraints.initMarginRatioPercent, 7);
  assert.ok(run.risk.portfolioConstraints.groupExposure.some(
    (item) => item.key === "Technology" && item.weight === 18,
  ));
  assert.equal(run.risk.leverage.additionalLeverageAllowed, false);
  assert.equal(run.risk.leverage.maxAdditionalBorrowedWeightPercent, 0);
  assert.equal(run.risk.leverage.maxLeverageMultiple, 1);
  assert.equal(run.risk.leverage.projectedGrossAtMaxPercent, 36);
  assert.equal(run.plan.sizing.initialAdditionalWeightPercent, 2);
  assert.equal(run.plan.sizing.maxTotalWeightPercent, 4);
  assert.equal(Object.hasOwn(run.analysisContext, "positions"), false);
  assert.equal(run.analysisContext.target.quantity, null);
  assert.equal(run.analysisContext.portfolioSummary.top1WeightPercent, 18);
  assert.equal(run.capabilities.candidatePortfolioConstraints, true);
  assert.equal(run.capabilities.leverageAssessment, true);
});

test("candidate sizing fails closed until EMA21 evidence is plan-ready", async () => {
  const run = await buildAnalysisEvidence({
    scope: "candidate",
    portfolio: portfolioFixture(),
    symbol: "MSFT",
    loadCandles: async () => risingCandles(20),
  });

  assert.equal(run.technical.ema[21], null);
  assert.equal(run.risk.technicalPlanReady, false);
  assert.equal(run.risk.supported, false);
  assert.equal(run.risk.entryAllowed, false);
  assert.equal(run.risk.recommendedInitialAdditionalWeightPercent, null);
  assert.equal(run.risk.recommendedMaxWeightPercent, null);
  assert.equal(run.risk.leverage.decision, "disabled");
  assert.equal(run.risk.leverage.additionalLeverageAllowed, false);
  assert.equal(run.plan.available, false);
  assert.match(run.risk.limitation, /EMA21|日线证据/);
});

test("candidate sizing requires a finite non-negative cash ratio", async () => {
  for (const cashRatio of [undefined, -1]) {
    const portfolio = portfolioFixture();
    portfolio.totals.cashRatio = cashRatio;
    const run = await buildAnalysisEvidence({
      scope: "candidate",
      portfolio,
      symbol: "MSFT",
      loadCandles: async () => risingCandles(220),
    });

    assert.equal(run.risk.cashRatioValid, false);
    assert.equal(run.risk.supported, false);
    assert.equal(run.risk.entryAllowed, false);
    assert.equal(run.risk.recommendedInitialAdditionalWeightPercent, null);
    assert.equal(run.risk.recommendedMaxWeightPercent, null);
    assert.equal(run.risk.leverage.decision, "disabled");
    assert.equal(run.risk.leverage.additionalLeverageAllowed, false);
    assert.match(run.risk.limitation, /现金比例/);
  }
});

test("candidate sizing and leverage are disabled when option Delta exposure is unavailable", async () => {
  const portfolio = portfolioFixture();
  portfolio.positions.push({
    symbol: "AAPL260821C00200000.US",
    ticker: "AAPL260821C00200000",
    instrumentType: "option",
    currency: "USD",
    quantity: 1,
    lastPrice: 8,
    contractMultiplier: 100,
    weight: 8,
    netWeight: 8,
    marketValueBase: 800,
    grossMarketValueBase: 800,
    group: "Technology",
    direction: "long",
    valuationStatus: "priced",
  });
  portfolio.totals.positionCount = 3;
  portfolio.totals.pricedPositionCount = 3;
  portfolio.totals.positionsGrossMarketValueBase = 4_000;
  portfolio.totals.positionsNetMarketValueBase = 4_000;
  portfolio.totals.top5Weight = 38;

  const run = await buildAnalysisEvidence({
    scope: "candidate",
    portfolio,
    symbol: "MSFT",
    loadCandles: async () => risingCandles(220),
  });

  assert.equal(run.risk.technicalPlanReady, true);
  assert.equal(run.risk.derivativeExposureComplete, false);
  assert.equal(run.risk.portfolioConstraints.optionCount, 1);
  assert.equal(run.risk.portfolioConstraints.derivativeExposureComplete, false);
  assert.equal(run.risk.supported, false);
  assert.equal(run.risk.entryAllowed, false);
  assert.equal(run.risk.recommendedInitialAdditionalWeightPercent, null);
  assert.equal(run.risk.recommendedMaxAdditionalWeightPercent, null);
  assert.equal(run.risk.recommendedMaxWeightPercent, null);
  assert.equal(run.risk.leverage.decision, "disabled");
  assert.equal(run.risk.leverage.additionalLeverageAllowed, false);
  assert.equal(run.risk.leverage.maxAdditionalBorrowedWeightPercent, 0);
  assert.equal(run.plan.riskSizingAvailable, false);
  assert.match(run.risk.limitation, /Delta\/标的名义敞口/);
  assert.ok(run.risk.portfolioConstraints.alerts.some(
    (item) => item.code === "derivative_exposure_unavailable",
  ));
});

test("candidate sizing blocks new risk when the full portfolio has a margin call", async () => {
  const portfolio = portfolioFixture();
  portfolio.account.marginCall = 500;
  const run = await buildAnalysisEvidence({
    scope: "candidate",
    portfolio,
    symbol: "MSFT",
    loadCandles: async () => risingCandles(220),
  });

  assert.equal(run.risk.supported, true);
  assert.equal(run.risk.entryAllowed, false);
  assert.equal(run.risk.recommendedInitialAdditionalWeightPercent, 0);
  assert.equal(run.risk.recommendedMaxAdditionalWeightPercent, 0);
  assert.equal(run.risk.recommendedMaxWeightPercent, 0);
  assert.match(run.risk.entryBlockReasons.join(" "), /追加保证金/);
  assert.equal(run.risk.leverage.decision, "disabled");
  assert.equal(run.risk.leverage.additionalLeverageAllowed, false);
  assert.equal(run.plan.state, "candidate_blocked");
  assert.equal(run.plan.riskSizingAvailable, false);
  assert.match(run.conclusion.body, /新增仓位 0%/);
});

test("candidate context exposes only aggregate portfolio constraints and strips credentials", async () => {
  const portfolio = portfolioFixture();
  portfolio.account.accountNumber = "SECRET-ACCOUNT";
  portfolio.account.accessToken = "SECRET-TOKEN";
  portfolio.apiToken = "SECRET-ROOT-TOKEN";
  let candleCalls = 0;
  const run = await buildAnalysisEvidence({
    scope: "candidate",
    portfolio,
    symbol: "NVDA",
    loadCandles: async () => {
      candleCalls += 1;
      return risingCandles(220);
    },
  });

  const serializedEvidence = JSON.stringify({
    analysisContext: run.analysisContext,
    risk: run.risk,
    plan: run.plan,
  });
  assert.equal(candleCalls, 1);
  assert.doesNotMatch(serializedEvidence, /SECRET-ACCOUNT|SECRET-TOKEN|SECRET-ROOT-TOKEN/);
  assert.equal(Object.hasOwn(run.analysisContext, "positions"), false);
  assert.match(run.risk.portfolioConstraints.dataBoundary, /不包含账户号/);
});

test("candidate option scope never treats the contract chart as equity EMA/Fib risk", async () => {
  let candleCalls = 0;
  const run = await buildAnalysisEvidence({
    scope: "candidate",
    portfolio: portfolioFixture(),
    symbol: "AAPL260821C00200000.US",
    loadCandles: async () => {
      candleCalls += 1;
      return risingCandles(220);
    },
  });

  assert.equal(candleCalls, 0);
  assert.equal(run.analysisContext.target.instrumentType, "option");
  assert.equal(run.risk.supported, false);
  assert.equal(run.plan.available, false);
  assert.equal(run.risk.recommendedInitialAdditionalWeightPercent, null);
  assert.equal(run.risk.recommendedMaxWeightPercent, null);
  assert.equal(run.risk.leverage.additionalLeverageAllowed, false);
  assert.equal(run.risk.leverage.maxAdditionalBorrowedWeightPercent, 0);
  assert.match(run.risk.limitation, /Greeks/);
  assert.match(run.technical.reason, /期权合约/);
});

test("portfolio scope reviews every holding without loading per-symbol candles", async () => {
  const portfolio = portfolioFixture();
  let candleCalls = 0;
  const run = await buildAnalysisEvidence({
    scope: "portfolio",
    portfolio,
    task: "检查整个组合是否 OK",
    loadCandles: async () => {
      candleCalls += 1;
      return risingCandles(220);
    },
  });

  assert.equal(candleCalls, 0);
  assert.equal(run.context.scope, "portfolio");
  assert.equal(run.context.symbol, null);
  assert.equal(run.analysisContext.positions.length, portfolio.positions.length);
  assert.deepEqual(
    run.analysisContext.positions.map((item) => item.symbol),
    portfolio.positions.map((item) => item.symbol),
  );
  assert.equal(run.technical.capabilities.fastEma, false);
  assert.match(run.technical.reason, /不会逐个请求 K 线/);
  assert.equal(run.capabilities.fullPortfolioReview, true);
  assert.ok(["balanced", "review", "partial", "critical"].includes(run.risk.health));
  assert.ok(run.risk.currencyExposure.some((item) => item.key === "USD"));
});

test("single-position context contains aggregates and target but not the full holdings list", async () => {
  const portfolio = portfolioFixture();
  const run = await buildAnalysisEvidence({
    scope: "position",
    portfolio,
    symbol: "AAPL.US",
    loadCandles: async () => risingCandles(220),
  });

  assert.equal(run.analysisContext.scope, "position");
  assert.equal(run.analysisContext.target.symbol, "AAPL.US");
  assert.equal(Object.hasOwn(run.analysisContext, "positions"), false);
  assert.ok(Array.isArray(run.analysisContext.portfolioSummary.largestGroups));
});

test("portfolio health flags critical concentration and margin calls deterministically", () => {
  const portfolio = portfolioFixture();
  portfolio.account.marginCall = 500;
  portfolio.positions[0].weight = 35;
  portfolio.totals.top1Weight = 35;
  portfolio.totals.top5Weight = 82;
  portfolio.groupExposure.Technology = 50;
  const risk = calculatePortfolioRisk(portfolio, 0.8);

  assert.equal(risk.health, "critical");
  assert.ok(risk.alerts.some((item) => item.code === "margin_call"));
  assert.ok(risk.alerts.some((item) => item.code === "top1_concentration"));
  assert.ok(risk.alerts.some((item) => item.code === "top5_concentration"));
  assert.ok(risk.alerts.some((item) => item.code === "group_concentration"));
});

test("invalid analysis scopes fail before doing any market-data work", async () => {
  let candleCalls = 0;
  await assert.rejects(
    buildAnalysisEvidence({
      scope: "everything",
      portfolio: portfolioFixture(),
      loadCandles: async () => {
        candleCalls += 1;
        return [];
      },
    }),
    /分析范围无效/,
  );
  assert.equal(candleCalls, 0);
});

function portfolioFixture() {
  const timestamp = "2026-07-20T20:00:00.000Z";
  return {
    status: "live",
    holdingsStatus: "live",
    syncedAt: timestamp,
    quoteAsOf: timestamp,
    quoteLatestAsOf: timestamp,
    positions: [
      {
        symbol: "AAPL.US",
        ticker: "AAPL",
        name: "Apple",
        instrumentType: "equity",
        currency: "USD",
        quantity: 10,
        availableQuantity: 10,
        lastPrice: 200,
        costPrice: 180,
        quoteTimestamp: timestamp,
        quoteSession: "intraday",
        weight: 18,
        netWeight: 18,
        marketValueBase: 2_000,
        grossMarketValueBase: 2_000,
        group: "Technology",
        direction: "long",
        pnlPercent: 11.11,
        valuationStatus: "priced",
      },
      {
        symbol: "TSM.US",
        ticker: "TSM",
        name: "TSMC ADR",
        instrumentType: "equity",
        currency: "USD",
        quantity: 5,
        availableQuantity: 5,
        lastPrice: 240,
        costPrice: 210,
        quoteTimestamp: timestamp,
        quoteSession: "intraday",
        weight: 12,
        netWeight: 12,
        marketValueBase: 1_200,
        grossMarketValueBase: 1_200,
        group: "Semiconductor",
        direction: "long",
        pnlPercent: 14.29,
        valuationStatus: "priced",
      },
    ],
    account: {
      baseCurrency: "USD",
      netAssets: 10_000,
      totalCash: 4_000,
      maintenanceMargin: 500,
      initMargin: 700,
      marginCall: 0,
    },
    dataQuality: {
      fxStatus: "reference",
      sourceErrors: [],
      sourceWarnings: [],
      valuationComplete: true,
    },
    fx: { currencyCount: 1, providerCode: "ECB", asOf: "2026-07-17" },
    groupExposure: { Technology: 18, Semiconductor: 12 },
    groupNetExposure: { Technology: 18, Semiconductor: 12 },
    totals: {
      positionCount: 2,
      pricedPositionCount: 2,
      unpricedPositionCount: 0,
      positionsGrossMarketValueBase: 3_200,
      positionsNetMarketValueBase: 3_200,
      top1Weight: 18,
      top5Weight: 30,
      cashRatio: 40,
    },
  };
}

function risingCandles(count) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index;
    return {
      timestamp: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
      open: close - 1,
      high: close + 2,
      low: close - 2,
      close,
      volume: 1_000 + index,
    };
  });
}
