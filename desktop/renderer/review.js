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

  const state = {
    mode: "cockpit",
    activeTab: "cases",
    loading: false,
    selectedCaseId: null,
    creatingCase: false,
    caseFilter: "",
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
    syncHistory: document.querySelector("#review-sync-history"),
    caseSearch: document.querySelector("#review-case-search"),
    caseList: document.querySelector("#review-case-list"),
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
    linkRecords: document.querySelector("#review-link-records"),
    saveCase: document.querySelector("#review-save-case"),
    brokerMatches: document.querySelector("#review-broker-matches"),
    brokerMatchCount: document.querySelector("#review-broker-match-count"),
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

    elements.newCase?.addEventListener("click", beginNewCase);
    elements.syncHistory?.addEventListener("click", syncTradeHistory);
    elements.caseSearch?.addEventListener("input", (event) => {
      state.caseFilter = String(event.target.value ?? "").trim().toLowerCase();
      renderCaseList();
    });
    elements.caseList?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-review-case-id]");
      if (button) selectCase(button.dataset.reviewCaseId);
    });
    elements.caseForm?.addEventListener("submit", saveCase);
    elements.freezeCase?.addEventListener("click", freezeSelectedCase);
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

  async function loadSnapshot({ preserveNewCase = false } = {}) {
    const managesLoadingState = !state.loading;
    if (managesLoadingState) setLoading(true, "正在读取加密复盘记录…");
    try {
      const result = await callReview("snapshot");
      state.snapshot = normalizeSnapshot(result);
      const caseExists = state.snapshot.cases.some((item) => caseId(item) === state.selectedCaseId);
      if (!preserveNewCase && !caseExists) {
        state.selectedCaseId = state.snapshot.cases[0] ? caseId(state.snapshot.cases[0]) : null;
        state.creatingCase = !state.selectedCaseId;
      }
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

  function normalizeSnapshot(result) {
    const source = result?.snapshot ?? result?.data ?? result ?? {};
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
    };
  }

  function emptySnapshot() {
    return { cases: [], brokerMatches: {}, tests: [], rules: [], reviews: [], ruleMetrics: {}, summary: {} };
  }

  function renderAll() {
    renderSummary();
    renderCaseList();
    renderSelectedCase();
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
  }

  function renderCaseList() {
    const cases = state.snapshot.cases.filter((item) => {
      if (!state.caseFilter) return true;
      return [caseSymbol(item), casePeriod(item), item.strategyFamily, item.strategy]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(state.caseFilter);
    });
    elements.caseList.replaceChildren();
    if (!cases.length) {
      elements.caseList.append(emptyNode(
        state.caseFilter ? "没有匹配的案例。" : "还没有复盘案例。\n从财报前判断开始建立第一条记录。",
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

  function beginNewCase() {
    state.selectedCaseId = null;
    state.creatingCase = true;
    setReviewTab("cases");
    renderCaseList();
    renderSelectedCase();
    elements.caseSymbol.focus();
  }

  function selectCase(id) {
    if (!id) return;
    state.selectedCaseId = String(id);
    state.creatingCase = false;
    renderCaseList();
    renderSelectedCase();
  }

  function selectedCase() {
    return state.snapshot.cases.find((item) => caseId(item) === state.selectedCaseId) ?? null;
  }

  function renderSelectedCase() {
    const item = selectedCase();
    if (!item) {
      resetCaseForm();
      renderBrokerMatches(null);
      renderCheckpoints(null);
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
    renderBrokerMatches(item);
    renderCheckpoints(item);
  }

  function resetCaseForm() {
    elements.caseForm.reset();
    elements.caseId.value = "";
    elements.caseHeading.textContent = "新建财报案例";
    setCaseStatus("DRAFT");
    setSelectValue(elements.caseWindow, "t5");
    setSelectValue(elements.caseStrategy, "pre_hold");
    setCaseFormFrozen(false);
    elements.freezeNote.textContent = "草稿可编辑；封存后只能追加事后记录。";
    elements.freezeCase.disabled = true;
    elements.freezeCase.textContent = "封存财报前判断";
    elements.saveCase.disabled = state.loading;
    elements.saveCase.textContent = "保存案例";
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
    await runAction(currentId ? "正在更新案例…" : "正在建立案例…", async () => {
      const result = currentId
        ? await callReview("updateCase", { caseId: currentId, patch: draft })
        : await callReview("createCase", draft);
      state.selectedCaseId = String(
        result?.caseId ?? result?.case?.id ?? result?.reviewCase?.id ?? currentId ?? "",
      ) || null;
      state.creatingCase = false;
      await loadSnapshot();
      showNotice(currentId ? "案例草稿已更新。" : "案例已建立；请在财报前核对并封存。", "success");
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
    elements.brokerMatches.replaceChildren();
    elements.brokerMatchCount.textContent = `${records.length} 条`;
    if (!records.length) {
      elements.brokerMatches.append(emptyNode(
        item ? "暂无匹配候选。可同步长桥历史后重试。" : "先保存案例，再匹配订单与成交。",
        true,
      ));
      updateLinkButton();
      return;
    }
    for (const record of records) {
      const id = brokerRecordId(record);
      const row = node("label", "review-record-row");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.brokerRecordId = id;
      checkbox.disabled = record.linked === true || record.confirmed === true;
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
    const item = selectedCase();
    await runAction("正在同步长桥历史订单与成交…", async () => {
      await callReview("syncTradeHistory", {
        caseId: item ? caseId(item) : null,
        symbol: item ? caseSymbol(item) : null,
        eventAt: item ? item.eventAt ?? item.event?.scheduledAt ?? null : null,
      });
      await loadSnapshot({ preserveNewCase: state.creatingCase });
      showNotice("长桥历史已同步；自动匹配仅作为候选，仍需手动确认归属。", "success");
    });
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

  function setLoading(value, message = "") {
    state.loading = Boolean(value);
    elements.workspace.setAttribute("aria-busy", String(state.loading));
    elements.syncHistory.disabled = state.loading;
    elements.newCase.disabled = state.loading;
    if (state.loading && message) showNotice(message, "loading");
    if (!state.loading) updateLinkButton();
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

  function normalizeTags(value) {
    const values = Array.isArray(value) ? value : String(value ?? "").split(/[,，]/);
    return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))].slice(0, 30);
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
