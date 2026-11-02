import { createHash } from "node:crypto";

export const REVIEW_TECHNICAL_VALIDATION_SCHEMA_VERSION = "review-technical-validation/v1";
export const REVIEW_TECHNICAL_VALIDATION_METHOD_VERSION = "radar-entry-outcome-bridge/v1";
export const MIN_FORMAL_FORWARD_SAMPLES = 20;

const OBSERVABLE_STATE_FIELDS = Object.freeze([
  "coverageStatus",
  "technicalStatus",
  "dailySequenceStatus",
  "shortStructure",
  "longStructure",
  "priceVsEma21",
  "weeklyDirection",
  "weeklySwing",
  "costMigration",
  "cost14Location",
  "cost14Acceptance",
  "cost28Location",
  "cost28Acceptance",
  "qqqExcess5State",
  "qqqExcess20State",
  "sectorExcess20State",
  "marketEvidenceState",
]);

const EMA_PERIODS = Object.freeze(["3", "5", "8", "13", "21", "144", "169"]);

/**
 * Deterministically joins one explicitly selected trade cycle to the last
 * account-scoped radar batch that was both computed and recorded strictly
 * before its first selected Buy. It never reads current positions, current
 * quotes, or later radar state.
 */
export function buildReviewTechnicalValidationSample({
  accountScopeId,
  radarBatches = [],
  cycle,
  verifiedOutcome,
  validationProtocol = null,
  requestedMode = null,
} = {}) {
  const scope = cleanText(accountScopeId, 160);
  const normalizedOutcome = normalizeVerifiedOutcome(verifiedOutcome);
  const cycleIdentity = normalizeCycleIdentity(cycle, normalizedOutcome);
  const selection = selectEntryRadarSnapshot({
    accountScopeId: scope,
    radarBatches,
    cutoffAt: cycleIdentity.entryCutoffAt,
    symbol: cycleIdentity.symbol,
  });
  const validationMode = classifyValidationMode({
    entryCutoffAt: cycleIdentity.entryCutoffAt,
    validationProtocol,
    requestedMode,
  });
  const technical = buildTechnicalEvidence(selection);
  const outcome = buildOutcomeEvidence(normalizedOutcome, cycleIdentity);
  const riskR = buildRiskREvidence(cycle, normalizedOutcome);
  const revisionBinding = bindEvidenceRevision(cycleIdentity, normalizedOutcome);
  const evidenceBinding = buildEvidenceBinding({
    accountScopeId: scope,
    cycleIdentity,
    selection,
    normalizedOutcome,
  });
  const sampleCandidate = buildSampleCandidate({
    scope,
    cycleIdentity,
    selection,
    outcome,
    validationMode,
    revisionBinding,
  });
  const ruleCandidate = buildRuleCandidate({
    cycleIdentity,
    technical,
    outcome,
    validationMode,
    sampleCandidate,
  });
  const reasons = uniqueSorted([
    ...cycleIdentity.reasons,
    ...selection.coverage.reasonCodes,
    ...normalizedOutcome.reasons,
    ...outcome.reasonCodes,
    ...revisionBinding.reasonCodes,
  ]);
  const hasSnapshot = selection.batch != null && selection.item != null;
  const hasOutcome = outcome.status !== "unavailable";
  const status = hasSnapshot && hasOutcome && reasons.length === 0
    ? "complete"
    : hasSnapshot || hasOutcome ? "partial" : "unavailable";

  const body = {
    schemaVersion: REVIEW_TECHNICAL_VALIDATION_SCHEMA_VERSION,
    methodVersion: REVIEW_TECHNICAL_VALIDATION_METHOD_VERSION,
    status,
    reasonCodes: reasons,
    cycle: cycleIdentity.public,
    validationMode,
    entrySnapshot: {
      coverage: selection.coverage,
      batch: publicBatchReference(selection.batch),
      technical,
    },
    outcome,
    riskR,
    revisionBinding,
    sampleCandidate,
    ruleCandidate,
    evidenceBinding,
    provenance: {
      deterministic: true,
      currentPortfolioLookupAllowed: false,
      currentHoldingInferenceAllowed: false,
      cutoffPolicy: "computedAt and recordedAt must both be strictly before the earliest explicitly selected Buy",
      outcomePolicy: "Host-verified explicit-selection FIFO/path outputs are referenced; MAE/MFE and returns are not recomputed here.",
      missingValuePolicy: "Missing values remain null/N/A with a reason; observed zero remains available.",
      formalRulePolicy: `Historical calibration is discovery-only. At least ${MIN_FORMAL_FORWARD_SAMPLES} eligible walk-forward candidates from unique cycles, overlap/same-event independence checks, deterministic verification, and human review are required before rule promotion.`,
    },
  };
  return deepFreeze({
    ...body,
    resultHash: sha256(stableStringify(body)),
  });
}

/**
 * Rebuilds the deterministic binding and reports whether a persisted sample
 * still cites the current cycle evidence, selected radar revision and verified
 * outcome. A changed broker evidenceRevision is always stale.
 */
