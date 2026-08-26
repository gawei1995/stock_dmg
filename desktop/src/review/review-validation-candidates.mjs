const FORWARD_RANK = Object.freeze({
  forward: 3,
  overlapping: 2,
  historical: 1,
  unknown: 0,
});

/**
 * Builds the host-owned candidate list used by the validation center.
 *
 * Completed historical reviews are deliberately kept as exploratory
 * candidates instead of disappearing behind the observation-start cutoff.
 * They remain manual, non-formal observations; only cycles whose activity
 * starts after the frozen protocol are labelled as forward candidates.
 */
export function buildValidationCandidateIndex({ tests = [], cycles = [], now = Date.now(), limit = 100 } = {}) {
  const rows = Array.isArray(cycles) ? cycles : [];
  const cycleById = new Map(rows.map((cycle) => [cleanId(cycle?.id), cycle]));
  const result = {};

  for (const test of Array.isArray(tests) ? tests : []) {
    const testId = cleanId(test?.id);
    if (!testId || test?.testKind !== "protocol" || !Array.isArray(test?.samples)) continue;
    const sourceCycleId = cleanId(test?.sourceReviewCycleId);
    const sourceCycle = cycleById.get(sourceCycleId) ?? null;
    const included = new Set(test.samples.map((sample) => cleanId(sample?.reviewCycleId)).filter(Boolean));
    const candidates = [];

    for (const cycle of rows) {
      const candidateCycleId = cleanId(cycle?.id);
      if (!candidateCycleId || candidateCycleId === sourceCycleId || included.has(candidateCycleId)) continue;
      if (String(cycle?.status ?? "").toLowerCase() === "cancelled") continue;
      const reviewRun = currentValidationReviewRun(cycle);
      if (!reviewRun) continue;
      const endAt = parseTime(cycle?.endAt);
      if (!Number.isFinite(endAt) || endAt > Number(now)) continue;

      const timing = validationCandidateTiming(cycle, test?.observationStartedAt ?? test?.registeredAt);
      const relevance = validationCandidateRelevance({ test, cycle, sourceCycle });
      candidates.push({
        cycleId: candidateCycleId,
        timing,
        relevance: relevance.label,
        relevanceScore: relevance.score,
        reviewCompletedAt: reviewRun.completedAt ?? reviewRun.recordedAt ?? null,
        reason: candidateReason(timing, relevance),
      });
    }

    candidates.sort((left, right) => (
      (FORWARD_RANK[right.timing] ?? 0) - (FORWARD_RANK[left.timing] ?? 0)
      || right.relevanceScore - left.relevanceScore
      || parseTime(right.reviewCompletedAt) - parseTime(left.reviewCompletedAt)
    ));
    result[testId] = candidates.slice(0, Math.max(1, Number(limit) || 100));
  }

  return result;
}

/** Latest completed phase run that still cites the cycle's current evidence. */
export function currentValidationReviewRun(cycle) {
  const phase = validationReviewPhase(cycle);
  const runs = Array.isArray(cycle?.phaseRuns?.[phase]) ? cycle.phaseRuns[phase] : [];
  const currentEvidenceRevision = positiveInteger(
    cycle?.evidenceRevision ?? cycle?.brokerLinks?.evidenceRevision ?? cycle?.brokerLinks?.revision,
  );
  if (!currentEvidenceRevision) return null;
  const currentRetrospectiveVersion = phase === "retrospective"
    ? positiveInteger((Array.isArray(cycle?.retrospectiveVersions) ? cycle.retrospectiveVersions : [])
      .filter((item) => item?.integrityStatus !== "mismatch")
      .at(-1)?.version)
    : null;
  if (phase === "retrospective" && !currentRetrospectiveVersion) return null;

  return runs.filter((run) => (
    String(run?.status ?? "").toLowerCase() === "completed"
    && run?.integrityStatus === "valid"
    && positiveInteger(run?.evidenceRevision) === currentEvidenceRevision
    && (cycle?.brokerEvidenceAudit?.requiresPolicyV2Run !== true
      || Number(run?.evidenceFilterPolicyVersion ?? 0) >= 2)
    && (phase !== "retrospective"
      || positiveInteger(run?.retrospectiveVersion) === currentRetrospectiveVersion)
  )).at(-1) ?? null;
}

export function validationCandidateTiming(cycle, observationStartedAt) {
  const boundary = parseTime(observationStartedAt);
  const startAt = parseTime(cycle?.startAt);
  const endAt = parseTime(cycle?.endAt);
  if (!Number.isFinite(boundary) || !Number.isFinite(startAt) || !Number.isFinite(endAt)) return "unknown";
  if (startAt >= boundary) return "forward";
  if (endAt >= boundary) return "overlapping";
  return "historical";
}

function validationReviewPhase(cycle) {
  const reviewMode = String(cycle?.reviewMode ?? "").toLowerCase();
  const cycleType = String(cycle?.cycleType ?? cycle?.type ?? "").toLowerCase();
  return reviewMode === "lightweight" || (!reviewMode && cycleType === "trade_window")
    ? "retrospective"
    : "outcome";
}

function validationCandidateRelevance({ test, cycle, sourceCycle }) {
  const sourceSymbols = symbolSet(sourceCycle);
  const candidateSymbols = [...symbolSet(cycle)];
  const symbolOverlap = candidateSymbols.some((symbol) => sourceSymbols.has(symbol));
  const sameType = String(cycle?.cycleType ?? cycle?.type ?? "")
    === String(sourceCycle?.cycleType ?? sourceCycle?.type ?? "");
  const searchable = `${test?.cohort ?? ""} ${test?.hypothesis ?? ""} ${test?.strategyFamily ?? ""}`.toUpperCase();
  const cohortSymbol = candidateSymbols.some((symbol) => searchable.includes(symbol.replace(/\.[A-Z]+$/, "")));
  const score = Number(symbolOverlap) * 4 + Number(sameType) * 2 + Number(cohortSymbol);
  return {
    score,
    label: score >= 6 ? "high" : score >= 2 ? "related" : "review",
  };
}

function candidateReason(timing, relevance) {
  const timingLabel = ({
    forward: "开始观察后发生",
    overlapping: "跨越开始观察边界",
    historical: "开始观察前已发生，仅作历史探索",
    unknown: "周期时间边界待核对",
  })[timing];
  const relevanceLabel = ({ high: "高度相关", related: "同类周期", review: "需人工核对" })[relevance.label];
  return `${timingLabel} · ${relevanceLabel}`;
}

function symbolSet(cycle) {
  return new Set([
    ...(Array.isArray(cycle?.symbols) ? cycle.symbols : []),
    cycle?.symbol,
  ].map((value) => String(value ?? "").trim().toUpperCase()).filter(Boolean));
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function parseTime(value) {
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? time : Number.NaN;
}

function cleanId(value) {
  return String(value ?? "").trim();
}
