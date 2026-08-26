import { inferInstrumentType, normalizeCandles } from "./normalize.mjs";

const STORE_KEY = "brokerTradeHistoryV1";
const SCHEMA_VERSION = 2;
const DEFAULT_LOOKBACK_DAYS = 180;
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
const RECENT_EARNINGS_LOOKBACK_DAYS = 240;
const RECENT_EARNINGS_FORWARD_DAYS = 45;
const RECENT_EARNINGS_EVENT_LIMIT = 3;
const MAX_RECENT_EARNINGS_SYMBOLS = 5;
const FINANCE_CALENDAR_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const FINANCE_CALENDAR_CONCURRENCY = 4;
const ORDER_DETAIL_BACKFILL_LIMIT = 120;
const ORDER_DETAIL_BACKFILL_CONCURRENCY = 3;
const ORDER_DETAIL_MAX_ATTEMPTS = 2;
const ORDER_DETAIL_MIN_START_INTERVAL_MS = 75;
const ORDER_DETAIL_RETRY_DELAY_MS = 100;
const BROKER_PRICE_AUDIT_CONCURRENCY = 2;
const BROKER_PRICE_AUDIT_CANDLE_COUNT = 1_000;
const BROKER_PRICE_AUDIT_MAX_SYMBOLS = 12;

/**
 * Read-only Longbridge order/execution archive used by the review workspace.
 * It deliberately stores no account identifiers and never exposes brokerage
 * write operations.
 */
export class TradeHistoryService {
  constructor({
    longbridge,
    store,
    onStatus = () => {},
    orderDetailMinIntervalMs = ORDER_DETAIL_MIN_START_INTERVAL_MS,
  }) {
    this.longbridge = longbridge;
    this.store = store;
    this.onStatus = onStatus;
    this.orderDetailMinIntervalMs = clampInteger(orderDetailMinIntervalMs, 0, 5_000, ORDER_DETAIL_MIN_START_INTERVAL_MS);
    this.orderDetailStartQueue = Promise.resolve();
    this.orderDetailLastStartedAt = 0;
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

  async resolveBrokerRecords({ recordIds = [] } = {}) {
    return resolveBrokerRecordSelection(await this.cached(), { recordIds });
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

  async preloadRecentEventCandidates({ symbols = [], asOf = null } = {}) {
    const normalizedSymbols = [...new Set((Array.isArray(symbols) ? symbols : [symbols])
      .map(normalizeSymbol)
      .filter(Boolean))].slice(0, MAX_RECENT_EARNINGS_SYMBOLS);
    if (!normalizedSymbols.length) {
      return { status: "empty", message: null, eventCandidates: [] };
    }
    const pending = this.eventLookupQueue.then(() => this.#preloadRecentEventCandidates({
      symbols: normalizedSymbols,
      asOf,
    }));
    this.eventLookupQueue = pending.catch(() => {});
    return pending;
  }

