import assert from "node:assert/strict";
import test from "node:test";
import { ResearchThesisStore, RESEARCH_THESIS_STORE_KEY, RESEARCH_THESIS_SCHEMA_VERSION, buildResearchThesisContext, validateResearchThesisState } from "../src/data/research-thesis-store.mjs";

const START = "2026-10-22T01:00:00.000Z";

function fixture(options = {}) {
  const values = new Map();
  let clock = START;
  let sequence = 0;
  const store = {
    async get(key) { return structuredClone(values.get(key)); },
    async set(key, value, commitOptions) { commitOptions?.commitGuard?.(); values.set(key, structuredClone(value)); },
  };
  const service = new ResearchThesisStore({ store, now: () => new Date(clock), idFactory: () => `record-${++sequence}`, ...options });
  return { service, values, store, tick(at = "2026-10-22T02:00:00.000Z") { clock = at; } };
}

test("research store supports one-line hypotheses independent of holdings with no forced stage", async () => {
  const { service } = fixture();
  assert.deepEqual(await service.snapshot(), { schemaVersion: RESEARCH_THESIS_SCHEMA_VERSION, revision: 0, updatedAt: null, theses: [] });
  const thesis = await service.create({ myView: "AI 投资增长会传导到现金流。" });
  assert.equal(thesis.name, "AI 投资增长会传导到现金流。");
  assert.equal(thesis.symbol, null);
  assert.equal(thesis.versions[0].fields.myView, "AI 投资增长会传导到现金流。");
  assert.equal(thesis.versions[0].fields.stage, null);
  assert.equal(thesis.versions[0].fields.marketBelief, null);
  assert.equal(thesis.revision, 1);
  assert.equal(thesis.createdAt, START);
});

test("research store persists append-only original judgments, separate market belief and reset stages", async () => {
  const { service, tick } = fixture();
  const original = await service.create({ name: "收入预期差", symbol: "nvda.us", myView: "增长可持续", marketBelief: "增速见顶", stage: "4E" });
  tick();
  const revised = await service.revise(original.id, { expectedRevision: 1, name: "等待独立确认", fields: { myView: "边际放缓但不恶化", stage: "2R", nextReviewAt: "2026-11-01T10:00:00+08:00" } });
  assert.deepEqual(revised.versions[0], original.versions[0]);
  assert.equal(revised.versions[1].fields.marketBelief, "增速见顶");
  assert.equal(revised.versions[1].fields.nextReviewAt, "2026-11-01T02:00:00.000Z");
  assert.equal(revised.symbol, "NVDA.US");
  assert.equal(revised.versions[1].fieldOrigins.marketBelief.recordedAt, START);
  assert.equal(revised.versions[1].fieldOrigins.myView.recordedAt, "2026-10-22T02:00:00.000Z");
  assert.equal(revised.revision, 2);
  await assert.rejects(service.revise(original.id, { expectedRevision: 2, stage: "4" }), { code: "research_stage_invalid" });
});

test("every existing-thesis write requires CAS and concurrent writes do not overwrite", async () => {
  const { service } = fixture();
  const thesis = await service.create({ myView: "初始" });
  const attempts = await Promise.allSettled([
    service.revise(thesis.id, { expectedRevision: 1, myView: "先提交" }),
    service.revise(thesis.id, { expectedRevision: 1, myView: "后提交" }),
  ]);
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(attempts.find((item) => item.status === "rejected").reason.code, "research_revision_conflict");
  await assert.rejects(service.addEvidence(thesis.id, { claim: "缺少版本号" }), { code: "research_revision_conflict" });
  await assert.rejects(service.setStatus(thesis.id, { status: "archived" }), { code: "research_revision_conflict" });
  assert.equal((await service.snapshot()).theses[0].versions[1].fields.myView, "先提交");
});

