import { createHash } from "node:crypto";
import { activityFallsInReviewMonth } from "./review-calendar.mjs";
import { canonicalReviewEvidenceIdentity } from "./review-learning-source.mjs";
import {
  partitionReviewExecutions,
  partitionReviewOrders,
} from "../data/trade-history-service.mjs";

const REVIEW_PHASES = new Set(["blind", "outcome", "retrospective"]);
const MAX_DELIVERED_TIMELINE_NODES = 100;
const MAX_FROZEN_BLIND_ASSESSMENT_CHARS = 180_000;
const MAX_PORTFOLIO_CONTEXT_POSITIONS = 200;
const MAX_PORTFOLIO_CONTEXT_DETAILS = 20;

/** Build a bounded, time-gated evidence run for a decision review cycle. */
export function buildReviewCycleAnalysisRun({
  workspace,
  archive,
  cycleId,
  phase,
  runId,
  task = "",
  portfolio = null,
  pointInTimeTechnical = null,
  deterministicOutcomeMetrics = null,
  technicalValidation = null,
  reconciliation = null,
  now = () => new Date(),
} = {}) {
  const normalizedPhase = String(phase ?? "").trim();
  if (!REVIEW_PHASES.has(normalizedPhase)) throw new Error("复盘阶段必须是 blind、outcome 或 retrospective。");
  const cycle = (workspace?.cycles ?? []).find((item) => String(item?.id) === String(cycleId ?? ""));
  if (!cycle) throw new Error("未找到复盘周期。");
  const canonicalEvidenceIdentity = canonicalReviewEvidenceIdentity(cycle);
  if (cycle.legacySource && canonicalEvidenceIdentity.status !== "identified") {
    throw new Error(`旧复盘迁移来源无法核验：${canonicalEvidenceIdentity.reason}；请核对原案例与匿名账户作用域。`);
  }
  const eventMetadata = sanitizeCycleEventMetadata(cycle?.eventMetadata);
  if (eventMetadata && eventMetadata.timePrecision !== "exact"
    && (cycle?.reviewMode !== "lightweight" || normalizedPhase !== "retrospective")) {
    throw new Error("只有日期或盘前/盘后精度的事件只能进行轻量事后复盘；不得补造事件时点或放宽盲态门槛。");
  }
  const archiveAccountScopeId = cleanText(archive?.accountScopeId, 160);
  const cycleAccountScopeId = cleanText(cycle?.brokerLinks?.accountScopeId, 160);
  if (archiveAccountScopeId && uniqueStrings(cycle?.brokerLinks?.recordIds).length
    && cycleAccountScopeId !== archiveAccountScopeId) {
    throw new Error(cycleAccountScopeId
      ? "复盘周期与当前长桥历史属于不同匿名账户作用域；已拒绝跨账户分析。"
      : "该旧复盘缺少匿名账户作用域；请在当前账户重新选择订单后再分析。");
  }
  const sealedVersion = latestSealedVersion(cycle);
  if (normalizedPhase !== "retrospective" && !sealedVersion) {
    throw new Error("请先封存事前四字段，再运行阶段一盲态复盘。");
  }
  const blindRuns = cyclePhaseRuns(cycle, "blind").filter(completedPhaseRun);
  if (normalizedPhase === "outcome" && !blindRuns.length) {
    throw new Error("阶段二必须引用已经完成的阶段一盲态复盘。");
  }
  if (normalizedPhase === "outcome" && !cycleOutcomeReady(cycle, now())) {
    throw new Error("该周期尚未结束；请先确认结束时间，再运行阶段二结果复盘。");
  }
  if (normalizedPhase === "retrospective" && !cycleOutcomeReady(cycle, now())) {
    throw new Error("该周期尚未结束；直接事后复盘不能提前读取未来结果。");
  }
  if (normalizedPhase === "retrospective" && !uniqueStrings(cycle?.brokerLinks?.recordIds).length) {
    throw new Error("直接事后复盘需要先关联真实长桥订单或成交。");
  }
  const retrospectiveVersion = normalizedPhase === "retrospective"
    ? latestRetrospectiveVersion(cycle)
    : null;
  if (normalizedPhase === "retrospective" && !retrospectiveVersion) {
    throw new Error("直接事后复盘前，请先保存判断、感悟与未来预判。");
  }

  const cutoffAt = normalizedPhase === "retrospective" ? null : requiredCutoff(sealedVersion);
  const cycleEvidenceEndAt = optionalIso(cycle?.endAt);
  const orderById = new Map((archive?.orders ?? []).map((item) => [String(item?.orderId), item]));
  const executionById = new Map((archive?.executions ?? []).map((item) => [String(item?.tradeId), item]));
  const linkedOrderIds = uniqueStrings(cycle?.brokerLinks?.orderIds);
  const linkedExecutionIds = uniqueStrings(cycle?.brokerLinks?.executionIds);
  const requestedRecordIds = uniqueStrings(cycle?.brokerLinks?.requestedRecordIds);
  const rawLinkedOrders = linkedOrderIds.map((id) => orderById.get(id)).filter(Boolean);
  const rawLinkedExecutions = linkedExecutionIds.map((id) => executionById.get(id)).filter(Boolean);
  const archiveExecutionEligibility = partitionReviewExecutions(
    archive?.executions ?? [],
    archive?.orders ?? [],
  );
  // Derive the linked subset from the full-archive reconciliation. Passing
  // only selected children would hide sibling fills and could miss an
  // impossible parent/child quantity package (the legacy multi-leg shape).
  const rawLinkedExecutionIdSet = new Set(rawLinkedExecutions.map((item) => String(item?.tradeId)));
  const linkedExecutionEligibility = {
    included: archiveExecutionEligibility.included
      .filter((item) => rawLinkedExecutionIdSet.has(String(item?.tradeId))),
    excluded: archiveExecutionEligibility.excluded
      .filter(({ execution }) => rawLinkedExecutionIdSet.has(String(execution?.tradeId))),
  };
  const linkedExecutions = linkedExecutionEligibility.included;
  const excludedAuditExecutions = linkedExecutionEligibility.excluded;
  const linkedOrderEligibility = partitionReviewOrders(rawLinkedOrders, archive?.executions ?? []);
  const linkedOrders = linkedOrderEligibility.included;
  const excludedAuditOrders = linkedOrderEligibility.excluded;
  const eligibleRecordIds = new Set([
    ...linkedOrders.map((item) => `order:${item.orderId}`),
    ...linkedExecutions.map((item) => `execution:${item.tradeId}`),
  ]);
  const eligibleRequestedRecordIds = requestedRecordIds.filter((id) => eligibleRecordIds.has(id));
  const requestedRecordIdSet = new Set(eligibleRequestedRecordIds);
  const reviewableArchiveOrders = partitionReviewOrders(
    archive?.orders ?? [],
    archive?.executions ?? [],
  ).included;
  const reviewableOrderById = new Map(reviewableArchiveOrders.map((item) => [String(item?.orderId), item]));
  const reviewableExecutionById = new Map(archiveExecutionEligibility.included.map((item) => [String(item?.tradeId), item]));
  const cycleEndAt = optionalIso(cycle?.endAt);
  const cycleBoundOrders = cycleEndAt
    ? linkedOrders.filter((item) => atOrBeforeCycleEnd(orderAt(item), cycleEndAt))
    : linkedOrders;
  const cycleBoundExecutions = cycleEndAt
    ? linkedExecutions.filter((item) => atOrBeforeCycleEnd(executionAt(item), cycleEndAt))
    : linkedExecutions;
  const visibleOrders = normalizedPhase === "blind"
    ? cycleBoundOrders.filter((item) => beforeCutoff(orderAt(item), cutoffAt))
    : cycleBoundOrders;
  const visibleExecutions = normalizedPhase === "blind"
    ? cycleBoundExecutions.filter((item) => beforeCutoff(executionAt(item), cutoffAt))
    : cycleBoundExecutions;
  const allCheckpoints = normalizedCheckpoints(cycle);
  const visibleCheckpoints = normalizedPhase === "blind"
    ? allCheckpoints
      .filter((item) => beforeCutoff(item.cutoffAt ?? item.at, cutoffAt))
      .map((item) => ({
        ...item,
        evidence: item.evidence.filter((entry) => beforeCutoff(entry.observedAt, cutoffAt)),
      }))
    : allCheckpoints;
  const blindAssessment = normalizedPhase === "outcome" ? summarizeBlindRun(blindRuns.at(-1)) : null;
  const revealsOutcome = normalizedPhase !== "blind";
  const endingPortfolio = revealsOutcome
    ? sanitizeCycleEndPortfolio(
      cycle?.endingPortfolio ?? cycle?.outcome?.endingPortfolio,
      cycle?.startAt,
      cycleEndAt,
    )
    : null;
  const currentPortfolioContext = revealsOutcome
    ? sanitizePortfolioSnapshot(portfolio)
    : null;
  const cycleType = normalizeCycleType(cycle?.type ?? cycle?.cycleType);
  const evidenceGrade = normalizedPhase === "retrospective"
    ? "retrospective"
    : normalizeEvidenceGrade(
      sealedVersion?.evidenceGrade
        ?? sealedVersion?.timing
        ?? cycle?.evidenceGrade,
    );
  const missingOrderIds = linkedOrderIds.filter((id) => !orderById.has(id));
  const missingExecutionIds = linkedExecutionIds.filter((id) => !executionById.has(id));
  const decisionTimeline = normalizedPhase === "blind"
    ? hydrateDecisionTimeline({
      timeline: cycle?.decisionTimeline,
      orderById: reviewableOrderById,
      executionById: reviewableExecutionById,
      pointInTimeTechnical,
      cycleStartAt: cycle?.startAt,
      cycleEndAt,
    })
    : [];
  const analysisTask = String(task || defaultCycleTask({ cycle, cycleType, phase: normalizedPhase }))
    .trim()
    .slice(0, 4_000);
  const knowledgeCutoffAt = normalizedPhase === "blind"
    ? decisionTimeline.at(-1)?.knowledgeCutoffAt ?? cutoffAt
    : null;
  const snapshotAt = normalizedPhase === "blind"
    ? knowledgeCutoffAt
    : archive?.syncedAt ?? workspace?.updatedAt ?? now().toISOString();
  const evidenceRevision = positiveRevision(
    cycle?.evidenceRevision ?? cycle?.brokerLinks?.evidenceRevision ?? cycle?.brokerLinks?.revision,
  );
  if (revealsOutcome && reconciliation != null && (
    reconciliation.schemaVersion !== "review-reconciliation/v1"
    || reconciliation.cycleId !== cycle.id
    || reconciliation.cycleEvidenceRevision !== evidenceRevision
    || reconciliation.accountScopeId !== (cycleAccountScopeId || null)
    || reconciliation.window?.startAt !== optionalIso(cycle.startAt)
    || reconciliation.window?.endAt !== optionalIso(cycle.endAt)
  )) throw new Error("收益对账状态与本次周期、账户、证据版本或时间范围不一致；请重新生成对账证据。");
  const inputSnapshotHash = cleanText(workspace?.snapshotHash, 128);

  return {
    id: String(runId || `cycle-review-${Date.now()}`),
    // Runtime timestamps are not decision-time evidence. Withhold the actual
    // creation time from a blind projection instead of leaking a post-cutoff
    // clock value (or mislabelling the cutoff as the creation time).
    createdAt: normalizedPhase === "blind" ? null : now().toISOString(),
    elapsedMs: 0,
    task: analysisTask,
    state: normalizedPhase === "blind"
      ? "REVIEW_CYCLE_BLIND_READY"
      : normalizedPhase === "outcome" ? "REVIEW_CYCLE_OUTCOME_READY" : "REVIEW_CYCLE_RETROSPECTIVE_READY",
    context: {
      scope: "review",
      reviewProtocol: "decision_cycle",
      reviewCycleId: String(cycle.id),
      reviewPhase: normalizedPhase,
      reviewRetrospectiveVersion: retrospectiveVersion?.version ?? null,
      reviewEvidenceRevision: evidenceRevision,
      reviewInputSnapshotHash: inputSnapshotHash,
      knowledgeCutoffAt,
      cycleType,
      blindAssessmentId: blindAssessment?.assessmentId ?? null,
      snapshotAt,
      valuationSchemaVersion: portfolio?.valuationSchemaVersion ?? null,
    },
    analysisContext: {
      scope: "review",
      reviewProtocol: "decision_cycle",
      phase: normalizedPhase,
      timeFirewall: {
        cutoffAt,
        cycleEvidenceEndAt: normalizedPhase === "retrospective" ? cycleEvidenceEndAt : null,
        retrospectiveHasNoKnowledgeCutoff: normalizedPhase === "retrospective",
        futureEvidencePhysicallyExcluded: normalizedPhase === "blind"
          && decisionTimeline.length <= 1,
        firewallScope: normalizedPhase === "blind" && decisionTimeline.length
          ? decisionTimeline.length === 1
            ? "single_node_physical_cutoff"
            : "multi_node_logical_gating_plus_post_last_node_exclusion"
          : "single_phase_cutoff",
        formalBlindEligible: normalizedPhase === "blind" && decisionTimeline.length <= 1,
        externalToolsHostBlocked: normalizedPhase === "blind",
        decisionTimelineNodeCount: decisionTimeline.length,
        latestTimelineCutoffAt: knowledgeCutoffAt ?? cutoffAt,
        nodeCapsulesShareSingleModelRequest: normalizedPhase === "blind" && decisionTimeline.length > 0,
        hiddenOrderCount: revealsOutcome ? linkedOrders.length - visibleOrders.length : undefined,
        hiddenExecutionCount: revealsOutcome ? linkedExecutions.length - visibleExecutions.length : undefined,
        postCycleOrderCount: revealsOutcome ? linkedOrders.length - cycleBoundOrders.length : undefined,
        postCycleExecutionCount: revealsOutcome ? linkedExecutions.length - cycleBoundExecutions.length : undefined,
        preCycleOrderCount: revealsOutcome
          ? linkedOrders.filter((item) => beforeStart(orderAt(item), cycle?.startAt)).length
          : undefined,
        preCycleExecutionCount: revealsOutcome
          ? linkedExecutions.filter((item) => beforeStart(executionAt(item), cycle?.startAt)).length
          : undefined,
        hiddenCheckpointCount: revealsOutcome ? allCheckpoints.length - visibleCheckpoints.length : undefined,
        outcomeAvailable: revealsOutcome,
      },
      cycle: {
        id: String(cycle.id),
        type: cycleType,
        reviewMode: cleanText(cycle?.reviewMode, 40) ?? "rigorous",
        title: cleanText(cycle?.title, 240),
        scope: cleanText(cycle?.scope, 80),
        symbols: cycleSymbols(cycle),
        benchmark: cleanText(cycle?.benchmark, 40),
        timezone: cleanText(cycle?.timezone, 80) ?? "Asia/Shanghai",
        startAt: optionalIso(cycle?.startAt),
        endAt: revealsOutcome ? optionalIso(cycle?.endAt) : null,
        catalyst: cycleType === "catalyst" ? sanitizeCatalyst(cycle) : null,
        eventMetadata,
        legacySource: sanitizeLegacyCycleSource(cycle?.legacySource, { blind: !revealsOutcome }),
        canonicalEvidenceIdentity: revealsOutcome ? canonicalEvidenceIdentity : null,
        status: normalizedPhase === "blind"
          ? "sealed_for_blind_review"
          : cleanText(cycle?.status, 80),
        startCondition: cleanText(cycle?.startCondition, 2_000),
        endCondition: cleanText(cycle?.endCondition, 2_000),
        evidenceGrade,
        userRetrospectiveNote: retrospectiveVersion
          ? sanitizeRetrospectiveVersion(retrospectiveVersion)
          : null,
        sealedExAnte: sealedVersion ? sanitizeSealedVersion(sealedVersion) : null,
        checkpoints: visibleCheckpoints,
        decisionTimeline,
        decisionTimelineHash: normalizedPhase === "blind"
          ? cleanText(cycle?.decisionTimelineHash, 160)
          : null,
        brokerAssociation: {
          revision: evidenceRevision,
          evidenceRevision,
          accountScopeStatus: "matched",
          confirmedAt: revealsOutcome ? optionalIso(cycle?.brokerLinks?.confirmedAt) : null,
          requestedRecordIds: revealsOutcome ? eligibleRequestedRecordIds : undefined,
          requestedRecordCount: revealsOutcome
            ? eligibleRequestedRecordIds.length
            : visibleOrders.filter((item) => requestedRecordIdSet.has(`order:${item?.orderId}`)).length
              + visibleExecutions.filter((item) => requestedRecordIdSet.has(`execution:${item?.tradeId}`)).length,
          resolvedRecordCount: revealsOutcome
            ? linkedOrderIds.length + linkedExecutionIds.length
            : visibleOrders.length + visibleExecutions.length,
          supplementalRecordCount: revealsOutcome
            ? Math.max(0, linkedOrderIds.length + linkedExecutionIds.length - requestedRecordIds.length)
            : undefined,
          selectionPolicy: "user_selected_records_define_trade_path; resolved_parent_and_sibling_records_are_supplemental",
          linkedOrderCount: revealsOutcome ? linkedOrderIds.length : visibleOrders.length,
          linkedExecutionCount: revealsOutcome ? linkedExecutionIds.length : visibleExecutions.length,
          eligibleLinkedOrderCount: revealsOutcome ? linkedOrders.length : visibleOrders.length,
          eligibleLinkedExecutionCount: revealsOutcome ? linkedExecutions.length : visibleExecutions.length,
          excludedAuditOrderCount: revealsOutcome ? excludedAuditOrders.length : undefined,
          excludedAuditExecutionCount: revealsOutcome ? excludedAuditExecutions.length : undefined,
          excludedAuditOrderReasons: revealsOutcome
            ? countExcludedReviewReasons(excludedAuditOrders)
            : undefined,
          excludedAuditExecutionReasons: revealsOutcome
            ? countExcludedReviewReasons(excludedAuditExecutions)
            : undefined,
          evidenceFilterPolicyVersion: 2,
          missingOrderCount: revealsOutcome ? missingOrderIds.length : undefined,
          missingExecutionCount: revealsOutcome ? missingExecutionIds.length : undefined,
        },
        orders: visibleOrders.map((item) => sanitizeOrder(item, {
          startAt: cycle?.startAt,
          endAt: cycleEndAt,
          selectionRole: requestedRecordIdSet.has(`order:${item?.orderId}`)
            ? "user_selected_order"
            : "supplemental_parent_order",
        })),
        executions: visibleExecutions.map((item) => sanitizeExecution(item, {
          startAt: cycle?.startAt,
          endAt: cycleEndAt,
          selectionRole: requestedRecordIdSet.has(`execution:${item?.tradeId}`)
            ? "user_selected_execution"
            : requestedRecordIdSet.has(`order:${item?.orderId}`)
              ? "selected_order_fill"
              : "supplemental_sibling_execution",
        })),
        startingPortfolio: sanitizePortfolioSnapshot(cycle?.startingPortfolio ?? cycle?.portfolioSnapshot, {
          includeEvidenceMetadata: revealsOutcome,
        }),
        // A live portfolio fetched during review is not a historical cycle-end snapshot.
        endingPortfolio,
        currentPortfolioContext,
        portfolioCoverage: revealsOutcome ? {
          cycleEndAt,
          endingPortfolioAvailable: Boolean(endingPortfolio),
          endingPortfolioAsOf: endingPortfolio?.snapshotAt ?? null,
          currentPortfolioAsOf: currentPortfolioContext?.snapshotAt ?? null,
          currentPortfolioRelation: portfolioTimeRelation(
            currentPortfolioContext?.snapshotAt,
            cycleEndAt,
          ),
          note: endingPortfolio
            ? "周期末组合来自带时间戳的历史快照；当前组合另列为复盘时点背景。"
            : "没有合格的周期末历史组合快照；当前组合不得替代周期末仓位或用于重建历史敞口。",
          snapshotLedger: sanitizePortfolioSnapshotCoverage(cycle?.portfolioSnapshotCoverage),
        } : null,
        outcome: revealsOutcome ? sanitizeOutcome(cycle?.outcome) : null,
        blindAssessment,
      },
      dataCoverage: {
        brokerSource: archive?.source ?? "Longbridge MCP · read only",
        brokerAccountScopeStatus: "matched",
        brokerSyncedAt: revealsOutcome ? archive?.syncedAt ?? null : null,
        brokerRange: revealsOutcome ? archive?.range ?? null : null,
        completeness: revealsOutcome ? archive?.completeness ?? {} : {},
        parentOrderBackfill: revealsOutcome
          ? sanitizeParentOrderBackfill(archive?.parentOrderBackfill)
          : null,
        warnings: revealsOutcome ? stringList(archive?.warnings, 20) : [],
        blindProjection: normalizedPhase === "blind" ? "cutoff_filtered_without_future_counts" : null,
      },
      pointInTimeTechnical: sanitizePointInTimeTechnical(pointInTimeTechnical),
      deterministicOutcomeMetrics: revealsOutcome
        ? sanitizeDeterministicOutcomeMetrics(deterministicOutcomeMetrics)
        : null,
      technicalValidation: revealsOutcome
        ? sanitizeTechnicalValidation(technicalValidation)
        : null,
      reconciliation: revealsOutcome && reconciliation?.schemaVersion === "review-reconciliation/v1"
        ? structuredClone(reconciliation)
        : null,
      evidencePolicy: {
        evidenceLabels: [
          "user_original",
          "ai_ex_ante_structure",
          "broker_fact",
          "fundamental_market_fact",
          "technical_fact",
          "derived_metric",
          "agent_inference",
          ...(cycle.legacySource ? ["historical_legacy_source_not_new_ex_ante"] : []),
        ],
        narrativeStageIndependentFromTechnicalTemperature: true,
        emaOrFibRequired: false,
        orderWrite: false,
        ruleAutoPromotion: false,
        legacyMigrationCreatesNoNewExAnteSeal: true,
        legacyResultReferencesAreNotCurrentPhaseRuns: true,
        oneSamplePerCanonicalEvidenceIdentity: true,
      },
    },
    technical: null,
    risk: null,
    plan: { available: false, reason: "复盘输出不会生成或执行真实订单。" },
    sections: ["conclusion", "evidence"],
    evidence: [
      {
        source: archive?.source ?? "Longbridge MCP · read only",
        tool: "review:cycle-broker-history",
        asOf: normalizedPhase === "blind" ? knowledgeCutoffAt : archive?.syncedAt ?? null,
        records: visibleOrders.length + visibleExecutions.length,
        status: normalizedPhase === "blind"
          ? visibleOrders.length + visibleExecutions.length ? "succeeded" : "degraded"
          : brokerEvidenceStatus(archive, missingOrderIds, missingExecutionIds),
        summary: normalizedPhase === "blind"
          ? decisionTimeline.length
            ? `按 ${decisionTimeline.length} 个节点证据胶囊交付券商事实；每个节点只含严格早于其自身 knowledgeCutoffAt 的首次可知事实。`
            : `仅交付 cutoff ${cutoffAt} 及以前的已关联券商事实。`
          : normalizedPhase === "outcome"
            ? "交付周期内已关联的订单与成交，并引用冻结的阶段一评估。"
            : "交付订单优先周期内的真实订单与成交；本轮没有冻结的阶段一评估，证据等级为 retrospective。",
      },
      {
        source: "本机加密决策周期台账",
        tool: `review:decision-cycle:${normalizedPhase}`,
        asOf: normalizedPhase === "blind" ? knowledgeCutoffAt : workspace?.updatedAt ?? null,
        records: 1,
        status: evidenceGrade === "contaminated" ? "degraded" : "succeeded",
        summary: `${cycleTypeLabel(cycleType)} · ${phaseLabel(normalizedPhase)} · ${evidenceGrade}`,
      },
      ...(revealsOutcome ? [{
        source: "宿主确定性结果指标管线",
        tool: "review:decision-cycle:outcome-metrics",
        asOf: deterministicOutcomeMetrics?.generatedAt ?? null,
        records: deterministicOutcomeMetrics?.coverage?.loadedSymbols?.length ?? 0,
        status: deterministicOutcomeMetrics?.status === "available" ? "succeeded" : "degraded",
        summary: deterministicOutcomeMetrics?.status === "available"
          ? "已基于关联成交和周期内长桥日线计算可核验结果指标。"
          : "部分或全部结果指标不可计算；coverage/reasons 已明确记录，模型不得用临时查询替代。",
      }] : []),
      ...(revealsOutcome && technicalValidation ? [{
        source: "本机加密技术雷达 + 宿主结果指标",
        tool: "review:technical-validation-sample",
        asOf: technicalValidation?.entrySnapshot?.batch?.recordedAt ?? null,
        records: technicalValidation?.sampleCandidate?.status === "available" ? 1 : 0,
        status: technicalValidation?.status === "complete" ? "succeeded" : "degraded",
        summary: technicalValidation?.entrySnapshot?.batch
          ? "已把首个框选 Buy 之前最后一批技术雷达，与本次宿主验证结果做防未来泄漏关联；当前只作为历史校准样本。"
          : "首个框选 Buy 之前没有可用技术雷达批次；技术验证样本保持 N/A。",
      }] : []),
    ],
    safeguards: {
      orderWrite: false,
      brokerFactsImmutable: true,
      userExAnteVersioned: true,
      futureEvidenceExcludedInBlind: normalizedPhase === "blind",
      blindFormalStatisticsEligible: normalizedPhase === "blind" && decisionTimeline.length <= 1,
      blindTimelineCapsulesShareSingleModelRequest: normalizedPhase === "blind" && decisionTimeline.length > 0,
      outcomeRequiresBlindAssessment: normalizedPhase === "outcome",
      retrospectiveHasNoBlindAssessment: normalizedPhase === "retrospective",
      retrospectiveRecollectionIsNotExAnteEvidence: normalizedPhase === "retrospective",
      forwardHypothesisEffectiveOnlyFromSavedAt: normalizedPhase === "retrospective",
      ruleAutoPromotion: false,
      technicalValidationAutomaticPromotion: false,
    },
    capabilities: {
      modelNarration: true,
      persistentThread: true,
      skills: true,
      mcp: true,
      brokerHistory: Boolean(archive?.syncedAt),
      technicalValidation: Boolean(technicalValidation),
    },
  };
}

