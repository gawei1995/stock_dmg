const STORE_KEY = "brokerTradeHistoryV1";
const SCHEMA_VERSION = 2;
const DEFAULT_LOOKBACK_DAYS = 365;
const MAX_LOOKBACK_DAYS = 730;
const API_WINDOW_DAYS = 90;
const MIN_SPLIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const US_ORDER_PAGE_SIZE = 100;
const MAX_US_ORDER_PAGES = 200;
const ROOT_EXECUTION_SPLIT_THRESHOLD = 100;
const MAX_EXECUTION_SPLIT_DEPTH = 8;
const DEFAULT_INTAKE_LIMIT = 500;
const MAX_INTAKE_LIMIT = 2_000;
const MAX_SELECTED_RECORDS = 2_000;

/**
 * Read-only Longbridge order/execution archive used by the review workspace.
 * It deliberately stores no account identifiers and never exposes brokerage
 * write operations.
 */
export class TradeHistoryService {
  constructor({ longbridge, store, onStatus = () => {} }) {
    this.longbridge = longbridge;
    this.store = store;
    this.onStatus = onStatus;
    this.syncing = null;
    this.eventLookupQueue = Promise.resolve();
  }

  async cached() {
    const value = await this.store.get(STORE_KEY);
    return normalizeArchive(value);
  }

  async intake(options = {}) {
    return buildTradeHistoryIntake(await this.cached(), options);
  }

  async resolveReviewSelection({ recordIds = [], eventCandidateId = null } = {}) {
    return resolveReviewSelection(await this.cached(), { recordIds, eventCandidateId });
  }