test("evidence timestamps are host-authored and declared dates do not create point-in-time proof", async () => {
  const { service, tick } = fixture();
  let thesis = await service.create({ myView: "需要验证" });
  tick();
  thesis = await service.addEvidence(thesis.id, { expectedRevision: 1, claim: "文件报告收入增长", kind: "fact", stance: "support", sourceTitle: "IR 声明", url: "https://example.com/ir", publishedAt: "2026-09-01T00:00:00Z", knownAt: "2026-09-01T00:00:00Z", recordedAt: "2026-09-01T00:00:00Z", retrievedAt: "2026-09-01T00:00:00Z", provenance: "verified" });
  const evidence = thesis.evidence[0];
  assert.equal(evidence.knownAt, "2026-09-01T00:00:00.000Z");
  assert.equal(evidence.recordedAt, "2026-10-22T02:00:00.000Z");
  assert.equal(evidence.retrievedAt, null);
  assert.equal(evidence.retrievalStatus, "not_host_verified");
  assert.equal(evidence.knownAtVerified, false);
  assert.equal(evidence.pointInTimeEligible, false);
  assert.equal(evidence.provenance, "manual_unverified");
  assert.equal(buildResearchThesisContext(thesis, { asOf: START }).evidence.length, 0);
  assert.equal(buildResearchThesisContext(thesis, { asOf: START }).coverage.evidenceAfterCutoff, 1);
});

test("evidence preserves numeric zero with units, period, currency and explicit denominator", async () => {
  const { service } = fixture();
  let thesis = await service.create({ myView: "利润率验证" });
  thesis = await service.addEvidence(thesis.id, { expectedRevision: 1, claim: "经营利润暂时为零", numeric: { value: 0, unit: "USD million", period: "FY2026 Q3", currency: "USD", denominator: "GAAP revenue" } });
  assert.deepEqual(thesis.evidence[0].numeric, { value: 0, unit: "USD million", period: "FY2026 Q3", currency: "USD", denominator: "GAAP revenue" });
  thesis = await service.addEvidence(thesis.id, { expectedRevision: 2, claim: "尚未提供每股利润" });
  assert.equal(thesis.evidence[1].numeric, null);
  for (const numeric of [{ value: NaN }, { value: Infinity }, { value: "0" }, { unit: "%" }, { value: 1, denominator: Infinity }, { value: 1, currency: "usd" }]) {
    await assert.rejects(service.addEvidence(thesis.id, { expectedRevision: 3, claim: "不可用数字", numeric }), { code: "research_numeric_invalid" });
  }
  assert.equal((await service.snapshot()).theses[0].revision, 3);
});

test("evidence rejects credentials and non-web URLs without truncating or saving input", async () => {
  const { service } = fixture();
  const thesis = await service.create({ myView: "来源校验" });
  for (const url of ["javascript:alert(1)", "file:///tmp/secret", "https://user:secret@example.com/a", "not a url"]) {
    await assert.rejects(service.addEvidence(thesis.id, { expectedRevision: 1, claim: "来源", url }), { code: "research_url_invalid" });
  }
  await assert.rejects(service.addEvidence(thesis.id, { expectedRevision: 1, claim: "x".repeat(5001) }), { code: "research_text_limit" });
  assert.equal((await service.snapshot()).theses[0].evidence.length, 0);
});

test("observations append outcomes without changing user's thesis or stage", async () => {
  const { service, tick } = fixture();
  let thesis = await service.create({ myView: "预期改善", stage: "1" });
  const first = structuredClone(thesis.versions[0]);
  tick();
  thesis = await service.addObservation(thesis.id, { expectedRevision: 1, status: "confirmed", note: "出现第一组确认信息", eventAt: "2026-10-21T00:00:00Z" });
  assert.deepEqual(thesis.versions, [first]);
  assert.equal(thesis.observations[0].status, "confirmed");
  assert.equal(thesis.observations[0].recordedAt, "2026-10-22T02:00:00.000Z");
  assert.equal(thesis.versions[0].fields.stage, "1");
  await assert.rejects(service.addObservation(thesis.id, { expectedRevision: 2, status: "promote", note: "升级" }), { code: "research_observation_invalid" });
});

