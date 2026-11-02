const SCHEMA_VERSION = 1;

const COVERAGE_STATES = new Set([
  "pending",
  "attempting",
  "confirmed",
  "degraded",
  "gap",
]);

const CALENDAR_STATES = new Set([...COVERAGE_STATES, "missing"]);

const ALLOWED_TRANSITIONS = Object.freeze({
  pending: new Set(["pending", "attempting", "confirmed", "degraded", "gap"]),
  attempting: new Set(["attempting", "confirmed", "degraded", "gap"]),
  degraded: new Set(["attempting", "confirmed", "degraded", "gap"]),
  confirmed: new Set(["confirmed"]),
  gap: new Set(["gap"]),
});

/**
 * A small, persistence-agnostic continuity ledger.
 *
 * It records whether a real snapshot capture happened for an authoritative
 * trading date. It never reconstructs or manufactures a missed historical
 * snapshot. Callers must supply the exchange trading-date list separately.
 */
export function createSnapshotCoverageLedger({ createdAt = new Date() } = {}) {
  const timestamp = requiredIso(createdAt, "连续性账本创建时间无效。");
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 0,
    entries: [],
    events: [],
  };
}

/**
 * Applies one idempotent state transition and returns a new ledger.
 *
 * eventId is the caller's durable idempotency key. Replaying the same event
 * is a no-op; reusing its ID with different content fails closed.
 */
export function transitionSnapshotCoverage(ledger, transition) {
  const current = normalizeLedger(ledger);
  const event = normalizeTransition(transition);
  if (Date.parse(event.at) < Date.parse(current.createdAt)) {
    throw coverageError(
      "SNAPSHOT_COVERAGE_TIME_REGRESSION",
      "连续性事件时间早于账本创建时间。",
    );
  }
  const replay = current.events.find((item) => item.eventId === event.eventId);
  if (replay) {
    if (eventFingerprint(replay) !== eventFingerprint(event)) {
      throw coverageError(
        "SNAPSHOT_COVERAGE_EVENT_CONFLICT",
        "连续性事件 ID 已被不同内容使用。",
      );
    }
    return structuredClone(current);
  }

  const entryIndex = current.entries.findIndex((item) => (
    item.accountScopeId === event.accountScopeId
      && item.tradingDate === event.tradingDate
  ));
  const previous = entryIndex >= 0
    ? current.entries[entryIndex]
    : initialEntry(event);

  if (Date.parse(event.at) < Date.parse(previous.updatedAt)) {
    throw coverageError(
      "SNAPSHOT_COVERAGE_TIME_REGRESSION",
      "连续性事件时间早于该交易日的最新状态。",
    );
  }

  assertTransitionAllowed(previous, event);
  const nextEntry = applyTransition(previous, event);

  // Terminal replay remains idempotent even when an upstream caller emits a
  // different event ID for the same already-confirmed fact.
  if (entryIndex >= 0 && sameEntry(previous, nextEntry)) return structuredClone(current);

  const sequence = current.revision + 1;
  const storedEvent = {
    ...event,
    sequence,
    fromStatus: previous.status,
  };
  const entries = [...current.entries];
  const storedEntry = { ...nextEntry, revision: sequence };
  if (entryIndex >= 0) entries[entryIndex] = storedEntry;
  else entries.push(storedEntry);
  entries.sort(compareEntries);

  return {
    ...current,
    updatedAt: event.at,
    revision: sequence,
    entries,
    events: [...current.events, storedEvent],
  };
}

export function snapshotCoverageEntry(ledger, options = {}) {
  const normalized = normalizeLedger(ledger);
  const scope = coverageScopeId(options, "账户范围无效。");
  const date = requiredTradingDate(options.tradingDate);
  const entry = normalized.entries.find((item) => (
    item.accountScopeId === scope && item.tradingDate === date
  ));
  return entry ? structuredClone(entry) : null;
}

export function listSnapshotCoverageEntries(ledger, options = {}) {
  const normalized = normalizeLedger(ledger);
  const scopeValue = options.accountScopeId ?? options.scopeId ?? options.accountScope?.scopeId;
  const scope = scopeValue == null
    ? null
    : requiredId(scopeValue, "账户范围无效。");
  return normalized.entries
    .filter((item) => !scope || item.accountScopeId === scope)
    .map((item) => structuredClone(item));
}

