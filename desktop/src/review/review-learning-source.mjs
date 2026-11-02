/**
 * Cross-ledger provenance for AI validation packages.
 *
 * ReviewStore owns protocols/rules while ReviewCycleStore owns the immutable
 * Agent phase run that produced them. This module joins the two read models so
 * a broker-evidence correction cannot leave an old learning proposal looking
 * current or accepting new samples.
 */

/** A source revision is not a new independent statistical decision package. */
export function canonicalReviewEvidenceIdentity(record, { kind = "cycle" } = {}) {
  const legacy = record?.legacySource && typeof record.legacySource === "object" ? record.legacySource : null;
  const sourceCaseId = cleanId(legacy?.sourceCaseId) || (kind === "case" ? cleanId(record?.id) : "");
  const sourceScope = cleanId(legacy?.accountScopeId);
  const currentScope = cleanId(record?.brokerLinks?.accountScopeId ?? record?.brokerAssociation?.accountScopeId ?? record?.accountScopeId);
  const accountScopeId = sourceScope || currentScope || null;
  const conflict = Boolean(sourceScope && currentScope && sourceScope !== currentScope);
  const reason = conflict ? "legacy_source_account_scope_conflict"
    : legacy && !sourceCaseId ? "legacy_source_case_id_missing"
      : legacy && !accountScopeId ? "legacy_source_account_scope_missing" : null;
  const sourceId = sourceCaseId || cleanId(record?.id);
  return {
    key: sourceId && !reason ? JSON.stringify(["review-evidence/v1", accountScopeId, sourceCaseId ? "case" : kind, sourceId]) : null,
    status: sourceId && !reason ? "identified" : "unavailable",
    reason: reason ?? (!sourceId ? "review_evidence_id_missing" : null),
    accountScopeId,
    sourceCaseId: sourceCaseId || null,
    sourceCycleId: kind === "cycle" ? cleanId(record?.id) || null : null,
    sourceHash: cleanId(legacy?.sourceHash) || null,
    migrated: Boolean(legacy),
    boundary: "same_account_and_legacy_case_lineage_is_one_sample_regardless_of_migration_or_revision",
  };
}

export function phaseRunFollowsLegacyMigration(cycle, run) {
  if (!cycle?.legacySource) return true;
  const migratedAt = Date.parse(String(cycle.legacySource.migratedAt ?? ""));
  const completedAt = Date.parse(String(run?.completedAt ?? run?.recordedAt ?? ""));
  return Number.isFinite(migratedAt) && Number.isFinite(completedAt) && completedAt >= migratedAt;
}

export function annotateLearningSources(workspace, cycleWorkspace) {
  const packages = (workspace?.validationPackages ?? []).map((item) => ({
    ...item,
    ...learningSourceStatus(item, cycleWorkspace),
  }));
  const packageById = new Map(packages.map((item) => [String(item.id ?? ""), item]));
  const annotate = (item) => {
    const source = packageById.get(String(item?.validationPackageId ?? "")) ?? item;
    const provenance = learningSourceStatus(source, cycleWorkspace);
    return provenance.sourceStatus === "untracked" ? item : { ...item, ...provenance };
  };
  return {
    ...workspace,
    validationPackages: packages,
    tests: (workspace?.tests ?? []).map(annotate),
    rules: (workspace?.rules ?? []).map(annotate),
  };
}