test("archival is reversible and never deletes evidence, judgments or links", async () => {
  const { service } = fixture();
  let thesis = await service.create({ myView: "归档再恢复" });
  thesis = await service.setStatus(thesis.id, { expectedRevision: 1, status: "archived" });
  assert.equal((await service.snapshot()).theses.length, 0);
  assert.equal((await service.snapshot({ includeArchived: true })).theses[0].id, thesis.id);
  await assert.rejects(service.revise(thesis.id, { expectedRevision: 2, myView: "不能改归档" }), { code: "research_archived" });
  thesis = await service.setStatus(thesis.id, { expectedRevision: 2, status: "watching" });
  assert.equal(thesis.status, "watching");
  assert.equal(thesis.statusHistory.length, 3);
  assert.equal((await service.snapshot()).theses.length, 1);
});

test("AI proposals stay separate until explicit approved field adoption, preserving originals", async () => {
  const { service, tick } = fixture();
  let thesis = await service.create({ myView: "原始判断", marketBelief: "用户认为的预期" });
  const original = structuredClone(thesis.versions[0]);
  tick();
  thesis = await service.saveProposal(thesis.id, { expectedRevision: 1, sourceRunId: "run-1", sourceThreadId: "thread-1", proposal: { fields: { myView: "AI 建议判断", marketBelief: "AI 市场假设" }, evidence: [{ claim: "AI 建议核实的来源", url: "https://example.com/ir", publishedAt: "2026-10-01T00:00:00Z" }], openQuestions: ["需要独立确认什么？"] } });
  assert.deepEqual(thesis.versions, [original]);
  const proposal = thesis.proposals[0];
  assert.equal(proposal.evidence[0].provenance, "ai_suggested_unverified");
  assert.equal(proposal.evidence[0].retrievedAt, null);
  assert.equal(proposal.evidence[0].retrievalStatus, "not_host_verified");
  assert.equal(proposal.baseRevision, 1);
  assert.equal(proposal.baseThesisVersion, 1);
  assert.equal(thesis.evidence.length, 0);
  await assert.rejects(service.acceptProposal(thesis.id, { expectedRevision: 2, proposalId: proposal.id, fields: { myView: "确认后编辑的判断" } }), { code: "research_confirmation_required" });
  await assert.rejects(service.acceptProposal(thesis.id, { expectedRevision: 2, proposalId: proposal.id, fields: {}, confirmed: true }), { code: "research_proposal_fields_invalid" });
  thesis = await service.acceptProposal(thesis.id, { expectedRevision: 2, proposalId: proposal.id, fields: { myView: "确认后编辑的判断" }, confirmed: true });
  assert.deepEqual(thesis.versions[0], original);
  assert.equal(thesis.versions[1].fields.myView, "确认后编辑的判断");
  assert.equal(thesis.versions[1].fields.marketBelief, "用户认为的预期");
  assert.equal(thesis.versions[1].fieldOrigins.myView.proposalId, proposal.id);
  assert.equal(thesis.versions[1].fieldOrigins.marketBelief.origin, "user");
  assert.equal(thesis.proposals[0].status, "adopted");
  assert.deepEqual(thesis.proposals[0].adoption.fields, ["myView"]);
  assert.equal(thesis.evidence.length, 0);
  assert.equal((await service.snapshot()).theses[0].versions.length, 2);
});

