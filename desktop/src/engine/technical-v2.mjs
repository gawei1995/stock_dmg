import { createHash } from "node:crypto";

import { emaSeries, round } from "./technical.mjs";
import { buildDailyCostConcentration } from "./cost-concentration.mjs";

/**
 * Deterministic multi-timeframe contract.
 *
 * This module deliberately does not fetch data.  Its callers must state the
 * supplied interval and whether bars are completed; missing, forming, or
 * mis-labelled data remains unavailable instead of being inferred from a
 * chart.  It is intended to sit beside the existing daily calculator until
 * the Longbridge data layer has explicit weekly and 60-minute endpoints.
 */
export const TECHNICAL_V2_SCHEMA_VERSION = "technical-v2/v2";
export const WEEKLY_MINIMUM_BARS = 13;
export const EXECUTION_60M_MINIMUM_BARS = 21;
export const EXECUTION_EMA_PERIODS = Object.freeze([3, 5, 8, 13, 21]);

const FORMING_STATES = new Set(["forming", "open", "partial", "updating", "realtime", "live"]);
const EXECUTION_HORIZONS = new Set(["intraday", "swing", "event"]);

/**
 * Produce a structured, capability-aware technical envelope.  `weekly` and
 * `intraday60m` use the explicit LayerInput shape:
 *
 * { bars, interval: "1W" | "60m", completedBarsOnly: true,
 *   source, fetchedAt, coverage }
 *
 * When only `dailyCompletedBars` is supplied, weekly bars are conservatively
 * derived from it and the terminal (possibly incomplete) week is excluded.
 */
export function buildTechnicalV2({
  dailyTechnical = null,
  dailyCompletedBars = null,
  weekly = null,
  intraday60m = null,
  horizon = "swing",
} = {}) {
  const normalizedHorizon = normalizeHorizon(horizon);
  const weeklyResult = buildWeeklyStructure({ weekly, dailyCompletedBars });
  const executionResult = buildExecution60mStructure(intraday60m);
  const costResult = buildCostConcentrationStructure(dailyCompletedBars);
  const dailyCapability = dailyCapabilityFrom(dailyTechnical, dailyCompletedBars);
  const capabilityMatrix = buildCapabilityMatrix({
    horizon: normalizedHorizon,
    daily: dailyCapability,
    weekly: weeklyResult.capability,
    execution60m: executionResult.capability,
    costProfile: costResult.capability,
  });
  const availableLayers = [
    dailyCapability.status !== "unavailable",
    weeklyResult.capability.status !== "unavailable",
    executionResult.capability.status !== "unavailable",
  ].filter(Boolean).length;

  return {
    schemaVersion: TECHNICAL_V2_SCHEMA_VERSION,
    status: availableLayers === 0 ? "degraded" : capabilityMatrix.execution60m.status === "complete"
      && capabilityMatrix.weeklyStructure.status === "complete"
      ? "complete"
      : "partial",
    horizon: normalizedHorizon,
    daily: dailyCapability,
    weekly: weeklyResult.structure,
    execution60m: executionResult.structure,
    costProfile14d28d: costResult.structure,
    capabilityMatrix,
    limitations: collectLimitations(capabilityMatrix),
  };
}

/**
 * Build a low-confidence volume-at-price concentration proxy from completed
 * daily OHLCV. It is intentionally local and deterministic, and never claims
 * to be holder cost basis, exchange volume-at-price, or participant data.
 */
export function buildCostConcentrationStructure(dailyCompletedBars = null) {
  if (!Array.isArray(dailyCompletedBars) || dailyCompletedBars.length === 0) {
    return unavailableCostConcentration(["completed_daily_input_not_provided"]);
  }
  const terminal = dailyCompletedBars.at(-1);
  const cutoff = tradeDateOf(terminal);
  if (!cutoff) return unavailableCostConcentration(["completed_daily_cutoff_unavailable"]);
  try {
    const structure = buildDailyCostConcentration({
      bars: dailyCompletedBars,
      completedThroughTradeDate: cutoff,
      asOfTradingDate: cutoff,
    });
    const complete = structure.status === "complete";
    const partial = structure.status === "partial";
    const reasonCodes = [
      "daily_ohlcv_proxy_not_holder_cost_basis",
      ...(structure.profiles?.["14"]?.status === "available"
        ? []
        : [structure.profiles?.["14"]?.reasonCode ?? "profile_14_unavailable"]),
      ...(structure.profiles?.["28"]?.status === "available"
        ? []
        : [structure.profiles?.["28"]?.reasonCode ?? "profile_28_unavailable"]),
    ];
    return {
      capability: makeCapability({
        status: complete ? "complete" : partial ? "warming" : "unavailable",
        minimumBars: 28,
        barCount: Number(structure.input?.barCount ?? 0),
        source: "completed_daily_ohlcv_proxy",
        asOf: cutoff,
        reasonCodes,
        method: structure.methodVersion,
      }),
      structure,
    };
  } catch (error) {
    return unavailableCostConcentration([
      String(error?.code ?? "cost_concentration_input_invalid"),
    ]);
  }
}

