import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewTradePricePath,
  deriveSelectedBuySellWindow,
} from "../src/review/review-trade-price-path.mjs";

function execution({
  tradeId,
  orderId = `order-${tradeId}`,
  side,
  quantity,
  price,
  doneAt,
  symbol = "AAOI.US",
  currency = "USD",
  ...rest
}) {
  return { tradeId, orderId, side, quantity, price, doneAt, symbol, currency, ...rest };
}

function bar(tradeDate, close, { open = close, high = close, low = close, isClosed = true } = {}) {
  return { tradeDate, open, high, low, close, isClosed, symbol: "AAOI.US" };
}

test("explicit buy to sell builds FIFO lots, raw-fill P&L and an adjusted daily path without future bars", () => {
  const result = buildReviewTradePricePath({
    // 10:00 ET buy; 17:00 ET sell. The US exchange timezone must win over
    // this deliberately wrong cycle timezone.
    timezone: "Asia/Shanghai",
    selectedExecutions: [
      execution({ tradeId: "buy", side: "Buy", quantity: 100, price: 10, doneAt: "2026-08-03T14:00:00Z" }),
      execution({ tradeId: "sell", side: "Sell", quantity: 100, price: 12, doneAt: "2026-08-05T21:00:00Z" }),
    ],
    candles: [
      bar("2026-08-03", 100, { open: 96, high: 111, low: 80 }),
      bar("2026-08-04", 110, { open: 102, high: 130, low: 90 }),
      bar("2026-08-05", 120, { open: 111, high: 125, low: 105 }),
      bar("2026-08-06", 999, { high: 1_000, low: 900 }),
    ],
  });

  assert.equal(result.status, "available");
  assert.deepEqual(result.window, {
    startAt: "2026-08-03T14:00:00.000Z",
    endAt: "2026-08-05T21:00:00.000Z",
    startActivityId: "execution:buy",
    endActivityId: "execution:sell",
    boundaryPolicy: "earliest_selected_buy_to_latest_selected_sell",
  });
  assert.equal(result.coverage.timezone, "America/New_York");
  assert.equal(result.coverage.futureBarExcluded, true);
  assert.equal(result.coverage.eligibleBarCount, 3);
  assert.equal(result.pricePath.trend.granularity, "daily");
  assert.deepEqual(result.pricePath.trend.segments.map((item) => item.endTradeDate), [
    "2026-08-03", "2026-08-04", "2026-08-05",
  ]);
  assert.equal(result.pricePath.adjustedReferenceClose, 100);
  assert.equal(result.pricePath.periodReturnPercent, 20);
  // The buy-day high/low are not used because the position was opened after
  // the session began. MAE/MFE stay entirely on the adjusted candle basis.
  assert.equal(result.pricePath.mfePercent, 30);
  assert.equal(result.pricePath.maePercent, -10);
  assert.equal(result.pricePath.rawFillEndpoints.fillToFillReturnPercent, 20);
  assert.equal(result.pricePath.coverage.basisMismatch, true);
  assert.equal(result.metrics.linkedSelectionGrossPnl, 200);
  assert.equal(result.metrics.rawBuyVwap, 10);
  assert.equal(result.metrics.rawSellVwap, 12);
  assert.equal(result.lots[0].status, "closed");
  assert.equal(result.cycles[0].quantity, 100);
  assert.equal(result.cycles[0].executionBasis, "raw_execution_fills");
  assert.doesNotMatch(JSON.stringify(result.pricePath.trend), /999|1000|900/);
});

