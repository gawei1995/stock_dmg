import { createHash } from "node:crypto";

import { buildAnchoredVwapEvidence } from "./anchored-vwap.mjs";
import { calculateDailyExcessReturns } from "./daily-sequence.mjs";
import { assessDailyCandleEvidence } from "./market-evidence.mjs";
import {
  NUMERIC_EVIDENCE_SCHEMA_VERSION,
  createDerivedMetric,
  createObservedFact,
  numericEvidenceRef,
} from "./numeric-evidence.mjs";
import { calculateTechnical } from "./technical.mjs";
import { buildTechnicalV2 } from "./technical-v2.mjs";

export const TIER_B_TECHNICAL_EVIDENCE_SCHEMA_VERSION = "tier-b-technical-evidence/v1";
export const TIER_B_TECHNICAL_EVIDENCE_MAX_DAILY_BARS = 2_000;
export const TIER_B_TECHNICAL_EVIDENCE_MAX_WEEKLY_BARS = 520;
export const TIER_B_TECHNICAL_EVIDENCE_MAX_60M_BARS = 2_000;
export const TIER_B_TECHNICAL_EVIDENCE_MAX_OPTION_ROWS = 2_000;
export const TIER_B_TECHNICAL_EVIDENCE_MIN_PEERS = 2;
export const TIER_B_TECHNICAL_EVIDENCE_MAX_PEERS = 5;

const LAYER_NAMES = Object.freeze([
  "daily",
  "weekly",
  "benchmark",
  "execution60m",
  "sector",
  "peers",
  "anchoredVwap",
  "options",
  "catalyst",
]);
const FORMING_STATES = new Set([
  "forming",
  "open",
  "partial",
  "updating",
  "realtime",
  "live",
]);

export class TierBTechnicalEvidenceInputError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TierBTechnicalEvidenceInputError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Build a deterministic selected-symbol evidence envelope without fetching,
 * choosing an AVWAP anchor, interpreting options positioning, or producing a
 * trade decision.
 *
 * Every OHLCV layer uses the explicit descriptor contract:
 *   { bars, interval: "1D" | "1W" | "60m", completedBarsOnly: true,
 *     source, fetchedAt?, coverage? }
 *
 * `cutoffTradingDate` is the exact shared daily cutoff. Comparative daily
 * layers must contain that date; prior values are never forward-filled.
 * `knowledgeCutoffAt` gates 60m, option, and catalyst evidence.
 */
export function buildTierBTechnicalEvidence({
  symbol,
  currency = null,
  cutoffTradingDate,
  knowledgeCutoffAt = null,
  horizon = "swing",
  daily = null,
  weekly = null,
  intraday60m = null,
  benchmark = null,
  sector = null,
  peers = [],
  anchoredVwap = null,
  options = null,
  catalysts = null,
} = {}) {
  const targetSymbol = normalizeSymbol(symbol, "symbol");
  const cutoff = normalizeTradingDate(cutoffTradingDate);
  const cutoffAt = normalizeKnowledgeCutoff(knowledgeCutoffAt, cutoff);
  if (cutoffAt.slice(0, 10) !== cutoff) {
    throw inputError(
      "knowledge_cutoff_date_mismatch",
      "knowledgeCutoffAt must be on cutoffTradingDate so all layers share one point-in-time boundary.",
      { cutoffTradingDate: cutoff, knowledgeCutoffAt: cutoffAt },
    );
  }
  const normalizedCurrency = normalizeCurrency(currency, targetSymbol);
  const normalizedHorizon = normalizeHorizon(horizon);

  const targetDaily = normalizeSeries(daily, {
    layer: "daily",
    symbol: targetSymbol,
    interval: "1D",
    cutoffTradingDate: cutoff,
    cutoffAt,
    exactDailyCutoff: true,
    maxBars: TIER_B_TECHNICAL_EVIDENCE_MAX_DAILY_BARS,
  });
  const targetWeekly = normalizeSeries(weekly, {
    layer: "weekly",
    symbol: targetSymbol,
    interval: "1W",
    cutoffTradingDate: cutoff,
    cutoffAt,
    exactDailyCutoff: false,
    maxBars: TIER_B_TECHNICAL_EVIDENCE_MAX_WEEKLY_BARS,
  });
  const target60m = normalizeSeries(intraday60m, {
    layer: "execution60m",
    symbol: targetSymbol,
    interval: "60m",
    cutoffTradingDate: cutoff,
    cutoffAt,
    exactDailyCutoff: false,
    maxBars: TIER_B_TECHNICAL_EVIDENCE_MAX_60M_BARS,
  });

  const benchmarkSymbol = benchmark == null
    ? "QQQ.US"
    : normalizeSymbol(benchmark.symbol ?? "QQQ.US", "benchmark.symbol");
  if (benchmarkSymbol !== "QQQ.US") {
    throw inputError(
      "benchmark_must_be_qqq",
      "Tier-B growth/technology evidence requires the explicit QQQ.US benchmark layer.",
      { benchmarkSymbol },
    );
  }
  const benchmarkDaily = normalizeSeries(benchmark?.daily ?? null, {
    layer: "benchmark",
    symbol: benchmarkSymbol,
    interval: "1D",
    cutoffTradingDate: cutoff,
    cutoffAt,
    exactDailyCutoff: true,
    maxBars: TIER_B_TECHNICAL_EVIDENCE_MAX_DAILY_BARS,
  });

  const normalizedSector = normalizeRelatedDailyLayer(sector, {
    label: "sector",
    cutoffTradingDate: cutoff,
    cutoffAt,
  });
  const normalizedPeers = normalizePeerLayers(peers, {
    targetSymbol,
    sectorSymbol: normalizedSector.symbol,
    cutoffTradingDate: cutoff,
    cutoffAt,
  });

  const dailyTechnical = targetDaily.usable
    ? calculateTechnical(targetDaily.bars, {
        symbol: targetSymbol,
        analysisTime: cutoffAt,
        coverage: targetDaily.coverage,
      })
    : null;
  const dailyMarketEvidence = dailyTechnical
    ? assessDailyCandleEvidence({
        coverage: targetDaily.coverage,
        technical: dailyTechnical,
        symbol: targetSymbol,
        analysisTime: cutoffAt,
      })
    : null;
  const multiTimeframe = buildTechnicalV2({
    dailyTechnical,
    dailyCompletedBars: targetDaily.usable ? targetDaily.bars : null,
    // Explicit empty sentinel prevents silent weekly derivation when absent.
    weekly: targetWeekly.provided
      ? descriptorForTechnicalV2(targetWeekly)
      : missingExplicitLayerDescriptor("1W", "tier_b_explicit_weekly_not_provided"),
    intraday60m: target60m.provided
      ? descriptorForTechnicalV2(target60m)
      : null,
    horizon: normalizedHorizon,
  });

  const benchmarkRelative = buildRelativeCalculation(targetDaily, benchmarkDaily, "benchmark");
  const sectorRelative = buildRelativeCalculation(targetDaily, normalizedSector.daily, "sector");
  const peerRelative = buildPeerRelativeCalculations(targetDaily, normalizedPeers);
  const anchored = buildExplicitAnchoredVwap({
    request: anchoredVwap,
    daily: targetDaily,
    intraday60m: target60m,
  });
  const optionEvidence = normalizeOptions(options, {
    symbol: targetSymbol,
    cutoffTradingDate: cutoff,
    cutoffAt,
  });
  const optionCalculation = calculateOptions(optionEvidence);
  const catalystEvidence = normalizeCatalysts(catalysts, {
    cutoffTradingDate: cutoff,
    cutoffAt,
  });
  const catalystCalculation = calculateCatalystSummary(catalystEvidence, cutoffAt);

  const observedEvidence = {
    daily: observedSeries(targetDaily),
    weekly: observedSeries(targetWeekly),
    benchmark: observedSeries(benchmarkDaily),
    execution60m: observedSeries(target60m),
    sector: { symbol: normalizedSector.symbol, ...observedSeries(normalizedSector.daily) },
    peers: {
      status: peerObservedStatus(normalizedPeers),
      reasonCodes: peerObservedReasons(normalizedPeers),
      asOf: latestIso(normalizedPeers.map((peer) => peer.daily.asOf)),
      inputHash: hashCanonical(normalizedPeers.map((peer) => ({
        symbol: peer.symbol,
        inputHash: peer.daily.inputHash,
      }))),
      count: normalizedPeers.length,
      items: normalizedPeers.map((peer) => ({ symbol: peer.symbol, ...observedSeries(peer.daily) })),
      requiredRange: [TIER_B_TECHNICAL_EVIDENCE_MIN_PEERS, TIER_B_TECHNICAL_EVIDENCE_MAX_PEERS],
    },
    anchoredVwap: anchored.observed,
    options: optionEvidence.observed,
    catalyst: catalystEvidence.observed,
  };

  const calculatedEvidence = {
    daily: dailyTechnical ?? unavailableValue(targetDaily.reasonCodes),
    dailyMarketEvidence: dailyMarketEvidence ?? unavailableValue(targetDaily.reasonCodes),
    multiTimeframe,
    benchmarkRelativeStrength: benchmarkRelative.value,
    sectorRelativeStrength: sectorRelative.value,
    peerRelativeStrength: peerRelative.value,
    anchoredVwap: anchored.calculated,
    options: optionCalculation.value,
    catalyst: catalystCalculation.value,
  };

  const observedCapabilities = {
    daily: capabilityFromSeries(targetDaily, "observed"),
    weekly: capabilityFromSeries(targetWeekly, "observed"),
    benchmark: capabilityFromSeries(benchmarkDaily, "observed"),
    execution60m: capabilityFromSeries(target60m, "observed"),
    sector: capabilityFromSeries(normalizedSector.daily, "observed"),
    peers: makeCapability({
      evidenceClass: "observed",
      status: observedEvidence.peers.status,
      reasonCodes: observedEvidence.peers.reasonCodes,
      asOf: observedEvidence.peers.asOf,
      hash: observedEvidence.peers.inputHash,
      method: "caller_supplied_completed_daily_peer_series",
    }),
    anchoredVwap: anchored.observedCapability,
    options: optionEvidence.capability,
    catalyst: catalystEvidence.capability,
  };
  const calculatedCapabilities = {
    daily: calculatedDailyCapability(dailyTechnical, targetDaily),
    weekly: calculatedTechnicalV2Capability(
      multiTimeframe.capabilityMatrix.weeklyStructure,
      targetWeekly,
      "weekly_structure",
      multiTimeframe.weekly,
    ),
    benchmark: benchmarkRelative.capability,
    execution60m: calculatedTechnicalV2Capability(
      multiTimeframe.capabilityMatrix.execution60m,
      target60m,
      "closed_60m_ema_ribbon",
      multiTimeframe.execution60m,
    ),
    sector: sectorRelative.capability,
    peers: peerRelative.capability,
    anchoredVwap: anchored.calculatedCapability,
    options: optionCalculation.capability,
    catalyst: catalystCalculation.capability,
  };
  const inferenceCapabilities = buildInferenceCapabilities({ calculatedCapabilities });

  const numeric = buildNumericEvidenceIndex({
    symbol: targetSymbol,
    currency: normalizedCurrency,
    cutoffTradingDate: cutoff,
    cutoffAt,
    targetDaily,
    benchmarkDaily,
    sector: normalizedSector,
    peers: normalizedPeers,
    benchmarkRelative,
    sectorRelative,
    peerRelative,
    anchored,
    optionEvidence,
    optionCalculation,
    catalystEvidence,
  });

  const layers = Object.fromEntries(LAYER_NAMES.map((name) => [name, layerIndex({
    observed: observedCapabilities[name],
    calculated: calculatedCapabilities[name],
    inference: inferenceCapabilities[name],
  })]));
  const inputHash = hashCanonical({
    schemaVersion: TIER_B_TECHNICAL_EVIDENCE_SCHEMA_VERSION,
    symbol: targetSymbol,
    currency: normalizedCurrency,
    cutoffTradingDate: cutoff,
    knowledgeCutoffAt: cutoffAt,
    horizon: normalizedHorizon,
    observedHashes: Object.fromEntries(LAYER_NAMES.map((name) => [
      name,
      observedCapabilities[name].hash,
    ])),
  });
  const status = overallStatus(layers);
  const body = {
    schemaVersion: TIER_B_TECHNICAL_EVIDENCE_SCHEMA_VERSION,
    status,
    symbol: targetSymbol,
    currency: normalizedCurrency,
    cutoff: {
      tradingDate: cutoff,
      knowledgeCutoffAt: cutoffAt,
      dailyPolicy: "exact_shared_trade_date_no_forward_fill",
      intradayPolicy: "completed_bar_timestamp_at_or_before_knowledge_cutoff",
      futureDataPolicy: "excluded_before_hash_and_calculation",
    },
    horizon: normalizedHorizon,
    inputHash,
    layers,
    observed: {
      capabilities: observedCapabilities,
      evidence: observedEvidence,
      numericEvidence: numeric.observed,
    },
    calculated: {
      capabilities: calculatedCapabilities,
      evidence: calculatedEvidence,
      numericEvidence: numeric.calculated,
    },
    inference: {
      generated: false,
      capabilities: inferenceCapabilities,
      outputs: {
        dealerGamma: unavailableValue([
          "dealer_gamma_not_inferred_from_open_interest",
          "sourced_positioning_model_not_supplied",
        ]),
        tradeSignal: unavailableValue(["evidence_module_does_not_generate_trade_signal"]),
        positionSize: unavailableValue(["evidence_module_has_no_position_sizing_authority"]),
      },
      advisory: true,
      decisionAuthority: "LLM",
    },
    invariants: {
      completedBarsOnly: true,
      exactSharedDailyCutoff: true,
      noForwardFill: true,
      futureEvidenceExcluded: true,
      missingNumericEvidenceIsNullNotZero: true,
      avwapAnchorSelection: "caller_or_event_explicit_only",
      openInterestDoesNotImplyDealerGamma: true,
      llmUsed: false,
      tradingSignalGenerated: false,
    },
    limitations: [
      "Observed evidence, deterministic calculations, and inference capability are separate; no model reasoning or trade decision is included.",
      "Daily cost concentration remains the existing daily-OHLCV uniform-range proxy, not holder cost basis.",
      "Relative returns are same-date simple differences, not model-estimated alpha or causality.",
      "Raw option open interest and volume do not identify long/short direction, opening/closing activity, or dealer gamma.",
      "Catalyst facts are admitted only by knownAt; truth, materiality, and narrative meaning remain source and LLM responsibilities.",
    ],
  };
  return deepFreeze({ ...body, outputHash: hashCanonical(body) });
}

