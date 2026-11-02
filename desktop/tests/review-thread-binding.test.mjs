import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReviewThreadBinding,
  normalizeReviewThreadBinding,
  reviewThreadBindingContext,
  reviewThreadBindingFromEvidence,
} from "../src/engine/review-thread-binding.mjs";

test("decision-cycle review binding includes phase and immutable evidence identity", () => {
  const binding = reviewThreadBindingFromEvidence({
    analysisScope: "review",
    context: {
      reviewProtocol: "decision_cycle",
      reviewCycleId: "cycle-1",
      reviewPhase: "outcome",
      reviewEvidenceRevision: 4,
      reviewRetrospectiveVersion: null,
      reviewInputSnapshotHash: "snapshot-4",
    },
  });
  assert.deepEqual(reviewThreadBindingContext(binding), {
    reviewProtocol: "decision_cycle",
    reviewCycleId: "cycle-1",
    reviewPhase: "outcome",
    reviewEvidenceRevision: 4,
    reviewRetrospectiveVersion: null,
    reviewInputSnapshotHash: "snapshot-4",
  });
  assert.deepEqual(assertReviewThreadBinding(binding, { ...binding }), binding);
});

test("one persistent review thread rejects phase, cycle and revision switching", () => {
  const original = normalizeReviewThreadBinding({
    protocol: "decision_cycle",
    cycleId: "cycle-a",
    phase: "blind",
    evidenceRevision: 2,
    inputSnapshotHash: "hash-a",
  });
  for (const changed of [
    { ...original, phase: "outcome" },
    { ...original, cycleId: "cycle-b" },
    { ...original, evidenceRevision: 3 },
    { ...original, inputSnapshotHash: "hash-b" },
  ]) {
    assert.throws(() => assertReviewThreadBinding(original, changed), /新建独立复盘对话/);
  }
});

test("earnings review case binding is stable regardless of selected input order", () => {
  const first = reviewThreadBindingFromEvidence({
    analysisScope: "review",
    context: {
      reviewProtocol: "earnings_case",
      reviewCaseIds: ["case-b", "case-a"],
      reviewEvidenceRevisions: [
        { caseId: "case-a", revision: 2 },
        { caseId: "case-b", revision: 1 },
      ],
    },
  });
  const second = reviewThreadBindingFromEvidence({
    analysisScope: "review",
    context: {
      reviewProtocol: "earnings_case",
      reviewCaseIds: ["case-a", "case-b"],
      reviewEvidenceRevisions: [
        { caseId: "case-b", revision: 1 },
        { caseId: "case-a", revision: 2 },
      ],
    },
  });
  assert.deepEqual(assertReviewThreadBinding(first, second), first);
  assert.deepEqual(first.caseIds, ["case-a", "case-b"]);
});
