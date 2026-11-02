import {
  listSnapshotCoverageEntries,
} from "./snapshot-coverage.mjs";
import { isUsTradingDay } from "../engine/market-evidence.mjs";

const SCHEMA_VERSION = 1;
const DEFAULT_CAPTURE_DELAY_MINUTES = 10;
const DEFAULT_RETRY_WINDOW_MINUTES = 4 * 60;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 60 * 1000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 15 * 60 * 1000;
const US_TIME_ZONE = "America/New_York";

/**
 * User-owned configuration for the optional background collector.
 *
 * The default is deliberately inert: closing the last window must not keep a
 * brokerage-connected process alive unless the user explicitly enables it.
 * Keep this contract pure so the Electron host can map it to
 * app.setLoginItemSettings without persisting OS-specific state in the ledger.
 */
export function createSnapshotBackgroundPreferences(input = {}) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const enabled = value.enabled === true;
  const updatedAt = requiredIso(value.updatedAt ?? new Date());
  return {
    schemaVersion: SCHEMA_VERSION,
    enabled,
    launchAtLogin: enabled && value.launchAtLogin === true,
    notifyOnMissedCapture: enabled && value.notifyOnMissedCapture !== false,
    monitoringStartedAt: enabled
      ? requiredIso(value.monitoringStartedAt ?? updatedAt)
      : null,
    scopeActivatedAt: enabled
      ? normalizeScopeActivationMap(value.scopeActivatedAt)
      : {},
    updatedAt,
  };
}

/**
 * Bind background continuity monitoring to one opaque/local ledger scope.
 * A newly observed broker account starts at `activatedAt`; it must never
 * inherit another account's older monitoring epoch and manufacture gaps.
 *
 * `inheritGlobalEpoch` is only for migrating the already-active scope from
 * preferences written before per-scope epochs existed.
 */
export function activateSnapshotBackgroundScope(preferences, {
  accountScopeId,
  activatedAt = new Date(),
  inheritGlobalEpoch = false,
} = {}) {
  const normalized = normalizeSnapshotBackgroundPreferences(preferences);
  if (!normalized.enabled) return normalized;
  const scope = requiredId(accountScopeId, "账户范围无效。");
  if (normalized.scopeActivatedAt[scope]) return normalized;
  const activation = inheritGlobalEpoch && normalized.monitoringStartedAt
    ? normalized.monitoringStartedAt
    : requiredIso(activatedAt);
  return createSnapshotBackgroundPreferences({
    ...normalized,
    scopeActivatedAt: {
      ...normalized.scopeActivatedAt,
      [scope]: activation,
    },
    updatedAt: requiredIso(activatedAt),
  });
}

export function snapshotMonitoringStartedAtForScope(preferences, accountScopeId) {
  const normalized = normalizeSnapshotBackgroundPreferences(preferences);
  if (!normalized.enabled || !normalized.monitoringStartedAt) return null;
  const scope = requiredId(accountScopeId, "账户范围无效。");
  return normalized.scopeActivatedAt[scope] ?? null;
}

export function normalizeSnapshotBackgroundPreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw reliabilityError("SNAPSHOT_BACKGROUND_PREFERENCES_INVALID", "后台快照偏好无效。");
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw reliabilityError("SNAPSHOT_BACKGROUND_PREFERENCES_SCHEMA_UNSUPPORTED", "后台快照偏好版本不受支持。");
  }
  return createSnapshotBackgroundPreferences(value);
}

/**
 * Resolves the exact Electron-side intent. `openAtLogin` is never inferred
 * from a stale OS setting; it is true only when the user chose both switches.
 */
export function snapshotBackgroundRuntimeIntent(preferences) {
  const normalized = normalizeSnapshotBackgroundPreferences(preferences);
  return {
    keepRunningWhenLastWindowClosed: normalized.enabled,
    openAtLogin: normalized.enabled && normalized.launchAtLogin,
    openAsHidden: normalized.enabled && normalized.launchAtLogin,
    notifyOnMissedCapture: normalized.enabled && normalized.notifyOnMissedCapture,
  };
}

/**
 * Calculate a capture deadline from the official session close. The deadline
 * is not a reconstructed valuation: after it passes, a missing observation is
 * only eligible to be recorded as a permanent gap.
 */
