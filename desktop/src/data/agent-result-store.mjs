const STORE_KEY = "agentResultsByThreadV1";
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_THREAD_RESULTS = 80;

/**
 * Keeps the last completed result for each app-owned Codex thread. The backing
 * store is Electron safeStorage, so switching sessions never leaks another
 * thread's result into the active conversation.
 */
export class AgentResultStore {
  constructor({ store, retentionMs = DEFAULT_RETENTION_MS } = {}) {
    this.store = store;
    this.retentionMs = retentionMs;
    this.mutationQueue = Promise.resolve();
    // Completion delivery must never wait for the encrypted persistence queue.
    // Keep the latest envelope in memory as soon as save() is called; disk is a
    // crash-recovery copy, not part of the renderer hand-off protocol.
    this.memoryResults = new Map();
  }

  peek(threadId) {
    const id = normalizeThreadId(threadId);
    if (!id) return null;
    const value = normalizeEnvelope(this.memoryResults.get(id), this.retentionMs);
    return value ? structuredClone(value) : null;
  }

  async latest(threadId) {
    const id = normalizeThreadId(threadId);
    if (!id) return null;
    const memory = this.peek(id);
    if (memory) return memory;
    // Do not await mutationQueue here. A slow write for one thread must not
    // head-of-line block opening or recovering another conversation.
    const state = normalizeState(await this.store?.get?.(STORE_KEY));
    const persisted = normalizeEnvelope(state.results[id], this.retentionMs);
    if (persisted) this.memoryResults.set(id, persisted);
    return persisted ? structuredClone(persisted) : null;
  }

  async save(envelope) {
    const normalized = normalizeEnvelope(envelope, this.retentionMs);
    if (!normalized) throw new Error("Agent result envelope is invalid or expired.");
    this.memoryResults.set(normalized.threadId, normalized);
    const mutation = this.mutationQueue.then(async () => {
      const state = normalizeState(await this.store?.get?.(STORE_KEY));
      const cutoff = Date.now() - this.retentionMs;
      const entries = Object.entries(state.results)
        .filter(([threadId, value]) => (
          threadId !== normalized.threadId
          && timestampMs(value?.completedAt) >= cutoff
        ));
      entries.push([normalized.threadId, normalized]);
      entries.sort((left, right) => timestampMs(right[1]?.completedAt) - timestampMs(left[1]?.completedAt));
      const results = Object.fromEntries(entries.slice(0, MAX_THREAD_RESULTS));
      await this.store?.set?.(STORE_KEY, {
        version: 1,
        updatedAt: new Date().toISOString(),
        results,
      });
      return structuredClone(normalized);
    });
    this.mutationQueue = mutation.then(() => undefined, () => undefined);
    return mutation;
  }
}

export function normalizeAgentResult(value, {
  retentionMs = DEFAULT_RETENTION_MS,
  threadId = null,
} = {}) {
  const normalized = normalizeEnvelope(value, retentionMs);
  if (!normalized) return null;
  if (threadId && normalized.threadId !== normalizeThreadId(threadId)) return null;
  return normalized;
}

function normalizeEnvelope(value, retentionMs) {
  const threadId = normalizeThreadId(value?.threadId ?? value?.run?.modelAnalysis?.threadId);
  if (!threadId || !value?.run?.id || !value?.operationId || !value?.completedAt) return null;
  const completedAt = timestampMs(value.completedAt);
  if (!Number.isFinite(completedAt) || Date.now() - completedAt > retentionMs) return null;
  return structuredClone({ ...value, threadId });
}

function normalizeState(value) {
  return value?.version === 1 && value.results && typeof value.results === "object"
    ? value
    : { version: 1, updatedAt: null, results: {} };
}

function normalizeThreadId(value) {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{4,200}$/.test(id) ? id : null;
}

function timestampMs(value) {
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : 0;
}
