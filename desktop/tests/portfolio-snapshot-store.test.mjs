import assert from "node:assert/strict";
import test from "node:test";
import {
  isCurrentRegularCloseSnapshot,
  PORTFOLIO_SNAPSHOT_STORE_KEY,
  PortfolioSnapshotStore,
  REGULAR_CLOSE_VALUATION_METHOD_VERSION,
} from "../src/data/portfolio-snapshot-store.mjs";

function memoryStore({ persistent = true } = {}) {
  const values = new Map();
  return {
    persistent,
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => values.set(key, structuredClone(value)),
    unsafeRead: (key) => structuredClone(values.get(key)),
    unsafeWrite: (key, value) => values.set(key, structuredClone(value)),
  };
}

function fixture(overrides = {}) {
  return {
    idempotencyKey: "eod:longbridge-main:2026-08-19",
    kind: "eod",
    capturedAt: "2026-08-19T21:30:00.000Z",
    timezone: "America/New_York",
    accountScope: {
      scopeId: "longbridge-main",
      broker: "longbridge",
      accounts: [{ accountRef: "account-us", accountType: "margin", baseCurrency: "USD" }],
    },
    summary: {
      reportingCurrency: "USD",
      totalAssets: 100_000,
      cash: 20_000,
      grossExposure: 80_000,
      netExposure: 80_000,
      longExposure: 80_000,
      shortExposure: 0,
    },
    holdings: [{
      accountRef: "account-us",
      symbol: "AAPL.US",
      assetType: "equity",
      currency: "USD",
      quantity: 100,
      marketPrice: 200,
      marketValue: 20_000,
      valueInReportingCurrency: 20_000,
      weight: 0.2,
    }],
    dataQuality: { status: "complete", completeForPeriodReturn: true, issues: [] },
    fx: { status: "not_required", rates: [] },
    provenance: {
      provider: "longbridge",
      transport: "openapi",
      fetchedAt: "2026-08-19T21:30:00.000Z",
      sourceSnapshotId: "lb-20260819-close",
      freshness: "live",
    },
    ...overrides,
  };
}

function makeStore(backing = memoryStore(), options = {}) {
  let id = 0;
  const nowValues = [
    "2026-08-20T01:00:00.000Z",
    "2026-08-20T01:01:00.000Z",
    "2026-08-20T01:02:00.000Z",
    "2026-08-20T01:03:00.000Z",
  ];
  const snapshots = new PortfolioSnapshotStore({
    store: backing,
    now: () => new Date(nowValues[Math.min(id, nowValues.length - 1)]),
    idFactory: () => `snapshot-${++id}`,
    ...options,
  });
  return { snapshots, backing };
}

test("appends an encrypted, immutable EOD snapshot with account and quality provenance", async () => {
  const { snapshots } = makeStore();
  const result = await snapshots.appendSnapshot(fixture());

  assert.equal(result.appended, true);
  assert.equal(result.snapshot.kind, "eod");
  assert.equal(result.snapshot.tradingDate, "2026-08-19");
  assert.equal(result.snapshot.accountScope.scopeId, "longbridge-main");
  assert.equal(result.snapshot.summary.reportingCurrency, "USD");
  assert.equal(result.snapshot.summary.totalAssets, 100_000);
  assert.equal(result.snapshot.summary.cash, 20_000);
  assert.equal(result.snapshot.summary.grossExposure, 80_000);
  assert.equal(result.snapshot.summary.netExposure, 80_000);
  assert.equal(result.snapshot.summary.positionCount, 1);
  assert.equal(result.snapshot.dataQuality.status, "complete");
  assert.equal(result.snapshot.provenance.sourceSnapshotId, "lb-20260819-close");
  assert.equal(result.snapshot.valuation.session, "unknown");
  assert.equal(result.snapshot.valuation.totalAssetsBasis, "broker_observed");
  assert.match(result.snapshot.integrity.entryHash, /^[a-f0-9]{64}$/);
  assert.equal((await snapshots.verifyIntegrity()).valid, true);
});