function normalizeSeries(descriptor, {
  layer,
  symbol,
  interval,
  cutoffTradingDate,
  cutoffAt,
  exactDailyCutoff,
  maxBars,
}) {
  if (descriptor == null) {
    return unavailableSeries({
      layer,
      symbol,
      interval,
      provided: false,
      reasonCodes: ["input_not_provided"],
      cutoffTradingDate,
    });
  }
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    return unavailableSeries({
      layer,
      symbol,
      interval,
      provided: true,
      reasonCodes: ["layer_descriptor_invalid"],
      cutoffTradingDate,
    });
  }
  const declaredInterval = normalizeInterval(descriptor.interval ?? descriptor.timeframe);
  const source = textOrNull(descriptor.source);
  const reasons = [];
  if (!Array.isArray(descriptor.bars)) reasons.push("bars_not_array");
  if (descriptor.completedBarsOnly !== true) reasons.push("completed_bars_not_explicitly_attested");
  if (declaredInterval !== interval) reasons.push("declared_interval_mismatch");
  if (!source) reasons.push("source_missing");
  if (Array.isArray(descriptor.bars) && descriptor.bars.length > maxBars) {
    reasons.push("bar_limit_exceeded");
  }
  if (reasons.length) {
    return unavailableSeries({
      layer,
      symbol,
      interval,
      provided: true,
      reasonCodes: reasons,
      cutoffTradingDate,
      source,
    });
  }

  try {
    const eligible = [];
    let ignoredAfterCutoffCount = 0;
    let previousSortTime = null;
    for (const [index, raw] of descriptor.bars.entries()) {
      const identity = barIdentity(raw, interval, index, layer);
      if (previousSortTime != null && identity.sortTime <= previousSortTime) {
        throw inputError(
          "bars_not_strictly_ascending",
          `${layer} bars must be strictly ascending and unique.`,
          { layer, index },
        );
      }
      previousSortTime = identity.sortTime;
      const afterCutoff = interval === "1D"
        ? identity.tradeDate > cutoffTradingDate
        : identity.sortTime > Date.parse(cutoffAt);
      if (afterCutoff) {
        ignoredAfterCutoffCount += 1;
        continue;
      }
      eligible.push(normalizeBar(raw, identity, { layer, index, symbol }));
    }
    if (!eligible.length) {
      return unavailableSeries({
        layer,
        symbol,
        interval,
        provided: true,
        reasonCodes: ["no_completed_bars_at_or_before_cutoff"],
        cutoffTradingDate,
        source,
        ignoredAfterCutoffCount,
      });
    }
    if (exactDailyCutoff && eligible.at(-1).tradeDate !== cutoffTradingDate) {
      return unavailableSeries({
        layer,
        symbol,
        interval,
        provided: true,
        reasonCodes: ["exact_cutoff_bar_missing_no_forward_fill"],
        cutoffTradingDate,
        source,
        bars: eligible,
        ignoredAfterCutoffCount,
      });
    }
    const coverage = normalizedCoverage(descriptor, eligible, {
      source,
      cutoffTradingDate,
    });
    const partialReasons = unique([
      ...(coverage.partialReasons ?? []),
      ...(coverage.partial === true ? ["source_coverage_partial"] : []),
    ]);
    const inputHash = hashCanonical({
      symbol,
      interval,
      cutoffTradingDate,
      source,
      bars: eligible.map(hashableBar),
      coverage: hashableCoverage(coverage),
    });
    return {
      layer,
      symbol,
      interval,
      provided: true,
      usable: true,
      status: partialReasons.length ? "partial" : "available",
      reasonCodes: partialReasons,
      bars: eligible,
      barCount: eligible.length,
      source,
      asOf: eligible.at(-1).timestamp,
      inputHash,
      coverage,
      ignoredAfterCutoffCount,
      cutoffTradingDate,
    };
  } catch (error) {
    return unavailableSeries({
      layer,
      symbol,
      interval,
      provided: true,
      reasonCodes: [String(error?.code ?? "invalid_ohlcv_input")],
      cutoffTradingDate,
      source,
    });
  }
}

