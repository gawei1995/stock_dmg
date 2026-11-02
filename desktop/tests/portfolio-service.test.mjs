import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeLongbridgeExchangeRates,
  PortfolioService,
  PORTFOLIO_SNAPSHOT_SCHEMA_VERSION,
  selectCompletedMarketSeriesBars,
} from "../src/data/portfolio-service.mjs";
import { buildFxGraph, findConversionRate } from "../src/data/normalize.mjs";
import { LongbridgeClient } from "../src/mcp/longbridge-client.mjs";

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
  assert.equal(portfolio.freshness.state, "fresh");
  assert.equal(portfolio.freshness.snapshotFreshForSizing, true);
  assert.equal(portfolio.freshness.freshForSizing, false);
  assert.equal(portfolio.valuationGate.outcome.status, "block");
  assert.ok(portfolio.valuationGate.outcome.blockingReasonCodes.includes(
    "quote_older_than_latest_completed_session",
  ));
  assert.ok(portfolio.valuationGate.outcome.blockingReasonCodes.includes(
    "net_asset_reconciliation_failed",
  ));
  assert.equal(portfolio.accountScopeIdentity.status, "unverified");
  assert.equal(portfolio.accountScopeIdentity.scopeId, null);
  assert.doesNotMatch(JSON.stringify(portfolio.accountScopeIdentity), /117679|7709/);
});

