import assert from "node:assert/strict";
import test from "node:test";
import {
  createSnapshotCoverageLedger,
  transitionSnapshotCoverage,
} from "../src/data/snapshot-coverage.mjs";
import {
  activateSnapshotBackgroundScope,
  createSnapshotBackgroundPreferences,
  createSnapshotReconnectState,
  decideSnapshotReconnect,
  deriveExpiredSnapshotGaps,
  isWithinUsSnapshotCaptureWindow,
  listExpiredSnapshotCaptureAlerts,
  normalizeSnapshotBackgroundPreferences,
  recordSnapshotReconnectOutcome,
  snapshotBackgroundRuntimeIntent,
  snapshotMonitoringStartedAtForScope,
  usSnapshotCaptureDeadline,
  usSnapshotCaptureWindow,
} from "../src/data/snapshot-background-reliability.mjs";

const SCOPE = "lb-ledger-test";

function ledger(createdAt = "2026-08-20T19:00:00.000Z") {
  return createSnapshotCoverageLedger({ createdAt });
}

test("background collection is opt-in and login launch cannot survive a disabled collector", () => {
  const defaults = createSnapshotBackgroundPreferences({ updatedAt: "2026-08-20T19:00:00.000Z" });
  assert.deepEqual(snapshotBackgroundRuntimeIntent(defaults), {
    keepRunningWhenLastWindowClosed: false,
    openAtLogin: false,
    openAsHidden: false,
    notifyOnMissedCapture: false,
  });
  assert.equal(defaults.monitoringStartedAt, null);
  assert.deepEqual(defaults.scopeActivatedAt, {});

  const enabled = createSnapshotBackgroundPreferences({
    enabled: true,
    launchAtLogin: true,
    updatedAt: "2026-08-20T19:00:00.000Z",
  });
  assert.deepEqual(snapshotBackgroundRuntimeIntent(enabled), {
    keepRunningWhenLastWindowClosed: true,
    openAtLogin: true,
    openAsHidden: true,
    notifyOnMissedCapture: true,
  });
  assert.equal(enabled.monitoringStartedAt, "2026-08-20T19:00:00.000Z");
  assert.deepEqual(enabled.scopeActivatedAt, {});

  assert.throws(
    () => normalizeSnapshotBackgroundPreferences({ schemaVersion: 999 }),
    (error) => error.code === "SNAPSHOT_BACKGROUND_PREFERENCES_SCHEMA_UNSUPPORTED",
  );
});

