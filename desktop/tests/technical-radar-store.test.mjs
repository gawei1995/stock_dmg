import assert from "node:assert/strict";
import test from "node:test";

import {
  TechnicalRadarStore,
  TECHNICAL_RADAR_STORE_KEY,
} from "../src/data/technical-radar-store.mjs";

test("technical radar batches are append-only, hash chained and idempotent", async () => {
  const store = memoryStore();
  const ledger = new TechnicalRadarStore({ store });
  const first = await ledger.appendBatch(batch({ inputHash: hash("a") }));
  const duplicate = await ledger.appendBatch(batch({ inputHash: hash("a") }));
  const revision = await ledger.appendBatch(batch({ inputHash: hash("b"), recordedAt: "2026-08-31T21:10:00.000Z" }));

  assert.equal(first.appended, true);
  assert.equal(duplicate.appended, false);
  assert.equal(duplicate.batch.batchId, first.batch.batchId);
  assert.equal(revision.batch.revision, 2);
  assert.equal(revision.batch.previousHash, first.batch.recordHash);
  assert.deepEqual((await ledger.listBatches()).map((item) => item.revision), [1, 2]);
  assert.deepEqual((await ledger.listBatches({ latestRevisionOnly: true })).map((item) => item.revision), [2]);
  assert.deepEqual(await ledger.verifyIntegrity(), {
    valid: true,
    batchCount: 2,
    firstInvalidIndex: null,
    reason: null,
    headHash: revision.batch.recordHash,
    updatedAt: "2026-08-31T21:10:00.000Z",
  });
});

test("technical radar isolates account scopes and date ranges", async () => {
  const ledger = new TechnicalRadarStore({ store: memoryStore() });
  await ledger.appendBatch(batch({ accountScopeId: "lb-account:one", tradingDate: "2026-08-29", inputHash: hash("a") }));
  await ledger.appendBatch(batch({ accountScopeId: "lb-account:two", tradingDate: "2026-08-30", inputHash: hash("b") }));
  await ledger.appendBatch(batch({ accountScopeId: "lb-account:one", tradingDate: "2026-08-31", inputHash: hash("c") }));

  const values = await ledger.listBatches({
    accountScopeId: "lb-account:one",
    fromTradingDate: "2026-08-30",
    toTradingDate: "2026-08-31",
  });
  assert.deepEqual(values.map((item) => item.tradingDate), ["2026-08-31"]);
  assert.equal((await ledger.latest({ accountScopeId: "lb-account:two" })).tradingDate, "2026-08-30");
});

test("technical radar refuses malformed, duplicate or oversized data without trimming history", async () => {
  const store = memoryStore();
  const ledger = new TechnicalRadarStore({ store, maxBatches: 1 });
  await ledger.appendBatch(batch({ inputHash: hash("a") }));
  await assert.rejects(
    ledger.appendBatch(batch({ inputHash: hash("b") })),
    (error) => error.code === "technical_radar_store_limit_reached",
  );
  assert.equal((await ledger.listBatches()).length, 1);

  await assert.rejects(
    new TechnicalRadarStore({ store: memoryStore() }).appendBatch(batch({
      items: [{ symbol: "AAPL.US" }, { symbol: "AAPL.US" }],
    })),
    (error) => error.code === "item_symbol_invalid",
  );
});

test("technical radar integrity detects mutation", async () => {
  const store = memoryStore();
  const ledger = new TechnicalRadarStore({ store });
  await ledger.appendBatch(batch());
  const raw = structuredClone(await store.get(TECHNICAL_RADAR_STORE_KEY));
  raw.batches[0].items[0].state = "tampered";
  await store.set(TECHNICAL_RADAR_STORE_KEY, raw);
  const integrity = await ledger.verifyIntegrity();
  assert.equal(integrity.valid, false);
  assert.equal(integrity.reason, "record_hash_mismatch");
});

test("technical radar rejects non-finite evidence and impossible timestamps", async () => {
  const ledger = new TechnicalRadarStore({ store: memoryStore() });
  await assert.rejects(
    ledger.appendBatch(batch({ items: [{ symbol: "AAPL.US", score: Number.NaN }] })),
    (error) => error.code === "item_1_invalid",
  );
  await assert.rejects(
    ledger.appendBatch(batch({ summary: { missing: undefined } })),
    (error) => error.code === "summary_invalid",
  );
  await assert.rejects(
    ledger.appendBatch(batch({
      computedAt: "2026-08-31T12:00:00.000Z",
      recordedAt: "2026-08-31T11:59:59.000Z",
    })),
    (error) => error.code === "recorded_before_computed",
  );
});

function batch(overrides = {}) {
  return {
    accountScopeId: "lb-account:test",
    tradingDate: "2026-08-31",
    computedAt: "2026-08-31T21:05:00.000Z",
    recordedAt: "2026-08-31T21:06:00.000Z",
    inputHash: hash("input"),
    scannerVersion: "tier-a/v1",
    source: "tier_a_deterministic_scan",
    summary: { symbolCount: 1, completeCount: 1 },
    items: [{ symbol: "AAPL.US", state: "mixed", inputHash: hash("aapl") }],
    limitations: [],
    ...overrides,
  };
}

function hash(value) {
  return Buffer.from(String(value)).toString("hex").padEnd(64, "0").slice(0, 64);
}

function memoryStore() {
  const values = new Map();
  return {
    async get(key) { return structuredClone(values.get(key)); },
    async set(key, value) { values.set(key, structuredClone(value)); },
  };
}
