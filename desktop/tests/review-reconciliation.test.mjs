import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewReconciliation, hashReviewReconciliationEvidence, summarizeReviewReconciliation } from "../src/review/review-reconciliation.mjs";

const startAt = "2026-08-03T20:00:00.000Z";
const endAt = "2026-08-31T20:00:00.000Z";
const scope = "broker-scope-fixture";
const cycle = { id: "cycle-1", startAt, endAt, evidenceRevision: 4, brokerLinks: { accountScopeId: scope } };
function snapshot(at, amount, extra = {}) {
  return { snapshotId: `snapshot-${at}`, capturedAt: at, accountScope: { scopeId: scope },
    summary: { totalAssets: amount, cash: 0, reportingCurrency: "USD" },
    holdings: [{ symbol: "AAPL.US", quantity: 10, currency: "USD", costBasis: 100 }],
    valuation: { session: "regular_close", methodVersion: "broker-statement-v1", totalAssetsBasis: "broker_observed",
      quoteAsOf: at, quoteLatestAsOf: at, afterHoursMarksExcluded: true },
    dataQuality: { status: "complete" },
    provenance: { provider: "FixtureBroker", freshness: "live" }, ...extra };
}
function ledger(records = [], extra = {}) {
  return { evidenceId: "statement-1", source: "FixtureBroker original statement", sourceKind: "broker_statement",
    accountScopeId: scope, observedAt: "2026-09-01T01:00:00.000Z", coverage: { startAt, endAt, complete: true }, records, ...extra };
}
function verified(...values) { return values.filter(Boolean).map(hashReviewReconciliationEvidence); }
function fullScope() {
  return { cycle, openingSnapshot: snapshot(startAt, 100), closingSnapshot: snapshot(endAt, 110),
    externalFlows: ledger([], { evidenceId: "flows" }), fees: ledger([], { evidenceId: "fees" }),
    taxes: ledger([], { evidenceId: "taxes" }), corporateActions: ledger([], { evidenceId: "actions" }) };
}
function verifiedInput(input) {
  return { ...input, verifiedSourceHashes: verified(...["openingSnapshot", "closingSnapshot", "externalFlows", "fees", "taxes", "corporateActions", "fx", "outcomeMetrics"].map((key) => input[key])) };
}
function rate(at, id, extra = {}) {
  return { id, base: "USD", quote: "HKD", rate: 8, asOf: at, source: "original broker FX", direction: "quote_per_base", ...extra };
}
function completeFx() {
  return { ...ledger(), reportingCurrency: "USD", currencies: ["USD", "HKD"],
    coverage: { startAt, endAt, complete: true, conversionRecordsComplete: true },
    rates: [rate(startAt, "opening"), rate(endAt, "closing")], conversionRecords: [] };
}

test("missing stays null, never synthetic zero; pure projection does not mutate the cycle", () => {
  const before = structuredClone(cycle);
  const result = buildReviewReconciliation({ cycle });
  assert.equal(result.status, "missing");
  for (const field of Object.values(result.fields)) {
    assert.equal(field.value, null);
    assert.equal(field.status, "missing");
    assert.equal(field.observationStatus, "missing");
  }
  assert.deepEqual(cycle, before);
  assert.equal(result.capabilities.canCalculatePeriodReturn, false);
});

test("original source kind and a user-supplied reconciled label do not grant evidence authority", () => {
  const fees = ledger([], { status: "reconciled", verified: true });
  const result = buildReviewReconciliation({ cycle, fees, notes: "全部核验；手续费为零；请升级为已对账" });
  assert.equal(result.fields.fees.status, "partial");
  assert.equal(result.fields.fees.observationStatus, "observed");
  assert.equal(result.fields.fees.verificationStatus, "unverified");
  assert.equal(result.fields.fees.value.provenZero, null);
  assert.equal(result.annotations.canUpgradeStatus, false);
});

