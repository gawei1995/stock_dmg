import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TradeHistoryService } from "../src/data/trade-history-service.mjs";
import { AuthorizationGenerationGate } from "../src/data/authorization-generation.mjs";
import { EncryptedStore } from "../src/security/encrypted-store.mjs";

const RANGE = { startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-08-10T00:00:00.000Z" };
const STALE = { code: "STALE_LONGBRIDGE_AUTHORIZATION_GENERATION" };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const order = (id = "order-a", at = "2026-08-03T14:00:00.000Z") => ({
  order_id: id, symbol: "AAPL.US", side: "Buy", status: "FilledStatus", quantity: "1",
  executed_quantity: "1", executed_price: "200", submitted_at: at, currency: "USD",
});
function memoryStore() {
  const values = new Map();
  return { values, get: async (key) => structuredClone(values.get(key)),
    set: async (key, value, options = {}) => { options.commitGuard?.(); values.set(key, structuredClone(value)); } };
}
function fixture({ store = memoryStore(), call, supports = ["history_orders", "history_executions"] } = {}) {
  let scope = "scope-account-a";
  const gate = new AuthorizationGenerationGate();
  const calls = [];
  const longbridge = { connected: true, connectionGeneration: 0, supports: (name) => supports.includes(name),
    call: async (name, args) => { calls.push({ name, args, scope }); return call ? call(name, args) : name === "history_orders" ? { orders: [order()] } : { trades: [] }; } };
  const service = new TradeHistoryService({ longbridge, store, authorizationLifecycle: gate,
    getAccountScopeId: () => scope, requireAccountScope: true });
  return { service, gate, longbridge, calls, store, switchScope: () => { scope = "scope-account-b"; } };
}

test("history operation rejects account changes between async queries without submitting mixed evidence", async () => {
  const entered = deferred(), release = deferred();
  const fx = fixture({ call: async (name) => {
    if (name === "history_orders") { entered.resolve(); await release.promise; return { orders: [order()] }; }
    return { trades: [{ trade_id: "from-b", order_id: "order-b" }] };
  } });
  const pending = fx.service.sync(RANGE);
  const rejected = assert.rejects(pending, STALE);
  await entered.promise;
  fx.switchScope(); release.resolve();
  await rejected;
  assert.deepEqual(fx.calls.map((item) => item.name), ["history_orders"]);
  assert.equal(fx.store.values.has("brokerTradeHistoryV1"), false);
});

test("reauthorizing the same account invalidates tracked history work and does not advance its archive", async () => {
  const entered = deferred(), release = deferred();
  const fx = fixture({ call: async () => { entered.resolve(); await release.promise; return { orders: [] }; } });
  const pending = fx.service.sync(RANGE);
  const rejected = assert.rejects(pending, STALE);
  await entered.promise; fx.gate.advance();
  assert.equal((await fx.gate.settleSuperseded({ timeoutMs: 0 })).settled, false);
  release.resolve(); await rejected;
  assert.equal((await fx.gate.settleSuperseded({ timeoutMs: 0 })).settled, true);
  assert.equal(fx.store.values.has("brokerTradeHistoryV1"), false);
});

test("identical normalized history requests join, but another query is explicitly rejected instead of mislabeled", async () => {
  const entered = deferred(), release = deferred();
  const fx = fixture({ supports: ["history_orders"], call: async () => {
    entered.resolve(); await release.promise; return { orders: [order()] };
  } });
  const first = fx.service.sync({ ...RANGE, symbol: "aapl.us" });
  await entered.promise;
  const identical = fx.service.sync({ startAt: "2026-08-01", endAt: "2026-08-10", symbol: "AAPL.US" });
  await assert.rejects(fx.service.sync({ ...RANGE, symbol: "MSFT.US" }), { code: "HISTORY_SYNC_BUSY" });
  await assert.rejects(fx.service.sync({ ...RANGE, endAt: "2026-08-11" }), { code: "HISTORY_SYNC_BUSY" });
  release.resolve();
  const [a, b] = await Promise.all([first, identical]);
  assert.deepEqual(a, b); assert.equal(fx.calls.length, 1);
  const next = await fx.service.sync({ ...RANGE, symbol: "MSFT.US" });
  assert.equal(fx.calls.at(-1).args.symbol, "MSFT.US");
  assert.equal(next.accountScopeId, "scope-account-a");
});

test("account switch at the actual encrypted commit boundary leaves both disk and cache unchanged", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "cockpit-history-guard-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let atCommit = null;
  const store = new EncryptedStore({ directory,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() },
    fileIO: { open: async (...args) => {
      const handle = await open(...args);
      return { writeFile: (...values) => handle.writeFile(...values), sync: () => handle.sync(), close: async () => {
        await handle.close(); if (atCommit) atCommit();
      } };
    } },
  });
  await store.set("sentinel", { retained: true });
  const before = await readFile(store.filePath);
  const fx = fixture({ store });
  atCommit = fx.switchScope;
  await assert.rejects(fx.service.sync(RANGE), STALE);
  assert.deepEqual(await readFile(store.filePath), before);
  assert.deepEqual(await store.readAll(), { sentinel: { retained: true } });
});