test("intervening evidence or newer proposals invalidate stale AI adoption", async () => {
  const { service } = fixture();
  let thesis = await service.create({ myView: "原始" });
  const input = { sourceRunId: "run", sourceThreadId: "thread", proposal: { fields: { marketBelief: "待确认" } } };
  thesis = await service.saveProposal(thesis.id, { ...input, expectedRevision: 1 });
  const id = thesis.proposals[0].id;
  thesis = await service.addEvidence(thesis.id, { expectedRevision: 2, claim: "新增反证", stance: "counter" });
  assert.equal(thesis.proposals[0].status, "superseded");
  await assert.rejects(service.acceptProposal(thesis.id, { expectedRevision: 3, proposalId: id, fields: { marketBelief: "待确认" }, confirmed: true }), { code: "research_proposal_stale" });
  thesis = await service.saveProposal(thesis.id, { ...input, expectedRevision: 3 });
  thesis = await service.saveProposal(thesis.id, { ...input, expectedRevision: 4 });
  assert.deepEqual(thesis.proposals.map((item) => item.status), ["superseded", "superseded", "pending"]);
});

test("proposals cannot smuggle account fields, a stage promotion action or raw model text", async () => {
  const { service } = fixture();
  const thesis = await service.create({ myView: "研究" });
  for (const proposal of ["raw markdown", { fields: { quantity: 100 } }, { fields: { stage: "auto_promote" } }, { fields: {} }]) {
    await assert.rejects(service.saveProposal(thesis.id, { expectedRevision: 1, sourceRunId: "r", sourceThreadId: "t", proposal }));
  }
  assert.equal((await service.snapshot()).theses[0].proposals.length, 0);
});

test("review links freeze exact bounded version and context without retrospectively becoming ex ante", async () => {
  const { service, tick } = fixture();
  let thesis = await service.create({ myView: "最初的判断", stage: "2" });
  tick();
  await assert.rejects(service.linkReview(thesis.id, { expectedRevision: 1, cycleId: "cycle-1", accountScopeId: "account-1", cycleTitle: "十月复盘" }), { code: "research_confirmation_required" });
  thesis = await service.linkReview(thesis.id, { expectedRevision: 1, cycleId: "cycle-1", accountScopeId: "account-1", cycleTitle: "十月复盘", confirmed: true });
  const link = structuredClone(thesis.reviewLinks[0]);
  assert.equal(link.thesisVersion, 1);
  assert.equal(link.thesisRecordedAt, START);
  assert.equal(link.linkedAt, "2026-10-22T02:00:00.000Z");
  assert.equal(link.contextSnapshot.fields.myView, "最初的判断");
  assert.equal(link.contextSnapshot.historicalPointInTimeVerified, false);
  assert.equal(link.interpretation, "supplementary_recorded_judgment_not_ex_ante_baseline");
  tick("2026-10-22T03:00:00.000Z");
  thesis = await service.revise(thesis.id, { expectedRevision: 2, myView: "事后的修正" });
  assert.deepEqual(thesis.reviewLinks[0], link);
  assert.notEqual(thesis.versions.at(-1).fields.myView, link.contextSnapshot.fields.myView);
});

test("duplicate links to identical thesis version and account-cycle are rejected", async () => {
  const { service } = fixture();
  let thesis = await service.create({ myView: "判断" });
  const input = { cycleId: "cycle", accountScopeId: "account", cycleTitle: "复盘", confirmed: true };
  thesis = await service.linkReview(thesis.id, { expectedRevision: 1, ...input });
  await assert.rejects(service.linkReview(thesis.id, { expectedRevision: 2, ...input }), { code: "research_review_duplicate" });
  thesis = await service.linkReview(thesis.id, { expectedRevision: 2, ...input, accountScopeId: "account-2" });
  assert.equal(thesis.reviewLinks.length, 2);
});

