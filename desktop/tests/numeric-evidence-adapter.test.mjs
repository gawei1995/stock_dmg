import assert from "node:assert/strict";
import test from "node:test";

import { buildCoreNumericEvidence } from "../src/engine/numeric-evidence-adapter.mjs";
import { validateNumericEvidence } from "../src/engine/numeric-evidence.mjs";

function fixture() {
  const syncedAt = "2026-08-31T21:01:00.000Z";
  return {
    portfolio: {
      status: "live",
      syncedAt,
      freshness: { freshForSizing: true, ageMs: 1_000 },
      account: {
        baseCurrency: "USD",
        netAssets: 100_000,
        totalCash: 20_000,
        buyPower: 50_000,
      },
      totals: {
        cashRatio: 20,
        positionsGrossMarketValueBase: 80_000,
      },
      dataQuality: { valuationComplete: true },
    },
    target: { symbol: "AAPL.US", currency: "USD" },
    technical: {
      lastPrice: 230.5,
      asOf: "2026-08-31T20:00:00.000Z",
      asOfTradingDate: "2026-08-31",
      dailySequence: { methodVersion: "daily-sequence-v1" },
      marketData: {
        fetchedAt: syncedAt,
        cacheAgeMs: 1_000,
        freshForResearch: true,
        freshForDecision: true,
        freshForSizing: true,
        reasonCodes: [],
      },
    },
    risk: { riskBudgetPercent: 0.8, grossExposurePercent: 80 },
  };
}

test("core numeric package exposes auditable account, market and risk facts", () => {
  const result = buildCoreNumericEvidence(fixture());
  assert.equal(result.packageVersion, "core-numeric-evidence/v1");
  assert.equal(result.status, "complete");
  assert.equal(result.factCount, 8);
  assert.equal(result.knownCount, 8);
  result.facts.forEach(validateNumericEvidence);
  const cashRatio = result.facts.find((fact) => fact.metric === "portfolio.cash_ratio_percent");
  assert.equal(cashRatio.value, "20");
  assert.equal(cashRatio.unit.kind, "percent_point");
  assert.equal(cashRatio.provenance.inputRefs.length, 2);
  const price = result.facts.find((fact) => fact.metric === "market.last_completed_close");
  assert.equal(price.value, "230.5");
  assert.equal(price.asOf.tradingDate, "2026-08-31");
  const gross = result.facts.find((fact) => fact.metric === "portfolio.positions_gross_market_value");
  assert.equal(gross.value, "80000");
  assert.equal(gross.display.label, "持仓毛市值");
  assert.equal(result.facts.some((fact) => fact.metric === "portfolio.positions_gross_notional"), false);
});

test("option market-value facts retain premium qualifications even when Delta coverage exists elsewhere", () => {
  const input = fixture();
  input.portfolio.positions = [{ instrumentType: "option" }];
  input.risk.derivativeExposureComplete = true;
  const complete = buildCoreNumericEvidence(input);
  const gross = complete.facts.find((fact) => fact.metric === "portfolio.positions_gross_market_value");
  const exposure = complete.facts.find((fact) => fact.metric === "portfolio.gross_exposure_percent");
  assert.equal(gross.quality.complete, true); // complete valuation, not Delta exposure
  for (const fact of [gross, exposure]) {
    assert.match(fact.display.label, /权利金.*非 Delta/);
    assert.deepEqual(fact.quality.reasonCodes, ["includes_option_premium_market_value", "not_delta_or_underlying_notional_exposure"]);
  }
  for (const coverage of [false, undefined]) {
    input.risk.derivativeExposureComplete = coverage;
    const incomplete = buildCoreNumericEvidence(input);
    assert.equal(incomplete.status, "partial");
    for (const metric of ["portfolio.positions_gross_market_value", "portfolio.gross_exposure_percent"]) {
      const fact = incomplete.facts.find((row) => row.metric === metric);
      assert.equal(fact.availability, "known");
      assert.equal(fact.quality.complete, false);
      assert.ok(fact.quality.reasonCodes.includes("derivative_risk_exposure_incomplete"));
    }
  }
});

test("missing values stay unknown and never become numeric zero", () => {
  const input = fixture();
  input.portfolio.account.buyPower = null;
  input.portfolio.account.totalCash = null;
  input.portfolio.totals.cashRatio = null;
  const result = buildCoreNumericEvidence(input);
  const buyPower = result.facts.find((fact) => fact.metric === "portfolio.buy_power");
  const cashRatio = result.facts.find((fact) => fact.metric === "portfolio.cash_ratio_percent");
  assert.equal(result.status, "partial");
  assert.equal(buyPower.availability, "unknown");
  assert.equal(buyPower.value, null);
  assert.equal(cashRatio.availability, "unknown");
  assert.equal(cashRatio.value, null);
});

test("missing source timestamps use the assembly time only as a degraded placeholder", () => {
  const input = fixture();
  delete input.portfolio.syncedAt;
  delete input.technical.asOf;
  delete input.technical.marketData.fetchedAt;
  input.now = () => new Date("2026-09-01T12:00:00.000Z");

  const result = buildCoreNumericEvidence(input);
  const netAssets = result.facts.find((fact) => fact.metric === "portfolio.net_assets");
  const close = result.facts.find((fact) => fact.metric === "market.last_completed_close");

  assert.equal(result.status, "partial");
  assert.equal(netAssets.asOf.effectiveAt, "2026-09-01T12:00:00.000Z");
  assert.equal(netAssets.quality.freshness, "unknown");
  assert.equal(netAssets.quality.complete, false);
  assert.ok(netAssets.quality.reasonCodes.includes("source_timestamp_missing"));
  assert.equal(close.quality.freshness, "unknown");
  assert.equal(close.quality.complete, false);
  assert.ok(close.quality.reasonCodes.includes("source_timestamp_missing"));
});