export function usSnapshotCaptureDeadline({
  tradingDate,
  retryWindowMinutes = DEFAULT_RETRY_WINDOW_MINUTES,
} = {}) {
  const date = requiredTradingDate(tradingDate);
  if (!isUsTradingDay(date)) {
    throw reliabilityError("SNAPSHOT_CAPTURE_DATE_NOT_TRADING_DAY", "捕获截止日必须是美股交易日。");
  }
  const retry = nonNegativeInteger(retryWindowMinutes, "捕获重试窗口分钟数无效。");
  const closeMinute = usCloseMinute(date);
  return zonedLocalMinuteToIso(date, closeMinute + retry, US_TIME_ZONE);
}

/**
 * Returns the only interval in which a regular-close portfolio observation
 * may be captured for a US trading date. Both bounds are inclusive instants:
 * regular sessions use 16:10:00-20:00:00 ET, while official early-close
 * sessions use 13:10:00-17:00:00 ET. Account state observed after the closing
 * instant must never be relabelled as that trading day's close.
 */
export function usSnapshotCaptureWindow({
  tradingDate,
  captureDelayMinutes = DEFAULT_CAPTURE_DELAY_MINUTES,
  retryWindowMinutes = DEFAULT_RETRY_WINDOW_MINUTES,
} = {}) {
  const date = requiredTradingDate(tradingDate);
  if (!isUsTradingDay(date)) {
    throw reliabilityError("SNAPSHOT_CAPTURE_DATE_NOT_TRADING_DAY", "捕获窗口日期必须是美股交易日。");
  }
  const delay = nonNegativeInteger(captureDelayMinutes, "捕获延迟分钟数无效。");
  const retry = nonNegativeInteger(retryWindowMinutes, "捕获重试窗口分钟数无效。");
  if (delay > retry) {
    throw reliabilityError("SNAPSHOT_CAPTURE_WINDOW_INVALID", "捕获开始时间不能晚于捕获截止时间。");
  }
  const closeMinute = usCloseMinute(date);
  return {
    tradingDate: date,
    sessionCloseAt: zonedLocalMinuteToIso(date, closeMinute, US_TIME_ZONE),
    opensAt: zonedLocalMinuteToIso(date, closeMinute + delay, US_TIME_ZONE),
    deadlineAt: zonedLocalMinuteToIso(date, closeMinute + retry, US_TIME_ZONE),
    captureDelayMinutes: delay,
    retryWindowMinutes: retry,
    timeZone: US_TIME_ZONE,
  };
}

/**
 * Pure wall-clock gate used by the Electron host. The trading date is derived
 * in America/New_York, so DST, regular closes and official early closes all
 * share the same policy. No prior trading date is inferred after the window.
 */
export function isWithinUsSnapshotCaptureWindow(value) {
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) return false;
  const local = zonedDateParts(instant, US_TIME_ZONE);
  if (!isUsTradingDay(local.date)) return false;
  const window = usSnapshotCaptureWindow({ tradingDate: local.date });
  const instantMs = instant.getTime();
  return instantMs >= Date.parse(window.opensAt)
    && instantMs <= Date.parse(window.deadlineAt);
}

/** Runtime-only state for non-interactive broker reconnects during capture. */
export function createSnapshotReconnectState(input = {}) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    schemaVersion: SCHEMA_VERSION,
    tradingDate: validTradingDateOrNull(value.tradingDate),
    attemptCount: normalizeNonNegativeInteger(value.attemptCount),
    nextAttemptAt: validIsoOrNull(value.nextAttemptAt),
    blockedForWindow: value.blockedForWindow === true,
    lastAttemptAt: validIsoOrNull(value.lastAttemptAt),
    lastSuccessAt: validIsoOrNull(value.lastSuccessAt),
    lastFailureKind: value.lastFailureKind == null
      ? null
      : String(value.lastFailureKind).trim().slice(0, 80) || null,
  };
}

/**
 * Pure eligibility gate. A reconnect is never attempted outside the official
 * capture window, without persisted authorization, while auth is blocked for
 * the window, or before the bounded backoff expires.
 */
