import { createHash } from "node:crypto";
import {
  normalizeDecimalString,
  validateNumericEvidence,
} from "./numeric-evidence.mjs";

export const NUMERIC_CLAIM_AUDIT_VERSION = "numeric-claim-audit/v2";

const CLAIM_DEFINITIONS = Object.freeze([
  Object.freeze({
    claimId: "model_initial_additional_weight",
    role: "model_proposal",
    metric: "candidate.sizing.model_initial_additional_weight_percent",
    path: ["modelProposal", "initialAdditionalWeightPercent"],
    unitBasis: "portfolio_net_assets",
    label: "LLM 建议初始新增仓位",
  }),
  Object.freeze({
    claimId: "model_max_total_weight",
    role: "model_proposal",
    metric: "candidate.sizing.model_max_total_weight_percent",
    path: ["modelProposal", "maxTotalWeightPercent"],
    unitBasis: "portfolio_net_assets",
    label: "LLM 建议最大总仓位",
  }),
  Object.freeze({
    claimId: "model_stress_loss",
    role: "model_proposal",
    metric: "candidate.sizing.model_stress_loss_percent",
    path: ["modelProposal", "stressTest", "lossPercent"],
    unitBasis: "candidate_position_notional",
    label: "LLM 建议压力损失",
  }),
  Object.freeze({
    claimId: "model_exit_slippage",
    role: "model_proposal",
    metric: "candidate.sizing.model_exit_slippage_percent",
    path: ["modelProposal", "stressTest", "slippagePercent"],
    unitBasis: "candidate_position_notional",
    label: "LLM 建议退出滑点",
  }),
  Object.freeze({
    claimId: "host_invalidation_reference",
    role: "host_decision",
    metric: "candidate.sizing.accepted_invalidation_reference_price",
    path: ["accepted", "referenceLevel"],
    unitKind: "price",
    requiredMetricRefs: ["market.last_completed_close"],
    label: "宿主接受失效参考价",
  }),
  Object.freeze({
    claimId: "derived_invalidation_distance",
    role: "derived_metric",
    metric: "candidate.sizing.validated_invalidation_distance_percent",
    path: ["accepted", "riskDistancePercent"],
    unitBasis: "candidate_last_completed_close",
    requiredClaimIds: ["host_invalidation_reference"],
    requiredMetricRefs: ["market.last_completed_close"],
    label: "宿主验证失效距离",
  }),
  Object.freeze({
    claimId: "host_initial_additional_weight",
    role: "host_decision",
    metric: "candidate.sizing.accepted_initial_additional_weight_percent",
    path: ["accepted", "initialAdditionalWeightPercent"],
    unitBasis: "portfolio_net_assets",
    requiredClaimIds: ["model_initial_additional_weight", "host_max_total_weight"],
    allowMissingDependencyWhenNoEntry: true,
    label: "宿主接受初始新增仓位",
  }),
  Object.freeze({
    claimId: "host_max_total_weight",
    role: "host_decision",
    metric: "candidate.sizing.accepted_max_total_weight_percent",
    path: ["accepted", "maxTotalWeightPercent"],
    unitBasis: "portfolio_net_assets",
    requiredClaimIds: ["model_max_total_weight", "host_stress_risk_loss"],
    allowMissingDependencyWhenNoEntry: true,
    label: "宿主接受最大总仓位",
  }),
  Object.freeze({
    claimId: "host_planned_risk_loss",
    role: "host_decision",
    metric: "candidate.sizing.accepted_planned_risk_loss_percent",
    path: ["accepted", "plannedRiskLossPercent"],
    unitBasis: "candidate_position_notional",
    requiredClaimIds: ["derived_invalidation_distance", "model_exit_slippage"],
    label: "宿主采用计划损失",
  }),
  Object.freeze({
    claimId: "host_stress_risk_loss",
    role: "host_decision",
    metric: "candidate.sizing.accepted_stress_risk_loss_percent",
    path: ["accepted", "stressRiskLossPercent"],
    unitBasis: "candidate_position_notional",
    requiredClaimIds: ["model_stress_loss", "host_planned_risk_loss"],
    label: "宿主采用压力损失",
  }),
]);

/**
 * Verify the final candidate sizing contract without inspecting or parsing the
 * model's prose. The structured sizing review is compared to immutable numeric
 * evidence, and host decisions are checked for a reference to the applicable
 * model proposal. The result is an audit index, not an explanation of model
 * reasoning.
 */
