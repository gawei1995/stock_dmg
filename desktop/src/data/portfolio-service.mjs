import {
  buildFxGraph,
  findHkdPerUsd,
  inferInstrumentType,
  normalizePortfolio,
  normalizeCandles,
} from "./normalize.mjs";
import { EcbReferenceFxProvider } from "./reference-fx.mjs";

const QUOTE_BATCH_SIZE = 500;
const DEFAULT_CANDLE_COUNT = 260;
const CANDLE_CACHE_TTL_MS = 2 * 60 * 1000;
export const PORTFOLIO_SNAPSHOT_SCHEMA_VERSION = 2;

export class PortfolioService {
  constructor({
    longbridge,
    store,
    onStatus = () => {},
    referenceFxProvider = null,
    baseCurrency = "USD",
  }) {
    this.longbridge = longbridge;
    this.store = store;
    this.onStatus = onStatus;
    this.referenceFxProvider = referenceFxProvider ?? new EcbReferenceFxProvider({ store });
    this.baseCurrency = String(baseCurrency || "USD").toUpperCase();
    this.refreshing = null;
    this.candleCache = new Map();
  }

  async cachedPortfolio() {
    const cached = await this.store.get("portfolioSnapshot");
    return cached?.endpoint === this.longbridge.endpoint
      && cached?.valuationSchemaVersion === PORTFOLIO_SNAPSHOT_SCHEMA_VERSION
      ? { ...cached, status: "cached" }
      : null;
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.#refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async #refresh() {
    this.onStatus({
      state: "syncing",
      phase: "positions",
      message: "正在读取长桥真实持仓（请求会自动超时）",
    });
    const positionsPromise = this.longbridge.call("stock_positions", {});
    // Ask Longbridge for the account headline directly in the cockpit base
    // currency.  Calling without a currency returns the broker's display
    // currency (often HKD); converting that aggregate again is both needless
    // and vulnerable to provider-specific FX direction conventions.
    const balancesPromise = this.longbridge.call("account_balance", {
      currency: this.baseCurrency,
    });
    const fxPromise = fetchExchangeRates(this.longbridge, this.referenceFxProvider);
    // These requests intentionally overlap the position call. Attach rejection
    // observers immediately so a fatal position failure cannot leave a sibling
    // request as an unhandled rejection after refresh() has already returned.
    void balancesPromise.catch(() => {});
    void fxPromise.catch(() => {});
    const positions = await positionsPromise;
    const { equitySymbols, optionSymbols } = flattenSymbolsByType(positions);
    this.onStatus({
      state: "syncing",
      phase: "market_data",
      message: "正在读取账户、汇率与持仓行情（请求会自动超时）",
    });
    const [balancePayload, fxResult, equityQuotes, optionQuotes] = await Promise.all([
      balancesPromise,
      fxPromise,
      fetchQuotes(this.longbridge, "quote", equitySymbols),
      fetchQuotes(this.longbridge, "option_quote", optionSymbols),
    ]);
    const balances = selectRequestedCurrencyBalances(balancePayload, this.baseCurrency);

    const portfolio = normalizePortfolio({
      positions,
      balances,
      quotes: [...equityQuotes.quotes, ...optionQuotes.quotes],
      exchangeRates: fxResult.data,
      baseCurrency: this.baseCurrency,
      quoteErrors: [...equityQuotes.errors, ...optionQuotes.errors],
      sourceErrors: fxResult.errors,
      sourceWarnings: fxResult.warnings,
      fxStatus: fxResult.status,
      fxMetadata: fxResult.metadata,
    });
    portfolio.valuationSchemaVersion = PORTFOLIO_SNAPSHOT_SCHEMA_VERSION;
    portfolio.endpoint = this.longbridge.endpoint;
    await this.store.set("portfolioSnapshot", portfolio);
    const degraded = !portfolio.dataQuality.valuationComplete;
    const fxUnavailable = portfolio.dataQuality.fxStatus === "unavailable";
    const usingReferenceFx = portfolio.dataQuality.fxStatus === "reference"
      || portfolio.dataQuality.fxStatus === "reference_cached";
    this.onStatus({
      state: degraded ? "degraded" : "ready",
      message: fxUnavailable
        ? `持仓和账户已实时更新 · 汇率不可用${formatSourceCode(fxResult.errors[0])} · 跨币种组合风险已暂停`
        : usingReferenceFx
        ? `真实持仓已同步 · 按 ${this.baseCurrency} 估值 · ECB ${fxResult.metadata.asOf ?? "最新"} 参考汇率${portfolio.dataQuality.fxStatus === "reference_cached" ? "（缓存）" : ""}`
        : degraded
        ? `真实持仓已同步 · ${portfolio.positions.length} 项 · ${portfolio.totals.unpricedPositionCount} 项待估值`
        : `真实持仓已同步 · ${portfolio.positions.length} 项 · 按 ${this.baseCurrency} 估值`,
      syncedAt: portfolio.syncedAt,
    });
    return portfolio;
  }

