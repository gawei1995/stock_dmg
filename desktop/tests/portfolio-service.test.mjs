import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeLongbridgeExchangeRates,
  PortfolioService,
  PORTFOLIO_SNAPSHOT_SCHEMA_VERSION,
} from "../src/data/portfolio-service.mjs";
import { buildFxGraph, findConversionRate } from "../src/data/normalize.mjs";

const liveUsdSelfRate = () => ({ exchanges: [{
  base_currency: "USD",
  other_currency: "USD",
  average_rate: 1,
}] });

test("live Longbridge MCP FX keeps HKD assets in the correct USD magnitude", async () => {
  const calls = [];
  const longbridge = {
    endpoint: "https://mcp.longbridge.com/v2",
    async call(name, args) {
      calls.push([name, args]);
      if (name === "stock_positions") {
        return { list: [{ stock_info: [{
          symbol: "7709.HK",
          symbol_name: "XL2CSOPHYNIX",
          quantity: "100",
          available_quantity: "100",
          cost_price: "53.49",
          currency: "HKD",
          market: "HK",
        }] }] };
      }
      if (name === "account_balance") {
        return [{
          currency: "USD",
          net_assets: "117679.86",
          total_cash: "18060.22",
          buy_power: "72856.64",
          risk_level: "0",
        }, {
          // A defensive duplicate display denomination must never be summed
          // into the requested USD account headline.
          currency: "HKD",
          net_assets: "922764.53",
          total_cash: "141604.34",
          buy_power: "571285.19",
          risk_level: "0",
        }];
      }
      if (name === "exchange_rate") {
        // Captured from the live Longbridge MCP contract on 2026-07-21:
        // the value is USD received for one HKD, despite the pair labels.
        return { exchanges: [{
          base_currency: "USD",
          other_currency: "HKD",
          average_rate: 0.12754,
        }] };
      }
      if (name === "quote") {
        return [{
          symbol: "7709.HK",
          last_done: "57.80",
          prev_close: "52.58",
          timestamp: "1784640000",
        }];
      }
      if (name === "option_quote") return [];
      throw new Error(`unexpected tool ${name}`);
    },
  };
  const store = { async set() {}, async get() { return null; } };
  const portfolio = await new PortfolioService({ longbridge, store }).refresh();
  const position = portfolio.positions[0];

  assert.deepEqual(
    calls.find(([name]) => name === "account_balance")?.[1],
    { currency: "USD" },
  );
  assert.equal(portfolio.account.netAssets, 117679.86);
  assert.equal(portfolio.account.totalCash, 18060.22);
  assert.ok(Math.abs(portfolio.fx.hkdPerUsd - (1 / 0.12754)) < 1e-12);
  assert.ok(Math.abs(position.marketValueBase - (5780 * 0.12754)) < 1e-9);
  assert.ok(Math.abs(position.weight - ((5780 * 0.12754) / 117679.86 * 100)) < 1e-9);
  assert.ok(position.marketValueBase < 1_000);
  assert.equal(portfolio.dataQuality.valuationComplete, true);
  assert.equal(portfolio.valuationSchemaVersion, PORTFOLIO_SNAPSHOT_SCHEMA_VERSION);
});

test("an old ambiguous-FX portfolio snapshot is never restored", async () => {
  const longbridge = { endpoint: "https://mcp.longbridge.com/v2" };
  const oldService = new PortfolioService({
    longbridge,
    store: {
      async get() {
        return { endpoint: longbridge.endpoint, valuationSchemaVersion: 1 };
      },
    },
  });
  assert.equal(await oldService.cachedPortfolio(), null);

  const currentService = new PortfolioService({
    longbridge,
    store: {
      async get() {
        return {
          endpoint: longbridge.endpoint,
          valuationSchemaVersion: PORTFOLIO_SNAPSHOT_SCHEMA_VERSION,
          account: { netAssets: 117679.86 },
        };
      },
    },
  });
  assert.deepEqual(await currentService.cachedPortfolio(), {
    endpoint: longbridge.endpoint,
    valuationSchemaVersion: PORTFOLIO_SNAPSHOT_SCHEMA_VERSION,
    account: { netAssets: 117679.86 },
    status: "cached",
  });
});

