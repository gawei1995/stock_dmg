import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildAnalysisEvidence, normalizeAnalysisScope } from "../src/engine/agent.mjs";
import { buildCodexEvidence, buildWorkspacePrompt, buildWorkspaceAdditionalContext, validateWorkspaceEvidenceDelivery } from "../src/engine/codex-workspace.mjs";

test("free research needs neither portfolio nor symbol and never performs broker or technical requests", async () => {
  let calls = 0;
  const run = await buildAnalysisEvidence({ scope: "chat", portfolio: null, task: "讨论行业估值方法",
    loadCandles: () => { calls++; throw new Error("must not fetch"); },
    loadMarketSeries: () => { calls++; throw new Error("must not fetch"); } });
  assert.equal(normalizeAnalysisScope("chat"), "chat");
  assert.equal(calls, 0);
  assert.equal(run.context.scope, "chat");
  assert.equal(run.analysisContext.portfolioSummary, null);
  assert.equal(run.technical, null);
  assert.equal(run.risk, null);
  assert.equal(run.plan.available, false);
  assert.deepEqual(run.sections, ["conclusion"]);
  const evidence = buildCodexEvidence({ portfolio: null, run, task: run.task });
  assert.equal(evidence.analysisScope, "chat");
  assert.equal(evidence.selectedPosition, null);
  assert.equal(evidence.candidateTarget, null);
  assert.equal(evidence.dataQuality.portfolioStatus, "not_attached_to_free_research");
  const prompt = buildWorkspacePrompt(evidence);
  assert.match(prompt, /自由研究与讨论/);
  assert.match(prompt, /不要求已经持仓/);
  assert.match(prompt, /不强制输出 EMA\/Fib/);
  const blocks = buildWorkspaceAdditionalContext(evidence, prompt);
  assert.doesNotThrow(() => validateWorkspaceEvidenceDelivery(evidence, blocks));
});

test("free research respects cancellation before any evidence work", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled research"));
  await assert.rejects(buildAnalysisEvidence({ scope: "chat", signal: controller.signal }), /取消|cancel/);
});

test("host accepts chat, does not require a broker snapshot and forbids saving it as an executable plan", async () => {
  const source = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function validateAnalysisScope(");
  const end = source.indexOf("\nfunction ", start + 1);
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end), context);
  assert.equal(context.validateAnalysisScope("chat"), "chat");
  assert.throws(() => context.validateAnalysisScope("unsafe"));
  const runStart = source.indexOf('ipcMain.handle("agent:run"');
  const runEnd = source.indexOf('ipcMain.handle("agent:cancel"', runStart);
  const run = source.slice(runStart, runEnd);
  assert.match(run, /requestedPortfolio = scope === "chat" \? null/);
  assert.match(run, /!\["review", "chat"\]\.includes\(scope\) && !requestedPortfolio/);
  assert.match(run, /scope !== "chat" && requestedBrokerScope !== "ibkr"\) longbridgeAuthorizationLifecycle/);
  assert.match(source, /\["review", "chat"\]\.includes\(scope\)\) \{\s*throw new Error\("研究与复盘结论不保存为当前可执行交易计划/);
});
