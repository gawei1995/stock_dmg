import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const renderer = await readFile(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const html = await readFile(new URL("../renderer/index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../renderer/styles.css", import.meta.url), "utf8");

function implementation(name) {
  const start = renderer.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = renderer.slice(start);
  const end = tail.slice(1).search(/\n(?:async )?function \w+\(/);
  return end < 0 ? tail : tail.slice(0, end + 1);
}

function functions(names, values) {
  const context = vm.createContext(values);
  vm.runInContext(names.map(implementation).join("\n"), context);
  return context;
}

const restrictedMode = {
  kind: "restricted", available: true, reason: "catalog_unavailable",
  unavailableTools: ["MCP", "Apps"], recoveryAction: "new_full_session",
};

function statusFixture() {
  const elements = Object.fromEntries([
    "agentAvailability", "agentGuardActions", "agentGuardRecheck", "agentGuardNewSession",
    "agentRestrictedSession", "agentFullSession", "agentGuardFeedback",
  ].map(key => [key, {}]));
  elements.codexBadge = { classList: { toggle() {} } };
  return functions(["agentNetworkRuntimeView", "setCodexStatus", "setAgentCapabilities", "recheckAgentReadOnlyGuard"], {
    state: {}, elements,
    api: { agentSessions: { create() {} }, recheckAgentReadOnlyGuard: async () => ({
      available: true, ready: true, readOnlyGuardReady: true, researchMode: restrictedMode,
    }) },
    updateAgentSubmitState() {}, renderAgentSessions() {}, renderAgentNetworkPreferences() {}, updatePromptSuggestions() {},
  });
}

test("restricted research stays usable only with a positively verified ready guard", () => {
  const context = statusFixture();
  for (const guard of [false, undefined]) {
    context.setCodexStatus({ available: true, ready: true, readOnlyGuardReady: guard, researchMode: restrictedMode });
    assert.equal(context.state.codexAvailable, false);
    assert.equal(context.elements.codexBadge.textContent, "CODEX GUARD");
  }
  context.setCodexStatus({ available: true, ready: true, readOnlyGuardReady: true,
    readOnlyGuard: { ready: false }, researchMode: restrictedMode });
  assert.equal(context.state.codexAvailable, false);
  context.setCodexStatus({ available: true, ready: true, readOnlyGuardReady: true, researchMode: restrictedMode });
  assert.equal(context.state.codexAvailable, true);
  assert.equal(context.elements.codexBadge.textContent, "CODEX LIMITED");
  assert.equal(context.elements.agentAvailability.hidden, false);
  assert.match(context.elements.agentAvailability.textContent, /研究可用·外部工具受限/);
  assert.match(context.elements.agentAvailability.textContent, /本对话的外部 MCP \/ Apps 已关闭/);
  assert.match(context.elements.agentAvailability.textContent, /Skills、Web、项目文件.*只读券商数据/);
  assert.match(context.elements.agentAvailability.textContent, /不表示券商账户断开/);
  assert.equal(context.elements.agentFullSession.hidden, false);
  assert.equal(context.elements.agentRestrictedSession.hidden, true);
  context.setCodexStatus({ available: true, ready: true, readOnlyGuardReady: true,
    researchMode: { ...restrictedMode, available: false } });
  assert.equal(context.state.codexAvailable, false);
  context.setCodexStatus({ available: true, ready: false, readOnlyGuardReady: true, researchMode: restrictedMode });
  assert.equal(context.state.codexAvailable, false);
});

test("failed full conversations offer an explicit new restricted thread and never claim account disconnection", () => {
  const context = statusFixture();
  context.setCodexStatus({ available: true, ready: true, readOnlyGuardReady: false,
    researchMode: { kind: "full", available: false, recoveryAction: null } });
  assert.equal(context.elements.agentRestrictedSession.hidden, false);
  assert.equal(context.elements.agentFullSession.hidden, true);
  assert.match(context.elements.agentAvailability.textContent, /原对话保留/);
  assert.match(context.elements.agentAvailability.textContent, /仅该新对话关闭外部 MCP \/ Apps/);
  context.setCodexStatus({ available: true, ready: true, readOnlyGuardReady: true,
    researchMode: { kind: "full", available: true, recoveryAction: null } });
  assert.equal(context.elements.codexBadge.textContent, "CODEX READY");
  assert.equal(context.elements.agentAvailability.hidden, true);
  assert.equal(context.elements.agentGuardActions.hidden, true);
});

test("guard recheck preserves limited mode and does not promise external tool recovery", async () => {
  const context = statusFixture();
  let creates = 0;
  context.api.agentSessions.create = () => creates++;
  context.setCodexStatus({ available: true, ready: true, readOnlyGuardReady: true, researchMode: restrictedMode });
  await context.recheckAgentReadOnlyGuard();
  assert.equal(context.state.codexAvailable, true);
  assert.equal(context.elements.codexBadge.textContent, "CODEX LIMITED");
  assert.match(context.elements.agentGuardFeedback.textContent, /外部 MCP \/ Apps 仍关闭/);
  assert.match(context.elements.agentGuardFeedback.textContent, /显式新建完整工具对话/);
  assert.equal(creates, 0);
});

test("session creation sends a tool mode only from the two explicit supported choices", async () => {
  const requests = [];
  let sequence = 0;
  const state = { activeSessionId: "original", agentSessions: [], sessionViews: new Map() };
  const ensureSessionView = id => {
    if (!state.sessionViews.has(id)) state.sessionViews.set(id, { transcript: [] });
    return state.sessionViews.get(id);
  };
  const context = functions(["createAgentSession"], {
    state, api: { agentSessions: { create: async request => {
      requests.push({ ...request });
      return { session: { id: `new-${++sequence}`, name: request.name } };
    } } },
    crypto: { randomUUID: () => `provisional-${sequence}` }, ensureSessionView,
    saveActiveSessionView() {}, resetAgentConversation() {}, renderAgentSessions() {},
    restoreSessionAgentResult() {}, setSystemMessage: error => assert.fail(error),
  });
  await context.createAgentSession();
  await context.createAgentSession({ type: "click", target: {}, toolMode: "invalid" });
  await context.createAgentSession({ toolMode: "restricted" });
  await context.createAgentSession({ toolMode: "full" });
  assert.deepEqual(requests, [
    { name: "新对话" }, { name: "新对话" },
    { name: "新对话", toolMode: "restricted" }, { name: "新对话", toolMode: "full" },
  ]);
  assert.match(renderer, /newAgentSession\.addEventListener\("click", \(\) => createAgentSession\(\)\)/);
  assert.match(renderer, /agentRestrictedSession\?\.addEventListener\("click", \(\) => createResearchModeSession\("restricted"\)\)/);
  assert.match(renderer, /agentFullSession\?\.addEventListener\("click", \(\) => createResearchModeSession\("full"\)\)/);
});

test("chat can submit without a portfolio, while position, candidate, portfolio and review validation remain", async () => {
  const calls = [], notices = [];
  const context = functions(["submitAgentTask"], {
    state: { analysisScope: "chat", codexAvailable: true, activeSessionId: "thread", portfolio: null, candidateSymbol: "" },
    elements: { agentInput: { value: "解释这个研究框架", focus() {} }, candidateSymbol: { value: "", focus() {} }, riskBudget: { value: "0.8" } },
    closePromptSuggestions() {}, ensureSessionView: () => ({ reviewContext: null }), selectedPosition: () => null,
    normalizeCandidateSymbol: value => String(value ?? ""),
    startAgentOperation: request => calls.push({ ...request }), setSystemMessage: message => notices.push(message),
  });
  const submit = () => context.submitAgentTask({ preventDefault() {} });
  await submit();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, "chat");
  assert.equal(calls[0].task, "解释这个研究框架");
  assert.equal(calls[0].targetSymbol, null);
  for (const scope of ["position", "candidate", "portfolio"]) {
    context.state.analysisScope = scope;
    await submit();
    assert.match(notices.at(-1), /需要先连接券商/);
  }
  context.state.portfolio = { positions: [] };
  context.state.analysisScope = "position";
  await submit();
  assert.match(notices.at(-1), /请选择.*真实持仓/);
  context.state.analysisScope = "candidate";
  await submit();
  assert.match(notices.at(-1), /请输入未持有候选标的/);
  context.state.analysisScope = "review";
  await submit();
  assert.match(notices.at(-1), /缺少已关联周期或案例/);
  context.state.analysisScope = "chat";
  context.state.codexAvailable = false;
  await submit();
  assert.match(notices.at(-1), /只读隔离尚未就绪/);
  context.state.codexAvailable = true;
  context.elements.agentInput.value = "  ";
  await submit();
  assert.match(notices.at(-1), /请输入.*问题/);
  assert.equal(calls.length, 1);
});

test("chat submit enablement and freshness are independent of live portfolio data but not guard readiness", () => {
  const context = functions(["updateAgentSubmitState", "isRunStale"], {
    state: { analysisScope: "chat", codexAvailable: true, activeSessionId: "thread", agentSessions: [], portfolio: null },
    elements: { agentSubmit: {}, agentCancel: {} }, activeOperationForThread: () => null,
  });
  context.updateAgentSubmitState();
  assert.equal(context.elements.agentSubmit.disabled, false);
  assert.equal(context.isRunStale({ context: { scope: "chat" } }), false);
  context.state.codexAvailable = false;
  context.updateAgentSubmitState();
  assert.equal(context.elements.agentSubmit.disabled, true);
  context.state.codexAvailable = true;
  context.state.analysisScope = "portfolio";
  context.updateAgentSubmitState();
  assert.equal(context.elements.agentSubmit.disabled, true);
  assert.equal(context.isRunStale({ context: { scope: "chat" } }), true);
  assert.equal(context.isRunStale({ context: { scope: "portfolio" } }), true);
});

test("new views default to chat without a portfolio and saved per-session scopes remain intact", () => {
  const buttons = ["chat", "position", "candidate", "portfolio"].map(scope => ({
    dataset: { scope }, setAttribute(key, value) { this[key] = value; },
  }));
  const context = functions(["ensureSessionView", "restoreSessionComposer"], {
    state: { portfolio: null, sessionViews: new Map() },
    document: { querySelectorAll: () => buttons },
    elements: { candidateSymbolField: {}, candidateSymbol: {}, riskBudget: {}, agentInput: {} },
    renderReviewAgentContext() {}, renderAgentContext() {},
  });
  const view = context.ensureSessionView("first");
  assert.equal(view.scope, "chat");
  context.restoreSessionComposer(view);
  assert.equal(context.state.analysisScope, "chat");
  assert.equal(buttons[0]["aria-checked"], "true");
  view.scope = "candidate";
  view.candidateSymbol = "NVDA.US";
  view.draft = "保留原问题";
  context.restoreSessionComposer(view);
  assert.equal(context.state.analysisScope, "candidate");
  assert.equal(context.elements.candidateSymbolField.hidden, false);
  assert.equal(context.elements.agentInput.value, "保留原问题");
  assert.equal(context.ensureSessionView("first"), view);
  context.state.portfolio = { positions: [] };
  assert.equal(context.ensureSessionView("second").scope, "position");
});

test("restricted suggestions cannot advertise external apps or MCP as available", () => {
  const context = functions(["capabilityItems"], {
    state: { codexStatus: { researchMode: restrictedMode }, agentCapabilities: {
      skills: [{ name: "local-research" }], apps: [{ id: "connected-app", name: "App" }],
      mcpServers: [{ name: "broker", authStatus: "loggedIn", runtimeStatus: "connected", tools: [{ name: "quote" }] }],
    } },
  });
  const items = context.capabilityItems();
  assert.equal(items.find(item => item.kind === "SKILL").available, true);
  for (const item of items.filter(item => ["APP", "MCP", "TOOL"].includes(item.kind))) {
    assert.equal(item.available, false);
  }
  assert.match(items.find(item => item.kind === "MCP").description, /本对话已关闭外部 MCP/);
});

test("chat results do not fabricate market modules and controls stay bounded", () => {
  const wrapper = { dataset: {}, querySelector: () => null };
  const context = functions(["renderAgentRun"], {
    document: { createElement: () => wrapper }, isRunStale: () => false, candidateSizingExpired: () => false,
    conclusionCard: () => "chat conclusion", window: {},
  });
  context.renderAgentRun({ id: "chat-result", context: { scope: "chat" }, sections: ["conclusion", "risk", "technical"] });
  assert.equal(wrapper.innerHTML, "chat conclusion");
  assert.match(html, /data-scope="chat" role="radio" aria-checked="true">自由研究/);
  assert.match(html, /id="agent-full-session" type="button" hidden>新建完整工具对话/);
  assert.match(html, /id="agent-restricted-session" type="button" hidden>新建受限研究对话/);
  assert.match(css, /\.scope-segmented\s*\{[^}]*repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.agent-availability\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.agent-guard-actions\s*\{[^}]*flex-wrap:\s*wrap/);
});
