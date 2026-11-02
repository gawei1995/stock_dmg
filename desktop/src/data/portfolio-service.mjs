import {
  buildFxGraph,
  findHkdPerUsd,
  inferInstrumentType,
  normalizePortfolio,
  normalizeCandles,
} from "./normalize.mjs";
import { withPortfolioFreshness } from "./freshness.mjs";
import { EcbReferenceFxProvider } from "./reference-fx.mjs";
import { MarketHistoryStore } from "./market-history-store.mjs";
import { MarketSeriesStore } from "./market-series-store.mjs";
import { deriveLongbridgeAccountScopeIdentity } from "./account-scope-identity.mjs";
import { assessPortfolioValuationGate } from "./portfolio-valuation-gate.mjs";

const QUOTE_BATCH_SIZE = 500;
const DEFAULT_CANDLE_COUNT = 1000;
const CANDLE_CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_CANDLE_CACHE_ENTRIES = 100;
const DEFAULT_PERSISTENT_REVALIDATE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CANDLE_REFRESH_TIMEOUT_MS = 8_000;
const DEFAULT_MARKET_SERIES_COUNT = 240;
const MARKET_SERIES_CACHE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MARKET_SERIES_REVALIDATE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MARKET_SERIES_REFRESH_TIMEOUT_MS = 8_000;
const SUPPORTED_AGENT_SERIES_PERIODS = new Set(["1h", "week"]);
const CANDLE_DESCRIPTOR = Object.freeze({
  period: "day",
  adjustment: "forward",
  tradeSessions: "intraday",
});
export const PORTFOLIO_SNAPSHOT_SCHEMA_VERSION = 2;

export class PortfolioService {
  constructor({
    longbridge,
    store,
    onStatus = () => {},
    referenceFxProvider = null,
    marketHistoryStore = null,
    marketSeriesStore = null,
    baseCurrency = "USD",
    clock = () => Date.now(),
  }) {
    this.longbridge = longbridge;
    this.store = store;
    this.onStatus = onStatus;
    this.referenceFxProvider = referenceFxProvider ?? new EcbReferenceFxProvider({ store });
    this.baseCurrency = String(baseCurrency || "USD").toUpperCase();
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.marketHistoryStore = marketHistoryStore
      ?? (store?.get && store?.set
        ? new MarketHistoryStore({ store, endpoint: longbridge.endpoint })
        : disabledMarketHistoryStore());
    this.marketSeriesStore = marketSeriesStore
      ?? createDefaultMarketSeriesStore(store, longbridge?.endpoint);
    this.refreshing = null;
    this.candleCache = new Map();
    this.candleLoads = new Map();
    this.marketSeriesCache = new Map();
    this.marketSeriesLoads = new Map();
  }

  async cachedPortfolio() {
    const cached = await this.store.get("portfolioSnapshot");
    return cached?.endpoint === this.longbridge.endpoint
      && cached?.valuationSchemaVersion === PORTFOLIO_SNAPSHOT_SCHEMA_VERSION
      ? withPortfolioFreshness(
          { ...cached, status: "cached", holdingsStatus: "cached" },
          {
            now: this.#now().getTime(),
            forceState: "cached",
            reason: "本机加密缓存；尚未完成本轮长桥同步",
          },
        )
      : null;
  }

