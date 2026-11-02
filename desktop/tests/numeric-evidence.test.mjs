import test from "node:test";
import assert from "node:assert/strict";

import {
  NUMERIC_EVIDENCE_SCHEMA_VERSION,
  createDerivedMetric,
  createHostDecision,
  createModelProposal,
  createObservedFact,
  normalizeDecimalString,
  numericEvidenceRef,
  stableNumericEvidenceHash,
  validateNumericEvidence,
} from "../src/engine/numeric-evidence.mjs";

const NOW = "2026-08-31T10:00:00.000Z";

function observed(overrides = {}) {
  return createObservedFact({
    factId: "portfolio.net_assets@2026-08-31T10:00:00Z",
    metric: "portfolio.net_assets",
    value: "123456.7800",
    availability: "known",
    unit: { kind: "money", currency: "usd" },
    asOf: {
      effectiveAt: NOW,
      retrievedAt: NOW,
      tradingDate: null,
      session: "not_applicable",
      timeZone: "UTC",
    },
    provenance: {
      source: "Longbridge",
      tool: "account_balance",
      sourceRecordId: "account:primary",
      rawFields: ["net_assets"],
      inputRefs: [],
      formula: null,
      methodVersion: "longbridge-account/v1",
    },
    quality: {
      freshness: "live",
      ageMs: 0,
      complete: true,
      confidence: "not_applicable",
      reasonCodes: [],
    },
    display: { precision: 2, label: "净资产" },
    ...overrides,
  });
}

test("known zero remains distinct from an unavailable value", () => {
  const zero = observed({
    factId: "portfolio.margin_call@2026-08-31T10:00:00Z",
    metric: "portfolio.margin_call",
    value: -0,
  });
  assert.equal(zero.value, "0");
  assert.equal(zero.availability, "known");

  const unknown = observed({
    factId: "portfolio.buy_power@2026-08-31T10:00:00Z",
    metric: "portfolio.buy_power",
    value: null,
    availability: "unknown",
    quality: {
      freshness: "unknown",
      ageMs: null,
      complete: false,
      confidence: "unknown",
      reasonCodes: ["broker_field_missing"],
    },
  });
  assert.equal(unknown.value, null);
  assert.equal(unknown.availability, "unknown");
  assert.throws(() => observed({ value: null, availability: "known" }), /must contain a value/);
  assert.throws(() => observed({
    value: "0",
    availability: "unknown",
    quality: {
      freshness: "unknown",
      ageMs: null,
      complete: false,
      confidence: "unknown",
      reasonCodes: ["missing"],
    },
  }), /must use value: null/);
});

test("unknown and not_applicable require an explicit reason", () => {
  for (const availability of ["unknown", "not_applicable"]) {
    assert.throws(() => observed({
      value: null,
      availability,
      quality: {
        freshness: availability === "unknown" ? "unknown" : "not_applicable",
        ageMs: null,
        complete: false,
        confidence: "not_applicable",
        reasonCodes: [],
      },
    }), /requires at least one quality.reasonCodes/);
  }
  assert.throws(() => observed({
    value: null,
    availability: "unknown",
    quality: {
      freshness: "unknown",
      ageMs: null,
      complete: true,
      confidence: "unknown",
      reasonCodes: ["missing"],
    },
  }), /cannot be marked complete/);
});

test("decimal strings are canonical, non-exponent, and reject formatted or non-finite input", () => {
  assert.equal(normalizeDecimalString("00123.45000"), "123.45");
  assert.equal(normalizeDecimalString(".5000"), "0.5");
  assert.equal(normalizeDecimalString("-0.000"), "0");
  assert.equal(normalizeDecimalString(1e-7), "0.0000001");
  assert.equal(normalizeDecimalString(12n), "12");
  for (const invalid of [NaN, Infinity, -Infinity, "1.2%", "1,200", "NaN", true, null]) {
    assert.throws(() => normalizeDecimalString(invalid), /numeric evidence|decimal|NaN|Infinity/);
  }
});

test("percent points, money, price and FX have unambiguous units", () => {
  const percent = observed({
    factId: "portfolio.gross_exposure_percent@2026-08-31T10:00:00Z",
    metric: "portfolio.gross_exposure_percent",
    value: "120.5",
    unit: { kind: "percent_point", basis: "net_assets" },
  });
  assert.deepEqual(percent.unit, { kind: "percent_point", basis: "net_assets" });
  assert.equal(observed().unit.currency, "USD");

  const price = observed({
    factId: "quote.aapl.last@2026-08-31T10:00:00Z",
    metric: "quote.last_price",
    value: "0.045600",
    unit: { kind: "price", currency: "usd", symbol: "AAPL.US", tickSize: "0.0001" },
  });
  assert.equal(price.value, "0.0456");
  assert.equal(price.unit.tickSize, "0.0001");

  const fx = observed({
    factId: "fx.usd_hkd@2026-08-31T10:00:00Z",
    metric: "fx.rate",
    value: "7.8123",
    unit: {
      kind: "fx",
      baseCurrency: "usd",
      quoteCurrency: "hkd",
      direction: "quote_per_base",
    },
  });
  assert.deepEqual(fx.unit, {
    kind: "fx",
    baseCurrency: "USD",
    quoteCurrency: "HKD",
    direction: "quote_per_base",
  });

  assert.throws(() => observed({ unit: { kind: "percent" } }), /ambiguous percentage/);
  assert.throws(() => observed({
    unit: { kind: "fx", baseCurrency: "USD", quoteCurrency: "HKD", direction: "base_per_quote" },
  }), /quote_per_base/);
  assert.throws(() => observed({
    value: "0",
    unit: { kind: "fx", baseCurrency: "USD", quoteCurrency: "HKD", direction: "quote_per_base" },
  }), /must be positive/);
  assert.throws(() => observed({
    value: "-1",
    unit: { kind: "price", currency: "USD", symbol: "AAPL.US" },
  }), /cannot be negative/);
});

