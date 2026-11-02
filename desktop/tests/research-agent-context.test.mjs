import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAnalysisEvidence } from "../src/engine/agent.mjs";
import {
  applyCodexWorkspaceAnalysis,
  buildCodexEvidence,
  buildWorkspaceAdditionalContext,
  buildWorkspacePrompt,
  CodexWorkspaceService,
  validateWorkspaceEvidenceDelivery,
  workspaceContextDiagnostics,
} from "../src/engine/codex-workspace.mjs";
import {
  assertResearchThreadBinding,
  normalizeResearchProposal,
  normalizeResearchThreadBinding,
  researchInstructions,
  researchProposalOutputSchema,
  researchThreadBindingContext,
  supportsResearchProposal,
} from "../src/engine/research-contract.mjs";

const proposal = () => ({
  fields: { myView: "需求需要验证", marketBelief: "待核验", expectationGap: "订单兑现或存在差异", stage: "2R" },
  evidence: [{ claim: "需要核验来源", stance: "counter", sourceTitle: "Synthetic source",
    url: "https://example.com/report", publishedAt: "2026-10-01", numeric: {
      value: 0, unit: "%", period: "FY2026 Q3", currency: null, denominator: "revenue" } }],
  openQuestions: ["最新指引是否改变？"],
});

async function selectedRun({ id = "thesis-a", revision = 1, intent = "update" } = {}) {
  const run = await buildAnalysisEvidence({ scope: "chat", portfolio: null, task: "更新研究" });
  run.context = { ...run.context, researchThesisId: id, researchThesisRevision: revision, researchIntent: intent };
  run.analysisContext.researchThesis = {
    schemaVersion: "research-thesis-context/v1", id, revision, name: "Synthetic research", symbol: "TEST.US",
    asOf: "2026-10-01T00:00:00.000Z", recordedAt: "2026-10-01T01:00:00.000Z", version: 1,
    fields: { myView: "USER VIEW" }, evidence: [], observations: [],
    coverage: { evidenceKnownByCutoff: 41, evidenceIncluded: 16, evidenceOmitted: 25,
      observationsKnownByCutoff: 3, observationsIncluded: 3, observationsOmitted: 0 },
    limitations: ["AI proposals are unverified"],
  };
  return run;
}

test("research proposal schema is strict, nullable, bounded and has no order or account write fields", () => {
  const schema = researchProposalOutputSchema();
  assert.deepEqual(schema.required, ["analysisMarkdown", "researchProposal"]);
  assert.equal(schema.properties.researchProposal.anyOf[1].type, "null");
  const walk = node => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
    }
    for (const child of Object.values(node)) if (child && typeof child === "object") {
      if (Array.isArray(child)) child.forEach(walk); else walk(child);
    }
  };
  walk(schema);
  const p = schema.properties.researchProposal.anyOf[0];
  assert.equal(p.properties.evidence.maxItems, 16);
  assert.equal(p.properties.openQuestions.maxItems, 12);
  assert.equal(p.properties.evidence.items.properties.numeric.anyOf[0].properties.value.type, "number");
  assert.ok(!JSON.stringify(schema).includes("submit_order"));
});

