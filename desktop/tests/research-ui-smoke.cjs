// Isolated full Chromium renderer + actual ResearchThesisStore. All bridge
// responses are synthetic, the store is memory-only, and external network is
// denied. This driver never loads a real account, profile or Codex harness.
const electron = require("electron");

if (process.type === "renderer") {
  const noop = () => {};
  const invoke = (name) => (request) => electron.ipcRenderer.invoke(`research-fixture:${name}`, request);
  const listen = (name) => (callback) => electron.ipcRenderer.on(`research-fixture:${name}`, (_event, payload) => callback(payload));
  electron.contextBridge.exposeInMainWorld("cockpit", {
    getInitialState: invoke("initial"), getAgentCapabilities: invoke("capabilities"),
    agentSessions: { list: invoke("sessions"), create: invoke("session-create"), switch: invoke("session-open"), open: invoke("session-open") },
    runAgent: invoke("run"),
    workspace: { setMode: invoke("workspace") },
    research: Object.fromEntries(["snapshot", "create", "revise", "addEvidence", "addObservation", "setStatus", "linkReview", "acceptProposal"].map((name) => [name, invoke(name)])),
    review: { snapshot: invoke("review-snapshot") },
    technicalRadar: { snapshot: async () => ({ radar: {} }) },
    tv: { setBounds: noop, reload: noop, home: noop, loadSymbol: noop },
    openExternal: noop, onAgentResult: listen("agent-result"), onStatus: noop,
    onReviewSnapshotUpdated: noop, onRequestTvBounds: noop, onPortfolio: noop,
    onBrokers: noop, onAgentCapabilities: noop, onAgentStream: noop,
    onTechnicalRadar: noop, onTvState: noop,
  });
} else {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { pathToFileURL } = require("node:url");
  const arguments_ = process.argv.slice(2);
  const interactive = arguments_.includes("--interactive");
  const unexpected = arguments_.find((value) => value.startsWith("--") && value !== "--interactive");
  if (unexpected) throw new Error(`Unknown smoke option: ${unexpected}`);
  const rendererDirectory = path.resolve(arguments_.find((value) => !value.startsWith("--")) || path.join(__dirname, "../renderer"));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-research-ui-"));
  const profile = path.join(output, "synthetic-profile");
  electron.app.setPath("userData", profile);

  electron.app.whenReady().then(async () => {
    const { ResearchThesisStore, RESEARCH_THESIS_FIELDS } = await import(pathToFileURL(path.join(__dirname, "../src/data/research-thesis-store.mjs")).href);
    const { assertResearchReviewLink, eligibleResearchReviewCycles } = await import(pathToFileURL(path.join(__dirname, "../src/review/research-links.mjs")).href);
    const { buildResearchEvidence } = await import(pathToFileURL(path.join(__dirname, "../src/engine/agent.mjs")).href);
    const memory = new Map();
    let sequence = 0, clock = Date.parse("2026-10-22T01:00:00.000Z");
    const store = new ResearchThesisStore({
      store: { get: async (key) => structuredClone(memory.get(key)), set: async (key, value, options) => { options?.commitGuard?.(); memory.set(key, structuredClone(value)); } },
      now: () => new Date(clock++), idFactory: () => `synthetic-research-${++sequence}`,
    });
    const accountScopeId = "synthetic-account-only";
    const cycle = { id: "synthetic-cycle", title: "演示标的 · 选定订单周期", cycleType: "trade_window", reviewMode: "lightweight", status: "draft", scope: "single_symbol", symbols: ["DEMO.US"], startAt: "2026-10-12T14:00:00.000Z", endAt: "2026-10-21T20:00:00.000Z", evidenceRevision: 1,
      brokerLinks: { accountScopeId, orderIds: ["synthetic-buy", "synthetic-sell"], executionIds: [], evidenceRevision: 1 },
      retrospectiveDraft: { recalledJudgment: "仅演示所选订单，不是真实账户。", lesson: "确认原判断与后续证据分开保存。", forwardHypothesis: "继续观察，不形成正式规则。" },
    };
    const readSnapshot = async () => ({ ...(await store.snapshot({ includeArchived: true })), reviewCycles: eligibleResearchReviewCycles([cycle], accountScopeId) });
    const capabilities = { available: true, ready: true, readOnlyGuardReady: true, skills: [{ name: "analyze-market-narratives", description: "隔离演示，只显示 Skill 名称，不调用模型。" }], tools: [], apps: [], researchMode: { kind: "restricted", available: true, unavailableTools: ["MCP", "Apps"], reason: "synthetic_fixture", recoveryAction: "new_full_session" } };
    const requests = [], sessions = [], runs = [], workspaceModes = [];
    let snapshotReads = 0, reviewSnapshotReads = 0, blockedNetworkRequests = 0;
    const register = (name, callback) => electron.ipcMain.handle(`research-fixture:${name}`, (_event, request) => callback(request));
    register("initial", () => ({ portfolio: null, codex: capabilities, longbridge: { connected: false }, storage: { encrypted: true, state: "healthy" } }));
    register("capabilities", () => capabilities);
    register("workspace", (mode) => { workspaceModes.push(mode); return { ok: true, mode }; });
    register("sessions", () => ({ sessions, activeSessionId: sessions.at(-1)?.id ?? null }));
    register("session-create", (request) => {
      requests.push({ method: "session-create", request });
      const session = { id: `synthetic-persistent-thread-${sessions.length + 1}`, name: request.name || "隔离研究对话", runState: "idle", toolMode: "restricted" };
      sessions.push(session);
      return { session, sessions: structuredClone(sessions), activeSessionId: session.id };
    });
    register("session-open", (request) => {
      const id = typeof request === "string" ? request : request?.threadId;
      const session = sessions.find((item) => item.id === id);
      assert.ok(session);
      return { session, sessions, activeSessionId: session.id };
    });
    register("snapshot", async () => { snapshotReads++; return { ok: true, snapshot: await readSnapshot() }; });
    register("review-snapshot", () => {
      reviewSnapshotReads++;
      return { accountScopeId, snapshotUpdateSequence: 1, cases: [], cycles: [cycle], tests: [], rules: [], reviews: [], ruleMetrics: {}, validationCandidates: {}, intake: { records: [], eventCandidates: [], totalRecordCount: 0 }, portfolioSnapshots: {}, summary: {} };
    });
    for (const method of ["create", "revise", "addEvidence", "addObservation", "setStatus", "acceptProposal", "linkReview"]) {
      register(method, async (request) => {
        requests.push({ method, request: structuredClone(request) });
        let thesis;
        if (method === "create") thesis = await store.create(request);
        else if (method === "linkReview") {
          const current = (await store.snapshot({ includeArchived: true })).theses.find((item) => item.id === request.id);
          assertResearchReviewLink({ thesis: current, cycle, accountScopeId });
          assert.equal(request.cycleId, cycle.id);
          thesis = await store.linkReview(request.id, { ...request, accountScopeId, cycleTitle: cycle.title });
        } else thesis = await store[method](request.id, request);
        return { ok: true, thesis, snapshot: await readSnapshot() };
      });
    }
    register("run", async (request) => {
      assert.equal(request.scope, "chat");
      assert.equal(request.researchIntent, "update");
      assert.equal(request.threadId, sessions.at(-1).id);
      assert.match(request.task, /\$analyze-market-narratives/);
      requests.push({ method: "run", request: structuredClone(request) });
      const current = (await store.snapshot()).theses.find((item) => item.id === request.researchThesisId);
      const fields = Object.fromEntries(RESEARCH_THESIS_FIELDS.map((key) => [key, null]));
      fields.marketBelief = "演示：市场更关注收入兑现与现金流，而不是单一增长叙事。";
      fields.nextTrigger = "演示：核对下一次披露与一致预期修订，来源仍需确认。";
      const updated = await store.saveProposal(current.id, { expectedRevision: current.revision, sourceRunId: "synthetic-run-1", sourceThreadId: request.threadId,
        proposal: { fields, evidence: [{ claim: "演示来源声称收入同比增长；不是真实投资事实。", stance: "context", kind: "fact", sourceTitle: "合成 IR 示例（未访问）", url: "https://example.com/synthetic-ir", publishedAt: "2026-10-21T00:00:00.000Z", numeric: { value: 0, unit: "%", period: "FY2026 Q3 synthetic", currency: "USD", denominator: "synthetic prior period" } }], openQuestions: ["真实一致预期尚未核验；本测试未联网。"] },
      });
      const run = buildResearchEvidence({ task: request.task });
      run.id = "synthetic-run-1"; run.operationId = request.operationId;
      run.status = "completed"; run.state = "SYNTHETIC_COMPLETED";
      run.context = { ...run.context, researchThesisId: current.id, researchTitle: current.name, researchProposalId: updated.proposals.at(-1).id, researchProposalPersistence: "recorded_pending_confirmation" };
      run.conclusion = { headline: "隔离研究演示已完成", body: "这是合成回答：草案已保存，原判断未被覆盖。未调用真实模型、券商或外部网络。", posture: "仅演示 · 待用户确认" };
      run.modelAnalysis = { threadId: request.threadId, requestedSkills: ["analyze-market-narratives"], toolEvents: [] };
      runs.push(run);
      return run;
    });

    const win = new electron.BrowserWindow({ show: false, width: 1480, height: 960, webPreferences: { preload: __filename, sandbox: false, contextIsolation: true, nodeIntegration: false, partition: "research-ui-synthetic-memory" } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_request, callback) => { blockedNetworkRequests++; callback({ cancel: true }); });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => { if (!url.startsWith("file://")) event.preventDefault(); });
    const errors = [];
    win.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
    const js = (code) => win.webContents.executeJavaScript(code);
    const pause = (ms = 70) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (predicate, message) => { for (let index = 0; index < 100; index++) { if (await js(predicate)) return; await pause(); } throw new Error(`Timed out: ${message}`); };
    const clickText = (text) => js(`(()=>{const button=[...document.querySelectorAll('#research-detail button')].find(item=>item.textContent===${JSON.stringify(text)});if(!button)throw Error('Missing button');button.click()})()`);
    const setField = (label, value) => js(`(()=>{const label=[...document.querySelectorAll('#research-detail label')].find(item=>item.firstChild?.textContent===${JSON.stringify(label)});if(!label)throw Error('Missing field');const input=label.querySelector('input,textarea,select');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`);

    await win.loadFile(path.join(rendererDirectory, "index.html")); await pause();
    assert.equal(snapshotReads, 0, "research is not fetched before its tab is opened");
    assert.equal(reviewSnapshotReads, 0);
    await js(`location.hash='#/review/research'`);
    await waitFor(`document.body.dataset.workspaceMode==='review'&&!document.querySelector('#review-panel-research').hidden`, "research workspace");
    await waitFor(`document.querySelector('#research-refresh').disabled===false`, "research read");
    assert.equal(reviewSnapshotReads, 0, "research entry never loads the whole review workspace snapshot");
    await js(`document.querySelector('#research-create-symbol').value='DEMO.US';document.querySelector('#research-create-view').value='演示：我认为收入兑现可能领先于市场预期。';document.querySelector('#research-create-form').requestSubmit()`);
    await waitFor(`document.querySelector('#research-detail').textContent.includes('我的判断 · 版本化保存')`, "create thesis");
    let current = (await store.snapshot()).theses[0];
    const originalVersion = structuredClone(current.versions[0]);
    assert.equal(current.versions.length, 1);
    assert.equal(sessions.length, 0, "saving a judgment does not start research");
    const thesisId = current.id;
    // Exercise the list selection independently of auto-select after creation.
    await js(`document.querySelector('#research-list button').click()`);
    await js(`(()=>{const details=[...document.querySelectorAll('#research-detail details')].find(item=>item.firstChild.textContent==='添加一条证据 / 反证');details.open=true})()`);
    await setField("证据 / 反证内容", "演示：经营利润率为零，需保留原始口径。");
    await setField("原始数值", "0"); await setField("单位，如 % / 百万美元", "%");
    await setField("所属期间，如 FY2026 Q2", "FY2026 Q3 synthetic"); await setField("币种，如 USD", "USD");
    await setField("分母 / 比较口径", "synthetic revenue");
    await clickText("保存证据记录");
    await waitFor(`document.querySelector('#research-detail').textContent.includes('原始数值 0 %')`, "numeric zero evidence");
    current = (await store.snapshot()).theses[0];
    assert.equal(current.evidence[0].numeric.value, 0);
    assert.equal(current.evidence[0].numeric.unit, "%");
    assert.equal(current.evidence[0].provenance, "manual_unverified");
    assert.equal(current.versions.length, 1);

    await clickText("新对话研究并生成草案");
    await waitFor(`document.querySelector('[data-open-research]')!==null`, "synthetic research completion");
    assert.equal(sessions.length, 1, "one explicit button creates one persistent session");
    assert.equal(runs.length, 1, "one explicit button creates one synthetic run");
    assert.equal(requests.filter((item) => item.method === "session-create").length, 1);
    assert.equal(requests.filter((item) => item.method === "run").length, 1);
    assert.equal(await js(`state.operations.size`), 0, "completed result settles the original renderer operation");
    assert.equal(await js(`state.analysisScope`), "chat");
    await js(`document.querySelector('[data-open-research]').click()`);
    await waitFor(`document.body.dataset.workspaceMode==='review'&&document.querySelector('#research-detail').textContent.includes('AI 更新草案 · 1 条待确认')`, "open result-linked saved proposal");
    assert.equal(reviewSnapshotReads, 0, "opening a research result does not read full broker review data");
    const selected = await js(`(()=>{const form=[...document.querySelectorAll('#research-detail form')].find(item=>item.textContent.includes('确认采纳勾选字段'));const label=text=>[...form.querySelectorAll('label')].find(item=>item.textContent.includes(text));return {myView:label('采纳：我目前的判断').querySelector('input').checked,source:label('纳入证据账本').querySelector('input').checked}})()`);
    assert.deepEqual(selected, { myView: false, source: false }, "unknown model fields and suggested sources never default to adoption");
    assert.deepEqual((await store.snapshot()).theses[0].versions[0], originalVersion);
    await js(`(()=>{const form=[...document.querySelectorAll('#research-detail form')].find(item=>item.textContent.includes('确认采纳勾选字段'));const label=text=>[...form.querySelectorAll('label')].find(item=>item.textContent.includes(text));const source=label('纳入证据账本').querySelector('input');source.checked=true;source.dispatchEvent(new Event('change',{bubbles:true}));const market=[...form.querySelectorAll('label')].find(item=>item.firstChild?.textContent==='市场目前相信什么').querySelector('textarea');market.value='演示：用户修订后的市场预期，仍待独立核验。';market.dispatchEvent(new Event('input',{bubbles:true}));label('我已核对勾选字段').querySelector('input').checked=true;form.requestSubmit()})()`);
    await waitFor(`document.querySelector('#research-detail').textContent.includes('AI 更新草案 · 0 条待确认')`, "confirmed proposal adoption");
    current = (await store.snapshot()).theses[0];
    assert.equal(current.versions.length, 2);
    assert.equal(current.versions[1].fields.myView, originalVersion.fields.myView, "null AI myView never erases the original judgment");
    assert.equal(current.versions[1].fields.marketBelief, "演示：用户修订后的市场预期，仍待独立核验。");
    assert.equal(current.evidence.length, 2);
    assert.equal(current.evidence[1].provenance, "ai_accepted_unverified");
    assert.equal(current.evidence[1].acceptance.acceptedByUser, true);
    assert.equal(current.evidence[1].knownAtVerified, false);
    assert.equal(current.evidence[1].pointInTimeEligible, false);
    assert.deepEqual(current.versions[0], originalVersion);
    assert.match(await js(`document.querySelector('#research-detail').textContent`), /用户确认纳入 AI 来源 · 仍未独立核验/);

    await js(`(()=>{const form=[...document.querySelectorAll('#research-detail form')].find(item=>item.textContent.includes('确认关联'));form.querySelector('select').value='synthetic-cycle';form.querySelector('input[type=checkbox]').checked=true;form.requestSubmit()})()`);
    await waitFor(`document.querySelector('#research-detail').textContent.includes('打开原复盘周期')`, "confirmed review association");
    current = (await store.snapshot()).theses[0];
    assert.equal(current.reviewLinks.length, 1);
    assert.equal(current.reviewLinks[0].cycleId, cycle.id);
    assert.equal(current.reviewLinks[0].accountScopeId, accountScopeId);
    assert.equal(current.reviewLinks[0].thesisVersion, 2);
    assert.equal(current.reviewLinks[0].contextSnapshot.version, 2);
    assert.equal(current.reviewLinks[0].interpretation, "supplementary_recorded_judgment_not_ex_ante_baseline");
    await clickText("打开原复盘周期");
    await waitFor(`document.querySelector('#review-cycle-detail-title').textContent==='演示标的 · 选定订单周期'`, "original linked cycle");
    assert.equal(reviewSnapshotReads, 1);
    await js(`document.querySelector('#review-tab-research').click();document.querySelector('#research-list button').click()`); await pause();
    assert.equal(await js(`document.querySelector('#review-panel-research').hidden`), false);
    const dimensions = await js(`(()=>{const panel=document.querySelector('#review-panel-research'),detail=document.querySelector('.research-detail-scroll');return {panelFits:panel.scrollWidth<=panel.clientWidth,detailFits:detail.scrollWidth<=detail.clientWidth,detailScrolls:detail.scrollHeight>detail.clientHeight,rootFits:document.documentElement.scrollWidth<=innerWidth}})()`);
    assert.equal(dimensions.panelFits, true);
    assert.equal(dimensions.detailFits, true);
    assert.equal(dimensions.detailScrolls, true, "long thesis/history scroll independently");
    assert.equal(dimensions.rootFits, true);
    const filterLayout = await js(`(()=>{const boxes=[...document.querySelectorAll('.research-list-controls input[type=checkbox]')];return boxes.map(input=>({width:input.getBoundingClientRect().width,height:input.getBoundingClientRect().height,labelHeight:input.closest('label').getBoundingClientRect().height,whiteSpace:getComputedStyle(input.closest('label')).whiteSpace}))})()`);
    assert.ok(filterLayout.every(item => item.width <= 18 && item.height <= 18 && item.labelHeight <= 24 && item.whiteSpace === "nowrap"), "sidebar checkboxes keep native compact size and one-line labels despite inherited review input styles");
    fs.writeFileSync(path.join(output, "research-mainline.png"), (await win.webContents.capturePage()).toPNG());
    win.setSize(980, 860); await pause();
    assert.equal(await js(`document.querySelector('#review-panel-research').scrollWidth<=document.querySelector('#review-panel-research').clientWidth`), true, "research panel fits compact width");
    fs.writeFileSync(path.join(output, "research-compact.png"), (await win.webContents.capturePage()).toPNG());
    win.setSize(1480, 960); await pause();
    assert.deepEqual(errors, [], "renderer must not emit console errors");
    assert.equal(blockedNetworkRequests, 0, "synthetic renderer never even attempts outside network");
    const report = { schemaVersion: "research-ui-smoke/v1", syntheticOnly: true, memoryStoreOnly: true, realAccountAccess: false, realModelCalls: 0, realHarnessStarts: 0, blockedNetworkRequests, snapshotReads, reviewSnapshotReads, syntheticSessionCreates: sessions.length, syntheticRuns: runs.length, thesisId, judgmentVersions: current.versions.length, evidenceRecords: current.evidence.length, reviewLinks: current.reviewLinks.length, checks: ["lazy research only", "one-line create", "numeric zero with complete units", "one persistent synthetic session/run", "result recovered and operation settled", "null field never clears original", "AI source opt-in and provenance", "explicit edited adoption", "exact current-account cycle link", "original cycle navigation", "independent vertical scrolling", "compact width without horizontal overflow"], interactive, screenshots: ["research-mainline.png", "research-compact.png"] };
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ output, ...report }) + "\n");
    if (interactive) {
      win.setTitle("交易驾驶舱 · 研究主线隔离验收 · 无真实账户");
      win.on("page-title-updated", (event) => event.preventDefault());
      win.on("closed", () => electron.app.quit());
      win.show(); win.focus();
      process.stdout.write("Interactive acceptance ready. Synthetic data only; no broker, network or model. Close this window to exit.\n");
    } else { win.destroy(); electron.app.quit(); }
  }).catch((error) => { process.stderr.write(error.stack + "\n"); electron.app.exit(1); });
}
