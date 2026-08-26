import assert from "node:assert/strict";
import test from "node:test";
import {
  buildValidationCandidateIndex,
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
