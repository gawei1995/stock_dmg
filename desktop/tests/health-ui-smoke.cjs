// Isolated full renderer only: synthetic health model, temporary profile,
// no broker, Codex, TradingView, or external network requests.
const electron = require("electron");
if (process.type === "renderer") {
  const noop = () => {};
  electron.contextBridge.exposeInMainWorld("cockpit", {
    getInitialState: () => electron.ipcRenderer.invoke("fixture:initial"),
    getAgentCapabilities: () => electron.ipcRenderer.invoke("fixture:capabilities"),
    recheckAgentReadOnlyGuard: () => electron.ipcRenderer.invoke("fixture:guard-recheck"),
    setAgentNetworkPreferences: (request) => electron.ipcRenderer.invoke("fixture:network-save", request),
    agentSessions: { list: async () => ({ sessions: [] }) },
    workspace: { setMode: async () => ({ ok: true }) },
    technicalRadar: { snapshot: async () => ({ radar: {} }) },
    review: { snapshot: async () => ({ cases: [], cycles: [], tests: [], rules: [], reviews: [], portfolioSnapshots: {} }) },
    health: {
      snapshot: () => electron.ipcRenderer.invoke("fixture:health"),
      setOpen: (open) => electron.ipcRenderer.invoke("fixture:health-open", open),
    },
    tv: { setBounds: noop, reload: noop, home: noop, loadSymbol: noop }, openExternal: noop,
    onStatus: noop, onReviewSnapshotUpdated: noop, onAgentResult: noop,
    onRequestTvBounds: noop, onPortfolio: noop, onBrokers: noop,
    onAgentCapabilities: (callback) => electron.ipcRenderer.on("fixture:capabilities", (_event, value) => callback(value)),
    onAgentStream: noop, onTechnicalRadar: noop, onTvState: noop,
  });
} else {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), assert = require("node:assert/strict");
  const arguments_ = process.argv.slice(2);
  const interactive = arguments_.includes("--interactive");
  const rendererDirectory = arguments_.find((value) => !value.startsWith("--")) || path.join(__dirname, "../renderer");
  const unexpectedFlag = arguments_.find((value) => value.startsWith("--") && value !== "--interactive");
  if (unexpectedFlag) throw new Error(`Unknown smoke option: ${unexpectedFlag}`);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-health-ui-"));
  electron.app.setPath("userData", path.join(output, "profile"));
  electron.app.whenReady().then(async () => {
    const card = (id, title, state, summary, fields = []) => ({ id, title, state, summary, observedAt: "2026-09-18T01:02:03Z", fields, details: ["这里显示本机已有记录，不主动查询外部服务。"], source: "本机状态记录" });
    const model = { schemaVersion: 1, generatedAt: "2026-09-18T02:03:04Z", status: "degraded", sections: [
      { id: "storage", title: "本机保存", state: "degraded", summary: "应用索引与凭证分开；各类存储独立观测。", cards: [
        card("review", "复盘与验证记录", "healthy", "最近保存成功", [{ label: "保存方式", value: "加密文件" }]),
        card("ledger", "快照账本", "healthy", "确认记录已落盘", [{ label: "恢复副本", value: "可用" }]),
        card("business", "应用索引与最近结果", "degraded", "最近保存未完成；不等于外部 Codex 完整对话备份", [{ label: "凭证", value: "不包含" }]),
      ] },
      { id: "data", title: "连接与数据", state: "degraded", summary: "连接、行情时效与账户证据分别核对。", cards: [
        card("longbridge", "长桥", "healthy", "已连接；不是实时行情探测结果", [{ label: "持仓读取", value: "缓存" }]),
        card("ibkr", "IBKR", "degraded", "可读取期权持仓，复盘尚未接入", [{ label: "期权价格", value: "订阅条件限制" }]),
      ] },
      { id: "eod", title: "收盘快照覆盖", state: "degraded", summary: "确认落盘、已知缺口与待捕获分别保留，不补造历史。", cards: [
        card("confirmed", "确认落盘", "healthy", "已保存的正常收盘快照", [{ label: "交易日", value: 18 }]),
        card("gaps", "历史缺口", "degraded", "睡眠或离线时未捕获", [{ label: "交易日", value: 2 }]),
      ] },
      { id: "agent", title: "Agent 与上下文", state: "unknown", summary: "本视图不启动 Agent，不会把历史成功当成实时连通测试。", cards: [card("agent", "运行与回收", "unknown", "没有当前活动任务")] },
      { id: "capacity", title: "数据规模", state: "unknown", summary: "未测量的数字保留未知，不以零代替。", cards: [card("capacity", "本机占用", "unknown", "此项尚未测量", [{ label: "字节数", value: null }])] },
      { id: "version", title: "版本与支持边界", state: "healthy", summary: "软件版本不代表外部服务可用性。", cards: [card("version", "当前版本", "healthy", "隔离测试版本", [{ label: "版本", value: "0.24.2-test" }])] },
    ], capabilities: [
      { id: "longbridge", label: "长桥", items: [{ id: "history", label: "历史订单与成交", support: "implemented", state: "healthy", detail: "实际覆盖受账户归档和本地保存状态限制" }] },
      { id: "ibkr", label: "IBKR", items: [{ id: "options", label: "期权行情", support: "conditional", state: "degraded", detail: "取决于会话与行情订阅" }, { id: "review", label: "复盘与收盘快照", support: "not_supported", state: "unavailable", detail: "目前仅覆盖长桥" }] },
    ] };
    let failed = false, delayed = false, release = null, snapshotCalls = 0;
    let savedNetworkMode = "system", effectiveNetworkMode = "system", networkSaveFailure = false, delayNetworkSave = false, releaseNetworkSave = null;
    const networkSaves = [];
    const systemNetwork = { mode: "system", status: "ready", feature: "respect_system_proxy", stage: "under development", experimental: true, errorCode: null, message: "已为本应用的 Codex 进程启用非稳定的系统代理功能；实际连通性以请求结果为准。" };
    const readyCapabilities = () => ({ available: true, ready: true, readOnlyGuardReady: true, skills: [], tools: [], apps: [], network: { ...systemNetwork } });
    let capabilities = readyCapabilities();
    const networkPreferences = () => ({ mode: savedNetworkMode, effectiveMode: effectiveNetworkMode, requiresRestart: savedNetworkMode !== effectiveNetworkMode });
    const visibility = [], events = [];
    electron.ipcMain.handle("fixture:initial", () => ({ portfolio: null, codex: structuredClone(capabilities), agentNetwork: networkPreferences(), longbridge: { connected: false }, storage: { encrypted: true, state: "healthy" } }));
    electron.ipcMain.handle("fixture:capabilities", () => structuredClone(capabilities));
    let guardRechecks = 0;
    electron.ipcMain.handle("fixture:guard-recheck", async () => {
      guardRechecks++;
      capabilities = readyCapabilities();
      return structuredClone(capabilities);
    });
    electron.ipcMain.handle("fixture:network-save", async (_event, request) => {
      assert.ok(["inherit", "system"].includes(request?.mode));
      assert.deepEqual(Object.keys(request), ["mode"]);
      networkSaves.push({ ...request });
      if (delayNetworkSave) await new Promise(resolve => { releaseNetworkSave = resolve; });
      if (networkSaveFailure) throw new Error("Synthetic network save failure");
      savedNetworkMode = request.mode;
      return networkPreferences();
    });
    electron.ipcMain.handle("fixture:health-open", (_event, open) => { visibility.push(open); events.push(`visible:${open}`); return { ok: true, open }; });
    electron.ipcMain.handle("fixture:health", async () => {
      snapshotCalls++; events.push("snapshot");
      if (failed) throw new Error("Synthetic health read failure");
      if (delayed) await new Promise((resolve) => { release = resolve; });
      return structuredClone(model);
    });
    const win = new electron.BrowserWindow({ show: false, width: 1440, height: 940, webPreferences: { preload: __filename, sandbox: false, contextIsolation: true, nodeIntegration: false } });
    // Enforce isolation even when this fixture is left open for the final manual
    // pass. These synthetic bridges never start a real app-server or broker.
    win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_request, callback) => callback({ cancel: true }));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => { if (!url.startsWith("file://")) event.preventDefault(); });
    const errors = [];
    win.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
    const js = (code) => win.webContents.executeJavaScript(code);
    const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
    await win.loadFile(path.join(rendererDirectory, "index.html")); await pause();
    assert.equal(await js(`document.querySelector('#agent-network-settings').hidden`), false);
    assert.equal(await js(`document.querySelector('#agent-network-settings').open`), false, "network settings start collapsed");
    assert.equal(await js(`document.querySelector('#agent-network-mode').value`), "system");
    assert.equal(networkSaves.length, 0, "loading settings must not save or change the route");
    await js(`document.querySelector('#agent-network-settings summary').click();for(let index=0;index<6;index++)document.querySelector('#agent-resizer').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`); await pause();
    assert.equal(await js(`document.querySelector('#agent-network-settings').open`), true);
    assert.equal(await js(`document.querySelector('#agent-resizer').getAttribute('aria-valuenow')`), "320");
    for (const selector of ["#agent-network-settings", "#agent-network-form", ".agent-network-controls"]) {
      assert.equal(await js(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});return element.scrollWidth<=element.clientWidth})()`), true, `${selector} fits the 320px Agent pane`);
    }
    const tvWidth = await js(`document.querySelector('#tv-surface').getBoundingClientRect().width`);
    await js(`document.querySelector('#agent-network-mode').value='inherit';document.querySelector('#agent-network-mode').dispatchEvent(new Event('change',{bubbles:true}))`);
    assert.equal(networkSaves.length, 0, "changing the selection alone must not persist it");
    delayNetworkSave = true;
    await js(`document.querySelector('#agent-network-form').requestSubmit()`); await pause();
    assert.equal(await js(`document.querySelector('#agent-network-save').disabled`), true);
    assert.equal(await js(`document.querySelector('#agent-network-mode').disabled`), true);
    await js(`document.querySelector('#agent-network-form').requestSubmit()`); await pause();
    assert.equal(networkSaves.length, 1, "repeat submissions must not duplicate the pending save");
    assert.ok(releaseNetworkSave);
    delayNetworkSave = false; releaseNetworkSave(); await pause();
    assert.equal(savedNetworkMode, "inherit");
    assert.equal(effectiveNetworkMode, "system", "saving does not reconfigure the running process");
    assert.match(await js(`document.querySelector('#agent-network-feedback').textContent`), /下次重启应用后生效.*当前任务未中断/);
    assert.match(await js(`document.querySelector('#agent-network-effective').textContent`), /跟随系统代理（实验性）/);
    assert.match(await js(`document.querySelector('#agent-network-summary').textContent`), /重启后生效/);
    networkSaveFailure = true;
    await js(`document.querySelector('#agent-network-mode').value='system';document.querySelector('#agent-network-mode').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#agent-network-form').requestSubmit()`); await pause();
    assert.equal(savedNetworkMode, "inherit");
    assert.equal(await js(`document.querySelector('#agent-network-mode').value`), "system", "failed save retains the chosen draft");
    assert.equal(await js(`document.querySelector('#agent-network-save').disabled`), false, "failed save can be retried");
    assert.match(await js(`document.querySelector('#agent-network-feedback').textContent`), /保存未获确认.*选择已保留/);
    assert.match(await js(`document.querySelector('#agent-network-effective').textContent`), /跟随系统代理（实验性）/);
    assert.doesNotMatch(await js(`document.querySelector('#agent-network-feedback').textContent`), /Synthetic/);
    networkSaveFailure = false;
    await js(`document.querySelector('#agent-network-form').requestSubmit()`); await pause();
    assert.equal(savedNetworkMode, "system");
    assert.equal(await js(`document.querySelector('#agent-network-feedback').hidden`), true);
    assert.equal(networkSaves.length, 3);
    assert.equal(await js(`document.querySelector('#tv-surface').getBoundingClientRect().width`), tvWidth, "editing network settings does not resize TradingView");
    capabilities = { ...readyCapabilities(), readOnlyGuardReady: false, network: { ...systemNetwork, status: "failed", errorCode: "unsupported", message: "本机 Codex 不支持所选系统代理功能；未启动分析，也未静默切换为直连。" } };
    win.webContents.send("fixture:capabilities", capabilities); await pause();
    assert.equal(await js(`document.querySelector('#agent-availability').hidden`), false);
    assert.match(await js(`document.querySelector('#agent-availability').textContent`), /券商写工具只读隔离尚未通过/);
    assert.match(await js(`document.querySelector('#agent-availability').textContent`), /网络配置需检查.*不支持所选系统代理功能/);
    assert.match(await js(`document.querySelector('#agent-network-runtime').textContent`), /不支持所选系统代理功能/);
    assert.equal(await js(`document.querySelector('#agent-availability').getAttribute('role')`), "status");
    assert.equal(await js(`document.querySelector('#agent-submit').disabled`), true);
    assert.equal(await js(`document.querySelector('#codex-badge').textContent`), "CODEX GUARD");
    assert.equal(await js(`document.querySelector('#agent-availability').scrollWidth<=document.querySelector('#agent-availability').clientWidth`), true, "guard explanation wraps inside the agent pane");
    fs.writeFileSync(path.join(output, "agent-readonly-guard.png"), (await win.webContents.capturePage()).toPNG());
    capabilities = { ...readyCapabilities(), readOnlyGuardReady: false, readOnlyGuardDiagnostic: {
      state: "blocked", code: "cold_configuration_required", title: "旧对话尚未加载只读配置",
      message: "请新建安全对话，或在任务结束后退出并重新打开驾驶舱。原对话与输入不会删除。",
      action: "new_session", tools: [{ server: "broker_data", tool: "submit_order" }],
    } };
    win.webContents.send("fixture:capabilities", capabilities); await pause();
    assert.match(await js(`document.querySelector('#agent-availability').textContent`), /broker_data\/submit_order/);
    assert.equal(await js(`document.querySelector('#agent-guard-new-session').hidden`), false);
    assert.equal(await js(`document.querySelector('#agent-guard-actions').scrollWidth<=document.querySelector('#agent-guard-actions').clientWidth`), true, "repair controls fit the narrow pane");
    await js(`document.querySelector('#agent-guard-recheck').click()`); await pause();
    assert.equal(guardRechecks, 1);
    assert.equal(await js(`document.querySelector('#agent-guard-actions').hidden`), true);
    assert.equal(await js(`document.querySelector('#codex-badge').textContent`), "CODEX READY");
    capabilities = readyCapabilities();
    win.webContents.send("fixture:capabilities", capabilities); await pause();
    assert.equal(await js(`document.querySelector('#agent-availability').hidden`), true);
    assert.equal(await js(`document.querySelector('#codex-badge').textContent`), "CODEX READY");
    await js(`document.querySelector('#agent-network-settings summary').click();document.querySelector('#agent-resizer').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`); await pause();
    await js(`document.querySelector('#agent-input').value='未提交的真实界面草稿';document.querySelector('#system-health-open').focus();document.querySelector('#system-health-open').click()`); await pause();
    assert.equal(await js(`document.querySelector('#system-health-dialog').open`), true);
    assert.equal(await js(`document.activeElement.id`), "system-health-close");
    assert.deepEqual(events.slice(0, 2), ["visible:true", "snapshot"]);
    assert.equal(snapshotCalls, 1);
    assert.match(await js(`document.querySelector('#system-health-asof').textContent`), /非行情时间/);
    assert.match(await js(`document.querySelector('#system-health-body').textContent`), /应用索引与最近结果.*最近保存未完成/s);
    assert.equal(await js(`document.querySelector('#system-health-body').scrollHeight>document.querySelector('#system-health-body').clientHeight`), true, "long status body must scroll independently");
    assert.equal(await js(`document.querySelector('#system-health-dialog').scrollWidth<=document.querySelector('#system-health-dialog').clientWidth`), true, "dialog must not overflow horizontally");
    fs.writeFileSync(path.join(output, "health-top.png"), (await win.webContents.capturePage()).toPNG());
    await js(`document.querySelector('#system-health-body').scrollTop=document.querySelector('#system-health-body').scrollHeight`); await pause();
    fs.writeFileSync(path.join(output, "health-capabilities.png"), (await win.webContents.capturePage()).toPNG());
    await js(`document.querySelector('#system-health-refresh').click()`); await pause();
    assert.equal(snapshotCalls, 2);
    failed = true;
    await js(`document.querySelector('#system-health-refresh').click()`); await pause();
    assert.match(await js(`document.querySelector('#system-health-message').textContent`), /本次读取失败/);
    assert.equal(await js(`document.querySelector('#system-health-body').childElementCount`), 0);
    fs.writeFileSync(path.join(output, "health-failure.png"), (await win.webContents.capturePage()).toPNG());
    failed = false;
    await js(`document.querySelector('#system-health-refresh').click()`); await pause();
    assert.equal(snapshotCalls, 4);
    delayed = true;
    await js(`document.querySelector('#system-health-refresh').click()`); await pause();
    assert.equal(await js(`document.querySelector('#system-health-body').childElementCount`), 0);
    assert.equal(await js(`document.querySelector('#system-health-refresh').disabled`), true);
    assert.ok(release);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" }); await pause();
    assert.equal(await js(`document.querySelector('#system-health-dialog').open`), false, "native Escape must close through host restore");
    assert.equal(await js(`document.activeElement.id`), "system-health-open");
    delayed = false; release(); await pause();
    assert.equal(await js(`document.querySelector('#system-health-body').childElementCount`), 0, "late refresh cannot recreate closed dialog content");
    assert.equal(await js(`document.querySelector('#agent-input').value`), "未提交的真实界面草稿");
    await js(`document.querySelector('#workspace-review').click()`); await pause();
    await js(`document.querySelector('#system-health-open').focus();document.querySelector('#system-health-open').click()`); await pause();
    await js(`document.querySelector('#system-health-close').click()`); await pause();
    assert.equal(await js(`document.body.dataset.workspaceMode`), "review", "health does not alter workspace selection");
    assert.deepEqual(visibility, [true, false, true, false]);
    assert.deepEqual(errors, []);
    process.stdout.write(JSON.stringify({ output, snapshotCalls, networkSaveCalls: networkSaves.length, interactive, screenshots: ["agent-readonly-guard.png", "health-top.png", "health-capabilities.png", "health-failure.png"], checks: "network collapsed / explicit single-flight save / pending restart / failed save preserves draft and route / 320px pane / TV width stable / network failure plus broker guard / open / local refresh / scroll / native Escape / focus / late response / workspace and draft isolation PASS" }) + "\n");
    if (interactive) {
      // Opt-in only, after every automated assertion passed. Reload solely this
      // temporary synthetic profile; no real application or account is touched.
      savedNetworkMode = "system"; effectiveNetworkMode = "system";
      capabilities = readyCapabilities();
      await js(`document.querySelector('#workspace-cockpit').click()`); await pause();
      await win.loadFile(path.join(rendererDirectory, "index.html")); await pause();
      assert.equal(await js(`document.body.dataset.workspaceMode`), "cockpit");
      assert.equal(await js(`document.querySelector('#agent-network-settings').open`), false);
      assert.equal(await js(`document.querySelector('#agent-network-mode').value`), "system");
      assert.equal(await js(`document.querySelector('#codex-badge').textContent`), "CODEX READY");
      win.setTitle("交易驾驶舱 · 隔离验收 · 无真实账户");
      win.on("page-title-updated", event => event.preventDefault());
      win.on("closed", () => electron.app.quit());
      win.show(); win.focus();
      process.stdout.write("Interactive acceptance window ready; synthetic data only. Close the window to exit.\n");
      return;
    }
    win.destroy(); electron.app.quit();
  }).catch((error) => { process.stderr.write(error.stack + "\n"); electron.app.exit(1); });
}
