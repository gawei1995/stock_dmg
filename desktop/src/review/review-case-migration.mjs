import { createHash } from "node:crypto";
import { reviewDayRange } from "./review-calendar.mjs";

const MAX_RECORDS = 5_000;

/** Pure preparation only: the host resolves the legacy selection from its scoped archive. */
export function buildLegacyCaseMigration({ reviewCase, selection, accountScopeId, now = new Date(), existingCycles = [] } = {}) {
  const sourceCaseId = requiredId(reviewCase?.id, "旧案例 ID 无效。");
  const scope = requiredScope(accountScopeId);
  if (requiredScope(reviewCase?.brokerLinks?.accountScopeId) !== scope) {
    throw new Error("旧案例与当前账户作用域不符，不能跨账户迁移。");
  }
  const existing = existingCycles.find((item) => (
    item?.legacySource?.sourceCaseId === sourceCaseId && item.legacySource.accountScopeId === scope
  ));
  // Opening an already migrated cycle does not require reconstructing evidence
  // from an archive that may since have expired. It never creates another sample.
  if (existing) {
    const migration = {
      preview: previewFor(existing, existing.brokerLinks, existing.legacySource, ["该旧案例已迁移；打开既有周期，不重新创建或覆盖。"], existing.id),
      cycle: null,
      links: null,
      legacySource: structuredClone(existing.legacySource),
    };
    return signedMigration(migration);
  }
  if (requiredScope(selection?.accountScopeId) !== scope) throw new Error("解析的订单证据与当前账户作用域不符。");
  const selectedIds = legacyRecordIds(reviewCase.brokerLinks);
  if (!selectedIds.length) throw new Error("旧案例没有已关联订单或成交，不能迁移。");
  const records = validateSelection(selection, selectedIds, scope);
  const recordIds = records.map((item) => item.recordId).sort();
  const timestamps = records.map((item) => item.occurredAt).sort();
  let startAt = timestamps[0];
  let endAt = timestamps.at(-1);
  const symbols = [...new Set(records.map((item) => item.symbol))].sort();
  if (symbols.length !== 1 || symbols[0] !== String(reviewCase.symbol ?? "").trim().toUpperCase()) {
    throw new Error("旧案例标的与所选订单证据不一致。");
  }
  const metadata = normalizeReviewEventMetadata({
    ...reviewCase.eventMetadata,
    symbol: reviewCase.symbol,
    eventAt: reviewCase.eventAt,
    eventDate: reviewCase.eventDate,
    timePrecision: reviewCase.eventTimePrecision ?? reviewCase.eventMetadata?.timePrecision ?? "date",
    session: reviewCase.eventSession,
    fiscalQuarter: reviewCase.fiscalQuarter,
    timezone: reviewCase.timezone,
  });
  const limitations = ["迁移只建立轻量复盘草稿；旧封存和旧结果仅保留来源引用，不等于新周期已完成分析。", "旧判断为历史记录，需本人确认事后回忆并补充感悟与未来验证假设。"];
  const cycleType = metadata.eventDate ? "catalyst" : "trade_window";
  if (metadata.eventDate) {
    const range = metadata.eventAt ? { startAt: metadata.eventAt, endAt: metadata.eventAt } : reviewEventDayRange(metadata);
    startAt = [startAt, range.startAt].sort()[0];
    endAt = [endAt, range.endAt].sort().at(-1);
    limitations.push("周期范围覆盖原选订单及事件日期；日期边界仅表示观察区间，不是财报发布时间。");
  }
  if (!metadata.eventDate) limitations.push("缺少真实财报日期，按原订单区间迁移；不补造财报时点。");
  if (metadata.timePrecision !== "exact") limitations.push("财报仅有日期/时段精度，不填造午夜时间，不能用于精确事前时点评分。");
  const sourceHash = digest({
    reviewCase,
    associationVersions: reviewCase.brokerLinkVersions ?? [],
    selection: { accountScopeId: scope, requestedRecordIds: selectedIds, records },
  });
  const legacySource = normalizeLegacySource({
    sourceCaseId, sourceHash, accountScopeId: scope,
    migratedAt: iso(now, "迁移时间无效。"),
    associationVersions: reviewCase.brokerLinkVersions ?? [],
    originalJudgment: reviewCase.exAnteDraft ?? {},
    sealedVersionReferences: (reviewCase.exAnteVersions ?? []).map((item) => ({
      version: item.version ?? null, hash: item.hash ?? null, sealedAt: item.sealedAt ?? null,
      knowledgeCutoffAt: item.knowledgeCutoffAt ?? null, snapshotHash: digest(item.snapshot ?? {}),
    })),
    resultReferences: ["outcome", "review"].filter((kind) => reviewCase[kind] != null).map((kind) => ({
      kind, sourceCaseId, hash: digest(reviewCase[kind]), updatedAt: reviewCase.updatedAt ?? null,
    })),
    sampleSourceIdentity: `case:${sourceCaseId}`,
  });
  const cycle = {
    cycleType, reviewMode: "lightweight", title: String(reviewCase.title || `${symbols[0]} ${reviewCase.fiscalQuarter || "旧案例"} 复盘`).slice(0, 160),
    symbols, scope: "single_symbol", benchmark: reviewCase.benchmark ?? "QQQ.US", startAt, endAt,
    catalystAt: cycleType === "catalyst" ? metadata.eventAt : null,
    eventKind: cycleType === "catalyst" ? "earnings" : null,
    eventMetadata: metadata, timezone: metadata.timezone,
    retrospectiveNote: { recalledJudgment: reviewCase.exAnteDraft?.myView ?? reviewCase.exAnteDraft?.thesis ?? null, lesson: null, forwardHypothesis: null },
  };
  const links = {
    accountScopeId: scope, requestedRecordIds: selectedIds, recordIds,
    orderIds: recordIds.filter((id) => id.startsWith("order:")).map((id) => id.slice(6)),
    executionIds: recordIds.filter((id) => id.startsWith("execution:")).map((id) => id.slice(10)),
    records,
    reason: `从旧案例 ${sourceCaseId} 显式迁移原关联证据`,
  };
  return signedMigration({ preview: previewFor(cycle, links, legacySource, limitations), cycle, links, legacySource });
}

