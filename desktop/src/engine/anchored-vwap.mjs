import { createHash } from "node:crypto";

export const ANCHORED_VWAP_SCHEMA_VERSION = "anchored-vwap-evidence/v1";
export const ANCHORED_VWAP_METHOD_VERSION = "anchored-vwap-hlc3-volume/v1";

const FORMING_STATES = new Set([
  "forming",
  "open",
  "partial",
  "updating",
  "realtime",
  "live",
]);

export class AnchoredVwapInputError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AnchoredVwapInputError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Build deterministic Anchored VWAP evidence from an explicitly selected
 * anchor and completed, strictly ascending OHLCV bars. This function does not
 * choose anchors, infer events, fetch data, or produce a trade decision.
 */
export function buildAnchoredVwapEvidence({
  bars,
  completedBarsOnly = false,
  anchor,
  asOf = null,
} = {}) {
  if (completedBarsOnly !== true) {
    throw inputError(
      "completed_bars_not_explicitly_attested",
      "Anchored VWAP requires completedBarsOnly: true from the caller.",
    );
  }
  const normalizedBars = normalizeBars(bars);
  const normalizedAnchor = normalizeAnchor(anchor);
  const anchorMatch = resolveIdentity(normalizedBars, normalizedAnchor, {
    label: "anchor",
    missingCode: "anchor_not_found",
  });
  const cutoffRequest = asOf == null ? null : normalizeIdentityRequest(asOf, "asOf");
  const cutoffMatch = cutoffRequest == null
    ? normalizedBars.at(-1)
    : resolveIdentity(normalizedBars, cutoffRequest, {
        label: "asOf",
        missingCode: "as_of_not_found",
      });
  const anchorIndex = normalizedBars.indexOf(anchorMatch);
  const cutoffIndex = normalizedBars.indexOf(cutoffMatch);
  if (cutoffIndex < anchorIndex) {
    throw inputError(
      "as_of_before_anchor",
      "Anchored VWAP asOf cannot precede the explicit anchor.",
      {
        anchorTimestamp: anchorMatch.timestamp,
        asOfTimestamp: cutoffMatch.timestamp,
      },
    );
  }

  const calculationBars = normalizedBars.slice(anchorIndex, cutoffIndex + 1);
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  for (const bar of calculationBars) {
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    cumulativePriceVolume += typicalPrice * bar.volume;
    cumulativeVolume += bar.volume;
    if (!Number.isFinite(cumulativePriceVolume) || !Number.isFinite(cumulativeVolume)) {
      throw inputError(
        "calculation_overflow",
        "Anchored VWAP accumulation exceeded finite numeric range.",
      );
    }
  }
  if (!(cumulativeVolume > 0)) {
    throw inputError(
      "zero_cumulative_volume",
      "Anchored VWAP cannot be calculated from zero cumulative volume.",
    );
  }

  const vwap = cumulativePriceVolume / cumulativeVolume;
  const lastClose = cutoffMatch.close;
  const difference = lastClose - vwap;
  const differencePercent = (difference / vwap) * 100;
  const priceRelation = difference > 0 ? "above" : difference < 0 ? "below" : "at";
  const resolvedAnchor = {
    barId: anchorMatch.barId,
    timestamp: anchorMatch.timestamp,
    reason: normalizedAnchor.reason,
    source: normalizedAnchor.source,
    matchedBy: matchMode(normalizedAnchor),
  };
  const resolvedAsOf = {
    barId: cutoffMatch.barId,
    timestamp: cutoffMatch.timestamp,
    matchedBy: cutoffRequest == null ? "terminal_completed_bar" : matchMode(cutoffRequest),
  };
  const inputHash = hashCanonical({
    bars: calculationBars.map(hashableBar),
    completedBarsOnly: true,
    anchor: resolvedAnchor,
    asOf: resolvedAsOf,
  });

  return deepFreeze({
    schemaVersion: ANCHORED_VWAP_SCHEMA_VERSION,
    methodVersion: ANCHORED_VWAP_METHOD_VERSION,
    status: "available",
    inputHash,
    anchor: resolvedAnchor,
    asOf: resolvedAsOf,
    barCount: calculationBars.length,
    cumulativeVolume,
    vwap,
    asOfClose: lastClose,
    priceRelation: {
      state: priceRelation,
      difference,
      differencePercent,
      basis: "as_of_close_minus_anchored_vwap",
    },
    method: {
      name: "anchored_vwap",
      formula: "sum((((high + low + close) / 3) * volume)) / sum(volume)",
      typicalPrice: "HLC3",
      weighting: "bar_volume",
      range: "inclusive_anchor_through_as_of",
      anchorSelection: "caller_explicit_only",
      barOrder: "strictly_ascending",
      barFinality: "caller_attested_completed_only",
    },
    limitations: [
      "Anchor identity, reason, and source are caller-supplied; this module does not select or validate the economic meaning of an anchor.",
      "Bar-level HLC3 volume weighting is not tick-level execution VWAP or holder cost basis.",
      "Corporate-action adjustment, session coverage, venue coverage, and volume quality remain caller responsibilities.",
      "This evidence does not identify buyers, sellers, institutions, support, resistance, or a trade action by itself.",
    ],
    advisory: true,
    decisionAuthority: "LLM",
  });
}