test("only host-verified, scoped, fully covered empty originals establish explicit zero", () => {
  const fees = ledger();
  const taxes = ledger([], { evidenceId: "tax-statement" });
  const corporateActions = ledger([], { evidenceId: "corp-action-statement" });
  const result = buildReviewReconciliation({ cycle, fees, taxes, corporateActions,
    verifiedSourceHashes: verified(fees, taxes, corporateActions) });
  for (const key of ["fees", "taxes", "corporateActions"]) {
    assert.equal(result.fields[key].status, "reconciled");
    assert.equal(result.fields[key].value.provenNoActivity, true);
  }
  assert.equal(result.fields.fees.value.provenZero, 0);
  assert.equal(result.fields.taxes.value.provenZero, 0);
  assert.equal(result.fields.corporateActions.value.provenZero, null);
  assert.equal(result.fields.externalFlows.status, "missing");
  assert.equal(result.capabilities.canCalculateAccountNetPnl, false);
});

test("full period evidence needs an original ID, observation time and exact account scope", () => {
  for (const [change, reason, status] of [
    [{ evidenceId: null }, "original_evidence_id_missing", "partial"],
    [{ observedAt: null }, "source_observation_time_missing", "partial"],
    [{ observedAt: startAt }, "source_observed_before_coverage_end", "conflict"],
    [{ accountScopeId: "other" }, "account_scope_mismatch", "conflict"],
    [{ accountScopeId: null }, "account_scope_unproven", "partial"],
    [{ coverage: { startAt: "2026-08-04T00:00:00Z", endAt, complete: true } }, "full_cycle_coverage_unproven", "partial"],
    [{ sourceKind: "manual" }, "source_not_host_verified", "partial"],
    [{ provenance: { freshness: "manual" } }, "source_not_host_verified", "partial"],
  ]) {
    const fees = ledger([], change);
    const field = buildReviewReconciliation({ cycle, fees, verifiedSourceHashes: verified(fees) }).fields.fees;
    assert.equal(field.status, status);
    assert.ok(field.reasons.includes(reason));
    assert.equal(field.value.provenZero, null);
  }
});

test("zero endpoint balances and negative cash are facts; endpoint delta is never a return", () => {
  const opening = snapshot(startAt, 0, { summary: { totalAssets: 0, cash: -25, reportingCurrency: "USD" } });
  const closing = snapshot(endAt, 100, { summary: { totalAssets: 100, cash: 0, reportingCurrency: "USD" } });
  const result = buildReviewReconciliation({ cycle, openingSnapshot: opening, closingSnapshot: closing,
    verifiedSourceHashes: verified(opening, closing) });
  const field = result.fields.netAssetEndpoints;
  assert.equal(field.status, "reconciled");
  assert.equal(field.value.opening, 0);
  assert.equal(field.value.openingCash, -25);
  assert.equal(field.value.closingCash, 0);
  assert.equal(field.value.netAssetChange, 100);
  assert.equal(field.value.periodReturnPercent, null);
  assert.equal(result.capabilities.canCompareObservedNetAssetEndpoints, true);
  assert.equal(result.capabilities.canCalculatePeriodReturn, false);
});

test("unknown and blank numeric fields do not silently become zero", () => {
  const opening = snapshot(startAt, null, { summary: { totalAssets: null, cash: "", reportingCurrency: "USD" } });
  const closing = snapshot(endAt, 100);
  const field = buildReviewReconciliation({ cycle, openingSnapshot: opening, closingSnapshot: closing,
    verifiedSourceHashes: verified(opening, closing) }).fields.netAssetEndpoints;
  assert.equal(field.value.opening, null);
  assert.equal(field.value.openingCash, null);
  assert.equal(field.value.netAssetChange, null);
  assert.equal(field.status, "partial");
});

