const CACHE_KEY = "marketHistoryCacheV1";
const SCHEMA_VERSION = 1;
const DEFAULT_MAX_SERIES = 96;
const DEFAULT_MAX_BARS = 1000;

/**
 * Encrypted, bounded persistence for normalized daily candles.
 *
 * The caller supplies the same EncryptedStore used by the desktop app, so no
 * market or account data is ever written as plaintext. Series identity keeps
 * endpoint, adjustment and session semantics separate to prevent a cached
 * chart from silently changing the evidence contract used by a review.
 */
export class MarketHistoryStore {
  constructor({
    store,
    endpoint,
    key = CACHE_KEY,
    maxSeries = DEFAULT_MAX_SERIES,
    maxBars = DEFAULT_MAX_BARS,
    now = () => new Date().toISOString(),
  }) {
    if (!store?.get || !store?.set) {
      throw new Error("MarketHistoryStore requires an encrypted key-value store.");
    }
    this.store = store;
    this.endpoint = normalizeEndpoint(endpoint);
    this.key = key;
    this.maxSeries = positiveInteger(maxSeries, DEFAULT_MAX_SERIES);
    this.maxBars = positiveInteger(maxBars, DEFAULT_MAX_BARS);
    this.now = now;
    this.mutationQueue = Promise.resolve();
  }

  async getSeries(input = {}) {
    const descriptor = normalizeDescriptor({ ...input, endpoint: input.endpoint ?? this.endpoint });
    const state = normalizeState(await this.store.get(this.key));
    const entry = state.series[seriesKey(descriptor)];
    if (!entry || !Array.isArray(entry.candles) || !entry.candles.length) return null;
    const count = positiveInteger(input.count, this.maxBars);
    return {
      descriptor: structuredClone(entry.descriptor),
      fetchedAt: entry.fetchedAt,
      storedAt: entry.storedAt,
      candleCount: entry.candles.length,
      candles: structuredClone(entry.candles.slice(-Math.min(count, this.maxBars))),
    };
  }

  async putSeries(input = {}) {
    const descriptor = normalizeDescriptor({ ...input, endpoint: input.endpoint ?? this.endpoint });
    const incoming = normalizeStoredCandles(input.candles);
    if (!incoming.length) return null;
    const fetchedAt = validIso(input.fetchedAt) ?? this.now();
    const operation = async () => {
      const state = normalizeState(await this.store.get(this.key));
      const key = seriesKey(descriptor);
      const previous = state.series[key];
      const previousFetchedAtMs = Date.parse(previous?.fetchedAt ?? "");
      const incomingFetchedAtMs = Date.parse(fetchedAt);
      const incomingIsOlder = Number.isFinite(previousFetchedAtMs)
        && Number.isFinite(incomingFetchedAtMs)
        && incomingFetchedAtMs < previousFetchedAtMs;
      // A slow, older request may finish after a newer one. It may contribute
      // missing historical dates, but it must never replace an overlapping
      // daily bar or move the series freshness backwards.
      const candles = (incomingIsOlder
        ? mergeCandles(incoming, previous?.candles)
        : mergeCandles(previous?.candles, incoming))
        .slice(-this.maxBars);
      const storedAt = this.now();
      state.series[key] = {
        descriptor,
        fetchedAt: incomingIsOlder ? previous.fetchedAt : fetchedAt,
        storedAt,
        candles,
      };
      state.schemaVersion = SCHEMA_VERSION;
      state.updatedAt = storedAt;
      pruneSeries(state.series, this.maxSeries);
      await this.store.set(this.key, state);
      return {
        descriptor: structuredClone(descriptor),
        fetchedAt: state.series[key].fetchedAt,
        storedAt,
        candleCount: candles.length,
        candles: structuredClone(candles),
      };
    };
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.catch(() => {});
    return next;
  }
}

export function marketHistorySeriesKey(input = {}) {
  return seriesKey(normalizeDescriptor(input));
}

function normalizeState(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || !value.series || typeof value.series !== "object") {
    return { schemaVersion: SCHEMA_VERSION, updatedAt: null, series: {} };
  }
  const series = {};
  for (const [key, entry] of Object.entries(value.series).slice(0, DEFAULT_MAX_SERIES * 4)) {
    if (!entry?.descriptor || !Array.isArray(entry.candles)) continue;
    try {
      const descriptor = normalizeDescriptor(entry.descriptor);
      if (key !== seriesKey(descriptor)) continue;
      const candles = mergeCandles([], entry.candles).slice(-DEFAULT_MAX_BARS);
      if (!candles.length) continue;
      series[key] = {
        descriptor,
        fetchedAt: validIso(entry.fetchedAt),
        storedAt: validIso(entry.storedAt),
        candles,
      };
    } catch {
      // Fail closed for malformed cache entries while keeping healthy series.
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: validIso(value.updatedAt),
    series,
  };
}

function normalizeDescriptor(input) {
  const endpoint = normalizeEndpoint(input.endpoint);
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  if (!endpoint || !symbol || symbol.length > 40 || !/^[A-Z0-9._-]+$/.test(symbol)) {
    throw new Error("Market history descriptor is invalid.");
  }
  const period = String(input.period ?? "day").trim().toLowerCase();
  const adjustment = String(input.adjustment ?? "forward").trim().toLowerCase();
  const tradeSessions = String(input.tradeSessions ?? "intraday").trim().toLowerCase();
  return { endpoint, symbol, period, adjustment, tradeSessions };
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
  if (!endpoint || endpoint.length > 300) return "";
  try {
    const url = new URL(endpoint);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

function normalizeStoredCandles(candles) {
  if (!Array.isArray(candles)) return [];
  return candles
    .map((bar) => {
      const timestamp = validIso(bar?.timestamp);
      const tradeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(bar?.tradeDate ?? ""))
        ? String(bar.tradeDate)
        : null;
      const open = finiteNumber(bar?.open);
      const high = finiteNumber(bar?.high);
      const low = finiteNumber(bar?.low);
      const close = finiteNumber(bar?.close);
      const volume = finiteNumber(bar?.volume);
      if (!timestamp || !tradeDate || [open, high, low, close, volume]
        .some((value) => value == null)) return null;
      return {
        timestamp,
        tradeDate,
        timestampBasis: cleanText(bar?.timestampBasis, 80),
        symbol: cleanText(bar?.symbol, 40)?.toUpperCase() ?? null,
        market: cleanText(bar?.market, 12)?.toUpperCase() ?? null,
        open,
        high,
        low,
        close,
        volume,
        tradeSession: cleanText(bar?.tradeSession, 40) ?? "Intraday",
        ...(typeof bar?.isClosed === "boolean" ? { isClosed: bar.isClosed } : {}),
        ...(cleanText(bar?.barStatus, 40) ? { barStatus: cleanText(bar.barStatus, 40) } : {}),
      };
    })
    .filter(Boolean)
    .sort(compareCandles);
}

function mergeCandles(existing, incoming) {
  const merged = new Map();
  for (const bar of [
    ...normalizeStoredCandles(existing),
    ...normalizeStoredCandles(incoming),
  ]) {
    // The store is intentionally for daily candles. Longbridge can revise the
    // timestamp representation of the same exchange trading day; tradeDate is
    // therefore the stable evidence identity.
    merged.set(bar.tradeDate, bar);
  }
  return [...merged.values()].sort(compareCandles);
}

function compareCandles(left, right) {
  return String(left.tradeDate).localeCompare(String(right.tradeDate))
    || Date.parse(left.timestamp) - Date.parse(right.timestamp);
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
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validIso(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString();
}

function cleanText(value, limit) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, limit) : null;
}
