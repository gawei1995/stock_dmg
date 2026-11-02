import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTradeHistoryIntake,
  matchExecutionsToEvent,
  matchOrdersToEvent,
  resolveBrokerRecordSelection,
  resolveReviewSelection,
  TradeHistoryService,
} from "../src/data/trade-history-service.mjs";

class MemoryStore {
  constructor() { this.values = new Map(); }
  async get(key) { return structuredClone(this.values.get(key)); }
  async set(key, value) { this.values.set(key, structuredClone(value)); }
}

function priceAuditLongbridge({ candidatePrice, candleRows, candleCalls = [] }) {
  const peerFills = [
    ["peer-1", "peer-fill-1", "2026-07-10T14:00:00.000Z", "198"],
    ["peer-2", "peer-fill-2", "2026-07-17T14:00:00.000Z", "200"],
    ["peer-3", "peer-fill-3", "2026-07-24T14:00:00.000Z", "202"],
  ];
  return {
    connected: true,
    supports: (name) => ["history_orders", "history_executions", "candlesticks"].includes(name),
    async call(name, args) {
      if (name === "history_orders") {
        return { orders: [
          {
            order_id: "candidate-order",
            symbol: "AAPL.US",
            side: "Sell",
            status: "FilledStatus",
            quantity: "1",
            executed_quantity: "1",
            executed_price: candidatePrice,
            submitted_at: "2026-07-31T13:30:00.000Z",
            currency: "USD",
          },
          ...peerFills.map(([orderId, , doneAt, price]) => ({
            order_id: orderId,
            symbol: "AAPL.US",
            side: "Buy",
            status: "FilledStatus",
            quantity: "1",
            executed_quantity: "1",
            executed_price: price,
            submitted_at: doneAt,
            currency: "USD",
          })),
        ], has_more: false };
      }
      if (name === "history_executions") {
        return { trades: [
          {
            trade_id: "candidate-fill",
            order_id: "candidate-order",
            symbol: "AAPL.US",
            quantity: "1",
            price: candidatePrice,
            trade_done_at: "2026-07-31T13:30:16.000Z",
          },
          ...peerFills.map(([orderId, tradeId, doneAt, price]) => ({
            trade_id: tradeId,
            order_id: orderId,
            symbol: "AAPL.US",
            quantity: "1",
            price,
            trade_done_at: doneAt,
          })),
        ], has_more: false };
      }
      if (name === "candlesticks") {
        candleCalls.push(args);
        return { candlesticks: candleRows };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
}

function parentOnlyPriceAuditLongbridge({ candidatePrice, candleRows, candleCalls = [] }) {
  const peerOrders = [
    ["peer-parent-1", "2026-07-10T14:00:00.000Z", "198"],
    ["peer-parent-2", "2026-07-17T14:00:00.000Z", "200"],
    ["peer-parent-3", "2026-07-24T14:00:00.000Z", "202"],
  ];
  return {
    connected: true,
    supports: (name) => ["history_orders", "history_executions", "candlesticks"].includes(name),
    async call(name, args) {
      if (name === "history_orders") {
        return { orders: [
          {
            order_id: "candidate-parent-only",
            symbol: "AAPL.US",
            side: "Sell",
            status: "FilledStatus",
            quantity: "1",
            executed_quantity: "1",
            executed_price: candidatePrice,
            submitted_at: "2026-07-31T13:30:00.000Z",
            currency: "USD",
          },
          ...peerOrders.map(([orderId, submittedAt, price]) => ({
            order_id: orderId,
            symbol: "AAPL.US",
            side: "Buy",
            status: "FilledStatus",
            quantity: "1",
            executed_quantity: "1",
            executed_price: price,
            submitted_at: submittedAt,
            currency: "USD",
          })),
        ], has_more: false };
      }
      if (name === "history_executions") return { trades: [], has_more: false };
      if (name === "candlesticks") {
        candleCalls.push(args);
        return { candlesticks: candleRows };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
}

test("trade history merges history and today executions without duplicating fills", async () => {
  const calls = [];
  const longbridge = {
    connected: true,
    supports: () => true,
    async call(name, args) {
      calls.push({ name, args });
      if (name === "history_orders") {
        return { orders: [{
          order_id: "o-1",
          symbol: "AAPL.US",
          side: "Buy",
          status: "FilledStatus",
          quantity: "2",
          executed_quantity: "2",
          executed_price: "190",
          submitted_at: "1785801600",
          currency: "USD",
        }], has_more: false };
      }
      if (name === "history_executions") {
        return { trades: [{
          trade_id: "t-1",
          order_id: "o-1",
          symbol: "AAPL.US",
          quantity: "1",
          price: "189",
          trade_done_at: "1785801700",
        }], has_more: false };
      }
      if (name === "today_orders") return { orders: [] };
      if (name === "today_executions") {
        return { trades: [{
          trade_id: "t-1",
          order_id: "o-1",
          symbol: "AAPL.US",
          quantity: "1",
          price: "189",
          trade_done_at: "1785801700",
        }] };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const service = new TradeHistoryService({ longbridge, store: new MemoryStore() });
  const archive = await service.sync({
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-09T00:00:00.000Z",
  });

  assert.equal(archive.orders.length, 1);
  assert.equal(archive.executions.length, 1);
  assert.equal(archive.executions[0].side, "Buy");
  assert.equal(archive.executions[0].currency, "USD");
  assert.match(calls.find((item) => item.name === "history_orders").args.start_at, /^2026-08-01T/);
});

test("opaque account scope isolates cached history and prevents cross-account merges", async () => {
  const store = new MemoryStore();
  let scopeId = "scope-account-a";
  const longbridge = {
    connected: true,
    supports: (name) => ["history_orders", "history_executions"].includes(name),
    async call(name) {
      if (name === "history_orders") return { orders: [{
        order_id: `order-${scopeId}`,
        symbol: "AAPL.US",
        side: "Buy",
        status: "FilledStatus",
        quantity: "1",
        executed_quantity: "1",
        executed_price: "200",
        submitted_at: "1785801600",
        currency: "USD",
      }], has_more: false };
      if (name === "history_executions") return { trades: [{
        trade_id: `trade-${scopeId}`,
        order_id: `order-${scopeId}`,
        symbol: "AAPL.US",
        quantity: "1",
        price: "200",
        trade_done_at: "1785801700",
      }], has_more: false };
      throw new Error(`unexpected ${name}`);
    },
  };
  const service = new TradeHistoryService({
    longbridge,
    store,
    getAccountScopeId: () => scopeId,
    requireAccountScope: true,
  });
  const first = await service.sync({
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-09T00:00:00.000Z",
  });
  assert.equal(first.accountScopeId, "scope-account-a");
  assert.deepEqual(first.orders.map((item) => item.orderId), ["order-scope-account-a"]);

  scopeId = "scope-account-b";
  const isolated = await service.cached();
  assert.equal(isolated.accountScopeId, "scope-account-b");
  assert.equal(isolated.orders.length, 0);
  assert.match(isolated.warnings[0], /另一匿名账户作用域/);

  const second = await service.sync({
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-09T00:00:00.000Z",
  });
  assert.deepEqual(second.orders.map((item) => item.orderId), ["order-scope-account-b"]);
  assert.equal(second.orders.some((item) => item.orderId === "order-scope-account-a"), false);
  scopeId = "scope-account-a";
  const returnedToFirst = await service.cached();
  assert.deepEqual(returnedToFirst.orders.map(item => item.orderId), ["order-scope-account-a"]);
  assert.equal(returnedToFirst.orders.some(item => item.orderId === "order-scope-account-b"), false);
  const restarted = new TradeHistoryService({ longbridge, store, getAccountScopeId: () => scopeId, requireAccountScope: true });
  assert.deepEqual((await restarted.cached()).orders.map(item => item.orderId), ["order-scope-account-a"]);
});

test("orphan executions backfill each unique parent once and are renormalized from read-only order detail", async () => {
  const detailCalls = [];
  const longbridge = {
    connected: true,
    supports: (name) => ["history_orders", "history_executions", "order_detail"].includes(name),
    async call(name, args) {
      if (name === "history_orders") return { orders: [], has_more: false };
      if (name === "history_executions") {
        return {
          trades: [
            {
              trade_id: "fill-a",
              order_id: "missing-parent",
              symbol: "AAOI.US",
              quantity: "80",
              price: "27.50",
              trade_done_at: "1785801700",
            },
            {
              trade_id: "fill-b",
              order_id: "missing-parent",
              symbol: "AAOI.US",
              quantity: "20",
              price: "27.75",
              trade_done_at: "1785801800",
            },
          ],
          has_more: false,
        };
      }
      if (name === "order_detail") {
        detailCalls.push(args);
        return {
          data: {
            order_id: "missing-parent",
            symbol: "AAOI.US",
            side: "Buy",
            status: "FilledStatus",
            quantity: "100",
            executed_quantity: "100",
            price: "",
            executed_price: "27.55",
            submitted_at: "1785801600",
            charge_detail: { currency: "USD" },
          },
        };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const service = new TradeHistoryService({
    longbridge,
    store: new MemoryStore(),
    orderDetailMinIntervalMs: 0,
  });
  const archive = await service.sync({
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-09T00:00:00.000Z",
  });

  assert.deepEqual(detailCalls, [{ order_id: "missing-parent", is_attached: false }]);
  assert.equal(archive.orders.length, 1);
  assert.equal(archive.orders[0].submittedPrice, null, "an empty broker field is not converted to zero");
  assert.deepEqual(archive.executions.map((item) => item.side), ["Buy", "Buy"]);
  assert.deepEqual(archive.executions.map((item) => item.currency), ["USD", "USD"]);
  assert.deepEqual(archive.executions.map((item) => item.priceAudit.status), ["accepted", "accepted"]);
  assert.deepEqual(archive.executions.map((item) => item.priceAudit.parentOrderMatched), [true, true]);
  assert.deepEqual(archive.parentOrderBackfill, {
    status: "ready",
    discoveredOrderCount: 1,
    attemptedOrderCount: 1,
    recoveredOrderCount: 1,
    recoveredAttachedOrderCount: 0,
    failedOrderCount: 0,
    deferredOrderCount: 0,
    queryCallCount: 1,
    retryCallCount: 0,
  });
  assert.equal(archive.warnings.some((item) => /孤立股票成交/.test(item)), false);
});

test("missing attached parents use the explicit read-only attached detail query", async () => {
  const detailCalls = [];
  const longbridge = {
    connected: true,
    supports: (name) => ["history_orders", "history_executions", "order_detail"].includes(name),
    async call(name, args) {
      if (name === "history_orders") return { orders: [], has_more: false };
      if (name === "history_executions") {
        return {
          trades: [{
            trade_id: "attached-fill",
            order_id: "attached-stop",
            symbol: "NVDA.US",
            quantity: "5",
            price: "175",
            trade_done_at: "1785801700",
          }],
          has_more: false,
        };
      }
      if (name === "order_detail") {
        detailCalls.push(args);
        if (!args.is_attached) throw new Error("normal order not found");
        return {
          order_id: "attached-stop",
          symbol: "NVDA.US",
          side: "Sell",
          status: "FilledStatus",
          quantity: "5",
          executed_qty: "5",
          submit_price: "",
          executed_price: "175",
          submitted_at: "1785801600",
          charge_detail: { currency: "USD" },
        };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const service = new TradeHistoryService({
    longbridge,
    store: new MemoryStore(),
    orderDetailMinIntervalMs: 0,
  });
  const archive = await service.sync({
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-09T00:00:00.000Z",
  });

  assert.deepEqual(detailCalls, [
    { order_id: "attached-stop", is_attached: false },
    { order_id: "attached-stop", is_attached: true },
  ]);
  assert.equal(archive.parentOrderBackfill.recoveredAttachedOrderCount, 1);
  assert.equal(archive.executions[0].side, "Sell");
  assert.equal(archive.executions[0].currency, "USD");
  assert.equal(archive.executions[0].price, 175);
});

test("parent detail retries are bounded and a failed backfill preserves the original execution evidence", async () => {
  let detailCallCount = 0;
  const longbridge = {
    connected: true,
    supports: (name) => ["history_orders", "history_executions", "order_detail"].includes(name),
    async call(name) {
      if (name === "history_orders") return { orders: [], has_more: false };
      if (name === "history_executions") {
        return {
          trades: [{
            trade_id: "still-orphan",
            order_id: "unavailable-parent",
            symbol: "TSLA.US",
            quantity: "1",
            price: "5.36",
            trade_done_at: "1785801700",
          }],
          has_more: false,
        };
      }
      if (name === "order_detail") {
        detailCallCount += 1;
        const error = new Error("gateway timeout");
        error.retryable = true;
        error.kind = "timeout";
        throw error;
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const service = new TradeHistoryService({
    longbridge,
    store: new MemoryStore(),
    orderDetailMinIntervalMs: 0,
  });
  const archive = await service.sync({
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-09T00:00:00.000Z",
  });

  assert.equal(detailCallCount, 2, "one initial detail call plus at most one retry");
  assert.equal(archive.orders.length, 0);
  assert.equal(archive.executions[0].reportedPrice, 5.36);
  assert.equal(archive.executions[0].price, null);
  assert.equal(archive.executions[0].priceAudit.status, "excluded");
  assert.equal(archive.parentOrderBackfill.failedOrderCount, 1);
  assert.equal(archive.parentOrderBackfill.retryCallCount, 1);
  assert.equal(archive.completeness.orders, "best_effort");
  assert.match(archive.warnings.join("\n"), /详情查询失败.*原成交继续保留.*未填 0/);
});

test("parent detail backfill has bounded concurrency and defers IDs beyond the per-sync read limit", async () => {
  let active = 0;
  let peakActive = 0;
  const detailOrderIds = [];
  const missingCount = 125;
  const longbridge = {
    connected: true,
    supports: (name) => ["history_orders", "history_executions", "order_detail"].includes(name),
    async call(name, args) {
      if (name === "history_orders") return { orders: [], has_more: false };
      if (name === "history_executions") {
        return {
          trades: Array.from({ length: missingCount }, (_, index) => ({
            trade_id: `bounded-fill-${index}`,
            order_id: `bounded-order-${index}`,
            symbol: "AAPL.US",
            quantity: "1",
            price: "200",
            trade_done_at: 1785801700 + index,
          })),
          has_more: false,
        };
      }
      if (name === "order_detail") {
        detailOrderIds.push(args.order_id);
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return {
          order_id: args.order_id,
          symbol: "AAPL.US",
          side: "Buy",
          status: "FilledStatus",
          quantity: "1",
          executed_quantity: "1",
          executed_price: "200",
          submitted_at: "1785801600",
          charge_detail: { currency: "USD" },
        };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const service = new TradeHistoryService({
    longbridge,
    store: new MemoryStore(),
    orderDetailMinIntervalMs: 0,
  });
  const archive = await service.sync({
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-09T00:00:00.000Z",
  });

  assert.equal(new Set(detailOrderIds).size, 120, "the same missing order is never queried twice");
  assert.ok(peakActive <= 3, `expected at most three concurrent detail calls, saw ${peakActive}`);
  assert.equal(archive.parentOrderBackfill.attemptedOrderCount, 120);
  assert.equal(archive.parentOrderBackfill.deferredOrderCount, 5);
  assert.equal(archive.parentOrderBackfill.status, "degraded");
  assert.match(archive.warnings.join("\n"), /本次按只读限额查询 120 个.*其余 5 个留待后续同步/);
});

test("trade history capability is optional and never turns missing queries into writes", async () => {
  const longbridge = {
    connected: true,
    supports: (name) => name === "history_executions",
    async call(name) {
      assert.equal(name, "history_executions");
      return { trades: [], has_more: false };
    },
  };
  const service = new TradeHistoryService({ longbridge, store: new MemoryStore() });
  const archive = await service.sync({
    startAt: "2026-07-01T00:00:00.000Z",
    endAt: "2026-08-01T00:00:00.000Z",
  });
  assert.equal(archive.capabilities.historyOrders, false);
  assert.equal(archive.capabilities.historyExecutions, true);
});

test("successful history with failed current-day queries is never marked complete", async () => {
  const calls = [];
  const longbridge = {
    connected: true,
    supports: (name) => [
      "history_orders",
      "history_executions",
      "today_orders",
      "today_executions",
    ].includes(name),
    async call(name) {
      calls.push(name);
      if (name === "history_orders") return { orders: [], has_more: false };
      if (name === "history_executions") return { trades: [], has_more: false };
      if (name === "today_orders" || name === "today_executions") {
        throw new Error("current-day endpoint unavailable");
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const service = new TradeHistoryService({ longbridge, store: new MemoryStore() });
  const endAt = new Date().toISOString();
  const startAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const archive = await service.sync({ startAt, endAt });

  assert.ok(calls.includes("today_orders"));
  assert.ok(calls.includes("today_executions"));
  assert.equal(archive.completeness.orders, "best_effort");
  assert.equal(archive.completeness.executions, "best_effort");
  assert.match(archive.warnings.join("\n"), /today_orders/);
  assert.match(archive.warnings.join("\n"), /today_executions/);
});

test("a total historical-query failure preserves the last successful cache and never advances freshness", async () => {
  const repository = new MemoryStore();
  repository.values.set("brokerTradeHistoryV1", {
    schemaVersion: 2,
    source: "Longbridge MCP · read only",
    syncedAt: "2026-07-01T00:00:00.000Z",
    range: { startAt: "2026-06-01T00:00:00.000Z", endAt: "2026-07-01T00:00:00.000Z" },
    capabilities: { historyOrders: true, historyExecutions: true },
    completeness: { orders: "complete", executions: "windowed" },
    warnings: [],
    orders: [{
      orderId: "old-order",
      symbol: "AAPL.US",
      submittedAt: "2026-06-20T12:00:00.000Z",
    }],
    executions: [],
    events: [],
  });
  const calls = [];
  const longbridge = {
    connected: true,
    supports: (name) => ["history_orders", "history_executions"].includes(name),
    async call(name) {
      calls.push(name);
      throw new Error("MCP 463 gateway unavailable");
    },
  };
  const service = new TradeHistoryService({ longbridge, store: repository });

  await assert.rejects(service.sync({
    startAt: "2025-08-01T00:00:00.000Z",
    endAt: "2026-08-01T00:00:00.000Z",
  }), /查询全部失败/);
  assert.deepEqual(calls, ["history_orders", "history_executions"]);
  const cached = await service.cached();
  assert.equal(cached.syncedAt, "2026-07-01T00:00:00.000Z");
  assert.equal(cached.range.endAt, "2026-07-01T00:00:00.000Z");
  assert.deepEqual(cached.orders.map((item) => item.orderId), ["old-order"]);
});

test("scope 403308 fails on the first request with an actionable reauthorization status", async () => {
  const store = new MemoryStore();
  const calls = [];
  const status = [];
  const longbridge = {
    connected: true,
    supports: (name) => ["history_orders", "history_executions"].includes(name),
    async call(name) {
      calls.push(name);
      const error = new Error("Target API's scope is not in authorized scopes");
      error.kind = "permission";
      error.code = 403308;
      error.retryable = false;
      error.reauth = true;
      throw error;
    },
  };
  const service = new TradeHistoryService({
    longbridge,
    store,
    onStatus: (event) => status.push(event),
  });

  await assert.rejects(
    service.sync({
      startAt: "2025-08-01T00:00:00.000Z",
      endAt: "2026-08-01T00:00:00.000Z",
    }),
    (error) => error.code === 403308
      && error.reauth === true
      && /升级只读授权/.test(error.message)
      && /不会申请下单权限/.test(error.message),
  );
  assert.deepEqual(calls, ["history_orders"]);
  assert.equal(status.at(-1)?.state, "scope_upgrade_required");
  assert.equal((await service.cached()).syncedAt, null);
});

test("an offline legacy authorization enters the same explicit upgrade flow without broker calls", async () => {
  let brokerCalls = 0;
  const status = [];
  const service = new TradeHistoryService({
    longbridge: {
      connected: false,
      async needsAuthorizationUpgrade() { return true; },
      async call() { brokerCalls += 1; },
    },
    store: new MemoryStore(),
    onStatus: (event) => status.push(event),
  });

  await assert.rejects(
    service.sync({
      startAt: "2026-07-01T00:00:00.000Z",
      endAt: "2026-08-01T00:00:00.000Z",
    }),
    (error) => error.code === 403308 && error.reauth === true,
  );
  assert.equal(brokerCalls, 0);
  assert.equal(status.at(-1)?.state, "scope_upgrade_required");
});

test("US history orders follow total_count pagination instead of stopping at the default page", async () => {
  const pages = [];
  const longbridge = {
    connected: true,
    supports: (name) => name === "history_orders",
    async call(name, args) {
      assert.equal(name, "history_orders");
      pages.push(args.us_page);
      const start = (args.us_page - 1) * 100;
      const count = Math.min(100, 205 - start);
      return {
        total_count: 205,
        orders: Array.from({ length: count }, (_, index) => ({
          id: `us-${start + index + 1}`,
          symbol: "AAPL.US",
          action: "Buy",
          quantity: "1",
          price: "200",
          submitted_at: 1785801600 + start + index,
          updated_at: 1785801600 + start + index,
        })),
      };
    },
  };
  const service = new TradeHistoryService({ longbridge, store: new MemoryStore() });
  const archive = await service.sync({
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-09T00:00:00.000Z",
  });

  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(archive.orders.length, 205);
  assert.equal(archive.orders[0].side, "Buy");
});

test("root-array US order history keeps paging until a short page", async () => {
  const pages = [];
  const longbridge = {
    connected: true,
    supports: (name) => name === "history_orders",
    async call(name, args) {
      assert.equal(name, "history_orders");
      pages.push(args.us_page);
      const start = (args.us_page - 1) * 100;
      const count = Math.max(0, Math.min(100, 249 - start));
      return Array.from({ length: count }, (_, index) => ({
        id: `array-${start + index + 1}`,
        symbol: "AAPL.US",
        action: "Buy",
        quantity: "1",
        submitted_at: 1785801600 + start + index,
      }));
    },
  };
  const service = new TradeHistoryService({ longbridge, store: new MemoryStore() });
  const archive = await service.sync({
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-08T00:00:00.000Z",
  });

  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(archive.orders.length, 249);
  assert.equal(archive.completeness.orders, "complete");
});

test("large root-array executions are re-queried through narrower time windows", async () => {
  const calls = [];
  const rows = Array.from({ length: 102 }, (_, index) => ({
    trade_id: `trade-${index + 1}`,
    order_id: `order-${index + 1}`,
    symbol: "NVDA.US",
    quantity: "1",
    price: "180",
    trade_done_at: Math.floor(Date.parse("2026-08-01T00:00:00.000Z") / 1000) + index * 4_000,
  }));
  const longbridge = {
    connected: true,
    supports: (name) => name === "history_executions",
    async call(name, args) {
      assert.equal(name, "history_executions");
      calls.push(args);
      const start = Date.parse(args.start_at) / 1000;
      const end = Date.parse(args.end_at) / 1000;
      return rows.filter((item) => item.trade_done_at >= start && item.trade_done_at <= end);
    },
  };
  const service = new TradeHistoryService({ longbridge, store: new MemoryStore() });
  const archive = await service.sync({
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-08T00:00:00.000Z",
  });

  assert.ok(calls.length > 1);
  assert.equal(archive.executions.length, 102);
  assert.equal(archive.completeness.executions, "windowed");
});

test("review intake is sanitized and record selections resolve only from the encrypted archive", () => {
  const archive = {
    schemaVersion: 2,
    source: "Longbridge MCP · read only",
    syncedAt: "2026-08-09T00:00:00.000Z",
    range: { startAt: "2026-07-01T00:00:00.000Z", endAt: "2026-08-09T00:00:00.000Z" },
    capabilities: { historyOrders: true, historyExecutions: true },
    warnings: [],
    orders: [{
      orderId: "secret-order-id",
      symbol: "AAPL.US",
      side: "Buy",
      status: "FilledStatus",
      quantity: 2,
      executedQuantity: 2,
      executedPrice: 200,
      currency: "USD",
      submittedAt: "2026-08-01T12:00:00.000Z",
      account_id: "must-not-leak",
    }],
    executions: [{
      tradeId: "secret-trade-id",
      orderId: "secret-order-id",
      symbol: "AAPL.US",
      side: "Buy",
      quantity: 2,
      price: 200,
      currency: "USD",
      doneAt: "2026-08-01T12:01:00.000Z",
    }],
    events: [],
  };
  const intake = buildTradeHistoryIntake(archive);
  assert.equal(intake.records.length, 2);
  assert.equal(intake.records.some((item) => Object.hasOwn(item, "account_id")), false);
  assert.equal(intake.records.some((item) => Object.hasOwn(item, "orderId")), false);
  const selection = resolveReviewSelection(archive, {
    recordIds: ["order:secret-order-id", "execution:secret-trade-id"],
  });
  assert.equal(selection.symbol, "AAPL.US");
  assert.equal(selection.activityStartAt, "2026-08-01T12:00:00.000Z");
  assert.deepEqual(selection.orderIds, ["secret-order-id"]);
  assert.throws(
    () => resolveReviewSelection(archive, { recordIds: ["order:forged"] }),
    /不在本机加密长桥历史/,
  );
});

test("orphan equity execution prices without parent, side, or currency stay auditable but are not displayed as fills", () => {
  const archive = {
    schemaVersion: 2,
    source: "Longbridge MCP · read only",
    syncedAt: "2026-08-18T00:00:00.000Z",
    range: { startAt: "2026-07-01T00:00:00.000Z", endAt: "2026-08-18T00:00:00.000Z" },
    capabilities: { historyOrders: true, historyExecutions: true },
    warnings: [],
    orders: [{
      orderId: "known-equity-order",
      symbol: "TSLA.US",
      side: "Buy",
      status: "FilledStatus",
      quantity: 1,
      executedQuantity: 1,
      executedPrice: 5.36,
      currency: "USD",
      submittedAt: "2026-08-01T12:00:00.000Z",
    }],
    executions: [
      {
        tradeId: "orphan-equity",
        orderId: "missing-parent",
        symbol: "TSLA.US",
        quantity: 1,
        price: 5.36,
        doneAt: "2026-08-01T12:01:00.000Z",
      },
      {
        tradeId: "orphan-option",
        orderId: "missing-option-parent",
        symbol: "TSLA260918C500000.US",
        quantity: 1,
        price: 2.31,
        doneAt: "2026-08-01T12:02:00.000Z",
      },
      {
        tradeId: "matched-equity",
        orderId: "known-equity-order",
        symbol: "TSLA.US",
        quantity: 1,
        price: 5.36,
        doneAt: "2026-08-01T12:03:00.000Z",
      },
    ],
    events: [],
  };
  const intake = buildTradeHistoryIntake(archive);
  assert.equal(intake.records.some((item) => item.recordId === "execution:orphan-equity"), false);
  assert.equal(intake.records.some((item) => item.recordId === "execution:orphan-option"), false);
  assert.equal(intake.excludedExecutionAudit.totalCount, 2);
  const auditIntake = buildTradeHistoryIntake(archive, { includeExcludedOrders: true });
  const orphanEquity = auditIntake.records.find((item) => item.recordId === "execution:orphan-equity");
  const orphanOption = auditIntake.records.find((item) => item.recordId === "execution:orphan-option");
  const matchedEquity = intake.records.find((item) => item.recordId === "execution:matched-equity");

  assert.equal(orphanEquity.price, null);
  assert.equal(orphanEquity.reportedPrice, 5.36);
  assert.equal(orphanEquity.priceAudit.status, "excluded");
  assert.equal(orphanEquity.priceAudit.sourceField, "Longbridge history_executions.price");
  assert.equal(orphanEquity.priceAudit.reason, "orphan_equity_execution_missing_parent_side_currency");
  assert.equal(orphanOption.price, 2.31, "the raw option premium remains visible in the audit-only projection");
  assert.equal(orphanOption.priceAudit.status, "accepted");
  assert.equal(orphanOption.reviewEligibility.status, "audit_only");
  assert.equal(matchedEquity.price, 5.36, "a matched equity execution remains visible regardless of its numeric level");
  assert.equal(intake.executionCount, 3, "the suspect broker record is retained, not silently deleted");

  assert.throws(
    () => resolveBrokerRecordSelection(archive, { recordIds: ["execution:orphan-equity"] }),
    /只供审计查看/,
  );
});

test("review selection closes orders and executions in both directions from encrypted history", () => {
  const archive = {
    schemaVersion: 2,
    syncedAt: "2026-08-09T00:00:00.000Z",
    capabilities: { historyOrders: true, historyExecutions: true },
    warnings: [],
    orders: [
      { orderId: "o-1", symbol: "NVDA.US", side: "Buy", status: "FilledStatus", executedQuantity: 2, submittedAt: "2026-08-01T12:00:00.000Z" },
      { orderId: "o-2", symbol: "NVDA.US", side: "Sell", status: "FilledStatus", executedQuantity: 1, submittedAt: "2026-08-02T12:00:00.000Z" },
    ],
    executions: [
      { tradeId: "t-1", orderId: "o-1", symbol: "NVDA.US", side: "Buy", quantity: 1, price: 100, currency: "USD", doneAt: "2026-08-01T12:01:00.000Z" },
      { tradeId: "t-2", orderId: "o-1", symbol: "NVDA.US", side: "Buy", quantity: 1, price: 101, currency: "USD", doneAt: "2026-08-01T12:02:00.000Z" },
      { tradeId: "t-3", orderId: "o-2", symbol: "NVDA.US", side: "Sell", quantity: 1, price: 102, currency: "USD", doneAt: "2026-08-02T12:01:00.000Z" },
    ],
    events: [],
  };

  const fromOrder = resolveReviewSelection(archive, { recordIds: ["order:o-1"] });
  assert.deepEqual(fromOrder.orderIds, ["o-1"]);
  assert.deepEqual(fromOrder.executionIds, ["t-1", "t-2"]);
  assert.deepEqual(fromOrder.recordIds, ["order:o-1", "execution:t-1", "execution:t-2"]);
  assert.deepEqual(fromOrder.requestedRecordIds, ["order:o-1"]);
  assert.equal(fromOrder.autoIncludedRecordCount, 2);

  const fromExecution = resolveReviewSelection(archive, { recordIds: ["execution:t-1"] });
  assert.deepEqual(fromExecution.orderIds, ["o-1"]);
  assert.deepEqual(fromExecution.executionIds, ["t-1", "t-2"]);
  assert.deepEqual(fromExecution.recordIds, ["order:o-1", "execution:t-1", "execution:t-2"]);
  assert.deepEqual(fromExecution.requestedRecordIds, ["execution:t-1"]);
  assert.equal(fromExecution.autoIncludedRecordCount, 2);
  assert.doesNotMatch(JSON.stringify(fromExecution), /o-2|t-3/);
});

test("default review intake excludes non-trading orders but keeps partially-filled cancellations", () => {
  const base = {
    schemaVersion: 2,
    syncedAt: "2026-08-09T00:00:00.000Z",
    capabilities: { historyOrders: true, historyExecutions: true },
    warnings: [],
    executions: [],
    events: [],
  };
  const archive = {
    ...base,
    orders: [
      { orderId: "cancelled", symbol: "NVDA.US", side: "Buy", status: "CanceledStatus", quantity: 10, executedQuantity: 0, submittedAt: "2026-08-01T12:00:00.000Z" },
      { orderId: "rejected", symbol: "NVDA.US", side: "Buy", status: "RejectedStatus", quantity: 10, submittedAt: "2026-08-01T12:01:00.000Z" },
      { orderId: "expired", symbol: "NVDA.US", side: "Buy", status: "ExpiredStatus", quantity: 10, submittedAt: "2026-08-01T12:02:00.000Z" },
      { orderId: "pending", symbol: "NVDA.US", side: "Buy", status: "PendingStatus", quantity: 10, submittedAt: "2026-08-01T12:03:00.000Z" },
      { orderId: "partial-cancel", symbol: "NVDA.US", side: "Buy", status: "CanceledStatus", quantity: 10, executedQuantity: 2, submittedAt: "2026-08-01T12:04:00.000Z" },
    ],
  };

  const intake = buildTradeHistoryIntake(archive);
  assert.deepEqual(intake.records.map((item) => item.recordId), ["order:partial-cancel"]);
  assert.equal(intake.excludedOrderAudit.totalCount, 4);
  assert.deepEqual(intake.excludedOrderAudit.byReason, {
    cancelled_unfilled: 1,
    rejected_unfilled: 1,
    expired_unfilled: 1,
    open_or_pending_unfilled: 1,
    unfilled_or_unverified: 0,
    price_unverified: 0,
  });

  const audit = buildTradeHistoryIntake(archive, { includeExcludedOrders: true });
  assert.equal(audit.records.filter((item) => item.reviewEligibility?.status === "audit_only").length, 4);
  assert.throws(
    () => resolveBrokerRecordSelection(archive, { recordIds: ["order:cancelled"] }),
    /只供审计查看/,
  );
  assert.equal(resolveBrokerRecordSelection(archive, { recordIds: ["order:partial-cancel"] }).orderIds[0], "partial-cancel");
});

test("flattened AAPL option combos never become stock orders or stock executions in default review evidence", () => {
  const archive = {
    schemaVersion: 2,
    syncedAt: "2026-08-01T00:00:00.000Z",
    capabilities: { historyOrders: true, historyExecutions: true },
    warnings: [],
    orders: [
      {
        orderId: "aapl-combo-sell",
        symbol: "AAPL.US",
        side: "Sell",
        status: "FilledStatus",
        orderType: "LO",
        quantity: 1,
        executedQuantity: 1,
        submittedPrice: 4.58,
        executedPrice: 4.92,
        currency: "USD",
        submittedAt: "2026-07-31T13:30:13.000Z",
      },
      {
        orderId: "aapl-combo-buy",
        symbol: "AAPL.US",
        side: "Buy",
        status: "FilledStatus",
        orderType: "LO",
        quantity: 1,
        executedQuantity: 1,
        submittedPrice: 1.29,
        executedPrice: 1.29,
        currency: "USD",
        submittedAt: "2026-07-30T19:50:22.000Z",
      },
    ],
    executions: [
      { tradeId: "sell-net", orderId: "aapl-combo-sell", symbol: "AAPL.US", side: "Sell", quantity: 1, price: 4.92, currency: "USD", doneAt: "2026-07-31T13:30:16.000Z" },
      { tradeId: "sell-long-leg", orderId: "aapl-combo-sell", symbol: "AAPL.US", side: "Sell", quantity: 1, price: 19.60, currency: "USD", doneAt: "2026-07-31T13:30:16.000Z" },
      { tradeId: "sell-short-leg", orderId: "aapl-combo-sell", symbol: "AAPL.US", side: "Sell", quantity: 1, price: 14.68, currency: "USD", doneAt: "2026-07-31T13:30:16.000Z" },
      { tradeId: "buy-net", orderId: "aapl-combo-buy", symbol: "AAPL.US", side: "Buy", quantity: 1, price: 1.29, currency: "USD", doneAt: "2026-07-30T19:50:22.000Z" },
      { tradeId: "buy-long-leg", orderId: "aapl-combo-buy", symbol: "AAPL.US", side: "Buy", quantity: 1, price: 1.87, currency: "USD", doneAt: "2026-07-30T19:50:22.000Z" },
      { tradeId: "buy-short-leg", orderId: "aapl-combo-buy", symbol: "AAPL.US", side: "Buy", quantity: 1, price: 3.16, currency: "USD", doneAt: "2026-07-30T19:50:22.000Z" },
    ],
    events: [],
  };

  const intake = buildTradeHistoryIntake(archive);
  assert.deepEqual(intake.records, []);
  assert.equal(intake.excludedOrderAudit.byReason.possible_multileg_missing_leg_metadata, 2);
  assert.equal(intake.excludedExecutionAudit.byReason.possible_multileg_missing_leg_metadata, 6);

  const audit = buildTradeHistoryIntake(archive, { includeExcludedOrders: true });
  assert.equal(audit.records.length, 8);
  assert.ok(audit.records.every((record) => record.reviewEligibility?.status === "audit_only"));
  assert.ok(audit.records.every((record) => (
    record.reviewEligibility?.reason === "possible_multileg_missing_leg_metadata"
  )));
  const sellNet = audit.records.find((record) => record.recordId === "execution:sell-net");
  assert.equal(sellNet.price, null);
  assert.equal(sellNet.reportedPrice, 4.92);
  assert.equal(sellNet.priceAudit.consistencyAudit.childExecutionQuantity, 3);
  assert.equal(sellNet.priceAudit.consistencyAudit.parentExecutedQuantity, 1);
  assert.equal(sellNet.priceAudit.consistencyAudit.netAndLegPricePattern, true);
});

test("ordinary split fills remain reviewable when child quantities reconcile to the parent", () => {
  const archive = {
    schemaVersion: 2,
    syncedAt: "2026-08-01T00:00:00.000Z",
    capabilities: { historyOrders: true, historyExecutions: true },
    warnings: [],
    orders: [{
      orderId: "ordinary-split-fill",
      symbol: "AAPL.US",
      side: "Buy",
      status: "FilledStatus",
      quantity: 3,
      executedQuantity: 3,
      submittedPrice: 101,
      executedPrice: 100.6667,
      currency: "USD",
      submittedAt: "2026-07-29T14:00:00.000Z",
    }],
    executions: [
      { tradeId: "ordinary-1", orderId: "ordinary-split-fill", symbol: "AAPL.US", side: "Buy", quantity: 1, price: 100, currency: "USD", doneAt: "2026-07-29T14:00:01.000Z" },
      { tradeId: "ordinary-2", orderId: "ordinary-split-fill", symbol: "AAPL.US", side: "Buy", quantity: 2, price: 101, currency: "USD", doneAt: "2026-07-29T14:00:02.000Z" },
    ],
    events: [],
  };

  const intake = buildTradeHistoryIntake(archive);
  assert.deepEqual(
    new Set(intake.records.map((record) => record.recordId)),
    new Set(["order:ordinary-split-fill", "execution:ordinary-1", "execution:ordinary-2"]),
  );
  assert.equal(intake.excludedOrderAudit.totalCount, 0);
  assert.equal(intake.excludedExecutionAudit.totalCount, 0);
});

test("explicit Longbridge multi_leg metadata is retained but excluded until multi-leg P&L is modeled", () => {
  const archive = {
    schemaVersion: 2,
    syncedAt: "2026-08-01T00:00:00.000Z",
    capabilities: { historyOrders: true, historyExecutions: true },
    warnings: [],
    orders: [{
      order_id: "explicit-combo",
      symbol: "QQQ.US",
      side: "Sell",
      status: "FilledStatus",
      quantity: "1",
      executed_quantity: "1",
      executed_price: "2.50",
      submitted_at: "2026-07-31T14:00:00.000Z",
      currency: "USD",
      multi_leg: {
        strategy: "2",
        strategy_name: "Vertical",
        multileg_id: "combo-1",
        code: "QQQ-combo",
        legs: [
          { symbol: "QQQ260731C764000.US", side: "Buy", position: "LONG", ratio_quantity: "1", strike_price: "764", expire_date: "20260731", contract_direction: "C" },
          { symbol: "QQQ260731C769000.US", side: "Sell", position: "SHORT", ratio_quantity: "1", strike_price: "769", expire_date: "20260731", contract_direction: "C" },
        ],
      },
    }],
    executions: [{ tradeId: "explicit-net", orderId: "explicit-combo", symbol: "QQQ.US", side: "Sell", quantity: 1, price: 2.5, currency: "USD", doneAt: "2026-07-31T14:00:01.000Z" }],
    events: [],
  };

  assert.deepEqual(buildTradeHistoryIntake(archive).records, []);
  const audit = buildTradeHistoryIntake(archive, { includeExcludedOrders: true });
  const order = audit.records.find((record) => record.recordId === "order:explicit-combo");
  assert.equal(order.reviewEligibility.reason, "multileg_order_unmodeled");
  assert.equal(order.multiLeg.strategyName, "Vertical");
  assert.deepEqual(order.multiLeg.legs.map((leg) => leg.symbol), [
    "QQQ260731C764000.US",
    "QQQ260731C769000.US",
  ]);
});

test("public order price distinguishes a submitted limit from an executed price", () => {
  const intake = buildTradeHistoryIntake({
    schemaVersion: 2,
    syncedAt: "2026-08-01T00:00:00.000Z",
    capabilities: { historyOrders: true },
    warnings: [],
    orders: [{
      orderId: "filled-without-execution-price",
      symbol: "NVDA.US",
      side: "Buy",
      status: "FilledStatus",
      quantity: 1,
      executedQuantity: 1,
      submittedPrice: 180,
      executedPrice: null,
      submittedAt: "2026-07-31T14:00:00.000Z",
    }],
    executions: [],
    events: [],
  });
  assert.equal(intake.records[0].price, null);
  assert.equal(intake.records[0].priceBasis, "submitted_only");
  assert.equal(intake.records[0].submittedPrice, 180);
});

test("sync adds unadjusted daily-range provenance to an internally inconsistent equity package", async () => {
  const longbridge = {
    connected: true,
    supports: (name) => ["history_orders", "history_executions", "candlesticks"].includes(name),
    async call(name) {
      if (name === "history_orders") return { orders: [{
        order_id: "aapl-combo-sell",
        symbol: "AAPL.US",
        side: "Sell",
        status: "FilledStatus",
        quantity: "1",
        executed_quantity: "1",
        price: "4.58",
        executed_price: "4.92",
        submitted_at: "2026-07-31T13:30:13.000Z",
        currency: "USD",
      }] };
      if (name === "history_executions") return { trades: [
        { trade_id: "sell-net", order_id: "aapl-combo-sell", symbol: "AAPL.US", quantity: "1", price: "4.92", trade_done_at: "2026-07-31T13:30:16.000Z" },
        { trade_id: "sell-long-leg", order_id: "aapl-combo-sell", symbol: "AAPL.US", quantity: "1", price: "19.60", trade_done_at: "2026-07-31T13:30:16.000Z" },
        { trade_id: "sell-short-leg", order_id: "aapl-combo-sell", symbol: "AAPL.US", quantity: "1", price: "14.68", trade_done_at: "2026-07-31T13:30:16.000Z" },
      ] };
      if (name === "candlesticks") return { candlesticks: [{
        timestamp: "2026-07-31T04:00:00.000Z",
        trade_date: "2026-07-31",
        symbol: "AAPL.US",
        open: "304.536",
        high: "310.41",
        low: "299.73",
        close: "308.632",
        volume: "132489137",
      }] };
      throw new Error(`unexpected ${name}`);
    },
  };
  const service = new TradeHistoryService({ longbridge, store: new MemoryStore() });
  const archive = await service.sync({
    startAt: "2026-07-30T00:00:00.000Z",
    endAt: "2026-08-02T00:00:00.000Z",
  });

  assert.ok(archive.executions.every((execution) => execution.price == null));
  assert.ok(archive.executions.every((execution) => (
    execution.priceAudit.marketReference.status === "available"
      && execution.priceAudit.marketReference.adjustment === "none"
      && execution.priceAudit.marketReference.reportedPriceInsideRange === false
  )));
});

test("sync excludes a robust local equity price outlier only after an unadjusted daily range disproves it", async () => {
  const candleCalls = [];
  const longbridge = priceAuditLongbridge({
    candidatePrice: "4.92",
    candleRows: [{
      timestamp: "2026-07-31T04:00:00.000Z",
      trade_date: "2026-07-31",
      symbol: "AAPL.US",
      open: "202",
      high: "205",
      low: "199",
      close: "203",
      volume: "1000000",
    }],
    candleCalls,
  });
  const service = new TradeHistoryService({ longbridge, store: new MemoryStore() });
  const archive = await service.sync({
    startAt: "2026-07-01T00:00:00.000Z",
    endAt: "2026-08-02T00:00:00.000Z",
  });

  const execution = archive.executions.find((item) => item.tradeId === "candidate-fill");
  assert.equal(execution.reportedPrice, 4.92);
  assert.equal(execution.price, null);
  assert.equal(execution.priceAudit.status, "excluded");
  assert.equal(execution.priceAudit.reason, "execution_price_outside_unadjusted_daily_range");
  assert.equal(execution.priceAudit.marketReference.reportedPriceInsideRange, false);
  assert.equal(buildTradeHistoryIntake(archive).records.some(
    (item) => item.recordId === "execution:candidate-fill",
  ), false);
  assert.equal(candleCalls.length, 1);
  assert.equal(candleCalls[0].forward_adjust, false);
});

test("sync retains an outlier candidate when its unadjusted trade-date candle verifies the price", async () => {
  const candleCalls = [];
  const service = new TradeHistoryService({
    longbridge: priceAuditLongbridge({
      // This resembles a four-for-one split relative to nearby fills. The
      // exact unadjusted trade-date candle is authoritative and keeps it.
      candidatePrice: "50",
      candleRows: [{
        timestamp: "2026-07-31T04:00:00.000Z",
        trade_date: "2026-07-31",
        symbol: "AAPL.US",
        open: "49",
        high: "52",
        low: "48",
        close: "51",
        volume: "1000000",
      }],
      candleCalls,
    }),
    store: new MemoryStore(),
  });
  const archive = await service.sync({
    startAt: "2026-07-01T00:00:00.000Z",
    endAt: "2026-08-02T00:00:00.000Z",
  });

  const execution = archive.executions.find((item) => item.tradeId === "candidate-fill");
  assert.equal(execution.price, 50);
  assert.equal(execution.priceAudit.status, "accepted");
  assert.equal(execution.priceAudit.reason, null);
  assert.equal(execution.priceAudit.marketReference.reportedPriceInsideRange, true);
  assert.equal(candleCalls.length, 1);
});

test("sync fails closed for a strong local equity price outlier when its trade-date candle is unavailable", async () => {
  const candleCalls = [];
  const service = new TradeHistoryService({
    longbridge: priceAuditLongbridge({
      candidatePrice: "4.92",
      candleRows: [],
      candleCalls,
    }),
    store: new MemoryStore(),
  });
  const archive = await service.sync({
    startAt: "2026-07-01T00:00:00.000Z",
    endAt: "2026-08-02T00:00:00.000Z",
  });

  const execution = archive.executions.find((item) => item.tradeId === "candidate-fill");
  assert.equal(execution.price, null);
  assert.equal(execution.priceAudit.status, "excluded");
  assert.equal(execution.priceAudit.reason, "execution_price_unverified_strong_local_outlier");
  assert.equal(execution.priceAudit.marketReference.status, "unavailable");
  const intake = buildTradeHistoryIntake(archive);
  assert.equal(intake.records.some((item) => item.recordId === "execution:candidate-fill"), false);
  const audit = buildTradeHistoryIntake(archive, { includeExcludedOrders: true });
  assert.equal(
    audit.records.find((item) => item.recordId === "execution:candidate-fill")
      .reviewEligibility.reason,
    "price_unverified",
  );
  assert.equal(candleCalls.length, 1);
});

test("parent-only filled equity order is audit-only when its executed price contradicts the unadjusted trade-date candle", async () => {
  const candleCalls = [];
  const service = new TradeHistoryService({
    longbridge: parentOnlyPriceAuditLongbridge({
      candidatePrice: "4.92",
      candleRows: [{
        timestamp: "2026-07-31T04:00:00.000Z",
        trade_date: "2026-07-31",
        symbol: "AAPL.US",
        open: "202",
        high: "205",
        low: "199",
        close: "203",
        volume: "1000000",
      }],
      candleCalls,
    }),
    store: new MemoryStore(),
  });
  const archive = await service.sync({
    startAt: "2026-07-01T00:00:00.000Z",
    endAt: "2026-08-02T00:00:00.000Z",
  });

  const order = archive.orders.find((item) => item.orderId === "candidate-parent-only");
  assert.equal(order.executedPrice, null);
  assert.equal(order.reportedExecutedPrice, 4.92);
  assert.equal(order.priceAudit.status, "excluded");
  assert.equal(order.priceAudit.reason, "parent_order_price_outside_unadjusted_daily_range");
  assert.equal(order.priceAudit.marketReference.adjustment, "none");
  assert.equal(order.priceAudit.marketReference.reportedPriceInsideRange, false);
  assert.equal(order.brokerEvidenceAudit.reason, "price_unverified");
  assert.equal(buildTradeHistoryIntake(archive).records.some(
    (item) => item.recordId === "order:candidate-parent-only",
  ), false);
  const audit = buildTradeHistoryIntake(archive, { includeExcludedOrders: true });
  assert.equal(
    audit.records.find((item) => item.recordId === "order:candidate-parent-only")
      .reviewEligibility.reason,
    "price_unverified",
  );
  assert.throws(
    () => resolveBrokerRecordSelection(archive, {
      recordIds: ["order:candidate-parent-only"],
    }),
    /只供审计查看/,
  );
  assert.equal(candleCalls[0].forward_adjust, false);
});

test("strong parent-only price outlier is audit-only when exact candle evidence is unavailable", async () => {
  const service = new TradeHistoryService({
    longbridge: parentOnlyPriceAuditLongbridge({
      candidatePrice: "4.92",
      candleRows: [],
    }),
    store: new MemoryStore(),
  });
  const archive = await service.sync({
    startAt: "2026-07-01T00:00:00.000Z",
    endAt: "2026-08-02T00:00:00.000Z",
  });

  const order = archive.orders.find((item) => item.orderId === "candidate-parent-only");
  assert.equal(order.executedPrice, null);
  assert.equal(order.priceAudit.status, "excluded");
  assert.equal(order.priceAudit.reason, "parent_order_price_unverified_strong_local_outlier");
  assert.equal(buildTradeHistoryIntake(archive).records.some(
    (item) => item.recordId === "order:candidate-parent-only",
  ), false);
});

test("ordinary parent-only filled order remains reviewable when no strong anomaly is present", async () => {
  const service = new TradeHistoryService({
    longbridge: parentOnlyPriceAuditLongbridge({
      candidatePrice: "201",
      candleRows: [],
    }),
    store: new MemoryStore(),
  });
  const archive = await service.sync({
    startAt: "2026-07-01T00:00:00.000Z",
    endAt: "2026-08-02T00:00:00.000Z",
  });

  const order = archive.orders.find((item) => item.orderId === "candidate-parent-only");
  assert.equal(order.executedPrice, 201);
  assert.equal(order.priceAudit.status, "unavailable");
  assert.equal(order.priceAudit.reason, "parent_order_trade_date_candle_unavailable");
  assert.equal(buildTradeHistoryIntake(archive).records.some(
    (item) => item.recordId === "order:candidate-parent-only",
  ), true);
});

test("review-cycle record selection supports a closed multi-symbol portfolio package without inventing an event", () => {
  const archive = {
    schemaVersion: 2,
    syncedAt: "2026-08-31T23:59:00.000Z",
    capabilities: { historyOrders: true, historyExecutions: true },
    warnings: [],
    orders: [
      { orderId: "o-aapl", symbol: "AAPL.US", side: "Buy", status: "FilledStatus", executedQuantity: 1, submittedAt: "2026-08-04T14:00:00.000Z" },
      { orderId: "o-nvda", symbol: "NVDA.US", side: "Sell", status: "FilledStatus", executedQuantity: 1, submittedAt: "2026-08-19T14:00:00.000Z" },
    ],
    executions: [
      { tradeId: "t-aapl", orderId: "o-aapl", symbol: "AAPL.US", side: "Buy", quantity: 1, price: 200, currency: "USD", doneAt: "2026-08-04T14:01:00.000Z" },
      { tradeId: "t-nvda", orderId: "o-nvda", symbol: "NVDA.US", side: "Sell", quantity: 1, price: 210, currency: "USD", doneAt: "2026-08-19T14:02:00.000Z" },
    ],
    events: [],
  };

  const selection = resolveBrokerRecordSelection(archive, {
    recordIds: ["order:o-aapl", "execution:t-nvda"],
  });
  assert.deepEqual(selection.relatedSymbols, ["AAPL.US", "NVDA.US"]);
  assert.deepEqual(selection.orderIds, ["o-aapl", "o-nvda"]);
  assert.deepEqual(selection.executionIds, ["t-aapl", "t-nvda"]);
  assert.deepEqual(selection.requestedRecordIds, ["order:o-aapl", "execution:t-nvda"]);
  assert.equal(selection.autoIncludedRecordCount, 2);
  assert.equal(selection.activityStartAt, "2026-08-04T14:00:00.000Z");
  assert.equal(selection.activityEndAt, "2026-08-19T14:02:00.000Z");
  assert.equal("event" in selection, false);
});

test("finance calendar lookup is narrow, filters the selected symbol, and keeps explicit fiscal metadata", async () => {
  const store = new MemoryStore();
  store.values.set("brokerTradeHistoryV1", {
    schemaVersion: 2,
    source: "Longbridge MCP · read only",
    syncedAt: "2026-08-09T00:00:00.000Z",
    range: { startAt: "2026-07-01T00:00:00.000Z", endAt: "2026-08-09T00:00:00.000Z" },
    capabilities: { historyOrders: true, financeCalendar: true },
    warnings: [],
    orders: [{
      orderId: "o-earnings",
      symbol: "NVDA.US",
      side: "Buy",
      quantity: 1,
      status: "FilledStatus",
      executedQuantity: 1,
      submittedAt: "2026-08-10T14:00:00.000Z",
    }],
    executions: [],
    events: [{
      eventId: "stale-scheduled-date",
      symbol: "NVDA.US",
      eventAt: "2026-08-19T00:00:00.000Z",
      fiscalQuarter: "FY2026 Q2",
    }],
  });
  const calls = [];
  const longbridge = {
    connected: true,
    supports: (name) => name === "finance_calendar",
    async call(name, args) {
      assert.equal(name, "finance_calendar");
      calls.push(args);
      return { list: [{
        date: "2026-08-20",
        infos: [
          {
            symbol: "NVDA.US",
            datetime: "2026-08-20T00:00:00.000Z",
            ext: { financial_report: {
              fiscal_year: 2026,
              period: "2",
              period_type: "qf",
              market_time: "after",
            } },
          },
          { symbol: "OTHER.US", datetime: "2026-08-20T20:00:00.000Z" },
        ],
      }] };
    },
  };
  const service = new TradeHistoryService({ longbridge, store });
  const lookup = await service.lookupEventCandidates({ recordIds: ["order:o-earnings"] });

  assert.ok(calls.length > 0);
  assert.ok(calls.every((item) => item.market === "US"));
  assert.ok(calls.every((item) =>
    (Date.parse(item.end) - Date.parse(item.start)) / (24 * 60 * 60 * 1000) <= 31));
  assert.equal(lookup.eventCandidates.length, 1);
  assert.equal(lookup.eventCandidates[0].fiscalQuarter, "FY2026 Q2");
  assert.equal(lookup.eventCandidates[0].eventSession, "amc");
  assert.equal(lookup.eventCandidates[0].eventTimePrecision, "session");
  assert.deepEqual((await service.cached()).events.map((item) => item.eventId), [
    lookup.eventCandidates[0].eventCandidateId,
  ]);
});

test("recent earnings preload returns only the latest three events and reuses its 12-hour symbol cache", async () => {
  const store = new MemoryStore();
  const nowMs = Date.now();
  const eventDates = [20, 95, 175, 260].map((daysAgo, index) => ({
    datetime: new Date(nowMs - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    symbol: "AAOI.US",
    ext: { financial_report: {
      fiscal_year: 2026,
      period: String(Math.max(1, 4 - index)),
      period_type: "qf",
      market_time: "after",
    } },
  }));
  let active = 0;
  let peak = 0;
  const calls = [];
  const longbridge = {
    connected: true,
    supports: (name) => name === "finance_calendar",
    async call(name, args) {
      assert.equal(name, "finance_calendar");
      calls.push(args);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      const startMs = Date.parse(args.start);
      const endMs = Date.parse(args.end) + 24 * 60 * 60 * 1000 - 1;
      const infos = eventDates.filter((item) => {
        const eventMs = Date.parse(item.datetime);
        return eventMs >= startMs && eventMs <= endMs;
      });
      return infos.length ? { list: [{ date: args.start, infos }] } : { list: [] };
    },
  };
  const service = new TradeHistoryService({ longbridge, store });
  const first = await service.preloadRecentEventCandidates({
    symbols: ["AAOI.US"],
    asOf: new Date(nowMs).toISOString(),
  });

  assert.equal(first.eventCandidates.length, 3);
  assert.deepEqual(
    first.eventCandidates.map((item) => item.eventAt),
    eventDates.slice(0, 3).map((item) => item.datetime),
  );
  assert.equal(first.lookbackDays, 240);
  assert.equal(first.eventLimitPerSymbol, 3);
  assert.equal(calls.length, 10);
  assert.equal(peak, 4);

  const callsAfterFirstLoad = calls.length;
  const second = await service.preloadRecentEventCandidates({
    symbols: ["AAOI.US"],
    asOf: new Date(nowMs).toISOString(),
  });
  assert.equal(second.status, "cached");
  assert.equal(second.eventCandidates.length, 3);
  assert.equal(calls.length, callsAfterFirstLoad);
});

test("cross-symbol protection records require an explicit event and take the event symbol as primary", () => {
  const archive = {
    schemaVersion: 2,
    syncedAt: "2026-08-09T00:00:00.000Z",
    capabilities: { financeCalendar: true },
    warnings: [],
    orders: [
      { orderId: "nvda", symbol: "NVDA.US", side: "Buy", status: "FilledStatus", executedQuantity: 1, submittedAt: "2026-08-10T14:00:00.000Z" },
      { orderId: "hedge", symbol: "QQQ.US", side: "Buy", status: "FilledStatus", executedQuantity: 1, submittedAt: "2026-08-10T14:05:00.000Z" },
    ],
    executions: [],
    events: [{
      eventId: "nvda-event",
      symbol: "NVDA.US",
      eventAt: "2026-08-20T20:00:00.000Z",
      fiscalQuarter: "FY2026 Q2",
    }],
  };
  const recordIds = ["order:nvda", "order:hedge"];
  assert.throws(
    () => resolveReviewSelection(archive, { recordIds }),
    /需要先确认财报事件/,
  );
  const selection = resolveReviewSelection(archive, {
    recordIds,
    eventCandidateId: "nvda-event",
  });
  assert.equal(selection.symbol, "NVDA.US");
  assert.deepEqual(selection.relatedSymbols, ["NVDA.US", "QQQ.US"]);
});

test("every selected record must fall inside the same earnings-event window", () => {
  const archive = {
    schemaVersion: 2,
    source: "Longbridge MCP · read only",
    syncedAt: "2026-08-10T00:00:00.000Z",
    capabilities: { historyOrders: true, financeCalendar: true },
    warnings: [],
    orders: [
      { orderId: "near", symbol: "NVDA.US", side: "Buy", status: "FilledStatus", executedQuantity: 1, submittedAt: "2026-08-20T12:00:00.000Z" },
      { orderId: "prior-quarter", symbol: "NVDA.US", side: "Buy", status: "FilledStatus", executedQuantity: 1, submittedAt: "2026-05-20T12:00:00.000Z" },
    ],
    executions: [],
    events: [{
      eventId: "q2-event",
      symbol: "NVDA.US",
      eventAt: "2026-08-26T20:00:00.000Z",
      eventDate: "2026-08-26",
      eventTimePrecision: "exact",
      eventSession: "amc",
      fiscalQuarter: "FY2027 Q2",
    }],
  };

  assert.throws(() => resolveReviewSelection(archive, {
    recordIds: ["order:near", "order:prior-quarter"],
    eventCandidateId: "q2-event",
  }), /财报事件.*不匹配/);
});

test("event matching uses symbol and the configured earnings window", () => {
  const archive = {
    executions: [
      { tradeId: "before", symbol: "NVDA.US", side: "Buy", quantity: 1, price: 100, currency: "USD", doneAt: "2026-08-01T12:00:00.000Z" },
      { tradeId: "inside", symbol: "NVDA.US", side: "Buy", quantity: 1, price: 101, currency: "USD", doneAt: "2026-08-08T12:00:00.000Z" },
      { tradeId: "other", symbol: "AAPL.US", side: "Buy", quantity: 1, price: 200, currency: "USD", doneAt: "2026-08-08T12:00:00.000Z" },
    ],
  };
  assert.deepEqual(
    matchExecutionsToEvent(archive, {
      symbol: "nvda.us",
      eventAt: "2026-08-09T00:00:00.000Z",
      daysBefore: 2,
      daysAfter: 2,
    }).map((item) => item.tradeId),
    ["inside"],
  );
});

test("event matching excludes unfilled historical orders without executions", () => {
  const archive = {
    orders: [
      { orderId: "open-1", symbol: "MU.US", submittedAt: "2026-07-15T14:00:00.000Z" },
      { orderId: "old-1", symbol: "MU.US", submittedAt: "2026-05-01T14:00:00.000Z" },
    ],
  };
  assert.deepEqual(
    matchOrdersToEvent(archive, {
      symbol: "MU.US",
      eventAt: "2026-07-20T20:00:00.000Z",
    }).map((item) => item.orderId),
    [],
  );
});
