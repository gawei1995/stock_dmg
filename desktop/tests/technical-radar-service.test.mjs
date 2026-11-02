import assert from "node:assert/strict";
import test from "node:test";

import {
  TECHNICAL_RADAR_SERVICE_CANDLE_COUNT,
  TECHNICAL_RADAR_SERVICE_CONCURRENCY,
  TechnicalRadarService,
  buildRadarUniverse,
} from "../src/data/technical-radar-service.mjs";
import { TechnicalRadarStore } from "../src/data/technical-radar-store.mjs";
import { TechnicalWatchlistStore } from "../src/data/technical-watchlist-store.mjs";
import { classifyLastDailyBar } from "../src/engine/technical.mjs";
import { buildTierATechnicalBatchScan } from "../src/engine/tier-a-technical-scan.mjs";

const ACCOUNT_SCOPE = "lb-account:technical-radar-test";
const FIXED_CLOCK = "2026-08-31T21:05:00.000Z";
const WATCHLIST_TIME = "2026-08-30T12:00:00.000Z";
const PERSISTED_CARD_FIELDS = [
  "symbol",
  "memberships",
  "status",
  "cutoff",
  "inputHash",
  "lastClose",
  "ema",
  "structure",
  "metrics",
  "weekly",
  "costProfile14d28d",
  "benchmark",
  "sector",
  "marketEvidence",
  "degradedReasons",
  "observableState",
  "comparison",
].sort();

test("integrates holdings, watchlist, completed candles, compact ledger persistence, and snapshot", async () => {
  const fixture = await serviceFixture({
    watchlist: ["NVDA.US", "QQQ.US", "AAPL.US"],
    positions: [
      { symbol: "AAPL.US", quantity: 10, instrumentType: "equity" },
      { symbol: "MSFT260918C400000.US", quantity: 2 },
      { symbol: "ZERO.US", quantity: 0, instrumentType: "equity" },
    ],
  });

  const result = await fixture.service.run({ portfolio: fixture.portfolio });

  assert.deepEqual(result.universe.selectedSymbols, ["AAPL.US", "NVDA.US", "QQQ.US"]);
  assert.deepEqual(result.cards.map((card) => card.symbol), ["AAPL.US", "NVDA.US", "QQQ.US"]);
  assert.deepEqual(result.cards.find((card) => card.symbol === "AAPL.US").memberships, [
    "holding",
    "watchlist",
  ]);
  assert.equal(fixture.source.calls.filter((call) => call.symbol === "QQQ.US").length, 1);
  assert.ok(fixture.source.calls.every((call) => call.count === TECHNICAL_RADAR_SERVICE_CANDLE_COUNT));
  assert.ok(fixture.source.calls.every((call) => call.options.preferPersistent === true));
  assert.ok(fixture.source.calls.every((call) => call.options.allowPersistentFallback === true));
  assert.ok(fixture.source.maxActive <= TECHNICAL_RADAR_SERVICE_CONCURRENCY);
  assert.equal(result.persistence.appended, true);
  assert.equal(result.coverage.dataLoads.failedCount, 0);

  const latest = await fixture.radarStore.latest({ accountScopeId: ACCOUNT_SCOPE });
  assert.deepEqual(Object.keys(latest.items[0]).sort(), PERSISTED_CARD_FIELDS);
  assert.equal("input" in latest.items[0], false);
  assert.equal("cacheKey" in latest.items[0], false);
  assert.equal("capabilityMatrix" in latest.items[0], false);
  assert.equal("advisory" in latest.items[0], false);
  assert.equal("decisionAuthority" in latest.items[0], false);
  assert.ok(latest.summary.coverage);
  assert.ok(latest.summary.rankings);
  assert.ok(latest.summary.comparison);
  assert.ok(latest.summary.capabilityMatrix);
  assert.equal((await fixture.radarStore.verifyIntegrity()).valid, true);

  const callCount = fixture.source.calls.length;
  const snapshot = await fixture.service.snapshot({ portfolio: fixture.portfolio });
  assert.equal(fixture.source.calls.length, callCount, "snapshot must not fetch market data");
  assert.equal(snapshot.status, "available");
  assert.deepEqual(snapshot.cards, latest.items);
  assert.equal(snapshot.latest.batchId, latest.batchId);
});

test("normalizes live and memory coverage so an identical repeat is cache-idempotent and comparable", async () => {
  const fixture = await serviceFixture({
    watchlist: ["AAPL.US"],
    positions: [{ symbol: "AAPL.US", quantity: 10, instrumentType: "equity" }],
    sourceOptions: { memoryAfterFirst: true },
  });

  const first = await fixture.service.run({ portfolio: fixture.portfolio });
  const second = await fixture.service.run({ portfolio: fixture.portfolio });

  assert.equal(first.persistence.appended, true);
  assert.equal(second.persistence.appended, false);
  assert.equal(second.evidenceHash, first.evidenceHash);
  assert.equal(second.persistence.batchId, first.persistence.batchId);
  assert.equal(second.cards[0].comparison.status, "available");
  assert.equal(second.cards[0].comparison.kind, "unchanged");
  assert.deepEqual(second.cards[0].comparison.changedFields, []);
  assert.equal((await fixture.radarStore.listBatches({ accountScopeId: ACCOUNT_SCOPE })).length, 1);

  const persisted = await fixture.radarStore.latest({ accountScopeId: ACCOUNT_SCOPE });
  assert.deepEqual(Object.keys(persisted.items[0]).sort(), PERSISTED_CARD_FIELDS);
  assert.ok(persisted.items[0].observableState);
});

