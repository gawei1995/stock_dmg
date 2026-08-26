import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rendererUrl = new URL("../renderer/", import.meta.url);

async function source(name) {
  return readFile(new URL(name, rendererUrl), "utf8");
}

test("review workspace is a same-window flow with cycle review plus four learning stages", async () => {
  const [html, css] = await Promise.all([
    source("index.html"),
    source("review.css"),
  ]);

  assert.match(html, /id="workspace-cockpit"[^>]*data-workspace-mode="cockpit"/);
  assert.match(html, /id="workspace-review"[^>]*data-workspace-mode="review"/);
  assert.match(html, /id="review-workspace"[^>]*hidden/);
  for (const tab of ["cycles", "cases", "tests", "rules", "governance"]) {
    assert.match(html, new RegExp(`data-review-tab="${tab}"`));
    assert.match(html, new RegExp(`id="review-panel-${tab}"`));
  }
  assert.match(html, /案例复盘/);
  assert.match(html, />验证中心\s*</);
  assert.match(html, />候选规则\s*</);
  assert.match(html, />人工确认\s*</);
  assert.match(html, /href="\.\/review\.css"/);
  assert.match(html, /src="\.\/review\.js"/);
  assert.match(css, /\.review-workspace[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\.review-panel[\s\S]*overflow:\s*auto/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test("review cycles expose rigorous and order-first workflows with conditional inputs and durable host actions", async () => {
  const [html, script, css] = await Promise.all([
    source("index.html"),
    source("review.js"),
    source("review.css"),
  ]);

  for (const id of [
    "review-cycle-form",
    "review-cycle-list",
    "review-cycle-detail",
    "review-cycle-ex-ante-form",
    "review-cycle-link-records",
    "review-cycle-checkpoint-form",
    "review-cycle-close-form",
    "review-cycle-retrospective-form",
    "review-cycle-recalled-judgment",
    "review-cycle-lesson",
    "review-cycle-forward-hypothesis",
    "review-order-first-note-dialog",
    "review-order-first-note-form",
    "review-order-first-recalled-judgment",
    "review-order-first-lesson",
    "review-order-first-forward-hypothesis",
    "review-cycle-trade-path",
    "review-cycle-trade-path-anchors",
    "review-cycle-trade-path-summary",
    "review-cycle-trade-path-segments",
  ]) assert.match(html, new RegExp(`id="${id}"`));

  for (const type of ["catalyst", "position_lifecycle", "monthly_portfolio", "trade_window"]) {
    assert.match(html, new RegExp(`(?:value|data-cycle-create-type)="${type}"`));
    assert.match(script, new RegExp(type));
  }
  assert.doesNotMatch(`${html}\n${script}`, /earnings_catalyst/);
  assert.match(html, /财报 \/ 催化剂周期/);
  assert.match(html, /单一持仓生命周期/);
  assert.match(html, /月度组合周期/);
  assert.match(html, /data-cycle-types="catalyst,position_lifecycle,trade_window"/);
  assert.match(html, /data-cycle-types="monthly_portfolio"/);
  assert.match(script, /function updateCycleTypeFields\(\)/);
  assert.match(script, /elements\.cycleEventAt\.required = type === "catalyst"/);
  assert.match(script, /elements\.cycleMonth\.required = type === "monthly_portfolio"/);
  assert.match(script, /zonedLocalMidnightUtc/);
  assert.match(script, /timezone: type === "monthly_portfolio" \? "America\/New_York"/);
  assert.match(script, /cycles:\s*arrayValue\(source\.cycles, source\.reviewCycles, source\.decisionCycles\)/);
  assert.match(script, /cycles:\s*\[\], cases:\s*\[\]/);
  for (const method of ["createCycle", "createOrderFirstCycle", "updateCycle", "saveCycleRetrospectiveNote", "sealCycle", "linkCycleRecords", "addCycleCheckpoint"]) {
    assert.match(script, new RegExp(`callReview\\("${method}"`));
  }
  assert.match(script, /cycleRangeLabel/);
  assert.match(script, /const declaredMonth = String\(item\?\.month/);
  assert.match(script, /timeZone: item\?\.timezone \|\| "Asia\/Shanghai"/);
  assert.match(script, /cycleEvidenceCounts/);
  assert.match(script, /function closePositionCycle/);
  assert.match(script, /patch:\s*\{ endAt \}/);
  assert.match(script, /saveSelectedCycleRetrospectiveNote/);
  assert.match(script, /function openOrderFirstNoteDialog/);
  assert.match(script, /function confirmOrderFirstCycle/);
  assert.match(script, /createOrderFirstCycle", \{ \.\.\.request, retrospectiveNote \}/);
  assert.match(script, /function cyclePhaseComplete/);
  assert.match(script, /Number\(run\?\.retrospectiveVersion\) === currentVersion/);
  assert.match(script, /Number\(run\?\.evidenceRevision\) === currentEvidenceRevision/);
  assert.match(script, /未来预判从本次保存时刻起生效/);
  assert.match(script, /api\.onAgentResult\?\.\(\(envelope\) => captureCycleTradePathResult\(envelope\)\)/);
  assert.match(script, /function renderCycleTradePath\(item\)/);
  assert.match(script, /function persistedCycleTradePathResult\(item, currentEvidenceRevision\)/);
  assert.match(script, /run\?\.result\?\.tradePricePathSummary/);
  assert.match(script, /run\?\.integrityStatus === "valid"/);
  assert.match(script, /path\?\.window\?\.startActivityId/);
  assert.match(script, /path\?\.positionStatus === "partially_closed"/);
  assert.match(script, /boundedUiSequence\(segments, 36\)/);
  assert.match(script, /旧路径不再展示；按最新框选重新复盘后生成新路径/);
  assert.doesNotMatch(script, /if \(created\) prepareCycleAnalysis\("retrospective"\)/);
  assert.match(script, /订单 · \$\{counts\.executions\} 成交 · \$\{counts\.checkpoints\} 检查点/);
  assert.match(css, /\.review-cycle-panel[\s\S]{0,150}grid-template-columns/);
  assert.match(css, /\.review-cycle-type-cards[\s\S]{0,150}repeat\(3/);
  assert.match(css, /\.review-trade-path-anchors/);
  assert.match(css, /\.review-trade-path-segments/);
});

test("order-first review is available from both the cycle landing page and the selected-order intake", async () => {
  const [html, script, preload, main] = await Promise.all([
    source("index.html"),
    source("review.js"),
    source("../preload.cjs"),
    source("../main.mjs"),
  ]);
  for (const id of [
    "review-quick-month-form",
    "review-quick-month-retrospective",
    "review-quick-month-rigorous",
    "review-quick-single-create",
    "review-intake-trade-review",
    "review-cycle-analyze-retrospective",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(script, /function createQuickMonthly/);
  assert.match(script, /function createQuickSingle/);
  assert.match(script, /createOrderFirstCycle/);
  assert.match(script, /reviewPhase === "retrospective"/);
  assert.match(preload, /review:cycle:create-order-first/);
  assert.match(main, /review:cycle:create-order-first/);
  assert.match(main, /reviewCycleStore\.createLinkedCycle/);
  assert.match(main, /retrospectiveNote: cycleInput\.reviewMode === "lightweight"/);
  assert.match(main, /type:\s*"trade_window"/);
  assert.match(main, /reviewMonthRange/);
  assert.match(script, /timezone: "America\/New_York"/);
  assert.match(main, /cycleKind === "monthly_portfolio" && !replace[\s\S]{0,100}\? \[\]/);
  assert.match(script, /const monthly = cycleType\(item\) === "monthly_portfolio";[\s\S]{0,120}const recordIds = monthly \? \[\]/);
  assert.match(script, /"自动关联整月交易"/);
});

test("portfolio history can be captured manually and exposes encrypted ledger status", async () => {
  const [html, script, preload, main] = await Promise.all([
    source("index.html"),
    source("review.js"),
    source("../preload.cjs"),
    source("../main.mjs"),
  ]);
  assert.match(html, /id="review-capture-snapshot"/);
  assert.match(html, /id="review-snapshot-ledger-status"/);
  assert.match(script, /capturePortfolioSnapshot/);
  assert.match(preload, /review:portfolio-snapshot:capture/);
  assert.match(main, /new PortfolioSnapshotStore/);
  assert.match(main, /review:portfolio-snapshot:capture/);
  assert.match(main, /scheduleFreshPortfolioEvidence/);
  assert.match(main, /requiresAppRunning: true/);
  assert.match(main, /missedDayBackfill: false/);
  assert.match(main, /summarizeTradePricePath/);
  assert.match(main, /tradePricePathSummary:/);
  assert.match(script, /本地账户范围/);
  assert.match(script, /切换券商账户前请先清除长桥授权/);
  assert.match(script, /关闭应用期间不会运行/);
  assert.match(script, /自动捕获未连接/);
  assert.match(script, /今日重估已确认/);
  assert.match(script, /收盘重估等待重试/);
  assert.match(script, /最后尝试/);
  assert.match(script, /最后成功/);
  assert.match(script, /最近错误/);
  assert.match(script, /不能作为确定性收益端点/);
});

test("cycle review enforces the temporal firewall and dispatches phase preparation only", async () => {
  const [html, script] = await Promise.all([
    source("index.html"),
    source("review.js"),
  ]);

  for (const phrase of [
    "时间防火墙",
    "阶段一 · BLIND",
    "阶段二 · OUTCOME",
    "选择与现有证据匹配的复盘路径",
    "不能用财报结果、后续价格或事后新闻覆盖当时判断",
  ]) assert.match(html, new RegExp(phrase));
  for (const id of ["review-cycle-analyze-blind", "review-cycle-analyze-outcome", "review-cycle-phase-gate"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="review-cycle-analyze-outcome"[^>]*disabled[^>]*title="请先完成阶段一盲态复盘"/);
  assert.match(script, /reviewPhase === "outcome" && !cyclePhaseComplete\(item, "blind"\)/);
  assert.match(script, /reviewPhase === "outcome" && !cycleOutcomeReady\(item\)/);
  assert.match(script, /阶段二尚未解锁：必须先有阶段一完成记录/);
  assert.match(script, /reviewPhase === "blind" && !cycleSealed\(item\)/);
  assert.match(script, /const detail = \{[\s\S]{0,160}cycleId: cycleId\(item\),[\s\S]{0,160}cycleType: cycleType\(item\),[\s\S]{0,160}reviewPhase,[\s\S]{0,160}task/);
  assert.match(script, /new CustomEvent\("cockpit:review-cycle-analysis-prepared", \{ detail \}\)/);
  assert.match(script, /不要读取或推断后续价格、P&L、财报结果与未来新闻/);
  const phaseHandler = script.match(/async function prepareCycleAnalysis\(reviewPhase\) \{[\s\S]+?\n  \}/)?.[0] ?? "";
  assert.match(phaseHandler, /cockpit:review-cycle-analysis-prepared/);
  assert.match(phaseHandler, /cycleType: cycleType\(item\)/);
  assert.match(phaseHandler, /仅在宿主依据关联成交及周期内长桥日线可计算时引用/);
  assert.match(phaseHandler, /saveSelectedCycleRetrospectiveNote/);
  assert.doesNotMatch(phaseHandler, /runAgent|submitAgent/);
});

test("cycle details reuse selected broker history and keep the four ex-ante fields auditable", async () => {
  const [html, script] = await Promise.all([
    source("index.html"),
    source("review.js"),
  ]);

  for (const id of [
    "review-cycle-detail-thesis",
    "review-cycle-detail-market-belief",
    "review-cycle-detail-action",
    "review-cycle-detail-invalidation",
    "review-cycle-detail-fundamental",
    "review-cycle-detail-technical",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /保留你的原话与时间戳/);
  assert.match(html, /不选，让系统按周期时间与标的自动关联/);
  assert.match(html, /月度组合扫描整月账户历史，但未成交和不可核验记录只进入排除审计/);
  assert.match(script, /const recordIds = monthly \? \[\] : \[\.\.\.state\.selectedRecordIds\]/);
  assert.match(script, /fundamentalView:\s*elements\.cycleDetailFundamental/);
  assert.match(script, /technicalView:\s*elements\.cycleDetailTechnical/);
  assert.match(script, /fundamental:\s*elements\.cycleCheckpointFundamental/);
  assert.match(script, /technical:\s*elements\.cycleCheckpointTechnical/);
  assert.match(script, /callReview\("linkCycleRecords", \{ cycleId: cycleId\(item\), recordIds, confirmed: true \}\)/);
  assert.match(script, /requestedRecordIds = arrayValue\(item\?\.brokerLinks\?\.requestedRecordIds\)/);
  assert.match(script, /只预选你上次框选的/);
  assert.doesNotMatch(script, /for \(const record of cycleBrokerRecords\(item\)\) \{[\s\S]{0,160}state\.selectedRecordIds\.add/);
  assert.match(script, /自动关联周期内订单/);
  assert.match(script, /patch: \{ exAnte \}/);
  assert.match(script, /cycleExAnteVersions|cycleExAnte|exAnteVersions/);
  assert.match(script, /elements\.cycleExAnteForm\.querySelectorAll\("textarea"\)/);
  assert.match(script, /field\.disabled = sealed/);
  assert.match(script, /callReview\("addCycleCheckpoint", \{ cycleId: cycleId\(item\), checkpoint \}\)/);
});

test("review UI supports frozen cases, broker confirmation, tests, rules, and governance", async () => {
  const [html, script] = await Promise.all([
    source("index.html"),
    source("review.js"),
  ]);

  for (const id of [
    "review-case-form",
    "review-freeze-case",
    "review-broker-matches",
    "review-link-records",
    "review-edit-broker-links",
    "review-intake-cancel-link-edit",
    "review-test-form",
    "review-test-success-criteria",
    "review-rule-form",
    "review-governance-form",
  ]) assert.match(html, new RegExp(`id="${id}"`));

  assert.match(script, /^\(\(\) => \{[\s\S]*"use strict";/);
  assert.match(script, /api\.workspace\.setMode\(nextMode\)/);
  for (const method of [
    "snapshot",
    "createCase",
    "updateCase",
    "freezeCase",
    "linkBrokerRecords",
    "acceptLearningProposal",
    "archiveValidation",
    "registerTest",
    "completeTest",
    "createRule",
    "transitionRule",
    "addRuleReview",
  ]) assert.match(script, new RegExp(`callReview\\("${method}"`));
  assert.match(script, /const syncMethod = intakeMethod \?\? "syncTradeHistory"/);
  assert.match(script, /callReview\(syncMethod, payload\)/);

  assert.match(script, /CASE_FROZEN_STATES/);
  assert.match(script, /财报前字段不可覆盖/);
  assert.match(script, /自动匹配仅作为候选/);
  assert.match(script, /stripBrokerRecordPrefix/);
  assert.match(script, /function beginCaseLinkEdit/);
  assert.match(script, /function saveCaseLinkEdit/);
  assert.match(script, /replace:\s*true/);
  assert.match(script, /新的关联版本已保存/);
  assert.match(script, /cockpit:review-evidence-revisions/);
  assert.match(script, /function renderLearningProposal/);
  assert.match(html, /开始观察/);
  assert.match(html, /一条验证路径/);
  assert.match(script, /纳入本次验证/);
  assert.match(script, /function validationCandidateCycles/);
  assert.match(script, /待你决策/);
  assert.match(script, /继续观察/);
  assert.match(script, /创建 v2/);
  assert.match(script, /暂行采用/);
  assert.match(script, /未关联观察（不计入独立案例）/);
  assert.match(script, /不开放 PROVISIONAL \/ VALIDATED/);
  assert.match(script, /来源复盘/);
  assert.match(script, /item\.sourceStatus === "stale"/);
  assert.match(script, /`order:\$\{raw\}`/);
  assert.match(script, /`execution:\$\{raw\}`/);
  assert.match(html, /提出修改（仅记录，待另行生成新版本）/);
  assert.match(script, /规则已原子迁移为 RETIRED/);
  assert.match(script, /keep:\s*elements\.governanceKeep/);
  assert.match(script, /change:\s*elements\.governanceChange/);
  assert.match(script, /nextTrigger:\s*elements\.governanceNext/);
  assert.doesNotMatch(script, /window\.(?:reviewState|state)\s*=/);
});

test("history scope upgrade is explicit, read only, and retries the original range once", async () => {
  const [script, main, preload] = await Promise.all([
    source("review.js"),
    readFile(new URL("../main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../preload.cjs", import.meta.url), "utf8"),
  ]);

  assert.match(main, /LONGBRIDGE_HISTORY_SCOPE_REQUIRED/);
  assert.match(main, /LONGBRIDGE_REAUTH_REQUIRED/);
  assert.match(main, /cachePreserved:\s*true/);
  assert.match(main, /REVIEW_SNAPSHOT_FAILED/);
  assert.match(main, /historySynced:\s*true/);
  assert.match(main, /cachePreserved:\s*false/);
  assert.match(main, /buttons:\s*\["取消", "继续只读授权"\]/);
  assert.match(main, /defaultId:\s*0/);
  assert.match(main, /不会申请、开放或调用提交订单、改单、撤单权限/);
  assert.match(preload, /connectLongbridge:\s*\(request\) => ipcRenderer\.invoke\("longbridge:connect", request\)/);
  assert.match(script, /error\.code === "LONGBRIDGE_HISTORY_SCOPE_REQUIRED"/);
  assert.match(script, /error\.code === "LONGBRIDGE_REAUTH_REQUIRED"/);
  assert.match(script, /api\.connectLongbridge\(\{ forceReauthorize: true \}\)/);
  assert.match(script, /Exactly one retry/);
  assert.match(script, /error\.code = result\.errorCode/);
});

test("validation confirmation preserves edited drafts and v2 is atomic in the host", async () => {
  const [script, main, preload] = await Promise.all([
    source("review.js"),
    source("../main.mjs"),
    source("../preload.cjs"),
  ]);
  assert.match(script, /proposal,\s*reviewCycleId/);
  assert.match(main, /proposal: request\?\.proposal \?\? sourceProposal/);
  assert.match(main, /sourceProposal,/);
  assert.match(main, /review:validation:create-version/);
  assert.match(main, /reviewStore\.createValidationVersion\(request\)/);
  assert.match(preload, /createValidationVersion:.*review:validation:create-version/);
});

test("validation center archives observations audibly and consumes host-matched forward or calibration candidates", async () => {
  const [html, script, main, preload] = await Promise.all([
    source("index.html"),
    source("review.js"),
    source("../main.mjs"),
    source("../preload.cjs"),
  ]);
  assert.match(html, /id="review-validation-archive"/);
  assert.match(html, /id="review-archived-test-list"/);
  assert.match(html, /停止观察不会删除假设、来源、样本或操作记录/);
  assert.match(script, /dataset\.archiveValidation/);
  assert.match(script, /window\.confirm/);
  assert.match(script, /callReview\("archiveValidation"/);
  assert.match(script, /validationCandidates/);
  assert.match(script, /历史校准候选/);
  assert.match(script, /不计样本外验证/);
  assert.match(preload, /archiveValidation:.*review:validation:archive/);
  assert.match(main, /review:validation:archive/);
  assert.match(main, /reviewStore\.archiveValidation/);
  assert.match(main, /buildValidationCandidateIndex/);
  assert.match(main, /observationTiming:\s*observation\?\.timing/);
  assert.match(script, /历史\/跨界校准/);
});

test("review analysis reuses the existing Codex operation and recovery harness", async () => {
  const [script, reviewScript] = await Promise.all([
    source("renderer.js"),
    source("review.js"),
  ]);

  assert.match(script, /cockpit:review-analysis-prepared/);
  assert.match(script, /submitPreparedReviewAnalysis/);
  assert.match(script, /startAgentOperation\(\{/);
  assert.match(script, /scope:\s*"review"/);
  assert.match(script, /reviewCaseIds/);
  assert.match(script, /api\.runAgent\(\{/);
  assert.match(script, /scheduleAgentResultRecovery/);
  assert.match(script, /view\.scope = "review"/);
  assert.match(script, /reviewContext/);
  assert.match(script, /state\.analysisScope !== "review" && !state\.portfolio/);
  assert.match(reviewScript, /setTimeout\(\(\) => \{[\s\S]{0,220}cockpit:review-analysis-prepared/);
});

test("a prepared review starts a fresh persistent Codex session while follow-ups reuse it", async () => {
  const script = await source("renderer.js");
  const submitTask = script.match(/async function submitAgentTask\(event\) \{[\s\S]+?\n\}/)?.[0] ?? "";

  assert.match(script, /async function createAgentSession\(\)/);
  assert.match(script, /return createdId \|\| null/);
  assert.match(script, /async function createReviewAgentSession\(\{[\s\S]{0,500}reviewCaseIds = \[\][\s\S]{0,200}\} = \{\}\)/);
  assert.match(script, /const threadId = await createAgentSession\(\)/);
  assert.match(script, /if \(!threadId \|\| String\(state\.activeSessionId \?\? ""\) !== String\(threadId\)\) return null/);
  assert.match(script, /submitPreparedReviewAnalysis[\s\S]{0,1000}await createReviewAgentSession/);
  assert.match(script, /submitPreparedReviewCycleAnalysis[\s\S]{0,1000}await createReviewAgentSession/);
  assert.match(submitTask, /const reviewContext = ensureSessionView\(state\.activeSessionId\)\.reviewContext/);
  assert.match(submitTask, /startAgentOperation\(\{/);
  assert.doesNotMatch(submitTask, /createReviewAgentSession|createAgentSession/);
  assert.match(script, /reviewProtocol:\s*"decision_cycle"/);
  assert.doesNotMatch(script, /if \(!state\.activeSessionId\) await createAgentSession\(\)/);
  assert.match(script, /\$review-earnings-decisions · 独立 Codex 对话/);
  assert.match(script, /\$review-decision-cycles · 独立 Codex 对话/);
});

test("review intake searches the host and paginates beyond the first page", async () => {
  const [html, script] = await Promise.all([
    source("index.html"),
    source("review.js"),
  ]);

  assert.match(html, /id="review-intake-load-more"/);
  assert.match(html, /id="review-intake-page-status"/);
  assert.match(script, /INTAKE_PAGE_LIMIT/);
  assert.match(script, /loadIntakePage\(\{ append: true \}\)/);
  assert.match(script, /const offset = append \? previous\.nextOffset : 0/);
  assert.match(script, /const requestQuery = state\.intakeSearch/);
  assert.match(script, /query:\s*requestQuery/);
  assert.match(script, /mergeIntakePages/);
  assert.match(script, /selectedRecordCache/);
  assert.match(script, /nextOffset:\s*nullableNonNegativeInteger/);
  assert.match(script, /completeness:\s*source\?\.completeness/);
  assert.match(script, /\["stale", "best_effort", "not_synced"\]/);
  assert.doesNotMatch(script, /limit:\s*2_000/);
});

test("review intake defaults to trading facts and exposes excluded broker records only as read-only audit", async () => {
  const [html, script, main, tradeHistory] = await Promise.all([
    readFile(new URL("../renderer/index.html", import.meta.url), "utf8"),
    readFile(new URL("../renderer/review.js", import.meta.url), "utf8"),
    readFile(new URL("../main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/data/trade-history-service.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(html, /value="audit_record">审计：已排除记录/);
  assert.match(script, /includeExcludedOrders: state\.intakeKind === "audit_record"/);
  assert.match(script, /reviewEligibility\?\.status === "audit_only"/);
  assert.match(script, /cycleRunUsesCurrentEvidenceFilter/);
  assert.match(main, /brokerEvidenceAudit/);
  assert.match(main, /evidenceFilterPolicyVersion: 2/);
  assert.match(tradeHistory, /partitionReviewOrders/);
  assert.match(tradeHistory, /partitionReviewExecutions/);
});

test("review history renders semantically excluded execution prices as unverified rather than zero or a fill", async () => {
  const script = await source("review.js");
  assert.match(script, /function brokerPriceNode\(record\)/);
  assert.match(script, /audit\?\.status === "excluded"/);
  assert.match(script, /成交价未核验/);
  assert.match(script, /多腿期权组合尚未建模/);
  assert.match(script, /父单与成交数量不守恒，疑似多腿组合/);
  assert.match(script, /成交缺少可匹配父订单，方向和币种未恢复/);
  assert.match(script, /这是委托\/限价，不是成交价/);
  assert.match(script, /原始 \$\{audit\?\.sourceField/);
  assert.match(script, /if \(value == null \|\| value === ""\)/);
  assert.equal((script.match(/brokerPriceNode\(record\)/g) ?? []).length >= 3, true);
});

test("single-symbol intake preloads a bounded recent earnings preview without blocking record selection", async () => {
  const [html, script, preload, main] = await Promise.all([
    source("index.html"),
    source("review.js"),
    source("../preload.cjs"),
    source("../main.mjs"),
  ]);

  assert.match(html, /option value="180" selected/);
  assert.match(html, /近 240 天、最多 3 次财报/);
  assert.match(script, /preloadRecentEventsForNarrowedIntake/);
  assert.match(script, /void preloadRecentEventsForNarrowedIntake\(\)/);
  assert.match(script, /EVENT_LOOKUP_DEBOUNCE_MS/);
  assert.match(script, /\.slice\(0, 3\)/);
  assert.match(script, /已缓存 · 选择订单后自动匹配/);
  assert.match(preload, /review:intake:recent-events/);
  assert.match(main, /preloadRecentEventCandidates/);
});

test("review analysis accepts only explicitly confirmed broker-backed cases", async () => {
  const [html, script] = await Promise.all([
    source("index.html"),
    source("review.js"),
  ]);

  assert.match(script, /function caseHasConfirmedBrokerRecords\(item\)/);
  assert.match(script, /links\?\.confirmedAt/);
  assert.match(html, /id="review-batch-scope"/);
  assert.match(html, /只分析你勾选的案例/);
  assert.match(html, /不会自动纳入同期间账户里的其他订单/);
  assert.match(script, /selectedBatchCaseIds:\s*new Set\(\)/);
  assert.match(script, /function selectedBatchCases\(\)/);
  assert.match(script, /state\.selectedBatchCaseIds\.has\(caseId\(item\)\)/);
  assert.match(script, /caseIds:\s*cases\.map\(caseId\)/);
  assert.match(script, /不代表同期间账户全部订单/);
  assert.doesNotMatch(script, /function casesForSelectedQuarter\(\)/);
  assert.match(script, /尚未确认关联长桥订单或成交/);
  assert.match(script, /autoIncludedRecordCount/);
  assert.match(script, /自动补齐了/);
});

test("main process builds review evidence from encrypted cases without requiring a live portfolio", async () => {
  const main = await readFile(new URL("../main.mjs", import.meta.url), "utf8");

  assert.match(main, /scope !== "review" && !portfolio/);
  assert.match(main, /selectReviewCaseIds\(reviewWorkspace/);
  assert.match(main, /buildReviewAnalysisRun\(\{/);
  assert.match(main, /archive:\s*reviewArchive/);
  assert.match(main, /caseIds:\s*reviewCaseIds/);
  assert.match(main, /const reviewWorkspace = await reviewStore\.snapshot\(\)/);
  assert.match(main, /if \(reviewCycleId\)[\s\S]+?else \{[\s\S]+?reviewStore\.snapshot\(\)/);
  assert.match(main, /\["position", "candidate", "portfolio", "review"\]/);
});

test("main and preload connect decision cycles to encrypted broker history and the two-phase Codex harness", async () => {
  const [main, preload, script] = await Promise.all([
    readFile(new URL("../main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../preload.cjs", import.meta.url), "utf8"),
    source("review.js"),
  ]);
  for (const channel of [
    "review:cycle:create",
    "review:cycle:create-order-first",
    "review:cycle:update",
    "review:cycle:seal",
    "review:cycle:link-broker",
    "review:cycle:checkpoint",
  ]) assert.match(main, new RegExp(channel));
  for (const method of ["createCycle", "createOrderFirstCycle", "updateCycle", "sealCycle", "linkCycleRecords", "addCycleCheckpoint"]) {
    assert.match(preload, new RegExp(`${method}:`));
  }
  assert.match(main, /new ReviewCycleStore/);
  assert.match(main, /resolveBrokerRecords\(\{ recordIds \}\)/);
  assert.match(main, /selectCycleRecordIds\(archive, cycle\)/);
  assert.match(main, /assertCycleBrokerSelection\(cycle, selection\)/);
  assert.match(main, /reviewCycleStore\.replaceCycleBrokerRecords\(linkInput\)/);
  assert.match(main, /requestedRecordIds: selection\.requestedRecordIds/);
  assert.match(main, /const explicitTradeWindow = replace && cycleKind === "trade_window"/);
  assert.match(main, /const explicitTradeWindow = selectedBuySellWindow\(selection, archive\);[\s\S]{0,500}startAt: explicitTradeWindow\.windowStartAt/);
  assert.match(main, /activityStartAt: explicitTradeWindow\.windowStartAt/);
  assert.match(main, /activityEndAt: explicitTradeWindow\.windowEndAt/);
  assert.match(main, /deriveSelectedBuySellWindow/);
  assert.match(main, /buildReviewCycleAnalysisRun\(\{/);
  assert.match(main, /buildReviewCycleOutcomeMetrics\(\{/);
  assert.match(main, /loadCandles:\s*\(value, count, options\) => portfolioService\.candlesWithCoverage\(value, count,/);
  assert.match(main, /deterministicOutcomeMetrics,/);
  assert.match(main, /reviewCycleStore\.recordPhaseRun\(\{/);
  assert.match(main, /expectedEvidenceRevision: run\.context\.reviewEvidenceRevision/);
  assert.match(main, /expectedRetrospectiveVersion: run\.context\.reviewRetrospectiveVersion/);
  assert.match(main, /expectedInputSnapshotHash: run\.context\.reviewInputSnapshotHash/);
  assert.match(main, /annotateLearningSources\(workspace, cycleWorkspace\)/);
  assert.match(main, /assertReviewLearningMutationSource\(\{ testId: request\?\.testId \}\)/);
  assert.match(main, /assertReviewLearningMutationSource\(\{ ruleId: request\?\.ruleId \}\)/);
  assert.match(main, /assertReviewObservationCycle\(\{/);
  assert.match(main, /reviewCycleId: request\?\.reviewCycleId/);
  assert.match(main, /withReviewLearningMutation\(async \(\) => \{/);
  assert.match(main, /function cycleCurrentReviewComplete\(cycle\)/);
  assert.match(main, /sourcePhaseRunId: sourceRun\.id/);
  assert.match(main, /reviewProtocol === "decision_cycle"/);
  assert.match(script, /sampleCycle\.dataset\.testReviewCycle = "true"/);
  assert.match(script, /后续复盘候选/);
  assert.match(script, /reviewCycleId: reviewCycleId \|\| null/);
  assert.match(script, /run\?\.integrityStatus === "valid"/);
  assert.match(script, /历史完成 · 需重跑/);
});