  async #preloadRecentEventCandidates({ symbols, asOf }) {
    if (!this.longbridge.connected) {
      throw new Error("长桥尚未连接，无法预取财报事件。");
    }
    if (!this.longbridge.supports("finance_calendar")) {
      return {
        status: "unavailable",
        message: "当前长桥只读授权未开放财报日历。",
        eventCandidates: [],
      };
    }
    if (this.syncing) await this.syncing;
    const archive = await this.cached();
    const referenceMs = Math.min(parseOptionalDate(asOf) ?? Date.now(), Date.now());
    const windows = [{
      startMs: referenceMs - RECENT_EARNINGS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
      // Fetch the next window into the same cache so selecting a recent order
      // does not immediately trigger a second calendar round-trip. Upcoming
      // events are not shown in the "recent reports" preview below.
      endMs: referenceMs + RECENT_EARNINGS_FORWARD_DAYS * 24 * 60 * 60 * 1000,
    }];
    const symbolSet = new Set(symbols);
    const warnings = [];
    const refresh = await this.#fetchFinanceCalendar(
      windows,
      symbolSet,
      warnings,
      archive.eventCoverage,
    );
    const nextArchive = await this.#saveFinanceCalendarRefresh({
      archive,
      refresh,
      warnings,
      replaceSymbols: symbolSet,
    });
    const candidates = [...symbolSet].flatMap((symbol) => nextArchive.events
      .filter((item) => item.symbol === symbol)
      .filter((item) => {
        const eventMs = Date.parse(String(item.eventAt ?? ""));
        return Number.isFinite(eventMs) && eventMs >= windows[0].startMs && eventMs <= referenceMs;
      })
      .sort(sortNewest("eventAt"))
      .slice(0, RECENT_EARNINGS_EVENT_LIMIT));
    return {
      status: warnings.length ? "degraded" : refresh.coverage.length ? "ready" : "cached",
      message: warnings.length ? warnings.join("；") : null,
      eventCandidates: candidates.map(publicFinanceEvent),
      lookbackDays: RECENT_EARNINGS_LOOKBACK_DAYS,
      eventLimitPerSymbol: RECENT_EARNINGS_EVENT_LIMIT,
    };
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
    const refresh = await this.#fetchFinanceCalendar(
      windows,
      selected.symbols,
      warnings,
      archive.eventCoverage,
    );
    const events = refresh.events;
    const retainedEvents = warnings.length || !refresh.coverage.length
      ? archive.events
      : archive.events.filter((item) => !selected.symbols.has(item.symbol)
        || !financeEventInsideCoverage(item, refresh.coverage));
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
      eventCoverage: mergeFinanceCoverage(archive.eventCoverage, refresh.coverage),
    };
    await this.store.set(STORE_KEY, nextArchive);
    const candidates = financeCandidatesForSelection(nextArchive, selected);
    return {
      status: warnings.length ? "degraded" : "ready",
      message: warnings.length ? warnings.join("；") : null,
      eventCandidates: candidates.map(publicFinanceEvent),
    };
  }

  async #saveFinanceCalendarRefresh({ archive, refresh, warnings, replaceSymbols = null }) {
    if (!refresh.coverage.length && !refresh.events.length && !warnings.length) return archive;
    const retainedEvents = !warnings.length && refresh.coverage.length && replaceSymbols?.size
      ? archive.events.filter((item) => !replaceSymbols.has(item.symbol)
        || !financeEventInsideCoverage(item, refresh.coverage))
      : archive.events;
    const nextArchive = {
      ...archive,
      capabilities: { ...archive.capabilities, financeCalendar: true },
      warnings: [...new Set([...archive.warnings, ...warnings])].slice(0, 20),
      events: mergeById([...retainedEvents, ...refresh.events], (item) => item.eventId)
        .sort(sortNewest("eventAt"))
        .slice(0, 10_000),
      eventCoverage: mergeFinanceCoverage(archive.eventCoverage, refresh.coverage),
    };
    await this.store.set(STORE_KEY, nextArchive);
    return nextArchive;
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
      if (await this.longbridge.needsAuthorizationUpgrade?.()) {
        const cause = Object.assign(new Error("Legacy account.read authorization"), {
          kind: "permission",
          code: 403308,
          retryable: false,
          reauth: true,
        });
        const authorizationError = tradeHistoryAuthorizationError(cause);
        this.onStatus({
          state: "scope_upgrade_required",
          message: "长桥历史查询需要升级只读授权",
          detail: authorizationError.message,
        });
        throw authorizationError;
      }
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
      orderDetail: this.longbridge.supports("order_detail"),
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
      const firstFailures = warnings.filter((item) => /history_(?:orders|executions)/.test(item)).slice(0, 2);
      const detail = firstFailures.length ? `（${firstFailures.join("；")}）` : "";
      throw new Error(`长桥历史订单与成交查询全部失败${detail}；本机仍保留上次成功缓存，未伪装为本次已同步。`);
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
    const executionRows = [...previous.executions, ...historicalExecutions, ...todayExecutions];
    const initialOrders = mergeById(
      [...previous.orders, ...historicalOrders, ...todayOrders].map(normalizeOrder).filter(Boolean),
      (item) => item.orderId,
    ).sort(sortNewest("submittedAt"));
    const parentOrderBackfill = await this.#backfillMissingParentOrders({
      orders: initialOrders,
      executions: executionRows,
      warnings,
    });
    const normalizedOrders = mergeById(
      [...initialOrders, ...parentOrderBackfill.orders].map(normalizeOrder).filter(Boolean),
      (item) => item.orderId,
    ).sort(sortNewest("submittedAt"));
    const orderById = new Map(normalizedOrders.map((item) => [item.orderId, item]));
    const normalizedExecutions = mergeById(
      executionRows
        .map((item) => normalizeExecution(item, orderById))
        .filter(Boolean),
      (item) => item.tradeId,
    ).sort(sortNewest("doneAt"));
    const reconciled = auditBrokerPackages(normalizedOrders, normalizedExecutions);
    const orders = reconciled.orders;
    const executions = await this.#enrichExcludedEquityMarketEvidence({
      executions: reconciled.executions,
      warnings,
    });

    const events = mergeById(
      previous.events.map(normalizeFinanceEvent).filter(Boolean),
      (item) => item.eventId,
    ).sort(sortNewest("eventAt"));

    const completeness = historyCompleteness(warnings, capabilities, {
      orders: orderFetch,
      executions: executionFetch,
      todayOrders: todayOrderFetch,
      todayExecutions: todayExecutionFetch,
      includesToday,
    });
    if (["degraded", "unavailable"].includes(parentOrderBackfill.status)
      && parentOrderBackfill.discoveredOrderCount > 0
      && completeness.orders !== "unavailable") {
      completeness.orders = "best_effort";
    }
    const archive = {
      schemaVersion: SCHEMA_VERSION,
      source: "Longbridge MCP · read only",
      syncedAt: new Date().toISOString(),
      range: {
        startAt: new Date(range.startMs).toISOString(),
        endAt: new Date(range.endMs).toISOString(),
      },
      capabilities,
      completeness,
      parentOrderBackfill: publicParentOrderBackfill(parentOrderBackfill),
      warnings: [...new Set(warnings)].slice(0, 20),
      orders: orders.slice(0, 20_000),
      executions: executions.slice(0, 20_000),
      events: events.slice(0, 10_000),
      eventCoverage: previous.eventCoverage,
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

  async #enrichExcludedEquityMarketEvidence({ executions, warnings }) {
    const rows = Array.isArray(executions) ? executions : [];
    if (!this.longbridge.supports("candlesticks")) return rows;
    const reasons = new Set([
      "multileg_order_unmodeled",
      "possible_multileg_missing_leg_metadata",
      "parent_execution_fields_conflict",
    ]);
    const allSymbols = [...new Set(rows
      .filter((item) => item?.brokerEvidenceAudit?.status === "excluded")
      .filter((item) => reasons.has(item?.brokerEvidenceAudit?.reason))
      .filter((item) => inferInstrumentType(item?.symbol) === "equity")
      .map((item) => normalizeSymbol(item?.symbol))
      .filter(Boolean))];
    const symbols = allSymbols.slice(0, BROKER_PRICE_AUDIT_MAX_SYMBOLS);
    if (allSymbols.length > symbols.length) {
      warnings.push(
        `证券语义行情核验本轮按最近记录覆盖 ${symbols.length} 个标的；其余 ${allSymbols.length - symbols.length} 个异常包仍按父单/成交确定性冲突排除，不等待行情旁证。`,
      );
    }
    if (!symbols.length) return rows;
    const results = await mapWithConcurrency(
      symbols,
      BROKER_PRICE_AUDIT_CONCURRENCY,
      async (symbol) => {
        try {
          const payload = await this.longbridge.call("candlesticks", {
            symbol,
            period: "day",
            count: BROKER_PRICE_AUDIT_CANDLE_COUNT,
            // Transaction prices are unadjusted facts; an adjusted series can
            // manufacture a false mismatch after a split or distribution.
            forward_adjust: false,
            trade_sessions: "intraday",
          });
          return [symbol, normalizeCandles(payload, { symbol })];
        } catch (error) {
          warnings.push(`证券语义行情核验(${symbol}): ${safeMessage(error)}`);
          return [symbol, []];
        }
      },
    );
    const candlesBySymbol = new Map(results);
    const checkedAt = new Date().toISOString();
    return rows.map((execution) => {
      if (execution?.brokerEvidenceAudit?.status !== "excluded"
          || !reasons.has(execution?.brokerEvidenceAudit?.reason)) return execution;
      const symbol = normalizeSymbol(execution.symbol);
      const tradeDate = exchangeDateForTimestamp(execution.doneAt, symbol);
      const candle = (candlesBySymbol.get(symbol) ?? [])
        .find((item) => item.tradeDate === tradeDate);
      const reportedPrice = positiveFiniteOrNull(
        execution.reportedPrice
          ?? execution.priceAudit?.reportedValue
          ?? execution.price,
      );
      const marketReference = candle
        ? {
          status: "available",
          source: "Longbridge candlesticks",
          period: "day",
          adjustment: "none",
          tradeSessions: "intraday",
          tradeDate,
          low: candle.low,
          high: candle.high,
          reportedPriceInsideRange: reportedPrice != null
            ? reportedPrice >= candle.low && reportedPrice <= candle.high
            : null,
          checkedAt,
        }
        : {
          status: "unavailable",
          source: "Longbridge candlesticks",
          period: "day",
          adjustment: "none",
          tradeSessions: "intraday",
          tradeDate,
          low: null,
          high: null,
          reportedPriceInsideRange: null,
          checkedAt,
        };
      return {
        ...execution,
        priceAudit: {
          ...(execution.priceAudit ?? {}),
          marketReference,
        },
      };
    });
  }

  async #backfillMissingParentOrders({ orders, executions, warnings }) {
    const knownOrderIds = new Set(orders.map((item) => cleanId(item?.orderId)).filter(Boolean));
    const missingOrderIds = [...new Set(executions
      .map((item) => cleanId(item?.order_id ?? item?.orderId))
      .filter((orderId) => orderId && !knownOrderIds.has(orderId)))];
    const base = {
      status: "not_needed",
      discoveredOrderCount: missingOrderIds.length,
      attemptedOrderCount: 0,
      recoveredOrderCount: 0,
      recoveredAttachedOrderCount: 0,
      failedOrderCount: 0,
      deferredOrderCount: 0,
      queryCallCount: 0,
      retryCallCount: 0,
      orders: [],
    };
    if (!missingOrderIds.length) return base;
    if (!this.longbridge.supports("order_detail")) {
      warnings.push(
        `订单证据回填：${missingOrderIds.length} 个成交父订单缺失，但当前长桥只读接口未开放 order_detail；原成交已保留，方向、币种和价格审计不会猜测或填 0。`,
      );
      return {
        ...base,
        status: "unavailable",
        deferredOrderCount: missingOrderIds.length,
      };
    }

    const targets = missingOrderIds.slice(0, ORDER_DETAIL_BACKFILL_LIMIT);
    const deferredOrderCount = missingOrderIds.length - targets.length;
    if (deferredOrderCount) {
      warnings.push(
        `订单证据回填：发现 ${missingOrderIds.length} 个唯一缺失父订单；本次按只读限额查询 ${targets.length} 个，其余 ${deferredOrderCount} 个留待后续同步。`,
      );
    }
    const results = await mapWithConcurrency(
      targets,
      ORDER_DETAIL_BACKFILL_CONCURRENCY,
      (orderId) => this.#fetchMissingParentOrder(orderId),
    );
    const recovered = results.filter((item) => item.order);
    const failedOrderCount = results.length - recovered.length;
    const recoveredAttachedOrderCount = recovered.filter((item) => item.attached).length;
    const queryCallCount = results.reduce((total, item) => total + item.queryCallCount, 0);
    const retryCallCount = results.reduce((total, item) => total + item.retryCallCount, 0);
    if (failedOrderCount) {
      warnings.push(
        `订单证据回填：恢复 ${recovered.length} 个父订单（attached ${recoveredAttachedOrderCount} 个），${failedOrderCount} 个详情查询失败；相关原成交继续保留，缺失字段未填 0。`,
      );
    }
    return {
      ...base,
      status: failedOrderCount || deferredOrderCount ? "degraded" : "ready",
      attemptedOrderCount: targets.length,
      recoveredOrderCount: recovered.length,
      recoveredAttachedOrderCount,
      failedOrderCount,
      deferredOrderCount,
      queryCallCount,
      retryCallCount,
      orders: recovered.map((item) => item.order),
    };
  }

  async #fetchMissingParentOrder(orderId) {
    let queryCallCount = 0;
    let retryCallCount = 0;
    const query = async (isAttached) => {
      let lastError = null;
      for (let attempt = 1; attempt <= ORDER_DETAIL_MAX_ATTEMPTS; attempt += 1) {
        queryCallCount += 1;
        try {
          const payload = await this.#rateLimitedOrderDetailCall({
            order_id: orderId,
            is_attached: isAttached,
          });
          const order = extractExactOrderDetail(payload, orderId);
          if (order) return { order, exhaustedRetryableError: false, terminalError: false };
          lastError = new Error("order_detail 未返回匹配的父订单证据");
          break;
        } catch (error) {
          lastError = error;
          if (error?.reauth === true || error?.kind === "permission" || error?.kind === "auth") {
            return { order: null, exhaustedRetryableError: false, terminalError: true };
          }
          if (error?.retryable !== true || attempt >= ORDER_DETAIL_MAX_ATTEMPTS) break;
          retryCallCount += 1;
          await wait(ORDER_DETAIL_RETRY_DELAY_MS * attempt);
        }
      }
      return {
        order: null,
        exhaustedRetryableError: lastError?.retryable === true,
        terminalError: false,
      };
    };

    const normal = await query(false);
    if (normal.order) {
      return { order: normal.order, attached: false, queryCallCount, retryCallCount };
    }
    // A transport/rate-limit timeout after its single bounded retry gives us
    // no evidence that the ID is an attached order. Stop here rather than
    // doubling pressure on an unhealthy broker connection.
    if (normal.exhaustedRetryableError || normal.terminalError) {
      return { order: null, attached: false, queryCallCount, retryCallCount };
    }
    const attached = await query(true);
    return {
      order: attached.order,
      attached: Boolean(attached.order),
      queryCallCount,
      retryCallCount,
    };
  }

  async #rateLimitedOrderDetailCall(args) {
    const start = this.orderDetailStartQueue.then(async () => {
      const elapsed = Date.now() - this.orderDetailLastStartedAt;
      const remaining = this.orderDetailMinIntervalMs - elapsed;
      if (remaining > 0) await wait(remaining);
      this.orderDetailLastStartedAt = Date.now();
    });
    this.orderDetailStartQueue = start.catch(() => {});
    await start;
    return this.longbridge.call("order_detail", args);
  }

  async #fetchWindows(tool, range, symbol, listKey, warnings, diagnostics) {
    const rows = [];
    for (const window of splitRange(range.startMs, range.endMs, API_WINDOW_DAYS)) {
      rows.push(...await this.#fetchWindow(tool, window, symbol, listKey, warnings, diagnostics));
      // A failure before this stream has returned any successful page is
      // normally systemic (authorization, transport, gateway, or schema), not
      // date-window-specific. Do not repeat the same failing request for every
      // 90-day slice before returning an actionable error.
      if (diagnostics.succeeded === 0 && diagnostics.failed > 0) {
        diagnostics.abortedEarly = true;
        break;
      }
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
      if (isTradeHistoryScopeError(error)) {
        const authorizationError = tradeHistoryAuthorizationError(error);
        this.onStatus({
          state: "scope_upgrade_required",
          message: "长桥历史查询需要升级只读授权",
          detail: authorizationError.message,
        });
        throw authorizationError;
      }
      if (error?.reauth === true) throw error;
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

  async #fetchFinanceCalendar(windows, symbols, warnings, existingCoverage = []) {
    if (!symbols.size) return { events: [], coverage: [] };
    const symbolsByMarket = groupSymbolsByMarket(symbols);
    const now = Date.now();
    const tasks = [];
    for (const [market, marketSymbols] of symbolsByMarket) {
      for (const broadWindow of windows) {
        for (const window of splitRange(broadWindow.startMs, broadWindow.endMs, 31)) {
          if (financeCoverageContains(existingCoverage, market, marketSymbols, window, now)) continue;
          tasks.push({ market, marketSymbols, window });
        }
      }
    }
    const results = await mapWithConcurrency(tasks, FINANCE_CALENDAR_CONCURRENCY, async ({
      market,
      marketSymbols,
      window,
    }) => {
      try {
        const payload = await this.longbridge.call("finance_calendar", {
          category: "report",
          start: isoDate(window.startMs),
          end: isoDate(window.endMs),
          market,
        });
        return {
          events: extractFinanceCalendarRows(payload)
            .map(normalizeFinanceEvent)
            .filter((item) => item && marketSymbols.has(item.symbol)),
          coverage: {
            market,
            symbols: [...marketSymbols].sort(),
            startAt: new Date(window.startMs).toISOString(),
            endAt: new Date(window.endMs).toISOString(),
            queriedAt: new Date().toISOString(),
          },
        };
      } catch (error) {
        warnings.push(`finance_calendar(${market}): ${safeMessage(error)}`);
        return { events: [], coverage: null };
      }
    });
    return {
      events: results.flatMap((item) => item.events),
      coverage: results.map((item) => item.coverage).filter(Boolean),
    };
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
  includeExcludedOrders = false,
} = {}) {
  const normalized = normalizeArchive(archive);
  const normalizedSymbol = normalizeSymbol(symbol);
  const fromMs = parseOptionalDate(from);
  const toMs = parseOptionalDate(to);
  const needle = String(query ?? "").trim().toUpperCase().slice(0, 80);
  const executionEligibility = partitionReviewExecutions(normalized.executions, normalized.orders);
  const orderEligibility = partitionReviewOrders(normalized.orders, normalized.executions);
  const eligibleOrders = orderEligibility.included.map((item) => publicOrderRecord(item, {
    reviewEligibility: { status: "included", reason: null },
  }));
  const excludedOrders = orderEligibility.excluded.map(({ order, reason }) => publicOrderRecord(order, {
    reviewEligibility: { status: "audit_only", reason },
  }));
  const matchesIntakeFilter = (item) => {
    const timeMs = Date.parse(item.activityAt ?? "");
    if (normalizedSymbol && item.symbol !== normalizedSymbol) return false;
    if (fromMs != null && !(timeMs >= fromMs)) return false;
    if (toMs != null && !(timeMs <= toMs)) return false;
    if (needle && !`${item.symbol} ${item.side ?? ""} ${item.status ?? ""}`.toUpperCase().includes(needle)) return false;
    return true;
  };
  const excludedExecutions = executionEligibility.excluded.map(({ execution, reason }) => publicExecutionRecord(execution, {
    reviewEligibility: { status: "audit_only", reason },
  }));
  const matchingExcludedOrders = excludedOrders.filter(matchesIntakeFilter);
  const matchingExcludedExecutions = excludedExecutions.filter(matchesIntakeFilter);
  const records = [
    ...eligibleOrders,
    ...(includeExcludedOrders === true ? excludedOrders : []),
    ...executionEligibility.included.map((item) => publicExecutionRecord(item, {
      reviewEligibility: { status: "included", reason: null },
    })),
    ...(includeExcludedOrders === true ? excludedExecutions : []),
  ].filter(matchesIntakeFilter).sort(sortNewest("activityAt"));
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
    parentOrderBackfill: normalized.parentOrderBackfill,
    warnings: normalized.warnings,
    records: page,
    eventCandidates,
    totalRecordCount: records.length,
    offset: safeOffset,
    limit: safeLimit,
    nextOffset: safeOffset + page.length < records.length ? safeOffset + page.length : null,
    orderCount: normalized.orders.length,
    eligibleOrderCount: orderEligibility.included.length,
    excludedOrderAudit: {
      totalCount: orderEligibility.excluded.length,
      matchingFilterCount: matchingExcludedOrders.length,
      visible: includeExcludedOrders === true,
      byReason: countExcludedOrderReasons(orderEligibility.excluded),
    },
    excludedExecutionAudit: {
      totalCount: executionEligibility.excluded.length,
      matchingFilterCount: matchingExcludedExecutions.length,
      visible: includeExcludedOrders === true,
      byReason: countExcludedExecutionReasons(executionEligibility.excluded),
    },
    eligibleExecutionCount: executionEligibility.included.length,
    executionCount: normalized.executions.length,
    executionPriceCoverage: {
      accepted: normalized.executions.filter((item) => item?.priceAudit?.status === "accepted").length,
      excluded: normalized.executions.filter((item) => item?.priceAudit?.status === "excluded").length,
      unavailable: normalized.executions.filter((item) => item?.priceAudit?.status === "unavailable").length,
    },
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

/**
 * Resolve an arbitrary review-cycle selection without assigning an earnings
 * event. This preserves parent-order/fill closure and encrypted-archive
 * validation while allowing multi-symbol monthly portfolio cycles.
 */
export function resolveBrokerRecordSelection(archive, { recordIds = [] } = {}) {
  const normalized = normalizeArchive(archive);
  const selected = resolveArchivedRecords(normalized, recordIds);
  return {
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
  const executionEligibility = partitionReviewExecutions(archive.executions, archive.orders);
  const excludedExecutionIds = new Set(executionEligibility.excluded.map(({ execution }) => execution.tradeId));
  if ([...selectedExecutionIds].some((tradeId) => excludedExecutionIds.has(tradeId))) {
    throw new Error("所选记录包含方向、数量、时间或成交价不可核验的成交；这些记录只供审计查看，不能作为默认复盘证据。");
  }
  const excludedOrderIds = new Set(partitionReviewOrders(archive.orders, archive.executions)
    .excluded.map(({ order }) => order.orderId));
  if ([...selectedOrderIds].some((orderId) => excludedOrderIds.has(orderId))) {
    throw new Error("所选记录包含未成交、取消、拒绝或过期订单；这些记录只供审计查看，不能作为默认复盘证据。");
  }

  // Broker records form a closed decision package: selecting a fill brings in
  // its parent order, while selecting an order brings in every archived fill.
  // Every automatically included ID is resolved from the encrypted archive.
  const orderByBrokerId = new Map(archive.orders.map((item) => [item.orderId, item]));
  for (const execution of executionEligibility.included) {
    if (selectedExecutionIds.has(execution.tradeId) && orderByBrokerId.has(execution.orderId)) {
      selectedOrderIds.add(execution.orderId);
    }
  }
  for (const execution of executionEligibility.included) {
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
      orderDetail: false,
      financeCalendar: false,
    },
    warnings: [],
    completeness: {
      orders: "not_synced",
      executions: "not_synced",
    },
    parentOrderBackfill: emptyParentOrderBackfill(),
    orders: [],
    executions: [],
    events: [],
    eventCoverage: [],
  };
}

function normalizeArchive(value) {
  if (!value || ![1, SCHEMA_VERSION].includes(value.schemaVersion)) return emptyArchive();
  const archive = emptyArchive();
  const normalized = structuredClone({
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
    parentOrderBackfill: normalizeParentOrderBackfill(value.parentOrderBackfill),
    orders: Array.isArray(value.orders) ? value.orders.map(normalizeOrder).filter(Boolean).slice(0, 20_000) : [],
    executions: normalizeStoredExecutions(value.executions, value.orders),
    events: Array.isArray(value.events) ? value.events.map(normalizeFinanceEvent).filter(Boolean).slice(0, 10_000) : [],
    eventCoverage: normalizeFinanceCoverage(value.eventCoverage),
  });
  const reconciled = auditBrokerPackages(normalized.orders, normalized.executions);
  normalized.orders = reconciled.orders;
  normalized.executions = reconciled.executions;
  const excludedExecutions = partitionReviewExecutions(
    normalized.executions,
    normalized.orders,
  ).excluded;
  const multiLegAuditCount = excludedExecutions.filter((item) => [
    "multileg_order_unmodeled",
    "possible_multileg_missing_leg_metadata",
  ].includes(item.reason)).length;
  const unmatchedParentCount = excludedExecutions
    .filter((item) => item.reason === "parent_order_unmatched").length;
  const priceEvidenceCount = excludedExecutions
    .filter((item) => item.reason === "price_unverified").length;
  if (multiLegAuditCount || unmatchedParentCount || priceEvidenceCount) {
    normalized.warnings = [...new Set([
      ...normalized.warnings,
      ...(multiLegAuditCount
        ? [`${multiLegAuditCount} 条成交属于显式多腿组合或父单/成交数量不守恒；已整组移入排除审计，不按股票成交或 P&L 解释。`]
        : []),
      ...(unmatchedParentCount
        ? [`${unmatchedParentCount} 条股票成交缺少可匹配父订单；方向、币种与证券语义未恢复前只供审计。`]
        : []),
      ...(priceEvidenceCount
        ? [`${priceEvidenceCount} 条成交缺少可核验价格证据；原始 execution.price 已保留审计，但不作为成交价展示。`]
        : []),
    ])].slice(0, 20);
  }
  return normalized;
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

function emptyParentOrderBackfill() {
  return {
    status: "not_needed",
    discoveredOrderCount: 0,
    attemptedOrderCount: 0,
    recoveredOrderCount: 0,
    recoveredAttachedOrderCount: 0,
    failedOrderCount: 0,
    deferredOrderCount: 0,
    queryCallCount: 0,
    retryCallCount: 0,
  };
}

function normalizeParentOrderBackfill(value) {
  const result = emptyParentOrderBackfill();
  const statuses = new Set(["not_needed", "ready", "degraded", "unavailable"]);
  if (!value || typeof value !== "object") return result;
  result.status = statuses.has(value.status) ? value.status : result.status;
  for (const key of Object.keys(result).filter((item) => item.endsWith("Count"))) {
    result[key] = nonNegativeInteger(value[key]);
  }
  return result;
}

function normalizeFinanceCoverage(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const market = cleanText(item?.market, 8)?.toUpperCase();
    const symbols = [...new Set((Array.isArray(item?.symbols) ? item.symbols : [])
      .map(normalizeSymbol)
      .filter(Boolean))].sort();
    const startAt = timestampToIso(item?.startAt);
    const endAt = timestampToIso(item?.endAt);
    const queriedAt = timestampToIso(item?.queriedAt);
    if (!market || !symbols.length || !startAt || !endAt || !queriedAt) return null;
    return { market, symbols, startAt, endAt, queriedAt };
  }).filter(Boolean).slice(-2_000);
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
  return { attempted: 0, succeeded: 0, failed: 0, abortedEarly: false };
}

