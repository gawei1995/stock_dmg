import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_FORMAL_FORWARD_SAMPLES,
  assessReviewTechnicalValidationStaleness,
  buildReviewTechnicalValidationSample,
  evaluateReviewTechnicalRuleEvidence,
} from "../src/review/review-technical-validation.mjs";

const SCOPE = "lb-account:primary";
const ENTRY_AT = "2026-08-04T14:30:00.000Z";
const EXIT_AT = "2026-08-08T19:30:00.000Z";

test("joins the last strictly pre-entry account radar batch to verified host outcome without future leakage", () => {
  const prior = radarBatch({
    batchId: "radar-prior",
    tradingDate: "2026-08-01",
    computedAt: "2026-08-01T21:05:00.000Z",
    recordedAt: "2026-08-01T21:06:00.000Z",
    recordHash: hash("prior"),
    state: { priceVsEma21: "below", shortStructure: "bearish" },
  });
  const entry = radarBatch({
    batchId: "radar-entry",
    tradingDate: "2026-08-03",
    computedAt: "2026-08-03T21:05:00.000Z",
    recordedAt: "2026-08-03T21:06:00.000Z",
    recordHash: hash("entry"),
    state: { priceVsEma21: "above", shortStructure: "bullish" },
  });
  const future = radarBatch({
    batchId: "radar-future",
    tradingDate: "2026-08-04",
    computedAt: "2026-08-04T14:31:00.000Z",
    recordedAt: "2026-08-04T14:32:00.000Z",
    recordHash: hash("future"),
    state: { priceVsEma21: "below" },
  });
  const result = buildReviewTechnicalValidationSample({
    accountScopeId: SCOPE,
    radarBatches: [future, entry, prior, radarBatch({ accountScopeId: "lb-account:other", batchId: "other" })],
    cycle: tradeCycle(),
    verifiedOutcome: hostOutcome(),
    validationProtocol: protocol(),
    requestedMode: "walk_forward",
  });

  assert.equal(result.status, "complete");
  assert.equal(result.entrySnapshot.batch.batchId, "radar-entry");
  assert.equal(result.entrySnapshot.coverage.atOrAfterCutoffBatchCount, 1);
  assert.equal(result.entrySnapshot.coverage.otherScopeBatchCount, 1);
  assert.equal(result.entrySnapshot.coverage.computedBeforeCutoff, true);
  assert.equal(result.entrySnapshot.coverage.recordedBeforeCutoff, true);
  assert.equal(result.entrySnapshot.technical.state.priceVsEma21, "above");
  assert.deepEqual(
    result.entrySnapshot.technical.transition.changedFields.find((item) => item.field === "priceVsEma21"),
    { field: "priceVsEma21", from: "below", to: "above" },
  );
  assert.equal(result.outcome.holdingPeriodReturnPercent.value, 4.5);
  assert.equal(result.outcome.qqqExcessPercent.value, 2.25);
  assert.equal(result.outcome.maePercent.value, -3.25);
  assert.equal(result.outcome.maePercent.hostVerifiedReference, true);
  assert.equal(result.outcome.mfePercent.value, 8.75);
  assert.equal(result.outcome.mfePercent.hostVerifiedReference, true);
  assert.equal(result.riskR.planned.value, 1);
  assert.equal(result.riskR.stress.value, 1.8);
  assert.equal(result.riskR.realized.value, 0.7);
  assert.equal(result.validationMode.classification, "walk_forward");
  assert.equal(result.sampleCandidate.eligibleForFormalStatistics, true);
  assert.equal(result.ruleCandidate.promotionStatus, "single_observation_not_a_rule");
  assert.equal(result.ruleCandidate.formalWinRatePercent, null);
  assert.match(result.resultHash, /^[a-f0-9]{64}$/);
});

test("excludes a batch recorded at or after entry even when it claims an earlier computation", () => {
  const valid = radarBatch({ batchId: "valid", recordHash: hash("valid") });
  const lateRecorded = radarBatch({
    batchId: "late-recorded",
    tradingDate: "2026-08-04",
    computedAt: "2026-08-04T14:00:00.000Z",
    recordedAt: "2026-08-04T14:31:00.000Z",
    recordHash: hash("late"),
    state: { priceVsEma21: "future-state" },
  });
  const atCutoff = radarBatch({
    batchId: "at-cutoff",
    tradingDate: "2026-08-04",
    computedAt: ENTRY_AT,
    recordedAt: ENTRY_AT,
    recordHash: hash("same-time"),
  });
  const result = buildReviewTechnicalValidationSample({
    accountScopeId: SCOPE,
    radarBatches: [lateRecorded, atCutoff, valid],
    cycle: tradeCycle(),
    verifiedOutcome: hostOutcome(),
  });

  assert.equal(result.entrySnapshot.batch.batchId, "valid");
  assert.equal(result.entrySnapshot.coverage.recordedAfterCutoffBatchCount, 1);
  assert.equal(result.entrySnapshot.coverage.atOrAfterCutoffBatchCount, 1);
  assert.ok(result.reasonCodes.includes("late_recorded_radar_batches_excluded"));
  assert.equal(result.validationMode.classification, "historical_calibration");
  assert.equal(result.sampleCandidate.eligibleForFormalStatistics, false);
});