test("context cuts off host-recorded evidence, judgment changes and outcomes instead of declared publication dates", async () => {
  const { service, tick } = fixture();
  let thesis = await service.create({ myView: "原先看好", name: "原题目", stage: "2" });
  tick();
  thesis = await service.revise(thesis.id, { expectedRevision: 1, name: "事后改名", myView: "事后转谨慎", stage: "4F" });
  thesis = await service.addEvidence(thesis.id, { expectedRevision: 2, claim: "事后披露", knownAt: "2026-01-01T00:00:00Z" });
  thesis = await service.addObservation(thesis.id, { expectedRevision: 3, note: "结果很好", status: "confirmed", eventAt: "2026-01-01T00:00:00Z" });
  const context = buildResearchThesisContext(thesis, { asOf: START });
  assert.equal(context.name, "原题目");
  assert.equal(context.fields.myView, "原先看好");
  assert.equal(context.fields.stage, "2");
  assert.equal(context.revision, null);
  assert.equal(context.revisionAsOfUnverified, true);
  assert.deepEqual(context.evidence, []);
  assert.deepEqual(context.observations, []);
  assert.equal(context.coverage.evidenceAfterCutoff, 1);
  assert.equal(context.coverage.observationsAfterCutoff, 1);
  const before = buildResearchThesisContext(thesis, { asOf: "2026-10-21T00:00:00Z" });
  assert.equal(before.available, false);
  assert.equal(before.fields, null);
});

test("context is deterministic, bounded and explicitly reports omissions and text truncation", async () => {
  const { service } = fixture();
  let thesis = await service.create({ myView: "x".repeat(5000), marketBelief: "y".repeat(5000) });
  for (let index = 0; index < 20; index += 1) thesis = await service.addEvidence(thesis.id, { expectedRevision: thesis.revision, claim: `${index}:${"z".repeat(3000)}`, sourceTitle: "来源" });
  for (let index = 0; index < 5; index += 1) thesis = await service.addObservation(thesis.id, { expectedRevision: thesis.revision, note: `${index}:${"w".repeat(2000)}` });
  const options = { asOf: START, maxEvidence: 3, maxObservations: 2, maxChars: 6000, maxTextChars: 800 };
  const context = buildResearchThesisContext(thesis, options);
  assert.deepEqual(context, buildResearchThesisContext(thesis, options));
  assert.ok(JSON.stringify(context).length <= 6000);
  assert.equal(context.coverage.evidenceTotal, 20);
  assert.equal(context.coverage.observationsTotal, 5);
  assert.equal(context.coverage.evidenceOmitted, 20 - context.evidence.length);
  assert.equal(context.coverage.observationsOmitted, 5 - context.observations.length);
  assert.ok(context.coverage.truncatedTextFields > 0);
  assert.equal(context.coverage.truncated, true);
  const empty = buildResearchThesisContext(thesis, { maxEvidence: 0, maxObservations: 0 });
  assert.equal(empty.evidence.length, 0);
  assert.equal(empty.observations.length, 0);
});

test("store and context return detached data and survive serializable reloads", async () => {
  const { service, values } = fixture();
  const thesis = await service.create({ myView: "不能被引用改写" });
  thesis.versions[0].fields.myView = "篡改";
  const snapshot = await service.snapshot();
  snapshot.theses[0].versions[0].fields.myView = "再次篡改";
  const context = await service.context(thesis.id);
  context.fields.myView = "上下文篡改";
  assert.equal((await service.snapshot()).theses[0].versions[0].fields.myView, "不能被引用改写");
  const saved = JSON.parse(JSON.stringify(values.get(RESEARCH_THESIS_STORE_KEY)));
  const reloaded = new ResearchThesisStore({ store: { get: async () => saved, set: async () => {} } });
  assert.equal((await reloaded.snapshot()).theses[0].id, thesis.id);
});

test("malformed persisted state fails closed instead of defaulting, trimming or overwriting", async () => {
  for (const value of [{}, { schemaVersion: "old", revision: 0, theses: [] }, { schemaVersion: RESEARCH_THESIS_SCHEMA_VERSION, revision: -1, theses: [] }, { schemaVersion: RESEARCH_THESIS_SCHEMA_VERSION, revision: 1, updatedAt: START, theses: [{ id: "broken" }] }]) {
    let writes = 0;
    const service = new ResearchThesisStore({ store: { get: async () => value, set: async () => { writes += 1; } } });
    await assert.rejects(service.snapshot(), { code: "research_state_invalid" });
    await assert.rejects(service.create({ myView: "不能覆盖" }), { code: "research_state_invalid" });
    assert.equal(writes, 0);
  }
});