export function assessReviewTechnicalValidationStaleness({
  result,
  accountScopeId,
  radarBatches = [],
  cycle,
  verifiedOutcome,
  validationProtocol = null,
  requestedMode = null,
} = {}) {
  if (!result || typeof result !== "object") {
    return deepFreeze({ status: "unverifiable", reasonCodes: ["stored_result_missing"], currentResultHash: null });
  }
  const current = buildReviewTechnicalValidationSample({
    accountScopeId,
    radarBatches,
    cycle,
    verifiedOutcome,
    validationProtocol,
    requestedMode,
  });
  const stored = result.evidenceBinding ?? {};
  const next = current.evidenceBinding ?? {};
  const reasons = [];
  compareBinding(reasons, stored, next, "accountScopeId", "account_scope_changed");
  compareBinding(reasons, stored, next, "cycleAccountScopeId", "cycle_account_scope_changed");
  compareBinding(reasons, stored, next, "cycleId", "cycle_id_changed");
  compareBinding(reasons, stored, next, "symbol", "cycle_symbol_changed");
  compareBinding(reasons, stored, next, "entryCutoffAt", "selected_trade_entry_changed");
  compareBinding(reasons, stored, next, "cycleEvidenceRevision", "cycle_evidence_revision_changed");
  compareBinding(reasons, stored, next, "radarBatchId", "entry_radar_batch_changed");
  compareBinding(reasons, stored, next, "radarBatchRevision", "entry_radar_revision_changed");
  compareBinding(reasons, stored, next, "radarBatchRecordHash", "entry_radar_record_hash_changed");
  compareBinding(reasons, stored, next, "outcomeEvidenceRevision", "outcome_evidence_revision_changed");
  compareBinding(reasons, stored, next, "outcomeInputHash", "verified_outcome_changed");
  if (stored.cycleEvidenceRevision == null || next.cycleEvidenceRevision == null) {
    reasons.push("cycle_evidence_revision_unbound");
  }
  if (!next.radarBatchId && stored.radarBatchId) reasons.push("entry_radar_snapshot_no_longer_resolves");
  const uniqueReasons = uniqueSorted(reasons);
  return deepFreeze({
    status: uniqueReasons.length ? "stale" : "current",
    reasonCodes: uniqueReasons,
    storedResultHash: cleanHash(result.resultHash),
    currentResultHash: current.resultHash,
    storedBindingHash: cleanHash(stored.bindingHash),
    currentBindingHash: cleanHash(next.bindingHash),
  });
}

/**
 * Applies an explicit success criterion to already-built samples. Calibration
 * and walk-forward observations are reported separately. Repeated sample IDs
 * are idempotently deduplicated; conflicting duplicates are excluded.
 */
export function evaluateReviewTechnicalRuleEvidence({
  ruleKey,
  samples = [],
  criterion,
  minimumForwardSamples = MIN_FORMAL_FORWARD_SAMPLES,
} = {}) {
  const normalizedRuleKey = cleanText(ruleKey, 160);
  const normalizedCriterion = normalizeCriterion(criterion);
  const minimum = Math.max(
    MIN_FORMAL_FORWARD_SAMPLES,
    positiveInteger(minimumForwardSamples) ?? MIN_FORMAL_FORWARD_SAMPLES,
  );
  const deduped = dedupeSamples(samples);
  const matching = deduped.samples.filter((sample) => (
    sample?.ruleCandidate?.ruleKey === normalizedRuleKey
    && sample?.sampleCandidate?.status === "available"
    && (sample?.sourceStatus === "current" || sample?.staleness?.status === "current")
  ));
  const evaluated = matching.map((sample) => evaluateSample(sample, normalizedCriterion));
  const walkForward = summarizeEvaluations(
    evaluated.filter((item) => item.mode === "walk_forward" && item.formalEligible),
  );
  const historical = summarizeEvaluations(
    evaluated.filter((item) => item.mode === "historical_calibration"),
  );
  const formalSampleMinimumReached = normalizedCriterion.status === "available"
    && walkForward.evaluatedCount >= minimum;
  const reasonCodes = uniqueSorted([
    ...deduped.reasonCodes,
    ...(deduped.samples.some((sample) => (
      sample?.ruleCandidate?.ruleKey === normalizedRuleKey
      && sample?.sampleCandidate?.status === "available"
      && sample?.sourceStatus !== "current"
      && sample?.staleness?.status !== "current"
    )) ? ["samples_without_current_staleness_audit_excluded"] : []),
    ...(normalizedRuleKey ? [] : ["rule_key_missing"]),
    ...(normalizedCriterion.status === "available" ? [] : [normalizedCriterion.reason]),
    ...(formalSampleMinimumReached ? [] : ["insufficient_independent_walk_forward_samples"]),
    ...(historical.evaluatedCount ? ["historical_calibration_excluded_from_formal_statistics"] : []),
  ]);
  const body = {
    schemaVersion: REVIEW_TECHNICAL_VALIDATION_SCHEMA_VERSION,
    methodVersion: REVIEW_TECHNICAL_VALIDATION_METHOD_VERSION,
    ruleKey: normalizedRuleKey,
    criterion: normalizedCriterion,
    minimumForwardSamples: minimum,
    uniqueSampleCount: deduped.samples.length,
    matchingSampleCount: matching.length,
    walkForward: {
      ...walkForward,
      descriptiveOnly: !formalSampleMinimumReached,
    },
    historicalCalibration: {
      ...historical,
      descriptiveOnly: true,
      includedInFormalStatistics: false,
    },
    promotion: {
      status: formalSampleMinimumReached ? "ready_for_human_review" : "insufficient_forward_evidence",
      automaticPromotion: false,
      formalRuleCreated: false,
      humanReviewRequired: true,
      reasonCodes,
    },
  };
  return deepFreeze({ ...body, resultHash: sha256(stableStringify(body)) });
}