test("more than three eligible trading days use deterministic 3/3/.../remainder segments", () => {
  for (const [barCount, expected] of [
    [4, [3, 1]],
    [7, [3, 3, 1]],
    [8, [3, 3, 2]],
  ]) {
    const candles = Array.from({ length: barCount }, (_, index) => {
      const day = String(index + 3).padStart(2, "0");
      return bar(`2026-08-${day}`, 100 + index);
    });
    const endDay = String(barCount + 2).padStart(2, "0");
    const result = buildReviewTradePricePath({
      selectedExecutions: [
        execution({ tradeId: `buy-${barCount}`, side: "Buy", quantity: 1, price: 50, doneAt: "2026-08-03T13:00:00Z" }),
        execution({ tradeId: `sell-${barCount}`, side: "Sell", quantity: 1, price: 55, doneAt: `2026-08-${endDay}T21:00:00Z` }),
      ],
      candles,
    });

    assert.equal(result.pricePath.trend.granularity, "3_trading_days");
    assert.equal(result.pricePath.trend.segmentTradingDays, 3);
    assert.deepEqual(result.pricePath.trend.segments.map((item) => item.tradingDayCount), expected);
  }
});

test("partial sell is a closed sub-cycle while the selected lot remains explicitly open", () => {
  const result = buildReviewTradePricePath({
    selectedExecutions: [
      execution({ tradeId: "buy", side: "Buy", quantity: 100, price: 10, doneAt: "2026-08-03T13:00:00Z" }),
      execution({ tradeId: "sell", side: "Sell", quantity: 20, price: 12, doneAt: "2026-08-04T21:00:00Z" }),
    ],
    candles: [bar("2026-08-03", 10), bar("2026-08-04", 12)],
  });

  assert.equal(result.status, "partial");
  assert.equal(result.reason, "selected_position_remains_open");
  assert.equal(result.positionStatus, "partially_closed");
  assert.equal(result.lots[0].status, "partially_closed");
  assert.equal(result.lots[0].matchedQuantity, 20);
  assert.equal(result.lots[0].openQuantity, 80);
  assert.equal(result.cycles.length, 1);
  assert.equal(result.cycles[0].quantity, 20);
  assert.equal(result.metrics.realizedQuantity, 20);
  assert.equal(result.metrics.openQuantity, 80);
  assert.equal(result.metrics.linkedSelectionGrossPnl, 40);
});

test("multiple selected buy and sell nodes are retained and FIFO matched", () => {
  const selectedExecutions = [
    execution({ tradeId: "b1", side: "Buy", quantity: 100, price: 10, doneAt: "2026-08-03T13:00:00Z" }),
    execution({ tradeId: "b2", side: "Buy", quantity: 50, price: 12, doneAt: "2026-08-04T13:00:00Z" }),
    execution({ tradeId: "s1", side: "Sell", quantity: 120, price: 15, doneAt: "2026-08-05T21:00:00Z" }),
    execution({ tradeId: "s2", side: "Sell", quantity: 30, price: 14, doneAt: "2026-08-06T21:00:00Z" }),
  ];
  const result = buildReviewTradePricePath({
    selectedExecutions,
    candles: [
      bar("2026-08-03", 10), bar("2026-08-04", 12),
      bar("2026-08-05", 15), bar("2026-08-06", 14),
    ],
  });

  assert.equal(result.activities.length, 4);
  assert.deepEqual(result.activities.map((item) => item.id), [
    "execution:b1", "execution:b2", "execution:s1", "execution:s2",
  ]);
  assert.equal(result.lots.length, 2);
  assert.equal(result.cycles.length, 3);
  assert.deepEqual(result.cycles.map((item) => item.quantity), [100, 20, 30]);
  assert.equal(result.positionStatus, "closed");
  assert.equal(result.metrics.linkedSelectionGrossPnl, 620);
});

