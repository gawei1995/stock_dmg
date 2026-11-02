import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  Notification,
  powerMonitor,
  safeStorage,
  session,
  shell,
  WebContentsView,
} from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EncryptedStore } from "./src/security/encrypted-store.mjs";
import { SegmentedLedgerStore } from "./src/security/segmented-ledger-store.mjs";
import { BusinessStateStore, validateBusinessStateDocument } from "./src/security/business-state-store.mjs";
import { createScopedSnapshotPublisher, statusDomain, storageHealthSnapshot } from "./src/runtime/view-events.mjs";
import { buildSystemHealthSnapshot } from "./src/runtime/system-health.mjs";
import {
  applyStagedTrustedBackupRestore,
  createTrustedBackupBundle,
  describeTrustedBackupSource,
  discardStagedTrustedBackupRestore,
  stageTrustedBackupRestore,
} from "./src/security/trusted-backup-bundle.mjs";
import { assessArchiveBackupCapacity } from "./src/security/archive-backup-capacity.mjs";
import {
  isAllowedAuthPopup,
  normalizeSafeExternalUrl,
  isTradingViewUrl,
} from "./src/security/navigation.mjs";
import {
  LongbridgeClient,
  classifyLongbridgeError,
} from "./src/mcp/longbridge-client.mjs";
import { createProxyAwareFetch } from "./src/mcp/proxy-aware-fetch.mjs";
import { PortfolioService } from "./src/data/portfolio-service.mjs";
import { IbkrClient, normalizeGatewayConfig } from "./src/brokers/ibkr-client.mjs";
import { findTwsApplication } from "./src/brokers/tws-application.mjs";
import { buildBrokerViews, brokerScope } from "./src/data/broker-portfolios.mjs";
import { MarketHistoryStore } from "./src/data/market-history-store.mjs";
import { MarketSeriesStore } from "./src/data/market-series-store.mjs";
import { TechnicalRadarStore } from "./src/data/technical-radar-store.mjs";
import { TechnicalWatchlistStore } from "./src/data/technical-watchlist-store.mjs";
import { TechnicalLinkageStore } from "./src/data/technical-linkage-store.mjs";
import { TechnicalRadarService } from "./src/data/technical-radar-service.mjs";
import {
  isCurrentRegularCloseSnapshot,
  PortfolioSnapshotStore,
  PORTFOLIO_SNAPSHOT_STORE_KEY,
  REGULAR_CLOSE_VALUATION_METHOD_VERSION,
} from "./src/data/portfolio-snapshot-store.mjs";
import {
  buildSnapshotCoverageCalendar,
  createSnapshotCoverageLedger,
  deserializeSnapshotCoverage,
  listSnapshotCoverageEntries,
  snapshotCoverageEntry,
  summarizeSnapshotCoverage,
  transitionSnapshotCoverage,
} from "./src/data/snapshot-coverage.mjs";
import { reconcileDurableSnapshotCoverage } from "./src/data/snapshot-coverage-reconcile.mjs";
import { buildReviewReconciliation, hashReviewReconciliationEvidence, summarizeReviewReconciliation } from "./src/review/review-reconciliation.mjs";
import {
  activateSnapshotBackgroundScope,
  createSnapshotReconnectState,
  createSnapshotBackgroundPreferences,
  decideSnapshotReconnect,
  deriveExpiredSnapshotGaps,
  isWithinUsSnapshotCaptureWindow,
  listExpiredSnapshotCaptureAlerts,
  normalizeSnapshotBackgroundPreferences,
  snapshotBackgroundReliabilityPolicy,
  snapshotBackgroundRuntimeIntent,
  snapshotMonitoringStartedAtForScope,
  recordSnapshotReconnectOutcome,
} from "./src/data/snapshot-background-reliability.mjs";
import { EcbReferenceFxProvider } from "./src/data/reference-fx.mjs";
import {
  inspectPersistedAccountScope,
  isOpaqueBrokerAccountScopeId,
  planBrokerAccountScopeActivation,
} from "./src/data/account-scope-identity.mjs";
import { AuthorizationGenerationGate } from "./src/data/authorization-generation.mjs";
import {
  portfolioFreshness,
  withPortfolioFreshness,
} from "./src/data/freshness.mjs";
import { AgentResultStore, normalizeAgentResult } from "./src/data/agent-result-store.mjs";
import { ReviewStore, calculateRuleMetrics, reconcileSampleEvidenceIdentities } from "./src/data/review-store.mjs";
import { ReviewCycleStore } from "./src/data/review-cycle-store.mjs";
import { ResearchThesisStore, RESEARCH_THESIS_STORE_KEY, buildResearchThesisContext, validateResearchThesisState } from "./src/data/research-thesis-store.mjs";
import { assertResearchReviewLink, buildLinkedResearchReferences, eligibleResearchReviewCycles } from "./src/review/research-links.mjs";
import {
  partitionReviewExecutions,
  partitionReviewOrders,
  TradeHistoryService,
} from "./src/data/trade-history-service.mjs";
import { buildAnalysisEvidence } from "./src/engine/agent.mjs";
import { calculateTechnical, classifyLastDailyBar } from "./src/engine/technical.mjs";
import {
  expectedLastCompletedTradingDate,
  isUsTradingDay,
} from "./src/engine/market-evidence.mjs";
import {
  applyCodexWorkspaceAnalysis,
  CodexWorkspaceService,
  resolveCodexExecutable,
} from "./src/engine/codex-workspace.mjs";
import { ensureWorkspaceReviewSkills } from "./src/engine/workspace-review-skills.mjs";
import { buildLegacyCaseMigration } from "./src/review/review-case-migration.mjs";
import { buildEarningsOrderFirstCycle, catalystSelectionRange, legacyCaseBrokerMatches, legacyReviewWriteError } from "./src/review/review-workflow.mjs";
import {
  buildReviewCycleAnalysisRun,
  filterCandlesBeforeReviewCutoff,
  selectCycleRecordIds,
} from "./src/review/review-cycle-analysis.mjs";
import {
  buildReviewCycleOutcomeMetrics,
  summarizeTradePricePath,
} from "./src/review/review-cycle-outcome-metrics.mjs";
import { buildReviewTechnicalValidationSample } from "./src/review/review-technical-validation.mjs";
import { deriveSelectedBuySellWindow } from "./src/review/review-trade-price-path.mjs";
import { reviewMonthRange } from "./src/review/review-calendar.mjs";
import {
  annotateLearningSources,
  assertLearningSourceCurrent,
} from "./src/review/review-learning-source.mjs";
import {
  buildValidationCandidateIndex,
  buildValidationCandidateReport,
  currentValidationReviewRun,
} from "./src/review/review-validation-candidates.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererPath = path.join(__dirname, "renderer", "index.html");
const DEFAULT_TV_URL = "https://www.tradingview.com/chart/";
const MARKET_HISTORY_STORE_KEY = "marketHistoryCacheV1";
const MARKET_HISTORY_STORE_FILE = "market-history.bin";
const PORTFOLIO_SNAPSHOT_STORE_FILE = "portfolio-snapshots.bin";
const TECHNICAL_RADAR_STORE_FILE = "technical-radar.bin";
const PORTFOLIO_SNAPSHOT_COVERAGE_STORE_KEY = "portfolioSnapshotCoverageV1";
const PORTFOLIO_SNAPSHOT_BACKGROUND_PREFERENCES_STORE_KEY = "portfolioSnapshotBackgroundPreferencesV1";
const PORTFOLIO_LEDGER_SCOPE_STORE_KEY = "portfolioLedgerScopeIdV1";
const PORTFOLIO_BROKER_SCOPE_IDENTITY_STORE_KEY = "portfolioBrokerScopeIdentityV1";
const LEGACY_PORTFOLIO_LEDGER_SCOPE_ID = "longbridge-primary-usd-v1";

let mainWindow;
let tvView;
let tvSession;
let secureStore;
let businessStateStore;
let researchThesisStore;
let reviewDataStore;
let marketHistoryDataStore;
let portfolioSnapshotDataStore;
let technicalRadarDataStore;
let longbridge;
let portfolioService;
let ibkr;
let portfolioSnapshotStore;
let technicalRadarStore;
let technicalWatchlistStore;
let technicalLinkageStore;
let technicalRadarService;
let technicalRadarRunPromise = null;
let trustedRestoreInProgress = false;
let trustedRestoreFilesFrozen = false;
let trustedLedgerArchivePermit = null;
let technicalRadarLastError = null;
let technicalRadarLastAutomaticTradingDate = null;
let portfolioSnapshotCoverageStore;
let portfolioSnapshotCoverageLedger;
let portfolioSnapshotCoverageWriteQueue = Promise.resolve();
let portfolioSnapshotBackgroundPreferences = null;
let portfolioLedgerScopeId = null;
let portfolioBrokerScopeIdentity = null;
let tradeHistoryService;
let reviewStore;
let reviewCycleStore;
let portfolio;
const longbridgeAuthorizationLifecycle = new AuthorizationGenerationGate();
const reviewSnapshotPublisher = createScopedSnapshotPublisher({
  getIdentity: () => ({ accountScopeId: currentPortfolioLedgerScopeId(), generation: longbridgeAuthorizationLifecycle.capture() }),
  readSnapshot: () => portfolioSnapshotLedgerStatus(),
  send: (payload) => safeSend("cockpit:review-snapshot-updated", payload),
});
const refreshedPortfolioAuthorization = new WeakMap();
const reviewPortfolioEvidence = new WeakMap();
let codexAnalysis;
let reviewSkillStatus = null;
let agentResults;
const activeAgentOperations = new Map();
const activeAgentByThread = new Map();
let reviewLearningMutationQueue = Promise.resolve();
let portfolioSnapshotSweep = null;
let portfolioSnapshotTimer = null;
let portfolioSnapshotCaptureQueue = Promise.resolve();
let portfolioSnapshotReconnectRuntime = createSnapshotReconnectState();
let portfolioSnapshotCaptureRuntime = {
  lastAttemptAt: null,
  lastAttemptTradingDate: null,
  lastSuccessAt: null,
  lastSuccessTradingDate: null,
  lastError: null,
  outcome: null,
};
let guardedShutdownPromise = null;
let guardedShutdownComplete = false;
let lastTvBounds = { x: 292, y: 86, width: 820, height: 780 };
let tvMainLoadFailed = false;
let pendingTvUrl = null;
let tvUrlSaveTimer = null;
let workspaceMode = "cockpit";
let systemHealthOpen = false;
const hardenedSessions = new WeakSet();
const tvPopups = new Set();
const AGENT_PORTFOLIO_REFRESH_WAIT_MS = 1_500;
const AGENT_NETWORK_PREFS_KEY = "agentNetworkPreferences.v1";
// User confirmed 2026-09-24: follow the already configured system proxy.
// An explicitly saved per-app preference still takes precedence.
const DEFAULT_AGENT_NETWORK_MODE = "system";
let agentNetworkPreferences = { mode: DEFAULT_AGENT_NETWORK_MODE };
let effectiveAgentNetworkMode = DEFAULT_AGENT_NETWORK_MODE;
const LAST_AGENT_RESULT_KEY = "lastAgentResult";
const PORTFOLIO_SNAPSHOT_CAPTURE_POLICY = Object.freeze({
  automaticEod: true,
  automaticPostTrade: true,
  manualAvailable: true,
  requiresAppRunning: true,
  requiresLongbridgeConnection: true,
  checkIntervalMinutes: 15,
  postTradeWindowMinutes: 15,
  missedDayBackfill: false,
  eodTimezone: "America/New_York",
  eodEarliestLocalTime: "16:10",
  eodLatestLocalTime: "20:00",
  automaticReconnect: "saved_authorization_non_interactive_bounded_backoff",
  eodSnapshotsPerTradingDate: 1,
  eodValuationSession: "regular_close",
  eodValuationMethodVersion: REGULAR_CLOSE_VALUATION_METHOD_VERSION,
  extendedHoursHandling: "separate_observation_never_overwrite_eod",
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on("second-instance", () => {
  if (!mainWindow) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  const longbridgeFetch = createProxyAwareFetch(
    (input, init) => net.fetch(input, init),
  );
  secureStore = new EncryptedStore({
    directory: app.getPath("userData"),
    safeStorage,
    onHealthChange: publishStorageHealth,
  });
  agentNetworkPreferences = await loadAgentNetworkPreferences();
  effectiveAgentNetworkMode = agentNetworkPreferences.mode;
  const configuredWorkspace = process.env.TRADING_COCKPIT_CODEX_WORKSPACE;
  const workspaceDirectory = configuredWorkspace && path.isAbsolute(configuredWorkspace)
    ? configuredWorkspace
    : path.join(app.getPath("documents"), "stock_agent", "trading-agent-workspace");
  businessStateStore = new BusinessStateStore({
    directory: app.getPath("userData"), safeStorage, legacyStore: secureStore,
    workspaceDirectory, onHealthChange: publishStorageHealth,
    canWrite: () => !trustedRestoreFilesFrozen,
  });
  await businessStateStore.initialize();
  portfolioSnapshotBackgroundPreferences = await loadSnapshotBackgroundPreferences();
  applySnapshotBackgroundLoginIntent();
  reviewDataStore = new EncryptedStore({
    directory: app.getPath("userData"),
    safeStorage,
    fileName: "review-data.bin",
    canWrite: () => !trustedRestoreFilesFrozen,
    onHealthChange: publishStorageHealth,
  });
  marketHistoryDataStore = new EncryptedStore({
    directory: app.getPath("userData"),
    safeStorage,
    fileName: MARKET_HISTORY_STORE_FILE,
    canWrite: () => !trustedRestoreFilesFrozen,
    onHealthChange: publishStorageHealth,
  });
  portfolioSnapshotDataStore = new EncryptedStore({
    directory: app.getPath("userData"),
    safeStorage,
    fileName: PORTFOLIO_SNAPSHOT_STORE_FILE,
    canWrite: options => canWriteLedgerStore("portfolio", options),
    onHealthChange: publishStorageHealth,
  });
  technicalRadarDataStore = new EncryptedStore({
    directory: app.getPath("userData"),
    safeStorage,
    fileName: TECHNICAL_RADAR_STORE_FILE,
    canWrite: options => canWriteLedgerStore("radar", options),
    onHealthChange: publishStorageHealth,
  });
  await migrateEncryptedStoreKey({
    source: secureStore,
    target: marketHistoryDataStore,
    key: MARKET_HISTORY_STORE_KEY,
  });
  await migrateEncryptedStoreKey({
    source: secureStore,
    target: portfolioSnapshotDataStore,
    key: PORTFOLIO_SNAPSHOT_STORE_KEY,
  });
  // Rehydrate verified immutable history before scope discovery or any domain
  // read. This also supports a v4 restore; ordinary reads never auto-archive.
  portfolioSnapshotDataStore = new SegmentedLedgerStore({
    store: portfolioSnapshotDataStore, kind: "portfolio", canWrite: options => canWriteLedgerStore("portfolio", options),
  });
  technicalRadarDataStore = new SegmentedLedgerStore({
    store: technicalRadarDataStore, kind: "radar", canWrite: options => canWriteLedgerStore("radar", options),
  });
  portfolioLedgerScopeId = await initializePortfolioLedgerScope({
    metadataStore: secureStore,
    snapshotStore: portfolioSnapshotDataStore,
  });
  portfolioBrokerScopeIdentity = normalizePersistedBrokerScopeIdentity(
    await secureStore.get(PORTFOLIO_BROKER_SCOPE_IDENTITY_STORE_KEY),
  );
  agentResults = new AgentResultStore({ store: businessStateStore });
  longbridge = new LongbridgeClient({
    endpoint: preferredLongbridgeEndpoint(),
    fetchFn: longbridgeFetch,
    networkStack: "electron-system-proxy",
    store: secureStore,
    openExternal: (url) => shell.openExternal(url),
    onStatus: (payload) => sendStatus({ ...payload, domain: "longbridge" }),
    clientVersion: app.getVersion(),
  });
  portfolioService = new PortfolioService({
    longbridge,
    store: secureStore,
    onStatus: (payload) => sendStatus({ ...payload, domain: "portfolio" }),
    referenceFxProvider: new EcbReferenceFxProvider({
      store: secureStore,
      fetchImpl: longbridgeFetch,
    }),
    marketHistoryStore: new MarketHistoryStore({
      store: marketHistoryDataStore,
      endpoint: longbridge.endpoint,
    }),
    marketSeriesStore: new MarketSeriesStore({
      store: marketHistoryDataStore,
      endpoint: longbridge.endpoint,
    }),
  });
  portfolioSnapshotStore = new PortfolioSnapshotStore({ store: portfolioSnapshotDataStore });
  technicalRadarStore = new TechnicalRadarStore({ store: technicalRadarDataStore });
  technicalWatchlistStore = new TechnicalWatchlistStore({ store: technicalRadarDataStore });
  technicalLinkageStore = new TechnicalLinkageStore({ store: technicalRadarDataStore });
  technicalRadarService = new TechnicalRadarService({
    portfolioService,
    radarStore: technicalRadarStore,
    watchlistStore: technicalWatchlistStore,
  });
  portfolioSnapshotCoverageStore = portfolioSnapshotDataStore;
  portfolioSnapshotCoverageLedger = await initializeSnapshotCoverageLedger({
    store: portfolioSnapshotCoverageStore,
    snapshotStore: portfolioSnapshotStore,
    scopeId: currentPortfolioLedgerScopeId(),
  });
  await persistSnapshotBackgroundScopeActivation({
    scopeId: currentPortfolioLedgerScopeId(),
    inheritGlobalEpoch: true,
  });
  tradeHistoryService = new TradeHistoryService({
    longbridge,
    store: reviewDataStore,
    onStatus: (payload) => sendStatus({ ...payload, domain: "history" }),
    getAccountScopeId: () => currentPortfolioLedgerScopeId(),
    requireAccountScope: true,
    authorizationLifecycle: longbridgeAuthorizationLifecycle,
  });
  reviewStore = new ReviewStore({ store: reviewDataStore });
  reviewCycleStore = new ReviewCycleStore({ store: reviewDataStore });
  researchThesisStore = new ResearchThesisStore({ store: reviewDataStore, canWrite: () => !trustedRestoreFilesFrozen });
  portfolio = await portfolioService.cachedPortfolio();
  ibkr = new IbkrClient({ store: secureStore, onUpdate: () => publishBrokerViews() });
  await ibkr.initialize();
  const codexPath = await resolveCodexExecutable();
  const bundledReviewSkillsDirectory = app.isPackaged
    ? path.join(process.resourcesPath, "trading-agent-skills")
    : path.join(app.getAppPath(), "..", "trading-agent-workspace", ".agents", "skills");
  const reviewSkillSeed = await ensureWorkspaceReviewSkills({
    workspaceDirectory,
    bundledSkillsDirectory: bundledReviewSkillsDirectory,
  });
  reviewSkillStatus = reviewSkillSeed;
  if (reviewSkillSeed.status !== "ready") {
    sendStatus({
      domain: "agent",
      state: "agent_notice",
      active: false,
      message: `复盘 Skills 安装不完整：${reviewSkillSeed.missing.join("、") || reviewSkillSeed.reason}`,
    });
  }
  for (const warning of reviewSkillSeed.warnings ?? []) {
    sendStatus({ domain: "agent", state: "agent_notice", active: false, message: warning.message });
  }
  codexAnalysis = new CodexWorkspaceService({
    codexPath,
    workspaceDirectory,
    store: businessStateStore,
    networkMode: effectiveAgentNetworkMode,
    clientVersion: app.getVersion(),
    onStatus: ({ phase, message, detail, threadId = null, operationId = null }) => sendStatus({
      domain: "agent",
      state: operationId && activeAgentOperations.has(operationId) ? "agent_running" : "agent_notice",
      active: Boolean(operationId && activeAgentOperations.has(operationId)),
      threadId,
      operationId,
      phase,
      message,
      detail,
    }),
    onStream: (payload) => safeSend("cockpit:agent-stream", payload),
    onCapabilities: (capabilities) => safeSend("cockpit:agent-capabilities", capabilities),
  });

  registerIpc();
  if (!shouldStartAsBackgroundCollector()) await createWindow();
  portfolioSnapshotTimer = setInterval(() => {
    void runPortfolioEvidenceSweep().catch(() => {});
  }, 15 * 60 * 1000);
  powerMonitor.on("resume", resumeAutomaticPortfolioEvidence);
  powerMonitor.on("unlock-screen", resumeAutomaticPortfolioEvidence);
  void reconcileExpiredPortfolioSnapshotGaps().catch(() => {});

  codexAnalysis.prepare()
    .then(async () => {
      await migrateLegacyAgentResult();
      safeSend("cockpit:agent-capabilities", codexAnalysis.capabilities());
    })
    .catch((error) => sendStatus({
      state: "agent_degraded",
      message: "Codex 持久项目线程初始化失败；运行 Agent 时会再次尝试",
      detail: safeError(error),
    }));

  if (await longbridge.hasSavedAuthorization()) {
    try {
      await longbridge.connect({ interactive: false });
      const fresh = await refreshPortfolioFromLongbridge();
      publishRefreshedPortfolio(fresh, { scheduleEvidence: true });
    } catch (error) {
      if (!isStaleLongbridgeAuthorizationError(error)) {
        markCurrentPortfolioStale(`恢复长桥连接失败：${safeError(error)}`);
      }
      sendStatus(longbridgeFailureStatus(error, "恢复长桥连接失败"));
    }
  } else if (await longbridge.needsAuthorizationUpgrade()) {
    sendStatus({
      state: "scope_upgrade_required",
      message: "长桥历史查询需要升级只读授权",
      detail: "旧授权只包含账户与持仓读取；点击“升级只读授权”补充订单与成交历史查询，不会申请下单权限。",
    });
  }
}).catch((error) => {
  const detail = safeError(error);
  console.error("Trading cockpit startup failed:", error);
  dialog.showErrorBox(
    "交易驾驶舱启动失败",
    `应用初始化没有完成，为避免后台空转已停止启动。\n\n${detail}`,
  );
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", (event) => {
  if (guardedShutdownComplete) return;
  event.preventDefault();
  if (guardedShutdownPromise) return;
  guardedShutdownPromise = performGuardedShutdown().catch((error) => {
    console.error("Trading cockpit guarded shutdown degraded:", error);
  });
  void guardedShutdownPromise.finally(() => {
    guardedShutdownComplete = true;
    app.quit();
  });
});

async function performGuardedShutdown() {
  if (portfolioSnapshotTimer) clearInterval(portfolioSnapshotTimer);
  powerMonitor.removeListener("resume", resumeAutomaticPortfolioEvidence);
  powerMonitor.removeListener("unlock-screen", resumeAutomaticPortfolioEvidence);
  for (const operation of activeAgentOperations.values()) operation.controller.abort();
  codexAnalysis?.dispose();
  let deadlineId = null;
  try {
    await Promise.race([
      Promise.resolve(tvSession?.flushStorageData()),
      new Promise((resolve) => {
        deadlineId = setTimeout(resolve, 3_000);
      }),
    ]);
  } catch {
    // The guarded shutdown still continues when Chromium storage rejects.
  } finally {
    if (deadlineId != null) clearTimeout(deadlineId);
  }
}

app.on("window-all-closed", () => {
  const keepRunning = snapshotBackgroundRuntimeIntent(
    portfolioSnapshotBackgroundPreferences ?? createSnapshotBackgroundPreferences(),
  ).keepRunningWhenLastWindowClosed;
  if (process.platform !== "darwin" || !keepRunning) app.quit();
});

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 760,
    show: false,
    backgroundColor: "#0a0e11",
    title: "交易驾驶舱",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: true,
    },
  });

  mainWindow.removeMenu();
  guardLocalRenderer(mainWindow.webContents);
  mainWindow.webContents.setZoomFactor(1);
  // This API takes scale factors, not logarithmic zoom levels. A negative
  // minimum can zero the layout viewport and leave only the native TV view.
  mainWindow.webContents.setVisualZoomLevelLimits(1, 3).catch(() => {});
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (!(input.meta || input.control) || input.type !== "keyDown") return;
    const key = String(input.key ?? "").toLowerCase();
    const current = mainWindow?.webContents.getZoomFactor?.() ?? 1;
    let next = null;
    if (["+", "="].includes(key)) next = Math.min(1.5, current + 0.1);
    else if (["-", "_"].includes(key)) next = Math.max(0.8, current - 0.1);
    else if (key === "0") next = 1;
    if (next == null) return;
    event.preventDefault();
    mainWindow.webContents.setZoomFactor(Number(next.toFixed(2)));
    requestTvBounds();
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });
  createTradingViewSurface();
  await mainWindow.loadFile(rendererPath);
  mainWindow.on("resize", requestTvBounds);
  mainWindow.on("closed", () => {
    for (const popup of tvPopups) {
      if (!popup.isDestroyed()) popup.close();
    }
    tvPopups.clear();
    tvView?.webContents.close();
    tvView = null;
    mainWindow = null;
  });
}

function createTradingViewSurface() {
  tvSession = session.fromPartition("persist:tradingview", { cache: true });
  hardenTradingViewSession(tvSession);

  tvView = new WebContentsView({
    webPreferences: {
      session: tvSession,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      plugins: false,
      experimentalFeatures: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
    },
  });
  mainWindow.contentView.addChildView(tvView);
  tvView.setBackgroundColor("#101418");
  setTvBounds(lastTvBounds);
  guardTradingViewContents(tvView.webContents);

  Promise.resolve(businessStateStore.get("tradingViewLastUrl")).then((saved) => {
    const target = isTradingViewUrl(saved) ? saved : DEFAULT_TV_URL;
    return tvView.webContents.loadURL(target);
  }).catch((error) => sendTvState({ state: "failed", message: safeError(error) }));
}

function hardenTradingViewSession(targetSession) {
  if (hardenedSessions.has(targetSession)) return;
  hardenedSessions.add(targetSession);
  const allowedPermissions = new Set(["fullscreen", "clipboard-sanitized-write"]);
  const allowPermission = (permission, requestingUrl, isMainFrame) => {
    return isMainFrame === true && isTradingViewUrl(requestingUrl) && allowedPermissions.has(permission);
  };

  targetSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(allowPermission(permission, details?.requestingUrl ?? "", details?.isMainFrame));
  });
  targetSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) =>
    allowPermission(permission, requestingOrigin ?? "", details?.isMainFrame),
  );
  targetSession.setDevicePermissionHandler(() => false);
  targetSession.on("will-download", (event, item, webContents) => {
    const mime = item.getMimeType();
    const userGesture = item.hasUserGesture?.() ?? false;
    const allowedMime = new Set(["image/png", "image/jpeg", "application/pdf", "text/csv"])
      .has(String(mime).toLowerCase());
    const urlChain = item.getURLChain?.() ?? [];
    const fromMainTradingView = webContents === tvView?.webContents;
    const trustedChain = urlChain.length > 0 && urlChain.every(isTradingViewResourceUrl);
    if (!userGesture || !allowedMime || !fromMainTradingView || !trustedChain) {
      event.preventDefault();
      return;
    }
    item.setSaveDialogOptions({
      title: "保存 TradingView 文件",
      defaultPath: item.getFilename(),
    });
  });
}

function guardTradingViewContents(contents) {
  const guardNavigation = (event, legacyUrl, _isInPlace, isMainFrame = true) => {
    if (isMainFrame === false) return;
    const url = event.url ?? legacyUrl;
    if (!isTradingViewUrl(url)) {
      event.preventDefault();
      sendTvState({ state: "blocked", message: "已阻止 TradingView 视图跳转到非白名单站点。" });
    }
  };
  contents.on("will-navigate", guardNavigation);
  contents.on("will-redirect", guardNavigation);
  contents.on("will-frame-navigate", guardNavigation);
  contents.on("did-navigate", (_event, url) => rememberTradingViewUrl(url));
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame) rememberTradingViewUrl(url);
  });
  contents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    tvMainLoadFailed = false;
    sendTvState({ state: "loading" });
  });
  contents.on("did-finish-load", () => {
    if (!tvMainLoadFailed) {
      sendTvState({ state: "ready", url: contents.getURL(), title: contents.getTitle() });
    }
  });
  contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    tvMainLoadFailed = true;
    sendTvState({ state: "failed", message: description });
  });
  contents.on("render-process-gone", () =>
    sendTvState({ state: "failed", message: "TradingView 渲染进程已退出，可点击重载。" }),
  );
  contents.on("unresponsive", () =>
    sendTvState({ state: "unresponsive", message: "TradingView 暂无响应。" }),
  );
  contents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedAuthPopup(url)) {
      sendTvState({ state: "blocked", message: "已阻止 TradingView 打开非白名单窗口。" });
      return { action: "deny" };
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 560,
        height: 760,
        parent: mainWindow,
        modal: false,
        webPreferences: {
          session: tvSession,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      },
    };
  });
  contents.on("did-create-window", (childWindow) => {
    tvPopups.add(childWindow);
    childWindow.removeMenu();
    const guardPopupNavigation = (event, legacyUrl, _isInPlace, isMainFrame = true) => {
      if (isMainFrame === false) return;
      const url = event.url ?? legacyUrl;
      if (!isAllowedAuthPopup(url)) event.preventDefault();
    };
    childWindow.webContents.on("will-navigate", guardPopupNavigation);
    childWindow.webContents.on("will-redirect", guardPopupNavigation);
    childWindow.webContents.on("will-frame-navigate", guardPopupNavigation);
    childWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    childWindow.on("closed", () => tvPopups.delete(childWindow));
  });
}

async function loadAgentNetworkPreferences() {
  const saved = await secureStore.get(AGENT_NETWORK_PREFS_KEY);
  if (saved == null) return { mode: DEFAULT_AGENT_NETWORK_MODE };
  if (!["inherit", "system"].includes(saved.mode)) {
    // Fail only Agent startup, not holdings/TV or the settings recovery UI.
    // The runtime validator rejects this sentinel before starting a child.
    return { mode: "unsupported" };
  }
  return { mode: saved.mode };
}

function agentNetworkPreferencesSnapshot() {
  return {
    mode: agentNetworkPreferences.mode,
    effectiveMode: effectiveAgentNetworkMode,
    requiresRestart: agentNetworkPreferences.mode !== effectiveAgentNetworkMode,
  };
}

async function saveAgentNetworkPreferences(request) {
  if (!["inherit", "system"].includes(request?.mode)) {
    throw new Error("请选择沿用启动环境或跟随系统代理。");
  }
  const next = { mode: request.mode };
  await secureStore.set(AGENT_NETWORK_PREFS_KEY, next, {
    commitGuard: () => { assertTrustedRestoreIdle(); return true; },
  });
  // Persist for the next app launch only. Never terminate an active thread,
  // modify global Codex configuration, or imply that network routing changed.
  agentNetworkPreferences = next;
  return agentNetworkPreferencesSnapshot();
}

