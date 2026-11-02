import assert from "node:assert/strict";
import test from "node:test";
import {
  assessPortfolioValuationGate,
  PORTFOLIO_VALUATION_GATE_SCHEMA_VERSION,
  stablePortfolioValuationGateHash,
} from "../src/data/portfolio-valuation-gate.mjs";

const REGULAR_NOW = "2026-08-31T14:00:00.000Z"; // 10:00 America/New_York

function position(overrides = {}) {
  return {
    symbol: "AAPL.US",
    instrumentType: "equity",
    market: "US",
    currency: "USD",
    quantity: 10,
    lastPrice: 200,
    quoteTimestamp: "2026-08-31T13:59:00.000Z",
    quoteSession: "regular",
    tradeStatus: "NormalStatus",
    valuationStatus: "priced",
    marketValue: 2_000,
    marketValueBase: 2_000,
    contractMultiplier: 1,
    ...overrides,
  };
}

function portfolio(overrides = {}) {
  const positions = overrides.positions ?? [position()];
  const positionsNetMarketValueBase = positions.reduce((sum, item) => (
    sum + (typeof item.marketValueBase === "number" ? item.marketValueBase : 0)
  ), 0);
  return {
    status: "live",
    holdingsStatus: "live",
    valuationStatus: "complete",
    syncedAt: "2026-08-31T13:59:30.000Z",
    account: {
      baseCurrency: "USD",
      netAssets: 10_000,
      totalCash: 10_000 - positionsNetMarketValueBase,
      valuationComplete: true,
      ...(overrides.account ?? {}),
    },
    totals: {
      positionsNetMarketValueBase,
      ...(overrides.totals ?? {}),
    },
    positions,
    ...Object.fromEntries(Object.entries(overrides).filter(
      ([key]) => !["account", "totals", "positions"].includes(key),
    )),
  };
}

test("a fresh account sync does not upgrade a stale per-symbol quote", () => {
  const result = assessPortfolioValuationGate({
    portfolio: portfolio({
      positions: [position({ quoteTimestamp: "2026-08-31T13:50:00.000Z" })],
    }),
    assessedAt: REGULAR_NOW,
  });

  assert.equal(result.accountSync.status, "pass");
  assert.equal(result.positions[0].quote.ageMs, 10 * 60 * 1000);
  assert.equal(result.positions[0].quote.state, "stale_active");
  assert.equal(result.positions[0].status, "block");
  assert.equal(result.outcome.readyForSizing, false);
  assert.ok(result.outcome.blockingReasonCodes.includes("quote_stale_active_session"));
});

test("a latest Friday close remains current while the US market is closed on Sunday", () => {
  const result = assessPortfolioValuationGate({
    portfolio: portfolio({
      syncedAt: "2026-08-30T15:59:30.000Z",
      positions: [position({
        quoteTimestamp: "2026-08-28T19:59:00.000Z",
        quoteSession: "regular",
      })],
    }),
    assessedAt: "2026-08-30T16:00:00.000Z",
  });

  assert.ok(result.positions[0].quote.ageMs > 24 * 60 * 60 * 1000);
  assert.equal(result.positions[0].marketClock.phase, "closed");
  assert.equal(result.positions[0].marketClock.expectedLatestCompletedTradeDate, "2026-08-28");
  assert.equal(result.positions[0].quote.state, "accepted_market_closed");
  assert.equal(result.outcome.status, "pass");
});

test("an older-than-latest completed close is blocked even though absolute age is ignored while closed", () => {
  const result = assessPortfolioValuationGate({
    portfolio: portfolio({
      syncedAt: "2026-08-30T15:59:30.000Z",
      positions: [position({ quoteTimestamp: "2026-08-27T19:59:00.000Z" })],
    }),
    assessedAt: "2026-08-30T16:00:00.000Z",
  });

  assert.equal(result.positions[0].quote.state, "older_than_required_session");
  assert.ok(result.outcome.blockingReasonCodes.includes(
    "quote_older_than_latest_completed_session",
  ));
});

