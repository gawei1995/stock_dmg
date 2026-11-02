import { createHash } from "node:crypto";

export const NUMERIC_EVIDENCE_SCHEMA_VERSION = "numeric-evidence/v1";

export const NUMERIC_EVIDENCE_KINDS = Object.freeze([
  "observed_fact",
  "derived_metric",
  "model_proposal",
  "host_decision",
]);

export const NUMERIC_EVIDENCE_AVAILABILITY = Object.freeze([
  "known",
  "unknown",
  "not_applicable",
]);

const FRESHNESS_STATES = new Set([
  "live",
  "fresh",
  "stale",
  "cached",
  "historical",
  "unknown",
  "not_applicable",
]);
const CONFIDENCE_STATES = new Set([
  "high",
  "medium",
  "low",
  "unknown",
  "not_applicable",
]);
const SESSION_STATES = new Set([
  "regular",
  "pre_market",
  "post_market",
  "overnight",
  "all",
  "unknown",
  "not_applicable",
]);
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const METRIC_PATTERN = /^[a-z][a-z0-9_.-]{0,119}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const TRADING_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DECIMAL_DIGITS = 1_000;

/**
 * Create one immutable numeric evidence item and attach a content hash.
 * All public factory helpers eventually use this function.
 */
export function createNumericEvidence(input) {
  const normalized = normalizeEvidence(input, { requireHash: false });
  const hash = hashCanonical(normalized);
  if (input?.hash != null && input.hash !== hash) {
    throw new TypeError("numeric evidence hash does not match its canonical content");
  }
  return deepFreeze({ ...normalized, hash });
}

export function createObservedFact(input) {
  return createNumericEvidence({ ...input, kind: "observed_fact" });
}

export function createDerivedMetric(input) {
  return createNumericEvidence({ ...input, kind: "derived_metric" });
}

export function createModelProposal(input) {
  return createNumericEvidence({ ...input, kind: "model_proposal" });
}

export function createHostDecision(input) {
  return createNumericEvidence({ ...input, kind: "host_decision" });
}

/** Validate an already-created evidence item, including its content hash. */
export function validateNumericEvidence(input) {
  const normalized = normalizeEvidence(input, { requireHash: true });
  const expectedHash = hashCanonical(normalized);
  if (input.hash !== expectedHash) {
    throw new TypeError("numeric evidence hash does not match its canonical content");
  }
  return deepFreeze({ ...normalized, hash: expectedHash });
}

/** Return the stable hash without mutating or attaching it to the input. */
export function stableNumericEvidenceHash(input) {
  return hashCanonical(normalizeEvidence(input, { requireHash: false }));
}

/** Produce an auditable reference suitable for provenance.inputRefs. */
export function numericEvidenceRef(evidence) {
  const validated = validateNumericEvidence(evidence);
  return deepFreeze({ factId: validated.factId, hash: validated.hash });
}

/**
 * Convert a finite decimal input into a non-exponent canonical decimal string.
 * `0`, `-0`, and zero with any scale all normalize to the real value `"0"`.
 */
export function normalizeDecimalString(value) {
  if (!["string", "number", "bigint"].includes(typeof value)) {
    throw new TypeError("numeric evidence value must be a decimal string, finite number, or bigint");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("numeric evidence value cannot be NaN or Infinity");
  }
  const source = String(value).trim();
  if (!source || /[%_,]/.test(source)) {
    throw new TypeError("numeric evidence value must be an unformatted decimal without percent signs or separators");
  }
  const match = source.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/);
  if (!match) throw new TypeError("numeric evidence value is not a valid finite decimal");

  const sign = match[1] === "-" ? "-" : "";
  const integer = match[2] ?? "0";
  const fraction = match[3] ?? match[4] ?? "";
  const exponent = Number(match[5] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_DECIMAL_DIGITS) {
    throw new RangeError("numeric evidence exponent is outside the supported canonical range");
  }

  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + exponent;
  let expanded;
  if (decimalIndex <= 0) {
    expanded = `0.${"0".repeat(-decimalIndex)}${digits}`;
  } else if (decimalIndex >= digits.length) {
    expanded = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  } else {
    expanded = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  }
  if (expanded.length > MAX_DECIMAL_DIGITS + 2) {
    throw new RangeError("numeric evidence decimal is too large to canonicalize");
  }

  let [whole, fractional = ""] = expanded.split(".");
  whole = whole.replace(/^0+(?=\d)/, "");
  fractional = fractional.replace(/0+$/, "");
  const canonical = fractional ? `${whole}.${fractional}` : whole;
  return /^0(?:\.0*)?$/.test(canonical) ? "0" : `${sign}${canonical}`;
}

