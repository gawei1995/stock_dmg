import assert from "node:assert/strict";
import test from "node:test";

import {
  DAILY_SEQUENCE_METHOD_VERSION,
  DailySequenceInputError,
  buildDailySequence,
  calculateDailyExcessReturns,
} from "../src/engine/daily-sequence.mjs";

function ascendingBars(count = 21, {
  closeStart = 100,
  closeStep = 1,
  volumeStart = 1_000,
  volumeStep = 10,
} = {}) {
  return Array.from({ length: count }, (_, index) => {
    const close = closeStart + index * closeStep;
    return {
      tradeDate: `2026-01-${String(index + 1).padStart(2, "0")}`,
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: volumeStart + index * volumeStep,
      isClosed: true,
    };
  });
}

test("builds a complete daily sequence card with explicit units and provenance", () => {
  const bars = ascendingBars();
  const result = buildDailySequence(bars);

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.methodVersion, DAILY_SEQUENCE_METHOD_VERSION);
  assert.equal(result.methodVersion, "daily-sequence-v2");
  assert.equal(result.status, "complete");
  assert.match(result.inputHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.input, {
    observationCount: 21,
    startAt: "2026-01-01",
    endAt: "2026-01-21",
    order: "ascending",
    completedBarsAssumed: true,
    priceAdjustment: "caller_supplied",
    tradeSession: "caller_supplied",
  });

  assert.equal(result.metrics.returns["1"].status, "available");
  assert.equal(result.metrics.returns["1"].unit, "percent_point");
  assert.ok(Math.abs(result.metrics.returns["1"].value - ((120 / 119 - 1) * 100)) < 1e-12);
  assert.ok(Math.abs(result.metrics.returns["20"].value - 20) < 1e-12);
  assert.equal(result.metrics.closeLocationValue.value, 0);
  assert.equal(result.metrics.trueRange.value, 2);
  assert.equal(result.metrics.priorAtr14.value, 2);
  assert.equal(result.metrics.normalizedTrueRangeAtr14.value, 1);
  assert.ok(Math.abs(result.metrics.gapPercent.value - ((119.5 - 119) / 119) * 100) < 1e-12);
  assert.ok(Math.abs(result.metrics.relativeVolume20.value - (1_200 / 1_095)) < 1e-12);
  assert.equal(result.metrics.directionalEfficiency["10"].value, 1);
  assert.equal(result.metrics.directionalEfficiency["20"].value, 1);
});

test("insufficient history returns explicit unavailable metrics and never imputes zero", () => {
  const result = buildDailySequence(ascendingBars(1));

  assert.equal(result.status, "partial");
  assert.equal(result.metrics.closeLocationValue.status, "available");
  for (const metric of [
    result.metrics.returns["1"],
    result.metrics.trueRange,
    result.metrics.priorAtr14,
    result.metrics.normalizedTrueRangeAtr14,
    result.metrics.gapPercent,
    result.metrics.relativeVolume20,
    result.metrics.directionalEfficiency["10"],
  ]) {
    assert.equal(metric.status, "unavailable");
    assert.equal(metric.value, null);
    assert.ok(metric.reason);
  }

  const empty = buildDailySequence([]);
  assert.equal(empty.status, "unavailable");
  assert.equal(empty.metrics.closeLocationValue.value, null);
  assert.equal(empty.metrics.closeLocationValue.reason, "no_observations");
});

test("zero denominators are unavailable while valid numeric zero remains observable", () => {
  const bars = ascendingBars(21, { closeStart: 100, closeStep: 0, volumeStart: 0, volumeStep: 0 })
    .map((bar) => ({ ...bar, open: 100, high: 100, low: 100, close: 100 }));
  const result = buildDailySequence(bars);

  assert.equal(result.metrics.returns["20"].status, "available");
  assert.equal(result.metrics.returns["20"].value, 0);
  assert.equal(result.metrics.closeLocationValue.status, "unavailable");
  assert.equal(result.metrics.closeLocationValue.reason, "zero_session_range");
  assert.equal(result.metrics.priorAtr14.status, "available");
  assert.equal(result.metrics.priorAtr14.value, 0);
  assert.equal(result.metrics.normalizedTrueRangeAtr14.status, "unavailable");
  assert.equal(result.metrics.normalizedTrueRangeAtr14.reason, "prior_atr14_is_zero");
  assert.equal(result.metrics.relativeVolume20.status, "unavailable");
  assert.equal(result.metrics.relativeVolume20.reason, "prior_volume_mean_is_zero");
  assert.equal(result.metrics.directionalEfficiency["20"].status, "unavailable");
  assert.equal(result.metrics.directionalEfficiency["20"].reason, "zero_price_travel");
});