test("persisted content hash detects tampered immutable version, evidence, proposal and link snapshots", async () => {
  const { service, values } = fixture();
  let thesis = await service.create({ myView: "保持原始版本" });
  thesis = await service.addEvidence(thesis.id, { expectedRevision: 1, claim: "证据" });
  thesis = await service.saveProposal(thesis.id, { expectedRevision: 2, sourceRunId: "run", sourceThreadId: "thread", proposal: { fields: { myView: "草案" } } });
  thesis = await service.linkReview(thesis.id, { expectedRevision: 3, cycleId: "cycle", accountScopeId: "account", cycleTitle: "案例", confirmed: true });
  const persisted = structuredClone(values.get(RESEARCH_THESIS_STORE_KEY));
  for (const mutate of [
    (item) => { item.versions[0].fields.myView = "改过"; },
    (item) => { item.evidence[0].retrievedAt = "2026-01-01T00:00:00.000Z"; },
    (item) => { item.proposals[0].fields.myView = "改过草案"; },
    (item) => { item.reviewLinks[0].contextSnapshot.fields.myView = "改过关联"; },
  ]) {
    const corrupted = structuredClone(persisted);
    mutate(corrupted.theses[0]);
    values.set(RESEARCH_THESIS_STORE_KEY, corrupted);
    await assert.rejects(service.snapshot(), { code: "research_state_invalid" });
  }
  values.set(RESEARCH_THESIS_STORE_KEY, persisted);
  assert.equal((await service.snapshot()).theses[0].id, thesis.id);
});

test("failed durable write leaves prior record intact and queue remains usable", async () => {
  const { service, store } = fixture();
  const thesis = await service.create({ myView: "原始" });
  const originalSet = store.set;
  store.set = async () => { throw new Error("disk full"); };
  await assert.rejects(service.revise(thesis.id, { expectedRevision: 1, myView: "未保存" }), /disk full/);
  assert.equal((await service.snapshot()).theses[0].revision, 1);
  store.set = originalSet;
  const saved = await service.revise(thesis.id, { expectedRevision: 1, myView: "已保存" });
  assert.equal(saved.revision, 2);
});

test("write guards run before and during durable commit and never become global settings", async () => {
  let enabled = true;
  const { service, store, values } = fixture({ canWrite: () => enabled });
  const thesis = await service.create({ myView: "原始" });
  enabled = false;
  await assert.rejects(service.revise(thesis.id, { expectedRevision: 1, myView: "拒绝" }), { code: "research_stale_commit" });
  enabled = true;
  let guardCalls = 0;
  const originalSet = store.set;
  store.set = async (key, value, options) => {
    assert.equal(typeof options.commitGuard, "function");
    enabled = false;
    await originalSet(key, value, options);
  };
  await assert.rejects(service.revise(thesis.id, { expectedRevision: 1, myView: "提交前变更", commitGuard: () => { guardCalls += 1; return true; } }), { code: "research_stale_commit" });
  assert.ok(guardCalls >= 2);
  assert.equal(values.get(RESEARCH_THESIS_STORE_KEY).theses[0].revision, 1);
});

test("host clock cannot regress and user timestamps cannot backdate a thesis version", async () => {
  const { service, tick } = fixture();
  const thesis = await service.create({ myView: "原始", createdAt: "2020-01-01T00:00:00Z" });
  assert.equal(thesis.createdAt, START);
  tick("2026-10-21T00:00:00.000Z");
  await assert.rejects(service.revise(thesis.id, { expectedRevision: 1, myView: "倒填", recordedAt: "2020-01-01T00:00:00Z" }), { code: "research_clock_regression" });
  assert.equal((await service.snapshot()).theses[0].revision, 1);
});

