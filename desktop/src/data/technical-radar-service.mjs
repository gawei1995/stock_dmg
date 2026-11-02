import { createHash } from "node:crypto";

import { inferInstrumentType } from "./normalize.mjs";
import { classifyLastDailyBar } from "../engine/technical.mjs";
import {
  buildTierATechnicalBatchScan,
  TIER_A_TECHNICAL_SCAN_SCHEMA_VERSION,
} from "../engine/tier-a-technical-scan.mjs";

export const TECHNICAL_RADAR_SERVICE_SCHEMA_VERSION = "technical-radar-service/v1";
export const TECHNICAL_RADAR_SERVICE_MAX_SYMBOLS = 50;
export const TECHNICAL_RADAR_SERVICE_CANDLE_COUNT = 1_000;
export const TECHNICAL_RADAR_SERVICE_CONCURRENCY = 4;
export const TECHNICAL_RADAR_SERVICE_BENCHMARK = "QQQ.US";

export class TechnicalRadarServiceError extends Error {
  constructor(code, message, details = {}, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "TechnicalRadarServiceError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Read-only orchestration around the deterministic Tier A scanner.
 *
 * The service owns universe selection, bounded candle loading, daily-bar
 * finality, prior-batch hydration, and tamper-evident persistence. It does not
 * fetch positions itself, infer a trade, or pass wall-clock analysis time into
 * the scanner.
 */
export class TechnicalRadarService {
  constructor({
    portfolioService,
    radarStore,
    watchlistStore,
    scanner = buildTierATechnicalBatchScan,
    classifyDailyBar = classifyLastDailyBar,
    clock = () => new Date(),
    benchmarkSymbol = TECHNICAL_RADAR_SERVICE_BENCHMARK,
    maxSymbols = TECHNICAL_RADAR_SERVICE_MAX_SYMBOLS,
    candleCount = TECHNICAL_RADAR_SERVICE_CANDLE_COUNT,
    concurrency = TECHNICAL_RADAR_SERVICE_CONCURRENCY,
  } = {}) {
    if (typeof portfolioService?.candlesWithCoverage !== "function") {
      throw new TypeError("TechnicalRadarService requires PortfolioService.candlesWithCoverage.");
    }
    if (typeof radarStore?.latest !== "function" || typeof radarStore?.appendBatch !== "function") {
      throw new TypeError("TechnicalRadarService requires a TechnicalRadarStore.");
    }
    if (typeof watchlistStore?.snapshot !== "function") {
      throw new TypeError("TechnicalRadarService requires a TechnicalWatchlistStore.");
    }
    if (typeof scanner !== "function" || typeof classifyDailyBar !== "function") {
      throw new TypeError("TechnicalRadarService requires deterministic scanner and daily-bar classifier functions.");
    }
    this.portfolioService = portfolioService;
    this.radarStore = radarStore;
    this.watchlistStore = watchlistStore;
    this.scanner = scanner;
    this.classifyDailyBar = classifyDailyBar;
    this.clock = typeof clock === "function" ? clock : () => new Date();
    this.benchmarkSymbol = normalizeSymbol(benchmarkSymbol);
    this.maxSymbols = boundedInteger(maxSymbols, "maxSymbols", 1, TECHNICAL_RADAR_SERVICE_MAX_SYMBOLS);
    this.candleCount = boundedInteger(
      candleCount,
      "candleCount",
      TECHNICAL_RADAR_SERVICE_CANDLE_COUNT,
      TECHNICAL_RADAR_SERVICE_CANDLE_COUNT,
    );
    this.concurrency = boundedInteger(
      concurrency,
      "concurrency",
      1,
      TECHNICAL_RADAR_SERVICE_CONCURRENCY,
    );
  }

  /**
   * Return the current holdings/watchlist universe plus the latest persisted
   * batch. No market-data request is made.
   */
  async snapshot({ portfolio = null, accountScopeId = null, signal = null } = {}) {
    throwIfAborted(signal);
    const context = await this.#context({ portfolio, accountScopeId, signal });
    throwIfAborted(signal);
    return deepFreeze({
      schemaVersion: TECHNICAL_RADAR_SERVICE_SCHEMA_VERSION,
      status: context.latest ? "available" : "empty",
      accountScopeId: context.accountScopeId,
      universe: context.universe,
      watchlist: context.watchlist,
      latest: context.latest ? persistedBatchView(context.latest) : null,
      coverage: context.latest?.summary?.coverage ?? null,
      rankings: context.latest?.summary?.rankings ?? null,
      cards: structuredClone(context.latest?.items ?? []),
    });
  }

  /**
   * Load one exact daily dataset per selected symbol plus QQQ, run the
   * deterministic scanner, and append a hash-chained batch when evidence
   * changed. Symbol failures remain unavailable cards; QQQ failure aborts the
   * batch because a shared cutoff cannot be established safely.
   */
  async run({ portfolio = null, accountScopeId = null, signal = null } = {}) {
    throwIfAborted(signal);
    const context = await this.#context({ portfolio, accountScopeId, signal });
    const symbols = [...new Set([...context.universe.selectedSymbols, this.benchmarkSymbol])];
    const loads = await mapConcurrent(symbols, this.concurrency, async (symbol) => {
      throwIfAborted(signal);
      try {
        const result = await this.portfolioService.candlesWithCoverage(
          symbol,
          this.candleCount,
          {
            signal,
            preferPersistent: true,
            allowPersistentFallback: true,
          },
        );
        throwIfAborted(signal);
        return buildCompletedDescriptor({
          symbol,
          result,
          classifyDailyBar: this.classifyDailyBar,
          requestedCount: this.candleCount,
        });
      } catch (error) {
        if (isAbort(error, signal)) throw abortError(signal, error);
        return failedLoad(symbol, error);
      }
    }, signal);
    throwIfAborted(signal);

    const loadBySymbol = new Map(loads.map((load) => [load.symbol, load]));
    const benchmarkLoad = loadBySymbol.get(this.benchmarkSymbol);
    if (!benchmarkLoad?.ok) {
      throw new TechnicalRadarServiceError(
        "technical_radar_benchmark_failed",
        `Technical radar could not establish the ${this.benchmarkSymbol} completed-daily cutoff.`,
        {
          benchmarkSymbol: this.benchmarkSymbol,
          failure: benchmarkLoad?.failure ?? { code: "benchmark_load_missing", message: "Benchmark load missing." },
        },
      );
    }

    const dailyBySymbol = Object.fromEntries(symbols.map((symbol) => {
      const load = loadBySymbol.get(symbol);
      return [symbol, load?.ok
        ? load.descriptor
        : {
            bars: [],
            completedBarsOnly: true,
            source: "technical_radar_symbol_load_failed",
          }];
    }));
    const previousBatch = reconstructPreviousBatch(context.latest);
    let scan;
    try {
      // Do not pass analysisTime. The scanner derives a stable deterministic
      // value from the QQQ completed cutoff instead of wall-clock time.
      scan = this.scanner({
        holdings: context.universe.holdingSymbols,
        watchlist: context.universe.watchlistSymbols,
        dailyBySymbol,
        benchmarkSymbol: this.benchmarkSymbol,
        previousBatch,
        maxSymbols: this.maxSymbols,
      });
    } catch (error) {
      throw new TechnicalRadarServiceError(
        "technical_radar_scan_failed",
        "Technical radar deterministic scan failed.",
        { causeCode: String(error?.code ?? error?.name ?? "scan_error") },
        error,
      );
    }
    throwIfAborted(signal);

    const loadSummary = summarizeLoads(loads, this.benchmarkSymbol);
    const coverage = {
      ...structuredClone(scan.coverage),
      dataLoads: loadSummary,
    };
    const evidenceHash = hashCanonical({
      schemaVersion: TECHNICAL_RADAR_SERVICE_SCHEMA_VERSION,
      scannerVersion: scan.schemaVersion,
      cutoff: scan.cutoff,
      universe: context.universe,
      cards: scan.cards.map((card) => ({
        symbol: card.symbol,
        status: card.status,
        inputHash: card.inputHash,
        observableState: card.observableState,
      })),
      dataLoads: loads.map(stableLoadEvidence),
    });
    const duplicate = context.latest?.summary?.evidenceHash === evidenceHash;
    let persisted;
    if (duplicate) {
      persisted = { appended: false, batch: structuredClone(context.latest) };
    } else {
      throwIfAborted(signal);
      const timestamp = this.#nowIso();
      persisted = await this.radarStore.appendBatch({
        accountScopeId: context.accountScopeId,
        tradingDate: scan.cutoff,
        computedAt: timestamp,
        recordedAt: timestamp,
        inputHash: evidenceHash,
        scannerVersion: scan.schemaVersion,
        source: "tier_a_deterministic_scan",
        summary: {
          evidenceHash,
          scannerInputHash: scan.inputHash,
          scannerCacheKey: scan.cacheKey,
          status: scan.status,
          coverage,
          rankings: scan.rankings,
          comparison: scan.comparison,
          capabilityMatrix: scan.capabilityMatrix,
          universe: context.universe,
        },
        items: scan.cards.map(compactPersistedCard),
        limitations: scan.limitations,
      });
    }

    return deepFreeze({
      schemaVersion: TECHNICAL_RADAR_SERVICE_SCHEMA_VERSION,
      status: scan.status,
      accountScopeId: context.accountScopeId,
      tradingDate: scan.cutoff,
      evidenceHash,
      scanner: {
        schemaVersion: scan.schemaVersion,
        inputHash: scan.inputHash,
        cacheKey: scan.cacheKey,
      },
      universe: context.universe,
      dataLoads: loadSummary,
      coverage,
      rankings: scan.rankings,
      cards: scan.cards,
      persistence: {
        appended: persisted.appended,
        batchId: persisted.batch.batchId,
        revision: persisted.batch.revision,
        recordHash: persisted.batch.recordHash,
      },
      limitations: scan.limitations,
    });
  }

  async #context({ portfolio, accountScopeId, signal }) {
    const [resolvedPortfolio, watchlist] = await Promise.all([
      this.#portfolio(portfolio),
      this.watchlistStore.snapshot(),
    ]);
    throwIfAborted(signal);
    const scope = resolveAccountScopeId(accountScopeId, resolvedPortfolio);
    const universe = buildRadarUniverse({
      positions: resolvedPortfolio?.positions,
      watchlistItems: watchlist?.items,
      maxSymbols: this.maxSymbols,
    });
    const latest = await this.radarStore.latest({ accountScopeId: scope });
    throwIfAborted(signal);
    return {
      portfolio: resolvedPortfolio,
      watchlist: structuredClone(watchlist),
      accountScopeId: scope,
      universe,
      latest,
    };
  }

  async #portfolio(value) {
    if (value && typeof value === "object") return value;
    if (typeof this.portfolioService.cachedPortfolio === "function") {
      return await this.portfolioService.cachedPortfolio() ?? { positions: [] };
    }
    return { positions: [] };
  }