test("degrades one target load without losing the batch, but fails closed when QQQ is unavailable", async () => {
  const targetFailure = await serviceFixture({
    positions: [
      { symbol: "AAPL.US", quantity: 1, instrumentType: "equity" },
      { symbol: "MSFT.US", quantity: 1, instrumentType: "equity" },
    ],
    sourceOptions: { failures: new Set(["AAPL.US"]) },
  });

  const result = await targetFailure.service.run({ portfolio: targetFailure.portfolio });
  assert.equal(result.cards.find((card) => card.symbol === "AAPL.US").status, "unavailable");
  assert.equal(result.cards.find((card) => card.symbol === "MSFT.US").status === "unavailable", false);
  assert.deepEqual(result.dataLoads.failures.map((failure) => failure.symbol), ["AAPL.US"]);
  assert.equal(result.persistence.appended, true);

  const benchmarkFailure = await serviceFixture({
    positions: [{ symbol: "AAPL.US", quantity: 1, instrumentType: "equity" }],
    sourceOptions: { failures: new Set(["QQQ.US"]) },
  });
  await assert.rejects(
    benchmarkFailure.service.run({ portfolio: benchmarkFailure.portfolio }),
    (error) => error.code === "technical_radar_benchmark_failed"
      && error.details.benchmarkSymbol === "QQQ.US",
  );
  assert.equal((await benchmarkFailure.radarStore.listBatches()).length, 0);
});

test("classifies and removes an unfinished terminal daily bar before attesting scanner input", async () => {
  let scannerInput = null;
  const classifierCalls = [];
  const fixture = await serviceFixture({
    positions: [{ symbol: "AAPL.US", quantity: 1, instrumentType: "equity" }],
    sourceOptions: { terminalForming: true, barCount: 36 },
    scanner(input) {
      scannerInput = structuredClone(input);
      return buildTierATechnicalBatchScan(input);
    },
    classifyDailyBar(bar, options) {
      classifierCalls.push({ bar: structuredClone(bar), options: structuredClone(options) });
      return classifyLastDailyBar(bar, options);
    },
  });
  const expectedBars = fixture.source.barsFor("QQQ.US").slice(0, -1);

  const result = await fixture.service.run({ portfolio: fixture.portfolio });

  assert.equal("analysisTime" in scannerInput, false);
  assert.equal(scannerInput.dailyBySymbol["AAPL.US"].completedBarsOnly, true);
  assert.equal(scannerInput.dailyBySymbol["AAPL.US"].bars.length, 35);
  assert.ok(scannerInput.dailyBySymbol["AAPL.US"].bars.every((bar) => bar.isClosed === true));
  assert.equal(result.tradingDate, expectedBars.at(-1).tradeDate);
  assert.ok(result.dataLoads.finality.every((item) => item.terminalExcluded === true));
  assert.equal(classifierCalls.length, 2);
  assert.ok(classifierCalls.every((call) => call.options.analysisTime === "2026-09-01T22:00:00.000Z"));
});

test("caps the universe at 50 with holdings before watchlist and never exceeds four candle requests", async () => {
  const holdings = Array.from({ length: 50 }, (_, index) => ({
    symbol: `H${String(index).padStart(2, "0")}.US`,
    quantity: 1,
    instrumentType: "equity",
  })).reverse();
  const watchlist = Array.from({ length: 12 }, (_, index) => `W${String(index).padStart(2, "0")}.US`);
  const fixture = await serviceFixture({
    positions: [
      ...holdings,
      { symbol: "ZERO.US", quantity: 0, instrumentType: "equity" },
      { symbol: "OPT260918P100000.US", quantity: 1 },
    ],
    watchlist,
    sourceOptions: { barCount: 24, delayMs: 1 },
  });

  const result = await fixture.service.run({ portfolio: fixture.portfolio });

  assert.equal(result.universe.selectedSymbols.length, 50);
  assert.equal(result.universe.omittedWatchlistSymbols.length, 12);
  assert.equal(result.universe.omittedHoldingSymbols.length, 0);
  assert.equal(result.cards.length, 50);
  assert.equal(fixture.source.calls.length, 51, "50 selected holdings plus one QQQ benchmark");
  assert.equal(fixture.source.calls.some((call) => call.symbol.startsWith("W")), false);
  assert.equal(fixture.source.maxActive, 4);
});

