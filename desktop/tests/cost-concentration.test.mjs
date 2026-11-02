import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDailyCostConcentration,
  CostConcentrationInputError,
} from "../src/engine/cost-concentration.mjs";

function dailyBars(count = 28, { trend = 1 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * trend;
    const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
    return {
      tradeDate: date,
      timestamp: `${date}T21:00:00.000Z`,
      open: close - 0.5,
      high: close + 1.5,
      low: close - 1.5,
      close,
      volume: 1_000 + index * 10,
    };
  });
}

test("daily 14/28 cost concentration exposes full estimate provenance and same cutoff", () => {
  const bars = dailyBars();
  const result = buildDailyCostConcentration({
    bars,
    completedThroughTradeDate: bars.at(-1).tradeDate,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.methodVersion, "daily-cost-concentration-v1");
  assert.equal(result.configuration.bins, 80);
  assert.equal(result.configuration.allocationMethod, "uniform_range");
  assert.equal(result.configuration.valueAreaFraction, 0.7);
  assert.equal(result.configuration.densePercentile, 0.75);
  assert.equal(result.input.sameCutoffVerified, true);
  assert.match(result.input.inputHash, /^[a-f0-9]{64}$/);
  for (const profile of Object.values(result.profiles)) {
    assert.equal(profile.status, "available");
    assert.equal(profile.inputResolution, "daily_single_bar");
    assert.equal(profile.confidence, "low");
    assert.equal(profile.estimateNotHolderCostBasis, true);
    assert.equal(profile.endTradeDate, bars.at(-1).tradeDate);
    assert.equal(profile.sameCutoffVerified, true);
    assert.ok(profile.poc >= profile.val && profile.poc <= profile.vah);
    assert.ok(profile.denseZones.length > 0);
    assert.ok(Array.isArray(profile.hvn));
    assert.ok(Array.isArray(profile.lvn));
    assert.ok(profile.acceptance.state);
  }
  assert.equal(result.comparison.status, "available");
  assert.equal(result.comparison.sameCutoffVerified, true);
  assert.ok(["upward", "downward", "overlapping", "compression_inside_28", "new_regime_outside_28"].includes(result.comparison.migrationState));
  assert.ok(result.limitations.includes("estimate_not_holder_cost_basis"));
  assert.doesNotMatch(JSON.stringify(result).toLowerCase(), /institutional|chip/);
});

test("input hash and profile output are deterministic for identical completed daily bars", () => {
  const bars = dailyBars();
  const input = { bars, completedThroughTradeDate: bars.at(-1).tradeDate };
  const left = buildDailyCostConcentration(input);
  const right = buildDailyCostConcentration(structuredClone(input));
  assert.deepEqual(left, right);
  const changed = structuredClone(input);
  changed.bars[10].volume += 1;
  assert.notEqual(buildDailyCostConcentration(changed).input.inputHash, left.input.inputHash);
});

test("14 sessions is partial evidence and never fabricates 28-session migration", () => {
  const bars = dailyBars(14);
  const result = buildDailyCostConcentration({
    bars,
    completedThroughTradeDate: bars.at(-1).tradeDate,
  });
  assert.equal(result.status, "partial");
  assert.equal(result.profiles["14"].status, "available");
  assert.equal(result.profiles["28"].status, "unavailable");
  assert.equal(result.profiles["28"].reasonCode, "insufficient_completed_sessions");
  assert.equal(result.comparison.status, "unavailable");
});

test("completed cutoff contract rejects a mismatched endpoint and an explicitly forming current day", () => {
  const bars = dailyBars();
  assert.throws(
    () => buildDailyCostConcentration({
      bars,
      completedThroughTradeDate: bars.at(-2).tradeDate,
    }),
    (error) => error instanceof CostConcentrationInputError && error.code === "completed_through_mismatch",
  );
  const forming = structuredClone(bars);
  forming.at(-1).isClosed = false;
  assert.throws(
    () => buildDailyCostConcentration({
      bars: forming,
      completedThroughTradeDate: forming.at(-1).tradeDate,
    }),
    (error) => error instanceof CostConcentrationInputError && error.code === "forming_bar_not_allowed",
  );
});

test("acceptance retains last three completed daily closes only", () => {
  const bars = dailyBars();
  const result = buildDailyCostConcentration({
    bars,
    completedThroughTradeDate: bars.at(-1).tradeDate,
  });
  for (const profile of Object.values(result.profiles)) {
    assert.equal(profile.acceptance.lookbackSessions, 3);
    assert.equal(profile.acceptance.recentSessionCloses.length, 3);
    assert.equal(profile.acceptance.recentCloseLocations.length, 3);
  }
});

test("missing volume remains unavailable input instead of becoming numeric zero", () => {
  const bars = dailyBars();
  bars[4].volume = null;
  assert.throws(
    () => buildDailyCostConcentration({
      bars,
      completedThroughTradeDate: bars.at(-1).tradeDate,
    }),
    (error) => error instanceof CostConcentrationInputError && error.code === "number_missing",
  );
});
