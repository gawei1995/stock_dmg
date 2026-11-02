import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { AuthorizationGenerationGate } from "../src/data/authorization-generation.mjs";
import { PortfolioSnapshotStore, PORTFOLIO_SNAPSHOT_STORE_KEY, REGULAR_CLOSE_VALUATION_METHOD_VERSION, isCurrentRegularCloseSnapshot } from "../src/data/portfolio-snapshot-store.mjs";
import * as coverage from "../src/data/snapshot-coverage.mjs";
import * as background from "../src/data/snapshot-background-reliability.mjs";
import { reconcileDurableSnapshotCoverage } from "../src/data/snapshot-coverage-reconcile.mjs";
import { deriveBrokerAccountScopeIdentity, inspectPersistedAccountScope, planBrokerAccountScopeActivation } from "../src/data/account-scope-identity.mjs";
import { classifyLastDailyBar } from "../src/engine/technical.mjs";
import { expectedLastCompletedTradingDate, isUsTradingDay } from "../src/engine/market-evidence.mjs";

const source = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
const COVERAGE_KEY = "portfolioSnapshotCoverageV1";
const A = deriveBrokerAccountScopeIdentity({ broker: "longbridge", environment: "sandbox", accountIdentifiers: [{ kind: "account_id", value: "isolated-fixture-A" }] });
const B = deriveBrokerAccountScopeIdentity({ broker: "longbridge", environment: "sandbox", accountIdentifiers: [{ kind: "account_id", value: "isolated-fixture-B" }] });
const HOST_FUNCTIONS = [
  "refreshPortfolioFromLongbridge", "activatePortfolioLedgerScope", "persistSnapshotBackgroundScopeActivation", "currentPortfolioAccountScopeStatus",
  "normalizePortfolioLedgerScopeId", "currentPortfolioLedgerScopeId", "initializeSnapshotCoverageLedger", "recordSnapshotCoverageTransition",
  "reconcileSnapshotCoverageFromSnapshots", "runPortfolioEvidenceSweep", "reconcileExpiredPortfolioSnapshotGaps", "captureReviewAccountOperation", "assertReviewAccountOperation",
  "publishRefreshedPortfolio", "publishPortfolioForAuthorization", "scheduleFreshPortfolioEvidence", "ensureAutomaticPortfolioSnapshots", "reconnectLongbridgeForSnapshotCapture",
  "captureAutomaticPortfolioSnapshots", "captureAutomaticPortfolioSnapshotsNow", "recordPortfolioSnapshotCaptureAttempt", "recordPortfolioSnapshotCaptureRetry",
  "recordPortfolioSnapshotCaptureSuccess", "uniqueRecentExecutions", "capturePostTradeAfterHistorySync", "verifyUsEodObservation", "regularClosePortfolioObservation",
  "appendPortfolioSnapshot", "portfolioSnapshotLedgerInput", "latestPortfolioValuation", "isUsEodCaptureWindow", "localDateInTimezone", "zonedDateTimeParts",
  "normalizeFxAsOf", "finiteOrNull", "recentUsTradingDates", "isStaleLongbridgeAuthorizationError", "stalePortfolioAccountScopeError",
];

