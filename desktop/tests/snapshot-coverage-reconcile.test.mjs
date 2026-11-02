import assert from "node:assert/strict";
import test from "node:test";
import {
  createSnapshotCoverageLedger,
  deserializeSnapshotCoverage,
  transitionSnapshotCoverage,
} from "../src/data/snapshot-coverage.mjs";
import { deriveExpiredSnapshotGaps } from "../src/data/snapshot-background-reliability.mjs";
import { reconcileDurableSnapshotCoverage } from "../src/data/snapshot-coverage-reconcile.mjs";

const SCOPE = "scope-account-a";
const DATE = "2026-08-20";
const NOW = "2026-08-21T01:00:00.000Z";
const snapshot = (patch = {}) => ({
  snapshotId: "durable-eod-a",
  accountScope: { scopeId: SCOPE },
  tradingDate: DATE,
  recordedAt: "2026-08-20T20:01:05.000Z",
  capturedAt: "2026-08-20T20:01:00.000Z",
  ...patch,
});
const empty = () => createSnapshotCoverageLedger({ createdAt: "2026-08-20T18:00:00.000Z" });
const attempting = () => transitionSnapshotCoverage(empty(), {
  eventId: "attempt-a", accountScopeId: SCOPE, tradingDate: DATE,
  toStatus: "attempting", at: "2026-08-20T20:01:00.000Z",
});
const reconcile = (ledger, snapshots, now = NOW) => reconcileDurableSnapshotCoverage(ledger, snapshots, { scopeId: SCOPE, now });

test("durable EOD reconciliation prevents sealing an expired attempting entry as a gap", () => {
  const ledger = attempting();
  const options = {
    accountScopeId: SCOPE, tradingDates: [DATE], now: NOW,
    monitoringStartedAt: ledger.createdAt,
  };
  assert.equal(deriveExpiredSnapshotGaps(ledger, options).length, 1);
  const evidence = snapshot();
  const before = structuredClone({ ledger, evidence });
  const next = reconcile(ledger, [evidence]);
  assert.equal(next.entries[0].status, "confirmed");
  assert.equal(next.entries[0].confirmedSnapshotId, evidence.snapshotId);
  assert.equal(next.entries[0].confirmedAt, NOW);
  assert.deepEqual(deriveExpiredSnapshotGaps(next, options), []);
  assert.deepEqual({ ledger, evidence }, before, "neither ledger nor immutable evidence may be mutated");
});

test("stable reconciliation events and already-confirmed evidence are idempotent", () => {
  const evidence = snapshot();
  const next = reconcile(attempting(), [evidence, evidence]);
  assert.equal(next.revision, 2);
  assert.equal(next.events.at(-1).eventId, `reconcile:${SCOPE}:${DATE}:${evidence.snapshotId}`);
  const repeated = reconcile(next, [evidence], "2026-08-22T01:00:00.000Z");
  assert.equal(repeated, next);
  assert.deepEqual(deserializeSnapshotCoverage(repeated), next);
});

test("terminal gaps conflict explicitly instead of being silently reopened", () => {
  const ledger = transitionSnapshotCoverage(attempting(), {
    eventId: "gap-a", accountScopeId: SCOPE, tradingDate: DATE,
    toStatus: "gap", at: NOW, reason: "capture_window_expired",
  });
  const before = structuredClone(ledger);
  assert.throws(() => reconcile(ledger, [snapshot()]), {
    code: "SNAPSHOT_COVERAGE_DURABLE_CONFLICT", existingStatus: "gap", tradingDate: DATE,
  });
  assert.deepEqual(ledger, before);
});

test("a different durable snapshot cannot replace an already-confirmed ID", () => {
  const ledger = reconcile(empty(), [snapshot()]);
  assert.throws(() => reconcile(ledger, [snapshot({ snapshotId: "different-eod" })]), {
    code: "SNAPSHOT_COVERAGE_DURABLE_CONFLICT",
    existingStatus: "confirmed", existingSnapshotId: "durable-eod-a", snapshotId: "different-eod",
  });
  assert.equal(ledger.entries[0].confirmedSnapshotId, "durable-eod-a");
});

test("conflicting same-day input snapshots fail without partially changing the caller ledger", () => {
  const ledger = empty();
  assert.throws(() => reconcile(ledger, [snapshot(), snapshot({ snapshotId: "another-eod" })]), {
    code: "SNAPSHOT_COVERAGE_DURABLE_CONFLICT",
  });
  assert.equal(ledger.revision, 0);
  assert.deepEqual(ledger.entries, []);
});

test("only immutable accountScope.scopeId bindings may enter the requested scope", () => {
  const ledger = attempting();
  const wrongScope = snapshot({ accountScope: { scopeId: "scope-account-b" } });
  const legacyUnbound = snapshot({ accountScope: null, accountScopeId: SCOPE, scopeId: SCOPE });
  assert.equal(reconcile(ledger, [wrongScope, legacyUnbound]), ledger);
  const next = reconcile(ledger, [wrongScope, legacyUnbound, snapshot()]);
  assert.equal(next.revision, ledger.revision + 1);
  assert.ok(next.entries.every((entry) => entry.accountScopeId === SCOPE));
});

test("confirmation uses the latest reconciliation or ledger time, never old capture time", () => {
  const ledger = transitionSnapshotCoverage(attempting(), {
    eventId: "other-account-later", accountScopeId: "scope-account-b", tradingDate: DATE,
    toStatus: "attempting", at: "2026-08-22T10:00:00.000Z",
  });
  const next = reconcile(ledger, [snapshot()], "2026-08-19T00:00:00.000Z");
  assert.equal(next.events.at(-1).at, "2026-08-22T10:00:00.000Z");
  assert.equal(next.entries.find((entry) => entry.accountScopeId === SCOPE).confirmedAt, next.updatedAt);
  assert.deepEqual(deserializeSnapshotCoverage(next), next);
  const createdOnly = reconcile(empty(), [snapshot()], "2026-08-19T00:00:00.000Z");
  assert.equal(createdOnly.events[0].at, empty().createdAt);
});

test("no durable evidence leaves coverage unchanged and malformed inputs fail closed", () => {
  const ledger = attempting();
  assert.equal(reconcile(ledger, []), ledger);
  assert.throws(() => reconcile(ledger, null), { code: "SNAPSHOT_COVERAGE_RECONCILE_INVALID" });
  assert.throws(() => reconcile(ledger, [], "not-a-date"), { code: "SNAPSHOT_COVERAGE_RECONCILE_INVALID" });
  assert.throws(() => reconcileDurableSnapshotCoverage(ledger, [], { scopeId: "", now: NOW }), {
    code: "SNAPSHOT_COVERAGE_RECONCILE_INVALID",
  });
  assert.throws(() => reconcile(ledger, [snapshot({ snapshotId: null })]), {
    code: "SNAPSHOT_COVERAGE_RECONCILE_INVALID",
  });
});
