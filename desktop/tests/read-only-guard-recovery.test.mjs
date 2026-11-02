import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexWorkspaceService } from "../src/engine/codex-workspace.mjs";

test("a cold direct-broker configuration receipt covers exact catalog-retained deny names", async (t) => {
  const { service, rpc } = await recoveryFixture(t, { savedThread: true });
  await service.prepare();
  await service.refreshInventory();
  assert.equal(service.status().readOnlyGuardReady, true);
  assert.equal(service.status().readOnlyGuardDiagnostic.code, "ready");
  assert.equal(service.capabilities().readOnlyGuard.configurationReceipt.origin, "cold_resume");
  assert.ok(rpc.calls.find(call => call.method === "thread/resume")
    .params.config.mcp_servers.broker_data.disabled_tools.includes("submit_order"));
  assert.deepEqual(service.capabilities().readOnlyGuard.residualTools, []);
});

test("a hot direct-broker resume without a cold deny receipt cannot excuse visible transaction tools", async (t) => {
  const { service, rpc } = await recoveryFixture(t, { savedThread: true, preloaded: true });
  await service.prepare();
  await service.refreshInventory();
  assert.equal(service.capabilities().readOnlyGuard.configurationReceipt, null);
  assert.equal(service.status().readOnlyGuardReady, false,
    "desired deny config is not evidence that an already-loaded thread accepted it");
  assert.equal(service.status().readOnlyGuardDiagnostic.code, "session_configuration_missing");
  assert.equal(service.status().readOnlyGuardDiagnostic.action, "new_session");
  assert.deepEqual(service.capabilities().readOnlyGuard.residualTools, [
    { server: "broker_data", tool: "submit_order" },
  ]);
  assert.equal(rpc.calls.some(call => call.method === "turn/start"), false);
});

test("explicit read-only recheck refreshes a missing proof even while inventory TTL is fresh", async (t) => {
  const { service, rpc } = await recoveryFixture(t);
  await service.prepare();
  await service.refreshInventory();
  const previousReads = rpc.calls.filter(call => call.method === "mcpServerStatus/list").length;
  service.threadBrokerGuardProofs.delete(service.threadId);
  assert.equal(service.status().readOnlyGuardReady, false);
  assert.equal(service.status().readOnlyGuardDiagnostic.action, "recheck");
  assert.ok(Date.now() - service.inventoryState.mcp.updatedAt < 10_000);

  await service.recheckReadOnlyGuard();
  assert.equal(service.status().readOnlyGuardReady, true);
  assert.ok(rpc.calls.filter(call => call.method === "mcpServerStatus/list").length > previousReads);
  assert.equal(rpc.calls.filter(call => call.method === "thread/start").length, 1);
  assert.equal(rpc.calls.some(call => call.method === "thread/resume" || call.method === "turn/interrupt"), false);
  assert.equal(service.guardRecheckPromise, null);
});

test("read-only recheck recovers a failed per-thread catalog without replacing the conversation", async (t) => {
  const { service, rpc } = await recoveryFixture(t, { verificationError: true });
  await service.prepare();
  await service.refreshInventory();
  const threadId = service.threadId;
  assert.equal(service.status().readOnlyGuardReady, false);
  assert.match(service.capabilities().inventory.mcp.error, /synthetic catalog unavailable/);
  assert.equal(service.status().readOnlyGuardDiagnostic.action, "recheck");
  assert.ok(service.capabilities().readOnlyGuard.configurationReceipt);

  rpc.fixture.verificationError = false;
  await service.recheckReadOnlyGuard();
  assert.equal(service.threadId, threadId);
  assert.equal(service.status().readOnlyGuardReady, true);
  assert.equal(service.status().readOnlyGuardDiagnostic.code, "ready");
  assert.equal(service.capabilities().inventory.mcp.error, null);
  assert.equal(rpc.calls.filter(call => call.method === "thread/start").length, 1);
  assert.equal(rpc.calls.some(call => call.method === "thread/resume" || call.method === "turn/interrupt"), false);
});

test("optional unauthenticated TradingView does not block a validated direct-broker guard", async (t) => {
  const { service } = await recoveryFixture(t, { optionalTradingView: true });
  await service.prepare();
  await service.refreshInventory();
  assert.equal(service.status().readOnlyGuardReady, true);
  const tradingView = service.capabilities().mcpServers.find(server => server.name === "tradingview");
  assert.equal(tradingView.authStatus, "notLoggedIn");
  assert.equal(tradingView.toolsUnavailable, true);
  assert.deepEqual(tradingView.tools, []);
  assert.deepEqual(service.capabilities().readOnlyGuard.residualTools, []);
});

