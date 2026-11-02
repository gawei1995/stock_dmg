import { createHash } from "node:crypto";

import { calculateDailyExcessReturns, buildDailySequence, normalizeCompletedDailyBars } from "./daily-sequence.mjs";
import { calculateTechnical, EMA_PERIODS } from "./technical.mjs";
import { buildTechnicalV2 } from "./technical-v2.mjs";

export const TIER_A_TECHNICAL_SCAN_SCHEMA_VERSION = "tier-a-technical-scan/v1";
export const TIER_A_TECHNICAL_SCAN_DEFAULT_MAX_SYMBOLS = 50;
export const TIER_A_TECHNICAL_SCAN_HARD_MAX_SYMBOLS = 100;
export const TIER_A_TECHNICAL_SCAN_MAX_BARS_PER_SYMBOL = 1_200;
export const TIER_A_TECHNICAL_SCAN_DEFAULT_RANKING_LIMIT = 20;

const DEFAULT_BENCHMARK_SYMBOL = "QQQ.US";
const RETURN_WINDOWS = Object.freeze(["1", "3", "5", "10", "20"]);
const FORMING_STATES = new Set([
  "forming",
  "open",
  "partial",
  "updating",
  "realtime",
  "live",
]);
const STATE_FIELDS = Object.freeze([
  "coverageStatus",
  "technicalStatus",
  "dailySequenceStatus",
  "shortStructure",
  "longStructure",
  "priceVsEma21",
  "weeklyDirection",
  "weeklySwing",
  "costMigration",
  "cost14Location",
  "cost14Acceptance",
  "cost28Location",
  "cost28Acceptance",
  "qqqExcess5State",
  "qqqExcess20State",
  "sectorExcess20State",
  "marketEvidenceState",
]);

export class TierATechnicalScanInputError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TierATechnicalScanInputError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Build a deterministic, bounded Tier A observability scan from completed
 * daily OHLCV. This pure calculator does not fetch data, use an LLM, select an
 * AVWAP anchor, inspect options, or produce a trade signal.
 */