  #nowIso() {
    const value = this.clock();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new TechnicalRadarServiceError(
        "technical_radar_clock_invalid",
        "Technical radar clock returned an invalid timestamp.",
      );
    }
    return date.toISOString();
  }
}

export function buildRadarUniverse({ positions = [], watchlistItems = [], maxSymbols = 50 } = {}) {
  const limit = boundedInteger(maxSymbols, "maxSymbols", 1, TECHNICAL_RADAR_SERVICE_MAX_SYMBOLS);
  const includedHoldings = new Set();
  const excludedHoldings = [];
  for (const position of Array.isArray(positions) ? positions : []) {
    const symbol = safeSymbol(position?.symbol);
    if (!symbol) {
      excludedHoldings.push({ symbol: null, reason: "symbol_invalid" });
      continue;
    }
    const quantity = strictNumber(position?.quantity);
    if (quantity == null || quantity === 0) {
      excludedHoldings.push({ symbol, reason: quantity === 0 ? "zero_quantity" : "quantity_unavailable" });
      continue;
    }
    if (String(position?.instrumentType ?? inferInstrumentType(symbol)).toLowerCase() === "option") {
      excludedHoldings.push({ symbol, reason: "option_excluded" });
      continue;
    }
    includedHoldings.add(symbol);
  }
  const holdingSymbols = [...includedHoldings].sort();
  const watchlistSet = new Set();
  const excludedWatchlist = [];
  for (const item of Array.isArray(watchlistItems) ? watchlistItems : []) {
    const symbol = safeSymbol(typeof item === "string" ? item : item?.symbol);
    if (!symbol) {
      excludedWatchlist.push({ symbol: null, reason: "symbol_invalid" });
      continue;
    }
    if (inferInstrumentType(symbol) === "option") {
      excludedWatchlist.push({ symbol, reason: "option_excluded" });
      continue;
    }
    watchlistSet.add(symbol);
  }
  const watchlistSymbols = [...watchlistSet].sort();
  const watchlistOnly = watchlistSymbols.filter((symbol) => !includedHoldings.has(symbol));
  const requestedSymbols = [...holdingSymbols, ...watchlistOnly];
  const selectedSymbols = requestedSymbols.slice(0, limit);
  const omittedSymbols = requestedSymbols.slice(limit);
  return deepFreeze({
    maxSymbols: limit,
    holdingSymbols,
    watchlistSymbols,
    requestedSymbols,
    selectedSymbols,
    omittedSymbols,
    omittedHoldingSymbols: omittedSymbols.filter((symbol) => includedHoldings.has(symbol)),
    omittedWatchlistSymbols: omittedSymbols.filter((symbol) => watchlistSet.has(symbol)),
    excludedHoldings: excludedHoldings.sort(compareExclusions),
    excludedWatchlist: excludedWatchlist.sort(compareExclusions),
  });
}

