const DEFAULT_DAILY_BAR_LIMIT = 3;
const DEFAULT_SEGMENT_TRADING_DAYS = 3;
const EPSILON = 1e-10;

const MARKET_SESSIONS = {
  US: { timeZone: "America/New_York", openMinute: 9 * 60 + 30, closeMinute: 16 * 60 },
  HK: { timeZone: "Asia/Hong_Kong", openMinute: 9 * 60 + 30, closeMinute: 16 * 60 },
  CN: { timeZone: "Asia/Shanghai", openMinute: 9 * 60 + 30, closeMinute: 15 * 60 },
  SH: { timeZone: "Asia/Shanghai", openMinute: 9 * 60 + 30, closeMinute: 15 * 60 },
  SZ: { timeZone: "Asia/Shanghai", openMinute: 9 * 60 + 30, closeMinute: 15 * 60 },
  SG: { timeZone: "Asia/Singapore", openMinute: 9 * 60, closeMinute: 17 * 60 },
};

export function exchangeTimezoneForSymbol(symbol, fallbackTimezone = null) {
  return resolveSession({
    market: marketFromSymbol(normalizeSymbol(symbol)),
    timezone: fallbackTimezone,
  }).timeZone;
}

/**
 * Derive an execution-only window without throwing.
 *
 * Two call forms are supported:
 * - Pass selectedOrders/selectedExecutions when the caller has already built
 *   the explicit evidence set.
 * - Pass selectedOrderIds/selectedExecutionIds plus archive orders/executions.
 *   Selecting an order expands to every archived fill for that order;
 *   selecting one fill includes only that fill. A parent order used to enrich
 *   a selected fill and its unselected sibling fills are evidence-only.
 *
 * submittedAt is never an activity boundary.
 */
export function deriveSelectedBuySellWindow({
  selectedOrders = null,
  selectedExecutions = null,
  selectedOrderIds = null,
  selectedExecutionIds = null,
  orders = [],
  executions = [],
} = {}) {
  const resolved = Array.isArray(selectedOrderIds) || Array.isArray(selectedExecutionIds)
    ? resolveExplicitSelection({ selectedOrderIds, selectedExecutionIds, orders, executions })
    : {
        selectedOrders: Array.isArray(selectedOrders) ? selectedOrders : [],
        selectedExecutions: Array.isArray(selectedExecutions) ? selectedExecutions : [],
        allowOrderFallback: true,
        error: Array.isArray(selectedOrders) && Array.isArray(selectedExecutions)
          ? null
          : "selected_records_must_be_arrays",
        missingOrderIds: [],
        missingExecutionIds: [],
      };
  const coverage = {
    selectedOnly: true,
    selectedOrderCount: resolved.selectedOrders.length,
    selectedExecutionCount: resolved.selectedExecutions.length,
    missingOrderIds: resolved.missingOrderIds,
    missingExecutionIds: resolved.missingExecutionIds,
    selectionExpansion: "selected order -> all archived fills; selected fill -> only that fill",
    submittedAtUsed: false,
  };
  if (resolved.error) return unavailableWindow(resolved.error, coverage);
  const normalized = normalizeSelectedActivities({
    selectedOrders: resolved.selectedOrders,
    selectedExecutions: resolved.selectedExecutions,
    allowOrderFallback: resolved.allowOrderFallback,
  });
  if (normalized.error) return unavailableWindow(normalized.error, coverage);
  const activities = [...normalized.activities].sort(compareActivities);
  coverage.activityCount = activities.length;
  const symbols = unique(activities.map((item) => item.symbol));
  const currencies = unique(activities.map((item) => item.currency));
  const contractMultipliers = unique(activities.map((item) => item.contractMultiplier));
  if (!activities.length) return unavailableWindow("no_executed_activity_in_selected_records", coverage);
  if (symbols.length !== 1) return unavailableWindow("selected_activities_must_have_one_symbol", coverage, activities);
  if (currencies.length !== 1) return unavailableWindow("selected_activities_must_have_one_currency", coverage, activities);
  if (contractMultipliers.length !== 1) {
    return unavailableWindow("option_contract_multiplier_conflict", coverage, activities);
  }
  const ambiguousAt = opposingSidesAtSameInstant(activities);
  if (ambiguousAt) return unavailableWindow("ambiguous_buy_sell_order_at_same_timestamp", coverage, activities);
  const buys = activities.filter((item) => item.side === "buy");
  const sells = activities.filter((item) => item.side === "sell");
  if (!buys.length) return unavailableWindow("selected_buy_activity_missing", coverage, activities);
  if (!sells.length) return unavailableWindow("selected_sell_activity_missing", coverage, activities);
  const windowStartAt = buys[0].at;
  const windowEndAt = sells.at(-1).at;
  const outsideWindow = activities.find((item) => item.at < windowStartAt || item.at > windowEndAt);
  if (outsideWindow) return unavailableWindow("selected_activity_outside_buy_sell_window", coverage, activities);
  return {
    status: "available",
    reason: null,
    symbol: symbols[0],
    currency: currencies[0],
    windowStartAt,
    windowEndAt,
    startActivityId: buys[0].id,
    endActivityId: sells.at(-1).id,
    activities: activities.map(publicActivity),
    coverage,
  };
}

