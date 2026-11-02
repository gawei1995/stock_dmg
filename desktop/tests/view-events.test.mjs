import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createScopedSnapshotPublisher, statusDomain, storageHealthSnapshot } from "../src/runtime/view-events.mjs";
import { fxEvidenceMetadata } from "../src/engine/fx-evidence.mjs";

test("view event domains keep radar and snapshots away from broker auth", () => {
  assert.equal(statusDomain({ state: "connected" }), "longbridge");
  assert.equal(statusDomain({ state: "reauth_required" }), "longbridge");
  assert.equal(statusDomain({ state: "technical_radar_ready" }), "technical_radar");
  assert.equal(statusDomain({ state: "snapshot_gap" }), "snapshot");
  assert.equal(statusDomain({ state: "agent_error" }), "agent");
  assert.equal(statusDomain({ state: "new_unknown_event" }), "application");
  assert.equal(statusDomain({ domain: "ibkr", state: "connected" }), "ibkr");
  assert.equal(statusDomain({ phase: "trade_history", state: "ready" }), "history");
});

test("storage status covers every supplied store, not just the credential store", () => {
  const result = storageHealthSnapshot([
    { health: () => ({ file: "secure", state: "healthy", encrypted: true }) },
    { health: () => ({ file: "review", state: "degraded", encrypted: true, errorCode: "STORAGE_WRITE_FAILED" }) },
  ]);
  assert.equal(result.encrypted, true);
  assert.equal(result.state, "degraded");
  assert.equal(result.stores[1].errorCode, "STORAGE_WRITE_FAILED");
});

test("snapshot publisher coalesces refreshes and never pushes a replaced account", async () => {
  let identity = { accountScopeId: "a", generation: 1 };
  let release;
  const packets = [];
  const publisher = createScopedSnapshotPublisher({
    getIdentity: () => identity,
    readSnapshot: () => new Promise(resolve => { release = resolve; }),
    send: value => packets.push(value),
    delayMs: 1,
  });
  publisher.schedule(); publisher.schedule();
  await delay(10);
  identity = { accountScopeId: "b", generation: 2 };
  release({ account: "a" });
  await delay(10);
  assert.equal(packets.length, 0);
  publisher.schedule();
  await delay(10);
  release({ account: "b", captureRuntime: { outcome: "confirmed" } });
  await delay(10);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].accountScopeId, "b");
  assert.equal(packets[0].portfolioSnapshots.captureRuntime.outcome, "confirmed");
  assert.ok(publisher.nextSequence() > packets[0].snapshotUpdateSequence);
  publisher.dispose();
});

test("failed snapshot reads do not publish an invented empty ledger", async () => {
  const packets = [];
  const publisher = createScopedSnapshotPublisher({
    getIdentity: () => ({ accountScopeId: "a", generation: 1 }),
    readSnapshot: async () => { throw new Error("storage unavailable"); },
    send: value => packets.push(value), delayMs: 1,
  });
  publisher.schedule(); await delay(10); publisher.dispose();
  assert.deepEqual(packets, []);
});

test("combined FX evidence retains cached status and missing observation date", () => {
  const metadata = fxEvidenceMetadata({
    dataQuality: { fxStatus: "reference_cached" }, syncedAt: "2026-09-18T00:00:00Z",
    fx: { providerCode: "多券商", sources: [
      { broker: "longbridge", status: "reference_cached", asOf: "2026-09-15" },
      { broker: "ibkr", status: "live", asOf: null },
    ] },
  });
  assert.equal(metadata.source, "多券商汇率来源汇总");
  assert.equal(metadata.evidenceStatus, "degraded");
  assert.equal(metadata.asOf, null);
  assert.match(metadata.summary, /reference_cached/);
  assert.match(metadata.summary, /来源日期未提供/);
  assert.doesNotMatch(metadata.source, /长桥账户汇率/);
});

test("IBKR live captions and reference sources remain distinguishable", () => {
  assert.equal(fxEvidenceMetadata({ brokerScope: "ibkr", dataQuality: { fxStatus: "live" } }).source, "IBKR账户汇率");
  assert.equal(fxEvidenceMetadata({ dataQuality: { fxStatus: "not_required" } }).tool, "fx_not_required");
  assert.equal(fxEvidenceMetadata({ dataQuality: { fxStatus: "unavailable" } }).evidenceStatus, "failed");
});