test("records the quote session and keeps a regular close distinct from a broker after-hours mark", async () => {
  const { snapshots } = makeStore();
  const result = await snapshots.appendSnapshot(fixture({
    valuation: {
      session: "regular_close",
      quoteAsOf: "2026-08-19T19:59:30.000Z",
      quoteLatestAsOf: "2026-08-19T20:00:00.000Z",
      observedAt: "2026-08-19T20:10:00.000Z",
      totalAssetsBasis: "capture_cash_plus_regular_close_positions",
      brokerObservedNetAssets: 100_125,
      afterHoursMarksExcluded: true,
      methodVersion: REGULAR_CLOSE_VALUATION_METHOD_VERSION,
    },
    dataQuality: {
      status: "partial",
      completeForPeriodReturn: false,
      issues: [{
        code: "regular_close_cash_and_inventory_not_reconciled",
        message: "Cash and inventory were observed after the close.",
        field: "valuation.totalAssetsBasis",
      }],
    },
  }));

  assert.equal(result.snapshot.valuation.session, "regular_close");
  assert.equal(result.snapshot.valuation.afterHoursMarksExcluded, true);
  assert.equal(result.snapshot.valuation.brokerObservedNetAssets, 100_125);
  assert.equal(result.snapshot.valuation.methodVersion, REGULAR_CLOSE_VALUATION_METHOD_VERSION);
  assert.equal(isCurrentRegularCloseSnapshot(result.snapshot), true);
  assert.equal(result.snapshot.dataQuality.completeForPeriodReturn, false);
});

test("legacy EOD history does not block the current regular-close valuation version", async () => {
  const { snapshots } = makeStore();
  const legacy = await snapshots.appendSnapshot(fixture());
  const unversionedRegularClose = await snapshots.appendSnapshot(fixture({
    idempotencyKey: "legacy-regular-close:2026-08-19",
    valuation: {
      session: "regular_close",
      quoteAsOf: "2026-08-19T19:59:30.000Z",
      quoteLatestAsOf: "2026-08-19T20:00:00.000Z",
      observedAt: "2026-08-19T20:10:00.000Z",
      totalAssetsBasis: "capture_cash_plus_regular_close_positions",
      afterHoursMarksExcluded: true,
    },
  }));
  const current = await snapshots.appendSnapshot(fixture({
    idempotencyKey: "eod-regular-close-v2:longbridge-main:2026-08-19",
    valuation: {
      session: "regular_close",
      quoteAsOf: "2026-08-19T19:59:30.000Z",
      quoteLatestAsOf: "2026-08-19T20:00:00.000Z",
      observedAt: "2026-08-19T20:10:00.000Z",
      totalAssetsBasis: "capture_cash_plus_regular_close_positions",
      brokerObservedNetAssets: 100_125,
      afterHoursMarksExcluded: true,
      methodVersion: REGULAR_CLOSE_VALUATION_METHOD_VERSION,
    },
    dataQuality: {
      status: "partial",
      completeForPeriodReturn: false,
      issues: [{
        code: "regular_close_cash_and_inventory_not_reconciled",
        message: "Cash and inventory were observed after the close.",
      }],
    },
  }));

  assert.equal(isCurrentRegularCloseSnapshot(legacy.snapshot), false);
  assert.equal(isCurrentRegularCloseSnapshot(unversionedRegularClose.snapshot), false);
  assert.equal(isCurrentRegularCloseSnapshot(current.snapshot), true);
  assert.equal((await snapshots.listSnapshots({ scopeId: "longbridge-main" })).length, 3);
});

test("one scope and trading date accepts only one EOD for a formal valuation version", async () => {
  const { snapshots } = makeStore();
  const valuation = {
    session: "regular_close",
    quoteAsOf: "2026-08-19T19:59:30.000Z",
    quoteLatestAsOf: "2026-08-19T20:00:00.000Z",
    observedAt: "2026-08-19T20:10:00.000Z",
    totalAssetsBasis: "capture_cash_plus_regular_close_positions",
    brokerObservedNetAssets: 100_125,
    afterHoursMarksExcluded: true,
    methodVersion: REGULAR_CLOSE_VALUATION_METHOD_VERSION,
  };
  const outcomes = await Promise.allSettled([
    snapshots.appendSnapshot(fixture({ idempotencyKey: "regular-close-v2:first", valuation })),
    snapshots.appendSnapshot(fixture({ idempotencyKey: "regular-close-v2:second", valuation })),
  ]);

  assert.deepEqual(outcomes.map((item) => item.status).sort(), ["fulfilled", "rejected"]);
  assert.match(String(outcomes.find((item) => item.status === "rejected")?.reason?.message), /估值版本已存在/);
  assert.equal((await snapshots.listSnapshots({ scopeId: "longbridge-main" })).length, 1);
  assert.equal((await snapshots.verifyIntegrity()).valid, true);
});

