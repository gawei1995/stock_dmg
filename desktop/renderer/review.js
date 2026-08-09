(() => {
  "use strict";

  const api = window.cockpit;
  const WORKSPACE_MODES = new Set(["cockpit", "review"]);
  const REVIEW_TABS = new Set(["cases", "tests", "rules", "governance"]);
  const CASE_FROZEN_STATES = new Set([
    "FROZEN",
    "EVENT_OCCURRED",
    "REVIEW_DUE",
    "REVIEWED",
    "CLOSED",
  ]);
  const RULE_STATES = ["HYPOTHESIS", "TESTING", "PROVISIONAL", "VALIDATED", "RETIRED"];
  const INTAKE_PAGE_LIMIT = 250;
  const INTAKE_SEARCH_DEBOUNCE_MS = 240;

  const state = {
    mode: "cockpit",
    activeTab: "cases",
    casePane: "intake",
    loading: false,
    selectedCaseId: null,
    caseFilter: "",
    quarterFilter: "",
    intakeSearch: "",
    intakeKind: "",
    intakePageLoading: false,
    intakePageToken: 0,
    intakeSearchTimer: null,
    eventLookupToken: 0,
    eventLookupLoading: false,
    eventLookupMessage: "",
    selectedRecordIds: new Set(),
    selectedRecordCache: new Map(),
    selectedEventId: null,
    snapshot: emptySnapshot(),
  };

  const elements = {
    cockpit: document.querySelector("#cockpit-grid"),
    workspace: document.querySelector("#review-workspace"),
    cockpitButton: document.querySelector("#workspace-cockpit"),
    reviewButton: document.querySelector("#workspace-review"),
    tabs: [...document.querySelectorAll("[data-review-tab]")],
    panels: [...document.querySelectorAll(".review-panel")],
    notice: document.querySelector("#review-notice"),
    summary: document.querySelector("#review-summary"),
    caseCount: document.querySelector("#review-case-count"),
    testCount: document.querySelector("#review-test-count"),
    ruleCount: document.querySelector("#review-rule-count"),
    dueCount: document.querySelector("#review-due-count"),
    newCase: document.querySelector("#review-new-case"),
    batchAnalyze: document.querySelector("#review-batch-analyze"),
    syncHistory: document.querySelector("#review-sync-history"),
    showIntake: document.querySelector("#review-show-intake"),
    showCases: document.querySelector("#review-show-cases"),
    intakeCount: document.querySelector("#review-intake-count"),
    listCaseCount: document.querySelector("#review-list-case-count"),
    caseSearch: document.querySelector("#review-case-search"),
    quarterFilter: document.querySelector("#review-quarter-filter"),
    caseList: document.querySelector("#review-case-list"),
    intakePanel: document.querySelector("#review-intake-panel"),
    caseDetail: document.querySelector("#review-case-detail"),
    intakeStatus: document.querySelector("#review-intake-status"),
    intakeRange: document.querySelector("#review-intake-range"),
    intakeKind: document.querySelector("#review-intake-kind"),
    intakeSearch: document.querySelector("#review-intake-search"),
    intakeSync: document.querySelector("#review-intake-sync"),
    intakeRecords: document.querySelector("#review-intake-records"),
    intakePagination: document.querySelector("#review-intake-pagination"),
    intakePageStatus: document.querySelector("#review-intake-page-status"),
    intakeLoadMore: document.querySelector("#review-intake-load-more"),
    intakeSelectedCount: document.querySelector("#review-intake-selected-count"),
    intakeClear: document.querySelector("#review-intake-clear"),
    eventMatchStatus: document.querySelector("#review-event-match-status"),
    eventCandidates: document.querySelector("#review-event-candidates"),
    derivedContext: document.querySelector("#review-derived-context"),
    createFromRecords: document.querySelector("#review-create-from-records"),
    caseForm: document.querySelector("#review-case-form"),
    caseId: document.querySelector("#review-case-id"),
    caseHeading: document.querySelector("#review-case-heading"),
    caseStatus: document.querySelector("#review-case-status"),
    caseSymbol: document.querySelector("#review-case-symbol"),
    casePeriod: document.querySelector("#review-case-period"),
    caseEventAt: document.querySelector("#review-case-event-at"),
    caseStrategy: document.querySelector("#review-case-strategy"),
    caseWindow: document.querySelector("#review-case-window"),
    caseRiskBudget: document.querySelector("#review-case-risk-budget"),
    caseStage: document.querySelector("#review-case-stage"),
    caseTemperature: document.querySelector("#review-case-temperature"),
    caseThesis: document.querySelector("#review-case-thesis"),
    caseMarketBelief: document.querySelector("#review-case-market-belief"),
    caseAction: document.querySelector("#review-case-action"),
    caseInvalidation: document.querySelector("#review-case-invalidation"),
    freezeNote: document.querySelector("#review-freeze-note"),
    freezeCase: document.querySelector("#review-freeze-case"),
    analyzeCase: document.querySelector("#review-case-analyze"),
    linkRecords: document.querySelector("#review-link-records"),
    saveCase: document.querySelector("#review-save-case"),
    brokerMatches: document.querySelector("#review-broker-matches"),
    brokerMatchCount: document.querySelector("#review-broker-match-count"),
    caseLinkedCount: document.querySelector("#review-case-linked-count"),
    checkpoints: document.querySelector("#review-checkpoints"),
    testForm: document.querySelector("#review-test-form"),
    testHypothesis: document.querySelector("#review-test-hypothesis"),
    testCase: document.querySelector("#review-test-case"),
    testRule: document.querySelector("#review-test-rule"),
    testStrategy: document.querySelector("#review-test-strategy"),
    testMetric: document.querySelector("#review-test-metric"),
    testWindow: document.querySelector("#review-test-window"),
    testMinCases: document.querySelector("#review-test-min-cases"),
    testCohort: document.querySelector("#review-test-cohort"),
    testExclusions: document.querySelector("#review-test-exclusions"),
    testList: document.querySelector("#review-test-list"),
    ruleForm: document.querySelector("#review-rule-form"),
    ruleTitle: document.querySelector("#review-rule-title"),
    ruleCondition: document.querySelector("#review-rule-condition"),
    ruleAction: document.querySelector("#review-rule-action"),
    ruleInvalidation: document.querySelector("#review-rule-invalidation"),
    ruleScope: document.querySelector("#review-rule-scope"),
    ruleList: document.querySelector("#review-rule-list"),
    governanceForm: document.querySelector("#review-governance-form"),
    governanceRule: document.querySelector("#review-governance-rule"),
    governanceKeep: document.querySelector("#review-governance-keep"),
    governanceChange: document.querySelector("#review-governance-change"),
    governanceNext: document.querySelector("#review-governance-next"),
    governanceVerdict: document.querySelector("#review-governance-verdict"),
    governanceList: document.querySelector("#review-governance-list"),
  };

  if (!elements.cockpit || !elements.workspace) return;

  bindEvents();
  applyRoute({ initial: true });

  function bindEvents() {
    elements.cockpitButton?.addEventListener("click", () => setWorkspace("cockpit"));
    elements.reviewButton?.addEventListener("click", () => setWorkspace("review"));
    elements.tabs.forEach((button) => {
      button.addEventListener("click", () => setReviewTab(button.dataset.reviewTab));
    });
    window.addEventListener("hashchange", () => applyRoute());

    elements.newCase?.addEventListener("click", showIntakePane);
    elements.showIntake?.addEventListener("click", showIntakePane);
    elements.showCases?.addEventListener("click", showCasePane);
    elements.batchAnalyze?.addEventListener("click", prepareQuarterAnalysis);
    elements.syncHistory?.addEventListener("click", syncTradeHistory);
    elements.intakeSync?.addEventListener("click", syncTradeHistory);
    elements.caseSearch?.addEventListener("input", (event) => {
      state.caseFilter = String(event.target.value ?? "").trim().toLowerCase();
      renderCaseList();
    });
    elements.quarterFilter?.addEventListener("change", (event) => {
      state.quarterFilter = String(event.target.value ?? "");
      renderCaseList();
      updateBatchButton();
    });
    elements.intakeSearch?.addEventListener("input", (event) => {
      state.intakeSearch = String(event.target.value ?? "").trim().toLowerCase();
      scheduleIntakeSearch();
    });
    elements.intakeKind?.addEventListener("change", (event) => {
      state.intakeKind = String(event.target.value ?? "");
      renderIntakeRecords();
    });
    elements.intakeRecords?.addEventListener("change", handleIntakeRecordSelection);
    elements.intakeLoadMore?.addEventListener("click", () => loadIntakePage({ append: true }));
    elements.intakeClear?.addEventListener("click", clearIntakeSelection);
    elements.eventCandidates?.addEventListener("change", handleEventSelection);
    elements.createFromRecords?.addEventListener("click", createCaseFromRecords);
    elements.caseList?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-review-case-id]");
      if (button) selectCase(button.dataset.reviewCaseId);
      const symbolButton = event.target.closest("[data-intake-symbol]");
      if (symbolButton) {
        state.intakeSearch = symbolButton.dataset.intakeSymbol.toLowerCase();
        elements.intakeSearch.value = symbolButton.dataset.intakeSymbol;
        renderCaseList();
        void loadIntakePage({ append: false });
      }
    });
    elements.caseForm?.addEventListener("submit", saveCase);
    elements.freezeCase?.addEventListener("click", freezeSelectedCase);
    elements.analyzeCase?.addEventListener("click", prepareCaseAnalysis);
    elements.linkRecords?.addEventListener("click", linkSelectedBrokerRecords);
    elements.brokerMatches?.addEventListener("change", updateLinkButton);

    elements.testForm?.addEventListener("submit", registerTest);
    elements.testList?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-complete-test-id]");
      if (button) completeTest(button.dataset.completeTestId, button);
    });
    elements.ruleForm?.addEventListener("submit", createRule);
    elements.ruleList?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-transition-rule-id]");
      if (!button) return;
      const card = button.closest("[data-rule-card-id]");
      const select = card?.querySelector("[data-rule-next-state]");
      if (select?.value) transitionRule(button.dataset.transitionRuleId, select.value, button);
    });
    elements.governanceForm?.addEventListener("submit", addRuleReview);
  }

  function routeFromHash() {
    const match = String(window.location.hash ?? "").match(/^#\/review(?:\/(cases|tests|rules|governance))?$/);
    if (match) return { mode: "review", tab: match[1] ?? "cases" };
    return { mode: "cockpit", tab: state.activeTab };
  }

  function applyRoute({ initial = false } = {}) {
    const route = routeFromHash();
    if (route.mode === "review") state.activeTab = route.tab;
    void setWorkspace(route.mode, { updateHash: !initial, fromRoute: true });
  }

  async function setWorkspace(mode, { updateHash = true, fromRoute = false } = {}) {
    const nextMode = WORKSPACE_MODES.has(mode) ? mode : "cockpit";
    if (state.loading && nextMode !== state.mode) return;
    try {
      if (typeof api?.workspace?.setMode !== "function") {
        throw new Error("复盘工作区桥接尚未就绪。");
      }
      await api.workspace.setMode(nextMode);
    } catch (error) {
      if (nextMode === "review") {
        showNotice(error.message || "无法切换到复盘工作区。", "error");
        if (!fromRoute) replaceHash("#/cockpit");
        return;
      }
    }

    state.mode = nextMode;
    document.body.dataset.workspaceMode = nextMode;
    elements.cockpit.hidden = nextMode !== "cockpit";
    elements.workspace.hidden = nextMode !== "review";
    elements.cockpitButton?.setAttribute("aria-pressed", String(nextMode === "cockpit"));
    elements.reviewButton?.setAttribute("aria-pressed", String(nextMode === "review"));

    if (nextMode === "review") {
      renderTabs();
      if (updateHash) replaceHash(`#\/review/${state.activeTab}`);
      await loadSnapshot();
    } else if (updateHash) {
      replaceHash("#/cockpit");
    }
  }

  function setReviewTab(value, { updateHash = true } = {}) {
    const next = REVIEW_TABS.has(value) ? value : "cases";
    state.activeTab = next;
    renderTabs();
    if (updateHash && state.mode === "review") replaceHash(`#\/review/${next}`);
  }

  function renderTabs() {
    elements.tabs.forEach((button) => {
      const active = button.dataset.reviewTab === state.activeTab;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    elements.panels.forEach((panel) => {
      panel.hidden = panel.id !== `review-panel-${state.activeTab}`;
    });
  }

  function replaceHash(hash) {
    if (window.location.hash === hash) return;
    window.history.replaceState(null, "", hash);
  }

  async function loadSnapshot({ preservePane = false } = {}) {
    const managesLoadingState = !state.loading;
    if (managesLoadingState) setLoading(true, "正在读取加密复盘记录…");
    try {
      const result = await callReview("snapshot");
      const separateIntake = await optionalReviewCall([
        "reviewIntakeSnapshot",
        "intakeSnapshot",
      ], {
        offset: 0,
        limit: INTAKE_PAGE_LIMIT,
        query: state.intakeSearch,
      });
      state.snapshot = normalizeSnapshot(result, separateIntake);
      const caseExists = state.snapshot.cases.some((item) => caseId(item) === state.selectedCaseId);
      if (!caseExists) state.selectedCaseId = null;
      if (!preservePane && !state.selectedCaseId) {
        state.casePane = "intake";
      }
      pruneIntakeSelection();
      renderAll();
      clearNotice();
    } catch (error) {
      state.snapshot = emptySnapshot();
      renderAll();
      showNotice(error.message || "复盘记录读取失败。", "error");
    } finally {
      if (managesLoadingState) setLoading(false);
    }
  }

  function normalizeSnapshot(result, separateIntake = null) {
    const source = result?.snapshot ?? result?.data ?? result ?? {};
    const intakeSource = separateIntake?.intake
      ?? separateIntake?.snapshot
      ?? separateIntake?.data
      ?? source.intake
      ?? source.reviewIntake
      ?? source.broker
      ?? {};
    return {
      cases: arrayValue(source.cases, source.reviewCases),
      brokerMatches: source.brokerMatches && typeof source.brokerMatches === "object"
        ? source.brokerMatches
        : {},
      tests: arrayValue(source.tests, source.experiments),
      rules: arrayValue(source.rules),
      reviews: arrayValue(source.reviews, source.ruleReviews),
      ruleMetrics: source.ruleMetrics && typeof source.ruleMetrics === "object" ? source.ruleMetrics : {},
      summary: source.summary && typeof source.summary === "object" ? source.summary : {},
      intake: normalizeIntake(intakeSource, source),
    };
  }

  function emptySnapshot() {
    return {
      cases: [], brokerMatches: {}, tests: [], rules: [], reviews: [], ruleMetrics: {}, summary: {},
      intake: normalizeIntake(),
    };
  }

  function renderAll() {
    renderSummary();
    renderQuarterFilter();
    renderCaseList();
    renderSelectedCase();
    renderIntake();
    renderTests();
    renderRules();
    renderGovernance();
    renderTestLinks();
  }

  function renderSummary() {
    const testsRunning = state.snapshot.tests.filter((item) => !testComplete(item)).length;
    const activeRules = state.snapshot.rules.filter((item) => ruleStatus(item) !== "RETIRED").length;
    const dueReviews = numberOr(
      state.snapshot.summary.reviewDueCount,
      state.snapshot.summary.dueReviews,
      state.snapshot.rules.filter((item) => item.reviewDue === true || item.reviewStatus === "due").length,
    );
    const values = [state.snapshot.cases.length, testsRunning, activeRules, dueReviews];
    [...elements.summary.querySelectorAll("strong")].forEach((node, index) => {
      node.textContent = String(values[index] ?? 0);
    });
    elements.caseCount.textContent = String(state.snapshot.cases.length);
    elements.testCount.textContent = String(state.snapshot.tests.length);
    elements.ruleCount.textContent = String(state.snapshot.rules.length);
    elements.dueCount.textContent = String(dueReviews);
    elements.listCaseCount.textContent = String(state.snapshot.cases.length);
    elements.intakeCount.textContent = String(state.snapshot.intake.totalRecordCount);
    updateBatchButton();
  }

  function renderCaseList() {
    elements.showIntake.setAttribute("aria-pressed", String(state.casePane === "intake"));
    elements.showCases.setAttribute("aria-pressed", String(state.casePane === "case"));
    const cases = state.snapshot.cases.filter((item) => {
      if (state.quarterFilter && casePeriod(item) !== state.quarterFilter) return false;
      if (!state.caseFilter) return true;
      return [caseSymbol(item), casePeriod(item), item.strategyFamily, item.strategy]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(state.caseFilter);
    });
    elements.caseList.replaceChildren();
    if (state.casePane === "intake") {
      const records = filteredIntakeRecords();
      const bySymbol = new Map();
      for (const record of records) {
        const symbol = brokerSymbol(record);
        if (!symbol) continue;
        const group = bySymbol.get(symbol) ?? { symbol, count: 0, latestAt: null };
        group.count += 1;
        const at = brokerRecordAt(record);
        if (timestamp(at) > timestamp(group.latestAt)) group.latestAt = at;
        bySymbol.set(symbol, group);
      }
      const groups = [...bySymbol.values()]
        .filter((item) => !state.caseFilter || item.symbol.toLowerCase().includes(state.caseFilter))
        .sort((left, right) => timestamp(right.latestAt) - timestamp(left.latestAt));
      if (!groups.length) {
        elements.caseList.append(emptyNode(
          state.snapshot.intake.syncedAt
            ? "当前范围没有可关联记录。\n可扩大历史范围后重新同步。"
            : "先同步长桥历史。\n订单与成交会在这里按标的归组。",
          true,
        ));
        return;
      }
      for (const group of groups) {
        const button = node("button", `review-case-item${state.intakeSearch === group.symbol.toLowerCase() ? " active" : ""}`);
        button.type = "button";
        button.dataset.intakeSymbol = group.symbol;
        button.append(
          node("strong", "", group.symbol),
          node("small", "", `${group.count} 条`),
          node("p", "", `最近记录 ${formatDateTime(group.latestAt)}`),
        );
        elements.caseList.append(button);
      }
      return;
    }
    if (!cases.length) {
      elements.caseList.append(emptyNode(
        state.caseFilter || state.quarterFilter
          ? "没有匹配的案例。"
          : "还没有复盘案例。\n先从真实订单建立第一条记录。",
        true,
      ));
      return;
    }
    for (const item of cases) {
      const id = caseId(item);
      const button = node("button", `review-case-item${id === state.selectedCaseId ? " active" : ""}`);
      button.type = "button";
      button.dataset.reviewCaseId = id;
      button.append(
        node("strong", "", `${caseSymbol(item)} · ${casePeriod(item)}`),
        node("small", "", caseStatus(item)),
        node("p", "", `${strategyLabel(item.strategyType ?? item.strategyFamily ?? item.strategy)} · ${horizonLabel(casePrimaryWindow(item))}`),
      );
      elements.caseList.append(button);
    }
  }

  function showIntakePane() {
    state.selectedCaseId = null;
    state.casePane = "intake";
    setReviewTab("cases");
    renderCaseList();
    renderSelectedCase();
    renderIntake();
    elements.intakeSearch.focus();
  }

  function showCasePane() {
    state.casePane = "case";
    if (!state.selectedCaseId && state.snapshot.cases[0]) {
      state.selectedCaseId = caseId(state.snapshot.cases[0]);
    }
    setReviewTab("cases");
    renderCaseList();
    renderSelectedCase();
  }

  function selectCase(id) {
    if (!id) return;
    state.selectedCaseId = String(id);
    state.casePane = "case";
    renderCaseList();
    renderSelectedCase();
  }

  function selectedCase() {
    return state.snapshot.cases.find((item) => caseId(item) === state.selectedCaseId) ?? null;
  }

  function renderSelectedCase() {
    const item = selectedCase();
    const showCase = state.casePane === "case" && Boolean(item);
    elements.intakePanel.hidden = showCase;
    elements.caseDetail.hidden = !showCase;
    if (!showCase) {
      return;
    }
    const exAnte = item.exAnteDraft ?? item.exAnte ?? item.decision ?? item.draft ?? {};
    const frozen = caseFrozen(item);
    elements.caseId.value = caseId(item);
    elements.caseHeading.textContent = `${caseSymbol(item)} · ${casePeriod(item)}`;
    setCaseStatus(caseStatus(item));
    elements.caseSymbol.value = caseSymbol(item);
    elements.casePeriod.value = casePeriod(item);
    elements.caseEventAt.value = localDateTimeValue(
      item.eventAt ?? item.scheduledAt ?? item.event?.scheduledAt ?? item.event?.actualAt,
    );
    setSelectValue(elements.caseStrategy, item.strategyType ?? item.strategyFamily ?? item.strategy ?? "other");
    setSelectValue(elements.caseWindow, casePrimaryWindow(item));
    elements.caseRiskBudget.value = valueOrEmpty(
      exAnte.riskBudgetR ?? exAnte.riskBudgetAmount ?? item.riskBudgetR,
    );
    elements.caseStage.value = exAnte.narrativeStage ?? exAnte.stage ?? item.stage ?? "";
    elements.caseTemperature.value = valueOrEmpty(exAnte.marketTemperature ?? exAnte.temperature ?? item.temperature);
    elements.caseThesis.value = exAnte.myView ?? exAnte.thesis ?? item.thesis ?? "";
    elements.caseMarketBelief.value = exAnte.marketView ?? exAnte.marketBelief ?? item.marketBelief ?? "";
    elements.caseAction.value = exAnte.plannedAction ?? item.plannedAction ?? "";
    elements.caseInvalidation.value = exAnte.invalidation ?? item.invalidation ?? "";
    setCaseFormFrozen(frozen);
    const latestVersion = Array.isArray(item.exAnteVersions) ? item.exAnteVersions.at(-1) : null;
    elements.freezeNote.textContent = frozen
      ? `已于 ${formatDateTime(latestVersion?.sealedAt ?? item.frozenAt ?? item.exAnteFrozenAt)} 封存；财报前字段不可覆盖。`
      : "草稿可编辑；封存后只能追加事后记录。";
    elements.freezeCase.disabled = frozen || state.loading;
    elements.freezeCase.textContent = frozen ? "已封存" : "封存财报前判断";
    elements.saveCase.disabled = frozen || state.loading;
    elements.saveCase.textContent = frozen ? "财报前记录已锁定" : "保存案例";
    elements.analyzeCase.disabled = state.loading;
    renderBrokerMatches(item);
    renderCheckpoints(item);
  }

  function setCaseStatus(value) {
    const status = String(value || "DRAFT").toUpperCase();
    elements.caseStatus.textContent = status;
    elements.caseStatus.className = `review-state-badge ${statusClass(status)}`;
  }

  function setCaseFormFrozen(frozen) {
    elements.caseForm.querySelectorAll("input:not([type='hidden']), select, textarea").forEach((field) => {
      field.disabled = frozen;
    });
  }

  async function saveCase(event) {
    event.preventDefault();
    if (state.loading) return;
    const draft = caseDraftFromForm();
    if (!draft.symbol || !draft.fiscalQuarter || !draft.eventAt) return;
    const currentId = elements.caseId.value.trim();
    if (!currentId) {
      showNotice("请先从长桥订单建立案例，再补充当时判断。", "warning");
      showIntakePane();
      return;
    }
    await runAction("正在更新案例…", async () => {
      const result = await callReview("updateCase", { caseId: currentId, patch: draft });
      state.selectedCaseId = String(
        result?.caseId ?? result?.case?.id ?? result?.reviewCase?.id ?? currentId ?? "",
      ) || null;
      state.casePane = "case";
      await loadSnapshot({ preservePane: true });
      showNotice("当时判断已保存。", "success");
    });
  }

  function caseDraftFromForm() {
    const riskBudgetValue = elements.caseRiskBudget.value.trim();
    const marketTemperatureValue = elements.caseTemperature.value.trim();
    const base = {
      symbol: normalizeSymbol(elements.caseSymbol.value),
      fiscalQuarter: elements.casePeriod.value.trim(),
      eventAt: inputDateTimeToIso(elements.caseEventAt.value),
      strategyType: elements.caseStrategy.value,
      primaryHorizon: elements.caseWindow.value,
      riskBudgetR: riskBudgetValue === "" ? null : Number(riskBudgetValue),
      narrativeStage: elements.caseStage.value.trim(),
      marketTemperature: marketTemperatureValue === "" ? null : Number(marketTemperatureValue),
      myView: elements.caseThesis.value.trim(),
      marketView: elements.caseMarketBelief.value.trim(),
      plannedAction: elements.caseAction.value.trim(),
      invalidation: elements.caseInvalidation.value.trim(),
    };
    return {
      ...base,
      event: { kind: "earnings", scheduledAt: base.eventAt },
      evaluationPlan: { primaryWindow: base.primaryHorizon },
      exAnte: {
        narrativeStage: base.narrativeStage,
        marketTemperature: base.marketTemperature,
        myView: base.myView,
        marketView: base.marketView,
        plannedAction: base.plannedAction,
        invalidation: base.invalidation,
        riskBudgetR: base.riskBudgetR,
      },
    };
  }

  async function freezeSelectedCase() {
    const item = selectedCase();
    if (!item || caseFrozen(item) || state.loading) return;
    await runAction("正在封存财报前判断…", async () => {
      await callReview("freezeCase", { caseId: caseId(item) });
      await loadSnapshot();
      showNotice("财报前判断已封存。后续修改将作为事后追加记录，而不会覆盖原判断。", "success");
    });
  }

  function brokerMatchesForCase(item) {
    if (!item) return [];
    const embedded = arrayValue(item.brokerMatches, item.executionCandidates, item.matches);
    if (embedded.length) return embedded;
    const id = caseId(item);
    const matchGroup = state.snapshot.brokerMatches[id];
    if (!matchGroup || typeof matchGroup !== "object") return [];
    const linkedOrderIds = new Set(arrayValue(item.brokerLinks?.orderIds));
    const linkedExecutionIds = new Set(arrayValue(item.brokerLinks?.executionIds));
    return [
      ...arrayValue(matchGroup.orders).map((record) => ({
        ...record,
        type: "order",
        recordId: record.orderId,
        linked: linkedOrderIds.has(String(record.orderId)),
      })),
      ...arrayValue(matchGroup.executions).map((record) => ({
        ...record,
        type: "execution",
        recordId: record.tradeId,
        linked: linkedExecutionIds.has(String(record.tradeId)),
      })),
    ];
  }

  function renderBrokerMatches(item) {
    const records = brokerMatchesForCase(item);
    const confirmed = records.filter((record) => record.linked === true || record.confirmed === true);
    const shownRecords = confirmed.length ? confirmed : records;
    elements.brokerMatches.replaceChildren();
    elements.brokerMatchCount.textContent = `${shownRecords.length} 条`;
    elements.caseLinkedCount.textContent = `${confirmed.length || arrayValue(item?.brokerLinks?.orderIds).length + arrayValue(item?.brokerLinks?.executionIds).length} 条`;
    elements.linkRecords.hidden = confirmed.length > 0 || !records.length;
    if (!shownRecords.length) {
      elements.brokerMatches.append(emptyNode(
        item ? "这个旧案例尚未关联真实订单。可回到“待关联订单”重新建立，或同步历史后确认候选。" : "先从订单建立案例。",
        true,
      ));
      updateLinkButton();
      return;
    }
    for (const record of shownRecords) {
      const id = brokerRecordId(record);
      const row = node("label", "review-record-row");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.brokerRecordId = id;
      checkbox.disabled = confirmed.length > 0 || record.linked === true || record.confirmed === true;
      checkbox.checked = checkbox.disabled;
      row.append(
        checkbox,
        node("strong", "", String(record.type ?? record.kind ?? "EXECUTION").toUpperCase()),
        node("span", "", `${normalizeSymbol(record.symbol)} · ${String(record.side ?? record.direction ?? "—").toUpperCase()}`),
        node("span", "", `数量 ${formatNumber(record.quantity ?? record.executedQuantity ?? record.qty)}`),
        priceText(record.price ?? record.executedPrice ?? record.submittedPrice, record.currency),
        node("span", "", formatDateTime(record.executedAt ?? record.doneAt ?? record.submittedAt ?? record.updatedAt ?? record.createdAt)),
      );
      elements.brokerMatches.append(row);
    }
    updateLinkButton();
  }

  function updateLinkButton() {
    const checked = elements.brokerMatches.querySelectorAll("[data-broker-record-id]:checked:not(:disabled)").length;
    elements.linkRecords.disabled = !selectedCase() || checked === 0 || state.loading;
    elements.linkRecords.textContent = checked ? `确认关联 ${checked} 条` : "确认关联成交";
  }

  async function linkSelectedBrokerRecords() {
    const item = selectedCase();
    const recordIds = [...elements.brokerMatches.querySelectorAll("[data-broker-record-id]:checked:not(:disabled)")]
      .map((input) => input.dataset.brokerRecordId)
      .filter(Boolean);
    if (!item || !recordIds.length || state.loading) return;
    await runAction("正在确认订单与成交归属…", async () => {
      await callReview("linkBrokerRecords", {
        caseId: caseId(item),
        recordIds,
        confirmed: true,
      });
      await loadSnapshot();
      showNotice(`已把 ${recordIds.length} 条长桥记录关联到当前案例。`, "success");
    });
  }

  async function syncTradeHistory() {
    if (state.loading) return;
    const days = Number(elements.intakeRange?.value || 365);
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    await runAction("正在同步长桥历史订单与成交…", async () => {
      const payload = {
        from: from.toISOString(),
        to: to.toISOString(),
        startAt: from.toISOString(),
        endAt: to.toISOString(),
      };
      const intakeMethod = firstReviewMethod(["syncReviewIntake", "syncIntake"]);
      if (intakeMethod) await callReview(intakeMethod, payload);
      else await callReview("syncTradeHistory", payload);
      state.casePane = "intake";
      state.selectedCaseId = null;
      await loadSnapshot({ preservePane: true });
      const completeness = Object.values(state.snapshot.intake.completeness ?? {});
      const degraded = state.snapshot.intake.warnings.length > 0
        || completeness.some((value) => ["stale", "best_effort", "not_synced"].includes(String(value)));
      showNotice(
        degraded
          ? "历史记录已尽力同步，但部分长桥数据源未完整返回；当前结果已标记为降级，请先核对完整性提示再关联。"
          : "长桥历史已同步。财报事件自动匹配仅作为候选；请选择真实订单与成交后亲自确认。",
        degraded ? "warning" : "success",
      );
    });
  }

  function renderIntake() {
    const intake = state.snapshot.intake;
    const brokerCounts = `${formatNumber(intake.orderCount, 0)} 笔订单 · ${formatNumber(intake.executionCount, 0)} 笔成交`;
    elements.intakeStatus.textContent = intake.syncedAt
      ? `${brokerCounts} · ${formatDateTime(intake.syncedAt)}`
      : "尚未同步";
    renderIntakeRecords();
    renderIntakePagination();
    renderEventCandidates();
    renderDerivedContext();
  }

  function renderIntakeRecords() {
    const records = filteredIntakeRecords();
    elements.intakeRecords.replaceChildren();
    if (!records.length) {
      elements.intakeRecords.append(emptyNode(
        state.intakePageLoading
          ? "正在从本机加密历史中查询完整结果…"
          : state.snapshot.intake.syncedAt
          ? "没有符合筛选条件的历史记录。"
          : "尚未取得历史订单。点击“同步历史”后，这里会显示只读订单与成交。",
        true,
      ));
      updateIntakeSelectionSummary();
      return;
    }
    for (const record of records) {
      const id = brokerRecordId(record);
      const symbol = brokerSymbol(record);
      const type = brokerRecordType(record);
      const linked = recordAlreadyLinked(id);
      const label = node("label", `review-record-row review-intake-record${linked ? " linked" : ""}`);
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.intakeRecordId = id;
      checkbox.checked = state.selectedRecordIds.has(id);
      checkbox.disabled = !id || linked || state.loading || state.intakePageLoading;
      label.append(
        checkbox,
        node("span", "review-record-time", `${formatShortDateTime(brokerRecordAt(record))}\n${type === "order" ? "订单" : "成交"}`),
        node("strong", "", symbol || "—"),
        node("span", "", `${String(record.side ?? record.direction ?? "—").toUpperCase()}\n${String(record.status ?? (type === "execution" ? "FILLED" : "—")).toUpperCase()}`),
        node("span", "", formatNumber(record.quantity ?? record.executedQuantity ?? record.qty)),
        priceText(record.price ?? record.executedPrice ?? record.submittedPrice, record.currency),
      );
      if (linked) label.title = "这条记录已经关联到一个复盘案例";
      elements.intakeRecords.append(label);
    }
    updateIntakeSelectionSummary();
  }

  function filteredIntakeRecords() {
    return state.snapshot.intake.records.filter((record) => {
      if (state.intakeKind && brokerRecordType(record) !== state.intakeKind) return false;
      return true;
    });
  }

  function renderIntakePagination() {
    const intake = state.snapshot.intake;
    const loaded = intake.records.length;
    const total = intake.totalRecordCount;
    const queryLabel = state.intakeSearch ? ` · 服务端筛选“${state.intakeSearch}”` : "";
    elements.intakePagination.classList.toggle("loading", state.intakePageLoading);
    elements.intakePageStatus.textContent = state.intakePageLoading
      ? `${loaded ? `已保留 ${loaded} 条，` : ""}正在读取历史${queryLabel}`
      : `已加载 ${formatNumber(loaded, 0)} / ${formatNumber(total, 0)} 条${queryLabel}`;
    elements.intakeLoadMore.hidden = intake.nextOffset == null;
    elements.intakeLoadMore.disabled = state.loading || state.intakePageLoading || intake.nextOffset == null;
    elements.intakeLoadMore.textContent = state.intakePageLoading ? "加载中…" : "加载更多";
  }

  function scheduleIntakeSearch() {
    if (state.intakeSearchTimer) clearTimeout(state.intakeSearchTimer);
    state.intakeSearchTimer = setTimeout(() => {
      state.intakeSearchTimer = null;
      void loadIntakePage({ append: false });
    }, INTAKE_SEARCH_DEBOUNCE_MS);
    renderIntakePagination();
  }

  async function loadIntakePage({ append = false } = {}) {
    if (state.loading || state.intakePageLoading) {
      if (!append) {
        if (state.intakeSearchTimer) clearTimeout(state.intakeSearchTimer);
        state.intakeSearchTimer = setTimeout(() => {
          state.intakeSearchTimer = null;
          void loadIntakePage({ append: false });
        }, 100);
      }
      return;
    }
    const method = firstReviewMethod(["reviewIntakeSnapshot", "intakeSnapshot"]);
    if (!method) {
      showNotice("历史订单分页接口尚未就绪。", "error");
      return;
    }
    const previous = state.snapshot.intake;
    const offset = append ? previous.nextOffset : 0;
    if (append && offset == null) return;
    const requestQuery = state.intakeSearch;
    const token = ++state.intakePageToken;
    state.intakePageLoading = true;
    if (!append) {
      state.snapshot.intake = {
        ...previous,
        records: [],
        totalRecordCount: 0,
        offset: 0,
        nextOffset: null,
      };
    }
    renderCaseList();
    renderIntakeRecords();
    renderIntakePagination();
    try {
      const result = await callReview(method, {
        offset,
        limit: INTAKE_PAGE_LIMIT,
        query: requestQuery,
      });
      if (token !== state.intakePageToken) return;
      if (requestQuery !== state.intakeSearch) {
        state.snapshot.intake = previous;
        return;
      }
      const source = result?.intake ?? result?.snapshot?.intake ?? result?.data?.intake ?? result?.data ?? result ?? {};
      const page = normalizeIntake(source);
      state.snapshot.intake = append ? mergeIntakePages(previous, page) : page;
      pruneIntakeSelection();
      renderQuarterFilter();
      renderCaseList();
      renderSummary();
    } catch (error) {
      if (token !== state.intakePageToken) return;
      state.snapshot.intake = previous;
      showNotice(error.message || "历史订单查询失败。", "error");
    } finally {
      if (token === state.intakePageToken) {
        state.intakePageLoading = false;
        renderIntake();
      }
    }
  }

  function mergeIntakePages(previous, page) {
    const records = [...new Map([
      ...previous.records,
      ...page.records,
    ].map((item) => [brokerRecordId(item), item])).values()]
      .sort((left, right) => timestamp(brokerRecordAt(right)) - timestamp(brokerRecordAt(left)));
    const eventCandidates = [...new Map([
      ...previous.eventCandidates,
      ...page.eventCandidates,
    ].map((item) => [eventCandidateId(item), item])).values()];
    return {
      ...previous,
      ...page,
      records,
      eventCandidates,
      totalRecordCount: page.totalRecordCount,
      nextOffset: page.nextOffset,
    };
  }

  function handleIntakeRecordSelection(event) {
    const checkbox = event.target.closest("[data-intake-record-id]");
    if (!checkbox) return;
    const id = checkbox.dataset.intakeRecordId;
    const record = state.snapshot.intake.records.find((item) => brokerRecordId(item) === id);
    if (!record) return;
    if (checkbox.checked) {
      state.selectedRecordIds.add(id);
      state.selectedRecordCache.set(id, record);
    } else {
      state.selectedRecordIds.delete(id);
      state.selectedRecordCache.delete(id);
    }
    reconcileSelectedEvent();
    renderIntakeRecords();
    renderEventCandidates();
    renderDerivedContext();
    void lookupEventCandidatesForSelection();
  }

  function clearIntakeSelection() {
    state.eventLookupToken += 1;
    state.eventLookupLoading = false;
    state.selectedRecordIds.clear();
    state.selectedRecordCache.clear();
    state.selectedEventId = null;
    state.eventLookupMessage = "";
    renderIntakeRecords();
    renderEventCandidates();
    renderDerivedContext();
  }

  function selectedIntakeRecords() {
    return [...state.selectedRecordIds]
      .map((id) => state.selectedRecordCache.get(id)
        ?? state.snapshot.intake.records.find((item) => brokerRecordId(item) === id))
      .filter(Boolean);
  }

  function selectedIntakeSymbols() {
    return [...new Set(selectedIntakeRecords().map(brokerSymbol).filter(Boolean))];
  }

  function updateIntakeSelectionSummary() {
    const selected = selectedIntakeRecords();
    const symbols = selectedIntakeSymbols();
    elements.intakeSelectedCount.textContent = selected.length
      ? `已选择 ${selected.length} 条 · ${symbols.join(" + ")} · ${formatDateRange(selected.map(brokerRecordAt))}`
      : "尚未选择记录";
    elements.intakeClear.disabled = !selected.length || state.loading;
  }

  function renderEventCandidates() {
    const selected = selectedIntakeRecords();
    const candidates = eventCandidatesForSelection();
    elements.eventCandidates.replaceChildren();
    if (!selected.length) {
      elements.eventMatchStatus.textContent = "等待选择订单";
      elements.eventCandidates.append(emptyNode("选择至少一条订单或成交后，系统才会查询同标的的财报事件。", true));
      return;
    }
    if (state.eventLookupLoading) {
      elements.eventMatchStatus.textContent = "正在查询财报日历…";
      elements.eventCandidates.append(emptyNode("正在根据所选标的与交易时间查询只读财报事件。", true));
      return;
    }
    if (!candidates.length) {
      elements.eventMatchStatus.textContent = "财报事件待补全";
      elements.eventCandidates.append(emptyNode(
        state.eventLookupMessage || "订单已取得，但财报日历没有返回可确认的日期与季度。系统不会用订单时间猜测财报季度，请检查只读财报日历能力后重试。",
        true,
      ));
      return;
    }
    elements.eventMatchStatus.textContent = `${candidates.length} 个候选`;
    for (const candidate of candidates) {
      const id = eventCandidateId(candidate);
      const label = node("label", `review-event-option${id === state.selectedEventId ? " active" : ""}`);
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "review-earnings-event";
      radio.value = id;
      radio.checked = id === state.selectedEventId;
      radio.disabled = state.loading;
      label.append(
        radio,
        node("strong", "", `${eventPeriod(candidate)} · ${eventSessionLabel(candidate)}`),
        node("span", "", formatDateTime(eventAt(candidate))),
        node("small", "", eventDistanceLabel(candidate, selected)),
      );
      elements.eventCandidates.append(label);
    }
  }

  function handleEventSelection(event) {
    const radio = event.target.closest("input[name='review-earnings-event']");
    if (!radio) return;
    state.selectedEventId = radio.value;
    renderEventCandidates();
    renderDerivedContext();
  }

  async function lookupEventCandidatesForSelection() {
    const method = firstReviewMethod(["lookupEventCandidates", "lookupReviewEvents", "reviewEventCandidates"]);
    const recordIds = selectedIntakeRecords().map(brokerRecordId);
    const token = ++state.eventLookupToken;
    if (!method || !recordIds.length) return;
    state.eventLookupLoading = true;
    state.eventLookupMessage = "";
    renderEventCandidates();
    try {
      const result = await callReview(method, { recordIds });
      if (token !== state.eventLookupToken) return;
      const source = result?.data ?? result ?? {};
      const candidates = arrayValue(source.eventCandidates, source.events);
      const merged = [...new Map([
        ...state.snapshot.intake.eventCandidates,
        ...candidates,
      ].filter((item) => eventCandidateId(item)).map((item) => [eventCandidateId(item), item])).values()];
      state.snapshot.intake.eventCandidates = merged;
      state.eventLookupMessage = String(source.message ?? "");
      reconcileSelectedEvent();
    } catch (error) {
      if (token !== state.eventLookupToken) return;
      state.eventLookupMessage = error.message || "财报事件查询失败。";
    } finally {
      if (token === state.eventLookupToken) {
        state.eventLookupLoading = false;
        renderQuarterFilter();
        renderEventCandidates();
        renderDerivedContext();
      }
    }
  }

  function renderDerivedContext() {
    const records = selectedIntakeRecords();
    const candidate = selectedEventCandidate();
    elements.derivedContext.replaceChildren();
    if (!records.length) {
      elements.createFromRecords.disabled = true;
      return;
    }
    elements.derivedContext.append(
      metricCell("相关标的", selectedIntakeSymbols().join(" + ") || "—"),
      metricCell("订单 / 成交", `${records.filter((item) => brokerRecordType(item) === "order").length} / ${records.filter((item) => brokerRecordType(item) === "execution").length}`),
      metricCell("交易时间", formatDateRange(records.map(brokerRecordAt))),
      metricCell("财报季度", candidate ? eventPeriod(candidate) : "待确认"),
      metricCell("财报时间", candidate ? formatDateTime(eventAt(candidate)) : "待确认"),
    );
    elements.createFromRecords.disabled = !candidate || state.loading;
  }

  async function createCaseFromRecords() {
    const records = selectedIntakeRecords();
    const candidate = selectedEventCandidate();
    if (!records.length || !candidate || state.loading) return;
    const payload = {
      recordIds: records.map(brokerRecordId),
      eventCandidateId: eventCandidateId(candidate),
      symbol: eventSymbol(candidate),
      fiscalQuarter: eventPeriod(candidate),
      eventAt: eventAt(candidate),
      eventSession: eventSession(candidate),
      primaryHorizon: "t5",
      strategyType: "other",
    };
    await runAction("正在建立订单关联的财报案例…", async () => {
      let result;
      const createMethod = firstReviewMethod(["createReviewCaseFromRecords", "createCaseFromRecords"]);
      if (createMethod) {
        result = await callReview(createMethod, payload);
      } else {
        result = await callReview("createCase", {
          ...payload,
          exAnte: {},
        });
        const createdId = reviewCaseIdFromResult(result);
        if (!createdId) throw new Error("案例已创建，但宿主没有返回案例 ID，无法确认订单关联。");
        await callReview("linkBrokerRecords", { caseId: createdId, recordIds: payload.recordIds, confirmed: true });
      }
      const createdId = reviewCaseIdFromResult(result);
      if (!createdId) throw new Error("建立案例后未取得案例 ID。");
      state.selectedCaseId = createdId;
      state.casePane = "case";
      state.selectedRecordIds.clear();
      state.selectedRecordCache.clear();
      state.selectedEventId = null;
      await loadSnapshot({ preservePane: true });
      const autoIncluded = Math.max(0, Number(result?.selection?.autoIncludedRecordCount ?? 0));
      showNotice(
        autoIncluded
          ? `订单、成交与财报事件已关联；系统从加密历史自动补齐了 ${autoIncluded} 条父订单或同单成交。现在请补充当时的四项判断。`
          : "订单、成交与财报事件已关联。现在请补充当时的四项判断，再交给复盘 Agent。",
        "success",
      );
    });
  }

  function reconcileSelectedEvent() {
    const candidates = eventCandidatesForSelection();
    if (candidates.some((item) => eventCandidateId(item) === state.selectedEventId)) return;
    const closest = closestEventCandidate(candidates, selectedIntakeRecords());
    state.selectedEventId = closest ? eventCandidateId(closest) : null;
  }

  function eventCandidatesForSelection() {
    const symbols = new Set(selectedIntakeSymbols());
    if (!symbols.size) return [];
    return state.snapshot.intake.eventCandidates
      .filter((item) => symbols.has(eventSymbol(item)))
      .sort((left, right) => Math.abs(eventDistanceMs(left, selectedIntakeRecords())) - Math.abs(eventDistanceMs(right, selectedIntakeRecords())));
  }

  function selectedEventCandidate() {
    return eventCandidatesForSelection().find((item) => eventCandidateId(item) === state.selectedEventId) ?? null;
  }

  async function prepareCaseAnalysis() {
    const item = selectedCase();
    if (!item || state.loading) return;
    if (!caseHasConfirmedBrokerRecords(item)) {
      showNotice("这个案例尚未确认关联长桥订单或成交，不能进入订单证据复盘。", "warning");
      return;
    }
    await runAction("正在准备复盘 Skill 上下文…", async () => {
      if (!caseFrozen(item)) {
        await callReview("updateCase", {
          caseId: caseId(item),
          patch: caseDraftFromForm(),
        });
      }
      const request = {
        scope: "earnings_case",
        caseId: caseId(item),
        caseIds: [caseId(item)],
        task: `$review-earnings-decisions 复盘 ${caseSymbol(item)} · ${casePeriod(item)} 的已关联财报决策。区分订单与成交事实、我的事前判断、过程质量和结果运气；评估赔率、动作一致性与失效纪律，并给出下一轮可验证计划。`,
      };
      const method = firstReviewMethod(["prepareReviewAnalysis", "prepareAnalysis"]);
      const result = method ? await callReview(method, request) : { request };
      announcePreparedAnalysis(result, `已把 ${caseSymbol(item)} · ${casePeriod(item)} 的订单证据与事前记录交给复盘 Agent。`);
    });
  }

  async function prepareQuarterAnalysis() {
    const cases = casesForSelectedQuarter();
    if (!state.quarterFilter || !cases.length || state.loading) return;
    await runAction("正在准备季度通盘复盘…", async () => {
      const current = selectedCase();
      if (current && casePeriod(current) === state.quarterFilter && !caseFrozen(current)) {
        await callReview("updateCase", {
          caseId: caseId(current),
          patch: caseDraftFromForm(),
        });
      }
      const request = {
        scope: "earnings_quarter",
        fiscalQuarter: state.quarterFilter,
        caseIds: cases.map(caseId),
        task: `$review-earnings-decisions 通盘复盘 ${state.quarterFilter} 的 ${cases.length} 个已关联财报决策。统一评估赔率、胜率、动作一致性、失效执行与尾部风险，提出未来应保留、验证和规避的行为；候选规则不得自动晋级。`,
      };
      const method = firstReviewMethod(["prepareReviewAnalysis", "prepareAnalysis"]);
      const result = method ? await callReview(method, request) : { request };
      announcePreparedAnalysis(result, `已把 ${state.quarterFilter} 的 ${cases.length} 个案例交给复盘 Agent，统一评估赔率、胜率、动作与失效纪律。`);
    });
  }

  function announcePreparedAnalysis(result, fallbackMessage) {
    const detail = result?.analysis ?? result?.request ?? result ?? {};
    // runAction keeps workspace navigation locked while its operation is
    // active. Dispatch on the next task so its finally block clears loading
    // before the shared Agent harness switches back to the cockpit.
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("cockpit:review-analysis-prepared", { detail }));
    }, 0);
    showNotice(result?.message || fallbackMessage, "success");
  }

  function renderCheckpoints(item) {
    const checkpoints = arrayValue(item?.checkpoints, item?.outcomes);
    elements.checkpoints.replaceChildren();
    if (!checkpoints.length) {
      elements.checkpoints.append(emptyNode(
        item ? "尚未生成结果检查点。财报发生后按冻结的主窗口计算。" : "保存案例后显示结果路径。",
        true,
      ));
      return;
    }
    for (const checkpoint of checkpoints) {
      const row = node("div", "review-checkpoint-row");
      row.append(
        metricCell("窗口", checkpoint.horizon ?? checkpoint.window ?? "—"),
        metricCell("净R", signedNumber(checkpoint.netR ?? checkpoint.rMultiple)),
        metricCell("标的收益", signedPercent(checkpoint.assetReturnPercent ?? checkpoint.returnPercent)),
        metricCell("相对基准", signedPercent(checkpoint.relativeReturnPercent)),
        metricCell("MAE / MFE", `${signedNumber(checkpoint.maeR)} / ${signedNumber(checkpoint.mfeR)}`),
      );
      elements.checkpoints.append(row);
    }
  }

  async function registerTest(event) {
    event.preventDefault();
    if (state.loading) return;
    const draft = {
      hypothesis: elements.testHypothesis.value.trim(),
      title: truncate(elements.testHypothesis.value, 160),
      caseId: elements.testCase.value || null,
      ruleId: elements.testRule.value || null,
      strategyFamily: elements.testStrategy.value.trim(),
      primaryMetric: elements.testMetric.value,
      primaryHorizon: elements.testWindow.value,
      minimumCases: Number(elements.testMinCases.value || 20),
      cohort: elements.testCohort.value.trim(),
      exclusions: elements.testExclusions.value.trim(),
    };
    draft.notes = [
      draft.strategyFamily ? `策略族：${draft.strategyFamily}` : "",
      draft.cohort ? `纳入条件：${draft.cohort}` : "",
      draft.exclusions ? `排除条件：${draft.exclusions}` : "",
      `计划最少案例：${draft.minimumCases}`,
    ].filter(Boolean).join("\n");
    await runAction("正在登记测试协议…", async () => {
      await callReview("registerTest", draft);
      elements.testForm.reset();
      elements.testMinCases.value = "20";
      setSelectValue(elements.testWindow, "t5");
      await loadSnapshot();
      showNotice("测试协议已登记。主指标、窗口和样本条件应在读取结果前冻结。", "success");
    });
  }

  async function completeTest(testId, button) {
    if (!testId || state.loading) return;
    const card = button.closest("[data-test-card-id]");
    const censored = card?.querySelector("[data-test-censored]")?.checked === true;
    const outcomeValue = card?.querySelector("[data-test-outcome-r]")?.value ?? "";
    const benchmarkValue = card?.querySelector("[data-test-benchmark-return]")?.value ?? "";
    const outcomeR = outcomeValue === "" ? null : Number(outcomeValue);
    if (!censored && !Number.isFinite(outcomeR)) {
      showNotice("完成测试前请填写有效的净R，或标记为删失样本。", "warning");
      return;
    }
    button.disabled = true;
    await runAction("正在计算测试结果…", async () => {
      await callReview("completeTest", {
        testId,
        outcomeR,
        benchmarkReturnPercent: benchmarkValue === "" ? null : Number(benchmarkValue),
        outcomeSource: "manual",
        notes: card?.querySelector("[data-test-result-notes]")?.value?.trim() ?? "",
        censored,
      });
      await loadSnapshot();
      showNotice("测试结果已完成并保留为不可变快照。", "success");
    });
  }

  function renderTests() {
    elements.testList.replaceChildren();
    if (!state.snapshot.tests.length) {
      elements.testList.append(emptyNode("还没有测试。\n从重复出现的复盘结论中登记一个可证伪假设。"));
      return;
    }
    for (const item of state.snapshot.tests) {
      const status = String(item.status ?? "REGISTERED").toUpperCase();
      const article = node("article");
      article.dataset.testCardId = String(item.id ?? item.testId ?? "");
      const header = node("div", "review-item-head");
      header.append(
        node("h3", "", item.title ?? truncate(item.hypothesis, 90) ?? "未命名测试"),
        badge(status),
      );
      const details = node("dl");
      appendDefinition(details, "假设", item.hypothesis ?? "—");
      appendDefinition(details, "主指标", item.primaryMetric ?? item.metric ?? "—");
      appendDefinition(details, "主窗口", horizonLabel(item.primaryHorizon ?? item.primaryWindow ?? item.window));
      appendDefinition(details, "关联案例", linkedCaseLabel(item.caseId));
      appendDefinition(details, "关联规则", linkedRuleLabel(item.ruleId));
      const result = item.result ?? item.results ?? item.statistics;
      if (result) appendDefinition(details, "结果", result.summary ?? formatStats(result));
      if (item.outcomeR != null) appendDefinition(details, "净R", signedNumber(item.outcomeR));
      article.append(header, node("p", "", item.notes ?? item.cohort ?? item.inclusionCriteria ?? "尚未描述样本条件。"), details);
      if (!testComplete(item)) {
        const resultForm = node("div", "review-test-result-form");
        const outcome = labeledInput("净R", "number", "例如 1.25");
        outcome.input.step = "0.01";
        outcome.input.dataset.testOutcomeR = "true";
        const benchmark = labeledInput("基准收益 %", "number", "例如 2.4");
        benchmark.input.step = "0.01";
        benchmark.input.dataset.testBenchmarkReturn = "true";
        const source = document.createElement("select");
        source.dataset.testOutcomeSource = "true";
        source.append(new Option("人工结果 · 仅观察性", "manual"));
        const sourceLabel = node("label");
        sourceLabel.append(node("span", "", "结果来源"), source);
        const notes = labeledInput("结果备注", "text", "异常路径、成本或删失原因");
        notes.input.dataset.testResultNotes = "true";
        const censoredLabel = node("label", "review-inline-check");
        const censored = document.createElement("input");
        censored.type = "checkbox";
        censored.dataset.testCensored = "true";
        censoredLabel.append(censored, node("span", "", "删失样本"));
        resultForm.append(outcome.label, benchmark.label, sourceLabel, notes.label, censoredLabel);
        const actions = node("div", "review-item-actions");
        const complete = actionButton("完成测试", "secondary");
        complete.dataset.completeTestId = String(item.id ?? item.testId ?? "");
        actions.append(complete);
        article.append(resultForm, actions);
      }
      elements.testList.append(article);
    }
  }

  function renderTestLinks() {
    const selectedCaseId = elements.testCase.value;
    const selectedRuleId = elements.testRule.value;
    elements.testCase.replaceChildren(new Option("不限定单一案例", ""));
    elements.testRule.replaceChildren(new Option("暂不关联规则", ""));
    for (const item of state.snapshot.cases) {
      elements.testCase.append(new Option(`${caseSymbol(item)} · ${casePeriod(item)}`, caseId(item)));
    }
    for (const item of state.snapshot.rules) {
      elements.testRule.append(new Option(`${item.title ?? "未命名规则"} · ${ruleStatus(item)}`, String(item.id ?? item.ruleId ?? "")));
    }
    if ([...elements.testCase.options].some((option) => option.value === selectedCaseId)) {
      elements.testCase.value = selectedCaseId;
    }
    if ([...elements.testRule.options].some((option) => option.value === selectedRuleId)) {
      elements.testRule.value = selectedRuleId;
    }
  }

  async function createRule(event) {
    event.preventDefault();
    if (state.loading) return;
    const draft = {
      title: elements.ruleTitle.value.trim(),
      condition: elements.ruleCondition.value.trim(),
      action: elements.ruleAction.value.trim(),
      falsification: elements.ruleInvalidation.value.trim(),
      invalidation: elements.ruleInvalidation.value.trim(),
      scope: elements.ruleScope.value.trim(),
      status: "HYPOTHESIS",
    };
    await runAction("正在建立规则假设…", async () => {
      await callReview("createRule", draft);
      elements.ruleForm.reset();
      await loadSnapshot();
      showNotice("规则已从HYPOTHESIS状态建立；必须经过登记测试才能晋升。", "success");
    });
  }

  async function transitionRule(ruleId, to, button) {
    if (!ruleId || !RULE_STATES.includes(to) || state.loading) return;
    button.disabled = true;
    await runAction(`正在迁移规则至 ${to}…`, async () => {
      await callReview("transitionRule", { ruleId, to: to.toLowerCase() });
      await loadSnapshot();
      showNotice(`规则状态已迁移至 ${to}。`, "success");
    });
  }

  function renderRules() {
    elements.ruleList.replaceChildren();
    if (!state.snapshot.rules.length) {
      elements.ruleList.append(emptyNode("还没有规则。\n规则应来自重复证据，而不是一次交易结果。"));
      return;
    }
    for (const item of state.snapshot.rules) {
      const id = String(item.id ?? item.ruleId ?? "");
      const status = ruleStatus(item);
      const article = node("article");
      article.dataset.ruleCardId = id;
      const header = node("div", "review-item-head");
      header.append(node("h3", "", item.title ?? "未命名规则"), badge(status));
      const details = node("dl");
      appendDefinition(details, "条件", item.condition ?? item.currentVersion?.condition ?? "—");
      appendDefinition(details, "动作", item.action ?? item.currentVersion?.action ?? "—");
      appendDefinition(details, "失效", item.falsification ?? item.invalidation ?? item.currentVersion?.invalidation ?? "—");
      appendDefinition(details, "范围", item.scope ?? item.currentVersion?.scope ?? "—");
      appendDefinition(details, "版本", String(item.version ?? item.currentVersion?.version ?? 1));
      const metrics = state.snapshot.ruleMetrics[id];
      if (metrics) {
        appendDefinition(details, "证据", metrics.evidenceLabel ?? "—");
        appendDefinition(details, "样本 / 核验", `${formatNumber(metrics.sampleCount, 0)} / ${formatNumber(metrics.verifiedSampleCount, 0)}`);
        appendDefinition(details, "期望R / 胜率", `${signedNumber(metrics.expectancyR)} / ${signedPercent(metrics.winRatePercent)}`);
        appendDefinition(details, "赔率 / 盈亏平衡胜率", `${formatNumber(metrics.payoffRatio)} / ${signedPercent(metrics.breakEvenWinRatePercent)}`);
        appendDefinition(details, "Profit Factor / 尾部亏损率", `${formatNumber(metrics.profitFactor)} / ${signedPercent(metrics.tailLossRatePercent)}`);
      }
      article.append(header, details);
      const actions = node("div", "review-item-actions");
      const select = document.createElement("select");
      select.dataset.ruleNextState = "true";
      for (const optionStatus of RULE_STATES) {
        const option = new Option(optionStatus, optionStatus, false, optionStatus === nextRuleState(status));
        select.append(option);
      }
      const transition = actionButton("迁移状态", "secondary");
      transition.dataset.transitionRuleId = id;
      transition.disabled = !id;
      actions.append(select, transition);
      article.append(actions);
      elements.ruleList.append(article);
    }
  }

  async function addRuleReview(event) {
    event.preventDefault();
    if (state.loading) return;
    const ruleId = elements.governanceRule.value;
    if (!ruleId) return;
    const verdict = elements.governanceVerdict.value;
    const payload = {
      ruleId,
      keep: elements.governanceKeep.value.trim(),
      evidence: elements.governanceKeep.value.trim(),
      change: elements.governanceChange.value.trim(),
      nextTrigger: elements.governanceNext.value.trim(),
      verdict,
      decision: verdict === "MODIFY" ? "change" : verdict.toLowerCase(),
    };
    await runAction("正在追加规则Review…", async () => {
      await callReview("addRuleReview", payload);
      elements.governanceForm.reset();
      await loadSnapshot();
      showNotice("规则Review已作为追加记录保存；旧规则版本未被覆盖。", "success");
    });
  }

  function renderGovernance() {
    const selected = elements.governanceRule.value;
    elements.governanceRule.replaceChildren(new Option("请选择规则", ""));
    for (const rule of state.snapshot.rules) {
      const id = String(rule.id ?? rule.ruleId ?? "");
      elements.governanceRule.append(new Option(`${rule.title ?? "未命名规则"} · ${ruleStatus(rule)}`, id));
    }
    if ([...elements.governanceRule.options].some((option) => option.value === selected)) {
      elements.governanceRule.value = selected;
    }

    const reviews = [...state.snapshot.reviews].sort((left, right) =>
      timestamp(right.createdAt ?? right.reviewedAt) - timestamp(left.createdAt ?? left.reviewedAt),
    );
    elements.governanceList.replaceChildren();
    if (!reviews.length) {
      elements.governanceList.append(emptyNode("还没有规则Review。\n每次Review都应明确Keep、Change和Next trigger。"));
      return;
    }
    for (const item of reviews) {
      const rule = state.snapshot.rules.find((candidate) =>
        String(candidate.id ?? candidate.ruleId ?? "") === String(item.ruleId ?? ""),
      );
      const article = node("article");
      const header = node("div", "review-item-head");
      header.append(
        node("h3", "", rule?.title ?? item.ruleTitle ?? "规则Review"),
        badge(String(item.decision ?? item.verdict ?? "REVIEW").toUpperCase()),
      );
      const details = node("dl");
      appendDefinition(details, "Keep", item.evidence ?? item.keep ?? "—");
      appendDefinition(details, "Change", item.change ?? "—");
      appendDefinition(details, "Next trigger", item.nextTrigger ?? "—");
      appendDefinition(details, "时间", formatDateTime(item.createdAt ?? item.reviewedAt));
      article.append(header, details);
      elements.governanceList.append(article);
    }
  }

  async function runAction(message, operation) {
    if (state.loading) return;
    setLoading(true, message);
    try {
      await operation();
    } catch (error) {
      showNotice(error.message || "操作失败。", "error");
    } finally {
      setLoading(false);
      renderSelectedCase();
    }
  }

  async function callReview(method, payload) {
    const target = api?.review?.[method];
    if (typeof target !== "function") throw new Error(`复盘接口 ${method} 尚未就绪。`);
    const result = arguments.length > 1 ? await target(payload) : await target();
    if (result?.ok === false) throw new Error(result.error || result.message || `${method} 失败。`);
    return result;
  }

  function firstReviewMethod(methods) {
    return methods.find((method) => typeof api?.review?.[method] === "function") ?? null;
  }

  async function optionalReviewCall(methods, payload) {
    const method = firstReviewMethod(methods);
    return method ? callReview(method, payload) : null;
  }

  function setLoading(value, message = "") {
    state.loading = Boolean(value);
    elements.workspace.setAttribute("aria-busy", String(state.loading));
    elements.syncHistory.disabled = state.loading;
    elements.newCase.disabled = state.loading;
    elements.intakeSync.disabled = state.loading;
    elements.createFromRecords.disabled = state.loading || !selectedEventCandidate();
    elements.analyzeCase.disabled = state.loading || !selectedCase();
    updateBatchButton();
    renderIntakePagination();
    if (state.loading && message) showNotice(message, "loading");
    if (!state.loading) {
      updateLinkButton();
      updateIntakeSelectionSummary();
    }
  }

  function showNotice(message, tone = "success") {
    if (!message) return clearNotice();
    elements.notice.hidden = false;
    elements.notice.className = `review-notice${tone === "error" || tone === "warning" ? ` ${tone}` : ""}${tone === "loading" ? " review-loading" : ""}`;
    elements.notice.textContent = message;
  }

  function clearNotice() {
    elements.notice.hidden = true;
    elements.notice.className = "review-notice";
    elements.notice.textContent = "";
  }

  function normalizeIntake(source = {}, root = {}) {
    const archive = source?.archive ?? source?.brokerArchive ?? source?.tradeHistory ?? source ?? {};
    const explicitRecords = arrayValue(
      source?.records,
      source?.availableRecords,
      source?.unlinkedRecords,
      source?.brokerRecords,
      root?.brokerRecords,
    );
    const orders = arrayValue(source?.orders, archive?.orders).map((item) => ({
      ...item,
      _reviewKind: "order",
      recordId: item?.recordId ?? item?.orderId ?? item?.order_id,
    }));
    const executions = arrayValue(source?.executions, source?.trades, archive?.executions, archive?.trades).map((item) => ({
      ...item,
      _reviewKind: "execution",
      recordId: item?.recordId ?? item?.tradeId ?? item?.trade_id ?? item?.executionId,
    }));
    const records = explicitRecords.length
      ? explicitRecords.map((item) => ({
        ...item,
        _reviewKind: brokerRecordType(item),
        recordId: brokerRecordId(item),
      }))
      : [...orders, ...executions];
    const dedupedRecords = [...new Map(records
      .filter((item) => brokerRecordId(item))
      .map((item) => [brokerRecordId(item), item])).values()]
      .sort((left, right) => timestamp(brokerRecordAt(right)) - timestamp(brokerRecordAt(left)));
    const groups = arrayValue(source?.groups, source?.associationCandidates, source?.eventGroups);
    const groupEvents = groups.flatMap((item) => arrayValue(item?.eventCandidates, item?.events).length
      ? arrayValue(item?.eventCandidates, item?.events)
      : item?.eventCandidate || item?.event ? [item.eventCandidate ?? item.event] : []);
    const eventCandidates = arrayValue(
      source?.eventCandidates,
      source?.earningsEvents,
      source?.events,
      root?.eventCandidates,
    );
    const dedupedEvents = [...new Map([...eventCandidates, ...groupEvents]
      .filter((item) => eventCandidateId(item) && eventSymbol(item) && eventAt(item) && eventPeriod(item) !== "待确认季度")
      .map((item) => [eventCandidateId(item), item])).values()];
    const orderCount = numberOr(source?.orderCount, archive?.orderCount, orders.length);
    const executionCount = numberOr(source?.executionCount, source?.tradeCount, archive?.executionCount, executions.length);
    return {
      records: dedupedRecords,
      eventCandidates: dedupedEvents,
      groups,
      syncedAt: source?.syncedAt ?? archive?.syncedAt ?? null,
      range: source?.range ?? archive?.range ?? null,
      capabilities: source?.capabilities ?? archive?.capabilities ?? {},
      completeness: source?.completeness ?? archive?.completeness ?? {},
      warnings: arrayValue(source?.warnings, archive?.warnings),
      orderCount: orderCount || dedupedRecords.filter((item) => brokerRecordType(item) === "order").length,
      executionCount: executionCount || dedupedRecords.filter((item) => brokerRecordType(item) === "execution").length,
      totalRecordCount: numberOr(source?.totalRecordCount, archive?.totalRecordCount, dedupedRecords.length),
      offset: nonNegativeInteger(source?.offset ?? archive?.offset, 0),
      limit: nonNegativeInteger(source?.limit ?? archive?.limit, INTAKE_PAGE_LIMIT),
      nextOffset: nullableNonNegativeInteger(source?.nextOffset ?? archive?.nextOffset),
    };
  }

  function pruneIntakeSelection() {
    for (const record of state.snapshot.intake.records) {
      const id = brokerRecordId(record);
      if (state.selectedRecordIds.has(id)) state.selectedRecordCache.set(id, record);
    }
    reconcileSelectedEvent();
  }

  function renderQuarterFilter() {
    const selected = state.quarterFilter;
    const values = [...new Set([
      ...state.snapshot.cases.map(casePeriod),
      ...state.snapshot.intake.eventCandidates.map(eventPeriod),
    ].filter((value) => value && value !== "未标记季度" && value !== "待确认季度"))]
      .sort((left, right) => right.localeCompare(left, "zh-CN", { numeric: true }));
    elements.quarterFilter.replaceChildren(new Option("全部财报季度", ""));
    values.forEach((value) => elements.quarterFilter.append(new Option(value, value)));
    if (values.includes(selected)) elements.quarterFilter.value = selected;
    else state.quarterFilter = "";
  }

  function casesForSelectedQuarter() {
    if (!state.quarterFilter) return [];
    return state.snapshot.cases.filter((item) => (
      casePeriod(item) === state.quarterFilter && caseHasConfirmedBrokerRecords(item)
    ));
  }

  function caseHasConfirmedBrokerRecords(item) {
    const links = item?.brokerLinks;
    if (!links?.confirmedAt) return false;
    return arrayValue(links.orderIds).length + arrayValue(links.executionIds).length > 0;
  }

  function updateBatchButton() {
    const count = casesForSelectedQuarter().length;
    elements.batchAnalyze.disabled = state.loading || !state.quarterFilter || !count;
    elements.batchAnalyze.textContent = state.quarterFilter
      ? `季度通盘复盘 · ${count}`
      : "季度通盘复盘";
  }

  function recordAlreadyLinked(recordId) {
    if (!recordId) return false;
    const candidate = String(recordId);
    return state.snapshot.cases.some((item) => {
      const linked = new Set([
        ...arrayValue(item?.brokerLinks?.orderIds).flatMap((id) => {
          const raw = stripBrokerRecordPrefix(id);
          return [String(id), raw, `order:${raw}`];
        }),
        ...arrayValue(item?.brokerLinks?.executionIds).flatMap((id) => {
          const raw = stripBrokerRecordPrefix(id);
          return [String(id), raw, `execution:${raw}`];
        }),
      ]);
      return linked.has(candidate) || linked.has(stripBrokerRecordPrefix(candidate));
    });
  }

  function stripBrokerRecordPrefix(value) {
    return String(value ?? "").replace(/^(?:order|execution):/, "");
  }

  function brokerRecordType(item) {
    const value = String(item?._reviewKind ?? item?.type ?? item?.kind ?? item?.recordType ?? "").toLowerCase();
    if (value.includes("exec") || value.includes("trade") || item?.tradeId || item?.executionId) return "execution";
    return "order";
  }

  function brokerSymbol(item) {
    return normalizeSymbol(item?.symbol ?? item?.ticker);
  }

  function brokerRecordAt(item) {
    return item?.activityAt ?? item?.doneAt ?? item?.executedAt ?? item?.tradeDoneAt ?? item?.submittedAt ?? item?.updatedAt ?? item?.createdAt ?? null;
  }

  function eventCandidateId(item) {
    return String(item?.eventCandidateId ?? item?.id ?? item?.eventId ?? item?.candidateId ?? [eventSymbol(item), eventAt(item), eventPeriod(item)].join(":"));
  }

  function eventSymbol(item) {
    return normalizeSymbol(item?.symbol ?? item?.ticker ?? item?.security?.symbol);
  }

  function eventAt(item) {
    const value = item?.eventAt ?? item?.scheduledAt ?? item?.reportAt ?? item?.announceAt ?? item?.dateTime ?? item?.date;
    return timestamp(value) ? new Date(timestamp(value)).toISOString() : null;
  }

  function eventPeriod(item) {
    return String(item?.fiscalQuarter ?? item?.fiscalPeriod ?? item?.reportPeriod ?? item?.quarter ?? item?.period ?? "待确认季度");
  }

  function eventSession(item) {
    return String(item?.eventSession ?? item?.session ?? item?.timing ?? "unknown").toLowerCase();
  }

  function eventSessionLabel(item) {
    const value = eventSession(item);
    if (["bmo", "before_open", "pre_market"].includes(value)) return "盘前";
    if (["amc", "after_close", "post_market"].includes(value)) return "盘后";
    if (value === "intraday") return "盘中";
    return "时段待确认";
  }

  function eventDistanceMs(candidate, records) {
    const times = records.map((item) => timestamp(brokerRecordAt(item))).filter(Boolean).sort((a, b) => a - b);
    if (!times.length) return Number.POSITIVE_INFINITY;
    const middle = times[Math.floor(times.length / 2)];
    return timestamp(eventAt(candidate)) - middle;
  }

  function closestEventCandidate(candidates, records) {
    return candidates.reduce((best, candidate) => {
      if (!best) return candidate;
      return Math.abs(eventDistanceMs(candidate, records)) < Math.abs(eventDistanceMs(best, records)) ? candidate : best;
    }, null);
  }

  function eventDistanceLabel(candidate, records) {
    const distance = eventDistanceMs(candidate, records);
    if (!Number.isFinite(distance)) return "与订单距离待计算";
    const days = Math.round(Math.abs(distance) / (24 * 60 * 60 * 1000));
    return distance >= 0 ? `所选交易后 ${days} 天公布` : `所选交易发生在公布后约 ${days} 天`;
  }

  function reviewCaseIdFromResult(result) {
    return String(
      result?.caseId
      ?? result?.case?.id
      ?? result?.reviewCase?.id
      ?? result?.data?.caseId
      ?? result?.data?.reviewCase?.id
      ?? "",
    );
  }

  function formatShortDateTime(value) {
    const time = timestamp(value);
    if (!time) return "—";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(time);
  }

  function formatDateRange(values) {
    const times = values.map(timestamp).filter(Boolean).sort((a, b) => a - b);
    if (!times.length) return "—";
    if (times.length === 1) return formatShortDateTime(times[0]);
    return `${formatShortDateTime(times[0])} → ${formatShortDateTime(times.at(-1))}`;
  }

  function caseId(item) {
    return String(item?.id ?? item?.caseId ?? item?.reviewCaseId ?? "");
  }

  function caseSymbol(item) {
    return normalizeSymbol(item?.symbol ?? item?.ticker) || "—";
  }

  function casePeriod(item) {
    return String(item?.fiscalPeriod ?? item?.fiscalQuarter ?? item?.period ?? "未标记季度");
  }

  function caseStatus(item) {
    return String(item?.status ?? (item?.frozenAt ? "FROZEN" : "DRAFT")).toUpperCase();
  }

  function caseFrozen(item) {
    return Boolean(item?.frozenAt ?? item?.exAnteFrozenAt) || CASE_FROZEN_STATES.has(caseStatus(item));
  }

  function casePrimaryWindow(item) {
    return String(item?.primaryHorizon ?? item?.primaryWindow ?? item?.evaluationPlan?.primaryWindow ?? "t5");
  }

  function brokerRecordId(item) {
    return String(item?.id ?? item?.recordId ?? item?.executionId ?? item?.orderId ?? "");
  }

  function testComplete(item) {
    return ["COMPLETED", "CLOSED", "VALIDATED"].includes(String(item?.status ?? "").toUpperCase())
      || Boolean(item?.completedAt);
  }

  function ruleStatus(item) {
    const value = String(item?.status ?? item?.currentVersion?.status ?? "HYPOTHESIS").toUpperCase();
    return RULE_STATES.includes(value) ? value : "HYPOTHESIS";
  }

  function nextRuleState(status) {
    const index = RULE_STATES.indexOf(status);
    return RULE_STATES[Math.min(index + 1, RULE_STATES.length - 1)] ?? "HYPOTHESIS";
  }

  function statusClass(status) {
    const value = String(status).toLowerCase();
    if (value.includes("frozen") || value.includes("closed") || value.includes("validated")) return "validated";
    if (value.includes("test") || value.includes("provisional") || value.includes("registered")) return "testing";
    if (value.includes("retire") || value.includes("reject")) return "retired";
    if (["keep", "modify", "review"].some((item) => value.includes(item))) return "review";
    return "hypothesis";
  }

  function badge(status) {
    return node("span", `review-state-badge ${statusClass(status)}`, status);
  }

  function actionButton(text, kind = "secondary") {
    const button = node("button", `review-button ${kind}`, text);
    button.type = "button";
    return button;
  }

  function labeledInput(label, type, placeholder) {
    const wrapper = node("label");
    const input = document.createElement("input");
    input.type = type;
    input.placeholder = placeholder;
    wrapper.append(node("span", "", label), input);
    return { label: wrapper, input };
  }

  function linkedCaseLabel(id) {
    const item = state.snapshot.cases.find((candidate) => caseId(candidate) === String(id ?? ""));
    return item ? `${caseSymbol(item)} · ${casePeriod(item)}` : "未关联";
  }

  function linkedRuleLabel(id) {
    const item = state.snapshot.rules.find((candidate) => String(candidate.id ?? candidate.ruleId ?? "") === String(id ?? ""));
    return item?.title ?? "未关联";
  }

  function emptyNode(text, compact = false) {
    return node("div", `review-empty${compact ? " compact" : ""}`, text);
  }

  function metricCell(label, value) {
    const cell = node("div");
    cell.append(node("span", "", label), node("strong", "", value));
    return cell;
  }

  function appendDefinition(list, term, description) {
    list.append(node("dt", "", term), node("dd", "", String(description ?? "—")));
  }

  function node(tag, className = "", text = null) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = String(text);
    return element;
  }

  function arrayValue(...values) {
    return values.find(Array.isArray) ?? [];
  }

  function normalizeSymbol(value) {
    return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9._:-]/g, "").slice(0, 32);
  }

  function setSelectValue(select, value) {
    const normalized = String(value ?? "");
    if ([...select.options].some((option) => option.value === normalized)) select.value = normalized;
  }

  function valueOrEmpty(value) {
    return value == null || !Number.isFinite(Number(value)) ? "" : String(value);
  }

  function numberOr(...values) {
    for (const value of values) {
      if (value != null && Number.isFinite(Number(value))) return Number(value);
    }
    return 0;
  }

  function nonNegativeInteger(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric >= 0 ? numeric : fallback;
  }

  function nullableNonNegativeInteger(value) {
    if (value == null || value === "") return null;
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
  }

  function formatNumber(value, digits = 2) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "—";
    return numeric.toLocaleString("zh-CN", { maximumFractionDigits: digits });
  }

  function signedNumber(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "—";
    return `${numeric > 0 ? "+" : ""}${formatNumber(numeric, 2)}`;
  }

  function signedPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "—";
    return `${numeric > 0 ? "+" : ""}${formatNumber(numeric, 2)}%`;
  }

  function priceText(value, currency = "") {
    const numeric = Number(value);
    return node("span", "", Number.isFinite(numeric) ? `${String(currency ?? "")} ${formatNumber(numeric, 4)}`.trim() : "价格 —");
  }

  function formatDateTime(value) {
    const time = timestamp(value);
    if (!time) return "—";
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(time);
  }

  function timestamp(value) {
    const result = new Date(value ?? 0).getTime();
    return Number.isFinite(result) ? result : 0;
  }

  function localDateTimeValue(value) {
    const time = timestamp(value);
    if (!time) return "";
    const date = new Date(time);
    const local = new Date(time - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  }

  function inputDateTimeToIso(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function truncate(value, limit) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  function strategyLabel(value) {
    return {
      pre_hold: "财报前持有",
      pre_add: "财报前加仓",
      pre_reduce: "财报前减仓",
      pre_hedge: "财报前保护",
      post_confirm_entry: "财报后确认买入",
      post_reversal_exit: "财报后退出",
      pre_earnings_hold: "财报前持有",
      pre_earnings_add: "财报前加仓",
      pre_earnings_reduce: "财报前减仓",
      pre_earnings_hedge: "财报前保护",
      post_earnings_entry: "财报后确认买入",
      post_earnings_exit: "财报后退出",
      other: "其他",
    }[value] ?? String(value ?? "未分类");
  }

  function horizonLabel(value) {
    return {
      t1: "T+1",
      t3: "T+3",
      t5: "T+5",
      t20: "T+20",
      next_quarter: "下次财报",
      T1: "T+1",
      T3: "T+3",
      T5: "T+5",
      T20: "T+20",
    }[value] ?? String(value ?? "—");
  }

  function formatStats(value) {
    if (typeof value === "string") return value;
    const fields = [
      ["净期望R", value.netExpectancyR ?? value.expectancyR],
      ["胜率", value.winRatePercent],
      ["样本", value.sampleSize],
    ].filter((entry) => entry[1] != null);
    return fields.length ? fields.map(([key, item]) => `${key} ${formatNumber(item)}`).join(" · ") : "结果已记录";
  }
})();