function hostFunction(name) {
  const starts = [...source.matchAll(/^(?:export )?(?:async )?function ([A-Za-z0-9_]+)\(/gm)];
  const index = starts.findIndex((item) => item[1] === name);
  assert.ok(index >= 0, `real host function ${name} exists`);
  return source.slice(starts[index].index, starts[index + 1]?.index ?? source.length).replace(/^export /, "");
}

class IsolatedStore {
  constructor() { this.values = new Map(); this.persistent = true; this.beforeSet = null; this.writes = []; }
  async get(key) { return structuredClone(this.values.get(key)); }
  async set(key, value, { commitGuard } = {}) {
    await this.beforeSet?.(key, value);
    if (commitGuard && commitGuard() !== true) throw new Error("commit guard refused");
    this.values.set(key, structuredClone(value)); this.writes.push(key);
  }
  async delete(key) { this.values.delete(key); }
}

async function harness({ start = "2026-09-14T19:00:00Z", now = start, repository = new IsolatedStore(), identity = A, preferences = null, connected = true } = {}) {
  let clock = Date.parse(now), ids = 0;
  const counters = { connect: 0, refresh: 0, candles: 0, prewarm: 0, radar: 0 };
  const status = [];
  const behavior = { online: true, connectWait: null, refreshWait: null, candleWait: null, afterHoursPrice: 230, executions: [] };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const snapshotStore = new PortfolioSnapshotStore({ store: repository, now: () => new Clock(), idFactory: () => `isolated-${clock}-${++ids}` });
  const prefs = preferences ?? background.createSnapshotBackgroundPreferences({ enabled: true, notifyOnMissedCapture: false, monitoringStartedAt: start, updatedAt: start, scopeActivatedAt: { [identity.scopeId]: start } });
  const context = vm.createContext({
    ...coverage, ...background, reconcileDurableSnapshotCoverage, inspectPersistedAccountScope, planBrokerAccountScopeActivation,
    classifyLastDailyBar, expectedLastCompletedTradingDate, isUsTradingDay, isCurrentRegularCloseSnapshot,
    REGULAR_CLOSE_VALUATION_METHOD_VERSION, Date: Clock, Intl, structuredClone, console,
    PORTFOLIO_SNAPSHOT_COVERAGE_STORE_KEY: COVERAGE_KEY, PORTFOLIO_LEDGER_TIMEZONE: "America/New_York", PORTFOLIO_LEDGER_ACCOUNT_REF: "aggregate",
    PORTFOLIO_BROKER_SCOPE_IDENTITY_STORE_KEY: "fixtureScopeIdentity", PORTFOLIO_LEDGER_SCOPE_STORE_KEY: "fixtureScopeId",
    PORTFOLIO_SNAPSHOT_BACKGROUND_PREFERENCES_STORE_KEY: "fixturePreferences", LEGACY_PORTFOLIO_LEDGER_SCOPE_ID: "legacy",
    portfolioSnapshotCoverageStore: repository, portfolioSnapshotStore: snapshotStore, secureStore: repository,
    portfolioSnapshotCoverageWriteQueue: Promise.resolve(), portfolioSnapshotCaptureQueue: Promise.resolve(), portfolioSnapshotSweep: null,
    portfolioSnapshotReconnectRuntime: background.createSnapshotReconnectState(), portfolioSnapshotCaptureRuntime: {},
    portfolioSnapshotBackgroundPreferences: prefs, portfolioLedgerScopeId: identity.scopeId, portfolioBrokerScopeIdentity: identity,
    longbridgeAuthorizationLifecycle: new AuthorizationGenerationGate(), refreshedPortfolioAuthorization: new WeakMap(),
    trustedRestoreInProgress: false, portfolio: null,
    reviewSnapshotPublisher: { schedule() {} },
    Notification: { isSupported: () => false }, safeSend() {}, sendStatus: (item) => status.push(item), safeError: (error) => String(error?.message ?? error),
    scheduleAutomaticTechnicalRadar: async () => { counters.radar++; },
    classifyLongbridgeError: () => ({ kind: "network", code: null, retryable: true }),
    longbridgeFailureStatus: () => ({ state: "network_error" }),
  });
  const fixture = () => {
    const tradingDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(clock));
    const regularAt = background.usSnapshotCaptureWindow({ tradingDate }).sessionCloseAt;
    const p = behavior.afterHoursPrice;
    return { syncedAt: new Clock().toISOString(), status: "live", holdingsStatus: "live", accountScopeIdentity: context.portfolioBrokerScopeIdentity,
      account: { baseCurrency: "USD", netAssets: 1000 + p * 10, totalCash: 1000, valuationComplete: true },
      positions: [{ symbol: "AAPL.US", instrumentType: "equity", currency: "USD", quantity: 10, lastPrice: p, marketValue: p * 10, marketValueBase: p * 10,
        grossMarketValueBase: p * 10, pnlBase: 100, weight: 65, quoteTimestamp: new Clock().toISOString(), quoteSession: "post_market", valuationStatus: "priced",
        regularLastPrice: 200, regularMarketValue: 2000, regularMarketValueBase: 2000, regularGrossMarketValueBase: 2000, regularPnlBase: 0, regularQuoteTimestamp: regularAt }],
      quoteAsOf: new Clock().toISOString(), quoteLatestAsOf: new Clock().toISOString(), regularQuoteAsOf: regularAt, regularQuoteLatestAsOf: regularAt,
      totals: { positionsGrossMarketValueBase: p * 10, positionsNetMarketValueBase: p * 10 }, dataQuality: { valuationComplete: true, fxStatus: "not_required" }, fx: {},
    };
  };
  context.longbridge = { connected, hasSavedAuthorization: async () => true, connect: async ({ interactive }) => {
    assert.equal(interactive, false); counters.connect++; await behavior.connectWait?.(); if (!behavior.online) throw new Error("controlled offline"); context.longbridge.connected = true;
  } };
  context.portfolioService = {
    refresh: async ({ commitGuard }) => { counters.refresh++; const result = fixture(); await behavior.refreshWait?.(); if (!behavior.online) throw new Error("controlled offline"); if (!commitGuard()) context.longbridgeAuthorizationLifecycle.assertCurrent(-1); return result; },
    prewarmCandles: async () => { counters.prewarm++; },
    candles: async () => { counters.candles++; await behavior.candleWait?.(); if (!behavior.online) throw new Error("controlled offline"); const tradingDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(clock)); return [{ tradeDate: tradingDate, open: 100, high: 105, low: 99, close: 104, volume: 1000 }]; },
  };
  context.tradeHistoryService = { cached: async () => ({ accountScopeId: context.portfolioLedgerScopeId, executions: structuredClone(behavior.executions) }) };
  vm.runInContext(HOST_FUNCTIONS.map(hostFunction).join("\n"), context, { filename: "isolated-real-main-snapshot-functions.mjs" });
  context.portfolioSnapshotCoverageLedger = await context.initializeSnapshotCoverageLedger({ store: repository, snapshotStore, scopeId: identity.scopeId });
  async function settle() {
    // Capture is intentionally scheduled asynchronously by the real publisher.
    for (let i = 0; i < 3; i++) { await context.portfolioSnapshotCaptureQueue; await context.portfolioSnapshotCoverageWriteQueue; }
  }
  return { context, repository, snapshotStore, counters, status, behavior, fixture, settle,
    setTime: (value) => { clock = Date.parse(value); },
    async sweep(value) { if (value) clock = Date.parse(value); await context.runPortfolioEvidenceSweep(new Clock()); await settle(); },
    async entries() { await settle(); return coverage.listSnapshotCoverageEntries(await repository.get(COVERAGE_KEY)); },
    async snapshots() { await settle(); return snapshotStore.listSnapshots({ order: "asc", limit: 12_000 }); },
    async switchAccount(next) { context.longbridgeAuthorizationLifecycle.advance(); context.portfolioBrokerScopeIdentity = next; context.portfolioLedgerScopeId = next.scopeId; await context.persistSnapshotBackgroundScopeActivation({ scopeId: next.scopeId, activatedAt: new Clock() }); },
  };
}

