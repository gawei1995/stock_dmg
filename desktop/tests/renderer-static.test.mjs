import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rendererUrl = new URL("../renderer/", import.meta.url);

async function rendererSource(name) {
  return readFile(new URL(name, rendererUrl), "utf8");
}

test("renderer exposes two persisted pane resizers without scaling TradingView", async () => {
  const [html, script, css] = await Promise.all([
    rendererSource("index.html"),
    rendererSource("renderer.js"),
    rendererSource("styles.css"),
  ]);

  assert.match(html, /id="portfolio-resizer"[\s\S]*role="separator"/);
  assert.match(html, /id="agent-resizer"[\s\S]*role="separator"/);
  assert.match(script, /localStorage\.setItem\(LAYOUT_STORAGE_KEY/);
  assert.match(script, /MIN_TV_WIDTH\s*=\s*440/);
  assert.match(script, /api\.tv\.setBounds\(/);
  assert.match(css, /grid-template-columns:[^;]*--portfolio-pane-width[^;]*--agent-pane-width/);
  assert.doesNotMatch(css, /\.tv-surface\s*\{[^}]*\b(?:zoom|transform)\s*:/s);
  assert.doesNotMatch(script, /tvSurface\.style\.(?:zoom|transform)/);
});

test("renderer removes ineffective TradingView history arrows", async () => {
  const [html, script] = await Promise.all([
    rendererSource("index.html"),
    rendererSource("renderer.js"),
  ]);

  assert.doesNotMatch(html, /id="tv-(?:back|forward)"/);
  assert.doesNotMatch(script, /api\.tv\.(?:back|forward)\(/);
  assert.match(html, /id="tv-reload"/);
  assert.match(html, /id="tv-home"/);
});

test("renderer supports independent sessions and all three analysis scopes", async () => {
  const [html, script] = await Promise.all([
    rendererSource("index.html"),
    rendererSource("renderer.js"),
  ]);

  assert.match(html, /id="agent-session-select"/);
  assert.match(html, /id="new-agent-session"/);
  assert.match(script, /api\.agentSessions\.list\(\)/);
  assert.match(script, /api\.agentSessions\.create\(/);
  assert.match(script, /api\.agentSessions\.open/);
  assert.match(script, /renderOpenedSession\(/);
  assert.match(script, /payload\?\.transcript/);
  assert.match(script, /payload\?\.lastAgentResult/);
  assert.match(script, /operations:\s*new Map\(\)/);
  assert.match(script, /sessionOpenEpoch:\s*0/);
  assert.doesNotMatch(script, /if \(!restored && operationId && state\.settledOperationIds\.has\(operationId\)\)/);
  assert.match(script, /activeOperationForThread\(/);
  assert.match(script, /threadId,[\s\S]*operationId: requestId/);
  assert.doesNotMatch(script, /elements\.agentInput\.value\s*=\s*`\/history/);
  assert.doesNotMatch(script, /api\.getAgentHistory\(/);
  for (const scope of ["position", "candidate", "portfolio"]) {
    assert.match(html, new RegExp(`data-scope="${scope}"`));
  }
  assert.match(html, /id="candidate-symbol"/);
  assert.match(script, /runAgent\(\{[\s\S]*scope,[\s\S]*symbol: targetSymbol/);
  assert.match(script, /leverage\.decision === "disabled" \? "禁止新增 \/ 不可评估"/);
  assert.match(script, /SKILL\/MCP REVIEWED · CASH/);
});

test("desktop routes direct-open transcripts and concurrent operations through one App Server harness", async () => {
  const [main, preload, workspace] = await Promise.all([
    readFile(new URL("../main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../preload.cjs", import.meta.url), "utf8"),
    readFile(new URL("../src/engine/codex-workspace.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(main, /activeAgentOperations\s*=\s*new Map\(\)/);
  assert.match(main, /activeAgentByThread\s*=\s*new Map\(\)/);
  assert.match(main, /agent:sessions:open/);
  assert.match(main, /session\?\.id \?\? session\?\.threadId \?\? listing\.currentThreadId/);
  assert.match(main, /activeAgentByThread\.set\(threadId, operationId\)[\s\S]*cachePendingUserMessage\(\{/);
  assert.match(main, /codexAnalysis\.analyze\(\{[\s\S]*threadId,[\s\S]*operationId/);
  assert.doesNotMatch(main, /let activeAgentController\s*=/);
  assert.match(preload, /agentSessions:[\s\S]*open:/);
  assert.match(preload, /cancelAgent:\s*\(request\)/);
  assert.match(workspace, /this\.activeTurns\s*=\s*new Map\(\)/);
  assert.match(workspace, /async openSession\(threadId\)/);
  assert.match(workspace, /initialTurnsPage:[\s\S]*itemsView:\s*"summary"/);
  assert.match(workspace, /timeoutMs:\s*5_000/);
  assert.match(workspace, /this\.activeTurns\.get\(eventThreadId\)/);
});

test("renderer recovers a completed result after final_message and creates summary-ready sessions", async () => {
  const [script, main, preload] = await Promise.all([
    rendererSource("renderer.js"),
    readFile(new URL("../main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../preload.cjs", import.meta.url), "utf8"),
  ]);

  assert.match(preload, /recoverAgentResult:\s*\(request\)\s*=>\s*ipcRenderer\.invoke\("agent:result:recover",\s*request\)/);
  assert.match(main, /ipcMain\.handle\("agent:result:recover"[\s\S]*?agentResults\.(?:peek|latest)\(/);
  assert.doesNotMatch(main, /await\s+agentResults\.save\(resultEnvelope\)/);
  assert.match(main, /settleActiveAgentOperation\(\{\s*threadId,\s*operationId\s*\}\)[\s\S]{0,1000}agentResults\.save\(resultEnvelope\)[\s\S]{0,1000}safeSend\("cockpit:agent-result",\s*resultEnvelope\)/);
  assert.match(script, /event\.kind === "final_message"[\s\S]{0,2400}scheduleAgentResultRecovery\(operation/);
  assert.match(script, /function scheduleAgentResultRecovery\([\s\S]{0,2400}api\.recoverAgentResult\(\{[\s\S]{0,400}threadId[\s\S]{0,400}operationId/);
  assert.doesNotMatch(script, /scheduleAgentResultRecovery\(operation,\s*2_000\)[\s\S]{0,400}api\.runAgent\(/);
  assert.match(script, /event\.kind === "final_message"[\s\S]{0,1400}CockpitMarkdown\?\.renderMarkdown/);
  assert.match(script, /function flushAgentStream[\s\S]{0,1600}if \(operation\.finalText\)[\s\S]{0,600}CockpitMarkdown\?\.renderMarkdown/);
  assert.match(script, /streamBuffers:\s*new Map\(\)/);
  assert.match(script, /event\.kind === "text_delta"[\s\S]{0,700}event\.itemId[\s\S]{0,700}streamBuffers\.set/);
  const recoveryHandlerStart = main.indexOf('ipcMain.handle("agent:result:recover"');
  const recoveryHandlerEnd = main.indexOf('ipcMain.handle("longbridge:connect"', recoveryHandlerStart);
  const recoveryHandler = main.slice(recoveryHandlerStart, recoveryHandlerEnd);
  assert.doesNotMatch(recoveryHandler, /reconcileActiveTurn\(/);
  assert.match(main, /!matchingResult && !active[\s\S]{0,300}recoverLatestTurn\(\{/);
  assert.match(main, /recoverLatestTurn\(\{[\s\S]{0,300}task:[\s\S]{0,300}operationId/);
  assert.match(main, /activeAgentOperations\.get\(operationId\)\?\.threadId/);

  const createStart = script.indexOf("async function createAgentSession()");
  const createEnd = script.indexOf("async function switchAgentSession", createStart);
  const createSource = script.slice(createStart, createEnd);
  assert.match(createSource, /const\s+name\s*=\s*"新对话"/);
  assert.match(createSource, /api\.agentSessions\.create\(\{\s*name\s*\}\)/);
  assert.doesNotMatch(createSource, /new Date\(|getMonth\(|getHours\(|交易会话\s*\$\{/);
});
