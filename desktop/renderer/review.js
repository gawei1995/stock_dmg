(() => {
  "use strict";

  const api = window.cockpit;
  const WORKSPACE_MODES = new Set(["cockpit", "review"]);
  const REVIEW_TABS = new Set(["research", "cycles", "cases", "tests"]);
  const CYCLE_TYPES = new Set(["catalyst", "position_lifecycle", "monthly_portfolio", "trade_window"]);
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
  const EVENT_LOOKUP_DEBOUNCE_MS = 180;
  const RECENT_EARNINGS_PREVIEW_MS = 240 * 24 * 60 * 60 * 1000;
  const RECENT_EVENT_CACHE_FRESH_MS = 15 * 60 * 1000;

  const state = {
    mode: "cockpit",
    activeTab: "cycles",
    cyclePane: "welcome",
    selectedCycleId: null,
    casePane: "intake",
    loading: false,
    archiveLedgerBusy: false,
    selectedCaseId: null,
    caseFilter: "",
    quarterFilter: "",
    intakeSearch: "",
    intakeKind: "",
    intakePageLoading: false,
    intakePageToken: 0,
    intakeSearchTimer: null,
    eventLookupToken: 0,
    eventLookupTimer: null,
    eventLookupLoading: false,
    eventLookupMessage: "",
    recentEventRequestKey: "",
    recentEventRequestToken: 0,
    recentEventRequests: new Map(),
    prefetchedEventSymbol: null,
    recentEventLoading: false,
    selectedRecordIds: new Set(),
    selectedRecordCache: new Map(),
    editingCaseLinkId: null,
    editingCycleLinkId: null,
    selectedEventId: null,
    suggestedEventId: null,
    caseDrafts: new Map(),
    cycleDrafts: new Map(),
    validationDrafts: new Map(),
    accountScopeId: null,
    snapshotUpdateSequence: -1,
    snapshotLoading: false,
    workspaceRequestToken: 0,
    snapshotLoaded: false,
    snapshotReadError: null,
    snapshotLoadedAt: null,
    snapshotRequestToken: 0,
    selectedBatchCaseIds: new Set(),
    pendingLearningProposal: null,
    pendingOrderFirstCycle: null,
    caseMigrationPreview: null,
    caseMigrationRequestToken: 0,
    cycleTradePathResults: new Map(),
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
    cycleCount: document.querySelector("#review-cycle-count"),
    caseCount: document.querySelector("#review-case-count"),
    testCount: document.querySelector("#review-test-count"),
    ruleCount: document.querySelector("#review-rule-count"),
    dueCount: document.querySelector("#review-due-count"),
    newCycle: document.querySelector("#review-new-cycle"),
    newCase: document.querySelector("#review-new-case"),
    batchAnalyze: document.querySelector("#review-batch-analyze"),
    syncHistory: document.querySelector("#review-sync-history"),
    captureSnapshot: document.querySelector("#review-capture-snapshot"),
    backgroundCapture: document.querySelector("#review-background-capture"),
    exportBackup: document.querySelector("#review-export-backup"),
    restoreBackup: document.querySelector("#review-restore-backup"),
    archiveLedger: document.querySelector("#review-ledger-archive"),
    archiveLedgerForms: [...document.querySelectorAll("[data-ledger-archive-kind]")],
    archiveLedgerStatus: document.querySelector("#review-ledger-archive-status"),
    snapshotLedgerStatus: document.querySelector("#review-snapshot-ledger-status"),
    snapshotCoverage: document.querySelector("#review-snapshot-coverage"),
    snapshotCoverageSummary: document.querySelector("#review-snapshot-coverage-summary"),
    snapshotCoverageDays: document.querySelector("#review-snapshot-coverage-days"),
    showIntake: document.querySelector("#review-show-intake"),
    showCases: document.querySelector("#review-show-cases"),
    intakeCount: document.querySelector("#review-intake-count"),
    listCaseCount: document.querySelector("#review-list-case-count"),
    caseSearch: document.querySelector("#review-case-search"),
    quarterFilter: document.querySelector("#review-quarter-filter"),
    batchScope: document.querySelector("#review-batch-scope"),
    batchSelectionStatus: document.querySelector("#review-batch-selection-status"),
    batchSelectVisible: document.querySelector("#review-batch-select-visible"),
    batchClear: document.querySelector("#review-batch-clear"),
    caseList: document.querySelector("#review-case-list"),
    intakePanel: document.querySelector("#review-intake-panel"),
    caseDetail: document.querySelector("#review-case-detail"),
    intakeStatus: document.querySelector("#review-intake-status"),
    intakeCoverage: document.querySelector("#review-intake-coverage"),
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
    intakeTradeReview: document.querySelector("#review-intake-trade-review"),
    intakeCancelLinkEdit: document.querySelector("#review-intake-cancel-link-edit"),
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
    editBrokerLinks: document.querySelector("#review-edit-broker-links"),
    previewCaseMigration: document.querySelector("#review-case-migrate-preview"),
    caseMigration: document.querySelector("#review-case-migration"),
    caseMigrationSummary: document.querySelector("#review-case-migration-summary"),
    caseMigrationLimitations: document.querySelector("#review-case-migration-limitations"),
    confirmCaseMigration: document.querySelector("#review-case-migrate-confirm"),
    cancelCaseMigration: document.querySelector("#review-case-migrate-cancel"),
    brokerLinkNote: document.querySelector("#review-broker-link-note"),
    checkpoints: document.querySelector("#review-checkpoints"),
    cycleCreateOpen: document.querySelector("#review-cycle-create-open"),
    quickMonthForm: document.querySelector("#review-quick-month-form"),
    quickMonth: document.querySelector("#review-quick-month"),
    quickMonthBenchmark: document.querySelector("#review-quick-month-benchmark"),
    quickMonthRigorous: document.querySelector("#review-quick-month-rigorous"),
    quickSingleSelection: document.querySelector("#review-quick-single-selection"),
    quickSingleCreate: document.querySelector("#review-quick-single-create"),
    orderFirstNoteDialog: document.querySelector("#review-order-first-note-dialog"),
    orderFirstNoteForm: document.querySelector("#review-order-first-note-form"),
    orderFirstNoteScope: document.querySelector("#review-order-first-note-scope"),
    orderFirstRecalledJudgment: document.querySelector("#review-order-first-recalled-judgment"),
    orderFirstLesson: document.querySelector("#review-order-first-lesson"),
    orderFirstForwardHypothesis: document.querySelector("#review-order-first-forward-hypothesis"),
    orderFirstNoteCancel: document.querySelector("#review-order-first-note-cancel"),
    orderFirstNoteBack: document.querySelector("#review-order-first-note-back"),
    orderFirstNoteSubmit: document.querySelector("#review-order-first-note-submit"),
    cycleCreateCancel: document.querySelector("#review-cycle-create-cancel"),
    cycleList: document.querySelector("#review-cycle-list"),
    cycleWelcome: document.querySelector("#review-cycle-welcome"),
    cycleForm: document.querySelector("#review-cycle-form"),
    cycleType: document.querySelector("#review-cycle-type"),
    cycleTitle: document.querySelector("#review-cycle-title"),
    cycleSymbol: document.querySelector("#review-cycle-symbol"),
    cycleEventKind: document.querySelector("#review-cycle-event-kind"),
    cycleEventAt: document.querySelector("#review-cycle-event-at"),
    cycleStartAt: document.querySelector("#review-cycle-start-at"),
    cycleEndAt: document.querySelector("#review-cycle-end-at"),
    cycleMonth: document.querySelector("#review-cycle-month"),
    cycleBenchmark: document.querySelector("#review-cycle-benchmark"),
    cycleStartCondition: document.querySelector("#review-cycle-start-condition"),
    cycleEndCondition: document.querySelector("#review-cycle-end-condition"),
    cycleThesis: document.querySelector("#review-cycle-thesis"),
    cycleMarketBelief: document.querySelector("#review-cycle-market-belief"),
    cycleAction: document.querySelector("#review-cycle-action"),
    cycleInvalidation: document.querySelector("#review-cycle-invalidation"),
    cycleFundamental: document.querySelector("#review-cycle-fundamental"),
    cycleTechnical: document.querySelector("#review-cycle-technical"),
    cycleDetail: document.querySelector("#review-cycle-detail"),
    cycleDetailType: document.querySelector("#review-cycle-detail-type"),
    cycleDetailTitle: document.querySelector("#review-cycle-detail-title"),
    cycleDetailRange: document.querySelector("#review-cycle-detail-range"),
    cycleDetailStatus: document.querySelector("#review-cycle-detail-status"),
    cycleMetrics: document.querySelector("#review-cycle-metrics"),
    cyclePortfolioCoverage: document.querySelector("#review-cycle-portfolio-coverage"),
    cycleReconciliation: document.querySelector("#review-cycle-reconciliation"),
    cycleReconciliationStatus: document.querySelector("#review-cycle-reconciliation-status"),
    cycleReconciliationNote: document.querySelector("#review-cycle-reconciliation-note"),
    cycleReconciliationFields: document.querySelector("#review-cycle-reconciliation-fields"),
    cycleTradePath: document.querySelector("#review-cycle-trade-path"),
    cycleTradePathStatus: document.querySelector("#review-cycle-trade-path-status"),
    cycleTradePathAnchors: document.querySelector("#review-cycle-trade-path-anchors"),
    cycleTradePathSummary: document.querySelector("#review-cycle-trade-path-summary"),
    cycleTradePathSegments: document.querySelector("#review-cycle-trade-path-segments"),
    cycleTechnicalValidation: document.querySelector("#review-cycle-technical-validation"),
    cycleTechnicalValidationStatus: document.querySelector("#review-cycle-technical-validation-status"),
    cycleTechnicalValidationSummary: document.querySelector("#review-cycle-technical-validation-summary"),
    cycleTechnicalValidationNote: document.querySelector("#review-cycle-technical-validation-note"),
    cycleRetrospectiveForm: document.querySelector("#review-cycle-retrospective-form"),
    cycleRetrospectiveVersion: document.querySelector("#review-cycle-retrospective-version"),
    cycleRecalledJudgment: document.querySelector("#review-cycle-recalled-judgment"),
    cycleLesson: document.querySelector("#review-cycle-lesson"),
    cycleForwardHypothesis: document.querySelector("#review-cycle-forward-hypothesis"),
    cycleSaveRetrospective: document.querySelector("#review-cycle-save-retrospective"),
    cycleCloseForm: document.querySelector("#review-cycle-close-form"),
    cycleCloseAt: document.querySelector("#review-cycle-close-at"),
    cycleExAnteForm: document.querySelector("#review-cycle-ex-ante-form"),
    cycleDetailThesis: document.querySelector("#review-cycle-detail-thesis"),
    cycleDetailMarketBelief: document.querySelector("#review-cycle-detail-market-belief"),
    cycleDetailAction: document.querySelector("#review-cycle-detail-action"),
    cycleDetailInvalidation: document.querySelector("#review-cycle-detail-invalidation"),
    cycleDetailFundamental: document.querySelector("#review-cycle-detail-fundamental"),
    cycleDetailTechnical: document.querySelector("#review-cycle-detail-technical"),
    cycleSealTime: document.querySelector("#review-cycle-seal-time"),
    cycleFreezeNote: document.querySelector("#review-cycle-freeze-note"),
    cycleSeal: document.querySelector("#review-cycle-seal"),
    cycleUpdate: document.querySelector("#review-cycle-update"),
    cycleRecords: document.querySelector("#review-cycle-records"),
    cycleRecordCount: document.querySelector("#review-cycle-record-count"),
    cycleLinkHint: document.querySelector("#review-cycle-link-hint"),
    cycleLinkRecords: document.querySelector("#review-cycle-link-records"),
    cycleCheckpoints: document.querySelector("#review-cycle-checkpoints"),
    cycleCheckpointCount: document.querySelector("#review-cycle-checkpoint-count"),
    cycleCheckpointForm: document.querySelector("#review-cycle-checkpoint-form"),
    cycleCheckpointAt: document.querySelector("#review-cycle-checkpoint-at"),
    cycleCheckpointKind: document.querySelector("#review-cycle-checkpoint-kind"),
    cycleCheckpointAction: document.querySelector("#review-cycle-checkpoint-action"),
    cycleCheckpointFundamental: document.querySelector("#review-cycle-checkpoint-fundamental"),
    cycleCheckpointTechnical: document.querySelector("#review-cycle-checkpoint-technical"),
    cycleAnalyzeBlind: document.querySelector("#review-cycle-analyze-blind"),
    cycleAnalyzeOutcome: document.querySelector("#review-cycle-analyze-outcome"),
    cycleAnalyzeRetrospective: document.querySelector("#review-cycle-analyze-retrospective"),
    cyclePhaseGate: document.querySelector("#review-cycle-phase-gate"),
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
    testSuccessCriteria: document.querySelector("#review-test-success-criteria"),
    testSuccessOperator: document.querySelector("#review-test-success-operator"),
    testSuccessThreshold: document.querySelector("#review-test-success-threshold"),
    testList: document.querySelector("#review-test-list"),
    validationArchive: document.querySelector("#review-validation-archive"),
    archivedTestCount: document.querySelector("#review-archived-test-count"),
    archivedTestList: document.querySelector("#review-archived-test-list"),
    learningProposal: document.querySelector("#review-learning-proposal"),
    learningConfidence: document.querySelector("#review-learning-confidence"),
    learningHypothesis: document.querySelector("#review-learning-hypothesis"),
    learningEvidence: document.querySelector("#review-learning-evidence"),
    learningMetric: document.querySelector("#review-learning-metric"),
    learningWindow: document.querySelector("#review-learning-window"),
    learningMinCases: document.querySelector("#review-learning-min-cases"),
    learningInclusion: document.querySelector("#review-learning-inclusion"),
    learningExclusion: document.querySelector("#review-learning-exclusion"),
    learningSuccess: document.querySelector("#review-learning-success"),
    learningSuccessOperator: document.querySelector("#review-learning-success-operator"),
    learningSuccessThreshold: document.querySelector("#review-learning-success-threshold"),
    learningRuleTitle: document.querySelector("#review-learning-rule-title"),
    learningRuleAction: document.querySelector("#review-learning-rule-action"),
    learningRuleInvalidation: document.querySelector("#review-learning-rule-invalidation"),
    learningRuleScope: document.querySelector("#review-learning-rule-scope"),
    learningAccept: document.querySelector("#review-learning-accept"),
    learningDismiss: document.querySelector("#review-learning-dismiss"),
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
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const index = elements.tabs.indexOf(button);
        const next = event.key === "Home" ? 0 : event.key === "End" ? elements.tabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + elements.tabs.length) % elements.tabs.length;
        elements.tabs[next].focus();
        setReviewTab(elements.tabs[next].dataset.reviewTab);
      });
    });
    window.addEventListener("hashchange", () => applyRoute());
    window.addEventListener("cockpit:review-cycle-analysis-completed", () => {
      if (state.mode === "review" && state.activeTab !== "research") void loadSnapshot({ preservePane: true });
    });
    api.onAgentResult?.((envelope) => captureCycleTradePathResult(envelope));
    api.onReviewSnapshotUpdated?.(handleReviewSnapshotUpdate);
    window.addEventListener("cockpit:learning-proposal-opened", (event) => {
      void openLearningProposal(event.detail);
    });
    window.addEventListener("cockpit:research-open-review", (event) => {
      const id = event.detail?.cycleId;
      if (!id) return;
      state.activeTab = "cycles";
      void setWorkspace("review").then(() => {
        if (state.snapshot.cycles.some((item) => cycleId(item) === id)) selectCycle(id);
        else showNotice("该周期当前不可用，请核对账户与复盘记录。", "error");
      });
    });

    elements.newCycle?.addEventListener("click", () => showCycleCreate());
    elements.cycleCreateOpen?.addEventListener("click", () => showCycleCreate());
    elements.cycleCreateCancel?.addEventListener("click", showCycleWelcome);
    elements.cycleWelcome?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-cycle-create-type]");
      if (button) showCycleCreate(button.dataset.cycleCreateType);
    });
    elements.cycleList?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-review-cycle-id]");
      if (button) selectCycle(button.dataset.reviewCycleId);
    });
    elements.cycleType?.addEventListener("change", updateCycleTypeFields);
    elements.quickMonthForm?.addEventListener("submit", (event) => createQuickMonthly(event, "lightweight"));
    elements.quickMonthRigorous?.addEventListener("click", (event) => createQuickMonthly(event, "rigorous"));
    elements.quickSingleCreate?.addEventListener("click", createQuickSingle);
    elements.orderFirstNoteForm?.addEventListener("submit", confirmOrderFirstCycle);
    elements.orderFirstNoteCancel?.addEventListener("click", closeOrderFirstNoteDialog);
    elements.orderFirstNoteBack?.addEventListener("click", closeOrderFirstNoteDialog);
    elements.orderFirstNoteDialog?.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeOrderFirstNoteDialog();
    });
    elements.cycleForm?.addEventListener("submit", createCycle);
    elements.cycleExAnteForm?.addEventListener("input", rememberSelectedCycleDraft);
    elements.cycleExAnteForm?.addEventListener("change", rememberSelectedCycleDraft);
    elements.cycleRetrospectiveForm?.addEventListener("input", rememberSelectedCycleDraft);
    elements.cycleRetrospectiveForm?.addEventListener("change", rememberSelectedCycleDraft);
    elements.cycleRetrospectiveForm?.addEventListener("submit", saveSelectedCycleRetrospectiveNote);
    elements.cycleExAnteForm?.addEventListener("submit", updateSelectedCycle);
    elements.cycleSeal?.addEventListener("click", sealSelectedCycle);
    elements.cycleLinkRecords?.addEventListener("click", handleCycleLinkAction);
    elements.cycleCheckpointForm?.addEventListener("submit", addCycleCheckpoint);
    elements.cycleCloseForm?.addEventListener("submit", closePositionCycle);
    elements.cycleAnalyzeBlind?.addEventListener("click", () => prepareCycleAnalysis("blind"));
    elements.cycleAnalyzeOutcome?.addEventListener("click", () => prepareCycleAnalysis("outcome"));
    elements.cycleAnalyzeRetrospective?.addEventListener("click", () => void prepareCycleAnalysis("retrospective"));

    elements.newCase?.addEventListener("click", showIntakePane);
    elements.showIntake?.addEventListener("click", showIntakePane);
    elements.showCases?.addEventListener("click", showCasePane);
    elements.batchAnalyze?.addEventListener("click", prepareBatchAnalysis);
    elements.syncHistory?.addEventListener("click", syncTradeHistory);
    elements.captureSnapshot?.addEventListener("click", capturePortfolioSnapshot);
    elements.backgroundCapture?.addEventListener("click", toggleSnapshotBackgroundCapture);
    elements.exportBackup?.addEventListener("click", exportTrustedBackup);
    elements.restoreBackup?.addEventListener("click", restoreTrustedBackup);
    for (const form of elements.archiveLedgerForms) {
      form.addEventListener("submit", archiveLedger);
    }
    elements.intakeSync?.addEventListener("click", syncTradeHistory);
    elements.caseSearch?.addEventListener("input", (event) => {
      state.caseFilter = String(event.target.value ?? "").trim().toLowerCase();
      renderCaseList();
      updateBatchButton();
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
      const wasAuditOnly = state.intakeKind === "audit_record";
      state.intakeKind = String(event.target.value ?? "");
      if (wasAuditOnly !== (state.intakeKind === "audit_record")) void loadIntakePage({ append: false });
      else renderIntakeRecords();
    });
    elements.intakeRecords?.addEventListener("change", handleIntakeRecordSelection);
    elements.intakeLoadMore?.addEventListener("click", () => loadIntakePage({ append: true }));
    elements.intakeClear?.addEventListener("click", clearIntakeSelection);
    elements.intakeTradeReview?.addEventListener("click", handleIntakePrimaryAction);
    elements.intakeCancelLinkEdit?.addEventListener("click", cancelCaseLinkEdit);
    elements.eventCandidates?.addEventListener("change", handleEventSelection);
    elements.createFromRecords?.addEventListener("click", createEarningsCycleFromRecords);
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
    elements.caseForm?.addEventListener("submit", legacyCaseReadOnly);
    elements.analyzeCase?.addEventListener("click", prepareCaseAnalysis);
    elements.previewCaseMigration?.addEventListener("click", previewSelectedCaseMigration);
    elements.confirmCaseMigration?.addEventListener("click", confirmSelectedCaseMigration);
    elements.cancelCaseMigration?.addEventListener("click", clearCaseMigrationPreview);

    elements.learningAccept?.addEventListener("click", acceptLearningProposal);
    elements.learningDismiss?.addEventListener("click", dismissLearningProposal);
    elements.testList?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-complete-test-id]");
      if (button) return completeTest(button.dataset.completeTestId, button);
      const evaluate = event.target.closest("[data-evaluate-protocol-id]");
      if (evaluate) return evaluateProtocol(evaluate);
      const archive = event.target.closest("[data-archive-validation]");
      if (archive) return archiveValidation(archive);
      const decision = event.target.closest("[data-validation-decision]");
      if (decision) return handleValidationDecision(decision);
      const version = event.target.closest("[data-create-validation-v2]");
      if (version) return createValidationV2(version);
    });
    elements.testList?.addEventListener("input", rememberValidationDrafts);
    elements.testList?.addEventListener("change", rememberValidationDrafts);
  }

  function routeFromHash() {
    const match = String(window.location.hash ?? "").match(/^#\/review(?:\/(research|cycles|cases|tests|rules|governance))?$/);
    if (match) return { mode: "review", tab: ["rules", "governance"].includes(match[1]) ? "tests" : match[1] ?? "cycles" };
    return { mode: "cockpit", tab: state.activeTab };
  }

  function applyRoute({ initial = false } = {}) {
    const route = routeFromHash();
    if (/^#\/review\/(rules|governance)$/.test(window.location.hash)) replaceHash("#/review/tests");
    if (route.mode === "review") state.activeTab = route.tab;
    void setWorkspace(route.mode, { updateHash: !initial, fromRoute: true });
  }

  async function setWorkspace(mode, { updateHash = true, fromRoute = false } = {}) {
    const nextMode = WORKSPACE_MODES.has(mode) ? mode : "cockpit";
    const workspaceRequestToken = ++state.workspaceRequestToken;
    try {
      if (typeof api?.workspace?.setMode !== "function") {
        throw new Error("复盘工作区桥接尚未就绪。");
      }
      await api.workspace.setMode(nextMode);
      if (workspaceRequestToken !== state.workspaceRequestToken) return;
    } catch (error) {
      if (nextMode === "review" && workspaceRequestToken === state.workspaceRequestToken) {
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
      if (state.activeTab !== "research") await loadSnapshot();
    } else if (updateHash) {
      replaceHash("#/cockpit");
    }
  }

  function setReviewTab(value, { updateHash = true } = {}) {
    const next = ["rules", "governance"].includes(value) ? "tests" : REVIEW_TABS.has(value) ? value : "cycles";
    const previous = state.activeTab;
    state.activeTab = next;
    renderTabs();
    if (updateHash && state.mode === "review") replaceHash(`#\/review/${next}`);
    if (previous === "research" && next !== "research" && state.mode === "review") void loadSnapshot({ preservePane: true });
  }

  function renderTabs() {
    elements.workspace.dataset.activeTab = state.activeTab;
    elements.tabs.forEach((button) => {
      const active = button.dataset.reviewTab === state.activeTab;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    elements.panels.forEach((panel) => {
      panel.hidden = panel.id !== `review-panel-${state.activeTab}`;
    });
    window.dispatchEvent(new CustomEvent("cockpit:review-tab-changed", { detail: { tab: state.activeTab, mode: state.mode } }));
  }

  function replaceHash(hash) {
    if (window.location.hash === hash) return;
    window.history.replaceState(null, "", hash);
  }

  async function loadSnapshot({ preservePane = false } = {}) {
    const requestToken = ++state.snapshotRequestToken;
    state.snapshotLoading = true;
    elements.workspace.setAttribute("aria-busy", "true");
    try {
      // One atomic full view, including the selected intake page. Pagination
      // uses the separate intake endpoint and never rebuilds this summary.
      const result = await callReview("snapshot", {
        offset: 0,
        limit: INTAKE_PAGE_LIMIT,
        query: state.intakeSearch,
        includeExcludedOrders: state.intakeKind === "audit_record",
      });
      if (requestToken !== state.snapshotRequestToken) return;
      const source = result?.snapshot ?? result?.data ?? result ?? {};
      adoptReviewAccountScope(source.accountScopeId ?? null);
      rememberValidationDrafts();
      const priorLedger = state.snapshot.portfolioSnapshots;
      const incomingSequence = reviewSnapshotSequence(source.snapshotUpdateSequence);
      state.snapshot = normalizeSnapshot(result);
      if (incomingSequence != null && incomingSequence < state.snapshotUpdateSequence) {
        // A newer lightweight ledger event may arrive while the full summary
        // is being read. Keep that ledger without discarding the other data.
        state.snapshot.portfolioSnapshots = priorLedger;
      } else if (incomingSequence != null) {
        state.snapshotUpdateSequence = incomingSequence;
      }
      state.snapshotLoaded = true;
      state.snapshotReadError = null;
      state.snapshotLoadedAt = new Date().toISOString();
      publishReviewEvidenceRevisions();
      const cycleExists = state.snapshot.cycles.some((item) => cycleId(item) === state.selectedCycleId);
      if (!cycleExists) state.selectedCycleId = null;
      const caseExists = state.snapshot.cases.some((item) => caseId(item) === state.selectedCaseId);
      if (!caseExists) state.selectedCaseId = null;
      if (!preservePane && !state.selectedCaseId) {
        state.casePane = "intake";
      }
      pruneIntakeSelection();
      renderAll();
      clearNotice();
    } catch (error) {
      if (requestToken !== state.snapshotRequestToken) return;
      state.snapshotReadError = error.message || "复盘记录读取失败。";
      if (!state.snapshotLoaded) state.snapshot = emptySnapshot();
      renderAll();
      showNotice(
        state.snapshotLoaded
          ? `复盘记录刷新失败；仍显示 ${formatDateTime(state.snapshotLoadedAt)} 的上次成功结果，不会伪装为空。${state.snapshotReadError}`
          : state.snapshotReadError,
        "error",
      );
    } finally {
      if (requestToken === state.snapshotRequestToken) {
        state.snapshotLoading = false;
        elements.workspace.setAttribute("aria-busy", String(state.loading));
      }
    }
  }

  function reviewSnapshotSequence(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function adoptReviewAccountScope(value) {
    const scope = typeof value === "string" && value.trim() ? value.trim() : null;
    if (scope === state.accountScopeId) return false;
    state.accountScopeId = scope;
    state.validationDrafts.clear();
    state.caseDrafts.clear();
    state.cycleDrafts.clear();
    state.cycleTradePathResults?.clear();
    state.selectedRecordIds.clear();
    state.selectedRecordCache.clear();
    state.selectedBatchCaseIds.clear();
    state.selectedCaseId = null;
    state.selectedCycleId = null;
    state.intakePageLoading = false;
    state.snapshotLoading = false;
    state.eventLookupToken += 1;
    state.recentEventRequestToken += 1;
    state.recentEventRequests?.clear();
    if (state.eventLookupTimer) clearTimeout(state.eventLookupTimer);
    if (state.intakeSearchTimer) clearTimeout(state.intakeSearchTimer);
    state.eventLookupTimer = null;
    state.intakeSearchTimer = null;
    state.eventLookupLoading = false;
    state.recentEventLoading = false;
    state.recentEventRequestKey = "";
    state.prefetchedEventSymbol = null;
    state.selectedEventId = null;
    state.suggestedEventId = null;
    state.eventLookupMessage = "";
    state.editingCaseLinkId = null;
    state.editingCycleLinkId = null;
    state.pendingLearningProposal = null;
    state.pendingOrderFirstCycle = null;
    state.caseMigrationPreview = null;
    state.caseMigrationRequestToken = (state.caseMigrationRequestToken ?? 0) + 1;
    if (elements.caseMigration) elements.caseMigration.hidden = true;
    state.casePane = "intake";
    state.cyclePane = "welcome";
    state.snapshot = emptySnapshot();
    state.snapshotLoaded = false;
    // No financial draft is written to localStorage. Clearing the old DOM
    // also prevents capture of account A's inputs under account B's key.
    elements.testList.replaceChildren();
    elements.testForm?.reset();
    elements.cycleForm?.reset();
    elements.workspace?.setAttribute("aria-busy", String(state.loading));
    if (elements.orderFirstNoteDialog?.open) elements.orderFirstNoteDialog.close();
    return true;
  }

  function handleReviewSnapshotUpdate(payload) {
    const sequence = reviewSnapshotSequence(payload?.snapshotUpdateSequence);
    if (sequence == null || sequence <= state.snapshotUpdateSequence
      || !Object.prototype.hasOwnProperty.call(payload ?? {}, "accountScopeId")
      || !payload?.portfolioSnapshots || typeof payload.portfolioSnapshots !== "object") return;
    const changedScope = adoptReviewAccountScope(payload.accountScopeId);
    state.snapshotUpdateSequence = sequence;
    state.snapshot.portfolioSnapshots = payload.portfolioSnapshots;
    if (changedScope) {
      // Invalidate reads and pages issued under the previous account first.
      state.snapshotRequestToken += 1;
      state.intakePageToken += 1;
      renderAll();
      if (state.mode === "review" && state.activeTab !== "research") void loadSnapshot({ preservePane: true });
    } else {
      // A capture is metadata about historical evidence, not a live quote.
      // Refresh only its summary/calendar; do not rebuild editable forms.
      renderSummary();
    }
  }

  function applyActionReviewSnapshot(result) {
    const source = result?.snapshot ?? result?.data ?? result ?? {};
    const incomingSequence = reviewSnapshotSequence(source.snapshotUpdateSequence);
    if (incomingSequence != null && incomingSequence < state.snapshotUpdateSequence
      && source.accountScopeId !== state.accountScopeId) return;
    adoptReviewAccountScope(source.accountScopeId ?? null);
    rememberValidationDrafts();
    const priorLedger = state.snapshot.portfolioSnapshots;
    state.snapshot = normalizeSnapshot(result);
    if (incomingSequence != null && incomingSequence < state.snapshotUpdateSequence) state.snapshot.portfolioSnapshots = priorLedger;
    else if (incomingSequence != null) state.snapshotUpdateSequence = incomingSequence;
    renderAll();
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
      cycles: arrayValue(source.cycles, source.reviewCycles, source.decisionCycles),
      cases: arrayValue(source.cases, source.reviewCases),
      brokerMatches: source.brokerMatches && typeof source.brokerMatches === "object"
        ? source.brokerMatches
        : {},
      tests: arrayValue(source.tests, source.experiments),
      rules: arrayValue(source.rules),
      reviews: arrayValue(source.reviews, source.ruleReviews),
      ruleMetrics: source.ruleMetrics && typeof source.ruleMetrics === "object" ? source.ruleMetrics : {},
      validationPackages: arrayValue(source.validationPackages),
      validationCandidates: source.validationCandidates && typeof source.validationCandidates === "object"
        ? source.validationCandidates
        : {},
      validationCandidateExclusions: source.validationCandidateExclusions && typeof source.validationCandidateExclusions === "object"
        ? source.validationCandidateExclusions
        : {},
      portfolioSnapshots: source.portfolioSnapshots && typeof source.portfolioSnapshots === "object"
        ? source.portfolioSnapshots
        : { status: "empty", snapshotCount: 0, latest: null, warnings: [] },
      summary: source.summary && typeof source.summary === "object" ? source.summary : {},
      intake: normalizeIntake(intakeSource, source),
    };
  }

  function emptySnapshot() {
    return {
      cycles: [], cases: [], brokerMatches: {}, tests: [], rules: [], reviews: [], ruleMetrics: {}, validationPackages: [], validationCandidates: {}, validationCandidateExclusions: {}, summary: {},
      portfolioSnapshots: { status: "empty", snapshotCount: 0, latest: null, warnings: [] },
      intake: normalizeIntake(),
    };
  }

  function publishReviewEvidenceRevisions() {
    window.dispatchEvent(new CustomEvent("cockpit:review-evidence-revisions", {
      detail: {
        cases: state.snapshot.cases.map((item) => ({
          caseId: caseId(item),
          revision: Number(item?.brokerLinks?.revision ?? item?.brokerLinkVersions?.at?.(-1)?.revision ?? 0),
        })).filter((item) => item.caseId && Number.isInteger(item.revision) && item.revision > 0),
        cycles: state.snapshot.cycles.map((item) => ({
          cycleId: cycleId(item),
          retrospectiveVersion: Number(cycleRetrospectiveVersion(item)?.version ?? 0),
          evidenceRevision: Number(item?.evidenceRevision ?? item?.brokerLinks?.evidenceRevision ?? item?.brokerLinks?.revision ?? 0),
        })).filter((item) => item.cycleId),
      },
    }));
  }

  function renderAll() {
    pruneBatchCaseSelection();
    renderSummary();
    renderCycles();
    renderQuarterFilter();
    renderCaseList();
    renderSelectedCase();
    renderIntake();
    renderTests();
    renderLearningProposal();
    renderRules();
    renderGovernance();
    renderTestLinks();
  }

  function renderSummary() {
    const activeTests = state.snapshot.tests.filter((item) => String(item?.status ?? "").toLowerCase() !== "retired");
    const testsRunning = activeTests.filter((item) => !testComplete(item)).length;
    const activeRules = state.snapshot.rules.filter((item) => ruleStatus(item) !== "RETIRED").length;
    const legacyDueReviews = numberOr(
      state.snapshot.summary.reviewDueCount,
      state.snapshot.summary.dueReviews,
      state.snapshot.rules.filter((item) => item.reviewDue === true || item.reviewStatus === "due").length,
    );
    const dueReviews = legacyDueReviews + state.snapshot.tests.filter((item) => (
      String(item?.status ?? "").toLowerCase() === "decision_due"
    )).length;
    const values = [state.snapshot.cycles.length, state.snapshot.cases.length, testsRunning, activeRules, dueReviews];
    [...elements.summary.querySelectorAll("strong")].forEach((node, index) => {
      node.textContent = String(values[index] ?? 0);
    });
    elements.cycleCount.textContent = String(state.snapshot.cycles.length);
    elements.caseCount.textContent = String(state.snapshot.cases.length);
    elements.testCount.textContent = String(activeTests.length);
    elements.testCount.title = `${state.snapshot.tests.length - activeTests.length} 个已停止观察保留在审计档案`;
    elements.ruleCount.textContent = String(state.snapshot.rules.length);
    const snapshots = state.snapshot.portfolioSnapshots;
    const background = snapshots?.backgroundCapture ?? {};
    const backgroundEnabled = background?.preferences?.enabled === true;
    if (elements.backgroundCapture) {
      elements.backgroundCapture.textContent = backgroundEnabled
        ? "无人值守：已开启"
        : "无人值守：关闭";
      elements.backgroundCapture.setAttribute("aria-pressed", String(backgroundEnabled));
      elements.backgroundCapture.classList.toggle("active", backgroundEnabled);
      elements.backgroundCapture.title = backgroundEnabled
        ? "关闭后，最后一个窗口关闭时应用会退出，也不会在登录后隐藏启动。已捕获的历史不会删除。"
        : "开启后，关闭窗口仍保留后台采集；登录 macOS 后隐藏启动，并在漏过收盘捕获窗口时通知。";
    }
    if (elements.snapshotLedgerStatus) {
      const capturePolicy = snapshots?.capturePolicy ?? {};
      const captureRuntime = snapshots?.captureRuntime ?? {};
      const automaticLabel = capturePolicy.automaticEod === false
        ? "需手动"
        : snapshotCaptureRuntimeLabel(captureRuntime);
      const valuationLabel = snapshotValuationLabel(snapshots?.latest);
      const coverage = snapshots?.coverageSummary ?? null;
      const coverageGapCount = coverage
        ? Number(coverage?.counts?.missing ?? 0) + Number(coverage?.counts?.gap ?? 0)
        : 0;
      const coverageLabel = coverage?.expectedTradingDays
        ? `正式覆盖 ${formatNumber(coverage.counts?.confirmed, 0)}/${formatNumber(coverage.expectedTradingDays, 0)}${coverageGapCount ? ` · 缺口 ${formatNumber(coverageGapCount, 0)}` : ""}`
        : "正式覆盖待建立";
      elements.snapshotLedgerStatus.textContent = snapshots?.latest
        ? `组合历史 ${formatNumber(snapshots.snapshotCount, 0)} 个 · ${coverageLabel} · 最近 ${formatDateTime(snapshots.latest.capturedAt)} · ${valuationLabel} · ${automaticLabel}${snapshots.accountScopeVerified === false ? " · 本地账户范围" : ""}`
        : snapshots?.status === "invalid"
          ? "组合历史完整性校验失败"
          : `组合历史尚未开始 · ${automaticLabel}`;
      const captureNote = capturePolicy.automaticEod === false
        ? "当前仅在你点击“保存组合快照”时记录。"
        : `应用运行且长桥已连接时，每 15 分钟检查一次；每个美股交易日最多保存一个 v2 常规收盘重估。证券按该交易日常规交易时段的收盘 mark 重估，提前收盘日遵循实际收盘时间；持仓数量和现金来自收盘后抓取，所以该记录是 partial，不能作为确定性收益端点。确认成功后停止当日重估检查；被动盘后价格变化不会自动保存，也不会覆盖它，只有手动或成交后观察会另存。${backgroundEnabled ? "无人值守已开启：关闭窗口后继续运行，并在系统登录后隐藏启动。" : "无人值守未开启：关闭最后一个窗口后应用退出。"}关闭应用期间不会运行；设备关机期间同样不会补造错过日期的历史快照。`;
      elements.snapshotLedgerStatus.title = [
        captureNote,
        captureRuntime.lastAttemptAt ? `最后尝试：${formatDateTime(captureRuntime.lastAttemptAt)}` : null,
        captureRuntime.lastSuccessAt
          ? `最后成功：${formatDateTime(captureRuntime.lastSuccessAt)}${captureRuntime.lastSuccessTradingDate ? ` · 交易日 ${captureRuntime.lastSuccessTradingDate}` : ""}`
          : null,
        captureRuntime.lastError ? `最近错误：${captureRuntime.lastError}` : null,
        coverage?.expectedTradingDays
          ? `连续性：确认 ${formatNumber(coverage.counts?.confirmed, 0)} · 降级 ${formatNumber(coverage.counts?.degraded, 0)} · 尝试中 ${formatNumber(coverage.counts?.attempting, 0)} · 明确缺口 ${formatNumber(coverage.counts?.gap, 0)} · 未捕获 ${formatNumber(coverage.counts?.missing, 0)}`
          : null,
        ...arrayValue(snapshots?.warnings).map(snapshotWarningText),
      ].filter(Boolean).join("\n");
    }
    renderSnapshotCoverageCalendar(snapshots);
    elements.dueCount.textContent = String(dueReviews);
    elements.listCaseCount.textContent = String(state.snapshot.cases.length);
    elements.intakeCount.textContent = String(state.snapshot.intake.totalRecordCount);
    updateBatchButton();
  }

  function renderSnapshotCoverageCalendar(snapshots) {
    if (!elements.snapshotCoverageDays || !elements.snapshotCoverageSummary) return;
    const calendar = arrayValue(snapshots?.coverageCalendar);
    const summary = snapshots?.coverageSummary ?? null;
    const counts = summary?.counts ?? {};
    elements.snapshotCoverageSummary.textContent = summary?.expectedTradingDays
      ? `最近 ${formatNumber(summary.expectedTradingDays, 0)} 个受监控交易日 · 已确认 ${formatNumber(counts.confirmed, 0)} · 缺口 ${formatNumber(Number(counts.gap ?? 0) + Number(counts.missing ?? 0), 0)}`
      : "尚无受监控交易日";
    elements.snapshotCoverageDays.replaceChildren();
    if (!calendar.length) {
      elements.snapshotCoverageDays.append(node("span", "review-snapshot-coverage-empty", "连接长桥并开启无人值守后，这里会显示真实捕获状态。"));
      return;
    }
    for (const entry of calendar) {
      const status = snapshotCoverageStatus(entry?.status);
      const day = node("article", `review-snapshot-day ${status}`);
      const date = String(entry?.tradingDate ?? "N/A");
      const time = node("time", "", date);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) time.dateTime = date;
      day.dataset.status = status;
      day.title = snapshotCoverageDayTitle(entry);
      day.append(
        time,
        node("strong", "", snapshotCoverageStatusLabel(status)),
      );
      elements.snapshotCoverageDays.append(day);
    }
  }

  function snapshotCoverageStatus(value) {
    const status = String(value ?? "missing").toLowerCase();
    return ["confirmed", "degraded", "attempting", "gap", "missing"].includes(status)
      ? status
      : "missing";
  }

  function snapshotCoverageStatusLabel(value) {
    return {
      confirmed: "已确认",
      degraded: "降级",
      attempting: "尝试中",
      gap: "明确缺口",
      missing: "未捕获",
    }[value] ?? "未捕获";
  }

  function snapshotCoverageDayTitle(entry) {
    return [
      entry?.tradingDate ? `交易日：${entry.tradingDate}` : null,
      `状态：${snapshotCoverageStatusLabel(snapshotCoverageStatus(entry?.status))}`,
      entry?.lastAttemptAt ? `最后尝试：${formatDateTime(entry.lastAttemptAt)}` : null,
      entry?.confirmedAt ? `确认时间：${formatDateTime(entry.confirmedAt)}` : null,
      entry?.failureReason ?? entry?.lastFailureReason ?? null,
    ].filter(Boolean).join("\n");
  }

  function snapshotValuationLabel(snapshot) {
    const session = String(snapshot?.valuationSession ?? "unknown");
    if (session === "regular_close") return "常规收盘重估（部分）";
    if (session === "post_market") return "盘后观察";
    if (session === "pre_market") return "盘前观察";
    if (session === "overnight") return "夜盘观察";
    if (session === "regular") return "常规时段观察";
    if (session === "mixed") return "混合时段观察";
    return "估值时段待核验";
  }

  function snapshotCaptureRuntimeLabel(runtime) {
    const status = String(runtime?.status ?? "waiting");
    if (status === "disconnected") return "自动捕获未连接";
    if (status === "confirmed_today") return runtime?.connected === false
      ? "今日重估已确认 · 当前未连接"
      : "今日重估已确认";
    if (status === "retrying") return "收盘重估等待重试";
    return "等待下一次收盘重估";
  }

  function renderCycles() {
    const cycles = [...state.snapshot.cycles]
      .sort((left, right) => timestamp(cycleUpdatedAt(right)) - timestamp(cycleUpdatedAt(left)));
    elements.cycleList.replaceChildren();
    if (!cycles.length) {
      elements.cycleList.append(emptyNode("还没有复盘周期。\n从事件、持仓或月度组合建立第一条。", true));
    } else {
      for (const item of cycles) {
        const id = cycleId(item);
        const counts = cycleEvidenceCounts(item);
        const blindDone = cyclePhaseComplete(item, "blind");
        const outcomeDone = cyclePhaseComplete(item, "outcome");
        const retrospectiveDone = cyclePhaseComplete(item, "retrospective");
        const progress = cycleReviewMode(item) === "lightweight"
          ? retrospectiveDone ? "直接事后复盘已完成" : "可直接事后复盘"
          : outcomeDone ? "两阶段完成" : blindDone ? "待结果复盘" : "待盲态复盘";
        const displayStatus = cycleDisplayStatus(item);
        const button = node("button", `review-cycle-list-item${id === state.selectedCycleId ? " active" : ""}`);
        button.type = "button";
        button.dataset.reviewCycleId = id;
        button.append(
          node("strong", "", cycleTitle(item)),
          node("small", "", displayStatus),
          node("p", "", `${cycleTypeLabel(cycleType(item))} · ${cycleScopeLabel(item)} · ${cycleRangeLabel(item)}`),
          node("p", "review-cycle-list-progress", `${counts.orders} 订单 · ${counts.executions} 成交 · ${counts.checkpoints} 检查点 · ${progress}`),
        );
        elements.cycleList.append(button);
      }
    }
    renderOrderFirstEntry();
    renderSelectedCycle();
  }

  function renderOrderFirstEntry() {
    if (elements.quickMonth && !elements.quickMonth.value) {
      const now = new Date();
      const firstThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const previous = new Date(firstThisMonth.getFullYear(), firstThisMonth.getMonth() - 1, 1);
      elements.quickMonth.value = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, "0")}`;
    }
    const count = state.selectedRecordIds.size;
    const symbols = selectedIntakeSymbols();
    const editingCase = state.editingCaseLinkId
      ? state.snapshot.cases.find((item) => caseId(item) === state.editingCaseLinkId)
      : null;
    const editingCycle = state.editingCycleLinkId
      ? state.snapshot.cycles.find((item) => cycleId(item) === state.editingCycleLinkId)
      : null;
    const editingSymbol = editingCase
      ? caseSymbol(editingCase)
      : editingCycle && cycleType(editingCycle) !== "monthly_portfolio"
        ? cycleSymbols(editingCycle)[0]
        : null;
    const selectionMatchesEditingScope = !editingSymbol
      || (symbols.length === 1 && symbols[0] === editingSymbol);
    if (elements.quickSingleSelection) {
      elements.quickSingleSelection.textContent = count
        ? `已选 ${count} 条 · ${symbols.join(" + ") || "正在解析标的"}`
        : "尚未选择订单";
    }
    if (elements.quickSingleCreate) {
      elements.quickSingleCreate.disabled = Boolean(editingCase || editingCycle) || state.loading || !count || symbols.length !== 1;
      elements.quickSingleCreate.title = symbols.length > 1 ? "单标的复盘不能混选多个标的" : "";
    }
    if (elements.intakeTradeReview) {
      elements.intakeTradeReview.disabled = state.loading || !count
        || (!editingCycle && symbols.length !== 1)
        || !selectionMatchesEditingScope;
      elements.intakeTradeReview.textContent = editingCase || editingCycle
        ? `保存关联修改${count ? ` · ${count}` : ""}`
        : "复盘所选交易";
      elements.intakeTradeReview.title = !selectionMatchesEditingScope
        ? `只能选择 ${editingSymbol} 的订单与成交`
        : symbols.length > 1 && !editingCycle ? "请只选择同一标的的订单与成交" : "";
    }
    const eventCard = elements.createFromRecords?.closest(".review-event-card");
    if (eventCard) eventCard.hidden = Boolean(editingCase || editingCycle);
  }

  async function createQuickMonthly(event, reviewMode) {
    event?.preventDefault?.();
    if (state.loading) return;
    const month = String(elements.quickMonth?.value ?? "");
    const range = monthDateRange(month);
    if (!range) return;
    if (reviewMode === "lightweight" && Date.parse(range.endAt) > Date.now()) {
      showNotice("本月尚未结束，不能直接做事后复盘；可以先建立严谨预判。", "warning");
      return;
    }
    const request = {
      flow: "monthly",
      month,
      benchmark: normalizeSymbol(elements.quickMonthBenchmark?.value) || "QQQ.US",
      reviewMode,
      timezone: "America/New_York",
    };
    if (reviewMode === "lightweight") {
      openOrderFirstNoteDialog(request, `${month} 整月组合 · 自动关联有效成交；未成交与不可核验记录只作审计`);
      return;
    }
    await runAction("正在建立月度预判…", async () => {
      const result = await callReview("createOrderFirstCycle", request);
      await openCreatedOrderFirstCycle(result);
      showNotice("月度严谨周期已建立并自动关联订单。可补充预判后封存，或保留为空白草稿。", "success");
    });
  }

  async function createQuickSingle(event) {
    event?.preventDefault?.();
    if (state.loading || !state.selectedRecordIds.size) return;
    const symbols = selectedIntakeSymbols();
    openOrderFirstNoteDialog({
      flow: "single_symbol",
      recordIds: [...state.selectedRecordIds],
      reviewMode: "lightweight",
      timezone: "Asia/Shanghai",
    }, `${symbols[0] || "单标的"} · 已选择 ${state.selectedRecordIds.size} 条，保存后自动补齐父订单与同单成交`);
  }

  function openOrderFirstNoteDialog(request, scopeLabel) {
    if (!request || state.loading || !elements.orderFirstNoteDialog) return;
    state.pendingOrderFirstCycle = structuredClone(request);
    elements.orderFirstNoteForm.reset();
    elements.orderFirstNoteSubmit.disabled = false;
    elements.orderFirstNoteScope.textContent = scopeLabel;
    if (typeof elements.orderFirstNoteDialog.showModal === "function") {
      elements.orderFirstNoteDialog.showModal();
    } else {
      elements.orderFirstNoteDialog.setAttribute("open", "");
    }
    elements.orderFirstRecalledJudgment.focus();
  }

  function closeOrderFirstNoteDialog() {
    state.pendingOrderFirstCycle = null;
    if (elements.orderFirstNoteDialog?.open && typeof elements.orderFirstNoteDialog.close === "function") {
      elements.orderFirstNoteDialog.close();
    } else {
      elements.orderFirstNoteDialog?.removeAttribute("open");
    }
  }

  async function confirmOrderFirstCycle(event) {
    event.preventDefault();
    const request = state.pendingOrderFirstCycle;
    if (!request || state.loading) return;
    const retrospectiveNote = {
      recalledJudgment: elements.orderFirstRecalledJudgment.value.trim(),
      lesson: elements.orderFirstLesson.value.trim(),
      forwardHypothesis: elements.orderFirstForwardHypothesis.value.trim(),
    };
    if (Object.values(retrospectiveNote).some((value) => !value)) {
      elements.orderFirstNoteForm.reportValidity();
      return;
    }
    let completed = false;
    elements.orderFirstNoteSubmit.disabled = true;
    await runAction("正在保存记录并关联真实订单…", async () => {
      const result = await callReview("createOrderFirstCycle", { ...request, retrospectiveNote });
      await openCreatedOrderFirstCycle(result);
      completed = true;
      closeOrderFirstNoteDialog();
      showNotice("三段原话、复盘周期与真实订单已原子保存。现在可以直接运行 AI 复盘。", "success");
    });
    if (!completed) elements.orderFirstNoteSubmit.disabled = false;
  }

  async function openCreatedOrderFirstCycle(result) {
    const createdId = cycleIdFromResult(result);
    if (!createdId) throw new Error("未取得周期 ID；原选择保留，请刷新后查看。");
    if (result?.snapshot) applyActionReviewSnapshot(result.snapshot);
    else await loadSnapshot({ preservePane: true });
    if (!state.snapshot.cycles.some((item) => cycleId(item) === createdId)) {
      throw new Error("周期已保存，但当前视图尚未取得对应记录；原选择保留，请刷新后打开。");
    }
    state.selectedCycleId = createdId;
    state.cyclePane = "detail";
    setReviewTab("cycles");
    renderCycles();
  }

  function showCycleCreate(type = "catalyst") {
    state.cyclePane = "create";
    state.selectedCycleId = null;
    setReviewTab("cycles");
    elements.cycleForm.reset();
    elements.cycleBenchmark.value = "QQQ.US";
    elements.cycleType.value = CYCLE_TYPES.has(type) ? type : "catalyst";
    updateCycleTypeFields();
    renderSelectedCycle();
    elements.cycleTitle.focus();
  }

  function showCycleWelcome() {
    state.cyclePane = "welcome";
    state.selectedCycleId = null;
    setReviewTab("cycles");
    renderCycles();
  }

  function selectCycle(id) {
    if (!id) return;
    state.selectedCycleId = String(id);
    state.cyclePane = "detail";
    setReviewTab("cycles");
    renderCycles();
  }

  function selectedCycle() {
    return state.snapshot.cycles.find((item) => cycleId(item) === state.selectedCycleId) ?? null;
  }

  function rememberSelectedCycleDraft() {
    const item = selectedCycle();
    if (!item || state.cyclePane !== "detail") return;
    const id = cycleId(item);
    const existing = state.cycleDrafts.get(id) ?? {};
    state.cycleDrafts.set(id, {
      ...existing,
      exAnte: cycleExAnteFromDetail(),
      retrospectiveNote: retrospectiveNoteFromDetail(),
    });
  }

  function clearCycleDraftSection(id, key) {
    const existing = state.cycleDrafts.get(id);
    if (!existing) return;
    const next = { ...existing };
    delete next[key];
    if (Object.keys(next).length) state.cycleDrafts.set(id, next);
    else state.cycleDrafts.delete(id);
  }

  function updateCycleTypeFields() {
    const type = CYCLE_TYPES.has(elements.cycleType.value) ? elements.cycleType.value : "catalyst";
    elements.cycleForm.querySelectorAll("[data-cycle-types]").forEach((field) => {
      const visible = String(field.dataset.cycleTypes ?? "").split(",").includes(type);
      field.hidden = !visible;
      field.querySelectorAll("input, select, textarea").forEach((input) => {
        input.disabled = !visible;
      });
    });
    elements.cycleSymbol.required = ["catalyst", "position_lifecycle", "trade_window"].includes(type);
    elements.cycleEventAt.required = type === "catalyst";
    elements.cycleStartAt.required = ["catalyst", "position_lifecycle", "trade_window"].includes(type);
    elements.cycleEndAt.required = ["catalyst", "trade_window"].includes(type);
    elements.cycleMonth.required = type === "monthly_portfolio";
  }

  async function createCycle(event) {
    event.preventDefault();
    if (state.loading) return;
    const draft = cycleDraftFromCreateForm();
    if (!draft.title || !CYCLE_TYPES.has(draft.type)) return;
    await runAction("正在建立复盘周期…", async () => {
      const result = await callReview("createCycle", draft);
      const createdId = cycleIdFromResult(result);
      await loadSnapshot({ preservePane: true });
      const resolvedId = createdId || cycleId(state.snapshot.cycles[0]);
      if (!resolvedId) throw new Error("建立周期后未取得周期 ID。");
      state.selectedCycleId = resolvedId;
      state.cyclePane = "detail";
      renderCycles();
      showNotice("复盘周期已建立。请确认事前四字段、关联真实记录，再主动封存。", "success");
    });
  }

  function cycleDraftFromCreateForm() {
    const type = CYCLE_TYPES.has(elements.cycleType.value) ? elements.cycleType.value : "catalyst";
    const monthRange = type === "monthly_portfolio" ? monthDateRange(elements.cycleMonth.value) : null;
    const symbol = type === "monthly_portfolio" ? "" : normalizeSymbol(elements.cycleSymbol.value);
    const eventAtValue = inputDateTimeToIso(elements.cycleEventAt.value);
    const startAt = type === "monthly_portfolio"
      ? monthRange?.startAt ?? null
      : inputDateTimeToIso(elements.cycleStartAt.value);
    const endAt = type === "monthly_portfolio"
      ? monthRange?.endAt ?? null
      : inputDateTimeToIso(elements.cycleEndAt.value);
    const exAnte = {
      myView: elements.cycleThesis.value.trim(),
      marketView: elements.cycleMarketBelief.value.trim(),
      plannedAction: elements.cycleAction.value.trim(),
      invalidation: elements.cycleInvalidation.value.trim(),
      fundamentalView: elements.cycleFundamental.value.trim(),
      technicalView: elements.cycleTechnical.value.trim(),
    };
    return {
      type,
      reviewMode: "rigorous",
      title: elements.cycleTitle.value.trim(),
      symbol: symbol || null,
      symbols: symbol ? [symbol] : [],
      scope: type === "monthly_portfolio" ? "portfolio" : "single_symbol",
      eventKind: type === "catalyst" ? elements.cycleEventKind.value : null,
      eventAt: type === "catalyst" ? eventAtValue : null,
      catalystAt: type === "catalyst" ? eventAtValue : null,
      event: type === "catalyst" ? { kind: elements.cycleEventKind.value, scheduledAt: eventAtValue } : null,
      month: type === "monthly_portfolio" ? elements.cycleMonth.value : null,
      timezone: type === "monthly_portfolio" ? "America/New_York" : "Asia/Shanghai",
      benchmark: type === "monthly_portfolio" ? normalizeSymbol(elements.cycleBenchmark.value) : null,
      startAt,
      endAt,
      startCondition: type === "position_lifecycle" ? elements.cycleStartCondition.value.trim() : "",
      endCondition: type === "position_lifecycle" ? elements.cycleEndCondition.value.trim() : "",
      exAnte,
    };
  }

  function renderSelectedCycle() {
    const item = selectedCycle();
    const showCreate = state.cyclePane === "create";
    const showDetail = state.cyclePane === "detail" && Boolean(item);
    elements.cycleWelcome.hidden = showCreate || showDetail;
    elements.cycleForm.hidden = !showCreate;
    elements.cycleDetail.hidden = !showDetail;
    if (showCreate) {
      updateCycleTypeFields();
      return;
    }
    if (!showDetail) return;

    const sealed = cycleSealed(item);
    if (sealed) clearCycleDraftSection(cycleId(item), "exAnte");
    const rememberedDraft = state.cycleDrafts.get(cycleId(item)) ?? {};
    const exAnte = rememberedDraft.exAnte ?? cycleExAnte(item);
    const sealedAt = cycleSealedAt(item);
    const counts = cycleEvidenceCounts(item);
    const lightweight = cycleReviewMode(item) === "lightweight";
    const retrospectiveNote = rememberedDraft.retrospectiveNote ?? cycleRetrospectiveNote(item);
    const retrospectiveVersion = cycleRetrospectiveVersion(item);
    const blindDone = cyclePhaseComplete(item, "blind");
    const outcomeDone = cyclePhaseComplete(item, "outcome");
    const outcomeReady = cycleOutcomeReady(item);
    elements.cycleDetailType.textContent = cycleTypeLabel(cycleType(item)).toUpperCase();
    elements.cycleDetailTitle.textContent = cycleTitle(item);
    elements.cycleDetailRange.textContent = `${cycleRangeLabel(item)} · ${cycleScopeLabel(item)}`;
    const displayStatus = cycleDisplayStatus(item);
    elements.cycleDetailStatus.textContent = displayStatus;
    elements.cycleDetailStatus.className = `review-state-badge ${statusClass(displayStatus)}`;
    const metricValues = [
      String(counts.orders),
      String(counts.executions),
      String(counts.checkpoints),
      lightweight ? "不适用" : blindDone ? "已完成" : sealed ? "可开始" : "待封存",
      lightweight ? (cyclePhaseComplete(item, "retrospective") ? "已复盘" : "可开始") : outcomeDone ? "已完成" : blindDone && outcomeReady ? "可开始" : "锁定",
    ];
    [...elements.cycleMetrics.querySelectorAll("strong")].forEach((target, index) => {
      target.textContent = metricValues[index] ?? "—";
    });
    const snapshotCoverage = item?.portfolioSnapshotCoverage;
    if (elements.cyclePortfolioCoverage) {
      const hasStart = Boolean(snapshotCoverage?.openingSnapshotAt);
      const hasEnd = Boolean(snapshotCoverage?.endingSnapshotAt);
      elements.cyclePortfolioCoverage.textContent = snapshotCoverage?.canCompareNetAssetEndpoints
        ? `组合历史端点可比 · 起点 ${formatDateTime(snapshotCoverage.openingSnapshotAt)} · 终点 ${formatDateTime(snapshotCoverage.endingSnapshotAt)} · 可比较净资产变化；资金流、费用和税费核对前不称为周期收益`
        : `组合历史降级 · 起点${hasStart ? "已覆盖" : "缺失"} · 终点${hasEnd ? "已覆盖" : "缺失"} · 周期内 ${formatNumber(snapshotCoverage?.snapshotCountWithinCycle, 0)} 个快照；不会把当前持仓冒充历史仓位`;
      elements.cyclePortfolioCoverage.classList.toggle("complete", snapshotCoverage?.canCompareNetAssetEndpoints === true);
      elements.cyclePortfolioCoverage.title = arrayValue(snapshotCoverage?.warnings).map(snapshotWarningText).join("\n");
    }
    renderCycleTradePath(item);
    renderCycleTechnicalValidation(item);
    renderCycleReconciliation(item);
    elements.cycleRetrospectiveForm.hidden = !lightweight;
    elements.cycleRecalledJudgment.value = retrospectiveNote.recalledJudgment ?? "";
    elements.cycleLesson.value = retrospectiveNote.lesson ?? "";
    elements.cycleForwardHypothesis.value = retrospectiveNote.forwardHypothesis ?? "";
    elements.cycleRetrospectiveVersion.textContent = retrospectiveVersion
      ? `版本 ${retrospectiveVersion.version} · ${formatDateTime(retrospectiveVersion.savedAt)}`
      : "尚未保存";
    elements.cycleSaveRetrospective.disabled = !lightweight || state.loading;
    elements.cycleSaveRetrospective.textContent = retrospectiveVersion ? "保存新版本" : "保存我的记录";
    elements.cycleDetailThesis.value = exAnte.myView ?? exAnte.thesis ?? "";
    elements.cycleDetailMarketBelief.value = exAnte.marketView ?? exAnte.marketBelief ?? "";
    elements.cycleDetailAction.value = exAnte.plannedAction ?? "";
    elements.cycleDetailInvalidation.value = exAnte.invalidation ?? "";
    elements.cycleDetailFundamental.value = exAnte.fundamentalView ?? "";
    elements.cycleDetailTechnical.value = exAnte.technicalView ?? "";
    elements.cycleExAnteForm.querySelectorAll("textarea").forEach((field) => {
      field.disabled = sealed;
    });
    elements.cycleExAnteForm.hidden = lightweight;
    elements.cycleUpdate.disabled = sealed || state.loading;
    elements.cycleSeal.disabled = sealed || state.loading;
    elements.cycleUpdate.textContent = sealed ? "事前记录已锁定" : "保存四字段";
    elements.cycleSeal.textContent = sealed ? "已封存" : "封存事前记录";
    elements.cycleSealTime.textContent = sealedAt ? `封存于 ${formatDateTime(sealedAt)}` : "尚未封存";
    elements.cycleFreezeNote.textContent = sealed
      ? "时间防火墙已生效；事后信息只能追加，不能覆盖原始判断。"
      : "草稿可更新；封存后事前字段只读。";
    const openLifecycle = cycleType(item) === "position_lifecycle" && !item.endAt;
    elements.cycleCloseForm.hidden = !openLifecycle;
    elements.cycleCloseAt.disabled = !openLifecycle || state.loading;
    renderCycleRecords(item);
    renderCycleCheckpoints(item);
    const checkpointCard = elements.cycleCheckpointForm?.closest(".review-cycle-checkpoint-card");
    if (checkpointCard) checkpointCard.hidden = lightweight;
    renderCyclePhases(item);
  }

  function captureCycleTradePathResult(envelope) {
    const run = envelope?.run;
    if (run?.context?.scope !== "review"
      || run?.context?.reviewProtocol !== "decision_cycle"
      || !["outcome", "retrospective"].includes(run?.context?.reviewPhase)) return;
    const cycleIdValue = String(run.context.reviewCycleId ?? "");
    const metrics = run?.analysisContext?.deterministicOutcomeMetrics;
    const technicalValidation = run?.analysisContext?.technicalValidation;
    const reconciliation = run?.analysisContext?.reconciliation;
    if (!cycleIdValue || (!metrics?.tradePricePath && !technicalValidation && !reconciliation)) return;
    state.cycleTradePathResults.set(cycleIdValue, {
      metrics,
      technicalValidation: technicalValidation ?? null,
      reconciliation: reconciliation ?? null,
      evidenceRevision: Number(run.context.reviewEvidenceRevision),
      reviewPhase: run.context.reviewPhase,
      retrospectiveVersion: run.context.reviewRetrospectiveVersion,
      phaseRunId: run.context.reviewPhaseRunId ?? null,
      persistence: run.context.reviewPhasePersistence ?? null,
      evidenceFilterPolicyVersion: run?.analysisContext?.cycle?.brokerAssociation?.evidenceFilterPolicyVersion ?? null,
      completedAt: !envelope?.error && envelope?.complete !== false && envelope?.partial !== true ? envelope?.completedAt ?? null : null,
      generatedAt: metrics?.generatedAt ?? envelope?.completedAt ?? run.createdAt ?? null,
    });
    const item = selectedCycle();
    if (item && cycleId(item) === cycleIdValue) {
      renderCycleTradePath(item);
      renderCycleTechnicalValidation(item);
      renderCycleReconciliation(item);
    }
  }

  function cycleReconciliationResult(item) {
    const revision = reconciliationRevision(item?.evidenceRevision ?? item?.brokerLinks?.evidenceRevision ?? item?.brokerLinks?.revision);
    if (!revision) return null;
    const phases = ["retrospective", "outcome"].flatMap((phase) => arrayValue(item?.phaseRuns?.[phase]).map((run) => ({ ...run, reviewPhase: phase })));
    const validVersion = (run) => run.reviewPhase !== "retrospective"
      || (reconciliationRevision(cycleRetrospectiveVersion(item)?.version) != null
        && reconciliationRevision(run.retrospectiveVersion) === reconciliationRevision(cycleRetrospectiveVersion(item)?.version));
    const validResult = (result) => result?.schemaVersion === "review-reconciliation/v1"
      && result.cycleId === cycleId(item) && reconciliationRevision(result.cycleEvidenceRevision) === revision
      && typeof result.accountScopeId === "string" && Boolean(state.accountScopeId) && result.accountScopeId === state.accountScopeId
      && (!item?.brokerLinks?.accountScopeId || result.accountScopeId === item.brokerLinks.accountScopeId)
      && /^[a-f0-9]{64}$/.test(String(result.evidenceHash ?? ""))
      && timestamp(result.window?.startAt) > 0 && timestamp(result.window?.startAt) === timestamp(item?.startAt)
      && timestamp(result.window?.endAt) > 0 && timestamp(result.window?.endAt) === timestamp(item?.endAt);
    const validRun = (run) => run.status === "completed" && run.integrityStatus === "valid"
      && timestamp(run.completedAt) > 0 && reconciliationRevision(run.evidenceRevision) === revision
      && validVersion(run) && cycleRunUsesCurrentEvidenceFilter(item, run) && validResult(run.result?.reconciliation);
    const candidates = phases.filter(validRun).map((run) => ({ completedAt: timestamp(run.completedAt), result: run.result.reconciliation }));
    const cached = state.cycleTradePathResults.get(cycleId(item));
    const persistedCacheRun = phases.find((run) => run.id === cached?.phaseRunId);
    if (cached?.persistence === "recorded" && cached.phaseRunId && timestamp(cached.completedAt) > 0
      && ["retrospective", "outcome"].includes(cached.reviewPhase) && cached.evidenceRevision === revision
      && validVersion(cached) && cycleRunUsesCurrentEvidenceFilter(item, cached) && validResult(cached.reconciliation)
      && (!persistedCacheRun || (validRun(persistedCacheRun)
        && persistedCacheRun.result.reconciliation.evidenceHash === cached.reconciliation.evidenceHash))) {
      candidates.push({ completedAt: timestamp(cached.completedAt), result: cached.reconciliation });
    }
    candidates.sort((a, b) => a.completedAt - b.completedAt);
    return candidates.at(-1)?.result ?? null;
  }

  function reconciliationRevision(value) {
    if (typeof value !== "number" && (typeof value !== "string" || !/^[1-9]\d*$/.test(value))) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function reconciliationReasonText(value) {
    const reason = String(value ?? "");
    for (const [prefix, label] of [["opening:", "起点"], ["closing:", "终点"]]) {
      if (reason.startsWith(prefix)) return `${label}：${reconciliationReasonText(reason.slice(prefix.length))}`;
    }
    if (reason.startsWith("fx_requirement_scope_incomplete:")) {
      const name = { openingInventory: "起点库存", closingInventory: "终点库存", externalFlows: "资金流", fees: "费用", taxes: "税费", corporateActions: "企业行动" }[reason.split(":")[1]] ?? "相关证据";
      return `${name}尚未完整核对，汇率覆盖范围不能确认`;
    }
    return ({
      source_missing: "尚未取得原始资料", source_not_host_verified: "原始资料尚未通过本机核验",
      account_scope_unproven: "账户归属尚未确认", account_scope_mismatch: "资料与当前账户不一致",
      cycle_window_invalid: "周期起止时间不完整或无效", original_evidence_id_missing: "缺少原始资料编号",
      full_cycle_coverage_unproven: "资料尚未证明覆盖整个周期", source_observation_time_missing: "缺少资料观测时间",
      source_observed_before_coverage_end: "资料生成时周期尚未结束", original_records_missing: "缺少逐笔原始记录",
      original_inventory_rows_missing: "缺少原始库存明细", inventory_observation_time_missing: "缺少库存观测时间",
      inventory_not_observed_at_exact_boundary: "库存不是在周期边界时点取得", inventory_observed_after_boundary: "库存是在周期边界之后取得",
      inventory_fields_incomplete: "库存数量、证券或币种存在缺项", opening_cost_inventory_incomplete: "起点成本库存不完整",
      cash_inventory_missing: "现金余额尚未取得", reporting_currency_missing: "缺少报告币种",
      reporting_currency_mismatch: "起终点报告币种不同", snapshot_quality_not_complete: "组合快照仍有数据缺口",
      regular_close_v2_prices_only_inventory_and_cash_unreconciled: "仅按收盘价重估，收盘时的数量和现金尚未核对",
      valuation_basis_missing: "缺少估值口径", price_time_missing: "缺少计价时间",
      price_after_boundary: "计价晚于周期边界", price_time_range_invalid: "计价起止时间矛盾",
      prices_not_observed_at_exact_boundary: "价格不是周期边界时点的观测值",
      net_asset_endpoint_missing: "起点或终点净资产缺失", endpoint_times_not_increasing: "起终点时间顺序不正确",
      amount_or_currency_missing: "金额或币种缺失", duplicate_record_id: "存在重复记录编号",
      record_id_missing: "记录缺少编号", record_time_missing: "记录缺少发生时间",
      record_account_scope_mismatch: "记录属于其他账户", record_outside_declared_coverage: "记录超出声明覆盖范围",
      external_flow_direction_missing: "资金流入或流出方向未确认", external_flow_sign_conflict: "资金方向与金额正负号矛盾",
      amount_aggregate_out_of_range: "金额汇总超出可靠计算范围",
      corporate_action_cash_inventory_effects_unreconciled: "企业行动已发现，但现金、税费或库存影响尚未核对",
      corporate_action_fields_incomplete: "企业行动缺少类型或证券信息", split_ratio_missing: "拆股比例缺失",
      dividend_amount_or_currency_missing: "分红金额或币种缺失", corporate_action_kind_unclassified: "企业行动类型尚未支持",
      complete_currency_scope_missing: "涉及币种尚未完整确认", period_fx_evidence_missing: "缺少周期内汇率证据",
      original_conversion_records_coverage_unproven: "缺少完整原始换汇记录，完成标志不能替代证据",
      transaction_and_endpoint_fx_times_incomplete: "交易时点或起终点汇率尚未覆盖",
      observed_currency_missing_from_fx_scope: "实际涉及的币种未纳入汇率范围", fx_rate_fields_incomplete: "汇率记录缺少关键字段",
      fx_rate_direction_unproven: "汇率换算方向未明确", currency_pair_missing: "缺少所需币种对",
      fx_rate_after_cycle: "汇率观测晚于周期结束", fx_reporting_currency_endpoint_mismatch: "汇率报告币种与端点不一致",
      conversion_amount_arithmetic_conflict: "换汇前后金额与汇率不一致", conversion_rate_reference_unverified: "换汇记录引用的汇率无法核验",
      fx_reciprocal_rate_conflict: "正反向汇率不一致", fx_rate_conflict_at_same_time: "同一时点存在冲突汇率",
      qqq_benchmark_missing: "尚未取得 QQQ 基准", benchmark_coverage_incomplete: "基准行情覆盖不完整",
      benchmark_source_or_fetch_time_missing: "基准来源或获取时间缺失", benchmark_endpoint_prices_missing: "基准起终价格缺失",
      benchmark_return_arithmetic_conflict: "基准收益与价格计算不一致", benchmark_window_mismatch: "基准区间与复盘周期不一致",
      benchmark_path_unavailable: "基准价格路径不可用", benchmark_adjustment_basis_missing: "基准复权口径缺失",
      benchmark_trading_dates_outside_cycle: "基准交易日超出周期", qqq_price_currency_conflict: "QQQ 价格币种存在冲突",
      daily_close_interval_not_exact_portfolio_boundary_benchmark: "QQQ 是日线价格区间，不代表组合精确边界收益或超额收益",
    })[reason] ?? "另有证据条件待核对，请查阅原始核对清单";
  }

  function renderCycleReconciliation(item) {
    if (!elements.cycleReconciliation) return;
    elements.cycleReconciliationFields.replaceChildren();
    const result = cycleReconciliationResult(item);
    elements.cycleReconciliationStatus.textContent = result
      ? ({ reconciled: "证据已核对", partial: "仍有缺口", missing: "缺少证据", conflict: "存在冲突" }[result.status] ?? "未核验")
      : "待复盘 / 待重跑";
    elements.cycleReconciliationNote.textContent = result
      ? "以下是本次复盘的证据核对状态，不是收益认证。收盘价重估不代表收盘库存；净资产差额、成交毛盈亏与账户净收益分开处理。"
      : "尚无当前订单版本的核对清单。运行结果或直接事后复盘后生成；旧记录不会自动升级为已对账。";
    if (!result) return;
    const labels = { openingInventory: "起点库存与现金", closingInventory: "终点库存与现金", closingPrices: "终点计价",
      netAssetEndpoints: "净资产端点", externalFlows: "外部资金流", fees: "费用", taxes: "税费", corporateActions: "企业行动", fx: "汇率与换算", qqqBenchmark: "QQQ 基准" };
    const statuses = { reconciled: "已核对", partial: "部分证据", missing: "未取得", conflict: "证据冲突" };
    for (const [key, label] of Object.entries(labels)) {
      const field = result.fields?.[key];
      const group = node("div");
      group.append(node("dt", "", label), node("dd", "", statuses[field?.status] ?? "未核验"));
      const details = node("details");
      details.append(node("summary", "", "来源与限制"), node("p", "review-card-note",
        field?.status === "missing" ? "尚未取得覆盖此周期的原始资料；不按零处理。"
          : `原始来源${field?.sourceVerificationStatus === "verified" ? "已由本机核验" : "尚未核验"}；${field?.status === "reconciled" ? "该项条件齐备" : "时点、覆盖或口径仍需核对"}。`));
      const reasons = arrayValue(field?.reasons);
      if (reasons.length) details.append(node("p", "review-card-note", `核对项：${reasons.map(reconciliationReasonText).join("；")}`));
      const omittedReasons = field?.projection?.omittedReasonCount;
      if (Number.isSafeInteger(omittedReasons) && omittedReasons > 0) details.append(node("p", "review-card-note", `另有 ${omittedReasons} 项未展开的核对条件；以原始证据为准。`));
      const sourceCount = arrayValue(field?.source).length;
      if (sourceCount) details.append(node("p", "review-card-note", `${sourceCount} 项来源引用 · 证据 ${String(field?.evidenceHash ?? "").slice(0, 12)}`));
      const omittedSources = field?.projection?.omittedSourceCount;
      if (Number.isSafeInteger(omittedSources) && omittedSources > 0) details.append(node("p", "review-card-note", `另有 ${omittedSources} 项来源引用未展开；以上为摘要，不是全部原始资料。`));
      group.append(details);
      elements.cycleReconciliationFields.append(group);
    }
  }

  function renderCycleTradePath(item) {
    if (!elements.cycleTradePath) return;
    const isTradeWindow = cycleType(item) === "trade_window";
    elements.cycleTradePath.hidden = !isTradeWindow;
    if (!isTradeWindow) return;
    elements.cycleTradePathAnchors.replaceChildren();
    elements.cycleTradePathSummary.replaceChildren();
    elements.cycleTradePathSegments.replaceChildren();

    const currentEvidenceRevision = Number(
      item?.evidenceRevision ?? item?.brokerLinks?.evidenceRevision ?? item?.brokerLinks?.revision,
    );
    const inMemoryResult = state.cycleTradePathResults.get(cycleId(item));
    const persistedResult = persistedCycleTradePathResult(item, currentEvidenceRevision);
    const result = Number(inMemoryResult?.evidenceRevision) === currentEvidenceRevision
      && inMemoryResult?.metrics?.tradePricePath
      ? inMemoryResult
      : persistedResult ?? inMemoryResult;
    const resultRevision = Number(result?.evidenceRevision);
    const stale = result && Number.isInteger(currentEvidenceRevision) && currentEvidenceRevision > 0
      && (!Number.isInteger(resultRevision) || resultRevision !== currentEvidenceRevision);
    if (!result?.metrics?.tradePricePath || stale) {
      const selectedIds = arrayValue(item?.brokerLinks?.requestedRecordIds);
      elements.cycleTradePathStatus.textContent = stale ? "证据已更新 · 待重跑" : "待运行 Agent";
      const anchorPreview = node("div", "review-trade-path-anchor");
      anchorPreview.append(
        node("span", "", "当前用户框选"),
        node("strong", "", `${selectedIds.length} 条订单 / 成交锚点`),
        node("span", "", selectedIds.length
          ? boundedLabelList(selectedIds, 8)
          : "尚未保留明确框选来源；不能从历史首笔交易推断窗口。"),
      );
      elements.cycleTradePathAnchors.append(anchorPreview);
      elements.cycleTradePathSegments.append(emptyNode(
        stale
          ? "订单范围已修改。旧路径不再展示；按最新框选重新复盘后生成新路径。"
          : "完成订单优先复盘或阶段二后，这里会显示 Buy / Sell 锚点、部分退出与 3 交易日分段。",
        true,
      ));
      return;
    }

    const path = result.metrics.tradePricePath;
    const activities = arrayValue(path?.activities);
    const startActivity = activities.find((entry) => entry?.id === path?.window?.startActivityId) ?? null;
    const endActivity = activities.find((entry) => entry?.id === path?.window?.endActivityId) ?? null;
    elements.cycleTradePathStatus.textContent = tradePathStatusLabel(path);
    elements.cycleTradePathAnchors.append(
      tradePathAnchorNode("BUY 锚点", startActivity, path?.window?.startAt),
      tradePathAnchorNode("SELL 锚点", endActivity, path?.window?.endAt),
    );

    const metricRows = [
      ["已闭合数量", optionalNumberText(path?.metrics?.realizedQuantity)],
      ["框选后未平数量", optionalNumberText(path?.metrics?.openQuantity)],
      ["框选内 FIFO 毛盈亏", `${path?.currency ?? ""} ${optionalSignedNumberText(path?.metrics?.linkedSelectionGrossPnl)}`.trim()],
      ["调整后路径 / MAE", `${optionalSignedPercentText(path?.pricePath?.periodReturnPercent)} / ${optionalSignedPercentText(path?.pricePath?.maePercent)}`],
    ];
    for (const [label, value] of metricRows) {
      const group = node("div");
      group.append(node("dt", "", label), node("dd", "", value));
      elements.cycleTradePathSummary.append(group);
    }

    const segments = arrayValue(path?.pricePath?.trend?.segments);
    const projection = Number(path?.pricePath?.trend?.omittedSegmentCount) > 0
      ? { items: segments }
      : boundedUiSequence(segments, 36);
    if (!projection.items.length) {
      elements.cycleTradePathSegments.append(emptyNode(
        `价格分段不可用 · ${tradePathReasonLabel(path?.pricePath?.reason ?? path?.reason)}`,
        true,
      ));
      return;
    }
    projection.items.forEach((segment) => {
      if (segment?.omittedCount) {
        elements.cycleTradePathSegments.append(node(
          "div",
          "review-trade-path-segment omitted",
          `中间 ${segment.omittedCount} 段已折叠；Agent 证据仍按有界首尾投影并明确记录省略数。`,
        ));
        return;
      }
      const card = node("div", `review-trade-path-segment ${String(segment?.direction ?? "flat")}`);
      card.append(
        node("span", "", `#${formatNumber(segment?.index, 0)} · ${formatNumber(segment?.tradingDayCount, 0)} 个交易日`),
        node("strong", "", `${segment?.startTradeDate ?? "—"} → ${segment?.endTradeDate ?? "—"}`),
        node("span", "", `收盘 ${formatNumber(segment?.firstClose)} → ${formatNumber(segment?.lastClose)} · ${signedPercent(segment?.closeReturnPercent)}`),
      );
      elements.cycleTradePathSegments.append(card);
    });
  }

  function persistedCycleTradePathResult(item, currentEvidenceRevision) {
    const runs = [
      ...arrayValue(item?.phaseRuns?.retrospective),
      ...arrayValue(item?.phaseRuns?.outcome),
    ].filter((run) => (
      run?.status === "completed"
      && run?.integrityStatus === "valid"
      && Number(run?.evidenceRevision) === Number(currentEvidenceRevision)
      && cycleRunUsesCurrentEvidenceFilter(item, run)
      && run?.result?.tradePricePathSummary
    )).sort((left, right) => timestamp(left.completedAt) - timestamp(right.completedAt));
    const run = runs.at(-1);
    if (!run) return null;
    return {
      metrics: { tradePricePath: run.result.tradePricePathSummary },
      evidenceRevision: Number(run.evidenceRevision),
      reviewPhase: run.phase,
      generatedAt: run.result.tradePricePathSummary.generatedAt ?? run.completedAt ?? null,
      persisted: true,
    };
  }

  function renderCycleTechnicalValidation(item) {
    if (!elements.cycleTechnicalValidation) return;
    const isTradeWindow = cycleType(item) === "trade_window";
    elements.cycleTechnicalValidation.hidden = !isTradeWindow;
    if (!isTradeWindow) return;
    elements.cycleTechnicalValidationSummary.replaceChildren();
    const currentEvidenceRevision = Number(
      item?.evidenceRevision ?? item?.brokerLinks?.evidenceRevision ?? item?.brokerLinks?.revision,
    );
    const inMemory = state.cycleTradePathResults.get(cycleId(item));
    const persisted = persistedCycleTechnicalValidationResult(item, currentEvidenceRevision);
    const result = Number(inMemory?.evidenceRevision) === currentEvidenceRevision && inMemory?.technicalValidation
      ? inMemory
      : persisted;
    const sample = result?.technicalValidation ?? null;
    if (!sample) {
      elements.cycleTechnicalValidationStatus.textContent = "待运行 Agent";
      elements.cycleTechnicalValidationNote.textContent = "完成订单优先复盘后，系统会尝试关联入场前雷达；没有历史批次时保持 N/A，不会拿当前图表倒推当时状态。";
      return;
    }
    const classification = String(sample?.validationMode?.classification ?? "historical_calibration");
    const available = sample?.sampleCandidate?.status === "available";
    const complete = sample?.status === "complete";
    const modeLabel = classification === "walk_forward" ? "前向样本" : "历史校准";
    elements.cycleTechnicalValidationStatus.textContent = complete
      ? `已关联 · ${modeLabel}`
      : available ? `部分关联 · ${modeLabel}` : "N/A · 无可用入场前样本";
    const rows = [
      ["雷达批次", sample?.entrySnapshot?.batch?.tradingDate ?? "N/A"],
      ["写入时间", sample?.entrySnapshot?.batch?.recordedAt ? formatDateTime(sample.entrySnapshot.batch.recordedAt) : "N/A"],
      ["持有期 / QQQ 超额（收益率差）", `${technicalMetricPercent(sample?.outcome?.holdingPeriodReturnPercent)} / ${technicalMetricPercentagePoints(sample?.outcome?.qqqExcessPercent)}`],
      ["MAE / MFE", `${technicalMetricPercent(sample?.outcome?.maePercent)} / ${technicalMetricPercent(sample?.outcome?.mfePercent)}`],
      ["计划 / 压力 / 已实现 R", `${technicalMetricR(sample?.riskR?.planned)} / ${technicalMetricR(sample?.riskR?.stress)} / ${technicalMetricR(sample?.riskR?.realized)}`],
      ["验证类别", classification === "walk_forward" ? "前向样本" : "历史校准"],
    ];
    for (const [label, value] of rows) {
      const group = node("div");
      group.append(node("dt", "", label), node("dd", "", value));
      elements.cycleTechnicalValidationSummary.append(group);
    }
    const reasons = arrayValue(sample?.reasonCodes);
    elements.cycleTechnicalValidationNote.textContent = available
      ? `${classification === "walk_forward" && sample?.sampleCandidate?.eligibleForFormalStatistics === true ? "满足单样本前向时序条件" : "仅供发现与校准"}；单笔观察不是规则。至少需要 20 个来自唯一周期的合格前向候选，并完成重叠窗口与同一事件去重、确定性核验及人工确认，才可进入规则决策。${reasons.length ? ` 降级原因：${boundedLabelList(reasons, 5)}` : ""}`
      : `未生成可用技术样本。${reasons.length ? ` 原因：${boundedLabelList(reasons, 6)}` : " 入场前没有合格雷达批次或结果证据不足。"}`;
  }

  function persistedCycleTechnicalValidationResult(item, currentEvidenceRevision) {
    const runs = [
      ...arrayValue(item?.phaseRuns?.retrospective),
      ...arrayValue(item?.phaseRuns?.outcome),
    ].filter((run) => (
      run?.status === "completed"
      && run?.integrityStatus === "valid"
      && Number(run?.evidenceRevision) === Number(currentEvidenceRevision)
      && cycleRunUsesCurrentEvidenceFilter(item, run)
      && run?.result?.technicalValidation
    )).sort((left, right) => timestamp(left.completedAt) - timestamp(right.completedAt));
    const run = runs.at(-1);
    if (!run) return null;
    return {
      technicalValidation: run.result.technicalValidation,
      evidenceRevision: Number(run.evidenceRevision),
      reviewPhase: run.phase,
      generatedAt: run.completedAt ?? null,
      persisted: true,
    };
  }

  function technicalMetricPercent(metric) {
    return metric?.status === "available" && strictFiniteReviewNumber(metric?.value) != null
      ? signedPercent(metric.value)
      : "N/A";
  }

  function technicalMetricPercentagePoints(metric) {
    return metric?.status === "available" && strictFiniteReviewNumber(metric?.value) != null
      ? `${Number(metric.value) > 0 ? "+" : ""}${Number(metric.value).toFixed(2)} 个百分点`
      : "N/A";
  }

  function technicalMetricR(metric) {
    return metric?.status === "available" && strictFiniteReviewNumber(metric?.value) != null
      ? signedR(metric.value)
      : "N/A";
  }

  function tradePathAnchorNode(label, activity, fallbackAt) {
    const card = node("div", "review-trade-path-anchor");
    card.append(
      node("span", "", label),
      node("strong", "", activity
        ? `${activity.id} · ${formatNumber(activity.quantity)} @ ${activity.currency ?? ""} ${formatNumber(activity.price, 4)}`
        : "锚点证据不可用"),
      node("span", "", formatDateTime(activity?.at ?? fallbackAt)),
    );
    return card;
  }

  function tradePathStatusLabel(path) {
    if (path?.positionStatus === "partially_closed") {
      return `部分退出 · 尚余 ${optionalNumberText(path?.metrics?.openQuantity)}`;
    }
    if (path?.status === "available") return "框选周期已闭合";
    if (path?.status === "partial") return `证据部分可用 · ${tradePathReasonLabel(path?.reason)}`;
    return `不可计算 · ${tradePathReasonLabel(path?.reason)}`;
  }

  function tradePathReasonLabel(value) {
    return ({
      no_executed_activity_in_selected_records: "框选记录没有已执行成交",
      selected_buy_activity_missing: "缺少框选买入",
      selected_sell_activity_missing: "缺少框选卖出",
      selected_position_remains_open: "仍有框选买入数量未卖出",
      daily_price_path_unavailable: "周期日线不足",
      price_path_coverage_partial: "周期日线覆盖不完整",
      no_completed_daily_close_inside_holding_window: "持有窗口内没有已完成日线",
    })[String(value ?? "")] ?? String(value ?? "未提供原因");
  }

  function boundedUiSequence(values, maximum) {
    const source = Array.isArray(values) ? values : [];
    if (source.length <= maximum) return { items: source };
    const head = Math.ceil(maximum / 2);
    const tail = maximum - head;
    return {
      items: [
        ...source.slice(0, head),
        { omittedCount: source.length - maximum },
        ...source.slice(-tail),
      ],
    };
  }

  function boundedLabelList(values, maximum) {
    const source = arrayValue(values);
    if (source.length <= maximum) return source.join(" · ");
    const head = Math.ceil(maximum / 2);
    const tail = maximum - head;
    return `${source.slice(0, head).join(" · ")} · …省略 ${source.length - maximum} 条… · ${source.slice(-tail).join(" · ")}`;
  }

  function optionalNumberText(value) {
    return value == null || value === "" || !Number.isFinite(Number(value)) ? "—" : formatNumber(value);
  }

  function optionalSignedNumberText(value) {
    return value == null || value === "" || !Number.isFinite(Number(value)) ? "—" : signedNumber(value);
  }

  function optionalSignedPercentText(value) {
    return value == null || value === "" || !Number.isFinite(Number(value)) ? "—" : signedPercent(value);
  }

  async function updateSelectedCycle(event) {
    event.preventDefault();
    const item = selectedCycle();
    if (!item || cycleSealed(item) || state.loading) return;
    const exAnte = cycleExAnteFromDetail();
    await runAction("正在保存事前记录…", async () => {
      await callReview("updateCycle", { cycleId: cycleId(item), patch: { exAnte } });
      clearCycleDraftSection(cycleId(item), "exAnte");
      await loadSnapshot({ preservePane: true });
      showNotice("事前四字段已保存；尚未封存，仍可修改。", "success");
    });
  }

  async function saveSelectedCycleRetrospectiveNote(event, { quiet = false } = {}) {
    event?.preventDefault?.();
    const item = selectedCycle();
    if (!item || cycleReviewMode(item) !== "lightweight" || state.loading) return false;
    const note = retrospectiveNoteFromDetail();
    const missing = [
      [note.recalledJudgment, "当时判断（事后回忆）"],
      [note.lesson, "本次感悟"],
      [note.forwardHypothesis, "未来预判"],
    ].filter(([value]) => !value).map(([, label]) => label);
    if (missing.length) {
      showNotice(`开始复盘前请补充：${missing.join("、")}。每项一两句话即可。`, "warning");
      return false;
    }
    let saved = false;
    await runAction("正在保存你的复盘记录…", async () => {
      await callReview("saveCycleRetrospectiveNote", { cycleId: cycleId(item), note });
      clearCycleDraftSection(cycleId(item), "retrospectiveNote");
      await loadSnapshot({ preservePane: true });
      saved = true;
      if (!quiet) showNotice("记录已保存为带时间戳的新版本；未来预判从本次保存时刻起生效。", "success");
    });
    return saved;
  }

  function retrospectiveNoteFromDetail() {
    return {
      recalledJudgment: elements.cycleRecalledJudgment.value.trim(),
      lesson: elements.cycleLesson.value.trim(),
      forwardHypothesis: elements.cycleForwardHypothesis.value.trim(),
    };
  }

  function cycleExAnteFromDetail() {
    return {
      myView: elements.cycleDetailThesis.value.trim(),
      marketView: elements.cycleDetailMarketBelief.value.trim(),
      plannedAction: elements.cycleDetailAction.value.trim(),
      invalidation: elements.cycleDetailInvalidation.value.trim(),
      fundamentalView: elements.cycleDetailFundamental.value.trim(),
      technicalView: elements.cycleDetailTechnical.value.trim(),
    };
  }

  async function sealSelectedCycle() {
    const item = selectedCycle();
    if (!item || cycleSealed(item) || state.loading) return;
    await runAction("正在封存事前信息…", async () => {
      await callReview("updateCycle", { cycleId: cycleId(item), patch: { exAnte: cycleExAnteFromDetail() } });
      await callReview("sealCycle", { cycleId: cycleId(item) });
      clearCycleDraftSection(cycleId(item), "exAnte");
      await loadSnapshot({ preservePane: true });
      showNotice("事前信息已封存。阶段一只能使用封存时点以前的证据。", "success");
    });
  }

  function handleCycleLinkAction() {
    const item = selectedCycle();
    if (!item || state.loading) return;
    if (cycleReviewMode(item) === "lightweight" && cycleBrokerRecords(item).length) {
      beginCycleLinkEdit();
      return;
    }
    void linkCycleRecords();
  }

  async function linkCycleRecords() {
    const item = selectedCycle();
    if (!item || state.loading) return;
    // A monthly portfolio cycle is account-wide by definition. Never let a
    // stale intake selection narrow it or trigger an unrelated range error.
    const monthly = cycleType(item) === "monthly_portfolio";
    const recordIds = monthly ? [] : [...state.selectedRecordIds];
    await runAction("正在关联周期订单与成交…", async () => {
      const result = await callReview("linkCycleRecords", { cycleId: cycleId(item), recordIds, confirmed: true });
      const linkedCount = arrayValue(result?.selection?.recordIds).length || recordIds.length;
      await loadSnapshot({ preservePane: true });
      showNotice(
        !monthly && recordIds.length
          ? `已将当前选择及同单自动补齐的 ${linkedCount} 条只读历史记录关联到周期。`
          : `已按${monthly ? "整月账户" : "周期范围"}自动关联 ${linkedCount} 条只读历史记录。`,
        "success",
      );
    });
  }

  function renderCycleRecords(item) {
    const records = cycleBrokerRecords(item);
    const excludedAuditCount = Number(item?.brokerEvidenceAudit?.excludedAuditRecordCount ?? 0);
    const accountScopeStatus = String(item?.brokerEvidenceAudit?.accountScopeStatus ?? "");
    const accountScopeWarning = accountScopeStatus === "mismatch"
      ? "此周期绑定的是另一个长桥账户范围。系统已隐藏关联记录，防止跨账户混入；请切回原账户，或在当前账户下重新建立复盘周期。"
      : accountScopeStatus === "legacy_unbound"
        ? "此周期创建于账户范围绑定之前，旧关联记录没有可核验的账户归属。请连接长桥后重新选择并关联记录，再运行复盘。"
        : null;
    elements.cycleRecords.replaceChildren();
    elements.cycleRecordCount.textContent = accountScopeStatus === "mismatch"
      ? "账户范围不匹配 · 0 条可分析"
      : `${records.length} 条可分析${excludedAuditCount ? ` · ${excludedAuditCount} 条仅审计` : ""}`;
    if (accountScopeWarning) {
      elements.cycleRecords.append(node("p", "review-cycle-account-scope-warning", accountScopeWarning));
    }
    if (!records.length) {
      elements.cycleRecords.append(emptyNode(
        accountScopeWarning
          ? "账户范围核验通过并重新关联后，订单与成交才会进入本周期证据。"
          : excludedAuditCount
          ? `已关联记录中有 ${excludedAuditCount} 条不构成可核验交易事实，已从默认证据排除；可在待关联订单的“审计：已排除记录”中查看。`
          : "尚未关联订单或成交。\n可到案例复盘的待关联订单中选择记录。",
        true,
      ));
    } else {
      for (const record of records) {
        const row = node("div", "review-cycle-record-row");
        row.append(
          node("strong", "", brokerRecordType(record) === "order" ? "订单" : "成交"),
          node("span", "", `${brokerSymbol(record) || "—"} · ${String(record.side ?? record.direction ?? "—").toUpperCase()}`),
          node("span", "", `数量 ${formatNumber(record.quantity ?? record.executedQuantity ?? record.qty)}`),
          node("span", "", formatShortDateTime(brokerRecordAt(record))),
        );
        elements.cycleRecords.append(row);
      }
    }
    updateCycleLinkButton();
  }

  function updateCycleLinkButton() {
    const item = selectedCycle();
    const monthly = cycleType(item) === "monthly_portfolio";
    const count = monthly ? 0 : state.selectedRecordIds.size;
    const existingCount = item ? cycleBrokerRecords(item).length : 0;
    elements.cycleLinkRecords.disabled = !item || state.loading;
    elements.cycleLinkRecords.textContent = item && cycleReviewMode(item) === "lightweight" && existingCount
      ? `重新选择订单 · v${Number(item?.brokerLinks?.revision ?? item?.brokerLinkVersions?.at?.(-1)?.revision ?? 1)}`
      : monthly
      ? "自动关联整月交易"
      : count ? `关联当前选择 · ${count}` : "自动关联周期内订单";
    elements.cycleLinkHint.textContent = item && cycleReviewMode(item) === "lightweight" && existingCount
      ? "可增删错单或漏单；保存后旧结果保留并标记过期"
      : !monthly && count
      ? `待关联 ${count} 条 · ${selectedIntakeSymbols().join(" + ") || "已选历史"}`
      : monthly
        ? "未手选 · 将按整月时间范围关联有效成交并审计排除项"
        : "未手选 · 将按周期时间与标的自动关联";
  }

  function renderCycleCheckpoints(item) {
    const checkpoints = cycleCheckpoints(item);
    elements.cycleCheckpoints.replaceChildren();
    elements.cycleCheckpointCount.textContent = `${checkpoints.length} 个`;
    if (!checkpoints.length) {
      elements.cycleCheckpoints.append(emptyNode("尚无动作检查点。\n添加每次显著仓位或判断变化。", true));
      return;
    }
    for (const checkpoint of checkpoints) {
      const row = node("div", "review-cycle-checkpoint-item");
      row.append(
        node("span", "", formatShortDateTime(checkpoint.at ?? checkpoint.occurredAt ?? checkpoint.createdAt)),
        node("strong", "", checkpointKindLabel(checkpoint.kind ?? checkpoint.type)),
        node("span", "", checkpoint.action ?? checkpoint.note ?? checkpoint.description ?? "—"),
      );
      elements.cycleCheckpoints.append(row);
    }
  }

  async function addCycleCheckpoint(event) {
    event.preventDefault();
    const item = selectedCycle();
    if (!item || state.loading) return;
    const checkpoint = {
      at: inputDateTimeToIso(elements.cycleCheckpointAt.value),
      kind: elements.cycleCheckpointKind.value,
      action: elements.cycleCheckpointAction.value.trim(),
      fundamental: elements.cycleCheckpointFundamental.value.trim(),
      technical: elements.cycleCheckpointTechnical.value.trim(),
    };
    if (!checkpoint.at || !checkpoint.action) return;
    await runAction("正在添加动作检查点…", async () => {
      await callReview("addCycleCheckpoint", { cycleId: cycleId(item), checkpoint });
      elements.cycleCheckpointForm.reset();
      await loadSnapshot({ preservePane: true });
      showNotice("动作检查点已加入决策时间线。", "success");
    });
  }

  async function closePositionCycle(event) {
    event.preventDefault();
    const item = selectedCycle();
    const endAt = inputDateTimeToIso(elements.cycleCloseAt.value);
    if (!item || cycleType(item) !== "position_lifecycle" || item.endAt || !endAt || state.loading) return;
    await runAction("正在确认持仓周期结束…", async () => {
      await callReview("updateCycle", { cycleId: cycleId(item), patch: { endAt } });
      await loadSnapshot({ preservePane: true });
      showNotice("持仓周期结束时间已确认且不可改写；若阶段一已完成，阶段二会在该时间到达后解锁。", "success");
    });
  }

  function renderCyclePhases(item) {
    const lightweight = cycleReviewMode(item) === "lightweight";
    const sealed = cycleSealed(item);
    const blindDone = cyclePhaseComplete(item, "blind");
    const outcomeDone = cyclePhaseComplete(item, "outcome");
    const outcomeReady = cycleOutcomeReady(item);
    const blindCard = elements.cycleAnalyzeBlind.closest("[data-cycle-phase='blind']");
    const outcomeCard = elements.cycleAnalyzeOutcome.closest("[data-cycle-phase='outcome']");
    const retrospectiveCard = elements.cycleAnalyzeRetrospective.closest("[data-cycle-phase='retrospective']");
    retrospectiveCard.hidden = !lightweight;
    retrospectiveCard.classList.toggle("complete", cyclePhaseComplete(item, "retrospective"));
    retrospectiveCard.classList.toggle("locked", !outcomeReady);
    retrospectiveCard.parentElement.dataset.mode = lightweight ? "lightweight" : "rigorous";
    blindCard.hidden = lightweight;
    outcomeCard.hidden = lightweight;
    elements.cycleAnalyzeRetrospective.disabled = !lightweight || !outcomeReady || state.loading;
    elements.cycleAnalyzeRetrospective.textContent = cyclePhaseComplete(item, "retrospective")
      ? "保存新版本并重新复盘"
      : outcomeReady ? "保存并开始复盘" : "周期结束后可复盘";
    blindCard.classList.toggle("complete", blindDone);
    blindCard.classList.toggle("locked", !sealed);
    outcomeCard.classList.toggle("complete", outcomeDone);
    outcomeCard.classList.toggle("locked", !blindDone || !outcomeReady);
    elements.cycleAnalyzeBlind.disabled = !sealed || state.loading;
    elements.cycleAnalyzeBlind.textContent = blindDone ? "重新运行阶段一" : sealed ? "开始阶段一" : "封存后开始阶段一";
    elements.cycleAnalyzeBlind.title = sealed ? "在独立复盘会话中执行盲态重放" : "请先封存事前四字段";
    elements.cycleAnalyzeOutcome.disabled = !blindDone || !outcomeReady || state.loading;
    elements.cycleAnalyzeOutcome.textContent = outcomeDone
      ? "重新运行阶段二"
      : !blindDone
        ? "阶段二尚未解锁"
        : outcomeReady
          ? "开始阶段二"
          : "周期结束后解锁";
    elements.cycleAnalyzeOutcome.title = !blindDone
      ? "请先完成阶段一盲态复盘"
      : outcomeReady
        ? "揭示结果并进行归因"
        : "必须先到达并确认周期结束时间";
    elements.cyclePhaseGate.textContent = lightweight
      ? cyclePhaseComplete(item, "retrospective")
        ? "已有复盘记录；修改三段笔记后再次运行，会保存新版本并新建独立 Agent 会话，不覆盖旧结论。"
        : "先写三段个人记录，再用已关联的真实订单与成交复盘。事后回忆不算事前证据，未来预判只从保存时刻起进入后续验证。"
      : !sealed
      ? "请先封存事前记录。封存前，任何阶段都不会启动。"
      : !blindDone
        ? "阶段二仍被时间防火墙锁定：先完成阶段一盲态复盘，未来信息才会解锁。"
        : !outcomeReady
          ? "阶段一已有完成记录，但周期尚未结束；阶段二不会提前读取结果。"
        : outcomeDone
          ? "两阶段均已有完成记录；重新运行会新建分析会话，不会覆盖旧结果。"
          : "阶段一已有完成记录。现在可以揭示结果，分析后续路径与盈亏归因。";
  }

  async function prepareCycleAnalysis(reviewPhase) {
    let item = selectedCycle();
    if (!item || state.loading) return;
    if (reviewPhase === "retrospective" && cycleReviewMode(item) !== "lightweight") {
      showNotice("严谨周期请使用阶段一与阶段二；直接事后复盘只用于订单优先轻量模式。", "warning");
      return;
    }
    if (reviewPhase === "blind" && !cycleSealed(item)) {
      showNotice("请先封存事前四字段，再开始阶段一盲态复盘。", "warning");
      return;
    }
    if (reviewPhase === "outcome" && !cyclePhaseComplete(item, "blind")) {
      showNotice("阶段二尚未解锁：必须先有阶段一完成记录。", "warning");
      return;
    }
    if (reviewPhase === "outcome" && !cycleOutcomeReady(item)) {
      showNotice("阶段二尚未解锁：复盘周期必须先结束，不能提前揭示未来结果。", "warning");
      return;
    }
    if (reviewPhase === "retrospective" && !cycleOutcomeReady(item)) {
      showNotice("周期尚未结束，不能提前执行事后复盘。", "warning");
      return;
    }
    if (reviewPhase === "retrospective") {
      const saved = await saveSelectedCycleRetrospectiveNote(null, { quiet: true });
      if (!saved) return;
      item = selectedCycle() ?? item;
    }
    const task = reviewPhase === "blind"
      ? `$review-decision-cycles 对“${cycleTitle(item)}”执行阶段一盲态重放。严格按检查点时间推进，只读取各节点当时已公开且已封存的信息；分别审计基本面、技术面、市场预期、仓位风险、计划动作和失效纪律。不要读取或推断后续价格、P&L、财报结果与未来新闻。`
      : reviewPhase === "retrospective"
        ? `$review-decision-cycles 对“${cycleTitle(item)}”执行订单优先的直接事后复盘。先逐字尊重用户刚保存的三段记录：当时判断是事后回忆，本次感悟是回顾性解释，未来预判仅从保存时间起生效；三者不得互相冒充。以最新关联版本中的长桥订单与成交为事实起点，自由选择适用的基本面、技术面、筹码、市场环境、仓位与执行证据。最后生成一份结构化、可由用户确认的测试与候选规则草案，不因单次结果自动晋级规则。`
        : `$review-decision-cycles 对“${cycleTitle(item)}”执行阶段二结果复盘。以前一阶段的盲态判断为基线，再揭示后续基本面、技术路径与真实订单成交；P&L、MAE/MFE和相对收益仅在宿主依据关联成交及周期内长桥日线可计算时引用，否则保留明确的缺失原因。区分判断、时点、仓位、执行和运气，并提出下一轮可验证计划。`;
    const detail = {
      cycleId: cycleId(item),
      cycleType: cycleType(item),
      reviewPhase,
      task,
    };
    window.dispatchEvent(new CustomEvent("cockpit:review-cycle-analysis-prepared", { detail }));
    showNotice(
      reviewPhase === "blind"
        ? "阶段一盲态复盘已交给独立 Agent 会话；结果信息仍保持锁定。"
        : reviewPhase === "retrospective"
          ? "订单优先事后复盘已交给独立 Agent 会话。"
          : "阶段二结果复盘已交给独立 Agent 会话。",
      "success",
    );
  }

  function renderCaseList() {
    elements.showIntake.setAttribute("aria-pressed", String(state.casePane === "intake"));
    elements.showCases.setAttribute("aria-pressed", String(state.casePane === "case"));
    const cases = visibleReviewCases();
    elements.batchScope.hidden = true;
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
          : "没有旧版案例。\n新的分析请从真实订单建立复盘周期。",
        true,
      ));
      return;
    }
    for (const item of cases) {
      const id = caseId(item);
      const row = node("div", "review-case-select-row");
      const button = node("button", `review-case-item${id === state.selectedCaseId ? " active" : ""}`);
      button.type = "button";
      button.dataset.reviewCaseId = id;
      button.append(
        node("strong", "", `${caseSymbol(item)} · ${casePeriod(item)}`),
        node("small", "", caseStatus(item)),
        node("p", "", `${strategyLabel(item.strategyType ?? item.strategyFamily ?? item.strategy)} · ${horizonLabel(casePrimaryWindow(item))}`),
      );
      row.append(button);
      elements.caseList.append(row);
    }
  }

  function visibleReviewCases() {
    return state.snapshot.cases.filter((item) => {
      if (state.quarterFilter && casePeriod(item) !== state.quarterFilter) return false;
      if (!state.caseFilter) return true;
      return [caseSymbol(item), casePeriod(item), item.strategyFamily, item.strategy]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(state.caseFilter);
    });
  }

  function showIntakePane() {
    clearCaseMigrationPreview();
    const wasEditingLinks = Boolean(state.editingCaseLinkId || state.editingCycleLinkId);
    state.editingCaseLinkId = null;
    state.editingCycleLinkId = null;
    if (wasEditingLinks) {
      state.selectedRecordIds.clear();
      state.selectedRecordCache.clear();
      state.selectedEventId = null;
      state.suggestedEventId = null;
    }
    state.selectedCaseId = null;
    state.casePane = "intake";
    setReviewTab("cases");
    renderCaseList();
    renderSelectedCase();
    renderIntake();
    elements.intakeSearch.focus();
  }

  function showCasePane() {
    if (state.editingCaseLinkId || state.editingCycleLinkId) {
      state.selectedRecordIds.clear();
      state.selectedRecordCache.clear();
      state.selectedEventId = null;
      state.suggestedEventId = null;
    }
    state.editingCaseLinkId = null;
    state.editingCycleLinkId = null;
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
    if (String(id) !== state.selectedCaseId) clearCaseMigrationPreview();
    state.editingCaseLinkId = null;
    state.editingCycleLinkId = null;
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
    if (!showCase) return;
    const exAnte = item.exAnteDraft ?? item.exAnte ?? item.decision ?? item.draft ?? {};
    elements.caseId.value = caseId(item);
    elements.caseHeading.textContent = `${caseSymbol(item)} · ${casePeriod(item)}`;
    setCaseStatus(caseStatus(item));
    elements.caseSymbol.value = caseSymbol(item);
    elements.casePeriod.value = casePeriod(item);
    elements.caseEventAt.value = localDateTimeValue(item.eventAt ?? item.scheduledAt ?? item.event?.scheduledAt ?? item.event?.actualAt);
    setSelectValue(elements.caseStrategy, item.strategyType ?? item.strategyFamily ?? item.strategy ?? "other");
    setSelectValue(elements.caseWindow, casePrimaryWindow(item));
    elements.caseRiskBudget.value = valueOrEmpty(exAnte.riskBudgetR ?? exAnte.riskBudgetAmount ?? item.riskBudgetR);
    elements.caseStage.value = exAnte.narrativeStage ?? exAnte.stage ?? item.stage ?? "";
    elements.caseTemperature.value = valueOrEmpty(exAnte.marketTemperature ?? exAnte.temperature ?? item.temperature);
    elements.caseThesis.value = exAnte.myView ?? exAnte.thesis ?? item.thesis ?? "";
    elements.caseMarketBelief.value = exAnte.marketView ?? exAnte.marketBelief ?? item.marketBelief ?? "";
    elements.caseAction.value = exAnte.plannedAction ?? item.plannedAction ?? "";
    elements.caseInvalidation.value = exAnte.invalidation ?? item.invalidation ?? "";
    setCaseFormFrozen();
    const latestVersion = Array.isArray(item.exAnteVersions) ? item.exAnteVersions.at(-1) : null;
    elements.freezeNote.textContent = latestVersion
      ? `历史只读 · 原封存时间 ${formatDateTime(latestVersion.sealedAt)}。继续分析请先预览迁移；原记录与原 Codex 对话保留。`
      : "历史只读 · 迁移不会将旧草稿或事后回忆提升为事前证据。原记录与原 Codex 对话保留。";
    for (const button of [elements.freezeCase, elements.saveCase, elements.analyzeCase, elements.editBrokerLinks, elements.linkRecords]) {
      if (button) { button.disabled = true; button.hidden = true; }
    }
    elements.previewCaseMigration.disabled = state.loading;
    const linkedCount = arrayValue(item?.brokerLinks?.orderIds).length + arrayValue(item?.brokerLinks?.executionIds).length;
    elements.brokerLinkNote.textContent = linkedCount
      ? "原关联及其历史版本只读保留。迁移后可在周期中修正订单、补充记录并重新分析，不覆盖这里的证据。"
      : "旧案例尚无可核验关联。预览会说明缺失；也可从订单证据创建新的周期，原案例保留。";
    renderBrokerMatches(item);
    renderCheckpoints(item);
    renderCaseMigrationPreview();
  }

  function legacyCaseReadOnly(event) {
    event?.preventDefault?.();
    showNotice("旧案例只读保留。请先预览迁移到周期，再修改订单或继续分析；不会自动批量迁移。", "warning");
  }

  function clearCaseMigrationPreview() {
    state.caseMigrationPreview = null;
    state.caseMigrationRequestToken = (state.caseMigrationRequestToken ?? 0) + 1;
    if (elements.caseMigration) elements.caseMigration.hidden = true;
  }

  function caseMigrationRequestIsCurrent(caseIdValue, scopeId, token) {
    return state.selectedCaseId === caseIdValue && state.accountScopeId === scopeId
      && state.caseMigrationRequestToken === token;
  }

  async function previewSelectedCaseMigration() {
    const item = selectedCase();
    if (!item || state.loading) return;
    const id = caseId(item), scopeId = state.accountScopeId;
    clearCaseMigrationPreview();
    const token = state.caseMigrationRequestToken;
    await runAction("正在核对旧案例与迁移范围…", async () => {
      const result = await callReview("previewCaseMigration", { caseId: id });
      if (!caseMigrationRequestIsCurrent(id, scopeId, token)) return;
      const preview = result?.preview;
      if (!preview || preview.sourceCaseId !== id || (!preview.existingCycleId && !preview.sourceHash)) {
        throw new Error("迁移预览缺少可核验来源；原案例保持不变。");
      }
      state.caseMigrationPreview = { ...preview, accountScopeId: scopeId };
      renderCaseMigrationPreview();
      showNotice(preview.existingCycleId ? "该案例已有迁移周期，可以直接打开，不会重复创建。" : "预览未写入数据。请检查范围与限制，再明确确认迁移。", "success");
    });
  }

  function renderCaseMigrationPreview() {
    const preview = state.caseMigrationPreview;
    const visible = preview && preview.sourceCaseId === state.selectedCaseId
      && preview.accountScopeId === state.accountScopeId;
    elements.caseMigration.hidden = !visible;
    if (!visible) return;
    elements.caseMigrationSummary.replaceChildren(
      node("strong", "", preview.title || "迁移为复盘周期"),
      node("p", "", `${arrayValue(preview.symbols).join(" · ") || "标的待核验"} · ${cycleTypeLabel(preview.cycleType)}`),
      node("p", "", `${formatDateTime(preview.startAt)} → ${formatDateTime(preview.endAt)}`),
      node("p", "", `${formatNumber(preview.recordCount, 0)} 条证据 · ${formatNumber(preview.orderCount, 0)} 笔订单 · ${formatNumber(preview.executionCount, 0)} 笔成交`),
    );
    elements.caseMigrationLimitations.replaceChildren();
    for (const limitation of arrayValue(preview.limitations)) {
      elements.caseMigrationLimitations.append(node("li", "", typeof limitation === "string" ? limitation : limitation?.message || limitation?.code || "证据存在限制"));
    }
    elements.confirmCaseMigration.textContent = preview.existingCycleId ? "打开已迁移周期" : "确认迁移并打开周期";
    elements.confirmCaseMigration.disabled = state.loading;
  }

  async function confirmSelectedCaseMigration() {
    const preview = state.caseMigrationPreview;
    if (!preview || state.loading || preview.sourceCaseId !== state.selectedCaseId
      || preview.accountScopeId !== state.accountScopeId) return;
    const id = preview.sourceCaseId, scopeId = state.accountScopeId, token = state.caseMigrationRequestToken;
    await runAction(preview.existingCycleId ? "正在打开已迁移周期…" : "正在保存新的迁移周期…", async () => {
      const result = preview.existingCycleId
        ? { cycle: { id: preview.existingCycleId } }
        : await callReview("migrateCase", { caseId: id, sourceHash: preview.sourceHash, confirmed: true });
      if (!caseMigrationRequestIsCurrent(id, scopeId, token)) return;
      await openCreatedOrderFirstCycle(result);
      if (!caseMigrationRequestIsCurrent(id, scopeId, token)) return;
      clearCaseMigrationPreview();
      showNotice("已打开周期；原案例、封存版本、历史结果及原 Codex 对话均保留。继续分析使用周期的新证据版本。", "success");
    });
  }

  function setCaseStatus(value) {
    const status = String(value || "DRAFT").toUpperCase();
    elements.caseStatus.textContent = status;
    elements.caseStatus.className = `review-state-badge ${statusClass(status)}`;
  }

  function setCaseFormFrozen() {
    elements.caseForm.querySelectorAll("input:not([type='hidden']), textarea").forEach((field) => {
      field.readOnly = true;
      field.disabled = false;
    });
    elements.caseForm.querySelectorAll("select").forEach((field) => { field.disabled = true; });
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
    elements.linkRecords.hidden = true;
    if (!shownRecords.length) {
      elements.brokerMatches.append(emptyNode(
        item ? "此旧案例未取得可展示的关联记录。请预览迁移限制，或从订单证据建立新的周期；这里不会改写关联。" : "请选择历史案例。",
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
      checkbox.disabled = true;
      checkbox.checked = record.linked === true || record.confirmed === true;
      row.append(
        checkbox,
        node("strong", "", String(record.type ?? record.kind ?? "EXECUTION").toUpperCase()),
        node("span", "", `${normalizeSymbol(record.symbol)} · ${String(record.side ?? record.direction ?? "—").toUpperCase()}`),
        node("span", "", `数量 ${formatNumber(record.quantity ?? record.executedQuantity ?? record.qty)}`),
        brokerPriceNode(record),
        node("span", "", formatDateTime(record.executedAt ?? record.doneAt ?? record.submittedAt ?? record.updatedAt ?? record.createdAt)),
      );
      elements.brokerMatches.append(row);
    }
    updateLinkButton();
  }

  function updateLinkButton() {
    elements.linkRecords.disabled = true;
    elements.linkRecords.hidden = true;
  }



  function cancelCaseLinkEdit() {
    const id = state.editingCaseLinkId;
    const cycleLinkId = state.editingCycleLinkId;
    state.editingCaseLinkId = null;
    state.editingCycleLinkId = null;
    state.selectedRecordIds.clear();
    state.selectedRecordCache.clear();
    state.selectedEventId = null;
    state.suggestedEventId = null;
    if (cycleLinkId) {
      state.selectedCycleId = cycleLinkId;
      state.cyclePane = "detail";
      setReviewTab("cycles");
      renderCycles();
    } else {
      state.casePane = "case";
      if (id) state.selectedCaseId = id;
      renderCaseList();
      renderSelectedCase();
    }
    showNotice("已取消订单关联修改；原关联版本保持不变。", "success");
  }

  function handleIntakePrimaryAction(event) {
    if (state.editingCycleLinkId) {
      void saveCycleLinkEdit(event);
      return;
    }
    if (state.editingCaseLinkId) {
      legacyCaseReadOnly(event);
      return;
    }
    void createQuickSingle(event);
  }

  function beginCycleLinkEdit() {
    const item = selectedCycle();
    if (!item || state.loading) return;
    state.editingCycleLinkId = cycleId(item);
    state.editingCaseLinkId = null;
    state.selectedRecordIds.clear();
    state.selectedRecordCache.clear();
    state.selectedEventId = null;
    state.suggestedEventId = null;
    const records = cycleBrokerRecords(item);
    const requestedRecordIds = arrayValue(item?.brokerLinks?.requestedRecordIds);
    const anchorRecordIds = requestedRecordIds.length
      ? requestedRecordIds
      : records.map(brokerRecordId).filter(Boolean);
    for (const requestedId of anchorRecordIds) {
      const record = records.find((candidate) => brokerRecordId(candidate) === requestedId)
        ?? state.snapshot.intake.records.find((candidate) => brokerRecordId(candidate) === requestedId);
      state.selectedRecordIds.add(requestedId);
      if (record) state.selectedRecordCache.set(requestedId, record);
    }
    state.casePane = "intake";
    const symbol = cycleType(item) === "monthly_portfolio" ? "" : cycleSymbols(item)[0] ?? "";
    state.intakeSearch = symbol.toLowerCase();
    elements.intakeSearch.value = symbol;
    setReviewTab("cases");
    renderCaseList();
    renderSelectedCase();
    renderIntake();
    showNotice(
      requestedRecordIds.length
        ? `正在编辑“${cycleTitle(item)}”的订单范围。只预选你上次框选的 ${requestedRecordIds.length} 条记录；系统补齐的父订单和同单成交不会被误算为新锚点。`
        : `正在编辑“${cycleTitle(item)}”的旧版订单范围。该版本没有保留原始框选来源；本次保存会以当前勾选建立明确锚点。`,
      "success",
    );
    void loadIntakePage({ append: false });
  }

  async function saveCycleLinkEdit(event) {
    event?.preventDefault?.();
    const item = state.snapshot.cycles.find((candidate) => cycleId(candidate) === state.editingCycleLinkId);
    const records = selectedIntakeRecords();
    const symbols = selectedIntakeSymbols();
    if (!item || state.loading) return;
    if (!records.length) {
      showNotice("复盘周期必须至少保留一条真实订单或成交。", "warning");
      return;
    }
    const expectedSymbol = cycleType(item) === "monthly_portfolio" ? null : cycleSymbols(item)[0] ?? null;
    if (expectedSymbol && (symbols.length !== 1 || symbols[0] !== expectedSymbol)) {
      showNotice(`只能为 ${expectedSymbol} 选择订单与成交。`, "warning");
      return;
    }
    let saved = false;
    await runAction("正在保存新的周期证据版本…", async () => {
      const result = await callReview("linkCycleRecords", {
        cycleId: cycleId(item),
        recordIds: [...state.selectedRecordIds],
        replace: true,
        reason: "用户重新选择周期订单与成交",
      });
      const resolvedCount = arrayValue(result?.selection?.recordIds).length || records.length;
      state.editingCycleLinkId = null;
      state.selectedRecordIds.clear();
      state.selectedRecordCache.clear();
      state.selectedCycleId = cycleId(item);
      state.cyclePane = "detail";
      await loadSnapshot({ preservePane: true });
      setReviewTab("cycles");
      saved = true;
      showNotice(`周期证据新版本已保存，共 ${resolvedCount} 条订单/成交。旧复盘已标记为历史结果，请重新运行。`, "success");
    });
    if (saved) renderCycles();
  }


  async function syncTradeHistory() {
    if (state.loading) return;
    const days = Number(elements.intakeRange?.value || 180);
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
      const syncMethod = intakeMethod ?? "syncTradeHistory";
      try {
        await callReview(syncMethod, payload);
      } catch (error) {
        const requiresAuthorization = error.code === "LONGBRIDGE_HISTORY_SCOPE_REQUIRED"
          || error.code === "LONGBRIDGE_REAUTH_REQUIRED";
        if (!requiresAuthorization) throw error;
        showNotice(
          error.code === "LONGBRIDGE_HISTORY_SCOPE_REQUIRED"
            ? "旧授权不含订单与成交历史。确认后将只扩展查询权限，并自动重试本次同步。"
            : "长桥授权已过期。确认重新授权后，将自动重试本次同步。",
          "warning",
        );
        const authorization = await api.connectLongbridge({ forceReauthorize: true });
        if (authorization?.cancelled) {
          throw new Error("已取消长桥历史查询重新授权；原有加密缓存保持不变。");
        }
        if (!authorization?.ok || authorization?.authorizationReady === false) {
          throw new Error(authorization?.error || authorization?.status?.detail || "长桥只读重新授权失败。");
        }
        showNotice("只读授权已更新，正在重试原历史范围…", "loading");
        // Exactly one retry. A second scope failure is surfaced to the user
        // and never starts an authorization loop.
        await callReview(syncMethod, payload);
      }
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

  async function capturePortfolioSnapshot() {
    if (state.loading) return;
    await runAction("正在读取长桥并保存组合快照…", async () => {
      const result = await callReview("capturePortfolioSnapshot", {
        note: "用户在复盘工作台手动保存组合观察快照",
      });
      if (result?.reviewSnapshot) {
        applyActionReviewSnapshot(result.reviewSnapshot);
      } else {
        await loadSnapshot({ preservePane: true });
      }
      showNotice("组合快照已写入本机加密追加式账本；历史记录不会被覆盖。", "success");
    });
  }

  async function toggleSnapshotBackgroundCapture() {
    if (state.loading) return;
    const currentlyEnabled = state.snapshot.portfolioSnapshots
      ?.backgroundCapture?.preferences?.enabled === true;
    const nextEnabled = !currentlyEnabled;
    await runAction(nextEnabled ? "正在开启无人值守采集…" : "正在关闭无人值守采集…", async () => {
      const result = await callReview("setSnapshotBackgroundPreferences", {
        enabled: nextEnabled,
        launchAtLogin: nextEnabled,
        notifyOnMissedCapture: nextEnabled,
      });
      if (result?.snapshot) {
        applyActionReviewSnapshot(result.snapshot);
      } else {
        await loadSnapshot({ preservePane: true });
      }
      showNotice(
        nextEnabled
          ? "无人值守采集已开启：关闭窗口仍在后台运行，登录后隐藏启动；设备关机期间不会伪造历史。"
          : "无人值守采集已关闭；既有加密快照和缺口记录不会删除。",
        "success",
      );
    });
  }

  async function exportTrustedBackup() {
    if (state.loading || state.archiveLedgerBusy) return;
    await runAction("正在生成本机加密恢复包…", async () => {
      const method = api?.review?.exportTrustedBackup;
      if (typeof method !== "function") throw new Error("本机恢复包导出接口尚未就绪。");
      const result = await method();
      if (result?.canceled) {
        showNotice("已取消导出；本机业务数据未改变。", "warning");
        return;
      }
      if (result?.ok === false) throw new Error(result.error || result.message || "本机恢复包导出失败。");
      const fileCount = Number(result?.fileCount ?? 0);
      const location = String(result?.path ?? "").trim();
      showNotice(
        `${result?.idempotent ? "相同恢复包已存在" : "本机恢复包已导出"}${fileCount ? ` · ${fileCount} 个加密业务文件` : ""}${location ? ` · ${location}` : ""}。应用索引与最近结果按清单保存；不含登录凭证或 Codex 外部完整对话，只能用同一 macOS 钥匙串身份恢复。`,
        "success",
      );
    });
  }

  async function restoreTrustedBackup() {
    if (state.loading || state.archiveLedgerBusy) return;
    await runAction("正在预检本机恢复包…", async () => {
      const method = api?.review?.restoreTrustedBackup;
      if (typeof method !== "function") throw new Error("本机恢复包恢复接口尚未就绪。");
      const result = await method();
      if (result?.canceled) {
        showNotice("已取消恢复；当前本机业务数据保持不变。", "warning");
        return;
      }
      if (result?.ok === false) throw new Error(result.error || result.message || "本机恢复包恢复失败。");
      if (result?.unchanged) {
        showNotice("恢复包覆盖的业务数据与当前一致，无需替换或重新启动；旧版包未包含的应用索引和本机后台、账户校验设置保持不变。", "success");
        return;
      }
      if (result?.restarting) {
        showNotice("业务数据已按确认清单恢复，应用正在重新启动。本机后台、登录启动和账户校验设置保留；Codex 完整对话仍依赖原服务。", "success");
        return;
      }
      showNotice("业务数据已按确认清单恢复；本机后台、登录启动和账户校验设置保留。应用索引不等于 Codex 外部完整对话档案。", "success");
    });
  }

  function setArchiveLedgerStatus(message, tone = "info") {
    if (!elements.archiveLedgerStatus) return;
    elements.archiveLedgerStatus.hidden = !message;
    elements.archiveLedgerStatus.textContent = message;
    elements.archiveLedgerStatus.dataset.tone = tone;
  }

  function updateArchiveLedgerControls() {
    const busy = state.loading || state.archiveLedgerBusy;
    for (const form of elements.archiveLedgerForms) {
      for (const control of form.querySelectorAll("input, button")) control.disabled = busy;
    }
    elements.archiveLedger?.setAttribute("aria-busy", String(state.archiveLedgerBusy));
    if (elements.exportBackup) elements.exportBackup.disabled = busy;
    if (elements.restoreBackup) elements.restoreBackup.disabled = busy;
  }

  async function archiveLedger(event) {
    event.preventDefault();
    if (state.loading || state.archiveLedgerBusy) return;
    const form = event.currentTarget;
    const kind = form?.dataset.ledgerArchiveKind;
    const input = form?.querySelector("[name='retainActiveCount']");
    const rawCount = String(input?.value ?? "").trim();
    const retainActiveCount = Number(rawCount);
    if (!["portfolio", "radar"].includes(kind) || !/^\d+$/.test(rawCount)
      || !Number.isSafeInteger(retainActiveCount) || retainActiveCount < 1) {
      setArchiveLedgerStatus("保留条数须为大于或等于 1 的整数；尚未开始归档预览。", "error");
      input?.focus();
      return;
    }
    const label = kind === "portfolio" ? "组合快照" : "技术雷达";
    state.archiveLedgerBusy = true;
    updateArchiveLedgerControls();
    setArchiveLedgerStatus(`正在预检${label}的本机存储，请在系统窗口查看预览并确认…`);
    try {
      if (typeof api?.reviewArchiveLedger !== "function") throw new Error("历史存储整理接口尚未就绪。");
      const result = await api.reviewArchiveLedger({ kind, retainActiveCount });
      if (result?.canceled === true) {
        setArchiveLedgerStatus("已取消归档；本机记录保持不变。");
        return;
      }
      if (result?.ok !== true) throw new Error(result?.error || result?.message || "未取得明确的归档结果。");
      if (result.archived === false) {
        setArchiveLedgerStatus(result.message || `${label}无需归档：当前追加区未超过保留条数，记录保持不变。`);
        return;
      }
      const counts = [result.archiveCount, result.activeCount, result.archivedCount, result.totalCount];
      if (result.archived !== true || result.kind !== kind
        || !counts.every((count) => Number.isSafeInteger(count) && count >= 0)
        || result.archiveCount < 1 || result.archiveCount > result.archivedCount
        || result.activeCount + result.archivedCount !== result.totalCount) {
        throw new Error("归档返回信息不完整，请查看系统状态后再确认；未将本次操作标记为成功。");
      }
      setArchiveLedgerStatus(`${label}已整理：本次归档 ${result.archiveCount} 条，当前追加区 ${result.activeCount} 条，累计历史 ${result.archivedCount} 条，共 ${result.totalCount} 条。未删除记录，历史仍可查询并随恢复包保留。`, "success");
    } catch (error) {
      setArchiveLedgerStatus(`归档未确认：${error.message || "操作失败，请稍后检查。"}`, "error");
    } finally {
      state.archiveLedgerBusy = false;
      updateArchiveLedgerControls();
    }
  }

  function renderIntake() {
    const intake = state.snapshot.intake;
    const excludedCount = Number(intake.excludedOrderAudit?.totalCount ?? 0)
      + Number(intake.excludedExecutionAudit?.totalCount ?? 0);
    const brokerCounts = `${formatNumber(intake.eligibleOrderCount, 0)} 笔已成交订单 · ${formatNumber(intake.eligibleExecutionCount, 0)} 笔可核验成交${excludedCount ? ` · ${formatNumber(excludedCount, 0)} 条仅审计` : ""}`;
    elements.intakeStatus.textContent = intake.syncedAt
      ? `${brokerCounts} · ${formatDateTime(intake.syncedAt)}`
      : "尚未同步";
    const auditOption = [...(elements.intakeKind?.options ?? [])]
      .find((option) => option.value === "audit_record");
    if (auditOption) auditOption.textContent = `审计：已排除记录（${formatNumber(excludedCount, 0)}）`;
    if (elements.intakeCoverage) {
      const backfill = intake.parentOrderBackfill;
      const recovered = Number(backfill?.recoveredOrderCount ?? 0);
      const failed = Number(backfill?.failedOrderCount ?? 0);
      const deferred = Number(backfill?.deferredOrderCount ?? 0);
      elements.intakeCoverage.textContent = !intake.syncedAt
        ? "尚未同步历史；订单与成交覆盖不可判断。"
        : backfill
          ? `父订单回补：发现 ${formatNumber(backfill.discoveredOrderCount, 0)} 个缺口，恢复 ${formatNumber(recovered, 0)} 个${failed || deferred ? `，仍有 ${formatNumber(failed + deferred, 0)} 个降级` : "，当前无遗留缺口"}。未恢复记录不会猜测方向、币种或成交价。`
          : intake.warnings.length
            ? "历史存在降级项；请先核对同步提示，未核验成交不会进入 P&L。"
            : "订单与成交已同步；未发现需要披露的父订单回补缺口。";
      elements.intakeCoverage.classList.toggle("complete", Boolean(intake.syncedAt)
        && (backfill ? failed + deferred === 0 : intake.warnings.length === 0));
      elements.intakeCoverage.title = intake.warnings.join("\n");
    }
    renderIntakeRecords();
    renderIntakePagination();
    renderEventCandidates();
    renderDerivedContext();
    renderOrderFirstEntry();
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
      const auditOnly = record?.reviewEligibility?.status === "audit_only";
      checkbox.disabled = !id || auditOnly || state.loading || state.intakePageLoading;
      label.append(
        checkbox,
        node("span", "review-record-time", `${formatShortDateTime(brokerRecordAt(record))}\n${type === "order" ? "订单" : "成交"}`),
        node("strong", "", symbol || "—"),
        node("span", "", `${String(record.side ?? record.direction ?? "—").toUpperCase()}\n${String(record.status ?? (type === "execution" ? "FILLED" : "—")).toUpperCase()}`),
        node("span", "", formatNumber(record.quantity ?? record.executedQuantity ?? record.qty)),
        brokerPriceNode(record),
      );
      if (linked) label.title = "此记录曾关联历史案例；旧关联只读保留。可显式迁移原案例，或选择订单建立新周期。";
      else if (auditOnly) label.title = `${brokerAuditReasonText(record)}；仅供审计查看，不能纳入复盘证据。`;
      elements.intakeRecords.append(label);
    }
    updateIntakeSelectionSummary();
  }

  function filteredIntakeRecords() {
    const source = state.editingCaseLinkId || state.editingCycleLinkId
      ? [...new Map([
        ...state.selectedRecordCache.values(),
        ...state.snapshot.intake.records,
      ].map((record) => [brokerRecordId(record), record])).values()]
      : state.snapshot.intake.records;
    return source.filter((record) => {
      const auditOnly = record?.reviewEligibility?.status === "audit_only";
      if (state.intakeKind === "audit_record") return auditOnly;
      if (auditOnly) return false;
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
    const requestScope = state.accountScopeId;
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
        includeExcludedOrders: state.intakeKind === "audit_record",
      });
      if (token !== state.intakePageToken) return;
      if (requestScope !== state.accountScopeId
        || (Object.prototype.hasOwnProperty.call(result ?? {}, "accountScopeId")
          && result.accountScopeId !== state.accountScopeId)) return;
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
      if (!append) void preloadRecentEventsForNarrowedIntake();
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
    // A changed evidence set invalidates the user's previous event consent.
    // The closest event may still be suggested, but must be explicitly chosen.
    state.selectedEventId = null;
    state.suggestedEventId = null;
    reconcileSelectedEvent();
    renderIntakeRecords();
    renderEventCandidates();
    renderDerivedContext();
    scheduleEventLookupForSelection();
    updateCycleLinkButton();
    renderOrderFirstEntry();
  }

  function clearIntakeSelection() {
    if (state.eventLookupTimer) clearTimeout(state.eventLookupTimer);
    state.eventLookupTimer = null;
    state.eventLookupToken += 1;
    state.eventLookupLoading = false;
    state.selectedRecordIds.clear();
    state.selectedRecordCache.clear();
    state.selectedEventId = null;
    state.suggestedEventId = null;
    state.eventLookupMessage = "";
    renderIntakeRecords();
    renderEventCandidates();
    renderDerivedContext();
    updateCycleLinkButton();
    renderOrderFirstEntry();
  }

  function scheduleEventLookupForSelection() {
    if (state.eventLookupTimer) clearTimeout(state.eventLookupTimer);
    state.eventLookupTimer = setTimeout(() => {
      state.eventLookupTimer = null;
      void lookupEventCandidatesForSelection();
    }, EVENT_LOOKUP_DEBOUNCE_MS);
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
      ? `${state.editingCaseLinkId || state.editingCycleLinkId ? "待保存" : "已选择"} ${selected.length} 条 · ${symbols.join(" + ")} · ${formatDateRange(selected.map(brokerRecordAt))}`
      : "尚未选择记录";
    elements.intakeClear.disabled = !selected.length || state.loading;
    elements.intakeCancelLinkEdit.hidden = !state.editingCaseLinkId && !state.editingCycleLinkId;
    updateCycleLinkButton();
  }

  async function preloadRecentEventsForNarrowedIntake() {
    const method = firstReviewMethod(["preloadRecentEventCandidates"]);
    const query = state.intakeSearch.trim().toUpperCase();
    const symbols = [...new Set(state.snapshot.intake.records.map(brokerSymbol).filter(Boolean))];
    const symbol = symbols.length === 1 ? symbols[0] : null;
    const exactSymbolQuery = symbol && (query === symbol || query === symbol.split(".")[0]);
    if (!method || !exactSymbolQuery) {
      if (!selectedIntakeRecords().length) {
        state.prefetchedEventSymbol = null;
        state.recentEventRequestKey = "";
        state.recentEventLoading = false;
        renderEventCandidates();
      }
      return;
    }
    const requestKey = `${symbol}:recent-240d`;
    state.prefetchedEventSymbol = symbol;
    state.recentEventRequestKey = requestKey;
    const cachedRequest = state.recentEventRequests.get(requestKey);
    if (cachedRequest?.status === "in_flight") {
      state.recentEventLoading = true;
      renderEventCandidates();
      return;
    }
    if (recentEventRequestIsFresh(cachedRequest)) {
      mergeRecentEventCandidates(cachedRequest.candidates);
      state.recentEventLoading = false;
      state.eventLookupMessage = cachedRequest.message;
      renderQuarterFilter();
      renderEventCandidates();
      renderDerivedContext();
      return;
    }
    const requestToken = ++state.recentEventRequestToken;
    state.recentEventRequests.set(requestKey, {
      status: "in_flight",
      requestToken,
      startedAt: Date.now(),
      candidates: arrayValue(cachedRequest?.candidates),
      message: "",
    });
    state.recentEventLoading = true;
    state.eventLookupMessage = "";
    renderEventCandidates();
    try {
      const result = await callReview(method, { symbols: [symbol] });
      const activeRequest = state.recentEventRequests.get(requestKey);
      if (activeRequest?.requestToken !== requestToken) return;
      const source = result?.data ?? result ?? {};
      const candidates = arrayValue(source.eventCandidates, source.events);
      const message = String(source.message ?? "");
      mergeRecentEventCandidates(candidates);
      state.recentEventRequests.set(requestKey, {
        status: "success",
        requestToken,
        completedAt: Date.now(),
        candidates,
        message,
      });
      if (state.recentEventRequestKey === requestKey) {
        state.eventLookupMessage = message;
        renderQuarterFilter();
      }
    } catch (error) {
      const activeRequest = state.recentEventRequests.get(requestKey);
      if (activeRequest?.requestToken !== requestToken) return;
      const message = `${error.message || "最近财报日预取失败。"} 可点击“重试财报日期”再次查询。`;
      state.recentEventRequests.set(requestKey, {
        status: "failed",
        requestToken,
        completedAt: Date.now(),
        candidates: arrayValue(activeRequest.candidates),
        message,
      });
      if (state.recentEventRequestKey === requestKey) state.eventLookupMessage = message;
    } finally {
      if (state.recentEventRequestKey === requestKey) {
        state.recentEventLoading = state.recentEventRequests.get(requestKey)?.status === "in_flight";
        renderEventCandidates();
        renderDerivedContext();
      }
    }
  }

  function recentEventRequestIsFresh(request, now = Date.now()) {
    const completedAt = Number(request?.completedAt);
    return request?.status === "success"
      && Number.isFinite(completedAt)
      && now - completedAt >= 0
      && now - completedAt < RECENT_EVENT_CACHE_FRESH_MS;
  }

  function mergeRecentEventCandidates(candidates) {
    state.snapshot.intake.eventCandidates = [...new Map([
      ...state.snapshot.intake.eventCandidates,
      ...arrayValue(candidates),
    ].filter((item) => eventCandidateId(item)).map((item) => [eventCandidateId(item), item])).values()];
  }

  function recentEventRequestForPreview() {
    if (!state.prefetchedEventSymbol) return null;
    return state.recentEventRequests.get(`${state.prefetchedEventSymbol}:recent-240d`) ?? null;
  }

  function recentEventRetryButton() {
    const button = actionButton("重试财报日期", "secondary");
    button.addEventListener("click", () => void preloadRecentEventsForNarrowedIntake());
    return button;
  }

  function renderEventCandidates() {
    const selected = selectedIntakeRecords();
    const candidates = eventCandidatesForSelection();
    const previewRequest = recentEventRequestForPreview();
    const previewFailed = previewRequest?.status === "failed";
    elements.eventCandidates.replaceChildren();
    if (!selected.length) {
      if (state.recentEventLoading && state.prefetchedEventSymbol && !candidates.length) {
        elements.eventMatchStatus.textContent = `正在预取 ${state.prefetchedEventSymbol}`;
        elements.eventCandidates.append(emptyNode("正在后台读取近 240 天、最多 3 次财报；订单列表仍可继续使用。", true));
        return;
      }
      if (previewFailed) {
        elements.eventMatchStatus.textContent = `${state.prefetchedEventSymbol} · 财报日期更新失败`;
        elements.eventCandidates.append(
          emptyNode(previewRequest.message || "最近财报日预取失败，可立即重试。", true),
          recentEventRetryButton(),
        );
        if (!candidates.length) return;
      }
      if (!state.prefetchedEventSymbol || !candidates.length) {
        elements.eventMatchStatus.textContent = "等待选择标的";
        elements.eventCandidates.append(emptyNode(
          state.eventLookupMessage || "从左侧选择一个标的，系统会先显示最近 2–3 次财报；再勾选订单确认具体决策包。",
          true,
        ));
        return;
      }
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
    elements.eventMatchStatus.textContent = selected.length
      ? `${candidates.length} 个候选`
      : `${state.prefetchedEventSymbol} · 最近 ${candidates.length} 次${state.recentEventLoading ? " · 更新中" : ""}${previewFailed ? " · 更新失败，可重试" : ""}`;
    for (const candidate of candidates) {
      const id = eventCandidateId(candidate);
      const suggested = id === state.suggestedEventId && id !== state.selectedEventId;
      const label = node("label", `review-event-option${id === state.selectedEventId ? " active" : ""}${suggested ? " suggested" : ""}`);
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "review-earnings-event";
      radio.value = id;
      radio.checked = id === state.selectedEventId;
      radio.disabled = state.loading || !selected.length;
      label.append(
        radio,
        node("strong", "", `${eventPeriod(candidate)} · ${eventSessionLabel(candidate)}`),
        node("span", "", formatDateTime(eventAt(candidate))),
        node("small", "", selected.length
          ? `${suggested ? "系统建议 · 请点击确认 · " : ""}${eventDistanceLabel(candidate, selected)}`
          : "已缓存 · 选择订单后显示建议"),
      );
      elements.eventCandidates.append(label);
    }
  }

  function handleEventSelection(event) {
    const radio = event.target.closest("input[name='review-earnings-event']");
    if (!radio) return;
    state.selectedEventId = radio.value;
    state.suggestedEventId = radio.value;
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
    const suggested = eventCandidatesForSelection()
      .find((item) => eventCandidateId(item) === state.suggestedEventId) ?? null;
    elements.derivedContext.replaceChildren();
    if (!records.length) {
      elements.createFromRecords.disabled = true;
      return;
    }
    elements.derivedContext.append(
      metricCell("相关标的", selectedIntakeSymbols().join(" + ") || "—"),
      metricCell("订单 / 成交", `${records.filter((item) => brokerRecordType(item) === "order").length} / ${records.filter((item) => brokerRecordType(item) === "execution").length}`),
      metricCell("交易时间", formatDateRange(records.map(brokerRecordAt))),
      metricCell("财报季度", candidate ? eventPeriod(candidate) : suggested ? `${eventPeriod(suggested)}（建议待确认）` : "待确认"),
      metricCell("财报时间", candidate ? formatDateTime(eventAt(candidate)) : suggested ? `${formatDateTime(eventAt(suggested))}（请确认）` : "待确认"),
    );
    elements.createFromRecords.disabled = !candidate || state.loading || Boolean(state.editingCycleLinkId);
  }

  function createEarningsCycleFromRecords() {
    const records = selectedIntakeRecords();
    const candidate = selectedEventCandidate();
    if (!records.length || !candidate || state.loading || state.editingCycleLinkId) return;
    openOrderFirstNoteDialog({
      flow: "earnings",
      recordIds: records.map(brokerRecordId),
      eventCandidateId: eventCandidateId(candidate),
      reviewMode: "lightweight",
      benchmark: "QQQ.US",
    }, `${eventSymbol(candidate)} · ${eventPeriod(candidate)} · ${records.length} 条所选记录。日期与事件由宿主核验；你的三段记录作为事后信息保存。`);
  }

  function reconcileSelectedEvent() {
    if (!selectedIntakeRecords().length) {
      state.selectedEventId = null;
      state.suggestedEventId = null;
      return;
    }
    const candidates = eventCandidatesForSelection();
    if (!candidates.some((item) => eventCandidateId(item) === state.selectedEventId)) {
      state.selectedEventId = null;
    }
    const closest = closestEventCandidate(candidates, selectedIntakeRecords());
    state.suggestedEventId = closest ? eventCandidateId(closest) : null;
  }

  function eventCandidatesForSelection() {
    const records = selectedIntakeRecords();
    const selectedSymbols = selectedIntakeSymbols();
    const symbols = new Set(selectedSymbols.length
      ? selectedSymbols
      : state.prefetchedEventSymbol ? [state.prefetchedEventSymbol] : []);
    if (!symbols.size) return [];
    const candidates = state.snapshot.intake.eventCandidates
      .filter((item) => symbols.has(eventSymbol(item)))
      .filter((item) => records.length || (
        timestamp(eventAt(item)) <= Date.now()
        && timestamp(eventAt(item)) >= Date.now() - RECENT_EARNINGS_PREVIEW_MS
      ));
    return (records.length
      ? candidates.sort((left, right) => Math.abs(eventDistanceMs(left, records)) - Math.abs(eventDistanceMs(right, records)))
      : candidates.sort((left, right) => timestamp(eventAt(right)) - timestamp(eventAt(left))))
      .slice(0, 3);
  }

  function selectedEventCandidate() {
    return eventCandidatesForSelection().find((item) => eventCandidateId(item) === state.selectedEventId) ?? null;
  }

  function prepareCaseAnalysis() {
    legacyCaseReadOnly();
  }

  function prepareBatchAnalysis() {
    showCycleWelcome();
    showNotice("组合复盘请创建明确范围的周期，例如整月组合。旧财报案例只读保留；需要继续时请逐个预览迁移，不会批量静默迁移，也不会再发送旧案例分析。", "warning");
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
        metricCell("净R", signedR(checkpoint.netR ?? checkpoint.rMultiple)),
        metricCell("标的收益", signedPercent(checkpoint.assetReturnPercent ?? checkpoint.returnPercent)),
        metricCell("相对基准", signedPercent(checkpoint.relativeReturnPercent)),
        metricCell("MAE / MFE", `${signedR(checkpoint.maeR)} / ${signedR(checkpoint.mfeR)}`),
      );
      elements.checkpoints.append(row);
    }
  }

  async function openLearningProposal(detail) {
    const proposal = detail?.proposal;
    if (!proposal?.hypothesis || !proposal?.testDesign || !proposal?.candidateRule) return;
    state.pendingLearningProposal = {
      runId: String(detail?.runId ?? ""),
      reviewCycleId: String(detail?.reviewCycleId ?? detail?.cycleId ?? ""),
      threadId: String(detail?.threadId ?? ""),
      proposal,
      rendered: false,
    };
    await setWorkspace("review");
    setReviewTab("tests");
    renderLearningProposal();
    showNotice("Agent 验证草案已打开。核对后可一次性登记测试与候选规则。", "success");
  }

  function renderLearningProposal() {
    const draft = state.pendingLearningProposal;
    elements.learningProposal.hidden = !draft;
    if (!draft) return;
    const proposal = draft.proposal;
    const test = proposal.testDesign ?? {};
    const rule = proposal.candidateRule ?? {};
    elements.learningConfidence.textContent = `置信度 ${String(proposal.confidence ?? "unknown").toUpperCase()}`;
    if (!draft.rendered) {
      elements.learningHypothesis.value = proposal.hypothesis ?? "";
      elements.learningEvidence.value = proposal.evidenceSummary ?? "";
      setSelectValue(elements.learningMetric, deterministicMetricValue(test.metric) ?? "net_r");
      elements.learningWindow.value = test.window ?? "";
      elements.learningMinCases.value = String(test.minCases ?? 20);
      elements.learningInclusion.value = test.inclusion ?? "";
      elements.learningExclusion.value = test.exclusion ?? "";
      elements.learningSuccess.value = test.successCriteria ?? "";
      setSelectValue(elements.learningSuccessOperator, successOperatorValue(test.successOperator) ?? "gt");
      elements.learningSuccessThreshold.value = valueOrEmpty(test.successThreshold);
      elements.learningRuleTitle.value = rule.title ?? "";
      elements.learningRuleAction.value = rule.action ?? "";
      elements.learningRuleInvalidation.value = rule.invalidation ?? "";
      elements.learningRuleScope.value = rule.scope ?? "";
      draft.rendered = true;
    }
    elements.learningAccept.disabled = state.loading;
    elements.learningDismiss.disabled = state.loading;
  }

  async function acceptLearningProposal() {
    const draft = state.pendingLearningProposal;
    if (!draft || state.loading) return;
    if (!deterministicMetricValue(elements.learningMetric.value)
      || !successOperatorValue(elements.learningSuccessOperator.value)
      || elements.learningSuccessThreshold.value === ""
      || !Number.isFinite(Number(elements.learningSuccessThreshold.value))) {
      showNotice("请确认受支持主指标、成功比较符与数值门槛；最终通过结论将由宿主计算。", "warning");
      return;
    }
    let accepted = false;
    const proposal = learningProposalFromEditor(draft.proposal);
    await runAction("正在登记 AI 验证方案…", async () => {
      await callReview("acceptLearningProposal", {
        proposal,
        reviewCycleId: draft.reviewCycleId || null,
        runId: draft.runId || null,
        confirmed: true,
      });
      state.pendingLearningProposal = null;
      accepted = true;
      await loadSnapshot({ preservePane: true });
      showNotice("验证已开始观察。后续完成的复盘会出现在候选区；只有你确认后才会纳入。", "success");
    });
    if (accepted) renderLearningProposal();
  }

  function learningProposalFromEditor(original) {
    return {
      ...original,
      hypothesis: elements.learningHypothesis.value.trim(),
      evidenceSummary: elements.learningEvidence.value.trim(),
      testDesign: {
        ...(original?.testDesign ?? {}),
        metric: elements.learningMetric.value.trim(),
        window: elements.learningWindow.value.trim(),
        minCases: Number(elements.learningMinCases.value || 0),
        inclusion: elements.learningInclusion.value.trim(),
        exclusion: elements.learningExclusion.value.trim(),
        successCriteria: elements.learningSuccess.value.trim(),
        successOperator: elements.learningSuccessOperator.value,
        successThreshold: Number(elements.learningSuccessThreshold.value),
      },
      candidateRule: {
        ...(original?.candidateRule ?? {}),
        title: elements.learningRuleTitle.value.trim(),
        action: elements.learningRuleAction.value.trim(),
        invalidation: elements.learningRuleInvalidation.value.trim(),
        scope: elements.learningRuleScope.value.trim(),
      },
    };
  }

  function dismissLearningProposal() {
    state.pendingLearningProposal = null;
    renderLearningProposal();
    showNotice("已暂存于 Agent 对话结果，本次不登记到验证中心。", "success");
  }


  async function completeTest(testId, button) {
    if (!testId || state.loading) return;
    const card = button.closest("[data-test-card-id]");
    const test = state.snapshot.tests.find((item) => String(item?.id ?? "") === String(testId));
    const protocol = isProtocolTest(test);
    const censored = card?.querySelector("[data-test-censored]")?.checked === true;
    const outcomeValue = card?.querySelector("[data-test-outcome-r]")?.value ?? "";
    const benchmarkValue = card?.querySelector("[data-test-benchmark-return]")?.value ?? "";
    const reviewCycleId = card?.querySelector("[data-test-review-cycle]")?.value ?? "";
    const outcomeR = outcomeValue === "" ? null : Number(outcomeValue);
    if (protocol && !reviewCycleId) {
      showNotice("请选择一个已完成、且不是假设来源本身的复盘周期。", "warning");
      return;
    }
    const selectedCandidate = protocol
      ? validationCandidateCycles(test).find((cycle) => cycleId(cycle) === reviewCycleId) ?? null
      : null;
    const verifiedMethod = selectedCandidate?.validationCandidate?.timing === "forward" && !censored
      ? firstReviewMethod(["recordVerifiedProtocolSample", "verifyProtocolSample"])
      : null;
    if (!verifiedMethod && !censored && !Number.isFinite(outcomeR)) {
      showNotice("历史校准或人工观察需要填写有效的净R；前向候选会由宿主从已持久化结果中核验，不能手填冒充。", "warning");
      return;
    }
    button.disabled = true;
    await runAction(verifiedMethod ? "正在核验前向样本…" : "正在追加观察样本…", async () => {
      if (verifiedMethod) {
        // Only identifiers cross the renderer boundary. The host resolves R,
        // evidence revision, run hash and timing from its durable stores.
        await callReview(verifiedMethod, {
          testId,
          reviewCycleId,
          confirmed: true,
        });
      } else {
        await callReview("completeTest", {
          testId,
          reviewCycleId: reviewCycleId || null,
          outcomeR,
          benchmarkReturnPercent: benchmarkValue === "" ? null : Number(benchmarkValue),
          outcomeSource: "manual",
          notes: card?.querySelector("[data-test-result-notes]")?.value?.trim() ?? "",
          censored,
        });
      }
      clearValidationObservationDraft(testId);
      await loadSnapshot();
      showNotice(verifiedMethod
        ? "宿主已从持久化证据核验并追加前向样本；达到门槛后只进入待你决策，不会自动晋级。"
        : "已追加一条不可变人工/校准观察；它不会推进正式验证门槛。", "success");
    });
  }

  async function evaluateProtocol(button) {
    const testId = button?.dataset?.evaluateProtocolId;
    if (!testId || state.loading) return;
    await runAction("正在按冻结协议计算正式样本…", async () => {
      const result = await callReview("evaluateProtocol", { testId, confirmed: true });
      await loadSnapshot({ preservePane: true });
      const evaluation = result?.experiment?.protocolEvaluation;
      showNotice(
        evaluation?.passed
          ? `确定性评估已完成：观察值 ${formatProtocolValue(evaluation.primaryMetric, evaluation.observedValue)}，达到冻结门槛。仍需你决定是否采用。`
          : `确定性评估已完成：观察值 ${formatProtocolValue(evaluation?.primaryMetric, evaluation?.observedValue)}，未达到冻结门槛。`,
        evaluation?.passed ? "success" : "warning",
      );
    });
  }

  function validationDraftKey(test) {
    if (!state.accountScopeId || !test?.id) return null;
    // Older protocols lack an explicit revision. Their frozen specification
    // forms the revision identity; sample counts/status are deliberately absent.
    const revision = test.protocolRevision ?? test.protocolSpecHash ?? JSON.stringify({
      registeredAt: test.registeredAt ?? test.createdAt ?? null,
      primaryMetric: test.primaryMetric,
      primaryHorizon: test.primaryHorizon,
      successOperator: test.successOperator,
      successThreshold: test.successThreshold,
      minimumCases: test.minimumCases,
      cohort: test.cohort,
      exclusions: test.exclusions,
      successCriteria: test.successCriteria,
      sourceEvidenceRevision: test.sourceEvidenceRevision,
      sourceRetrospectiveVersion: test.sourceRetrospectiveVersion,
      sourceStatus: test.sourceStatus,
    });
    return JSON.stringify([state.accountScopeId, String(test.id), revision]);
  }

  function validationFieldKey(field) {
    return field.getAttributeNames().find((name) => (
      name.startsWith("data-test-") || name.startsWith("data-v2-")
    )) ?? null;
  }

  function rememberValidationDrafts() {
    for (const card of elements.testList.querySelectorAll("[data-validation-draft-key]")) {
      const key = card.dataset.validationDraftKey;
      if (!key) continue;
      const fields = {};
      for (const field of card.querySelectorAll("input, textarea, select")) {
        const fieldKey = validationFieldKey(field);
        if (fieldKey) fields[fieldKey] = field.type === "checkbox" ? field.checked : field.value;
      }
      state.validationDrafts.set(key, {
        fields,
        versionOpen: card.querySelector(".review-validation-v2")?.open === true,
      });
    }
  }

  function restoreValidationDraft(card, test) {
    const key = validationDraftKey(test);
    if (!key) return;
    card.dataset.validationDraftKey = key;
    const draft = state.validationDrafts.get(key);
    if (!draft) return;
    for (const field of card.querySelectorAll("input, textarea, select")) {
      const fieldKey = validationFieldKey(field);
      if (!fieldKey || !Object.prototype.hasOwnProperty.call(draft.fields, fieldKey)) continue;
      const value = draft.fields[fieldKey];
      if (field.type === "checkbox") field.checked = value === true;
      else if (field.tagName !== "SELECT" || [...field.options].some((option) => option.value === value)) field.value = value;
    }
    const version = card.querySelector(".review-validation-v2");
    if (version) version.open = draft.versionOpen;
  }

  function clearValidationObservationDraft(testId) {
    const card = [...elements.testList.querySelectorAll("[data-test-card-id]")]
      .find((item) => item.dataset.testCardId === String(testId));
    if (!card) return;
    for (const field of card.querySelectorAll(".review-test-result-form input, .review-test-result-form textarea, .review-test-result-form select")) {
      if (field.type === "checkbox") field.checked = false;
      else if (field.hasAttribute("data-test-outcome-source")) field.value = "manual";
      else field.value = "";
    }
    rememberValidationDrafts();
  }

  function forgetValidationDraft(testId) {
    for (const card of elements.testList.querySelectorAll("[data-test-card-id]")) {
      if (card.dataset.testCardId !== String(testId)) continue;
      state.validationDrafts.delete(card.dataset.validationDraftKey);
      delete card.dataset.validationDraftKey;
    }
  }

  function renderTests() {
    rememberValidationDrafts();
    const focused = document.activeElement;
    const focusedTest = focused?.closest?.("[data-test-card-id]")?.dataset.testCardId;
    const focusedField = focused && focusedTest ? validationFieldKey(focused) : null;
    const selection = focusedField && typeof focused.selectionStart === "number"
      ? [focused.selectionStart, focused.selectionEnd] : null;
    elements.testList.replaceChildren();
    elements.archivedTestList?.replaceChildren();
    const activeTests = state.snapshot.tests.filter((item) => String(item?.status ?? "").toLowerCase() !== "retired");
    const archivedTests = state.snapshot.tests.filter((item) => String(item?.status ?? "").toLowerCase() === "retired");
    if (!activeTests.length) {
      elements.testList.append(emptyNode("还没有测试。\n从重复出现的复盘结论中登记一个可证伪假设。"));
    }
    for (const item of activeTests) {
      const rawStatus = String(item.status ?? "REGISTERED").toUpperCase();
      const status = rawStatus === "DECISION_DUE" ? "待你决策"
        : rawStatus === "COLLECTING" ? "观察中"
          : rawStatus === "RETIRED" ? "已退役"
            : rawStatus;
      const article = node("article");
      article.classList.add("review-validation-card");
      article.dataset.testCardId = String(item.id ?? item.testId ?? "");
      const header = node("div", "review-item-head");
      header.append(
        node("h3", "", item.title ?? truncate(item.hypothesis, 90) ?? "未命名测试"),
        badge(status),
      );
      const details = node("dl");
      appendDefinition(details, "假设", item.hypothesis ?? "—");
      appendDefinition(details, "主指标", item.metricSpec ?? item.primaryMetric ?? item.metric ?? "—");
      appendDefinition(details, "主窗口", item.windowSpec ?? horizonLabel(item.primaryHorizon ?? item.primaryWindow ?? item.window));
      const protocol = isProtocolTest(item);
      const samples = protocol ? arrayValue(item.samples) : [];
      const linkedRule = state.snapshot.rules.find((rule) => String(rule.id ?? "") === String(item.ruleId ?? ""));
      const metrics = linkedRule ? state.snapshot.ruleMetrics[String(linkedRule.id ?? "")] : null;
      const linkedValidSampleCount = formalProtocolSampleCount(item);
      const unlinkedObservationCount = samples.filter((sample) => (
        sample?.censored !== true && !sample?.reviewCycleId && !sample?.caseId && !item.caseId
      )).length;
      const censoredSampleCount = samples.filter((sample) => sample?.censored === true).length;
      const calibrationSampleCount = samples.filter((sample) => (
        ["historical", "overlapping"].includes(String(sample?.observationTiming ?? ""))
      )).length;
      const manualObservationCount = samples.filter((sample) => (
        sample?.censored !== true && sample?.outcomeVerified !== true
      )).length;
      const decisionTarget = Math.max(20, Number(item.decisionSampleTarget ?? item.minimumCases ?? 20));
      const evaluationMinimum = Math.max(20, Number(item.minimumCases ?? 20));
      const protocolLockReason = protocol ? deterministicProtocolLockReason(item) : null;
      const protocolEvaluation = item.protocolEvaluation ?? null;
      if (protocol) {
        appendDefinition(details, "机器成功门槛", protocolLockReason
          ? `${protocolLockReason} · 已锁定，请创建 v2`
          : `${metricLabel(item.primaryMetric)} ${successOperatorLabel(item.successOperator)} ${formatProtocolValue(item.primaryMetric, item.successThreshold)}`);
        appendDefinition(details, "正式评估下限", `${formatNumber(evaluationMinimum, 0)} 个已核验前向唯一案例`);
        if (protocolEvaluation?.verified === true) {
          appendDefinition(details, "确定性评估", `${protocolEvaluation.passed ? "通过" : "未通过"} · 观察值 ${formatProtocolValue(item.primaryMetric, protocolEvaluation.observedValue)} · 门槛 ${successOperatorLabel(item.successOperator)} ${formatProtocolValue(item.primaryMetric, item.successThreshold)}`);
          appendDefinition(details, "结果绑定", `协议 ${shortHash(protocolEvaluation.protocolSpecHash)} · 样本 ${shortHash(protocolEvaluation.sampleSetHash)} · 结果 ${shortHash(protocolEvaluation.resultHash)}`);
        }
      }
      appendDefinition(details, "验证进度", protocol
        ? `${formatNumber(linkedValidSampleCount, 0)} / ${formatNumber(decisionTarget, 0)} 个已核验前向唯一案例${manualObservationCount ? ` · ${formatNumber(manualObservationCount, 0)} 条人工观察（不推进门槛）` : ""}${calibrationSampleCount ? ` · ${formatNumber(calibrationSampleCount, 0)} 个历史/跨界校准（不推进门槛）` : ""}${unlinkedObservationCount ? ` · ${formatNumber(unlinkedObservationCount, 0)} 条未关联观察` : ""}${censoredSampleCount ? ` · ${formatNumber(censoredSampleCount, 0)} 个删失` : ""}${rawStatus === "DECISION_DUE" ? " · 已达到本轮门槛" : ""}`
        : testComplete(item)
          ? "本条旧版样本已冻结"
          : "待记录旧版样本");
      if (item.successCriteria) appendDefinition(details, "成功标准", item.successCriteria);
      if (item.cohort) appendDefinition(details, "纳入条件", item.cohort);
      if (item.exclusions) appendDefinition(details, "排除条件", item.exclusions);
      appendDefinition(details, "关联案例", linkedCaseLabel(item.caseId));
      appendDefinition(details, "关联规则", linkedRuleLabel(item.ruleId));
      if (item.sourceReviewCycleId || item.sourceRunId) {
        appendDefinition(details, "假设来源 / 基线", `${item.sourceReviewCycleId ?? "—"} · 运行 ${item.sourceRunId ?? "—"} · 不计样本外验证`);
      }
      const sourceStale = item.sourceStatus === "stale";
      if (sourceStale) appendDefinition(details, "来源状态", "源复盘证据已更新 · 此协议只供历史审计，不能继续追加样本");
      const result = item.result ?? item.results ?? item.statistics;
      if (result) appendDefinition(details, "结果", result.summary ?? formatStats(result));
      if (item.outcomeR != null) appendDefinition(details, "净R", signedR(item.outcomeR));
      const latestSample = samples.at(-1);
      if (latestSample) {
        appendDefinition(details, "最近观察", latestSample.censored
          ? `删失 · ${formatDateTime(latestSample.recordedAt)}`
          : `${signedR(latestSample.outcomeR)} · ${formatDateTime(latestSample.recordedAt)}${latestSample.reviewCycleId ? ` · 周期 ${latestSample.reviewCycleId}` : ""} · ${observationTimingLabel(latestSample.observationTiming)}`);
      }
      if (metrics?.sampleCount) {
        appendDefinition(details, "观察统计（含人工 / 校准）", `胜率 ${signedPercent(metrics.winRatePercent)} · 赔率 ${formatNumber(metrics.payoffRatio)} · 期望 ${signedR(metrics.expectancyR)}`);
        appendDefinition(details, "观察风险路径", `最差 ${signedR(metrics.worstR)} · 尾部亏损率 ${signedPercent(metrics.tailLossRatePercent)}`);
      }
      if (Number(metrics?.verifiedSampleCount ?? 0) > 0) {
        appendDefinition(details, "正式前向统计", `${formatNumber(metrics.verifiedSampleCount, 0)} 个已核验唯一案例 · 期望 ${signedR(metrics.verifiedExpectancyR)}`);
      }
      article.append(header, node("p", "", item.notes ?? item.cohort ?? item.inclusionCriteria ?? "尚未描述样本条件。"), details);
      if (protocol) {
        const progress = node("div", "review-validation-progress");
        const progressBar = node("i");
        progressBar.style.width = `${Math.min(100, decisionTarget ? linkedValidSampleCount / decisionTarget * 100 : 0)}%`;
        progress.append(progressBar);
        article.append(progress);
        const evaluationActions = node("div", "review-item-actions review-protocol-evaluation-actions");
        const evaluate = actionButton("运行确定性评估", "primary");
        evaluate.dataset.evaluateProtocolId = String(item.id ?? "");
        const evaluationReasons = [];
        if (protocolLockReason) evaluationReasons.push(`${protocolLockReason}；请创建 v2`);
        if (linkedValidSampleCount < evaluationMinimum) {
          evaluationReasons.push(`需要 ${evaluationMinimum} 个正式样本，当前 ${linkedValidSampleCount} 个`);
        }
        if (!firstReviewMethod(["evaluateProtocol"])) evaluationReasons.push("宿主确定性评估接口尚未接线");
        if (sourceStale) evaluationReasons.push("验证来源已过期");
        if (rawStatus === "RETIRED") evaluationReasons.push("验证已退役");
        evaluate.disabled = state.loading || evaluationReasons.length > 0;
        evaluate.title = evaluationReasons.join("；");
        evaluationActions.append(
          evaluate,
          node("span", "review-evaluation-hint", evaluationReasons.join("；") || "宿主将只读取正式前向已核验样本；前端与模型不能提交通过结论。"),
        );
        article.append(evaluationActions);
      }
      if (!protocol) appendDefinition(details, "历史边界", "独立旧样本只读保留；不再追加或冻结。新观察从周期复盘的验证草案开始。");
      if (protocol && !sourceStale && rawStatus !== "DECISION_DUE" && rawStatus !== "RETIRED") {
        const resultForm = node("div", "review-test-result-form");
        const outcome = labeledInput("观察净R", "number", "例如 1.25");
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
        const sampleCycle = document.createElement("select");
        sampleCycle.dataset.testReviewCycle = "true";
        sampleCycle.append(new Option("选择系统找到的复盘候选", ""));
        const eligibleSampleCycles = validationCandidateCycles(item);
        for (const cycle of eligibleSampleCycles) {
          const technicalLabel = validationCandidateTechnicalLabel(cycle?.validationCandidate?.technicalValidation);
          sampleCycle.append(new Option(`${validationCandidateLabel(item, cycle)} · ${technicalLabel} · ${cycleTitle(cycle)} · ${cycleRangeLabel(cycle)}`, cycleId(cycle)));
        }
        const sampleCycleLabel = node("label");
        sampleCycleLabel.append(node("span", "", "后续复盘候选 / 历史校准"), sampleCycle);
        const notes = labeledInput("结果备注", "text", "异常路径、成本或删失原因");
        notes.input.dataset.testResultNotes = "true";
        const censoredLabel = node("label", "review-inline-check");
        const censored = document.createElement("input");
        censored.type = "checkbox";
        censored.dataset.testCensored = "true";
        censoredLabel.append(censored, node("span", "", "删失样本"));
        resultForm.append(
          node("p", "review-card-note", validationCandidateGuidance(item, eligibleSampleCycles)),
          validationGateList(item, eligibleSampleCycles, metrics),
          sampleCycleLabel,
          outcome.label,
          benchmark.label,
          sourceLabel,
          notes.label,
          censoredLabel,
        );
        const actions = node("div", "review-item-actions");
        const complete = actionButton(protocol ? "核验 / 纳入所选周期" : "冻结旧版样本", "secondary");
        complete.dataset.completeTestId = String(item.id ?? item.testId ?? "");
        if (protocol && !eligibleSampleCycles.length) {
          complete.disabled = true;
          complete.title = "先完成一个不是假设来源本身的后续复盘周期；上方条件清单会说明缺口";
        }
        actions.append(complete);
        article.append(resultForm, actions);
      }
      if (protocol && !sourceStale && rawStatus === "DECISION_DUE" && linkedRule) {
        article.append(buildValidationDecisionPanel(item, linkedRule, metrics));
      }
      if (protocolLockReason && linkedRule && !["RETIRED", "DECISION_DUE"].includes(rawStatus)) {
        const legacy = node("section", "review-validation-decision legacy-locked");
        legacy.append(
          node("strong", "", "旧协议已锁定"),
          node("p", "", `${protocolLockReason}。旧样本继续保留作审计；创建 v2 后才能开始确定性验证。`),
          buildValidationV2Panel(item, linkedRule, { legacyRepair: true }),
        );
        article.append(legacy);
      }
      if (protocol && rawStatus !== "DECISION_DUE") {
        const archiveActions = node("div", "review-item-actions");
        const archive = actionButton("停止并归档", "danger");
        archive.dataset.archiveValidation = String(item.id ?? "");
        archive.dataset.validationRuleId = String(item.ruleId ?? "");
        archive.dataset.validationPackageId = String(item.validationPackageId ?? "");
        archive.title = "停止观察并从活动列表移除；假设、来源与现有样本会完整保留";
        archiveActions.append(archive);
        article.append(archiveActions);
      }
      restoreValidationDraft(article, item);
      elements.testList.append(article);
    }
    const currentKeys = new Set(activeTests.map(validationDraftKey).filter(Boolean));
    for (const key of state.validationDrafts.keys()) {
      if (!currentKeys.has(key)) state.validationDrafts.delete(key);
    }
    if (focusedTest && focusedField) {
      const card = [...elements.testList.querySelectorAll("[data-test-card-id]")]
        .find((item) => item.dataset.testCardId === focusedTest);
      const field = card?.querySelector(`[${focusedField}]`);
      field?.focus({ preventScroll: true });
      if (field && selection && typeof field.setSelectionRange === "function") field.setSelectionRange(...selection);
    }
    renderArchivedValidations(archivedTests);
  }

  function renderArchivedValidations(items) {
    if (!elements.validationArchive || !elements.archivedTestList) return;
    elements.validationArchive.hidden = !items.length;
    if (elements.archivedTestCount) elements.archivedTestCount.textContent = String(items.length);
    for (const item of items) {
      const linkedRule = state.snapshot.rules.find((rule) => String(rule?.id ?? "") === String(item?.ruleId ?? ""));
      const validationPackage = state.snapshot.validationPackages.find((entry) => (
        String(entry?.id ?? "") === String(item?.validationPackageId ?? "")
      ));
      const article = node("article", "review-validation-card");
      const header = node("div", "review-item-head");
      header.append(
        node("h3", "", item.title ?? linkedRule?.title ?? "已停止的观察"),
        badge("已停止"),
      );
      const details = node("dl");
      appendDefinition(details, "假设", item.hypothesis ?? linkedRule?.condition ?? "—");
      appendDefinition(details, "开始观察", formatDateTime(item.observationStartedAt ?? item.registeredAt));
      appendDefinition(details, "停止时间", formatDateTime(validationPackage?.archivedAt ?? item.retiredAt));
      appendDefinition(details, "已保留样本", `${arrayValue(item.samples).length} 条`);
      appendDefinition(details, "停止原因", validationPackage?.archiveReason ?? item.archiveReason ?? "用户停止观察");
      appendDefinition(details, "审计状态", "来源、协议、样本和状态迁移均已保留，未物理删除");
      article.append(header, details);
      elements.archivedTestList.append(article);
    }
  }

  async function archiveValidation(button) {
    if (state.loading) return;
    const testId = button.dataset.archiveValidation;
    const test = state.snapshot.tests.find((item) => String(item?.id ?? "") === String(testId ?? ""));
    if (!test) return;
    const confirmed = window.confirm(
      `停止观察“${test.title ?? truncate(test.hypothesis, 60) ?? "未命名验证"}”？\n\n它会从活动列表移入审计档案；假设、来源和已经纳入的样本都不会删除。`,
    );
    if (!confirmed) return;
    await runAction("正在停止并归档该观察…", async () => {
      await callReview("archiveValidation", {
        validationPackageId: button.dataset.validationPackageId || null,
        testId,
        ruleId: button.dataset.validationRuleId || test.ruleId || null,
        reason: "用户在验证中心主动停止并归档观察决策",
        confirmed: true,
      });
      forgetValidationDraft(testId);
      await loadSnapshot({ preservePane: true });
      showNotice("观察已停止并移入审计档案；没有删除任何来源或样本。", "success");
    });
  }

  function renderTestLinks() {
    // Legacy manual forms are retired; existing validation links stay in cards.
  }

  function validationCandidateCycles(test) {
    const testId = String(test?.id ?? "");
    if (Object.prototype.hasOwnProperty.call(state.snapshot.validationCandidates, testId)) {
      return arrayValue(state.snapshot.validationCandidates[testId]).map((candidate) => {
        const cycle = state.snapshot.cycles.find((item) => cycleId(item) === String(candidate?.cycleId ?? ""));
        return cycle ? { ...cycle, validationCandidate: candidate } : null;
      }).filter(Boolean);
    }
    const included = new Set(arrayValue(test?.samples).map((sample) => String(sample?.reviewCycleId ?? "")).filter(Boolean));
    const sourceCycle = state.snapshot.cycles.find((cycle) => cycleId(cycle) === String(test?.sourceReviewCycleId ?? ""));
    return state.snapshot.cycles.filter((cycle) => (
      cycleId(cycle) !== String(test?.sourceReviewCycleId ?? "")
      && !included.has(cycleId(cycle))
      && cycleOutcomeReady(cycle)
      && (cycleReviewMode(cycle) === "lightweight"
        ? cyclePhaseComplete(cycle, "retrospective")
        : cyclePhaseComplete(cycle, "outcome"))
    )).sort((left, right) => (
      validationCandidateScore(test, right, sourceCycle) - validationCandidateScore(test, left, sourceCycle)
      || timestamp(right?.endAt ?? right?.updatedAt) - timestamp(left?.endAt ?? left?.updatedAt)
    ));
  }

  function validationCandidateScore(test, cycle, sourceCycle) {
    const sourceSymbols = new Set(arrayValue(sourceCycle?.symbols, [sourceCycle?.symbol]).map((item) => String(item ?? "").toUpperCase()).filter(Boolean));
    const candidateSymbols = arrayValue(cycle?.symbols, [cycle?.symbol]).map((item) => String(item ?? "").toUpperCase()).filter(Boolean);
    const symbolOverlap = candidateSymbols.some((symbol) => sourceSymbols.has(symbol));
    const sameType = String(cycle?.cycleType ?? cycle?.type ?? "") === String(sourceCycle?.cycleType ?? sourceCycle?.type ?? "");
    const searchable = `${test?.cohort ?? ""} ${test?.hypothesis ?? ""} ${test?.strategyFamily ?? ""}`.toUpperCase();
    const cohortSymbol = candidateSymbols.some((symbol) => searchable.includes(symbol.replace(/\.[A-Z]+$/, "")));
    return Number(symbolOverlap) * 4 + Number(sameType) * 2 + Number(cohortSymbol);
  }

  function validationCandidateLabel(test, cycle) {
    const candidate = cycle?.validationCandidate;
    if (candidate?.timing === "historical") return "历史校准候选";
    if (candidate?.timing === "overlapping") return "跨观察边界候选";
    if (candidate?.timing === "unknown") return "时间待核对候选";
    if (candidate?.timing === "forward") {
      if (candidate?.relevance === "high") return "前向高相关候选";
      if (candidate?.relevance === "related") return "前向同类候选";
      return "前向待核对候选";
    }
    const sourceCycle = state.snapshot.cycles.find((item) => cycleId(item) === String(test?.sourceReviewCycleId ?? ""));
    const score = validationCandidateScore(test, cycle, sourceCycle);
    return score >= 6 ? "高相关候选" : score >= 2 ? "同类候选" : "待核对候选";
  }

  function validationCandidateGuidance(test, cycles) {
    const exclusions = validationCandidateExclusionSummary(test);
    if (!cycles.length) {
      if (exclusions) return `暂无可纳入候选。${exclusions}完成新的周期复盘或修正其证据后，系统会重新核对；旧案例迁移或修改版本不会额外增加样本。`;
      return "暂无其他基于当前证据完成的复盘。形成假设的来源周期只作为基线，不计样本；开始观察后发生并完成的新周期会自动出现，已有历史周期仅在完成且证据版本有效时显示为历史校准候选。";
    }
    const forward = cycles.filter((cycle) => cycle?.validationCandidate?.timing === "forward").length;
    const overlapping = cycles.filter((cycle) => cycle?.validationCandidate?.timing === "overlapping").length;
    const historical = cycles.filter((cycle) => cycle?.validationCandidate?.timing === "historical").length;
    const technical = cycles.filter((cycle) => cycle?.validationCandidate?.technicalValidation?.sampleStatus === "available").length;
    const parts = [
      forward ? `${forward} 个前向候选` : "",
      overlapping ? `${overlapping} 个跨边界候选` : "",
      historical ? `${historical} 个历史校准候选` : "",
    ].filter(Boolean);
    return `系统找到 ${cycles.length} 个尚未纳入的已完成复盘${parts.length ? `（${parts.join("、")}）` : ""}，其中 ${technical} 个已关联入场前技术样本。历史校准不能伪装成前向样本；每一条仍需你核对冻结的纳入与排除条件。${exclusions}`;
  }

  function validationCandidateExclusionSummary(test) {
    const rows = arrayValue(state.snapshot.validationCandidateExclusions?.[String(test?.id ?? "")]);
    if (!rows.length) return "";
    const labels = {
      same_evidence_as_hypothesis_source: "与假设来源相同，不作验证样本",
      same_evidence_already_included: "同一证据已纳入",
      duplicate_legacy_evidence: "同一旧案例的重复迁移或版本",
      no_current_cycle_phase_run: "尚无基于当前证据完成的周期复盘",
      legacy_source_account_scope_conflict: "迁移来源账户不一致",
      legacy_source_case_id_missing: "迁移来源案例缺失",
      legacy_source_account_scope_missing: "迁移来源账户未绑定",
      review_evidence_id_missing: "证据身份不完整",
    };
    const counts = new Map();
    for (const row of rows) {
      const label = labels[row?.reason] || "其他证据条件未满足";
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const parts = [...counts].map(([label, count]) => `${label} ${count} 个`);
    return `已排除 ${rows.length} 个周期：${parts.slice(0, 4).join("；")}${parts.length > 4 ? "；另有其他证据限制" : ""}。`;
  }

  function validationGateList(test, cycles, metrics) {
    const list = node("ul", "review-validation-gates");
    const forward = cycles.filter((cycle) => cycle?.validationCandidate?.timing === "forward");
    const historical = cycles.filter((cycle) => (
      ["historical", "overlapping"].includes(cycle?.validationCandidate?.timing)
    ));
    const hostVerificationAvailable = Boolean(firstReviewMethod([
      "recordVerifiedProtocolSample",
      "verifyProtocolSample",
    ]));
    const target = Math.max(20, Number(test?.decisionSampleTarget ?? test?.minimumCases ?? 20));
    const formalCount = formalProtocolSampleCount(test);
    const protocolLockReason = deterministicProtocolLockReason(test);
    for (const [status, text] of [
      [protocolLockReason ? "waiting" : "ready", protocolLockReason
        ? `${protocolLockReason}；请创建 v2`
        : `机器门槛已冻结：${metricLabel(test.primaryMetric)} ${successOperatorLabel(test.successOperator)} ${formatProtocolValue(test.primaryMetric, test.successThreshold)}`],
      [cycles.length ? "ready" : "waiting", cycles.length
        ? `候选池已有 ${cycles.length} 个完成周期`
        : "等待一个已完成、且不是假设来源本身的复盘周期"],
      [forward.length ? "ready" : "waiting", forward.length
        ? `${forward.length} 个前向候选可交给宿主核验`
        : "当前只有历史/跨界校准；它们不会推进正式门槛"],
      [hostVerificationAvailable ? "ready" : "waiting", hostVerificationAvailable
        ? "前向结果由宿主从持久化证据计算；输入框不能冒充正式结果"
        : "宿主确定性核验接口尚未接线；本页只能追加人工观察"],
      [formalCount >= target ? "ready" : "waiting", `正式进度 ${formatNumber(formalCount, 0)} / ${formatNumber(target, 0)}；历史/人工 ${formatNumber(historical.length, 0)} 个候选不计入`],
    ]) {
      list.append(node("li", status, `${status === "ready" ? "✓" : "○"} ${text}`));
    }
    return list;
  }

  function validationCandidateTechnicalLabel(value) {
    if (value?.sampleStatus !== "available") return "技术样本 N/A";
    if (value?.validationMode === "walk_forward_candidate") return "前向技术候选 · 待协议绑定";
    if (value?.validationMode === "walk_forward" && value?.eligibleForFormalStatistics === true) return "合格前向技术样本";
    return "技术历史校准";
  }

  function observationTimingLabel(value) {
    return ({
      forward: "前向样本",
      overlapping: "跨观察边界校准",
      historical: "历史校准",
      unknown: "时间口径待核对",
    })[String(value ?? "")] ?? "时间口径待核对";
  }

  function buildValidationDecisionPanel(test, rule, metrics) {
    const panel = node("section", "review-validation-decision");
    const formalCount = formalProtocolSampleCount(test);
    panel.append(
      node("strong", "", "已达到本轮门槛 · 待你决策"),
      node("p", "", `系统只汇总证据，不替你晋级。当前 ${formatNumber(formalCount, 0)} 个已核验前向唯一案例；人工观察与历史校准另列，不进入正式进度。规则总体已核验期望 ${signedR(metrics?.verifiedExpectancyR)}。`),
    );
    const minimum = Math.max(20, Number(test.minimumCases ?? 20));
    const evaluation = test.protocolEvaluation;
    const gates = node("ul", "review-validation-gates decision");
    for (const [ready, label] of [
      [formalCount >= minimum, `已核验前向样本至少 ${minimum} 个`],
      [!deterministicProtocolLockReason(test), "机器可读指标、比较符与数值门槛已冻结"],
      [evaluation?.verified === true, "确定性引擎已按冻结主指标评估"],
      [evaluation?.passed === true, "冻结成功标准已通过"],
      [evaluation?.sampleSetHash != null && evaluation?.protocolSpecHash != null && evaluation?.resultHash != null, "评估已绑定协议、样本集合、观察值与结论"],
    ]) {
      gates.append(node("li", ready ? "ready" : "waiting", `${ready ? "✓" : "○"} ${label}`));
    }
    panel.append(gates);
    const actions = node("div", "review-item-actions");
    for (const [decision, label, kind] of [
      ["continue", "继续观察", "secondary"],
      ["provisional", "暂行采用", "secondary"],
      ["retire", "退役", "danger"],
    ]) {
      const button = actionButton(label, kind);
      button.dataset.validationDecision = decision;
      button.dataset.validationTestId = String(test.id ?? "");
      button.dataset.validationRuleId = String(rule.id ?? "");
      if (decision === "provisional") {
        button.disabled = !(formalCount >= minimum
          && ["completed", "decision_due"].includes(String(test.status ?? "").toLowerCase())
          && evaluation?.verified === true
          && evaluation?.passed === true);
        if (button.disabled) button.title = "暂行采用需要确定性引擎按冻结口径核验通过；人工观察不会绕过该门槛。";
      }
      actions.append(button);
    }
    panel.append(actions, buildValidationV2Panel(test, rule));
    return panel;
  }

  function buildValidationV2Panel(test, rule, { legacyRepair = false } = {}) {
    const version = document.createElement("details");
    version.className = "review-validation-v2";
    version.append(node("summary", "", legacyRepair ? "填写机器门槛并创建 v2" : "创建 v2"));
    const grid = node("div", "review-validation-v2-grid");
    const title = labeledInput("v2 名称", "text", "规则名称");
    title.input.value = rule.title ?? "";
    title.input.dataset.v2Title = "true";
    const condition = labeledTextarea("v2 条件", rule.condition ?? "", "调整后的可观察条件");
    condition.textarea.dataset.v2Condition = "true";
    const action = labeledTextarea("v2 动作", rule.action ?? "", "调整后的动作");
    action.textarea.dataset.v2Action = "true";
    const invalidation = labeledTextarea("v2 失效", rule.falsification ?? "", "调整后的反证条件");
    invalidation.textarea.dataset.v2Invalidation = "true";
    const metric = document.createElement("select");
    metric.dataset.v2Metric = "true";
    for (const [value, label] of [
      ["net_r", "累计净R"],
      ["expectancy_r", "平均期望R"],
      ["win_rate", "胜率 %"],
      ["payoff_ratio", "赔率"],
    ]) metric.append(new Option(label, value));
    setSelectValue(metric, deterministicMetricValue(test.primaryMetric) ?? "expectancy_r");
    const metricLabelNode = node("label");
    metricLabelNode.append(node("span", "", "v2 主指标"), metric);
    const operator = document.createElement("select");
    operator.dataset.v2SuccessOperator = "true";
    for (const [value, label] of [["gt", "大于 >"], ["gte", "大于等于 ≥"], ["lt", "小于 <"], ["lte", "小于等于 ≤"]]) {
      operator.append(new Option(label, value));
    }
    setSelectValue(operator, successOperatorValue(test.successOperator) ?? "gt");
    const operatorLabelNode = node("label");
    operatorLabelNode.append(node("span", "", "v2 成功比较符"), operator);
    const threshold = labeledInput("v2 数值门槛", "number", "例如 0");
    threshold.input.step = "any";
    threshold.input.required = true;
    threshold.input.value = valueOrEmpty(test.successThreshold);
    threshold.input.dataset.v2SuccessThreshold = "true";
    const successCriteria = labeledTextarea("v2 成功标准说明", test.successCriteria ?? "", "解释机器门槛的交易含义");
    successCriteria.textarea.dataset.v2SuccessCriteria = "true";
    const minimumCases = labeledInput("v2 声明最少案例", "number", "20");
    minimumCases.input.min = "1";
    minimumCases.input.max = "10000";
    minimumCases.input.step = "1";
    minimumCases.input.value = String(test.minimumCases ?? 20);
    minimumCases.input.dataset.v2MinimumCases = "true";
    const create = actionButton("确认创建 v2 并开始观察", "primary");
    create.dataset.createValidationV2 = String(test.id ?? "");
    create.dataset.validationRuleId = String(rule.id ?? "");
    grid.append(
      title.label,
      condition.label,
      action.label,
      invalidation.label,
      metricLabelNode,
      operatorLabelNode,
      threshold.label,
      successCriteria.label,
      minimumCases.label,
      node("p", "review-card-note wide", "正式评估实际下限始终为 max(20, 声明最少案例)；胜率阈值使用百分比，例如 55 表示 55%。"),
      create,
    );
    version.append(grid);
    return version;
  }

  async function handleValidationDecision(button) {
    if (state.loading) return;
    const decision = button.dataset.validationDecision;
    const ruleId = button.dataset.validationRuleId;
    const testId = button.dataset.validationTestId;
    const test = state.snapshot.tests.find((item) => String(item.id ?? "") === String(testId ?? ""));
    if (!ruleId || !test) return;
    if (decision === "provisional") {
      return transitionRule(ruleId, "PROVISIONAL", button);
    }
    await runAction(decision === "retire" ? "正在退役该验证…" : "正在开启下一轮观察…", async () => {
      await callReview("addRuleReview", {
        ruleId,
        decision: decision === "retire" ? "retire" : "keep",
        evidence: decision === "retire" ? "用户在验证门槛处决定退役" : "本轮证据不足以定稿，继续观察",
        nextTrigger: decision === "retire" ? "前提重新出现时建立新版本" : "达到下一轮系统样本门槛",
      });
      await loadSnapshot({ preservePane: true });
      showNotice(decision === "retire" ? "验证已退役，历史样本仍完整保留。" : "已开启下一轮观察，系统提高了下一次人工决策门槛。", "success");
    });
  }

  async function createValidationV2(button) {
    if (state.loading) return;
    const test = state.snapshot.tests.find((item) => String(item.id ?? "") === String(button.dataset.createValidationV2 ?? ""));
    const rule = state.snapshot.rules.find((item) => String(item.id ?? "") === String(button.dataset.validationRuleId ?? ""));
    const panel = button.closest(".review-validation-v2");
    if (!test || !rule || !panel) return;
    const title = panel.querySelector("[data-v2-title]")?.value?.trim();
    const condition = panel.querySelector("[data-v2-condition]")?.value?.trim();
    const action = panel.querySelector("[data-v2-action]")?.value?.trim();
    const falsification = panel.querySelector("[data-v2-invalidation]")?.value?.trim();
    const primaryMetric = panel.querySelector("[data-v2-metric]")?.value ?? "";
    const successOperator = panel.querySelector("[data-v2-success-operator]")?.value ?? "";
    const thresholdText = panel.querySelector("[data-v2-success-threshold]")?.value ?? "";
    const successThreshold = thresholdText === "" ? null : Number(thresholdText);
    const successCriteria = panel.querySelector("[data-v2-success-criteria]")?.value?.trim() ?? "";
    const minimumCases = Number(panel.querySelector("[data-v2-minimum-cases]")?.value ?? 20);
    if (![title, condition, action, falsification, primaryMetric, successOperator, successCriteria].every(Boolean)
      || !Number.isFinite(successThreshold)
      || !Number.isInteger(minimumCases)
      || minimumCases < 1) {
      showNotice("创建 v2 前请完整填写规则内容、受支持主指标、比较符、数值门槛与成功标准。", "warning");
      return;
    }
    await runAction("正在建立 v2 验证…", async () => {
      await callReview("createValidationVersion", {
        ruleId: rule.id,
        testId: test.id,
        title,
        condition,
        action,
        falsification,
        primaryMetric,
        successOperator,
        successThreshold,
        successCriteria,
        minimumCases,
        scope: rule.scope ?? "",
        evidence: "本轮观察达到人工复核门槛",
      });
      forgetValidationDraft(test.id);
      await loadSnapshot({ preservePane: true });
      showNotice("v2 已原子建立并开始独立观察；旧版本及其样本未被覆盖。", "success");
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
      appendDefinition(details, "版本", `v${item.contentVersion ?? 1} · 台账修订 ${item.version ?? item.currentVersion?.version ?? 1}`);
      if (item.sourceReviewCycleId || item.sourceRunId) {
        appendDefinition(details, "来源复盘", `${item.sourceReviewCycleId ?? "—"} · 运行 ${item.sourceRunId ?? "—"}`);
      }
      if (item.sourceStatus === "stale") {
        appendDefinition(details, "来源状态", "源复盘证据已更新 · 候选规则已冻结为历史草案");
      }
      const metrics = state.snapshot.ruleMetrics[id];
      if (["PROVISIONAL", "VALIDATED"].includes(status)) {
        const currentEvaluation = state.snapshot.tests.some(test => test.ruleId === id
          && test.protocolEvaluation?.verified === true && test.protocolEvaluation?.passed === true
          && formalProtocolSampleCount(test) >= Math.max(20, Number(test.minimumCases ?? 20)));
        appendDefinition(details, "状态解释", currentEvaluation
          ? "保留人工采用状态；当前独立样本与确定性评估仍可核验。"
          : "历史人工采用状态；当前证据需重新核验，不能据旧状态视作目前验证通过。请在验证中心检查样本与评估。");
      }
      if (metrics) {
        appendDefinition(details, "证据", metrics.evidenceLabel ?? "—");
        appendDefinition(details, "样本 / 核验", `${formatNumber(metrics.sampleCount, 0)} / ${formatNumber(metrics.verifiedSampleCount, 0)}`);
        if (metrics.unlinkedObservationCount) {
          appendDefinition(details, "未关联观察", `${formatNumber(metrics.unlinkedObservationCount, 0)} 条 · 不计入独立案例或正式晋级`);
        }
        appendDefinition(details, "期望R / 胜率", `${signedR(metrics.expectancyR)} / ${signedPercent(metrics.winRatePercent)}`);
        appendDefinition(details, "赔率 / 盈亏平衡胜率", `${formatNumber(metrics.payoffRatio)} / ${signedPercent(metrics.breakEvenWinRatePercent)}`);
        appendDefinition(details, "Profit Factor / 尾部亏损率", `${formatNumber(metrics.profitFactor)} / ${signedPercent(metrics.tailLossRatePercent)}`);
      }
      if (["HYPOTHESIS", "TESTING"].includes(status)) {
        appendDefinition(details, "后续操作", "请在上方验证卡中核验样本并作出决策。缺少协议或来源的旧规则只保留历史，不会自动补齐或晋级。");
      }
      article.append(header, details);
      elements.ruleList.append(article);
    }
  }


  function renderGovernance() {
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
      const decisionLabel = String(item.decision ?? item.verdict ?? "REVIEW").toUpperCase() === "CHANGE"
        ? "CHANGE PROPOSAL"
        : String(item.decision ?? item.verdict ?? "REVIEW").toUpperCase();
      header.append(
        node("h3", "", rule?.title ?? item.ruleTitle ?? "规则Review"),
        badge(decisionLabel),
      );
      const details = node("dl");
      appendDefinition(details, "Keep", item.evidence ?? item.keep ?? "—");
      appendDefinition(details, "Change", item.change ?? "—");
      appendDefinition(details, "Next trigger", item.nextTrigger ?? "—");
      if (item.applicationStatus === "proposal_only") appendDefinition(details, "应用状态", "仅记录修改建议 · 尚未改版");
      if (item.applicationStatus === "applied") appendDefinition(details, "应用状态", "已原子退役规则");
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
      renderSelectedCycle();
    }
  }

  async function callReview(method, payload) {
    const target = api?.review?.[method];
    if (typeof target !== "function") throw new Error(`复盘接口 ${method} 尚未就绪。`);
    const result = arguments.length > 1 ? await target(payload) : await target();
    if (result?.ok === false) {
      const error = new Error(result.error || result.message || `${method} 失败。`);
      error.code = result.errorCode ?? null;
      error.cachePreserved = result.cachePreserved === true;
      throw error;
    }
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
    elements.workspace.setAttribute("aria-busy", String(state.loading || state.snapshotLoading));
    elements.syncHistory.disabled = state.loading;
    updateArchiveLedgerControls();
    elements.newCycle.disabled = state.loading;
    elements.cycleCreateOpen.disabled = state.loading;
    elements.newCase.disabled = state.loading;
    elements.intakeSync.disabled = state.loading;
    elements.createFromRecords.disabled = state.loading || !selectedEventCandidate();
    elements.analyzeCase.disabled = true;
    if (elements.previewCaseMigration) elements.previewCaseMigration.disabled = state.loading || !selectedCase();
    if (elements.confirmCaseMigration) elements.confirmCaseMigration.disabled = state.loading;
    elements.cycleCheckpointForm.querySelector("button[type='submit']").disabled = state.loading || !selectedCycle();
    updateBatchButton();
    updateCycleLinkButton();
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
      parentOrderBackfill: source?.parentOrderBackfill ?? archive?.parentOrderBackfill ?? null,
      warnings: arrayValue(source?.warnings, archive?.warnings),
      orderCount: orderCount || dedupedRecords.filter((item) => brokerRecordType(item) === "order").length,
      executionCount: executionCount || dedupedRecords.filter((item) => brokerRecordType(item) === "execution").length,
      totalRecordCount: numberOr(source?.totalRecordCount, archive?.totalRecordCount, dedupedRecords.length),
      offset: nonNegativeInteger(source?.offset ?? archive?.offset, 0),
      limit: nonNegativeInteger(source?.limit ?? archive?.limit, INTAKE_PAGE_LIMIT),
      nextOffset: nullableNonNegativeInteger(source?.nextOffset ?? archive?.nextOffset),
      eligibleOrderCount: numberOr(source?.eligibleOrderCount, archive?.eligibleOrderCount, orderCount),
      eligibleExecutionCount: numberOr(source?.eligibleExecutionCount, archive?.eligibleExecutionCount, executionCount),
      excludedOrderAudit: source?.excludedOrderAudit && typeof source.excludedOrderAudit === "object"
        ? source.excludedOrderAudit
        : { totalCount: 0, matchingFilterCount: 0, visible: false, byReason: {} },
      excludedExecutionAudit: source?.excludedExecutionAudit && typeof source.excludedExecutionAudit === "object"
        ? source.excludedExecutionAudit
        : { totalCount: 0, matchingFilterCount: 0, visible: false, byReason: {} },
    };
  }

  function pruneIntakeSelection() {
    for (const record of state.snapshot.intake.records) {
      const id = brokerRecordId(record);
      if (record?.reviewEligibility?.status === "audit_only") {
        state.selectedRecordIds.delete(id);
        state.selectedRecordCache.delete(id);
        continue;
      }
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
    elements.quarterFilter.replaceChildren(new Option("全部公司财季", ""));
    values.forEach((value) => elements.quarterFilter.append(new Option(value, value)));
    if (values.includes(selected)) elements.quarterFilter.value = selected;
    else state.quarterFilter = "";
  }

  function eligibleBatchCases() {
    return state.snapshot.cases.filter((item) => (
      item?.archived !== true && caseHasConfirmedBrokerRecords(item)
    ));
  }

  function selectedBatchCases() {
    return eligibleBatchCases().filter((item) => state.selectedBatchCaseIds.has(caseId(item)));
  }

  function pruneBatchCaseSelection() {
    const eligibleIds = new Set(eligibleBatchCases().map(caseId));
    for (const id of state.selectedBatchCaseIds) {
      if (!eligibleIds.has(id)) state.selectedBatchCaseIds.delete(id);
    }
  }

  function selectVisibleBatchCases() {
    for (const item of visibleReviewCases()) {
      if (caseHasConfirmedBrokerRecords(item) && item?.archived !== true) {
        state.selectedBatchCaseIds.add(caseId(item));
      }
    }
    renderCaseList();
    updateBatchButton();
  }

  function clearBatchCaseSelection() {
    state.selectedBatchCaseIds.clear();
    renderCaseList();
    updateBatchButton();
  }

  function handleBatchCaseSelection(event) {
    const checkbox = event.target.closest("[data-review-batch-case-id]");
    if (!checkbox) return;
    const id = String(checkbox.dataset.reviewBatchCaseId ?? "");
    if (!id) return;
    if (checkbox.checked) state.selectedBatchCaseIds.add(id);
    else state.selectedBatchCaseIds.delete(id);
    updateBatchButton();
  }

  function caseHasConfirmedBrokerRecords(item) {
    const links = item?.brokerLinks;
    if (!links?.confirmedAt) return false;
    return arrayValue(links.orderIds).length + arrayValue(links.executionIds).length > 0;
  }

  function updateBatchButton() {
    if (elements.batchAnalyze) {
      elements.batchAnalyze.disabled = state.loading;
      elements.batchAnalyze.textContent = "组合复盘 → 周期";
    }
    if (elements.batchScope) elements.batchScope.hidden = true;
  }

  function recordAlreadyLinked(recordId) {
    if (!recordId) return false;
    if (state.editingCycleLinkId) return false;
    const candidate = String(recordId);
    return state.snapshot.cases.some((item) => {
      if (state.editingCaseLinkId && caseId(item) === state.editingCaseLinkId) return false;
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
    return item?.activityAt ?? item?.occurredAt ?? item?.doneAt ?? item?.executedAt ?? item?.tradeDoneAt ?? item?.submittedAt ?? item?.updatedAt ?? item?.createdAt ?? null;
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

  function monthDateRange(value, timezone = "America/New_York") {
    const match = String(value ?? "").match(/^(\d{4})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (!Number.isInteger(year) || month < 1 || month > 12) return null;
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    try {
      const start = zonedLocalMidnightUtc(year, month, timezone);
      const next = zonedLocalMidnightUtc(nextYear, nextMonth, timezone);
      return {
        startAt: new Date(start).toISOString(),
        endAt: new Date(next - 1).toISOString(),
      };
    } catch {
      return null;
    }
  }

  function zonedLocalMidnightUtc(year, month, timezone) {
    const target = Date.UTC(year, month - 1, 1);
    let candidate = target;
    for (let index = 0; index < 4; index += 1) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(candidate));
      const part = (type) => Number(parts.find((item) => item.type === type)?.value);
      const represented = Date.UTC(
        part("year"), part("month") - 1, part("day"),
        part("hour"), part("minute"), part("second"),
      );
      const correction = target - represented;
      candidate += correction;
      if (correction === 0) return candidate;
    }
    throw new Error("月份时区边界无法解析。");
  }

  function cycleIdFromResult(result) {
    return String(
      result?.cycleId
      ?? result?.cycle?.id
      ?? result?.reviewCycle?.id
      ?? result?.data?.cycleId
      ?? result?.data?.cycle?.id
      ?? result?.id
      ?? "",
    );
  }

  function cycleId(item) {
    return String(item?.id ?? item?.cycleId ?? item?.reviewCycleId ?? "");
  }

  function cycleType(item) {
    const value = String(item?.cycleType ?? item?.type ?? "");
    return CYCLE_TYPES.has(value) ? value : "catalyst";
  }

  function cycleTypeLabel(type) {
    return ({
      catalyst: "财报 / 催化剂周期",
      position_lifecycle: "单一持仓生命周期",
      monthly_portfolio: "月度组合周期",
      trade_window: "单标的订单区间",
    })[type] ?? "复盘周期";
  }

  function cycleReviewMode(item) {
    const value = String(item?.reviewMode ?? "");
    if (["lightweight", "rigorous"].includes(value)) return value;
    return cycleType(item) === "trade_window" ? "lightweight" : "rigorous";
  }

  function cycleTitle(item) {
    return String(item?.title ?? item?.name ?? `${cycleTypeLabel(cycleType(item))} · ${cycleRangeLabel(item)}`);
  }

  function cycleStatus(item) {
    return String(item?.status ?? (cycleSealed(item) ? "sealed" : "draft")).toUpperCase();
  }

  function cycleUpdatedAt(item) {
    return item?.updatedAt ?? item?.createdAt ?? item?.startAt ?? null;
  }

  function cycleSymbols(item) {
    return [...new Set([
      ...arrayValue(item?.symbols),
      item?.symbol,
    ].map(normalizeSymbol).filter(Boolean))];
  }

  function cycleScopeLabel(item) {
    if (cycleType(item) === "monthly_portfolio" || item?.scope === "portfolio") return "全部组合";
    return cycleSymbols(item).join(" + ") || "标的待确认";
  }

  function cycleRangeLabel(item) {
    if (cycleType(item) === "catalyst") {
      const catalystAt = item?.catalystAt ?? item?.eventAt ?? item?.event?.scheduledAt;
      return catalystAt
        ? `催化剂 ${formatDateTime(catalystAt)} · ${formatShortDateTime(item?.startAt)} → ${formatShortDateTime(item?.endAt)}`
        : formatDateRange([item?.startAt, item?.endAt]);
    }
    if (cycleType(item) === "monthly_portfolio") {
      const declaredMonth = String(item?.month ?? "").trim();
      if (/^\d{4}-(?:0[1-9]|1[0-2])$/.test(declaredMonth)) return declaredMonth;
      const startAt = item?.startAt;
      const time = timestamp(startAt);
      if (!time) return "月份待确认";
      try {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: item?.timezone || "Asia/Shanghai",
          year: "numeric",
          month: "2-digit",
        }).formatToParts(time);
        const part = (type) => parts.find((entry) => entry.type === type)?.value;
        return `${part("year")}-${part("month")}`;
      } catch {
        return new Date(time).toISOString().slice(0, 7);
      }
    }
    if (cycleType(item) === "trade_window") {
      return `订单区间 ${formatShortDateTime(item?.startAt)} → ${formatShortDateTime(item?.endAt)}`;
    }
    return `${formatShortDateTime(item?.startAt)} → ${item?.endAt ? formatShortDateTime(item.endAt) : "持仓进行中"}`;
  }

  function cycleExAnte(item) {
    const latest = arrayValue(item?.exAnteVersions).at(-1);
    return item?.exAnteDraft
      ?? item?.exAnte
      ?? latest?.snapshot?.exAnte
      ?? latest?.exAnte
      ?? {};
  }

  function cycleRetrospectiveVersion(item) {
    return arrayValue(item?.retrospectiveVersions)
      .filter((version) => version?.integrityStatus !== "mismatch")
      .at(-1) ?? null;
  }

  function cycleRetrospectiveNote(item) {
    return item?.retrospectiveDraft
      ?? cycleRetrospectiveVersion(item)?.snapshot
      ?? {};
  }

  function cycleSealedAt(item) {
    const latest = arrayValue(item?.exAnteVersions).at(-1);
    return latest?.sealedAt ?? item?.sealedAt ?? item?.exAnteFrozenAt ?? item?.frozenAt ?? null;
  }

  function cycleSealed(item) {
    return Boolean(cycleSealedAt(item))
      || ["SEALED", "BLIND_REVIEWED", "COMPLETED"].includes(cycleStatusWithoutSealFallback(item));
  }

  function cycleStatusWithoutSealFallback(item) {
    return String(item?.status ?? "DRAFT").toUpperCase();
  }

  function cycleDisplayStatus(item) {
    const stored = cycleStatus(item);
    if (stored !== "COMPLETED") return stored;
    return cycleReviewMode(item) === "lightweight"
      ? cyclePhaseComplete(item, "retrospective") ? stored : "历史完成 · 需重跑"
      : cyclePhaseComplete(item, "outcome") ? stored : "历史完成 · 需重跑";
  }

  function cyclePhaseRuns(item, phase) {
    const direct = arrayValue(item?.phaseRuns?.[phase], item?.reviewPhases?.[phase], item?.runs?.[phase]);
    if (direct.length) return direct;
    return arrayValue(item?.analysisRuns, item?.reviews).filter((run) => (
      String(run?.phase ?? run?.reviewPhase ?? "").toLowerCase() === phase
    ));
  }

  function cyclePhaseComplete(item, phase) {
    if (phase === "retrospective") {
      const currentVersion = Number(cycleRetrospectiveVersion(item)?.version ?? 0);
      const currentEvidenceRevision = Number(
        item?.evidenceRevision ?? item?.brokerLinks?.evidenceRevision ?? item?.brokerLinks?.revision ?? 0,
      );
      if (!Number.isInteger(currentVersion) || currentVersion < 1
        || !Number.isInteger(currentEvidenceRevision) || currentEvidenceRevision < 1) return false;
      return cyclePhaseRuns(item, phase).some((run) => (
        Boolean(run?.completedAt)
        && String(run?.status ?? "completed").toLowerCase() === "completed"
        && run?.integrityStatus === "valid"
        && Number(run?.retrospectiveVersion) === currentVersion
        && Number(run?.evidenceRevision) === currentEvidenceRevision
        && cycleRunUsesCurrentEvidenceFilter(item, run)
      ));
    }
    if (phase === "outcome") {
      const currentEvidenceRevision = Number(
        item?.evidenceRevision ?? item?.brokerLinks?.evidenceRevision ?? item?.brokerLinks?.revision ?? 0,
      );
      const hasEvidenceRevision = Number.isInteger(currentEvidenceRevision) && currentEvidenceRevision > 0;
      return cyclePhaseRuns(item, phase).some((run) => (
        Boolean(run?.completedAt)
        && String(run?.status ?? "completed").toLowerCase() === "completed"
        && run?.integrityStatus === "valid"
        && (!hasEvidenceRevision || Number(run?.evidenceRevision) === currentEvidenceRevision)
        && cycleRunUsesCurrentEvidenceFilter(item, run)
      ));
    }
    const direct = item?.analysis?.[phase] ?? item?.phases?.[phase] ?? item?.[`${phase}Review`];
    if ((direct?.completedAt || String(direct?.status ?? "").toLowerCase() === "completed")
      && direct?.integrityStatus === "valid"
      && cycleRunUsesCurrentEvidenceFilter(item, direct)) return true;
    return cyclePhaseRuns(item, phase).some((run) => (
      Boolean(run?.completedAt)
      && String(run?.status ?? "completed").toLowerCase() === "completed"
      && run?.integrityStatus === "valid"
      && cycleRunUsesCurrentEvidenceFilter(item, run)
    ));
  }

  function cycleRunUsesCurrentEvidenceFilter(item, run) {
    if (item?.brokerEvidenceAudit?.requiresPolicyV2Run !== true) return true;
    return Number(run?.evidenceFilterPolicyVersion ?? 0) >= 2;
  }

  function cycleOutcomeReady(item, now = Date.now()) {
    const endAt = timestamp(item?.endAt);
    return Number.isFinite(endAt) && endAt <= now;
  }

  function cycleCheckpoints(item) {
    return arrayValue(item?.checkpoints, item?.actionCheckpoints, item?.timeline)
      .slice()
      .sort((left, right) => timestamp(left?.occurredAt ?? left?.at) - timestamp(right?.occurredAt ?? right?.at));
  }

  function cycleBrokerRecords(item) {
    const links = item?.brokerLinks ?? {};
    const embedded = [
      ...arrayValue(links.records),
      ...arrayValue(item?.linkedRecords),
      ...arrayValue(item?.brokerRecords),
    ];
    const byId = new Map(embedded.map((record) => [stripBrokerRecordPrefix(brokerRecordId(record)), record]));
    const orderIds = arrayValue(links.orderIds, item?.orderIds);
    const executionIds = arrayValue(links.executionIds, item?.executionIds);
    const recordIds = arrayValue(links.recordIds, item?.recordIds);
    const typedIds = [
      ...orderIds.map((id) => ({ id, kind: "order" })),
      ...executionIds.map((id) => ({ id, kind: "execution" })),
      ...recordIds.map((id) => ({ id, kind: String(id).startsWith("execution:") ? "execution" : String(id).startsWith("order:") ? "order" : null })),
    ];
    for (const entry of typedIds) {
      const rawId = stripBrokerRecordPrefix(entry.id);
      if (byId.has(rawId)) continue;
      const intakeRecord = [...state.selectedRecordCache.values(), ...state.snapshot.intake.records]
        .find((record) => stripBrokerRecordPrefix(brokerRecordId(record)) === rawId);
      byId.set(rawId, intakeRecord ?? {
        recordId: String(entry.id),
        _reviewKind: entry.kind ?? "order",
        symbol: cycleSymbols(item)[0] ?? null,
      });
    }
    return [...byId.values()];
  }

  function cycleEvidenceCounts(item) {
    const records = cycleBrokerRecords(item);
    return {
      orders: records.filter((record) => brokerRecordType(record) === "order").length,
      executions: records.filter((record) => brokerRecordType(record) === "execution").length,
      checkpoints: cycleCheckpoints(item).length,
    };
  }

  function checkpointKindLabel(value) {
    return ({
      position_change: "仓位变化",
      risk_change: "风险变化",
      thesis_update: "判断更新",
      market_expectation: "市场预期",
      technical_signal: "技术信号",
      invalidation: "失效触发",
      catalyst: "催化剂",
      review_note: "复盘备注",
      other: "其他",
    })[String(value ?? "")] ?? "其他";
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

  function isProtocolTest(item) {
    return item?.testKind === "protocol" && Array.isArray(item?.samples);
  }

  function ruleStatus(item) {
    const value = String(item?.status ?? item?.currentVersion?.status ?? "HYPOTHESIS").toUpperCase();
    return RULE_STATES.includes(value) ? value : "HYPOTHESIS";
  }

  function ruleTransitionTargets(status, hasLinkedTests) {
    if (status === "HYPOTHESIS") return [...(hasLinkedTests ? ["TESTING"] : []), "RETIRED"];
    if (status === "TESTING") return ["RETIRED"];
    if (["PROVISIONAL", "VALIDATED"].includes(status)) return ["TESTING", "RETIRED"];
    if (status === "RETIRED" && hasLinkedTests) return ["TESTING"];
    return [];
  }

  function statusClass(status) {
    const value = String(status).toLowerCase();
    if (value.includes("frozen") || value.includes("sealed") || value.includes("closed") || value.includes("completed") || value.includes("validated")) return "validated";
    if (value.includes("test") || value.includes("collect") || value.includes("provisional") || value.includes("registered")) return "testing";
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

  function labeledTextarea(label, value, placeholder) {
    const wrapper = node("label");
    const textarea = document.createElement("textarea");
    textarea.rows = 2;
    textarea.placeholder = placeholder;
    textarea.value = value;
    wrapper.append(node("span", "", label), textarea);
    return { label: wrapper, textarea };
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

  function snapshotWarningText(value) {
    const warning = String(value ?? "");
    const direct = {
      broker_account_subject_unavailable_local_scope_only: "长桥未返回可验证的账户标识；切换券商账户前请先清除长桥授权，系统会开启新的本地快照范围。",
      external_cash_flows_and_fees_not_reconciled: "尚未核对外部入金、出金、费用和税费，因此只能比较净资产端点，不能称为周期收益。",
      opening_baseline_missing: "缺少周期起点附近的组合快照。",
      period_end_snapshot_missing: "缺少周期终点附近的组合快照。",
      period_has_no_snapshot: "周期内没有组合快照。",
      opening_snapshot_too_far_from_cycle: "现有起点快照距离周期边界过远，未用于确定性比较。",
      ending_snapshot_too_far_from_cycle: "现有终点快照距离周期边界过远，未用于确定性比较。",
      opening_snapshot_quality_incomplete: "起点快照存在未定价或汇率证据缺口。",
      ending_snapshot_quality_incomplete: "终点快照存在未定价或汇率证据缺口。",
    }[warning];
    if (direct) return direct;
    if (warning.startsWith("snapshot_ledger_unavailable:")) return `组合快照账本暂不可用：${warning.slice("snapshot_ledger_unavailable:".length)}`;
    return warning;
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

  function strictFiniteReviewNumber(value) {
    if (value == null || typeof value === "boolean") return null;
    if (typeof value === "string" && !value.trim()) return null;
    if (!["number", "string"].includes(typeof value)) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function formatNumber(value, digits = 2) {
    const numeric = strictFiniteReviewNumber(value);
    if (numeric == null) return "—";
    return numeric.toLocaleString("zh-CN", { maximumFractionDigits: digits });
  }

  function signedNumber(value) {
    const numeric = strictFiniteReviewNumber(value);
    if (numeric == null) return "—";
    return `${numeric > 0 ? "+" : ""}${formatNumber(numeric, 2)}`;
  }

  function signedPercent(value) {
    const numeric = strictFiniteReviewNumber(value);
    if (numeric == null) return "—";
    return `${numeric > 0 ? "+" : ""}${formatNumber(numeric, 2)}%`;
  }

  function signedR(value) {
    return strictFiniteReviewNumber(value) == null ? "—" : `${signedNumber(value)}R`;
  }

  function priceText(value, currency = "") {
    if (value == null || value === "") return node("span", "", "价格 —");
    const numeric = Number(value);
    return node("span", "", Number.isFinite(numeric) ? `${String(currency ?? "")} ${formatNumber(numeric, 4)}`.trim() : "价格 —");
  }

  function brokerPriceNode(record) {
    const evidenceAudit = record?.brokerEvidenceAudit ?? record?.priceAudit?.consistencyAudit;
    if (evidenceAudit?.status === "excluded") {
      const result = node("span", "review-price-unverified", brokerAuditReasonText(record));
      const market = record?.priceAudit?.marketReference;
      const marketDetail = market?.status === "available"
        ? `；${market.tradeDate ?? "当日"} 未复权日线区间 ${formatNumber(market.low, 4)}–${formatNumber(market.high, 4)}，原始值${market.reportedPriceInsideRange === false ? "不在" : "位于"}区间内`
        : "";
      result.title = `${brokerAuditReasonText(record)}${marketDetail}。不会按股票成交或 P&L 解释。`;
      return result;
    }
    const audit = record?.priceAudit;
    if (audit?.status === "excluded") {
      const result = node("span", "review-price-unverified", "成交价未核验");
      const reported = Number(audit?.reportedValue);
      const original = Number.isFinite(reported) ? formatNumber(reported, 4) : "—";
      result.title = `原始 ${audit?.sourceField || "Longbridge execution.price"}=${original} 已保留；${brokerAuditReasonText(record)}，不能作为标的成交价。`;
      return result;
    }
    if (brokerRecordType(record) === "order") {
      if (record?.priceBasis === "executed" && record?.executedPrice != null) {
        return priceText(record.executedPrice, record?.currency);
      }
      if (record?.priceBasis === "submitted_only" && record?.submittedPrice != null) {
        const result = priceText(record.submittedPrice, record?.currency);
        result.textContent = `限价 ${result.textContent.replace(/^价格\s*/, "")}`;
        result.title = "这是委托/限价，不是成交价。";
        return result;
      }
      return node("span", "", "成交价 —");
    }
    return priceText(record?.price, record?.currency);
  }

  function brokerAuditReasonText(record) {
    const reason = record?.reviewEligibility?.reason
      ?? record?.brokerEvidenceAudit?.reason
      ?? record?.priceAudit?.reason;
    return ({
      multileg_order_unmodeled: "多腿期权组合尚未建模",
      possible_multileg_missing_leg_metadata: "父单与成交数量不守恒，疑似多腿组合",
      parent_execution_fields_conflict: "父单与成交的证券字段相互冲突",
      parent_order_unmatched: "成交缺少可匹配父订单，证券语义未恢复",
      orphan_equity_execution_missing_parent_side_currency: "成交缺少可匹配父订单，方向和币种未恢复",
      side_unverified: "成交方向未恢复",
      quantity_unverified: "成交数量未恢复",
      time_unverified: "成交时间未恢复",
      price_unverified: "成交价未核验",
      symbol_missing: "证券代码缺失",
      cancelled_unfilled: "订单已取消且没有成交",
      rejected_unfilled: "订单被拒绝且没有成交",
      expired_unfilled: "订单已过期且没有成交",
      open_or_pending_unfilled: "订单尚未成交",
      unfilled_or_unverified: "订单没有可核验成交",
    })[reason] ?? "记录没有形成可核验交易事实";
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

  function deterministicMetricValue(value) {
    return ["net_r", "expectancy_r", "win_rate", "payoff_ratio"].includes(String(value ?? ""))
      ? String(value)
      : null;
  }

  function successOperatorValue(value) {
    return ["gt", "gte", "lt", "lte"].includes(String(value ?? "")) ? String(value) : null;
  }

  function metricLabel(value) {
    return ({
      net_r: "累计净R",
      expectancy_r: "平均期望R",
      win_rate: "胜率 %",
      payoff_ratio: "赔率",
    })[String(value ?? "")] ?? "不支持的旧指标";
  }

  function successOperatorLabel(value) {
    return ({ gt: ">", gte: "≥", lt: "<", lte: "≤" })[String(value ?? "")] ?? "?";
  }

  function formatProtocolValue(metric, value) {
    const formatted = formatNumber(value, 4);
    return metric === "win_rate" && formatted !== "—" ? `${formatted}%` : formatted;
  }

  function deterministicProtocolLockReason(test) {
    if (!deterministicMetricValue(test?.primaryMetric)) return "主指标不受宿主评估支持";
    if (!successOperatorValue(test?.successOperator) || strictFiniteReviewNumber(test?.successThreshold) == null) {
      return "缺少机器可读比较符或数值门槛";
    }
    return null;
  }

  function formalProtocolSampleCount(test) {
    return test?.formalIdentityMethod === "canonical-review-evidence/v1"
      && Number.isSafeInteger(test.formalUniqueSampleCount) && test.formalUniqueSampleCount >= 0
      ? test.formalUniqueSampleCount : 0;
  }

  function shortHash(value) {
    const text = String(value ?? "");
    return /^[a-f0-9]{64}$/i.test(text) ? `${text.slice(0, 12)}…` : "—";
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
