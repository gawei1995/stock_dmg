import { calculateTechnical, round } from "./technical.mjs";

// This module is a deterministic evidence builder, not a conversational
// harness. Codex App Server owns the only Agent/thread/tool lifecycle.
export async function buildAnalysisEvidence(options = {}) {
  const scope = normalizeAnalysisScope(options.scope);
  if (scope === "portfolio") return buildPortfolioEvidence(options);
  if (scope === "candidate") return buildCandidateEvidence(options);
  return buildPositionEvidence(options);
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
  onStage = () => {},
  signal,
}) {
  throwIfCancelled(signal);
  const startedAt = Date.now();
  const position = portfolio?.positions?.find((item) => item.symbol === symbol);
  if (!position) throw new Error("选中的标的不在当前长桥持仓中。");
  const intent = classifyIntent(task);
  const portfolioEvidenceStatus = portfolio.status === "live" ? "succeeded" : "degraded";
  const selectedQuoteStatus = position.lastPrice != null && position.quoteTimestamp
    ? "succeeded"
    : "degraded";
  const fxError = portfolio.dataQuality?.sourceErrors?.find(
    (item) => item.tool === "exchange_rate",
  );
  const fxWarning = portfolio.dataQuality?.sourceWarnings?.find(
    (item) => item.tool === "exchange_rate",
  );
  const fxStatus = portfolio.dataQuality?.fxStatus ?? "unavailable";
  const fxEvidenceStatus = fxStatus === "live" || fxStatus === "reference"
    ? "succeeded"
    : fxStatus === "reference_cached"
      ? "degraded"
      : "failed";
  const fxSource = fxStatus === "live" ? "长桥账户汇率" : "ECB 参考汇率";
  const fxSummary = fxStatus === "live"
    ? "长桥账户汇率图"
    : fxStatus === "reference" || fxStatus === "reference_cached"
      ? `${portfolio.fx?.providerCode ?? "ECB"} ${portfolio.fx?.asOf ?? "最新"} 参考汇率${fxStatus === "reference_cached" ? "（缓存）" : ""}${fxWarning?.code ? ` · 长桥 ${fxWarning.code} 已降级` : ""}`
      : `跨币种估值暂停${fxError?.code ? ` · ${fxError.code}` : ""}`;
  const accountEvidenceStatus = portfolio.account?.netAssets != null ? "succeeded" : "degraded";

  const evidence = [
    evidenceItem("长桥账户", "account_balance", portfolio.syncedAt, 1, accountEvidenceStatus, "账户数据实时；跨币种聚合可能受汇率状态限制"),
    evidenceItem("长桥真实持仓", "stock_positions", portfolio.syncedAt, portfolio.positions.length, "succeeded", `${position.symbol} 数量 ${formatNumber(position.quantity)} · 权重 ${formatPercent(position.weight)}`),
    evidenceItem(
      fxSource,
      fxStatus === "live" ? "exchange_rate" : "ecb_reference_rates",
      portfolio.fx?.asOf ?? portfolio.syncedAt,
      portfolio.fx?.currencyCount ?? 0,
      fxEvidenceStatus,
      fxSummary,
    ),
    evidenceItem(
      "长桥行情",
      position.instrumentType === "option" ? "option_quote" : "quote",
      position.quoteTimestamp,
      position.lastPrice != null ? 1 : 0,
      selectedQuoteStatus,
      position.lastPrice != null
        ? `现价 ${formatNumber(position.lastPrice)} · ${position.quoteSession ?? "unknown session"}`
        : position.valuationLimitation,
    ),
  ];

  let candles = [];
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
    candles = await loadCandles(symbol);
    throwIfCancelled(signal);
    evidence.push(
      evidenceItem(
        "长桥日线",
        "candlesticks",
        candles.at(-1)?.timestamp ?? null,
        candles.length,
        candles.length >= 21 ? "succeeded" : "degraded",
        "1D · 前复权 · 仅常规交易时段",
      ),
    );
    technical = calculateTechnical(candles);
  } catch (error) {
    throwIfCancelled(signal);
    technical = calculateTechnical([]);
    evidence.push(
      evidenceItem("长桥日线", "candlesticks", null, 0, "failed", cleanError(error)),
    );
  }

  notifyStage(onStage, "risk_plan", "正在计算 EMA、Fib、组合风险与条件计划");
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
  const hasUsableShortStructure = technical.ema?.[21] != null;
  const state = !hasUsableShortStructure
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
      marketDataAsOf: technical.asOf ?? position.quoteTimestamp,
    },
    analysisContext: buildScopedAnalysisContext({
      scope: "position",
      portfolio,
      target: position,
      technical,
      risk,
    }),
    conclusion,
    technical,
    risk,
    plan,
    evidence,
    safeguards: {
      orderWrite: false,
      modelNarration: false,
      execution: "所有交易由用户在长桥端手动确认",
    },
    sections: sectionsForIntent(intent),
    capabilities: {
      ...technical.capabilities,
      portfolioRisk: risk.supported,
      portfolioRiskComplete: risk.portfolioValuationComplete,
      conditionalPlan: plan.available,
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
    candles = await loadCandles(targetSymbol);
    throwIfCancelled(signal);
    technical = calculateTechnical(candles);
    evidence.push(
      evidenceItem(
        "长桥日线",
        "candlesticks",
        candles.at(-1)?.timestamp ?? null,
        candles.length,
        candles.length >= 21 ? "succeeded" : "degraded",
        "1D · 前复权 · 仅常规交易时段；最新收盘用于候选价格参考",
      ),
    );
  } catch (error) {
    throwIfCancelled(signal);
    technical = calculateTechnical([]);
    evidence.push(
      evidenceItem("长桥日线", "candlesticks", null, 0, "failed", cleanError(error)),
    );
  }

  notifyStage(onStage, "risk_plan", "正在计算候选 EMA、Fib、风险预算与买入条件");
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
      "候选风险预算",
      "local:candidate-risk",
      portfolio.syncedAt,
      1,
      risk.supported && risk.entryAllowed ? "succeeded" : "degraded",
      risk.supported && risk.entryAllowed
        ? `初始新增 ${formatPercent(risk.recommendedInitialAdditionalWeightPercent)} · 最大总仓位 ${formatPercent(risk.recommendedMaxWeightPercent)} · 仅现金建仓，不新增杠杆`
        : risk.supported
          ? `新增风险暂缓：${risk.entryBlockReasons.join("；")}`
        : risk.limitation,
    ),
  );

  const hasUsableShortStructure = technical.ema?.[21] != null;
  const state = !hasUsableShortStructure
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
      marketDataAsOf: technical.asOf ?? null,
    },
    analysisContext: buildScopedAnalysisContext({
      scope: "candidate",
      portfolio,
      target,
      technical,
      risk,
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
      candidateSizing: risk.supported,
      leverageAssessment: true,
      candidateEntryPlan: plan.available,
      conditionalPlan: plan.available,
      backgroundWatcher: false,
      orderWrite: false,
    },
  };
}

