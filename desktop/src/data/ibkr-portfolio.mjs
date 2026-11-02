import { createHash } from "node:crypto";
import { getSymbolMetadata } from "../config/symbol-map.mjs";
import { withPortfolioFreshness } from "./freshness.mjs";
import { finite, calculateBrokerTotals } from "./broker-portfolios.mjs";

export function normalizeIbkrPortfolio({ account, summary, ledger, positions, quotes = [], warnings = [], now = Date.now() }) {
  const accountId = String(account?.id ?? account?.accountId ?? "");
  if (!/^[A-Z][A-Z0-9-]{2,30}$/.test(accountId)) throw new Error("IBKR 未返回可核验的账户标识。");
  if (!Array.isArray(positions)) throw new Error("IBKR 持仓响应格式无效。");
  const base = String(account.currency ?? "").toUpperCase();
  const usdToBase = base === "USD" ? 1 : finite(ledger?.USD?.exchangerate);
  const toUsd = (currency) => currency === "USD" ? 1
    : currency === base || currency === "BASE" ? (usdToBase > 0 ? 1 / usdToBase : null)
    : usdToBase > 0 && finite(ledger?.[currency]?.exchangerate) > 0 ? ledger[currency].exchangerate / usdToBase : null;
  const convert = (value, currency) => finite(value) != null && toUsd(currency) > 0 ? Number(value) * toUsd(currency) : null;
  const summaryMoney = (key) => {
    const field = summary?.[key];
    return field?.isNull === true || field?.isNone === true ? null
      : convert(field?.amount, String(field?.currency ?? base));
  };
  const normalizedAccount = {
    baseCurrency: "USD", brokerBaseCurrency: base,
    netAssets: summaryMoney("netliquidation") ?? convert(ledger?.BASE?.netliquidationvalue, base),
    totalCash: summaryMoney("totalcashvalue") ?? convert(ledger?.BASE?.cashbalance, base),
    buyPower: summaryMoney("buyingpower"), initMargin: summaryMoney("initmarginreq"),
    maintenanceMargin: summaryMoney("maintmarginreq"), availableFunds: summaryMoney("availablefunds"),
    riskLevel: "IBKR 独立保证金", cashInfos: Object.entries(ledger ?? {}).filter(([c]) => c !== "BASE").map(([currency, row]) => ({ currency, availableCash: finite(row.cashbalance) })),
  };
  normalizedAccount.valuationComplete = normalizedAccount.netAssets != null && normalizedAccount.totalCash != null;
  const quoteMap = new Map(quotes.map((q) => [String(q.conid ?? q.conidEx?.split("@")[0]), q]));
  const seen = new Set();
  const normalized = positions.filter((p) => finite(p.position) !== 0).map((raw) => {
    const conid = String(raw.conid ?? "");
    if (!/^\d+$/.test(conid) || finite(raw.position) == null || raw.acctId && raw.acctId !== accountId) {
      throw new Error("IBKR 持仓账户、合约标识或数量校验失败，未覆盖旧快照。");
    }
    if (seen.has(conid)) throw new Error("IBKR 持仓分页包含重复合约，未覆盖旧快照。");
    seen.add(conid);
    const asset = String(raw.assetClass ?? "").toUpperCase();
    const option = ["OPT", "FOP"].includes(asset);
    const equity = asset === "STK";
    const currency = String(raw.currency ?? "").toUpperCase();
    const quantity = finite(raw.position);
    const multiplier = equity ? 1 : finite(raw.multiplier) > 0 ? Number(raw.multiplier) : null;
    const ticker = String(raw.ticker ?? raw.contractDesc ?? conid).trim();
    const us = raw.isUS === true || raw.countryCode === "US"
      || ["NASDAQ", "NYSE", "AMEX", "ARCA", "NYSEARCA", "BATS", "ISLAND"].includes(raw.listingExchange);
    const hk = raw.countryCode === "HK" || raw.listingExchange === "SEHK";
    const symbol = equity && /^[A-Z0-9.-]{1,16}$/i.test(ticker) && (us || hk)
      ? `${ticker.toUpperCase()}.${hk ? "HK" : "US"}` : `IBKR-${conid}.IB`;
    const meta = getSymbolMetadata(symbol, hk ? "HK" : "");
    const quote = quoteMap.get(conid) ?? {};
    const marketValue = finite(raw.mktValue);
    const price = finite(raw.mktPrice);
    const costPrice = multiplier > 0 && finite(raw.avgCost) != null ? Number(raw.avgCost) / multiplier : null;
    const marketValueBase = convert(marketValue, currency);
    const pnlBase = convert(raw.unrealizedPnl, currency);
    const timestamp = Number(quote._updated);
    const quoteTimestamp = Number.isFinite(timestamp) && timestamp > 1e12 && timestamp <= now + 60_000
      ? new Date(timestamp).toISOString() : null;
    const availability = ibkrAvailability(quote["6509"]);
    const baseRow = {
      symbol, ticker: option ? String(raw.contractDesc ?? ticker) : ticker, name: String(raw.name ?? raw.contractDesc ?? ticker),
      instrumentType: option ? "option" : equity ? "equity" : "other", assetClass: asset,
      positionId: `ibkr:${conid}`, broker: "ibkr", conid, currency, market: us ? "US" : hk ? "HK" : "IBKR",
      tvSymbol: equity && (us || hk) ? meta.tvSymbol : null, group: meta.group,
      quantity, grossQuantity: Math.abs(quantity), availableQuantity: null, direction: quantity > 0 ? "long" : "short",
      contractMultiplier: multiplier, costPrice, costBasisStatus: costPrice == null ? "missing" : "available",
      costBasisLimitation: costPrice == null ? "IBKR 未提供完整单位成本/合约乘数，不能默认使用 100 倍。" : null,
      lastPrice: price, marketValue, marketValueBase, grossMarketValueBase: marketValueBase == null ? null : Math.abs(marketValueBase),
      pnlBase, pnlPercent: finite(raw.unrealizedPnl) != null && finite(raw.avgCost) != null && Math.abs(quantity * raw.avgCost) > 0
        ? Number(raw.unrealizedPnl) / Math.abs(quantity * raw.avgCost) * 100 : null,
      prevClose: null, changePercent: null,
      // Portfolio mktPrice and market-data snapshot are distinct observations.
      // No fabricated trade timestamp on the broker's portfolio valuation.
      quoteTimestamp: null, quoteSession: "broker_valuation", quoteAvailability: availability,
      marketData: { source: "IBKR /iserver/marketdata/snapshot", observedAt: quoteTimestamp,
        availability, last: parseIbkrNumber(quote["31"]), bid: parseIbkrNumber(quote["84"]), ask: parseIbkrNumber(quote["86"]),
        lastPrefix: typeof quote["31"] === "string" ? quote["31"].match(/^[CH]/)?.[0] ?? null : null },
      valuationStatus: marketValueBase == null ? "unpriced" : "priced",
      valuationLimitation: marketValueBase == null ? "缺少 IBKR 市值或到 USD 的账户汇率" : "IBKR 账户估值；不是已核验的实时成交报价",
      valuationSource: "IBKR portfolio mktValue (native currency), converted once to USD",
      option: option ? { expiry: raw.expiry ?? null, right: raw.putOrCall ?? null, strike: finite(raw.strike),
        underlyingConid: raw.undConid ?? null, multiplier, delta: validIbkrMetric(quote["7308"], -1, 1),
        gamma: validIbkrMetric(quote["7309"], 0), theta: validIbkrMetric(quote["7310"]), vega: validIbkrMetric(quote["7311"], 0),
        ivPercent: validIbkrMetric(quote["7633"], 0), openInterest: validIbkrMetric(quote["7638"], 0),
        availability, observedAt: quoteTimestamp, units: "per-unit quote Greeks; IV in percent; no portfolio delta-dollar aggregation without underlying price" } : null,
    };
    return baseRow;
  });
  const totals = calculateBrokerTotals(normalized, normalizedAccount);
  const complete = normalizedAccount.valuationComplete && totals.totals.unpricedPositionCount === 0;
  return withPortfolioFreshness({
    source: "IBKR Client Portal Gateway · 只读", brokerScope: "ibkr", status: "degraded", holdingsStatus: "live",
    syncedAt: new Date(now).toISOString(), valuationSchemaVersion: 2,
    accountLabel: `IBKR · ${accountId.slice(0, 1)}***${accountId.slice(-3)}`,
    accountScopeIdentity: { broker: "ibkr", status: "verified", scopeId: `ibkr:${createHash("sha256").update(`ibkr:${accountId}`).digest("hex")}`, rawIdentifiersPersisted: false },
    account: normalizedAccount, positions: normalized, ...totals,
    dataQuality: { valuationComplete: complete, accountValuationComplete: normalizedAccount.valuationComplete,
      unpricedPositionCount: totals.totals.unpricedPositionCount, fxStatus: usdToBase > 0 ? "live" : "missing", sourceErrors: [], sourceWarnings: warnings.map((message) => ({ tool: "ibkr", message })), quoteErrors: [] },
    valuationGate: null, orderWrite: false,
    limitations: ["期权权利金市值不等于 Delta 名义敞口；不可仅按期权市值判断杠杆风险。", "IBKR 复盘历史订单与自动收盘快照尚未接入；当前是持仓/期权信息接入。", ...warnings],
  }, { now });
}

export function parseIbkrNumber(value) {
  if (typeof value === "number") return finite(value);
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/^[CH](?=\d)/, "").replace(/,/g, "").replace(/%$/, "");
  return /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(cleaned) ? finite(cleaned) : null;
}
export function ibkrAvailability(value) {
  return ({ R: "realtime", D: "delayed", Z: "frozen", Y: "frozen_delayed", N: "not_subscribed", i: "incomplete" })[String(value ?? "")[0]] ?? "unknown";
}
function validIbkrMetric(value, min = -1e100, max = 1e100) {
  const n = parseIbkrNumber(value);
  return n != null && n >= min && n <= max ? n : null;
}