/**
 * Deterministically describe the price path for an explicitly selected set of
 * broker records. This function never searches account history or infers an
 * earlier position. Its outer window is always:
 *
 *   earliest selected Buy activity -> latest selected Sell activity
 *
 * Selected executions are authoritative. A selected order is used as one
 * aggregate fill only when none of its executions was explicitly selected.
 */
export function buildReviewTradePricePath({
  selectedOrders = [],
  selectedExecutions = [],
  selectedOrderIds = null,
  selectedExecutionIds = null,
  orders = [],
  executions = [],
  candles = [],
  asOf = null,
  timezone = null,
  dailyBarLimit = DEFAULT_DAILY_BAR_LIMIT,
  segmentTradingDays = DEFAULT_SEGMENT_TRADING_DAYS,
} = {}) {
  const base = emptyResult({ selectedOrders, selectedExecutions, candles });
  const resolved = Array.isArray(selectedOrderIds) || Array.isArray(selectedExecutionIds)
    ? resolveExplicitSelection({ selectedOrderIds, selectedExecutionIds, orders, executions })
    : { selectedOrders, selectedExecutions, allowOrderFallback: true, error: null, missingOrderIds: [], missingExecutionIds: [] };
  if (Array.isArray(selectedOrderIds) || Array.isArray(selectedExecutionIds)) {
    base.coverage.selectedOrderCount = (selectedOrderIds ?? []).length;
    base.coverage.selectedExecutionCount = (selectedExecutionIds ?? []).length;
    base.coverage.selectionExpansion = "selected order -> all archived fills; selected fill -> only that fill";
  }
  if (resolved.error) {
    base.coverage.missingOrderIds = resolved.missingOrderIds;
    base.coverage.missingExecutionIds = resolved.missingExecutionIds;
    return fail(base, resolved.error);
  }
  const selected = normalizeSelectedActivities({
    selectedOrders: resolved.selectedOrders,
    selectedExecutions: resolved.selectedExecutions,
    allowOrderFallback: resolved.allowOrderFallback,
  });
  base.coverage.ignoredUnfilledOrderCount = selected.ignoredUnfilledOrderCount;
  base.coverage.orderFallbackActivityCount = selected.orderFallbackActivityCount;
  base.coverage.executionActivityCount = selected.executionActivityCount;
  base.coverage.parentOrdersRepresentedBySelectedExecutions = selected.parentOrdersRepresentedBySelectedExecutions;
  base.coverage.reasons.push(...selected.warnings);
  if (selected.error) return fail(base, selected.error, selected.activities);

  const activities = [...selected.activities].sort(compareActivities);
  base.activities = activities.map(publicActivity);
  base.coverage.activityCount = activities.length;
  if (!activities.length) return fail(base, "no_executed_activity_in_selected_records");

  const symbols = unique(activities.map((item) => item.symbol));
  const currencies = unique(activities.map((item) => item.currency));
  const contractMultipliers = unique(activities.map((item) => item.contractMultiplier));
  if (symbols.length !== 1) return fail(base, "selected_activities_must_have_one_symbol");
  if (currencies.length !== 1) return fail(base, "selected_activities_must_have_one_currency");
  if (contractMultipliers.length !== 1) return fail(base, "option_contract_multiplier_conflict");
  const symbol = symbols[0];
  const currency = currencies[0];
  base.symbol = symbol;
  base.currency = currency;

  const ambiguousAt = opposingSidesAtSameInstant(activities);
  if (ambiguousAt) return fail(base, "ambiguous_buy_sell_order_at_same_timestamp", activities, { ambiguousAt });

  const buys = activities.filter((item) => item.side === "buy");
  const sells = activities.filter((item) => item.side === "sell");
  const matched = matchLongLots(activities);
  base.lots = matched.lots.map(publicLot);
  base.positionStatus = matched.positionStatus;
  if (matched.error) return fail(base, matched.error, activities, matched.details);
  if (!buys.length) return fail(base, "selected_buy_activity_missing", activities);
  if (!sells.length) return fail(base, "selected_sell_activity_missing", activities);

  const startAt = buys[0].at;
  const endAt = sells.at(-1).at;
  base.window = {
    startAt,
    endAt,
    startActivityId: buys[0].id,
    endActivityId: sells.at(-1).id,
    boundaryPolicy: "earliest_selected_buy_to_latest_selected_sell",
  };
  const outsideWindow = activities.find((item) => item.at < startAt || item.at > endAt);
  if (outsideWindow) {
    return fail(base, "selected_activity_outside_buy_sell_window", activities, {
      activityId: outsideWindow.id,
    });
  }

  const asOfIso = optionalIso(asOf);
  if (asOf != null && !asOfIso) return fail(base, "as_of_invalid", activities);
  if (asOfIso && activities.some((item) => item.at > asOfIso)) {
    return fail(base, "selected_activity_after_as_of", activities);
  }
  base.coverage.asOf = asOfIso ?? endAt;

  const normalizedBars = normalizeDailyBars(candles, symbol);
  if (normalizedBars.error) {
    base.pricePath = unavailablePath(normalizedBars.error);
    base.cycles = matched.cycles.map((cycle) => publicCycle(cycle, unavailablePath(normalizedBars.error)));
    base.metrics = tradeMetrics(matched, currency, activities);
    base.coverage.reasons.push(normalizedBars.error);
    return finish(base, matched, false);
  }

  const market = marketFromSymbol(symbol);
  const session = resolveSession({ market, timezone });
  base.coverage.market = market;
  base.coverage.timezone = session.timeZone;
  const pathOptions = {
    bars: normalizedBars.bars,
    session,
    dailyBarLimit: positiveInteger(dailyBarLimit, DEFAULT_DAILY_BAR_LIMIT),
    segmentTradingDays: positiveInteger(segmentTradingDays, DEFAULT_SEGMENT_TRADING_DAYS),
  };
  const overallEntry = buys[0];
  const overallExit = sells.at(-1);
  base.pricePath = calculatePath({ entry: overallEntry, exit: overallExit, ...pathOptions });
  base.coverage.eligibleBarCount = base.pricePath.coverage.eligibleBarCount;
  base.coverage.excludedBeforeWindowCount = base.pricePath.coverage.excludedBeforeWindowCount;
  base.coverage.excludedAfterWindowCount = base.pricePath.coverage.excludedAfterWindowCount;
  base.coverage.excludedFormingBarCount = base.pricePath.coverage.excludedFormingBarCount;
  base.coverage.excludedOutsideHoldingCloseCount = base.pricePath.coverage.excludedOutsideHoldingCloseCount;
  base.coverage.futureBarExcluded = base.pricePath.coverage.futureBarExcluded;
  base.coverage.reasons.push(...base.pricePath.coverage.reasons);

  base.cycles = matched.cycles.map((cycle) => publicCycle(
    cycle,
    calculatePath({ entry: cycle.buy, exit: cycle.sell, ...pathOptions }),
  ));
  base.metrics = tradeMetrics(matched, currency, activities);
  return finish(base, matched, base.pricePath.status !== "unavailable");
}

