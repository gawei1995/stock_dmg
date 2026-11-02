import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const mainUrl = new URL("../main.mjs", import.meta.url);

test("desktop wires one encrypted Tier-A radar path into UI, EOD capture, and portfolio Agent", async () => {
  const main = await readFile(mainUrl, "utf8");

  assert.match(main, /const TECHNICAL_RADAR_STORE_FILE = "technical-radar\.bin"/);
  assert.match(main, /new TechnicalRadarStore\(\{ store: technicalRadarDataStore \}\)/);
  assert.match(main, /new TechnicalWatchlistStore\(\{ store: technicalRadarDataStore \}\)/);
  assert.match(main, /new TechnicalRadarService\(\{[\s\S]{0,300}portfolioService,[\s\S]{0,300}radarStore: technicalRadarStore/);

  for (const channel of [
    "technical:radar:snapshot",
    "technical:radar:run",
    "technical:watchlist:add",
    "technical:watchlist:remove",
  ]) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\("${channel.replaceAll(":", "\\:")}"`));
  }
  assert.match(main, /safeSend\("cockpit:technical-radar", radar\)/);
  assert.match(main, /latestBatch:\s*snapshot\.latest[\s\S]{0,180}items:\s*snapshot\.cards/);

  assert.match(main, /recordPortfolioSnapshotCaptureSuccess\(snapshot\)[\s\S]{0,900}scheduleAutomaticTechnicalRadar\(snapshot\.tradingDate\)/);
  assert.match(main, /technicalRadarLastAutomaticTradingDate === date/);
  assert.match(main, /current\?\.latestBatch\?\.tradingDate >= date/);

  assert.match(main, /assertCurrentPortfolioScopeForWrite\(portfolio, currentPortfolioLedgerScopeId\(\)\)/);
  assert.match(main, /inspectPersistedAccountScope\(value\?\.accountScopeIdentity\)/);
  assert.match(main, /已阻止技术雷达写入已验证账户历史/);

  assert.match(main, /scope === "portfolio"[\s\S]{0,220}technicalRadarForPortfolioAnalysis\(analysisPortfolio, agentPortfolioScopeId\)/);
  assert.match(main, /buildAnalysisEvidence\(\{[\s\S]{0,260}technicalRadar,/);
  assert.doesNotMatch(main, /submit_order|replace_order|cancel_order/);
});

test("portfolio evidence reads the send-time scope directly and retains raw radar identity", async () => {
  const main = await readFile(mainUrl, "utf8");
  const helper = main.slice(main.indexOf("async function technicalRadarForPortfolioAnalysis("),
    main.indexOf("async function technicalRadarUiSnapshot("));
  const reads = [];
  const context = vm.createContext({ technicalRadarStore: { async latest(request) {
    reads.push(request.accountScopeId);
    return { batchId: "fixture-batch", accountScopeId: request.accountScopeId, items: [] };
  } } });
  vm.runInContext(helper, context);
  for (const input of [
    { brokerScope: "longbridge", accountScopeIdentity: { scopeId: "sent-longbridge" } },
    { brokerScope: "all", brokerAccounts: [{ broker: "longbridge", scopeId: "sent-longbridge" }] },
  ]) {
    const batch = await context.technicalRadarForPortfolioAnalysis(input, "later-visible-account");
    assert.equal(batch.accountScopeId, "sent-longbridge");
    assert.equal(batch.batchId, "fixture-batch");
  }
  for (const input of [
    { brokerScope: "ibkr", accountScopeIdentity: { scopeId: "ibkr-scope" } },
    { brokerScope: "all", brokerAccounts: [{ broker: "longbridge", scopeId: "A" }, { broker: "ibkr", scopeId: "B" }] },
  ]) {
    const batch = await context.technicalRadarForPortfolioAnalysis(input, "captured-reference-scope");
    assert.equal(batch.accountScopeId, "captured-reference-scope");
  }
  assert.deepEqual(reads, ["sent-longbridge", "sent-longbridge", "captured-reference-scope", "captured-reference-scope"]);
  assert.equal(await context.technicalRadarForPortfolioAnalysis({ brokerScope: "ibkr" }, null), null);
});
