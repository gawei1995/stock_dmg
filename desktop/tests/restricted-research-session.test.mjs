import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAnalysisEvidence } from "../src/engine/agent.mjs";
import { CodexWorkspaceService } from "../src/engine/codex-workspace.mjs";

const SUPPORTED_FEATURES = "apps stable true\nplugins stable true\nremote_plugin stable true\n";

test("full inventory failures stay blocked while an explicitly new restricted conversation gets its own proof", async t => {
  const { service, rpc, store } = await fixture(t);
  await service.prepare();
  await service.refreshInventory();
  const fullThreadId = service.threadId;
  const originalConfig = structuredClone(rpc.configs.get(fullThreadId));
  assert.equal(service.status().readOnlyGuardReady, true);

  rpc.fixture.fullInventoryError = true;
  await service.refreshInventory({ forceReload: true, resources: ["mcp"] });
  assert.equal(service.status().readOnlyGuardReady, false);
  await assert.rejects(research(service), { kind: "read_only_guard" });
  assert.equal(rpc.calls.some(call => call.method === "turn/start"), false);

  const restricted = await service.createSession({ name: "Restricted synthetic research", toolMode: "restricted" });
  await service.refreshInventory({ threadId: restricted.id });
  assert.notEqual(restricted.id, fullThreadId);
  assert.equal(service.status().researchMode.kind, "restricted");
  assert.equal(service.status().researchMode.available, true);
  assert.equal(service.status().readOnlyGuardReady, true);
  assert.deepEqual(rpc.configs.get(fullThreadId), originalConfig, "the full conversation is never hot-relabeled or reconfigured");
  assertRestrictedConfig(rpc.configs.get(restricted.id));
  assert.equal(service.threadBrokerGuardProofs.get(restricted.id).isolation.ready, true);
  const registry = await store.get("codexWorkspaceThreadRegistry");
  assert.equal(registry.threads.find(thread => thread.threadId === fullThreadId).toolMode, "full");
  assert.equal(registry.threads.find(thread => thread.threadId === restricted.id).toolMode, "restricted");
  assert.equal(rpc.calls.some(call => call.method === "thread/archive" && call.params.threadId === fullThreadId), false);
});

test("a global installed-App outage starts a separately verified restricted conversation without opening tools", async t => {
  const { service, rpc, store } = await fixture(t, { globalInstalledError: true });
  await service.prepare();
  await service.refreshInventory();
  assert.equal(service.status().researchMode.kind, "restricted");
  assert.equal(service.status().readOnlyGuardReady, true);
  assertRestrictedConfig(rpc.configs.get(service.threadId));
  assert.equal((await store.get("codexWorkspaceThread")).toolMode, "restricted");
  assert.equal(rpc.calls.filter(call => call.method === "thread/start").length, 1);
  assert.equal(rpc.calls.some(call => call.method === "turn/start"), false);
});

test("unsupported restricted feature flags never create an unverified fallback conversation", async t => {
  const { service, rpc } = await fixture(t, { globalInstalledError: true });
  service.inspectRestrictedFeatures = async () => "apps stable true\nplugins removed false\nremote_plugin stable true";
  await assert.rejects(service.prepare());
  assert.equal(service.status().readOnlyGuardReady, false);
  assert.equal(rpc.calls.some(call => call.method === "thread/start" || call.method === "turn/start"), false);
});

test("restricted conversations reject visible, malformed, unavailable, or still-running external MCP inventories", async t => {
  for (const restrictedInventoryFault of ["visible", "missing_tools", "tools_error", "running", "malformed_page"]) {
    await t.test(restrictedInventoryFault, async child => {
      const { service, rpc } = await fixture(child, { restrictedInventoryFault, globalInstalledError: true });
      await service.prepare();
      await service.refreshInventory();
      assert.equal(service.status().researchMode.kind, "restricted");
      assert.equal(service.status().readOnlyGuardReady, false);
      await assert.rejects(research(service), { kind: "read_only_guard" });
      assert.equal(rpc.calls.some(call => call.method === "turn/start"), false);
    });
  }
});

test("restricted conversations require every App to be explicitly disabled and non-callable", async t => {
  for (const restrictedAppFault of ["callable", "enabled", "missing_state", "unavailable"]) {
    await t.test(restrictedAppFault, async child => {
      const { service, rpc } = await fixture(child, { restrictedAppFault, globalInstalledError: true });
      await service.prepare();
      await service.refreshInventory();
      assert.equal(service.status().readOnlyGuardReady, false);
      await assert.rejects(research(service), { kind: "read_only_guard" });
      assert.equal(rpc.calls.some(call => call.method === "turn/start"), false);
    });
  }
});

