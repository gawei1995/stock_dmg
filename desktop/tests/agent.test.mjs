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
  assert.equal(run.plan.riskSizingAvailable, false);
  assert.equal(run.plan.state, "awaiting_codex_strategy");
  assert.equal(run.risk.awaitingModelReview, true);
  assert.equal(run.risk.entryAllowed, false);
  assert.equal(run.risk.stageAssumption, "llm_determined");
  assert.equal(run.risk.recommendedInitialAdditionalWeightPercent, null);
  assert.equal(run.risk.recommendedMaxWeightPercent, null);
  assert.ok(run.risk.hardMaxTotalWeightPercent > 0);
  assert.ok(run.risk.hardMaxAdditionalWeightPercent > 0);
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
  assert.equal(run.risk.leverage.maxLeverageMultiple, 1.5);
  assert.equal(run.risk.leverage.decision, "model_review_required");
  assert.equal(run.plan.sizing.initialAdditionalWeightPercent, null);
  assert.equal(run.plan.sizing.maxTotalWeightPercent, null);
  assert.equal(run.analysisContext.technical.priceBars.length, 220);
  assert.equal(Object.hasOwn(run.analysisContext, "positions"), false);
  assert.equal(run.analysisContext.target.quantity, null);
  assert.equal(run.analysisContext.portfolioSummary.top1WeightPercent, 18);
  assert.equal(run.capabilities.candidatePortfolioConstraints, true);
  assert.equal(run.capabilities.leverageAssessment, true);
});

test("candidate sizing accepts closed market evidence without requiring EMA21", async () => {
  const run = await buildAnalysisEvidence({
    scope: "candidate",
    portfolio: portfolioFixture(),
    symbol: "MSFT",
    loadCandles: async () => risingCandles(20),
  });

  assert.equal(run.technical.ema[21], null);
  assert.equal(run.risk.technicalPlanReady, true);
  assert.equal(run.risk.supported, true);
  assert.equal(run.risk.entryAllowed, false);
  assert.equal(run.risk.recommendedInitialAdditionalWeightPercent, null);
  assert.equal(run.risk.recommendedMaxWeightPercent, null);
  assert.equal(run.risk.leverage.decision, "model_review_required");
  assert.equal(run.risk.leverage.additionalLeverageAllowed, false);
  assert.equal(run.plan.available, true);
  assert.equal(run.plan.state, "awaiting_codex_strategy");
  assert.equal(run.risk.limitation, null);
});

test("candidate sizing requires a finite cash ratio", async () => {
  const portfolio = portfolioFixture();
  portfolio.totals.cashRatio = undefined;
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
});

test("negative cash is a financing warning instead of an automatic block below the gross cap", async () => {
  const portfolio = portfolioFixture();
  portfolio.totals.cashRatio = -10;
  portfolio.totals.positionsGrossMarketValueBase = 1.1 * portfolio.account.netAssets;
  const run = await buildAnalysisEvidence({
    scope: "candidate",
    portfolio,
    symbol: "MSFT",
    loadCandles: async () => risingCandles(220),
  });

  assert.equal(run.risk.cashRatioValid, true);
  assert.equal(run.risk.supported, true);
  assert.equal(run.risk.awaitingModelReview, true);
  assert.equal(run.risk.cashConstrainedWeightPercent, 0);
  assert.equal(run.risk.leverage.marginEligible, true);
  assert.ok(run.risk.portfolioConstraints.alerts.some(
    (item) => item.code === "negative_cash" && item.severity === "warning",
  ));
});

test("candidate sizing fails closed when broker buying power is missing", async () => {
  const portfolio = portfolioFixture();
  delete portfolio.account.buyPower;
  const run = await buildAnalysisEvidence({
    scope: "candidate",
    portfolio,
    symbol: "MSFT",
    loadCandles: async () => risingCandles(220),
  });

  assert.equal(run.risk.buyPowerValid, false);
  assert.equal(run.risk.supported, false);
  assert.equal(run.risk.leverage.decision, "disabled");
  assert.match(run.risk.limitation, /购买力/);
});

