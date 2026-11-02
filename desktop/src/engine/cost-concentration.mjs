import { createHash } from "node:crypto";

/**
 * Deterministic 14/28-session volume-at-price proxy for completed daily OHLCV.
 *
 * This is deliberately a low-confidence estimate: a daily bar has only one
 * aggregate volume observation, so its volume is allocated uniformly through
 * the bar's high-low range. It is never a holder-cost, participant-identity,
 * or order-flow dataset.
 */
export const COST_CONCENTRATION_METHOD_VERSION = "daily-cost-concentration-v1";
export const COST_CONCENTRATION_DEFAULTS = Object.freeze({
  windows: [14, 28],
  bins: 80,
  allocationMethod: "uniform_range",
  valueAreaFraction: 0.70,
  densePercentile: 0.75,
});

const FORMING_STATES = new Set([
  "forming", "open", "partial", "updating", "realtime", "live",
]);

export class CostConcentrationInputError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CostConcentrationInputError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Build 14/28 profiles from strictly ascending completed daily OHLCV bars.
 * `completedThroughTradeDate` is mandatory and must exactly equal the final
 * input bar's trade date: this prevents a caller from accidentally including
 * a forming current day or comparing windows with different endpoints.
 */
export function buildDailyCostConcentration({
  bars = [],
  completedThroughTradeDate,
  asOfTradingDate = completedThroughTradeDate,
  bins = COST_CONCENTRATION_DEFAULTS.bins,
  allocationMethod = COST_CONCENTRATION_DEFAULTS.allocationMethod,
  valueAreaFraction = COST_CONCENTRATION_DEFAULTS.valueAreaFraction,
  densePercentile = COST_CONCENTRATION_DEFAULTS.densePercentile,
} = {}) {
  const config = validateConfig({ bins, allocationMethod, valueAreaFraction, densePercentile });
  const normalized = normalizeCompletedDailyBars(bars);
  const cutoff = dateOnly(completedThroughTradeDate);
  const declaredAsOf = dateOnly(asOfTradingDate);
  if (!cutoff) {
    throw new CostConcentrationInputError(
      "completed_through_required",
      "completedThroughTradeDate is required for daily cost-concentration input.",
    );
  }
  if (!declaredAsOf || declaredAsOf !== cutoff) {
    throw new CostConcentrationInputError(
      "asof_cutoff_mismatch",
      "asOfTradingDate must equal completedThroughTradeDate.",
      { asOfTradingDate: asOfTradingDate ?? null, completedThroughTradeDate: cutoff },
    );
  }
  const finalTradeDate = normalized.at(-1)?.tradeDate ?? null;
  if (finalTradeDate !== cutoff) {
    throw new CostConcentrationInputError(
      "completed_through_mismatch",
      "The final supplied daily bar must equal completedThroughTradeDate; exclude any incomplete current day before calling.",
      { finalTradeDate, completedThroughTradeDate: cutoff },
    );
  }
  const inputHash = hashBars(normalized);
  const baseInput = {
    barCount: normalized.length,
    sessionCount: normalized.length,
    tradeSession: "completed_daily_sessions_caller_attested",
    inputResolution: "daily_single_bar",
    completedThroughTradeDate: cutoff,
    asOfTradingDate: declaredAsOf,
    sameCutoffVerified: true,
    inputHash,
  };
  const profiles = Object.fromEntries(COST_CONCENTRATION_DEFAULTS.windows.map((window) => [
    String(window),
    buildProfile(normalized, window, config, cutoff),
  ]));
  const shortProfile = profiles["14"];
  const longProfile = profiles["28"];
  const comparison = shortProfile.status === "available" && longProfile.status === "available"
    ? compareProfiles(shortProfile, longProfile)
    : unavailableComparison(shortProfile, longProfile);
  const availableProfiles = Object.values(profiles).filter((profile) => profile.status === "available").length;

  return {
    schemaVersion: "cost-concentration/v1",
    methodVersion: COST_CONCENTRATION_METHOD_VERSION,
    status: availableProfiles === 2 ? "complete" : availableProfiles ? "partial" : "unavailable",
    input: baseInput,
    configuration: config,
    profiles,
    comparison,
    limitations: [
      "estimate_not_holder_cost_basis",
      "daily_single_bar_low_confidence",
      "uniform_range_volume_allocation",
      "caller_must_exclude_incomplete_current_session",
    ],
    notes: [
      "Daily OHLCV allocation is a price-volume concentration estimate, not actual holder cost basis.",
      "Each daily bar volume is distributed uniformly through its reported high-low range.",
      "Acceptance describes only the last up-to-three completed daily closes and needs market, volume, and time confirmation.",
    ],
  };
}