export function buildTierATechnicalBatchScan({
  holdings = [],
  watchlist = [],
  dailyBySymbol = {},
  benchmarkSymbol = DEFAULT_BENCHMARK_SYMBOL,
  sectorBySymbol = {},
  cutoff = null,
  analysisTime = null,
  previousBatch = null,
  maxSymbols = TIER_A_TECHNICAL_SCAN_DEFAULT_MAX_SYMBOLS,
  rankingLimit = null,
} = {}) {
  const normalizedHoldings = normalizeSymbolList(holdings, "holdings");
  const normalizedWatchlist = normalizeSymbolList(watchlist, "watchlist");
  const normalizedBenchmark = normalizeSymbol(benchmarkSymbol, "benchmarkSymbol");
  const normalizedDailyMap = normalizeDailyMap(dailyBySymbol);
  const normalizedSectorMap = normalizeSectorMap(sectorBySymbol);
  const scanLimit = boundedInteger(
    maxSymbols,
    "maxSymbols",
    1,
    TIER_A_TECHNICAL_SCAN_HARD_MAX_SYMBOLS,
  );
  const rankLimit = boundedInteger(
    rankingLimit ?? Math.min(TIER_A_TECHNICAL_SCAN_DEFAULT_RANKING_LIMIT, scanLimit),
    "rankingLimit",
    1,
    scanLimit,
  );
  const universe = buildUniverse(normalizedHoldings, normalizedWatchlist, scanLimit);
  const baseDatasets = new Map();
  const baseDataset = (symbol) => {
    if (!baseDatasets.has(symbol)) {
      baseDatasets.set(symbol, normalizeBaseDataset(symbol, normalizedDailyMap.get(symbol)));
    }
    return baseDatasets.get(symbol);
  };
  const cutoffResolution = resolveCutoff(cutoff, baseDataset(normalizedBenchmark));
  const evaluatedAt = resolveAnalysisTime(analysisTime, cutoffResolution.cutoff);

  const requiredSymbols = new Set([
    ...universe.selectedSymbols,
    normalizedBenchmark,
    ...universe.selectedSymbols
      .map((symbol) => normalizedSectorMap.get(symbol))
      .filter(Boolean),
  ]);
  const datasets = new Map([...requiredSymbols].map((symbol) => [
    symbol,
    finalizeDataset(baseDataset(symbol), cutoffResolution.cutoff),
  ]));
  const benchmark = datasets.get(normalizedBenchmark);
  const previous = normalizePreviousBatch(previousBatch, cutoffResolution.cutoff);

  const cards = universe.selectedSymbols.map((symbol) => buildCard({
    symbol,
    memberships: universe.memberships.get(symbol),
    dataset: datasets.get(symbol),
    benchmark,
    benchmarkSymbol: normalizedBenchmark,
    sectorSymbol: normalizedSectorMap.get(symbol) ?? null,
    sectorDataset: normalizedSectorMap.has(symbol)
      ? datasets.get(normalizedSectorMap.get(symbol))
      : null,
    cutoff: cutoffResolution.cutoff,
    analysisTime: evaluatedAt,
    previousCard: previous.cardsBySymbol.get(symbol) ?? null,
    comparisonEnabled: previous.status === "available",
  }));
  const cardsBySymbol = new Map(cards.map((card) => [card.symbol, card]));
  const removedSymbols = previous.status === "available"
    ? [...previous.cardsBySymbol.keys()]
      .filter((symbol) => !cardsBySymbol.has(symbol))
      .sort()
    : [];
  const rankings = buildRankings(cards, rankLimit);
  const coverage = buildCoverage(universe, cards, normalizedBenchmark, benchmark);
  const capabilityMatrix = aggregateCapabilityMatrix(cards);
  const currentFingerprint = cards.map((card) => ({
    symbol: card.symbol,
    memberships: card.memberships,
    inputHash: card.inputHash,
    observableState: card.observableState,
  }));
  const inputHash = hashCanonical({
    schemaVersion: TIER_A_TECHNICAL_SCAN_SCHEMA_VERSION,
    cutoff: cutoffResolution.cutoff,
    cutoffSource: cutoffResolution.source,
    analysisTime: evaluatedAt,
    benchmarkSymbol: normalizedBenchmark,
    maxSymbols: scanLimit,
    rankingLimit: rankLimit,
    selectedSymbols: universe.selectedSymbols,
    omittedSymbols: universe.omittedSymbols,
    sectorBySymbol: Object.fromEntries(
      [...normalizedSectorMap.entries()]
        .filter(([symbol]) => universe.selectedSymbols.includes(symbol))
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
    benchmarkDataset: datasetHashReference(benchmark),
    cards: currentFingerprint,
    previous: previous.fingerprint,
  });

  return deepFreeze({
    schemaVersion: TIER_A_TECHNICAL_SCAN_SCHEMA_VERSION,
    status: batchStatus(coverage),
    cutoff: cutoffResolution.cutoff,
    cutoffSource: cutoffResolution.source,
    analysisTime: evaluatedAt,
    benchmarkSymbol: normalizedBenchmark,
    inputHash,
    cacheKey: `tier-a-technical-scan:${inputHash}`,
    limits: {
      maxSymbols: scanLimit,
      hardMaxSymbols: TIER_A_TECHNICAL_SCAN_HARD_MAX_SYMBOLS,
      maxBarsPerSymbol: TIER_A_TECHNICAL_SCAN_MAX_BARS_PER_SYMBOL,
      rankingLimit: rankLimit,
    },
    coverage,
    cards,
    rankings,
    comparison: {
      status: previous.status,
      previousCutoff: previous.cutoff,
      reasonCodes: previous.reasonCodes,
      removedSymbols,
    },
    capabilityMatrix,
    method: {
      engine: "deterministic_existing_technical_modules",
      reusedModules: [
        "technical.mjs",
        "technical-v2.mjs",
        "daily-sequence.mjs",
        "cost-concentration.mjs",
        "market-evidence.mjs_via_technical",
      ],
      cutoffPolicy: "exact_shared_trade_date",
      missingDatePolicy: "no_forward_fill",
      universePolicy: "holdings_first_then_watchlist_alphabetical_with_explicit_omissions",
      changePolicy: "categorical_observable_state_transitions_only",
      anomalyPolicy: "coverage_then_observed_range_volume_return_magnitudes",
      tradingSignal: false,
      llmUsed: false,
      automaticAnchoredVwap: false,
      optionsInference: false,
    },
    limitations: [
      "Rankings are an observability triage order, not an entry, exit, sizing, or recommendation score.",
      "Daily cost concentration remains the existing low-confidence uniform-range OHLCV proxy, not holder cost basis.",
      "Sector comparison is N/A unless the caller explicitly maps a sector symbol and supplies an exact-cutoff series.",
      "Anchored VWAP is intentionally absent because this scanner never selects an anchor.",
      "Options and positioning are intentionally absent without a sourced chain contract.",
    ],
    advisory: true,
    decisionAuthority: "LLM",
  });
}

function buildCard({
  symbol,
  memberships,
  dataset,
  benchmark,
  benchmarkSymbol,
  sectorSymbol,
  sectorDataset,
  cutoff,
  analysisTime,
  previousCard,
  comparisonEnabled,
}) {
  if (!dataset?.usable) {
    const card = unavailableCard({
      symbol,
      memberships,
      cutoff,
      dataset,
      benchmarkSymbol,
      sectorSymbol,
    });
    card.comparison = compareCard(card, previousCard, comparisonEnabled);
    return card;
  }

  try {
    const technical = calculateTechnical(dataset.bars, {
      symbol,
      analysisTime,
      coverage: dataset.coverageForCutoff,
    });
    const multi = buildTechnicalV2({
      dailyTechnical: technical,
      dailyCompletedBars: dataset.bars,
      horizon: "position",
    });
    const qqqExcess = benchmark?.usable
      ? calculateDailyExcessReturns(dataset.bars, benchmark.bars)
      : unavailableExcess("benchmark_exact_cutoff_unavailable");
    const sectorExcess = !sectorSymbol
      ? unavailableExcess("sector_not_mapped")
      : sectorDataset?.usable
        ? calculateDailyExcessReturns(dataset.bars, sectorDataset.bars)
        : unavailableExcess("sector_exact_cutoff_unavailable");
    const metrics = compactMetrics(technical.dailySequence, qqqExcess, sectorExcess);
    const capabilityMatrix = cardCapabilityMatrix({
      technical,
      multi,
      qqqExcess,
      benchmark,
      sectorSymbol,
      sectorDataset,
      sectorExcess,
    });
    const degradedReasons = collectDegradedReasons({
      technical,
      multi,
      benchmark,
      qqqExcess,
      sectorSymbol,
      sectorDataset,
      sectorExcess,
      dataset,
    });
    const status = classifyCardStatus({
      technical,
      multi,
      benchmark,
      qqqExcess,
      sectorSymbol,
      sectorDataset,
      sectorExcess,
      dataset,
    });
    const cost = compactCost(multi.costProfile14d28d);
    const weekly = compactWeekly(multi.weekly);
    const ema = compactEma(technical);
    const observableState = buildObservableState({
      status,
      technical,
      ema,
      weekly,
      cost,
      qqqExcess,
      sectorExcess,
      sectorSymbol,
    });
    const inputHash = hashCanonical({
      symbol,
      memberships,
      cutoff,
      analysisTime,
      targetInput: compactInput(dataset),
      targetReasonCodes: dataset.reasonCodes,
      benchmarkSymbol,
      benchmark: datasetHashReference(benchmark),
      sectorSymbol,
      sector: datasetHashReference(sectorDataset),
      coverage: dataset.coverageForCutoff,
    });
    const card = {
      symbol,
      memberships,
      status,
      cutoff,
      inputHash,
      cacheKey: `tier-a-technical-card:${symbol}:${inputHash}`,
      input: compactInput(dataset),
      lastClose: availableValue(technical.lastPrice, "price", "last_close_unavailable"),
      ema,
      structure: {
        short: technical.shortStructure ?? "N/A",
        long: technical.longStructure ?? "N/A",
        priceVsEma21: priceRelation(technical.lastPrice, technical.ema?.[21]),
      },
      metrics,
      weekly,
      costProfile14d28d: cost,
      benchmark: {
        symbol: benchmarkSymbol,
        status: qqqExcess.status,
        inputHash: benchmark?.inputHash ?? null,
        exactCutoff: Boolean(benchmark?.usable),
      },
      sector: {
        symbol: sectorSymbol,
        status: !sectorSymbol ? "not_applicable" : sectorExcess.status,
        inputHash: sectorDataset?.inputHash ?? null,
        exactCutoff: Boolean(sectorDataset?.usable),
      },
      marketEvidence: compactMarketEvidence(technical.marketData),
      degradedReasons,
      capabilityMatrix,
      observableState,
      comparison: null,
      advisory: true,
      decisionAuthority: "LLM",
    };
    card.comparison = compareCard(card, previousCard, comparisonEnabled);
    return card;
  } catch (error) {
    const failedDataset = {
      ...dataset,
      usable: false,
      reasonCodes: uniqueSorted([
        ...dataset.reasonCodes,
        String(error?.code ?? "technical_calculation_failed"),
      ]),
    };
    const card = unavailableCard({
      symbol,
      memberships,
      cutoff,
      dataset: failedDataset,
      benchmarkSymbol,
      sectorSymbol,
    });
    card.comparison = compareCard(card, previousCard, comparisonEnabled);
    return card;
  }
}

function unavailableCard({ symbol, memberships, cutoff, dataset, benchmarkSymbol, sectorSymbol }) {
  const reasonCodes = uniqueSorted(dataset?.reasonCodes?.length
    ? dataset.reasonCodes
    : ["daily_dataset_unavailable"]);
  const inputHash = hashCanonical({
    symbol,
    memberships,
    cutoff,
    datasetFingerprint: dataset?.rawFingerprint ?? null,
    reasonCodes,
    benchmarkSymbol,
    sectorSymbol,
  });
  const metrics = compactMetrics(null, unavailableExcess("target_unavailable"), unavailableExcess(
    sectorSymbol ? "target_unavailable" : "sector_not_mapped",
  ));
  const capabilityMatrix = unavailableCardCapabilities(sectorSymbol);
  const observableState = {
    coverageStatus: "unavailable",
    technicalStatus: "N/A",
    dailySequenceStatus: "N/A",
    shortStructure: "N/A",
    longStructure: "N/A",
    priceVsEma21: "N/A",
    weeklyDirection: "N/A",
    weeklySwing: "N/A",
    costMigration: "N/A",
    cost14Location: "N/A",
    cost14Acceptance: "N/A",
    cost28Location: "N/A",
    cost28Acceptance: "N/A",
    qqqExcess5State: "N/A",
    qqqExcess20State: "N/A",
    sectorExcess20State: "N/A",
    marketEvidenceState: "N/A",
  };
  return {
    symbol,
    memberships,
    status: "unavailable",
    cutoff,
    inputHash,
    cacheKey: `tier-a-technical-card:${symbol}:${inputHash}`,
    input: compactInput(dataset),
    lastClose: unavailableValue("price", "target_unavailable"),
    ema: Object.fromEntries(EMA_PERIODS.map((period) => [
      String(period),
      unavailableValue("price", "target_unavailable"),
    ])),
    structure: { short: "N/A", long: "N/A", priceVsEma21: "N/A" },
    metrics,
    weekly: unavailableWeekly("target_unavailable"),
    costProfile14d28d: unavailableCost("target_unavailable"),
    benchmark: {
      symbol: benchmarkSymbol,
      status: "unavailable",
      inputHash: null,
      exactCutoff: false,
    },
    sector: {
      symbol: sectorSymbol,
      status: sectorSymbol ? "unavailable" : "not_applicable",
      inputHash: null,
      exactCutoff: false,
    },
    marketEvidence: unavailableCapability("target_unavailable"),
    degradedReasons: reasonCodes,
    capabilityMatrix,
    observableState,
    comparison: null,
    advisory: true,
    decisionAuthority: "LLM",
  };
}

function normalizeBaseDataset(symbol, descriptor) {
  const rawFingerprint = boundedDatasetFingerprint(symbol, descriptor);
  if (descriptor == null) {
    return invalidDataset(symbol, rawFingerprint, ["daily_dataset_not_provided"]);
  }
  if (Array.isArray(descriptor)) {
    return invalidDataset(symbol, rawFingerprint, ["completed_bars_not_explicitly_attested"]);
  }
  if (typeof descriptor !== "object") {
    return invalidDataset(symbol, rawFingerprint, ["daily_dataset_invalid"]);
  }
  if (descriptor.completedBarsOnly !== true) {
    return invalidDataset(symbol, rawFingerprint, ["completed_bars_not_explicitly_attested"]);
  }
  if (!Array.isArray(descriptor.bars)) {
    return invalidDataset(symbol, rawFingerprint, ["daily_bars_not_array"]);
  }
  if (descriptor.bars.length > TIER_A_TECHNICAL_SCAN_MAX_BARS_PER_SYMBOL) {
    return invalidDataset(symbol, rawFingerprint, ["daily_bar_limit_exceeded"]);
  }
  const explicitFormingIndex = descriptor.bars.findIndex(isExplicitlyForming);
  if (explicitFormingIndex >= 0) {
    return invalidDataset(symbol, rawFingerprint, ["forming_bar_not_allowed"]);
  }
  try {
    const normalized = normalizeCompletedDailyBars(descriptor.bars);
    const bars = normalized.map((bar) => ({
      tradeDate: tradeDateFromIdentity(bar.identity),
      timestamp: `${tradeDateFromIdentity(bar.identity)}T23:59:59.000Z`,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      isClosed: true,
    }));
    for (let index = 1; index < bars.length; index += 1) {
      if (bars[index].tradeDate <= bars[index - 1].tradeDate) {
        return invalidDataset(symbol, rawFingerprint, ["daily_trade_dates_not_strictly_ascending"]);
      }
    }
    const sequence = buildDailySequence(bars);
    return {
      symbol,
      valid: true,
      usable: false,
      bars,
      source: textOrNull(descriptor.source) ?? "caller_supplied",
      coverage: descriptor.coverage && typeof descriptor.coverage === "object"
        ? stableClone(descriptor.coverage)
        : null,
      rawBarCount: descriptor.bars.length,
      rawFingerprint,
      fullInputHash: sequence.inputHash,
      inputHash: null,
      reasonCodes: [],
    };
  } catch (error) {
    return invalidDataset(symbol, rawFingerprint, [
      String(error?.code ?? "daily_dataset_invalid"),
    ]);
  }
}

function finalizeDataset(base, cutoff) {
  if (!base.valid) return { ...base, cutoff, exactCutoff: false };
  const bars = base.bars.filter((bar) => bar.tradeDate <= cutoff);
  if (!bars.length) {
    return {
      ...base,
      bars: [],
      cutoff,
      usable: false,
      exactCutoff: false,
      inputHash: null,
      coverageForCutoff: null,
      ignoredAfterCutoffCount: base.bars.length,
      reasonCodes: ["no_daily_bars_at_or_before_cutoff"],
    };
  }
  const exactCutoff = bars.at(-1).tradeDate === cutoff;
  const sequence = buildDailySequence(bars);
  const coverageDate = dateOnly(base.coverage?.latestTradeDate);
  const coverageMatches = !base.coverage || !coverageDate || coverageDate === cutoff;
  return {
    ...base,
    bars,
    cutoff,
    usable: exactCutoff,
    exactCutoff,
    inputHash: sequence.inputHash,
    coverageForCutoff: coverageMatches ? base.coverage : null,
    ignoredAfterCutoffCount: base.rawBarCount - bars.length,
    reasonCodes: uniqueSorted([
      ...(exactCutoff ? [] : ["exact_cutoff_bar_missing_no_forward_fill"]),
      ...(coverageMatches ? [] : ["coverage_cutoff_mismatch"]),
    ]),
  };
}

function invalidDataset(symbol, rawFingerprint, reasonCodes) {
  return {
    symbol,
    valid: false,
    usable: false,
    bars: [],
    source: null,
    coverage: null,
    coverageForCutoff: null,
    rawBarCount: 0,
    ignoredAfterCutoffCount: 0,
    rawFingerprint,
    fullInputHash: null,
    inputHash: null,
    exactCutoff: false,
    reasonCodes: uniqueSorted(reasonCodes),
  };
}

function compactMetrics(sequence, qqqExcess, sectorExcess) {
  return {
    returns: Object.fromEntries(RETURN_WINDOWS.map((window) => [
      window,
      compactMetric(sequence?.metrics?.returns?.[window], "percent_point", "daily_return_unavailable"),
    ])),
    closeLocationValue: compactMetric(
      sequence?.metrics?.closeLocationValue,
      "ratio",
      "close_location_unavailable",
    ),
    normalizedTrueRangeAtr14: compactMetric(
      sequence?.metrics?.normalizedTrueRangeAtr14,
      "multiple",
      "normalized_range_unavailable",
    ),
    gapPercent: compactMetric(sequence?.metrics?.gapPercent, "percent_point", "gap_unavailable"),
    relativeVolume20: compactMetric(
      sequence?.metrics?.relativeVolume20,
      "multiple",
      "relative_volume_unavailable",
    ),
    directionalEfficiency10: compactMetric(
      sequence?.metrics?.directionalEfficiency?.["10"],
      "ratio",
      "directional_efficiency_unavailable",
    ),
    directionalEfficiency20: compactMetric(
      sequence?.metrics?.directionalEfficiency?.["20"],
      "ratio",
      "directional_efficiency_unavailable",
    ),
    qqqExcessReturns: compactExcess(qqqExcess),
    sectorExcessReturns: compactExcess(sectorExcess),
  };
}

function compactExcess(excess) {
  return Object.fromEntries(RETURN_WINDOWS.map((window) => [
    window,
    compactMetric(excess?.windows?.[window], "percent_point", "excess_return_unavailable"),
  ]));
}

function compactMetric(metric, fallbackUnit, fallbackReason) {
  if (metric?.status === "available" && isFiniteNumeric(metric.value)) {
    return {
      status: "available",
      value: Number(metric.value),
      display: null,
      unit: metric.unit ?? fallbackUnit,
      reason: null,
    };
  }
  return unavailableValue(
    metric?.unit ?? fallbackUnit,
    metric?.reason ?? fallbackReason,
  );
}

function availableValue(value, unit, unavailableReason) {
  return isFiniteNumeric(value)
    ? { status: "available", value: Number(value), display: null, unit, reason: null }
    : unavailableValue(unit, unavailableReason);
}

function unavailableValue(unit, reason) {
  return { status: "unavailable", value: null, display: "N/A", unit, reason };
}

function compactEma(technical) {
  return Object.fromEntries(EMA_PERIODS.map((period) => {
    const value = technical.ema?.[period];
    const maturity = technical.emaMaturity?.[period] ?? null;
    return [String(period), {
      ...availableValue(value, "price", `ema_${period}_unavailable`),
      slope5SessionsPercent: isFiniteNumeric(technical.emaSlope5d?.[period])
        ? Number(technical.emaSlope5d[period])
        : null,
      maturity: maturity?.status ?? "unavailable",
      requiredBarCount: maturity?.requiredBarCount ?? period,
      barCount: maturity?.barCount ?? technical.calculationBarCount ?? 0,
    }];
  }));
}

function compactWeekly(weekly) {
  if (weekly?.status !== "available") {
    return unavailableWeekly(weekly?.reasonCodes?.[0] ?? "weekly_unavailable");
  }
  return {
    status: "available",
    asOf: weekly.asOf ?? null,
    direction: weekly.direction ?? "N/A",
    swing: weekly.swing ?? "N/A",
    return4WeeksPercent: availableValue(
      weekly.metrics?.return4WeeksPercent,
      "percent_point",
      "weekly_return4_unavailable",
    ),
    return12WeeksPercent: availableValue(
      weekly.metrics?.return12WeeksPercent,
      "percent_point",
      "weekly_return12_unavailable",
    ),
    inputHash: weekly.input?.inputHash ?? null,
  };
}

function unavailableWeekly(reason) {
  return {
    status: "unavailable",
    asOf: null,
    direction: "N/A",
    swing: "N/A",
    return4WeeksPercent: unavailableValue("percent_point", reason),
    return12WeeksPercent: unavailableValue("percent_point", reason),
    inputHash: null,
  };
}

function compactCost(cost) {
  if (!cost || cost.status === "unavailable") {
    return unavailableCost(cost?.reasonCodes?.[0] ?? "cost_profile_unavailable");
  }
  const profile = (window) => {
    const value = cost.profiles?.[String(window)];
    if (value?.status !== "available") {
      return {
        status: "unavailable",
        poc: unavailableValue("price", value?.reasonCode ?? "profile_unavailable"),
        valueArea: {
          low: unavailableValue("price", value?.reasonCode ?? "profile_unavailable"),
          high: unavailableValue("price", value?.reasonCode ?? "profile_unavailable"),
        },
        currentPriceLocation: "N/A",
        acceptance: "N/A",
      };
    }
    return {
      status: "available",
      poc: availableValue(value.poc, "price", "poc_unavailable"),
      valueArea: {
        low: availableValue(value.val, "price", "val_unavailable"),
        high: availableValue(value.vah, "price", "vah_unavailable"),
      },
      currentPriceLocation: value.currentPriceLocation ?? "N/A",
      acceptance: value.acceptance?.state ?? "N/A",
    };
  };
  return {
    status: cost.status,
    methodVersion: cost.methodVersion ?? null,
    inputHash: cost.input?.inputHash ?? null,
    profile14: profile(14),
    profile28: profile(28),
    comparison: cost.comparison?.status === "available"
      ? {
          status: "available",
          migrationState: cost.comparison.migrationState ?? "N/A",
          pocShift: availableValue(cost.comparison.pocShift, "price", "poc_shift_unavailable"),
          valueAreaOverlapRatio: availableValue(
            cost.comparison.valueAreaOverlapRatio,
            "ratio",
            "value_area_overlap_unavailable",
          ),
        }
      : {
          status: "unavailable",
          migrationState: "N/A",
          pocShift: unavailableValue("price", "cost_comparison_unavailable"),
          valueAreaOverlapRatio: unavailableValue("ratio", "cost_comparison_unavailable"),
        },
    confidence: "low_daily_ohlcv_proxy",
  };
}

function unavailableCost(reason) {
  const profile = {
    status: "unavailable",
    poc: unavailableValue("price", reason),
    valueArea: {
      low: unavailableValue("price", reason),
      high: unavailableValue("price", reason),
    },
    currentPriceLocation: "N/A",
    acceptance: "N/A",
  };
  return {
    status: "unavailable",
    methodVersion: null,
    inputHash: null,
    profile14: stableClone(profile),
    profile28: stableClone(profile),
    comparison: {
      status: "unavailable",
      migrationState: "N/A",
      pocShift: unavailableValue("price", reason),
      valueAreaOverlapRatio: unavailableValue("ratio", reason),
    },
    confidence: "N/A",
  };
}

function compactMarketEvidence(value) {
  if (!value) return unavailableCapability("coverage_not_supplied");
  return {
    status: value.freshForSizing
      ? "sizing_ready"
      : value.freshForDecision
        ? "decision_ready"
        : value.freshForResearch
          ? "research_only"
          : "unavailable",
    latestTradeDate: value.latestTradeDate ?? null,
    expectedLatestTradeDate: value.expectedLatestTradeDate ?? null,
    source: value.source ?? null,
    fetchedAt: value.fetchedAt ?? null,
    reasonCodes: uniqueSorted(value.reasonCodes ?? []),
  };
}

function buildObservableState({
  status,
  technical,
  ema,
  weekly,
  cost,
  qqqExcess,
  sectorExcess,
  sectorSymbol,
}) {
  return {
    coverageStatus: status,
    technicalStatus: technical.status ?? "N/A",
    dailySequenceStatus: technical.dailySequence?.status ?? "N/A",
    shortStructure: technical.shortStructure ?? "N/A",
    longStructure: technical.longStructure ?? "N/A",
    priceVsEma21: priceRelation(technical.lastPrice, ema["21"]?.value),
    weeklyDirection: weekly.direction,
    weeklySwing: weekly.swing,
    costMigration: cost.comparison.migrationState,
    cost14Location: cost.profile14.currentPriceLocation,
    cost14Acceptance: cost.profile14.acceptance,
    cost28Location: cost.profile28.currentPriceLocation,
    cost28Acceptance: cost.profile28.acceptance,
    qqqExcess5State: metricSignState(qqqExcess?.windows?.["5"]),
    qqqExcess20State: metricSignState(qqqExcess?.windows?.["20"]),
    sectorExcess20State: sectorSymbol
      ? metricSignState(sectorExcess?.windows?.["20"])
      : "N/A",
    marketEvidenceState: compactMarketEvidence(technical.marketData).status,
  };
}

function compareCard(card, previousCard, enabled) {
  if (!enabled) {
    return { status: "not_compared", kind: "N/A", changedFields: [] };
  }
  if (!previousCard) {
    return {
      status: "available",
      kind: "new_symbol",
      changedFields: [{ field: "universeMembership", from: "N/A", to: card.memberships.join("+") }],
    };
  }
  const prior = previousCard.observableState && typeof previousCard.observableState === "object"
    ? previousCard.observableState
    : {};
  const changedFields = STATE_FIELDS.flatMap((field) => {
    const from = normalizeStateValue(prior[field]);
    const to = normalizeStateValue(card.observableState[field]);
    return from === to ? [] : [{ field, from, to }];
  });
  return {
    status: "available",
    kind: changedFields.length ? "state_changed" : "unchanged",
    changedFields,
  };
}

function buildRankings(cards, limit) {
  const changes = cards
    .filter((card) => ["state_changed", "new_symbol"].includes(card.comparison.kind))
    .map((card) => ({
      symbol: card.symbol,
      kind: card.comparison.kind,
      changedFieldCount: card.comparison.changedFields.length,
      changedFields: card.comparison.changedFields,
      observableOnly: true,
    }))
    .sort((left, right) => {
      const leftCoverage = left.changedFields.some(({ field }) => field === "coverageStatus") ? 1 : 0;
      const rightCoverage = right.changedFields.some(({ field }) => field === "coverageStatus") ? 1 : 0;
      return rightCoverage - leftCoverage
        || right.changedFieldCount - left.changedFieldCount
        || left.symbol.localeCompare(right.symbol);
    })
    .slice(0, limit);
  const anomalies = cards.map((card) => ({
    symbol: card.symbol,
    status: card.status,
    degradedReasonCount: card.degradedReasons.length,
    normalizedTrueRangeAtr14: finiteOrNull(card.metrics.normalizedTrueRangeAtr14.value),
    relativeVolume20: finiteOrNull(card.metrics.relativeVolume20.value),
    absoluteReturn1Percent: absoluteOrNull(card.metrics.returns["1"].value),
    absoluteQqqExcess5Percent: absoluteOrNull(card.metrics.qqqExcessReturns["5"].value),
    observableOnly: true,
  })).sort(compareAnomalyRows).slice(0, limit);
  return {
    changes: {
      status: cards.some((card) => card.comparison.status === "available")
        ? "available"
        : "not_compared",
      rows: changes,
      sortBasis: [
        "coverage_state_change_first",
        "changed_categorical_field_count_desc",
        "symbol_asc",
      ],
    },
    anomalies: {
      status: cards.length ? "available" : "unavailable",
      rows: anomalies,
      sortBasis: [
        "coverage_severity_desc",
        "degraded_reason_count_desc",
        "normalized_true_range_atr14_desc",
        "relative_volume20_desc",
        "absolute_return1_desc",
        "absolute_qqq_excess5_desc",
        "symbol_asc",
      ],
    },
    interpretation: "descriptive_observability_only_not_a_trading_signal",
  };
}

function compareAnomalyRows(left, right) {
  return statusSeverity(right.status) - statusSeverity(left.status)
    || right.degradedReasonCount - left.degradedReasonCount
    || sortableNumber(right.normalizedTrueRangeAtr14) - sortableNumber(left.normalizedTrueRangeAtr14)
    || sortableNumber(right.relativeVolume20) - sortableNumber(left.relativeVolume20)
    || sortableNumber(right.absoluteReturn1Percent) - sortableNumber(left.absoluteReturn1Percent)
    || sortableNumber(right.absoluteQqqExcess5Percent) - sortableNumber(left.absoluteQqqExcess5Percent)
    || left.symbol.localeCompare(right.symbol);
}

function cardCapabilityMatrix({
  technical,
  multi,
  qqqExcess,
  benchmark,
  sectorSymbol,
  sectorDataset,
  sectorExcess,
}) {
  return {
    dailyFastEma: capabilityFromScalarStatus(technical.capabilityMatrix?.dailyFastEma),
    dailyLongEma: capabilityFromScalarStatus(technical.capabilityMatrix?.dailyLongEma),
    dailySequence: capabilityFromScalarStatus(technical.dailySequence?.status),
    weeklyStructure: compactCapability(multi.capabilityMatrix?.weeklyStructure),
    costProfile14d28d: compactCapability(multi.capabilityMatrix?.costProfile14d28d),
    benchmarkRelativeStrength: excessCapability(qqqExcess, benchmark),
    sectorRelativeStrength: !sectorSymbol
      ? notApplicableCapability("sector_not_mapped")
      : excessCapability(sectorExcess, sectorDataset),
    marketEvidence: technical.marketData
      ? {
          status: technical.marketData.freshForResearch ? "complete" : "unavailable",
          reasonCodes: uniqueSorted(technical.marketData.reasonCodes ?? []),
        }
      : unavailableCapability("coverage_not_supplied"),
    anchoredVwap: unavailableCapability("explicit_anchor_required_batch_does_not_select_anchor"),
    optionsStructure: unavailableCapability("options_chain_not_supplied_batch_does_not_infer_positioning"),
    tradingDecision: notApplicableCapability("observability_scan_has_no_trading_signal"),
  };
}

function unavailableCardCapabilities(sectorSymbol) {
  return {
    dailyFastEma: unavailableCapability("target_unavailable"),
    dailyLongEma: unavailableCapability("target_unavailable"),
    dailySequence: unavailableCapability("target_unavailable"),
    weeklyStructure: unavailableCapability("target_unavailable"),
    costProfile14d28d: unavailableCapability("target_unavailable"),
    benchmarkRelativeStrength: unavailableCapability("target_unavailable"),
    sectorRelativeStrength: sectorSymbol
      ? unavailableCapability("target_unavailable")
      : notApplicableCapability("sector_not_mapped"),
    marketEvidence: unavailableCapability("target_unavailable"),
    anchoredVwap: unavailableCapability("explicit_anchor_required_batch_does_not_select_anchor"),
    optionsStructure: unavailableCapability("options_chain_not_supplied_batch_does_not_infer_positioning"),
    tradingDecision: notApplicableCapability("observability_scan_has_no_trading_signal"),
  };
}

function collectDegradedReasons({
  technical,
  multi,
  benchmark,
  qqqExcess,
  sectorSymbol,
  sectorDataset,
  sectorExcess,
  dataset,
}) {
  return uniqueSorted([
    ...dataset.reasonCodes,
    ...(technical.status === "complete" ? [] : [technical.reason ?? `daily_technical_${technical.status}`]),
    ...(multi.capabilityMatrix?.weeklyStructure?.status === "complete"
      ? []
      : ["weekly_structure_incomplete"]),
    ...(multi.capabilityMatrix?.costProfile14d28d?.status === "complete"
      ? []
      : ["cost_profile_14_28_incomplete"]),
    ...(benchmark?.usable ? [] : ["benchmark_exact_cutoff_unavailable"]),
    ...(qqqExcess.status === "complete" ? [] : [`benchmark_excess_${qqqExcess.status}`]),
    ...(sectorSymbol && !sectorDataset?.usable ? ["sector_exact_cutoff_unavailable"] : []),
    ...(sectorSymbol && sectorExcess.status !== "complete"
      ? [`sector_excess_${sectorExcess.status}`]
      : []),
    ...(technical.marketData?.freshForResearch === false
      ? technical.marketData.reasonCodes.map((reason) => `market_evidence:${reason}`)
      : []),
  ]);
}

function classifyCardStatus({
  technical,
  multi,
  benchmark,
  qqqExcess,
  sectorSymbol,
  sectorDataset,
  sectorExcess,
  dataset,
}) {
  const dailyCore = technical.calculationBarCount >= 21
    && technical.dailySequence?.status !== "unavailable";
  const researchCoverageFailed = technical.marketData
    && technical.marketData.freshForResearch !== true;
  if (!dailyCore || !benchmark?.usable || qqqExcess.status === "unavailable"
    || researchCoverageFailed) return "degraded";
  const complete = technical.status === "complete"
    && technical.dailySequence?.status === "complete"
    && multi.capabilityMatrix?.weeklyStructure?.status === "complete"
    && multi.capabilityMatrix?.costProfile14d28d?.status === "complete"
    && qqqExcess.status === "complete"
    && dataset.reasonCodes.length === 0
    && (!sectorSymbol || (sectorDataset?.usable && sectorExcess.status === "complete"));
  return complete ? "complete" : "partial";
}

function aggregateCapabilityMatrix(cards) {
  const keys = [
    "dailyFastEma",
    "dailyLongEma",
    "dailySequence",
    "weeklyStructure",
    "costProfile14d28d",
    "benchmarkRelativeStrength",
    "sectorRelativeStrength",
    "marketEvidence",
    "anchoredVwap",
    "optionsStructure",
    "tradingDecision",
  ];
  return Object.fromEntries(keys.map((key) => {
    const statuses = cards.map((card) => card.capabilityMatrix[key]?.status ?? "unavailable");
    const counts = Object.fromEntries(
      [...new Set(["complete", "partial", "warming", "unavailable", "not_applicable", ...statuses])]
        .map((status) => [status, statuses.filter((value) => value === status).length]),
    );
    const applicable = statuses.filter((status) => status !== "not_applicable");
    const status = !applicable.length
      ? "not_applicable"
      : applicable.every((value) => value === "complete")
        ? "complete"
        : applicable.every((value) => value === "unavailable")
          ? "unavailable"
          : "partial";
    return [key, { status, counts }];
  }));
}

function buildCoverage(universe, cards, benchmarkSymbol, benchmark) {
  const counts = {
    complete: cards.filter((card) => card.status === "complete").length,
    partial: cards.filter((card) => card.status === "partial").length,
    degraded: cards.filter((card) => card.status === "degraded").length,
    unavailable: cards.filter((card) => card.status === "unavailable").length,
  };
  return {
    status: cards.length === 0 || counts.unavailable === cards.length
      ? "unavailable"
      : universe.omittedSymbols.length || counts.partial || counts.degraded || counts.unavailable
        ? "partial"
        : "complete",
    requestedSymbolCount: universe.requestedSymbols.length,
    selectedSymbolCount: universe.selectedSymbols.length,
    omittedSymbolCount: universe.omittedSymbols.length,
    selectedSymbols: [...universe.selectedSymbols],
    omittedSymbols: [...universe.omittedSymbols],
    omittedHoldingSymbols: universe.omittedHoldingSymbols,
    omittedWatchlistSymbols: universe.omittedWatchlistSymbols,
    cardCounts: counts,
    benchmark: {
      symbol: benchmarkSymbol,
      exactCutoff: Boolean(benchmark?.usable),
      reasonCodes: benchmark?.reasonCodes ?? ["benchmark_unavailable"],
    },
  };
}

function batchStatus(coverage) {
  if (coverage.status === "unavailable") return "unavailable";
  return coverage.status === "complete" ? "complete" : "partial";
}

function buildUniverse(holdings, watchlist, limit) {
  const holdingSet = new Set(holdings);
  const watchlistSet = new Set(watchlist);
  const holdingSymbols = [...holdingSet].sort();
  const watchlistOnly = [...watchlistSet].filter((symbol) => !holdingSet.has(symbol)).sort();
  const requestedSymbols = [...holdingSymbols, ...watchlistOnly];
  const selectedSymbols = requestedSymbols.slice(0, limit);
  const omittedSymbols = requestedSymbols.slice(limit);
  const memberships = new Map(selectedSymbols.map((symbol) => [
    symbol,
    [
      ...(holdingSet.has(symbol) ? ["holding"] : []),
      ...(watchlistSet.has(symbol) ? ["watchlist"] : []),
    ],
  ]));
  return {
    requestedSymbols,
    selectedSymbols,
    omittedSymbols,
    omittedHoldingSymbols: omittedSymbols.filter((symbol) => holdingSet.has(symbol)),
    omittedWatchlistSymbols: omittedSymbols.filter((symbol) => watchlistSet.has(symbol)),
    memberships,
  };
}

function normalizePreviousBatch(value, currentCutoff) {
  if (value == null) {
    return {
      status: "not_requested",
      cutoff: null,
      reasonCodes: [],
      cardsBySymbol: new Map(),
      fingerprint: null,
    };
  }
  if (!value || typeof value !== "object"
    || value.schemaVersion !== TIER_A_TECHNICAL_SCAN_SCHEMA_VERSION
    || !Array.isArray(value.cards)) {
    return {
      status: "unavailable",
      cutoff: dateOnly(value?.cutoff),
      reasonCodes: ["previous_batch_contract_invalid"],
      cardsBySymbol: new Map(),
      fingerprint: hashCanonical({ invalidPrevious: value }),
    };
  }
  const previousCutoff = dateOnly(value.cutoff);
  if (!previousCutoff || previousCutoff > currentCutoff) {
    return {
      status: "unavailable",
      cutoff: previousCutoff,
      reasonCodes: [previousCutoff ? "previous_batch_cutoff_after_current" : "previous_batch_cutoff_invalid"],
      cardsBySymbol: new Map(),
      fingerprint: hashCanonical({ cutoff: previousCutoff, cards: [] }),
    };
  }
  const cards = value.cards
    .filter((card) => card && typeof card === "object" && textOrNull(card.symbol))
    .map((card) => ({
      symbol: normalizeSymbol(card.symbol, "previousBatch.cards.symbol"),
      observableState: stableClone(card.observableState ?? {}),
    }))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
  const cardsBySymbol = new Map(cards.map((card) => [card.symbol, card]));
  return {
    status: "available",
    cutoff: previousCutoff,
    reasonCodes: [],
    cardsBySymbol,
    fingerprint: hashCanonical({ cutoff: previousCutoff, cards }),
  };
}

function resolveCutoff(value, benchmark) {
  if (value != null && value !== "") {
    const explicit = dateOnly(value);
    if (!explicit) {
      throw inputError("cutoff_invalid", "cutoff must be a YYYY-MM-DD trade date.");
    }
    return { cutoff: explicit, source: "caller_explicit" };
  }
  const derived = benchmark?.valid ? benchmark.bars.at(-1)?.tradeDate ?? null : null;
  if (!derived) {
    throw inputError(
      "cutoff_unavailable",
      "cutoff is required when the completed QQQ benchmark has no terminal trade date.",
    );
  }
  return { cutoff: derived, source: "benchmark_terminal_completed_bar" };
}

function resolveAnalysisTime(value, cutoff) {
  const candidate = value == null || value === ""
    ? `${cutoff}T23:59:59.999Z`
    : String(value);
  const date = new Date(candidate);
  if (!Number.isFinite(date.getTime())) {
    throw inputError("analysis_time_invalid", "analysisTime must be a valid timestamp.");
  }
  return date.toISOString();
}

function normalizeDailyMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw inputError("daily_by_symbol_invalid", "dailyBySymbol must be an object keyed by symbol.");
  }
  const result = new Map();
  for (const [rawSymbol, descriptor] of Object.entries(value)) {
    const symbol = normalizeSymbol(rawSymbol, "dailyBySymbol key");
    if (result.has(symbol)) {
      throw inputError("duplicate_daily_symbol", `dailyBySymbol contains duplicate normalized symbol ${symbol}.`);
    }
    result.set(symbol, descriptor);
  }
  return result;
}