function unavailableSeries({
  layer,
  symbol,
  interval,
  provided,
  reasonCodes,
  cutoffTradingDate,
  source = null,
  bars = [],
  ignoredAfterCutoffCount = 0,
}) {
  const reasons = unique(reasonCodes);
  return {
    layer,
    symbol,
    interval,
    provided,
    usable: false,
    status: "unavailable",
    reasonCodes: reasons,
    bars,
    barCount: 0,
    source,
    asOf: null,
    inputHash: hashCanonical({
      symbol,
      interval,
      cutoffTradingDate,
      source,
      status: "unavailable",
      reasonCodes: reasons,
    }),
    coverage: null,
    ignoredAfterCutoffCount,
    cutoffTradingDate,
  };
}

function barIdentity(value, interval, index, layer) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw inputError("bar_not_object", `${layer} bar ${index + 1} must be an object.`);
  }
  const rawTradeDate = String(
    value.tradeDate ?? value.trade_date ?? value.date ?? "",
  ).trim();
  const parsedTimestamp = validIso(value.timestamp ?? value.time);
  if (interval === "1D") {
    const tradeDate = /^\d{4}-\d{2}-\d{2}$/.test(rawTradeDate)
      ? normalizeTradingDate(rawTradeDate)
      : parsedTimestamp?.slice(0, 10) ?? null;
    if (!tradeDate) throw inputError("bar_time_invalid", `${layer} bar ${index + 1} has no valid trade date.`);
    return {
      tradeDate,
      timestamp: parsedTimestamp ?? `${tradeDate}T00:00:00.000Z`,
      sortTime: Date.parse(`${tradeDate}T00:00:00.000Z`),
    };
  }
  if (!parsedTimestamp) {
    throw inputError("bar_time_invalid", `${layer} bar ${index + 1} has no valid timestamp.`);
  }
  return {
    tradeDate: /^\d{4}-\d{2}-\d{2}$/.test(rawTradeDate)
      ? normalizeTradingDate(rawTradeDate)
      : parsedTimestamp.slice(0, 10),
    timestamp: parsedTimestamp,
    sortTime: Date.parse(parsedTimestamp),
  };
}

function normalizeBar(value, identity, { layer, index, symbol }) {
  if (isExplicitlyForming(value)) {
    throw inputError("forming_bar_not_allowed", `${layer} bar ${index + 1} is explicitly forming.`);
  }
  const open = requiredFinite(value.open, `${layer}.${index}.open`);
  const high = requiredFinite(value.high, `${layer}.${index}.high`);
  const low = requiredFinite(value.low, `${layer}.${index}.low`);
  const close = requiredFinite(value.close, `${layer}.${index}.close`);
  const volume = requiredFinite(value.volume, `${layer}.${index}.volume`);
  if ([open, high, low, close].some((number) => number <= 0)) {
    throw inputError("non_positive_price", `${layer} bar ${index + 1} has a non-positive price.`);
  }
  if (volume < 0 || high < low || open < low || open > high || close < low || close > high) {
    throw inputError("invalid_ohlcv", `${layer} bar ${index + 1} has invalid OHLCV bounds.`);
  }
  return {
    barId: textOrNull(value.barId ?? value.bar_id ?? value.id) ?? identity.timestamp,
    timestamp: identity.timestamp,
    tradeDate: identity.tradeDate,
    timestampBasis: textOrNull(value.timestampBasis ?? value.timestamp_basis),
    symbol,
    market: textOrNull(value.market) ?? marketFromSymbol(symbol),
    open,
    high,
    low,
    close,
    volume,
    tradeSession: textOrNull(value.tradeSession ?? value.trade_session) ?? "Intraday",
    isClosed: true,
  };
}

function normalizedCoverage(descriptor, bars, { source, cutoffTradingDate }) {
  const value = descriptor.coverage && typeof descriptor.coverage === "object"
    ? descriptor.coverage
    : {};
  const partialReasons = unique(Array.isArray(value.partialReasons) ? value.partialReasons : []);
  const partial = value.partial === true || partialReasons.length > 0;
  return {
    source,
    originSource: textOrNull(value.originSource),
    coverageStatus: partial ? "partial" : "complete",
    complete: !partial,
    partial,
    partialReasons,
    fetchedAt: validIso(descriptor.fetchedAt ?? value.fetchedAt),
    storedAt: validIso(value.storedAt),
    requestedCount: finiteIntegerOrNull(value.requestedCount),
    returnedCount: bars.length,
    latestTradeDate: cutoffTradingDate,
    endpoint: textOrNull(value.endpoint ?? descriptor.endpoint),
    period: textOrNull(value.period),
    adjustment: textOrNull(value.adjustment),
    tradeSessions: textOrNull(value.tradeSessions),
    refreshAttempted: value.refreshAttempted === true,
    fallbackReason: finiteJsonClone(value.fallbackReason),
    persistenceStatus: textOrNull(value.persistenceStatus),
  };
}

function normalizeRelatedDailyLayer(value, { label, cutoffTradingDate, cutoffAt }) {
  if (value == null) {
    return {
      symbol: null,
      daily: unavailableSeries({
        layer: label,
        symbol: null,
        interval: "1D",
        provided: false,
        reasonCodes: [`${label}_not_provided`],
        cutoffTradingDate,
      }),
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw inputError(`${label}_invalid`, `${label} must be an object.`);
  }
  const relatedSymbol = normalizeSymbol(value.symbol, `${label}.symbol`);
  return {
    symbol: relatedSymbol,
    daily: normalizeSeries(value.daily, {
      layer: label,
      symbol: relatedSymbol,
      interval: "1D",
      cutoffTradingDate,
      cutoffAt,
      exactDailyCutoff: true,
      maxBars: TIER_B_TECHNICAL_EVIDENCE_MAX_DAILY_BARS,
    }),
  };
}

function normalizePeerLayers(values, {
  targetSymbol,
  sectorSymbol,
  cutoffTradingDate,
  cutoffAt,
}) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw inputError("peers_not_array", "peers must be an array.");
  if (values.length > 0 && (
    values.length < TIER_B_TECHNICAL_EVIDENCE_MIN_PEERS
    || values.length > TIER_B_TECHNICAL_EVIDENCE_MAX_PEERS
  )) {
    throw inputError(
      "peer_count_out_of_range",
      `Tier-B peer evidence requires ${TIER_B_TECHNICAL_EVIDENCE_MIN_PEERS}-${TIER_B_TECHNICAL_EVIDENCE_MAX_PEERS} peers when supplied.`,
      { count: values.length },
    );
  }
  const seen = new Set([targetSymbol, sectorSymbol].filter(Boolean));
  return values.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw inputError("peer_invalid", `peer ${index + 1} must be an object.`);
    }
    const peerSymbol = normalizeSymbol(value.symbol, `peers.${index}.symbol`);
    if (seen.has(peerSymbol)) {
      throw inputError("peer_symbol_duplicate_or_conflicting", `Peer ${peerSymbol} is duplicated or conflicts with target/sector.`);
    }
    seen.add(peerSymbol);
    return {
      symbol: peerSymbol,
      daily: normalizeSeries(value.daily, {
        layer: "peer",
        symbol: peerSymbol,
        interval: "1D",
        cutoffTradingDate,
        cutoffAt,
        exactDailyCutoff: true,
        maxBars: TIER_B_TECHNICAL_EVIDENCE_MAX_DAILY_BARS,
      }),
    };
  }).sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function buildRelativeCalculation(target, comparator, label) {
  if (!target.usable || !comparator.usable) {
    const reasons = unique([
      ...(!target.usable ? target.reasonCodes.map((reason) => `target:${reason}`) : []),
      ...(!comparator.usable ? comparator.reasonCodes.map((reason) => `${label}:${reason}`) : []),
    ]);
    const value = unavailableValue(reasons);
    return {
      value,
      capability: makeCapability({
        evidenceClass: "calculated",
        status: "unavailable",
        reasonCodes: reasons,
        asOf: null,
        hash: hashCanonical(value),
        method: "same_date_simple_excess_return_no_forward_fill",
      }),
    };
  }
  try {
    const value = calculateDailyExcessReturns(target.bars, comparator.bars);
    const status = value.status === "complete"
      ? "available"
      : value.status === "partial"
        ? "partial"
        : "unavailable";
    const reasons = relativeReasonCodes(value);
    return {
      value,
      capability: makeCapability({
        evidenceClass: "calculated",
        status,
        reasonCodes: reasons,
        asOf: target.asOf,
        hash: hashCanonical(value),
        method: value.methodVersion,
      }),
    };
  } catch (error) {
    const reasons = [String(error?.code ?? "relative_strength_calculation_failed")];
    const value = unavailableValue(reasons);
    return {
      value,
      capability: makeCapability({
        evidenceClass: "calculated",
        status: "unavailable",
        reasonCodes: reasons,
        asOf: null,
        hash: hashCanonical(value),
        method: "same_date_simple_excess_return_no_forward_fill",
      }),
    };
  }
}