function buildCompletedDescriptor({ symbol, result, classifyDailyBar, requestedCount }) {
  const candles = Array.isArray(result?.candles) ? result.candles : [];
  if (!candles.length) {
    throw new TechnicalRadarServiceError(
      "technical_radar_daily_bars_empty",
      `${symbol} returned no daily candles.`,
      { symbol },
    );
  }
  const terminal = candles.at(-1);
  const evaluatedAt = stableFinalityTime(result?.coverage, terminal);
  const classification = classifyDailyBar(terminal, { symbol, analysisTime: evaluatedAt });
  const terminalCompleted = classification?.status === "CLOSED";
  const completed = terminalCompleted ? candles : candles.slice(0, -1);
  if (!completed.length) {
    throw new TechnicalRadarServiceError(
      "technical_radar_no_completed_daily_bars",
      `${symbol} has no completed daily candles after terminal-bar finality checks.`,
      { symbol, terminalBarStatus: classification?.status ?? "UNKNOWN" },
    );
  }
  const interiorForming = completed.findIndex(isExplicitlyForming);
  if (interiorForming >= 0) {
    throw new TechnicalRadarServiceError(
      "technical_radar_interior_forming_bar",
      `${symbol} contains an explicitly forming non-terminal daily bar.`,
      { symbol, index: interiorForming },
    );
  }
  const bars = completed.map((bar) => canonicalCompletedBar(bar, symbol));
  validateCanonicalBars(bars, symbol);
  const coverage = stableCoverage({
    coverage: result?.coverage,
    bars,
    requestedCount,
    terminalExcluded: !terminalCompleted,
  });
  return {
    symbol,
    ok: true,
    descriptor: {
      bars,
      completedBarsOnly: true,
      source: coverage.source,
      coverage,
    },
    finality: {
      terminalInputTradeDate: dateOnly(terminal?.tradeDate ?? terminal?.timestamp),
      terminalBarStatus: classification?.status ?? "UNKNOWN",
      terminalBarBasis: classification?.basis ?? "unknown",
      terminalExcluded: !terminalCompleted,
      completedThroughTradeDate: bars.at(-1).tradeDate,
    },
    failure: null,
  };
}