test("does not reach back to an older symbol card when the latest eligible account batch omitted it", () => {
  const olderWithSymbol = radarBatch({
    batchId: "older-with-aapl",
    tradingDate: "2026-08-01",
    computedAt: "2026-08-01T21:00:00.000Z",
    recordedAt: "2026-08-01T21:01:00.000Z",
    recordHash: hash("older"),
  });
  const latestWithoutSymbol = radarBatch({
    batchId: "latest-without-aapl",
    tradingDate: "2026-08-03",
    computedAt: "2026-08-03T21:00:00.000Z",
    recordedAt: "2026-08-03T21:01:00.000Z",
    recordHash: hash("latest"),
    items: [technicalCard("MSFT.US")],
  });
  const result = buildReviewTechnicalValidationSample({
    accountScopeId: SCOPE,
    radarBatches: [olderWithSymbol, latestWithoutSymbol],
    cycle: tradeCycle(),
    verifiedOutcome: hostOutcome(),
  });

  assert.equal(result.entrySnapshot.batch.batchId, "latest-without-aapl");
  assert.equal(result.entrySnapshot.coverage.status, "unavailable");
  assert.equal(result.entrySnapshot.technical.status, "unavailable");
  assert.ok(result.reasonCodes.includes("symbol_missing_from_latest_pre_entry_batch"));
  assert.equal(result.sampleCandidate.status, "unavailable");
});

test("keeps observed zero separate from missing outcome and R values", () => {
  const zero = buildReviewTechnicalValidationSample({
    accountScopeId: SCOPE,
    radarBatches: [radarBatch()],
    cycle: tradeCycle({ riskR: { plannedR: 0, stressR: 0 } }),
    verifiedOutcome: hostOutcome({
      holdingReturn: 0,
      qqqExcess: 0,
      mae: 0,
      mfe: 0,
      realizedFillReturn: 0,
      realizedR: 0,
    }),
    validationProtocol: protocol(),
  });
  for (const metric of [
    zero.outcome.holdingPeriodReturnPercent,
    zero.outcome.qqqExcessPercent,
    zero.outcome.maePercent,
    zero.outcome.mfePercent,
    zero.outcome.realizedFillReturnPercent,
    zero.riskR.planned,
    zero.riskR.stress,
    zero.riskR.realized,
  ]) {
    assert.equal(metric.status, "available");
    assert.equal(metric.value, 0);
    assert.equal(metric.display, null);
  }

  const missing = buildReviewTechnicalValidationSample({
    accountScopeId: SCOPE,
    radarBatches: [],
    cycle: { ...tradeCycle(), currentPortfolio: { positions: [{ symbol: "AAPL.US", marketValue: 1_000_000 }] } },
    verifiedOutcome: {},
  });
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.entrySnapshot.batch, null);
  assert.equal(missing.outcome.holdingPeriodReturnPercent.value, null);
  assert.equal(missing.outcome.holdingPeriodReturnPercent.display, "N/A");
  assert.equal(missing.riskR.realized.value, null);
  assert.equal(missing.provenance.currentHoldingInferenceAllowed, false);

  const unverifiedNumbers = hostOutcome();
  delete unverifiedNumbers.provenance;
  delete unverifiedNumbers.executionPnl;
  unverifiedNumbers.tradePricePath.coverage.selectedOnly = false;
  const rejected = buildReviewTechnicalValidationSample({
    accountScopeId: SCOPE,
    radarBatches: [radarBatch()],
    cycle: tradeCycle(),
    verifiedOutcome: unverifiedNumbers,
  });
  assert.equal(rejected.outcome.verifiedByHost, false);
  assert.equal(rejected.outcome.holdingPeriodReturnPercent.value, null);
  assert.equal(rejected.outcome.maePercent.hostVerifiedReference, undefined);
  assert.equal(rejected.riskR.realized.value, null);
});