/** Host-produced payload integrity and stale-preview check, before any store mutation. */
export function assertLegacyCaseMigration(migration, expectedSourceHash) {
  if (!migration || migration.integrityHash !== digest(migrationPayload(migration))) throw new Error("迁移预览内容已变化，请重新预览。");
  const source = normalizeLegacySource(migration.legacySource);
  if (!source || source.sourceHash !== expectedSourceHash || migration.preview?.sourceHash !== expectedSourceHash) {
    throw new Error("旧案例或订单证据已变化，请重新预览后确认迁移。");
  }
  if (migration.preview.sourceCaseId !== source.sourceCaseId) throw new Error("迁移来源身份不一致。");
  if (migration.links && migration.links.accountScopeId !== source.accountScopeId) throw new Error("迁移证据账户不一致。");
  return source;
}

/** Precision is explicit. Date/session observations never become fabricated timestamps. */
export function normalizeReviewEventMetadata(value = {}, fallback = {}) {
  const input = { ...fallback, ...(value ?? {}) };
  const timezone = text(input.timezone, 80) || "America/New_York";
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0); } catch { throw new Error("事件时区无效。"); }
  const rawAt = input.eventAt ?? input.catalystAt;
  const precision = input.timePrecision ?? input.eventTimePrecision ?? (rawAt ? "exact" : "date");
  if (!["exact", "session", "date"].includes(precision)) throw new Error("事件日期精度无效。");
  const eventAt = precision === "exact" && rawAt != null ? exactIso(rawAt) : null;
  const eventDate = validDate(input.eventDate) ?? (eventAt ? dateInZone(eventAt, timezone) : null);
  if (input.eventDate != null && !validDate(input.eventDate)) throw new Error("事件日期无效。");
  if (eventAt && eventDate !== dateInZone(eventAt, timezone)) throw new Error("事件日期与精确时间、时区不一致。");
  const session = input.session ?? input.eventSession ?? "unknown";
  if (!["bmo", "amc", "intraday", "unknown"].includes(session)) throw new Error("事件交易时段无效。");
  return {
    symbol: text(input.symbol, 100)?.toUpperCase() ?? null,
    eventDate, eventAt, timePrecision: precision, session,
    fiscalQuarter: text(input.fiscalQuarter, 80), timezone,
    source: text(input.source, 500), status: text(input.status, 80), confidence: text(input.confidence, 80),
    eventCandidateId: text(input.eventCandidateId, 200),
  };
}

export function normalizeLegacySource(value) {
  if (value == null) return null;
  const sourceCaseId = requiredId(value.sourceCaseId, "迁移来源案例 ID 无效。");
  const sourceHash = String(value.sourceHash ?? "");
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error("迁移来源指纹无效。");
  const accountScopeId = requiredScope(value.accountScopeId);
  const payload = {
    sourceCaseId, sourceHash, accountScopeId, migratedAt: iso(value.migratedAt, "迁移时间无效。"),
    associationVersions: jsonCopy(value.associationVersions ?? []),
    originalJudgment: jsonCopy(value.originalJudgment ?? {}),
    sealedVersionReferences: jsonCopy(value.sealedVersionReferences ?? []),
    resultReferences: jsonCopy(value.resultReferences ?? []),
    sampleSourceIdentity: `case:${sourceCaseId}`,
  };
  if (!Array.isArray(payload.associationVersions) || !Array.isArray(payload.sealedVersionReferences) || !Array.isArray(payload.resultReferences)
    || !payload.originalJudgment || Array.isArray(payload.originalJudgment) || typeof payload.originalJudgment !== "object") {
    throw new Error("迁移来源证据结构无效。");
  }
  if (payload.associationVersions.some((item) => item?.accountScopeId && item.accountScopeId !== accountScopeId)) throw new Error("旧关联版本包含其他账户，不能合并迁移。");
  return payload;
}