export function auditCandidateSizingClaims({
  numericEvidence,
  sizingReview,
  entryAllowed = false,
  sizingValidUntil = null,
} = {}) {
  const issues = [];
  const facts = Array.isArray(numericEvidence?.facts) ? numericEvidence.facts : [];
  const decisionAt = validIsoOrNull(sizingReview?.decisionAt);
  const proposalIds = new Set(normalizedIds(numericEvidence?.sizingDecision?.proposalFactIds));
  const hostDecisionIds = new Set(normalizedIds(
    numericEvidence?.sizingDecision?.hostDecisionFactIds,
  ));
  const derivedMetricIds = new Set(normalizedIds(
    numericEvidence?.sizingDecision?.derivedMetricFactIds,
  ));

  if (!sizingReview || typeof sizingReview !== "object" || Array.isArray(sizingReview)) {
    return finalizeAudit({
      status: "not_applicable",
      decisionAt: null,
      sizingValidUntil,
      entryAllowed: false,
      claims: [],
      issues: [{
        code: "structured_sizing_review_missing",
        severity: "warning",
        claimId: null,
        message: "候选仓位尚无结构化模型建议与宿主裁决。",
      }],
    });
  }
  if (!facts.length) {
    issues.push(issue(
      "numeric_evidence_missing",
      "error",
      null,
      "结构化候选仓位缺少 Numeric Evidence，不能成为可执行裁决。",
    ));
  }
  if (!decisionAt) {
    issues.push(issue(
      "decision_timestamp_missing",
      "error",
      null,
      "结构化候选仓位缺少有效的宿主裁决时间。",
    ));
  }
  const indexedDecisionAt = validIsoOrNull(numericEvidence?.sizingDecision?.decisionAt);
  if (!numericEvidence?.sizingDecision || typeof numericEvidence.sizingDecision !== "object") {
    issues.push(issue(
      "sizing_decision_index_missing",
      "error",
      null,
      "Numeric Evidence 缺少本次候选裁决索引。",
    ));
  } else {
    if (decisionAt && indexedDecisionAt !== decisionAt) {
      issues.push(issue(
        "sizing_decision_time_mismatch",
        "error",
        null,
        "候选裁决索引与结构化结果不属于同一决策时间。",
      ));
    }
    if (typeof numericEvidence.sizingDecision.entryAllowed === "boolean"
      && numericEvidence.sizingDecision.entryAllowed !== (entryAllowed === true)) {
      issues.push(issue(
        "sizing_decision_disposition_mismatch",
        "error",
        null,
        "候选裁决索引与宿主最终准入状态不一致。",
      ));
    }
  }

  const claims = CLAIM_DEFINITIONS.map((definition) => auditClaim({
    definition,
    sizingReview,
    facts,
    decisionAt,
    scopedIds: definition.role === "model_proposal"
      ? proposalIds
      : definition.role === "derived_metric"
        ? derivedMetricIds
        : hostDecisionIds,
    issues,
  }));
  const claimsById = new Map(claims.map((claim) => [claim.claimId, claim]));

  for (const claim of claims) {
    if (claim.status !== "verified") continue;
    for (const requiredClaimId of claim.requiredClaimIds) {
      const required = claimsById.get(requiredClaimId);
      if (!required || required.status === "omitted") {
        if (!entryAllowed && claim.allowMissingDependencyWhenNoEntry) continue;
        issues.push(issue(
          "required_claim_missing",
          "error",
          claim.claimId,
          `${claim.label}缺少必要输入 ${requiredClaimId}。`,
        ));
        claim.status = "failed";
        continue;
      }
      if (required.status !== "verified" || !required.factId || !required.hash) {
        issues.push(issue(
          "required_claim_reference_unverifiable",
          "error",
          claim.claimId,
          `${claim.label}所依赖的 ${requiredClaimId} 未通过校验。`,
        ));
        claim.status = "failed";
        continue;
      }
      if (!hasReference(claim, required)) {
        issues.push(issue(
          "required_claim_reference_missing",
          "error",
          claim.claimId,
          `${claim.label}没有引用 ${requiredClaimId} 的事实哈希。`,
        ));
        claim.status = "failed";
      }
    }
    for (const requiredMetric of claim.requiredMetricRefs) {
      const requiredFacts = facts.flatMap((fact) => {
        if (fact?.metric !== requiredMetric) return [];
        try {
          return [validateNumericEvidence(fact)];
        } catch {
          return [];
        }
      });
      const referencedFacts = requiredFacts.filter((fact) => hasReference(claim, fact));
      if (referencedFacts.length !== 1) {
        issues.push(issue(
          "required_metric_reference_missing",
          "error",
          claim.claimId,
          `${claim.label}没有唯一引用 ${requiredMetric} 的有效事实。`,
        ));
        claim.status = "failed";
      } else if (claim.unit === "price" && requiredMetric === "market.last_completed_close") {
        const close = referencedFacts[0];
        if (close.availability !== "known" || close.unit.kind !== "price"
          || close.unit.currency !== claim.unitDetail.currency
          || close.unit.symbol !== claim.unitDetail.symbol) {
          issues.push(issue(
            "claim_price_unit_reference_mismatch",
            "error",
            claim.claimId,
            `${claim.label}必须与其引用的已知收盘价使用同一标的和币种。`,
          ));
          claim.status = "failed";
        }
      }
    }
  }

  const errorCount = issues.filter((item) => item.severity === "error").length;
  const warningCount = issues.filter((item) => item.severity === "warning").length;
  const status = errorCount ? "failed" : warningCount ? "degraded" : "verified";
  return finalizeAudit({
    status,
    decisionAt,
    sizingValidUntil,
    entryAllowed,
    claims,
    issues,
  });
}

