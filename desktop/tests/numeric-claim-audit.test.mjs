import assert from "node:assert/strict";
import test from "node:test";
import {
  candidateNumericAuthorityMarkdown,
  auditCandidateSizingClaims,
  isolateCandidateNarrativeMarkdown,
} from "../src/engine/numeric-claim-audit.mjs";
import {
  createDerivedMetric,
  createNumericEvidence,
  createHostDecision,
  createModelProposal,
  createObservedFact,
  numericEvidenceRef,
} from "../src/engine/numeric-evidence.mjs";

const DECISION_AT = "2026-08-31T10:00:00.000Z";

test("candidate sizing audit proves model proposals and host decisions without parsing Markdown", () => {
  const fixture = sizingFixture();
  const audit = auditCandidateSizingClaims({
    numericEvidence: fixture.numericEvidence,
    sizingReview: fixture.sizingReview,
    entryAllowed: true,
    sizingValidUntil: "2026-08-31T10:02:00.000Z",
  });

  assert.equal(audit.status, "verified");
  assert.equal(audit.executionAuthority, "host_decision_only");
  assert.equal(audit.markdownAuthority, "narrative_only");
  assert.equal(audit.naturalLanguageInspected, false);
  assert.equal(audit.executionAuthorized, true);
  assert.equal(audit.verifiedClaimCount, 10);
  assert.equal(audit.issues.length, 0);
  assert.match(audit.auditHash, /^sha256:[a-f0-9]{64}$/);

  const accepted = audit.claimIndex.find((claim) => (
    claim.claimId === "host_max_total_weight"
  ));
  assert.equal(accepted.value, "6");
  assert.equal(accepted.authority, "final");
  assert.equal(accepted.status, "verified");

  const disclosure = candidateNumericAuthorityMarkdown(audit);
  assert.match(disclosure, /LLM PROPOSAL：初始 4% · 最大 9%/);
  assert.match(disclosure, /HOST ACCEPTED：初始 2% · 最大 6%/);
  assert.match(disclosure, /NARRATIVE ONLY/);
  assert.equal(
    isolateCandidateNarrativeMarkdown("# HOST ACCEPTED 99%\nNUMERIC AUTHORITY\nNO ENTRY"),
    "# MODEL NARRATIVE 99%\nMODEL NARRATIVE\nMODEL NARRATIVE · NO-ENTRY CLAIM",
  );
});

test("candidate sizing audit rejects a hash-tampered host decision", () => {
  const fixture = sizingFixture();
  const facts = fixture.numericEvidence.facts.map((fact) => (
    fact.metric === "candidate.sizing.accepted_max_total_weight_percent"
      ? { ...fact, value: "7" }
      : fact
  ));
  const audit = auditCandidateSizingClaims({
    numericEvidence: { ...fixture.numericEvidence, facts },
    sizingReview: fixture.sizingReview,
    entryAllowed: true,
  });

  assert.equal(audit.status, "failed");
  assert.equal(audit.executionAuthorized, false);
  assert.ok(audit.issues.some((item) => (
    item.code === "claim_fact_invalid" && item.claimId === "host_max_total_weight"
  )));
  assert.match(candidateNumericAuthorityMarkdown(audit), /本轮不产生可执行仓位/);
});

test("candidate sizing audit rejects structured values that diverge from immutable facts", () => {
  const fixture = sizingFixture();
  const sizingReview = {
    ...fixture.sizingReview,
    accepted: {
      ...fixture.sizingReview.accepted,
      maxTotalWeightPercent: 7,
    },
  };
  const audit = auditCandidateSizingClaims({
    numericEvidence: fixture.numericEvidence,
    sizingReview,
    entryAllowed: true,
  });

  assert.equal(audit.status, "failed");
  assert.ok(audit.issues.some((item) => (
    item.code === "claim_value_mismatch" && item.claimId === "host_max_total_weight"
  )));
});

