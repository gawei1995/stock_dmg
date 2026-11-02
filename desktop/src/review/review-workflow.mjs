import { reviewDayRange } from "./review-calendar.mjs";

/** Re-selection may change activity bounds, never the saved event identity. */
export function catalystSelectionRange({ activityStartAt, activityEndAt, eventMetadata, catalystAt = null } = {}) {
  const activityStart = Date.parse(activityStartAt);
  const activityEnd = Date.parse(activityEndAt);
  if (!Number.isFinite(activityStart) || !Number.isFinite(activityEnd) || activityEnd < activityStart) throw new Error("订单活动区间无效。");
  const eventRange = reviewDayRange(eventMetadata?.eventDate, eventMetadata?.timezone);
  const exact = eventMetadata?.timePrecision === "exact" ? Date.parse(eventMetadata.eventAt ?? catalystAt) : null;
  if (eventMetadata?.timePrecision === "exact" && !Number.isFinite(exact)) throw new Error("精确财报事件缺少有效时间。");
  return {
    startAt: new Date(Math.min(activityStart, exact ?? Date.parse(eventRange.startAt))).toISOString(),
    endAt: new Date(Math.max(activityEnd, exact ?? Date.parse(eventRange.endAt))).toISOString(),
    timezone: eventRange.timezone,
  };
}

/** Only host-resolved records/events are accepted here; no current holdings. */
export function buildEarningsOrderFirstCycle({ selection, benchmark = "QQQ.US", title = "" } = {}) {
  const event = selection?.event;
  const symbols = [...new Set((selection?.relatedSymbols ?? []).map(value => String(value).trim().toUpperCase()).filter(Boolean))];
  if (!selection?.recordIds?.length || !event?.eventCandidateId || !symbols.includes(event.symbol)) {
    throw new Error("请先从真实订单中明确选择匹配的财报事件。");
  }
  const activityStart = Date.parse(selection.activityStartAt);
  const activityEnd = Date.parse(selection.activityEndAt);
  if (!Number.isFinite(activityStart) || !Number.isFinite(activityEnd) || activityEnd < activityStart) throw new Error("订单活动区间无效。");
  const precision = ["exact", "session", "date"].includes(event.eventTimePrecision) ? event.eventTimePrecision : "date";
  const eventRange = reviewDayRange(event.eventDate, event.timezone);
  const exact = precision === "exact" ? Date.parse(event.eventAt) : null;
  if (precision === "exact" && !Number.isFinite(exact)) throw new Error("精确财报事件缺少有效时间。");
  const startMs = Math.min(activityStart, exact ?? Date.parse(eventRange.startAt));
  const endMs = Math.max(activityEnd, exact ?? Date.parse(eventRange.endAt));
  return {
    type: "catalyst", reviewMode: "lightweight", eventKind: "earnings",
    title: String(title).trim().slice(0, 160) || `${event.symbol} · ${event.fiscalQuarter || "财报"} 复盘`,
    scope: symbols.length === 1 ? "single_symbol" : "symbol_set", symbols,
    benchmark, timezone: eventRange.timezone,
    startAt: new Date(startMs).toISOString(), endAt: new Date(endMs).toISOString(),
    catalystAt: exact == null ? null : new Date(exact).toISOString(),
    eventMetadata: {
      eventCandidateId: event.eventCandidateId, symbol: event.symbol,
      eventDate: eventRange.date, eventAt: exact == null ? null : new Date(exact).toISOString(),
      timePrecision: precision, session: event.eventSession ?? "unknown",
      fiscalQuarter: event.fiscalQuarter ?? null, timezone: eventRange.timezone,
      source: event.source ?? "Longbridge finance_calendar",
    },
    description: precision === "exact"
      ? "范围来自所选订单活动与已确认财报时点；当时判断以事后回忆记录，不生成事前封存。"
      : "范围来自所选订单活动与财报日期的当地整日区间；整日边界仅定义复盘范围，不代表财报发生时间。精确财报时点未核验。",
  };
}

export function legacyReviewWriteError(message = "旧财报案例已改为只读历史；请预览迁移到复盘周期，再编辑订单关联或开始新分析。") {
  return Object.assign(new Error(message), { code: "LEGACY_REVIEW_READ_ONLY", kind: "legacy_review_read_only" });
}

/** Never guess links for an unbound legacy case from the current account. */
export function legacyCaseBrokerMatches(reviewCase, archive) {
  const scope = reviewCase?.brokerLinks?.accountScopeId;
  const matches = Boolean(scope && scope === archive?.accountScopeId);
  const selectedOrders = new Set(reviewCase?.brokerLinks?.orderIds ?? []);
  const selectedExecutions = new Set(reviewCase?.brokerLinks?.executionIds ?? []);
  const orders = matches ? (archive.orders ?? []).filter(item => selectedOrders.has(item.orderId)) : [];
  const executions = matches ? (archive.executions ?? []).filter(item => selectedExecutions.has(item.tradeId)) : [];
  return {
    orders, executions, recordIds: [...orders.map(item => item.orderId), ...executions.map(item => item.tradeId)],
    confirmed: matches && Boolean(reviewCase?.brokerLinks?.confirmedAt),
    accountScopeStatus: matches ? "matched" : scope ? "mismatch" : "legacy_unbound",
    readOnly: true,
  };
}
