import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
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
import {
  PortfolioService,
  PORTFOLIO_SNAPSHOT_SCHEMA_VERSION,
} from "./src/data/portfolio-service.mjs";
import { AgentResultStore, normalizeAgentResult } from "./src/data/agent-result-store.mjs";
import { buildAnalysisEvidence } from "./src/engine/agent.mjs";
import {
  applyCodexWorkspaceAnalysis,
  CodexWorkspaceService,
  resolveCodexExecutable,
} from "./src/engine/codex-workspace.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererPath = path.join(__dirname, "renderer", "index.html");
const DEFAULT_TV_URL = "https://www.tradingview.com/chart/";

let mainWindow;
let tvView;
let tvSession;
let secureStore;
let longbridge;
let portfolioService;
let portfolio;
let codexAnalysis;
let agentResults;
const activeAgentOperations = new Map();
const activeAgentByThread = new Map();
let lastTvBounds = { x: 292, y: 86, width: 820, height: 780 };
let tvMainLoadFailed = false;
let pendingTvUrl = null;
let tvUrlSaveTimer = null;
const hardenedSessions = new WeakSet();
const tvPopups = new Set();
const PORTFOLIO_MAX_AGE_MS = 2 * 60 * 1000;
const AGENT_PORTFOLIO_REFRESH_WAIT_MS = 1_500;
const LAST_AGENT_RESULT_KEY = "lastAgentResult";

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  secureStore = new EncryptedStore({
    directory: app.getPath("userData"),
    safeStorage,
  });
  agentResults = new AgentResultStore({ store: secureStore });
  longbridge = new LongbridgeClient({
    endpoint: preferredLongbridgeEndpoint(),
    store: secureStore,
    openExternal: (url) => shell.openExternal(url),
    onStatus: sendStatus,
    clientVersion: app.getVersion(),
  });
  const savedPortfolio = await secureStore.get("portfolioSnapshot");
  portfolio = savedPortfolio?.endpoint === longbridge.endpoint
    && savedPortfolio?.valuationSchemaVersion === PORTFOLIO_SNAPSHOT_SCHEMA_VERSION
    ? { ...savedPortfolio, status: "cached" }
    : null;
  portfolioService = new PortfolioService({
    longbridge,
    store: secureStore,
    onStatus: sendStatus,
  });
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
      portfolio = await portfolioService.refresh();
      safeSend("cockpit:portfolio", portfolio);
    } catch (error) {
      sendStatus(longbridgeFailureStatus(error, "恢复长桥连接失败"));
    }
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", async () => {
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
      portfolio: portfolio ? { ...portfolio, status: "cached" } : null,
      longbridge: {
        ...longbridge.status(),
        hasSavedAuthorization: await longbridge.hasSavedAuthorization(),
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

  ipcMain.handle("longbridge:connect", async (event) => {
    assertTrustedSender(event);
    try {
      await longbridge.connect({ interactive: true });
      portfolio = await portfolioService.refresh();
      safeSend("cockpit:portfolio", portfolio);
      return { ok: true, portfolio, status: longbridge.status() };
    } catch (error) {
      sendStatus(longbridgeFailureStatus(error, "长桥连接失败"));
      return { ok: false, error: safeError(error) };
    }
  });

  ipcMain.handle("longbridge:refresh", async (event) => {
    assertTrustedSender(event);
    try {
      if (!longbridge.connected) {
        throw new Error("长桥尚未连接；请先点击“连接长桥”完成只读授权。");
      }
      portfolio = await portfolioService.refresh();
      safeSend("cockpit:portfolio", portfolio);
      return { ok: true, portfolio };
    } catch (error) {
      sendStatus(longbridgeFailureStatus(error, "长桥同步失败"));
      return { ok: false, error: safeError(error) };
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
    portfolio = null;
    safeSend("cockpit:portfolio", null);
    return { ok: true };
  });

  ipcMain.handle("agent:run", async (event, request) => {
    assertTrustedSender(event);
    if (!portfolio) throw new Error("请先连接长桥并至少同步一次真实持仓。");
    const requestStartedAt = Date.now();
    const operationId = validateOperationId(request?.operationId) ?? randomUUID();
    const threadId = validateThreadId(request?.threadId ?? codexAnalysis.status().threadId);
    if (activeAgentOperations.has(operationId)) throw new Error("该 Agent 请求已在运行。");
    if (activeAgentByThread.has(threadId)) throw new Error("当前对话已有一轮分析正在运行；可切换到其他对话并行分析。");
    const scope = validateAnalysisScope(request?.scope);
    const symbol = scope === "portfolio" ? null : normalizeAnalysisSymbol(request?.symbol);
    const targetLabel = scope === "portfolio" ? "全部持仓" : symbol;
    const riskBudgetPercent = clamp(Number(request?.riskBudgetPercent ?? 0.8), 0.05, 5);
    const task = String(request?.task ?? "分析当前持仓").slice(0, 4_000);
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
      if (!isFreshIsoTime(portfolio.syncedAt, PORTFOLIO_MAX_AGE_MS)) {
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
          const refreshStartedAt = Date.now();
          const refreshPromise = portfolioService.refresh()
            .then((nextPortfolio) => {
              portfolio = nextPortfolio;
              safeSend("cockpit:portfolio", portfolio);
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
            sendStatus({
              domain: "agent",
              state: "agent_running",
              active: true,
              threadId,
              operationId,
              message: `长桥刷新失败；沿用现有快照继续分析：${safeError(refreshOutcome.error)}`,
            });
          } else if (refreshOutcome.timedOut) {
            sendStatus({
              domain: "agent",
              state: "agent_running",
              active: true,
              threadId,
              operationId,
              message: "长桥刷新转入后台；Agent 已用现有快照继续，不再等待",
            });
          }
        }
      }
      const analysisPortfolio = portfolio;
      if (controller.signal.aborted) throw new Error("Codex 分析已取消。");
      const evidenceStartedAt = Date.now();
      const localRun = await buildAnalysisEvidence({
        portfolio: analysisPortfolio,
        scope,
        symbol,
        task,
        riskBudgetPercent,
        loadCandles: (value) => portfolioService.candles(value, 260, {
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
    if (!run?.id || !run?.plan || (scope !== "portfolio" && !run?.context?.symbol)) {
      throw new Error("计划数据无效。");
    }
    if (!portfolio
      || run.context.snapshotAt !== portfolio.syncedAt
      || run.context.valuationSchemaVersion !== portfolio.valuationSchemaVersion) {
      throw new Error("计划对应的持仓快照已失效，请重新运行 Agent。");
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
  if (!tvView || !mainWindow || !value) return;
  const content = mainWindow.getContentBounds();
  const x = clamp(Math.round(Number(value.x)), 0, content.width - 200);
  const y = clamp(Math.round(Number(value.y)), 0, content.height - 200);
  const width = clamp(Math.round(Number(value.width)), 200, content.width - x);
  const height = clamp(Math.round(Number(value.height)), 200, content.height - y);
  if (![x, y, width, height].every(Number.isFinite)) return;
  lastTvBounds = { x, y, width, height };
  tvView.setBounds(lastTvBounds);
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

function isFreshIsoTime(value, maxAgeMs) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp <= maxAgeMs;
}

function preferredLongbridgeEndpoint() {
  if (process.env.LONGBRIDGE_MCP_URL) return process.env.LONGBRIDGE_MCP_URL;
  return app.getLocaleCountryCode() === "CN"
    ? "https://mcp.longbridge.cn/v2"
    : "https://mcp.longbridge.com/v2";
}

function validateAnalysisScope(value) {
  const scope = String(value ?? "position").trim().toLowerCase();
  if (!["position", "candidate", "portfolio"].includes(scope)) {
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
  if (classification.kind === "auth") {
    return {
      state: "reauth_required",
      message: "长桥授权已过期，请重新连接",
      detail: safeError(error),
    };
  }
  if (classification.kind === "permission") {
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
