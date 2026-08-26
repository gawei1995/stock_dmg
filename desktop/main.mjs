import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  safeStorage,
  session,
  shell,
  WebContentsView,
} from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EncryptedStore } from "./src/security/encrypted-store.mjs";
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
import { MarketHistoryStore } from "./src/data/market-history-store.mjs";
import {
  isCurrentRegularCloseSnapshot,
  PortfolioSnapshotStore,
  PORTFOLIO_SNAPSHOT_STORE_KEY,
  REGULAR_CLOSE_VALUATION_METHOD_VERSION,
} from "./src/data/portfolio-snapshot-store.mjs";
import { EcbReferenceFxProvider } from "./src/data/reference-fx.mjs";
import {
  portfolioFreshness,
  withPortfolioFreshness,
} from "./src/data/freshness.mjs";
import { AgentResultStore, normalizeAgentResult } from "./src/data/agent-result-store.mjs";
import { ReviewStore, calculateRuleMetrics } from "./src/data/review-store.mjs";
import { ReviewCycleStore } from "./src/data/review-cycle-store.mjs";
import {
  matchExecutionsToEvent,
  matchOrdersToEvent,
  partitionReviewExecutions,
  partitionReviewOrders,
  TradeHistoryService,
} from "./src/data/trade-history-service.mjs";
import { buildAnalysisEvidence } from "./src/engine/agent.mjs";
import { calculateTechnical, classifyLastDailyBar } from "./src/engine/technical.mjs";
import {
  applyCodexWorkspaceAnalysis,
  CodexWorkspaceService,
  resolveCodexExecutable,
} from "./src/engine/codex-workspace.mjs";
import {
  buildReviewAnalysisRun,
  selectReviewCaseIds,
} from "./src/review/review-analysis.mjs";
import {
  buildReviewCycleAnalysisRun,
  filterCandlesBeforeReviewCutoff,
  selectCycleRecordIds,
} from "./src/review/review-cycle-analysis.mjs";
import {
  buildReviewCycleOutcomeMetrics,
  summarizeTradePricePath,
} from "./src/review/review-cycle-outcome-metrics.mjs";
import { deriveSelectedBuySellWindow } from "./src/review/review-trade-price-path.mjs";
import { reviewMonthRange } from "./src/review/review-calendar.mjs";
import {
  annotateLearningSources,
  assertLearningSourceCurrent,
} from "./src/review/review-learning-source.mjs";
import {
  buildValidationCandidateIndex,
  currentValidationReviewRun,
} from "./src/review/review-validation-candidates.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererPath = path.join(__dirname, "renderer", "index.html");
const DEFAULT_TV_URL = "https://www.tradingview.com/chart/";
const MARKET_HISTORY_STORE_KEY = "marketHistoryCacheV1";
const MARKET_HISTORY_STORE_FILE = "market-history.bin";
const PORTFOLIO_SNAPSHOT_STORE_FILE = "portfolio-snapshots.bin";
const PORTFOLIO_LEDGER_SCOPE_STORE_KEY = "portfolioLedgerScopeIdV1";
const LEGACY_PORTFOLIO_LEDGER_SCOPE_ID = "longbridge-primary-usd-v1";