function latestRetrospectiveVersion(cycle) {
  const values = Array.isArray(cycle?.retrospectiveVersions) ? cycle.retrospectiveVersions : [];
  const value = values.at(-1);
  if (!value || value.integrityStatus === "mismatch") return null;
  const snapshot = value.snapshot ?? {};
  if (!cleanText(snapshot.recalledJudgment, 6_000)
    || !cleanText(snapshot.lesson, 6_000)
    || !cleanText(snapshot.forwardHypothesis, 6_000)) return null;
  return value;
}

function sanitizeRetrospectiveVersion(value) {
  return {
    version: finiteOrNull(value?.version),
    savedAt: optionalIso(value?.savedAt),
    evidenceTiming: "retrospective",
    recalledJudgment: {
      text: cleanText(value?.snapshot?.recalledJudgment, 6_000),
      label: "user_retrospective_recollection",
      eligibleAsExAnteEvidence: false,
    },
    lesson: {
      text: cleanText(value?.snapshot?.lesson, 6_000),
      label: "user_retrospective_reflection",
      eligibleAsExAnteEvidence: false,
    },
    forwardHypothesis: {
      text: cleanText(value?.snapshot?.forwardHypothesis, 6_000),
      label: "user_forward_hypothesis",
      effectiveFrom: optionalIso(value?.forwardEffectiveAt ?? value?.savedAt),
      eligibleForReviewedCycleAttribution: false,
    },
  };
}