  async candles(symbol, count = DEFAULT_CANDLE_COUNT, { signal } = {}) {
    const normalizedCount = Math.min(
      Math.max(Number(count) || DEFAULT_CANDLE_COUNT, 21),
      1000,
    );
    const cacheKey = `${String(symbol).toUpperCase()}:${normalizedCount}`;
    const cached = this.candleCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CANDLE_CACHE_TTL_MS) {
      return structuredClone(cached.candles);
    }
    const raw = await this.longbridge.call("candlesticks", {
      symbol,
      period: "day",
      count: normalizedCount,
      forward_adjust: true,
      trade_sessions: "intraday",
    }, { signal });
    const candles = normalizeCandles(raw);
    this.candleCache.set(cacheKey, { fetchedAt: Date.now(), candles });
    return structuredClone(candles);
  }
}

async function fetchExchangeRates(longbridge, referenceFxProvider) {
  try {
    const raw = await longbridge.call("exchange_rate", {});
    return {
      data: canonicalizeLongbridgeExchangeRates(raw),
      status: "live",
      errors: [],
      warnings: [],
      metadata: {
        provider: "Longbridge",
        providerCode: "Longbridge",
        usage: "broker_account_fx",
      },
    };
  } catch (error) {
    if (isFatalSourceError(error)) throw error;
    const longbridgeWarning = sourceError("exchange_rate", error);
    try {
      const reference = await referenceFxProvider.latest();
      const warnings = [longbridgeWarning];
      if (reference.cacheWarning) {
        warnings.push(sourceError("ecb_reference_rates", reference.cacheWarning));
      }
      return {
        data: canonicalizeReferenceExchangeRates(reference.exchanges),
        status: reference.status,
        errors: [],
        warnings,
        metadata: {
          provider: reference.provider,
          providerCode: reference.providerCode,
          asOf: reference.asOf,
          fetchedAt: reference.fetchedAt,
          sourceUrl: reference.sourceUrl,
          usage: reference.usage,
        },
      };
    } catch (referenceError) {
      return {
        data: [],
        status: "unavailable",
        errors: [
          longbridgeWarning,
          sourceError("ecb_reference_rates", referenceError),
        ],
        warnings: [],
        metadata: {},
      };
    }
  }
}

/**
 * The Longbridge MCP currently emits `average_rate` as units of
 * `base_currency` per one unit of `other_currency` (for example USD/HKD is
 * 0.12754).  The public REST example has historically shown the reciprocal
 * convention, so an unambiguous USD/HKD anchor is used to detect that change
 * instead of silently multiplying in the wrong direction.
 *
 * Every returned row uses the cockpit's single canonical contract:
 * `rate = to_currency units per one from_currency unit`.
 */