test("supports EOD, post-trade and manual kinds and derives the exchange trading day", async () => {
  const { snapshots } = makeStore();
  await snapshots.appendSnapshot(fixture());
  await snapshots.appendSnapshot(fixture({
    idempotencyKey: "post-trade:fill-123",
    kind: "post_trade",
    capturedAt: "2026-08-20T00:30:00.000Z",
    provenance: { ...fixture().provenance, fetchedAt: "2026-08-20T00:30:00.000Z", sourceSnapshotId: "fill-123" },
  }));
  await snapshots.appendSnapshot(fixture({
    idempotencyKey: "manual:2026-08-20T10:00",
    kind: "manual",
    capturedAt: "2026-08-20T14:00:00.000Z",
    provenance: { provider: "user", transport: "manual", fetchedAt: "2026-08-20T14:00:00.000Z", freshness: "manual" },
  }));

  const all = await snapshots.listSnapshots({ scopeId: "longbridge-main", order: "asc" });
  assert.deepEqual(all.map((item) => item.kind), ["eod", "post_trade", "manual"]);
  assert.deepEqual(all.map((item) => item.tradingDate), ["2026-08-19", "2026-08-19", "2026-08-20"]);
});

test("the same scope and idempotency key returns the original while conflicts fail closed", async () => {
  const { snapshots } = makeStore();
  const first = await snapshots.appendSnapshot(fixture());
  const duplicate = await snapshots.appendSnapshot(fixture());
  assert.equal(duplicate.appended, false);
  assert.equal(duplicate.snapshot.snapshotId, first.snapshot.snapshotId);
  assert.equal((await snapshots.capacity()).snapshotCount, 1);

  await assert.rejects(
    snapshots.appendSnapshot(fixture({ summary: { ...fixture().summary, totalAssets: 101_000 } })),
    /不同的组合快照|拒绝覆盖历史/,
  );
  assert.equal((await snapshots.capacity()).snapshotCount, 1);
});

test("concurrent appends are serialized and preserve the integrity chain", async () => {
  const { snapshots } = makeStore();
  await Promise.all([
    snapshots.appendSnapshot(fixture()),
    snapshots.appendSnapshot(fixture({
      idempotencyKey: "post-trade:fill-456",
      kind: "post_trade",
      capturedAt: "2026-08-20T14:00:00.000Z",
      provenance: { ...fixture().provenance, fetchedAt: "2026-08-20T14:00:00.000Z", sourceSnapshotId: "fill-456" },
    })),
  ]);
  const integrity = await snapshots.verifyIntegrity();
  assert.equal(integrity.valid, true);
  assert.equal(integrity.recordCount, 2);
  const all = await snapshots.listSnapshots({ order: "asc" });
  assert.equal(all[1].integrity.previousHash, all[0].integrity.entryHash);
});