test("rejects post-entry planned R and any cycle/radar account-scope mismatch", () => {
  const postEntryRisk = buildReviewTechnicalValidationSample({
    accountScopeId: SCOPE,
    radarBatches: [radarBatch()],
    cycle: tradeCycle({ riskR: { plannedR: 1, stressR: 2, recordedAt: "2026-08-04T15:00:00.000Z" } }),
    verifiedOutcome: hostOutcome(),
  });
  assert.equal(postEntryRisk.riskR.planned.status, "unavailable");
  assert.equal(postEntryRisk.riskR.stress.status, "unavailable");
  assert.equal(postEntryRisk.riskR.timing.directRiskAcceptedAsExAnte, false);

  const wrongScope = buildReviewTechnicalValidationSample({
    accountScopeId: SCOPE,
    radarBatches: [radarBatch()],
    cycle: tradeCycle({ brokerLinks: { accountScopeId: "lb-account:other" } }),
    verifiedOutcome: hostOutcome(),
  });
  assert.equal(wrongScope.sampleCandidate.status, "unavailable");
  assert.ok(wrongScope.sampleCandidate.reasonCodes.includes("cycle_radar_account_scope_mismatch"));
  assert.equal(wrongScope.evidenceBinding.cycleAccountScopeId, "lb-account:other");
});

test("is idempotent across input order and marks cycle, radar or outcome revisions stale", () => {
  const batches = [
    radarBatch({ batchId: "prior", tradingDate: "2026-08-01", computedAt: "2026-08-01T21:00:00Z", recordedAt: "2026-08-01T21:01:00Z", recordHash: hash("prior") }),
    radarBatch({ batchId: "entry", recordHash: hash("entry") }),
  ];
  const args = {
    accountScopeId: SCOPE,
    radarBatches: batches,
    cycle: tradeCycle(),
    verifiedOutcome: hostOutcome(),
    validationProtocol: protocol(),
  };
  const first = buildReviewTechnicalValidationSample(args);
  const repeated = buildReviewTechnicalValidationSample({ ...args, radarBatches: [...batches].reverse() });
  assert.deepEqual(repeated, first);
  assert.equal(repeated.sampleCandidate.sampleId, first.sampleCandidate.sampleId);

  const cycleChanged = assessReviewTechnicalValidationStaleness({
    result: first,
    ...args,
    cycle: tradeCycle({ evidenceRevision: 2, brokerLinks: { evidenceRevision: 2 } }),
    verifiedOutcome: hostOutcome({ evidenceRevision: 2 }),
  });
  assert.equal(cycleChanged.status, "stale");
  assert.ok(cycleChanged.reasonCodes.includes("cycle_evidence_revision_changed"));

  const correctedBatch = radarBatch({
    batchId: "entry-revision-2",
    revision: 2,
    computedAt: "2026-08-03T22:00:00.000Z",
    recordedAt: "2026-08-03T22:01:00.000Z",
    recordHash: hash("entry-v2"),
  });
  const radarChanged = assessReviewTechnicalValidationStaleness({
    result: first,
    ...args,
    radarBatches: [...batches, correctedBatch],
  });
  assert.equal(radarChanged.status, "stale");
  assert.ok(radarChanged.reasonCodes.includes("entry_radar_revision_changed"));
  assert.ok(radarChanged.reasonCodes.includes("entry_radar_record_hash_changed"));

  const outcomeChanged = assessReviewTechnicalValidationStaleness({
    result: first,
    ...args,
    verifiedOutcome: hostOutcome({ holdingReturn: 7 }),
  });
  assert.equal(outcomeChanged.status, "stale");
  assert.ok(outcomeChanged.reasonCodes.includes("verified_outcome_changed"));

  const current = assessReviewTechnicalValidationStaleness({ result: first, ...args });
  assert.deepEqual(current.reasonCodes, []);
  assert.equal(current.status, "current");
});

