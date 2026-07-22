const api = window.cockpit;
const LAYOUT_STORAGE_KEY = "trading-cockpit:layout:v1";
const DEFAULT_PANE_WIDTHS = Object.freeze({ portfolio: 292, agent: 408 });
const MIN_PANE_WIDTHS = Object.freeze({ portfolio: 220, agent: 320 });
const MAX_PANE_WIDTHS = Object.freeze({ portfolio: 520, agent: 760 });
const MIN_TV_WIDTH = 440;
const RESIZER_WIDTH = 6;
const AGENT_WELCOME_HTML = `<article class="agent-welcome">
  <span class="agent-orbit" aria-hidden="true">A</span>
  <div><strong>Codex 项目线程已接入交易驾驶舱。</strong><p>每条本机对话都可直接打开并继续；不同对话可通过同一条 Codex 链路并行调用 Skills、MCP、Apps 与项目工具。</p></div>
</article>`;

const state = {
  portfolio: null,
  selectedSymbol: null,
  currentRun: null,
  runsById: new Map(),
  activeRequestId: null,
  activeRunNode: null,
  operations: new Map(),
  sessionViews: new Map(),
  filter: "",
  busy: false,
  codexRuntimeAvailable: false,
  codexAvailable: false,
  agentCapabilities: null,
  promptSuggestions: [],
  suggestionIndex: 0,
  suggestionTrigger: null,
  suggestionQueryKey: null,
  historyThreads: [],
  historyLoading: false,
  agentSessions: [],
  activeSessionId: null,
  sessionsLoading: false,
  sessionOpenEpoch: 0,
  analysisScope: "position",
  candidateSymbol: "",
  streamFrame: null,
  scrollFrame: null,
  settledOperationIds: new Set(),
  layout: {
    portfolioCollapsed: false,
    agentCollapsed: false,
    portfolioWidth: DEFAULT_PANE_WIDTHS.portfolio,
    agentWidth: DEFAULT_PANE_WIDTHS.agent,
  },
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  accountCard: $("#account-card"),
  agentContext: $("#agent-context"),
  agentCancel: $("#agent-cancel"),
  agentForm: $("#agent-form"),
  agentInput: $("#agent-input"),
  agentLiveStatus: $("#agent-live-status"),
  agentSubmit: $("#agent-submit"),
  agentThread: $("#agent-thread"),
  agentSessionSelect: $("#agent-session-select"),
  newAgentSession: $("#new-agent-session"),
  historyList: $("#history-list"),
  historyPanel: $("#agent-history"),
  historySearch: $("#history-search"),
  historyToggle: $("#history-toggle"),
  promptSuggestions: $("#prompt-suggestions"),
  agentPane: $("#agent-pane"),
  connect: $("#connect-button"),
  codexBadge: $("#codex-badge"),
  cockpitGrid: $("#cockpit-grid"),
  candidateSymbol: $("#candidate-symbol"),
  candidateSymbolField: $("#candidate-symbol-field"),
  longbridgeChip: $("#longbridge-chip"),
  mapping: $("#symbol-mapping"),
  positionCount: $("#position-count"),
  positionList: $("#position-list"),
  positionSearch: $("#position-search"),
  portfolioFoot: $("#portfolio-foot"),
  portfolioPane: $("#portfolio-pane"),
  portfolioResizer: $("#portfolio-resizer"),
  refresh: $("#refresh-button"),
  riskBudget: $("#risk-budget"),
  snapshotState: $("#snapshot-state"),
  syncTv: $("#sync-tv"),
  systemMessage: $("#system-message"),
  tvChip: $("#tv-chip"),
  tvSurface: $("#tv-surface"),
  agentResizer: $("#agent-resizer"),
  toggleAgent: $("#toggle-agent"),
  togglePortfolio: $("#toggle-portfolio"),
};

initialize();

async function initialize() {
  restorePaneLayout();
  bindEvents();
  queueTvBoundsSync();
  try {
    const initial = await api.getInitialState();
    setCodexStatus(initial.codex);
    setPortfolio(initial.portfolio ?? null);
    syncActiveAgents(initial.activeAgents);
    if (initial.agentSessions) setAgentSessions(initial.agentSessions);
    loadAgentSessions();
    restoreAgentResult(initial.lastAgentResult);
    restoreActiveAgent(initial.activeAgent);
    setLongbridgeStatus(
      initial.longbridge.connected
        ? { state: "connected", message: "长桥已连接 · 查询权限" }
        : initial.longbridge.hasSavedAuthorization
          ? { state: "connecting", message: "正在恢复长桥授权" }
          : { state: "disconnected", message: "长桥未连接" },
    );
    if (!initial.storage.encrypted) {
      setSystemMessage("系统密钥存储不可用：授权不会持久化", "warning");
    } else if (initial.storage.recoveredUnreadableState) {
      setSystemMessage("旧加密状态无法解密，已保留恢复副本并以空状态启动", "warning");
    }
    loadAgentCapabilities();
  } catch (error) {
    setPortfolio(null);
    setLongbridgeStatus({ state: "error", message: "本地驾驶舱初始化失败" });
    setSystemMessage(error.message || "初始化失败", "error");
  }
}

function bindEvents() {
  window.addEventListener("resize", () => {
    normalizePaneWidths();
    applyPaneWidths();
    sendTvBounds();
  });
  new ResizeObserver(sendTvBounds).observe(elements.tvSurface);
  api.onRequestTvBounds(sendTvBounds);
  api.onStatus((status) => {
    if (status.domain === "agent" || String(status.state).startsWith("agent_")) {
      const message = status.detail || status.message || "Agent 状态已更新";
      const operation = status.operationId ? state.operations.get(String(status.operationId)) : null;
      if (operation && status.message) operation.progress = status.message;
      if (operation && status.state === "agent_complete") {
        scheduleAgentResultRecovery(operation, 0);
      } else if (operation && status.state === "agent_error") {
        failAgentOperation(operation, message);
      }
      const belongsToActiveSession = !status.threadId
        || String(status.threadId) === String(state.activeSessionId);
      if (belongsToActiveSession) {
        elements.agentLiveStatus.textContent = message;
        setSystemMessage(message, status.state === "agent_error" ? "error" : "normal");
      }
      const progress = state.activeRunNode?.querySelector("[data-progress-message]");
      const sameOperation = !status.operationId || status.operationId === state.activeRequestId;
      if (progress && status.active && sameOperation && status.message) {
        progress.textContent = status.message;
      }
      return;
    }
    setLongbridgeStatus(status);
    setSystemMessage(status.detail || status.message || "状态已更新");
  });
  api.onPortfolio((portfolio) => setPortfolio(portfolio));
  api.onAgentCapabilities(setAgentCapabilities);
  api.onAgentStream(renderAgentStream);
  api.onAgentResult(handleAgentResult);
  api.onTvState(setTvStatus);

  elements.connect.addEventListener("click", connectLongbridge);
  elements.refresh.addEventListener("click", refreshPortfolio);
  elements.positionSearch.addEventListener("input", (event) => {
    state.filter = event.target.value.trim().toUpperCase();
    renderPositions();
  });
  elements.positionList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-symbol]");
    if (row) selectPosition(row.dataset.symbol);
  });
  elements.syncTv.addEventListener("click", syncSelectedToTv);
  elements.togglePortfolio.addEventListener("click", () => {
    setPaneCollapsed("portfolio", !state.layout.portfolioCollapsed);
  });
  elements.toggleAgent.addEventListener("click", () => {
    setPaneCollapsed("agent", !state.layout.agentCollapsed);
  });
  bindPaneResizer(elements.portfolioResizer, "portfolio");
  bindPaneResizer(elements.agentResizer, "agent");
  $("#tv-reload").addEventListener("click", () => api.tv.reload());
  $("#tv-home").addEventListener("click", () => api.tv.home());

  elements.agentSessionSelect.addEventListener("change", switchAgentSession);
  elements.newAgentSession.addEventListener("click", createAgentSession);
  elements.agentForm.addEventListener("submit", submitAgentTask);
  elements.agentCancel.addEventListener("click", cancelAgentTask);
  elements.agentInput.addEventListener("input", updatePromptSuggestions);
  elements.agentInput.addEventListener("keydown", handlePromptKeydown);
  elements.agentInput.addEventListener("blur", () => setTimeout(closePromptSuggestions, 100));
  elements.candidateSymbol.addEventListener("input", (event) => {
    state.candidateSymbol = sanitizeCandidateSymbol(event.target.value);
    renderAgentContext();
  });
  elements.candidateSymbol.addEventListener("change", () => {
    elements.candidateSymbol.value = state.candidateSymbol;
    invalidateAgentRuns();
  });
  document.querySelectorAll("[data-scope]").forEach((button) => {
    if (!button.closest(".scope-segmented")) return;
    button.addEventListener("click", () => setAnalysisScope(button.dataset.scope));
  });
  elements.historyToggle.addEventListener("click", toggleAgentHistory);
  elements.historySearch.addEventListener("input", () => {
    loadAgentHistory();
  });
  elements.historyList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-history-index]");
    if (!button) return;
    openHistoryThread(Number(button.dataset.historyIndex));
  });
  elements.promptSuggestions.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("[data-suggestion-index]");
    if (!button) return;
    event.preventDefault();
    applyPromptSuggestion(Number(button.dataset.suggestionIndex));
  });
  document.querySelectorAll("[data-task]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.scope) setAnalysisScope(button.dataset.scope);
      elements.agentInput.value = button.dataset.task;
      elements.agentInput.focus();
    });
  });
  elements.agentThread.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-save-plan]");
    if (!button) return;
    const run = state.runsById.get(button.dataset.savePlan);
    if (!run) return;
    if (run.context.snapshotAt !== state.portfolio?.syncedAt
      || run.context.valuationSchemaVersion !== state.portfolio?.valuationSchemaVersion) {
      button.disabled = true;
      button.textContent = "快照已失效 · 请重新运行";
      return;
    }
    button.disabled = true;
    try {
      const result = await api.savePlan(run);
      button.textContent = result.ok ? "已保存为静态计划快照" : "保存失败";
      button.classList.add("saved");
    } catch (error) {
      button.disabled = false;
      button.textContent = error.message || "保存失败";
    }
  });
}

async function loadAgentSessions() {
  if (!api.agentSessions?.list || state.sessionsLoading) return;
  state.sessionsLoading = true;
  const openEpoch = ++state.sessionOpenEpoch;
  renderAgentSessions();
  try {
    const result = await api.agentSessions.list();
    syncActiveAgents(result?.activeAgents);
    setAgentSessions(result);
    const activeId = String(result?.activeSessionId ?? result?.currentThreadId ?? state.activeSessionId ?? "");
    if (activeId && (api.agentSessions?.open || api.agentSessions?.switch)) {
      const opener = api.agentSessions.open ?? api.agentSessions.switch;
      const opened = await opener(activeId);
      if (openEpoch !== state.sessionOpenEpoch) return;
      syncActiveAgents(opened?.activeAgents);
      setAgentSessions(opened);
      renderOpenedSession(opened);
    } else {
      restoreSessionAgentResult(result);
    }
  } catch (error) {
    setSystemMessage(error.message || "Agent 会话列表加载失败", "warning");
  } finally {
    state.sessionsLoading = false;
    renderAgentSessions();
  }
}

