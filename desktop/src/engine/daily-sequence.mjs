import { createHash } from "node:crypto";

export const DAILY_SEQUENCE_METHOD_VERSION = "daily-sequence-v2";
export const DAILY_SEQUENCE_WINDOWS = Object.freeze([1, 3, 5, 10, 20]);

const ATR_WINDOW = 14;
const RELATIVE_VOLUME_WINDOW = 20;
const DIRECTIONAL_EFFICIENCY_WINDOWS = Object.freeze([10, 20]);
const FORMING_STATUSES = new Set([
  "forming",
  "open",
  "partial",
  "updating",
  "realtime",
  "live",
]);

export class DailySequenceInputError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DailySequenceInputError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Build deterministic path-preserving statistics from completed, ascending
 * daily OHLCV bars. The caller owns exchange-calendar and bar-finality
 * classification; this module rejects an explicitly forming bar but does not
 * infer whether an otherwise unmarked bar is complete.
 */
export function buildDailySequence(input = []) {
  const bars = normalizeCompletedDailyBars(input);
  const inputHash = hashBars(bars);
  const latest = bars.at(-1) ?? null;
  const previous = bars.at(-2) ?? null;
  const returns = Object.fromEntries(DAILY_SEQUENCE_WINDOWS.map((window) => [
    String(window),
    returnMetric(bars, window),
  ]));
  const trueRange = latest && previous
    ? availableMetric(trueRangeAt(bars, bars.length - 1), "price", {
        basis: "max(high-low, abs(high-prior_close), abs(low-prior_close))",
      })
    : unavailableMetric("price", "requires_previous_close", {
        requiredObservations: 2,
        availableObservations: bars.length,
      });
  const priorAtr14 = priorAtrMetric(bars);
  const normalizedTrueRangeAtr14 = trueRange.status === "available"
    && priorAtr14.status === "available"
    && priorAtr14.value > 0
    ? availableMetric(trueRange.value / priorAtr14.value, "multiple", {
        basis: "latest_true_range / prior_atr14",
      })
    : unavailableMetric(
        "multiple",
        priorAtr14.status !== "available"
          ? priorAtr14.reason
          : priorAtr14.value === 0
            ? "prior_atr14_is_zero"
            : trueRange.reason,
        {
          requiredObservations: ATR_WINDOW + 2,
          availableObservations: bars.length,
        },
      );
  const metrics = {
    returns,
    closeLocationValue: closeLocationMetric(latest),
    trueRange,
    priorAtr14,
    normalizedTrueRangeAtr14,
    gapPercent: gapMetric(latest, previous),
    relativeVolume20: relativeVolumeMetric(bars),
    directionalEfficiency: Object.fromEntries(
      DIRECTIONAL_EFFICIENCY_WINDOWS.map((window) => [
        String(window),
        directionalEfficiencyMetric(bars, window),
      ]),
    ),
  };
  const allMetrics = flattenMetrics(metrics);
  const availableCount = allMetrics.filter((metric) => metric.status === "available").length;

  return {
    schemaVersion: 1,
    methodVersion: DAILY_SEQUENCE_METHOD_VERSION,
    status: availableCount === 0
      ? "unavailable"
      : availableCount === allMetrics.length
        ? "complete"
        : "partial",
    inputHash,
    input: {
      observationCount: bars.length,
      startAt: bars[0]?.identity ?? null,
      endAt: latest?.identity ?? null,
      order: "ascending",
      completedBarsAssumed: true,
      priceAdjustment: "caller_supplied",
      tradeSession: "caller_supplied",
    },
    metrics,
  };
}

/**
 * Calculate same-date simple excess returns. Each benchmark window must have
 * observations on the target window's exact start and end identities. Missing
 * dates remain unavailable rather than being forward-filled or treated as 0.
 */
