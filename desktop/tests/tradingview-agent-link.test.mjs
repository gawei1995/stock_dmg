import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { buildReadOnlyToolGuard, buildWorkspacePrompt, CodexWorkspaceService } from "../src/engine/codex-workspace.mjs";
import { TRADINGVIEW_MCP_URL, TRADINGVIEW_READ_ONLY_TOOLS } from "../src/engine/tradingview-mcp-policy.mjs";

test("TV thread override restricts official server without changing other research or stricter user choices", () => {
  const original = { mcp_servers: {
    tradingview: { url: TRADINGVIEW_MCP_URL, enabled_tools: ["get_ohlcv", "get_news", "create_alert"], disabled_tools: ["get_news"], tool_timeout_sec: 5 },
    other: { url: "https://example.invalid/mcp" },
  } };
  const before = structuredClone(original);
  const guard = buildReadOnlyToolGuard({ effectiveConfig: original });
  assert.deepEqual(guard.config.mcp_servers.tradingview, { enabled_tools: ["get_ohlcv", "get_news"], disabled_tools: ["get_news"] });
  assert.deepEqual(guard.tradingViewTools.tradingview, ["get_ohlcv"]);
  assert.equal(guard.config.mcp_servers.other, undefined);
  assert.deepEqual(original, before);
});

test("TV disabled server and unrelated URL never become enabled through thread policy", () => {
  for (const entry of [{ url: TRADINGVIEW_MCP_URL, enabled: false }, { url: "https://not-tradingview.invalid/mcp" }]) {
    const guard = buildReadOnlyToolGuard({ effectiveConfig: { mcp_servers: { tradingview: entry } } });
    assert.equal(guard.config.mcp_servers, undefined);
    assert.deepEqual(guard.tradingViewTools, {});
  }
  assert.throws(() => buildReadOnlyToolGuard({ effectiveConfig: { mcp_servers: { tradingview: { url: TRADINGVIEW_MCP_URL, enabled_tools: "all" } } } }), /enabled_tools/);
});

test("right Agent capabilities expose only permitted TV tools, never unknown or mislabeled writes", () => {
  const service = new CodexWorkspaceService({ workspaceDirectory: "/synthetic/trading" });
  service.readOnlyGuard = { ...service.readOnlyGuard, ...buildReadOnlyToolGuard({ effectiveConfig: { mcp_servers: { tradingview: { url: TRADINGVIEW_MCP_URL } } } }) };
  service.mcpServers = [{ name: "tradingview", authStatus: "oAuth", tools: [
    { name: "get_ohlcv" }, { name: "get_active_watchlist" }, { name: "create_alert" },
    { name: "future_query" }, { name: "get_news", annotations: { readOnlyHint: false } },
  ] }];
  const tv = service.capabilities().mcpServers[0];
  assert.deepEqual(tv.tools.map(t => t.name), ["get_ohlcv"]);
});

test("actual renderer autocomplete links TV server/tools to right Agent and respects missing login", async () => {
  const source = await readFile(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  const start = source.indexOf("function capabilityItems()");
  const end = source.indexOf("\nfunction updatePromptSuggestions", start);
  assert.ok(start > 0 && end > start);
  const state = { agentCapabilities: { mcpServers: [{ name: "tradingview", authStatus: "notLoggedIn", tools: [{ name: "get_ohlcv", description: "TV bars" }] }] } };
  const context = vm.createContext({ state });
  vm.runInContext(source.slice(start, end), context);
  let rows = context.capabilityItems();
  assert.deepEqual(Array.from(rows, r => r.token), ["@tradingview", "@tradingview/get_ohlcv"]);
  assert.ok(rows.every(r => r.available === false));
  state.agentCapabilities.mcpServers[0].authStatus = "oAuth";
  rows = context.capabilityItems();
  assert.ok(rows.every(r => r.available === true));
  for (const runtimeStatus of ["failed", "starting", "authenticationRequired", "disabled", "cancelled"]) {
    state.agentCapabilities.mcpServers[0].runtimeStatus = runtimeStatus;
    rows = context.capabilityItems();
    assert.ok(rows.every(r => r.available === false));
    assert.doesNotMatch(rows[0].description, /已连接/);
  }
  state.agentCapabilities.mcpServers[0].runtimeStatus = "connected";
  state.agentCapabilities.mcpServers[0].toolsUnavailable = true;
  assert.ok(context.capabilityItems().every(r => r.available === false));
  assert.match(context.capabilityItems()[0].description, /工具发现失败/);
});

test("failed or malformed config read cannot create an unguarded TV analysis thread", async t => {
  const workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), "tv-config-failure-"));
  t.after(() => rm(workspaceDirectory, { recursive: true, force: true }));
  for (const mode of ["failure", "missing", "array"]) {
    const calls = [];
    const rpc = { ready: false, async start() { this.ready = true; }, dispose() { this.ready = false; },
      async request(method) { calls.push(method); if (method === "config/read") {
        if (mode === "failure") throw new Error("synthetic config failure");
        return mode === "array" ? { config: [] } : {};
      } return {}; },
    };
    const service = new CodexWorkspaceService({ codexPath: "/fake/codex", workspaceDirectory, rpcFactory: () => rpc });
    try {
      await assert.rejects(service.prepare(), /无法读取 Codex 有效配置/);
      assert.equal(calls.includes("thread/start"), false);
      assert.equal(calls.includes("thread/resume"), false);
      assert.equal(service.status().readOnlyGuardReady, false);
    } finally { service.dispose(); }
  }
});

test("TV research instructions link current scope without overriding valuation or blind review firewall", () => {
  const prompt = buildWorkspacePrompt({ analysisScope: "candidate", context: { symbol: "AAPL.US" } });
  assert.match(prompt, /TradingView MCP 是可选研究数据源/);
  assert.match(prompt, /本轮选中标的\/候选或组合/);
  assert.match(prompt, /不得覆盖冻结持仓、成本、USD估值/);
  assert.match(prompt, /401\/403、429、503或超时出现一次/);
  assert.match(prompt, /get_active_watchlist/);
  const blind = buildWorkspacePrompt({ analysisScope: "review", context: { reviewProtocol: "decision_cycle", reviewPhase: "blind" } });
  assert.match(blind, /禁止网页、MCP/);
  assert.doesNotMatch(blind, /TradingView MCP 是可选研究数据源/);
});

test("project-only TV configuration matches reviewed allowlist and carries no credentials", async () => {
  const config = await readFile(new URL("../../trading-agent-workspace/.codex/config.toml", import.meta.url), "utf8");
  assert.match(config, /\[mcp_servers\.tradingview\]/);
  assert.match(config, /required = false/);
  assert.match(config, /startup_timeout_sec = 15/);
  assert.match(config, /tool_timeout_sec = 30/);
  const list = config.match(/enabled_tools\s*=\s*(\[[\s\S]*?\])/)[1];
  const names = [...list.matchAll(/"([a-z_]+)"/g)].map(m => m[1]);
  assert.deepEqual(names, TRADINGVIEW_READ_ONLY_TOOLS);
  assert.doesNotMatch(config, /(?:bearer_token|Authorization|http_headers|client_secret)\s*=/i);
});