function sanitizeDeterministicOutcomeMetrics(value) {
  if (!value || typeof value !== "object") {
    return {
      status: "unavailable",
      generatedAt: null,
      executionPnl: null,
      pricePath: null,
      coverage: { reasons: ["host_metrics_not_provided"] },
      provenance: {
        deterministicHostCalculation: true,
        modelLookupAllowedAsMetricSubstitute: false,
      },
    };
  }
  // The producer is a bounded host calculator. Clone through JSON so no
  // executable or prototype-bearing values can enter the model context.
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    return {
      ...cloned,
      status: cleanText(cloned?.status, 80) ?? "unavailable",
      generatedAt: optionalIso(cloned?.generatedAt),
      provenance: {
        ...(cloned?.provenance && typeof cloned.provenance === "object" ? cloned.provenance : {}),
        deterministicHostCalculation: true,
        modelLookupAllowedAsMetricSubstitute: false,
      },
    };
  } catch {
    return {
      status: "unavailable",
      generatedAt: null,
      executionPnl: null,
      pricePath: null,
      coverage: { reasons: ["host_metrics_serialization_failed"] },
      provenance: {
        deterministicHostCalculation: true,
        modelLookupAllowedAsMetricSubstitute: false,
      },
    };
  }
}

function sanitizeTechnicalValidation(value) {
  if (!value || typeof value !== "object") return null;
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    return {
      ...cloned,
      status: cleanText(cloned?.status, 80) ?? "unavailable",
      reasonCodes: stringList(cloned?.reasonCodes, 40),
      provenance: {
        ...(cloned?.provenance && typeof cloned.provenance === "object"
          ? cloned.provenance
          : {}),
        deterministic: true,
        currentPortfolioLookupAllowed: false,
        currentHoldingInferenceAllowed: false,
        formalRulePolicy: "historical calibration is discovery-only; forward validation and human review are required",
      },
    };
  } catch {
    return {
      status: "unavailable",
      reasonCodes: ["technical_validation_serialization_failed"],
      entrySnapshot: null,
      outcome: null,
      riskR: null,
      sampleCandidate: null,
      ruleCandidate: null,
      provenance: {
        deterministic: true,
        currentPortfolioLookupAllowed: false,
        currentHoldingInferenceAllowed: false,
      },
    };
  }
}