export function decideSnapshotReconnect({
  state,
  now = new Date(),
  connected = false,
  hasSavedAuthorization = false,
} = {}) {
  const instant = now instanceof Date ? now : new Date(now);
  const normalized = createSnapshotReconnectState(state);
  if (!Number.isFinite(instant.getTime())) {
    return { shouldAttempt: false, reason: "invalid_time", tradingDate: null, state: normalized };
  }
  if (!isWithinUsSnapshotCaptureWindow(instant)) {
    return { shouldAttempt: false, reason: "outside_capture_window", tradingDate: null, state: normalized };
  }
  const tradingDate = zonedDateParts(instant, US_TIME_ZONE).date;
  const current = normalized.tradingDate === tradingDate
    ? normalized
    : createSnapshotReconnectState({ tradingDate });
  if (connected) {
    return { shouldAttempt: false, reason: "already_connected", tradingDate, state: current };
  }
  if (!hasSavedAuthorization) {
    return { shouldAttempt: false, reason: "saved_authorization_missing", tradingDate, state: current };
  }
  if (current.blockedForWindow) {
    return { shouldAttempt: false, reason: "blocked_for_capture_window", tradingDate, state: current };
  }
  if (current.nextAttemptAt && instant.getTime() < Date.parse(current.nextAttemptAt)) {
    return { shouldAttempt: false, reason: "backoff_active", tradingDate, state: current };
  }
  return { shouldAttempt: true, reason: "eligible", tradingDate, state: current };
}

/**
 * Records one completed reconnect attempt. Auth/permission failures are
 * blocked for the rest of the trading-date window; retryable transport,
 * timeout, gateway and rate-limit failures use capped exponential backoff.
 */
export function recordSnapshotReconnectOutcome(state, {
  now = new Date(),
  tradingDate,
  outcome,
  classification = {},
  baseDelayMs = DEFAULT_RECONNECT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_RECONNECT_MAX_DELAY_MS,
} = {}) {
  const instant = now instanceof Date ? now : new Date(now);
  const at = requiredIso(instant);
  const date = requiredTradingDate(tradingDate);
  const current = createSnapshotReconnectState(state);
  const attemptCount = (current.tradingDate === date ? current.attemptCount : 0) + 1;
  if (outcome === "success") {
    return createSnapshotReconnectState({
      tradingDate: date,
      attemptCount,
      lastAttemptAt: at,
      lastSuccessAt: at,
    });
  }
  if (outcome !== "failure") {
    throw reliabilityError("SNAPSHOT_RECONNECT_OUTCOME_INVALID", "自动重连结果无效。");
  }
  const kind = String(classification?.kind ?? "unknown").trim().toLowerCase() || "unknown";
  const authFailure = kind === "auth" || kind === "permission" || classification?.reauth === true;
  const retryable = classification?.retryable === true && !authFailure;
  if (!retryable) {
    return createSnapshotReconnectState({
      tradingDate: date,
      attemptCount,
      blockedForWindow: true,
      lastAttemptAt: at,
      lastFailureKind: kind,
    });
  }
  const base = positiveInteger(baseDelayMs, "自动重连基础退避无效。");
  const cap = positiveInteger(maxDelayMs, "自动重连最大退避无效。");
  if (base > cap) {
    throw reliabilityError("SNAPSHOT_RECONNECT_BACKOFF_INVALID", "自动重连基础退避不能超过最大退避。");
  }
  const delayMs = Math.min(cap, base * (2 ** Math.min(attemptCount - 1, 20)));
  const deadlineMs = Date.parse(usSnapshotCaptureWindow({ tradingDate: date }).deadlineAt);
  const nextAttemptMs = Math.min(instant.getTime() + delayMs, deadlineMs);
  return createSnapshotReconnectState({
    tradingDate: date,
    attemptCount,
    nextAttemptAt: nextAttemptMs > instant.getTime()
      ? new Date(nextAttemptMs).toISOString()
      : null,
    lastAttemptAt: at,
    lastFailureKind: kind,
  });
}

/**
 * Derives *proposed* irreversible gap transitions from an authoritative list
 * of trading days. It does not mutate the ledger and never fills missing
 * historical data. The host may persist the returned transitions after it has
 * presented/queued its alert work.
 *
 * `monitoringStartedAt` is mandatory in spirit: by default it is the ledger's
 * creation time, so dates before monitoring began stay `missing`, not gaps.
 */