  async refresh({ commitGuard = null } = {}) {
    assertPortfolioCommitGuard(commitGuard);
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.#refresh({ commitGuard }).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async #refresh({ commitGuard = null } = {}) {
    this.#publishRefreshStatus({
      state: "syncing",
      phase: "positions",
      message: "正在读取长桥真实持仓（请求会自动超时）",
    }, commitGuard);
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
    this.#publishRefreshStatus({
      state: "syncing",
      phase: "market_data",
      message: "正在读取账户、汇率与持仓行情（请求会自动超时）",
    }, commitGuard);
    const [balancePayload, fxResult, equityQuotes, optionQuotes] = await Promise.all([
      balancesPromise,
      fxPromise,
      fetchQuotes(this.longbridge, "quote", equitySymbols),
      fetchQuotes(this.longbridge, "option_quote", optionSymbols),
    ]);
    const balances = selectRequestedCurrencyBalances(balancePayload, this.baseCurrency);

    let accountScopeIdentity;
    try {
      accountScopeIdentity = deriveLongbridgeAccountScopeIdentity({
        positionsPayload: positions,
        balancePayload,
        environment: "production",
      });
    } catch (error) {
      accountScopeIdentity = {
        status: "unverified",
        scopeId: null,
        broker: "longbridge",
        environment: "production",
        version: "account-scope-identity/v1",
        reason: "explicit_broker_account_identifier_unavailable",
        limitation: String(error?.message ?? error).slice(0, 300),
        provenance: {
          source: "longbridge_raw_portfolio_payload",
          rawIdentifiersPersisted: false,
          mutablePortfolioContentUsed: false,
        },
      };
    }

    const normalizedPortfolio = normalizePortfolio({
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
    const assessedAt = this.#now();
    normalizedPortfolio.syncedAt = assessedAt.toISOString();
    normalizedPortfolio.accountScopeIdentity = accountScopeIdentity;
    normalizedPortfolio.valuationGate = assessPortfolioValuationGate({
      portfolio: normalizedPortfolio,
      assessedAt,
    });
    if (normalizedPortfolio.valuationGate.outcome.status !== "pass"
        && normalizedPortfolio.status === "live") {
      normalizedPortfolio.status = "degraded";
    }
    const portfolio = withPortfolioFreshness(normalizedPortfolio, {
      now: assessedAt.getTime(),
      forceState: "fresh",
      reason: normalizedPortfolio.valuationGate.outcome.readyForSizing
        ? "本轮长桥持仓、账户、逐标的行情与估值校验已完成"
        : "本轮长桥同步已完成，但逐标的行情或估值校验未通过",
    });
    portfolio.valuationSchemaVersion = PORTFOLIO_SNAPSHOT_SCHEMA_VERSION;
    portfolio.endpoint = this.longbridge.endpoint;
    // The host advances its authorization generation before credentials are
    // cleared or replaced. Check at the exact persistence boundary so a late
    // broker response cannot repopulate the cache for the previous account.
    assertPortfolioCommitAllowed(commitGuard);
    await this.store.set("portfolioSnapshot", portfolio, { commitGuard });
    assertPortfolioCommitAllowed(commitGuard);
    const degraded = !portfolio.dataQuality.valuationComplete
      || !portfolio.valuationGate.outcome.readyForSizing;
    const fxUnavailable = portfolio.dataQuality.fxStatus === "unavailable";
    const usingReferenceFx = portfolio.dataQuality.fxStatus === "reference"
      || portfolio.dataQuality.fxStatus === "reference_cached";
    const valuationGateWarning = portfolio.valuationGate.outcome.readyForSizing
      ? ""
      : " · 逐标的行情或估值校验未通过，仓位建议暂停";
    this.#publishRefreshStatus({
      state: degraded ? "degraded" : "ready",
      message: fxUnavailable
        ? `持仓和账户已实时更新 · 汇率不可用${formatSourceCode(fxResult.errors[0])} · 跨币种组合风险已暂停`
        : usingReferenceFx
        ? `真实持仓已同步 · 按 ${this.baseCurrency} 估值 · ECB ${fxResult.metadata.asOf ?? "最新"} 参考汇率${portfolio.dataQuality.fxStatus === "reference_cached" ? "（缓存）" : ""}${valuationGateWarning}`
        : !portfolio.valuationGate.outcome.readyForSizing
        ? `真实持仓已同步 · 逐标的行情或估值校验未通过 · 仓位建议已暂停`
        : degraded
        ? `真实持仓已同步 · ${portfolio.positions.length} 项 · ${portfolio.totals.unpricedPositionCount} 项待估值`
        : `真实持仓已同步 · ${portfolio.positions.length} 项 · 按 ${this.baseCurrency} 估值`,
      syncedAt: portfolio.syncedAt,
    }, commitGuard);
    return portfolio;
  }

  #publishRefreshStatus(status, commitGuard) {
    if (portfolioCommitAllowed(commitGuard)) this.onStatus(status);
  }

  #now() {
    const value = this.clock();
    const instant = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(instant.getTime())) {
      throw new TypeError("PortfolioService clock returned an invalid time.");
    }
    return instant;
  }

  async candles(symbol, count = DEFAULT_CANDLE_COUNT, options = {}) {
    const result = await this.candlesWithCoverage(symbol, count, options);
    return result.candles;
  }

  async candlesWithCoverage(symbol, count = DEFAULT_CANDLE_COUNT, {
    signal,
    preferPersistent = false,
    allowPersistentFallback = true,
    persistentRevalidateMs = DEFAULT_PERSISTENT_REVALIDATE_MS,
    liveRefreshTimeoutMs = DEFAULT_CANDLE_REFRESH_TIMEOUT_MS,
    requireLive = false,
  } = {}) {
    const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
    if (!normalizedSymbol) throw new Error("Daily candle symbol is required.");
    const normalizedCount = Math.min(
      Math.max(Number(count) || DEFAULT_CANDLE_COUNT, 21),
      1000,
    );
    const cacheKey = `${normalizedSymbol}:${normalizedCount}`;
    const now = Date.now();
    this.#pruneCandleCache(now);
    const cached = this.candleCache.get(cacheKey);
    const cachedHasLiveLineage = cached?.coverage?.source === "live"
      || cached?.coverage?.originSource === "live";
    if (cached
        && now - (cached.cachedAt ?? cached.fetchedAt) < CANDLE_CACHE_TTL_MS
        && (!requireLive || cachedHasLiveLineage)) {
      return cloneCandleResult({
        candles: cached.candles,
        coverage: buildCandleCoverage({
          source: "memory",
          originSource: cached.coverage?.originSource ?? cached.coverage?.source ?? null,
          fetchedAt: cached.coverage?.fetchedAt ?? isoFromMs(cached.fetchedAt),
          requestedCount: normalizedCount,
          candles: cached.candles,
          endpoint: this.longbridge.endpoint,
          now,
          partialReasons: cached.coverage?.partialReasons,
          refreshAttempted: cached.coverage?.refreshAttempted,
          fallbackReason: cached.coverage?.fallbackReason,
          persistenceStatus: cached.coverage?.persistenceStatus,
        }),
      });
    }

    const persistent = await this.marketHistoryStore.getSeries({
      symbol: normalizedSymbol,
      count: normalizedCount,
      ...CANDLE_DESCRIPTOR,
    }).catch(() => null);
    const persistentAgeMs = cacheAgeMs(persistent?.fetchedAt, now);
    const revalidateAfterMs = nonNegativeNumber(
      persistentRevalidateMs,
      DEFAULT_PERSISTENT_REVALIDATE_MS,
    );
    const persistentIncomplete = Boolean(persistent?.candles?.length)
      && persistent.candles.length < normalizedCount;
    const persistentStale = Boolean(persistent?.candles?.length)
      && (!Number.isFinite(persistentAgeMs) || persistentAgeMs >= revalidateAfterMs);
    if (!requireLive
        && preferPersistent
        && persistent?.candles?.length
        && !persistentIncomplete
        && !persistentStale) {
      const coverage = buildCandleCoverage({
        source: "persistent",
        fetchedAt: persistent.fetchedAt,
        storedAt: persistent.storedAt,
        requestedCount: normalizedCount,
        candles: persistent.candles,
        endpoint: this.longbridge.endpoint,
        now,
      });
      this.#rememberCandles(cacheKey, persistent.candles, coverage);
      return cloneCandleResult({ candles: persistent.candles, coverage });
    }

    const refreshReasons = [
      ...(persistentIncomplete ? ["insufficient_history"] : []),
      ...(persistentStale ? ["stale_cache"] : []),
    ];
    const canAttemptLive = this.longbridge?.connected !== false;
    try {
      if (!canAttemptLive) throw candleRefreshUnavailableError("longbridge_disconnected");
      return await this.#fetchCandlesShared(normalizedSymbol, normalizedCount, cacheKey, {
        signal,
        timeoutMs: preferPersistent && persistent?.candles?.length
          ? liveRefreshTimeoutMs
          : null,
      });
    } catch (error) {
      if (signal?.aborted || !allowPersistentFallback || !persistent?.candles?.length) throw error;
      const fallbackReason = candleErrorSummary(error);
      const coverage = buildCandleCoverage({
        source: "persistent_fallback",
        originSource: "persistent",
        fetchedAt: persistent.fetchedAt,
        storedAt: persistent.storedAt,
        requestedCount: normalizedCount,
        candles: persistent.candles,
        endpoint: this.longbridge.endpoint,
        now,
        forcePartial: true,
        partialReasons: [...refreshReasons, "live_refresh_failed"],
        refreshAttempted: canAttemptLive,
        fallbackReason,
      });
      this.#rememberCandles(cacheKey, persistent.candles, coverage);
      return cloneCandleResult({ candles: persistent.candles, coverage });
    }
  }

  /**
   * Fetch and persist a non-daily OHLCV series without collapsing bars that
   * share an exchange trading date.  Completion is decided at this connector
   * boundary: a later bar proves its predecessor is final, while an unlabelled
   * terminal bar stays provisional.  The Agent never guesses bar finality.
   */
  async marketSeriesWithCoverage(symbol, period = "1h", count = DEFAULT_MARKET_SERIES_COUNT, {
    signal,
    preferPersistent = false,
    allowPersistentFallback = true,
    persistentRevalidateMs = DEFAULT_MARKET_SERIES_REVALIDATE_MS,
    liveRefreshTimeoutMs = DEFAULT_MARKET_SERIES_REFRESH_TIMEOUT_MS,
    requireLive = false,
    adjustment = "forward",
    tradeSessions = "intraday",
  } = {}) {
    const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
    const normalizedPeriod = String(period ?? "").trim().toLowerCase();
    const normalizedAdjustment = String(adjustment ?? "forward").trim().toLowerCase();
    const normalizedTradeSessions = String(tradeSessions ?? "intraday").trim().toLowerCase();
    if (!normalizedSymbol) throw new Error("Market series symbol is required.");
    if (!SUPPORTED_AGENT_SERIES_PERIODS.has(normalizedPeriod)) {
      throw new Error(`Unsupported Agent market period: ${normalizedPeriod || "unknown"}.`);
    }
    const normalizedCount = Math.min(
      Math.max(Math.trunc(Number(count) || DEFAULT_MARKET_SERIES_COUNT), 2),
      1000,
    );
    const descriptor = {
      symbol: normalizedSymbol,
      period: normalizedPeriod,
      adjustment: normalizedAdjustment,
      tradeSessions: normalizedTradeSessions,
    };
    const cacheKey = marketSeriesCacheKey(descriptor, normalizedCount);
    const now = Date.now();
    this.#pruneMarketSeriesCache(now);
    const cached = this.marketSeriesCache.get(cacheKey);
    const cachedHasLiveLineage = cached?.coverage?.source === "live"
      || cached?.coverage?.originSource === "live";
    if (cached
        && now - cached.cachedAt < MARKET_SERIES_CACHE_TTL_MS
        && (!requireLive || cachedHasLiveLineage)) {
      return marketSeriesResult({
        bars: cached.bars,
        coverage: {
          ...cached.coverage,
          source: "memory",
          originSource: cached.coverage?.originSource ?? cached.coverage?.source ?? null,
        },
        period: normalizedPeriod,
        now,
      });
    }

    const persistent = await this.marketSeriesStore.getSeries({
      ...descriptor,
      count: normalizedCount,
    }).catch(() => null);
    const persistentAgeMs = cacheAgeMs(persistent?.fetchedAt, now);
    const revalidateAfterMs = nonNegativeNumber(
      persistentRevalidateMs,
      DEFAULT_MARKET_SERIES_REVALIDATE_MS,
    );
    const persistentIncomplete = Boolean(persistent?.bars?.length)
      && persistent.bars.length < normalizedCount;
    const persistentStale = Boolean(persistent?.bars?.length)
      && (!Number.isFinite(persistentAgeMs) || persistentAgeMs >= revalidateAfterMs);
    if (!requireLive
        && preferPersistent
        && persistent?.bars?.length
        && !persistentIncomplete
        && !persistentStale) {
      const coverage = buildMarketSeriesCoverage({
        source: "persistent",
        fetchedAt: persistent.fetchedAt,
        storedAt: persistent.storedAt,
        requestedCount: normalizedCount,
        bars: persistent.bars,
        descriptor,
        endpoint: this.longbridge.endpoint,
        now,
      });
      this.#rememberMarketSeries(cacheKey, persistent.bars, coverage);
      return marketSeriesResult({ bars: persistent.bars, coverage, period: normalizedPeriod, now });
    }

    const canAttemptLive = this.longbridge?.connected !== false;
    try {
      if (!canAttemptLive) throw marketSeriesRefreshUnavailableError("longbridge_disconnected");
      return await this.#fetchMarketSeriesShared(descriptor, normalizedCount, cacheKey, {
        signal,
        timeoutMs: preferPersistent && persistent?.bars?.length
          ? liveRefreshTimeoutMs
          : null,
      });
    } catch (error) {
      if (signal?.aborted || !allowPersistentFallback || !persistent?.bars?.length) throw error;
      const coverage = buildMarketSeriesCoverage({
        source: "persistent_fallback",
        originSource: "persistent",
        fetchedAt: persistent.fetchedAt,
        storedAt: persistent.storedAt,
        requestedCount: normalizedCount,
        bars: persistent.bars,
        descriptor,
        endpoint: this.longbridge.endpoint,
        now,
        forcePartial: true,
        partialReasons: [
          ...(persistentIncomplete ? ["insufficient_history"] : []),
          ...(persistentStale ? ["stale_cache"] : []),
          "live_refresh_failed",
        ],
        refreshAttempted: canAttemptLive,
        fallbackReason: candleErrorSummary(error),
      });
      this.#rememberMarketSeries(cacheKey, persistent.bars, coverage);
      return marketSeriesResult({ bars: persistent.bars, coverage, period: normalizedPeriod, now });
    }
  }

  async prewarmCandles(symbols, {
    count = DEFAULT_CANDLE_COUNT,
    concurrency = 2,
    maxSymbols = 24,
    persistentRevalidateMs = DEFAULT_PERSISTENT_REVALIDATE_MS,
  } = {}) {
    const queue = [...new Set((Array.isArray(symbols) ? symbols : [])
      .map((symbol) => String(symbol ?? "").trim().toUpperCase())
      .filter(Boolean))].slice(0, Math.max(1, Number(maxSymbols) || 24));
    const results = [];
    const worker = async () => {
      while (queue.length) {
        const symbol = queue.shift();
        try {
          const { candles, coverage } = await this.candlesWithCoverage(symbol, count, {
            preferPersistent: true,
            persistentRevalidateMs,
          });
          results.push({ symbol, ok: true, candleCount: candles.length, coverage });
        } catch (error) {
          results.push({ symbol, ok: false, error: String(error?.message ?? error).slice(0, 240) });
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(queue.length, Math.max(1, Number(concurrency) || 2)) },
      () => worker(),
    ));
    return results;
  }

  async #fetchCandlesShared(symbol, count, cacheKey, { signal, timeoutMs } = {}) {
    // Do not share an abortable caller's fetch: one consumer must never cancel
    // another. Non-abortable reads with an identical evidence descriptor and
    // count safely reuse the same Longbridge request and encrypted write.
    if (signal) return this.#fetchCandles(symbol, count, cacheKey, { signal, timeoutMs });
    const descriptorKey = [
      this.longbridge.endpoint,
      symbol,
      CANDLE_DESCRIPTOR.period,
      CANDLE_DESCRIPTOR.adjustment,
      CANDLE_DESCRIPTOR.tradeSessions,
      count,
    ].join("|");
    const existing = this.candleLoads.get(descriptorKey);
    if (existing) return cloneCandleResult(await existing);
    const load = this.#fetchCandles(symbol, count, cacheKey, { timeoutMs })
      .finally(() => this.candleLoads.delete(descriptorKey));
    this.candleLoads.set(descriptorKey, load);
    return cloneCandleResult(await load);
  }

  async #fetchCandles(symbol, count, cacheKey, { signal, timeoutMs } = {}) {
    const requestedAt = Date.now();
    const raw = await callWithDeadline(
      (requestSignal) => this.longbridge.call("candlesticks", {
        symbol,
        period: CANDLE_DESCRIPTOR.period,
        count,
        forward_adjust: true,
        trade_sessions: CANDLE_DESCRIPTOR.tradeSessions,
      }, { signal: requestSignal }),
      { signal, timeoutMs },
    );
    const candles = deduplicateDailyCandles(normalizeCandles(
      validRawCandleRows(raw),
      { symbol },
    ));
    if (!candles.length) {
      throw candleRefreshUnavailableError("no_valid_daily_candles");
    }
    const requestedAtIso = new Date(requestedAt).toISOString();
    let persisted = null;
    let persistenceStatus = "stored";
    try {
      persisted = await this.marketHistoryStore.putSeries({
        symbol,
        ...CANDLE_DESCRIPTOR,
        fetchedAt: requestedAtIso,
        candles,
      });
      if (!persisted) persistenceStatus = "not_stored";
    } catch {
      persistenceStatus = "failed";
    }
    // If this was an older overlapping response, putSeries returns the newer
    // persisted truth. Prefer that truth over the stale raw response.
    const effectiveCandles = (persisted?.candles?.length ? persisted.candles : candles)
      .slice(-count);
    const effectiveFetchedAt = persisted?.fetchedAt ?? requestedAtIso;
    const coverage = buildCandleCoverage({
      source: "live",
      fetchedAt: effectiveFetchedAt,
      storedAt: persisted?.storedAt ?? null,
      requestedCount: count,
      candles: effectiveCandles,
      endpoint: this.longbridge.endpoint,
      now: Date.now(),
      refreshAttempted: true,
      persistenceStatus,
    });
    this.#rememberCandles(cacheKey, effectiveCandles, coverage);
    return cloneCandleResult({ candles: effectiveCandles, coverage });
  }

  async #fetchMarketSeriesShared(descriptor, count, cacheKey, { signal, timeoutMs } = {}) {
    if (signal) {
      return this.#fetchMarketSeries(descriptor, count, cacheKey, { signal, timeoutMs });
    }
    const loadKey = [
      this.longbridge.endpoint,
      descriptor.symbol,
      descriptor.period,
      descriptor.adjustment,
      descriptor.tradeSessions,
      count,
    ].join("|");
    const existing = this.marketSeriesLoads.get(loadKey);
    if (existing) return cloneMarketSeriesResult(await existing);
    const load = this.#fetchMarketSeries(descriptor, count, cacheKey, { timeoutMs })
      .finally(() => this.marketSeriesLoads.delete(loadKey));
    this.marketSeriesLoads.set(loadKey, load);
    return cloneMarketSeriesResult(await load);
  }

  async #fetchMarketSeries(descriptor, count, cacheKey, { signal, timeoutMs } = {}) {
    const requestedAt = Date.now();
    const raw = await callWithDeadline(
      (requestSignal) => this.longbridge.call("candlesticks", {
        symbol: descriptor.symbol,
        period: descriptor.period,
        count,
        forward_adjust: descriptor.adjustment === "forward",
        trade_sessions: descriptor.tradeSessions,
      }, { signal: requestSignal }),
      { signal, timeoutMs },
    );
    const bars = deduplicateMarketSeries(normalizeCandles(
      validRawCandleRows(raw),
      { symbol: descriptor.symbol },
    ), descriptor.period);
    if (!bars.length) {
      throw marketSeriesRefreshUnavailableError(`no_valid_${descriptor.period}_candles`);
    }
    const requestedAtIso = new Date(requestedAt).toISOString();
    let persisted = null;
    let persistenceStatus = "stored";
    try {
      persisted = await this.marketSeriesStore.putSeries({
        ...descriptor,
        fetchedAt: requestedAtIso,
        bars,
      });
      if (!persisted) persistenceStatus = "not_stored";
    } catch {
      persistenceStatus = "failed";
    }
    const effectiveBars = (persisted?.bars?.length ? persisted.bars : bars).slice(-count);
    const coverage = buildMarketSeriesCoverage({
      source: "live",
      fetchedAt: persisted?.fetchedAt ?? requestedAtIso,
      storedAt: persisted?.storedAt ?? null,
      requestedCount: count,
      bars: effectiveBars,
      descriptor,
      endpoint: this.longbridge.endpoint,
      now: Date.now(),
      refreshAttempted: true,
      persistenceStatus,
    });
    this.#rememberMarketSeries(cacheKey, effectiveBars, coverage);
    return marketSeriesResult({
      bars: effectiveBars,
      coverage,
      period: descriptor.period,
      now: Date.now(),
    });
  }

  #rememberCandles(cacheKey, candles, coverage) {
    const fetchedAt = Date.parse(coverage?.fetchedAt ?? "");
    const previous = this.candleCache.get(cacheKey);
    if (previous && Number.isFinite(previous.fetchedAt) && Number.isFinite(fetchedAt)
        && previous.fetchedAt > fetchedAt) {
      return;
    }
    this.candleCache.delete(cacheKey);
    this.candleCache.set(cacheKey, {
      cachedAt: Date.now(),
      fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : Date.now(),
      candles: structuredClone(candles),
      coverage: structuredClone(coverage ?? null),
    });
    while (this.candleCache.size > MAX_CANDLE_CACHE_ENTRIES) {
      const oldestKey = this.candleCache.keys().next().value;
      this.candleCache.delete(oldestKey);
    }
  }

  #pruneCandleCache(now) {
    for (const [key, entry] of this.candleCache) {
      if (!entry || now - (entry.cachedAt ?? entry.fetchedAt) >= CANDLE_CACHE_TTL_MS) {
        this.candleCache.delete(key);
      }
    }
  }

  #rememberMarketSeries(cacheKey, bars, coverage) {
    const nextFetchedAt = Date.parse(coverage?.fetchedAt ?? "");
    const previous = this.marketSeriesCache.get(cacheKey);
    const previousFetchedAt = Date.parse(previous?.coverage?.fetchedAt ?? "");
    if (Number.isFinite(previousFetchedAt)
        && Number.isFinite(nextFetchedAt)
        && previousFetchedAt > nextFetchedAt) return;
    this.marketSeriesCache.delete(cacheKey);
    this.marketSeriesCache.set(cacheKey, {
      cachedAt: Date.now(),
      bars: structuredClone(bars),
      coverage: structuredClone(coverage),
    });
    while (this.marketSeriesCache.size > MAX_CANDLE_CACHE_ENTRIES) {
      const oldestKey = this.marketSeriesCache.keys().next().value;
      this.marketSeriesCache.delete(oldestKey);
    }
  }

  #pruneMarketSeriesCache(now) {
    for (const [key, entry] of this.marketSeriesCache) {
      if (!entry || now - entry.cachedAt >= MARKET_SERIES_CACHE_TTL_MS) {
        this.marketSeriesCache.delete(key);
      }
    }
  }
}