function normalizeCycleIdentity(cycle, outcome) {
  const cycleId = cleanText(cycle?.id, 240);
  const cycleType = cleanText(cycle?.cycleType ?? cycle?.type, 80)?.toLowerCase() ?? null;
  const evidenceRevision = positiveInteger(
    cycle?.evidenceRevision ?? cycle?.brokerLinks?.evidenceRevision ?? cycle?.brokerLinks?.revision,
  );
  const accountScopeId = cleanText(cycle?.brokerLinks?.accountScopeId ?? cycle?.accountScopeId, 160);
  const entryCutoffAt = optionalIso(outcome.tradePath?.window?.startAt);
  const exitAt = optionalIso(outcome.tradePath?.window?.endAt);
  const outcomeSymbol = normalizeSymbol(outcome.tradePath?.symbol);
  const declaredSymbols = uniqueSorted([
    ...(Array.isArray(cycle?.symbols) ? cycle.symbols : []),
    cycle?.symbol,
  ].map(normalizeSymbol).filter(Boolean));
  const symbol = outcomeSymbol ?? (declaredSymbols.length === 1 ? declaredSymbols[0] : null);
  const reasons = [];
  if (!cycleId) reasons.push("cycle_id_missing");
  if (cycleType !== "trade_window") reasons.push("explicit_trade_window_cycle_required");
  if (!entryCutoffAt) reasons.push("verified_trade_entry_cutoff_missing");
  if (!exitAt) reasons.push("verified_trade_exit_missing");
  if (entryCutoffAt && exitAt && Date.parse(exitAt) < Date.parse(entryCutoffAt)) reasons.push("verified_trade_window_invalid");
  if (!symbol) reasons.push("single_trade_symbol_missing");
  if (outcomeSymbol && declaredSymbols.length && !declaredSymbols.includes(outcomeSymbol)) {
    reasons.push("verified_outcome_symbol_cycle_mismatch");
  }
  if (!evidenceRevision) reasons.push("cycle_evidence_revision_missing");
  if (!accountScopeId) reasons.push("cycle_account_scope_missing");
  return {
    cycleId,
    cycleType,
    evidenceRevision,
    accountScopeId,
    entryCutoffAt,
    exitAt,
    symbol,
    reasons,
    public: {
      id: cycleId,
      type: cycleType,
      symbol,
      entryCutoffAt,
      exitAt,
      evidenceRevision,
      accountScopeId,
      selectionPolicy: "earliest_explicitly_selected_buy_to_latest_explicitly_selected_sell",
    },
  };
}

function selectEntryRadarSnapshot({ accountScopeId, radarBatches, cutoffAt, symbol }) {
  const batches = Array.isArray(radarBatches) ? radarBatches : [];
  const cutoffMs = parseTime(cutoffAt);
  const diagnostics = {
    suppliedBatchCount: batches.length,
    otherScopeBatchCount: 0,
    invalidBatchCount: 0,
    atOrAfterCutoffBatchCount: 0,
    recordedAfterCutoffBatchCount: 0,
    eligibleBatchCount: 0,
  };
  const eligible = [];
  for (const batch of batches) {
    if (cleanText(batch?.accountScopeId, 160) !== accountScopeId) {
      diagnostics.otherScopeBatchCount += 1;
      continue;
    }
    const computedMs = parseTime(batch?.computedAt);
    const recordedMs = parseTime(batch?.recordedAt);
    if (!Number.isFinite(computedMs) || !Number.isFinite(recordedMs) || recordedMs < computedMs) {
      diagnostics.invalidBatchCount += 1;
      continue;
    }
    if (!Number.isFinite(cutoffMs) || computedMs >= cutoffMs) {
      diagnostics.atOrAfterCutoffBatchCount += 1;
      continue;
    }
    if (recordedMs >= cutoffMs) {
      diagnostics.recordedAfterCutoffBatchCount += 1;
      continue;
    }
    eligible.push(batch);
  }
  eligible.sort(compareRadarBatches);
  diagnostics.eligibleBatchCount = eligible.length;
  const batch = eligible.at(-1) ?? null;
  const item = batch && symbol
    ? (Array.isArray(batch.items) ? batch.items : []).find((value) => normalizeSymbol(value?.symbol) === symbol) ?? null
    : null;
  const priorBatch = batch
    ? eligible.filter((candidate) => String(candidate?.tradingDate ?? "") < String(batch?.tradingDate ?? "")).at(-1) ?? null
    : null;
  const priorItem = priorBatch && symbol
    ? (Array.isArray(priorBatch.items) ? priorBatch.items : []).find((value) => normalizeSymbol(value?.symbol) === symbol) ?? null
    : null;
  const reasonCodes = [];
  if (!accountScopeId) reasonCodes.push("account_scope_missing");
  if (!Number.isFinite(cutoffMs)) reasonCodes.push("entry_cutoff_invalid");
  if (!batch) reasonCodes.push("pre_entry_radar_batch_missing");
  if (batch && !item) reasonCodes.push("symbol_missing_from_latest_pre_entry_batch");
  if (batch && !cleanHash(batch?.recordHash)) reasonCodes.push("entry_radar_record_hash_missing");
  if (diagnostics.invalidBatchCount) reasonCodes.push("invalid_radar_batches_excluded");
  if (diagnostics.recordedAfterCutoffBatchCount) reasonCodes.push("late_recorded_radar_batches_excluded");
  const cardStatus = String(item?.status ?? "").toLowerCase();
  if (item && ["degraded", "partial", "unavailable"].includes(cardStatus)) {
    reasonCodes.push(`entry_technical_card_${cardStatus}`);
  }
  const coverageStatus = !batch || !item
    ? "unavailable"
    : cardStatus === "complete" || cardStatus === "available" ? "complete" : "partial";
  return {
    batch,
    item,
    priorBatch,
    priorItem,
    coverage: {
      status: coverageStatus,
      reasonCodes: uniqueSorted(reasonCodes),
      cutoffAt: optionalIso(cutoffAt),
      cutoffStrict: true,
      latestAccountBatchPolicy: "latest eligible account batch; an older symbol batch is never substituted when the latest batch omits the symbol",
      computedBeforeCutoff: batch ? Date.parse(batch.computedAt) < cutoffMs : false,
      recordedBeforeCutoff: batch ? Date.parse(batch.recordedAt) < cutoffMs : false,
      batchAgeAtEntryMs: batch ? cutoffMs - Date.parse(batch.computedAt) : null,
      symbolPresent: Boolean(item),
      ...diagnostics,
    },
  };
}