function normalizeBars(input) {
  if (!Array.isArray(input)) {
    throw inputError("bars_not_array", "Anchored VWAP bars must be an array.");
  }
  if (!input.length) {
    throw inputError("bars_empty", "Anchored VWAP requires at least one completed bar.");
  }
  const bars = input.map((bar, index) => normalizeBar(bar, index, input.length));
  const seenBarIds = new Set();
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    if (bar.barId != null) {
      if (seenBarIds.has(bar.barId)) {
        throw inputError(
          "duplicate_bar_id",
          `Anchored VWAP barId must be unique; duplicate at row ${index + 1}.`,
          { barId: bar.barId, index },
        );
      }
      seenBarIds.add(bar.barId);
    }
    if (index > 0 && bar.sortTime <= bars[index - 1].sortTime) {
      throw inputError(
        "bars_not_strictly_ascending",
        `Anchored VWAP bars must be strictly ascending; row ${index + 1} is not later than row ${index}.`,
        {
          previousTimestamp: bars[index - 1].timestamp,
          currentTimestamp: bar.timestamp,
          index,
        },
      );
    }
  }
  return bars;
}

function normalizeBar(value, index, barCount) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw inputError("bar_not_object", `Anchored VWAP bar ${index + 1} must be an object.`, {
      index,
    });
  }
  if (isExplicitlyForming(value)) {
    throw inputError(
      index === barCount - 1 ? "terminal_bar_forming" : "forming_bar_not_allowed",
      `Anchored VWAP bar ${index + 1} is explicitly forming.`,
      { index, terminal: index === barCount - 1 },
    );
  }
  const timestamp = normalizeTimestamp(
    value.timestamp ?? value.time ?? value.tradeDate ?? value.trade_date ?? value.date,
    `bar ${index + 1} timestamp`,
  );
  const barId = optionalText(value.barId ?? value.bar_id ?? value.id, `bar ${index + 1} barId`, 240);
  const open = requiredFiniteNumber(value.open, "open", index);
  const high = requiredFiniteNumber(value.high, "high", index);
  const low = requiredFiniteNumber(value.low, "low", index);
  const close = requiredFiniteNumber(value.close, "close", index);
  const volume = requiredFiniteNumber(value.volume, "volume", index);
  if ([open, high, low, close].some((number) => number <= 0)) {
    throw inputError(
      "non_positive_price",
      `Anchored VWAP bar ${index + 1} contains a non-positive OHLC price.`,
      { index },
    );
  }
  if (high < low || open < low || open > high || close < low || close > high) {
    throw inputError(
      "invalid_ohlc_relationship",
      `Anchored VWAP bar ${index + 1} has inconsistent OHLC bounds.`,
      { index, open, high, low, close },
    );
  }
  if (volume < 0) {
    throw inputError(
      "negative_volume",
      `Anchored VWAP bar ${index + 1} contains negative volume.`,
      { index },
    );
  }
  if (volume === 0) {
    throw inputError(
      "zero_volume_bar",
      `Anchored VWAP bar ${index + 1} has zero volume; the calculation fails closed.`,
      { index },
    );
  }
  return {
    barId,
    timestamp,
    sortTime: Date.parse(timestamp),
    open,
    high,
    low,
    close,
    volume,
  };
}

