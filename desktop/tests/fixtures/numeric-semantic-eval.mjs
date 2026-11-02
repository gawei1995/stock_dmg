// Fixed synthetic inputs. No account/network access and no live model calls.
// These cases test host facts and structured citations, not language comprehension.
export const EVAL = Object.freeze({
  version: "numeric-semantic-regression/v1",
  mode: "synthetic_structured_citation_regression",
  liveModelCalls: false,
  at: "2026-08-31T21:01:00.000Z",
  cutoff: "2026-08-10T00:00:00.000Z",
});

export function longbridgeInput({ option = false, multiplier = 100 } = {}) {
  const symbol = option ? "AAPL260918C250000.US" : "AAPL.US";
  return {
    baseCurrency: "USD",
    positions: { list: [{ stock_info: [{ symbol, quantity: "2", available_quantity: "2",
      currency: "USD", cost_price: option ? "2" : "200", market: "US" }] }] },
    balances: [{ currency: "HKD", net_assets: "80000", total_cash: "-8000", buy_power: "0", cash_infos: [] }],
    quotes: [{ symbol, last_done: option ? "5" : "250", prev_close: option ? "4" : "240",
      timestamp: EVAL.at, ...(option && multiplier != null ? { contract_multiplier: multiplier } : {}) }],
    exchangeRates: { exchanges: [{ from_currency: "USD", to_currency: "HKD", rate: 8 }] },
  };
}

export function ibkrInput() {
  return {
    account: { id: "U000000", currency: "HKD" },
    summary: { netliquidation: { amount: 40000, currency: "HKD" },
      totalcashvalue: { amount: 8000, currency: "HKD" }, buyingpower: { amount: 16000, currency: "HKD" } },
    ledger: { USD: { exchangerate: 8 }, HKD: { exchangerate: 1 } },
    positions: [{ conid: "101", acctId: "U000000", assetClass: "STK", ticker: "AAPL", isUS: true,
      position: 4, currency: "USD", mktPrice: 250, mktValue: 1000, avgCost: 200, unrealizedPnl: 200 }],
    now: Date.parse(EVAL.at),
  };
}

export function bar(tradeDate, close, overrides = {}) {
  return { timestamp: `${tradeDate}T20:00:00.000Z`, tradeDate, open: close,
    high: close, low: close, close, volume: 1000, isClosed: true, ...overrides };
}

export function technicalBars() {
  const rows = [];
  for (let date = new Date("2026-07-20T00:00:00Z"); rows.length < 30; date.setUTCDate(date.getUTCDate() + 1)) {
    if (![0, 6].includes(date.getUTCDay())) rows.push(bar(date.toISOString().slice(0, 10), 100, { high: 102, low: 98 }));
  }
  return [...rows, bar("2026-08-31", 999, { high: 1000, low: 99, isClosed: false })];
}

export function executions({ option = false, multiplier = 100 } = {}) {
  const symbol = option ? "AAPL260918C250000.US" : "AAOI.US";
  return [
    { tradeId: "buy", orderId: "before", symbol, side: "Buy", quantity: option ? 1 : 100,
      price: option ? 2 : 10, currency: "USD", doneAt: "2026-08-03T14:00:00.000Z" },
    { tradeId: "sell", orderId: "after", symbol, side: "Sell", quantity: option ? 1 : 20,
      price: option ? 3 : 12, currency: "USD", doneAt: "2026-08-12T20:01:00.000Z" },
  ].map((row) => option && multiplier != null ? { ...row, contractMultiplier: multiplier } : row);
}

export function outcomeFixture() {
  return {
    cycle: { id: "eval-cycle", type: "position_lifecycle", symbol: "AAOI.US", benchmark: "QQQ.US", timezone: "UTC",
      startAt: "2026-08-03T00:00:00.000Z", endAt: "2026-08-14T23:59:59.000Z",
      brokerLinks: { executionIds: ["buy", "sell"] },
      startingPortfolio: { snapshotAt: "2026-07-31T23:00:00.000Z", positions: [] } },
    archive: { syncedAt: EVAL.at, executions: executions() },
    series: {
      "AAOI.US": [bar("2026-08-03", 10, { high: 11, low: 9 }), bar("2026-08-12", 12),
        bar("2026-08-14", 11), bar("2026-08-17", 999)],
      "QQQ.US": [bar("2026-08-03", 100), bar("2026-08-14", 105), bar("2026-08-17", 1)],
    },
  };
}

export function sampleFixture() {
  return {
    cases: ["win", "loss", "flat", "unverified", "censored"].map((id) => ({ id })),
    tests: [
      { id: "w", caseId: "win", outcomeR: 2, outcomeVerified: true, completedAt: EVAL.at },
      { id: "l", caseId: "loss", outcomeR: -1, outcomeVerified: true },
      { id: "f", caseId: "flat", outcomeR: 0, outcomeVerified: true },
      { id: "u", caseId: "unverified", outcomeR: 9, outcomeVerified: false },
      { id: "c", caseId: "censored", outcomeR: 9, outcomeVerified: true, censored: true },
      { id: "x", caseId: "foreign", outcomeR: 9, outcomeVerified: true },
      { id: "old", caseId: "win", outcomeR: -9, outcomeVerified: true, completedAt: "2026-08-30T00:00:00.000Z" },
    ],
  };
}

export function blindFixture() {
  return {
    cycle: { id: "eval-blind", type: "catalyst", title: "Synthetic event", symbol: "AAOI.US", scope: "symbol",
      benchmark: "QQQ.US", startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-08-20T23:59:59.000Z",
      eventAt: "2026-08-11T20:00:00.000Z", status: "sealed",
      brokerLinks: { revision: 1, evidenceRevision: 1, orderIds: ["before", "after"], executionIds: ["buy", "sell"], confirmedAt: EVAL.cutoff },
      exAnteVersions: [{ version: 1, sealedAt: EVAL.cutoff, cutoffAt: EVAL.cutoff, timing: "prospective",
        eligibleForFormalStats: true, hash: "synthetic-pre-event-version", snapshot: { exAnte: {
          myView: "事前判断：需求改善", marketView: "事前预期偏高", plannedAction: "确认再加仓", invalidation: "指引下修" } } }],
      checkpoints: [{ id: "pre", at: "2026-08-07T12:00:00.000Z", note: "事前观察" },
        { id: "post", at: "2026-08-12T12:00:00.000Z", note: "FUTURE_SENTINEL_987654" }],
      phaseRuns: { blind: [], outcome: [] }, outcome: { pnl: 987654, summary: "FUTURE_SENTINEL_987654" } },
    archive: { syncedAt: EVAL.at, source: "synthetic broker fixture", completeness: { orders: "complete", executions: "complete" }, warnings: [],
      orders: [{ orderId: "before", symbol: "AAOI.US", side: "Buy", quantity: 100, submittedAt: "2026-08-03T13:59:00.000Z" },
        { orderId: "after", symbol: "AAOI.US", side: "Sell", quantity: 20, submittedAt: "2026-08-12T20:00:00.000Z" }],
      executions: executions() },
  };
}
