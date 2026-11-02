import { calculateTechnical, round } from "./technical.mjs";
import { calculateDailyExcessReturns } from "./daily-sequence.mjs";
import { buildCoreNumericEvidence } from "./numeric-evidence-adapter.mjs";
import {
  aggregateCompletedDailyBarsToWeeks,
  buildTechnicalV2,
} from "./technical-v2.mjs";
import { buildTierBTechnicalEvidence } from "./tier-b-technical-evidence.mjs";
import { fxEvidenceMetadata } from "./fx-evidence.mjs";
import { expectedLastCompletedTradingDate } from "./market-evidence.mjs";

const PORTFOLIO_RISK_POLICY = Object.freeze({
  top1WarningPercent: 20,
  top1CriticalPercent: 30,
  top5WarningPercent: 60,
  top5CriticalPercent: 80,
  groupWarningPercent: 30,
  groupCriticalPercent: 45,
  grossWarningPercent: 120,
  grossHardMaxPercent: 150,
  grossCriticalPercent: 150,
  maxLeverageMultiple: 1.5,
  lowCashWarningPercent: 5,
});

// This module is a deterministic evidence builder, not a conversational
// harness. Codex App Server owns the only Agent/thread/tool lifecycle.
export async function buildAnalysisEvidence(options = {}) {
  const scope = normalizeAnalysisScope(options.scope);
  if (scope === "chat") return buildResearchEvidence(options);
  if (scope === "portfolio") return buildPortfolioEvidence(options);
  if (scope === "candidate") return buildCandidateEvidence(options);
  return buildPositionEvidence(options);
}

export function buildResearchEvidence({ task = "自由研究", signal } = {}) {
  throwIfCancelled(signal);
  return {
    id: crypto.randomUUID(), status: "research_ready", state: "RESEARCH_READY",
    createdAt: new Date().toISOString(), elapsedMs: 0, task,
    context: { scope: "chat", symbol: null, ticker: "RESEARCH", timeframe: null,
      snapshotAt: null, marketDataAsOf: null, intent: "research" },
    analysisContext: { scope: "chat", portfolioSummary: null, target: null,
      dataBoundary: "No portfolio, quote or technical evidence is automatically attached to free research. Use cited available sources or ask the user; missing values are unknown, not zero." },
    technical: null, risk: null, plan: { available: false }, evidence: [],
    safeguards: defaultSafeguards(), sections: ["conclusion"],
    capabilities: { orderWrite: false, conditionalPlan: false, freeResearch: true },
  };
}

// Backwards-compatible entry point for existing callers. New callers should
// pass an explicit scope to buildAnalysisEvidence so a portfolio review never
// starts per-symbol candle requests by accident.
export async function buildTradingEvidence(options = {}) {
  return buildAnalysisEvidence({ ...options, scope: options.scope ?? "position" });
}

async function buildPositionEvidence({
  portfolio,
  symbol,
  task = "分析当前持仓",
  riskBudgetPercent = 0.8,
  loadCandles,
  loadMarketSeries,
  technicalLinkage = null,
  anchoredVwap = null,
  optionEvidence = null,
  catalystEvidence = null,
  onStage = () => {},
  signal,
}) {
  throwIfCancelled(signal);
  const startedAt = Date.now();
  const position = portfolio?.positions?.find((item) => item.symbol === symbol);
  if (!position) throw new Error("选中的标的不在当前账户范围的持仓中。");
  const intent = classifyIntent(task);
  const snapshotFresh = portfolio.freshness?.freshForSizing === true;
  const positionValuationGate = portfolio.valuationGate?.positions?.find(
    (item) => item?.symbol === position.symbol,
  ) ?? null;
  const portfolioEvidenceStatus = portfolio.status === "live" && snapshotFresh
    ? "succeeded"
    : "degraded";
  const selectedQuoteStatus = position.lastPrice != null
    && position.quoteTimestamp
    && snapshotFresh
    && positionValuationGate?.readyForSizing === true
    ? "succeeded"
    : "degraded";
  const fxEvidence = fxEvidenceMetadata(portfolio);
  const { status: fxStatus, evidenceStatus: fxEvidenceStatus, source: fxSource, summary: fxSummary } = fxEvidence;
  const accountEvidenceStatus = portfolio.account?.netAssets != null && snapshotFresh
    ? "succeeded"
    : "degraded";
  const snapshotSummary = portfolioSnapshotEvidenceSummary(portfolio);
  const brokerSource = brokerObservationLabels(portfolio, position);

  const evidence = [
    evidenceItem(brokerSource.account, brokerSource.accountTool, portfolio.syncedAt, 1, accountEvidenceStatus, `${snapshotSummary}；${fxStatus === "not_required" ? "USD 单币种账户，无跨币种限制" : "跨币种聚合受汇率证据状态约束"}`),
    evidenceItem(
      brokerSource.holdings,
      brokerSource.holdingsTool,
      portfolio.syncedAt,
      portfolio.positions.length,
      snapshotFresh ? "succeeded" : "degraded",
      `${position.symbol} 数量 ${formatNumber(position.quantity)} · 权重 ${formatPercent(position.weight)} · ${snapshotSummary}`,
    ),
    evidenceItem(
      fxSource,
      fxEvidence.tool,
      fxEvidence.asOf,
      portfolio.fx?.currencyCount ?? 0,
      fxEvidenceStatus,
      fxSummary,
    ),
    evidenceItem(
      brokerSource.quote,
      brokerSource.quoteTool,
      position.quoteTimestamp,
      position.lastPrice != null ? 1 : 0,
      selectedQuoteStatus,
      position.lastPrice != null
        ? `现价 ${formatNumber(position.lastPrice)} · ${position.quoteSession ?? "unknown session"} · ${selectedQuoteStatus === "succeeded" ? "逐标的报价与估值校验通过" : `仅供回看，不用于仓位计算${positionValuationGate?.reasonCodes?.length ? `（${positionValuationGate.reasonCodes.join("、")}）` : ""}`}`
        : position.valuationLimitation,
    ),
  ];

  let candles = [];
  let candleCoverage = null;
  let benchmarkLoad = null;
  let technical;
  if (position.instrumentType === "option") {
    notifyStage(onStage, "technical_skipped", "期权合约跳过正股技术指标，正在检查组合风险");
    technical = calculateTechnical([]);
    technical.reason = "当前选中项为期权合约；本版本不会把期权价格当作正股做 EMA/Fib 或线性风险推演。";
    evidence.push(
      evidenceItem("长桥日线", "candlesticks", null, 0, "skipped", "期权合约需要标的映射、乘数与 Greeks"),
    );
  } else try {
    notifyStage(onStage, "candles", `正在读取 ${symbol} 日线（超时会自动降级，不会阻塞 Agent）`);
    const marketBundle = await loadTargetAndBenchmarkCandles(loadCandles, symbol);
    const candleResult = marketBundle.target;
    benchmarkLoad = marketBundle.benchmark;
    candles = candleResult.candles;
    candleCoverage = candleResult.coverage;
    throwIfCancelled(signal);
    technical = attachBenchmarkRelativeStrength(calculateTechnical(candles, {
      symbol: position.symbol,
      coverage: candleCoverage,
    }), {
      symbol: position.symbol,
      targetCandles: candles,
      benchmarkLoad,
    });
    evidence.push(
      evidenceItem(
        "长桥日线",
        "candlesticks",
        technical.asOf ?? null,
        technical.calculationBarCount,
        technical.marketData
          ? technical.marketData.freshForDecision ? "succeeded" : "degraded"
          : technical.capabilities?.officialBar ? "succeeded" : "degraded",
        candleEvidenceSummary(technical),
      ),
    );
    evidence.push(benchmarkEvidenceItem(technical));
  } catch (error) {
    throwIfCancelled(signal);
    technical = calculateTechnical([]);
    evidence.push(
      evidenceItem("长桥日线", "candlesticks", null, 0, "failed", cleanError(error)),
    );
  }

  if (position.instrumentType !== "option") {
    technical = await attachTechnicalV2({
      technical,
      dailyCandles: candles,
      symbol,
      task,
      loadCandles,
      loadMarketSeries,
      benchmarkLoad,
      dailyCoverage: candleCoverage,
      technicalLinkage,
      anchoredVwap,
      optionEvidence,
      catalystEvidence,
      onStage,
      signal,
    });
    appendMultiTimeframeEvidence(evidence, technical);
  }

  notifyStage(onStage, "risk_plan", "正在整理市场证据、组合风险与条件计划");
  throwIfCancelled(signal);

  evidence.push(
    evidenceItem(
      "EMA 引擎",
      "local:ema",
      technical.asOf ?? null,
      technical.candleCount,
      technical.status === "complete" ? "succeeded" : technical.ema?.[21] ? "degraded" : "skipped",
      "EMA 3/5/8/13/21/144/169",
    ),
  );
  evidence.push(
    evidenceItem(
      "Fib 引擎",
      "local:fibonacci",
      technical.asOf ?? null,
      technical.fib ? 4 : 0,
      technical.fib ? "succeeded" : "skipped",
      "0.382 / 0.618 / 1 / 1.618",
    ),
  );

  const risk = calculatePositionRisk(portfolio, position, technical, riskBudgetPercent);
  evidence.push(
    evidenceItem(
      "组合风险",
      "local:portfolio-risk",
      portfolio.syncedAt,
      portfolio.positions.length,
      risk.supported && risk.portfolioValuationComplete ? portfolioEvidenceStatus : "degraded",
      risk.supported
        ? `Top1 ${formatPercent(portfolio.totals.top1Weight)} · ${position.group} ${formatPercent(portfolio.groupExposure[position.group])}`
        : risk.limitation,
    ),
  );

  const plan = buildConditionalPlan(position, technical, risk);
  const conclusion = buildConclusion(position, technical, risk, task, intent);
  const hasUsableMarketEvidence = candidateMarketEvidenceReady(technical);
  const state = !hasUsableMarketEvidence
    ? "DEGRADED"
    : technical.status === "complete" && risk.supported && risk.portfolioValuationComplete
      ? "REVIEW_READY"
      : "PARTIAL_REVIEW";

  return {
    id: crypto.randomUUID(),
    status: state.toLowerCase(),
    state,
    createdAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    task,
    context: {
      scope: "position",
      symbol: position.symbol,
      ticker: position.ticker,
      isHeld: true,
      timeframe: "1D",
      intent,
      snapshotAt: portfolio.syncedAt,
      valuationSchemaVersion: portfolio.valuationSchemaVersion ?? null,
      valuationGateInputHash: portfolio.valuationGate?.inputHash ?? null,
      valuationGateHash: portfolio.valuationGate?.hash ?? null,
      marketDataAsOf: technical.asOf ?? position.quoteTimestamp,
      marketDataTradingDate: technical.asOfTradingDate ?? null,
    },
    analysisContext: buildScopedAnalysisContext({
      scope: "position",
      portfolio,
      target: position,
      technical,
      risk,
      candles,
    }),
    conclusion,
    technical,
    risk,
    plan,
    evidence,
    safeguards: {
      orderWrite: false,
      modelNarration: false,
      execution: "所有交易由用户在对应券商端手动确认",
    },
    sections: sectionsForIntent(intent),
    capabilities: {
      ...technical.capabilities,
      portfolioRisk: risk.supported,
      portfolioRiskComplete: risk.portfolioValuationComplete,
      conditionalPlan: plan.available,
      weeklyStructure: technical.technicalV2?.capabilityMatrix?.weeklyStructure?.status ?? "unavailable",
      execution60m: technical.technicalV2?.capabilityMatrix?.execution60m?.status ?? "unavailable",
      costProfile14d28d: technical.technicalV2?.capabilityMatrix?.costProfile14d28d?.status ?? "unavailable",
      anchoredVwap: technical.technicalV2?.capabilityMatrix?.anchoredVwap?.status ?? "unavailable",
      backgroundWatcher: false,
      orderWrite: false,
    },
  };
}

