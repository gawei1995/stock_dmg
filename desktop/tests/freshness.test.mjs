import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PORTFOLIO_FRESHNESS_MAX_AGE_MS,
  portfolioFreshness,
  portfolioSnapshotAgeMs,
  withPortfolioFreshness,
} from "../src/data/freshness.mjs";

const NOW = Date.parse("2026-07-26T12:00:00.000Z");

test("a completed live synchronization is sizing-fresh for exactly two minutes", () => {
  const portfolio = {
    status: "live",
    holdingsStatus: "live",
    syncedAt: new Date(NOW - PORTFOLIO_FRESHNESS_MAX_AGE_MS).toISOString(),
  };
  const freshness = portfolioFreshness(portfolio, { now: NOW });

  assert.equal(portfolioSnapshotAgeMs(portfolio, NOW), 120_000);
  assert.equal(freshness.state, "fresh");
  assert.equal(freshness.freshForSizing, true);
  assert.equal(freshness.sourceStatus, "live");
  assert.equal(freshness.expiresAt, new Date(NOW).toISOString());
});

test("a live snapshot older than two minutes becomes stale and cannot size", () => {
  const portfolio = withPortfolioFreshness({
    status: "live",
    holdingsStatus: "live",
    syncedAt: new Date(NOW - PORTFOLIO_FRESHNESS_MAX_AGE_MS - 1).toISOString(),
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

test("desktop gates Agent fallback and plan saving on the freshness contract", async () => {
  const main = await readFile(new URL("../main.mjs", import.meta.url), "utf8");

  assert.match(main, /let analysisPortfolio = portfolio \? withPortfolioFreshness\(portfolio\) : null/);
  assert.match(main, /scope !== "review" && !analysisPortfolio\.freshness\.freshForSizing/);
  assert.match(
    main,
    /refreshOutcome\.error[\s\S]{0,500}forceState:\s*"stale"[\s\S]{0,900}refreshOutcome\.timedOut[\s\S]{0,500}forceState:\s*"stale"/,
  );
  assert.match(
    main,
    /forceState:\s*"stale",\s*reason:\s*"长桥离线；本轮仅使用上次同步快照"/,
  );
  assert.match(main, /portfolioService\.candles\(value,\s*1000/);
  assert.match(
    main,
    /ipcMain\.handle\("agent:save-plan"[\s\S]{0,800}portfolioFreshness\(portfolio\)\.freshForSizing/,
  );
});