export function canonicalizeLongbridgeExchangeRates(payload) {
  const rows = exchangeRows(payload);
  if (!rows.length) throw new Error("Longbridge returned an empty FX table.");
  const kinds = new Set(rows.map(longbridgeFxRowKind));
  if (kinds.has("invalid") || kinds.size !== 1) {
    throw new Error("Longbridge returned mixed or invalid FX row conventions.");
  }

  let exchanges;
  if (kinds.has("canonical")) {
    exchanges = rows.map((item) => ({
      from_currency: currencyCode(item.from_currency),
      to_currency: currencyCode(item.to_currency),
      rate: positiveRate(item.rate),
    }));
  } else {
    const crossCurrencyRows = rows.filter(
      (item) => currencyCode(item.base_currency) !== currencyCode(item.other_currency),
    );
    const convention = crossCurrencyRows.length
      ? inferLongbridgeRateConvention(rows)
      : null;
    exchanges = rows.map((item) => {
      const base = currencyCode(item.base_currency);
      const other = currencyCode(item.other_currency);
      const rate = positiveRate(item.average_rate ?? item.rate ?? item.bid_rate);
      if (base === other) {
        if (Math.abs(rate - 1) > 1e-12) {
          throw new Error("Longbridge same-currency FX rate is not 1.");
        }
        return { from_currency: base, to_currency: other, rate: 1 };
      }
      return convention === "other_to_base"
        ? { from_currency: other, to_currency: base, rate }
        : { from_currency: base, to_currency: other, rate };
    });
  }
  validateCanonicalFx(exchanges, "Longbridge");
  return { exchanges };
}

/** ECB publishes quote-currency units per EUR, already the canonical direction. */
export function canonicalizeReferenceExchangeRates(payload) {
  const rows = exchangeRows(payload);
  if (!rows.length) throw new Error("Reference FX returned an empty table.");
  const exchanges = rows.flatMap((item) => {
    const from = currencyCode(item.base_currency ?? item.from_currency);
    const to = currencyCode(item.other_currency ?? item.to_currency);
    const rate = positiveRate(item.average_rate ?? item.rate ?? item.bid_rate);
    return from && to && rate != null
      ? [{ from_currency: from, to_currency: to, rate }]
      : [];
  });
  if (!exchanges.length) throw new Error("Reference FX returned no valid rates.");
  validateCanonicalFx(exchanges, "reference FX");
  return { exchanges };
}

function selectRequestedCurrencyBalances(payload, requestedCurrency) {
  const balances = Array.isArray(payload)
    ? payload
    : payload?.balances ?? payload?.list ?? [];
  if (!Array.isArray(balances) || !balances.length) {
    throw new Error("Longbridge account_balance returned no account records.");
  }
  const requested = currencyCode(requestedCurrency);
  const matching = balances.filter(
    (item) => currencyCode(item?.currency) === requested,
  );
  if (!matching.length) {
    throw new Error(
      `Longbridge account_balance did not return the requested ${requested} valuation.`,
    );
  }
  if (matching.length !== 1) {
    throw new Error(
      `Longbridge account_balance returned duplicate ${requested} account totals.`,
    );
  }
  // Some upstream shapes may include the same account expressed in several
  // currencies.  Only the explicitly requested denomination is authoritative;
  // summing alternative display currencies would double-count the account.
  return matching;
}

function inferLongbridgeRateConvention(rows) {
  const anchor = rows.find((item) => {
    const pair = new Set([
      currencyCode(item?.base_currency),
      currencyCode(item?.other_currency),
    ]);
    return pair.has("USD") && pair.has("HKD");
  });
  if (!anchor) {
    throw new Error("Longbridge FX direction cannot be proven without a USD/HKD anchor.");
  }
  const base = currencyCode(anchor.base_currency);
  const other = currencyCode(anchor.other_currency);
  const rate = positiveRate(anchor.average_rate ?? anchor.rate ?? anchor.bid_rate);
  if (rate == null) throw new Error("Longbridge USD/HKD anchor rate is invalid.");

  const hkdPerUsdIfOtherToBase = base === "HKD" && other === "USD"
    ? rate
    : base === "USD" && other === "HKD"
      ? 1 / rate
      : NaN;
  const hkdPerUsdIfBaseToOther = base === "USD" && other === "HKD"
    ? rate
    : base === "HKD" && other === "USD"
      ? 1 / rate
      : NaN;
  const otherToBasePlausible = plausibleHkdPerUsd(hkdPerUsdIfOtherToBase);
  const baseToOtherPlausible = plausibleHkdPerUsd(hkdPerUsdIfBaseToOther);
  if (otherToBasePlausible === baseToOtherPlausible) {
    throw new Error("Longbridge USD/HKD rate direction is ambiguous or implausible.");
  }
  return otherToBasePlausible ? "other_to_base" : "base_to_other";
}

