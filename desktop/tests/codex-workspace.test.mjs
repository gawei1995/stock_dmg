import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  applyCodexWorkspaceAnalysis,
  buildReadOnlyToolGuard,
  CodexAppServerRpc,
  CodexWorkspaceService,
  expandAgentCommand,
  extractThreadTranscript,
  findRequestedApps,
  findRequestedSkills,
} from "../src/engine/codex-workspace.mjs";

test("history exposes one aggregated assistant answer and hides commentary segments", () => {
  const transcript = extractThreadTranscript([{ items: [
    { type: "userMessage", content: [{ type: "text", text: "分析 Google" }] },
    { type: "agentMessage", id: "commentary", phase: "commentary", text: "正在查资料" },
    { type: "agentMessage", id: "final-1", phase: "final_answer", text: "最终结论" },
    { type: "agentMessage", id: "final-2", phase: "final_answer", text: "风险计划" },
  ] }]);
  assert.deepEqual(transcript, [
    { role: "user", text: "分析 Google" },
    { role: "assistant", text: "最终结论\n\n风险计划" },
  ]);
});

test("read-only thread config targets Longbridge execution tools without limiting ordinary MCP analysis", () => {
  const guard = buildReadOnlyToolGuard({
    effectiveConfig: {
      mcp_servers: {
        broker_data: {
          url: "https://mcp.longbridge.com/v2",
          disabled_tools: ["user_disabled_tool"],
        },
        commerce: {
          url: "https://example.com/mcp",
          disabled_tools: ["catalog_delete"],
        },
      },
      apps: {
        longbridge: { enabled: true },
        research: { enabled: true, destructive_enabled: true },
      },
    },
  });

  const disabled = guard.config.mcp_servers.broker_data.disabled_tools;
  assert.equal(disabled.includes("user_disabled_tool"), true);
  for (const tool of [
    "submit_order",
    "replace_order",
    "cancel_order",
    "dca_create",
    "dca_pause",
    "dca_resume",
  ]) assert.equal(disabled.includes(tool), true);
  for (const queryTool of [
    "today_orders",
    "history_orders",
    "order_detail",
    "stock_positions",
    "quote",
    "dca_list",
  ]) assert.equal(disabled.includes(queryTool), false);
  assert.equal("commerce" in guard.config.mcp_servers, false);
  assert.deepEqual(guard.config.apps, {
    _default: { destructive_enabled: false },
    research: { destructive_enabled: false },
  });
});

test("Codex workspace starts a persistent unrestricted project thread with real capability inventory", async () => {
  const store = new MemoryStore();
  const rpcInstances = [];
  const service = createService({ store, rpcInstances });
  await service.prepare();

  const rpc = rpcInstances[0];
  const start = rpc.calls.find((call) => call.method === "thread/start");
  assert.equal(start.params.cwd, "/tmp/stock-agent-workspace");
  assert.equal(start.params.ephemeral, false);
  assert.equal(start.params.sandbox, "danger-full-access");
  assert.equal(start.params.approvalPolicy, "on-request");
  assert.equal(start.params.approvalsReviewer, "auto_review");
  assert.equal(start.params.dynamicTools[0].name, "query_recent_history");
  assert.equal(service.status().persistent, true);
  assert.equal(service.status().toolsEnabled, true);
  assert.equal(service.capabilities().skills[0].name, "technical-structure");
  assert.equal(service.capabilities().mcpServers[0].tools[0].name, "quote");
  assert.deepEqual(service.capabilities().apps.map((app) => app.id), ["research-app"]);
});

test("session startup and local listing do not wait for slow capability inventory", async () => {
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => {
      rpc = new HangingInventoryRpc(options);
      return rpc;
    },
  });
  await Promise.race([
    service.prepare(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("prepare blocked")), 100)),
  ]);
  rpc.calls.length = 0;
  const listing = await Promise.race([
    service.listSessions(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("list blocked")), 100)),
  ]);
  assert.equal(listing.sessions.length, 1);
  assert.equal(rpc.calls.some((call) => call.method === "thread/list"), false);
  service.dispose();
});

test("capability discovery is single-flight and cached across session changes", async () => {
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => {
      rpc = new MultiSessionRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  await Promise.all([
    service.refreshInventory(),
    service.refreshInventory(),
    service.refreshInventory(),
  ]);
  await service.createSession({ name: "能力缓存会话" });
  await new Promise((resolve) => setImmediate(resolve));
  for (const method of ["skills/list", "mcpServerStatus/list", "app/list"]) {
    assert.equal(rpc.calls.filter((call) => call.method === method).length, 1);
  }
  service.dispose();
});

test("persistent App Server threads apply the Longbridge write deny-list before model turns", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new GuardedLongbridgeRpc(options),
  });
  await service.prepare();

  const rpc = service.rpc;
  const start = rpc.calls.find((call) => call.method === "thread/start");
  const disabled = start.params.config.mcp_servers.broker_data.disabled_tools;
  assert.equal(disabled.includes("existing_disabled"), true);
  assert.equal(disabled.includes("submit_order"), true);
  assert.equal(start.params.config.apps._default.destructive_enabled, false);
  assert.equal(service.status().readOnlyGuardReady, true);
  assert.deepEqual(
    service.capabilities().mcpServers[0].tools.map((tool) => tool.name),
    ["quote", "stock_positions"],
  );

  await service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "$technical-structure 只读分析",
  });
  assert.equal(rpc.calls.some((call) => call.method === "turn/start"), true);
  service.dispose();
});

test("analyze fails closed only when an unguarded Longbridge write tool remains visible", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new UnguardedLongbridgeRpc(options),
  });
  await service.prepare();
  assert.equal(service.status().readOnlyGuardReady, false);
  await assert.rejects(service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "只读分析",
  }), /尚未被线程配置禁用的长桥交易写能力/);
  assert.equal(service.rpc.calls.some((call) => call.method === "turn/start"), false);
  service.dispose();
});

test("Codex workspace resumes the saved project thread after an app restart", async () => {
  const store = new MemoryStore();
  const firstInstances = [];
  const first = createService({ store, rpcInstances: firstInstances });
  await first.prepare();
  first.dispose();

  const secondInstances = [];
  const second = createService({ store, rpcInstances: secondInstances });
  await second.prepare();
  assert.equal(secondInstances[0].calls.some((call) => call.method === "thread/resume"), true);
  assert.equal(secondInstances[0].calls.some((call) => call.method === "thread/start"), false);
  assert.equal(second.status().threadId, "thr-persistent-1");
});

test("App-owned Codex sessions can be created, listed, switched, and persist the active pointer", async () => {
  const store = new MemoryStore();
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new MultiSessionRpc(options);
      return rpc;
    },
  });
  await service.prepare();

  const created = await service.createSession({ name: "候选股计划" });
  assert.equal(created.id, "thr-session-2");
  assert.equal(created.name, "候选股计划");
  assert.equal(created.current, true);
  assert.equal(rpc.calls.some((call) => call.method === "thread/name/set"
    && call.params.threadId === "thr-session-2"
    && call.params.name === "候选股计划"), true);

  const listed = await service.listSessions();
  assert.equal(listed.currentThreadId, "thr-session-2");
  assert.deepEqual(listed.sessions.map((session) => session.id), [
    "thr-session-2",
    "thr-session-1",
  ]);
  assert.deepEqual(Object.keys(listed.sessions[0]).sort(), [
    "createdAt",
    "current",
    "id",
    "name",
    "operationId",
    "preview",
    "runState",
    "updatedAt",
  ]);

  rpc.turns.set("thr-session-1", [historyTurn(
    "turn-opened",
    Math.floor(Date.now() / 1_000),
    "继续分析这段原对话",
  )]);
  const switched = await service.openSession("thr-session-1");
  assert.equal(switched.id, "thr-session-1");
  assert.match(JSON.stringify(switched.transcript), /继续分析这段原对话/);
  assert.equal(rpc.calls.some((call) => call.method === "thread/turns/list"
    && call.params.threadId === "thr-session-1"), false);
  assert.equal(rpc.calls.some((call) => call.method === "thread/resume"
    && call.params.threadId === "thr-session-1"
    && call.params.initialTurnsPage.itemsView === "summary"
    && call.params.dynamicTools[0].name === "query_recent_history"), true);
  assert.equal((await store.get("codexWorkspaceThread")).threadId, "thr-session-1");
  assert.equal(service.status().threadName, "交易驾驶舱 Agent");
  service.dispose();
});