function buildTechnicalEvidence(selection) {
  const item = selection.item;
  if (!item) {
    return {
      status: "unavailable",
      reason: "entry_technical_item_unavailable",
      state: null,
      stateHash: null,
      numericContext: null,
      transition: unavailableTransition(selection.priorBatch ? "symbol_missing_from_prior_batch" : "prior_radar_batch_missing"),
    };
  }
  const state = normalizeObservableState(item.observableState);
  const priorState = selection.priorItem ? normalizeObservableState(selection.priorItem.observableState) : null;
  const changedFields = priorState ? OBSERVABLE_STATE_FIELDS.flatMap((field) => (
    stableStringify(priorState[field]) === stableStringify(state[field])
      ? []
      : [{ field, from: priorState[field], to: state[field] }]
  )) : [];
  const transition = priorState ? {
    status: "available",
    reason: null,
    kind: changedFields.length ? "state_changed" : "unchanged",
    fromBatch: publicBatchReference(selection.priorBatch),
    toBatch: publicBatchReference(selection.batch),
    changedFields,
    embeddedScannerComparison: compactComparison(item.comparison),
  } : {
    ...unavailableTransition(selection.priorBatch ? "symbol_missing_from_prior_batch" : "prior_trading_date_radar_batch_missing"),
    embeddedScannerComparison: compactComparison(item.comparison),
  };
  return {
    status: selection.coverage.status,
    reason: selection.coverage.status === "complete" ? null : selection.coverage.reasonCodes[0] ?? "entry_technical_degraded",
    state,
    stateHash: sha256(stableStringify(state)),
    numericContext: {
      lastClose: compactValueNode(item.lastClose),
      ema: Object.fromEntries(EMA_PERIODS.map((period) => [period, compactEmaNode(item?.ema?.[period])])),
      qqqExcessReturns: {
        "5": compactValueNode(item?.metrics?.qqqExcessReturns?.["5"]),
        "20": compactValueNode(item?.metrics?.qqqExcessReturns?.["20"]),
      },
      costProfile14d28d: compactCostNode(item?.costProfile14d28d),
    },
    transition,
  };
}

function normalizeVerifiedOutcome(value) {
  const wrapper = value && typeof value === "object" ? value : {};
  const root = unwrapOutcomeMetrics(wrapper);
  const tradePath = root?.tradePricePath
    ?? root?.selectedTradePricePath
    ?? (root?.window && root?.pricePath ? root : null);
  const explicitVerification = String(wrapper?.verification?.status ?? "").toLowerCase();
  const explicitMethod = String(wrapper?.verification?.method ?? "").toLowerCase();
  const deterministicHost = root?.provenance?.deterministicHostCalculation === true
    || wrapper?.provenance?.deterministicHostCalculation === true;
  const selectedOnly = tradePath?.coverage?.selectedOnly === true
    || root?.executionPnl?.coverage?.selectionScope === "explicit_user_selected_buy_sell_activities";
  const explicitlyVerified = ["verified", "valid"].includes(explicitVerification)
    && (explicitMethod.includes("fifo") || explicitMethod.includes("explicit"));
  const integrityInvalid = ["invalid", "mismatch", "corrupt"].includes(
    String(wrapper?.integrityStatus ?? root?.integrityStatus ?? "").toLowerCase(),
  );
  const verified = !integrityInvalid && (explicitlyVerified || (deterministicHost && selectedOnly));
  const evidenceRevision = positiveInteger(
    wrapper?.evidenceRevision ?? wrapper?.reviewEvidenceRevision ?? root?.evidenceRevision,
  );
  const declaredResultHash = cleanHash(
    wrapper?.resultHash ?? wrapper?.phaseResultHash ?? root?.resultHash,
  );
  const outcomeInput = {
    tradePath: stableJson(tradePath),
    pricePath: stableJson(root?.pricePath),
    riskR: stableJson(wrapper?.riskR ?? root?.riskR),
    netR: finiteOrNull(wrapper?.netR ?? root?.netR ?? root?.outcome?.netR),
  };
  const reasons = [];
  if (!tradePath) reasons.push("verified_trade_price_path_missing");
  if (!verified) reasons.push(integrityInvalid ? "verified_outcome_integrity_invalid" : "host_fifo_outcome_verification_missing");
  return {
    wrapper,
    root,
    tradePath,
    verified,
    evidenceRevision,
    declaredResultHash,
    outcomeInputHash: sha256(stableStringify(outcomeInput)),
    reasons,
  };
}

function unwrapOutcomeMetrics(value) {
  return value?.metrics?.tradePricePath ? value.metrics
    : value?.outcomeMetrics?.tradePricePath ? value.outcomeMetrics
      : value?.result?.outcomeMetrics?.tradePricePath ? value.result.outcomeMetrics
        : value?.result?.metrics?.tradePricePath ? value.result.metrics
          : value;
}

