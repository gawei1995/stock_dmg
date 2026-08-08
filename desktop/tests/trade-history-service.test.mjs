import assert from "node:assert/strict";
import test from "node:test";
import {
  matchExecutionsToEvent,
  matchOrdersToEvent,
  TradeHistoryService,
} from "../src/data/trade-history-service.mjs";

class MemoryStore {
  constructor() { this.values = new Map(); }
  async get(key) { return structuredClone(this.values.get(key)); }
  async set(key, value) { this.values.set(key, structuredClone(value)); }
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

test("event matching uses symbol and the configured earnings window", () => {
  const archive = {
    executions: [
      { tradeId: "before", symbol: "NVDA.US", doneAt: "2026-08-01T12:00:00.000Z" },
      { tradeId: "inside", symbol: "NVDA.US", doneAt: "2026-08-08T12:00:00.000Z" },
      { tradeId: "other", symbol: "AAPL.US", doneAt: "2026-08-08T12:00:00.000Z" },
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

test("event matching keeps unfilled historical orders even without executions", () => {
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
    ["open-1"],
  );
});