export function calculateDailyExcessReturns(targetInput = [], benchmarkInput = []) {
  const target = normalizeCompletedDailyBars(targetInput);
  const benchmark = normalizeCompletedDailyBars(benchmarkInput);
  const targetHash = hashBars(target);
  const benchmarkHash = hashBars(benchmark);
  const benchmarkByIdentity = new Map(benchmark.map((bar) => [bar.identity, bar]));
  const targetEnd = target.at(-1) ?? null;
  const windows = {};

  for (const window of DAILY_SEQUENCE_WINDOWS) {
    const key = String(window);
    if (target.length < window + 1) {
      windows[key] = unavailableMetric("percent_point", "insufficient_target_history", {
        requiredObservations: window + 1,
        availableObservations: target.length,
      });
      continue;
    }
    if (!benchmark.length) {
      windows[key] = unavailableMetric("percent_point", "benchmark_unavailable", {
        requiredObservations: 2,
        availableObservations: 0,
      });
      continue;
    }
    const targetStart = target[target.length - 1 - window];
    const benchmarkStart = benchmarkByIdentity.get(targetStart.identity);
    const benchmarkEnd = benchmarkByIdentity.get(targetEnd.identity);
    if (!benchmarkStart || !benchmarkEnd) {
      windows[key] = unavailableMetric(
        "percent_point",
        !benchmarkStart && !benchmarkEnd
          ? "benchmark_start_and_end_dates_missing"
          : !benchmarkStart
            ? "benchmark_start_date_missing"
            : "benchmark_end_date_missing",
        {
          startAt: targetStart.identity,
          endAt: targetEnd.identity,
        },
      );
      continue;
    }
    const targetReturn = percentReturn(targetStart.close, targetEnd.close);
    const benchmarkReturn = percentReturn(benchmarkStart.close, benchmarkEnd.close);
    windows[key] = availableMetric(
      targetReturn - benchmarkReturn,
      "percent_point",
      {
        basis: "target_simple_return_percent - benchmark_simple_return_percent",
        startAt: targetStart.identity,
        endAt: targetEnd.identity,
        targetReturnPercent: targetReturn,
        benchmarkReturnPercent: benchmarkReturn,
      },
    );
  }

  const values = Object.values(windows);
  const availableCount = values.filter((metric) => metric.status === "available").length;
  return {
    schemaVersion: 1,
    methodVersion: DAILY_SEQUENCE_METHOD_VERSION,
    calculation: "same_date_simple_excess_return",
    status: availableCount === 0
      ? "unavailable"
      : availableCount === values.length
        ? "complete"
        : "partial",
    inputHash: createHash("sha256")
      .update(JSON.stringify({ targetHash, benchmarkHash }))
      .digest("hex"),
    targetInputHash: targetHash,
    benchmarkInputHash: benchmarkHash,
    asOf: targetEnd?.identity ?? null,
    windows,
  };
}

export function normalizeCompletedDailyBars(input = []) {
  if (!Array.isArray(input)) {
    throw new DailySequenceInputError("input_not_array", "Daily sequence input must be an array.");
  }
  const bars = input.map((bar, index) => normalizeBar(bar, index));
  for (let index = 1; index < bars.length; index += 1) {
    if (bars[index].sortTime <= bars[index - 1].sortTime) {
      throw new DailySequenceInputError(
        "bars_not_strictly_ascending",
        `Daily bars must be strictly ascending and unique; row ${index + 1} is not after row ${index}.`,
        {
          previous: bars[index - 1].identity,
          current: bars[index].identity,
          index,
        },
      );
    }
  }
  return bars;
}