let mainWindow;
let tvView;
let tvSession;
let secureStore;
let reviewDataStore;
let longbridge;
let portfolioService;
let portfolioSnapshotStore;
let portfolioLedgerScopeId = null;
let tradeHistoryService;
let reviewStore;
let reviewCycleStore;
let portfolio;
let codexAnalysis;
let agentResults;
const activeAgentOperations = new Map();
const activeAgentByThread = new Map();
let reviewLearningMutationQueue = Promise.resolve();
let portfolioSnapshotSweep = null;
let portfolioSnapshotTimer = null;
let portfolioSnapshotCaptureQueue = Promise.resolve();
let portfolioSnapshotCaptureRuntime = {
  lastAttemptAt: null,
  lastAttemptTradingDate: null,
  lastSuccessAt: null,
  lastSuccessTradingDate: null,
  lastError: null,
  outcome: null,
};
let lastTvBounds = { x: 292, y: 86, width: 820, height: 780 };
let tvMainLoadFailed = false;
let pendingTvUrl = null;
let tvUrlSaveTimer = null;
let workspaceMode = "cockpit";
const hardenedSessions = new WeakSet();
const tvPopups = new Set();
const AGENT_PORTFOLIO_REFRESH_WAIT_MS = 1_500;
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
  eodSnapshotsPerTradingDate: 1,
  eodValuationSession: "regular_close",
  eodValuationMethodVersion: REGULAR_CLOSE_VALUATION_METHOD_VERSION,
  extendedHoursHandling: "separate_observation_never_overwrite_eod",
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on("second-instance", () => {
  if (!mainWindow) return;
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
  });
  reviewDataStore = new EncryptedStore({
    directory: app.getPath("userData"),
    safeStorage,
    fileName: "review-data.bin",
  });
  const marketHistoryDataStore = new EncryptedStore({
    directory: app.getPath("userData"),
    safeStorage,
    fileName: MARKET_HISTORY_STORE_FILE,
  });
  const portfolioSnapshotDataStore = new EncryptedStore({
    directory: app.getPath("userData"),
    safeStorage,
    fileName: PORTFOLIO_SNAPSHOT_STORE_FILE,
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
  portfolioLedgerScopeId = await initializePortfolioLedgerScope({
    metadataStore: secureStore,
    snapshotStore: portfolioSnapshotDataStore,
  });
  agentResults = new AgentResultStore({ store: secureStore });
  longbridge = new LongbridgeClient({
    endpoint: preferredLongbridgeEndpoint(),
    fetchFn: longbridgeFetch,
    networkStack: "electron-system-proxy",
    store: secureStore,
    openExternal: (url) => shell.openExternal(url),
    onStatus: sendStatus,
    clientVersion: app.getVersion(),
  });
  portfolioService = new PortfolioService({
    longbridge,
    store: secureStore,
    onStatus: sendStatus,
    referenceFxProvider: new EcbReferenceFxProvider({
      store: secureStore,
      fetchImpl: longbridgeFetch,
    }),
    marketHistoryStore: new MarketHistoryStore({
      store: marketHistoryDataStore,
      endpoint: longbridge.endpoint,
    }),
  });
  portfolioSnapshotStore = new PortfolioSnapshotStore({ store: portfolioSnapshotDataStore });
  tradeHistoryService = new TradeHistoryService({
    longbridge,
    store: reviewDataStore,
    onStatus: sendStatus,
  });
  reviewStore = new ReviewStore({ store: reviewDataStore });
  reviewCycleStore = new ReviewCycleStore({ store: reviewDataStore });
  portfolio = await portfolioService.cachedPortfolio();
  const codexPath = await resolveCodexExecutable();
  const configuredWorkspace = process.env.TRADING_COCKPIT_CODEX_WORKSPACE;
  const workspaceDirectory = configuredWorkspace && path.isAbsolute(configuredWorkspace)
    ? configuredWorkspace
    : path.join(app.getPath("documents"), "stock_agent", "trading-agent-workspace");
  codexAnalysis = new CodexWorkspaceService({
    codexPath,
    workspaceDirectory,
    store: secureStore,
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
  });

  registerIpc();
  await createWindow();
  portfolioSnapshotTimer = setInterval(() => {
    void ensureAutomaticPortfolioSnapshots().catch(() => {});
  }, 15 * 60 * 1000);

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
      const scopeId = currentPortfolioLedgerScopeId();
      portfolio = await portfolioService.refresh();
      safeSend("cockpit:portfolio", portfolio);
      scheduleFreshPortfolioEvidence(portfolio, { scopeId });
    } catch (error) {
      markCurrentPortfolioStale(`恢复长桥连接失败：${safeError(error)}`);
      sendStatus(longbridgeFailureStatus(error, "恢复长桥连接失败"));
    }
  } else if (await longbridge.needsAuthorizationUpgrade()) {
    sendStatus({
      state: "scope_upgrade_required",
      message: "长桥历史查询需要升级只读授权",
      detail: "旧授权只包含账户与持仓读取；点击“升级只读授权”补充订单与成交历史查询，不会申请下单权限。",
    });
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", async () => {
  if (portfolioSnapshotTimer) clearInterval(portfolioSnapshotTimer);
  for (const operation of activeAgentOperations.values()) operation.controller.abort();
  codexAnalysis?.dispose();
  try {
    await tvSession?.flushStorageData();
  } catch {
    // Best effort only.
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1280,
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
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
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

  Promise.resolve(secureStore.get("tradingViewLastUrl")).then((saved) => {
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
        ?? normalizeAgentResult(await secureStore.get(LAST_AGENT_RESULT_KEY), {
          threadId: activeThreadId,
        })
      : null;
    return {
      portfolio,
      longbridge: {
        ...longbridge.status(),
        hasSavedAuthorization: await longbridge.hasSavedAuthorization(),
        needsAuthorizationUpgrade: await longbridge.needsAuthorizationUpgrade(),
      },
      storage: {
        encrypted: secureStore.persistent,
        recoveredUnreadableState: Boolean(secureStore.recoveryBackupPath),
      },
      codex: codexAnalysis.status(),
      activeAgents: activeAgentSnapshot(),
      activeAgent: activeAgentForThread(activeThreadId),
      lastAgentResult,
      safeguards: { orderWrite: false, modelNarration: codexAnalysis.available },
    };
  });

  ipcMain.handle("workspace:set-mode", async (event, request) => {
    assertTrustedSender(event);
    const mode = request?.mode === "review" ? "review" : "cockpit";
    workspaceMode = mode;
    tvView?.setVisible?.(mode === "cockpit");
    if (mode === "cockpit") requestTvBounds();
    return { ok: true, mode };
  });

  ipcMain.handle("review:snapshot", async (event) => {
    assertTrustedSender(event);
    return buildReviewSnapshot();
  });

  ipcMain.handle("review:portfolio-snapshot:capture", async (event, request) => {
    assertTrustedSender(event);
    if (!longbridge?.connected) {
      throw new Error("长桥尚未连接，不能把旧持仓缓存保存为新的观察快照。");
    }
    const scopeId = currentPortfolioLedgerScopeId();
    portfolio = await portfolioService.refresh();
    safeSend("cockpit:portfolio", portfolio);
    const captured = await appendPortfolioSnapshot(portfolio, {
      kind: "manual",
      idempotencyKey: `manual:${portfolio.syncedAt}`,
      note: String(request?.note ?? "").trim().slice(0, 1_000) || "用户手动保存组合观察快照",
    }, { scopeId });
    scheduleFreshPortfolioEvidence(portfolio, { scopeId });
    return { ok: true, snapshot: captured.snapshot, reviewSnapshot: await buildReviewSnapshot() };
  });

  ipcMain.handle("review:intake:snapshot", async (event, request) => {
    assertTrustedSender(event);
    if (Array.isArray(request?.recordIds) && request.recordIds.length) {
      await tradeHistoryService.lookupEventCandidates({ recordIds: request.recordIds });
    }
    const snapshot = await buildReviewSnapshot(request);
    return { ok: true, intake: snapshot.intake, snapshot };
  });

  ipcMain.handle("review:intake:events", async (event, request) => {
    assertTrustedSender(event);
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
    const lookup = await tradeHistoryService.preloadRecentEventCandidates({
      symbols: request?.symbols,
      asOf: request?.asOf,
    });
    return { ok: true, ...lookup };
  });

  ipcMain.handle("review:case:create", async (event, request) => {
    assertTrustedSender(event);
    const reviewCase = await reviewStore.createCase(request);
    return { ok: true, reviewCase, snapshot: await buildReviewSnapshot() };
  });

  ipcMain.handle("review:case:create-from-records", async (event, request) => {
    assertTrustedSender(event);
    let selection = null;
    if (request?.eventCandidateId) {
      selection = await tradeHistoryService.resolveReviewSelection({
        recordIds: request?.recordIds,
        eventCandidateId: request.eventCandidateId,
      }).catch(() => null);
    }
    if (!selection) {
      await tradeHistoryService.lookupEventCandidates({ recordIds: request?.recordIds });
      selection = await tradeHistoryService.resolveReviewSelection({
        recordIds: request?.recordIds,
        eventCandidateId: request?.eventCandidateId,
      });
    }
    const reviewCase = await reviewStore.createCaseFromBrokerRecords({
      ...selection,
      strategyType: request?.strategyType,
      benchmark: request?.benchmark,
      primaryHorizon: request?.primaryHorizon,
    });
    return { ok: true, reviewCase, selection, snapshot: await buildReviewSnapshot() };
  });

  ipcMain.handle("review:case:update", async (event, request) => {
    assertTrustedSender(event);
    const reviewCase = await reviewStore.updateCase(request?.caseId, request?.patch);
    return { ok: true, reviewCase, snapshot: await buildReviewSnapshot() };
  });

  ipcMain.handle("review:case:freeze", async (event, request) => {
    assertTrustedSender(event);
    const version = await reviewStore.freezeCase(request?.caseId, {
      reason: request?.reason,
    });
    return { ok: true, version, snapshot: await buildReviewSnapshot() };
  });

  ipcMain.handle("review:case:link-broker", async (event, request) => {
    assertTrustedSender(event);
    const archive = await tradeHistoryService.cached();
    const recordIds = typedBrokerRecordIds(archive, request?.recordIds);
    const selection = await tradeHistoryService.resolveBrokerRecords({ recordIds });
    const workspace = await reviewStore.snapshot();
    const reviewCase = workspace.cases.find((item) => item.id === String(request?.caseId ?? ""));
    if (!reviewCase) throw new Error("未找到复盘案例。");
    if (selection.relatedSymbols.length !== 1 || selection.relatedSymbols[0] !== reviewCase.symbol) {
      throw new Error("所选长桥记录与当前案例标的不一致，已拒绝关联。");
    }
    const links = await reviewStore.replaceBrokerRecords(request?.caseId, {
      orderIds: selection.orderIds,
      executionIds: selection.executionIds,
      reason: request?.reason ?? (request?.replace ? "用户重新选择案例订单与成交" : "确认案例订单与成交"),
    });
    return { ok: true, links, selection, snapshot: await buildReviewSnapshot() };
  });

  ipcMain.handle("review:cycle:create", async (event, request) => {
    assertTrustedSender(event);
    const cycle = await reviewCycleStore.createCycle({
      ...request,
      startingPortfolio: reviewStartingPortfolioSnapshot(portfolio, request?.startAt),
    });
    return { ok: true, cycle, snapshot: await buildReviewSnapshot() };
  });

  ipcMain.handle("review:cycle:create-order-first", async (event, request) => {
    assertTrustedSender(event);
    const archive = await tradeHistoryService.cached();
    const flow = request?.flow === "single_symbol" ? "single_symbol" : "monthly";
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
      ? await tradeHistoryService.resolveBrokerRecords({ recordIds: seedRecordIds })
      : {
        relatedSymbols: [], activityStartAt: null, activityEndAt: null,
        requestedRecordIds: [], recordIds: [], orderIds: [], executionIds: [], records: [],
      };
    if (flow === "single_symbol") {
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
      links: brokerLinksFromSelection(selection),
      retrospectiveNote: cycleInput.reviewMode === "lightweight" ? request.retrospectiveNote : null,
    });
    return { ok: true, cycle, selection, snapshot: await buildReviewSnapshot() };
  });

  ipcMain.handle("review:cycle:update", async (event, request) => {
    assertTrustedSender(event);
    return withReviewLearningMutation(async () => {
      const cycle = await reviewCycleStore.updateCycle(request);
      return { ok: true, cycle, snapshot: await buildReviewSnapshot() };
    });
  });

  ipcMain.handle("review:cycle:retrospective-note", async (event, request) => {
    assertTrustedSender(event);
    return withReviewLearningMutation(async () => {
      const version = await reviewCycleStore.saveRetrospectiveNote(request);
      return { ok: true, version, snapshot: await buildReviewSnapshot() };
    });
  });

  ipcMain.handle("review:cycle:seal", async (event, request) => {
    assertTrustedSender(event);
    return withReviewLearningMutation(async () => {
      const version = await reviewCycleStore.sealCycle(request);
      return { ok: true, version, snapshot: await buildReviewSnapshot() };
    });
  });

  ipcMain.handle("review:cycle:link-broker", async (event, request) => {
    assertTrustedSender(event);
    return withReviewLearningMutation(async () => {
      const cycleId = String(request?.cycleId ?? "").trim();
      const [cycleWorkspace, archive] = await Promise.all([
        reviewCycleStore.snapshot(),
        tradeHistoryService.cached(),
      ]);
      const cycle = cycleWorkspace.cycles.find((item) => item.id === cycleId);
      if (!cycle) throw new Error("未找到复盘周期。");
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
      const explicitTradeWindow = replace && cycleKind === "trade_window"
        ? selectedBuySellWindow(selection, archive)
        : null;
      if (replace && cycleKind === "trade_window") {
        assertCycleBrokerSymbols(cycle, selection);
      } else {
        assertCycleBrokerSelection(cycle, selection);
      }
      const linkInput = {
        cycleId,
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
        ...(replace && cycleKind === "trade_window" ? {
          activityStartAt: explicitTradeWindow.windowStartAt,
          activityEndAt: explicitTradeWindow.windowEndAt,
        } : {}),
      };
      const links = replace
        ? await reviewCycleStore.replaceCycleBrokerRecords(linkInput)
        : await reviewCycleStore.linkCycleRecords(linkInput);
      return { ok: true, links, selection, snapshot: await buildReviewSnapshot() };
    });
  });

  ipcMain.handle("review:cycle:checkpoint", async (event, request) => {
    assertTrustedSender(event);
    return withReviewLearningMutation(async () => {
      const checkpoint = await reviewCycleStore.addCycleCheckpoint(request);
      return { ok: true, checkpoint, snapshot: await buildReviewSnapshot() };
    });
  });

  const syncReviewHistory = async (request) => {
    let syncedArchive = null;
    try {
      syncedArchive = await tradeHistoryService.sync({
        startAt: request?.from ?? request?.startAt,
        endAt: request?.to ?? request?.endAt,
        symbol: request?.symbol,
      });
    } catch (error) {
      const classification = classifyLongbridgeError(error);
      if (classification.reauth) {
        sendStatus(longbridgeFailureStatus(error, "长桥历史同步需要重新授权"));
      }
      return {
        ok: false,
        errorCode: classification.code === 403308
          ? "LONGBRIDGE_HISTORY_SCOPE_REQUIRED"
          : classification.kind === "auth" && classification.reauth
            ? "LONGBRIDGE_REAUTH_REQUIRED"
          : "LONGBRIDGE_HISTORY_SYNC_FAILED",
        error: safeError(error),
        cachePreserved: true,
      };
    }
    await capturePostTradeAfterHistorySync(syncedArchive).catch((error) => sendStatus({
      state: "snapshot_degraded",
      message: "订单历史已同步，但成交后组合快照未能补充",
      detail: safeError(error),
    }));
    try {
      const snapshot = await buildReviewSnapshot(request);
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
    return syncReviewHistory(request);
  });

  ipcMain.handle("review:intake:sync", async (event, request) => {
    assertTrustedSender(event);
    return syncReviewHistory(request);
  });

  ipcMain.handle("review:test:register", async (event, request) => {
    assertTrustedSender(event);
    const experiment = await reviewStore.registerTest(request);
    return { ok: true, experiment, snapshot: await buildReviewSnapshot() };
  });

  ipcMain.handle("review:test:complete", async (event, request) => {
    assertTrustedSender(event);
    return withReviewLearningMutation(async () => {
      await assertReviewLearningMutationSource({ testId: request?.testId });
      const observation = await assertReviewObservationCycle({
        testId: request?.testId,
        reviewCycleId: request?.reviewCycleId,
      });
      const experiment = await reviewStore.completeTest(request?.testId, {
        ...request,
        observationTiming: observation?.timing ?? "unknown",
      });
      return { ok: true, experiment, snapshot: await buildReviewSnapshot() };
    });
  });

  ipcMain.handle("review:rule:create", async (event, request) => {
    assertTrustedSender(event);
    const rule = await reviewStore.createRule(request);
    return { ok: true, rule, snapshot: await buildReviewSnapshot() };
  });

  ipcMain.handle("review:rule:transition", async (event, request) => {
    assertTrustedSender(event);
    return withReviewLearningMutation(async () => {
      await assertReviewLearningMutationSource({ ruleId: request?.ruleId });
      const rule = await reviewStore.transitionRule(request?.ruleId, {
        status: request?.to ?? request?.status,
        reason: request?.reason,
      });
      return { ok: true, rule, snapshot: await buildReviewSnapshot() };
    });
  });

  ipcMain.handle("review:rule:review", async (event, request) => {
    assertTrustedSender(event);
    return withReviewLearningMutation(async () => {
      await assertReviewLearningMutationSource({ ruleId: request?.ruleId });
      const ruleReview = await reviewStore.addRuleReview(request?.ruleId, {
        decision: request?.decision,
        evidence: request?.evidence ?? request?.keep,
        change: request?.change,
        nextTrigger: request?.nextTrigger,
      });
      return { ok: true, ruleReview, snapshot: await buildReviewSnapshot() };
    });
  });

  ipcMain.handle("review:validation:create-version", async (event, request) => {
    assertTrustedSender(event);
    return withReviewLearningMutation(async () => {
      await assertReviewLearningMutationSource({ ruleId: request?.ruleId ?? request?.parentRuleId });
      const created = await reviewStore.createValidationVersion(request);
      return { ok: true, ...created, snapshot: await buildReviewSnapshot() };
    });
  });

  ipcMain.handle("review:validation:archive", async (event, request) => {
    assertTrustedSender(event);
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
    await codexAnalysis.prepare();
    return codexAnalysis.capabilities();
  });

  ipcMain.handle("agent:history:list", async (event, request) => {
    assertTrustedSender(event);
    return codexAnalysis.recentHistory({
      query: String(request?.query ?? "").slice(0, 200),
      limit: Math.min(Math.max(Number(request?.limit) || 20, 1), 40),
      includeTurns: false,
    });
  });

  ipcMain.handle("agent:sessions:list", async (event) => {
    assertTrustedSender(event);
    return sessionPayload();
  });

  ipcMain.handle("agent:sessions:create", async (event, request) => {
    assertTrustedSender(event);
    const session = await codexAnalysis.createSession({
      name: String(request?.name ?? "").slice(0, 120),
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
    const session = await codexAnalysis.openSession(String(request?.threadId ?? ""));
    safeSend("cockpit:agent-capabilities", codexAnalysis.capabilities());
    return sessionPayload(session);
  });

  ipcMain.handle("agent:sessions:open", async (event, request) => {
    assertTrustedSender(event);
    const session = await codexAnalysis.openSession(String(request?.threadId ?? ""));
    safeSend("cockpit:agent-capabilities", codexAnalysis.capabilities());
    return sessionPayload(session);
  });

  ipcMain.handle("agent:result:recover", async (event, request) => {
    assertTrustedSender(event);
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
    const historicalTurn = !matchingResult && !active
      ? await codexAnalysis.recoverLatestTurn({
          threadId,
          task: String(request?.task ?? "").slice(0, 4_000),
          operationId,
        }).catch(() => null)
      : null;
    return {
      threadId,
      operationId,
      active,
      result: matchingResult,
      historicalTurn,
    };
  });

  ipcMain.handle("longbridge:connect", async (event, request) => {
    assertTrustedSender(event);
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
          detail: "不会申请、开放或调用提交订单、改单、撤单权限；现有持仓和复盘缓存不会被删除。",
        };
        const confirmation = owner && !owner.isDestroyed()
          ? await dialog.showMessageBox(owner, options)
          : await dialog.showMessageBox(options);
        if (confirmation.response !== 1) {
          return { ok: false, cancelled: true };
        }
        await longbridge.disconnect({ forget: true });
      }
      await longbridge.connect({ interactive: true });
    } catch (error) {
      markCurrentPortfolioStale(`长桥连接失败：${safeError(error)}`);
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
      const scopeId = currentPortfolioLedgerScopeId();
      portfolio = await portfolioService.refresh();
      safeSend("cockpit:portfolio", portfolio);
      scheduleFreshPortfolioEvidence(portfolio, { scopeId });
      return {
        ok: true,
        authorizationReady: true,
        portfolio,
        status: longbridge.status(),
      };
    } catch (error) {
      markCurrentPortfolioStale(`长桥已授权，但持仓同步失败：${safeError(error)}`);
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
    try {
      if (!longbridge.connected) {
        throw new Error("长桥尚未连接；请先点击“连接长桥”完成只读授权。");
      }
      const scopeId = currentPortfolioLedgerScopeId();
      portfolio = await portfolioService.refresh();
      safeSend("cockpit:portfolio", portfolio);
      scheduleFreshPortfolioEvidence(portfolio, { scopeId });
      return { ok: true, portfolio };
    } catch (error) {
      markCurrentPortfolioStale(`长桥同步失败：${safeError(error)}`);
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
    await longbridge.disconnect({ forget: true });
    await secureStore.delete("portfolioSnapshot");
    await rotatePortfolioLedgerScope();
    portfolio = null;
    safeSend("cockpit:portfolio", null);
    return { ok: true };
  });

  ipcMain.handle("agent:run", async (event, request) => {
    assertTrustedSender(event);
    const scope = validateAnalysisScope(request?.scope);
    const reviewCycleId = scope === "review"
      ? String(request?.reviewCycleId ?? request?.cycleId ?? "").trim().slice(0, 200)
      : "";
    const reviewPhase = ["blind", "outcome", "retrospective"].includes(request?.reviewPhase)
      ? request.reviewPhase
      : "blind";
    if (scope !== "review" && !portfolio) {
      throw new Error("请先连接长桥并至少同步一次真实持仓。");
    }
    const requestStartedAt = Date.now();
    const operationId = validateOperationId(request?.operationId) ?? randomUUID();
    const threadId = validateThreadId(request?.threadId ?? codexAnalysis.status().threadId);
    if (activeAgentOperations.has(operationId)) throw new Error("该 Agent 请求已在运行。");
    if (activeAgentByThread.has(threadId)) throw new Error("当前对话已有一轮分析正在运行；可切换到其他对话并行分析。");
    const symbol = ["portfolio", "review"].includes(scope)
      ? null
      : normalizeAnalysisSymbol(request?.symbol);
    const targetLabel = scope === "portfolio"
      ? "全部持仓"
      : scope === "review"
        ? reviewCycleId
          ? reviewPhase === "blind"
            ? "周期盲态复盘"
            : reviewPhase === "retrospective" ? "订单优先事后复盘" : "周期结果复盘"
          : "交易复盘"
        : symbol;
    const riskBudgetPercent = clamp(Number(request?.riskBudgetPercent ?? 0.8), 0.05, 5);
    const defaultTask = scope === "review"
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
      let analysisPortfolio = portfolio ? withPortfolioFreshness(portfolio) : null;
      if (scope !== "review" && !analysisPortfolio.freshness.freshForSizing) {
        portfolio = analysisPortfolio;
        safeSend("cockpit:portfolio", portfolio);
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
          const scopeId = currentPortfolioLedgerScopeId();
          const refreshPromise = portfolioService.refresh()
            .then((nextPortfolio) => {
              portfolio = nextPortfolio;
              safeSend("cockpit:portfolio", portfolio);
              scheduleFreshPortfolioEvidence(portfolio, { scopeId });
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
            portfolio = analysisPortfolio;
            safeSend("cockpit:portfolio", portfolio);
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
            portfolio = analysisPortfolio;
            safeSend("cockpit:portfolio", portfolio);
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
          portfolio = analysisPortfolio;
          safeSend("cockpit:portfolio", portfolio);
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
          });
        } else {
          const reviewWorkspace = await reviewStore.snapshot();
          const reviewCaseIds = selectReviewCaseIds(reviewWorkspace, {
            caseId: request?.reviewCaseId ?? request?.caseId,
            caseIds: request?.reviewCaseIds ?? request?.caseIds,
            fiscalQuarter: request?.fiscalQuarter,
          });
          localRun = buildReviewAnalysisRun({
            workspace: reviewWorkspace,
            archive: reviewArchive,
            caseIds: reviewCaseIds,
            runId: randomUUID(),
            task,
            portfolio: analysisPortfolio,
          });
        }
      } else {
        localRun = await buildAnalysisEvidence({
          portfolio: analysisPortfolio,
          scope,
          symbol,
          task,
          riskBudgetPercent,
          loadCandles: (value) => portfolioService.candles(value, 1000, {
            signal: controller.signal,
          }),
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
      safeSend("cockpit:agent-stream", {
        kind: "evidence_ready",
        threadId,
        operationId,
        message: `只读证据已就绪 · ${evidenceMs}ms；Codex 正在组织结论`,
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
      const run = {
        ...applyCodexWorkspaceAnalysis(localRun, modelAnalysis),
        operationId,
      };
      run.performance = {
        portfolioRefreshMs,
        evidenceMs,
        codexFirstActivityMs: modelAnalysis.firstActivityMs,
        codexMs: Date.now() - codexStartedAt,
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
              tradePricePathSummary: summarizeTradePricePath(
                run?.analysisContext?.deterministicOutcomeMetrics,
              ),
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
        error: safeError(error),
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
    const scope = validateAnalysisScope(run?.context?.scope);
    if (scope === "review") {
      throw new Error("复盘结论属于研究记录，不保存为当前交易计划。");
    }
    if (!run?.id || !run?.plan || (scope !== "portfolio" && !run?.context?.symbol)) {
      throw new Error("计划数据无效。");
    }
    if (!portfolio
      || run.context.snapshotAt !== portfolio.syncedAt
      || run.context.valuationSchemaVersion !== portfolio.valuationSchemaVersion) {
      throw new Error("计划对应的持仓快照已失效，请重新运行 Agent。");
    }
    if (!portfolioFreshness(portfolio).freshForSizing) {
      throw new Error("持仓快照已超过 2 分钟或来自缓存；请先同步长桥再保存计划。");
    }
    if (scope === "position" && !portfolio.positions.some((item) => item.symbol === run.context.symbol)) {
      throw new Error("计划标的不在当前真实持仓中。");
    }
    const plans = (await secureStore.get("watchPlans")) ?? [];
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
    await secureStore.set("watchPlans", plans.slice(0, 100));
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
    const saved = await secureStore.get("tradingViewLastUrl");
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

async function buildReviewSnapshot(intakeOptions = {}) {
  const [workspace, cycleWorkspace, broker, intake, portfolioSnapshots] = await Promise.all([
    reviewStore.snapshot(),
    reviewCycleStore.snapshot(),
    tradeHistoryService.cached(),
    tradeHistoryService.intake(intakeOptions),
    portfolioSnapshotLedgerStatus(),
  ]);
  const brokerMatches = Object.fromEntries(workspace.cases.map((reviewCase) => {
    const confirmed = reviewCase.brokerLinks?.confirmedAt != null
      || reviewCase.origin === "longbridge_records";
    const linkedExecutionIds = new Set(reviewCase.brokerLinks?.executionIds ?? []);
    const linkedOrderIds = new Set(reviewCase.brokerLinks?.orderIds ?? []);
    const executions = confirmed
      ? broker.executions.filter((item) => linkedExecutionIds.has(item.tradeId))
      : matchExecutionsToEvent(broker, {
        symbol: reviewCase.symbol,
        eventAt: reviewCase.eventAt,
      });
    const matchedOrderIds = new Set(executions.map((item) => item.orderId).filter(Boolean));
    const orders = (confirmed
      ? broker.orders.filter((item) => linkedOrderIds.has(item.orderId)
        || matchedOrderIds.has(item.orderId))
      : [
        ...matchOrdersToEvent(broker, {
          symbol: reviewCase.symbol,
          eventAt: reviewCase.eventAt,
        }),
        ...broker.orders.filter((item) => matchedOrderIds.has(item.orderId)),
      ]).filter((item, index, rows) => rows.findIndex(
      (candidate) => candidate.orderId === item.orderId,
    ) === index);
    return [reviewCase.id, {
      orders,
      executions,
      recordIds: [
        ...orders.map((item) => item.orderId),
        ...executions.map((item) => item.tradeId),
      ],
      confirmed,
    }];
  }));
  const ruleMetrics = Object.fromEntries(workspace.rules.map((rule) => [
    rule.id,
    calculateRuleMetrics(workspace, rule.id),
  ]));
  const cycleSnapshotCoverage = await portfolioSnapshotCoverageForCycles(cycleWorkspace.cycles);
  const cycles = cycleWorkspace.cycles.map((cycle) => {
    const orderIds = new Set(cycle?.brokerLinks?.orderIds ?? []);
    const executionIds = new Set(cycle?.brokerLinks?.executionIds ?? []);
    const rawOrders = broker.orders.filter((item) => orderIds.has(item.orderId));
    const rawExecutions = broker.executions.filter((item) => executionIds.has(item.tradeId));
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
  const validationCandidates = buildValidationCandidateIndex({
    tests: learningWorkspace.tests,
    cycles,
  });
  return {
    ...learningWorkspace,
    cycles,
    validationCandidates,
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
      frozenCount: workspace.cases.filter((item) => item.exAnteVersions?.length).length,
      reviewDueCount: workspace.cases.filter((item) => ["event_occurred", "review_due"].includes(item.status)).length,
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
  if (!item) return;
  const validationPackage = workspace.validationPackages.find((candidate) => (
    String(candidate?.id ?? "") === String(item?.validationPackageId ?? "")
  ));
  const source = validationPackage ?? item;
  if (!source?.sourceReviewCycleId || !source?.sourceRunId) return;
  assertLearningSourceCurrent(source, cycleWorkspace);
}

async function assertReviewObservationCycle({ testId, reviewCycleId } = {}) {
  const requestedCycleId = String(reviewCycleId ?? "").trim();
  if (!requestedCycleId) return null;
  const snapshot = await buildReviewSnapshot();
  const test = snapshot.tests.find((item) => String(item?.id ?? "") === String(testId ?? ""));
  if (!test) return;
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

function brokerLinksFromSelection(selection) {
  return {
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
  const netAssets = Number(value?.account?.netAssets);
  const grossMarketValue = Number(value?.totals?.positionsGrossMarketValueBase);
  return {
    snapshotAt: value.syncedAt ?? null,
    baseCurrency: value?.account?.baseCurrency ?? "USD",
    netAssets: Number.isFinite(netAssets) ? netAssets : null,
    cashRatioPercent: Number.isFinite(Number(value?.totals?.cashRatio))
      ? Number(value.totals.cashRatio)
      : null,
    grossExposurePercent: Number.isFinite(grossMarketValue) && Number.isFinite(netAssets) && netAssets !== 0
      ? (grossMarketValue / netAssets) * 100
      : null,
    top1WeightPercent: Number.isFinite(Number(value?.totals?.top1Weight))
      ? Number(value.totals.top1Weight)
      : null,
    positions: (Array.isArray(value.positions) ? value.positions : []).slice(0, 500).map((item) => ({
      symbol: item.symbol ?? null,
      quantity: Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : null,
      weightPercent: Number.isFinite(Number(item.weight)) ? Number(item.weight) : null,
      marketValue: Number.isFinite(Number(item.marketValueBase)) ? Number(item.marketValueBase) : null,
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

async function migrateEncryptedStoreKey({ source, target, key }) {
  const [legacyValue, currentValue] = await Promise.all([
    source.get(key),
    target.get(key),
  ]);
  if (legacyValue == null) return { migrated: false, conflict: false };
  if (currentValue == null) {
    await target.set(key, legacyValue);
    await source.delete(key);
    return { migrated: true, conflict: false };
  }
  if (JSON.stringify(currentValue) === JSON.stringify(legacyValue)) {
    await source.delete(key);
    return { migrated: false, conflict: false, duplicateRemoved: true };
  }
  // Never merge two append-only/enriched values implicitly. The dedicated
  // ledger remains authoritative and the legacy value is preserved for
  // recovery instead of being overwritten or deleted.
  return { migrated: false, conflict: true };
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

async function rotatePortfolioLedgerScope() {
  const scopeId = createPortfolioLedgerScopeId();
  await secureStore.set(PORTFOLIO_LEDGER_SCOPE_STORE_KEY, scopeId);
  portfolioLedgerScopeId = scopeId;
  return scopeId;
}

function scheduleFreshPortfolioEvidence(value, {
  scopeId = currentPortfolioLedgerScopeId(),
} = {}) {
  if (!value || value.holdingsStatus !== "live" || value?.freshness?.state === "cached") return;
  const symbols = [
    "QQQ.US",
    ...(Array.isArray(value.positions) ? value.positions : [])
      .filter((item) => item?.instrumentType !== "option")
      .map((item) => item?.symbol),
  ];
  void portfolioService.prewarmCandles(symbols).catch(() => {});
  void captureAutomaticPortfolioSnapshots(value, { scopeId }).catch((error) => sendStatus({
    state: "snapshot_degraded",
    message: "组合快照未写入，但不影响当前持仓显示",
    detail: safeError(error),
  }));
}

async function ensureAutomaticPortfolioSnapshots() {
  if (portfolioSnapshotSweep || !longbridge?.connected || !isUsEodCaptureWindow(new Date())) return;
  portfolioSnapshotSweep = (async () => {
    const scopeId = currentPortfolioLedgerScopeId();
    const tradingDate = localDateInTimezone(new Date(), PORTFOLIO_LEDGER_TIMEZONE);
    try {
      const existingEod = await portfolioSnapshotStore.listSnapshots({
        scopeId,
        kinds: "eod",
        fromTradingDate: tradingDate,
        toTradingDate: tradingDate,
        limit: 12_000,
      });
      const confirmed = existingEod.find(isCurrentRegularCloseSnapshot);
      // The versioned regular-close revaluation is first-write-wins for its
      // trading date. Legacy EOD observations remain immutable history but do
      // not block the current valuation method.
      if (confirmed) {
        recordPortfolioSnapshotCaptureSuccess(confirmed);
        return;
      }
      const fresh = await portfolioService.refresh();
      portfolio = fresh;
      safeSend("cockpit:portfolio", fresh);
      scheduleFreshPortfolioEvidence(fresh, { scopeId });
    } catch (error) {
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

function captureAutomaticPortfolioSnapshots(value, options = {}) {
  const queued = portfolioSnapshotCaptureQueue.then(
    () => captureAutomaticPortfolioSnapshotsNow(value, options),
    () => captureAutomaticPortfolioSnapshotsNow(value, options),
  );
  const operation = queued.catch((error) => {
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
} = {}) {
  const capturedAt = new Date(value.syncedAt);
  if (!Number.isFinite(capturedAt.getTime())) return [];
  const tasks = [];
  const eodResults = [];
  if (isUsEodCaptureWindow(capturedAt)) {
    const tradingDate = localDateInTimezone(capturedAt, PORTFOLIO_LEDGER_TIMEZONE);
    const snapshotsForDate = await portfolioSnapshotStore.listSnapshots({
      scopeId,
      fromTradingDate: tradingDate,
      toTradingDate: tradingDate,
      order: "asc",
      limit: 12_000,
    });
    const confirmedEod = snapshotsForDate.find(isCurrentRegularCloseSnapshot) ?? null;
    const hasScheduledFallback = snapshotsForDate.some(
      (item) => item.idempotencyKey === `scheduled-close:${scopeId}:${tradingDate}`,
    );
    // Do not even re-verify the closing bar after today's versioned regular-
    // close revaluation exists. Legacy EOD entries do not satisfy this check.
    // Other refresh paths may still append a distinct post-trade observation.
    if (confirmedEod) {
      recordPortfolioSnapshotCaptureSuccess(confirmedEod);
    } else {
      recordPortfolioSnapshotCaptureAttempt(capturedAt, tradingDate);
      const verified = await verifyUsEodObservation(value, capturedAt, tradingDate);
      if (verified) {
        const closeValue = regularClosePortfolioObservation(value, tradingDate);
        if (closeValue) {
          try {
            const result = await appendPortfolioSnapshot(closeValue, {
              kind: "eod",
              idempotencyKey: `eod-regular-close-v2:${scopeId}:${tradingDate}`,
              note: "每日唯一常规收盘重估（v2）：证券按 16:00 ET 常规时段最后成交 mark 重估；盘后报价不覆盖本条。持仓数量和现金来自收盘后抓取，未核对盘后成交与现金流，因此是 partial 观察，不能作为确定性收益端点。",
            }, { scopeId });
            recordPortfolioSnapshotCaptureSuccess(result.snapshot);
            eodResults.push({ status: "fulfilled", value: result });
          } catch (error) {
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
        }, { scopeId }));
        recordPortfolioSnapshotCaptureRetry({ attemptedAt: capturedAt, tradingDate });
      } else {
        recordPortfolioSnapshotCaptureRetry({ attemptedAt: capturedAt, tradingDate });
      }
    }
  }
  const archive = await tradeHistoryService?.cached?.().catch(() => null);
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
    }, { scopeId }));
  }
  return [...eodResults, ...await Promise.allSettled(tasks)];
}

function recordPortfolioSnapshotCaptureAttempt(attemptedAt, tradingDate) {
  const value = attemptedAt instanceof Date ? attemptedAt : new Date(attemptedAt);
  portfolioSnapshotCaptureRuntime = {
    ...portfolioSnapshotCaptureRuntime,
    lastAttemptAt: Number.isFinite(value.getTime()) ? value.toISOString() : new Date().toISOString(),
    lastAttemptTradingDate: tradingDate,
    lastError: null,
    outcome: "retrying",
  };
}

function recordPortfolioSnapshotCaptureRetry({ attemptedAt, tradingDate, error = null }) {
  recordPortfolioSnapshotCaptureAttempt(attemptedAt, tradingDate);
  portfolioSnapshotCaptureRuntime = {
    ...portfolioSnapshotCaptureRuntime,
    lastError: error ? safeError(error) : null,
    outcome: "retrying",
  };
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
async function capturePostTradeAfterHistorySync(archive) {
  if (!longbridge?.connected) return null;
  const scopeId = currentPortfolioLedgerScopeId();
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
  const coveredSources = new Set(existing.map((item) => item?.provenance?.sourceSnapshotId).filter(Boolean));
  if (recentExecutions.every((item) => coveredSources.has(`execution:${item.tradeId}`))) return null;
  const fresh = await portfolioService.refresh();
  portfolio = fresh;
  safeSend("cockpit:portfolio", fresh);
  const symbols = [
    "QQQ.US",
    ...(Array.isArray(fresh.positions) ? fresh.positions : [])
      .filter((item) => item?.instrumentType !== "option")
      .map((item) => item?.symbol),
  ];
  void portfolioService.prewarmCandles(symbols).catch(() => {});
  await captureAutomaticPortfolioSnapshots(fresh, { scopeId });
  return fresh;
}

async function verifyUsEodObservation(value, capturedAt, tradingDate) {
  const regularQuoteAt = Date.parse(String(value?.regularQuoteAsOf ?? ""));
  const regularQuoteLatestAt = Date.parse(String(value?.regularQuoteLatestAsOf ?? ""));
  const positions = Array.isArray(value?.positions) ? value.positions : [];
  const allRegularMarksCurrent = positions.every((item) => (
    finiteOrNull(item?.regularLastPrice) != null
    && finiteOrNull(item?.regularMarketValueBase) != null
    && finiteOrNull(item?.regularGrossMarketValueBase) != null
    && Number.isFinite(Date.parse(String(item?.regularQuoteTimestamp ?? "")))
    && localDateInTimezone(new Date(item.regularQuoteTimestamp), PORTFOLIO_LEDGER_TIMEZONE) === tradingDate
  ));
  if (!Number.isFinite(regularQuoteAt)
    || !Number.isFinite(regularQuoteLatestAt)
    || !allRegularMarksCurrent
    || localDateInTimezone(new Date(regularQuoteAt), PORTFOLIO_LEDGER_TIMEZONE) !== tradingDate
    || localDateInTimezone(new Date(regularQuoteLatestAt), PORTFOLIO_LEDGER_TIMEZONE) !== tradingDate) {
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
      quoteAsOf: value.regularQuoteAsOf,
      quoteLatestAsOf: value.regularQuoteLatestAsOf,
      totalAssetsBasis: "capture_cash_plus_regular_close_positions",
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
} = {}) {
  return portfolioSnapshotStore.appendSnapshot(portfolioSnapshotLedgerInput(value, {
    kind,
    idempotencyKey,
    note,
    sourceSnapshotId,
    scopeId,
  }));
}

function portfolioSnapshotLedgerInput(value, {
  kind,
  idempotencyKey,
  note,
  sourceSnapshotId,
  scopeId,
}) {
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
      code: "regular_close_cash_and_inventory_not_reconciled",
      message: "持仓按常规时段收盘价估值，但现金与数量来自收盘后抓取；未核对盘后成交、费用及现金流。",
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
      scopeId,
      broker: "Longbridge",
      accounts: [{
        accountRef: PORTFOLIO_LEDGER_ACCOUNT_REF,
        accountType: "aggregate_read_only",
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
      accountRef: PORTFOLIO_LEDGER_ACCOUNT_REF,
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
  const parts = zonedDateTimeParts(value, PORTFOLIO_LEDGER_TIMEZONE);
  if (!parts || parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  return parts.hour * 60 + parts.minute >= 16 * 60 + 10;
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
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function hydrateCyclePortfolioSnapshots(cycle) {
  if (!cycle?.startAt || !cycle?.endAt || !portfolioSnapshotStore) return cycle;
  const scopeId = currentPortfolioLedgerScopeId();
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
    return {
      ...cycle,
      startingPortfolio: selectedStarting,
      endingPortfolio: ledgerSnapshotForReview(closing),
      portfolioSnapshotCoverage: {
        source: "本机加密追加式组合快照账本",
        accountScopeVerified: false,
        snapshotCountWithinCycle: period.coverage?.snapshotCount ?? 0,
        openingSnapshotAt: opening?.capturedAt ?? null,
        endingSnapshotAt: closing?.capturedAt ?? null,
        openingDistanceMs: opening ? Math.max(0, startMs - Date.parse(opening.capturedAt)) : null,
        endingDistanceMs: closing ? Math.max(0, endMs - Date.parse(closing.capturedAt)) : null,
        canCompareNetAssetEndpoints,
        canCalculatePeriodReturn: false,
        warnings: [...new Set([...warnings, "broker_account_subject_unavailable_local_scope_only"])],
      },
    };
  } catch (error) {
    return {
      ...cycle,
      portfolioSnapshotCoverage: {
        source: "本机加密追加式组合快照账本",
        accountScopeVerified: false,
        snapshotCountWithinCycle: 0,
        openingSnapshotAt: null,
        endingSnapshotAt: null,
        canCalculatePeriodReturn: false,
        warnings: [
          "broker_account_subject_unavailable_local_scope_only",
          `snapshot_ledger_unavailable:${safeError(error)}`,
        ],
      },
    };
  }
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
  const totalAssets = finiteOrNull(snapshot?.summary?.totalAssets);
  const grossExposure = finiteOrNull(snapshot?.summary?.grossExposure);
  const cash = finiteOrNull(snapshot?.summary?.cash);
  const holdings = Array.isArray(snapshot?.holdings) ? snapshot.holdings : [];
  return {
    snapshotAt: snapshot.capturedAt,
    snapshotId: snapshot.snapshotId,
    kind: snapshot.kind,
    baseCurrency: snapshot?.summary?.reportingCurrency ?? "USD",
    netAssets: totalAssets,
    cashRatioPercent: totalAssets && cash != null ? (cash / totalAssets) * 100 : null,
    grossExposurePercent: totalAssets && grossExposure != null ? (grossExposure / totalAssets) * 100 : null,
    top1WeightPercent: holdings.length
      ? Math.max(...holdings.map((item) => Math.abs(Number(item?.weight) || 0))) * 100
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
    provenance: {
      source: "本机加密组合快照账本",
      accountScopeVerified: false,
      accountScopeLimitation: "券商未返回可验证账户主体；本地匿名作用域仅在显式清除长桥授权时轮换。",
      recordedAt: snapshot.recordedAt,
      integrityStatus: snapshot.integrity?.entryHash ? "verified_on_read" : "unavailable",
    },
  };
}

async function portfolioSnapshotLedgerStatus() {
  if (!portfolioSnapshotStore) {
    return {
      status: "unavailable",
      snapshotCount: 0,
      latest: null,
      capturePolicy: PORTFOLIO_SNAPSHOT_CAPTURE_POLICY,
      captureRuntime: currentPortfolioSnapshotCaptureRuntime([]),
      accountScopeVerified: false,
      warnings: ["broker_account_subject_unavailable_local_scope_only", "snapshot_store_not_ready"],
    };
  }
  try {
    const scopeId = currentPortfolioLedgerScopeId();
    const [integrity, scopedSnapshots] = await Promise.all([
      portfolioSnapshotStore.verifyIntegrity(),
      portfolioSnapshotStore.listSnapshots({ scopeId, order: "asc", limit: 12_000 }),
    ]);
    const latest = scopedSnapshots.at(-1) ?? null;
    const captureRuntime = currentPortfolioSnapshotCaptureRuntime(scopedSnapshots);
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
      accountScopeVerified: false,
      warnings: [
        "broker_account_subject_unavailable_local_scope_only",
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
      accountScopeVerified: false,
      warnings: [
        "broker_account_subject_unavailable_local_scope_only",
        `snapshot_ledger_unavailable:${safeError(error)}`,
      ],
    };
  }
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
  try {
    const scopeId = currentPortfolioLedgerScopeId();
    const snapshots = await portfolioSnapshotStore.listSnapshots({
      scopeId,
      order: "asc",
      limit: 12_000,
    });
    return Object.fromEntries(values.map((cycle) => {
      const startMs = Date.parse(String(cycle?.startAt ?? ""));
      const endMs = Date.parse(String(cycle?.endAt ?? ""));
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        return [cycle.id, {
          status: "unavailable",
          accountScopeVerified: false,
          snapshotCountWithinCycle: 0,
          canCalculatePeriodReturn: false,
          warnings: ["broker_account_subject_unavailable_local_scope_only", "cycle_boundary_missing"],
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
        "broker_account_subject_unavailable_local_scope_only",
        ...(!opening ? [openingCandidate ? "opening_snapshot_too_far_from_cycle" : "opening_baseline_missing"] : []),
        ...(!closing ? [closingCandidate ? "ending_snapshot_too_far_from_cycle" : "period_end_snapshot_missing"] : []),
        ...(within.length ? [] : ["period_has_no_snapshot"]),
        ...(opening && opening.dataQuality?.status !== "complete" ? ["opening_snapshot_quality_incomplete"] : []),
        ...(closing && closing.dataQuality?.status !== "complete" ? ["ending_snapshot_quality_incomplete"] : []),
      ];
      return [cycle.id, {
        status: complete ? "complete" : snapshots.length ? "partial" : "unavailable",
        source: "本机加密追加式组合快照账本",
        accountScopeVerified: false,
        snapshotCountWithinCycle: within.length,
        openingSnapshotAt: opening?.capturedAt ?? null,
        endingSnapshotAt: closing?.capturedAt ?? null,
        canCompareNetAssetEndpoints: complete,
        canCalculatePeriodReturn: false,
        ...(complete ? { warnings: [...warnings, "external_cash_flows_and_fees_not_reconciled"] } : { warnings }),
      }];
    }));
  } catch (error) {
    return Object.fromEntries(values.map((cycle) => [cycle.id, {
      status: "unavailable",
      accountScopeVerified: false,
      snapshotCountWithinCycle: 0,
      canCompareNetAssetEndpoints: false,
      canCalculatePeriodReturn: false,
      warnings: [
        "broker_account_subject_unavailable_local_scope_only",
        `snapshot_ledger_unavailable:${safeError(error)}`,
      ],
    }]));
  }
}

async function buildCyclePointInTimeTechnical({ cycle, archive, phase, signal }) {
  const sealed = Array.isArray(cycle?.exAnteVersions) ? cycle.exAnteVersions.at(-1) : null;
  const timelineNodes = phase === "blind" && Array.isArray(cycle?.decisionTimeline)
    ? cycle.decisionTimeline
      .map((node, index) => ({
        nodeId: String(node?.nodeId ?? `timeline-node-${index + 1}`),
        timelineIndex: Number.isFinite(Number(node?.timelineIndex)) ? Number(node.timelineIndex) : index,
        knowledgeCutoffAt: node?.knowledgeCutoffAt,
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
  const validCutoffs = cutoffs.filter((item) => Number.isFinite(Date.parse(String(item.knowledgeCutoffAt ?? ""))));
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
  const linkedOrderIds = new Set(cycle?.brokerLinks?.orderIds ?? []);
  const linkedExecutionIds = new Set(cycle?.brokerLinks?.executionIds ?? []);
  const timelineRecordIds = new Set(
    (Array.isArray(cycle?.decisionTimeline) ? cycle.decisionTimeline : [])
      .flatMap((node) => node?.brokerFactsIntroduced?.recordIds ?? []),
  );
  const activitySymbols = [
    ...(archive?.orders ?? []).filter((item) => (
      linkedOrderIds.has(item.orderId) || timelineRecordIds.has(`order:${item.orderId}`)
    )).map((item) => item.symbol),
    ...(archive?.executions ?? []).filter((item) => (
      linkedExecutionIds.has(item.tradeId) || timelineRecordIds.has(`execution:${item.tradeId}`)
    )).map((item) => item.symbol),
  ];
  const cycleSymbols = [
    ...(Array.isArray(cycle?.symbols) ? cycle.symbols : []),
    ...activitySymbols,
  ].map((item) => String(item ?? "").trim().toUpperCase()).filter(Boolean);
  const inferredBenchmark = cycleSymbols.some((symbol) => symbol.endsWith(".US")) ? "QQQ.US" : null;
  const allSymbols = [...new Set([
    ...cycleSymbols,
    cycle?.benchmark,
    inferredBenchmark,
  ].map((item) => String(item ?? "").trim().toUpperCase()).filter(Boolean))];
  const requestedSymbols = allSymbols.slice(0, 8);
  const omittedSymbols = allSymbols.slice(8);
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
        asOf: new Date(Date.parse(node.knowledgeCutoffAt)).toISOString(),
        status: "unavailable",
        cutoffPolicy: "该节点仅接受交易日早于其 knowledgeCutoffAt 的长桥前复权日线。",
        warnings: ["cycle_symbols_missing"],
        snapshots: [],
      })),
    };
  }
  const technicalController = new AbortController();
  const abortTechnical = () => technicalController.abort(signal?.reason);
  if (signal?.aborted) abortTechnical();
  else signal?.addEventListener?.("abort", abortTechnical, { once: true });
  // Fetch each symbol exactly once. Every decision node is then calculated
  // from its own strictly filtered prefix of the same immutable daily series.
  const work = Promise.allSettled(requestedSymbols.map(async (symbol) => ({
    symbol,
    candleResult: await portfolioService.candlesWithCoverage(symbol, 600, {
      signal: technicalController.signal,
      preferPersistent: true,
    }),
  })));
  let outcome;
  try {
    outcome = await Promise.race([
      work.then((results) => ({ results, timedOut: false })),
      abortableDelay(2_500, signal).then(() => ({ results: [], timedOut: true })),
    ]);
  } finally {
    signal?.removeEventListener?.("abort", abortTechnical);
  }
  if (outcome.timedOut) {
    technicalController.abort(new Error("历史技术快照预取超时。"));
    return {
      status: "timed_out",
      asOf: new Date(cutoffMs).toISOString(),
      cutoffPolicy: "为避免拖慢 Agent，历史技术快照预取超过 2.5 秒后降级；不会读取截止日及之后的 K 线。",
      requestedSymbols,
      omittedSymbols,
      warnings: ["historical_candles_timeout"],
      snapshots: [],
      nodes: validCutoffs.map((node) => ({
        ...node,
        asOf: new Date(Date.parse(node.knowledgeCutoffAt)).toISOString(),
        status: "timed_out",
        cutoffPolicy: "历史日线预取超时；该节点未获得技术快照。",
        warnings: ["historical_candles_timeout"],
        snapshots: [],
      })),
    };
  }
  const barsBySymbol = new Map();
  const candleCoverageBySymbol = new Map();
  const warnings = [];
  outcome.results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      const candleResult = result.value.candleResult;
      barsBySymbol.set(result.value.symbol, candleResult.candles);
      candleCoverageBySymbol.set(result.value.symbol, candleResult.coverage ?? null);
      if (candleResult.coverage?.partial === true
        || candleResult.coverage?.source === "persistent_fallback") {
        warnings.push(`${result.value.symbol}: cached_or_partial_market_history`);
      }
    } else warnings.push(`${requestedSymbols[index]}: ${safeError(result.reason)}`);
  });
  const nodes = validCutoffs.map((node) => {
    const nodeWarnings = [];
    const nodeSnapshots = [];
    for (const symbol of requestedSymbols) {
      const bars = barsBySymbol.get(symbol);
      if (!bars) {
        nodeWarnings.push(`${symbol}: historical_candles_unavailable`);
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
      asOf: new Date(Date.parse(node.knowledgeCutoffAt)).toISOString(),
      status: nodeSnapshots.length === requestedSymbols.length
        ? "complete"
        : nodeSnapshots.length ? "partial" : "unavailable",
      cutoffPolicy: "严格仅使用交易日早于该节点 knowledgeCutoffAt 的长桥前复权、常规交易时段日线；截止当日整根 K 线保守排除。EMA/Fib 是可选证据。",
      warnings: nodeWarnings,
      snapshots: nodeSnapshots,
    };
  }).sort((left, right) => left.timelineIndex - right.timelineIndex);
  const snapshots = nodes.at(-1)?.snapshots ?? [];
  return {
    status: snapshots.length === requestedSymbols.length ? "complete" : snapshots.length ? "partial" : "unavailable",
    asOf: new Date(cutoffMs).toISOString(),
    cutoffPolicy: phase === "blind"
      ? "每个决策节点严格仅使用早于其 knowledgeCutoffAt 的长桥前复权日线；同一标的日线只抓取一次，再分别截断计算。EMA/Fib 是可选证据。"
      : "严格仅使用交易日早于阶段截止日期的长桥前复权、常规交易时段日线；截止当日整根 K 线保守排除。EMA/Fib 是可选证据，不是强制结论。",
    requestedSymbols,
    omittedSymbols,
    marketHistoryCoverage: requestedSymbols.map((symbol) => ({
      symbol,
      ...(candleCoverageBySymbol.get(symbol) ?? { source: "unavailable", coverageStatus: "unavailable" }),
    })),
    warnings,
    snapshots,
    nodes,
  };
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
  if (!isTradingViewUrl(url)) return;
  pendingTvUrl = url;
  if (tvUrlSaveTimer) clearTimeout(tvUrlSaveTimer);
  tvUrlSaveTimer = setTimeout(() => {
    const value = pendingTvUrl;
    pendingTvUrl = null;
    tvUrlSaveTimer = null;
    if (value) {
      secureStore.set("tradingViewLastUrl", value).catch((error) => {
        sendTvState({ state: "degraded", message: `无法保存 TradingView 页面状态：${safeError(error)}` });
      });
    }
  }, 350);
}

function sendStatus(payload) {
  safeSend("cockpit:status", payload);
}

function sendTvState(payload) {
  safeSend("cockpit:tv-state", payload);
}

function safeSend(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return false;
  mainWindow.webContents.send(channel, payload);
  return true;
}

function assertTrustedSender(event) {
  if (isTrustedSender(event)) return;
  throw new Error("Rejected IPC from an untrusted renderer.");
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

export function preferredLongbridgeEndpoint() {
  return "https://mcp.longbridge.com/v2";
}

function validateAnalysisScope(value) {
  const scope = String(value ?? "position").trim().toLowerCase();
  if (!["position", "candidate", "portfolio", "review"].includes(scope)) {
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
  const legacy = normalizeAgentResult(await secureStore.get(LAST_AGENT_RESULT_KEY));
  if (!legacy) return;
  await agentResults.save(legacy);
  await secureStore.delete(LAST_AGENT_RESULT_KEY);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function safeError(error) {
  return error instanceof Error ? error.message : "未知错误";
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