test("opening an exact session falls back to the encrypted local transcript when live hydration fails", async () => {
  const store = new MemoryStore();
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new HistoryHydrationFailureRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  await service.createSession({ name: "另一个会话" });
  const now = Math.floor(Date.now() / 1_000);
  await store.set("codexWorkspaceRecentHistoryIndex", {
    version: 1,
    updatedAt: new Date().toISOString(),
    threads: [{
      id: "thr-session-1",
      name: "交易驾驶舱 Agent",
      createdAt: new Date((now - 60) * 1_000).toISOString(),
      updatedAt: new Date(now * 1_000).toISOString(),
      recencyAt: new Date(now * 1_000).toISOString(),
      turns: [historyTurn("cached-turn", now, "缓存中的原问题", "缓存中的原回答")],
    }],
  });

  const opened = await service.openSession("thr-session-1");
  assert.equal(opened.id, "thr-session-1");
  assert.match(JSON.stringify(opened.transcript), /缓存中的原问题/);
  assert.match(JSON.stringify(opened.transcript), /缓存中的原回答/);
  assert.equal(rpc.calls.some((call) => call.method === "thread/turns/list"
    && call.params.itemsView === "summary"
    && call.params.limit === 30), true);
  service.dispose();
});

test("pre-analysis work persists the user question before an App Server turn exists", async () => {
  const store = new MemoryStore();
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new MultiSessionRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  await service.createSession({ name: "前置计算会话" });
  await service.cachePendingUserMessage({
    threadId: "thr-session-1",
    operationId: "operation-preflight",
    text: "刷新持仓前就要保存这条问题",
  });
  assert.equal(service.status().activeCount, 0);
  const listing = await service.listSessions();
  assert.equal(listing.sessions.find((item) => item.id === "thr-session-1").runState, "running");
  const opened = await service.openSession("thr-session-1");
  assert.match(JSON.stringify(opened.transcript), /刷新持仓前就要保存这条问题/);
  assert.equal(rpc.calls.some((call) => call.method === "thread/turns/list"
    && call.params.threadId === "thr-session-1"), false);
  assert.equal(service.clearPendingOperation({
    threadId: "thr-session-1",
    operationId: "operation-preflight",
  }), true);
  service.dispose();
});

test("session switching accepts only the encrypted app registry and remains available during a turn", async () => {
  const store = new MemoryStore();
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new MultiSessionRpc(options, { hangingTurns: true });
      return rpc;
    },
  });
  await service.prepare();

  await assert.rejects(service.switchSession("thr-unregistered"), /不属于交易驾驶舱/);
  assert.equal(rpc.calls.some((call) => call.method === "thread/resume"
    && call.params.threadId === "thr-unregistered"), false);

  const analysis = service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "保持运行以验证会话锁",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const created = await service.createSession({ name: "并行会话" });
  assert.equal(created.id, "thr-session-2");
  const switched = await service.openSession("thr-session-1");
  assert.equal(switched.id, "thr-session-1");
  assert.match(JSON.stringify(switched.transcript), /保持运行以验证会话锁/);
  assert.equal(rpc.calls.some((call) => call.method === "thread/turns/list"
    && call.params.threadId === "thr-session-1"), false);
  assert.equal(rpc.calls.filter((call) => call.method === "thread/start").length, 2);
  await service.cancel({ threadId: "thr-session-1" });
  await assert.rejects(analysis, /已取消/);
  service.dispose();
});

test("one App Server connection runs different Codex threads concurrently and settles each independently", async () => {
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => {
      rpc = new MultiSessionRpc(options, { hangingTurns: true });
      return rpc;
    },
  });
  await service.prepare();
  await service.createSession({ name: "第二会话" });

  const first = service.analyze({
    portfolio: portfolioFixture(), run: runFixture(), task: "第一条并发分析",
    threadId: "thr-session-1", operationId: "operation-first",
  });
  const second = service.analyze({
    portfolio: portfolioFixture(), run: runFixture(), task: "第二条并发分析",
    threadId: "thr-session-2", operationId: "operation-second",
  });
  await waitUntil(() => rpc.calls.filter((call) => call.method === "turn/start").length === 2);
  assert.equal(service.status().activeCount, 2);
  assert.deepEqual(new Set(service.status().activeThreads.map((item) => item.threadId)), new Set([
    "thr-session-1", "thr-session-2",
  ]));
  const listed = await service.listSessions();
  assert.equal(listed.sessions.every((session) => session.runState === "running"), true);

  rpc.completeThread("thr-session-1", "第一条完成");
  assert.equal((await first).text, "第一条完成");
  assert.equal(service.status().activeCount, 1);
  assert.equal(service.status().activeThreads[0].threadId, "thr-session-2");

  rpc.completeThread("thr-session-2", "第二条完成");
  assert.equal((await second).text, "第二条完成");
  assert.equal(service.status().activeCount, 0);
  service.dispose();
});

test("turn input attaches real Skill and App references while MCP and tool events remain enabled", async () => {
  const store = new MemoryStore();
  const rpcInstances = [];
  const stream = [];
  const service = createService({ store, rpcInstances, onStream: (event) => stream.push(event) });
  await service.prepare();
  const analysis = await service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "$technical-structure $research-app @market/quote 完整分析",
  });

  const turn = rpcInstances[0].calls.find((call) => call.method === "turn/start");
  assert.equal("outputSchema" in turn.params, false);
  assert.equal(turn.params.input.some((item) => item.type === "skill"
    && item.name === "technical-structure"), true);
  assert.equal(turn.params.input.some((item) => item.type === "mention"
    && item.path === "app://research-app"), true);
  assert.equal(turn.params.additionalContext["trading-cockpit-evidence"].kind, "application");
  assert.match(turn.params.additionalContext["trading-cockpit-evidence"].value, /"weightPercent":12/);
  assert.doesNotMatch(
    turn.params.additionalContext["trading-cockpit-evidence"].value,
    /netAssets|accountId|oauth|accessToken/i,
  );
  assert.equal(analysis.persistent, true);
  assert.equal(analysis.ephemeral, false);
  assert.equal(analysis.toolsUsed, true);
  assert.equal(analysis.text, "持久 Codex 已结合 MCP 完成分析。");
  assert.equal(Number.isFinite(analysis.firstActivityMs), true);
  assert.equal(stream.some((event) => event.kind === "text_delta"), true);
  assert.equal(stream.some((event) => event.kind === "tool" && /market\.quote/.test(event.label)), true);
});

test("workspace analysis replaces local narration but preserves deterministic numeric cards", () => {
  const run = runFixture();
  const enriched = applyCodexWorkspaceAnalysis(run, {
    text: "# 结构需要确认\n\n结合持仓与工具数据，先观察确认条件。",
    provider: "Codex App Server",
    elapsedMs: 1_200,
    persistent: true,
    ephemeral: false,
    threadId: "thr-persistent-1",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    requestedSkills: [],
    requestedApps: [],
    toolEvents: [],
    toolsUsed: false,
    skillCount: 1,
    mcpServerCount: 1,
    appCount: 1,
    tokenUsage: null,
  });
  assert.equal(enriched.conclusion.headline, "结构需要确认");
  assert.equal(enriched.technical.ema[21], 98);
  assert.equal(enriched.plan.scenarios[0].if, "收复 EMA21");
  assert.equal(enriched.safeguards.modelSession, "persistent");
  assert.equal(enriched.safeguards.modelTools, true);
});