test("real host normal close, repeated polls and post-market observations preserve one immutable EOD", async () => {
  const h = await harness();
  await h.sweep("2026-09-14T20:10:00Z");
  const first = (await h.snapshots())[0];
  assert.equal(first.kind, "eod"); assert.equal(first.summary.totalAssets, 3000);
  assert.equal(first.holdings[0].marketPrice, 200); assert.equal(first.dataQuality.completeForPeriodReturn, false);
  assert.equal((await h.entries())[0].status, "confirmed");
  assert.equal((await h.entries())[0].attemptCount, 1);
  const network = structuredClone(h.counters);
  await Promise.all([h.sweep("2026-09-14T20:25:00Z"), h.sweep(), h.sweep()]);
  assert.equal(h.counters.refresh, network.refresh); assert.equal(h.counters.candles, network.candles); assert.equal(h.counters.connect, network.connect);
  assert.equal((await h.entries())[0].attemptCount, 1);
  h.setTime("2026-09-14T22:00:00Z"); h.behavior.afterHoursPrice = 300;
  h.behavior.executions = [{ tradeId: "post-close-fill", symbol: "AAPL.US", doneAt: "2026-09-14T21:59:00Z" }];
  await h.context.captureAutomaticPortfolioSnapshots(h.fixture()); await h.settle();
  const observations = await h.snapshots();
  assert.deepEqual(observations.find((item) => item.kind === "eod"), first);
  assert.equal(observations.filter((item) => item.kind === "post_trade").length, 1);
  assert.equal(observations.find((item) => item.kind === "post_trade").holdings[0].marketPrice, 300);
});

test("real host offline window recovery uses bounded reconnect and captures only after an actual fresh observation", async () => {
  const h = await harness({ connected: false }); h.behavior.online = false;
  await h.sweep("2026-09-14T20:10:00Z");
  assert.equal((await h.snapshots()).length, 0); assert.equal(h.counters.connect, 1);
  await h.sweep("2026-09-14T20:10:01Z"); assert.equal(h.counters.connect, 1);
  h.behavior.online = true;
  await h.sweep("2026-09-14T20:30:00Z");
  assert.equal(h.counters.connect, 2); assert.equal((await h.snapshots()).length, 1);
  assert.equal((await h.entries())[0].status, "confirmed");
  assert.ok((await h.entries())[0].attemptCount >= 1);
});