test("failed full-session preflight cannot revoke an independently verified restricted conversation", async t => {
  const { service, rpc } = await fixture(t, { globalInstalledError: true });
  await service.prepare();
  await service.refreshInventory();
  const restrictedId = service.threadId;
  const proof = structuredClone(service.threadBrokerGuardProofs.get(restrictedId));
  await assert.rejects(service.createSession({ toolMode: "full" }));
  assert.equal(service.threadId, restrictedId);
  assert.equal(service.status().researchMode.kind, "restricted");
  assert.equal(service.status().readOnlyGuardReady, true);
  assert.deepEqual(service.threadBrokerGuardProofs.get(restrictedId), proof);
  const result = await research(service);
  assert.equal(result.text, "Synthetic research complete");
  assert.equal(rpc.calls.filter(call => call.method === "turn/start").length, 1);
});

test("restricted mode persists across switching and cold reconnect with a new-generation receipt", async t => {
  const { service, rpc, store } = await fixture(t, { globalInstalledError: true });
  await service.prepare();
  await service.refreshInventory();
  const restrictedId = service.threadId;
  rpc.fixture.globalInstalledError = false;
  const full = await service.createSession({ toolMode: "full", name: "Full synthetic research" });
  await service.refreshInventory({ threadId: full.id });
  assert.equal(service.status().researchMode.kind, "full");
  await service.switchSession(restrictedId);
  await service.refreshInventory({ threadId: restrictedId });
  assert.equal(service.status().researchMode.kind, "restricted");
  assert.equal(service.status().readOnlyGuardReady, true);
  assert.equal((await store.get("codexWorkspaceThread")).toolMode, "restricted");

  const priorGeneration = service.rpcGeneration;
  service.dispose();
  rpc.fixture.globalInstalledError = true;
  await service.prepare();
  await service.refreshInventory();
  assert.equal(service.threadId, restrictedId);
  assert.ok(service.rpcGeneration > priorGeneration);
  assert.equal(service.status().researchMode.kind, "restricted");
  assert.equal(service.status().readOnlyGuardReady, true);
  const receipt = service.threadBrokerConfigReceipts.get(restrictedId);
  assert.equal(receipt.origin, "cold_resume");
  assert.equal(receipt.generation, service.rpcGeneration);
  assert.equal(receipt.toolMode, "restricted");
  assertRestrictedConfig(receipt.config);
});

test("a preloaded restricted conversation cannot borrow a cold receipt from desired configuration", async t => {
  const { service, rpc, store, workspaceDirectory } = await fixture(t);
  const id = "synthetic-preloaded-restricted";
  await store.set("codexWorkspaceThread", { threadId: id, cwd: workspaceDirectory,
    name: "Preloaded synthetic restricted research", toolMode: "restricted", updatedAt: new Date().toISOString() });
  rpc.loaded.add(id);
  rpc.configs.set(id, { features: { apps: false, plugins: false, remote_plugin: false } });
  await service.prepare();
  await service.refreshInventory();
  assert.equal(service.threadBrokerConfigReceipts.has(id), false);
  assert.equal(service.status().readOnlyGuardReady, false);
  await assert.rejects(research(service), { kind: "read_only_guard" });
  assert.equal(rpc.calls.some(call => call.method === "turn/start"), false);
});

test("requesting a new mode before startup preserves an existing saved conversation's immutable mode", async t => {
  for (const [savedMode, requestedMode] of [["full", "restricted"], ["restricted", "full"]]) {
    await t.test(`${savedMode} to new ${requestedMode}`, async child => {
      const { service, rpc, store, workspaceDirectory } = await fixture(child);
      const savedId = `synthetic-saved-${savedMode}`;
      await store.set("codexWorkspaceThread", { threadId: savedId, cwd: workspaceDirectory,
        name: "Existing synthetic conversation", toolMode: savedMode, updatedAt: new Date().toISOString() });
      const existingConfig = { features: { apps: savedMode !== "restricted", plugins: savedMode !== "restricted", remote_plugin: savedMode !== "restricted" } };
      rpc.configs.set(savedId, structuredClone(existingConfig));
      await service.createSession({ toolMode: requestedMode, name: "Explicit new mode" });
      await service.refreshInventory();
      assert.notEqual(service.threadId, savedId);
      assert.equal(service.status().researchMode.kind, requestedMode);
      assert.equal(rpc.calls.some(call => call.method === "thread/resume" && call.params.threadId === savedId), false,
        "creating another mode must not cold-reconfigure the original saved conversation first");
      assert.deepEqual(rpc.configs.get(savedId), existingConfig);
      const registry = await store.get("codexWorkspaceThreadRegistry");
      assert.equal(registry.threads.find(thread => thread.threadId === savedId).toolMode, savedMode);
    });
  }
});