function normalizeSectorMap(value) {
  if (value == null) return new Map();
  if (typeof value !== "object" || Array.isArray(value)) {
    throw inputError("sector_by_symbol_invalid", "sectorBySymbol must be an object keyed by target symbol.");
  }
  const result = new Map();
  for (const [rawTarget, rawSector] of Object.entries(value)) {
    const target = normalizeSymbol(rawTarget, "sectorBySymbol target");
    const sector = normalizeSymbol(
      rawSector && typeof rawSector === "object" ? rawSector.symbol : rawSector,
      `sectorBySymbol.${target}`,
    );
    result.set(target, sector);
  }
  return result;
}

function normalizeSymbolList(value, field) {
  if (!Array.isArray(value)) {
    throw inputError(`${field}_not_array`, `${field} must be an array.`);
  }
  return value.map((item, index) => normalizeSymbol(
    item && typeof item === "object" ? item.symbol : item,
    `${field}[${index}]`,
  ));
}

function normalizeSymbol(value, field) {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (!symbol || symbol.length > 64 || /\s/.test(symbol)) {
    throw inputError("symbol_invalid", `${field} must be a non-empty symbol without whitespace.`);
  }
  return symbol;
}

function compactInput(dataset) {
  return {
    status: dataset?.usable ? "available" : "unavailable",
    source: dataset?.source ?? null,
    completedBarsOnly: dataset?.valid === true,
    barCount: dataset?.bars?.length ?? 0,
    rawBarCount: dataset?.rawBarCount ?? 0,
    ignoredAfterCutoffCount: dataset?.ignoredAfterCutoffCount ?? 0,
    exactCutoff: Boolean(dataset?.exactCutoff),
    startTradeDate: dataset?.bars?.[0]?.tradeDate ?? null,
    endTradeDate: dataset?.bars?.at(-1)?.tradeDate ?? null,
    inputHash: dataset?.inputHash ?? null,
    noForwardFill: true,
  };
}