function buildProfile(bars, window, config, cutoff) {
  if (bars.length < window) {
    return unavailableProfile(window, "insufficient_completed_sessions", {
      requiredSessions: window,
      availableSessions: bars.length,
      completedThroughTradeDate: cutoff,
    });
  }
  const selected = bars.slice(-window);
  const profileLow = Math.min(...selected.map((bar) => bar.low));
  const profileHigh = Math.max(...selected.map((bar) => bar.high));
  if (!(profileHigh > profileLow)) {
    return unavailableProfile(window, "profile_has_no_price_range", {
      completedThroughTradeDate: cutoff,
      startTradeDate: selected[0].tradeDate,
      endTradeDate: selected.at(-1).tradeDate,
    });
  }
  const binWidth = (profileHigh - profileLow) / config.bins;
  const volumes = allocateUniformRangeVolume(selected, profileLow, binWidth, config.bins);
  const totalVolume = volumes.reduce((sum, volume) => sum + volume, 0);
  if (!(totalVolume > 0)) {
    return unavailableProfile(window, "profile_has_no_positive_volume", {
      completedThroughTradeDate: cutoff,
      startTradeDate: selected[0].tradeDate,
      endTradeDate: selected.at(-1).tradeDate,
    });
  }
  const pocIndex = maxIndex(volumes);
  const [valueAreaLowIndex, valueAreaHighIndex] = contiguousValueArea(
    volumes,
    pocIndex,
    config.valueAreaFraction,
  );
  const positiveVolumes = volumes.filter((volume) => volume > 0);
  const denseThreshold = percentile(positiveVolumes, config.densePercentile);
  const val = profileLow + valueAreaLowIndex * binWidth;
  const vah = profileLow + (valueAreaHighIndex + 1) * binWidth;
  const currentPrice = bars.at(-1).close;
  const sessionCloses = selected.map((bar) => bar.close);

  return {
    status: "available",
    windowSessions: window,
    startTradeDate: selected[0].tradeDate,
    endTradeDate: selected.at(-1).tradeDate,
    completedThroughTradeDate: cutoff,
    sameCutoffVerified: selected.at(-1).tradeDate === cutoff,
    barCount: selected.length,
    barsPerSession: 1,
    inputResolution: "daily_single_bar",
    allocationMethod: config.allocationMethod,
    profileIsEstimate: true,
    estimateNotHolderCostBasis: true,
    confidence: "low",
    confidenceReasons: ["daily_single_bar", "uniform_range_volume_allocation"],
    binCount: config.bins,
    binWidth: round(binWidth, 8),
    valueAreaFraction: config.valueAreaFraction,
    densePercentile: config.densePercentile,
    totalAllocatedVolume: round(totalVolume, 6),
    poc: round(profileLow + (pocIndex + 0.5) * binWidth),
    pocVolumeShare: round(volumes[pocIndex] / totalVolume, 8),
    val: round(val),
    vah: round(vah),
    valueAreaWidth: round(vah - val),
    denseZones: mergeDenseZones(volumes, denseThreshold, profileLow, binWidth, totalVolume),
    hvn: localNodes(volumes, profileLow, binWidth).hvn,
    lvn: localNodes(volumes, profileLow, binWidth).lvn,
    currentPrice: round(currentPrice),
    currentPriceLocation: priceLocation(currentPrice, val, vah),
    acceptance: acceptanceState(sessionCloses, val, vah),
  };
}

