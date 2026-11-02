import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildAnalysisEvidence,
  buildTradingEvidence,
  calculatePortfolioRisk,
} from "../src/engine/agent.mjs";
import { withPortfolioFreshness } from "../src/data/freshness.mjs";
import { assessPortfolioValuationGate } from "../src/data/portfolio-valuation-gate.mjs";
import { expectedLastCompletedTradingDate } from "../src/engine/market-evidence.mjs";

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
  const requestedSymbols = [];
  const run = await buildAnalysisEvidence({
    scope: "candidate",
    portfolio,
    symbol: "msft",
    task: "为未持有的 MSFT 准备买入计划",
    loadCandles: async (symbol) => {
      requestedSymbols.push(symbol);
      return risingCandles(220);
    },
  });

  assert.deepEqual(requestedSymbols.sort(), ["MSFT.US", "QQQ.US"]);
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

test("candidate analysis attaches derived weekly and host-attested 60m execution evidence", async () => {
  const run = await buildAnalysisEvidence({
    scope: "candidate",
    portfolio: portfolioFixture(),
    symbol: "MSFT",
    task: "分析候选标的的周线结构与60分钟入场时点",
    loadCandles: async () => risingCandles(220),
    loadMarketSeries: async (symbol, descriptor) => {
      assert.equal(symbol, "MSFT.US");
      assert.deepEqual(descriptor, { period: "1h", count: 240 });
      const completedBars = risingHourlyBars(30);
      return {
        bars: [...completedBars, {
          ...risingHourlyBars(1, { startHour: 44 })[0],
          barStatus: "forming",
        }],
        completedBars,
        completedBarsOnly: true,
        finality: {
          method: "provider_explicit_finality_or_successor_bar_confirmation",
          completedBarCount: completedBars.length,
          terminalBarStatus: "provider_marked_forming",
        },
        coverage: {
          source: "live",
          originSource: null,
          partial: false,
          fetchedAt: "2026-08-31T16:00:00.000Z",
          period: "1h",
        },
      };
    },
  });

  assert.equal(run.technical.technicalV2.capabilityMatrix.weeklyStructure.status, "complete");
  assert.equal(run.technical.technicalV2.capabilityMatrix.execution60m.status, "complete");
  assert.equal(run.technical.technicalV2.capabilityMatrix.costProfile14d28d.status, "complete");
  assert.equal(run.technical.technicalV2.capabilityMatrix.benchmarkRelativeStrength.status, "complete");
  assert.equal(run.technical.technicalV2.costProfile14d28d.profiles["14"].confidence, "low");
  assert.equal(run.technical.technicalV2.costProfile14d28d.profiles["28"].estimateNotHolderCostBasis, true);
  assert.equal(run.technical.technicalV2.execution60m.input.completedBarCount, 30);
  assert.equal(run.analysisContext.technical.technicalV2.execution60m.status, "available");
  assert.equal(run.capabilities.weeklyStructure, "complete");
  assert.equal(run.capabilities.execution60m, "complete");
  assert.equal(run.capabilities.costProfile14d28d, "complete");
  assert.equal(run.capabilities.anchoredVwap, "unavailable");
  assert.equal(
    run.evidence.find((item) => item.tool === "candlesticks:1h")?.status,
    "succeeded",
  );
  assert.match(
    run.evidence.find((item) => item.tool === "local:daily-cost-concentration-proxy")?.summary ?? "",
    /LOW CONFIDENCE.*非逐笔筹码/,
  );
  assert.equal(run.technical.tierB.cutoff.tradingDate, run.technical.asOfTradingDate);
  assert.equal(run.technical.tierB.layers.execution60m.status, "unavailable");
  assert.ok(run.technical.tierB.layers.execution60m.reasonCodes.includes("no_completed_bars_at_or_before_cutoff"));
  assert.equal(run.analysisContext.technical.tierB.inputHash, run.technical.tierB.inputHash);
});