/**
 * Create a weekly structure card from explicit weekly OHLCV bars or from
 * completed daily bars.  The latter is a transparent aggregation, never a
 * substitute for a vendor-provided weekly series.
 */
export function buildWeeklyStructure({ weekly = null, dailyCompletedBars = null } = {}) {
  let layer = normalizeLayerInput(weekly, { expectedInterval: "1W", layer: "weekly" });
  let derived = null;
  if (!layer.provided && Array.isArray(dailyCompletedBars)) {
    derived = aggregateCompletedDailyBarsToWeeks(dailyCompletedBars);
    layer = normalizeLayerInput({
      bars: derived.bars,
      interval: "1W",
      completedBarsOnly: true,
      source: "derived_from_completed_daily",
      derivation: derived.derivation,
    }, { expectedInterval: "1W", layer: "weekly" });
  }

  if (!layer.usable) {
    return unavailableLayer({
      layer: "weeklyStructure",
      minimumBars: WEEKLY_MINIMUM_BARS,
      reasonCodes: layer.reasonCodes,
      metadata: layer.metadata,
      barCount: layer.closedBars.length,
    });
  }
  const bars = layer.closedBars;
  const warm = bars.length < WEEKLY_MINIMUM_BARS;
  const capability = makeCapability({
    status: warm ? "warming" : "complete",
    minimumBars: WEEKLY_MINIMUM_BARS,
    barCount: bars.length,
    source: layer.metadata.source,
    asOf: bars.at(-1)?.identity ?? null,
    reasonCodes: [
      ...layer.reasonCodes,
      ...(warm ? ["insufficient_weekly_history"] : []),
      ...(derived?.terminalWeekExcluded ? ["terminal_week_excluded_until_confirmed"] : []),
    ],
    method: layer.metadata.source === "derived_from_completed_daily"
      ? "completed_daily_aggregation_terminal_week_excluded"
      : "provider_or_caller_supplied_weekly_ohlcv",
  });
  if (warm) {
    return {
      capability,
      structure: unavailableStructure({
        timeframe: "1W",
        reasonCodes: capability.reasonCodes,
        barCount: bars.length,
        minimumBars: WEEKLY_MINIMUM_BARS,
        input: layer.metadata,
      }),
    };
  }

  const latest = bars.at(-1);
  const return4 = percentChange(bars.at(-5)?.close, latest.close);
  const return12 = percentChange(bars.at(-13)?.close, latest.close);
  const recent = bars.slice(-4);
  const prior = bars.slice(-8, -4);
  const currentHigh = Math.max(...recent.map((bar) => bar.high));
  const currentLow = Math.min(...recent.map((bar) => bar.low));
  const priorHigh = Math.max(...prior.map((bar) => bar.high));
  const priorLow = Math.min(...prior.map((bar) => bar.low));
  const swing = currentHigh > priorHigh && currentLow > priorLow
    ? "higher_high_higher_low"
    : currentHigh < priorHigh && currentLow < priorLow
      ? "lower_high_lower_low"
      : "mixed_or_range";
  const direction = return4 > 0 && return12 > 0 && swing === "higher_high_higher_low"
    ? "advancing"
    : return4 < 0 && return12 < 0 && swing === "lower_high_lower_low"
      ? "declining"
      : "ranging_or_transitional";
  const latestRange = latest.high - latest.low;
  const closeLocationValue = latestRange > 0
    ? ((2 * latest.close - latest.high - latest.low) / latestRange)
    : null;

  return {
    capability,
    structure: {
      schemaVersion: TECHNICAL_V2_SCHEMA_VERSION,
      status: "available",
      timeframe: "1W",
      input: {
        ...layer.metadata,
        barCount: bars.length,
        completedBarCount: bars.length,
        inputHash: hashBars(bars),
      },
      asOf: latest.identity,
      latestClose: round(latest.close),
      direction,
      swing,
      metrics: {
        return4WeeksPercent: round(return4),
        return12WeeksPercent: round(return12),
        latestCloseLocationValue: closeLocationValue == null ? null : round(closeLocationValue, 4),
        currentFourWeekHigh: round(currentHigh),
        currentFourWeekLow: round(currentLow),
        priorFourWeekHigh: round(priorHigh),
        priorFourWeekLow: round(priorLow),
      },
      method: {
        direction: "4w_and_12w_simple_returns + 4w_vs_prior4w_swing_range",
        closeLocationValue: "(2C-H-L)/(H-L)",
      },
      advisory: true,
      decisionAuthority: "LLM",
    },
  };
}

