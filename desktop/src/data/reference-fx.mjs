export const ECB_REFERENCE_FX_URL =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
export const ECB_REFERENCE_FX_CACHE_KEY = "ecbReferenceFxSnapshot";
export const DEFAULT_REFERENCE_FX_TIMEOUT_MS = 6_000;
export const DEFAULT_REFERENCE_FX_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

const MAX_XML_BYTES = 1_000_000;

/**
 * Fetches the ECB's latest euro reference rates and keeps a short-lived public-data cache.
 * ECB rates are informational reference rates, not executable broker FX quotes.
 */
export class EcbReferenceFxProvider {
  constructor({
    store,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    timeoutMs = DEFAULT_REFERENCE_FX_TIMEOUT_MS,
    cacheMaxAgeMs = DEFAULT_REFERENCE_FX_CACHE_MAX_AGE_MS,
    url = ECB_REFERENCE_FX_URL,
    readCache,
    writeCache,
  } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("ECB reference FX requires a fetch implementation.");
    }
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = positiveMilliseconds(timeoutMs, DEFAULT_REFERENCE_FX_TIMEOUT_MS);
    this.cacheMaxAgeMs = positiveMilliseconds(
      cacheMaxAgeMs,
      DEFAULT_REFERENCE_FX_CACHE_MAX_AGE_MS,
    );
    this.url = String(url || ECB_REFERENCE_FX_URL);
    this.readCache = readCache
      ?? (store?.get ? () => store.get(ECB_REFERENCE_FX_CACHE_KEY) : async () => null);
    this.writeCache = writeCache
      ?? (store?.set
        ? (value) => store.set(ECB_REFERENCE_FX_CACHE_KEY, value)
        : async () => {});
  }

  async latest() {
    try {
      const snapshot = await fetchEcbReferenceRates({
        fetchImpl: this.fetchImpl,
        now: this.now,
        timeoutMs: this.timeoutMs,
        url: this.url,
      });
      let cacheWarning = null;
      try {
        await this.writeCache(snapshot);
      } catch {
        cacheWarning = "ECB 参考汇率已获取，但本地缓存写入失败。";
      }
      return {
        ...snapshot,
        status: "reference",
        cacheWarning,
      };
    } catch (fetchError) {
      let cached = null;
      try {
        cached = await this.readCache();
      } catch {
        // A cache read problem must never hide the primary network error.
      }
      if (isUsableCachedSnapshot(cached, this.now(), this.cacheMaxAgeMs, this.url)) {
        return {
          ...cached,
          status: "reference_cached",
          cacheWarning: cleanError(fetchError),
        };
      }
      const error = new Error(`无法获取 ECB 最新参考汇率：${cleanError(fetchError)}`);
      error.kind = "reference";
      error.cause = fetchError;
      throw error;
    }
  }
}

export async function fetchEcbReferenceRates({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = DEFAULT_REFERENCE_FX_TIMEOUT_MS,
  url = ECB_REFERENCE_FX_URL,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("ECB reference FX requires a fetch implementation.");
  }
  const safeTimeoutMs = positiveMilliseconds(timeoutMs, DEFAULT_REFERENCE_FX_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`ECB reference FX timed out after ${safeTimeoutMs}ms.`));
  }, safeTimeoutMs);
  timeout.unref?.();

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/xml,text/xml;q=0.9,*/*;q=0.1",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response?.ok) {
      throw new Error(`ECB reference FX returned HTTP ${response?.status ?? "unknown"}.`);
    }
    const xml = await response.text();
    if (Buffer.byteLength(xml, "utf8") > MAX_XML_BYTES) {
      throw new Error("ECB reference FX response exceeded the size limit.");
    }
    const parsed = parseEcbReferenceRates(xml);
    return {
      ...parsed,
      provider: "European Central Bank",
      providerCode: "ECB",
      fetchedAt: new Date(now()).toISOString(),
      sourceUrl: String(url),
      usage: "reference_only",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function parseEcbReferenceRates(xml) {
  if (typeof xml !== "string" || !xml.trim()) {
    throw new Error("ECB reference FX returned an empty XML document.");
  }
  const asOfMatch = xml.match(/<Cube\b[^>]*\btime\s*=\s*(['"])(\d{4}-\d{2}-\d{2})\1[^>]*>/i);
  const asOf = asOfMatch?.[2] ?? null;
  if (!isIsoDate(asOf)) {
    throw new Error("ECB reference FX XML did not contain a valid observation date.");
  }

  const rates = new Map();
  const cubePattern = /<Cube\b([^>]*)\/?\s*>/gi;
  for (const match of xml.matchAll(cubePattern)) {
    const attributes = parseAttributes(match[1]);
    const currency = String(attributes.currency ?? "").toUpperCase();
    const rate = Number(attributes.rate);
    if (!/^[A-Z]{3}$/.test(currency) || !(rate > 0)) continue;
    rates.set(currency, String(attributes.rate));
  }
  if (!rates.has("USD")) {
    throw new Error("ECB reference FX XML did not contain a valid USD rate.");
  }

  return {
    asOf,
    exchanges: [...rates.entries()].map(([currency, rate]) => ({
      from_currency: "EUR",
      to_currency: currency,
      rate,
    })),
  };
}

function parseAttributes(value) {
  const attributes = {};
  const attributePattern = /([:\w-]+)\s*=\s*(['"])(.*?)\2/g;
  for (const match of String(value ?? "").matchAll(attributePattern)) {
    attributes[match[1]] = match[3];
  }
  return attributes;
}

function isUsableCachedSnapshot(value, now, maxAgeMs, expectedUrl) {
  if (!value || value.sourceUrl !== expectedUrl || value.providerCode !== "ECB") return false;
  if (!Array.isArray(value.exchanges) || !value.exchanges.length || !isIsoDate(value.asOf)) {
    return false;
  }
  const asOfTimestamp = Date.parse(`${value.asOf}T23:59:59.999Z`);
  const age = Number(now) - asOfTimestamp;
  return Number.isFinite(age) && age >= -24 * 60 * 60 * 1_000 && age <= maxAgeMs;
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function positiveMilliseconds(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function cleanError(error) {
  return String(error instanceof Error ? error.message : error ?? "未知错误").slice(0, 300);
}
