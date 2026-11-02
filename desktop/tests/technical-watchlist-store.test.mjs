import assert from "node:assert/strict";
import test from "node:test";

import { TechnicalWatchlistStore } from "../src/data/technical-watchlist-store.mjs";

test("technical watchlist normalizes US symbols and persists deterministic order", async () => {
  const watchlist = new TechnicalWatchlistStore({ store: memoryStore() });
  await watchlist.add("nvda", { addedAt: "2026-08-31T01:00:00Z" });
  await watchlist.add("700.HK", { addedAt: "2026-08-31T02:00:00Z" });
  await watchlist.add("NVDA.US", { addedAt: "2026-08-31T03:00:00Z" });
  const value = await watchlist.snapshot();
  assert.equal(value.revision, 2);
  assert.deepEqual(value.items.map((item) => item.symbol), ["700.HK", "NVDA.US"]);
});

test("technical watchlist removal is idempotent and replace preserves addedAt", async () => {
  const watchlist = new TechnicalWatchlistStore({ store: memoryStore() });
  await watchlist.add("AAPL", { addedAt: "2026-08-30T01:00:00Z" });
  await watchlist.add("MSFT", { addedAt: "2026-08-30T02:00:00Z" });
  const replaced = await watchlist.replace(["MSFT.US", "GOOG"], { updatedAt: "2026-08-31T01:00:00Z" });
  assert.equal(replaced.items.find((item) => item.symbol === "MSFT.US").addedAt, "2026-08-30T02:00:00.000Z");
  assert.equal(replaced.items.find((item) => item.symbol === "GOOG.US").addedAt, "2026-08-31T01:00:00.000Z");
  const once = await watchlist.remove("MSFT", { removedAt: "2026-08-31T02:00:00Z" });
  const twice = await watchlist.remove("MSFT", { removedAt: "2026-08-31T03:00:00Z" });
  assert.deepEqual(once, twice);
});

test("technical watchlist refuses invalid symbols and overflow instead of trimming", async () => {
  const watchlist = new TechnicalWatchlistStore({ store: memoryStore(), maxSymbols: 1 });
  await watchlist.add("AAPL");
  await assert.rejects(watchlist.add("MSFT"), (error) => error.code === "technical_watchlist_limit_reached");
  await assert.rejects(watchlist.add("../secret"), (error) => error.code === "technical_symbol_invalid");
  assert.deepEqual((await watchlist.snapshot()).items.map((item) => item.symbol), ["AAPL.US"]);
});

function memoryStore() {
  const values = new Map();
  return {
    async get(key) { return structuredClone(values.get(key)); },
    async set(key, value) { values.set(key, structuredClone(value)); },
  };
}