function disabledMarketHistoryStore() {
  return {
    async getSeries() { return null; },
    async putSeries() { return null; },
  };
}

function disabledMarketSeriesStore() {
  return {
    async getSeries() { return null; },
    async putSeries() { return null; },
  };
}

function createDefaultMarketSeriesStore(store, endpoint) {
  if (!store?.get || !store?.set) return disabledMarketSeriesStore();
  try {
    return new MarketSeriesStore({ store, endpoint });
  } catch {
    return disabledMarketSeriesStore();
  }
}

function cloneCandleResult(result) {
  return {
    candles: structuredClone(result?.candles ?? []),
    coverage: structuredClone(result?.coverage ?? null),
  };
}

function cloneMarketSeriesResult(result) {
  return structuredClone(result ?? {
    bars: [],
    completedBars: [],
    completedBarsOnly: false,
    finality: null,
    coverage: null,
  });
}

function marketSeriesResult({ bars, coverage, period, now = Date.now() }) {
  const normalizedBars = Array.isArray(bars) ? bars : [];
  const finality = selectCompletedMarketSeriesBars(normalizedBars, period, now);
  return cloneMarketSeriesResult({
    bars: normalizedBars,
    completedBars: finality.bars,
    completedBarsOnly: finality.attested,
    finality: {
      method: finality.method,
      rawBarCount: normalizedBars.length,
      completedBarCount: finality.bars.length,
      excludedBarCount: normalizedBars.length - finality.bars.length,
      terminalBarStatus: finality.terminalBarStatus,
      evaluatedAt: new Date(now).toISOString(),
      limitation: "未带供应商完结标记的末根 K 线不会进入正式技术指标；历史前序 K 线由后继 K 线证明已经结束。",
    },
    coverage,
  });
}

