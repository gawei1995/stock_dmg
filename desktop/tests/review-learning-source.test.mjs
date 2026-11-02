import assert from "node:assert/strict";
import test from "node:test";
import {
  annotateLearningSources,
  assertLearningSourceCurrent,
  learningSourceStatus,
  canonicalReviewEvidenceIdentity,
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

test("one legacy case and multiple migrations share an account-scoped evidence identity", () => {
  const original = canonicalReviewEvidenceIdentity({ id: "case-1", brokerLinks: { accountScopeId: "scope-a" } }, { kind: "case" });
  const migrated = (id, sourceHash, accountScopeId = "scope-a") => canonicalReviewEvidenceIdentity({ id,
    legacySource: { sourceCaseId: "case-1", sourceHash, accountScopeId },
    brokerLinks: { accountScopeId, revision: sourceHash === "old" ? 1 : 2 },
  });
  assert.equal(original.key, migrated("cycle-a", "old").key);
  assert.equal(original.key, migrated("cycle-b", "new").key, "a changed source hash is not a new statistical unit");
  assert.notEqual(original.key, migrated("cycle-c", "old", "scope-b").key);
  const conflict = canonicalReviewEvidenceIdentity({ id: "cycle-bad", legacySource: { sourceCaseId: "case-1", accountScopeId: "scope-a" }, brokerLinks: { accountScopeId: "scope-b" } });
  assert.equal(conflict.key, null);
  assert.equal(conflict.reason, "legacy_source_account_scope_conflict");
  assert.equal(canonicalReviewEvidenceIdentity({ id: "cycle-unknown", legacySource: { sourceCaseId: "case-1" } }).reason,
    "legacy_source_account_scope_missing");
});

test("migration references and pre-migration results never become a current cycle learning source", () => {
  const workspace = fixture();
  const cycle = workspace.cycles[0];
  cycle.legacySource = { sourceCaseId: "case-1", accountScopeId: "scope-a", migratedAt: "2026-08-20T00:00:00Z",
    resultReferences: [{ kind: "review", hash: "old-result" }] };
  const missingRun = learningSourceStatus({ sourceReviewCycleId: cycle.id }, workspace);
  assert.equal(missingRun.sourceStatus, "stale");
  assert.deepEqual(missingRun.sourceStatusReasons, ["legacy_source_requires_new_cycle_phase_run"]);
  cycle.phaseRuns.retrospective[0].completedAt = "2026-08-19T00:00:00Z";
  assert.ok(learningSourceStatus(source, workspace).sourceStatusReasons.includes("legacy_result_is_not_a_new_cycle_phase_run"));
  cycle.phaseRuns.retrospective[0].completedAt = "2026-08-21T00:00:00Z";
  const current = learningSourceStatus(source, workspace);
  assert.equal(current.sourceStatus, "current");
  assert.equal(current.canonicalEvidenceIdentity.sourceCaseId, "case-1");
  assert.equal(current.sourceEvidencePosture, "historical_legacy_source_not_new_ex_ante");
  cycle.phaseRuns.retrospective = [];
  assert.equal(learningSourceStatus(source, workspace).sourceStatus, "stale");
});
