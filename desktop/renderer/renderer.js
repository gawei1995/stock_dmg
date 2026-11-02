const { radarChanges, radarHasGap, radarVisibleCards, radarFieldLabel, radarStateLabel, radarInteger, radarEmaNote } = window.CockpitRadarView;
const api = window.cockpit;
const LAYOUT_STORAGE_KEY = "trading-cockpit:layout:v1";
const DEFAULT_PANE_WIDTHS = Object.freeze({ portfolio: 292, agent: 408 });
const MIN_PANE_WIDTHS = Object.freeze({ portfolio: 220, agent: 320 });
const MAX_PANE_WIDTHS = Object.freeze({ portfolio: 520, agent: 760 });
const MIN_TV_WIDTH = 440;
const RESIZER_WIDTH = 6;
const PORTFOLIO_TRUST_REFRESH_MS = 5_000;
const LEGACY_PORTFOLIO_MAX_AGE_MS = 2 * 60 * 1000;
const POST_TERMINAL_RECOVERY_WINDOW_MS = 60_000;
const AGENT_WELCOME_HTML = `<article class="agent-welcome">
  <span class="agent-orbit" aria-hidden="true">A</span>
  <div><strong>Codex 项目线程已接入交易驾驶舱。</strong><p>可直接聊天与研究，无需先连接券商；每条本机对话都可继续。Skills、Web 与项目文件可用，外部 MCP / Apps 以当前对话的工具状态为准。</p></div>
</article>`;

