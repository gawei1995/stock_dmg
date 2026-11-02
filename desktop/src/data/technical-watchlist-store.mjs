export const TECHNICAL_WATCHLIST_STORE_KEY = "technicalWatchlistV1";
export const TECHNICAL_WATCHLIST_SCHEMA_VERSION = "technical-watchlist/v1";
export const TECHNICAL_WATCHLIST_MAX_SYMBOLS = 80;

export class TechnicalWatchlistStore {
  constructor({
    store,
    key = TECHNICAL_WATCHLIST_STORE_KEY,
    maxSymbols = TECHNICAL_WATCHLIST_MAX_SYMBOLS,
  } = {}) {
    if (!store?.get || !store?.set) {
      throw new TypeError("TechnicalWatchlistStore requires an encrypted key-value store.");
    }
    this.store = store;
    this.key = String(key || TECHNICAL_WATCHLIST_STORE_KEY);
    this.maxSymbols = positiveInteger(maxSymbols, TECHNICAL_WATCHLIST_MAX_SYMBOLS);
    this.writeQueue = Promise.resolve();
  }

  async snapshot() {
    return structuredClone(normalizeState(await this.store.get(this.key), this.maxSymbols));
  }

  async add(symbol, { note = null, addedAt = new Date().toISOString() } = {}) {
    const normalizedSymbol = normalizeSymbol(symbol);
    return this.#mutate((state) => {
      const existing = state.items.find((item) => item.symbol === normalizedSymbol);
      if (existing) return state;
      if (state.items.length >= this.maxSymbols) {
        const error = new Error(`技术自选池最多保留 ${this.maxSymbols} 个标的。`);
        error.code = "technical_watchlist_limit_reached";
        throw error;
      }
      const timestamp = normalizeIso(addedAt);
      return {
        ...state,
        revision: state.revision + 1,
        updatedAt: timestamp,
        items: [...state.items, {
          symbol: normalizedSymbol,
          note: normalizeNote(note),
          addedAt: timestamp,
        }].sort((left, right) => left.symbol.localeCompare(right.symbol)),
      };
    });
  }

  async remove(symbol, { removedAt = new Date().toISOString() } = {}) {
    const normalizedSymbol = normalizeSymbol(symbol);
    return this.#mutate((state) => {
      const items = state.items.filter((item) => item.symbol !== normalizedSymbol);
      if (items.length === state.items.length) return state;
      return {
        ...state,
        revision: state.revision + 1,
        updatedAt: normalizeIso(removedAt),
        items,
      };
    });
  }

  async replace(symbols, { updatedAt = new Date().toISOString() } = {}) {
    const values = [...new Set((Array.isArray(symbols) ? symbols : [])
      .map((item) => typeof item === "string" ? normalizeSymbol(item) : normalizeSymbol(item?.symbol)))];
    if (values.length > this.maxSymbols) {
      const error = new Error(`技术自选池最多保留 ${this.maxSymbols} 个标的。`);
      error.code = "technical_watchlist_limit_reached";
      throw error;
    }
    return this.#mutate((state) => {
      const timestamp = normalizeIso(updatedAt);
      const previous = new Map(state.items.map((item) => [item.symbol, item]));
      const items = values.sort().map((symbol) => ({
        symbol,
        note: previous.get(symbol)?.note ?? null,
        addedAt: previous.get(symbol)?.addedAt ?? timestamp,
      }));
      if (JSON.stringify(items) === JSON.stringify(state.items)) return state;
      return {
        ...state,
        revision: state.revision + 1,
        updatedAt: timestamp,
        items,
      };
    });
  }

  async #mutate(updater) {
    const operation = this.writeQueue.then(async () => {
      const current = normalizeState(await this.store.get(this.key), this.maxSymbols);
      const next = normalizeState(updater(structuredClone(current)), this.maxSymbols);
      if (JSON.stringify(next) !== JSON.stringify(current)) await this.store.set(this.key, next);
      return structuredClone(next);
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export function normalizeTechnicalSymbol(value) {
  return normalizeSymbol(value);
}

function normalizeState(value, maxSymbols) {
  if (value == null) {
    return {
      schemaVersion: TECHNICAL_WATCHLIST_SCHEMA_VERSION,
      revision: 0,
      updatedAt: null,
      items: [],
    };
  }
  if (!value || value.schemaVersion !== TECHNICAL_WATCHLIST_SCHEMA_VERSION) {
    const error = new Error("技术自选池数据版本无效；未自动猜测或覆盖旧数据。");
    error.code = "technical_watchlist_state_invalid";
    throw error;
  }
  if (!Number.isInteger(value.revision) || value.revision < 0 || !Array.isArray(value.items)) {
    const error = new Error("技术自选池数据结构无效。");
    error.code = "technical_watchlist_state_invalid";
    throw error;
  }
  if (value.items.length > maxSymbols) {
    const error = new Error("技术自选池超过当前容量，未静默裁剪。");
    error.code = "technical_watchlist_state_overflow";
    throw error;
  }
  const seen = new Set();
  const items = value.items.map((item) => {
    const symbol = normalizeSymbol(item?.symbol);
    if (seen.has(symbol)) {
      const error = new Error(`技术自选池存在重复标的 ${symbol}。`);
      error.code = "technical_watchlist_duplicate_symbol";
      throw error;
    }
    seen.add(symbol);
    return {
      symbol,
      note: normalizeNote(item?.note),
      addedAt: normalizeIso(item?.addedAt),
    };
  }).sort((left, right) => left.symbol.localeCompare(right.symbol));
  return {
    schemaVersion: TECHNICAL_WATCHLIST_SCHEMA_VERSION,
    revision: value.revision,
    updatedAt: value.updatedAt == null ? null : normalizeIso(value.updatedAt),
    items,
  };
}

function normalizeSymbol(value) {
  let symbol = String(value ?? "").trim().toUpperCase();
  if (!symbol) {
    const error = new Error("请输入技术自选标的。");
    error.code = "technical_symbol_missing";
    throw error;
  }
  if (!symbol.includes(".") && /^[A-Z][A-Z0-9-]{0,9}$/.test(symbol)) symbol = `${symbol}.US`;
  if (!/^[A-Z0-9][A-Z0-9_-]{0,29}\.(US|HK|SG|SH|SZ|CN)$/.test(symbol)) {
    const error = new Error("标的格式无效；非美股请包含市场后缀，例如 700.HK。");
    error.code = "technical_symbol_invalid";
    throw error;
  }
  return symbol;
}

function normalizeNote(value) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 240) : null;
}

function normalizeIso(value) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) {
    const error = new Error("技术自选池时间戳无效。");
    error.code = "technical_watchlist_timestamp_invalid";
    throw error;
  }
  return new Date(parsed).toISOString();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