function buildOutcomeEvidence(outcome, cycleIdentity) {
  const path = outcome.tradePath?.pricePath ?? {};
  const root = outcome.root ?? {};
  const symbol = cycleIdentity.symbol;
  const benchmark = normalizeSymbol(root?.pricePath?.benchmark);
  const excessRow = (Array.isArray(root?.pricePath?.excessReturns) ? root.pricePath.excessReturns : [])
    .find((item) => normalizeSymbol(item?.symbol) === symbol);
  const verifiedMetric = (value, options) => outcome.verified
    ? metricReference(value, options)
    : unavailableMetric(options.unit, "host_fifo_outcome_not_verified");
  const holdingPeriodReturn = verifiedMetric(path?.periodReturnPercent, {
    unit: "percent_point",
    source: "verifiedOutcome.tradePricePath.pricePath.periodReturnPercent",
    reason: path?.reason ?? "verified_holding_period_return_unavailable",
  });
  const qqqExcess = benchmark === "QQQ.US" || benchmark === "QQQ"
    ? verifiedMetric(excessRow?.valuePercent, {
        unit: "percent_point",
        source: "verifiedOutcome.pricePath.excessReturns[QQQ]",
        reason: excessRow?.reason ?? "verified_qqq_excess_unavailable",
      })
    : unavailableMetric("percent_point", benchmark ? "verified_benchmark_is_not_qqq" : "verified_qqq_benchmark_missing");
  const mae = verifiedMetric(path?.maePercent, {
    unit: "percent_point",
    source: "verifiedOutcome.tradePricePath.pricePath.maePercent",
    reason: path?.reason ?? "verified_mae_unavailable",
  });
  const mfe = verifiedMetric(path?.mfePercent, {
    unit: "percent_point",
    source: "verifiedOutcome.tradePricePath.pricePath.mfePercent",
    reason: path?.reason ?? "verified_mfe_unavailable",
  });
  const realizedFillReturn = verifiedMetric(outcome.tradePath?.metrics?.realizedReturnPercent, {
    unit: "percent_point",
    source: "verifiedOutcome.tradePricePath.metrics.realizedReturnPercent",
    reason: "verified_fifo_realized_return_unavailable",
  });
  const reasonCodes = [];
  if (!outcome.verified) reasonCodes.push("host_fifo_outcome_not_verified");
  for (const [name, metric] of Object.entries({ holdingPeriodReturn, qqqExcess, mae, mfe })) {
    if (metric.status !== "available") reasonCodes.push(`${name}_unavailable:${metric.reason}`);
  }
  const availableCount = [holdingPeriodReturn, qqqExcess, mae, mfe, realizedFillReturn]
    .filter((metric) => metric.status === "available").length;
  return {
    status: !outcome.verified || availableCount === 0
      ? "unavailable"
      : availableCount === 5 ? "available" : "partial",
    verifiedByHost: outcome.verified,
    sourceResultHash: outcome.declaredResultHash,
    sourceInputHash: outcome.outcomeInputHash,
    holdingPeriodReturnPercent: holdingPeriodReturn,
    qqqExcessPercent: qqqExcess,
    maePercent: mae,
    mfePercent: mfe,
    realizedFillReturnPercent: realizedFillReturn,
    pathCoverage: compactPathCoverage(path?.coverage),
    reasonCodes: uniqueSorted(reasonCodes),
  };
}

function buildRiskREvidence(cycle, outcome) {
  const entryCutoffAt = optionalIso(outcome?.tradePath?.window?.startAt);
  const entryMs = parseTime(entryCutoffAt);
  const latestExAnte = latestByVersion([
    ...(Array.isArray(cycle?.exAnteVersions) ? cycle.exAnteVersions : []),
    ...(Array.isArray(cycle?.sealedVersions) ? cycle.sealedVersions : []),
  ].filter((version) => {
    const sealedMs = parseTime(version?.sealedAt);
    const knowledgeMs = parseTime(version?.knowledgeCutoffAt ?? version?.sealedAt);
    return Number.isFinite(entryMs)
      && Number.isFinite(sealedMs)
      && Number.isFinite(knowledgeMs)
      && sealedMs < entryMs
      && knowledgeMs <= sealedMs
      && version?.integrityStatus !== "mismatch";
  }));
  const exAnte = latestExAnte?.snapshot?.exAnte ?? latestExAnte?.exAnte ?? latestExAnte?.snapshot ?? null;
  const directRiskRecordedAt = optionalIso(
    cycle?.riskR?.knowledgeCutoffAt
      ?? cycle?.riskR?.recordedAt
      ?? cycle?.riskR?.sealedAt,
  );
  const directRiskIsExAnte = Number.isFinite(entryMs)
    && Number.isFinite(parseTime(directRiskRecordedAt))
    && parseTime(directRiskRecordedAt) < entryMs;
  const planned = firstMetricR([
    [directRiskIsExAnte ? cycle?.riskR?.plannedR : null, "cycle.riskR.plannedR@pre_entry"],
    [exAnte?.plannedRiskR, "cycle.latestExAnte.plannedRiskR"],
    [exAnte?.riskBudgetR, "cycle.latestExAnte.riskBudgetR"],
  ], "planned_r_not_recorded_ex_ante");
  const stress = firstMetricR([
    [directRiskIsExAnte ? cycle?.riskR?.stressR : null, "cycle.riskR.stressR@pre_entry"],
    [exAnte?.stressRiskR, "cycle.latestExAnte.stressRiskR"],
  ], "stress_r_not_recorded_ex_ante");
  const realized = outcome.verified
    ? firstMetricR([
        [outcome.wrapper?.riskR?.realizedR, "verifiedOutcome.riskR.realizedR"],
        [outcome.root?.riskR?.realizedR, "verifiedOutcome.metrics.riskR.realizedR"],
        [outcome.wrapper?.realizedR, "verifiedOutcome.realizedR"],
        [outcome.root?.realizedR, "verifiedOutcome.metrics.realizedR"],
        [outcome.root?.outcome?.netR, "verifiedOutcome.outcome.netR"],
        [outcome.root?.netR, "verifiedOutcome.netR"],
      ], "realized_r_not_verified")
    : unavailableMetric("R", "realized_r_not_verified");
  return {
    planned,
    stress,
    realized,
    comparable: planned.status === "available" && realized.status === "available",
    timing: {
      entryCutoffAt,
      sealedExAnteAt: optionalIso(latestExAnte?.sealedAt),
      directRiskRecordedAt,
      directRiskAcceptedAsExAnte: directRiskIsExAnte,
    },
    limitation: "Planned/stress R is accepted only from a sealed or explicitly timestamped record strictly before the selected Buy. Percent returns, P&L, MAE/MFE and current holdings are never converted into R here.",
  };
}

