import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewCycleOutcomeMetrics,
  calculateExecutionGrossPnl,
  summarizeTradePricePath,
} from "../src/review/review-cycle-outcome-metrics.mjs";

function bar(tradeDate, close, { high = close, low = close } = {}) {
  return {
    timestamp: `${tradeDate}T20:00:00.000Z`,
    tradeDate,
    open: close,
    high,
    low,
    close,
    isClosed: true,
  };
}

function metricsCycle(symbols = ["AAPL.US"]) {
  return { symbols, startAt: "2026-08-03T00:00:00.000Z", endAt: "2026-08-31T21:00:00.000Z",
    brokerLinks: { executionIds: [] } };
}

const completeBars = () => [bar("2026-08-03", 100), bar("2026-08-31", 110)];

test("eight cycle symbols retain an independent QQQ benchmark request and complete coverage", async () => {
  const symbols = Array.from({ length: 8 }, (_, index) => `T${index}.US`);
  const calls = [];
  const result = await buildReviewCycleOutcomeMetrics({ cycle: metricsCycle(symbols), archive: {},
    loadCandles: async (symbol) => { calls.push(symbol); return completeBars(); } });
  assert.deepEqual(calls, [...symbols, "QQQ.US"]);
  assert.equal(result.pricePath.symbols.length, 8);
  assert.equal(result.pricePath.benchmarkMetrics.status, "available");
  assert.equal(result.pricePath.excessReturns.every((item) => item.valuePercent === 0), true);
  assert.deepEqual(result.coverage.omittedSymbols, []);
  assert.equal(result.coverage.cycleSymbolCoverage.omittedCount, 0);
  assert.equal(result.coverage.benchmarkCoverage.independentRequestSlot, true);
});

test("stock budget is explicit, normalized duplicates do not consume it and a held benchmark shares one request", async () => {
  const symbols = ["QQQ.US", "qqq.us", ...Array.from({ length: 9 }, (_, index) => `T${index}.US`)];
  const calls = [];
  const result = await buildReviewCycleOutcomeMetrics({ cycle: metricsCycle(symbols), archive: {},
    loadCandles: async (symbol) => { calls.push(symbol); return completeBars(); } });
  assert.equal(calls.filter((symbol) => symbol === "QQQ.US").length, 1);
  assert.equal(calls.length, 8);
  assert.equal(result.coverage.cycleSymbolCoverage.sourceCount, 10);
  assert.equal(result.coverage.cycleSymbolCoverage.deliveredCount, 8);
  assert.deepEqual(result.coverage.cycleSymbolCoverage.omittedSymbols, ["T7.US", "T8.US"]);
  assert.equal(result.coverage.cycleSymbolCoverage.omittedCount, 2);
  assert.equal(result.coverage.benchmarkCoverage.sharedWithCycleSymbol, true);
  assert.ok(result.coverage.reasons.includes("metric_symbol_limit_reached"));
  assert.equal(result.status, "partial");
});

test("global deadline preserves completed source and individual failure while timing out only unfinished source", async () => {
  let resolveBenchmark;
  let benchmarkSignal;
  const result = await buildReviewCycleOutcomeMetrics({ cycle: metricsCycle(["AAPL.US", "BAD.US"]), archive: {}, timeoutMs: 50,
    loadCandles: async (symbol, _count, { signal }) => {
      if (symbol === "AAPL.US") return completeBars();
      if (symbol === "BAD.US") throw new Error("provider permission denied");
      benchmarkSignal = signal;
      return new Promise((resolve) => { resolveBenchmark = resolve; });
    } });
  assert.equal(benchmarkSignal.aborted, true);
  assert.deepEqual(result.coverage.loadedSymbols.map((item) => item.symbol), ["AAPL.US"]);
  assert.deepEqual(result.coverage.failedSymbols, [
    { symbol: "BAD.US", reason: "provider permission denied" }, { symbol: "QQQ.US", reason: "timeout" },
  ]);
  assert.equal(result.pricePath.symbols[0].periodReturnPercent, 10);
  assert.equal(result.pricePath.benchmarkMetrics.status, "unavailable");
  assert.equal(result.pricePath.status, "partial");
  const before = JSON.stringify(result);
  resolveBenchmark(completeBars());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(result), before, "late source must not mutate returned evidence");
});