/**
 * Build a 60-minute execution card.  It intentionally stops at an execution
 * state; it never creates an entry or a size.  A missing or non-60m series is
 * explicitly unavailable.
 */
export function buildExecution60mStructure(intraday60m = null) {
  const layer = normalizeLayerInput(intraday60m, {
    expectedInterval: "60m",
    layer: "execution60m",
  });
  if (!layer.usable) {
    return unavailableLayer({
      layer: "execution60m",
      minimumBars: EXECUTION_60M_MINIMUM_BARS,
      reasonCodes: layer.reasonCodes,
      metadata: layer.metadata,
      barCount: layer.closedBars.length,
    });
  }
  const bars = layer.closedBars;
  const warm = bars.length < EXECUTION_60M_MINIMUM_BARS;
  const capability = makeCapability({
    status: warm ? "warming" : "complete",
    minimumBars: EXECUTION_60M_MINIMUM_BARS,
    barCount: bars.length,
    source: layer.metadata.source,
    asOf: bars.at(-1)?.identity ?? null,
    reasonCodes: [
      ...layer.reasonCodes,
      ...(warm ? ["insufficient_60m_history"] : []),
    ],
    method: "closed_60m_ohlcv_ema_ribbon",
  });
  if (warm) {
    return {
      capability,
      structure: unavailableStructure({
        timeframe: "60m",
        reasonCodes: capability.reasonCodes,
        barCount: bars.length,
        minimumBars: EXECUTION_60M_MINIMUM_BARS,
        input: layer.metadata,
      }),
    };
  }

  const closes = bars.map((bar) => bar.close);
  const ema = Object.fromEntries(EXECUTION_EMA_PERIODS.map((period) => {
    const series = emaSeries(closes, period);
    const value = series.at(-1);
    const past = series.at(-6);
    return [period, {
      value: Number.isFinite(value) ? round(value) : null,
      slope5BarsPercent: Number.isFinite(value) && Number.isFinite(past) && past !== 0
        ? round(((value - past) / past) * 100)
        : null,
    }];
  }));
  const lastClose = closes.at(-1);
  const ribbon = EXECUTION_EMA_PERIODS.map((period) => ema[period].value);
  const longOrder = isStrictDescending([lastClose, ...ribbon]);
  const shortOrder = isStrictAscending([lastClose, ...ribbon]);
  const currentRange = bars.at(-1).high - bars.at(-1).low;
  const clv = currentRange > 0
    ? (2 * lastClose - bars.at(-1).high - bars.at(-1).low) / currentRange
    : null;

  return {
    capability,
    structure: {
      schemaVersion: TECHNICAL_V2_SCHEMA_VERSION,
      status: "available",
      timeframe: "60m",
      input: {
        ...layer.metadata,
        barCount: bars.length,
        completedBarCount: bars.length,
        inputHash: hashBars(bars),
      },
      asOf: bars.at(-1).identity,
      lastClose: round(lastClose),
      executionState: longOrder ? "bullish_ribbon" : shortOrder ? "bearish_ribbon" : "mixed_or_transition",
      emaMethod: { inputSource: "close", seed: "SMA", multiplier: "2 / (period + 1)" },
      ema,
      metrics: {
        return1BarPercent: round(percentChange(closes.at(-2), lastClose)),
        return3BarsPercent: round(percentChange(closes.at(-4), lastClose)),
        latestCloseLocationValue: clv == null ? null : round(clv, 4),
      },
      advisory: true,
      decisionAuthority: "LLM",
      limitation: "Execution state is timing evidence only; it does not certify liquidity, gap risk, stop execution, or position size.",
    },
  };
}

/**
 * Aggregate completed ascending daily OHLCV into weekly bars.  The most
 * recent week is always excluded because this pure calculator does not have
 * an exchange calendar or a vendor close confirmation for it.
 */