function normalizeSelectedActivities({ selectedOrders, selectedExecutions, allowOrderFallback = true }) {
  const result = {
    activities: [],
    error: null,
    warnings: [],
    ignoredUnfilledOrderCount: 0,
    orderFallbackActivityCount: 0,
    executionActivityCount: 0,
    parentOrdersRepresentedBySelectedExecutions: 0,
  };
  if (!Array.isArray(selectedOrders) || !Array.isArray(selectedExecutions)) {
    result.error = "selected_records_must_be_arrays";
    return result;
  }

  const orderById = new Map();
  for (const value of selectedOrders) {
    const orderId = cleanId(value?.orderId);
    if (!orderId) return { ...result, error: "selected_order_id_missing" };
    if (orderById.has(orderId)) return { ...result, error: "duplicate_selected_order_id" };
    orderById.set(orderId, value);
  }

  const executionIds = new Set();
  const selectedExecutionOrderIds = new Set();
  for (const value of selectedExecutions) {
    const tradeId = cleanId(value?.tradeId);
    if (!tradeId) return { ...result, error: "selected_execution_id_missing" };
    if (executionIds.has(tradeId)) return { ...result, error: "duplicate_selected_execution_id" };
    executionIds.add(tradeId);
    const orderId = cleanId(value?.orderId);
    const parent = orderId ? orderById.get(orderId) : null;
    if (parent && parentConflict(value, parent)) {
      return { ...result, error: "selected_execution_parent_order_conflict" };
    }
    if (String(value?.priceAudit?.status ?? "").toLowerCase() === "excluded") {
      return { ...result, error: "selected_execution_price_excluded" };
    }
    const activitySymbol = value?.symbol ?? parent?.symbol;
    const activityContractMultiplier = value?.contractMultiplier ?? parent?.contractMultiplier;
    if (isOptionSymbol(activitySymbol) && finitePositive(activityContractMultiplier) == null) {
      return { ...result, error: "option_contract_multiplier_unavailable" };
    }
    const activity = normalizeActivity({
      id: `execution:${tradeId}`,
      source: "execution",
      orderId,
      symbol: activitySymbol,
      side: value?.side ?? parent?.side,
      quantity: value?.quantity,
      price: value?.price,
      currency: value?.currency ?? parent?.currency,
      contractMultiplier: activityContractMultiplier,
      at: value?.doneAt,
      sequence: value?.sequence,
    });
    if (!activity) return { ...result, error: "selected_execution_fields_incomplete" };
    result.activities.push(activity);
    result.executionActivityCount += 1;
    if (orderId) selectedExecutionOrderIds.add(orderId);
  }

  for (const [orderId, value] of orderById) {
    if (selectedExecutionOrderIds.has(orderId)) {
      result.parentOrdersRepresentedBySelectedExecutions += 1;
      continue;
    }
    if (!allowOrderFallback) {
      result.ignoredUnfilledOrderCount += 1;
      continue;
    }
    const quantity = finitePositive(value?.executedQuantity);
    const filledStatus = /fill|execut/i.test(String(value?.status ?? ""));
    if (quantity == null) {
      if (filledStatus) return { ...result, error: "selected_filled_order_quantity_missing" };
      result.ignoredUnfilledOrderCount += 1;
      continue;
    }
    if (isOptionSymbol(value?.symbol) && finitePositive(value?.contractMultiplier) == null) {
      return { ...result, error: "option_contract_multiplier_unavailable" };
    }
    const activity = normalizeActivity({
      id: `order:${orderId}`,
      source: "order_aggregate",
      orderId,
      symbol: value?.symbol,
      side: value?.side,
      quantity,
      price: value?.executedPrice,
      currency: value?.currency,
      contractMultiplier: value?.contractMultiplier,
      // submittedAt is intentionally not a fill timestamp.
      at: value?.executedAt ?? value?.doneAt ?? value?.updatedAt,
      sequence: value?.sequence,
    });
    if (!activity) return { ...result, error: "selected_executed_order_fields_incomplete" };
    result.activities.push(activity);
    result.orderFallbackActivityCount += 1;
  }
  if (result.orderFallbackActivityCount) result.warnings.push("aggregate_order_fallback_used");
  return result;
}