function sanitizePointInTimeTechnical(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value.nodes) && value.nodes.length > MAX_DELIVERED_TIMELINE_NODES) {
    throw new Error(`时点技术节点超过 ${MAX_DELIVERED_TIMELINE_NODES} 个；请拆分复盘周期后重试。`);
  }
  return {
    status: cleanText(value.status, 80) ?? "unavailable",
    asOf: optionalIso(value.asOf),
    cutoffPolicy: cleanText(value.cutoffPolicy, 500),
    requestedSymbols: stringList(value.requestedSymbols, 20),
    omittedSymbols: stringList(value.omittedSymbols, 100),
    warnings: stringList(value.warnings, 20),
    snapshots: sanitizeTechnicalSnapshots(value.snapshots),
    nodes: (Array.isArray(value.nodes) ? value.nodes : []).map((node) => ({
      nodeId: cleanText(node?.nodeId, 240),
      timelineIndex: finiteOrNull(node?.timelineIndex),
      asOf: optionalIso(node?.asOf ?? node?.knowledgeCutoffAt),
      knowledgeCutoffAt: optionalIso(node?.knowledgeCutoffAt ?? node?.asOf),
      status: cleanText(node?.status, 80) ?? "unavailable",
      cutoffPolicy: cleanText(node?.cutoffPolicy, 500),
      warnings: stringList(node?.warnings, 20),
      snapshots: sanitizeTechnicalSnapshots(node?.snapshots),
    })),
  };
}

function sanitizeTechnicalSnapshots(values) {
  return (Array.isArray(values) ? values : []).slice(0, 20).map((item) => ({
    symbol: cleanText(item?.symbol, 40),
    source: cleanText(item?.source, 120),
    asOf: optionalIso(item?.asOf),
    asOfTradingDate: cleanText(item?.asOfTradingDate, 20),
    calculationBarCount: finiteOrNull(item?.calculationBarCount),
    status: cleanText(item?.status, 80),
    reason: cleanText(item?.reason, 1_000),
    lastPrice: finiteOrNull(item?.lastPrice),
    emaMethod: item?.emaMethod ?? null,
    ema: item?.ema ?? null,
    emaSlope5d: item?.emaSlope5d ?? null,
    emaMaturity: item?.emaMaturity ?? null,
    shortStructure: cleanText(item?.shortStructure, 120),
    longStructure: cleanText(item?.longStructure, 120),
    range20: item?.range20 ?? null,
    fib: item?.fib ?? null,
    capabilities: item?.capabilities ?? null,
  }));
}

function hydrateDecisionTimeline({
  timeline,
  orderById,
  executionById,
  pointInTimeTechnical,
  cycleStartAt,
  cycleEndAt,
}) {
  const timelineValues = Array.isArray(timeline) ? timeline : [];
  if (timelineValues.length > MAX_DELIVERED_TIMELINE_NODES) {
    throw new Error(`决策时间线超过 ${MAX_DELIVERED_TIMELINE_NODES} 个节点；为避免不完整盲评，请拆分复盘周期后重试。`);
  }
  const technicalValues = Array.isArray(pointInTimeTechnical?.nodes) ? pointInTimeTechnical.nodes : [];
  const technicalByNode = new Map(
    technicalValues.map((item) => [String(item?.nodeId ?? ""), item]),
  );
  if (technicalByNode.size !== technicalValues.length) {
    throw new Error("时点技术快照包含重复或空的决策节点 ID，已拒绝不完整盲评。");
  }
  const timelineNodeIds = timelineValues.map((node, index) => String(node?.nodeId ?? `timeline-node-${index + 1}`));
  if (new Set(timelineNodeIds).size !== timelineNodeIds.length) {
    throw new Error("决策时间线包含重复节点 ID，已拒绝不完整盲评。");
  }
  if (technicalValues.length) {
    const timelineNodeIdSet = new Set(timelineNodeIds);
    const missingTechnical = timelineNodeIds.filter((nodeId) => !technicalByNode.has(nodeId));
    const extraTechnical = [...technicalByNode.keys()].filter((nodeId) => !timelineNodeIdSet.has(nodeId));
    if (missingTechnical.length || extraTechnical.length) {
      throw new Error("时点技术节点与决策时间线不一一对应，已拒绝不完整盲评。");
    }
    timelineValues.forEach((node, index) => {
      const nodeId = timelineNodeIds[index];
      const nodeCutoff = optionalIso(node?.knowledgeCutoffAt);
      const technical = technicalByNode.get(nodeId);
      const technicalCutoff = optionalIso(technical?.knowledgeCutoffAt ?? technical?.asOf);
      if (!nodeCutoff || !technicalCutoff || Date.parse(nodeCutoff) !== Date.parse(technicalCutoff)) {
        throw new Error("时点技术节点 cutoff 与决策时间线不一致，已拒绝可能穿越的盲评。");
      }
      const futureSnapshot = (Array.isArray(technical?.snapshots) ? technical.snapshots : []).find((snapshot) => {
        const snapshotMs = Date.parse(String(snapshot?.asOf ?? ""));
        return Number.isFinite(snapshotMs) && snapshotMs >= Date.parse(nodeCutoff);
      });
      if (futureSnapshot) {
        throw new Error("时点技术快照包含节点 cutoff 当时或之后的数据，已拒绝可能穿越的盲评。");
      }
    });
  }
  return timelineValues.map((node, index) => {
    const cutoffAt = optionalIso(node?.knowledgeCutoffAt);
    const declaredIds = uniqueStrings(node?.brokerFactsIntroduced?.recordIds).slice(0, 500);
    const records = [];
    const missingRecordIds = [];
    const excludedAtOrAfterCutoffRecordIds = [];
    for (const recordId of declaredIds) {
      const [kind, ...idParts] = recordId.split(":");
      const rawId = idParts.join(":");
      const raw = kind === "order" ? orderById.get(rawId)
        : kind === "execution" ? executionById.get(rawId)
          : null;
      if (!raw) {
        missingRecordIds.push(recordId);
        continue;
      }
      const occurredAt = kind === "order" ? orderAt(raw) : executionAt(raw);
      if (!cutoffAt || !beforeCutoff(occurredAt, cutoffAt)) {
        excludedAtOrAfterCutoffRecordIds.push(recordId);
        continue;
      }
      records.push({
        recordRef: recordId,
        ...(kind === "order"
          ? sanitizeOrder(raw, { startAt: cycleStartAt, endAt: cycleEndAt })
          : sanitizeExecution(raw, { startAt: cycleStartAt, endAt: cycleEndAt })),
      });
    }
    const technical = technicalByNode.get(String(node?.nodeId ?? ""));
    const coverageStatus = missingRecordIds.length || excludedAtOrAfterCutoffRecordIds.length
      ? records.length ? "partial" : "unavailable"
      : "complete";
    return {
      nodeId: cleanText(node?.nodeId, 240) ?? `timeline-node-${index + 1}`,
      timelineIndex: finiteOrNull(node?.timelineIndex) ?? index,
      nodeType: cleanText(node?.nodeType, 80),
      sourceId: cleanText(node?.sourceId, 240),
      sourceSequence: finiteOrNull(node?.sourceSequence),
      occurredAt: optionalIso(node?.occurredAt),
      recordedAt: optionalIso(node?.recordedAt),
      knowledgeCutoffAt: cutoffAt,
      kind: cleanText(node?.kind, 80),
      title: cleanText(node?.title, 500),
      decision: cleanText(node?.decision, 6_000),
      marketView: cleanText(node?.marketView, 6_000),
      action: cleanText(node?.action, 6_000),
      invalidation: cleanText(node?.invalidation, 6_000),
      fundamental: cleanText(node?.fundamental, 8_000),
      technical: cleanText(node?.technical, 8_000),
      portfolioContext: cleanText(node?.portfolioContext, 6_000),
      riskNotes: cleanText(node?.riskNotes, 6_000),
      note: cleanText(node?.note, 8_000),
      evidence: (Array.isArray(node?.evidence) ? node.evidence : []).slice(0, 200).map((entry) => ({
        id: cleanText(entry?.id, 160),
        kind: cleanText(entry?.kind, 80),
        observedAt: optionalIso(entry?.observedAt ?? entry?.at),
        source: cleanText(entry?.source, 300),
        title: cleanText(entry?.title, 300),
        summary: cleanText(entry?.summary ?? entry?.note, 4_000),
        uri: cleanText(entry?.uri ?? entry?.url, 1_000),
      })).filter((entry) => entry.summary && beforeCutoff(entry.observedAt, cutoffAt)),
      coveredBySealedPlan: node?.coveredBySealedPlan === true,
      formalCoverage: node?.formalCoverage ?? null,
      recordedAfterOccurrence: node?.recordedAfterOccurrence === true,
      recordingLagMs: finiteOrNull(node?.recordingLagMs),
      integrityStatus: cleanText(node?.integrityStatus, 80),
      brokerFactsIntroduced: {
        recordIds: declaredIds,
        records,
        missingRecordIds,
        excludedAtOrAfterCutoffRecordIds,
        coverage: {
          status: coverageStatus,
          declaredCount: declaredIds.length,
          hydratedCount: records.length,
          missingCount: missingRecordIds.length,
          excludedAtOrAfterCutoffCount: excludedAtOrAfterCutoffRecordIds.length,
          note: "仅补充该节点 knowledgeCutoffAt 严格之前、且由节点公开 recordIds 指向的加密券商事实。",
        },
      },
      pointInTimeTechnical: technical ? {
        status: cleanText(technical?.status, 80) ?? "unavailable",
        asOf: optionalIso(technical?.asOf ?? technical?.knowledgeCutoffAt),
        knowledgeCutoffAt: optionalIso(technical?.knowledgeCutoffAt ?? technical?.asOf),
        cutoffPolicy: cleanText(technical?.cutoffPolicy, 500),
        warnings: stringList(technical?.warnings, 20),
        snapshots: sanitizeTechnicalSnapshots(technical?.snapshots),
      } : {
        status: "unavailable",
        asOf: cutoffAt,
        knowledgeCutoffAt: cutoffAt,
        cutoffPolicy: "该节点没有可用的时点技术快照。",
        warnings: ["node_technical_snapshot_missing"],
        snapshots: [],
      },
    };
  }).sort((left, right) => left.timelineIndex - right.timelineIndex);
}