test("a late provider rejection is consumed after the deadline without changing completed evidence", async () => {
  let rejectBenchmark;
  const result = await buildReviewCycleOutcomeMetrics({ cycle: metricsCycle(), archive: {}, timeoutMs: 50,
    loadCandles: async (symbol) => symbol === "QQQ.US"
      ? new Promise((_resolve, reject) => { rejectBenchmark = reject; }) : completeBars() });
  const before = JSON.stringify(result);
  rejectBenchmark(new Error("late transport rejection"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(result), before);
});

test("cancel does not wait for a provider that ignores AbortSignal or downgrade to ordinary missing evidence", async () => {
  const controller = new AbortController();
  let providerStarted;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  const pending = buildReviewCycleOutcomeMetrics({ cycle: metricsCycle(), archive: {}, signal: controller.signal, timeoutMs: 10_000,
    loadCandles: async () => { providerStarted(); return new Promise(() => {}); } });
  await started;
  controller.abort(new Error("user cancelled uncooperative provider"));
  let timer;
  try {
    await assert.rejects(Promise.race([pending, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("cancel remained blocked")), 500);
    })]), /user cancelled uncooperative provider/);
  } finally { clearTimeout(timer); }
});

test("pre-aborted requests perform no provider work", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled before start"));
  let calls = 0;
  await assert.rejects(buildReviewCycleOutcomeMetrics({ cycle: metricsCycle(), archive: {}, signal: controller.signal,
    loadCandles: async () => { calls += 1; return []; } }), /cancelled before start/);
  assert.equal(calls, 0);
});

test("linked FIFO executions produce verifiable round-trip gross P&L while account cost basis and fees remain unavailable", () => {
  const result = calculateExecutionGrossPnl({
    linkedExecutionCount: 2,
    startAt: "2026-08-01T00:00:00Z",
    startingPortfolio: { snapshotAt: "2026-07-31T23:00:00Z", positions: [] },
    executions: [
      { symbol: "AAOI.US", side: "Buy", quantity: 100, price: 10, currency: "USD", doneAt: "2026-08-01T14:00:00Z" },
      { symbol: "AAOI.US", side: "Sell", quantity: 20, price: 12, currency: "USD", doneAt: "2026-08-05T20:00:00Z" },
    ],
  });
  assert.equal(result.status, "available");
  assert.equal(result.linkedRoundTripGrossPnl, 40);
  assert.equal(result.accountRealizedGrossPnl, null);
  assert.equal(result.currency, "USD");
  assert.equal(result.netPnl, null);
  assert.equal(result.netPnlReason, "execution_fees_and_taxes_unavailable");
  assert.equal(result.bySymbol[0].endingUnclosedBuyQuantity, 80);
});