test("proposal normalization strips unknown fields, preserves real zero and never coerces numeric strings", () => {
  const raw = proposal(); raw.approved = true; raw.fields.accountScopeId = "MUST_NOT_PASS";
  raw.evidence[0].verified = true;
  const normalized = normalizeResearchProposal(raw);
  assert.deepEqual(Object.keys(normalized), ["fields", "evidence", "openQuestions"]);
  assert.equal(normalized.fields.stage, "2R");
  assert.equal(normalized.fields.nextReviewAt, null);
  assert.equal(normalized.evidence[0].numeric.value, 0);
  assert.equal(normalized.evidence[0].publishedAt, "2026-10-01T00:00:00.000Z");
  assert.ok(!JSON.stringify(normalized).includes("MUST_NOT_PASS"));
  assert.equal(normalized.evidence[0].verified, undefined);
  for (const value of ["0", "", null, false, Number.NaN, Number.POSITIVE_INFINITY]) {
    raw.evidence[0].numeric.value = value;
    assert.equal(normalizeResearchProposal(raw).evidence[0].numeric, null);
  }
  raw.fields.nextReviewAt = "2026-02-31";
  raw.fields.stage = "automatic_promotion";
  assert.equal(normalizeResearchProposal(raw).fields.nextReviewAt, null);
  assert.equal(normalizeResearchProposal(raw).fields.stage, null);
  raw.fields.nextReviewAt = "2026-10-22T12:00";
  raw.evidence[0].publishedAt = "2026-10-21T09:30:00";
  assert.equal(normalizeResearchProposal(raw).fields.nextReviewAt, null);
  assert.equal(normalizeResearchProposal(raw).evidence[0].publishedAt, null);
  raw.fields.nextReviewAt = "2026-10-22T12:00:00+08:00";
  assert.equal(normalizeResearchProposal(raw).fields.nextReviewAt, "2026-10-22T04:00:00.000Z");
  assert.equal(normalizeResearchProposal({}), null);
  assert.equal(normalizeResearchProposal(null), null);
  assert.equal(raw.fields.accountScopeId, "MUST_NOT_PASS", "normalization must not mutate model input");
});

test("proposal sources reject credentials and executable schemes, and text sequences are bounded", () => {
  const raw = proposal();
  raw.evidence = Array.from({ length: 30 }, (_, index) => ({ claim: `claim ${index}`, stance: "context",
    sourceTitle: "x".repeat(900), url: index % 2 ? "javascript:alert(1)" : "https://user:secret@example.com/path",
    publishedAt: "tomorrow", numeric: { value: 12, unit: "", period: null } }));
  raw.openQuestions = Array.from({ length: 40 }, (_, index) => `question ${index}`);
  raw.fields.myView = "x".repeat(9_000); raw.fields.nextReviewAt = "tomorrow";
  const normalized = normalizeResearchProposal(raw);
  assert.equal(normalized.fields.myView.length, 4_000);
  assert.equal(normalized.fields.nextReviewAt, null);
  assert.equal(normalized.evidence.length, 16);
  assert.equal(normalized.openQuestions.length, 12);
  for (const row of normalized.evidence) {
    assert.equal(row.url, null); assert.equal(row.publishedAt, null); assert.equal(row.numeric, null);
    assert.equal(row.sourceTitle.length, 300);
  }
});

test("only explicit selected chat update asks for a research proposal", async () => {
  const run = await selectedRun();
  const evidence = buildCodexEvidence({ portfolio: null, run, task: "update" });
  assert.equal(supportsResearchProposal(evidence), true);
  assert.equal(supportsResearchProposal({ ...evidence, analysisScope: "candidate" }), false);
  assert.equal(supportsResearchProposal({ ...evidence, context: { ...evidence.context, researchIntent: "discuss" } }), false);
  assert.equal(supportsResearchProposal({ ...evidence, scopedContext: {} }), false);
  assert.match(researchInstructions(evidence), /未核验的 AI 来源建议/);
  assert.match(buildWorkspacePrompt(evidence), /禁止直接改写已采纳判断/);
  assert.match(buildWorkspacePrompt(evidence), /公司 IR 原文和正式指引/);
  assert.match(buildWorkspacePrompt(evidence), /两组独立证据/);
  assert.match(buildWorkspacePrompt(evidence), /null 表示本轮不提议更改/);
});