function setAgentSessions(value) {
  const sessions = Array.isArray(value)
    ? value
    : Array.isArray(value?.sessions)
      ? value.sessions
      : Array.isArray(value?.threads)
        ? value.threads
        : [];
  state.agentSessions = sessions.map((session) => ({
    ...session,
    id: String(session.id ?? session.threadId ?? ""),
    name: String(session.name ?? session.title ?? "未命名会话"),
  })).filter((session) => session.id).map((session) => {
    const operation = activeOperationForThread(session.id);
    return {
      ...session,
      runState: operation ? "running" : session.runState ?? "idle",
      operationId: operation?.operationId ?? session.operationId ?? null,
    };
  });
  const explicitActiveId = value?.activeSessionId ?? value?.activeThreadId ?? value?.currentThreadId;
  const current = state.agentSessions.find((session) => session.current || session.active);
  state.activeSessionId = String(explicitActiveId ?? current?.id ?? state.activeSessionId ?? state.agentSessions[0]?.id ?? "") || null;
  renderAgentSessions();
}

function renderAgentSessions() {
  const supported = Boolean(api.agentSessions?.list && api.agentSessions?.create && api.agentSessions?.switch);
  elements.agentSessionSelect.replaceChildren();
  if (!supported) {
    elements.agentSessionSelect.append(new Option("会话桥接待就绪", ""));
  } else if (state.sessionsLoading && !state.agentSessions.length) {
    elements.agentSessionSelect.append(new Option("正在读取…", ""));
  } else if (!state.agentSessions.length) {
    elements.agentSessionSelect.append(new Option("尚无会话，请新建", ""));
  } else {
    state.agentSessions.forEach((session) => {
      const operation = activeOperationForThread(session.id);
      const prefix = session.provisioning ? "… " : operation ? "⟳ " : session.runState === "error" ? "! " : "";
      const option = new Option(`${prefix}${session.name}`, session.id, false, session.id === state.activeSessionId);
      elements.agentSessionSelect.append(option);
    });
  }
  elements.agentSessionSelect.disabled = !supported || state.sessionsLoading || !state.agentSessions.length;
  elements.newAgentSession.disabled = !supported || state.sessionsLoading;
  updateAgentSubmitState();
}

async function createAgentSession() {
  if (!api.agentSessions?.create || state.sessionsLoading) return;
  saveActiveSessionView();
  const previousId = state.activeSessionId;
  const provisionalId = `provisioning-${crypto.randomUUID()}`;
  const name = "新对话";
  state.agentSessions.unshift({
    id: provisionalId,
    name,
    preview: "正在创建持久 Codex thread…",
    provisioning: true,
    runState: "idle",
  });
  state.activeSessionId = provisionalId;
  ensureSessionView(provisionalId);
  resetAgentConversation("新对话已打开；正在后台创建持久 Codex thread。你可以先输入问题。 ");
  state.sessionsLoading = true;
  ++state.sessionOpenEpoch;
  renderAgentSessions();
  try {
    const result = await api.agentSessions.create({ name });
    if (result?.sessions || result?.threads || Array.isArray(result)) setAgentSessions(result);
    const createdId = String(result?.session?.id ?? result?.thread?.id ?? result?.activeSessionId ?? result?.activeThreadId ?? "");
    const createdSession = result?.session ?? result?.thread;
    const provisionalIndex = state.agentSessions.findIndex((session) => session.id === provisionalId);
    if (provisionalIndex >= 0 && createdId) {
      state.agentSessions[provisionalIndex] = {
        ...state.agentSessions[provisionalIndex],
        ...createdSession,
        id: createdId,
        name: createdSession?.name ?? createdSession?.title ?? name,
        provisioning: false,
        preview: createdSession?.preview ?? "",
      };
      const provisionalView = state.sessionViews.get(provisionalId);
      state.sessionViews.delete(provisionalId);
      if (provisionalView) state.sessionViews.set(createdId, provisionalView);
    } else if (createdSession && !state.agentSessions.some((session) => session.id === createdId)) {
      state.agentSessions.unshift({ ...createdSession, id: createdId, name: createdSession.name ?? createdSession.title ?? name });
    }
    if (createdId && state.activeSessionId === provisionalId) state.activeSessionId = createdId;
    resetAgentConversation("已创建独立会话。项目规则与工具保持共享，对话上下文不会与其他会话混合。");
    ensureSessionView(createdId).transcript = [];
    restoreSessionAgentResult(result);
  } catch (error) {
    state.agentSessions = state.agentSessions.filter((session) => session.id !== provisionalId);
    state.sessionViews.delete(provisionalId);
    if (state.activeSessionId === provisionalId) state.activeSessionId = previousId;
    setSystemMessage(error.message || "新建 Agent 会话失败", "error");
  } finally {
    state.sessionsLoading = false;
    renderAgentSessions();
  }
}

async function switchAgentSession(event) {
  const nextId = String(event.target.value || "");
  const previousId = state.activeSessionId;
  if (!nextId || nextId === previousId || !(api.agentSessions?.open || api.agentSessions?.switch)) return;
  await openAgentSession(nextId, { previousId });
}

async function openAgentSession(nextId, { previousId = state.activeSessionId } = {}) {
  if (!nextId || state.sessionsLoading || !(api.agentSessions?.open || api.agentSessions?.switch)) return;
  if (String(nextId) === String(state.activeSessionId ?? "")) {
    elements.historyPanel.hidden = true;
    elements.historyToggle.setAttribute("aria-expanded", "false");
    elements.historyToggle.classList.remove("active");
    return;
  }
  saveActiveSessionView();
  const openEpoch = ++state.sessionOpenEpoch;
  state.sessionsLoading = true;
  elements.agentSessionSelect.disabled = true;
  try {
    const opener = api.agentSessions.open ?? api.agentSessions.switch;
    const result = await opener(nextId);
    if (openEpoch !== state.sessionOpenEpoch) return;
    syncActiveAgents(result?.activeAgents);
    state.activeSessionId = String(result?.activeSessionId ?? result?.activeThreadId ?? result?.session?.id ?? result?.thread?.id ?? nextId);
    if (result?.sessions || result?.threads || Array.isArray(result)) setAgentSessions(result);
    renderOpenedSession(result);
    elements.historyPanel.hidden = true;
    elements.historyToggle.setAttribute("aria-expanded", "false");
    elements.historyToggle.classList.remove("active");
  } catch (error) {
    if (openEpoch !== state.sessionOpenEpoch) return;
    state.activeSessionId = previousId;
    elements.agentSessionSelect.value = previousId || "";
    setSystemMessage(error.message || "切换 Agent 会话失败", "error");
  } finally {
    if (openEpoch === state.sessionOpenEpoch) {
      state.sessionsLoading = false;
      renderAgentSessions();
    }
  }
}

function resetAgentConversation(message) {
  state.currentRun = null;
  state.activeRequestId = null;
  state.activeRunNode = null;
  elements.agentThread.innerHTML = AGENT_WELCOME_HTML;
  if (message) {
    elements.agentThread.insertAdjacentHTML(
      "beforeend",
      `<div class="run-state"><span class="evidence-dot complete"></span><span>${esc(message)}</span></div>`,
    );
  }
  scrollAgentToEnd();
}

function ensureSessionView(threadId) {
  const id = String(threadId ?? "");
  if (!state.sessionViews.has(id)) {
    state.sessionViews.set(id, {
      transcript: [],
      draft: "",
      scope: "position",
      candidateSymbol: "",
      riskBudget: "0.8",
      lastAgentResult: null,
    });
  }
  return state.sessionViews.get(id);
}

function saveActiveSessionView() {
  if (!state.activeSessionId) return;
  const view = ensureSessionView(state.activeSessionId);
  view.draft = elements.agentInput.value;
  view.scope = state.analysisScope;
  view.candidateSymbol = state.candidateSymbol;
  view.riskBudget = elements.riskBudget.value;
}

function renderOpenedSession(payload) {
  const threadId = String(payload?.activeSessionId ?? payload?.currentThreadId ?? state.activeSessionId ?? "");
  const view = ensureSessionView(threadId);
  if (Array.isArray(payload?.transcript)) view.transcript = payload.transcript;
  if (payload?.lastAgentResult?.run) view.lastAgentResult = payload.lastAgentResult;
  resetAgentConversation();
  restoreSessionComposer(view);

  const latestBody = String(view.lastAgentResult?.run?.conclusion?.body ?? "").trim();
  const transcript = [...view.transcript];
  if (latestBody && transcript.at(-1)?.role === "assistant"
    && sameConversationText(transcript.at(-1).text, latestBody)) transcript.pop();
  for (const entry of transcript) appendTranscriptEntry(entry);

  restoreSessionAgentResult({
    ...payload,
    activeSessionId: threadId,
    lastAgentResult: view.lastAgentResult,
  });
  const operation = activeOperationForThread(threadId);
  if (operation) restoreActiveAgent(operation);
  else finishActiveAgentUi(null, transcript.length || view.lastAgentResult ? "已打开原对话，可继续分析" : "新对话");

  scrollAgentToEnd();
}

function appendTranscriptEntry(entry) {
  const role = entry?.role === "assistant" ? "assistant" : "user";
  const text = String(entry?.text ?? "").trim();
  if (!text) return;
  if (role === "user") {
    const node = document.createElement("div");
    node.className = "user-message";
    node.textContent = text;
    elements.agentThread.append(node);
    return;
  }
  const article = document.createElement("article");
  article.className = "agent-card transcript-message";
  const body = document.createElement("div");
  body.className = "agent-card-body model-response";
  article.append(body);
  elements.agentThread.append(article);
  if (window.CockpitMarkdown?.renderMarkdown) window.CockpitMarkdown.renderMarkdown(body, text);
  else body.textContent = text;
}

function sameConversationText(left, right) {
  const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const a = normalize(left);
  const b = normalize(right);
  return a === b || (a.length > 200 && b.length > 200 && a.slice(0, 200) === b.slice(0, 200));
}

function summarizeConversationTitle(value) {
  let text = String(value ?? "")
    .replace(/(?:^|\s)[$@][\w:.-]+/g, " ")
    .replace(/(?:^|\s)\/[\w-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:请|麻烦)?(?:帮我|给我)?(?:分析|评估|检查|看一下|看看)\s*/u, "")
    .replace(/[。！？!?；;\n].*$/u, "")
    .trim();
  if (!text) text = "新对话";
  const characters = Array.from(text);
  const compact = characters.slice(0, 32).join("");
  return characters.length > 32 ? `${compact}…` : compact;
}

function restoreSessionComposer(view) {
  const scope = ["position", "candidate", "portfolio"].includes(view.scope) ? view.scope : "position";
  state.analysisScope = scope;
  state.candidateSymbol = view.candidateSymbol ?? "";
  document.querySelectorAll(".scope-segmented [data-scope]").forEach((button) => {
    button.setAttribute("aria-checked", String(button.dataset.scope === scope));
  });
  elements.candidateSymbolField.hidden = scope !== "candidate";
  elements.candidateSymbol.value = state.candidateSymbol;
  elements.riskBudget.value = view.riskBudget || "0.8";
  elements.agentInput.value = view.draft || "";
  renderAgentContext();
}

function syncActiveAgents(activeAgents) {
  for (const active of Array.isArray(activeAgents) ? activeAgents : []) {
    const operationId = String(active?.operationId ?? "");
    const threadId = String(active?.threadId ?? "");
    // list/open can return an older active snapshot after the result event has
    // already settled. Never resurrect that tombstoned operation as a ghost
    // spinner (the common "restart to see the answer" failure mode).
    if (!operationId || !threadId
      || state.operations.has(operationId)
      || state.settledOperationIds.has(operationId)) continue;
    const operation = {
      operationId,
      threadId,
      status: "running",
      progress: "后台 Codex 分析仍在运行",
      task: String(active?.task ?? ""),
      streamText: "",
      finalText: "",
      streamBuffers: new Map(),
      streamOrder: [],
      toolEvents: new Map(),
    };
    state.operations.set(operationId, operation);
    scheduleAgentResultRecovery(operation, 1_000);
  }
}