test("US official early close transitions to post-market instead of remaining regular", () => {
  const result = assessPortfolioValuationGate({
    portfolio: portfolio({
      syncedAt: "2026-11-27T19:00:00.000Z",
      positions: [position({
        quoteTimestamp: "2026-11-27T17:59:00.000Z",
        quoteSession: "regular",
      })],
    }),
    assessedAt: "2026-11-27T19:00:30.000Z",
  });

  assert.equal(result.positions[0].marketClock.phase, "post_market");
  assert.equal(result.positions[0].marketClock.expectedLatestCompletedTradeDate, "2026-11-27");
  assert.equal(result.positions[0].quote.state, "accepted_prior_session_mark");
  assert.ok(result.outcome.degradedReasonCodes.includes("extended_session_mark_not_current"));
  assert.equal(result.outcome.blockingReasonCodes.includes("quote_stale_active_session"), false);
});

test("Hong Kong lunch break accepts the current-session mark instead of applying open-market TTL", () => {
  const hkPosition = position({
    symbol: "700.HK",
    market: "HK",
    currency: "HKD",
    quantity: 100,
    lastPrice: 50,
    quoteTimestamp: "2026-08-31T03:59:00.000Z",
    marketValue: 5_000,
    marketValueBase: 5_000,
  });
  const result = assessPortfolioValuationGate({
    portfolio: portfolio({
      syncedAt: "2026-08-31T04:29:30.000Z",
      positions: [hkPosition],
      account: { netAssets: 10_000, totalCash: 5_000 },
    }),
    assessedAt: "2026-08-31T04:30:00.000Z",
  });

  assert.equal(result.positions[0].marketClock.phase, "session_break");
  assert.equal(result.positions[0].quote.state, "accepted_exchange_break");
  assert.equal(result.outcome.status, "pass");
});

test("an option remains an option outside its venue session and never needs an equity extended-hours quote", () => {
  const option = position({
    symbol: "AAPL260918C00200000.US",
    instrumentType: "option",
    quantity: 2,
    lastPrice: 5,
    quoteTimestamp: "2026-08-31T19:59:00.000Z",
    quoteSession: "regular",
    marketValue: 1_000,
    marketValueBase: 1_000,
    contractMultiplier: 100,
  });
  const result = assessPortfolioValuationGate({
    portfolio: portfolio({
      syncedAt: "2026-08-31T20:59:30.000Z",
      positions: [option],
      account: { netAssets: 10_000, totalCash: 9_000 },
    }),
    assessedAt: "2026-08-31T21:00:00.000Z",
  });

  assert.equal(result.positions[0].instrumentType, "option");
  assert.equal(result.positions[0].marketClock.phase, "closed");
  assert.equal(result.positions[0].quote.state, "accepted_market_closed");
  assert.equal(result.outcome.status, "pass");
});

test("a missing OPRA mark blocks the option explicitly instead of treating it as an equity", () => {
  const result = assessPortfolioValuationGate({
    portfolio: portfolio({
      positions: [position({
        symbol: "AAPL260918C00200000.US",
        instrumentType: null,
        quantity: 2,
        lastPrice: null,
        quoteTimestamp: null,
        quoteSession: null,
        valuationStatus: "unpriced",
        marketValue: null,
        marketValueBase: null,
        contractMultiplier: null,
      })],
      account: { totalCash: 10_000 },
    }),
    assessedAt: REGULAR_NOW,
  });

  assert.equal(result.positions[0].instrumentType, "option");
  assert.equal(result.positions[0].instrumentTypeSource, "symbol_pattern");
  assert.ok(result.positions[0].reasonCodes.includes("quote_price_missing"));
  assert.ok(result.positions[0].reasonCodes.includes("quote_timestamp_missing"));
  assert.ok(result.positions[0].reasonCodes.includes("option_contract_multiplier_missing"));
  assert.equal(result.positions[0].reasonCodes.includes("instrument_type_unknown"), false);
  assert.equal(result.outcome.status, "block");
});