/**
 * Builds UI-ready cells for dates supplied by an authoritative exchange
 * calendar. Absence remains `missing`; no historical state is inferred.
 */
export function buildSnapshotCoverageCalendar(ledger, options = {}) {
  const normalized = normalizeLedger(ledger);
  const scope = coverageScopeId(options, "覆盖日历必须指定账户范围。");
  const dates = normalizeTradingDates(options.tradingDates);
  const byDate = new Map(normalized.entries
    .filter((item) => item.accountScopeId === scope)
    .map((item) => [item.tradingDate, item]));

  return dates.map((tradingDate) => {
    const entry = byDate.get(tradingDate);
    if (!entry) {
      return {
        accountScopeId: scope,
        tradingDate,
        status: "missing",
        attemptCount: 0,
        lastAttemptAt: null,
        failureReason: null,
        lastFailureReason: null,
        confirmedSnapshotId: null,
        captured: false,
        final: false,
      };
    }
    return {
      accountScopeId: scope,
      tradingDate,
      status: entry.status,
      attemptCount: entry.attemptCount,
      lastAttemptAt: entry.lastAttemptAt,
      failureReason: entry.failureReason,
      lastFailureReason: entry.lastFailureReason,
      confirmedSnapshotId: entry.confirmedSnapshotId,
      captured: entry.status === "confirmed" || entry.status === "degraded",
      final: entry.status === "confirmed" || entry.status === "gap",
    };
  });
}

export function summarizeSnapshotCoverage(ledger, options = {}) {
  const calendar = buildSnapshotCoverageCalendar(ledger, options);
  const counts = Object.fromEntries([...CALENDAR_STATES].map((status) => [status, 0]));
  for (const item of calendar) counts[item.status] += 1;
  const expectedTradingDays = calendar.length;
  const capturedCount = counts.confirmed + counts.degraded;
  const accountedForCount = expectedTradingDays - counts.missing;
  const unresolvedCount = counts.pending + counts.attempting + counts.missing;
  return {
    accountScopeId: coverageScopeId(options, "覆盖摘要必须指定账户范围。"),
    expectedTradingDays,
    counts,
    capturedCount,
    accountedForCount,
    unresolvedCount,
    confirmedRate: rate(counts.confirmed, expectedTradingDays),
    evidenceRate: rate(capturedCount, expectedTradingDays),
    accountedForRate: rate(accountedForCount, expectedTradingDays),
    hasGaps: counts.gap > 0 || counts.missing > 0,
    complete: expectedTradingDays > 0
      && counts.confirmed === expectedTradingDays,
  };
}

export function serializeSnapshotCoverage(ledger) {
  return JSON.stringify(normalizeLedger(ledger));
}

export function deserializeSnapshotCoverage(serialized) {
  let value;
  try {
    value = typeof serialized === "string" ? JSON.parse(serialized) : structuredClone(serialized);
  } catch {
    throw coverageError(
      "SNAPSHOT_COVERAGE_SERIALIZATION_INVALID",
      "连续性账本无法解析。",
    );
  }
  return normalizeLedger(value);
}

export const SNAPSHOT_COVERAGE_SCHEMA_VERSION = SCHEMA_VERSION;
export const SNAPSHOT_COVERAGE_STATES = Object.freeze([...COVERAGE_STATES]);