export function aggregateCompletedDailyBarsToWeeks(dailyBars = []) {
  const bars = normalizeBars(dailyBars, { layer: "daily" }).closedBars;
  const groups = new Map();
  for (const bar of bars) {
    const key = isoWeekKey(bar.time);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bar);
  }
  const entries = [...groups.entries()];
  const terminal = entries.pop() ?? null;
  const weeklyBars = entries.map(([week, values]) => aggregateWeek(week, values));
  return {
    bars: weeklyBars,
    terminalWeekExcluded: Boolean(terminal),
    derivation: {
      source: "completed_daily_ohlcv",
      policy: "terminal_week_excluded_without_explicit_weekly_close_confirmation",
      terminalWeek: terminal?.[0] ?? null,
      inputBarCount: bars.length,
      outputBarCount: weeklyBars.length,
    },
  };
}

function dailyCapabilityFrom(dailyTechnical, dailyCompletedBars) {
  if (dailyTechnical && typeof dailyTechnical === "object") {
    const hasBars = Number(dailyTechnical.calculationBarCount ?? dailyTechnical.candleCount ?? 0) > 0;
    return makeCapability({
      status: hasBars ? dailyTechnical.status === "degraded" ? "warming" : "complete" : "unavailable",
      minimumBars: 1,
      barCount: Number(dailyTechnical.calculationBarCount ?? dailyTechnical.candleCount ?? 0),
      source: dailyTechnical.marketData?.source ?? "daily_technical_envelope",
      asOf: dailyTechnical.asOf ?? null,
      reasonCodes: hasBars ? [] : ["daily_technical_has_no_completed_bars"],
      method: "existing_daily_technical_contract",
    });
  }
  if (Array.isArray(dailyCompletedBars)) {
    const normalized = normalizeBars(dailyCompletedBars, { layer: "daily" });
    return makeCapability({
      status: normalized.closedBars.length ? "complete" : "unavailable",
      minimumBars: 1,
      barCount: normalized.closedBars.length,
      source: "caller_supplied_completed_daily",
      asOf: normalized.closedBars.at(-1)?.identity ?? null,
      reasonCodes: normalized.reasonCodes,
      method: "caller_supplied_daily_ohlcv",
    });
  }
  return makeCapability({
    status: "unavailable",
    minimumBars: 1,
    barCount: 0,
    source: null,
    asOf: null,
    reasonCodes: ["daily_input_not_provided"],
    method: null,
  });
}

function buildCapabilityMatrix({ horizon, daily, weekly, execution60m, costProfile }) {
  const executionRequired = EXECUTION_HORIZONS.has(horizon);
  return {
    schemaVersion: TECHNICAL_V2_SCHEMA_VERSION,
    dailyPrimary: daily,
    weeklyStructure: weekly,
    execution60m: {
      ...execution60m,
      requiredForSpecifiedHorizon: executionRequired,
      decisionUse: "entry_timing_and_intraday_invalidation_only",
    },
    costProfile14d28d: costProfile,
    anchoredVwap: unavailableCapability("awaiting_explicit_llm_anchor"),
    benchmarkRelativeStrength: unavailableCapability("benchmark_contract_not_attached"),
    sectorPeerMatrix: unavailableCapability("sector_peer_contract_not_attached"),
    optionsStructure: unavailableCapability("options_chain_contract_not_attached"),
  };
}

function unavailableCostConcentration(reasonCodes) {
  const capability = makeCapability({
    status: "unavailable",
    minimumBars: 28,
    barCount: 0,
    source: "completed_daily_ohlcv_proxy",
    asOf: null,
    reasonCodes,
    method: "daily-cost-concentration-v1",
  });
  return {
    capability,
    structure: {
      schemaVersion: "cost-concentration/v1",
      methodVersion: "daily-cost-concentration-v1",
      status: "unavailable",
      input: null,
      configuration: {
        windows: [14, 28],
        bins: 80,
        allocationMethod: "uniform_range",
        valueAreaFraction: 0.7,
        densePercentile: 0.75,
      },
      profiles: {},
      comparison: { status: "unavailable", reasonCodes },
      limitations: [
        "estimate_not_holder_cost_basis",
        "daily_single_bar_low_confidence",
      ],
      reasonCodes,
    },
  };
}