  async lookupEventCandidates({ recordIds = [], daysBefore = 45, daysAfter = 45 } = {}) {
    const pending = this.eventLookupQueue.then(() => this.#lookupEventCandidates({
      recordIds,
      daysBefore,
      daysAfter,
    }));
    this.eventLookupQueue = pending.catch(() => {});
    return pending;
  }

  async #lookupEventCandidates({ recordIds, daysBefore, daysAfter }) {
    if (!this.longbridge.connected) {
      throw new Error("长桥尚未连接，无法查询财报事件。");
    }
    if (!this.longbridge.supports("finance_calendar")) {
      return {
        status: "unavailable",
        message: "当前长桥只读授权未开放财报日历；不会根据下单日期猜测财报季度。",
        eventCandidates: [],
      };
    }
    if (this.syncing) await this.syncing;
    const archive = await this.cached();
    const selected = resolveArchivedRecords(archive, recordIds);
    const selectedSpanMs = Date.parse(selected.activityTimes.at(-1)) - Date.parse(selected.activityTimes[0]);
    if (selectedSpanMs > 180 * 24 * 60 * 60 * 1000) {
      throw new Error("所选记录跨越超过 180 天，请缩小为一个财报决策包后再查询事件。");
    }
    const before = clampInteger(daysBefore, 1, 60, 45);
    const after = clampInteger(daysAfter, 1, 60, 45);
    const warnings = [];
    const windows = mergeWindows(selected.activityTimes.map((value) => {
      const time = Date.parse(value);
      return {
        startMs: time - before * 24 * 60 * 60 * 1000,
        endMs: time + after * 24 * 60 * 60 * 1000,
      };
    }));
    const events = await this.#fetchFinanceCalendar(windows, selected.symbols, warnings);
    const retainedEvents = warnings.length
      ? archive.events
      : archive.events.filter((item) => !selected.symbols.has(item.symbol)
        || !windows.some((window) => {
          const eventMs = Date.parse(String(item.eventAt ?? ""));
          return Number.isFinite(eventMs)
            && eventMs >= window.startMs
            && eventMs <= window.endMs;
        }));
    const nextArchive = {
      ...archive,
      capabilities: { ...archive.capabilities, financeCalendar: true },
      warnings: [...new Set([...archive.warnings, ...warnings])].slice(0, 20),
      // A successful narrow refresh replaces cached candidates in that same
      // symbol/window, so a rescheduled earnings event does not remain as a
      // second stale option. On a degraded refresh the old cache is retained.
      events: mergeById([...retainedEvents, ...events], (item) => item.eventId)
        .sort(sortNewest("eventAt"))
        .slice(0, 10_000),
    };
    await this.store.set(STORE_KEY, nextArchive);
    const candidates = financeCandidatesForSelection(nextArchive, selected);
    return {
      status: warnings.length ? "degraded" : "ready",
      message: warnings.length ? warnings.join("；") : null,
      eventCandidates: candidates.map(publicFinanceEvent),
    };
  }

  async sync({ startAt = null, endAt = null, symbol = null } = {}) {
    if (this.syncing) return this.syncing;
    this.syncing = this.#sync({ startAt, endAt, symbol }).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  async #sync({ startAt, endAt, symbol }) {
    if (!this.longbridge.connected) {
      throw new Error("长桥尚未连接，无法同步历史订单与成交。");
    }
    const range = normalizeRange({ startAt, endAt });
    const normalizedSymbol = normalizeSymbol(symbol);
    const warnings = [];
    const capabilities = {
      historyOrders: this.longbridge.supports("history_orders"),
      historyExecutions: this.longbridge.supports("history_executions"),
      todayOrders: this.longbridge.supports("today_orders"),
      todayExecutions: this.longbridge.supports("today_executions"),
      financeCalendar: this.longbridge.supports("finance_calendar"),
    };
    if (!capabilities.historyOrders && !capabilities.historyExecutions) {
      throw new Error("当前长桥授权未暴露历史订单或历史成交查询；请重新授权查询权限。");
    }

    this.onStatus({
      state: "syncing",
      phase: "trade_history",
      message: "正在只读同步长桥历史订单与成交",
    });

    const orderFetch = emptyFetchDiagnostics();
    const executionFetch = emptyFetchDiagnostics();
    const historicalOrders = capabilities.historyOrders
      ? await this.#fetchWindows("history_orders", range, normalizedSymbol, "orders", warnings, orderFetch)
      : [];
    const historicalExecutions = capabilities.historyExecutions
      ? await this.#fetchWindows("history_executions", range, normalizedSymbol, "trades", warnings, executionFetch)
      : [];
    const enabledHistoricalFetches = [
      capabilities.historyOrders ? orderFetch : null,
      capabilities.historyExecutions ? executionFetch : null,
    ].filter(Boolean);
    if (enabledHistoricalFetches.length
      && enabledHistoricalFetches.every((item) => item.succeeded === 0)) {
      throw new Error("长桥历史订单与成交查询全部失败；本机仍保留上次成功缓存，未伪装为本次已同步。");
    }

    const includesToday = range.endMs >= startOfUtcDay(Date.now());
    const todayOrderFetch = emptyFetchDiagnostics();
    const todayExecutionFetch = emptyFetchDiagnostics();
    const todayOrders = includesToday && capabilities.todayOrders
      ? await this.#optionalCall(
          "today_orders",
          compactArgs({ symbol: normalizedSymbol }),
          "orders",
          warnings,
          todayOrderFetch,
        )
      : [];
    const todayExecutions = includesToday && capabilities.todayExecutions
      ? await this.#optionalCall(
          "today_executions",
          compactArgs({ symbol: normalizedSymbol }),
          "trades",
          warnings,
          todayExecutionFetch,
        )
      : [];

    const previous = await this.cached();
    const orders = mergeById(
      [...previous.orders, ...historicalOrders, ...todayOrders].map(normalizeOrder).filter(Boolean),
      (item) => item.orderId,
    ).sort(sortNewest("submittedAt"));
    const orderById = new Map(orders.map((item) => [item.orderId, item]));
    const executions = mergeById(
      [...previous.executions, ...historicalExecutions, ...todayExecutions]
        .map((item) => normalizeExecution(item, orderById))
        .filter(Boolean),
      (item) => item.tradeId,
    ).sort(sortNewest("doneAt"));

    const events = mergeById(
      previous.events.map(normalizeFinanceEvent).filter(Boolean),
      (item) => item.eventId,
    ).sort(sortNewest("eventAt"));

    const archive = {
      schemaVersion: SCHEMA_VERSION,
      source: "Longbridge MCP · read only",
      syncedAt: new Date().toISOString(),
      range: {
        startAt: new Date(range.startMs).toISOString(),
        endAt: new Date(range.endMs).toISOString(),
      },
      capabilities,
      completeness: historyCompleteness(warnings, capabilities, {
        orders: orderFetch,
        executions: executionFetch,
        todayOrders: todayOrderFetch,
        todayExecutions: todayExecutionFetch,
        includesToday,
      }),
      warnings: [...new Set(warnings)].slice(0, 20),
      orders: orders.slice(0, 20_000),
      executions: executions.slice(0, 20_000),
      events: events.slice(0, 10_000),
    };
    await this.store.set(STORE_KEY, archive);
    this.onStatus({
      state: warnings.length ? "degraded" : "ready",
      phase: "trade_history",
      message: `长桥交易历史已同步 · ${archive.orders.length} 笔订单 · ${archive.executions.length} 笔成交`,
      syncedAt: archive.syncedAt,
    });
    return structuredClone(archive);
  }

  async #fetchWindows(tool, range, symbol, listKey, warnings, diagnostics) {
    const rows = [];
    for (const window of splitRange(range.startMs, range.endMs, API_WINDOW_DAYS)) {
      rows.push(...await this.#fetchWindow(tool, window, symbol, listKey, warnings, diagnostics));
    }
    return rows;
  }

  async #fetchWindow(tool, range, symbol, listKey, warnings, diagnostics, depth = 0) {
    const args = compactArgs({
      symbol,
      // The hosted MCP schema accepts RFC3339 timestamps even though the
      // underlying HTTP endpoint documents epoch seconds.
      start_at: new Date(range.startMs).toISOString(),
      end_at: new Date(range.endMs).toISOString(),
      ...(tool === "history_orders"
        ? { us_page: 1, us_limit: US_ORDER_PAGE_SIZE }
        : {}),
    });
    try {
      const payload = await this.#trackedHistoryCall(tool, args, diagnostics);
      const rows = extractRows(payload, listKey);
      const totalCount = tool === "history_orders" ? extractTotalCount(payload) : null;
      if (totalCount != null) {
        const pages = Math.min(
          MAX_US_ORDER_PAGES,
          Math.max(1, Math.ceil(totalCount / US_ORDER_PAGE_SIZE)),
        );
        for (let page = 2; page <= pages; page += 1) {
          const pagePayload = await this.#trackedHistoryCall(
            tool,
            { ...args, us_page: page },
            diagnostics,
          );
          rows.push(...extractRows(pagePayload, listKey));
        }
        if (pages * US_ORDER_PAGE_SIZE < totalCount) {
          warnings.push(`history_orders 美区分页超过 ${MAX_US_ORDER_PAGES} 页，结果可能被截断。`);
        }
        return rows;
      }
      if (tool === "history_orders" && isRootArrayPayload(payload) && rows.length >= US_ORDER_PAGE_SIZE) {
        let previousSignature = rowPageSignature(rows);
        let lastPageWasFull = true;
        for (let page = 2; page <= MAX_US_ORDER_PAGES; page += 1) {
          const pagePayload = await this.#trackedHistoryCall(
            tool,
            { ...args, us_page: page },
            diagnostics,
          );
          const pageRows = extractRows(pagePayload, listKey);
          const signature = rowPageSignature(pageRows);
          if (pageRows.length && signature === previousSignature) {
            warnings.push("history_orders 根数组响应忽略了 us_page，结果完整性待确认。");
            lastPageWasFull = false;
            break;
          }
          rows.push(...pageRows);
          previousSignature = signature;
          lastPageWasFull = pageRows.length >= US_ORDER_PAGE_SIZE;
          if (!lastPageWasFull) break;
        }
        if (lastPageWasFull) {
          warnings.push(`history_orders 根数组分页达到 ${MAX_US_ORDER_PAGES} 页，结果可能被截断。`);
        }
        return rows;
      }
      if (
        tool === "history_executions"
        && isRootArrayPayload(payload)
        && rows.length >= ROOT_EXECUTION_SPLIT_THRESHOLD
      ) {
        if (range.endMs - range.startMs <= MIN_SPLIT_WINDOW_MS || depth >= MAX_EXECUTION_SPLIT_DEPTH) {
          warnings.push("history_executions 根数组在最小时间窗口仍较大，成交完整性待确认。");
          return rows;
        }
        const middle = range.startMs + Math.floor((range.endMs - range.startMs) / 2);
        const left = await this.#fetchWindow(
          tool,
          { startMs: range.startMs, endMs: middle },
          symbol,
          listKey,
          warnings,
          diagnostics,
          depth + 1,
        );
        const right = await this.#fetchWindow(
          tool,
          { startMs: middle + 1_000, endMs: range.endMs },
          symbol,
          listKey,
          warnings,
          diagnostics,
          depth + 1,
        );
        return [...left, ...right];
      }
      if (!hasMore(payload)) return rows;
      if (range.endMs - range.startMs <= MIN_SPLIT_WINDOW_MS) {
        warnings.push(`${tool} 在单日窗口仍超过 1000 条，结果可能被截断。`);
        return rows;
      }
      const middle = range.startMs + Math.floor((range.endMs - range.startMs) / 2);
      const left = await this.#fetchWindow(
        tool,
        { startMs: range.startMs, endMs: middle },
        symbol,
        listKey,
        warnings,
        diagnostics,
      );
      const right = await this.#fetchWindow(
        tool,
        { startMs: middle + 1_000, endMs: range.endMs },
        symbol,
        listKey,
        warnings,
        diagnostics,
      );
      return [...left, ...right];
    } catch (error) {
      warnings.push(`${tool}: ${safeMessage(error)}`);
      return [];
    }
  }

  async #trackedHistoryCall(tool, args, diagnostics) {
    diagnostics.attempted += 1;
    try {
      const payload = await this.longbridge.call(tool, args);
      diagnostics.succeeded += 1;
      return payload;
    } catch (error) {
      diagnostics.failed += 1;
      throw error;
    }
  }

  async #optionalCall(tool, args, listKey, warnings, diagnostics = emptyFetchDiagnostics()) {
    diagnostics.attempted += 1;
    try {
      const rows = extractRows(await this.longbridge.call(tool, args), listKey);
      diagnostics.succeeded += 1;
      return rows;
    } catch (error) {
      diagnostics.failed += 1;
      warnings.push(`${tool}: ${safeMessage(error)}`);
      return [];
    }
  }

  async #fetchFinanceCalendar(windows, symbols, warnings) {
    if (!symbols.size) return [];
    const events = [];
    const symbolsByMarket = groupSymbolsByMarket(symbols);
    for (const [market, marketSymbols] of symbolsByMarket) {
      for (const broadWindow of windows) {
        for (const window of splitRange(broadWindow.startMs, broadWindow.endMs, 31)) {
          try {
            const payload = await this.longbridge.call("finance_calendar", {
              category: "report",
              start: isoDate(window.startMs),
              end: isoDate(window.endMs),
              market,
            });
            events.push(...extractFinanceCalendarRows(payload)
              .map(normalizeFinanceEvent)
              .filter((item) => item && marketSymbols.has(item.symbol)));
          } catch (error) {
            warnings.push(`finance_calendar(${market}): ${safeMessage(error)}`);
          }
        }
      }
    }
    return events;
  }
}

