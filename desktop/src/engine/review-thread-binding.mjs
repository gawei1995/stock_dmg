import { createHash } from "node:crypto";

const REVIEW_PHASES = new Set(["blind", "outcome", "retrospective"]);

/**
 * Build the immutable review identity that may occupy one persistent Codex
 * thread. Evidence revisions are part of the identity: a refreshed evidence
 * set must start a new review thread instead of inheriting conclusions formed
 * from an older snapshot.
 */
export function reviewThreadBindingFromEvidence(evidence) {
  if (evidence?.analysisScope !== "review") return null;
  const context = evidence?.context ?? {};
  const scoped = evidence?.scopedContext ?? {};
  const protocol = cleanText(context.reviewProtocol ?? scoped.reviewProtocol, 80)
    ?? "earnings_case";

  if (protocol === "decision_cycle") {
    const cycleId = requiredText(context.reviewCycleId ?? scoped?.cycle?.id, "复盘周期 ID");
    const phase = String(context.reviewPhase ?? scoped.phase ?? "").trim();
    if (!REVIEW_PHASES.has(phase)) throw new Error("复盘线程阶段无效。");
    const evidenceRevision = positiveIntegerOrNull(
      context.reviewEvidenceRevision
      ?? scoped?.cycle?.brokerAssociation?.evidenceRevision
      ?? scoped?.cycle?.evidenceRevision,
    );
    const retrospectiveVersion = positiveIntegerOrNull(
      context.reviewRetrospectiveVersion ?? scoped?.cycle?.retrospectiveVersion?.version,
    );
    const inputSnapshotHash = cleanText(
      context.reviewInputSnapshotHash ?? scoped?.cycle?.inputSnapshotHash,
      160,
    );
    return freezeBinding({
      version: 1,
      protocol,
      cycleId,
      phase,
      caseIds: [],
      evidenceRevision,
      retrospectiveVersion,
      inputSnapshotHash,
    });
  }

  const caseIds = uniqueStrings(context.reviewCaseIds ?? scoped?.cases?.map((item) => item?.id));
  if (!caseIds.length) throw new Error("复盘线程缺少案例 ID。");
  const revisions = (Array.isArray(context.reviewEvidenceRevisions)
    ? context.reviewEvidenceRevisions
    : Array.isArray(scoped.basedOnEvidenceRevisions)
      ? scoped.basedOnEvidenceRevisions
      : [])
    .map((item) => ({
      caseId: cleanText(item?.caseId, 200),
      revision: positiveIntegerOrNull(item?.revision),
    }))
    .filter((item) => item.caseId)
    .sort((left, right) => left.caseId.localeCompare(right.caseId));
  return freezeBinding({
    version: 1,
    protocol: "earnings_case",
    cycleId: null,
    phase: null,
    caseIds,
    evidenceRevision: null,
    retrospectiveVersion: null,
    inputSnapshotHash: hashValue(revisions),
  });
}

export function normalizeReviewThreadBinding(value) {
  if (!value || typeof value !== "object") return null;
  try {
    const protocol = cleanText(value.protocol, 80);
    if (protocol === "decision_cycle") {
      const phase = String(value.phase ?? "").trim();
      if (!REVIEW_PHASES.has(phase)) return null;
      return freezeBinding({
        version: 1,
        protocol,
        cycleId: requiredText(value.cycleId, "复盘周期 ID"),
        phase,
        caseIds: [],
        evidenceRevision: positiveIntegerOrNull(value.evidenceRevision),
        retrospectiveVersion: positiveIntegerOrNull(value.retrospectiveVersion),
        inputSnapshotHash: cleanText(value.inputSnapshotHash, 160),
      });
    }
    if (protocol !== "earnings_case") return null;
    const caseIds = uniqueStrings(value.caseIds);
    if (!caseIds.length) return null;
    return freezeBinding({
      version: 1,
      protocol,
      cycleId: null,
      phase: null,
      caseIds,
      evidenceRevision: null,
      retrospectiveVersion: null,
      inputSnapshotHash: cleanText(value.inputSnapshotHash, 160),
    });
  } catch {
    return null;
  }
}

export function assertReviewThreadBinding(existing, requested) {
  const current = normalizeReviewThreadBinding(existing);
  const next = normalizeReviewThreadBinding(requested);
  if (!next) throw new Error("本轮复盘缺少可验证的线程绑定。");
  if (!current) return next;
  if (bindingKey(current) !== bindingKey(next)) {
    throw new Error("该 Codex 对话已绑定另一复盘周期、阶段、案例集或证据版本；请新建独立复盘对话，避免上下文串线。");
  }
  return current;
}

export function reviewThreadBindingContext(value) {
  const binding = normalizeReviewThreadBinding(value);
  if (!binding) return null;
  return binding.protocol === "decision_cycle"
    ? {
      reviewProtocol: binding.protocol,
      reviewCycleId: binding.cycleId,
      reviewPhase: binding.phase,
      reviewEvidenceRevision: binding.evidenceRevision,
      reviewRetrospectiveVersion: binding.retrospectiveVersion,
      reviewInputSnapshotHash: binding.inputSnapshotHash,
    }
    : {
      reviewProtocol: binding.protocol,
      reviewCaseIds: binding.caseIds,
    };
}

function bindingKey(value) {
  return JSON.stringify({
    protocol: value.protocol,
    cycleId: value.cycleId,
    phase: value.phase,
    caseIds: value.caseIds,
    evidenceRevision: value.evidenceRevision,
    retrospectiveVersion: value.retrospectiveVersion,
    inputSnapshotHash: value.inputSnapshotHash,
  });
}

function freezeBinding(value) {
  return Object.freeze({
    ...value,
    caseIds: Object.freeze([...value.caseIds]),
  });
}

function requiredText(value, label) {
  const text = cleanText(value, 200);
  if (!text) throw new Error(`${label}不能为空。`);
  return text;
}

function cleanText(value, limit) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, limit) : null;
}

function positiveIntegerOrNull(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean))].sort();
}

function hashValue(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
