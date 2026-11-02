import assert from "node:assert/strict";
import test from "node:test";

import {
  TIER_A_TECHNICAL_SCAN_HARD_MAX_SYMBOLS,
  TIER_A_TECHNICAL_SCAN_MAX_BARS_PER_SYMBOL,
  TIER_A_TECHNICAL_SCAN_SCHEMA_VERSION,
  TierATechnicalScanInputError,
  buildTierATechnicalBatchScan,
} from "../src/engine/tier-a-technical-scan.mjs";

function calendarBars({
  count = 40,
  start = "2025-01-01",
  base = 100,
  slope = 0.2,
  volume = 1_000,
} = {}) {
  const date = new Date(`${start}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const close = base + index * slope;
    const value = {
      tradeDate: date.toISOString().slice(0, 10),
      open: close - 0.25,
      high: close + 1,
      low: close - 1,
      close,
      volume: volume + index * 10,
      isClosed: true,
    };
    date.setUTCDate(date.getUTCDate() + 1);
    return value;
  });
}

function dataset(bars, extra = {}) {
  return { bars, completedBarsOnly: true, source: "test_fixture", ...extra };
}

function fullInput() {
  const aapl = calendarBars({ count: 520, base: 100, slope: 0.22 });
  const msft = calendarBars({ count: 520, base: 200, slope: 0.18 });
  const qqq = calendarBars({ count: 520, base: 300, slope: 0.12 });
  const xlk = calendarBars({ count: 520, base: 150, slope: 0.1 });
  return {
    holdings: [{ symbol: "MSFT.US" }, { symbol: "AAPL.US" }],
    watchlist: ["AAPL.US", "MSFT.US"],
    dailyBySymbol: {
      "XLK.US": dataset(xlk),
      "QQQ.US": dataset(qqq),
      "MSFT.US": dataset(msft),
      "AAPL.US": dataset(aapl),
    },
    sectorBySymbol: { "MSFT.US": "XLK.US", "AAPL.US": "XLK.US" },
  };
}

test("builds deterministic compact Tier A cards by reusing the existing engines", () => {
  const input = fullInput();
  const untouched = structuredClone(input);
  const first = buildTierATechnicalBatchScan(input);
  const reordered = buildTierATechnicalBatchScan({
    ...input,
    holdings: [...input.holdings].reverse(),
    watchlist: [...input.watchlist].reverse(),
    dailyBySymbol: Object.fromEntries(Object.entries(input.dailyBySymbol).reverse()),
    sectorBySymbol: Object.fromEntries(Object.entries(input.sectorBySymbol).reverse()),
  });

  assert.deepEqual(input, untouched);
  assert.deepEqual(first, reordered);
  assert.equal(first.schemaVersion, TIER_A_TECHNICAL_SCAN_SCHEMA_VERSION);
  assert.equal(first.status, "complete");
  assert.match(first.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(first.cacheKey, `tier-a-technical-scan:${first.inputHash}`);
  assert.deepEqual(first.cards.map((card) => card.symbol), ["AAPL.US", "MSFT.US"]);
  assert.deepEqual(first.cards[0].memberships, ["holding", "watchlist"]);
  assert.equal(first.cards[0].status, "complete");
  assert.equal(first.cards[0].input.exactCutoff, true);
  assert.equal(first.cards[0].input.noForwardFill, true);
  assert.equal(first.cards[0].ema["169"].maturity, "mature");
  assert.equal(first.cards[0].weekly.status, "available");
  assert.equal(first.cards[0].costProfile14d28d.status, "complete");
  assert.equal(first.cards[0].capabilityMatrix.benchmarkRelativeStrength.status, "complete");
  assert.equal(first.cards[0].capabilityMatrix.sectorRelativeStrength.status, "complete");
  assert.deepEqual(first.cards[0].capabilityMatrix.anchoredVwap, {
    status: "unavailable",
    reasonCodes: ["explicit_anchor_required_batch_does_not_select_anchor"],
  });
  assert.deepEqual(first.cards[0].capabilityMatrix.optionsStructure, {
    status: "unavailable",
    reasonCodes: ["options_chain_not_supplied_batch_does_not_infer_positioning"],
  });
  assert.equal(first.cards[0].capabilityMatrix.tradingDecision.status, "not_applicable");
  assert.equal(first.method.llmUsed, false);
  assert.equal(first.method.automaticAnchoredVwap, false);
  assert.equal(first.method.optionsInference, false);
  assert.equal(first.method.tradingSignal, false);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.cards[0]), true);
});

test("derives the shared cutoff only from the completed QQQ terminal bar", () => {
  const target = calendarBars({ count: 30 });
  const qqq = calendarBars({ count: 30, base: 200 });
  const result = buildTierATechnicalBatchScan({
    holdings: ["AAPL.US"],
    dailyBySymbol: {
      "AAPL.US": dataset(target),
      "QQQ.US": dataset(qqq),
    },
  });

  assert.equal(result.cutoff, qqq.at(-1).tradeDate);
  assert.equal(result.cutoffSource, "benchmark_terminal_completed_bar");
  assert.equal(result.analysisTime, `${result.cutoff}T23:59:59.999Z`);

  assertCode(
    () => buildTierATechnicalBatchScan({
      holdings: ["AAPL.US"],
      dailyBySymbol: { "AAPL.US": dataset(target) },
    }),
    "cutoff_unavailable",
  );
});

test("uses an exact shared cutoff and never forward-fills a missing QQQ or target date", () => {
  const target = calendarBars({ count: 35 });
  const cutoff = target.at(-1).tradeDate;
  const qqqMissingCutoff = calendarBars({ count: 34, base: 200 });
  const degraded = buildTierATechnicalBatchScan({
    holdings: ["AAPL.US"],
    cutoff,
    dailyBySymbol: {
      "AAPL.US": dataset(target),
      "QQQ.US": dataset(qqqMissingCutoff),
    },
  });
  const degradedCard = degraded.cards[0];

  assert.equal(degradedCard.status, "degraded");
  assert.equal(degradedCard.benchmark.exactCutoff, false);
  assert.equal(degradedCard.capabilityMatrix.benchmarkRelativeStrength.status, "unavailable");
  assert.equal(degradedCard.metrics.qqqExcessReturns["1"].status, "unavailable");
  assert.equal(degradedCard.metrics.qqqExcessReturns["1"].value, null);
  assert.equal(degradedCard.metrics.qqqExcessReturns["1"].display, "N/A");
  assert.equal(
    degradedCard.metrics.qqqExcessReturns["1"].reason,
    "benchmark_exact_cutoff_unavailable",
  );
  assert.ok(degradedCard.degradedReasons.includes("benchmark_exact_cutoff_unavailable"));

  const targetMissingCutoff = target.slice(0, -1);
  const unavailable = buildTierATechnicalBatchScan({
    holdings: ["AAPL.US"],
    cutoff,
    dailyBySymbol: {
      "AAPL.US": dataset(targetMissingCutoff),
      "QQQ.US": dataset(target),
    },
  });
  assert.equal(unavailable.cards[0].status, "unavailable");
  assert.ok(unavailable.cards[0].degradedReasons.includes(
    "exact_cutoff_bar_missing_no_forward_fill",
  ));
});

test("an explicit historical cutoff excludes later values from the calculation hash", () => {
  const target = calendarBars({ count: 45 });
  const qqq = calendarBars({ count: 45, base: 200 });
  const cutoff = target[35].tradeDate;
  const first = buildTierATechnicalBatchScan({
    holdings: ["AAPL.US"],
    cutoff,
    dailyBySymbol: {
      "AAPL.US": dataset(target),
      "QQQ.US": dataset(qqq),
    },
  });
  const changedAfterCutoff = structuredClone(target);
  changedAfterCutoff[40].close += 30;
  changedAfterCutoff[40].high += 30;
  changedAfterCutoff[40].low += 30;
  changedAfterCutoff[40].open += 30;
  const second = buildTierATechnicalBatchScan({
    holdings: ["AAPL.US"],
    cutoff,
    dailyBySymbol: {
      "AAPL.US": dataset(changedAfterCutoff),
      "QQQ.US": dataset(qqq),
    },
  });

  assert.deepEqual(first, second);
  assert.equal(first.cards[0].input.ignoredAfterCutoffCount, 9);
});

test("missing numeric evidence remains N/A while an observed zero stays available", () => {
  const one = calendarBars({ count: 1 });
  const oneResult = buildTierATechnicalBatchScan({
    holdings: ["AAPL.US"],
    cutoff: one[0].tradeDate,
    dailyBySymbol: {
      "AAPL.US": dataset(one),
      "QQQ.US": dataset(one),
    },
  });
  assert.equal(oneResult.cards[0].metrics.returns["1"].value, null);
  assert.equal(oneResult.cards[0].metrics.returns["1"].display, "N/A");
  assert.equal(oneResult.cards[0].ema["21"].value, null);
  assert.equal(oneResult.cards[0].ema["21"].display, "N/A");
  assert.equal(oneResult.cards[0].structure.priceVsEma21, "N/A");
  assert.equal(oneResult.cards[0].observableState.priceVsEma21, "N/A");

  const identical = calendarBars({ count: 30 });
  const zeroResult = buildTierATechnicalBatchScan({
    holdings: ["AAPL.US"],
    dailyBySymbol: {
      "AAPL.US": dataset(identical),
      "QQQ.US": dataset(structuredClone(identical)),
    },
  });
  const zero = zeroResult.cards[0].metrics.qqqExcessReturns["20"];
  assert.equal(zero.status, "available");
  assert.equal(zero.value, 0);
  assert.equal(zero.display, null);
  assert.equal(zeroResult.cards[0].observableState.qqqExcess20State, "flat");
});

test("invalid, unattested, forming, unsorted, and oversized datasets fail per symbol", () => {
  const valid = calendarBars({ count: 30 });
  const forming = structuredClone(valid);
  forming.at(-1).complete = false;
  const unsorted = structuredClone(valid);
  [unsorted[3], unsorted[4]] = [unsorted[4], unsorted[3]];
  const oversized = calendarBars({ count: TIER_A_TECHNICAL_SCAN_MAX_BARS_PER_SYMBOL + 1 });
  const result = buildTierATechnicalBatchScan({
    holdings: ["ARRAY.US", "FORMING.US", "UNSORTED.US", "OVERSIZED.US"],
    cutoff: valid.at(-1).tradeDate,
    dailyBySymbol: {
      "ARRAY.US": valid,
      "FORMING.US": dataset(forming),
      "UNSORTED.US": dataset(unsorted),
      "OVERSIZED.US": dataset(oversized),
      "QQQ.US": dataset(valid),
    },
  });
  const bySymbol = Object.fromEntries(result.cards.map((card) => [card.symbol, card]));

  assert.ok(bySymbol["ARRAY.US"].degradedReasons.includes(
    "completed_bars_not_explicitly_attested",
  ));
  assert.ok(bySymbol["FORMING.US"].degradedReasons.includes("forming_bar_not_allowed"));
  assert.ok(bySymbol["UNSORTED.US"].degradedReasons.includes(
    "bars_not_strictly_ascending",
  ));
  assert.ok(bySymbol["OVERSIZED.US"].degradedReasons.includes("daily_bar_limit_exceeded"));
  assert.ok(result.cards.every((card) => card.status === "unavailable"));
});

test("bounds the universe deterministically with holdings before watchlist", () => {
  const bars = calendarBars({ count: 30 });
  const result = buildTierATechnicalBatchScan({
    holdings: ["C.US", "A.US", "B.US"],
    watchlist: ["E.US", "D.US", "A.US"],
    cutoff: bars.at(-1).tradeDate,
    maxSymbols: 3,
    dailyBySymbol: { "QQQ.US": dataset(bars) },
  });

  assert.deepEqual(result.coverage.selectedSymbols, ["A.US", "B.US", "C.US"]);
  assert.deepEqual(result.coverage.omittedSymbols, ["D.US", "E.US"]);
  assert.deepEqual(result.coverage.omittedHoldingSymbols, []);
  assert.deepEqual(result.coverage.omittedWatchlistSymbols, ["D.US", "E.US"]);
  assert.equal(result.limits.rankingLimit, 3);
  assert.equal(result.coverage.status, "unavailable");

  assertCode(
    () => buildTierATechnicalBatchScan({
      cutoff: bars.at(-1).tradeDate,
      maxSymbols: TIER_A_TECHNICAL_SCAN_HARD_MAX_SYMBOLS + 1,
      dailyBySymbol: { "QQQ.US": dataset(bars) },
    }),
    "max_symbols_invalid",
  );
});

test("compares only categorical observable states with the previous batch", () => {
  const target = calendarBars({ count: 45, base: 100, slope: 1 });
  const qqq = calendarBars({ count: 45, base: 200, slope: 0.2 });
  const previousCutoff = target[43].tradeDate;
  const previous = buildTierATechnicalBatchScan({
    holdings: ["AAPL.US"],
    cutoff: previousCutoff,
    dailyBySymbol: {
      "AAPL.US": dataset(target),
      "QQQ.US": dataset(qqq),
    },
  });
  const damaged = structuredClone(target);
  damaged[44] = {
    ...damaged[44],
    open: 55,
    high: 56,
    low: 49,
    close: 50,
    volume: 20_000,
  };
  const current = buildTierATechnicalBatchScan({
    holdings: ["AAPL.US"],
    cutoff: damaged[44].tradeDate,
    previousBatch: previous,
    dailyBySymbol: {
      "AAPL.US": dataset(damaged),
      "QQQ.US": dataset(qqq),
    },
  });
  const comparison = current.cards[0].comparison;

  assert.equal(current.comparison.status, "available");
  assert.equal(comparison.kind, "state_changed");
  assert.ok(comparison.changedFields.some(({ field }) => field === "priceVsEma21"));
  assert.ok(comparison.changedFields.every(({ field }) => !/return|price|volume/i.test(field)
    || field === "priceVsEma21"));
  assert.equal(current.rankings.changes.rows[0].symbol, "AAPL.US");
  assert.equal(current.rankings.changes.rows[0].observableOnly, true);

  const unchanged = buildTierATechnicalBatchScan({
    holdings: ["AAPL.US"],
    cutoff: previousCutoff,
    previousBatch: previous,
    dailyBySymbol: {
      "AAPL.US": dataset(target),
      "QQQ.US": dataset(qqq),
    },
  });
  assert.equal(unchanged.cards[0].comparison.kind, "unchanged");
  assert.deepEqual(unchanged.rankings.changes.rows, []);
});

test("reports new and removed universe members without treating them as market signals", () => {
  const bars = calendarBars({ count: 30 });
  const previous = buildTierATechnicalBatchScan({
    holdings: ["AAPL.US", "MSFT.US"],
    dailyBySymbol: {
      "AAPL.US": dataset(bars),
      "MSFT.US": dataset(bars),
      "QQQ.US": dataset(bars),
    },
  });
  const current = buildTierATechnicalBatchScan({
    holdings: ["AAPL.US", "NVDA.US"],
    previousBatch: previous,
    dailyBySymbol: {
      "AAPL.US": dataset(bars),
      "NVDA.US": dataset(bars),
      "QQQ.US": dataset(bars),
    },
  });

  assert.deepEqual(current.comparison.removedSymbols, ["MSFT.US"]);
  assert.equal(current.cards.find((card) => card.symbol === "NVDA.US").comparison.kind, "new_symbol");
  assert.equal(current.rankings.interpretation, "descriptive_observability_only_not_a_trading_signal");
});

test("ranks observable anomalies by disclosed data-quality and numeric evidence only", () => {
  const normal = calendarBars({ count: 40, base: 100 });
  const expanded = structuredClone(normal);
  expanded.at(-1).high = expanded.at(-1).close + 20;
  expanded.at(-1).low = expanded.at(-1).close - 20;
  expanded.at(-1).open = expanded.at(-1).close;
  const qqq = calendarBars({ count: 40, base: 200 });
  const result = buildTierATechnicalBatchScan({
    holdings: ["NORMAL.US", "EXPANDED.US"],
    dailyBySymbol: {
      "NORMAL.US": dataset(normal),
      "EXPANDED.US": dataset(expanded),
      "QQQ.US": dataset(qqq),
    },
  });

  assert.equal(result.rankings.anomalies.rows[0].symbol, "EXPANDED.US");
  assert.ok(
    result.rankings.anomalies.rows[0].normalizedTrueRangeAtr14
      > result.rankings.anomalies.rows[1].normalizedTrueRangeAtr14,
  );
  assert.equal(result.rankings.anomalies.rows[0].observableOnly, true);
  assert.ok(result.rankings.anomalies.sortBasis.includes("normalized_true_range_atr14_desc"));
});

test("passes caller coverage through the existing market-evidence contract deterministically", () => {
  const bars = weekdayBarsEnding("2026-08-31", 30);
  const cutoff = bars.at(-1).tradeDate;
  const analysisTime = "2026-08-31T22:00:00.000Z";
  const coverage = {
    source: "live",
    originSource: "live",
    endpoint: "fixture://daily",
    fetchedAt: analysisTime,
    cacheAgeMs: 0,
    latestTradeDate: cutoff,
    complete: true,
    partialReasons: [],
  };
  const result = buildTierATechnicalBatchScan({
    holdings: ["AAPL.US"],
    cutoff,
    analysisTime,
    dailyBySymbol: {
      "AAPL.US": dataset(bars, { coverage }),
      "QQQ.US": dataset(structuredClone(bars), { coverage }),
    },
  });

  assert.equal(result.cards[0].marketEvidence.status, "sizing_ready");
  assert.equal(result.cards[0].marketEvidence.latestTradeDate, cutoff);
  assert.equal(result.cards[0].capabilityMatrix.marketEvidence.status, "complete");
  assert.equal(result.analysisTime, analysisTime);
});

test("rejects invalid top-level bounds, symbols, and future previous comparisons", () => {
  const bars = calendarBars({ count: 30 });
  assertCode(
    () => buildTierATechnicalBatchScan({
      holdings: "AAPL.US",
      cutoff: bars.at(-1).tradeDate,
      dailyBySymbol: { "QQQ.US": dataset(bars) },
    }),
    "holdings_not_array",
  );
  assertCode(
    () => buildTierATechnicalBatchScan({
      holdings: ["bad symbol"],
      cutoff: bars.at(-1).tradeDate,
      dailyBySymbol: { "QQQ.US": dataset(bars) },
    }),
    "symbol_invalid",
  );

  const future = buildTierATechnicalBatchScan({
    holdings: ["AAPL.US"],
    dailyBySymbol: {
      "AAPL.US": dataset(bars),
      "QQQ.US": dataset(bars),
    },
  });
  const earlierCutoff = bars.at(-2).tradeDate;
  const current = buildTierATechnicalBatchScan({
    holdings: ["AAPL.US"],
    cutoff: earlierCutoff,
    previousBatch: future,
    dailyBySymbol: {
      "AAPL.US": dataset(bars),
      "QQQ.US": dataset(bars),
    },
  });
  assert.equal(current.comparison.status, "unavailable");
  assert.deepEqual(current.comparison.reasonCodes, ["previous_batch_cutoff_after_current"]);
  assert.equal(current.cards[0].comparison.status, "not_compared");
});

function weekdayBarsEnding(end, count) {
  const dates = [];
  const date = new Date(`${end}T00:00:00.000Z`);
  while (dates.length < count) {
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return dates.reverse().map((tradeDate, index) => {
    const close = 100 + index * 0.25;
    return {
      tradeDate,
      open: close - 0.25,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000 + index * 10,
      isClosed: true,
    };
  });
}

function assertCode(operation, code) {
  assert.throws(
    operation,
    (error) => error instanceof TierATechnicalScanInputError && error.code === code,
  );
}
