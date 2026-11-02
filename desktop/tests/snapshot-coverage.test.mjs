import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSnapshotCoverageCalendar,
  createSnapshotCoverageLedger,
  deserializeSnapshotCoverage,
  listSnapshotCoverageEntries,
  serializeSnapshotCoverage,
  snapshotCoverageEntry,
  summarizeSnapshotCoverage,
  transitionSnapshotCoverage,
} from "../src/data/snapshot-coverage.mjs";

const CREATED_AT = "2026-08-20T19:00:00.000Z";
const SCOPE = "lb-ledger-test";
const DATE = "2026-08-20";

function ledger() {
  return createSnapshotCoverageLedger({ createdAt: CREATED_AT });
}

function event(overrides = {}) {
  return {
    eventId: "event-1",
    accountScopeId: SCOPE,
    tradingDate: DATE,
    toStatus: "pending",
    at: CREATED_AT,
    ...overrides,
  };
}

test("tracks attempts, degradation and eventual confirmation without mutating earlier values", () => {
  const initial = ledger();
  const pending = transitionSnapshotCoverage(initial, event());
  const attempting = transitionSnapshotCoverage(pending, event({
    eventId: "event-2",
    toStatus: "attempting",
    at: "2026-08-20T20:10:00.000Z",
  }));
  const degraded = transitionSnapshotCoverage(attempting, event({
    eventId: "event-3",
    toStatus: "degraded",
    at: "2026-08-20T20:11:00.000Z",
    reason: "regular quote unavailable",
  }));
  const retrying = transitionSnapshotCoverage(degraded, event({
    eventId: "event-4",
    toStatus: "attempting",
    at: "2026-08-20T20:25:00.000Z",
  }));
  const confirmed = transitionSnapshotCoverage(retrying, event({
    eventId: "event-5",
    toStatus: "confirmed",
    at: "2026-08-20T20:26:00.000Z",
    snapshotId: "snapshot-123",
  }));

  assert.equal(initial.entries.length, 0);
  assert.equal(snapshotCoverageEntry(attempting, { accountScopeId: SCOPE, tradingDate: DATE }).attemptCount, 1);
  const result = snapshotCoverageEntry(confirmed, { accountScopeId: SCOPE, tradingDate: DATE });
  assert.equal(result.status, "confirmed");
  assert.equal(result.attemptCount, 2);
  assert.equal(result.lastAttemptAt, "2026-08-20T20:25:00.000Z");
  assert.equal(result.failureReason, "regular quote unavailable");
  assert.equal(result.lastFailureReason, "regular quote unavailable");
  assert.equal(result.confirmedSnapshotId, "snapshot-123");
  assert.equal(confirmed.revision, 5);
});

test("replaying one event is idempotent while conflicting reuse fails closed", () => {
  const firstEvent = event({
    eventId: "attempt-once",
    toStatus: "attempting",
    at: "2026-08-20T20:10:00.000Z",
  });
  const first = transitionSnapshotCoverage(ledger(), firstEvent);
  const replay = transitionSnapshotCoverage(first, firstEvent);
  assert.deepEqual(replay, first);
  assert.equal(snapshotCoverageEntry(replay, { accountScopeId: SCOPE, tradingDate: DATE }).attemptCount, 1);

  assert.throws(() => transitionSnapshotCoverage(first, {
    ...firstEvent,
    toStatus: "degraded",
    reason: "different payload",
  }), (error) => error.code === "SNAPSHOT_COVERAGE_EVENT_CONFLICT");
});

test("confirmed and gap states cannot silently regress or be replaced", () => {
  const confirmed = transitionSnapshotCoverage(ledger(), event({
    eventId: "confirm",
    toStatus: "confirmed",
    at: "2026-08-20T20:20:00.000Z",
    snapshotId: "snapshot-1",
  }));
  const sameConfirmation = transitionSnapshotCoverage(confirmed, event({
    eventId: "confirm-again",
    toStatus: "confirmed",
    at: "2026-08-20T20:21:00.000Z",
    snapshotId: "snapshot-1",
  }));
  assert.deepEqual(sameConfirmation, confirmed);
  assert.throws(() => transitionSnapshotCoverage(confirmed, event({
    eventId: "replace-confirmation",
    toStatus: "confirmed",
    at: "2026-08-20T20:21:00.000Z",
    snapshotId: "snapshot-2",
  })), (error) => error.code === "SNAPSHOT_COVERAGE_CONFIRMATION_CONFLICT");
  assert.throws(() => transitionSnapshotCoverage(confirmed, event({
    eventId: "regress-confirmation",
    toStatus: "attempting",
    at: "2026-08-20T20:21:00.000Z",
  })), (error) => error.code === "SNAPSHOT_COVERAGE_TRANSITION_REJECTED");

  const gap = transitionSnapshotCoverage(ledger(), event({
    eventId: "seal-gap",
    toStatus: "gap",
    at: "2026-08-21T14:00:00.000Z",
    reason: "collector was offline; no historical snapshot exists",
  }));
  assert.throws(() => transitionSnapshotCoverage(gap, event({
    eventId: "invent-history",
    toStatus: "confirmed",
    at: "2026-08-21T14:01:00.000Z",
    snapshotId: "invented-snapshot",
  })), (error) => error.code === "SNAPSHOT_COVERAGE_TRANSITION_REJECTED");
  assert.throws(() => transitionSnapshotCoverage(gap, event({
    eventId: "rewrite-gap",
    toStatus: "gap",
    at: "2026-08-21T14:01:00.000Z",
    reason: "a different explanation",
  })), (error) => error.code === "SNAPSHOT_COVERAGE_GAP_CONFLICT");
});