function canonicalCompletedBar(bar, symbol) {
  const tradeDate = dateOnly(bar?.tradeDate ?? bar?.trade_date ?? bar?.timestamp);
  if (!tradeDate) {
    throw new TechnicalRadarServiceError(
      "technical_radar_trade_date_invalid",
      `${symbol} contains a daily candle without a valid trade date.`,
      { symbol },
    );
  }
  return {
    timestamp: validIso(bar?.timestamp) ?? `${tradeDate}T00:00:00.000Z`,
    tradeDate,
    timestampBasis: textOrNull(bar?.timestampBasis ?? bar?.timestamp_basis),
    symbol,
    market: textOrNull(bar?.market),
    open: strictRequiredNumber(bar?.open, "open", symbol),
    high: strictRequiredNumber(bar?.high, "high", symbol),
    low: strictRequiredNumber(bar?.low, "low", symbol),
    close: strictRequiredNumber(bar?.close, "close", symbol),
    volume: strictRequiredNumber(bar?.volume, "volume", symbol),
    tradeSession: textOrNull(bar?.tradeSession ?? bar?.trade_session) ?? "Intraday",
    isClosed: true,
  };
}

function validateCanonicalBars(bars, symbol) {
  let previous = null;
  for (const [index, bar] of bars.entries()) {
    if (previous && bar.tradeDate <= previous.tradeDate) {
      throw new TechnicalRadarServiceError(
        "technical_radar_bars_not_strictly_ascending",
        `${symbol} daily candles are not strictly ascending by trade date.`,
        { symbol, index, previousTradeDate: previous.tradeDate, tradeDate: bar.tradeDate },
      );
    }
    if (bar.open <= 0 || bar.high <= 0 || bar.low <= 0 || bar.close <= 0
      || bar.volume < 0 || bar.high < Math.max(bar.open, bar.close, bar.low)
      || bar.low > Math.min(bar.open, bar.close, bar.high)) {
      throw new TechnicalRadarServiceError(
        "technical_radar_bar_bounds_invalid",
        `${symbol} contains a daily candle with impossible OHLCV bounds.`,
        { symbol, index, tradeDate: bar.tradeDate },
      );
    }
    previous = bar;
  }
}

