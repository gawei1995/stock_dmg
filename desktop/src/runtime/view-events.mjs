const LONGBRIDGE_STATES = new Set([
  "awaiting_auth", "connecting", "connected", "disconnected", "syncing", "ready",
  "degraded", "service_degraded", "network_error", "permission_error", "reauth_required", "scope_upgrade_required",
  "authorization_generation_drain_timeout", "error",
]);

export function statusDomain(payload = {}) {
  if (payload.domain) return payload.domain;
  if (payload.phase === "trade_history") return "history";
  const state = String(payload.state ?? "");
  if (state.startsWith("agent_") || state.startsWith("codex_")) return "agent";
  if (state.startsWith("technical_radar_")) return "technical_radar";
  if (state.startsWith("snapshot_") || state.startsWith("background_capture_")) return "snapshot";
  if (state.startsWith("storage_")) return "storage";
  if (LONGBRIDGE_STATES.has(state)) return "longbridge";
  return "application";
}

export function storageHealthSnapshot(stores = []) {
  const health = stores.filter(Boolean).map(store => store.health());
  return {
    encrypted: health.length > 0 && health.every(item => item.encrypted),
    recoveredUnreadableState: health.some(item => item.recoveryAvailable),
    state: health.some(item => ["unavailable", "degraded"].includes(item.state)) ? "degraded"
      : health.length > 0 && health.every(item => item.state === "healthy") ? "healthy" : "uninitialized",
    stores: health,
  };
}

/** Coalesce view-only refreshes. Identity checks prevent an old account's
 * async ledger read from being pushed into the replacement account's page. */
export function createScopedSnapshotPublisher({ getIdentity, readSnapshot, send, delayMs = 30 }) {
  let sequence = 0;
  let timer = null;
  return {
    nextSequence: () => ++sequence,
    schedule() {
      if (timer) return;
      timer = setTimeout(async () => {
        timer = null;
        const identity = getIdentity();
        const snapshotUpdateSequence = ++sequence;
        try {
          const portfolioSnapshots = await readSnapshot();
          const current = getIdentity();
          if (identity.accountScopeId !== current.accountScopeId || identity.generation !== current.generation) return;
          send({ accountScopeId: identity.accountScopeId, snapshotUpdateSequence, portfolioSnapshots });
        } catch {
          // Domain owners publish failures; a failed view read must not turn
          // a successful capture into a connection error or fake empty ledger.
        }
      }, delayMs);
      timer.unref?.();
    },
    dispose() { if (timer) clearTimeout(timer); timer = null; },
  };
}
