import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeIbkrPortfolio, parseIbkrNumber, ibkrAvailability } from "../src/data/ibkr-portfolio.mjs";
import { IbkrClient, assertIbkrReadOnlyRequest, normalizeGatewayConfig } from "../src/brokers/ibkr-client.mjs";
import { buildBrokerViews } from "../src/data/broker-portfolios.mjs";
import { buildAnalysisEvidence } from "../src/engine/agent.mjs";
import { buildCodexEvidence, buildWorkspaceAdditionalContext } from "../src/engine/codex-workspace.mjs";

const NOW = Date.parse("2026-09-17T14:00:00Z");
const account = { id: "U1234567", currency: "USD" };
const summary = { netliquidation: { amount: 10000, currency: "USD" }, totalcashvalue: { amount: 5000, currency: "USD" }, buyingpower: { amount: 12000, currency: "USD" } };
const ledger = { BASE: { cashbalance: 5000, netliquidationvalue: 10000 }, USD: { cashbalance: 5000, exchangerate: 1 } };
const stock = { acctId: account.id, conid: 100, assetClass: "STK", ticker: "AAPL", contractDesc: "AAPL", isUS: true, currency: "USD", position: 10, mktPrice: 120, mktValue: 1200, avgCost: 100, unrealizedPnl: 200 };
const option = { acctId: account.id, conid: 200, assetClass: "OPT", ticker: "AAPL", contractDesc: "AAPL SEP 25 120 C", currency: "USD", position: 2, mktPrice: 2, mktValue: 400, avgCost: 250, multiplier: 100, expiry: "20260925", strike: 120, putOrCall: "C", unrealizedPnl: -100 };
const quote = { conid: 200, _updated: NOW, "6509": "RPB", "31": "2.1", "84": "2.00", "86": "2.20", "7308": ".5", "7309": "0.02", "7310": "-0.1", "7311": "0.03", "7633": "35.2%", "7638": "1,200" };
const makePortfolio = (patch = {}) => normalizeIbkrPortfolio({ account, summary, ledger, positions: [stock, option], quotes: [quote], now: NOW, ...patch });
function memoryStore() { const values = new Map(); return { values, get: async (k) => values.get(k), set: async (k, v) => values.set(k, structuredClone(v)), delete: async (k) => values.delete(k) }; }
function requestFixture(calls, overrides = {}) {
  return async ({ path, method, body, signal }) => {
    signal?.throwIfAborted(); calls.push({ path, method, body });
    if (overrides[path]) return overrides[path]();
    if (path === "/portfolio/accounts") return [account];
    if (path.endsWith("/summary")) return summary;
    if (path.endsWith("/ledger")) return ledger;
    if (path.endsWith("/positions/0")) return [stock, option];
    if (path === "/iserver/accounts") return { accounts: [account.id] };
    if (path === "/iserver/secdef/search") return [{ conid: "100", symbol: "AAPL" }];
    if (path.startsWith("/iserver/marketdata/snapshot")) return [quote];
    throw new Error(`Unexpected ${path}`);
  };
}