test("regular-close-v2 remains partial even with a host verified hash and a complete flag", () => {
  const opening = snapshot(startAt, 100);
  const closing = snapshot(endAt, 110);
  closing.valuation.methodVersion = "regular-close-v2";
  closing.dataQuality.completeForPeriodReturn = true;
  const result = buildReviewReconciliation({ cycle, openingSnapshot: opening, closingSnapshot: closing,
    verifiedSourceHashes: verified(opening, closing) });
  assert.equal(result.fields.closingInventory.status, "partial");
  assert.equal(result.fields.closingPrices.status, "partial");
  assert.equal(result.fields.netAssetEndpoints.status, "partial");
  assert.ok(result.fields.closingPrices.reasons.includes("regular_close_v2_prices_only_inventory_and_cash_unreconciled"));
  assert.equal(result.capabilities.canCalculatePeriodReturn, false);
});

test("future inventory, mismatched currency and reversed endpoints suppress net asset comparison", () => {
  const opening = snapshot(startAt, 100);
  for (const closing of [
    snapshot("2026-09-01T20:00:00Z", 110),
    snapshot(endAt, 110, { summary: { totalAssets: 110, cash: 0, reportingCurrency: "HKD" } }),
    snapshot(startAt, 110),
  ]) {
    const result = buildReviewReconciliation({ cycle, openingSnapshot: opening, closingSnapshot: closing,
      verifiedSourceHashes: verified(opening, closing) });
    assert.equal(result.fields.netAssetEndpoints.status, "conflict");
    assert.equal(result.fields.netAssetEndpoints.value.netAssetChange, null);
  }
});

test("older observations and lossy review snapshots remain partial instead of silently standing in for boundaries", () => {
  const opening = snapshot("2026-07-31T20:00:00Z", 100);
  const closing = { snapshotAt: endAt, netAssets: 110, baseCurrency: "USD", positions: [],
    dataQuality: { status: "complete" }, provenance: { source: "ledger", integrityStatus: "verified_on_read" } };
  const result = buildReviewReconciliation({ cycle, openingSnapshot: opening, closingSnapshot: closing,
    verifiedSourceHashes: verified(opening, closing) });
  assert.equal(result.fields.openingInventory.status, "partial");
  assert.ok(result.fields.openingInventory.reasons.includes("inventory_not_observed_at_exact_boundary"));
  assert.equal(result.fields.closingInventory.status, "partial");
  assert.ok(result.fields.closingInventory.reasons.includes("original_inventory_rows_missing"));
  assert.ok(result.fields.closingPrices.reasons.includes("valuation_basis_missing"));
});

test("external flows keep signed original-currency totals, duplicates and sign conflicts are not accepted", () => {
  const records = [
    { id: "in", occurredAt: "2026-08-10T15:00:00Z", amount: 300, currency: "USD", kind: "deposit" },
    { id: "out", occurredAt: "2026-08-11T15:00:00Z", amount: -100, currency: "USD", kind: "withdrawal" },
    { id: "hkd", occurredAt: "2026-08-12T15:00:00Z", amount: "700.50", currency: "HKD", kind: "deposit" },
  ];
  const externalFlows = ledger(records);
  const field = buildReviewReconciliation({ cycle, externalFlows, verifiedSourceHashes: verified(externalFlows) }).fields.externalFlows;
  assert.equal(field.status, "reconciled");
  assert.deepEqual(field.value.reconciledTotalsByCurrency, { USD: 200, HKD: 700.5 });
  assert.equal(field.value.provenZero, null);
  for (const bad of [[...records, records[0]], [{ ...records[0], amount: -300 }]]) {
    const input = ledger(bad);
    const result = buildReviewReconciliation({ cycle, externalFlows: input, verifiedSourceHashes: verified(input) }).fields.externalFlows;
    assert.equal(result.status, "conflict");
    assert.equal(result.value.reconciledTotalsByCurrency, null);
  }
});