test("candidate Skill/MCP sizing can only tighten deterministic and theme ceilings", () => {
  const run = candidateRunFixture();
  const enriched = applyCodexWorkspaceAnalysis(run, {
    text: "# 候选复核\n\n半导体主题接近上限，初始只允许 1%。",
    candidateSizing: {
      candidateGroupKey: "半导体",
      classificationConfidence: "high",
      recommendedInitialAdditionalWeightPercent: 2,
      recommendedMaxTotalWeightPercent: 9,
      leverageDecision: "cash_only",
      rationale: "半导体主题现有 29%，主题预警线为 30%。",
    },
    provider: "Codex App Server",
    elapsedMs: 100,
    threadId: "thr-persistent-1",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    requestedSkills: ["analyze-market-narratives"],
    requestedApps: [],
    toolEvents: [{ type: "mcpToolCall" }],
    toolsUsed: true,
    skillCount: 2,
    mcpServerCount: 1,
    appCount: 0,
    tokenUsage: null,
  });

  assert.equal(enriched.risk.sizingReview.status, "skill_mcp_reviewed");
  assert.equal(enriched.risk.group, "半导体");
  assert.equal(enriched.risk.recommendedInitialAdditionalWeightPercent, 1);
  assert.equal(enriched.risk.recommendedMaxWeightPercent, 1);
  assert.equal(enriched.risk.recommendedInitialNotionalBase, 1_000);
  assert.equal(enriched.risk.recommendedMaxAdditionalNotionalBase, 1_000);
  assert.equal(enriched.risk.leverage.decision, "cash_only");
  assert.equal(enriched.plan.sizing.maxTotalWeightPercent, 1);
  assert.match(enriched.plan.scenarios[0].then, /初始新增 1%/);
});

test("candidate turns request structured Markdown plus a bounded sizing review", async () => {
  const store = new MemoryStore();
  const rpcInstances = [];
  const service = createService({ store, rpcInstances });
  await service.prepare();
  await service.analyze({
    portfolio: portfolioFixture(),
    run: candidateRunFixture(),
    task: "$technical-structure 评估候选仓位",
  });
  const turn = rpcInstances[0].calls.find((call) => call.method === "turn/start");
  assert.equal(turn.params.outputSchema.properties.analysisMarkdown.type, "string");
  assert.deepEqual(
    turn.params.outputSchema.properties.candidateSizing.properties.leverageDecision.enum,
    ["cash_only", "disabled"],
  );
  assert.equal(turn.params.input.some((item) => item.type === "skill"
    && item.name === "analyze-market-narratives"), true);
  assert.equal(turn.params.input.some((item) => item.type === "skill"
    && item.name === "analyze-technical-structure"), true);
  service.dispose();
});

test("composer markers map only to discovered Skills and accessible Apps", () => {
  const skills = [{ name: "risk", path: "/skills/risk/SKILL.md" }];
  const apps = [{ id: "research-app", name: "Research" }];
  assert.deepEqual(findRequestedSkills("$risk $missing", skills), [skills[0]]);
  assert.deepEqual(findRequestedApps("$research-app $missing", apps), [apps[0]]);
  assert.match(expandAgentCommand("/technical 看日线"), /EMA 3\/5\/8\/13\/21/);
});

test("remaining context below two percent triggers persistent thread compaction", async () => {
  const store = new MemoryStore();
  const rpcInstances = [];
  const service = createService({ store, rpcInstances });
  await service.prepare();
  const rpc = rpcInstances[0];
  rpc.options.onNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thr-persistent-1",
      tokenUsage: {
        modelContextWindow: 1_000,
        last: { inputTokens: 1, totalTokens: 981 },
        total: { inputTokens: 1, totalTokens: 981 },
      },
    },
  });
  await service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "完整分析",
  });
  assert.equal(rpc.calls.some((call) => call.method === "thread/compact/start"), true);
});

test("cancel ends a disconnected turn locally without waiting for remote confirmation", async () => {
  const store = new MemoryStore();
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new HangingTurnRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  const analysis = service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "完整分析",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await service.cancel(), true);
  await assert.rejects(
    Promise.race([
      analysis,
      new Promise((_, reject) => setTimeout(() => reject(new Error("local cancel timed out")), 100)),
    ]),
    /已取消/,
  );
  assert.equal(rpc.calls.some((call) => call.method === "turn/interrupt"), true);
  service.dispose();
});

test("cancel settles locally while turn/start is still pending and interrupts a late turn", async () => {
  const store = new MemoryStore();
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new PendingTurnStartRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  const analysis = service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "在 turn/start 返回前取消",
    operationId: "operation-pending-start",
  });
  await waitUntil(() => rpc.calls.some((call) => call.method === "turn/start"));

  assert.equal(await service.cancel({
    threadId: "thr-persistent-1",
    operationId: "operation-pending-start",
  }), true);
  await assert.rejects(
    Promise.race([
      analysis,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("pending turn/start cancellation timed out")),
        250,
      )),
    ]),
    /已取消/,
  );
  assert.equal(service.status().active, false);

  rpc.resolveTurnStart();
  await waitUntil(() => rpc.calls.some((call) => call.method === "turn/interrupt"
    && call.params.turnId === "turn-started-late"));
  service.dispose();
});

test("recent history uses only registered App Server threads, summary turns, and a per-turn 30-day cutoff", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const store = new MemoryStore();
  await store.set("codexWorkspaceThread", {
    threadId: "thr-current",
    cwd: "/tmp/stock-agent-workspace",
    createdAt: now - 60,
  });
  await store.set("codexWorkspaceThreadRegistry", {
    version: 1,
    threads: ["thr-current", "thr-no-match", "thr-match"].map((threadId) => ({
      threadId,
      cwd: "/tmp/stock-agent-workspace",
      createdAt: new Date((now - 3_600) * 1_000).toISOString(),
    })),
  });
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new HistoryRpc(options, {
        currentThreadId: "thr-current",
        liveThreads: [
          historyThread("thr-current", now - 10),
          historyThread("thr-no-match", now - 20),
          historyThread("thr-match", now - 30),
          { ...historyThread("thr-stranger", now - 5), name: "交易驾驶舱 Agent" },
        ],
        turns: {
          "thr-current": [historyTurn("turn-current", now - 10, "current discussion")],
          "thr-no-match": [historyTurn("turn-no-match", now - 20, "unrelated")],
          "thr-match": [
            historyTurn("turn-recent", now - 30, "target recent"),
            historyTurn("turn-expired", now - (31 * 86_400), "target ancient"),
          ],
          "thr-stranger": [historyTurn("turn-private", now - 5, "target private")],
        },
      });
      return rpc;
    },
  });
  await service.prepare();

  const history = await service.recentHistory({ query: "target", limit: 1, includeTurns: true });
  assert.equal(history.threads.length, 1);
  assert.equal(history.threads[0].id, "thr-match");
  assert.match(JSON.stringify(history.threads[0].transcript), /target recent/);
  assert.doesNotMatch(JSON.stringify(history.threads[0].transcript), /target ancient|target private/);
  assert.equal(rpc.calls.some((call) => call.method === "thread/read"), false);
  assert.equal(rpc.calls.filter((call) => call.method === "thread/turns/list")
    .every((call) => call.params.itemsView === "summary"), true);
  assert.equal(rpc.calls.some((call) => call.method === "thread/turns/list"
    && call.params.threadId === "thr-no-match"), true);
  assert.equal(rpc.calls.some((call) => call.method === "thread/turns/list"
    && call.params.threadId === "thr-stranger"), false);
  const listCall = rpc.calls.find((call) => call.method === "thread/list");
  assert.equal(listCall.params.useStateDbOnly, true);
  assert.equal(listCall.params.sourceKinds.includes("exec"), true);
  assert.equal(listCall.params.sourceKinds.includes("unknown"), true);
  service.dispose();
});

test("startup keeps a stale local pointer when App Server reports recent thread activity", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const oldCreatedAt = now - (40 * 86_400);
  const store = new MemoryStore();
  await store.set("codexWorkspaceThread", {
    threadId: "thr-old",
    cwd: "/tmp/stock-agent-workspace",
    createdAt: oldCreatedAt,
  });
  await store.set("codexWorkspaceThreadRegistry", {
    version: 1,
    threads: [{
      threadId: "thr-old",
      cwd: "/tmp/stock-agent-workspace",
      createdAt: new Date(oldCreatedAt * 1_000).toISOString(),
    }],
  });
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new HistoryRpc(options, {
        currentThreadId: "thr-old",
        liveThreads: [historyThread("thr-old", now - 60)],
        turns: {
          "thr-old": [
            historyTurn("turn-carry", now - 60, "carry recent decision"),
            historyTurn("turn-too-old", now - (35 * 86_400), "carry expired decision"),
          ],
        },
      });
      return rpc;
    },
  });
  await service.prepare();

  assert.equal(rpc.calls.some((call) => call.method === "thread/read"
    && call.params.threadId === "thr-old"), true);
  assert.equal(rpc.calls.some((call) => call.method === "thread/archive"), false);
  assert.equal(rpc.calls.some((call) => call.method === "thread/start"), false);
  assert.equal(rpc.calls.some((call) => call.method === "thread/resume"
    && call.params.threadId === "thr-old"), true);
  assert.equal((await store.get("codexWorkspaceThread")).threadId, "thr-old");
  service.dispose();
});