test("an explicitly selected execution uses its parent only as evidence and never absorbs sibling fills", () => {
  const orders = [
    {
      orderId: "parent-buy",
      symbol: "AAOI.US",
      side: "Buy",
      currency: "USD",
      submittedAt: "2026-07-01T00:00:00Z",
    },
    { orderId: "sell-order", symbol: "AAOI.US", side: "Sell", currency: "USD" },
  ];
  const executions = [
    execution({ tradeId: "chosen-buy", orderId: "parent-buy", side: null, quantity: 10, price: 10, doneAt: "2026-08-03T14:00:00Z" }),
    execution({ tradeId: "sibling-buy", orderId: "parent-buy", side: null, quantity: 90, price: 9, doneAt: "2026-07-30T14:00:00Z" }),
    execution({ tradeId: "chosen-sell", orderId: "sell-order", side: null, quantity: 10, price: 12, doneAt: "2026-08-05T21:00:00Z" }),
  ];
  const window = deriveSelectedBuySellWindow({
    selectedExecutionIds: ["chosen-buy", "chosen-sell"],
    selectedOrderIds: [],
    orders,
    executions,
  });

  assert.equal(window.status, "available");
  assert.equal(window.windowStartAt, "2026-08-03T14:00:00.000Z");
  assert.equal(window.windowEndAt, "2026-08-05T21:00:00.000Z");
  assert.deepEqual(window.activities.map((item) => item.id), [
    "execution:chosen-buy", "execution:chosen-sell",
  ]);
  assert.doesNotMatch(JSON.stringify(window), /sibling-buy|2026-07-30|2026-07-01/);
  assert.equal(window.coverage.submittedAtUsed, false);

  const built = buildReviewTradePricePath({
    selectedOrderIds: [],
    selectedExecutionIds: ["chosen-buy", "chosen-sell"],
    orders,
    executions,
    candles: [bar("2026-08-03", 10), bar("2026-08-04", 11), bar("2026-08-05", 12)],
  });
  assert.deepEqual(built.activities.map((item) => item.id), [
    "execution:chosen-buy", "execution:chosen-sell",
  ]);
  assert.equal(built.metrics.realizedQuantity, 10);
});

test("selecting a parent order expands to all of that order's archived fills", () => {
  const orders = [
    { orderId: "buy-order", symbol: "AAOI.US", side: "Buy", currency: "USD" },
    { orderId: "sell-order", symbol: "AAOI.US", side: "Sell", currency: "USD" },
  ];
  const executions = [
    execution({ tradeId: "b1", orderId: "buy-order", side: null, quantity: 5, price: 10, doneAt: "2026-08-03T14:00:00Z" }),
    execution({ tradeId: "b2", orderId: "buy-order", side: null, quantity: 5, price: 11, doneAt: "2026-08-04T14:00:00Z" }),
    execution({ tradeId: "s1", orderId: "sell-order", side: null, quantity: 10, price: 12, doneAt: "2026-08-05T21:00:00Z" }),
  ];
  const window = deriveSelectedBuySellWindow({
    selectedOrderIds: ["buy-order", "sell-order"],
    selectedExecutionIds: [],
    orders,
    executions,
  });

  assert.equal(window.status, "available");
  assert.deepEqual(window.activities.map((item) => item.id), [
    "execution:b1", "execution:b2", "execution:s1",
  ]);

  const built = buildReviewTradePricePath({
    selectedOrderIds: ["buy-order", "sell-order"],
    selectedExecutionIds: [],
    orders,
    executions,
    candles: [bar("2026-08-03", 10), bar("2026-08-04", 11), bar("2026-08-05", 12)],
  });
  assert.deepEqual(built.activities.map((item) => item.id), [
    "execution:b1", "execution:b2", "execution:s1",
  ]);
  assert.equal(built.metrics.realizedQuantity, 10);
});

