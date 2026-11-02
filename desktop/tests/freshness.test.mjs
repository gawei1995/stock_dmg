import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PORTFOLIO_FRESHNESS_MAX_AGE_MS,
  portfolioFreshness,
  portfolioSnapshotAgeMs,
  portfolioValuationGateFreshness,
  withPortfolioFreshness,
} from "../src/data/freshness.mjs";
import { assessPortfolioValuationGate } from "../src/data/portfolio-valuation-gate.mjs";

const NOW = Date.parse("2026-07-26T12:00:00.000Z");

function passingValuationGate(assessedAt = NOW) {
  const timestamp = new Date(assessedAt).toISOString();
  return assessPortfolioValuationGate({
    portfolio: {
      status: "live",
      holdingsStatus: "live",
      syncedAt: timestamp,
      account: {
        baseCurrency: "USD",
        netAssets: 1_000,
        totalCash: 1_000,
        valuationComplete: true,
      },
      dataQuality: { valuationComplete: true },
      totals: { positionsNetMarketValueBase: 0 },
      positions: [],
    },
    assessedAt: timestamp,
  });
}

test("a completed live synchronization is sizing-fresh for exactly two minutes", () => {
  const portfolio = {
    status: "live",
    holdingsStatus: "live",
    syncedAt: new Date(NOW - PORTFOLIO_FRESHNESS_MAX_AGE_MS).toISOString(),
    valuationGate: passingValuationGate(NOW - PORTFOLIO_FRESHNESS_MAX_AGE_MS),
  };
  const freshness = portfolioFreshness(portfolio, { now: NOW });

  assert.equal(portfolioSnapshotAgeMs(portfolio, NOW), 120_000);
  assert.equal(freshness.state, "fresh");
  assert.equal(freshness.freshForSizing, true);
  assert.equal(freshness.sourceStatus, "live");
  assert.equal(freshness.snapshotFreshForSizing, true);
  assert.equal(freshness.valuationGate.status, "pass");
  assert.equal(freshness.expiresAt, new Date(NOW).toISOString());
});

test("a live snapshot older than two minutes becomes stale and cannot size", () => {
  const portfolio = withPortfolioFreshness({
    status: "live",
    holdingsStatus: "live",
    syncedAt: new Date(NOW - PORTFOLIO_FRESHNESS_MAX_AGE_MS - 1).toISOString(),
    valuationGate: passingValuationGate(NOW - PORTFOLIO_FRESHNESS_MAX_AGE_MS - 1),
  }, { now: NOW });

  assert.equal(portfolio.status, "stale");
  assert.equal(portfolio.holdingsStatus, "stale");
  assert.equal(portfolio.freshness.state, "stale");
  assert.equal(portfolio.freshness.freshForSizing, false);
});

test("an encrypted cache is never considered sizing-fresh even when recent", () => {
  const portfolio = withPortfolioFreshness({
    status: "cached",
    holdingsStatus: "live",
    syncedAt: new Date(NOW - 1_000).toISOString(),
    valuationGate: passingValuationGate(NOW - 1_000),
  }, {
    now: NOW,
    forceState: "cached",
    reason: "cache restore",
  });

  assert.equal(portfolio.status, "cached");
  assert.equal(portfolio.holdingsStatus, "cached");
  assert.equal(portfolio.freshness.state, "cached");
  assert.equal(portfolio.freshness.freshForSizing, false);
  assert.equal(portfolio.freshness.reason, "cache restore");
});

test("a failed refresh can explicitly downgrade a recent snapshot", () => {
  const portfolio = withPortfolioFreshness({
    status: "degraded",
    holdingsStatus: "live",
    syncedAt: new Date(NOW - 1_000).toISOString(),
    valuationGate: passingValuationGate(NOW - 1_000),
  }, {
    now: NOW,
    forceState: "stale",
    reason: "refresh failed",
  });

  assert.equal(portfolio.status, "stale");
  assert.equal(portfolio.holdingsStatus, "stale");
  assert.equal(portfolio.freshness.sourceStatus, "degraded");
  assert.equal(portfolio.freshness.freshForSizing, false);
  assert.equal(portfolio.freshness.reason, "refresh failed");
});

