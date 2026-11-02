import assert from "node:assert/strict";
import test from "node:test";
import {
  buildValidationCandidateIndex,
  buildValidationCandidateReport,
  currentValidationReviewRun,
  validationCandidateTiming,
} from "../src/review/review-validation-candidates.mjs";

function completedCycle({
  id,
  startAt,
  endAt,
  completedAt,
  symbol = "NVDA.US",
  evidenceRevision = 1,
  runEvidenceRevision = evidenceRevision,
  retrospectiveVersion = 1,
  runRetrospectiveVersion = retrospectiveVersion,
  technicalValidation = null,
} = {}) {
  return {
    id,
    cycleType: "trade_window",
    reviewMode: "lightweight",
    status: "completed",
    symbols: [symbol],
    startAt,
    endAt,
    evidenceRevision,
    retrospectiveVersions: [{ version: retrospectiveVersion, integrityStatus: "valid" }],
    phaseRuns: {
      blind: [],
      outcome: [],
      retrospective: [{
        id: `${id}-run`,
        status: "completed",
        integrityStatus: "valid",
        evidenceRevision: runEvidenceRevision,
        retrospectiveVersion: runRetrospectiveVersion,
        completedAt,
        result: technicalValidation ? { technicalValidation } : null,
      }],
    },
  };
}

test("validation candidate index shows forward and historical calibration reviews without reusing the source", () => {
  const source = completedCycle({
    id: "source",
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-02T00:00:00.000Z",
    completedAt: "2026-08-03T00:00:00.000Z",
  });
  const historical = completedCycle({
    id: "historical",
    startAt: "2026-08-04T00:00:00.000Z",
    endAt: "2026-08-05T00:00:00.000Z",
    completedAt: "2026-08-06T00:00:00.000Z",
  });
  const overlapping = completedCycle({
    id: "overlap",
    startAt: "2026-08-09T00:00:00.000Z",
    endAt: "2026-08-11T00:00:00.000Z",
    completedAt: "2026-08-12T00:00:00.000Z",
  });
  const forward = completedCycle({
    id: "forward",
    startAt: "2026-08-12T00:00:00.000Z",
    endAt: "2026-08-13T00:00:00.000Z",
    completedAt: "2026-08-14T00:00:00.000Z",
  });
  const included = completedCycle({
    id: "already-included",
    startAt: "2026-08-15T00:00:00.000Z",
    endAt: "2026-08-16T00:00:00.000Z",
    completedAt: "2026-08-17T00:00:00.000Z",
  });
  const testProtocol = {
    id: "test-1",
    testKind: "protocol",
    sourceReviewCycleId: "source",
    observationStartedAt: "2026-08-10T00:00:00.000Z",
    cohort: "NVDA 突破回踩",
    samples: [{ reviewCycleId: "already-included" }],
  };

  const result = buildValidationCandidateIndex({
    tests: [testProtocol],
    cycles: [source, historical, overlapping, forward, included],
    now: Date.parse("2026-08-20T00:00:00.000Z"),
  });
  assert.deepEqual(result["test-1"].map((item) => item.cycleId), ["forward", "overlap", "historical"]);
  assert.deepEqual(result["test-1"].map((item) => item.timing), ["forward", "overlapping", "historical"]);
  assert.match(result["test-1"].at(-1).reason, /历史探索/);
});

test("candidate matching fails closed for a stale evidence revision", () => {
  const stale = completedCycle({
    id: "stale",
    startAt: "2026-08-12T00:00:00.000Z",
    endAt: "2026-08-13T00:00:00.000Z",
    completedAt: "2026-08-14T00:00:00.000Z",
    evidenceRevision: 2,
    runEvidenceRevision: 1,
  });
  assert.equal(currentValidationReviewRun(stale), null);
  const index = buildValidationCandidateIndex({
    tests: [{ id: "test", testKind: "protocol", samples: [], observationStartedAt: "2026-08-10T00:00:00.000Z" }],
    cycles: [stale],
    now: Date.parse("2026-08-20T00:00:00.000Z"),
  });
  assert.deepEqual(index.test, []);
});

test("candidate matching rejects a completed run made before the trading-fact filter", () => {
  const legacy = completedCycle({
    id: "legacy-filter",
    startAt: "2026-08-12T00:00:00.000Z",
    endAt: "2026-08-13T00:00:00.000Z",
    completedAt: "2026-08-14T00:00:00.000Z",
  });
  legacy.brokerEvidenceAudit = { requiresPolicyV2Run: true };
  assert.equal(currentValidationReviewRun(legacy), null);
  legacy.phaseRuns.retrospective[0].evidenceFilterPolicyVersion = 2;
  assert.notEqual(currentValidationReviewRun(legacy), null);
});

test("candidate timing is based on the selected cycle activity, not review completion time", () => {
  assert.equal(validationCandidateTiming({
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-02T00:00:00.000Z",
  }, "2026-08-10T00:00:00.000Z"), "historical");
  assert.equal(validationCandidateTiming({
    startAt: "2026-08-09T00:00:00.000Z",
    endAt: "2026-08-11T00:00:00.000Z",
  }, "2026-08-10T00:00:00.000Z"), "overlapping");
  assert.equal(validationCandidateTiming({
    startAt: "2026-08-10T00:00:00.000Z",
    endAt: "2026-08-11T00:00:00.000Z",
  }, "2026-08-10T00:00:00.000Z"), "forward");
});