async function buildPortfolioEvidence({
  portfolio,
  task = "分析全部持仓与组合健康",
  riskBudgetPercent = 0.8,
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

  // Portfolio scope deliberately does not fetch a candle for every holding.
  // The portfolio snapshot already contains the latest marks needed for a
  // concentration review; per-symbol EMA/Fib remains an explicit second step.
  const technical = calculateTechnical([]);
  technical.reason = "组合分析不会逐个请求 K 线；请切换到已持仓或候选标的 scope 查看 EMA/Fib。";
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
      "单标的技术指标",
      "local:ema-fib",
      null,
      0,
      "skipped",
      "组合 scope 不逐个拉取 K 线，避免持仓越多分析越慢",
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
      marketDataAsOf: portfolio.quoteAsOf ?? portfolio.quoteLatestAsOf ?? null,
    },
    analysisContext: buildScopedAnalysisContext({
      scope: "portfolio",
      portfolio,
      target: null,
      technical,
      risk,
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
  if (["position", "candidate", "portfolio"].includes(value)) return value;
  throw new Error("分析范围无效；仅支持 position、candidate 或 portfolio。");
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
  const downsideReference = selectDownsideReference(lastPrice, technical);
  const reference = finiteOrNull(downsideReference?.level);
  const moveToReference = reference != null && lastPrice > 0
    ? ((reference - lastPrice) / lastPrice) * 100
    : null;
  const riskDistancePercent = moveToReference == null ? null : Math.abs(moveToReference);
  const normalizedBudget = round(Number(riskBudgetPercent), 2);
  const riskLimitedWeight = riskDistancePercent > 0
    ? (normalizedBudget / riskDistancePercent) * 100
    : null;
  const cashRatio = finiteOrNull(portfolio.totals?.cashRatio);
  const cashRatioValid = cashRatio != null && cashRatio >= 0;
  const technicalPlanReady = candidateTechnicalPlanReady(technical);
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
      thresholds.grossWarningPercent,
      portfolioRisk.grossExposurePercent,
    ),
    cashFundedPercent: conservativeCashWeight,
  };
  const inputSupported =
    target.instrumentType !== "option"
    && technicalPlanReady
    && lastPrice > 0
    && reference > 0
    && netAssets > 0
    && portfolioValuationComplete
    && cashRatioValid
    && portfolioRisk.derivativeExposureComplete;
  const hardPortfolioBlockers = candidatePortfolioBlockers(portfolioRisk, cashRatio);
  const stageOneCeilingPercent = 4;
  const sizingCeilings = [
    riskLimitedWeight,
    stageOneCeilingPercent,
    concentrationHeadroom.singlePositionPercent == null
      ? null
      : existingWeight + concentrationHeadroom.singlePositionPercent,
    concentrationHeadroom.top5Percent == null
      ? null
      : existingWeight + concentrationHeadroom.top5Percent,
    concentrationHeadroom.grossExposurePercent == null
      ? null
      : existingWeight + concentrationHeadroom.grossExposurePercent,
    concentrationHeadroom.cashFundedPercent == null
      ? null
      : existingWeight + concentrationHeadroom.cashFundedPercent,
    concentrationHeadroom.groupPercent == null
      ? null
      : existingWeight + concentrationHeadroom.groupPercent,
  ].filter((value) => Number.isFinite(value));
  const unconstrainedMaxWeight = inputSupported && sizingCeilings.length
    ? Math.max(0, Math.min(...sizingCeilings))
    : null;
  const provisionalMaxWeight = hardPortfolioBlockers.length
    ? existingWeight
    : unconstrainedMaxWeight == null
      ? null
      : Math.max(existingWeight, unconstrainedMaxWeight);
  const maxAdditionalWeight = provisionalMaxWeight == null
    ? null
    : Math.max(0, provisionalMaxWeight - existingWeight);
  const entryAllowed = inputSupported
    && hardPortfolioBlockers.length === 0
    && maxAdditionalWeight > 0;
  const recommendedInitialAdditionalWeight = entryAllowed
    ? Math.min(2, maxAdditionalWeight)
    : 0;
  const recommendedInitialTotalWeight = existingWeight + recommendedInitialAdditionalWeight;
  const supported = inputSupported;
  const riskBudgetValue = netAssets > 0
    ? netAssets * (normalizedBudget / 100)
    : null;
  const provisionalNotional = supported && provisionalMaxWeight != null
    ? netAssets * (provisionalMaxWeight / 100)
    : null;
  const initialAdditionalNotional = supported
    ? netAssets * (recommendedInitialAdditionalWeight / 100)
    : null;
  const maxAdditionalNotional = supported && maxAdditionalWeight != null
    ? netAssets * (maxAdditionalWeight / 100)
    : null;
  const impactAtReference = supported && maxAdditionalWeight != null
    ? (maxAdditionalWeight * moveToReference) / 100
    : null;
  const leverage = buildCandidateLeverageAssessment({
    portfolioRisk,
    cashRatio,
    initialAdditionalWeight: recommendedInitialAdditionalWeight,
    maxAdditionalWeight,
    entryAllowed,
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
      reference,
      technicalPlanReady,
      cashRatio,
      derivativeExposureComplete: portfolioRisk.derivativeExposureComplete,
    })] : []),
    ...(inputSupported && maxAdditionalWeight === 0 && hardPortfolioBlockers.length === 0
      ? ["风险预算、Stage 1 上限或组合集中度约束已没有新增仓位空间"]
      : []),
  ].filter(Boolean);

  return {
    scope: "candidate",
    supported,
    portfolioValuationComplete,
    technicalPlanReady,
    cashRatioValid,
    derivativeExposureComplete: portfolioRisk.derivativeExposureComplete,
    instrumentType: target.instrumentType ?? "equity",
    limitation: supported ? null : entryBlockReasons[0] ?? "候选仓位评估证据不足。",
    entryAllowed,
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
    referenceLevel: reference,
    referenceLabel: downsideReference?.label ?? "无可靠下行参考",
    moveToReferencePercent: moveToReference == null ? null : round(moveToReference, 2),
    riskDistancePercent: riskDistancePercent == null ? null : round(riskDistancePercent, 2),
    riskLimitedWeightPercent: riskLimitedWeight == null ? null : round(riskLimitedWeight, 2),
    stageAssumption: "stage_1_unvalidated",
    stagePolicyCeilingPercent: stageOneCeilingPercent,
    recommendedInitialAdditionalWeightPercent: supported
      ? round(recommendedInitialAdditionalWeight, 2)
      : null,
    recommendedInitialTotalWeightPercent: supported
      ? round(recommendedInitialTotalWeight, 2)
      : null,
    recommendedInitialNotionalBase: initialAdditionalNotional == null
      ? null
      : round(initialAdditionalNotional, 2),
    recommendedMaxAdditionalWeightPercent: supported && maxAdditionalWeight != null
      ? round(maxAdditionalWeight, 2)
      : null,
    recommendedMaxWeightPercent: supported && provisionalMaxWeight != null
      ? round(provisionalMaxWeight, 2)
      : null,
    recommendedMaxAdditionalNotionalBase: maxAdditionalNotional == null
      ? null
      : round(maxAdditionalNotional, 2),
    cashConstrainedWeightPercent: conservativeCashWeight == null
      ? null
      : round(conservativeCashWeight, 2),
    cashBufferFloorPercent,
    provisionalMaxWeightPercent: supported && provisionalMaxWeight != null
      ? round(provisionalMaxWeight, 2)
      : null,
    provisionalMaxNotionalBase: provisionalNotional == null
      ? null
      : round(provisionalNotional, 2),
    portfolioImpactAtReferencePercent: impactAtReference == null
      ? null
      : round(impactAtReference, 2),
    top1Weight: finiteRound(portfolio.totals?.top1Weight, 2),
    top5Weight: finiteRound(portfolio.totals?.top5Weight, 2),
    cashRatio: finiteRound(portfolio.totals?.cashRatio, 2),
    marginCall: portfolio.account?.marginCall ?? null,
    concentrationHeadroom: roundedObject(concentrationHeadroom),
    portfolioConstraints: candidatePortfolioConstraints(portfolioRisk),
    leverage,
    sizingNote: "候选默认按未验证 Stage 1：约 2% 初始探测、总仓位不高于 4%，再受风险预算、现金、集中度、主题、毛暴露与保证金约束；这是条件计划证据，不是自动买入建议。未计滑点、跳空、税费与汇率漂移。",
  };
}

