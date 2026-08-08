const STORE_KEY = "brokerTradeHistoryV1";
const SCHEMA_VERSION = 1;
const DEFAULT_LOOKBACK_DAYS = 365;
const MAX_LOOKBACK_DAYS = 730;
const API_WINDOW_DAYS = 90;
const MIN_SPLIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const US_ORDER_PAGE_SIZE = 100;
const MAX_US_ORDER_PAGES = 200;

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
  }

  async cached() {
    const value = await this.store.get(STORE_KEY);
    return value?.schemaVersion === SCHEMA_VERSION
      ? structuredClone(value)
      : emptyArchive();
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
    };
    if (!capabilities.historyOrders && !capabilities.historyExecutions) {
      throw new Error("当前长桥授权未暴露历史订单或历史成交查询；请重新授权查询权限。");
    }

    this.onStatus({
      state: "syncing",
      phase: "trade_history",
      message: "正在只读同步长桥历史订单与成交",
    });

    const historicalOrders = capabilities.historyOrders
      ? await this.#fetchWindows("history_orders", range, normalizedSymbol, "orders", warnings)
      : [];
    const historicalExecutions = capabilities.historyExecutions
      ? await this.#fetchWindows("history_executions", range, normalizedSymbol, "trades", warnings)
      : [];

    const includesToday = range.endMs >= startOfUtcDay(Date.now());
    const todayOrders = includesToday && capabilities.todayOrders
      ? await this.#optionalCall("today_orders", compactArgs({ symbol: normalizedSymbol }), "orders", warnings)
      : [];
    const todayExecutions = includesToday && capabilities.todayExecutions
      ? await this.#optionalCall("today_executions", compactArgs({ symbol: normalizedSymbol }), "trades", warnings)
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

    const archive = {
      schemaVersion: SCHEMA_VERSION,
      source: "Longbridge MCP · read only",
      syncedAt: new Date().toISOString(),
      range: {
        startAt: new Date(range.startMs).toISOString(),
        endAt: new Date(range.endMs).toISOString(),
      },
      capabilities,
      warnings: [...new Set(warnings)].slice(0, 20),
      orders: orders.slice(0, 20_000),
      executions: executions.slice(0, 20_000),
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

  async #fetchWindows(tool, range, symbol, listKey, warnings) {
    const rows = [];
    for (const window of splitRange(range.startMs, range.endMs, API_WINDOW_DAYS)) {
      rows.push(...await this.#fetchWindow(tool, window, symbol, listKey, warnings));
    }
    return rows;
  }

  async #fetchWindow(tool, range, symbol, listKey, warnings) {
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
      const payload = await this.longbridge.call(tool, args);
      const rows = extractRows(payload, listKey);
      const totalCount = tool === "history_orders" ? extractTotalCount(payload) : null;
      if (totalCount != null) {
        const pages = Math.min(
          MAX_US_ORDER_PAGES,
          Math.max(1, Math.ceil(totalCount / US_ORDER_PAGE_SIZE)),
        );
        for (let page = 2; page <= pages; page += 1) {
          const pagePayload = await this.longbridge.call(tool, { ...args, us_page: page });
          rows.push(...extractRows(pagePayload, listKey));
        }
        if (pages * US_ORDER_PAGE_SIZE < totalCount) {
          warnings.push(`history_orders 美区分页超过 ${MAX_US_ORDER_PAGES} 页，结果可能被截断。`);
        }
        return rows;
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
      );
      const right = await this.#fetchWindow(
        tool,
        { startMs: middle + 1_000, endMs: range.endMs },
        symbol,
        listKey,
        warnings,
      );
      return [...left, ...right];
    } catch (error) {
      warnings.push(`${tool}: ${safeMessage(error)}`);
      return [];
    }
  }

  async #optionalCall(tool, args, listKey, warnings) {
    try {
      return extractRows(await this.longbridge.call(tool, args), listKey);
    } catch (error) {
      warnings.push(`${tool}: ${safeMessage(error)}`);
      return [];
    }
  }
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
    },
    warnings: [],
    orders: [],
    executions: [],
  };
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
    submittedPrice: finiteOrNull(value.price),
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

function cleanText(value, limit) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, limit) : null;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeMessage(error) {
  return (error instanceof Error ? error.message : String(error ?? "未知错误")).slice(0, 240);
}

function startOfUtcDay(value) {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