async function buildCandidateEvidence({
  portfolio,
  symbol,
  task = "分析候选标的并准备买入计划",
  riskBudgetPercent = 0.8,
  loadCandles,
  loadMarketSeries,
  technicalLinkage = null,
  anchoredVwap = null,
  optionEvidence = null,
  catalystEvidence = null,
  onStage = () => {},
  signal,
}) {
  throwIfCancelled(signal);
  assertPortfolio(portfolio);
  const startedAt = Date.now();
  const targetSymbol = normalizeCandidateSymbol(symbol);
  const existingPosition = portfolio.positions.find((item) => item.symbol === targetSymbol) ?? null;
  const candidateInstrumentType = existingPosition?.instrumentType
    ?? inferCandidateInstrumentType(targetSymbol);
  const intent = classifyIntent(task);
  const evidence = buildPortfolioSourceEvidence(portfolio, {
    holdingsSummary: existingPosition
      ? `${targetSymbol} 已存在持仓；本次仍按“候选加仓计划”评估`
      : `${targetSymbol} 当前不在持仓；仅评估候选买入计划`,
  });

  let candles = [];
  let candleCoverage = null;
  let benchmarkLoad = null;
  let technical;
  if (candidateInstrumentType === "option") {
    notifyStage(onStage, "technical_skipped", "候选期权不使用合约价格生成正股 EMA/Fib 或线性买入计划");
    technical = calculateTechnical([]);
    technical.reason = "候选项为期权合约；需要标的映射、合约乘数与 Greeks 后再评估。";
    evidence.push(
      evidenceItem(
        "长桥日线",
        "candlesticks",
        null,
        0,
        "skipped",
        "候选期权不套用正股 EMA/Fib 与线性风险预算",
      ),
    );
  } else try {
    notifyStage(onStage, "candles", `正在读取 ${targetSymbol} 日线（候选分析不要求已持仓）`);
    const marketBundle = await loadTargetAndBenchmarkCandles(loadCandles, targetSymbol);
    const candleResult = marketBundle.target;
    benchmarkLoad = marketBundle.benchmark;
    candles = candleResult.candles;
    candleCoverage = candleResult.coverage;
    throwIfCancelled(signal);
    technical = attachBenchmarkRelativeStrength(calculateTechnical(candles, {
      symbol: targetSymbol,
      coverage: candleCoverage,
    }), {
      symbol: targetSymbol,
      targetCandles: candles,
      benchmarkLoad,
    });
    evidence.push(
      evidenceItem(
        "长桥日线",
        "candlesticks",
        technical.asOf ?? null,
        technical.calculationBarCount,
        technical.marketData
          ? technical.marketData.freshForDecision ? "succeeded" : "degraded"
          : technical.capabilities?.officialBar ? "succeeded" : "degraded",
        candleEvidenceSummary(technical),
      ),
    );
    evidence.push(benchmarkEvidenceItem(technical));
  } catch (error) {
    throwIfCancelled(signal);
    technical = calculateTechnical([]);
    evidence.push(
      evidenceItem("长桥日线", "candlesticks", null, 0, "failed", cleanError(error)),
    );
  }

  if (candidateInstrumentType !== "option") {
    technical = await attachTechnicalV2({
      technical,
      dailyCandles: candles,
      symbol: targetSymbol,
      task,
      loadCandles,
      loadMarketSeries,
      benchmarkLoad,
      dailyCoverage: candleCoverage,
      technicalLinkage,
      anchoredVwap,
      optionEvidence,
      catalystEvidence,
      onStage,
      signal,
    });
    appendMultiTimeframeEvidence(evidence, technical);
  }

  notifyStage(onStage, "risk_plan", "正在整理候选市场证据与组合安全边界，并交给 Codex 独立评估");
  throwIfCancelled(signal);
  appendTechnicalEvidence(evidence, technical);

  const target = {
    symbol: targetSymbol,
    ticker: existingPosition?.ticker ?? targetSymbol.split(".")[0],
    name: existingPosition?.name ?? targetSymbol,
    group: existingPosition?.group ?? "候选标的",
    currency: existingPosition?.currency ?? inferSymbolCurrency(targetSymbol),
    instrumentType: candidateInstrumentType,
    isHeld: Boolean(existingPosition),
    existingWeight: finiteOrNull(existingPosition?.weight),
    lastPrice: finiteOrNull(technical.lastPrice),
  };
  const risk = calculateCandidateRisk(
    portfolio,
    target,
    technical,
    riskBudgetPercent,
  );
  const plan = buildCandidatePlan(target, technical, risk);
  const conclusion = buildCandidateConclusion(target, technical, risk, task);
  evidence.push(
    evidenceItem(
      "候选安全边界",
      "local:candidate-safety-envelope",
      portfolio.syncedAt,
      1,
      risk.supported ? "succeeded" : "degraded",
      risk.supported
        ? `本地仅给出硬安全上限 ${formatPercent(risk.hardMaxTotalWeightPercent)}；证据权重、失效位与建议仓位由 Codex 评估`
        : risk.limitation,
    ),
  );

  const hasUsableMarketEvidence = candidateMarketEvidenceReady(technical);
  const state = !hasUsableMarketEvidence
    ? "DEGRADED"
    : technical.status === "complete" && risk.supported
      ? "REVIEW_READY"
      : "PARTIAL_REVIEW";

  return {
    id: crypto.randomUUID(),
    status: state.toLowerCase(),
    state,
    createdAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    task,
    context: {
      scope: "candidate",
      symbol: target.symbol,
      ticker: target.ticker,
      isHeld: target.isHeld,
      timeframe: "1D",
      intent,
      snapshotAt: portfolio.syncedAt,
      valuationSchemaVersion: portfolio.valuationSchemaVersion ?? null,
      valuationGateInputHash: portfolio.valuationGate?.inputHash ?? null,
      valuationGateHash: portfolio.valuationGate?.hash ?? null,
      marketDataAsOf: technical.asOf ?? null,
      marketDataTradingDate: technical.asOfTradingDate ?? null,
    },
    analysisContext: buildScopedAnalysisContext({
      scope: "candidate",
      portfolio,
      target,
      technical,
      risk,
      candles,
    }),
    conclusion,
    technical,
    risk,
    plan,
    evidence,
    safeguards: defaultSafeguards(),
    sections: sectionsForIntent(intent),
    capabilities: {
      ...technical.capabilities,
      portfolioRisk: risk.supported,
      portfolioRiskComplete: risk.portfolioValuationComplete,
      candidatePortfolioConstraints: true,
      candidateSizing: false,
      candidateLlmSizing: risk.supported,
      leverageAssessment: true,
      candidateEntryPlan: plan.available,
      conditionalPlan: plan.available,
      weeklyStructure: technical.technicalV2?.capabilityMatrix?.weeklyStructure?.status ?? "unavailable",
      execution60m: technical.technicalV2?.capabilityMatrix?.execution60m?.status ?? "unavailable",
      costProfile14d28d: technical.technicalV2?.capabilityMatrix?.costProfile14d28d?.status ?? "unavailable",
      anchoredVwap: technical.technicalV2?.capabilityMatrix?.anchoredVwap?.status ?? "unavailable",
      backgroundWatcher: false,
      orderWrite: false,
    },
  };
}

async function buildPortfolioEvidence({
  portfolio,
  task = "分析全部持仓与组合健康",
  riskBudgetPercent = 0.8,
  technicalRadar = null,
  onStage = () => {},
  signal,
}) {
  throwIfCancelled(signal);
  assertPortfolio(portfolio);
  const startedAt = Date.now();
  const intent = classifyIntent(task);
  notifyStage(onStage, "portfolio_risk", "正在汇总全部持仓、集中度、币种与保证金风险");
  const risk = calculatePortfolioRisk(portfolio, riskBudgetPercent);
  throwIfCancelled(signal);

  // Portfolio scope never performs a serial per-symbol fetch. It consumes the
  // latest immutable Tier-A batch when available; deeper Tier-B work remains
  // an explicit selected-symbol step.
  const technical = calculateTechnical([]);
  const radarContext = compactTechnicalRadarForAgent(technicalRadar, portfolio);
  technical.reason = radarContext.available
    ? `组合分析使用截止 ${radarContext.tradingDate} 的确定性技术雷达${radarContext.status === "complete" ? "" : "部分参考"}；当前股票持仓匹配 ${radarContext.coverage.matchedSymbolCount}/${radarContext.coverage.requestedSymbolCount} 项，未在本轮逐个联网读取 K 线。`
    : "组合分析没有可用的技术雷达批次；本轮不会逐个请求 K 线拖慢对话。";
  const evidence = buildPortfolioSourceEvidence(portfolio, {
    holdingsSummary: `${portfolio.positions.length} 项真实持仓 · ${portfolio.totals?.pricedPositionCount ?? "—"} 项已定价`,
  });
  evidence.push(
    evidenceItem(
      "组合健康引擎",
      "local:portfolio-health",
      portfolio.syncedAt,
      portfolio.positions.length,
      risk.supported && risk.portfolioValuationComplete ? "succeeded" : "degraded",
      `健康状态 ${risk.health} · 总暴露 ${formatPercent(risk.grossExposurePercent)} · Top1 ${formatPercent(risk.top1Weight)}`,
    ),
    evidenceItem(
      "批量技术雷达",
      "local:tier-a-technical-radar",
      radarContext.recordedAt,
      radarContext.cards.length,
      radarContext.available
        ? radarContext.status === "complete" ? "succeeded" : "degraded"
        : "skipped",
      radarContext.available
        ? `截止 ${radarContext.tradingDate} · 当前股票持仓匹配 ${radarContext.coverage.matchedSymbolCount}/${radarContext.coverage.requestedSymbolCount} 项${radarContext.status === "complete" ? "" : " · 部分/跨账户/旧批次参考，不代表当前组合完整扫描"} · 观察排序不是买卖建议`
        : radarContext.limitation ?? "尚无已持久化批次；可在左侧技术雷达手动扫描，或等待每日收盘自动扫描",
    ),
  );
  const plan = buildPortfolioPlan(risk);
  const conclusion = buildPortfolioConclusion(portfolio, risk, task);
  const state = !risk.supported
    ? "DEGRADED"
    : risk.portfolioValuationComplete
      ? "REVIEW_READY"
      : "PARTIAL_REVIEW";

  return {
    id: crypto.randomUUID(),
    status: state.toLowerCase(),
    state,
    createdAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    task,
    context: {
      scope: "portfolio",
      symbol: null,
      ticker: "PORTFOLIO",
      isHeld: null,
      timeframe: null,
      intent,
      snapshotAt: portfolio.syncedAt,
      valuationSchemaVersion: portfolio.valuationSchemaVersion ?? null,
      valuationGateInputHash: portfolio.valuationGate?.inputHash ?? null,
      valuationGateHash: portfolio.valuationGate?.hash ?? null,
      marketDataAsOf: portfolio.quoteAsOf ?? portfolio.quoteLatestAsOf ?? null,
      marketDataTradingDate: null,
    },
    analysisContext: buildScopedAnalysisContext({
      scope: "portfolio",
      portfolio,
      target: null,
      technical,
      risk,
      technicalRadar: radarContext,
    }),
    conclusion,
    technical,
    risk,
    plan,
    evidence,
    safeguards: defaultSafeguards(),
    sections: ["conclusion", "risk", "plan", "evidence"],
    capabilities: {
      ...technical.capabilities,
      portfolioRisk: risk.supported,
      portfolioRiskComplete: risk.portfolioValuationComplete,
      fullPortfolioReview: true,
      conditionalPlan: plan.available,
      backgroundWatcher: false,
      orderWrite: false,
    },
  };
}

export function normalizeAnalysisScope(scope) {
  const value = String(scope ?? "position").trim().toLowerCase();
  if (["chat", "position", "candidate", "portfolio"].includes(value)) return value;
  throw new Error("分析范围无效；仅支持 chat、position、candidate 或 portfolio。");
}

export function calculateCandidateRisk(
  portfolio,
  target,
  technical,
  riskBudgetPercent = 0.8,
) {
  const portfolioValuationComplete = portfolio.dataQuality?.valuationComplete !== false;
  const portfolioRisk = calculatePortfolioRisk(portfolio, riskBudgetPercent);
  const netAssets = finiteOrNull(portfolio.account?.netAssets);
  const lastPrice = finiteOrNull(technical.lastPrice ?? target.lastPrice);
  const requestedBudget = finiteOrNull(riskBudgetPercent);
  const normalizedBudget = requestedBudget == null ? null : round(requestedBudget, 2);
  const riskBudgetValid = normalizedBudget != null
    && normalizedBudget >= 0.05
    && normalizedBudget <= 5;
  const cashRatio = finiteOrNull(portfolio.totals?.cashRatio);
  const cashRatioValid = cashRatio != null;
  const buyPower = finiteOrNull(portfolio.account?.buyPower);
  const buyPowerValid = buyPower != null && buyPower >= 0;
  const buyPowerWeight = buyPowerValid && netAssets > 0
    ? (buyPower / netAssets) * 100
    : null;
  const technicalPlanReady = candidateMarketEvidenceReady(technical);
  const marketDataFreshForSizing = technical.marketData
    ? technical.marketData.freshForSizing === true
    : true;
  const snapshotFresh = portfolio.freshness?.freshForSizing === true;
  const snapshotAtMs = Date.parse(String(portfolio.syncedAt ?? ""));
  const sizingValidUntil = snapshotFresh && Number.isFinite(snapshotAtMs)
    ? new Date(snapshotAtMs + 2 * 60 * 1000).toISOString()
    : null;
  const cashBufferFloorPercent = 5;
  const conservativeCashWeight = !cashRatioValid
    ? null
    : Math.max(0, cashRatio - cashBufferFloorPercent);
  const existingWeight = Math.max(0, finiteOrNull(target.existingWeight) ?? 0);
  const thresholds = portfolioRisk.policyThresholds;
  const candidateGroupKnown = isKnownCandidateGroup(target.group);
  const groupWeight = candidateGroupKnown
    ? finiteOrNull(portfolio.groupExposure?.[target.group]) ?? 0
    : null;
  const concentrationHeadroom = {
    singlePositionPercent: positiveHeadroom(
      thresholds.top1WarningPercent,
      existingWeight,
    ),
    top5Percent: positiveHeadroom(
      thresholds.top5WarningPercent,
      portfolioRisk.top5Weight,
    ),
    groupPercent: candidateGroupKnown
      ? positiveHeadroom(thresholds.groupWarningPercent, groupWeight)
      : null,
    grossExposurePercent: positiveHeadroom(
      thresholds.grossHardMaxPercent,
      portfolioRisk.grossExposurePercent,
    ),
    cashFundedPercent: conservativeCashWeight,
    brokerBuyPowerPercent: buyPowerWeight,
  };
  const inputSupported =
    target.instrumentType !== "option"
    && technicalPlanReady
    && marketDataFreshForSizing
    && lastPrice > 0
    && netAssets > 0
    && portfolioValuationComplete
    && cashRatioValid
    && buyPowerValid
    && riskBudgetValid
    && portfolioRisk.derivativeExposureComplete
    && snapshotFresh;
  const hardPortfolioBlockers = [
    ...candidatePortfolioBlockers(portfolioRisk),
    ...(!marketDataFreshForSizing
      ? ["日线不是最新实时来源或已超过仓位计算时效；可继续研究，但禁止输出可执行仓位"]
      : []),
    ...(!snapshotFresh ? ["持仓快照已过期或来自缓存；可继续分析，但禁止输出可执行仓位"] : []),
    ...(!riskBudgetValid ? ["风险预算缺失或超出 0.05%–5% 的允许范围；禁止输出可执行仓位"] : []),
  ];
  const safetyCeilings = [
    concentrationHeadroom.singlePositionPercent == null
      ? null
      : existingWeight + concentrationHeadroom.singlePositionPercent,
    concentrationHeadroom.top5Percent == null
      ? null
      : existingWeight + concentrationHeadroom.top5Percent,
    concentrationHeadroom.grossExposurePercent == null
      ? null
      : existingWeight + concentrationHeadroom.grossExposurePercent,
    concentrationHeadroom.brokerBuyPowerPercent == null
      ? null
      : existingWeight + concentrationHeadroom.brokerBuyPowerPercent,
    concentrationHeadroom.groupPercent == null
      ? null
      : existingWeight + concentrationHeadroom.groupPercent,
  ].filter((value) => Number.isFinite(value));
  const unconstrainedMaxWeight = inputSupported && safetyCeilings.length
    ? Math.max(0, Math.min(...safetyCeilings))
    : null;
  const hardMaxTotalWeight = hardPortfolioBlockers.length
    ? existingWeight
    : unconstrainedMaxWeight == null
      ? null
      : Math.max(existingWeight, unconstrainedMaxWeight);
  const hardMaxAdditionalWeight = hardMaxTotalWeight == null
    ? null
    : Math.max(0, hardMaxTotalWeight - existingWeight);
  const awaitingModelReview = inputSupported
    && hardPortfolioBlockers.length === 0
    && hardMaxAdditionalWeight > 0;
  const entryAllowed = false;
  const supported = inputSupported;
  const riskBudgetValue = netAssets > 0 && riskBudgetValid
    ? netAssets * (normalizedBudget / 100)
    : null;
  const hardMaxNotional = supported && hardMaxTotalWeight != null
    ? netAssets * (hardMaxTotalWeight / 100)
    : null;
  const hardMaxAdditionalNotional = supported && hardMaxAdditionalWeight != null
    ? netAssets * (hardMaxAdditionalWeight / 100)
    : null;
  const leverage = buildCandidateLeverageAssessment({
    portfolioRisk,
    cashRatio,
    initialAdditionalWeight: 0,
    maxAdditionalWeight: hardMaxAdditionalWeight,
    entryAllowed: false,
    awaitingModelReview,
    inputSupported,
    hardPortfolioBlockers,
    candidateGroupKnown,
  });
  const entryBlockReasons = [
    ...hardPortfolioBlockers,
    ...(!inputSupported ? [candidateInputLimitation({
      target,
      portfolioValuationComplete,
      netAssets,
      lastPrice,
      technicalPlanReady,
      marketDataFreshForSizing,
      cashRatio,
      buyPower,
      snapshotFresh,
      derivativeExposureComplete: portfolioRisk.derivativeExposureComplete,
    })] : []),
    ...(inputSupported && hardMaxAdditionalWeight === 0 && hardPortfolioBlockers.length === 0
      ? ["购买力、集中度或组合毛暴露安全边界已没有新增仓位空间"]
      : []),
  ].filter(Boolean);

  return {
    scope: "candidate",
    supported,
    portfolioValuationComplete,
    technicalPlanReady,
    marketDataFreshForSizing,
    snapshotFresh,
    snapshotAt: portfolio.syncedAt ?? null,
    sizingValidUntil,
    cashRatioValid,
    buyPowerValid,
    derivativeExposureComplete: portfolioRisk.derivativeExposureComplete,
    instrumentType: target.instrumentType ?? "equity",
    limitation: supported ? null : entryBlockReasons[0] ?? "候选仓位评估证据不足。",
    entryAllowed,
    awaitingModelReview,
    entryBlockReasons,
    isHeld: Boolean(target.isHeld),
    existingPositionWeight: round(existingWeight, 2),
    positionWeight: 0,
    group: target.group,
    candidateGroupKnown,
    groupWeight: groupWeight == null ? null : round(groupWeight, 2),
    baseCurrency: portfolio.account?.baseCurrency ?? "USD",
    riskBudgetPercent: normalizedBudget,
    riskBudgetValueBase: riskBudgetValue == null ? null : round(riskBudgetValue, 2),
    referenceLevel: null,
    referenceLabel: "等待 Codex 选择失效依据",
    moveToReferencePercent: null,
    riskDistancePercent: null,
    riskLimitedWeightPercent: null,
    stageAssumption: "llm_determined",
    stagePolicyCeilingPercent: null,
    recommendedInitialAdditionalWeightPercent: null,
    recommendedInitialTotalWeightPercent: null,
    recommendedInitialNotionalBase: null,
    recommendedMaxAdditionalWeightPercent: null,
    recommendedMaxWeightPercent: null,
    recommendedMaxAdditionalNotionalBase: null,
    cashConstrainedWeightPercent: conservativeCashWeight == null
      ? null
      : round(conservativeCashWeight, 2),
    buyPowerValueBase: buyPower == null ? null : round(buyPower, 2),
    buyPowerWeightPercent: buyPowerWeight == null ? null : round(buyPowerWeight, 2),
    cashBufferFloorPercent,
    hardMaxAdditionalWeightPercent: supported && hardMaxAdditionalWeight != null
      ? round(hardMaxAdditionalWeight, 2)
      : null,
    hardMaxTotalWeightPercent: supported && hardMaxTotalWeight != null
      ? round(hardMaxTotalWeight, 2)
      : null,
    hardMaxTotalNotionalBase: hardMaxNotional == null
      ? null
      : round(hardMaxNotional, 2),
    hardMaxAdditionalNotionalBase: hardMaxAdditionalNotional == null
      ? null
      : round(hardMaxAdditionalNotional, 2),
    portfolioImpactAtReferencePercent: null,
    top1Weight: finiteRound(portfolio.totals?.top1Weight, 2),
    top5Weight: finiteRound(portfolio.totals?.top5Weight, 2),
    cashRatio: finiteRound(portfolio.totals?.cashRatio, 2),
    marginCall: portfolio.account?.marginCall ?? null,
    concentrationHeadroom: roundedObject(concentrationHeadroom),
    portfolioConstraints: candidatePortfolioConstraints(portfolioRisk),
    leverage,
    sizingNote: "本地引擎不写死指标权重、2%/4% 或 Fib/EMA 策略。Codex 可综合价格与成交量、相对强弱、成本/筹码结构、波动率、期权、板块与事件反应等证据选择失效依据和建议仓位；本地只验证新鲜度、估值、现金、集中度、总暴露、风险预算与保证金硬边界。",
  };
}