function tradeDateOf(bar) {
  const direct = String(bar?.tradeDate ?? bar?.trade_date ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
  const parsed = new Date(String(bar?.timestamp ?? bar?.time ?? ""));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

function collectLimitations(matrix) {
  return Object.entries(matrix)
    .filter(([key, value]) => key !== "schemaVersion" && value.status !== "complete")
    .map(([layer, value]) => ({ layer, status: value.status, reasonCodes: value.reasonCodes }));
}

function normalizeLayerInput(input, { expectedInterval, layer }) {
  if (input == null) {
    return {
      provided: false,
      usable: false,
      closedBars: [],
      reasonCodes: ["input_not_provided"],
      metadata: emptyLayerMetadata(expectedInterval),
    };
  }
  const value = Array.isArray(input) ? { bars: input } : input;
  if (!value || typeof value !== "object" || !Array.isArray(value.bars)) {
    return {
      provided: true,
      usable: false,
      closedBars: [],
      reasonCodes: ["bars_not_array"],
      metadata: emptyLayerMetadata(expectedInterval),
    };
  }
  const interval = normalizeInterval(value.interval ?? value.timeframe ?? value.intervalMinutes);
  if (interval !== expectedInterval) {
    return {
      provided: true,
      usable: false,
      closedBars: [],
      reasonCodes: ["declared_interval_mismatch"],
      metadata: {
        ...emptyLayerMetadata(expectedInterval),
        declaredInterval: interval,
        source: stringOrNull(value.source) ?? "caller_supplied",
        rawBarCount: value.bars.length,
      },
    };
  }
  let normalized;
  try {
    normalized = normalizeBars(value.bars, { layer });
  } catch (error) {
    return {
      provided: true,
      usable: false,
      closedBars: [],
      reasonCodes: [String(error.code ?? "invalid_ohlcv_input")],
      metadata: {
        ...emptyLayerMetadata(expectedInterval),
        declaredInterval: interval,
        source: stringOrNull(value.source) ?? "caller_supplied",
        rawBarCount: value.bars.length,
      },
    };
  }
  const explicitlyAttested = value.completedBarsOnly === true;
  const metadata = {
    declaredInterval: interval,
    completedBarsOnly: explicitlyAttested,
    source: stringOrNull(value.source) ?? "caller_supplied",
    fetchedAt: stringOrNull(value.fetchedAt),
    coverage: value.coverage ?? null,
    derivation: value.derivation ?? null,
    rawBarCount: value.bars.length,
    excludedFormingBarCount: normalized.excludedFormingBarCount,
  };
  const reasonCodes = [
    ...(explicitlyAttested ? [] : ["completed_bars_not_explicitly_attested"]),
    ...(normalized.excludedFormingBarCount ? ["forming_bars_excluded"] : []),
  ];
  return {
    provided: true,
    usable: explicitlyAttested && normalized.closedBars.length > 0,
    closedBars: normalized.closedBars,
    reasonCodes,
    metadata,
  };
}

function normalizeBars(input, { layer }) {
  if (!Array.isArray(input)) {
    throw codeError("bars_not_array", `${layer} bars must be an array.`);
  }
  const closedBars = [];
  let excludedFormingBarCount = 0;
  for (let index = 0; index < input.length; index += 1) {
    const raw = input[index];
    if (!raw || typeof raw !== "object") {
      throw codeError("bar_not_object", `${layer} bar ${index + 1} must be an object.`);
    }
    if (isExplicitlyForming(raw)) {
      excludedFormingBarCount += 1;
      continue;
    }
    const time = parseBarTime(raw.timestamp ?? raw.time ?? raw.tradeDate ?? raw.trade_date);
    if (!time) throw codeError("bar_time_invalid", `${layer} bar ${index + 1} has no valid timestamp.`);
    const open = finiteBarNumber(raw.open, "open", index, layer);
    const high = finiteBarNumber(raw.high, "high", index, layer);
    const low = finiteBarNumber(raw.low, "low", index, layer);
    const close = finiteBarNumber(raw.close, "close", index, layer);
    const volume = finiteBarNumber(raw.volume, "volume", index, layer);
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
      throw codeError("non_positive_price", `${layer} bar ${index + 1} has non-positive price.`);
    }
    if (volume < 0 || high < low || open < low || open > high || close < low || close > high) {
      throw codeError("invalid_ohlcv", `${layer} bar ${index + 1} has invalid OHLCV relationships.`);
    }
    closedBars.push({
      identity: time.toISOString(),
      time,
      open,
      high,
      low,
      close,
      volume,
    });
  }
  for (let index = 1; index < closedBars.length; index += 1) {
    if (closedBars[index].time.getTime() <= closedBars[index - 1].time.getTime()) {
      throw codeError("bars_not_strictly_ascending", `${layer} bars must be strictly ascending.`);
    }
  }
  return { closedBars, excludedFormingBarCount };
}

function unavailableLayer({ layer, minimumBars, reasonCodes, metadata, barCount = 0 }) {
  const capabilityValue = makeCapability({
    status: "unavailable",
    minimumBars,
    barCount,
    source: metadata?.source ?? null,
    asOf: null,
    reasonCodes,
    method: null,
  });
  return {
    capability: capabilityValue,
    structure: unavailableStructure({
      timeframe: layer === "weeklyStructure" ? "1W" : "60m",
      reasonCodes: capabilityValue.reasonCodes,
      barCount,
      minimumBars,
      input: metadata,
    }),
  };
}

function unavailableStructure({ timeframe, reasonCodes, barCount, minimumBars, input }) {
  return {
    schemaVersion: TECHNICAL_V2_SCHEMA_VERSION,
    status: "unavailable",
    timeframe,
    input: { ...(input ?? {}), barCount, completedBarCount: 0 },
    reasonCodes: [...new Set(reasonCodes)],
    minimumBars,
    advisory: true,
    decisionAuthority: "LLM",
  };
}

function makeCapability({ status, minimumBars, barCount, source, asOf, reasonCodes = [], method }) {
  return {
    status,
    minimumBars,
    barCount,
    source,
    asOf,
    method,
    reasonCodes: [...new Set((Array.isArray(reasonCodes) ? reasonCodes : []).filter(Boolean))],
  };
}

function unavailableCapability(reason) {
  return makeCapability({
    status: "unavailable",
    minimumBars: null,
    barCount: 0,
    source: null,
    asOf: null,
    method: null,
    reasonCodes: [reason],
  });
}

function emptyLayerMetadata(expectedInterval) {
  return {
    declaredInterval: null,
    expectedInterval,
    completedBarsOnly: false,
    source: null,
    fetchedAt: null,
    coverage: null,
    derivation: null,
    rawBarCount: 0,
    excludedFormingBarCount: 0,
  };
}

function aggregateWeek(week, bars) {
  return {
    timestamp: bars.at(-1).identity,
    tradeDate: week,
    open: bars[0].open,
    high: Math.max(...bars.map((bar) => bar.high)),
    low: Math.min(...bars.map((bar) => bar.low)),
    close: bars.at(-1).close,
    volume: bars.reduce((sum, bar) => sum + bar.volume, 0),
  };
}

function isoWeekKey(date) {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((value - yearStart) / 86_400_000) + 1) / 7);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function normalizeInterval(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["1w", "1wk", "1week", "week", "weekly", "w"].includes(text)) return "1W";
  if (["60", "60m", "60min", "60minute", "1h", "hour", "hourly"].includes(text)) return "60m";
  return text || null;
}