test("future quote and account timestamps fail closed with distinct reasons", () => {
  const result = assessPortfolioValuationGate({
    portfolio: portfolio({
      syncedAt: "2026-08-31T14:02:00.000Z",
      positions: [position({ quoteTimestamp: "2026-08-31T14:02:00.000Z" })],
    }),
    assessedAt: REGULAR_NOW,
  });

  assert.ok(result.outcome.blockingReasonCodes.includes("account_sync_time_in_future"));
  assert.ok(result.outcome.blockingReasonCodes.includes("quote_timestamp_in_future"));
  assert.equal(result.accountSync.ageMs, 0);
  assert.equal(result.positions[0].quote.ageMs, 0);
});

test("an explicit incomplete account valuation is a hard gate even when headline numbers exist", () => {
  const result = assessPortfolioValuationGate({
    portfolio: portfolio({ account: { valuationComplete: false } }),
    assessedAt: REGULAR_NOW,
  });

  assert.ok(result.outcome.blockingReasonCodes.includes("account_valuation_incomplete"));
  assert.equal(result.accountSync.status, "block");
});

test("cross-symbol time skew degrades an otherwise individually fresh regular-session set", () => {
  const aapl = position({ quoteTimestamp: "2026-08-31T13:59:30.000Z" });
  const msft = position({
    symbol: "MSFT.US",
    quantity: 10,
    lastPrice: 300,
    quoteTimestamp: "2026-08-31T13:56:30.000Z",
    marketValue: 3_000,
    marketValueBase: 3_000,
  });
  const result = assessPortfolioValuationGate({
    portfolio: portfolio({
      positions: [aapl, msft],
      account: { netAssets: 10_000, totalCash: 5_000 },
    }),
    assessedAt: REGULAR_NOW,
  });

  assert.equal(result.positions.every((item) => item.status === "pass"), true);
  assert.equal(result.quoteCohorts[0].skewMs, 3 * 60 * 1000);
  assert.equal(result.quoteCohorts[0].status, "degraded");
  assert.ok(result.outcome.degradedReasonCodes.includes("cross_symbol_quote_skew_exceeded"));
  assert.equal(result.outcome.readyForSizing, false);
});

test("zero cash is a known value and reconciles; zero NAV and zero price are not missing", () => {
  const allInvested = assessPortfolioValuationGate({
    portfolio: portfolio({
      positions: [position({
        quantity: 50,
        marketValue: 10_000,
        marketValueBase: 10_000,
      })],
      account: { netAssets: 10_000, totalCash: 0 },
    }),
    assessedAt: REGULAR_NOW,
  });
  assert.equal(allInvested.reconciliation.totalCash, 0);
  assert.equal(allInvested.reconciliation.residual, 0);
  assert.equal(allInvested.reconciliation.status, "pass");

  const zeroNav = assessPortfolioValuationGate({
    portfolio: portfolio({
      positions: [],
      account: { netAssets: 0, totalCash: 0 },
      totals: { positionsNetMarketValueBase: 0 },
    }),
    assessedAt: REGULAR_NOW,
  });
  assert.ok(zeroNav.outcome.blockingReasonCodes.includes("account_net_assets_zero"));
  assert.equal(zeroNav.outcome.blockingReasonCodes.includes("account_net_assets_missing"), false);

  const zeroPrice = assessPortfolioValuationGate({
    portfolio: portfolio({
      positions: [position({
        lastPrice: 0,
        marketValue: 0,
        marketValueBase: 0,
      })],
      account: { netAssets: 10_000, totalCash: 10_000 },
    }),
    assessedAt: REGULAR_NOW,
  });
  assert.ok(zeroPrice.outcome.blockingReasonCodes.includes("quote_price_zero"));
  assert.equal(zeroPrice.outcome.blockingReasonCodes.includes("quote_price_missing"), false);
});

