const STORE_KEY = "marketSeriesCacheV2";
const SCHEMA_VERSION = 2;
const DEFAULT_MAX_SERIES = 192;
const DEFAULT_MAX_BARS = 1000;

const SUPPORTED_PERIODS = new Set([
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "day",
  "week",
  "month",
  "year",
]);
const INTRADAY_PERIODS = new Set(["1m", "5m", "15m", "30m", "1h"]);
const SUPPORTED_ADJUSTMENTS = new Set(["forward", "backward", "none"]);
const SUPPORTED_SESSIONS = new Set(["intraday", "all"]);

/**
 * Encrypted multi-timeframe market-series persistence.
 *
 * Unlike the legacy daily store, intraday rows use their exact timestamp as
 * identity, so multiple bars from one exchange trading date cannot overwrite
 * one another. The caller supplies an EncryptedStore-compatible backend.
 */
export class MarketSeriesStore {
  constructor({
    store,
    endpoint,
    key = STORE_KEY,
    maxSeries = DEFAULT_MAX_SERIES,
    maxBars = DEFAULT_MAX_BARS,
    now = () => new Date().toISOString(),
  } = {}) {
    if (!store?.get || !store?.set) {
      throw new Error("MarketSeriesStore requires an encrypted key-value store.");
    }
    this.store = store;
    this.endpoint = normalizeEndpoint(endpoint);
    if (!this.endpoint) throw new Error("MarketSeriesStore requires a valid HTTPS endpoint.");
    this.key = String(key || STORE_KEY);
    this.maxSeries = positiveInteger(maxSeries, DEFAULT_MAX_SERIES);
    this.maxBars = positiveInteger(maxBars, DEFAULT_MAX_BARS);
    this.now = now;
    this.mutationQueue = Promise.resolve();
  }

  async getSeries(input = {}) {
    const descriptor = normalizeDescriptor({ ...input, endpoint: input.endpoint ?? this.endpoint });
    const state = normalizeState(await this.store.get(this.key));
    const entry = state.series[seriesKey(descriptor)];
    if (!entry?.bars?.length) return null;
    const count = Math.min(positiveInteger(input.count, this.maxBars), this.maxBars);
    return {
      schemaVersion: SCHEMA_VERSION,
      descriptor: structuredClone(entry.descriptor),
      fetchedAt: entry.fetchedAt,
      storedAt: entry.storedAt,
      barCount: entry.bars.length,
      bars: structuredClone(entry.bars.slice(-count)),
    };
  }

  async putSeries(input = {}) {
    const descriptor = normalizeDescriptor({ ...input, endpoint: input.endpoint ?? this.endpoint });
    const incoming = normalizeBars(input.bars ?? input.candles, descriptor);
    if (!incoming.length) return null;
    const fetchedAt = validIso(input.fetchedAt) ?? validIso(this.now());
    if (!fetchedAt) throw new Error("Market series fetchedAt is invalid.");

    const operation = async () => {
      const state = normalizeState(await this.store.get(this.key));
      const key = seriesKey(descriptor);
      const previous = state.series[key];
      const previousFetchedAt = Date.parse(previous?.fetchedAt ?? "");
      const incomingFetchedAt = Date.parse(fetchedAt);
      const incomingOlder = Number.isFinite(previousFetchedAt)
        && incomingFetchedAt < previousFetchedAt;
      const bars = (incomingOlder
        ? mergeBars(incoming, previous?.bars, descriptor)
        : mergeBars(previous?.bars, incoming, descriptor))
        .slice(-this.maxBars);
      const storedAt = validIso(this.now());
      if (!storedAt) throw new Error("Market series storedAt is invalid.");
      state.series[key] = {
        descriptor,
        fetchedAt: incomingOlder ? previous.fetchedAt : fetchedAt,
        storedAt,
        bars,
      };
      state.updatedAt = storedAt;
      pruneSeries(state.series, this.maxSeries);
      await this.store.set(this.key, state);
      return {
        schemaVersion: SCHEMA_VERSION,
        descriptor: structuredClone(descriptor),
        fetchedAt: state.series[key].fetchedAt,
        storedAt,
        barCount: bars.length,
        bars: structuredClone(bars),
      };
    };
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.catch(() => {});
    return next;
  }
}

export function marketSeriesKey(input = {}) {
  return seriesKey(normalizeDescriptor(input));
}

export const MARKET_SERIES_SCHEMA_VERSION = SCHEMA_VERSION;
export const MARKET_SERIES_STORE_KEY = STORE_KEY;
export const MARKET_SERIES_PERIODS = Object.freeze([...SUPPORTED_PERIODS]);