function isTradeHistoryScopeError(error) {
  return error?.kind === "permission"
    && error?.reauth === true
    && Number(error?.code) === 403308;
}

function tradeHistoryAuthorizationError(cause) {
  const error = new Error(
    "长桥拒绝历史订单与成交查询（403308）：旧授权只有账户/持仓读取权限。请点击顶部“升级只读授权”完成一次重新授权；不会申请下单权限，现有历史缓存也未被改写。",
    { cause },
  );
  error.name = "TradeHistoryAuthorizationError";
  error.kind = "permission";
  error.code = 403308;
  error.retryable = false;
  error.reauth = true;
  return error;
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
    executedQuantity: finiteOrNull(
      value.executed_quantity
        ?? value.executedQuantity
        ?? value.executed_qty
        ?? value.executedQty,
    ),
    submittedPrice: finiteOrNull(
      value.price
        ?? value.submitted_price
        ?? value.submittedPrice
        ?? value.submit_price
        ?? value.submitPrice,
    ),
    executedPrice: finiteOrNull(value.executed_price ?? value.executedPrice),
    currency: cleanCurrency(
      value.currency
        ?? value.charge_detail?.currency
        ?? value.chargeDetail?.currency,
    ),
    submittedAt: timestampToIso(value.submitted_at ?? value.submittedAt),
    updatedAt: timestampToIso(value.updated_at ?? value.updatedAt),
    multiLeg: normalizeMultiLeg(value.multi_leg ?? value.multiLeg),
    source: "Longbridge",
  };
}