function candidateInputLimitation({
  target,
  portfolioValuationComplete,
  netAssets,
  lastPrice,
  reference,
  technicalPlanReady,
  cashRatio,
  derivativeExposureComplete,
}) {
  if (target.instrumentType === "option") {
    return "候选期权需要合约乘数、标的映射与 Greeks；不能用正股仓位或杠杆计划替代。";
  }
  if (!portfolioValuationComplete) {
    return "组合估值不完整；可观察技术条件，但不能给出风险预算仓位上限。";
  }
  if (!(netAssets > 0)) return "缺少可靠净资产，不能把风险预算换算为候选仓位上限。";
  if (cashRatio == null) return "缺少可靠现金比例；候选仓位与杠杆计算已关闭。";
  if (cashRatio < 0) return "现金比例为负；候选仓位与杠杆计算已关闭。";
  if (!derivativeExposureComplete) {
    return "组合含期权，但当前快照缺少或尚未纳入 Delta/标的名义敞口；候选仓位与杠杆计算已关闭。";
  }
  if (!technicalPlanReady) {
    return "候选日线证据未达到计划标准（至少需要有效 EMA21、最新收盘与时间戳）；不能给出仓位上限。";
  }
  if (!(lastPrice > 0)) return "候选 K 线缺少可靠最新收盘价。";
  if (!(reference > 0)) return "没有低于当前价格的可靠 EMA/Fib/前低失效参考。";
  return null;
}