function longbridgeFxRowKind(item) {
  if (!item || typeof item !== "object") return "invalid";
  const hasCanonicalKeys = item.from_currency != null
    || item.to_currency != null;
  const hasNativeKeys = item.base_currency != null
    || item.other_currency != null
    || item.average_rate != null
    || item.bid_rate != null
    || item.offer_rate != null;
  if (hasCanonicalKeys && hasNativeKeys) return "invalid";
  if (hasCanonicalKeys) {
    return currencyCode(item.from_currency)
      && currencyCode(item.to_currency)
      && positiveRate(item.rate) != null
      ? "canonical"
      : "invalid";
  }
  if (hasNativeKeys) {
    return currencyCode(item.base_currency)
      && currencyCode(item.other_currency)
      && positiveRate(item.average_rate ?? item.rate ?? item.bid_rate) != null
      ? "native"
      : "invalid";
  }
  return "invalid";
}

function validateCanonicalFx(exchanges, source) {
  const graph = buildFxGraph({ exchanges });
  const hkdPerUsd = findHkdPerUsd(graph);
  if (Number.isFinite(hkdPerUsd) && !plausibleHkdPerUsd(hkdPerUsd)) {
    throw new Error(`${source} USD/HKD rate failed the direction sanity check.`);
  }
}

function exchangeRows(payload) {
  const rows = payload?.exchanges ?? payload?.list ?? payload ?? [];
  return Array.isArray(rows) ? rows : [];
}

function currencyCode(value) {
  const code = String(value ?? "").toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function positiveRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function plausibleHkdPerUsd(value) {
  return Number.isFinite(value) && value >= 6 && value <= 9;
}

async function fetchQuotes(longbridge, tool, symbols) {
  if (!symbols.length) return { quotes: [], errors: [] };
  const batches = chunk(symbols, QUOTE_BATCH_SIZE);
  const settled = await Promise.all(
    batches.map(async (batch) => {
      try {
        const payload = await longbridge.call(tool, { symbols: batch });
        return { quotes: flattenQuotes(payload), errors: [] };
      } catch (error) {
        if (isFatalSourceError(error)) throw error;
        const message = error instanceof Error ? error.message : "未知报价错误";
        return {
          quotes: [],
          errors: batch.map((symbol) => `${symbol}: ${message}`),
        };
      }
    }),
  );
  return {
    quotes: settled.flatMap((item) => item.quotes),
    errors: settled.flatMap((item) => item.errors),
  };
}

function flattenQuotes(payload) {
  const list = Array.isArray(payload)
    ? payload
    : payload?.list ?? payload?.quotes ?? payload?.option_quotes ?? [];
  return Array.isArray(list) ? list : [];
}

function flattenSymbolsByType(payload) {
  const list = payload?.list ?? payload ?? [];
  if (!Array.isArray(list)) {
    throw new Error("Longbridge stock_positions returned an invalid shape.");
  }
  const symbols = [...new Set(
    list
      .flatMap((item) => item?.stock_info ?? item?.positions ?? [])
      .map((item) => item?.symbol)
      .filter(Boolean),
  )];
  return {
    equitySymbols: symbols.filter((symbol) => inferInstrumentType(symbol) === "equity"),
    optionSymbols: symbols.filter((symbol) => inferInstrumentType(symbol) === "option"),
  };
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function sourceError(tool, error) {
  const message = error instanceof Error ? error.message : String(error ?? "未知错误");
  const code = Number.isFinite(Number(error?.code))
    ? Number(error.code)
    : Number(message.match(/\b(\d{3})\b/)?.[1]) || null;
  return {
    tool,
    code,
    kind: String(error?.kind ?? (code === 463 ? "gateway" : "tool")),
    message: message.slice(0, 300),
  };
}

function formatSourceCode(error) {
  return error?.code ? `(${error.code})` : "";
}

function isFatalSourceError(error) {
  return error?.kind === "auth" || error?.kind === "transport";
}
