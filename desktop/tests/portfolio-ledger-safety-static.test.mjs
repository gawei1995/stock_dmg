import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainUrl = new URL("../main.mjs", import.meta.url);
const accountScopeUrl = new URL("../src/data/account-scope-identity.mjs", import.meta.url);
const snapshotStoreUrl = new URL("../src/data/portfolio-snapshot-store.mjs", import.meta.url);

async function mainSource() {
  return readFile(mainUrl, "utf8");
}

async function accountScopeSource() {
  return readFile(accountScopeUrl, "utf8");
}

async function snapshotStoreSource() {
  return readFile(snapshotStoreUrl, "utf8");
}

function sourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing source block: ${startMarker}`);
  return source.slice(start, end);
}

test("desktop isolates market history and portfolio snapshots in dedicated encrypted files", async () => {
  const main = await mainSource();

  assert.match(main, /const MARKET_HISTORY_STORE_FILE = "market-history\.bin"/);
  assert.match(main, /const PORTFOLIO_SNAPSHOT_STORE_FILE = "portfolio-snapshots\.bin"/);
  assert.match(
    main,
    /(?:const\s+)?marketHistoryDataStore\s*=\s*new EncryptedStore\(\{[\s\S]*?fileName: MARKET_HISTORY_STORE_FILE[\s\S]*?\}\)/,
  );
  assert.match(
    main,
    /(?:const\s+)?portfolioSnapshotDataStore\s*=\s*new EncryptedStore\(\{[\s\S]*?fileName: PORTFOLIO_SNAPSHOT_STORE_FILE[\s\S]*?\}\)/,
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

test("verified opaque portfolio scope persists, switches in isolation, and never stores raw account identifiers", async () => {
  const [main, accountScope, snapshotStore] = await Promise.all([
    mainSource(),
    accountScopeSource(),
    snapshotStoreSource(),
  ]);
  const connectStart = main.indexOf('ipcMain.handle("longbridge:connect"');
  const forgetStart = main.indexOf('ipcMain.handle("longbridge:forget"', connectStart);
  const agentStart = main.indexOf('ipcMain.handle("agent:run"', forgetStart);
  const connectHandler = main.slice(connectStart, forgetStart);
  const forgetHandler = main.slice(forgetStart, agentStart);
  const activationStart = main.indexOf("async function activatePortfolioLedgerScope");
  const activationEnd = main.indexOf("function normalizePersistedBrokerScopeIdentity", activationStart);
  const activation = main.slice(activationStart, activationEnd);
  const statusStart = main.indexOf("function currentPortfolioAccountScopeStatus");
  const statusEnd = main.indexOf("async function migrateEncryptedStoreKey", statusStart);
  const scopeStatus = main.slice(statusStart, statusEnd);
  const rotateStart = main.indexOf("async function rotatePortfolioLedgerScope");
  const rotateEnd = main.indexOf("function scheduleFreshPortfolioEvidence", rotateStart);
  const rotate = main.slice(rotateStart, rotateEnd);
  const ledgerInputStart = main.indexOf("function portfolioSnapshotLedgerInput");
  const ledgerInputEnd = main.indexOf("function latestPortfolioValuation", ledgerInputStart);
  const ledgerInput = main.slice(ledgerInputStart, ledgerInputEnd);

  assert.match(main, /const PORTFOLIO_LEDGER_SCOPE_STORE_KEY = "portfolioLedgerScopeIdV1"/);
  assert.match(main, /const PORTFOLIO_BROKER_SCOPE_IDENTITY_STORE_KEY = "portfolioBrokerScopeIdentityV1"/);
  assert.match(main, /initializePortfolioLedgerScope\(\{[\s\S]*?metadataStore: secureStore,[\s\S]*?snapshotStore: portfolioSnapshotDataStore/);
  assert.match(main, /normalizePersistedBrokerScopeIdentity\([\s\S]*?secureStore\.get\(PORTFOLIO_BROKER_SCOPE_IDENTITY_STORE_KEY\)/);
  assert.match(main, /\^broker-scope-v1-\[0-9a-f\]\{64\}\$/);

  assert.match(activation, /planBrokerAccountScopeActivation\(\{[\s\S]*?persistedScope,[\s\S]*?candidateIdentity: candidate/);
  assert.match(activation, /secureStore\.set\(PORTFOLIO_BROKER_SCOPE_IDENTITY_STORE_KEY, candidate\)/);
  assert.match(activation, /secureStore\.set\(PORTFOLIO_LEDGER_SCOPE_STORE_KEY, candidate\.scopeId\)/);
  assert.match(activation, /portfolioLedgerScopeId = candidate\.scopeId/);
  assert.match(activation, /account_switch_detected/);
  assert.match(activation, /旧快照保持只读，不会重标、合并或删除/);
  assert.doesNotMatch(activation, /delete\(PORTFOLIO_SNAPSHOT_STORE_KEY|portfolioSnapshotDataStore\.delete/);

  // Normal connect may adopt a verified scope after refresh. A forced
  // reauthorization is a different authorization lifecycle and must rotate
  // to an anonymous isolated scope before the new account can be verified.
  assert.match(connectHandler, /if \(forceReauthorize\)[\s\S]*?invalidateLongbridgeAuthorizationLifecycle\(\)[\s\S]*?longbridge\.disconnect\(\{ forget: true \}\)[\s\S]*?settleSupersededLongbridgeAuthorizationWork\(\)[\s\S]*?rotatePortfolioLedgerScope\(\)[\s\S]*?longbridge\.connect/);
  assert.match(forgetHandler, /invalidateLongbridgeAuthorizationLifecycle\(\)[\s\S]*?longbridge\.disconnect\(\{ forget: true \}\)[\s\S]*?settleSupersededLongbridgeAuthorizationWork\(\)[\s\S]*?secureStore\.delete\("portfolioSnapshot"\)/);
  assert.match(forgetHandler, /await rotatePortfolioLedgerScope\(\)/);
  assert.match(rotate, /createPortfolioLedgerScopeId\(\)/);
  assert.match(rotate, /secureStore\.delete\(PORTFOLIO_BROKER_SCOPE_IDENTITY_STORE_KEY\)/);
  assert.match(rotate, /portfolioBrokerScopeIdentity = null/);
  assert.doesNotMatch(rotate, /PORTFOLIO_SNAPSHOT_STORE_KEY|portfolioSnapshotDataStore\.delete/);

  assert.doesNotMatch(main, /scopeId:\s*LEGACY_PORTFOLIO_LEDGER_SCOPE_ID/);
  assert.match(scopeStatus, /inspectPersistedAccountScope\(portfolioBrokerScopeIdentity\)/);
  assert.match(scopeStatus, /portfolioBrokerScopeIdentity\?\.scopeId === scopeId/);
  assert.match(main, /accountScopeVerified:\s*accountScope\.verified/);
  assert.match(main, /accountScopeVerified:\s*snapshotScopeInspection\.verified/);
  // Ledger writes must derive verification from the active scope. Other
  // read-only views may explicitly expose `false` when a historical cycle has
  // no trustworthy account binding, which is the required fail-closed state.
  assert.doesNotMatch(ledgerInput, /accountScopeVerified:\s*false/);

  assert.match(ledgerInput, /const verifiedScope = runtimeScope\.verified/);
  assert.match(ledgerInput, /accountRef = verifiedScope \? "verified-broker-scope" : PORTFOLIO_LEDGER_ACCOUNT_REF/);
  assert.match(ledgerInput, /\.\.\.\(verifiedScope \?\? \{\}\)/);
  assert.doesNotMatch(ledgerInput, /accountIdentifiers|rawAccount|account_?id|account_?number/i);

  assert.match(accountScope, /ACCOUNT_SCOPE_HASH_DOMAIN[\s\S]*?account-scope\/v1/);
  assert.match(accountScope, /createHash\(ACCOUNT_SCOPE_HASH_ALGORITHM\)[\s\S]*?ACCOUNT_SCOPE_HASH_DOMAIN[\s\S]*?digest\("hex"\)/);
  assert.match(accountScope, /rawIdentifiersPersisted:\s*false/);
  assert.match(accountScope, /mutablePortfolioContentUsed:\s*false/);
  assert.doesNotMatch(
    accountScope.match(/return Object\.freeze\(\{([\s\S]*?)\n  \}\);/)?.[1] ?? "",
    /identifiers[,\s]/,
  );
  assert.match(snapshotStore, /if \(value\.status !== "verified"\) return base/);
  assert.match(snapshotStore, /inspectPersistedAccountScope\(candidate\)\.verified !== true/);
  assert.doesNotMatch(snapshotStore, /rawAccountNumber|accountIdentifiers/);
  assert.match(main, /captureAutomaticPortfolioSnapshots\(value, \{[\s\S]*?scopeId,[\s\S]*?authorizationGeneration/);
});

test("late Longbridge work is generation-gated before cache, scope, UI, and snapshot commits", async () => {
  const main = await mainSource();
  const refreshStart = main.indexOf("function refreshPortfolioFromLongbridge");
  const refreshEnd = main.indexOf("async function activatePortfolioLedgerScope", refreshStart);
  const activationEnd = main.indexOf("function normalizePersistedBrokerScopeIdentity", refreshEnd);
  const publishStart = main.indexOf("function publishRefreshedPortfolio");
  const publishEnd = main.indexOf("function scheduleFreshPortfolioEvidence", publishStart);
  const appendStart = main.indexOf("async function appendPortfolioSnapshot");
  const appendEnd = main.indexOf("function portfolioSnapshotLedgerInput", appendStart);
  const refresh = main.slice(refreshStart, refreshEnd);
  const activation = main.slice(refreshEnd, activationEnd);
  const publish = main.slice(publishStart, publishEnd);
  const append = main.slice(appendStart, appendEnd);

  assert.match(refresh, /longbridgeAuthorizationLifecycle\.track\(authorizationGeneration/);
  assert.match(refresh, /portfolioService\.refresh\(\{[\s\S]*?commitGuard:/);
  assert.match(refresh, /assertCurrent\(authorizationGeneration\)[\s\S]*?activatePortfolioLedgerScope/);
  assert.match(refresh, /refreshedPortfolioAuthorization\.set\(next/);
  assert.match(activation, /assertCurrent\(authorizationGeneration\)[\s\S]*?secureStore\.set\(PORTFOLIO_BROKER_SCOPE_IDENTITY_STORE_KEY/);
  assert.match(activation, /secureStore\.set\(PORTFOLIO_LEDGER_SCOPE_STORE_KEY[\s\S]*?assertCurrent\(authorizationGeneration\)/);
  assert.match(publish, /refreshedPortfolioAuthorization\.get\(value\)/);
  assert.match(publish, /assertCurrent\(authorizationGeneration\)[\s\S]*?portfolio = value[\s\S]*?safeSend\("cockpit:portfolio"/);
  assert.match(append, /longbridgeAuthorizationLifecycle\.track\(authorizationGeneration/);
  assert.match(append, /scopeId !== currentPortfolioLedgerScopeId\(\)/);
  assert.match(main, /settleSuperseded\(\{ timeoutMs: 30_000 \}\)/);
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
  assert.match(main, /function isUsEodCaptureWindow[\s\S]*?isWithinUsSnapshotCaptureWindow\(value\)/);
  assert.match(main, /lastAttemptAt:[\s\S]*?lastSuccessAt:[\s\S]*?lastError:/);
  assert.match(main, /completeForPeriodReturn:[\s\S]*?!isRegularCloseObservation/);
});

test("cash-only accounts can produce one verified close without inventing position quote timestamps", async () => {
  const main = await mainSource();
  const verifyStart = main.indexOf("async function verifyUsEodObservation");
  const closeStart = main.indexOf("function regularClosePortfolioObservation", verifyStart);
  const appendStart = main.indexOf("async function appendPortfolioSnapshot", closeStart);
  const verify = main.slice(verifyStart, closeStart);
  const close = main.slice(closeStart, appendStart);

  assert.match(verify, /const cashOnly = positions\.length === 0/);
  assert.match(verify, /cashObservationCurrent[\s\S]*?account\?\.valuationComplete === true[\s\S]*?dataQuality\?\.valuationComplete === true/);
  assert.match(verify, /portfolioService\.candles\("QQQ\.US"[\s\S]*?status === "CLOSED"/);
  assert.match(close, /capture_cash_only_after_verified_market_close/);
  assert.match(main, /regular_close_cash_observed_after_close/);
});

test("unattended snapshot capture stops after one confirmation and never turns a sealed gap into history", async () => {
  const main = await mainSource();
  const sweepStart = main.indexOf("async function ensureAutomaticPortfolioSnapshots");
  const captureStart = main.indexOf("async function captureAutomaticPortfolioSnapshotsNow(", sweepStart);
  const attemptStart = main.indexOf("function recordPortfolioSnapshotCaptureAttempt", captureStart);
  const sweep = main.slice(sweepStart, captureStart);
  const capture = main.slice(captureStart, attemptStart);
  const gapBranch = capture.match(/else if \(captureWindowExpired\) \{([\s\S]*?)\n    \} else \{/);

  assert.match(sweep, /const confirmed = existingEod\.find\(isCurrentRegularCloseSnapshot\)/);
  assert.match(sweep, /if \(confirmed\) \{\s*recordPortfolioSnapshotCaptureSuccess\(confirmed\);\s*return;/);
  assert.match(capture, /if \(confirmedEod\) \{\s*recordPortfolioSnapshotCaptureSuccess\(confirmedEod\);\s*\} else if \(captureWindowExpired\)/);
  assert.ok(gapBranch, "terminal gap branch must remain structurally distinct from EOD capture");
  assert.doesNotMatch(gapBranch[1], /appendPortfolioSnapshot|regularClosePortfolioObservation|verifyUsEodObservation/);
  assert.match(sweep, /snapshotCoverageEntry\(portfolioSnapshotCoverageLedger,[\s\S]*?\?\.status === "gap"\) return;/);
  assert.match(main, /await reconcileSnapshotCoverageFromSnapshots\(snapshots, scopeId, now\)/);
  assert.match(main, /recordSnapshotCoverageTransition\(\(ledger\) => \{[\s\S]*?deriveExpiredSnapshotGaps\(ledger, options\)/);
  assert.match(main, /recordSnapshotCoverageTransition\(transition\)/);
  assert.doesNotMatch(main, /backfill.*appendPortfolioSnapshot|appendPortfolioSnapshot.*backfill/i);
});

test("background sweep seals expired gaps before attempting any capture", async () => {
  const main = await mainSource();
  const sweepStart = main.indexOf("async function runPortfolioEvidenceSweep");
  const sweepEnd = main.indexOf("async function reconcileExpiredPortfolioSnapshotGaps", sweepStart);
  const sweep = main.slice(sweepStart, sweepEnd);

  assert.ok(sweep.indexOf("await reconcileExpiredPortfolioSnapshotGaps(now)") >= 0);
  assert.ok(sweep.indexOf("await ensureAutomaticPortfolioSnapshots(now)")
    > sweep.indexOf("await reconcileExpiredPortfolioSnapshotGaps(now)"));
  assert.match(main, /function isUsEodCaptureWindow\(value\) \{\s*return isWithinUsSnapshotCaptureWindow\(value\);\s*\}/);
});

test("snapshot reconnect is saved-auth, window and backoff gated before the same first-write-wins sweep", async () => {
  const main = await mainSource();
  const reconnectStart = main.indexOf("async function reconnectLongbridgeForSnapshotCapture");
  const reconnectEnd = main.indexOf("function captureAutomaticPortfolioSnapshots", reconnectStart);
  const reconnect = main.slice(reconnectStart, reconnectEnd);
  const sweepStart = main.indexOf("async function ensureAutomaticPortfolioSnapshots");
  const sweepEnd = main.indexOf("function captureAutomaticPortfolioSnapshots", sweepStart);
  const sweep = main.slice(sweepStart, sweepEnd);

  assert.match(reconnect, /if \(!isUsEodCaptureWindow\(now\)/);
  assert.match(reconnect, /hasSavedAuthorization/);
  assert.match(reconnect, /decideSnapshotReconnect/);
  assert.match(reconnect, /longbridge\.connect\(\{ interactive: false \}\)/);
  assert.match(reconnect, /recordSnapshotReconnectOutcome/);
  assert.match(reconnect, /classification\.kind === "auth" \|\| classification\.kind === "permission"/);
  assert.match(sweep, /reconnectLongbridgeForSnapshotCapture\(now\)/);
  assert.match(sweep, /const captureNow = new Date\(\);[\s\S]*?!isUsEodCaptureWindow\(captureNow\)\) return/);
  assert.match(sweep, /const confirmed = existingEod\.find\(isCurrentRegularCloseSnapshot\)/);
});

test("background persistence and login startup require an explicit opt-in through the narrow review IPC", async () => {
  const main = await mainSource();
  const updateStart = main.indexOf('ipcMain.handle("review:snapshot-background:update"');
  const nextHandler = main.indexOf('ipcMain.handle("review:portfolio-snapshot:capture"', updateStart);
  const updateHandler = main.slice(updateStart, nextHandler);

  assert.match(main, /const PORTFOLIO_SNAPSHOT_BACKGROUND_PREFERENCES_STORE_KEY = "portfolioSnapshotBackgroundPreferencesV1"/);
  assert.match(main, /enabled: false,[\s\S]{0,100}launchAtLogin: false,[\s\S]{0,100}notifyOnMissedCapture: false/);
  assert.match(updateHandler, /assertTrustedSender\(event\)/);
  assert.match(updateHandler, /const enabled = request\?\.enabled === true/);
  assert.match(updateHandler, /launchAtLogin: enabled && request\?\.launchAtLogin === true/);
  assert.match(updateHandler, /monitoringStartedAt: enabled[\s\S]{0,140}: null/);
  assert.match(updateHandler, /activateSnapshotBackgroundScope\(next,[\s\S]*?currentPortfolioLedgerScopeId\(\)/);
  assert.match(main, /snapshotMonitoringStartedAtForScope\(preferences, scopeId\)/);
  assert.match(main, /const settings = \{ openAtLogin: intent\.openAtLogin \}/);
  assert.match(main, /if \(process\.platform === "darwin"\) settings\.openAsHidden = intent\.openAsHidden/);
  assert.match(main, /return intent\.openAsHidden && loginItem\.wasOpenedAtLogin/);
  assert.match(main, /const keepRunning = snapshotBackgroundRuntimeIntent\([\s\S]*?\)\.keepRunningWhenLastWindowClosed;[\s\S]*?if \(process\.platform !== "darwin" \|\| !keepRunning\) app\.quit\(\)/);
  assert.doesNotMatch(main, /setLoginItemSettings\(\{\s*openAtLogin:\s*true/);
});

test("review market history consumes explicit cache provenance instead of opaque candle arrays", async () => {
  const main = await mainSource();

  assert.match(main, /loadCandles:\s*\(value, count, options\) => portfolioService\.candlesWithCoverage/);
  assert.match(main, /const candleResult\s*=\s*await portfolioService\.candlesWithCoverage\(symbol, 600/);
  assert.match(main, /marketHistoryCoverage:\s*candleCoverageBySymbol\.get\(symbol\)/);
  assert.match(main, /cached_or_partial_market_history/);
});

test("cycle snapshot coverage reads the cycle-bound account scope instead of the currently connected account", async () => {
  const main = await mainSource();
  const hydrateStart = main.indexOf("async function hydrateCyclePortfolioSnapshots");
  const hydrateEnd = main.indexOf("function snapshotWithinDistance", hydrateStart);
  const coverageStart = main.indexOf("async function portfolioSnapshotCoverageForCycles");
  const coverageEnd = main.indexOf("async function buildCyclePointInTimeTechnical", coverageStart);
  const hydrate = main.slice(hydrateStart, hydrateEnd);
  const coverage = main.slice(coverageStart, coverageEnd);

  assert.match(hydrate, /cycle\?\.brokerLinks\?\.accountScopeId/);
  assert.match(hydrate, /queryPeriod\(\{\s*scopeId/);
  assert.doesNotMatch(hydrate, /const scopeId = currentPortfolioLedgerScopeId\(\)/);
  assert.match(coverage, /cycle\?\.brokerLinks\?\.accountScopeId/);
  assert.match(coverage, /snapshotsByScope/);
  assert.match(coverage, /cycle_account_scope_missing_reselect_broker_records/);
});

test("review portfolio projection rejects null, booleans, and blank strings as numeric evidence", async () => {
  const main = await mainSource();
  const reviewSnapshotSource = sourceBlock(
    main,
    "function reviewPortfolioSnapshot",
    "function reviewStartingPortfolioSnapshot",
  );
  const finiteSource = sourceBlock(main, "function finiteOrNull", "async function hydrateCyclePortfolioSnapshots");
  const reviewPortfolioSnapshot = Function(
    `"use strict"; ${finiteSource}\n${reviewSnapshotSource}\nreturn reviewPortfolioSnapshot;`,
  )();

  const unknown = reviewPortfolioSnapshot({
    syncedAt: "2026-08-01T00:00:00.000Z",
    account: { netAssets: null, baseCurrency: "USD" },
    totals: {
      positionsGrossMarketValueBase: false,
      cashRatio: " ",
      top1Weight: true,
    },
    positions: [{
      symbol: "AAPL.US",
      quantity: false,
      weight: "",
      marketValueBase: null,
    }],
  });
  assert.equal(unknown.netAssets, null);
  assert.equal(unknown.cashRatioPercent, null);
  assert.equal(unknown.grossExposurePercent, null);
  assert.equal(unknown.top1WeightPercent, null);
  assert.deepEqual(unknown.positions[0], {
    symbol: "AAPL.US",
    quantity: null,
    weightPercent: null,
    marketValue: null,
    currency: "USD",
    group: null,
  });

  const valid = reviewPortfolioSnapshot({
    account: { netAssets: "200", baseCurrency: "USD" },
    totals: { positionsGrossMarketValueBase: "300", cashRatio: "25", top1Weight: 40 },
    positions: [{ quantity: "2", weight: "40", marketValueBase: "80" }],
  });
  assert.equal(valid.grossExposurePercent, 150);
  assert.equal(valid.cashRatioPercent, 25);
  assert.equal(valid.positions[0].quantity, 2);
});

test("blind point-in-time activity symbols only expose records explicitly introduced before each node cutoff", async () => {
  const main = await mainSource();
  const helperSource = sourceBlock(
    main,
    "function buildPointInTimeActivitySymbols",
    "async function buildCyclePointInTimeTechnical",
  );
  const buildPointInTimeActivitySymbols = Function(
    `"use strict"; ${helperSource}\nreturn buildPointInTimeActivitySymbols;`,
  )();
  const cycle = {
    brokerLinks: {
      recordIds: ["order:early", "execution:later", "order:introduced-late", "order:future"],
    },
  };
  const archive = {
    orders: [
      { orderId: "early", symbol: "MU.US", submittedAt: "2026-08-01T12:00:00.000Z" },
      { orderId: "introduced-late", symbol: "MSFT.US", submittedAt: "2026-08-01T13:00:00.000Z" },
      { orderId: "future", symbol: "GOOG.US", submittedAt: "2026-08-05T12:00:00.000Z" },
    ],
    executions: [{
      tradeId: "later",
      symbol: "NVDA.US",
      doneAt: "2026-08-03T12:00:00.000Z",
    }],
  };
  const symbols = buildPointInTimeActivitySymbols({
    cycle,
    archive,
    phase: "blind",
    cutoffs: [
      {
        nodeId: "initial",
        knowledgeCutoffAt: "2026-08-02T00:00:00.000Z",
        introducedRecordIds: ["order:early", "order:future"],
      },
      {
        nodeId: "checkpoint",
        knowledgeCutoffAt: "2026-08-04T00:00:00.000Z",
        introducedRecordIds: ["execution:later", "order:introduced-late"],
      },
    ],
  });

  assert.deepEqual(symbols.get("initial"), ["MU.US"]);
  assert.deepEqual(symbols.get("checkpoint"), ["MU.US", "NVDA.US", "MSFT.US"]);
  assert.equal([...symbols.values()].flat().includes("GOOG.US"), false);
});