function candidateInputLimitation({
  target,
  portfolioValuationComplete,
  netAssets,
  lastPrice,
  technicalPlanReady,
  marketDataFreshForSizing = true,
  cashRatio,
  buyPower,
  snapshotFresh,
  derivativeExposureComplete,
}) {
  if (target.instrumentType === "option") {
    return "候选期权需要合约乘数、标的映射与 Greeks；不能用正股仓位或杠杆计划替代。";
  }
  if (!portfolioValuationComplete) {
    return "组合估值不完整；可观察技术条件，但不能给出风险预算仓位上限。";
  }
  if (!snapshotFresh) return "持仓快照已过期或来自缓存；可以继续研究，但不能给出可执行仓位。";
  if (!(netAssets > 0)) return "缺少可靠净资产，不能把风险预算换算为候选仓位上限。";
  if (cashRatio == null) return "缺少可靠现金比例；候选仓位与杠杆计算已关闭。";
  if (buyPower == null || buyPower < 0) {
    return "缺少可靠购买力；候选仓位与杠杆计算已关闭。";
  }
  if (!derivativeExposureComplete) {
    return "组合含期权，但当前快照缺少或尚未纳入 Delta/标的名义敞口；候选仓位与杠杆计算已关闭。";
  }
  if (!technicalPlanReady) {
    return "候选市场证据未达到计划标准（需要足够的已收盘日线、最新收盘与可靠时间戳）；不能给出仓位上限。";
  }
  if (!marketDataFreshForSizing) {
    return "候选日线仅可用于研究，来源回退、交易日缺口或缓存时效不满足仓位计算要求。";
  }
  if (!(lastPrice > 0)) return "候选 K 线缺少可靠最新收盘价。";
  return null;
}

function candidatePortfolioBlockers(portfolioRisk) {
  const blockers = [];
  if (!portfolioRisk.portfolioValuationComplete) blockers.push("组合估值不完整，暂停新增风险");
  if (!portfolioRisk.derivativeExposureComplete) {
    blockers.push("组合含未量化 Delta/标的名义敞口的期权，暂停候选仓位与杠杆计算");
  }
  if (portfolioRisk.alerts.some((item) => item.code === "margin_call")) {
    blockers.push("账户存在追加保证金要求，禁止新增仓位或杠杆");
  }
  if (portfolioRisk.grossExposurePercent != null
    && portfolioRisk.grossExposurePercent >= portfolioRisk.policyThresholds.grossHardMaxPercent) {
    blockers.push(`组合毛暴露已达到 ${portfolioRisk.policyThresholds.grossHardMaxPercent}% 硬上限，先降总风险再评估候选`);
  }
  const remainingCritical = portfolioRisk.alerts.filter((item) =>
    item.severity === "critical"
    && !["margin_call", "negative_cash", "gross_exposure"].includes(item.code));
  if (remainingCritical.length) {
    blockers.push(`组合存在关键风险：${remainingCritical.map((item) => item.label).join("、")}`);
  }
  return blockers;
}

function buildCandidateLeverageAssessment({
  portfolioRisk,
  cashRatio,
  initialAdditionalWeight,
  maxAdditionalWeight,
  entryAllowed,
  awaitingModelReview = false,
  inputSupported,
  hardPortfolioBlockers,
  candidateGroupKnown,
}) {
  const currentGross = finiteOrNull(portfolioRisk.grossExposurePercent);
  const projectedInitialGross = currentGross == null
    ? null
    : currentGross + (finiteOrNull(initialAdditionalWeight) ?? 0);
  const projectedMaxGross = currentGross == null || maxAdditionalWeight == null
    ? null
    : currentGross + maxAdditionalWeight;
  const reasons = [
    ...hardPortfolioBlockers,
  ];
  if (!candidateGroupKnown) reasons.push("候选主题尚未映射，不能验证与现有主题暴露的重叠程度");
  if (!inputSupported) reasons.push("仓位风险输入不完整，无法支持融资风险估算");
  if (!portfolioRisk.derivativeExposureComplete) {
    reasons.push("组合期权的 Delta/标的名义敞口未完整纳入组合风险，禁止新增杠杆");
  }
  if (cashRatio != null && cashRatio < 5) reasons.push("现金缓冲低于 5%，新增仓位需要显式融资复核");
  if (awaitingModelReview && inputSupported && hardPortfolioBlockers.length === 0) {
    reasons.push("融资只能由 Codex 显式选择 margin_within_cap，并由宿主按购买力与 150% 毛敞口硬上限裁剪");
  }
  const marginEligible = inputSupported
    && hardPortfolioBlockers.length === 0
    && currentGross != null
    && currentGross < portfolioRisk.policyThresholds.grossHardMaxPercent
    && finiteOrNull(maxAdditionalWeight) > 0;
  const cashHeadroom = Math.max(0, finiteOrNull(cashRatio) ?? 0);
  const potentialMaxAdditionalBorrowed = maxAdditionalWeight == null
    ? null
    : Math.max(
        0,
        maxAdditionalWeight
          - Math.max(0, cashHeadroom - portfolioRisk.policyThresholds.lowCashWarningPercent),
      );

  return {
    additionalLeverageAllowed: false,
    decision: entryAllowed ? "cash_only" : awaitingModelReview ? "model_review_required" : "disabled",
    maxAdditionalBorrowedWeightPercent: 0,
    potentialMaxAdditionalBorrowedWeightPercent: finiteRound(
      potentialMaxAdditionalBorrowed,
      2,
    ),
    maxLeverageMultiple: portfolioRisk.policyThresholds.maxLeverageMultiple,
    recommendedGrossExposureCeilingPercent: portfolioRisk.policyThresholds.grossHardMaxPercent,
    reviewGrossExposureThresholdPercent: portfolioRisk.policyThresholds.grossWarningPercent,
    marginEligible,
    buyPowerValueBase: portfolioRisk.buyPower,
    buyPowerWeightPercent: portfolioRisk.buyPowerWeightPercent,
    currentGrossExposurePercent: finiteRound(currentGross, 2),
    projectedGrossAtInitialPercent: finiteRound(projectedInitialGross, 2),
    projectedGrossAtMaxPercent: finiteRound(projectedMaxGross, 2),
    brokerBuyPowerExcluded: false,
    disabledReasons: [...new Set(reasons)],
    reconsiderationRequirements: [
      "由叙事 Skill 独立确认 Stage 2/3 与最大主题暴露",
      "以最新账户快照确认现金、保证金和毛净暴露仍在阈值内",
      "明确定义失效位、跳空压力情景与最大可承受组合损失",
    ],
  };
}

function candidatePortfolioConstraints(portfolioRisk) {
  return {
    health: portfolioRisk.health,
    positionCount: portfolioRisk.positionCount,
    optionCount: portfolioRisk.optionCount,
    derivativeExposureComplete: portfolioRisk.derivativeExposureComplete,
    derivativeExposureLimitation: portfolioRisk.derivativeExposureLimitation,
    grossExposurePercent: portfolioRisk.grossExposurePercent,
    netExposurePercent: portfolioRisk.netExposurePercent,
    buyPowerValueBase: portfolioRisk.buyPower,
    buyPowerWeightPercent: portfolioRisk.buyPowerWeightPercent,
    top1WeightPercent: portfolioRisk.top1Weight,
    top5WeightPercent: portfolioRisk.top5Weight,
    cashRatioPercent: portfolioRisk.cashRatio,
    maintenanceMarginRatioPercent: portfolioRisk.maintenanceMarginRatioPercent,
    initMarginRatioPercent: portfolioRisk.initMarginRatioPercent,
    marginCall: portfolioRisk.marginCall,
    groupExposure: portfolioRisk.groupExposure,
    groupNetExposure: portfolioRisk.groupNetExposure,
    currencyExposure: portfolioRisk.currencyExposure,
    alerts: portfolioRisk.alerts,
    policyThresholds: portfolioRisk.policyThresholds,
    dataBoundary: "仅包含组合聚合风险证据；不包含账户号、凭证、Token，也不逐只请求持仓 K 线。期权只有在 Delta/标的名义敞口已纳入风险汇总时才允许候选 sizing。",
  };
}

function candidateMarketEvidenceReady(technical) {
  const candleCount = finiteOrNull(technical?.calculationBarCount);
  const lastPrice = finiteOrNull(technical?.lastPrice);
  const asOfMs = Date.parse(String(technical?.asOf ?? ""));
  const coverageReady = technical?.marketData
    ? technical.marketData.freshForDecision === true
    : true;
  return coverageReady
    && technical?.capabilities?.officialBar === true
    && technical?.lastBar?.status === "CLOSED"
    && technical?.timeframe === "1D"
    && candleCount >= 20
    && lastPrice > 0
    && Number.isFinite(asOfMs);
}

function derivativeExposureCoverage(portfolio) {
  const optionPositions = (portfolio.positions ?? []).filter(
    (item) => item.instrumentType === "option",
  );
  if (!optionPositions.length) {
    return { complete: true, limitation: null };
  }

  const explicitlyIncluded = portfolio.dataQuality?.derivativeExposureComplete === true
    && portfolio.dataQuality?.derivativeExposureIncludedInRiskTotals === true;
  const everyOptionQuantified = optionPositions.every((position) => {
    const delta = finiteOrNull(position.delta ?? position.optionDelta ?? position.greeks?.delta);
    const deltaNotional = finiteOrNull(
      position.deltaAdjustedNotionalBase
        ?? position.deltaNotionalBase
        ?? position.optionDeltaNotionalBase,
    );
    return delta != null && Math.abs(delta) <= 1 && deltaNotional != null;
  });
  const complete = explicitlyIncluded && everyOptionQuantified;
  return {
    complete,
    limitation: complete
      ? null
      : "组合含期权，但 Delta/标的名义敞口未完整量化并纳入组合风险；权利金市值不能替代衍生品风险敞口。",
  };
}

function isKnownCandidateGroup(group) {
  const value = String(group ?? "").trim();
  return Boolean(value) && !["候选标的", "未分类", "unknown"].includes(value.toLowerCase());
}

function positiveHeadroom(ceiling, current) {
  if (!Number.isFinite(ceiling) || !Number.isFinite(current)) return null;
  return Math.max(0, ceiling - current);
}

function roundedObject(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    item == null ? null : round(item, 2),
  ]));
}