test("catalog-retained non-query TradingView tools require an exact cold allowlist receipt", async (t) => {
  for (const preloaded of [false, true]) {
    const { service } = await recoveryFixture(t, {
      savedThread: true, preloaded, optionalTradingView: true, retainedTradingViewWrite: true,
    });
    await service.prepare();
    await service.refreshInventory();
    assert.equal(service.status().readOnlyGuardReady, !preloaded);
    const raw = service.capabilities().readOnlyGuard;
    assert.ok(raw.rawResidualTools.some(tool => tool.server === "tradingview" && tool.tool === "create_alert"));
    assert.equal(raw.residualTools.some(tool => tool.server === "tradingview" && tool.tool === "create_alert"), preloaded);
    assert.deepEqual(service.capabilities().mcpServers.find(server => server.name === "tradingview").tools, []);
  }
});

test("cold broker plugin receipts cover only their exact known runtime server aliases", async (t) => {
  for (const pluginServerName of ["broker_data", "longbridge-plugin.broker_data", "longbridge-plugin:broker_data", "longbridge-plugin/broker_data"]) {
    const { service } = await recoveryFixture(t, { pluginServerName });
    await service.prepare();
    await service.refreshInventory();
    assert.equal(service.status().readOnlyGuardReady, true, pluginServerName);
    assert.deepEqual(service.capabilities().readOnlyGuard.residualTools, []);
  }
});

test("broker and shared App catalog errors fail closed for empty or partial tool results until recheck succeeds", async (t) => {
  for (const inventoryFailure of ["broker_empty", "broker_partial", "apps_empty", "apps_partial"]) {
    const { service, rpc } = await recoveryFixture(t, { inventoryFailure });
    await service.prepare();
    await service.refreshInventory();
    assert.equal(service.status().readOnlyGuardReady, false, inventoryFailure);
    assert.ok(service.capabilities().inventory.mcp.error, inventoryFailure);
    rpc.fixture.inventoryFailure = null;
    await service.recheckReadOnlyGuard();
    assert.equal(service.status().readOnlyGuardReady, true, inventoryFailure);
    assert.equal(service.capabilities().inventory.mcp.error, null);
  }
});

test("a reconnect config-read failure clears old thread readiness and keeps a repair reason", async (t) => {
  const { service, rpc } = await recoveryFixture(t);
  await service.prepare();
  await service.refreshInventory();
  assert.equal(service.status().readOnlyGuardReady, true);
  rpc.ready = false;
  rpc.fixture.configError = true;
  await assert.rejects(service.prepare(), { kind: "read_only_guard" });
  assert.equal(service.status().threadId, null);
  assert.equal(service.status().ready, false);
  assert.equal(service.status().readOnlyGuardReady, false);
  assert.equal(service.guardStartupFailure.code, "config_unavailable");
  assert.equal(service.status().readOnlyGuardDiagnostic.code, "config_unavailable");
  assert.equal(service.status().readOnlyGuardDiagnostic.action, "recheck");
  rpc.fixture.configError = false;
  await service.recheckReadOnlyGuard();
  assert.equal(service.status().readOnlyGuardReady, true);
});

test("explicit recheck waits out a prior inventory read and then takes a new snapshot", async (t) => {
  const { service, rpc } = await recoveryFixture(t);
  await service.prepare();
  await service.refreshInventory();
  rpc.fixture.deferNextVerification = true;
  const pending = service.refreshInventory({ forceReload: true, resources: ["mcp"] });
  await until(() => typeof rpc.releaseVerification === "function");
  const readsWhilePending = rpc.calls.filter(call => call.method === "mcpServerStatus/list").length;
  const recheck = service.recheckReadOnlyGuard();
  await new Promise(resolve => setImmediate(resolve));
  rpc.releaseVerification();
  await Promise.all([pending, recheck]);
  assert.ok(rpc.calls.filter(call => call.method === "mcpServerStatus/list").length > readsWhilePending,
    "an explicit retry must not reuse the snapshot that preceded the retry");
  assert.equal(service.status().readOnlyGuardReady, true);
});

test("a late pre-dispose recheck cannot poison a replacement generation or retire its newer retry", async (t) => {
  const { service, rpc: previousRpc } = await recoveryFixture(t);
  await service.prepare();
  await service.refreshInventory();
  previousRpc.fixture.deferNextInstalled = true;
  const oldRetry = service.recheckReadOnlyGuard();
  await until(() => typeof previousRpc.releaseInstalled === "function");

  const replacementRpc = new RecoveryRpc({}, {});
  service.rpcFactory = options => { replacementRpc.options = options; return replacementRpc; };
  service.dispose();
  await service.prepare();
  await service.refreshInventory();
  const generation = service.rpcGeneration;
  const threadId = service.threadId;
  assert.equal(service.status().readOnlyGuardReady, true,
    "the pending old retry must not leave the replacement runtime in checking state");

  replacementRpc.fixture.deferNextInstalled = true;
  const newRetry = service.recheckReadOnlyGuard();
  await until(() => typeof replacementRpc.releaseInstalled === "function");
  const pendingReplacement = service.guardRecheckPromise;
  previousRpc.releaseInstalled();
  await oldRetry;
  assert.equal(service.rpcGeneration, generation);
  assert.equal(service.threadId, threadId);
  assert.equal(service.guardStartupFailure, null,
    "a stale preflight rejection must not become the new runtime's repair reason");
  assert.equal(service.guardRecheckPromise, pendingReplacement,
    "old finally cleanup must not clear a newer explicit retry");
  assert.equal(service.status().readOnlyGuardDiagnostic.code, "checking");

  replacementRpc.releaseInstalled();
  await newRetry;
  assert.equal(service.guardRecheckPromise, null);
  assert.equal(service.status().readOnlyGuardReady, true);
  assert.equal(service.status().readOnlyGuardDiagnostic.code, "ready");
});