function normalizeHorizon(value) {
  const normalized = String(value ?? "swing").trim().toLowerCase();
  return ["intraday", "swing", "position", "event", "unknown"].includes(normalized)
    ? normalized
    : "unknown";
}

function isExplicitlyForming(bar) {
  if (bar.isClosed === false || bar.is_closed === false || bar.complete === false || bar.confirmed === false) return true;
  const status = String(bar.barStatus ?? bar.bar_status ?? bar.status ?? bar.state ?? "").trim().toLowerCase();
  return FORMING_STATES.has(status);
}

function parseBarTime(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && String(value).trim() !== ""
    ? new Date(Math.abs(numeric) < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

function finiteBarNumber(value, field, index, layer) {
  if (value == null || value === "" || typeof value === "boolean") {
    throw codeError("bar_number_missing", `${layer} bar ${index + 1} is missing ${field}.`);
  }
  const result = Number(value);
  if (!Number.isFinite(result)) {
    throw codeError("bar_number_invalid", `${layer} bar ${index + 1} has invalid ${field}.`);
  }
  return result;
}

function percentChange(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === 0) return null;
  return ((end - start) / start) * 100;
}

function hashBars(bars) {
  return createHash("sha256")
    .update(JSON.stringify(bars.map((bar) => [
      bar.identity,
      bar.open,
      bar.high,
      bar.low,
      bar.close,
      bar.volume,
    ])))
    .digest("hex");
}

function isStrictDescending(values) {
  return values.every((value, index) => Number.isFinite(value) && (index === 0 || values[index - 1] > value));
}

function isStrictAscending(values) {
  return values.every((value, index) => Number.isFinite(value) && (index === 0 || values[index - 1] < value));
}

function stringOrNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function codeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