export function calculatePortfolioRisk(portfolio, riskBudgetPercent = 0.8) {
  assertPortfolio(portfolio);
  const positions = portfolio.positions;
  const derivativeExposure = derivativeExposureCoverage(portfolio);
  const netAssets = finiteOrNull(portfolio.account?.netAssets);
  const buyPower = finiteOrNull(portfolio.account?.buyPower);
  const valuationComplete = portfolio.dataQuality?.valuationComplete !== false;
  const brokerNumericsIncomplete = Boolean(portfolio.brokerScope)
    && (netAssets == null || portfolio.totals?.unpricedPositionCount > 0);
  const grossExposurePercent = brokerNumericsIncomplete ? null : netAssets > 0
    && Number.isFinite(portfolio.totals?.positionsGrossMarketValueBase)
    ? (portfolio.totals.positionsGrossMarketValueBase / netAssets) * 100
    : sumFinite(positions.map((item) => item.weight));
  const netExposurePercent = brokerNumericsIncomplete ? null : netAssets > 0
    && Number.isFinite(portfolio.totals?.positionsNetMarketValueBase)
    ? (portfolio.totals.positionsNetMarketValueBase / netAssets) * 100
    : sumFinite(positions.map((item) => item.netWeight));
  const groupExposure = sortedExposure(
    portfolio.groupExposure,
    positions,
    "group",
    "weight",
  );
  const groupNetExposure = sortedExposure(
    portfolio.groupNetExposure,
    positions,
    "group",
    "netWeight",
  );
  const currencyExposure = sortedExposure(null, positions, "currency", "weight");
  const cashByCurrency = (portfolio.account?.cashInfos ?? []).map((cash) => ({
    currency: cash.currency ?? null,
    availableCash: finiteOrNull(cash.availableCash ?? cash.available_cash),
    withdrawCash: finiteOrNull(cash.withdrawCash ?? cash.withdraw_cash),
    frozenCash: finiteOrNull(cash.frozenCash ?? cash.frozen_cash),
    settlingCash: finiteOrNull(cash.settlingCash ?? cash.settling_cash),
  }));
  const sortedPositions = [...positions].sort(
    (a, b) => (finiteOrNull(b.weight) ?? -Infinity) - (finiteOrNull(a.weight) ?? -Infinity),
  );
  const top1Weight = finiteOrNull(portfolio.totals?.top1Weight)
    ?? finiteOrNull(sortedPositions[0]?.weight);
  const top5Weight = brokerNumericsIncomplete ? null : finiteOrNull(portfolio.totals?.top5Weight)
    ?? sumFinite(sortedPositions.slice(0, 5).map((item) => item.weight));
  const cashRatio = finiteOrNull(portfolio.totals?.cashRatio);
  const maintenanceMarginRatio = netAssets > 0
    && Number.isFinite(portfolio.account?.maintenanceMargin)
    ? (portfolio.account.maintenanceMargin / netAssets) * 100
    : null;
  const initMarginRatio = netAssets > 0
    && Number.isFinite(portfolio.account?.initMargin)
    ? (portfolio.account.initMargin / netAssets) * 100
    : null;
  const alerts = [];
  const addAlert = (condition, alert) => {
    if (condition) alerts.push(alert);
  };
  const marginCall = portfolio.account?.marginCall;
  const hasMarginCall = Number.isFinite(Number(marginCall))
    ? Number(marginCall) > 0
    : Boolean(marginCall);
  addAlert(hasMarginCall, riskAlert("margin_call", "critical", "账户存在追加保证金要求", marginCall, 0));
  addAlert(!valuationComplete, riskAlert(
    "valuation_incomplete",
    "warning",
    "组合存在未定价或时间戳不完整的持仓",
    portfolio.totals?.unpricedPositionCount ?? null,
    0,
  ));
  addThresholdAlert(
    alerts,
    "top1_concentration",
    "单一持仓集中度",
    top1Weight,
    PORTFOLIO_RISK_POLICY.top1WarningPercent,
    PORTFOLIO_RISK_POLICY.top1CriticalPercent,
  );
  addThresholdAlert(
    alerts,
    "top5_concentration",
    "Top5 集中度",
    top5Weight,
    PORTFOLIO_RISK_POLICY.top5WarningPercent,
    PORTFOLIO_RISK_POLICY.top5CriticalPercent,
  );
  addThresholdAlert(
    alerts,
    "group_concentration",
    `最大主题 ${groupExposure[0]?.key ?? "—"} 集中度`,
    groupExposure[0]?.weight,
    PORTFOLIO_RISK_POLICY.groupWarningPercent,
    PORTFOLIO_RISK_POLICY.groupCriticalPercent,
  );
  addThresholdAlert(
    alerts,
    "gross_exposure",
    "组合总暴露",
    grossExposurePercent,
    PORTFOLIO_RISK_POLICY.grossWarningPercent,
    PORTFOLIO_RISK_POLICY.grossHardMaxPercent,
  );
  addAlert(
    cashRatio != null && cashRatio < 0,
    riskAlert("negative_cash", "warning", "现金比例为负，组合正在使用融资", cashRatio, 0),
  );
  addAlert(
    cashRatio != null && cashRatio >= 0 && cashRatio < PORTFOLIO_RISK_POLICY.lowCashWarningPercent,
    riskAlert("low_cash", "warning", "现金缓冲低于 5%", cashRatio, 5),
  );
  addAlert(
    !derivativeExposure.complete,
    riskAlert(
      "derivative_exposure_unavailable",
      "warning",
      "期权 Delta/标的名义敞口未完整纳入组合风险",
      positions.filter((item) => item.instrumentType === "option").length,
      0,
    ),
  );
  const hasCritical = alerts.some((item) => item.severity === "critical");
  const hasWarning = alerts.some((item) => item.severity === "warning");
  const supported = positions.length > 0 && netAssets > 0;
  const health = !supported
    ? "unavailable"
    : hasCritical
      ? "critical"
      : !valuationComplete
        ? "partial"
        : hasWarning
          ? "review"
          : "balanced";

  const normalizedRiskBudgetPercent = finiteOrNull(riskBudgetPercent);
  return {
    scope: "portfolio",
    supported,
    portfolioValuationComplete: valuationComplete,
    health,
    limitation: supported
      ? valuationComplete
        ? null
        : "组合估值不完整；集中度按已定价持仓计算，不能视为完整风险。"
      : "缺少持仓或可靠净资产，不能完成组合健康评估。",
    baseCurrency: portfolio.account?.baseCurrency ?? "USD",
    netAssets: netAssets == null ? null : round(netAssets, 2),
    buyPower: buyPower == null ? null : round(buyPower, 2),
    buyPowerWeightPercent: buyPower != null && buyPower >= 0 && netAssets > 0
      ? round((buyPower / netAssets) * 100, 2)
      : null,
    riskBudgetPercent: normalizedRiskBudgetPercent == null
      ? null
      : round(normalizedRiskBudgetPercent, 2),
    positionCount: positions.length,
    equityCount: positions.filter((item) => item.instrumentType !== "option").length,
    optionCount: positions.filter((item) => item.instrumentType === "option").length,
    derivativeExposureComplete: derivativeExposure.complete,
    derivativeExposureLimitation: derivativeExposure.limitation,
    longCount: positions.filter((item) => item.direction === "long").length,
    shortCount: positions.filter((item) => item.direction === "short").length,
    pricedPositionCount: portfolio.totals?.pricedPositionCount
      ?? positions.filter((item) => item.valuationStatus === "priced").length,
    unpricedPositionCount: portfolio.totals?.unpricedPositionCount
      ?? positions.filter((item) => item.valuationStatus !== "priced").length,
    grossExposurePercent: finiteRound(grossExposurePercent, 2),
    netExposurePercent: finiteRound(netExposurePercent, 2),
    top1Weight: finiteRound(top1Weight, 2),
    top5Weight: finiteRound(top5Weight, 2),
    cashRatio: finiteRound(cashRatio, 2),
    maintenanceMarginRatioPercent: finiteRound(maintenanceMarginRatio, 2),
    initMarginRatioPercent: finiteRound(initMarginRatio, 2),
    marginCall: marginCall ?? null,
    groupExposure,
    groupNetExposure,
    currencyExposure,
    cashByCurrency,
    currencyExposureNote: "币种暴露按已定价持仓的组合毛权重汇总；各币种现金保留原币金额单列，不把未知汇率强行换算。",
    largestPositions: sortedPositions.slice(0, 10).map(contextPosition),
    alerts,
    policyThresholds: { ...PORTFOLIO_RISK_POLICY },
  };
}

export function buildScopedAnalysisContext({
  scope,
  portfolio,
  target,
  technical,
  risk,
  candles = [],
  technicalRadar = null,
}) {
  const normalizedScope = normalizeAnalysisScope(scope);
  const summary = {
    snapshotAt: portfolio.syncedAt ?? null,
    snapshotState: portfolio.freshness?.state ?? portfolio.status ?? "unknown",
    snapshotAgeMs: finiteOrNull(portfolio.freshness?.ageMs),
    snapshotExpiresAt: portfolio.freshness?.expiresAt ?? null,
    snapshotFreshForSizing: portfolio.freshness?.freshForSizing === true,
    quoteMarksOldestAt: portfolio.quoteAsOf ?? null,
    quoteMarksLatestAt: portfolio.quoteLatestAsOf ?? portfolio.quoteAsOf ?? null,
    valuationSchemaVersion: portfolio.valuationSchemaVersion ?? null,
    sourceStatus: portfolio.status ?? "unknown",
    baseCurrency: portfolio.account?.baseCurrency ?? "USD",
    netAssets: finiteOrNull(portfolio.account?.netAssets),
    buyPower: finiteOrNull(portfolio.account?.buyPower),
    cashRatioPercent: finiteOrNull(portfolio.totals?.cashRatio),
    top1WeightPercent: finiteOrNull(portfolio.totals?.top1Weight),
    top5WeightPercent: finiteOrNull(portfolio.totals?.top5Weight),
    valuationComplete: portfolio.dataQuality?.valuationComplete !== false,
    valuationGate: compactPortfolioValuationGate(portfolio.valuationGate),
    fxStatus: portfolio.dataQuality?.fxStatus ?? "unknown",
    largestGroups: sortedExposure(
      portfolio.groupExposure,
      portfolio.positions ?? [],
      "group",
      "weight",
    ).slice(0, 8),
  };
  const context = {
    scope: normalizedScope,
    portfolioSummary: summary,
    target: target ? contextTarget(target) : null,
    technical: normalizedScope === "portfolio"
      ? null
      : {
          asOf: technical.asOf ?? null,
          asOfTradingDate: technical.asOfTradingDate ?? null,
          lastPrice: finiteOrNull(technical.lastPrice),
          timeframe: technical.timeframe ?? "1D",
          adjustType: technical.adjustType ?? null,
          tradeSession: technical.tradeSession ?? null,
          calculationBarCount: finiteOrNull(technical.calculationBarCount),
          lastBar: technical.lastBar ?? null,
          provisional: technical.provisional ?? null,
          emaMethod: technical.emaMethod ?? null,
          emaMaturity: technical.emaMaturity ?? null,
          shortStructure: technical.shortStructure ?? null,
          longStructure: technical.longStructure ?? null,
          ema: technical.ema ?? {},
          emaSlope5d: technical.emaSlope5d ?? {},
          fib: technical.fib ?? null,
          dailySequence: technical.dailySequence ?? null,
          benchmarkRelativeStrength: technical.benchmarkRelativeStrength ?? null,
          technicalV2: technical.technicalV2 ?? null,
          tierB: technical.tierB ?? null,
          marketData: technical.marketData ?? null,
          capabilityMatrix: technical.capabilityMatrix ?? null,
          priceBars: compactPriceBars(candles),
        },
    risk,
    numericEvidence: safeCoreNumericEvidence({
      portfolio,
      target,
      technical,
      risk,
    }),
  };
  if (normalizedScope === "portfolio") {
    context.technicalRadar = technicalRadar?.available != null
      ? technicalRadar
      : compactTechnicalRadarForAgent(technicalRadar, portfolio);
    context.positions = (portfolio.positions ?? []).map(contextPosition);
    context.groupExposure = risk.groupExposure ?? summary.largestGroups;
    context.groupNetExposure = risk.groupNetExposure ?? [];
    context.currencyExposure = risk.currencyExposure ?? [];
    context.cashByCurrency = risk.cashByCurrency ?? [];
  }
  return context;
}

function compactTechnicalRadarForAgent(value, portfolio) {
  const source = value?.latestBatch ?? value?.batch ?? value;
  if (!source || typeof source !== "object" || !Array.isArray(source.items)) {
    return {
      available: false,
      status: "unavailable",
      tradingDate: null,
      recordedAt: null,
      inputHash: null,
      coverage: null,
      rankings: null,
      cards: [],
      limitation: "没有持久化的 Tier-A 技术雷达批次。",
    };
  }
  const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];
  const excludedHoldings = positions.filter((item) => item.instrumentType === "option"
    || finiteOrNull(item.quantity) == null || finiteOrNull(item.quantity) === 0)
    .map((item) => ({ symbol: item.symbol ?? null, reason: item.instrumentType === "option"
      ? "option_not_covered_by_equity_radar" : "quantity_unavailable_or_zero" }));
  const requestedSymbols = [...new Set(positions.filter((item) => item.instrumentType !== "option"
    && finiteOrNull(item.quantity) != null && finiteOrNull(item.quantity) !== 0)
    .map((item) => String(item.symbol ?? "").trim().toUpperCase()).filter(Boolean))].sort();
  const requestedSet = new Set(requestedSymbols);
  const items = source.items.filter((item) => requestedSet.has(item.symbol));
  const matchedSymbols = [...new Set(items.map((item) => item.symbol))].sort();
  const missingSymbols = requestedSymbols.filter((symbol) => !matchedSymbols.includes(symbol));
  const sourceHoldingSymbols = Array.isArray(source.summary?.universe?.holdingSymbols)
    ? [...source.summary.universe.holdingSymbols].sort()
    : [...new Set(source.items.filter((item) => item.memberships?.includes("holding")).map((item) => item.symbol))].sort();
  const accounts = Array.isArray(portfolio?.brokerAccounts) ? portfolio.brokerAccounts : [];
  const targetScopeId = portfolio?.accountScopeIdentity?.scopeId
    ?? (accounts.length === 1 ? accounts[0]?.scopeId : null);
  const sameAccountScope = Boolean(targetScopeId && source.accountScopeId === targetScopeId
    && portfolio?.brokerScope !== "ibkr" && !accounts.some((account) => account.broker !== "longbridge"));
  const expectedTradingDate = expectedLastCompletedTradingDate({ market: "US" });
  const currentTradingDate = Boolean(expectedTradingDate && source.tradingDate === expectedTradingDate);
  const holdingsChanged = JSON.stringify(sourceHoldingSymbols) !== JSON.stringify(requestedSymbols);
  const reasons = [
    ...(!source.batchId || !source.accountScopeId ? ["radar_batch_identity_missing"] : []),
    ...(!sameAccountScope ? ["radar_account_scope_not_matched"] : []),
    ...(holdingsChanged ? ["radar_holdings_universe_changed"] : []),
    ...(!currentTradingDate ? ["radar_not_latest_completed_session"] : []),
    ...(missingSymbols.length ? ["current_holdings_missing_radar_cards"] : []),
    ...(excludedHoldings.length ? ["positions_outside_equity_radar_scope"] : []),
  ];
  const complete = reasons.length === 0 && items.length > 0
    && source.summary?.status === "complete" && items.every((item) => item.status === "complete");
  return {
    available: items.length > 0,
    status: complete ? "complete" : items.length ? "partial" : "unavailable",
    batchId: source.batchId ?? null,
    accountScopeId: source.accountScopeId ?? null,
    recordHash: source.recordHash ?? null,
    sourceStatus: source.summary?.status ?? "unknown",
    sourceCoverage: source.summary?.coverage ?? null,
    portfolioBinding: {
      brokerScope: portfolio?.brokerScope ?? "longbridge",
      accountScopeId: targetScopeId ?? null,
      snapshotAt: portfolio?.syncedAt ?? null,
      sameAccountScope,
      holdingsChanged,
      usage: sameAccountScope ? "selected_portfolio_projection" : "matching_symbols_market_reference_only",
    },
    freshness: { expectedTradingDate, currentTradingDate, basis: "latest_completed_us_session" },
    tradingDate: source.tradingDate ?? null,
    computedAt: source.computedAt ?? null,
    recordedAt: source.recordedAt ?? null,
    inputHash: source.inputHash ?? null,
    scannerVersion: source.scannerVersion ?? null,
    coverage: { requestedSymbols, requestedSymbolCount: requestedSymbols.length,
      matchedSymbols, matchedSymbolCount: matchedSymbols.length, missingSymbols,
      excludedHoldings, sourceHoldingSymbols, omittedSourceCardCount: source.items.length - items.length,
      reasons },
    // Full-batch rankings and comparisons belong to the original universe;
    // they must not silently become rankings of a different portfolio.
    rankings: complete && source.items.length === items.length ? source.summary?.rankings ?? null : null,
    comparison: complete && source.items.length === items.length ? source.summary?.comparison ?? null : null,
    capabilityMatrix: source.summary?.capabilityMatrix ?? null,
    cards: items.map((item) => ({
      symbol: item.symbol ?? null,
      memberships: ["holding"],
      sourceMemberships: Array.isArray(item.memberships) ? item.memberships : [],
      status: item.status ?? "unknown",
      cutoff: item.cutoff ?? source.tradingDate ?? null,
      inputHash: item.inputHash ?? null,
      lastClose: item.lastClose ?? null,
      ema: item.ema ?? null,
      structure: item.structure ?? null,
      metrics: item.metrics ?? null,
      weekly: item.weekly ?? null,
      costProfile14d28d: item.costProfile14d28d ?? null,
      benchmark: item.benchmark ?? null,
      sector: item.sector ?? null,
      observableState: item.observableState ?? null,
      comparison: item.comparison ?? null,
      degradedReasons: Array.isArray(item.degradedReasons) ? item.degradedReasons : [],
    })),
    limitations: [...(Array.isArray(source.limitations) ? source.limitations : []), ...reasons],
    limitation: items.length ? null : "现有技术雷达没有匹配当前组合的股票持仓；不以其他账户或旧持仓的覆盖率代替。",
    advisory: true,
    decisionAuthority: "LLM",
  };
}

