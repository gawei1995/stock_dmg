// Explicit, opt-in live acceptance through the production service. This is
// never part of npm test or a release gate and never opens the installed app.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { buildAnalysisEvidence } from "../../src/engine/agent.mjs";
import { CodexAppServerRpc, CodexWorkspaceService, resolveCodexExecutable } from "../../src/engine/codex-workspace.mjs";
import { buildResearchThesisContext, ResearchThesisStore } from "../../src/data/research-thesis-store.mjs";

const TOOL_TYPES = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch", "imageView", "imageGeneration"]);
const hash = value => createHash("sha256").update(String(value)).digest("hex");
const safeCode = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : null;

export function parseP0Args(args) {
  const options = { live: false, timeoutMs: 300_000, report: null };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--live") options.live = true;
    else if (arg === "--plan") options.live = false;
    else if (arg === "--timeout-ms") options.timeoutMs = Number(args[++index]);
    else if (arg === "--report") options.report = args[++index];
    else throw new Error("Unknown P0 argument.");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 30_000 || options.timeoutMs > 900_000) throw new Error("P0 timeout must be 30000..900000 ms.");
  if (options.report != null && !path.isAbsolute(options.report)) throw new Error("P0 report must use an absolute path.");
  return options;
}

export const P0_SCOPE = Object.freeze({
  scope: "production_service_with_temporary_synthetic_file_store",
  liveModelCalls: 2,
  networkMode: "system_native_process_switch",
  accountAccess: "none",
  installedProfileAccess: "none",
  personalConversationAccess: "none",
  globalSettingsWrites: "none",
  workspace: "new_temporary_directory",
  requestedSkillsAndSources: "none",
  localToolPolicy: "prompt_forbids_tools_and_first_tool_event_aborts; not_a_native_zero_tool_sandbox",
  nativeHistory: "only_new_probe_threads; archive_on_exit",
});

