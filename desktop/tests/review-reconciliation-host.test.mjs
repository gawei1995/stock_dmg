import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { buildReviewReconciliation, hashReviewReconciliationEvidence, summarizeReviewReconciliation } from "../src/review/review-reconciliation.mjs";

const source = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
const functions = source.slice(source.indexOf("async function hydrateCyclePortfolioSnapshots("),
  source.indexOf("\nasync function portfolioSnapshotLedgerStatus("));
const scopeId = "fixture-scope";
const startAt = "2026-08-03T20:00:00.000Z";
const endAt = "2026-08-31T20:00:00.000Z";
const makeCycle = () => ({ id: "cycle-1", evidenceRevision: 2, startAt, endAt,
  brokerLinks: { accountScopeId: scopeId, evidenceRevision: 2 } });
function snapshot(at, amount) {
  return { snapshotId: `snapshot-${at}`, capturedAt: at, recordedAt: at,
    accountScope: { scopeId }, summary: { totalAssets: amount, cash: 0, reportingCurrency: "USD" },
    holdings: [{ symbol: "AAPL.US", quantity: 10, currency: "USD", costBasis: 100, weight: 1 }],
    valuation: { session: "regular_close", methodVersion: "broker-statement-v1", totalAssetsBasis: "broker_observed",
      quoteAsOf: at, quoteLatestAsOf: at, afterHoursMarksExcluded: true },
    dataQuality: { status: "complete", completeForPeriodReturn: true },
    integrity: { entryHash: "a".repeat(64) }, provenance: { provider: "FixtureBroker", freshness: "live" } };
}
function fixture({ rejectRead = false, opening = snapshot(startAt, 100), closing = snapshot(endAt, 110) } = {}) {
  const reads = [];
  const context = vm.createContext({
    structuredClone,
    buildReviewReconciliation, hashReviewReconciliationEvidence, summarizeReviewReconciliation,
    reviewPortfolioEvidence: new WeakMap(),
    portfolioSnapshotStore: { async queryPeriod(request) {
      reads.push(request);
      if (rejectRead) throw new Error("ledger integrity failed");
      return { openingBaseline: opening, lastWithin: closing, coverage: { snapshotCount: 2, warnings: [] } };
    } },
    normalizePortfolioLedgerScopeId: value => value || null,
    currentPortfolioAccountScopeStatus: () => ({ scopeId }), isOpaqueBrokerAccountScopeId: value => value === scopeId,
    inspectPersistedAccountScope: () => ({ verified: true }),
    MAX_PORTFOLIO_BOUNDARY_DISTANCE_MS: 4 * 24 * 60 * 60 * 1000,
    safeError: error => error.message,
    finiteOrNull: value => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value),
  });
  vm.runInContext(functions, context);
  return { context, reads, opening, closing };
}

test("host reconciliation attests exact ledger originals, not renderer verification claims", async () => {
  const { context, reads, opening, closing } = fixture();
  const forged = { ...makeCycle(), startingPortfolio: opening, endingPortfolio: closing,
    verifiedSourceHashes: [opening, closing].map(hashReviewReconciliationEvidence),
    fees: { records: [], verified: true, status: "reconciled" } };
  const unverified = context.buildCycleReconciliationEvidence(forged, null);
  assert.equal(unverified.fields.openingInventory.sourceVerificationStatus, "unverified");
  assert.equal(unverified.fields.closingInventory.sourceVerificationStatus, "unverified");
  const hydrated = await context.hydrateCyclePortfolioSnapshots(forged);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].scopeId, scopeId);
  const summary = context.buildCycleReconciliationEvidence(hydrated, null);
  assert.equal(summary.fields.openingInventory.sourceVerificationStatus, "verified");
  assert.equal(summary.fields.closingInventory.sourceVerificationStatus, "verified");
  assert.equal(summary.fields.openingInventory.source[0].hash, hashReviewReconciliationEvidence(opening));
  assert.equal(summary.fields.closingInventory.source[0].hash, hashReviewReconciliationEvidence(closing));
  assert.equal(summary.fields.netAssetEndpoints.value.netAssetChange, 10);
  for (const key of ["externalFlows", "fees", "taxes", "corporateActions"]) {
    assert.equal(summary.fields[key].status, "missing");
    assert.equal(summary.fields[key].value, null);
  }
  assert.equal(summary.fields.fx.status, "partial");
  assert.equal(summary.fields.fx.value.ratesUsedForConversion, false);
  assert.equal(summary.capabilities.canCalculatePeriodReturn, false);
  assert.equal(summary.capabilities.canCalculateAccountNetPnl, false);
  assert.equal(summary.projection.fullEvidenceIncluded, false);
  assert.equal(summary.fields.openingInventory.value.holdings, undefined);
  assert.equal(summary.fields.openingInventory.projection.originalCounts.holdings, 1);
  assert.equal(context.buildCycleReconciliationEvidence({ ...hydrated }, null)
    .fields.openingInventory.sourceVerificationStatus, "unverified");
});