function activeOperationForThread(threadId) {
  return [...state.operations.values()].find((operation) => operation.threadId === String(threadId)
    && ["running", "cancelling"].includes(operation.status)) ?? null;
}

function restoreSessionAgentResult(payload) {
  const envelope = payload?.lastAgentResult;
  if (!envelope?.run) return false;
  const activeThreadId = String(payload?.activeSessionId ?? payload?.currentThreadId ?? state.activeSessionId ?? "");
  if (!activeThreadId || String(envelope.threadId ?? "") !== activeThreadId) return false;
  return acceptAgentResult(envelope, { restored: true });
}

function setAnalysisScope(scope) {
  if (!["position", "candidate", "portfolio"].includes(scope) || scope === state.analysisScope) return;
  state.analysisScope = scope;
  document.querySelectorAll(".scope-segmented [data-scope]").forEach((button) => {
    button.setAttribute("aria-checked", String(button.dataset.scope === scope));
  });
  elements.candidateSymbolField.hidden = scope !== "candidate";
  invalidateAgentRuns();
  renderAgentContext();
  if (scope === "candidate") requestAnimationFrame(() => elements.candidateSymbol.focus());
}

function toggleAgentHistory() {
  const open = elements.historyPanel.hidden;
  elements.historyPanel.hidden = !open;
  elements.historyToggle.setAttribute("aria-expanded", String(open));
  elements.historyToggle.classList.toggle("active", open);
  if (open) {
    loadAgentHistory();
    requestAnimationFrame(() => elements.historySearch.focus());
  }
}

function loadAgentHistory() {
  if (elements.historyPanel.hidden) return;
  const query = elements.historySearch.value.trim().toLowerCase();
  state.historyLoading = false;
  state.historyThreads = state.agentSessions.filter((thread) => !query
    || `${thread.name} ${thread.preview ?? ""}`.toLowerCase().includes(query));
  renderAgentHistory();
}

function renderAgentHistory() {
  elements.historyList.replaceChildren();
  if (state.historyLoading) {
    elements.historyList.append(historyEmptyState("正在读取 Codex 最近历史…", true));
    return;
  }
  if (!state.historyThreads.length) {
    const message = elements.historySearch.value.trim()
      ? "最近 30 天没有匹配的对话"
      : "最近 30 天还没有可显示的对话";
    elements.historyList.append(historyEmptyState(message));
    return;
  }
  state.historyThreads.forEach((thread, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item";
    button.dataset.historyIndex = String(index);
    const header = document.createElement("span");
    header.className = "history-item-head";
    const title = document.createElement("strong");
    title.textContent = thread.name || "交易驾驶舱 Agent";
    const time = document.createElement("time");
    time.dateTime = thread.recencyAt || thread.updatedAt || "";
    time.textContent = thread.current
      ? "当前线程"
      : shortDateTime(thread.recencyAt || thread.updatedAt || thread.createdAt);
    header.append(title, time);
    const preview = document.createElement("span");
    preview.className = "history-preview";
    const operation = activeOperationForThread(thread.id);
    preview.textContent = operation
      ? operation.progress || "该对话正在后台分析"
      : thread.preview || "点击直接打开并继续这段对话";
    if (operation) button.classList.add("running");
    button.append(header, preview);
    elements.historyList.append(button);
  });
}

function historyEmptyState(message, loading = false) {
  const node = document.createElement("div");
  node.className = `history-empty${loading ? " loading" : ""}`;
  node.textContent = message;
  return node;
}

async function openHistoryThread(index) {
  const thread = state.historyThreads[index];
  if (!thread) return;
  await openAgentSession(thread.id);
}

function sendTvBounds() {
  const rect = elements.tvSurface.getBoundingClientRect();
  api.tv.setBounds({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
}

function restorePaneLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || "null");
    state.layout.portfolioCollapsed = saved?.portfolioCollapsed === true;
    state.layout.agentCollapsed = saved?.agentCollapsed === true;
    state.layout.portfolioWidth = validPaneWidth(saved?.portfolioWidth, "portfolio");
    state.layout.agentWidth = validPaneWidth(saved?.agentWidth, "agent");
  } catch {
    state.layout.portfolioCollapsed = false;
    state.layout.agentCollapsed = false;
    state.layout.portfolioWidth = DEFAULT_PANE_WIDTHS.portfolio;
    state.layout.agentWidth = DEFAULT_PANE_WIDTHS.agent;
  }
  applyPaneLayout();
}

function setPaneCollapsed(pane, collapsed) {
  if (pane === "portfolio") state.layout.portfolioCollapsed = collapsed;
  if (pane === "agent") state.layout.agentCollapsed = collapsed;
  applyPaneLayout();
  persistPaneLayout();
  queueTvBoundsSync();
}

function applyPaneLayout() {
  const portfolioCollapsed = state.layout.portfolioCollapsed;
  const agentCollapsed = state.layout.agentCollapsed;
  elements.cockpitGrid.classList.toggle("portfolio-collapsed", portfolioCollapsed);
  elements.cockpitGrid.classList.toggle("agent-collapsed", agentCollapsed);
  normalizePaneWidths();
  applyPaneWidths();
  updatePaneControl(elements.portfolioPane, elements.togglePortfolio, portfolioCollapsed, {
    hiddenLabel: "显示持仓栏",
    visibleLabel: "隐藏持仓栏",
    hiddenContent: "持仓 ▶",
    visibleContent: "◀ 持仓",
  });
  updatePaneControl(elements.agentPane, elements.toggleAgent, agentCollapsed, {
    hiddenLabel: "显示 Agent 栏",
    visibleLabel: "隐藏 Agent 栏",
    hiddenContent: "◀ Agent",
    visibleContent: "Agent ▶",
  });
}

function bindPaneResizer(resizer, pane) {
  if (!resizer) return;
  let drag = null;
  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || state.layout[`${pane}Collapsed`]) return;
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: state.layout[`${pane}Width`],
    };
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add("dragging");
    document.body.classList.add("resizing-panes");
    event.preventDefault();
  });
  resizer.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const movement = event.clientX - drag.startX;
    resizePane(pane, drag.startWidth + (pane === "portfolio" ? movement : -movement));
  });
  const finish = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    resizer.classList.remove("dragging");
    document.body.classList.remove("resizing-panes");
    persistPaneLayout();
    queueTvBoundsSync();
  };
  resizer.addEventListener("pointerup", finish);
  resizer.addEventListener("pointercancel", finish);
  resizer.addEventListener("dblclick", () => {
    resizePane(pane, DEFAULT_PANE_WIDTHS[pane]);
    persistPaneLayout();
  });
  resizer.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault();
    const current = state.layout[`${pane}Width`];
    if (event.key === "Home") {
      resizePane(pane, DEFAULT_PANE_WIDTHS[pane]);
    } else {
      const direction = event.key === "ArrowRight" ? 1 : -1;
      resizePane(pane, current + (pane === "portfolio" ? direction : -direction) * 16);
    }
    persistPaneLayout();
  });
}

function resizePane(pane, requestedWidth) {
  const otherPane = pane === "portfolio" ? "agent" : "portfolio";
  const otherWidth = state.layout[`${otherPane}Collapsed`] ? 0 : state.layout[`${otherPane}Width`];
  const visibleResizers = Number(!state.layout.portfolioCollapsed) + Number(!state.layout.agentCollapsed);
  const gridWidth = elements.cockpitGrid.clientWidth || window.innerWidth;
  const available = gridWidth - otherWidth - visibleResizers * RESIZER_WIDTH - MIN_TV_WIDTH;
  const upper = Math.max(MIN_PANE_WIDTHS[pane], Math.min(MAX_PANE_WIDTHS[pane], available));
  state.layout[`${pane}Width`] = clamp(Number(requestedWidth), MIN_PANE_WIDTHS[pane], upper);
  applyPaneWidths();
  sendTvBounds();
}

function normalizePaneWidths() {
  state.layout.portfolioWidth = validPaneWidth(state.layout.portfolioWidth, "portfolio");
  state.layout.agentWidth = validPaneWidth(state.layout.agentWidth, "agent");
  const visible = ["portfolio", "agent"].filter((pane) => !state.layout[`${pane}Collapsed`]);
  if (!visible.length) return;
  const gridWidth = elements.cockpitGrid.clientWidth || window.innerWidth;
  const sideBudget = Math.max(0, gridWidth - visible.length * RESIZER_WIDTH - MIN_TV_WIDTH);
  let total = visible.reduce((sum, pane) => sum + state.layout[`${pane}Width`], 0);
  if (total <= sideBudget) return;
  let excess = total - sideBudget;
  for (const pane of ["agent", "portfolio"].filter((name) => visible.includes(name))) {
    const reducible = Math.max(0, state.layout[`${pane}Width`] - MIN_PANE_WIDTHS[pane]);
    const reduction = Math.min(reducible, excess);
    state.layout[`${pane}Width`] -= reduction;
    excess -= reduction;
    if (excess <= 0) break;
  }
}

function applyPaneWidths() {
  elements.cockpitGrid.style.setProperty("--portfolio-pane-preferred-width", `${Math.round(state.layout.portfolioWidth)}px`);
  elements.cockpitGrid.style.setProperty("--agent-pane-preferred-width", `${Math.round(state.layout.agentWidth)}px`);
  elements.portfolioResizer?.setAttribute("aria-valuemin", String(MIN_PANE_WIDTHS.portfolio));
  elements.portfolioResizer?.setAttribute("aria-valuemax", String(MAX_PANE_WIDTHS.portfolio));
  elements.portfolioResizer?.setAttribute("aria-valuenow", String(Math.round(state.layout.portfolioWidth)));
  elements.agentResizer?.setAttribute("aria-valuemin", String(MIN_PANE_WIDTHS.agent));
  elements.agentResizer?.setAttribute("aria-valuemax", String(MAX_PANE_WIDTHS.agent));
  elements.agentResizer?.setAttribute("aria-valuenow", String(Math.round(state.layout.agentWidth)));
}

function validPaneWidth(value, pane) {
  const numeric = Number(value);
  return clamp(Number.isFinite(numeric) ? numeric : DEFAULT_PANE_WIDTHS[pane], MIN_PANE_WIDTHS[pane], MAX_PANE_WIDTHS[pane]);
}

function persistPaneLayout() {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(state.layout));
  } catch {
    // Persistence is optional; the controls still work for the current session.
  }
}

function updatePaneControl(pane, control, collapsed, labels) {
  pane.inert = collapsed;
  pane.setAttribute("aria-hidden", String(collapsed));
  control.setAttribute("aria-expanded", String(!collapsed));
  control.setAttribute("aria-label", collapsed ? labels.hiddenLabel : labels.visibleLabel);
  control.title = collapsed ? labels.hiddenLabel : labels.visibleLabel;
  control.textContent = collapsed ? labels.hiddenContent : labels.visibleContent;
}

function queueTvBoundsSync() {
  sendTvBounds();
  requestAnimationFrame(() => {
    sendTvBounds();
    requestAnimationFrame(sendTvBounds);
  });
}

async function connectLongbridge() {
  if (state.busy) return;
  setBusy(true);
  setSystemMessage("将在系统浏览器中打开长桥 OAuth；仅请求账户读取权限");
  try {
    const result = await api.connectLongbridge();
    if (!result.ok) setSystemMessage(result.error || "长桥连接失败", "error");
  } catch (error) {
    setSystemMessage(error.message || "长桥连接失败", "error");
  } finally {
    setBusy(false);
  }
}

async function refreshPortfolio() {
  if (state.busy) return;
  setBusy(true);
  try {
    const result = await api.refreshPortfolio();
    if (!result.ok) setSystemMessage(result.error || "持仓同步失败", "error");
  } catch (error) {
    setSystemMessage(error.message || "持仓同步失败", "error");
  } finally {
    setBusy(false);
  }
}