/**
 * A successor bar is deterministic evidence that its predecessor has ended,
 * without assuming whether the provider timestamp marks the open or close.
 * The terminal bar is admitted only with an explicit provider finality flag.
 */
export function selectCompletedMarketSeriesBars(bars, period, now = Date.now()) {
  const normalizedPeriod = String(period ?? "").trim().toLowerCase();
  if (!SUPPORTED_AGENT_SERIES_PERIODS.has(normalizedPeriod)) {
    return {
      bars: [],
      attested: false,
      method: "unsupported_period",
      terminalBarStatus: "unknown",
      evaluatedAt: new Date(now).toISOString(),
    };
  }
  const ordered = deduplicateMarketSeries(bars, normalizedPeriod);
  const completed = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const bar = ordered[index];
    const explicit = explicitBarFinality(bar);
    const hasSuccessor = index < ordered.length - 1;
    if (explicit === false) continue;
    if (explicit === true || hasSuccessor) completed.push(bar);
  }
  const terminalExplicit = explicitBarFinality(ordered.at(-1));
  return {
    bars: completed,
    attested: completed.length > 0,
    method: "provider_explicit_finality_or_successor_bar_confirmation",
    terminalBarStatus: terminalExplicit === true
      ? "provider_confirmed_closed"
      : terminalExplicit === false
        ? "provider_marked_forming"
        : ordered.length
          ? "unconfirmed_terminal_excluded"
          : "missing",
    evaluatedAt: new Date(now).toISOString(),
  };
}

