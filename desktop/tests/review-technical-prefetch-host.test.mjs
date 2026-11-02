import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";
import { calculateTechnical } from "../src/engine/technical.mjs";
import { filterCandlesBeforeReviewCutoff } from "../src/review/review-cycle-analysis.mjs";

const source = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
const start = source.indexOf("function buildPointInTimeActivitySymbols(");
const end = source.indexOf("\nasync function buildCycleTechnicalValidationSample(", start);
assert.ok(start >= 0 && end > start);
const hostSource = source.slice(start, end);
const cycle = { symbols: ["AAPL.US"], endAt: "2026-09-17T20:00:00.000Z" };

function candles() {
  return Array.from({ length: 100 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 5, 10 + index)).toISOString().slice(0, 10);
    return { timestamp: `${date}T20:00:00Z`, tradeDate: date,
      open: 100 + index, high: 102 + index, low: 99 + index, close: 101 + index, volume: 1000 };
  });
}
function loaded() {
  return { candles: candles(), coverage: { source: "isolated_fixture", partial: false, note: "original" } };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function harness(load = async () => loaded()) {
  const requests = [], timers = new Set(), calculations = [];
  const context = vm.createContext({
    AbortController, Date, Error, Intl, structuredClone,
    finiteOrNull: value => value == null || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null,
    safeError: error => String(error?.message ?? error),
    filterCandlesBeforeReviewCutoff,
    calculateTechnical: (bars, options) => {
      calculations.push(structuredClone({ bars, options }));
      return calculateTechnical(bars, options);
    },
    setTimeout: (callback, milliseconds) => {
      assert.equal(milliseconds, 2500, "keep the production shared deadline");
      const timer = { callback }; timers.add(timer); return timer;
    },
    clearTimeout: timer => timers.delete(timer),
    portfolioService: { candlesWithCoverage: async (symbol, count, options) => {
      assert.equal(count, 600); assert.equal(options.preferPersistent, true);
      requests.push({ symbol, signal: options.signal });
      return load(symbol, options);
    } },
  });
  vm.runInContext(hostSource, context, { filename: "isolated-real-main-technical-prefetch.mjs" });
  return { requests, calculations, timers,
    run: overrides => context.buildCyclePointInTimeTechnical({ cycle, archive: {}, phase: "retrospective", ...overrides }),
    async expire() {
      await setImmediate();
      for (const timer of [...timers]) timer.callback();
    },
  };
}
const plain = value => JSON.parse(JSON.stringify(value));

test("technical prefetch reserves benchmark slots independently of eight business symbols", async () => {
  const h = harness();
  const symbols = Array.from({ length: 9 }, (_, index) => `S${index}.US`);
  const result = await h.run({ cycle: { ...cycle, symbols, benchmark: "SPY.US" } });
  assert.deepEqual(h.requests.map(item => item.symbol), [...symbols.slice(0, 8), "SPY.US", "QQQ.US"]);
  assert.deepEqual(plain(result.omittedSymbols), ["S8.US"]);
  assert.equal(result.status, "partial", "omitted business symbols must not look fully covered");
  assert.equal(result.snapshots.length, 10);
  assert.equal(h.timers.size, 0);
  const held = harness();
  await held.run({ cycle: { ...cycle, symbols: ["QQQ.US", ...symbols.slice(0, 7)], benchmark: "QQQ.US" } });
  assert.equal(held.requests.length, 8, "a held benchmark shares its one request");
});

test("technical prefetch keeps settled sources after timeout and seals detached evidence against late success", async () => {
  const pending = deferred(), first = loaded();
  const h = harness(symbol => symbol === "QQQ.US" ? pending.promise : first);
  const operation = h.run();
  await h.expire();
  const result = await operation;
  assert.equal(result.status, "partial");
  assert.deepEqual(plain(result.snapshots.map(item => item.symbol)), ["AAPL.US"]);
  assert.ok(result.warnings.includes("QQQ.US: historical_candles_timeout"));
  assert.ok(result.nodes[0].warnings.includes("QQQ.US: historical_candles_timeout"));
  assert.ok(h.requests.every(item => item.signal.aborted));
  const before = JSON.stringify(result);
  first.coverage.note = "late mutation"; first.candles[0].close = 999999;
  pending.resolve(loaded()); await setImmediate();
  assert.equal(JSON.stringify(result), before);
  assert.equal(h.timers.size, 0);
});

test("a failed technical source and a late rejected source do not erase successful evidence", async () => {
  const failed = harness(async symbol => { if (symbol === "QQQ.US") throw new Error("fixture denied"); return loaded(); });
  const result = await failed.run();
  assert.equal(result.status, "partial"); assert.equal(result.snapshots.length, 1);
  assert.ok(result.warnings.includes("QQQ.US: fixture denied"));
  const pending = deferred();
  const late = harness(symbol => symbol === "QQQ.US" ? pending.promise : loaded());
  const operation = late.run(); await late.expire(); const timeout = await operation;
  const before = JSON.stringify(timeout);
  pending.reject(new Error("late isolated failure")); await setImmediate();
  assert.equal(JSON.stringify(timeout), before);
});

test("all pending technical sources retain a timed-out status without inventing facts", async () => {
  const h = harness(() => new Promise(() => {}));
  const operation = h.run(); await h.expire(); const result = await operation;
  assert.equal(result.status, "timed_out"); assert.equal(result.snapshots.length, 0);
  assert.equal(result.nodes[0].status, "timed_out");
  assert.deepEqual(plain(result.requestedSymbols), ["AAPL.US", "QQQ.US"]);
});

test("cancelled technical prefetch rejects before fetch or while pending and never returns a partial success", async () => {
  const before = new AbortController(); before.abort(new Error("fixture cancelled before fetch"));
  const h = harness(); await assert.rejects(h.run({ signal: before.signal }), /cancelled before fetch/);
  assert.equal(h.requests.length, 0);
  const pending = deferred(), during = new AbortController();
  const active = harness(symbol => symbol === "QQQ.US" ? pending.promise : loaded());
  const operation = active.run({ signal: during.signal });
  await setImmediate(); during.abort(new Error("fixture cancelled while waiting"));
  await assert.rejects(operation, /cancelled while waiting/);
  assert.equal(active.timers.size, 0); assert.ok(active.requests.every(item => item.signal.aborted));
  pending.resolve(loaded()); await setImmediate();
});

test("blind technical nodes keep introduced-symbol and strict per-node candle cutoffs after partial timeout", async () => {
  const h = harness(symbol => symbol === "QQQ.US" ? new Promise(() => {}) : loaded());
  const input = {
    cycle: { symbols: [], decisionTimeline: [
      { nodeId: "first", timelineIndex: 0, knowledgeCutoffAt: "2026-09-14T15:00:00Z",
        brokerFactsIntroduced: { recordIds: ["order:early", "order:future"] } },
      { nodeId: "later", timelineIndex: 1, knowledgeCutoffAt: "2026-09-17T15:00:00Z",
        brokerFactsIntroduced: { recordIds: ["order:later"] } },
    ] },
    archive: { orders: [
      { orderId: "early", symbol: "AAPL.US", submittedAt: "2026-09-13T12:00:00Z" },
      { orderId: "later", symbol: "MSFT.US", submittedAt: "2026-09-16T12:00:00Z" },
      { orderId: "future", symbol: "FUTURE.US", submittedAt: "2026-09-18T12:00:00Z" },
    ] }, phase: "blind",
  };
  const operation = h.run(input); await h.expire(); const result = await operation;
  assert.deepEqual(h.requests.map(item => item.symbol), ["AAPL.US", "MSFT.US", "QQQ.US"]);
  assert.deepEqual(plain(result.snapshots.map(item => item.symbol)), ["AAPL.US"]);
  assert.deepEqual(plain(result.nodes[0].requestedSymbols), ["AAPL.US", "QQQ.US"]);
  assert.deepEqual(plain(result.nodes[1].snapshots.map(item => item.symbol)), ["AAPL.US", "MSFT.US"]);
  for (const { bars, options } of h.calculations) {
    assert.ok(bars.length > 0);
    assert.ok(bars.every(bar => bar.tradeDate < options.analysisTime.slice(0, 10)), "cutoff-day and future daily bars stay excluded");
  }
  assert.equal(result.status, "partial");
});

test("technical prefetch without a valid cutoff or symbols does not call market tools", async () => {
  const h = harness();
  assert.equal((await h.run({ cycle: { symbols: ["AAPL.US"] } })).status, "unavailable");
  assert.equal((await h.run({ cycle: { endAt: cycle.endAt, symbols: [] } })).status, "unavailable");
  assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0);
});