function setBusy(value) {
  state.busy = value;
  elements.connect.disabled = value;
  elements.refresh.disabled = value;
  updateAgentSubmitState();
  renderAgentSessions();
}

function setPortfolio(portfolio) {
  const previousSnapshot = state.portfolio?.syncedAt ?? null;
  const nextSnapshot = portfolio?.syncedAt ?? null;
  if (previousSnapshot && previousSnapshot !== nextSnapshot) {
    invalidateAgentRuns("长桥快照已更新，旧结论仅保留用于回看。", {
      preserveActiveRequest: Boolean(state.activeRequestId),
    });
  }
  state.portfolio = portfolio;
  if (!portfolio) {
    state.selectedSymbol = null;
  } else if (!portfolio.positions.some((position) => position.symbol === state.selectedSymbol)) {
    state.selectedSymbol = portfolio.positions[0]?.symbol ?? null;
  }
  renderPortfolio();
  renderAgentContext();
  updateAgentSubmitState();
}

function renderPortfolio() {
  const portfolio = state.portfolio;
  if (!portfolio) {
    clearPortfolioUI();
    return;
  }

  const account = portfolio.account;
  const snapshotLabel = portfolio.status === "cached"
    ? "CACHED"
    : "HOLDINGS LIVE";
  elements.snapshotState.textContent = snapshotLabel;
  elements.snapshotState.className = `snapshot-state ${portfolio.status === "cached" ? "cached" : "live"}`;
  const fxStatus = portfolio.dataQuality?.fxStatus ?? "unavailable";
  const fxAvailable = ["live", "reference", "reference_cached"].includes(fxStatus);
  const fxReference = ["reference", "reference_cached"].includes(fxStatus);
  const fxLabel = fxReference
    ? `${portfolio.fx?.providerCode ?? "ECB"} ${portfolio.fx?.asOf ?? "最新"} 参考汇率${fxStatus === "reference_cached" ? "（缓存）" : ""}`
    : fxStatus === "live"
      ? "长桥账户汇率"
      : "汇率不可用";
  const accountSummary = portfolio.status === "cached"
    ? "本地加密缓存"
    : !fxAvailable
      ? "持仓实时 · 汇率降级，跨币种估值暂停"
      : fxReference
        ? `真实持仓 · USD 估值 · ${fxLabel}`
      : portfolio.status === "degraded"
        ? `持仓实时 · ${number(portfolio.totals.unpricedPositionCount, 0)} 项待估值`
        : `真实账户与完整估值 · ${fxLabel}`;
  elements.accountCard.innerHTML = `
    <div class="account-top">
      <div><span>净资产 / ${esc(account.baseCurrency)}</span><strong>${money(account.netAssets, account.baseCurrency)}</strong></div>
      <small>${esc(accountSummary)}</small>
    </div>
    <div class="metric-grid">
      <div><span>现金</span><strong>${money(account.totalCash, account.baseCurrency)}</strong></div>
      <div><span>购买力</span><strong>${money(account.buyPower, account.baseCurrency)}</strong></div>
      <div><span>风险等级</span><strong>${esc(account.riskLevel)}</strong></div>
    </div>`;

  elements.positionCount.textContent = String(portfolio.positions.length);
  const groups = Object.entries(portfolio.groupExposure).sort((a, b) => b[1] - a[1]);
  elements.portfolioFoot.innerHTML = `
    <div><span>TOP 1</span><strong>${percent(portfolio.totals.top1Weight)}</strong></div>
    <div><span>TOP 5</span><strong>${percent(portfolio.totals.top5Weight)}</strong></div>
    <div><span>最大主题</span><strong>${groups[0] ? `${esc(groups[0][0])} ${percent(groups[0][1])}` : "—"}</strong></div>
    <div><span>现金</span><strong>${percent(portfolio.totals.cashRatio)}</strong></div>`;
  renderPositions();
  updateSelectedMapping();
}

function clearPortfolioUI() {
  elements.snapshotState.textContent = "NO DATA";
  elements.snapshotState.className = "snapshot-state";
  elements.accountCard.innerHTML = `<div class="account-empty">
    <span class="empty-orbit" aria-hidden="true"></span>
    <strong>等待长桥授权</strong>
    <p>连接后直接显示账户净资产、现金、购买力与真实持仓；应用不具备下单能力。</p>
  </div>`;
  elements.positionList.replaceChildren();
  elements.positionCount.textContent = "0";
  elements.portfolioFoot.innerHTML = `<div><span>TOP 1</span><strong>—</strong></div>
    <div><span>TOP 5</span><strong>—</strong></div>
    <div><span>最大主题</span><strong>—</strong></div>
    <div><span>现金</span><strong>—</strong></div>`;
  updateSelectedMapping();
  state.currentRun = null;
  state.activeRequestId = null;
  state.runsById.clear();
  elements.agentThread.innerHTML = AGENT_WELCOME_HTML;
}

function invalidateAgentRuns(message, { preserveActiveRequest = false } = {}) {
  state.currentRun = null;
  if (!preserveActiveRequest && !activeOperationForThread(state.activeSessionId)) {
    state.activeRequestId = null;
  }
  elements.agentThread.querySelectorAll("[data-save-plan]").forEach((button) => {
    button.disabled = true;
    button.textContent = "快照已失效 · 请重新运行";
  });
  if (state.runsById.size && message) {
    elements.agentThread.insertAdjacentHTML(
      "beforeend",
      `<div class="run-state"><span class="evidence-dot degraded"></span><span>${esc(message)}</span></div>`,
    );
  }
}

function renderPositions() {
  const positions = state.portfolio?.positions ?? [];
  const filtered = positions.filter((position) =>
    !state.filter || `${position.symbol} ${position.name}`.toUpperCase().includes(state.filter),
  );
  elements.positionList.innerHTML = filtered.map((position) => {
    const selected = position.symbol === state.selectedSymbol;
    const changeClass = tone(position.changePercent);
    const pnlClass = tone(position.pnlPercent);
    const session = sessionLabel(position.quoteSession);
    return `<button class="position-row ${selected ? "selected" : ""}" type="button" data-symbol="${esc(position.symbol)}" aria-pressed="${selected}">
      <span class="position-id"><i class="ticker">${esc(position.ticker.slice(0, 4))}</i><span><strong>${esc(position.ticker)}</strong><small>${esc(position.name)}</small></span></span>
      <span class="position-price"><strong>${price(position.lastPrice, position.currency)}</strong><small class="${changeClass}">${signedPercent(position.changePercent)}${session ? ` · ${esc(session)}` : ""}</small></span>
      <span class="position-meta"><span>Q ${number(position.quantity)}</span><span>成本 ${number(position.costPrice)}</span><span>权重 ${percent(position.weight)}</span><span class="${pnlClass}">${signedPercent(position.pnlPercent)}</span></span>
    </button>`;
  }).join("");
}

function selectPosition(symbol) {
  if (state.selectedSymbol === symbol) return;
  state.selectedSymbol = symbol;
  if (state.analysisScope === "position") {
    state.currentRun = null;
    invalidateAgentRuns();
  }
  renderPositions();
  renderAgentContext();
  updateSelectedMapping();
  appendContextDirty();
}

function updateSelectedMapping() {
  const position = selectedPosition();
  if (!position) {
    elements.mapping.textContent = "选择持仓后可同步标的";
    elements.syncTv.disabled = true;
    return;
  }
  if (position.instrumentType === "option") {
    elements.mapping.textContent = `${position.symbol} · 期权标的映射尚未启用`;
    elements.syncTv.disabled = true;
    return;
  }
  elements.mapping.textContent = `${position.symbol} → ${position.tvSymbol}`;
  elements.syncTv.disabled = false;
}

async function syncSelectedToTv() {
  const position = selectedPosition();
  if (!position) return;
  elements.syncTv.disabled = true;
  try {
    await api.tv.loadSymbol(position.tvSymbol);
    setSystemMessage(`${position.symbol} 已显式同步到 TradingView`);
  } catch (error) {
    setSystemMessage(error.message || "同步 TradingView 失败", "error");
  } finally {
    elements.syncTv.disabled = false;
  }
}

function renderAgentContext() {
  const position = selectedPosition();
  const scope = state.analysisScope;
  const asOf = state.portfolio?.syncedAt;
  const fxStatus = state.portfolio?.dataQuality?.fxStatus;
  const quality = !state.portfolio
    ? "—"
    : fxStatus === "live"
      ? "长桥汇率"
      : fxStatus === "reference" || fxStatus === "reference_cached"
        ? `${state.portfolio.fx?.providerCode ?? "ECB"} ${state.portfolio.fx?.asOf ?? "参考"}${fxStatus === "reference_cached" ? " 缓存" : ""}`
        : "汇率不可用";
  const contextLabel = scope === "portfolio"
    ? `全部组合 · ${number(state.portfolio?.positions?.length ?? 0, 0)} 项`
    : scope === "candidate"
      ? state.candidateSymbol || "等待候选代码"
      : position
        ? `${position.symbol} · ${percent(position.weight)}`
        : "未选择持仓";
  elements.agentContext.innerHTML = `
    <div><span>${scope === "portfolio" ? "组合范围" : scope === "candidate" ? "候选标的" : "持仓上下文"}</span><strong>${esc(contextLabel)}</strong></div>
    <div><span>周期</span><strong>1D</strong></div>
    <div><span>数据</span><strong>${asOf ? `${shortTime(asOf)} · ${esc(quality)}` : "—"}</strong></div>`;
}

function appendContextDirty() {
  const position = selectedPosition();
  if (!position || state.analysisScope !== "position") return;
  invalidateAgentRuns();
  elements.agentThread.insertAdjacentHTML(
    "beforeend",
    `<div class="run-state"><span class="evidence-dot degraded"></span><span>上下文已切换至 ${esc(position.symbol)}。旧结论不会沿用，请重新运行 Agent。</span></div>`,
  );
  scrollAgentToEnd();
}

async function submitAgentTask(event) {
  event.preventDefault();
  closePromptSuggestions();
  if (!state.portfolio) {
    setSystemMessage("请先连接长桥并同步真实组合", "warning");
    return;
  }
  const scope = state.analysisScope;
  const position = selectedPosition();
  const candidateSymbol = normalizeCandidateSymbol(elements.candidateSymbol.value || state.candidateSymbol);
  if (scope === "position" && !position) {
    setSystemMessage("请选择要分析的真实持仓", "warning");
    return;
  }
  if (scope === "candidate" && !candidateSymbol) {
    setSystemMessage("请输入未持有候选标的代码，例如 NVDA.US", "warning");
    elements.candidateSymbol.focus();
    return;
  }
  state.candidateSymbol = candidateSymbol;
  elements.candidateSymbol.value = candidateSymbol;
  const defaultTasks = {
    position: "分析当前持仓的技术结构、组合风险和条件计划",
    candidate: "为未持有候选标的生成买入计划，包括触发、失效条件和风险预算",
    portfolio: "检查全部持仓的集中度、重复暴露、下行情景和组合健康度",
  };
  const task = elements.agentInput.value.trim() || defaultTasks[scope];
  const riskBudgetPercent = Number(elements.riskBudget.value || 0.8);
  const threadId = String(state.activeSessionId ?? "");
  if (!threadId) {
    setSystemMessage("请先新建或打开一个 Codex 对话", "warning");
    return;
  }
  if (activeOperationForThread(threadId)) {
    setSystemMessage("当前对话已有分析在运行；可以新建或切换到其他对话并行分析。", "warning");
    return;
  }

  const targetSymbol = scope === "position" ? position?.symbol : scope === "candidate" ? candidateSymbol : null;
  const requestId = crypto.randomUUID();
  const operation = {
    operationId: requestId,
    threadId,
    status: "running",
    progress: "正在获取长桥日线并计算 EMA、Fib 与组合风险…",
    task,
    streamText: "",
    finalText: "",
    streamBuffers: new Map(),
    streamOrder: [],
    toolEvents: new Map(),
  };
  state.operations.set(requestId, operation);
  state.activeRequestId = requestId;
  elements.agentInput.value = "";
  const sessionView = ensureSessionView(threadId);
  sessionView.draft = "";
  sessionView.transcript.push({ role: "user", text: task });
  const session = state.agentSessions.find((item) => item.id === threadId);
  if (session && ["新对话", "交易驾驶舱 Agent"].includes(session.name)) {
    session.name = summarizeConversationTitle(task);
  }
  elements.agentThread.insertAdjacentHTML("beforeend", `<div class="user-message">${esc(task)}</div>`);
  state.activeRunNode = createOperationNode(operation);
  elements.agentThread.append(state.activeRunNode);
  const targetLabel = scope === "portfolio" ? "全部组合" : targetSymbol;
  elements.agentLiveStatus.textContent = `正在分析 ${targetLabel}`;
  elements.agentCancel.hidden = false;
  updateAgentSubmitState();
  renderAgentSessions();
  scrollAgentToEnd();

  api.runAgent({
    operationId: requestId,
    threadId,
    scope,
    symbol: targetSymbol,
    task,
    riskBudgetPercent,
  }).then((run) => {
    acceptAgentResult({ threadId, operationId: requestId, run });
  }).catch((error) => {
    failAgentOperation(operation, error.message || "Agent 运行失败");
  });
}

