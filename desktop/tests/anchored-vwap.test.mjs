import assert from "node:assert/strict";
import test from "node:test";

import {
  ANCHORED_VWAP_METHOD_VERSION,
  ANCHORED_VWAP_SCHEMA_VERSION,
  AnchoredVwapInputError,
  buildAnchoredVwapEvidence,
} from "../src/engine/anchored-vwap.mjs";

function completedBars() {
  return [
    bar("b1", "2026-08-03T20:00:00.000Z", 10, 100),
    bar("b2", "2026-08-04T20:00:00.000Z", 12, 200),
    bar("b3", "2026-08-05T20:00:00.000Z", 14, 300),
  ];
}

function bar(barId, timestamp, close, volume) {
  return {
    barId,
    timestamp,
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume,
    isClosed: true,
  };
}

function build(overrides = {}) {
  return buildAnchoredVwapEvidence({
    bars: completedBars(),
    completedBarsOnly: true,
    anchor: {
      barId: "b2",
      reason: "财报缺口后的首个完整交易日",
      source: "用户在 TradingView 明确选择",
    },
    ...overrides,
  });
}

test("calculates inclusive HLC3 volume-weighted AVWAP from an explicit barId anchor", () => {
  const input = completedBars();
  const untouched = structuredClone(input);
  const result = buildAnchoredVwapEvidence({
    bars: input,
    completedBarsOnly: true,
    anchor: {
      barId: "b2",
      reason: "财报缺口后的首个完整交易日",
      source: "用户在 TradingView 明确选择",
    },
  });

  assert.deepEqual(input, untouched);
  assert.equal(result.schemaVersion, ANCHORED_VWAP_SCHEMA_VERSION);
  assert.equal(result.methodVersion, ANCHORED_VWAP_METHOD_VERSION);
  assert.equal(result.status, "available");
  assert.match(result.inputHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.anchor, {
    barId: "b2",
    timestamp: "2026-08-04T20:00:00.000Z",
    reason: "财报缺口后的首个完整交易日",
    source: "用户在 TradingView 明确选择",
    matchedBy: "barId",
  });
  assert.deepEqual(result.asOf, {
    barId: "b3",
    timestamp: "2026-08-05T20:00:00.000Z",
    matchedBy: "terminal_completed_bar",
  });
  assert.equal(result.barCount, 2);
  assert.equal(result.cumulativeVolume, 500);
  assert.ok(Math.abs(result.vwap - 13.2) < 1e-12);
  assert.equal(result.asOfClose, 14);
  assert.equal(result.priceRelation.state, "above");
  assert.ok(Math.abs(result.priceRelation.difference - 0.8) < 1e-12);
  assert.ok(Math.abs(result.priceRelation.differencePercent - (0.8 / 13.2 * 100)) < 1e-12);
  assert.equal(result.method.typicalPrice, "HLC3");
  assert.equal(result.method.anchorSelection, "caller_explicit_only");
  assert.equal(result.advisory, true);
  assert.equal(result.decisionAuthority, "LLM");
  assert.ok(result.limitations.some((item) => /does not select/.test(item)));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.anchor), true);
});

test("supports exact timestamp anchors and explicit inclusive asOf cutoffs", () => {
  const result = build({
    anchor: {
      timestamp: "2026-08-04T20:00:00Z",
      reason: "用户选择的突破确认时点",
      source: "用户输入",
    },
    asOf: { timestamp: "2026-08-04T20:00:00.000Z" },
  });

  assert.equal(result.anchor.matchedBy, "timestamp");
  assert.equal(result.asOf.matchedBy, "timestamp");
  assert.equal(result.barCount, 1);
  assert.equal(result.vwap, 12);
  assert.equal(result.asOfClose, 12);
  assert.equal(result.priceRelation.state, "at");
  assert.equal(result.priceRelation.difference, 0);
  assert.equal(result.priceRelation.differencePercent, 0);

  const both = build({
    anchor: {
      barId: "b2",
      timestamp: "2026-08-04T20:00:00.000Z",
      reason: "双重身份核验",
      source: "用户输入",
    },
    asOf: { barId: "b3", timestamp: "2026-08-05T20:00:00Z" },
  });
  assert.equal(both.anchor.matchedBy, "barId_and_timestamp");
  assert.equal(both.asOf.matchedBy, "barId_and_timestamp");
});

