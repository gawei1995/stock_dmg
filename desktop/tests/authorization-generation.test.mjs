import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthorizationGenerationGate,
  StaleAuthorizationGenerationError,
} from "../src/data/authorization-generation.mjs";

test("authorization generation rejects a late operation after credentials rotate", async () => {
  const gate = new AuthorizationGenerationGate();
  const oldGeneration = gate.capture();
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const operation = gate.track(oldGeneration, async () => {
    await delayed;
    return "old-account";
  });

  assert.equal(gate.advance(), 1);
  release();
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof StaleAuthorizationGenerationError);
    assert.equal(error.code, "STALE_LONGBRIDGE_AUTHORIZATION_GENERATION");
    assert.equal(error.requestGeneration, 0);
    assert.equal(error.currentGeneration, 1);
    return true;
  });
  await gate.settleSuperseded();
});

test("settleSuperseded waits for old work but not current-generation work", async () => {
  const gate = new AuthorizationGenerationGate();
  let releaseOld;
  let releaseCurrent;
  const old = gate.track(0, () => new Promise((resolve) => { releaseOld = resolve; }));
  await Promise.resolve();
  gate.advance();
  const current = gate.track(1, () => new Promise((resolve) => { releaseCurrent = resolve; }));
  let settled = false;
  const draining = gate.settleSuperseded().then(() => { settled = true; });

  await Promise.resolve();
  assert.equal(settled, false);
  releaseOld("old");
  await assert.rejects(old, /旧请求结果已丢弃/);
  await draining;
  assert.equal(settled, true);

  releaseCurrent("current");
  assert.equal(await current, "current");
});

test("same-generation operations remain valid", async () => {
  const gate = new AuthorizationGenerationGate({ initialGeneration: 7 });
  const results = await Promise.all([
    gate.track(7, async () => "first"),
    gate.track(7, async () => "second"),
  ]);
  assert.deepEqual(results, ["first", "second"]);
  assert.equal(gate.capture(), 7);
});

test("superseded-operation drain has a hard deadline", async () => {
  const gate = new AuthorizationGenerationGate();
  let release;
  const old = gate.track(0, () => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  gate.advance();
  const startedAt = Date.now();
  const result = await gate.settleSuperseded({ timeoutMs: 10 });
  assert.deepEqual(result, { settled: false, pendingCount: 1 });
  assert.ok(Date.now() - startedAt < 500);
  release();
  await assert.rejects(old, /旧请求结果已丢弃/);
});