test("date metadata requires timezone and real calendar date, missing remains null", async () => {
  const { service } = fixture();
  const thesis = await service.create({ myView: "时间口径" });
  for (const date of ["2026-10-22", "2026-10-22T01:00:00", "2026-02-30T00:00:00Z", "not date"]) {
    await assert.rejects(service.addEvidence(thesis.id, { expectedRevision: 1, claim: "时间", publishedAt: date }), { code: "research_timestamp_invalid" });
  }
  const saved = await service.addEvidence(thesis.id, { expectedRevision: 1, claim: "无来源时间" });
  assert.equal(saved.evidence[0].publishedAt, null);
  assert.equal(saved.evidence[0].knownAt, null);
});

test("new IDs must be unique and context capacity parameters are explicit", async () => {
  const { service } = fixture({ idFactory: () => "constant" });
  const thesis = await service.create({ myView: "研究" });
  await assert.rejects(service.create({ myView: "不重复标识" }), { code: "research_id_invalid" });
  for (const option of [{ maxEvidence: -1 }, { maxObservations: 200 }, { maxChars: 20 }, { maxTextChars: 0 }]) assert.throws(() => buildResearchThesisContext(thesis, option), { code: "research_context_limit" });
});

test("explicit nested field patches reject unsupported data rather than silently dropping it", async () => {
  const { service } = fixture();
  await assert.rejects(service.create({ fields: { myView: "判断", quantity: 100 } }), { code: "research_fields_invalid" });
  const thesis = await service.create({ fields: { myView: "判断" } });
  await assert.rejects(service.revise(thesis.id, { expectedRevision: 1, fields: { unknown: "不支持" } }), { code: "research_fields_invalid" });
  assert.equal((await service.snapshot()).theses[0].revision, 1);
});

test("explicit selected AI source adoption is atomic, time-stamped and remains unverified", async () => {
  const { service, tick } = fixture();
  let thesis = await service.create({ myView: "用户原判断" });
  thesis = await service.saveProposal(thesis.id, { expectedRevision: 1, sourceRunId: "run-ai", sourceThreadId: "thread-ai", proposal: {
    fields: { counterEvidence: "出现供需反证时重审" },
    evidence: [
      { claim: "第一条建议", sourceTitle: "IR", url: "https://example.com/ir", publishedAt: "2026-10-01T00:00:00Z", stance: "counter", numeric: { value: 0, unit: "%", denominator: "revenue" } },
      { claim: "未勾选的建议" },
    ],
  } });
  const proposal = structuredClone(thesis.proposals[0]);
  tick();
  thesis = await service.acceptProposal(thesis.id, { expectedRevision: 2, proposalId: proposal.id, fields: { counterEvidence: "出现供需反证时重审" }, selectedEvidenceIndexes: [0], confirmed: true });
  assert.equal(thesis.revision, 3, "sources are part of one atomic adoption, not independent extra revisions");
  assert.equal(thesis.evidence.length, 1);
  const evidence = thesis.evidence[0];
  assert.equal(evidence.thesisVersion, 2);
  assert.equal(evidence.claim, "第一条建议");
  assert.equal(evidence.provenance, "ai_accepted_unverified");
  assert.equal(evidence.numeric.value, 0);
  assert.equal(evidence.knownAtVerified, false);
  assert.equal(evidence.pointInTimeEligible, false);
  assert.equal(evidence.retrievedAt, null);
  assert.equal(evidence.retrievalStatus, "not_host_verified");
  assert.equal(evidence.recordedAt, "2026-10-22T02:00:00.000Z");
  assert.equal(evidence.acceptance.sourceRunId, "run-ai");
  assert.equal(evidence.acceptance.sourceThreadId, "thread-ai");
  assert.equal(evidence.acceptance.proposalId, proposal.id);
  assert.equal(evidence.acceptance.proposalEvidenceIndex, 0);
  assert.deepEqual(thesis.proposals[0].adoption.evidenceIds, [evidence.id]);
  assert.deepEqual(thesis.proposals[0].adoption.selectedEvidenceIndexes, [0]);
  assert.deepEqual(thesis.proposals[0].evidence, proposal.evidence, "original AI source suggestions remain unchanged");
  assert.equal((await service.context(thesis.id)).evidence[0].acceptance.acceptedByUser, true);
  assert.equal((await service.context(thesis.id)).evidence[0].retrievedAt, null);
  assert.equal((await service.context(thesis.id)).evidence[0].retrievalStatus, "not_host_verified");
  assert.equal(buildResearchThesisContext(thesis, { asOf: START }).evidence.length, 0);
  assert.equal((await service.snapshot()).theses[0].revision, 3);
});