function buildPeerRelativeCalculations(target, peers) {
  if (!peers.length) {
    const value = unavailableValue(["peer_group_not_provided"]);
    return {
      value,
      items: [],
      capability: makeCapability({
        evidenceClass: "calculated",
        status: "unavailable",
        reasonCodes: value.reasonCodes,
        asOf: null,
        hash: hashCanonical(value),
        method: "same_date_simple_excess_return_per_peer",
      }),
    };
  }
  const items = peers.map((peer) => ({
    symbol: peer.symbol,
    ...buildRelativeCalculation(target, peer.daily, `peer:${peer.symbol}`),
  }));
  const availableCount = items.filter((item) => item.capability.status !== "unavailable").length;
  const status = availableCount === 0
    ? "unavailable"
    : availableCount === items.length && items.every((item) => item.capability.status === "available")
      ? "available"
      : "partial";
  const reasonCodes = unique(items.flatMap((item) => (
    item.capability.status === "available"
      ? []
      : item.capability.reasonCodes.map((reason) => `${item.symbol}:${reason}`)
  )));
  const value = {
    status,
    peerCount: peers.length,
    availablePeerCount: availableCount,
    method: "target_minus_peer_same_date_simple_returns",
    items: items.map((item) => ({ symbol: item.symbol, ...item.value })),
    reasonCodes,
    advisory: true,
    decisionAuthority: "LLM",
  };
  return {
    value,
    items,
    capability: makeCapability({
      evidenceClass: "calculated",
      status,
      reasonCodes,
      asOf: target.usable ? target.asOf : null,
      hash: hashCanonical(value),
      method: "same_date_simple_excess_return_per_peer",
    }),
  };
}

function buildExplicitAnchoredVwap({ request, daily, intraday60m }) {
  if (request == null) return unavailableAnchored("explicit_anchor_not_provided");
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return unavailableAnchored("anchored_vwap_request_invalid");
  }
  const sourceLayer = normalizeAvwapSourceLayer(request.sourceLayer ?? request.timeframe);
  if (!sourceLayer) return unavailableAnchored("anchored_vwap_source_layer_invalid");
  const series = sourceLayer === "daily" ? daily : intraday60m;
  if (!series.usable) {
    return unavailableAnchored(
      `anchored_vwap_${sourceLayer}_series_unavailable`,
      request.anchor ?? null,
      sourceLayer,
    );
  }
  const observedAnchor = finiteJsonClone(request.anchor);
  if (!observedAnchor) return unavailableAnchored("anchored_vwap_anchor_invalid", null, sourceLayer);
  try {
    const calculated = buildAnchoredVwapEvidence({
      bars: series.bars,
      completedBarsOnly: true,
      anchor: request.anchor,
      asOf: request.asOf ?? { barId: series.bars.at(-1).barId },
    });
    const observed = {
      status: "available",
      sourceLayer,
      anchor: calculated.anchor,
      requestedAsOf: request.asOf ?? null,
      reasonCodes: [],
      asOf: calculated.anchor.timestamp,
      inputHash: hashCanonical({ sourceLayer, anchor: calculated.anchor }),
    };
    return {
      observed,
      calculated,
      observedCapability: makeCapability({
        evidenceClass: "observed",
        status: "available",
        reasonCodes: [],
        asOf: calculated.anchor.timestamp,
        hash: observed.inputHash,
        method: "caller_or_event_explicit_anchor",
      }),
      calculatedCapability: makeCapability({
        evidenceClass: "calculated",
        status: "available",
        reasonCodes: [],
        asOf: calculated.asOf.timestamp,
        hash: hashCanonical(calculated),
        method: calculated.methodVersion,
      }),
    };
  } catch (error) {
    return unavailableAnchored(
      String(error?.code ?? "anchored_vwap_calculation_failed"),
      observedAnchor,
      sourceLayer,
    );
  }
}

function unavailableAnchored(reason, anchor = null, sourceLayer = null) {
  const reasons = [reason];
  const observed = {
    status: "unavailable",
    sourceLayer,
    anchor,
    requestedAsOf: null,
    reasonCodes: reasons,
    asOf: null,
    inputHash: hashCanonical({ sourceLayer, anchor, status: "unavailable", reasonCodes: reasons }),
  };
  const calculated = unavailableValue(reasons);
  return {
    observed,
    calculated,
    observedCapability: makeCapability({
      evidenceClass: "observed",
      status: "unavailable",
      reasonCodes: reasons,
      asOf: null,
      hash: observed.inputHash,
      method: "caller_or_event_explicit_anchor",
    }),
    calculatedCapability: makeCapability({
      evidenceClass: "calculated",
      status: "unavailable",
      reasonCodes: reasons,
      asOf: null,
      hash: hashCanonical(calculated),
      method: "anchored-vwap-hlc3-volume/v1",
    }),
  };
}

function normalizeOptions(value, { symbol, cutoffTradingDate, cutoffAt }) {
  if (value == null) return unavailableOptions("options_not_provided_optional");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return unavailableOptions("options_contract_invalid");
  }
  const asOf = validIso(value.asOf);
  const source = textOrNull(value.source);
  if (!asOf) return unavailableOptions("options_as_of_invalid");
  if (!source) return unavailableOptions("options_source_missing");
  if (Date.parse(asOf) > Date.parse(cutoffAt)) {
    return unavailableOptions("options_as_of_after_knowledge_cutoff");
  }
  try {
    const rows = normalizeOptionRows(value.chain);
    const iv = normalizeVolatilityInput(
      value.iv ?? (value.impliedVolatilityPercent == null
        ? null
        : { valuePercent: value.impliedVolatilityPercent }),
      { label: "iv", fallbackAsOf: asOf, fallbackSource: source },
    );
    const rv = normalizeVolatilityInput(
      value.rv ?? (value.realizedVolatilityPercent == null
        ? null
        : { valuePercent: value.realizedVolatilityPercent }),
      { label: "rv", fallbackAsOf: asOf, fallbackSource: source },
    );
    const reasons = [];
    if (asOf.slice(0, 10) !== cutoffTradingDate) reasons.push("option_chain_not_current_for_cutoff");
    if (!rows.length) reasons.push("option_chain_rows_not_provided");
    if (!iv) reasons.push("implied_volatility_not_provided");
    if (!rv) reasons.push("realized_volatility_not_provided");
    const hasAny = rows.length > 0 || iv || rv;
    const status = !hasAny ? "unavailable" : reasons.length ? "partial" : "available";
    const inputHash = hashCanonical({ symbol, asOf, source, rows, iv, rv });
    const observed = {
      status,
      symbol,
      source,
      asOf,
      inputHash,
      reasonCodes: unique(reasons),
      chain: rows,
      iv,
      rv,
      rawOpenInterestInterpretation: "observed_unsigned_contract_count_only",
      dealerGamma: unavailableValue(["raw_open_interest_does_not_identify_dealer_direction"]),
    };
    return {
      observed,
      usable: hasAny,
      status,
      reasonCodes: observed.reasonCodes,
      asOf,
      inputHash,
      capability: makeCapability({
        evidenceClass: "observed",
        status,
        reasonCodes: observed.reasonCodes,
        asOf,
        hash: inputHash,
        method: "caller_supplied_current_option_chain_iv_rv",
      }),
    };
  } catch (error) {
    return unavailableOptions(String(error?.code ?? "options_contract_invalid"));
  }
}

