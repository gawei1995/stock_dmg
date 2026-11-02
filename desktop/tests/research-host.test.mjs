import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { ResearchThesisStore, RESEARCH_THESIS_STORE_KEY, validateResearchThesisState } from "../src/data/research-thesis-store.mjs";
import { buildResearchThesisContext } from "../src/data/research-thesis-store.mjs";
import { buildAnalysisEvidence } from "../src/engine/agent.mjs";
import { applyCodexWorkspaceAnalysis } from "../src/engine/codex-workspace.mjs";
import { randomUUID } from "node:crypto";
import { assertResearchReviewLink, eligibleResearchReviewCycles } from "../src/review/research-links.mjs";

const source = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
function fixture() {
  const routes = new Map(), data = new Map(); let frozen = false, scope = "scope-a", ids = 0;
  const researchThesisStore = new ResearchThesisStore({ store: {
    get: async key => structuredClone(data.get(key)),
    set: async (key, value, options) => { options?.commitGuard?.(); data.set(key, structuredClone(value)); },
  }, now: () => new Date("2026-10-22T08:00:00Z"), idFactory: () => `host-${++ids}` });
  const cycles = [{ id: "cycle-a", title: "AAPL cycle", symbols: ["AAPL.US"], brokerLinks: { accountScopeId: "scope-a" } },
    { id: "cycle-b", title: "Other account", symbols: ["AAPL.US"], brokerLinks: { accountScopeId: "scope-b" } }];
  const context = vm.createContext({
    ipcMain: { handle: (name, handler) => routes.set(name, handler) },
    researchThesisStore, reviewCycleStore: { snapshot: async () => ({ cycles: structuredClone(cycles) }) },
    assertTrustedSender: event => { if (!event?.trusted) throw new Error("untrusted sender"); },
    assertTrustedRestoreIdle: () => { if (frozen) throw new Error("restore frozen"); },
    currentPortfolioLedgerScopeId: () => scope,
    captureReviewAccountOperation: () => ({ scopeId: scope }),
    assertReviewAccountOperation: identity => { if (identity.scopeId !== scope) throw new Error("account changed"); },
    assertResearchReviewLink, eligibleResearchReviewCycles, reviewLearningMutationQueue: Promise.resolve(),
  });
  const helperStart = source.indexOf("async function buildResearchSnapshot(");
  const helperEnd = source.indexOf("\nasync function buildReviewSnapshot", helperStart);
  vm.runInContext(source.slice(helperStart, helperEnd), context);
  const queueStart = source.indexOf("function withReviewLearningMutation(");
  vm.runInContext(source.slice(queueStart, source.indexOf("\nasync function ", queueStart)), context);
  const start = source.indexOf('  ipcMain.handle("research:snapshot"');
  const end = source.indexOf('  ipcMain.handle("review:backup:export"', start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  return { routes, data, researchThesisStore, context, cycles,
    call: (name, request = {}, trusted = true) => routes.get(name)({ trusted }, request),
    freeze: () => { frozen = true; }, scope: value => { scope = value; } };
}

test("research IPC creates without a broker, updates via CAS and rejects untrusted renderer", async () => {
  const f = fixture(); f.scope(null);
  const response = await f.call("research:create", { symbol: "AAPL.US", myView: "short original" });
  assert.equal(response.ok, true);
  assert.equal(response.snapshot.theses.length, 1);
  assert.deepEqual(Array.from(response.snapshot.reviewCycles), []);
  const id = response.thesis.id;
  await f.call("research:revise", { id, expectedRevision: 1, myView: "revised" });
  await assert.rejects(f.call("research:revise", { id, expectedRevision: 1, myView: "stale overwrite" }), /变化/);
  assert.equal((await f.researchThesisStore.snapshot()).theses[0].versions.at(-1).fields.myView, "revised");
  await assert.rejects(f.call("research:snapshot", {}, false), /untrusted/);
});

test("research writes participate in restore barrier even if queued before restore", async () => {
  const f = fixture();
  let release;
  f.context.reviewLearningMutationQueue = new Promise(resolve => { release = resolve; });
  const pending = f.call("research:create", { myView: "must not commit" });
  f.freeze(); release();
  await assert.rejects(pending, /restore frozen/);
  assert.equal((await f.researchThesisStore.snapshot()).theses.length, 0);
});

test("research review linkage validates cycle/symbol/account and requires explicit confirmation", async () => {
  const f = fixture();
  const { thesis } = await f.call("research:create", { symbol: "AAPL.US", myView: "first" });
  await assert.rejects(f.call("research:review:link", { id: thesis.id, expectedRevision: 1, cycleId: "cycle-b", confirmed: true }), /订单归属/);
  await assert.rejects(f.call("research:review:link", { id: thesis.id, expectedRevision: 1, cycleId: "cycle-a" }), /确认/);
  const linked = await f.call("research:review:link", { id: thesis.id, expectedRevision: 1, cycleId: "cycle-a", confirmed: true });
  assert.equal(linked.thesis.reviewLinks[0].accountScopeId, "scope-a");
  assert.equal(linked.thesis.reviewLinks[0].contextSnapshot.fields.myView, "first");
  assert.deepEqual(Array.from(linked.snapshot.reviewCycles, x => x.id), ["cycle-a"]);
});

test("research module is encrypted business data in existing backup root, not credentials or another harness", async () => {
  const preload = await readFile(new URL("../preload.cjs", import.meta.url), "utf8");
  const invoked = [];
  let bridge;
  vm.runInNewContext(preload, { require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
    ipcRenderer: { invoke: (...args) => invoked.push(args), on() {}, removeListener() {} } }) });
  bridge.research.revise({ id: "id", expectedRevision: 1, myView: "text" });
  assert.equal(invoked[0][0], "research:revise");
  assert.match(source, /researchThesisStore = new ResearchThesisStore\(\{ store: reviewDataStore/);
  const run = source.slice(source.indexOf('ipcMain.handle("agent:run"'), source.indexOf('ipcMain.handle("agent:cancel"'));
  assert.match(run, /researchProposalPersistence = "not_saved"/);
  assert.match(run, /expectedRevision: localRun.context.researchThesisRevision/);
  assert.match(run, /if \(reviewPhase !== "blind"\) \{\s*const researchWorkspace/);
});

test("broker reauthorization cancels account-bound analysis but does not cancel free research", () => {
  const research = new AbortController(), position = new AbortController(), legacy = new AbortController();
  const context = vm.createContext({
    longbridgeAuthorizationLifecycle: { advance: () => 2 },
    activeAgentOperations: new Map([
      ["research", { scope: "chat", controller: research }],
      ["position", { scope: "position", controller: position }],
      ["legacy", { controller: legacy }],
    ]),
  });
  const start = source.indexOf("function invalidateLongbridgeAuthorizationLifecycle(");
  const end = source.indexOf("\nasync function ", start);
  vm.runInContext(source.slice(start, end), context);
  assert.equal(context.invalidateLongbridgeAuthorizationLifecycle(), 2);
  assert.equal(research.signal.aborted, false);
  assert.equal(position.signal.aborted, true);
  assert.equal(legacy.signal.aborted, true);
});

test("backup validates the research key without dropping it, reading credentials or inventing an empty ledger", async () => {
  const f = fixture();
  await f.call("research:create", { myView: "backup preserved original" });
  const context = vm.createContext({ safeStorage: { isEncryptionAvailable: () => true, decryptString: value => value.toString() },
    RESEARCH_THESIS_STORE_KEY, validateResearchThesisState,
  });
  const start = source.indexOf("async function validateTrustedBackupPayload(");
  const end = source.indexOf("\nfunction ", start);
  vm.runInContext(source.slice(start, end), context);
  const original = { unrelatedExistingBusinessData: { retained: true }, [RESEARCH_THESIS_STORE_KEY]: await f.researchThesisStore.snapshot({ includeArchived: true }) };
  const result = await context.validateTrustedBackupPayload({ name: "review-data.bin", payload: Buffer.from(JSON.stringify(original)) });
  assert.equal(result.document[RESEARCH_THESIS_STORE_KEY].theses[0].versions[0].fields.myView, "backup preserved original");
  assert.equal(result.document.unrelatedExistingBusinessData.retained, true);
  await assert.rejects(context.validateTrustedBackupPayload({ name: "review-data.bin", payload: Buffer.from(JSON.stringify({ [RESEARCH_THESIS_STORE_KEY]: null })) }), /研究/);
});

async function researchRunFixture({ onAnalyze = async () => {} } = {}) {
  const f = fixture();
  const { thesis } = await f.call("research:create", { symbol: "AAPL.US", myView: "original causal judgment" });
  const events = [], modelInputs = [];
  Object.assign(f.context, {
    AbortController, randomUUID, buildAnalysisEvidence, buildResearchThesisContext, applyCodexWorkspaceAnalysis,
    validateAnalysisScope: value => { assert.equal(value, "chat"); return value; }, brokerScope: value => value,
    ibkr: { config: { enabled: false }, generation: 1 },
    longbridgeAuthorizationLifecycle: { capture: () => 1 },
    validateOperationId: value => value || null, validateThreadId: value => value,
    finiteOrNull: value => value == null ? null : Number(value), clamp: (n, low, high) => Math.min(high, Math.max(low, n)),
    safeError: error => error.message,
    activeAgentOperations: new Map(), activeAgentByThread: new Map(),
    codexAnalysis: { status: () => ({ threadId: "research-thread" }), cachePendingUserMessage: async () => {},
      clearPendingOperation() {}, analyze: async input => {
        modelInputs.push(input); await onAnalyze(f, thesis.id);
        return { text: "研究正文完整返回", provider: "synthetic native model", elapsedMs: 1, firstActivityMs: 1,
          threadId: "research-thread", requestedSkills: ["analyze-market-narratives"], requestedApps: [],
          toolEvents: [], toolsUsed: [], resultDelivery: { complete: true },
          researchProposal: { fields: { marketBelief: "model proposal, pending confirmation" }, evidence: [], openQuestions: [] } };
      } },
    sendStatus: event => events.push(event), safeSend: (channel, payload) => events.push({ channel, payload }),
    agentResults: { save: async () => {} }, agentFailureEnvelope: error => ({ error: error.message }),
    // Any accidental private-data fetch makes this executable host path fail.
    portfolioService: new Proxy({}, { get: () => { throw new Error("unexpected broker access"); } }),
  });
  const settleStart = source.indexOf("function settleActiveAgentOperation(");
  vm.runInContext(source.slice(settleStart, source.indexOf("\nfunction ", settleStart + 1)), f.context);
  const start = source.indexOf('  ipcMain.handle("agent:run"');
  const end = source.indexOf('  ipcMain.handle("agent:cancel"', start);
  vm.runInContext(source.slice(start, end), f.context);
  return { ...f, thesis, events, modelInputs };
}

test("production host research request delivers selected context, saves only a pending draft and settles the answer", async () => {
  const f = await researchRunFixture();
  const run = await f.call("agent:run", { scope: "chat", threadId: "research-thread", operationId: "operation-success",
    researchThesisId: f.thesis.id, researchIntent: "update", task: "research without a portfolio" });
  assert.equal(f.modelInputs[0].portfolio, null);
  assert.equal(f.modelInputs[0].run.analysisContext.researchThesis.fields.myView, "original causal judgment");
  assert.equal(run.context.researchProposalPersistence, "recorded_pending_confirmation");
  assert.equal(run.conclusion.body, "研究正文完整返回");
  const thesis = (await f.researchThesisStore.snapshot()).theses[0];
  assert.equal(thesis.versions.length, 1);
  assert.equal(thesis.proposals[0].status, "pending");
  assert.equal(thesis.proposals[0].sourceThreadId, "research-thread");
  assert.equal(f.context.activeAgentOperations.size, 0);
  assert.ok(f.events.some(event => event.channel === "cockpit:agent-result" && event.payload.run.id === run.id));
});

test("a newer user edit prevents stale model draft persistence without losing the completed model answer", async () => {
  const f = await researchRunFixture({ onAnalyze: async (fixture, id) => {
    await fixture.researchThesisStore.revise(id, { expectedRevision: 1, myView: "new independent user edit" });
  } });
  const run = await f.call("agent:run", { scope: "chat", threadId: "research-thread", operationId: "operation-stale",
    researchThesisId: f.thesis.id, researchIntent: "update", task: "research with concurrent edit" });
  assert.equal(run.context.researchProposalPersistence, "not_saved");
  assert.equal(run.conclusion.body, "研究正文完整返回");
  assert.match(run.context.researchProposalPersistenceError, /变化/);
  const thesis = (await f.researchThesisStore.snapshot()).theses[0];
  assert.equal(thesis.proposals.length, 0);
  assert.equal(thesis.versions.at(-1).fields.myView, "new independent user edit");
  assert.equal(f.context.activeAgentOperations.size, 0);
});