test("AI source selection rejects duplicate or invalid indexes without partial judgment adoption", async () => {
  const { service } = fixture();
  let thesis = await service.create({ myView: "不变" });
  thesis = await service.saveProposal(thesis.id, { expectedRevision: 1, sourceRunId: "run", sourceThreadId: "thread", proposal: { fields: { myView: "建议" }, evidence: [{ claim: "唯一来源" }] } });
  for (const selectedEvidenceIndexes of [[0, 0], [-1], [1], [0.5], ["0"], "0"]) {
    await assert.rejects(service.acceptProposal(thesis.id, { expectedRevision: 2, proposalId: thesis.proposals[0].id, fields: { myView: "建议" }, selectedEvidenceIndexes, confirmed: true }), { code: "research_proposal_evidence_invalid" });
  }
  const saved = (await service.snapshot()).theses[0];
  assert.equal(saved.revision, 2);
  assert.equal(saved.versions.length, 1);
  assert.equal(saved.evidence.length, 0);
  assert.equal(saved.proposals[0].status, "pending");
});

test("AI source selection rejects duplicate source content rather than inflating evidence count", async () => {
  const { service } = fixture();
  let thesis = await service.create({ myView: "判断" });
  const evidence = { claim: "重复的来源", url: "https://example.com/a" };
  thesis = await service.saveProposal(thesis.id, { expectedRevision: 1, sourceRunId: "r", sourceThreadId: "t", proposal: { fields: { myView: "建议" }, evidence: [evidence, evidence] } });
  await assert.rejects(service.acceptProposal(thesis.id, { expectedRevision: 2, proposalId: thesis.proposals[0].id, fields: { myView: "建议" }, selectedEvidenceIndexes: [0, 1], confirmed: true }), { code: "research_evidence_duplicate" });
  assert.equal((await service.snapshot()).theses[0].evidence.length, 0);
});

test("known-key backup validation is detached, strict and performs no storage operations", async () => {
  const { service, values } = fixture();
  const thesis = await service.create({ myView: "备份前原始判断" });
  const persisted = values.get(RESEARCH_THESIS_STORE_KEY);
  const validated = validateResearchThesisState(persisted);
  assert.deepEqual(validated, persisted);
  validated.theses[0].versions[0].fields.myView = "不应改写备份来源";
  assert.equal(persisted.theses[0].versions[0].fields.myView, "备份前原始判断");
  for (const invalid of [undefined, null, false, [], {}, { ...persisted, schemaVersion: "unknown" }, { ...persisted, theses: [null] }]) {
    assert.throws(() => validateResearchThesisState(invalid), { code: "research_state_invalid" });
  }
  const corrupt = structuredClone(persisted);
  corrupt.theses[0].versions[0].fields.myView = "无效指纹";
  assert.throws(() => validateResearchThesisState(corrupt), { code: "research_state_invalid" });
  assert.equal((await service.snapshot()).theses[0].id, thesis.id);
});