function unavailableOptions(reason) {
  const reasons = [reason];
  const inputHash = hashCanonical({ status: "unavailable", reasonCodes: reasons });
  const observed = {
    status: "unavailable",
    symbol: null,
    source: null,
    asOf: null,
    inputHash,
    reasonCodes: reasons,
    chain: [],
    iv: null,
    rv: null,
    rawOpenInterestInterpretation: "N/A",
    dealerGamma: unavailableValue(["raw_open_interest_does_not_identify_dealer_direction"]),
  };
  return {
    observed,
    usable: false,
    status: "unavailable",
    reasonCodes: reasons,
    asOf: null,
    inputHash,
    capability: makeCapability({
      evidenceClass: "observed",
      status: "unavailable",
      reasonCodes: reasons,
      asOf: null,
      hash: inputHash,
      method: "caller_supplied_current_option_chain_iv_rv",
    }),
  };
}

function normalizeOptionRows(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw inputError("option_chain_not_array", "options.chain must be an array.");
  if (value.length > TIER_B_TECHNICAL_EVIDENCE_MAX_OPTION_ROWS) {
    throw inputError("option_chain_row_limit_exceeded", "options.chain exceeds the Tier-B row limit.");
  }
  const seen = new Set();
  return value.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw inputError("option_row_invalid", `Option row ${index + 1} must be an object.`);
    }
    const contractSymbol = boundedText(row.contractSymbol ?? row.symbol, `option row ${index + 1} contractSymbol`, 120);
    if (seen.has(contractSymbol)) throw inputError("option_contract_duplicate", `Duplicate option contract ${contractSymbol}.`);
    seen.add(contractSymbol);
    const expiry = normalizeTradingDate(row.expiry);
    const strike = requiredFinite(row.strike, `option row ${index + 1}.strike`);
    if (strike <= 0) throw inputError("option_strike_invalid", "Option strike must be positive.");
    const type = String(row.type ?? row.right ?? "").trim().toLowerCase();
    if (!["call", "put"].includes(type)) throw inputError("option_type_invalid", "Option type must be call or put.");
    return {
      contractSymbol,
      expiry,
      strike,
      type,
      bid: optionalNonNegative(row.bid, `option row ${index + 1}.bid`),
      ask: optionalNonNegative(row.ask, `option row ${index + 1}.ask`),
      last: optionalNonNegative(row.last, `option row ${index + 1}.last`),
      volume: optionalNonNegative(row.volume, `option row ${index + 1}.volume`),
      openInterest: optionalNonNegative(row.openInterest ?? row.open_interest, `option row ${index + 1}.openInterest`),
      impliedVolatilityPercent: optionalNonNegative(
        row.impliedVolatilityPercent ?? row.ivPercent,
        `option row ${index + 1}.impliedVolatilityPercent`,
      ),
    };
  }).sort((left, right) => left.expiry.localeCompare(right.expiry)
    || left.strike - right.strike
    || left.type.localeCompare(right.type)
    || left.contractSymbol.localeCompare(right.contractSymbol));
}

function normalizeVolatilityInput(value, { label, fallbackAsOf, fallbackSource }) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw inputError(`${label}_invalid`, `${label} must be an object.`);
  }
  const number = requiredFinite(value.valuePercent ?? value.value, `${label}.valuePercent`);
  if (number < 0) throw inputError(`${label}_negative`, `${label} cannot be negative.`);
  const asOf = validIso(value.asOf ?? fallbackAsOf);
  const source = textOrNull(value.source ?? fallbackSource);
  if (!asOf || !source) throw inputError(`${label}_provenance_missing`, `${label} requires source and asOf.`);
  return {
    valuePercent: number,
    asOf,
    source,
    horizonDays: finiteIntegerOrNull(value.horizonDays ?? value.lookbackDays),
  };
}

function calculateOptions(options) {
  if (!options.usable) {
    const value = unavailableValue(options.reasonCodes);
    return {
      value,
      capability: makeCapability({
        evidenceClass: "calculated",
        status: "unavailable",
        reasonCodes: options.reasonCodes,
        asOf: null,
        hash: hashCanonical(value),
        method: "option_chain_aggregation_without_positioning_inference",
      }),
    };
  }
  const rowsWithOi = options.observed.chain.filter((row) => row.openInterest != null);
  const callRows = rowsWithOi.filter((row) => row.type === "call");
  const putRows = rowsWithOi.filter((row) => row.type === "put");
  const callOpenInterest = callRows.length
    ? callRows.reduce((sum, row) => sum + row.openInterest, 0)
    : null;
  const putOpenInterest = putRows.length
    ? putRows.reduce((sum, row) => sum + row.openInterest, 0)
    : null;
  const ratio = callOpenInterest != null && callOpenInterest > 0 && putOpenInterest != null
    ? putOpenInterest / callOpenInterest
    : null;
  const ivRvSpread = options.observed.iv && options.observed.rv
    ? options.observed.iv.valuePercent - options.observed.rv.valuePercent
    : null;
  const value = {
    status: options.status,
    asOf: options.asOf,
    inputHash: options.inputHash,
    chain: {
      rowCount: options.observed.chain.length,
      rowsWithOpenInterest: rowsWithOi.length,
      callOpenInterest,
      putOpenInterest,
      putCallOpenInterestRatio: ratio,
      interpretation: "unsigned_raw_open_interest_aggregation_only",
    },
    volatility: {
      impliedVolatilityPercent: options.observed.iv?.valuePercent ?? null,
      realizedVolatilityPercent: options.observed.rv?.valuePercent ?? null,
      ivMinusRvPercentPoints: ivRvSpread,
      unavailableDisplay: ivRvSpread == null ? "N/A" : null,
    },
    dealerGamma: unavailableValue([
      "dealer_gamma_not_inferred_from_open_interest",
      "signed_positioning_model_not_supplied",
    ]),
    reasonCodes: options.reasonCodes,
    advisory: true,
    decisionAuthority: "LLM",
  };
  return {
    value,
    capability: makeCapability({
      evidenceClass: "calculated",
      status: options.status,
      reasonCodes: options.reasonCodes,
      asOf: options.asOf,
      hash: hashCanonical(value),
      method: "option_chain_aggregation_and_iv_minus_rv_no_gamma_inference",
    }),
  };
}

function normalizeCatalysts(value, { cutoffTradingDate, cutoffAt }) {
  if (value == null) return unavailableCatalyst("catalyst_facts_not_provided");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return unavailableCatalyst("catalyst_contract_invalid");
  }
  const source = textOrNull(value.source);
  if (!source || !Array.isArray(value.facts)) return unavailableCatalyst(
    !source ? "catalyst_source_missing" : "catalyst_facts_not_array",
  );
  try {
    const seen = new Set();
    let ignoredAfterCutoffCount = 0;
    const facts = [];
    for (const [index, fact] of value.facts.entries()) {
      if (!fact || typeof fact !== "object" || Array.isArray(fact)) {
        throw inputError("catalyst_fact_invalid", `Catalyst fact ${index + 1} must be an object.`);
      }
      const id = boundedText(fact.id ?? fact.factId, `catalyst fact ${index + 1}.id`, 160);
      if (seen.has(id)) throw inputError("catalyst_fact_duplicate", `Duplicate catalyst fact ${id}.`);
      seen.add(id);
      const knownAt = validIso(fact.knownAt ?? fact.publishedAt);
      const eventAt = validIso(fact.eventAt ?? fact.effectiveAt);
      if (!knownAt || !eventAt) throw inputError(
        "catalyst_fact_time_invalid",
        `Catalyst fact ${id} requires valid knownAt and eventAt timestamps.`,
      );
      if (Date.parse(knownAt) > Date.parse(cutoffAt)) {
        ignoredAfterCutoffCount += 1;
        continue;
      }
      facts.push({
        id,
        type: boundedText(fact.type ?? "other", `catalyst fact ${id}.type`, 80),
        knownAt,
        eventAt,
        source: textOrNull(fact.source) ?? source,
        summary: boundedText(fact.summary, `catalyst fact ${id}.summary`, 2_000),
        fiscalPeriod: textOrNull(fact.fiscalPeriod),
      });
    }
    facts.sort((left, right) => left.knownAt.localeCompare(right.knownAt)
      || left.eventAt.localeCompare(right.eventAt)
      || left.id.localeCompare(right.id));
    if (!facts.length) return unavailableCatalyst(
      ignoredAfterCutoffCount ? "no_point_in_time_facts_at_or_before_cutoff" : "catalyst_facts_empty",
      ignoredAfterCutoffCount,
    );
    const inputHash = hashCanonical({ cutoffTradingDate, source, facts });
    const observed = {
      status: "available",
      source,
      asOf: facts.at(-1).knownAt,
      inputHash,
      reasonCodes: [],
      pointInTimePolicy: "knownAt_at_or_before_knowledge_cutoff",
      ignoredAfterCutoffCount,
      facts,
    };
    return {
      observed,
      usable: true,
      status: "available",
      reasonCodes: [],
      asOf: observed.asOf,
      inputHash,
      capability: makeCapability({
        evidenceClass: "observed",
        status: "available",
        reasonCodes: [],
        asOf: observed.asOf,
        hash: inputHash,
        method: "point_in_time_known_at_filter",
      }),
    };
  } catch (error) {
    return unavailableCatalyst(String(error?.code ?? "catalyst_contract_invalid"));
  }
}