function registerIpc() {
  ipcMain.handle("external:open", async (event, value) => {
    assertTrustedSender(event);
    const target = normalizeSafeExternalUrl(value);
    if (!target) throw new Error("仅允许打开安全的 HTTPS 外链。");
    await shell.openExternal(target);
    return { ok: true, url: target };
  });

  ipcMain.handle("cockpit:get-initial-state", async (event) => {
    assertTrustedSender(event);
    const activeThreadId = codexAnalysis.status().threadId;
    const lastAgentResult = activeThreadId
      ? agentResults.peek(activeThreadId) ?? await agentResults.latest(activeThreadId)
        ?? normalizeAgentResult(await businessStateStore.get(LAST_AGENT_RESULT_KEY), {
          threadId: activeThreadId,
        })
      : null;
    return {
      portfolio,
      brokers: brokerUiSnapshot(),
      longbridge: {
        ...longbridge.status(),
        hasSavedAuthorization: await longbridge.hasSavedAuthorization(),
        needsAuthorizationUpgrade: await longbridge.needsAuthorizationUpgrade(),
      },
      storage: storageHealthSnapshot([secureStore, businessStateStore, reviewDataStore, marketHistoryDataStore, portfolioSnapshotDataStore, technicalRadarDataStore]),
      reviewSkills: reviewSkillStatus,
      codex: codexAnalysis.status(),
      agentNetwork: agentNetworkPreferencesSnapshot(),
      activeAgents: activeAgentSnapshot(),
      activeAgent: activeAgentForThread(activeThreadId),
      lastAgentResult,
      safeguards: { orderWrite: false, modelNarration: codexAnalysis.available },
    };
  });

  ipcMain.handle("agent:network:preferences", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    return saveAgentNetworkPreferences(request);
  });

  ipcMain.handle("technical:radar:snapshot", async (event) => {
    assertTrustedSender(event);
    return { ok: true, radar: await technicalRadarUiSnapshot() };
  });

  ipcMain.handle("health:snapshot", async (event) => {
    assertTrustedSender(event);
    return readSystemHealthSnapshot();
  });

  ipcMain.handle("health:set-open", async (event, request) => {
    assertTrustedSender(event);
    systemHealthOpen = request?.open === true;
    tvView?.setVisible?.(workspaceMode === "cockpit" && !systemHealthOpen);
    if (!systemHealthOpen && workspaceMode === "cockpit") requestTvBounds();
    return { ok: true, open: systemHealthOpen };
  });

  ipcMain.handle("brokers:snapshot", async (event) => {
    assertTrustedSender(event);
    return brokerUiSnapshot();
  });
  ipcMain.handle("ibkr:configure", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    await ibkr.configure(request);
    return brokerUiSnapshot();
  });
  ipcMain.handle("ibkr:discover", async (event) => {
    assertTrustedSender(event);
    try { await ibkr.discover(); return { ok: true, brokers: brokerUiSnapshot() }; }
    catch (error) { return { ok: false, error: safeError(error), brokers: brokerUiSnapshot() }; }
  });
  ipcMain.handle("ibkr:login", async (event, request) => {
    assertTrustedSender(event);
    const config = normalizeGatewayConfig(request);
    if (config.transport === "tws") {
      const target = await findTwsApplication({ homeDirectory: app.getPath("home") });
      if (!target) throw new Error("未找到标准位置的 TWS，请手动打开已安装客户端并登录，再检查连接。");
      const error = await shell.openPath(target.path);
      if (error) throw new Error("TWS 未能自动打开，请手动启动后检查连接。");
    } else await shell.openExternal(`https://localhost:${config.port}`);
    return { ok: true };
  });
  ipcMain.handle("brokers:refresh", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    const scope = brokerScope(request?.scope);
    const jobs = [];
    if (scope !== "ibkr") jobs.push((async () => {
      try {
        if (!longbridge.connected) throw new Error("长桥未连接，请先完成只读授权。");
        const fresh = await refreshPortfolioFromLongbridge();
        publishRefreshedPortfolio(fresh, { scheduleEvidence: true });
        return { broker: "longbridge", ok: true };
      } catch (error) {
        if (!isStaleLongbridgeAuthorizationError(error)) markCurrentPortfolioStale(`长桥同步失败：${safeError(error)}`);
        return { broker: "longbridge", ok: false, error: safeError(error) };
      }
    })());
    if (scope === "ibkr" || scope === "all" && ibkr.config.enabled) jobs.push((async () => {
      try { await ibkr.refresh(); return { broker: "ibkr", ok: true }; }
      catch (error) { return { broker: "ibkr", ok: false, error: safeError(error) }; }
    })());
    const results = await Promise.all(jobs);
    publishBrokerViews();
    return { ok: results.every((r) => r.ok), results, brokers: brokerUiSnapshot() };
  });

  ipcMain.handle("technical:radar:run", async (event) => {
    assertTrustedSender(event);
    const radar = await runTechnicalRadarScan({ trigger: "manual" });
    return { ok: true, radar };
  });

  ipcMain.handle("technical:watchlist:add", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    await technicalWatchlistStore.add(request?.symbol);
    const radar = await technicalRadarUiSnapshot();
    safeSend("cockpit:technical-radar", radar);
    return { ok: true, radar };
  });

  ipcMain.handle("technical:watchlist:remove", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    await technicalWatchlistStore.remove(request?.symbol);
    const radar = await technicalRadarUiSnapshot();
    safeSend("cockpit:technical-radar", radar);
    return { ok: true, radar };
  });

  ipcMain.handle("technical:linkage:confirm", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    await technicalLinkageStore.confirm({
      symbol: request?.symbol,
      sectorSymbol: request?.sectorSymbol,
      peerSymbols: request?.peerSymbols,
      rationale: request?.rationale,
    });
    const radar = await technicalRadarUiSnapshot();
    safeSend("cockpit:technical-radar", radar);
    return { ok: true, radar };
  });

  ipcMain.handle("technical:linkage:remove", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    await technicalLinkageStore.remove(request?.symbol);
    const radar = await technicalRadarUiSnapshot();
    safeSend("cockpit:technical-radar", radar);
    return { ok: true, radar };
  });

  ipcMain.handle("workspace:set-mode", async (event, request) => {
    assertTrustedSender(event);
    const mode = request?.mode === "review" ? "review" : "cockpit";
    workspaceMode = mode;
    tvView?.setVisible?.(mode === "cockpit" && !systemHealthOpen);
    if (mode === "cockpit") requestTvBounds();
    return { ok: true, mode };
  });

  ipcMain.handle("review:snapshot", async (event, request) => {
    assertTrustedSender(event);
    return buildReviewSnapshot(request);
  });

  ipcMain.handle("research:snapshot", async (event) => {
    assertTrustedSender(event);
    return { ok: true, snapshot: await buildResearchSnapshot() };
  });
  for (const [channel, method] of [
    ["research:create", "create"], ["research:revise", "revise"],
    ["research:evidence:add", "addEvidence"], ["research:observation:add", "addObservation"],
    ["research:status", "setStatus"], ["research:proposal:accept", "acceptProposal"],
  ]) {
    ipcMain.handle(channel, async (event, request) => {
      assertTrustedSender(event);
      assertTrustedRestoreIdle();
      return withReviewLearningMutation(async () => {
        assertTrustedRestoreIdle();
        const input = { ...request, commitGuard: () => { assertTrustedRestoreIdle(); return true; } };
        const thesis = method === "create"
          ? await researchThesisStore.create(input)
          : await researchThesisStore[method](request?.id, input);
        return { ok: true, thesis, snapshot: await buildResearchSnapshot() };
      });
    });
  }
  ipcMain.handle("research:review:link", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    const identity = captureReviewAccountOperation();
    return withReviewLearningMutation(async () => {
      assertTrustedRestoreIdle();
      assertReviewAccountOperation(identity);
      const [workspace, cycleWorkspace] = await Promise.all([
        researchThesisStore.snapshot({ includeArchived: true }), reviewCycleStore.snapshot(),
      ]);
      assertReviewAccountOperation(identity);
      const thesis = workspace.theses.find(item => item.id === request?.id);
      if (!thesis) throw new Error("研究记录不存在，请刷新后重试。");
      const cycle = cycleWorkspace.cycles.find(item => item.id === request?.cycleId);
      assertResearchReviewLink({ thesis, cycle, accountScopeId: identity.scopeId });
      const linked = await researchThesisStore.linkReview(thesis.id, {
        expectedRevision: request?.expectedRevision, confirmed: request?.confirmed,
        cycleId: cycle.id, cycleTitle: cycle.title || cycle.id, accountScopeId: identity.scopeId,
        commitGuard: () => { assertTrustedRestoreIdle(); assertReviewAccountOperation(identity); return true; },
      });
      assertReviewAccountOperation(identity);
      return { ok: true, thesis: linked, snapshot: await buildResearchSnapshot() };
    });
  });

  ipcMain.handle("review:backup:export", async (event) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const destination = await dialog.showSaveDialog(owner, {
      title: "导出交易驾驶舱本机恢复包",
      defaultPath: path.join(
        app.getPath("documents"),
        `交易驾驶舱备份-${localDateInTimezone(new Date(), "Asia/Shanghai")}.tcbackup`,
      ),
      buttonLabel: "导出恢复包",
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (destination.canceled || !destination.filePath) return { ok: false, canceled: true };
    assertTrustedRestoreIdle();
    assertTrustedBackupQuiescent();
    const exportIdentity = captureReviewAccountOperation();
    trustedRestoreInProgress = true;
    try {
      await portfolioSnapshotCaptureQueue;
      await portfolioSnapshotCoverageWriteQueue;
      await reviewLearningMutationQueue;
      await flushTrustedBackupStores();
      assertReviewAccountOperation(exportIdentity);
      trustedRestoreFilesFrozen = true;
      await drainTrustedBackupStores();
      assertReviewAccountOperation(exportIdentity);
      const result = await createTrustedBackupBundle({
        sourceDirectory: app.getPath("userData"),
        destinationDirectory: destination.filePath,
        appVersion: app.getVersion(),
        accountScope: currentVerifiedBackupScope(),
        validatePayload: validateTrustedBackupPayload,
        commitGuard: () => assertReviewAccountOperation(exportIdentity),
      });
      assertReviewAccountOperation(exportIdentity);
      return {
        ok: true,
        canceled: false,
        path: result.bundleDirectory,
        created: result.created,
        idempotent: result.idempotent,
        fileCount: result.files?.length ?? 0,
        portability: "same-safe-storage-identity-required",
        credentialsIncluded: false,
      };
    } finally {
      trustedRestoreFilesFrozen = false;
      trustedRestoreInProgress = false;
    }
  });

  ipcMain.handle("review:ledger:archive", async (event, request) => {
    assertTrustedSender(event);
    return archiveLedgerWithConfirmation(event, request);
  });

  ipcMain.handle("review:backup:restore", async (event) => {
    assertTrustedSender(event);
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const selected = await dialog.showOpenDialog(owner, {
      title: "选择交易驾驶舱本机恢复包",
      buttonLabel: "预检恢复包",
      properties: ["openDirectory"],
    });
    if (selected.canceled || !selected.filePaths?.[0]) return { ok: false, canceled: true };
    if (trustedRestoreInProgress) throw new Error("另一个恢复预检正在进行。");
    if (technicalRadarRunPromise) throw new Error("技术雷达正在写入，请等待扫描结束后再恢复。");
    if (tradeHistoryService?.busy) throw new Error("长桥历史或财报信息正在查询，请等待完成后再恢复。");
    if (activeAgentOperations.size) throw new Error("Agent 仍有运行中的任务，请等待完成后再恢复。");
    if (longbridge?.connecting || longbridgeAuthorizationLifecycle.inFlight.size || portfolioSnapshotSweep) {
      throw new Error("长桥连接或持仓采集仍在进行，请等待完成后再恢复。");
    }
    const restoreIdentity = captureReviewAccountOperation();
    trustedRestoreInProgress = true;
    let staged = null;
    let restarting = false;
    try {
      await portfolioSnapshotCaptureQueue;
      await portfolioSnapshotCoverageWriteQueue;
      await reviewLearningMutationQueue;
      await flushTrustedBackupStores();
      assertReviewAccountOperation(restoreIdentity);
      trustedRestoreFilesFrozen = true;
      staged = await stageTrustedBackupRestore({
        bundleDirectory: selected.filePaths[0],
        targetDirectory: app.getPath("userData"),
        expectedAccountScope: currentVerifiedBackupScope(),
        validatePayload: validateTrustedBackupPayload,
      });
      const changed = staged.plan.operations.filter((item) => ["create", "replace", "delete"].includes(item.operation));
      const operationSummary = describeTrustedRestoreOperations(staged.plan.operations);
      const confirmation = await dialog.showMessageBox(owner, {
        type: "warning",
        title: "确认恢复交易数据",
        message: changed.length
          ? `恢复包已通过完整性与账户范围校验。${operationSummary}`
          : "恢复包已通过校验，当前数据与恢复包一致。",
        detail: "恢复范围包括复盘、行情缓存、组合快照、技术雷达及应用内对话索引与最近结果。按文件整体替换，不自动合并；标为删除的旧槽位会移除，旧版包未包含的对话索引保持不变。不含登录凭证或 Codex 外部完整对话；后台开关与账户授权沿用本机。恢复后重新启动。",
        buttons: changed.length ? ["取消", "恢复并重启"] : ["关闭"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (!changed.length || confirmation.response !== 1) {
        return { ok: true, canceled: changed.length > 0, unchanged: !changed.length, plan: staged.plan };
      }
      await portfolioSnapshotCaptureQueue;
      await portfolioSnapshotCoverageWriteQueue;
      await reviewLearningMutationQueue;
      await drainTrustedBackupStores();
      assertReviewAccountOperation(restoreIdentity);
      const applied = await applyStagedTrustedBackupRestore(staged, {
        commitGuard: () => assertReviewAccountOperation(restoreIdentity),
      });
      restarting = true;
      try { app.relaunch(); }
      catch (error) {
        throw new Error("数据已恢复，但自动重启未成功。为保护已恢复数据，写入仍暂停；请退出应用后重新打开。", { cause: error });
      }
      setTimeout(() => app.exit(0), 50);
      return { ok: true, canceled: false, restarting: true, applied };
    } catch (error) {
      if (error?.code === "RESTORE_ROLLBACK_FAILED") {
        // A mixed restored state must never be reopened to the old caches.
        // Retain the recovery copies and the write barrier for manual repair.
        restarting = true;
      }
      throw error;
    } finally {
      if (staged) await discardStagedTrustedBackupRestore(staged).catch(() => {});
      if (!restarting) {
        trustedRestoreFilesFrozen = false;
        trustedRestoreInProgress = false;
      }
    }
  });

  ipcMain.handle("review:snapshot-background:update", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    const current = portfolioSnapshotBackgroundPreferences
      ?? createSnapshotBackgroundPreferences();
    const enabled = request?.enabled === true;
    const now = new Date().toISOString();
    let next = createSnapshotBackgroundPreferences({
      enabled,
      launchAtLogin: enabled && request?.launchAtLogin === true,
      notifyOnMissedCapture: enabled && request?.notifyOnMissedCapture !== false,
      monitoringStartedAt: enabled
        ? current.enabled ? current.monitoringStartedAt : now
        : null,
      scopeActivatedAt: enabled && current.enabled ? current.scopeActivatedAt : {},
      updatedAt: now,
    });
    if (enabled) {
      next = activateSnapshotBackgroundScope(next, {
        accountScopeId: currentPortfolioLedgerScopeId(),
        activatedAt: now,
      });
    }
    await secureStore.set(PORTFOLIO_SNAPSHOT_BACKGROUND_PREFERENCES_STORE_KEY, next);
    portfolioSnapshotBackgroundPreferences = next;
    reviewSnapshotPublisher.schedule();
    const loginItem = applySnapshotBackgroundLoginIntent();
    if (enabled) await reconcileExpiredPortfolioSnapshotGaps();
    return {
      ok: true,
      preferences: structuredClone(next),
      loginItem,
      snapshot: await buildReviewSnapshot(),
    };
  });

  ipcMain.handle("review:portfolio-snapshot:capture", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    if (!longbridge?.connected) {
      throw new Error("长桥尚未连接，不能把旧持仓缓存保存为新的观察快照。");
    }
    const fresh = await refreshPortfolioFromLongbridge();
    const authorization = publishRefreshedPortfolio(fresh);
    const captured = await appendPortfolioSnapshot(fresh, {
      kind: "manual",
      idempotencyKey: `manual:${fresh.syncedAt}`,
      note: String(request?.note ?? "").trim().slice(0, 1_000) || "用户手动保存组合观察快照",
    }, authorization);
    scheduleFreshPortfolioEvidence(fresh, authorization);
    return { ok: true, snapshot: captured.snapshot, reviewSnapshot: await buildReviewSnapshot() };
  });

  ipcMain.handle("review:intake:snapshot", async (event, request) => {
    assertTrustedSender(event);
    if (request?.recordIds?.length) assertTrustedRestoreIdle();
    const identity = captureReviewAccountOperation();
    if (Array.isArray(request?.recordIds) && request.recordIds.length) {
      await tradeHistoryService.lookupEventCandidates({ recordIds: request.recordIds });
    }
    assertReviewAccountOperation(identity);
    const intake = await tradeHistoryService.intake(request);
    assertReviewAccountOperation(identity);
    return { ok: true, intake, accountScopeId: identity.scopeId };
  });

  ipcMain.handle("review:intake:events", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    const lookup = await tradeHistoryService.lookupEventCandidates({
      recordIds: request?.recordIds,
      daysBefore: request?.daysBefore,
      daysAfter: request?.daysAfter,
    });
    const snapshot = await buildReviewSnapshot(request);
    return { ok: true, ...lookup, intake: snapshot.intake, snapshot };
  });

  ipcMain.handle("review:intake:recent-events", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    const lookup = await tradeHistoryService.preloadRecentEventCandidates({
      symbols: request?.symbols,
      asOf: request?.asOf,
    });
    return { ok: true, ...lookup };
  });

  ipcMain.handle("review:case:create", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    throw legacyReviewWriteError();
  });

  ipcMain.handle("review:case:create-from-records", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    throw legacyReviewWriteError();
  });

  ipcMain.handle("review:case:update", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    throw legacyReviewWriteError();
  });

  ipcMain.handle("review:case:freeze", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    throw legacyReviewWriteError();
  });

  ipcMain.handle("review:case:link-broker", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    throw legacyReviewWriteError();
  });

  ipcMain.handle("review:case:migration-preview", async (event, request) => {
    assertTrustedSender(event);
    const identity = captureReviewAccountOperation();
    const migration = await prepareLegacyCaseMigration(request?.caseId, identity);
    assertReviewAccountOperation(identity);
    return { ok: true, preview: migration.preview, accountScopeId: identity.scopeId };
  });

  ipcMain.handle("review:case:migrate", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    if (request?.confirmed !== true) throw new Error("迁移前请预览来源与限制，并明确确认。");
    const identity = captureReviewAccountOperation();
    return withReviewLearningMutation(async () => {
      assertReviewAccountOperation(identity);
      const migration = await prepareLegacyCaseMigration(request?.caseId, identity);
      assertReviewAccountOperation(identity);
      const migrated = await reviewCycleStore.migrateLegacyCase({
        migration,
        expectedSourceHash: request?.sourceHash,
        confirmed: true,
        commitGuard: () => assertReviewAccountOperation(identity),
      });
      assertReviewAccountOperation(identity);
      const snapshot = await buildReviewSnapshot();
      assertReviewAccountOperation(identity);
      return { ok: true, ...migrated, snapshot };
    });
  });

  ipcMain.handle("review:cycle:create", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    const cycle = await reviewCycleStore.createCycle({
      ...request,
      startingPortfolio: reviewStartingPortfolioSnapshot(portfolio, request?.startAt),
    });
    return { ok: true, cycle, snapshot: await buildReviewSnapshot() };
  });

  ipcMain.handle("review:cycle:create-order-first", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    const identity = captureReviewAccountOperation();
    const archive = await tradeHistoryService.cached();
    assertReviewAccountOperation(identity);
    if (archive.accountScopeId !== identity.scopeId) throw stalePortfolioAccountScopeError();
    const flow = request?.flow ?? "monthly";
    if (!["single_symbol", "monthly", "earnings"].includes(flow)) throw new Error("复盘创建类型无效。");
    let cycleInput;
    let seedRecordIds;
    if (flow === "monthly") {
      const month = String(request?.month ?? "").trim();
      const range = reviewMonthRange(month, request?.timezone ?? "America/New_York");
      cycleInput = {
        type: "monthly_portfolio",
        reviewMode: request?.reviewMode === "rigorous" ? "rigorous" : "lightweight",
        title: String(request?.title ?? "").trim() || `${month} 月度组合复盘`,
        scope: "portfolio",
        symbols: [],
        benchmark: request?.benchmark ?? "QQQ.US",
        month,
        timezone: range.timezone,
        startAt: range.startAt,
        endAt: range.endAt,
        exAnte: request?.exAnte ?? {},
      };
      seedRecordIds = selectCycleRecordIds(archive, cycleInput);
    } else {
      seedRecordIds = typedBrokerRecordIds(archive, request?.recordIds);
      if (!seedRecordIds.length) throw new Error("请先选择该笔交易的长桥订单或成交。");
    }
    const allowsEmptyRigorousMonth = flow === "monthly" && cycleInput.reviewMode === "rigorous";
    if (!seedRecordIds.length && !allowsEmptyRigorousMonth) {
      throw new Error("所选范围内没有可复盘的长桥订单或成交。");
    }
    const selection = seedRecordIds.length
      ? flow === "earnings"
        ? await tradeHistoryService.resolveReviewSelection({ recordIds: seedRecordIds, eventCandidateId: request?.eventCandidateId })
        : await tradeHistoryService.resolveBrokerRecords({ recordIds: seedRecordIds })
      : {
        relatedSymbols: [], activityStartAt: null, activityEndAt: null,
        requestedRecordIds: [], recordIds: [], orderIds: [], executionIds: [], records: [],
      };
    assertReviewAccountOperation(identity);
    if (flow === "earnings") {
      if (!request?.eventCandidateId) throw new Error("请明确选择关联的财报事件。");
      cycleInput = buildEarningsOrderFirstCycle({ selection, benchmark: request?.benchmark, title: request?.title });
    } else if (flow === "single_symbol") {
      if (selection.relatedSymbols.length !== 1) {
        throw new Error("单标的复盘只能选择同一标的的订单与成交。");
      }
      const explicitTradeWindow = selectedBuySellWindow(selection, archive);
      cycleInput = {
        type: "trade_window",
        reviewMode: request?.reviewMode === "rigorous" ? "rigorous" : "lightweight",
        title: String(request?.title ?? "").trim() || `${selection.relatedSymbols[0]} 订单区间复盘`,
        scope: "single_symbol",
        symbol: selection.relatedSymbols[0],
        symbols: selection.relatedSymbols,
        timezone: request?.timezone ?? "Asia/Shanghai",
        startAt: explicitTradeWindow.windowStartAt,
        endAt: explicitTradeWindow.windowEndAt,
        benchmark: request?.benchmark ?? "QQQ.US",
        exAnte: request?.exAnte ?? {},
      };
    } else if (selection.recordIds.length) {
      assertCycleBrokerSelection(cycleInput, selection);
    }
    if (cycleInput.reviewMode === "lightweight" && !request?.retrospectiveNote) {
      throw new Error("请先写下当时判断、本次感悟和未来预判，再关联订单建立事后复盘。");
    }
    const cycle = await reviewCycleStore.createLinkedCycle({
      cycle: {
        ...cycleInput,
        startingPortfolio: reviewStartingPortfolioSnapshot(portfolio, cycleInput.startAt),
      },
      links: brokerLinksFromSelection(selection, archive.accountScopeId),
      retrospectiveNote: cycleInput.reviewMode === "lightweight" ? request.retrospectiveNote : null,
      commitGuard: () => assertReviewAccountOperation(identity),
    });
    assertReviewAccountOperation(identity);
    const snapshot = await buildReviewSnapshot();
    assertReviewAccountOperation(identity);
    return { ok: true, cycle, selection, snapshot };
  });

  ipcMain.handle("review:cycle:update", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    return withReviewLearningMutation(async () => {
      const cycle = await reviewCycleStore.updateCycle(request);
      return { ok: true, cycle, snapshot: await buildReviewSnapshot() };
    });
  });

  ipcMain.handle("review:cycle:retrospective-note", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    return withReviewLearningMutation(async () => {
      const version = await reviewCycleStore.saveRetrospectiveNote(request);
      return { ok: true, version, snapshot: await buildReviewSnapshot() };
    });
  });

  ipcMain.handle("review:cycle:seal", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    return withReviewLearningMutation(async () => {
      const version = await reviewCycleStore.sealCycle(request);
      return { ok: true, version, snapshot: await buildReviewSnapshot() };
    });
  });

  ipcMain.handle("review:cycle:link-broker", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    const identity = captureReviewAccountOperation();
    return withReviewLearningMutation(async () => {
      assertReviewAccountOperation(identity);
      const cycleId = String(request?.cycleId ?? "").trim();
      const [cycleWorkspace, archive] = await Promise.all([
        reviewCycleStore.snapshot(),
        tradeHistoryService.cached(),
      ]);
      assertReviewAccountOperation(identity);
      if (archive.accountScopeId !== identity.scopeId) throw stalePortfolioAccountScopeError();
      const cycle = cycleWorkspace.cycles.find((item) => item.id === cycleId);
      if (!cycle) throw new Error("未找到复盘周期。");
      if (cycle.brokerLinks?.accountScopeId && cycle.brokerLinks.accountScopeId !== identity.scopeId) throw stalePortfolioAccountScopeError();
      const cycleKind = String(cycle.cycleType ?? cycle.type);
      const replace = request?.replace === true;
      // Monthly portfolio reviews always mean the complete account month. The
      // renderer may still hold a selection from another tab, but it must not
      // narrow a first-time automatic link. Explicit evidence correction is the
      // one path where the user's complete replacement selection must win.
      const requestedIds = cycleKind === "monthly_portfolio" && !replace
        ? []
        : typedBrokerRecordIds(archive, request?.recordIds);
      const recordIds = replace
        ? requestedIds
        : requestedIds.length ? requestedIds : selectCycleRecordIds(archive, cycle);
      if (!recordIds.length) throw new Error("当前周期范围内没有可关联的长桥订单或成交。");
      const selection = await tradeHistoryService.resolveBrokerRecords({ recordIds });
      assertReviewAccountOperation(identity);
      const explicitTradeWindow = replace && cycleKind === "trade_window"
        ? selectedBuySellWindow(selection, archive)
        : null;
      const catalystRange = replace && cycleKind === "catalyst" && cycle.reviewMode === "lightweight"
        ? catalystSelectionRange({
          activityStartAt: selection.activityStartAt, activityEndAt: selection.activityEndAt,
          eventMetadata: cycle.eventMetadata, catalystAt: cycle.catalystAt,
        })
        : null;
      const replacementRange = explicitTradeWindow
        ? { startAt: explicitTradeWindow.windowStartAt, endAt: explicitTradeWindow.windowEndAt }
        : catalystRange;
      if (replacementRange) {
        assertCycleBrokerSymbols(cycle, selection);
      } else {
        assertCycleBrokerSelection(cycle, selection);
      }
      const linkInput = {
        cycleId,
        accountScopeId: archive.accountScopeId,
        requestedRecordIds: selection.requestedRecordIds,
        recordIds: selection.recordIds,
        orderIds: selection.orderIds,
        executionIds: selection.executionIds,
        reason: String(request?.reason ?? "").trim().slice(0, 500) || undefined,
        records: selection.records.map((item) => ({
          id: item.recordId,
          kind: item.kind,
          occurredAt: item.activityAt,
          symbol: item.symbol,
          source: item.source,
        })),
        ...(replacementRange ? {
          activityStartAt: replacementRange.startAt,
          activityEndAt: replacementRange.endAt,
        } : {}),
        commitGuard: () => assertReviewAccountOperation(identity),
      };
      const links = replace
        ? await reviewCycleStore.replaceCycleBrokerRecords(linkInput)
        : await reviewCycleStore.linkCycleRecords(linkInput);
      assertReviewAccountOperation(identity);
      const snapshot = await buildReviewSnapshot();
      assertReviewAccountOperation(identity);
      return { ok: true, links, selection, snapshot };
    });
  });

  ipcMain.handle("review:cycle:checkpoint", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    return withReviewLearningMutation(async () => {
      const checkpoint = await reviewCycleStore.addCycleCheckpoint(request);
      return { ok: true, checkpoint, snapshot: await buildReviewSnapshot() };
    });
  });

  const syncReviewHistory = async (request) => {
    const identity = captureReviewAccountOperation();
    let syncedArchive = null;
    try {
      syncedArchive = await tradeHistoryService.sync({
        startAt: request?.from ?? request?.startAt,
        endAt: request?.to ?? request?.endAt,
        symbol: request?.symbol,
      });
      assertReviewAccountOperation(identity);
    } catch (error) {
      const classification = classifyLongbridgeError(error);
      if (classification.reauth) {
        sendStatus(longbridgeFailureStatus(error, "长桥历史同步需要重新授权"));
      }
      return {
        ok: false,
        errorCode: error?.code === "HISTORY_SYNC_BUSY" || isStaleLongbridgeAuthorizationError(error)
          || String(error?.code ?? "").startsWith("STALE_") ? error.code
          : classification.code === 403308
          ? "LONGBRIDGE_HISTORY_SCOPE_REQUIRED"
          : classification.kind === "auth" && classification.reauth
            ? "LONGBRIDGE_REAUTH_REQUIRED"
          : "LONGBRIDGE_HISTORY_SYNC_FAILED",
        error: safeError(error),
        cachePreserved: true,
      };
    }
    try {
      assertReviewAccountOperation(identity);
      await capturePostTradeAfterHistorySync(syncedArchive, identity).catch((error) => {
        assertReviewAccountOperation(identity);
        sendStatus({ state: "snapshot_degraded", message: "订单历史已同步，但成交后组合快照未能补充", detail: safeError(error) });
      });
      assertReviewAccountOperation(identity);
      const snapshot = await buildReviewSnapshot(request);
      assertReviewAccountOperation(identity);
      return { ok: true, intake: snapshot.intake, snapshot };
    } catch (error) {
      return {
        ok: false,
        errorCode: "REVIEW_SNAPSHOT_FAILED",
        error: `长桥历史已同步，但复盘视图刷新失败：${safeError(error)}`,
        historySynced: true,
        cachePreserved: false,
      };
    }
  };

  ipcMain.handle("review:trade-history:sync", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    return syncReviewHistory(request);
  });

  ipcMain.handle("review:intake:sync", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    return syncReviewHistory(request);
  });

  ipcMain.handle("review:test:register", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    throw legacyReviewWriteError("请在验证中心确认 AI 草案，或从已有验证建立下一版本；不再单独新建测试。");
  });

  ipcMain.handle("review:test:complete", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    return withReviewLearningMutation(async () => {
      await assertReviewLearningMutationSource({ testId: request?.testId });
      const observation = await assertReviewObservationCycle({
        testId: request?.testId,
        reviewCycleId: request?.reviewCycleId,
      });
      const experiment = await reviewStore.completeTest(request?.testId, {
        ...request,
        observationTiming: observation?.timing ?? "unknown",
        technicalValidationRef: observation?.technicalValidation ?? null,
        canonicalEvidenceIdentity: observation.canonicalEvidenceIdentity,
        cycles: observation.cycles,
      });
      return { ok: true, experiment, snapshot: await buildReviewSnapshot() };
    });
  });

  ipcMain.handle("review:test:record-verified-sample", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    if (request?.confirmed !== true) throw new Error("纳入正式验证前需要明确确认。");
    return withReviewLearningMutation(async () => {
      await assertReviewLearningMutationSource({ testId: request?.testId });
      const sampleInput = await resolveVerifiedProtocolSample({
        testId: request?.testId,
        reviewCycleId: request?.reviewCycleId,
      });
      const experiment = await reviewStore.recordVerifiedProtocolSample(sampleInput);
      return { ok: true, experiment, snapshot: await buildReviewSnapshot() };
    });
  });

  ipcMain.handle("review:test:evaluate-protocol", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    if (request?.confirmed !== true) throw new Error("运行确定性评估前需要明确确认。");
    return withReviewLearningMutation(async () => {
      const { cycleWorkspace } = await assertReviewLearningMutationSource({ testId: request?.testId });
      const experiment = await reviewStore.evaluateProtocol({ testId: request?.testId, cycles: cycleWorkspace.cycles });
      return { ok: true, experiment, snapshot: await buildReviewSnapshot() };
    });
  });

  ipcMain.handle("review:rule:create", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    throw legacyReviewWriteError("请在验证中心确认 AI 草案，或从已有验证建立下一版本；不再单独新建规则。");
  });

  ipcMain.handle("review:rule:transition", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    return withReviewLearningMutation(async () => {
      const { cycleWorkspace } = await assertReviewLearningMutationSource({ ruleId: request?.ruleId });
      const rule = await reviewStore.transitionRule(request?.ruleId, {
        status: request?.to ?? request?.status,
        reason: request?.reason,
        cycles: cycleWorkspace.cycles,
      });
      return { ok: true, rule, snapshot: await buildReviewSnapshot() };
    });
  });

  ipcMain.handle("review:rule:review", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    return withReviewLearningMutation(async () => {
      const { cycleWorkspace } = await assertReviewLearningMutationSource({ ruleId: request?.ruleId });
      const ruleReview = await reviewStore.addRuleReview(request?.ruleId, {
        decision: request?.decision,
        evidence: request?.evidence ?? request?.keep,
        change: request?.change,
        nextTrigger: request?.nextTrigger,
        cycles: cycleWorkspace.cycles,
      });
      return { ok: true, ruleReview, snapshot: await buildReviewSnapshot() };
    });
  });

  ipcMain.handle("review:validation:create-version", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    return withReviewLearningMutation(async () => {
      const { cycleWorkspace } = await assertReviewLearningMutationSource({ ruleId: request?.ruleId ?? request?.parentRuleId });
      const created = await reviewStore.createValidationVersion({ ...request, cycles: cycleWorkspace.cycles });
      return { ok: true, ...created, snapshot: await buildReviewSnapshot() };
    });
  });

  ipcMain.handle("review:validation:archive", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    return withReviewLearningMutation(async () => {
      const archived = await reviewStore.archiveValidation({
        validationPackageId: request?.validationPackageId,
        testId: request?.testId,
        ruleId: request?.ruleId,
        reason: request?.reason,
        confirmed: request?.confirmed === true,
      });
      return { ok: true, ...archived, snapshot: await buildReviewSnapshot() };
    });
  });

  ipcMain.handle("review:learning:accept", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    return withReviewLearningMutation(async () => {
      const reviewCycleId = String(request?.reviewCycleId ?? request?.cycleId ?? "").trim();
      const sourceRunId = String(request?.runId ?? "").trim();
      if (!reviewCycleId || !sourceRunId) {
        throw new Error("验证草案缺少可核验的复盘周期或运行 ID。");
      }
      const cycleWorkspace = await reviewCycleStore.snapshot({ cycleId: reviewCycleId, phase: "full" });
      const cycle = cycleWorkspace.cycles.find((item) => item.id === reviewCycleId);
      if (!cycle) throw new Error("验证草案对应的复盘周期不存在。");
      const phaseRuns = [
        ...(cycle.phaseRuns?.retrospective ?? []),
        ...(cycle.phaseRuns?.outcome ?? []),
      ].filter((item) => item?.status === "completed" && item?.integrityStatus === "valid");
      const sourceRun = phaseRuns.find((item) => String(item?.result?.runId ?? "") === sourceRunId);
      if (!sourceRun) throw new Error("验证草案无法对应到已完成且完整的复盘结果。");
      const latestForPhase = phaseRuns.filter((item) => item.phase === sourceRun.phase).at(-1);
      if (latestForPhase?.id !== sourceRun.id) {
        throw new Error("复盘证据或用户记录已经更新，请用最新版本重新运行后再登记验证草案。");
      }
      const sourceValidation = await reviewCycleStore.validatePhaseRunSource(reviewCycleId, sourceRun.id);
      if (!sourceValidation.isCurrent) {
        throw new Error("复盘证据或用户记录已经更新，请用最新版本重新运行后再登记验证草案。");
      }
      if (sourceRun.phase === "retrospective") {
        const latestNoteVersion = (cycle.retrospectiveVersions ?? [])
          .filter((item) => item?.integrityStatus !== "mismatch")
          .at(-1)?.version ?? null;
        if (sourceRun.retrospectiveVersion !== latestNoteVersion) {
          throw new Error("这份验证草案基于旧的三段记录版本，请重新运行复盘。");
        }
      }
      const sourceProposal = sourceRun?.result?.learningProposal;
      if (!sourceProposal) throw new Error("该复盘结果没有可登记的 AI 验证草案。");
      const accepted = await reviewStore.acceptLearningProposal({
        ...request,
        proposal: request?.proposal ?? sourceProposal,
        sourceProposal,
        reviewCycleId,
        runId: sourceRunId,
        sourcePhaseRunId: sourceRun.id,
        sourceEvidenceRevision: sourceRun.evidenceRevision,
        sourceRetrospectiveVersion: sourceRun.retrospectiveVersion,
        confirmed: request?.confirmed === true,
      });
      return { ok: true, ...accepted, snapshot: await buildReviewSnapshot() };
    });
  });

  ipcMain.handle("agent:capabilities", async (event) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    // Preserve structured repair advice when preparation fails. This read
    // never turns a failed guard into readiness or starts a model request.
    await codexAnalysis.prepare().catch(() => {});
    return codexAnalysis.capabilities();
  });

  ipcMain.handle("agent:guard:recheck", async (event) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    return codexAnalysis.recheckReadOnlyGuard();
  });

  ipcMain.handle("agent:history:list", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    return codexAnalysis.recentHistory({
      query: String(request?.query ?? "").slice(0, 200),
      limit: Math.min(Math.max(Number(request?.limit) || 20, 1), 40),
      includeTurns: false,
    });
  });

  ipcMain.handle("agent:sessions:list", async (event) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    return sessionPayload();
  });

  ipcMain.handle("agent:sessions:create", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    const session = await codexAnalysis.createSession({
      name: String(request?.name ?? "").slice(0, 120),
      ...(request?.toolMode === "full" || request?.toolMode === "restricted" ? { toolMode: request.toolMode } : {}),
    });
    safeSend("cockpit:agent-capabilities", codexAnalysis.capabilities());
    return {
      currentThreadId: session.id,
      activeSessionId: session.id,
      session,
      transcript: [],
      activeAgents: activeAgentSnapshot(),
      activeAgent: null,
      lastAgentResult: null,
    };
  });

  ipcMain.handle("agent:sessions:switch", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    const session = await codexAnalysis.openSession(String(request?.threadId ?? ""));
    safeSend("cockpit:agent-capabilities", codexAnalysis.capabilities());
    return sessionPayload(session);
  });

  ipcMain.handle("agent:sessions:open", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    const session = await codexAnalysis.openSession(String(request?.threadId ?? ""));
    safeSend("cockpit:agent-capabilities", codexAnalysis.capabilities());
    return sessionPayload(session);
  });

  ipcMain.handle("agent:result:recover", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    const threadId = validateThreadId(request?.threadId ?? codexAnalysis.status().threadId);
    const operationId = validateOperationId(request?.operationId);
    const hasMatchingActiveOperation = () => {
      if (!operationId) return activeAgentByThread.has(threadId);
      return String(activeAgentOperations.get(operationId)?.threadId ?? "") === threadId;
    };
    let active = hasMatchingActiveOperation();
    let result = agentResults.peek(threadId);
    let matchingResult = result && (!operationId || result.operationId === operationId) ? result : null;
    if (!matchingResult && !active) {
      result = await agentResults.latest(threadId).catch(() => null);
      matchingResult = result && (!operationId || result.operationId === operationId) ? result : null;
    }
    // While a matching run is active, the workspace's own reconciler is the
    // single source of polling. Avoid stacking a second history scan on every
    // renderer recovery request.
    let recoveryFailure = null;
    const historicalTurn = !matchingResult && !active
      ? await codexAnalysis.recoverLatestTurn({
          threadId,
          task: String(request?.task ?? "").slice(0, 4_000),
          operationId,
        }).catch((error) => { recoveryFailure = agentFailureEnvelope(error); return null; })
      : null;
    return {
      threadId,
      operationId,
      active,
      result: matchingResult,
      historicalTurn,
      recoveryFailure,
    };
  });

  ipcMain.handle("longbridge:connect", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    const forceReauthorize = request?.forceReauthorize === true;
    try {
      if (forceReauthorize) {
        const owner = BrowserWindow.fromWebContents(event.sender);
        const options = {
          type: "info",
          buttons: ["取消", "继续只读授权"],
          defaultId: 0,
          cancelId: 0,
          title: "重新授权长桥只读查询",
          message: "将清除旧的本地 OAuth 凭证，并重新申请账户、持仓、历史订单与成交查询。",
          detail: "不会申请、开放或调用提交订单、改单、撤单权限；复盘与历史快照保留，旧账户的当前持仓缓存会退出活动视图。",
        };
        const confirmation = owner && !owner.isDestroyed()
          ? await dialog.showMessageBox(owner, options)
          : await dialog.showMessageBox(options);
        if (confirmation.response !== 1) {
          return { ok: false, cancelled: true };
        }
        assertTrustedRestoreIdle();
        invalidateLongbridgeAuthorizationLifecycle();
        await longbridge.disconnect({ forget: true });
        await settleSupersededLongbridgeAuthorizationWork();
        await secureStore.delete("portfolioSnapshot");
        portfolio = null;
        safeSend("cockpit:portfolio", null);
        await rotatePortfolioLedgerScope();
      }
      await longbridge.connect({ interactive: true });
    } catch (error) {
      if (!isStaleLongbridgeAuthorizationError(error)) {
        markCurrentPortfolioStale(`长桥连接失败：${safeError(error)}`);
      }
      const failure = longbridgeFailureStatus(error, "长桥连接失败");
      sendStatus(failure);
      return {
        ok: false,
        authorizationReady: false,
        error: failure.detail || failure.message,
        status: failure,
      };
    }
    try {
      const fresh = await refreshPortfolioFromLongbridge();
      publishRefreshedPortfolio(fresh, { scheduleEvidence: true });
      return {
        ok: true,
        authorizationReady: true,
        portfolio: fresh,
        status: longbridge.status(),
      };
    } catch (error) {
      if (!isStaleLongbridgeAuthorizationError(error)) {
        markCurrentPortfolioStale(`长桥已授权，但持仓同步失败：${safeError(error)}`);
      }
      const failure = longbridgeFailureStatus(error, "长桥持仓同步失败");
      const classification = classifyLongbridgeError(error);
      sendStatus(failure);
      if (classification.reauth) {
        return {
          ok: false,
          authorizationReady: false,
          error: failure.detail || failure.message,
          status: failure,
        };
      }
      return {
        ok: true,
        authorizationReady: true,
        portfolio,
        status: longbridge.status(),
        warning: failure.detail || failure.message,
      };
    }
  });

  ipcMain.handle("longbridge:refresh", async (event) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    try {
      if (!longbridge.connected) {
        throw new Error("长桥尚未连接；请先点击“连接长桥”完成只读授权。");
      }
      const fresh = await refreshPortfolioFromLongbridge();
      publishRefreshedPortfolio(fresh, { scheduleEvidence: true });
      return { ok: true, portfolio: fresh };
    } catch (error) {
      if (!isStaleLongbridgeAuthorizationError(error)) {
        markCurrentPortfolioStale(`长桥同步失败：${safeError(error)}`);
      }
      const failure = longbridgeFailureStatus(error, "长桥同步失败");
      sendStatus(failure);
      return {
        ok: false,
        error: failure.detail || failure.message,
        status: failure,
      };
    }
  });

  ipcMain.handle("longbridge:forget", async (event) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      type: "warning",
      buttons: ["取消", "断开并清除本地授权"],
      defaultId: 0,
      cancelId: 0,
      title: "清除长桥授权",
      message: "这会删除本机加密保存的长桥 OAuth 凭证与持仓缓存。",
    };
    const result = owner && !owner.isDestroyed()
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);
    if (result.response !== 1) return { ok: false, cancelled: true };
    assertTrustedRestoreIdle();
    invalidateLongbridgeAuthorizationLifecycle();
    await longbridge.disconnect({ forget: true });
    await settleSupersededLongbridgeAuthorizationWork();
    await secureStore.delete("portfolioSnapshot");
    await rotatePortfolioLedgerScope();
    portfolio = null;
    safeSend("cockpit:portfolio", null);
    return { ok: true };
  });

  ipcMain.handle("agent:run", async (event, request) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    const scope = validateAnalysisScope(request?.scope);
    const researchThesisId = typeof request?.researchThesisId === "string"
      ? request.researchThesisId.trim().slice(0, 200) : "";
    if (researchThesisId && scope !== "chat") throw new Error("研究主线请在独立自由研究对话中打开，不与持仓或盲态复盘混用。");
    const requestedBrokerScope = scope === "review" ? "longbridge" : brokerScope(request?.brokerScope ?? "longbridge");
    const multiBrokerAnalysis = scope !== "review" && (requestedBrokerScope === "ibkr"
      || requestedBrokerScope === "all" && ibkr.config.enabled);
    const requestedPortfolio = scope === "chat" ? null : scope === "review" ? portfolio : brokerUiSnapshot().views[requestedBrokerScope];
    const ibkrGeneration = ibkr.generation;
    const reviewCycleId = scope === "review"
      ? String(request?.reviewCycleId ?? request?.cycleId ?? "").trim().slice(0, 200)
      : "";
    const reviewPhase = ["blind", "outcome", "retrospective"].includes(request?.reviewPhase)
      ? request.reviewPhase
      : "blind";
    if (scope === "review" && !reviewCycleId) {
      throw legacyReviewWriteError("旧案例及其历史分析仍可查看；请先预览迁移到复盘周期，再开始新的分析。");
    }
    if (!["review", "chat"].includes(scope) && !requestedPortfolio) {
      throw new Error("请先为当前账户范围至少同步一次真实持仓。");
    }
    const requestStartedAt = Date.now();
    const agentAuthorizationGeneration = longbridgeAuthorizationLifecycle.capture();
    let agentPortfolioScopeId = currentPortfolioLedgerScopeId();
    const operationId = validateOperationId(request?.operationId) ?? randomUUID();
    const threadId = validateThreadId(request?.threadId ?? codexAnalysis.status().threadId);
    if (activeAgentOperations.has(operationId)) throw new Error("该 Agent 请求已在运行。");
    if (activeAgentByThread.has(threadId)) throw new Error("当前对话已有一轮分析正在运行；可切换到其他对话并行分析。");
    const symbol = ["chat", "portfolio", "review"].includes(scope)
      ? null
      : normalizeAnalysisSymbol(request?.symbol);
    const targetLabel = scope === "chat" ? "自由研究" : scope === "portfolio"
      ? "全部持仓"
      : scope === "review"
        ? reviewCycleId
          ? reviewPhase === "blind"
            ? "周期盲态复盘"
            : reviewPhase === "retrospective" ? "订单优先事后复盘" : "周期结果复盘"
          : "交易复盘"
        : symbol;
    const requestedRiskBudgetPercent = finiteOrNull(request?.riskBudgetPercent);
    const riskBudgetPercent = clamp(requestedRiskBudgetPercent ?? 0.8, 0.05, 5);
    const defaultTask = scope === "chat" ? "讨论我的投资研究问题，按需选择方法和来源。" : scope === "review"
      ? reviewCycleId
        ? `$review-decision-cycles 完成该决策周期的${reviewPhase === "blind" ? "阶段一盲态" : reviewPhase === "retrospective" ? "订单优先事后" : "阶段二结果"}复盘。`
        : "$review-earnings-decisions 基于已确认关联的长桥历史订单、成交、财报事件与用户事前记录完成复盘。"
      : scope === "portfolio"
        ? "检查全部持仓的集中度、重复暴露、下行情景和组合健康度"
        : "分析当前持仓";
    const task = String(request?.task ?? defaultTask).slice(0, 4_000);
    const controller = new AbortController();
    activeAgentOperations.set(operationId, {
      operationId,
      threadId,
      scope,
      controller,
      startedAt: requestStartedAt,
      task,
    });
    activeAgentByThread.set(threadId, operationId);
    let portfolioRefreshMs = 0;
    sendStatus({
      domain: "agent",
      state: "agent_running",
      active: true,
      threadId,
      operationId,
      message: `Agent 正在分析 ${targetLabel}`,
    });
    try {
      await codexAnalysis.cachePendingUserMessage({
        threadId,
        operationId,
        text: task,
      });
      let analysisPortfolio = requestedPortfolio ? withPortfolioFreshness(requestedPortfolio) : null;
      if (!["review", "chat"].includes(scope) && !multiBrokerAnalysis && !analysisPortfolio.freshness.freshForSizing) {
        publishPortfolioForAuthorization(analysisPortfolio, {
          authorizationGeneration: agentAuthorizationGeneration,
          scopeId: agentPortfolioScopeId,
        });
        sendStatus({
          domain: "agent",
          state: "agent_running",
          active: true,
          threadId,
          operationId,
          message: longbridge.connected
            ? "持仓快照较旧；短暂尝试刷新，超时则沿用现有快照"
            : "长桥当前离线；本轮沿用上次真实持仓快照并降低置信度",
        });
        if (longbridge.connected) {
          const fallbackPortfolio = analysisPortfolio;
          const refreshStartedAt = Date.now();
          const refreshPromise = refreshPortfolioFromLongbridge({
            authorizationGeneration: agentAuthorizationGeneration,
          })
            .then((nextPortfolio) => {
              const authorization = publishRefreshedPortfolio(nextPortfolio, { scheduleEvidence: true });
              agentPortfolioScopeId = authorization.scopeId;
              return { portfolio: nextPortfolio, error: null };
            })
            .catch((error) => ({ portfolio: null, error }));
          const refreshOutcome = await Promise.race([
            refreshPromise,
            abortableDelay(AGENT_PORTFOLIO_REFRESH_WAIT_MS, controller.signal)
              .then(() => ({ portfolio: null, error: null, timedOut: true })),
          ]);
          portfolioRefreshMs = Date.now() - refreshStartedAt;
          if (refreshOutcome.error) {
            analysisPortfolio = withPortfolioFreshness(fallbackPortfolio, {
              forceState: "stale",
              reason: `Agent 运行前刷新失败：${safeError(refreshOutcome.error)}`,
            });
            publishPortfolioForAuthorization(analysisPortfolio, {
              authorizationGeneration: agentAuthorizationGeneration,
              scopeId: agentPortfolioScopeId,
            });
            sendStatus({
              domain: "agent",
              state: "agent_running",
              active: true,
              threadId,
              operationId,
              message: `长桥刷新失败；沿用现有快照继续分析：${safeError(refreshOutcome.error)}`,
            });
          } else if (refreshOutcome.timedOut) {
            analysisPortfolio = withPortfolioFreshness(fallbackPortfolio, {
              forceState: "stale",
              reason: "Agent 运行前刷新超过等待窗口；后台同步仍在继续",
            });
            publishPortfolioForAuthorization(analysisPortfolio, {
              authorizationGeneration: agentAuthorizationGeneration,
              scopeId: agentPortfolioScopeId,
            });
            sendStatus({
              domain: "agent",
              state: "agent_running",
              active: true,
              threadId,
              operationId,
              message: "长桥刷新转入后台；Agent 已用现有快照继续，不再等待",
            });
          } else if (refreshOutcome.portfolio) {
            analysisPortfolio = refreshOutcome.portfolio;
          }
        } else {
          analysisPortfolio = withPortfolioFreshness(analysisPortfolio, {
            forceState: "stale",
            reason: "长桥离线；本轮仅使用上次同步快照",
          });
          publishPortfolioForAuthorization(analysisPortfolio, {
            authorizationGeneration: agentAuthorizationGeneration,
            scopeId: agentPortfolioScopeId,
          });
        }
      }
      if (controller.signal.aborted) throw new Error("Codex 分析已取消。");
      const evidenceStartedAt = Date.now();
      let localRun;
      if (scope === "review") {
        const reviewArchive = await tradeHistoryService.cached();
        if (reviewCycleId) {
          let cycleWorkspace = await reviewCycleStore.snapshot({
            cycleId: reviewCycleId,
            phase: reviewPhase,
          });
          let cycle = cycleWorkspace.cycles.find((item) => item.id === reviewCycleId);
          if (!cycle) throw new Error("未找到复盘周期。");
          if (reviewPhase !== "blind") {
            cycle = await hydrateCyclePortfolioSnapshots(cycle);
            cycleWorkspace = {
              ...cycleWorkspace,
              cycles: cycleWorkspace.cycles.map((item) => item.id === cycle.id ? cycle : item),
            };
          }
          const pointInTimeTechnical = await buildCyclePointInTimeTechnical({
            cycle,
            archive: reviewArchive,
            phase: reviewPhase,
            signal: controller.signal,
          });
          const deterministicOutcomeMetrics = reviewPhase !== "blind"
            ? await buildReviewCycleOutcomeMetrics({
              cycle,
              archive: reviewArchive,
              loadCandles: (value, count, options) => portfolioService.candlesWithCoverage(value, count, {
                ...options,
                preferPersistent: true,
              }),
              signal: controller.signal,
            })
            : null;
          const technicalValidation = reviewPhase !== "blind" && deterministicOutcomeMetrics
            ? await buildCycleTechnicalValidationSample({
                cycle,
                deterministicOutcomeMetrics,
              })
            : null;
          localRun = buildReviewCycleAnalysisRun({
            workspace: cycleWorkspace,
            archive: reviewArchive,
            cycleId: reviewCycleId,
            phase: reviewPhase,
            runId: randomUUID(),
            task,
            portfolio: reviewPhase !== "blind" ? analysisPortfolio : null,
            pointInTimeTechnical,
            deterministicOutcomeMetrics,
            technicalValidation,
            reconciliation: reviewPhase !== "blind" ? buildCycleReconciliationEvidence(cycle, deterministicOutcomeMetrics) : null,
          });
          if (reviewPhase !== "blind") {
            const researchWorkspace = await researchThesisStore.snapshot({ includeArchived: true });
            localRun.analysisContext.researchReferences = buildLinkedResearchReferences({
              theses: researchWorkspace.theses, cycleId: reviewCycleId,
              accountScopeId: cycle?.brokerLinks?.accountScopeId, phase: reviewPhase,
            });
          }
        }
      } else {
        const technicalRadar = scope === "portfolio"
          ? await technicalRadarForPortfolioAnalysis(analysisPortfolio, agentPortfolioScopeId).catch(() => null)
          : null;
        const technicalLinkage = ["position", "candidate"].includes(scope) && symbol
          ? await technicalLinkageStore.get(symbol).catch(() => null)
          : null;
        localRun = await buildAnalysisEvidence({
          portfolio: analysisPortfolio,
          scope,
          symbol,
          task,
          riskBudgetPercent,
          technicalRadar,
          technicalLinkage,
          loadCandles: (value) => portfolioService.candlesWithCoverage(value, 1000, {
            signal: controller.signal,
            requireLive: true,
          }),
          loadMarketSeries: (value, descriptor = {}) => portfolioService.marketSeriesWithCoverage(
            value,
            descriptor.period ?? "1h",
            descriptor.count ?? 240,
            {
              signal: controller.signal,
              requireLive: true,
            },
          ),
          signal: controller.signal,
          onStage: ({ phase, message }) => sendStatus({
            domain: "agent",
            state: "agent_running",
            active: true,
            threadId,
            operationId,
            phase,
            message,
          }),
        });
        if (researchThesisId) {
          const workspace = await researchThesisStore.snapshot({ includeArchived: true });
          const thesis = workspace.theses.find(item => item.id === researchThesisId);
          if (!thesis || thesis.status === "archived") throw new Error("该研究记录不存在或已归档；请返回研究主线选择活动记录。");
          localRun.context.researchThesisId = thesis.id;
          localRun.context.researchThesisRevision = thesis.revision;
          localRun.context.researchTitle = thesis.name;
          localRun.context.researchIntent = request?.researchIntent === "update" ? "update" : "discuss";
          localRun.analysisContext.researchThesis = buildResearchThesisContext(thesis);
        }
      }
      if (scope === "review") {
        sendStatus({
          domain: "agent",
          state: "agent_running",
          active: true,
          threadId,
          operationId,
          phase: "review_evidence_ready",
          message: reviewCycleId
            ? reviewPhase === "blind"
              ? "已建立时间防火墙并汇总截止点以前的周期证据"
              : reviewPhase === "retrospective"
                ? "已从真实订单与成交建立直接事后复盘证据；没有伪造事前基线"
                : "已引用冻结的阶段一评估，并汇总周期结束后的结果证据"
            : "已汇总关联订单、成交、财报事件与版本化事前记录",
        });
      }
      const evidenceMs = Date.now() - evidenceStartedAt;
      if (!["review", "chat"].includes(scope)) {
        localRun.context.brokerScope = requestedBrokerScope;
        localRun.context.brokerAccounts = (analysisPortfolio.brokerAccounts ?? []).map((a) => ({
          broker: a.broker, label: a.accountLabel, scopeId: a.scopeId, syncedAt: a.syncedAt,
          netAssetsUsd: a.netAssets, cashUsd: a.totalCash, buyingPowerUsd: a.buyPower,
          initialMarginUsd: a.initMargin, maintenanceMarginUsd: a.maintenanceMargin,
          status: a.status, readyForSizing: a.readyForSizing,
        }));
        if (multiBrokerAnalysis) {
          localRun.context.brokerDataLimitations = [
            "当前使用发送时所选账户快照；切换左栏不会改变本轮上下文。",
            "各账户购买力、保证金与现金可用性独立，不能跨券商抵扣。",
            "IBKR 数量/账户估值与期权行情分开；延迟、冻结、缺失 Greeks 不得当成实时。",
            "IBKR 历史订单和每日收盘快照尚未接入原长桥复盘账本。",
          ];
          for (const item of localRun.evidence ?? []) {
            if (["account_balance", "stock_positions", "quote", "option_quote", "exchange_rate"].includes(item.tool)) {
              item.source = analysisPortfolio.source;
              item.tool = requestedBrokerScope === "ibkr" ? "ibkr_portfolio" : "broker_portfolio_aggregate";
              item.summary = String(item.summary ?? "").replaceAll("长桥", requestedBrokerScope === "ibkr" ? "IBKR" : "各券商");
            }
          }
        }
      }
      safeSend("cockpit:agent-stream", {
        kind: "evidence_ready",
        threadId,
        operationId,
        message: scope === "chat" ? "自由研究请求已准备，Codex 正在回应；本轮未自动读取账户或行情。" : `只读证据已就绪 · ${evidenceMs}ms；Codex 正在组织结论`,
      });
      const codexStartedAt = Date.now();
      const modelAnalysis = await codexAnalysis.analyze({
        portfolio: analysisPortfolio,
        run: localRun,
        task,
        threadId,
        operationId,
        signal: controller.signal,
      });
      const codexCompletedAt = Date.now();
      let postModelRefreshMs = 0;
      if (scope === "candidate" && !multiBrokerAnalysis && longbridge.connected && !controller.signal.aborted) {
        const refreshStartedAt = Date.now();
        sendStatus({
          domain: "agent",
          state: "agent_running",
          active: true,
          threadId,
          operationId,
          phase: "host_revalidation",
          message: "Codex 方案已返回；正在用最新账户、购买力、行情与汇率重新裁剪数值",
        });
        try {
          const refreshOutcome = await Promise.race([
            refreshPortfolioFromLongbridge({
              authorizationGeneration: agentAuthorizationGeneration,
            }).then((nextPortfolio) => ({ portfolio: nextPortfolio })),
            abortableDelay(AGENT_PORTFOLIO_REFRESH_WAIT_MS, controller.signal)
              .then(() => ({ timedOut: true })),
          ]);
          if (refreshOutcome.portfolio) {
            analysisPortfolio = refreshOutcome.portfolio;
            const authorization = publishRefreshedPortfolio(analysisPortfolio, { scheduleEvidence: true });
            agentPortfolioScopeId = authorization.scopeId;
            localRun = await buildAnalysisEvidence({
              portfolio: analysisPortfolio,
              scope,
              symbol,
              task,
              riskBudgetPercent,
              technicalLinkage: symbol
                ? await technicalLinkageStore.get(symbol).catch(() => null)
                : null,
              loadCandles: (value) => portfolioService.candlesWithCoverage(value, 1000, {
                signal: controller.signal,
                requireLive: true,
              }),
              loadMarketSeries: (value, descriptor = {}) => portfolioService.marketSeriesWithCoverage(
                value,
                descriptor.period ?? "1h",
                descriptor.count ?? 240,
                {
                  signal: controller.signal,
                  requireLive: true,
                },
              ),
              signal: controller.signal,
            });
          } else if (refreshOutcome.timedOut) {
            sendStatus({
              domain: "agent",
              state: "agent_notice",
              active: true,
              threadId,
              operationId,
              phase: "host_revalidation_degraded",
              message: "最新账户重算超过等待窗口；保留研究结论，但可执行仓位继续按过期规则关闭",
            });
          }
        } catch (error) {
          sendStatus({
            domain: "agent",
            state: "agent_notice",
            active: true,
            threadId,
            operationId,
            phase: "host_revalidation_degraded",
            message: "最新账户重算失败；保留研究结论，但不放行过期仓位数值",
            detail: safeError(error),
          });
        }
        postModelRefreshMs = Date.now() - refreshStartedAt;
      }
      const run = {
        ...applyCodexWorkspaceAnalysis(localRun, modelAnalysis),
        operationId,
      };
      if (researchThesisId && run.researchProposal && !controller.signal.aborted) {
        try {
          const thesis = await withReviewLearningMutation(() => {
            assertTrustedRestoreIdle();
            return researchThesisStore.saveProposal(researchThesisId, {
              expectedRevision: localRun.context.researchThesisRevision,
              proposal: run.researchProposal, sourceRunId: run.id,
              sourceThreadId: modelAnalysis.threadId ?? threadId,
              commitGuard: () => { assertTrustedRestoreIdle(); return true; },
            });
          });
          run.context.researchProposalId = thesis.proposals.at(-1)?.id ?? null;
          run.context.researchProposalPersistence = "recorded_pending_confirmation";
        } catch (error) {
          // A newer user edit must not be overwritten, and a draft-save
          // failure must never hide a successfully delivered model answer.
          run.context.researchProposalPersistence = "not_saved";
          run.context.researchProposalPersistenceError = safeError(error);
          run.evidence.push({ source: "研究主线", tool: "research:proposal", status: "degraded", records: 0,
            summary: "研究回答已保留，但草案未保存；可能已有更新版本。请回到研究主线刷新后重新生成，原判断未改变。" });
        }
      }
      if (scope !== "chat" && requestedBrokerScope !== "ibkr") longbridgeAuthorizationLifecycle.assertCurrent(agentAuthorizationGeneration);
      if (scope !== "chat" && requestedBrokerScope !== "ibkr" && agentPortfolioScopeId !== currentPortfolioLedgerScopeId()) {
        throw new Error("长桥账户范围已在分析期间变化；旧账户结论未发布，请重新运行 Agent。");
      }
      if (scope !== "chat" && multiBrokerAnalysis && ibkrGeneration !== ibkr.generation) {
        throw new Error("IBKR 账户配置已在分析期间变化，旧账户结果已隔离，请重新运行。");
      }
      run.performance = {
        portfolioRefreshMs,
        evidenceMs,
        codexFirstActivityMs: modelAnalysis.firstActivityMs,
        codexMs: codexCompletedAt - codexStartedAt,
        postModelRefreshMs,
        endToEndMs: Date.now() - requestStartedAt,
      };
      if (run.context?.reviewProtocol === "decision_cycle") {
        try {
          const phaseRun = await withReviewLearningMutation(() => reviewCycleStore.recordPhaseRun({
            cycleId: run.context.reviewCycleId,
            phase: run.context.reviewPhase,
            status: "completed",
            threadId: modelAnalysis.threadId ?? threadId,
            startedAt: new Date(requestStartedAt).toISOString(),
            completedAt: new Date().toISOString(),
            model: modelAnalysis.model ?? null,
            expectedEvidenceRevision: run.context.reviewEvidenceRevision,
            expectedRetrospectiveVersion: run.context.reviewRetrospectiveVersion,
            expectedInputSnapshotHash: run.context.reviewInputSnapshotHash,
            evidenceFilterPolicyVersion: 2,
            result: {
              runId: run.id,
              operationId,
              conclusion: run.conclusion ?? null,
              learningProposal: run.learningProposal ?? null,
              researchReferences: run.analysisContext?.researchReferences ?? null,
              actualSkillVersions: run.modelAnalysis?.actualSkillVersions ?? [],
              postRunSkillVersions: run.modelAnalysis?.postRunSkillVersions ?? [],
              skillReproducibility: run.modelAnalysis?.skillReproducibility ?? null,
              tradePricePathSummary: summarizeTradePricePath(
                run?.analysisContext?.deterministicOutcomeMetrics,
              ),
              technicalValidation: run?.analysisContext?.technicalValidation ?? null,
              reconciliation: run?.analysisContext?.reconciliation ?? null,
            },
          }));
          run.context.reviewPhaseRunId = phaseRun.id;
          run.context.reviewPhasePersistence = "recorded";
          run.context.blindAssessmentId = run.context.reviewPhase === "blind"
            ? phaseRun.id
            : run.context.blindAssessmentId;
        } catch (error) {
          run.context.reviewPhasePersistence = "failed";
          run.context.reviewPhasePersistenceError = safeError(error);
          run.evidence = [
            ...(Array.isArray(run.evidence) ? run.evidence : []),
            {
              source: "本机加密决策周期台账",
              tool: "review:cycle-phase-ledger",
              asOf: new Date().toISOString(),
              records: 0,
              status: "failed",
              summary: `Codex 结论已完成，但阶段记录未写入：${safeError(error)}`,
            },
          ];
          sendStatus({
            domain: "agent",
            state: "agent_notice",
            active: true,
            threadId,
            operationId,
            message: "分析已完成，但复盘阶段台账写入失败；本次结论仍会返回，阶段二不会误解锁",
            detail: safeError(error),
          });
        }
      }
      const resultEnvelope = {
        threadId: modelAnalysis.threadId ?? threadId,
        operationId,
        completedAt: new Date().toISOString(),
        run,
      };
      // Tombstone the operation and publish the answer before any encrypted
      // recovery write. This closes the stale activeAgents race and makes disk
      // persistence independent from the renderer completion handshake.
      settleActiveAgentOperation({ threadId, operationId });
      const persistence = agentResults.save(resultEnvelope).catch((error) => sendStatus({
        domain: "agent",
        state: "agent_notice",
        active: false,
        threadId,
        operationId,
        message: `结果已生成，但本地恢复副本保存失败：${safeError(error)}`,
      }));
      void persistence;
      safeSend("cockpit:agent-result", resultEnvelope);
      sendStatus({
        domain: "agent",
        state: "agent_complete",
        active: false,
        threadId,
        operationId,
        message: `Codex Agent 已完成 ${targetLabel} 分析`,
      });
      return run;
    } catch (error) {
      settleActiveAgentOperation({ threadId, operationId });
      safeSend("cockpit:agent-result", {
        threadId,
        operationId,
        failedAt: new Date().toISOString(),
        ...agentFailureEnvelope(error),
      });
      sendStatus({
        domain: "agent",
        state: "agent_error",
        active: false,
        threadId,
        operationId,
        message: `Codex Agent 未完成 ${targetLabel} 分析`,
        detail: safeError(error),
      });
      throw error;
    } finally {
      codexAnalysis.clearPendingOperation({ threadId, operationId });
      settleActiveAgentOperation({ threadId, operationId });
    }
  });

  ipcMain.handle("agent:cancel", async (event, request) => {
    assertTrustedSender(event);
    const operationId = validateOperationId(request?.operationId)
      ?? activeAgentByThread.get(validateThreadId(request?.threadId ?? codexAnalysis.status().threadId));
    const operation = operationId ? activeAgentOperations.get(operationId) : null;
    if (!operation) return { ok: false, message: "该对话当前没有正在运行的 Agent。" };
    const { threadId, controller } = operation;
    controller.abort(new Error("Codex 分析已取消。"));
    const codexWasActive = codexAnalysis.status().activeThreads
      .some((item) => item.threadId === threadId && item.operationId === operationId);
    const turnCancelled = await codexAnalysis.cancel({ threadId, operationId }).catch(() => false);
    if (codexWasActive && !turnCancelled) {
      sendStatus({
        domain: "agent",
        state: "agent_running",
        active: true,
        threadId,
        operationId,
        message: "检测到 Codex 已完成，正在从持久线程回收结果…",
      });
      return { ok: false, completed: true, message: "结果已经完成，正在回收，不再执行取消。" };
    }
    sendStatus({
      domain: "agent",
      state: "agent_running",
      active: true,
      threadId,
      operationId,
      message: "正在取消 Agent 分析…",
    });
    return { ok: true, turnCancelled };
  });

  ipcMain.handle("agent:save-plan", async (event, run) => {
    assertTrustedSender(event);
    assertTrustedRestoreIdle();
    const scope = validateAnalysisScope(run?.context?.scope);
    if (["review", "chat"].includes(scope)) {
      throw new Error("研究与复盘结论不保存为当前可执行交易计划。");
    }
    if (!run?.id || !run?.plan || (scope !== "portfolio" && !run?.context?.symbol)) {
      throw new Error("计划数据无效。");
    }
    if (!portfolio
      || run.context.snapshotAt !== portfolio.syncedAt
      || run.context.valuationSchemaVersion !== portfolio.valuationSchemaVersion
      || run.context.valuationGateInputHash !== portfolio.valuationGate?.inputHash
      || run.context.valuationGateHash !== portfolio.valuationGate?.hash) {
      throw new Error("计划对应的持仓快照已失效，请重新运行 Agent。");
    }
    if (!portfolioFreshness(portfolio).freshForSizing) {
      throw new Error("持仓快照已超过 2 分钟或来自缓存；请先同步长桥再保存计划。");
    }
    if (scope === "position" && !portfolio.positions.some((item) => item.symbol === run.context.symbol)) {
      throw new Error("计划标的不在当前真实持仓中。");
    }
    const plans = (await businessStateStore.get("watchPlans")) ?? [];
    plans.unshift({
      id: String(run.id),
      createdAt: String(run.createdAt),
      context: run.context,
      conclusion: run.conclusion,
      modelAnalysis: run.modelAnalysis ?? null,
      risk: run.risk,
      plan: run.plan,
      orderWrite: false,
    });
    await businessStateStore.set("watchPlans", plans.slice(0, 100));
    return { ok: true, count: Math.min(plans.length, 100) };
  });

  ipcMain.on("tv:set-bounds", (event, bounds) => {
    if (!isTrustedSender(event)) return;
    setTvBounds(bounds);
  });
  ipcMain.handle("tv:reload", (event) => {
    assertTrustedSender(event);
    tvView.webContents.reload();
  });
  ipcMain.handle("tv:home", async (event) => {
    assertTrustedSender(event);
    const saved = await businessStateStore.get("tradingViewLastUrl");
    await tvView.webContents.loadURL(isTradingViewUrl(saved) ? saved : DEFAULT_TV_URL);
  });
  ipcMain.handle("tv:load-symbol", async (event, tvSymbol) => {
    assertTrustedSender(event);
    const symbol = String(tvSymbol ?? "").toUpperCase();
    if (!/^[A-Z0-9._:-]{1,40}$/.test(symbol)) throw new Error("TradingView symbol 无效。");
    const current = tvView.webContents.getURL();
    const target = new URL(isTradingViewUrl(current) ? current : DEFAULT_TV_URL);
    target.searchParams.set("symbol", symbol);
    await tvView.webContents.loadURL(target.toString());
    return { ok: true };
  });
}