/**
 * Renderer-safe, paginated intake projection. It contains no account IDs,
 * credentials, raw MCP payloads, or brokerage write capability.
 */
export function buildTradeHistoryIntake(archive, {
  symbol = null,
  from = null,
  to = null,
  query = "",
  offset = 0,
  limit = DEFAULT_INTAKE_LIMIT,
} = {}) {
  const normalized = normalizeArchive(archive);
  const normalizedSymbol = normalizeSymbol(symbol);
  const fromMs = parseOptionalDate(from);
  const toMs = parseOptionalDate(to);
  const needle = String(query ?? "").trim().toUpperCase().slice(0, 80);
  const records = [
    ...normalized.orders.map(publicOrderRecord),
    ...normalized.executions.map(publicExecutionRecord),
  ].filter((item) => {
    const timeMs = Date.parse(item.activityAt ?? "");
    if (normalizedSymbol && item.symbol !== normalizedSymbol) return false;
    if (fromMs != null && !(timeMs >= fromMs)) return false;
    if (toMs != null && !(timeMs <= toMs)) return false;
    if (needle && !`${item.symbol} ${item.side ?? ""} ${item.status ?? ""}`.toUpperCase().includes(needle)) {
      return false;
    }
    return true;
  }).sort(sortNewest("activityAt"));
  const safeOffset = Math.min(Math.max(Math.trunc(Number(offset)) || 0, 0), records.length);
  const safeLimit = Math.min(Math.max(Math.trunc(Number(limit)) || DEFAULT_INTAKE_LIMIT, 1), MAX_INTAKE_LIMIT);
  const page = records.slice(safeOffset, safeOffset + safeLimit);
  const eventCandidates = normalized.events
    .filter((item) => !normalizedSymbol || item.symbol === normalizedSymbol)
    .filter((item) => {
      const eventMs = Date.parse(item.eventAt ?? "");
      return (fromMs == null || eventMs >= fromMs) && (toMs == null || eventMs <= toMs);
    })
    .map(publicFinanceEvent);
  return {
    status: normalized.syncedAt ? "ready" : "not_synced",
    source: normalized.source,
    syncedAt: normalized.syncedAt,
    range: normalized.range,
    capabilities: normalized.capabilities,
    completeness: normalized.completeness,
    warnings: normalized.warnings,
    records: page,
    eventCandidates,
    totalRecordCount: records.length,
    offset: safeOffset,
    limit: safeLimit,
    nextOffset: safeOffset + page.length < records.length ? safeOffset + page.length : null,
    orderCount: normalized.orders.length,
    executionCount: normalized.executions.length,
    eventCandidateCount: normalized.events.length,
    eventMetadataStatus: normalized.capabilities.financeCalendar
      ? "available"
      : "unavailable",
    eventMetadataMessage: normalized.capabilities.financeCalendar
      ? null
      : "当前长桥只读授权未开放财报日历；案例会保留为待确认事件，不会根据下单日期猜测财报季度。",
  };
}