test("startup archives only after exact metadata and persisted turns confirm inactivity", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const oldActivity = now - (40 * 86_400);
  const store = new MemoryStore();
  await store.set("codexWorkspaceThread", {
    threadId: "thr-old",
    cwd: "/tmp/stock-agent-workspace",
    createdAt: oldActivity,
    updatedAt: oldActivity,
  });
  await store.set("codexWorkspaceThreadRegistry", {
    version: 1,
    threads: [{
      threadId: "thr-old",
      cwd: "/tmp/stock-agent-workspace",
      createdAt: new Date(oldActivity * 1_000).toISOString(),
      updatedAt: new Date(oldActivity * 1_000).toISOString(),
    }],
  });
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new HistoryRpc(options, {
        currentThreadId: "thr-new",
        liveThreads: [historyThread("thr-old", oldActivity)],
        turns: {
          "thr-old": [historyTurn(
            "turn-expired",
            now - (35 * 86_400),
            "expired decision",
          )],
          "thr-new": [],
        },
      });
      return rpc;
    },
  });
  await service.prepare();

  const snapshotIndex = rpc.calls.findIndex((call) => call.method === "thread/turns/list"
    && call.params.threadId === "thr-old");
  const archiveIndex = rpc.calls.findIndex((call) => call.method === "thread/archive"
    && call.params.threadId === "thr-old");
  assert.equal(snapshotIndex >= 0, true);
  assert.equal(archiveIndex > snapshotIndex, true);
  assert.equal(rpc.calls.some((call) => call.method === "thread/start"), true);
  assert.equal((await store.get("codexWorkspaceThread")).threadId, "thr-new");
  service.dispose();
});

test("a conversation older than 30 days remains active when it has recent activity", async () => {
  const now = Date.now();
  const store = new MemoryStore();
  await store.set("codexWorkspaceThread", {
    threadId: "thr-long-lived",
    cwd: "/tmp/stock-agent-workspace",
    createdAt: new Date(now - (45 * 86_400_000)).toISOString(),
    updatedAt: new Date(now - 60_000).toISOString(),
  });
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new HistoryRpc(options, {
        currentThreadId: "thr-long-lived",
        liveThreads: [historyThread("thr-long-lived", Math.floor(now / 1_000) - 60)],
        turns: { "thr-long-lived": [] },
      });
      return rpc;
    },
  });
  await service.prepare();
  assert.equal(rpc.calls.some((call) => call.method === "thread/resume"), true);
  assert.equal(rpc.calls.some((call) => call.method === "thread/archive"), false);
  assert.equal(rpc.calls.some((call) => call.method === "thread/start"), false);
  service.dispose();
});

test("query_recent_history is a native dynamic tool and rejects cross-thread calls", async () => {
  const store = new MemoryStore();
  const rpcInstances = [];
  const service = createService({ store, rpcInstances });
  await service.prepare();
  const rpc = rpcInstances[0];

  rpc.options.onServerRequest({
    id: 70,
    method: "item/tool/call",
    params: {
      threadId: "thr-not-owned",
      turnId: "turn-1",
      callId: "call-70",
      tool: "query_recent_history",
      arguments: { query: "risk" },
    },
  });
  await waitUntil(() => rpc.results?.length === 1);
  assert.equal(rpc.results[0].result.success, false);
  assert.match(rpc.results[0].result.contentItems[0].text, /非交易驾驶舱线程/);

  rpc.options.onServerRequest({
    id: 71,
    method: "item/tool/call",
    params: {
      threadId: "thr-persistent-1",
      turnId: "turn-1",
      callId: "call-71",
      tool: "query_recent_history",
      arguments: "{\"query\":\"risk\",\"limit\":2}",
    },
  });
  await waitUntil(() => rpc.results?.length === 2);
  assert.equal(rpc.results[1].result.success, true);
  assert.equal(JSON.parse(rpc.results[1].result.contentItems[0].text).retentionDays, 30);
  service.dispose();
});

test("streamed agent text is the final fallback and tool lifecycle is deduplicated by item ID", async () => {
  const store = new MemoryStore();
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new StreamFallbackRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  const analysis = await service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "完整分析",
  });
  assert.equal(analysis.text, "only streamed answer");
  assert.equal(analysis.toolEvents.length, 1);
  assert.equal(analysis.toolEvents[0].itemId, "tool-stable");
  assert.equal(analysis.toolEvents[0].lifecycle, "completed");
  service.dispose();
});

test("a persisted completed turn is recovered when the terminal notification is lost", async () => {
  const store = new MemoryStore();
  const stream = [];
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    onStream: (event) => stream.push(event),
    rpcFactory: (options) => {
      rpc = new LostCompletionRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  const analysis = await Promise.race([
    service.analyze({
      portfolio: portfolioFixture(),
      run: runFixture(),
      task: "恢复丢失的终态",
    }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("persisted turn reconciliation timed out")),
      1_000,
    )),
  ]);
  assert.equal(analysis.text, "recovered final answer");
  assert.equal(stream.some((event) => event.kind === "final_message"
    && event.text === "recovered final answer"), true);
  assert.equal(rpc.calls.some((call) => call.method === "thread/turns/list"
    && call.params.itemsView === "summary"), true);
  assert.equal(await service.cancel(), false);
  service.dispose();
});

test("one turn aggregates every final_answer item in order and excludes commentary", async () => {
  let rpc;
  const stream = [];
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    onStream: (event) => stream.push(event),
    rpcFactory: (options) => {
      rpc = new SplitFinalAnswerRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  const analysis = await service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "聚合分段最终结论",
  });

  assert.equal(analysis.text, "第一段最终结论\n\n第二段执行计划");
  assert.equal(analysis.text.includes("运行中说明"), false);
  assert.equal(stream.filter((event) => event.kind === "final_message").at(-1)?.text,
    "第一段最终结论\n\n第二段执行计划");
  assert.equal(rpc.calls.some((call) => call.method === "turn/interrupt"), false);
  service.dispose();
});

test("terminal item history restores missing final segments in persisted order", async () => {
  let rpc;
  const stream = [];
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    onStream: (event) => stream.push(event),
    rpcFactory: (options) => {
      rpc = new PersistedSplitFinalRpc(options);
      return rpc;
    },
  });
  await service.prepare();
  const analysis = await Promise.race([
    service.analyze({
      portfolio: portfolioFixture(),
      run: runFixture(),
      task: "回收全部分段",
      operationId: "operation-persisted-split",
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("split recovery timed out")), 2_000)),
  ]);

  assert.equal(analysis.text, "第一段\n\n第二段");
  assert.equal(stream.filter((event) => event.kind === "final_message").at(-1)?.text,
    "第一段\n\n第二段");
  assert.equal(rpc.calls.some((call) => call.method === "thread/items/list"), true);
  assert.equal(rpc.calls.find((call) => call.method === "turn/start")?.params.clientUserMessageId,
    "operation-persisted-split");
  service.dispose();
});

test("historical recovery matches the exact client operation before repeated task text", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new RepeatedTaskHistoryRpc(options),
  });
  await service.prepare();
  const recovered = await service.recoverLatestTurn({
    threadId: "thr-persistent-1",
    operationId: "operation-newer",
    task: "分析全部持仓",
  });
  assert.equal(recovered.turnId, "turn-newer");
  assert.equal(recovered.text, "较新的组合结论");
  service.dispose();
});