test("Longbridge FX never guesses an unanchored or mixed provider convention", () => {
  assert.throws(
    () => canonicalizeLongbridgeExchangeRates({ exchanges: [{
      base_currency: "USD",
      other_currency: "EUR",
      average_rate: 0.9,
    }] }),
    /without a USD\/HKD anchor/,
  );
  assert.throws(
    () => canonicalizeLongbridgeExchangeRates({ exchanges: [{
      from_currency: "EUR",
      to_currency: "USD",
      rate: 1.1,
    }, {
      base_currency: "USD",
      other_currency: "HKD",
      average_rate: 0.12754,
    }] }),
    /mixed or invalid/,
  );
  assert.throws(
    () => canonicalizeLongbridgeExchangeRates({ exchanges: [] }),
    /empty FX table/,
  );

  const canonical = canonicalizeLongbridgeExchangeRates({ exchanges: [{
    from_currency: "EUR",
    to_currency: "USD",
    rate: 1.1,
  }] });
  assert.equal(findConversionRate("EUR", "USD", buildFxGraph(canonical)), 1.1);

  const restStyle = canonicalizeLongbridgeExchangeRates({ exchanges: [{
    base_currency: "USD",
    other_currency: "HKD",
    average_rate: 7.79,
  }] });
  assert.equal(findConversionRate("USD", "HKD", buildFxGraph(restStyle)), 7.79);
});