test("restricted research keeps native Skill and web instructions but omits App references and repeated external scans", async t => {
  const { service, rpc } = await fixture(t, { globalInstalledError: true });
  await service.prepare();
  await service.refreshInventory();
  // A stale optional directory must not be usable to attach an App mention.
  service.apps = [{ id: "research-app", name: "Research App", description: "Synthetic" }];
  const before = rpc.calls.filter(call => call.method === "mcpServerStatus/list" && call.params.threadId === service.threadId).length;
  const result = await research(service, "$local-research $research-app 请查阅网页并用本地文件解释研究框架");
  assert.equal(result.text, "Synthetic research complete");
  const turn = rpc.calls.find(call => call.method === "turn/start");
  assert.ok(turn.params.input.some(item => item.type === "skill" && item.name === "local-research"));
  assert.equal(turn.params.input.some(item => item.type === "mention" || String(item.path ?? "").startsWith("app://")), false);
  assert.ok(turn.params.input.some(item => item.type === "text" && item.text.includes("网页")));
  const start = rpc.calls.find(call => call.method === "thread/start");
  assert.equal(start.params.config.web_search, undefined, "native web configuration is inherited rather than disabled");
  assert.ok(start.params.dynamicTools.some(tool => tool.name === "query_recent_history"));
  assert.equal(rpc.calls.filter(call => call.method === "mcpServerStatus/list" && call.params.threadId === service.threadId).length, before,
    "a verified immutable restricted conversation does not depend on a new external scan for every message");
});

test("explicit recheck revalidates restricted isolation and blocks the conversation if external tools appear", async t => {
  const { service, rpc } = await fixture(t, { globalInstalledError: true });
  await service.prepare();
  await service.refreshInventory();
  assert.equal(service.status().readOnlyGuardReady, true);
  const scansBefore = rpc.calls.filter(call => call.method === "mcpServerStatus/list" && call.params.threadId === service.threadId).length;
  rpc.fixture.restrictedInventoryFault = "visible";
  await service.recheckReadOnlyGuard();
  assert.ok(rpc.calls.filter(call => call.method === "mcpServerStatus/list" && call.params.threadId === service.threadId).length > scansBefore);
  assert.equal(service.status().readOnlyGuardReady, false);
  await assert.rejects(research(service), { kind: "read_only_guard" });
  assert.equal(rpc.calls.some(call => call.method === "turn/start"), false);
});

test("restricted analysis cannot start while its explicit recheck is awaiting preparation", async t => {
  const { service, rpc } = await fixture(t, { globalInstalledError: true });
  await service.prepare();
  await service.refreshInventory();
  const originalPrepare = service.prepare.bind(service);
  let releasePreparation;
  service.prepare = async (...args) => {
    await new Promise(resolve => { releasePreparation = resolve; });
    return originalPrepare(...args);
  };
  const recheck = service.recheckReadOnlyGuard();
  try {
    assert.equal(typeof releasePreparation, "function");
    assert.equal(service.status().readOnlyGuardReady, false);
    await assert.rejects(research(service), { kind: "read_only_guard" });
    assert.equal(rpc.calls.some(call => call.method === "turn/start"), false);
  } finally {
    releasePreparation();
    await recheck;
    service.prepare = originalPrepare;
  }
  assert.equal(service.status().readOnlyGuardReady, true);
});

async function research(service, task = "讨论研究方法") {
  const run = await buildAnalysisEvidence({ scope: "chat", portfolio: null, task });
  return service.analyze({ portfolio: null, run, task });
}

function assertRestrictedConfig(config) {
  assert.deepEqual(config.features, { apps: false, plugins: false, remote_plugin: false });
  assert.equal(config.apps._default.enabled, false);
  assert.equal(config.apps["research-app"].enabled, false);
  assert.deepEqual(config.mcp_servers.broker_data, { enabled: false });
  assert.equal(config.plugins["synthetic@local"].enabled, false);
  assert.deepEqual(config.plugins["synthetic@local"].mcp_servers.bundled, { enabled: false });
}

async function fixture(t, options = {}) {
  const workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), "cockpit-restricted-service-"));
  const store = new MemoryStore();
  const rpc = new RestrictedResearchRpc(options);
  const service = new CodexWorkspaceService({ codexPath: "/synthetic/codex", workspaceDirectory, store,
    fingerprintSkills: async () => [], rpcFactory: hooks => { rpc.options = hooks; return rpc; } });
  service.inspectRestrictedFeatures = async () => SUPPORTED_FEATURES;
  t.after(async () => {
    service.dispose();
    await new Promise(resolve => setImmediate(resolve));
    await rm(workspaceDirectory, { recursive: true, force: true });
  });
  return { service, rpc, store, workspaceDirectory };
}

class MemoryStore {
  values = new Map();
  async get(key) { return structuredClone(this.values.get(key)); }
  async set(key, value) { this.values.set(key, structuredClone(value)); }
}

