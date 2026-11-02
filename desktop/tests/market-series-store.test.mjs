import assert from "node:assert/strict";
import test from "node:test";
import {
  MarketSeriesStore,
  marketSeriesKey,
} from "../src/data/market-series-store.mjs";

const endpoint = "https://mcp.longbridge.com/v2";

test("intraday series retains multiple bars from one trading date", async () => {
  const values = new Map();
  const store = new MarketSeriesStore({ store: memoryStore(values), endpoint });
  await store.putSeries({
    symbol: "AAPL.US",
    period: "1h",
    bars: [
      bar("2026-08-28T14:30:00.000Z", 100),
      bar("2026-08-28T15:30:00.000Z", 101),
      bar("2026-08-28T16:30:00.000Z", 102),
    ],
    fetchedAt: "2026-08-28T21:05:00.000Z",
  });

  const result = await store.getSeries({ symbol: "AAPL.US", period: "1h" });
  assert.equal(result.barCount, 3);
  assert.deepEqual(result.bars.map((item) => item.close), [100, 101, 102]);
  assert.equal(new Set(result.bars.map((item) => item.identity)).size, 3);
});

test("daily, weekly and hourly evidence contracts are isolated", async () => {
  const values = new Map();
  const store = new MarketSeriesStore({ store: memoryStore(values), endpoint });
  await store.putSeries({ symbol: "QQQ.US", period: "day", bars: [bar("2026-08-28T20:00:00Z", 500)] });
  await store.putSeries({ symbol: "QQQ.US", period: "week", bars: [bar("2026-08-28T20:00:00Z", 480)] });
  await store.putSeries({ symbol: "QQQ.US", period: "1h", bars: [bar("2026-08-28T20:00:00Z", 490)] });

  assert.notEqual(
    marketSeriesKey({ endpoint, symbol: "QQQ.US", period: "day" }),
    marketSeriesKey({ endpoint, symbol: "QQQ.US", period: "1h" }),
  );
  assert.equal((await store.getSeries({ symbol: "QQQ.US", period: "day" })).bars[0].close, 500);
  assert.equal((await store.getSeries({ symbol: "QQQ.US", period: "week" })).bars[0].close, 480);
  assert.equal((await store.getSeries({ symbol: "QQQ.US", period: "1h" })).bars[0].close, 490);
});

test("an older response may add history but cannot replace newer overlapping bars", async () => {
  const values = new Map();
  const store = new MarketSeriesStore({ store: memoryStore(values), endpoint });
  await store.putSeries({
    symbol: "NVDA.US",
    period: "1h",
    bars: [bar("2026-08-28T15:30:00Z", 150), bar("2026-08-28T16:30:00Z", 160)],
    fetchedAt: "2026-08-28T21:00:00Z",
  });
  const result = await store.putSeries({
    symbol: "NVDA.US",
    period: "1h",
    bars: [bar("2026-08-28T14:30:00Z", 140), bar("2026-08-28T15:30:00Z", 90)],
    fetchedAt: "2026-08-28T20:00:00Z",
  });

  assert.deepEqual(result.bars.map((item) => item.close), [140, 150, 160]);
  assert.equal(result.fetchedAt, "2026-08-28T21:00:00.000Z");
});

test("invalid OHLC rows never become zero-valued evidence", async () => {
  const values = new Map();
  const store = new MarketSeriesStore({ store: memoryStore(values), endpoint });
  const invalid = { ...bar("2026-08-28T14:30:00Z", 100), close: null };
  assert.equal(await store.putSeries({ symbol: "AAPL.US", period: "1h", bars: [invalid] }), null);
  assert.equal(await store.getSeries({ symbol: "AAPL.US", period: "1h" }), null);
});

test("series and bar retention remain bounded", async () => {
  const values = new Map();
  let tick = 0;
  const store = new MarketSeriesStore({
    store: memoryStore(values),
    endpoint,
    maxSeries: 2,
    maxBars: 2,
    now: () => new Date(Date.UTC(2026, 7, 28, 21, 0, tick++)).toISOString(),
  });
  await store.putSeries({
    symbol: "A.US",
    period: "1h",
    bars: [
      bar("2026-08-28T14:30:00Z", 1),
      bar("2026-08-28T15:30:00Z", 2),
      bar("2026-08-28T16:30:00Z", 3),
    ],
  });
  await store.putSeries({ symbol: "B.US", period: "day", bars: [bar("2026-08-28T20:00:00Z", 4)] });
  await store.putSeries({ symbol: "C.US", period: "week", bars: [bar("2026-08-28T20:00:00Z", 5)] });

  assert.equal(await store.getSeries({ symbol: "A.US", period: "1h" }), null);
  assert.equal((await store.getSeries({ symbol: "B.US", period: "day" })).barCount, 1);
  assert.equal((await store.getSeries({ symbol: "C.US", period: "week" })).barCount, 1);
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

function bar(timestamp, close) {
  return {
    timestamp: new Date(timestamp).toISOString(),
    tradeDate: "2026-08-28",
    symbol: "AAPL.US",
    market: "US",
    open: close,
    high: close + 1,
    low: Math.max(0.01, close - 1),
    close,
    volume: 1_000,
    tradeSession: "Intraday",
  };
}