test("serializes and restores the state machine with its idempotency history", () => {
  const value = transitionSnapshotCoverage(ledger(), event({
    eventId: "attempt",
    toStatus: "attempting",
    at: "2026-08-20T20:10:00.000Z",
  }));
  const restored = deserializeSnapshotCoverage(serializeSnapshotCoverage(value));
  assert.deepEqual(restored, value);
  assert.deepEqual(transitionSnapshotCoverage(restored, event({
    eventId: "attempt",
    toStatus: "attempting",
    at: "2026-08-20T20:10:00.000Z",
  })), value);

  const invalid = JSON.parse(serializeSnapshotCoverage(value));
  invalid.revision = 99;
  assert.throws(
    () => deserializeSnapshotCoverage(JSON.stringify(invalid)),
    (error) => error.code === "SNAPSHOT_COVERAGE_REVISION_INVALID",
  );

  const mismatched = JSON.parse(serializeSnapshotCoverage(value));
  mismatched.entries[0].attemptCount = 99;
  assert.throws(
    () => deserializeSnapshotCoverage(JSON.stringify(mismatched)),
    (error) => error.code === "SNAPSHOT_COVERAGE_ENTRY_CHAIN_MISMATCH",
  );
});

test("builds an authoritative-date calendar and leaves absent history explicitly missing", () => {
  let value = transitionSnapshotCoverage(ledger(), event({
    eventId: "confirmed-day",
    toStatus: "confirmed",
    at: "2026-08-20T20:20:00.000Z",
    snapshotId: "snapshot-1",
  }));
  value = transitionSnapshotCoverage(value, event({
    eventId: "degraded-day",
    tradingDate: "2026-08-21",
    toStatus: "degraded",
    at: "2026-08-21T20:20:00.000Z",
    reason: "partial valuation only",
  }));

  const before = structuredClone(value);
  const calendar = buildSnapshotCoverageCalendar(value, {
    accountScopeId: SCOPE,
    tradingDates: ["2026-08-24", "2026-08-20", "2026-08-21"],
  });
  assert.deepEqual(calendar.map((item) => item.tradingDate), [
    "2026-08-20",
    "2026-08-21",
    "2026-08-24",
  ]);
  assert.deepEqual(calendar.map((item) => item.status), ["confirmed", "degraded", "missing"]);
  assert.equal(calendar[2].confirmedSnapshotId, null);
  assert.equal(calendar[2].captured, false);
  assert.deepEqual(value, before, "calendar reads must never materialize a historical snapshot");

  const summary = summarizeSnapshotCoverage(value, {
    accountScopeId: SCOPE,
    tradingDates: calendar.map((item) => item.tradingDate),
  });
  assert.equal(summary.expectedTradingDays, 3);
  assert.equal(summary.counts.confirmed, 1);
  assert.equal(summary.counts.degraded, 1);
  assert.equal(summary.counts.missing, 1);
  assert.equal(summary.capturedCount, 2);
  assert.equal(summary.confirmedRate, 1 / 3);
  assert.equal(summary.evidenceRate, 2 / 3);
  assert.equal(summary.hasGaps, true);
  assert.equal(summary.complete, false);
});

test("isolates coverage by account scope", () => {
  let value = transitionSnapshotCoverage(ledger(), event({
    eventId: "scope-a",
    toStatus: "confirmed",
    snapshotId: "snapshot-a",
  }));
  value = transitionSnapshotCoverage(value, event({
    eventId: "scope-b",
    accountScopeId: "lb-ledger-other",
    toStatus: "gap",
    reason: "offline",
  }));
  assert.equal(listSnapshotCoverageEntries(value, { accountScopeId: SCOPE }).length, 1);
  assert.deepEqual(buildSnapshotCoverageCalendar(value, {
    accountScope: { scopeId: "lb-ledger-other" },
    tradingDates: [DATE],
  }).map((item) => item.status), ["gap"]);
});

test("accepts the persisted account-scope shapes used by the portfolio ledger", () => {
  const value = transitionSnapshotCoverage(ledger(), event({
    eventId: "scope-alias",
    accountScopeId: undefined,
    accountScope: { scopeId: SCOPE },
    toStatus: "confirmed",
    snapshotId: "snapshot-alias",
  }));
  assert.equal(snapshotCoverageEntry(value, {
    scopeId: SCOPE,
    tradingDate: DATE,
  })?.confirmedSnapshotId, "snapshot-alias");
});

test("rejects out-of-order events and requires evidence for terminal facts", () => {
  const attempting = transitionSnapshotCoverage(ledger(), event({
    eventId: "attempt",
    toStatus: "attempting",
    at: "2026-08-20T20:10:00.000Z",
  }));
  assert.throws(() => transitionSnapshotCoverage(attempting, event({
    eventId: "old-event",
    toStatus: "degraded",
    at: "2026-08-20T20:09:00.000Z",
    reason: "late delivery",
  })), (error) => error.code === "SNAPSHOT_COVERAGE_TIME_REGRESSION");
  assert.throws(() => transitionSnapshotCoverage(ledger(), event({
    eventId: "no-snapshot",
    toStatus: "confirmed",
  })), (error) => error.code === "SNAPSHOT_COVERAGE_SNAPSHOT_REQUIRED");
  assert.throws(() => transitionSnapshotCoverage(ledger(), event({
    eventId: "no-gap-reason",
    toStatus: "gap",
  })), (error) => error.code === "SNAPSHOT_COVERAGE_REASON_REQUIRED");
});