function compareProfiles(shortProfile, longProfile) {
  const intersection = Math.max(0, Math.min(shortProfile.vah, longProfile.vah) - Math.max(shortProfile.val, longProfile.val));
  const union = Math.max(shortProfile.vah, longProfile.vah) - Math.min(shortProfile.val, longProfile.val);
  const overlap = union ? intersection / union : 1;
  const shift = shortProfile.poc - longProfile.poc;
  const tolerance = Math.max(shortProfile.binWidth, longProfile.binWidth);
  let migrationState;
  let newRegimeSide = null;
  if (shortProfile.poc > longProfile.vah) {
    migrationState = "new_regime_outside_28";
    newRegimeSide = "above_long_value_area";
  } else if (shortProfile.poc < longProfile.val) {
    migrationState = "new_regime_outside_28";
    newRegimeSide = "below_long_value_area";
  } else if (
    shortProfile.val >= longProfile.val
    && shortProfile.vah <= longProfile.vah
    && shortProfile.valueAreaWidth <= longProfile.valueAreaWidth * 0.65
  ) {
    migrationState = "compression_inside_28";
  } else if (Math.abs(shift) <= tolerance && overlap >= 0.60) {
    migrationState = "overlapping";
  } else if (shift > 0) {
    migrationState = "upward";
  } else {
    migrationState = "downward";
  }
  return {
    status: "available",
    shortWindow: shortProfile.windowSessions,
    longWindow: longProfile.windowSessions,
    completedThroughTradeDate: shortProfile.completedThroughTradeDate,
    sameCutoffVerified: shortProfile.endTradeDate === longProfile.endTradeDate
      && shortProfile.endTradeDate === shortProfile.completedThroughTradeDate,
    pocShift: round(shift),
    pocShiftPercentOfLongPoc: longProfile.poc ? round(shift / longProfile.poc * 100) : null,
    valueAreaOverlapRatio: round(overlap, 8),
    shortPocVsLongValueArea: priceLocation(shortProfile.poc, longProfile.val, longProfile.vah),
    migrationState,
    newRegimeSide,
  };
}

function unavailableComparison(shortProfile, longProfile) {
  return {
    status: "unavailable",
    reasonCodes: [
      ...(shortProfile.status === "available" ? [] : [`14d_${shortProfile.reasonCode ?? "unavailable"}`]),
      ...(longProfile.status === "available" ? [] : [`28d_${longProfile.reasonCode ?? "unavailable"}`]),
    ],
  };
}

function unavailableProfile(window, reasonCode, details = {}) {
  return {
    status: "unavailable",
    windowSessions: window,
    reasonCode,
    profileIsEstimate: true,
    estimateNotHolderCostBasis: true,
    confidence: "low",
    ...details,
  };
}

function allocateUniformRangeVolume(rows, profileLow, binWidth, bins) {
  const volumes = Array(bins).fill(0);
  for (const row of rows) {
    if (row.volume === 0) continue;
    if (row.high === row.low) {
      volumes[binIndex(row.low, profileLow, binWidth, bins)] += row.volume;
      continue;
    }
    const start = binIndex(row.low, profileLow, binWidth, bins);
    const end = binIndex(row.high, profileLow, binWidth, bins);
    const overlaps = [];
    for (let index = start; index <= end; index += 1) {
      const binLow = profileLow + index * binWidth;
      const binHigh = binLow + binWidth;
      const overlap = Math.max(0, Math.min(row.high, binHigh) - Math.max(row.low, binLow));
      if (overlap > 0) overlaps.push([index, overlap]);
    }
    const totalOverlap = overlaps.reduce((sum, [, overlap]) => sum + overlap, 0);
    if (totalOverlap === 0) {
      volumes[binIndex(row.close, profileLow, binWidth, bins)] += row.volume;
    } else {
      for (const [index, overlap] of overlaps) volumes[index] += row.volume * overlap / totalOverlap;
    }
  }
  return volumes;
}