function bindEvidenceRevision(cycleIdentity, outcome) {
  const reasons = [];
  if (!cycleIdentity.evidenceRevision) reasons.push("cycle_evidence_revision_missing");
  if (!outcome.evidenceRevision) reasons.push("outcome_evidence_revision_unbound");
  if (cycleIdentity.evidenceRevision && outcome.evidenceRevision
    && cycleIdentity.evidenceRevision !== outcome.evidenceRevision) {
    reasons.push("outcome_evidence_revision_mismatch");
  }
  return {
    status: reasons.length ? "unbound" : "bound",
    cycleEvidenceRevision: cycleIdentity.evidenceRevision,
    outcomeEvidenceRevision: outcome.evidenceRevision,
    reasonCodes: uniqueSorted(reasons),
  };
}

function buildEvidenceBinding({ accountScopeId, cycleIdentity, selection, normalizedOutcome }) {
  const binding = {
    accountScopeId: accountScopeId ?? null,
    cycleAccountScopeId: cycleIdentity.accountScopeId ?? null,
    cycleId: cycleIdentity.cycleId,
    cycleEvidenceRevision: cycleIdentity.evidenceRevision,
    symbol: cycleIdentity.symbol,
    entryCutoffAt: cycleIdentity.entryCutoffAt,
    exitAt: cycleIdentity.exitAt,
    radarBatchId: cleanText(selection.batch?.batchId, 160),
    radarBatchRevision: positiveInteger(selection.batch?.revision),
    radarBatchRecordHash: cleanHash(selection.batch?.recordHash),
    radarBatchInputHash: cleanHash(selection.batch?.inputHash),
    radarCardInputHash: cleanHash(selection.item?.inputHash),
    outcomeEvidenceRevision: normalizedOutcome.evidenceRevision,
    outcomeResultHash: normalizedOutcome.declaredResultHash,
    outcomeInputHash: normalizedOutcome.outcomeInputHash,
  };
  return {
    ...binding,
    bindingHash: sha256(stableStringify(binding)),
  };
}

function classifyValidationMode({ entryCutoffAt, validationProtocol, requestedMode }) {
  const frozenAt = optionalIso(
    validationProtocol?.frozenAt
      ?? validationProtocol?.observationStartedAt
      ?? validationProtocol?.registeredAt,
  );
  const entryMs = parseTime(entryCutoffAt);
  const frozenMs = parseTime(frozenAt);
  const classification = Number.isFinite(entryMs) && Number.isFinite(frozenMs) && frozenMs < entryMs
    ? "walk_forward"
    : "historical_calibration";
  const reasons = classification === "walk_forward"
    ? ["protocol_frozen_strictly_before_trade_entry"]
    : [frozenAt ? "protocol_not_frozen_before_trade_entry" : "no_pre_entry_frozen_protocol"];
  const requested = ["walk_forward", "historical_calibration"].includes(String(requestedMode ?? "").toLowerCase())
    ? String(requestedMode).toLowerCase()
    : null;
  if (requested && requested !== classification) reasons.push("requested_mode_does_not_match_temporal_evidence");
  const protocolRef = {
    id: cleanText(validationProtocol?.id, 200),
    revision: positiveInteger(validationProtocol?.revision),
    frozenAt,
    protocolHash: cleanHash(validationProtocol?.protocolHash ?? validationProtocol?.hash),
  };
  return {
    classification,
    requested,
    protocol: protocolRef,
    eligibleForFormalStatisticsByTiming: classification === "walk_forward",
    historicalCalibrationExcludedFromFormalStatistics: classification === "historical_calibration",
    reasonCodes: uniqueSorted(reasons),
  };
}

function buildSampleCandidate({
  scope,
  cycleIdentity,
  selection,
  outcome,
  validationMode,
  revisionBinding,
}) {
  const reasons = [];
  if (!scope) reasons.push("account_scope_missing");
  if (!cycleIdentity.accountScopeId) reasons.push("cycle_account_scope_missing");
  if (scope && cycleIdentity.accountScopeId && scope !== cycleIdentity.accountScopeId) {
    reasons.push("cycle_radar_account_scope_mismatch");
  }
  if (!cycleIdentity.cycleId) reasons.push("cycle_id_missing");
  if (!selection.item) reasons.push("entry_technical_snapshot_unavailable");
  if (outcome.status === "unavailable") reasons.push("verified_outcome_unavailable");
  if (revisionBinding.status !== "bound") reasons.push(...revisionBinding.reasonCodes);
  if (validationMode.classification === "historical_calibration") {
    reasons.push("historical_calibration_discovery_only");
  }
  const available = Boolean(
    scope
      && cycleIdentity.accountScopeId === scope
      && cycleIdentity.cycleId
      && selection.item
      && outcome.status !== "unavailable",
  );
  const eligibleForFormalStatistics = available
    && validationMode.classification === "walk_forward"
    && validationMode.protocol.protocolHash != null
    && selection.coverage.status === "complete"
    && outcome.status === "available"
    && revisionBinding.status === "bound";
  if (available && validationMode.classification === "walk_forward" && !validationMode.protocol.protocolHash) {
    reasons.push("frozen_protocol_hash_missing");
  }
  if (available && !eligibleForFormalStatistics && validationMode.classification === "walk_forward") {
    reasons.push("walk_forward_sample_evidence_incomplete");
  }
  const idBody = {
    accountScopeId: scope,
    cycleAccountScopeId: cycleIdentity.accountScopeId,
    cycleId: cycleIdentity.cycleId,
    cycleEvidenceRevision: cycleIdentity.evidenceRevision,
    batchRecordHash: cleanHash(selection.batch?.recordHash),
    batchRevision: positiveInteger(selection.batch?.revision),
  };
  return {
    status: available ? "available" : "unavailable",
    sampleId: `technical-validation-sample:${sha256(stableStringify(idBody))}`,
    cycleId: cycleIdentity.cycleId,
    radarBatchId: cleanText(selection.batch?.batchId, 160),
    radarBatchRevision: positiveInteger(selection.batch?.revision),
    evidenceClass: validationMode.classification,
    eligibleForFormalStatistics,
    reasonCodes: uniqueSorted(reasons),
  };
}

