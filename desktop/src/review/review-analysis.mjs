const MAX_REVIEW_CASES = 100;

/** Build a sanitized, order-backed evidence run for the existing Codex harness. */
export function buildReviewAnalysisRun({
  workspace,
  archive,
  caseIds,
  runId,
  task = "",
  portfolio = null,
} = {}) {
  const selectedIds = uniqueStrings(caseIds);
  if (!selectedIds.length) throw new Error("请至少选择一个复盘案例。");
  assertReviewCaseLimit(selectedIds);
  const casesById = new Map((workspace?.cases ?? []).map((item) => [String(item.id), item]));
  const missing = selectedIds.filter((id) => !casesById.has(id));
  if (missing.length) throw new Error("部分复盘案例不存在或已被移除。");
  const selectedCases = selectedIds.map((id) => casesById.get(id));
  const unconfirmedCases = selectedCases.filter((item) => {
    const linkCount = uniqueStrings([
      ...(item?.brokerLinks?.orderIds ?? []),
      ...(item?.brokerLinks?.executionIds ?? []),
    ]).length;
    return !item?.brokerLinks?.confirmedAt || linkCount === 0;
  });
  if (unconfirmedCases.length) {
    throw new Error("复盘 Agent 仅接受已由用户确认关联的历史订单或成交；请先完成订单关联。");
  }
  const mode = reviewMode(selectedCases);
  const orderById = new Map((archive?.orders ?? []).map((item) => [String(item.orderId), item]));
  const executionById = new Map((archive?.executions ?? []).map((item) => [String(item.tradeId), item]));
  const cases = selectedCases.map((reviewCase) => sanitizeCase(
    reviewCase,
    orderById,
    executionById,
  ));
  const linkedRuleIds = new Set(cases.flatMap((item) => item.ruleIds));
  const selectedIdSet = new Set(selectedIds);
  const relatedTests = (workspace?.tests ?? [])
    .filter((item) => selectedIdSet.has(String(item.caseId ?? ""))
      || (!item.caseId && linkedRuleIds.has(String(item.ruleId ?? ""))))
    .map(sanitizeTest);
  const relatedRules = (workspace?.rules ?? [])
    .filter((item) => linkedRuleIds.has(String(item.id)))
    .map(sanitizeRule);
  const singleSymbol = new Set(cases.map((item) => item.symbol)).size === 1
    ? cases[0].symbol
    : null;
  const snapshotAt = archive?.syncedAt ?? workspace?.updatedAt ?? new Date().toISOString();
  const analysisTask = String(task || defaultTask(mode, cases)).trim().slice(0, 4_000);
  const brokerEvidenceStatus = reviewBrokerEvidenceStatus(archive, cases);

  return {
    id: String(runId || `review-${Date.now()}`),
    createdAt: new Date().toISOString(),
    elapsedMs: 0,
    task: analysisTask,
    state: "REVIEW_READY",
    context: {
      scope: "review",
      reviewMode: mode,
      reviewCaseIds: selectedIds,
      symbol: singleSymbol,
      snapshotAt,
      valuationSchemaVersion: portfolio?.valuationSchemaVersion ?? null,
    },
    analysisContext: {
      scope: "review",
      reviewMode: mode,
      sampleUnit: "symbol × earnings_event × decision_package",
      portfolioSummary: portfolio ? {
        snapshotAt: portfolio.syncedAt ?? null,
        baseCurrency: portfolio.account?.baseCurrency ?? "USD",
        netAssets: finiteOrNull(portfolio.totals?.netAssets),
        grossExposurePercent: finiteOrNull(portfolio.totals?.grossExposurePercent),
      } : null,
      dataCoverage: {
        brokerSource: archive?.source ?? "Longbridge MCP · read only",
        brokerSyncedAt: archive?.syncedAt ?? null,
        brokerRange: archive?.range ?? null,
        capabilities: archive?.capabilities ?? {},
        completeness: archive?.completeness ?? {},
        warnings: stringList(archive?.warnings, 20),
        orderCount: archive?.orders?.length ?? 0,
        executionCount: archive?.executions?.length ?? 0,
      },
      cases,
      tests: relatedTests,
      rules: relatedRules,
      evidencePolicy: {
        factLayers: [
          "broker_facts",
          "event_facts",
          "user_ex_ante",
          "derived_metrics",
          "agent_inference",
        ],
        fiscalQuarterFromOrderTimestamp: false,
        orderWrite: false,
        ruleAutoPromotion: false,
      },
    },
    technical: null,
    risk: null,
    plan: { available: false, reason: "复盘输出不会生成或执行真实订单。" },
    sections: ["conclusion", "evidence"],
    evidence: [
      {
        source: archive?.source ?? "Longbridge MCP · read only",
        tool: "review:broker-history",
        asOf: archive?.syncedAt ?? null,
        records: cases.reduce((total, item) => total + item.orders.length + item.executions.length, 0),
        status: brokerEvidenceStatus,
        summary: "仅包含用户已确认关联的历史订单与逐笔成交。",
      },
      {
        source: "本机加密复盘台账",
        tool: "review:ledger",
        asOf: workspace?.updatedAt ?? null,
        records: cases.length,
        status: "succeeded",
        summary: `${modeLabel(mode)} · ${cases.length} 个决策包`,
      },
    ],
    safeguards: {
      orderWrite: false,
      brokerFactsImmutable: true,
      userExAnteVersioned: true,
      ruleAutoPromotion: false,
    },
    capabilities: {
      modelNarration: true,
      persistentThread: true,
      skills: true,
      mcp: true,
      brokerHistory: Boolean(archive?.syncedAt),
    },
  };
}

