import test from "node:test";
import assert from "node:assert/strict";
import "../renderer/radar-view.js";
const { radarChanges, radarHasGap, radarVisibleCards, radarFieldLabel, radarStateLabel, radarInteger, radarEmaNote } = globalThis.CockpitRadarView;

const cards = [
  { symbol: "AAPL.US", status: "complete", comparison: { kind: "unchanged" } },
  { symbol: "MU.US", status: "partial", degradedReasons: ["weekly_structure_incomplete"], comparison: { kind: "state_changed", changedFields: [{ field: "priceVsEma21", from: "above", to: "below" }] } },
  { symbol: "NVDA.US", status: "complete", comparison: { kind: "new_symbol" } },
];
test("radar views only filter and prioritize existing changes without mutating evidence", () => {
  const before = JSON.stringify(cards);
  assert.deepEqual(radarVisibleCards(cards).map((c) => c.symbol), ["MU.US", "NVDA.US", "AAPL.US"]);
  assert.deepEqual(radarVisibleCards(cards, { filter: "changed" }).map((c) => c.symbol), ["MU.US", "NVDA.US"]);
  assert.deepEqual(radarVisibleCards(cards, { filter: "gaps", query: "mu" }).map((c) => c.symbol), ["MU.US"]);
  assert.equal(JSON.stringify(cards), before);
});
test("card-level comparison is retained when the ranking list is truncated", () => {
  assert.equal(radarChanges(cards[1], new Map()).kind, "state_changed");
  assert.equal(radarHasGap(cards[1]), true); assert.equal(radarHasGap(cards[0]), false);
  assert.equal(radarFieldLabel("priceVsEma21"), "价格 / EMA21");
  assert.equal(radarStateLabel("compression_inside_28"), "14日价值区在28日区间内收窄");
  assert.equal(radarStateLabel("accepted_below"), "连续收盘在价值区下方");
  assert.equal(radarStateLabel("future_unknown_state"), "future_unknown_state", "unknown states are not invented");
});
test("missing coverage never becomes a fabricated zero", () => {
  for (const n of [null, undefined, true, "", " ", -1, 1.5]) assert.equal(radarInteger(n), null);
  assert.equal(radarInteger(0), 0); assert.equal(radarInteger("9"), 9);
});
test("EMA presentation preserves the host maturity warning", () => {
  assert.equal(radarEmaNote({ status: "available", maturity: "mature" }), "");
  assert.equal(radarEmaNote({ status: "available", maturity: "warming" }), "预热中");
  assert.equal(radarEmaNote({ status: "available" }), "成熟度未知");
  assert.equal(radarEmaNote({ status: "unavailable" }), "");
});
