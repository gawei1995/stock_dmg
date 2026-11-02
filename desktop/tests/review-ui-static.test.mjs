import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const rendererUrl = new URL("../renderer/", import.meta.url);

async function source(name) {
  return readFile(new URL(name, rendererUrl), "utf8");
}

test("snapshot coverage copy follows the actual session close, including early-close days", async () => {
  for (const name of ["index.html", "review.js"]) {
    const text = await source(name);
    assert.match(text, /提前收盘日遵循实际收盘时间/);
    assert.doesNotMatch(text, /证券(?:按|使用) 16:00 ET/);
  }
});

async function reviewFunctions(names, context) {
  const script = await source("review.js");
  const implementations = names.map((name) => {
    const start = script.search(new RegExp(`^  (?:async )?function ${name}\\(`, "m"));
    assert.ok(start >= 0, `missing renderer function ${name}`);
    const tail = script.slice(start);
    const end = tail.slice(1).search(/\n  (?:async )?function \w+\(/);
    return end < 0 ? tail : tail.slice(0, end + 1);
  });
  vm.createContext(context);
  vm.runInContext(implementations.join("\n"), context);
  return context;
}

function reconciliationFixture() {
  const item = { id: "cycle-a", evidenceRevision: 2, startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-08-31T20:00:00.000Z",
    brokerLinks: { accountScopeId: "scope-a", evidenceRevision: 2 }, brokerEvidenceAudit: { requiresPolicyV2Run: true },
    retrospectiveVersions: [{ version: 3, integrityStatus: "valid" }], phaseRuns: { retrospective: [], outcome: [] } };
  const result = { schemaVersion: "review-reconciliation/v1", cycleId: item.id, cycleEvidenceRevision: 2,
    accountScopeId: "scope-a", window: { startAt: item.startAt, endAt: item.endAt }, evidenceHash: "a".repeat(64), status: "partial", fields: {} };
  const run = { id: "run-a", status: "completed", integrityStatus: "valid", evidenceRevision: 2, retrospectiveVersion: 3,
    completedAt: "2026-09-01T00:00:00.000Z", evidenceFilterPolicyVersion: 2, result: { reconciliation: result } };
  const cache = { reconciliation: result, evidenceRevision: 2, reviewPhase: "retrospective", retrospectiveVersion: 3,
    phaseRunId: "run-cache", persistence: "recorded", completedAt: "2026-09-01T00:00:00.000Z", evidenceFilterPolicyVersion: 2 };
  return { item, result, run, cache };
}

async function reconciliationContext() {
  return reviewFunctions(["cycleReconciliationResult", "reconciliationRevision", "cycleRetrospectiveVersion", "cycleRunUsesCurrentEvidenceFilter", "cycleId", "arrayValue", "timestamp"],
    { state: { accountScopeId: "scope-a", cycleTradePathResults: new Map() } });
}

test("reconciliation selects only valid completed persisted evidence at the current order and note versions", async () => {
  const context = await reconciliationContext();
  const { item, result, run } = reconciliationFixture();
  item.phaseRuns.retrospective = [run];
  assert.equal(context.cycleReconciliationResult(item), result);
  for (const patch of [
    { evidenceRevision: 1 }, { retrospectiveVersion: 2 }, { integrityStatus: "mismatch" }, { integrityStatus: null },
    { status: "running" }, { status: "failed" }, { completedAt: null }, { completedAt: "invalid" }, { evidenceFilterPolicyVersion: 1 },
  ]) {
    item.phaseRuns.retrospective = [{ ...run, ...patch }];
    assert.equal(context.cycleReconciliationResult(item), null, JSON.stringify(patch));
  }
  item.phaseRuns.retrospective = [];
  item.phaseRuns.outcome = [{ ...run, retrospectiveVersion: null }];
  assert.equal(context.cycleReconciliationResult(item), result, "outcome does not borrow retrospective note-version requirements");
});

test("reconciliation cache requires host-recorded completion and matches cycle, scope, window and current revisions", async () => {
  const context = await reconciliationContext();
  const { item, result, cache } = reconciliationFixture();
  context.state.cycleTradePathResults.set(item.id, cache);
  assert.equal(context.cycleReconciliationResult(item), result);
  for (const patch of [{ persistence: "failed" }, { persistence: null }, { phaseRunId: null }, { completedAt: null },
    { reviewPhase: "blind" }, { evidenceRevision: 1 }, { retrospectiveVersion: 2 }, { evidenceFilterPolicyVersion: 1 }]) {
    context.state.cycleTradePathResults.set(item.id, { ...cache, ...patch });
    assert.equal(context.cycleReconciliationResult(item), null, JSON.stringify(patch));
  }
  for (const patch of [{ schemaVersion: "legacy" }, { cycleId: "other" }, { accountScopeId: "other" }, { accountScopeId: null },
    { cycleEvidenceRevision: 1 }, { evidenceHash: null }, { window: { startAt: item.startAt, endAt: "2026-08-30T20:00:00Z" } }]) {
    context.state.cycleTradePathResults.set(item.id, { ...cache, reconciliation: { ...result, ...patch } });
    assert.equal(context.cycleReconciliationResult(item), null, JSON.stringify(patch));
  }
  context.state.cycleTradePathResults.set(item.id, cache);
  context.state.accountScopeId = "scope-b";
  assert.equal(context.cycleReconciliationResult(item), null);
  context.state.accountScopeId = "scope-a";
  for (const evidenceRevision of [null, true, false, "", 0, -1, NaN]) {
    assert.equal(context.cycleReconciliationResult({ ...item, evidenceRevision, brokerLinks: { accountScopeId: "scope-a" } }), null);
  }
});

test("reconciliation cache cannot hide a newer durable result or revive its invalidated durable run", async () => {
  const context = await reconciliationContext();
  const { item, result, run, cache } = reconciliationFixture();
  const newer = { ...result, evidenceHash: "b".repeat(64) };
  item.phaseRuns.retrospective = [{ ...run, completedAt: "2026-09-02T00:00:00Z", result: { reconciliation: newer } }];
  context.state.cycleTradePathResults.set(item.id, cache);
  assert.equal(context.cycleReconciliationResult(item), newer);
  item.phaseRuns.retrospective = [{ ...run, id: cache.phaseRunId, integrityStatus: "mismatch" }];
  assert.equal(context.cycleReconciliationResult(item), null);
  item.phaseRuns.retrospective = [{ ...run, id: cache.phaseRunId }];
  context.state.cycleTradePathResults.set(item.id, { ...cache, completedAt: "2026-09-03T00:00:00Z", reconciliation: newer });
  assert.equal(context.cycleReconciliationResult(item), result, "a different cached hash cannot override the verified payload of the same run");
  item.phaseRuns.retrospective = [run];
  item.evidenceRevision = 3;
  assert.equal(context.cycleReconciliationResult(item), null, "changing boxed orders invalidates both persistent and cached checklists");
});

test("reconciliation cache captures completion authority and partial errors never become a current result", async () => {
  const fixture = reconciliationFixture();
  const context = await reviewFunctions(["captureCycleTradePathResult"], {
    state: { cycleTradePathResults: new Map() }, selectedCycle: () => null,
  });
  const envelope = { completedAt: "2026-09-01T00:00:00Z", run: {
    context: { scope: "review", reviewProtocol: "decision_cycle", reviewPhase: "retrospective", reviewCycleId: fixture.item.id,
      reviewEvidenceRevision: 2, reviewRetrospectiveVersion: 3, reviewPhasePersistence: "recorded", reviewPhaseRunId: "phase-1" },
    analysisContext: { reconciliation: fixture.result, cycle: { brokerAssociation: { evidenceFilterPolicyVersion: 2 } } },
  } };
  context.captureCycleTradePathResult(envelope);
  const cached = context.state.cycleTradePathResults.get(fixture.item.id);
  assert.equal(cached.phaseRunId, "phase-1");
  assert.equal(cached.persistence, "recorded");
  assert.equal(cached.evidenceFilterPolicyVersion, 2);
  assert.equal(cached.retrospectiveVersion, 3);
  assert.equal(cached.completedAt, envelope.completedAt);
  context.captureCycleTradePathResult({ ...envelope, error: "终态未核验", complete: false, partial: true });
  assert.equal(context.state.cycleTradePathResults.get(fixture.item.id).completedAt, null);
});

test("reconciliation reasons use plain Chinese and the actual compact projection counters", async () => {
  const context = await reviewFunctions(["reconciliationReasonText"], {});
  assert.match(context.reconciliationReasonText("opening:source_not_host_verified"), /起点.*本机核验/);
  assert.match(context.reconciliationReasonText("fx_requirement_scope_incomplete:fees"), /费用.*汇率/);
  assert.match(context.reconciliationReasonText("corporate_action_cash_inventory_effects_unreconciled"), /企业行动.*库存/);
  assert.match(context.reconciliationReasonText("a_future_unknown_code"), /证据条件待核对/);
  assert.doesNotMatch(context.reconciliationReasonText("a_future_unknown_code"), /a_future_unknown_code/);
  const script = await source("review.js");
  assert.match(script, /field\?\.projection\?\.omittedReasonCount/);
  assert.match(script, /field\?\.projection\?\.omittedSourceCount/);
  assert.doesNotMatch(script, /field\?\.projection\?\.reasons\?\.omittedCount/);
});

test("excess return difference is displayed in percentage points, not percent", async () => {
  const context = await reviewFunctions(["technicalMetricPercentagePoints"], {
    strictFiniteReviewNumber: value => typeof value === "number" && Number.isFinite(value) ? value : null,
  });
  assert.equal(context.technicalMetricPercentagePoints({ status: "available", value: 5 }), "+5.00 个百分点");
  assert.equal(context.technicalMetricPercentagePoints({ status: "available", value: -2.5 }), "-2.50 个百分点");
  assert.equal(context.technicalMetricPercentagePoints({ status: "available", value: 0 }), "0.00 个百分点");
  assert.equal(context.technicalMetricPercentagePoints({ status: "unavailable", value: null }), "N/A");
  assert.match(await source("review.js"), /technicalMetricPercentagePoints\(sample\?\.outcome\?\.qqqExcessPercent\)/);
});

test("formal progress uses the host canonical count, never recounts migrated cycle aliases", async () => {
  const context = await reviewFunctions(["formalProtocolSampleCount"], {});
  const samples = Array.from({ length: 20 }, (_, index) => ({ reviewCycleId: `alias-${index}`, outcomeVerified: true, formalEligible: true, observationTiming: "forward", outcomeR: 1 }));
  assert.equal(context.formalProtocolSampleCount({ samples, formalIdentityMethod: "canonical-review-evidence/v1", formalUniqueSampleCount: 1 }), 1);
  assert.equal(context.formalProtocolSampleCount({ samples }), 0);
  assert.equal(context.formalProtocolSampleCount({ samples, formalIdentityMethod: "canonical-review-evidence/v1", formalUniqueSampleCount: "20" }), 0);
});

test("legacy deep links and direct tab requests resolve to the validation center", async () => {
  const hashes = [];
  const context = await reviewFunctions(["routeFromHash", "setReviewTab"], {
    state: { mode: "review", activeTab: "cycles" }, window: { location: { hash: "" } },
    REVIEW_TABS: new Set(["cycles", "cases", "tests"]), renderTabs() {}, replaceHash: (value) => hashes.push(value),
  });
  for (const legacy of ["rules", "governance"]) {
    context.window.location.hash = `#/review/${legacy}`;
    assert.equal(context.routeFromHash().tab, "tests");
    context.setReviewTab(legacy);
    assert.equal(context.state.activeTab, "tests");
    assert.equal(hashes.at(-1), "#/review/tests");
  }
});

test("earnings creation collects the existing three notes then sends only selected IDs and the host event reference", async () => {
  const calls = [], opened = [];
  const state = { loading: false, pendingOrderFirstCycle: null };
  const context = await reviewFunctions(["createEarningsCycleFromRecords", "confirmOrderFirstCycle"], {
    state,
    selectedIntakeRecords: () => [{ id: "order:1" }, { id: "execution:1" }],
    selectedEventCandidate: () => ({ id: "event-1", symbol: "AAPL.US", quarter: "FY2026 Q3" }),
    brokerRecordId: (value) => value.id, eventCandidateId: (value) => value.id,
    eventSymbol: (value) => value.symbol, eventPeriod: (value) => value.quarter,
    openOrderFirstNoteDialog: (request) => { state.pendingOrderFirstCycle = request; },
    elements: {
      orderFirstRecalledJudgment: { value: "当时看好增长" }, orderFirstLesson: { value: "分批退出" },
      orderFirstForwardHypothesis: { value: "下一次先验证指引" }, orderFirstNoteSubmit: {},
      orderFirstNoteForm: { reportValidity() { throw Error("unexpected incomplete notes"); } },
    },
    runAction: async (_message, action) => action(),
    callReview: async (method, request) => { calls.push({ method, request }); return { cycle: { id: "cycle-1" } }; },
    openCreatedOrderFirstCycle: async (result) => opened.push(result.cycle.id),
    closeOrderFirstNoteDialog() { state.pendingOrderFirstCycle = null; }, showNotice() {},
  });
  context.createEarningsCycleFromRecords();
  assert.equal(calls.length, 0, "opening the note dialog does not write anything");
  assert.equal(state.pendingOrderFirstCycle.flow, "earnings");
  await context.confirmOrderFirstCycle({ preventDefault() {} });
  assert.deepEqual(calls.map((value) => value.method), ["createOrderFirstCycle"]);
  const request = JSON.parse(JSON.stringify(calls[0].request));
  assert.deepEqual(request.recordIds, ["order:1", "execution:1"]);
  assert.equal(request.eventCandidateId, "event-1");
  assert.deepEqual(request.retrospectiveNote, { recalledJudgment: "当时看好增长", lesson: "分批退出", forwardHypothesis: "下一次先验证指引" });
  for (const key of ["symbol", "eventAt", "startAt", "endAt", "fiscalQuarter"]) assert.equal(key in request, false);
  assert.deepEqual(opened, ["cycle-1"]);
});

test("legacy case actions cannot write or dispatch analysis and fields remain selectable but read only", async () => {
  const notices = [], fields = [{ disabled: true }, { disabled: true }], selects = [{}];
  let redirected = 0;
  const context = await reviewFunctions(["legacyCaseReadOnly", "prepareCaseAnalysis", "prepareBatchAnalysis", "setCaseFormFrozen"], {
    showNotice: (message) => notices.push(message), showCycleWelcome: () => { redirected++; },
    callReview() { throw Error("legacy write attempted"); }, announcePreparedAnalysis() { throw Error("legacy analysis attempted"); },
    elements: { caseForm: { querySelectorAll: (selector) => selector === "select" ? selects : fields } },
  });
  context.prepareCaseAnalysis(); context.prepareBatchAnalysis(); context.setCaseFormFrozen();
  assert.equal(redirected, 1);
  assert.ok(notices.every((message) => /迁移/.test(message)));
  assert.ok(fields.every((field) => field.readOnly === true && field.disabled === false));
  assert.ok(selects.every((field) => field.disabled === true));
});

async function migrationFixture(handler) {
  const state = { selectedCaseId: "case-a", accountScopeId: "account-a", caseMigrationPreview: null,
    caseMigrationRequestToken: 0, loading: false, selectedRecordIds: new Set(["order:original"]) };
  const calls = [], opened = [], errors = [];
  const context = await reviewFunctions([
    "clearCaseMigrationPreview", "caseMigrationRequestIsCurrent", "previewSelectedCaseMigration", "confirmSelectedCaseMigration",
  ], {
    state, elements: { caseMigration: { hidden: true } },
    selectedCase: () => ({ id: state.selectedCaseId }), caseId: (value) => value.id,
    renderCaseMigrationPreview() {}, showNotice() {},
    runAction: async (_message, action) => { try { await action(); } catch (error) { errors.push(error.message); } },
    callReview: async (method, request) => { calls.push({ method, request }); return handler(method, request); },
    openCreatedOrderFirstCycle: async (result) => opened.push(result.cycle.id),
  });
  return { context, state, calls, opened, errors };
}

test("migration preview is read only and confirmation sends the frozen source hash once", async () => {
  const fx = await migrationFixture(async (method) => method === "previewCaseMigration"
    ? { preview: { sourceCaseId: "case-a", sourceHash: "source-v1", title: "旧案例", existingCycleId: null } }
    : { cycle: { id: "migrated-cycle" } });
  await fx.context.previewSelectedCaseMigration();
  assert.deepEqual(fx.calls.map((item) => item.method), ["previewCaseMigration"]);
  assert.deepEqual(fx.opened, []);
  await fx.context.confirmSelectedCaseMigration();
  assert.deepEqual(JSON.parse(JSON.stringify(fx.calls[1])), { method: "migrateCase", request: { caseId: "case-a", sourceHash: "source-v1", confirmed: true } });
  assert.deepEqual(fx.opened, ["migrated-cycle"]);
  assert.equal(fx.state.caseMigrationPreview, null);
  assert.deepEqual([...fx.state.selectedRecordIds], ["order:original"]);
});

test("existing migrations open their cycle without a second write", async () => {
  const fx = await migrationFixture(async () => ({ preview: { sourceCaseId: "case-a", existingCycleId: "existing-cycle" } }));
  await fx.context.previewSelectedCaseMigration();
  await fx.context.confirmSelectedCaseMigration();
  assert.deepEqual(fx.calls.map((item) => item.method), ["previewCaseMigration"]);
  assert.deepEqual(fx.opened, ["existing-cycle"]);
});

test("a failed migration preserves the original selection and reusable preview", async () => {
  const fx = await migrationFixture(async (method) => {
    if (method === "previewCaseMigration") return { preview: { sourceCaseId: "case-a", sourceHash: "source-v1" } };
    throw Error("source changed; preview again");
  });
  await fx.context.previewSelectedCaseMigration();
  await fx.context.confirmSelectedCaseMigration();
  assert.equal(fx.state.selectedCaseId, "case-a");
  assert.equal(fx.state.caseMigrationPreview.sourceHash, "source-v1");
  assert.deepEqual([...fx.state.selectedRecordIds], ["order:original"]);
  assert.deepEqual(fx.opened, []);
  assert.match(fx.errors[0], /source changed/);
});

test("late preview or migration responses cannot open a different account's cycle", async () => {
  let release;
  const fx = await migrationFixture(() => new Promise((resolve) => { release = resolve; }));
  const pending = fx.context.previewSelectedCaseMigration();
  fx.state.accountScopeId = "account-b"; fx.context.clearCaseMigrationPreview();
  release({ preview: { sourceCaseId: "case-a", sourceHash: "old-account-source" } });
  await pending;
  assert.equal(fx.state.caseMigrationPreview, null);
  assert.deepEqual(fx.opened, []);
  const fx2 = await migrationFixture(async (method) => {
    if (method === "previewCaseMigration") return { preview: { sourceCaseId: "case-a", sourceHash: "source-v1" } };
    fx2.state.accountScopeId = "account-b";
    return { cycle: { id: "old-account-cycle" } };
  });
  await fx2.context.previewSelectedCaseMigration();
  await fx2.context.confirmSelectedCaseMigration();
  assert.deepEqual(fx2.opened, []);
});

test("v2 creation has one atomic write and never falls back to legacy multi-step writes", async () => {
  const values = { title: "v2", condition: "条件", action: "动作", invalidation: "失效", metric: "net_r",
    "success-operator": "gt", "success-threshold": "0", "success-criteria": "净R大于0", "minimum-cases": "20" };
  const calls = [], errors = [];
  const panel = { querySelector: (selector) => ({ value: values[selector.replace(/^\[data-v2-|\]$/g, "")] }) };
  const context = await reviewFunctions(["createValidationV2"], {
    state: { loading: false, snapshot: { tests: [{ id: "test-a", ruleId: "rule-a" }], rules: [{ id: "rule-a" }] } },
    runAction: async (_message, action) => { try { await action(); } catch (error) { errors.push(error.message); } },
    callReview: async (method) => { calls.push(method); throw Error("atomic API unavailable"); },
    showNotice() {}, forgetValidationDraft() { throw Error("failure must retain draft"); }, loadSnapshot() {},
  });
  await context.createValidationV2({ dataset: { createValidationV2: "test-a", validationRuleId: "rule-a" }, closest: () => panel });
  assert.deepEqual(calls, ["createValidationVersion"]);
  assert.deepEqual(errors, ["atomic API unavailable"]);
});

test("an empty candidate pool explains host exclusions instead of silently appearing empty", async () => {
  const context = await reviewFunctions(["validationCandidateGuidance", "validationCandidateExclusionSummary"], {
    state: { snapshot: { validationCandidateExclusions: { "test-a": [
      { cycleId: "source", reason: "same_evidence_as_hypothesis_source" },
      { cycleId: "old-run", reason: "no_current_cycle_phase_run" },
      { cycleId: "duplicate", reason: "same_evidence_already_included" },
    ] } } }, arrayValue: (value) => Array.isArray(value) ? value : [],
  });
  const message = context.validationCandidateGuidance({ id: "test-a" }, []);
  assert.match(message, /已排除 3 个周期/);
  assert.match(message, /与假设来源相同/);
  assert.match(message, /尚无基于当前证据完成的周期复盘/);
  assert.match(message, /同一证据已纳入/);
  assert.doesNotMatch(message, /same_evidence|no_current/);
});

test("review workspace has three primary destinations and read-only legacy history inside validation", async () => {
  const [html, css] = await Promise.all([
    source("index.html"),
    source("review.css"),
  ]);

  assert.match(html, /id="workspace-cockpit"[^>]*data-workspace-mode="cockpit"/);
  assert.match(html, /id="workspace-review"[^>]*data-workspace-mode="review"/);
  assert.match(html, /id="review-workspace"[^>]*hidden/);
  for (const tab of ["cycles", "cases", "tests"]) {
    assert.match(html, new RegExp(`data-review-tab="${tab}"`));
    assert.match(html, new RegExp(`id="review-panel-${tab}"`));
  }
  assert.match(html, /订单证据 \/ 历史案例/);
  assert.match(html, />验证中心\s*</);
  assert.doesNotMatch(html, /data-review-tab="(?:rules|governance)"/);
  assert.match(html, /规则与决策历史/);
  assert.match(html, /id="review-rule-list"/);
  assert.match(html, /id="review-governance-list"/);
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
    "review-cycle-technical-validation",
    "review-cycle-technical-validation-summary",
    "review-cycle-technical-validation-note",
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
  assert.match(script, /function renderCycleTechnicalValidation\(item\)/);
  assert.match(script, /function persistedCycleTechnicalValidationResult\(item, currentEvidenceRevision\)/);
  assert.match(script, /run\?\.result\?\.technicalValidation/);
  assert.match(script, /20 个来自唯一周期的合格前向候选/);
  assert.match(script, /完成重叠窗口与同一事件去重/);
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
  assert.match(css, /\.review-technical-validation-summary/);
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
  assert.match(html, /id="review-background-capture"/);
  assert.match(html, /id="review-snapshot-ledger-status"/);
  assert.match(script, /capturePortfolioSnapshot/);
  assert.match(script, /toggleSnapshotBackgroundCapture/);
  assert.match(preload, /review:portfolio-snapshot:capture/);
  assert.match(preload, /review:snapshot-background:update/);
  assert.match(main, /new PortfolioSnapshotStore/);
  assert.match(main, /review:portfolio-snapshot:capture/);
  assert.match(main, /review:snapshot-background:update/);
  assert.match(main, /scheduleFreshPortfolioEvidence/);
  assert.match(main, /requiresAppRunning: true/);
  assert.match(main, /missedDayBackfill: false/);
  assert.match(main, /summarizeTradePricePath/);
  assert.match(main, /tradePricePathSummary:/);
  assert.match(main, /technicalValidation:\s*run\?\.analysisContext\?\.technicalValidation/);
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
  assert.match(script, /设备关机期间不会伪造历史/);
  assert.match(script, /登录 macOS 后隐藏启动/);
  assert.match(preload, /setSnapshotBackgroundPreferences: \(request\) => ipcRenderer\.invoke\("review:snapshot-background:update", request\)/);
});

test("review workspace exposes scoped encrypted recovery bundles with clear portability limits", async () => {
  const [html, script, css] = await Promise.all([
    source("index.html"),
    source("review.js"),
    source("review.css"),
  ]);

  assert.match(html, /id="review-export-backup"/);
  assert.match(html, /id="review-restore-backup"/);
  assert.match(html, /加密业务数据、应用内对话索引与最近结果/);
  assert.match(html, /不含登录凭证、TradingView 登录状态或 Codex 外部完整对话/);
  assert.match(html, /同一 macOS 钥匙串身份/);
  assert.match(script, /api\?\.review\?\.exportTrustedBackup/);
  assert.match(script, /api\?\.review\?\.restoreTrustedBackup/);
  assert.match(script, /已取消导出；本机业务数据未改变/);
  assert.match(script, /已取消恢复；当前本机业务数据保持不变/);
  assert.match(script, /恢复包覆盖的业务数据与当前一致，无需替换或重新启动/);
  assert.match(script, /业务数据已按确认清单恢复，应用正在重新启动/);
  assert.match(css, /\.review-recovery-controls/);
  assert.match(css, /\.review-recovery-actions/);
});

async function archiveLedgerContext(handler) {
  const inputs = ["500", "60"].map(value => ({ value, disabled: false, focus() { this.focused = true; } }));
  const buttons = inputs.map(() => ({ disabled: false }));
  const forms = ["portfolio", "radar"].map((kind, index) => ({
    dataset: { ledgerArchiveKind: kind }, querySelector: () => inputs[index],
    querySelectorAll: () => [inputs[index], buttons[index]],
  }));
  const elements = { archiveLedgerForms: forms, archiveLedger: { setAttribute() {} },
    archiveLedgerStatus: { hidden: true, textContent: "", dataset: {} }, exportBackup: {}, restoreBackup: {} };
  const context = await reviewFunctions(["archiveLedger", "updateArchiveLedgerControls", "setArchiveLedgerStatus"], {
    state: { loading: false, archiveLedgerBusy: false }, elements, api: { reviewArchiveLedger: handler },
  });
  return { context, inputs, buttons, elements, submit: (index = 0) => context.archiveLedger({ preventDefault() {}, currentTarget: forms[index] }) };
}

test("ledger archival is manual, advertises all-account append order, and the bridge dispatches only the archive IPC", async () => {
  const html = await source("index.html");
  assert.match(html, /<details class="review-ledger-archive" id="review-ledger-archive">/);
  assert.match(html, /整理历史存储（不删除记录）/);
  assert.match(html, /所有账户，按追加顺序/);
  assert.match(html, /不按行情日期排序/);
  assert.match(html, /随本机恢复包保留/);
  assert.match(html, /不会腾出全部历史记录占用的磁盘空间/);
  assert.match(html, /不会自动归档/);
  assert.match(html, /id="review-archive-portfolio-retain"[^>]+min="1" step="1" value="500"/);
  assert.match(html, /id="review-archive-radar-retain"[^>]+min="1" step="1" value="60"/);
  const invocations = [];
  let exposed;
  vm.runInNewContext(await readFile(new URL("../preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld(_name, api) { exposed = api; } },
      ipcRenderer: { invoke: (...args) => { invocations.push(args); return Promise.resolve({ ok: true }); } } }),
  });
  assert.equal(invocations.length, 0, "loading the bridge must not archive automatically");
  await exposed.reviewArchiveLedger({ kind: "radar", retainActiveCount: 60 });
  assert.deepEqual(invocations, [["review:ledger:archive", { kind: "radar", retainActiveCount: 60 }]]);
});