test("missing Sell and unknown starting inventory fail closed with structured reasons", () => {
  const open = buildReviewTradePricePath({
    selectedExecutions: [
      execution({ tradeId: "buy", side: "Buy", quantity: 10, price: 10, doneAt: "2026-08-03T14:00:00Z" }),
    ],
    candles: [bar("2026-08-03", 10)],
  });
  assert.equal(open.status, "unavailable");
  assert.equal(open.reason, "selected_sell_activity_missing");
  assert.equal(open.lots[0].status, "open");
  assert.equal(open.pricePath.mfePercent, null);

  const openWindow = deriveSelectedBuySellWindow({
    selectedOrders: [],
    selectedExecutions: [
      execution({ tradeId: "window-buy", side: "Buy", quantity: 10, price: 10, doneAt: "2026-08-03T14:00:00Z" }),
    ],
  });
  assert.equal(openWindow.status, "unavailable");
  assert.equal(openWindow.reason, "selected_sell_activity_missing");
  assert.equal(openWindow.windowStartAt, null);
  assert.equal(openWindow.windowEndAt, null);

  const unknownInventory = buildReviewTradePricePath({
    selectedExecutions: [
      execution({ tradeId: "sell", side: "Sell", quantity: 10, price: 12, doneAt: "2026-08-03T14:00:00Z" }),
    ],
  });
  assert.equal(unknownInventory.status, "unavailable");
  assert.equal(unknownInventory.reason, "selected_sell_requires_unselected_or_starting_inventory");
});

test("invalid or unsorted candles never produce trend, MAE or MFE", () => {
  const result = buildReviewTradePricePath({
    selectedExecutions: [
      execution({ tradeId: "buy", side: "Buy", quantity: 1, price: 10, doneAt: "2026-08-03T13:00:00Z" }),
      execution({ tradeId: "sell", side: "Sell", quantity: 1, price: 12, doneAt: "2026-08-05T21:00:00Z" }),
    ],
    candles: [bar("2026-08-05", 12), bar("2026-08-03", 10)],
  });

  assert.equal(result.status, "partial");
  assert.equal(result.pricePath.status, "unavailable");
  assert.equal(result.pricePath.reason, "daily_candles_not_ascending");
  assert.equal(result.pricePath.mfePercent, null);
  assert.equal(result.pricePath.maePercent, null);
  assert.deepEqual(result.pricePath.trend.segments, []);
});

test("a Sell-date bar before the exchange close is excluded instead of leaking future data", () => {
  const result = buildReviewTradePricePath({
    selectedExecutions: [
      execution({ tradeId: "buy", side: "Buy", quantity: 1, price: 10, doneAt: "2026-08-03T13:00:00Z" }),
      // 11:00 ET, before the official daily close.
      execution({ tradeId: "sell", side: "Sell", quantity: 1, price: 11, doneAt: "2026-08-04T15:00:00Z" }),
    ],
    candles: [
      bar("2026-08-03", 10),
      bar("2026-08-04", 999, { high: 1_000, low: 1 }),
      bar("2026-08-05", 2_000),
    ],
  });

  assert.equal(result.pricePath.coverage.futureBarExcluded, true);
  assert.equal(result.pricePath.coverage.exitTradeDateCovered, false);
  assert.equal(result.pricePath.adjustedLastClose, 10);
  assert.equal(result.pricePath.periodReturnPercent, 0);
  assert.equal(result.pricePath.mfePercent, 0);
  assert.equal(result.pricePath.maePercent, 0);
  assert.doesNotMatch(JSON.stringify(result.pricePath.trend), /999|1000|2000/);
});

test("excluded execution prices and missing selected archive records fail closed without throwing", () => {
  const excluded = buildReviewTradePricePath({
    selectedExecutions: [
      execution({
        tradeId: "bad",
        side: "Buy",
        quantity: 1,
        price: 10,
        doneAt: "2026-08-03T14:00:00Z",
        priceAudit: { status: "excluded" },
      }),
    ],
  });
  assert.equal(excluded.status, "unavailable");
  assert.equal(excluded.reason, "selected_execution_price_excluded");

  const missing = deriveSelectedBuySellWindow({
    selectedOrderIds: [],
    selectedExecutionIds: ["not-in-archive"],
    orders: [],
    executions: [],
  });
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.reason, "selected_broker_records_missing");
  assert.deepEqual(missing.coverage.missingExecutionIds, ["not-in-archive"]);
});
