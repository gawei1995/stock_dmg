import { canonicalReviewEvidenceIdentity, phaseRunFollowsLegacyMigration } from "./review-learning-source.mjs";

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
export function buildValidationCandidateIndex(options = {}) {
  return buildValidationCandidateReport(options).candidatesByTest;
}

export function buildValidationCandidateReport({ tests = [], cycles = [], now = Date.now(), limit = 100 } = {}) {
  const rows = Array.isArray(cycles) ? cycles : [];
  const cycleById = new Map(rows.map((cycle) => [cleanId(cycle?.id), cycle]));
  const result = {};
  const exclusionsByTest = {};

  for (const test of Array.isArray(tests) ? tests : []) {
    const testId = cleanId(test?.id);
    if (!testId || test?.testKind !== "protocol" || !Array.isArray(test?.samples)) continue;
    const sourceCycleId = cleanId(test?.sourceReviewCycleId);
    const sourceCycle = cycleById.get(sourceCycleId) ?? null;
    const sourceIdentity = sourceCycle ? canonicalReviewEvidenceIdentity(sourceCycle) : null;
    const sourceCaseId = sourceIdentity?.sourceCaseId || cleanId(test?.sourceCaseId ?? test?.caseId);
    const sourceAccountScopeId = sourceIdentity?.accountScopeId || cleanId(test?.accountScopeId);
    const included = new Set(test.samples.map((sample) => cleanId(sample?.reviewCycleId)).filter(Boolean));
    const includedIdentities = new Set(test.samples.map((sample) => {
      const linkedCycle = cycleById.get(cleanId(sample?.reviewCycleId));
      return linkedCycle ? canonicalReviewEvidenceIdentity(linkedCycle).key : sample?.canonicalEvidenceIdentity?.key;
    }).filter(Boolean));
    const candidates = [];
    const exclusions = [];
    const exclude = (cycleId, reason, identity = null, duplicateOfCycleId = null) => exclusions.push({
      cycleId, reason, canonicalEvidenceIdentity: identity, duplicateOfCycleId,
    });

    for (const cycle of rows) {
      const candidateCycleId = cleanId(cycle?.id);
      if (!candidateCycleId) continue;
      const identity = canonicalReviewEvidenceIdentity(cycle);
      if (!identity.key) { exclude(candidateCycleId, identity.reason, identity); continue; }
      const matchesLegacySourceCase = sourceCaseId && identity.sourceCaseId === sourceCaseId
        && (!sourceAccountScopeId || identity.accountScopeId === sourceAccountScopeId);
      if (candidateCycleId === sourceCycleId || (sourceIdentity?.key && identity.key === sourceIdentity.key)
        || matchesLegacySourceCase) {
        exclude(candidateCycleId, "same_evidence_as_hypothesis_source", identity, sourceCycleId || null); continue;
      }
      const includedLegacyCase = identity.sourceCaseId && test.samples.some((sample) => (
        cleanId(sample?.caseId ?? sample?.sourceCaseId) === identity.sourceCaseId
        && (!cleanId(sample?.accountScopeId) || cleanId(sample.accountScopeId) === identity.accountScopeId)
      ));
      if (included.has(candidateCycleId) || includedIdentities.has(identity.key) || includedLegacyCase) {
        exclude(candidateCycleId, "same_evidence_already_included", identity); continue;
      }
      if (String(cycle?.status ?? "").toLowerCase() === "cancelled") continue;
      const reviewRun = currentValidationReviewRun(cycle);
      if (!reviewRun) { exclude(candidateCycleId, "no_current_cycle_phase_run", identity); continue; }
      const endAt = parseTime(cycle?.endAt);
      if (!Number.isFinite(endAt) || endAt > Number(now)) continue;

      const technicalValidation = compactTechnicalValidationCandidate(reviewRun?.result?.technicalValidation);
      const timing = validationCandidateTiming(
        cycle,
        test?.observationStartedAt ?? test?.registeredAt,
        technicalValidation,
      );
      const relevance = validationCandidateRelevance({ test, cycle, sourceCycle });
      candidates.push({
        cycleId: candidateCycleId,
        canonicalEvidenceIdentity: identity,
        timing,
        relevance: relevance.label,
        relevanceScore: relevance.score,
        reviewCompletedAt: reviewRun.completedAt ?? reviewRun.recordedAt ?? null,
        reason: candidateReason(timing, relevance),
        technicalValidation: classifyTechnicalValidationForProtocol(technicalValidation, timing),
      });
    }

    candidates.sort((left, right) => (
      (FORWARD_RANK[right.timing] ?? 0) - (FORWARD_RANK[left.timing] ?? 0)
      || right.relevanceScore - left.relevanceScore
      || parseTime(right.reviewCompletedAt) - parseTime(left.reviewCompletedAt)
      || left.cycleId.localeCompare(right.cycleId)
    ));
    const uniqueCandidates = [];
    const selectedIdentities = new Map();
    for (const candidate of candidates) {
      const duplicate = selectedIdentities.get(candidate.canonicalEvidenceIdentity.key);
      if (duplicate) {
        exclude(candidate.cycleId, "duplicate_legacy_evidence", candidate.canonicalEvidenceIdentity, duplicate.cycleId);
      } else {
        selectedIdentities.set(candidate.canonicalEvidenceIdentity.key, candidate);
        uniqueCandidates.push(candidate);
      }
    }
    result[testId] = uniqueCandidates.slice(0, Math.max(1, Number(limit) || 100));
    exclusionsByTest[testId] = exclusions;
  }

  return { candidatesByTest: result, exclusionsByTest };
}