function candidatePortfolioBlockers(portfolioRisk, cashRatio) {
  const blockers = [];
  if (!portfolioRisk.portfolioValuationComplete) blockers.push("组合估值不完整，暂停新增风险");
  if (!portfolioRisk.derivativeExposureComplete) {
    blockers.push("组合含未量化 Delta/标的名义敞口的期权，暂停候选仓位与杠杆计算");
  }
  if (portfolioRisk.alerts.some((item) => item.code === "margin_call")) {
    blockers.push("账户存在追加保证金要求，禁止新增仓位或杠杆");
  }
  if (cashRatio != null && cashRatio < 0) blockers.push("现金比例为负，禁止新增仓位或杠杆");
  if (portfolioRisk.grossExposurePercent != null
    && portfolioRisk.grossExposurePercent >= portfolioRisk.policyThresholds.grossCriticalPercent) {
    blockers.push("组合毛暴露已达到关键阈值，先降总风险再评估候选");
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
    "候选默认处于未验证 Stage 1，初始建仓只允许现金覆盖，不新增融资暴露",
  ];
  if (!candidateGroupKnown) reasons.push("候选主题尚未映射，不能验证与现有主题暴露的重叠程度");
  if (!inputSupported) reasons.push("仓位风险输入不完整，无法支持融资风险估算");
  if (!portfolioRisk.derivativeExposureComplete) {
    reasons.push("组合期权的 Delta/标的名义敞口未完整纳入组合风险，禁止新增杠杆");
  }
  if (cashRatio != null && cashRatio < 5) reasons.push("现金缓冲低于 5%，不应使用新增杠杆");
  if (currentGross != null && currentGross > 100) reasons.push("组合当前毛暴露已高于 100%，不得继续增加融资暴露");

  return {
    additionalLeverageAllowed: false,
    decision: entryAllowed ? "cash_only" : "disabled",
    maxAdditionalBorrowedWeightPercent: 0,
    maxLeverageMultiple: 1,
    recommendedGrossExposureCeilingPercent: 100,
    reviewGrossExposureThresholdPercent: portfolioRisk.policyThresholds.grossWarningPercent,
    currentGrossExposurePercent: finiteRound(currentGross, 2),
    projectedGrossAtInitialPercent: finiteRound(projectedInitialGross, 2),
    projectedGrossAtMaxPercent: finiteRound(projectedMaxGross, 2),
    brokerBuyPowerExcluded: true,
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

function candidateTechnicalPlanReady(technical) {
  const candleCount = finiteOrNull(technical?.candleCount);
  const lastPrice = finiteOrNull(technical?.lastPrice);
  const ema21 = finiteOrNull(technical?.ema?.[21]);
  const asOfMs = Date.parse(String(technical?.asOf ?? ""));
  return technical?.status !== "degraded"
    && technical?.capabilities?.fastEma === true
    && technical?.timeframe === "1D"
    && candleCount >= 21
    && lastPrice > 0
    && ema21 > 0
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
  const valuationComplete = portfolio.dataQuality?.valuationComplete !== false;
  const grossExposurePercent = netAssets > 0
    && Number.isFinite(portfolio.totals?.positionsGrossMarketValueBase)
    ? (portfolio.totals.positionsGrossMarketValueBase / netAssets) * 100
    : sumFinite(positions.map((item) => item.weight));
  const netExposurePercent = netAssets > 0
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
  const top5Weight = finiteOrNull(portfolio.totals?.top5Weight)
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
  addThresholdAlert(alerts, "top1_concentration", "单一持仓集中度", top1Weight, 20, 30);
  addThresholdAlert(alerts, "top5_concentration", "Top5 集中度", top5Weight, 60, 80);
  addThresholdAlert(
    alerts,
    "group_concentration",
    `最大主题 ${groupExposure[0]?.key ?? "—"} 集中度`,
    groupExposure[0]?.weight,
    30,
    45,
  );
  addThresholdAlert(alerts, "gross_exposure", "组合总暴露", grossExposurePercent, 120, 160);
  addAlert(
    cashRatio != null && cashRatio < 0,
    riskAlert("negative_cash", "critical", "现金比例为负", cashRatio, 0),
  );
  addAlert(
    cashRatio != null && cashRatio >= 0 && cashRatio < 5,
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
    riskBudgetPercent: round(Number(riskBudgetPercent), 2),
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
    policyThresholds: {
      top1WarningPercent: 20,
      top1CriticalPercent: 30,
      top5WarningPercent: 60,
      top5CriticalPercent: 80,
      groupWarningPercent: 30,
      groupCriticalPercent: 45,
      grossWarningPercent: 120,
      grossCriticalPercent: 160,
      lowCashWarningPercent: 5,
    },
  };
}

export function buildScopedAnalysisContext({ scope, portfolio, target, technical, risk }) {
  const normalizedScope = normalizeAnalysisScope(scope);
  const summary = {
    snapshotAt: portfolio.syncedAt ?? null,
    valuationSchemaVersion: portfolio.valuationSchemaVersion ?? null,
    sourceStatus: portfolio.status ?? "unknown",
    baseCurrency: portfolio.account?.baseCurrency ?? "USD",
    netAssets: finiteOrNull(portfolio.account?.netAssets),
    cashRatioPercent: finiteOrNull(portfolio.totals?.cashRatio),
    top1WeightPercent: finiteOrNull(portfolio.totals?.top1Weight),
    top5WeightPercent: finiteOrNull(portfolio.totals?.top5Weight),
    valuationComplete: portfolio.dataQuality?.valuationComplete !== false,
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
          lastPrice: finiteOrNull(technical.lastPrice),
          shortStructure: technical.shortStructure ?? null,
          longStructure: technical.longStructure ?? null,
          ema: technical.ema ?? {},
          emaSlope5d: technical.emaSlope5d ?? {},
          fib: technical.fib ?? null,
        },
    risk,
  };
  if (normalizedScope === "portfolio") {
    context.positions = (portfolio.positions ?? []).map(contextPosition);
    context.groupExposure = risk.groupExposure ?? summary.largestGroups;
    context.groupNetExposure = risk.groupNetExposure ?? [];
    context.currencyExposure = risk.currencyExposure ?? [];
    context.cashByCurrency = risk.cashByCurrency ?? [];
  }
  return context;
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
  const maxPositionMove = weight ? (Number(riskBudgetPercent) / weight) * 100 : null;

  return {
    supported,
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
    riskBudgetPercent: round(Number(riskBudgetPercent), 2),
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
  const fibLevels = Object.entries(technical.fib?.levels ?? {})
    .map(([ratio, level]) => ({ ratio, level }))
    .filter((item) => Number.isFinite(item.level));
  const upsideFib = fibLevels
    .filter((item) => item.level > lastPrice)
    .sort((a, b) => a.level - b.level)[0];
  const downsideFib = fibLevels
    .filter((item) => item.level < lastPrice)
    .sort((a, b) => b.level - a.level)[0];

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
        then: `仅生成“允许评估”信号；新增风险不得超过组合 ${risk.riskBudgetPercent}%${upsideFib ? `；下一 Fib ${upsideFib.ratio} 观察位 ${formatNumber(upsideFib.level)}` : ""}`,
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
        then: `只生成减仓/保护评估提醒，由用户在长桥端确认${downsideFib ? `；下一 Fib ${downsideFib.ratio} 观察位 ${formatNumber(downsideFib.level)}` : ""}`,
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

  const ema = technical.ema;
  const lastPrice = technical.lastPrice ?? target.lastPrice;
  const overhead = [8, 13, 21]
    .map((period) => ({ label: `EMA${period}`, level: ema[period] }))
    .filter((item) => Number.isFinite(item.level) && item.level > lastPrice)
    .sort((a, b) => a.level - b.level)[0];
  const support = [8, 13, 21, 144, 169]
    .map((period) => ({ label: `EMA${period}`, level: ema[period] }))
    .filter((item) => Number.isFinite(item.level) && item.level < lastPrice)
    .sort((a, b) => b.level - a.level)[0];
  const baseLow = Math.min(ema[13] ?? ema[21], ema[21]);
  const baseHigh = Math.max(ema[13] ?? ema[21], ema[21]);
  const entryTrigger = overhead
    ? `日线收盘站上 ${overhead.label} ${formatNumber(overhead.level)}，随后首次回踩不破`
    : `回踩 ${support?.label ?? "EMA8"} ${formatNumber(support?.level ?? ema[8])} 附近止跌，EMA3/5 保持正斜率`;
  const invalidation = risk.referenceLevel != null
    ? `日线有效跌破 ${risk.referenceLabel} ${formatNumber(risk.referenceLevel)}`
    : `日线跌破前 20 日低点 ${formatNumber(technical.range20?.priorLow)}`;
  const sizingText = risk.supported
    ? `初始新增 ${formatPercent(risk.recommendedInitialAdditionalWeightPercent)}（约 ${risk.baseCurrency} ${formatNumber(risk.recommendedInitialNotionalBase)}），最大总仓位 ${formatPercent(risk.recommendedMaxWeightPercent)}，最大新增 ${formatPercent(risk.recommendedMaxAdditionalWeightPercent)}`
    : `仅记录技术触发；${risk.limitation}`;

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
  };
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
    state: risk.supported ? "candidate_snapshot" : "technical_only",
    available: true,
    watcherEnabled: false,
    evaluatedAt: technical.asOf,
    riskSizingAvailable: risk.supported,
    sizing,
    leverage: risk.leverage,
    scenarios: [
      {
        name: "允许试探",
        tone: "bull",
        if: entryTrigger,
        then: `${sizingText}；仅允许现金覆盖，不新增融资杠杆，并在成交前用最新快照重算`,
        invalidation,
        impact: risk.supported
          ? `触及参考失效位时，静态组合影响不高于约 ${formatSignedPercent(risk.portfolioImpactAtReferencePercent)}`
          : "仓位影响暂不可计算",
        status: "snapshot_only",
      },
      {
        name: "等待",
        tone: "base",
        if: `价格在 EMA13–EMA21 区域 ${formatNumber(baseLow)}–${formatNumber(baseHigh)} 内交错`,
        then: "保持观察名单状态，不在区间中部追价",
        invalidation: "快线重新有序，或日线收盘脱离区间",
        impact: "未持有时组合影响为 0；已有仓位则仅冻结新增风险",
        status: "snapshot_only",
      },
      {
        name: "取消计划",
        tone: "bear",
        if: invalidation,
        then: "取消本次买入计划；等待新的 A-B-C 波段或均线重新定序",
        invalidation: risk.referenceLevel != null
          ? `日线重新收复 ${risk.referenceLabel} ${formatNumber(risk.referenceLevel)}`
          : "日线重新收复破位前低点",
        impact: "不建立新仓位，不自动下单",
        status: "snapshot_only",
      },
    ],
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
        if: "存在追加保证金、负现金、估值缺口或关键行情不可用",
        then: "暂停新增风险，先恢复账户与估值完整性；所有操作由用户在长桥端确认",
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
    ...[0.382, 0.618, 1, 1.618].map((ratio) => ({
      label: `Fib ${ratio}`,
      level: technical.fib?.levels?.[String(ratio)],
    })),
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
  if (technical.ema?.[21] == null) {
    return {
      headline: `${position.ticker} 仅完成仓位风险检查`,
      body: `长桥仓位权重 ${formatPercent(risk.positionWeight)}；由于 K 线不足或请求失败，不编造 EMA、Fib 或交易触发。`,
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
      body: `${task}。日线证据未达到计划标准，未编造 EMA、Fib、入场位或仓位上限。${risk.limitation ? ` ${risk.limitation}` : ""}`,
      posture: "保留观察，不建立仓位",
    };
  }
  const holdingNote = target.isHeld
    ? `当前已有 ${formatPercent(risk.existingPositionWeight)} 持仓，本计划只针对新增风险。`
    : "当前未持有，触发前组合暴露为 0。";
  const sizingNote = risk.supported && risk.entryAllowed
    ? `建议初始新增 ${formatPercent(risk.recommendedInitialAdditionalWeightPercent)}，最大总仓位 ${formatPercent(risk.recommendedMaxWeightPercent)}；失效参考为 ${risk.referenceLabel} ${formatNumber(risk.referenceLevel)}。新增杠杆为 0。`
    : risk.supported
      ? `当前建议新增仓位 0%；${risk.entryBlockReasons.join("；")}。`
    : risk.limitation;
  return {
    headline: `${target.ticker}：候选买入计划 · ${technical.shortStructure}`,
    body: `${task}。${holdingNote}${sizingNote} 长线结构为“${technical.longStructure}”。`,
    posture: !risk.entryAllowed
      ? "保留观察，先解除组合风险约束"
      : technical.shortStructure === "完整多头"
      ? "等回踩确认，避免直接追价"
      : technical.shortStructure === "完整空头"
        ? "不接下跌趋势，等待重新定序"
        : "保持观察，等快线给出方向",
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
  const fxError = portfolio.dataQuality?.sourceErrors?.find(
    (item) => item.tool === "exchange_rate",
  );
  const fxWarning = portfolio.dataQuality?.sourceWarnings?.find(
    (item) => item.tool === "exchange_rate",
  );
  const fxStatus = portfolio.dataQuality?.fxStatus ?? "unavailable";
  const fxEvidenceStatus = fxStatus === "live" || fxStatus === "reference"
    ? "succeeded"
    : fxStatus === "reference_cached"
      ? "degraded"
      : "failed";
  const fxSource = fxStatus === "live" ? "长桥账户汇率" : "ECB 参考汇率";
  const fxSummary = fxStatus === "live"
    ? "长桥账户汇率图"
    : fxStatus === "reference" || fxStatus === "reference_cached"
      ? `${portfolio.fx?.providerCode ?? "ECB"} ${portfolio.fx?.asOf ?? "最新"} 参考汇率${fxStatus === "reference_cached" ? "（缓存）" : ""}${fxWarning?.code ? ` · 长桥 ${fxWarning.code} 已降级` : ""}`
      : `跨币种估值暂停${fxError?.code ? ` · ${fxError.code}` : ""}`;
  return [
    evidenceItem(
      "长桥账户",
      "account_balance",
      portfolio.syncedAt,
      1,
      portfolio.account?.netAssets != null ? "succeeded" : "degraded",
      "账户数据实时；跨币种聚合可能受汇率状态限制",
    ),
    evidenceItem(
      "长桥真实持仓",
      "stock_positions",
      portfolio.syncedAt,
      portfolio.positions.length,
      portfolio.holdingsStatus === "live" || portfolio.status === "live"
        ? "succeeded"
        : "degraded",
      holdingsSummary,
    ),
    evidenceItem(
      fxSource,
      fxStatus === "live" ? "exchange_rate" : "ecb_reference_rates",
      portfolio.fx?.asOf ?? portfolio.syncedAt,
      portfolio.fx?.currencyCount ?? 0,
      fxEvidenceStatus,
      fxSummary,
    ),
  ];
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

function defaultSafeguards() {
  return {
    orderWrite: false,
    modelNarration: false,
    execution: "所有交易由用户在长桥端手动确认",
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

function contextPosition(position) {
  return {
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
  return Number.isFinite(Number(value)) && value !== "" && value != null
    ? Number(value)
    : null;
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