/** Resolve renderer selections against the encrypted archive on the host. */
export function resolveReviewSelection(archive, {
  recordIds = [],
  eventCandidateId = null,
} = {}) {
  const normalized = normalizeArchive(archive);
  const selected = resolveArchivedRecords(normalized, recordIds);
  const nearbyEvents = financeCandidatesForSelection(normalized, selected);
  let event = null;
  if (eventCandidateId != null && String(eventCandidateId).trim()) {
    event = nearbyEvents.find((item) => item.eventId === String(eventCandidateId).trim());
    if (!event) throw new Error("所选财报事件与这些长桥记录不匹配，请重新选择。");
  } else if (selected.symbols.size > 1) {
    throw new Error("跨标的决策包需要先确认财报事件；主标的将由该事件决定，不能从第一笔订单猜测。");
  } else {
    const singleSymbolEvents = nearbyEvents.filter((item) => item.symbol === [...selected.symbols][0]);
    if (singleSymbolEvents.length === 1 || (
      singleSymbolEvents[0]?.distanceDays <= 21
      && singleSymbolEvents[1]?.distanceDays > 21
    )) event = singleSymbolEvents[0];
  }
  const symbol = event?.symbol ?? [...selected.symbols][0];
  const matchingEvents = nearbyEvents.filter((item) => item.symbol === symbol);

  return {
    symbol,
    relatedSymbols: [...selected.symbols].sort(),
    activityStartAt: selected.activityTimes[0],
    activityEndAt: selected.activityTimes[selected.activityTimes.length - 1],
    orderIds: selected.orders.map((item) => item.orderId),
    executionIds: selected.executions.map((item) => item.tradeId),
    recordIds: selected.recordIds,
    requestedRecordIds: selected.requested,
    autoIncludedRecordCount: selected.recordIds.length - selected.requested.length,
    records: [
      ...selected.orders.map(publicOrderRecord),
      ...selected.executions.map(publicExecutionRecord),
    ].sort(sortNewest("activityAt")),
    event: event ? publicFinanceEvent(event) : null,
    eventCandidates: matchingEvents.map(publicFinanceEvent),
    eventAssociation: event
      ? { status: "matched", source: "Longbridge finance_calendar", confidence: event.distanceDays <= 7 ? "high" : "candidate" }
      : {
          status: normalized.capabilities.financeCalendar ? "needs_confirmation" : "unavailable",
          source: null,
          confidence: null,
          message: normalized.capabilities.financeCalendar
            ? "附近存在多个或没有明确的财报事件，请人工选择后再确认。"
            : "财报日历不可用；仅保存订单实际时间，财报日与季度保持待确认。",
        },
  };
}