function normalizeLedger(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw coverageError("SNAPSHOT_COVERAGE_LEDGER_INVALID", "连续性账本无效。");
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw coverageError("SNAPSHOT_COVERAGE_SCHEMA_UNSUPPORTED", "连续性账本版本不受支持。");
  }
  const createdAt = requiredIso(value.createdAt, "连续性账本创建时间无效。");
  const updatedAt = requiredIso(value.updatedAt, "连续性账本更新时间无效。");
  const revision = nonNegativeInteger(value.revision, "连续性账本 revision 无效。");
  if (!Array.isArray(value.entries) || !Array.isArray(value.events)) {
    throw coverageError("SNAPSHOT_COVERAGE_LEDGER_INVALID", "连续性账本记录无效。");
  }

  const entries = value.entries.map(normalizeEntry).sort(compareEntries);
  const entryKeys = entries.map(entryKey);
  if (new Set(entryKeys).size !== entryKeys.length) {
    throw coverageError("SNAPSHOT_COVERAGE_ENTRY_DUPLICATE", "连续性账本包含重复交易日记录。");
  }

  const events = value.events.map(normalizeStoredEvent).sort((left, right) => left.sequence - right.sequence);
  const eventIds = events.map((item) => item.eventId);
  const sequences = events.map((item) => item.sequence);
  if (new Set(eventIds).size !== eventIds.length) {
    throw coverageError("SNAPSHOT_COVERAGE_EVENT_DUPLICATE", "连续性账本包含重复事件 ID。");
  }
  if (new Set(sequences).size !== sequences.length
    || sequences.some((sequence, index) => sequence !== index + 1)
    || revision !== events.length) {
    throw coverageError("SNAPSHOT_COVERAGE_REVISION_INVALID", "连续性账本事件序列不连续。");
  }
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw coverageError("SNAPSHOT_COVERAGE_TIME_INVALID", "连续性账本更新时间早于创建时间。");
  }

  assertLedgerConsistency({
    schemaVersion: SCHEMA_VERSION,
    createdAt,
    updatedAt,
    revision,
    entries,
    events,
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt,
    updatedAt,
    revision,
    entries,
    events,
  };
}

function normalizeEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw coverageError("SNAPSHOT_COVERAGE_ENTRY_INVALID", "连续性交易日记录无效。");
  }
  const status = requiredState(value.status);
  const entry = {
    accountScopeId: requiredId(value.accountScopeId, "连续性记录账户范围无效。"),
    tradingDate: requiredTradingDate(value.tradingDate),
    status,
    firstSeenAt: requiredIso(value.firstSeenAt, "连续性记录首次时间无效。"),
    updatedAt: requiredIso(value.updatedAt, "连续性记录更新时间无效。"),
    revision: positiveInteger(value.revision, "连续性记录 revision 无效。"),
    attemptCount: nonNegativeInteger(value.attemptCount, "连续性尝试次数无效。"),
    lastAttemptAt: optionalIso(value.lastAttemptAt, "连续性最后尝试时间无效。"),
    failureReason: optionalReason(value.failureReason ?? value.lastFailureReason),
    lastFailureReason: optionalReason(value.lastFailureReason ?? value.failureReason),
    confirmedSnapshotId: optionalId(value.confirmedSnapshotId),
    confirmedAt: optionalIso(value.confirmedAt, "连续性确认时间无效。"),
    degradedAt: optionalIso(value.degradedAt, "连续性降级时间无效。"),
    gapAt: optionalIso(value.gapAt, "连续性缺口时间无效。"),
  };
  if (Date.parse(entry.updatedAt) < Date.parse(entry.firstSeenAt)) {
    throw coverageError("SNAPSHOT_COVERAGE_TIME_INVALID", "连续性记录更新时间早于首次时间。");
  }
  if (entry.failureReason !== entry.lastFailureReason) {
    throw coverageError("SNAPSHOT_COVERAGE_REASON_INVALID", "连续性失败原因字段不一致。");
  }
  if (status === "confirmed" && (!entry.confirmedSnapshotId || !entry.confirmedAt)) {
    throw coverageError("SNAPSHOT_COVERAGE_CONFIRMATION_INVALID", "已确认记录缺少快照 ID 或确认时间。");
  }
  if (status === "gap" && (!entry.gapAt || !entry.lastFailureReason)) {
    throw coverageError("SNAPSHOT_COVERAGE_GAP_INVALID", "缺口记录缺少原因或时间。");
  }
  if (status === "degraded" && (!entry.degradedAt || !entry.lastFailureReason)) {
    throw coverageError("SNAPSHOT_COVERAGE_DEGRADED_INVALID", "降级记录缺少原因或时间。");
  }
  return entry;
}