export function selectCycleRecordIds(archive, cycle) {
  const startMs = Date.parse(String(cycle?.startAt ?? ""));
  const endMs = Date.parse(String(cycle?.endAt ?? ""));
  if (!Number.isFinite(startMs)) throw new Error("复盘周期缺少有效开始时间。");
  const effectiveEndMs = Number.isFinite(endMs) ? endMs : Date.now();
  if (effectiveEndMs < startMs) throw new Error("复盘周期结束时间早于开始时间。");
  const type = normalizeCycleType(cycle?.type ?? cycle?.cycleType);
  const symbols = new Set(cycleSymbols(cycle));
  const includeSymbol = (symbol) => type === "monthly_portfolio" || symbols.has(String(symbol ?? "").toUpperCase());
  const declaredMonth = /^\d{4}-(?:0[1-9]|1[0-2])$/.test(String(cycle?.month ?? ""))
    ? String(cycle.month)
    : null;
  const includeActivity = (value) => type === "monthly_portfolio" && declaredMonth
    ? activityFallsInReviewMonth(value, declaredMonth, cycle?.timezone)
    : inRange(value, startMs, effectiveEndMs);
  const reviewableExecutions = partitionReviewExecutions(
    archive?.executions ?? [],
    archive?.orders ?? [],
  ).included;
  const reviewableOrders = partitionReviewOrders(
    archive?.orders ?? [],
    archive?.executions ?? [],
  ).included;
  const ids = [
    ...reviewableOrders
      .filter((item) => includeSymbol(item?.symbol))
      .filter((item) => includeActivity(orderAt(item)))
      .map((item) => `order:${item.orderId}`),
    ...reviewableExecutions
      .filter((item) => includeSymbol(item?.symbol))
      .filter((item) => includeActivity(executionAt(item)))
      .map((item) => `execution:${item.tradeId}`),
  ];
  return [...new Set(ids)];
}