/**
 * Produce a deterministic disclosure that can be placed before model Markdown.
 * It is built only from verified structured claims and never parses prose.
 */
export function candidateNumericAuthorityMarkdown(audit) {
  if (!audit || audit.status === "not_applicable") return "";
  if (audit.status !== "verified") {
    return [
      `> **NUMERIC AUTHORITY · ${String(audit.status).toUpperCase()}**`,
      "> 结构化数值主张未通过宿主审计，本轮不产生可执行仓位。下方 Codex 内容仅作研究叙述，不是仓位裁决。",
      "",
      "## Codex 分析 · NARRATIVE ONLY",
    ].join("\n");
  }

  const modelInitial = claimValue(audit, "model_initial_additional_weight");
  const modelMax = claimValue(audit, "model_max_total_weight");
  const hostInitial = claimValue(audit, "host_initial_additional_weight");
  const hostMax = claimValue(audit, "host_max_total_weight");
  const disposition = audit.executionAuthorized ? "HOST ACCEPTED" : "NO ENTRY";
  return [
    "> **NUMERIC AUTHORITY · VERIFIED**",
    `> LLM PROPOSAL：初始 ${asPercent(modelInitial)} · 最大 ${asPercent(modelMax)}；${disposition}：初始 ${asPercent(hostInitial)} · 最大 ${asPercent(hostMax)}。只有 HOST DECISION 与其 factId 是最终仓位口径。`,
    "> 下方 Codex Markdown 仅解释判断与条件，不会覆盖宿主裁决。",
    "",
    "## Codex 分析 · NARRATIVE ONLY",
  ].join("\n");
}

/**
 * Prevent model-authored Markdown from impersonating reserved host authority
 * labels. This does not inspect numbers or infer claims from prose; it only
 * isolates labels owned by the deterministic host UI.
 */
export function isolateCandidateNarrativeMarkdown(value) {
  return String(value ?? "")
    .replace(/\bNUMERIC\s+AUTHORITY\b/giu, "MODEL NARRATIVE")
    .replace(/\bHOST\s+(?:ACCEPTED|DECISION|BOUNDED|BLOCKED|ADJUDICATION)\b/giu, "MODEL NARRATIVE")
    .replace(/\bNO\s+ENTRY\b/giu, "MODEL NARRATIVE · NO-ENTRY CLAIM");
}

