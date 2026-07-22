import assert from "node:assert/strict";
import test from "node:test";
import { AgentResultStore } from "../src/data/agent-result-store.mjs";

function memoryStore() {
  const values = new Map();
  return {
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => values.set(key, structuredClone(value)),
  };
}

function delayedMemoryStore(delayMs = 10) {
  const values = new Map();
  let activeReads = 0;
  let maxConcurrentReads = 0;
  return {
    get: async (key) => {
      activeReads += 1;
      maxConcurrentReads = Math.max(maxConcurrentReads, activeReads);
      const snapshot = structuredClone(values.get(key));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      activeReads -= 1;
      return snapshot;
    },
    set: async (key, value) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      values.set(key, structuredClone(value));
    },
    maxConcurrentReads: () => maxConcurrentReads,
  };
}

function hangingPersistenceStore() {
  const never = new Promise(() => {});
  let reads = 0;
  let writes = 0;
  return {
    get: async () => {
      reads += 1;
      return undefined;
    },
    set: async () => {
      writes += 1;
      return never;
    },
    reads: () => reads,
    writes: () => writes,
  };
}

function result(threadId, operationId = "operation_123") {
  return {
    threadId,
    operationId,
    completedAt: new Date().toISOString(),
    run: { id: `run-${threadId}` },
  };
}

test("completed Agent results are isolated by Codex thread", async () => {
  const results = new AgentResultStore({ store: memoryStore() });
  await results.save(result("thread_a"));
  await results.save(result("thread_b", "operation_456"));
  await results.save(result("thread_a", "operation_newest"));

  assert.equal((await results.latest("thread_a")).run.id, "run-thread_a");
  assert.equal((await results.latest("thread_a")).operationId, "operation_newest");
  assert.equal((await results.latest("thread_b")).run.id, "run-thread_b");
  assert.equal(await results.latest("thread_c"), null);
});

test("expired Agent results are not restored", async () => {
  const results = new AgentResultStore({ store: memoryStore(), retentionMs: 1_000 });
  const expired = result("thread_old");
  expired.completedAt = new Date(Date.now() - 5_000).toISOString();
  await assert.rejects(results.save(expired), /invalid or expired/);
  assert.equal(await results.latest("thread_old"), null);
});

test("concurrent Agent result saves are serialized without losing another thread", async () => {
  const store = delayedMemoryStore();
  const results = new AgentResultStore({ store });

  await Promise.all([
    results.save(result("thread_a")),
    results.save(result("thread_b", "operation_456")),
  ]);

  assert.equal(store.maxConcurrentReads(), 1);
  assert.equal((await results.latest("thread_a")).run.id, "run-thread_a");
  assert.equal((await results.latest("thread_b")).run.id, "run-thread_b");
});

test("save exposes the completed result from memory before persistence settles", async () => {
  const store = hangingPersistenceStore();
  const results = new AgentResultStore({ store });
  const completed = result("thread_fast_handoff", "operation_fast_handoff");

  // Deliberately do not await this promise: encrypted persistence is allowed to
  // remain blocked, while renderer completion recovery must stay synchronous.
  void results.save(completed);

  assert.equal(results.peek("thread_fast_handoff")?.operationId, "operation_fast_handoff");
  const latest = await Promise.race([
    results.latest("thread_fast_handoff"),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("latest waited for hanging persistence")),
      50,
    )),
  ]);
  assert.equal(latest.operationId, "operation_fast_handoff");
  assert.equal(latest.run.id, "run-thread_fast_handoff");

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.reads(), 1);
  assert.equal(store.writes(), 1);
});