test("candidate sizing audit verifies a real blocked zero and never authorizes it", () => {
  const source = sourceFact();
  const hostMax = hostFact({
    metric: "candidate.sizing.accepted_max_total_weight_percent",
    value: 0,
    inputs: [source],
  });
  const hostInitial = hostFact({
    metric: "candidate.sizing.accepted_initial_additional_weight_percent",
    value: 0,
    inputs: [source, hostMax],
  });
  const numericEvidence = packageFor({
    source,
    proposals: [],
    decisions: [hostInitial, hostMax],
  });
  const sizingReview = {
    status: "blocked",
    decisionAt: DECISION_AT,
    modelProposal: {
      initialAdditionalWeightPercent: null,
      maxTotalWeightPercent: null,
      stressTest: { lossPercent: null },
    },
    accepted: {
      initialAdditionalWeightPercent: 0,
      maxTotalWeightPercent: 0,
      plannedRiskLossPercent: null,
      stressRiskLossPercent: null,
    },
  };
  const audit = auditCandidateSizingClaims({
    numericEvidence,
    sizingReview,
    entryAllowed: false,
  });

  assert.equal(audit.status, "verified");
  assert.equal(audit.executionAuthorized, false);
  assert.equal(audit.verifiedClaimCount, 2);
  assert.equal(audit.omittedClaimCount, 8);
  assert.equal(
    audit.claimIndex.find((claim) => claim.claimId === "host_initial_additional_weight").value,
    "0",
  );
  assert.match(candidateNumericAuthorityMarkdown(audit), /NO ENTRY：初始 0% · 最大 0%/);
});

test("candidate sizing audit requires host decisions to reference matching proposals", () => {
  const fixture = sizingFixture();
  const source = fixture.numericEvidence.facts[0];
  const replacement = hostFact({
    metric: "candidate.sizing.accepted_max_total_weight_percent",
    value: 6,
    inputs: [source],
  });
  const facts = fixture.numericEvidence.facts.map((fact) => (
    fact.metric === replacement.metric ? replacement : fact
  ));
  const numericEvidence = {
    ...fixture.numericEvidence,
    facts,
    sizingDecision: {
      ...fixture.numericEvidence.sizingDecision,
      hostDecisionFactIds: fixture.numericEvidence.sizingDecision.hostDecisionFactIds.map((id) => (
        id.includes("accepted_max_total_weight_percent") ? replacement.factId : id
      )),
    },
  };
  const audit = auditCandidateSizingClaims({
    numericEvidence,
    sizingReview: fixture.sizingReview,
    entryAllowed: true,
  });

  assert.equal(audit.status, "failed");
  assert.ok(audit.issues.some((item) => (
    item.code === "required_claim_reference_missing"
      && item.claimId === "host_max_total_weight"
  )));
});

test("candidate sizing audit rejects a decision index from another sizing revision", () => {
  const fixture = sizingFixture();
  const audit = auditCandidateSizingClaims({
    numericEvidence: {
      ...fixture.numericEvidence,
      sizingDecision: {
        ...fixture.numericEvidence.sizingDecision,
        decisionAt: "2026-08-31T09:59:00.000Z",
        entryAllowed: false,
      },
    },
    sizingReview: fixture.sizingReview,
    entryAllowed: true,
  });

  assert.equal(audit.status, "failed");
  assert.ok(audit.issues.some((item) => item.code === "sizing_decision_time_mismatch"));
  assert.ok(audit.issues.some((item) => item.code === "sizing_decision_disposition_mismatch"));
});

test("candidate sizing audit follows the referenced target close when benchmark facts share the metric", () => {
  const fixture = sizingFixture();
  const audit = auditCandidateSizingClaims({
    numericEvidence: {
      ...fixture.numericEvidence,
      facts: [...fixture.numericEvidence.facts, marketFact("QQQ.US", 500)],
    },
    sizingReview: fixture.sizingReview,
    entryAllowed: true,
  });

  assert.equal(audit.status, "verified");
  assert.equal(audit.executionAuthorized, true);
});