function unavailableCatalyst(reason, ignoredAfterCutoffCount = 0) {
  const reasons = [reason];
  const inputHash = hashCanonical({ status: "unavailable", reasonCodes: reasons });
  const observed = {
    status: "unavailable",
    source: null,
    asOf: null,
    inputHash,
    reasonCodes: reasons,
    pointInTimePolicy: "knownAt_at_or_before_knowledge_cutoff",
    ignoredAfterCutoffCount,
    facts: [],
  };
  return {
    observed,
    usable: false,
    status: "unavailable",
    reasonCodes: reasons,
    asOf: null,
    inputHash,
    capability: makeCapability({
      evidenceClass: "observed",
      status: "unavailable",
      reasonCodes: reasons,
      asOf: null,
      hash: inputHash,
      method: "point_in_time_known_at_filter",
    }),
  };
}

function calculateCatalystSummary(catalyst, cutoffAt) {
  if (!catalyst.usable) {
    const value = unavailableValue(catalyst.reasonCodes);
    return {
      value,
      capability: makeCapability({
        evidenceClass: "calculated",
        status: "unavailable",
        reasonCodes: catalyst.reasonCodes,
        asOf: null,
        hash: hashCanonical(value),
        method: "point_in_time_catalyst_count_summary",
      }),
    };
  }
  const cutoffMs = Date.parse(cutoffAt);
  const occurredByCutoff = catalyst.observed.facts.filter((fact) => Date.parse(fact.eventAt) <= cutoffMs).length;
  const scheduledAfterCutoff = catalyst.observed.facts.length - occurredByCutoff;
  const value = {
    status: "available",
    asOf: catalyst.asOf,
    inputHash: catalyst.inputHash,
    knownFactCount: catalyst.observed.facts.length,
    occurredByCutoffCount: occurredByCutoff,
    scheduledAfterCutoffCount: scheduledAfterCutoff,
    reactionMetrics: unavailableValue(["event_reaction_requires_explicit_event_aligned_price_window"]),
    inference: unavailableValue(["catalyst_materiality_requires_llm_inference"]),
  };
  return {
    value,
    capability: makeCapability({
      evidenceClass: "calculated",
      status: "available",
      reasonCodes: ["event_reaction_not_calculated_without_explicit_alignment"],
      asOf: catalyst.asOf,
      hash: hashCanonical(value),
      method: "point_in_time_catalyst_count_summary",
    }),
  };
}

function buildNumericEvidenceIndex({
  symbol,
  currency,
  cutoffTradingDate,
  cutoffAt,
  targetDaily,
  benchmarkDaily,
  sector,
  peers,
  benchmarkRelative,
  sectorRelative,
  peerRelative,
  anchored,
  optionEvidence,
  optionCalculation,
  catalystEvidence,
}) {
  const observed = [];
  const refs = new Map();
  const addSeries = (key, series) => {
    const fact = createObservedFact({
      factId: `tier-b.${key}.completed-bars@${cutoffAt}`,
      metric: `technical.tier_b.${metricKey(key)}.completed_bar_count`,
      value: series.usable ? series.barCount : null,
      availability: series.usable ? "known" : "unknown",
      unit: { kind: "scalar", label: "completed bars" },
      asOf: numericAsOf(series.asOf ?? cutoffAt, cutoffTradingDate, series.interval),
      provenance: {
        source: series.source ?? "caller supplied explicit evidence",
        tool: "tier-b-technical-evidence",
        sourceRecordId: series.inputHash,
        rawFields: [`${key}.bars`],
        inputRefs: [],
        formula: null,
        methodVersion: "completed-ohlcv-contract/v1",
      },
      quality: {
        freshness: "historical",
        ageMs: null,
        complete: series.usable,
        confidence: series.usable ? "high" : "unknown",
        reasonCodes: series.usable ? series.reasonCodes : series.reasonCodes.length
          ? series.reasonCodes
          : ["input_unavailable"],
      },
      display: { precision: 0, label: `${key} completed bars` },
    });
    observed.push(fact);
    refs.set(key, numericEvidenceRef(fact));
  };
  addSeries("target_daily", targetDaily);
  addSeries("qqq_daily", benchmarkDaily);
  if (sector.symbol) addSeries("sector_daily", sector.daily);
  for (const peer of peers) addSeries(`peer_${metricKey(peer.symbol)}`, peer.daily);

  if (optionEvidence.usable && optionEvidence.observed.iv) {
    const fact = volatilityObservedFact({
      kind: "iv",
      symbol,
      cutoffTradingDate,
      value: optionEvidence.observed.iv,
      sourceRecordId: optionEvidence.inputHash,
    });
    observed.push(fact);
    refs.set("iv", numericEvidenceRef(fact));
  }
  if (optionEvidence.usable && optionEvidence.observed.rv) {
    const fact = volatilityObservedFact({
      kind: "rv",
      symbol,
      cutoffTradingDate,
      value: optionEvidence.observed.rv,
      sourceRecordId: optionEvidence.inputHash,
    });
    observed.push(fact);
    refs.set("rv", numericEvidenceRef(fact));
  }
  if (catalystEvidence.usable) {
    const fact = createObservedFact({
      factId: `tier-b.catalyst.known-fact-count@${cutoffAt}`,
      metric: "technical.tier_b.catalyst.known_fact_count",
      value: catalystEvidence.observed.facts.length,
      availability: "known",
      unit: { kind: "scalar", label: "point-in-time facts" },
      asOf: numericAsOf(catalystEvidence.asOf, cutoffTradingDate, "event"),
      provenance: {
        source: catalystEvidence.observed.source,
        tool: "tier-b-technical-evidence",
        sourceRecordId: catalystEvidence.inputHash,
        rawFields: ["catalysts.facts"],
        inputRefs: [],
        formula: null,
        methodVersion: "point-in-time-known-at-filter/v1",
      },
      quality: {
        freshness: "historical",
        ageMs: null,
        complete: true,
        confidence: "high",
        reasonCodes: [],
      },
      display: { precision: 0, label: "Known catalyst facts" },
    });
    observed.push(fact);
    refs.set("catalyst", numericEvidenceRef(fact));
  }

  const calculated = [];
  appendRelativeNumericFacts(calculated, {
    key: "qqq",
    result: benchmarkRelative,
    refs: [refs.get("target_daily"), refs.get("qqq_daily")],
    cutoffTradingDate,
    cutoffAt,
  });
  if (sector.symbol) appendRelativeNumericFacts(calculated, {
    key: "sector",
    result: sectorRelative,
    refs: [refs.get("target_daily"), refs.get("sector_daily")],
    cutoffTradingDate,
    cutoffAt,
  });
  for (const item of peerRelative.items ?? []) {
    appendRelativeNumericFacts(calculated, {
      key: `peer_${metricKey(item.symbol)}`,
      result: item,
      refs: [refs.get("target_daily"), refs.get(`peer_${metricKey(item.symbol)}`)],
      cutoffTradingDate,
      cutoffAt,
    });
  }
  if (anchored.calculated?.status === "available") {
    calculated.push(createDerivedMetric({
      factId: `tier-b.anchored-vwap.${symbol.toLowerCase()}@${cutoffAt}`,
      metric: "technical.tier_b.anchored_vwap_price",
      value: anchored.calculated.vwap,
      availability: "known",
      unit: { kind: "price", currency, symbol, tickSize: null },
      asOf: numericAsOf(anchored.calculated.asOf.timestamp, cutoffTradingDate, "regular"),
      provenance: {
        source: "local deterministic anchored VWAP",
        tool: "local:anchored-vwap",
        sourceRecordId: anchored.calculated.inputHash,
        rawFields: [],
        inputRefs: [refs.get("target_daily")].filter(Boolean),
        formula: anchored.calculated.method.formula,
        methodVersion: anchored.calculated.methodVersion,
      },
      quality: {
        freshness: "historical",
        ageMs: null,
        complete: true,
        confidence: "high",
        reasonCodes: ["anchor_semantics_caller_supplied"],
      },
      display: { precision: 4, label: "Anchored VWAP" },
    }));
  }
  if (optionCalculation.value?.volatility?.ivMinusRvPercentPoints != null
    && refs.get("iv") && refs.get("rv")) {
    calculated.push(createDerivedMetric({
      factId: `tier-b.options.iv-minus-rv.${symbol.toLowerCase()}@${cutoffAt}`,
      metric: "technical.tier_b.options.iv_minus_rv_percent_points",
      value: optionCalculation.value.volatility.ivMinusRvPercentPoints,
      availability: "known",
      unit: { kind: "percent_point", basis: "annualized_iv_percent_minus_comparable_rv_percent" },
      asOf: numericAsOf(optionEvidence.asOf, cutoffTradingDate, "regular"),
      provenance: {
        source: "local deterministic option volatility comparison",
        tool: "tier-b-technical-evidence",
        sourceRecordId: optionEvidence.inputHash,
        rawFields: [],
        inputRefs: [refs.get("iv"), refs.get("rv")],
        formula: "implied_volatility_percent - realized_volatility_percent",
        methodVersion: "iv-minus-rv/v1",
      },
      quality: {
        freshness: optionEvidence.status === "available" ? "fresh" : "historical",
        ageMs: null,
        complete: optionEvidence.status === "available",
        confidence: "high",
        reasonCodes: optionEvidence.reasonCodes,
      },
      display: { precision: 4, label: "IV-RV spread" },
    }));
  }

  return {
    observed: numericPackage("observed_fact", observed),
    calculated: numericPackage("derived_metric", calculated),
  };
}

