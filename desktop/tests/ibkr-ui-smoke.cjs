// Isolated UI smoke test. Synthetic data only; never loads the real profile,
// real broker connectors, TradingView cookies, or the Codex harness.
const electron = require("electron");
if (process.type === "renderer") {
  const noop = () => {};
  electron.contextBridge.exposeInMainWorld("cockpit", {
    getInitialState: () => electron.ipcRenderer.invoke("fixture:initial"),
    getAgentCapabilities: async () => ({ skills: [], tools: [], apps: [] }),
    agentSessions: { list: async () => ({ sessions: [] }) },
    technicalRadar: { snapshot: async () => ({ radar: {} }) },
    brokers: { snapshot: () => electron.ipcRenderer.invoke("fixture:brokers"), refresh: async () => ({ ok: true, results: [], brokers: await electron.ipcRenderer.invoke("fixture:brokers") }) },
    workspace: { setMode: async () => ({ ok: true }) },
    onRequestTvBounds: noop, onStatus: noop, onPortfolio: noop, onBrokers: noop,
    onAgentCapabilities: noop, onAgentStream: noop, onAgentResult: noop, onTechnicalRadar: noop, onTvState: noop,
    tv: { setBounds: noop }, openExternal: noop,
  });
} else {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const assert = require("node:assert/strict");
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-ibkr-ui-"));
  electron.app.setPath("userData", path.join(output, "profile"));
  electron.app.whenReady().then(async () => {
    const { normalizeIbkrPortfolio } = await import("../src/data/ibkr-portfolio.mjs");
    const { buildBrokerViews } = await import("../src/data/broker-portfolios.mjs");
    const now = Date.now();
    const p = normalizeIbkrPortfolio({ account: { id: "U1234567", currency: "USD" },
      summary: { netliquidation: { amount: 10000, currency: "USD" }, totalcashvalue: { amount: 5000, currency: "USD" } },
      ledger: { USD: { exchangerate: 1 } },
      positions: [
        { acctId: "U1234567", conid: 100, assetClass: "STK", ticker: "AAPL", isUS: true, currency: "USD", position: 10, mktPrice: 120, mktValue: 1200, avgCost: 100 },
        { acctId: "U1234567", conid: 200, assetClass: "OPT", ticker: "AAPL", contractDesc: "AAPL SEP 25 120 C", currency: "USD", position: 2, mktPrice: 2, mktValue: 400, avgCost: 250, multiplier: 100, expiry: "20260925", putOrCall: "C", strike: 120 },
      ], quotes: [{ conid: 200, _updated: now, "6509": "DPB", "84": "2.00", "86": "2.20", "7308": ".5", "7309": ".02", "7310": "-.1", "7311": ".03", "7633": "35.2%", "7638": "1200" }], now });
    const views = buildBrokerViews({ longbridge: p, ibkr: p, ibkrEnabled: true });
    const brokers = { views, ibkr: { state: "connected", config: { transport: "tws", port: 7496, accountId: "U1234567", enabled: true }, accounts: [{ id: "U1234567", label: "模拟 IBKR · U***567" }] } };
    electron.ipcMain.handle("fixture:brokers", () => brokers);
    electron.ipcMain.handle("fixture:initial", () => ({ brokers, portfolio: p, codex: { available: false }, longbridge: { connected: false }, storage: { encrypted: true } }));
    const win = new electron.BrowserWindow({ show: false, width: 1480, height: 940,
      webPreferences: { preload: __filename, sandbox: false, contextIsolation: true, nodeIntegration: false } });
    win.webContents.on("console-message", (_event, _level, message) => { if (typeof message === "string" && /Error/.test(message)) process.stderr.write(`${message}\n`); });
    const rendererDirectory = process.argv[2] || path.join(__dirname, "../renderer");
    await win.loadFile(path.join(rendererDirectory, "index.html"));
    await new Promise((r) => setTimeout(r, 350));
    const check = () => win.webContents.executeJavaScript(`(() => {
      const r = (id) => { const el = document.querySelector(id); const rect = el.getBoundingClientRect(); return { width: rect.width, height: rect.height, scroll: el.scrollHeight, client: el.clientHeight }; };
      return { scope: document.querySelector('[data-broker-scope][aria-pressed="true"]').dataset.brokerScope,
        rows: document.querySelectorAll('.position-row').length, account: document.querySelector('#account-card').innerText,
        list: r('#position-list'), tv: r('#tv-surface'), pane: r('#portfolio-pane'),
        overflowX: document.documentElement.scrollWidth > window.innerWidth, message: document.querySelector('#system-message').innerText };
    })()`);
    let metrics = await check(); assert.equal(metrics.scope, "all"); assert.equal(metrics.rows, 3);
    assert.ok(metrics.account.includes("20,000")); assert.ok(metrics.tv.width >= 440); assert.equal(metrics.overflowX, false);
    await win.webContents.executeJavaScript(`document.querySelector('.tv-placeholder strong').textContent = 'UI 验证 · 模拟数据'; document.querySelector('.tv-placeholder p').textContent = '本次验证没有连接券商，也没有加载个人 TradingView。'`);
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(path.join(output, "all-accounts.png"), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`document.querySelector('[data-broker-scope="ibkr"]').click(); document.querySelectorAll('.broker-position-details')[1].open = true; document.querySelectorAll('.broker-position-details')[1].scrollIntoView({block:'end'});`);
    metrics = await check(); assert.equal(metrics.rows, 2); assert.ok(metrics.list.height > 70);
    const detail = await win.webContents.executeJavaScript(`document.querySelectorAll('.broker-position-details')[1].innerText`);
    assert.match(detail, /Delta/); assert.match(detail, /0.5000/); assert.match(detail, /延迟/);
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(path.join(output, "ibkr-options.png"), (await win.webContents.capturePage()).toPNG());
    win.setSize(1280, 800);
    await new Promise((r) => setTimeout(r, 200));
    await win.webContents.executeJavaScript(`document.querySelector('#ibkr-setup').open = true;`);
    metrics = await check(); assert.ok(metrics.tv.width >= 440); assert.equal(metrics.overflowX, false);
    assert.ok(metrics.pane.scroll <= metrics.pane.client + 1, "settings must not clip the portfolio pane");
    const setup = await win.webContents.executeJavaScript(`(() => {
      const body = document.querySelector('.ibkr-setup-body'); body.scrollTop = body.scrollHeight;
      const a = body.getBoundingClientRect(), b = document.querySelector('#ibkr-sync').getBoundingClientRect();
      return { reachable: b.top >= a.top && b.bottom <= a.bottom, certificateHidden: document.querySelector('#ibkr-trust').closest('label').getBoundingClientRect().height === 0 };
    })()`);
    assert.equal(setup.reachable, true, "save button must be reachable inside settings scroll area");
    assert.equal(setup.certificateHidden, true, "TWS never shows a TLS exception toggle");
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(path.join(output, "compact-setup.png"), (await win.webContents.capturePage()).toPNG());
    process.stdout.write(JSON.stringify({ output, metrics }) + "\n");
    win.destroy(); electron.app.quit();
  }).catch((error) => { process.stderr.write(`${error.stack}\n`); electron.app.exit(1); });
}
