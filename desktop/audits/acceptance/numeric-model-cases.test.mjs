import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { prepareCase, summarizeManualChecks } from "./numeric-model-eval.mjs";

const suite = JSON.parse(await readFile(new URL("./numeric-model-cases.json", import.meta.url), "utf8"));
const byId = id => suite.cases.find(item => item.id === id);
const facts = id => byId(id).expected.facts;

test("fixed evaluation dataset stays synthetic, not-run, and has unique scorable cases", () => {
  assert.equal(suite.status, "dataset_ready_not_run");
  assert.equal(suite.liveModelCalls, false);
  assert.equal(suite.dataClassification, "synthetic_only");
  assert.equal(suite.cases.length, 12);
  assert.equal(new Set(suite.cases.map(item => item.id)).size, suite.cases.length);
  for (const item of suite.cases) {
    assert.ok(item.input.question && item.input.evidence.length && item.expected.limitation);
    assert.equal(new Set(item.input.evidence.map(row => row.id)).size, item.input.evidence.length);
    assert.equal(new Set(item.checks.map(row => row.id)).size, item.checks.length);
    assert.ok(item.checks.some(row => row.critical));
    assert.ok(item.checks.every(row => typeof row.critical === "boolean" && row.criterion));
  }
});

test("literal answer keys agree with independent arithmetic, not model-generated answers", () => {
  assert.deepEqual(facts("fx-and-nav-weight"), { navUsd: 80000 / 8, positionUsd: 2 * 250, weightPercentOfNav: 2 * 250 / (80000 / 8) * 100 });
  assert.deepEqual(facts("negative-cash-and-unknown"), { cashUsd: -8000 / 8, cashPercentOfNav: -8000 / 8 / 10000 * 100, buyingPowerUsd: 0, creditUsd: null });
  assert.deepEqual(facts("option-value-not-exposure"), { aCurrentPremiumMarketValueUsd: 2 * 5 * 100, bCurrentPremiumMarketValueUsd: null, deltaExposureUsd: null, maxLossFromOriginalEntryUsd: null });
  assert.deepEqual(facts("partial-sale-gross"), { realizedGrossPnlUsd: 20 * (12 - 10), remainingShares: 100 - 20, closedShares: 20, netPnlUsd: null });
  assert.equal(facts("percent-versus-points").priceReturnDifferencePercentagePoints, 10 - 5);
  assert.deepEqual(facts("partial-eod-not-performance"), { endpointNavChangeUsd: 11000 - 10000, endpointNavChangePercent: (11000 - 10000) / 10000 * 100, investmentReturnPercent: null });
  assert.equal(facts("sample-denominator").eligibleUniqueSamples, 3);
  assert.ok(Math.abs(facts("sample-denominator").winRatePercent - 100 / 3) < 1e-8);
  assert.ok(Math.abs(facts("sample-denominator").averageR - (2 - 1 + 0) / 3) < 1e-8);
  assert.equal(facts("cache-and-source-conflict").reportedSumUsd, 5000 + 5000);
  assert.deepEqual(facts("ema-completed-only"), { ema3AfterCompletedBar: 0.5 * 102 + 0.5 * 100, ema169Mature: false });
  for (const [key, ratio] of Object.entries({ extension0382: 0.382, extension0618: 0.618, extension1: 1, extension1618: 1.618 })) {
    assert.equal(facts("fib-explicit-anchor")[key], Number((110 + ratio * (120 - 100)).toFixed(2)));
  }
  assert.equal(facts("approximate-cost-profile").estimatedPoc, 110);
  const timeline = byId("point-in-time-conflict").input.evidence;
  assert.ok(Date.parse(timeline.find(row => row.id === "before").at) < Date.parse(timeline.find(row => row.id === "cutoff").at));
  assert.ok(Date.parse(timeline.find(row => row.id === "future").at) > Date.parse(timeline.find(row => row.id === "cutoff").at));
  assert.equal(facts("point-in-time-conflict").canAssignFormalQuantitativeDecisionScore, false);
});

test("model payload contains only this case and instructions, never the reference answer or rubric", () => {
  for (const item of suite.cases) {
    const { payload, inputHash } = prepareCase(suite, item.id);
    assert.deepEqual(Object.keys(payload), ["caseId", "instructions", "input"]);
    assert.deepEqual(payload.input, item.input);
    assert.match(inputHash, /^[a-f0-9]{64}$/);
    payload.input.question = "modified externally";
    assert.notEqual(item.input.question, payload.input.question);
    const altered = structuredClone(suite);
    altered.cases.find(row => row.id === item.id).expected = { secret: "DO_NOT_DELIVER" };
    assert.equal(prepareCase(altered, item.id).inputHash, inputHash);
  }
  assert.throws(() => prepareCase(suite, "missing"), /Unknown/);
});

test("unscored and failed manual checks cannot disappear from the denominator or yield acceptance", () => {
  const pending = summarizeManualChecks(suite);
  assert.equal(pending.rubricPassed, false);
  assert.equal(pending.notAssessed, pending.denominator);
  assert.equal(pending.passedFraction, 0);
  const synthetic = Object.fromEntries(suite.cases.map(item => [item.id, Object.fromEntries(item.checks.map(check => [check.id, true]))]));
  const all = summarizeManualChecks(suite, synthetic);
  assert.equal(all.rubricPassed, true); // Tests tally semantics, NOT a model pass.
  assert.equal(all.answersVerifiedByScript, false);
  synthetic[suite.cases[0].id][suite.cases[0].checks[0].id] = false;
  const failed = summarizeManualChecks(suite, synthetic);
  assert.equal(failed.rubricPassed, false);
  assert.equal(failed.criticalFailed, 1);
  assert.equal(failed.denominator, all.denominator);
  synthetic[suite.cases[0].id][suite.cases[0].checks[0].id] = null;
  assert.equal(summarizeManualChecks(suite, synthetic).notAssessed, 1);
  assert.throws(() => summarizeManualChecks(suite, { unknown: {} }), /Unknown/);
  assert.throws(() => summarizeManualChecks(suite, { [suite.cases[0].id]: { unknown: true } }), /Unknown/);
  assert.throws(() => summarizeManualChecks(suite, { [suite.cases[0].id]: { [suite.cases[0].checks[0].id]: "true" } }), /must be/);
});