function resolveExplicitSelection({ selectedOrderIds, selectedExecutionIds, orders, executions }) {
  if (!Array.isArray(selectedOrderIds ?? []) || !Array.isArray(selectedExecutionIds ?? [])
    || !Array.isArray(orders) || !Array.isArray(executions)) {
    return selectionResolutionError("selection_archive_fields_must_be_arrays");
  }
  const normalizedOrderIds = (selectedOrderIds ?? []).map(cleanId);
  const normalizedExecutionIds = (selectedExecutionIds ?? []).map(cleanId);
  if (normalizedOrderIds.some((id) => !id) || normalizedExecutionIds.some((id) => !id)) {
    return selectionResolutionError("selected_broker_id_invalid");
  }
  const explicitOrderIds = new Set(normalizedOrderIds);
  const explicitExecutionIds = new Set(normalizedExecutionIds);
  const orderById = new Map(orders.map((item) => [cleanId(item?.orderId), item]).filter(([id]) => id));
  const executionById = new Map(executions.map((item) => [cleanId(item?.tradeId), item]).filter(([id]) => id));
  const missingOrderIds = [...explicitOrderIds].filter((id) => !orderById.has(id));
  const missingExecutionIds = [...explicitExecutionIds].filter((id) => !executionById.has(id));
  if (missingOrderIds.length || missingExecutionIds.length) {
    return {
      ...selectionResolutionError("selected_broker_records_missing"),
      missingOrderIds,
      missingExecutionIds,
    };
  }
  const effectiveExecutions = executions.filter((item) => {
    const tradeId = cleanId(item?.tradeId);
    const orderId = cleanId(item?.orderId);
    return explicitExecutionIds.has(tradeId) || explicitOrderIds.has(orderId);
  });
  const parentOrderIds = new Set(effectiveExecutions.map((item) => cleanId(item?.orderId)).filter(Boolean));
  const effectiveOrders = orders.filter((item) => {
    const orderId = cleanId(item?.orderId);
    return explicitOrderIds.has(orderId) || parentOrderIds.has(orderId);
  });
  return {
    selectedOrders: effectiveOrders,
    selectedExecutions: effectiveExecutions,
    // In id-selection mode a submitted/updated aggregate order is evidence,
    // never a substitute for the archived fills that define the window.
    allowOrderFallback: false,
    error: null,
    missingOrderIds,
    missingExecutionIds,
  };
}

function selectionResolutionError(error) {
  return {
    selectedOrders: [],
    selectedExecutions: [],
    allowOrderFallback: false,
    error,
    missingOrderIds: [],
    missingExecutionIds: [],
  };
}

function unavailableWindow(reason, coverage, activities = []) {
  return {
    status: "unavailable",
    reason,
    symbol: null,
    currency: null,
    windowStartAt: null,
    windowEndAt: null,
    startActivityId: null,
    endActivityId: null,
    activities: activities.map(publicActivity),
    coverage,
  };
}

function normalizeActivity({
  id,
  source,
  orderId,
  symbol,
  side,
  quantity,
  price,
  currency,
  contractMultiplier,
  at,
  sequence,
}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedSide = normalizeSide(side);
  const normalizedQuantity = finitePositive(quantity);
  const normalizedPrice = finitePositive(price);
  const normalizedAt = optionalIso(at);
  const normalizedCurrency = normalizeCurrency(currency) ?? inferCurrency(normalizedSymbol);
  const normalizedContractMultiplier = isOptionSymbol(normalizedSymbol)
    ? finitePositive(contractMultiplier)
    : 1;
  if (!id || !normalizedSymbol || !normalizedSide || normalizedQuantity == null
    || normalizedPrice == null || !normalizedAt || !normalizedCurrency
    || normalizedContractMultiplier == null) return null;
  return {
    id,
    source,
    orderId: orderId ?? null,
    symbol: normalizedSymbol,
    side: normalizedSide,
    quantity: normalizedQuantity,
    price: normalizedPrice,
    currency: normalizedCurrency,
    contractMultiplier: normalizedContractMultiplier,
    at: normalizedAt,
    sequence: finiteNumberOrNull(sequence),
  };
}

function parentConflict(value, parent) {
  const ownSymbol = normalizeSymbol(value?.symbol);
  const parentSymbol = normalizeSymbol(parent?.symbol);
  const ownSide = normalizeSide(value?.side);
  const parentSide = normalizeSide(parent?.side);
  const ownCurrency = normalizeCurrency(value?.currency);
  const parentCurrency = normalizeCurrency(parent?.currency);
  const ownContractMultiplier = finitePositive(value?.contractMultiplier);
  const parentContractMultiplier = finitePositive(parent?.contractMultiplier);
  return Boolean(
    (ownSymbol && parentSymbol && ownSymbol !== parentSymbol)
    || (ownSide && parentSide && ownSide !== parentSide)
    || (ownCurrency && parentCurrency && ownCurrency !== parentCurrency)
    || (ownContractMultiplier != null && parentContractMultiplier != null
      && ownContractMultiplier !== parentContractMultiplier)
  );
}