test("requires a pre-entry frozen, hashed protocol and complete revision binding for formal walk-forward use", () => {
  const base = {
    accountScopeId: SCOPE,
    radarBatches: [radarBatch()],
    cycle: tradeCycle(),
    verifiedOutcome: hostOutcome(),
  };
  const afterEntry = buildReviewTechnicalValidationSample({
    ...base,
    requestedMode: "walk_forward",
    validationProtocol: protocol({ frozenAt: "2026-08-04T15:00:00.000Z" }),
  });
  assert.equal(afterEntry.validationMode.classification, "historical_calibration");
  assert.equal(afterEntry.sampleCandidate.eligibleForFormalStatistics, false);
  assert.ok(afterEntry.validationMode.reasonCodes.includes("requested_mode_does_not_match_temporal_evidence"));

  const noHash = buildReviewTechnicalValidationSample({
    ...base,
    validationProtocol: protocol({ protocolHash: null }),
  });
  assert.equal(noHash.validationMode.classification, "walk_forward");
  assert.equal(noHash.sampleCandidate.eligibleForFormalStatistics, false);
  assert.ok(noHash.sampleCandidate.reasonCodes.includes("frozen_protocol_hash_missing"));

  const unbound = buildReviewTechnicalValidationSample({
    ...base,
    validationProtocol: protocol(),
    verifiedOutcome: hostOutcome({ evidenceRevision: null }),
  });
  assert.equal(unbound.revisionBinding.status, "unbound");
  assert.equal(unbound.sampleCandidate.eligibleForFormalStatistics, false);
  assert.ok(unbound.revisionBinding.reasonCodes.includes("outcome_evidence_revision_unbound"));
});

test("keeps historical calibration separate and never promotes a small-sample hit rate as a rule", () => {
  const ruleKey = "technical-state:rule-one";
  const samples = [
    syntheticSample({ id: "wf-1", ruleKey, mode: "walk_forward", value: 2, formalEligible: true }),
    syntheticSample({ id: "wf-2", ruleKey, mode: "walk_forward", value: 1, formalEligible: true }),
    syntheticSample({ id: "hist-1", ruleKey, mode: "historical_calibration", value: 5 }),
  ];
  const result = evaluateReviewTechnicalRuleEvidence({
    ruleKey,
    samples: [...samples, structuredClone(samples[0])],
    criterion: { metric: "holdingPeriodReturnPercent", operator: ">", threshold: 0 },
    minimumForwardSamples: 1,
  });

  assert.equal(result.minimumForwardSamples, MIN_FORMAL_FORWARD_SAMPLES);
  assert.equal(result.uniqueSampleCount, 3);
  assert.equal(result.walkForward.evaluatedCount, 2);
  assert.equal(result.walkForward.hitRatePercent, 100);
  assert.equal(result.walkForward.descriptiveOnly, true);
  assert.equal(result.historicalCalibration.evaluatedCount, 1);
  assert.equal(result.historicalCalibration.includedInFormalStatistics, false);
  assert.equal(result.promotion.status, "insufficient_forward_evidence");
  assert.equal(result.promotion.automaticPromotion, false);
  assert.equal(result.promotion.formalRuleCreated, false);
  assert.ok(result.promotion.reasonCodes.includes("insufficient_independent_walk_forward_samples"));
});

test("twenty eligible forward samples reach only a human review gate, never automatic rule creation", () => {
  const ruleKey = "technical-state:rule-twenty";
  const samples = Array.from({ length: MIN_FORMAL_FORWARD_SAMPLES }, (_, index) => syntheticSample({
    id: `wf-${index + 1}`,
    ruleKey,
    mode: "walk_forward",
    value: index % 4 === 0 ? -1 : 2,
    formalEligible: true,
  }));
  const result = evaluateReviewTechnicalRuleEvidence({
    ruleKey,
    samples,
    criterion: { metric: "holdingPeriodReturnPercent", operator: "gt", threshold: 0 },
  });

  assert.equal(result.walkForward.evaluatedCount, MIN_FORMAL_FORWARD_SAMPLES);
  assert.equal(result.walkForward.hitCount, 15);
  assert.equal(result.walkForward.hitRatePercent, 75);
  assert.equal(result.walkForward.descriptiveOnly, false);
  assert.equal(result.promotion.status, "ready_for_human_review");
  assert.equal(result.promotion.humanReviewRequired, true);
  assert.equal(result.promotion.automaticPromotion, false);
  assert.equal(result.promotion.formalRuleCreated, false);
});

function tradeCycle(overrides = {}) {
  const base = {
    id: "cycle-aapl-1",
    cycleType: "trade_window",
    symbol: "AAPL.US",
    symbols: ["AAPL.US"],
    evidenceRevision: 1,
    brokerLinks: { evidenceRevision: 1, accountScopeId: SCOPE },
    riskR: { plannedR: 1, stressR: 1.8, recordedAt: "2026-08-03T20:00:00.000Z" },
  };
  return {
    ...base,
    ...overrides,
    brokerLinks: { ...base.brokerLinks, ...(overrides.brokerLinks ?? {}) },
    riskR: { ...base.riskR, ...(overrides.riskR ?? {}) },
  };
}

