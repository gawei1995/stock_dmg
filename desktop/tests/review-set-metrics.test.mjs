import assert from "node:assert/strict";
import test from "node:test";

import { buildReviewSetMetrics } from "../src/review/review-set-metrics.mjs";

test("review-set metrics calculate verified R statistics in the host with explicit units", () => {
  const result = buildReviewSetMetrics({
    cases: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
    tests: [
      { id: "ta", caseId: "a", outcomeR: 2, outcomeVerified: true },
      { id: "tb", caseId: "b", outcomeR: -1, outcomeVerified: true },
      { id: "tc", caseId: "c", outcomeR: 0, outcomeVerified: true },
      { id: "td", caseId: "d", outcomeR: -2, outcomeVerified: true },
    ],
  });
  assert.equal(result.status, "available");
  assert.equal(result.facts.sampleCount.value, 4);
  assert.equal(result.facts.winRate.value, 25);
  assert.equal(result.facts.payoffRatio.value, 1.333333);
  assert.equal(result.facts.expectancyR.value, -0.25);
  assert.equal(result.facts.profitFactor.value, 0.666667);
  assert.equal(result.facts.medianR.value, -0.5);
  assert.equal(result.facts.worstR.value, -2);
  assert.equal(result.facts.tailLossRate.value, 25);
  assert.deepEqual(result.facts.winRate.unit, { kind: "percent_point", basis: "verified_samples" });
  assert.deepEqual(result.facts.expectancyR.unit, { kind: "scalar", label: "R_multiple" });
  assert.match(result.resultHash, /^sha256:[a-f0-9]{64}$/);
});

test("review-set metrics reject unverified, censored, boolean and foreign samples", () => {
  const result = buildReviewSetMetrics({
    cases: [{ id: "a" }, { id: "b" }],
    tests: [
      { id: "unverified", caseId: "a", outcomeR: 3, outcomeVerified: false },
      { id: "censored", caseId: "a", outcomeR: -1, outcomeVerified: true, censored: true },
      { id: "boolean", caseId: "b", outcomeR: false, outcomeVerified: true },
      { id: "foreign", caseId: "z", outcomeR: 9, outcomeVerified: true },
    ],
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.facts.sampleCount.value, 0);
  assert.equal(result.facts.winRate.value, null);
  assert.equal(result.facts.winRate.availability, "unknown");
  assert.deepEqual(result.sampleFunnel.exclusionReasons, {
    censored: 1,
    net_r_missing_or_invalid: 1,
    not_bound_to_selected_case: 1,
    outcome_not_host_verified: 1,
  });
});

test("review-set metrics keep only the latest verified observation per decision package", () => {
  const result = buildReviewSetMetrics({
    cases: [{ id: "a" }],
    tests: [
      { id: "old", caseId: "a", outcomeR: -1, outcomeVerified: true, completedAt: "2026-01-01T00:00:00Z" },
      { id: "new", caseId: "a", outcomeR: 2, outcomeVerified: true, completedAt: "2026-01-02T00:00:00Z" },
    ],
  });
  assert.equal(result.facts.sampleCount.value, 1);
  assert.equal(result.facts.expectancyR.value, 2);
  assert.equal(result.sampleFunnel.exclusionReasons.duplicate_case_observation_superseded, 1);
});

test("duplicate observations without a unique timestamp are excluded independent of input order", () => {
  const input = {
    cases: [{ id: "a" }],
    tests: [
      { id: "one", caseId: "a", outcomeR: -3, outcomeVerified: true },
      { id: "two", caseId: "a", outcomeR: 4, outcomeVerified: true },
    ],
  };
  const forward = buildReviewSetMetrics(input);
  const reversed = buildReviewSetMetrics({ ...input, tests: [...input.tests].reverse() });
  assert.equal(forward.status, "unavailable");
  assert.equal(forward.facts.sampleCount.value, 0);
  assert.equal(forward.sampleFunnel.exclusionReasons.duplicate_case_observation_order_ambiguous, 2);
  assert.equal(forward.resultHash, reversed.resultHash);
});

function migratedCycle(id, sourceCaseId = "legacy-case", accountScopeId = "scope-a") {
  return {
    id, type: "trade_window", reviewMode: "lightweight", evidenceRevision: 1,
    legacySource: { sourceCaseId, accountScopeId, sourceHash: id, migratedAt: "2026-08-20T00:00:00Z" },
    brokerLinks: { accountScopeId, evidenceRevision: 1 },
    retrospectiveVersions: [{ version: 1, integrityStatus: "valid" }],
    phaseRuns: { retrospective: [{ id: `${id}-run`, status: "completed", integrityStatus: "valid",
      evidenceRevision: 1, retrospectiveVersion: 1, completedAt: "2026-08-21T00:00:00Z" }] },
  };
}

test("set metrics count a legacy case and two migrated cycles as one canonical decision package", () => {
  const result = buildReviewSetMetrics({
    cases: [{ id: "legacy-case", brokerLinks: { accountScopeId: "scope-a" } }],
    cycles: [migratedCycle("cycle-one"), migratedCycle("cycle-two")],
    tests: [
      { id: "legacy-result", caseId: "legacy-case", outcomeVerified: true, outcomeR: -1, completedAt: "2026-08-19T00:00:00Z" },
      { id: "new-result-one", reviewCycleId: "cycle-one", outcomeVerified: true, outcomeR: 1, completedAt: "2026-08-21T00:00:00Z" },
      { id: "new-result-two", reviewCycleId: "cycle-two", outcomeVerified: true, outcomeR: 2, completedAt: "2026-08-22T00:00:00Z" },
    ],
  });
  assert.equal(result.facts.sampleCount.value, 1);
  assert.equal(result.facts.expectancyR.value, 2);
  assert.equal(result.samples[0].reviewCycleId, "cycle-two");
  assert.equal(result.samples[0].canonicalEvidenceIdentity.sourceCaseId, "legacy-case");
  assert.equal(result.sampleFunnel.exclusionReasons.duplicate_evidence_observation_superseded, 2);
  assert.equal(result.invariants.legacyMigrationDoesNotCreateIndependentSample, true);
});

test("duplicate migration results with ambiguous ordering are excluded, while different accounts remain separate", () => {
  const cycles = [migratedCycle("cycle-one"), migratedCycle("cycle-two")];
  const tests = cycles.map((cycle) => ({ id: `${cycle.id}-result`, reviewCycleId: cycle.id,
    outcomeVerified: true, outcomeR: 1, completedAt: "2026-08-22T00:00:00Z" }));
  const ambiguous = buildReviewSetMetrics({ cycles, tests });
  assert.equal(ambiguous.facts.sampleCount.value, 0);
  assert.equal(ambiguous.sampleFunnel.exclusionReasons.duplicate_evidence_observation_order_ambiguous, 2);
  const separate = buildReviewSetMetrics({ cycles: [cycles[0], migratedCycle("cycle-two", "legacy-case", "scope-b")], tests });
  assert.equal(separate.facts.sampleCount.value, 2);
});

test("migration without a fresh completed cycle analysis cannot contribute a verified statistical result", () => {
  const cycle = migratedCycle("cycle-pending");
  cycle.phaseRuns.retrospective = [];
  const result = buildReviewSetMetrics({ cycles: [cycle], tests: [
    { id: "copied-old-result", reviewCycleId: cycle.id, outcomeVerified: true, outcomeR: 9 },
  ] });
  assert.equal(result.facts.sampleCount.value, 0);
  assert.equal(result.sampleFunnel.exclusionReasons.no_current_cycle_phase_run, 1);
});