function compareActivities(left, right) {
  const time = left.at.localeCompare(right.at);
  if (time) return time;
  if (left.sequence != null && right.sequence != null && left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  return left.id.localeCompare(right.id);
}

function opposingSidesAtSameInstant(activities) {
  for (let index = 1; index < activities.length; index += 1) {
    const left = activities[index - 1];
    const right = activities[index];
    if (left.at === right.at && left.side !== right.side
      && (left.sequence == null || right.sequence == null || left.sequence === right.sequence)) return left.at;
  }
  return null;
}

function matchLongLots(activities) {
  const lots = [];
  const openLots = [];
  const cycles = [];
  let realizedGrossPnl = 0;
  let realizedCost = 0;
  let realizedQuantity = 0;
  for (const activity of activities) {
    if (activity.side === "buy") {
      const lot = {
        id: `lot-${lots.length + 1}`,
        buy: activity,
        originalQuantity: activity.quantity,
        matchedQuantity: 0,
        openQuantity: activity.quantity,
        matches: [],
      };
      lots.push(lot);
      openLots.push(lot);
      continue;
    }
    let remaining = activity.quantity;
    while (remaining > EPSILON && openLots.length) {
      const lot = openLots[0];
      const quantity = Math.min(remaining, lot.openQuantity);
      const grossPnl = (activity.price - lot.buy.price)
        * quantity
        * lot.buy.contractMultiplier;
      const cycle = {
        id: `cycle-${cycles.length + 1}`,
        lotId: lot.id,
        buy: lot.buy,
        sell: activity,
        quantity,
        grossPnl,
        returnPercent: ((activity.price / lot.buy.price) - 1) * 100,
      };
      cycles.push(cycle);
      lot.matches.push({
        cycleId: cycle.id,
        sellActivityId: activity.id,
        quantity,
        sellPrice: activity.price,
        sellAt: activity.at,
      });
      lot.matchedQuantity += quantity;
      lot.openQuantity -= quantity;
      realizedGrossPnl += grossPnl;
      realizedCost += lot.buy.price * quantity * lot.buy.contractMultiplier;
      realizedQuantity += quantity;
      remaining -= quantity;
      if (lot.openQuantity <= EPSILON) {
        lot.openQuantity = 0;
        openLots.shift();
      }
    }
    if (remaining > EPSILON) {
      return {
        lots,
        cycles,
        error: "selected_sell_requires_unselected_or_starting_inventory",
        details: { sellActivityId: activity.id, unmatchedQuantity: round(remaining, 8) },
        positionStatus: "unavailable",
      };
    }
  }
  const openQuantity = lots.reduce((sum, lot) => sum + lot.openQuantity, 0);
  return {
    lots,
    cycles,
    error: null,
    realizedGrossPnl,
    realizedCost,
    realizedQuantity,
    openQuantity,
    positionStatus: realizedQuantity > EPSILON
      ? openQuantity > EPSILON ? "partially_closed" : "closed"
      : openQuantity > EPSILON ? "open" : "empty",
  };
}

function normalizeDailyBars(candles, symbol) {
  if (!Array.isArray(candles)) return { error: "candles_must_be_an_array", bars: [] };
  const bars = [];
  let previousDate = null;
  for (const value of candles) {
    const tradeDate = String(value?.tradeDate ?? "").trim();
    const barSymbol = value?.symbol == null ? null : normalizeSymbol(value.symbol);
    const open = finitePositive(value?.open);
    const high = finitePositive(value?.high);
    const low = finitePositive(value?.low);
    const close = finitePositive(value?.close);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)
      || [open, high, low, close].some((item) => item == null)
      || high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
      return { error: "daily_candle_fields_invalid", bars: [] };
    }
    if (barSymbol && barSymbol !== symbol) return { error: "daily_candle_symbol_mismatch", bars: [] };
    if (previousDate && tradeDate <= previousDate) {
      return { error: tradeDate === previousDate ? "daily_candles_duplicate_trade_date" : "daily_candles_not_ascending", bars: [] };
    }
    previousDate = tradeDate;
    bars.push({ tradeDate, open, high, low, close, isClosed: value?.isClosed });
  }
  return { error: null, bars };
}