function compactTechnicalValidationCandidate(value) {
  if (!value || typeof value !== "object") {
    return {
      status: "unavailable",
      reason: "该复盘没有持久化的入场前技术雷达样本。",
      validationMode: null,
      sampleStatus: null,
      eligibleForFormalStatistics: false,
      ruleKey: null,
      radarTradingDate: null,
      radarRecordedAt: null,
      entryCutoffAt: null,
      exitAt: null,
    };
  }
  const validationMode = String(value?.validationMode?.classification ?? "").trim() || null;
  const sampleStatus = String(value?.sampleCandidate?.status ?? "").trim() || null;
  const reasonCodes = Array.isArray(value?.reasonCodes)
    ? value.reasonCodes.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, 12)
    : [];
  return {
    status: String(value?.status ?? "unavailable"),
    reason: reasonCodes.length ? reasonCodes.join(" · ") : null,
    validationMode,
    sampleStatus,
    eligibleForFormalStatistics: value?.sampleCandidate?.eligibleForFormalStatistics === true,
    ruleKey: cleanId(value?.ruleCandidate?.ruleKey) || null,
    radarTradingDate: cleanId(value?.entrySnapshot?.batch?.tradingDate) || null,
    radarRecordedAt: value?.entrySnapshot?.batch?.recordedAt ?? null,
    entryCutoffAt: value?.cycle?.entryCutoffAt ?? value?.evidenceBinding?.entryCutoffAt ?? null,
    exitAt: value?.cycle?.exitAt ?? value?.evidenceBinding?.exitAt ?? null,
    resultHash: cleanId(value?.resultHash) || null,
    sampleId: cleanId(value?.sampleCandidate?.sampleId) || null,
  };
}

function classifyTechnicalValidationForProtocol(value, timing) {
  const forwardTiming = timing === "forward";
  return {
    ...value,
    protocolTiming: timing,
    validationMode: forwardTiming ? "walk_forward_candidate" : "historical_calibration",
    eligibleForFormalStatistics: false,
    formalEligibilityReason: forwardTiming
      ? "需在纳入时绑定冻结协议哈希，并由确定性结果引擎核验；候选列表本身不能晋级样本。"
      : "交易入场不晚于观察协议边界，只能作为历史/跨界校准。",
  };
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
    && phaseRunFollowsLegacyMigration(cycle, run)
  )).at(-1) ?? null;
}

export function validationCandidateTiming(cycle, observationStartedAt, technicalValidation = null) {
  const boundary = parseTime(observationStartedAt);
  const startAt = parseTime(technicalValidation?.entryCutoffAt ?? cycle?.startAt);
  const endAt = parseTime(technicalValidation?.exitAt ?? cycle?.endAt);
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