function normalizeBar(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DailySequenceInputError(
      "bar_not_object",
      `Daily bar ${index + 1} must be an object.`,
      { index },
    );
  }
  const explicitStatus = String(
    value.barStatus ?? value.bar_status ?? value.status ?? value.state ?? "",
  ).trim().toLowerCase();
  if (value.isClosed === false || value.is_closed === false || FORMING_STATUSES.has(explicitStatus)) {
    throw new DailySequenceInputError(
      "forming_bar_not_allowed",
      `Daily bar ${index + 1} is explicitly forming; the caller must exclude it.`,
      { index },
    );
  }
  const { identity, sortTime } = normalizeIdentity(value, index);
  const open = requiredFiniteNumber(value.open, "open", index);
  const high = requiredFiniteNumber(value.high, "high", index);
  const low = requiredFiniteNumber(value.low, "low", index);
  const close = requiredFiniteNumber(value.close, "close", index);
  const volume = requiredFiniteNumber(value.volume, "volume", index);
  if ([open, high, low, close].some((number) => number <= 0)) {
    throw new DailySequenceInputError(
      "non_positive_price",
      `Daily bar ${index + 1} contains a non-positive OHLC price.`,
      { index },
    );
  }
  if (volume < 0) {
    throw new DailySequenceInputError(
      "negative_volume",
      `Daily bar ${index + 1} contains negative volume.`,
      { index },
    );
  }
  if (high < low || open < low || open > high || close < low || close > high) {
    throw new DailySequenceInputError(
      "invalid_ohlc_relationship",
      `Daily bar ${index + 1} has inconsistent OHLC bounds.`,
      { index, open, high, low, close },
    );
  }
  return { identity, sortTime, open, high, low, close, volume };
}

function normalizeIdentity(value, index) {
  const exchangeDate = String(value.tradeDate ?? value.trade_date ?? value.date ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(exchangeDate)) {
    const sortTime = Date.parse(`${exchangeDate}T00:00:00.000Z`);
    if (Number.isFinite(sortTime)) return { identity: exchangeDate, sortTime };
  }
  const parsed = Date.parse(String(value.timestamp ?? value.time ?? ""));
  if (!Number.isFinite(parsed)) {
    throw new DailySequenceInputError(
      "bar_time_missing_or_invalid",
      `Daily bar ${index + 1} needs a valid tradeDate/date or timestamp.`,
      { index },
    );
  }
  return { identity: new Date(parsed).toISOString(), sortTime: parsed };
}

function requiredFiniteNumber(value, field, index) {
  if (value == null || value === "" || typeof value === "boolean") {
    throw new DailySequenceInputError(
      "numeric_field_missing",
      `Daily bar ${index + 1} is missing ${field}.`,
      { index, field },
    );
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new DailySequenceInputError(
      "numeric_field_invalid",
      `Daily bar ${index + 1} has a non-finite ${field}.`,
      { index, field },
    );
  }
  return number;
}

function returnMetric(bars, window) {
  if (bars.length < window + 1) {
    return unavailableMetric("percent_point", "insufficient_history", {
      requiredObservations: window + 1,
      availableObservations: bars.length,
    });
  }
  const start = bars[bars.length - 1 - window];
  const end = bars.at(-1);
  return availableMetric(percentReturn(start.close, end.close), "percent_point", {
    basis: "simple_close_to_close_return",
    sessions: window,
    startAt: start.identity,
    endAt: end.identity,
  });
}

function closeLocationMetric(bar) {
  if (!bar) {
    return unavailableMetric("ratio", "no_observations", {
      requiredObservations: 1,
      availableObservations: 0,
    });
  }
  const range = bar.high - bar.low;
  if (range === 0) {
    return unavailableMetric("ratio", "zero_session_range", {
      requiredObservations: 1,
      availableObservations: 1,
    });
  }
  return availableMetric((2 * bar.close - bar.high - bar.low) / range, "ratio", {
    basis: "(2*close-high-low)/(high-low)",
  });
}