test("real host sleep across deadline and next-day restart preserve gaps without historical reconstruction", async () => {
  const h = await harness();
  await h.sweep("2026-09-15T01:00:00Z");
  assert.equal(h.counters.refresh, 0); assert.equal((await h.snapshots()).length, 0);
  assert.equal((await h.entries())[0].tradingDate, "2026-09-14"); assert.equal((await h.entries())[0].status, "gap");
  const restarted = await harness({ repository: h.repository, now: "2026-09-16T20:15:00Z", preferences: h.context.portfolioSnapshotBackgroundPreferences });
  await restarted.sweep();
  const entries = await restarted.entries();
  assert.deepEqual(entries.map((item) => [item.tradingDate, item.status]), [["2026-09-14", "gap"], ["2026-09-15", "gap"], ["2026-09-16", "confirmed"]]);
  assert.deepEqual((await restarted.snapshots()).map((item) => item.tradingDate), ["2026-09-16"]);
});

test("real host repairs a failed coverage commit from durable snapshots after restart instead of sealing a false gap", async () => {
  const h = await harness();
  h.repository.beforeSet = (key, next) => { if (key === COVERAGE_KEY && next.entries.some((item) => item.status === "confirmed")) throw new Error("controlled coverage commit failure"); };
  await h.sweep("2026-09-14T20:10:00Z");
  const durable = (await h.snapshots())[0]; assert.ok(durable);
  assert.notEqual((await h.entries())[0].status, "confirmed");
  h.repository.beforeSet = null;
  const restarted = await harness({ repository: h.repository, now: "2026-09-15T01:00:00Z", preferences: h.context.portfolioSnapshotBackgroundPreferences });
  await restarted.sweep();
  assert.equal((await restarted.entries())[0].status, "confirmed");
  assert.equal((await restarted.entries())[0].confirmedSnapshotId, durable.snapshotId);
  assert.equal(restarted.counters.refresh, 0); assert.equal(restarted.counters.candles, 0);
});

test("real host A→B→A authorization rejects a late A result and keeps each successful account date separate", async () => {
  const h = await harness();
  let release, entered;
  const waiting = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  h.behavior.refreshWait = async () => { entered(); await waiting; };
  h.setTime("2026-09-14T20:10:00Z");
  const obsolete = h.context.ensureAutomaticPortfolioSnapshots(); await started;
  await h.switchAccount(B); await h.switchAccount(A); release();
  await assert.rejects(obsolete, /授权|generation/i);
  assert.equal((await h.snapshots()).length, 0);
  h.behavior.refreshWait = null;
  await h.sweep();
  await h.switchAccount(B); await h.sweep();
  const entries = await h.entries();
  assert.equal(entries.filter((item) => item.status === "confirmed").length, 2);
  assert.deepEqual(new Set((await h.snapshots()).map((item) => item.accountScope.scopeId)), new Set([A.scopeId, B.scopeId]));
  await h.switchAccount(A);
  const refreshes = h.counters.refresh; await h.sweep(); assert.equal(h.counters.refresh, refreshes);
});

test("real host A→B→A at the final snapshot commit rejects an obsolete capture even after its market verification passed", async () => {
  const h = await harness(); h.setTime("2026-09-14T20:10:00Z");
  let switched = false;
  h.repository.beforeSet = async (key) => {
    if (key !== PORTFOLIO_SNAPSHOT_STORE_KEY || switched) return;
    switched = true; await h.switchAccount(B); await h.switchAccount(A);
  };
  await assert.rejects(h.context.captureAutomaticPortfolioSnapshots(h.fixture()), /授权|generation/i);
  await h.settle();
  assert.equal(h.counters.candles, 1, "the rejected response had passed the actual candle verification path");
  assert.equal((await h.snapshots()).length, 0);
  assert.ok((await h.entries()).every((entry) => entry.status !== "confirmed"));
  h.repository.beforeSet = null;
  h.setTime("2026-09-14T20:11:00Z"); await h.sweep();
  assert.equal((await h.snapshots()).length, 1);
});

test("real host reconnect finishing beyond the hard deadline never fetches later holdings to label an earlier close", async () => {
  const h = await harness({ connected: false });
  h.behavior.connectWait = async () => { h.setTime("2026-09-15T00:00:01Z"); };
  await h.sweep("2026-09-14T23:59:55Z");
  assert.equal(h.counters.connect, 1); assert.equal(h.counters.refresh, 0); assert.equal(h.counters.candles, 0);
  assert.equal((await h.snapshots()).length, 0);
  await h.sweep();
  assert.equal((await h.entries())[0].status, "gap");
});