test("archive validates integers, prevents reentry and restores editing without touching drafts", async () => {
  const calls = [];
  let release;
  const fixture = await archiveLedgerContext(request => { calls.push(request); return new Promise(resolve => { release = resolve; }); });
  for (const invalid of ["", "0", "-1", "1.5", "1e3", "Infinity", "9007199254740992"]) {
    fixture.inputs[0].value = invalid;
    await fixture.submit();
    assert.equal(calls.length, 0, invalid);
    assert.equal(fixture.elements.archiveLedgerStatus.dataset.tone, "error");
  }
  fixture.inputs[0].value = "275";
  const pending = fixture.submit();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "portfolio");
  assert.equal(calls[0].retainActiveCount, 275);
  assert.ok([...fixture.inputs, ...fixture.buttons].every(control => control.disabled));
  assert.equal(fixture.elements.restoreBackup.disabled, true);
  await fixture.submit(1);
  assert.equal(calls.length, 1, "cross-kind submissions share the same guard");
  fixture.context.updateArchiveLedgerControls();
  assert.ok(fixture.inputs.every(control => control.disabled), "background busy refresh must not unlock pending preview");
  release({ ok: true, canceled: true });
  await pending;
  assert.equal(fixture.context.state.archiveLedgerBusy, false);
  assert.ok([...fixture.inputs, ...fixture.buttons].every(control => !control.disabled));
  assert.equal(fixture.inputs[0].value, "275", "input value must not reset after cancel");
  assert.match(fixture.elements.archiveLedgerStatus.textContent, /已取消.*保持不变/);
  assert.equal(fixture.elements.archiveLedgerStatus.dataset.tone, "info");
  fixture.context.state.loading = true;
  await fixture.submit();
  assert.equal(calls.length, 1, "another recovery action also blocks the archive request");
});