function datasetHashReference(dataset) {
  if (!dataset) return null;
  return {
    exactCutoff: Boolean(dataset.usable),
    inputHash: dataset.inputHash ?? null,
    invalidInputFingerprint: dataset.inputHash ? null : dataset.rawFingerprint ?? null,
    reasonCodes: uniqueSorted(dataset.reasonCodes ?? []),
  };
}

function unavailableExcess(reason) {
  return {
    status: "unavailable",
    inputHash: null,
    windows: Object.fromEntries(RETURN_WINDOWS.map((window) => [
      window,
      { status: "unavailable", value: null, unit: "percent_point", reason },
    ])),
  };
}

function excessCapability(excess, dataset) {
  if (!dataset?.usable) return unavailableCapability("exact_cutoff_series_unavailable");
  return {
    status: excess.status === "complete"
      ? "complete"
      : excess.status === "partial"
        ? "partial"
        : "unavailable",
    reasonCodes: excess.status === "complete" ? [] : ["exact_date_excess_windows_incomplete"],
    inputHash: excess.inputHash ?? null,
    noForwardFill: true,
  };
}

function compactCapability(value) {
  if (!value || typeof value !== "object") return unavailableCapability("capability_unavailable");
  return {
    status: value.status ?? "unavailable",
    reasonCodes: uniqueSorted(value.reasonCodes ?? []),
    barCount: isFiniteNumeric(value.barCount) ? Number(value.barCount) : null,
    minimumBars: isFiniteNumeric(value.minimumBars) ? Number(value.minimumBars) : null,
    asOf: value.asOf ?? null,
    method: value.method ?? null,
  };
}