function setTvBounds(value) {
  if (!tvView || !mainWindow || !value || workspaceMode !== "cockpit") return;
  const content = mainWindow.getContentBounds();
  const x = clamp(Math.round(Number(value.x)), 0, content.width - 200);
  const y = clamp(Math.round(Number(value.y)), 0, content.height - 200);
  const width = clamp(Math.round(Number(value.width)), 200, content.width - x);
  const height = clamp(Math.round(Number(value.height)), 200, content.height - y);
  if (![x, y, width, height].every(Number.isFinite)) return;
  lastTvBounds = { x, y, width, height };
  tvView.setBounds(lastTvBounds);
}

async function buildResearchSnapshot() {
  const [workspace, cycles] = await Promise.all([
    researchThesisStore.snapshot({ includeArchived: true }), reviewCycleStore.snapshot(),
  ]);
  const scopeId = currentPortfolioLedgerScopeId();
  return { ...workspace, accountScopeId: scopeId,
    reviewCycles: eligibleResearchReviewCycles(cycles.cycles, scopeId) };
}

async function buildReviewSnapshot(intakeOptions = {}) {
  const identity = captureReviewAccountOperation();
  const snapshotUpdateSequence = reviewSnapshotPublisher.nextSequence();
  const [storedWorkspace, cycleWorkspace, broker, intake, portfolioSnapshots] = await Promise.all([
    reviewStore.snapshot(),
    reviewCycleStore.snapshot(),
    tradeHistoryService.cached(),
    tradeHistoryService.intake(intakeOptions),
    portfolioSnapshotLedgerStatus(),
  ]);
  const workspace = reconcileSampleEvidenceIdentities(storedWorkspace, { cycles: cycleWorkspace.cycles });
  const brokerMatches = Object.fromEntries(workspace.cases.map((reviewCase) => [
    reviewCase.id, legacyCaseBrokerMatches(reviewCase, broker),
  ]));
  const ruleMetrics = Object.fromEntries(workspace.rules.map((rule) => [
    rule.id,
    calculateRuleMetrics(workspace, rule.id),
  ]));
  const cycleSnapshotCoverage = await portfolioSnapshotCoverageForCycles(cycleWorkspace.cycles);
  const cycles = cycleWorkspace.cycles.map((cycle) => {
    const cycleAccountScopeId = cycle?.brokerLinks?.accountScopeId ?? null;
    const accountScopeMatches = !broker.accountScopeId || cycleAccountScopeId === broker.accountScopeId;
    const orderIds = new Set(cycle?.brokerLinks?.orderIds ?? []);
    const executionIds = new Set(cycle?.brokerLinks?.executionIds ?? []);
    const rawOrders = accountScopeMatches
      ? broker.orders.filter((item) => orderIds.has(item.orderId))
      : [];
    const rawExecutions = accountScopeMatches
      ? broker.executions.filter((item) => executionIds.has(item.tradeId))
      : [];
    const executionEligibility = partitionReviewExecutions(rawExecutions, rawOrders);
    const archiveExecutionEligibility = partitionReviewExecutions(
      broker.executions,
      broker.orders,
    );
    const orderEligibility = partitionReviewOrders(
      rawOrders,
      archiveExecutionEligibility.included,
    );
    const excludedAuditRecordCount = orderEligibility.excluded.length + executionEligibility.excluded.length;
    return {
      ...cycle,
      portfolioSnapshotCoverage: cycleSnapshotCoverage[cycle.id] ?? null,
      brokerEvidenceAudit: {
        evidenceFilterPolicyVersion: 2,
        accountScopeStatus: accountScopeMatches
          ? (cycleAccountScopeId ? "matched" : "legacy_unbound")
          : "mismatch",
        accountScopeBound: Boolean(cycleAccountScopeId),
        excludedAuditRecordCount,
        excludedOrderCount: orderEligibility.excluded.length,
        excludedExecutionCount: executionEligibility.excluded.length,
        excludedOrderReasons: reviewExclusionReasonCounts(orderEligibility.excluded),
        excludedExecutionReasons: reviewExclusionReasonCounts(executionEligibility.excluded),
        requiresPolicyV2Run: excludedAuditRecordCount > 0,
      },
      brokerRecords: [
        ...orderEligibility.included.map((item) => ({
          recordId: `order:${item.orderId}`,
          kind: "order",
          symbol: item.symbol,
          side: item.side,
          status: item.status,
          orderType: item.orderType,
          quantity: item.quantity,
          executedQuantity: item.executedQuantity,
          submittedPrice: item.submittedPrice,
          executedPrice: item.executedPrice,
          price: item.executedPrice ?? item.submittedPrice,
          currency: item.currency,
          activityAt: item.submittedAt ?? item.updatedAt,
          source: "Longbridge · read only",
        })),
        ...executionEligibility.included.map((item) => ({
          recordId: `execution:${item.tradeId}`,
          relatedOrderRecordId: item.orderId ? `order:${item.orderId}` : null,
          kind: "execution",
          symbol: item.symbol,
          side: item.side,
          status: "filled",
          quantity: item.quantity,
          executedQuantity: item.quantity,
          price: item.price,
          reportedPrice: item.reportedPrice,
          priceAudit: item.priceAudit ?? null,
          currency: item.currency,
          activityAt: item.doneAt,
          source: "Longbridge · read only",
        })),
      ],
    };
  });
  const learningWorkspace = annotateLearningSources(workspace, cycleWorkspace);
  const validationReport = buildValidationCandidateReport({
    tests: learningWorkspace.tests,
    cycles,
  });
  assertReviewAccountOperation(identity);
  return {
    ...learningWorkspace,
    accountScopeId: identity.scopeId,
    snapshotUpdateSequence,
    cycles,
    validationCandidates: validationReport.candidatesByTest,
    validationCandidateExclusions: validationReport.exclusionsByTest,
    cycleRevision: cycleWorkspace.revision,
    cycleUpdatedAt: cycleWorkspace.updatedAt,
    reviews: workspace.ruleReviews,
    broker: {
      syncedAt: broker.syncedAt,
      range: broker.range,
      capabilities: broker.capabilities,
      completeness: broker.completeness,
      parentOrderBackfill: broker.parentOrderBackfill ?? null,
      warnings: broker.warnings,
      orderCount: broker.orders.length,
      executionCount: broker.executions.length,
    },
    portfolioSnapshots,
    intake,
    brokerMatches,
    ruleMetrics,
    summary: {
      cycleCount: cycleWorkspace.cycles.length,
      activeCycleCount: cycleWorkspace.cycles.filter((item) => (
        item.status !== "cancelled" && !cycleCurrentReviewComplete(item)
      )).length,
      blindReviewedCycleCount: cycleWorkspace.cycles.filter((item) => item.phaseRuns?.blind?.some((run) => run.status === "completed")).length,
      completedCycleCount: cycleWorkspace.cycles.filter(cycleCurrentReviewComplete).length,
      caseCount: workspace.cases.length,
      legacyCaseCount: workspace.cases.length,
      migratedCaseCount: new Set(cycleWorkspace.cycles.map(item => item.legacySource?.sourceCaseId).filter(Boolean)).size,
      frozenCount: workspace.cases.filter((item) => item.exAnteVersions?.length).length,
      reviewDueCount: cycleWorkspace.cycles.filter((item) => item.status !== "cancelled" && !cycleCurrentReviewComplete(item)).length,
      testCount: workspace.tests.length,
      completedTestCount: workspace.tests.filter((item) => item.status === "completed").length,
      ruleCount: workspace.rules.length,
      validatedRuleCount: workspace.rules.filter((item) => item.status === "validated").length,
      brokerOrderCount: broker.orders.length,
      brokerExecutionCount: broker.executions.length,
    },
  };
}