function priorAtrMetric(bars) {
  const required = ATR_WINDOW + 2;
  if (bars.length < required) {
    return unavailableMetric("price", "insufficient_history_for_prior_atr14", {
      requiredObservations: required,
      availableObservations: bars.length,
    });
  }
  const endIndex = bars.length - 2;
  const startIndex = endIndex - ATR_WINDOW + 1;
  const values = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    values.push(trueRangeAt(bars, index));
  }
  return availableMetric(mean(values), "price", {
    basis: "simple_mean_of_14_true_ranges_ending_prior_session",
    sessions: ATR_WINDOW,
    startAt: bars[startIndex].identity,
    endAt: bars[endIndex].identity,
  });
}

function gapMetric(latest, previous) {
  if (!latest || !previous) {
    return unavailableMetric("percent_point", "requires_previous_close", {
      requiredObservations: 2,
      availableObservations: latest ? 1 : 0,
    });
  }
  return availableMetric(((latest.open - previous.close) / previous.close) * 100, "percent_point", {
    basis: "(open-prior_close)/prior_close*100",
    startAt: previous.identity,
    endAt: latest.identity,
  });
}

function relativeVolumeMetric(bars) {
  const required = RELATIVE_VOLUME_WINDOW + 1;
  if (bars.length < required) {
    return unavailableMetric("multiple", "insufficient_history_for_relative_volume20", {
      requiredObservations: required,
      availableObservations: bars.length,
    });
  }
  const latest = bars.at(-1);
  const prior = bars.slice(-required, -1).map((bar) => bar.volume);
  const baselineMean = mean(prior);
  if (baselineMean === 0) {
    return unavailableMetric("multiple", "prior_volume_mean_is_zero", {
      requiredObservations: required,
      availableObservations: bars.length,
      baselineMean,
    });
  }
  return availableMetric(latest.volume / baselineMean, "multiple", {
    basis: "latest_volume / prior_20_session_mean_volume",
    sessions: RELATIVE_VOLUME_WINDOW,
    baselineMean,
    currentVolume: latest.volume,
  });
}

function directionalEfficiencyMetric(bars, window) {
  if (bars.length < window + 1) {
    return unavailableMetric("ratio", "insufficient_history", {
      requiredObservations: window + 1,
      availableObservations: bars.length,
    });
  }
  const startIndex = bars.length - 1 - window;
  const endIndex = bars.length - 1;
  const displacement = Math.abs(bars[endIndex].close - bars[startIndex].close);
  let travel = 0;
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    travel += Math.abs(bars[index].close - bars[index - 1].close);
  }
  if (travel === 0) {
    return unavailableMetric("ratio", "zero_price_travel", {
      requiredObservations: window + 1,
      availableObservations: bars.length,
      sessions: window,
    });
  }
  return availableMetric(displacement / travel, "ratio", {
    basis: "abs(close_t-close_t-n)/sum(abs(close_i-close_i-1))",
    sessions: window,
    startAt: bars[startIndex].identity,
    endAt: bars[endIndex].identity,
  });
}

function trueRangeAt(bars, index) {
  const bar = bars[index];
  if (index === 0) return bar.high - bar.low;
  const priorClose = bars[index - 1].close;
  return Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - priorClose),
    Math.abs(bar.low - priorClose),
  );
}

function percentReturn(start, end) {
  return ((end / start) - 1) * 100;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function hashBars(bars) {
  const canonical = bars.map(({ identity, open, high, low, close, volume }) => ({
    identity,
    open,
    high,
    low,
    close,
    volume,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function availableMetric(value, unit, metadata = {}) {
  return { status: "available", value, unit, reason: null, ...metadata };
}

function unavailableMetric(unit, reason, metadata = {}) {
  return { status: "unavailable", value: null, unit, reason, ...metadata };
}

function flattenMetrics(metrics) {
  return [
    ...Object.values(metrics.returns),
    metrics.closeLocationValue,
    metrics.trueRange,
    metrics.priorAtr14,
    metrics.normalizedTrueRangeAtr14,
    metrics.gapPercent,
    metrics.relativeVolume20,
    ...Object.values(metrics.directionalEfficiency),
  ];
}