test("candidate gross headroom uses 150 percent as the hard cap and blocks at the cap", async () => {
  const nearCap = portfolioFixture();
  nearCap.totals.positionsGrossMarketValueBase = 14_900;
  nearCap.totals.cashRatio = -49;
  const nearCapRun = await buildAnalysisEvidence({
    scope: "candidate",
    portfolio: nearCap,
    symbol: "MSFT",
    loadCandles: async () => risingCandles(220),
  });
  assert.equal(nearCapRun.risk.portfolioConstraints.policyThresholds.grossWarningPercent, 120);
  assert.equal(nearCapRun.risk.portfolioConstraints.policyThresholds.grossHardMaxPercent, 150);
  assert.equal(nearCapRun.risk.hardMaxAdditionalWeightPercent, 1);
  assert.equal(nearCapRun.risk.awaitingModelReview, true);

  const atCap = portfolioFixture();
  atCap.totals.positionsGrossMarketValueBase = 15_000;
  atCap.totals.cashRatio = -50;
  const atCapRun = await buildAnalysisEvidence({
    scope: "candidate",
    portfolio: atCap,
    symbol: "MSFT",
    loadCandles: async () => risingCandles(220),
  });
  assert.equal(atCapRun.risk.hardMaxAdditionalWeightPercent, 0);
  assert.equal(atCapRun.risk.awaitingModelReview, false);
  assert.match(atCapRun.risk.entryBlockReasons.join(" "), /150% 硬上限/);
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
  assert.equal(run.risk.recommendedInitialAdditionalWeightPercent, null);
  assert.equal(run.risk.recommendedMaxAdditionalWeightPercent, null);
  assert.equal(run.risk.recommendedMaxWeightPercent, null);
  assert.match(run.risk.entryBlockReasons.join(" "), /追加保证金/);
  assert.equal(run.risk.leverage.decision, "disabled");
  assert.equal(run.risk.leverage.additionalLeverageAllowed, false);
  assert.equal(run.plan.state, "candidate_blocked");
  assert.equal(run.plan.riskSizingAvailable, false);
  assert.match(run.conclusion.body, /新增风险被安全边界阻止/);
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

test("stale portfolio evidence is degraded and never described as real-time", async () => {
  const portfolio = portfolioFixture();
  portfolio.status = "stale";
  portfolio.holdingsStatus = "stale";
  portfolio.freshness = {
    ...portfolio.freshness,
    state: "stale",
    freshForSizing: false,
  };

  const run = await buildAnalysisEvidence({
    scope: "portfolio",
    portfolio,
    task: "检查陈旧快照",
  });
  const accountEvidence = run.evidence.find((item) => item.tool === "account_balance");
  const holdingsEvidence = run.evidence.find((item) => item.tool === "stock_positions");

  assert.equal(accountEvidence.status, "degraded");
  assert.equal(holdingsEvidence.status, "degraded");
  assert.equal(run.analysisContext.portfolioSummary.snapshotFreshForSizing, false);
  assert.equal(run.analysisContext.portfolioSummary.snapshotState, "stale");
  assert.match(accountEvidence.summary, /STALE.*只供回看/);
  assert.match(holdingsEvidence.summary, /STALE.*只供回看/);
  assert.doesNotMatch(
    run.evidence.map((item) => item.summary).join("\n"),
    /账户数据实时/,
  );
});

function portfolioFixture() {
  const timestamp = new Date().toISOString();
  return {
    status: "live",
    holdingsStatus: "live",
    freshness: {
      state: "fresh",
      freshForSizing: true,
      snapshotAt: timestamp,
      expiresAt: new Date(Date.parse(timestamp) + 2 * 60 * 1000).toISOString(),
    },
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
      buyPower: 20_000,
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