function reviewExclusionReasonCounts(excluded) {
  const counts = {};
  for (const item of excluded) {
    const reason = String(item?.reason ?? "unverified");
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

async function assertReviewLearningMutationSource({ testId = null, ruleId = null } = {}) {
  const [workspace, cycleWorkspace] = await Promise.all([
    reviewStore.snapshot(),
    reviewCycleStore.snapshot(),
  ]);
  const item = testId
    ? workspace.tests.find((candidate) => String(candidate?.id ?? "") === String(testId ?? ""))
    : workspace.rules.find((candidate) => String(candidate?.id ?? "") === String(ruleId ?? ""));
  if (!item) throw new Error("未找到对应的验证记录。");
  const hasProtocol = testId
    ? item.testKind === "protocol"
    : workspace.tests.some(candidate => candidate.testKind === "protocol"
      && (candidate.ruleId === item.id || item.testIds?.includes(candidate.id)));
  if (!hasProtocol) throw legacyReviewWriteError("独立旧测试和旧规则仅保留只读档案；请从周期复盘的 AI 草案开始新验证。");
  const validationPackage = workspace.validationPackages.find((candidate) => (
    String(candidate?.id ?? "") === String(item?.validationPackageId ?? "")
  ));
  const source = validationPackage ?? item;
  assertLearningSourceCurrent(source, cycleWorkspace);
  return { workspace, cycleWorkspace };
}

async function assertReviewObservationCycle({ testId, reviewCycleId } = {}) {
  const requestedCycleId = String(reviewCycleId ?? "").trim();
  if (!requestedCycleId) throw new Error("请明确选择已完成的复盘周期，不能向旧案例追加观察。");
  const snapshot = await buildReviewSnapshot();
  const test = snapshot.tests.find((item) => String(item?.id ?? "") === String(testId ?? ""));
  if (!test || test.testKind !== "protocol") throw legacyReviewWriteError("只有验证中心的协议可以登记周期观察。");
  if (requestedCycleId === String(test?.sourceReviewCycleId ?? "")) {
    throw new Error("形成假设的来源周期不能同时作为样本外验证；请选择后续复盘周期。");
  }
  const candidate = snapshot.validationCandidates?.[String(testId ?? "")]?.find((item) => (
    String(item?.cycleId ?? "") === requestedCycleId
  ));
  if (!candidate) throw new Error("所选周期不是当前验证的有效候选；它可能尚未完成、证据已更新、已经纳入或属于假设来源。");
  return {
    cycleId: requestedCycleId,
    timing: candidate.timing ?? "unknown",
    technicalValidation: candidate.technicalValidation ?? null,
    canonicalEvidenceIdentity: candidate.canonicalEvidenceIdentity,
    cycles: snapshot.cycles,
  };
}

async function resolveVerifiedProtocolSample({ testId, reviewCycleId } = {}) {
  const requestedTestId = String(testId ?? "").trim();
  const requestedCycleId = String(reviewCycleId ?? "").trim();
  if (!requestedTestId || !requestedCycleId) {
    throw new Error("正式样本需要验证协议和复盘周期。");
  }
  const [workspace, cycleWorkspace] = await Promise.all([
    reviewStore.snapshot(),
    reviewCycleStore.snapshot(),
  ]);
  const test = workspace.tests.find((item) => String(item?.id ?? "") === requestedTestId);
  if (!test || test.testKind !== "protocol") throw new Error("未找到可登记样本的验证协议。");
  if (requestedCycleId === String(test.sourceReviewCycleId ?? "")) {
    throw new Error("形成假设的来源周期不能作为样本外验证。");
  }
  const cycle = cycleWorkspace.cycles.find((item) => String(item?.id ?? "") === requestedCycleId);
  if (!cycle) throw new Error("未找到候选复盘周期。");
  const candidate = buildValidationCandidateIndex({
    tests: [test],
    cycles: cycleWorkspace.cycles,
  })[requestedTestId]?.find((item) => item.cycleId === requestedCycleId);
  if (!candidate || candidate.timing !== "forward") {
    throw new Error("该周期不是冻结协议之后开始的前向候选，只能作为探索样本。");
  }
  const phaseRun = currentValidationReviewRun(cycle);
  if (!phaseRun) throw new Error("该周期没有引用当前证据版本的已完成复盘结果。");
  const source = await reviewCycleStore.validatePhaseRunSource({
    cycleId: requestedCycleId,
    runId: phaseRun.id,
  });
  if (!source.isCurrent) {
    throw new Error(`复盘结果已过期：${source.reasons.join("、") || "证据版本已变化"}`);
  }
  const technical = phaseRun?.result?.technicalValidation;
  const protocolPackage = workspace.validationPackages.find((item) => (
    String(item?.testId ?? "") === requestedTestId
  ));
  const protocolHash = String(
    protocolPackage?.proposalHash ?? protocolPackage?.sourceProposalHash ?? "",
  ).toLowerCase();
  const resultHash = String(technical?.resultHash ?? "").toLowerCase();
  const phaseResultHash = String(phaseRun?.resultHash ?? "").toLowerCase();
  const entryCutoffAt = technical?.cycle?.entryCutoffAt ?? candidate?.technicalValidation?.entryCutoffAt;
  const protocolAt = test.observationStartedAt ?? test.registeredAt;
  if (!/^[a-f0-9]{64}$/.test(protocolHash)) {
    throw new Error("验证协议缺少冻结内容哈希，不能升级为正式样本。");
  }
  if (!Number.isFinite(Date.parse(String(entryCutoffAt ?? "")))
      || !Number.isFinite(Date.parse(String(protocolAt ?? "")))
      || Date.parse(protocolAt) >= Date.parse(entryCutoffAt)) {
    throw new Error("协议必须严格早于所选 Buy，当前周期只能作为历史校准。");
  }
  if (technical?.status !== "complete"
      || technical?.sampleCandidate?.status !== "available"
      || !/^[a-f0-9]{64}$/.test(resultHash)
      || !/^[a-f0-9]{64}$/.test(phaseResultHash)) {
    throw new Error("该周期的技术快照、确定性结果或结果哈希不完整，不能纳入正式样本。");
  }
  const evidenceRevision = Number(phaseRun.evidenceRevision);
  if (!Number.isInteger(evidenceRevision) || evidenceRevision <= 0
      || evidenceRevision !== Number(cycle.evidenceRevision ?? cycle?.brokerLinks?.evidenceRevision)) {
    throw new Error("复盘结果与当前券商证据版本不一致。");
  }
  const realizedR = technical?.riskR?.realized?.status === "available"
    ? finiteOrNull(technical.riskR.realized.value)
    : null;
  if (realizedR == null) {
    throw new Error("该周期没有事前风险口径下的已核验净 R；不能用收益率或盈亏事后换算成 R。");
  }
  return {
    testId: requestedTestId,
    reviewCycleId: requestedCycleId,
    canonicalEvidenceIdentity: candidate.canonicalEvidenceIdentity,
    cycles: cycleWorkspace.cycles,
    outcomeR: realizedR,
    benchmarkReturnPercent: null,
    verification: {
      engine: "review_cycle_phase_run_v1",
      sourceRunId: phaseRun.id,
      sourceEvidenceRevision: evidenceRevision,
      resultHash: phaseResultHash,
      sourceCompletedAt: phaseRun.completedAt,
    },
    technicalValidationRef: {
      status: "complete",
      sampleStatus: "available",
      sampleId: technical.sampleCandidate.sampleId,
      resultHash,
      ruleKey: technical?.ruleCandidate?.ruleKey ?? null,
      radarTradingDate: technical?.entrySnapshot?.batch?.tradingDate ?? null,
      radarRecordedAt: technical?.entrySnapshot?.batch?.recordedAt ?? null,
      entryCutoffAt,
      exitAt: technical?.cycle?.exitAt ?? null,
      protocolTiming: "forward",
      validationMode: "walk_forward",
      eligibleForFormalStatistics: true,
      formalEligibilityReason: `冻结协议 ${protocolHash.slice(0, 12)}… 严格早于交易入场；宿主已核验当前证据版本、确定性净 R 与技术结果哈希。`,
    },
    notes: "由宿主从持久化周期运行登记；renderer 未提供任何数值型结果。",
  };
}

function cycleCurrentReviewComplete(cycle) {
  return Boolean(currentValidationReviewRun(cycle));
}

function withReviewLearningMutation(operation) {
  const mutation = reviewLearningMutationQueue.then(operation, operation);
  reviewLearningMutationQueue = mutation.then(() => undefined, () => undefined);
  return mutation;
}

async function prepareLegacyCaseMigration(caseId, identity) {
  const [workspace, cycleWorkspace] = await Promise.all([reviewStore.snapshot(), reviewCycleStore.snapshot()]);
  assertReviewAccountOperation(identity);
  const reviewCase = workspace.cases.find(item => item.id === String(caseId ?? "").trim());
  if (!reviewCase) throw new Error("未找到历史案例。");
  if (!reviewCase.brokerLinks?.accountScopeId) {
    throw new Error("该历史案例没有账户绑定，不能猜测原订单归属。原记录仍可查看；请从当前账户的订单证据建立新周期。");
  }
  if (reviewCase.brokerLinks.accountScopeId !== identity.scopeId) throw stalePortfolioAccountScopeError();
  const existing = cycleWorkspace.cycles.find(item => item.legacySource?.sourceCaseId === reviewCase.id
    && item.legacySource?.accountScopeId === identity.scopeId);
  let selection = null;
  if (!existing) {
    const archive = await tradeHistoryService.cached();
    assertReviewAccountOperation(identity);
    if (archive.accountScopeId !== identity.scopeId) throw stalePortfolioAccountScopeError();
    selection = await tradeHistoryService.resolveBrokerRecords({ recordIds: [
      ...(reviewCase.brokerLinks.orderIds ?? []).map(id => `order:${id}`),
      ...(reviewCase.brokerLinks.executionIds ?? []).map(id => `execution:${id}`),
    ] });
    selection = { ...selection, accountScopeId: archive.accountScopeId };
    assertReviewAccountOperation(identity);
  }
  return buildLegacyCaseMigration({ reviewCase, selection, accountScopeId: identity.scopeId,
    now: new Date(), existingCycles: cycleWorkspace.cycles });
}

function positiveMainInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function assertCycleBrokerSelection(cycle, selection) {
  const type = String(cycle?.cycleType ?? cycle?.type ?? "");
  assertCycleBrokerSymbols(cycle, selection);
  const startMs = Date.parse(String(cycle?.startAt ?? ""));
  const endMs = Date.parse(String(cycle?.endAt ?? ""));
  if (!Number.isFinite(startMs)) throw new Error("复盘周期缺少有效开始时间。");
  const effectiveEndMs = Number.isFinite(endMs) ? endMs : Date.now();
  const requested = new Set(selection?.requestedRecordIds ?? []);
  const outside = (selection?.records ?? []).filter((record) => {
    if (!requested.has(record.recordId)) return false;
    const timeMs = Date.parse(String(record.activityAt ?? ""));
    return !Number.isFinite(timeMs) || timeMs < startMs || timeMs > effectiveEndMs;
  });
  if (outside.length) throw new Error("所选长桥记录不在该复盘周期的开始与结束范围内。");
}

function assertCycleBrokerSymbols(cycle, selection) {
  const type = String(cycle?.cycleType ?? cycle?.type ?? "");
  const allowedSymbols = new Set((cycle?.symbols ?? []).map((item) => String(item).toUpperCase()));
  const relatedSymbols = (selection?.relatedSymbols ?? []).map((item) => String(item).toUpperCase());
  if (type !== "monthly_portfolio" && relatedSymbols.some((symbol) => !allowedSymbols.has(symbol))) {
    throw new Error("所选长桥记录包含复盘周期范围外的标的，已拒绝关联。");
  }
}

function brokerLinksFromSelection(selection, accountScopeId = null) {
  return {
    accountScopeId,
    requestedRecordIds: selection.requestedRecordIds ?? [],
    recordIds: selection.recordIds,
    orderIds: selection.orderIds,
    executionIds: selection.executionIds,
    records: selection.records.map((item) => ({
      id: item.recordId,
      kind: item.kind,
      occurredAt: item.activityAt,
      symbol: item.symbol,
      source: item.source,
    })),
  };
}

function selectedBuySellWindow(selection, archive) {
  const requestedRecordIds = Array.isArray(selection?.requestedRecordIds)
    ? selection.requestedRecordIds
    : [];
  const result = deriveSelectedBuySellWindow({
    selectedOrderIds: requestedRecordIds
      .filter((id) => id.startsWith("order:"))
      .map((id) => id.slice("order:".length)),
    selectedExecutionIds: requestedRecordIds
      .filter((id) => id.startsWith("execution:"))
      .map((id) => id.slice("execution:".length)),
    orders: archive?.orders ?? [],
    executions: archive?.executions ?? [],
  });
  if (result.status !== "available") {
    const messages = {
      selected_buy_activity_missing: "框选记录里没有可核验的买入成交。",
      selected_sell_activity_missing: "框选记录里没有可核验的卖出成交。",
      selected_broker_records_missing: "部分框选记录不在当前长桥历史缓存中。",
      selected_activity_outside_buy_sell_window: "框选记录不是一个连续的买入到卖出周期，请拆分复盘。",
    };
    throw new Error(messages[result.reason] ?? `框选记录无法形成 Buy→Sell 周期（${result.reason ?? "证据不完整"}）。`);
  }
  return result;
}

function reviewPortfolioSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  const netAssets = finiteOrNull(value?.account?.netAssets);
  const grossMarketValue = finiteOrNull(value?.totals?.positionsGrossMarketValueBase);
  return {
    snapshotAt: value.syncedAt ?? null,
    baseCurrency: value?.account?.baseCurrency ?? "USD",
    netAssets,
    cashRatioPercent: finiteOrNull(value?.totals?.cashRatio),
    grossExposurePercent: grossMarketValue != null && netAssets != null && netAssets !== 0
      ? (grossMarketValue / netAssets) * 100
      : null,
    top1WeightPercent: finiteOrNull(value?.totals?.top1Weight),
    positions: (Array.isArray(value.positions) ? value.positions : []).slice(0, 500).map((item) => ({
      symbol: item.symbol ?? null,
      quantity: finiteOrNull(item.quantity),
      weightPercent: finiteOrNull(item.weight),
      marketValue: finiteOrNull(item.marketValueBase),
      currency: value?.account?.baseCurrency ?? item.currency ?? null,
      group: item.group ?? null,
    })),
  };
}

function reviewStartingPortfolioSnapshot(value, cycleStartAt) {
  const snapshot = reviewPortfolioSnapshot(value);
  const snapshotMs = Date.parse(String(snapshot?.snapshotAt ?? ""));
  const startMs = Date.parse(String(cycleStartAt ?? ""));
  if (!snapshot || !Number.isFinite(snapshotMs) || !Number.isFinite(startMs) || snapshotMs > startMs) {
    return null;
  }
  return snapshot;
}

const PORTFOLIO_LEDGER_ACCOUNT_REF = "aggregate";
const PORTFOLIO_LEDGER_TIMEZONE = "America/New_York";
const MAX_PORTFOLIO_BOUNDARY_DISTANCE_MS = 5 * 24 * 60 * 60 * 1000;

function refreshPortfolioFromLongbridge({
  authorizationGeneration = longbridgeAuthorizationLifecycle.capture(),
} = {}) {
  return longbridgeAuthorizationLifecycle.track(authorizationGeneration, async () => {
    const next = await portfolioService.refresh({
      commitGuard: () => longbridgeAuthorizationLifecycle.isCurrent(authorizationGeneration),
    });
    longbridgeAuthorizationLifecycle.assertCurrent(authorizationGeneration);
    await activatePortfolioLedgerScope(next, { authorizationGeneration });
    longbridgeAuthorizationLifecycle.assertCurrent(authorizationGeneration);
    refreshedPortfolioAuthorization.set(next, {
      authorizationGeneration,
      scopeId: currentPortfolioLedgerScopeId(),
    });
    return next;
  });
}

async function activatePortfolioLedgerScope(value, {
  authorizationGeneration = longbridgeAuthorizationLifecycle.capture(),
} = {}) {
  longbridgeAuthorizationLifecycle.assertCurrent(authorizationGeneration);
  const candidate = value?.accountScopeIdentity;
  if (candidate?.status !== "verified") {
    return currentPortfolioAccountScopeStatus();
  }
  const persistedScope = portfolioBrokerScopeIdentity ?? currentPortfolioLedgerScopeId();
  const activation = planBrokerAccountScopeActivation({
    persistedScope,
    candidateIdentity: candidate,
  });
  if (activation.status !== "reuse" || currentPortfolioLedgerScopeId() !== candidate.scopeId) {
    await secureStore.set(PORTFOLIO_BROKER_SCOPE_IDENTITY_STORE_KEY, candidate);
    longbridgeAuthorizationLifecycle.assertCurrent(authorizationGeneration);
    await secureStore.set(PORTFOLIO_LEDGER_SCOPE_STORE_KEY, candidate.scopeId);
    longbridgeAuthorizationLifecycle.assertCurrent(authorizationGeneration);
    portfolioBrokerScopeIdentity = candidate;
    portfolioLedgerScopeId = candidate.scopeId;
    sendStatus({
      state: activation.status === "account_switch_detected" ? "account_scope_changed" : "account_scope_verified",
      message: activation.status === "account_switch_detected"
        ? "检测到长桥账户范围变化，新的快照已切换到独立账本作用域"
        : "长桥账户范围已匿名核验，后续快照将与旧的本机匿名历史隔离",
      detail: activation.requiresIsolation
        ? "旧快照保持只读，不会重标、合并或删除。"
        : "原始账户号不会写入本机账本，只保存不可逆指纹。",
    });
  } else {
    portfolioBrokerScopeIdentity = candidate;
  }
  await persistSnapshotBackgroundScopeActivation({
    scopeId: candidate.scopeId,
    inheritGlobalEpoch: activation.status === "reuse",
    authorizationGeneration,
  });
  longbridgeAuthorizationLifecycle.assertCurrent(authorizationGeneration);
  return currentPortfolioAccountScopeStatus();
}

async function persistSnapshotBackgroundScopeActivation({
  scopeId,
  inheritGlobalEpoch = false,
  activatedAt = new Date(),
  authorizationGeneration = null,
} = {}) {
  if (authorizationGeneration != null) {
    longbridgeAuthorizationLifecycle.assertCurrent(authorizationGeneration);
  }
  const current = portfolioSnapshotBackgroundPreferences
    ?? createSnapshotBackgroundPreferences();
  if (!current.enabled || !scopeId || current.scopeActivatedAt?.[scopeId]) return current;
  const next = activateSnapshotBackgroundScope(current, {
    accountScopeId: scopeId,
    activatedAt,
    inheritGlobalEpoch,
  });
  if (authorizationGeneration != null) {
    longbridgeAuthorizationLifecycle.assertCurrent(authorizationGeneration);
  }
  await secureStore.set(PORTFOLIO_SNAPSHOT_BACKGROUND_PREFERENCES_STORE_KEY, next);
  if (authorizationGeneration != null) {
    longbridgeAuthorizationLifecycle.assertCurrent(authorizationGeneration);
  }
  portfolioSnapshotBackgroundPreferences = next;
  return next;
}

function normalizePersistedBrokerScopeIdentity(value) {
  try {
    return inspectPersistedAccountScope(value).verified ? value : null;
  } catch {
    return null;
  }
}

function currentPortfolioAccountScopeStatus() {
  const scopeId = currentPortfolioLedgerScopeId();
  const inspected = inspectPersistedAccountScope(portfolioBrokerScopeIdentity);
  const verified = inspected.verified === true
    && portfolioBrokerScopeIdentity?.scopeId === scopeId;
  return {
    scopeId,
    verified,
    identity: verified ? structuredClone(portfolioBrokerScopeIdentity) : null,
    warning: verified ? null : "broker_account_subject_unavailable_local_scope_only",
    limitation: verified
      ? null
      : "券商本轮未返回可验证账户主体；当前仅以本机授权生命周期隔离，不能证明跨授权的账户连续性。",
  };
}

function currentVerifiedBackupScope() {
  const status = currentPortfolioAccountScopeStatus();
  if (!status.verified || !status.identity) {
    const error = new Error("当前长桥账户范围尚未得到验证；请先连接并成功刷新持仓，再导出或恢复。");
    error.code = "backup_account_scope_unverified";
    throw error;
  }
  return status.identity;
}

function canWriteLedgerStore(kind, { writePermit } = {}) {
  return !trustedRestoreFilesFrozen || Boolean(trustedRestoreInProgress
    && trustedLedgerArchivePermit && writePermit === trustedLedgerArchivePermit
    && writePermit.kind === kind);
}

async function archiveLedgerWithConfirmation(event, request) {
  assertTrustedRestoreIdle();
  const kind = request?.kind;
  if (!["portfolio", "radar"].includes(kind)) throw new Error("请选择组合快照或技术雷达账本。");
  const domain = kind === "portfolio" ? portfolioSnapshotStore : technicalRadarStore;
  const store = kind === "portfolio" ? portfolioSnapshotDataStore : technicalRadarDataStore;
  const retainActiveCount = request?.retainActiveCount;
  const limit = kind === "portfolio" ? domain?.maxSnapshots : domain?.maxBatches;
  if (!Number.isSafeInteger(retainActiveCount) || retainActiveCount < 1 || retainActiveCount > limit) {
    throw new Error(`保留数量必须是 1 到 ${limit ?? "账本上限"} 之间的整数。`);
  }
  if (!store?.estimateArchivePublication || !domain?.verifyIntegrity) throw new Error("历史归档尚未初始化。");
  assertTrustedBackupQuiescent();
  currentVerifiedBackupScope();
  const identity = captureReviewAccountOperation();
  trustedRestoreInProgress = true;
  let committed = false;
  let preserveBarrier = false;
  try {
    await portfolioSnapshotCaptureQueue;
    await portfolioSnapshotCoverageWriteQueue;
    await reviewLearningMutationQueue;
    await domain.queue;
    await domain.writeQueue;
    await drainTrustedBackupStores();
    assertReviewAccountOperation(identity);
    trustedRestoreFilesFrozen = true;
    await drainTrustedBackupStores();
    assertReviewAccountOperation(identity);
    const integrity = await domain.verifyIntegrity();
    if (integrity?.valid !== true) throw new Error("账本完整性未通过，未执行归档；请先处理原始数据问题。");
    const capacity = await domain.capacity();
    const totalCount = kind === "portfolio" ? capacity.snapshotCount : capacity.batchCount;
    if (capacity.activeCount <= retainActiveCount) {
      return { ok: true, canceled: false, archived: false, kind, archiveCount: 0,
        activeCount: capacity.activeCount, archivedCount: capacity.archivedCount, totalCount };
    }
    const plan = await store.planArchive({ retainActiveCount });
    const sourceDescription = await describeTrustedBackupSource({
      sourceDirectory: app.getPath("userData"), validatePayload: validateTrustedBackupPayload,
    });
    const publication = await store.estimateArchivePublication({ plan });
    const budget = assessArchiveBackupCapacity({ sourceDescription, publication });
    assertReviewAccountOperation(identity);
    const label = kind === "portfolio" ? "组合快照" : "技术雷达";
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const confirmation = await dialog.showMessageBox(owner, {
      type: "question", title: `预览${label}历史归档`,
      message: `${label}共 ${totalCount} 条：本次归档 ${plan.archiveCount} 条，活动文件保留最近追加的 ${plan.after.activeCount} 条。`,
      detail: `作用于本机此类账本的全部账户历史，按追加顺序整理，不按行情日期删除。已有历史 ${plan.archivedCount} 条；完成后历史共 ${plan.after.archivedCount} 条，所有旧记录仍可查询并随本机恢复包保留。\n\n预计完整备份 ${budget.fileCount} 个文件、${formatArchiveBytes(budget.totalBytes)}；容量检查通过。归档减少活动文件重写量，不保证减少总磁盘占用，也不创建独立备份。建议另行导出恢复包；恢复仍需原本机钥匙串身份。归档期间业务写入暂停，取消不改动记录。`,
      buttons: ["取消", "确认归档"], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (confirmation.response !== 1) return { ok: true, canceled: true, archived: false, kind };
    assertReviewAccountOperation(identity);
    const writePermit = Object.freeze({ kind });
    trustedLedgerArchivePermit = writePermit;
    const archived = await store.archive({
      plan, confirmed: true, writePermit,
      commitGuard: () => {
        assertReviewAccountOperation(identity);
        return trustedRestoreInProgress && trustedRestoreFilesFrozen && trustedLedgerArchivePermit === writePermit;
      },
      publicationGuard: actual => {
        assertReviewAccountOperation(identity);
        assessArchiveBackupCapacity({ sourceDescription, publication: actual });
        return true;
      },
    });
    committed = archived.archived === true;
    trustedLedgerArchivePermit = null;
    const [verified, description] = await Promise.all([domain.verifyIntegrity(), store.describe()]);
    if (verified?.valid !== true || verified.headHash !== integrity.headHash
      || description.contentHash !== plan.contentHash || description.totalCount !== totalCount
      || description.activeCount !== plan.after.activeCount || description.archivedCount !== plan.after.archivedCount) {
      throw new Error("归档后的历史连续性或数量复核未通过。");
    }
    await describeTrustedBackupSource({ sourceDirectory: app.getPath("userData"), validatePayload: validateTrustedBackupPayload });
    assertReviewAccountOperation(identity);
    return { ok: true, canceled: false, archived: committed, kind, archiveCount: archived.archiveCount,
      activeCount: description.activeCount, archivedCount: description.archivedCount, totalCount };
  } catch (error) {
    if (committed) {
      preserveBarrier = true;
      const failure = new Error(`归档已提交，但后续复核未完成：${safeError(error)} 为保护记录，业务写入保持暂停；请退出后重新打开并检查系统状态。`, { cause: error });
      failure.code = "ARCHIVE_POSTCOMMIT_UNVERIFIED";
      throw failure;
    }
    throw error;
  } finally {
    trustedLedgerArchivePermit = null;
    if (!preserveBarrier) {
      trustedRestoreFilesFrozen = false;
      trustedRestoreInProgress = false;
    }
    publishStorageHealth();
    if (committed && !preserveBarrier) reviewSnapshotPublisher.schedule();
  }
}

function formatArchiveBytes(bytes) {
  return Number.isFinite(bytes) && bytes >= 0 ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB` : "容量未知";
}

function describeTrustedRestoreOperations(operations) {
  const labels = { "review-data.bin": "复盘与验证", "market-history.bin": "行情缓存",
    "portfolio-snapshots.bin": "组合快照", "technical-radar.bin": "技术雷达", "business-state.bin": "应用索引" };
  const verbs = { create: "新增", replace: "覆盖", delete: "删除", preserve: "保留", unchanged: "不变" };
  const roots = operations.filter(item => Object.hasOwn(labels, item.name));
  const segments = operations.filter(item => /^ledger-segment-[a-f0-9]{64}\.bin$/.test(item.name));
  const segmentCounts = new Map();
  for (const item of segments) segmentCounts.set(item.operation, (segmentCounts.get(item.operation) ?? 0) + 1);
  return [
    ...roots.map(item => `${verbs[item.operation]}：${labels[item.name]}`),
    ...(segments.length ? [`历史分段：${[...segmentCounts].map(([operation, count]) => `${verbs[operation] ?? operation} ${count} 段`).join("、")}（均保持加密）`] : []),
  ].join("；");
}

async function flushTrustedBackupStores() {
  await agentResults?.mutationQueue;
  const stores = [
    businessStateStore,
    reviewDataStore,
    marketHistoryDataStore,
    portfolioSnapshotDataStore,
    technicalRadarDataStore,
  ].filter(Boolean);
  await Promise.all(stores.map((store) => store.flush()));
}

function assertTrustedBackupQuiescent() {
  if (technicalRadarRunPromise || tradeHistoryService?.busy || activeAgentOperations.size
    || longbridge?.connecting || longbridgeAuthorizationLifecycle.inFlight.size || portfolioSnapshotSweep) {
    throw new Error("仍有分析、同步或采集任务运行；请等待完成后再备份，避免导出不同版本的业务文件。");
  }
}

async function drainTrustedBackupStores() {
  await agentResults?.mutationQueue;
  await Promise.all([reviewDataStore, marketHistoryDataStore, portfolioSnapshotDataStore,
    technicalRadarDataStore].filter(Boolean).map(store => store.drain()));
  await businessStateStore?.flush();
}

async function validateTrustedBackupPayload({ name, payload }) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("当前系统安全存储不可用，不能验证恢复包。");
  }
  const plaintext = safeStorage.decryptString(payload);
  let value;
  try {
    value = JSON.parse(plaintext);
  } catch (error) {
    throw new Error(`状态文件 ${name} 解密后不是有效 JSON。`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`状态文件 ${name} 的根结构无效。`);
  }
  if (name === "business-state.bin") {
    validateBusinessStateDocument(value, { workspaceDirectory: codexAnalysis.workspaceDirectory });
  }
  if (name === "review-data.bin" && Object.hasOwn(value, RESEARCH_THESIS_STORE_KEY)) {
    validateResearchThesisState(value[RESEARCH_THESIS_STORE_KEY]);
  }
  return { document: value };
}

async function technicalRadarForPortfolioAnalysis(value, capturedLongbridgeScopeId) {
  // Bind the read to the sent portfolio, not the currently visible account or
  // a later scope switch. IBKR/combined views may reuse matching market facts,
  // but the evidence builder must label that as a partial reference batch.
  const accounts = Array.isArray(value?.brokerAccounts) ? value.brokerAccounts : [];
  const longbridgeOnly = value?.brokerScope !== "ibkr"
    && !accounts.some((account) => account.broker !== "longbridge");
  const accountScopeId = longbridgeOnly
    ? value?.accountScopeIdentity?.scopeId
      ?? accounts.find((account) => account.broker === "longbridge")?.scopeId
      ?? capturedLongbridgeScopeId
    : capturedLongbridgeScopeId;
  if (!technicalRadarStore || !accountScopeId) return null;
  return technicalRadarStore.latest({ accountScopeId });
}

async function technicalRadarUiSnapshot({ running = Boolean(technicalRadarRunPromise) } = {}) {
  if (!technicalRadarService) {
    return {
      schemaVersion: "technical-radar-service/v1",
      running: false,
      lastError: "技术雷达尚未初始化。",
      watchlist: { items: [], revision: 0, updatedAt: null },
      linkage: { profiles: [], revision: 0, updatedAt: null },
      latestBatch: null,
    };
  }
  const [snapshot, linkage] = await Promise.all([
    technicalRadarService.snapshot({
      portfolio,
      accountScopeId: currentPortfolioLedgerScopeId(),
    }),
    technicalLinkageStore.snapshot(),
  ]);
  return {
    schemaVersion: snapshot.schemaVersion,
    running: Boolean(running),
    lastError: technicalRadarLastError,
    watchlist: snapshot.watchlist,
    linkage,
    latestBatch: snapshot.latest
      ? {
          ...snapshot.latest,
          items: snapshot.cards,
        }
      : null,
  };
}

async function runTechnicalRadarScan({ trigger = "manual" } = {}) {
  if (trustedRestoreInProgress) {
    throw new Error("本机恢复预检正在进行；技术雷达本轮未启动。");
  }
  if (technicalRadarRunPromise) return technicalRadarRunPromise;
  technicalRadarLastError = null;
  const operation = (async () => {
    const runningState = await technicalRadarUiSnapshot({ running: true });
    safeSend("cockpit:technical-radar", runningState);
    sendStatus({
      state: "technical_radar_running",
      message: trigger === "eod"
        ? "每日组合快照已确认；正在后台更新技术雷达"
        : "正在批量扫描持仓与技术自选",
      detail: "只使用已完成日 K；观察排序不构成买卖建议。",
    });
    try {
      assertCurrentPortfolioScopeForWrite(portfolio, currentPortfolioLedgerScopeId());
      await technicalRadarService.run({
        portfolio,
        accountScopeId: currentPortfolioLedgerScopeId(),
      });
      technicalRadarLastError = null;
      const radar = await technicalRadarUiSnapshot({ running: false });
      safeSend("cockpit:technical-radar", radar);
      sendStatus({
        state: "technical_radar_ready",
        message: `技术雷达已更新${radar.latestBatch?.tradingDate ? ` · 截止 ${radar.latestBatch.tradingDate}` : ""}`,
      });
      return radar;
    } catch (error) {
      technicalRadarLastError = safeError(error);
      const radar = await technicalRadarUiSnapshot({ running: false }).catch(() => ({
        schemaVersion: "technical-radar-service/v1",
        running: false,
        lastError: technicalRadarLastError,
        watchlist: { items: [], revision: 0, updatedAt: null },
        linkage: { profiles: [], revision: 0, updatedAt: null },
        latestBatch: null,
      }));
      safeSend("cockpit:technical-radar", radar);
      sendStatus({
        state: "technical_radar_degraded",
        message: "技术雷达本轮未完成；已保留上一批结果",
        detail: technicalRadarLastError,
      });
      throw error;
    }
  })();
  technicalRadarRunPromise = operation.finally(() => {
    technicalRadarRunPromise = null;
  });
  return technicalRadarRunPromise;
}

async function scheduleAutomaticTechnicalRadar(tradingDate) {
  const date = String(tradingDate ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
      || technicalRadarLastAutomaticTradingDate === date) return;
  const current = await technicalRadarUiSnapshot().catch(() => null);
  if (current?.latestBatch?.tradingDate >= date) {
    technicalRadarLastAutomaticTradingDate = date;
    return;
  }
  technicalRadarLastAutomaticTradingDate = date;
  try {
    await runTechnicalRadarScan({ trigger: "eod" });
  } catch {
    technicalRadarLastAutomaticTradingDate = null;
  }
}

function assertCurrentPortfolioScopeForWrite(value, scopeId) {
  const runtime = currentPortfolioAccountScopeStatus();
  if (!runtime.verified || runtime.scopeId !== scopeId) return;
  const current = inspectPersistedAccountScope(value?.accountScopeIdentity);
  if (!current.verified || current.scopeId !== scopeId) {
    throw new Error("本轮长桥同步未能核验当前账户主体，已阻止技术雷达写入已验证账户历史。");
  }
}

async function migrateEncryptedStoreKey({ source, target, key }) {
  const policies = {
    marketHistoryCacheV1: {
      targetFile: "market-history.bin",
      receiptKey: "marketHistoryCacheV1DedicatedAuthorityV1",
    },
    portfolioSnapshotLedgerV2: {
      targetFile: "portfolio-snapshots.bin",
      receiptKey: "portfolioSnapshotLedgerV2DedicatedAuthorityV1",
    },
  };
  const policy = Object.hasOwn(policies, key) ? policies[key] : null;
  if (!policy) throw new Error("不支持的旧数据迁移键；未读取或写入数据。");
  const [receipt, currentValue] = await Promise.all([
    source.get(policy.receiptKey),
    target.get(key),
  ]);
  const schemaVersion = "dedicated-encrypted-store-authority/v1";
  if (receipt !== undefined) {
    const expectedKeys = ["activatedAt", "authority", "key", "schemaVersion", "targetFile"];
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
        || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(expectedKeys)
        || receipt.schemaVersion !== schemaVersion || receipt.key !== key
        || receipt.targetFile !== policy.targetFile || receipt.authority !== "dedicated"
        || typeof receipt.activatedAt !== "string" || !Number.isFinite(Date.parse(receipt.activatedAt))) {
      const error = new Error("旧数据迁移权威标记无效；未启用旧副本回填，请核验本机数据或受信任备份。");
      error.code = "LEGACY_STORE_AUTHORITY_INVALID";
      throw error;
    }
    // A missing dedicated key can be an intentional backup tombstone. The
    // receipt records authority, not content: never resurrect retained data.
    return { migrated: false, conflict: false, authority: "dedicated",
      legacyFallbackEnabled: false, targetPresent: currentValue != null };
  }

  const legacyValue = await source.get(key);
  const migrated = currentValue == null && legacyValue != null;
  const conflict = currentValue != null && legacyValue != null
    && JSON.stringify(currentValue) !== JSON.stringify(legacyValue);
  if (migrated) await target.set(key, legacyValue);
  // Commit the receipt only after a successful target read and, when needed,
  // publication. Receipt failure rejects startup; retry recognizes the target.
  // Even an empty installation becomes authoritative so later legacy material
  // cannot silently become current. Preserve all source evidence read-only.
  await source.set(policy.receiptKey, {
    schemaVersion,
    key,
    targetFile: policy.targetFile,
    authority: "dedicated",
    activatedAt: new Date().toISOString(),
  });
  return {
    migrated,
    conflict,
    authority: "dedicated",
    legacyFallbackEnabled: false,
    targetPresent: currentValue != null || migrated,
  };
}

async function initializePortfolioLedgerScope({ metadataStore, snapshotStore }) {
  const persisted = normalizePortfolioLedgerScopeId(
    await metadataStore.get(PORTFOLIO_LEDGER_SCOPE_STORE_KEY),
  );
  if (persisted) return persisted;
  const ledger = await snapshotStore.get(PORTFOLIO_SNAPSHOT_STORE_KEY);
  const existingScopes = [...new Set((Array.isArray(ledger?.snapshots) ? ledger.snapshots : [])
    .map((item) => normalizePortfolioLedgerScopeId(item?.accountScope?.scopeId))
    .filter(Boolean))];
  const scopeId = existingScopes.length === 1
    ? existingScopes[0]
    : createPortfolioLedgerScopeId();
  await metadataStore.set(PORTFOLIO_LEDGER_SCOPE_STORE_KEY, scopeId);
  return scopeId;
}

function normalizePortfolioLedgerScopeId(value) {
  const scopeId = String(value ?? "").trim();
  if (scopeId === LEGACY_PORTFOLIO_LEDGER_SCOPE_ID) return scopeId;
  if (/^broker-scope-v1-[0-9a-f]{64}$/.test(scopeId)) return scopeId;
  return /^lb-ledger-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scopeId)
    ? scopeId
    : null;
}

function createPortfolioLedgerScopeId() {
  return `lb-ledger-${randomUUID()}`;
}

function currentPortfolioLedgerScopeId() {
  const scopeId = normalizePortfolioLedgerScopeId(portfolioLedgerScopeId);
  if (!scopeId) throw new Error("组合快照账户作用域尚未初始化。");
  return scopeId;
}

async function initializeSnapshotCoverageLedger({ store, snapshotStore, scopeId }) {
  // A failed read is not an empty ledger. Preserve invalid or temporarily
  // unreadable evidence instead of overwriting it with a fresh index.
  const stored = await store.get(PORTFOLIO_SNAPSHOT_COVERAGE_STORE_KEY);
  const previous = stored ? deserializeSnapshotCoverage(stored) : null;
  const snapshots = await snapshotStore.listSnapshots({
    scopeId,
    order: "asc",
    limit: null,
  });
  const confirmed = snapshots.filter(isCurrentRegularCloseSnapshot);
  const createdAt = confirmed[0]?.recordedAt
    ?? confirmed[0]?.capturedAt
    ?? new Date().toISOString();
  const initial = previous ?? createSnapshotCoverageLedger({ createdAt });
  let ledger;
  try {
    ledger = reconcileDurableSnapshotCoverage(initial, confirmed, { scopeId, now: new Date() });
  } catch (error) {
    if (!previous || error.code !== "SNAPSHOT_COVERAGE_DURABLE_CONFLICT") throw error;
    sendStatus({
      state: "snapshot_degraded",
      message: "已保存快照与连续性记录冲突；原记录保留，暂停自动判定缺口",
      detail: safeError(error),
    });
    return previous;
  }
  if (!previous || ledger.revision !== previous.revision) {
    await store.set(PORTFOLIO_SNAPSHOT_COVERAGE_STORE_KEY, ledger);
  }
  return ledger;
}

function recordSnapshotCoverageTransition(transition) {
  if (!portfolioSnapshotCoverageLedger || !portfolioSnapshotCoverageStore) return;
  portfolioSnapshotCoverageWriteQueue = portfolioSnapshotCoverageWriteQueue
    .then(async () => {
      const next = typeof transition === "function"
        ? transition(portfolioSnapshotCoverageLedger)
        : transitionSnapshotCoverage(portfolioSnapshotCoverageLedger, transition);
      if (next.revision === portfolioSnapshotCoverageLedger.revision) return { committed: true };
      await portfolioSnapshotCoverageStore.set(PORTFOLIO_SNAPSHOT_COVERAGE_STORE_KEY, next);
      portfolioSnapshotCoverageLedger = next;
      reviewSnapshotPublisher.schedule();
      return { committed: true };
    })
    .catch((error) => {
      sendStatus({
        state: "snapshot_degraded",
        message: "组合快照连续性状态未提交；原记录保留，稍后会从已保存快照核对",
        detail: safeError(error),
      });
      return { committed: false, error };
    });
  return portfolioSnapshotCoverageWriteQueue;
}

async function reconcileSnapshotCoverageFromSnapshots(snapshots, scopeId, now = new Date()) {
  const result = await recordSnapshotCoverageTransition((ledger) => (
    reconcileDurableSnapshotCoverage(ledger, snapshots.filter(isCurrentRegularCloseSnapshot), { scopeId, now })
  ));
  if (!result?.committed) {
    throw result?.error ?? new Error("组合快照连续性索引尚未就绪，不能判定历史缺口。");
  }
}

function resumeAutomaticPortfolioEvidence() {
  void (async () => {
    try {
      await runPortfolioEvidenceSweep();
    } catch (error) {
      sendStatus({
        state: "snapshot_degraded",
        message: "设备唤醒后组合快照补检未完成，将在下个周期重试",
        detail: safeError(error),
      });
    }
  })();
}

async function loadSnapshotBackgroundPreferences() {
  const stored = await secureStore.get(
    PORTFOLIO_SNAPSHOT_BACKGROUND_PREFERENCES_STORE_KEY,
  ).catch(() => null);
  if (stored) {
    try {
      return normalizeSnapshotBackgroundPreferences(stored);
    } catch (error) {
      sendStatus({
        state: "snapshot_degraded",
        message: "后台快照偏好校验失败，已恢复为显式关闭",
        detail: safeError(error),
      });
    }
  }
  const preferences = createSnapshotBackgroundPreferences({
    enabled: false,
    launchAtLogin: false,
    notifyOnMissedCapture: false,
  });
  await secureStore.set(PORTFOLIO_SNAPSHOT_BACKGROUND_PREFERENCES_STORE_KEY, preferences);
  return preferences;
}

function applySnapshotBackgroundLoginIntent() {
  const preferences = portfolioSnapshotBackgroundPreferences
    ?? createSnapshotBackgroundPreferences();
  const intent = snapshotBackgroundRuntimeIntent(preferences);
  try {
    const settings = { openAtLogin: intent.openAtLogin };
    if (process.platform === "darwin") settings.openAsHidden = intent.openAsHidden;
    app.setLoginItemSettings(settings);
    return sanitizedLoginItemSettings();
  } catch (error) {
    sendStatus({
      state: "snapshot_degraded",
      message: "无法更新系统登录启动设置",
      detail: safeError(error),
    });
    return { supported: false, openAtLogin: false, wasOpenedAtLogin: false };
  }
}

function sanitizedLoginItemSettings() {
  try {
    const settings = app.getLoginItemSettings();
    return {
      supported: true,
      openAtLogin: settings.openAtLogin === true,
      wasOpenedAtLogin: settings.wasOpenedAtLogin === true,
      wasOpenedAsHidden: settings.wasOpenedAsHidden === true,
    };
  } catch {
    return { supported: false, openAtLogin: false, wasOpenedAtLogin: false };
  }
}

function shouldStartAsBackgroundCollector() {
  const intent = snapshotBackgroundRuntimeIntent(
    portfolioSnapshotBackgroundPreferences ?? createSnapshotBackgroundPreferences(),
  );
  const loginItem = sanitizedLoginItemSettings();
  return intent.openAsHidden && loginItem.wasOpenedAtLogin;
}

async function runPortfolioEvidenceSweep(now = new Date()) {
  // Reconcile persisted observations before sealing gaps. A missing index
  // write does not erase a real capture; later account state still cannot be
  // relabelled as the close of a missed day.
  await reconcileExpiredPortfolioSnapshotGaps(now);
  await ensureAutomaticPortfolioSnapshots(now);
}

async function reconcileExpiredPortfolioSnapshotGaps(now = new Date()) {
  const preferences = portfolioSnapshotBackgroundPreferences;
  if (!preferences?.enabled || !preferences.monitoringStartedAt
      || !portfolioSnapshotCoverageLedger) return [];
  const scopeId = currentPortfolioLedgerScopeId();
  const scopeMonitoringStartedAt = snapshotMonitoringStartedAtForScope(preferences, scopeId);
  if (!scopeMonitoringStartedAt) return [];
  const identity = captureReviewAccountOperation();
  const snapshots = await portfolioSnapshotStore.listSnapshots({ scopeId, order: "asc", limit: null });
  assertReviewAccountOperation(identity);
  // Reading or committing this reconciliation must succeed. Otherwise the
  // old index is not evidence that a capture was missed.
  await reconcileSnapshotCoverageFromSnapshots(snapshots, scopeId, now);
  assertReviewAccountOperation(identity);
  const notBefore = localDateInTimezone(
    new Date(scopeMonitoringStartedAt),
    PORTFOLIO_LEDGER_TIMEZONE,
  );
  const tradingDates = recentUsTradingDates(now, { limit: 400, notBefore });
  const options = {
    accountScopeId: scopeId,
    tradingDates,
    now,
    monitoringStartedAt: scopeMonitoringStartedAt,
  };
  let alerts = [], transitions = [];
  const result = await recordSnapshotCoverageTransition((ledger) => {
    assertReviewAccountOperation(identity);
    alerts = listExpiredSnapshotCaptureAlerts(ledger, options).filter((item) => !item.acknowledged);
    transitions = deriveExpiredSnapshotGaps(ledger, options);
    return transitions.reduce((current, transition) => transitionSnapshotCoverage(current, transition), ledger);
  });
  if (!result?.committed) throw result?.error ?? new Error("组合快照缺口状态未提交。");
  assertReviewAccountOperation(identity);
  if (alerts.length) {
    sendStatus({
      state: "snapshot_gap",
      message: `组合历史发现 ${alerts.length} 个已过捕获窗口的交易日缺口`,
      detail: alerts.map((item) => item.tradingDate).join("、"),
    });
    const intent = snapshotBackgroundRuntimeIntent(preferences);
    if (intent.notifyOnMissedCapture && Notification.isSupported()) {
      new Notification({
        title: "交易驾驶舱 · 组合快照缺口",
        body: `${alerts.map((item) => item.tradingDate).join("、")} 未取得已确认收盘快照；系统没有伪造回填。`,
        silent: false,
      }).show();
    }
  }
  return transitions;
}

async function rotatePortfolioLedgerScope() {
  const scopeId = createPortfolioLedgerScopeId();
  await secureStore.set(PORTFOLIO_LEDGER_SCOPE_STORE_KEY, scopeId);
  await secureStore.delete(PORTFOLIO_BROKER_SCOPE_IDENTITY_STORE_KEY);
  portfolioBrokerScopeIdentity = null;
  portfolioLedgerScopeId = scopeId;
  reviewSnapshotPublisher.schedule();
  return scopeId;
}

function captureReviewAccountOperation() {
  return { scopeId: currentPortfolioLedgerScopeId(), authorizationGeneration: longbridgeAuthorizationLifecycle.capture() };
}

function assertReviewAccountOperation({ scopeId, authorizationGeneration }) {
  longbridgeAuthorizationLifecycle.assertCurrent(authorizationGeneration);
  if (scopeId !== currentPortfolioLedgerScopeId()) throw stalePortfolioAccountScopeError();
  return true;
}

function invalidateLongbridgeAuthorizationLifecycle() {
  const generation = longbridgeAuthorizationLifecycle.advance();
  // A result computed for the previous account must never be delivered as if
  // it belonged to the replacement authorization. Abort active analysis as
  // well as rejecting its later portfolio publish checkpoints.
  for (const operation of activeAgentOperations.values()) {
    // Free research deliberately carries no automatic broker snapshot. An
    // unrelated account refresh/re-authorisation must not cancel that work.
    // Legacy operations without an explicit scope keep the conservative guard.
    if (operation.scope === "chat") continue;
    operation.controller.abort(new Error(
      "长桥授权已变化；为避免跨账户混用持仓，本轮 Agent 已停止，请重新运行。",
    ));
  }
  return generation;
}

async function settleSupersededLongbridgeAuthorizationWork() {
  const result = await longbridgeAuthorizationLifecycle.settleSuperseded({ timeoutMs: 30_000 });
  if (!result.settled) {
    sendStatus({
      state: "authorization_generation_drain_timeout",
      message: "旧长桥请求未在安全等待窗口内退出；已隔离其结果并继续重新授权",
      detail: `${result.pendingCount} 个旧请求仍由代际防护拦截，不会写入新账户。`,
    });
  }
  return result;
}

function publishRefreshedPortfolio(value, {
  scheduleEvidence = false,
} = {}) {
  const authorization = refreshedPortfolioAuthorization.get(value);
  if (!authorization) {
    throw new Error("未找到本轮长桥同步的授权代际，已拒绝发布持仓。");
  }
  publishPortfolioForAuthorization(value, {
    ...authorization,
    scheduleEvidence,
  });
  return authorization;
}

function publishPortfolioForAuthorization(value, {
  authorizationGeneration,
  scopeId = currentPortfolioLedgerScopeId(),
  scheduleEvidence = false,
} = {}) {
  longbridgeAuthorizationLifecycle.assertCurrent(authorizationGeneration);
  if (scopeId !== currentPortfolioLedgerScopeId()) {
    throw stalePortfolioAccountScopeError();
  }
  portfolio = value;
  safeSend("cockpit:portfolio", value);
  if (scheduleEvidence) {
    scheduleFreshPortfolioEvidence(value, {
      scopeId,
      authorizationGeneration,
    });
  }
}

function scheduleFreshPortfolioEvidence(value, {
  scopeId = currentPortfolioLedgerScopeId(),
  authorizationGeneration = refreshedPortfolioAuthorization.get(value)?.authorizationGeneration
    ?? longbridgeAuthorizationLifecycle.capture(),
} = {}) {
  longbridgeAuthorizationLifecycle.assertCurrent(authorizationGeneration);
  if (scopeId !== currentPortfolioLedgerScopeId()) throw stalePortfolioAccountScopeError();
  if (!value || value.holdingsStatus !== "live" || value?.freshness?.state === "cached") return;
  const symbols = [
    "QQQ.US",
    ...(Array.isArray(value.positions) ? value.positions : [])
      .filter((item) => item?.instrumentType !== "option")
      .map((item) => item?.symbol),
  ];
  void portfolioService.prewarmCandles(symbols).catch(() => {});
  void captureAutomaticPortfolioSnapshots(value, {
    scopeId,
    authorizationGeneration,
  }).catch((error) => {
    if (isStaleLongbridgeAuthorizationError(error)) return;
    sendStatus({
      state: "snapshot_degraded",
      message: "组合快照未写入，但不影响当前持仓显示",
      detail: safeError(error),
    });
  });
}

async function ensureAutomaticPortfolioSnapshots(now = new Date()) {
  if (trustedRestoreInProgress || portfolioSnapshotSweep || !isUsEodCaptureWindow(now)) return;
  portfolioSnapshotSweep = (async () => {
    // Read the durable local outcome before any reconnection attempt. A saved
    // close is terminal for this account/day even if the broker disconnected.
    const localIdentity = captureReviewAccountOperation();
    const localTradingDate = localDateInTimezone(now, PORTFOLIO_LEDGER_TIMEZONE);
    if (snapshotCoverageEntry(portfolioSnapshotCoverageLedger, {
      accountScopeId: localIdentity.scopeId, tradingDate: localTradingDate,
    })?.status === "gap") return;
    const localEod = await portfolioSnapshotStore.listSnapshots({
      scopeId: localIdentity.scopeId, kinds: "eod", fromTradingDate: localTradingDate,
      toTradingDate: localTradingDate, limit: null,
    });
    assertReviewAccountOperation(localIdentity);
    const savedClose = localEod.find(isCurrentRegularCloseSnapshot);
    if (savedClose) {
      recordPortfolioSnapshotCaptureSuccess(savedClose);
      return;
    }
    if (!longbridge?.connected && !await reconnectLongbridgeForSnapshotCapture(now)) return;
    // A reconnect may finish at or after the hard deadline. Never convert the
    // later account state into a historical close, even though it began in the
    // window.
    const captureNow = new Date();
    if (!longbridge?.connected || !isUsEodCaptureWindow(captureNow)) return;
    const authorizationGeneration = longbridgeAuthorizationLifecycle.capture();
    const scopeId = currentPortfolioLedgerScopeId();
    const tradingDate = localDateInTimezone(captureNow, PORTFOLIO_LEDGER_TIMEZONE);
    try {
      if (snapshotCoverageEntry(portfolioSnapshotCoverageLedger, {
        accountScopeId: scopeId,
        tradingDate,
      })?.status === "gap") return;
      const existingEod = await portfolioSnapshotStore.listSnapshots({
        scopeId,
        kinds: "eod",
        fromTradingDate: tradingDate,
        toTradingDate: tradingDate,
        limit: null,
      });
      assertReviewAccountOperation({ scopeId, authorizationGeneration });
      const confirmed = existingEod.find(isCurrentRegularCloseSnapshot);
      // The versioned regular-close revaluation is first-write-wins for its
      // trading date. Legacy EOD observations remain immutable history but do
      // not block the current valuation method.
      if (confirmed) {
        recordPortfolioSnapshotCaptureSuccess(confirmed);
        return;
      }
      const fresh = await refreshPortfolioFromLongbridge({ authorizationGeneration });
      publishRefreshedPortfolio(fresh, { scheduleEvidence: true });
    } catch (error) {
      if (isStaleLongbridgeAuthorizationError(error)) throw error;
      recordPortfolioSnapshotCaptureRetry({
        attemptedAt: new Date(),
        tradingDate,
        error,
      });
      throw error;
    }
  })().finally(() => {
    portfolioSnapshotSweep = null;
  });
  return portfolioSnapshotSweep;
}

async function reconnectLongbridgeForSnapshotCapture(now = new Date()) {
  if (!isUsEodCaptureWindow(now) || longbridge?.connected) return Boolean(longbridge?.connected);
  let hasSavedAuthorization = false;
  try {
    hasSavedAuthorization = await longbridge?.hasSavedAuthorization?.() === true;
  } catch {
    return false;
  }
  const decision = decideSnapshotReconnect({
    state: portfolioSnapshotReconnectRuntime,
    now,
    connected: longbridge?.connected === true,
    hasSavedAuthorization,
  });
  portfolioSnapshotReconnectRuntime = decision.state;
  if (!decision.shouldAttempt) return false;

  try {
    await longbridge.connect({ interactive: false });
    portfolioSnapshotReconnectRuntime = recordSnapshotReconnectOutcome(
      portfolioSnapshotReconnectRuntime,
      {
        now: new Date(),
        tradingDate: decision.tradingDate,
        outcome: "success",
      },
    );
    return longbridge.connected === true && isUsEodCaptureWindow(new Date());
  } catch (error) {
    const classified = classifyLongbridgeError(error);
    // The MCP SDK's non-interactive redirect error is phrased as an
    // authorization requirement and may not carry an HTTP status.
    const classification = classified.kind === "tool"
      && /authori[sz]ation (?:is )?required|oauth/i.test(safeError(error))
      ? { kind: "auth", code: 401, retryable: false, reauth: true }
      : classified;
    const failedAt = new Date();
    portfolioSnapshotReconnectRuntime = recordSnapshotReconnectOutcome(
      portfolioSnapshotReconnectRuntime,
      {
        now: failedAt,
        tradingDate: decision.tradingDate,
        outcome: "failure",
        classification,
      },
    );
    recordPortfolioSnapshotCaptureRetry({
      attemptedAt: failedAt,
      tradingDate: decision.tradingDate,
      error,
    });
    const failureStatus = classification.kind === "auth"
      ? { state: "reauth_required", message: "长桥授权已过期，请重新连接" }
      : classification.kind === "permission"
        ? { state: "permission_error", message: "长桥后台读取授权不可用" }
        : longbridgeFailureStatus(error, "长桥后台快照重连失败");
    sendStatus({
      ...failureStatus,
      detail: classification.kind === "auth" || classification.kind === "permission"
        ? `后台无交互重连已停止到本捕获窗口结束；${safeError(error)}`
        : `后台无交互重连已进入有界退避；${safeError(error)}`,
    });
    return false;
  }
}

function captureAutomaticPortfolioSnapshots(value, options = {}) {
  if (trustedRestoreInProgress) return Promise.resolve([]);
  const authorizationGeneration = options.authorizationGeneration
    ?? refreshedPortfolioAuthorization.get(value)?.authorizationGeneration
    ?? longbridgeAuthorizationLifecycle.capture();
  longbridgeAuthorizationLifecycle.assertCurrent(authorizationGeneration);
  const guardedOptions = { ...options, authorizationGeneration };
  const queued = portfolioSnapshotCaptureQueue.then(
    () => captureAutomaticPortfolioSnapshotsNow(value, guardedOptions),
    () => captureAutomaticPortfolioSnapshotsNow(value, guardedOptions),
  );
  const operation = queued.catch((error) => {
    if (isStaleLongbridgeAuthorizationError(error)) throw error;
    const attemptedAt = new Date(value?.syncedAt);
    if (Number.isFinite(attemptedAt.getTime()) && isUsEodCaptureWindow(attemptedAt)) {
      recordPortfolioSnapshotCaptureRetry({
        attemptedAt,
        tradingDate: localDateInTimezone(attemptedAt, PORTFOLIO_LEDGER_TIMEZONE),
        error,
      });
    }
    throw error;
  });
  portfolioSnapshotCaptureQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function captureAutomaticPortfolioSnapshotsNow(value, {
  scopeId = currentPortfolioLedgerScopeId(),
  authorizationGeneration = longbridgeAuthorizationLifecycle.capture(),
} = {}) {
  longbridgeAuthorizationLifecycle.assertCurrent(authorizationGeneration);
  if (scopeId !== currentPortfolioLedgerScopeId()) {
    throw stalePortfolioAccountScopeError();
  }
  const capturedAt = new Date(value.syncedAt);
  if (!Number.isFinite(capturedAt.getTime())) return [];
  const tasks = [];
  const eodResults = [];
  if (isUsEodCaptureWindow(capturedAt)) {
    const tradingDate = localDateInTimezone(capturedAt, PORTFOLIO_LEDGER_TIMEZONE);
    const captureWindowExpired = snapshotCoverageEntry(portfolioSnapshotCoverageLedger, {
      accountScopeId: scopeId,
      tradingDate,
    })?.status === "gap";
    const snapshotsForDate = await portfolioSnapshotStore.listSnapshots({
      scopeId,
      fromTradingDate: tradingDate,
      toTradingDate: tradingDate,
      order: "asc",
      limit: null,
    });
    longbridgeAuthorizationLifecycle.assertCurrent(authorizationGeneration);
    if (scopeId !== currentPortfolioLedgerScopeId()) {
      throw stalePortfolioAccountScopeError();
    }
    const confirmedEod = snapshotsForDate.find(isCurrentRegularCloseSnapshot) ?? null;
    const hasScheduledFallback = snapshotsForDate.some(
      (item) => item.idempotencyKey === `scheduled-close:${scopeId}:${tradingDate}`,
    );
    // Do not even re-verify the closing bar after today's versioned regular-
    // close revaluation exists. Legacy EOD entries do not satisfy this check.
    // Other refresh paths may still append a distinct post-trade observation.
    if (confirmedEod) {
      recordPortfolioSnapshotCaptureSuccess(confirmedEod);
    } else if (captureWindowExpired) {
      // A terminal gap is an evidence fact: later account state cannot be
      // relabelled as that trading day's confirmed close. Post-trade/manual
      // observations below remain allowed as separate records.
    } else {
      recordPortfolioSnapshotCaptureAttempt(capturedAt, tradingDate);
      const verified = await verifyUsEodObservation(value, capturedAt, tradingDate);
      longbridgeAuthorizationLifecycle.assertCurrent(authorizationGeneration);
      if (scopeId !== currentPortfolioLedgerScopeId()) {
        throw stalePortfolioAccountScopeError();
      }
      if (verified) {
        const closeValue = regularClosePortfolioObservation(value, tradingDate);
        if (closeValue) {
          try {
            const result = await appendPortfolioSnapshot(closeValue, {
              kind: "eod",
              idempotencyKey: `eod-regular-close-v2:${scopeId}:${tradingDate}`,
              note: closeValue.positions.length === 0
                ? "每日唯一纯现金收盘观察（v2）：账户无证券持仓，以收盘后实时现金和已闭合 QQQ 交易日确认；未核对费用与盘后现金流，因此仍是 partial 观察。"
                : "每日唯一常规收盘重估（v2）：证券按该交易日常规交易时段的收盘 mark 重估，提前收盘日遵循实际收盘时间；盘后报价不覆盖本条。持仓数量和现金来自收盘后抓取，未核对盘后成交与现金流，因此是 partial 观察，不能作为确定性收益端点。",
            }, { scopeId, authorizationGeneration });
            recordPortfolioSnapshotCaptureSuccess(result.snapshot);
            eodResults.push({ status: "fulfilled", value: result });
          } catch (error) {
            if (isStaleLongbridgeAuthorizationError(error)) throw error;
            recordPortfolioSnapshotCaptureRetry({ attemptedAt: capturedAt, tradingDate, error });
            eodResults.push({ status: "rejected", reason: error });
          }
        } else {
          recordPortfolioSnapshotCaptureRetry({
            attemptedAt: capturedAt,
            tradingDate,
            error: new Error("常规收盘价格、收盘后现金或持仓数量尚不足以完成重估。"),
          });
        }
      } else if (!hasScheduledFallback) {
        tasks.push(appendPortfolioSnapshot(value, {
          kind: "manual",
          idempotencyKey: `scheduled-close:${scopeId}:${tradingDate}`,
          note: "收盘后定时观察；常规收盘报价或交易日尚未核验，因此只作独立观察，不标记为常规收盘重估。",
        }, { scopeId, authorizationGeneration }));
        recordPortfolioSnapshotCaptureRetry({ attemptedAt: capturedAt, tradingDate });
      } else {
        recordPortfolioSnapshotCaptureRetry({ attemptedAt: capturedAt, tradingDate });
      }
    }
  }
  const archive = await tradeHistoryService?.cached?.().catch(() => null);
  longbridgeAuthorizationLifecycle.assertCurrent(authorizationGeneration);
  if (scopeId !== currentPortfolioLedgerScopeId()) {
    throw stalePortfolioAccountScopeError();
  }
  const recentExecutions = uniqueRecentExecutions(
    Array.isArray(archive?.executions) ? archive.executions : [],
    capturedAt,
  );
  for (const execution of recentExecutions) {
    const ageMs = capturedAt.getTime() - Date.parse(execution.doneAt);
    tasks.push(appendPortfolioSnapshot(value, {
      kind: "post_trade",
      idempotencyKey: `post-trade:${execution.tradeId}`,
      note: `成交后 ${Math.round(ageMs / 1000)} 秒组合观察 · 成交 ${execution.symbol ?? "未知标的"}`,
      sourceSnapshotId: `execution:${execution.tradeId}`,
    }, { scopeId, authorizationGeneration }));
  }
  return [...eodResults, ...await Promise.allSettled(tasks)];
}

function recordPortfolioSnapshotCaptureAttempt(attemptedAt, tradingDate) {
  const value = attemptedAt instanceof Date ? attemptedAt : new Date(attemptedAt);
  const attemptedAtIso = Number.isFinite(value.getTime())
    ? value.toISOString()
    : new Date().toISOString();
  portfolioSnapshotCaptureRuntime = {
    ...portfolioSnapshotCaptureRuntime,
    lastAttemptAt: attemptedAtIso,
    lastAttemptTradingDate: tradingDate,
    lastError: null,
    outcome: "retrying",
  };
  recordSnapshotCoverageTransition({
    eventId: `attempt:${currentPortfolioLedgerScopeId()}:${tradingDate}:${attemptedAtIso}`,
    accountScopeId: currentPortfolioLedgerScopeId(),
    tradingDate,
    toStatus: "attempting",
    at: attemptedAtIso,
  });
}

function recordPortfolioSnapshotCaptureRetry({ attemptedAt, tradingDate, error = null }) {
  recordPortfolioSnapshotCaptureAttempt(attemptedAt, tradingDate);
  portfolioSnapshotCaptureRuntime = {
    ...portfolioSnapshotCaptureRuntime,
    lastError: error ? safeError(error) : null,
    outcome: "retrying",
  };
  reviewSnapshotPublisher.schedule();
}

function recordPortfolioSnapshotCaptureSuccess(snapshot) {
  if (!isCurrentRegularCloseSnapshot(snapshot)) return;
  portfolioSnapshotCaptureRuntime = {
    ...portfolioSnapshotCaptureRuntime,
    lastSuccessAt: snapshot.recordedAt ?? snapshot.capturedAt ?? new Date().toISOString(),
    lastSuccessTradingDate: snapshot.tradingDate ?? null,
    lastError: null,
    outcome: "confirmed",
  };
  recordSnapshotCoverageTransition((ledger) => reconcileDurableSnapshotCoverage(ledger, [snapshot], {
    scopeId: snapshot.accountScope?.scopeId ?? currentPortfolioLedgerScopeId(),
    now: new Date(),
  }));
  void scheduleAutomaticTechnicalRadar(snapshot.tradingDate).catch(() => {});
  reviewSnapshotPublisher.schedule();
}

function uniqueRecentExecutions(executions, capturedAt, windowMs = 15 * 60 * 1000) {
  const capturedMs = capturedAt instanceof Date ? capturedAt.getTime() : Date.parse(String(capturedAt ?? ""));
  if (!Number.isFinite(capturedMs)) return [];
  const unique = new Map();
  for (const item of Array.isArray(executions) ? executions : []) {
    const tradeId = String(item?.tradeId ?? "").trim();
    const doneAt = Date.parse(String(item?.doneAt ?? ""));
    const ageMs = capturedMs - doneAt;
    if (!tradeId || !Number.isFinite(doneAt) || ageMs < 0 || ageMs > windowMs) continue;
    unique.set(tradeId, item);
  }
  return [...unique.values()].sort((left, right) => Date.parse(left.doneAt) - Date.parse(right.doneAt));
}

/*
 * A post-trade snapshot is a prompt observation, never a historical
 * reconstruction. One refreshed portfolio may evidence every execution in
 * its preceding 15-minute window, with one immutable source link per trade.
 */
async function capturePostTradeAfterHistorySync(archive, identity = captureReviewAccountOperation()) {
  assertReviewAccountOperation(identity);
  if (archive?.accountScopeId && archive.accountScopeId !== identity.scopeId) throw stalePortfolioAccountScopeError();
  if (!longbridge?.connected) return null;
  const { authorizationGeneration, scopeId } = identity;
  const recentExecutions = uniqueRecentExecutions(
    Array.isArray(archive?.executions) ? archive.executions : [],
    new Date(),
  );
  if (!recentExecutions.length) return null;
  const existing = await portfolioSnapshotStore.listSnapshots({
    scopeId,
    kinds: "post_trade",
    order: "desc",
    limit: Math.max(50, recentExecutions.length * 2),
  });
  assertReviewAccountOperation(identity);
  const coveredSources = new Set(existing.map((item) => item?.provenance?.sourceSnapshotId).filter(Boolean));
  if (recentExecutions.every((item) => coveredSources.has(`execution:${item.tradeId}`))) return null;
  const fresh = await refreshPortfolioFromLongbridge({ authorizationGeneration });
  assertReviewAccountOperation(identity);
  const activeScopeId = currentPortfolioLedgerScopeId();
  publishRefreshedPortfolio(fresh);
  const symbols = [
    "QQQ.US",
    ...(Array.isArray(fresh.positions) ? fresh.positions : [])
      .filter((item) => item?.instrumentType !== "option")
      .map((item) => item?.symbol),
  ];
  void portfolioService.prewarmCandles(symbols).catch(() => {});
  await captureAutomaticPortfolioSnapshots(fresh, {
    scopeId: activeScopeId,
    authorizationGeneration,
  });
  assertReviewAccountOperation(identity);
  return fresh;
}

async function verifyUsEodObservation(value, capturedAt, tradingDate) {
  const regularQuoteAt = Date.parse(String(value?.regularQuoteAsOf ?? ""));
  const regularQuoteLatestAt = Date.parse(String(value?.regularQuoteLatestAsOf ?? ""));
  const positions = Array.isArray(value?.positions) ? value.positions : [];
  const cashOnly = positions.length === 0;
  const cashObservationCurrent = cashOnly
    && finiteOrNull(value?.account?.totalCash) != null
    && value?.account?.valuationComplete === true
    && value?.dataQuality?.valuationComplete === true
    && localDateInTimezone(capturedAt, PORTFOLIO_LEDGER_TIMEZONE) === tradingDate;
  const allRegularMarksCurrent = positions.every((item) => (
    finiteOrNull(item?.regularLastPrice) != null
    && finiteOrNull(item?.regularMarketValueBase) != null
    && finiteOrNull(item?.regularGrossMarketValueBase) != null
    && Number.isFinite(Date.parse(String(item?.regularQuoteTimestamp ?? "")))
    && localDateInTimezone(new Date(item.regularQuoteTimestamp), PORTFOLIO_LEDGER_TIMEZONE) === tradingDate
  ));
  if (!cashObservationCurrent && (!Number.isFinite(regularQuoteAt)
    || !Number.isFinite(regularQuoteLatestAt)
    || !allRegularMarksCurrent
    || localDateInTimezone(new Date(regularQuoteAt), PORTFOLIO_LEDGER_TIMEZONE) !== tradingDate
    || localDateInTimezone(new Date(regularQuoteLatestAt), PORTFOLIO_LEDGER_TIMEZONE) !== tradingDate)) {
    return false;
  }
  try {
    const bars = await portfolioService.candles("QQQ.US", 21, {
      allowPersistentFallback: true,
    });
    const last = bars.at(-1);
    return last?.tradeDate === tradingDate
      && classifyLastDailyBar(last, {
        symbol: "QQQ.US",
        analysisTime: capturedAt.toISOString(),
      })?.status === "CLOSED";
  } catch {
    return false;
  }
}

function regularClosePortfolioObservation(value, tradingDate) {
  const positions = Array.isArray(value?.positions) ? value.positions : [];
  const cashOnly = positions.length === 0;
  if (!positions.every((item) => (
    finiteOrNull(item?.regularLastPrice) != null
    && finiteOrNull(item?.regularMarketValue) != null
    && finiteOrNull(item?.regularMarketValueBase) != null
    && finiteOrNull(item?.regularGrossMarketValueBase) != null
    && Number.isFinite(Date.parse(String(item?.regularQuoteTimestamp ?? "")))
    && localDateInTimezone(new Date(item.regularQuoteTimestamp), PORTFOLIO_LEDGER_TIMEZONE) === tradingDate
  ))) return null;
  const cash = finiteOrNull(value?.account?.totalCash);
  if (cash == null) return null;
  const closePositions = positions.map((item) => ({
    ...item,
    lastPrice: Number(item.regularLastPrice),
    marketValue: Number(item.regularMarketValue),
    marketValueBase: Number(item.regularMarketValueBase),
    grossMarketValueBase: Number(item.regularGrossMarketValueBase),
    pnlBase: finiteOrNull(item?.regularPnlBase),
    quoteTimestamp: item.regularQuoteTimestamp,
    quoteSession: "regular_close",
    valuationStatus: "priced",
  }));
  const netExposure = closePositions.reduce((sum, item) => sum + item.marketValueBase, 0);
  const grossExposure = closePositions.reduce((sum, item) => sum + Math.abs(item.grossMarketValueBase), 0);
  const totalAssets = cash + netExposure;
  if (!Number.isFinite(totalAssets) || totalAssets < 0) return null;
  for (const item of closePositions) {
    item.netWeight = totalAssets > 0 ? (item.marketValueBase / totalAssets) * 100 : null;
    item.weight = totalAssets > 0 ? (Math.abs(item.grossMarketValueBase) / totalAssets) * 100 : null;
  }
  return {
    ...value,
    quoteAsOf: value.regularQuoteAsOf,
    quoteLatestAsOf: value.regularQuoteLatestAsOf,
    account: {
      ...value.account,
      netAssets: totalAssets,
    },
    positions: closePositions,
    totals: {
      ...value.totals,
      positionsNetMarketValueBase: netExposure,
      positionsGrossMarketValueBase: grossExposure,
    },
    dataQuality: {
      ...value.dataQuality,
      valuationComplete: false,
    },
    snapshotValuation: {
      session: "regular_close",
      quoteAsOf: cashOnly ? null : value.regularQuoteAsOf,
      quoteLatestAsOf: cashOnly ? null : value.regularQuoteLatestAsOf,
      totalAssetsBasis: cashOnly
        ? "capture_cash_only_after_verified_market_close"
        : "capture_cash_plus_regular_close_positions",
      brokerObservedNetAssets: finiteOrNull(value?.account?.netAssets),
      afterHoursMarksExcluded: true,
      methodVersion: REGULAR_CLOSE_VALUATION_METHOD_VERSION,
    },
  };
}

async function appendPortfolioSnapshot(value, {
  kind,
  idempotencyKey,
  note = null,
  sourceSnapshotId = null,
} = {}, {
  scopeId = currentPortfolioLedgerScopeId(),
  authorizationGeneration = refreshedPortfolioAuthorization.get(value)?.authorizationGeneration
    ?? longbridgeAuthorizationLifecycle.capture(),
} = {}) {
  return longbridgeAuthorizationLifecycle.track(authorizationGeneration, () => {
    longbridgeAuthorizationLifecycle.assertCurrent(authorizationGeneration);
    if (scopeId !== currentPortfolioLedgerScopeId()) {
      throw stalePortfolioAccountScopeError();
    }
    return portfolioSnapshotStore.appendSnapshot(portfolioSnapshotLedgerInput(value, {
      kind,
      idempotencyKey,
      note,
      sourceSnapshotId,
      scopeId,
    }), { commitGuard: () => assertReviewAccountOperation({ scopeId, authorizationGeneration }) })
      .then((result) => { reviewSnapshotPublisher.schedule(); return result; });
  });
}

function portfolioSnapshotLedgerInput(value, {
  kind,
  idempotencyKey,
  note,
  sourceSnapshotId,
  scopeId,
}) {
  const runtimeScope = currentPortfolioAccountScopeStatus();
  const currentPortfolioScope = inspectPersistedAccountScope(value?.accountScopeIdentity);
  const verifiedScope = runtimeScope.verified
    && runtimeScope.scopeId === scopeId
    && currentPortfolioScope.verified
    && currentPortfolioScope.scopeId === scopeId
    ? runtimeScope.identity
    : null;
  if (runtimeScope.verified && runtimeScope.scopeId === scopeId && !verifiedScope) {
    throw new Error("本轮长桥同步未能再次核验账户主体，已阻止写入已验证账户账本，避免跨账户混写。");
  }
  const accountRef = verifiedScope ? "verified-broker-scope" : PORTFOLIO_LEDGER_ACCOUNT_REF;
  const capturedAt = new Date(Date.parse(String(value?.syncedAt ?? ""))).toISOString();
  const reportingCurrency = String(value?.account?.baseCurrency ?? "USD").toUpperCase();
  const totalAssets = finiteOrNull(value?.account?.netAssets);
  const cash = finiteOrNull(value?.account?.totalCash);
  const grossExposure = finiteOrNull(value?.totals?.positionsGrossMarketValueBase);
  const netExposure = finiteOrNull(value?.totals?.positionsNetMarketValueBase);
  if (totalAssets == null || totalAssets < 0 || cash == null || grossExposure == null || netExposure == null) {
    throw new Error("当前组合缺少可核验的资产汇总，未写入历史快照。");
  }
  const positions = Array.isArray(value?.positions) ? value.positions : [];
  const snapshotValuation = value?.snapshotValuation && typeof value.snapshotValuation === "object"
    ? value.snapshotValuation
    : latestPortfolioValuation(value);
  const isRegularCloseObservation = snapshotValuation.session === "regular_close";
  const isCashOnlyCloseObservation = isRegularCloseObservation
    && snapshotValuation.totalAssetsBasis === "capture_cash_only_after_verified_market_close";
  const longExposure = positions.reduce((sum, item) => {
    const amount = finiteOrNull(item?.marketValueBase);
    return amount != null && amount > 0 ? sum + amount : sum;
  }, 0);
  const shortExposure = positions.reduce((sum, item) => {
    const amount = finiteOrNull(item?.marketValueBase);
    return amount != null && amount < 0 ? sum + Math.abs(amount) : sum;
  }, 0);
  const issues = [
    ...(Array.isArray(value?.dataQuality?.sourceErrors) ? value.dataQuality.sourceErrors : []),
    ...(Array.isArray(value?.dataQuality?.quoteErrors) ? value.dataQuality.quoteErrors : []),
    ...positions.filter((item) => item?.valuationStatus !== "priced").map((item) => ({
      code: `position_unpriced:${item?.symbol ?? "unknown"}`,
      message: item?.valuationLimitation ?? `${item?.symbol ?? "持仓"} 缺少可核验估值。`,
      field: "holdings.valueInReportingCurrency",
    })),
    ...(isRegularCloseObservation ? [{
      code: isCashOnlyCloseObservation
        ? "regular_close_cash_observed_after_close"
        : "regular_close_cash_and_inventory_not_reconciled",
      message: isCashOnlyCloseObservation
        ? "该账户收盘时无证券持仓；现金来自收盘后实时账户观察，已用闭合的 QQQ 交易日确认市场收盘，但未核对费用与盘后现金流。"
        : "持仓按常规时段收盘价估值，但现金与数量来自收盘后抓取；未核对盘后成交、费用及现金流。",
      field: "valuation.totalAssetsBasis",
    }] : []),
  ].map((item, index) => ({
    code: String(item?.code ?? `portfolio_source_issue:${index + 1}`).slice(0, 120),
    message: String(item?.message ?? item ?? "组合数据源降级").slice(0, 500),
    field: item?.field ? String(item.field).slice(0, 160) : null,
  }));
  const hkdPerUsd = finiteOrNull(value?.fx?.hkdPerUsd);
  const nonReportingCurrencies = new Set(positions
    .map((item) => String(item?.currency ?? reportingCurrency).toUpperCase())
    .filter((currency) => currency !== reportingCurrency));
  const fxRates = reportingCurrency === "USD" && hkdPerUsd && nonReportingCurrencies.has("HKD")
    ? [{
      base: "USD",
      quote: "HKD",
      rate: hkdPerUsd,
      asOf: normalizeFxAsOf(value?.fx?.asOf, capturedAt),
      source: value?.fx?.provider ?? "Longbridge/ECB",
    }]
    : [];
  const fxCovered = [...nonReportingCurrencies].every((currency) => (
    currency === "HKD" && reportingCurrency === "USD" && fxRates.length > 0
  ));
  return {
    kind,
    idempotencyKey,
    capturedAt,
    timezone: PORTFOLIO_LEDGER_TIMEZONE,
    accountScope: {
      ...(verifiedScope ?? {}),
      scopeId,
      broker: "Longbridge",
      accounts: [{
        accountRef,
        accountType: verifiedScope ? "verified_scope_aggregate_read_only" : "aggregate_read_only",
        baseCurrency: reportingCurrency,
      }],
    },
    summary: {
      reportingCurrency,
      totalAssets,
      cash,
      grossExposure,
      netExposure,
      longExposure,
      shortExposure,
      buyingPower: finiteOrNull(value?.account?.buyPower),
      marginDebt: null,
    },
    holdings: positions.map((item) => ({
      accountRef,
      symbol: item?.symbol,
      assetType: item?.instrumentType ?? "unknown",
      currency: String(item?.currency ?? reportingCurrency).toUpperCase(),
      quantity: finiteOrNull(item?.quantity) ?? 0,
      marketPrice: finiteOrNull(item?.lastPrice),
      marketValue: finiteOrNull(item?.marketValue),
      valueInReportingCurrency: finiteOrNull(item?.marketValueBase),
      costBasis: null,
      unrealizedPnl: finiteOrNull(item?.pnlBase),
      weight: finiteOrNull(item?.weight) == null ? null : Number(item.weight) / 100,
    })),
    dataQuality: {
      status: value?.dataQuality?.valuationComplete && !isRegularCloseObservation ? "complete" : "partial",
      completeForPeriodReturn: Boolean(value?.dataQuality?.valuationComplete) && !isRegularCloseObservation,
      issues,
    },
    valuation: {
      session: snapshotValuation.session,
      quoteAsOf: snapshotValuation.quoteAsOf,
      quoteLatestAsOf: snapshotValuation.quoteLatestAsOf,
      observedAt: capturedAt,
      totalAssetsBasis: snapshotValuation.totalAssetsBasis,
      brokerObservedNetAssets: snapshotValuation.brokerObservedNetAssets,
      afterHoursMarksExcluded: snapshotValuation.afterHoursMarksExcluded,
      methodVersion: snapshotValuation.methodVersion ?? null,
    },
    fx: {
      status: nonReportingCurrencies.size === 0
        ? "not_required"
        : fxCovered ? "complete" : value?.dataQuality?.fxStatus === "unavailable" ? "unavailable" : "partial",
      source: value?.fx?.provider ?? null,
      retrievedAt: value?.fx?.fetchedAt ? normalizeFxAsOf(value.fx.fetchedAt, capturedAt) : null,
      rates: fxRates,
    },
    provenance: {
      provider: "Longbridge",
      transport: "MCP OAuth 2.1 read only",
      fetchedAt: capturedAt,
      sourceSnapshotId: sourceSnapshotId ?? value?.syncedAt ?? null,
      freshness: value?.status === "live" ? "live" : "cached",
      cacheAgeMs: value?.status === "live" ? null : Math.max(0, Date.now() - Date.parse(capturedAt)),
    },
    note,
  };
}

function latestPortfolioValuation(value) {
  const sessions = new Set((Array.isArray(value?.positions) ? value.positions : [])
    .map((item) => String(item?.quoteSession ?? "").trim())
    .filter(Boolean));
  return {
    session: sessions.size === 1 ? [...sessions][0] : sessions.size > 1 ? "mixed" : "unknown",
    quoteAsOf: Number.isFinite(Date.parse(String(value?.quoteAsOf ?? ""))) ? value.quoteAsOf : null,
    quoteLatestAsOf: Number.isFinite(Date.parse(String(value?.quoteLatestAsOf ?? "")))
      ? value.quoteLatestAsOf
      : null,
    totalAssetsBasis: "broker_observed",
    brokerObservedNetAssets: finiteOrNull(value?.account?.netAssets),
    afterHoursMarksExcluded: false,
    methodVersion: null,
  };
}

function isUsEodCaptureWindow(value) {
  return isWithinUsSnapshotCaptureWindow(value);
}

function localDateInTimezone(value, timezone) {
  const parts = zonedDateTimeParts(value, timezone);
  if (!parts) throw new Error("组合快照时间无效。");
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function zonedDateTimeParts(value, timezone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return {
    year: Number(part("year")),
    month: Number(part("month")),
    day: Number(part("day")),
    hour: Number(part("hour")),
    minute: Number(part("minute")),
    weekday: part("weekday"),
  };
}

function normalizeFxAsOf(value, fallback) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function finiteOrNull(value) {
  if (value == null || typeof value === "boolean") return null;
  if (typeof value === "string" && !value.trim()) return null;
  if (!["number", "string"].includes(typeof value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function hydrateCyclePortfolioSnapshots(cycle) {
  if (!cycle?.startAt || !cycle?.endAt || !portfolioSnapshotStore) return cycle;
  const scopeId = normalizePortfolioLedgerScopeId(cycle?.brokerLinks?.accountScopeId);
  const currentAccountScope = currentPortfolioAccountScopeStatus();
  if (!scopeId) {
    return {
      ...cycle,
      portfolioSnapshotCoverage: {
        status: "unavailable",
        source: "本机加密追加式组合快照账本",
        accountScopeVerified: false,
        accountScopeMatchesCurrent: false,
        snapshotCountWithinCycle: 0,
        canCalculatePeriodReturn: false,
        warnings: ["cycle_account_scope_missing_reselect_broker_records"],
      },
    };
  }
  const accountScopeVerified = isOpaqueBrokerAccountScopeId(scopeId);
  const accountScopeMatchesCurrent = scopeId === currentAccountScope.scopeId;
  const accountScopeWarnings = [
    ...(!accountScopeVerified ? ["cycle_account_scope_not_broker_verified"] : []),
    ...(!accountScopeMatchesCurrent ? ["cycle_uses_historical_account_scope"] : []),
  ];
  try {
    const period = await portfolioSnapshotStore.queryPeriod({
      scopeId,
      startAt: cycle.startAt,
      endAt: cycle.endAt,
      includeSnapshots: false,
    });
    const startMs = Date.parse(cycle.startAt);
    const endMs = Date.parse(cycle.endAt);
    const opening = snapshotWithinDistance(period.openingBaseline, startMs);
    const closing = snapshotWithinDistance(period.lastWithin, endMs);
    const embeddedStarting = eligibleEmbeddedStartingPortfolio(cycle.startingPortfolio, startMs);
    const ledgerStarting = ledgerSnapshotForReview(opening);
    const selectedStarting = selectCloserStartingPortfolio(embeddedStarting, ledgerStarting, startMs);
    const distinctEndpoints = Boolean(opening && closing)
      && opening.snapshotId !== closing.snapshotId;
    const canCompareNetAssetEndpoints = distinctEndpoints
      && [opening, closing].every((item) => (
        item.dataQuality?.status === "complete" && item.dataQuality?.completeForPeriodReturn
      ));
    const warnings = [...new Set([
      ...(period.coverage?.warnings ?? []),
      ...(period.openingBaseline && !opening ? ["opening_snapshot_too_far_from_cycle"] : []),
      ...(period.lastWithin && !closing ? ["ending_snapshot_too_far_from_cycle"] : []),
      ...(canCompareNetAssetEndpoints ? ["external_cash_flows_and_fees_not_reconciled"] : []),
    ])];
    const hydrated = {
      ...cycle,
      startingPortfolio: selectedStarting,
      endingPortfolio: ledgerSnapshotForReview(closing),
      portfolioSnapshotCoverage: {
        source: "本机加密追加式组合快照账本",
        accountScopeVerified,
        accountScopeMatchesCurrent,
        snapshotCountWithinCycle: period.coverage?.snapshotCount ?? 0,
        openingSnapshotAt: opening?.capturedAt ?? null,
        endingSnapshotAt: closing?.capturedAt ?? null,
        openingDistanceMs: opening ? Math.max(0, startMs - Date.parse(opening.capturedAt)) : null,
        endingDistanceMs: closing ? Math.max(0, endMs - Date.parse(closing.capturedAt)) : null,
        canCompareNetAssetEndpoints,
        canCalculatePeriodReturn: false,
        warnings: [...new Set([
          ...warnings,
          ...accountScopeWarnings,
        ])],
      },
    };
    // queryPeriod verified the original immutable ledger before selecting these
    // records. Keep originals host-only; the model gets a bounded status map.
    const originals = {
      // The projection can legitimately prefer a closer embedded observation.
      // Do not silently reconcile a different, older ledger baseline instead.
      opening: selectedStarting === ledgerStarting ? structuredClone(opening) : null,
      closing: structuredClone(closing),
    };
    reviewPortfolioEvidence.set(hydrated, {
      ...originals,
      originalHashes: Object.fromEntries(Object.entries(originals)
        .map(([key, value]) => [key, value ? hashReviewReconciliationEvidence(value) : null])),
    });
    return hydrated;
  } catch (error) {
    return {
      ...cycle,
      portfolioSnapshotCoverage: {
        source: "本机加密追加式组合快照账本",
        accountScopeVerified,
        accountScopeMatchesCurrent,
        snapshotCountWithinCycle: 0,
        openingSnapshotAt: null,
        endingSnapshotAt: null,
        canCalculatePeriodReturn: false,
        warnings: [
          ...accountScopeWarnings,
          `snapshot_ledger_unavailable:${safeError(error)}`,
        ],
      },
    };
  }
}

function buildCycleReconciliationEvidence(cycle, outcomeMetrics) {
  const verified = reviewPortfolioEvidence.get(cycle) ?? {};
  for (const key of ["opening", "closing"]) {
    if (verified[key] && hashReviewReconciliationEvidence(verified[key]) !== verified.originalHashes?.[key]) {
      throw new Error("已核验的原始组合快照在复盘准备期间发生变化；本轮未使用被改动的证据。");
    }
  }
  const scopeId = cycle?.brokerLinks?.accountScopeId;
  const verifiedSources = [verified.opening, verified.closing].filter(snapshot => snapshot
    && isOpaqueBrokerAccountScopeId(scopeId)
    && snapshot.accountScope?.scopeId === scopeId
    && inspectPersistedAccountScope(snapshot.accountScope).verified);
  if (outcomeMetrics) verifiedSources.push(outcomeMetrics);
  return summarizeReviewReconciliation(buildReviewReconciliation({
    cycle,
    openingSnapshot: verified.opening ?? cycle.startingPortfolio ?? null,
    closingSnapshot: verified.closing ?? cycle.endingPortfolio ?? null,
    outcomeMetrics,
    // Never accept verification flags/hashes or supplemental ledgers from IPC.
    // Flows, fees, taxes and corporate actions stay missing until sourced.
    verifiedSourceHashes: verifiedSources.map(hashReviewReconciliationEvidence),
  }));
}

function snapshotWithinDistance(snapshot, boundaryMs) {
  const capturedMs = Date.parse(String(snapshot?.capturedAt ?? ""));
  if (!snapshot || !Number.isFinite(capturedMs) || !Number.isFinite(boundaryMs)) return null;
  return Math.abs(boundaryMs - capturedMs) <= MAX_PORTFOLIO_BOUNDARY_DISTANCE_MS ? snapshot : null;
}

function eligibleEmbeddedStartingPortfolio(snapshot, startMs) {
  const snapshotMs = Date.parse(String(snapshot?.snapshotAt ?? snapshot?.syncedAt ?? ""));
  if (!snapshot || !Number.isFinite(snapshotMs) || snapshotMs > startMs) return null;
  return startMs - snapshotMs <= MAX_PORTFOLIO_BOUNDARY_DISTANCE_MS ? snapshot : null;
}

function selectCloserStartingPortfolio(embedded, ledger, startMs) {
  const candidates = [embedded, ledger].filter(Boolean).filter((item) => {
    const snapshotMs = Date.parse(String(item?.snapshotAt ?? item?.syncedAt ?? ""));
    return Number.isFinite(snapshotMs) && snapshotMs <= startMs;
  });
  return candidates.sort((left, right) => (
    Math.abs(startMs - Date.parse(left.snapshotAt ?? left.syncedAt))
      - Math.abs(startMs - Date.parse(right.snapshotAt ?? right.syncedAt))
  ))[0] ?? null;
}

function ledgerSnapshotForReview(snapshot) {
  if (!snapshot) return null;
  const snapshotScopeInspection = inspectPersistedAccountScope(snapshot?.accountScope);
  const totalAssets = finiteOrNull(snapshot?.summary?.totalAssets);
  const grossExposure = finiteOrNull(snapshot?.summary?.grossExposure);
  const cash = finiteOrNull(snapshot?.summary?.cash);
  const holdings = Array.isArray(snapshot?.holdings) ? snapshot.holdings : [];
  const weights = holdings.map(item => finiteOrNull(item?.weight));
  return {
    snapshotAt: snapshot.capturedAt,
    snapshotId: snapshot.snapshotId,
    kind: snapshot.kind,
    baseCurrency: snapshot?.summary?.reportingCurrency ?? "USD",
    netAssets: totalAssets,
    cash,
    cashRatioPercent: totalAssets && cash != null ? (cash / totalAssets) * 100 : null,
    grossExposurePercent: totalAssets && grossExposure != null ? (grossExposure / totalAssets) * 100 : null,
    top1WeightPercent: weights.length && weights.every(weight => weight != null)
      ? Math.max(...weights.map(Math.abs)) * 100
      : null,
    positions: holdings.map((item) => ({
      symbol: item.symbol,
      quantity: item.quantity,
      weightPercent: item.weight == null ? null : Number(item.weight) * 100,
      marketValue: item.valueInReportingCurrency,
      currency: snapshot?.summary?.reportingCurrency ?? item.currency,
      group: null,
    })),
    dataQuality: snapshot.dataQuality,
    valuation: snapshot.valuation ?? null,
    fx: snapshot.fx ?? null,
    accountScope: snapshot.accountScope ?? null,
    provenance: {
      source: "本机加密组合快照账本",
      accountScopeVerified: snapshotScopeInspection.verified,
      accountScopeLimitation: snapshotScopeInspection.verified
        ? null
        : "券商未返回可验证账户主体；该记录只证明本机匿名作用域内的连续性。",
      recordedAt: snapshot.recordedAt,
      integrityStatus: snapshot.integrity?.entryHash ? "verified_on_read" : "unavailable",
    },
  };
}

async function portfolioSnapshotLedgerStatus({ reconcile = true } = {}) {
  const accountScope = currentPortfolioAccountScopeStatus();
  if (!portfolioSnapshotStore) {
    return {
      status: "unavailable",
      snapshotCount: 0,
      latest: null,
      capturePolicy: PORTFOLIO_SNAPSHOT_CAPTURE_POLICY,
      captureRuntime: currentPortfolioSnapshotCaptureRuntime([]),
      backgroundCapture: currentSnapshotBackgroundStatus(),
      accountScopeVerified: accountScope.verified,
      warnings: [
        ...(accountScope.warning ? [accountScope.warning] : []),
        "snapshot_store_not_ready",
      ],
    };
  }
  try {
    const scopeId = currentPortfolioLedgerScopeId();
    const [integrity, scopedSnapshots] = await Promise.all([
      portfolioSnapshotStore.verifyIntegrity(),
      portfolioSnapshotStore.listSnapshots({ scopeId, order: "asc", limit: null }),
    ]);
    if (reconcile) await reconcileSnapshotCoverageFromSnapshots(scopedSnapshots, scopeId);
    const latest = scopedSnapshots.at(-1) ?? null;
    const captureRuntime = currentPortfolioSnapshotCaptureRuntime(scopedSnapshots);
    const coverageEntries = portfolioSnapshotCoverageLedger
      ? listSnapshotCoverageEntries(portfolioSnapshotCoverageLedger, { accountScopeId: scopeId })
      : [];
    const earliestCoverageDate = coverageEntries[0]?.tradingDate
      ?? scopedSnapshots.filter(isCurrentRegularCloseSnapshot)[0]?.tradingDate
      ?? null;
    const tradingDates = recentUsTradingDates(new Date(), {
      limit: 45,
      notBefore: earliestCoverageDate,
    });
    const coverageCalendar = portfolioSnapshotCoverageLedger
      ? buildSnapshotCoverageCalendar(portfolioSnapshotCoverageLedger, {
          accountScopeId: scopeId,
          tradingDates,
        }).map(entry => ({
          ...entry,
          snapshotReferenceVerified: entry.status === "confirmed" && scopedSnapshots.some(snapshot =>
            snapshot.snapshotId === entry.confirmedSnapshotId && snapshot.tradingDate === entry.tradingDate
            && snapshot.accountScope?.scopeId === scopeId && isCurrentRegularCloseSnapshot(snapshot)),
        }))
      : [];
    const coverageSummary = portfolioSnapshotCoverageLedger
      ? summarizeSnapshotCoverage(portfolioSnapshotCoverageLedger, {
          accountScopeId: scopeId,
          tradingDates,
        })
      : null;
    return {
      status: integrity.valid ? (scopedSnapshots.length ? "available" : "empty") : "invalid",
      snapshotCount: scopedSnapshots.length,
      latest: latest ? {
        snapshotId: latest.snapshotId,
        kind: latest.kind,
        capturedAt: latest.capturedAt,
        tradingDate: latest.tradingDate,
        quality: latest.dataQuality?.status ?? "unknown",
        valuationSession: latest.valuation?.session ?? "unknown",
        quoteAsOf: latest.valuation?.quoteAsOf ?? null,
        quoteLatestAsOf: latest.valuation?.quoteLatestAsOf ?? null,
        totalAssetsBasis: latest.valuation?.totalAssetsBasis ?? "unknown",
        valuationMethodVersion: latest.valuation?.methodVersion ?? null,
      } : null,
      integrity: {
        valid: integrity.valid,
        headHash: integrity.headHash,
        ledgerRecordCount: integrity.recordCount,
      },
      capturePolicy: PORTFOLIO_SNAPSHOT_CAPTURE_POLICY,
      captureRuntime,
      backgroundCapture: currentSnapshotBackgroundStatus(),
      coverageSummary,
      coverageCalendar,
      accountScopeVerified: accountScope.verified,
      warnings: [
        ...(accountScope.warning ? [accountScope.warning] : []),
        ...(coverageSummary?.hasGaps ? ["snapshot_trading_day_coverage_has_gaps"] : []),
        ...(integrity.valid ? [] : integrity.issues),
      ],
    };
  } catch (error) {
    return {
      status: "unavailable",
      snapshotCount: 0,
      latest: null,
      capturePolicy: PORTFOLIO_SNAPSHOT_CAPTURE_POLICY,
      captureRuntime: currentPortfolioSnapshotCaptureRuntime([]),
      backgroundCapture: currentSnapshotBackgroundStatus(),
      accountScopeVerified: accountScope.verified,
      warnings: [
        ...(accountScope.warning ? [accountScope.warning] : []),
        `snapshot_ledger_unavailable:${safeError(error)}`,
      ],
    };
  }
}

function currentSnapshotBackgroundStatus() {
  const preferences = portfolioSnapshotBackgroundPreferences
    ?? createSnapshotBackgroundPreferences();
  return {
    preferences: structuredClone(preferences),
    runtimeIntent: snapshotBackgroundRuntimeIntent(preferences),
    loginItem: sanitizedLoginItemSettings(),
    policy: snapshotBackgroundReliabilityPolicy(),
  };
}

function recentUsTradingDates(now = new Date(), { limit = 45, notBefore = null } = {}) {
  const expected = expectedLastCompletedTradingDate({
    market: "US",
    analysisTime: now.toISOString(),
  });
  if (!expected) return [];
  const values = [];
  let cursor = expected;
  const floor = /^\d{4}-\d{2}-\d{2}$/.test(String(notBefore ?? ""))
    ? String(notBefore)
    : expected;
  while (values.length < Math.max(1, Number(limit) || 45) && cursor >= floor) {
    if (isUsTradingDay(cursor)) values.push(cursor);
    const date = new Date(`${cursor}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() - 1);
    cursor = date.toISOString().slice(0, 10);
  }
  return values.reverse();
}

function currentPortfolioSnapshotCaptureRuntime(snapshots, now = new Date()) {
  const currentTradingDate = localDateInTimezone(now, PORTFOLIO_LEDGER_TIMEZONE);
  const latestConfirmed = (Array.isArray(snapshots) ? snapshots : [])
    .filter(isCurrentRegularCloseSnapshot)
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt))
    .at(-1) ?? null;
  const lastSuccessAt = latestConfirmed?.recordedAt
    ?? latestConfirmed?.capturedAt
    ?? portfolioSnapshotCaptureRuntime.lastSuccessAt;
  const lastSuccessTradingDate = latestConfirmed?.tradingDate
    ?? portfolioSnapshotCaptureRuntime.lastSuccessTradingDate;
  const confirmedToday = lastSuccessTradingDate === currentTradingDate;
  const connected = Boolean(longbridge?.connected);
  let status = "waiting";
  if (confirmedToday) status = "confirmed_today";
  else if (!connected) status = "disconnected";
  else if (portfolioSnapshotCaptureRuntime.lastAttemptTradingDate === currentTradingDate
    && portfolioSnapshotCaptureRuntime.outcome === "retrying") status = "retrying";
  return {
    status,
    connected,
    currentTradingDate,
    lastAttemptAt: portfolioSnapshotCaptureRuntime.lastAttemptAt,
    lastAttemptTradingDate: portfolioSnapshotCaptureRuntime.lastAttemptTradingDate,
    lastSuccessAt,
    lastSuccessTradingDate,
    lastError: portfolioSnapshotCaptureRuntime.lastError,
  };
}