test("selected research context and bounded coverage reach the wire exactly and reject tampering", async () => {
  const run = await selectedRun();
  const evidence = buildCodexEvidence({ portfolio: null, run, task: "update" });
  assert.equal(evidence.dataQuality.portfolioStatus, "not_attached_to_free_research");
  const contexts = buildWorkspaceAdditionalContext(evidence, "instructions");
  const research = JSON.parse(contexts["trading-cockpit-evidence-research-thesis"].value);
  assert.deepEqual(research.researchThesis.coverage, run.analysisContext.researchThesis.coverage);
  assert.deepEqual(research.researchThesis, run.analysisContext.researchThesis);
  const coverage = validateWorkspaceEvidenceDelivery(evidence, contexts);
  assert.ok(coverage.some(item => item.sourcePath === "scopedContext.researchThesis"));
  const manifest = workspaceContextDiagnostics(contexts);
  assert.equal(manifest.deliveryStatus, "complete_with_declared_omissions");
  assert.deepEqual(manifest.semanticOmissions.map(item => [item.path, item.omittedCount]), [["researchThesis.evidence", 25]]);
  const changed = structuredClone(contexts);
  research.researchThesis.coverage.evidenceOmitted = 0;
  changed["trading-cockpit-evidence-research-thesis"].value = JSON.stringify(research);
  assert.throws(() => validateWorkspaceEvidenceDelivery(evidence, changed), /researchThesis/);
  delete changed["trading-cockpit-evidence-research-thesis"];
  assert.throws(() => validateWorkspaceEvidenceDelivery(evidence, changed), /researchThesis/);
});

test("plain chat has no research block and rejects unsolicited research evidence", async () => {
  const plain = await buildAnalysisEvidence({ scope: "chat", portfolio: null, task: "hello" });
  const evidence = buildCodexEvidence({ portfolio: null, run: plain, task: "hello" });
  const contexts = buildWorkspaceAdditionalContext(evidence, "instructions");
  assert.equal(Object.keys(contexts).some(key => key.includes("research-thesis")), false);
  contexts["trading-cockpit-evidence-research-thesis"] = { kind: "application", value: JSON.stringify({ block: "research-thesis", researchThesis: { id: "unsolicited" } }) };
  assert.throws(() => validateWorkspaceEvidenceDelivery(evidence, contexts), /未显式选择/);
});

test("research identity, revision and intent mismatches fail before sending context", async () => {
  for (const mutate of [
    run => { run.analysisContext.researchThesis.id = "other"; },
    run => { run.analysisContext.researchThesis.revision = 99; },
    run => { run.context.researchThesisRevision = null; },
    run => { run.context.researchIntent = "auto_adopt"; },
  ]) {
    const run = await selectedRun(); mutate(run);
    assert.throws(() => buildCodexEvidence({ portfolio: null, run, task: "update" }), /研究主线/);
  }
});

test("blind review rejects research links physically; nonblind overview preserves exact frozen references", () => {
  const reference = { thesisId: "thesis-a", version: 1, hash: "frozen-source", linkedAt: "2026-10-01T00:00:00Z",
    snapshot: { fields: { myView: "RETROSPECTIVE RESEARCH" } } };
  const evidence = { analysisScope: "review", context: { reviewProtocol: "decision_cycle", reviewPhase: "retrospective" },
    scopedContext: { reviewProtocol: "decision_cycle", phase: "retrospective", cycle: { id: "cycle-1" }, researchReferences: [reference] } };
  const contexts = buildWorkspaceAdditionalContext(evidence, buildWorkspacePrompt(evidence));
  assert.ok(JSON.stringify(contexts).includes("frozen-source"));
  assert.match(researchInstructions(evidence), /不得把它升级为封存事前基线/);
  const overview = JSON.parse(contexts["trading-cockpit-evidence"].value);
  overview.scopedContext.researchReferences[0].version = 2;
  const tampered = structuredClone(contexts);
  tampered["trading-cockpit-evidence"].value = JSON.stringify(overview);
  assert.throws(() => validateWorkspaceEvidenceDelivery(evidence, tampered), /overview/);
  const blind = { ...evidence, context: { ...evidence.context, reviewPhase: "blind" },
    scopedContext: { ...evidence.scopedContext, phase: "blind" } };
  assert.throws(() => buildWorkspaceAdditionalContext(blind, "blind"), /盲态复盘不得携带研究/);
  assert.throws(() => validateWorkspaceEvidenceDelivery(blind, contexts), /盲态复盘不得携带研究/);
});