function contiguousValueArea(volumes, poc, fraction) {
  const selected = new Set([poc]);
  let accumulated = volumes[poc];
  const total = volumes.reduce((sum, volume) => sum + volume, 0);
  let left = poc - 1;
  let right = poc + 1;
  while (accumulated < total * fraction && (left >= 0 || right < volumes.length)) {
    const leftVolume = left >= 0 ? volumes[left] : -1;
    const rightVolume = right < volumes.length ? volumes[right] : -1;
    if (leftVolume === rightVolume && left >= 0 && right < volumes.length) {
      selected.add(left);
      selected.add(right);
      accumulated += leftVolume + rightVolume;
      left -= 1;
      right += 1;
    } else if (leftVolume >= rightVolume && left >= 0) {
      selected.add(left);
      accumulated += leftVolume;
      left -= 1;
    } else if (right < volumes.length) {
      selected.add(right);
      accumulated += rightVolume;
      right += 1;
    }
  }
  return [Math.min(...selected), Math.max(...selected)];
}

function mergeDenseZones(volumes, threshold, low, width, totalVolume) {
  const indices = volumes
    .map((volume, index) => ({ volume, index }))
    .filter(({ volume }) => volume >= threshold && volume > 0)
    .map(({ index }) => index);
  if (!indices.length) return [];
  const groups = [[indices[0]]];
  for (const index of indices.slice(1)) {
    if (index === groups.at(-1).at(-1) + 1) groups.at(-1).push(index);
    else groups.push([index]);
  }
  return groups.map((group) => {
    const volume = group.reduce((sum, index) => sum + volumes[index], 0);
    return {
      low: round(low + group[0] * width),
      high: round(low + (group.at(-1) + 1) * width),
      volumeShare: round(volume / totalVolume, 8),
    };
  }).sort((left, right) => right.volumeShare - left.volumeShare).slice(0, 4);
}

function localNodes(volumes, low, width) {
  const smoothed = volumes.map((_, index) => {
    const start = Math.max(0, index - 1);
    const end = Math.min(volumes.length, index + 2);
    return mean(volumes.slice(start, end));
  });
  const medianVolume = median(smoothed);
  const candidates = (predicate, sort) => smoothed
    .map((value, index) => ({ value, index }))
    .filter(({ value, index }) => index > 0 && index < volumes.length - 1 && predicate(value, index))
    .sort(sort)
    .slice(0, 3)
    .map(({ index }) => round(low + (index + 0.5) * width));
  return {
    hvn: candidates(
      (value, index) => value >= smoothed[index - 1] && value >= smoothed[index + 1] && value > medianVolume,
      (left, right) => volumes[right.index] - volumes[left.index],
    ),
    lvn: candidates(
      (value, index) => value <= smoothed[index - 1] && value <= smoothed[index + 1] && value < medianVolume,
      (left, right) => volumes[left.index] - volumes[right.index],
    ),
  };
}

function acceptanceState(closes, val, vah) {
  const recent = closes.slice(-3);
  const locations = recent.map((close) => priceLocation(close, val, vah));
  const current = locations.at(-1) ?? null;
  let consecutive = 0;
  for (const location of [...locations].reverse()) {
    if (location !== current) break;
    consecutive += 1;
  }
  let state;
  if (current === "above_value_area") state = consecutive >= 2 ? "accepted_above" : "probing_above";
  else if (current === "below_value_area") state = consecutive >= 2 ? "accepted_below" : "probing_below";
  else if (locations.length >= 2 && locations.at(-2) === "above_value_area") state = "rejected_from_above";
  else if (locations.length >= 2 && locations.at(-2) === "below_value_area") state = "rejected_from_below";
  else if (consecutive >= 2) state = "accepted_inside";
  else state = "mixed_inside";
  return {
    state,
    lookbackSessions: recent.length,
    consecutiveClosesInCurrentLocation: consecutive,
    recentSessionCloses: recent.map((close) => round(close)),
    recentCloseLocations: locations,
  };
}

function normalizeCompletedDailyBars(input) {
  if (!Array.isArray(input)) {
    throw new CostConcentrationInputError("bars_not_array", "Daily cost-concentration bars must be an array.");
  }
  const bars = input.map((bar, index) => normalizeBar(bar, index));
  for (let index = 1; index < bars.length; index += 1) {
    if (bars[index].tradeDate <= bars[index - 1].tradeDate) {
      throw new CostConcentrationInputError(
        "trade_dates_not_strictly_ascending",
        "Daily cost-concentration bars must have unique ascending trade dates.",
        { previous: bars[index - 1].tradeDate, current: bars[index].tradeDate },
      );
    }
  }
  return bars;
}

