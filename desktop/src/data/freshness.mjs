import {
  PORTFOLIO_VALUATION_GATE_SCHEMA_VERSION,
  stablePortfolioValuationGateHash,
} from "./portfolio-valuation-gate.mjs";

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
  const valuationGate = portfolioValuationGateFreshness(portfolio?.valuationGate);
  const snapshotFreshForSizing = state === "fresh";
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
    snapshotFreshForSizing,
    valuationGate,
    freshForSizing: snapshotFreshForSizing && valuationGate.readyForSizing,
  };
}

/**
 * Treat the host valuation gate as an independently verified prerequisite.
 * Missing, malformed, tampered, or non-passing gates fail closed; a recent
 * account response can never promote stale per-symbol marks.
 */
export function portfolioValuationGateFreshness(gate) {
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
    return {
      status: "missing",
      valid: false,
      readyForSizing: false,
      hash: null,
      reason: "valuation_gate_missing",
    };
  }
  if (gate.schemaVersion !== PORTFOLIO_VALUATION_GATE_SCHEMA_VERSION) {
    return {
      status: "invalid",
      valid: false,
      readyForSizing: false,
      hash: typeof gate.hash === "string" ? gate.hash : null,
      reason: "valuation_gate_schema_unsupported",
    };
  }
  try {
    const expectedHash = stablePortfolioValuationGateHash(gate);
    if (gate.hash !== expectedHash) {
      return {
        status: "invalid",
        valid: false,
        readyForSizing: false,
        hash: typeof gate.hash === "string" ? gate.hash : null,
        reason: "valuation_gate_hash_mismatch",
      };
    }
  } catch {
    return {
      status: "invalid",
      valid: false,
      readyForSizing: false,
      hash: typeof gate.hash === "string" ? gate.hash : null,
      reason: "valuation_gate_malformed",
    };
  }
  const outcomeStatus = String(gate.outcome?.status ?? "unknown");
  const readyForSizing = outcomeStatus === "pass"
    && gate.outcome?.readyForSizing === true;
  return {
    status: outcomeStatus,
    valid: true,
    readyForSizing,
    hash: gate.hash,
    reason: readyForSizing ? null : "valuation_gate_not_ready",
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
      snapshotFreshForSizing: normalizedState === "fresh",
      freshForSizing: normalizedState === "fresh"
        && measured.valuationGate.readyForSizing,
      reason: reason == null ? portfolio.freshness?.reason ?? null : String(reason).slice(0, 300),
    },
  };
}