test("corporate action original fields matter; explicit no-activity is distinct from missing actions", () => {
  const corporateActions = ledger([{ id: "split-1", occurredAt: "2026-08-10T12:00:00Z", symbol: "AAPL.US", kind: "split" }]);
  const result = buildReviewReconciliation({ cycle, corporateActions, verifiedSourceHashes: verified(corporateActions) });
  assert.equal(result.fields.corporateActions.status, "partial");
  assert.ok(result.fields.corporateActions.reasons.includes("split_ratio_missing"));
});

test("FX must cover currencies and conversion times; endpoint rates are only observed evidence", () => {
  const opening = snapshot(startAt, 100, { fx: { status: "complete", rates: [{ base: "USD", quote: "HKD", rate: 7.8, asOf: startAt, source: "broker" }] } });
  const partial = buildReviewReconciliation({ cycle, openingSnapshot: opening, verifiedSourceHashes: verified(opening) }).fields.fx;
  assert.equal(partial.status, "partial");
  assert.equal(partial.value.observedEndpointRates[0].rates[0].rate, 7.8);
  const input = fullScope();
  const fx = { ...ledger(), reportingCurrency: "USD", currencies: ["USD", "HKD"], rates: [rate(endAt, "closing")] };
  let result = buildReviewReconciliation(verifiedInput({ ...input, fx })).fields.fx;
  assert.equal(result.status, "partial");
  fx.coverage.conversionTimesComplete = true;
  result = buildReviewReconciliation(verifiedInput({ ...input, fx })).fields.fx;
  assert.equal(result.status, "partial");
  fx.rates.push(rate(startAt, "opening"));
  result = buildReviewReconciliation(verifiedInput({ ...input, fx })).fields.fx;
  assert.equal(result.status, "partial"); // flags plus rates do not prove original conversions
  assert.ok(result.reasons.includes("original_conversion_records_coverage_unproven"));
  fx.coverage.conversionRecordsComplete = true;
  fx.conversionRecords = [];
  result = buildReviewReconciliation(verifiedInput({ ...input, fx })).fields.fx;
  assert.equal(result.status, "reconciled");
  assert.equal(result.value.ratesUsedForConversion, false);
  fx.rates[0].asOf = "2026-09-01T12:00:00Z";
  result = buildReviewReconciliation(verifiedInput({ ...input, fx })).fields.fx;
  assert.equal(result.status, "conflict");
});

test("QQQ output keeps price interval semantics, detects arithmetic conflicts and never creates portfolio alpha", () => {
  const outcomeMetrics = { generatedAt: "2026-09-01T12:00:00Z", cycleWindow: { startAt, endAt },
    coverage: { source: "Longbridge daily bars", adjustType: "forward", candleSources: [{ symbol: "QQQ.US", source: "live", coverageStatus: "complete", fetchedAt: "2026-09-01T12:00:00Z", adjustment: "forward" }] },
    pricePath: { benchmark: "QQQ.US", benchmarkMetrics: { symbol: "QQQ.US", status: "available", firstClose: 100, lastClose: 110, periodReturnPercent: 10, firstTradeDate: "2026-08-03", lastTradeDate: "2026-08-31" } } };
  let result = buildReviewReconciliation({ cycle, outcomeMetrics, verifiedSourceHashes: verified(outcomeMetrics) });
  assert.equal(result.fields.qqqBenchmark.status, "partial");
  assert.ok(Math.abs(result.fields.qqqBenchmark.value.observedPriceReturnPercent - 10) < 1e-10);
  assert.equal(result.fields.qqqBenchmark.value.portfolioAlphaPercent, null);
  assert.equal(result.capabilities.canCalculatePortfolioAlpha, false);
  outcomeMetrics.pricePath.benchmarkMetrics.periodReturnPercent = 110;
  result = buildReviewReconciliation({ cycle, outcomeMetrics, verifiedSourceHashes: verified(outcomeMetrics) });
  assert.equal(result.fields.qqqBenchmark.status, "conflict");
  assert.ok(result.fields.qqqBenchmark.reasons.includes("benchmark_return_arithmetic_conflict"));
});