export function selectReviewCaseIds(workspace, {
  caseId = null,
  caseIds = [],
  fiscalQuarter = null,
} = {}) {
  const explicit = uniqueStrings([caseId, ...(Array.isArray(caseIds) ? caseIds : [])]);
  if (explicit.length) {
    assertReviewCaseLimit(explicit);
    return explicit;
  }
  const quarter = cleanText(fiscalQuarter, 80);
  if (!quarter) return [];
  const matches = (workspace?.cases ?? [])
    .filter((item) => !item.archived && String(item.fiscalQuarter ?? "") === quarter)
    .map((item) => String(item.id));
  assertReviewCaseLimit(matches);
  return matches;
}

function sanitizeCase(reviewCase, orderById, executionById) {
  const linkedOrderIds = uniqueStrings(reviewCase?.brokerLinks?.orderIds);
  const linkedExecutionIds = uniqueStrings(reviewCase?.brokerLinks?.executionIds);
  const orderRefs = new Map(linkedOrderIds.map((id, index) => [id, `order-${index + 1}`]));
  const executionRefs = new Map(linkedExecutionIds.map((id, index) => [id, `execution-${index + 1}`]));
  const orders = linkedOrderIds
    .map((id) => orderById.get(id))
    .filter(Boolean)
    .map((item) => sanitizeOrder(item, orderRefs.get(String(item.orderId))));
  const executions = linkedExecutionIds
    .map((id) => executionById.get(id))
    .filter(Boolean)
    .map((item) => sanitizeExecution(
      item,
      executionRefs.get(String(item.tradeId)),
      orderRefs.get(String(item.orderId)) ?? null,
    ));
  const missingOrderIds = linkedOrderIds.filter((id) => !orderById.has(id));
  const missingExecutionIds = linkedExecutionIds.filter((id) => !executionById.has(id));
  return {
    id: String(reviewCase.id),
    symbol: String(reviewCase.symbol ?? ""),
    fiscalQuarter: reviewCase.fiscalQuarter ?? "待确认季度",
    event: {
      id: reviewCase.event?.id
        ?? reviewCase.eventMetadata?.eventCandidateId
        ?? reviewCase.earningsEventId
        ?? null,
      eventAt: reviewCase.eventAt ?? null,
      session: reviewCase.eventSession ?? "unknown",
      timezone: reviewCase.timezone ?? null,
      source: reviewCase.event?.source
        ?? reviewCase.eventMetadata?.source
        ?? reviewCase.eventSource
        ?? null,
      associationStatus: reviewCase.event?.associationStatus
        ?? reviewCase.eventMetadata?.status
        ?? reviewCase.eventAssociationStatus
        ?? "unknown",
    },
    strategyType: reviewCase.strategyType ?? "other",
    benchmark: reviewCase.benchmark ?? null,
    primaryHorizon: reviewCase.primaryHorizon ?? null,
    status: reviewCase.status ?? null,
    createdAt: reviewCase.createdAt ?? null,
    updatedAt: reviewCase.updatedAt ?? null,
    brokerAssociation: {
      confirmedAt: reviewCase.brokerLinks?.confirmedAt ?? null,
      linkedOrderCount: linkedOrderIds.length,
      linkedExecutionCount: linkedExecutionIds.length,
      missingOrderCount: missingOrderIds.length,
      missingExecutionCount: missingExecutionIds.length,
    },
    orders,
    executions,
    exAnteDraft: reviewCase.exAnteDraft ?? null,
    exAnteVersions: (reviewCase.exAnteVersions ?? []).map((version) => ({
      version: version.version,
      sealedAt: version.sealedAt,
      timing: version.timing,
      eligibleForFormalStats: version.eligibleForFormalStats === true,
      hash: version.hash ?? null,
      snapshot: version.snapshot ?? null,
    })),
    outcome: reviewCase.outcome ?? null,
    review: reviewCase.review ?? null,
    ruleIds: uniqueStrings(reviewCase.ruleIds),
  };
}