function handleAgentResult(envelope) {
  if (envelope?.run) {
    acceptAgentResult(envelope);
    return;
  }
  const operationId = String(envelope?.operationId ?? "");
  const operation = state.operations.get(operationId);
  if (!envelope?.error || !operationId) return;
  rememberSettledOperation(operationId);
  if (operation) failAgentOperation(operation, envelope.error);
}

function scheduleAgentResultRecovery(operation, delayMs = 900) {
  if (!operation || !api.recoverAgentResult || !state.operations.has(operation.operationId)) return;
  if (operation.recoveryTimer) clearTimeout(operation.recoveryTimer);
  operation.recoveryTimer = setTimeout(() => {
    operation.recoveryTimer = null;
    recoverAgentResult(operation);
  }, delayMs);
}

async function recoverAgentResult(operation) {
  if (!state.operations.has(operation.operationId) || operation.recoveryInFlight) return;
  operation.recoveryInFlight = true;
  operation.recoveryAttempts = Number(operation.recoveryAttempts ?? 0) + 1;
  try {
    const recovered = await api.recoverAgentResult({
      threadId: operation.threadId,
      operationId: operation.operationId,
      task: operation.task ?? "",
    });
    if (!state.operations.has(operation.operationId)) return;
    operation.recoveryAttempts = 0;
    if (recovered?.result?.run) {
      acceptAgentResult(recovered.result, { restored: true });
      return;
    }
    if (recovered?.historicalTurn?.status === "completed"
      && recovered.historicalTurn.text
      && recovered.active === false) {
      settleAgentFromRecoveredTurn(operation, recovered.historicalTurn.text);
      return;
    }
    if (recovered?.active !== false) {
      scheduleAgentResultRecovery(operation, 5_000);
      return;
    }
    if (recovered?.historicalTurn?.terminal) {
      failAgentOperation(operation, "Codex 上一轮已中断且没有最终答案；可在本对话中重新运行。 ");
      return;
    }
  } catch {
    // Recovery is an auxiliary read path. A timeout here must never tombstone
    // the live run or suppress a later authoritative result envelope.
    if (state.operations.has(operation.operationId)) {
      scheduleAgentResultRecovery(operation, Math.min(15_000, 5_000 + operation.recoveryAttempts * 1_000));
    }
    return;
  } finally {
    operation.recoveryInFlight = false;
  }
  if (operation.finalText?.trim()) {
    settleAgentFromRecoveredTurn(operation, operation.finalText);
  } else if (state.operations.has(operation.operationId)) {
    scheduleAgentResultRecovery(operation, 10_000);
  }
}

function settleAgentFromRecoveredTurn(operation, value) {
  const text = String(value ?? "").trim();
  const node = elements.agentThread.querySelector(
    `[data-operation-id="${CSS.escape(operation.operationId)}"]`,
  );
  const article = document.createElement("article");
  article.className = "agent-card transcript-message";
  article.dataset.operationId = operation.operationId;
  const body = document.createElement("div");
  body.className = "agent-card-body model-response";
  article.append(body);
  if (window.CockpitMarkdown?.renderMarkdown) window.CockpitMarkdown.renderMarkdown(body, text);
  else body.textContent = text;
  if (node) node.replaceWith(article);
  else if (operation.threadId === state.activeSessionId) elements.agentThread.append(article);
  const view = ensureSessionView(operation.threadId);
  if (view.transcript.at(-1)?.role !== "assistant") {
    view.transcript.push({ role: "assistant", text });
  }
  rememberSettledOperation(operation.operationId);
  finishAgentOperation(operation, "最终答案已恢复");
}

function acceptAgentResult(envelope, { restored = false } = {}) {
  const run = envelope?.run;
  if (!run?.id || !run?.context) return false;
  const operationId = String(envelope.operationId ?? run.operationId ?? "");
  const envelopeThreadId = String(
    envelope?.threadId ?? run?.modelAnalysis?.threadId ?? "",
  ).trim();
  const activeThreadId = String(state.activeSessionId ?? "").trim();
  const resultThreadId = envelopeThreadId || activeThreadId;
  if (!resultThreadId) return false;
  const operation = operationId ? state.operations.get(operationId) : null;
  const view = ensureSessionView(resultThreadId);
  view.lastAgentResult = { ...envelope, threadId: resultThreadId };
  const session = state.agentSessions.find((item) => item.id === resultThreadId);
  if (session) {
    session.preview = String(run.conclusion?.body ?? run.conclusion?.headline ?? "")
      .replace(/\s+/g, " ").trim().slice(0, 500);
    session.updatedAt = envelope.completedAt ?? run.createdAt ?? new Date().toISOString();
    session.runState = "idle";
    session.operationId = null;
  }
  if (!restored && run.conclusion?.body) {
    const latest = view.transcript.at(-1);
    if (latest?.role !== "assistant" || !sameConversationText(latest.text, run.conclusion.body)) {
      view.transcript.push({ role: "assistant", text: run.conclusion.body });
    }
  }
  const runScope = run.context.scope ?? (run.context.symbol ? "position" : "portfolio");
  const activeTarget = state.analysisScope === "position"
    ? state.selectedSymbol
    : state.analysisScope === "candidate"
      ? normalizeCandidateSymbol(state.candidateSymbol)
      : null;
  const runTarget = run.context.symbol ? normalizeCandidateSymbol(run.context.symbol) : null;
  const stale = resultThreadId === activeThreadId && (state.analysisScope !== runScope
    || (runScope !== "portfolio" && activeTarget !== runTarget)
    || state.portfolio?.syncedAt !== run.context.snapshotAt
    || state.portfolio?.valuationSchemaVersion !== run.context.valuationSchemaVersion);
  state.runsById.set(run.id, run);
  if (state.runsById.size > 50) state.runsById.delete(state.runsById.keys().next().value);
  if (resultThreadId === activeThreadId) {
    const rendered = renderAgentRun(run, { stale });
    const activeNode = operationId
      ? elements.agentThread.querySelector(`[data-operation-id="${CSS.escape(operationId)}"]`)
      : null;
    if (activeNode) {
      activeNode.replaceWith(rendered);
    } else {
      const alreadyRendered = Array.from(elements.agentThread.querySelectorAll(".agent-run"))
        .some((node) => node.dataset.runId === String(run.id));
      if (!alreadyRendered) {
        if (restored) {
          elements.agentThread.insertAdjacentHTML(
            "beforeend",
            `<div class="run-state"><span class="evidence-dot complete"></span><span>已恢复这条对话最近一次完成的 Codex 结果。</span></div>`,
          );
        }
        elements.agentThread.append(rendered);
      }
    }
    if (!stale) state.currentRun = run;
  }
  if (operationId) {
    rememberSettledOperation(operationId);
  }
  const resultLabel = runScope === "portfolio" ? "全部组合" : run.context.symbol || "目标";
  const label = stale
    ? `${resultLabel} 分析完成，但上下文已变化`
    : `${resultLabel} 分析完成`;
  if (operation) finishAgentOperation(operation, label);
  else if (resultThreadId === activeThreadId) finishActiveAgentUi(operationId, label);
  renderAgentSessions();
  if (resultThreadId === activeThreadId) scrollAgentToEnd();
  return true;
}

function finishAgentOperation(operation, message) {
  if (operation.recoveryTimer) clearTimeout(operation.recoveryTimer);
  operation.status = "completed";
  state.operations.delete(operation.operationId);
  if (operation.threadId === state.activeSessionId) {
    finishActiveAgentUi(operation.operationId, message);
  }
  renderAgentSessions();
  if (!elements.historyPanel.hidden) loadAgentHistory();
}

function failAgentOperation(operation, message) {
  if (!state.operations.has(operation.operationId)
    && state.settledOperationIds.has(operation.operationId)) return;
  operation.status = "error";
  if (operation.recoveryTimer) clearTimeout(operation.recoveryTimer);
  const isActive = operation.threadId === state.activeSessionId;
  const session = state.agentSessions.find((item) => item.id === operation.threadId);
  if (session) {
    session.runState = "error";
    session.operationId = null;
  }
  if (isActive) {
    const node = elements.agentThread.querySelector(`[data-operation-id="${CSS.escape(operation.operationId)}"]`)
      ?? state.activeRunNode;
    if (node) {
      node.className = "run-state negative";
      node.innerHTML = `<span class="evidence-dot failed"></span><span>${esc(message)}</span>`;
    }
    elements.agentLiveStatus.textContent = message;
  }
  state.operations.delete(operation.operationId);
  rememberSettledOperation(operation.operationId);
  if (isActive) finishActiveAgentUi(operation.operationId, message);
  renderAgentSessions();
  if (!elements.historyPanel.hidden) loadAgentHistory();
  setSystemMessage(message, "error");
}

function finishActiveAgentUi(operationId, message) {
  if (!operationId || operationId === state.activeRequestId) {
    state.activeRunNode = null;
    state.activeRequestId = null;
    resetAgentStream();
    elements.agentCancel.hidden = true;
    elements.agentCancel.disabled = false;
    updateAgentSubmitState();
  }
  elements.agentLiveStatus.textContent = message || "Agent 已结束";
  renderAgentSessions();
}

function rememberSettledOperation(operationId) {
  const normalized = String(operationId ?? "").trim();
  if (!normalized) return;
  state.settledOperationIds.delete(normalized);
  state.settledOperationIds.add(normalized);
  while (state.settledOperationIds.size > 100) {
    state.settledOperationIds.delete(state.settledOperationIds.values().next().value);
  }
}

function restoreAgentResult(envelope) {
  if (!envelope?.run) return;
  acceptAgentResult(envelope, { restored: true });
}

