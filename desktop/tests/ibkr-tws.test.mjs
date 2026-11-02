import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { readTws, twsNumber } from "../src/brokers/ibkr-tws.mjs";
import { IbkrClient, normalizeGatewayConfig } from "../src/brokers/ibkr-client.mjs";

const account = "U1234567";
const stock = { conId: 123, symbol: "QQQ", secType: "STK", currency: "USD", primaryExch: "NASDAQ" };
function fake({ option = false, currency = "USD", neverEnd = false, ready = true, quote = true, wrongAccount = false, accountValues = null } = {}) {
  const api = new EventEmitter(); api.calls = []; api.options = null;
  api.connect = () => queueMicrotask(() => api.emit("managedAccounts", account));
  api.disconnect = () => { api.calls.push(["disconnect"]); api.emit("disconnected"); };
  api.reqAccountUpdates = (subscribe, a) => {
    api.calls.push(["reqAccountUpdates", subscribe, a]);
    if (!subscribe) return;
    queueMicrotask(() => {
      const ac = wrongAccount ? "U7654321" : a;
      for (const [key, value, c, scope = ac] of accountValues ?? [["NetLiquidation", "10000", currency], ["TotalCashValue", "6000", currency], ["CashBalance", "6000", currency], ["ExchangeRate", "7.8", "USD"], ["AccountReady", String(ready), ""]]) api.emit("updateAccountValue", key, value, c, scope);
      api.emit("updatePortfolio", option ? { ...stock, conId: 234, secType: "OPT", multiplier: 100, right: "C", strike: 700, lastTradeDateOrContractMonth: "20260918" } : stock, 2, 20, 4000, 1800, 400, 0, ac);
      if (!neverEnd) api.emit("accountDownloadEnd", a);
    });
  };
  api.reqMarketDataType = (type) => api.calls.push(["reqMarketDataType", type]);
  api.reqMktData = (id, c, generic, snapshot, regulatory) => {
    api.calls.push(["reqMktData", id, c, generic, snapshot, regulatory]);
    queueMicrotask(() => {
      if (!quote) return api.emit("error", new Error("No permission"), 354, id);
      api.emit("marketDataType", id, 3);
      api.emit("tickPrice", id, 66, 19.5);
      api.emit("tickPrice", id, 67, 20.5);
      api.emit("tickOptionComputation", id, 83, 0, 0.3, 0.6, 20, 0, 0.02, 0.1, -0.2, 710);
      api.emit("tickSize", id, 27, 1000);
    });
  };
  api.cancelMktData = (id) => api.calls.push(["cancelMktData", id]);
  return { api, factory: (options) => { api.options = options; return api; } };
}
function read(f, extra = {}) { return readTws({ config: { port: 7496, accountId: account }, factory: f.factory, quoteWindowMs: 1, timeoutMs: 100, ...extra }); }