test("never selects an anchor and requires identity, reason, and source", () => {
  assertCode(
    () => build({ anchor: null }),
    "anchor_invalid",
  );
  assertCode(
    () => build({ anchor: { reason: "缺少身份", source: "用户" } }),
    "anchor_identity_missing",
  );
  assertCode(
    () => build({ anchor: { barId: "b2", source: "用户" } }),
    "anchor_reason_missing",
  );
  assertCode(
    () => build({ anchor: { barId: "b2", reason: "事件" } }),
    "anchor_source_missing",
  );
});

test("fails closed when anchor or cutoff identities do not resolve exactly", () => {
  assertCode(
    () => build({
      anchor: { barId: "missing", reason: "事件", source: "用户" },
    }),
    "anchor_not_found",
  );
  assertCode(
    () => build({ asOf: { barId: "missing" } }),
    "as_of_not_found",
  );
  assertCode(
    () => build({
      anchor: {
        barId: "b2",
        timestamp: "2026-08-05T20:00:00.000Z",
        reason: "冲突身份",
        source: "用户",
      },
    }),
    "anchor_identity_conflict",
  );
  assertCode(
    () => build({
      anchor: { barId: "b3", reason: "较晚锚点", source: "用户" },
      asOf: { barId: "b2" },
    }),
    "as_of_before_anchor",
  );
});

test("requires an explicit completed-bars attestation and rejects a terminal forming bar", () => {
  assertCode(
    () => buildAnchoredVwapEvidence({
      bars: completedBars(),
      anchor: { barId: "b1", reason: "事件", source: "用户" },
    }),
    "completed_bars_not_explicitly_attested",
  );

  const bars = completedBars();
  bars.at(-1).isClosed = false;
  assertCode(
    () => build({ bars }),
    "terminal_bar_forming",
  );

  const terminalFinalFlag = completedBars();
  terminalFinalFlag.at(-1).final = false;
  assertCode(
    () => build({ bars: terminalFinalFlag }),
    "terminal_bar_forming",
  );

  const midForming = completedBars();
  midForming[1].status = "forming";
  assertCode(
    () => build({ bars: midForming }),
    "forming_bar_not_allowed",
  );
});

test("fails closed on zero or negative volume rather than imputing a weight", () => {
  const zero = completedBars();
  zero[1].volume = 0;
  assertCode(() => build({ bars: zero }), "zero_volume_bar");

  const negative = completedBars();
  negative[1].volume = -1;
  assertCode(() => build({ bars: negative }), "negative_volume");
});

test("rejects unsorted timestamps, duplicate IDs, invalid OHLC, and missing numeric values", () => {
  const unsorted = completedBars();
  [unsorted[1], unsorted[2]] = [unsorted[2], unsorted[1]];
  assertCode(() => build({ bars: unsorted }), "bars_not_strictly_ascending");

  const duplicateTime = completedBars();
  duplicateTime[2].timestamp = duplicateTime[1].timestamp;
  assertCode(() => build({ bars: duplicateTime }), "bars_not_strictly_ascending");

  const duplicateId = completedBars();
  duplicateId[2].barId = duplicateId[1].barId;
  assertCode(() => build({ bars: duplicateId }), "duplicate_bar_id");

  const invalidOhlc = completedBars();
  invalidOhlc[1].close = invalidOhlc[1].high + 1;
  assertCode(() => build({ bars: invalidOhlc }), "invalid_ohlc_relationship");

  const missing = completedBars();
  missing[1].volume = null;
  assertCode(() => build({ bars: missing }), "numeric_field_missing");
});

test("input hash is stable, excludes bars after an explicit cutoff, and binds anchor provenance", () => {
  const first = build({ asOf: { barId: "b2" } });
  const second = build({ asOf: { barId: "b2" }, bars: structuredClone(completedBars()) });
  assert.equal(first.inputHash, second.inputHash);

  const laterBarChanged = completedBars();
  laterBarChanged[2].volume += 999;
  const unchangedHistorical = build({ asOf: { barId: "b2" }, bars: laterBarChanged });
  assert.equal(first.inputHash, unchangedHistorical.inputHash);

  const selectedBarChanged = completedBars();
  selectedBarChanged[1].volume += 1;
  const changedCalculation = build({ asOf: { barId: "b2" }, bars: selectedBarChanged });
  assert.notEqual(first.inputHash, changedCalculation.inputHash);

  const changedReason = build({
    asOf: { barId: "b2" },
    anchor: {
      barId: "b2",
      reason: "不同但仍由调用方明确给出的原因",
      source: "用户在 TradingView 明确选择",
    },
  });
  assert.notEqual(first.inputHash, changedReason.inputHash);
});

function assertCode(operation, code) {
  assert.throws(
    operation,
    (error) => error instanceof AnchoredVwapInputError && error.code === code,
  );
}