function normalizeBar(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CostConcentrationInputError("bar_not_object", `Daily bar ${index + 1} must be an object.`);
  }
  if (isExplicitlyForming(raw)) {
    throw new CostConcentrationInputError(
      "forming_bar_not_allowed",
      `Daily bar ${index + 1} is explicitly forming; exclude it before calculating cost concentration.`,
      { index },
    );
  }
  const tradeDate = dateOnly(raw.tradeDate ?? raw.trade_date ?? raw.timestamp);
  if (!tradeDate) {
    throw new CostConcentrationInputError("trade_date_invalid", `Daily bar ${index + 1} has no valid trade date.`);
  }
  const open = finiteNumber(raw.open, "open", index);
  const high = finiteNumber(raw.high, "high", index);
  const low = finiteNumber(raw.low, "low", index);
  const close = finiteNumber(raw.close, "close", index);
  const volume = finiteNumber(raw.volume, "volume", index);
  if ([open, high, low, close].some((value) => value <= 0)) {
    throw new CostConcentrationInputError("non_positive_price", `Daily bar ${index + 1} has non-positive OHLC.`);
  }
  if (volume < 0 || high < low || open < low || open > high || close < low || close > high) {
    throw new CostConcentrationInputError("invalid_ohlcv", `Daily bar ${index + 1} has invalid OHLCV relationships.`);
  }
  return { tradeDate, open, high, low, close, volume };
}

function validateConfig({ bins, allocationMethod, valueAreaFraction, densePercentile }) {
  const normalizedBins = Math.trunc(Number(bins));
  if (!Number.isFinite(normalizedBins) || normalizedBins < 10) {
    throw new CostConcentrationInputError("bin_count_invalid", "Bin count must be at least 10.");
  }
  if (allocationMethod !== "uniform_range") {
    throw new CostConcentrationInputError("allocation_method_unsupported", "Daily cost concentration supports uniform_range only.");
  }
  const valueArea = Number(valueAreaFraction);
  const dense = Number(densePercentile);
  if (!(valueArea > 0 && valueArea < 1) || !(dense > 0 && dense < 1)) {
    throw new CostConcentrationInputError("profile_fraction_invalid", "Value-area and dense-percentile fractions must be between 0 and 1.");
  }
  return {
    windows: [...COST_CONCENTRATION_DEFAULTS.windows],
    bins: normalizedBins,
    allocationMethod: "uniform_range",
    valueAreaFraction: valueArea,
    densePercentile: dense,
  };
}

function isExplicitlyForming(bar) {
  if (bar.isClosed === false || bar.is_closed === false || bar.complete === false || bar.confirmed === false) return true;
  const status = String(bar.barStatus ?? bar.bar_status ?? bar.status ?? bar.state ?? "").trim().toLowerCase();
  return FORMING_STATES.has(status);
}

function finiteNumber(value, field, index) {
  if (value == null || value === "" || typeof value === "boolean") {
    throw new CostConcentrationInputError(
      "number_missing",
      `Daily bar ${index + 1} is missing ${field}.`,
      { index, field },
    );
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new CostConcentrationInputError("number_invalid", `Daily bar ${index + 1} has invalid ${field}.`);
  }
  return number;
}

function dateOnly(value) {
  const text = String(value ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

function binIndex(price, low, width, bins) {
  return Math.min(Math.max(Math.trunc((price - low) / width), 0), bins - 1);
}

function maxIndex(values) {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] > values[best]) best = index;
  }
  return best;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function priceLocation(price, val, vah) {
  if (price > vah) return "above_value_area";
  if (price < val) return "below_value_area";
  return "inside_value_area";
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function hashBars(bars) {
  return createHash("sha256")
    .update(JSON.stringify(bars.map((bar) => [bar.tradeDate, bar.open, bar.high, bar.low, bar.close, bar.volume])))
    .digest("hex");
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