export function deriveExpiredSnapshotGaps(ledger, {
  accountScopeId,
  tradingDates,
  now = new Date(),
  monitoringStartedAt,
  deadlineForTradingDate = usSnapshotCaptureDeadline,
} = {}) {
  const scope = requiredId(accountScopeId, "账户范围无效。");
  const dates = normalizeTradingDates(tradingDates);
  const current = requiredIso(now);
  const currentMs = Date.parse(current);
  const startedAt = requiredIso(monitoringStartedAt ?? ledger?.createdAt);
  const startedMs = Date.parse(startedAt);
  const entries = new Map(listSnapshotCoverageEntries(ledger, { accountScopeId: scope })
    .map((entry) => [entry.tradingDate, entry]));
  const transitions = [];

  for (const tradingDate of dates) {
    const deadline = requiredIso(deadlineForTradingDate({ tradingDate }));
    const deadlineMs = Date.parse(deadline);
    // Monitoring cannot retroactively declare pre-monitoring dates failed.
    // The exact deadline instant is still a valid capture boundary. A gap is
    // irreversible, so seal it only once the deadline has actually passed.
    if (deadlineMs < startedMs || deadlineMs >= currentMs) continue;
    const entry = entries.get(tradingDate) ?? null;
    if (entry?.status === "confirmed" || entry?.status === "gap") continue;
    transitions.push({
      eventId: `gap-window-expired:v1:${scope}:${tradingDate}`,
      accountScopeId: scope,
      tradingDate,
      toStatus: "gap",
      at: current,
      reason: gapReason(entry),
      deadlineAt: deadline,
      priorStatus: entry?.status ?? "missing",
      attemptCount: entry?.attemptCount ?? 0,
    });
  }
  return transitions;
}

/**
 * A UI/notification-safe view of expired capture windows. Acknowledgement is
 * intentionally external: the append-only coverage ledger remains factual,
 * while a user can dismiss a notification without rewriting evidence.
 */
export function listExpiredSnapshotCaptureAlerts(ledger, options = {}) {
  const transitions = deriveExpiredSnapshotGaps(ledger, options);
  const acknowledged = new Set((Array.isArray(options.acknowledgedGapKeys)
    ? options.acknowledgedGapKeys
    : []).map(String));
  return transitions.map((transition) => ({
    alertKey: `snapshot-gap:${transition.accountScopeId}:${transition.tradingDate}`,
    severity: transition.attemptCount > 0 ? "warning" : "error",
    acknowledged: acknowledged.has(`snapshot-gap:${transition.accountScopeId}:${transition.tradingDate}`),
    ...transition,
  }));
}

/** A concise, serializable policy shown in the UI and review evidence. */
export function snapshotBackgroundReliabilityPolicy() {
  return {
    schemaVersion: "snapshot-background-reliability/v1",
    defaultEnabled: false,
    defaultLaunchAtLogin: false,
    requiresExplicitOptIn: true,
    monitoringEpoch: "reset_when_collection_is_reenabled_and_bound_per_account_scope",
    captureWindow: "US official regular/early close + 10 through + 240 minutes, inclusive",
    captureDeadline: "US regular close + 240 minutes; early closes use the official early close",
    preMonitoringDates: "remain_missing_not_gap",
    expiredWindows: "record_gap_without_backfilling_or_revaluing_history",
    reconnect: "saved-authorization-only, non-interactive, auth-blocked per window, retryable failures use capped exponential backoff",
    acknowledgement: "notification_state_only_never_rewrites_ledger",
  };
}

function normalizeScopeActivationMap(value) {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw reliabilityError("SNAPSHOT_SCOPE_ACTIVATION_INVALID", "账户监控起点无效。");
  }
  const entries = Object.entries(value);
  if (entries.length > 64) {
    throw reliabilityError("SNAPSHOT_SCOPE_ACTIVATION_LIMIT", "账户监控起点数量超过上限。");
  }
  const result = {};
  for (const [key, at] of entries) {
    const scope = requiredId(key, "账户范围无效。");
    result[scope] = requiredIso(at);
  }
  return result;
}

function gapReason(entry) {
  if (!entry) return "capture_window_expired_without_attempt";
  if (entry.status === "attempting") return "capture_window_expired_after_attempts";
  if (entry.status === "degraded") return "capture_window_expired_after_degraded_capture";
  if (entry.status === "pending") return "capture_window_expired_pending";
  return "capture_window_expired_without_confirmed_snapshot";
}