test("hash is canonical and stable across notes but changes with evidence, host attestation or cycle revision", () => {
  const fees = ledger();
  const a = buildReviewReconciliation({ cycle, fees, notes: "old" });
  const b = buildReviewReconciliation({ cycle, fees, notes: "new interpretation" });
  assert.equal(a.evidenceHash, b.evidenceHash);
  assert.deepEqual(a.fields, b.fields);
  assert.equal(hashReviewReconciliationEvidence({ a: 1, b: 2 }), hashReviewReconciliationEvidence({ b: 2, a: 1 }));
  assert.notEqual(a.evidenceHash, buildReviewReconciliation({ cycle, fees, verifiedSourceHashes: verified(fees) }).evidenceHash);
  assert.notEqual(a.evidenceHash, buildReviewReconciliation({ cycle: { ...cycle, evidenceRevision: 5 }, fees }).evidenceHash);
  assert.notEqual(a.evidenceHash, buildReviewReconciliation({ cycle, fees: { ...fees, evidenceId: "new-source" } }).evidenceHash);
  assert.equal(a.cycleEvidenceRevision, 4);
  assert.ok(a.sourceHashes.includes(hashReviewReconciliationEvidence(fees)));
});

test("attestation binds the complete original payload, not its label or an old hash", () => {
  const fees = ledger([{ id: "fee-1", occurredAt: endAt, amount: 1, currency: "USD", kind: "commission" }]);
  const hashes = verified(fees);
  fees.records[0].amount = 0;
  fees.verified = true;
  const result = buildReviewReconciliation({ cycle, fees, verifiedSourceHashes: hashes });
  assert.equal(result.fields.fees.sourceVerificationStatus, "unverified");
  assert.equal(result.fields.fees.verificationStatus, "unverified");
  assert.equal(result.fields.fees.value.reconciledTotalsByCurrency, null);
  assert.ok(result.fields.fees.reasons.includes("source_not_host_verified"));
  assert.doesNotThrow(() => buildReviewReconciliation({ cycle, fees, verifiedSourceHashes: { verified: true } }));
});

test("authentic nonempty corporate events do not prove their account cash, tax and inventory effects", () => {
  for (const event of [
    { kind: "split", ratio: 2 },
    { kind: "dividend", amount: 10, currency: "USD" },
    { kind: "merger" }, { kind: "spinoff" }, { kind: "return_of_capital", amount: 10, currency: "USD" },
  ]) {
    const corporateActions = ledger([{ id: `action-${event.kind}`, occurredAt: endAt, symbol: "AAPL.US", ...event,
      effectsComplete: true, cashInventoryEffectsReconciled: true }]);
    const field = buildReviewReconciliation({ cycle, corporateActions, verifiedSourceHashes: verified(corporateActions) }).fields.corporateActions;
    assert.equal(field.status, "partial");
    assert.equal(field.sourceVerificationStatus, "verified");
    assert.equal(field.verificationStatus, "unverified");
    assert.equal(field.value.cashInventoryEffectsReconciled, false);
    assert.equal(field.value.reconciledTotalsByCurrency, null);
    assert.ok(field.reasons.includes("corporate_action_cash_inventory_effects_unreconciled"));
  }
});