test("honors a pre-aborted signal without fetching or persisting", async () => {
  const fixture = await serviceFixture({
    positions: [{ symbol: "AAPL.US", quantity: 1, instrumentType: "equity" }],
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    fixture.service.run({ portfolio: fixture.portfolio, signal: controller.signal }),
    (error) => error.name === "AbortError",
  );
  assert.equal(fixture.source.calls.length, 0);
  assert.equal((await fixture.radarStore.listBatches()).length, 0);
});

test("buildRadarUniverse excludes options and zero quantities deterministically", () => {
  const result = buildRadarUniverse({
    positions: [
      { symbol: "TSLA.US", quantity: -3, instrumentType: "equity" },
      { symbol: "AAPL.US", quantity: 0, instrumentType: "equity" },
      { symbol: "MSFT260918C400000.US", quantity: 1 },
    ],
    watchlistItems: ["NVDA.US", "TSLA.US", "QQQ260918P500000.US"],
  });

  assert.deepEqual(result.holdingSymbols, ["TSLA.US"]);
  assert.deepEqual(result.watchlistSymbols, ["NVDA.US", "TSLA.US"]);
  assert.deepEqual(result.selectedSymbols, ["TSLA.US", "NVDA.US"]);
  assert.deepEqual(result.excludedHoldings.map((item) => item.reason).sort(), [
    "option_excluded",
    "zero_quantity",
  ]);
  assert.deepEqual(result.excludedWatchlist.map((item) => item.reason), ["option_excluded"]);
});

async function serviceFixture({
  positions = [],
  watchlist = [],
  sourceOptions = {},
  scanner = buildTierATechnicalBatchScan,
  classifyDailyBar = classifyLastDailyBar,
} = {}) {
  const encryptedStore = memoryStore();
  const radarStore = new TechnicalRadarStore({ store: encryptedStore });
  const watchlistStore = new TechnicalWatchlistStore({ store: encryptedStore });
  if (watchlist.length) await watchlistStore.replace(watchlist, { updatedAt: WATCHLIST_TIME });
  const source = candleSource(sourceOptions);
  const portfolio = {
    accountScopeIdentity: { scopeId: ACCOUNT_SCOPE },
    positions: structuredClone(positions),
  };
  const portfolioService = {
    candlesWithCoverage: source.candlesWithCoverage,
    async cachedPortfolio() { return structuredClone(portfolio); },
  };
  const service = new TechnicalRadarService({
    portfolioService,
    radarStore,
    watchlistStore,
    scanner,
    classifyDailyBar,
    clock: () => FIXED_CLOCK,
  });
  return { service, radarStore, watchlistStore, source, portfolio };
}

function candleSource({
  failures = new Set(),
  terminalForming = false,
  barCount = 220,
  memoryAfterFirst = false,
  delayMs = 0,
} = {}) {
  const calls = [];
  const perSymbol = new Map();
  let active = 0;
  let maxActive = 0;
  const barsFor = (symbol) => calendarBars({
    count: barCount,
    base: 100 + stableSymbolOffset(symbol),
    terminalForming,
  });
  return {
    calls,
    get maxActive() { return maxActive; },
    barsFor,
    async candlesWithCoverage(symbol, count, options) {
      calls.push({ symbol, count, options: { ...options, signal: undefined } });
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (failures.has(symbol)) {
          const error = new Error(`fixture load failed for ${symbol}`);
          error.code = "fixture_candle_failure";
          throw error;
        }
        const attempt = 1 + (perSymbol.get(symbol) ?? 0);
        perSymbol.set(symbol, attempt);
        const source = memoryAfterFirst && attempt > 1 ? "memory" : "live";
        const bars = barsFor(symbol);
        return {
          candles: structuredClone(bars),
          coverage: {
            source,
            originSource: source === "memory" ? "live" : null,
            fetchedAt: "2026-09-01T22:00:00.000Z",
            storedAt: "2026-09-01T22:00:00.000Z",
            latestTradeDate: bars.at(-1).tradeDate,
            requestedCount: count,
            returnedCount: bars.length,
            endpoint: "fixture://daily-candles",
            period: "day",
            adjustment: "forward",
            tradeSessions: "intraday",
            cacheAgeMs: source === "memory" ? 99_999 : 0,
            refreshAttempted: false,
          },
        };
      } finally {
        active -= 1;
      }
    },
  };
}

function calendarBars({ count, base, terminalForming }) {
  const date = new Date("2026-01-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const close = base + index * 0.2;
    const bar = {
      timestamp: `${date.toISOString().slice(0, 10)}T21:00:00.000Z`,
      tradeDate: date.toISOString().slice(0, 10),
      timestampBasis: "exchange_trade_date",
      market: "US",
      open: close - 0.25,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000_000 + index * 100,
      tradeSession: "Intraday",
      isClosed: true,
    };
    date.setUTCDate(date.getUTCDate() + 1);
    if (terminalForming && index === count - 1) bar.isClosed = false;
    return bar;
  });
}

function stableSymbolOffset(symbol) {
  return [...String(symbol)].reduce((total, character) => total + character.charCodeAt(0), 0) % 50;
}

function memoryStore() {
  const values = new Map();
  return {
    async get(key) { return structuredClone(values.get(key)); },
    async set(key, value) { values.set(key, structuredClone(value)); },
  };
}