export function reviewEventDayRange(metadata) {
  const range = reviewDayRange(metadata.eventDate, metadata.timezone);
  if (range.timezone !== metadata.timezone) throw new Error("该事件时区尚不支持精确日期边界，已停止迁移或重选；不会静默改用其他时区。");
  return range;
}

function validateSelection(selection, selectedIds, scope) {
  if (!Array.isArray(selection.records) || !selection.records.length || selection.records.length > MAX_RECORDS) throw new Error("旧案例选择记录缺失或超过迁移上限。");
  const requested = selection.requestedRecordIds ?? selectedIds;
  if (stable([...new Set(requested)].sort()) !== stable(selectedIds)) throw new Error("解析的选择不是旧案例已选订单，禁止用当前持仓或新选择重建。");
  const records = selection.records.map((raw) => {
    const recordId = String(raw?.recordId ?? raw?.id ?? "");
    if (!/^(order|execution):.+$/.test(recordId)) throw new Error("订单记录身份无效。");
    const kind = recordId.startsWith("order:") ? "order" : "execution";
    if (raw.kind && raw.kind !== kind) throw new Error("订单记录类型不一致。");
    if (raw.accountScopeId && raw.accountScopeId !== scope) throw new Error("订单记录属于其他账户。");
    const symbol = text(raw.symbol, 100)?.toUpperCase();
    if (!symbol) throw new Error("订单记录缺少标的。");
    return { ...jsonCopy(raw), recordId, kind, symbol, occurredAt: iso(raw.occurredAt ?? raw.activityAt ?? raw.at, "订单记录缺少真实交易时间。") };
  }).sort((a, b) => a.recordId.localeCompare(b.recordId));
  const ids = records.map((item) => item.recordId);
  if (new Set(ids).size !== ids.length) throw new Error("解析的订单记录身份重复。");
  if (selectedIds.some((id) => !ids.includes(id))) throw new Error("旧案例选择记录缺失，请先恢复历史订单归档。");
  if (selection.recordIds && stable([...new Set(selection.recordIds)].sort()) !== stable([...ids].sort())) throw new Error("选择记录清单与已解析证据不一致。");
  return records;
}

function legacyRecordIds(links) {
  return [...new Set([
    ...(links?.orderIds ?? []).map((id) => `order:${String(id).replace(/^order:/, "")}`),
    ...(links?.executionIds ?? []).map((id) => `execution:${String(id).replace(/^execution:/, "")}`),
  ])].sort();
}
function previewFor(cycle, links, source, limitations, existingCycleId = null) {
  return {
    sourceCaseId: source.sourceCaseId, sourceHash: source.sourceHash, title: cycle.title,
    cycleType: cycle.cycleType, symbols: structuredClone(cycle.symbols), startAt: cycle.startAt, endAt: cycle.endAt,
    recordCount: links?.recordIds?.length ?? 0, orderCount: links?.orderIds?.length ?? 0, executionCount: links?.executionIds?.length ?? 0,
    limitations, existingCycleId,
  };
}
function signedMigration(value) { return { ...value, integrityHash: digest(value) }; }
function migrationPayload(value) { const { integrityHash: _, ...payload } = value; return payload; }
function text(value, limit) { return value == null ? null : String(value).trim().slice(0, limit) || null; }
function requiredId(value, message) { const id = text(value, 200); if (!id) throw new Error(message); return id; }
function requiredScope(value) { const scope = String(value ?? "").trim(); if (!/^[A-Za-z0-9._:-]{8,160}$/.test(scope)) throw new Error("账户尚未绑定有效作用域，不能迁移旧案例。"); return scope; }
function iso(value, message) { const millis = value instanceof Date ? value.getTime() : Date.parse(String(value ?? "")); if (!Number.isFinite(millis)) throw new Error(message); return new Date(millis).toISOString(); }
function exactIso(value) { if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/.test(String(value))) throw new Error("精确事件时间需要真实时分和时区，不能用日期补午夜。"); return iso(value, "精确事件时间无效。"); }
function validDate(value) { const date = String(value ?? ""); return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date ? date : null; }
function dateInZone(value, timezone) { return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)); }
function jsonCopy(value) { const serialized = JSON.stringify(value); if (serialized.length > 2_000_000) throw new Error("旧案例证据过大，迁移已停止。"); return JSON.parse(serialized); }
function digest(value) { return createHash("sha256").update(stable(value)).digest("hex"); }
function stable(value) { if (value === undefined) return "null"; if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`; return JSON.stringify(value); }