test("asOf, provenance and quality reject ambiguous metadata", () => {
  assert.throws(() => observed({
    asOf: { effectiveAt: "not-a-date", retrievedAt: NOW, tradingDate: null, session: "regular", timeZone: "UTC" },
  }), /ISO timestamp/);
  assert.throws(() => observed({
    asOf: { effectiveAt: NOW, retrievedAt: NOW, tradingDate: "2026-02-30", session: "regular", timeZone: "UTC" },
  }), /valid calendar date/);
  assert.throws(() => observed({
    asOf: { effectiveAt: NOW, retrievedAt: NOW, tradingDate: null, session: "regular", timeZone: "Mars\/Olympus" },
  }), /valid IANA/);
  assert.throws(() => observed({
    quality: { freshness: "fresh", ageMs: -1, complete: true, confidence: "high", reasonCodes: [] },
  }), /non-negative safe integer/);
  assert.throws(() => observed({ extra: true }), /unsupported fields/);
});

test("all four evidence kinds are supported and non-observed kinds require fact references", () => {
  const source = observed();
  const ref = numericEvidenceRef(source);
  const common = {
    factId: "portfolio.net_assets_percent@2026-08-31T10:00:00Z",
    metric: "portfolio.net_assets_ratio",
    value: "1",
    availability: "known",
    unit: { kind: "ratio", basis: "opening_net_assets" },
    asOf: source.asOf,
    quality: {
      freshness: "fresh",
      ageMs: 0,
      complete: true,
      confidence: "high",
      reasonCodes: [],
    },
  };
  const derived = createDerivedMetric({
    ...common,
    provenance: {
      source: "local",
      tool: "risk_engine",
      sourceRecordId: null,
      rawFields: [],
      inputRefs: [ref],
      formula: "net_assets / opening_net_assets",
      methodVersion: "risk/v1",
    },
  });
  const proposal = createModelProposal({
    ...common,
    factId: "proposal.initial_weight@2026-08-31T10:00:00Z",
    metric: "proposal.initial_weight_percent",
    value: "2",
    unit: { kind: "percent_point", basis: "net_assets" },
    provenance: {
      source: "Codex LLM",
      tool: null,
      sourceRecordId: null,
      rawFields: [],
      inputRefs: [numericEvidenceRef(derived)],
      formula: null,
      methodVersion: "candidate-proposal/v1",
    },
  });
  const decision = createHostDecision({
    ...common,
    factId: "decision.accepted_weight@2026-08-31T10:00:00Z",
    metric: "decision.accepted_weight_percent",
    value: "1",
    unit: { kind: "percent_point", basis: "net_assets" },
    provenance: {
      source: "Trading Cockpit host",
      tool: "candidate_sizing",
      sourceRecordId: null,
      rawFields: [],
      inputRefs: [numericEvidenceRef(proposal), numericEvidenceRef(source)],
      formula: "min(model_proposal, deterministic_limits)",
      methodVersion: "candidate-sizing/v1",
    },
  });

  assert.equal(source.kind, "observed_fact");
  assert.equal(derived.kind, "derived_metric");
  assert.equal(proposal.kind, "model_proposal");
  assert.equal(decision.kind, "host_decision");
  assert.equal(decision.schemaVersion, NUMERIC_EVIDENCE_SCHEMA_VERSION);
  assert.throws(() => createDerivedMetric({
    ...common,
    provenance: {
      source: "local",
      tool: null,
      sourceRecordId: null,
      rawFields: [],
      inputRefs: [],
      formula: "x / y",
      methodVersion: "v1",
    },
  }), /requires at least one provenance.inputRefs/);
});

test("hashes are stable across set ordering and detect any mutation", () => {
  const left = observed({
    provenance: {
      source: "Longbridge",
      tool: "account_balance",
      sourceRecordId: "account:primary",
      rawFields: ["total_cash", "net_assets"],
      inputRefs: [],
      formula: null,
      methodVersion: "longbridge-account/v1",
    },
    quality: {
      freshness: "live",
      ageMs: 0,
      complete: true,
      confidence: "not_applicable",
      reasonCodes: ["b", "a", "a"],
    },
  });
  const right = observed({
    quality: {
      freshness: "live",
      ageMs: 0,
      complete: true,
      confidence: "not_applicable",
      reasonCodes: ["a", "b"],
    },
    provenance: {
      source: "Longbridge",
      tool: "account_balance",
      sourceRecordId: "account:primary",
      rawFields: ["net_assets", "total_cash"],
      inputRefs: [],
      formula: null,
      methodVersion: "longbridge-account/v1",
    },
  });
  assert.equal(left.hash, right.hash);
  assert.equal(stableNumericEvidenceHash(left), left.hash);
  assert.deepEqual(validateNumericEvidence(left), left);
  assert.equal(Object.isFrozen(left), true);

  const tampered = { ...left, value: "999" };
  assert.throws(() => validateNumericEvidence(tampered), /hash does not match/);
  assert.throws(() => numericEvidenceRef({ ...left, hash: "sha256:bad" }), /requires a sha256/);
});