function restoreActiveAgent(activeAgent) {
  const operationId = String(activeAgent?.operationId ?? "");
  const threadId = String(activeAgent?.threadId ?? state.activeSessionId ?? "");
  if (!operationId || state.activeRequestId || state.settledOperationIds.has(operationId)) return;
  let operation = state.operations.get(operationId);
  if (!operation) {
    operation = {
      operationId,
      threadId,
      status: "running",
      progress: "正在重新接入后台 Codex 分析…",
      task: String(activeAgent?.task ?? ""),
      streamText: "",
      finalText: "",
      streamBuffers: new Map(),
      streamOrder: [],
      toolEvents: new Map(),
    };
    state.operations.set(operationId, operation);
  }
  if (operation.threadId !== state.activeSessionId) return;
  const node = createOperationNode(operation);
  state.activeRequestId = operationId;
  state.activeRunNode = node;
  elements.agentThread.append(node);
  elements.agentCancel.hidden = false;
  elements.agentSubmit.disabled = true;
  elements.agentLiveStatus.textContent = "后台 Codex 分析仍在运行";
  scheduleAgentResultRecovery(operation, 1_000);
  scrollAgentToEnd();
}

function createOperationNode(operation) {
  const node = document.createElement("div");
  node.className = "run-state";
  node.dataset.operationId = operation.operationId;
  node.innerHTML = `<span class="loader"></span><div class="run-progress"><span data-progress-message>${esc(operation.progress || "Codex 正在分析…")}</span><div class="agent-stream-output" data-stream-output ${operation.streamText ? "" : "hidden"}></div><div class="agent-stream-tools" data-stream-tools></div></div>`;
  const output = node.querySelector("[data-stream-output]");
  if (output && operation.streamText) output.textContent = operation.streamText;
  const tools = node.querySelector("[data-stream-tools]");
  for (const event of operation.toolEvents?.values?.() ?? []) renderToolChip(tools, event);
  return node;
}

async function cancelAgentTask() {
  const operation = activeOperationForThread(state.activeSessionId);
  if (!operation) return;
  elements.agentCancel.disabled = true;
  elements.agentLiveStatus.textContent = "正在取消 Agent 分析";
  const progress = state.activeRunNode?.querySelector("[data-progress-message]");
  if (progress) progress.textContent = "正在取消 Agent 分析…";
  try {
    operation.status = "cancelling";
    const result = await api.cancelAgent({
      threadId: operation.threadId,
      operationId: operation.operationId,
    });
    if (!result.ok) {
      elements.agentCancel.disabled = false;
      setSystemMessage(result.message || "当前没有正在运行的 Agent", "warning");
    }
  } catch (error) {
    elements.agentCancel.disabled = false;
    setSystemMessage(error.message || "取消 Agent 失败", "error");
  }
}

function renderAgentRun(run, { stale = false } = {}) {
  const wrapper = document.createElement("section");
  wrapper.className = `agent-run${stale ? " stale" : ""}`;
  wrapper.dataset.runId = run.id;
  const renderers = {
    conclusion: () => conclusionCard(run),
    technical: () => technicalCard(run.technical),
    fib: () => fibCard(run.technical?.fib, run.technical?.lastPrice),
    risk: () => riskCard(run.risk),
    plan: () => planCard(run.plan),
    evidence: () => evidenceCard(run),
  };
  const requestedSections = run.sections ?? Object.keys(renderers);
  const conclusion = requestedSections.includes("conclusion") ? conclusionCard(run) : "";
  const structuredSections = requestedSections
    .filter((name) => name !== "conclusion" && renderers[name])
    .map((name) => renderers[name]());
  const structuredModuleCount = structuredSections.length;
  const notices = [];
  if (stale) {
    notices.push(`<div class="run-state"><span class="evidence-dot degraded"></span><span>分析完成时持仓或选择已变化；此结果仅供回看，不能保存为当前计划。</span></div>`);
  }
  if (run.plan?.available && requestedSections.includes("plan")) {
    structuredSections.push(`<button class="save-plan" type="button" data-save-plan="${esc(run.id)}" ${stale ? "disabled" : ""}>${stale ? "上下文已失效 · 请重新运行" : "保存为静态计划快照 · 不监控、不下单"}</button>`);
  }
  const structured = structuredSections.length
    ? `<details class="structured-evidence"><summary><span>展开结构化证据</span><strong>${structuredModuleCount} 个模块 · EMA / FIB / 风险 / 计划</strong></summary><div class="structured-evidence-body">${structuredSections.join("")}</div></details>`
    : "";
  wrapper.innerHTML = `${notices.join("")}${conclusion}${structured}`;
  const response = wrapper.querySelector(".model-response");
  if (response) {
    if (window.CockpitMarkdown?.renderMarkdown) {
      window.CockpitMarkdown.renderMarkdown(response, run.conclusion?.body ?? "");
    } else {
      response.textContent = run.conclusion?.body ?? "";
    }
  }
  return wrapper;
}

function conclusionCard(run) {
  const model = run.modelAnalysis;
  const toolLabels = (model?.toolEvents ?? [])
    .filter((item) => item.lifecycle === "completed")
    .slice(-8)
    .map((item) => `<span>${esc(item.label)}</span>`)
    .join("");
  const elapsed = run.performance?.endToEndMs ?? run.elapsedMs;
  const firstActivity = run.performance?.codexFirstActivityMs;
  const firstActivityMeta = firstActivity != null && Number.isFinite(Number(firstActivity))
    ? `<span>首响应 ${number(Number(firstActivity) / 1000, 1)}s</span>`
    : "";
  return `<article class="agent-card conclusion-card">
    <div class="agent-card-head"><span>CODEX ANALYSIS</span><strong>${esc(run.state)} · ${number(elapsed / 1000, 1)}s</strong></div>
    <div class="agent-card-body">
      <h3>${esc(run.conclusion.headline)}</h3>
      <div class="model-response"></div>
      <span class="posture">${esc(run.conclusion.posture)}</span>
      <div class="workspace-meta"><span>PERSISTENT</span><span>${esc(model?.threadId?.slice(0, 12) ?? "THREAD")}</span>${firstActivityMeta}<span>${number(model?.skillCount, 0)} SKILLS</span><span>${number(model?.mcpServerCount, 0)} MCP</span><span>${number(model?.appCount, 0)} APPS</span>${toolLabels}</div>
    </div>
  </article>`;
}

function technicalCard(technical) {
  if (!technical?.ema || !Object.keys(technical.ema).length) {
    return `<article class="agent-card"><div class="agent-card-head"><span>EMA STRUCTURE</span><strong class="negative">DEGRADED</strong></div><div class="agent-card-body"><p>${esc(technical?.reason || "无行情数据")}</p></div></article>`;
  }
  const periods = [3, 5, 8, 13, 21, 144, 169];
  const values = [
    { label: "价格", value: technical.lastPrice },
    ...periods.slice(0, 5).map((period) => ({ label: `EMA${period}`, value: technical.ema[period] })),
  ].filter((item) => Number.isFinite(item.value));
  const inequality = values.map((item, index) => {
    if (index === 0) return `${item.label} ${number(item.value)}`;
    const previous = values[index - 1].value;
    const operator = previous > item.value ? " > " : previous < item.value ? " < " : " ≈ ";
    return `${operator}${item.label} ${number(item.value)}`;
  }).join("");
  const emaCells = periods.map((period) => {
    const value = technical.ema[period];
    const slope = technical.emaSlope5d[period];
    const slopeClass = slope > 0 ? "slope-up" : slope < 0 ? "slope-down" : "";
    const arrow = slope > 0 ? "↑" : slope < 0 ? "↓" : "—";
    return `<div class="ema-cell"><span>EMA${period}<em class="${slopeClass}">${arrow} ${signedPercent(slope)}</em></span><strong>${number(value)}</strong></div>`;
  }).join("");
  return `<article class="agent-card">
    <div class="agent-card-head"><span>EMA STRUCTURE</span><strong>${esc(technical.asOf ? shortDate(technical.asOf) : "—")}</strong></div>
    <div class="agent-card-body">
      <div class="structure-line">${esc(inequality)}</div>
      <div class="ema-grid">${emaCells}</div>
      <div class="cycle-verdict"><div><span>时点层 · 3/5/8/13/21</span><strong>${esc(technical.shortStructure)}</strong></div><div><span>核心周期 · 144/169</span><strong>${esc(technical.longStructure)}</strong></div></div>
    </div>
  </article>`;
}

function fibCard(fib, lastPrice) {
  if (!fib) {
    return `<article class="agent-card"><div class="agent-card-head"><span>FIBONACCI EXTENSION</span><strong>SKIPPED</strong></div><div class="agent-card-body"><p>没有足够 K 线生成三点扩展。</p></div></article>`;
  }
  const anchor = (key) => `<div><span>${key.toUpperCase()}</span><strong>${number(fib.anchors[key].price)}</strong><small>${esc(fib.anchors[key].date)}</small></div>`;
  const levels = [0.382, 0.618, 1, 1.618].map((ratio) => {
    const value = fib.levels[String(ratio)];
    const distance = lastPrice ? ((value - lastPrice) / lastPrice) * 100 : null;
    return `<div class="fib-level"><span>${ratio}</span><i></i><strong>${number(value)} · ${signedPercent(distance)}</strong></div>`;
  }).join("");
  return `<article class="agent-card">
    <div class="agent-card-head"><span>FIBONACCI EXTENSION</span><strong>${fib.direction === "up" ? "UP" : "DOWN"}</strong></div>
    <div class="agent-card-body"><div class="fib-anchors">${anchor("a")}${anchor("b")}${anchor("c")}</div><div class="fib-levels">${levels}</div><p class="fib-source">${esc(fib.source)}</p></div>
  </article>`;
}

function riskCard(risk) {
  if (risk?.scope === "portfolio") return portfolioRiskCard(risk);
  if (risk?.scope === "candidate") return candidateRiskCard(risk);
  if (!risk.supported) {
    return `<article class="agent-card">
      <div class="agent-card-head"><span>PORTFOLIO RISK</span><strong class="negative">UNSUPPORTED</strong></div>
      <div class="agent-card-body">
        <div class="risk-grid"><div><span>持仓权重</span><strong>${percent(risk.positionWeight)}</strong></div><div><span>主题暴露</span><strong>${percent(risk.groupWeight)}</strong></div><div><span>工具类型</span><strong>${esc(risk.instrumentType)}</strong></div></div>
        <div class="risk-warning">${esc(risk.limitation)}</div>
      </div>
    </article>`;
  }
  return `<article class="agent-card">
    <div class="agent-card-head"><span>PORTFOLIO RISK</span><strong>${esc(risk.group)}</strong></div>
    <div class="agent-card-body">
      <div class="risk-grid">
        <div><span>持仓权重</span><strong>${percent(risk.positionWeight)}</strong></div>
        <div><span>主题暴露</span><strong>${percent(risk.groupWeight)}</strong></div>
        <div><span>浮动盈亏</span><strong class="${tone(risk.pnlPercent)}">${signedPercent(risk.pnlPercent)}</strong></div>
        <div><span>风险预算</span><strong>${percent(risk.riskBudgetPercent)}</strong></div>
        <div><span>${esc(risk.referenceLabel)}</span><strong>${number(risk.referenceLevel)}</strong></div>
        <div><span>静态组合影响</span><strong>${signedPercent(risk.portfolioImpactAtReferencePercent)}</strong></div>
      </div>
      <div class="risk-warning">${risk.limitation ? `${esc(risk.limitation)} ` : ""}组合影响仅对普通多头股票按当前权重与线性价格变动静态估算；执行前必须用最新长桥快照重算。</div>
    </div>
  </article>`;
}