function calculatePath({ entry, exit, bars, session, dailyBarLimit, segmentTradingDays }) {
  const start = localClock(entry.at, session.timeZone);
  const end = localClock(exit.at, session.timeZone);
  const coverage = {
    status: "unavailable",
    eligibleBarCount: 0,
    fullSessionExcursionBarCount: 0,
    excludedBeforeWindowCount: 0,
    excludedAfterWindowCount: 0,
    excludedFormingBarCount: 0,
    excludedOutsideHoldingCloseCount: 0,
    futureBarExcluded: false,
    candleAdjustType: "forward",
    executionPriceBasis: "raw_fill",
    basisMismatch: true,
    entryTradeDateCovered: false,
    exitTradeDateCovered: false,
    reasons: [],
    limitations: [
      "Daily closes are used for trend compression; intraday ordering inside a daily bar is not inferred.",
      "MAE/MFE use eligible adjusted closes, and adjusted high/low only for sessions held from open through close.",
      "Forward-adjusted candles and raw execution prices are different bases; no fill price is compared with candle OHLC.",
    ],
  };
  const eligible = [];
  for (const bar of bars) {
    if (bar.tradeDate < start.date) {
      coverage.excludedBeforeWindowCount += 1;
      continue;
    }
    if (bar.tradeDate > end.date) {
      coverage.excludedAfterWindowCount += 1;
      coverage.futureBarExcluded = true;
      continue;
    }
    if (bar.isClosed === false) {
      coverage.excludedFormingBarCount += 1;
      continue;
    }
    if (!closeOccursWithinHolding(bar.tradeDate, start, end, session)) {
      coverage.excludedOutsideHoldingCloseCount += 1;
      if (bar.tradeDate === end.date) coverage.futureBarExcluded = true;
      continue;
    }
    eligible.push({
      ...bar,
      fullSessionHeld: fullSessionHeld(bar.tradeDate, start, end, session),
    });
  }
  coverage.eligibleBarCount = eligible.length;
  coverage.fullSessionExcursionBarCount = eligible.filter((bar) => bar.fullSessionHeld).length;
  coverage.entryTradeDateCovered = eligible.some((bar) => bar.tradeDate === start.date);
  coverage.exitTradeDateCovered = eligible.some((bar) => bar.tradeDate === end.date);
  if (!eligible.length) coverage.reasons.push("no_completed_daily_close_inside_holding_window");
  if (!coverage.entryTradeDateCovered) coverage.reasons.push("entry_trade_date_close_not_covered");
  if (!coverage.exitTradeDateCovered) coverage.reasons.push("exit_trade_date_close_not_covered_without_future_data");

  const referenceClose = eligible[0]?.close ?? null;
  const excursionHighs = [];
  const excursionLows = [];
  for (const bar of eligible) {
    excursionHighs.push(bar.close);
    excursionLows.push(bar.close);
    if (bar.fullSessionHeld) {
      excursionHighs.push(bar.high);
      excursionLows.push(bar.low);
    }
  }
  const granularity = eligible.length > dailyBarLimit ? "3_trading_days" : "daily";
  const groupSize = granularity === "daily" ? 1 : segmentTradingDays;
  const trend = buildTrend(eligible, referenceClose, groupSize, granularity);
  coverage.status = eligible.length
    ? coverage.entryTradeDateCovered && coverage.exitTradeDateCovered ? "available" : "partial"
    : "unavailable";
  return {
    status: coverage.status,
    reason: coverage.status === "unavailable" ? coverage.reasons[0] : null,
    startAt: entry.at,
    endAt: exit.at,
    rawFillEndpoints: {
      entryPrice: round(entry.price),
      exitPrice: round(exit.price),
      fillToFillReturnPercent: round(((exit.price / entry.price) - 1) * 100),
      basis: "raw_execution_fills",
    },
    adjustedReferenceClose: round(referenceClose),
    adjustedLastClose: round(eligible.at(-1)?.close),
    periodReturnPercent: referenceClose == null
      ? null
      : round(((eligible.at(-1).close / referenceClose) - 1) * 100),
    mfePercent: referenceClose == null
      ? null
      : round(((Math.max(...excursionHighs) / referenceClose) - 1) * 100),
    maePercent: referenceClose == null
      ? null
      : round(((Math.min(...excursionLows) / referenceClose) - 1) * 100),
    excursionMethod: "forward-adjusted daily closes + high/low only for fully-held sessions, relative to first eligible adjusted close",
    basisMismatchLimitation: "Raw fill endpoints are reported separately and never compared with forward-adjusted candle OHLC.",
    trend,
    coverage,
  };
}

function buildTrend(bars, referenceClose, groupSize, granularity) {
  const segments = [];
  for (let index = 0; index < bars.length; index += groupSize) {
    const group = bars.slice(index, index + groupSize);
    const first = group[0];
    const last = group.at(-1);
    const highestClose = Math.max(...group.map((bar) => bar.close));
    const lowestClose = Math.min(...group.map((bar) => bar.close));
    segments.push({
      index: segments.length + 1,
      startTradeDate: first.tradeDate,
      endTradeDate: last.tradeDate,
      tradingDayCount: group.length,
      firstClose: round(first.close),
      lastClose: round(last.close),
      highestClose: round(highestClose),
      lowestClose: round(lowestClose),
      closeReturnPercent: round(((last.close / first.close) - 1) * 100),
      returnFromReferenceClosePercent: referenceClose == null
        ? null
        : round(((last.close / referenceClose) - 1) * 100),
      closeRangeFromReferencePercent: referenceClose == null ? null : {
        highPercent: round(((highestClose / referenceClose) - 1) * 100),
        lowPercent: round(((lowestClose / referenceClose) - 1) * 100),
        spanPercent: round(((highestClose - lowestClose) / referenceClose) * 100),
      },
      maxCloseDrawdownPercent: maxCloseDrawdownPercent(group.map((bar) => bar.close), referenceClose),
      direction: direction(first.close, last.close),
    });
  }
  return {
    granularity,
    segmentTradingDays: groupSize,
    segmentCount: segments.length,
    source: "forward-adjusted completed daily closes inside selected holding window",
    segments,
  };
}

