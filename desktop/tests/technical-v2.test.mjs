import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCostConcentrationStructure,
  aggregateCompletedDailyBarsToWeeks,
  buildExecution60mStructure,
  buildTechnicalV2,
  buildWeeklyStructure,
} from "../src/engine/technical-v2.mjs";

function bars({ count, start = "2026-01-05T14:30:00.000Z", stepMs, trend = 1 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * trend;
    return {
      timestamp: new Date(new Date(start).getTime() + index * stepMs).toISOString(),
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000 + index,
    };
  });
}

test("v2 capability matrix does not invent weekly or 60m evidence", () => {
  const result = buildTechnicalV2({ horizon: "swing" });
  assert.equal(result.status, "degraded");
  assert.equal(result.weekly.status, "unavailable");
  assert.equal(result.execution60m.status, "unavailable");
  assert.deepEqual(result.capabilityMatrix.weeklyStructure.reasonCodes, ["input_not_provided"]);
  assert.equal(result.capabilityMatrix.execution60m.requiredForSpecifiedHorizon, true);
  assert.ok(result.limitations.some((item) => item.layer === "execution60m"));
  assert.equal(result.costProfile14d28d.status, "unavailable");
  assert.equal(result.capabilityMatrix.costProfile14d28d.status, "unavailable");
});

test("v2 attaches a low-confidence 14/28 daily cost proxy without calling it holder cost", () => {
  const dailyBars = bars({ count: 40, stepMs: 86_400_000 }).map((bar) => ({
    ...bar,
    tradeDate: bar.timestamp.slice(0, 10),
    isClosed: true,
  }));
  const result = buildTechnicalV2({
    dailyCompletedBars: dailyBars,
    horizon: "position",
  });
  assert.equal(result.schemaVersion, "technical-v2/v2");
  assert.equal(result.capabilityMatrix.costProfile14d28d.status, "complete");
  assert.equal(result.costProfile14d28d.status, "complete");
  assert.equal(result.costProfile14d28d.profiles["14"].confidence, "low");
  assert.equal(result.costProfile14d28d.profiles["28"].estimateNotHolderCostBasis, true);
  assert.equal(result.costProfile14d28d.comparison.sameCutoffVerified, true);
  assert.doesNotMatch(JSON.stringify(result.costProfile14d28d).toLowerCase(), /institutional|chip/);
});

test("cost concentration integration degrades instead of throwing on invalid daily volume", () => {
  const dailyBars = bars({ count: 40, stepMs: 86_400_000 }).map((bar) => ({
    ...bar,
    tradeDate: bar.timestamp.slice(0, 10),
  }));
  dailyBars.at(-2).volume = null;
  const result = buildCostConcentrationStructure(dailyBars);
  assert.equal(result.capability.status, "unavailable");
  assert.ok(result.capability.reasonCodes.includes("number_missing"));
  assert.equal(result.structure.status, "unavailable");
});

test("weekly contract compresses an explicit completed weekly series deterministically", () => {
  const weeklyBars = bars({ count: 16, stepMs: 7 * 86_400_000 });
  const result = buildWeeklyStructure({
    weekly: {
      bars: weeklyBars,
      interval: "1W",
      completedBarsOnly: true,
      source: "longbridge_weekly",
      fetchedAt: "2026-08-31T21:00:00.000Z",
    },
  });
  assert.equal(result.capability.status, "complete");
  assert.equal(result.structure.status, "available");
  assert.equal(result.structure.direction, "advancing");
  assert.equal(result.structure.swing, "higher_high_higher_low");
  assert.equal(result.structure.metrics.return4WeeksPercent, 3.604);
  assert.equal(result.structure.input.source, "longbridge_weekly");
});

test("daily-to-week aggregation excludes terminal week rather than calling it closed", () => {
  const daily = bars({ count: 20, stepMs: 86_400_000 });
  const aggregate = aggregateCompletedDailyBarsToWeeks(daily);
  assert.equal(aggregate.terminalWeekExcluded, true);
  assert.ok(aggregate.bars.length < 4);
  const weekly = buildWeeklyStructure({ dailyCompletedBars: daily });
  assert.equal(weekly.capability.status, "warming");
  assert.ok(weekly.capability.reasonCodes.includes("terminal_week_excluded_until_confirmed"));
  assert.ok(weekly.capability.reasonCodes.includes("insufficient_weekly_history"));
});

test("60m card uses only completed, explicitly attested 60m bars", () => {
  const intraday = bars({ count: 22, start: "2026-08-03T13:30:00.000Z", stepMs: 60 * 60_000 });
  intraday.at(-1).isClosed = false;
  const result = buildExecution60mStructure({
    bars: intraday,
    intervalMinutes: 60,
    completedBarsOnly: true,
    source: "longbridge_60m",
  });
  assert.equal(result.capability.status, "complete");
  assert.ok(result.capability.reasonCodes.includes("forming_bars_excluded"));
  assert.equal(result.structure.status, "available");
  assert.equal(result.structure.input.completedBarCount, 21);
  assert.equal(result.structure.executionState, "bullish_ribbon");
  assert.equal(result.structure.ema[21].value, 110);
});

test("60m contract refuses a mismatched interval or an unattested completed-bar claim", () => {
  const input = bars({ count: 30, stepMs: 60 * 60_000 });
  const wrongInterval = buildExecution60mStructure({
    bars: input,
    interval: "15m",
    completedBarsOnly: true,
  });
  assert.equal(wrongInterval.capability.status, "unavailable");
  assert.ok(wrongInterval.capability.reasonCodes.includes("declared_interval_mismatch"));

  const noAttestation = buildExecution60mStructure({ bars: input, interval: "60m" });
  assert.equal(noAttestation.capability.status, "unavailable");
  assert.equal(noAttestation.capability.barCount, 30);
  assert.ok(noAttestation.capability.reasonCodes.includes("completed_bars_not_explicitly_attested"));
});

test("v2 never converts missing OHLCV values into numeric zero", () => {
  const hourly = bars({ count: 30, stepMs: 60 * 60 * 1000 });
  hourly[4].volume = null;
  const result = buildExecution60mStructure({
    bars: hourly,
    interval: "60m",
    completedBarsOnly: true,
    source: "test",
  });
  assert.equal(result.capability.status, "unavailable");
  assert.ok(result.capability.reasonCodes.includes("bar_number_missing"));
});

test("v2 envelope keeps a 60m omission visible even with usable weekly context", () => {
  const result = buildTechnicalV2({
    horizon: "position",
    weekly: {
      bars: bars({ count: 16, stepMs: 7 * 86_400_000 }),
      interval: "1W",
      completedBarsOnly: true,
    },
  });
  assert.equal(result.status, "partial");
  assert.equal(result.capabilityMatrix.weeklyStructure.status, "complete");
  assert.equal(result.capabilityMatrix.execution60m.status, "unavailable");
  assert.equal(result.capabilityMatrix.execution60m.requiredForSpecifiedHorizon, false);
});