test("a sell requiring unknown starting inventory never fabricates execution P&L", () => {
  const result = calculateExecutionGrossPnl({
    linkedExecutionCount: 1,
    executions: [
      { symbol: "AAOI.US", side: "Sell", quantity: 20, price: 12, currency: "USD", doneAt: "2026-08-05T20:00:00Z" },
    ],
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.linkedRoundTripGrossPnl, null);
  assert.equal(result.reason, "starting_inventory_or_short_open_close_unknown");
});

test("a matched in-cycle buy and sell is only linked round-trip gross when starting inventory is unproven", () => {
  const result = calculateExecutionGrossPnl({
    linkedExecutionCount: 2,
    startAt: "2026-08-01T00:00:00Z",
    executions: [
      { symbol: "AAOI.US", side: "Buy", quantity: 100, price: 10, currency: "USD", doneAt: "2026-08-01T14:00:00Z" },
      { symbol: "AAOI.US", side: "Sell", quantity: 20, price: 12, currency: "USD", doneAt: "2026-08-05T20:00:00Z" },
    ],
  });
  assert.equal(result.status, "partial");
  assert.equal(result.linkedRoundTripGrossPnl, 40);
  assert.equal(result.accountRealizedGrossPnl, null);
  assert.equal(result.reason, "starting_inventory_not_proven_zero_linked_round_trip_only");
});

test("a semantically excluded execution price can never enter deterministic P&L", () => {
  const result = calculateExecutionGrossPnl({
    linkedExecutionCount: 2,
    startAt: "2026-08-01T00:00:00Z",
    startingPortfolio: { snapshotAt: "2026-07-31T23:00:00Z", positions: [] },
    executions: [
      { symbol: "TSLA.US", side: "Buy", quantity: 1, price: 5.36, currency: "USD", doneAt: "2026-08-01T14:00:00Z", priceAudit: { status: "excluded" } },
      { symbol: "TSLA.US", side: "Sell", quantity: 1, price: 12, currency: "USD", doneAt: "2026-08-05T20:00:00Z" },
    ],
  });
  assert.equal(result.linkedRoundTripGrossPnl, null);
  assert.equal(result.reason, "execution_fields_incomplete");
});

test("boolean execution numerics never become a one-share one-dollar trade", () => {
  const result = calculateExecutionGrossPnl({
    linkedExecutionCount: 2,
    startAt: "2026-08-01T00:00:00Z",
    startingPortfolio: { snapshotAt: "2026-07-31T23:00:00Z", positions: [] },
    executions: [
      { symbol: "AAOI.US", side: "Buy", quantity: true, price: 10, currency: "USD", doneAt: "2026-08-01T14:00:00Z" },
      { symbol: "AAOI.US", side: "Sell", quantity: 1, price: false, currency: "USD", doneAt: "2026-08-05T20:00:00Z" },
    ],
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.linkedRoundTripGrossPnl, null);
  assert.equal(result.reason, "execution_fields_incomplete");
});

test("option execution P&L requires a real multiplier and applies it exactly once", () => {
  const optionSymbol = "AAPL260918C250000.US";
  const base = {
    linkedExecutionCount: 2,
    startAt: "2026-08-01T00:00:00Z",
    startingPortfolio: { snapshotAt: "2026-07-31T23:00:00Z", positions: [] },
  };
  const withoutMultiplier = calculateExecutionGrossPnl({
    ...base,
    executions: [
      { symbol: optionSymbol, side: "Buy", quantity: 1, price: 2, currency: "USD", doneAt: "2026-08-01T14:00:00Z" },
      { symbol: optionSymbol, side: "Sell", quantity: 1, price: 3, currency: "USD", doneAt: "2026-08-05T20:00:00Z" },
    ],
  });
  assert.equal(withoutMultiplier.status, "unavailable");
  assert.equal(withoutMultiplier.reason, "option_contract_multiplier_unavailable");

  const withMultiplier = calculateExecutionGrossPnl({
    ...base,
    executions: [
      { symbol: optionSymbol, side: "Buy", quantity: 1, price: 2, contractMultiplier: 100, currency: "USD", doneAt: "2026-08-01T14:00:00Z" },
      { symbol: optionSymbol, side: "Sell", quantity: 1, price: 3, contractMultiplier: 100, currency: "USD", doneAt: "2026-08-05T20:00:00Z" },
    ],
  });
  assert.equal(withMultiplier.status, "available");
  assert.equal(withMultiplier.linkedRoundTripGrossPnl, 100);
  assert.equal(withMultiplier.bySymbol[0].contractMultiplier, 100);
});

test("outcome pipeline bounds Longbridge bars by cycle end and computes symbol, benchmark, excess, MFE and MAE", async () => {
  const cycle = {
    id: "cycle-1",
    type: "position_lifecycle",
    symbol: "AAOI.US",
    benchmark: "QQQ.US",
    timezone: "UTC",
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-10T23:59:59.000Z",
    brokerLinks: { executionIds: ["buy", "sell"] },
    startingPortfolio: { snapshotAt: "2026-07-31T23:00:00.000Z", positions: [] },
  };
  const archive = {
    syncedAt: "2026-08-11T00:00:00.000Z",
    executions: [
      { tradeId: "buy", symbol: "AAOI.US", side: "Buy", quantity: 100, price: 10, currency: "USD", doneAt: "2026-08-01T14:00:00Z" },
      { tradeId: "sell", symbol: "AAOI.US", side: "Sell", quantity: 20, price: 12, currency: "USD", doneAt: "2026-08-05T20:00:00Z" },
    ],
  };
  const values = {
    "AAOI.US": [
      bar("2026-08-01", 10, { high: 11, low: 9 }),
      bar("2026-08-05", 12, { high: 12, low: 10 }),
      bar("2026-08-10", 11, { high: 11.5, low: 10.5 }),
      bar("2026-08-11", 99, { high: 100, low: 90 }),
    ],
    "QQQ.US": [bar("2026-08-01", 100), bar("2026-08-10", 105), bar("2026-08-11", 1)],
  };
  const result = await buildReviewCycleOutcomeMetrics({
    cycle,
    archive,
    loadCandles: async (symbol) => values[symbol],
    now: () => new Date("2026-08-11T01:00:00Z"),
  });
  assert.equal(result.status, "available");
  assert.equal(result.executionPnl.linkedRoundTripGrossPnl, 40);
  assert.equal(result.executionPnl.accountRealizedGrossPnl, null);
  assert.equal(result.pricePath.symbols[0].periodReturnPercent, 10);
  assert.equal(result.pricePath.symbols[0].priceMfePercent, 20);
  assert.equal(result.pricePath.symbols[0].priceMaePercent, -10);
  assert.equal(result.pricePath.benchmarkMetrics.periodReturnPercent, 5);
  assert.equal(result.pricePath.excessReturns[0].valuePercent, 5);
  assert.equal(result.pricePath.symbols[0].lastTradeDate, "2026-08-10");
  assert.equal(result.provenance.modelLookupAllowedAsMetricSubstitute, false);
});

test("offline outcome metrics return structured coverage and null reasons without blocking review", async () => {
  const result = await buildReviewCycleOutcomeMetrics({
    cycle: {
      symbol: "AAOI.US",
      startAt: "2026-08-01T00:00:00Z",
      endAt: "2026-08-10T00:00:00Z",
      brokerLinks: { executionIds: [] },
    },
    archive: { syncedAt: null, executions: [] },
    loadCandles: null,
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.executionPnl.linkedRoundTripGrossPnl, null);
  assert.equal(result.executionPnl.reason, "no_linked_executions");
  assert.deepEqual(result.coverage.reasons, ["longbridge_candles_unavailable"]);
  assert.equal(result.pricePath.symbols.length, 1);
  assert.equal(result.pricePath.symbols[0].periodReturnPercent, null);
  assert.equal(result.pricePath.symbols[0].reason, "candles_not_loaded");
});

test("missing linked executions invalidate aggregate P&L instead of silently calculating a partial subset", async () => {
  const result = await buildReviewCycleOutcomeMetrics({
    cycle: {
      symbol: "AAOI.US",
      startAt: "2026-08-01T00:00:00Z",
      endAt: "2026-08-10T00:00:00Z",
      brokerLinks: { executionIds: ["present", "missing"] },
    },
    archive: {
      syncedAt: "2026-08-11T00:00:00Z",
      executions: [{ tradeId: "present", symbol: "AAOI.US", side: "Buy", quantity: 10, price: 5, doneAt: "2026-08-02T00:00:00Z" }],
    },
    loadCandles: null,
  });
  assert.equal(result.executionPnl.linkedRoundTripGrossPnl, null);
  assert.equal(result.executionPnl.reason, "linked_executions_missing_from_archive");
  assert.equal(result.executionPnl.coverage.missingExecutionCount, 1);
});

test("parent cancellation is propagated instead of being reported as ordinary missing market data", async () => {
  const controller = new AbortController();
  const pending = buildReviewCycleOutcomeMetrics({
    cycle: {
      symbol: "AAOI.US",
      startAt: "2026-08-01T00:00:00Z",
      endAt: "2026-08-10T00:00:00Z",
      brokerLinks: { executionIds: [] },
    },
    archive: { executions: [] },
    signal: controller.signal,
    loadCandles: async (_symbol, _count, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  const reason = new Error("user cancelled");
  controller.abort(reason);
  await assert.rejects(pending, /user cancelled/);
});

test("trade-window metrics use only the explicitly boxed Buy and Sell orders and split long paths into three trading-day segments", async () => {
  const cycle = {
    id: "cycle-selected-window",
    type: "trade_window",
    symbols: ["AAOI.US"],
    benchmark: "QQQ.US",
    timezone: "Asia/Shanghai",
    startAt: "2026-07-20T00:00:00.000Z",
    endAt: "2026-08-20T00:00:00.000Z",
    brokerLinks: {
      requestedRecordIds: ["order:selected-buy", "order:selected-sell"],
      executionIds: ["old-buy", "selected-buy-fill", "selected-sell-fill", "later-sell"],
    },
  };
  const archive = {
    syncedAt: "2026-08-20T00:00:00.000Z",
    orders: [
      { orderId: "old", symbol: "AAOI.US", side: "Buy", currency: "USD" },
      { orderId: "selected-buy", symbol: "AAOI.US", side: "Buy", currency: "USD" },
      { orderId: "selected-sell", symbol: "AAOI.US", side: "Sell", currency: "USD" },
      { orderId: "later", symbol: "AAOI.US", side: "Sell", currency: "USD" },
    ],
    executions: [
      { tradeId: "old-buy", orderId: "old", symbol: "AAOI.US", side: "Buy", quantity: 100, price: 70, currency: "USD", doneAt: "2026-07-21T14:00:00Z" },
      { tradeId: "selected-buy-fill", orderId: "selected-buy", symbol: "AAOI.US", side: "Buy", quantity: 100, price: 100, currency: "USD", doneAt: "2026-08-03T13:00:00Z" },
      { tradeId: "selected-sell-fill", orderId: "selected-sell", symbol: "AAOI.US", side: "Sell", quantity: 20, price: 112, currency: "USD", doneAt: "2026-08-11T21:00:00Z" },
      { tradeId: "later-sell", orderId: "later", symbol: "AAOI.US", side: "Sell", quantity: 80, price: 120, currency: "USD", doneAt: "2026-08-18T21:00:00Z" },
    ],
  };
  const aaoiBars = [
    bar("2026-08-03", 100),
    bar("2026-08-04", 101),
    bar("2026-08-05", 102),
    bar("2026-08-06", 103),
    bar("2026-08-07", 104),
    bar("2026-08-10", 105),
    bar("2026-08-11", 106),
    bar("2026-08-12", 999),
  ];
  const result = await buildReviewCycleOutcomeMetrics({
    cycle,
    archive,
    loadCandles: async (symbol) => symbol === "AAOI.US"
      ? aaoiBars
      : aaoiBars.map((item) => ({ ...item, symbol: "QQQ.US" })),
    now: () => new Date("2026-08-20T01:00:00Z"),
  });

  assert.equal(result.tradePricePath.window.startActivityId, "execution:selected-buy-fill");
  assert.equal(result.tradePricePath.window.endActivityId, "execution:selected-sell-fill");
  assert.equal(result.tradePricePath.window.startAt, "2026-08-03T13:00:00.000Z");
  assert.equal(result.tradePricePath.window.endAt, "2026-08-11T21:00:00.000Z");
  assert.deepEqual(result.tradePricePath.activities.map((item) => item.id), [
    "execution:selected-buy-fill",
    "execution:selected-sell-fill",
  ]);
  assert.equal(result.tradePricePath.positionStatus, "partially_closed");
  assert.equal(result.tradePricePath.metrics.openQuantity, 80);
  assert.equal(result.executionPnl.linkedRoundTripGrossPnl, 240);
  assert.equal(result.executionPnl.bySymbol[0].realizedQuantity, 20);
  assert.equal(result.executionPnl.bySymbol[0].endingUnclosedBuyQuantity, 80);
  assert.equal(result.executionPnl.coverage.usedExecutionCount, 2);
  assert.equal(result.executionPnl.coverage.selectionScope, "explicit_user_selected_buy_sell_activities");
  assert.equal(result.tradePricePath.pricePath.trend.granularity, "3_trading_days");
  assert.deepEqual(
    result.tradePricePath.pricePath.trend.segments.map((item) => item.tradingDayCount),
    [3, 3, 1],
  );
  assert.equal(result.tradePricePath.pricePath.trend.segments.at(-1).endTradeDate, "2026-08-11");
  assert.equal(result.tradePricePath.coverage.timezone, "America/New_York");
  assert.equal(result.cycleWindow.policy, "explicit_user_selected_buy_to_sell");
  assert.equal(result.cycleWindow.startAt, "2026-08-03T13:00:00.000Z");
  assert.equal(result.cycleWindow.endAt, "2026-08-11T21:00:00.000Z");
  assert.equal(result.pricePath.symbols[0].firstTradeDate, "2026-08-03");
  assert.equal(result.pricePath.symbols[0].lastTradeDate, "2026-08-11");
  assert.equal(result.pricePath.symbols[0].periodReturnPercent, 6);
});

test("selecting exact executions never absorbs sibling fills, while a legacy trade window without explicit anchors fails closed", async () => {
  const archive = {
    orders: [
      { orderId: "buy-order", symbol: "AAOI.US", side: "Buy", currency: "USD" },
      { orderId: "sell-order", symbol: "AAOI.US", side: "Sell", currency: "USD" },
    ],
    executions: [
      { tradeId: "buy-selected", orderId: "buy-order", symbol: "AAOI.US", side: "Buy", quantity: 10, price: 100, currency: "USD", doneAt: "2026-08-03T14:00:00Z" },
      { tradeId: "buy-sibling", orderId: "buy-order", symbol: "AAOI.US", side: "Buy", quantity: 90, price: 101, currency: "USD", doneAt: "2026-08-04T14:00:00Z" },
      { tradeId: "sell-selected", orderId: "sell-order", symbol: "AAOI.US", side: "Sell", quantity: 10, price: 110, currency: "USD", doneAt: "2026-08-05T21:00:00Z" },
    ],
  };
  const baseCycle = {
    type: "trade_window",
    symbol: "AAOI.US",
    startAt: "2026-08-01T00:00:00Z",
    endAt: "2026-08-10T00:00:00Z",
    brokerLinks: { executionIds: ["buy-selected", "buy-sibling", "sell-selected"] },
  };
  const selected = await buildReviewCycleOutcomeMetrics({
    cycle: {
      ...baseCycle,
      brokerLinks: {
        ...baseCycle.brokerLinks,
        requestedRecordIds: ["execution:buy-selected", "execution:sell-selected"],
      },
    },
    archive,
    loadCandles: async () => [bar("2026-08-03", 100), bar("2026-08-04", 105), bar("2026-08-05", 110)],
  });
  assert.deepEqual(selected.tradePricePath.activities.map((item) => item.id), [
    "execution:buy-selected",
    "execution:sell-selected",
  ]);
  assert.equal(selected.tradePricePath.metrics.realizedQuantity, 10);

  const legacy = await buildReviewCycleOutcomeMetrics({
    cycle: baseCycle,
    archive,
    loadCandles: async () => [bar("2026-08-03", 100), bar("2026-08-05", 110)],
  });
  assert.equal(legacy.tradePricePath.status, "unavailable");
  assert.equal(legacy.tradePricePath.reason, "no_executed_activity_in_selected_records");
  assert.equal(legacy.tradePricePath.window, null);
  assert.equal(legacy.cycleWindow.policy, "declared_cycle_window_fallback_due_to_missing_explicit_anchors");
  assert.equal(legacy.coverage.reasons.includes("explicit_trade_window_unavailable_declared_cycle_fallback_used"), true);
  assert.match(legacy.provenance.executionMethod, /explicit user-selected Buy\/Sell activities/);
});

test("generic symbol and benchmark paths use the exchange timezone instead of the cycle display timezone", async () => {
  const result = await buildReviewCycleOutcomeMetrics({
    cycle: {
      type: "position_lifecycle",
      symbol: "AAOI.US",
      benchmark: "QQQ.US",
      timezone: "Asia/Shanghai",
      // 15:00 New York on Aug 3 is already Aug 4 in Shanghai.
      startAt: "2026-08-03T19:00:00Z",
      endAt: "2026-08-05T21:00:00Z",
      brokerLinks: { executionIds: [] },
    },
    archive: { executions: [] },
    loadCandles: async (symbol) => [
      { ...bar("2026-08-03", 100), symbol },
      { ...bar("2026-08-04", 105), symbol },
      { ...bar("2026-08-05", 110), symbol },
    ],
  });
  assert.equal(result.pricePath.symbols[0].firstTradeDate, "2026-08-03");
  assert.equal(result.pricePath.symbols[0].lastTradeDate, "2026-08-05");
  assert.equal(result.pricePath.symbols[0].periodReturnPercent, 10);
});

test("outcome evidence preserves candle cache provenance and marks fallback history as degraded", async () => {
  const result = await buildReviewCycleOutcomeMetrics({
    cycle: {
      type: "position_lifecycle",
      symbol: "AAOI.US",
      benchmark: "QQQ.US",
      startAt: "2026-08-03T13:00:00Z",
      endAt: "2026-08-05T21:00:00Z",
      brokerLinks: { executionIds: [] },
    },
    archive: { executions: [] },
    loadCandles: async (symbol) => ({
      candles: [
        { ...bar("2026-08-03", 100), symbol },
        { ...bar("2026-08-04", 101), symbol },
        { ...bar("2026-08-05", 102), symbol },
      ],
      coverage: {
        source: "persistent_fallback",
        originSource: "persistent",
        coverageStatus: "partial",
        partial: true,
        partialReasons: ["stale_cache", "live_refresh_failed"],
        fetchedAt: "2026-08-05T22:00:00Z",
        storedAt: "2026-08-05T22:00:01Z",
        requestedCount: 1_000,
        returnedCount: 3,
        latestTradeDate: "2026-08-05",
        endpoint: "https://mcp.longbridge.com/v2",
        period: "day",
        adjustment: "forward",
        tradeSessions: "intraday",
        refreshAttempted: true,
        fallbackReason: "timeout",
      },
    }),
  });

  assert.equal(result.coverage.candleSources.length, 2);
  assert.equal(result.coverage.candleSources[0].source, "persistent_fallback");
  assert.equal(result.status, "partial");
  assert.equal(result.coverage.candleSources[0].coverageStatus, "partial");
  assert.equal(result.coverage.reasons.includes("candle_evidence_degraded:AAOI.US"), true);
  assert.equal(result.coverage.loadedSymbols[0].source, "persistent_fallback");
});

test("persisted selected-trade path summary keeps anchors and bounded first/last segments", () => {
  const segments = Array.from({ length: 100 }, (_, index) => ({
    index: index + 1,
    startTradeDate: `2026-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
    endTradeDate: `2026-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
    tradingDayCount: 3,
    firstClose: 100 + index,
    lastClose: 101 + index,
  }));
  const summary = summarizeTradePricePath({
    generatedAt: "2026-08-20T00:00:00Z",
    coverage: { candleSources: [{ symbol: "AAOI.US", source: "persistent", coverageStatus: "complete" }] },
    tradePricePath: {
      status: "partial",
      reason: "selected_position_remains_open",
      symbol: "AAOI.US",
      currency: "USD",
      positionStatus: "partially_closed",
      window: {
        startActivityId: "execution:buy",
        endActivityId: "execution:sell",
        startAt: "2026-01-02T15:00:00Z",
        endAt: "2026-08-03T20:00:00Z",
      },
      activities: [
        { id: "execution:buy", side: "buy", quantity: 100, price: 10, currency: "USD", at: "2026-01-02T15:00:00Z" },
        { id: "execution:middle", side: "sell", quantity: 10, price: 11, currency: "USD", at: "2026-04-01T20:00:00Z" },
        { id: "execution:sell", side: "sell", quantity: 20, price: 12, currency: "USD", at: "2026-08-03T20:00:00Z" },
      ],
      metrics: { realizedQuantity: 20, openQuantity: 80, linkedSelectionGrossPnl: 40 },
      pricePath: {
        status: "available",
        periodReturnPercent: 20,
        maePercent: -8,
        mfePercent: 25,
        coverage: { status: "available", eligibleBarCount: 300 },
        trend: { granularity: "3_trading_days", segmentTradingDays: 3, segments },
      },
    },
  }, { maxSegments: 10 });

  assert.deepEqual(summary.activities.map((item) => item.id), ["execution:buy", "execution:sell"]);
  assert.equal(summary.pricePath.trend.segmentCount, 100);
  assert.equal(summary.pricePath.trend.deliveredSegmentCount, 10);
  assert.equal(summary.pricePath.trend.omittedSegmentCount, 90);
  assert.equal(summary.pricePath.trend.segments.some((item) => item.omittedCount === 90), true);
  assert.equal(summary.pricePath.trend.segments[0].index, 1);
  assert.equal(summary.pricePath.trend.segments.at(-1).index, 100);
});