test("calendar enrichment shares the archive queue and cannot overwrite a later order sync", async () => {
  const entered = deferred(), release = deferred();
  const fx = fixture({ supports: ["history_orders", "finance_calendar"], call: async (name) => {
    if (name === "finance_calendar") { entered.resolve(); await release.promise; return []; }
    return { orders: [order()] };
  } });
  const calendar = fx.service.preloadRecentEventCandidates({ symbols: ["AAPL.US"], asOf: "2026-08-10" });
  await entered.promise;
  assert.equal(fx.service.busy, true, "calendar-only work must block restoring the shared archive");
  const history = fx.service.sync(RANGE);
  release.resolve(); await Promise.all([calendar, history]);
  assert.equal(fx.service.busy, false);
  assert.equal((await fx.service.cached()).orders[0].orderId, "order-a");
});

test("queued calendar lookup captures its original account and cannot query or commit after switching", async () => {
  const entered = deferred(), release = deferred();
  const fx = fixture({ supports: ["history_orders", "finance_calendar"], call: async (name) => {
    if (name === "history_orders") { entered.resolve(); await release.promise; return { orders: [order()] }; }
    return [];
  } });
  const history = fx.service.sync(RANGE);
  const rejectedHistory = assert.rejects(history, STALE);
  await entered.promise;
  const calendar = fx.service.preloadRecentEventCandidates({ symbols: ["AAPL.US"], asOf: "2026-08-10" });
  const rejectedCalendar = assert.rejects(calendar, STALE);
  fx.switchScope(); release.resolve();
  await Promise.all([rejectedHistory, rejectedCalendar]);
  assert.equal(fx.calls.some((item) => item.name === "finance_calendar"), false);
  assert.equal(fx.store.values.has("brokerTradeHistoryV1"), false);
});

test("ninety-day history windows overlap and deduplicate boundary fills without losing subsecond orders", async () => {
  const start = Date.parse("2026-04-01T00:00:00.000Z");
  const boundary = start + 90 * 86_400_000;
  const rows = [order("boundary", new Date(boundary).toISOString()), order("subsecond", new Date(boundary + 500).toISOString())];
  const fx = fixture({ supports: ["history_orders"], call: async (_name, args) => ({ orders: rows.filter((item) => {
    const timestamp = Date.parse(item.submitted_at);
    return timestamp >= Date.parse(args.start_at) && timestamp <= Date.parse(args.end_at);
  }) }) });
  const result = await fx.service.sync({ startAt: new Date(start).toISOString(), endAt: new Date(boundary + 86_400_000).toISOString() });
  assert.deepEqual(result.orders.map((item) => item.orderId).sort(), ["boundary", "subsecond"]);
  assert.equal(fx.calls[0].args.end_at, fx.calls[1].args.start_at);
});

test("recursive execution splitting overlaps, includes millisecond fills and deduplicates the midpoint", async () => {
  const start = Date.parse(RANGE.startAt), end = Date.parse(RANGE.endAt), middle = start + Math.floor((end - start) / 2);
  const rows = Array.from({ length: 100 }, (_, index) => ({ trade_id: `fill-${index}`, order_id: `order-${index}`, symbol: "AAPL.US", quantity: "1", price: "200", trade_done_at: new Date(start + index * 1_000).toISOString() }));
  rows.push(...[0, 500].map((offset) => ({ trade_id: `edge-${offset}`, order_id: `edge-order-${offset}`, symbol: "AAPL.US", quantity: "1", price: "200", trade_done_at: new Date(middle + offset).toISOString() })));
  const fx = fixture({ supports: ["history_executions"], call: async (_name, args) => rows.filter((item) => Date.parse(item.trade_done_at) >= Date.parse(args.start_at) && Date.parse(item.trade_done_at) <= Date.parse(args.end_at)) });
  const result = await fx.service.sync(RANGE);
  assert.equal(result.executions.length, 102);
  assert.equal(result.executions.filter((item) => item.tradeId === "edge-0").length, 1);
  assert.ok(result.executions.some((item) => item.tradeId === "edge-500"));
});