test("an item notification adopts a lost turn/start response and history closes the turn", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new LostTurnStartResponseRpc(options),
  });
  await service.prepare();
  const analysis = await Promise.race([
    service.analyze({
      portfolio: portfolioFixture(),
      run: runFixture(),
      task: "turn start 响应丢失后恢复",
    }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("lost turn/start recovery timed out")),
      2_000,
    )),
  ]);
  assert.equal(analysis.text, "从持久 turn 恢复的最终结论");
  assert.equal(service.status().active, false);
  service.dispose();
});

test("a stable final_answer settles only after a quiet history-reconciliation window", async () => {
  const stream = [];
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    onStream: (event) => stream.push(event),
    rpcFactory: (options) => new FinalAnswerWithoutTurnCompletionRpc(options),
  });
  await service.prepare();
  const startedAt = Date.now();
  const analysis = await Promise.race([
    service.analyze({
      portfolio: portfolioFixture(),
      run: runFixture(),
      task: "最终文本已经完成，不应永久等待终态通知",
      operationId: "operation-final-grace",
    }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("stable final_answer recovery timed out")),
      8_000,
    )),
  ]);

  assert.equal(analysis.text, "final answer without turn completed");
  assert.equal(Date.now() - startedAt >= 4_500, true);
  assert.equal(Date.now() - startedAt < 8_000, true);
  assert.equal(stream.some((event) => event.kind === "final_message"
    && event.text === "final answer without turn completed"), true);
  assert.equal(service.status().active, false);
  assert.equal(await service.cancel(), false);
  service.dispose();
});

test("a late turn/start response cannot cancel stable-final settlement", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new DelayedTurnStartStableFinalRpc(options),
  });
  await service.prepare();
  const analysis = await Promise.race([
    service.analyze({
      portfolio: portfolioFixture(),
      run: runFixture(),
      task: "迟到 start 响应也要交付 final",
      operationId: "operation-late-start-final",
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("late start stable final timed out")), 7_000)),
  ]);
  assert.equal(analysis.text, "late start stable final");
  service.dispose();
});

test("a stable final settles even when turn/start and turn/completed responses are both lost", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new MissingTurnStartStableFinalRpc(options),
  });
  await service.prepare();
  const analysis = await Promise.race([
    service.analyze({
      portfolio: portfolioFixture(),
      run: runFixture(),
      task: "start 和 terminal 都丢失也要交付 final",
      operationId: "operation-missing-start-final",
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("missing start stable final timed out")), 7_000)),
  ]);
  assert.equal(analysis.text, "missing start stable final");
  service.dispose();
});

test("a new session is untitled until its first real task persists a summary title", async () => {
  const store = new MemoryStore();
  let rpc;
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    rpcFactory: (options) => {
      rpc = new MultiSessionRpc(options);
      return rpc;
    },
  });
  await service.prepare();

  const created = await service.createSession();
  assert.equal(created.name, "新对话");

  await service.cachePendingUserMessage({
    threadId: created.id,
    operationId: "operation-first-real-task",
    text: "$analyze-technical-structure 请分析 NVDA 候选买入计划与组合风险",
  });
  await waitUntil(() => rpc.calls.some((call) => call.method === "thread/name/set"
    && call.params.threadId === created.id
    && call.params.name !== "新对话"));
  await waitUntil(() => store.values.get("codexWorkspaceThreadRegistry")?.threads
    ?.some((thread) => thread.threadId === created.id && thread.name !== "新对话"));
  const registry = await store.get("codexWorkspaceThreadRegistry");
  const persisted = registry.threads.find((thread) => thread.threadId === created.id);
  assert.ok(persisted?.name);
  assert.notEqual(persisted.name, "新对话");
  assert.match(persisted.name, /NVDA|候选买入|组合风险/);
  assert.doesNotMatch(persisted.name, /\b\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}\b/);
  const current = await store.get("codexWorkspaceThread");
  assert.equal(current.name, persisted.name);
  assert.equal(rpc.calls.some((call) => call.method === "thread/name/set"
    && call.params.threadId === created.id
    && call.params.name === persisted.name), true);

  const renameCount = rpc.calls.filter((call) => call.method === "thread/name/set"
    && call.params.threadId === created.id).length;
  await service.cachePendingUserMessage({
    threadId: created.id,
    operationId: "operation-second-task",
    text: "再分析一次别的标的",
  });
  assert.equal(rpc.calls.filter((call) => call.method === "thread/name/set"
    && call.params.threadId === created.id).length, renameCount);
  service.dispose();
});

test("turn completion received before turn/start responds is queued by params.turn.id", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new EarlyCompletionRpc(options),
  });
  await service.prepare();
  const analysis = await service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "验证提前完成通知",
  });
  assert.equal(analysis.text, "early completed answer");
  assert.equal(service.status().active, false);
  service.dispose();
});

test("a malformed turn/start response always clears the local busy state", async () => {
  const service = new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store: new MemoryStore(),
    rpcFactory: (options) => new MissingTurnIdRpc(options),
  });
  await service.prepare();
  await assert.rejects(service.analyze({
    portfolio: portfolioFixture(),
    run: runFixture(),
    task: "验证协议错误清理",
  }), /没有返回 turn ID/);
  assert.equal(service.status().active, false);
  assert.equal(await service.cancel(), false);
  service.dispose();
});

test("App Server RPC uses the official persistent stdio protocol without exec restriction flags", async () => {
  const sent = [];
  let spawnArgs;
  const child = scriptedChild(sent);
  const rpc = new CodexAppServerRpc({
    codexPath: "/fake/codex",
    cwd: "/tmp/stock-agent-workspace",
    clientVersion: "0.5.0",
    spawnImpl: (_path, args, options) => {
      spawnArgs = { args, options };
      return child;
    },
  });
  await rpc.start();
  assert.deepEqual(spawnArgs.args, ["app-server", "--stdio"]);
  assert.equal(spawnArgs.args.includes("--ephemeral"), false);
  assert.equal(spawnArgs.args.includes("--ignore-user-config"), false);
  assert.equal(spawnArgs.options.cwd, "/tmp/stock-agent-workspace");
  assert.equal(sent[0].method, "initialize");
  assert.equal(sent[1].method, "initialized");
  rpc.dispose();
});

function createService({ store, rpcInstances, onStream = () => {} }) {
  return new CodexWorkspaceService({
    codexPath: "/fake/codex",
    workspaceDirectory: "/tmp/stock-agent-workspace",
    store,
    clientVersion: "0.5.0",
    onStream,
    rpcFactory: (options) => {
      const rpc = new FakeRpc(options);
      rpcInstances.push(rpc);
      return rpc;
    },
  });
}

class MemoryStore {
  constructor() {
    this.values = new Map();
  }
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async set(key, value) {
    this.values.set(key, structuredClone(value));
  }
}

class FakeRpc {
  constructor(options) {
    this.options = options;
    this.calls = [];
    this.ready = false;
  }
  async start() {
    this.ready = true;
  }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/start" || method === "thread/resume") {
      return {
        thread: {
          id: "thr-persistent-1",
          ephemeral: false,
          createdAt: Math.floor(Date.now() / 1_000),
        },
        cwd: "/tmp/stock-agent-workspace",
        model: "test-model",
        modelProvider: "openai",
        instructionSources: ["/tmp/stock-agent-workspace/AGENTS.md"],
      };
    }
    if (method === "skills/list") {
      return { data: [{ cwd: params.cwds[0], errors: [], skills: [
        {
          name: "technical-structure",
          path: "/skills/technical-structure/SKILL.md",
          description: "Technical analysis",
          enabled: true,
          scope: "user",
        },
        {
          name: "analyze-market-narratives",
          path: "/skills/analyze-market-narratives/SKILL.md",
          description: "Narrative and exposure analysis",
          enabled: true,
          scope: "user",
        },
        {
          name: "analyze-technical-structure",
          path: "/skills/analyze-technical-structure/SKILL.md",
          description: "EMA, Fib, and timing analysis",
          enabled: true,
          scope: "user",
        },
      ] }] };
    }
    if (method === "mcpServerStatus/list") {
      return { data: [{
        name: "market",
        authStatus: "oAuth",
        tools: { quote: { name: "quote", title: "Quote", description: "Latest quote" } },
      }] };
    }
    if (method === "app/list") {
      return { data: [
        { id: "research-app", name: "Research", description: "Research data", isAccessible: true, isEnabled: true },
        { id: "hidden-app", name: "Hidden", isAccessible: false, isEnabled: true },
      ] };
    }
    if (method === "turn/start") {
      setImmediate(() => {
        this.options.onNotification({ method: "item/agentMessage/delta", params: {
          threadId: "thr-persistent-1", turnId: "turn-1", itemId: "msg-1", delta: "持久 Codex ",
        } });
        const tool = {
          type: "mcpToolCall", id: "tool-1", server: "market", tool: "quote",
          arguments: {}, status: "completed",
        };
        this.options.onNotification({ method: "item/completed", params: {
          threadId: "thr-persistent-1", turnId: "turn-1", item: tool,
        } });
        this.options.onNotification({ method: "item/completed", params: {
          threadId: "thr-persistent-1", turnId: "turn-1",
          item: { type: "agentMessage", id: "msg-1", text: "持久 Codex 已结合 MCP 完成分析。" },
        } });
        this.options.onNotification({ method: "turn/completed", params: {
          threadId: "thr-persistent-1",
          turn: {
            id: "turn-1", status: "completed",
            items: [{ type: "agentMessage", id: "msg-1", text: "持久 Codex 已结合 MCP 完成分析。" }],
          },
        } });
      });
      return { turn: { id: "turn-1", status: "inProgress", items: [] } };
    }
    return {};
  }
  respondResult(id, result) {
    this.results ??= [];
    this.results.push({ id, result });
  }
  respondError() {}
  dispose() {
    this.ready = false;
  }
}