test("zero net quantity with offsetting gross legs remains exposed and still requires a fresh quote", () => {
  const result = assessPortfolioValuationGate({
    portfolio: portfolio({
      positions: [position({
        quantity: 0,
        grossQuantity: 20,
        quoteTimestamp: "2026-08-31T13:50:00.000Z",
        marketValue: 0,
        marketValueBase: 0,
        grossMarketValueBase: 4_000,
      })],
      account: { netAssets: 10_000, totalCash: 10_000 },
    }),
    assessedAt: REGULAR_NOW,
  });

  assert.equal(result.positions[0].quantity, 0);
  assert.equal(result.positions[0].grossQuantity, 20);
  assert.equal(result.positions[0].hasExposure, true);
  assert.equal(result.positions[0].quote.state, "stale_active");
  assert.ok(result.outcome.blockingReasonCodes.includes("quote_stale_active_session"));
});

test("net-asset reconciliation distinguishes warning drift from a blocking failure", () => {
  const warning = assessPortfolioValuationGate({
    portfolio: portfolio({
      account: { netAssets: 10_000, totalCash: 7_800 },
    }),
    assessedAt: REGULAR_NOW,
  });
  assert.equal(warning.reconciliation.residual, 200);
  assert.equal(warning.reconciliation.residualBps, 200);
  assert.equal(warning.reconciliation.status, "degraded");
  assert.ok(warning.outcome.degradedReasonCodes.includes("net_asset_reconciliation_degraded"));

  const blocked = assessPortfolioValuationGate({
    portfolio: portfolio({
      account: { netAssets: 10_000, totalCash: 7_000 },
    }),
    assessedAt: REGULAR_NOW,
  });
  assert.equal(blocked.reconciliation.residual, 1_000);
  assert.equal(blocked.reconciliation.residualBps, 1_000);
  assert.equal(blocked.reconciliation.status, "block");
  assert.ok(blocked.outcome.blockingReasonCodes.includes("net_asset_reconciliation_failed"));
});

test("declared position totals and native values are independently reconciled", () => {
  const nativeMismatch = assessPortfolioValuationGate({
    portfolio: portfolio({
      positions: [position({ marketValue: 1_500 })],
    }),
    assessedAt: REGULAR_NOW,
  });
  assert.ok(nativeMismatch.outcome.blockingReasonCodes.includes(
    "position_native_market_value_mismatch",
  ));

  const totalMismatch = assessPortfolioValuationGate({
    portfolio: portfolio({
      totals: { positionsNetMarketValueBase: 3_000 },
    }),
    assessedAt: REGULAR_NOW,
  });
  assert.ok(totalMismatch.outcome.blockingReasonCodes.includes(
    "portfolio_position_total_mismatch",
  ));
});

test("the result is frozen, hash-verifiable, and invariant to position ordering", () => {
  const aapl = position();
  const msft = position({
    symbol: "MSFT.US",
    lastPrice: 300,
    marketValue: 3_000,
    marketValueBase: 3_000,
  });
  const left = assessPortfolioValuationGate({
    portfolio: portfolio({
      positions: [aapl, msft],
      account: { netAssets: 10_000, totalCash: 5_000 },
    }),
    assessedAt: REGULAR_NOW,
  });
  const right = assessPortfolioValuationGate({
    portfolio: portfolio({
      positions: [msft, aapl],
      account: { netAssets: 10_000, totalCash: 5_000 },
    }),
    assessedAt: REGULAR_NOW,
  });

  assert.equal(left.schemaVersion, PORTFOLIO_VALUATION_GATE_SCHEMA_VERSION);
  assert.match(left.hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(stablePortfolioValuationGateHash(left), left.hash);
  assert.equal(left.hash, right.hash);
  assert.equal(left.inputHash, right.inputHash);
  assert.equal(Object.isFrozen(left), true);
  assert.equal(Object.isFrozen(left.positions[0]), true);
});

test("invalid policy and missing assessedAt fail closed instead of inventing time", () => {
  assert.throws(
    () => assessPortfolioValuationGate({ portfolio: portfolio() }),
    /assessedAt must be a valid ISO timestamp/,
  );
  assert.throws(
    () => assessPortfolioValuationGate({
      portfolio: portfolio(),
      assessedAt: REGULAR_NOW,
      policy: { accountSyncMaxAgeMs: -1 },
    }),
    /accountSyncMaxAgeMs must be a non-negative finite number/,
  );
});