function normalizeAnchor(value) {
  const identity = normalizeIdentityRequest(value, "anchor");
  return {
    ...identity,
    reason: requiredText(value.reason, "anchor.reason", 1_000),
    source: requiredText(value.source, "anchor.source", 300),
  };
}

function normalizeIdentityRequest(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw inputError(`${snake(label)}_invalid`, `${label} must be an object.`);
  }
  const barId = optionalText(value.barId ?? value.bar_id, `${label}.barId`, 240);
  const timestampValue = value.timestamp ?? value.time ?? null;
  const timestamp = timestampValue == null || timestampValue === ""
    ? null
    : normalizeTimestamp(timestampValue, `${label}.timestamp`);
  if (!barId && !timestamp) {
    throw inputError(
      `${snake(label)}_identity_missing`,
      `${label} requires an explicit barId, timestamp, or both.`,
    );
  }
  return { barId, timestamp };
}

function resolveIdentity(bars, request, { label, missingCode }) {
  const byBarId = request.barId == null
    ? null
    : bars.find((bar) => bar.barId === request.barId) ?? null;
  const byTimestamp = request.timestamp == null
    ? null
    : bars.find((bar) => bar.timestamp === request.timestamp) ?? null;
  if (request.barId && request.timestamp && byBarId !== byTimestamp) {
    throw inputError(
      `${snake(label)}_identity_conflict`,
      `${label} barId and timestamp do not resolve to the same bar.`,
      { barId: request.barId, timestamp: request.timestamp },
    );
  }
  const match = byBarId ?? byTimestamp;
  if (!match) {
    throw inputError(
      missingCode,
      `${label} does not match any supplied completed bar.`,
      { barId: request.barId, timestamp: request.timestamp },
    );
  }
  return match;
}

function isExplicitlyForming(bar) {
  if (bar.isClosed === false || bar.is_closed === false
    || bar.closed === false || bar.complete === false
    || bar.confirmed === false || bar.final === false
    || bar.isFinal === false || bar.is_final === false) return true;
  const status = String(
    bar.barStatus ?? bar.bar_status ?? bar.status ?? bar.state ?? "",
  ).trim().toLowerCase();
  return FORMING_STATES.has(status);
}

function requiredFiniteNumber(value, field, index) {
  if (value == null || value === "" || typeof value === "boolean") {
    throw inputError(
      "numeric_field_missing",
      `Anchored VWAP bar ${index + 1} is missing ${field}.`,
      { index, field },
    );
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw inputError(
      "numeric_field_invalid",
      `Anchored VWAP bar ${index + 1} has invalid ${field}.`,
      { index, field },
    );
  }
  return number;
}

function normalizeTimestamp(value, field) {
  if (value == null || value === "") {
    throw inputError("timestamp_missing", `${field} is required.`);
  }
  const numeric = typeof value === "number" || /^\d+$/.test(String(value).trim())
    ? Number(value)
    : null;
  const date = numeric != null && Number.isFinite(numeric)
    ? new Date(Math.abs(numeric) < 10_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw inputError("timestamp_invalid", `${field} must be a valid timestamp.`);
  }
  return date.toISOString();
}

function optionalText(value, field, limit) {
  if (value == null || value === "") return null;
  return requiredText(value, field, limit);
}

function requiredText(value, field, limit) {
  const text = String(value ?? "").trim();
  if (!text) throw inputError(`${snake(field)}_missing`, `${field} is required.`);
  if (text.length > limit) {
    throw inputError(`${snake(field)}_too_long`, `${field} exceeds ${limit} characters.`);
  }
  return text;
}

function matchMode(request) {
  return request.barId && request.timestamp
    ? "barId_and_timestamp"
    : request.barId
      ? "barId"
      : "timestamp";
}

function hashableBar(bar) {
  return [
    bar.barId,
    bar.timestamp,
    bar.open,
    bar.high,
    bar.low,
    bar.close,
    bar.volume,
  ];
}

function hashCanonical(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function snake(value) {
  return String(value).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

function inputError(code, message, details = {}) {
  return new AnchoredVwapInputError(code, message, details);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