function stableCoverage({ coverage, bars, requestedCount, terminalExcluded }) {
  const value = coverage && typeof coverage === "object" ? coverage : {};
  const source = String(value.originSource ?? value.source ?? "unknown");
  const reasons = new Set(
    (Array.isArray(value.partialReasons) ? value.partialReasons : []).map(String).filter(Boolean),
  );
  if (terminalExcluded) reasons.add("terminal_forming_bar_excluded");
  if (bars.length < requestedCount) reasons.add("insufficient_completed_history");
  const partial = reasons.size > 0;
  return {
    source,
    originSource: textOrNull(value.originSource) ?? (source === "unknown" ? null : source),
    coverageStatus: partial ? "partial" : "complete",
    complete: !partial,
    partial,
    partialReasons: [...reasons].sort(),
    fetchedAt: validIso(value.fetchedAt),
    storedAt: validIso(value.storedAt),
    requestedCount,
    returnedCount: bars.length,
    latestTradeDate: bars.at(-1)?.tradeDate ?? null,
    endpoint: textOrNull(value.endpoint),
    period: textOrNull(value.period) ?? "day",
    adjustment: textOrNull(value.adjustment) ?? "forward",
    tradeSessions: textOrNull(value.tradeSessions) ?? "intraday",
    refreshAttempted: Boolean(value.refreshAttempted),
    fallbackReason: finiteJsonClone(value.fallbackReason),
    persistenceStatus: textOrNull(value.persistenceStatus),
  };
}

function failedLoad(symbol, error) {
  return {
    symbol,
    ok: false,
    descriptor: null,
    finality: null,
    failure: {
      code: String(error?.code ?? error?.name ?? "candle_load_failed").slice(0, 120),
      message: String(error?.message ?? error).slice(0, 300),
    },
  };
}

function summarizeLoads(loads, benchmarkSymbol) {
  const succeeded = loads.filter((load) => load.ok);
  const failed = loads.filter((load) => !load.ok);
  return {
    requestedCount: loads.length,
    succeededCount: succeeded.length,
    failedCount: failed.length,
    benchmarkSymbol,
    benchmarkReady: Boolean(loads.find((load) => load.symbol === benchmarkSymbol)?.ok),
    failures: failed.map((load) => ({ symbol: load.symbol, ...load.failure })),
    finality: succeeded.map((load) => ({ symbol: load.symbol, ...load.finality })),
  };
}

function stableLoadEvidence(load) {
  return load.ok
    ? {
        symbol: load.symbol,
        ok: true,
        inputHash: hashCanonical(load.descriptor.bars),
        coverage: load.descriptor.coverage,
        finality: load.finality,
      }
    : { symbol: load.symbol, ok: false, failure: load.failure };
}

function reconstructPreviousBatch(batch) {
  if (!batch || batch.scannerVersion !== TIER_A_TECHNICAL_SCAN_SCHEMA_VERSION
    || !Array.isArray(batch.items)) return null;
  return {
    schemaVersion: TIER_A_TECHNICAL_SCAN_SCHEMA_VERSION,
    cutoff: batch.tradingDate,
    cards: batch.items.map((item) => ({
      symbol: item.symbol,
      observableState: structuredClone(item.observableState ?? {}),
    })),
  };
}

function compactPersistedCard(card) {
  const fields = [
    "symbol",
    "memberships",
    "status",
    "cutoff",
    "inputHash",
    "lastClose",
    "ema",
    "structure",
    "metrics",
    "weekly",
    "costProfile14d28d",
    "benchmark",
    "sector",
    "marketEvidence",
    "degradedReasons",
    "observableState",
    "comparison",
  ];
  return Object.fromEntries(fields.map((field) => [field, structuredClone(card[field])]));
}

