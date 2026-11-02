import {
  NUMERIC_EVIDENCE_SCHEMA_VERSION,
  createDerivedMetric,
  createObservedFact,
  numericEvidenceRef,
} from "./numeric-evidence.mjs";
import { appendTechnicalNumericEvidence } from "./technical-numeric-evidence.mjs";

export const CORE_NUMERIC_EVIDENCE_PACKAGE_VERSION = "core-numeric-evidence/v1";

/**
 * Build the small, high-value numeric contract delivered to every Agent turn.
 * This adapter is intentionally narrower than the complete portfolio model;
 * fields are added only when their unit, time and provenance are unambiguous.
 */
export function buildCoreNumericEvidence({
  portfolio,
  target = null,
  technical = null,
  risk = null,
  now = () => new Date(),
} = {}) {
  const generatedAt = validIsoOrNull(now?.()) ?? new Date().toISOString();
  const baseCurrency = currencyCode(portfolio?.account?.baseCurrency, "USD");
  const portfolioSourceAt = validIsoOrNull(portfolio?.syncedAt);
  const portfolioAt = portfolioSourceAt ?? generatedAt;
  const portfolioTimestampKnown = portfolioSourceAt != null;
  const portfolioAgeMs = safeAge(portfolio?.freshness?.ageMs);
  const portfolioFreshness = !portfolioTimestampKnown
    ? "unknown"
    : portfolio?.freshness?.freshForSizing === true
      ? "live"
      : portfolio?.status === "cached"
        ? "cached"
        : portfolio?.status === "live"
          ? "fresh"
          : "stale";
  const portfolioComplete = portfolioTimestampKnown
    && portfolio?.dataQuality?.valuationComplete === true;
  const portfolioReasonCodes = portfolioTimestampKnown ? [] : ["source_timestamp_missing"];
  const hasOptions = Array.isArray(portfolio?.positions)
    && portfolio.positions.some((position) => position?.instrumentType === "option");
  const derivativeRiskIncomplete = hasOptions && risk?.derivativeExposureComplete !== true;
  const exposureReasonCodes = [
    ...portfolioReasonCodes,
    ...(hasOptions ? ["includes_option_premium_market_value", "not_delta_or_underlying_notional_exposure"] : []),
    ...(derivativeRiskIncomplete ? ["derivative_risk_exposure_incomplete"] : []),
  ];
  const observed = [];
  const derived = [];
  const portfolioSource = portfolio?.source ?? "Longbridge normalized portfolio";
  const portfolioTool = portfolio?.brokerScope === "ibkr" ? "ibkr_portfolio"
    : portfolio?.brokerAccounts?.length > 1 || portfolio?.missingBrokers?.length ? "broker_portfolio_aggregate" : "account_balance";

  const netAssets = accountMoneyFact({
    source: portfolioSource, tool: portfolioTool,
    metric: "portfolio.net_assets",
    rawField: "account.netAssets",
    value: portfolio?.account?.netAssets,
    currency: baseCurrency,
    effectiveAt: portfolioAt,
    ageMs: portfolioAgeMs,
    freshness: portfolioFreshness,
    complete: portfolioComplete,
    reasonCodes: portfolioReasonCodes,
    label: "净资产",
  });
  const totalCash = accountMoneyFact({
    source: portfolioSource, tool: portfolioTool,
    metric: "portfolio.total_cash",
    rawField: "account.totalCash",
    value: portfolio?.account?.totalCash,
    currency: baseCurrency,
    effectiveAt: portfolioAt,
    ageMs: portfolioAgeMs,
    freshness: portfolioFreshness,
    complete: portfolioComplete,
    reasonCodes: portfolioReasonCodes,
    label: "现金",
  });
  const buyPower = accountMoneyFact({
    source: portfolioSource, tool: portfolioTool,
    metric: "portfolio.buy_power",
    rawField: "account.buyPower",
    value: portfolio?.account?.buyPower,
    currency: baseCurrency,
    effectiveAt: portfolioAt,
    ageMs: portfolioAgeMs,
    freshness: portfolioFreshness,
    complete: portfolioComplete,
    reasonCodes: portfolioReasonCodes,
    label: "购买力",
  });
  const grossMarketValue = accountMoneyFact({
    source: portfolioSource, tool: portfolioTool,
    metric: "portfolio.positions_gross_market_value",
    rawField: "totals.positionsGrossMarketValueBase",
    value: portfolio?.totals?.positionsGrossMarketValueBase,
    currency: baseCurrency,
    effectiveAt: portfolioAt,
    ageMs: portfolioAgeMs,
    freshness: portfolioFreshness,
    complete: portfolioComplete && !derivativeRiskIncomplete,
    reasonCodes: exposureReasonCodes,
    label: hasOptions ? "持仓毛市值（含期权权利金，非 Delta 敞口）" : "持仓毛市值",
  });
  observed.push(netAssets, totalCash, buyPower, grossMarketValue);

  const riskBudget = observedFact({
    metric: "policy.risk_budget_percent",
    value: risk?.riskBudgetPercent,
    unit: { kind: "percent_point", basis: "portfolio_net_assets" },
    effectiveAt: generatedAt,
    source: "user_or_policy_setting",
    tool: "local:risk-policy",
    rawFields: ["risk.riskBudgetPercent"],
    methodVersion: "risk-policy/v1",
    freshness: "fresh",
    ageMs: 0,
    complete: true,
    label: "单笔风险预算",
  });
  observed.push(riskBudget);

  if (target?.symbol || technical?.lastPrice != null) {
    const symbol = String(target?.symbol ?? technical?.symbol ?? "UNKNOWN").toUpperCase();
    const marketSourceAt = validIsoOrNull(
      technical?.asOf ?? technical?.marketData?.fetchedAt,
    );
    const marketAt = marketSourceAt ?? generatedAt;
    const marketTimestampKnown = marketSourceAt != null;
    const marketReasonCodes = [
      ...(technical?.marketData?.reasonCodes ?? []),
      ...(marketTimestampKnown ? [] : ["source_timestamp_missing"]),
    ];
    observed.push(observedFact({
      metric: "market.last_completed_close",
      factKey: symbol,
      value: technical?.lastPrice,
      unit: {
        kind: "price",
        currency: currencyCode(target?.currency, baseCurrency),
        symbol,
        tickSize: null,
      },
      effectiveAt: marketAt,
      retrievedAt: validIsoOrNull(technical?.marketData?.fetchedAt) ?? generatedAt,
      tradingDate: validTradingDateOrNull(technical?.asOfTradingDate),
      session: "regular",
      source: "Longbridge market evidence",
      tool: "candlesticks",
      rawFields: ["technical.lastPrice"],
      methodVersion: technical?.dailySequence?.methodVersion ?? "daily-close/v1",
      freshness: !marketTimestampKnown
        ? "unknown"
        : technical?.marketData?.freshForSizing
        ? "live"
        : technical?.marketData?.freshForDecision
          ? "fresh"
          : technical?.marketData?.freshForResearch
            ? "cached"
            : "unknown",
      ageMs: safeAge(technical?.marketData?.cacheAgeMs),
      complete: marketTimestampKnown && (technical?.marketData
        ? technical.marketData.freshForDecision === true
        : technical?.lastPrice != null),
      reasonCodes: marketReasonCodes,
      label: `${symbol} 最近完成收盘价`,
    }));
  }

  derived.push(derivedPercentFact({
    metric: "portfolio.cash_ratio_percent",
    value: portfolio?.totals?.cashRatio,
    inputs: [totalCash, netAssets],
    formula: "total_cash / net_assets * 100",
    effectiveAt: portfolioAt,
    freshness: portfolioFreshness,
    ageMs: portfolioAgeMs,
    complete: portfolioComplete,
    reasonCodes: portfolioReasonCodes,
    label: "现金比例",
  }));
  derived.push(derivedPercentFact({
    metric: "portfolio.gross_exposure_percent",
    value: risk?.grossExposurePercent ?? risk?.portfolioConstraints?.grossExposurePercent,
    inputs: [grossMarketValue, netAssets],
    formula: "positions_gross_market_value / net_assets * 100",
    effectiveAt: portfolioAt,
    freshness: portfolioFreshness,
    ageMs: portfolioAgeMs,
    complete: portfolioComplete && !derivativeRiskIncomplete,
    reasonCodes: exposureReasonCodes,
    label: hasOptions ? "市值毛暴露（含期权权利金，非 Delta 敞口）" : "市值毛暴露",
  }));

  const facts = [...observed, ...derived];
  const numericPackage = {
    packageVersion: CORE_NUMERIC_EVIDENCE_PACKAGE_VERSION,
    schemaVersion: NUMERIC_EVIDENCE_SCHEMA_VERSION,
    status: facts.every((fact) => fact.availability === "known" && fact.quality.complete)
      ? "complete"
      : facts.some((fact) => fact.availability === "known")
        ? "partial"
        : "unavailable",
    facts,
    factCount: facts.length,
    knownCount: facts.filter((fact) => fact.availability === "known").length,
    invariants: {
      unknownIsNeverZero: true,
      percentageUnit: "percent_point",
      modelMayCreateHostDecision: false,
    },
  };
  return appendTechnicalNumericEvidence(numericPackage, { target, technical });
}

