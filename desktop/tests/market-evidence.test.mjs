import assert from "node:assert/strict";
import test from "node:test";
import {
  assessDailyCandleEvidence,
  expectedLastCompletedTradingDate,
  isUsTradingDay,
} from "../src/engine/market-evidence.mjs";

test("US expected completed date respects close, weekend, holiday and early close", () => {
  assert.equal(expectedLastCompletedTradingDate({
    market: "US",
    analysisTime: "2026-08-31T19:00:00.000Z",
  }), "2026-08-28");
  assert.equal(expectedLastCompletedTradingDate({
    market: "US",
    analysisTime: "2026-08-31T21:10:00.000Z",
  }), "2026-08-31");
  assert.equal(expectedLastCompletedTradingDate({
    market: "US",
    analysisTime: "2026-11-27T18:10:00.000Z",
  }), "2026-11-27");
  assert.equal(isUsTradingDay("2026-12-25"), false);
});

test("persistent fallback remains research-only even when it contains the latest bar", () => {
  const result = assessDailyCandleEvidence({
    symbol: "AAPL.US",
    analysisTime: "2026-08-31T21:10:00.000Z",
    technical: {
      timeframe: "1D",
      asOfTradingDate: "2026-08-31",
      lastBar: { status: "CLOSED", market: "US" },
    },
    coverage: {
      source: "persistent_fallback",
      endpoint: "https://openapi-sg.longportapp.com/v2",
      latestTradeDate: "2026-08-31",
      complete: true,
      cacheAgeMs: 60_000,
      partialReasons: ["live_refresh_failed"],
    },
  });
  assert.equal(result.freshForResearch, true);
  assert.equal(result.freshForDecision, false);
  assert.equal(result.freshForSizing, false);
  assert.ok(result.reasonCodes.includes("persistent_fallback_research_only"));
});

test("fresh live evidence can size while an old or missing trading date cannot", () => {
  const base = {
    symbol: "AAPL.US",
    analysisTime: "2026-08-31T21:10:00.000Z",
    technical: {
      timeframe: "1D",
      asOfTradingDate: "2026-08-31",
      lastBar: { status: "CLOSED", market: "US" },
    },
  };
  const fresh = assessDailyCandleEvidence({
    ...base,
    coverage: {
      source: "live",
      endpoint: "https://openapi-sg.longportapp.com/v2",
      latestTradeDate: "2026-08-31",
      complete: true,
      cacheAgeMs: 30_000,
      partialReasons: [],
    },
  });
  assert.equal(fresh.freshForDecision, true);
  assert.equal(fresh.freshForSizing, true);

  const stale = assessDailyCandleEvidence({
    ...base,
    coverage: {
      source: "persistent",
      endpoint: "https://openapi-sg.longportapp.com/v2",
      latestTradeDate: "2026-08-28",
      complete: true,
      cacheAgeMs: 86_400_000,
      partialReasons: [],
    },
  });
  assert.equal(stale.freshForResearch, true);
  assert.equal(stale.freshForDecision, false);
  assert.equal(stale.freshForSizing, false);
  assert.ok(stale.reasonCodes.includes("latest_completed_trade_date_missing"));
});
