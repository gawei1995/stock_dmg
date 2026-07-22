import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFxGraph,
  findConversionRate,
  findHkdPerUsd,
  inferInstrumentType,
  normalizeCandles,
  normalizePortfolio,
  normalizeTimestamp,
  selectQuoteMark,
} from "../src/data/normalize.mjs";

test("normalizes account positions, quotes, FX, weights, and exposure", () => {
  const result = normalizePortfolio({
    positions: {
      list: [
        {
          stock_info: [
            {
              symbol: "AAPL.US",
              symbol_name: "Apple",
              quantity: "10",
              available_quantity: "10",
              currency: "USD",
              cost_price: "100",
              market: "US",
            },
          ],
        },
      ],
    },
    balances: [
      {
        currency: "HKD",
        net_assets: "20000",
        total_cash: "1000",
        buy_power: "5000",
        risk_level: "0",
        cash_infos: [],
      },
    ],
    quotes: [{ symbol: "AAPL.US", last_done: "200", prev_close: "190" }],
    exchangeRates: {
      exchanges: [
        { from_currency: "USD", to_currency: "HKD", rate: 8 },
      ],
    },
  });

  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].marketValueBase, 16000);
  assert.equal(result.positions[0].weight, 80);
  assert.equal(result.positions[0].tvSymbol, "NASDAQ:AAPL");
  assert.equal(result.groupExposure["消费科技"], 80);
  assert.equal(result.orderWrite, false);
});

test("derives HKD per USD from an inverse HKD/USD response", () => {
  const rate = findHkdPerUsd({
    exchanges: [
      { from_currency: "HKD", to_currency: "USD", rate: 0.12755 },
    ],
  });
  assert.ok(Math.abs(rate - 7.84006272) < 0.00001);
});

test("uses the official USD/HKD direction without inversion", () => {
  const rate = findHkdPerUsd({
    exchanges: [
      { from_currency: "USD", to_currency: "HKD", rate: 7.79 },
    ],
  });
  assert.equal(rate, 7.79);
});

test("aggregates the same symbol across Longbridge position channels", () => {
  const result = normalizePortfolio({
    positions: { list: [
      { stock_info: [{ symbol: "AAPL.US", quantity: "2", available_quantity: "2", currency: "USD", cost_price: "100", market: "US" }] },
      { stock_info: [{ symbol: "AAPL.US", quantity: "3", available_quantity: "1", currency: "USD", cost_price: "200", market: "US" }] },
    ] },
    balances: [{ currency: "HKD", net_assets: "10000", total_cash: "1000" }],
    quotes: [{ symbol: "AAPL.US", last_done: "250", prev_close: "240" }],
    exchangeRates: { exchanges: [{ from_currency: "USD", to_currency: "HKD", rate: 8 }] },
  });
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].quantity, 5);
  assert.equal(result.positions[0].availableQuantity, 3);
  assert.equal(result.positions[0].costPrice, 160);
});

test("keeps real quantities but degrades valuation when a quote is missing", () => {
  const result = normalizePortfolio({
    positions: { list: [{ stock_info: [{ symbol: "AAPL.US", quantity: "2", currency: "USD", cost_price: "100", market: "US" }] }] },
    balances: [{ currency: "HKD", net_assets: "10000" }],
    quotes: [],
    exchangeRates: { exchanges: [{ from_currency: "USD", to_currency: "HKD", rate: 8 }] },
  });
  assert.equal(result.status, "degraded");
  assert.equal(result.positions[0].quantity, 2);
  assert.equal(result.positions[0].valuationStatus, "unpriced");
  assert.equal(result.positions[0].lastPrice, null);
  assert.equal(result.positions[0].weight, null);
});

test("keeps the native quote when FX is unavailable without inventing a conversion", () => {
  const result = normalizePortfolio({
    positions: { list: [{ stock_info: [{
      symbol: "AAPL.US",
      quantity: "2",
      currency: "USD",
      cost_price: "100",
      market: "US",
    }] }] },
    balances: [{ currency: "HKD", net_assets: "10000" }],
    quotes: [{ symbol: "AAPL.US", last_done: "250", prev_close: "240", timestamp: "1767225600" }],
    exchangeRates: [],
    fxStatus: "unavailable",
    sourceErrors: [{ tool: "exchange_rate", code: 463, kind: "gateway", message: "status error: 463" }],
  });
  assert.equal(result.holdingsStatus, "live");
  assert.equal(result.positions[0].lastPrice, 250);
  assert.equal(result.positions[0].marketValue, 500);
  assert.equal(result.positions[0].marketValueBase, null);
  assert.equal(result.positions[0].weight, null);
  assert.equal(result.positions[0].valuationStatus, "native_only");
  assert.equal(result.dataQuality.fxStatus, "unavailable");
  assert.equal(result.dataQuality.sourceErrors[0].code, 463);
});