function normalizeTransition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw coverageError("SNAPSHOT_COVERAGE_TRANSITION_INVALID", "连续性状态转换无效。");
  }
  const toStatus = requiredState(value.toStatus ?? value.status);
  const reason = optionalReason(value.reason ?? value.failureReason);
  const snapshotId = optionalId(value.snapshotId ?? value.confirmedSnapshotId);
  if ((toStatus === "degraded" || toStatus === "gap") && !reason) {
    throw coverageError(
      "SNAPSHOT_COVERAGE_REASON_REQUIRED",
      `${toStatus === "gap" ? "缺口" : "降级"}状态必须记录原因。`,
    );
  }
  if (toStatus === "confirmed" && !snapshotId) {
    throw coverageError(
      "SNAPSHOT_COVERAGE_SNAPSHOT_REQUIRED",
      "确认状态必须关联真实快照 ID。",
    );
  }
  return {
    eventId: requiredId(value.eventId, "连续性事件 ID 无效。"),
    accountScopeId: requiredId(
      value.accountScopeId ?? value.scopeId ?? value.accountScope?.scopeId,
      "连续性事件账户范围无效。",
    ),
    tradingDate: requiredTradingDate(value.tradingDate),
    toStatus,
    at: requiredIso(value.at, "连续性事件时间无效。"),
    reason: toStatus === "degraded" || toStatus === "gap" ? reason : null,
    snapshotId: toStatus === "confirmed" ? snapshotId : null,
  };
}

function normalizeStoredEvent(value) {
  const event = normalizeTransition(value);
  return {
    ...event,
    sequence: positiveInteger(value.sequence, "连续性事件序号无效。"),
    fromStatus: requiredState(value.fromStatus),
  };
}

function initialEntry(event) {
  return {
    accountScopeId: event.accountScopeId,
    tradingDate: event.tradingDate,
    status: "pending",
    firstSeenAt: event.at,
    updatedAt: event.at,
    revision: 0,
    attemptCount: 0,
    lastAttemptAt: null,
    failureReason: null,
    lastFailureReason: null,
    confirmedSnapshotId: null,
    confirmedAt: null,
    degradedAt: null,
    gapAt: null,
  };
}

function assertLedgerConsistency(ledger) {
  const derived = new Map();
  for (const event of ledger.events) {
    const key = `${event.accountScopeId}\0${event.tradingDate}`;
    const exists = derived.has(key);
    const previous = exists ? derived.get(key) : initialEntry(event);
    if (event.fromStatus !== previous.status) {
      throw coverageError(
        "SNAPSHOT_COVERAGE_EVENT_CHAIN_INVALID",
        "连续性事件的来源状态与事件链不一致。",
      );
    }
    if (Date.parse(event.at) < Date.parse(previous.updatedAt)
      || Date.parse(event.at) < Date.parse(ledger.createdAt)) {
      throw coverageError(
        "SNAPSHOT_COVERAGE_EVENT_CHAIN_INVALID",
        "连续性事件链包含时间倒退。",
      );
    }
    assertTransitionAllowed(previous, event);
    const next = applyTransition(previous, event);
    if (exists && sameEntry(previous, next)) {
      throw coverageError(
        "SNAPSHOT_COVERAGE_EVENT_CHAIN_INVALID",
        "连续性事件链包含未改变状态的冗余事件。",
      );
    }
    derived.set(key, { ...next, revision: event.sequence });
  }
  const derivedEntries = [...derived.values()].sort(compareEntries);
  if (JSON.stringify(derivedEntries) !== JSON.stringify(ledger.entries)) {
    throw coverageError(
      "SNAPSHOT_COVERAGE_ENTRY_CHAIN_MISMATCH",
      "连续性交易日状态与事件链不一致。",
    );
  }
  const expectedUpdatedAt = ledger.events.at(-1)?.at ?? ledger.createdAt;
  if (ledger.updatedAt !== expectedUpdatedAt) {
    throw coverageError(
      "SNAPSHOT_COVERAGE_EVENT_CHAIN_INVALID",
      "连续性账本更新时间与最后事件不一致。",
    );
  }
}

function assertTransitionAllowed(previous, event) {
  if (!ALLOWED_TRANSITIONS[previous.status]?.has(event.toStatus)) {
    throw coverageError(
      "SNAPSHOT_COVERAGE_TRANSITION_REJECTED",
      `连续性状态不能从 ${previous.status} 退回 ${event.toStatus}。`,
    );
  }
  if (previous.status === "confirmed" && event.toStatus === "confirmed"
    && previous.confirmedSnapshotId !== event.snapshotId) {
    throw coverageError(
      "SNAPSHOT_COVERAGE_CONFIRMATION_CONFLICT",
      "该交易日已由另一快照确认，不能静默替换。",
    );
  }
  if (previous.status === "gap" && event.toStatus === "gap"
    && previous.lastFailureReason !== event.reason) {
    throw coverageError(
      "SNAPSHOT_COVERAGE_GAP_CONFLICT",
      "已封存缺口不能静默改写原因。",
    );
  }
}