test("period, month and nearest queries return only actual observations", async () => {
  const { snapshots } = makeStore();
  for (const [day, total] of [["01", 90_000], ["15", 95_000], ["29", 105_000]]) {
    await snapshots.appendSnapshot(fixture({
      idempotencyKey: `eod:longbridge-main:2026-08-${day}`,
      capturedAt: `2026-08-${day}T21:30:00.000Z`,
      summary: { ...fixture().summary, totalAssets: total },
      provenance: { ...fixture().provenance, fetchedAt: `2026-08-${day}T21:30:00.000Z`, sourceSnapshotId: `lb-${day}` },
    }));
  }

  const month = await snapshots.queryMonth({ scopeId: "longbridge-main", month: "2026-08" });
  assert.equal(month.firstWithin.summary.totalAssets, 90_000);
  assert.equal(month.lastWithin.summary.totalAssets, 105_000);
  assert.equal(month.latestWithin.snapshotId, month.lastWithin.snapshotId);
  assert.equal(month.coverage.snapshotCount, 3);

  const period = await snapshots.queryPeriod({
    scopeId: "longbridge-main",
    startAt: "2026-08-10T00:00:00.000Z",
    endAt: "2026-08-20T23:59:59.999Z",
  });
  assert.equal(period.openingBaseline.summary.totalAssets, 90_000);
  assert.equal(period.firstWithin.summary.totalAssets, 95_000);
  assert.equal(period.lastWithin.summary.totalAssets, 95_000);
  assert.equal(period.snapshots.length, 1);
  assert.equal(period.coverage.canCalculateDeterministicDelta, true);
  assert.equal(period.coverage.canCalculatePeriodReturn, false);
  assert.ok(period.coverage.warnings.includes("external_cash_flows_and_fees_not_reconciled"));
  assert.equal(month.coverage.canCalculatePeriodReturn, false);

  const nearest = await snapshots.findNearestSnapshot({
    scopeId: "longbridge-main",
    at: "2026-08-20T00:00:00.000Z",
    direction: "at_or_before",
  });
  assert.equal(nearest.summary.totalAssets, 95_000);
  assert.equal(await snapshots.findNearestSnapshot({
    scopeId: "longbridge-main",
    at: "2026-07-01T00:00:00.000Z",
    direction: "at_or_before",
  }), null);
});

test("missing cross-currency FX provenance degrades quality rather than inventing a rate", async () => {
  const { snapshots } = makeStore();
  const result = await snapshots.appendSnapshot(fixture({
    holdings: [{
      accountRef: "account-us",
      symbol: "0700.HK",
      assetType: "equity",
      currency: "HKD",
      quantity: 100,
      marketValue: 50_000,
      valueInReportingCurrency: 6_400,
    }],
    dataQuality: { status: "complete", completeForPeriodReturn: true },
    fx: { status: "not_required", rates: [] },
  }));
  assert.equal(result.snapshot.dataQuality.status, "degraded");
  assert.equal(result.snapshot.dataQuality.completeForPeriodReturn, false);
  assert.deepEqual(result.snapshot.fx.rates, []);
  assert.ok(result.snapshot.dataQuality.issues.some((item) => item.code === "fx_rate_missing:HKD"));
});

test("records explicit FX provenance for a multi-currency snapshot", async () => {
  const { snapshots } = makeStore();
  const result = await snapshots.appendSnapshot(fixture({
    holdings: [{
      accountRef: "account-us",
      symbol: "0700.HK",
      assetType: "equity",
      currency: "HKD",
      quantity: 100,
      marketValue: 50_000,
      valueInReportingCurrency: 6_400,
    }],
    fx: {
      status: "complete",
      source: "reference-fx",
      retrievedAt: "2026-08-19T21:29:00.000Z",
      rates: [{ base: "HKD", quote: "USD", rate: 0.128, asOf: "2026-08-19T21:29:00.000Z", source: "reference-fx" }],
    },
  }));
  assert.equal(result.snapshot.dataQuality.status, "complete");
  assert.equal(result.snapshot.fx.rates[0].source, "reference-fx");
});

test("tampering is reported and queries refuse to return altered history", async () => {
  const { snapshots, backing } = makeStore();
  await snapshots.appendSnapshot(fixture());
  const raw = backing.unsafeRead(PORTFOLIO_SNAPSHOT_STORE_KEY);
  raw.snapshots[0].summary.totalAssets = 9_999_999;
  backing.unsafeWrite(PORTFOLIO_SNAPSHOT_STORE_KEY, raw);

  const integrity = await snapshots.verifyIntegrity();
  assert.equal(integrity.valid, false);
  assert.ok(integrity.issues.includes("content_hash_invalid:1"));
  await assert.rejects(
    snapshots.listSnapshots(),
    (error) => error.code === "PORTFOLIO_SNAPSHOT_INTEGRITY_FAILED",
  );
});

test("capacity failures never prune prior snapshots", async () => {
  const { snapshots } = makeStore(memoryStore(), { maxSnapshots: 1 });
  await snapshots.appendSnapshot(fixture());
  await assert.rejects(snapshots.appendSnapshot(fixture({
    idempotencyKey: "manual:second-snapshot",
    kind: "manual",
  })), /容量上限|不会自动删除/);
  assert.equal((await snapshots.listSnapshots()).length, 1);
});