function resolveArchivedRecords(archive, recordIds) {
  const requested = uniqueRecordIds(recordIds);
  if (!requested.length) throw new Error("请至少选择一笔长桥订单或成交。");
  if (requested.length > MAX_SELECTED_RECORDS) {
    throw new Error(`一次最多关联 ${MAX_SELECTED_RECORDS} 条长桥记录。`);
  }
  if (requested.some((item) => !/^(?:order|execution):.{1,160}$/.test(item))) {
    throw new Error("长桥记录标识无效，请刷新列表后重试。");
  }
  const orderByRecordId = new Map(archive.orders.map((item) => [`order:${item.orderId}`, item]));
  const executionByRecordId = new Map(archive.executions.map((item) => [`execution:${item.tradeId}`, item]));
  const selectedOrderIds = new Set();
  const selectedExecutionIds = new Set();
  const missing = [];
  for (const recordId of requested) {
    if (orderByRecordId.has(recordId)) selectedOrderIds.add(orderByRecordId.get(recordId).orderId);
    else if (executionByRecordId.has(recordId)) selectedExecutionIds.add(executionByRecordId.get(recordId).tradeId);
    else missing.push(recordId);
  }
  if (missing.length) throw new Error("部分所选记录不在本机加密长桥历史中，请重新同步后再试。");

  // Broker records form a closed decision package: selecting a fill brings in
  // its parent order, while selecting an order brings in every archived fill.
  // Every automatically included ID is resolved from the encrypted archive.
  const orderByBrokerId = new Map(archive.orders.map((item) => [item.orderId, item]));
  for (const execution of archive.executions) {
    if (selectedExecutionIds.has(execution.tradeId) && orderByBrokerId.has(execution.orderId)) {
      selectedOrderIds.add(execution.orderId);
    }
  }
  for (const execution of archive.executions) {
    if (selectedOrderIds.has(execution.orderId)) selectedExecutionIds.add(execution.tradeId);
  }
  const orders = archive.orders.filter((item) => selectedOrderIds.has(item.orderId));
  const executions = archive.executions.filter((item) => selectedExecutionIds.has(item.tradeId));
  const closedRecordIds = [
    ...orders.map((item) => `order:${item.orderId}`),
    ...executions.map((item) => `execution:${item.tradeId}`),
  ];
  if (closedRecordIds.length > MAX_SELECTED_RECORDS) {
    throw new Error(`所选记录连同父订单和关联成交超过 ${MAX_SELECTED_RECORDS} 条，请拆分复盘案例。`);
  }
  const symbols = new Set([...orders, ...executions].map((item) => item.symbol));
  const activityTimes = [
    ...orders.map((item) => item.submittedAt ?? item.updatedAt),
    ...executions.map((item) => item.doneAt),
  ].map((item) => timestampToIso(item)).filter(Boolean).sort();
  if (!activityTimes.length) throw new Error("所选长桥记录缺少有效时间，无法建立复盘案例。");
  return { requested, recordIds: closedRecordIds, orders, executions, symbols, activityTimes };
}

function financeCandidatesForSelection(archive, selected) {
  return archive.events
    .filter((item) => selected.symbols.has(item.symbol))
    .map((item) => ({
      ...item,
      ...eventDistanceStats(item.eventAt, selected.activityTimes),
    }))
    // Every selected order/fill must belong to the same event window. Using
    // only the nearest record allowed a remote prior-quarter order to hitch a
    // ride on an otherwise plausible candidate.
    .filter((item) => item.distanceDays != null && item.maxDistanceDays <= 45)
    .sort((left, right) => left.distanceDays - right.distanceDays);
}

export function matchExecutionsToEvent(archive, {
  symbol,
  eventAt,
  daysBefore = 21,
  daysAfter = 20,
} = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const eventMs = Date.parse(String(eventAt ?? ""));
  if (!normalizedSymbol || !Number.isFinite(eventMs)) return [];
  const startMs = eventMs - daysBefore * 24 * 60 * 60 * 1000;
  const endMs = eventMs + daysAfter * 24 * 60 * 60 * 1000;
  return (archive?.executions ?? []).filter((item) => {
    const doneMs = Date.parse(String(item.doneAt ?? ""));
    return item.symbol === normalizedSymbol && doneMs >= startMs && doneMs <= endMs;
  });
}

export function matchOrdersToEvent(archive, {
  symbol,
  eventAt,
  daysBefore = 21,
  daysAfter = 20,
} = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const eventMs = Date.parse(String(eventAt ?? ""));
  if (!normalizedSymbol || !Number.isFinite(eventMs)) return [];
  const startMs = eventMs - daysBefore * 24 * 60 * 60 * 1000;
  const endMs = eventMs + daysAfter * 24 * 60 * 60 * 1000;
  return (archive?.orders ?? []).filter((item) => {
    const submittedMs = Date.parse(String(item.submittedAt ?? item.updatedAt ?? ""));
    return item.symbol === normalizedSymbol && submittedMs >= startMs && submittedMs <= endMs;
  });
}

function emptyArchive() {
  return {
    schemaVersion: SCHEMA_VERSION,
    source: "Longbridge MCP · read only",
    syncedAt: null,
    range: null,
    capabilities: {
      historyOrders: false,
      historyExecutions: false,
      todayOrders: false,
      todayExecutions: false,
      financeCalendar: false,
    },
    warnings: [],
    completeness: {
      orders: "not_synced",
      executions: "not_synced",
    },
    orders: [],
    executions: [],
    events: [],
  };
}

function normalizeArchive(value) {
  if (!value || ![1, SCHEMA_VERSION].includes(value.schemaVersion)) return emptyArchive();
  const archive = emptyArchive();
  return structuredClone({
    ...archive,
    schemaVersion: SCHEMA_VERSION,
    source: cleanText(value.source, 120) || archive.source,
    syncedAt: timestampToIso(value.syncedAt),
    range: normalizeStoredRange(value.range),
    capabilities: {
      ...archive.capabilities,
      ...(value.capabilities && typeof value.capabilities === "object"
        ? Object.fromEntries(Object.keys(archive.capabilities).map((key) => [key, value.capabilities[key] === true]))
        : {}),
    },
    warnings: Array.isArray(value.warnings)
      ? value.warnings.map((item) => cleanText(item, 240)).filter(Boolean).slice(0, 20)
      : [],
    completeness: normalizeCompleteness(value.completeness),
    orders: Array.isArray(value.orders) ? value.orders.map(normalizeOrder).filter(Boolean).slice(0, 20_000) : [],
    executions: normalizeStoredExecutions(value.executions, value.orders),
    events: Array.isArray(value.events) ? value.events.map(normalizeFinanceEvent).filter(Boolean).slice(0, 10_000) : [],
  });
}

