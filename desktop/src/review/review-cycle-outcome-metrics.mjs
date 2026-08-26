import {
  buildReviewTradePricePath,
  exchangeTimezoneForSymbol,
} from "./review-trade-price-path.mjs";
import { partitionReviewExecutions } from "../data/trade-history-service.mjs";

const MAX_METRIC_SYMBOLS = 8;
const DEFAULT_CANDLE_COUNT = 1_000;
const DEFAULT_TIMEOUT_MS = 2_500;

/**
 * Build host-computed outcome facts for a completed decision cycle.
 * Every numeric result is derived only from linked Longbridge executions and
 * bounded Longbridge daily bars. Missing inputs remain explicit nulls.
 */
export async function buildReviewCycleOutcomeMetrics({
  cycle,
  archive,
  loadCandles,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => new Date(),
} = {}) {
  const startAt = optionalIso(cycle?.startAt);
  const endAt = optionalIso(cycle?.endAt);
  const generatedAt = now().toISOString();
  const linkedExecutionIds = uniqueStrings(cycle?.brokerLinks?.executionIds);
  const requestedRecordIds = uniqueStrings(cycle?.brokerLinks?.requestedRecordIds);
  const selectedOrderIds = requestedRecordIds
    .filter((id) => id.startsWith("order:"))
    .map((id) => id.slice("order:".length));
  const selectedExecutionIds = requestedRecordIds
    .filter((id) => id.startsWith("execution:"))
    .map((id) => id.slice("execution:".length));
  const isSelectedTradeWindow = String(cycle?.cycleType ?? cycle?.type ?? "") === "trade_window";
  const archiveExecutionEligibility = partitionReviewExecutions(
    archive?.executions ?? [],
    archive?.orders ?? [],
  );
  const executionById = new Map(archiveExecutionEligibility.included.map((item) => [String(item?.tradeId), item]));
  const missingExecutionIds = linkedExecutionIds.filter((id) => !executionById.has(id));
  const linkedExecutions = linkedExecutionIds
    .map((id) => executionById.get(id))
    .filter(Boolean)
    .filter((item) => inClosedRange(item?.doneAt, startAt, endAt));
  const buildSelectedTradePricePath = (candles = []) => isSelectedTradeWindow
    ? buildReviewTradePricePath({
      selectedOrderIds,
      selectedExecutionIds,
      orders: archive?.orders ?? [],
      executions: archiveExecutionEligibility.included,
      candles,
      asOf: endAt,
      timezone: cycle?.timezone,
    })
    : null;
  const initialTradePricePath = buildSelectedTradePricePath();
  const explicitWindowStartAt = optionalIso(initialTradePricePath?.window?.startAt);
  const explicitWindowEndAt = optionalIso(initialTradePricePath?.window?.endAt);
  const hasExplicitTradeWindow = isSelectedTradeWindow && Boolean(explicitWindowStartAt && explicitWindowEndAt);
  const metricStartAt = hasExplicitTradeWindow
    ? explicitWindowStartAt
    : startAt;
  const metricEndAt = hasExplicitTradeWindow
    ? explicitWindowEndAt
    : endAt;
  const executions = isSelectedTradeWindow
    ? selectedPathActivitiesAsExecutions(initialTradePricePath)
    : linkedExecutions;
  const executionPnl = calculateExecutionGrossPnl({
    executions,
    startingPortfolio: cycle?.startingPortfolio ?? cycle?.portfolioSnapshot ?? null,
    linkedExecutionCount: isSelectedTradeWindow ? executions.length : linkedExecutionIds.length,
    missingExecutionCount: isSelectedTradeWindow ? 0 : missingExecutionIds.length,
    archiveSyncedAt: archive?.syncedAt ?? null,
    startAt: metricStartAt,
    endAt: metricEndAt,
  });
  executionPnl.coverage.selectionScope = isSelectedTradeWindow
    ? "explicit_user_selected_buy_sell_activities"
    : "all_cycle_linked_executions";

  const cycleSymbols = uniqueStrings([
    ...(Array.isArray(cycle?.symbols) ? cycle.symbols : []),
    cycle?.symbol,
    ...linkedExecutions.map((item) => item?.symbol),
  ]).map(normalizeSymbol).filter(Boolean);
  const benchmark = normalizeSymbol(cycle?.benchmark)
    ?? (cycleSymbols.some((symbol) => symbol.endsWith(".US")) ? "QQQ.US" : null);
  const requestedSymbols = uniqueStrings([...cycleSymbols, benchmark]).slice(0, MAX_METRIC_SYMBOLS);
  const omittedSymbols = uniqueStrings([...cycleSymbols, benchmark]).slice(MAX_METRIC_SYMBOLS);
  const initiallyUnavailableSymbols = cycleSymbols.slice(0, MAX_METRIC_SYMBOLS)
    .map((symbol) => unavailablePath(symbol, "candles_not_loaded"));
  const base = {
    schemaVersion: 1,
    status: "unavailable",
    generatedAt,
    cycleWindow: {
      startAt: metricStartAt,
      endAt: metricEndAt,
      declaredStartAt: metricStartAt === startAt ? null : startAt,
      declaredEndAt: metricEndAt === endAt ? null : endAt,
      policy: hasExplicitTradeWindow
        ? "explicit_user_selected_buy_to_sell"
        : isSelectedTradeWindow
          ? "declared_cycle_window_fallback_due_to_missing_explicit_anchors"
          : "declared_cycle_window",
    },
    executionPnl,
    tradePricePath: initialTradePricePath,
    pricePath: {
      status: "unavailable",
      benchmark,
      symbols: initiallyUnavailableSymbols,
      benchmarkMetrics: unavailablePath(benchmark, "candles_not_loaded"),
      excessReturns: initiallyUnavailableSymbols.map((item) => ({
        symbol: item.symbol,
        valuePercent: null,
        reason: "symbol_and_benchmark_returns_unavailable",
      })),
    },
    coverage: {
      source: "Longbridge forward-adjusted regular-hours daily candles + linked executions · read only",
      archiveSyncedAt: optionalIso(archive?.syncedAt),
      requestedSymbols,
      omittedSymbols,
      loadedSymbols: [],
      failedSymbols: [],
      candleSources: [],
      candleCountRequested: DEFAULT_CANDLE_COUNT,
      resolution: "1D",
      adjustType: "forward",
      tradeSession: "regular_hours",
      reasons: [],
      excludedAuditExecutionCount: archiveExecutionEligibility.excluded
        .filter(({ execution }) => linkedExecutionIds.includes(String(execution?.tradeId))).length,
    },
    provenance: {
      deterministicHostCalculation: true,
      modelLookupAllowedAsMetricSubstitute: false,
      endBoundary: "Only completed daily bars whose exchange trade date is within the cycle and whose bar is closed as of endAt are eligible.",
      returnMethod: "first eligible close to last eligible close",
      excursionMethod: "long-oriented price excursion from first eligible close; daily high/low, not position-adjusted trade MAE/MFE",
      executionMethod: isSelectedTradeWindow
        ? "FIFO round-trip gross P&L paired only among explicit user-selected Buy/Sell activities; supplemental parent and sibling records are excluded. Not brokerage account realized P&L or tax cost basis; no fees, FX conversion, current holdings, or inferred starting inventory."
        : "FIFO round-trip gross P&L paired only among linked in-cycle executions; not brokerage account realized P&L or tax cost basis; no fees, FX conversion, current holdings, or inferred starting inventory",
      selectedTradePathMethod: "For trade_window only: exact user-selected order/fill anchors define earliest selected Buy execution to latest selected Sell execution; resolved parent and sibling records cannot expand the path. More than three completed exchange trading sessions are summarized in non-overlapping three-session segments.",
    },
  };
  if (isSelectedTradeWindow && !hasExplicitTradeWindow) {
    base.coverage.reasons.push("explicit_trade_window_unavailable_declared_cycle_fallback_used");
  }

  if (!metricStartAt || !metricEndAt || Date.parse(metricEndAt) < Date.parse(metricStartAt)) {
    base.coverage.reasons.push("cycle_window_invalid");
    base.executionPnl = unavailableExecutionPnl("cycle_window_invalid", executionPnl.coverage);
    return base;
  }
  if (!requestedSymbols.length) {
    base.coverage.reasons.push("cycle_symbols_missing");
    return combineMetricStatus(base);
  }
  if (typeof loadCandles !== "function") {
    base.coverage.reasons.push("longbridge_candles_unavailable");
    return combineMetricStatus(base);
  }

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener?.("abort", abortFromParent, { once: true });
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true, results: [] }), Math.max(50, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  });
  const work = Promise.allSettled(requestedSymbols.map(async (symbol) => {
    const loaded = normalizeLoadedCandles(
      await loadCandles(symbol, DEFAULT_CANDLE_COUNT, { signal: controller.signal }),
    );
    return { symbol, ...loaded };
  })).then((results) => ({ timedOut: false, results }));

  let outcome;
  try {
    outcome = await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", abortFromParent);
  }
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("周期结果指标计算已取消。");
  }
  if (outcome.timedOut) {
    controller.abort(new Error("周期结果指标日线读取超时。"));
    base.coverage.reasons.push("historical_candles_timeout");
    base.coverage.failedSymbols = requestedSymbols.map((symbol) => ({ symbol, reason: "timeout" }));
    return combineMetricStatus(base);
  }

  const metricsBySymbol = new Map();
  const candlesBySymbol = new Map();
  outcome.results.forEach((result, index) => {
    const symbol = requestedSymbols[index];
    if (result.status === "rejected") {
      base.coverage.failedSymbols.push({ symbol, reason: cleanReason(result.reason) });
      return;
    }
    const eligibleBars = selectCompletedCycleCandles(result.value.candles, {
      symbol,
      startAt: metricStartAt,
      endAt: metricEndAt,
      timezone: exchangeTimezoneForSymbol(symbol, cycle?.timezone),
    });
    const metrics = calculatePricePathMetrics({
      symbol,
      candles: eligibleBars,
      startAt: metricStartAt,
      endAt: metricEndAt,
    });
    candlesBySymbol.set(symbol, result.value.candles);
    metricsBySymbol.set(symbol, metrics);
    const candleCoverage = compactCandleCoverage(result.value.coverage);
    base.coverage.loadedSymbols.push({
      symbol,
      eligibleBarCount: eligibleBars.length,
      source: candleCoverage?.source ?? "unspecified",
      coverageStatus: candleCoverage?.coverageStatus ?? "unknown",
    });
    if (candleCoverage) base.coverage.candleSources.push({ symbol, ...candleCoverage });
    if (candleCoverage?.partial === true || candleCoverage?.source === "persistent_fallback") {
      base.coverage.reasons.push(`candle_evidence_degraded:${symbol}`);
    }
  });
  if (base.coverage.failedSymbols.length) base.coverage.reasons.push("some_candles_unavailable");
  if (omittedSymbols.length) base.coverage.reasons.push("metric_symbol_limit_reached");

  const benchmarkMetrics = benchmark
    ? metricsBySymbol.get(benchmark) ?? unavailablePath(benchmark, "benchmark_candles_unavailable")
    : unavailablePath(null, "benchmark_not_configured_or_inferable");
  const symbolMetrics = cycleSymbols.slice(0, MAX_METRIC_SYMBOLS)
    .map((symbol) => metricsBySymbol.get(symbol) ?? unavailablePath(symbol, "symbol_candles_unavailable"));
  const excessReturns = symbolMetrics.map((item) => {
    if (item.periodReturnPercent == null) {
      return { symbol: item.symbol, valuePercent: null, reason: item.reason ?? "symbol_return_unavailable" };
    }
    if (benchmarkMetrics.periodReturnPercent == null) {
      return { symbol: item.symbol, valuePercent: null, reason: "benchmark_return_unavailable" };
    }
    return {
      symbol: item.symbol,
      valuePercent: round(item.periodReturnPercent - benchmarkMetrics.periodReturnPercent),
      reason: null,
      formula: "symbol period return - benchmark period return",
    };
  });
  base.pricePath = {
    status: aggregatePathStatus([...symbolMetrics, benchmarkMetrics]),
    benchmark,
    symbols: symbolMetrics,
    benchmarkMetrics,
    excessReturns,
  };
  if (isSelectedTradeWindow) {
    const selectedSymbol = base.tradePricePath?.symbol ?? cycleSymbols[0] ?? null;
    base.tradePricePath = buildSelectedTradePricePath(candlesBySymbol.get(selectedSymbol) ?? []);
  }
  return combineMetricStatus(base);
}