test("archive distinguishes no-op, failure and count-verified success, without a renderer confirmation", async () => {
  let result;
  const fixture = await archiveLedgerContext(() => { if (result instanceof Error) throw result; return result; });
  for (result of [{ ok: true, archived: false, message: "当前没有需要归档的记录" }, new Error("空间不足"),
    { ok: false, message: "保存失败" }, undefined, { ok: true, archived: true, kind: "portfolio", archiveCount: 1 }]) {
    await fixture.submit();
    const status = fixture.elements.archiveLedgerStatus;
    assert.notEqual(status.dataset.tone, "success");
    assert.equal(fixture.context.state.archiveLedgerBusy, false);
    assert.ok(fixture.inputs.every(control => !control.disabled));
  }
  result = { ok: true, archived: true, kind: "portfolio", archiveCount: 25, activeCount: 500, archivedCount: 40, totalCount: 540 };
  await fixture.submit();
  assert.equal(fixture.elements.archiveLedgerStatus.dataset.tone, "success");
  assert.match(fixture.elements.archiveLedgerStatus.textContent, /本次归档 25 条.*当前追加区 500 条.*累计历史 40 条.*共 540 条.*未删除/);
  result = { ...result, totalCount: 0 };
  await fixture.submit();
  assert.equal(fixture.elements.archiveLedgerStatus.dataset.tone, "error", "inconsistent counts cannot appear successful");
  // The extracted original handler has no window, broker, Agent or render functions
  // in its environment; any extra confirmation, fetch or form rebuild would fail.
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

test("legacy cases remain read only and all new learning uses the validation center", async () => {
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
    "review-case-migrate-preview",
    "review-case-migrate-confirm",
    "review-case-migration-limitations",
    "review-learning-success-operator",
    "review-learning-success-threshold",
    "review-rule-list",
    "review-governance-list",
  ]) assert.match(html, new RegExp(`id="${id}"`));

  assert.match(script, /^\(\(\) => \{[\s\S]*"use strict";/);
  assert.match(script, /api\.workspace\.setMode\(nextMode\)/);
  for (const method of [
    "snapshot",
    "previewCaseMigration",
    "migrateCase",
    "acceptLearningProposal",
    "archiveValidation",
    "completeTest",
    "evaluateProtocol",
    "createValidationVersion",
    "transitionRule",
    "addRuleReview",
  ]) assert.match(script, new RegExp(`callReview\\("${method}"`));
  assert.match(script, /const syncMethod = intakeMethod \?\? "syncTradeHistory"/);
  assert.match(script, /callReview\(syncMethod, payload\)/);

  assert.match(script, /CASE_FROZEN_STATES/);
  assert.match(script, /迁移不会将旧草稿或事后回忆提升为事前证据/);
  assert.match(script, /自动匹配仅作为候选/);
  assert.match(script, /stripBrokerRecordPrefix/);
  assert.doesNotMatch(script, /callReview\("(?:createCase|createCaseFromRecords|updateCase|freezeCase|linkBrokerRecords|createRule|registerTest)"/);
  assert.doesNotMatch(html, /id="(?:review-test-form|review-rule-form|review-governance-form)"/);
  assert.match(script, /function previewSelectedCaseMigration/);
  assert.match(script, /function confirmSelectedCaseMigration/);
  assert.match(script, /replace:\s*true/);
  assert.match(script, /周期证据新版本已保存/);
  assert.match(script, /cockpit:review-evidence-revisions/);
  assert.match(script, /function renderLearningProposal/);
  assert.match(html, /开始观察/);
  assert.match(html, /一条验证路径/);
  assert.match(script, /核验 \/ 纳入所选周期/);
  assert.match(script, /function validationCandidateCycles/);
  assert.match(script, /待你决策/);
  assert.match(script, /继续观察/);
  assert.match(script, /创建 v2/);
  assert.match(script, /暂行采用/);
  assert.match(script, /人工观察（不推进门槛）/);
  assert.match(script, /运行确定性评估/);
  assert.match(script, /formalProtocolSampleCount/);
  assert.match(script, /胜率阈值使用百分比/);
  assert.match(script, /dataV2SuccessThreshold|v2SuccessThreshold/);
  assert.match(script, /formalIdentityMethod === "canonical-review-evidence\/v1"/);
  assert.match(script, /Number\.isSafeInteger\(test\.formalUniqueSampleCount\)/);
  assert.match(script, /当前证据需重新核验，不能据旧状态视作目前验证通过/);
  assert.match(script, /review-validation-gates/);
  assert.match(script, /人工观察不会绕过该门槛/);
  assert.match(script, /来源复盘/);
  assert.match(script, /item\.sourceStatus === "stale"/);
  assert.match(script, /`order:\$\{raw\}`/);
  assert.match(script, /`execution:\$\{raw\}`/);
  assert.match(script, /applicationStatus === "proposal_only"/);
  assert.match(script, /decision: decision === "retire" \? "retire" : "keep"/);
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
  assert.match(main, /reviewStore\.createValidationVersion\(\{ \.\.\.request, cycles: cycleWorkspace\.cycles \}\)/);
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
  assert.match(main, /technicalValidationRef:\s*observation\?\.technicalValidation/);
  assert.match(script, /历史\/跨界校准/);
  assert.match(script, /前向技术候选 · 待协议绑定/);
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
  assert.match(script, /!\["chat", "review"\]\.includes\(state\.analysisScope\) && !state\.portfolio/);
  assert.match(reviewScript, /setTimeout\(\(\) => \{[\s\S]{0,220}cockpit:review-analysis-prepared/);
});

test("a prepared review starts a fresh persistent Codex session while follow-ups reuse it", async () => {
  const script = await source("renderer.js");
  const submitTask = script.match(/async function submitAgentTask\(event\) \{[\s\S]+?\n\}/)?.[0] ?? "";

  assert.match(script, /async function createAgentSession\(options = \{\}\)/);
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
  assert.match(script, /accountScopeStatus === "mismatch"/);
  assert.match(script, /系统已隐藏关联记录，防止跨账户混入/);
  assert.match(script, /此周期创建于账户范围绑定之前/);
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
  assert.match(script, /已缓存 · 选择订单后显示建议/);
  assert.match(script, /系统建议 · 请点击确认/);
  assert.doesNotMatch(script, /state\.selectedEventId = closest \?/);
  assert.match(preload, /review:intake:recent-events/);
  assert.match(main, /preloadRecentEventCandidates/);
});

test("recent earnings preview deduplicates only active or fresh successful requests and exposes retry after failure", async () => {
  const script = await source("review.js");

  assert.match(script, /RECENT_EVENT_CACHE_FRESH_MS/);
  assert.match(script, /recentEventRequests: new Map\(\)/);
  assert.match(script, /cachedRequest\?\.status === "in_flight"/);
  assert.match(script, /function recentEventRequestIsFresh\(request, now = Date\.now\(\)\)/);
  assert.match(script, /request\?\.status === "success"/);
  assert.match(script, /status: "failed"/);
  assert.match(script, /重试财报日期/);
  assert.match(script, /button\.addEventListener\("click", \(\) => void preloadRecentEventsForNarrowedIntake\(\)\)/);
  assert.doesNotMatch(script, /if \(state\.recentEventRequestKey === requestKey\) \{\s*renderEventCandidates\(\);\s*return;/);
});

test("review navigation preserves entity drafts and a failed refresh keeps the last successful snapshot", async () => {
  const [script, css] = await Promise.all([
    source("review.js"),
    source("review.css"),
  ]);
  assert.match(script, /caseDrafts: new Map\(\)/);
  assert.match(script, /cycleDrafts: new Map\(\)/);
  assert.doesNotMatch(script, /function rememberSelectedCaseDraft/);
  assert.match(script, /function rememberSelectedCycleDraft/);
  assert.match(script, /snapshotRequestToken: 0/);
  assert.match(script, /const requestToken = \+\+state\.snapshotRequestToken/);
  assert.equal((script.match(/if \(requestToken !== state\.snapshotRequestToken\) return;/g) ?? []).length >= 2, true);
  assert.match(script, /requestToken === state\.snapshotRequestToken\) \{\s*state\.snapshotLoading = false/);
  assert.doesNotMatch(script, /snapshotManagesLoading/);
  assert.match(script, /if \(!state\.snapshotLoaded\) state\.snapshot = emptySnapshot\(\)/);
  assert.match(script, /仍显示 .* 的上次成功结果，不会伪装为空/);
  assert.match(css, /@media \(max-width: 1500px\)/);
  assert.match(css, /\.review-trade-path-segments[\s\S]{0,180}max-height: none/);
});

test("legacy case analysis no longer dispatches old scopes or implicit batch migration", async () => {
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
  assert.doesNotMatch(script, /scope:\s*"earnings_case"|scope:\s*"earnings_batch"/);
  assert.match(script, /旧财报案例只读保留/);
  assert.doesNotMatch(script, /function casesForSelectedQuarter\(\)/);
  assert.match(script, /不会批量静默迁移/);
  assert.match(script, /flow: "earnings"/);
  assert.match(script, /eventCandidateId: eventCandidateId\(candidate\)/);
});

test("main process only starts cycle review while legacy case history remains readable", async () => {
  const main = await readFile(new URL("../main.mjs", import.meta.url), "utf8");

  assert.match(main, /!\["review", "chat"\]\.includes\(scope\) && !requestedPortfolio/);
  assert.doesNotMatch(main, /selectReviewCaseIds\(reviewWorkspace|buildReviewAnalysisRun\(\{/);
  assert.match(main, /buildReviewCycleAnalysisRun\(\{/);
  assert.match(main, /archive:\s*reviewArchive/);
  assert.match(main, /scope === "review" && !reviewCycleId/);
  assert.match(main, /throw legacyReviewWriteError\(/);
  assert.match(main, /legacyCaseBrokerMatches/);
  assert.match(main, /\["chat", "position", "candidate", "portfolio", "review"\]/);
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
  assert.match(main, /const replacementRange = explicitTradeWindow\s*\? \{ startAt: explicitTradeWindow\.windowStartAt, endAt: explicitTradeWindow\.windowEndAt \}/);
  assert.match(main, /activityStartAt: replacementRange\.startAt/);
  assert.match(main, /activityEndAt: replacementRange\.endAt/);
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
  assert.match(main, /review:test:evaluate-protocol/);
  assert.match(main, /reviewStore\.evaluateProtocol\(\{ testId: request\?\.testId, cycles: cycleWorkspace\.cycles \}\)/);
  assert.match(preload, /evaluateProtocol: \(request\) => ipcRenderer\.invoke\("review:test:evaluate-protocol"/);
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

test("review numeric presentation preserves unknown values and labels R metrics", async () => {
  const script = await source("review.js");
  const strictNumber = script.match(
    /function strictFiniteReviewNumber\(value\) \{[\s\S]*?\n  \}/,
  )?.[0] ?? "";
  const protocolLock = script.match(
    /function deterministicProtocolLockReason\(test\) \{[\s\S]*?\n  \}/,
  )?.[0] ?? "";

  assert.match(strictNumber, /value == null \|\| typeof value === "boolean"/);
  assert.match(strictNumber, /typeof value === "string" && !value\.trim\(\)/);
  assert.match(strictNumber, /\["number", "string"\]\.includes\(typeof value\)/);
  for (const helper of ["formatNumber", "signedNumber", "signedPercent"]) {
    assert.match(script, new RegExp(`function ${helper}\\(value[\\s\\S]{0,180}strictFiniteReviewNumber\\(value\\)`));
  }
  assert.match(script, /function signedR\(value\)[\s\S]{0,140}strictFiniteReviewNumber\(value\) == null \? "—"/);
  assert.match(script, /metricCell\("净R", signedR\(checkpoint\.netR \?\? checkpoint\.rMultiple\)\)/);
  assert.match(script, /metricCell\("MAE \/ MFE", `\$\{signedR\(checkpoint\.maeR\)\} \/ \$\{signedR\(checkpoint\.mfeR\)\}`\)/);
  assert.match(protocolLock, /strictFiniteReviewNumber\(test\?\.successThreshold\) == null/);
});

test("review element registry contains one learning-window binding", async () => {
  const script = await source("review.js");
  assert.equal(
    (script.match(/learningWindow:\s*document\.querySelector\("#review-learning-window"\)/g) ?? []).length,
    1,
  );
});
