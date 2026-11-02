import { createHash } from "node:crypto";

export const REVIEW_RECONCILIATION_SCHEMA = "review-reconciliation/v1";
const VERIFIED_SOURCE_KINDS = new Set(["broker_statement", "broker_api", "snapshot_ledger", "market_data", "deterministic_host"]);

/**
 * Pure evidence projection, not a performance calculator or an attestation API.
 * verifiedSourceHashes must be constructed by the host AFTER verifying original
 * ledger/statement provenance; never forward a renderer's claims into this list.
 * A hash alone checks identity, not authenticity. Notes cannot attest evidence.
 * FX originals additionally require coverage.conversionRecordsComplete and a
 * conversionRecords array (explicit [] proves no conversions only with complete
 * scoped originals). Each record carries id/occurredAt/fromCurrency/toCurrency/
 * fromAmount/toAmount/rateId; rates carry id/base/quote/rate/asOf/source and
 * direction="quote_per_base". All currency/time requirements are cross-checked.
 */
export function buildReviewReconciliation({ cycle = {}, openingSnapshot = cycle.startingPortfolio ?? null,
  closingSnapshot = cycle.endingPortfolio ?? null, externalFlows = null, fees = null, taxes = null,
  corporateActions = null, fx = null, outcomeMetrics = null, verifiedSourceHashes = [], notes = null } = {}) {
  const window = { startAt: iso(cycle.startAt), endAt: iso(cycle.endAt) };
  const scope = text(cycle.brokerLinks?.accountScopeId ?? cycle.accountScopeId);
  const validWindow = Boolean(window.startAt && window.endAt && window.startAt < window.endAt);
  const verified = new Set((Array.isArray(verifiedSourceHashes) ? verifiedSourceHashes : [])
    .filter((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)));
  const context = { window, scope, validWindow, verified,
    monetaryRecords: [externalFlows, fees, taxes, corporateActions].flatMap((item) => Array.isArray(item?.records) ? item.records : []) };
  const opening = endpoint(openingSnapshot, "opening", context);
  const closing = endpoint(closingSnapshot, "closing", context);
  const fields = {
    openingInventory: opening.inventory,
    closingInventory: closing.inventory,
    closingPrices: closing.prices,
    netAssetEndpoints: endpointValues(opening, closing, context),
    externalFlows: ledger(externalFlows, "externalFlows", context),
    fees: ledger(fees, "fees", context),
    taxes: ledger(taxes, "taxes", context),
    corporateActions: ledger(corporateActions, "corporateActions", context),
  };
  fields.fx = fxField(fx, openingSnapshot, closingSnapshot, { ...context, requiredFields: fields });
  fields.qqqBenchmark = benchmark(outcomeMetrics, context);
  const statuses = Object.values(fields).map((item) => item.status);
  const status = statuses.includes("conflict") ? "conflict"
    : statuses.every((item) => item === "reconciled") ? "reconciled"
      : statuses.every((item) => item === "missing") ? "missing" : "partial";
  const revision = Number(cycle.evidenceRevision ?? cycle.brokerLinks?.evidenceRevision ?? cycle.brokerLinks?.revision);
  const cycleEvidenceRevision = Number.isInteger(revision) && revision > 0 ? revision : null;
  const material = {
    schemaVersion: REVIEW_RECONCILIATION_SCHEMA,
    cycleId: text(cycle.id), cycleEvidenceRevision,
    accountScopeId: scope, window, fields,
  };
  return {
    ...material,
    evidenceHash: hashReviewReconciliationEvidence(material),
    status,
    sourceHashes: [...new Set(Object.values(fields).flatMap((item) => item.source.map((source) => source.hash)).filter(Boolean))].sort(),
    capabilities: {
      canCompareObservedNetAssetEndpoints: fields.netAssetEndpoints.value?.netAssetChange != null,
      reconciliationEvidenceComplete: status === "reconciled",
      canCalculatePeriodReturn: false,
      canCalculateAccountNetPnl: false,
      canCalculatePortfolioAlpha: false,
    },
    limitations: [
      "net_asset_change_is_not_investment_return",
      "evidence_reconciliation_does_not_implement_cash_flow_adjusted_performance",
      "linked_fifo_trade_pnl_is_not_account_net_pnl",
      "qqq_price_path_is_not_portfolio_alpha",
      ...(!validWindow ? ["cycle_window_invalid"] : []),
      ...(!scope ? ["cycle_account_scope_missing"] : []),
    ],
    annotations: { notes: text(notes), evidentiary: false, canUpgradeStatus: false },
  };
}