function radarBatch(overrides = {}) {
  const item = technicalCard("AAPL.US", overrides.state);
  return {
    accountScopeId: SCOPE,
    batchId: "radar-entry",
    revision: 1,
    tradingDate: "2026-08-03",
    computedAt: "2026-08-03T21:05:00.000Z",
    recordedAt: "2026-08-03T21:06:00.000Z",
    inputHash: hash("radar-input"),
    recordHash: hash("radar-record"),
    scannerVersion: "tier-a-technical-scan/v1",
    items: [item],
    ...without(overrides, ["state"]),
  };
}

function technicalCard(symbol, state = {}) {
  return {
    symbol,
    status: "complete",
    inputHash: hash(`card:${symbol}`),
    lastClose: available(200, "price"),
    ema: Object.fromEntries([3, 5, 8, 13, 21, 144, 169].map((period) => [String(period), {
      ...available(200 - period / 10, "price"),
      slope5SessionsPercent: period < 21 ? 1 : 0,
      maturity: "mature",
      requiredBarCount: period,
      barCount: 520,
    }])),
    metrics: {
      qqqExcessReturns: {
        "5": available(0, "percent_point"),
        "20": available(2, "percent_point"),
      },
    },
    costProfile14d28d: {
      status: "complete",
      inputHash: hash(`cost:${symbol}`),
      profile14: { currentPriceLocation: "above_value", acceptance: "accepted" },
      profile28: { currentPriceLocation: "inside_value", acceptance: "accepted" },
      comparison: { migrationState: "rising" },
    },
    observableState: {
      coverageStatus: "complete",
      technicalStatus: "complete",
      dailySequenceStatus: "advancing",
      shortStructure: "mixed",
      longStructure: "bullish",
      priceVsEma21: "above",
      weeklyDirection: "up",
      weeklySwing: "higher_high",
      costMigration: "rising",
      cost14Location: "above_value",
      cost14Acceptance: "accepted",
      cost28Location: "inside_value",
      cost28Acceptance: "accepted",
      qqqExcess5State: "flat",
      qqqExcess20State: "positive",
      sectorExcess20State: "positive",
      marketEvidenceState: "available",
      ...state,
    },
    comparison: { status: "available", kind: "state_changed", changedFields: [] },
  };
}

function hostOutcome({
  evidenceRevision = 1,
  holdingReturn = 4.5,
  qqqExcess = 2.25,
  mae = -3.25,
  mfe = 8.75,
  realizedFillReturn = 3.5,
  realizedR = 0.7,
} = {}) {
  return {
    evidenceRevision,
    provenance: { deterministicHostCalculation: true },
    executionPnl: { coverage: { selectionScope: "explicit_user_selected_buy_sell_activities" } },
    tradePricePath: {
      status: "available",
      symbol: "AAPL.US",
      window: { startAt: ENTRY_AT, endAt: EXIT_AT },
      coverage: { selectedOnly: true },
      metrics: { realizedReturnPercent: realizedFillReturn },
      pricePath: {
        status: "available",
        periodReturnPercent: holdingReturn,
        maePercent: mae,
        mfePercent: mfe,
        coverage: {
          status: "available",
          eligibleBarCount: 4,
          fullSessionExcursionBarCount: 3,
          candleAdjustType: "forward",
          executionPriceBasis: "raw_fill",
          basisMismatch: true,
          reasons: [],
          limitations: ["verified host path"],
        },
      },
    },
    pricePath: {
      benchmark: "QQQ.US",
      excessReturns: [{ symbol: "AAPL.US", valuePercent: qqqExcess, reason: null }],
    },
    riskR: { realizedR },
  };
}

function protocol(overrides = {}) {
  return {
    id: "protocol-1",
    revision: 1,
    frozenAt: "2026-08-01T00:00:00.000Z",
    protocolHash: hash("protocol"),
    ...overrides,
  };
}

function syntheticSample({ id, ruleKey, mode, value, formalEligible = false }) {
  return {
    sourceStatus: "current",
    resultHash: hash(`result:${id}`),
    sampleCandidate: {
      sampleId: id,
      status: "available",
      eligibleForFormalStatistics: formalEligible,
      evidenceClass: mode,
    },
    ruleCandidate: { ruleKey },
    validationMode: { classification: mode },
    outcome: { holdingPeriodReturnPercent: available(value, "percent_point") },
  };
}

function available(value, unit) {
  return { status: "available", value, display: null, unit, reason: null };
}

function hash(value) {
  return Buffer.from(String(value)).toString("hex").padEnd(64, "0").slice(0, 64);
}

function without(value, keys) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