test("input hash is deterministic and changes when an OHLCV value changes", () => {
  const bars = ascendingBars();
  const first = buildDailySequence(bars);
  const second = buildDailySequence(structuredClone(bars));
  const changed = structuredClone(bars);
  changed.at(-1).volume += 1;
  const third = buildDailySequence(changed);

  assert.equal(first.inputHash, second.inputHash);
  assert.notEqual(first.inputHash, third.inputHash);
});

test("validates strict ascending order, OHLC bounds, finite values, and forming bars", () => {
  const unsorted = ascendingBars(3);
  [unsorted[1], unsorted[2]] = [unsorted[2], unsorted[1]];
  assert.throws(
    () => buildDailySequence(unsorted),
    (error) => error instanceof DailySequenceInputError
      && error.code === "bars_not_strictly_ascending",
  );

  const invalidBounds = ascendingBars(3);
  invalidBounds[1].high = invalidBounds[1].low - 1;
  assert.throws(
    () => buildDailySequence(invalidBounds),
    (error) => error.code === "invalid_ohlc_relationship",
  );

  const missingVolume = ascendingBars(3);
  missingVolume[1].volume = null;
  assert.throws(
    () => buildDailySequence(missingVolume),
    (error) => error.code === "numeric_field_missing",
  );

  const forming = ascendingBars(3);
  forming[2].isClosed = false;
  assert.throws(
    () => buildDailySequence(forming),
    (error) => error.code === "forming_bar_not_allowed",
  );
});

test("calculates same-date target excess returns without filling missing benchmark dates", () => {
  const target = ascendingBars(21, { closeStart: 100, closeStep: 1 });
  const benchmark = ascendingBars(21, { closeStart: 200, closeStep: 1 });
  const result = calculateDailyExcessReturns(target, benchmark);

  assert.equal(result.status, "complete");
  assert.equal(result.calculation, "same_date_simple_excess_return");
  assert.match(result.inputHash, /^[a-f0-9]{64}$/);
  const expected20 = ((120 / 100) - 1) * 100 - ((220 / 200) - 1) * 100;
  assert.ok(Math.abs(result.windows["20"].value - expected20) < 1e-12);
  assert.equal(result.windows["20"].unit, "percent_point");
  assert.equal(result.windows["20"].startAt, "2026-01-01");
  assert.equal(result.windows["20"].endAt, "2026-01-21");

  const missingDate = benchmark.filter((bar) => bar.tradeDate !== "2026-01-11");
  const partial = calculateDailyExcessReturns(target, missingDate);
  assert.equal(partial.status, "partial");
  assert.equal(partial.windows["10"].status, "unavailable");
  assert.equal(partial.windows["10"].value, null);
  assert.equal(partial.windows["10"].reason, "benchmark_start_date_missing");
  assert.equal(partial.windows["20"].status, "available");
});

test("accepts timestamp identities when exchange trade dates are unavailable", () => {
  const bars = ascendingBars(2).map(({ tradeDate, ...bar }, index) => ({
    ...bar,
    timestamp: new Date(Date.UTC(2026, 0, index + 1, 21)).toISOString(),
  }));
  const result = buildDailySequence(bars);

  assert.equal(result.input.startAt, "2026-01-01T21:00:00.000Z");
  assert.equal(result.input.endAt, "2026-01-02T21:00:00.000Z");
  assert.equal(result.metrics.returns["1"].status, "available");
});