export function hashReviewReconciliationEvidence(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** Metadata-only view. evidenceHash/field hashes continue to identify the FULL
 * evidence, not this intentionally incomplete projection. Never attest or
 * reconstruct originals from this summary. Limits are explicit in coverage.
 */
export function summarizeReviewReconciliation(value, { maxSourcesPerField = 4, maxReasonsPerField = 8 } = {}) {
  if (!value || value.schemaVersion !== REVIEW_RECONCILIATION_SCHEMA) return null;
  const sourceLimit = boundedLimit(maxSourcesPerField, 4, 16);
  const reasonLimit = boundedLimit(maxReasonsPerField, 8, 32);
  const valueKeys = ["cash", "reportingCurrency", "snapshotId", "inventoryAsOf", "session", "methodVersion",
    "afterHoursMarksExcluded", "totalAssetsBasis", "priceOnlyObservation", "opening", "closing", "currency", "netAssetChange",
    "interpretation", "periodReturnPercent", "openingCash", "closingCash", "sourceRecordCount", "recordCount", "provenNoActivity",
    "provenZero", "cashInventoryEffectsReconciled", "signedAmountConvention", "ratesUsedForConversion", "symbol", "firstTradeDate",
    "lastTradeDate", "firstClose", "lastClose", "observedPriceReturnPercent", "portfolioAlphaPercent", "adjustment"];
  const arrays = ["holdings", "records", "rates", "conversionRecords", "requiredConversionTimes", "observedEndpointRates", "currencies"];
  const fields = Object.fromEntries(Object.entries(value.fields ?? {}).map(([key, item]) => {
    const sources = Array.isArray(item?.source) ? item.source : [];
    const reasons = Array.isArray(item?.reasons) ? item.reasons : [];
    const scalars = item?.value == null ? null : Object.fromEntries(valueKeys.filter((name) => name in item.value)
      .map((name) => [name, scalar(item.value[name])]));
    const originalCounts = Object.fromEntries(arrays.filter((name) => Array.isArray(item?.value?.[name]))
      .map((name) => [name, item.value[name].length]));
    if (Array.isArray(item?.value?.observedEndpointRates)) {
      originalCounts.observedEndpointRateCount = item.value.observedEndpointRates.reduce((sum, row) => sum + (row.rates?.length ?? 0), 0);
    }
    const currencyTotalCoverage = {};
    for (const name of ["observedTotalsByCurrency", "reconciledTotalsByCurrency"]) {
      if (!scalars || !(name in item.value)) continue;
      const totals = item.value[name];
      if (totals == null) { scalars[name] = null; continue; }
      const entries = Object.entries(totals).filter(([unit]) => currency(unit)).sort(([a], [b]) => a.localeCompare(b));
      scalars[name] = Object.fromEntries(entries.slice(0, 12).map(([unit, amount]) => [unit, number(amount)]));
      currencyTotalCoverage[name] = { sourceCount: entries.length, deliveredCount: Math.min(entries.length, 12), omittedCount: Math.max(0, entries.length - 12) };
    }
    for (const name of ["priceUnit", "returnUnit"]) {
      if (scalars && item?.value?.[name]) scalars[name] = Object.fromEntries(["kind", "currency", "symbol", "basis"]
        .filter((part) => part in item.value[name]).map((part) => [part, text(item.value[name][part])]));
    }
    return [key, {
      status: item?.status ?? "missing", observationStatus: item?.observationStatus ?? "missing",
      sourceVerificationStatus: item?.sourceVerificationStatus ?? "unverified", verificationStatus: item?.verificationStatus ?? "unverified",
      evidenceHash: item?.evidenceHash ?? null, evidenceHashScope: "full_field_evidence", value: scalars,
      time: item?.time ?? null,
      source: sources.slice(0, sourceLimit).map((source) => ({ id: source?.id ?? null, hash: source?.hash ?? null,
        kind: source?.kind ?? null, observedAt: source?.observedAt ?? null, verified: source?.verified === true })),
      reasons: reasons.slice(0, reasonLimit),
      projection: { kind: "metadata_only", originalCounts, arraysOmitted: arrays.filter((name) => Array.isArray(item?.value?.[name])), currencyTotalCoverage,
        sourceCount: sources.length, deliveredSourceCount: Math.min(sources.length, sourceLimit), omittedSourceCount: Math.max(0, sources.length - sourceLimit),
        reasonCount: reasons.length, deliveredReasonCount: Math.min(reasons.length, reasonLimit), omittedReasonCount: Math.max(0, reasons.length - reasonLimit) },
    }];
  }));
  return {
    schemaVersion: value.schemaVersion, cycleId: value.cycleId, cycleEvidenceRevision: value.cycleEvidenceRevision,
    accountScopeId: value.accountScopeId, window: value.window, evidenceHash: value.evidenceHash,
    status: value.status, fields, capabilities: value.capabilities, limitations: value.limitations,
    projection: { kind: "metadata_only", fullEvidenceIncluded: false, evidenceHashScope: "full_reconciliation_evidence",
      fieldCount: Object.keys(fields).length, originalFieldHashesPreserved: true, originalSourceHashCount: value.sourceHashes?.length ?? 0 },
  };
}

function endpoint(raw, side, context) {
  const boundary = side === "opening" ? context.window.startAt : context.window.endAt;
  const observedAt = iso(raw?.capturedAt ?? raw?.snapshotAt ?? raw?.syncedAt);
  const source = describe(raw, context, "snapshot_ledger");
  const reasons = [];
  const snapshotScope = text(raw?.accountScope?.scopeId ?? raw?.accountScopeId);
  let conflict = false;
  if (!context.validWindow) { reasons.push("cycle_window_invalid"); conflict = Boolean(raw); }
  if (!context.scope || !snapshotScope) reasons.push("account_scope_unproven");
  else if (context.scope !== snapshotScope) { reasons.push("account_scope_mismatch"); conflict = true; }
  if (!observedAt) reasons.push("inventory_observation_time_missing");
  else if (boundary && observedAt > boundary) { reasons.push("inventory_observed_after_boundary"); conflict = true; }
  else if (boundary && observedAt !== boundary) reasons.push("inventory_not_observed_at_exact_boundary");
  if (!source.verified) reasons.push("source_not_host_verified");
  const rows = Array.isArray(raw?.holdings) ? raw.holdings : Array.isArray(raw?.positions) ? raw.positions : null;
  if (!Array.isArray(raw?.holdings)) reasons.push("original_inventory_rows_missing");
  const holdings = rows?.map((item) => ({ symbol: text(item?.symbol), quantity: number(item?.quantity),
    currency: currency(item?.currency), costBasis: number(item?.costBasis) })) ?? null;
  if (holdings?.some((item) => !item.symbol || item.quantity == null || !item.currency)) reasons.push("inventory_fields_incomplete");
  if (side === "opening" && holdings?.some((item) => item.quantity !== 0 && item.costBasis == null)) reasons.push("opening_cost_inventory_incomplete");
  const cash = number(raw?.summary?.cash ?? raw?.account?.totalCash ?? raw?.cash);
  const reportingCurrency = currency(raw?.summary?.reportingCurrency ?? raw?.baseCurrency ?? raw?.account?.baseCurrency);
  if (cash == null) reasons.push("cash_inventory_missing");
  if (!reportingCurrency) reasons.push("reporting_currency_missing");
  if (raw?.dataQuality?.status !== "complete") reasons.push("snapshot_quality_not_complete");
  const valuation = raw?.valuation ?? raw?.snapshotValuation ?? null;
  const pricesOnly = valuation?.methodVersion === "regular-close-v2";
  if (pricesOnly) reasons.push("regular_close_v2_prices_only_inventory_and_cash_unreconciled");
  if (!valuation) reasons.push("valuation_basis_missing");
  const time = { boundaryAt: boundary, observedAt, priceAsOf: iso(valuation?.quoteAsOf), priceLatestAsOf: iso(valuation?.quoteLatestAsOf) };
  const inventory = field({ holdings, cash,
    reportingCurrency,
    snapshotId: text(raw?.snapshotId), inventoryAsOf: observedAt }, raw, [source], time, reasons, conflict);
  const priceReasons = reasons.filter((reason) => !["opening_cost_inventory_incomplete"].includes(reason));
  if (holdings?.length && (!time.priceAsOf || !time.priceLatestAsOf)) priceReasons.push("price_time_missing");
  if (boundary && [time.priceAsOf, time.priceLatestAsOf].some((at) => at && at > boundary)) {
    priceReasons.push("price_after_boundary"); conflict = true;
  }
  if (time.priceAsOf && time.priceLatestAsOf && time.priceAsOf > time.priceLatestAsOf) {
    priceReasons.push("price_time_range_invalid"); conflict = true;
  }
  if (holdings?.length && boundary && [time.priceAsOf, time.priceLatestAsOf].some((at) => at && at < boundary)) {
    priceReasons.push("prices_not_observed_at_exact_boundary");
  }
  const prices = field(valuation ? { session: text(valuation.session), methodVersion: text(valuation.methodVersion),
    afterHoursMarksExcluded: valuation.afterHoursMarksExcluded === true,
    totalAssetsBasis: text(valuation.totalAssetsBasis), priceOnlyObservation: pricesOnly } : null,
  raw, [source], time, priceReasons, conflict);
  return { inventory, prices, raw, source, time, reasons: [...new Set([...reasons, ...priceReasons])], conflict, netAssets: number(raw?.summary?.totalAssets
    ?? raw?.netAssets ?? raw?.account?.netAssets), currency: currency(raw?.summary?.reportingCurrency ?? raw?.baseCurrency ?? raw?.account?.baseCurrency) };
}

function endpointValues(opening, closing, context) {
  const sources = [opening.source, closing.source];
  const reasons = [...opening.reasons.map((item) => `opening:${item}`), ...closing.reasons.map((item) => `closing:${item}`)];
  let conflict = opening.conflict || closing.conflict;
  if (opening.netAssets == null || closing.netAssets == null) reasons.push("net_asset_endpoint_missing");
  if (!opening.currency || !closing.currency) reasons.push("reporting_currency_missing");
  else if (opening.currency !== closing.currency) { reasons.push("reporting_currency_mismatch"); conflict = true; }
  if (opening.time.observedAt && closing.time.observedAt && opening.time.observedAt >= closing.time.observedAt) {
    reasons.push("endpoint_times_not_increasing"); conflict = true;
  }
  const comparable = !conflict && opening.netAssets != null && closing.netAssets != null
    && opening.currency && opening.currency === closing.currency;
  return field({ opening: opening.netAssets, closing: closing.netAssets, currency: comparable ? opening.currency : null,
    netAssetChange: comparable ? closing.netAssets - opening.netAssets : null,
    interpretation: "observed_net_asset_difference_not_return", periodReturnPercent: null,
    openingCash: opening.inventory.value?.cash ?? null, closingCash: closing.inventory.value?.cash ?? null },
  opening.raw || closing.raw, sources, { ...context.window, openingObservedAt: opening.time.observedAt,
    closingObservedAt: closing.time.observedAt }, reasons, conflict);
}

function ledger(raw, kind, context) {
  const source = describe(raw, context);
  const checks = envelopeChecks(raw, source, context);
  const { reasons } = checks;
  const rows = Array.isArray(raw?.records) ? raw.records : null;
  if (!rows) reasons.push("original_records_missing");
  const ids = new Set();
  const selected = [];
  for (const row of rows ?? []) {
    const id = text(row?.id);
    const at = iso(row?.occurredAt ?? row?.effectiveAt);
    if (!id) reasons.push("record_id_missing");
    else if (ids.has(id)) { reasons.push("duplicate_record_id"); checks.conflict = true; }
    ids.add(id);
    if (!at) reasons.push("record_time_missing");
    if (row?.accountScopeId && row.accountScopeId !== context.scope) { reasons.push("record_account_scope_mismatch"); checks.conflict = true; }
    if (at && checks.coverage.startAt && checks.coverage.endAt && (at < checks.coverage.startAt || at > checks.coverage.endAt)) {
      reasons.push("record_outside_declared_coverage"); checks.conflict = true;
    }
    const amount = number(row?.amount);
    const unit = currency(row?.currency);
    const type = text(row?.kind);
    if (kind === "corporateActions") {
      if (!type || !text(row?.symbol)) reasons.push("corporate_action_fields_incomplete");
      if (type === "split" && !(number(row.ratio) > 0)) reasons.push("split_ratio_missing");
      if (type === "dividend" && (amount == null || !unit)) reasons.push("dividend_amount_or_currency_missing");
      if (type && !["split", "dividend", "merger", "spinoff", "return_of_capital"].includes(type)) reasons.push("corporate_action_kind_unclassified");
    } else if (amount == null || !unit) reasons.push("amount_or_currency_missing");
    if (kind === "externalFlows" && !["deposit", "withdrawal", "transfer_in", "transfer_out"].includes(type)) reasons.push("external_flow_direction_missing");
    if (kind === "externalFlows" && amount != null && ((["deposit", "transfer_in"].includes(type) && amount < 0)
      || (["withdrawal", "transfer_out"].includes(type) && amount > 0))) {
      reasons.push("external_flow_sign_conflict"); checks.conflict = true;
    }
    if (at && context.validWindow && at >= context.window.startAt && at <= context.window.endAt) {
      selected.push({ id, occurredAt: at, amount, currency: unit, kind: type, symbol: text(row.symbol), ratio: number(row.ratio) });
    }
  }
  const sums = {};
  for (const row of selected) if (row.amount != null && row.currency) sums[row.currency] = (sums[row.currency] ?? 0) + row.amount;
  if (Object.values(sums).some((value) => !Number.isFinite(value))) {
    reasons.push("amount_aggregate_out_of_range"); checks.conflict = true;
    for (const unit of Object.keys(sums)) if (!Number.isFinite(sums[unit])) sums[unit] = null;
  }
  // Event existence is not proof that the broker applied split inventory,
  // dividend cash/tax, merger or spin-off basis effects to this account.
  // No effect-accounting engine exists here; a row's boolean cannot attest it.
  if (kind === "corporateActions" && selected.length) reasons.push("corporate_action_cash_inventory_effects_unreconciled");
  const canProveEmpty = Boolean(raw && rows && !selected.length && !reasons.length && !checks.conflict);
  return field(rows ? { sourceRecordCount: rows.length, recordCount: selected.length, records: selected, observedTotalsByCurrency: sums,
    reconciledTotalsByCurrency: !reasons.length && !checks.conflict ? sums : null,
    provenNoActivity: canProveEmpty, provenZero: kind !== "corporateActions" && canProveEmpty ? 0 : null,
    ...(kind === "corporateActions" ? { cashInventoryEffectsReconciled: canProveEmpty } : {}),
    signedAmountConvention: kind === "externalFlows" ? "inflow_positive_outflow_negative" : "provider_signed_amount" } : null,
  raw, [source], { ...checks.coverage, observedAt: iso(raw?.observedAt) }, reasons, checks.conflict);
}

function fxField(raw, opening, closing, context) {
  const source = describe(raw, context);
  const checks = envelopeChecks(raw, source, context);
  const observed = [opening, closing].filter(Boolean).map((item) => ({ snapshotId: text(item.snapshotId),
    reportingCurrency: currency(item?.summary?.reportingCurrency ?? item?.baseCurrency),
    status: text(item?.fx?.status), rates: Array.isArray(item?.fx?.rates) ? item.fx.rates.map((rate) => ({
      base: currency(rate.base), quote: currency(rate.quote), rate: number(rate.rate), asOf: iso(rate.asOf), source: text(rate.source),
    })) : [] }));
  const rates = Array.isArray(raw?.rates) ? raw.rates.map((rate) => ({ id: text(rate?.id), base: currency(rate?.base), quote: currency(rate?.quote),
    rate: number(rate?.rate), asOf: iso(rate?.asOf), source: text(rate?.source), direction: text(rate?.direction) })) : null;
  const currencies = Array.isArray(raw?.currencies) ? [...new Set(raw.currencies.map(currency).filter(Boolean))].sort() : [];
  const reporting = currency(raw?.reportingCurrency);
  if (!reporting || !currencies.length) checks.reasons.push("complete_currency_scope_missing");
  if (!rates) checks.reasons.push("period_fx_evidence_missing");
  for (const rate of rates ?? []) {
    if (!rate.id || !rate.base || !rate.quote || !(rate.rate > 0) || !rate.asOf || !rate.source) checks.reasons.push("fx_rate_fields_incomplete");
    if (rate.direction !== "quote_per_base") checks.reasons.push("fx_rate_direction_unproven");
    if (rate.base && rate.base === rate.quote) { checks.reasons.push("fx_currency_pair_invalid"); checks.conflict = true; }
    if (rate.asOf && context.window.endAt && rate.asOf > context.window.endAt) { checks.reasons.push("fx_rate_after_cycle"); checks.conflict = true; }
  }
  if (currencies.some((item) => item !== reporting && !(rates ?? []).some((rate) =>
    (rate.base === item && rate.quote === reporting) || (rate.quote === item && rate.base === reporting)))) checks.reasons.push("currency_pair_missing");
  const foreign = currencies.filter((item) => item !== reporting);
  const requirements = foreign.flatMap((unit) => [context.window.startAt, context.window.endAt]
    .filter(Boolean).map((at) => ({ currency: unit, at, source: "endpoint" })));
  // The declared currency/time universe is insufficient on its own. Reconcile
  // it against verified original inventory and monetary ledgers, not flags.
  for (const key of ["openingInventory", "closingInventory", "externalFlows", "fees", "taxes", "corporateActions"]) {
    if (context.requiredFields?.[key]?.status !== "reconciled") checks.reasons.push(`fx_requirement_scope_incomplete:${key}`);
  }
  for (const [side, item] of [["opening", opening], ["closing", closing]]) {
    if (!item) continue;
    const endpointCurrency = currency(item?.summary?.reportingCurrency ?? item?.baseCurrency ?? item?.account?.baseCurrency);
    if (reporting && endpointCurrency && reporting !== endpointCurrency) {
      checks.reasons.push("fx_reporting_currency_endpoint_mismatch"); checks.conflict = true;
    }
    const rows = [...(Array.isArray(item.holdings) ? item.holdings : []),
      ...(Array.isArray(item.cashBalances) ? item.cashBalances : []),
      ...(Array.isArray(item.account?.cashInfos) ? item.account.cashInfos : [])];
    for (const row of rows) {
      const unit = currency(row?.currency);
      if (unit && !currencies.includes(unit)) checks.reasons.push("observed_currency_missing_from_fx_scope");
      if (unit && unit !== reporting) requirements.push({ currency: unit,
        at: side === "opening" ? context.window.startAt : context.window.endAt, source: `${side}_inventory` });
    }
  }
  for (const row of context.monetaryRecords) {
    const at = iso(row?.occurredAt ?? row?.effectiveAt), unit = currency(row?.currency);
    if (unit && unit !== reporting && at && context.validWindow && at >= context.window.startAt && at <= context.window.endAt) {
      if (!currencies.includes(unit)) checks.reasons.push("observed_currency_missing_from_fx_scope");
      requirements.push({ currency: unit, at, source: "monetary_record", recordId: text(row?.id) });
    }
  }
  const conversions = Array.isArray(raw?.conversionRecords) ? raw.conversionRecords.map((row) => ({
    id: text(row?.id), occurredAt: iso(row?.occurredAt), fromCurrency: currency(row?.fromCurrency), toCurrency: currency(row?.toCurrency),
    fromAmount: number(row?.fromAmount), toAmount: number(row?.toAmount), rateId: text(row?.rateId), accountScopeId: text(row?.accountScopeId),
  })) : null;
  if (!conversions || raw?.coverage?.conversionRecordsComplete !== true) checks.reasons.push("original_conversion_records_coverage_unproven");
  const conversionIds = new Set();
  for (const row of conversions ?? []) {
    if (!row.id || !row.occurredAt || !row.fromCurrency || !row.toCurrency || row.fromAmount == null || row.toAmount == null || !row.rateId) {
      checks.reasons.push("conversion_record_fields_incomplete");
    }
    if (row.id && conversionIds.has(row.id)) { checks.reasons.push("duplicate_conversion_record_id"); checks.conflict = true; }
    conversionIds.add(row.id);
    if (row.accountScopeId && row.accountScopeId !== context.scope) { checks.reasons.push("conversion_record_account_scope_mismatch"); checks.conflict = true; }
    if (row.occurredAt && checks.coverage.startAt && checks.coverage.endAt
      && (row.occurredAt < checks.coverage.startAt || row.occurredAt > checks.coverage.endAt)) {
      checks.reasons.push("conversion_record_outside_declared_coverage"); checks.conflict = true;
    }
    for (const unit of [row.fromCurrency, row.toCurrency].filter(Boolean)) {
      if (!currencies.includes(unit)) checks.reasons.push("observed_currency_missing_from_fx_scope");
      if (unit !== reporting && row.occurredAt && context.validWindow
        && row.occurredAt >= context.window.startAt && row.occurredAt <= context.window.endAt) {
        requirements.push({ currency: unit, at: row.occurredAt, source: "conversion_record", recordId: row.id });
      }
    }
    const matched = (rates ?? []).filter((rate) => rate.id === row.rateId);
    const rate = matched.length === 1 ? matched[0] : null;
    const direct = rate?.base === row.fromCurrency && rate?.quote === row.toCurrency;
    const inverse = rate?.quote === row.fromCurrency && rate?.base === row.toCurrency;
    if (!rate || rate.asOf !== row.occurredAt || rate.direction !== "quote_per_base" || !(rate.rate > 0) || (!direct && !inverse)) {
      checks.reasons.push("conversion_rate_reference_unverified");
    } else if (row.fromAmount != null && row.toAmount != null) {
      const expected = direct ? row.fromAmount * rate.rate : row.fromAmount / rate.rate;
      if (!Number.isFinite(expected) || Math.abs(expected - row.toAmount) > Math.max(1e-8, Math.abs(expected) * 1e-10)) {
        checks.reasons.push("conversion_amount_arithmetic_conflict"); checks.conflict = true;
      }
    }
  }
  if (requirements.some((requirement) => !(rates ?? []).some((rate) => rate.asOf === requirement.at
    && rate.rate > 0 && rate.source && rate.direction === "quote_per_base"
    && ((rate.base === requirement.currency && rate.quote === reporting)
      || (rate.quote === requirement.currency && rate.base === reporting))))) checks.reasons.push("transaction_and_endpoint_fx_times_incomplete");
  const duplicateRates = new Map();
  const reciprocalRates = new Map();
  const rateIds = new Set();
  for (const rate of rates ?? []) {
    if (rate.id && rateIds.has(rate.id)) { checks.reasons.push("duplicate_fx_rate_id"); checks.conflict = true; }
    rateIds.add(rate.id);
    const key = `${rate.base}/${rate.quote}/${rate.asOf}`;
    if (duplicateRates.has(key) && duplicateRates.get(key) !== rate.rate) {
      checks.reasons.push("fx_rate_conflict_at_same_time"); checks.conflict = true;
    }
    duplicateRates.set(key, rate.rate);
    if (rate.base && rate.quote && rate.rate > 0 && rate.asOf) {
      const [base, quote] = [rate.base, rate.quote].sort();
      const pairKey = `${base}/${quote}/${rate.asOf}`;
      const normalized = rate.base === base ? rate.rate : 1 / rate.rate;
      const previous = reciprocalRates.get(pairKey);
      if (!Number.isFinite(normalized) || (previous != null
        && Math.abs(previous - normalized) > Math.max(1e-10, Math.abs(previous) * 1e-10))) {
        checks.reasons.push("fx_reciprocal_rate_conflict"); checks.conflict = true;
      }
      reciprocalRates.set(pairKey, normalized);
    }
  }
  return field(raw || observed.length ? { reportingCurrency: reporting, currencies, rates, conversionRecords: conversions,
    requiredConversionTimes: requirements, observedEndpointRates: observed, ratesUsedForConversion: false } : null,
  raw || opening || closing, [source, ...[opening, closing].filter(Boolean).map((item) => describe(item, context, "snapshot_ledger"))],
  { ...checks.coverage, observedAt: iso(raw?.observedAt) }, checks.reasons, checks.conflict);
}

function benchmark(raw, context) {
  const metric = raw?.pricePath?.benchmarkMetrics;
  const source = describe(raw, context, "deterministic_host");
  const reasons = [];
  let conflict = false;
  const symbol = text(raw?.pricePath?.benchmark ?? metric?.symbol)?.toUpperCase();
  if (!context.validWindow) { reasons.push("cycle_window_invalid"); conflict = Boolean(raw); }
  if (!metric) reasons.push("qqq_benchmark_missing");
  if (!symbol) reasons.push("benchmark_symbol_missing");
  if (symbol && !["QQQ", "QQQ.US"].includes(symbol)) { reasons.push("benchmark_is_not_qqq"); conflict = true; }
  if (!source.verified) reasons.push("source_not_host_verified");
  const coverage = raw?.coverage?.candleSources?.find((item) => ["QQQ", "QQQ.US"].includes(String(item.symbol).toUpperCase()));
  if (!coverage?.source || !iso(coverage?.fetchedAt)) reasons.push("benchmark_source_or_fetch_time_missing");
  if (coverage?.partial === true || coverage?.source === "persistent_fallback" || coverage?.coverageStatus !== "complete") reasons.push("benchmark_coverage_incomplete");
  if (iso(raw?.cycleWindow?.startAt) !== context.window.startAt || iso(raw?.cycleWindow?.endAt) !== context.window.endAt) reasons.push("benchmark_window_mismatch");
  const first = number(metric?.firstClose), last = number(metric?.lastClose);
  const calculated = first > 0 && last > 0 ? number(((last / first) - 1) * 100) : null;
  const reported = number(metric?.periodReturnPercent);
  if (calculated == null) reasons.push("benchmark_endpoint_prices_missing");
  if (reported != null && calculated != null && Math.abs(reported - calculated) > 0.00011) { reasons.push("benchmark_return_arithmetic_conflict"); conflict = true; }
  if (metric?.status !== "available") reasons.push("benchmark_path_unavailable");
  const firstTradeDate = tradingDate(metric?.firstTradeDate), lastTradeDate = tradingDate(metric?.lastTradeDate);
  if (!firstTradeDate || !lastTradeDate) reasons.push("benchmark_trading_dates_missing");
  if (firstTradeDate && lastTradeDate && (firstTradeDate > lastTradeDate
    || (context.window.startAt && firstTradeDate < usTradingDate(context.window.startAt))
    || (context.window.endAt && lastTradeDate > usTradingDate(context.window.endAt)))) {
    reasons.push("benchmark_trading_dates_outside_cycle"); conflict = true;
  }
  const adjustment = text(coverage?.adjustment ?? raw?.coverage?.adjustType);
  if (!adjustment) reasons.push("benchmark_adjustment_basis_missing");
  if (metric?.currency && currency(metric.currency) !== "USD") { reasons.push("qqq_price_currency_conflict"); conflict = true; }
  // Existing outcome metrics describe the first/last eligible daily closes,
  // not valuations at exact portfolio cash-flow boundaries. Do not silently
  // call a shortened price interval a reconciled full-cycle benchmark.
  reasons.push("daily_close_interval_not_exact_portfolio_boundary_benchmark");
  return field(metric ? { symbol, firstTradeDate, lastTradeDate,
    firstClose: first, lastClose: last, observedPriceReturnPercent: calculated, currency: "USD",
    priceUnit: { kind: "price", currency: "USD", symbol: "QQQ.US" },
    returnUnit: { kind: "percent_point", basis: "qqq_first_eligible_close" },
    interpretation: "qqq_eligible_daily_close_price_change_not_portfolio_alpha",
    portfolioAlphaPercent: null, adjustment } : null,
  metric, [source], { ...context.window, generatedAt: iso(raw?.generatedAt), fetchedAt: iso(coverage?.fetchedAt) }, reasons, conflict);
}

function envelopeChecks(raw, source, context) {
  const coverage = { startAt: iso(raw?.coverage?.startAt), endAt: iso(raw?.coverage?.endAt) };
  const reasons = [];
  let conflict = false;
  if (!context.validWindow) { reasons.push("cycle_window_invalid"); conflict = Boolean(raw); }
  if (!context.scope || !text(raw?.accountScopeId)) reasons.push("account_scope_unproven");
  else if (raw.accountScopeId !== context.scope) { reasons.push("account_scope_mismatch"); conflict = true; }
  if (!source.verified) reasons.push("source_not_host_verified");
  if (!source.id) reasons.push("original_evidence_id_missing");
  const observedAt = iso(raw?.observedAt);
  if (!observedAt) reasons.push("source_observation_time_missing");
  if (observedAt && coverage.endAt && observedAt < coverage.endAt) { reasons.push("source_observed_before_coverage_end"); conflict = true; }
  if (raw?.coverage?.complete !== true || !coverage.startAt || !coverage.endAt
    || coverage.startAt > context.window.startAt || coverage.endAt < context.window.endAt) reasons.push("full_cycle_coverage_unproven");
  if (coverage.startAt && coverage.endAt && coverage.startAt > coverage.endAt) { reasons.push("coverage_window_invalid"); conflict = true; }
  return { reasons, conflict, coverage };
}

function describe(raw, context, defaultKind = null) {
  if (!raw) return { id: null, label: null, kind: null, hash: null, observedAt: null, verified: false };
  const hash = hashReviewReconciliationEvidence(raw);
  const kind = text(raw.sourceKind ?? (raw.provenance?.freshness === "manual" ? "manual" : defaultKind));
  const id = text(raw.evidenceId ?? raw.snapshotId ?? raw.source?.recordId);
  const label = text(typeof raw.source === "string" ? raw.source : raw.source?.provider)
    ?? text(raw.provenance?.provider ?? raw.coverage?.source);
  const observedAt = iso(raw.observedAt ?? raw.capturedAt ?? raw.snapshotAt ?? raw.syncedAt ?? raw.generatedAt);
  return { id, label, kind, hash, observedAt, verified: Boolean(context.verified.has(hash) && VERIFIED_SOURCE_KINDS.has(kind)
    && raw?.provenance?.freshness !== "manual" && raw?.manual !== true
    && label && (id || kind === "deterministic_host")) };
}

function field(value, raw, source, time, reasons, conflict = false) {
  const unique = [...new Set(reasons)];
  const observed = Boolean(raw);
  const status = conflict ? "conflict" : !observed ? "missing" : unique.length ? "partial" : "reconciled";
  const originals = source.filter((item) => item.hash);
  const sourceVerified = observed && originals.length > 0 && originals.every((item) => item.verified);
  const material = { value: observed ? value : null, source: source.filter((item) => item.hash), time, status,
    observationStatus: observed ? "observed" : "missing",
    sourceVerificationStatus: sourceVerified ? "verified" : "unverified",
    verificationStatus: sourceVerified && status === "reconciled" ? "verified" : "unverified",
    reasons: observed ? unique : [...new Set(["source_missing", ...unique])] };
  return { ...material, evidenceHash: hashReviewReconciliationEvidence(material) };
}

function text(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function iso(value) { const parsed = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null; }
function currency(value) { const normalized = text(value)?.toUpperCase(); return /^[A-Z]{3}$/.test(normalized ?? "") ? normalized : null; }
function scalar(value) { return value == null || typeof value === "boolean" || typeof value === "string" ? value
  : typeof value === "number" && Number.isFinite(value) ? value : null; }
function boundedLimit(value, fallback, maximum) { return Number.isInteger(value) && value >= 0 ? Math.min(value, maximum) : fallback; }
function tradingDate(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && iso(`${value}T00:00:00.000Z`)?.slice(0, 10) === value ? value : null; }
function usTradingDate(value) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)); }
function number(value) { if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null; }
function canonical(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}