// This adapter persists only this probe's synthetic data, using the production
// store interface. It does not substitute for the encrypted installed profile.
class SyntheticFileStore {
  constructor(filename) { this.filename = filename; this.queue = Promise.resolve(); this.revision = 0; this.data = {}; }
  async load() {
    try { this.data = JSON.parse(await readFile(this.filename, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return this;
  }
  async get(key) { await this.queue; return structuredClone(this.data[key] ?? null); }
  set(key, value, options) {
    const task = this.queue.then(async () => {
      options?.commitGuard?.();
      const next = { ...this.data, [key]: structuredClone(value) };
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      options?.commitGuard?.();
      await rename(temporary, this.filename);
      this.data = next;
      this.revision++;
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async flush() {
    for (let stable = 0, previous = -1; stable < 2;) {
      await this.queue;
      await nextTick();
      stable = previous === this.revision ? stable + 1 : 0;
      previous = this.revision;
    }
  }
}

function summarizedGuard(service) {
  const status = service.status();
  return { mode: status.researchMode.kind, ready: status.readOnlyGuardReady,
    diagnosticState: safeCode(status.readOnlyGuardDiagnostic.state), diagnosticCode: safeCode(status.readOnlyGuardDiagnostic.code),
    networkStatus: safeCode(status.network.status), networkStage: status.network.stage,
    externalMcpCount: status.mcpServerCount, appCount: status.appCount,
    blockedToolCount: status.brokerageWriteToolBlockCount, blockedAppCount: status.brokerageWriteAppBlockCount };
}

export async function runP0Live({ timeoutMs, report: requestedReport }) {
  const started = Date.now(), root = await mkdtemp(path.join(os.tmpdir(), "cockpit-p0-live-"));
  const workspace = path.join(root, "synthetic-workspace"), filename = path.join(root, "synthetic-state.json");
  await mkdir(workspace, { mode: 0o700 });
  const reportFile = requestedReport ?? path.join(os.tmpdir(), `cockpit-p0-${randomUUID()}.json`);
  const report = { schemaVersion: "p0-live-research/v1", startedAt: new Date(started).toISOString(), status: "unverified", scope: P0_SCOPE,
    fullMode: null, restrictedMode: null, calls: [], checks: {}, toolEvents: 0, serverToolRequests: 0,
    cleanup: {}, limits: ["Not an installed-user-profile, encrypted-store or real-order-cycle acceptance.",
      "Full mode is checked by native metadata only; both model calls use an independently verified restricted thread.",
      "No source fetching, Skills or real financial research are requested.",
      "A no-tools prompt plus cancellation observes tool compliance; it is not a hard native prohibition of local tools."] };
  const ownThreads = new Set(), controller = new AbortController();
  let service = null, stage = "runtime_discovery", call = null, timeout, cleaning = false;
  const fail = code => { const error = new Error(code); error.code = code; return error; };
  const abortTool = () => controller.abort(fail("unexpected_tool_activity"));
  const makeService = store => {
    controller.signal.throwIfAborted();
    const instance = new CodexWorkspaceService({ codexPath, workspaceDirectory: workspace, store, clientVersion,
      networkMode: "system", onStatus: event => {
        if (event.phase === "codex_turn_complete" && call) call.serviceTerminalMs = Date.now() - call.startedAt;
      },
      rpcFactory: options => {
        let rpc;
        rpc = new CodexAppServerRpc({ ...options,
          onNotification: message => {
            const item = message.params?.item;
            if (TOOL_TYPES.has(item?.type) && message.method === "item/started") { report.toolEvents++; abortTool(); }
            if (message.method === "turn/completed" && call) call.nativeTerminalMs = Date.now() - call.startedAt;
            options.onNotification(message);
          },
          onServerRequest: message => {
            if (message.method === "currentTime/read") return options.onServerRequest(message);
            report.serverToolRequests++;
            rpc.respondError(message.id, -32601, "This synthetic P0 acceptance does not permit tool or approval requests.");
            abortTool();
          },
        });
        const request = rpc.request.bind(rpc);
        rpc.request = async (method, params = {}, options_) => {
          // Disposal of an in-flight prepare must not later bootstrap a new
          // thread after the probe has timed out and removed its workspace.
          const cleanupRequest = method === "turn/interrupt" || method === "thread/read"
            || method.startsWith("thread/turns/") || cleaning && method === "thread/archive";
          if (!cleanupRequest) controller.signal.throwIfAborted();
          if (method === "thread/list") assert.deepEqual(params.cwd, [workspace], "History enumeration must stay in the new probe cwd.");
          if (params.threadId) assert.ok(ownThreads.has(params.threadId), "Only this probe's thread may be addressed.");
          if (["thread/start", "thread/resume"].includes(method)) assert.equal(params.cwd, workspace);
          if (method === "turn/start" && call) call.turnSubmittedMs = Date.now() - call.startedAt;
          const result = await request(method, params, options_);
          if (method === "thread/start") {
            assert.ok(result.thread?.id);
            ownThreads.add(result.thread.id);
          }
          return result;
        };
        return rpc;
      },
    });
    return instance;
  };
  let codexPath, clientVersion;
  const workflow = async () => {
    codexPath = await resolveCodexExecutable();
    assert.ok(codexPath, "No installed native Codex runtime found.");
    clientVersion = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")).version;
    report.sourceVersion = clientVersion;
    const store = await new SyntheticFileStore(filename).load();
    const domain = new ResearchThesisStore({ store });
    let thesis = await domain.create({ name: "Synthetic P0 arithmetic research", myView: "合成判断：2 + 3 = 5。没有证券、账户或交易。" });
    service = makeService(store);
    stage = "full_mode_guard";
    const prepareStarted = Date.now();
    try {
      await service.prepare({ toolMode: "full" });
      await service.refreshInventory({ threadId: service.threadId });
      report.fullMode = { ...summarizedGuard(service), prepareMs: Date.now() - prepareStarted };
    } catch (error) {
      report.fullMode = { status: "unverified", errorKind: safeCode(error.kind), errorCode: safeCode(error.code), prepareMs: Date.now() - prepareStarted };
    }
    controller.signal.throwIfAborted();
    stage = "restricted_mode_guard";
    await service.createSession({ name: "Synthetic P0 isolated live research", toolMode: "restricted" });
    await service.refreshInventory({ threadId: service.threadId });
    report.restrictedMode = summarizedGuard(service);
    assert.equal(report.restrictedMode.mode, "restricted");
    assert.equal(report.restrictedMode.ready, true);
    const threadId = service.threadId, marker = `P0_ONLY_${randomUUID().slice(0, 8)}`;
    report.threadFingerprint = hash(threadId);

    const analyze = async (task, intent) => {
      const run = await buildAnalysisEvidence({ scope: "chat", portfolio: null, task, signal: controller.signal });
      Object.assign(run.context, { researchThesisId: thesis.id, researchThesisRevision: thesis.revision,
        researchTitle: thesis.name, researchIntent: intent });
      run.analysisContext.researchThesis = buildResearchThesisContext(thesis);
      call = { startedAt: Date.now(), intent };
      const result = await service.analyze({ portfolio: null, run, task, threadId, operationId: randomUUID(), signal: controller.signal });
      call.finalDeliveryMs = Date.now() - call.startedAt;
      call.modelElapsedMs = result.elapsedMs;
      call.firstActivityMs = result.firstActivityMs;
      call.resultDelivery = result.resultDelivery;
      call.outputBytes = Buffer.byteLength(result.text);
      call.outputHash = hash(result.text);
      assert.equal(result.resultDelivery.complete, true);
      assert.equal(result.resultDelivery.historyStatus, "verified");
      assert.equal(result.toolEvents.length, 0);
      report.calls.push(call);
      return { run, result };
    };
    stage = "initial_live_research";
    const initial = await analyze(`这是隔离合成验收。不要调用任何工具、Skills、网页、文件、MCP 或 Apps；只根据本消息回答。先在 analysisMarkdown 中原样写出校验串 ${marker} 并说明 2 + 3 = 5。生成 researchProposal：marketBelief 为“合成假设：需要独立验证”，nextTrigger 为“合成验证：再次核对 2 + 3”，其他字段全部 null；evidence 为空数组，openQuestions 写“合成内容无需外部来源”。不要将校验串放入草案字段。这不是投资研究，也不要查询任何真实资料。`, "update");
    assert.ok(initial.result.text.includes(marker), "Initial answer did not retain synthetic marker.");
    assert.ok(initial.result.researchProposal?.fields?.marketBelief, "A real model draft is required.");
    assert.equal(thesis.versions.length, 1);
    stage = "draft_persistence_and_synthetic_confirmation";
    const persistStarted = Date.now();
    thesis = await domain.saveProposal(thesis.id, { expectedRevision: thesis.revision, proposal: initial.result.researchProposal,
      sourceRunId: initial.run.id, sourceThreadId: threadId });
    await store.set("p0SyntheticFinalResult", { text: initial.result.text, threadId, runId: initial.run.id });
    report.calls[0].draftPersistenceMs = Date.now() - persistStarted;
    assert.equal(thesis.versions.length, 1);
    report.checks.draftPendingBeforeConfirmation = thesis.proposals.at(-1).status === "pending";
    thesis = await domain.acceptProposal(thesis.id, { expectedRevision: thesis.revision, proposalId: thesis.proposals.at(-1).id,
      confirmed: true, fields: { marketBelief: "合成验收：已人工编辑的待验证假设。" }, selectedEvidenceIndexes: [] });
    assert.equal(thesis.versions[0].fields.myView, "合成判断：2 + 3 = 5。没有证券、账户或交易。");
    assert.equal(thesis.evidence.length, 0);
    report.checks.onlyExplicitEditedFieldAdopted = thesis.versions.length === 2 && thesis.versions.at(-1).fields.myView === thesis.versions[0].fields.myView;
    report.checks.noSourcesAutomaticallyAdopted = true;
    stage = "own_history_reopen";
    const opened = await service.openSession(threadId);
    assert.ok(JSON.stringify(opened.transcript).includes(marker));
    report.checks.ownHistoryReopened = true;
    await store.flush();
    service.dispose();
    service = null;
    await store.flush();
    stage = "cold_restart_and_binding";
    const resumedStore = await new SyntheticFileStore(filename).load();
    const resumedDomain = new ResearchThesisStore({ store: resumedStore });
    const restored = await resumedDomain.snapshot();
    thesis = restored.theses.find(item => item.id === thesis.id);
    assert.equal(thesis.versions.length, 2);
    assert.equal((await resumedStore.get("p0SyntheticFinalResult")).text, initial.result.text);
    service = makeService(resumedStore);
    await service.prepare({ toolMode: "restricted" });
    assert.equal(service.threadId, threadId);
    const binding = (await resumedStore.get("codexWorkspaceThreadRegistry")).threads.find(item => item.threadId === threadId).researchBinding;
    assert.equal(binding.researchThesisId, thesis.id);
    const reopened = await service.openSession(threadId);
    assert.ok(JSON.stringify(reopened.transcript).includes(marker));
    report.checks.syntheticStateAndBindingSurviveServiceRestart = true;
    stage = "live_continuation";
    const followup = await analyze("继续本对话的隔离验收。不要调用任何工具、Skills、文件或外部来源。只从本对话先前消息找出 P0_ONLY_ 开头的完整校验串，原样回复，并简短回答 5 - 3 的结果。不要重新生成研究草案。", "discuss");
    assert.ok(followup.result.text.includes(marker), "Continued model did not recall its own synthetic thread marker.");
    report.checks.realModelContinuedOriginalThread = true;
    report.checks.realOrderLinkage = "unverified_requires_selected_user_account_and_cycle";
    report.status = report.fullMode?.ready === true ? "passed_scoped" : "degraded";
  };
  const work = workflow();
  try {
    await Promise.race([work, new Promise((_, reject) => {
      timeout = setTimeout(() => { const error = fail("p0_timeout"); controller.abort(error); reject(error); }, timeoutMs);
    })]);
  } catch (error) {
    report.status = "failed";
    report.failure = { stage, kind: safeCode(error.kind), code: safeCode(error.code) ?? (error.name === "AssertionError" ? "acceptance_assertion" : "probe_error") };
  } finally {
    clearTimeout(timeout);
    controller.abort(fail("probe_finished"));
    cleaning = true;
    if (service?.status().active) await service.cancel({ threadId: service.threadId }).catch(() => {});
    for (const threadId of ownThreads) {
      try {
        if (!service?.rpc?.ready) throw fail("archive_rpc_unavailable");
        await service.rpc.request("thread/archive", { threadId }, { timeoutMs: 5_000 });
        report.cleanup.threadsArchived = (report.cleanup.threadsArchived ?? 0) + 1;
      }
      catch { report.cleanup.archiveFailures = (report.cleanup.archiveFailures ?? 0) + 1; }
    }
    service?.dispose();
    // Pending native requests reject on dispose. The abort check at every
    // factory/request boundary prevents the workflow from opening a new RPC.
    await work.catch(() => {});
    await rm(root, { recursive: true, force: true });
    report.cleanup.temporaryDirectoryRemoved = true;
    report.toolEvents === 0 && report.serverToolRequests === 0 || (report.status = "failed");
    report.finishedAt = new Date().toISOString();
    report.totalMs = Date.now() - started;
    await mkdir(path.dirname(reportFile), { recursive: true });
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  return { reportFile, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseP0Args(process.argv.slice(2));
  if (!options.live) process.stdout.write(`${JSON.stringify({ liveExecution: false, ...P0_SCOPE }, null, 2)}\n`);
  else {
    const { reportFile, report } = await runP0Live(options);
    process.stdout.write(`${JSON.stringify({ reportFile, status: report.status, stage: report.failure?.stage ?? "complete", totalMs: report.totalMs })}\n`);
    if (report.status === "failed") process.exitCode = 1;
  }
}