function appendRelativeNumericFacts(output, {
  key,
  result,
  refs,
  cutoffTradingDate,
  cutoffAt,
}) {
  if (result?.capability?.status === "unavailable") return;
  const validRefs = refs.filter(Boolean);
  if (!validRefs.length) return;
  for (const [window, metric] of Object.entries(result.value?.windows ?? {})) {
    if (metric?.status !== "available" || !Number.isFinite(metric.value)) continue;
    output.push(createDerivedMetric({
      factId: `tier-b.${key}.excess-return-${window}d@${cutoffAt}`,
      metric: `technical.tier_b.${metricKey(key)}.excess_return_${window}d_percent`,
      value: metric.value,
      availability: "known",
      unit: { kind: "percent_point", basis: "same_date_target_return_minus_comparator_return" },
      asOf: numericAsOf(cutoffAt, cutoffTradingDate, "regular"),
      provenance: {
        source: "local deterministic same-date relative return",
        tool: "local:daily-sequence",
        sourceRecordId: result.value.inputHash,
        rawFields: [],
        inputRefs: validRefs,
        formula: "target simple return percent - comparator simple return percent",
        methodVersion: result.value.methodVersion,
      },
      quality: {
        freshness: "historical",
        ageMs: null,
        complete: true,
        confidence: "high",
        reasonCodes: ["same_trade_date_alignment_no_forward_fill"],
      },
      display: { precision: 4, label: `${key} excess return ${window}d` },
    }));
  }
}

function volatilityObservedFact({ kind, symbol, cutoffTradingDate, value, sourceRecordId }) {
  const implied = kind === "iv";
  return createObservedFact({
    factId: `tier-b.options.${kind}.${symbol.toLowerCase()}@${value.asOf}`,
    metric: implied
      ? "technical.tier_b.options.implied_volatility_percent"
      : "technical.tier_b.options.realized_volatility_percent",
    value: value.valuePercent,
    availability: "known",
    unit: {
      kind: "percent_point",
      basis: implied ? "caller_supplied_annualized_implied_volatility" : "caller_supplied_annualized_realized_volatility",
    },
    asOf: numericAsOf(value.asOf, cutoffTradingDate, "regular"),
    provenance: {
      source: value.source,
      tool: "tier-b-technical-evidence",
      sourceRecordId,
      rawFields: [implied ? "options.iv.valuePercent" : "options.rv.valuePercent"],
      inputRefs: [],
      formula: null,
      methodVersion: implied ? "caller-supplied-iv/v1" : "caller-supplied-rv/v1",
    },
    quality: {
      freshness: "fresh",
      ageMs: null,
      complete: true,
      confidence: "high",
      reasonCodes: [],
    },
    display: { precision: 4, label: implied ? "Implied volatility" : "Realized volatility" },
  });
}

function numericPackage(kind, facts) {
  return {
    schemaVersion: NUMERIC_EVIDENCE_SCHEMA_VERSION,
    kind,
    status: facts.length ? "available" : "unavailable",
    factCount: facts.length,
    facts,
    inputHash: hashCanonical(facts.map((fact) => ({ factId: fact.factId, hash: fact.hash }))),
    missingValuesAreNullNotZero: true,
  };
}

function numericAsOf(value, tradingDate, interval) {
  return {
    effectiveAt: validIso(value) ?? `${tradingDate}T23:59:59.999Z`,
    retrievedAt: validIso(value) ?? `${tradingDate}T23:59:59.999Z`,
    tradingDate,
    session: interval === "event" ? "not_applicable" : "regular",
    timeZone: "UTC",
  };
}

function observedSeries(series) {
  return {
    status: series.status,
    symbol: series.symbol,
    interval: series.interval,
    source: series.source,
    completedBarsOnly: series.usable,
    barCount: series.barCount,
    asOf: series.asOf,
    inputHash: series.inputHash,
    reasonCodes: series.reasonCodes,
    coverage: series.coverage,
    ignoredAfterCutoffCount: series.ignoredAfterCutoffCount,
    futureValuesIncluded: false,
  };
}

function descriptorForTechnicalV2(series) {
  return {
    bars: series.bars,
    interval: series.interval,
    completedBarsOnly: true,
    source: series.source,
    fetchedAt: series.coverage?.fetchedAt ?? null,
    coverage: series.coverage,
  };
}

function missingExplicitLayerDescriptor(interval, source) {
  return {
    bars: [],
    interval,
    completedBarsOnly: false,
    source,
  };
}

function capabilityFromSeries(series, evidenceClass) {
  return makeCapability({
    evidenceClass,
    status: series.status,
    reasonCodes: series.reasonCodes,
    asOf: series.asOf,
    hash: series.inputHash,
    method: `caller_supplied_completed_${series.interval.toLowerCase()}_ohlcv`,
  });
}

function calculatedDailyCapability(technical, series) {
  const status = !technical
    ? "unavailable"
    : technical.calculationBarCount > 0
      ? technical.status === "complete" ? "available" : "partial"
      : "unavailable";
  const reasons = status === "available"
    ? []
    : unique([...(series.reasonCodes ?? []), technical?.reason ?? "daily_calculation_unavailable"]);
  const value = technical ?? unavailableValue(reasons);
  return makeCapability({
    evidenceClass: "calculated",
    status,
    reasonCodes: reasons,
    asOf: technical?.asOf ?? null,
    hash: hashCanonical(value),
    method: technical?.dailySequence?.methodVersion ?? "existing_daily_technical_engine",
  });
}

function calculatedTechnicalV2Capability(capability, series, method, value) {
  const status = capability?.status === "complete"
    ? "available"
    : capability?.status === "warming"
      ? "partial"
      : "unavailable";
  const reasons = unique([
    ...(series.reasonCodes ?? []),
    ...(capability?.reasonCodes ?? []),
  ]);
  return makeCapability({
    evidenceClass: "calculated",
    status,
    reasonCodes: status === "available" ? reasons.filter((reason) => reason !== "input_not_provided") : reasons,
    asOf: capability?.asOf ?? null,
    hash: hashCanonical(value),
    method: capability?.method ?? method,
  });
}

