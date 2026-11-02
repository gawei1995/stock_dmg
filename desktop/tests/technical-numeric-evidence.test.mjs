import assert from "node:assert/strict";
import test from "node:test";

import { appendTechnicalNumericEvidence } from "../src/engine/technical-numeric-evidence.mjs";
import { createObservedFact, validateNumericEvidence } from "../src/engine/numeric-evidence.mjs";

function basePackage() {
  const close = createObservedFact({
    factId: "market.last_completed_close.test.us@2026-08-31T20:00:00.000Z",
    metric: "market.last_completed_close",
    value: 110,
    availability: "known",
    unit: { kind: "price", currency: "USD", symbol: "TEST.US", tickSize: null },
    asOf: {
      effectiveAt: "2026-08-31T20:00:00.000Z",
      retrievedAt: "2026-08-31T20:01:00.000Z",
      tradingDate: "2026-08-31",
      session: "regular",
      timeZone: "UTC",
    },
    provenance: {
      source: "test",
      tool: "test",
      sourceRecordId: null,
      rawFields: ["close"],
      inputRefs: [],
      formula: null,
      methodVersion: "test/v1",
    },
    quality: {
      freshness: "fresh",
      ageMs: 1_000,
      complete: true,
      confidence: "not_applicable",
      reasonCodes: [],
    },
    display: { precision: 2, label: "Close" },
  });
  return {
    packageVersion: "core-numeric-evidence/v1",
    schemaVersion: "numeric-evidence/v1",
    status: "complete",
    facts: [close],
    factCount: 1,
    knownCount: 1,
    invariants: { unknownIsNeverZero: true },
  };
}

function technicalFixture() {
  const profile = (window, poc, val, vah) => ({
    status: "available",
    windowSessions: window,
    poc,
    val,
    vah,
    confidence: "low",
    estimateNotHolderCostBasis: true,
  });
  return {
    ema: { 3: 108, 21: 101, 144: null },
    emaMaturity: { 3: { mature: true }, 21: { mature: true }, 144: { mature: false } },
    emaMethod: { methodVersion: "ema-sma-seed/v1" },
    dailySequence: { inputHash: "daily-hash" },
    fib: {
      anchors: {
        a: { price: 80 }, b: { price: 120 }, c: { price: 90 },
      },
      levels: { "0.382": 105.28, "0.618": 114.72, "1": 130, "1.618": 154.72 },
    },
    benchmarkRelativeStrength: {
      status: "complete",
      excessReturns: {
        methodVersion: "daily-sequence-v1",
        inputHash: "target-qqq-hash",
        windows: {
          20: { status: "available", value: 3.25 },
          10: { status: "unavailable", value: null },
        },
      },
    },
    technicalV2: {
      costProfile14d28d: {
        status: "complete",
        methodVersion: "daily-cost-concentration-v1",
        input: { inputHash: "cost-hash" },
        configuration: { bins: 80 },
        profiles: {
          14: profile(14, 106, 102, 109),
          28: profile(28, 100, 95, 107),
        },
        comparison: { status: "available", pocShiftPercentOfLongPoc: 6 },
      },
      anchoredVwap: {
        status: "selected",
        hostVerified: true,
        confidence: "medium",
        evidence: {
          inputHash: "avwap-hash",
          methodVersion: "anchored-vwap-hlc3-volume/v1",
          vwap: 104,
          priceRelation: { differencePercent: 5.7692307692 },
          method: { formula: "sum(HLC3 * volume) / sum(volume)" },
        },
      },
    },
  };
}

test("technical facts preserve units, lineage, proxy confidence, and host verification", () => {
  const result = appendTechnicalNumericEvidence(basePackage(), {
    target: { symbol: "TEST.US", currency: "USD" },
    technical: technicalFixture(),
  });
  result.facts.forEach(validateNumericEvidence);
  const metric = (name) => result.facts.find((fact) => fact.metric === name);
  assert.equal(metric("technical.ema_3_price").value, "108");
  assert.equal(metric("technical.auto_fib_0_618_price").value, "114.72");
  assert.ok(metric("technical.auto_fib_0_618_price").quality.reasonCodes.includes(
    "automatic_anchor_advisory_only",
  ));
  assert.equal(metric("technical.cost_profile_14_poc_price").value, "106");
  assert.equal(metric("technical.cost_profile_14_poc_price").quality.confidence, "low");
  assert.ok(metric("technical.cost_profile_14_poc_price").quality.reasonCodes.includes(
    "daily_ohlcv_proxy_not_holder_cost_basis",
  ));
  assert.equal(metric("technical.host_verified_anchored_vwap_price").value, "104");
  assert.equal(metric("technical.host_verified_anchored_vwap_price").quality.confidence, "medium");
  assert.equal(metric("technical.close_distance_from_anchored_vwap_percent").unit.kind, "percent_point");
  assert.equal(metric("technical.close_distance_from_anchored_vwap_percent").provenance.inputRefs.length, 2);
  assert.equal(metric("technical.qqq_excess_return_20d_percent").value, "3.25");
  assert.equal(metric("technical.qqq_excess_return_10d_percent"), undefined);
  assert.equal(metric("technical.ema_144_price"), undefined);
  assert.equal(result.invariants.unavailableTechnicalValueIsNeverZero, true);
});

test("the same inputs are deterministic and unavailable AVWAP never becomes zero", () => {
  const input = technicalFixture();
  input.technicalV2.anchoredVwap = {
    status: "invalid",
    hostVerified: false,
    evidence: { vwap: 0 },
  };
  const first = appendTechnicalNumericEvidence(basePackage(), {
    target: { symbol: "TEST.US", currency: "USD" },
    technical: input,
  });
  const second = appendTechnicalNumericEvidence(basePackage(), {
    target: { symbol: "TEST.US", currency: "USD" },
    technical: structuredClone(input),
  });
  assert.deepEqual(first, second);
  assert.equal(first.facts.some((fact) => fact.metric.includes("anchored_vwap")), false);
});

test("short and long EMA facts share the host maturity contract; absent maturity is not invented", () => {
  for (const period of [3, 21, 144, 169]) {
    for (const maturity of [true, false, undefined]) {
      const technical = { ema: { [period]: 100 }, emaMaturity: maturity === undefined ? {} : { [period]: { mature: maturity } } };
      const result = appendTechnicalNumericEvidence(basePackage(), { target: { symbol: "TEST.US", currency: "USD" }, technical });
      const fact = result.facts.find((row) => row.metric === `technical.ema_${period}_price`);
      assert.equal(fact.value, "100");
      assert.equal(fact.quality.confidence, maturity === true ? "high" : "medium");
      assert.deepEqual(fact.quality.reasonCodes, maturity === true ? []
        : [maturity === false ? "ema_available_but_not_mature" : "ema_maturity_unavailable"]);
      validateNumericEvidence(fact);
    }
  }
});