function explicitBarFinality(bar) {
  if (!bar || typeof bar !== "object") return null;
  if (bar.isClosed === true) return true;
  if (bar.isClosed === false) return false;
  const status = String(bar.barStatus ?? "").trim().toLowerCase();
  if (["closed", "complete", "completed", "final", "confirmed"].includes(status)) return true;
  if (["forming", "open", "partial", "updating", "realtime", "live"].includes(status)) return false;
  return null;
}

function marketSeriesCacheKey(descriptor, count) {
  return [
    descriptor.symbol,
    descriptor.period,
    descriptor.adjustment,
    descriptor.tradeSessions,
    count,
  ].join("|");
}

function deduplicateMarketSeries(bars, period) {
  const rows = new Map();
  const intraday = ["1m", "5m", "15m", "30m", "1h"].includes(String(period));
  for (const bar of Array.isArray(bars) ? bars : []) {
    const timestamp = validIso(bar?.timestamp);
    if (!timestamp) continue;
    const identity = intraday
      ? `${timestamp}|${String(bar?.tradeSession ?? "Intraday").toLowerCase()}`
      : String(bar?.tradeDate ?? timestamp.slice(0, 10));
    rows.set(identity, { ...bar, timestamp });
  }
  return [...rows.values()].sort((left, right) => (
    Date.parse(left.timestamp) - Date.parse(right.timestamp)
  ));
}