test("selected-symbol Tier-B uses only a confirmed sector and 2-5 peer mapping", async () => {
  const requested = [];
  const daily = risingCandles(260).map((bar, index) => ({
    ...bar,
    timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  }));
  const run = await buildAnalysisEvidence({
    scope: "candidate",
    portfolio: portfolioFixture(),
    symbol: "MSFT",
    task: "用同行与板块评估候选结构",
    technicalLinkage: {
      state: "confirmed",
      symbol: "MSFT.US",
      sectorSymbol: "XLK.US",
      peerSymbols: ["AAPL.US", "GOOG.US"],
      source: "user_confirmed",
      confirmedAt: "2026-08-01T00:00:00.000Z",
      inputHash: "a".repeat(64),
    },
    loadCandles: async (symbol) => {
      requested.push(symbol);
      return daily;
    },
    loadMarketSeries: async () => {
      const completedBars = risingHourlyBars(30);
      return {
        completedBars,
        completedBarsOnly: true,
        finality: { method: "provider_explicit_finality" },
        coverage: { source: "live", partial: false, fetchedAt: "2026-08-22T00:00:00.000Z" },
      };
    },
  });

  assert.deepEqual([...new Set(requested)].sort(), [
    "AAPL.US",
    "GOOG.US",
    "MSFT.US",
    "QQQ.US",
    "XLK.US",
  ]);
  assert.equal(run.technical.tierB.linkage.status, "confirmed");
  assert.equal(run.technical.tierB.linkage.inputHash, "a".repeat(64));
  assert.equal(Object.hasOwn(run.technical.tierB.linkage, "profileHash"), false);
  assert.equal(run.technical.tierB.layers.execution60m.status, "available");
  assert.notEqual(run.technical.tierB.layers.sector.status, "unavailable");
  assert.notEqual(run.technical.tierB.layers.peers.status, "unavailable");
  assert.equal(run.technical.tierB.layers.anchoredVwap.status, "unavailable");
  assert.equal(run.technical.tierB.inference.outputs.dealerGamma.status, "unavailable");
  assert.ok(run.evidence.some((item) => item.tool === "local:confirmed-market-linkage"));
});