function normalizeMultiLeg(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const legs = (Array.isArray(value.legs) ? value.legs : [])
    .map((leg) => {
      if (!leg || typeof leg !== "object") return null;
      const symbol = normalizeSymbol(leg.symbol ?? leg.code);
      const side = cleanText(leg.side, 20);
      const position = cleanText(leg.position, 20);
      const ratioQuantity = finiteOrNull(
        leg.ratio_quantity
          ?? leg.ratioQuantity
          ?? leg.quantity,
      );
      const strikePrice = finiteOrNull(leg.strike_price ?? leg.strikePrice);
      const expireDate = cleanText(leg.expire_date ?? leg.expireDate, 16);
      const contractDirection = cleanText(
        leg.contract_direction ?? leg.contractDirection,
        12,
      );
      if (!symbol && !side && !position && ratioQuantity == null
          && strikePrice == null && !expireDate && !contractDirection) return null;
      return {
        symbol,
        side,
        position,
        ratioQuantity,
        strikePrice,
        expireDate,
        contractDirection,
      };
    })
    .filter(Boolean)
    .slice(0, 20);
  const strategy = cleanText(value.strategy, 40);
  const strategyName = cleanText(value.strategy_name ?? value.strategyName, 80);
  const multiLegId = cleanId(value.multileg_id ?? value.multiLegId ?? value.multi_leg_id);
  const code = cleanText(value.code, 160);
  if (!strategy && !strategyName && !multiLegId && !code && !legs.length) return null;
  return { strategy, strategyName, multiLegId, code, legs };
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
  const side = cleanText(value.side ?? order?.side, 20);
  const currency = cleanCurrency(value.currency ?? order?.currency);
  const reportedPrice = finiteOrNull(
    value.reportedPrice
      ?? value.priceAudit?.reportedValue
      ?? value.price,
  );
  const priceAudit = assessExecutionPrice({
    symbol,
    reportedPrice,
    order,
    side,
    currency,
    previousAudit: value.priceAudit,
  });
  return {
    tradeId,
    orderId,
    symbol,
    side,
    quantity: finiteOrNull(value.quantity),
    price: priceAudit.status === "accepted" ? reportedPrice : null,
    reportedPrice,
    priceAudit,
    currency,
    doneAt: timestampToIso(value.trade_done_at ?? value.doneAt ?? value.tradeDoneAt),
    source: "Longbridge",
  };
}

