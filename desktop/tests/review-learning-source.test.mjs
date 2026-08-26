import assert from "node:assert/strict";
import test from "node:test";
import {
  annotateLearningSources,
  assertLearningSourceCurrent,
  learningSourceStatus,
} from "../src/review/review-learning-source.mjs";

function fixture({ evidenceRevision = 1, noteVersion = 1, extraRuns = [] } = {}) {
  return {
    cycles: [{
      id: "cycle-1",
      evidenceRevision,
      brokerLinks: { evidenceRevision },
      retrospectiveVersions: [{ version: noteVersion, integrityStatus: "valid" }],
      phaseRuns: {
        retrospective: [{
          id: "phase-run-1",
          phase: "retrospective",
          status: "completed",
          integrityStatus: "valid",
          evidenceRevision: 1,
          retrospectiveVersion: 1,
          result: { runId: "agent-run-1" },
        }, ...extraRuns],
        outcome: [],
      },
    }],
  };
}

const source = {
  id: "package-1",
  sourceReviewCycleId: "cycle-1",
  sourceRunId: "agent-run-1",
  validationPackageId: "package-1",
};

test("a package, protocol, and rule remain current only while their source phase run is current", () => {
  const workspace = {
    validationPackages: [source],
    tests: [{ id: "test-1", validationPackageId: "package-1" }],
    rules: [{ id: "rule-1", validationPackageId: "package-1" }],
  };
  const annotated = annotateLearningSources(workspace, fixture());
  assert.equal(annotated.validationPackages[0].sourceStatus, "current");
  assert.equal(annotated.tests[0].sourceStatus, "current");
  assert.equal(annotated.rules[0].sourceStatus, "current");
  assert.equal(annotated.tests[0].sourcePhaseRunId, "phase-run-1");
});

test("broker or retrospective revisions freeze every artifact derived from the old review", () => {
  const brokerChanged = learningSourceStatus(source, fixture({ evidenceRevision: 2 }));
  assert.equal(brokerChanged.sourceStatus, "stale");
  assert.deepEqual(brokerChanged.sourceStatusReasons, ["broker_evidence_revision_changed"]);
  const noteChanged = learningSourceStatus(source, fixture({ noteVersion: 2 }));
  assert.equal(noteChanged.sourceStatus, "stale");
  assert.deepEqual(noteChanged.sourceStatusReasons, ["retrospective_note_version_changed"]);
  assert.throws(
    () => assertLearningSourceCurrent(source, fixture({ evidenceRevision: 2 })),
    /已经过期的复盘证据/,
  );
});

test("a newer completed run supersedes a package even when evidence revisions are unchanged", () => {
  const status = learningSourceStatus(source, fixture({
    extraRuns: [{
      id: "phase-run-2",
      phase: "retrospective",
      status: "completed",
      integrityStatus: "valid",
      evidenceRevision: 1,
      retrospectiveVersion: 1,
      result: { runId: "agent-run-2" },
    }],
  }));
  assert.equal(status.sourceStatus, "stale");
  assert.deepEqual(status.sourceStatusReasons, ["source_phase_run_superseded"]);
});

test("manually created protocols without a cycle source remain untracked rather than falsely stale", () => {
  assert.equal(learningSourceStatus({ id: "manual" }, fixture()).sourceStatus, "untracked");
});
