import {
  deserializeSnapshotCoverage,
  snapshotCoverageEntry,
  transitionSnapshotCoverage,
} from "./snapshot-coverage.mjs";

/**
 * Reconcile already-persisted, caller-verified regular-close snapshots.
 * This records when durable evidence was reconciled, not a new capture time.
 * Persistence and gap sealing belong to the caller and must follow success.
 */
export function reconcileDurableSnapshotCoverage(ledger, snapshots, {
  scopeId,
  now = new Date(),
} = {}) {
  if (typeof scopeId !== "string" || !scopeId.trim() || scopeId !== scopeId.trim()) {
    throw invalidInput("快照对账必须指定有效账户范围。");
  }
  if (!Array.isArray(snapshots)) throw invalidInput("快照对账必须提供已保存快照列表。");
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw invalidInput("快照对账时间无效。");
  let current = deserializeSnapshotCoverage(ledger);
  const originalRevision = current.revision;
  // Never infer the account from the caller or accept a legacy top-level
  // scope field as a substitute for the immutable snapshot's own binding.
  const scoped = snapshots.filter((snapshot) => snapshot?.accountScope?.scopeId === scopeId)
    .slice().sort((left, right) => (
      String(left.tradingDate).localeCompare(String(right.tradingDate))
      || String(left.snapshotId).localeCompare(String(right.snapshotId))
    ));

  for (const snapshot of scoped) {
    if (typeof snapshot.snapshotId !== "string" || !snapshot.snapshotId.trim()
      || snapshot.snapshotId !== snapshot.snapshotId.trim()) {
      throw invalidInput("已保存快照缺少有效快照 ID。");
    }
    const entry = snapshotCoverageEntry(current, {
      accountScopeId: scopeId,
      tradingDate: snapshot.tradingDate,
    });
    if (entry?.status === "confirmed" && entry.confirmedSnapshotId === snapshot.snapshotId) continue;
    if (entry?.status === "gap" || entry?.status === "confirmed") {
      const error = new Error("已保存快照与连续性终态冲突；未解除缺口或替换确认记录，需要单独核验证据并记录纠正事件。");
      error.code = "SNAPSHOT_COVERAGE_DURABLE_CONFLICT";
      error.accountScopeId = scopeId;
      error.tradingDate = snapshot.tradingDate;
      error.existingStatus = entry.status;
      error.existingSnapshotId = entry.confirmedSnapshotId ?? null;
      error.snapshotId = snapshot.snapshotId;
      throw error;
    }
    const reconciledAt = new Date(Math.max(
      nowMs,
      Date.parse(current.createdAt),
      Date.parse(current.updatedAt),
      entry ? Date.parse(entry.updatedAt) : -Infinity,
    )).toISOString();
    current = transitionSnapshotCoverage(current, {
      eventId: `reconcile:${scopeId}:${snapshot.tradingDate}:${snapshot.snapshotId}`,
      accountScopeId: scopeId,
      tradingDate: snapshot.tradingDate,
      toStatus: "confirmed",
      at: reconciledAt,
      snapshotId: snapshot.snapshotId,
    });
  }
  return current.revision === originalRevision ? ledger : current;
}

function invalidInput(message) {
  return Object.assign(new Error(message), { code: "SNAPSHOT_COVERAGE_RECONCILE_INVALID" });
}