/**
 * Persist a bounded, renderer-safe projection of the deterministic selected
 * Buy→Sell path. It is evidence, not a model summary, and remains tied to the
 * phase run's evidenceRevision and resultHash in ReviewCycleStore.
 */
export function summarizeTradePricePath(metrics, { maxSegments = 72 } = {}) {
  const path = metrics?.tradePricePath;
  if (!path || typeof path !== "object") return null;
  const activities = Array.isArray(path.activities) ? path.activities : [];
  const anchorIds = new Set([
    path?.window?.startActivityId,
    path?.window?.endActivityId,
  ].filter(Boolean));
  const anchors = activities.filter((item) => anchorIds.has(item?.id)).slice(0, 2);
  const rawSegments = Array.isArray(path?.pricePath?.trend?.segments)
    ? path.pricePath.trend.segments
    : [];
  const projected = projectBoundedSequence(rawSegments, maxSegments);
  return {
    schemaVersion: 1,
    generatedAt: optionalIso(metrics?.generatedAt),
    status: path.status ?? "unavailable",
    reason: path.reason ?? null,
    symbol: path.symbol ?? null,
    currency: path.currency ?? null,
    positionStatus: path.positionStatus ?? null,
    window: path.window ? { ...path.window } : null,
    activities: anchors,
    metrics: {
      realizedQuantity: finiteOrNull(path?.metrics?.realizedQuantity),
      openQuantity: finiteOrNull(path?.metrics?.openQuantity),
      linkedSelectionGrossPnl: finiteOrNull(path?.metrics?.linkedSelectionGrossPnl),
      rawBuyVwap: finiteOrNull(path?.metrics?.rawBuyVwap),
      rawSellVwap: finiteOrNull(path?.metrics?.rawSellVwap),
    },
    pricePath: {
      status: path?.pricePath?.status ?? "unavailable",
      reason: path?.pricePath?.reason ?? null,
      periodReturnPercent: finiteOrNull(path?.pricePath?.periodReturnPercent),
      mfePercent: finiteOrNull(path?.pricePath?.mfePercent),
      maePercent: finiteOrNull(path?.pricePath?.maePercent),
      coverage: compactPathCoverage(path?.pricePath?.coverage),
      trend: {
        granularity: path?.pricePath?.trend?.granularity ?? null,
        segmentTradingDays: finiteOrNull(path?.pricePath?.trend?.segmentTradingDays),
        segmentCount: rawSegments.length,
        deliveredSegmentCount: rawSegments.length - projected.omittedCount,
        omittedSegmentCount: projected.omittedCount,
        segments: projected.items,
      },
    },
    marketDataCoverage: Array.isArray(metrics?.coverage?.candleSources)
      ? metrics.coverage.candleSources.slice(0, MAX_METRIC_SYMBOLS)
      : [],
  };
}