function assessExecutionPrice({ symbol, reportedPrice, order, side, currency, previousAudit = null }) {
  const instrumentType = inferInstrumentType(symbol);
  const parentOrderMatched = Boolean(order);
  const sideResolved = Boolean(side);
  const currencyResolved = Boolean(currency);
  const sourceField = "Longbridge history_executions.price";
  if (reportedPrice == null) {
    return {
      status: "unavailable",
      sourceField,
      reportedValue: null,
      reason: "execution_price_missing",
      instrumentType,
      parentOrderMatched,
      sideResolved,
      currencyResolved,
      marketReference: publicMarketReference(previousAudit?.marketReference),
    };
  }
  // An option contract symbol gives the number an unambiguous premium
  // meaning even when an old parent order has fallen outside the archive.
  // For an equity-labelled orphan, a number with no parent order, side, or
  // currency lacks enough field semantics to call it an execution price.
  // No numerical threshold is involved in this decision.
  const unverifiedOrphanEquity = instrumentType === "equity"
    && !parentOrderMatched
    && !sideResolved
    && !currencyResolved;
  return {
    status: unverifiedOrphanEquity ? "excluded" : "accepted",
    sourceField,
    reportedValue: reportedPrice,
    reason: unverifiedOrphanEquity
      ? "orphan_equity_execution_missing_parent_side_currency"
      : null,
    instrumentType,
    parentOrderMatched,
    sideResolved,
    currencyResolved,
    marketReference: publicMarketReference(previousAudit?.marketReference),
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

function publicOrderRecord(value, { reviewEligibility = null } = {}) {
  const executedPrice = finiteOrNull(value.executedPrice);
  const submittedPrice = finiteOrNull(value.submittedPrice);
  return {
    recordId: `order:${value.orderId}`,
    kind: "order",
    symbol: value.symbol,
    side: value.side,
    status: value.status,
    orderType: value.orderType,
    quantity: value.quantity,
    executedQuantity: value.executedQuantity,
    // A limit/submission price is an instruction, not a fill. Never expose it
    // through the generic price field as though it were an executed price.
    price: executedPrice,
    priceBasis: executedPrice != null
      ? "executed"
      : submittedPrice != null
        ? "submitted_only"
        : "unavailable",
    submittedPrice,
    executedPrice,
    currency: value.currency,
    activityAt: value.submittedAt ?? value.updatedAt,
    multiLeg: publicMultiLeg(value.multiLeg),
    brokerEvidenceAudit: publicBrokerEvidenceAudit(value.brokerEvidenceAudit),
    source: "Longbridge · read only",
    ...(reviewEligibility ? { reviewEligibility } : {}),
  };
}

/**
 * A reviewable order must carry evidence that some trade actually occurred.
 * A cancelled terminal state does not disqualify a partially-filled order;
 * submission alone is never treated as an execution fact.
 */
export function partitionReviewOrders(orders = [], executions = []) {
  const audited = auditBrokerPackages(orders, executions);
  const executionOrderIds = new Set(audited.executions
    .map((item) => cleanId(item?.orderId ?? item?.order_id))
    .filter(Boolean));
  const included = [];
  const excluded = [];
  for (const order of audited.orders) {
    if (!order || typeof order !== "object") continue;
    if (order?.brokerEvidenceAudit?.status === "excluded") {
      excluded.push({ order, reason: order.brokerEvidenceAudit.reason });
      continue;
    }
    const orderId = cleanId(order.orderId ?? order.order_id ?? order.id);
    const executedQuantity = finiteOrNull(
      order.executedQuantity
        ?? order.executed_quantity
        ?? order.executedQty
        ?? order.executed_qty,
    );
    const statusToken = String(order.status ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
    const statusProvesFill = [
      "filled",
      "filledstatus",
      "partialfilled",
      "partialfilledstatus",
      "partiallyfilled",
      "partiallyfilledstatus",
      "partialwithdrawal",
    ].includes(statusToken);
    if ((orderId && executionOrderIds.has(orderId)) || (executedQuantity != null && executedQuantity > 0) || statusProvesFill) {
      included.push(order);
      continue;
    }
    excluded.push({ order, reason: excludedOrderReason(statusToken) });
  }
  return { included, excluded };
}

/** An execution is analyzable only when its core broker facts are verifiable. */
export function partitionReviewExecutions(executions = [], orders = []) {
  const audited = auditBrokerPackages(orders, executions);
  const included = [];
  const excluded = [];
  for (const execution of audited.executions) {
    if (!execution || typeof execution !== "object") continue;
    const reason = excludedExecutionReason(execution);
    if (reason) excluded.push({ execution, reason });
    else included.push(execution);
  }
  return { included, excluded };
}

function excludedExecutionReason(execution) {
  if (execution?.brokerEvidenceAudit?.status === "excluded") {
    return execution.brokerEvidenceAudit.reason;
  }
  if (!normalizeSymbol(execution?.symbol)) return "symbol_missing";
  const side = String(execution?.side ?? "").trim().toLowerCase();
  if (!new Set(["buy", "sell"]).has(side)) return "side_unverified";
  const quantity = finiteOrNull(execution?.quantity);
  if (quantity == null || quantity <= 0) return "quantity_unverified";
  if (!timestampToIso(execution?.doneAt ?? execution?.trade_done_at ?? execution?.tradeDoneAt)) return "time_unverified";
  if (String(execution?.priceAudit?.status ?? "accepted").toLowerCase() !== "accepted") return "price_unverified";
  const price = finiteOrNull(execution?.price);
  if (price == null || price <= 0) return "price_unverified";
  return null;
}

/**
 * Reconcile parent orders with their child executions before anything can be
 * presented as a stock trade. Longbridge can flatten multi-leg option orders
 * under the root equity symbol while returning both the net combo execution
 * and individual leg executions. Treating those rows as shares invents trades
 * and P&L, so explicit multi-leg metadata or an impossible quantity package is
 * fail-closed into the audit lane.
 */
function auditBrokerPackages(orders = [], executions = []) {
  const orderList = (Array.isArray(orders) ? orders : [])
    .filter((item) => item && typeof item === "object")
    .map((item) => ({ ...item }));
  const executionList = (Array.isArray(executions) ? executions : [])
    .filter((item) => item && typeof item === "object")
    .map((item) => ({ ...item }));
  const orderById = new Map(orderList
    .map((order) => [cleanId(order?.orderId ?? order?.order_id ?? order?.id), order])
    .filter(([orderId]) => Boolean(orderId)));
  const executionsByOrderId = new Map();
  for (const execution of executionList) {
    const orderId = cleanId(execution?.orderId ?? execution?.order_id);
    if (!orderId) continue;
    if (!executionsByOrderId.has(orderId)) executionsByOrderId.set(orderId, []);
    executionsByOrderId.get(orderId).push(execution);
  }
  const packageAuditByOrderId = new Map();
  for (const [orderId, order] of orderById) {
    const children = executionsByOrderId.get(orderId) ?? [];
    const explicitMultiLeg = normalizeMultiLeg(order.multiLeg ?? order.multi_leg);
    const expectedQuantity = positiveFiniteOrNull(
      order.executedQuantity
        ?? order.executed_quantity
        ?? order.executedQty
        ?? order.executed_qty,
    );
    const childQuantities = children.map((item) => positiveFiniteOrNull(item?.quantity));
    const knownChildQuantities = childQuantities.filter((item) => item != null);
    const childQuantityTotal = knownChildQuantities.reduce((sum, value) => sum + value, 0);
    const quantityExceedsParent = expectedQuantity != null
      && knownChildQuantities.length === children.length
      && quantityGreaterThan(childQuantityTotal, expectedQuantity);
    const parentSymbol = normalizeSymbol(order.symbol);
    const parentSide = normalizedSide(order.side);
    const parentCurrency = cleanCurrency(order.currency);
    const fieldConflicts = children.flatMap((execution) => {
      const conflicts = [];
      const executionSymbol = normalizeSymbol(execution.symbol);
      const executionSide = normalizedSide(execution.side);
      const executionCurrency = cleanCurrency(execution.currency);
      if (parentSymbol && executionSymbol && executionSymbol !== parentSymbol) conflicts.push("symbol");
      if (parentSide && executionSide && executionSide !== parentSide) conflicts.push("side");
      if (parentCurrency && executionCurrency && executionCurrency !== parentCurrency) conflicts.push("currency");
      return conflicts;
    });
    const reason = explicitMultiLeg
      ? "multileg_order_unmodeled"
      : quantityExceedsParent
        ? "possible_multileg_missing_leg_metadata"
        : fieldConflicts.length
          ? "parent_execution_fields_conflict"
          : null;
    if (!reason) continue;
    const parentExecutedPrice = positiveFiniteOrNull(order.executedPrice ?? order.executed_price);
    const executionPrices = children
      .map((item) => positiveFiniteOrNull(item.reportedPrice ?? item.priceAudit?.reportedValue ?? item.price))
      .filter((item) => item != null);
    packageAuditByOrderId.set(orderId, {
      status: "excluded",
      reason,
      instrumentType: explicitMultiLeg ? "multi_leg" : inferInstrumentType(parentSymbol),
      orderId,
      sourceFields: [
        "Longbridge history_orders",
        "Longbridge history_executions",
      ],
      parentExecutedQuantity: expectedQuantity,
      childExecutionCount: children.length,
      childExecutionQuantity: knownChildQuantities.length === children.length
        ? childQuantityTotal
        : null,
      parentExecutedPrice,
      childExecutionPrices: executionPrices.slice(0, 20),
      netAndLegPricePattern: detectsNetAndLegPricePattern(parentExecutedPrice, executionPrices),
      conflictingFields: [...new Set(fieldConflicts)],
      explicitMultiLeg: explicitMultiLeg ? publicMultiLeg(explicitMultiLeg) : null,
    });
  }
  const auditedOrders = orderList.map((order) => {
    const audit = packageAuditByOrderId.get(cleanId(order?.orderId ?? order?.order_id ?? order?.id));
    return audit ? { ...order, brokerEvidenceAudit: audit } : order;
  });
  const auditedExecutions = executionList.map((execution) => {
    const audit = packageAuditByOrderId.get(cleanId(execution?.orderId ?? execution?.order_id));
    if (!audit) return execution;
    const originalAudit = execution.priceAudit && typeof execution.priceAudit === "object"
      ? execution.priceAudit
      : {};
    return {
      ...execution,
      price: null,
      brokerEvidenceAudit: audit,
      priceAudit: {
        ...originalAudit,
        status: "excluded",
        reason: audit.reason,
        consistencyAudit: audit,
      },
    };
  });
  return { orders: auditedOrders, executions: auditedExecutions };
}

function positiveFiniteOrNull(value) {
  const result = finiteOrNull(value);
  return result != null && result > 0 ? result : null;
}

function normalizedSide(value) {
  const side = String(value ?? "").trim().toLowerCase();
  return new Set(["buy", "sell"]).has(side) ? side : null;
}

function quantityGreaterThan(actual, expected) {
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  return actual - expected > Number.EPSILON * scale * 16;
}

function detectsNetAndLegPricePattern(parentPrice, executionPrices) {
  if (!(parentPrice > 0) || executionPrices.length < 3) return false;
  const tolerance = decimalEvidenceTolerance([parentPrice, ...executionPrices]);
  const includesParentNet = executionPrices.some((price) => Math.abs(price - parentPrice) <= tolerance);
  const containsLegDifference = executionPrices.some((left, leftIndex) => executionPrices.some(
    (right, rightIndex) => leftIndex !== rightIndex
      && Math.abs(Math.abs(left - right) - parentPrice) <= tolerance,
  ));
  return includesParentNet && containsLegDifference;
}

function decimalEvidenceTolerance(values) {
  const decimals = values.reduce((maximum, value) => {
    const text = String(value);
    const fraction = text.includes(".") ? text.split(".")[1].length : 0;
    return Math.max(maximum, Math.min(fraction, 8));
  }, 0);
  return Math.max(Number.EPSILON * 16, 0.5 * (10 ** -decimals));
}

function excludedOrderReason(statusToken) {
  if (/cancel|withdraw/.test(statusToken)) return "cancelled_unfilled";
  if (/reject/.test(statusToken)) return "rejected_unfilled";
  if (/expir/.test(statusToken)) return "expired_unfilled";
  if (/wait|pending|new|submit|protect|inactive|report|replace/.test(statusToken)) return "open_or_pending_unfilled";
  return "unfilled_or_unverified";
}

function countExcludedOrderReasons(excluded) {
  const counts = {
    cancelled_unfilled: 0,
    rejected_unfilled: 0,
    expired_unfilled: 0,
    open_or_pending_unfilled: 0,
    unfilled_or_unverified: 0,
  };
  for (const item of excluded) {
    if (item?.reason) counts[item.reason] = (counts[item.reason] ?? 0) + 1;
  }
  return counts;
}

function countExcludedExecutionReasons(excluded) {
  const counts = {
    symbol_missing: 0,
    side_unverified: 0,
    quantity_unverified: 0,
    time_unverified: 0,
    price_unverified: 0,
  };
  for (const item of excluded) {
    if (item?.reason) counts[item.reason] = (counts[item.reason] ?? 0) + 1;
  }
  return counts;
}

function publicExecutionRecord(value, { reviewEligibility = null } = {}) {
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
    reportedPrice: value.reportedPrice,
    priceAudit: publicPriceAudit(value.priceAudit),
    currency: value.currency,
    activityAt: value.doneAt,
    source: "Longbridge · read only",
    ...(reviewEligibility ? { reviewEligibility } : {}),
  };
}

function publicPriceAudit(value) {
  if (!value || typeof value !== "object") return null;
  return {
    status: cleanText(value.status, 30),
    sourceField: cleanText(value.sourceField, 120),
    reportedValue: finiteOrNull(value.reportedValue),
    reason: cleanText(value.reason, 160),
    instrumentType: cleanText(value.instrumentType, 30),
    parentOrderMatched: value.parentOrderMatched === true,
    sideResolved: value.sideResolved === true,
    currencyResolved: value.currencyResolved === true,
    consistencyAudit: publicBrokerEvidenceAudit(value.consistencyAudit),
    marketReference: publicMarketReference(value.marketReference),
  };
}

function publicMultiLeg(value) {
  const normalized = normalizeMultiLeg(value);
  if (!normalized) return null;
  return {
    strategy: normalized.strategy,
    strategyName: normalized.strategyName,
    multiLegId: normalized.multiLegId,
    code: normalized.code,
    legs: normalized.legs.map((leg) => ({ ...leg })),
  };
}

function publicBrokerEvidenceAudit(value) {
  if (!value || typeof value !== "object") return null;
  return {
    status: value.status === "excluded" ? "excluded" : "accepted",
    reason: cleanText(value.reason, 120),
    instrumentType: cleanText(value.instrumentType, 30),
    orderId: cleanId(value.orderId),
    sourceFields: (Array.isArray(value.sourceFields) ? value.sourceFields : [])
      .map((item) => cleanText(item, 120))
      .filter(Boolean)
      .slice(0, 10),
    parentExecutedQuantity: finiteOrNull(value.parentExecutedQuantity),
    childExecutionCount: nonNegativeInteger(value.childExecutionCount),
    childExecutionQuantity: finiteOrNull(value.childExecutionQuantity),
    parentExecutedPrice: finiteOrNull(value.parentExecutedPrice),
    childExecutionPrices: (Array.isArray(value.childExecutionPrices) ? value.childExecutionPrices : [])
      .map(finiteOrNull)
      .filter((item) => item != null)
      .slice(0, 20),
    netAndLegPricePattern: value.netAndLegPricePattern === true,
    conflictingFields: (Array.isArray(value.conflictingFields) ? value.conflictingFields : [])
      .map((item) => cleanText(item, 40))
      .filter(Boolean)
      .slice(0, 10),
    explicitMultiLeg: publicMultiLeg(value.explicitMultiLeg),
  };
}

function publicMarketReference(value) {
  if (!value || typeof value !== "object") return null;
  return {
    status: value.status === "available" ? "available" : "unavailable",
    source: cleanText(value.source, 120),
    period: cleanText(value.period, 20),
    adjustment: cleanText(value.adjustment, 30),
    tradeSessions: cleanText(value.tradeSessions, 30),
    tradeDate: cleanDate(value.tradeDate),
    low: finiteOrNull(value.low),
    high: finiteOrNull(value.high),
    reportedPriceInsideRange: typeof value.reportedPriceInsideRange === "boolean"
      ? value.reportedPriceInsideRange
      : null,
    checkedAt: timestampToIso(value.checkedAt),
  };
}

function publicParentOrderBackfill(value) {
  return normalizeParentOrderBackfill(value);
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

function extractExactOrderDetail(payload, expectedOrderId) {
  const value = unwrapData(payload);
  const candidates = [
    value,
    value?.order,
    value?.order_detail,
    value?.orderDetail,
    ...(Array.isArray(value?.orders) ? value.orders : []),
    ...(Array.isArray(value) ? value : []),
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const candidateOrderId = cleanId(candidate.order_id ?? candidate.orderId ?? candidate.id);
    if (candidateOrderId !== expectedOrderId) continue;
    const normalized = normalizeOrder(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function mergeFinanceCoverage(previous, next) {
  const values = new Map();
  for (const item of normalizeFinanceCoverage([...(previous ?? []), ...(next ?? [])])) {
    const key = `${item.market}:${item.symbols.join(",")}:${item.startAt}:${item.endAt}`;
    const current = values.get(key);
    if (!current || Date.parse(item.queriedAt) >= Date.parse(current.queriedAt)) values.set(key, item);
  }
  return [...values.values()]
    .sort((left, right) => Date.parse(left.queriedAt) - Date.parse(right.queriedAt))
    .slice(-2_000);
}

function financeCoverageContains(coverage, market, symbols, window, now = Date.now()) {
  const requiredSymbols = [...symbols];
  const fresh = normalizeFinanceCoverage(coverage)
    .filter((item) => item.market === market)
    .filter((item) => requiredSymbols.every((symbol) => item.symbols.includes(symbol)))
    .filter((item) => now - Date.parse(item.queriedAt) <= FINANCE_CALENDAR_CACHE_TTL_MS)
    .map((item) => ({ startMs: Date.parse(item.startAt), endMs: Date.parse(item.endAt) }))
    .filter((item) => Number.isFinite(item.startMs) && Number.isFinite(item.endMs))
    .sort((left, right) => left.startMs - right.startMs);
  let cursor = window.startMs;
  for (const item of fresh) {
    if (item.endMs < cursor) continue;
    if (item.startMs > cursor + 2_000) return false;
    cursor = Math.max(cursor, item.endMs);
    if (cursor >= window.endMs) return true;
  }
  return false;
}

function financeEventInsideCoverage(event, coverage) {
  const eventMs = Date.parse(String(event?.eventAt ?? ""));
  const market = marketForSymbol(event?.symbol);
  if (!market || !Number.isFinite(eventMs)) return false;
  return normalizeFinanceCoverage(coverage).some((item) => (
    item.market === market
    && item.symbols.includes(event.symbol)
    && eventMs >= Date.parse(item.startAt)
    && eventMs <= Date.parse(item.endAt)
  ));
}

async function mapWithConcurrency(values, concurrency, iteratee) {
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await iteratee(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
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
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
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
  return (error instanceof Error ? error.message : String(error ?? "未知错误"))
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/(?:access|refresh)[_-]?token\s*[:=]\s*[^\s,;]+/gi, "token=[redacted]")
    .slice(0, 240);
}

function wait(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
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

function exchangeDateForTimestamp(value, symbol) {
  const iso = timestampToIso(value);
  if (!iso) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezoneForSymbol(symbol),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const read = (type) => parts.find((part) => part.type === type)?.value;
  const year = read("year");
  const month = read("month");
  const day = read("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
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