test("apply preserves human-readable model answer and only exposes proposal for explicit updates", async () => {
  const run = await selectedRun();
  const analysis = { text: "# 研究回答\n\n保留正文。", researchProposal: proposal(), elapsedMs: 1,
    requestedSkills: [], requestedApps: [], toolEvents: [], actualSkillVersions: [] };
  const applied = applyCodexWorkspaceAnalysis(run, analysis);
  assert.match(applied.conclusion.body, /保留正文/);
  assert.equal(applied.researchProposal.fields.myView, "需求需要验证");
  assert.equal(run.researchProposal, undefined);
  const discussed = await selectedRun({ intent: "discuss" });
  assert.equal(applyCodexWorkspaceAnalysis(discussed, analysis).researchProposal, undefined);
});

test("research binding permits evolving revisions but only one thesis identity", () => {
  const binding = normalizeResearchThreadBinding({ researchThesisId: "thesis-a", revision: 1 });
  assert.deepEqual(researchThreadBindingContext(binding), { researchThesisId: "thesis-a" });
  assert.deepEqual(assertResearchThreadBinding(binding, { researchThesisId: "thesis-a", revision: 3 }), binding);
  assert.throws(() => assertResearchThreadBinding(binding, { researchThesisId: "thesis-b" }), /新建研究对话/);
  assert.equal(normalizeResearchThreadBinding({}), null);
});

test("production service requests native research output, keeps one binding and persists it across restart", async t => {
  const { service, rpc, store } = await serviceFixture(t);
  await service.prepare(); await service.refreshInventory();
  const id = service.threadId;
  await service.cachePendingUserMessage({ threadId: id, operationId: "pending-research", text: "Update my view" });
  const run = await selectedRun();
  const result = await service.analyze({ portfolio: null, run, task: "update", operationId: "pending-research" });
  assert.equal(result.text, "# Synthetic research\n\nKeep this answer.");
  assert.equal(result.researchProposal.fields.stage, "2R");
  assert.deepEqual(rpc.calls.find(call => call.method === "turn/start").params.outputSchema.required,
    ["analysisMarkdown", "researchProposal"]);
  let sessions = await service.listSessions();
  assert.deepEqual(sessions.sessions.find(item => item.id === id).researchContext, { researchThesisId: "thesis-a" });
  const registry = await store.get("codexWorkspaceThreadRegistry");
  assert.deepEqual(registry.threads.find(item => item.threadId === id).researchBinding, { researchThesisId: "thesis-a" });
  assert.equal(await store.get("researchThesesV1"), undefined, "engine never silently writes a research ledger");

  const revision2 = await selectedRun({ revision: 2 });
  await service.analyze({ portfolio: null, run: revision2, task: "continue" });
  const starts = rpc.calls.filter(call => call.method === "turn/start").length;
  await assert.rejects(service.analyze({ portfolio: null, run: await selectedRun({ id: "thesis-b" }), task: "other" }), { kind: "research_thread_binding" });
  const plain = await buildAnalysisEvidence({ scope: "chat", portfolio: null, task: "plain" });
  await assert.rejects(service.analyze({ portfolio: null, run: plain, task: "plain" }), /选择对应研究记录/);
  assert.equal(rpc.calls.filter(call => call.method === "turn/start").length, starts);

  const plainSession = await service.createSession({ name: "Ordinary research" });
  await service.refreshInventory();
  await service.analyze({ portfolio: null, run: plain, task: "plain" });
  assert.equal(rpc.calls.filter(call => call.method === "turn/start").at(-1).params.outputSchema, undefined);
  await service.switchSession(id); await service.refreshInventory();
  assert.deepEqual((await service.listSessions()).sessions.find(item => item.id === id).researchContext, { researchThesisId: "thesis-a" });
  assert.notEqual(plainSession.id, id);
  service.dispose(); await service.prepare(); await service.refreshInventory();
  sessions = await service.listSessions();
  assert.deepEqual(sessions.sessions.find(item => item.id === id).researchContext, { researchThesisId: "thesis-a" });
  await assert.rejects(service.analyze({ portfolio: null, run: plain, task: "plain" }), /选择对应研究记录/);
});