test("60m load failure degrades only the execution layer and preserves daily candidate planning", async () => {
  const run = await buildAnalysisEvidence({
    scope: "candidate",
    portfolio: portfolioFixture(),
    symbol: "MSFT",
    loadCandles: async () => risingCandles(220),
    loadMarketSeries: async () => {
      const error = new Error("Longbridge hourly request timed out");
      error.code = "TIMEOUT";
      throw error;
    },
  });

  assert.equal(run.plan.available, true);
  assert.equal(run.risk.supported, true);
  assert.equal(run.technical.technicalV2.capabilityMatrix.weeklyStructure.status, "complete");
  assert.equal(run.technical.technicalV2.capabilityMatrix.execution60m.status, "unavailable");
  assert.equal(run.technical.technicalV2.loads.hourly60m.error.code, "TIMEOUT");
  assert.equal(run.evidence.find((item) => item.tool === "candlesticks:1h")?.status, "failed");
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

test("candidate keeps stale persistent candles for research but blocks executable sizing", async () => {
  const candles = risingCandles(220);
  const run = await buildAnalysisEvidence({
    scope: "candidate",
    portfolio: portfolioFixture(),
    symbol: "MSFT",
    loadCandles: async () => ({
      candles,
      coverage: {
        source: "persistent_fallback",
        originSource: "persistent",
        endpoint: "https://openapi-sg.longportapp.com/v2",
        latestTradeDate: "2025-08-08",
        complete: true,
        cacheAgeMs: 86_400_000,
        partialReasons: ["stale_cache", "live_refresh_failed"],
        fallbackReason: { message: "network unavailable" },
      },
    }),
  });

  assert.equal(run.technical.marketData.freshForResearch, true);
  assert.equal(run.technical.marketData.freshForDecision, false);
  assert.equal(run.technical.marketData.freshForSizing, false);
  assert.equal(run.risk.supported, false);
  assert.equal(run.risk.awaitingModelReview, false);
  assert.match(run.risk.limitation, /日线不是最新实时来源|市场证据/);
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
  assert.equal(candleCalls, 2);
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

test("USD-only evidence needs no FX service and preserves missing cost-basis semantics", async () => {
  const portfolio = portfolioFixture();
  portfolio.dataQuality.fxStatus = "not_required";
  portfolio.dataQuality.ignoredFxErrors = [{ code: "fx_fetch_failed" }];
  portfolio.positions[0].costPrice = null;
  portfolio.positions[0].pnlBase = null;
  portfolio.positions[0].pnlPercent = null;
  portfolio.positions[0].costBasisStatus = "missing";
  portfolio.positions[0].costBasisLimitation = "cost_basis_missing";

  const run = await buildAnalysisEvidence({
    scope: "portfolio",
    portfolio,
    task: "检查整个 USD 组合",
    loadCandles: async () => risingCandles(220),
  });

  const fxEvidence = run.evidence.find((item) => item.tool === "fx_not_required");
  assert.equal(fxEvidence?.status, "succeeded");
  assert.match(fxEvidence?.summary ?? "", /无需汇率换算/);
  assert.equal(run.analysisContext.positions[0].costPrice, null);
  assert.equal(run.analysisContext.positions[0].costBasisStatus, "missing");
  assert.equal(run.analysisContext.positions[0].costBasisLimitation, "cost_basis_missing");
});

test("portfolio scope consumes the persisted Tier-A batch without refetching holdings", async () => {
  const portfolio = portfolioFixture();
  let candleCalls = 0;
  const technicalRadar = {
    tradingDate: "2026-08-28",
    computedAt: "2026-08-29T00:10:00.000Z",
    recordedAt: "2026-08-29T00:10:01.000Z",
    inputHash: "a".repeat(64),
    scannerVersion: "tier-a-technical-scan/v1",
    summary: {
      status: "complete",
      coverage: { selectedSymbolCount: 2, completeCardCount: 2 },
      rankings: { changes: { rows: [{ symbol: "AAPL.US", changedFieldCount: 1 }] } },
    },
    items: [{
      symbol: "AAPL.US",
      memberships: ["holding"],
      status: "complete",
      cutoff: "2026-08-28",
      inputHash: "b".repeat(64),
      structure: { short: "bullish", long: "bullish", priceVsEma21: "above" },
      observableState: { shortStructure: "bullish" },
      degradedReasons: [],
    }],
    limitations: ["observation_not_signal"],
  };
  const run = await buildAnalysisEvidence({
    scope: "portfolio",
    portfolio,
    technicalRadar,
    loadCandles: async () => {
      candleCalls += 1;
      return risingCandles(220);
    },
  });

  assert.equal(candleCalls, 0);
  assert.equal(run.analysisContext.technicalRadar.available, true);
  assert.equal(run.analysisContext.technicalRadar.tradingDate, "2026-08-28");
  assert.equal(run.analysisContext.technicalRadar.cards[0].symbol, "AAPL.US");
  assert.equal(run.analysisContext.technicalRadar.cards[0].structure.short, "bullish");
  assert.equal(run.evidence.find((item) => item.tool === "local:tier-a-technical-radar").status, "degraded");
  assert.deepEqual(run.analysisContext.technicalRadar.coverage.missingSymbols, ["TSM.US"]);
  assert.ok(run.analysisContext.technicalRadar.coverage.reasons.includes("radar_batch_identity_missing"));
  assert.match(run.technical.reason, /确定性技术雷达/);
});

test("portfolio radar preserves source identity and only calls a matching current batch complete", async () => {
  const portfolio = portfolioFixture();
  portfolio.brokerScope = "longbridge";
  portfolio.accountScopeIdentity = { scopeId: "fixture-longbridge-A" };
  const technicalRadar = radarForPortfolio(portfolio);
  const run = await buildAnalysisEvidence({ scope: "portfolio", portfolio, technicalRadar });
  const radar = run.analysisContext.technicalRadar;
  assert.equal(radar.status, "complete");
  assert.equal(radar.batchId, technicalRadar.batchId);
  assert.equal(radar.accountScopeId, technicalRadar.accountScopeId);
  assert.equal(radar.recordHash, technicalRadar.recordHash);
  assert.equal(radar.portfolioBinding.accountScopeId, portfolio.accountScopeIdentity.scopeId);
  assert.equal(radar.portfolioBinding.sameAccountScope, true);
  assert.equal(radar.freshness.currentTradingDate, true);
  assert.equal(radar.coverage.matchedSymbolCount, 2);
  assert.deepEqual(radar.coverage.missingSymbols, []);
  assert.equal(run.evidence.find(item => item.tool === "local:tier-a-technical-radar").status, "succeeded");
});

test("IBKR and combined portfolio radar use only matching market references, never Longbridge holdings coverage", async () => {
  const original = portfolioFixture();
  original.accountScopeIdentity = { scopeId: "fixture-longbridge-A" };
  const technicalRadar = radarForPortfolio(original);
  const unchanged = structuredClone(technicalRadar);
  for (const brokerScope of ["ibkr", "all"]) {
    const portfolio = portfolioFixture();
    portfolio.brokerScope = brokerScope;
    portfolio.accountScopeIdentity = brokerScope === "ibkr" ? { scopeId: "fixture-ibkr-B" } : null;
    portfolio.brokerAccounts = brokerScope === "ibkr"
      ? [{ broker: "ibkr", scopeId: "fixture-ibkr-B" }]
      : [{ broker: "longbridge", scopeId: "fixture-longbridge-A" }, { broker: "ibkr", scopeId: "fixture-ibkr-B" }];
    portfolio.positions[1].symbol = "MSFT.US";
    const run = await buildAnalysisEvidence({ scope: "portfolio", portfolio, technicalRadar });
    const radar = run.analysisContext.technicalRadar;
    assert.equal(radar.status, "partial", brokerScope);
    assert.equal(radar.accountScopeId, "fixture-longbridge-A");
    assert.equal(radar.portfolioBinding.sameAccountScope, false);
    assert.equal(radar.portfolioBinding.usage, "matching_symbols_market_reference_only");
    assert.deepEqual(radar.cards.map(item => item.symbol), ["AAPL.US"]);
    assert.deepEqual(radar.coverage.missingSymbols, ["MSFT.US"]);
    assert.equal(radar.rankings, null);
    assert.equal(radar.comparison, null);
    assert.equal(run.evidence.find(item => item.tool === "local:tier-a-technical-radar").status, "degraded");
  }
  assert.deepEqual(technicalRadar, unchanged);
});

test("changed holdings and old sessions cannot inherit a complete radar coverage claim", async () => {
  const portfolio = portfolioFixture();
  portfolio.accountScopeIdentity = { scopeId: "fixture-longbridge-A" };
  const original = radarForPortfolio(portfolio);
  for (const change of ["new-holding", "sold-holding", "old-session", "unmatched", "option", "ibkr-options-only"]) {
    const selected = structuredClone(portfolio);
    const technicalRadar = structuredClone(original);
    if (change === "new-holding") selected.positions[1].symbol = "MSFT.US";
    if (change === "sold-holding") selected.positions.pop();
    if (change === "old-session") technicalRadar.tradingDate = "2020-01-02";
    if (change === "unmatched") selected.positions = selected.positions.map(item => ({ ...item, symbol: "MSFT.US" }));
    if (change === "option") selected.positions.push({ symbol: "AAPL260918C00200000.US", quantity: 1, instrumentType: "option" });
    if (change === "ibkr-options-only") {
      selected.brokerScope = "ibkr";
      selected.accountScopeIdentity = { scopeId: "fixture-ibkr-B" };
      selected.positions = [{ symbol: "AAPL260918C00200000.US", quantity: 1, instrumentType: "option" }];
    }
    const run = await buildAnalysisEvidence({ scope: "portfolio", portfolio: selected, technicalRadar });
    const radar = run.analysisContext.technicalRadar;
    assert.notEqual(radar.status, "complete", change);
    assert.notEqual(run.evidence.find(item => item.tool === "local:tier-a-technical-radar").status, "succeeded", change);
    assert.equal(radar.coverage.matchedSymbolCount, radar.cards.length);
    if (["unmatched", "ibkr-options-only"].includes(change)) {
      assert.equal(radar.available, false);
      assert.equal(radar.status, "unavailable");
      assert.match(radar.limitation, /没有匹配当前组合/);
    }
    if (change === "old-session") {
      assert.equal(radar.freshness.currentTradingDate, false);
      assert.equal(radar.available, true);
      assert.equal(radar.portfolioBinding.sameAccountScope, true);
      assert.equal(radar.cards.length, 2);
    }
    if (change === "ibkr-options-only") {
      assert.equal(radar.coverage.requestedSymbolCount, 0);
      assert.equal(radar.coverage.excludedHoldings[0].reason, "option_not_covered_by_equity_radar");
    }
  }
});

test("projected radar identity and missing holdings survive the actual Codex evidence wire contract", async () => {
  const { buildCodexEvidence, buildWorkspaceAdditionalContext, validateWorkspaceEvidenceDelivery } =
    await import("../src/engine/codex-workspace.mjs");
  const portfolio = portfolioFixture();
  portfolio.accountScopeIdentity = { scopeId: "fixture-longbridge-A" };
  const technicalRadar = radarForPortfolio(portfolio);
  portfolio.positions[1].symbol = "MSFT.US";
  const run = await buildAnalysisEvidence({ scope: "portfolio", portfolio, technicalRadar });
  const evidence = buildCodexEvidence({ portfolio, run, task: "fixture portfolio review" });
  const contexts = buildWorkspaceAdditionalContext(evidence, "fixture audit");
  assert.doesNotThrow(() => validateWorkspaceEvidenceDelivery(evidence, contexts));
  const serialized = JSON.stringify(contexts);
  for (const required of [technicalRadar.batchId, technicalRadar.accountScopeId,
    technicalRadar.recordHash, "current_holdings_missing_radar_cards", "MSFT.US"]) {
    assert.ok(serialized.includes(required), required);
  }
  const changed = structuredClone(evidence);
  changed.scopedContext.technicalRadar.portfolioBinding.accountScopeId = "different-account";
  assert.throws(() => validateWorkspaceEvidenceDelivery(changed, contexts), /technicalRadar/);
});

function radarForPortfolio(portfolio) {
  const holdingSymbols = portfolio.positions.map(item => item.symbol).sort();
  return {
    batchId: "fixture-radar-batch-A", accountScopeId: portfolio.accountScopeIdentity.scopeId,
    recordHash: "a".repeat(64), tradingDate: expectedLastCompletedTradingDate(), recordedAt: new Date().toISOString(),
    inputHash: "b".repeat(64), summary: { status: "complete", universe: { holdingSymbols },
      coverage: { selectedSymbolCount: holdingSymbols.length, completeCardCount: holdingSymbols.length },
      rankings: { changes: { rows: [{ symbol: holdingSymbols[0] }] } }, comparison: { source: "fixture" } },
    items: holdingSymbols.map(symbol => ({ symbol, memberships: ["holding"], status: "complete", inputHash: "c".repeat(64) })),
  };
}

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

test("one blocked position valuation gate preserves technical research but disables sizing and plans", async () => {
  const portfolio = portfolioWithHostValuationGate({ blockedSymbol: "AAPL.US" });
  const run = await buildAnalysisEvidence({
    scope: "position",
    portfolio,
    symbol: "AAPL.US",
    task: "保留技术研究，但不要用失效报价生成仓位计划",
    loadCandles: async () => risingCandles(220),
  });

  assert.equal(portfolio.freshness.state, "fresh");
  assert.equal(portfolio.freshness.snapshotFreshForSizing, true);
  assert.equal(portfolio.freshness.freshForSizing, false);
  assert.equal(portfolio.valuationGate.outcome.status, "block");
  assert.ok(Number.isFinite(run.technical.ema[21]));
  assert.ok(run.technical.calculationBarCount >= 21);
  assert.equal(run.risk.supported, true);
  assert.equal(run.risk.sizingSupported, false);
  assert.equal(run.risk.selectedQuoteReadyForSizing, false);
  assert.ok(run.risk.valuationGateReasonCodes.includes(
    "quote_older_than_latest_completed_session",
  ));
  assert.equal(run.plan.state, "valuation_gate_blocked");
  assert.equal(run.plan.available, false);
  assert.equal(run.capabilities.conditionalPlan, false);
  assert.equal(run.evidence.find((item) => item.tool === "quote")?.status, "degraded");
  assert.equal(run.context.snapshotAt, portfolio.syncedAt);
  assert.equal(run.context.valuationSchemaVersion, portfolio.valuationSchemaVersion);
  assert.equal(run.context.valuationGateInputHash, portfolio.valuationGate.inputHash);
  assert.equal(run.context.valuationGateHash, portfolio.valuationGate.hash);
});

test("a passing host valuation gate enables the same position sizing and conditional plan", async () => {
  const portfolio = portfolioWithHostValuationGate();
  const run = await buildAnalysisEvidence({
    scope: "position",
    portfolio,
    symbol: "AAPL.US",
    task: "分析持仓并生成条件计划",
    loadCandles: async () => risingCandles(220),
  });

  assert.equal(portfolio.valuationGate.outcome.status, "pass");
  assert.equal(portfolio.freshness.freshForSizing, true);
  assert.equal(run.risk.supported, true);
  assert.equal(run.risk.sizingSupported, true);
  assert.equal(run.risk.selectedQuoteReadyForSizing, true);
  assert.equal(run.plan.state, "static_snapshot");
  assert.equal(run.plan.available, true);
  assert.ok(run.plan.scenarios.length >= 3);
  assert.equal(run.capabilities.conditionalPlan, true);
  assert.equal(run.evidence.find((item) => item.tool === "quote")?.status, "succeeded");
});

test("saved plans bind all snapshot and valuation-gate identities before persistence", async () => {
  const main = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
  const start = main.indexOf('ipcMain.handle("agent:save-plan"');
  const end = main.indexOf('ipcMain.on("tv:set-bounds"', start);
  assert.ok(start >= 0 && end > start, "agent:save-plan handler must be discoverable");
  const handler = main.slice(start, end);

  assert.match(handler, /run\.context\.snapshotAt !== portfolio\.syncedAt/);
  assert.match(
    handler,
    /run\.context\.valuationSchemaVersion !== portfolio\.valuationSchemaVersion/,
  );
  assert.match(
    handler,
    /run\.context\.valuationGateInputHash !== portfolio\.valuationGate\?\.inputHash/,
  );
  assert.match(
    handler,
    /run\.context\.valuationGateHash !== portfolio\.valuationGate\?\.hash/,
  );
  assert.match(
    handler,
    /throw new Error\("计划对应的持仓快照已失效，请重新运行 Agent。"\)/,
  );
  assert.match(handler, /if \(!portfolioFreshness\(portfolio\)\.freshForSizing\)/);
  assert.match(handler, /await businessStateStore\.set\("watchPlans"/);

  const bindingGuard = handler.indexOf("run.context.snapshotAt !== portfolio.syncedAt");
  const gateFreshnessGuard = handler.indexOf("portfolioFreshness(portfolio).freshForSizing");
  const persistence = handler.indexOf('businessStateStore.set("watchPlans"');
  assert.ok(bindingGuard >= 0 && bindingGuard < gateFreshnessGuard);
  assert.ok(gateFreshnessGuard < persistence);
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

test("boolean risk budgets stay unavailable instead of coercing to zero or one percent", () => {
  const risk = calculatePortfolioRisk(portfolioFixture(), true);
  assert.equal(risk.riskBudgetPercent, null);
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

test("portfolio source labels describe the selected broker observation without inventing API calls", async () => {
  for (const [brokerScope, expectedSource, accountTool, holdingsTool] of [
    ["longbridge", "长桥账户", "account_balance", "stock_positions"],
    ["ibkr", "IBKR 账户观察", "local:ibkr-account-snapshot", "local:ibkr-position-snapshot"],
    ["all", "多券商账户汇总", "local:broker-account-aggregate", "local:broker-position-aggregate"],
  ]) {
    const portfolio = { ...portfolioFixture(), brokerScope };
    const run = await buildAnalysisEvidence({ scope: "portfolio", portfolio });
    assert.equal(run.evidence[0].source, expectedSource);
    assert.equal(run.evidence[0].tool, accountTool);
    assert.equal(run.evidence[1].tool, holdingsTool);
    assert.match(run.safeguards.execution, /对应券商/);
  }
});

test("position evidence distinguishes IBKR valuation observations from unchanged Longbridge daily bars", async () => {
  const portfolio = { ...portfolioFixture(), brokerScope: "ibkr" };
  portfolio.positions[0].broker = "ibkr";
  const run = await buildAnalysisEvidence({ portfolio, symbol: "AAPL.US", loadCandles: async () => [] });
  assert.equal(run.evidence[0].source, "IBKR 账户观察");
  assert.equal(run.evidence[1].source, "IBKR 真实持仓");
  const mark = run.evidence.find((item) => item.tool === "local:ibkr-portfolio-mark");
  assert.equal(mark.source, "IBKR 账户估值观察");
  assert.equal(run.evidence.some((item) => item.tool === "quote" || item.tool === "option_quote"), false);
  assert.equal(run.evidence.find((item) => item.tool === "candlesticks").source, "长桥日线");
  assert.match(run.safeguards.execution, /对应券商/);
});

test("all-account position evidence retains the selected leg's broker or labels a merged valuation explicitly", async () => {
  for (const [broker, tool, source] of [["longbridge", "quote", "长桥行情"], ["multiple", "local:broker-valuation-aggregate", "多券商估值汇总观察"]]) {
    const portfolio = { ...portfolioFixture(), brokerScope: "all" };
    portfolio.positions[0].broker = broker;
    const run = await buildAnalysisEvidence({ portfolio, symbol: "AAPL.US", loadCandles: async () => [] });
    assert.equal(run.evidence[0].source, "多券商账户汇总");
    assert.equal(run.evidence.find((item) => item.tool === tool).source, source);
  }
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

function portfolioWithHostValuationGate({ blockedSymbol = null } = {}) {
  const assessedAt = "2026-08-30T16:00:00.000Z";
  const latestOfficialClose = "2026-08-28T19:59:00.000Z";
  const oldClose = "2026-08-27T19:59:00.000Z";
  const portfolio = portfolioFixture();
  portfolio.syncedAt = assessedAt;
  portfolio.quoteAsOf = blockedSymbol ? oldClose : latestOfficialClose;
  portfolio.quoteLatestAsOf = latestOfficialClose;
  portfolio.valuationSchemaVersion = 2;
  portfolio.account.totalCash = 6_800;
  portfolio.account.valuationComplete = true;
  portfolio.totals.positionsNetMarketValueBase = 3_200;
  portfolio.positions = portfolio.positions.map((item) => ({
    ...item,
    grossQuantity: Math.abs(item.quantity),
    marketValue: item.marketValueBase,
    contractMultiplier: 1,
    quoteTimestamp: item.symbol === blockedSymbol ? oldClose : latestOfficialClose,
    quoteSession: "regular",
    tradeStatus: "NormalStatus",
  }));
  portfolio.valuationGate = assessPortfolioValuationGate({
    portfolio,
    assessedAt,
  });
  return withPortfolioFreshness(portfolio, {
    now: Date.parse(assessedAt),
    forceState: "fresh",
  });
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

function risingHourlyBars(count, { startHour = 0 } = {}) {
  const base = Date.UTC(2026, 7, 20, 13, 30);
  return Array.from({ length: count }, (_, index) => {
    const close = 200 + startHour + index;
    const timestamp = new Date(base + (startHour + index) * 60 * 60 * 1000).toISOString();
    return {
      timestamp,
      tradeDate: timestamp.slice(0, 10),
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 2_000 + index,
      tradeSession: "Intraday",
      isClosed: true,
    };
  });
}