class HangingInventoryRpc extends FakeRpc {
  async request(method, params) {
    if (["skills/list", "mcpServerStatus/list", "app/list"].includes(method)) {
      this.calls.push({ method, params });
      return new Promise(() => {});
    }
    return super.request(method, params);
  }
}

class GuardedLongbridgeRpc extends FakeRpc {
  async request(method, params) {
    if (method === "config/read") {
      this.calls.push({ method, params });
      return {
        config: {
          mcp_servers: {
            broker_data: {
              url: "https://mcp.longbridge.com/v2",
              disabled_tools: ["existing_disabled"],
            },
          },
          apps: { longbridge: { enabled: true } },
        },
      };
    }
    if (method === "app/list") {
      this.calls.push({ method, params });
      return { data: [
        { id: "longbridge", name: "Longbridge", isAccessible: true, isEnabled: true },
        { id: "research-app", name: "Research", isAccessible: true, isEnabled: true },
      ] };
    }
    if (method === "mcpServerStatus/list") {
      this.calls.push({ method, params });
      return { data: [{
        name: "broker_data",
        serverInfo: { title: "Broker data", websiteUrl: "https://mcp.longbridge.com" },
        authStatus: "oAuth",
        tools: {
          quote: { name: "quote", title: "Quote", description: "Latest quote" },
          stock_positions: { name: "stock_positions", title: "Positions", description: "Positions" },
          submit_order: { name: "submit_order", title: "Submit order", description: "Place an order" },
        },
      }] };
    }
    return super.request(method, params);
  }
}

class UnguardedLongbridgeRpc extends FakeRpc {
  async request(method, params) {
    if (method === "config/read") {
      this.calls.push({ method, params });
      return { config: {} };
    }
    if (method === "app/list") {
      this.calls.push({ method, params });
      return { data: [] };
    }
    if (method === "mcpServerStatus/list") {
      this.calls.push({ method, params });
      return { data: [{
        name: "longbridge-proxy",
        authStatus: "oAuth",
        tools: {
          quote: { name: "quote", title: "Quote", description: "Latest quote" },
          submit_order: { name: "submit_order", title: "Submit order", description: "Place an order" },
        },
      }] };
    }
    return super.request(method, params);
  }
}

class MultiSessionRpc extends FakeRpc {
  constructor(options, { hangingTurns = false } = {}) {
    super(options);
    this.hangingTurns = hangingTurns;
    this.nextThreadNumber = 1;
    this.threads = new Map();
    this.turns = new Map();
  }
  async request(method, params) {
    if (method === "thread/start") {
      this.calls.push({ method, params });
      const id = `thr-session-${this.nextThreadNumber++}`;
      const now = new Date().toISOString();
      this.threads.set(id, {
        id,
        name: "交易驾驶舱 Agent",
        preview: "",
        createdAt: now,
        updatedAt: now,
        recencyAt: now,
      });
      return this.#threadResponse(id);
    }
    if (method === "thread/resume") {
      this.calls.push({ method, params });
      if (!this.threads.has(params.threadId)) throw new Error("missing thread");
      return this.#threadResponse(params.threadId);
    }
    if (method === "thread/name/set") {
      this.calls.push({ method, params });
      const thread = this.threads.get(params.threadId);
      if (thread) thread.name = params.name;
      return {};
    }
    if (method === "thread/list") {
      this.calls.push({ method, params });
      return { data: [...this.threads.values()], nextCursor: null };
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      return { data: this.turns.get(params.threadId) ?? [], nextCursor: null };
    }
    if (method === "turn/start" && this.hangingTurns) {
      this.calls.push({ method, params });
      return { turn: { id: "turn-session-hanging", status: "inProgress", items: [] } };
    }
    if (method === "turn/interrupt" && this.hangingTurns) {
      this.calls.push({ method, params });
      return {};
    }
    return super.request(method, params);
  }
  completeThread(threadId, text) {
    const turn = {
      id: "turn-session-hanging",
      status: "completed",
      items: [{ type: "agentMessage", id: `message-${threadId}`, phase: "final_answer", text }],
    };
    this.turns.set(threadId, [turn]);
    this.options.onNotification({
      method: "turn/completed",
      params: { threadId, turn },
    });
  }
  #threadResponse(id) {
    const thread = this.threads.get(id);
    return {
      thread: {
        id,
        ephemeral: false,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      },
      cwd: "/tmp/stock-agent-workspace",
      model: "test-model",
      modelProvider: "openai",
      instructionSources: ["/tmp/stock-agent-workspace/AGENTS.md"],
      initialTurnsPage: {
        data: this.turns.get(id) ?? [],
        nextCursor: null,
      },
    };
  }
}

class HistoryHydrationFailureRpc extends MultiSessionRpc {
  async request(method, params) {
    if (method === "thread/resume") {
      const response = await super.request(method, params);
      delete response.initialTurnsPage;
      return response;
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      throw new CodexWorkspaceError("timeout", "thread/turns/list 请求超时。");
    }
    return super.request(method, params);
  }
}

class HangingTurnRpc extends FakeRpc {
  async request(method, params) {
    if (method === "turn/start") {
      this.calls.push({ method, params });
      return { turn: { id: "turn-hanging", status: "inProgress", items: [] } };
    }
    if (method === "turn/interrupt") {
      this.calls.push({ method, params });
      return new Promise(() => {});
    }
    return super.request(method, params);
  }
}

class PendingTurnStartRpc extends FakeRpc {
  constructor(options) {
    super(options);
    this.turnStartPromise = new Promise((resolve) => {
      this.resolvePendingTurnStart = resolve;
    });
  }
  async request(method, params) {
    if (method === "turn/start") {
      this.calls.push({ method, params });
      return this.turnStartPromise;
    }
    if (method === "turn/interrupt") {
      this.calls.push({ method, params });
      return {};
    }
    return super.request(method, params);
  }
  resolveTurnStart() {
    this.resolvePendingTurnStart({
      turn: { id: "turn-started-late", status: "inProgress", items: [] },
    });
  }
}

class HistoryRpc extends FakeRpc {
  constructor(options, config) {
    super(options);
    this.config = config;
    this.archived = new Set();
  }
  async request(method, params) {
    if (method === "thread/start" || method === "thread/resume") {
      this.calls.push({ method, params });
      return {
        thread: {
          id: this.config.currentThreadId,
          ephemeral: false,
          createdAt: Math.floor(Date.now() / 1_000),
        },
        cwd: "/tmp/stock-agent-workspace",
        model: "test-model",
        modelProvider: "openai",
        instructionSources: [],
      };
    }
    if (method === "thread/list") {
      this.calls.push({ method, params });
      return {
        data: this.config.liveThreads.filter((thread) => !this.archived.has(thread.id)),
        nextCursor: null,
      };
    }
    if (method === "thread/read") {
      this.calls.push({ method, params });
      const thread = this.config.liveThreads.find((entry) => entry.id === params.threadId);
      return thread ? { thread } : {};
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      return { data: this.config.turns[params.threadId] ?? [], nextCursor: null };
    }
    if (method === "thread/archive") {
      this.calls.push({ method, params });
      this.archived.add(params.threadId);
      return {};
    }
    return super.request(method, params);
  }
}