function normalizeEvidence(input, { requireHash }) {
  assertPlainObject(input, "numeric evidence");
  assertOnlyKeys(input, [
    "schemaVersion",
    "factId",
    "kind",
    "metric",
    "value",
    "availability",
    "unit",
    "asOf",
    "provenance",
    "quality",
    "display",
    "hash",
  ], "numeric evidence");

  const schemaVersion = input.schemaVersion ?? NUMERIC_EVIDENCE_SCHEMA_VERSION;
  if (schemaVersion !== NUMERIC_EVIDENCE_SCHEMA_VERSION) {
    throw new TypeError(`unsupported numeric evidence schema: ${String(schemaVersion)}`);
  }
  const factId = boundedText(input.factId, "factId", 240);
  const kind = enumValue(input.kind, NUMERIC_EVIDENCE_KINDS, "kind");
  const metric = boundedText(input.metric, "metric", 120);
  if (!METRIC_PATTERN.test(metric)) {
    throw new TypeError("metric must be a lowercase canonical identifier");
  }
  const availability = enumValue(
    input.availability,
    NUMERIC_EVIDENCE_AVAILABILITY,
    "availability",
  );
  const value = input.value == null ? null : normalizeDecimalString(input.value);
  if (availability === "known" && value == null) {
    throw new TypeError("known numeric evidence must contain a value; use unknown for missing data");
  }
  if (availability !== "known" && value != null) {
    throw new TypeError(`${availability} numeric evidence must use value: null`);
  }

  const unit = normalizeUnit(input.unit, value);
  const asOf = normalizeAsOf(input.asOf);
  const provenance = normalizeProvenance(input.provenance, kind);
  const quality = normalizeQuality(input.quality, availability);
  const display = input.display == null ? null : normalizeDisplay(input.display);

  if (requireHash && !HASH_PATTERN.test(String(input.hash ?? ""))) {
    throw new TypeError("validated numeric evidence requires a sha256 content hash");
  }
  return {
    schemaVersion,
    factId,
    kind,
    metric,
    value,
    availability,
    unit,
    asOf,
    provenance,
    quality,
    display,
  };
}

function normalizeUnit(input, value) {
  assertPlainObject(input, "unit");
  const kind = String(input.kind ?? "").trim();
  if (["percent", "percentage", "%", "pct"].includes(kind.toLowerCase())) {
    throw new TypeError("ambiguous percentage unit; use percent_point explicitly");
  }

  if (kind === "percent_point") {
    assertOnlyKeys(input, ["kind", "basis"], "percent_point unit");
    return { kind, basis: boundedText(input.basis, "percent_point basis", 160) };
  }
  if (kind === "money") {
    assertOnlyKeys(input, ["kind", "currency"], "money unit");
    return { kind, currency: currency(input.currency, "money currency") };
  }
  if (kind === "price") {
    assertOnlyKeys(input, ["kind", "currency", "symbol", "tickSize"], "price unit");
    if (value != null && compareCanonicalDecimal(value, "0") < 0) {
      throw new RangeError("price cannot be negative");
    }
    const tickSize = input.tickSize == null ? null : normalizeDecimalString(input.tickSize);
    if (tickSize != null && compareCanonicalDecimal(tickSize, "0") <= 0) {
      throw new RangeError("price tickSize must be positive");
    }
    return {
      kind,
      currency: currency(input.currency, "price currency"),
      symbol: boundedText(input.symbol, "price symbol", 80),
      tickSize,
    };
  }
  if (kind === "fx") {
    assertOnlyKeys(input, ["kind", "baseCurrency", "quoteCurrency", "direction"], "fx unit");
    const baseCurrency = currency(input.baseCurrency, "FX baseCurrency");
    const quoteCurrency = currency(input.quoteCurrency, "FX quoteCurrency");
    if (baseCurrency === quoteCurrency) {
      throw new TypeError("FX baseCurrency and quoteCurrency must differ");
    }
    if (input.direction !== "quote_per_base") {
      throw new TypeError("FX direction must be the unambiguous quote_per_base contract");
    }
    if (value != null && compareCanonicalDecimal(value, "0") <= 0) {
      throw new RangeError("known FX rates must be positive");
    }
    return { kind, baseCurrency, quoteCurrency, direction: "quote_per_base" };
  }
  if (kind === "quantity") {
    assertOnlyKeys(input, [
      "kind",
      "symbol",
      "quantityType",
      "contractMultiplier",
      "lotSize",
    ], "quantity unit");
    const quantityType = enumValue(
      input.quantityType,
      ["shares", "contracts", "units"],
      "quantityType",
    );
    const contractMultiplier = input.contractMultiplier == null
      ? null
      : normalizePositiveDecimal(input.contractMultiplier, "contractMultiplier");
    const lotSize = input.lotSize == null
      ? null
      : normalizePositiveDecimal(input.lotSize, "lotSize");
    return {
      kind,
      symbol: boundedText(input.symbol, "quantity symbol", 80),
      quantityType,
      contractMultiplier,
      lotSize,
    };
  }
  if (kind === "ratio") {
    assertOnlyKeys(input, ["kind", "basis"], "ratio unit");
    return {
      kind,
      basis: input.basis == null ? null : boundedText(input.basis, "ratio basis", 160),
    };
  }
  if (kind === "scalar") {
    assertOnlyKeys(input, ["kind", "label"], "scalar unit");
    return {
      kind,
      label: input.label == null ? null : boundedText(input.label, "scalar label", 80),
    };
  }
  if (kind === "duration") {
    assertOnlyKeys(input, ["kind", "timeUnit"], "duration unit");
    return {
      kind,
      timeUnit: enumValue(input.timeUnit, ["ms", "second", "minute", "day"], "timeUnit"),
    };
  }
  throw new TypeError(`unsupported or ambiguous numeric unit: ${kind || "missing"}`);
}