function countExcludedReviewReasons(excluded) {
  const counts = {};
  for (const item of excluded) {
    const reason = cleanText(item?.reason, 80) ?? "unverified";
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

export function filterCandlesBeforeReviewCutoff(candles, cutoffAt) {
  const cutoffMs = Date.parse(String(cutoffAt ?? ""));
  if (!Number.isFinite(cutoffMs)) return [];
  const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10);
  return (Array.isArray(candles) ? candles : []).filter((bar) => {
    if (bar?.tradeDate) return String(bar.tradeDate) < cutoffDate;
    const timestampMs = Date.parse(String(bar?.timestamp ?? ""));
    return Number.isFinite(timestampMs)
      && timestampMs < cutoffMs
      && new Date(timestampMs).toISOString().slice(0, 10) < cutoffDate;
  });
}

function latestSealedVersion(cycle) {
  const values = [
    ...(Array.isArray(cycle?.exAnteVersions) ? cycle.exAnteVersions : []),
    ...(Array.isArray(cycle?.sealedVersions) ? cycle.sealedVersions : []),
  ].filter((item) => item && typeof item === "object");
  return values.sort((left, right) => Date.parse(left?.sealedAt ?? "") - Date.parse(right?.sealedAt ?? "")).at(-1) ?? null;
}

function cyclePhaseRuns(cycle, phase) {
  const direct = cycle?.phaseRuns?.[phase] ?? cycle?.runs?.[phase];
  if (Array.isArray(direct)) return direct;
  if (direct && typeof direct === "object") return [direct];
  return (Array.isArray(cycle?.reviewRuns) ? cycle.reviewRuns : [])
    .filter((item) => item?.phase === phase);
}

function completedPhaseRun(value) {
  return ["completed", "succeeded", "complete"].includes(String(value?.status ?? "completed").toLowerCase())
    && Boolean(value?.threadId || value?.assessmentId || value?.runId || value?.operationId);
}

function cycleOutcomeReady(cycle, now) {
  const endMs = Date.parse(String(cycle?.endAt ?? ""));
  return Number.isFinite(endMs) && endMs <= now.getTime();
}

function requiredCutoff(version) {
  const value = optionalIso(version?.cutoffAt ?? version?.knowledgeCutoffAt ?? version?.sealedAt);
  if (!value) throw new Error("封存版本缺少有效 cutoff，不能建立时间防火墙。");
  return value;
}

function normalizedCheckpoints(cycle) {
  return (Array.isArray(cycle?.checkpoints) ? cycle.checkpoints : [])
    .map((item) => ({
      id: cleanText(item?.id, 160),
      at: optionalIso(item?.occurredAt ?? item?.at ?? item?.decisionAt),
      recordedAt: optionalIso(item?.recordedAt),
      cutoffAt: optionalIso(
        item?.cutoffAt
          ?? item?.knowledgeCutoffAt
          ?? item?.recordedAt
          ?? item?.occurredAt
          ?? item?.at
          ?? item?.decisionAt,
      ),
      kind: cleanText(item?.kind, 80),
      title: cleanText(item?.title, 500),
      decision: cleanText(item?.decision, 4_000),
      action: cleanText(item?.action, 2_000),
      invalidation: cleanText(item?.invalidation, 4_000),
      fundamental: cleanText(item?.fundamental, 6_000),
      technical: cleanText(item?.technical, 6_000),
      note: cleanText(item?.note, 4_000),
      source: cleanText(item?.source, 80) ?? "user",
      evidence: (Array.isArray(item?.evidence) ? item.evidence : []).slice(0, 200).map((entry) => ({
        id: cleanText(entry?.id, 160),
        kind: cleanText(entry?.kind, 80),
        observedAt: optionalIso(entry?.observedAt ?? entry?.at),
        source: cleanText(entry?.source, 300),
        title: cleanText(entry?.title, 300),
        summary: cleanText(entry?.summary ?? entry?.note, 4_000),
        uri: cleanText(entry?.uri ?? entry?.url, 1_000),
      })).filter((entry) => entry.summary),
    }))
    .filter((item) => item.at)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

function sanitizeSealedVersion(value) {
  const snapshot = value?.snapshot ?? {};
  const exAnte = snapshot?.exAnte ?? value?.exAnte ?? snapshot;
  return {
    version: finiteOrNull(value?.version),
    sealedAt: optionalIso(value?.sealedAt),
    cutoffAt: requiredCutoff(value),
    timing: normalizeEvidenceGrade(value?.evidenceGrade ?? value?.timing),
    eligibleForFormalStats: value?.eligibleForFormalStats === true,
    eligibleFromAt: optionalIso(value?.eligibleFromAt),
    coverageLimitation: cleanText(value?.coverageLimitation, 1_000),
    hash: cleanText(value?.hash, 160),
    userOriginal: {
      myView: cleanText(exAnte?.myView, 6_000),
      marketView: cleanText(exAnte?.marketView, 6_000),
      plannedAction: cleanText(exAnte?.plannedAction, 4_000),
      invalidation: cleanText(exAnte?.invalidation, 4_000),
      fundamentalView: cleanText(exAnte?.fundamentalView, 6_000),
      technicalView: cleanText(exAnte?.technicalView, 6_000),
      evidence: (Array.isArray(exAnte?.evidence) ? exAnte.evidence : []).slice(0, 200).map((entry) => ({
        id: cleanText(entry?.id, 160),
        kind: cleanText(entry?.kind, 80),
        observedAt: optionalIso(entry?.observedAt ?? entry?.at),
        source: cleanText(entry?.source, 300),
        title: cleanText(entry?.title, 300),
        summary: cleanText(entry?.summary ?? entry?.note, 4_000),
        uri: cleanText(entry?.uri ?? entry?.url, 1_000),
      })).filter((entry) => entry.summary),
    },
    aiExAnteStructure: value?.aiExAnteStructure ?? null,
  };
}

function summarizeBlindRun(value) {
  const result = value?.result && typeof value.result === "object" ? value.result : {};
  const sourceSummary = String(
    value?.summary
      ?? result?.summary
      ?? result?.body
      ?? result?.conclusion?.body
      ?? result?.conclusion?.headline
      ?? "",
  ).trim();
  const summary = sourceSummary.slice(0, MAX_FROZEN_BLIND_ASSESSMENT_CHARS);
  return {
    assessmentId: cleanText(value?.assessmentId ?? value?.id ?? value?.runId, 200),
    threadId: cleanText(value?.threadId, 220),
    operationId: cleanText(value?.operationId, 120),
    completedAt: optionalIso(value?.completedAt ?? value?.recordedAt),
    evidenceHash: cleanText(
      value?.evidenceHash ?? value?.inputSnapshotHash ?? value?.hash,
      160,
    ),
    resultHash: cleanText(value?.resultHash, 160),
    summary: summary || null,
    summaryHash: sourceSummary
      ? `sha256:${createHash("sha256").update(sourceSummary).digest("hex")}`
      : null,
    sourceCharacterCount: sourceSummary.length,
    deliveredCharacterCount: summary.length,
    truncated: summary.length !== sourceSummary.length,
    truncationReason: summary.length !== sourceSummary.length
      ? "frozen_blind_assessment_exceeds_transport_safety_limit"
      : null,
    frozen: true,
  };
}

function sanitizeOrder(item, { startAt = null, endAt = null, selectionRole = null } = {}) {
  return {
    kind: "order",
    recordRef: item?.orderId ? `order:${item.orderId}` : null,
    selectionRole: cleanText(selectionRole, 80),
    symbol: item?.symbol ?? null,
    side: item?.side ?? null,
    status: item?.status ?? null,
    orderType: item?.orderType ?? null,
    quantity: finiteOrNull(item?.quantity),
    executedQuantity: finiteOrNull(item?.executedQuantity),
    submittedPrice: finiteOrNull(item?.submittedPrice),
    executedPrice: finiteOrNull(item?.executedPrice),
    contractMultiplier: positiveFiniteOrNull(item?.contractMultiplier),
    currency: item?.currency ?? null,
    submittedAt: optionalIso(item?.submittedAt),
    updatedAt: optionalIso(item?.updatedAt),
    relationshipContext: periodRelation(orderAt(item), startAt, endAt),
  };
}

function sanitizeExecution(item, { startAt = null, endAt = null, selectionRole = null } = {}) {
  return {
    kind: "execution",
    recordRef: item?.tradeId ? `execution:${item.tradeId}` : null,
    parentOrderRef: item?.orderId ? `order:${item.orderId}` : null,
    selectionRole: cleanText(selectionRole, 80),
    symbol: item?.symbol ?? null,
    side: item?.side ?? null,
    quantity: finiteOrNull(item?.quantity),
    price: finiteOrNull(item?.price),
    contractMultiplier: positiveFiniteOrNull(item?.contractMultiplier),
    reportedPrice: finiteOrNull(item?.reportedPrice),
    priceAudit: sanitizeExecutionPriceAudit(item?.priceAudit),
    currency: item?.currency ?? null,
    doneAt: optionalIso(item?.doneAt),
    relationshipContext: periodRelation(executionAt(item), startAt, endAt),
  };
}

function sanitizeExecutionPriceAudit(value) {
  if (!value || typeof value !== "object") return null;
  return {
    status: cleanText(value?.status, 30),
    sourceField: cleanText(value?.sourceField, 120),
    reportedValue: finiteOrNull(value?.reportedValue),
    reason: cleanText(value?.reason, 160),
    instrumentType: cleanText(value?.instrumentType, 30),
    parentOrderMatched: value?.parentOrderMatched === true,
    sideResolved: value?.sideResolved === true,
    currencyResolved: value?.currencyResolved === true,
  };
}

function sanitizePortfolioSnapshot(value, { includeEvidenceMetadata = true } = {}) {
  if (!value || typeof value !== "object") return null;
  const netAssets = finiteOrNull(
    value?.account?.netAssets
      ?? value?.netAssets
      ?? value?.totals?.netAssets
      ?? value?.summary?.totalAssets,
  );
  const grossNotional = finiteOrNull(value?.totals?.positionsGrossMarketValueBase ?? value?.summary?.grossExposure);
  const cash = finiteOrNull(value?.cash ?? value?.account?.totalCash ?? value?.summary?.cash);
  const reportingCurrency = cleanText(value?.baseCurrency ?? value?.account?.baseCurrency ?? value?.summary?.reportingCurrency, 20);
  const rawHoldings = !Array.isArray(value.positions) && Array.isArray(value.holdings);
  const sourcePositions = Array.isArray(value.positions) ? value.positions : rawHoldings ? value.holdings : null;
  const sourceQuality = value.dataQuality && typeof value.dataQuality === "object" ? value.dataQuality : null;
  const sourceValuation = value.valuation ?? value.snapshotValuation ?? null;
  const regularClosePricesOnly = sourceValuation?.methodVersion === "regular-close-v2";
  const issues = Array.isArray(sourceQuality?.issues) ? sourceQuality.issues : [];
  const rates = Array.isArray(value?.fx?.rates) ? value.fx.rates : [];
  const positionCoverage = compactProjectionCoverage(sourcePositions, MAX_PORTFOLIO_CONTEXT_POSITIONS);
  const explicitGrossExposure = finiteOrNull(
    value?.grossExposurePercent
      ?? value?.totals?.grossExposurePercent,
  );
  const snapshot = {
    snapshotAt: optionalIso(value?.snapshotAt ?? value?.syncedAt ?? value?.capturedAt),
    snapshotId: cleanText(value?.snapshotId, 160),
    kind: cleanText(value?.kind, 40),
    baseCurrency: reportingCurrency,
    netAssets,
    cash,
    units: { netAssets: reportingCurrency, cash: reportingCurrency, weightPercent: "percent_of_net_assets",
      quantity: "shares_or_contracts_as_reported", marketValue: "per_position_currency",
      marketValueInReportingCurrency: reportingCurrency },
    cashRatioPercent: finiteOrNull(value?.cashRatioPercent ?? value?.totals?.cashRatio)
      ?? (cash != null && netAssets != null && netAssets > 0 ? cash / netAssets * 100 : null),
    grossExposurePercent: explicitGrossExposure
      ?? (netAssets != null && netAssets > 0 && grossNotional != null
        ? (grossNotional / netAssets) * 100
        : null),
    top1WeightPercent: finiteOrNull(value?.top1WeightPercent ?? value?.totals?.top1Weight),
    positions: (sourcePositions ?? []).slice(0, MAX_PORTFOLIO_CONTEXT_POSITIONS).map((item) => ({
      symbol: cleanText(item?.symbol, 80),
      quantity: finiteOrNull(item?.quantity),
      weightPercent: finiteOrNull(item?.weightPercent)
        ?? (rawHoldings && finiteOrNull(item?.weight) != null ? Number(item.weight) * 100 : finiteOrNull(item?.weight)),
      marketValue: finiteOrNull(item?.marketValue),
      currency: cleanText(item?.currency, 20),
      marketValueInReportingCurrency: finiteOrNull(item?.valueInReportingCurrency ?? item?.marketValueBase),
      group: cleanText(item?.group, 80),
    })),
    positionCoverage,
    accountScope: compactPortfolioAccountScope(value),
    valuation: sourceValuation && typeof sourceValuation === "object" ? {
      session: cleanText(sourceValuation.session, 40),
      methodVersion: cleanText(sourceValuation.methodVersion, 80),
      quoteAsOf: optionalIso(sourceValuation.quoteAsOf),
      quoteLatestAsOf: optionalIso(sourceValuation.quoteLatestAsOf),
      observedAt: optionalIso(sourceValuation.observedAt),
      totalAssetsBasis: cleanText(sourceValuation.totalAssetsBasis, 100),
      brokerObservedNetAssets: finiteOrNull(sourceValuation.brokerObservedNetAssets),
      afterHoursMarksExcluded: booleanOrNull(sourceValuation.afterHoursMarksExcluded),
      pricesOnlyNotReconciledInventory: regularClosePricesOnly,
    } : null,
    fx: value.fx && typeof value.fx === "object" ? {
      status: cleanText(value.fx.status, 40),
      reportingCurrency,
      source: cleanText(value.fx.source ?? value.fx.provider, 120),
      retrievedAt: optionalIso(value.fx.retrievedAt ?? value.fx.fetchedAt),
      asOf: optionalIso(value.fx.asOf),
      rates: rates.slice(0, MAX_PORTFOLIO_CONTEXT_DETAILS).map((rate) => ({
        base: cleanText(rate?.base, 20), quote: cleanText(rate?.quote, 20),
        rate: positiveFiniteOrNull(rate?.rate), asOf: optionalIso(rate?.asOf), source: cleanText(rate?.source, 120),
      })),
      rateCoverage: compactProjectionCoverage(Array.isArray(value.fx.rates) ? rates : null, MAX_PORTFOLIO_CONTEXT_DETAILS),
    } : null,
    dataQuality: sourceQuality || regularClosePricesOnly ? {
      sourceStatus: cleanText(sourceQuality?.status, 40),
      status: regularClosePricesOnly && sourceQuality?.status !== "unavailable" ? "partial" : cleanText(sourceQuality?.status, 40),
      completeForPeriodReturn: regularClosePricesOnly ? false : booleanOrNull(sourceQuality?.completeForPeriodReturn),
      issues: issues.slice(0, MAX_PORTFOLIO_CONTEXT_DETAILS).map((item) => ({
        code: cleanText(item?.code, 120), field: cleanText(item?.field, 120), message: cleanText(item?.message, 300),
      })),
      issueCoverage: compactProjectionCoverage(Array.isArray(sourceQuality?.issues) ? issues : null, MAX_PORTFOLIO_CONTEXT_DETAILS),
      limitations: [
        ...(regularClosePricesOnly ? ["regular_close_prices_only_inventory_cash_not_reconciled"] : []),
        ...(positionCoverage.omittedCount > 0 ? ["portfolio_positions_partially_delivered"] : []),
      ],
    } : null,
    provenance: compactPortfolioProvenance(value.provenance, value.integrity),
  };
  if (includeEvidenceMetadata) return snapshot;
  // Preserve the existing blind boundary. Newly exposed retrieval timestamps,
  // FX and quality narratives may have been recorded after the knowledge cut;
  // do not add those to blind replay without a separate cutoff-aware contract.
  return {
    snapshotAt: snapshot.snapshotAt, baseCurrency: snapshot.baseCurrency, netAssets: snapshot.netAssets,
    cashRatioPercent: snapshot.cashRatioPercent, grossExposurePercent: snapshot.grossExposurePercent,
    top1WeightPercent: snapshot.top1WeightPercent,
    units: snapshot.units,
    provenanceQualification: "metadata_not_verified_at_knowledge_cutoff",
    positions: snapshot.positions.map(({ marketValueInReportingCurrency: _converted, ...item }) => item),
  };
}

function compactProjectionCoverage(values, maximum) {
  return { sourceCount: Array.isArray(values) ? values.length : null,
    deliveredCount: Array.isArray(values) ? Math.min(values.length, maximum) : 0,
    omittedCount: Array.isArray(values) ? Math.max(0, values.length - maximum) : null,
    status: !Array.isArray(values) ? "missing" : values.length > maximum ? "partial" : "complete" };
}

function compactPortfolioAccountScope(value) {
  const scope = value.accountScope ?? value.accountScopeIdentity;
  const scopeId = cleanText(scope?.scopeId ?? value.accountScopeId, 160);
  if (!scope && !scopeId) return null;
  // Do not carry account numbers, account identifiers, OAuth subjects or raw
  // account records into the model. scopeId is the host-owned opaque partition.
  return { scopeId, broker: cleanText(scope?.broker, 80), environment: cleanText(scope?.environment, 40),
    status: cleanText(scope?.status, 40), version: cleanText(scope?.version, 80),
    accountCount: Array.isArray(scope?.accounts) ? scope.accounts.length : null,
    verified: booleanOrNull(value.provenance?.accountScopeVerified) };
}

function compactPortfolioProvenance(value, integrity) {
  if ((!value || typeof value !== "object") && (!integrity || typeof integrity !== "object")) return null;
  const source = value ?? {};
  const hash = (input) => typeof input === "string" && /^[a-f0-9]{64}$/i.test(input) ? input : null;
  return { source: cleanText(source.source, 160), provider: cleanText(source.provider, 80),
    transport: cleanText(source.transport, 80), freshness: cleanText(source.freshness, 40),
    fetchedAt: optionalIso(source.fetchedAt), recordedAt: optionalIso(source.recordedAt),
    sourceSnapshotId: cleanText(source.sourceSnapshotId, 160), cacheAgeMs: finiteOrNull(source.cacheAgeMs),
    integrityStatus: cleanText(source.integrityStatus, 60),
    contentHash: hash(integrity?.contentHash), entryHash: hash(integrity?.entryHash),
    accountScopeVerified: booleanOrNull(source.accountScopeVerified),
    accountScopeLimitation: cleanText(source.accountScopeLimitation, 300) };
}

function booleanOrNull(value) { return typeof value === "boolean" ? value : null; }

function sanitizeCycleEndPortfolio(value, startAt, endAt) {
  const snapshot = sanitizePortfolioSnapshot(value);
  const snapshotMs = Date.parse(String(snapshot?.snapshotAt ?? ""));
  const startMs = Date.parse(String(startAt ?? ""));
  const endMs = Date.parse(String(endAt ?? ""));
  if (!snapshot || !Number.isFinite(snapshotMs) || !Number.isFinite(endMs)) return null;
  if (snapshotMs > endMs) return null;
  if (Number.isFinite(startMs) && snapshotMs < startMs) return null;
  return snapshot;
}

function portfolioTimeRelation(snapshotAt, endAt) {
  const snapshotMs = Date.parse(String(snapshotAt ?? ""));
  const endMs = Date.parse(String(endAt ?? ""));
  if (!Number.isFinite(snapshotMs) || !Number.isFinite(endMs)) return "unknown";
  if (snapshotMs > endMs) return "after_cycle_end";
  if (snapshotMs === endMs) return "at_cycle_end";
  return "before_cycle_end";
}

function sanitizePortfolioSnapshotCoverage(value) {
  if (!value || typeof value !== "object") return null;
  return {
    source: cleanText(value?.source, 160),
    scopeId: cleanText(value?.scopeId, 100),
    snapshotCountWithinCycle: finiteOrNull(value?.snapshotCountWithinCycle),
    openingSnapshotAt: optionalIso(value?.openingSnapshotAt),
    endingSnapshotAt: optionalIso(value?.endingSnapshotAt),
    openingDistanceMs: finiteOrNull(value?.openingDistanceMs),
    endingDistanceMs: finiteOrNull(value?.endingDistanceMs),
    canCompareNetAssetEndpoints: value?.canCompareNetAssetEndpoints === true,
    canCalculatePeriodReturn: value?.canCalculatePeriodReturn === true,
    warnings: stringList(value?.warnings, 20),
  };
}

function sanitizeParentOrderBackfill(value) {
  if (!value || typeof value !== "object") return null;
  return {
    status: cleanText(value?.status, 40),
    discoveredOrderCount: finiteOrNull(value?.discoveredOrderCount),
    attemptedOrderCount: finiteOrNull(value?.attemptedOrderCount),
    recoveredOrderCount: finiteOrNull(value?.recoveredOrderCount),
    recoveredAttachedOrderCount: finiteOrNull(value?.recoveredAttachedOrderCount),
    failedOrderCount: finiteOrNull(value?.failedOrderCount),
    deferredOrderCount: finiteOrNull(value?.deferredOrderCount),
    queryCallCount: finiteOrNull(value?.queryCallCount),
    retryCallCount: finiteOrNull(value?.retryCallCount),
  };
}

function sanitizeOutcome(value) {
  if (!value || typeof value !== "object") return null;
  return {
    summary: cleanText(value?.summary ?? value?.actualSummary, 6_000),
    marketReaction: cleanText(value?.marketReaction, 4_000),
    pnl: finiteOrNull(value?.pnl ?? value?.netPnl),
    returnPercent: finiteOrNull(value?.returnPercent),
    benchmarkReturnPercent: finiteOrNull(value?.benchmarkReturnPercent),
    excessReturnPercent: finiteOrNull(value?.excessReturnPercent),
    mae: finiteOrNull(value?.mae ?? value?.maeR),
    mfe: finiteOrNull(value?.mfe ?? value?.mfeR),
    dataAsOf: optionalIso(value?.dataAsOf),
  };
}

function sanitizeCatalyst(cycle) {
  const metadata = sanitizeCycleEventMetadata(cycle?.eventMetadata);
  return {
    kind: cleanText(cycle?.eventKind ?? cycle?.catalyst?.kind, 80),
    eventAt: metadata && metadata.timePrecision !== "exact" ? null
      : optionalIso(cycle?.eventAt ?? cycle?.catalystAt ?? cycle?.catalyst?.eventAt ?? metadata?.eventAt),
    eventId: cleanText(cycle?.eventId ?? cycle?.catalyst?.eventId, 180),
  };
}

function sanitizeCycleEventMetadata(value) {
  if (!value || typeof value !== "object") return null;
  const eventDate = /^\d{4}-\d{2}-\d{2}$/.test(String(value.eventDate ?? "")) ? value.eventDate : null;
  const timePrecision = ["exact", "session", "date"].includes(value.timePrecision) ? value.timePrecision : "date";
  return {
    eventDate,
    timePrecision,
    eventAt: timePrecision === "exact" ? optionalIso(value.eventAt) : null,
    session: ["bmo", "amc", "intraday", "unknown"].includes(value.session) ? value.session : "unknown",
    fiscalQuarter: cleanText(value.fiscalQuarter, 80),
    timezone: cleanText(value.timezone, 80),
    source: cleanText(value.source, 300),
    eventCandidateId: cleanText(value.eventCandidateId, 180),
    symbol: cleanText(value.symbol, 40),
    status: cleanText(value.status, 80),
    confidence: cleanText(value.confidence, 80),
    precisionPolicy: "date_and_session_are_not_exact_timestamps_do_not_infer_cutoff_from_them",
  };
}

function sanitizeLegacyCycleSource(value, { blind = false } = {}) {
  if (!value || typeof value !== "object") return null;
  const boundary = {
    sourceCaseId: cleanText(value.sourceCaseId, 240),
    evidencePosture: "historical_legacy_source_not_new_ex_ante",
    eligibleAsExAnteEvidence: false,
    resultsAreCurrentPhaseRuns: false,
    migrationCreatesIndependentSample: false,
  };
  if (blind) return { ...boundary, contentsWithheldForBlind: true };
  const draft = value.originalJudgment ?? {};
  const textFields = ["myView", "thesis", "marketView", "expectationGap", "narrativeStage", "technicalEvidence",
    "supportingEvidence", "contradictingEvidence", "plannedAction", "invalidation", "fundamentalView", "technicalView"];
  const numericFields = ["marketTemperature", "riskBudgetR", "bullProbability", "baseProbability", "bearProbability",
    "bullPayoffR", "basePayoffR", "bearPayoffR"];
  const originalJudgment = Object.fromEntries([
    ...textFields.map((key) => [key, cleanText(draft[key], 6_000)]),
    ...numericFields.map((key) => [key, finiteOrNull(draft[key])]),
  ]);
  const referenceProjection = (items, keys) => {
    const source = Array.isArray(items) ? items : [];
    return {
      sourceCount: source.length,
      omittedCount: Math.max(0, source.length - 100),
      references: source.slice(0, 100).map((item) => Object.fromEntries(keys.map((key) => [key,
        ["version", "revision", "evidenceRevision"].includes(key) ? finiteOrNull(item?.[key]) : cleanText(item?.[key], 240),
      ]))),
      policy: "historical_reference_only_not_current_phase_or_broker_evidence",
    };
  };
  return {
    ...boundary,
    sourceHash: cleanText(value.sourceHash, 160),
    accountScopeId: cleanText(value.accountScopeId, 160),
    migratedAt: optionalIso(value.migratedAt),
    originalJudgment,
    originalJudgmentLabel: "historical_user_text_preserved_not_newly_sealed",
    associationVersions: referenceProjection(value.associationVersions,
      ["revision", "evidenceRevision", "hash", "changedAt", "confirmedAt"]),
    sealedVersionReferences: referenceProjection(value.sealedVersionReferences,
      ["version", "hash", "sealedAt", "knowledgeCutoffAt", "snapshotHash"]),
    resultReferences: referenceProjection(value.resultReferences,
      ["kind", "sourceCaseId", "hash", "updatedAt"]),
  };
}

function cycleSymbols(cycle) {
  return uniqueStrings([
    ...(Array.isArray(cycle?.symbols) ? cycle.symbols : []),
    cycle?.symbol,
  ]).map((item) => item.toUpperCase()).filter((item) => /^[A-Z0-9._:-]{1,40}$/.test(item)).slice(0, 200);
}

function normalizeCycleType(value) {
  const raw = String(value ?? "").trim();
  if (raw === "earnings_catalyst") return "catalyst";
  if (!["catalyst", "position_lifecycle", "monthly_portfolio", "trade_window"].includes(raw)) {
    throw new Error("复盘周期类型无效。");
  }
  return raw;
}

function normalizeEvidenceGrade(value) {
  const raw = String(value ?? "").trim();
  if (["ex_ante", "prospective"].includes(raw)) return "prospective";
  if (["partial_ex_ante", "partial_prospective"].includes(raw)) return "partial_prospective";
  if (["retrospective", "contaminated"].includes(raw)) return raw;
  return "retrospective";
}

function brokerEvidenceStatus(archive, missingOrderIds, missingExecutionIds) {
  if (!archive?.syncedAt) return "degraded";
  const incomplete = Object.values(archive?.completeness ?? {})
    .some((value) => ["stale", "best_effort", "not_synced"].includes(value));
  return incomplete || stringList(archive?.warnings, 20).length || missingOrderIds.length || missingExecutionIds.length
    ? "degraded"
    : "succeeded";
}

function defaultCycleTask({ cycle, cycleType, phase }) {
  const title = cleanText(cycle?.title, 200) ?? cycleTypeLabel(cycleType);
  if (phase === "blind") {
    return `$review-decision-cycles 对“${title}”执行阶段一盲态复盘。严格只使用 cutoff 及以前证据，分别审计基本面/叙事、技术温度、仓位和计划自洽性；不要查看或推断未来结果。`;
  }
  if (phase === "retrospective") {
    return `$review-decision-cycles 对“${title}”执行订单优先的直接事后复盘。以关联长桥订单与成交为事实起点，结合周期内基本面、技术路径、仓位和执行进行归因；明确没有冻结的事前基线，不得把事后解释写成事前判断。`;
  }
  return `$review-decision-cycles 对“${title}”执行阶段二结果复盘。先原样引用冻结的阶段一判断，再揭示基本面变化、技术路径、真实执行与结果，分开评价决策、执行、结果和归因，并提出继续、验证、规避。`;
}

function cycleTypeLabel(value) {
  return {
    catalyst: "财报 / 催化剂周期",
    position_lifecycle: "单一持仓生命周期",
    monthly_portfolio: "月度组合周期",
    trade_window: "单标的订单区间",
  }[value] ?? value;
}

function phaseLabel(value) {
  if (value === "blind") return "阶段一盲态复盘";
  if (value === "retrospective") return "直接事后复盘";
  return "阶段二结果复盘";
}

function orderAt(value) {
  return value?.submittedAt ?? value?.updatedAt ?? null;
}

function executionAt(value) {
  return value?.doneAt ?? null;
}

function beforeCutoff(value, cutoffAt) {
  const millis = Date.parse(String(value ?? ""));
  return Number.isFinite(millis) && millis < Date.parse(cutoffAt);
}

function atOrBeforeCycleEnd(value, endAt) {
  const millis = Date.parse(String(value ?? ""));
  return Number.isFinite(millis) && millis <= Date.parse(endAt);
}

function beforeStart(value, startAt) {
  const millis = Date.parse(String(value ?? ""));
  const startMs = Date.parse(String(startAt ?? ""));
  return Number.isFinite(millis) && Number.isFinite(startMs) && millis < startMs;
}

function periodRelation(value, startAt, endAt) {
  const millis = Date.parse(String(value ?? ""));
  const startMs = Date.parse(String(startAt ?? ""));
  const endMs = Date.parse(String(endAt ?? ""));
  if (!Number.isFinite(millis)) return "time_unknown";
  if (Number.isFinite(startMs) && millis < startMs) return "pre_cycle_context";
  if (Number.isFinite(endMs) && millis > endMs) return "post_cycle_excluded";
  return "in_cycle";
}

function inRange(value, startMs, endMs) {
  const millis = Date.parse(String(value ?? ""));
  return Number.isFinite(millis) && millis >= startMs && millis <= endMs;
}

function optionalIso(value) {
  if (value == null || value === "") return null;
  const millis = Date.parse(String(value));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function cleanText(value, limit) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, limit) : null;
}

function finiteOrNull(value) {
  if (value == null || typeof value === "boolean") return null;
  if (typeof value === "string" && !value.trim()) return null;
  if (!["number", "string"].includes(typeof value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveFiniteOrNull(value) {
  const number = finiteOrNull(value);
  return number != null && number > 0 ? number : null;
}

function positiveRevision(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean))];
}

function stringList(values, limit) {
  return (Array.isArray(values) ? values : [])
    .map((value) => cleanText(value, 500))
    .filter(Boolean)
    .slice(0, limit);
}