function buildRuleCandidate({ cycleIdentity, technical, outcome, validationMode, sampleCandidate }) {
  const technicalStateHash = technical.stateHash;
  const ruleKey = technicalStateHash && cycleIdentity.symbol
    ? `technical-state:${sha256(stableStringify({ symbol: cycleIdentity.symbol, technicalStateHash }))}`
    : null;
  const observationAvailable = sampleCandidate.status === "available" && Boolean(ruleKey);
  return {
    status: observationAvailable ? "observation_candidate" : "unavailable",
    ruleKey,
    predicate: technical.state ? {
      symbol: cycleIdentity.symbol,
      observableState: technical.state,
      observableStateHash: technicalStateHash,
    } : null,
    observedOutcome: {
      holdingPeriodReturnPercent: outcome.holdingPeriodReturnPercent,
      qqqExcessPercent: outcome.qqqExcessPercent,
      maePercent: outcome.maePercent,
      mfePercent: outcome.mfePercent,
      realizedR: null,
    },
    evidenceClass: validationMode.classification,
    promotionStatus: "single_observation_not_a_rule",
    automaticPromotion: false,
    formalWinRatePercent: null,
    reasonCodes: uniqueSorted([
      ...(observationAvailable ? [] : ["rule_observation_inputs_incomplete"]),
      "single_cycle_cannot_establish_win_rate_or_formal_rule",
      ...(validationMode.classification === "historical_calibration"
        ? ["historical_calibration_excluded_from_formal_statistics"]
        : []),
    ]),
  };
}

