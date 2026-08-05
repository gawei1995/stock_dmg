export const PORTFOLIO_FRESHNESS_MAX_AGE_MS = 2 * 60 * 1000;

export function portfolioSnapshotAgeMs(portfolio, now = Date.now()) {
  const timestamp = Date.parse(String(portfolio?.syncedAt ?? ""));
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Number(now) - timestamp);
}

export function portfolioFreshness(portfolio, {
  now = Date.now(),
  maxAgeMs = PORTFOLIO_FRESHNESS_MAX_AGE_MS,
} = {}) {
  const ageMs = portfolioSnapshotAgeMs(portfolio, now);
  const snapshotTimestamp = Date.parse(String(portfolio?.syncedAt ?? ""));
  const sourceStatus = String(portfolio?.status ?? "unknown");
  const state = sourceStatus === "cached"
    ? "cached"
    : sourceStatus === "stale"
      ? "stale"
      : sourceStatus === "live" || sourceStatus === "degraded"
        ? ageMs != null && ageMs <= maxAgeMs ? "fresh" : "stale"
        : "unknown";
  return {
    state,
    sourceStatus,
    ageMs,
    maxAgeMs,
    assessedAt: new Date(Number(now)).toISOString(),
    snapshotAt: portfolio?.syncedAt ?? null,
    expiresAt: Number.isFinite(snapshotTimestamp)
      ? new Date(snapshotTimestamp + maxAgeMs).toISOString()
      : null,
    freshForSizing: state === "fresh",
  };
}

export function withPortfolioFreshness(portfolio, {
  now = Date.now(),
  maxAgeMs = PORTFOLIO_FRESHNESS_MAX_AGE_MS,
  forceState = null,
  reason = null,
} = {}) {
  if (!portfolio || typeof portfolio !== "object") return portfolio;
  const measured = portfolioFreshness(portfolio, { now, maxAgeMs });
  const state = forceState ?? measured.state;
  const normalizedState = ["fresh", "stale", "cached", "unknown"].includes(state)
    ? state
    : "unknown";
  const visibleStatus = normalizedState === "stale" || normalizedState === "cached"
    ? normalizedState
    : portfolio.status;
  return {
    ...portfolio,
    ...(visibleStatus ? { status: visibleStatus } : {}),
    ...(normalizedState === "stale" || normalizedState === "cached"
      ? { holdingsStatus: normalizedState }
      : {}),
    freshness: {
      ...measured,
      state: normalizedState,
      freshForSizing: normalizedState === "fresh",
      reason: reason == null ? portfolio.freshness?.reason ?? null : String(reason).slice(0, 300),
    },
  };
}
