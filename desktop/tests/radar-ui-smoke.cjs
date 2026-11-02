// Isolated desktop interaction checks. No real credentials, market queries,
// TradingView session or Agent execution are used.
const electron = require("electron");
if (process.type === "renderer") {
  const noop = () => {};
  electron.contextBridge.exposeInMainWorld("cockpit", {
    getInitialState: () => electron.ipcRenderer.invoke("fixture:initial"),
    getAgentCapabilities: async () => ({ skills: [], tools: [], apps: [] }),
    agentSessions: { list: async () => ({ sessions: [] }) },
    technicalRadar: { snapshot: () => electron.ipcRenderer.invoke("fixture:radar"), run: () => electron.ipcRenderer.invoke("fixture:radar"), addWatchlist: (s) => electron.ipcRenderer.invoke("fixture:add", s) },
    workspace: { setMode: async () => ({ ok: true }) },
    onRequestTvBounds: noop, onStatus: noop, onPortfolio: noop, onBrokers: noop, onAgentCapabilities: noop, onAgentStream: noop, onAgentResult: noop, onTvState: noop,
    onTechnicalRadar: (cb) => electron.ipcRenderer.on("fixture:update", (_e, radar) => cb(radar)),
    tv: { setBounds: noop, loadSymbol: (s) => electron.ipcRenderer.invoke("fixture:tv", s) }, openExternal: noop,
  });
} else {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), assert = require("node:assert/strict");
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-radar-ui-"));
  electron.app.setPath("userData", path.join(output, "profile"));
  electron.app.whenReady().then(async () => {
    const symbols = ["AAPL.US", "MU.US", "AVGO.US", "NVDA.US", "MSFT.US", "GOOGL.US", "QQQ.US", "AMD.US", "SOXX.US", "DRAM.US", "SKHY.US", "PDD.US"];
    const radar = { running: false, lastError: null, watchlist: { items: [{ symbol: "MU.US" }], revision: 1 }, linkage: { profiles: [] },
      latestBatch: { tradingDate: "2026-09-16", computedAt: new Date().toISOString(), summary: { status: "degraded", coverage: { selectedSymbolCount: 12, requestedSymbolCount: 12 }, rankings: { changes: { rows: [] }, anomalies: { rows: [] } } },
        items: symbols.map((symbol, i) => ({ symbol, memberships: ["holding"], status: i % 3 === 0 ? "partial" : "complete", degradedReasons: i % 3 === 0 ? ["weekly_structure_incomplete"] : [],
          structure: { short: i % 2 ? "交错 / 过渡" : "完整多头", long: "长周期多头", priceVsEma21: "below" }, metrics: { qqqExcessReturns: { 20: { status: "available", value: 2.3 } } },
          ema: { 21: { status: "available", value: 130 } }, comparison: { kind: i === 1 || i === 2 ? "state_changed" : "unchanged", changedFields: i === 1 || i === 2 ? [{ field: "priceVsEma21", from: "above", to: "below" }] : [] } })) } };
    const tv = [], errors = [];
    electron.ipcMain.handle("fixture:initial", () => ({ portfolio: null, codex: { available: false }, longbridge: { connected: false }, storage: { encrypted: true } }));
    electron.ipcMain.handle("fixture:radar", () => ({ radar }));
    electron.ipcMain.handle("fixture:tv", (_e, s) => { tv.push(s); });
    electron.ipcMain.handle("fixture:add", (_e, s) => { radar.watchlist.items.push({ symbol: `${s}.US` }); radar.watchlist.updatedAt = new Date(Date.now() + 1000).toISOString(); return { radar }; });
    const win = new electron.BrowserWindow({ show: false, width: 1480, height: 940, webPreferences: { preload: __filename, sandbox: false, contextIsolation: true, nodeIntegration: false } });
    win.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
    const js = (code) => win.webContents.executeJavaScript(code);
    const pause = () => new Promise((r) => setTimeout(r, 180));
    const capture = async (name) => { await pause(); fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG()); };
    const rendererDirectory = process.argv[2] || path.join(__dirname, "../renderer");
    await win.loadFile(path.join(rendererDirectory, "index.html")); await pause();
    await js(`document.querySelector('.tv-placeholder strong').textContent = '桌面交互验证'; document.querySelector('.tv-placeholder p').textContent = '模拟数据 · 未连接券商或个人 TV';`);
    const tvBefore = await js(`document.querySelector('#tv-surface').getBoundingClientRect().width`);
    await js(`document.querySelector('[data-portfolio-view="radar"]').click()`);
    assert.equal(await js(`document.querySelector('#tv-surface').getBoundingClientRect().width`), tvBefore);
    assert.ok(await js(`document.querySelector('#technical-radar').clientHeight > 600`));
    assert.equal(await js(`document.querySelectorAll('.technical-radar-card').length`), 12);
    assert.equal(await js(`document.querySelector('[data-radar-expand]').dataset.radarExpand`), "MU.US");
    await capture("radar-results.png");
    await js(`document.querySelector('[data-radar-expand="MU.US"]').click()`);
    assert.equal(tv.length, 0, "expansion never switches chart or starts an Agent");
    assert.match(await js(`document.querySelector('.radar-card-detail:not([hidden])').innerText`), /均线上方 → 均线下方/);
    await capture("radar-detail.png");
    await js(`document.querySelector('[data-radar-filter="changed"]').click()`);
    assert.equal(await js(`document.querySelectorAll('.technical-radar-card').length`), 2);
    await js(`document.querySelector('#radar-search').value='zzzz';document.querySelector('#radar-search').dispatchEvent(new Event('input',{bubbles:true}))`);
    assert.match(await js(`document.querySelector('#technical-radar-list').innerText`), /没有匹配/);
    await js(`document.querySelector('[data-radar-clear]').click(); document.querySelector('[data-radar-linkage="MU.US"]').click()`);
    await js(`const input=document.querySelector('#technical-linkage-rationale');input.value='保留我的未保存判断';input.dispatchEvent(new Event('input',{bubbles:true}));`);
    await js(`document.querySelector('#technical-linkage-symbol').value='AAPL.US';document.querySelector('#technical-linkage-symbol').dispatchEvent(new Event('change',{bubbles:true}))`);
    await js(`document.querySelector('#technical-linkage-symbol').value='MU.US';document.querySelector('#technical-linkage-symbol').dispatchEvent(new Event('change',{bubbles:true}))`);
    assert.equal(await js(`document.querySelector('#technical-linkage-rationale').value`), "保留我的未保存判断");
    await js(`document.querySelector('#technical-linkage-symbol').focus();document.querySelector('#technical-linkage-symbol').value='AAPL';document.querySelector('#technical-linkage-symbol').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#technical-linkage-rationale').focus();document.querySelector('#technical-linkage-rationale').value='AAPL简写输入草稿';document.querySelector('#technical-linkage-rationale').dispatchEvent(new Event('input',{bubbles:true}));setTechnicalLinkageEditorSymbol('MU',{force:true});setTechnicalLinkageEditorSymbol('AAPL',{force:true})`);
    assert.equal(await js(`state.technicalLinkageDraft.rationale`), "AAPL简写输入草稿");
    await js(`document.activeElement.blur();setTechnicalLinkageEditorSymbol('MU',{force:true})`);
    win.webContents.send("fixture:update", radar); await pause();
    assert.equal(await js(`document.querySelector('#technical-linkage-rationale').value`), "保留我的未保存判断");
    await js(`document.querySelector('#technical-radar-body').scrollTop=9999`);
    const reachable = await js(`(() => {const a=document.querySelector('#technical-radar-body').getBoundingClientRect(),b=document.querySelector('#technical-linkage-save').getBoundingClientRect();return b.top>=a.top&&b.bottom<=a.bottom})()`);
    assert.equal(reachable, true, "linkage confirmation stays reachable by scrolling");
    await capture("radar-settings.png");
    assert.ok(await js(`(() => {const a=document.querySelector('#technical-radar-body').getBoundingClientRect(),b=document.querySelector('#radar-settings-back').getBoundingClientRect();return b.top>=a.top&&b.bottom<=a.bottom})()`), "back to results stays visible at the bottom of settings");
    await js(`document.querySelector('#radar-settings-back').click();document.querySelector('[data-radar-open="MU.US"]').click()`);
    await pause(); assert.deepEqual(tv, ["MU"]);
    await js(`document.querySelector('[data-radar-expand="MU.US"]').focus();document.querySelector('[data-radar-expand="MU.US"]').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));`);
    assert.equal(await js(`document.activeElement.dataset.radarExpand`), "PDD.US");
    const beforeScroll = await js(`document.querySelector('#technical-radar-body').scrollTop`);
    win.webContents.send("fixture:update", radar); await pause();
    assert.ok(Math.abs(await js(`document.querySelector('#technical-radar-body').scrollTop`) - beforeScroll) < 2);
    assert.equal(await js(`document.activeElement.dataset.radarExpand`), "PDD.US");
    win.setSize(1280, 800); await pause();
    await js(`state.layout.portfolioWidth=220;applyPaneWidths();document.querySelector('#technical-radar-body').scrollTop=0`);
    assert.ok(await js(`document.querySelector('#tv-surface').getBoundingClientRect().width >= 440`));
    assert.ok(await js(`document.querySelector('#portfolio-pane').scrollWidth <= document.querySelector('#portfolio-pane').clientWidth + 1`));
    assert.ok(await js(`document.querySelector('#technical-radar-body').scrollWidth <= document.querySelector('#technical-radar-body').clientWidth + 1`));
    await capture("radar-narrow.png");
    await js(`document.querySelector('[data-portfolio-view="portfolio"]').click()`);
    assert.equal(await js(`document.querySelector('#technical-radar-body').hidden`), true);
    assert.deepEqual(errors, []);
    process.stdout.write(JSON.stringify({ output, checks: "view/filter/detail/explicit-sync/draft/refresh/keyboard/narrow PASS" }) + "\n");
    win.destroy(); electron.app.quit();
  }).catch((error) => { process.stderr.write(error.stack + "\n"); electron.app.exit(1); });
}