function normalizeStoredExecutions(executions, orders) {
  if (!Array.isArray(executions)) return [];
  const orderById = new Map((Array.isArray(orders) ? orders : [])
    .map(normalizeOrder)
    .filter(Boolean)
    .map((item) => [item.orderId, item]));
  return executions.map((item) => normalizeExecution(item, orderById)).filter(Boolean).slice(0, 20_000);
}

function normalizeStoredRange(value) {
  const startAt = timestampToIso(value?.startAt);
  const endAt = timestampToIso(value?.endAt);
  return startAt && endAt ? { startAt, endAt } : null;
}

function normalizeCompleteness(value) {
  const choices = new Set(["not_synced", "unavailable", "complete", "windowed", "best_effort", "stale"]);
  return {
    orders: choices.has(value?.orders) ? value.orders : "best_effort",
    executions: choices.has(value?.executions) ? value.executions : "best_effort",
  };
}

function historyCompleteness(warnings, capabilities, diagnostics = {}) {
  const text = warnings.join("\n");
  const streamState = (tool, capability, normalState, todayTool, todayCapability, todayKey) => {
    if (!capability) return "unavailable";
    const outcome = diagnostics[tool === "history_orders" ? "orders" : "executions"];
    if (!outcome || outcome.succeeded === 0) return "stale";
    if (outcome.failed > 0 || new RegExp(tool).test(text)) return "best_effort";
    if (diagnostics.includesToday) {
      const todayOutcome = diagnostics[todayKey];
      if (!todayCapability || !todayOutcome || todayOutcome.succeeded === 0) return "best_effort";
      if (todayOutcome.failed > 0 || new RegExp(todayTool).test(text)) return "best_effort";
    }
    return normalState;
  };
  return {
    orders: streamState(
      "history_orders",
      capabilities.historyOrders,
      "complete",
      "today_orders",
      capabilities.todayOrders,
      "todayOrders",
    ),
    executions: streamState(
      "history_executions",
      capabilities.historyExecutions,
      "windowed",
      "today_executions",
      capabilities.todayExecutions,
      "todayExecutions",
    ),
  };
}

function emptyFetchDiagnostics() {
  return { attempted: 0, succeeded: 0, failed: 0 };
}

function normalizeRange({ startAt, endAt }) {
  const now = Date.now();
  const rawEnd = endAt == null ? now : Date.parse(String(endAt));
  const endMs = Number.isFinite(rawEnd) ? Math.min(rawEnd, now) : now;
  const fallbackStart = endMs - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const rawStart = startAt == null ? fallbackStart : Date.parse(String(startAt));
  const earliest = endMs - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const startMs = Math.max(Number.isFinite(rawStart) ? rawStart : fallbackStart, earliest);
  if (startMs >= endMs) throw new Error("交易历史开始时间必须早于结束时间。");
  return { startMs, endMs };
}

function splitRange(startMs, endMs, days) {
  const windows = [];
  const span = days * 24 * 60 * 60 * 1000;
  let cursor = startMs;
  while (cursor < endMs) {
    const windowEnd = Math.min(endMs, cursor + span);
    windows.push({ startMs: cursor, endMs: windowEnd });
    cursor = windowEnd + 1_000;
  }
  return windows;
}

function extractRows(payload, key) {
  const value = unwrapData(payload);
  const rows = Array.isArray(value)
    ? value
    : value?.[key] ?? value?.list ?? [];
  return Array.isArray(rows) ? rows : [];
}

function extractFinanceCalendarRows(payload) {
  const value = unwrapData(payload);
  const groups = Array.isArray(value) ? value : value?.list ?? [];
  if (!Array.isArray(groups)) return [];
  const rows = [];
  for (const group of groups) {
    if (Array.isArray(group?.infos)) {
      for (const info of group.infos) rows.push({ ...info, calendarDate: group.date ?? group.calendar_date });
    } else if (group && typeof group === "object") {
      rows.push(group);
    }
  }
  return rows;
}

function unwrapData(payload) {
  let value = payload;
  for (let index = 0; index < 3; index += 1) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.data == null) break;
    value = value.data;
  }
  return value;
}

function hasMore(payload) {
  const value = unwrapData(payload);
  return value?.has_more === true || value?.hasMore === true;
}

function isRootArrayPayload(payload) {
  return Array.isArray(unwrapData(payload));
}

function rowPageSignature(rows) {
  if (!Array.isArray(rows) || !rows.length) return "empty";
  const identity = (item) => item?.order_id ?? item?.orderId ?? item?.trade_id ?? item?.tradeId ?? item?.id ?? "";
  return `${rows.length}:${identity(rows[0])}:${identity(rows[rows.length - 1])}`;
}

