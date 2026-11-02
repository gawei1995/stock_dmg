// Isolated renderer only. No real profile, broker, TradingView or Codex calls.
const electron = require("electron");
if (process.type === "renderer") {
  const noop = () => {};
  const listen = (name) => (callback) => electron.ipcRenderer.on(name, (_event, value) => callback(value));
  electron.contextBridge.exposeInMainWorld("cockpit", {
    getInitialState: () => electron.ipcRenderer.invoke("fixture:initial"),
    getAgentCapabilities: async () => ({ skills: [], tools: [], apps: [] }),
    agentSessions: { list: async () => ({ sessions: [] }) },
    workspace: { setMode: async () => ({ ok: true }) },
    reviewArchiveLedger: (request) => electron.ipcRenderer.invoke("fixture:archive-ledger", request),
    technicalRadar: { snapshot: async () => ({ radar: {} }) },
    review: {
      snapshot: (request) => electron.ipcRenderer.invoke("fixture:snapshot", request),
      intakeSnapshot: (request) => electron.ipcRenderer.invoke("fixture:intake", request),
      previewCaseMigration: (request) => electron.ipcRenderer.invoke("fixture:migration-preview", request),
      migrateCase: (request) => electron.ipcRenderer.invoke("fixture:migrate", request),
    },
    tv: { setBounds: noop }, openExternal: noop,
    onStatus: listen("fixture:status"), onReviewSnapshotUpdated: listen("fixture:ledger"),
    onAgentResult: listen("fixture:agent-result"),
    onRequestTvBounds: noop, onPortfolio: noop, onBrokers: noop, onAgentCapabilities: noop,
    onAgentStream: noop, onTechnicalRadar: noop, onTvState: noop,
  });
} else {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), assert = require("node:assert/strict");
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-review-stability-"));
  electron.app.setPath("userData", path.join(output, "profile"));
  electron.app.whenReady().then(async () => {
    const intake = { records: [], eventCandidates: [], totalRecordCount: 0, nextOffset: null };
    const protocol = (id, status) => ({ id, testKind: "protocol", protocolRevision: 1, ruleId: `rule-${id}`,
      title: id, hypothesis: "可证伪的观察假设", status, primaryMetric: "net_r", minimumCases: 20,
      successOperator: "gt", successThreshold: 0, successCriteria: "净 R 大于零", registeredAt: "2026-09-01T00:00:00Z", samples: [] });
    const snapshot = { accountScopeId: "account-A", snapshotUpdateSequence: 1,
      cases: [], cycles: [], tests: [protocol("observing", "collecting"), protocol("deciding", "decision_due")],
      rules: ["observing", "deciding"].map((id) => ({ id: `rule-${id}`, title: `规则 ${id}`, status: "testing", condition: "条件", action: "动作", falsification: "失效" })),
      reviews: [], ruleMetrics: {}, validationCandidates: { observing: [], deciding: [] }, intake,
      portfolioSnapshots: { status: "empty", snapshotCount: 0, latest: null, warnings: [] }, summary: {} };
    let summaryCalls = 0, intakeCalls = 0, releaseRead = null, delayed = false;
    let migrationPreviews = 0, migrationWrites = 0;
    const archiveCalls = [];
    let archiveReply = { ok: true, canceled: true }, archiveDelayed = false, releaseArchive = null;
    electron.ipcMain.handle("fixture:initial", () => ({ portfolio: null, codex: { available: false }, longbridge: { connected: true }, storage: { encrypted: true, state: "healthy" } }));
    electron.ipcMain.handle("fixture:snapshot", async () => {
      summaryCalls++;
      const result = structuredClone(snapshot);
      if (delayed) await new Promise((resolve) => { releaseRead = resolve; });
      return result;
    });
    electron.ipcMain.handle("fixture:intake", () => { intakeCalls++; return { ok: true, accountScopeId: snapshot.accountScopeId, intake }; });
    electron.ipcMain.handle("fixture:archive-ledger", async (_event, request) => {
      archiveCalls.push(request);
      if (archiveDelayed) await new Promise(resolve => { releaseArchive = resolve; });
      return archiveReply;
    });
    electron.ipcMain.handle("fixture:migration-preview", (_event, request) => {
      assert.equal(request.caseId, "legacy-a"); migrationPreviews++;
      return { ok: true, preview: { sourceCaseId: "legacy-a", sourceHash: "a".repeat(64), title: "历史案例迁移", cycleType: "catalyst", symbols: ["AAPL.US"],
        startAt: "2026-08-01T14:00:00Z", endAt: "2026-08-03T21:00:00Z", recordCount: 2, orderCount: 2, executionCount: 0,
        limitations: ["旧判断不作为新事前封存"], existingCycleId: snapshot.cycles[0]?.id ?? null } };
    });
    electron.ipcMain.handle("fixture:migrate", (_event, request) => {
      assert.equal(request.caseId, "legacy-a"); assert.equal(request.confirmed, true); assert.equal(request.sourceHash, "a".repeat(64)); migrationWrites++;
      const cycle = { id: "migrated-cycle", cycleType: "catalyst", reviewMode: "lightweight", title: "历史案例迁移", status: "draft", symbols: ["AAPL.US"], scope: "single_symbol",
        startAt: "2026-08-01T14:00:00Z", endAt: "2026-08-03T21:00:00Z", retrospectiveDraft: { recalledJudgment: "历史原文" }, brokerLinks: { orderIds: ["buy", "sell"], executionIds: [] } };
      snapshot.cycles = [cycle];
      return { ok: true, cycle, created: true, snapshot: structuredClone(snapshot) };
    });
    const win = new electron.BrowserWindow({ show: false, width: 1480, height: 940, webPreferences: { preload: __filename, sandbox: false, contextIsolation: true, nodeIntegration: false } });
    const errors = [];
    win.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
    const js = (source) => win.webContents.executeJavaScript(source);
    const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
    const rendererDirectory = process.argv[2] || path.join(__dirname, "../renderer");
    await win.loadFile(path.join(rendererDirectory, "index.html")); await pause();
    win.webContents.send("fixture:status", { state: "technical_radar_ready", message: "雷达完成" }); await pause();
    assert.equal(await js(`document.querySelector('#connect-button').textContent`), "长桥已连接");
    win.webContents.send("fixture:status", { domain: "longbridge", state: "reauth_required" });
    win.webContents.send("fixture:status", { domain: "snapshot", state: "snapshot_gap" }); await pause();
    assert.equal(await js(`document.querySelector('#connect-button').textContent`), "升级只读授权");
    await js(`document.querySelector('#workspace-review').click()`); await pause();
    assert.equal(summaryCalls, 1); assert.equal(intakeCalls, 0, "full entry must not trigger a second whole snapshot");
    await js(`document.querySelector('#review-tab-tests').click();
      document.querySelector('[data-test-card-id="observing"] [data-test-result-notes]').value='我的未提交观察';
      document.querySelector('[data-test-card-id="deciding"] .review-validation-v2').open=true;
      document.querySelector('[data-test-card-id="deciding"] [data-v2-title]').value='未提交的第二版';`);
    await js(`document.querySelector('#workspace-cockpit').click()`); await pause();
    await js(`document.querySelector('#workspace-review').click()`); await pause();
    assert.equal(await js(`document.querySelector('[data-test-result-notes]').value`), "我的未提交观察");
    assert.equal(await js(`document.querySelector('[data-v2-title]').value`), "未提交的第二版");
    assert.equal(await js(`document.querySelector('.review-validation-v2').open`), true);
    await js(`globalThis.draftNode = document.querySelector('[data-test-result-notes]')`);
    snapshot.snapshotUpdateSequence = 2;
    snapshot.portfolioSnapshots = { status: "available", snapshotCount: 7, latest: { capturedAt: "2026-09-17T20:20:00Z", valuationSession: "regular_close" }, warnings: [] };
    win.webContents.send("fixture:ledger", { accountScopeId: "account-A", snapshotUpdateSequence: 2, portfolioSnapshots: snapshot.portfolioSnapshots }); await pause();
    assert.match(await js(`document.querySelector('#review-snapshot-ledger-status').textContent`), /组合历史 7 个/);
    assert.equal(await js(`globalThis.draftNode === document.querySelector('[data-test-result-notes]')`), true, "metadata update must not rebuild form DOM");
    const beforePagination = summaryCalls;
    await js(`document.querySelector('#review-intake-search').value='AAPL';document.querySelector('#review-intake-search').dispatchEvent(new Event('input',{bubbles:true}))`); await pause(400);
    assert.equal(intakeCalls, 1); assert.equal(summaryCalls, beforePagination);
    delayed = true;
    await js(`document.querySelector('#workspace-cockpit').click()`); await pause();
    await js(`document.querySelector('#workspace-review').click()`); await pause();
    assert.ok(releaseRead);
    await js(`document.querySelector('#workspace-cockpit').click()`); await pause();
    assert.equal(await js(`document.body.dataset.workspaceMode`), "cockpit", "slow history reads must not prevent returning to TV");
    delayed = false; releaseRead(); await pause();
    await js(`document.querySelector('#workspace-review').click()`); await pause();
    snapshot.accountScopeId = "account-B"; snapshot.snapshotUpdateSequence = 3;
    win.webContents.send("fixture:ledger", { accountScopeId: "account-B", snapshotUpdateSequence: 3, portfolioSnapshots: snapshot.portfolioSnapshots }); await pause();
    assert.equal(await js(`document.querySelector('[data-test-result-notes]').value`), "", "account A drafts must not leak into B");
    assert.notEqual(await js(`document.querySelector('[data-v2-title]').value`), "未提交的第二版");
    await js(`document.querySelector('[data-test-result-notes]').value='B的旧协议草稿'`);
    snapshot.tests[0].protocolRevision = 2;
    await js(`document.querySelector('#workspace-cockpit').click()`); await pause();
    await js(`document.querySelector('#workspace-review').click()`); await pause();
    assert.equal(await js(`document.querySelector('[data-test-result-notes]').value`), "", "new protocol revision cannot inherit prior inputs");
    win.webContents.send("fixture:status", { domain: "storage", state: "storage_degraded", storage: { encrypted: true, state: "degraded", stores: [{ file: "review.bin", state: "degraded", errorCode: "STORAGE_WRITE_FAILED" }] } }); await pause();
    assert.match(await js(`document.querySelector('#storage-chip').title`), /review.bin.*STORAGE_WRITE_FAILED/);
    assert.equal(await js(`document.querySelector('#connect-button').textContent`), "升级只读授权");
    await js(`state.activeSessionId='thread-1';state.agentSessions=[{id:'thread-1'}];state.operations.set('op-1',{operationId:'op-1',threadId:'thread-1',finalText:'旧预览'});`);
    win.webContents.send("fixture:agent-result", { error: "读取未完成", errorCode: "history_incomplete", operationId: "op-1", threadId: "thread-1", partialText: "已经取回的部分正文", complete: false, partial: true }); await pause();
    assert.match(await js(`document.querySelector('[data-partial="true"]').textContent`), /历史正文尚未完整取回.*已经取回的部分正文/s);
    assert.equal(await js(`document.querySelectorAll('[data-partial="true"] [data-save-plan]').length`), 0);
    assert.equal(await js(`state.operations.size`), 0);
    snapshot.cases = [{ id: "legacy-a", symbol: "AAPL.US", fiscalQuarter: "FY2026 Q3", eventAt: "2026-08-01T20:00:00Z", status: "draft", exAnteDraft: { myView: "历史原文" }, brokerLinks: { orderIds: ["buy", "sell"] } }];
    await js(`document.querySelector('#workspace-cockpit').click()`); await pause();
    await js(`document.querySelector('#workspace-review').click()`); await pause();
    await js(`document.querySelector('#review-tab-cases').click();document.querySelector('#review-show-cases').click();document.querySelector('[data-review-case-id="legacy-a"]').click()`); await pause();
    assert.equal(await js(`document.querySelector('#review-case-form textarea').readOnly`), true);
    assert.equal(await js(`document.querySelector('#review-save-case').hidden`), true);
    await js(`document.querySelector('#review-case-migrate-preview').click()`); await pause();
    assert.equal(migrationPreviews, 1); assert.equal(migrationWrites, 0);
    assert.match(await js(`document.querySelector('#review-case-migration').textContent`), /旧判断不作为新事前封存/);
    await js(`document.querySelector('#review-case-migrate-confirm').click()`); await pause();
    assert.equal(migrationWrites, 1);
    assert.equal(snapshot.cases[0].exAnteDraft.myView, "历史原文");
    assert.match(await js(`document.querySelector('#review-cycle-detail-title').textContent`), /历史案例迁移/);
    const cycle = snapshot.cycles[0];
    cycle.evidenceRevision = 2;
    cycle.brokerLinks = { ...cycle.brokerLinks, accountScopeId: "account-B", evidenceRevision: 2 };
    cycle.retrospectiveVersions = [{ version: 1, integrityStatus: "valid", savedAt: "2026-08-04T00:00:00Z", snapshot: { recalledJudgment: "原始判断", lesson: "复盘感悟", forwardHypothesis: "待验证的假设" } }];
    const reconciliationKeys = ["openingInventory", "closingInventory", "closingPrices", "netAssetEndpoints", "externalFlows", "fees", "taxes", "corporateActions", "fx", "qqqBenchmark"];
    const reconciliation = { schemaVersion: "review-reconciliation/v1", cycleId: cycle.id, cycleEvidenceRevision: 2,
      accountScopeId: "account-B", window: { startAt: cycle.startAt, endAt: cycle.endAt }, evidenceHash: "d".repeat(64), status: "partial",
      projection: { kind: "metadata_only", fullEvidenceIncluded: false },
      fields: Object.fromEntries(reconciliationKeys.map((key, index) => [key, {
        status: index === 5 ? "reconciled" : index === 4 ? "missing" : "partial", sourceVerificationStatus: index === 4 ? "unverified" : "verified",
        verificationStatus: index === 5 ? "verified" : "unverified", evidenceHash: "e".repeat(64),
        reasons: index === 0 ? ["regular_close_v2_prices_only_inventory_and_cash_unreconciled"] : ["source_missing"],
        source: index === 4 ? [] : [{ id: `source-${index}`, hash: "f".repeat(64), kind: "snapshot_ledger", observedAt: cycle.endAt }],
        projection: { kind: "metadata_only", sourceCount: index === 0 ? 3 : 1, omittedSourceCount: index === 0 ? 2 : 0,
          reasonCount: index === 0 ? 4 : 1, omittedReasonCount: index === 0 ? 3 : 0 },
      }])) };
    cycle.phaseRuns = { retrospective: [{ id: "c4-persisted", status: "completed", integrityStatus: "valid", evidenceRevision: 2,
      retrospectiveVersion: 1, completedAt: "2026-08-04T00:00:00Z", evidenceFilterPolicyVersion: 2, result: { reconciliation } }], outcome: [] };
    snapshot.snapshotUpdateSequence += 1;
    await js(`document.querySelector('#workspace-cockpit').click()`); await pause();
    await js(`document.querySelector('#workspace-review').click()`); await pause();
    assert.equal(await js(`document.querySelectorAll('#review-cycle-reconciliation-fields > div').length`), 10);
    assert.equal(await js(`document.querySelector('#review-cycle-reconciliation-status').textContent`), "仍有缺口");
    assert.equal(await js(`document.querySelectorAll('#review-cycle-reconciliation-fields details[open]').length`), 0);
    await js(`document.querySelector('#review-cycle-reconciliation-fields summary').click()`); await pause();
    assert.equal(await js(`document.querySelector('#review-cycle-reconciliation-fields details').open`), true);
    const reconciliationText = await js(`document.querySelector('#review-cycle-reconciliation-fields').textContent`);
    assert.match(reconciliationText, /仅按收盘价重估/);
    assert.match(reconciliationText, /另有 3 项未展开/);
    assert.match(reconciliationText, /另有 2 项来源引用未展开/);
    assert.doesNotMatch(reconciliationText, /regular_close_v2|source_missing/);
    assert.equal(await js(`document.body.dataset.workspaceMode`), "review");
    assert.equal(await js(`document.querySelector('#review-workspace').hidden`), false);
    // A hidden macOS window may keep an earlier compositor frame. Show only
    // this isolated fixture (no network/native TV) for a genuine visual check.
    win.showInactive(); await pause(150);
    await js(`document.querySelector('#review-cycle-reconciliation').scrollIntoView({block:'center'})`); await pause();
    fs.writeFileSync(path.join(output, "c4-reconciliation.png"), (await win.webContents.capturePage()).toPNG());
    await js(`document.querySelector('#review-cycle-reconciliation-fields summary').click()`); await pause();
    assert.equal(await js(`document.querySelector('#review-cycle-reconciliation-fields details').open`), false);
    // The original result remains in history, but a new boxed-order revision
    // must remove it from the current evidence panel immediately after reload.
    cycle.evidenceRevision = 3;
    cycle.brokerLinks.evidenceRevision = 3;
    snapshot.snapshotUpdateSequence += 1;
    await js(`document.querySelector('#workspace-cockpit').click()`); await pause();
    await js(`document.querySelector('#workspace-review').click()`); await pause();
    assert.equal(cycle.phaseRuns.retrospective.length, 1);
    assert.equal(await js(`document.querySelectorAll('#review-cycle-reconciliation-fields > div').length`), 0);
    assert.equal(await js(`document.querySelector('#review-cycle-reconciliation-status').textContent`), "待复盘 / 待重跑");
    assert.match(await js(`document.querySelector('#review-cycle-reconciliation-note').textContent`), /尚无当前订单版本/);
    assert.equal(archiveCalls.length, 0, "opening or refreshing review must never archive automatically");
    assert.equal(await js(`document.querySelector('#review-ledger-archive').open`), false);
    assert.equal(await js(`document.querySelector('#review-archive-portfolio-retain').value`), "500");
    assert.equal(await js(`document.querySelector('#review-archive-radar-retain').value`), "60");
    await js(`document.querySelector('#review-ledger-archive summary').click();
      globalThis.archiveDraftNode = document.querySelector('#review-cycle-retrospective-form textarea');
      globalThis.archiveDraftNode.value = '归档时保留的未提交复盘';
      globalThis.archiveDraftNode.dispatchEvent(new Event('input', { bubbles:true }));`);
    const archiveSubmit = (kind) => js(`document.querySelector('[data-ledger-archive-kind="${kind}"]').dispatchEvent(new Event('submit', { bubbles:true, cancelable:true }))`);
    for (const invalid of ["0", "1.5", ""]) {
      await js(`document.querySelector('#review-archive-portfolio-retain').value=${JSON.stringify(invalid)}`);
      await archiveSubmit("portfolio"); await pause();
      assert.equal(archiveCalls.length, 0);
      assert.equal(await js(`document.querySelector('#review-ledger-archive-status').dataset.tone`), "error");
    }
    await js(`document.querySelector('#review-archive-portfolio-retain').value='275';document.querySelector('#review-archive-radar-retain').value='9'`);
    archiveDelayed = true;
    await archiveSubmit("portfolio"); await pause();
    await archiveSubmit("portfolio"); await archiveSubmit("radar"); await pause();
    assert.equal(archiveCalls.length, 1, "pending native preview must suppress same-kind and cross-kind reentry");
    assert.deepEqual(archiveCalls[0], { kind: "portfolio", retainActiveCount: 275 });
    assert.equal(await js(`document.querySelectorAll('#review-ledger-archive input:disabled, #review-ledger-archive button:disabled').length`), 4);
    assert.equal(await js(`document.querySelector('#review-restore-backup').disabled`), true);
    snapshot.snapshotUpdateSequence += 1;
    win.webContents.send("fixture:ledger", { accountScopeId: "account-B", snapshotUpdateSequence: snapshot.snapshotUpdateSequence, portfolioSnapshots: snapshot.portfolioSnapshots }); await pause();
    assert.equal(await js(`document.querySelector('#review-archive-portfolio-retain').disabled`), true);
    assert.equal(await js(`globalThis.archiveDraftNode === document.querySelector('#review-cycle-retrospective-form textarea')`), true);
    releaseArchive(); archiveDelayed = false; await pause();
    assert.equal(await js(`document.querySelector('#review-ledger-archive-status').dataset.tone`), "info");
    assert.match(await js(`document.querySelector('#review-ledger-archive-status').textContent`), /已取消.*保持不变/);
    assert.equal(await js(`document.querySelectorAll('#review-ledger-archive input:disabled, #review-ledger-archive button:disabled').length`), 0);
    archiveReply = { ok: false, message: "隔离测试：磁盘空间不足" };
    await archiveSubmit("radar"); await pause();
    assert.equal(archiveCalls.length, 2);
    assert.deepEqual(archiveCalls[1], { kind: "radar", retainActiveCount: 9 });
    assert.equal(await js(`document.querySelector('#review-ledger-archive-status').dataset.tone`), "error");
    assert.match(await js(`document.querySelector('#review-ledger-archive-status').textContent`), /归档未确认.*磁盘空间不足/);
    assert.equal(await js(`document.querySelector('#review-archive-radar-retain').disabled`), false);
    archiveReply = { ok: true, archived: false, message: "无需归档：当前追加区只有 8 条记录" };
    await archiveSubmit("radar"); await pause();
    assert.equal(await js(`document.querySelector('#review-ledger-archive-status').dataset.tone`), "info");
    assert.match(await js(`document.querySelector('#review-ledger-archive-status').textContent`), /无需归档/);
    archiveReply = { ok: true, archived: true, kind: "portfolio", archiveCount: 25, activeCount: 275, archivedCount: 100, totalCount: 375 };
    await archiveSubmit("portfolio"); await pause();
    assert.equal(await js(`document.querySelector('#review-ledger-archive-status').dataset.tone`), "success");
    assert.match(await js(`document.querySelector('#review-ledger-archive-status').textContent`), /本次归档 25 条.*当前追加区 275 条.*累计历史 100 条.*共 375 条/);
    assert.equal(await js(`document.querySelector('#review-archive-portfolio-retain').value`), "275");
    assert.equal(await js(`document.querySelector('#review-archive-radar-retain').value`), "9");
    assert.equal(await js(`globalThis.archiveDraftNode === document.querySelector('#review-cycle-retrospective-form textarea')`), true);
    assert.equal(await js(`globalThis.archiveDraftNode.value`), "归档时保留的未提交复盘");
    await js(`document.querySelector('#review-ledger-archive').scrollIntoView({block:'center'})`); await pause();
    fs.writeFileSync(path.join(output, "c3-ledger-archive.png"), (await win.webContents.capturePage()).toPNG());
    await js(`document.querySelector('#workspace-cockpit').click()`); await pause();
    await js(`document.querySelector('#workspace-review').click()`); await pause();
    assert.equal(await js(`document.querySelector('#review-ledger-archive').open`), true);
    assert.equal(await js(`document.querySelector('#review-archive-portfolio-retain').value`), "275", "refresh cannot reset archive preferences");
    assert.equal(await js(`document.querySelector('#review-cycle-retrospective-form textarea').value`), "归档时保留的未提交复盘");
    assert.equal(archiveCalls.length, 4, "refresh must not repeat the last archive action");
    await js(`window.location.hash='#/review/rules'`); await pause();
    assert.equal(await js(`window.location.hash`), "#/review/tests");
    assert.deepEqual(errors, []);
    process.stdout.write(JSON.stringify({ output, summaryCalls, intakeCalls, migrationPreviews, migrationWrites, archiveCalls, checks: "status domains / ledger events / single summary / drafts / account isolation / TV navigation / partial result / explicit migration / reconciliation 10 fields + native details + stale revision / archive validation + reentry + cancel + error + no-op + success + drafts / legacy deep link PASS" }) + "\n");
    win.destroy(); electron.app.quit();
  }).catch((error) => { process.stderr.write(error.stack + "\n"); electron.app.exit(1); });
}