test("all nine percentage claims enforce their metric-specific denominator", () => {
  const expected = [
    ["model_initial_additional_weight_percent", "portfolio_net_assets"],
    ["model_max_total_weight_percent", "portfolio_net_assets"],
    ["model_stress_loss_percent", "candidate_position_notional"],
    ["model_exit_slippage_percent", "candidate_position_notional"],
    ["validated_invalidation_distance_percent", "candidate_last_completed_close"],
    ["accepted_initial_additional_weight_percent", "portfolio_net_assets"],
    ["accepted_max_total_weight_percent", "portfolio_net_assets"],
    ["accepted_planned_risk_loss_percent", "candidate_position_notional"],
    ["accepted_stress_risk_loss_percent", "candidate_position_notional"],
  ];
  for (const [suffix, basis] of expected) {
    const fixture = sizingFixture();
    const metric = `candidate.sizing.${suffix}`;
    const original = fixture.numericEvidence.facts.find((fact) => fact.metric === metric);
    assert.equal(original.unit.basis, basis);
    const { hash: _hash, ...input } = original;
    // Re-hash the wrong unit: the failure must be semantic, not hash tampering.
    const replacement = createNumericEvidence({ ...input, unit: { kind: "percent_point", basis: "wrong_denominator" } });
    const audit = auditCandidateSizingClaims({ ...fixture, entryAllowed: true,
      numericEvidence: { ...fixture.numericEvidence, facts: fixture.numericEvidence.facts.map((fact) => fact === original ? replacement : fact) } });
    assert.equal(audit.status, "failed", suffix);
    assert.equal(audit.executionAuthorized, false, suffix);
    assert.ok(audit.issues.some((issue) => issue.code === "claim_unit_basis_mismatch"
      && audit.claimIndex.find((claim) => claim.claimId === issue.claimId)?.metric === metric), suffix);
  }
});

test("price audit binds currency and symbol to the unique referenced known close", () => {
  const known = marketFact();
  for (const unit of [
    { kind: "price", currency: "USD", symbol: "NVDA.US", tickSize: null },
    { kind: "price", currency: "HKD", symbol: "NVDA.US", tickSize: null },
    { kind: "price", currency: "USD", symbol: "0700.HK", tickSize: null },
  ]) {
    const host = hostPriceFact({ value: 97, inputs: [known], unit });
    const result = auditCandidateSizingClaims({ numericEvidence: packageFor({ source: known, proposals: [], decisions: [host] }),
      sizingReview: { decisionAt: DECISION_AT, modelProposal: {}, accepted: { referenceLevel: 97 } }, entryAllowed: false });
    const same = unit.currency === "USD" && unit.symbol === "NVDA.US";
    assert.equal(result.status, same ? "verified" : "failed");
    assert.deepEqual(result.claimIndex.find((claim) => claim.claimId === "host_invalidation_reference").unitDetail, unit);
    if (!same) assert.ok(result.issues.some((issue) => issue.code === "claim_price_unit_reference_mismatch"));
  }
  const { hash: _hash, ...knownInput } = known;
  const unknown = createObservedFact({ ...knownInput, value: null, availability: "unknown",
    quality: { ...knownInput.quality, complete: false, reasonCodes: ["source_value_missing"] } });
  const host = hostPriceFact({ value: 97, inputs: [unknown] });
  const result = auditCandidateSizingClaims({ numericEvidence: packageFor({ source: unknown, proposals: [], decisions: [host] }),
    sizingReview: { decisionAt: DECISION_AT, modelProposal: {}, accepted: { referenceLevel: 97 } }, entryAllowed: false });
  assert.equal(result.status, "failed");
  assert.ok(result.issues.some((issue) => issue.code === "claim_price_unit_reference_mismatch"));
});