test("research service keeps raw answer when upstream ignores structured schema", async t => {
  const { service, rpc } = await serviceFixture(t);
  rpc.responseText = "A clear unstructured research answer.";
  await service.prepare(); await service.refreshInventory();
  const result = await service.analyze({ portfolio: null, run: await selectedRun(), task: "update" });
  assert.equal(result.text, rpc.responseText);
  assert.equal(result.researchProposal, null);
});

test("research-bound conversations cannot be reused as review conversations", async t => {
  const { service } = await serviceFixture(t);
  await service.prepare(); await service.refreshInventory();
  await service.analyze({ portfolio: null, run: await selectedRun(), task: "update" });
  const reviewRun = { context: { scope: "review", reviewProtocol: "decision_cycle", reviewCycleId: "cycle-1", reviewPhase: "retrospective" },
    analysisContext: { reviewProtocol: "decision_cycle", phase: "retrospective", cycle: { id: "cycle-1" } } };
  await assert.rejects(service.analyze({ portfolio: null, run: reviewRun, task: "review" }), /研究主线与历史复盘不能共用/);
});

test("first research binding rejects cheap known prior analysis history without a new remote probe", async t => {
  const { service, rpc } = await serviceFixture(t);
  await service.prepare(); await service.refreshInventory();
  const plain = await buildAnalysisEvidence({ scope: "chat", portfolio: null, task: "Prior unrelated analysis" });
  await service.analyze({ portfolio: null, run: plain, task: "Prior unrelated analysis" });
  await new Promise(resolve => setImmediate(resolve));
  await service.historyMutationQueue;
  const reads = rpc.calls.filter(call => call.method === "thread/turns/list").length;
  const starts = rpc.calls.filter(call => call.method === "turn/start").length;
  await assert.rejects(service.analyze({ portfolio: null, run: await selectedRun(), task: "bind" }), /已有分析历史/);
  assert.equal(rpc.calls.filter(call => call.method === "turn/start").length, starts);
  assert.equal(rpc.calls.filter(call => call.method === "thread/turns/list").length, reads);
});

test("concurrent first requests cannot replace the winning thesis binding", async t => {
  const { service, rpc } = await serviceFixture(t);
  await service.prepare(); await service.refreshInventory();
  const first = await selectedRun({ id: "thesis-a" });
  const second = await selectedRun({ id: "thesis-b" });
  const outcomes = await Promise.allSettled([
    service.analyze({ portfolio: null, run: first, task: "first" }),
    service.analyze({ portfolio: null, run: second, task: "second" }),
  ]);
  assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
  assert.ok(["research_thread_binding", "busy"].includes(outcomes.find(item => item.status === "rejected").reason.kind));
  assert.equal(rpc.calls.filter(call => call.method === "turn/start").length, 1);
  const winnerId = outcomes[0].status === "fulfilled" ? "thesis-a" : "thesis-b";
  const sessions = await service.listSessions();
  assert.equal(sessions.sessions.find(item => item.id === service.threadId).researchContext.researchThesisId, winnerId);
});