test("a fresh account snapshot without a valuation gate fails closed for sizing", () => {
  const freshness = portfolioFreshness({
    status: "live",
    holdingsStatus: "live",
    syncedAt: new Date(NOW - 1_000).toISOString(),
  }, { now: NOW });

  assert.equal(freshness.state, "fresh");
  assert.equal(freshness.snapshotFreshForSizing, true);
  assert.equal(freshness.valuationGate.status, "missing");
  assert.equal(freshness.valuationGate.reason, "valuation_gate_missing");
  assert.equal(freshness.freshForSizing, false);
});

test("a tampered valuation gate cannot be promoted by forceState fresh", () => {
  const valid = passingValuationGate(NOW - 1_000);
  const tampered = {
    ...valid,
    outcome: { ...valid.outcome, readyForSizing: false },
  };
  const portfolio = withPortfolioFreshness({
    status: "live",
    holdingsStatus: "live",
    syncedAt: new Date(NOW - 1_000).toISOString(),
    valuationGate: tampered,
  }, { now: NOW, forceState: "fresh" });

  assert.equal(portfolio.freshness.state, "fresh");
  assert.equal(portfolio.freshness.valuationGate.status, "invalid");
  assert.equal(portfolio.freshness.valuationGate.reason, "valuation_gate_hash_mismatch");
  assert.equal(portfolio.freshness.freshForSizing, false);
});

test("a valid blocking valuation gate remains an independent hard prerequisite", () => {
  const timestamp = new Date(NOW - 1_000).toISOString();
  const blocked = assessPortfolioValuationGate({
    portfolio: {
      status: "degraded",
      holdingsStatus: "live",
      syncedAt: timestamp,
      account: { baseCurrency: "USD", netAssets: 0, totalCash: 0, valuationComplete: true },
      dataQuality: { valuationComplete: true },
      totals: { positionsNetMarketValueBase: 0 },
      positions: [],
    },
    assessedAt: timestamp,
  });
  const freshness = portfolioFreshness({
    status: "degraded",
    holdingsStatus: "live",
    syncedAt: timestamp,
    valuationGate: blocked,
  }, { now: NOW });

  assert.equal(portfolioValuationGateFreshness(blocked).valid, true);
  assert.equal(freshness.state, "fresh");
  assert.equal(freshness.valuationGate.status, "block");
  assert.equal(freshness.freshForSizing, false);
});

test("desktop gates Agent fallback and plan saving on the freshness contract", async () => {
  const main = await readFile(new URL("../main.mjs", import.meta.url), "utf8");

  assert.match(main, /let analysisPortfolio = requestedPortfolio \? withPortfolioFreshness\(requestedPortfolio\) : null/);
  assert.match(main, /!\["review", "chat"\]\.includes\(scope\) && !multiBrokerAnalysis && !analysisPortfolio\.freshness\.freshForSizing/);
  assert.match(
    main,
    /refreshOutcome\.error[\s\S]{0,500}forceState:\s*"stale"[\s\S]{0,900}refreshOutcome\.timedOut[\s\S]{0,500}forceState:\s*"stale"/,
  );
  assert.match(
    main,
    /forceState:\s*"stale",\s*reason:\s*"长桥离线；本轮仅使用上次同步快照"/,
  );
  assert.match(main, /portfolioService\.candlesWithCoverage\(value,\s*1000/);
  assert.match(main, /scope === "candidate" && !multiBrokerAnalysis && longbridge\.connected[\s\S]{0,1800}phase: "host_revalidation"/);
  assert.match(main, /localRun = await buildAnalysisEvidence\([\s\S]{0,500}candlesWithCoverage/);
  assert.match(
    main,
    /ipcMain\.handle\("agent:save-plan"[\s\S]{0,800}portfolioFreshness\(portfolio\)\.freshForSizing/,
  );
});