async function portfolioSnapshotCoverageForCycles(cycles) {
  const values = Array.isArray(cycles) ? cycles : [];
  if (!portfolioSnapshotStore || !values.length) return {};
  const currentAccountScope = currentPortfolioAccountScopeStatus();
  const snapshotsByScope = new Map();
  async function snapshotsForScope(scopeId) {
    if (!snapshotsByScope.has(scopeId)) {
      snapshotsByScope.set(scopeId, portfolioSnapshotStore.listSnapshots({
        scopeId,
        order: "asc",
        limit: null,
      }));
    }
    return snapshotsByScope.get(scopeId);
  }
  const entries = await Promise.all(values.map(async (cycle) => {
    const scopeId = normalizePortfolioLedgerScopeId(cycle?.brokerLinks?.accountScopeId);
    if (!scopeId) {
      return [cycle.id, {
        status: "unavailable",
        accountScopeVerified: false,
        accountScopeMatchesCurrent: false,
        snapshotCountWithinCycle: 0,
        canCompareNetAssetEndpoints: false,
        canCalculatePeriodReturn: false,
        warnings: ["cycle_account_scope_missing_reselect_broker_records"],
      }];
    }
    const accountScopeVerified = isOpaqueBrokerAccountScopeId(scopeId);
    const accountScopeMatchesCurrent = scopeId === currentAccountScope.scopeId;
    const scopeWarnings = [
      ...(!accountScopeVerified ? ["cycle_account_scope_not_broker_verified"] : []),
      ...(!accountScopeMatchesCurrent ? ["cycle_uses_historical_account_scope"] : []),
    ];
    try {
      const snapshots = await snapshotsForScope(scopeId);
      const startMs = Date.parse(String(cycle?.startAt ?? ""));
      const endMs = Date.parse(String(cycle?.endAt ?? ""));
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        return [cycle.id, {
          status: "unavailable",
          accountScopeVerified,
          accountScopeMatchesCurrent,
          snapshotCountWithinCycle: 0,
          canCalculatePeriodReturn: false,
          warnings: [...scopeWarnings, "cycle_boundary_missing"],
        }];
      }
      const within = snapshots.filter((item) => {
        const time = Date.parse(item.capturedAt);
        return time >= startMs && time <= endMs;
      });
      const openingCandidate = snapshots.filter((item) => Date.parse(item.capturedAt) <= startMs).at(-1) ?? null;
      const closingCandidate = within.at(-1) ?? null;
      const opening = snapshotWithinDistance(openingCandidate, startMs);
      const closing = snapshotWithinDistance(closingCandidate, endMs);
      const complete = Boolean(opening && closing && opening.snapshotId !== closing.snapshotId
        && opening.dataQuality?.completeForPeriodReturn
        && closing.dataQuality?.completeForPeriodReturn);
      const warnings = [
        ...scopeWarnings,
        ...(!opening ? [openingCandidate ? "opening_snapshot_too_far_from_cycle" : "opening_baseline_missing"] : []),
        ...(!closing ? [closingCandidate ? "ending_snapshot_too_far_from_cycle" : "period_end_snapshot_missing"] : []),
        ...(within.length ? [] : ["period_has_no_snapshot"]),
        ...(opening && opening.dataQuality?.status !== "complete" ? ["opening_snapshot_quality_incomplete"] : []),
        ...(closing && closing.dataQuality?.status !== "complete" ? ["ending_snapshot_quality_incomplete"] : []),
      ];
      return [cycle.id, {
        status: complete ? "complete" : snapshots.length ? "partial" : "unavailable",
        source: "本机加密追加式组合快照账本",
        accountScopeVerified,
        accountScopeMatchesCurrent,
        snapshotCountWithinCycle: within.length,
        openingSnapshotAt: opening?.capturedAt ?? null,
        endingSnapshotAt: closing?.capturedAt ?? null,
        canCompareNetAssetEndpoints: complete,
        canCalculatePeriodReturn: false,
        ...(complete ? { warnings: [...warnings, "external_cash_flows_and_fees_not_reconciled"] } : { warnings }),
      }];
    } catch (error) {
      return [cycle.id, {
        status: "unavailable",
        accountScopeVerified,
        accountScopeMatchesCurrent,
        snapshotCountWithinCycle: 0,
        canCompareNetAssetEndpoints: false,
        canCalculatePeriodReturn: false,
        warnings: [...scopeWarnings, `snapshot_ledger_unavailable:${safeError(error)}`],
      }];
    }
  }));
  return Object.fromEntries(entries);
}