const state = {
  portfolio: null,
  brokerScope: "all",
  brokers: null,
  brokerBusy: new Set(),
  selectedSymbol: null,
  currentRun: null,
  runsById: new Map(),
  reviewEvidenceRevisions: new Map(),
  reviewCycleRetrospectiveVersions: new Map(),
  reviewCycleEvidenceRevisions: new Map(),
  activeRequestId: null,
  activeRunNode: null,
  operations: new Map(),
  latestOperationByThread: new Map(),
  sessionViews: new Map(),
  filter: "",
  busy: false,
  longbridgeReauthRequired: false,
  codexRuntimeAvailable: false,
  codexAvailable: false,
  agentCapabilities: null,
  agentNetworkPreferences: null,
  agentNetworkDraft: "",
  agentNetworkSaving: false,
  agentNetworkError: null,
  agentNetworkRuntime: null,
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
  analysisScope: "chat",
  candidateSymbol: "",
  technicalRadar: {
    running: false,
    lastError: null,
    watchlist: { items: [], revision: 0, updatedAt: null },
    linkage: { profiles: [], revision: 0, updatedAt: null },
    latestBatch: null,
  },
  technicalRadarLoading: false,
  technicalRadarMutationBusy: false,
  radarUi: { view: "portfolio", settings: false, filter: "all", query: "", expanded: null, notice: null, scroll: { results: 0, settings: 0 } },
  technicalLinkageDrafts: new Map(),
  technicalLinkageBusy: false,
  technicalLinkageDraft: {
    symbol: "",
    sectorSymbol: "",
    peerSymbols: "",
    rationale: "",
    dirty: false,
  },
  technicalLinkageMessage: null,
  streamFrame: null,
  scrollFrame: null,
  agentFollowTail: true,
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
  agentJumpLatest: $("#agent-jump-latest"),
  agentLiveStatus: $("#agent-live-status"),
  agentSubmit: $("#agent-submit"),
  agentAvailability: $("#agent-availability"),
  agentGuardActions: $("#agent-guard-actions"),
  agentGuardRecheck: $("#agent-guard-recheck"),
  agentGuardNewSession: $("#agent-guard-new-session"),
  agentRestrictedSession: $("#agent-restricted-session"),
  agentFullSession: $("#agent-full-session"),
  agentGuardDetails: $("#agent-guard-details"),
  agentGuardFeedback: $("#agent-guard-feedback"),
  agentNetworkSettings: $("#agent-network-settings"),
  agentNetworkForm: $("#agent-network-form"),
  agentNetworkMode: $("#agent-network-mode"),
  agentNetworkSave: $("#agent-network-save"),
  agentNetworkSummary: $("#agent-network-summary"),
  agentNetworkEffective: $("#agent-network-effective"),
  agentNetworkRuntime: $("#agent-network-runtime"),
  agentNetworkFeedback: $("#agent-network-feedback"),
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
  technicalRadar: $("#technical-radar"),
  technicalRadarToggle: $("#technical-radar-toggle"),
  technicalRadarToggleState: $("#technical-radar-toggle-state"),
  technicalRadarBody: $("#technical-radar-body"),
  technicalRadarSummary: $("#technical-radar-summary"),
  technicalRadarRun: $("#technical-radar-run"),
  technicalRadarComputed: $("#technical-radar-computed"),
  technicalRadarList: $("#technical-radar-list"),
  technicalLinkageEditor: $("#technical-linkage-editor"),
  technicalLinkageForm: $("#technical-linkage-form"),
  technicalLinkageState: $("#technical-linkage-state"),
  technicalLinkageSymbol: $("#technical-linkage-symbol"),
  technicalLinkageSector: $("#technical-linkage-sector"),
  technicalLinkagePeers: $("#technical-linkage-peers"),
  technicalLinkageRationale: $("#technical-linkage-rationale"),
  technicalLinkageSave: $("#technical-linkage-save"),
  technicalLinkageRemove: $("#technical-linkage-remove"),
  technicalLinkageMessage: $("#technical-linkage-message"),
  technicalWatchlistForm: $("#technical-watchlist-form"),
  technicalWatchlistSymbol: $("#technical-watchlist-symbol"),
  technicalWatchlistAdd: $("#technical-watchlist-add"),
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
window.setInterval(refreshPortfolioTrustUi, PORTFOLIO_TRUST_REFRESH_MS);

async function initialize() {
  restorePaneLayout();
  bindEvents();
  queueTvBoundsSync();
  try {
    const initial = await api.getInitialState();
    setAgentNetworkPreferences(initial.agentNetwork);
    setCodexStatus(initial.codex);
    if (initial.brokers) setBrokers(initial.brokers);
    else setPortfolio(initial.portfolio ?? null);
    syncActiveAgents(initial.activeAgents);
    if (initial.agentSessions) setAgentSessions(initial.agentSessions);
    loadAgentSessions();
    restoreAgentResult(initial.lastAgentResult);
    restoreActiveAgent(initial.activeAgent);
    setLongbridgeStatus(
      initial.longbridge.connected
        ? { state: "connected", message: "长桥已连接 · 查询权限" }
        : initial.longbridge.needsAuthorizationUpgrade
          ? { state: "scope_upgrade_required", message: "长桥历史查询需要升级只读授权" }
          : initial.longbridge.hasSavedAuthorization
            ? { state: "connecting", message: "正在恢复长桥授权" }
            : { state: "disconnected", message: "长桥未连接" },
    );
    renderStorageHealth(initial.storage);
    loadAgentCapabilities();
    void loadTechnicalRadar();
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
    if (status.storage) renderStorageHealth(status.storage);
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
    if (isLongbridgeConnectionStatus(status)) setLongbridgeStatus(status);
    setSystemMessage(status.detail || status.message || "状态已更新");
  });
  api.onPortfolio((portfolio) => { if (!api.brokers) setPortfolio(portfolio); });
  api.onBrokers?.(setBrokers);
  api.onAgentCapabilities(setAgentCapabilities);
  api.onAgentStream(renderAgentStream);
  api.onAgentResult(handleAgentResult);
  api.onTechnicalRadar(setTechnicalRadar);
  api.onTvState(setTvStatus);

  elements.connect.addEventListener("click", connectLongbridge);
  elements.refresh.addEventListener("click", refreshPortfolio);
  bindBrokerControls();
  elements.positionSearch.addEventListener("input", (event) => {
    state.filter = event.target.value.trim().toUpperCase();
    renderPositions();
  });
  elements.positionList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-symbol]");
    if (row) selectPosition(row.dataset.symbol);
  });
  elements.technicalRadarToggle.addEventListener("click", toggleTechnicalRadar);
  document.querySelectorAll("[data-portfolio-view]").forEach((button) => button.addEventListener("click", () => setPortfolioView(button.dataset.portfolioView)));
  $("#radar-settings-toggle").addEventListener("click", () => setRadarSettings(!state.radarUi.settings));
  $("#radar-settings-back").addEventListener("click", () => setRadarSettings(false));
  $("#radar-filters").addEventListener("click", (event) => {
    const filter = event.target.closest("[data-radar-filter]")?.dataset.radarFilter;
    if (!filter) return;
    state.radarUi.filter = filter; renderTechnicalRadar(); elements.technicalRadarBody.scrollTop = 0;
  });
  $("#radar-search").addEventListener("input", (event) => { state.radarUi.query = event.target.value; renderTechnicalRadar(); });
  $("#radar-watchlist-items").addEventListener("click", handleTechnicalRadarClick);
  elements.technicalRadarRun.addEventListener("click", runTechnicalRadar);
  elements.technicalWatchlistForm.addEventListener("submit", addTechnicalWatchlistSymbol);
  elements.technicalRadarList.addEventListener("click", handleTechnicalRadarClick);
  elements.technicalRadarList.addEventListener("keydown", (event) => {
    if (!event.target.matches("[data-radar-expand]") || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = [...elements.technicalRadarList.querySelectorAll("[data-radar-expand]")];
    const i = buttons.indexOf(event.target);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, i + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault(); buttons[next]?.focus({ preventScroll: true }); buttons[next]?.scrollIntoView({ block: "nearest" });
  });
  elements.technicalLinkageForm.addEventListener("submit", confirmTechnicalLinkage);
  elements.technicalLinkageRemove.addEventListener("click", removeTechnicalLinkage);
  for (const input of [
    elements.technicalLinkageSector,
    elements.technicalLinkagePeers,
    elements.technicalLinkageRationale,
  ]) {
    input.addEventListener("input", updateTechnicalLinkageDraft);
  }
  elements.technicalLinkageSymbol.addEventListener("change", () => {
    setTechnicalLinkageEditorSymbol(elements.technicalLinkageSymbol.value, { force: true });
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
  elements.agentNetworkForm?.addEventListener("submit", saveAgentNetworkPreferences);
  elements.agentNetworkMode?.addEventListener("change", () => {
    state.agentNetworkDraft = elements.agentNetworkMode.value;
    state.agentNetworkError = null;
    renderAgentNetworkPreferences();
  });
  elements.newAgentSession.addEventListener("click", () => createAgentSession());
  elements.agentRestrictedSession?.addEventListener("click", () => createResearchModeSession("restricted"));
  elements.agentFullSession?.addEventListener("click", () => createResearchModeSession("full"));
  elements.agentGuardRecheck?.addEventListener("click", recheckAgentReadOnlyGuard);
  elements.agentGuardNewSession?.addEventListener("click", async () => {
    if (state.guardRepairBusy) return;
    const created = await createAgentSession();
    if (created) await recheckAgentReadOnlyGuard();
  });
  elements.agentGuardDetails?.addEventListener("click", () => $("#system-health-open")?.click());
  elements.agentForm.addEventListener("submit", submitAgentTask);
  window.addEventListener("cockpit:review-analysis-prepared", (event) => {
    void submitPreparedReviewAnalysis(event.detail);
  });
  window.addEventListener("cockpit:review-cycle-analysis-prepared", (event) => {
    void submitPreparedReviewCycleAnalysis(event.detail);
  });
  window.addEventListener("cockpit:research-analysis-prepared", (event) => {
    void submitPreparedResearchAnalysis(event.detail);
  });
  window.addEventListener("cockpit:review-evidence-revisions", (event) => {
    state.reviewEvidenceRevisions = new Map((event.detail?.cases ?? [])
      .map((item) => [String(item?.caseId ?? ""), Number(item?.revision)])
      .filter(([caseId, revision]) => caseId && Number.isInteger(revision) && revision > 0));
    state.reviewCycleRetrospectiveVersions = new Map((event.detail?.cycles ?? [])
      .map((item) => [String(item?.cycleId ?? ""), Number(item?.retrospectiveVersion)])
      .filter(([cycleId, version]) => cycleId && Number.isInteger(version) && version > 0));
    state.reviewCycleEvidenceRevisions = new Map((event.detail?.cycles ?? [])
      .map((item) => [String(item?.cycleId ?? ""), Number(item?.evidenceRevision)])
      .filter(([cycleId, revision]) => cycleId && Number.isInteger(revision) && revision > 0));
    refreshCurrentRunTrustUi();
  });
  elements.agentCancel.addEventListener("click", cancelAgentTask);
  elements.agentThread.addEventListener("scroll", handleAgentThreadScroll, { passive: true });
  elements.agentJumpLatest.addEventListener("click", () => scrollAgentToEnd({ force: true }));
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
    syncTechnicalLinkageEditorFromContext();
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
    const researchButton = event.target.closest("[data-open-research]");
    if (researchButton) {
      window.dispatchEvent(new CustomEvent("cockpit:research-opened", {
        detail: { researchThesisId: researchButton.dataset.openResearch },
      }));
      return;
    }
    const originalThreadButton = event.target.closest("[data-open-original-thread]");
    if (originalThreadButton) {
      await openAgentSession(originalThreadButton.dataset.openOriginalThread, { force: true });
      return;
    }
    const learningButton = event.target.closest("[data-open-learning-proposal]");
    if (learningButton) {
      const run = state.runsById.get(learningButton.dataset.openLearningProposal);
      if (!run?.learningProposal) return;
      if (isRunStale(run)) {
        setSystemMessage(
          run.context?.reviewPhasePersistence === "failed"
            ? "分析已经返回，但未写入审计台账；这份草案不能登记，请重新运行复盘。"
            : "这份验证草案基于已被替换的复盘证据，请先用最新订单关联重新运行复盘。",
          "warning",
        );
        return;
      }
      window.dispatchEvent(new CustomEvent("cockpit:learning-proposal-opened", {
        detail: {
          runId: run.id,
          threadId: run.modelAnalysis?.threadId ?? null,
          reviewCycleId: run.context?.reviewCycleId ?? null,
          proposal: run.learningProposal,
        },
      }));
      return;
    }
    const button = event.target.closest("[data-save-plan]");
    if (!button) return;
    const run = state.runsById.get(button.dataset.savePlan);
    if (!run) return;
    if (isRunStale(run)) {
      button.disabled = true;
      button.textContent = "上下文或裁决已失效 · 请刷新后重新运行";
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

async function createAgentSession(options = {}) {
  if (!api.agentSessions?.create || state.sessionsLoading) return null;
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
    const toolMode = ["full", "restricted"].includes(options?.toolMode) ? options.toolMode : null;
    const result = await api.agentSessions.create({ name, ...(toolMode ? { toolMode } : {}) });
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
    resetAgentConversation("已创建独立会话。项目规则保持共享，工具以本对话的核验状态为准；对话上下文不会与其他会话混合。");
    ensureSessionView(createdId).transcript = [];
    restoreSessionAgentResult(result);
    return createdId || null;
  } catch (error) {
    state.agentSessions = state.agentSessions.filter((session) => session.id !== provisionalId);
    state.sessionViews.delete(provisionalId);
    if (state.activeSessionId === provisionalId) state.activeSessionId = previousId;
    setSystemMessage(error.message || "新建 Agent 会话失败", "error");
    return null;
  } finally {
    state.sessionsLoading = false;
    renderAgentSessions();
  }
}

async function createResearchModeSession(toolMode) {
  if (!["full", "restricted"].includes(toolMode) || state.guardRepairBusy || state.sessionsLoading) return;
  const created = await createAgentSession({ toolMode });
  if (!created) return;
  if (elements.agentGuardFeedback) elements.agentGuardFeedback.textContent = toolMode === "restricted"
    ? "已新建受限研究对话；外部 MCP / Apps 关闭，原对话与历史保留。"
    : "已请求新建完整工具对话；工具是否可用以本对话的只读核验结果为准，原对话保留。";
  await loadAgentCapabilities();
}

async function switchAgentSession(event) {
  const nextId = String(event.target.value || "");
  const previousId = state.activeSessionId;
  if (!nextId || nextId === previousId || !(api.agentSessions?.open || api.agentSessions?.switch)) return;
  await openAgentSession(nextId, { previousId });
}

async function openAgentSession(nextId, { previousId = state.activeSessionId, force = false } = {}) {
  if (!nextId || state.sessionsLoading || !(api.agentSessions?.open || api.agentSessions?.switch)) return;
  if (!force && String(nextId) === String(state.activeSessionId ?? "")) {
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
      scope: state.portfolio ? "position" : "chat",
      candidateSymbol: "",
      riskBudget: "0.8",
      reviewContext: null,
      researchContext: null,
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

function mergeReviewSessionContext(persistedBinding, lastRunContext) {
  if (!persistedBinding) return lastRunContext ?? null;
  if (!lastRunContext || persistedBinding.reviewProtocol !== lastRunContext.reviewProtocol) {
    return persistedBinding;
  }
  // The persisted thread binding is authoritative for the evidence identity.
  // Last-run context may add display metadata, but must never roll the binding
  // back to an older evidence revision, retrospective version, or input hash.
  return {
    ...lastRunContext,
    ...persistedBinding,
  };
}

function renderOpenedSession(payload) {
  const threadId = String(payload?.activeSessionId ?? payload?.currentThreadId ?? state.activeSessionId ?? "");
  const view = ensureSessionView(threadId);
  const researchContext = payload?.session?.researchContext ?? payload?.researchContext ?? null;
  if (researchContext?.researchThesisId) {
    view.scope = "chat";
    view.researchContext = { researchThesisId: researchContext.researchThesisId };
  }
  if (Array.isArray(payload?.transcript)) view.transcript = payload.transcript;
  const persistedReviewContext = payload?.session?.reviewContext ?? payload?.reviewContext ?? null;
  let persistedReviewBinding = null;
  if (persistedReviewContext?.reviewProtocol) {
    view.scope = "review";
    persistedReviewBinding = persistedReviewContext.reviewProtocol === "decision_cycle"
      ? {
        reviewProtocol: "decision_cycle",
        reviewCycleId: persistedReviewContext.reviewCycleId ?? null,
        reviewPhase: normalizeReviewPhase(persistedReviewContext.reviewPhase),
        reviewEvidenceRevision: persistedReviewContext.reviewEvidenceRevision ?? null,
        reviewRetrospectiveVersion: persistedReviewContext.reviewRetrospectiveVersion ?? null,
        reviewInputSnapshotHash: persistedReviewContext.reviewInputSnapshotHash ?? null,
      }
      : {
        reviewProtocol: "earnings_case",
        reviewCaseIds: Array.isArray(persistedReviewContext.reviewCaseIds)
          ? persistedReviewContext.reviewCaseIds
          : [],
      };
    view.reviewContext = persistedReviewBinding;
  }
  if (payload?.lastAgentResult?.run) {
    view.lastAgentResult = payload.lastAgentResult;
    const lastRun = payload.lastAgentResult.run;
    if (lastRun.context?.scope === "chat" && lastRun.context?.researchThesisId) {
      view.scope = "chat";
      view.researchContext = { researchThesisId: lastRun.context.researchThesisId,
        name: lastRun.context.researchTitle ?? null };
    }
    if (lastRun.context?.scope === "review") {
      view.scope = "review";
      if (lastRun.context.reviewProtocol === "decision_cycle") {
        view.reviewContext = mergeReviewSessionContext(persistedReviewBinding, {
          reviewProtocol: "decision_cycle",
          reviewCycleId: lastRun.context.reviewCycleId ?? null,
          reviewPhase: normalizeReviewPhase(lastRun.context.reviewPhase),
          cycleType: lastRun.context.cycleType ?? null,
        });
      } else {
        const quarters = [...new Set((lastRun.analysisContext?.cases ?? [])
          .map((item) => String(item?.fiscalQuarter ?? "").trim())
          .filter(Boolean))];
        view.reviewContext = mergeReviewSessionContext(persistedReviewBinding, {
          reviewProtocol: "earnings_case",
          reviewCaseIds: lastRun.context.reviewCaseIds ?? [],
          fiscalQuarter: quarters.length === 1 && lastRun.context.reviewMode === "single_event"
            ? quarters[0]
            : null,
          reviewMode: lastRun.context.reviewMode ?? null,
        });
      }
    }
  }
  resetAgentConversation();
  restoreSessionComposer(view);

  const latestBody = String(view.lastAgentResult?.run?.conclusion?.body ?? "").trim();
  const transcript = [...view.transcript];
  if (latestBody && transcript.at(-1)?.role === "assistant"
    && sameConversationText(transcript.at(-1).text, latestBody)) transcript.pop();
  for (const entry of transcript) {
    if (entry?.role === "assistant" && view.unverifiedPartial?.text
      && sameConversationText(entry.text, view.unverifiedPartial.text)) continue;
    appendTranscriptEntry(entry);
  }

  restoreSessionAgentResult({
    ...payload,
    activeSessionId: threadId,
    lastAgentResult: view.lastAgentResult,
  });
  if (view.unverifiedPartial) renderUnverifiedAgentPartial(view.unverifiedPartial);
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
  return a === b;
}

function markLatestThreadOperation(operation) {
  const threadId = String(operation?.threadId ?? "").trim();
  const operationId = String(operation?.operationId ?? "").trim();
  if (!threadId || !operationId) return false;
  const startedAtMs = Number.isFinite(Number(operation?.startedAtMs))
    ? Number(operation.startedAtMs)
    : Date.parse(String(operation?.startedAt ?? "")) || Date.now();
  const previous = state.latestOperationByThread.get(threadId);
  if (previous && previous.operationId !== operationId
    && Number(previous.startedAtMs ?? 0) > startedAtMs) return false;
  state.latestOperationByThread.set(threadId, { operationId, startedAtMs });
  return true;
}

function isLatestThreadOperation(threadId, operationId) {
  const latest = state.latestOperationByThread.get(String(threadId ?? ""));
  return !latest || latest.operationId === String(operationId ?? "");
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
  const scope = ["chat", "position", "candidate", "portfolio", "review"].includes(view.scope)
    ? view.scope
    : state.portfolio ? "position" : "chat";
  state.analysisScope = scope;
  state.candidateSymbol = view.candidateSymbol ?? "";
  document.querySelectorAll(".scope-segmented [data-scope]").forEach((button) => {
    button.setAttribute("aria-checked", String(button.dataset.scope === scope));
  });
  elements.candidateSymbolField.hidden = scope !== "candidate";
  elements.candidateSymbol.value = state.candidateSymbol;
  elements.riskBudget.value = view.riskBudget || "0.8";
  elements.agentInput.value = view.draft || "";
  if (scope === "review") renderReviewAgentContext(view.reviewContext ?? {});
  else renderAgentContext();
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
      startedAt: active?.startedAt ?? null,
      startedAtMs: Date.parse(String(active?.startedAt ?? "")) || Date.now(),
      status: "running",
      progress: "后台 Codex 分析仍在运行",
      task: String(active?.task ?? ""),
      streamText: "",
      finalText: "",
      streamBuffers: new Map(),
      streamOrder: [],
      toolEvents: new Map(),
    };
    if (!markLatestThreadOperation(operation)) continue;
    state.operations.set(operationId, operation);
    scheduleAgentResultRecovery(operation, 5_000);
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
  if (!["chat", "position", "candidate", "portfolio"].includes(scope) || scope === state.analysisScope) return;
  if (ensureSessionView(state.activeSessionId).researchContext?.researchThesisId) {
    setSystemMessage("这条对话绑定研究主线。持仓或候选分析请新建对话；当前研究和历史会保留。", "warning");
    return;
  }
  state.analysisScope = scope;
  const view = ensureSessionView(state.activeSessionId);
  view.scope = scope;
  view.reviewContext = null;
  document.querySelectorAll(".scope-segmented [data-scope]").forEach((button) => {
    button.setAttribute("aria-checked", String(button.dataset.scope === scope));
  });
  elements.candidateSymbolField.hidden = scope !== "candidate";
  invalidateAgentRuns();
  renderAgentContext();
  syncTechnicalLinkageEditorFromContext();
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
  const forceReauthorize = state.longbridgeReauthRequired;
  setBusy(true);
  setSystemMessage("将在系统浏览器中打开长桥 OAuth；仅请求账户、持仓、历史订单与成交查询权限，不含下单");
  try {
    const result = await api.connectLongbridge({ forceReauthorize });
    if (result.cancelled) {
      setSystemMessage("已取消长桥只读重新授权", "warning");
      return;
    }
    if (!result.ok) {
      setSystemMessage(
        result.status?.detail || result.status?.message || result.error || "长桥连接失败",
        "error",
      );
    } else if (result.warning) {
      setSystemMessage(`长桥只读授权已完成；${result.warning}`, "warning");
    }
  } catch (error) {
    setSystemMessage(error.message || "长桥连接失败", "error");
  } finally {
    setBusy(false);
  }
}

function brokerName(value) {
  return ({ all: "全部账户", longbridge: "长桥", ibkr: "IBKR", multiple: "长桥 + IBKR" })[value] ?? "";
}

function bindBrokerControls() {
  $("#broker-tabs")?.addEventListener("click", (event) => {
    const scope = event.target.closest("[data-broker-scope]")?.dataset.brokerScope;
    if (!scope || scope === state.brokerScope) return;
    state.brokerScope = scope;
    invalidateAgentRuns("账户范围已切换；运行中的任务仍使用发送时的账户快照。", { preserveActiveRequest: true });
    setBrokers(state.brokers);
    if (scope === "ibkr" && !state.brokers?.views?.ibkr) $("#ibkr-setup").open = true;
  });
  $("#broker-overview")?.addEventListener("click", (event) => {
    const broker = event.target.closest("[data-refresh-broker]")?.dataset.refreshBroker;
    if (broker) refreshBrokerScope(broker);
  });
  $("#ibkr-login")?.addEventListener("click", async () => {
    try { await api.brokers.loginIbkr({ transport: $("#ibkr-transport").value, port: $("#ibkr-port").value }); }
    catch (error) { $("#ibkr-setup-message").textContent = error.message; }
  });
  $("#ibkr-transport")?.addEventListener("change", () => {
    $("#ibkr-port").value = $("#ibkr-transport").value === "tws" ? 7496 : 5001;
    $("#ibkr-account").innerHTML = '<option value="">先检查连接</option>';
    renderIbkrTransport();
  });
  const configure = () => ({ transport: $("#ibkr-transport").value, port: Number($("#ibkr-port").value),
    accountId: $("#ibkr-account").value, trustLocalCertificate: $("#ibkr-trust").checked, enabled: true });
  $("#ibkr-discover")?.addEventListener("click", async () => {
    await withIbkrSetup(async () => {
      setBrokers(await api.brokers.configureIbkr(configure()));
      const result = await api.brokers.discoverIbkr(); setBrokers(result.brokers);
      if (!result.ok) throw new Error(result.error);
      $("#ibkr-setup-message").textContent = "连接成功。确认下方账户后，点击“保存并同步”。";
    });
  });
  $("#ibkr-sync")?.addEventListener("click", async () => {
    await withIbkrSetup(async () => {
      if (!$("#ibkr-account").value) throw new Error("请先检查连接并选择账户。");
      setBrokers(await api.brokers.configureIbkr(configure()));
      const result = await api.brokers.refresh("ibkr"); setBrokers(result.brokers);
      if (!result.ok) throw new Error(result.results?.find((r) => !r.ok)?.error ?? "IBKR 同步失败");
      $("#ibkr-setup-message").textContent = "真实持仓已同步；行情权限和延迟状态请展开持仓查看。";
      $("#ibkr-setup").open = false;
    });
  });
  $("#ibkr-disconnect")?.addEventListener("click", async () => {
    await withIbkrSetup(async () => {
      if (!window.confirm("从驾驶舱移除 IBKR 接入和当前持仓缓存？不会退出 IBKR 客户端或改变账户。")) return;
      setBrokers(await api.brokers.configureIbkr({ ...configure(), enabled: false, accountId: "" }));
      $("#ibkr-setup-message").textContent = "已移除当前 IBKR 缓存；可重新连接恢复。";
    });
  });
}

async function withIbkrSetup(work) {
  const buttons = [...document.querySelectorAll(".ibkr-actions button")];
  buttons.forEach((b) => { b.disabled = true; });
  $("#ibkr-setup-message").textContent = "正在读取本机 IBKR 客户端…";
  try { await work(); } catch (error) { $("#ibkr-setup-message").textContent = error.message; }
  finally { buttons.forEach((b) => { b.disabled = false; }); }
}

function renderIbkrTransport() {
  const tws = $("#ibkr-transport").value === "tws";
  $("#ibkr-login").textContent = tws ? "打开 TWS" : "打开登录页";
  $("#ibkr-trust").closest("label").hidden = tws;
  $("#ibkr-connection-help").textContent = tws
    ? "复用已登录的 Trader Workstation。启用 Socket API、保留只读 API。实盘常用 7496，模拟盘 7497；IB Gateway 常用 4001/4002。"
    : "启动本机 Client Portal Gateway，在 IBKR 页面登录；端口以网关配置为准。Mac 的 5000 可能被系统占用，5001 是备选值。";
}

function setBrokers(value) {
  if (!value?.views) return;
  state.brokers = value;
  const ib = value.ibkr;
  if (ib && !$("#ibkr-port").dataset.loaded) {
    $("#ibkr-port").value = ib.config.port;
    $("#ibkr-port").dataset.loaded = "true";
    $("#ibkr-trust").checked = ib.config.trustLocalCertificate;
    $("#ibkr-transport").value = ib.config.transport ?? "gateway";
    renderIbkrTransport();
  }
  const select = $("#ibkr-account");
  const selected = select.value || ib?.config.accountId;
  const accounts = ib?.accounts?.length ? ib.accounts : ib?.config.accountId
    ? [{ id: ib.config.accountId, label: "已保存账户（检查连接可重选）" }] : [];
  select.innerHTML = accounts.length
    ? accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}${a.currency ? ` · ${esc(a.currency)}` : ""}</option>`).join("")
    : '<option value="">先检查连接</option>';
  if (accounts.some((a) => a.id === selected)) select.value = selected;
  $("#ibkr-connection-state").textContent = ({ connected: "已连接", syncing: "同步中", error: "连接待检查" })[ib?.state] ?? "未连接";
  document.querySelectorAll("[data-broker-scope]").forEach((node) => node.setAttribute("aria-pressed", String(node.dataset.brokerScope === state.brokerScope)));
  renderBrokerOverview();
  setPortfolio(value.views[state.brokerScope] ?? null);
  if (!state.portfolio) {
    elements.accountCard.innerHTML = `<div class="account-empty"><strong>${state.brokerScope === "ibkr" ? "等待 IBKR 持仓" : "尚无真实持仓"}</strong><p>${state.brokerScope === "ibkr" ? "展开上方连接设置，启动并登录 TWS 或备用网关后同步。" : "可连接长桥或 IBKR；真实数据同步后显示。"}</p></div>`;
  }
}

function renderBrokerOverview() {
  if (!state.brokers) return;
  $("#broker-overview").innerHTML = ["longbridge", "ibkr"].map((broker) => {
    const p = state.brokers.views[broker];
    const syncing = state.brokerBusy.has(broker) || broker === "ibkr" && state.brokers.ibkr?.syncing;
    const fresh = p ? portfolioTrustSnapshot(p) : null;
    const status = syncing ? "同步中" : !p ? "未同步" : fresh.state === "cached" ? "缓存" : fresh.state === "stale" ? "待刷新" : "已同步";
    return `<div class="broker-summary-row"><span>${brokerName(broker)}</span><div><strong>${p ? money(p.account.netAssets, "USD") : "—"}</strong><small>${status}${p ? ` · 现金 ${percent(p.totals.cashRatio)}` : ""}</small></div><button type="button" data-refresh-broker="${broker}" ${syncing ? "disabled" : ""} aria-label="刷新${brokerName(broker)}持仓">↻</button></div>`;
  }).join("");
}

async function refreshBrokerScope(scope) {
  const brokers = scope === "all" ? ["longbridge", ...(state.brokers?.ibkr?.config.enabled ? ["ibkr"] : [])] : [scope];
  if (brokers.some((b) => state.brokerBusy.has(b))) return;
  if (scope === "ibkr" && !state.brokers?.ibkr?.config.enabled) {
    $("#ibkr-setup").open = true;
    $("#ibkr-setup-message").textContent = "请先启动并登录 TWS 或备用网关，再检查连接。";
    return;
  }
  brokers.forEach((b) => state.brokerBusy.add(b)); renderBrokerOverview();
  try {
    const result = await api.brokers.refresh(scope); setBrokers(result.brokers);
    const errors = result.results?.filter((r) => !r.ok).map((r) => `${brokerName(r.broker)}：${r.error}`) ?? [];
    setSystemMessage(errors.length ? errors.join("；") : `${brokerName(scope)}持仓已更新`, errors.length ? "error" : "normal");
  } catch (error) { setSystemMessage(error.message, "error"); }
  finally { brokers.forEach((b) => state.brokerBusy.delete(b)); renderBrokerOverview(); }
}

function renderBrokerAccountCard(portfolio) {
  const noteOpen = elements.accountCard.querySelector(".broker-account-note")?.open === true;
  const account = portfolio.account;
  const trust = portfolioTrustSnapshot(portfolio);
  const missing = portfolio.missingBrokers ?? [];
  elements.snapshotState.textContent = missing.length ? "PARTIAL" : trust.label;
  elements.snapshotState.className = `snapshot-state ${trust.className}`;
  elements.snapshotState.title = `${brokerName(state.brokerScope)}账户快照 ${trust.timestampLabel} · ${trust.ageLabel} · ${portfolioFxLabel(portfolio)} · 汇总仅供研究，不是统一实时执行校验`;
  elements.accountCard.classList.add("broker-account-card");
  const cash = money(account.totalCash, "USD");
  elements.accountCard.innerHTML = `<div class="account-top"><div><span>${missing.length ? "汇总未完整" : "净资产 / USD"}</span><strong>${money(account.netAssets, "USD")}</strong></div><small>${esc(brokerName(state.brokerScope))} · ${esc(trust.ageLabel)}${missing.length ? ` · 缺少${esc(missing.map(brokerName).join("、"))}` : ""}</small></div>
    <div class="metric-grid"><div><span>现金 / USD</span><strong>${cash}</strong></div><div><span>${state.brokerScope === "ibkr" ? "IBKR 购买力" : "购买力"}</span><strong>${state.brokerScope === "ibkr" ? money(account.buyPower, "USD") : "分账户查看"}</strong></div></div>
    <details class="broker-account-note" ${noteOpen ? "open" : ""}><summary>估值口径 · 研究用，未完成执行校验</summary>${state.brokerScope === "ibkr" ? "账户估值与实时行情分开。展开期权查看报价、延迟状态与 Greeks。" : "同一股票合并市值，多空敞口分别保留；资金与保证金不跨券商抵扣。"}<p>${esc(portfolioFxLabel(portfolio))}。各券商 USD 值只汇总一次；来源时间不等于实时行情。</p></details>`;
}

function brokerPositionDetails(position, open) {
  const legs = position.brokerLegs ?? [];
  if (legs.length < 2 && position.broker !== "ibkr") return "";
  const availability = (value) => ({ realtime: "实时", delayed: "延迟", frozen: "冻结收盘", frozen_delayed: "冻结延迟", not_subscribed: "未订阅", incomplete: "不完整" })[value] ?? "状态未知";
  const option = position.option;
  const md = position.marketData;
  return `<details class="broker-position-details" data-position="${esc(position.positionId ?? position.symbol)}" ${open ? "open" : ""}><summary>${option ? "期权报价与 Greeks" : "账户明细与来源"}${position.hasOffsettingLegs ? " · 跨账户多空" : ""}</summary>
    ${legs.map((leg) => `<div class="broker-leg">${esc(leg.label)} · ${number(leg.quantity)}${position.instrumentType === "option" ? " 张" : " 股"}<br />成本 ${price(leg.costPrice, leg.currency)} · 市值 ${money(leg.marketValueBase, "USD")}<br />账户同步 ${esc(leg.syncedAt ? new Date(leg.syncedAt).toLocaleString() : "未知")}</div>`).join("")}
    ${md ? `<div class="broker-leg">行情：${availability(md.availability)} · ${md.observedAt ? esc(new Date(md.observedAt).toLocaleString()) : "未返回更新时间"}<br />Bid ${price(md.bid, position.currency)} / Ask ${price(md.ask, position.currency)}<br />Last ${price(md.last, position.currency)}${md.lastPrefix === "C" ? "（昨收）" : md.lastPrefix === "H" ? "（停牌）" : ""}</div>` : ""}
    ${option ? `<div class="broker-leg">${esc(option.expiry ?? "到期待核验")} · ${esc(option.right ?? "方向待核验")} ${number(option.strike)} · 乘数 ${number(option.multiplier)}</div><div class="broker-option-grid">${[["Delta", option.delta], ["Gamma", option.gamma], ["Theta", option.theta], ["Vega", option.vega], ["IV %", option.ivPercent], ["OI", option.openInterest]].map(([label, value]) => `<span>${label} <strong>${number(value, 4)}</strong></span>`).join("")}</div><p>Greeks 为 IBKR 报价单位值，不是组合汇总风险；缺失保持 —。市值为权利金，不等于标的名义敞口。</p>` : ""}
  </details>`;
}

async function refreshPortfolio() {
  if (api.brokers) return refreshBrokerScope(state.brokerScope);
  if (state.busy) return;
  setBusy(true);
  try {
    const result = await api.refreshPortfolio();
    if (!result.ok) {
      setSystemMessage(
        result.status?.detail || result.status?.message || result.error || "持仓同步失败",
        "error",
      );
    }
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
    invalidateAgentRuns("账户快照已更新，旧结论仅保留用于回看。", {
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
  syncTechnicalLinkageEditorFromContext();
}

function renderPortfolio() {
  const portfolio = state.portfolio;
  if (!portfolio) {
    clearPortfolioUI();
    return;
  }

  renderPortfolioTrustUi(portfolio);
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

function renderPortfolioTrustUi(portfolio = state.portfolio) {
  if (!portfolio) return;
  if (portfolio.brokerScope === "ibkr" || portfolio.brokerAccounts?.length > 1 || portfolio.missingBrokers?.length) {
    renderBrokerAccountCard(portfolio);
    return;
  }
  elements.accountCard.classList.remove("broker-account-card");
  const previousIssues = elements.accountCard.querySelector(".portfolio-data-issues");
  const issuesOpen = previousIssues?.open === true;
  const issuesScrollTop = previousIssues?.querySelector(".portfolio-data-issues-body")?.scrollTop ?? 0;
  const account = portfolio.account;
  const trust = portfolioTrustSnapshot(portfolio);
  const marks = portfolioMarkRange(portfolio);
  const valuationGate = portfolioValuationGateView(portfolio);
  elements.snapshotState.textContent = trust.label;
  elements.snapshotState.className = `snapshot-state ${trust.className}`;
  elements.snapshotState.title = `账户快照 ${trust.timestampLabel} · 年龄 ${trust.ageLabel} · 行情标记 ${marks.label} · ${valuationGate.detail}`;
  const fxStatus = portfolio.dataQuality?.fxStatus ?? "unavailable";
  const fxAvailable = ["live", "reference", "reference_cached", "not_required"].includes(fxStatus);
  const fxReference = ["reference", "reference_cached"].includes(fxStatus);
  const fxLabel = fxReference
    ? `${portfolio.fx?.providerCode ?? "ECB"} ${portfolio.fx?.asOf ?? "最新"} 参考汇率${fxStatus === "reference_cached" ? "（缓存）" : ""}`
    : fxStatus === "live" || fxStatus === "not_required"
      ? fxStatus === "not_required" ? "USD 单币种，无需换算" : "长桥账户汇率"
      : "汇率不可用";
  const accountSummary = trust.state === "cached"
    ? "本地加密缓存 · 只供回看"
    : trust.state === "stale"
      ? "持仓快照已过期 · 禁止据此新增风险"
    : trust.state === "unknown"
        ? "持仓快照状态未知 · 先刷新再评估仓位"
    : !trust.freshForSizing
      ? "账户与持仓数量已同步 · 报价或估值待核验"
    : !fxAvailable
      ? "已同步持仓 · 汇率降级，跨币种估值暂停"
      : fxReference
        ? `已同步持仓 · USD 估值 · ${fxLabel}`
      : portfolio.status === "degraded"
        ? `已同步持仓 · ${number(portfolio.totals.unpricedPositionCount, 0)} 项待估值`
        : `已同步账户快照与完整估值 · ${fxLabel}`;
  elements.accountCard.innerHTML = `
    <div class="account-top">
      <div><span>净资产 / ${esc(account.baseCurrency)}</span><strong>${money(account.netAssets, account.baseCurrency)}</strong></div>
      <small>${esc(accountSummary)}</small>
    </div>
    <div class="data-passport ${esc(trust.className)} gate-${esc(valuationGate.status)}">
      <span>SNAPSHOT ${esc(trust.timestampLabel)}</span>
      <span>AGE ${esc(trust.ageLabel)}</span>
      <span>MARKS ${esc(marks.label)}</span>
      <span>GATE ${esc(valuationGate.status.toUpperCase())}</span>
      <strong>${trust.freshForSizing
        ? "账户、逐标的报价与估值校验通过"
        : trust.state !== "fresh"
          ? "当前是过期或缓存快照，请刷新持仓"
          : `仓位测算暂停 · ${esc(valuationGate.shortReason)}`}</strong>
      ${valuationGate.issues.length ? `
        <details class="portfolio-data-issues" ${issuesOpen ? "open" : ""}>
          <summary>查看原因与处理方式（${valuationGate.issues.length}）</summary>
          <div class="portfolio-data-issues-body">
            <p>同步成功不代表行情完整。仍可查看真实持仓与研究候选标的；完整仓位及杠杆测算需先补齐以下证据。</p>
            <ul>${valuationGate.issues.map((issue) => `<li>${esc(issue)}</li>`).join("")}</ul>
          </div>
        </details>` : ""}
    </div>
    <div class="metric-grid">
      <div><span>现金</span><strong>${money(account.totalCash, account.baseCurrency)}</strong></div>
      <div><span>购买力</span><strong>${money(account.buyPower, account.baseCurrency)}</strong></div>
      <div><span>风险等级</span><strong>${esc(account.riskLevel)}</strong></div>
    </div>`;
  const issuesBody = elements.accountCard.querySelector(".portfolio-data-issues-body");
  if (issuesBody) issuesBody.scrollTop = issuesScrollTop;
}

function refreshPortfolioTrustUi() {
  if (!state.portfolio) return;
  renderBrokerOverview();
  renderPortfolioTrustUi(state.portfolio);
  renderAgentContext();
  refreshCurrentRunTrustUi();
}

function portfolioTrustSnapshot(portfolio, now = Date.now()) {
  const declaredState = String(portfolio?.freshness?.state ?? "").toLowerCase();
  const syncedAtMs = Date.parse(String(portfolio?.syncedAt ?? ""));
  const assessedAtMs = Date.parse(String(portfolio?.freshness?.assessedAt ?? ""));
  const measuredAge = Number.isFinite(syncedAtMs)
    ? Math.max(0, now - syncedAtMs)
    : Number.isFinite(Number(portfolio?.freshness?.ageMs))
      ? Math.max(
        0,
        Number(portfolio.freshness.ageMs)
          + (Number.isFinite(assessedAtMs) ? Math.max(0, now - assessedAtMs) : 0),
      )
      : null;
  const maxAgeMs = Number.isFinite(Number(portfolio?.freshness?.maxAgeMs))
    ? Number(portfolio.freshness.maxAgeMs)
    : LEGACY_PORTFOLIO_MAX_AGE_MS;
  let trustState = ["fresh", "stale", "cached", "unknown"].includes(declaredState)
    ? declaredState
    : portfolio?.status === "cached"
      ? "cached"
      : portfolio?.status === "stale"
        ? "stale"
        : ["live", "degraded"].includes(portfolio?.status)
          ? measuredAge == null
            ? "unknown"
            : measuredAge <= maxAgeMs ? "fresh" : "stale"
          : "unknown";
  if (trustState === "fresh" && measuredAge != null && measuredAge > maxAgeMs) {
    trustState = "stale";
  }
  const display = {
    fresh: { label: "SYNCED", className: "synced" },
    stale: { label: "STALE", className: "stale" },
    cached: { label: "CACHED", className: "cached" },
    unknown: { label: "UNKNOWN", className: "unknown" },
  }[trustState];
  return {
    state: trustState,
    ...display,
    ageMs: measuredAge,
    ageLabel: formatSnapshotAge(measuredAge),
    timestampLabel: portfolio?.syncedAt ? shortDateTime(portfolio.syncedAt) : "未知",
    freshForSizing: trustState === "fresh" && portfolio?.freshness?.freshForSizing === true,
  };
}

function portfolioValuationGateView(portfolio) {
  const outcome = portfolio?.valuationGate?.outcome;
  const status = ["pass", "degraded", "block"].includes(String(outcome?.status))
    ? String(outcome.status)
    : "missing";
  const codes = Array.isArray(outcome?.reasonCodes) ? outcome.reasonCodes : [];
  const labels = {
    quote_stale_active_session: "存在过期行情",
    quote_timestamp_missing: "存在报价时间缺口",
    quote_older_than_latest_completed_session: "存在落后于最近收盘的行情",
    cross_symbol_quote_skew_exceeded: "持仓报价时间差过大",
    net_asset_reconciliation_failed: "净资产勾稽失败",
    net_asset_reconciliation_degraded: "净资产勾稽存在差异",
    position_native_market_value_mismatch: "持仓市值与价格数量不一致",
    position_market_value_base_missing: "持仓折算市值缺失",
    reconciliation_position_values_missing: "持仓市值不完整，暂不能核对组合净值",
    option_contract_multiplier_missing: "期权乘数缺失",
    position_valuation_unpriced: "存在未定价持仓",
    account_sync_expired: "账户同步已过期",
    portfolio_valuation_completeness_failed: "组合估值证据不完整",
    account_valuation_incomplete: "账户估值字段不完整",
    quote_price_missing: "报价缺失",
    quote_price_zero: "报价为零，不能用于仓位测算",
    quote_price_negative: "报价异常",
    quote_timestamp_in_future: "报价时间异常",
    quote_missing_current_trading_session: "缺少本交易时段行情",
    active_session_quote_session_mismatch: "报价交易时段不匹配",
    reconciliation_missing_position_values: "部分持仓市值未能核验",
  };
  const labelFor = (code) => labels[code] ?? `其他估值校验异常（${code}）`;
  const reasons = codes.map(labelFor);
  const quoteErrors = (portfolio?.dataQuality?.quoteErrors ?? []).map(String);
  const permissionErrors = quoteErrors.filter((error) => /301604|no quote access|OPRA.*permission/i.test(error));
  const issues = [...new Set([
    ...permissionErrors.map((error) => {
      const symbol = error.split(":")[0].trim();
      return `${symbol} 行情权限不足：长桥未授权此合约/市场的 API 行情。请在长桥核对行情订阅及 OpenAPI 权限；反复刷新或重新登录不能补齐该权限。`;
    }),
    ...quoteErrors.filter((error) => !permissionErrors.includes(error)),
    ...(portfolio?.positions ?? [])
      .filter((position) => position.valuationLimitation
        && !quoteErrors.some((error) => error.startsWith(`${position.symbol}:`)))
      .map((position) => String(position.valuationLimitation)),
  ])];
  // Present the actionable source failure first, not the umbrella gate code.
  const hasSourceIssue = issues.length > 0;
  const genericCodes = new Set(["portfolio_valuation_completeness_failed", "position_valuation_unpriced",
    "quote_price_missing", "quote_timestamp_missing", "option_contract_multiplier_missing"]);
  const gateIssues = portfolio?.valuationGate?.issues ?? [];
  issues.push(...new Set(gateIssues.length
    ? gateIssues.filter((issue) => !hasSourceIssue || !genericCodes.has(issue.code))
      .map((issue) => `${issue.symbol ? `${issue.symbol} · ` : ""}${labelFor(issue.code)}`)
    : hasSourceIssue ? [] : reasons));
  return {
    status,
    label: status === "pass"
      ? "报价与估值校验通过"
      : status === "degraded"
        ? "报价或估值校验降级"
        : status === "block"
          ? "报价或估值校验未通过"
          : "缺少报价与估值校验",
    shortReason: permissionErrors.length
      ? `${permissionErrors[0].split(":")[0].trim()} 行情权限不足`
      : issues[0] ?? (status === "pass" ? "通过" : "证据不完整"),
    detail: issues.length ? issues.join("\n") : status === "pass" ? "逐标的报价与账户估值一致" : "缺少可核验原因",
    issues,
  };
}

function formatSnapshotAge(ageMs) {
  if (!Number.isFinite(ageMs)) return "未知";
  if (ageMs < 5_000) return "刚刚";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}秒`;
  if (ageMs < 60 * 60_000) return `${Math.floor(ageMs / 60_000)}分钟`;
  if (ageMs < 24 * 60 * 60_000) return `${Math.floor(ageMs / (60 * 60_000))}小时`;
  return `${Math.floor(ageMs / (24 * 60 * 60_000))}天`;
}

function portfolioMarkRange(portfolio) {
  const timestamps = [
    portfolio?.quoteAsOf,
    portfolio?.quoteLatestAsOf,
    ...(portfolio?.positions ?? []).map((position) => position?.quoteTimestamp),
  ]
    .map((value) => {
      const timestamp = Date.parse(String(value ?? ""));
      return Number.isFinite(timestamp) ? timestamp : null;
    })
    .filter((value) => value != null)
    .sort((left, right) => left - right);
  if (!timestamps.length) {
    return { oldestAt: null, latestAt: null, label: "UNKNOWN" };
  }
  const oldestAt = new Date(timestamps[0]).toISOString();
  const latestAt = new Date(timestamps.at(-1)).toISOString();
  return {
    oldestAt,
    latestAt,
    label: oldestAt === latestAt
      ? shortDateTime(oldestAt)
      : `${shortDateTime(oldestAt)} → ${shortDateTime(latestAt)}`,
  };
}

function refreshCurrentRunTrustUi() {
  const runNodes = [...elements.agentThread.querySelectorAll(".agent-run[data-run-id]")];
  if (!runNodes.length) return;
  const scrollTop = elements.agentThread.scrollTop;
  const distanceFromBottom = elements.agentThread.scrollHeight
    - elements.agentThread.clientHeight
    - scrollTop;
  for (const currentNode of runNodes) {
    const run = state.runsById.get(String(currentNode.dataset.runId));
    if (!run) continue;
    const stale = isRunStale(run);
    const sizingExpired = candidateSizingExpired(run.risk);
    if (currentNode.dataset.stale === String(stale)
      && currentNode.dataset.sizingExpired === String(sizingExpired)) continue;
    const evidenceWasOpen = currentNode.querySelector(".structured-evidence")?.open === true;
    const replacement = renderAgentRun(run, { stale });
    const nextEvidence = replacement.querySelector(".structured-evidence");
    if (nextEvidence) nextEvidence.open = evidenceWasOpen;
    currentNode.replaceWith(replacement);
  }
  if (distanceFromBottom <= 24) {
    elements.agentThread.scrollTop = elements.agentThread.scrollHeight;
  } else {
    elements.agentThread.scrollTop = scrollTop;
  }
}

function clearPortfolioUI() {
  elements.snapshotState.textContent = "NO DATA";
  elements.snapshotState.className = "snapshot-state";
  elements.accountCard.innerHTML = `<div class="account-empty">
    <span class="empty-orbit" aria-hidden="true"></span>
    <strong>等待长桥授权</strong>
    <p>券商连接仅提供账户与行情查询；本机 Codex 工具权限独立管理。真实交易请到券商确认。</p>
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
    const previous = elements.agentThread.querySelector("[data-agent-invalidation]");
    if (previous) previous.querySelector("[data-invalidation-message]").textContent = message;
    else elements.agentThread.insertAdjacentHTML(
      "beforeend",
      `<div class="run-state" data-agent-invalidation><span class="evidence-dot degraded"></span><span data-invalidation-message>${esc(message)}</span></div>`,
    );
  }
}

function renderPositions() {
  const expanded = new Set([...elements.positionList.querySelectorAll(".broker-position-details[open]")].map((node) => node.dataset.position));
  const positions = state.portfolio?.positions ?? [];
  const filtered = positions.filter((position) =>
    !state.filter || `${position.symbol} ${position.name}`.toUpperCase().includes(state.filter),
  );
  elements.positionList.innerHTML = filtered.map((position) => {
    const selected = position.symbol === state.selectedSymbol;
    const changeClass = tone(position.changePercent);
    const pnlClass = tone(position.pnlPercent);
    const session = sessionLabel(position.quoteSession);
    const costAvailable = position.costBasisStatus !== "missing"
      && position.costPrice != null
      && position.costPrice !== ""
      && Number.isFinite(Number(position.costPrice));
    const costLimitation = String(position.costBasisLimitation
      ?? `${position.symbol} 的成本价未由长桥提供；市值与权重仍可查看，成本及盈亏不可据此判断。`);
    const costDisplay = costAvailable
      ? `<span>成本 ${number(position.costPrice)}</span>`
      : `<span class="cost-basis-missing" title="${esc(costLimitation)}" aria-label="${esc(costLimitation)}">成本 未提供</span>`;
    return `<button class="position-row ${selected ? "selected" : ""}" type="button" data-symbol="${esc(position.symbol)}" aria-pressed="${selected}">
      <span class="position-id"><i class="ticker">${esc(position.ticker.slice(0, 4))}</i><span><strong>${esc(position.ticker)}</strong><small>${esc(position.name)} <span class="broker-badge">${esc(brokerName(position.broker))}</span></small></span></span>
      <span class="position-price"><strong>${position.broker === "multiple" ? money(position.marketValueBase, "USD") : price(position.lastPrice, position.currency)}</strong><small class="${changeClass}">${position.broker === "multiple" ? "合计市值 · 分账户报价" : `${signedPercent(position.changePercent)}${session ? ` · ${esc(session)}` : ""}`}</small></span>
      <span class="position-meta"><span>Q ${number(position.quantity)}</span>${costDisplay}<span>权重 ${percent(position.weight)}</span><span class="${pnlClass}">${signedPercent(position.pnlPercent)}</span></span>
    </button>${brokerPositionDetails(position, expanded.has(position.positionId ?? position.symbol))}`;
  }).join("");
}

async function loadTechnicalRadar() {
  if (!api.technicalRadar?.snapshot || state.technicalRadarLoading) return;
  state.technicalRadarLoading = true;
  renderTechnicalRadar();
  try {
    const result = await api.technicalRadar.snapshot();
    setTechnicalRadar(result?.radar);
  } catch (error) {
    setTechnicalRadar({
      ...state.technicalRadar,
      running: false,
      lastError: error?.message || "技术雷达读取失败",
    });
  } finally {
    state.technicalRadarLoading = false;
    renderTechnicalRadar();
  }
}

function setTechnicalRadar(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const watchlist = value.watchlist && typeof value.watchlist === "object"
    ? value.watchlist
    : { items: [], revision: 0, updatedAt: null };
  const linkage = value.linkage && typeof value.linkage === "object"
    ? value.linkage
    : { profiles: [], revision: 0, updatedAt: null };
  state.technicalRadar = {
    schemaVersion: value.schemaVersion ?? null,
    running: value.running === true,
    lastError: value.lastError == null ? null : String(value.lastError),
    watchlist: {
      items: Array.isArray(watchlist.items) ? watchlist.items : [],
      revision: Number.isInteger(Number(watchlist.revision)) ? Number(watchlist.revision) : 0,
      updatedAt: watchlist.updatedAt ?? null,
    },
    linkage: {
      profiles: Array.isArray(linkage.profiles) ? linkage.profiles : [],
      revision: Number.isInteger(Number(linkage.revision)) ? Number(linkage.revision) : 0,
      updatedAt: linkage.updatedAt ?? null,
    },
    latestBatch: value.latestBatch && typeof value.latestBatch === "object"
      ? value.latestBatch
      : null,
  };
  if (!state.technicalLinkageDraft.dirty && !state.radarUi.settings) syncTechnicalLinkageEditorFromContext({ force: true });
  renderTechnicalRadar();
}

function toggleTechnicalRadar() {
  setPortfolioView(state.radarUi.view === "radar" ? "portfolio" : "radar");
}

function setPortfolioView(view) {
  const expanded = view === "radar";
  state.radarUi.view = expanded ? "radar" : "portfolio";
  elements.portfolioPane.classList.toggle("radar-focused", expanded);
  $("#portfolio-heading").textContent = expanded ? "技术雷达" : "真实账户";
  document.querySelectorAll("[data-portfolio-view]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.portfolioView === state.radarUi.view)));
  elements.technicalRadarToggle.setAttribute("aria-expanded", String(expanded));
  elements.technicalRadarBody.hidden = !expanded;
  elements.technicalRadar.classList.toggle("collapsed", !expanded);
  elements.technicalRadarToggle.querySelector(".technical-radar-chevron").textContent = "›";
  queueTvBoundsSync();
}

function setRadarSettings(open) {
  const key = state.radarUi.settings ? "settings" : "results";
  state.radarUi.scroll[key] = elements.technicalRadarBody.scrollTop;
  state.radarUi.settings = Boolean(open);
  renderTechnicalRadar();
  elements.technicalRadarBody.scrollTop = state.radarUi.scroll[open ? "settings" : "results"];
}

async function runTechnicalRadar() {
  if (!api.technicalRadar?.run || state.technicalRadar.running || state.technicalRadarLoading) return;
  state.technicalRadarLoading = true;
  state.radarUi.notice = null;
  renderTechnicalRadar();
  try {
    const result = await api.technicalRadar.run();
    setTechnicalRadar(result?.radar);
    setSystemMessage("技术雷达已按已完成日线更新");
  } catch (error) {
    setTechnicalRadar({
      ...state.technicalRadar,
      running: false,
      lastError: error?.message || "技术雷达扫描失败",
    });
    setSystemMessage(error?.message || "技术雷达扫描失败", "warning");
  } finally {
    state.technicalRadarLoading = false;
    renderTechnicalRadar();
  }
}

async function addTechnicalWatchlistSymbol(event) {
  event.preventDefault();
  const symbol = elements.technicalWatchlistSymbol.value.trim();
  if (!symbol || !api.technicalRadar?.addWatchlist || state.technicalRadarMutationBusy) return;
  state.technicalRadarMutationBusy = true;
  renderTechnicalRadar();
  try {
    const result = await api.technicalRadar.addWatchlist(symbol);
    elements.technicalWatchlistSymbol.value = "";
    if (result?.radar) setTechnicalRadar(result.radar);
    else await loadTechnicalRadar();
    state.radarUi.notice = `${normalizeCandidateSymbol(symbol)} 已加入自选，更新扫描后查看结果。`;
  } catch (error) {
    state.radarUi.notice = error?.message || "添加技术自选失败";
    setSystemMessage(error?.message || "添加技术自选失败", "warning");
  } finally {
    state.technicalRadarMutationBusy = false;
    renderTechnicalRadar();
  }
}

async function removeTechnicalWatchlistSymbol(symbol) {
  if (!symbol || !api.technicalRadar?.removeWatchlist || state.technicalRadarMutationBusy) return;
  state.technicalRadarMutationBusy = true;
  renderTechnicalRadar();
  try {
    const result = await api.technicalRadar.removeWatchlist(symbol);
    if (result?.radar) setTechnicalRadar(result.radar);
    else await loadTechnicalRadar();
    state.radarUi.notice = `${symbol} 已从自选移除；旧扫描结果保留到下次更新。`;
  } catch (error) {
    setSystemMessage(error?.message || "移除技术自选失败", "warning");
  } finally {
    state.technicalRadarMutationBusy = false;
    renderTechnicalRadar();
  }
}

function updateTechnicalLinkageDraft() {
  state.technicalLinkageDraft = {
    symbol: normalizeCandidateSymbol(elements.technicalLinkageSymbol.value),
    sectorSymbol: sanitizeCandidateSymbol(elements.technicalLinkageSector.value),
    peerSymbols: elements.technicalLinkagePeers.value.toUpperCase(),
    rationale: elements.technicalLinkageRationale.value,
    dirty: true,
  };
  state.technicalLinkageMessage = null;
  renderTechnicalLinkageEditor();
}

function syncTechnicalLinkageEditorFromContext({ force = false } = {}) {
  if (state.technicalLinkageBusy) return;
  if (state.radarUi.settings && !force) return;
  if (state.technicalLinkageDraft.dirty && !force) return;
  const symbol = state.analysisScope === "candidate"
    ? normalizeCandidateSymbol(state.candidateSymbol)
    : normalizeCandidateSymbol(state.selectedSymbol);
  if (!symbol) return;
  setTechnicalLinkageEditorSymbol(symbol, { force });
}

function setTechnicalLinkageEditorSymbol(value, { force = false, expand = false } = {}) {
  const symbol = normalizeCandidateSymbol(value);
  if (!force && symbol === normalizeCandidateSymbol(state.technicalLinkageDraft.symbol)) return;
  const previous = state.technicalLinkageDraft;
  if (previous.dirty && previous.symbol) state.technicalLinkageDrafts.set(previous.symbol, { ...previous });
  const profile = technicalLinkageProfile(symbol);
  state.technicalLinkageDraft = state.technicalLinkageDrafts.get(symbol) ?? {
    symbol,
    sectorSymbol: String(profile?.sectorSymbol ?? ""),
    peerSymbols: Array.isArray(profile?.peerSymbols) ? profile.peerSymbols.join(", ") : "",
    rationale: String(profile?.rationale ?? ""),
    dirty: false,
  };
  state.technicalLinkageMessage = null;
  if (expand) elements.technicalLinkageEditor.open = true;
  renderTechnicalLinkageEditor();
}

function technicalLinkageProfile(symbolValue) {
  const symbol = normalizeCandidateSymbol(symbolValue);
  const profiles = Array.isArray(state.technicalRadar.linkage?.profiles)
    ? state.technicalRadar.linkage.profiles
    : [];
  return profiles.find((profile) => normalizeCandidateSymbol(profile?.symbol) === symbol) ?? null;
}

function parseTechnicalLinkagePeers(value) {
  return [...new Set(String(value ?? "")
    .split(/[,，;；\s]+/)
    .map(normalizeCandidateSymbol)
    .filter(Boolean))];
}

async function confirmTechnicalLinkage(event) {
  event.preventDefault();
  if (!api.technicalRadar?.confirmLinkage || state.technicalLinkageBusy) return;
  const symbol = normalizeCandidateSymbol(state.technicalLinkageDraft.symbol);
  const sectorSymbol = normalizeCandidateSymbol(state.technicalLinkageDraft.sectorSymbol) || null;
  const peerSymbols = parseTechnicalLinkagePeers(state.technicalLinkageDraft.peerSymbols);
  if (!symbol) {
    state.technicalLinkageMessage = { tone: "error", text: "请先填写目标标的。" };
    renderTechnicalLinkageEditor();
    return;
  }
  if (!sectorSymbol && !peerSymbols.length) {
    state.technicalLinkageMessage = { tone: "error", text: "至少填写行业 ETF 或同行标的。" };
    renderTechnicalLinkageEditor();
    return;
  }
  if (peerSymbols.length > 5) {
    state.technicalLinkageMessage = { tone: "error", text: "同行标的最多 5 个。" };
    renderTechnicalLinkageEditor();
    return;
  }
  if (peerSymbols.length === 1) {
    state.technicalLinkageMessage = { tone: "error", text: "同行比较需要 2–5 个标的；也可以清空同行，只保留行业 ETF。" };
    renderTechnicalLinkageEditor();
    return;
  }
  state.technicalLinkageBusy = true;
  state.technicalLinkageMessage = { tone: "loading", text: "正在确认…" };
  state.technicalLinkageDraft = {
    ...state.technicalLinkageDraft,
    symbol,
    sectorSymbol: sectorSymbol ?? "",
    peerSymbols: peerSymbols.join(", "),
  };
  renderTechnicalLinkageEditor();
  try {
    const result = await api.technicalRadar.confirmLinkage({
      symbol,
      sectorSymbol,
      peerSymbols,
      rationale: state.technicalLinkageDraft.rationale.trim() || null,
    });
    if (result?.radar) setTechnicalRadar(result.radar);
    else await loadTechnicalRadar();
    state.technicalLinkageDraft.dirty = false;
    state.technicalLinkageDrafts.delete(symbol);
    setTechnicalLinkageEditorSymbol(symbol, { force: true });
    state.technicalLinkageMessage = { tone: "complete", text: "已由你确认" };
    setSystemMessage(`${symbol} 行业与同行映射已确认`);
  } catch (error) {
    state.technicalLinkageMessage = { tone: "error", text: error?.message || "联动映射确认失败" };
    setSystemMessage(error?.message || "联动映射确认失败", "warning");
  } finally {
    state.technicalLinkageBusy = false;
    renderTechnicalLinkageEditor();
  }
}

async function removeTechnicalLinkage() {
  const symbol = normalizeCandidateSymbol(state.technicalLinkageDraft.symbol);
  if (!symbol || !technicalLinkageProfile(symbol)
    || !api.technicalRadar?.removeLinkage || state.technicalLinkageBusy) return;
  state.technicalLinkageBusy = true;
  state.technicalLinkageMessage = { tone: "loading", text: "正在删除…" };
  renderTechnicalLinkageEditor();
  try {
    const result = await api.technicalRadar.removeLinkage(symbol);
    if (result?.radar) setTechnicalRadar(result.radar);
    else await loadTechnicalRadar();
    state.technicalLinkageDraft = {
      symbol,
      sectorSymbol: "",
      peerSymbols: "",
      rationale: "",
      dirty: false,
    };
    state.technicalLinkageDrafts.delete(symbol);
    state.technicalLinkageMessage = { tone: "complete", text: "映射已删除" };
    setSystemMessage(`${symbol} 技术联动映射已删除`);
  } catch (error) {
    state.technicalLinkageMessage = { tone: "error", text: error?.message || "联动映射删除失败" };
    setSystemMessage(error?.message || "联动映射删除失败", "warning");
  } finally {
    state.technicalLinkageBusy = false;
    renderTechnicalLinkageEditor();
  }
}

function renderTechnicalLinkageEditor() {
  const draft = state.technicalLinkageDraft;
  const profile = technicalLinkageProfile(draft.symbol);
  const busy = state.technicalLinkageBusy;
  for (const [input, value] of [[elements.technicalLinkageSymbol, draft.symbol], [elements.technicalLinkageSector, draft.sectorSymbol], [elements.technicalLinkagePeers, draft.peerSymbols], [elements.technicalLinkageRationale, draft.rationale]]) {
    if (document.activeElement !== input && input.value !== value) input.value = value;
  }
  const stateLabel = busy
    ? "处理中"
    : draft.dirty
      ? "未保存"
      : profile?.state === "confirmed"
        ? "用户已确认"
        : profile?.state === "proposed"
          ? "建议待确认"
          : "未配置";
  elements.technicalLinkageState.textContent = stateLabel;
  elements.technicalLinkageState.className = `technical-linkage-state ${busy
    ? "loading"
    : draft.dirty || profile?.state === "proposed"
      ? "pending"
      : profile?.state === "confirmed"
        ? "complete"
        : ""}`;
  for (const input of [
    elements.technicalLinkageSymbol,
    elements.technicalLinkageSector,
    elements.technicalLinkagePeers,
    elements.technicalLinkageRationale,
  ]) input.disabled = busy;
  elements.technicalLinkageSave.disabled = busy;
  elements.technicalLinkageSave.textContent = busy
    ? "处理中…"
    : profile?.state === "proposed"
      ? "确认建议"
      : "确认映射";
  elements.technicalLinkageRemove.disabled = busy || !profile;
  const message = state.technicalLinkageMessage;
  elements.technicalLinkageMessage.textContent = message?.text ?? "";
  elements.technicalLinkageMessage.className = message?.tone ?? "";
}

function renderTechnicalRadar() {
  const scrollTop = elements.technicalRadarBody.scrollTop;
  const focus = document.activeElement;
  const focusKey = focus?.dataset?.radarExpand ?? focus?.dataset?.radarOpen ?? null;
  const focusAction = focus?.dataset?.radarExpand ? "radarExpand" : "radarOpen";
  const radar = state.technicalRadar;
  const batch = radar.latestBatch;
  const summary = batch?.summary && typeof batch.summary === "object" ? batch.summary : {};
  const coverage = summary.coverage && typeof summary.coverage === "object" ? summary.coverage : {};
  const cards = Array.isArray(batch?.items) ? batch.items : [];
  const watchlist = Array.isArray(radar.watchlist?.items) ? radar.watchlist.items : [];
  const status = radar.running
    ? "scanning"
    : state.technicalRadarLoading
      ? "loading"
      : radarUiStatus(summary.status ?? (batch ? "degraded" : "unavailable"));
  const selectedCount = radarFiniteInteger(coverage.selectedSymbolCount);
  const requestedCount = radarFiniteInteger(coverage.requestedSymbolCount);
  const coverageLabel = selectedCount == null
    ? "N/A"
    : requestedCount == null
      ? String(selectedCount)
      : `${selectedCount}/${requestedCount}`;

  elements.technicalRadarToggleState.textContent = {
    scanning: "扫描中",
    loading: "读取中",
    complete: "数据完整",
    degraded: "部分缺失",
    unavailable: batch ? "暂无数据" : "待扫描",
  }[status] ?? "待扫描";
  elements.technicalRadarToggleState.className = `technical-radar-toggle-state ${status}`;
  elements.technicalRadarSummary.innerHTML = `
    <div><span>已完成交易日</span><strong>${esc(batch?.tradingDate ?? "尚未扫描")}</strong></div>
    <div><span>扫描覆盖</span><strong>${esc(coverageLabel)}</strong></div>
    <div><span>数据状态</span><strong>${esc(radarStatusLabel(status))}</strong></div>`;
  elements.technicalRadarComputed.textContent = batch?.computedAt
    ? `更新于 ${shortDateTime(batch.computedAt)}`
    : "扫描只使用已完成日线";
  elements.technicalRadarRun.disabled = radar.running || state.technicalRadarLoading;
  elements.technicalRadarRun.textContent = radar.running
    ? "正在扫描…"
    : state.technicalRadarLoading
      ? "正在读取…"
      : batch ? "更新扫描" : "开始扫描";
  elements.technicalWatchlistSymbol.disabled = state.technicalRadarMutationBusy;
  elements.technicalWatchlistAdd.disabled = state.technicalRadarMutationBusy;
  renderTechnicalLinkageEditor();

  const changeRows = Array.isArray(summary.rankings?.changes?.rows)
    ? summary.rankings.changes.rows
    : [];
  const anomalyRows = Array.isArray(summary.rankings?.anomalies?.rows)
    ? summary.rankings.anomalies.rows
    : [];
  const changesBySymbol = new Map(changeRows.map((row) => [String(row?.symbol ?? ""), row]));
  const anomalyRankBySymbol = new Map(anomalyRows.map((row, index) => [
    String(row?.symbol ?? ""),
    { row, rank: index + 1 },
  ]));
  const changedCount = cards.filter((card) => radarChanges(card, changesBySymbol)).length;
  const gapCount = cards.filter(radarHasGap).length;
  $("#radar-tab-count").textContent = cards.length ? String(cards.length) : "";
  $("#technical-radar-title").textContent = changedCount ? `技术雷达 · ${changedCount} 项变化` : "打开技术雷达";
  const counts = { all: cards.length, changed: changedCount, gaps: gapCount };
  for (const button of document.querySelectorAll("[data-radar-filter]")) {
    const filter = button.dataset.radarFilter;
    button.setAttribute("aria-pressed", String(filter === state.radarUi.filter));
    button.textContent = `${({ all: "全部", changed: "有变化", gaps: "待补数据" })[filter]} ${counts[filter]}`;
  }
  const settings = state.radarUi.settings;
  $("#radar-view-heading").textContent = settings ? "自选与联动管理" : "日线结构观察";
  $("#radar-view-description").textContent = settings ? "联动修改后请确认映射；返回后更新扫描。" : "长桥持仓 + 技术自选 · 非实时行情";
  $("#radar-settings-back").hidden = !settings;
  elements.technicalRadarRun.hidden = settings;
  elements.technicalRadarSummary.hidden = settings;
  $(".technical-radar-actions").hidden = settings;
  $("#radar-settings").hidden = !settings;
  $("#radar-filters").hidden = settings;
  elements.technicalRadarList.hidden = settings;
  $("#radar-settings-toggle").textContent = settings ? "返回扫描结果" : "管理自选与联动";
  $("#radar-settings-toggle").setAttribute("aria-expanded", String(settings));
  const changedWatchlist = radar.watchlist.updatedAt && (!batch?.computedAt || Date.parse(radar.watchlist.updatedAt) > Date.parse(batch.computedAt));
  const notice = radar.lastError ? `${radar.lastError}${batch ? "；仍显示上次扫描，不是本次新结果。" : ""}`
    : state.radarUi.notice ?? (changedWatchlist ? "自选已变更，更新扫描后纳入结果。" : null);
  $("#radar-notice").textContent = notice ?? "";
  $("#radar-notice").hidden = !notice;
  elements.technicalRadarList.setAttribute("aria-busy", String(radar.running || state.technicalRadarLoading));
  const watchlistHtml = watchlist.length
    ? `<div class="technical-watchlist-strip"><span>自选 ${watchlist.length}</span><div>${watchlist.map((item) => {
      const symbol = String(item?.symbol ?? "");
      return `<span class="technical-watchlist-chip"><button type="button" data-radar-linkage="${esc(symbol)}" title="配置 ${esc(symbol)} 的行业与同行">${esc(symbol)}</button><button type="button" data-radar-remove="${esc(symbol)}" ${state.technicalRadarMutationBusy ? "disabled" : ""} aria-label="从技术自选移除 ${esc(symbol)}">×</button></span>`;
    }).join("")}</div></div>`
    : '<p class="technical-radar-empty">还没有技术自选；上方输入代码即可添加。</p>';
  $("#radar-watchlist-items").innerHTML = watchlistHtml;
  const visible = radarVisibleCards(cards, { filter: state.radarUi.filter, query: state.radarUi.query, changes: changesBySymbol });
  const cardsHtml = cards.length
    ? visible.length ? visible.map((card) => technicalRadarCard(card, {
      change: radarChanges(card, changesBySymbol),
      anomaly: anomalyRankBySymbol.get(String(card?.symbol ?? "")) ?? null,
    })).join("") : `<div class="technical-radar-empty"><strong>${state.radarUi.query ? "没有匹配的标的" : state.radarUi.filter === "changed" ? "本轮没有记录到状态变化" : "当前没有待补数据的标的"}</strong><p>${state.radarUi.query ? "试试股票代码，或清除筛选查看全部。" : "这只描述本轮证据，不代表价格未波动或适合买入。"}</p><button type="button" data-radar-clear>查看全部</button></div>`
    : `<div class="technical-radar-empty">${radar.lastError
      ? esc(radar.lastError)
      : watchlist.length
        ? "自选已保存；运行扫描后显示结构，当前指标为 N/A。"
        : "运行扫描后显示可核验的结构变化；缺失指标保持 N/A。"}</div>`;
  elements.technicalRadarList.innerHTML = cardsHtml;
  if (focusKey) [...elements.technicalRadarList.querySelectorAll("button")].find((button) => button.dataset[focusAction] === focusKey)?.focus({ preventScroll: true });
  elements.technicalRadarBody.scrollTop = scrollTop;
}

function technicalRadarCard(card, { change, anomaly }) {
  const symbol = String(card?.symbol ?? "");
  const memberships = Array.isArray(card?.memberships) ? card.memberships : [];
  const status = radarUiStatus(card?.status);
  const qqq20 = card?.metrics?.qqqExcessReturns?.["20"];
  const qqq20Available = qqq20?.status === "available" && finiteUiNumber(qqq20.value) != null;
  const qqq20Value = qqq20Available ? Number(qqq20.value) : null;
  const changedCount = radarFiniteInteger(change?.changedFieldCount)
    ?? (Array.isArray(change?.changedFields) ? change.changedFields.length : null);
  const changeHint = change
    ? `<span class="radar-observation change">${change.kind === "new_symbol" ? "新增观察" : `变化 ${changedCount ?? "N/A"}`}</span>`
    : "";
  const degradedCount = Array.isArray(card?.degradedReasons) ? card.degradedReasons.length : 0;
  const limitationHint = degradedCount
    ? `<span class="radar-observation degraded" title="${esc(card.degradedReasons.join(" · "))}">证据缺口 ${degradedCount}</span>`
    : "";
  const membership = memberships.map((item) => item === "holding" ? "持仓" : item === "watchlist" ? "自选" : item).join(" + ") || "观察";
  const expanded = state.radarUi.expanded === symbol;
  const detailId = `radar-detail-${encodeURIComponent(symbol)}`;
  const changedFields = Array.isArray(change?.changedFields) ? change.changedFields : [];
  const changesHtml = changedFields.length ? `<section><h3>与上次扫描相比</h3>${changedFields.map((field) => `<p class="radar-change-row"><span>${esc(radarFieldLabel(field.field))}</span><span>${esc(radarStateLabel(field.from))} → <strong>${esc(radarStateLabel(field.to))}</strong></span></p>`).join("")}</section>`
    : '<p class="radar-detail-note">暂无可展示的状态对比；不等于期间没有价格变化。</p>';
  const gapsHtml = degradedCount ? `<section class="radar-gap-details"><h3>哪些数据还不完整</h3><ul>${card.degradedReasons.map((reason) => `<li>${esc(radarReasonLabel(reason))}</li>`).join("")}</ul><p>刷新可重试获取；历史长度或权限不足不能靠重复扫描补齐。</p></section>` : "";
  const emaHtml = [3, 5, 8, 13, 21, 144, 169].map((period) => {
    const metric = card?.ema?.[period];
    const value = metric?.status === "available" && finiteUiNumber(metric.value) != null ? Number(metric.value).toFixed(2) : "—";
    const maturityNote = value === "—" ? "" : radarEmaNote(metric);
    return `<div><dt>EMA ${period}</dt><dd>${esc(value)}${maturityNote ? `<small>${esc(maturityNote)}</small>` : ""}</dd></div>`;
  }).join("");
  return `<article class="technical-radar-card ${status} ${expanded ? "expanded" : ""}">
    <button class="technical-radar-card-main" type="button" data-radar-expand="${esc(symbol)}" aria-expanded="${expanded}" aria-controls="${detailId}" title="展开 ${esc(symbol)} 的结构与数据说明">
      <span class="technical-radar-card-head"><strong>${esc(symbol || "N/A")}</strong><small>${esc(membership)}</small><i>${esc(radarStatusLabel(status))}</i></span>
      <span class="radar-card-thesis">${esc(radarDisplay(card?.structure?.short))}<small>长线 · ${esc(radarDisplay(card?.structure?.long))}</small></span>
      <span class="technical-radar-observations">${changeHint}${limitationHint}${!changeHint && !limitationHint ? '<span class="radar-observation quiet">查看指标与证据</span>' : ""}<span class="radar-expand-label">${expanded ? "收起" : "详情"}</span></span>
    </button>
    <div class="radar-card-detail" id="${detailId}" ${expanded ? "" : "hidden"}>
      <div class="radar-card-actions"><button type="button" data-radar-open="${esc(symbol)}">同步到 TV / Agent</button><button type="button" data-radar-linkage="${esc(symbol)}">配置联动</button></div>
      <p class="radar-detail-note">同步只选择分析标的，不自动运行 Agent。</p>
      <div class="technical-radar-metrics"><span>价格 / EMA21<strong>${esc(radarRelationLabel(card?.structure?.priceVsEma21))}</strong></span><span>QQQ 超额 · 20日<strong class="${tone(qqq20Value)}">${qqq20Available ? signedPercent(qqq20Value) : "N/A"}</strong></span></div>
      ${changesHtml}
      <section><h3>均线数值 · 日线</h3><dl class="radar-ema-values">${emaHtml}</dl><p class="radar-detail-note">沿用宿主已完成 K 线计算；数值不代表买卖条件。</p></section>
      ${gapsHtml}
      ${anomaly ? `<p class="radar-detail-note">观察排序 #${anomaly.rank}：先考虑数据缺口，再参考波幅、量能等变化；不是投资机会排名。</p>` : ""}
    </div>
  </article>`;
}

function radarReasonLabel(value) {
  return ({ weekly_structure_incomplete: "周线结构不完整：检查历史长度或周线覆盖。", cost_profile_14_28_incomplete: "14 / 28 日筹码分布不完整。", benchmark_exact_cutoff_unavailable: "QQQ 缺少同一截止日的数据，不能作可靠比较。", sector_exact_cutoff_unavailable: "行业 ETF 缺少同一截止日的数据。", benchmark_excess_partial: "QQQ 超额收益仅部分周期可用。", benchmark_excess_unavailable: "QQQ 超额收益暂不可用。" })[value] ?? String(value);
}

async function handleTechnicalRadarClick(event) {
  if (event.target.closest("[data-radar-clear]")) {
    state.radarUi.filter = "all"; state.radarUi.query = ""; $("#radar-search").value = ""; renderTechnicalRadar(); return;
  }
  const expand = event.target.closest("[data-radar-expand]");
  if (expand) { state.radarUi.expanded = state.radarUi.expanded === expand.dataset.radarExpand ? null : expand.dataset.radarExpand; renderTechnicalRadar(); return; }
  const linkage = event.target.closest("[data-radar-linkage]");
  if (linkage) {
    if (state.technicalLinkageBusy) return;
    setTechnicalLinkageEditorSymbol(linkage.dataset.radarLinkage, { force: true, expand: true });
    setRadarSettings(true); elements.technicalLinkageEditor.scrollIntoView({ block: "nearest" }); return;
  }
  const remove = event.target.closest("[data-radar-remove]");
  if (remove) {
    event.preventDefault();
    event.stopPropagation();
    await removeTechnicalWatchlistSymbol(remove.dataset.radarRemove);
    return;
  }
  const target = event.target.closest("[data-radar-open]");
  if (!target) return;
  setTechnicalLinkageEditorSymbol(target.dataset.radarOpen, { force: true });
  await openTechnicalRadarSymbol(target.dataset.radarOpen);
}

async function openTechnicalRadarSymbol(value) {
  const symbol = normalizeCandidateSymbol(value);
  if (!symbol) return;
  const position = state.portfolio?.positions?.find((item) => item.symbol === symbol) ?? null;
  if (position) {
    if (state.analysisScope !== "position") setAnalysisScope("position");
    selectPosition(symbol);
    await syncSelectedToTv();
    return;
  }
  if (state.analysisScope !== "candidate") setAnalysisScope("candidate");
  state.candidateSymbol = symbol;
  elements.candidateSymbol.value = symbol;
  setTechnicalLinkageEditorSymbol(symbol, { force: true });
  renderAgentContext();
  invalidateAgentRuns("技术雷达已切换候选标的，请重新运行 Agent。 ");
  try {
    await api.tv.loadSymbol(technicalRadarTvSymbol(symbol));
    setSystemMessage(`${symbol} 已切换到 TradingView 与候选分析`);
  } catch (error) {
    setSystemMessage(error?.message || "切换 TradingView 标的失败", "warning");
  }
}

function technicalRadarTvSymbol(symbol) {
  const ticker = String(symbol ?? "").split(".")[0];
  if (String(symbol).endsWith(".HK")) return `HKEX:${ticker}`;
  if (String(symbol).endsWith(".SG")) return `SGX:${ticker}`;
  if (String(symbol).endsWith(".SH")) return `SSE:${ticker}`;
  if (String(symbol).endsWith(".SZ")) return `SZSE:${ticker}`;
  return ticker;
}

function radarUiStatus(value) {
  const status = String(value ?? "").toLowerCase();
  if (status === "complete") return "complete";
  if (["partial", "degraded"].includes(status)) return "degraded";
  return "unavailable";
}

function radarStatusLabel(value) {
  return {
    scanning: "扫描中",
    loading: "读取中",
    complete: "完整",
    degraded: "部分缺失",
    unavailable: "暂无数据",
  }[value] ?? "不可用";
}

function radarRelationLabel(value) {
  return { above: "价格在上", below: "价格在下", at: "价格贴合" }[value] ?? "N/A";
}

function radarDisplay(value) {
  if (value == null || value === "" || String(value).toUpperCase() === "N/A") return "N/A";
  return String(value);
}

function radarFiniteInteger(value) {
  return radarInteger(value);
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
  setTechnicalLinkageEditorSymbol(symbol, { force: true });
  appendContextDirty();
}

function updateSelectedMapping() {
  const position = selectedPosition();
  if (!position) {
    elements.mapping.textContent = "选择持仓后可同步标的";
    elements.syncTv.disabled = true;
    return;
  }
  if (position.instrumentType === "option" || !position.tvSymbol) {
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

function portfolioFxLabel(portfolio) {
  if (!portfolio) return "—";
  const describe = (status, fx, broker) => {
    const label = brokerName(broker) || "账户";
    if (status === "not_required") return `${label} USD 单币种 · 无需换汇`;
    if (status === "live") return `${label} 账户汇率${fx?.asOf ? ` · ${fx.asOf}` : " · 时间待核对"}`;
    if (status === "reference" || status === "reference_cached") {
      return `${label} ${fx?.providerCode ?? "参考来源"} ${fx?.asOf ?? "日期未知"} 参考汇率${status === "reference_cached" ? "（缓存）" : ""}`;
    }
    return `${label} 汇率不可用`;
  };
  if (Array.isArray(portfolio.fx?.sources) && portfolio.fx.sources.length) {
    return portfolio.fx.sources.map((source) => describe(source.status, source, source.broker)).join(" / ");
  }
  return describe(portfolio.dataQuality?.fxStatus, portfolio.fx, portfolio.brokerScope ?? state.brokerScope);
}

function renderAgentContext() {
  if (state.analysisScope === "review") {
    renderReviewAgentContext(ensureSessionView(state.activeSessionId).reviewContext ?? {});
    return;
  }
  if (state.analysisScope === "chat") {
    const research = ensureSessionView(state.activeSessionId).researchContext;
    elements.agentContext.innerHTML = `
      <div><span>研究范围</span><strong>${research?.researchThesisId ? `${esc(research.name || "已关联研究主线")} · 最新已保存版本` : "自由研究 · 无需账户快照"}</strong></div>
      <div><span>工具边界</span><strong>以当前对话工具状态为准</strong></div>
      <div><span>账户数据</span><strong>需要组合或仓位分析时，请切换对应范围</strong></div>`;
    return;
  }
  const position = selectedPosition();
  const scope = state.analysisScope;
  const asOf = state.portfolio?.syncedAt;
  const trust = state.portfolio ? portfolioTrustSnapshot(state.portfolio) : null;
  const marks = state.portfolio ? portfolioMarkRange(state.portfolio) : null;
  const quality = portfolioFxLabel(state.portfolio);
  const contextLabel = scope === "portfolio"
    ? `全部组合 · ${number(state.portfolio?.positions?.length ?? 0, 0)} 项`
    : scope === "candidate"
      ? state.candidateSymbol || "等待候选代码"
      : position
        ? `${position.symbol} · ${percent(position.weight)}`
        : "未选择持仓";
  elements.agentContext.innerHTML = `
    <div><span>${scope === "portfolio" ? "组合范围" : scope === "candidate" ? "候选标的" : "持仓上下文"} · ${esc(brokerName(state.brokerScope))}</span><strong>${esc(contextLabel)}</strong></div>
    <div><span>周期</span><strong>1D</strong></div>
    <div><span>持仓快照 / 行情标记</span><strong>${asOf && trust ? `${esc(trust.label)} · ${esc(trust.ageLabel)} · MARKS ${esc(marks?.label ?? "UNKNOWN")} · ${esc(quality)}` : "—"}</strong></div>`;
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
  const scope = state.analysisScope;
  if (!["chat", "review"].includes(scope) && !state.portfolio) {
    setSystemMessage("该分析范围需要先连接券商并同步真实组合；无需账户的问题可切换“自由研究”。", "warning");
    return;
  }
  if (!state.codexAvailable) {
    setSystemMessage("当前对话的研究运行时或只读隔离尚未就绪；请查看上方状态，或新建受限研究对话。", "warning");
    return;
  }
  const reviewContext = ensureSessionView(state.activeSessionId).reviewContext;
  const researchContext = ensureSessionView(state.activeSessionId).researchContext;
  if (scope === "review"
    && !reviewContext?.reviewCycleId
    && !reviewContext?.reviewCaseIds?.length) {
    setSystemMessage("当前复盘对话缺少已关联周期或案例，请返回复盘台重新选择。", "warning");
    return;
  }
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
    chat: "",
    position: "分析当前持仓的技术结构、组合风险和条件计划",
    candidate: "为未持有候选标的生成买入计划，包括触发、失效条件和风险预算",
    portfolio: "检查全部持仓的集中度、重复暴露、下行情景和组合健康度",
    review: reviewContext?.reviewProtocol === "decision_cycle"
      ? reviewContext.reviewPhase === "retrospective"
        ? "继续该订单优先事后复盘；保持 retrospective 证据标签，并更新可验证建议"
        : `继续执行该周期的${reviewContext.reviewPhase === "outcome" ? "结果归因" : "盲态过程"}复盘；遵守时间防火墙并更新可验证建议`
      : "继续基于当前已关联订单、财报事件与事前记录分析，并更新验证或规避建议",
  };
  const task = elements.agentInput.value.trim() || defaultTasks[scope];
  if (!task) {
    setSystemMessage("请输入你想研究的问题。", "warning");
    elements.agentInput.focus();
    return;
  }
  const riskBudgetPercent = Number(elements.riskBudget.value || 0.8);
  const targetSymbol = scope === "position" ? position?.symbol : scope === "candidate" ? candidateSymbol : null;
  // The prepared-review entry points create and bind the independent Codex
  // thread. Once the user is inside it, ordinary follow-ups must stay in that
  // same thread so its review context and prior answer remain conversational.
  startAgentOperation({
    scope,
    targetSymbol,
    task,
    riskBudgetPercent,
    targetLabel: scope === "review"
      ? reviewContext.reviewCycleId
        ? reviewContext.reviewPhase === "retrospective"
          ? "直接事后复盘 · 决策周期"
          : `${reviewContext.reviewPhase === "outcome" ? "阶段二" : "阶段一"} · 决策周期`
        : reviewContext.fiscalQuarter || `${reviewContext.reviewCaseIds.length} 个复盘案例`
      : null,
    requestExtras: scope === "review"
      ? reviewContext.reviewCycleId
        ? {
          reviewCycleId: reviewContext.reviewCycleId,
          cycleId: reviewContext.reviewCycleId,
          reviewPhase: reviewContext.reviewPhase,
          reviewProtocol: "decision_cycle",
        }
        : {
          reviewCaseIds: reviewContext.reviewCaseIds,
          caseIds: reviewContext.reviewCaseIds,
          fiscalQuarter: reviewContext.fiscalQuarter ?? null,
          reviewMode: reviewContext.reviewMode ?? null,
        }
      : scope === "chat" && researchContext?.researchThesisId
        ? { researchThesisId: researchContext.researchThesisId, researchIntent: "discuss" }
        : {},
  });
}

async function submitPreparedResearchAnalysis(detail) {
  const researchThesisId = String(detail?.researchThesisId ?? "").trim();
  if (!researchThesisId) return;
  const threadId = await createAgentSession();
  if (!threadId || String(state.activeSessionId ?? "") !== String(threadId)) {
    setSystemMessage("未能创建独立研究对话；研究记录未改变，请稍后重试。", "error");
    return;
  }
  const view = ensureSessionView(threadId);
  view.scope = "chat";
  view.reviewContext = null;
  view.researchContext = { researchThesisId, name: detail?.name ?? null };
  state.analysisScope = "chat";
  restoreSessionComposer(view);
  document.querySelector("#workspace-cockpit")?.click();
  if (state.layout.agentCollapsed) setPaneCollapsed("agent", false);
  const task = String(detail?.task ?? "").trim() ||
    "$analyze-market-narratives 依据当前已保存的研究记录，检查我的因果判断、市场当前预期、预期差和反证。核对最新可用一手资料与数据时间，缺失的一致预期不得猜测；提出下一验证点。生成可编辑研究草案，保留用户原判断，待我确认。";
  startAgentOperation({ scope: "chat", targetLabel: detail?.name || "研究主线", task,
    riskBudgetPercent: Number(elements.riskBudget.value || 0.8),
    requestExtras: { researchThesisId, researchIntent: "update" } });
}

async function submitPreparedReviewAnalysis(detail) {
  const source = detail?.request ?? detail?.analysis ?? detail ?? {};
  const reviewCaseIds = [...new Set([
    ...(Array.isArray(source.reviewCaseIds) ? source.reviewCaseIds : []),
    ...(Array.isArray(source.caseIds) ? source.caseIds : []),
    source.caseId,
  ].map((item) => String(item ?? "").trim()).filter(Boolean))];
  if (!reviewCaseIds.length) {
    setSystemMessage("复盘 Agent 请求缺少案例 ID，请返回复盘台重新选择。", "warning");
    return;
  }
  const reviewSessionId = await createReviewAgentSession({
    reviewCaseIds,
    fiscalQuarter: source.fiscalQuarter ?? null,
    reviewMode: source.reviewMode ?? (reviewCaseIds.length === 1 ? "single_event" : "selected_case_set"),
  });
  if (!reviewSessionId) {
    setSystemMessage("无法创建独立 Codex 复盘对话，复盘尚未提交。", "error");
    return;
  }
  document.querySelector("#workspace-cockpit")?.click();
  if (state.layout.agentCollapsed) setPaneCollapsed("agent", false);
  const task = String(source.task ?? "").trim()
    || (reviewCaseIds.length > 1
      ? `$review-earnings-decisions 组合复盘用户明确选择的 ${reviewCaseIds.length} 个案例及其已关联订单与成交；披露样本覆盖，区分决策、执行和结果，并提出下一轮验证与规避计划。`
      : "$review-earnings-decisions 基于已确认关联的长桥订单、成交、财报事件和用户事前记录，复盘该决策；区分过程质量与结果运气，并提出可验证的下一步。 ");
  elements.agentInput.value = task;
  const view = ensureSessionView(reviewSessionId);
  view.draft = task;
  renderReviewAgentContext({
    fiscalQuarter: source.fiscalQuarter,
    caseCount: reviewCaseIds.length,
  });
  startAgentOperation({
    scope: "review",
    targetSymbol: null,
    targetLabel: source.fiscalQuarter || `${reviewCaseIds.length} 个复盘案例`,
    task,
    riskBudgetPercent: Number(elements.riskBudget.value || 0.8),
    requestExtras: {
      reviewCaseIds,
      caseIds: reviewCaseIds,
      fiscalQuarter: source.fiscalQuarter ?? null,
      reviewMode: source.reviewMode ?? (reviewCaseIds.length === 1 ? "single_event" : "selected_case_set"),
    },
  });
}

async function submitPreparedReviewCycleAnalysis(detail) {
  const source = detail?.request ?? detail?.analysis ?? detail ?? {};
  const reviewCycleId = String(source.reviewCycleId ?? source.cycleId ?? "").trim();
  const reviewPhase = normalizeReviewPhase(source.reviewPhase);
  if (!reviewCycleId) {
    setSystemMessage("复盘 Agent 请求缺少周期 ID，请返回复盘台重新选择。", "warning");
    return;
  }
  const reviewSessionId = await createReviewAgentSession({
    reviewProtocol: "decision_cycle",
    reviewCycleId,
    reviewPhase,
    cycleType: source.cycleType ?? null,
  });
  if (!reviewSessionId) {
    setSystemMessage("无法创建独立 Codex 周期复盘对话，复盘尚未提交。", "error");
    return;
  }
  document.querySelector("#workspace-cockpit")?.click();
  if (state.layout.agentCollapsed) setPaneCollapsed("agent", false);
  const task = String(source.task ?? "").trim()
    || `$review-decision-cycles 执行该决策周期的${reviewPhase === "blind"
      ? "阶段一盲态"
      : reviewPhase === "outcome" ? "阶段二结果" : "订单优先直接事后"}复盘。`;
  elements.agentInput.value = task;
  const view = ensureSessionView(reviewSessionId);
  view.draft = task;
  renderReviewAgentContext(view.reviewContext);
  startAgentOperation({
    scope: "review",
    targetSymbol: null,
    targetLabel: reviewPhase === "blind"
      ? "阶段一 · 盲态复盘"
      : reviewPhase === "outcome" ? "阶段二 · 结果复盘" : "订单优先 · 直接事后复盘",
    task,
    riskBudgetPercent: Number(elements.riskBudget.value || 0.8),
    requestExtras: {
      reviewCycleId,
      cycleId: reviewCycleId,
      reviewPhase,
      reviewProtocol: "decision_cycle",
    },
  });
}

async function createReviewAgentSession({
  reviewProtocol = "earnings_case",
  reviewCycleId = null,
  reviewPhase = null,
  cycleType = null,
  reviewCaseIds = [],
  fiscalQuarter = null,
  reviewMode = null,
} = {}) {
  const threadId = await createAgentSession();
  if (!threadId || String(state.activeSessionId ?? "") !== String(threadId)) return null;
  const view = ensureSessionView(threadId);
  view.scope = "review";
  view.reviewContext = reviewProtocol === "decision_cycle" || reviewCycleId
    ? {
      reviewProtocol: "decision_cycle",
      reviewCycleId: String(reviewCycleId ?? "").trim(),
      reviewPhase: normalizeReviewPhase(reviewPhase),
      cycleType,
    }
    : {
      reviewProtocol: "earnings_case",
      reviewCaseIds: [...new Set((reviewCaseIds ?? []).map((item) => String(item ?? "").trim()).filter(Boolean))],
      fiscalQuarter,
      reviewMode: reviewMode ?? ((reviewCaseIds ?? []).length === 1 ? "single_event" : "selected_case_set"),
    };
  state.analysisScope = "review";
  document.querySelectorAll(".scope-segmented [data-scope]").forEach((button) => {
    button.setAttribute("aria-checked", "false");
  });
  elements.candidateSymbolField.hidden = true;
  return threadId;
}

function startAgentOperation({
  scope,
  targetSymbol = null,
  targetLabel = null,
  task,
  riskBudgetPercent,
  requestExtras = {},
}) {
  const threadId = String(state.activeSessionId ?? "");
  if (!threadId) {
    setSystemMessage("请先新建或打开一个 Codex 对话", "warning");
    return false;
  }
  if (activeOperationForThread(threadId)) {
    setSystemMessage("当前对话已有分析在运行；可以新建或切换到其他对话并行分析。", "warning");
    return false;
  }
  const requestId = crypto.randomUUID();
  const operation = {
    operationId: requestId,
    threadId,
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    status: "running",
    progress: scope === "chat"
      ? "正在通过 Codex 研究你的问题…"
      : scope === "review"
      ? requestExtras.reviewCycleId
        ? requestExtras.reviewPhase === "retrospective"
          ? "正在汇总周期内真实订单、成交与结果证据…"
          : requestExtras.reviewPhase === "outcome"
            ? "正在引用冻结的盲态结论并汇总周期结果…"
            : "正在建立时间防火墙并汇总截止点以前的证据…"
        : "正在汇总已关联订单、成交、财报事件与事前记录…"
      : "正在获取长桥日线并计算 EMA、Fib 与组合风险…",
    task,
    streamText: "",
    finalText: "",
    streamBuffers: new Map(),
    streamOrder: [],
    toolEvents: new Map(),
  };
  markLatestThreadOperation(operation);
  for (const previous of [...state.operations.values()]) {
    if (previous.threadId !== threadId || previous.operationId === requestId) continue;
    if (["running", "cancelling"].includes(previous.status)) continue;
    rememberSettledOperation(previous.operationId);
    stopAgentResultRecovery(previous);
  }
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
  const displayTarget = targetLabel ?? (scope === "chat" ? "自由研究" : scope === "portfolio" ? "全部组合" : targetSymbol);
  elements.agentLiveStatus.textContent = `正在分析 ${displayTarget}`;
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
    brokerScope: state.brokerScope,
    ...requestExtras,
  }).then((run) => {
    acceptAgentResult({ threadId, operationId: requestId, run });
  }).catch((error) => {
    failAgentOperation(operation, error.message || "Agent 运行失败");
  });
  return true;
}

function renderReviewAgentContext({
  reviewProtocol = "earnings_case",
  reviewCycleId = null,
  reviewPhase = null,
  cycleType = null,
  fiscalQuarter = null,
  caseCount = 0,
  reviewCaseIds = [],
} = {}) {
  if (reviewProtocol === "decision_cycle" || reviewCycleId) {
    const normalizedPhase = normalizeReviewPhase(reviewPhase);
    const phaseLabel = normalizedPhase === "retrospective"
      ? "订单优先 · 直接事后复盘"
      : normalizedPhase === "outcome" ? "阶段二 · 结果与归因" : "阶段一 · 盲态重放";
    const typeLabels = {
      catalyst: "财报 / 催化剂周期",
      position_lifecycle: "单一持仓生命周期",
      monthly_portfolio: "月度组合周期",
    };
    elements.agentContext.innerHTML = `
      <div><span>复盘范围</span><strong>${esc(typeLabels[cycleType] || "决策周期")}</strong></div>
      <div><span>时间防火墙</span><strong>${esc(phaseLabel)}</strong></div>
      <div><span>分析方式</span><strong>$review-decision-cycles · 独立 Codex 对话</strong></div>`;
    return;
  }
  const resolvedCaseCount = caseCount || reviewCaseIds.length;
  elements.agentContext.innerHTML = `
    <div><span>复盘范围</span><strong>${esc(fiscalQuarter || `${resolvedCaseCount} 个已关联案例`)}</strong></div>
    <div><span>事实层</span><strong>长桥历史订单 + 成交 + 财报事件</strong></div>
    <div><span>分析方式</span><strong>$review-earnings-decisions · 独立 Codex 对话</strong></div>`;
}

function normalizeReviewPhase(value) {
  return value === "outcome" || value === "retrospective" ? value : "blind";
}

function handleAgentResult(envelope) {
  if (envelope?.run) {
    acceptAgentResult(envelope);
    return;
  }
  const operationId = String(envelope?.operationId ?? "");
  const operation = state.operations.get(operationId);
  if (!envelope?.error || !operationId) return;
  if (operation) {
    const diagnostics = envelope?.contextDiagnostics;
    const detail = diagnostics?.deliveryStatus === "rejected_budget"
      ? `${envelope.error}（证据包 ${number(diagnostics.totalBlockCount, 0)} 块 / ${contextBytesLabel(diagnostics.totalUtf8Bytes)}，未静默截断）`
      : envelope.error;
    failAgentOperation(operation, detail, { continueRecovery: envelope?.retryable !== false, failure: envelope });
  }
}

function scheduleAgentResultRecovery(operation, delayMs = 900) {
  if (!operation || !api.recoverAgentResult || !state.operations.has(operation.operationId)) return;
  const recoveryStopAt = Number(operation.recoveryStopAt);
  if (Number.isFinite(recoveryStopAt) && Date.now() >= recoveryStopAt) {
    stopAgentResultRecovery(operation);
    return;
  }
  if (operation.recoveryTimer) clearTimeout(operation.recoveryTimer);
  const boundedDelay = Number.isFinite(recoveryStopAt)
    ? Math.max(0, Math.min(delayMs, recoveryStopAt - Date.now()))
    : delayMs;
  operation.recoveryTimer = setTimeout(() => {
    operation.recoveryTimer = null;
    if (Number.isFinite(Number(operation.recoveryStopAt))
      && Date.now() >= Number(operation.recoveryStopAt)) {
      stopAgentResultRecovery(operation);
      return;
    }
    recoverAgentResult(operation);
  }, boundedDelay);
}

function stopAgentResultRecovery(operation) {
  if (operation?.recoveryTimer) clearTimeout(operation.recoveryTimer);
  if (operation?.operationId) state.operations.delete(operation.operationId);
  renderAgentSessions();
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
    if (recovered?.recoveryFailure) {
      failAgentOperation(operation, recovered.recoveryFailure.error || "持久对话尚未完整取回", {
        continueRecovery: false,
        failure: recovered.recoveryFailure,
      });
      return;
    }
    if (recovered?.historicalTurn?.status === "completed"
      && recovered.historicalTurn.text
      && recovered.active === false) {
      settleAgentFromRecoveredTurn(operation, recovered.historicalTurn.text);
      scheduleAgentResultRecovery(operation, 10_000);
      return;
    }
    if (recovered?.active !== false) {
      scheduleAgentResultRecovery(operation, 5_000);
      return;
    }
    if (recovered?.historicalTurn?.terminal) {
      failAgentOperation(
        operation,
        "Codex 上一轮已中断且没有结构化结果；若稍后收到正式结果，界面仍会自动覆盖此状态。",
        { continueRecovery: false },
      );
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
    scheduleAgentResultRecovery(operation, 10_000);
  } else if (state.operations.has(operation.operationId)) {
    scheduleAgentResultRecovery(operation, 10_000);
  }
}

function settleAgentFromRecoveredTurn(operation, value) {
  const text = String(value ?? "").trim();
  if (!text || !state.operations.has(operation.operationId)) return;
  if (!isLatestThreadOperation(operation.threadId, operation.operationId)) {
    stopAgentResultRecovery(operation);
    return;
  }
  const node = elements.agentThread.querySelector(
    `[data-operation-id="${CSS.escape(operation.operationId)}"]`,
  );
  const article = document.createElement("article");
  article.className = "agent-card transcript-message provisional-fallback";
  article.dataset.operationId = operation.operationId;
  article.dataset.provisionalFallback = "true";
  const notice = document.createElement("div");
  notice.className = "provisional-fallback-notice";
  notice.textContent = "已恢复 Codex 文本 · 正在等待结构化裁决回执";
  const body = document.createElement("div");
  body.className = "agent-card-body model-response";
  article.append(notice);
  article.append(body);
  if (window.CockpitMarkdown?.renderMarkdown) window.CockpitMarkdown.renderMarkdown(body, text);
  else body.textContent = text;
  if (node) node.replaceWith(article);
  else if (operation.threadId === state.activeSessionId) elements.agentThread.append(article);
  const view = ensureSessionView(operation.threadId);
  if (view.transcript.at(-1)?.role !== "assistant"
    || !sameConversationText(view.transcript.at(-1)?.text, text)) {
    view.transcript.push({ role: "assistant", text });
  }
  operation.status = "fallback";
  operation.fallbackRendered = true;
  operation.fallbackText = text;
  operation.recoveryStopAt ??= Date.now() + POST_TERMINAL_RECOVERY_WINDOW_MS;
  const session = state.agentSessions.find((item) => item.id === operation.threadId);
  if (session) {
    session.runState = "idle";
    session.operationId = null;
  }
  if (operation.threadId === state.activeSessionId) {
    finishActiveAgentUi(operation.operationId, "文本已恢复，结构化裁决仍在对账");
  }
  renderAgentSessions();
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
  if ((operationId && !isLatestThreadOperation(resultThreadId, operationId))
    || (!operationId && state.latestOperationByThread.has(resultThreadId))) {
    // A provisional recovery lets the user start another turn. A late result
    // from that superseded operation remains in native Codex history, but must
    // not replace the newer turn's card, transcript tail, or session preview.
    if (operation?.recoveryTimer) clearTimeout(operation.recoveryTimer);
    if (operation) state.operations.delete(operation.operationId);
    if (operationId) rememberSettledOperation(operationId);
    return false;
  }
  if (operationId && !state.latestOperationByThread.has(resultThreadId)) {
    markLatestThreadOperation({
      operationId,
      threadId: resultThreadId,
      startedAt: envelope?.completedAt ?? run?.createdAt ?? null,
    });
  }
  const view = ensureSessionView(resultThreadId);
  if (view.unverifiedPartial?.operationId === operationId) view.unverifiedPartial = null;
  view.lastAgentResult = { ...envelope, threadId: resultThreadId };
  const session = state.agentSessions.find((item) => item.id === resultThreadId);
  if (session) {
    session.preview = String(run.conclusion?.body ?? run.conclusion?.headline ?? "")
      .replace(/\s+/g, " ").trim().slice(0, 500);
    session.updatedAt = envelope.completedAt ?? run.createdAt ?? new Date().toISOString();
    session.runState = "idle";
    session.operationId = null;
  }
  if (operation?.fallbackRendered && run.conclusion?.body) {
    const latest = view.transcript.at(-1);
    if (latest?.role === "assistant") latest.text = run.conclusion.body;
    else view.transcript.push({ role: "assistant", text: run.conclusion.body });
  } else if (!restored && run.conclusion?.body) {
    const latest = view.transcript.at(-1);
    if (latest?.role !== "assistant" || !sameConversationText(latest.text, run.conclusion.body)) {
      view.transcript.push({ role: "assistant", text: run.conclusion.body });
    }
  }
  const runScope = run.context.scope ?? (run.context.symbol ? "position" : "portfolio");
  const stale = resultThreadId === activeThreadId && isRunStale(run);
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
    state.currentRun = run;
  }
  if (operationId) {
    rememberSettledOperation(operationId);
  }
  const resultLabel = runScope === "portfolio"
    ? "全部组合"
    : runScope === "chat"
      ? "自由研究"
    : runScope === "review"
      ? "复盘"
      : run.context.symbol || "目标";
  const label = stale
    ? `${resultLabel} 分析完成，但上下文已变化`
    : `${resultLabel} 分析完成`;
  if (operation) finishAgentOperation(operation, label);
  else if (resultThreadId === activeThreadId) finishActiveAgentUi(operationId, label);
  if (run.context.reviewProtocol === "decision_cycle") {
    window.dispatchEvent(new CustomEvent("cockpit:review-cycle-analysis-completed", {
      detail: {
        cycleId: run.context.reviewCycleId,
        reviewPhase: run.context.reviewPhase,
        phaseRunId: run.context.reviewPhaseRunId ?? null,
      },
    }));
  }
  renderAgentSessions();
  if (resultThreadId === activeThreadId) scrollAgentToEnd({ force: false });
  return true;
}

function isRunStale(run, now = Date.now()) {
  if (!run?.context) return true;
  const runScope = run.context.scope ?? (run.context.symbol ? "position" : "portfolio");
  if (runScope === "review") return reviewRunEvidenceStale(run);
  if (runScope === "chat") return state.analysisScope !== "chat";
  if (!state.portfolio) return true;
  const activeTarget = state.analysisScope === "position"
    ? normalizeCandidateSymbol(state.selectedSymbol)
    : state.analysisScope === "candidate"
      ? normalizeCandidateSymbol(state.candidateSymbol)
      : null;
  const runTarget = run.context.symbol ? normalizeCandidateSymbol(run.context.symbol) : null;
  const snapshotMatches = state.portfolio.syncedAt === run.context.snapshotAt
    && state.portfolio.valuationSchemaVersion === run.context.valuationSchemaVersion;
  const trust = portfolioTrustSnapshot(state.portfolio, now);
  return state.analysisScope !== runScope
    || (runScope !== "portfolio" && activeTarget !== runTarget)
    || !snapshotMatches
    || !trust.freshForSizing
    || (runScope === "candidate" && candidateSizingExpired(run.risk, now));
}

function reviewRunEvidenceStale(run) {
  if (run?.context?.reviewProtocol === "decision_cycle") {
    if (run?.context?.reviewPhasePersistence === "failed") return true;
    const phase = run?.context?.reviewPhase;
    if (phase === "blind") return false;
    const cycleId = String(run.context.reviewCycleId ?? "");
    const currentNote = state.reviewCycleRetrospectiveVersions.get(cycleId);
    const usedNote = Number(run.context.reviewRetrospectiveVersion);
    const currentEvidence = state.reviewCycleEvidenceRevisions.get(cycleId);
    const usedEvidence = Number(run.context.reviewEvidenceRevision);
    const noteChanged = Number.isInteger(currentNote) && currentNote > 0
      && (!Number.isInteger(usedNote) || usedNote !== currentNote);
    const evidenceChanged = Number.isInteger(currentEvidence) && currentEvidence > 0
      && (!Number.isInteger(usedEvidence) || usedEvidence !== currentEvidence);
    return (phase === "retrospective" && noteChanged) || evidenceChanged;
  }
  const revisions = Array.isArray(run?.context?.reviewEvidenceRevisions)
    ? run.context.reviewEvidenceRevisions
    : [];
  if (!revisions.length || !state.reviewEvidenceRevisions.size) return false;
  return revisions.some((item) => {
    const current = state.reviewEvidenceRevisions.get(String(item?.caseId ?? ""));
    const used = Number(item?.revision);
    return Number.isInteger(current) && current > 0
      && (!Number.isInteger(used) || used !== current);
  });
}

function candidateSizingExpired(risk, now = Date.now()) {
  const validUntilMs = Date.parse(String(risk?.sizingValidUntil ?? ""));
  return Number.isFinite(validUntilMs) && now > validUntilMs;
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

function failAgentOperation(operation, message, { continueRecovery = true, failure = null } = {}) {
  if (!state.operations.has(operation.operationId)
    && state.settledOperationIds.has(operation.operationId)) return;
  if (!state.operations.has(operation.operationId)) return;
  operation.status = "error_pending_result";
  operation.recoveryStopAt ??= Date.now() + POST_TERMINAL_RECOVERY_WINDOW_MS;
  if (operation.recoveryTimer) clearTimeout(operation.recoveryTimer);
  const isActive = operation.threadId === state.activeSessionId;
  const failureCode = failure?.errorCode ?? failure?.code ?? failure?.deliveryStatus?.state ?? failure?.deliveryStatus;
  const terminalUnverified = ["terminal_unverified", "history_incomplete"].includes(failureCode);
  if (terminalUnverified) {
    continueRecovery = false;
    operation.terminalUnverified = true;
    message = failureCode === "history_incomplete"
      ? "历史正文尚未完整取回，可打开原对话继续 / 恢复；暂存文本不是完整结果，不能用于保存计划。"
      : "终态未核验，可打开原对话继续 / 恢复；暂存文本不是完整结果，不能用于保存计划。";
    const text = [failure?.partialText, operation.finalText, operation.streamText]
      .map((value) => String(value ?? "").trim()).find(Boolean) ?? "";
    ensureSessionView(operation.threadId).unverifiedPartial = {
      operationId: operation.operationId,
      threadId: operation.threadId,
      turnId: failure?.turnId ?? null,
      text,
      message,
    };
  }
  const session = state.agentSessions.find((item) => item.id === operation.threadId);
  if (session) {
    session.runState = "error";
    session.operationId = null;
  }
  if (isActive) {
    const node = elements.agentThread.querySelector(`[data-operation-id="${CSS.escape(operation.operationId)}"]`)
      ?? state.activeRunNode;
    if (terminalUnverified) {
      renderUnverifiedAgentPartial(ensureSessionView(operation.threadId).unverifiedPartial, node);
    } else if (node) {
      node.className = "run-state negative";
      node.innerHTML = `<span class="evidence-dot failed"></span><span>${esc(message)}</span>`;
    }
    elements.agentLiveStatus.textContent = message;
  }
  if (isActive) finishActiveAgentUi(operation.operationId, message);
  renderAgentSessions();
  if (!elements.historyPanel.hidden) loadAgentHistory();
  setSystemMessage(message, "error");
  if (continueRecovery) scheduleAgentResultRecovery(operation, 5_000);
  else stopAgentResultRecovery(operation);
}

function renderUnverifiedAgentPartial(partial, existingNode = null) {
  if (!partial || partial.threadId !== state.activeSessionId) return;
  const node = existingNode ?? elements.agentThread.querySelector(`[data-operation-id="${CSS.escape(partial.operationId)}"]`);
  const article = document.createElement("article");
  article.className = "agent-card transcript-message provisional-fallback";
  article.dataset.operationId = partial.operationId;
  article.dataset.partial = "true";
  const notice = document.createElement("div");
  notice.className = "provisional-fallback-notice";
  notice.textContent = partial.message;
  const body = document.createElement("div");
  body.className = "agent-card-body model-response";
  if (partial.text && window.CockpitMarkdown?.renderMarkdown) window.CockpitMarkdown.renderMarkdown(body, partial.text);
  else body.textContent = partial.text || "尚未收到可展示文本；原对话与工具记录仍由 Codex 保留。";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "save-plan";
  open.dataset.openOriginalThread = partial.threadId;
  open.textContent = "打开原对话 / 重新读取";
  article.append(notice, body, open);
  if (node) node.replaceWith(article);
  else elements.agentThread.append(article);
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
      startedAt: activeAgent?.startedAt ?? null,
      startedAtMs: Date.parse(String(activeAgent?.startedAt ?? "")) || Date.now(),
      status: "running",
      progress: "正在重新接入后台 Codex 分析…",
      task: String(activeAgent?.task ?? ""),
      streamText: "",
      finalText: "",
      streamBuffers: new Map(),
      streamOrder: [],
      toolEvents: new Map(),
    };
    if (!markLatestThreadOperation(operation)) return;
    state.operations.set(operationId, operation);
  } else if (!markLatestThreadOperation(operation)) {
    return;
  }
  if (operation.threadId !== state.activeSessionId) return;
  const node = createOperationNode(operation);
  state.activeRequestId = operationId;
  state.activeRunNode = node;
  elements.agentThread.append(node);
  elements.agentCancel.hidden = false;
  elements.agentSubmit.disabled = true;
  elements.agentLiveStatus.textContent = "后台 Codex 分析仍在运行";
  scheduleAgentResultRecovery(operation, 5_000);
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
  const runStale = stale || isRunStale(run);
  const wrapper = document.createElement("section");
  wrapper.className = `agent-run${runStale ? " stale" : ""}`;
  wrapper.dataset.runId = run.id;
  wrapper.dataset.stale = String(runStale);
  wrapper.dataset.sizingExpired = String(candidateSizingExpired(run.risk));
  const renderers = {
    conclusion: () => conclusionCard(run),
    technical: () => technicalCard(run.technical),
    fib: () => fibCard(
      run.technical?.fib,
      run.technical?.lastPrice,
      run.risk?.fibonacciReview
        ?? run.risk?.sizingReview?.fibonacciReview
        ?? run.risk?.sizingReview?.fibReview,
    ),
    risk: () => riskCard(run.risk),
    plan: () => planCard(run.plan),
    evidence: () => evidenceCard(run),
  };
  const requestedSections = run.context?.scope === "chat"
    ? ["conclusion"]
    : run.sections ?? Object.keys(renderers);
  const conclusion = requestedSections.includes("conclusion") ? conclusionCard(run) : "";
  const structuredSections = requestedSections
    .filter((name) => name !== "conclusion" && renderers[name])
    .map((name) => renderers[name]());
  const structuredModuleCount = structuredSections.length;
  const notices = [];
  if (runStale) {
    notices.push(`<div class="run-state"><span class="evidence-dot degraded"></span><span>${run.context?.scope === "review"
      ? run.context?.reviewPhasePersistence === "failed"
        ? "分析已返回，但没有写入不可变审计台账；该结果不能登记验证草案，请重新运行。"
        : "关联订单的证据版本已经变化；此结果已标记为历史产物，请基于最新关联完整重跑。"
      : run.context?.scope === "chat"
        ? "分析范围已切换；这条自由研究结论保留在原对话中供回看。"
      : "账户快照、仓位裁决有效期或分析选择已失效；此结果仅供回看，不能保存为当前计划。"}</span></div>`);
  }
  if (run.plan?.available && requestedSections.includes("plan")) {
    structuredSections.push(`<button class="save-plan" type="button" data-save-plan="${esc(run.id)}" ${runStale ? "disabled" : ""}>${runStale ? "上下文或裁决已失效 · 请刷新后重新运行" : "保存为静态计划快照 · 不监控、不下单"}</button>`);
  }
  const structured = structuredSections.length
    ? `<details class="structured-evidence"><summary><span>展开结构化证据</span><strong>${structuredModuleCount} 个模块 · 市场证据 / 风险 / 计划</strong></summary><div class="structured-evidence-body">${structuredSections.join("")}</div></details>`
    : "";
  const adjudication = run.context?.scope === "candidate"
    ? candidateAdjudicationCard(run.risk, { stale: runStale })
    : "";
  const learning = run.learningProposal ? learningProposalCard(run, { stale: runStale }) : "";
  const research = run.context?.researchThesisId ? `<article class="agent-card">
    <h3>研究主线 · ${esc(run.context.researchTitle || "已关联记录")}</h3>
    <p>${run.context.researchProposalPersistence === "recorded_pending_confirmation"
      ? "AI 草案已保存，尚未替换你的判断；回到研究主线编辑并确认。"
      : run.context.researchProposalPersistence === "not_saved"
        ? "回答已返回，但草案未保存。原判断未改变，请刷新研究记录后重试。"
        : "本轮讨论已保留在当前对话中，不会自动改写研究记录。"}</p>
    <button class="save-plan" type="button" data-open-research="${esc(run.context.researchThesisId)}">查看研究记录${run.context.researchProposalId ? "与草案" : ""}</button>
  </article>` : "";
  wrapper.innerHTML = `${notices.join("")}${conclusion}${research}${learning}${adjudication}${structured}`;
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

function learningProposalCard(run, { stale = false } = {}) {
  const proposal = run.learningProposal;
  const test = proposal?.testDesign ?? {};
  const rule = proposal?.candidateRule ?? {};
  return `<article class="agent-card learning-proposal-card">
    <div class="agent-card-head"><span>AI VALIDATION DRAFT</span><strong>HUMAN CONFIRMATION</strong></div>
    <div class="agent-card-body">
      <h3>${esc(rule.title || "从本次复盘生成验证草案")}</h3>
      <p>${esc(proposal.hypothesis || "—")}</p>
      <div class="learning-proposal-summary"><span>${esc(test.metric || "待定指标")}</span><span>${esc(test.window || "待定窗口")}</span><span>至少 ${number(test.minCases, 0)} 个案例</span><span>${esc(String(proposal.confidence || "unknown").toUpperCase())}</span></div>
      <p class="learning-proposal-caveat">事后草案不会回写为事前判断；确认后只登记为待验证假设。</p>
      <button class="save-plan learning-proposal-open" type="button" data-open-learning-proposal="${esc(run.id)}" ${stale ? "disabled" : ""}>${stale ? "证据已更新 · 请重新复盘" : "打开验证草案并确认"}</button>
    </div>
  </article>`;
}

function contextDeliveryPresentation(value) {
  return ({
    complete: { label: "完整交付", tone: "complete" },
    complete_with_declared_omissions: { label: "有声明省略", tone: "degraded" },
    rejected_budget: { label: "超限拒绝", tone: "rejected" },
  })[String(value ?? "")] ?? { label: "状态未知", tone: "unknown" };
}

function contextBytesLabel(value) {
  const bytes = finiteUiNumber(value);
  if (bytes == null) return "—";
  if (bytes < 1024) return `${number(bytes, 0)} B`;
  return `${number(bytes / 1024, 1)} KiB`;
}

function shortContextBundleHash(value) {
  const hash = String(value ?? "").trim().replace(/^sha256:/i, "");
  return hash ? hash.slice(0, 12).toUpperCase() : "—";
}

function evidencePassport(model) {
  const diagnostics = model?.contextDiagnostics;
  const requestedSkills = [...new Set((Array.isArray(model?.requestedSkills) ? model.requestedSkills : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean))];
  if (!diagnostics && !requestedSkills.length) return "";
  const delivery = contextDeliveryPresentation(diagnostics?.deliveryStatus);
  const blocks = firstFiniteUi(diagnostics?.totalBlockCount, diagnostics?.payloadBlockCount);
  const bytes = firstFiniteUi(diagnostics?.totalUtf8Bytes, diagnostics?.payloadUtf8Bytes);
  const omissions = Array.isArray(diagnostics?.semanticOmissions)
    ? diagnostics.semanticOmissions.filter((item) => finiteUiNumber(item?.omittedCount) > 0)
    : [];
  const omittedRecords = omissions.reduce(
    (sum, item) => sum + (finiteUiNumber(item?.omittedCount) ?? 0),
    0,
  );
  const omissionLabel = omissions.length
    ? `${number(omissions.length, 0)} 项 / ${number(omittedRecords, 0)} 条`
    : "无声明省略";
  const skillLabel = requestedSkills.length
    ? requestedSkills.join(" · ")
    : "本轮未显式请求 Skill";
  return `<section class="evidence-passport ${esc(delivery.tone)}">
    <div class="evidence-passport-head"><span>EVIDENCE PASSPORT</span><strong>${esc(delivery.label)}</strong></div>
    <div class="evidence-passport-grid"><span>${blocks == null ? "—" : number(blocks, 0)} BLOCKS</span><span>${esc(contextBytesLabel(bytes))}</span><span>OMISSIONS ${esc(omissionLabel)}</span><span>BUNDLE ${esc(shortContextBundleHash(diagnostics?.bundleHash))}</span></div>
    <p><strong>本轮 Skills</strong><span>${esc(skillLabel)}</span></p>
  </section>`;
}

function conclusionCard(run) {
  const model = run.modelAnalysis;
  const completedToolEvents = (model?.toolEvents ?? [])
    .filter((item) => item.lifecycle === "completed");
  const toolLabels = completedToolEvents
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
      ${evidencePassport(model)}
      <div class="workspace-meta"><span>PERSISTENT</span><span>${esc(model?.threadId?.slice(0, 12) ?? "THREAD")}</span>${firstActivityMeta}<span>${number(completedToolEvents.length, 0)} TOOL EVENTS</span>${toolLabels}</div>
    </div>
  </article>`;
}

function technicalCard(technical) {
  if (!technical?.ema || !Object.keys(technical.ema).length) {
    return `<article class="agent-card"><div class="agent-card-head"><span>EMA STRUCTURE</span><strong class="negative">DEGRADED</strong></div><div class="agent-card-body"><p>${esc(technical?.reason || "无行情数据")}</p></div></article>${dailySequenceCard(technical)}${technicalV2Card(technical)}${tierBTechnicalCard(technical)}`;
  }
  const periods = [3, 5, 8, 13, 21, 144, 169];
  const lastBarStatus = String(technical.lastBar?.status ?? "UNKNOWN").toUpperCase();
  const officialBarCount = finiteUiNumber(
    technical.calculationBarCount
      ?? technical.calculation?.completedBarCount
      ?? technical.candleCount,
  );
  const inputSource = String(technical.emaMethod?.inputSource ?? "unknown").toUpperCase();
  const seed = String(technical.emaMethod?.seed ?? "unknown").toUpperCase();
  const timeframe = String(technical.timeframe ?? "1D").toUpperCase();
  const adjustLabel = {
    forward: "前复权",
    backward: "后复权",
    none: "不复权",
    unadjusted: "不复权",
  }[String(technical.adjustType ?? "").toLowerCase()] ?? "复权口径未知";
  const tradeSessionLabel = {
    regular_hours: "常规时段",
    regular: "常规时段",
    intraday: "含盘中",
    extended_hours: "含盘前盘后",
    all: "全时段",
  }[String(technical.tradeSession ?? "").toLowerCase()] ?? "交易时段未知";
  const asOfTradingDate = technical.asOfTradingDate
    ?? technical.lastBar?.tradingDate
    ?? (technical.asOf ? shortDate(technical.asOf) : "—");
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
    const slope = technical.emaSlope5d?.[period];
    const slopeClass = slope > 0 ? "slope-up" : slope < 0 ? "slope-down" : "";
    const arrow = slope > 0 ? "↑" : slope < 0 ? "↓" : "—";
    const maturity = emaMaturityLabel(technical.emaMaturity?.[period], value);
    return `<div class="ema-cell"><span>EMA${period}<em class="${slopeClass}">${arrow} ${signedPercent(slope)}</em></span><strong>${number(value)}</strong><small class="ema-maturity ${esc(maturity.className)}">${esc(maturity.label)}</small></div>`;
  }).join("");
  const longMaturity = [144, 169].map((period) => {
    const maturity = emaMaturityLabel(technical.emaMaturity?.[period], technical.ema[period]);
    return `<span class="${esc(maturity.className)}">EMA${period} ${esc(maturity.label)}</span>`;
  }).join("");
  const provisional = technical.provisional?.available || lastBarStatus === "FORMING";
  const closureUnknown = lastBarStatus === "UNKNOWN";
  const provisionalNotice = provisional
    ? `<div class="provisional-warning"><strong>PROVISIONAL</strong><span>最新输入日 K 为 ${esc(lastBarStatus)}${technical.provisional?.close != null ? ` · close ${number(technical.provisional.close)}` : ""}，已从官方 EMA / Fib 计算排除。</span></div>`
    : closureUnknown
      ? `<div class="provisional-warning unknown"><strong>CLOSURE UNKNOWN</strong><span>结果未提供最后一根日 K 的 CLOSED / FORMING 证明；不要把最新值视为最终收盘值。</span></div>`
      : "";
  return `<article class="agent-card">
    <div class="agent-card-head"><span>EMA STRUCTURE</span><strong class="bar-status ${esc(lastBarStatus.toLowerCase())}">${esc(lastBarStatus)}</strong></div>
    <div class="agent-card-body">
      <div class="calculation-passport">
        <span>${esc(timeframe)}</span>
        <span>${esc(inputSource === "CLOSE" ? "CLOSE EMA" : `${inputSource} EMA`)}</span>
        <span>${esc(seed === "SMA" ? "SMA SEED" : `${seed} SEED`)}</span>
        <span>${esc(adjustLabel)}</span>
        <span>${esc(tradeSessionLabel)}</span>
        <span>${officialBarCount == null ? "OFFICIAL BARS UNKNOWN" : `${number(officialBarCount, 0)} OFFICIAL BARS`}</span>
        <span>AS OF ${esc(asOfTradingDate)}</span>
      </div>
      ${provisionalNotice}
      <div class="structure-line">${esc(inequality)}</div>
      <div class="ema-grid">${emaCells}</div>
      <div class="cycle-verdict"><div><span>时点层 · 3/5/8/13/21</span><strong>${esc(technical.shortStructure)}</strong></div><div><span>核心周期 · 144/169</span><strong>${esc(technical.longStructure)}</strong></div></div>
      <div class="long-ema-maturity"><strong>LONG EMA MATURITY</strong>${longMaturity}</div>
    </div>
  </article>${dailySequenceCard(technical)}${technicalV2Card(technical)}${tierBTechnicalCard(technical)}`;
}

function dailySequenceCard(technical) {
  const sequence = technical?.dailySequence ?? null;
  const market = technical?.marketData ?? null;
  const matrix = technical?.capabilityMatrix ?? {};
  const gate = market?.freshForSizing
    ? { label: "SIZING READY", className: "positive" }
    : market?.freshForDecision
      ? { label: "DECISION READY", className: "warning" }
      : market?.freshForResearch
        ? { label: "RESEARCH ONLY", className: "warning" }
        : { label: "UNAVAILABLE", className: "negative" };
  const metric = (value, kind = "number") => {
    if (value?.status !== "available" || !Number.isFinite(Number(value?.value))) return "N/A";
    if (kind === "percent") return signedPercent(Number(value.value));
    if (kind === "multiple") return `${number(Number(value.value), 2)}×`;
    return number(Number(value.value), 2);
  };
  const cells = [
    ["1D RETURN", metric(sequence?.metrics?.returns?.["1"], "percent")],
    ["5D RETURN", metric(sequence?.metrics?.returns?.["5"], "percent")],
    ["20D RETURN", metric(sequence?.metrics?.returns?.["20"], "percent")],
    ["CLV", metric(sequence?.metrics?.closeLocationValue)],
    ["TR / ATR14", metric(sequence?.metrics?.normalizedTrueRangeAtr14, "multiple")],
    ["GAP", metric(sequence?.metrics?.gapPercent, "percent")],
    ["REL VOL20", metric(sequence?.metrics?.relativeVolume20, "multiple")],
    ["EFFICIENCY20", metric(sequence?.metrics?.directionalEfficiency?.["20"])],
    ["5D VS QQQ", metric(technical?.benchmarkRelativeStrength?.excessReturns?.windows?.["5"], "percent")],
    ["20D VS QQQ", metric(technical?.benchmarkRelativeStrength?.excessReturns?.windows?.["20"], "percent")],
  ].map(([label, value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");
  const capabilities = Object.entries(matrix).map(([key, status]) => (
    `<span class="capability-${esc(String(status))}">${esc(key)} · ${esc(String(status).toUpperCase())}</span>`
  )).join("");
  const source = market?.source ?? "unknown";
  const latest = market?.latestTradeDate ?? technical?.asOfTradingDate ?? "—";
  const expected = market?.expectedLatestTradeDate ?? "—";
  const hash = sequence?.inputHash ? String(sequence.inputHash).slice(0, 12) : "—";
  return `<article class="agent-card sequence-evidence-card">
    <div class="agent-card-head"><span>DAILY SEQUENCE & DATA PASSPORT</span><strong class="${esc(gate.className)}">${esc(gate.label)}</strong></div>
    <div class="agent-card-body">
      <div class="calculation-passport">
        <span>${esc(String(source).toUpperCase())}</span>
        <span>LATEST ${esc(latest)}</span>
        <span>EXPECTED ${esc(expected)}</span>
        <span>${esc(sequence?.methodVersion ?? "daily-sequence unavailable")}</span>
        <span>HASH ${esc(hash)}</span>
      </div>
      <div class="sequence-grid">${cells}</div>
      <div class="capability-matrix">${capabilities}</div>
      ${Array.isArray(market?.reasonCodes) && market.reasonCodes.length
        ? `<p class="sequence-limitation">${esc(market.reasonCodes.join(" · "))}</p>`
        : ""}
    </div>
  </article>`;
}

function technicalV2Card(technical) {
  const value = technical?.technicalV2;
  if (!value) return "";
  const weeklyCapability = value.capabilityMatrix?.weeklyStructure ?? {};
  const hourlyCapability = value.capabilityMatrix?.execution60m ?? {};
  const weekly = value.weekly ?? {};
  const hourly = value.execution60m ?? {};
  const costCapability = value.capabilityMatrix?.costProfile14d28d ?? {};
  const cost = value.costProfile14d28d ?? {};
  const cost14 = cost.profiles?.["14"] ?? {};
  const cost28 = cost.profiles?.["28"] ?? {};
  const avwapCapability = value.capabilityMatrix?.anchoredVwap ?? {};
  const avwapReview = value.anchoredVwap ?? {};
  const avwap = avwapReview.evidence ?? {};
  const hourlyLoad = value.loads?.hourly60m ?? {};
  const statusClass = (status) => status === "complete"
    ? "positive"
    : status === "warming" || status === "partial"
      ? "warning"
      : "negative";
  const statusLabel = (status) => String(status ?? "unavailable").toUpperCase();
  const metricRows = (items) => items.map(([label, metric]) => (
    `<div><span>${esc(label)}</span><strong>${esc(metric == null ? "N/A" : String(metric))}</strong></div>`
  )).join("");
  const weeklyMetrics = [
    ["4W", signedPercent(weekly.metrics?.return4WeeksPercent)],
    ["12W", signedPercent(weekly.metrics?.return12WeeksPercent)],
    ["SWING", weekly.swing ?? "N/A"],
    ["DIRECTION", weekly.direction ?? "N/A"],
  ];
  const hourlyMetrics = [
    ["STATE", hourly.executionState ?? "N/A"],
    ["1 BAR", signedPercent(hourly.metrics?.return1BarPercent)],
    ["3 BARS", signedPercent(hourly.metrics?.return3BarsPercent)],
    ["EMA 3/5/8/13/21", hourly.ema
      ? [3, 5, 8, 13, 21].map((period) => number(hourly.ema?.[period]?.value)).join(" / ")
      : "N/A"],
  ];
  const priceRange = (low, high) => low == null || high == null
    ? "N/A"
    : `${number(low)} – ${number(high)}`;
  const costMetrics = [
    ["14D POC", cost14.poc == null ? "N/A" : number(cost14.poc)],
    ["14D VA", priceRange(cost14.val, cost14.vah)],
    ["28D POC", cost28.poc == null ? "N/A" : number(cost28.poc)],
    ["MIGRATION", cost.comparison?.migrationState ?? "N/A"],
    ["14D ACCEPT", cost14.acceptance?.state ?? "N/A"],
    ["28D ACCEPT", cost28.acceptance?.state ?? "N/A"],
    ["PRICE LOC 14", cost14.currentPriceLocation ?? "N/A"],
    ["PRICE LOC 28", cost28.currentPriceLocation ?? "N/A"],
  ];
  const avwapMetrics = [
    ["ANCHOR", avwap.anchor?.barId ? String(avwap.anchor.barId).slice(0, 10) : "N/A"],
    ["AVWAP", avwap.vwap == null ? "N/A" : number(avwap.vwap)],
    ["CLOSE", avwap.asOfClose == null ? "N/A" : number(avwap.asOfClose)],
    ["DIST", signedPercent(avwap.priceRelation?.differencePercent)],
  ];
  const finality = hourlyLoad.finality;
  const coverage = hourlyLoad.coverage;
  const hourlyLimitation = hourlyLoad.error?.message
    ?? (hourlyCapability.status === "complete"
      ? `完结证明：${finality?.method ?? "host_attested"}；末根：${finality?.terminalBarStatus ?? "unknown"}`
      : "60 分钟证据未达到本轮实时、完整、可证明完结的执行标准。");
  return `<article class="agent-card multi-timeframe-card">
    <div class="agent-card-head"><span>MULTI-TIMEFRAME · V2</span><strong>${esc(String(value.schemaVersion ?? ""))}</strong></div>
    <div class="agent-card-body">
      <section class="timeframe-layer">
        <header><span>1W STRUCTURE</span><strong class="${esc(statusClass(weeklyCapability.status))}">${esc(statusLabel(weeklyCapability.status))}</strong></header>
        <div class="sequence-grid">${metricRows(weeklyMetrics)}</div>
        <p>${esc(`来源 ${weeklyCapability.source ?? "unavailable"} · ${weeklyCapability.barCount ?? 0} 根已完成周 K · 末周固定排除`)}</p>
      </section>
      <section class="timeframe-layer">
        <header><span>60M EXECUTION</span><strong class="${esc(statusClass(hourlyCapability.status))}">${esc(statusLabel(hourlyCapability.status))}</strong></header>
        <div class="sequence-grid">${metricRows(hourlyMetrics)}</div>
        <p>${esc(`${hourlyLimitation}${coverage?.fetchedAt ? ` · fetched ${shortTime(coverage.fetchedAt)}` : ""}`)}</p>
      </section>
      <section class="timeframe-layer proxy-layer">
        <header><span>14/28D COST CONCENTRATION</span><strong class="warning">${esc(costCapability.status === "unavailable" ? "UNAVAILABLE" : "PROXY · LOW")}</strong></header>
        <div class="sequence-grid">${metricRows(costMetrics)}</div>
        <p>${esc(costCapability.status === "unavailable"
          ? `代理不可用 · ${(costCapability.reasonCodes ?? []).join(", ") || "样本不足"}`
          : `80 bins · uniform range · 70% value area · ${String(cost.input?.inputHash ?? "").slice(0, 12)} · 仅为日线 OHLCV 价格-成交量集中估算，不是逐笔筹码、机构持仓或真实持有人成本。`)}</p>
      </section>
      <section class="timeframe-layer avwap-layer">
        <header><span>ANCHORED VWAP</span><strong class="${esc(avwapReview.status === "selected" ? "positive" : avwapReview.status === "invalid" ? "negative" : "warning")}">${esc(avwapReview.status === "selected" ? "HOST VERIFIED" : avwapReview.status === "invalid" ? "HOST REJECTED" : avwapReview.status === "ignored" ? "LLM IGNORED" : "AWAITING LLM")}</strong></header>
        <div class="sequence-grid">${metricRows(avwapMetrics)}</div>
        <p>${esc(avwapReview.status === "selected"
          ? `${avwap.anchor?.reason ?? "显式锚点"} · HLC3×volume · ${avwap.inputHash ? `HASH ${String(avwap.inputHash).slice(0, 12)} · ` : ""}辅助证据，无 sizing / invalidation 权限`
          : avwapReview.reason ?? "只有 LLM 从本轮已完成 priceBars 显式选择锚点后，宿主才会复算；不会自动挑锚。")}</p>
      </section>
    </div>
  </article>`;
}

function tierBTechnicalCard(technical) {
  const value = technical?.tierB;
  if (!value) return "";
  const layerNames = [
    ["daily", "1D"],
    ["weekly", "1W"],
    ["execution60m", "60M"],
    ["benchmark", "QQQ"],
    ["sector", "SECTOR"],
    ["peers", "PEERS"],
    ["anchoredVwap", "AVWAP"],
    ["options", "OPTIONS"],
    ["catalyst", "EVENTS"],
  ];
  const layerClass = (status) => status === "available"
    ? "positive"
    : status === "partial" ? "warning" : "negative";
  const layers = layerNames.map(([key, label]) => {
    const layer = value.layers?.[key] ?? {};
    const reason = Array.isArray(layer.reasonCodes) ? layer.reasonCodes.join(" · ") : "";
    return `<span class="tier-b-layer ${esc(layerClass(layer.status))}" title="${esc(reason || "无额外限制")}"><b>${esc(label)}</b><i>${esc(String(layer.status ?? "unavailable").toUpperCase())}</i></span>`;
  }).join("");
  const linkage = value.linkage ?? {};
  const linkageText = linkage.status === "confirmed"
    ? `${linkage.sectorSymbol ?? "无行业ETF"}${Array.isArray(linkage.peerSymbols) && linkage.peerSymbols.length ? ` · ${linkage.peerSymbols.join(" / ")}` : ""}`
    : "未确认行业 / 同行映射";
  const errors = Array.isArray(value.relatedLoadErrors) ? value.relatedLoadErrors : [];
  const inputHash = value.inputHash ? String(value.inputHash).slice(0, 12) : "N/A";
  const cutoff = value.cutoff?.tradingDate ?? "N/A";
  const optionsStatus = value.layers?.options?.status ?? "unavailable";
  const catalystStatus = value.layers?.catalyst?.status ?? "unavailable";
  return `<article class="agent-card tier-b-card">
    <div class="agent-card-head"><span>SELECTED SYMBOL · TIER-B EVIDENCE</span><strong class="${esc(value.status === "complete" ? "positive" : value.status === "partial" ? "warning" : "negative")}">${esc(String(value.status ?? "unavailable").toUpperCase())}</strong></div>
    <div class="agent-card-body">
      <div class="calculation-passport"><span>CUTOFF ${esc(cutoff)}</span><span>NO FORWARD-FILL</span><span>COMPLETED BARS</span><span>HASH ${esc(inputHash)}</span></div>
      <div class="tier-b-layer-grid">${layers}</div>
      <div class="tier-b-notes">
        <p><strong>确认联动</strong>${esc(linkageText)}${errors.length ? ` · ${esc(String(errors.length))} 个读取缺口` : ""}</p>
        <p><strong>证据边界</strong>${esc(`Options ${String(optionsStatus).toUpperCase()} · Events ${String(catalystStatus).toUpperCase()} · 无显式锚点则 AVWAP=N/A · 不由 OI 推断 dealer gamma`)}</p>
      </div>
    </div>
  </article>`;
}

function emaMaturityLabel(maturity, value) {
  if (!maturity || typeof maturity !== "object") {
    return Number.isFinite(Number(value))
      ? { label: "MATURITY UNKNOWN", className: "unknown" }
      : { label: "UNAVAILABLE", className: "unavailable" };
  }
  const status = String(maturity.status ?? "").toLowerCase();
  const barCount = finiteUiNumber(maturity.barCount);
  const required = finiteUiNumber(maturity.requiredBarCount);
  const progress = barCount == null || required == null
    ? ""
    : ` · ${number(barCount, 0)}/${number(required, 0)}`;
  if (maturity.mature === true || status === "mature") {
    return { label: `MATURE${progress}`, className: "mature" };
  }
  if (maturity.available === true || status === "warming") {
    return { label: `WARMING${progress}`, className: "warming" };
  }
  return { label: `UNAVAILABLE${progress}`, className: "unavailable" };
}

function fibCard(fib, lastPrice, modelReview = null) {
  const reviewStatus = String(modelReview?.status ?? "").toLowerCase();
  const selectedFib = reviewStatus === "selected" && modelReview?.selected
    ? modelReview.selected
    : null;
  const displayFib = selectedFib ?? fib;
  if (!displayFib) {
    const missingReview = reviewStatus === "invalid"
      ? `<div class="fib-llm-review rejected"><strong>HOST REJECTED · LLM Fib</strong><span>${esc(modelReview?.rationale || "LLM Fib 未通过宿主锚点校验。")}</span></div>`
      : modelReview
        ? `<div class="fib-llm-review pending"><strong>LLM 未选择可用 Fib</strong>${modelReview.rationale ? `<span>${esc(modelReview.rationale)}</span>` : ""}</div>`
        : "";
    return `<article class="agent-card"><div class="agent-card-head"><span>FIBONACCI EXTENSION</span><strong>AUTO · SKIPPED</strong></div><div class="agent-card-body"><div class="fib-policy"><span>AUTO</span><span>ADVISORY</span><strong>LLM DECIDES</strong></div>${missingReview}<p class="fib-source">没有足够的已完成 K 线生成自动三点扩展。LLM 仍须独立判断是否需要 Fib，不得把缺失值补成交易依据。</p></div></article>`;
  }
  const anchor = (key) => {
    const point = displayFib.anchors?.[key];
    if (!point) return "";
    return `<div><span>${selectedFib ? "LLM" : "AUTO"} ${key.toUpperCase()}</span><strong>${number(point.price)}</strong><small>${esc(point.date ?? point.barId)}</small></div>`;
  };
  const levels = [0.382, 0.618, 1, 1.618].map((ratio) => {
    const value = displayFib.levels?.[String(ratio)];
    const distance = lastPrice ? ((value - lastPrice) / lastPrice) * 100 : null;
    return `<div class="fib-level"><span>${ratio}</span><i></i><strong>${number(value)} · ${signedPercent(distance)}</strong></div>`;
  }).join("");
  const reviewDecision = String(modelReview?.decision ?? "").toLowerCase();
  const reviewLabels = {
    use_auto: "LLM 采用自动锚点",
    override: "LLM 已覆盖自动锚点",
    ignore: "LLM 忽略自动 Fib",
    insufficient_evidence: "LLM 判断证据不足",
  };
  const reviewClass = reviewStatus === "invalid"
    ? "rejected"
    : reviewStatus === "selected"
      ? "selected"
      : "pending";
  const reviewLabel = reviewStatus === "invalid"
    ? "HOST REJECTED · LLM Fib"
    : reviewLabels[reviewDecision] ?? "LLM 已复核";
  const reviewMarkup = modelReview
    ? `<div class="fib-llm-review ${esc(reviewClass)}"><strong>${esc(reviewLabel)}</strong>${modelReview.rationale ? `<span>${esc(modelReview.rationale)}</span>` : ""}</div>`
    : `<div class="fib-llm-review pending"><strong>等待 LLM 复核</strong><span>自动锚点可被采用、覆盖或忽略。</span></div>`;
  return `<article class="agent-card">
    <div class="agent-card-head"><span>FIBONACCI EXTENSION</span><strong>${selectedFib ? "LLM SELECTED · HOST CALCULATED" : "AUTO · ADVISORY"}</strong></div>
    <div class="agent-card-body">
      <div class="fib-policy"><span>${selectedFib ? "LLM" : "AUTO"} ${displayFib.direction === "up" ? "UP" : "DOWN"}</span><span>${selectedFib ? "SELECTED" : "ADVISORY"}</span><strong>${selectedFib ? "HOST VERIFIED" : "LLM DECIDES"}</strong></div>
      <div class="fib-anchors">${anchor("a")}${anchor("b")}${anchor("c")}</div>
      <div class="fib-levels">${levels}</div>
      ${reviewMarkup}
      <p class="fib-source">${selectedFib
        ? `当前展示 LLM 选择的锚点；价格和 0.382 / 0.618 / 1 / 1.618 均由宿主按 ${esc(displayFib.formula || "C + (B - A) × ratio")} 复算。`
        : `${esc(fib.source || "自动波段锚点")}。自动 Fib 只作为候选证据，不是最终失效位、目标位或仓位指令。`}</p>
    </div>
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

function candidateAdjudicationCard(risk, { stale = false } = {}) {
  if (!risk) return "";
  const sizingReview = risk.sizingReview ?? {};
  const reviewStatus = String(sizingReview.status ?? "").toLowerCase();
  const expired = candidateSizingExpired(risk);
  const acceptanceExpired = expired
    && risk.entryAllowed === true
    && ["llm_reviewed", "bounded"].includes(reviewStatus);
  const llmProposal = sizingReview.modelProposal
    ?? sizingReview.llmProposed
    ?? sizingReview.proposed
    ?? {};
  const hostAcceptance = sizingReview.hostAccepted ?? sizingReview.accepted ?? {};
  const hardLimits = sizingReview.hardLimits ?? {};
  const proposedInitial = firstFiniteUi(
    llmProposal.initialAdditionalWeightPercent,
    llmProposal.recommendedInitialAdditionalWeightPercent,
    sizingReview.llmProposedInitialAdditionalWeightPercent,
    sizingReview.proposedInitialAdditionalWeightPercent,
  );
  const proposedMaxTotal = firstFiniteUi(
    llmProposal.maxTotalWeightPercent,
    llmProposal.recommendedMaxTotalWeightPercent,
    sizingReview.llmProposedMaxTotalWeightPercent,
    sizingReview.proposedMaxTotalWeightPercent,
  );
  const acceptedInitial = firstFiniteUi(
    hostAcceptance.initialAdditionalWeightPercent,
    hostAcceptance.recommendedInitialAdditionalWeightPercent,
    sizingReview.hostAcceptedInitialAdditionalWeightPercent,
    risk.recommendedInitialAdditionalWeightPercent,
  );
  const acceptedMaxTotal = firstFiniteUi(
    hostAcceptance.maxTotalWeightPercent,
    hostAcceptance.recommendedMaxTotalWeightPercent,
    sizingReview.hostAcceptedMaxTotalWeightPercent,
    risk.recommendedMaxWeightPercent,
  );
  const hardMaxTotal = firstFiniteUi(
    risk.hardMaxTotalWeightPercent,
    sizingReview.hardMaxTotalWeightPercent,
    hardLimits.accountAndConcentrationTotalWeightPercent,
  );
  const bindings = candidateLimitBindings({
    risk,
    sizingReview,
    reviewStatus,
    proposedMaxTotal,
    acceptedMaxTotal,
    hardMaxTotal,
  });
  const status = acceptanceExpired
    ? "HOST ACCEPTANCE EXPIRED"
    : reviewStatus === "blocked"
      ? "HOST BLOCKED"
      : reviewStatus === "bounded"
        ? "HOST BOUNDED"
        : reviewStatus === "llm_reviewed"
          ? risk.entryAllowed ? "HOST ACCEPTED" : "NO ENTRY"
          : "AWAITING LLM";
  const tone = reviewStatus === "blocked"
      ? "blocked"
      : acceptanceExpired
        ? "expired"
      : reviewStatus === "bounded"
        ? "bounded"
        : reviewStatus === "llm_reviewed" && risk.entryAllowed
          ? "accepted"
          : "pending";
  const historical = acceptanceExpired || stale;
  const decisionAt = sizingReview.decisionAt ?? null;
  const validUntil = risk.sizingValidUntil ?? null;
  const group = sizingReview.candidateGroupKey
    ?? sizingReview.requestedGroupKey
    ?? risk.group
    ?? "未分类";
  const stage = sizingReview.narrativeStage ?? risk.stageAssumption ?? "unknown";
  const invalidation = sizingReview.invalidation?.label
    ?? risk.referenceLabel
    ?? "未通过主机校验";
  return `<article class="candidate-adjudication ${esc(tone)}">
    <div class="candidate-adjudication-head">
      <span>HOST ADJUDICATION · 常驻裁决摘要</span>
      <strong>${esc(status)}</strong>
    </div>
    ${acceptanceExpired ? `<div class="candidate-expiry-warning"><strong>不可执行</strong><span>仓位裁决已超过 SIZING VALID UNTIL；HOST ACCEPTED 数值仅保留为历史记录。请刷新长桥持仓后重新运行。</span></div>` : ""}
    <div class="candidate-adjudication-grid">
      <div><span>LLM PROPOSAL</span><strong>初始 ${percent(proposedInitial)} · 最大 ${percent(proposedMaxTotal)}</strong></div>
      <div class="${historical ? "historical" : ""}"><span>${historical ? "HOST ACCEPTED · HISTORICAL" : "HOST ACCEPTED"}</span><strong>初始 ${percent(acceptedInitial)} · 最大 ${percent(acceptedMaxTotal)}</strong></div>
      <div><span>HARD MAX</span><strong>${percent(hardMaxTotal)}</strong></div>
      <div><span>主题 / Stage</span><strong>${esc(group)} · ${esc(stage)}</strong></div>
      <div><span>持有周期</span><strong>${esc(sizingReview.holdingHorizon ?? risk.holdingHorizon ?? "unknown")}</strong></div>
      <div><span>置信度 · 分类 / 仓位</span><strong>${esc(sizingReview.classificationConfidence ?? "unknown")} / ${esc(sizingReview.sizingConfidence ?? "unknown")}</strong></div>
      <div><span>失效依据</span><strong>${esc(invalidation)}</strong></div>
      <div><span>PLANNED / STRESS LOSS</span><strong>${percent(risk.plannedRiskLossPercent)} / ${percent(risk.stressRiskLossPercent)}</strong></div>
      <div><span>DECISION AT</span><strong>${decisionAt ? esc(shortDateTime(decisionAt)) : "—"}</strong></div>
      <div><span>VALID UNTIL</span><strong>${validUntil ? esc(shortDateTime(validUntil)) : "—"}</strong></div>
      <div><span>决策时快照</span><strong>${sizingReview.snapshotFreshAtDecision === true ? "FRESH" : sizingReview.snapshotFreshAtDecision === false ? "STALE" : "UNKNOWN"}</strong></div>
    </div>
    ${bindings.length ? `<div class="risk-bindings"><strong>LIMIT BINDINGS</strong>${bindings.map((item) => `<span>${esc(item)}</span>`).join("")}</div>` : ""}
  </article>`;
}

function candidateRiskCard(risk) {
  const leverage = risk.leverage ?? {};
  const sizingReview = risk.sizingReview ?? {};
  const reviewStatus = String(sizingReview.status ?? "").toLowerCase();
  const finalizedReview = ["llm_reviewed", "bounded", "blocked"].includes(reviewStatus);
  const sizingExpired = candidateSizingExpired(risk);
  const acceptanceExpired = sizingExpired
    && risk.entryAllowed === true
    && ["llm_reviewed", "bounded"].includes(reviewStatus);
  const legacyReviewed = reviewStatus === "skill_mcp_reviewed";
  const awaitingModel = risk.awaitingModelReview === true && !finalizedReview;
  const llmProposal = sizingReview.modelProposal
    ?? sizingReview.llmProposed
    ?? sizingReview.proposed
    ?? {};
  const hostAcceptance = sizingReview.hostAccepted ?? sizingReview.accepted ?? {};
  const hardLimits = sizingReview.hardLimits ?? {};
  const proposedInitial = firstFiniteUi(
    llmProposal.initialAdditionalWeightPercent,
    llmProposal.recommendedInitialAdditionalWeightPercent,
    sizingReview.llmProposedInitialAdditionalWeightPercent,
    sizingReview.proposedInitialAdditionalWeightPercent,
    sizingReview.requestedInitialAdditionalWeightPercent,
  );
  const proposedMaxTotal = firstFiniteUi(
    llmProposal.maxTotalWeightPercent,
    llmProposal.recommendedMaxTotalWeightPercent,
    sizingReview.llmProposedMaxTotalWeightPercent,
    sizingReview.proposedMaxTotalWeightPercent,
    sizingReview.requestedMaxTotalWeightPercent,
  );
  const acceptedInitial = firstFiniteUi(
    hostAcceptance.initialAdditionalWeightPercent,
    hostAcceptance.recommendedInitialAdditionalWeightPercent,
    sizingReview.hostAcceptedInitialAdditionalWeightPercent,
    risk.recommendedInitialAdditionalWeightPercent,
  );
  const acceptedMaxTotal = firstFiniteUi(
    hostAcceptance.maxTotalWeightPercent,
    hostAcceptance.recommendedMaxTotalWeightPercent,
    sizingReview.hostAcceptedMaxTotalWeightPercent,
    risk.recommendedMaxWeightPercent,
  );
  const hardMaxTotal = firstFiniteUi(
    risk.hardMaxTotalWeightPercent,
    sizingReview.hardMaxTotalWeightPercent,
    hardLimits.accountAndConcentrationTotalWeightPercent,
  );
  const hardMaxAdditional = firstFiniteUi(
    risk.hardMaxAdditionalWeightPercent,
    sizingReview.hardMaxAdditionalWeightPercent,
  );
  const hardGroupTotal = firstFiniteUi(hardLimits.groupTotalWeightPercent);
  const hardRiskBudgetTotal = firstFiniteUi(hardLimits.riskBudgetTotalWeightPercent);
  const status = acceptanceExpired
    ? "HOST ACCEPTANCE EXPIRED"
    : !risk.supported
    ? "TECHNICAL ONLY"
    : awaitingModel
      ? "AWAITING LLM"
      : reviewStatus === "blocked"
        ? "HOST BLOCKED"
        : reviewStatus === "bounded"
          ? "LLM PROPOSED · HOST BOUNDED"
          : reviewStatus === "llm_reviewed"
            ? risk.entryAllowed ? "LLM REVIEWED · HOST ACCEPTED" : "LLM REVIEWED · NO ENTRY"
            : legacyReviewed
              ? "LEGACY SKILL/MCP REVIEW"
              : risk.entryAllowed ? "HOST LEGACY RESULT" : "NO NEW RISK";
  const blockers = (risk.entryBlockReasons ?? []).filter(Boolean);
  const leverageReasons = (leverage.disabledReasons ?? []).filter(Boolean);
  const disclosure = acceptanceExpired
    ? "仓位裁决有效期已结束；下列 HOST ACCEPTED 值仅为历史裁决，不可执行。刷新长桥持仓后重新运行，主机才会重新接受仓位。"
    : awaitingModel
    ? "主机仅完成账户、快照与组合硬边界校验；等待 LLM 决定 Fib、失效位与建议仓位，自动 Fib 不会直接成为仓位指令。"
    : blockers.length
      ? blockers.join("；")
      : risk.limitation ?? risk.sizingNote;
  const limitBindings = candidateLimitBindings({
    risk,
    sizingReview,
    reviewStatus,
    proposedMaxTotal,
    acceptedMaxTotal,
    hardMaxTotal,
  });
  const reviewTone = reviewStatus === "blocked" || acceptanceExpired ? "risk-warning" : "risk-balanced";
  const acceptedLabel = acceptanceExpired ? "HOST ACCEPTED · HISTORICAL" : "HOST ACCEPTED";
  return `<article class="agent-card">
    <div class="agent-card-head"><span>ENTRY SIZE & LEVERAGE</span><strong class="${acceptanceExpired ? "negative" : ""}">${status}</strong></div>
    <div class="agent-card-body">
      ${acceptanceExpired ? `<div class="candidate-expiry-warning"><strong>不可执行</strong><span>SIZING VALID UNTIL ${risk.sizingValidUntil ? esc(shortDateTime(risk.sizingValidUntil)) : "—"} 已过期；刷新持仓并重跑后才能产生新的主机裁决。</span></div>` : ""}
      <div class="risk-grid">
        <div><span>当前持仓</span><strong>${percent(risk.existingPositionWeight ?? 0)}</strong></div>
        <div><span>LLM PROPOSED · 初始新增</span><strong>${percent(proposedInitial)}</strong></div>
        <div><span>LLM PROPOSED · 最大总仓位</span><strong>${percent(proposedMaxTotal)}</strong></div>
        <div class="${acceptanceExpired ? "historical" : ""}"><span>${acceptedLabel} · 初始新增</span><strong>${percent(acceptedInitial)}</strong></div>
        <div class="${acceptanceExpired ? "historical" : ""}"><span>${acceptedLabel} · 最大总仓位</span><strong>${percent(acceptedMaxTotal)}</strong></div>
        <div><span>HARD CEILING · 最大总仓位</span><strong>${percent(hardMaxTotal)}</strong></div>
        <div><span>HARD CEILING · 最大新增</span><strong>${percent(hardMaxAdditional)}</strong></div>
        <div><span>HARD LIMIT · 主题总仓位</span><strong>${percent(hardGroupTotal)}</strong></div>
        <div><span>HARD LIMIT · 风险预算总仓位</span><strong>${percent(hardRiskBudgetTotal)}</strong></div>
        <div><span>主机接受初始金额 / ${esc(risk.baseCurrency)}</span><strong>${money(risk.recommendedInitialNotionalBase, risk.baseCurrency)}</strong></div>
        <div><span>主机接受最大新增 / ${esc(risk.baseCurrency)}</span><strong>${money(risk.recommendedMaxAdditionalNotionalBase, risk.baseCurrency)}</strong></div>
        <div><span>风险预算</span><strong>${percent(risk.riskBudgetPercent)}</strong></div>
        <div><span>失效距离</span><strong>${percent(risk.riskDistancePercent)}</strong></div>
        <div><span>PLANNED RISK · 含滑点</span><strong>${percent(risk.plannedRiskLossPercent)}</strong></div>
        <div><span>STRESS RISK</span><strong>${percent(risk.stressRiskLossPercent)}</strong></div>
        <div><span>压力组合影响</span><strong>${signedPercent(risk.portfolioStressImpactPercent)}</strong></div>
        <div><span>${esc(risk.referenceLabel)}</span><strong>${number(risk.referenceLevel)}</strong></div>
        <div><span>新增融资权重</span><strong>${percent(leverage.maxAdditionalBorrowedWeightPercent ?? 0)}</strong></div>
        <div><span>杠杆上限</span><strong>${number(leverage.maxLeverageMultiple, 2)}×</strong></div>
        <div><span>杠杆判断</span><strong>${leverage.decision === "disabled" ? "禁止新增 / 不可评估" : leverage.decision === "margin_within_cap" ? "融资上限内 · ≤150%" : leverage.additionalLeverageAllowed ? "可复核" : "仅现金覆盖"}</strong></div>
        <div><span>DECISION AT</span><strong>${sizingReview.decisionAt ? esc(shortDateTime(sizingReview.decisionAt)) : "—"}</strong></div>
        <div><span>VALID UNTIL</span><strong>${risk.sizingValidUntil ? esc(shortDateTime(risk.sizingValidUntil)) : "—"}</strong></div>
      </div>
      ${limitBindings.length ? `<div class="risk-bindings"><strong>LIMIT BINDINGS</strong>${limitBindings.map((item) => `<span>${esc(item)}</span>`).join("")}</div>` : ""}
      ${sizingReview.rationale ? `<div class="${reviewTone}">LLM 复核：${esc(sizingReview.rationale)}</div>` : ""}
      <div class="${risk.supported && risk.entryAllowed && !acceptanceExpired ? "risk-balanced" : "risk-warning"}">${esc(disclosure)}</div>
      ${leverageReasons.length ? `<div class="risk-warning">杠杆约束：${esc(leverageReasons.join("；"))}</div>` : ""}
    </div>
  </article>`;
}

function candidateLimitBindings({
  risk,
  sizingReview,
  reviewStatus,
  proposedMaxTotal,
  acceptedMaxTotal,
  hardMaxTotal,
}) {
  const rawBindings = sizingReview.limitBindings
    ?? sizingReview.bindingConstraints
    ?? risk.limitBindings
    ?? risk.activeLimitBindings;
  const bindings = [];
  if (Array.isArray(rawBindings)) {
    for (const binding of rawBindings) {
      if (binding == null) continue;
      if (typeof binding === "object") {
        const label = binding.label ?? binding.reason ?? binding.key ?? binding.code;
        if (label) bindings.push(String(label));
      } else {
        bindings.push(String(binding));
      }
    }
  } else if (rawBindings && typeof rawBindings === "object") {
    for (const [key, value] of Object.entries(rawBindings)) {
      if (value === false || value == null) continue;
      bindings.push(value === true ? key : `${key}: ${value}`);
    }
  } else if (rawBindings) {
    bindings.push(String(rawBindings));
  }
  if (!bindings.length && reviewStatus === "bounded") {
    if (proposedMaxTotal != null && hardMaxTotal != null && proposedMaxTotal > hardMaxTotal) {
      bindings.push("LLM 最大总仓位被主机硬上限截断");
    } else if (proposedMaxTotal != null && acceptedMaxTotal != null && proposedMaxTotal > acceptedMaxTotal) {
      bindings.push("LLM 建议被主机风险边界收紧");
    } else {
      bindings.push("主机返回 bounded，但未附具体限制明细");
    }
  }
  if (!bindings.length && reviewStatus === "blocked") {
    bindings.push(...(risk.entryBlockReasons ?? []).filter(Boolean).map(String));
    if (!bindings.length) bindings.push("主机拒绝该仓位建议，但未附具体阻断明细");
  }
  return [...new Set(bindings)].slice(0, 8).map(candidateBindingLabel);
}

function candidateBindingLabel(binding) {
  const labels = {
    account_and_concentration: "账户 / 集中度硬上限",
    group_exposure: "主题暴露硬上限",
    risk_budget: "风险预算硬上限",
    stress_risk_budget: "压力风险预算硬上限",
    initial_additional: "初始新增不得超过可接受新增仓位",
  };
  return labels[binding] ?? binding;
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

function renderStorageHealth(health) {
  if (!health || typeof health !== "object") return;
  const degraded = health.encrypted === false || health.state === "degraded";
  const recovered = health.recoveredUnreadableState === true;
  const stores = Array.isArray(health.stores) ? health.stores : [];
  let chip = document.querySelector("#storage-chip");
  if (!chip) {
    chip = document.createElement("span");
    chip.id = "storage-chip";
    chip.className = "status-chip";
    chip.setAttribute("role", "status");
    elements.longbridgeChip.after(chip);
  }
  chip.hidden = !degraded && !recovered;
  chip.style.display = chip.hidden ? "none" : "";
  chip.textContent = degraded ? "本机存储降级" : "存在待恢复副本";
  chip.title = [
    degraded ? "部分本机加密状态未能读取或保存；未确认保存的更改不应视为已持久化。" : "存在原始恢复副本；请核对恢复状态，不会把空状态当作原记录。",
    ...stores.map((item) => `${item.file ?? "业务存储"} · ${item.state ?? "未知"}${item.errorCode ? ` · ${item.errorCode}` : ""}${item.lastSavedAt ? ` · 最近保存 ${item.lastSavedAt}` : ""}${item.recoveryAvailable ? " · 有恢复副本" : ""}`),
  ].join("\n");
  const key = JSON.stringify([degraded, recovered, stores.map((item) => [item.file, item.state, item.errorCode])]);
  if (degraded && key !== state.storageHealthKey) setSystemMessage("本机存储降级：请查看状态提示；本次未确认保存的变更不会冒充已落盘。", "warning");
  state.storageHealthKey = key;
}

function isLongbridgeConnectionStatus(status) {
  if (status?.domain != null) return status.domain === "longbridge";
  // Compatibility for older hosts only. Business-task messages must never
  // change connection truth or dismiss the explicit reauthorization state.
  return new Set([
    "connected", "ready", "degraded", "service_degraded", "syncing",
    "awaiting_auth", "connecting", "disconnected", "network_error",
    "reauth_required", "scope_upgrade_required", "permission_error", "error",
  ]).has(status?.state);
}

function setLongbridgeStatus(status) {
  if (!isLongbridgeConnectionStatus(status)) return;
  const connectedStates = new Set([
    "connected",
    "ready",
    "degraded",
    "service_degraded",
    "syncing",
  ]);
  const connected = connectedStates.has(status.state);
  state.longbridgeReauthRequired = status.state === "scope_upgrade_required"
    || status.state === "reauth_required";
  elements.longbridgeChip.className = `status-chip ${connected ? "connected" : ""}`;
  elements.longbridgeChip.innerHTML = `<i></i>${esc(status.message || (connected ? "长桥已连接" : "长桥未连接"))}`;
  elements.connect.textContent = state.longbridgeReauthRequired
    ? "升级只读授权"
    : connected ? "长桥已连接" : "连接长桥";
}

function agentNetworkModeLabel(mode) {
  return mode === "system" ? "跟随系统代理（实验性）"
    : mode === "inherit" ? "沿用启动环境" : "未启动／模式未知";
}

function agentNetworkRuntimeView(network) {
  if (network == null) return null; // Older hosts do not publish network evidence.
  const knownStatus = ["idle", "checking", "ready", "failed"].includes(network?.status);
  const blocked = !knownStatus || network.status === "failed";
  return {
    blocked,
    label: blocked ? "网络设置需检查"
      : network.status === "checking" ? "正在检查网络能力"
        : network.status === "ready" ? "网络配置已应用" : "等待启动",
    message: typeof network.message === "string" && network.message.trim()
      ? network.message
      : blocked ? "无法确认 Codex 网络状态，暂不能发起分析；请检查连接设置。"
        : network.status === "ready" ? "网络配置已应用；实际连通性以请求结果为准。"
          : "正在等待 Codex 网络能力检查。",
  };
}

function setAgentNetworkPreferences(value) {
  if (!elements.agentNetworkSettings) return;
  if (typeof api.setAgentNetworkPreferences !== "function" || !value || typeof value !== "object") {
    state.agentNetworkPreferences = null;
    elements.agentNetworkSettings.hidden = true;
    return;
  }
  const mode = ["inherit", "system"].includes(value.mode) ? value.mode : "unsupported";
  const effectiveMode = ["inherit", "system"].includes(value.effectiveMode) ? value.effectiveMode : "unsupported";
  state.agentNetworkPreferences = {
    mode, effectiveMode,
    requiresRestart: value.requiresRestart === true || mode !== effectiveMode,
  };
  state.agentNetworkDraft = mode === "unsupported" ? "" : mode;
  state.agentNetworkError = null;
  renderAgentNetworkPreferences();
}

function renderAgentNetworkPreferences() {
  if (!elements.agentNetworkSettings) return;
  const preferences = state.agentNetworkPreferences;
  const supported = typeof api.setAgentNetworkPreferences === "function" && Boolean(preferences);
  elements.agentNetworkSettings.hidden = !supported;
  if (!supported) return;
  const draftValid = ["inherit", "system"].includes(state.agentNetworkDraft);
  const dirty = draftValid && state.agentNetworkDraft !== preferences.mode;
  const runtime = agentNetworkRuntimeView(state.agentNetworkRuntime);
  const pending = preferences.requiresRestart;
  elements.agentNetworkMode.value = draftValid ? state.agentNetworkDraft : "";
  elements.agentNetworkMode.disabled = state.agentNetworkSaving;
  elements.agentNetworkSave.disabled = state.agentNetworkSaving || !dirty;
  elements.agentNetworkSave.textContent = state.agentNetworkSaving ? "保存中…" : "保存";
  elements.agentNetworkSettings.dataset.state = state.agentNetworkError || runtime?.blocked ? "failed"
    : dirty || pending ? "pending" : "normal";
  elements.agentNetworkSummary.textContent = state.agentNetworkSaving ? "正在保存"
    : state.agentNetworkError ? "保存失败"
      : dirty ? "未保存"
        : pending ? "已保存 · 重启后生效"
          : runtime?.blocked ? runtime.label : agentNetworkModeLabel(preferences.effectiveMode);
  elements.agentNetworkEffective.textContent = `本次启动：${agentNetworkModeLabel(preferences.effectiveMode)}`;
  elements.agentNetworkRuntime.textContent = runtime?.message ?? "尚未收到运行时网络状态，不代表连接已通过。";
  const feedback = state.agentNetworkError
    || (state.agentNetworkSaving ? "正在保存；当前网络路径与任务保持不变。" : "")
    || (dirty ? `选择尚未保存。${pending ? "之前保存的模式仍将在下次启动生效。" : "当前任务不会改变。"}` : "")
    || (pending ? `已保存：${agentNetworkModeLabel(preferences.mode)}。下次重启应用后生效，当前任务未中断。` : "");
  elements.agentNetworkFeedback.hidden = !feedback;
  elements.agentNetworkFeedback.textContent = feedback;
  elements.agentNetworkFeedback.className = `agent-network-feedback${state.agentNetworkError ? " error" : ""}`;
}

async function saveAgentNetworkPreferences(event) {
  event?.preventDefault();
  const requestedMode = state.agentNetworkDraft;
  if (state.agentNetworkSaving || typeof api.setAgentNetworkPreferences !== "function"
    || !state.agentNetworkPreferences || !["inherit", "system"].includes(requestedMode)
    || requestedMode === state.agentNetworkPreferences.mode) return;
  state.agentNetworkSaving = true;
  state.agentNetworkError = null;
  renderAgentNetworkPreferences();
  try {
    const saved = await api.setAgentNetworkPreferences({ mode: requestedMode });
    if (saved?.mode !== requestedMode || !["inherit", "system", "unsupported"].includes(saved?.effectiveMode)) {
      throw new Error("invalid_network_preferences_response");
    }
    setAgentNetworkPreferences(saved);
  } catch {
    // Keep the confirmed setting, current runtime and selection; do not expose
    // arbitrary host errors which may include environment or proxy details.
    state.agentNetworkError = "保存未获确认，当前有效模式未改变；选择已保留，可重试。";
  } finally {
    state.agentNetworkSaving = false;
    renderAgentNetworkPreferences();
  }
}

function setCodexStatus(status) {
  state.codexStatus = status;
  state.codexRuntimeAvailable = status?.available === true;
  state.agentNetworkRuntime = status?.network ?? null;
  const network = agentNetworkRuntimeView(state.agentNetworkRuntime);
  const researchMode = status?.researchMode;
  const restricted = researchMode?.kind === "restricted";
  const readOnlyGuardReady = status?.readOnlyGuardReady === true
    && status?.readOnlyGuard?.ready !== false;
  state.codexAvailable = status?.ready === true && readOnlyGuardReady
    && researchMode?.available !== false && !network?.blocked;
  elements.codexBadge.textContent = state.codexAvailable
    ? restricted ? "CODEX LIMITED" : "CODEX READY"
    : status?.ready === true && !readOnlyGuardReady
      ? "CODEX GUARD"
      : network?.blocked ? "CODEX NETWORK"
      : state.codexRuntimeAvailable ? "CODEX STARTING" : "CODEX OFF";
  elements.codexBadge.classList.toggle("unavailable", !state.codexRuntimeAvailable || Boolean(network?.blocked));
  elements.codexBadge.classList.toggle("starting", state.codexRuntimeAvailable && !state.codexAvailable && !network?.blocked);
  elements.codexBadge.classList.toggle("limited", state.codexAvailable && restricted);
  elements.codexBadge.title = state.codexAvailable
    ? restricted
      ? "研究可用·外部工具受限；本对话关闭外部 MCP / Apps，Skills、Web、项目文件与驾驶舱只读券商数据仍可使用"
      : `持久项目：${status?.workspaceDirectory ?? "stock_agent"}；Codex App Server 已就绪；交易写工具与破坏性 App 动作被禁用`
    : status?.ready === true && !readOnlyGuardReady
      ? "券商交易写工具尚未完成隔离；Agent 已停止启动分析，持仓刷新与看盘不受影响"
    : network?.blocked ? network.message
    : state.codexRuntimeAvailable
      ? "Codex App Server 正在恢复持久项目线程"
      : "未检测到本机 Codex 运行时";
  if (elements.agentAvailability) {
    const diagnostic = status?.readOnlyGuardDiagnostic ?? status?.readOnlyGuard?.diagnostic;
    const blocked = !readOnlyGuardReady && (status?.ready === true || Boolean(diagnostic));
    elements.agentAvailability.hidden = !blocked && !network?.blocked && !(state.codexAvailable && restricted);
    elements.agentAvailability.textContent = [
      blocked ? diagnostic
        ? `${diagnostic.title}：${diagnostic.message}${diagnostic.tools?.length ? ` 涉及工具：${diagnostic.tools.slice(0, 4).map(item => `${item.server}/${item.tool}`).join("、")}。` : ""} 持仓刷新与看盘仍可使用；请勿关闭防护。`
        : "Agent 暂停：券商写工具只读隔离尚未通过。请先点“重新检查只读隔离”；若仍失败，查看系统状态。持仓刷新与看盘仍可使用，请勿关闭防护。" : "",
      blocked && !restricted ? "也可新建受限研究对话：仅该新对话关闭外部 MCP / Apps，保留 Skills、Web、项目文件及驾驶舱提供的只读券商数据；原对话保留。" : "",
      state.codexAvailable && restricted ? "研究可用·外部工具受限。本对话的外部 MCP / Apps 已关闭；Skills、Web、项目文件及驾驶舱提供的只读券商数据仍可使用。可继续聊天，或新建完整工具对话重新核验；原对话保留。这不表示券商账户断开。" : "",
      network?.blocked ? `网络配置需检查：${network.message}` : "",
    ].filter(Boolean).join(" ");
    if (elements.agentGuardActions) {
      elements.agentGuardActions.hidden = !blocked && !restricted;
      elements.agentGuardRecheck.disabled = state.guardRepairBusy === true || diagnostic?.state === "checking"
        || typeof api.recheckAgentReadOnlyGuard !== "function";
      elements.agentGuardRecheck.textContent = state.guardRepairBusy || diagnostic?.state === "checking"
        ? "正在检查…" : "重新检查只读隔离";
      elements.agentGuardNewSession.hidden = diagnostic?.action !== "new_session";
      elements.agentGuardNewSession.disabled = state.guardRepairBusy === true || state.sessionsLoading === true;
      if (elements.agentRestrictedSession) {
        elements.agentRestrictedSession.hidden = !blocked || restricted;
        elements.agentRestrictedSession.disabled = state.guardRepairBusy === true || state.sessionsLoading === true
          || diagnostic?.state === "checking"
          || typeof api.agentSessions?.create !== "function";
      }
      if (elements.agentFullSession) {
        elements.agentFullSession.hidden = !restricted || researchMode?.recoveryAction !== "new_full_session";
        elements.agentFullSession.disabled = state.guardRepairBusy === true || state.sessionsLoading === true
          || diagnostic?.state === "checking"
          || typeof api.agentSessions?.create !== "function";
      }
    }
  }
  renderAgentNetworkPreferences();
  updateAgentSubmitState();
  renderAgentSessions();
}

async function recheckAgentReadOnlyGuard() {
  if (state.guardRepairBusy || typeof api.recheckAgentReadOnlyGuard !== "function") return;
  state.guardRepairBusy = true;
  if (elements.agentGuardFeedback) elements.agentGuardFeedback.textContent = "仅重新核验配置与工具清单；不发送分析、不修改授权、不重启正在运行的任务。";
  setCodexStatus(state.codexStatus);
  try {
    const capabilities = await api.recheckAgentReadOnlyGuard();
    setAgentCapabilities(capabilities);
    if (elements.agentGuardFeedback) elements.agentGuardFeedback.textContent = capabilities?.readOnlyGuardReady === true
      ? capabilities?.researchMode?.kind === "restricted"
        ? "本对话受限研究隔离已通过；外部 MCP / Apps 仍关闭。要重新启用，请显式新建完整工具对话。"
        : "只读隔离已通过，可以继续分析。"
      : "检查完成，仍未通过；请按上方原因处理。未放宽任何权限。";
  } catch {
    if (elements.agentGuardFeedback) elements.agentGuardFeedback.textContent = "检查请求未完成。请确认 Codex 已登录、网络可用后重试；若仍失败，在所有任务结束后退出并重新打开驾驶舱。原对话保留。";
  } finally {
    state.guardRepairBusy = false;
    setCodexStatus(state.codexStatus);
  }
}

function updateAgentSubmitState() {
  const active = activeOperationForThread(state.activeSessionId);
  const activeSession = state.agentSessions.find((session) => session.id === state.activeSessionId);
  elements.agentSubmit.disabled = state.busy
    || (!["chat", "review"].includes(state.analysisScope) && !state.portfolio)
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
  const restricted = (state.codexStatus?.researchMode ?? capabilities.researchMode)?.kind === "restricted";
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
    description: restricted ? "本对话已关闭外部 Apps" : item.description || item.name,
    available: !restricted,
  }));
  const mcp = (capabilities.mcpServers ?? []).flatMap((server) => {
    const available = !restricted && server.authStatus !== "notLoggedIn" && !server.toolsUnavailable
      && (server.runtimeStatus == null ? server.tools.length > 0 : server.runtimeStatus === "connected");
    const connectionLabel = restricted ? "本对话已关闭外部 MCP" : server.toolsUnavailable ? "工具发现失败"
      : server.authStatus === "notLoggedIn" ? "待授权"
        : ({ notStarted: "未启动", starting: "连接中", connected: "已连接", authenticationRequired: "待授权",
          failed: "连接失败", cancelled: "已取消", disabled: "已停用" })[server.runtimeStatus]
          ?? (server.tools.length ? server.authStatus : "工具尚不可用");
    const serverItem = {
      kind: "MCP",
      token: `@${server.name}`,
      label: `@${server.name}`,
      description: `${server.tools.length} tools · ${connectionLabel}`,
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
  if (isActive) scrollAgentToEnd({ force: false });
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

function agentThreadNearEnd(threshold = 64) {
  return elements.agentThread.scrollHeight
    - elements.agentThread.clientHeight
    - elements.agentThread.scrollTop <= threshold;
}

function updateAgentJumpLatest() {
  elements.agentJumpLatest.hidden = state.agentFollowTail || agentThreadNearEnd();
}

function handleAgentThreadScroll() {
  state.agentFollowTail = agentThreadNearEnd();
  updateAgentJumpLatest();
}

function scrollAgentToEnd({ force = true } = {}) {
  if (!force && !state.agentFollowTail) {
    updateAgentJumpLatest();
    return;
  }
  if (force) state.agentFollowTail = true;
  if (state.scrollFrame != null) return;
  state.scrollFrame = requestAnimationFrame(() => {
    state.scrollFrame = null;
    if (!force && !state.agentFollowTail) {
      updateAgentJumpLatest();
      return;
    }
    elements.agentThread.scrollTop = elements.agentThread.scrollHeight;
    state.agentFollowTail = true;
    updateAgentJumpLatest();
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

function finiteUiNumber(value) {
  return value != null && value !== "" && Number.isFinite(Number(value))
    ? Number(value)
    : null;
}

function firstFiniteUi(...values) {
  for (const value of values) {
    const normalized = finiteUiNumber(value);
    if (normalized != null) return normalized;
  }
  return null;
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