function sizingFixture() {
  const source = sourceFact();
  const market = marketFact();
  const modelInitial = proposalFact({
    metric: "candidate.sizing.model_initial_additional_weight_percent",
    value: 4,
    source,
  });
  const modelMax = proposalFact({
    metric: "candidate.sizing.model_max_total_weight_percent",
    value: 9,
    source,
  });
  const modelStress = proposalFact({
    metric: "candidate.sizing.model_stress_loss_percent",
    value: 12,
    source,
    basis: "candidate_position_notional",
  });
  const modelSlippage = proposalFact({
    metric: "candidate.sizing.model_exit_slippage_percent",
    value: 0.5,
    source,
    basis: "candidate_position_notional",
  });
  const modelInputs = [source, market, modelInitial, modelMax, modelStress, modelSlippage];
  const hostReference = hostPriceFact({ value: 97, inputs: modelInputs });
  const riskDistance = derivedPercentFact({
    metric: "candidate.sizing.validated_invalidation_distance_percent",
    value: 3,
    inputs: [market, hostReference],
  });
  const hostPlanned = hostFact({
    metric: "candidate.sizing.accepted_planned_risk_loss_percent",
    value: 3.5,
    inputs: [riskDistance, modelSlippage],
    basis: "candidate_position_notional",
  });
  const hostStress = hostFact({
    metric: "candidate.sizing.accepted_stress_risk_loss_percent",
    value: 12,
    inputs: [hostPlanned, modelStress],
    basis: "candidate_position_notional",
  });
  const hostMax = hostFact({
    metric: "candidate.sizing.accepted_max_total_weight_percent",
    value: 6,
    inputs: [source, modelMax, hostStress],
  });
  const hostInitial = hostFact({
    metric: "candidate.sizing.accepted_initial_additional_weight_percent",
    value: 2,
    inputs: [source, modelInitial, hostMax],
  });
  const proposals = [modelInitial, modelMax, modelStress, modelSlippage];
  const decisions = [hostReference, hostInitial, hostMax, hostPlanned, hostStress];
  return {
    numericEvidence: packageFor({
      sources: [source, market],
      proposals,
      decisions,
      derived: [riskDistance],
    }),
    sizingReview: {
      status: "bounded",
      decisionAt: DECISION_AT,
      modelProposal: {
        initialAdditionalWeightPercent: 4,
        maxTotalWeightPercent: 9,
        stressTest: { lossPercent: 12, slippagePercent: 0.5 },
      },
      accepted: {
        initialAdditionalWeightPercent: 2,
        maxTotalWeightPercent: 6,
        referenceLevel: 97,
        riskDistancePercent: 3,
        plannedRiskLossPercent: 3.5,
        stressRiskLossPercent: 12,
      },
    },
  };
}

function packageFor({ source = null, sources = null, proposals, decisions, derived = [] }) {
  const sourceFacts = sources ?? (source ? [source] : []);
  return {
    packageVersion: "core-numeric-evidence/v1",
    schemaVersion: "numeric-evidence/v1",
    facts: [...sourceFacts, ...proposals, ...decisions, ...derived],
    sizingDecision: {
      decisionAt: DECISION_AT,
      proposalFactIds: proposals.map((fact) => fact.factId),
      hostDecisionFactIds: decisions.map((fact) => fact.factId),
      derivedMetricFactIds: derived.map((fact) => fact.factId),
    },
  };
}

function sourceFact() {
  return createObservedFact({
    factId: `policy.risk_budget_percent@${DECISION_AT}`,
    metric: "policy.risk_budget_percent",
    value: 0.8,
    availability: "known",
    unit: { kind: "percent_point", basis: "portfolio_net_assets" },
    asOf: asOf(),
    provenance: {
      source: "test policy",
      tool: "local:test",
      sourceRecordId: null,
      rawFields: ["risk.riskBudgetPercent"],
      inputRefs: [],
      formula: null,
      methodVersion: "test-policy/v1",
    },
    quality: quality(),
    display: { precision: 2, label: "风险预算" },
  });
}

