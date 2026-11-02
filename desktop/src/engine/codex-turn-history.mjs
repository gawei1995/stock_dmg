const DEFAULT_BUDGET_MS = 5_000;

/** Read a whole turn under one deadline, never labelling a paged prefix complete. */
export async function readCodexTurnItems(rpc, threadId, turnId, {
  budgetMs = DEFAULT_BUDGET_MS,
  maxPages = 20,
} = {}) {
  const deadlineAt = Date.now() + Math.max(1, Number(budgetMs) || DEFAULT_BUDGET_MS);
  const items = [];
  const seenItemIds = new Set();
  const seenCursors = new Set();
  let cursor = null;
  let reason = "history_unavailable";
  let hasUnverifiedPrefix = false;
  const request = async (method, params) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Error("history_budget_exhausted");
    let timer;
    try {
      return await Promise.race([
        rpc.request(method, params, { timeoutMs: remaining }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("history_budget_exhausted")), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    for (let page = 0; page < maxPages; page += 1) {
      const response = await request("thread/items/list", {
        threadId, turnId, cursor, limit: 200, sortDirection: "asc",
      });
      const entries = Array.isArray(response?.data) ? response.data : [];
      for (const entry of entries) {
        if (String(entry?.turnId ?? turnId) !== String(turnId) || !entry?.item) continue;
        const id = entry.item.id == null ? null : String(entry.item.id);
        if (id && seenItemIds.has(id)) continue;
        if (id) seenItemIds.add(id);
        items.push(entry.item);
      }
      cursor = response?.nextCursor ?? null;
      if (!cursor) {
        if (items.length) return { items, complete: true, reason: null, hasUnverifiedPrefix: false };
        break;
      }
      hasUnverifiedPrefix = true;
      if (!entries.length || seenCursors.has(String(cursor))) {
        reason = "history_pagination_invalid";
        break;
      }
      seenCursors.add(String(cursor));
      reason = "history_page_limit";
    }
  } catch (error) {
    reason = Date.now() >= deadlineAt || error?.message === "history_budget_exhausted"
      ? "history_budget_exhausted" : "history_pagination_unavailable";
  }

  // Only spend the remainder of the same budget on the compatibility fallback.
  if (Date.now() < deadlineAt) {
    try {
      const response = await request("thread/turns/list", {
        threadId, limit: 12, sortDirection: "desc", itemsView: "full",
      });
      const turn = (response?.data ?? []).find((entry) => String(entry?.id ?? "") === String(turnId));
      if (Array.isArray(turn?.items) && turn.items.length) {
        return { items: turn.items, complete: true, reason: null, hasUnverifiedPrefix: false };
      }
    } catch (error) {
      if (Date.now() >= deadlineAt || error?.message === "history_budget_exhausted") {
        reason = "history_budget_exhausted";
      }
    }
  }
  return { items, complete: false, reason, hasUnverifiedPrefix };
}