class StreamFallbackRpc extends FakeRpc {
  async request(method, params) {
    if (method !== "turn/start") return super.request(method, params);
    this.calls.push({ method, params });
    setImmediate(() => {
      const startedTool = {
        type: "mcpToolCall",
        id: "tool-stable",
        server: "market",
        tool: "quote",
        status: "inProgress",
      };
      const completedTool = { ...startedTool, status: "completed" };
      this.options.onNotification({
        method: "item/started",
        params: { threadId: "thr-persistent-1", turnId: "turn-stream", item: startedTool },
      });
      this.options.onNotification({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thr-persistent-1",
          turnId: "turn-stream",
          itemId: "message-stable",
          delta: "only streamed answer",
        },
      });
      this.options.onNotification({
        method: "item/completed",
        params: { threadId: "thr-persistent-1", turnId: "turn-stream", item: completedTool },
      });
      this.options.onNotification({
        method: "turn/completed",
        params: {
          threadId: "thr-persistent-1",
          turn: { id: "turn-stream", status: "completed", items: [] },
        },
      });
    });
    return { turn: { id: "turn-stream", status: "inProgress", items: [] } };
  }
}

class LostCompletionRpc extends FakeRpc {
  async request(method, params) {
    if (method === "turn/start") {
      this.calls.push({ method, params });
      setImmediate(() => {
        this.options.onNotification({
          method: "item/completed",
          params: {
            threadId: "thr-persistent-1",
            turnId: "turn-lost-terminal",
            item: {
              type: "agentMessage",
              id: "commentary-1",
              phase: "commentary",
              text: "intermediate commentary",
            },
          },
        });
        this.options.onNotification({
          method: "item/completed",
          params: {
            threadId: "thr-persistent-1",
            turnId: "turn-lost-terminal",
            item: {
              type: "agentMessage",
              id: "final-1",
              phase: "final_answer",
              text: "recovered final answer",
            },
          },
        });
        this.options.onNotification({
          method: "turn/completed",
          params: {
            threadId: "unrelated-thread",
            turn: { id: "turn-lost-terminal", status: "failed", items: [] },
          },
        });
        this.options.onNotification({
          method: "thread/status/changed",
          params: { threadId: "thr-persistent-1", status: { type: "idle" } },
        });
      });
      return { turn: { id: "turn-lost-terminal", status: "inProgress", items: [] } };
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      return {
        data: [{
          id: "turn-lost-terminal",
          status: "completed",
          error: null,
          items: [
            { type: "agentMessage", id: "commentary-1", phase: "commentary", text: "intermediate commentary" },
            { type: "agentMessage", id: "final-1", phase: "final_answer", text: "recovered final answer" },
          ],
        }],
        nextCursor: null,
      };
    }
    return super.request(method, params);
  }
}

class SplitFinalAnswerRpc extends FakeRpc {
  async request(method, params) {
    if (method !== "turn/start") return super.request(method, params);
    this.calls.push({ method, params });
    setImmediate(() => {
      const notifyItem = (item) => this.options.onNotification({
        method: "item/completed",
        params: { threadId: "thr-persistent-1", turnId: "turn-split-final", item },
      });
      notifyItem({
        type: "agentMessage", id: "commentary-split", phase: "commentary", text: "运行中说明",
      });
      notifyItem({
        type: "agentMessage", id: "final-split-1", phase: "final_answer", text: "第一段最终结论",
      });
      notifyItem({
        type: "agentMessage", id: "final-split-2", phase: "final_answer", text: "第二段执行计划",
      });
      this.options.onNotification({
        method: "turn/completed",
        params: {
          threadId: "thr-persistent-1",
          turn: {
            id: "turn-split-final",
            status: "completed",
            items: [
              { type: "agentMessage", id: "commentary-split", phase: "commentary", text: "运行中说明" },
              { type: "agentMessage", id: "final-split-1", phase: "final_answer", text: "第一段最终结论" },
              { type: "agentMessage", id: "final-split-2", phase: "final_answer", text: "第二段执行计划" },
            ],
          },
        },
      });
    });
    return { turn: { id: "turn-split-final", status: "inProgress", items: [] } };
  }
}

class PersistedSplitFinalRpc extends FakeRpc {
  async request(method, params) {
    if (method === "turn/start") {
      this.calls.push({ method, params });
      setImmediate(() => {
        this.options.onNotification({
          method: "item/completed",
          params: {
            threadId: "thr-persistent-1",
            turnId: "turn-persisted-split",
            item: { type: "agentMessage", id: "final-2", phase: "final_answer", text: "第二段" },
          },
        });
        this.options.onNotification({
          method: "thread/status/changed",
          params: { threadId: "thr-persistent-1", status: { type: "idle" } },
        });
      });
      return { turn: { id: "turn-persisted-split", status: "inProgress", items: [] } };
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      return {
        data: [{
          id: "turn-persisted-split",
          status: "completed",
          items: [{ type: "agentMessage", id: "final-2", phase: "final_answer", text: "第二段" }],
        }],
        nextCursor: null,
      };
    }
    if (method === "thread/items/list") {
      this.calls.push({ method, params });
      return {
        data: [
          { turnId: "turn-persisted-split", item: { type: "agentMessage", id: "final-1", phase: "final_answer", text: "第一段" } },
          { turnId: "turn-persisted-split", item: { type: "agentMessage", id: "final-2", phase: "final_answer", text: "第二段" } },
        ],
        nextCursor: null,
      };
    }
    return super.request(method, params);
  }
}

class RepeatedTaskHistoryRpc extends FakeRpc {
  async request(method, params) {
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      return {
        data: [
          repeatedTaskTurn("turn-older", "operation-older", "较旧的组合结论"),
          repeatedTaskTurn("turn-newer", "operation-newer", "较新的组合结论"),
        ],
        nextCursor: null,
      };
    }
    if (method === "thread/items/list") {
      this.calls.push({ method, params });
      const turn = params.turnId === "turn-newer"
        ? repeatedTaskTurn("turn-newer", "operation-newer", "较新的组合结论")
        : repeatedTaskTurn("turn-older", "operation-older", "较旧的组合结论");
      return {
        data: turn.items.map((item) => ({ turnId: turn.id, item })),
        nextCursor: null,
      };
    }
    return super.request(method, params);
  }
}

function repeatedTaskTurn(id, clientId, text) {
  return {
    id,
    status: "completed",
    items: [
      { type: "userMessage", id: `${id}-user`, clientId, content: [{ type: "text", text: "分析全部持仓" }] },
      { type: "agentMessage", id: `${id}-final`, phase: "final_answer", text },
    ],
  };
}

class LostTurnStartResponseRpc extends FakeRpc {
  constructor(options) {
    super(options);
    this.persisted = false;
  }
  async request(method, params) {
    if (method === "turn/start") {
      this.calls.push({ method, params });
      setImmediate(() => {
        this.persisted = true;
        this.options.onNotification({
          method: "item/completed",
          params: {
            threadId: "thr-persistent-1",
            turnId: "turn-start-response-lost",
            item: {
              type: "agentMessage",
              id: "lost-start-final",
              phase: "final_answer",
              text: "从持久 turn 恢复的最终结论",
            },
          },
        });
      });
      return new Promise(() => {});
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      return {
        data: this.persisted ? [{
          id: "turn-start-response-lost",
          status: "completed",
          items: [{
            type: "agentMessage",
            id: "lost-start-final",
            phase: "final_answer",
            text: "从持久 turn 恢复的最终结论",
          }],
        }] : [],
        nextCursor: null,
      };
    }
    return super.request(method, params);
  }
}