function accountMoneyFact(options) {
  return observedFact({
    ...options,
    unit: { kind: "money", currency: options.currency },
    source: options.source ?? "Longbridge normalized portfolio",
    tool: options.tool ?? "account_balance",
    rawFields: [options.rawField],
    methodVersion: "portfolio-valuation/v2",
  });
}

function observedFact({
  metric,
  factKey = null,
  value,
  unit,
  effectiveAt,
  retrievedAt = effectiveAt,
  tradingDate = null,
  session = "not_applicable",
  source,
  tool,
  rawFields,
  methodVersion,
  freshness,
  ageMs,
  complete,
  reasonCodes = [],
  label,
}) {
  const known = finiteValue(value);
  return createObservedFact({
    factId: `${metric}${factKey ? `.${factKey.toLowerCase()}` : ""}@${effectiveAt}`,
    metric,
    value: known ? value : null,
    availability: known ? "known" : "unknown",
    unit,
    asOf: {
      effectiveAt,
      retrievedAt,
      tradingDate,
      session,
      timeZone: "UTC",
    },
    provenance: {
      source,
      tool,
      sourceRecordId: null,
      rawFields,
      inputRefs: [],
      formula: null,
      methodVersion,
    },
    quality: {
      freshness: known ? freshness : "unknown",
      ageMs: known ? ageMs : null,
      complete: known && Boolean(complete),
      confidence: known ? "not_applicable" : "unknown",
      reasonCodes: known
        ? [...new Set(reasonCodes.map(String))]
        : [...new Set(["source_value_missing", ...reasonCodes.map(String)])],
    },
    display: { precision: 2, label },
  });
}

