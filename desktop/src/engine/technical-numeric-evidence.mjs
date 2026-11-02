import {
  createDerivedMetric,
  numericEvidenceRef,
  validateNumericEvidence,
} from "./numeric-evidence.mjs";

export const TECHNICAL_NUMERIC_EVIDENCE_VERSION = "technical-numeric-evidence/v1";

/**
 * Append host-computed technical values to an existing Numeric Evidence
 * package. Only finite, lineage-bound values are added; unavailable inputs are
 * omitted rather than converted to zero. The full source-series hash remains
 * in sourceRecordId while the last completed close is the package lineage
 * root shared with the Agent turn.
 */
export function appendTechnicalNumericEvidence(
  numericPackage,
  { target = null, technical = null } = {},
) {
  if (!numericPackage || !Array.isArray(numericPackage.facts) || !technical) {
    return numericPackage;
  }
  const existing = numericPackage.facts.map(validateNumericEvidence);
  const closeFact = existing.find((fact) => (
    fact.metric === "market.last_completed_close" && fact.availability === "known"
  ));
  if (!closeFact) return numericPackage;

  const symbol = String(target?.symbol ?? technical?.symbol ?? closeFact.unit?.symbol ?? "UNKNOWN")
    .trim().toUpperCase().slice(0, 80) || "UNKNOWN";
  const currency = currencyCode(target?.currency ?? closeFact.unit?.currency, "USD");
  const effectiveAt = closeFact.asOf.effectiveAt;
  const retrievedAt = closeFact.asOf.retrievedAt;
  const tradingDate = closeFact.asOf.tradingDate;
  const closeRef = numericEvidenceRef(closeFact);
  const appended = [];

  const addPrice = ({ metric, value, label, tool, formula, methodVersion, sourceRecordId, confidence, reasonCodes, refs = [closeRef] }) => {
    if (!finite(value)) return null;
    const fact = createDerivedMetric({
      factId: `${metric}.${symbol.toLowerCase()}@${effectiveAt}`,
      metric,
      value,
      availability: "known",
      unit: { kind: "price", currency, symbol, tickSize: null },
      asOf: { effectiveAt, retrievedAt, tradingDate, session: "regular", timeZone: "UTC" },
      provenance: {
        source: "local deterministic technical engine",
        tool,
        sourceRecordId: sourceRecordId ? String(sourceRecordId).slice(0, 240) : null,
        rawFields: [],
        inputRefs: refs,
        formula,
        methodVersion,
      },
      quality: {
        freshness: closeFact.quality.freshness,
        ageMs: closeFact.quality.ageMs,
        complete: closeFact.quality.complete === true,
        confidence,
        reasonCodes: [...new Set([
          ...(closeFact.quality.reasonCodes ?? []),
          ...reasonCodes,
        ])],
      },
      display: { precision: 4, label },
    });
    appended.push(fact);
    return fact;
  };
  const addPercent = ({ metric, value, label, basis, tool, formula, methodVersion, sourceRecordId, confidence, reasonCodes, refs = [closeRef] }) => {
    if (!finite(value)) return null;
    const fact = createDerivedMetric({
      factId: `${metric}.${symbol.toLowerCase()}@${effectiveAt}`,
      metric,
      value,
      availability: "known",
      unit: { kind: "percent_point", basis },
      asOf: { effectiveAt, retrievedAt, tradingDate, session: "regular", timeZone: "UTC" },
      provenance: {
        source: "local deterministic technical engine",
        tool,
        sourceRecordId: sourceRecordId ? String(sourceRecordId).slice(0, 240) : null,
        rawFields: [],
        inputRefs: refs,
        formula,
        methodVersion,
      },
      quality: {
        freshness: closeFact.quality.freshness,
        ageMs: closeFact.quality.ageMs,
        complete: closeFact.quality.complete === true,
        confidence,
        reasonCodes: [...new Set([
          ...(closeFact.quality.reasonCodes ?? []),
          ...reasonCodes,
        ])],
      },
      display: { precision: 4, label },
    });
    appended.push(fact);
    return fact;
  };

  const dailyInputHash = technical?.dailySequence?.inputHash
    ?? technical?.technicalV2?.costProfile14d28d?.input?.inputHash
    ?? null;
  for (const period of [3, 5, 8, 13, 21, 144, 169]) {
    const value = technical?.ema?.[period];
    if (!finite(value)) continue;
    const maturity = technical?.emaMaturity?.[period] ?? null;
    const mature = maturity?.mature === true;
    const maturityReason = maturity?.mature === false
      ? "ema_available_but_not_mature" : "ema_maturity_unavailable";
    addPrice({
      metric: `technical.ema_${period}_price`,
      value,
      label: `EMA${period}`,
      tool: "local:ema",
      formula: `SMA-seeded EMA(${period}) over completed regular-session closes`,
      methodVersion: technical?.emaMethod?.methodVersion ?? "ema-sma-seed/v1",
      sourceRecordId: dailyInputHash,
      confidence: mature ? "high" : "medium",
      reasonCodes: mature ? [] : [maturityReason],
    });
  }

  const automaticFib = technical?.fib;
  if (automaticFib?.levels && automaticFib?.anchors) {
    for (const ratio of [0.382, 0.618, 1, 1.618]) {
      const suffix = String(ratio).replace(".", "_");
      addPrice({
        metric: `technical.auto_fib_${suffix}_price`,
        value: automaticFib.levels?.[String(ratio)],
        label: `自动 Fib ${ratio}`,
        tool: "local:fibonacci",
        formula: `C + (B - A) * ${ratio}`,
        methodVersion: automaticFib.methodVersion ?? "fibonacci-extension/v1",
        sourceRecordId: dailyInputHash,
        confidence: "low",
        reasonCodes: ["automatic_anchor_advisory_only", "llm_must_select_before_sizing_use"],
      });
    }
  }

  const cost = technical?.technicalV2?.costProfile14d28d;
  const costHash = cost?.input?.inputHash ?? null;
  for (const window of [14, 28]) {
    const profile = cost?.profiles?.[String(window)];
    if (profile?.status !== "available") continue;
    for (const [key, suffix, label] of [
      ["poc", "poc_price", `${window}日 POC 代理`],
      ["val", "val_price", `${window}日 VAL 代理`],
      ["vah", "vah_price", `${window}日 VAH 代理`],
    ]) {
      addPrice({
        metric: `technical.cost_profile_${window}_${suffix}`,
        value: profile[key],
        label,
        tool: "local:daily-cost-concentration-proxy",
        formula: `uniform-range daily OHLCV volume allocation into ${cost.configuration?.bins ?? 80} bins; ${key}`,
        methodVersion: cost.methodVersion ?? "daily-cost-concentration-v1",
        sourceRecordId: costHash,
        confidence: "low",
        reasonCodes: [
          "daily_ohlcv_proxy_not_holder_cost_basis",
          "uniform_range_volume_allocation",
        ],
      });
    }
  }
  if (cost?.comparison?.status === "available") {
    addPercent({
      metric: "technical.cost_profile_14_vs_28_poc_shift_percent",
      value: cost.comparison.pocShiftPercentOfLongPoc,
      label: "14日相对28日 POC 位移",
      basis: "28_session_daily_ohlcv_proxy_poc",
      tool: "local:daily-cost-concentration-proxy",
      formula: "(poc_14 - poc_28) / poc_28 * 100",
      methodVersion: cost.methodVersion ?? "daily-cost-concentration-v1",
      sourceRecordId: costHash,
      confidence: "low",
      reasonCodes: [
        "daily_ohlcv_proxy_not_holder_cost_basis",
        "uniform_range_volume_allocation",
      ],
    });
  }

  const relative = technical?.benchmarkRelativeStrength?.excessReturns;
  for (const window of [1, 3, 5, 10, 20]) {
    const metric = relative?.windows?.[String(window)];
    if (metric?.status !== "available") continue;
    addPercent({
      metric: `technical.qqq_excess_return_${window}d_percent`,
      value: metric.value,
      label: `${window}日相对 QQQ 超额收益`,
      basis: "target_simple_return_minus_qqq_simple_return_same_trade_dates",
      tool: "local:benchmark-relative-strength",
      formula: "target simple return percent - QQQ simple return percent on identical endpoints",
      methodVersion: relative.methodVersion ?? "daily-sequence-v1",
      sourceRecordId: relative.inputHash,
      confidence: technical?.benchmarkRelativeStrength?.status === "complete" ? "high" : "medium",
      reasonCodes: ["same_trade_date_alignment_no_forward_fill"],
    });
  }

  const avwapReview = technical?.technicalV2?.anchoredVwap;
  const avwap = avwapReview?.hostVerified === true && avwapReview?.status === "selected"
    ? avwapReview.evidence
    : null;
  if (avwap) {
    const anchorConfidence = ["high", "medium", "low"].includes(avwapReview.confidence)
      ? avwapReview.confidence
      : "unknown";
    const avwapFact = addPrice({
      metric: "technical.host_verified_anchored_vwap_price",
      value: avwap.vwap,
      label: "宿主核验 AVWAP",
      tool: "local:anchored-vwap",
      formula: avwap.method?.formula ?? "sum(HLC3 * volume) / sum(volume)",
      methodVersion: avwap.methodVersion ?? "anchored-vwap-hlc3-volume/v1",
      sourceRecordId: avwap.inputHash,
      confidence: anchorConfidence,
      reasonCodes: ["host_verified_calculation_advisory_anchor_semantics", "no_sizing_authority"],
    });
    if (avwapFact) {
      addPercent({
        metric: "technical.close_distance_from_anchored_vwap_percent",
        value: avwap.priceRelation?.differencePercent,
        label: "收盘价相对 AVWAP 距离",
        basis: "host_verified_anchored_vwap",
        tool: "local:anchored-vwap",
        formula: "(as_of_close - anchored_vwap) / anchored_vwap * 100",
        methodVersion: avwap.methodVersion ?? "anchored-vwap-hlc3-volume/v1",
        sourceRecordId: avwap.inputHash,
        confidence: anchorConfidence,
        reasonCodes: ["host_verified_calculation_advisory_anchor_semantics", "no_sizing_authority"],
        refs: [closeRef, numericEvidenceRef(avwapFact)],
      });
    }
  }

  if (!appended.length) return numericPackage;
  const merged = new Map(existing.map((fact) => [fact.factId, fact]));
  for (const fact of appended) merged.set(fact.factId, fact);
  const facts = [...merged.values()];
  return {
    ...numericPackage,
    facts,
    factCount: facts.length,
    knownCount: facts.filter((fact) => fact.availability === "known").length,
    status: facts.every((fact) => fact.availability === "known" && fact.quality.complete)
      ? "complete"
      : facts.some((fact) => fact.availability === "known")
        ? "partial"
        : "unavailable",
    invariants: {
      ...(numericPackage.invariants ?? {}),
      technicalFactsHostComputed: true,
      unavailableTechnicalValueIsNeverZero: true,
    },
  };
}

function finite(value) {
  return value != null
    && typeof value !== "boolean"
    && String(value).trim() !== ""
    && Number.isFinite(Number(value));
}

function currencyCode(value, fallback) {
  const code = String(value ?? fallback ?? "USD").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : String(fallback ?? "USD").toUpperCase();
}