function compactPortfolioValuationGate(gate) {
  if (!gate || typeof gate !== "object") {
    return {
      status: "missing",
      readyForSizing: false,
      reasonCodes: ["valuation_gate_missing"],
      positions: [],
    };
  }
  return {
    schemaVersion: gate.schemaVersion ?? null,
    methodVersion: gate.methodVersion ?? null,
    assessedAt: gate.assessedAt ?? null,
    inputHash: gate.inputHash ?? null,
    hash: gate.hash ?? null,
    status: gate.outcome?.status ?? "unknown",
    readyForSizing: gate.outcome?.readyForSizing === true,
    reasonCodes: Array.isArray(gate.outcome?.reasonCodes)
      ? gate.outcome.reasonCodes.slice(0, 50)
      : [],
    positions: Array.isArray(gate.positions)
      ? gate.positions.slice(0, 500).map((item) => ({
        symbol: item.symbol ?? null,
        status: item.status ?? "unknown",
        readyForSizing: item.readyForSizing === true,
        quoteAt: item.quote?.timestamp ?? null,
        quoteState: item.quote?.state ?? "unknown",
        reasonCodes: Array.isArray(item.reasonCodes) ? item.reasonCodes.slice(0, 20) : [],
      }))
      : [],
  };
}

function safeCoreNumericEvidence(input) {
  try {
    return buildCoreNumericEvidence(input);
  } catch (error) {
    return {
      packageVersion: "core-numeric-evidence/v1",
      schemaVersion: "numeric-evidence/v1",
      status: "unavailable",
      facts: [],
      factCount: 0,
      knownCount: 0,
      error: String(error?.message ?? error).slice(0, 500),
    };
  }
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    const error = new Error("Agent 分析已取消；没有后台任务继续运行。");
    error.name = "AbortError";
    throw error;
  }
}

function notifyStage(onStage, phase, message) {
  try {
    onStage({ phase, message });
  } catch {
    // Status reporting must never stop the analysis itself.
  }
}

export function calculatePositionRisk(portfolio, position, technical, riskBudgetPercent) {
  const weight = Number.isFinite(position.weight) ? position.weight : null;
  const groupWeight = Number.isFinite(portfolio.groupExposure[position.group])
    ? portfolio.groupExposure[position.group]
    : null;
  const supported =
    position.instrumentType !== "option"
    && Number.isFinite(position.lastPrice)
    && Number.isFinite(weight);
  const portfolioValuationComplete = portfolio.dataQuality?.valuationComplete !== false;
  const snapshotFresh = portfolio.freshness?.freshForSizing === true;
  const positionValuationGate = portfolio.valuationGate?.positions?.find(
    (item) => item?.symbol === position.symbol,
  ) ?? null;
  const selectedQuoteReadyForSizing = positionValuationGate?.readyForSizing === true;
  const sizingSupported = supported
    && portfolioValuationComplete
    && snapshotFresh
    && selectedQuoteReadyForSizing;
  const downsideReference = supported
    ? selectDownsideReference(position.lastPrice, technical)
    : null;
  const reference = downsideReference?.level ?? null;
  const moveToReference = reference != null
    ? ((reference - position.lastPrice) / position.lastPrice) * 100
    : null;
  const impactAtReference = moveToReference == null || weight == null
    ? null
    : (weight * moveToReference) / 100;
  const normalizedRiskBudgetPercent = finiteOrNull(riskBudgetPercent);
  const maxPositionMove = weight && normalizedRiskBudgetPercent != null
    ? (normalizedRiskBudgetPercent / weight) * 100
    : null;

  return {
    supported,
    sizingSupported,
    snapshotFreshForSizing: snapshotFresh,
    selectedQuoteReadyForSizing,
    valuationGateReasonCodes: Array.isArray(positionValuationGate?.reasonCodes)
      ? [...positionValuationGate.reasonCodes]
      : ["position_valuation_gate_missing"],
    portfolioValuationComplete,
    instrumentType: position.instrumentType ?? "equity",
    limitation: supported
      ? portfolioValuationComplete
        ? null
        : "组合中存在未定价持仓；单标的权重可用，但 Top/主题集中度并不完整。"
      : position.instrumentType === "option"
        ? "期权风险需要合约乘数、方向、标的映射与 Greeks；本版本不套用正股线性估算。"
        : position.valuationLimitation || "当前持仓缺少可靠现价，不能计算线性风险。",
    positionWeight: weight == null ? null : round(weight, 2),
    group: position.group,
    groupWeight: groupWeight == null ? null : round(groupWeight, 2),
    pnlPercent: position.pnlPercent == null ? null : round(position.pnlPercent, 2),
    riskBudgetPercent: normalizedRiskBudgetPercent == null
      ? null
      : round(normalizedRiskBudgetPercent, 2),
    referenceLevel: reference,
    referenceLabel: downsideReference?.label ?? "无可靠下行参考",
    moveToReferencePercent: moveToReference == null ? null : round(moveToReference, 2),
    portfolioImpactAtReferencePercent:
      impactAtReference == null ? null : round(impactAtReference, 2),
    maxPositionMoveForBudgetPercent:
      maxPositionMove == null ? null : round(maxPositionMove, 2),
    top1Weight: portfolio.totals.top1Weight == null ? null : round(portfolio.totals.top1Weight, 2),
    top5Weight: portfolio.totals.top5Weight == null ? null : round(portfolio.totals.top5Weight, 2),
    cashRatio: portfolio.totals.cashRatio == null ? null : round(portfolio.totals.cashRatio, 2),
    marginCall: portfolio.account.marginCall,
  };
}

export function buildConditionalPlan(position, technical, risk) {
  if (!risk.supported) {
    return {
      state: "unsupported",
      available: false,
      reason: risk.limitation,
      watcherEnabled: false,
      scenarios: [],
    };
  }
  if (!risk.portfolioValuationComplete) {
    return {
      state: "valuation_incomplete",
      available: false,
      reason: "组合估值不完整；EMA/Fib 技术观察仍可用，但不能生成带风险预算的交易计划。",
      watcherEnabled: false,
      scenarios: [],
    };
  }
  if (risk.sizingSupported === false) {
    return {
      state: "valuation_gate_blocked",
      available: false,
      reason: "账户同步时间、该标的报价时间或组合估值勾稽未同时通过；保留技术观察，但不生成带仓位含义的计划。",
      watcherEnabled: false,
      scenarios: [],
    };
  }
  if (!technical.ema?.[21]) {
    return {
      state: "dormant",
      available: false,
      reason: "K 线不足，不能生成可靠的技术条件计划。",
      watcherEnabled: false,
      scenarios: [],
    };
  }

  const ema = technical.ema;
  const lastPrice = technical.lastPrice ?? position.lastPrice;
  const overhead = [8, 13, 21]
    .map((period) => ({ label: `EMA${period}`, level: ema[period] }))
    .filter((item) => Number.isFinite(item.level) && item.level > lastPrice)
    .sort((a, b) => a.level - b.level)[0];
  const bullSupport = [8, 13, 21]
    .map((period) => ({ label: `EMA${period}`, level: ema[period] }))
    .filter((item) => Number.isFinite(item.level) && item.level < lastPrice)
    .sort((a, b) => b.level - a.level)[0];
  const baseLow = Math.min(ema[13] ?? ema[21], ema[21]);
  const baseHigh = Math.max(ema[13] ?? ema[21], ema[21]);
  const bullCondition = overhead
    ? `日线收盘重新站上 ${overhead.label} ${formatNumber(overhead.level)}，且 EMA3/5 斜率同步转正`
    : `回踩 ${bullSupport?.label ?? "EMA8"} ${formatNumber(bullSupport?.level ?? ema[8])} 附近不破，且 EMA3/5 保持正斜率`;
  const bullInvalidation = bullSupport
    ? `日线重新跌破 ${bullSupport.label} ${formatNumber(bullSupport.level)}`
    : overhead
      ? `日线重新跌破 ${overhead.label} ${formatNumber(overhead.level)}`
      : `日线跌破 EMA13 ${formatNumber(ema[13])}`;
  const bearCondition = risk.referenceLevel != null
    ? `日线有效跌破 ${risk.referenceLabel} ${formatNumber(risk.referenceLevel)}`
    : "日线刷新前 20 日低点，且下一交易日仍不能收回";
  const bearInvalidation = risk.referenceLevel != null
    ? `日线重新收复 ${risk.referenceLabel} ${formatNumber(risk.referenceLevel)}`
    : "日线收回破位前的 20 日低点";
  return {
    state: "static_snapshot",
    available: true,
    watcherEnabled: false,
    evaluatedAt: technical.asOf,
    scenarios: [
      {
        name: "牛",
        tone: "bull",
        if: bullCondition,
        then: `仅生成“允许评估”信号；新增风险不得超过组合 ${risk.riskBudgetPercent}%；Fib 是否采用由 Codex 结合共振证据判断`,
        invalidation: bullInvalidation,
        impact: "执行前用最新长桥快照重新计算，不自动下单",
        status: "snapshot_only",
        predicate: overhead
          ? { field: "daily_close", operator: "crosses_above", level: overhead.level, confirmation: "ema3_and_ema5_slope_positive" }
          : { field: "daily_low", operator: "holds_above", level: bullSupport?.level ?? ema[8], confirmation: "ema3_and_ema5_slope_positive" },
      },
      {
        name: "基准",
        tone: "base",
        if: `价格在 ${formatNumber(baseLow)}–${formatNumber(baseHigh)} 附近震荡，快线仍交错`,
        then: "维持现有仓位，冻结区间中部加仓",
        invalidation: "连续两个日线收盘脱离该区间",
        impact: `当前仓位权重 ${formatPercent(risk.positionWeight)}`,
        status: "snapshot_only",
        predicate: { field: "daily_close", operator: "inside", low: baseLow, high: baseHigh },
      },
      {
        name: "熊",
        tone: "bear",
        if: bearCondition,
        then: "只生成减仓/保护评估提醒，由用户在长桥端确认；本地自动 Fib 不会单独触发动作",
        invalidation: bearInvalidation,
        impact:
          risk.portfolioImpactAtReferencePercent == null
            ? "组合影响无法可靠计算"
            : `到参考位的静态组合影响约 ${formatSignedPercent(risk.portfolioImpactAtReferencePercent)}`,
        status: "snapshot_only",
        predicate: risk.referenceLevel != null
          ? { field: "daily_close", operator: "crosses_below", level: risk.referenceLevel }
          : { field: "daily_close", operator: "new_20d_low" },
      },
    ],
  };
}

export function buildCandidatePlan(target, technical, risk) {
  if (!risk.technicalPlanReady) {
    return {
      state: "dormant",
      available: false,
      reason: risk.limitation ?? "日线证据未达到计划标准，不能生成可靠的候选买入条件。",
      watcherEnabled: false,
      scenarios: [],
    };
  }
  if (target.instrumentType === "option") {
    return {
      state: "unsupported",
      available: false,
      reason: risk.limitation,
      watcherEnabled: false,
      scenarios: [],
    };
  }
  if (!risk.supported) {
    return {
      state: "technical_only",
      available: true,
      reason: risk.limitation,
      watcherEnabled: false,
      evaluatedAt: technical.asOf,
      riskSizingAvailable: false,
      sizing: null,
      leverage: risk.leverage,
      scenarios: [],
    };
  }

  const entryTrigger = "等待 Codex 综合价格/成交量、相对强弱、成本或筹码结构、波动与事件反应，选择可验证的入场触发";
  const invalidation = risk.referenceLevel != null
    ? `日线有效跌破 ${risk.referenceLabel} ${formatNumber(risk.referenceLevel)}`
    : "等待 Codex 基于技术/叙事证据选择失效依据；本地自动 Fib 不会单独充当止损位";

  const sizing = {
    stageAssumption: risk.stageAssumption,
    initialAdditionalWeightPercent: risk.recommendedInitialAdditionalWeightPercent,
    initialTotalWeightPercent: risk.recommendedInitialTotalWeightPercent,
    initialNotionalBase: risk.recommendedInitialNotionalBase,
    maxAdditionalWeightPercent: risk.recommendedMaxAdditionalWeightPercent,
    maxTotalWeightPercent: risk.recommendedMaxWeightPercent,
    maxAdditionalNotionalBase: risk.recommendedMaxAdditionalNotionalBase,
    riskBudgetPercent: risk.riskBudgetPercent,
    leverageDecision: risk.leverage.decision,
    maxAdditionalBorrowedWeightPercent: risk.leverage.maxAdditionalBorrowedWeightPercent,
    hardMaxAdditionalWeightPercent: risk.hardMaxAdditionalWeightPercent,
    hardMaxTotalWeightPercent: risk.hardMaxTotalWeightPercent,
  };
  if (risk.awaitingModelReview) {
    return {
      state: "awaiting_codex_strategy",
      available: true,
      watcherEnabled: false,
      evaluatedAt: technical.asOf,
      riskSizingAvailable: false,
      sizing,
      leverage: risk.leverage,
      scenarios: [
        {
          name: "允许试探",
          tone: "bull",
          if: entryTrigger,
          then: `等待 Codex 结合叙事、开放技术证据与可用 MCP 给出建议仓位；本地硬安全总上限为 ${formatPercent(risk.hardMaxTotalWeightPercent)}`,
          invalidation,
          impact: "LLM 尚未选择失效位，暂不计算风险预算仓位",
          status: "awaiting_model",
        },
        {
          name: "等待",
          tone: "base",
          if: "价格、量能、相对强弱、筹码/成本与事件反应尚未形成一致方向",
          then: "保持观察名单状态；不因单一指标触发而追价",
          invalidation: "至少两个独立证据族形成可复核的同向变化",
          impact: "未持有时组合影响为 0；已有仓位则冻结新增风险",
          status: "snapshot_only",
        },
        {
          name: "取消计划",
          tone: "bear",
          if: invalidation,
          then: "取消本次买入计划；等待 Codex 在新证据下重新选择结构与失效条件",
          invalidation: "新的结构化计划取代本计划",
          impact: "不新增风险",
          status: "snapshot_only",
        },
      ],
    };
  }
  if (!risk.entryAllowed) {
    return {
      state: "candidate_blocked",
      available: true,
      watcherEnabled: false,
      evaluatedAt: technical.asOf,
      riskSizingAvailable: false,
      sizing,
      leverage: risk.leverage,
      scenarios: [
        {
          name: "暂停新增风险",
          tone: "bear",
          if: risk.entryBlockReasons.join("；"),
          then: "建议初始新增仓位 0%；先解除组合风险约束，再用最新快照重算",
          invalidation: "组合关键风险消除、估值完整，且风险预算重新出现仓位空间",
          impact: `当前总暴露 ${formatPercent(risk.portfolioConstraints.grossExposurePercent)} · 现金 ${formatPercent(risk.portfolioConstraints.cashRatioPercent)}`,
          status: "snapshot_only",
        },
        {
          name: "仅观察技术触发",
          tone: "base",
          if: entryTrigger,
          then: "记录触发，不建立仓位；候选技术走强不能覆盖组合层面的禁用条件",
          invalidation,
          impact: "新增组合影响保持 0",
          status: "snapshot_only",
        },
      ],
    };
  }

  return {
    state: "candidate_blocked",
    available: true,
    watcherEnabled: false,
    evaluatedAt: technical.asOf,
    riskSizingAvailable: false,
    sizing,
    leverage: risk.leverage,
    scenarios: [],
  };
}

