import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTradeHistoryIntake,
  matchExecutionsToEvent,
  matchOrdersToEvent,
  resolveReviewSelection,
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
  const longbridge = {
    connected: true,
    supports: (name) => ["history_orders", "history_executions"].includes(name),
    async call() { throw new Error("MCP 463 gateway unavailable"); },
  };
  const service = new TradeHistoryService({ longbridge, store: repository });

  await assert.rejects(service.sync({
    startAt: "2026-07-01T00:00:00.000Z",
    endAt: "2026-08-01T00:00:00.000Z",
  }), /查询全部失败/);
  const cached = await service.cached();
  assert.equal(cached.syncedAt, "2026-07-01T00:00:00.000Z");
  assert.equal(cached.range.endAt, "2026-07-01T00:00:00.000Z");
  assert.deepEqual(cached.orders.map((item) => item.orderId), ["old-order"]);
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

test("review selection closes orders and executions in both directions from encrypted history", () => {
  const archive = {
    schemaVersion: 2,
    syncedAt: "2026-08-09T00:00:00.000Z",
    capabilities: { historyOrders: true, historyExecutions: true },
    warnings: [],
    orders: [
      { orderId: "o-1", symbol: "NVDA.US", side: "Buy", submittedAt: "2026-08-01T12:00:00.000Z" },
      { orderId: "o-2", symbol: "NVDA.US", side: "Sell", submittedAt: "2026-08-02T12:00:00.000Z" },
    ],
    executions: [
      { tradeId: "t-1", orderId: "o-1", symbol: "NVDA.US", doneAt: "2026-08-01T12:01:00.000Z" },
      { tradeId: "t-2", orderId: "o-1", symbol: "NVDA.US", doneAt: "2026-08-01T12:02:00.000Z" },
      { tradeId: "t-3", orderId: "o-2", symbol: "NVDA.US", doneAt: "2026-08-02T12:01:00.000Z" },
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

test("cross-symbol protection records require an explicit event and take the event symbol as primary", () => {
  const archive = {
    schemaVersion: 2,
    syncedAt: "2026-08-09T00:00:00.000Z",
    capabilities: { financeCalendar: true },
    warnings: [],
    orders: [
      { orderId: "nvda", symbol: "NVDA.US", side: "Buy", submittedAt: "2026-08-10T14:00:00.000Z" },
      { orderId: "hedge", symbol: "QQQ.US", side: "Buy", submittedAt: "2026-08-10T14:05:00.000Z" },
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
      { orderId: "near", symbol: "NVDA.US", submittedAt: "2026-08-20T12:00:00.000Z" },
      { orderId: "prior-quarter", symbol: "NVDA.US", submittedAt: "2026-05-20T12:00:00.000Z" },
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