test("endpoint cash and price timestamps cannot be declared complete by snapshot flags", () => {
  for (const [mutate, reason, status] of [
    [(row) => { row.summary.cash = null; }, "cash_inventory_missing", "partial"],
    [(row) => { row.summary.cash = true; }, "cash_inventory_missing", "partial"],
    [(row) => { row.valuation.quoteAsOf = "2026-09-01T20:00:00.000Z"; row.valuation.quoteLatestAsOf = null; }, "price_after_boundary", "conflict"],
    [(row) => { row.valuation.quoteAsOf = "2026-08-30T20:00:00.000Z"; }, "prices_not_observed_at_exact_boundary", "partial"],
    [(row) => { row.valuation.quoteLatestAsOf = "2026-08-30T20:00:00.000Z"; }, "price_time_range_invalid", "conflict"],
  ]) {
    const closing = snapshot(endAt, 100);
    mutate(closing);
    const field = buildReviewReconciliation({ cycle, closingSnapshot: closing, verifiedSourceHashes: verified(closing) }).fields.closingPrices;
    assert.equal(field.status, status);
    assert.equal(field.verificationStatus, "unverified");
    assert.ok(field.reasons.includes(reason), reason);
  }
});

test("fees and taxes distinguish recorded zero from missing, boolean and aggregate overflow", () => {
  for (const kind of ["fees", "taxes"]) {
    const record = { id: "charge", occurredAt: endAt, currency: "USD", kind: "charge", amount: 0 };
    const zero = ledger([record]);
    const actualZero = buildReviewReconciliation({ cycle, [kind]: zero, verifiedSourceHashes: verified(zero) }).fields[kind];
    assert.equal(actualZero.status, "reconciled");
    assert.deepEqual(actualZero.value.reconciledTotalsByCurrency, { USD: 0 });
    assert.equal(actualZero.value.provenNoActivity, false); // an actual zero-valued record is still activity
    for (const amount of [null, "", true, false]) {
      const incomplete = ledger([{ ...record, amount }]);
      const field = buildReviewReconciliation({ cycle, [kind]: incomplete, verifiedSourceHashes: verified(incomplete) }).fields[kind];
      assert.equal(field.status, "partial");
      assert.equal(field.value.reconciledTotalsByCurrency, null);
      assert.equal(field.value.provenZero, null);
    }
    const overflow = ledger([{ ...record, id: "one", amount: 1e308 }, { ...record, id: "two", amount: 1e308 }]);
    const field = buildReviewReconciliation({ cycle, [kind]: overflow, verifiedSourceHashes: verified(overflow) }).fields[kind];
    assert.equal(field.status, "conflict");
    assert.deepEqual(field.value.observedTotalsByCurrency, { USD: null });
    assert.equal(field.value.reconciledTotalsByCurrency, null);
  }
});

test("FX needs verified endpoint and cash-event scope, including currencies omitted from the declaration", () => {
  for (const missingKey of ["openingSnapshot", "closingSnapshot", "externalFlows", "fees", "taxes", "corporateActions"]) {
    const input = { ...fullScope(), fx: completeFx(), [missingKey]: null };
    const field = buildReviewReconciliation(verifiedInput(input)).fields.fx;
    assert.equal(field.status, "partial", missingKey);
    assert.equal(field.verificationStatus, "unverified");
    assert.ok(field.reasons.some((reason) => reason.startsWith("fx_requirement_scope_incomplete:")));
  }
  const input = { ...fullScope(), fx: completeFx() };
  input.openingSnapshot.holdings[0].currency = "JPY";
  const field = buildReviewReconciliation(verifiedInput(input)).fields.fx;
  assert.equal(field.status, "partial");
  assert.ok(field.reasons.includes("observed_currency_missing_from_fx_scope"));
  assert.ok(field.value.requiredConversionTimes.some((row) => row.currency === "JPY"));
});