function dedupeSamples(values) {
  const groups = new Map();
  for (const sample of Array.isArray(values) ? values : []) {
    const id = cleanText(sample?.sampleCandidate?.sampleId, 200);
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(sample);
  }
  const bySampleId = [];
  const reasonCodes = [];
  for (const [id, entries] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const hashes = uniqueSorted(entries.map((item) => cleanHash(item?.resultHash)).filter(Boolean));
    if (hashes.length > 1) {
      reasonCodes.push(`conflicting_duplicate_sample:${id}`);
      continue;
    }
    bySampleId.push(entries.slice().sort((left, right) => (
      String(left?.resultHash ?? "").localeCompare(String(right?.resultHash ?? ""))
    ))[0]);
  }
  const cycleGroups = new Map();
  for (const sample of bySampleId) {
    const cycleId = cleanText(
      sample?.sampleCandidate?.cycleId ?? sample?.evidenceBinding?.cycleId,
      240,
    ) ?? sample.sampleCandidate.sampleId;
    if (!cycleGroups.has(cycleId)) cycleGroups.set(cycleId, []);
    cycleGroups.get(cycleId).push(sample);
  }
  const samples = [];
  for (const [cycleId, entries] of [...cycleGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (entries.length > 1) {
      reasonCodes.push(`multiple_unresolved_revisions_for_cycle:${cycleId}`);
      continue;
    }
    samples.push(entries[0]);
  }
  return { samples, reasonCodes };
}

function normalizeCriterion(value) {
  const metric = String(value?.metric ?? "").trim();
  const allowedMetrics = new Set([
    "holdingPeriodReturnPercent",
    "qqqExcessPercent",
    "maePercent",
    "mfePercent",
    "realizedR",
  ]);
  const aliases = new Map([[">", "gt"], [">=", "gte"], ["<", "lt"], ["<=", "lte"], ["=", "eq"], ["==", "eq"]]);
  const rawOperator = String(value?.operator ?? "").trim().toLowerCase();
  const operator = aliases.get(rawOperator) ?? rawOperator;
  const threshold = finiteOrNull(value?.threshold);
  if (!allowedMetrics.has(metric)) {
    return { status: "unavailable", metric: null, operator: null, threshold: null, reason: "criterion_metric_invalid" };
  }
  if (!["gt", "gte", "lt", "lte", "eq"].includes(operator)) {
    return { status: "unavailable", metric, operator: null, threshold, reason: "criterion_operator_invalid" };
  }
  if (threshold == null) {
    return { status: "unavailable", metric, operator, threshold: null, reason: "criterion_threshold_missing" };
  }
  return { status: "available", metric, operator, threshold, reason: null };
}

function evaluateSample(sample, criterion) {
  const metricNode = criterion.status === "available"
    ? criterionMetricNode(sample, criterion.metric)
    : null;
  const value = metricNode?.status === "available" ? finiteOrNull(metricNode.value) : null;
  return {
    sampleId: sample.sampleCandidate.sampleId,
    mode: sample.validationMode?.classification ?? sample.sampleCandidate?.evidenceClass ?? "historical_calibration",
    formalEligible: sample.sampleCandidate?.eligibleForFormalStatistics === true,
    value,
    outcome: value == null || criterion.status !== "available"
      ? "unavailable"
      : compareCriterion(value, criterion.operator, criterion.threshold) ? "hit" : "miss",
  };
}

function criterionMetricNode(sample, metric) {
  if (metric === "realizedR") return sample?.riskR?.realized;
  return sample?.outcome?.[metric];
}

function compareCriterion(value, operator, threshold) {
  if (operator === "gt") return value > threshold;
  if (operator === "gte") return value >= threshold;
  if (operator === "lt") return value < threshold;
  if (operator === "lte") return value <= threshold;
  return value === threshold;
}

function summarizeEvaluations(values) {
  const available = values.filter((item) => item.outcome !== "unavailable");
  const hits = available.filter((item) => item.outcome === "hit").length;
  return {
    candidateCount: values.length,
    evaluatedCount: available.length,
    unavailableCount: values.length - available.length,
    hitCount: hits,
    missCount: available.length - hits,
    hitRatePercent: available.length ? round((hits / available.length) * 100) : null,
    sampleIds: values.map((item) => item.sampleId).sort(),
  };
}

function publicBatchReference(batch) {
  if (!batch) return null;
  return {
    batchId: cleanText(batch.batchId, 160),
    revision: positiveInteger(batch.revision),
    tradingDate: /^\d{4}-\d{2}-\d{2}$/.test(String(batch.tradingDate ?? "")) ? String(batch.tradingDate) : null,
    computedAt: optionalIso(batch.computedAt),
    recordedAt: optionalIso(batch.recordedAt),
    inputHash: cleanHash(batch.inputHash),
    recordHash: cleanHash(batch.recordHash),
    scannerVersion: cleanText(batch.scannerVersion, 120),
  };
}

function normalizeObservableState(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(OBSERVABLE_STATE_FIELDS.map((field) => [
    field,
    normalizeStateValue(source[field]),
  ]));
}

function normalizeStateValue(value) {
  if (value == null || value === "") return "N/A";
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  return "N/A";
}

function compactValueNode(value) {
  const number = finiteOrNull(value?.value);
  if (value?.status === "available" && number != null) {
    return {
      status: "available",
      value: number,
      display: null,
      unit: cleanText(value?.unit, 80),
      reason: null,
    };
  }
  return unavailableMetric(cleanText(value?.unit, 80), cleanText(value?.reason, 240) ?? "value_unavailable");
}

function compactEmaNode(value) {
  return {
    ...compactValueNode(value),
    slope5SessionsPercent: finiteOrNull(value?.slope5SessionsPercent),
    maturity: cleanText(value?.maturity, 80),
    requiredBarCount: finiteOrNull(value?.requiredBarCount),
    barCount: finiteOrNull(value?.barCount),
  };
}

function compactCostNode(value) {
  if (!value || typeof value !== "object") return null;
  return stableJson({
    status: value.status ?? null,
    methodVersion: value.methodVersion ?? null,
    inputHash: cleanHash(value.inputHash),
    profile14: value.profile14 ?? null,
    profile28: value.profile28 ?? null,
    comparison: value.comparison ?? null,
    confidence: value.confidence ?? null,
  });
}

function compactComparison(value) {
  if (!value || typeof value !== "object") return null;
  return {
    status: cleanText(value.status, 80),
    kind: cleanText(value.kind, 80),
    changedFields: (Array.isArray(value.changedFields) ? value.changedFields : []).slice(0, 100).map((item) => ({
      field: cleanText(item?.field, 120),
      from: normalizeStateValue(item?.from),
      to: normalizeStateValue(item?.to),
    })).filter((item) => item.field),
  };
}

function compactPathCoverage(value) {
  if (!value || typeof value !== "object") return null;
  return stableJson({
    status: value.status ?? null,
    eligibleBarCount: finiteOrNull(value.eligibleBarCount),
    fullSessionExcursionBarCount: finiteOrNull(value.fullSessionExcursionBarCount),
    candleAdjustType: value.candleAdjustType ?? null,
    executionPriceBasis: value.executionPriceBasis ?? null,
    basisMismatch: value.basisMismatch === true,
    reasons: uniqueSorted(Array.isArray(value.reasons) ? value.reasons : []),
    limitations: uniqueSorted(Array.isArray(value.limitations) ? value.limitations : []),
  });
}

function metricReference(value, { unit, source, reason }) {
  const number = finiteOrNull(value);
  return number == null ? unavailableMetric(unit, reason) : {
    status: "available",
    value: number,
    display: null,
    unit,
    reason: null,
    source,
    hostVerifiedReference: true,
  };
}

function unavailableMetric(unit, reason) {
  return {
    status: "unavailable",
    value: null,
    display: "N/A",
    unit: unit ?? null,
    reason: reason ?? "unavailable",
  };
}

function firstMetricR(candidates, unavailableReason) {
  for (const [value, source] of candidates) {
    const number = finiteOrNull(value);
    if (number != null) {
      return { status: "available", value: number, display: null, unit: "R", reason: null, source };
    }
  }
  return unavailableMetric("R", unavailableReason);
}

function latestByVersion(values) {
  return (Array.isArray(values) ? values : []).filter((item) => item && typeof item === "object")
    .slice()
    .sort((left, right) => (
      Number(left?.version ?? 0) - Number(right?.version ?? 0)
      || parseTime(left?.sealedAt) - parseTime(right?.sealedAt)
    )).at(-1) ?? null;
}

function unavailableTransition(reason) {
  return { status: "unavailable", reason, kind: "N/A", fromBatch: null, toBatch: null, changedFields: [] };
}

function compareRadarBatches(left, right) {
  return parseTime(left?.computedAt) - parseTime(right?.computedAt)
    || parseTime(left?.recordedAt) - parseTime(right?.recordedAt)
    || Number(left?.revision ?? 0) - Number(right?.revision ?? 0)
    || String(left?.recordHash ?? "").localeCompare(String(right?.recordHash ?? ""))
    || String(left?.batchId ?? "").localeCompare(String(right?.batchId ?? ""));
}

function compareBinding(reasons, stored, current, field, code) {
  if (stableStringify(stored?.[field] ?? null) !== stableStringify(current?.[field] ?? null)) reasons.push(code);
}

function stableJson(value) {
  if (value == null) return null;
  try {
    return canonicalize(structuredClone(value));
  } catch {
    return null;
  }
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") return null;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function cleanHash(value) {
  const text = String(value ?? "").trim().toLowerCase().replace(/^sha256:/, "");
  return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function normalizeSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9._:-]{1,40}$/.test(symbol) ? symbol : null;
}

function optionalIso(value) {
  const time = parseTime(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function parseTime(value) {
  if (value == null || value === "") return Number.NaN;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? time : Number.NaN;
}

function finiteOrNull(value) {
  if (value == null || typeof value === "boolean") return null;
  if (typeof value === "string" && !value.trim()) return null;
  if (!["number", "string"].includes(typeof value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value) {
  const number = finiteOrNull(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function cleanText(value, maxLength) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maxLength) : null;
}

function uniqueSorted(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