function marketFact(symbol = "NVDA.US", value = 100) {
  return createObservedFact({
    factId: `market.last_completed_close.${symbol.toLowerCase()}@${DECISION_AT}`,
    metric: "market.last_completed_close",
    value,
    availability: "known",
    unit: {
      kind: "price",
      currency: "USD",
      symbol,
      tickSize: null,
    },
    asOf: asOf(),
    provenance: {
      source: "test market",
      tool: "local:test",
      sourceRecordId: null,
      rawFields: ["technical.lastPrice"],
      inputRefs: [],
      formula: null,
      methodVersion: "test-market/v1",
    },
    quality: quality(),
    display: { precision: 2, label: `${symbol} 收盘价` },
  });
}

function proposalFact({ metric, value, source, basis = "portfolio_net_assets" }) {
  return createModelProposal({
    factId: `${metric}@${DECISION_AT}`,
    metric,
    value,
    availability: "known",
    unit: { kind: "percent_point", basis },
    asOf: asOf(),
    provenance: {
      source: "test model",
      tool: "codex:test",
      sourceRecordId: null,
      rawFields: [],
      inputRefs: [numericEvidenceRef(source)],
      formula: null,
      methodVersion: "test-proposal/v1",
    },
    quality: quality("medium"),
    display: { precision: 2, label: metric },
  });
}

function hostFact({ metric, value, inputs, basis = "portfolio_net_assets" }) {
  return createHostDecision({
    factId: `${metric}@${DECISION_AT}`,
    metric,
    value,
    availability: "known",
    unit: { kind: "percent_point", basis },
    asOf: asOf(),
    provenance: {
      source: "test host",
      tool: "local:test-guardrail",
      sourceRecordId: null,
      rawFields: [],
      inputRefs: inputs.map(numericEvidenceRef),
      formula: "min(model_proposal, deterministic_limits)",
      methodVersion: "test-host/v1",
    },
    quality: quality("high"),
    display: { precision: 2, label: metric },
  });
}

function hostPriceFact({ value, inputs, unit = { kind: "price", currency: "USD", symbol: "NVDA.US", tickSize: null } }) {
  return createHostDecision({
    factId: `candidate.sizing.accepted_invalidation_reference_price@${DECISION_AT}`,
    metric: "candidate.sizing.accepted_invalidation_reference_price",
    value,
    availability: "known",
    unit,
    asOf: asOf(),
    provenance: {
      source: "test host",
      tool: "local:test-guardrail",
      sourceRecordId: "structured-invalidation:test",
      rawFields: ["candidateSizing.invalidation"],
      inputRefs: inputs.map(numericEvidenceRef),
      formula: "resolve_structured_invalidation",
      methodVersion: "test-host/v1",
    },
    quality: quality("high"),
    display: { precision: 2, label: "宿主接受失效参考价" },
  });
}

function derivedPercentFact({ metric, value, inputs }) {
  return createDerivedMetric({
    factId: `${metric}@${DECISION_AT}`,
    metric,
    value,
    availability: "known",
    unit: { kind: "percent_point", basis: "candidate_last_completed_close" },
    asOf: asOf(),
    provenance: {
      source: "test host",
      tool: "local:test-guardrail",
      sourceRecordId: null,
      rawFields: [],
      inputRefs: inputs.map(numericEvidenceRef),
      formula: "(market_close - accepted_reference) / market_close * 100",
      methodVersion: "test-derived/v1",
    },
    quality: quality("high"),
    display: { precision: 4, label: metric },
  });
}

function asOf() {
  return {
    effectiveAt: DECISION_AT,
    retrievedAt: DECISION_AT,
    tradingDate: null,
    session: "not_applicable",
    timeZone: "UTC",
  };
}

function quality(confidence = "high") {
  return {
    freshness: "fresh",
    ageMs: 0,
    complete: true,
    confidence,
    reasonCodes: [],
  };
}
