// The package root also eagerly imports an unused reactive API with optional
// peers. Load only the pinned low-level Socket API so packaged builds do not
// depend on development-only rxjs being present.
import { IBApi } from "@stoqey/ib/dist/api/api.js";
import { EventName } from "@stoqey/ib/dist/api/data/enum/event-name.js";
import { randomInt } from "node:crypto";
import { normalizeIbkrPortfolio, parseIbkrNumber } from "../data/ibkr-portfolio.mjs";
const ib = { IBApi, EventName };

const MONEY_KEYS = { NetLiquidation: "netliquidation", TotalCashValue: "totalcashvalue", BuyingPower: "buyingpower", InitMarginReq: "initmarginreq", MaintMarginReq: "maintmarginreq", AvailableFunds: "availablefunds" };
const INFORMATIONAL = new Set([2104, 2106, 2107, 2108, 2158]);
export function twsNumber(value, { min = -1e100, max = 1e100 } = {}) {
  const n = parseIbkrNumber(value);
  return n != null && n >= min && n <= max ? n : null;
}

// Short-lived, loopback-only, non-zero client ID. Never binds/manual-syncs
// orders, requests order IDs, places orders or takes over a brokerage session.
export function readTws({ config, signal, mode = "portfolio", factory = (options) => new ib.IBApi(options), timeoutMs = 15_000, quoteWindowMs = 2_000, clock = () => Date.now() }) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const api = factory({ host: "127.0.0.1", port: config.port, clientId: randomInt(7100, 1_000_000) });
    let finished = false, subscribed = false, accountReady = true, quoteTimer;
    let accounts = [], baseCurrency = "", accountTime = null;
    const rows = new Map(), values = new Map(), quoteMap = new Map(), quoteIds = new Set(), warnings = new Set();
    const timer = setTimeout(() => finish(new Error("TWS 读取超时；请检查登录、Socket 端口及本机 API 连接提示。")), timeoutMs);
    const abort = () => finish(signal.reason ?? new Error("TWS 读取已取消。"));
    signal?.addEventListener("abort", abort, { once: true });
    function finish(error, result) {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(quoteTimer); signal?.removeEventListener("abort", abort);
      try { for (const id of quoteIds) api.cancelMktData(id); } catch {}
      try { if (subscribed) api.reqAccountUpdates(false, config.accountId); } catch {}
      try { api.disconnect(); } catch {}
      if (error) reject(error); else resolve(result);
    }
    const on = (event, fn) => api.on(event, (...args) => { if (!finished) { try { fn(...args); } catch (error) { finish(error); } } });
    on(ib.EventName.error, (error, code, reqId) => {
      if (INFORMATIONAL.has(code)) return;
      if (code === 502 || error?.code === "ECONNREFUSED" || /ECONNREFUSED/.test(String(error?.message ?? error))) {
        return finish(new Error(`无法连接本机 TWS API（127.0.0.1:${config.port}）。请在已登录的新版 TWS「全局配置 → API → 设置」确认启用 Socket 客户端、端口一致，并保留只读 API 和仅允许本机连接；升级可能重置 API 设置。`));
      }
      if (quoteIds.has(reqId)) { warnings.add(`TWS 行情 ${code ?? "错误"}：部分报价/Greeks 不可用。`); return; }
      // Reset, subscription replacement, client-ID collision and socket errors
      // cannot be turned into a successful empty portfolio.
      if ([2100, 2101, 1100, 1101, 1102, 1300, 326, 502, 504].includes(code) || code == null || code < 0) {
        finish(new Error(`TWS 连接未完成（${code ?? "Socket"}）：${String(error?.message ?? error).slice(0, 220)}`));
      } else warnings.add(`TWS 提示 ${code}：${String(error?.message ?? error).slice(0, 160)}`);
    });
    on(ib.EventName.disconnected, () => finish(new Error("TWS 在账户读取完成前断开；保留上次成功缓存。")));
    on(ib.EventName.managedAccounts, (list) => {
      accounts = [...new Set(String(list).split(",").map((a) => a.trim()).filter(Boolean))].map((id) => ({ id }));
      if (!accounts.length || accounts.some((a) => !/^[A-Z][A-Z0-9-]{2,30}$/.test(a.id))) throw new Error("TWS 未返回可核验账户。");
      if (mode === "accounts") return finish(null, { accounts });
      if (!accounts.some((a) => a.id === config.accountId)) throw new Error("TWS 当前登录不包含所选账户，未读取其他账户。");
      if (!subscribed) { subscribed = true; api.reqAccountUpdates(true, config.accountId); }
    });
    on(ib.EventName.updateAccountValue, (key, value, currency, account) => {
      if (account !== config.accountId) return;
      if (key === "AccountReady" || key === "accountReady") { if (String(value).toLowerCase() === "false") accountReady = false; }
      if (key === "NetLiquidation" && currency && currency !== "BASE") baseCurrency = currency;
      values.set(`${key}:${currency}`, { key, value, currency });
    });
    on(ib.EventName.updateAccountTime, (time) => { accountTime = String(time); });
    on(ib.EventName.updatePortfolio, (contract, quantity, price, marketValue, cost, unrealized, realized, account) => {
      if (account !== config.accountId) return;
      if (!Number.isSafeInteger(contract.conId) || twsNumber(quantity) == null) throw new Error("TWS 合约或数量格式无效。");
      rows.set(contract.conId, { contract, acctId: account, conid: contract.conId, ticker: contract.symbol,
        contractDesc: contract.localSymbol || contract.symbol, assetClass: contract.secType, currency: contract.currency,
        listingExchange: contract.primaryExch || contract.exchange, position: quantity, mktPrice: twsNumber(price),
        mktValue: twsNumber(marketValue), avgCost: twsNumber(cost), unrealizedPnl: twsNumber(unrealized),
        multiplier: twsNumber(contract.multiplier, { min: 0 }), expiry: contract.lastTradeDateOrContractMonth || null,
        putOrCall: contract.right || null, strike: twsNumber(contract.strike),
      });
    });
    on(ib.EventName.marketDataType, (id, type) => { if (quoteMap.has(id)) quoteMap.get(id)["6509"] = ({ 1: "R", 2: "Z", 3: "D", 4: "Y" })[type]; });
    on(ib.EventName.tickPrice, (id, field, value) => {
      const q = quoteMap.get(id), key = ({ 1: "84", 2: "86", 4: "31", 66: "84", 67: "86", 68: "31" })[field];
      if (!q || !key) return;
      q[key] = twsNumber(value, { min: 0 }); q._updated = clock();
      if ([66, 67, 68].includes(field)) q["6509"] = "D";
    });
    on(ib.EventName.tickSize, (id, field, value) => {
      const q = quoteMap.get(id);
      if (q && ((q.right === "C" && field === 27) || (q.right === "P" && field === 28))) q["7638"] = twsNumber(value, { min: 0 });
    });
    on(ib.EventName.tickOptionComputation, (id, field, _attrib, iv, delta, _price, _dividend, gamma, vega, theta, underlying) => {
      const q = quoteMap.get(id);
      // Model (#13), or delayed model (#83); do not silently mix bid/ask Greeks.
      if (!q || ![13, 83].includes(field)) return;
      const validIv = twsNumber(iv, { min: 0 });
      Object.assign(q, { "7633": validIv == null ? null : validIv * 100,
        "7308": twsNumber(delta, { min: -1, max: 1 }), "7309": twsNumber(gamma, { min: 0 }),
        "7311": twsNumber(vega, { min: 0 }), "7310": theta === -2 ? null : twsNumber(theta),
        underlyingPrice: twsNumber(underlying, { min: 0 }), _updated: clock() });
      if (field === 83) q["6509"] = "D";
    });
    const publish = () => {
      try {
        if (!accountReady) throw new Error("IBKR 正在重置账户数据（AccountReady=false）；本轮结果不入缓存。");
        if (!baseCurrency) throw new Error("TWS 未提供账户基础币种，不能安全折算 USD。");
        const summary = {}, ledger = {}, ledgerFields = new Map();
        for (const { key, value, currency } of values.values()) {
          if (MONEY_KEYS[key] && (currency === baseCurrency || currency === "BASE")) {
            summary[MONEY_KEYS[key]] = { amount: twsNumber(value), currency: baseCurrency };
          }
          // TWS 10.47+ can explicitly prefix per-currency values with $LEDGER-.
          // Keep this scope separate from account-level totals: stripping the
          // prefix globally could mistake per-currency NAV for the whole account.
          const explicitLedger = key.startsWith("$LEDGER-");
          const ledgerKey = explicitLedger ? key.slice("$LEDGER-".length) : key;
          if (ledgerKey === "ExchangeRate" || ledgerKey === "CashBalance") {
            if (!/^(?:[A-Z]{3}|BASE)$/.test(currency ?? "")) {
              warnings.add("部分 TWS 分币种账本缺少有效币种；未猜测币种或用于汇率折算。");
              continue;
            }
            const field = `${ledgerKey}:${currency}`, previous = ledgerFields.get(field);
            // If both formats arrive, the explicitly scoped value wins,
            // irrespective of arrival order. Never add the two observations.
            if (!previous || explicitLedger || !previous.explicitLedger) {
              ledgerFields.set(field, { key: ledgerKey, currency, value, explicitLedger });
            }
          }
        }
        for (const { key, currency, value } of ledgerFields.values()) {
          ledger[currency] ??= {};
          ledger[currency][key === "ExchangeRate" ? "exchangerate" : "cashbalance"] = twsNumber(value);
        }
        const account = { id: config.accountId, currency: baseCurrency };
        const snapshot = normalizeIbkrPortfolio({ account, summary, ledger, positions: [...rows.values()], quotes: [...quoteMap.values()], warnings: [...warnings], now: clock() });
        snapshot.source = "IBKR TWS Socket · 只读";
        snapshot.accountUpdateTime = accountTime; // TWS supplies HH:mm, not a verified quote timestamp.
        snapshot.limitations.push("TWS 账户估值可能约每 3 分钟更新；同步时间不是逐笔报价时间。");
        for (const row of snapshot.positions) {
          row.valuationSource = "IBKR TWS updatePortfolio marketValue (native currency), converted once to USD";
          row.marketData.source = "IBKR TWS reqMktData";
          row.marketData.timestampKind = "received_at";
          if (row.option) { row.option.greeksBasis = "model"; row.option.underlyingPrice = [...quoteMap.values()].find((q) => String(q.conid) === row.conid)?.underlyingPrice ?? null; }
        }
        finish(null, { accounts: accounts.map((a) => a.id === account.id ? account : a), snapshot });
      } catch (error) { finish(error); }
    };
    on(ib.EventName.accountDownloadEnd, (account) => {
      if (account !== config.accountId || quoteTimer) return;
      if (!accountReady) return publish();
      const options = [...rows.values()].filter((p) => p.position !== 0 && ["OPT", "FOP"].includes(p.assetClass));
      if (!options.length) return publish();
      // Delayed data is explicitly allowed; IB returns live data when entitled.
      api.reqMarketDataType(3);
      for (const [i, row] of options.slice(0, 40).entries()) {
        const id = 1000 + i; quoteIds.add(id);
        quoteMap.set(id, { conid: row.conid, right: row.putOrCall });
        api.reqMktData(id, { ...row.contract, exchange: row.contract.exchange || "SMART" }, "101", false, false);
      }
      if (options.length > 40) warnings.add("本轮仅补充前 40 个期权持仓的行情；持仓清单完整保留。");
      quoteTimer = setTimeout(() => {
        if ([...quoteMap.values()].some((q) => q["7308"] == null)) warnings.add("部分期权 Greeks 未在本轮窗口返回；显示缺失，不补造数值。");
        publish();
      }, quoteWindowMs);
    });
    try { api.connect(); } catch (error) { finish(error); }
  });
}