function portfolioRiskCard(risk) {
  const largestGroup = risk.groupExposure?.[0];
  const alerts = (risk.alerts ?? []).filter((item) => item.severity !== "info");
  const alertMarkup = alerts.length
    ? `<div class="portfolio-alerts">${alerts.map((item) => `<div class="${esc(item.severity)}"><strong>${esc(item.label)}</strong><span>${item.value == null ? "" : esc(number(item.value))}</span></div>`).join("")}</div>`
    : `<div class="risk-balanced">当前确定性阈值未触发集中度、杠杆或保证金预警。</div>`;
  const healthLabels = {
    balanced: "均衡",
    review: "需复核",
    partial: "估值不完整",
    critical: "高风险",
    unavailable: "不可用",
  };
  return `<article class="agent-card">
    <div class="agent-card-head"><span>PORTFOLIO HEALTH</span><strong class="health-${esc(risk.health)}">${esc(healthLabels[risk.health] ?? risk.health ?? "—")}</strong></div>
    <div class="agent-card-body">
      <div class="risk-grid portfolio-risk-grid">
        <div><span>真实持仓</span><strong>${number(risk.positionCount, 0)}</strong></div>
        <div><span>总暴露</span><strong>${percent(risk.grossExposurePercent)}</strong></div>
        <div><span>净暴露</span><strong>${percent(risk.netExposurePercent)}</strong></div>
        <div><span>TOP 1</span><strong>${percent(risk.top1Weight)}</strong></div>
        <div><span>TOP 5</span><strong>${percent(risk.top5Weight)}</strong></div>
        <div><span>现金</span><strong>${percent(risk.cashRatio)}</strong></div>
        <div><span>最大主题</span><strong>${largestGroup ? `${esc(largestGroup.key)} ${percent(largestGroup.weight)}` : "—"}</strong></div>
        <div><span>未定价</span><strong>${number(risk.unpricedPositionCount, 0)}</strong></div>
        <div><span>追加保证金</span><strong>${risk.marginCall ? esc(number(risk.marginCall)) : "无"}</strong></div>
      </div>
      ${alertMarkup}
      ${risk.limitation ? `<div class="risk-warning">${esc(risk.limitation)}</div>` : ""}
    </div>
  </article>`;
}

function candidateRiskCard(risk) {
  const leverage = risk.leverage ?? {};
  const sizingReview = risk.sizingReview ?? {};
  const reviewed = sizingReview.status === "skill_mcp_reviewed";
  const status = !risk.supported
    ? "TECHNICAL ONLY"
    : risk.entryAllowed
      ? reviewed ? "SKILL/MCP REVIEWED · CASH" : "LOCAL CEILING · CASH"
      : "NO NEW RISK";
  const blockers = (risk.entryBlockReasons ?? []).filter(Boolean);
  const leverageReasons = (leverage.disabledReasons ?? []).filter(Boolean);
  const disclosure = blockers.length
    ? blockers.join("；")
    : risk.limitation ?? risk.sizingNote;
  const initialLabel = reviewed ? "Skill/MCP 初始新增" : "本地初始上限";
  const maxLabel = reviewed ? "Skill/MCP 最大总仓位" : "本地最大总上限";
  return `<article class="agent-card">
    <div class="agent-card-head"><span>ENTRY SIZE & LEVERAGE</span><strong>${status}</strong></div>
    <div class="agent-card-body">
      <div class="risk-grid">
        <div><span>当前持仓</span><strong>${percent(risk.existingPositionWeight ?? 0)}</strong></div>
        <div><span>${initialLabel}</span><strong>${percent(risk.recommendedInitialAdditionalWeightPercent)}</strong></div>
        <div><span>${maxLabel}</span><strong>${percent(risk.recommendedMaxWeightPercent)}</strong></div>
        <div><span>最大新增仓位</span><strong>${percent(risk.recommendedMaxAdditionalWeightPercent)}</strong></div>
        <div><span>初始名义金额 / ${esc(risk.baseCurrency)}</span><strong>${money(risk.recommendedInitialNotionalBase, risk.baseCurrency)}</strong></div>
        <div><span>最大新增金额 / ${esc(risk.baseCurrency)}</span><strong>${money(risk.recommendedMaxAdditionalNotionalBase, risk.baseCurrency)}</strong></div>
        <div><span>风险预算</span><strong>${percent(risk.riskBudgetPercent)}</strong></div>
        <div><span>失效距离</span><strong>${percent(risk.riskDistancePercent)}</strong></div>
        <div><span>${esc(risk.referenceLabel)}</span><strong>${number(risk.referenceLevel)}</strong></div>
        <div><span>新增融资权重</span><strong>${percent(leverage.maxAdditionalBorrowedWeightPercent ?? 0)}</strong></div>
        <div><span>杠杆上限</span><strong>${number(leverage.maxLeverageMultiple, 2)}×</strong></div>
        <div><span>杠杆判断</span><strong>${leverage.decision === "disabled" ? "禁止新增 / 不可评估" : leverage.additionalLeverageAllowed ? "可复核" : "仅现金覆盖"}</strong></div>
      </div>
      ${sizingReview.rationale ? `<div class="risk-balanced">Skill/MCP 复核：${esc(sizingReview.rationale)}</div>` : ""}
      <div class="${risk.supported && risk.entryAllowed ? "risk-balanced" : "risk-warning"}">${esc(disclosure)}</div>
      ${leverageReasons.length ? `<div class="risk-warning">杠杆约束：${esc(leverageReasons.join("；"))}</div>` : ""}
    </div>
  </article>`;
}

function planCard(plan) {
  if (!plan.available) {
    return `<article class="agent-card"><div class="agent-card-head"><span>CONDITIONAL PLAN</span><strong>UNAVAILABLE</strong></div><div class="agent-card-body"><p>${esc(plan.reason)}</p></div></article>`;
  }
  const scenarios = plan.scenarios.map((scenario) => `<div class="scenario ${esc(scenario.tone)}">
    <span class="scenario-name">${esc(scenario.name)}</span>
    <dl><dt>IF</dt><dd>${esc(scenario.if)}</dd><dt>THEN</dt><dd>${esc(scenario.then)}</dd><dt>失效</dt><dd>${esc(scenario.invalidation)}</dd><dt>组合影响</dt><dd>${esc(scenario.impact)}</dd>${scenario.modelView ? `<dt>Codex</dt><dd class="model-view">${esc(scenario.modelView)}</dd>` : ""}</dl>
  </div>`).join("");
  return `<article class="agent-card"><div class="agent-card-head"><span>CONDITIONAL PLAN</span><strong>${esc(plan.state.toUpperCase())}</strong></div><div class="agent-card-body"><p class="plan-disclosure">静态计划快照：当前不会后台监控条件，也不会生成或提交订单。</p>${scenarios}</div></article>`;
}

function evidenceCard(run) {
  const rows = run.evidence.map((item) => `<div class="evidence-item">
    <span class="evidence-dot ${esc(item.status)}" aria-hidden="true"></span>
    <div><strong>${esc(item.source)} · ${esc(item.summary)}</strong><small>${esc(item.tool)} · asOf ${esc(item.asOf ? shortTime(item.asOf) : "—")}</small></div>
    <em>${esc(item.status.toUpperCase())} · ${number(item.records, 0)} rec</em>
  </div>`).join("");
  return `<article class="agent-card">
    <div class="agent-card-head"><span>EVIDENCE TRACE</span><strong>${run.evidence.length} steps</strong></div>
    <div class="agent-card-body evidence-list">${rows}</div>
  </article>`;
}

function setLongbridgeStatus(status) {
  const connectedStates = new Set([
    "connected",
    "ready",
    "degraded",
    "service_degraded",
    "syncing",
  ]);
  const connected = connectedStates.has(status.state);
  elements.longbridgeChip.className = `status-chip ${connected ? "connected" : ""}`;
  elements.longbridgeChip.innerHTML = `<i></i>${esc(status.message || (connected ? "长桥已连接" : "长桥未连接"))}`;
  elements.connect.textContent = connected ? "长桥已连接" : "连接长桥";
}

function setCodexStatus(status) {
  state.codexRuntimeAvailable = status?.available === true;
  const readOnlyGuardReady = status?.readOnlyGuardReady !== false
    && status?.readOnlyGuard?.ready !== false;
  state.codexAvailable = status?.ready === true && readOnlyGuardReady;
  elements.codexBadge.textContent = state.codexAvailable
    ? "CODEX READY"
    : status?.ready === true && !readOnlyGuardReady
      ? "CODEX GUARD"
      : state.codexRuntimeAvailable ? "CODEX STARTING" : "CODEX OFF";
  elements.codexBadge.classList.toggle("unavailable", !state.codexRuntimeAvailable);
  elements.codexBadge.classList.toggle("starting", state.codexRuntimeAvailable && !state.codexAvailable);
  elements.codexBadge.title = state.codexAvailable
    ? `持久项目：${status?.workspaceDirectory ?? "stock_agent"}；Codex App Server 已就绪；交易写工具与破坏性 App 动作被禁用`
    : status?.ready === true && !readOnlyGuardReady
      ? "检测到未受保护的长桥交易写能力；Agent 已停止启动分析，行情、Skills 与其他工具未被限制"
    : state.codexRuntimeAvailable
      ? "Codex App Server 正在恢复持久项目线程"
      : "未检测到本机 Codex 运行时";
  updateAgentSubmitState();
  renderAgentSessions();
}

function updateAgentSubmitState() {
  const active = activeOperationForThread(state.activeSessionId);
  const activeSession = state.agentSessions.find((session) => session.id === state.activeSessionId);
  elements.agentSubmit.disabled = state.busy
    || !state.portfolio
    || !state.codexAvailable
    || !state.activeSessionId
    || Boolean(activeSession?.provisioning)
    || Boolean(active);
  elements.agentCancel.hidden = !active;
  if (!active) elements.agentCancel.disabled = false;
}

async function loadAgentCapabilities() {
  if (!state.codexRuntimeAvailable) return;
  try {
    setAgentCapabilities(await api.getAgentCapabilities());
  } catch (error) {
    setSystemMessage(error.message || "Codex 能力清单加载失败", "warning");
  }
}

function setAgentCapabilities(capabilities) {
  state.agentCapabilities = capabilities;
  setCodexStatus(capabilities);
  updatePromptSuggestions();
}

function capabilityItems() {
  const capabilities = state.agentCapabilities;
  if (!capabilities) return [];
  const commands = (capabilities.commands ?? []).map((item) => ({
    kind: "COMMAND",
    token: item.name,
    label: item.name,
    description: item.description,
    available: true,
  }));
  const skills = (capabilities.skills ?? []).map((item) => ({
    kind: "SKILL",
    token: `$${item.name}`,
    label: `$${item.name}`,
    description: item.description || `${item.scope} skill`,
    available: true,
  }));
  const apps = (capabilities.apps ?? []).map((item) => ({
    kind: "APP",
    token: `$${item.id}`,
    label: `$${item.id}`,
    description: item.description || item.name,
    available: true,
  }));
  const mcp = (capabilities.mcpServers ?? []).flatMap((server) => {
    const available = server.authStatus !== "notLoggedIn";
    const serverItem = {
      kind: "MCP",
      token: `@${server.name}`,
      label: `@${server.name}`,
      description: `${server.tools.length} tools · ${server.authStatus}`,
      available,
    };
    const tools = server.tools.map((tool) => ({
      kind: "TOOL",
      token: `@${server.name}/${tool.name}`,
      label: `@${server.name}/${tool.name}`,
      description: tool.description || tool.title,
      available,
    }));
    return [serverItem, ...tools];
  });
  return [...commands, ...skills, ...apps, ...mcp];
}

