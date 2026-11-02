import assert from "node:assert/strict";
import test from "node:test";
import {
  TRADINGVIEW_MCP_URL, TRADINGVIEW_READ_ONLY_TOOLS,
  isOfficialTradingViewMcpUrl, tradingViewReadOnlyOverride,
} from "../src/engine/tradingview-mcp-policy.mjs";

test("official TradingView endpoint accepts only its exact HTTPS URL and default port", () => {
  assert.equal(TRADINGVIEW_MCP_URL, "https://mcp.tradingview.com/mcp");
  assert.equal(isOfficialTradingViewMcpUrl(TRADINGVIEW_MCP_URL), true);
  assert.equal(isOfficialTradingViewMcpUrl("https://mcp.tradingview.com:443/mcp"), true);
  for (const url of [undefined, null, 123, {}, "", "http://mcp.tradingview.com/mcp",
    "https://mcp.tradingview.com:8443/mcp", "https://mcp.tradingview.com.evil.test/mcp",
    "https://evil.test/mcp", "https://mcp.tradingview.com./mcp", "https://mcp.tradingview.com/",
    "https://mcp.tradingview.com/mcp/", "https://mcp.tradingview.com/MCP",
    "https://mcp.tradingview.com/other/../mcp", "https://mcp.tradingview.com/%6dcp",
    "https://user:secret@mcp.tradingview.com/mcp", "https://@mcp.tradingview.com/mcp",
    `${TRADINGVIEW_MCP_URL}?`, `${TRADINGVIEW_MCP_URL}?token=synthetic`, `${TRADINGVIEW_MCP_URL}#`,
    `${TRADINGVIEW_MCP_URL}#section`, ` ${TRADINGVIEW_MCP_URL}`, `${TRADINGVIEW_MCP_URL}\n`,
    "https://mcp.tradingview.com/\nmcp", "https:\\mcp.tradingview.com\\mcp",
  ]) assert.equal(isOfficialTradingViewMcpUrl(url), false, String(url));
});

test("read-only capabilities are the fixed reviewed list, not name or annotation heuristics", () => {
  assert.deepEqual(TRADINGVIEW_READ_ONLY_TOOLS, [
    "list_watchlists", "get_watchlist", "get_ohlcv", "get_economic_data",
    "get_economic_symbols", "search_symbols", "get_symbol_data", "run_screener",
    "get_symbol_data_batch", "get_screener_columns", "get_technicals_rating",
    "get_news", "get_news_story", "get_forecasts", "get_financials",
    "get_financial_history", "get_documents", "get_document_view",
    "get_earnings_calendar", "get_economic_calendar", "get_dividends_calendar",
    "list_alerts", "get_alerts", "get_alerts_log",
  ]);
  assert.equal(Object.isFrozen(TRADINGVIEW_READ_ONLY_TOOLS), true);
  assert.equal(new Set(TRADINGVIEW_READ_ONLY_TOOLS).size, 24);
  for (const name of ["get_active_watchlist", "create_watchlist", "add_symbols_to_watchlist",
    "delete_watchlist", "create_alert", "delete_alert", "get_future_unknown_tool", "*"]) {
    assert.equal(TRADINGVIEW_READ_ONLY_TOOLS.includes(name), false, name);
  }
});

test("default session patch adds only an allowlist and an empty denylist", () => {
  const result = tradingViewReadOnlyOverride({ url: TRADINGVIEW_MCP_URL });
  assert.deepEqual(result, { enabled_tools: [...TRADINGVIEW_READ_ONLY_TOOLS], disabled_tools: [] });
  assert.notEqual(result.enabled_tools, TRADINGVIEW_READ_ONLY_TOOLS);
});

test("a configured allowlist is narrowed and all existing denials are preserved", () => {
  const config = Object.freeze({
    url: TRADINGVIEW_MCP_URL, enabled: true, required: true,
    enabled_tools: Object.freeze(["get_news", "get_ohlcv", "get_news", "get_active_watchlist", "create_alert", "unknown"]),
    disabled_tools: Object.freeze(["get_news", "unknown", "get_news"]),
    startup_timeout_sec: 3, tool_timeout_sec: 4,
  });
  const result = tradingViewReadOnlyOverride(config);
  assert.deepEqual(result, {
    enabled_tools: ["get_ohlcv", "get_news"],
    disabled_tools: ["get_news", "unknown", "get_news"],
  });
  assert.notEqual(result.disabled_tools, config.disabled_tools);
  const merged = { ...config, ...result };
  assert.equal(merged.required, true);
  assert.equal(merged.enabled, true);
  assert.equal(merged.startup_timeout_sec, 3);
  assert.equal(merged.tool_timeout_sec, 4);
  assert.equal(merged.url, TRADINGVIEW_MCP_URL);
  result.disabled_tools.push("get_ohlcv");
  assert.deepEqual(config.disabled_tools, ["get_news", "unknown", "get_news"]);
});

test("an explicitly empty or nonmatching allowlist never becomes the default allowlist", () => {
  for (const enabled_tools of [[], ["get_active_watchlist"], ["*"], ["get_unknown"], ["GET_NEWS"]]) {
    assert.deepEqual(tradingViewReadOnlyOverride({ url: TRADINGVIEW_MCP_URL, enabled_tools }), {
      enabled_tools: [], disabled_tools: [],
    });
  }
});

test("invalid configured permission lists throw instead of expanding access", () => {
  for (const key of ["enabled_tools", "disabled_tools"]) {
    for (const value of [undefined, null, false, 0, "get_news", {}, [null], ["get_news", 1], [""], [" "], Array(1)]) {
      assert.throws(() => tradingViewReadOnlyOverride({ url: TRADINGVIEW_MCP_URL, [key]: value }),
        { name: "TypeError", message: `TradingView MCP ${key} must be an array of non-empty tool names` });
    }
  }
});

test("disabled and unrelated servers are not opened or rewritten", () => {
  for (const config of [undefined, null, [], {}, { url: "https://other.test/mcp" },
    { command: "synthetic-mcp" }, { name: "tradingview", url: "https://other.test/mcp" },
    { url: TRADINGVIEW_MCP_URL, enabled: false },
    { url: TRADINGVIEW_MCP_URL, enabled: false, enabled_tools: "malformed-but-disabled" },
  ]) assert.equal(tradingViewReadOnlyOverride(config), null);
});