test("an unprovable live FX direction falls back to the reference provider", async () => {
  const longbridge = {
    endpoint: "https://mcp.longbridge.com/v2",
    async call(name) {
      if (name === "stock_positions") {
        return { list: [{ stock_info: [{
          symbol: "7709.HK",
          quantity: "100",
          currency: "HKD",
          cost_price: "53.49",
          market: "HK",
        }] }] };
      }
      if (name === "account_balance") {
        return [{ currency: "USD", net_assets: "117679.86", total_cash: "18060.22" }];
      }
      if (name === "exchange_rate") {
        return { exchanges: [{
          base_currency: "USD",
          other_currency: "EUR",
          average_rate: 0.9,
        }] };
      }
      if (name === "quote") {
        return [{ symbol: "7709.HK", last_done: "57.80", timestamp: "1784640000" }];
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
  const referenceFxProvider = {
    async latest() {
      return {
        status: "reference",
        provider: "European Central Bank",
        providerCode: "ECB",
        asOf: "2026-07-21",
        exchanges: [
          { from_currency: "EUR", to_currency: "USD", rate: 1.14 },
          { from_currency: "EUR", to_currency: "HKD", rate: 8.94 },
        ],
      };
    },
  };
  const store = { async set() {}, async get() { return null; } };
  const portfolio = await new PortfolioService({
    longbridge,
    store,
    referenceFxProvider,
  }).refresh();

  assert.equal(portfolio.dataQuality.fxStatus, "reference");
  assert.equal(portfolio.dataQuality.sourceWarnings[0].tool, "exchange_rate");
  assert.ok(Math.abs(portfolio.positions[0].marketValueBase - (5780 * 1.14 / 8.94)) < 1e-9);
});

test("duplicate requested-currency account totals fail closed", async () => {
  const longbridge = {
    endpoint: "https://mcp.longbridge.com/v2",
    async call(name) {
      if (name === "stock_positions") return { list: [] };
      if (name === "account_balance") return [
        { currency: "USD", net_assets: "1000" },
        { currency: "USD", net_assets: "1000" },
      ];
      if (name === "exchange_rate") return liveUsdSelfRate();
      throw new Error(`unexpected tool ${name}`);
    },
  };
  const store = { async set() {}, async get() { return null; } };
  await assert.rejects(
    new PortfolioService({ longbridge, store }).refresh(),
    /duplicate USD account totals/,
  );
});

test("portfolio service deduplicates symbols and keeps quote batches at 500", async () => {
  const symbols = Array.from({ length: 501 }, (_, index) => `T${index}.US`);
  const quoteBatches = [];
  const longbridge = {
    endpoint: "https://mcp.longbridge.com/v2",
    async call(name, args) {
      if (name === "stock_positions") {
        return { list: [{ stock_info: [
          ...symbols.map((symbol) => ({ symbol, quantity: "1", cost_price: "1", currency: "USD", market: "US" })),
          { symbol: symbols[0], quantity: "1", cost_price: "1", currency: "USD", market: "US" },
        ] }] };
      }
      if (name === "account_balance") {
        return [{ currency: "USD", net_assets: "1000000", total_cash: "1000" }];
      }
      if (name === "exchange_rate") return liveUsdSelfRate();
      if (name === "quote") {
        quoteBatches.push(args.symbols);
        return args.symbols.map((symbol) => ({
          symbol,
          last_done: "2",
          prev_close: "1.9",
          timestamp: "1767225600",
        }));
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
  const store = { async set() {}, async get() { return null; } };
  const service = new PortfolioService({ longbridge, store });
  const portfolio = await service.refresh();
  assert.equal(portfolio.positions.length, 501);
  assert.deepEqual(quoteBatches.map((batch) => batch.length).sort((a, b) => a - b), [1, 500]);
  assert.equal(new Set(quoteBatches.flat()).size, 501);
});

test("missing OPRA degrades only option valuation and still returns the real portfolio", async () => {
  const longbridge = {
    endpoint: "https://mcp.longbridge.com/v2",
    async call(name, args) {
      if (name === "stock_positions") {
        return { list: [{ stock_info: [
          { symbol: "AAPL.US", quantity: "10", cost_price: "100", currency: "USD", market: "US" },
          { symbol: "AAPL250117C250000.US", quantity: "2", cost_price: "5", currency: "USD", market: "US" },
        ] }] };
      }
      if (name === "account_balance") return [{ currency: "USD", net_assets: "10000" }];
      if (name === "exchange_rate") return liveUsdSelfRate();
      if (name === "quote") {
        return args.symbols.map((symbol) => ({ symbol, last_done: "200", timestamp: "1767225600" }));
      }
      if (name === "option_quote") throw new Error("OPRA permission required");
      throw new Error(`unexpected tool ${name}`);
    },
  };
  const store = { async set() {}, async get() { return null; } };
  const service = new PortfolioService({ longbridge, store });
  const portfolio = await service.refresh();
  assert.equal(portfolio.positions.length, 2);
  assert.equal(portfolio.status, "degraded");
  assert.equal(portfolio.positions.find((item) => item.symbol === "AAPL.US").weight, 20);
  assert.equal(
    portfolio.positions.find((item) => item.instrumentType === "option").valuationStatus,
    "unpriced",
  );
  assert.match(portfolio.dataQuality.quoteErrors[0], /OPRA permission required/);
});

test("exchange-rate 463 falls back to ECB reference rates and keeps USD portfolio weights", async () => {
  const saved = [];
  const longbridge = {
    endpoint: "https://mcp.longbridge.cn/v2",
    async call(name, args) {
      if (name === "stock_positions") {
        return { list: [{ stock_info: [{
          symbol: "AAPL.US",
          quantity: "10",
          available_quantity: "8",
          cost_price: "100",
          currency: "USD",
          market: "US",
        }] }] };
      }
      if (name === "account_balance") {
        assert.deepEqual(args, { currency: "USD" });
        return [{
          currency: "USD",
          net_assets: String(100000 * 1.1435 / 8.9653),
          total_cash: String(10000 * 1.1435 / 8.9653),
        }];
      }
      if (name === "exchange_rate") {
        const error = new Error("MCP error -32603: status error: 463 <unknown status code>");
        error.code = 463;
        error.kind = "gateway";
        throw error;
      }
      if (name === "quote") {
        return args.symbols.map((symbol) => ({
          symbol,
          last_done: "200",
          prev_close: "190",
          timestamp: "1767225600",
        }));
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
  const store = {
    async set(key, value) { saved.push([key, value]); },
    async get() { return null; },
  };
  const referenceFxProvider = {
    async latest() {
      return {
        status: "reference",
        provider: "European Central Bank",
        providerCode: "ECB",
        asOf: "2026-07-17",
        fetchedAt: "2026-07-19T08:00:00.000Z",
        sourceUrl: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
        usage: "reference_only",
        exchanges: [
          { from_currency: "EUR", to_currency: "USD", rate: "1.1435" },
          { from_currency: "EUR", to_currency: "HKD", rate: "8.9653" },
        ],
      };
    },
  };
  const service = new PortfolioService({ longbridge, store, referenceFxProvider });
  const portfolio = await service.refresh();
  const position = portfolio.positions[0];

  assert.equal(portfolio.holdingsStatus, "live");
  assert.equal(portfolio.status, "live");
  assert.equal(portfolio.account.baseCurrency, "USD");
  assert.equal(portfolio.dataQuality.fxStatus, "reference");
  assert.equal(portfolio.dataQuality.sourceErrors.length, 0);
  assert.equal(portfolio.dataQuality.sourceWarnings[0].tool, "exchange_rate");
  assert.equal(portfolio.dataQuality.sourceWarnings[0].code, 463);
  assert.equal(portfolio.fx.providerCode, "ECB");
  assert.equal(portfolio.fx.asOf, "2026-07-17");
  assert.equal(position.quantity, 10);
  assert.equal(position.availableQuantity, 8);
  assert.equal(position.costPrice, 100);
  assert.equal(position.lastPrice, 200);
  assert.equal(position.valuationStatus, "priced");
  assert.equal(position.marketValueBase, 2000);
  assert.ok(Math.abs(position.weight - (2000 / (100000 * 1.1435 / 8.9653)) * 100) < 1e-9);
  assert.equal(saved.some(([key]) => key === "portfolioSnapshot"), true);
});

test("both Longbridge and ECB FX failures preserve holdings but suspend cross-currency weights", async () => {
  const longbridge = {
    endpoint: "https://mcp.longbridge.cn/v2",
    async call(name, args) {
      if (name === "stock_positions") {
        return { list: [{ stock_info: [{
          symbol: "AAPL.US",
          quantity: "10",
          available_quantity: "8",
          cost_price: "100",
          currency: "HKD",
          market: "US",
        }] }] };
      }
      if (name === "account_balance") {
        assert.deepEqual(args, { currency: "USD" });
        return [{ currency: "USD", net_assets: "12755", total_cash: "1275.5" }];
      }
      if (name === "exchange_rate") {
        const error = new Error("status error: 463");
        error.code = 463;
        error.kind = "gateway";
        throw error;
      }
      if (name === "quote") {
        return args.symbols.map((symbol) => ({
          symbol,
          last_done: "200",
          timestamp: "1767225600",
        }));
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
  const referenceFxProvider = {
    async latest() { throw new Error("ECB offline"); },
  };
  const store = { async set() {}, async get() { return null; } };
  const portfolio = await new PortfolioService({
    longbridge,
    store,
    referenceFxProvider,
  }).refresh();

  assert.equal(portfolio.holdingsStatus, "live");
  assert.equal(portfolio.status, "degraded");
  assert.equal(portfolio.dataQuality.fxStatus, "unavailable");
  assert.deepEqual(
    portfolio.dataQuality.sourceErrors.map((item) => item.tool),
    ["exchange_rate", "ecb_reference_rates"],
  );
  assert.equal(portfolio.positions[0].valuationStatus, "native_only");
  assert.equal(portfolio.positions[0].weight, null);
});

test("core position failure remains fatal and never overwrites the portfolio snapshot", async () => {
  const saved = [];
  const longbridge = {
    endpoint: "https://mcp.longbridge.cn/v2",
    async call(name) {
      if (name === "stock_positions") throw new Error("status error: 463");
      throw new Error(`unexpected tool ${name}`);
    },
  };
  const store = {
    async set(key, value) { saved.push([key, value]); },
    async get() { return null; },
  };
  const service = new PortfolioService({ longbridge, store });
  await assert.rejects(service.refresh(), /463/);
  assert.equal(saved.some(([key]) => key === "portfolioSnapshot"), false);
});

test("exchange-rate auth failures are never hidden as a degraded snapshot", async () => {
  const saved = [];
  const longbridge = {
    endpoint: "https://mcp.longbridge.cn/v2",
    async call(name) {
      if (name === "stock_positions") return { list: [] };
      if (name === "account_balance") return [{ currency: "USD", net_assets: "1000" }];
      if (name === "exchange_rate") {
        const error = new Error("401003 token expired");
        error.kind = "auth";
        error.code = 401;
        throw error;
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
  const store = {
    async set(key, value) { saved.push([key, value]); },
    async get() { return null; },
  };
  const service = new PortfolioService({ longbridge, store });
  await assert.rejects(service.refresh(), /token expired/);
  assert.equal(saved.some(([key]) => key === "portfolioSnapshot"), false);
});

test("quote transport failures are never hidden as missing market data", async () => {
  const saved = [];
  const longbridge = {
    endpoint: "https://mcp.longbridge.com/v2",
    async call(name) {
      if (name === "stock_positions") {
        return { list: [{ stock_info: [{ symbol: "AAPL.US", quantity: "1", currency: "USD" }] }] };
      }
      if (name === "account_balance") return [{ currency: "USD", net_assets: "1000" }];
      if (name === "exchange_rate") return liveUsdSelfRate();
      if (name === "quote") {
        const error = new Error("Streamable HTTP transport closed");
        error.kind = "transport";
        throw error;
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
  const store = {
    async set(key, value) { saved.push([key, value]); },
    async get() { return null; },
  };
  const service = new PortfolioService({ longbridge, store });
  await assert.rejects(service.refresh(), /transport closed/);
  assert.equal(saved.some(([key]) => key === "portfolioSnapshot"), false);
});

test("concurrent refresh requests share one real Longbridge synchronization", async () => {
  const calls = new Map();
  const longbridge = {
    endpoint: "https://mcp.longbridge.com/v2",
    async call(name) {
      calls.set(name, (calls.get(name) ?? 0) + 1);
      if (name === "stock_positions") return { list: [] };
      if (name === "account_balance") return [{ currency: "USD", net_assets: "1000" }];
      if (name === "exchange_rate") return liveUsdSelfRate();
      throw new Error(`unexpected tool ${name}`);
    },
  };
  const store = { async set() {}, async get() { return null; } };
  const service = new PortfolioService({ longbridge, store });
  const [first, second] = await Promise.all([service.refresh(), service.refresh()]);
  assert.equal(first.syncedAt, second.syncedAt);
  assert.equal(calls.get("stock_positions"), 1);
  assert.equal(calls.get("account_balance"), 1);
  assert.equal(calls.get("exchange_rate"), 1);
});

test("account and FX requests start while positions are still in flight", async () => {
  let resolvePositions;
  const positionsGate = new Promise((resolve) => { resolvePositions = resolve; });
  const started = [];
  const longbridge = {
    endpoint: "https://mcp.longbridge.com/v2",
    async call(name) {
      started.push(name);
      if (name === "stock_positions") return positionsGate;
      if (name === "account_balance") return [{ currency: "USD", net_assets: "1000" }];
      if (name === "exchange_rate") return liveUsdSelfRate();
      throw new Error(`unexpected tool ${name}`);
    },
  };
  const store = { async set() {}, async get() { return null; } };
  const service = new PortfolioService({ longbridge, store });
  const refresh = service.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(new Set(started), new Set([
    "stock_positions",
    "account_balance",
    "exchange_rate",
  ]));
  resolvePositions({ list: [] });
  await refresh;
});

test("daily candles reuse the two-minute in-memory cache", async () => {
  let candleCalls = 0;
  const longbridge = {
    endpoint: "https://mcp.longbridge.com/v2",
    async call(name, args) {
      assert.equal(name, "candlesticks");
      candleCalls += 1;
      assert.equal(args.count, 260);
      return [{
        timestamp: "1767225600",
        open: "100",
        high: "102",
        low: "99",
        close: "101",
        volume: "1000",
      }];
    },
  };
  const store = { async set() {}, async get() { return null; } };
  const service = new PortfolioService({ longbridge, store });
  const first = await service.candles("AAPL.US");
  first[0].close = 0;
  const second = await service.candles("AAPL.US");
  assert.equal(candleCalls, 1);
  assert.equal(second[0].close, 101);
});