function updatePromptSuggestions() {
  const input = elements.agentInput;
  const beforeCaret = input.value.slice(0, input.selectionStart ?? input.value.length);
  const match = beforeCaret.match(/(^|\s)([/@$][^\s]*)$/u);
  if (!match) {
    closePromptSuggestions();
    return;
  }
  const query = match[2].toLowerCase();
  const start = beforeCaret.length - match[2].length;
  const marker = query[0];
  const queryKey = `${start}:${query}`;
  const candidates = capabilityItems()
    .filter((item) => item.token[0] === marker)
    .filter((item) => item.token.toLowerCase().includes(query))
    .sort((a, b) => {
      const aPrefix = a.token.toLowerCase().startsWith(query) ? 0 : 1;
      const bPrefix = b.token.toLowerCase().startsWith(query) ? 0 : 1;
      return aPrefix - bPrefix || a.token.localeCompare(b.token);
    });
  if (!candidates.length) {
    closePromptSuggestions();
    return;
  }
  if (queryKey !== state.suggestionQueryKey) state.suggestionIndex = 0;
  state.suggestionQueryKey = queryKey;
  state.promptSuggestions = candidates;
  state.suggestionIndex = Math.min(state.suggestionIndex, candidates.length - 1);
  state.suggestionTrigger = { start, end: input.selectionStart ?? beforeCaret.length };
  renderPromptSuggestions();
}

function renderPromptSuggestions() {
  elements.promptSuggestions.hidden = false;
  elements.agentInput.setAttribute("aria-expanded", "true");
  elements.promptSuggestions.innerHTML = state.promptSuggestions.map((item, index) => `
    <button id="prompt-suggestion-${index}" class="prompt-suggestion${index === state.suggestionIndex ? " active" : ""}${item.available ? "" : " unavailable"}" type="button" role="option" aria-selected="${index === state.suggestionIndex}" data-suggestion-index="${index}" ${item.available ? "" : "disabled"}>
      <span class="suggestion-kind">${esc(item.kind)}</span>
      <span><strong>${esc(item.label)}</strong><small>${esc(item.description)}</small></span>
    </button>`).join("");
  updatePromptSuggestionSelection({ scroll: false });
}

function updatePromptSuggestionSelection({ scroll = true } = {}) {
  const buttons = elements.promptSuggestions.querySelectorAll("[data-suggestion-index]");
  let active = null;
  buttons.forEach((button) => {
    const selected = Number(button.dataset.suggestionIndex) === state.suggestionIndex;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
    if (selected) active = button;
  });
  if (!active) {
    elements.agentInput.removeAttribute("aria-activedescendant");
    return;
  }
  elements.agentInput.setAttribute("aria-activedescendant", active.id);
  if (scroll) active.scrollIntoView({ block: "nearest" });
}

function handlePromptKeydown(event) {
  if (event.isComposing) return;
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    closePromptSuggestions();
    elements.agentForm.requestSubmit();
    return;
  }
  if (elements.promptSuggestions.hidden) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    state.suggestionIndex = (state.suggestionIndex + direction + state.promptSuggestions.length)
      % state.promptSuggestions.length;
    updatePromptSuggestionSelection();
  } else if (event.key === "Tab" || event.key === "Enter") {
    event.preventDefault();
    applyPromptSuggestion(state.suggestionIndex);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closePromptSuggestions();
  }
}

function applyPromptSuggestion(index) {
  const suggestion = state.promptSuggestions[index];
  const trigger = state.suggestionTrigger;
  if (!suggestion?.available || !trigger) return;
  const input = elements.agentInput;
  const suffix = suggestion.kind === "MCP" ? "/" : " ";
  input.value = `${input.value.slice(0, trigger.start)}${suggestion.token}${suffix}${input.value.slice(trigger.end)}`;
  const caret = trigger.start + suggestion.token.length + suffix.length;
  input.setSelectionRange(caret, caret);
  input.focus();
  closePromptSuggestions();
  if (suggestion.kind === "MCP") updatePromptSuggestions();
}

function closePromptSuggestions() {
  state.promptSuggestions = [];
  state.suggestionIndex = 0;
  state.suggestionTrigger = null;
  state.suggestionQueryKey = null;
  elements.promptSuggestions.hidden = true;
  elements.promptSuggestions.replaceChildren();
  elements.agentInput.setAttribute("aria-expanded", "false");
  elements.agentInput.removeAttribute("aria-activedescendant");
}

function renderAgentStream(event) {
  const operationId = String(event.operationId ?? "");
  const operation = state.operations.get(operationId);
  if (!operation) return;
  const isActive = operation.threadId === state.activeSessionId;
  const node = isActive
    ? elements.agentThread.querySelector(`[data-operation-id="${CSS.escape(operationId)}"]`)
    : null;
  if (event.kind === "text_delta") {
    const itemId = String(event.itemId ?? "agent-message");
    if (!operation.streamBuffers.has(itemId)) operation.streamOrder.push(itemId);
    const next = `${operation.streamBuffers.get(itemId) ?? ""}${String(event.delta ?? "")}`
      .slice(-40_000);
    operation.streamBuffers.set(itemId, next);
    operation.previewItemId = itemId;
    scheduleAgentStreamFlush();
  } else if (event.kind === "tool") {
    const itemId = String(event.itemId ?? `${event.type ?? "tool"}:${event.label ?? ""}`);
    operation.toolEvents.set(itemId, { ...event, itemId });
    if (node) renderToolChip(node.querySelector("[data-stream-tools]"), { ...event, itemId });
  } else if (event.kind === "evidence_ready") {
    operation.progress = event.message || "只读证据已就绪，Codex 正在组织结论";
    const progress = node?.querySelector("[data-progress-message]");
    if (progress) progress.textContent = event.message || "只读证据已就绪，Codex 正在组织结论";
    node?.classList.add("evidence-ready");
  } else if (event.kind === "final_message") {
    flushAgentStream(operationId);
    operation.finalText = String(event.text ?? operation.finalText ?? "");
    operation.streamText = operation.finalText;
    const output = node?.querySelector("[data-stream-output]");
    if (output) {
      output.hidden = false;
      output.classList.add("model-response", "final-preview");
      if (window.CockpitMarkdown?.renderMarkdown) {
        window.CockpitMarkdown.renderMarkdown(output, operation.streamText);
      } else {
        output.textContent = operation.streamText;
      }
    }
    operation.progress = event.recovered
      ? "已从持久线程找回最终结论，正在完成结构化呈现…"
      : "Codex 最终结论已收到，正在确认终态…";
    const progress = node?.querySelector("[data-progress-message]");
    if (progress) {
      progress.textContent = event.recovered
        ? "已从持久线程找回最终结论，正在完成结构化呈现…"
        : "Codex 最终结论已收到，正在确认终态…";
    }
    scheduleAgentResultRecovery(operation, 900);
  }
  if (isActive) scrollAgentToEnd();
}

function renderToolChip(tools, event) {
  if (!tools) return;
  const itemId = String(event.itemId ?? `${event.type ?? "tool"}:${event.label ?? ""}`);
  let chip = Array.from(tools.children).find((item) => item.dataset.toolId === itemId);
  if (!chip) {
    chip = document.createElement("span");
    chip.dataset.toolId = itemId;
    tools.append(chip);
  }
  const lifecycle = event.lifecycle === "completed" ? "completed" : "running";
  const visualState = /fail|error/i.test(String(event.status ?? "")) ? "failed" : lifecycle;
  chip.className = `tool-chip ${visualState}`;
  chip.textContent = `${visualState === "failed" ? "!" : lifecycle === "completed" ? "✓" : "↗"} ${event.label ?? event.type ?? "Codex tool"}`;
  chip.title = event.status ? String(event.status) : lifecycle;
  while (tools.children.length > 12) {
    const removable = Array.from(tools.children).find((item) => item !== chip && item.classList.contains("completed"));
    (removable ?? tools.firstElementChild)?.remove();
  }
}

function scheduleAgentStreamFlush() {
  if (state.streamFrame != null) return;
  state.streamFrame = requestAnimationFrame(() => {
    state.streamFrame = null;
    flushAgentStream();
  });
}

function flushAgentStream(operationId = null) {
  if (state.streamFrame != null) {
    cancelAnimationFrame(state.streamFrame);
    state.streamFrame = null;
  }
  const operations = operationId
    ? [state.operations.get(operationId)].filter(Boolean)
    : [...state.operations.values()];
  for (const operation of operations) {
    const previewItemId = operation.previewItemId ?? operation.streamOrder?.at(-1);
    const preview = operation.finalText
      || (previewItemId ? operation.streamBuffers?.get(previewItemId) : "")
      || "";
    if (!preview) continue;
    operation.streamText = String(preview).slice(-40_000);
    if (operation.threadId !== state.activeSessionId) continue;
    const output = elements.agentThread.querySelector(`[data-operation-id="${CSS.escape(operation.operationId)}"] [data-stream-output]`);
    if (!output) continue;
    output.hidden = false;
    if (operation.finalText) {
      output.classList.add("model-response", "final-preview");
      if (window.CockpitMarkdown?.renderMarkdown) {
        window.CockpitMarkdown.renderMarkdown(output, operation.streamText);
      } else {
        output.textContent = operation.streamText;
      }
    } else {
      output.classList.remove("model-response", "final-preview");
      output.textContent = operation.streamText;
    }
  }
}

function resetAgentStream() {
  if (state.streamFrame != null) cancelAnimationFrame(state.streamFrame);
  state.streamFrame = null;
}

function setTvStatus(status) {
  const toneClass = status.state === "ready" ? "ready" : ["failed", "blocked", "degraded"].includes(status.state) ? "failed" : "loading";
  elements.tvChip.className = `status-chip tv ${toneClass}`;
  const label = status.state === "ready"
    ? "TradingView 个人会话"
    : status.state === "blocked"
      ? "TradingView 已阻止越界跳转"
      : status.state === "failed"
        ? "TradingView 加载失败"
        : "TradingView 加载中";
  elements.tvChip.innerHTML = `<i></i>${label}`;
  if (status.message) setSystemMessage(status.message, status.state === "failed" ? "error" : "normal");
}

function setSystemMessage(message, toneValue = "normal") {
  elements.systemMessage.textContent = message;
  elements.systemMessage.className = `status-message ${toneValue}`;
}

function selectedPosition() {
  return state.portfolio?.positions?.find((position) => position.symbol === state.selectedSymbol) ?? null;
}

function normalizeCandidateSymbol(value) {
  let symbol = sanitizeCandidateSymbol(value);
  if (!symbol) return "";
  const usMarket = symbol.match(/^(?:NASDAQ|NYSE|AMEX):(.+)$/);
  const hongKong = symbol.match(/^HKEX:(.+)$/);
  if (usMarket) symbol = `${usMarket[1]}.US`;
  else if (hongKong) symbol = `${hongKong[1]}.HK`;
  else if (!symbol.includes(".")) symbol = `${symbol}.US`;
  return symbol.slice(0, 32);
}

function sanitizeCandidateSymbol(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9._:-]/g, "")
    .slice(0, 32);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function scrollAgentToEnd() {
  if (state.scrollFrame != null) return;
  state.scrollFrame = requestAnimationFrame(() => {
    state.scrollFrame = null;
    elements.agentThread.scrollTop = elements.agentThread.scrollHeight;
  });
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function number(value, digits = 2) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function money(value, currency = "USD") {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: 0,
  }).format(Number(value));
}

function price(value, currency = "USD") {
  if (value == null || value === "") return "—";
  const symbols = { HKD: "HK$", USD: "$", CNY: "¥", CNH: "CN¥", SGD: "S$" };
  return `${symbols[currency] ?? `${currency} `}${number(value)}`;
}

function percent(value) {
  return value != null && value !== "" && Number.isFinite(Number(value)) ? `${number(value)}%` : "—";
}

function signedPercent(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "—";
  return `${Number(value) >= 0 ? "+" : ""}${number(value)}%`;
}

function tone(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value)) || Number(value) === 0) return "";
  return Number(value) > 0 ? "positive" : "negative";
}

function sessionLabel(value) {
  return {
    regular: "常规",
    pre_market: "盘前",
    post_market: "盘后",
    overnight: "夜盘",
  }[value] ?? "";
}

function shortTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function shortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function shortDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