function extractTotalCount(payload) {
  const value = unwrapData(payload);
  const count = Number(value?.total_count ?? value?.totalCount);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

function normalizeOrder(value) {
  if (!value || typeof value !== "object") return null;
  const orderId = cleanId(value.order_id ?? value.orderId ?? value.id);
  const symbol = normalizeSymbol(value.symbol);
  if (!orderId || !symbol) return null;
  return {
    orderId,
    symbol,
    side: cleanText(value.side ?? value.action, 20),
    status: cleanText(value.status, 60),
    orderType: cleanText(value.order_type ?? value.orderType, 40),
    quantity: finiteOrNull(value.quantity),
    executedQuantity: finiteOrNull(value.executed_quantity ?? value.executedQuantity),
    submittedPrice: finiteOrNull(value.price ?? value.submitted_price ?? value.submittedPrice),
    executedPrice: finiteOrNull(value.executed_price ?? value.executedPrice),
    currency: cleanCurrency(value.currency),
    submittedAt: timestampToIso(value.submitted_at ?? value.submittedAt),
    updatedAt: timestampToIso(value.updated_at ?? value.updatedAt),
    source: "Longbridge",
  };
}

function normalizeExecution(value, orderById) {
  if (!value || typeof value !== "object") return null;
  const orderId = cleanId(value.order_id ?? value.orderId);
  const tradeId = cleanId(value.trade_id ?? value.tradeId) || [
    orderId,
    value.trade_done_at ?? value.doneAt,
    value.price,
    value.quantity,
  ].filter(Boolean).join(":");
  const symbol = normalizeSymbol(value.symbol ?? orderById.get(orderId)?.symbol);
  if (!tradeId || !symbol) return null;
  const order = orderById.get(orderId);
  return {
    tradeId,
    orderId,
    symbol,
    side: cleanText(value.side ?? order?.side, 20),
    quantity: finiteOrNull(value.quantity),
    price: finiteOrNull(value.price),
    currency: cleanCurrency(value.currency ?? order?.currency),
    doneAt: timestampToIso(value.trade_done_at ?? value.doneAt ?? value.tradeDoneAt),
    source: "Longbridge",
  };
}

function normalizeFinanceEvent(value) {
  if (!value || typeof value !== "object") return null;
  const symbol = normalizeSymbol(value.symbol ?? value.security?.symbol);
  const financial = value.ext?.financial_report
    ?? value.ext?.financialReport
    ?? value.financial_report
    ?? value.financialReport
    ?? {};
  const eventAt = timestampToIso(
    value.eventAt
      ?? value.datetime
      ?? value.date_time
      ?? value.calendarDate
      ?? value.date,
  );
  if (!symbol || !eventAt) return null;
  const fiscalYear = integerOrNull(financial.fiscal_year ?? financial.fiscalYear ?? value.fiscalYear);
  const fiscalPeriod = cleanText(financial.period ?? value.fiscalPeriod, 40);
  const periodType = cleanText(financial.period_type ?? financial.periodType ?? value.periodType, 40);
  const marketTime = cleanText(financial.market_time ?? financial.marketTime ?? value.marketTime, 80);
  const eventSession = normalizeEventSession(value.eventSession ?? marketTime);
  const eventTimePrecision = normalizeEventTimePrecision(
    value.eventTimePrecision,
    eventAt,
    eventSession,
  );
  const fiscalQuarter = normalizeFiscalQuarter({
    fiscalYear,
    fiscalPeriod,
    periodType,
    existing: value.fiscalQuarter,
  });
  const eventId = cleanId(value.eventId) || financeEventId({
    symbol,
    eventAt,
    fiscalYear,
    fiscalPeriod,
    periodType,
  });
  return {
    eventId,
    symbol,
    eventAt,
    eventDate: cleanDate(value.eventDate) || eventAt.slice(0, 10),
    eventTimePrecision,
    eventSession,
    timezone: cleanText(value.timezone, 80) || timezoneForSymbol(symbol),
    fiscalYear,
    fiscalPeriod,
    periodType,
    fiscalQuarter,
    marketTime,
    source: "Longbridge finance_calendar",
  };
}

function publicOrderRecord(value) {
  return {
    recordId: `order:${value.orderId}`,
    kind: "order",
    symbol: value.symbol,
    side: value.side,
    status: value.status,
    orderType: value.orderType,
    quantity: value.quantity,
    executedQuantity: value.executedQuantity,
    price: value.executedPrice ?? value.submittedPrice,
    submittedPrice: value.submittedPrice,
    executedPrice: value.executedPrice,
    currency: value.currency,
    activityAt: value.submittedAt ?? value.updatedAt,
    source: "Longbridge · read only",
  };
}

function publicExecutionRecord(value) {
  return {
    recordId: `execution:${value.tradeId}`,
    relatedOrderRecordId: value.orderId ? `order:${value.orderId}` : null,
    kind: "execution",
    symbol: value.symbol,
    side: value.side,
    status: "filled",
    quantity: value.quantity,
    executedQuantity: value.quantity,
    price: value.price,
    currency: value.currency,
    activityAt: value.doneAt,
    source: "Longbridge · read only",
  };
}

function publicFinanceEvent(value) {
  return {
    eventCandidateId: value.eventId,
    symbol: value.symbol,
    eventAt: value.eventAt,
    eventDate: value.eventDate,
    eventTimePrecision: value.eventTimePrecision,
    eventSession: value.eventSession,
    timezone: value.timezone,
    fiscalYear: value.fiscalYear,
    fiscalPeriod: value.fiscalPeriod,
    periodType: value.periodType,
    fiscalQuarter: value.fiscalQuarter,
    marketTime: value.marketTime,
    source: "Longbridge finance_calendar",
    ...(Number.isFinite(value.distanceDays) ? { distanceDays: value.distanceDays } : {}),
    ...(Number.isFinite(value.maxDistanceDays) ? { maxDistanceDays: value.maxDistanceDays } : {}),
  };
}

function mergeById(items, getId) {
  const values = new Map();
  for (const item of items) {
    const id = getId(item);
    if (!id) continue;
    values.set(id, { ...(values.get(id) ?? {}), ...item });
  }
  return [...values.values()];
}

function sortNewest(field) {
  return (left, right) => Date.parse(right[field] ?? "") - Date.parse(left[field] ?? "");
}

function timestampToIso(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  const millis = Number.isFinite(numeric)
    ? numeric > 10_000_000_000 ? numeric : numeric * 1000
    : Date.parse(String(value));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function compactArgs(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item != null && item !== ""));
}

function normalizeSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9._:-]{1,40}$/.test(symbol) ? symbol : null;
}

function cleanCurrency(value) {
  const currency = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function cleanId(value) {
  const id = String(value ?? "").trim();
  return id ? id.slice(0, 160) : null;
}

function uniqueRecordIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean))];
}

function cleanText(value, limit) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, limit) : null;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function parseOptionalDate(value) {
  if (value == null || value === "") return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function safeMessage(error) {
  return (error instanceof Error ? error.message : String(error ?? "未知错误")).slice(0, 240);
}

function startOfUtcDay(value) {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function isoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(Math.max(Math.trunc(parsed), min), max)
    : fallback;
}

function mergeWindows(values) {
  const sorted = values
    .filter((item) => Number.isFinite(item?.startMs) && Number.isFinite(item?.endMs))
    .sort((left, right) => left.startMs - right.startMs);
  const result = [];
  for (const value of sorted) {
    const previous = result[result.length - 1];
    if (previous && value.startMs <= previous.endMs + 1_000) {
      previous.endMs = Math.max(previous.endMs, value.endMs);
    } else {
      result.push({ startMs: value.startMs, endMs: value.endMs });
    }
  }
  return result;
}

function groupSymbolsByMarket(symbols) {
  const groups = new Map();
  for (const symbol of symbols) {
    const market = marketForSymbol(symbol);
    if (!market) continue;
    if (!groups.has(market)) groups.set(market, new Set());
    groups.get(market).add(symbol);
  }
  return groups;
}

function marketForSymbol(symbol) {
  const suffix = String(symbol ?? "").split(".").pop()?.toUpperCase();
  return new Set(["US", "HK", "CN", "SG", "JP", "UK", "DE", "AU"]).has(suffix)
    ? suffix
    : null;
}

function timezoneForSymbol(symbol) {
  return ({
    US: "America/New_York",
    HK: "Asia/Hong_Kong",
    CN: "Asia/Shanghai",
    SG: "Asia/Singapore",
    JP: "Asia/Tokyo",
    UK: "Europe/London",
    DE: "Europe/Berlin",
    AU: "Australia/Sydney",
  })[marketForSymbol(symbol)] ?? "UTC";
}

function normalizeEventSession(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (/\b(?:bmo|before|pre.?market|盘前)\b/.test(text)) return "bmo";
  if (/\b(?:amc|after|post.?market|盘后)\b/.test(text)) return "amc";
  if (/\b(?:intraday|during|盘中)\b/.test(text)) return "intraday";
  return "unknown";
}

function normalizeFiscalQuarter({ fiscalYear, fiscalPeriod, periodType, existing }) {
  const current = cleanText(existing, 40);
  if (current && /^FY\d{2,4}\s+Q[1-4]$/i.test(current)) return current.toUpperCase();
  if (!Number.isInteger(fiscalYear)) return null;
  const period = String(fiscalPeriod ?? "").trim().toUpperCase();
  const type = String(periodType ?? "").trim().toUpperCase();
  const explicitQuarter = period.match(/^Q([1-4])$/)?.[1];
  if (explicitQuarter) return `FY${fiscalYear} Q${explicitQuarter}`;
  const typeQuarter = type.match(/^Q([1-4])$/)?.[1];
  if (typeQuarter) return `FY${fiscalYear} Q${typeQuarter}`;
  if (/^[1-4]$/.test(period) && (
    type === "QF"
    || /(?:^|[^A-Z])Q(?:UARTER)?(?:$|[^A-Z])|QUARTERLY/.test(type)
  )) {
    return `FY${fiscalYear} Q${period}`;
  }
  return null;
}

function normalizeEventTimePrecision(value, eventAt, eventSession) {
  if (["exact", "session", "date"].includes(value)) return value;
  const time = String(eventAt ?? "").slice(11, 19);
  if (time === "00:00:00" && eventSession !== "unknown") return "session";
  return time === "00:00:00" ? "date" : "exact";
}

function cleanDate(value) {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function financeEventId({ symbol, eventAt, fiscalYear, fiscalPeriod, periodType }) {
  return [symbol, eventAt, fiscalYear ?? "", fiscalPeriod ?? "", periodType ?? ""]
    .map((item) => encodeURIComponent(String(item)))
    .join("|")
    .slice(0, 160);
}

function eventDistanceStats(eventAt, activityTimes) {
  const eventMs = Date.parse(String(eventAt ?? ""));
  if (!Number.isFinite(eventMs)) return { distanceDays: null, maxDistanceDays: null };
  const distances = activityTimes
    .map((item) => Math.abs(eventMs - Date.parse(item)) / (24 * 60 * 60 * 1000))
    .filter(Number.isFinite);
  if (!distances.length) return { distanceDays: null, maxDistanceDays: null };
  return {
    distanceDays: Math.round(Math.min(...distances) * 100) / 100,
    maxDistanceDays: Math.round(Math.max(...distances) * 100) / 100,
  };
}