function buildMarketSeriesCoverage({
  source,
  originSource = null,
  fetchedAt = null,
  storedAt = null,
  requestedCount,
  bars,
  descriptor,
  endpoint,
  now = Date.now(),
  forcePartial = false,
  partialReasons = [],
  refreshAttempted = false,
  fallbackReason = null,
  persistenceStatus = null,
}) {
  const rows = Array.isArray(bars) ? bars : [];
  const requested = Math.max(0, Math.trunc(Number(requestedCount) || 0));
  const reasons = new Set((Array.isArray(partialReasons) ? partialReasons : []).filter(Boolean));
  if (rows.length < requested) reasons.add("insufficient_history");
  if (persistenceStatus === "failed") reasons.add("persistence_failed");
  if (persistenceStatus === "not_stored") reasons.add("persistence_unavailable");
  if (forcePartial && !reasons.size) reasons.add("degraded_fallback");
  const normalizedFetchedAt = validIso(fetchedAt);
  const partial = forcePartial || reasons.size > 0;
  return {
    source: String(source ?? "unknown"),
    originSource: originSource ? String(originSource) : null,
    coverageStatus: partial ? "partial" : "complete",
    complete: !partial,
    partial,
    partialReasons: [...reasons],
    fetchedAt: normalizedFetchedAt,
    storedAt: validIso(storedAt),
    cacheAgeMs: Number.isFinite(cacheAgeMs(normalizedFetchedAt, now))
      ? cacheAgeMs(normalizedFetchedAt, now)
      : null,
    requestedCount: requested,
    returnedCount: rows.length,
    endpoint: String(endpoint ?? "") || null,
    period: descriptor.period,
    adjustment: descriptor.adjustment,
    tradeSessions: descriptor.tradeSessions,
    refreshAttempted: Boolean(refreshAttempted),
    fallbackReason: fallbackReason ? structuredClone(fallbackReason) : null,
    persistenceStatus: persistenceStatus ? String(persistenceStatus) : null,
  };
}

