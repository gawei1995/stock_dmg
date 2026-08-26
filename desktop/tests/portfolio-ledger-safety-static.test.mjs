import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainUrl = new URL("../main.mjs", import.meta.url);

async function mainSource() {
  return readFile(mainUrl, "utf8");
}

test("desktop isolates market history and portfolio snapshots in dedicated encrypted files", async () => {
  const main = await mainSource();

  assert.match(main, /const MARKET_HISTORY_STORE_FILE = "market-history\.bin"/);
  assert.match(main, /const PORTFOLIO_SNAPSHOT_STORE_FILE = "portfolio-snapshots\.bin"/);
  assert.match(
    main,
    /const marketHistoryDataStore = new EncryptedStore\(\{[\s\S]*?fileName: MARKET_HISTORY_STORE_FILE[\s\S]*?\}\)/,
  );
  assert.match(
    main,
    /const portfolioSnapshotDataStore = new EncryptedStore\(\{[\s\S]*?fileName: PORTFOLIO_SNAPSHOT_STORE_FILE[\s\S]*?\}\)/,
  );
  assert.match(
    main,
    /marketHistoryStore: new MarketHistoryStore\(\{[\s\S]*?store: marketHistoryDataStore,[\s\S]*?endpoint: longbridge\.endpoint/,
  );
  assert.match(main, /new PortfolioSnapshotStore\(\{ store: portfolioSnapshotDataStore \}\)/);
  assert.doesNotMatch(main, /new PortfolioSnapshotStore\(\{ store: secureStore \}\)/);
  assert.match(
    main,
    /migrateEncryptedStoreKey\(\{[\s\S]*?target: marketHistoryDataStore,[\s\S]*?key: MARKET_HISTORY_STORE_KEY/,
  );
  assert.match(
    main,
    /migrateEncryptedStoreKey\(\{[\s\S]*?target: portfolioSnapshotDataStore,[\s\S]*?key: PORTFOLIO_SNAPSHOT_STORE_KEY/,
  );
});

test("portfolio snapshot scope is opaque, persisted, and rotates only on explicit forget", async () => {
  const main = await mainSource();
  const connectStart = main.indexOf('ipcMain.handle("longbridge:connect"');
  const forgetStart = main.indexOf('ipcMain.handle("longbridge:forget"', connectStart);
  const agentStart = main.indexOf('ipcMain.handle("agent:run"', forgetStart);
  const connectHandler = main.slice(connectStart, forgetStart);
  const forgetHandler = main.slice(forgetStart, agentStart);

  assert.match(main, /const PORTFOLIO_LEDGER_SCOPE_STORE_KEY = "portfolioLedgerScopeIdV1"/);
  assert.match(main, /return `lb-ledger-\$\{randomUUID\(\)\}`/);
  assert.match(main, /initializePortfolioLedgerScope\(\{[\s\S]*?metadataStore: secureStore,[\s\S]*?snapshotStore: portfolioSnapshotDataStore/);
  assert.match(main, /existingScopes\.length === 1[\s\S]*?existingScopes\[0\][\s\S]*?createPortfolioLedgerScopeId\(\)/);
  assert.match(forgetHandler, /await rotatePortfolioLedgerScope\(\)/);
  assert.doesNotMatch(connectHandler, /rotatePortfolioLedgerScope\(/);
  assert.doesNotMatch(main, /scopeId:\s*LEGACY_PORTFOLIO_LEDGER_SCOPE_ID/);
  assert.match(main, /accountScopeVerified:\s*false/);
  assert.match(main, /broker_account_subject_unavailable_local_scope_only/);
  assert.match(main, /captureAutomaticPortfolioSnapshots\(value, \{ scopeId \}\)/);
});

test("post-trade observations cover every prompt execution instead of only the latest trade", async () => {
  const main = await mainSource();

  assert.match(main, /function uniqueRecentExecutions\([\s\S]*?15 \* 60 \* 1000/);
  assert.match(main, /for \(const execution of recentExecutions\)[\s\S]*?idempotencyKey: `post-trade:\$\{execution\.tradeId\}`/);
  assert.match(main, /sourceSnapshotId: `execution:\$\{execution\.tradeId\}`/);
  assert.match(main, /capturePostTradeAfterHistorySync\([\s\S]*?listSnapshots\(\{[\s\S]*?kinds: "post_trade"/);
  assert.match(main, /recentExecutions\.every\(\(item\) => coveredSources\.has\(`execution:\$\{item\.tradeId\}`\)\)/);
  assert.doesNotMatch(main, /const latestExecution =/);
});

test("a scheduled-close fallback retries until one versioned regular-close revaluation then silently stops", async () => {
  const main = await mainSource();

  assert.match(main, /existingEod\.find\(isCurrentRegularCloseSnapshot\)/);
  assert.match(main, /confirmedEod = snapshotsForDate\.find\(isCurrentRegularCloseSnapshot\)/);
  assert.match(main, /if \(confirmedEod\)[\s\S]*?recordPortfolioSnapshotCaptureSuccess[\s\S]*?else[\s\S]*?verifyUsEodObservation[\s\S]*?regularClosePortfolioObservation/);
  assert.match(main, /else if \(!hasScheduledFallback\)/);
  assert.match(main, /idempotencyKey: `eod-regular-close-v2:\$\{scopeId\}:\$\{tradingDate\}`/);
  assert.match(main, /idempotencyKey: `scheduled-close:\$\{scopeId\}:\$\{tradingDate\}`/);
  assert.match(main, /session: "regular_close"/);
  assert.match(main, /afterHoursMarksExcluded: true/);
  assert.match(main, /methodVersion: REGULAR_CLOSE_VALUATION_METHOD_VERSION/);
  assert.match(main, /lastAttemptAt:[\s\S]*?lastSuccessAt:[\s\S]*?lastError:/);
  assert.match(main, /completeForPeriodReturn:[\s\S]*?!isRegularCloseObservation/);
});

test("review market history consumes explicit cache provenance instead of opaque candle arrays", async () => {
  const main = await mainSource();

  assert.match(main, /loadCandles:\s*\(value, count, options\) => portfolioService\.candlesWithCoverage/);
  assert.match(main, /candleResult:\s*await portfolioService\.candlesWithCoverage\(symbol, 600/);
  assert.match(main, /marketHistoryCoverage:\s*candleCoverageBySymbol\.get\(symbol\)/);
  assert.match(main, /cached_or_partial_market_history/);
});