function capabilityFromScalarStatus(status) {
  const normalized = ["complete", "partial", "warming", "unavailable"].includes(status)
    ? status
    : "unavailable";
  return { status: normalized, reasonCodes: normalized === "unavailable" ? ["capability_unavailable"] : [] };
}

function unavailableCapability(reason) {
  return { status: "unavailable", reasonCodes: [reason] };
}

function notApplicableCapability(reason) {
  return { status: "not_applicable", reasonCodes: [reason] };
}

function priceRelation(price, reference) {
  if (!isFiniteNumeric(price) || !isFiniteNumeric(reference)) return "N/A";
  const left = Number(price);
  const right = Number(reference);
  return left > right ? "above" : left < right ? "below" : "at";
}

function metricSignState(metric) {
  if (metric?.status !== "available" || !isFiniteNumeric(metric.value)) return "N/A";
  const value = Number(metric.value);
  return value > 0 ? "positive" : value < 0 ? "negative" : "flat";
}

function normalizeStateValue(value) {
  return value == null || value === "" ? "N/A" : String(value);
}

function statusSeverity(status) {
  return { complete: 0, partial: 1, degraded: 2, unavailable: 3 }[status] ?? 3;
}

function finiteOrNull(value) {
  return isFiniteNumeric(value) ? Number(value) : null;
}

