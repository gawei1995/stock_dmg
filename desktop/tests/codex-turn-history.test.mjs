import assert from "node:assert/strict";
import test from "node:test";
import { readCodexTurnItems } from "../src/engine/codex-turn-history.mjs";

const entry = (id) => ({ turnId: "turn-a", item: { id, type: "agentMessage", phase: "final_answer", text: id } });

test("turn history preserves all pages in order and deduplicates boundary items", async () => {
  const calls = [];
  const result = await readCodexTurnItems({ request: async (method, params) => {
    calls.push(method);
    return params.cursor ? { data: [entry("one"), entry("two")], nextCursor: null }
      : { data: [entry("one")], nextCursor: "page-two" };
  } }, "thread-a", "turn-a");
  assert.deepEqual(result.items.map((item) => item.id), ["one", "two"]);
  assert.equal(result.complete, true);
  assert.equal(calls.length, 2);
});

test("one deadline bounds all pages even when a request never settles", async () => {
  const startedAt = Date.now();
  const budgets = [];
  const result = await readCodexTurnItems({ request: async (method, params, options) => {
    budgets.push(options.timeoutMs);
    if (params.cursor) return new Promise(() => {});
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { data: [entry("one")], nextCursor: "page-two" };
  } }, "thread-a", "turn-a", { budgetMs: 50 });
  assert.equal(result.complete, false);
  assert.equal(result.hasUnverifiedPrefix, true);
  assert.equal(result.reason, "history_budget_exhausted");
  assert.deepEqual(result.items.map((item) => item.id), ["one"]);
  assert.ok(budgets[1] < budgets[0]);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("a valid full-turn fallback recovers an interrupted pagination without losing segments", async () => {
  const result = await readCodexTurnItems({ request: async (method, params) => {
    if (method === "thread/turns/list") return { data: [{ id: "turn-a", status: "completed", items: [entry("one").item, entry("two").item] }] };
    if (params.cursor) throw new Error("paging unavailable");
    return { data: [entry("one")], nextCursor: "page-two" };
  } }, "thread-a", "turn-a");
  assert.equal(result.complete, true);
  assert.equal(result.hasUnverifiedPrefix, false);
  assert.deepEqual(result.items.map((item) => item.id), ["one", "two"]);
});

test("cursor loops with no full-turn fallback are explicitly incomplete", async () => {
  const result = await readCodexTurnItems({ request: async (method) => {
    if (method === "thread/turns/list") return { data: [] };
    return { data: [entry("one")], nextCursor: "loop" };
  } }, "thread-a", "turn-a");
  assert.equal(result.complete, false);
  assert.equal(result.hasUnverifiedPrefix, true);
  assert.equal(result.reason, "history_pagination_invalid");
});
