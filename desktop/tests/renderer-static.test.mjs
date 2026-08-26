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
  assert.match(script, /LLM REVIEWED · HOST ACCEPTED/);
});

test("renderer exposes snapshot, calculation, Fib, and LLM sizing provenance", async () => {
  const [script, css] = await Promise.all([
    rendererSource("renderer.js"),
    rendererSource("styles.css"),
  ]);

  assert.doesNotMatch(script, /HOLDINGS LIVE/);
  for (const label of ["SYNCED", "STALE", "CACHED", "UNKNOWN"]) {
    assert.match(script, new RegExp(`label: "${label}"`));
  }
  assert.match(script, /portfolio\?\.freshness\?\.state/);
  assert.match(script, /SNAPSHOT \$\{esc\(trust\.timestampLabel\)\}/);
  assert.match(script, /AGE \$\{esc\(trust\.ageLabel\)\}/);
  assert.match(script, /MARKS \$\{esc\(marks\.label\)\}/);
  assert.match(script, /账户快照时间新鲜/);
  assert.match(script, /持仓快照 \/ 行情标记<\/span><strong>\$\{asOf && trust/);
  assert.match(script, /function portfolioMarkRange\(/);

  assert.match(script, /CLOSE EMA/);
  assert.match(script, /SMA SEED/);
  assert.match(script, /forward: "前复权"/);
  assert.match(script, /regular_hours: "常规时段"/);
  assert.match(script, /technical\.asOfTradingDate/);
  assert.match(script, /OFFICIAL BARS/);
  assert.match(script, /lastBar\?\.status \?\? "UNKNOWN"/);
  assert.match(script, /LONG EMA MATURITY/);
  assert.match(script, /\[144, 169\]\.map\(\(period\)/);
  assert.match(script, /EMA\$\{period\}[\s\S]{0,100}maturity\.label/);
  assert.match(script, /PROVISIONAL/);
  assert.match(script, /已从官方 EMA \/ Fib 计算排除/);

  assert.match(script, /AUTO · ADVISORY/);
  assert.match(script, /LLM DECIDES/);
  assert.match(script, /自动 Fib 只作为候选证据/);
  assert.match(script, /LLM SELECTED · HOST CALCULATED/);
  assert.match(script, /HOST REJECTED · LLM Fib/);
  assert.match(script, /modelReview\?\.selected/);
  assert.match(script, /价格和 0\.382 \/ 0\.618 \/ 1 \/ 1\.618 均由宿主/);
  assert.match(script, /LLM PROPOSED · 初始新增/);
  assert.match(script, /\$\{acceptedLabel\} · 最大总仓位/);
  assert.match(script, /HARD CEILING · 最大总仓位/);
  assert.match(script, /LIMIT BINDINGS/);
  assert.match(script, /AWAITING LLM/);
  assert.match(script, /HOST ACCEPTANCE EXPIRED/);
  assert.match(script, /HOST ADJUDICATION · 常驻裁决摘要/);
  assert.match(
    script,
    /const finalizedReview = \["llm_reviewed", "bounded", "blocked"\]\.includes\(reviewStatus\)/,
  );
  assert.match(script, /function isRunStale\(/);
  assert.match(script, /function reviewRunEvidenceStale\(/);
  assert.match(script, /reviewEvidenceRevisions:\s*new Map\(\)/);
  assert.match(script, /reviewCycleRetrospectiveVersions:\s*new Map\(\)/);
  assert.match(script, /reviewCycleEvidenceRevisions:\s*new Map\(\)/);
  assert.match(script, /usedEvidence !== currentEvidence/);
  assert.match(script, /phase === "blind"/);
  assert.match(script, /phase === "retrospective" && noteChanged/);
  assert.match(script, /reviewPhasePersistence === "failed"/);
  assert.match(script, /没有写入不可变审计台账/);
  assert.match(script, /关联订单的证据版本已经变化/);
  assert.match(script, /证据已更新 · 请重新复盘/);
  assert.match(script, /function candidateSizingExpired\(/);
  assert.match(
    script,
    /function refreshCurrentRunTrustUi\(\)[\s\S]*querySelectorAll\("\.agent-run\[data-run-id\]"\)/,
  );
  assert.match(script, /currentNode\.dataset\.stale === String\(stale\)/);
  assert.match(script, /currentNode\.dataset\.sizingExpired === String\(sizingExpired\)/);
  assert.match(css, /\.data-passport\.stale/);
  assert.match(css, /\.provisional-warning/);
  assert.match(css, /\.fib-policy/);
  assert.match(css, /\.fib-llm-review\.rejected/);
  assert.match(css, /\.risk-bindings/);
  assert.match(css, /\.candidate-adjudication\.expired/);
  assert.match(css, /\.candidate-expiry-warning/);
});

test("renderer keeps text recovery provisional so an authoritative structured run can replace it", async () => {
  const script = await rendererSource("renderer.js");
  const fallback = script.match(
    /function settleAgentFromRecoveredTurn\(operation, value\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? "";
  const failure = script.match(
    /function failAgentOperation\(operation, message,[^{]*\{([\s\S]*?)\n\}/,
  )?.[1] ?? "";

  assert.match(fallback, /operation\.status = "fallback"/);
  assert.match(fallback, /provisionalFallback = "true"/);
  assert.doesNotMatch(fallback, /rememberSettledOperation/);
  assert.doesNotMatch(fallback, /finishAgentOperation/);
  assert.match(script, /operation\?\.fallbackRendered && run\.conclusion\?\.body/);
  assert.match(script, /operation\.status = "error_pending_result"/);
  assert.doesNotMatch(failure, /rememberSettledOperation/);
  assert.doesNotMatch(failure, /state\.operations\.delete/);
  assert.match(script, /Recovery is an auxiliary read path[\s\S]*scheduleAgentResultRecovery/);
  assert.match(script, /POST_TERMINAL_RECOVERY_WINDOW_MS\s*=\s*60_000/);
  assert.match(
    fallback,
    /operation\.recoveryStopAt \?\?= Date\.now\(\) \+ POST_TERMINAL_RECOVERY_WINDOW_MS/,
  );
  assert.match(
    failure,
    /operation\.recoveryStopAt \?\?= Date\.now\(\) \+ POST_TERMINAL_RECOVERY_WINDOW_MS/,
  );
  assert.match(
    script,
    /function scheduleAgentResultRecovery\([\s\S]*Date\.now\(\) >= recoveryStopAt[\s\S]*stopAgentResultRecovery\(operation\)/,
  );
  assert.match(
    script,
    /function stopAgentResultRecovery\(operation\)[\s\S]*state\.operations\.delete\(operation\.operationId\)/,
  );
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

test("desktop fixes Longbridge to the global endpoint and uses Electron's system-proxy fetch", async () => {
  const [main, script] = await Promise.all([
    readFile(new URL("../main.mjs", import.meta.url), "utf8"),
    rendererSource("renderer.js"),
  ]);
  const match = main.match(
    /export function preferredLongbridgeEndpoint\(\) \{([\s\S]*?)\n\}/,
  );
  assert.ok(match, "preferredLongbridgeEndpoint must remain an exported pure function");
  const resolveEndpoint = new Function(match[1]);

  assert.equal(resolveEndpoint(), "https://mcp.longbridge.com/v2");
  assert.doesNotMatch(main, /app\.getLocaleCountryCode\(\)/);
  assert.doesNotMatch(main, /LONGBRIDGE_MCP_URL/);
  assert.match(main, /createProxyAwareFetch\([\s\S]*net\.fetch\(input, init\)/);
  assert.match(main, /fetchFn:\s*longbridgeFetch/);
  assert.match(main, /networkStack:\s*"electron-system-proxy"/);
  assert.match(
    main,
    /new EcbReferenceFxProvider\(\{[\s\S]*fetchImpl:\s*longbridgeFetch/,
  );
  assert.match(main, /GLOBAL · macOS 系统代理/);
  assert.match(main, /state:\s*"network_error"/);
  assert.equal(
    (main.match(/error:\s*failure\.detail \|\| failure\.message/g) ?? []).length,
    3,
  );
  const connectHandlerStart = main.indexOf('ipcMain.handle("longbridge:connect"');
  const forgetHandlerStart = main.indexOf('ipcMain.handle("longbridge:forget"', connectHandlerStart);
  const connectAndRefreshHandlers = main.slice(connectHandlerStart, forgetHandlerStart);
  assert.doesNotMatch(connectAndRefreshHandlers, /error:\s*safeError\(error\)/);
  assert.match(
    script,
    /result\.status\?\.detail \|\| result\.status\?\.message \|\| result\.error/,
  );
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