export function buildPortfolioPlan(risk) {
  if (!risk.supported) {
    return {
      state: "unsupported",
      available: false,
      reason: risk.limitation,
      watcherEnabled: false,
      scenarios: [],
    };
  }
  const warningLabels = risk.alerts
    .filter((item) => item.severity !== "info")
    .map((item) => item.label)
    .join("、");
  return {
    state: "portfolio_snapshot",
    available: true,
    watcherEnabled: false,
    evaluatedAt: null,
    scenarios: [
      {
        name: "维持",
        tone: "bull",
        if: "无追加保证金，Top1≤20%、最大主题≤30%、总暴露≤120%，且估值完整",
        then: "维持组合框架；新增单笔风险仍受组合风险预算约束",
        invalidation: "任一集中度/杠杆阈值被突破",
        impact: `当前健康状态：${risk.health}`,
        status: "snapshot_only",
      },
      {
        name: "再平衡复核",
        tone: "base",
        if: warningLabels || "出现单一持仓、Top5、主题或总暴露预警",
        then: "先识别重复暴露与相关性，再决定减仓、对冲或暂停新增；不自动生成订单",
        invalidation: "风险指标回到预警阈值内，并以新快照确认",
        impact: `Top1 ${formatPercent(risk.top1Weight)} · Top5 ${formatPercent(risk.top5Weight)} · 总暴露 ${formatPercent(risk.grossExposurePercent)}`,
        status: "snapshot_only",
      },
      {
        name: "防守",
        tone: "bear",
        if: "存在追加保证金、组合毛暴露达到 150% 硬上限、估值缺口或关键行情不可用",
        then: "暂停新增风险，先恢复毛敞口、保证金与估值安全空间；所有操作由用户在长桥端确认",
        invalidation: "保证金与估值问题已消除，并重新同步完整快照",
        impact: risk.limitation ?? "优先保护组合可持续性",
        status: "snapshot_only",
      },
    ],
  };
}

export function selectDownsideReference(lastPrice, technical) {
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) return null;
  const candidates = [
    { label: "EMA21", level: technical.ema?.[21] },
    { label: "EMA144", level: technical.ema?.[144] },
    { label: "EMA169", level: technical.ema?.[169] },
    { label: "前20日低点", level: technical.range20?.priorLow },
  ];
  return candidates
    .filter(({ level }) => Number.isFinite(level) && level > 0 && level < lastPrice)
    .sort((a, b) => b.level - a.level)[0] ?? null;
}

function buildConclusion(position, technical, risk, task, intent) {
  if (!risk.supported) {
    return {
      headline: `${position.ticker}：仅显示真实仓位，风险估值已降级`,
      body: `${task}。当前权重 ${formatPercent(risk.positionWeight)}；${risk.limitation}`,
      posture: "映射正股与 Greeks 后再评估",
    };
  }
  if (!candidateMarketEvidenceReady(technical)) {
    return {
      headline: `${position.ticker} 仅完成仓位风险检查`,
      body: `长桥仓位权重 ${formatPercent(risk.positionWeight)}；由于正式日线不足或请求失败，不编造技术指标或交易触发。`,
      posture: "等待完整证据",
    };
  }

  const alignment =
    technical.shortStructure === "完整多头" && technical.longStructure === "长周期多头"
      ? "快慢周期同向多头"
      : technical.shortStructure === "完整空头" && technical.longStructure === "长周期多头"
        ? "长多短空，处于修正结构"
        : technical.shortStructure === "完整多头"
          ? "短周期多头，长周期尚未同向确认"
        : technical.shortStructure === "完整空头"
          ? "短周期卖压占优"
          : "快线交错，方向尚未确认";
  const posture = technical.shortStructure === "完整多头"
    ? "持有优先，回踩确认后再评估"
    : technical.shortStructure === "完整空头"
      ? "冻结加仓，反弹先按修复"
      : "降低行动频率，等待重新定序";

  const longCycleNote = technical.status === "partial"
    ? "；长线样本不足，EMA144/169 不参与结论"
    : "";
  if (intent === "risk_review") {
    return {
      headline: `${position.ticker}：组合仓位风险检查`,
      body: `当前权重 ${formatPercent(risk.positionWeight)}，${position.group} 合计 ${formatPercent(risk.groupWeight)}，到 ${risk.referenceLabel} 的静态组合影响为 ${formatSignedPercent(risk.portfolioImpactAtReferencePercent)}。${risk.limitation ?? ""}`,
      posture: "先校验集中度与风险预算，再决定技术动作",
    };
  }
  if (intent === "conditional_plan") {
    return {
      headline: `${position.ticker}：三情景条件计划已生成`,
      body: `计划基于本次长桥快照与 1D 结构；短线为“${technical.shortStructure}”，长线为“${technical.longStructure}”${longCycleNote}。`,
      posture: "静态计划快照，不监控、不下单",
    };
  }
  return {
    headline: `${position.ticker}：${alignment}`,
    body: `${task}。当前权重 ${formatPercent(risk.positionWeight)}，${position.group} 合计 ${formatPercent(risk.groupWeight)}；短线为“${technical.shortStructure}”，长线为“${technical.longStructure}”${longCycleNote}。${risk.limitation ?? ""}`,
    posture,
  };
}

function buildCandidateConclusion(target, technical, risk, task) {
  if (!risk.technicalPlanReady) {
    return {
      headline: `${target.ticker}：候选计划暂不可用`,
      body: `${task}。市场证据未达到计划标准，未编造技术指标、入场位或仓位上限。${risk.limitation ? ` ${risk.limitation}` : ""}`,
      posture: "保留观察，不建立仓位",
    };
  }
  const holdingNote = target.isHeld
    ? `当前已有 ${formatPercent(risk.existingPositionWeight)} 持仓，本计划只针对新增风险。`
    : "当前未持有，触发前组合暴露为 0。";
  const sizingNote = risk.awaitingModelReview
    ? `本地已验证账户与组合硬安全边界，最大总仓位不得超过 ${formatPercent(risk.hardMaxTotalWeightPercent)}；具体证据权重、失效位与建议仓位等待 Codex 判断。`
    : risk.supported
      ? `当前新增风险被安全边界阻止：${risk.entryBlockReasons.join("；")}。`
      : risk.limitation;
  return {
    headline: `${target.ticker}：候选买入计划 · ${technical.shortStructure}`,
    body: `${task}。${holdingNote}${sizingNote} 长线结构为“${technical.longStructure}”。`,
    posture: risk.awaitingModelReview
      ? "等待 Codex 策略复核"
      : "保留观察，先解除组合风险约束",
  };
}

function buildPortfolioConclusion(portfolio, risk, task) {
  const labels = {
    balanced: "组合结构在启发式阈值内",
    review: "组合存在集中度或现金预警",
    partial: "组合估值不完整",
    critical: "组合存在高优先级风险",
    unavailable: "组合健康暂不可评估",
  };
  const topGroup = risk.groupExposure?.[0];
  const alertText = risk.alerts?.length
    ? `需复核：${risk.alerts.map((item) => item.label).join("、")}。`
    : "未触发预设集中度、现金或总暴露阈值。";
  return {
    headline: `全部持仓：${labels[risk.health] ?? risk.health}`,
    body: `${task}。共 ${portfolio.positions.length} 项，Top1 ${formatPercent(risk.top1Weight)}，Top5 ${formatPercent(risk.top5Weight)}，总暴露 ${formatPercent(risk.grossExposurePercent)}${topGroup ? `，最大主题 ${topGroup.key} ${formatPercent(topGroup.weight)}` : ""}。${alertText}`,
    posture: risk.health === "critical"
      ? "暂停新增风险，先处理保证金、现金或过度集中"
      : risk.health === "partial"
        ? "先恢复完整估值，再做再平衡决定"
        : risk.health === "review"
          ? "先复核重复暴露，再决定是否新增仓位"
          : "保持纪律，以新交易的边际风险为主",
  };
}

export function classifyIntent(task) {
  const value = String(task ?? "").toLowerCase();
  const wantsPlan = /计划|情景|牛.{0,3}熊|trigger|scenario/.test(value);
  const wantsRisk = /风险|集中度|集中|暴露|仓位|预算|回撤/.test(value);
  const wantsTechnical = /技术|结构|时点|ema|fib|斐波那契|均线/.test(value);
  if (wantsPlan) return "conditional_plan";
  if (wantsRisk && !wantsTechnical) return "risk_review";
  if (wantsTechnical && !wantsRisk) return "technical_timing";
  return "full_review";
}

function sectionsForIntent(intent) {
  if (intent === "risk_review") return ["conclusion", "risk", "evidence"];
  if (intent === "technical_timing") return ["conclusion", "technical", "fib", "evidence"];
  return ["conclusion", "technical", "fib", "risk", "plan", "evidence"];
}

function buildPortfolioSourceEvidence(portfolio, { holdingsSummary }) {
  const snapshotFresh = portfolio.freshness?.freshForSizing === true;
  const snapshotSummary = portfolioSnapshotEvidenceSummary(portfolio);
  const fxEvidence = fxEvidenceMetadata(portfolio);
  const { status: fxStatus, evidenceStatus: fxEvidenceStatus, source: fxSource, summary: fxSummary } = fxEvidence;
  const brokerSource = brokerObservationLabels(portfolio);
  return [
    evidenceItem(
      brokerSource.account,
      brokerSource.accountTool,
      portfolio.syncedAt,
      1,
      portfolio.account?.netAssets != null && snapshotFresh ? "succeeded" : "degraded",
      `${snapshotSummary}；${fxStatus === "not_required" ? "USD 单币种账户，无跨币种限制" : "跨币种聚合受汇率证据状态约束"}`,
    ),
    evidenceItem(
      brokerSource.holdings,
      brokerSource.holdingsTool,
      portfolio.syncedAt,
      portfolio.positions.length,
      snapshotFresh && (portfolio.holdingsStatus === "live" || portfolio.status === "live")
        ? "succeeded"
        : "degraded",
      `${holdingsSummary} · ${snapshotSummary}`,
    ),
    evidenceItem(
      fxSource,
      fxEvidence.tool,
      fxEvidence.asOf,
      portfolio.fx?.currencyCount ?? 0,
      fxEvidenceStatus,
      fxSummary,
    ),
  ];
}

function brokerObservationLabels(portfolio, position = null) {
  const scope = ["ibkr", "all"].includes(portfolio?.brokerScope) ? portfolio.brokerScope : "longbridge";
  const quoteScope = position?.broker === "multiple" ? "all"
    : ["ibkr", "longbridge"].includes(position?.broker) ? position.broker : scope;
  // These local observation identifiers describe already-read snapshots.
  // They do not claim an IBKR API or an aggregate broker endpoint was called
  // by this evidence builder. Longbridge's existing provenance stays intact.
  return {
    account: scope === "longbridge" ? "长桥账户" : scope === "ibkr" ? "IBKR 账户观察" : "多券商账户汇总",
    accountTool: scope === "longbridge" ? "account_balance" : scope === "ibkr" ? "local:ibkr-account-snapshot" : "local:broker-account-aggregate",
    holdings: scope === "longbridge" ? "长桥真实持仓" : scope === "ibkr" ? "IBKR 真实持仓" : "多券商真实持仓",
    holdingsTool: scope === "longbridge" ? "stock_positions" : scope === "ibkr" ? "local:ibkr-position-snapshot" : "local:broker-position-aggregate",
    quote: quoteScope === "longbridge" ? "长桥行情" : quoteScope === "ibkr" ? "IBKR 账户估值观察" : "多券商估值汇总观察",
    quoteTool: quoteScope === "longbridge" ? position?.instrumentType === "option" ? "option_quote" : "quote"
      : quoteScope === "ibkr" ? "local:ibkr-portfolio-mark" : "local:broker-valuation-aggregate",
  };
}

function portfolioSnapshotEvidenceSummary(portfolio) {
  const state = String(
    portfolio?.freshness?.state
      ?? portfolio?.status
      ?? "unknown",
  ).toUpperCase();
  const markStart = portfolio?.quoteAsOf ?? null;
  const markEnd = portfolio?.quoteLatestAsOf ?? markStart;
  const markRange = markStart && markEnd
    ? markStart === markEnd
      ? `行情标记 ${markStart}`
      : `行情标记 ${markStart} → ${markEnd}`
    : "行情标记时间未知";
  if (portfolio?.freshness?.freshForSizing === true) {
    return `账户快照已同步（${state}）· ${markRange}`;
  }
  return `账户快照 ${state}，只供回看 · ${markRange}`;
}

function appendTechnicalEvidence(evidence, technical) {
  evidence.push(
    evidenceItem(
      "EMA 引擎",
      "local:ema",
      technical.asOf ?? null,
      technical.candleCount,
      technical.status === "complete"
        ? "succeeded"
        : technical.ema?.[21]
          ? "degraded"
          : "skipped",
      "EMA 3/5/8/13/21/144/169",
    ),
    evidenceItem(
      "Fib 引擎",
      "local:fibonacci",
      technical.asOf ?? null,
      technical.fib ? 4 : 0,
      technical.fib ? "succeeded" : "skipped",
      "0.382 / 0.618 / 1 / 1.618",
    ),
  );
}