async function recoveryFixture(t, fixture = {}) {
  const workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), "cockpit-guard-recovery-"));
  const store = new RecoveryMemoryStore();
  if (fixture.savedThread) {
    await store.set("codexWorkspaceThread", { threadId: "saved-synthetic-thread", cwd: workspaceDirectory,
      name: "Synthetic recovery", updatedAt: new Date().toISOString() });
  }
  const rpc = new RecoveryRpc({}, fixture);
  const service = new CodexWorkspaceService({
    codexPath: "/synthetic/codex", workspaceDirectory, store,
    rpcFactory: options => { rpc.options = options; return rpc; },
  });
  t.after(async () => {
    service.dispose();
    await rm(workspaceDirectory, { recursive: true, force: true });
  });
  return { service, rpc };
}

class RecoveryMemoryStore {
  values = new Map();
  async get(key) { return structuredClone(this.values.get(key)); }
  async set(key, value) { this.values.set(key, structuredClone(value)); }
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail("Synthetic recovery request did not become pending");
}

class RecoveryRpc {
  constructor(options, fixture) {
    this.options = options;
    this.fixture = { ...fixture };
    this.calls = [];
    this.ready = false;
  }
  async start() { this.ready = true; }
  dispose() { this.ready = false; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "config/read") {
      if (this.fixture.configError) throw new Error("synthetic config unavailable");
      return { config: { mcp_servers: {
        ...(!this.fixture.pluginServerName ? { broker_data: { url: "https://mcp.longbridge.com/v2" } } : {}),
        ...(this.fixture.optionalTradingView ? { tradingview: {
          url: "https://mcp.tradingview.com/mcp", enabled_tools: ["get_ohlcv"], required: false,
        } } : {}),
      }, ...(this.fixture.pluginServerName ? { plugins: { "longbridge-plugin": { mcp_servers: {
        broker_data: { url: "https://mcp.longbridge.com/v2" },
      } } } } : {}) } };
    }
    if (method === "app/installed") {
      if (this.fixture.deferNextInstalled) {
        this.fixture.deferNextInstalled = false;
        await new Promise(resolve => { this.releaseInstalled = resolve; });
      }
      return { apps: [] };
    }
    if (method === "thread/loaded/list") {
      return { data: this.fixture.preloaded ? ["saved-synthetic-thread"] : [], nextCursor: null };
    }
    if (method === "thread/start" || method === "thread/resume") {
      return { thread: { id: params.threadId ?? "new-synthetic-thread", ephemeral: false,
        createdAt: Math.floor(Date.now() / 1_000) }, cwd: this.options.cwd };
    }
    if (method === "skills/list") return { data: [] };
    if (method === "app/list" || method === "thread/list" || method === "thread/turns/list") {
      return { data: [], nextCursor: null };
    }
    if (method === "mcpServerStatus/list") {
      if (this.fixture.verificationError && params.threadId) throw new Error("synthetic catalog unavailable");
      if (this.fixture.deferNextVerification && params.threadId) {
        this.fixture.deferNextVerification = false;
        await new Promise(resolve => { this.releaseVerification = resolve; });
      }
      const failure = this.fixture.inventoryFailure;
      return { data: [{ name: this.fixture.pluginServerName ?? "broker_data", authStatus: "oAuth", runtimeStatus: "connected",
        toolsError: failure?.startsWith("broker_") ? "synthetic incomplete broker catalog" : null,
        serverInfo: { title: "Longbridge", websiteUrl: "https://mcp.longbridge.com" },
        tools: failure === "broker_empty" ? {} : {
          quote: { name: "quote", description: "Read a quote" },
          submit_order: { name: "submit_order", description: "Submit an order" },
        } }, ...(failure?.startsWith("apps_") ? [{ name: "codex_apps", authStatus: "bearerToken",
          toolsError: "synthetic incomplete App catalog", tools: failure === "apps_empty" ? {} : {
            "research.query": { name: "research.query", description: "Read public research" },
          } }] : []), ...(this.fixture.optionalTradingView ? [{ name: "tradingview", authStatus: "notLoggedIn",
          runtimeStatus: "authenticationRequired", toolsError: "synthetic optional login unavailable",
          tools: this.fixture.retainedTradingViewWrite ? {
            create_alert: { name: "create_alert", description: "Create a TradingView alert", annotations: { destructiveHint: true } },
          } : {} }] : [])],
        nextCursor: null };
    }
    return {};
  }
}