test("serialized-byte capacity fails before persistence without pruning or truncation", async () => {
  const backing = memoryStore();
  const { snapshots } = makeStore(backing, { maxSerializedBytes: 200 });
  await assert.rejects(snapshots.appendSnapshot(fixture()), /加密存储容量上限|不会自动删除/);
  assert.equal(backing.unsafeRead(PORTFOLIO_SNAPSHOT_STORE_KEY), undefined);
});

test("holdings cannot escape their declared account scope", async () => {
  const { snapshots } = makeStore();
  await assert.rejects(snapshots.appendSnapshot(fixture({
    holdings: [{ ...fixture().holdings[0], accountRef: "another-account" }],
  })), /账户范围之外/);
  assert.equal((await snapshots.capacity()).snapshotCount, 0);
});

test("legacy V1 snapshots migrate without inventing missing market history", async () => {
  const backing = memoryStore();
  const legacy = fixture({
    snapshotId: "legacy-snapshot-1",
    recordedAt: "2026-08-19T21:31:00.000Z",
  });
  backing.unsafeWrite(PORTFOLIO_SNAPSHOT_STORE_KEY, {
    version: 1,
    createdAt: "2026-08-19T21:31:00.000Z",
    snapshots: [legacy],
  });
  const { snapshots } = makeStore(backing);
  const migrated = await snapshots.migrate();
  assert.deepEqual(migrated, { migrated: true, fromVersion: 1, recordCount: 1 });
  const stored = backing.unsafeRead(PORTFOLIO_SNAPSHOT_STORE_KEY);
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.migratedFromVersion, 1);
  assert.equal(stored.snapshots[0].summary.totalAssets, 100_000);
  assert.equal((await snapshots.verifyIntegrity()).valid, true);
});

test("credentials are rejected and unavailable encryption never falls back to plaintext", async () => {
  const insecure = makeStore(memoryStore({ persistent: false }));
  await assert.rejects(insecure.snapshots.appendSnapshot(fixture()), /加密存储不可用/);
  assert.equal(insecure.backing.unsafeRead(PORTFOLIO_SNAPSHOT_STORE_KEY), undefined);

  const secure = makeStore();
  await assert.rejects(
    secure.snapshots.appendSnapshot({ ...fixture(), accessToken: "must-not-be-saved" }),
    /禁止保存凭证字段/,
  );
  assert.equal((await secure.snapshots.capacity()).snapshotCount, 0);
});

test("an empty ledger explicitly reports missing period evidence", async () => {
  const { snapshots } = makeStore();
  const month = await snapshots.queryMonth({ scopeId: "longbridge-main", month: "2026-08" });
  assert.equal(month.firstWithin, null);
  assert.equal(month.lastWithin, null);
  assert.equal(month.coverage.canCalculateDeterministicDelta, false);
  assert.ok(month.coverage.warnings.includes("period_has_no_snapshot"));
});

test("an unpriced holding keeps its quantity while portfolio-return coverage degrades", async () => {
  const { snapshots } = makeStore();
  const input = fixture({
    holdings: [{
      ...fixture().holdings[0],
      marketPrice: null,
      marketValue: null,
      valueInReportingCurrency: null,
      weight: null,
    }],
  });
  const result = await snapshots.appendSnapshot(input);
  assert.equal(result.snapshot.holdings[0].quantity, 100);
  assert.equal(result.snapshot.holdings[0].marketValue, null);
  assert.equal(result.snapshot.dataQuality.status, "partial");
  assert.equal(result.snapshot.dataQuality.completeForPeriodReturn, false);
  assert.equal(
    result.snapshot.dataQuality.issues.some((item) => item.code === "holding_value_missing"),
    true,
  );
});

test("required snapshot totals reject null and empty strings instead of storing false zeros", async () => {
  const { snapshots } = makeStore();
  await assert.rejects(
    snapshots.appendSnapshot(fixture({
      summary: { ...fixture().summary, totalAssets: null },
    })),
    /总资产无效/,
  );
  await assert.rejects(
    snapshots.appendSnapshot(fixture({
      idempotencyKey: "bad-empty-cash",
      summary: { ...fixture().summary, cash: "" },
    })),
    /现金金额无效/,
  );
});