async function attachTechnicalV2({
  technical,
  dailyCandles,
  symbol,
  task,
  loadCandles,
  loadMarketSeries,
  benchmarkLoad,
  dailyCoverage,
  technicalLinkage,
  anchoredVwap,
  optionEvidence,
  catalystEvidence,
  onStage,
  signal,
}) {
  throwIfCancelled(signal);
  let intraday60m = null;
  let hourlyLoad = null;
  let hourlyError = null;
  if (typeof loadMarketSeries === "function") {
    notifyStage(onStage, "intraday_60m", `正在读取 ${symbol} 60 分钟完结 K 线（失败只降级执行层）`);
    try {
      hourlyLoad = await loadMarketSeries(symbol, { period: "1h", count: 240 });
      throwIfCancelled(signal);
      const coverage = hourlyLoad?.coverage ?? null;
      const liveLineage = coverage?.source === "live"
        || (coverage?.source === "memory" && coverage?.originSource === "live");
      const decisionGrade = liveLineage
        && coverage?.partial !== true
        && hourlyLoad?.completedBarsOnly === true
        && Array.isArray(hourlyLoad?.completedBars)
        && hourlyLoad.completedBars.length > 0;
      if (decisionGrade) {
        intraday60m = {
          bars: hourlyLoad.completedBars,
          interval: "60m",
          completedBarsOnly: true,
          source: coverage.source,
          fetchedAt: coverage.fetchedAt,
          coverage: {
            ...coverage,
            finality: hourlyLoad.finality ?? null,
          },
        };
      } else {
        hourlyError = {
          code: "hourly_not_decision_grade",
          message: "60 分钟数据不是本轮实时完整来源，或没有可证明已完结的 K 线；执行层保持不可用。",
        };
      }
    } catch (error) {
      throwIfCancelled(signal);
      hourlyError = {
        code: String(error?.code ?? error?.kind ?? "hourly_load_failed").slice(0, 80),
        message: cleanError(error),
      };
    }
  }

  const dailyCompletedBars = completedCandlesThrough(
    dailyCandles,
    technical?.asOfTradingDate,
  );
  const technicalV2 = buildTechnicalV2({
    dailyTechnical: technical,
    dailyCompletedBars,
    intraday60m,
    horizon: inferTechnicalHorizon(task),
  });
  const benchmark = technical?.benchmarkRelativeStrength;
  if (benchmark) {
    const availableWindows = Object.values(benchmark.excessReturns?.windows ?? {})
      .filter((metric) => metric?.status === "available").length;
    const benchmarkStatus = benchmark.status === "complete"
      ? "complete"
      : ["partial", "research_only"].includes(benchmark.status)
        ? "warming"
        : "unavailable";
    const benchmarkCapability = {
      status: benchmarkStatus,
      minimumBars: 2,
      barCount: availableWindows,
      source: "same_date_target_vs_qqq_completed_daily",
      asOf: benchmark.asOfTradingDate ?? null,
      method: benchmark.excessReturns?.methodVersion ?? "daily-sequence-v1",
      reasonCodes: [
        ...(benchmark.reason ? [benchmark.reason] : []),
        ...(benchmarkStatus === "complete" ? [] : [`benchmark_${benchmark.status ?? "unavailable"}`]),
      ],
    };
    technicalV2.capabilityMatrix.benchmarkRelativeStrength = benchmarkCapability;
    technicalV2.limitations = [
      ...(technicalV2.limitations ?? []).filter((item) => item?.layer !== "benchmarkRelativeStrength"),
      ...(benchmarkStatus === "complete"
        ? []
        : [{
            layer: "benchmarkRelativeStrength",
            status: benchmarkStatus,
            reasonCodes: benchmarkCapability.reasonCodes,
          }]),
    ];
  }
  technicalV2.loads = {
    hourly60m: {
      attempted: typeof loadMarketSeries === "function",
      coverage: hourlyLoad?.coverage ?? null,
      finality: hourlyLoad?.finality ?? null,
      error: hourlyError,
    },
    weekly: {
      attempted: false,
      source: "derived_from_completed_daily",
      limitation: "周线由已完成日线聚合，并固定排除无法确认完结的末周。",
    },
  };

  const tierB = await buildSelectedSymbolTierBEvidence({
    symbol,
    task,
    technical,
    dailyCompletedBars,
    dailyCoverage,
    benchmarkLoad,
    intraday60m,
    loadCandles,
    technicalLinkage,
    anchoredVwap,
    optionEvidence,
    catalystEvidence,
    onStage,
    signal,
  });
  return {
    ...technical,
    technicalV2,
    tierB,
    capabilityMatrix: {
      ...technical?.capabilityMatrix,
      technicalV2: technicalV2.status,
      tierB: tierB?.status ?? "unavailable",
      weeklyStructure: technicalV2.capabilityMatrix.weeklyStructure.status,
      execution60m: technicalV2.capabilityMatrix.execution60m.status,
      costProfile14d28d: technicalV2.capabilityMatrix.costProfile14d28d.status,
      anchoredVwap: technicalV2.capabilityMatrix.anchoredVwap.status,
    },
  };
}

async function buildSelectedSymbolTierBEvidence({
  symbol,
  task,
  technical,
  dailyCompletedBars,
  dailyCoverage,
  benchmarkLoad,
  intraday60m,
  loadCandles,
  technicalLinkage,
  anchoredVwap,
  optionEvidence,
  catalystEvidence,
  onStage,
  signal,
}) {
  const cutoffTradingDate = String(technical?.asOfTradingDate ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffTradingDate) || !dailyCompletedBars.length) {
    return null;
  }
  throwIfCancelled(signal);
  const confirmedLinkage = normalizedConfirmedTechnicalLinkage(technicalLinkage, symbol);
  let related = { sector: null, peers: [], errors: [] };
  if (confirmedLinkage && typeof loadCandles === "function") {
    notifyStage(
      onStage,
      "market_linkage",
      `正在按你确认的联动表读取行业与同行（严格对齐 ${cutoffTradingDate}，缺日不前填）`,
    );
    related = await loadTierBRelatedDaily({
      linkage: confirmedLinkage,
      loadCandles,
      cutoffTradingDate,
      signal,
    });
  }
  throwIfCancelled(signal);

  const weeklyAggregation = aggregateCompletedDailyBarsToWeeks(dailyCompletedBars);
  const targetDaily = tierBDailyDescriptor(dailyCompletedBars, dailyCoverage);
  const benchmarkDailyBars = completedCandlesThrough(
    benchmarkLoad?.candles,
    cutoffTradingDate,
  );
  const benchmarkDaily = tierBDailyDescriptor(
    benchmarkDailyBars,
    benchmarkLoad?.coverage,
  );
  const weekly = weeklyAggregation.bars.length
    ? {
        bars: weeklyAggregation.bars,
        interval: "1W",
        completedBarsOnly: true,
        source: "derived_from_completed_daily",
        fetchedAt: dailyCoverage?.fetchedAt ?? null,
        coverage: {
          source: "derived_from_completed_daily",
          originSource: dailyCoverage?.originSource ?? dailyCoverage?.source ?? null,
          partial: dailyCoverage?.partial === true,
          partialReasons: Array.isArray(dailyCoverage?.partialReasons)
            ? dailyCoverage.partialReasons
            : [],
          derivation: weeklyAggregation.derivation,
        },
      }
    : null;

  try {
    const evidence = buildTierBTechnicalEvidence({
      symbol,
      currency: inferSymbolCurrency(symbol),
      cutoffTradingDate,
      knowledgeCutoffAt: `${cutoffTradingDate}T23:59:59.999Z`,
      horizon: inferTechnicalHorizon(task),
      daily: targetDaily,
      weekly,
      intraday60m,
      benchmark: {
        symbol: "QQQ.US",
        daily: benchmarkDaily,
      },
      sector: related.sector,
      peers: related.peers.length === 1 ? [] : related.peers,
      anchoredVwap,
      options: optionEvidence,
      catalysts: catalystEvidence,
    });
    return {
      ...evidence,
      linkage: confirmedLinkage
        ? {
            status: "confirmed",
            inputHash: confirmedLinkage.inputHash ?? null,
            symbol: confirmedLinkage.symbol,
            sectorSymbol: confirmedLinkage.sectorSymbol,
            peerSymbols: confirmedLinkage.peerSymbols,
            source: confirmedLinkage.source,
            confirmedAt: confirmedLinkage.confirmedAt,
          }
        : {
            status: "unavailable",
            reasonCodes: ["user_confirmed_sector_peer_mapping_not_provided"],
          },
      relatedLoadErrors: [
        ...related.errors,
        ...(related.peers.length === 1
          ? [{
              kind: "peer",
              code: "peer_group_requires_two_to_five_symbols",
              message: "同行比较至少需要 2 个已确认标的；单个同行未用于横向结论。",
            }]
          : []),
      ],
    };
  } catch (error) {
    return {
      schemaVersion: "tier-b-technical-evidence/v1",
      status: "unavailable",
      symbol: String(symbol ?? "").toUpperCase(),
      cutoff: { tradingDate: cutoffTradingDate },
      reasonCodes: [String(error?.code ?? "tier_b_evidence_build_failed")],
      error: cleanError(error),
      relatedLoadErrors: related.errors,
      advisory: true,
      decisionAuthority: "LLM",
    };
  }
}

async function loadTierBRelatedDaily({
  linkage,
  loadCandles,
  cutoffTradingDate,
  signal,
}) {
  const descriptors = [
    ...(linkage.sectorSymbol
      ? [{ kind: "sector", symbol: linkage.sectorSymbol }]
      : []),
    ...linkage.peerSymbols.map((peer) => ({ kind: "peer", symbol: peer })),
  ];
  const settled = await Promise.allSettled(descriptors.map(async (descriptor) => {
    throwIfCancelled(signal);
    const loaded = normalizeCandleLoadResult(await loadCandles(descriptor.symbol));
    return {
      ...descriptor,
      daily: tierBDailyDescriptor(
        completedCandlesThrough(loaded.candles, cutoffTradingDate),
        loaded.coverage,
      ),
    };
  }));
  throwIfCancelled(signal);
  const values = [];
  const errors = [];
  for (let index = 0; index < settled.length; index += 1) {
    const item = settled[index];
    const descriptor = descriptors[index];
    if (item.status === "fulfilled") values.push(item.value);
    else errors.push({
      symbol: descriptor.symbol,
      kind: descriptor.kind,
      code: String(item.reason?.code ?? item.reason?.kind ?? "related_daily_load_failed").slice(0, 80),
      message: cleanError(item.reason),
    });
  }
  const sectorValue = values.find((item) => item.kind === "sector") ?? null;
  const peerBySymbol = new Map(values
    .filter((item) => item.kind === "peer")
    .map((item) => [item.symbol, item]));
  return {
    sector: linkage.sectorSymbol
      ? {
          symbol: linkage.sectorSymbol,
          daily: sectorValue?.daily ?? null,
        }
      : null,
    // Keep the confirmed peer set intact. A failed fetch remains an explicit
    // unavailable descriptor instead of silently changing the comparison set.
    peers: linkage.peerSymbols.map((peer) => ({
      symbol: peer,
      daily: peerBySymbol.get(peer)?.daily ?? null,
    })),
    errors,
  };
}

function tierBDailyDescriptor(bars, coverage) {
  const values = Array.isArray(bars) ? bars : [];
  return {
    bars: values,
    interval: "1D",
    completedBarsOnly: true,
    source: String(coverage?.source ?? "host_normalized_completed_daily"),
    fetchedAt: coverage?.fetchedAt ?? null,
    coverage: coverage && typeof coverage === "object"
      ? structuredClone(coverage)
      : {
          source: "host_normalized_completed_daily",
          partial: true,
          partialReasons: ["coverage_metadata_unavailable"],
        },
  };
}

function normalizedConfirmedTechnicalLinkage(value, symbol) {
  if (!value || value.state !== "confirmed") return null;
  const target = String(symbol ?? "").trim().toUpperCase();
  if (String(value.symbol ?? "").trim().toUpperCase() !== target) return null;
  const sectorSymbol = String(value.sectorSymbol ?? "").trim().toUpperCase() || null;
  const peerSymbols = [...new Set((Array.isArray(value.peerSymbols) ? value.peerSymbols : [])
    .map((item) => String(item ?? "").trim().toUpperCase())
    .filter((item) => item && item !== target && item !== sectorSymbol))]
    .slice(0, 5);
  if (!sectorSymbol && !peerSymbols.length) return null;
  return {
    ...structuredClone(value),
    symbol: target,
    sectorSymbol,
    peerSymbols,
  };
}

function appendMultiTimeframeEvidence(evidence, technical) {
  const technicalV2 = technical?.technicalV2;
  if (!technicalV2) return;
  const tierB = technical?.tierB;
  const weekly = technicalV2.capabilityMatrix?.weeklyStructure;
  const hourly = technicalV2.capabilityMatrix?.execution60m;
  const cost = technicalV2.capabilityMatrix?.costProfile14d28d;
  const hourlyError = technicalV2.loads?.hourly60m?.error;
  evidence.push(
    evidenceItem(
      "周线结构",
      "local:weekly-structure",
      weekly?.asOf ?? null,
      weekly?.barCount ?? 0,
      weekly?.status === "complete"
        ? "succeeded"
        : weekly?.status === "warming"
          ? "degraded"
          : "skipped",
      weekly?.status === "complete"
        ? "已完成日 K 聚合为周线；末周固定排除，避免把进行中周线当作事实"
        : `周线层 ${weekly?.status ?? "unavailable"} · ${(weekly?.reasonCodes ?? []).join(", ") || "无可用输入"}`,
    ),
    evidenceItem(
      "60 分钟执行结构",
      "candlesticks:1h",
      hourly?.asOf ?? null,
      hourly?.barCount ?? 0,
      hourly?.status === "complete"
        ? "succeeded"
        : hourly?.status === "warming"
          ? "degraded"
          : "failed",
      hourly?.status === "complete"
        ? `只使用已证明完结的 60m K 线 · ${technicalV2.loads?.hourly60m?.finality?.method ?? "host_attested"}`
        : hourlyError?.message
          ?? `60 分钟层不可用 · ${(hourly?.reasonCodes ?? []).join(", ") || "无可用输入"}`,
    ),
    evidenceItem(
      "14/28 日价格-成交量集中代理",
      "local:daily-cost-concentration-proxy",
      cost?.asOf ?? null,
      cost?.barCount ?? 0,
      cost?.status === "complete"
        ? "degraded"
        : cost?.status === "warming"
          ? "degraded"
          : "skipped",
      cost?.status === "complete"
        ? "80 档均匀区间分配 · 70% 价值区 · LOW CONFIDENCE · 非逐笔筹码或持有人成本"
        : `成本集中代理 ${cost?.status ?? "unavailable"} · ${(cost?.reasonCodes ?? []).join(", ") || "无可用输入"}`,
    ),
  );
  if (!tierB) return;
  const layer = (name) => tierB.layers?.[name] ?? null;
  const linkage = tierB.linkage ?? null;
  const relatedLayerStatus = [layer("sector")?.status, layer("peers")?.status]
    .filter(Boolean);
  evidence.push(
    evidenceItem(
      "Tier-B 同截止技术证据",
      "local:tier-b-technical-evidence",
      tierB.cutoff?.knowledgeCutoffAt ?? tierB.cutoff?.tradingDate ?? null,
      Object.values(tierB.layers ?? {}).filter((item) => item?.status !== "unavailable").length,
      tierB.status === "complete" ? "succeeded" : tierB.status === "partial" ? "degraded" : "skipped",
      `日/周/60m/QQQ 使用同一截止 ${tierB.cutoff?.tradingDate ?? "N/A"}；严格不前填，观察、计算与推断分层`,
    ),
    evidenceItem(
      "行业与同行联动",
      "local:confirmed-market-linkage",
      linkage?.confirmedAt ?? null,
      Number(Boolean(linkage?.sectorSymbol)) + (linkage?.peerSymbols?.length ?? 0),
      relatedLayerStatus.includes("complete") || relatedLayerStatus.includes("available")
        ? "succeeded"
        : linkage?.status === "confirmed" ? "degraded" : "skipped",
      linkage?.status === "confirmed"
        ? `仅使用用户确认映射 · 行业 ${linkage.sectorSymbol ?? "N/A"} · 同行 ${(linkage.peerSymbols ?? []).join(" / ") || "N/A"}${tierB.relatedLoadErrors?.length ? ` · ${tierB.relatedLoadErrors.length} 个数据缺口` : ""}`
        : "尚未确认行业ETF与 2–5 个同行；本轮不让模型猜测后自动发起行情请求",
    ),
    evidenceItem(
      "显式锚定 VWAP",
      "local:anchored-vwap",
      tierB.observed?.evidence?.anchoredVwap?.asOf ?? null,
      layer("anchoredVwap")?.status === "available" ? 1 : 0,
      layer("anchoredVwap")?.status === "available" ? "succeeded" : "skipped",
      layer("anchoredVwap")?.status === "available"
        ? "仅使用显式事件或用户锚点计算"
        : "没有已发布锚点则保持 N/A；不会自动挑选最有利锚点",
    ),
    evidenceItem(
      "期权与事件证据",
      "local:options-catalyst-capability",
      tierB.observed?.evidence?.options?.asOf
        ?? tierB.observed?.evidence?.catalyst?.asOf
        ?? null,
      Number(layer("options")?.status === "available") + Number(layer("catalyst")?.status === "available"),
      layer("options")?.status === "available" || layer("catalyst")?.status === "available"
        ? "degraded"
        : "skipped",
      "没有带来源、knownAt 与截止时间的期权链/事件事实时保持 N/A；不由 OI 推断 dealer gamma",
    ),
  );
}