class FinalAnswerWithoutTurnCompletionRpc extends FakeRpc {
  async request(method, params) {
    if (method === "turn/start") {
      this.calls.push({ method, params });
      setImmediate(() => {
        this.options.onNotification({
          method: "item/completed",
          params: {
            threadId: "thr-persistent-1",
            turnId: "turn-final-only",
            item: {
              type: "agentMessage",
              id: "final-only-message",
              phase: "final_answer",
              text: "final answer without turn completed",
            },
          },
        });
      });
      return { turn: { id: "turn-final-only", status: "inProgress", items: [] } };
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      return {
        data: [{
          id: "turn-final-only",
          status: "inProgress",
          items: [{
            type: "agentMessage",
            id: "final-only-message",
            phase: "final_answer",
            text: "final answer without turn completed",
          }],
        }],
        nextCursor: null,
      };
    }
    return super.request(method, params);
  }
}

class DelayedTurnStartStableFinalRpc extends FakeRpc {
  async request(method, params) {
    if (method === "turn/start") {
      this.calls.push({ method, params });
      return new Promise((resolve) => {
        setImmediate(() => this.options.onNotification({
          method: "item/completed",
          params: {
            threadId: "thr-persistent-1",
            turnId: "turn-late-start-final",
            item: { type: "agentMessage", id: "late-final", phase: "final_answer", text: "late start stable final" },
          },
        }));
        setTimeout(() => resolve({
          turn: { id: "turn-late-start-final", status: "inProgress", items: [] },
        }), 80);
      });
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      return {
        data: [{ id: "turn-late-start-final", status: "inProgress", items: [] }],
        nextCursor: null,
      };
    }
    return super.request(method, params);
  }
}

class MissingTurnStartStableFinalRpc extends FakeRpc {
  async request(method, params) {
    if (method === "turn/start") {
      this.calls.push({ method, params });
      setImmediate(() => this.options.onNotification({
        method: "item/completed",
        params: {
          threadId: "thr-persistent-1",
          turnId: "turn-missing-start-final",
          item: { type: "agentMessage", id: "missing-start-final", phase: "final_answer", text: "missing start stable final" },
        },
      }));
      return new Promise(() => {});
    }
    if (method === "thread/turns/list") {
      this.calls.push({ method, params });
      return {
        data: [{ id: "turn-missing-start-final", status: "inProgress", items: [] }],
        nextCursor: null,
      };
    }
    return super.request(method, params);
  }
}

class EarlyCompletionRpc extends FakeRpc {
  async request(method, params) {
    if (method !== "turn/start") return super.request(method, params);
    this.calls.push({ method, params });
    this.options.onNotification({
      method: "turn/completed",
      params: {
        threadId: "thr-persistent-1",
        turn: {
          id: "turn-early",
          status: "completed",
          items: [{
            type: "agentMessage",
            id: "early-final",
            phase: "final_answer",
            text: "early completed answer",
          }],
        },
      },
    });
    return { turn: { id: "turn-early", status: "inProgress", items: [] } };
  }
}

class MissingTurnIdRpc extends FakeRpc {
  async request(method, params) {
    if (method !== "turn/start") return super.request(method, params);
    this.calls.push({ method, params });
    return { turn: { status: "inProgress", items: [] } };
  }
}

function historyThread(id, recencyAt) {
  return {
    id,
    name: "交易驾驶舱 Agent",
    preview: "",
    createdAt: recencyAt - 60,
    updatedAt: recencyAt,
    recencyAt,
  };
}

function historyTurn(id, completedAt, userText, assistantText = "assistant response") {
  return {
    id,
    startedAt: completedAt - 1,
    completedAt,
    items: [
      { type: "userMessage", content: [{ type: "inputText", text: userText }] },
      { type: "agentMessage", text: assistantText },
    ],
  };
}

async function waitUntil(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function scriptedChild(sent) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  let buffer = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      sent.push(message);
      if (message.method === "initialize") {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({
          id: message.id,
          result: { userAgent: "test", platformFamily: "unix", platformOs: "macos" },
        })}\n`));
      }
    }
  });
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit("close", 0, "SIGTERM"));
    return true;
  };
  return child;
}

function portfolioFixture() {
  return {
    status: "live",
    account: { baseCurrency: "USD" },
    totals: { cashRatio: 20, top1Weight: 12, top5Weight: 42 },
    dataQuality: { valuationComplete: true, fxStatus: "reference" },
    fx: { provider: "European Central Bank", asOf: "2026-07-17" },
    positions: [{
      symbol: "AAPL.US", ticker: "AAPL", name: "Apple", group: "科技",
      instrumentType: "equity", currency: "USD", quantity: 10,
      availableQuantity: 10, costPrice: 95, lastPrice: 100, weight: 12, pnlPercent: 5.26,
    }],
  };
}

function runFixture() {
  return {
    id: "run-1", elapsedMs: 200, task: "分析", state: "REVIEW_READY",
    context: {
      symbol: "AAPL.US", ticker: "AAPL", timeframe: "1D",
      snapshotAt: "2026-07-19T00:00:00.000Z", marketDataAsOf: "2026-07-18T00:00:00.000Z",
    },
    technical: { ema: { 21: 98 }, shortStructure: "交错", longStructure: "长周期多头" },
    risk: {
      groupWeight: 18, riskBudgetPercent: 0.8, referenceLabel: "EMA21",
      referenceLevel: 98, portfolioImpactAtReferencePercent: -0.24, limitation: null,
    },
    plan: {
      available: true,
      scenarios: [
        { name: "牛", tone: "bull", if: "收复 EMA21", then: "观察", invalidation: "跌破", impact: "重算" },
        { name: "基准", tone: "base", if: "震荡", then: "等待", invalidation: "离开区间", impact: "不变" },
        { name: "熊", tone: "bear", if: "破位", then: "评估保护", invalidation: "收回", impact: "重算" },
      ],
    },
    conclusion: { headline: "本地结论", body: "本地规则文本", posture: "等待" },
    evidence: [], safeguards: { orderWrite: false, modelNarration: false }, capabilities: {},
  };
}

function candidateRunFixture() {
  return {
    id: "candidate-run-1",
    elapsedMs: 200,
    task: "评估候选仓位",
    state: "REVIEW_READY",
    context: {
      scope: "candidate",
      symbol: "NVDA.US",
      ticker: "NVDA",
      snapshotAt: "2026-07-19T00:00:00.000Z",
      marketDataAsOf: "2026-07-18T00:00:00.000Z",
    },
    analysisContext: {
      scope: "candidate",
      portfolioSummary: { netAssets: 100_000, cashRatioPercent: 20 },
      target: { symbol: "NVDA.US", ticker: "NVDA", isHeld: false },
    },
    technical: { ema: { 21: 98 }, shortStructure: "交错", longStructure: "长周期多头" },
    risk: {
      scope: "candidate",
      supported: true,
      entryAllowed: true,
      entryBlockReasons: [],
      existingPositionWeight: 0,
      group: "候选标的",
      groupWeight: null,
      candidateGroupKnown: false,
      baseCurrency: "USD",
      recommendedInitialAdditionalWeightPercent: 2,
      recommendedInitialTotalWeightPercent: 2,
      recommendedInitialNotionalBase: 2_000,
      recommendedMaxAdditionalWeightPercent: 4,
      recommendedMaxWeightPercent: 4,
      recommendedMaxAdditionalNotionalBase: 4_000,
      moveToReferencePercent: -8,
      portfolioImpactAtReferencePercent: -0.32,
      leverage: {
        decision: "cash_only",
        additionalLeverageAllowed: false,
        maxAdditionalBorrowedWeightPercent: 0,
        disabledReasons: [],
      },
      portfolioConstraints: {
        groupExposure: [{ key: "半导体", weight: 29 }],
        policyThresholds: { groupWarningPercent: 30 },
      },
    },
    plan: {
      available: true,
      state: "candidate_snapshot",
      riskSizingAvailable: true,
      sizing: {},
      scenarios: [
        { name: "允许试探", tone: "bull", if: "站回 EMA21", then: "初始 2%", invalidation: "破位", impact: "-0.32%" },
        { name: "等待", tone: "base", if: "交错", then: "等待", invalidation: "脱离", impact: "0" },
      ],
    },
    conclusion: { headline: "本地候选结论", body: "本地规则文本", posture: "等待" },
    evidence: [],
    safeguards: { orderWrite: false, modelNarration: false },
    capabilities: {},
  };
}