test("binds continuity monitoring to each account scope without inheriting old-account gaps", () => {
  const enabled = createSnapshotBackgroundPreferences({
    enabled: true,
    monitoringStartedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
  const existing = activateSnapshotBackgroundScope(enabled, {
    accountScopeId: "account-a",
    activatedAt: "2026-09-01T00:00:00.000Z",
    inheritGlobalEpoch: true,
  });
  const switched = activateSnapshotBackgroundScope(existing, {
    accountScopeId: "account-b",
    activatedAt: "2026-09-01T12:34:56.000Z",
  });

  assert.equal(
    snapshotMonitoringStartedAtForScope(switched, "account-a"),
    "2026-07-01T00:00:00.000Z",
  );
  assert.equal(
    snapshotMonitoringStartedAtForScope(switched, "account-b"),
    "2026-09-01T12:34:56.000Z",
  );
  assert.equal(
    activateSnapshotBackgroundScope(switched, {
      accountScopeId: "account-b",
      activatedAt: "2026-09-02T12:34:56.000Z",
    }).scopeActivatedAt["account-b"],
    "2026-09-01T12:34:56.000Z",
  );

  const value = ledger("2026-07-01T00:00:00.000Z");
  const accountBGaps = deriveExpiredSnapshotGaps(value, {
    accountScopeId: "account-b",
    tradingDates: ["2026-08-31", "2026-09-01"],
    now: "2026-09-02T01:00:00.000Z",
    monitoringStartedAt: snapshotMonitoringStartedAtForScope(switched, "account-b"),
  });
  assert.deepEqual(accountBGaps.map((item) => item.tradingDate), ["2026-09-01"]);
});

test("uses regular and early US closes to calculate a deterministic capture deadline", () => {
  assert.equal(
    usSnapshotCaptureDeadline({ tradingDate: "2026-08-20" }),
    "2026-08-21T00:00:00.000Z",
  );
  assert.equal(
    usSnapshotCaptureDeadline({ tradingDate: "2026-11-27" }),
    "2026-11-27T22:00:00.000Z",
  );
  assert.equal(
    usSnapshotCaptureDeadline({ tradingDate: "2026-03-10", retryWindowMinutes: 0 }),
    "2026-03-10T20:00:00.000Z",
  );
});

test("accepts only the official regular-close +10 through +240 minute window", () => {
  assert.deepEqual(usSnapshotCaptureWindow({ tradingDate: "2026-08-20" }), {
    tradingDate: "2026-08-20",
    sessionCloseAt: "2026-08-20T20:00:00.000Z",
    opensAt: "2026-08-20T20:10:00.000Z",
    deadlineAt: "2026-08-21T00:00:00.000Z",
    captureDelayMinutes: 10,
    retryWindowMinutes: 240,
    timeZone: "America/New_York",
  });
  assert.equal(isWithinUsSnapshotCaptureWindow("2026-08-20T20:09:00.000Z"), false); // 16:09 ET
  assert.equal(isWithinUsSnapshotCaptureWindow("2026-08-20T20:10:00.000Z"), true); // 16:10 ET
  assert.equal(isWithinUsSnapshotCaptureWindow("2026-08-20T23:59:00.000Z"), true); // 19:59 ET
  assert.equal(isWithinUsSnapshotCaptureWindow("2026-08-21T00:00:00.000Z"), true); // 20:00 ET
  assert.equal(isWithinUsSnapshotCaptureWindow("2026-08-21T00:01:00.000Z"), false); // 20:01 ET
});

test("uses the official early-close +10 through +240 minute window", () => {
  assert.deepEqual(usSnapshotCaptureWindow({ tradingDate: "2026-11-27" }), {
    tradingDate: "2026-11-27",
    sessionCloseAt: "2026-11-27T18:00:00.000Z",
    opensAt: "2026-11-27T18:10:00.000Z",
    deadlineAt: "2026-11-27T22:00:00.000Z",
    captureDelayMinutes: 10,
    retryWindowMinutes: 240,
    timeZone: "America/New_York",
  });
  assert.equal(isWithinUsSnapshotCaptureWindow("2026-11-27T18:09:00.000Z"), false); // 13:09 ET
  assert.equal(isWithinUsSnapshotCaptureWindow("2026-11-27T18:10:00.000Z"), true); // 13:10 ET
  assert.equal(isWithinUsSnapshotCaptureWindow("2026-11-27T21:59:00.000Z"), true); // 16:59 ET
  assert.equal(isWithinUsSnapshotCaptureWindow("2026-11-27T22:00:00.000Z"), true); // 17:00 ET
  assert.equal(isWithinUsSnapshotCaptureWindow("2026-11-27T22:01:00.000Z"), false); // 17:01 ET
});

test("does not seal the exact deadline before its final capture attempt", () => {
  const value = ledger("2026-08-20T19:00:00.000Z");
  assert.deepEqual(deriveExpiredSnapshotGaps(value, {
    accountScopeId: SCOPE,
    tradingDates: ["2026-08-20"],
    now: "2026-08-21T00:00:00.000Z",
  }), []);
  assert.equal(deriveExpiredSnapshotGaps(value, {
    accountScopeId: SCOPE,
    tradingDates: ["2026-08-20"],
    now: "2026-08-21T00:00:00.001Z",
  })[0]?.toStatus, "gap");
});

test("allows non-interactive reconnect only in-window with saved authorization", () => {
  const state = createSnapshotReconnectState();
  assert.equal(decideSnapshotReconnect({
    state,
    now: "2026-08-20T20:09:00.000Z",
    hasSavedAuthorization: true,
  }).reason, "outside_capture_window");
  assert.equal(decideSnapshotReconnect({
    state,
    now: "2026-08-20T20:10:00.000Z",
    hasSavedAuthorization: false,
  }).reason, "saved_authorization_missing");
  assert.equal(decideSnapshotReconnect({
    state,
    now: "2026-08-20T20:10:00.000Z",
    hasSavedAuthorization: true,
  }).shouldAttempt, true);
  assert.equal(decideSnapshotReconnect({
    state,
    now: "2026-08-21T00:00:00.001Z",
    hasSavedAuthorization: true,
  }).reason, "outside_capture_window");
});

test("retryable reconnect failures use capped exponential backoff without storms", () => {
  let state = createSnapshotReconnectState({ tradingDate: "2026-08-20" });
  state = recordSnapshotReconnectOutcome(state, {
    now: "2026-08-20T20:10:00.000Z",
    tradingDate: "2026-08-20",
    outcome: "failure",
    classification: { kind: "transport", retryable: true },
  });
  assert.equal(state.attemptCount, 1);
  assert.equal(state.nextAttemptAt, "2026-08-20T20:11:00.000Z");
  assert.equal(decideSnapshotReconnect({
    state,
    now: "2026-08-20T20:10:59.999Z",
    hasSavedAuthorization: true,
  }).reason, "backoff_active");
  assert.equal(decideSnapshotReconnect({
    state,
    now: "2026-08-20T20:11:00.000Z",
    hasSavedAuthorization: true,
  }).shouldAttempt, true);

  state = recordSnapshotReconnectOutcome(state, {
    now: "2026-08-20T20:11:00.000Z",
    tradingDate: "2026-08-20",
    outcome: "failure",
    classification: { kind: "gateway", retryable: true },
  });
  assert.equal(state.nextAttemptAt, "2026-08-20T20:13:00.000Z");

  for (let attempt = 0; attempt < 10; attempt += 1) {
    state = recordSnapshotReconnectOutcome(state, {
      now: state.nextAttemptAt,
      tradingDate: "2026-08-20",
      outcome: "failure",
      classification: { kind: "transport", retryable: true },
    });
  }
  assert.ok(Date.parse(state.nextAttemptAt) <= Date.parse("2026-08-21T00:00:00.000Z"));
});

test("auth failures block the current window but reset on the next trading date", () => {
  const blocked = recordSnapshotReconnectOutcome(createSnapshotReconnectState(), {
    now: "2026-08-20T20:10:00.000Z",
    tradingDate: "2026-08-20",
    outcome: "failure",
    classification: { kind: "auth", retryable: false, reauth: true },
  });
  assert.equal(blocked.blockedForWindow, true);
  assert.equal(decideSnapshotReconnect({
    state: blocked,
    now: "2026-08-20T20:30:00.000Z",
    hasSavedAuthorization: true,
  }).reason, "blocked_for_capture_window");
  const nextDay = decideSnapshotReconnect({
    state: blocked,
    now: "2026-08-21T20:10:00.000Z",
    hasSavedAuthorization: true,
  });
  assert.equal(nextDay.shouldAttempt, true);
  assert.equal(nextDay.state.attemptCount, 0);
  assert.equal(nextDay.state.blockedForWindow, false);
});

test("successful reconnect clears backoff and remains a single completed attempt", () => {
  const result = recordSnapshotReconnectOutcome(createSnapshotReconnectState({
    tradingDate: "2026-08-20",
    attemptCount: 2,
    nextAttemptAt: "2026-08-20T20:30:00.000Z",
    lastFailureKind: "transport",
  }), {
    now: "2026-08-20T20:30:00.000Z",
    tradingDate: "2026-08-20",
    outcome: "success",
  });
  assert.equal(result.attemptCount, 3);
  assert.equal(result.nextAttemptAt, null);
  assert.equal(result.blockedForWindow, false);
  assert.equal(result.lastFailureKind, null);
  assert.equal(result.lastSuccessAt, "2026-08-20T20:30:00.000Z");
});

test("marks only monitored, expired, unconfirmed authoritative days as gaps", () => {
  let value = ledger("2026-08-20T19:00:00.000Z");
  value = transitionSnapshotCoverage(value, {
    eventId: "confirmed",
    accountScopeId: SCOPE,
    tradingDate: "2026-08-20",
    toStatus: "confirmed",
    at: "2026-08-21T00:00:00.000Z",
    snapshotId: "snapshot-20",
  });
  value = transitionSnapshotCoverage(value, {
    eventId: "attempted",
    accountScopeId: SCOPE,
    tradingDate: "2026-08-21",
    toStatus: "attempting",
    at: "2026-08-22T00:00:00.000Z",
  });

  const gaps = deriveExpiredSnapshotGaps(value, {
    accountScopeId: SCOPE,
    tradingDates: ["2026-08-19", "2026-08-20", "2026-08-21", "2026-08-24"],
    now: "2026-08-25T01:00:00.000Z",
  });
  assert.deepEqual(gaps.map((item) => [item.tradingDate, item.priorStatus, item.reason]), [[
    "2026-08-21",
    "attempting",
    "capture_window_expired_after_attempts",
  ], [
    "2026-08-24",
    "missing",
    "capture_window_expired_without_attempt",
  ]]);
  assert.equal(gaps[0].eventId, `gap-window-expired:v1:${SCOPE}:2026-08-21`);
  assert.equal(gaps[0].toStatus, "gap");
  assert.equal(gaps[0].at, "2026-08-25T01:00:00.000Z");
});

test("does not call an active capture window a permanent gap and keeps acknowledgement outside evidence", () => {
  const value = ledger("2026-08-20T19:00:00.000Z");
  const open = deriveExpiredSnapshotGaps(value, {
    accountScopeId: SCOPE,
    tradingDates: ["2026-08-20"],
    now: "2026-08-20T22:00:00.000Z",
  });
  assert.deepEqual(open, []);

  const alerts = listExpiredSnapshotCaptureAlerts(value, {
    accountScopeId: SCOPE,
    tradingDates: ["2026-08-20"],
    now: "2026-08-21T01:00:00.000Z",
    acknowledgedGapKeys: [`snapshot-gap:${SCOPE}:2026-08-20`],
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].acknowledged, true);
  assert.equal(alerts[0].severity, "error");
});

test("a proposed gap becomes a terminal factual gap only when the host applies it", () => {
  const value = ledger("2026-08-20T19:00:00.000Z");
  const [transition] = deriveExpiredSnapshotGaps(value, {
    accountScopeId: SCOPE,
    tradingDates: ["2026-08-20"],
    now: "2026-08-21T01:00:00.000Z",
  });
  const persisted = transitionSnapshotCoverage(value, transition);
  assert.equal(persisted.entries[0].status, "gap");
  assert.equal(persisted.entries[0].lastFailureReason, "capture_window_expired_without_attempt");
});