export function learningSourceStatus(source, cycleWorkspace) {
  const sourceReviewCycleId = cleanId(source?.sourceReviewCycleId);
  const sourceRunId = cleanId(source?.sourceRunId);
  const sourcePhaseRunId = cleanId(source?.sourcePhaseRunId);
  const cycle = (cycleWorkspace?.cycles ?? []).find((item) => String(item?.id ?? "") === sourceReviewCycleId);
  if (cycle?.legacySource && (!sourceRunId && !sourcePhaseRunId)) {
    return staleSource("legacy_source_requires_new_cycle_phase_run", sourcePhaseRunId, source);
  }
  if (!sourceReviewCycleId || (!sourceRunId && !sourcePhaseRunId)) {
    return {
      sourceStatus: "untracked",
      sourceStatusReasons: [],
      sourcePhaseRunId: sourcePhaseRunId || null,
      sourceEvidenceRevision: positiveIntegerOrNull(source?.sourceEvidenceRevision),
      sourceRetrospectiveVersion: positiveIntegerOrNull(source?.sourceRetrospectiveVersion),
    };
  }

  if (!cycle) return staleSource("source_cycle_missing", sourcePhaseRunId, source);
  const identity = canonicalReviewEvidenceIdentity(cycle);
  if (identity.status !== "identified") return staleSource(identity.reason, sourcePhaseRunId, source);
  const runs = [
    ...(cycle?.phaseRuns?.retrospective ?? []),
    ...(cycle?.phaseRuns?.outcome ?? []),
  ];
  const run = runs.find((item) => (
    (sourcePhaseRunId && String(item?.id ?? "") === sourcePhaseRunId)
    || (sourceRunId && String(item?.result?.runId ?? "") === sourceRunId)
  ));
  if (!run) return staleSource("source_phase_run_missing", sourcePhaseRunId, source);

  const reasons = [];
  if (run.status !== "completed" || run.integrityStatus !== "valid") reasons.push("source_phase_run_invalid");
  if (!phaseRunFollowsLegacyMigration(cycle, run)) reasons.push("legacy_result_is_not_a_new_cycle_phase_run");
  const samePhaseRuns = runs.filter((item) => (
    item?.phase === run.phase && item?.status === "completed" && item?.integrityStatus === "valid"
  ));
  if (samePhaseRuns.at(-1)?.id !== run.id) reasons.push("source_phase_run_superseded");
  const currentEvidenceRevision = positiveIntegerOrNull(
    cycle?.evidenceRevision ?? cycle?.brokerLinks?.evidenceRevision ?? cycle?.brokerLinks?.revision,
  );
  const citedEvidenceRevision = positiveIntegerOrNull(run?.evidenceRevision);
  if (["retrospective", "outcome"].includes(run.phase)
    && citedEvidenceRevision !== currentEvidenceRevision) {
    reasons.push("broker_evidence_revision_changed");
  }
  const currentRetrospectiveVersion = positiveIntegerOrNull(
    (cycle?.retrospectiveVersions ?? []).filter((item) => item?.integrityStatus !== "mismatch").at(-1)?.version,
  );
  const citedRetrospectiveVersion = positiveIntegerOrNull(run?.retrospectiveVersion);
  if (run.phase === "retrospective" && citedRetrospectiveVersion !== currentRetrospectiveVersion) {
    reasons.push("retrospective_note_version_changed");
  }

  return {
    sourceStatus: reasons.length ? "stale" : "current",
    sourceStatusReasons: reasons,
    sourcePhaseRunId: String(run.id),
    sourceEvidenceRevision: citedEvidenceRevision,
    sourceRetrospectiveVersion: citedRetrospectiveVersion,
    canonicalEvidenceIdentity: identity,
    sourceEvidencePosture: cycle.legacySource ? "historical_legacy_source_not_new_ex_ante" : null,
  };
}

export function assertLearningSourceCurrent(source, cycleWorkspace) {
  const status = learningSourceStatus(source, cycleWorkspace);
  if (status.sourceStatus === "stale") {
    throw new Error("该测试或规则来自已经过期的复盘证据；请按最新订单与记录重新复盘并确认新的验证草案。");
  }
  return status;
}

function staleSource(reason, sourcePhaseRunId, source) {
  return {
    sourceStatus: "stale",
    sourceStatusReasons: [reason],
    sourcePhaseRunId: sourcePhaseRunId || null,
    sourceEvidenceRevision: positiveIntegerOrNull(source?.sourceEvidenceRevision),
    sourceRetrospectiveVersion: positiveIntegerOrNull(source?.sourceRetrospectiveVersion),
  };
}

function cleanId(value) {
  const id = String(value ?? "").trim();
  return id ? id.slice(0, 240) : "";
}

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