function maxCloseDrawdownPercent(closes, referenceClose) {
  if (!Number.isFinite(referenceClose) || referenceClose <= 0 || !closes.length) return null;
  let peak = referenceClose;
  let maximumDrawdown = 0;
  for (const close of closes) {
    peak = Math.max(peak, close);
    maximumDrawdown = Math.min(maximumDrawdown, ((close / peak) - 1) * 100);
  }
  return round(maximumDrawdown);
}

function closeOccursWithinHolding(tradeDate, start, end, session) {
  if (tradeDate < start.date || tradeDate > end.date) return false;
  if (tradeDate === start.date && start.minute > session.closeMinute) return false;
  if (tradeDate === end.date && end.minute < session.closeMinute) return false;
  return true;
}

function fullSessionHeld(tradeDate, start, end, session) {
  if (tradeDate < start.date || tradeDate > end.date) return false;
  if (tradeDate === start.date && start.minute > session.openMinute) return false;
  if (tradeDate === end.date && end.minute < session.closeMinute) return false;
  return true;
}

function publicActivity(item) {
  return {
    id: item.id,
    source: item.source,
    orderId: item.orderId,
    symbol: item.symbol,
    side: item.side,
    quantity: round(item.quantity, 8),
    price: round(item.price, 8),
    currency: item.currency,
    contractMultiplier: item.contractMultiplier,
    at: item.at,
  };
}

function publicLot(lot) {
  const matchedQuantity = round(lot.matchedQuantity, 8);
  const openQuantity = round(lot.openQuantity, 8);
  return {
    id: lot.id,
    buyActivityId: lot.buy.id,
    buyAt: lot.buy.at,
    buyPrice: round(lot.buy.price, 8),
    contractMultiplier: lot.buy.contractMultiplier,
    originalQuantity: round(lot.originalQuantity, 8),
    matchedQuantity,
    openQuantity,
    status: openQuantity <= EPSILON
      ? "closed"
      : matchedQuantity > EPSILON ? "partially_closed" : "open",
    matches: lot.matches.map((item) => ({ ...item, quantity: round(item.quantity, 8), sellPrice: round(item.sellPrice, 8) })),
  };
}

function publicCycle(cycle, pricePath) {
  return {
    id: cycle.id,
    lotId: cycle.lotId,
    buyActivityId: cycle.buy.id,
    sellActivityId: cycle.sell.id,
    startAt: cycle.buy.at,
    endAt: cycle.sell.at,
    quantity: round(cycle.quantity, 8),
    buyPrice: round(cycle.buy.price, 8),
    sellPrice: round(cycle.sell.price, 8),
    contractMultiplier: cycle.buy.contractMultiplier,
    grossPnl: round(cycle.grossPnl),
    returnPercent: round(cycle.returnPercent),
    executionBasis: "raw_execution_fills",
    pricePath,
  };
}

function tradeMetrics(matched, currency, activities = []) {
  const buys = activities.filter((item) => item.side === "buy");
  const sells = activities.filter((item) => item.side === "sell");
  return {
    realizedQuantity: round(matched.realizedQuantity ?? 0, 8),
    openQuantity: round(matched.openQuantity ?? 0, 8),
    linkedSelectionGrossPnl: round(matched.realizedGrossPnl ?? 0),
    realizedReturnPercent: matched.realizedCost > EPSILON
      ? round((matched.realizedGrossPnl / matched.realizedCost) * 100)
      : null,
    currency,
    contractMultiplier: activities[0]?.contractMultiplier ?? null,
    rawBuyVwap: weightedVwap(buys),
    rawSellVwap: weightedVwap(sells),
    executionBasis: "raw_execution_fills",
    accountRealizedPnl: null,
    netPnl: null,
    limitation: "FIFO uses only explicitly selected activities; account inventory, fees, taxes and FX are not inferred.",
  };
}

function emptyResult({ selectedOrders, selectedExecutions, candles }) {
  return {
    schemaVersion: 1,
    status: "unavailable",
    reason: null,
    symbol: null,
    currency: null,
    positionStatus: "unavailable",
    window: null,
    activities: [],
    lots: [],
    cycles: [],
    metrics: {
      realizedQuantity: null,
      openQuantity: null,
      linkedSelectionGrossPnl: null,
      realizedReturnPercent: null,
      currency: null,
      contractMultiplier: null,
      accountRealizedPnl: null,
      netPnl: null,
    },
    pricePath: unavailablePath("not_calculated"),
    coverage: {
      source: "explicitly selected normalized Longbridge records + supplied daily candles",
      selectedOnly: true,
      accountHistoryLookupPerformed: false,
      selectedOrderCount: Array.isArray(selectedOrders) ? selectedOrders.length : null,
      selectedExecutionCount: Array.isArray(selectedExecutions) ? selectedExecutions.length : null,
      inputBarCount: Array.isArray(candles) ? candles.length : null,
      activityCount: 0,
      executionActivityCount: 0,
      orderFallbackActivityCount: 0,
      parentOrdersRepresentedBySelectedExecutions: 0,
      ignoredUnfilledOrderCount: 0,
      eligibleBarCount: 0,
      excludedBeforeWindowCount: 0,
      excludedAfterWindowCount: 0,
      excludedFormingBarCount: 0,
      excludedOutsideHoldingCloseCount: 0,
      futureBarExcluded: false,
      asOf: null,
      market: null,
      timezone: null,
      reasons: [],
    },
    provenance: {
      deterministicHostCalculation: true,
      selectionBoundary: "Only selectedOrders and selectedExecutions are consulted.",
      cycleBoundary: "earliest selected Buy activity -> latest selected Sell activity",
      lotMethod: "FIFO within the explicit selection only",
      futureDataPolicy: "Daily closes after the selected Sell boundary, and the Sell-date close before session close, are excluded.",
      priceBasisPolicy: "Raw fills are used only for selection-local FIFO/VWAP/P&L. Trend and MAE/MFE stay entirely on forward-adjusted candle basis.",
    },
  };
}