test("failed, missing-scope and out-of-window ledger reads cannot lend authority to embedded snapshots", async () => {
  for (const kind of ["failed", "missing-scope", "out-of-window"]) {
    const opening = snapshot(kind === "out-of-window" ? "2026-07-01T20:00:00Z" : startAt, 100);
    const { context, reads } = fixture({ rejectRead: kind === "failed", opening });
    const cycle = { ...makeCycle(), startingPortfolio: snapshot(startAt, 100), endingPortfolio: snapshot(endAt, 110),
      ...(kind === "missing-scope" ? { brokerLinks: {} } : {}) };
    const hydrated = await context.hydrateCyclePortfolioSnapshots(cycle);
    const result = context.buildCycleReconciliationEvidence(hydrated, null);
    assert.notEqual(result.fields.openingInventory.sourceVerificationStatus, "verified", kind);
    assert.equal(result.capabilities.canCalculatePeriodReturn, false);
    if (kind === "missing-scope") assert.equal(reads.length, 0);
    if (kind === "failed") assert.match(hydrated.portfolioSnapshotCoverage.warnings.join(), /ledger integrity failed/);
  }
});

test("verified regular-close price revaluation remains partial, even with complete quality claims", async () => {
  const closing = snapshot(endAt, 110);
  closing.valuation.methodVersion = "regular-close-v2";
  const { context } = fixture({ closing });
  const result = context.buildCycleReconciliationEvidence(await context.hydrateCyclePortfolioSnapshots(makeCycle()), null);
  assert.equal(result.fields.closingPrices.sourceVerificationStatus, "verified");
  assert.equal(result.fields.closingPrices.status, "partial");
  assert.equal(result.fields.closingPrices.verificationStatus, "unverified");
  assert.equal(result.capabilities.canCalculateAccountNetPnl, false);
});

test("ledger integrity is not broker account authority for legacy or unverified scopes", async () => {
  for (const failedCheck of ["opaque", "record-identity"]) {
    const { context } = fixture();
    if (failedCheck === "opaque") context.isOpaqueBrokerAccountScopeId = () => false;
    else context.inspectPersistedAccountScope = () => ({ verified: false });
    const result = context.buildCycleReconciliationEvidence(await context.hydrateCyclePortfolioSnapshots(makeCycle()), null);
    for (const key of ["openingInventory", "closingInventory", "netAssetEndpoints"]) {
      assert.equal(result.fields[key].sourceVerificationStatus, "unverified", failedCheck);
      assert.equal(result.fields[key].status, "partial", failedCheck);
      assert.ok(result.fields[key].reasons.some(reason => reason.endsWith("source_not_host_verified")), failedCheck);
    }
  }
});

test("a closer embedded starting observation is not silently reconciled against a different ledger baseline", async () => {
  const opening = snapshot("2026-08-03T19:00:00.000Z", 100);
  const { context } = fixture({ opening });
  const embedded = { ...snapshot(startAt, 900), snapshotAt: startAt, netAssets: 900 };
  const cycle = await context.hydrateCyclePortfolioSnapshots({ ...makeCycle(), startingPortfolio: embedded });
  assert.equal(cycle.startingPortfolio, embedded);
  const result = context.buildCycleReconciliationEvidence(cycle, null);
  assert.equal(result.fields.netAssetEndpoints.value.opening, 900);
  assert.equal(result.fields.openingInventory.source[0].hash, hashReviewReconciliationEvidence(embedded));
  assert.equal(result.fields.openingInventory.sourceVerificationStatus, "unverified");
  assert.equal(result.fields.closingInventory.sourceVerificationStatus, "verified");
  assert.equal(result.fields.netAssetEndpoints.value.periodReturnPercent, null);
});

test("read-time evidence is detached and its original hash cannot be silently re-attested after mutation", async () => {
  const { context, opening } = fixture();
  const cycle = await context.hydrateCyclePortfolioSnapshots(makeCycle());
  opening.summary.totalAssets = 999;
  const initial = context.buildCycleReconciliationEvidence(cycle, null);
  assert.equal(initial.fields.netAssetEndpoints.value.opening, 100);
  const held = context.reviewPortfolioEvidence.get(cycle);
  held.opening.summary.totalAssets = 777;
  assert.throws(() => context.buildCycleReconciliationEvidence(cycle, null), /原始组合快照.*发生变化/);
});