test("TWS defaults to loopback real TWS, keeps CP explicit, rejects unknown transports", () => {
  assert.equal(normalizeGatewayConfig().port, 7496);
  assert.equal(normalizeGatewayConfig().transport, "tws");
  assert.equal(normalizeGatewayConfig({ transport: "gateway" }).port, 5001);
  assert.equal(normalizeGatewayConfig({ trustLocalCertificate: true }).trustLocalCertificate, false);
  assert.throws(() => normalizeGatewayConfig({ transport: "remote" }));
});
test("TWS discovery does not subscribe or request orders, and disconnects", async () => {
  const f = fake(); const result = await read(f, { mode: "accounts" });
  assert.deepEqual(result.accounts, [{ id: account }]);
  assert.deepEqual(f.api.calls, [["disconnect"]]);
  assert.equal(f.api.options.host, "127.0.0.1"); assert.ok(f.api.options.clientId > 0);
});
test("TWS real account values, unit cost, contract multiplier and delayed model Greeks normalize once", async () => {
  const f = fake({ option: true }); const { snapshot: p } = await read(f);
  assert.equal(p.account.netAssets, 10000); assert.equal(p.account.totalCash, 6000);
  const row = p.positions[0];
  assert.equal(row.costPrice, 18); assert.equal(row.marketValueBase, 4000);
  assert.equal(row.option.ivPercent, 30); assert.equal(row.option.delta, 0.6);
  assert.equal(row.option.openInterest, 1000); assert.equal(row.option.underlyingPrice, 710);
  assert.equal(row.option.availability, "delayed"); assert.equal(row.marketData.bid, 19.5);
  assert.equal(row.marketData.timestampKind, "received_at"); assert.match(p.source, /TWS/);
  assert.ok(f.api.calls.some(([method, flag]) => method === "reqAccountUpdates" && !flag));
  assert.ok(f.api.calls.some(([method]) => method === "cancelMktData"));
  assert.equal(f.api.calls.find(([method]) => method === "reqMktData")[5], false);
});
test("TWS account BASE and USD cash are not summed; HKD base FX uses one inversion", async () => {
  const { snapshot: p } = await read(fake({ currency: "HKD" }));
  assert.ok(Math.abs(p.account.netAssets - 10000 / 7.8) < 1e-9);
  assert.ok(Math.abs(p.account.totalCash - 6000 / 7.8) < 1e-9);
  assert.equal(p.positions[0].marketValueBase, 4000);
});
test("TWS 10.47+ prefixed ledger values supply FX and cash without replacing account totals", async () => {
  const { snapshot: p } = await read(fake({ accountValues: [
    ["NetLiquidation", "78000", "HKD"], ["TotalCashValue", "15600", "HKD"],
    ["$LEDGER-ExchangeRate", "7.8", "USD"], ["$LEDGER-ExchangeRate", "1", "HKD"],
    ["$LEDGER-CashBalance", "7800", "HKD"], ["$LEDGER-CashBalance", "1000", "USD"],
    ["$LEDGER-CashBalance", "15600", "BASE"],
    ["$LEDGER-NetLiquidation", "999999", "USD"], ["$LEDGER-TotalCashValue", "999999", "HKD"],
  ] }));
  assert.equal(p.account.brokerBaseCurrency, "HKD");
  assert.ok(Math.abs(p.account.netAssets - 10000) < 1e-8); assert.ok(Math.abs(p.account.totalCash - 2000) < 1e-8);
  assert.equal(p.positions[0].marketValueBase, 4000);
  assert.deepEqual(p.account.cashInfos, [{ currency: "USD", availableCash: 1000 }, { currency: "HKD", availableCash: 7800 }]);
  assert.equal(p.dataQuality.fxStatus, "live");
});
test("TWS mixed ledger formats are deduplicated and explicit scope wins in either arrival order", async () => {
  const oldValues = [["ExchangeRate", "8", "USD"], ["CashBalance", "500", "USD"]];
  const scopedValues = [["$LEDGER-ExchangeRate", "7.8", "USD"], ["$LEDGER-CashBalance", "1000", "USD"]];
  for (const values of [[...oldValues, ...scopedValues], [...scopedValues, ...oldValues]]) {
    const { snapshot: p } = await read(fake({ accountValues: [
      ["NetLiquidation", "78000", "HKD"], ["TotalCashValue", "7800", "HKD"], ...values,
    ] }));
    assert.ok(Math.abs(p.account.netAssets - 10000) < 1e-8); assert.ok(Math.abs(p.account.totalCash - 1000) < 1e-8);
    assert.deepEqual(p.account.cashInfos, [{ currency: "USD", availableCash: 1000 }]);
  }
});
test("TWS prefixed ledger cannot borrow another account or infer a missing currency or base", async () => {
  const { snapshot: p } = await read(fake({ accountValues: [
    ["NetLiquidation", "78000", "HKD"], ["TotalCashValue", "7800", "HKD"],
    ["$LEDGER-ExchangeRate", "7.8", "USD", "U7654321"],
    ["$LEDGER-CashBalance", "1000", "USD", "U7654321"],
    ["$LEDGER-ExchangeRate", "7.8", ""], ["$LEDGER-CashBalance", "1000", undefined],
    ["$LEDGER-CashBalance", "1000", "UNKNOWN"],
  ] }));
  assert.equal(p.account.netAssets, null); assert.equal(p.account.totalCash, null);
  assert.equal(p.dataQuality.fxStatus, "missing"); assert.deepEqual(p.account.cashInfos, []);
  assert.ok(p.dataQuality.sourceWarnings.some((w) => /未猜测币种/.test(w.message)));
  await assert.rejects(read(fake({ accountValues: [["$LEDGER-NetLiquidation", "10000", "USD"]] })), /未提供账户基础币种/);
});
test("TWS connection refusal identifies API settings and keeps the configured port and read-only boundary", async () => {
  for (const [error, code] of [[new Error("connect failed"), 502], [Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }), undefined]]) {
    const f = fake();
    f.api.connect = () => queueMicrotask(() => f.api.emit("error", error, code));
    await assert.rejects(read(f, { config: { port: 7497, accountId: account } }), (failure) => {
      assert.match(failure.message, /127\.0\.0\.1:7497/);
      assert.match(failure.message, /启用 Socket 客户端/); assert.match(failure.message, /只读 API/);
      return true;
    });
    assert.deepEqual(f.api.calls, [["disconnect"]]);
  }
});
test("TWS missing quote rights retain positions but missing Greeks remain unknown", async () => {
  const { snapshot: p } = await read(fake({ option: true, quote: false }));
  assert.equal(p.positions.length, 1); assert.equal(p.positions[0].option.delta, null);
  assert.ok(p.dataQuality.sourceWarnings.some((w) => /354/.test(w.message)));
});
test("TWS wrong scope, reset and incomplete downloads reject instead of inventing empty success", async () => {
  for (const options of [{ wrongAccount: true }, { ready: false }, { neverEnd: true }]) {
    const f = fake(options); await assert.rejects(read(f));
    assert.equal(f.api.calls.at(-1)[0], "disconnect");
  }
  const f = fake(); await assert.rejects(read(f, { config: { port: 7496, accountId: "U9999999" } }), /不包含/);
  assert.equal(f.api.calls.filter(([method]) => method === "reqAccountUpdates").length, 0);
});
test("TWS abort cleans up subscriptions, and unavailable numeric sentinels stay null", async () => {
  const f = fake({ neverEnd: true }), controller = new AbortController();
  const pending = read(f, { signal: controller.signal });
  controller.abort(new Error("changed account")); await assert.rejects(pending, /changed account/);
  assert.equal(f.api.calls.at(-1)[0], "disconnect");
  for (const v of [null, undefined, Number.MAX_VALUE, Infinity, "NaN", true]) assert.equal(twsNumber(v), null);
  assert.equal(twsNumber(-1, { min: 0 }), null); assert.equal(twsNumber(-2, { min: -1, max: 1 }), null);
});
test("IBKR client transport change invalidates cache and TWS result persists with source identity", async () => {
  const values = new Map(); const store = { get: async (k) => values.get(k), set: async (k, v) => values.set(k, v), delete: async (k) => values.delete(k) };
  const c = new IbkrClient({ store, twsRead: (opts) => readTws({ ...opts, factory: fake().factory }) });
  await c.configure({ enabled: true, accountId: account }); await c.refresh();
  assert.match(c.portfolio.source, /TWS/); assert.equal(values.get("ibkrPortfolioSnapshotV1").transport, "tws");
  const restored = new IbkrClient({ store }); await restored.initialize(); assert.equal(restored.portfolio.status, "cached");
  await c.configure({ enabled: true, transport: "gateway", accountId: account, port: 7496 });
  assert.equal(c.portfolio, null); assert.equal(values.has("ibkrPortfolioSnapshotV1"), false);
});
test("TWS adapter exposes only bounded reads, not financial write or manual-order binding methods", async () => {
  const source = await readFile(new URL("../src/brokers/ibkr-tws.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.(placeOrder|cancelOrder|exerciseOptions|reqGlobalCancel|reqAutoOpenOrders|reqOpenOrders|reqAllOpenOrders|reqIds)\(/);
  const methods = [...source.matchAll(/api\.([A-Za-z]+)\(/g)].map((m) => m[1]);
  assert.ok(methods.every((m) => ["on", "connect", "disconnect", "reqAccountUpdates", "reqMarketDataType", "reqMktData", "cancelMktData"].includes(m)));
});
