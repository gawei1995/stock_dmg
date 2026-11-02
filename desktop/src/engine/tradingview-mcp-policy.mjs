export const TRADINGVIEW_MCP_URL = "https://mcp.tradingview.com/mcp";

// An explicit capability allowlist: unknown tools stay unavailable even if the
// server labels them read-only. get_active_watchlist is intentionally absent:
// it can create or activate the default watchlist.
export const TRADINGVIEW_READ_ONLY_TOOLS = Object.freeze([
  "list_watchlists", "get_watchlist", "get_ohlcv", "get_economic_data",
  "get_economic_symbols", "search_symbols", "get_symbol_data", "run_screener",
  "get_symbol_data_batch", "get_screener_columns", "get_technicals_rating",
  "get_news", "get_news_story", "get_forecasts", "get_financials",
  "get_financial_history", "get_documents", "get_document_view",
  "get_earnings_calendar", "get_economic_calendar", "get_dividends_calendar",
  "list_alerts", "get_alerts", "get_alerts_log",
]);

export function isOfficialTradingViewMcpUrl(value) {
  // Reject credentials, queries, fragments, whitespace and path normalization
  // tricks instead of allowing URL parsing to silently erase them. Explicit
  // HTTPS port 443 is equivalent to the official endpoint's default port.
  return typeof value === "string"
    && /^https:\/\/mcp\.tradingview\.com(?::443)?\/mcp$/u.test(value);
}

function configuredToolList(config, key) {
  if (!Object.hasOwn(config, key)) return null;
  const value = config[key];
  if (!Array.isArray(value) || [...value].some(tool => typeof tool !== "string" || !tool.trim())) {
    throw new TypeError(`TradingView MCP ${key} must be an array of non-empty tool names`);
  }
  return value;
}

/** Pure, deny-only, per-session configuration patch. The caller must merge it
 * into an existing official server configuration; it is not a new server, a
 * global configuration write, or evidence that the runtime enforced it.
 * Disabled and unrelated servers remain untouched. Invalid permission lists
 * fail closed by throwing, rather than becoming unrestricted defaults.
 */
export function tradingViewReadOnlyOverride(serverConfig) {
  if (!serverConfig || typeof serverConfig !== "object" || Array.isArray(serverConfig)
    || !isOfficialTradingViewMcpUrl(serverConfig.url) || serverConfig.enabled === false) return null;
  const configuredEnabled = configuredToolList(serverConfig, "enabled_tools");
  const configuredDisabled = configuredToolList(serverConfig, "disabled_tools");
  const enabledSet = configuredEnabled === null ? null : new Set(configuredEnabled);
  return {
    enabled_tools: TRADINGVIEW_READ_ONLY_TOOLS.filter(tool => enabledSet === null || enabledSet.has(tool)),
    disabled_tools: configuredDisabled === null ? [] : [...configuredDisabled],
  };
}