function buildPointInTimeActivitySymbols({ cycle, archive, phase, cutoffs }) {
  const recordsById = new Map();
  for (const item of Array.isArray(archive?.orders) ? archive.orders : []) {
    const recordId = `order:${String(item?.orderId ?? "").trim()}`;
    const occurredAt = item?.submittedAt ?? item?.updatedAt;
    const symbol = String(item?.symbol ?? "").trim().toUpperCase();
    if (recordId !== "order:" && symbol) recordsById.set(recordId, { occurredAt, symbol });
  }
  for (const item of Array.isArray(archive?.executions) ? archive.executions : []) {
    const recordId = `execution:${String(item?.tradeId ?? "").trim()}`;
    const symbol = String(item?.symbol ?? "").trim().toUpperCase();
    if (recordId !== "execution:" && symbol) recordsById.set(recordId, {
      occurredAt: item?.doneAt,
      symbol,
    });
  }
  const normalizeRecordIds = (values) => (Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim())
    .filter((value) => /^(?:order|execution):.+/.test(value));
  const symbolsBeforeCutoff = (recordIds, cutoffAt) => {
    const cutoffMs = Date.parse(String(cutoffAt ?? ""));
    if (!Number.isFinite(cutoffMs)) return [];
    return [...new Set(recordIds.flatMap((recordId) => {
      const record = recordsById.get(recordId);
      const occurredMs = Date.parse(String(record?.occurredAt ?? ""));
      return record && Number.isFinite(occurredMs) && occurredMs < cutoffMs
        ? [record.symbol]
        : [];
    }))];
  };

  if (phase === "blind") {
    const introducedSoFar = new Set();
    return new Map((Array.isArray(cutoffs) ? cutoffs : []).map((node) => {
      normalizeRecordIds(node?.introducedRecordIds).forEach((recordId) => introducedSoFar.add(recordId));
      return [String(node?.nodeId ?? ""), symbolsBeforeCutoff(
        [...introducedSoFar],
        node?.knowledgeCutoffAt,
      )];
    }));
  }

  const linkedRecordIds = new Set([
    ...normalizeRecordIds(cycle?.brokerLinks?.recordIds),
    ...(Array.isArray(cycle?.brokerLinks?.orderIds) ? cycle.brokerLinks.orderIds : [])
      .map((id) => `order:${String(id ?? "").trim()}`),
    ...(Array.isArray(cycle?.brokerLinks?.executionIds) ? cycle.brokerLinks.executionIds : [])
      .map((id) => `execution:${String(id ?? "").trim()}`),
  ]);
  return new Map((Array.isArray(cutoffs) ? cutoffs : []).map((node) => [
    String(node?.nodeId ?? ""),
    symbolsBeforeCutoff([...linkedRecordIds], node?.knowledgeCutoffAt),
  ]));
}