function absoluteOrNull(value) {
  const number = finiteOrNull(value);
  return number == null ? null : Math.abs(number);
}

function sortableNumber(value) {
  return isFiniteNumeric(value) ? Number(value) : Number.NEGATIVE_INFINITY;
}

function isFiniteNumeric(value) {
  return value != null && value !== "" && typeof value !== "boolean"
    && Number.isFinite(Number(value));
}

function isExplicitlyForming(bar) {
  if (!bar || typeof bar !== "object") return false;
  if (bar.isClosed === false || bar.is_closed === false || bar.closed === false
    || bar.complete === false || bar.confirmed === false || bar.final === false) return true;
  const status = String(
    bar.barStatus ?? bar.bar_status ?? bar.status ?? bar.state ?? "",
  ).trim().toLowerCase();
  return FORMING_STATES.has(status);
}

function tradeDateFromIdentity(identity) {
  const date = dateOnly(identity);
  if (!date) throw inputError("daily_trade_date_invalid", "Daily bar has no valid trade date.");
  return date;
}

function dateOnly(value) {
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(`${text}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text
      ? text
      : null;
  }
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

function boundedInteger(value, field, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw inputError(
      `${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_invalid`,
      `${field} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return number;
}

function textOrNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function uniqueSorted(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))].sort();
}

function hashCanonical(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function boundedDatasetFingerprint(symbol, descriptor) {
  const bars = Array.isArray(descriptor)
    ? descriptor
    : Array.isArray(descriptor?.bars)
      ? descriptor.bars
      : null;
  if (bars && bars.length > TIER_A_TECHNICAL_SCAN_MAX_BARS_PER_SYMBOL) {
    return hashCanonical({
      symbol,
      descriptorShape: Array.isArray(descriptor) ? "unattested_array" : "dataset_object",
      completedBarsOnly: descriptor?.completedBarsOnly === true,
      barCount: bars.length,
      reason: "daily_bar_limit_exceeded",
    });
  }
  return hashCanonical({ symbol, descriptor: descriptor ?? null });
}

function stableClone(value) {
  return canonicalize(value);
}

function canonicalize(value) {
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : `[${String(value)}]`;
  if (typeof value === "bigint") return `[bigint:${value}]`;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") return `[unsupported:${typeof value}]`;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function inputError(code, message, details = {}) {
  return new TierATechnicalScanInputError(code, message, details);
}