class RestrictedResearchRpc {
  constructor(fixture) {
    this.fixture = { ...fixture };
    this.calls = [];
    this.configs = new Map();
    this.threads = new Map();
    this.loaded = new Set();
    this.turns = new Map();
    this.ready = false;
    this.sequence = 0;
  }
  async start() { this.ready = true; }
  dispose() { this.ready = false; this.loaded.clear(); }
  async request(method, params = {}) {
    this.calls.push({ method, params: structuredClone(params) });
    const restricted = this.configs.get(params.threadId)?.features?.apps === false;
    if (method === "config/read") return { config: {
      apps: { _default: { enabled: true }, "research-app": { enabled: true } },
      mcp_servers: { broker_data: { url: "https://mcp.longbridge.com/v2", enabled: true, tool_timeout_sec: null } },
      plugins: { "synthetic@local": { enabled: true, mcp_servers: { bundled: { enabled: true, command: "synthetic-only" } } } },
    } };
    if (method === "app/installed") {
      if (!params.threadId && this.fixture.globalInstalledError) throw new Error("Synthetic installed-App service unavailable");
      if (!params.threadId) return { apps: [] };
      if (restricted) {
        if (this.fixture.restrictedAppFault === "unavailable") throw new Error("Synthetic thread App state unavailable");
        if (this.fixture.restrictedAppFault === "missing_state") return { apps: [{ id: "research-app" }] };
        return { apps: [{ id: "research-app", enabled: this.fixture.restrictedAppFault === "enabled",
          callable: this.fixture.restrictedAppFault === "callable" }] };
      }
      return { apps: [{ id: "research-app", enabled: true, callable: true }] };
    }
    if (method === "thread/loaded/list") return { data: [...this.loaded], nextCursor: null };
    if (method === "thread/start" || method === "thread/resume") {
      const id = params.threadId ?? `synthetic-research-${++this.sequence}`;
      // Native hot resume does not apply a new immutable tool configuration.
      if (method === "thread/start" || !this.loaded.has(id)) this.configs.set(id, structuredClone(params.config));
      this.loaded.add(id);
      const thread = { ...(this.threads.get(id) ?? {}), id, ephemeral: false,
        createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000),
        cwd: this.options.cwd, status: { type: "idle" } };
      this.threads.set(id, thread);
      return { thread, cwd: this.options.cwd, model: "synthetic-model", modelProvider: "synthetic" };
    }
    if (method === "thread/read") return { thread: this.threads.get(params.threadId) };
    if (method === "thread/list") return { data: [...this.threads.values()], nextCursor: null };
    if (method === "thread/name/set") { const thread = this.threads.get(params.threadId); if (thread) thread.name = params.name; return {}; }
    if (method === "thread/turns/list") return { data: this.turns.get(params.threadId) ?? [], nextCursor: null };
    if (method === "skills/list") return { data: [{ cwd: this.options.cwd, errors: [], skills: [{
      name: "local-research", description: "Synthetic standalone local research protocol", enabled: true,
      path: "/synthetic/skills/local-research/SKILL.md", scope: "user",
    }] }] };
    if (method === "app/list") return { data: [{ id: "research-app", name: "Research App", description: "Synthetic research",
      isAccessible: true, isEnabled: true }], nextCursor: null };
    if (method === "mcpServerStatus/list") {
      if (!restricted && params.threadId && this.fixture.fullInventoryError) throw new Error("Synthetic full catalog unavailable");
      if (restricted) {
        const fault = this.fixture.restrictedInventoryFault;
        if (fault === "malformed_page") return { data: null, nextCursor: null };
        const row = { name: "broker_data", runtimeStatus: fault === "running" ? "connected" : "disabled", tools: {} };
        if (fault === "visible") row.tools = { quote: { name: "quote" } };
        if (fault === "missing_tools") delete row.tools;
        if (fault === "tools_error") row.toolsError = "Synthetic unavailable inventory";
        return { data: [row], nextCursor: null };
      }
      return { data: [{ name: "broker_data", runtimeStatus: "connected", authStatus: "oAuth", tools: {
        quote: { name: "quote", description: "Read a quote" },
        submit_order: { name: "submit_order", description: "Submit an order" },
      } }], nextCursor: null };
    }
    if (method === "turn/start") {
      const id = `synthetic-turn-${this.calls.filter(call => call.method === "turn/start").length}`;
      const item = { type: "agentMessage", id: `message-${id}`, text: "Synthetic research complete" };
      const completed = { id, status: "completed", items: [item] };
      this.turns.set(params.threadId, [completed]);
      setImmediate(() => {
        this.options.onNotification({ method: "item/completed", params: { threadId: params.threadId, turnId: id, item } });
        this.options.onNotification({ method: "turn/completed", params: { threadId: params.threadId, turn: completed } });
      });
      return { turn: { id, status: "inProgress", items: [] } };
    }
    return {};
  }
  respondResult() {}
  respondError() {}
}