export function calculateExecutionGrossPnl({
  executions = [],
  startingPortfolio = null,
  linkedExecutionCount = executions.length,
  missingExecutionCount = 0,
  archiveSyncedAt = null,
  startAt = null,
  endAt = null,
} = {}) {
  const coverage = {
    source: "Longbridge linked executions · read only",
    archiveSyncedAt: optionalIso(archiveSyncedAt),
    linkedExecutionCount,
    availableExecutionCount: executions.length,
    missingExecutionCount,
    usedExecutionCount: 0,
    startAt: optionalIso(startAt),
    endAt: optionalIso(endAt),
  };
  if (!linkedExecutionCount) return unavailableExecutionPnl("no_linked_executions", coverage);
  if (missingExecutionCount) return unavailableExecutionPnl("linked_executions_missing_from_archive", coverage);

  const normalized = executions.map(normalizeExecutionForPnl);
  if (normalized.some((item) => !item)) return unavailableExecutionPnl("execution_fields_incomplete", coverage);
  const groups = new Map();
  for (const item of normalized.sort((left, right) => Date.parse(left.doneAt) - Date.parse(right.doneAt))) {
    const key = `${item.symbol}|${item.currency}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const bySymbol = [];
  for (const records of groups.values()) {
    const lots = [];
    let gross = 0;
    let realizedQuantity = 0;
    let used = 0;
    let invalidReason = null;
    for (const item of records) {
      used += 1;
      if (item.side === "buy") {
        lots.push({ quantity: item.quantity, price: item.price });
        continue;
      }
      let remaining = item.quantity;
      while (remaining > 0 && lots.length) {
        const lot = lots[0];
        const matched = Math.min(remaining, lot.quantity);
        gross += (item.price - lot.price) * matched;
        realizedQuantity += matched;
        lot.quantity -= matched;
        remaining -= matched;
        if (lot.quantity <= 1e-10) lots.shift();
      }
      if (remaining > 1e-10) {
        invalidReason = "starting_inventory_or_short_open_close_unknown";
        break;
      }
    }
    coverage.usedExecutionCount += used;
    const symbol = records[0].symbol;
    const currency = records[0].currency;
    const inventoryEvidence = startingInventoryEvidence(startingPortfolio, symbol, startAt);
    bySymbol.push({
      symbol,
      currency,
      linkedRoundTripGrossPnl: invalidReason ? null : round(gross),
      accountRealizedGrossPnl: null,
      realizedQuantity: invalidReason ? null : round(realizedQuantity, 6),
      endingUnclosedBuyQuantity: invalidReason ? null : round(lots.reduce((sum, lot) => sum + lot.quantity, 0), 6),
      startingInventoryEvidence: inventoryEvidence,
      status: invalidReason
        ? "unavailable"
        : realizedQuantity <= 0
          ? "partial"
          : inventoryEvidence.status === "verified_zero"
            ? "available"
            : "partial",
      reason: invalidReason
        ?? (realizedQuantity <= 0
          ? "no_closed_fifo_quantity"
          : inventoryEvidence.status === "verified_zero"
            ? null
            : "starting_inventory_not_proven_zero_linked_round_trip_only"),
    });
  }
  const invalid = bySymbol.find((item) => item.status === "unavailable");
  if (invalid) return unavailableExecutionPnl(invalid.reason, coverage, bySymbol);
  const currencies = uniqueStrings(bySymbol.map((item) => item.currency));
  const available = bySymbol.filter((item) => item.linkedRoundTripGrossPnl != null);
  const aggregateAvailable = currencies.length === 1 && available.length === bySymbol.length;
  const inventoryVerified = bySymbol.every((item) => item.startingInventoryEvidence?.status === "verified_zero");
  return {
    status: aggregateAvailable && inventoryVerified ? "available" : available.length ? "partial" : "unavailable",
    linkedRoundTripGrossPnl: aggregateAvailable ? round(available.reduce((sum, item) => sum + item.linkedRoundTripGrossPnl, 0)) : null,
    accountRealizedGrossPnl: null,
    currency: aggregateAvailable ? currencies[0] : null,
    netPnl: null,
    reason: aggregateAvailable
      ? inventoryVerified ? null : "starting_inventory_not_proven_zero_linked_round_trip_only"
      : available.length ? "multiple_currencies_or_partial_groups" : "no_closed_fifo_quantity",
    accountRealizedPnlReason: "brokerage_cost_basis_and_complete_account_inventory_unavailable",
    netPnlReason: "execution_fees_and_taxes_unavailable",
    bySymbol,
    coverage,
  };
}

export function selectCompletedCycleCandles(candles, { symbol, startAt, endAt, timezone } = {}) {
  const startDate = zonedDateKey(startAt, timezone);
  const endDate = zonedDateKey(endAt, timezone);
  if (!startDate || !endDate) return [];
  const values = (Array.isArray(candles) ? candles : [])
    .filter(validBar)
    .filter((bar) => String(bar.tradeDate ?? "") >= startDate && String(bar.tradeDate ?? "") <= endDate)
    .sort((left, right) => String(left.tradeDate).localeCompare(String(right.tradeDate)));
  if (!values.length) return [];
  const last = values.at(-1);
  if (last?.isClosed === false) values.pop();
  else if (last?.isClosed !== true) {
    // The technical engine is the existing authority for whether an unstamped
    // daily bar was actually complete at the exact cycle end instant.
    const analysis = classifyBarAt(last, { symbol, endAt });
    if (analysis !== "CLOSED") values.pop();
  }
  return values;
}

export function calculatePricePathMetrics({ symbol, candles = [], startAt, endAt } = {}) {
  if (candles.length < 2) return unavailablePath(symbol, "fewer_than_two_completed_daily_bars", candles.length);
  const first = candles[0];
  const last = candles.at(-1);
  const reference = Number(first.close);
  if (!Number.isFinite(reference) || reference <= 0) return unavailablePath(symbol, "invalid_reference_close", candles.length);
  const highest = Math.max(...candles.map((bar) => Number(bar.high)));
  const lowest = Math.min(...candles.map((bar) => Number(bar.low)));
  return {
    symbol,
    status: "available",
    reason: null,
    eligibleBarCount: candles.length,
    startAt: optionalIso(startAt),
    endAt: optionalIso(endAt),
    firstTradeDate: first.tradeDate,
    lastTradeDate: last.tradeDate,
    firstClose: round(reference),
    lastClose: round(Number(last.close)),
    periodReturnPercent: round(((Number(last.close) / reference) - 1) * 100),
    priceMfePercent: round(Math.max(0, ((highest / reference) - 1) * 100)),
    priceMaePercent: round(Math.min(0, ((lowest / reference) - 1) * 100)),
    excursionOrientation: "long_price_path",
    excursionLimitation: "Daily-bar price path from first eligible close; not position-sized, fill-time, or R-multiple trade MAE/MFE.",
  };
}

// Imported lazily to keep this module's deterministic calculator easy to test
// without duplicating the existing market-session close rules.
import { classifyLastDailyBar } from "../engine/technical.mjs";

function classifyBarAt(bar, { symbol, endAt }) {
  return classifyLastDailyBar(bar, { symbol, analysisTime: endAt })?.status;
}

function selectedPathActivitiesAsExecutions(tradePricePath) {
  return (Array.isArray(tradePricePath?.activities) ? tradePricePath.activities : []).map((item) => ({
    tradeId: item.id,
    orderId: item.orderId,
    symbol: item.symbol,
    side: item.side,
    quantity: item.quantity,
    price: item.price,
    currency: item.currency,
    doneAt: item.at,
  }));
}

function normalizeLoadedCandles(value) {
  if (Array.isArray(value)) return { candles: value, coverage: null };
  if (value && Array.isArray(value.candles)) {
    return {
      candles: value.candles,
      coverage: value.coverage && typeof value.coverage === "object" ? value.coverage : null,
    };
  }
  throw new Error("历史行情读取结果缺少日线数组。");
}

function compactCandleCoverage(value) {
  if (!value || typeof value !== "object") return null;
  return {
    source: String(value.source ?? "unknown").slice(0, 80),
    originSource: value.originSource == null ? null : String(value.originSource).slice(0, 80),
    coverageStatus: String(value.coverageStatus ?? "unknown").slice(0, 40),
    partial: value.partial === true || value.coverageStatus === "partial",
    partialReasons: uniqueStrings(value.partialReasons).slice(0, 20),
    fetchedAt: optionalIso(value.fetchedAt),
    storedAt: optionalIso(value.storedAt),
    cacheAgeMs: finiteOrNull(value.cacheAgeMs),
    requestedCount: finiteOrNull(value.requestedCount),
    returnedCount: finiteOrNull(value.returnedCount),
    latestTradeDate: /^\d{4}-\d{2}-\d{2}$/.test(String(value.latestTradeDate ?? ""))
      ? String(value.latestTradeDate)
      : null,
    endpoint: String(value.endpoint ?? "").slice(0, 300) || null,
    period: String(value.period ?? "").slice(0, 40) || null,
    adjustment: String(value.adjustment ?? "").slice(0, 40) || null,
    tradeSessions: String(value.tradeSessions ?? "").slice(0, 80) || null,
    refreshAttempted: value.refreshAttempted === true,
    fallbackReason: value.fallbackReason == null ? null : String(value.fallbackReason).slice(0, 300),
    persistenceStatus: value.persistenceStatus == null ? null : String(value.persistenceStatus).slice(0, 80),
  };
}

function compactPathCoverage(value) {
  if (!value || typeof value !== "object") return null;
  return {
    status: value.status ?? null,
    eligibleBarCount: finiteOrNull(value.eligibleBarCount),
    fullSessionExcursionBarCount: finiteOrNull(value.fullSessionExcursionBarCount),
    candleAdjustType: value.candleAdjustType ?? null,
    executionPriceBasis: value.executionPriceBasis ?? null,
    basisMismatch: value.basisMismatch === true,
    timezone: value.timezone ?? null,
    reasons: uniqueStrings(value.reasons).slice(0, 30),
    limitations: uniqueStrings(value.limitations).slice(0, 20),
  };
}

function projectBoundedSequence(values, maximum) {
  const source = Array.isArray(values) ? values : [];
  const limit = Math.max(2, Math.min(180, Math.trunc(Number(maximum) || 72)));
  if (source.length <= limit) return { items: source, omittedCount: 0 };
  const headCount = Math.ceil(limit / 2);
  const tailCount = limit - headCount;
  return {
    items: [
      ...source.slice(0, headCount),
      { omittedCount: source.length - limit },
      ...source.slice(-tailCount),
    ],
    omittedCount: source.length - limit,
  };
}

function normalizeExecutionForPnl(value) {
  // Defense in depth: the history normalizer already nulls semantically
  // unverified equity prices, but a future caller must not be able to restore
  // the raw reported number while retaining its exclusion audit.
  if (String(value?.priceAudit?.status ?? "").toLowerCase() === "excluded") return null;
  const sideText = String(value?.side ?? "").trim().toLowerCase();
  const side = sideText.includes("buy") || sideText === "b" ? "buy"
    : sideText.includes("sell") || sideText === "s" ? "sell"
      : null;
  const symbol = normalizeSymbol(value?.symbol);
  const quantity = Number(value?.quantity);
  const price = Number(value?.price);
  const doneAt = optionalIso(value?.doneAt);
  const currency = String(value?.currency ?? inferCurrency(symbol) ?? "").trim().toUpperCase() || null;
  if (!side || !symbol || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0 || !doneAt || !currency) return null;
  return { side, symbol, quantity, price, doneAt, currency };
}

function inferCurrency(symbol) {
  if (symbol?.endsWith(".US")) return "USD";
  if (symbol?.endsWith(".HK")) return "HKD";
  if (symbol?.endsWith(".SG")) return "SGD";
  if (symbol?.endsWith(".CN") || symbol?.endsWith(".SH") || symbol?.endsWith(".SZ")) return "CNY";
  return null;
}

function unavailableExecutionPnl(reason, coverage = {}, bySymbol = []) {
  return {
    status: "unavailable",
    linkedRoundTripGrossPnl: null,
    accountRealizedGrossPnl: null,
    currency: null,
    netPnl: null,
    reason,
    accountRealizedPnlReason: "brokerage_cost_basis_and_complete_account_inventory_unavailable",
    netPnlReason: "execution_fees_and_taxes_unavailable",
    bySymbol,
    coverage,
  };
}

function startingInventoryEvidence(value, symbol, cycleStartAt) {
  const snapshotAt = optionalIso(value?.snapshotAt ?? value?.syncedAt);
  const snapshotMs = Date.parse(String(snapshotAt ?? ""));
  const startMs = Date.parse(String(cycleStartAt ?? ""));
  if (!value || !snapshotAt || !Number.isFinite(startMs) || snapshotMs > startMs || !Array.isArray(value?.positions)) {
    return { status: "unknown", snapshotAt, quantity: null, reason: "eligible_starting_portfolio_snapshot_unavailable" };
  }
  const matching = value.positions.filter((item) => normalizeSymbol(item?.symbol) === symbol);
  const quantities = matching.map((item) => Number(item?.quantity));
  if (quantities.some((quantity) => !Number.isFinite(quantity))) {
    return { status: "unknown", snapshotAt, quantity: null, reason: "starting_quantity_invalid" };
  }
  const quantity = round(quantities.reduce((sum, item) => sum + item, 0), 6);
  return quantity === 0
    ? { status: "verified_zero", snapshotAt, quantity, reason: null }
    : { status: "nonzero", snapshotAt, quantity, reason: "starting_inventory_present_cost_basis_unknown" };
}

function unavailablePath(symbol, reason, eligibleBarCount = 0) {
  return {
    symbol: symbol ?? null,
    status: "unavailable",
    reason,
    eligibleBarCount,
    firstTradeDate: null,
    lastTradeDate: null,
    firstClose: null,
    lastClose: null,
    periodReturnPercent: null,
    priceMfePercent: null,
    priceMaePercent: null,
  };
}

function aggregatePathStatus(values) {
  const available = values.filter((item) => item?.status === "available").length;
  return available === values.length ? "available" : available ? "partial" : "unavailable";
}

function combineMetricStatus(value) {
  const statuses = [value.executionPnl?.status, value.pricePath?.status];
  if (value.tradePricePath) statuses.push(value.tradePricePath.status);
  const candleEvidenceDegraded = Array.isArray(value.coverage?.candleSources)
    && value.coverage.candleSources.some((item) => item?.partial === true || item?.source === "persistent_fallback");
  value.status = statuses.every((status) => status === "available") && !candleEvidenceDegraded
    ? "available"
    : statuses.some((status) => ["available", "partial"].includes(status))
      ? "partial"
      : "unavailable";
  return value;
}

function validBar(bar) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(bar?.tradeDate ?? ""))
    && [bar?.open, bar?.high, bar?.low, bar?.close].every((value) => Number.isFinite(Number(value)));
}

function inClosedRange(value, startAt, endAt) {
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time)
    && (!startAt || time >= Date.parse(startAt))
    && (!endAt || time <= Date.parse(endAt));
}

function zonedDateKey(value, timezone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: String(timezone || "Asia/Shanghai"),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const part = (type) => parts.find((item) => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function normalizeSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9._:-]{1,40}$/.test(symbol) ? symbol : null;
}

function optionalIso(value) {
  if (value == null || value === "") return null;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function cleanReason(error) {
  return String(error?.message ?? error ?? "unknown_error").replace(/\s+/g, " ").trim().slice(0, 300) || "unknown_error";
}

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