function inferTechnicalHorizon(task) {
  const text = String(task ?? "").toLowerCase();
  if (/财报|earnings|事件|event/.test(text)) return "event";
  if (/日内|盘中|小时|60\s*(分钟|m)|intraday/.test(text)) return "intraday";
  return "swing";
}

function defaultSafeguards() {
  return {
    orderWrite: false,
    modelNarration: false,
    execution: "所有交易由用户在对应券商端手动确认",
  };
}

function assertPortfolio(portfolio) {
  if (!portfolio || !Array.isArray(portfolio.positions)) {
    throw new Error("缺少有效的长桥持仓快照。");
  }
}

function normalizeCandidateSymbol(symbol) {
  const value = String(symbol ?? "").trim().toUpperCase();
  if (!value) throw new Error("请输入候选证券代码。");
  if (!/^[A-Z0-9._-]{1,30}$/.test(value)) throw new Error("候选证券代码无效。");
  if (value.includes(".")) return value;
  if (/^[A-Z][A-Z0-9-]{0,9}$/.test(value)) return `${value}.US`;
  throw new Error("非美股候选代码请包含市场后缀，例如 700.HK。");
}

function inferSymbolCurrency(symbol) {
  const market = String(symbol ?? "").toUpperCase().split(".").at(-1);
  if (market === "US") return "USD";
  if (market === "HK") return "HKD";
  if (["SH", "SZ", "CN"].includes(market)) return "CNY";
  if (market === "SG") return "SGD";
  return null;
}

function inferCandidateInstrumentType(symbol) {
  const localCode = String(symbol ?? "").toUpperCase().split(".")[0];
  return /\d{6}[CP]\d+$/.test(localCode) ? "option" : "equity";
}

function contextTarget(target) {
  return {
    symbol: target.symbol ?? null,
    ticker: target.ticker ?? null,
    name: target.name ?? null,
    group: target.group ?? null,
    currency: target.currency ?? null,
    instrumentType: target.instrumentType ?? "equity",
    isHeld: target.isHeld ?? Number.isFinite(target.quantity),
    quantity: finiteOrNull(target.quantity),
    availableQuantity: finiteOrNull(target.availableQuantity),
    costPrice: finiteOrNull(target.costPrice),
    lastPrice: finiteOrNull(target.lastPrice),
    weightPercent: finiteOrNull(target.weight ?? target.existingWeight),
    pnlPercent: finiteOrNull(target.pnlPercent),
  };
}

function compactPriceBars(candles, limit = 260) {
  return (Array.isArray(candles) ? candles : [])
    .slice(-limit)
    .map((bar) => ({
      barId: String(bar?.timestamp ?? ""),
      time: bar?.timestamp ?? null,
      tradeDate: bar?.tradeDate ?? null,
      timestampBasis: bar?.timestampBasis ?? null,
      open: finiteOrNull(bar?.open),
      high: finiteOrNull(bar?.high),
      low: finiteOrNull(bar?.low),
      close: finiteOrNull(bar?.close),
      volume: finiteOrNull(bar?.volume),
    }))
    .filter((bar) =>
      bar.barId
      && bar.high != null
      && bar.low != null
      && bar.close != null
    );
}

function normalizeCandleLoadResult(value) {
  if (Array.isArray(value)) return { candles: value, coverage: null };
  return {
    candles: Array.isArray(value?.candles) ? value.candles : [],
    coverage: value?.coverage && typeof value.coverage === "object"
      ? value.coverage
      : null,
  };
}

async function loadTargetAndBenchmarkCandles(loadCandles, symbol) {
  const targetSymbol = String(symbol ?? "").toUpperCase();
  const benchmarkSymbol = "QQQ.US";
  const targetPromise = Promise.resolve().then(() => loadCandles(targetSymbol));
  const benchmarkPromise = targetSymbol === benchmarkSymbol
    ? targetPromise
    : Promise.resolve().then(() => loadCandles(benchmarkSymbol));
  const [targetResult, benchmarkResult] = await Promise.allSettled([
    targetPromise,
    benchmarkPromise,
  ]);
  if (targetResult.status === "rejected") throw targetResult.reason;
  return {
    target: normalizeCandleLoadResult(targetResult.value),
    benchmark: benchmarkResult.status === "fulfilled"
      ? {
          symbol: benchmarkSymbol,
          ...normalizeCandleLoadResult(benchmarkResult.value),
          error: null,
        }
      : {
          symbol: benchmarkSymbol,
          candles: [],
          coverage: null,
          error: cleanError(benchmarkResult.reason),
        },
  };
}

function attachBenchmarkRelativeStrength(technical, {
  symbol,
  targetCandles,
  benchmarkLoad,
}) {
  if (!technical || !benchmarkLoad) return technical;
  if (benchmarkLoad.error) {
    return {
      ...technical,
      benchmarkRelativeStrength: {
        benchmark: benchmarkLoad.symbol,
        status: "unavailable",
        reason: benchmarkLoad.error,
        excessReturns: null,
      },
      capabilityMatrix: {
        ...technical.capabilityMatrix,
        benchmarkRelativeStrength: "unavailable",
      },
    };
  }
  const benchmarkTechnical = String(symbol ?? "").toUpperCase() === benchmarkLoad.symbol
    ? technical
    : calculateTechnical(benchmarkLoad.candles, {
        symbol: benchmarkLoad.symbol,
        coverage: benchmarkLoad.coverage,
      });
  const targetCompleted = completedCandlesThrough(targetCandles, technical.asOfTradingDate);
  const benchmarkCompleted = completedCandlesThrough(
    benchmarkLoad.candles,
    benchmarkTechnical.asOfTradingDate,
  );
  let excessReturns;
  try {
    excessReturns = calculateDailyExcessReturns(targetCompleted, benchmarkCompleted);
  } catch (error) {
    excessReturns = {
      schemaVersion: 1,
      methodVersion: "daily-sequence-v1",
      calculation: "same_date_simple_excess_return",
      status: "unavailable",
      inputHash: null,
      asOf: technical.asOfTradingDate ?? null,
      windows: {},
      error: cleanError(error),
    };
  }
  const benchmarkDecisionReady = benchmarkTechnical.marketData
    ? benchmarkTechnical.marketData.freshForDecision === true
    : benchmarkTechnical.lastBar?.status === "CLOSED";
  const status = benchmarkDecisionReady
    ? excessReturns.status
    : excessReturns.status === "unavailable" ? "unavailable" : "research_only";
  return {
    ...technical,
    benchmarkRelativeStrength: {
      benchmark: benchmarkLoad.symbol,
      status,
      asOfTradingDate: benchmarkTechnical.asOfTradingDate ?? null,
      marketData: benchmarkTechnical.marketData ?? null,
      excessReturns,
      reason: benchmarkDecisionReady
        ? null
        : "QQQ 基准不是最新可决策证据；超额收益仅供研究。",
    },
    capabilityMatrix: {
      ...technical.capabilityMatrix,
      benchmarkRelativeStrength: status,
    },
  };
}

function completedCandlesThrough(candles, tradingDate) {
  const cutoff = String(tradingDate ?? "");
  return (Array.isArray(candles) ? candles : []).filter((bar) => {
    const date = String(bar?.tradeDate ?? bar?.trade_date ?? "");
    if (cutoff && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date <= cutoff;
    const timestamp = Date.parse(String(bar?.timestamp ?? ""));
    const cutoffTime = Date.parse(`${cutoff}T23:59:59.999Z`);
    return !cutoff || (Number.isFinite(timestamp) && timestamp <= cutoffTime);
  });
}

function benchmarkEvidenceItem(technical) {
  const benchmark = technical?.benchmarkRelativeStrength;
  const records = Object.values(benchmark?.excessReturns?.windows ?? {})
    .filter((metric) => metric?.status === "available").length;
  return evidenceItem(
    "QQQ 市场基准",
    "candlesticks:QQQ.US",
    benchmark?.asOfTradingDate ?? null,
    records,
    benchmark?.status === "complete"
      ? "succeeded"
      : benchmark?.status === "partial" || benchmark?.status === "research_only"
        ? "degraded"
        : "failed",
    benchmark?.status === "unavailable"
      ? benchmark?.reason ?? "QQQ 基准不可用"
      : `同交易日 1/3/5/10/20 日相对 QQQ 超额收益 · ${benchmark?.status ?? "unknown"}`,
  );
}

function candleEvidenceSummary(technical) {
  const marketData = technical?.marketData;
  const freshness = !marketData
    ? "来源新鲜度未提供"
    : marketData.freshForSizing
      ? "实时来源，可用于当前仓位校验"
      : marketData.freshForDecision
        ? "交易日完整，仅用于分析"
        : marketData.freshForResearch
          ? "缓存或缺少最新交易日，仅供研究"
          : "行情证据不可用";
  return `1D · OHLCV · 前复权 · 常规交易时段 · 最新输入 ${technical?.lastBar?.status ?? "UNKNOWN"}${technical?.provisional?.available ? "（未计入正式指标）" : ""} · ${freshness}`;
}

function contextPosition(position) {
  return {
    broker: position.broker ?? "longbridge",
    brokerLegs: position.brokerLegs ?? null,
    contractMultiplier: finiteOrNull(position.contractMultiplier),
    option: position.option ?? null,
    marketData: position.marketData ?? null,
    valuationSource: position.valuationSource ?? null,
    symbol: position.symbol ?? null,
    ticker: position.ticker ?? null,
    name: position.name ?? null,
    group: position.group ?? null,
    currency: position.currency ?? null,
    instrumentType: position.instrumentType ?? "equity",
    direction: position.direction ?? null,
    quantity: finiteOrNull(position.quantity),
    availableQuantity: finiteOrNull(position.availableQuantity),
    costPrice: finiteOrNull(position.costPrice),
    costBasisStatus: position.costBasisStatus ?? null,
    costBasisLimitation: position.costBasisLimitation ?? null,
    lastPrice: finiteOrNull(position.lastPrice),
    marketValueBase: finiteOrNull(position.marketValueBase),
    grossMarketValueBase: finiteOrNull(position.grossMarketValueBase),
    weightPercent: finiteOrNull(position.weight),
    netWeightPercent: finiteOrNull(position.netWeight),
    pnlBase: finiteOrNull(position.pnlBase),
    pnlPercent: finiteOrNull(position.pnlPercent),
    quoteTimestamp: position.quoteTimestamp ?? null,
    valuationStatus: position.valuationStatus ?? null,
    valuationLimitation: position.valuationLimitation ?? null,
  };
}

function sortedExposure(explicit, positions, keyField, weightField) {
  let entries;
  if (explicit && typeof explicit === "object" && Object.keys(explicit).length) {
    entries = Object.entries(explicit);
  } else {
    const totals = new Map();
    for (const position of positions ?? []) {
      const key = String(position?.[keyField] ?? "未分类");
      const weight = finiteOrNull(position?.[weightField]);
      if (weight == null) continue;
      totals.set(key, (totals.get(key) ?? 0) + weight);
    }
    entries = [...totals.entries()];
  }
  return entries
    .map(([key, weight]) => ({ key, weight: finiteRound(weight, 2) }))
    .filter((item) => item.weight != null)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
}

function addThresholdAlert(alerts, code, label, value, warningThreshold, criticalThreshold) {
  if (!Number.isFinite(value)) return;
  if (value > criticalThreshold) {
    alerts.push(riskAlert(code, "critical", `${label}超过 ${criticalThreshold}%`, value, criticalThreshold));
  } else if (value > warningThreshold) {
    alerts.push(riskAlert(code, "warning", `${label}超过 ${warningThreshold}%`, value, warningThreshold));
  }
}

function riskAlert(code, severity, label, value, threshold) {
  return {
    code,
    severity,
    label,
    value: finiteRound(value, 2) ?? value ?? null,
    threshold,
  };
}

function sumFinite(values) {
  return (values ?? []).reduce(
    (sum, value) => sum + (Number.isFinite(value) ? Number(value) : 0),
    0,
  );
}

function finiteOrNull(value) {
  if (value == null || typeof value === "boolean") return null;
  if (typeof value === "string" && !value.trim()) return null;
  if (!["number", "string"].includes(typeof value)) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function finiteRound(value, digits = 3) {
  const finite = finiteOrNull(value);
  return finite == null ? null : round(finite, digits);
}

function evidenceItem(source, tool, asOf, records, status, summary) {
  return { source, tool, asOf, records, status, summary };
}

function cleanError(error) {
  return error instanceof Error ? error.message : "未知错误";
}

function formatNumber(value) {
  return Number.isFinite(value) ? Number(value).toFixed(2) : "—";
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${Number(value).toFixed(2)}%` : "—";
}

function formatSignedPercent(value) {
  return Number.isFinite(value)
    ? `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}%`
    : "—";
}