function auditClaim({
  definition,
  sizingReview,
  facts,
  decisionAt,
  scopedIds,
  issues,
}) {
  const expectedRaw = getPath(sizingReview, definition.path);
  const expectedValue = canonicalFiniteOrNull(expectedRaw);
  const expectedPresent = expectedValue != null;
  let candidates = facts.filter((fact) => fact?.metric === definition.metric);
  if (scopedIds.size) {
    candidates = candidates.filter((fact) => scopedIds.has(String(fact?.factId ?? "")));
  }
  if (decisionAt) {
    const sameDecision = candidates.filter((fact) => fact?.asOf?.effectiveAt === decisionAt);
    if (sameDecision.length) candidates = sameDecision;
  }

  const base = {
    claimId: definition.claimId,
    role: definition.role,
    authority: definition.role === "host_decision" ? "final" : "proposal_only",
    metric: definition.metric,
    label: definition.label,
    requiredClaimIds: [...(definition.requiredClaimIds ?? [])],
    requiredMetricRefs: [...(definition.requiredMetricRefs ?? [])],
    allowMissingDependencyWhenNoEntry:
      definition.allowMissingDependencyWhenNoEntry === true,
    expectedValue,
    value: null,
    unit: definition.unitKind ?? "percent_point",
    expectedBasis: definition.unitBasis ?? null,
    unitDetail: null,
    factId: null,
    hash: null,
    inputRefs: [],
    status: expectedPresent ? "failed" : "omitted",
  };

  if (!expectedPresent) {
    if (candidates.length) {
      issues.push(issue(
        "unexpected_numeric_fact",
        "error",
        definition.claimId,
        `${definition.label}在结构化结果中为空，但事实包包含该数值。`,
      ));
      return { ...base, status: "failed" };
    }
    return base;
  }
  if (!candidates.length) {
    issues.push(issue(
      "claim_fact_missing",
      "error",
      definition.claimId,
      `${definition.label}缺少对应的数值事实。`,
    ));
    return base;
  }
  if (candidates.length !== 1) {
    issues.push(issue(
      "claim_fact_ambiguous",
      "error",
      definition.claimId,
      `${definition.label}对应多个事实，无法确定本次裁决版本。`,
    ));
    return base;
  }

  let fact;
  try {
    fact = validateNumericEvidence(candidates[0]);
  } catch {
    issues.push(issue(
      "claim_fact_invalid",
      "error",
      definition.claimId,
      `${definition.label}的结构或内容哈希无效。`,
    ));
    return base;
  }
  const actualValue = fact.availability === "known" ? fact.value : null;
  const result = {
    ...base,
    value: actualValue,
    factId: fact.factId,
    hash: fact.hash,
    inputRefs: fact.provenance.inputRefs,
    unitDetail: fact.unit,
  };
  if (fact.kind !== definition.role) {
    issues.push(issue(
      "claim_role_mismatch",
      "error",
      definition.claimId,
      `${definition.label}被标记为 ${fact.kind}，预期为 ${definition.role}。`,
    ));
    return result;
  }
  const expectedUnitKind = definition.unitKind ?? "percent_point";
  if (fact.unit.kind !== expectedUnitKind) {
    issues.push(issue(
      "claim_unit_mismatch",
      "error",
      definition.claimId,
      `${definition.label}必须使用明确的 ${expectedUnitKind} 单位。`,
    ));
    return result;
  }
  if (definition.unitBasis && fact.unit.basis !== definition.unitBasis) {
    issues.push(issue(
      "claim_unit_basis_mismatch",
      "error",
      definition.claimId,
      `${definition.label}的百分比基准必须是 ${definition.unitBasis}。`,
    ));
    return result;
  }
  if (actualValue !== expectedValue) {
    issues.push(issue(
      "claim_value_mismatch",
      "error",
      definition.claimId,
      `${definition.label}与最终结构化候选结果不一致。`,
    ));
    return result;
  }
  if (decisionAt && fact.asOf.effectiveAt !== decisionAt) {
    issues.push(issue(
      "claim_decision_time_mismatch",
      "error",
      definition.claimId,
      `${definition.label}不属于本次宿主裁决时间。`,
    ));
    return result;
  }
  return { ...result, status: "verified" };
}

function finalizeAudit({
  status,
  decisionAt,
  sizingValidUntil,
  entryAllowed,
  claims,
  issues,
}) {
  const executionAuthorized = status === "verified" && entryAllowed === true;
  const body = {
    schemaVersion: NUMERIC_CLAIM_AUDIT_VERSION,
    status,
    executionAuthority: "host_decision_only",
    markdownAuthority: "narrative_only",
    naturalLanguageInspected: false,
    decisionAt,
    sizingValidUntil: validIsoOrNull(sizingValidUntil),
    entryAllowedBySizingEngine: entryAllowed === true,
    executionAuthorized,
    claimIndex: claims.map((claim) => ({ ...claim, inputRefs: [...claim.inputRefs] })),
    issues: issues.map((item) => ({ ...item })),
    verifiedClaimCount: claims.filter((claim) => claim.status === "verified").length,
    omittedClaimCount: claims.filter((claim) => claim.status === "omitted").length,
  };
  const auditHash = `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
  return deepFreeze({ ...body, auditHash });
}

function claimValue(audit, claimId) {
  const claim = audit.claimIndex.find((item) => item.claimId === claimId);
  return claim?.status === "verified" ? claim.value : null;
}

function hasReference(claim, evidence) {
  return claim.inputRefs.some((ref) => (
    ref.factId === evidence.factId && ref.hash === evidence.hash
  ));
}

function getPath(value, path) {
  return path.reduce((current, key) => current?.[key], value);
}

function canonicalFiniteOrNull(value) {
  if (value == null || typeof value === "boolean" || String(value).trim() === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  try {
    return normalizeDecimalString(value);
  } catch {
    return null;
  }
}

function normalizedIds(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))]
    : [];
}

function validIsoOrNull(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function asPercent(value) {
  return value == null ? "—" : `${value}%`;
}

function issue(code, severity, claimId, message) {
  return { code, severity, claimId, message };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
