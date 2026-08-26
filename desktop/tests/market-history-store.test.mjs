import assert from "node:assert/strict";
import test from "node:test";
import {
  MarketHistoryStore,
  marketHistorySeriesKey,
} from "../src/data/market-history-store.mjs";

const endpoint = "https://mcp.longbridge.com/v2";

test("market history persists and merges normalized daily bars by evidence contract", async () => {
  const values = new Map();
  const store = memoryStore(values);
  let clock = 0;
  const history = new MarketHistoryStore({
    store,
    endpoint,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, clock++)).toISOString(),
  });
  await history.putSeries({
    symbol: "AAPL.US",
    candles: [bar("2026-01-02", 100), bar("2026-01-05", 101)],
    fetchedAt: "2026-01-05T22:00:00.000Z",
  });
  await history.putSeries({
    symbol: "AAPL.US",
    candles: [
      { ...bar("2026-01-05", 102), timestamp: "2026-01-05T06:00:00.000Z" },
      bar("2026-01-06", 103),
    ],
    fetchedAt: "2026-01-06T22:00:00.000Z",
  });

  const restored = await new MarketHistoryStore({ store, endpoint }).getSeries({
    symbol: "aapl.us",
    count: 2,
  });
  assert.equal(restored.candleCount, 3);
  assert.deepEqual(restored.candles.map((item) => item.tradeDate), ["2026-01-05", "2026-01-06"]);
  assert.equal(restored.candles[0].close, 102);
  assert.equal(restored.fetchedAt, "2026-01-06T22:00:00.000Z");
});

test("an older concurrent response can add missing dates but cannot replace newer daily bars", async () => {
  const values = new Map();
  const history = new MarketHistoryStore({ store: memoryStore(values), endpoint });
  const newer = await history.putSeries({
    symbol: "AAPL.US",
    candles: [bar("2026-01-05", 150), bar("2026-01-06", 160)],
    fetchedAt: "2026-01-06T22:00:00.000Z",
  });
  const older = await history.putSeries({
    symbol: "AAPL.US",
    candles: [
      bar("2026-01-02", 120),
      { ...bar("2026-01-05", 90), timestamp: "2026-01-05T07:00:00.000Z" },
    ],
    fetchedAt: "2026-01-05T22:00:00.000Z",
  });

  assert.equal(newer.fetchedAt, "2026-01-06T22:00:00.000Z");
  assert.equal(older.fetchedAt, "2026-01-06T22:00:00.000Z");
  assert.deepEqual(older.candles.map((item) => item.tradeDate), [
    "2026-01-02",
    "2026-01-05",
    "2026-01-06",
  ]);
  assert.equal(older.candles.find((item) => item.tradeDate === "2026-01-05").close, 150);
});

test("market history keeps endpoints, adjustments and sessions isolated", async () => {
  const values = new Map();
  const store = memoryStore(values);
  const history = new MarketHistoryStore({ store, endpoint });
  await history.putSeries({ symbol: "QQQ.US", candles: [bar("2026-01-02", 500)] });
  await history.putSeries({
    symbol: "QQQ.US",
    adjustment: "none",
    candles: [bar("2026-01-02", 480)],
  });

  assert.notEqual(
    marketHistorySeriesKey({ endpoint, symbol: "QQQ.US", adjustment: "forward" }),
    marketHistorySeriesKey({ endpoint, symbol: "QQQ.US", adjustment: "none" }),
  );
  assert.equal((await history.getSeries({ symbol: "QQQ.US" })).candles[0].close, 500);
  assert.equal((await history.getSeries({ symbol: "QQQ.US", adjustment: "none" })).candles[0].close, 480);
  assert.equal(await history.getSeries({
    endpoint: "https://mcp.longbridgeapp.com/v2",
    symbol: "QQQ.US",
  }), null);
});

test("market history is bounded by bars and least recently stored series", async () => {
  const values = new Map();
  const store = memoryStore(values);
  let tick = 0;
  const history = new MarketHistoryStore({
    store,
    endpoint,
    maxBars: 2,
    maxSeries: 2,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
  });
  await history.putSeries({
    symbol: "A.US",
    candles: [bar("2026-01-02", 1), bar("2026-01-05", 2), bar("2026-01-06", 3)],
  });
  await history.putSeries({ symbol: "B.US", candles: [bar("2026-01-02", 4)] });
  await history.putSeries({ symbol: "C.US", candles: [bar("2026-01-02", 5)] });

  assert.equal(await history.getSeries({ symbol: "A.US" }), null);
  assert.equal((await history.getSeries({ symbol: "B.US" })).candles.length, 1);
  assert.equal((await history.getSeries({ symbol: "C.US" })).candles.length, 1);
});

test("market history rejects null OHLC instead of persisting a false zero bar", async () => {
  const values = new Map();
  const history = new MarketHistoryStore({ store: memoryStore(values), endpoint });
  const invalid = { ...bar("2026-01-02", 100), close: null };
  assert.equal(await history.putSeries({ symbol: "AAPL.US", candles: [invalid] }), null);
  assert.equal(await history.getSeries({ symbol: "AAPL.US" }), null);
});

test("market history rejects empty OHLC instead of coercing it to zero", async () => {
  const values = new Map();
  const history = new MarketHistoryStore({ store: memoryStore(values), endpoint });
  const invalid = { ...bar("2026-01-02", 100), open: "" };
  assert.equal(await history.putSeries({ symbol: "AAPL.US", candles: [invalid] }), null);
  assert.equal(await history.getSeries({ symbol: "AAPL.US" }), null);
});

test("market history rejects missing volume instead of fabricating zero-volume evidence", async () => {
  const values = new Map();
  const history = new MarketHistoryStore({ store: memoryStore(values), endpoint });
  const invalid = { ...bar("2026-01-02", 100), volume: null };
  assert.equal(await history.putSeries({ symbol: "AAPL.US", candles: [invalid] }), null);
  assert.equal(await history.getSeries({ symbol: "AAPL.US" }), null);
});

function memoryStore(values) {
  return {
    async get(key) {
      return values.has(key) ? structuredClone(values.get(key)) : null;
    },
    async set(key, value) {
      values.set(key, structuredClone(value));
    },
  };
}

function bar(tradeDate, close) {
  return {
    timestamp: `${tradeDate}T05:00:00.000Z`,
    tradeDate,
    timestampBasis: "exchange_trade_date_midnight",
    symbol: "AAPL.US",
    market: "US",
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 1000,
    tradeSession: "Intraday",
  };
}