test("IBKR option cost is divided by explicit multiplier once; broker mktValue is never multiplied again", () => {
  const p = makePortfolio(); const row = p.positions.find((p) => p.instrumentType === "option");
  assert.equal(row.costPrice, 2.5); assert.equal(row.marketValueBase, 400); assert.equal(row.pnlBase, -100);
  assert.equal(row.pnlPercent, -20); assert.equal(row.contractMultiplier, 100);
  assert.equal(row.option.ivPercent, 35.2); assert.equal(row.option.openInterest, 1200);
  assert.equal(row.option.delta, 0.5);
  assert.equal(row.quoteTimestamp, null); assert.equal(row.marketData.observedAt, new Date(NOW).toISOString());
  assert.equal(p.freshness.freshForSizing, false);
});
test("IBKR missing multiplier or price remains unknown, while authoritative portfolio value survives", () => {
  const p = makePortfolio({ positions: [{ ...option, multiplier: null, mktPrice: null }] });
  assert.equal(p.positions[0].contractMultiplier, null); assert.equal(p.positions[0].costPrice, null);
  assert.equal(p.positions[0].lastPrice, null); assert.equal(p.positions[0].marketValueBase, 400);
});
test("IBKR HKD base account converts aggregate once and leaves native USD positions unchanged", () => {
  const p = makePortfolio({ account: { ...account, currency: "HKD" },
    summary: { netliquidation: { amount: 78000, currency: "HKD" }, totalcashvalue: { amount: 7800, currency: "HKD" } },
    ledger: { USD: { exchangerate: 7.8 }, HKD: { exchangerate: 1 } },
    positions: [option, { ...stock, currency: "HKD", mktValue: 780 }] });
  assert.ok(Math.abs(p.account.netAssets - 10000) < 1e-8); assert.ok(Math.abs(p.account.totalCash - 1000) < 1e-8);
  assert.equal(p.positions.find((p) => p.instrumentType === "option").marketValueBase, 400);
  assert.ok(Math.abs(p.positions.find((p) => p.instrumentType === "equity").marketValueBase - 100) < 1e-8);
  const missing = makePortfolio({ account: { ...account, currency: "HKD" }, summary: {}, ledger: { BASE: { netliquidationvalue: 78000 } } });
  assert.equal(missing.account.netAssets, null);
});
test("IBKR rejects malformed rows, account contamination and pagination duplication", () => {
  assert.throws(() => makePortfolio({ positions: [{ ...stock, acctId: "U7654321" }] }), /校验失败/);
  assert.throws(() => makePortfolio({ positions: [stock, stock] }), /重复/);
  assert.throws(() => makePortfolio({ positions: [{ ...stock, position: true }] }), /校验失败/);
  assert.throws(() => makePortfolio({ positions: [{ ...stock, position: null }] }), /校验失败/);
});
test("IBKR availability is explicit and parsing does not fabricate missing Greeks", () => {
  assert.equal(ibkrAvailability("DPB"), "delayed"); assert.equal(ibkrAvailability("N"), "not_subscribed");
  for (const value of [null, "", "N/A", "--", true, "NaN", "Infinity"]) assert.equal(parseIbkrNumber(value), null);
  assert.equal(parseIbkrNumber("C123.45"), 123.45); assert.equal(parseIbkrNumber("-0.2"), -0.2);
});
test("all-broker view merges identical equities, not option contracts, and never sums buying power", () => {
  const ib = makePortfolio(); const lb = structuredClone(ib); lb.source = "Longbridge";
  const views = buildBrokerViews({ longbridge: lb, ibkr: ib, ibkrEnabled: true, now: NOW });
  assert.equal(views.all.account.netAssets, 20000); assert.equal(views.all.account.buyPower, null);
  assert.equal(views.all.positions.length, 3);
  const row = views.all.positions.find((p) => p.symbol === "AAPL.US");
  assert.equal(row.quantity, 20); assert.equal(row.weight, 12); assert.equal(row.brokerLegs.length, 2);
  assert.equal(row.lastPrice, null); assert.equal(views.longbridge.positions[0].quantity, 10);
});
test("opposite broker equities preserve gross exposure and show no merged cost", () => {
  const lb = makePortfolio({ positions: [stock] });
  const ib = makePortfolio({ positions: [{ ...stock, position: -10, mktValue: -1200 }] });
  const row = buildBrokerViews({ longbridge: lb, ibkr: ib, ibkrEnabled: true, now: NOW }).all.positions[0];
  assert.equal(row.quantity, 0); assert.equal(row.grossQuantity, 20); assert.equal(row.grossMarketValueBase, 2400);
  assert.equal(row.marketValueBase, 0); assert.equal(row.weight, 12); assert.equal(row.costPrice, null);
  assert.equal(row.hasOffsettingLegs, true);
});
test("all-broker view preserves mixed FX quality, broker diagnostics and original source dates", () => {
  const lb = makePortfolio(), ib = makePortfolio();
  lb.source = "Longbridge";
  lb.dataQuality.fxStatus = "reference_cached";
  lb.dataQuality.sourceWarnings = [{ tool: "exchange_rate", code: 463, message: "using cached reference FX" }];
  lb.dataQuality.quoteErrors = ["AAPL.US: missing quote timestamp"];
  lb.fx = { provider: "European Central Bank", providerCode: "ECB", asOf: "2026-09-10", fetchedAt: "2026-09-10T16:00:00Z" };
  ib.dataQuality.sourceErrors = [{ tool: "ibkr", message: "Greeks incomplete" }];
  const original = structuredClone(lb);
  const all = buildBrokerViews({ longbridge: lb, ibkr: ib, ibkrEnabled: true, now: NOW }).all;
  assert.equal(all.dataQuality.fxStatus, "reference_cached");
  assert.equal(all.fx.providerCode, "多券商");
  assert.equal(all.fx.asOf, null, "unknown broker FX dates must not be invented");
  assert.equal(all.fx.sources[0].asOf, "2026-09-10");
  assert.equal(all.dataQuality.sourceWarnings[0].broker, "longbridge");
  assert.equal(all.dataQuality.sourceWarnings[0].code, 463);
  assert.equal(all.dataQuality.sourceErrors[0].broker, "ibkr");
  assert.match(all.dataQuality.quoteErrors[0], /长桥.*missing quote/);
  assert.equal(all.brokerAccounts[0].dataQuality.fxStatus, "reference_cached");
  assert.equal(all.brokerAccounts[0].fx.asOf, "2026-09-10");
  assert.ok(all.limitations.some((message) => message.includes("IBKR 复盘历史")));
  assert.equal(all.account.netAssets, 20000);
  assert.equal(all.freshness.freshForSizing, false);
  assert.deepEqual(lb, original, "aggregate annotations must not mutate input snapshots");
});
test("aggregate FX uses the least trusted source and never promotes unknown or missing brokers", () => {
  for (const [first, second, expected] of [
    ["live", "reference", "reference"], ["reference", "reference_cached", "reference_cached"],
    ["live", "missing", "unavailable"], ["live", "unknown", "unavailable"],
    ["not_required", "not_required", "not_required"], ["live", "not_required", "live"],
  ]) {
    const lb = makePortfolio(), ib = makePortfolio();
    lb.dataQuality.fxStatus = first; ib.dataQuality.fxStatus = second;
    assert.equal(buildBrokerViews({ longbridge: lb, ibkr: ib, ibkrEnabled: true, now: NOW }).all.dataQuality.fxStatus, expected);
  }
  assert.equal(buildBrokerViews({ longbridge: makePortfolio(), ibkrEnabled: true, now: NOW }).all.dataQuality.fxStatus, "unavailable");
});
test("missing broker never creates a falsely complete account total or weight", () => {
  const all = buildBrokerViews({ longbridge: makePortfolio(), ibkrEnabled: true, now: NOW }).all;
  assert.equal(all.account.netAssets, null); assert.equal(all.account.totalCash, null);
  assert.deepEqual(all.missingBrokers, ["ibkr"]); assert.ok(all.positions.every((p) => p.weight === null));
  assert.equal(all.freshness.freshForSizing, false);
});
test("IBKR transport allowlist rejects trade writes, arbitrary origins, escapes and socket ports misuse", () => {
  for (const [path, method] of [["/iserver/account/U123/orders", "POST"], ["/iserver/reply/1", "POST"], ["/iserver/account/U123/order/1", "DELETE"], ["https://example.com", "GET"], ["/portfolio/../orders", "GET"], ["/portfolio/%2e%2e", "GET"], ["/logout", "POST"], ["/iserver/auth/ssodh/init", "POST"]]) assert.throws(() => assertIbkrReadOnlyRequest(path, method));
  assert.doesNotThrow(() => assertIbkrReadOnlyRequest("/iserver/secdef/search", "POST"));
  assert.doesNotThrow(() => assertIbkrReadOnlyRequest("/portfolio/U1234567/positions/0"));
  for (const port of [0, 80, 65536, "abc"]) assert.throws(() => normalizeGatewayConfig({ port }));
  assert.equal(normalizeGatewayConfig({ hostname: "example.com" }).port, 7496);
});
test("IBKR sync reads account first, primes derivative lookup and performs bounded quote preflight", async () => {
  const calls = [], store = memoryStore();
  const client = new IbkrClient({ store, request: requestFixture(calls), clock: () => NOW, pacingMs: 0 });
  await client.configure({ transport: "gateway", enabled: true, accountId: account.id });
  const p = await client.refresh();
  assert.equal(p.positions.length, 2); assert.equal(calls[0].path, "/portfolio/accounts");
  assert.equal(calls.filter((c) => c.path.startsWith("/iserver/marketdata/snapshot")).length, 2);
  assert.ok(calls.findIndex((c) => c.path === "/iserver/secdef/search") < calls.findIndex((c) => c.path.startsWith("/iserver/marketdata/snapshot")));
  await client.refresh(); assert.equal(calls.filter((c) => c.path === "/portfolio/accounts").length, 1);
  const restored = new IbkrClient({ store }); await restored.initialize();
  assert.equal(restored.portfolio.status, "cached"); assert.equal(restored.portfolio.freshness.freshForSizing, false);
});
test("IBKR missing market permission retains real positions and explicit diagnostics", async () => {
  const client = new IbkrClient({ store: memoryStore(), request: requestFixture([], { "/iserver/accounts": () => { throw new Error("No market session"); } }), clock: () => NOW, pacingMs: 0 });
  await client.configure({ transport: "gateway", enabled: true, accountId: account.id }); const p = await client.refresh();
  assert.equal(p.positions.length, 2); assert.equal(p.account.netAssets, 10000);
  assert.match(p.dataQuality.sourceWarnings[0].message, /No market session/);
  assert.equal(p.positions[1].option.delta, null);
});
test("IBKR expired authentication preserves old snapshot as stale, not newly synced", async () => {
  let now = NOW, fail = false;
  const request = requestFixture([], { "/portfolio/accounts": () => { if (fail) throw new Error("Expired"); return [account]; } });
  const client = new IbkrClient({ store: memoryStore(), request, clock: () => now, pacingMs: 0 });
  await client.configure({ transport: "gateway", enabled: true, accountId: account.id }); await client.refresh();
  fail = true; now += 10_000; await assert.rejects(client.refresh(), /Expired/);
  assert.equal(client.portfolio.syncedAt, new Date(NOW).toISOString()); assert.equal(client.portfolio.status, "stale");
});
test("IBKR account change drains old request and cannot publish old positions into new scope", async () => {
  const store = memoryStore(); let release, entered;
  const started = new Promise((r) => { entered = r; });
  const wait = new Promise((r) => { release = r; });
  const request = requestFixture([], { "/portfolio/accounts": async () => { entered(); await wait; return [account]; } });
  const client = new IbkrClient({ store, request, clock: () => NOW, pacingMs: 0 });
  await client.configure({ transport: "gateway", enabled: true, accountId: account.id });
  const work = client.refresh(); const rejected = assert.rejects(work); await started;
  const changed = client.configure({ transport: "gateway", enabled: true, accountId: "U7654321" }); release();
  await Promise.all([rejected, changed]); assert.equal(client.portfolio, null);
  assert.equal(store.values.has("ibkrPortfolioSnapshotV1"), false);
});
test("full-portfolio Agent receives broker legs and option fields via actual bounded context blocks", async () => {
  const p = buildBrokerViews({ longbridge: makePortfolio(), ibkr: makePortfolio(), ibkrEnabled: true, now: NOW }).all;
  const run = await buildAnalysisEvidence({ portfolio: p, scope: "portfolio", task: "审查组合" });
  run.context.brokerScope = "all";
  const evidence = buildCodexEvidence({ portfolio: p, run, task: "审查组合" });
  const text = JSON.stringify(buildWorkspaceAdditionalContext(evidence, "研究，不下单"));
  assert.match(text, /ivPercent/); assert.match(text, /brokerLegs/); assert.match(text, /IBKR/);
  assert.equal(evidence.scopedContext.positions.filter((p) => p.instrumentType === "option").length, 2);
});
test("renderer and host wire independent brokers, frozen analysis scope and no IBKR review ledger mixing", async () => {
  const main = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.match(main, /scope === "review" \? "longbridge"/);
  assert.match(main, /ibkrGeneration !== ibkr.generation/);
  assert.match(main, /brokerUiSnapshot\(\).views\[requestedBrokerScope\]/);
  assert.match(renderer, /brokerScope: state.brokerScope/);
  assert.match(renderer, /refreshBrokerScope\(broker\)/);
  assert.match(html, /data-broker-scope="all"/);
  assert.match(html, /当前复盘与自动收盘快照仍仅覆盖长桥/);
});