async function buildCyclePointInTimeTechnical({ cycle, archive, phase, signal }) {
  const sealed = Array.isArray(cycle?.exAnteVersions) ? cycle.exAnteVersions.at(-1) : null;
  const timelineNodes = phase === "blind" && Array.isArray(cycle?.decisionTimeline)
    ? cycle.decisionTimeline
      .map((node, index) => ({
        nodeId: String(node?.nodeId ?? `timeline-node-${index + 1}`),
        timelineIndex: finiteOrNull(node?.timelineIndex) ?? index,
        knowledgeCutoffAt: node?.knowledgeCutoffAt,
        introducedRecordIds: (Array.isArray(node?.brokerFactsIntroduced?.recordIds)
          ? node.brokerFactsIntroduced.recordIds
          : []).map((recordId) => String(recordId ?? "").trim()).filter(Boolean),
      }))
      .filter((node) => Number.isFinite(Date.parse(String(node.knowledgeCutoffAt ?? ""))))
    : [];
  const fallbackAsOf = phase === "blind"
    ? sealed?.knowledgeCutoffAt ?? sealed?.sealedAt
    : cycle?.endAt;
  const cutoffs = timelineNodes.length ? timelineNodes : [{
    nodeId: phase === "blind" ? "initial-plan" : "cycle-outcome",
    timelineIndex: 0,
    knowledgeCutoffAt: fallbackAsOf,
  }];
  const validCutoffs = cutoffs
    .filter((item) => Number.isFinite(Date.parse(String(item.knowledgeCutoffAt ?? ""))))
    .sort((left, right) => left.timelineIndex - right.timelineIndex);
  if (!validCutoffs.length) {
    return {
      status: "unavailable",
      asOf: null,
      cutoffPolicy: "缺少有效的阶段截止时间，未计算历史技术快照。",
      requestedSymbols: [],
      omittedSymbols: [],
      warnings: ["cycle_cutoff_missing"],
      snapshots: [],
      nodes: [],
    };
  }
  const latestCutoff = validCutoffs.reduce((latest, item) => (
    Date.parse(item.knowledgeCutoffAt) > Date.parse(latest.knowledgeCutoffAt) ? item : latest
  ));
  const asOf = latestCutoff.knowledgeCutoffAt;
  const cutoffMs = Date.parse(asOf);
  const activitySymbolsByNode = buildPointInTimeActivitySymbols({
    cycle,
    archive,
    phase,
    cutoffs: validCutoffs,
  });
  const baseCycleSymbols = (Array.isArray(cycle?.symbols) ? cycle.symbols : [])
    .map((item) => String(item ?? "").trim().toUpperCase())
    .filter(Boolean);
  const nodeSymbolPlans = validCutoffs.map((node) => {
    const cycleSymbols = [...new Set([
      ...baseCycleSymbols,
      ...(activitySymbolsByNode.get(node.nodeId) ?? []),
    ])];
    const inferredBenchmark = cycleSymbols.some((symbol) => symbol.endsWith(".US")) ? "QQQ.US" : null;
    const benchmarks = [...new Set([cycle?.benchmark, inferredBenchmark]
      .map((item) => String(item ?? "").trim().toUpperCase()).filter(Boolean))];
    return {
      nodeId: node.nodeId,
      cycleSymbols,
      benchmarks,
      allSymbols: [...new Set([...cycleSymbols, ...benchmarks])],
    };
  });
  const allSymbols = [...new Set(nodeSymbolPlans.flatMap((item) => item.allSymbols))];
  // Business symbols have a bounded budget; the explicitly selected and US
  // market benchmarks have independent slots and share any duplicate request.
  const requestedSymbols = [...new Set([
    ...[...new Set(nodeSymbolPlans.flatMap((item) => item.cycleSymbols))].slice(0, 8),
    ...nodeSymbolPlans.flatMap((item) => item.benchmarks),
  ])];
  const requestedSymbolSet = new Set(requestedSymbols);
  const symbolPlanByNode = new Map(nodeSymbolPlans.map((item) => [item.nodeId, {
    requestedSymbols: item.allSymbols.filter((symbol) => requestedSymbolSet.has(symbol)),
    omittedSymbols: item.allSymbols.filter((symbol) => !requestedSymbolSet.has(symbol)),
  }]));
  const omittedSymbols = allSymbols.filter((symbol) => !requestedSymbolSet.has(symbol));
  if (!requestedSymbols.length) {
    return {
      status: "unavailable",
      asOf: new Date(cutoffMs).toISOString(),
      cutoffPolicy: "仅接受交易日早于阶段截止日期的长桥前复权日线；当前周期没有可计算标的。",
      requestedSymbols,
      omittedSymbols,
      warnings: ["cycle_symbols_missing"],
      snapshots: [],
      nodes: validCutoffs.map((node) => ({
        ...node,
        requestedSymbols: [],
        omittedSymbols: [],
        asOf: new Date(Date.parse(node.knowledgeCutoffAt)).toISOString(),
        status: "unavailable",
        cutoffPolicy: "该节点仅接受交易日早于其 knowledgeCutoffAt 的长桥前复权日线。",
        warnings: ["cycle_symbols_missing"],
        snapshots: [],
      })),
    };
  }
  const technicalController = new AbortController();
  const cancellationError = () => signal?.reason instanceof Error
    ? signal.reason : new Error("历史技术快照预取已取消。");
  if (signal?.aborted) throw cancellationError();
  const settled = new Array(requestedSymbols.length).fill(null);
  let accepting = true;
  let deadlineTimer;
  let resolveCancelled;
  const cancelled = new Promise((resolve) => { resolveCancelled = resolve; });
  const abortTechnical = () => {
    technicalController.abort(signal?.reason);
    resolveCancelled("cancelled");
  };
  signal?.addEventListener?.("abort", abortTechnical, { once: true });
  if (signal?.aborted) abortTechnical();
  // Fetch each symbol exactly once. Every decision node is then calculated
  // from its own strictly filtered prefix of the same immutable daily series.
  const work = Promise.all(requestedSymbols.map(async (symbol, index) => {
    try {
      if (technicalController.signal.aborted) throw cancellationError();
      const candleResult = await portfolioService.candlesWithCoverage(symbol, 600, {
        signal: technicalController.signal,
        preferPersistent: true,
      });
      if (accepting) settled[index] = {
        status: "fulfilled", value: structuredClone({ symbol, candleResult }),
      };
    } catch (reason) {
      if (accepting) settled[index] = { status: "rejected", reason };
    }
  })).then(() => "completed");
  let outcome;
  try {
    const winner = await Promise.race([
      work,
      new Promise((resolve) => { deadlineTimer = setTimeout(() => resolve("timeout"), 2_500); }),
      cancelled,
    ]);
    // Seal before aborting providers: late resolutions and abort callbacks
    // are consumed but cannot edit the already returned evidence snapshot.
    accepting = false;
    if (signal?.aborted || winner === "cancelled") throw cancellationError();
    if (winner === "timeout") technicalController.abort(new Error("历史技术快照预取超时。"));
    outcome = { timedOut: winner === "timeout",
      results: settled.map((item) => item ?? { status: "timed_out" }) };
  } finally {
    accepting = false;
    clearTimeout(deadlineTimer);
    signal?.removeEventListener?.("abort", abortTechnical);
  }
  const barsBySymbol = new Map();
  const candleCoverageBySymbol = new Map();
  const warnings = outcome.timedOut ? ["historical_candles_timeout"] : [];
  const timedOutSymbols = new Set();
  outcome.results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      const candleResult = result.value.candleResult;
      barsBySymbol.set(result.value.symbol, candleResult.candles);
      candleCoverageBySymbol.set(result.value.symbol, candleResult.coverage ?? null);
      if (candleResult.coverage?.partial === true
        || candleResult.coverage?.source === "persistent_fallback") {
        warnings.push(`${result.value.symbol}: cached_or_partial_market_history`);
      }
    } else if (result.status === "timed_out") {
      timedOutSymbols.add(requestedSymbols[index]);
      warnings.push(`${requestedSymbols[index]}: historical_candles_timeout`);
    } else warnings.push(`${requestedSymbols[index]}: ${safeError(result.reason)}`);
  });
  const nodes = validCutoffs.map((node) => {
    const symbolPlan = symbolPlanByNode.get(node.nodeId)
      ?? { requestedSymbols: [], omittedSymbols: [] };
    const nodeWarnings = [];
    const nodeSnapshots = [];
    for (const symbol of symbolPlan.requestedSymbols) {
      const bars = barsBySymbol.get(symbol);
      if (!bars) {
        nodeWarnings.push(`${symbol}: ${timedOutSymbols.has(symbol) ? "historical_candles_timeout" : "historical_candles_unavailable"}`);
        continue;
      }
      try {
        const historicalBars = filterCandlesBeforeReviewCutoff(bars, node.knowledgeCutoffAt);
        const technical = calculateTechnical(historicalBars, {
          symbol,
          analysisTime: new Date(Date.parse(node.knowledgeCutoffAt)).toISOString(),
        });
        nodeSnapshots.push({
          symbol,
          source: "Longbridge forward-adjusted regular-hours daily candles · read only",
          marketHistoryCoverage: candleCoverageBySymbol.get(symbol) ?? null,
          ...technical,
        });
      } catch (error) {
        nodeWarnings.push(`${symbol}: ${safeError(error)}`);
      }
    }
    return {
      ...node,
      ...symbolPlan,
      asOf: new Date(Date.parse(node.knowledgeCutoffAt)).toISOString(),
      status: symbolPlan.requestedSymbols.length > 0
        && nodeSnapshots.length === symbolPlan.requestedSymbols.length
        && symbolPlan.omittedSymbols.length === 0
        ? "complete"
        : nodeSnapshots.length ? "partial"
          : symbolPlan.requestedSymbols.some((symbol) => timedOutSymbols.has(symbol)) ? "timed_out" : "unavailable",
      cutoffPolicy: "严格仅使用交易日早于该节点 knowledgeCutoffAt 的长桥前复权、常规交易时段日线；截止当日整根 K 线保守排除。EMA/Fib 是可选证据。",
      warnings: nodeWarnings,
      snapshots: nodeSnapshots,
    };
  }).sort((left, right) => left.timelineIndex - right.timelineIndex);
  const exposedNode = phase === "blind" ? nodes.at(0) : nodes.at(-1);
  const exposedRequestedSymbols = exposedNode?.requestedSymbols ?? [];
  const exposedOmittedSymbols = exposedNode?.omittedSymbols ?? [];
  const snapshots = exposedNode?.snapshots ?? [];
  return {
    status: exposedNode?.status ?? "unavailable",
    asOf: new Date(Date.parse(exposedNode?.knowledgeCutoffAt ?? asOf)).toISOString(),
    cutoffPolicy: phase === "blind"
      ? "每个决策节点严格仅使用早于其 knowledgeCutoffAt 的长桥前复权日线；同一标的日线只抓取一次，再分别截断计算。EMA/Fib 是可选证据。"
      : "严格仅使用交易日早于阶段截止日期的长桥前复权、常规交易时段日线；截止当日整根 K 线保守排除。EMA/Fib 是可选证据，不是强制结论。",
    requestedSymbols: exposedRequestedSymbols,
    omittedSymbols: exposedOmittedSymbols,
    marketHistoryCoverage: exposedRequestedSymbols.map((symbol) => ({
      symbol,
      ...(candleCoverageBySymbol.get(symbol) ?? { source: "unavailable", coverageStatus: "unavailable" }),
    })),
    warnings: phase === "blind" ? (exposedNode?.warnings ?? []) : warnings,
    snapshots,
    nodes,
  };
}