test("real host retains verified EOD across disconnect without another broker connection", async () => {
  const h = await harness(); await h.sweep("2026-09-14T20:10:00Z");
  h.context.longbridge.connected = false;
  const connects = h.counters.connect; await h.sweep("2026-09-14T20:30:00Z");
  assert.equal(h.counters.connect, connects, "an already durable EOD must be checked before reconnecting");
});

test("real host local EOD read failure fails closed before reconnect and releases the sweep lock for a safe retry", async () => {
  const h = await harness({ connected: false }); h.setTime("2026-09-14T20:10:00Z");
  const actualList = h.snapshotStore.listSnapshots.bind(h.snapshotStore);
  h.snapshotStore.listSnapshots = async () => { throw new Error("controlled ledger read failure"); };
  await assert.rejects(h.context.ensureAutomaticPortfolioSnapshots(), /ledger read failure/);
  assert.equal(h.context.portfolioSnapshotSweep, null);
  assert.equal(h.counters.connect, 0); assert.equal(h.counters.refresh, 0); assert.equal(h.counters.candles, 0);
  h.snapshotStore.listSnapshots = actualList;
  assert.equal((await h.snapshots()).length, 0);
  await h.sweep(); assert.equal((await h.snapshots()).length, 1);
});

test("real host checks scope generation after both first and second local EOD reads", async () => {
  for (const switchOnRead of [1, 2]) {
    const h = await harness(); h.setTime("2026-09-14T20:10:00Z");
    const actualList = h.snapshotStore.listSnapshots.bind(h.snapshotStore);
    let reads = 0;
    h.snapshotStore.listSnapshots = async (options) => {
      const rows = await actualList(options);
      if (++reads === switchOnRead) { await h.switchAccount(B); await h.switchAccount(A); }
      return rows;
    };
    await assert.rejects(h.context.ensureAutomaticPortfolioSnapshots(), /授权|generation/i);
    assert.equal(h.context.portfolioSnapshotSweep, null);
    assert.equal(h.counters.connect, 0); assert.equal(h.counters.refresh, 0); assert.equal(h.counters.candles, 0);
    h.snapshotStore.listSnapshots = actualList;
    assert.equal((await h.snapshots()).length, 0);
  }
});

test("real host same-window restart verifies the saved EOD locally without reconnecting", async () => {
  const h = await harness(); await h.sweep("2026-09-14T20:10:00Z");
  const first = (await h.snapshots())[0];
  const restarted = await harness({ repository: h.repository, now: "2026-09-14T22:00:00Z", preferences: h.context.portfolioSnapshotBackgroundPreferences, connected: false });
  await restarted.sweep();
  assert.deepEqual(await restarted.snapshots(), [first]);
  assert.equal(restarted.counters.connect, 0); assert.equal(restarted.counters.refresh, 0); assert.equal(restarted.counters.candles, 0);
});

test("real host accepts the official early close at close+10 with an unflagged completed daily candle", async () => {
  const h = await harness({ start: "2026-11-27T17:00:00Z" });
  await h.sweep("2026-11-27T18:09:59Z"); assert.equal(h.counters.refresh, 0);
  await h.sweep("2026-11-27T18:10:00Z");
  const snapshot = (await h.snapshots())[0];
  assert.equal(snapshot?.kind, "eod");
  assert.equal(snapshot.valuation.quoteAsOf, "2026-11-27T18:00:00.000Z");
  assert.match(snapshot.note, /提前收盘日遵循实际收盘时间/);
  assert.doesNotMatch(snapshot.note, /16:00/);
  assert.equal((await h.entries())[0].status, "confirmed");
});

test("real host observes New York DST boundaries across the spring weekend without Saturday/Sunday gaps", async () => {
  const h = await harness({ start: "2026-03-06T20:00:00Z" });
  await h.sweep("2026-03-06T21:09:59Z"); assert.equal(h.counters.refresh, 0);
  await h.sweep("2026-03-06T21:10:00Z"); assert.equal((await h.snapshots())[0].kind, "eod");
  await h.sweep("2026-03-09T20:09:59Z"); assert.equal(h.counters.refresh, 1);
  await h.sweep("2026-03-09T20:10:00Z");
  assert.deepEqual((await h.entries()).map((item) => [item.tradingDate, item.status]), [["2026-03-06", "confirmed"], ["2026-03-09", "confirmed"]]);
});