test("identifies Longbridge option symbols for the nonlinear-risk guard", () => {
  assert.equal(inferInstrumentType("AAPL250117C250000.US"), "option");
  assert.equal(inferInstrumentType("AAPL.US"), "equity");
});

test("candles are numeric and chronologically sorted", () => {
  const bars = normalizeCandles([
    { timestamp: "2026-01-02T00:00:00Z", open: "2", high: "3", low: "1", close: "2.5" },
    { timestamp: "2026-01-01T00:00:00Z", open: "1", high: "2", low: "0.5", close: "1.5" },
  ]);
  assert.equal(bars[0].close, 1.5);
  assert.equal(bars[1].close, 2.5);
});

test("normalizes Longbridge epoch-second timestamps before EMA ordering", () => {
  assert.equal(normalizeTimestamp("1767225600"), "2026-01-01T00:00:00.000Z");
});

test("uses the newest valid extended-hours mark and records its session", () => {
  const mark = selectQuoteMark({
    last_done: "100",
    timestamp: "1767225600",
    post_market_quote: { last_done: "105", timestamp: "1767232800" },
    pre_market_quote: { last_done: "99", timestamp: "1767218400" },
  });
  assert.equal(mark.price, 105);
  assert.equal(mark.session, "post_market");
  assert.equal(mark.timestamp, "2026-01-01T02:00:00.000Z");
});

test("converts multi-currency holdings through the complete Longbridge FX graph", () => {
  const graph = buildFxGraph({ exchanges: [
    { from_currency: "SGD", to_currency: "USD", rate: 0.75 },
    { from_currency: "USD", to_currency: "HKD", rate: 7.8 },
  ] });
  assert.ok(Math.abs(findConversionRate("SGD", "HKD", graph) - 5.85) < 1e-9);
  const result = normalizePortfolio({
    positions: { list: [{ stock_info: [{ symbol: "D05.SG", quantity: "10", currency: "SGD", cost_price: "90", market: "SG" }] }] },
    balances: [{ currency: "HKD", net_assets: "100000", total_cash: "10000" }],
    quotes: [{ symbol: "D05.SG", last_done: "100", timestamp: "1767225600" }],
    exchangeRates: { exchanges: [
      { from_currency: "SGD", to_currency: "USD", rate: 0.75 },
      { from_currency: "USD", to_currency: "HKD", rate: 7.8 },
    ] },
  });
  assert.equal(result.positions[0].marketValueBase, 5850);
  assert.equal(result.status, "live");
});

test("option valuation requires the real contract multiplier and never assumes 100", () => {
  const base = {
    positions: { list: [{ stock_info: [{ symbol: "AAPL250117C250000.US", quantity: "2", currency: "USD", cost_price: "5", market: "US" }] }] },
    balances: [{ currency: "USD", net_assets: "10000", total_cash: "1000" }],
    exchangeRates: [],
  };
  const unpriced = normalizePortfolio({
    ...base,
    quotes: [{ symbol: "AAPL250117C250000.US", last_done: "6" }],
  });
  assert.equal(unpriced.status, "degraded");
  assert.equal(unpriced.positions[0].marketValueBase, null);

  const priced = normalizePortfolio({
    ...base,
    quotes: [{
      symbol: "AAPL250117C250000.US",
      last_done: "6",
      option_extend: { contract_multiplier: "100" },
    }],
  });
  assert.equal(priced.positions[0].marketValueBase, 1200);
  assert.equal(priced.positions[0].weight, 12);
});

test("gross exposure preserves offsetting long and short legs across channels", () => {
  const result = normalizePortfolio({
    positions: { list: [
      { account_channel: "cash", stock_info: [{ symbol: "AAPL.US", quantity: "10", currency: "USD", cost_price: "90", market: "US" }] },
      { account_channel: "margin", stock_info: [{ symbol: "AAPL.US", quantity: "-4", currency: "USD", cost_price: "110", market: "US" }] },
    ] },
    balances: [{ currency: "USD", net_assets: "10000" }],
    quotes: [{ symbol: "AAPL.US", last_done: "100", timestamp: "1767225600" }],
    exchangeRates: [],
  });
  const position = result.positions[0];
  assert.equal(position.quantity, 6);
  assert.equal(position.grossQuantity, 14);
  assert.equal(position.netWeight, 6);
  assert.ok(Math.abs(position.weight - 14) < 1e-9);
  assert.equal(position.hasOffsettingLegs, true);
});