function sanitizeOrder(item, recordRef) {
  return {
    kind: "order",
    recordRef,
    symbol: item.symbol,
    side: item.side ?? null,
    status: item.status ?? null,
    orderType: item.orderType ?? null,
    quantity: finiteOrNull(item.quantity),
    executedQuantity: finiteOrNull(item.executedQuantity),
    submittedPrice: finiteOrNull(item.submittedPrice),
    executedPrice: finiteOrNull(item.executedPrice),
    currency: item.currency ?? null,
    submittedAt: item.submittedAt ?? null,
    updatedAt: item.updatedAt ?? null,
  };
}

function sanitizeExecution(item, recordRef, orderRecordRef) {
  return {
    kind: "execution",
    recordRef,
    orderRecordRef,
    symbol: item.symbol,
    side: item.side ?? null,
    quantity: finiteOrNull(item.quantity),
    price: finiteOrNull(item.price),
    currency: item.currency ?? null,
    doneAt: item.doneAt ?? null,
  };
}

function sanitizeTest(item) {
  return {
    id: item.id,
    caseId: item.caseId ?? null,
    ruleId: item.ruleId ?? null,
    title: item.title ?? null,
    hypothesis: item.hypothesis ?? null,
    primaryMetric: item.primaryMetric ?? null,
    primaryHorizon: item.primaryHorizon ?? null,
    status: item.status ?? null,
    registeredAt: item.registeredAt ?? null,
    completedAt: item.completedAt ?? null,
    outcomeR: finiteOrNull(item.outcomeR),
    outcomeVerified: item.outcomeVerified === true,
    censored: item.censored === true,
  };
}

function sanitizeRule(item) {
  return {
    id: item.id,
    title: item.title ?? null,
    condition: item.condition ?? null,
    action: item.action ?? null,
    falsification: item.falsification ?? null,
    scope: item.scope ?? null,
    status: item.status ?? null,
    version: item.version ?? null,
    caseIds: uniqueStrings(item.caseIds),
  };
}

function reviewMode(cases) {
  if (cases.length === 1) return "single_event";
  const quarters = new Set(cases.map((item) => String(item.fiscalQuarter ?? "待确认季度")));
  return quarters.size === 1 ? "earnings_quarter" : "cross_quarter_validation";
}

function defaultTask(mode, cases) {
  if (mode === "single_event") {
    return `$review-earnings-decisions 复盘 ${cases[0].symbol} ${cases[0].fiscalQuarter} 的已确认订单与成交，区分决策质量、执行质量和结果运气，并提出继续、验证、规避。`;
  }
  if (mode === "earnings_quarter") {
    return `$review-earnings-decisions 对 ${cases[0].fiscalQuarter} 的 ${cases.length} 个财报决策包做通盘复盘，报告样本漏斗、胜率、赔率、期望、尾部风险、执行纪律和下一季度验证计划。`;
  }
  return `$review-earnings-decisions 对 ${cases.length} 个跨季度财报决策包做规则验证，比较发现集与留出集，提出规则保留、修改、降级或退役建议，等待人工 Review。`;
}

function modeLabel(value) {
  return {
    single_event: "单事件复盘",
    earnings_quarter: "财报季度通盘复盘",
    cross_quarter_validation: "跨季度规则验证",
  }[value] ?? "复盘";
}

function reviewBrokerEvidenceStatus(archive, cases) {
  if (!archive?.syncedAt) return "degraded";
  const completeness = Object.values(archive?.completeness ?? {});
  const incompleteStream = completeness.some((value) => ["stale", "best_effort", "not_synced"].includes(value));
  const brokerWarnings = stringList(archive?.warnings, 20);
  const missingLinkedRecord = cases.some((item) =>
    item.brokerAssociation.missingOrderCount > 0
    || item.brokerAssociation.missingExecutionCount > 0);
  return incompleteStream || brokerWarnings.length > 0 || missingLinkedRecord
    ? "degraded"
    : "succeeded";
}

function assertReviewCaseLimit(caseIds) {
  if (caseIds.length > MAX_REVIEW_CASES) {
    throw new Error(`一次最多分析 ${MAX_REVIEW_CASES} 个复盘案例；请缩小季度或分批验证，系统不会静默截断。`);
  }
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

function cleanText(value, limit) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, limit) : null;
}

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