test("a plain request preparing a turn cannot concurrently acquire an unrelated research binding", async t => {
  const { service, rpc } = await serviceFixture(t);
  await service.prepare(); await service.refreshInventory();
  const plain = await buildAnalysisEvidence({ scope: "chat", portfolio: null, task: "plain" });
  const selected = await selectedRun();
  const outcomes = await Promise.allSettled([
    service.analyze({ portfolio: null, run: plain, task: "plain" }),
    service.analyze({ portfolio: null, run: selected, task: "selected" }),
  ]);
  assert.equal(outcomes[0].status, "fulfilled");
  assert.equal(outcomes[1].status, "rejected");
  assert.equal(outcomes[1].reason.kind, "busy");
  assert.equal(rpc.calls.filter(call => call.method === "turn/start").length, 1);
  assert.equal((await service.listSessions()).sessions.find(item => item.id === service.threadId).researchContext, null);
});

async function serviceFixture(t) {
  const workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), "cockpit-research-context-test-"));
  const store = new MemoryStore();
  let rpc;
  const service = new CodexWorkspaceService({ codexPath: "/synthetic/codex", workspaceDirectory, store,
    fingerprintSkills: async () => [], rpcFactory: hooks => {
      if (!rpc) rpc = new ResearchRpc(hooks); else rpc.options = hooks;
      return rpc;
    } });
  t.after(async () => {
    service.dispose(); await new Promise(resolve => setImmediate(resolve));
    await rm(workspaceDirectory, { recursive: true, force: true });
  });
  // Build the RPC before returning so tests can choose their synthetic answer.
  rpc = new ResearchRpc({ cwd: workspaceDirectory });
  return { service, store, rpc, workspaceDirectory };
}

class MemoryStore {
  values = new Map();
  async get(key) { return structuredClone(this.values.get(key)); }
  async set(key, value) { this.values.set(key, structuredClone(value)); }
}

class ResearchRpc {
  constructor(options) {
    this.options = options; this.calls = []; this.ready = false; this.sequence = 0;
    this.threads = new Map(); this.turns = new Map(); this.loaded = new Set();
    this.responseText = JSON.stringify({ analysisMarkdown: "# Synthetic research\n\nKeep this answer.", researchProposal: proposal() });
  }
  async start() { this.ready = true; }
  dispose() { this.ready = false; this.loaded.clear(); }
  respondResult() {}
  respondError() {}
  async request(method, params = {}) {
    this.calls.push({ method, params: structuredClone(params) });
    if (method === "config/read") return { config: {} };
    if (method === "app/installed") return { apps: [] };
    if (["app/list", "mcpServerStatus/list"].includes(method)) return { data: [], nextCursor: null };
    if (method === "skills/list") return { data: [{ cwd: this.options.cwd, skills: [], errors: [] }] };
    if (method === "thread/loaded/list") return { data: [...this.loaded], nextCursor: null };
    if (["thread/start", "thread/resume"].includes(method)) {
      const id = params.threadId ?? `research-thread-${++this.sequence}`;
      const thread = { id, cwd: this.options.cwd, ephemeral: false, createdAt: Math.floor(Date.now() / 1_000),
        updatedAt: Math.floor(Date.now() / 1_000), status: { type: "idle" } };
      this.threads.set(id, thread); this.loaded.add(id);
      return { thread, cwd: this.options.cwd, model: "synthetic", modelProvider: "synthetic" };
    }
    if (method === "thread/read") return { thread: this.threads.get(params.threadId) };
    if (method === "thread/list") return { data: [...this.threads.values()], nextCursor: null };
    if (method === "thread/turns/list") return { data: this.turns.get(params.threadId) ?? [], nextCursor: null };
    if (method === "turn/start") {
      const id = `research-turn-${this.calls.filter(call => call.method === "turn/start").length}`;
      const item = { type: "agentMessage", id: `message-${id}`, text: this.responseText };
      const completed = { id, status: "completed", items: [item] };
      this.turns.set(params.threadId, [completed]);
      setImmediate(() => {
        this.options.onNotification({ method: "item/completed", params: { threadId: params.threadId, turnId: id, item } });
        this.options.onNotification({ method: "turn/completed", params: { threadId: params.threadId, turn: completed } });
      });
      return { turn: { id, status: "inProgress", items: [] } };
    }
    return {};
  }
}