test("portfolio derives an opaque account scope before raw broker identifiers are discarded", async () => {
  const longbridge = {
    endpoint: "https://mcp.longbridge.com/v2",
    async call(name) {
      if (name === "stock_positions") return {
        list: [{
          account_id: "REAL-BROKER-ACCOUNT-42",
          account_channel: "margin",
          stock_info: [],
        }],
      };
      if (name === "account_balance") return [{
        account_id: "REAL-BROKER-ACCOUNT-42",
        currency: "USD",
        net_assets: "1000",
        total_cash: "1000",
        buy_power: "1000",
      }];
      if (name === "exchange_rate") return liveUsdSelfRate();
      if (name === "quote" || name === "option_quote") return [];
      throw new Error(`unexpected tool ${name}`);
    },
  };
  const portfolio = await new PortfolioService({
    longbridge,
    store: { async set() {}, async get() { return null; } },
  }).refresh();
  assert.equal(portfolio.accountScopeIdentity.status, "verified");
  assert.match(portfolio.accountScopeIdentity.scopeId, /^broker-scope-v1-[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(portfolio), /REAL-BROKER-ACCOUNT-42/);
});

test("portfolio service attaches a passing gate for a coherent official close valuation", async () => {
  const assessedAt = "2026-08-30T16:00:00.000Z";
  const quoteAt = "2026-08-28T19:59:00.000Z";
  const longbridge = coherentUsdLongbridge({ quoteAt });
  const saved = [];
  const portfolio = await new PortfolioService({
    longbridge,
    store: {
      async set(key, value) { saved.push([key, value]); },
      async get() { return null; },
    },
    clock: () => Date.parse(assessedAt),
  }).refresh();

  assert.equal(portfolio.syncedAt, assessedAt);
  assert.equal(portfolio.valuationGate.outcome.status, "pass");
  assert.equal(portfolio.valuationGate.positions[0].quote.state, "accepted_market_closed");
  assert.match(portfolio.valuationGate.hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(portfolio.freshness.state, "fresh");
  assert.equal(portfolio.freshness.valuationGate.valid, true);
  assert.equal(portfolio.freshness.freshForSizing, true);
  assert.equal(saved.at(-1)[1].valuationGate.hash, portfolio.valuationGate.hash);
});

test("portfolio service keeps the account snapshot fresh but blocks sizing on one stale live mark", async () => {
  const assessedAt = "2026-08-31T14:00:00.000Z";
  const longbridge = coherentUsdLongbridge({ quoteAt: "2026-08-31T13:50:00.000Z" });
  const portfolio = await new PortfolioService({
    longbridge,
    store: { async set() {}, async get() { return null; } },
    clock: () => new Date(assessedAt),
  }).refresh();

  assert.equal(portfolio.freshness.state, "fresh");
  assert.equal(portfolio.freshness.snapshotFreshForSizing, true);
  assert.equal(portfolio.freshness.freshForSizing, false);
  assert.equal(portfolio.status, "degraded");
  assert.equal(portfolio.valuationGate.accountSync.status, "pass");
  assert.equal(portfolio.valuationGate.positions[0].quote.state, "stale_active");
  assert.ok(portfolio.valuationGate.outcome.blockingReasonCodes.includes(
    "quote_stale_active_session",
  ));
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
  const cached = await currentService.cachedPortfolio();
  assert.equal(cached.endpoint, longbridge.endpoint);
  assert.equal(cached.valuationSchemaVersion, PORTFOLIO_SNAPSHOT_SCHEMA_VERSION);
  assert.deepEqual(cached.account, { netAssets: 117679.86 });
  assert.equal(cached.status, "cached");
  assert.equal(cached.holdingsStatus, "cached");
  assert.equal(cached.freshness.state, "cached");
  assert.equal(cached.freshness.freshForSizing, false);
  assert.equal(cached.freshness.valuationGate.reason, "valuation_gate_missing");
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

test("new holdings are saved on repeated refresh despite an isError=false option permission failure", async () => {
  const saved = new Map();
  const store = { async get(key) { return saved.get(key); }, async set(key, value) { saved.set(key, value); } };
  const longbridge = new LongbridgeClient({ store, openExternal: async () => {} });
  let includeOption = false;
  longbridge.transport = { async close() { assert.fail("market-data permission must not disconnect holdings"); } };
  longbridge.client = { async callTool({ name, arguments: args }) {
    let payload;
    if (name === "stock_positions") payload = { list: [{ account_id: "test-account", stock_info: [
      { symbol: "AAPL.US", quantity: "10", cost_price: "100", currency: "USD", market: "US" },
      ...(includeOption ? [{ symbol: "TEST260918P100000.US", quantity: "2", cost_price: "1", currency: "USD", market: "US" }] : []),
    ] }] };
    else if (name === "account_balance") payload = [{ currency: "USD", net_assets: "10000", total_cash: "8000", buy_power: "16000" }];
    else if (name === "exchange_rate") payload = liveUsdSelfRate();
    else if (name === "quote") payload = args.symbols.map((symbol) => ({ symbol, last_done: "200", timestamp: "1767225600" }));
    else if (name === "option_quote") payload = { error_code: 301604, message: "no quote access", recoverable: "none" };
    else assert.fail(`unexpected tool ${name}`);
    return { isError: false, content: [{ type: "text", text: JSON.stringify(payload) }] };
  } };
  for (const name of ["stock_positions", "account_balance", "exchange_rate", "quote", "option_quote"]) longbridge.tools.set(name, {});
  const service = new PortfolioService({ longbridge, store });
  assert.equal((await service.refresh()).positions.length, 1);
  includeOption = true;
  for (let repeat = 0; repeat < 2; repeat += 1) {
    const portfolio = await service.refresh();
    assert.equal(portfolio.positions.length, 2);
    assert.equal(portfolio.positions.find((p) => p.symbol === "AAPL.US").weight, 20);
    const option = portfolio.positions.find((p) => p.instrumentType === "option");
    assert.equal(option.quantity, 2);
    assert.equal(option.marketValueBase, null);
    assert.equal(option.weight, null);
    assert.match(portfolio.dataQuality.quoteErrors[0], /TEST260918P100000.US.*301604.*no quote access/);
    assert.equal(portfolio.freshness.state, "fresh");
    assert.equal(portfolio.freshness.freshForSizing, false);
    assert.equal(saved.get("portfolioSnapshot").positions.length, 2);
    assert.equal(longbridge.connected, true);
  }
});

test("empty or malformed quote payloads are visible per-symbol failures, never silent successes", async () => {
  for (const payload of [[], { list: [] }, { unexpected: [] }]) {
    const longbridge = {
      endpoint: "https://mcp.longbridge.com/v2",
      async call(name) {
        if (name === "stock_positions") return { list: [{ stock_info: [
          { symbol: "AAPL.US", quantity: "1", cost_price: "100", currency: "USD", market: "US" },
        ] }] };
        if (name === "account_balance") return [{ currency: "USD", net_assets: "1000" }];
        if (name === "exchange_rate") return liveUsdSelfRate();
        if (name === "quote") return payload;
        assert.fail(`unexpected tool ${name}`);
      },
    };
    const service = new PortfolioService({ longbridge, store: { async get() {}, async set() {} } });
    const portfolio = await service.refresh();
    assert.equal(portfolio.positions.length, 1);
    assert.equal(portfolio.positions[0].quantity, 1);
    assert.equal(portfolio.positions[0].marketValueBase, null);
    assert.equal(portfolio.dataQuality.quoteErrors.length, 1);
    assert.match(portfolio.dataQuality.quoteErrors[0], /AAPL.US/);
    assert.equal(portfolio.freshness.freshForSizing, false);
  }
});

test("USD-only portfolio marks fallback FX as not required while keeping weights", async () => {
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
  assert.equal(portfolio.status, "degraded");
  assert.equal(portfolio.dataQuality.valuationComplete, true);
  assert.equal(portfolio.freshness.snapshotFreshForSizing, true);
  assert.equal(portfolio.freshness.freshForSizing, false);
  assert.equal(portfolio.valuationGate.outcome.status, "block");
  assert.equal(portfolio.account.baseCurrency, "USD");
  assert.equal(portfolio.dataQuality.fxStatus, "not_required");
  assert.equal(portfolio.dataQuality.fxRequired, false);
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

function coherentUsdLongbridge({ quoteAt }) {
  const quoteTimestamp = String(Math.floor(Date.parse(quoteAt) / 1000));
  return {
    endpoint: "https://mcp.longbridge.com/v2",
    async call(name, args) {
      if (name === "stock_positions") {
        return { list: [{ stock_info: [{
          symbol: "AAPL.US",
          quantity: "10",
          available_quantity: "10",
          cost_price: "100",
          currency: "USD",
          market: "US",
        }] }] };
      }
      if (name === "account_balance") {
        assert.deepEqual(args, { currency: "USD" });
        return [{
          currency: "USD",
          net_assets: "10000",
          total_cash: "8000",
          buy_power: "8000",
        }];
      }
      if (name === "exchange_rate") return liveUsdSelfRate();
      if (name === "quote") {
        return args.symbols.map((symbol) => ({
          symbol,
          last_done: "200",
          prev_close: "198",
          timestamp: quoteTimestamp,
        }));
      }
      if (name === "option_quote") return [];
      throw new Error(`unexpected tool ${name}`);
    },
  };
}

test("USD-only portfolio stays live when both FX providers fail", async () => {
  const base = coherentUsdLongbridge({ quoteAt: "2026-08-28T19:59:00.000Z" });
  const longbridge = {
    ...base,
    async call(name, args) {
      if (name === "exchange_rate") {
        const error = new Error("status error: 463");
        error.code = 463;
        error.kind = "gateway";
        throw error;
      }
      return base.call(name, args);
    },
  };
  const statuses = [];
  const portfolio = await new PortfolioService({
    longbridge,
    store: { async set() {}, async get() { return null; } },
    referenceFxProvider: { async latest() { throw new Error("ECB offline"); } },
    onStatus: (value) => statuses.push(value),
    clock: () => Date.parse("2026-08-30T16:00:00.000Z"),
  }).refresh();

  assert.equal(portfolio.status, "live");
  assert.equal(portfolio.dataQuality.valuationComplete, true);
  assert.equal(portfolio.dataQuality.fxStatus, "not_required");
  assert.equal(portfolio.dataQuality.fxRequired, false);
  assert.equal(portfolio.dataQuality.sourceErrors.length, 0);
  assert.equal(portfolio.dataQuality.ignoredFxErrors.length, 2);
  assert.equal(statuses.at(-1).state, "ready");
  assert.doesNotMatch(statuses.at(-1).message, /汇率不可用|跨币种/);
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
  const sameGeneration = () => true;
  const [first, second] = await Promise.all([
    service.refresh({ commitGuard: sameGeneration }),
    service.refresh({ commitGuard: sameGeneration }),
  ]);
  assert.equal(first.syncedAt, second.syncedAt);
  assert.equal(calls.get("stock_positions"), 1);
  assert.equal(calls.get("account_balance"), 1);
  assert.equal(calls.get("exchange_rate"), 1);
});

test("a refresh that returns after authorization rotation cannot repopulate the portfolio cache", async () => {
  let resolvePositions;
  const positionsGate = new Promise((resolve) => { resolvePositions = resolve; });
  const saved = [];
  const longbridge = {
    endpoint: "https://mcp.longbridge.com/v2",
    async call(name) {
      if (name === "stock_positions") return positionsGate;
      if (name === "account_balance") {
        return [{
          account_id: "OLD-ACCOUNT",
          currency: "USD",
          net_assets: "1000",
          total_cash: "1000",
          buy_power: "1000",
        }];
      }
      if (name === "exchange_rate") return liveUsdSelfRate();
      throw new Error(`unexpected tool ${name}`);
    },
  };
  const store = {
    async set(key, value) { saved.push([key, structuredClone(value)]); },
    async get() { return null; },
  };
  let currentGeneration = 4;
  const statuses = [];
  const service = new PortfolioService({
    longbridge,
    store,
    onStatus: (status) => statuses.push(status),
  });
  const refresh = service.refresh({ commitGuard: () => currentGeneration === 4 });
  await new Promise((resolve) => setImmediate(resolve));

  currentGeneration = 5;
  resolvePositions({ list: [{ account_id: "OLD-ACCOUNT", stock_info: [] }] });
  await assert.rejects(refresh, (error) => {
    assert.equal(error.code, "STALE_LONGBRIDGE_AUTHORIZATION_GENERATION");
    return true;
  });
  assert.equal(saved.some(([key]) => key === "portfolioSnapshot"), false);
  assert.deepEqual(statuses.map((item) => item.phase ?? item.state), ["positions"]);
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
      assert.equal(args.count, 1000);
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

test("daily candle cache prunes expired rows and remains bounded at 100 entries", async () => {
  let candleCalls = 0;
  const longbridge = {
    endpoint: "https://mcp.longbridge.com/v2",
    async call(name) {
      assert.equal(name, "candlesticks");
      candleCalls += 1;
      return [{
        timestamp: "1767243600",
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
  service.candleCache.set("EXPIRED.US:1000", {
    fetchedAt: Date.now() - 10 * 60 * 1000,
    candles: [],
  });
  const oldestLiveKey = "LIVE0.US:1000";
  for (let index = 0; index < 100; index += 1) {
    service.candleCache.set(`LIVE${index}.US:1000`, {
      fetchedAt: Date.now(),
      candles: [],
    });
  }

  const [bar] = await service.candles("NEW.US");
  assert.equal(candleCalls, 1);
  assert.equal(service.candleCache.size, 100);
  assert.equal(service.candleCache.has("EXPIRED.US:1000"), false);
  assert.equal(service.candleCache.has(oldestLiveKey), false);
  assert.equal(service.candleCache.has("NEW.US:1000"), true);
  assert.equal(bar.symbol, "NEW.US");
  assert.equal(bar.market, "US");
  assert.ok(bar.tradeDate);
});

test("daily candles survive service restart through encrypted persistent history", async () => {
  const values = new Map();
  const store = {
    async get(key) {
      return values.has(key) ? structuredClone(values.get(key)) : null;
    },
    async set(key, value) {
      values.set(key, structuredClone(value));
    },
  };
  const endpoint = "https://mcp.longbridge.com/v2";
  const online = new PortfolioService({
    store,
    longbridge: {
      endpoint,
      async call(name) {
        assert.equal(name, "candlesticks");
        return [{
          timestamp: "1767243600",
          open: "100",
          high: "102",
          low: "99",
          close: "101",
          volume: "1000",
        }];
      },
    },
  });
  assert.equal((await online.candles("AAPL.US"))[0].close, 101);

  let offlineCalls = 0;
  const restored = new PortfolioService({
    store,
    longbridge: {
      endpoint,
      async call() {
        offlineCalls += 1;
        throw new Error("offline");
      },
    },
  });
  const [cached] = await restored.candles("AAPL.US");
  assert.equal(offlineCalls, 1);
  assert.equal(cached.close, 101);
});

test("review candle reads can prefer persistent history without waiting for Longbridge", async () => {
  const values = new Map();
  const store = {
    async get(key) {
      return values.has(key) ? structuredClone(values.get(key)) : null;
    },
    async set(key, value) {
      values.set(key, structuredClone(value));
    },
  };
  const endpoint = "https://mcp.longbridge.com/v2";
  const seeded = new PortfolioService({
    store,
    longbridge: {
      endpoint,
      async call() {
        return [{
          timestamp: "1767243600",
          open: "100",
          high: "102",
          low: "99",
          close: "101",
          volume: "1000",
        }];
      },
    },
  });
  await seeded.candles("QQQ.US");

  let liveCalls = 0;
  const review = new PortfolioService({
    store,
    longbridge: {
      endpoint,
      connected: false,
      async call() {
        liveCalls += 1;
        throw new Error("should not run");
      },
    },
  });
  const [cached] = await review.candles("QQQ.US", 600, { preferPersistent: true });
  assert.equal(liveCalls, 0);
  assert.equal(cached.close, 101);
});

test("candlesWithCoverage returns complete fresh persistent evidence without a live call", async () => {
  let liveCalls = 0;
  const fetchedAt = new Date(Date.now() - 60_000).toISOString();
  const candles = normalizedDailyBars(21);
  const service = new PortfolioService({
    store: { async get() { return null; }, async set() {} },
    marketHistoryStore: {
      async getSeries() {
        return { candles, fetchedAt, storedAt: fetchedAt, candleCount: candles.length };
      },
      async putSeries() { throw new Error("unexpected write"); },
    },
    longbridge: {
      endpoint: "https://mcp.longbridge.com/v2",
      connected: true,
      async call() { liveCalls += 1; throw new Error("unexpected live call"); },
    },
  });

  const result = await service.candlesWithCoverage("AAPL.US", 21, { preferPersistent: true });
  assert.equal(liveCalls, 0);
  assert.equal(result.candles.length, 21);
  assert.deepEqual(result.coverage, {
    source: "persistent",
    originSource: null,
    coverageStatus: "complete",
    complete: true,
    partial: false,
    partialReasons: [],
    fetchedAt,
    storedAt: fetchedAt,
    cacheAgeMs: result.coverage.cacheAgeMs,
    requestedCount: 21,
    returnedCount: 21,
    latestTradeDate: "2026-01-21",
    endpoint: "https://mcp.longbridge.com/v2",
    period: "day",
    adjustment: "forward",
    tradeSessions: "intraday",
    refreshAttempted: false,
    fallbackReason: null,
    persistenceStatus: null,
  });
  assert.ok(result.coverage.cacheAgeMs >= 0);
});

test("requireLive bypasses a fresh persistent series for Agent sizing evidence", async () => {
  let liveCalls = 0;
  const fetchedAt = new Date(Date.now() - 60_000).toISOString();
  const service = new PortfolioService({
    store: { async get() { return null; }, async set() {} },
    marketHistoryStore: {
      async getSeries() {
        return {
          candles: normalizedDailyBars(21),
          fetchedAt,
          storedAt: fetchedAt,
        };
      },
      async putSeries(input) {
        return {
          candles: input.candles,
          fetchedAt: input.fetchedAt,
          storedAt: input.fetchedAt,
        };
      },
    },
    longbridge: {
      endpoint: "https://mcp.longbridge.com/v2",
      connected: true,
      async call() {
        liveCalls += 1;
        return rawDailyBars(21);
      },
    },
  });

  const result = await service.candlesWithCoverage("AAPL.US", 21, {
    preferPersistent: true,
    requireLive: true,
  });
  assert.equal(liveCalls, 1);
  assert.equal(result.coverage.source, "live");
});

test("insufficient persistent history is an explicit partial fallback when Longbridge is disconnected", async () => {
  let liveCalls = 0;
  const fetchedAt = new Date(Date.now() - 60_000).toISOString();
  const service = new PortfolioService({
    store: { async get() { return null; }, async set() {} },
    marketHistoryStore: {
      async getSeries() {
        return { candles: normalizedDailyBars(3), fetchedAt, storedAt: fetchedAt };
      },
      async putSeries() { return null; },
    },
    longbridge: {
      endpoint: "https://mcp.longbridge.com/v2",
      connected: false,
      async call() { liveCalls += 1; throw new Error("must not run"); },
    },
  });

  const result = await service.candlesWithCoverage("AAPL.US", 21, { preferPersistent: true });
  assert.equal(liveCalls, 0);
  assert.equal(result.coverage.source, "persistent_fallback");
  assert.equal(result.coverage.coverageStatus, "partial");
  assert.equal(result.coverage.refreshAttempted, false);
  assert.deepEqual(new Set(result.coverage.partialReasons), new Set([
    "insufficient_history",
    "live_refresh_failed",
  ]));
  assert.equal(result.coverage.fallbackReason.code, "LONGBRIDGE_DISCONNECTED");
});

test("stale persistent history attempts a bounded live refresh then returns a marked fallback", async () => {
  let liveCalls = 0;
  const staleAt = "2026-01-01T00:00:00.000Z";
  const service = new PortfolioService({
    store: { async get() { return null; }, async set() {} },
    marketHistoryStore: {
      async getSeries() {
        return { candles: normalizedDailyBars(21), fetchedAt: staleAt, storedAt: staleAt };
      },
      async putSeries() { return null; },
    },
    longbridge: {
      endpoint: "https://mcp.longbridge.com/v2",
      connected: true,
      async call() { liveCalls += 1; return new Promise(() => {}); },
    },
  });

  const result = await service.candlesWithCoverage("AAPL.US", 21, {
    preferPersistent: true,
    liveRefreshTimeoutMs: 5,
  });
  assert.equal(liveCalls, 1);
  assert.equal(result.coverage.source, "persistent_fallback");
  assert.equal(result.coverage.refreshAttempted, true);
  assert.equal(result.coverage.partial, true);
  assert.ok(result.coverage.partialReasons.includes("stale_cache"));
  assert.equal(result.coverage.fallbackReason.code, "CANDLE_REFRESH_TIMEOUT");
});

test("identical concurrent candle reads reuse one descriptor-level live request", async () => {
  let liveCalls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = new PortfolioService({
    store: { async get() { return null; }, async set() {} },
    marketHistoryStore: {
      async getSeries() { return null; },
      async putSeries(input) {
        return {
          candles: input.candles,
          fetchedAt: input.fetchedAt,
          storedAt: input.fetchedAt,
        };
      },
    },
    longbridge: {
      endpoint: "https://mcp.longbridge.com/v2",
      connected: true,
      async call() { liveCalls += 1; await gate; return rawDailyBars(21); },
    },
  });

  const first = service.candlesWithCoverage("AAPL.US", 21);
  const second = service.candlesWithCoverage("aapl.us", 21);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(liveCalls, 1);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.coverage.source, "live");
  assert.equal(right.coverage.source, "live");
  assert.equal(left.candles.length, 21);
  left.candles[0].close = 0;
  assert.notEqual(right.candles[0].close, 0);
});

test("live candle normalization rejects null and empty OHLC instead of creating zero prices", async () => {
  const service = new PortfolioService({
    store: { async get() { return null; }, async set() {} },
    marketHistoryStore: {
      async getSeries() { return null; },
      async putSeries() { throw new Error("invalid rows must not be persisted"); },
    },
    longbridge: {
      endpoint: "https://mcp.longbridge.com/v2",
      async call() {
        return [
          { ...rawDailyBars(1)[0], close: null },
          { ...rawDailyBars(1)[0], open: "" },
        ];
      },
    },
  });
  await assert.rejects(service.candles("AAPL.US", 21), /no_valid_daily_candles/);
});

test("hourly market series keeps same-day bars and excludes an unconfirmed terminal bar", async () => {
  const calls = [];
  const rows = [
    hourlyBar("2026-08-28T13:30:00.000Z", 100),
    hourlyBar("2026-08-28T14:30:00.000Z", 101),
    hourlyBar("2026-08-28T15:30:00.000Z", 102),
  ];
  const marketSeriesStore = {
    async getSeries() { return null; },
    async putSeries(input) {
      return {
        fetchedAt: input.fetchedAt,
        storedAt: input.fetchedAt,
        bars: input.bars,
      };
    },
  };
  const service = new PortfolioService({
    longbridge: {
      endpoint: "https://mcp.longbridge.sg/mcp",
      connected: true,
      async call(name, args) {
        calls.push([name, args]);
        return { candlesticks: rows };
      },
    },
    store: { async get() { return null; }, async set() {} },
    marketSeriesStore,
  });

  const result = await service.marketSeriesWithCoverage("AAPL.US", "1h", 3, {
    requireLive: true,
  });

  assert.equal(result.bars.length, 3);
  assert.equal(result.completedBars.length, 2);
  assert.equal(result.completedBarsOnly, true);
  assert.equal(result.finality.terminalBarStatus, "unconfirmed_terminal_excluded");
  assert.equal(result.coverage.period, "1h");
  assert.deepEqual(calls[0], ["candlesticks", {
    symbol: "AAPL.US",
    period: "1h",
    count: 3,
    forward_adjust: true,
    trade_sessions: "intraday",
  }]);
});

test("provider-confirmed terminal hourly bar is admitted but a forming bar is not", () => {
  const completed = selectCompletedMarketSeriesBars([
    hourlyBar("2026-08-28T13:30:00.000Z", 100),
    { ...hourlyBar("2026-08-28T14:30:00.000Z", 101), isClosed: true },
  ], "1h");
  assert.equal(completed.bars.length, 2);
  assert.equal(completed.terminalBarStatus, "provider_confirmed_closed");

  const forming = selectCompletedMarketSeriesBars([
    hourlyBar("2026-08-28T13:30:00.000Z", 100),
    { ...hourlyBar("2026-08-28T14:30:00.000Z", 101), barStatus: "forming" },
  ], "1h");
  assert.equal(forming.bars.length, 1);
  assert.equal(forming.terminalBarStatus, "provider_marked_forming");
});

test("one unlabelled hourly bar cannot be attested as completed", () => {
  const result = selectCompletedMarketSeriesBars([
    hourlyBar("2026-08-28T13:30:00.000Z", 100),
  ], "1h");
  assert.equal(result.attested, false);
  assert.deepEqual(result.bars, []);
  assert.equal(result.terminalBarStatus, "unconfirmed_terminal_excluded");
});

function hourlyBar(timestamp, close) {
  return {
    timestamp,
    trade_date: timestamp.slice(0, 10),
    open: String(close - 0.25),
    high: String(close + 0.5),
    low: String(close - 0.5),
    close: String(close),
    volume: "1000",
    trade_session: "Intraday",
  };
}

function normalizedDailyBars(count) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, 1 + index));
    const tradeDate = date.toISOString().slice(0, 10);
    return {
      timestamp: `${tradeDate}T05:00:00.000Z`,
      tradeDate,
      timestampBasis: "exchange_trade_date_midnight",
      symbol: "AAPL.US",
      market: "US",
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
      volume: 1000,
      tradeSession: "Intraday",
    };
  });
}

function rawDailyBars(count) {
  return normalizedDailyBars(count).map((bar) => ({
    timestamp: String(Date.parse(bar.timestamp) / 1000),
    open: String(bar.open),
    high: String(bar.high),
    low: String(bar.low),
    close: String(bar.close),
    volume: String(bar.volume),
  }));
}
