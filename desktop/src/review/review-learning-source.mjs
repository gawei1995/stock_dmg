/**
 * Cross-ledger provenance for AI validation packages.
 *
 * ReviewStore owns protocols/rules while ReviewCycleStore owns the immutable
 * Agent phase run that produced them. This module joins the two read models so
 * a broker-evidence correction cannot leave an old learning proposal looking
 * current or accepting new samples.
 */

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
  if (!sourceReviewCycleId || (!sourceRunId && !sourcePhaseRunId)) {
    return {
      sourceStatus: "untracked",
      sourceStatusReasons: [],
      sourcePhaseRunId: sourcePhaseRunId || null,
      sourceEvidenceRevision: positiveIntegerOrNull(source?.sourceEvidenceRevision),
      sourceRetrospectiveVersion: positiveIntegerOrNull(source?.sourceRetrospectiveVersion),
    };
  }

  const cycle = (cycleWorkspace?.cycles ?? []).find((item) => String(item?.id ?? "") === sourceReviewCycleId);
  if (!cycle) return staleSource("source_cycle_missing", sourcePhaseRunId, source);
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