test("FX verifies actual conversion arithmetic and exact transaction rates, not a completion boolean", () => {
  const at = "2026-08-10T15:00:00.000Z";
  const input = { ...fullScope(), fx: completeFx() };
  input.externalFlows.records = [{ id: "deposit-hkd", occurredAt: at, amount: 80, currency: "HKD", kind: "deposit" }];
  input.fx.conversionRecords = [{ id: "converted", occurredAt: at, fromCurrency: "HKD", toCurrency: "USD",
    fromAmount: 80, toAmount: 10, rateId: "transaction" }];
  let field = buildReviewReconciliation(verifiedInput(input)).fields.fx;
  assert.equal(field.status, "partial");
  assert.ok(field.reasons.includes("transaction_and_endpoint_fx_times_incomplete"));
  input.fx.rates.push(rate(at, "transaction"));
  field = buildReviewReconciliation(verifiedInput(input)).fields.fx;
  assert.equal(field.status, "reconciled");
  assert.equal(field.verificationStatus, "verified");
  assert.equal(field.value.ratesUsedForConversion, false); // validation is not a performance engine
  for (const [mutate, code, status] of [
    [(fx) => { fx.conversionRecords[0].toAmount = 80; }, "conversion_amount_arithmetic_conflict", "conflict"],
    [(fx) => { fx.conversionRecords[0].fromAmount = true; }, "conversion_record_fields_incomplete", "partial"],
    [(fx) => { fx.conversionRecords[0].accountScopeId = "other-account"; }, "conversion_record_account_scope_mismatch", "conflict"],
    [(fx) => { fx.conversionRecords.push({ ...fx.conversionRecords[0] }); }, "duplicate_conversion_record_id", "conflict"],
    [(fx) => { fx.rates[2].direction = "base_per_quote"; }, "fx_rate_direction_unproven", "partial"],
    [(fx) => { fx.rates.push(rate(at, "inverse", { base: "HKD", quote: "USD", rate: 0.2 })); }, "fx_reciprocal_rate_conflict", "conflict"],
  ]) {
    const changed = structuredClone(input);
    mutate(changed.fx);
    const result = buildReviewReconciliation(verifiedInput(changed)).fields.fx;
    assert.equal(result.status, status, code);
    assert.ok(result.reasons.includes(code), code);
    assert.equal(result.verificationStatus, "unverified");
  }
});

test("USD-only no-conversion evidence is explicit and does not invent FX from a missing rate", () => {
  const input = { ...fullScope(), fx: { ...completeFx(), currencies: ["USD"], rates: [], conversionRecords: [] } };
  const result = buildReviewReconciliation(verifiedInput(input)).fields.fx;
  assert.equal(result.status, "reconciled");
  assert.deepEqual(result.value.requiredConversionTimes, []);
  assert.deepEqual(result.value.rates, []);
  input.fx.conversionRecords = null;
  assert.equal(buildReviewReconciliation(verifiedInput(input)).fields.fx.status, "partial");
});

test("QQQ numbers state USD price and percent-of-first-close semantics without claiming exact-boundary performance", () => {
  const outcomeMetrics = { generatedAt: endAt, cycleWindow: { startAt, endAt },
    coverage: { source: "verified daily source", adjustType: "forward", candleSources: [{ symbol: "QQQ.US", source: "live", coverageStatus: "complete", fetchedAt: endAt, adjustment: "forward" }] },
    pricePath: { benchmark: "QQQ.US", benchmarkMetrics: { symbol: "QQQ.US", status: "available", firstClose: 100,
      lastClose: 110, periodReturnPercent: 10, firstTradeDate: "2026-08-03", lastTradeDate: "2026-08-31" } } };
  const build = () => buildReviewReconciliation({ cycle, outcomeMetrics, verifiedSourceHashes: verified(outcomeMetrics) }).fields.qqqBenchmark;
  const field = build();
  assert.equal(field.status, "partial");
  assert.equal(field.sourceVerificationStatus, "verified");
  assert.equal(field.verificationStatus, "unverified");
  assert.deepEqual(field.value.returnUnit, { kind: "percent_point", basis: "qqq_first_eligible_close" });
  assert.deepEqual(field.value.priceUnit, { kind: "price", currency: "USD", symbol: "QQQ.US" });
  outcomeMetrics.pricePath.benchmarkMetrics.periodReturnPercent = 0.1;
  assert.equal(build().status, "conflict");
  outcomeMetrics.pricePath.benchmarkMetrics.periodReturnPercent = 10;
  outcomeMetrics.pricePath.benchmarkMetrics.lastTradeDate = "2026-09-01";
  assert.ok(build().reasons.includes("benchmark_trading_dates_outside_cycle"));
  outcomeMetrics.pricePath.benchmarkMetrics.lastTradeDate = "2026-08-31";
  outcomeMetrics.pricePath.benchmarkMetrics.currency = "HKD";
  assert.ok(build().reasons.includes("qqq_price_currency_conflict"));
});