function buildInferenceCapabilities({ calculatedCapabilities }) {
  const fromCalculation = (name, method, extraReasons = []) => {
    const calculated = calculatedCapabilities[name];
    const status = calculated.status === "unavailable" ? "unavailable" : calculated.status;
    const reasons = unique([
      ...calculated.reasonCodes,
      ...extraReasons,
      ...(status === "unavailable" ? [`${name}_calculation_unavailable`] : []),
    ]);
    return makeCapability({
      evidenceClass: "inference",
      status,
      reasonCodes: reasons,
      asOf: calculated.asOf,
      hash: hashCanonical({
        generated: false,
        sourceCalculationHash: calculated.hash,
        method,
        reasonCodes: reasons,
      }),
      method,
      generated: false,
    });
  };
  return {
    daily: fromCalculation("daily", "llm_multi_indicator_daily_state_inference"),
    weekly: fromCalculation("weekly", "llm_weekly_context_inference"),
    benchmark: fromCalculation("benchmark", "llm_qqq_regime_inference"),
    execution60m: fromCalculation("execution60m", "llm_execution_timing_inference"),
    sector: fromCalculation("sector", "llm_sector_linkage_inference"),
    peers: fromCalculation("peers", "llm_peer_confirmation_inference"),
    anchoredVwap: fromCalculation("anchoredVwap", "llm_anchor_semantics_and_price_acceptance_inference", [
      "anchor_reason_is_caller_or_event_supplied",
    ]),
    options: fromCalculation("options", "llm_options_and_volatility_inference", [
      "dealer_gamma_not_inferred_from_open_interest",
    ]),
    catalyst: fromCalculation("catalyst", "llm_point_in_time_catalyst_materiality_inference"),
  };
}

function layerIndex({ observed, calculated, inference }) {
  const status = observed.status === "unavailable"
    ? "unavailable"
    : calculated.status === "unavailable"
      ? "partial"
      : [observed.status, calculated.status, inference.status].includes("partial")
        ? "partial"
        : "available";
  return {
    status,
    reasonCodes: unique([
      ...observed.reasonCodes,
      ...calculated.reasonCodes,
      ...inference.reasonCodes,
    ]),
    asOf: calculated.asOf ?? observed.asOf,
    hashes: {
      observed: observed.hash,
      calculated: calculated.hash,
      inference: inference.hash,
    },
  };
}

function overallStatus(layers) {
  if (layers.daily.status === "unavailable" || layers.benchmark.status === "unavailable") {
    return "unavailable";
  }
  const requiredDepth = ["weekly", "execution60m", "sector", "peers", "anchoredVwap", "catalyst"];
  return requiredDepth.every((name) => layers[name].status === "available") ? "complete" : "partial";
}

function makeCapability({
  evidenceClass,
  status,
  reasonCodes,
  asOf,
  hash,
  method,
  generated = null,
}) {
  const normalizedStatus = ["available", "partial", "unavailable"].includes(status)
    ? status
    : "unavailable";
  const body = {
    evidenceClass,
    status: normalizedStatus,
    reasonCodes: unique(reasonCodes),
    asOf: asOf ?? null,
    method: method ?? null,
    ...(evidenceClass === "inference" ? { generated: generated === true } : {}),
  };
  return { ...body, hash: validHash(hash) ? hash : hashCanonical(body) };
}

function peerObservedStatus(peers) {
  if (!peers.length) return "unavailable";
  if (peers.every((peer) => peer.daily.status === "available")) return "available";
  if (peers.some((peer) => peer.daily.usable)) return "partial";
  return "unavailable";
}

function peerObservedReasons(peers) {
  if (!peers.length) return ["peer_group_not_provided"];
  return unique(peers.flatMap((peer) => peer.daily.status === "available"
    ? []
    : peer.daily.reasonCodes.map((reason) => `${peer.symbol}:${reason}`)));
}

function relativeReasonCodes(value) {
  return unique(Object.values(value?.windows ?? {}).flatMap((metric) => (
    metric?.status === "available" ? [] : [metric?.reason ?? "relative_window_unavailable"]
  )));
}

function normalizeAvwapSourceLayer(value) {
  const text = String(value ?? "daily").trim().toLowerCase();
  if (["daily", "1d", "day"].includes(text)) return "daily";
  if (["60m", "1h", "hourly"].includes(text)) return "execution60m";
  return null;
}

function normalizeInterval(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["1d", "day", "daily", "d"].includes(text)) return "1D";
  if (["1w", "1wk", "week", "weekly", "w"].includes(text)) return "1W";
  if (["60", "60m", "1h", "hour", "hourly"].includes(text)) return "60m";
  return text || null;
}

function normalizeHorizon(value) {
  const text = String(value ?? "swing").trim().toLowerCase();
  return ["intraday", "swing", "position", "event", "unknown"].includes(text)
    ? text
    : "unknown";
}

function normalizeSymbol(value, field) {
  let symbol = String(value ?? "").trim().toUpperCase();
  if (!symbol) throw inputError("symbol_missing", `${field} is required.`);
  if (!symbol.includes(".") && /^[A-Z][A-Z0-9-]{0,9}$/.test(symbol)) symbol = `${symbol}.US`;
  if (!/^[A-Z0-9][A-Z0-9_-]{0,29}\.(US|HK|SG|SH|SZ|CN)$/.test(symbol)) {
    throw inputError("symbol_invalid", `${field} is invalid.`, { value: symbol });
  }
  return symbol;
}

function normalizeCurrency(value, symbol) {
  const explicit = String(value ?? "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(explicit)) return explicit;
  const market = symbol.split(".").at(-1);
  if (market === "US") return "USD";
  if (market === "HK") return "HKD";
  if (["CN", "SH", "SZ"].includes(market)) return "CNY";
  if (market === "SG") return "SGD";
  return "USD";
}

function normalizeTradingDate(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw inputError("cutoff_trading_date_invalid", "Trading dates must use YYYY-MM-DD.");
  }
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw inputError("cutoff_trading_date_invalid", "Trading date is not a valid calendar date.");
  }
  return text;
}

function normalizeKnowledgeCutoff(value, tradingDate) {
  if (value == null || value === "") return `${tradingDate}T23:59:59.999Z`;
  const iso = validIso(value);
  if (!iso) throw inputError("knowledge_cutoff_invalid", "knowledgeCutoffAt must be an ISO timestamp.");
  return iso;
}

function marketFromSymbol(symbol) {
  return String(symbol ?? "").split(".").at(-1) ?? null;
}

function isExplicitlyForming(value) {
  if (value.isClosed === false || value.is_closed === false || value.complete === false
    || value.confirmed === false || value.final === false) return true;
  const status = String(
    value.barStatus ?? value.bar_status ?? value.status ?? value.state ?? "",
  ).trim().toLowerCase();
  return FORMING_STATES.has(status);
}

function hashableBar(bar) {
  return {
    barId: bar.barId,
    timestamp: bar.timestamp,
    tradeDate: bar.tradeDate,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  };
}

function hashableCoverage(value) {
  if (!value) return null;
  return {
    source: value.source,
    originSource: value.originSource,
    coverageStatus: value.coverageStatus,
    complete: value.complete,
    partial: value.partial,
    partialReasons: value.partialReasons,
    fetchedAt: value.fetchedAt,
    storedAt: value.storedAt,
    endpoint: value.endpoint,
    period: value.period,
    adjustment: value.adjustment,
    tradeSessions: value.tradeSessions,
    refreshAttempted: value.refreshAttempted,
    fallbackReason: value.fallbackReason,
    persistenceStatus: value.persistenceStatus,
  };
}

function unavailableValue(reasonCodes) {
  return {
    status: "unavailable",
    value: null,
    display: "N/A",
    reasonCodes: unique(reasonCodes),
  };
}

function requiredFinite(value, field) {
  if (value == null || value === "" || typeof value === "boolean") {
    throw inputError("numeric_value_missing", `${field} is required.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw inputError("numeric_value_invalid", `${field} must be finite.`);
  return number;
}

function optionalNonNegative(value, field) {
  if (value == null || value === "") return null;
  const number = requiredFinite(value, field);
  if (number < 0) throw inputError("numeric_value_negative", `${field} cannot be negative.`);
  return number;
}

function finiteIntegerOrNull(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function boundedText(value, field, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) throw inputError("text_missing", `${field} is required.`);
  if (text.length > maxLength) throw inputError("text_too_long", `${field} exceeds ${maxLength} characters.`);
  if (/\p{Cc}/u.test(text)) throw inputError("text_control_character", `${field} contains control characters.`);
  return text;
}

function textOrNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function validIso(value) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function latestIso(values) {
  return values.filter(Boolean).sort().at(-1) ?? null;
}

function metricKey(value) {
  return String(value ?? "unknown").toLowerCase().replace(/[^a-z0-9.-]+/g, "_").slice(0, 70);
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))].sort();
}

function validHash(value) {
  return /^sha256:[a-f0-9]{64}$/.test(String(value ?? ""));
}

function hashCanonical(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(",")}}`;
}

function finiteJsonClone(value) {
  if (value == null) return null;
  try {
    const clone = structuredClone(value);
    JSON.stringify(clone, (_key, item) => {
      if (typeof item === "number" && !Number.isFinite(item)) throw new TypeError("non_finite");
      if (item === undefined) throw new TypeError("undefined");
      return item;
    });
    return clone;
  } catch {
    return null;
  }
}

function inputError(code, message, details = {}) {
  return new TierBTechnicalEvidenceInputError(code, message, details);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