function normalizeState(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || !plainObject(value.series)) {
    return { schemaVersion: SCHEMA_VERSION, updatedAt: null, series: {} };
  }
  const series = {};
  for (const [key, entry] of Object.entries(value.series).slice(0, DEFAULT_MAX_SERIES * 4)) {
    try {
      const descriptor = normalizeDescriptor(entry?.descriptor);
      if (key !== seriesKey(descriptor)) continue;
      const bars = normalizeBars(entry?.bars, descriptor).slice(-DEFAULT_MAX_BARS);
      if (!bars.length) continue;
      series[key] = {
        descriptor,
        fetchedAt: validIso(entry.fetchedAt),
        storedAt: validIso(entry.storedAt),
        bars,
      };
    } catch {
      // One malformed cached series must not poison the remaining evidence.
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: validIso(value.updatedAt),
    series,
  };
}

function normalizeDescriptor(input = {}) {
  const endpoint = normalizeEndpoint(input.endpoint);
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  const period = String(input.period ?? "day").trim().toLowerCase();
  const adjustment = String(input.adjustment ?? "forward").trim().toLowerCase();
  const tradeSessions = String(input.tradeSessions ?? "intraday").trim().toLowerCase();
  if (!endpoint || !symbol || symbol.length > 40 || !/^[A-Z0-9._-]+$/.test(symbol)) {
    throw new Error("Market series descriptor is invalid.");
  }
  if (!SUPPORTED_PERIODS.has(period)) throw new Error(`Unsupported market period: ${period}.`);
  if (!SUPPORTED_ADJUSTMENTS.has(adjustment)) {
    throw new Error(`Unsupported market adjustment: ${adjustment}.`);
  }
  if (!SUPPORTED_SESSIONS.has(tradeSessions)) {
    throw new Error(`Unsupported market trade session: ${tradeSessions}.`);
  }
  return { endpoint, symbol, period, adjustment, tradeSessions };
}

function normalizeBars(input, descriptor) {
  if (!Array.isArray(input)) return [];
  return input.map((bar) => normalizeBar(bar, descriptor)).filter(Boolean).sort(compareBars);
}

function normalizeBar(value, descriptor) {
  if (!plainObject(value)) return null;
  const timestamp = validIso(value.timestamp ?? value.time);
  const tradeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(value.tradeDate ?? ""))
    ? String(value.tradeDate)
    : timestamp?.slice(0, 10) ?? null;
  const open = finiteNumber(value.open);
  const high = finiteNumber(value.high);
  const low = finiteNumber(value.low);
  const close = finiteNumber(value.close);
  const volume = finiteNumber(value.volume);
  if (!timestamp || !tradeDate || [open, high, low, close, volume].some((item) => item == null)) {
    return null;
  }
  if ([open, high, low, close].some((item) => item <= 0) || volume < 0) return null;
  if (high < low || open < low || open > high || close < low || close > high) return null;
  const tradeSession = cleanText(value.tradeSession ?? value.trade_session, 40) ?? "Intraday";
  const identity = INTRADAY_PERIODS.has(descriptor.period)
    ? `${timestamp}|${tradeSession.toLowerCase()}`
    : tradeDate;
  return {
    identity,
    timestamp,
    tradeDate,
    timestampBasis: cleanText(value.timestampBasis, 80),
    symbol: cleanText(value.symbol, 40)?.toUpperCase() ?? descriptor.symbol,
    market: cleanText(value.market, 12)?.toUpperCase() ?? null,
    open,
    high,
    low,
    close,
    volume,
    tradeSession,
    ...(typeof value.isClosed === "boolean" ? { isClosed: value.isClosed } : {}),
    ...(cleanText(value.barStatus, 40) ? { barStatus: cleanText(value.barStatus, 40) } : {}),
  };
}

function mergeBars(existing, incoming, descriptor) {
  const merged = new Map();
  for (const bar of [
    ...normalizeBars(existing, descriptor),
    ...normalizeBars(incoming, descriptor),
  ]) merged.set(bar.identity, bar);
  return [...merged.values()].sort(compareBars);
}

function compareBars(left, right) {
  return Date.parse(left.timestamp) - Date.parse(right.timestamp)
    || left.identity.localeCompare(right.identity);
}

function seriesKey(descriptor) {
  return [
    descriptor.endpoint,
    descriptor.symbol,
    descriptor.period,
    descriptor.adjustment,
    descriptor.tradeSessions,
    `schema-${SCHEMA_VERSION}`,
  ].join("|");
}

function normalizeEndpoint(value) {
  const endpoint = String(value ?? "").trim();
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") return "";
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

function pruneSeries(series, maxSeries) {
  const entries = Object.entries(series);
  if (entries.length <= maxSeries) return;
  entries
    .sort(([, left], [, right]) => Date.parse(right.storedAt ?? 0) - Date.parse(left.storedAt ?? 0))
    .slice(maxSeries)
    .forEach(([key]) => delete series[key]);
}

function positiveInteger(value, fallback) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNumber(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validIso(value) {
  if (!value || !Number.isFinite(Date.parse(String(value)))) return null;
  return new Date(Date.parse(String(value))).toISOString();
}

function cleanText(value, limit) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, limit) : null;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