function buildCandleCoverage({
  source,
  originSource = null,
  fetchedAt = null,
  storedAt = null,
  requestedCount,
  candles,
  endpoint,
  now = Date.now(),
  forcePartial = false,
  partialReasons = [],
  refreshAttempted = false,
  fallbackReason = null,
  persistenceStatus = null,
}) {
  const rows = Array.isArray(candles) ? candles : [];
  const requested = Math.max(0, Math.trunc(Number(requestedCount) || 0));
  const reasons = new Set((Array.isArray(partialReasons) ? partialReasons : []).filter(Boolean));
  if (rows.length < requested) reasons.add("insufficient_history");
  if (persistenceStatus === "failed") reasons.add("persistence_failed");
  if (persistenceStatus === "not_stored") reasons.add("persistence_unavailable");
  if (forcePartial && !reasons.size) reasons.add("degraded_fallback");
  const normalizedFetchedAt = validIso(fetchedAt);
  const ageMs = cacheAgeMs(normalizedFetchedAt, now);
  const partial = forcePartial || reasons.size > 0;
  return {
    source: String(source ?? "unknown"),
    originSource: originSource ? String(originSource) : null,
    coverageStatus: partial ? "partial" : "complete",
    complete: !partial,
    partial,
    partialReasons: [...reasons],
    fetchedAt: normalizedFetchedAt,
    storedAt: validIso(storedAt),
    cacheAgeMs: Number.isFinite(ageMs) ? Math.max(0, ageMs) : null,
    requestedCount: requested,
    returnedCount: rows.length,
    latestTradeDate: rows.reduce((latest, row) => (
      String(row?.tradeDate ?? "") > latest ? String(row.tradeDate) : latest
    ), "") || null,
    endpoint: String(endpoint ?? "") || null,
    period: CANDLE_DESCRIPTOR.period,
    adjustment: CANDLE_DESCRIPTOR.adjustment,
    tradeSessions: CANDLE_DESCRIPTOR.tradeSessions,
    refreshAttempted: Boolean(refreshAttempted),
    fallbackReason: fallbackReason ? structuredClone(fallbackReason) : null,
    persistenceStatus: persistenceStatus ? String(persistenceStatus) : null,
  };
}