function applyTransition(previous, event) {
  if (previous.status === "confirmed" && event.toStatus === "confirmed") return previous;
  if (previous.status === "gap" && event.toStatus === "gap") return previous;
  if (previous.status === "pending" && event.toStatus === "pending") return previous;

  const next = {
    ...previous,
    status: event.toStatus,
    updatedAt: event.at,
  };
  if (event.toStatus === "attempting") {
    next.attemptCount += 1;
    next.lastAttemptAt = event.at;
  }
  if (event.toStatus === "degraded") {
    next.degradedAt = event.at;
    next.failureReason = event.reason;
    next.lastFailureReason = event.reason;
  }
  if (event.toStatus === "gap") {
    next.gapAt = event.at;
    next.failureReason = event.reason;
    next.lastFailureReason = event.reason;
  }
  if (event.toStatus === "confirmed") {
    next.confirmedAt = event.at;
    next.confirmedSnapshotId = event.snapshotId;
  }
  return next;
}

function sameEntry(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function eventFingerprint(value) {
  return JSON.stringify({
    eventId: value.eventId,
    accountScopeId: value.accountScopeId,
    tradingDate: value.tradingDate,
    toStatus: value.toStatus,
    at: value.at,
    reason: value.reason ?? null,
    snapshotId: value.snapshotId ?? null,
  });
}

function compareEntries(left, right) {
  return entryKey(left).localeCompare(entryKey(right));
}

function entryKey(value) {
  return `${value.accountScopeId}\0${value.tradingDate}`;
}

function normalizeTradingDates(value) {
  if (!Array.isArray(value)) {
    throw coverageError(
      "SNAPSHOT_COVERAGE_CALENDAR_REQUIRED",
      "覆盖日历必须由调用方提供真实交易日列表。",
    );
  }
  const dates = value.map(requiredTradingDate);
  if (new Set(dates).size !== dates.length) {
    throw coverageError("SNAPSHOT_COVERAGE_CALENDAR_DUPLICATE", "覆盖日历包含重复交易日。");
  }
  return dates.sort();
}

function requiredState(value) {
  const state = String(value ?? "").trim();
  if (!COVERAGE_STATES.has(state)) {
    throw coverageError("SNAPSHOT_COVERAGE_STATE_INVALID", "连续性状态无效。");
  }
  return state;
}

function coverageScopeId(value, message) {
  return requiredId(
    value?.accountScopeId ?? value?.scopeId ?? value?.accountScope?.scopeId,
    message,
  );
}

function requiredTradingDate(value) {
  const date = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw coverageError("SNAPSHOT_COVERAGE_DATE_INVALID", "交易日无效。");
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw coverageError("SNAPSHOT_COVERAGE_DATE_INVALID", "交易日无效。");
  }
  return date;
}

function requiredIso(value, message) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw coverageError("SNAPSHOT_COVERAGE_TIME_INVALID", message);
  }
  return date.toISOString();
}

function optionalIso(value, message) {
  return value == null || value === "" ? null : requiredIso(value, message);
}

function requiredId(value, message) {
  const id = optionalId(value);
  if (!id) throw coverageError("SNAPSHOT_COVERAGE_ID_INVALID", message);
  return id;
}

function optionalId(value) {
  if (value == null || value === "") return null;
  const id = String(value).trim();
  return /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,239}$/.test(id) ? id : null;
}

function optionalReason(value) {
  if (value == null) return null;
  const reason = String(value).trim();
  return reason ? reason.slice(0, 1_000) : null;
}

function positiveInteger(value, message) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw coverageError("SNAPSHOT_COVERAGE_NUMBER_INVALID", message);
  }
  return number;
}

function nonNegativeInteger(value, message) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw coverageError("SNAPSHOT_COVERAGE_NUMBER_INVALID", message);
  }
  return number;
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function coverageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