function derivedPercentFact({
  metric,
  value,
  inputs,
  formula,
  effectiveAt,
  freshness,
  ageMs,
  complete,
  reasonCodes = [],
  label,
}) {
  const known = finiteValue(value) && inputs.every((input) => input.availability === "known");
  return createDerivedMetric({
    factId: `${metric}@${effectiveAt}`,
    metric,
    value: known ? value : null,
    availability: known ? "known" : "unknown",
    unit: { kind: "percent_point", basis: "portfolio_net_assets" },
    asOf: {
      effectiveAt,
      retrievedAt: effectiveAt,
      tradingDate: null,
      session: "not_applicable",
      timeZone: "UTC",
    },
    provenance: {
      source: "local deterministic risk engine",
      tool: "local:portfolio-risk",
      sourceRecordId: null,
      rawFields: [],
      inputRefs: inputs.map(numericEvidenceRef),
      formula,
      methodVersion: "portfolio-risk/v2",
    },
    quality: {
      freshness: known ? freshness : "unknown",
      ageMs: known ? ageMs : null,
      complete: known && Boolean(complete),
      confidence: known ? "high" : "unknown",
      reasonCodes: known
        ? [...new Set(reasonCodes.map(String))]
        : [...new Set(["required_numeric_input_missing", ...reasonCodes.map(String)])],
    },
    display: { precision: 2, label },
  });
}

function finiteValue(value) {
  return value != null && typeof value !== "boolean" && String(value).trim() !== ""
    && Number.isFinite(Number(value));
}

function validIsoOrNull(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function safeAge(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

function currencyCode(value, fallback) {
  const code = String(value ?? fallback ?? "USD").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : String(fallback ?? "USD").toUpperCase();
}

function validTradingDateOrNull(value) {
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}