function normalizeAsOf(input) {
  assertPlainObject(input, "asOf");
  assertOnlyKeys(input, [
    "effectiveAt",
    "retrievedAt",
    "tradingDate",
    "session",
    "timeZone",
  ], "asOf");
  const effectiveAt = isoTimestamp(input.effectiveAt, "asOf.effectiveAt");
  const retrievedAt = isoTimestamp(input.retrievedAt, "asOf.retrievedAt");
  const tradingDate = input.tradingDate == null
    ? null
    : validTradingDate(input.tradingDate);
  const session = enumValue(input.session, [...SESSION_STATES], "asOf.session");
  const timeZone = validTimeZone(input.timeZone);
  return { effectiveAt, retrievedAt, tradingDate, session, timeZone };
}

function normalizeProvenance(input, kind) {
  assertPlainObject(input, "provenance");
  assertOnlyKeys(input, [
    "source",
    "tool",
    "sourceRecordId",
    "rawFields",
    "inputRefs",
    "formula",
    "methodVersion",
  ], "provenance");
  const rawFields = normalizedTextSet(input.rawFields, "provenance.rawFields", 120, 100);
  const inputRefs = normalizeFactRefs(input.inputRefs);
  const formula = input.formula == null
    ? null
    : boundedText(input.formula, "provenance.formula", 1_000);

  if (kind === "observed_fact") {
    if (!rawFields.length) throw new TypeError("observed_fact requires at least one rawFields entry");
    if (inputRefs.length) throw new TypeError("observed_fact cannot depend on derived inputRefs");
    if (formula != null) throw new TypeError("observed_fact cannot contain a derivation formula");
  } else {
    if (!inputRefs.length) throw new TypeError(`${kind} requires at least one provenance.inputRefs entry`);
    if (["derived_metric", "host_decision"].includes(kind) && formula == null) {
      throw new TypeError(`${kind} requires an explicit provenance.formula`);
    }
  }

  return {
    source: boundedText(input.source, "provenance.source", 160),
    tool: input.tool == null ? null : boundedText(input.tool, "provenance.tool", 160),
    sourceRecordId: input.sourceRecordId == null
      ? null
      : boundedText(input.sourceRecordId, "provenance.sourceRecordId", 240),
    rawFields,
    inputRefs,
    formula,
    methodVersion: boundedText(input.methodVersion, "provenance.methodVersion", 160),
  };
}

function normalizeQuality(input, availability) {
  assertPlainObject(input, "quality");
  assertOnlyKeys(input, [
    "freshness",
    "ageMs",
    "complete",
    "confidence",
    "reasonCodes",
  ], "quality");
  const ageMs = input.ageMs == null ? null : strictNonNegativeInteger(input.ageMs, "quality.ageMs");
  if (typeof input.complete !== "boolean") {
    throw new TypeError("quality.complete must be a boolean");
  }
  const reasonCodes = normalizedTextSet(input.reasonCodes, "quality.reasonCodes", 120, 50);
  if (availability !== "known" && !reasonCodes.length) {
    throw new TypeError(`${availability} numeric evidence requires at least one quality.reasonCodes entry`);
  }
  if (availability === "unknown" && input.complete) {
    throw new TypeError("unknown numeric evidence cannot be marked complete");
  }
  return {
    freshness: enumValue(input.freshness, [...FRESHNESS_STATES], "quality.freshness"),
    ageMs,
    complete: input.complete,
    confidence: enumValue(input.confidence, [...CONFIDENCE_STATES], "quality.confidence"),
    reasonCodes,
  };
}

