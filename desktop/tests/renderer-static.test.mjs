import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

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

test("Agent streaming follows only while the reader remains at the tail", async () => {
  const [html, script, css] = await Promise.all([
    rendererSource("index.html"),
    rendererSource("renderer.js"),
    rendererSource("styles.css"),
  ]);

  assert.match(html, /id="agent-jump-latest"[^>]*hidden/);
  assert.match(script, /agentFollowTail:\s*true/);
  assert.match(script, /agentThread\.addEventListener\("scroll", handleAgentThreadScroll/);
  assert.match(script, /function agentThreadNearEnd\(/);
  assert.match(script, /scrollAgentToEnd\(\{ force: false \}\)/);
  assert.match(script, /agentJumpLatest\.addEventListener\("click", \(\) => scrollAgentToEnd\(\{ force: true \}\)\)/);
  assert.match(css, /\.agent-jump-latest\s*\{/);
  assert.match(css, /\.agent-stream-output\s*\{[^}]*overflow:\s*visible/s);
  assert.doesNotMatch(css, /\.agent-stream-output\s*\{[^}]*max-height:/s);
});

test("application quit waits for a bounded TradingView storage flush", async () => {
  const main = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
  const shutdown = main.slice(
    main.indexOf('app.on("before-quit"'),
    main.indexOf('app.on("window-all-closed"'),
  );

  assert.match(shutdown, /event\.preventDefault\(\)/);
  assert.match(shutdown, /guardedShutdownPromise/);
  assert.match(shutdown, /await Promise\.race\(/);
  assert.match(shutdown, /tvSession\?\.flushStorageData\(\)/);
  assert.match(shutdown, /setTimeout\(resolve, 3_000\)/);
  assert.match(shutdown, /guardedShutdownComplete = true;[\s\S]*app\.quit\(\)/);
});

test("visual zoom limits use positive scale factors, never negative zoom levels", async () => {
  const main = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
  assert.match(main, /setVisualZoomLevelLimits\(1, 3\)/);
  assert.doesNotMatch(main, /setVisualZoomLevelLimits\(-/);
});

test("left portfolio pane exposes a read-only Tier-A technical radar without shrinking TradingView", async () => {
  const [html, script, css, preload] = await Promise.all([
    rendererSource("index.html"),
    rendererSource("renderer.js"),
    rendererSource("styles.css"),
    readFile(new URL("../preload.cjs", import.meta.url), "utf8"),
  ]);

  assert.match(
    html,
    /<aside class="portfolio-pane"[\s\S]*?id="position-list"[\s\S]*?<section class="technical-radar collapsed" id="technical-radar"[\s\S]*?<\/aside>/,
  );
  assert.match(html, /id="technical-radar-toggle"[^>]*aria-expanded="false"/);
  assert.match(html, /id="technical-radar-run"/);
  assert.match(html, /id="technical-watchlist-symbol"/);
  assert.match(html, /变化优先展示 · 点击展开证据 · 不代表买卖信号/);
  assert.match(html, /缺失指标保持 N\/A/);

  assert.match(preload, /snapshot:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("technical:radar:snapshot"\)/);
  assert.match(preload, /run:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("technical:radar:run"\)/);
  assert.match(preload, /addWatchlist:[\s\S]*?ipcRenderer\.invoke\("technical:watchlist:add", \{ symbol \}\)/);
  assert.match(preload, /removeWatchlist:[\s\S]*?ipcRenderer\.invoke\("technical:watchlist:remove", \{ symbol \}\)/);
  assert.match(preload, /onTechnicalRadar:[\s\S]*?listen\("cockpit:technical-radar", callback\)/);

  assert.match(script, /api\.onTechnicalRadar\(setTechnicalRadar\)/);
  assert.match(script, /api\.technicalRadar\.snapshot\(\)/);
  assert.match(script, /api\.technicalRadar\.run\(\)/);
  assert.match(script, /api\.technicalRadar\.addWatchlist\(symbol\)/);
  assert.match(script, /api\.technicalRadar\.removeWatchlist\(symbol\)/);
  assert.match(script, /value\.latestBatch/);
  assert.match(script, /summary\.coverage/);
  assert.match(script, /summary\.rankings\?\.changes\?\.rows/);
  assert.match(script, /summary\.rankings\?\.anomalies\?\.rows/);
  assert.match(script, /card\?\.structure\?\.short/);
  assert.match(script, /card\?\.structure\?\.long/);
  assert.match(script, /card\?\.structure\?\.priceVsEma21/);
  assert.match(script, /card\?\.metrics\?\.qqqExcessReturns\?\.\["20"\]/);
  assert.match(script, /qqq20\?\.status === "available"[\s\S]*?: "N\/A"/);
  assert.match(script, /\["partial", "degraded"\]\.includes\(status\)[\s\S]*?return "degraded"/);
  assert.match(script, /selectPosition\(symbol\)[\s\S]*?syncSelectedToTv\(\)/);
  assert.match(script, /setAnalysisScope\("candidate"\)/);
  assert.match(script, /api\.tv\.loadSymbol\(technicalRadarTvSymbol\(symbol\)\)/);
  assert.doesNotMatch(script, /buildTierATechnicalBatchScan|calculateTechnical\(/);

  assert.match(css, /\.technical-radar\s*\{/);
  assert.match(css, /\.technical-radar\.collapsed/);
  assert.match(css, /\.technical-radar-card\.complete/);
  assert.match(css, /\.technical-radar-card\.degraded/);
  assert.match(css, /\.technical-radar-card\.unavailable/);
  assert.match(css, /\.technical-radar-body\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.technical-radar-list\s*\{[^}]*flex:\s*0 0 auto[^}]*overflow:\s*visible/s);
  assert.doesNotMatch(css, /\.technical-radar[^}]*position:\s*(?:fixed|absolute)/s);
  assert.doesNotMatch(css, /\.technical-radar[^}]*\.tv-surface/s);
});

test("portfolio gate explains quote permissions without calling a successful sync a connection failure", async () => {
  const script = await rendererSource("renderer.js");
  const source = script.slice(script.indexOf("function portfolioValuationGateView("), script.indexOf("function formatSnapshotAge("));
  const view = vm.runInNewContext(`${source}; portfolioValuationGateView`);
  const result = view({
    positions: [{ symbol: "TEST260918P100000.US", valuationLimitation: "缺少可用报价" }],
    dataQuality: { quoteErrors: ["TEST260918P100000.US: Longbridge option_quote: 301604: no quote access"] },
    valuationGate: {
      outcome: { status: "block", reasonCodes: ["portfolio_valuation_completeness_failed", "quote_price_missing"] },
      issues: [
        { code: "portfolio_valuation_completeness_failed" },
        { code: "quote_price_missing", symbol: "TEST260918P100000.US" },
        { code: "net_asset_reconciliation_failed" },
      ],
    },
  });
  assert.equal(result.status, "block");
  assert.equal(result.shortReason, "TEST260918P100000.US 行情权限不足");
  assert.match(result.detail, /OpenAPI 权限/);
  assert.match(result.detail, /反复刷新或重新登录不能/);
  assert.match(result.detail, /净资产勾稽失败/);
  assert.doesNotMatch(result.detail, /portfolio_valuation_completeness_failed|缺少可用报价/);
  assert.equal(result.issues.length, 2);
  assert.match(script, /previousIssues\?\.open === true/);
  assert.match(script, /issuesBody\.scrollTop = issuesScrollTop/);
});

test("portfolio gate retains human-readable reasons for non-permission failures and clean passes", async () => {
  const script = await rendererSource("renderer.js");
  const source = script.slice(script.indexOf("function portfolioValuationGateView("), script.indexOf("function formatSnapshotAge("));
  const view = vm.runInNewContext(`${source}; portfolioValuationGateView`);
  const result = view({
    valuationGate: {
      outcome: { status: "block", reasonCodes: ["quote_stale_active_session"] },
      issues: [{ code: "quote_stale_active_session", symbol: "AAPL.US" }],
    },
  });
  assert.equal(result.shortReason, "AAPL.US · 存在过期行情");
  const pass = view({ valuationGate: { outcome: { status: "pass", reasonCodes: [] }, issues: [] } });
  assert.equal(pass.shortReason, "通过");
  assert.equal(pass.issues.length, 0);
});

test("technical radar exposes a user-confirmed sector and peer linkage editor", async () => {
  const [html, script, css, preload] = await Promise.all([
    rendererSource("index.html"),
    rendererSource("renderer.js"),
    rendererSource("styles.css"),
    readFile(new URL("../preload.cjs", import.meta.url), "utf8"),
  ]);

  assert.match(html, /<details class="technical-linkage-editor" id="technical-linkage-editor">/);
  assert.match(html, /id="technical-linkage-symbol"/);
  assert.match(html, /id="technical-linkage-sector"/);
  assert.match(html, /id="technical-linkage-peers"/);
  assert.match(html, /id="technical-linkage-rationale"/);
  assert.match(html, /同行比较如启用，必须填写 2–5 个/);
  assert.match(html, /模型建议不会自动确认；只有你确认的映射才会触发宿主行情请求/);

  assert.match(preload, /confirmLinkage:\s*\(request\)\s*=>\s*ipcRenderer\.invoke\("technical:linkage:confirm", request\)/);
  assert.match(preload, /removeLinkage:\s*\(symbol\)\s*=>\s*ipcRenderer\.invoke\("technical:linkage:remove", \{ symbol \}\)/);
  assert.match(script, /technicalLinkageForm\.addEventListener\("submit", confirmTechnicalLinkage\)/);
  assert.match(script, /api\.technicalRadar\.confirmLinkage\(\{/);
  assert.match(script, /api\.technicalRadar\.removeLinkage\(symbol\)/);
  assert.match(script, /setTechnicalLinkageEditorSymbol\(target\.dataset\.radarOpen, \{ force: true \}\)/);
  assert.match(script, /profile\?\.state === "proposed"[\s\S]*?"建议待确认"/);
  assert.match(script, /同行比较需要 2–5 个标的/);
  const setRadarSource = script.slice(
    script.indexOf("function setTechnicalRadar(value)"),
    script.indexOf("function toggleTechnicalRadar()"),
  );
  assert.doesNotMatch(setRadarSource, /confirmLinkage/);

  assert.match(css, /\.technical-linkage-editor\s*\{/);
  assert.match(css, /\.technical-linkage-grid\s*\{[^}]*grid-template-columns:\s*1fr 1fr/s);
  assert.match(css, /\.technical-linkage-state\.complete/);
  assert.match(css, /\.technical-linkage-actions span\.error/);
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
  assert.match(script, /latestOperationByThread:\s*new Map\(\)/);
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
  assert.match(script, /function isLatestThreadOperation\(/);
  assert.match(script, /A late result[\s\S]*must[\s\S]*not replace the newer turn/);
  assert.doesNotMatch(script, /slice\(0, 200\) === b\.slice\(0, 200\)/);
  assert.match(script, /成本 未提供/);
  assert.match(script, /costBasisLimitation/);
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
  assert.match(script, /GATE \$\{esc\(valuationGate\.status\.toUpperCase\(\)\)\}/);
  assert.match(script, /账户、逐标的报价与估值校验通过/);
  assert.match(script, /freshForSizing:\s*trustState === "fresh" && portfolio\?\.freshness\?\.freshForSizing === true/);
  assert.match(script, /function portfolioValuationGateView\(/);
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
  assert.match(script, /function tierBTechnicalCard\(/);
  assert.match(script, /SELECTED SYMBOL · TIER-B EVIDENCE/);
  assert.match(script, /NO FORWARD-FILL/);
  assert.match(script, /不由 OI 推断 dealer gamma/);
  assert.match(css, /\.tier-b-layer-grid\s*\{/);
  assert.match(script, /已从官方 EMA \/ Fib 计算排除/);
  assert.match(script, /DAILY SEQUENCE & DATA PASSPORT/);
  assert.match(script, /TR \/ ATR14/);
  assert.match(script, /RESEARCH ONLY/);
  assert.match(script, /technical\?\.capabilityMatrix/);
  assert.match(script, /function technicalV2Card\(/);
  assert.match(script, /MULTI-TIMEFRAME · V2/);
  assert.match(script, /1W STRUCTURE/);
  assert.match(script, /60M EXECUTION/);
  assert.match(script, /14\/28D COST CONCENTRATION/);
  assert.match(script, /PROXY · LOW/);
  assert.match(script, /不是逐笔筹码、机构持仓或真实持有人成本/);
  assert.match(script, /ANCHORED VWAP/);
  assert.match(script, /HOST VERIFIED/);
  assert.match(script, /不会自动挑锚/);
  assert.match(script, /无 sizing \/ invalidation 权限/);
  assert.match(script, /末周固定排除/);
  assert.match(script, /完结证明/);
  assert.match(css, /\.multi-timeframe-card/);
  assert.match(css, /\.timeframe-layer/);
  assert.match(css, /\.proxy-layer/);
  assert.match(css, /\.avwap-layer/);

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
  assert.match(script, /PLANNED RISK · 含滑点/);
  assert.match(script, /STRESS RISK/);
  assert.match(script, /压力风险预算硬上限/);
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
  assert.match(css, /\.sequence-grid/);
  assert.match(css, /\.capability-matrix/);
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

  const createStart = script.indexOf("async function createAgentSession(options = {})");
  const createEnd = script.indexOf("async function switchAgentSession", createStart);
  const createSource = script.slice(createStart, createEnd);
  assert.match(createSource, /const\s+name\s*=\s*"新对话"/);
  assert.match(createSource, /api\.agentSessions\.create\(\{\s*name,\s*\.\.\.\(toolMode \? \{ toolMode \} : \{\}\)/);
  assert.doesNotMatch(createSource, /new Date\(|getMonth\(|getHours\(|交易会话\s*\$\{/);
});

test("conclusion card exposes the delivered evidence passport instead of capability totals", async () => {
  const [script, css] = await Promise.all([
    rendererSource("renderer.js"),
    rendererSource("styles.css"),
  ]);
  const passport = script.slice(
    script.indexOf("function evidencePassport(model)"),
    script.indexOf("function conclusionCard(run)"),
  );
  const conclusion = script.slice(
    script.indexOf("function conclusionCard(run)"),
    script.indexOf("function technicalCard(technical)"),
  );

  for (const field of [
    "contextDiagnostics",
    "deliveryStatus",
    "totalBlockCount",
    "totalUtf8Bytes",
    "semanticOmissions",
    "bundleHash",
    "requestedSkills",
  ]) assert.match(passport, new RegExp(field));
  assert.match(passport, /EVIDENCE PASSPORT/);
  assert.match(passport, /本轮 Skills/);
  assert.match(conclusion, /completedToolEvents\.length/);
  assert.doesNotMatch(conclusion, /skillCount|mcpServerCount|appCount/);
  assert.match(css, /\.evidence-passport\s*\{/);
  assert.match(css, /\.evidence-passport\.degraded/);
  assert.match(css, /\.evidence-passport\.rejected/);
});

test("opening a review session keeps the persisted evidence binding authoritative", async () => {
  const script = await rendererSource("renderer.js");
  const merge = script.slice(
    script.indexOf("function mergeReviewSessionContext(persistedBinding, lastRunContext)"),
    script.indexOf("function renderOpenedSession(payload)"),
  );
  const opened = script.slice(
    script.indexOf("function renderOpenedSession(payload)"),
    script.indexOf("function resetAgentConversation()"),
  );

  assert.match(merge, /\.\.\.lastRunContext,[\s\S]*\.\.\.persistedBinding/);
  assert.match(merge, /evidence revision, retrospective version, or input hash/);
  for (const field of [
    "reviewEvidenceRevision",
    "reviewRetrospectiveVersion",
    "reviewInputSnapshotHash",
  ]) assert.match(opened, new RegExp(`${field}: persistedReviewContext\\.${field}`));
  assert.equal((opened.match(/mergeReviewSessionContext\(persistedReviewBinding/g) ?? []).length, 2);
});

test("non-retryable context and review contract failures stop result recovery immediately", async () => {
  const [script, main] = await Promise.all([
    rendererSource("renderer.js"),
    readFile(new URL("../main.mjs", import.meta.url), "utf8"),
  ]);
  const handler = script.slice(
    script.indexOf("function handleAgentResult(envelope)"),
    script.indexOf("function scheduleAgentResultRecovery"),
  );
  assert.match(handler, /continueRecovery:\s*envelope\?\.retryable !== false/);
  assert.match(handler, /deliveryStatus === "rejected_budget"/);
  assert.match(main, /function agentFailureEnvelope\(error\)/);
  for (const code of [
    "context_budget",
    "review_skill_missing",
    "review_thread_binding",
    "blind_time_firewall",
  ]) assert.match(main, new RegExp(`"${code}"`));
  assert.match(main, /Number\(error\?\.rpcCode\) === -32602/);
});