function persistedBatchView(batch) {
  return {
    batchId: batch.batchId,
    revision: batch.revision,
    tradingDate: batch.tradingDate,
    computedAt: batch.computedAt,
    recordedAt: batch.recordedAt,
    inputHash: batch.inputHash,
    scannerVersion: batch.scannerVersion,
    recordHash: batch.recordHash,
    summary: structuredClone(batch.summary),
  };
}

async function mapConcurrent(values, concurrency, mapper, signal) {
  const items = [...values];
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      throwIfAborted(signal);
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(items.length, concurrency) },
    () => worker(),
  ));
  return results;
}

function resolveAccountScopeId(explicit, portfolio) {
  const value = textOrNull(explicit)
    ?? textOrNull(portfolio?.accountScopeIdentity?.scopeId)
    ?? textOrNull(portfolio?.accountScope?.scopeId)
    ?? textOrNull(portfolio?.accountScopeId);
  if (!value) {
    throw new TechnicalRadarServiceError(
      "technical_radar_account_scope_required",
      "Technical radar requires an explicit or verified account scope before persistence.",
    );
  }
  return value;
}

function stableFinalityTime(coverage, terminal) {
  return validIso(coverage?.fetchedAt)
    ?? validIso(coverage?.storedAt)
    ?? validIso(terminal?.timestamp)
    ?? `${dateOnly(terminal?.tradeDate) ?? "1970-01-01"}T00:00:00.000Z`;
}

function isExplicitlyForming(bar) {
  if (!bar || typeof bar !== "object") return false;
  if (bar.isClosed === false || bar.is_closed === false || bar.closed === false
    || bar.complete === false || bar.confirmed === false || bar.final === false) return true;
  const status = String(
    bar.barStatus ?? bar.bar_status ?? bar.status ?? bar.state ?? "",
  ).trim().toLowerCase();
  return ["forming", "open", "partial", "updating", "realtime", "live"].includes(status);
}

function strictRequiredNumber(value, field, symbol) {
  const number = strictNumber(value);
  if (number == null) {
    throw new TechnicalRadarServiceError(
      "technical_radar_bar_number_invalid",
      `${symbol} contains an invalid ${field} value.`,
      { symbol, field },
    );
  }
  return number;
}

function strictNumber(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeSymbol(value) {
  try {
    return normalizeSymbol(value);
  } catch {
    return null;
  }
}

function normalizeSymbol(value) {
  let symbol = String(value ?? "").trim().toUpperCase();
  if (!symbol) throw new TechnicalRadarServiceError("technical_radar_symbol_invalid", "Symbol is required.");
  if (!symbol.includes(".") && /^[A-Z][A-Z0-9-]{0,9}$/.test(symbol)) symbol = `${symbol}.US`;
  if (!/^[A-Z0-9][A-Z0-9_-]{0,29}\.(US|HK|SG|SH|SZ|CN)$/.test(symbol)) {
    throw new TechnicalRadarServiceError(
      "technical_radar_symbol_invalid",
      `Technical radar symbol ${symbol} is invalid.`,
    );
  }
  return symbol;
}

function compareExclusions(left, right) {
  return String(left.symbol ?? "").localeCompare(String(right.symbol ?? ""))
    || left.reason.localeCompare(right.reason);
}

function dateOnly(value) {
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(`${text}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text
      ? text
      : null;
  }
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function validIso(value) {
  const date = new Date(String(value ?? ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function textOrNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function finiteJsonClone(value) {
  if (value == null) return null;
  try {
    const cloned = structuredClone(value);
    assertFiniteJson(cloned);
    return cloned;
  } catch {
    return null;
  }
}

function assertFiniteJson(value, seen = new Set()) {
  if (value == null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non_finite");
    return;
  }
  if (typeof value !== "object" || seen.has(value)) throw new TypeError("non_json");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertFiniteJson(item, seen);
  } else {
    for (const item of Object.values(value)) assertFiniteJson(item, seen);
  }
  seen.delete(value);
}

function boundedInteger(value, field, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return number;
}

function hashCanonical(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value) {
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : `[${String(value)}]`;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") return `[unsupported:${typeof value}]`;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function isAbort(error, signal) {
  return signal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal, fallback = null) {
  if (signal?.reason instanceof Error) return signal.reason;
  if (fallback?.name === "AbortError") return fallback;
  const error = new Error("Technical radar operation was aborted.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