test("technical candidates use the strict selected Buy cutoff and expose only an unverified protocol reference", () => {
  const cycle = completedCycle({
    id: "entry-bound",
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-12T00:00:00.000Z",
    completedAt: "2026-08-13T00:00:00.000Z",
    technicalValidation: {
      status: "complete",
      resultHash: "a".repeat(64),
      cycle: {
        entryCutoffAt: "2026-08-11T14:30:00.000Z",
        exitAt: "2026-08-12T19:30:00.000Z",
      },
      entrySnapshot: { batch: { tradingDate: "2026-08-10", recordedAt: "2026-08-10T21:01:00.000Z" } },
      sampleCandidate: { status: "available", sampleId: "sample-entry-bound" },
      ruleCandidate: { ruleKey: "technical-state:entry-bound" },
      validationMode: { classification: "historical_calibration" },
    },
  });
  const index = buildValidationCandidateIndex({
    tests: [{
      id: "test-entry",
      testKind: "protocol",
      samples: [],
      observationStartedAt: "2026-08-10T00:00:00.000Z",
    }],
    cycles: [cycle],
    now: Date.parse("2026-08-20T00:00:00.000Z"),
  });
  const candidate = index["test-entry"][0];
  assert.equal(candidate.timing, "forward");
  assert.equal(candidate.technicalValidation.validationMode, "walk_forward_candidate");
  assert.equal(candidate.technicalValidation.eligibleForFormalStatistics, false);
  assert.equal(candidate.technicalValidation.entryCutoffAt, "2026-08-11T14:30:00.000Z");
  assert.match(candidate.technicalValidation.formalEligibilityReason, /协议哈希/);
});

test("candidate report excludes source aliases, included aliases, and duplicate migrations with reasons", () => {
  const migrated = (id, sourceCaseId, completedAt = "2026-08-18T00:00:00Z") => ({
    ...completedCycle({ id, startAt: "2026-08-11T00:00:00Z", endAt: "2026-08-12T00:00:00Z", completedAt }),
    legacySource: { sourceCaseId, sourceHash: id, accountScopeId: "scope-a", migratedAt: "2026-08-16T00:00:00Z" },
  });
  const cycles = [migrated("source", "case-source"), migrated("source-copy", "case-source"),
    migrated("included", "case-included"), migrated("included-copy", "case-included"),
    migrated("candidate-old", "case-candidate", "2026-08-17T00:00:00Z"), migrated("candidate-new", "case-candidate")];
  const tests = [{ id: "test", testKind: "protocol", sourceReviewCycleId: "source",
    observationStartedAt: "2026-08-10T00:00:00Z", samples: [{ reviewCycleId: "included" }] }];
  const report = buildValidationCandidateReport({ tests, cycles, now: Date.parse("2026-08-20T00:00:00Z") });
  assert.deepEqual(report.candidatesByTest.test.map((item) => item.cycleId), ["candidate-new"]);
  const reasonFor = (id) => report.exclusionsByTest.test.find((item) => item.cycleId === id)?.reason;
  assert.equal(reasonFor("source-copy"), "same_evidence_as_hypothesis_source");
  assert.equal(reasonFor("included-copy"), "same_evidence_already_included");
  assert.equal(reasonFor("candidate-old"), "duplicate_legacy_evidence");
  assert.deepEqual(buildValidationCandidateIndex({ tests, cycles: [...cycles].reverse(), now: Date.parse("2026-08-20T00:00:00Z") }), report.candidatesByTest);
  assert.equal(report.candidatesByTest.test[0].technicalValidation.eligibleForFormalStatistics, false);
});

test("an imported case reference and an old result are not a new completed validation sample", () => {
  const cycle = completedCycle({ id: "migrated", startAt: "2026-08-01T00:00:00Z", endAt: "2026-08-02T00:00:00Z",
    completedAt: "2026-08-03T00:00:00Z" });
  cycle.legacySource = { sourceCaseId: "old-case", accountScopeId: "scope-a", migratedAt: "2026-08-16T00:00:00Z" };
  const tests = [{ id: "test", testKind: "protocol", samples: [], observationStartedAt: "2026-08-10T00:00:00Z" }];
  assert.equal(currentValidationReviewRun(cycle), null);
  assert.equal(buildValidationCandidateReport({ tests, cycles: [cycle] }).exclusionsByTest.test[0].reason, "no_current_cycle_phase_run");
  cycle.phaseRuns.retrospective[0].completedAt = "2026-08-17T00:00:00Z";
  tests[0].samples = [{ caseId: "old-case", accountScopeId: "scope-a" }];
  const included = buildValidationCandidateReport({ tests, cycles: [cycle] });
  assert.deepEqual(included.candidatesByTest.test, []);
  assert.equal(included.exclusionsByTest.test[0].reason, "same_evidence_already_included");
  tests[0].samples = [];
  tests[0].sourceCaseId = "old-case";
  tests[0].accountScopeId = "scope-a";
  const originalHypothesis = buildValidationCandidateReport({ tests, cycles: [cycle] });
  assert.deepEqual(originalHypothesis.candidatesByTest.test, []);
  assert.equal(originalHypothesis.exclusionsByTest.test[0].reason, "same_evidence_as_hypothesis_source");
});