function normalizeDisplay(input) {
  assertPlainObject(input, "display");
  assertOnlyKeys(input, ["precision", "label"], "display");
  const precision = strictNonNegativeInteger(input.precision, "display.precision");
  if (precision > 18) throw new RangeError("display.precision cannot exceed 18");
  return {
    precision,
    label: input.label == null ? null : boundedText(input.label, "display.label", 120),
  };
}

function normalizeFactRefs(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new TypeError("provenance.inputRefs must be an array");
  const refs = input.map((item) => {
    assertPlainObject(item, "numeric evidence reference");
    assertOnlyKeys(item, ["factId", "hash"], "numeric evidence reference");
    const factId = boundedText(item.factId, "reference.factId", 240);
    const hash = String(item.hash ?? "");
    if (!HASH_PATTERN.test(hash)) throw new TypeError("reference.hash must be a sha256 content hash");
    return { factId, hash };
  });
  const unique = new Map(refs.map((item) => [`${item.factId}\u0000${item.hash}`, item]));
  return [...unique.values()].sort((left, right) => (
    left.factId.localeCompare(right.factId) || left.hash.localeCompare(right.hash)
  ));
}

function normalizedTextSet(input, field, itemLimit, maxItems) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new TypeError(`${field} must be an array`);
  if (input.length > maxItems) throw new RangeError(`${field} exceeds ${maxItems} entries`);
  return [...new Set(input.map((item) => boundedText(item, field, itemLimit)))].sort();
}

function normalizePositiveDecimal(value, field) {
  const normalized = normalizeDecimalString(value);
  if (compareCanonicalDecimal(normalized, "0") <= 0) {
    throw new RangeError(`${field} must be positive`);
  }
  return normalized;
}

function compareCanonicalDecimal(left, right) {
  const normalizeParts = (value) => {
    const negative = value.startsWith("-");
    const unsigned = negative ? value.slice(1) : value;
    const [whole, fraction = ""] = unsigned.split(".");
    return { negative, whole, fraction };
  };
  const a = normalizeParts(left);
  const b = normalizeParts(right);
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  const direction = a.negative ? -1 : 1;
  if (a.whole.length !== b.whole.length) return a.whole.length > b.whole.length ? direction : -direction;
  if (a.whole !== b.whole) return a.whole > b.whole ? direction : -direction;
  const length = Math.max(a.fraction.length, b.fraction.length);
  const af = a.fraction.padEnd(length, "0");
  const bf = b.fraction.padEnd(length, "0");
  if (af === bf) return 0;
  return af > bf ? direction : -direction;
}

function hashCanonical(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(",")}}`;
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
}

function assertOnlyKeys(value, allowed, field) {
  const permitted = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !permitted.has(key));
  if (unknown.length) throw new TypeError(`${field} contains unsupported fields: ${unknown.join(", ")}`);
}

function boundedText(value, field, maxLength) {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  const text = value.trim();
  if (!text) throw new TypeError(`${field} cannot be empty`);
  if (text.length > maxLength) throw new RangeError(`${field} exceeds ${maxLength} characters`);
  if (/\p{Cc}/u.test(text)) throw new TypeError(`${field} cannot contain control characters`);
  return text;
}

function enumValue(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function currency(value, field) {
  const code = String(value ?? "").toUpperCase();
  if (!CURRENCY_PATTERN.test(code)) throw new TypeError(`${field} must be an ISO-style three-letter code`);
  return code;
}

function isoTimestamp(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${field} must be an ISO timestamp`);
  return parsed.toISOString();
}

function validTradingDate(value) {
  const date = String(value ?? "");
  if (!TRADING_DATE_PATTERN.test(date)) throw new TypeError("asOf.tradingDate must use YYYY-MM-DD");
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new TypeError("asOf.tradingDate is not a valid calendar date");
  }
  return date;
}

function validTimeZone(value) {
  const timeZone = boundedText(value, "asOf.timeZone", 80);
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
  } catch {
    throw new TypeError("asOf.timeZone must be a valid IANA time zone");
  }
  return timeZone;
}

function strictNonNegativeInteger(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