function validRawCandleRows(payload) {
  const list = Array.isArray(payload)
    ? payload
    : payload?.list ?? payload?.candlesticks ?? [];
  if (!Array.isArray(list)) return [];
  return list.filter((bar) => [bar?.open, bar?.high, bar?.low, bar?.close, bar?.volume]
    .every(isProvidedFiniteNumber));
}

function isProvidedFiniteNumber(value) {
  if (value == null || typeof value === "boolean") return false;
  if (typeof value === "string" && !value.trim()) return false;
  return Number.isFinite(Number(value));
}

function deduplicateDailyCandles(candles) {
  const rows = new Map();
  for (const candle of Array.isArray(candles) ? candles : []) {
    if (!candle?.tradeDate) continue;
    rows.set(candle.tradeDate, candle);
  }
  return [...rows.values()].sort((left, right) => (
    String(left.tradeDate).localeCompare(String(right.tradeDate))
    || Date.parse(left.timestamp) - Date.parse(right.timestamp)
  ));
}

async function callWithDeadline(call, { signal, timeoutMs } = {}) {
  if (signal?.aborted) throw abortSignalError(signal.reason);
  const controller = new AbortController();
  let timeoutId = null;
  let abortListener = null;
  const races = [Promise.resolve().then(() => call(controller.signal))];
  if (signal) {
    races.push(new Promise((_, reject) => {
      abortListener = () => {
        controller.abort(signal.reason);
        reject(abortSignalError(signal.reason));
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }));
  }
  const boundedMs = Number(timeoutMs);
  if (Number.isFinite(boundedMs) && boundedMs > 0) {
    races.push(new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error(`Daily candle live refresh exceeded ${boundedMs}ms.`);
        error.code = "CANDLE_REFRESH_TIMEOUT";
        controller.abort(error);
        reject(error);
      }, boundedMs);
    }));
  }
  try {
    return await Promise.race(races);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

function abortSignalError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error(reason ? String(reason) : "Daily candle request was aborted.");
  error.name = "AbortError";
  return error;
}

function candleRefreshUnavailableError(reason) {
  const error = new Error(`Daily candle live refresh unavailable: ${reason}.`);
  error.code = String(reason).toUpperCase();
  return error;
}

function marketSeriesRefreshUnavailableError(reason) {
  const error = new Error(`Market series live refresh unavailable: ${reason}.`);
  error.code = String(reason).toUpperCase();
  return error;
}

function candleErrorSummary(error) {
  return {
    code: error?.code == null ? null : String(error.code).slice(0, 80),
    message: String(error?.message ?? error ?? "unknown error").slice(0, 240),
  };
}

function cacheAgeMs(fetchedAt, now = Date.now()) {
  const timestamp = Date.parse(fetchedAt ?? "");
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : Infinity;
}

function isoFromMs(value) {
  return Number.isFinite(Number(value)) ? new Date(Number(value)).toISOString() : null;
}

function validIso(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString();
}

function nonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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
        const quotes = flattenQuotes(payload);
        const returnedSymbols = new Set(quotes.map((quote) => quote?.symbol));
        return {
          quotes,
          errors: batch.filter((symbol) => !returnedSymbols.has(symbol))
            .map((symbol) => `${symbol}: 长桥 ${tool} 未返回该标的行情；不使用空值或旧价格代替。`),
        };
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
    : payload?.list ?? payload?.quotes ?? payload?.option_quotes;
  if (!Array.isArray(list)) {
    throw new Error("长桥行情响应格式异常，未得到可核验的报价列表。");
  }
  return list;
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

function assertPortfolioCommitAllowed(commitGuard) {
  assertPortfolioCommitGuard(commitGuard);
  if (!portfolioCommitAllowed(commitGuard)) {
    const error = new Error("长桥授权已在同步期间发生变化；旧持仓结果未写入缓存。");
    error.code = "STALE_LONGBRIDGE_AUTHORIZATION_GENERATION";
    throw error;
  }
}

function assertPortfolioCommitGuard(commitGuard) {
  if (commitGuard != null && typeof commitGuard !== "function") {
    throw new TypeError("Portfolio refresh commitGuard must be a function.");
  }
}

function portfolioCommitAllowed(commitGuard) {
  return commitGuard == null || commitGuard() === true;
}