function usCloseMinute(date) {
  const year = Number(date.slice(0, 4));
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  const blackFriday = addDays(thanksgiving, 1);
  const christmasEve = `${year}-12-24`;
  const independenceObserved = observedFixedHoliday(year, 7, 4);
  let priorIndependenceTradingDay = addDays(independenceObserved, -1);
  while (!isUsTradingDay(priorIndependenceTradingDay)) {
    priorIndependenceTradingDay = addDays(priorIndependenceTradingDay, -1);
  }
  return [blackFriday, christmasEve, priorIndependenceTradingDay].includes(date)
    ? 13 * 60
    : 16 * 60;
}

// Converts a wall-clock date/minute in a known IANA zone to UTC. The second
// pass handles daylight-saving offsets without external date-time libraries.
function zonedLocalMinuteToIso(date, minuteOfDay, timeZone) {
  const normalizedMinute = Number(minuteOfDay);
  if (!Number.isFinite(normalizedMinute)) {
    throw reliabilityError("SNAPSHOT_CAPTURE_TIME_INVALID", "捕获截止时间无效。");
  }
  const dayOffset = Math.floor(normalizedMinute / (24 * 60));
  const withinDay = ((normalizedMinute % (24 * 60)) + (24 * 60)) % (24 * 60);
  const localDate = addDays(date, dayOffset);
  const [year, month, day] = localDate.split("-").map(Number);
  const wantedEncoded = Date.UTC(year, month - 1, day, Math.floor(withinDay / 60), withinDay % 60);
  let instantMs = wantedEncoded;
  for (let index = 0; index < 3; index += 1) {
    const parts = zonedDateParts(new Date(instantMs), timeZone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    instantMs += wantedEncoded - represented;
  }
  const result = new Date(instantMs);
  const final = zonedDateParts(result, timeZone);
  if (final.date !== localDate || final.hour * 60 + final.minute !== withinDay) {
    throw reliabilityError("SNAPSHOT_CAPTURE_TIME_INVALID", "无法确定捕获截止时间。");
  }
  return result.toISOString();
}

function zonedDateParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${fields.year}-${fields.month}-${fields.day}`,
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour),
    minute: Number(fields.minute),
  };
}

function observedFixedHoliday(year, month, day) {
  const date = formatDate(year, month, day);
  const weekday = utcDate(date).getUTCDay();
  if (weekday === 6) return addDays(date, -1);
  if (weekday === 0) return addDays(date, 1);
  return date;
}

function nthWeekday(year, month, weekday, nth) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return formatDate(year, month, 1 + offset + (nth - 1) * 7);
}

function addDays(date, count) {
  const value = utcDate(date);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

function utcDate(date) {
  return new Date(`${date}T00:00:00.000Z`);
}

function formatDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeTradingDates(value) {
  if (!Array.isArray(value)) {
    throw reliabilityError("SNAPSHOT_RELIABILITY_CALENDAR_REQUIRED", "必须提供权威交易日列表。");
  }
  const dates = value.map(requiredTradingDate);
  if (new Set(dates).size !== dates.length) {
    throw reliabilityError("SNAPSHOT_RELIABILITY_CALENDAR_DUPLICATE", "权威交易日列表包含重复日期。");
  }
  return dates.sort();
}

function requiredTradingDate(value) {
  const date = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw reliabilityError("SNAPSHOT_RELIABILITY_DATE_INVALID", "交易日无效。");
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw reliabilityError("SNAPSHOT_RELIABILITY_DATE_INVALID", "交易日无效。");
  }
  return date;
}

function requiredIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw reliabilityError("SNAPSHOT_RELIABILITY_TIME_INVALID", "时间无效。");
  }
  return date.toISOString();
}

function requiredId(value, message) {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,239}$/.test(id)) {
    throw reliabilityError("SNAPSHOT_RELIABILITY_SCOPE_INVALID", message);
  }
  return id;
}

function nonNegativeInteger(value, message) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw reliabilityError("SNAPSHOT_RELIABILITY_NUMBER_INVALID", message);
  }
  return number;
}

function positiveInteger(value, message) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw reliabilityError("SNAPSHOT_RELIABILITY_NUMBER_INVALID", message);
  }
  return number;
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function validTradingDateOrNull(value) {
  try {
    return value == null ? null : requiredTradingDate(value);
  } catch {
    return null;
  }
}

function validIsoOrNull(value) {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function reliabilityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