test("metadata summary preserves full hashes and scalar coverage but does not repeat 2000 holdings", () => {
  const input = fullScope();
  input.openingSnapshot.holdings = Array.from({ length: 2000 }, (_, i) => ({ symbol: `PRIVATE-HOLDING-${i}`, quantity: 1, currency: "USD", costBasis: 1 }));
  const full = buildReviewReconciliation(verifiedInput(input));
  const before = JSON.stringify(full);
  const summary = summarizeReviewReconciliation(full);
  assert.equal(summary.projection.kind, "metadata_only");
  assert.equal(summary.projection.fullEvidenceIncluded, false);
  assert.equal(summary.evidenceHash, full.evidenceHash);
  assert.equal(summary.projection.evidenceHashScope, "full_reconciliation_evidence");
  assert.equal(summary.projection.fieldCount, 10);
  assert.equal(summary.fields.openingInventory.projection.originalCounts.holdings, 2000);
  assert.equal(summary.fields.openingInventory.value.cash, 0);
  assert.equal(summary.fields.openingInventory.source[0].id, input.openingSnapshot.snapshotId);
  assert.equal(summary.fields.openingInventory.source[0].observedAt, startAt);
  for (const [key, field] of Object.entries(full.fields)) assert.equal(summary.fields[key].evidenceHash, field.evidenceHash);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE-HOLDING/);
  assert.ok(JSON.stringify(summary).length < before.length / 5);
  assert.equal(JSON.stringify(full), before);
  assert.equal(summarizeReviewReconciliation(null), null);
});

test("metadata summary declares omitted reasons, sources and currency totals without relabeling hashes", () => {
  const full = buildReviewReconciliation(verifiedInput(fullScope()));
  const field = full.fields.fees;
  field.source = Array.from({ length: 20 }, (_, i) => ({ id: `source-${i}`, hash: `hash-${i}`, kind: "broker_statement", observedAt: endAt, verified: true }));
  field.reasons = Array.from({ length: 40 }, (_, i) => `reason-${i}`);
  field.value.observedTotalsByCurrency = Object.fromEntries(["USD", "HKD", "EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "NZD", "SGD", "CNY", "KRW", "SEK"].map((unit) => [unit, 0]));
  const summary = summarizeReviewReconciliation(full, { maxSourcesPerField: 3, maxReasonsPerField: 5 });
  assert.equal(summary.fields.fees.source.length, 3);
  assert.equal(summary.fields.fees.projection.sourceCount, 20);
  assert.equal(summary.fields.fees.projection.omittedSourceCount, 17);
  assert.equal(summary.fields.fees.reasons.length, 5);
  assert.equal(summary.fields.fees.projection.reasonCount, 40);
  assert.equal(summary.fields.fees.projection.omittedReasonCount, 35);
  assert.deepEqual(summary.fields.fees.projection.currencyTotalCoverage.observedTotalsByCurrency,
    { sourceCount: 13, deliveredCount: 12, omittedCount: 1 });
  assert.equal(summary.fields.fees.evidenceHash, field.evidenceHash);
  assert.equal(summary.fields.fees.evidenceHashScope, "full_field_evidence");
  const capped = summarizeReviewReconciliation(full, { maxSourcesPerField: 1000, maxReasonsPerField: 1000 });
  assert.equal(capped.fields.fees.source.length, 16);
  assert.equal(capped.fields.fees.reasons.length, 32);
});