async function buildCycleTechnicalValidationSample({ cycle, deterministicOutcomeMetrics }) {
  const accountScopeId = currentPortfolioLedgerScopeId();
  const entryAt = deterministicOutcomeMetrics?.tradePricePath?.window?.startAt ?? null;
  const toTradingDate = Number.isFinite(Date.parse(String(entryAt ?? "")))
    ? new Date(Date.parse(entryAt)).toISOString().slice(0, 10)
    : null;
  let radarBatches = [];
  try {
    radarBatches = await technicalRadarStore.listBatches({
      accountScopeId,
      ...(toTradingDate ? { toTradingDate } : {}),
      latestRevisionOnly: false,
      limit: null,
    });
  } catch {
    // The deterministic bridge will preserve the missing snapshot as N/A.
    // A radar ledger read failure must not block the actual trade review.
  }
  const evidenceRevision = Number(
    cycle?.evidenceRevision
      ?? cycle?.brokerLinks?.evidenceRevision
      ?? cycle?.brokerLinks?.revision,
  );
  return buildReviewTechnicalValidationSample({
    accountScopeId,
    radarBatches,
    cycle,
    verifiedOutcome: {
      outcomeMetrics: deterministicOutcomeMetrics,
      evidenceRevision: Number.isInteger(evidenceRevision) && evidenceRevision > 0
        ? evidenceRevision
        : null,
    },
    requestedMode: "historical_calibration",
  });
}

function typedBrokerRecordIds(archive, values) {
  const orderIds = new Set((archive?.orders ?? []).map((item) => String(item.orderId)));
  const executionIds = new Set((archive?.executions ?? []).map((item) => String(item.tradeId)));
  return [...new Set((Array.isArray(values) ? values : []).map((value) => {
    const id = String(value ?? "").trim();
    if (/^(?:order|execution):/.test(id)) return id;
    if (orderIds.has(id)) return `order:${id}`;
    if (executionIds.has(id)) return `execution:${id}`;
    return id;
  }).filter(Boolean))];
}

function requestTvBounds() {
  mainWindow?.webContents.send("cockpit:request-tv-bounds");
}

async function rememberTradingViewUrl(url) {
  if (!isTradingViewUrl(url) || trustedRestoreInProgress) return;
  pendingTvUrl = url;
  if (tvUrlSaveTimer) clearTimeout(tvUrlSaveTimer);
  tvUrlSaveTimer = setTimeout(() => {
    const value = pendingTvUrl;
    pendingTvUrl = null;
    tvUrlSaveTimer = null;
    if (value && !trustedRestoreInProgress) {
      businessStateStore.set("tradingViewLastUrl", value).catch((error) => {
        sendTvState({ state: "degraded", message: `无法保存 TradingView 页面状态：${safeError(error)}` });
      });
    }
  }, 350);
}

function sendStatus(payload) {
  safeSend("cockpit:status", {
    ...payload,
    domain: statusDomain(payload),
    storage: storageHealthSnapshot([secureStore, businessStateStore, reviewDataStore, marketHistoryDataStore, portfolioSnapshotDataStore, technicalRadarDataStore]),
  });
}

function publishStorageHealth() {
  const storage = storageHealthSnapshot([secureStore, businessStateStore, reviewDataStore, marketHistoryDataStore, portfolioSnapshotDataStore, technicalRadarDataStore]);
  safeSend("cockpit:status", {
    domain: "storage", state: storage.state === "degraded" ? "storage_degraded" : "storage_status", storage,
  });
}

function sendTvState(payload) {
  safeSend("cockpit:tv-state", payload);
}

function safeSend(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return false;
  mainWindow.webContents.send(channel, payload);
  if (channel === "cockpit:portfolio" && ibkr) publishBrokerViews();
  return true;
}

async function readSystemHealthSnapshot() {
  const identity = captureReviewAccountOperation();
  const ibkrGeneration = ibkr?.generation;
  const codex = codexAnalysis.status();
  const [portfolioSnapshots, radarIntegrity, lastAgentResult, snapshotCapacity, radarCapacity, snapshotDisk, radarDisk] = await Promise.all([
    portfolioSnapshotLedgerStatus({ reconcile: false }),
    technicalRadarStore?.verifyIntegrity().catch(() => null) ?? null,
    codex.threadId ? agentResults.peek(codex.threadId) ?? agentResults.latest(codex.threadId) : null,
    portfolioSnapshotStore?.capacity?.().catch(() => null) ?? null,
    technicalRadarStore?.capacity?.().catch(() => null) ?? null,
    portfolioSnapshotDataStore?.diskUsage?.().catch(() => null) ?? null,
    technicalRadarDataStore?.diskUsage?.().catch(() => null) ?? null,
  ]);
  assertReviewAccountOperation(identity);
  if (ibkrGeneration !== ibkr?.generation) throw new Error("读取状态时 IBKR 连接已变化，请重新刷新。");
  return buildSystemHealthSnapshot({
    now: new Date(), version: app.getVersion(),
    storage: storageHealthSnapshot([secureStore, businessStateStore, reviewDataStore, marketHistoryDataStore, portfolioSnapshotDataStore, technicalRadarDataStore]),
    longbridge: longbridge.status(), brokers: brokerUiSnapshot(), portfolioSnapshots,
    codex, lastAgentResult, activeAgents: activeAgentSnapshot(),
    capacities: [
      { id: "portfolio_snapshots", label: "组合快照账本", count: snapshotCapacity?.activeCount ?? null,
        totalCount: snapshotCapacity?.snapshotCount ?? null, archivedCount: snapshotCapacity?.archivedCount ?? null,
        limit: portfolioSnapshotStore?.maxSnapshots ?? null, bytes: snapshotCapacity?.serializedBytes ?? null,
        totalBytes: snapshotCapacity?.totalSerializedBytes ?? null, diskBytes: snapshotDisk?.bytes ?? null,
        observedAt: snapshotDisk?.observedAt ?? null, byteLimit: portfolioSnapshotStore?.maxSerializedBytes ?? null },
      { id: "technical_radar", label: "技术雷达账本", count: radarCapacity?.activeCount ?? null,
        totalCount: radarCapacity?.batchCount ?? null, archivedCount: radarCapacity?.archivedCount ?? null,
        limit: technicalRadarStore?.maxBatches ?? null, bytes: radarCapacity?.serializedBytes ?? null,
        totalBytes: radarCapacity?.totalSerializedBytes ?? null, diskBytes: radarDisk?.bytes ?? null,
        observedAt: radarDisk?.observedAt ?? null, byteLimit: technicalRadarStore?.maxBytes ?? null },
    ],
  });
}

function brokerUiSnapshot() {
  return { views: buildBrokerViews({ longbridge: portfolio, ibkr: ibkr?.portfolio,
    ibkrEnabled: ibkr?.config.enabled }), ibkr: ibkr?.status() ?? null };
}

function publishBrokerViews() {
  safeSend("cockpit:brokers", brokerUiSnapshot());
}

function assertTrustedSender(event) {
  if (isTrustedSender(event)) return;
  throw new Error("Rejected IPC from an untrusted renderer.");
}

function assertTrustedRestoreIdle() {
  if (!trustedRestoreInProgress) return;
  const error = new Error("本机恢复预检或历史归档正在进行；业务数据暂时只读，请完成或取消后重试。");
  error.code = "trusted_restore_in_progress";
  throw error;
}

function isTrustedSender(event) {
  try {
    const senderPath = fileURLToPath(event.senderFrame.url);
    return path.normalize(senderPath) === path.normalize(rendererPath);
  } catch {
    return false;
  }
}

function guardLocalRenderer(contents) {
  const localUrl = pathToFileURL(rendererPath).toString();
  const preventUnexpectedNavigation = (event, legacyUrl, _isInPlace, isMainFrame = true) => {
    if (isMainFrame === false) return;
    const target = event.url ?? legacyUrl;
    if (target !== localUrl) event.preventDefault();
  };
  contents.on("will-navigate", preventUnexpectedNavigation);
  contents.on("will-redirect", preventUnexpectedNavigation);
  contents.on("will-frame-navigate", preventUnexpectedNavigation);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("before-input-event", (event, input) => {
    const modifier = process.platform === "darwin" ? input.meta : input.control;
    if (modifier && ["+", "=", "-", "0"].includes(input.key)) event.preventDefault();
  });
}

function isTradingViewResourceUrl(value) {
  if (isTradingViewUrl(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "blob:" && isTradingViewUrl(url.pathname);
  } catch {
    return false;
  }
}

function markCurrentPortfolioStale(reason) {
  if (!portfolio) return null;
  portfolio = withPortfolioFreshness(portfolio, {
    forceState: "stale",
    reason,
  });
  safeSend("cockpit:portfolio", portfolio);
  return portfolio;
}

function isStaleLongbridgeAuthorizationError(error) {
  return error?.code === "STALE_LONGBRIDGE_AUTHORIZATION_GENERATION";
}

function stalePortfolioAccountScopeError() {
  const error = new Error("长桥账户范围已变化；旧账户持仓或快照结果已丢弃。");
  error.code = "STALE_LONGBRIDGE_AUTHORIZATION_GENERATION";
  return error;
}

export function preferredLongbridgeEndpoint() {
  return "https://mcp.longbridge.com/v2";
}

function validateAnalysisScope(value) {
  const scope = String(value ?? "position").trim().toLowerCase();
  if (!["chat", "position", "candidate", "portfolio", "review"].includes(scope)) {
    throw new Error("分析范围无效。");
  }
  return scope;
}

function normalizeAnalysisSymbol(value) {
  let symbol = String(value ?? "").trim().toUpperCase();
  const tvMarket = symbol.match(/^(NASDAQ|NYSE|AMEX):(.+)$/);
  const tvHongKong = symbol.match(/^HKEX:(.+)$/);
  if (tvMarket) symbol = `${tvMarket[2]}.US`;
  else if (tvHongKong) symbol = `${tvHongKong[1]}.HK`;
  else if (symbol && !symbol.includes(".")) symbol = `${symbol}.US`;
  if (!/^[A-Z0-9._-]{1,30}$/.test(symbol)) throw new Error("证券代码无效。");
  return symbol;
}

function validateOperationId(value) {
  const operationId = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(operationId) ? operationId : null;
}

function validateThreadId(value) {
  const threadId = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{4,200}$/.test(threadId)) throw new Error("Codex 会话 ID 无效。");
  return threadId;
}

async function sessionPayload(session = null, { includeLastResult = true } = {}) {
  await migrateLegacyAgentResult().catch(() => {});
  const listing = await codexAnalysis.listSessions();
  // When two open requests overlap, bind every response to the exact session
  // requested by that IPC call. The renderer can then discard a stale reply
  // without ever pairing one thread's transcript with another thread's ID.
  const threadId = String(session?.id ?? session?.threadId ?? listing.currentThreadId ?? "") || null;
  const transcript = Array.isArray(session?.transcript) ? session.transcript : null;
  const cleanSession = session && transcript ? { ...session, transcript: undefined } : session;
  const sessions = listing.sessions.map((item) => {
    const operationId = activeAgentByThread.get(item.id) ?? item.operationId ?? null;
    return {
      ...item,
      runState: operationId ? "running" : item.runState ?? "idle",
      operationId,
    };
  });
  return {
    ...listing,
    sessions,
    activeSessionId: threadId,
    session: cleanSession ?? sessions.find((item) => item.current) ?? null,
    transcript,
    activeAgents: activeAgentSnapshot(),
    activeAgent: activeAgentForThread(threadId),
    lastAgentResult: includeLastResult && threadId
      ? agentResults.peek(threadId) ?? await agentResults.latest(threadId)
      : null,
  };
}

function activeAgentSnapshot() {
  return [...activeAgentOperations.values()].map((operation) => ({
    operationId: operation.operationId,
    threadId: operation.threadId,
    startedAt: new Date(operation.startedAt).toISOString(),
    task: operation.task ?? "",
  }));
}

function activeAgentForThread(threadId) {
  const operationId = threadId ? activeAgentByThread.get(threadId) : null;
  const operation = operationId ? activeAgentOperations.get(operationId) : null;
  return operation ? {
    operationId: operation.operationId,
    threadId: operation.threadId,
    startedAt: new Date(operation.startedAt).toISOString(),
    task: operation.task ?? "",
  } : null;
}

function settleActiveAgentOperation({ threadId, operationId }) {
  if (operationId) activeAgentOperations.delete(operationId);
  if (threadId && activeAgentByThread.get(threadId) === operationId) {
    activeAgentByThread.delete(threadId);
  }
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("操作已取消。"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal?.addEventListener?.("abort", () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("操作已取消。"));
    }, { once: true });
  });
}

async function migrateLegacyAgentResult() {
  const legacy = normalizeAgentResult(await businessStateStore.get(LAST_AGENT_RESULT_KEY));
  if (!legacy) return;
  await agentResults.save(legacy);
  await businessStateStore.delete(LAST_AGENT_RESULT_KEY);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function safeError(error) {
  return error instanceof Error ? error.message : "未知错误";
}

function agentFailureEnvelope(error) {
  const errorCode = String(error?.kind ?? error?.code ?? "agent_error");
  const protocolContractFailure = Number(error?.rpcCode) === -32602
    && /additionalContext|additional_context|experimentalApi/i.test(safeError(error));
  const nonRetryable = new Set([
    "context_budget",
    "context_manifest",
    "context_contract",
    "review_skill_missing",
    "review_thread_binding",
    "blind_time_firewall",
    "additional_context_unsupported",
  ]).has(errorCode) || protocolContractFailure;
  return {
    error: safeError(error),
    errorCode,
    retryable: !nonRetryable,
    contextDiagnostics: error?.contextDiagnostics ?? null,
    ...(["terminal_unverified", "history_incomplete"].includes(errorCode) ? {
      partial: true,
      complete: false,
      deliveryStatus: error?.deliveryStatus ?? errorCode,
      partialText: typeof error?.partialText === "string" ? error.partialText : "",
      threadId: error?.threadId ?? null,
      turnId: error?.turnId ?? null,
      operationId: error?.operationId ?? null,
    } : {}),
    protocolError: error?.rpcCode == null
      ? null
      : {
          code: error.rpcCode,
          method: error.rpcMethod ?? null,
          data: error.rpcData ?? null,
        },
  };
}

function longbridgeFailureStatus(error, fallbackMessage) {
  const classification = classifyLongbridgeError(error);
  if (classification.kind === "transport") {
    return {
      state: "network_error",
      message: "长桥全球节点网络连接失败",
      detail: `GLOBAL · macOS 系统代理 · ${safeError(error)}`,
    };
  }
  if (classification.kind === "auth") {
    return {
      state: "reauth_required",
      message: "长桥授权已过期，请重新连接",
      detail: safeError(error),
    };
  }
  if (classification.kind === "permission") {
    if (classification.reauth) {
      return {
        state: "scope_upgrade_required",
        message: "长桥历史查询需要升级只读授权",
        detail: safeError(error),
      };
    }
    return {
      state: "permission_error",
      message: "长桥账户读取权限不足",
      detail: safeError(error),
    };
  }
  if (classification.kind === "gateway") {
    return {
      state: "service_degraded",
      message: `长桥上游服务暂不可用${classification.code ? ` (${classification.code})` : ""}`,
      detail: "授权仍然有效；已保留最近一次加密快照。",
    };
  }
  return { state: "error", message: fallbackMessage, detail: safeError(error) };
}