function unavailablePath(reason) {
  return {
    status: "unavailable",
    reason,
    startAt: null,
    endAt: null,
    rawFillEndpoints: null,
    adjustedReferenceClose: null,
    adjustedLastClose: null,
    periodReturnPercent: null,
    mfePercent: null,
    maePercent: null,
    trend: {
      granularity: null,
      segmentTradingDays: null,
      segmentCount: 0,
      source: "forward-adjusted completed daily closes inside selected holding window",
      segments: [],
    },
    coverage: {
      status: "unavailable",
      eligibleBarCount: 0,
      reasons: [reason],
      limitations: [],
    },
  };
}

function fail(base, reason, activities = null, details = null) {
  base.status = "unavailable";
  base.reason = reason;
  if (activities) base.activities = activities.map(publicActivity);
  base.coverage.reasons.push(reason);
  if (details) base.coverage.failureDetails = details;
  base.pricePath = unavailablePath(reason);
  return base;
}

function finish(base, matched, hasPath) {
  const completePosition = matched.positionStatus === "closed";
  base.status = completePosition && hasPath && base.pricePath.status === "available" ? "available" : "partial";
  base.reason = completePosition
    ? hasPath ? (base.pricePath.status === "available" ? null : "price_path_coverage_partial") : "daily_price_path_unavailable"
    : matched.positionStatus === "partially_closed" ? "selected_position_remains_open" : "selected_position_not_closed";
  if (base.reason) base.coverage.reasons.push(base.reason);
  base.coverage.reasons = unique(base.coverage.reasons);
  return base;
}

function resolveSession({ market, timezone }) {
  const base = MARKET_SESSIONS[market] ?? { timeZone: "UTC", openMinute: 0, closeMinute: 24 * 60 - 1 };
  // The symbol's exchange timezone owns the trading date. A cycle-level
  // timezone is only a fallback for an unknown market.
  if (MARKET_SESSIONS[market]) return base;
  if (!timezone) return base;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(0));
    return { ...base, timeZone: timezone };
  } catch {
    return base;
  }
}

function weightedVwap(activities) {
  const quantity = activities.reduce((sum, item) => sum + item.quantity, 0);
  if (quantity <= EPSILON) return null;
  return round(activities.reduce((sum, item) => sum + item.price * item.quantity, 0) / quantity, 8);
}

function isOptionSymbol(symbol) {
  const localCode = String(symbol ?? "").trim().toUpperCase().split(".")[0];
  return /\d{6}[CP]\d+$/.test(localCode);
}

function localClock(value, timeZone) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  const hour = Number(part("hour"));
  const minute = Number(part("minute"));
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    minute: hour * 60 + minute,
  };
}

function marketFromSymbol(symbol) {
  const suffix = String(symbol ?? "").split(".").at(-1)?.toUpperCase();
  return MARKET_SESSIONS[suffix] ? suffix : null;
}

function inferCurrency(symbol) {
  const market = marketFromSymbol(symbol);
  return market === "US" ? "USD"
    : market === "HK" ? "HKD"
      : market === "SG" ? "SGD"
        : ["CN", "SH", "SZ"].includes(market) ? "CNY" : null;
}

function normalizeSide(value) {
  const side = String(value ?? "").trim().toLowerCase();
  return side === "buy" || side === "b" ? "buy" : side === "sell" || side === "s" ? "sell" : null;
}

function normalizeSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9._:-]{1,40}$/.test(symbol) ? symbol : null;
}

function normalizeCurrency(value) {
  const currency = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function cleanId(value) {
  const id = String(value ?? "").trim();
  return id && id.length <= 200 ? id : null;
}

function finitePositive(value) {
  const number = finiteNumberOrNull(value);
  if (number == null) return null;
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNumberOrNull(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalIso(value) {
  if (value == null || value === "") return null;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function positiveInteger(value, fallback) {
  const number = finiteNumberOrNull(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function direction(first, last) {
  if (Math.abs(last - first) <= EPSILON) return "flat";
  return last > first ? "up" : "down";
}

function unique(values) {
  return [...new Set(values.filter((value) => value != null && value !== ""))];
}

function round(value, digits = 4) {
  const number = finiteNumberOrNull(value);
  if (number == null) return null;
  const factor = 10 ** digits;
  return Math.round((number + Number.EPSILON) * factor) / factor;
}
