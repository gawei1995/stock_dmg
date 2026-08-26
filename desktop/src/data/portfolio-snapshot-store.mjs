import { createHash, randomUUID } from "node:crypto";

const STORE_KEY = "portfolioSnapshotLedgerV2";
const SCHEMA_VERSION = 2;
const GENESIS_HASH = "0".repeat(64);
const DEFAULT_MAX_SNAPSHOTS = 12_000;
const DEFAULT_MAX_SERIALIZED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_HOLDINGS = 2_000;
const SNAPSHOT_KINDS = new Set(["eod", "post_trade", "manual"]);
const QUALITY_STATUSES = new Set(["complete", "partial", "degraded", "unavailable"]);
const FX_STATUSES = new Set(["complete", "partial", "unavailable", "not_required"]);
const VALUATION_SESSIONS = new Set([
  "regular",
  "regular_close",
  "pre_market",
  "post_market",
  "overnight",
  "mixed",
  "unknown",
]);
const TOTAL_ASSET_BASES = new Set([
  "broker_observed",
  "capture_cash_plus_regular_close_positions",
]);
export const REGULAR_CLOSE_VALUATION_METHOD_VERSION = "regular-close-v2";
const CREDENTIAL_KEYS = new Set([
  "accesstoken",
  "refreshtoken",
  "token",
  "apikey",
  "apisecret",
  "secret",
  "password",
  "authorization",
  "cookie",
  "credential",
  "credentials",
]);

/**
 * Append-only portfolio snapshots persisted through the encrypted desktop store.
 *
 * The supplied store is expected to be EncryptedStore (or an equivalent test
 * double). This module never writes a plaintext fallback and refuses writes
 * unless the backing store explicitly reports that encryption is available.
 */
export class PortfolioSnapshotStore {
  constructor({
    store,
    now = () => new Date(),
    idFactory = randomUUID,
    maxSnapshots = DEFAULT_MAX_SNAPSHOTS,
    maxSerializedBytes = DEFAULT_MAX_SERIALIZED_BYTES,
    maxHoldings = DEFAULT_MAX_HOLDINGS,
  } = {}) {
    if (!store?.get || !store?.set) {
      throw new Error("组合快照账本需要加密存储接口。");
    }
    this.store = store;
    this.now = now;
    this.idFactory = idFactory;
    this.maxSnapshots = positiveInteger(maxSnapshots, "快照容量无效。");
    this.maxSerializedBytes = positiveInteger(maxSerializedBytes, "账本容量无效。");
    this.maxHoldings = positiveInteger(maxHoldings, "持仓容量无效。");
    this.queue = Promise.resolve();
  }

  /** Appends one immutable snapshot or returns the existing idempotent entry. */
  async appendSnapshot(input) {
    return this.#enqueue(async () => {
      this.#assertEncryptedPersistence();
      assertNoCredentialFields(input);
      const loaded = await this.#loadVerified();
      const normalized = normalizeSnapshotInput(input, {
        maxHoldings: this.maxHoldings,
      });
      const existing = loaded.ledger.snapshots.find(
        (item) => item.accountScope.scopeId === normalized.accountScope.scopeId
          && item.idempotencyKey === normalized.idempotencyKey,
      );
      if (existing) {
        const comparable = snapshotComparable(existing);
        if (stableStringify(comparable) !== stableStringify(normalized)) {
          throw new Error("相同幂等键对应了不同的组合快照，已拒绝覆盖历史。");
        }
        return { appended: false, snapshot: structuredClone(existing) };
      }
      const valuationMethodVersion = normalized.kind === "eod"
        ? normalized.valuation?.methodVersion
        : null;
      if (valuationMethodVersion) {
        const existingValuation = loaded.ledger.snapshots.find((item) => (
          item.kind === "eod"
          && item.accountScope.scopeId === normalized.accountScope.scopeId
          && item.tradingDate === normalized.tradingDate
          && item.valuation?.methodVersion === valuationMethodVersion
        ));
        if (existingValuation) {
          throw new Error("同一账户范围、交易日和收盘估值版本已存在组合快照，已拒绝重复写入。");
        }
      }
      if (loaded.ledger.snapshots.length >= this.maxSnapshots) {
        throw new Error("组合快照账本已达到容量上限；不会自动删除历史快照。");
      }

      const recordedAt = requiredIso(this.now(), "系统记录时间无效。");
      const previousHash = loaded.ledger.headHash || GENESIS_HASH;
      const snapshotId = requiredId(this.idFactory(), "快照 ID 无效。");
      if (loaded.ledger.snapshots.some((item) => item.snapshotId === snapshotId)) {
        throw new Error("快照 ID 已存在，未覆盖历史快照。");
      }
      const entry = {
        schemaVersion: SCHEMA_VERSION,
        snapshotId,
        sequence: loaded.ledger.snapshots.length + 1,
        recordedAt,
        ...normalized,
      };
      entry.integrity = sealEntry(entry, previousHash);
      const snapshots = [...loaded.ledger.snapshots, entry];
      const ledger = sealLedger({
        schemaVersion: SCHEMA_VERSION,
        createdAt: loaded.ledger.createdAt ?? recordedAt,
        updatedAt: recordedAt,
        migratedFromVersion: loaded.migrated ? loaded.fromVersion : loaded.ledger.migratedFromVersion,
        snapshots,
        headHash: entry.integrity.entryHash,
      });
      this.#assertCapacity(ledger);
      await this.store.set(STORE_KEY, ledger);
      return { appended: true, snapshot: structuredClone(entry) };
    });
  }

  async append(input) {
    return this.appendSnapshot(input);
  }

  async getSnapshot(snapshotId) {
    const id = cleanId(snapshotId);
    if (!id) return null;
    const { ledger } = await this.#loadVerified();
    const found = ledger.snapshots.find((item) => item.snapshotId === id);
    return found ? structuredClone(found) : null;
  }

  async listSnapshots(filters = {}) {
    const { ledger } = await this.#loadVerified();
    return filterSnapshots(ledger.snapshots, filters).map((item) => structuredClone(item));
  }

  async latestSnapshot(filters = {}) {
    const snapshots = await this.listSnapshots({ ...filters, order: "desc", limit: 1 });
    return snapshots[0] ?? null;
  }

  /** Finds the nearest observation without manufacturing a boundary snapshot. */
  async findNearestSnapshot({
    at,
    direction = "at_or_before",
    maxDistanceMs = null,
    ...filters
  } = {}) {
    const scopeId = requiredId(filters.scopeId, "最近快照查询必须指定账户范围。");
    const targetAt = Date.parse(requiredIso(at, "查询时间无效。"));
    if (!["at_or_before", "at_or_after", "either"].includes(direction)) {
      throw new Error("最近快照查询方向无效。");
    }
    const maxDistance = maxDistanceMs == null
      ? null
      : nonNegativeNumber(maxDistanceMs, "最近快照最大距离无效。");
    const snapshots = await this.listSnapshots({ ...filters, scopeId, order: "asc", limit: this.maxSnapshots });
    const candidates = snapshots.filter((item) => {
      const capturedAt = Date.parse(item.capturedAt);
      if (direction === "at_or_before") return capturedAt <= targetAt;
      if (direction === "at_or_after") return capturedAt >= targetAt;
      return true;
    });
    candidates.sort((left, right) => {
      const leftDelta = Math.abs(Date.parse(left.capturedAt) - targetAt);
      const rightDelta = Math.abs(Date.parse(right.capturedAt) - targetAt);
      if (leftDelta !== rightDelta) return leftDelta - rightDelta;
      // At an equal distance, prefer the observation already known at cutoff.
      return Date.parse(left.capturedAt) - Date.parse(right.capturedAt);
    });
    const nearest = candidates[0] ?? null;
    if (!nearest) return null;
    if (maxDistance != null && Math.abs(Date.parse(nearest.capturedAt) - targetAt) > maxDistance) {
      return null;
    }
    return nearest;
  }

  /**
   * Returns actual snapshots around a UTC period. openingBaseline may predate
   * the period; firstWithin/lastWithin are never synthesized.
   */
  async queryPeriod({ startAt, endAt, includeSnapshots = true, ...filters } = {}) {
    const scopeId = requiredId(filters.scopeId, "复盘周期查询必须指定账户范围。");
    const start = requiredIso(startAt, "复盘周期起点无效。");
    const end = requiredIso(endAt, "复盘周期终点无效。");
    if (Date.parse(start) > Date.parse(end)) throw new Error("复盘周期起点不能晚于终点。");
    const all = await this.listSnapshots({ ...filters, scopeId, order: "asc", limit: this.maxSnapshots });
    const within = all.filter((item) => item.capturedAt >= start && item.capturedAt <= end);
    const beforeOrAtStart = all.filter((item) => item.capturedAt <= start).at(-1) ?? null;
    const beforeOrAtEnd = all.filter((item) => item.capturedAt <= end).at(-1) ?? null;
    const firstWithin = within[0] ?? null;
    const lastWithin = within.at(-1) ?? null;
    return structuredClone({
      startAt: start,
      endAt: end,
      openingBaseline: beforeOrAtStart,
      closingBaseline: beforeOrAtEnd,
      firstWithin,
      lastWithin,
      latestWithin: lastWithin,
      snapshots: includeSnapshots ? within : [],
      coverage: periodCoverage({
        count: within.length,
        openingBaseline: beforeOrAtStart,
        firstWithin,
        lastWithin,
      }),
    });
  }

  /** Queries by the stored exchange/account trading date, including month views. */
  async queryTradingPeriod({
    startTradingDate,
    endTradingDate,
    includeSnapshots = true,
    ...filters
  } = {}) {
    const scopeId = requiredId(filters.scopeId, "交易周期查询必须指定账户范围。");
    const start = requiredDate(startTradingDate, "交易日起点无效。");
    const end = requiredDate(endTradingDate, "交易日终点无效。");
    if (start > end) throw new Error("交易日起点不能晚于终点。");
    const all = await this.listSnapshots({ ...filters, scopeId, order: "asc", limit: this.maxSnapshots });
    const within = all.filter((item) => item.tradingDate >= start && item.tradingDate <= end);
    const openingBaseline = all.filter((item) => item.tradingDate < start).at(-1) ?? null;
    const first = within[0] ?? null;
    const last = within.at(-1) ?? null;
    return structuredClone({
      startTradingDate: start,
      endTradingDate: end,
      openingBaseline,
      firstWithin: first,
      lastWithin: last,
      latestWithin: last,
      snapshots: includeSnapshots ? within : [],
      coverage: periodCoverage({ count: within.length, openingBaseline, firstWithin: first, lastWithin: last }),
    });
  }

  async queryMonth({ month, ...filters } = {}) {
    const value = String(month ?? "").trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error("复盘月份无效。");
    return this.queryTradingPeriod({
      ...filters,
      startTradingDate: `${value}-01`,
      endTradingDate: `${value}-31`,
    });
  }

  /** Checks the complete chain and envelope without returning untrusted facts. */
  async verifyIntegrity() {
    const raw = await this.store.get(STORE_KEY);
    if (raw == null) return { valid: true, recordCount: 0, headHash: GENESIS_HASH, issues: [] };
    const migrated = migrateLedger(raw, { now: this.now, maxHoldings: this.maxHoldings });
    const result = verifyLedger(migrated.ledger);
    return { ...result, migrated: migrated.migrated, fromVersion: migrated.fromVersion };
  }

  /** Persists a supported legacy ledger as V2; no market facts are inferred. */
  async migrate() {
    return this.#enqueue(async () => {
      this.#assertEncryptedPersistence();
      const raw = await this.store.get(STORE_KEY);
      if (raw == null) return { migrated: false, fromVersion: null, recordCount: 0 };
      const loaded = migrateLedger(raw, { now: this.now, maxHoldings: this.maxHoldings });
      const verification = verifyLedger(loaded.ledger);
      if (!verification.valid) throw integrityError(verification);
      if (loaded.migrated) {
        this.#assertCapacity(loaded.ledger);
        await this.store.set(STORE_KEY, loaded.ledger);
      }
      return {
        migrated: loaded.migrated,
        fromVersion: loaded.fromVersion,
        recordCount: loaded.ledger.snapshots.length,
      };
    });
  }

  async capacity() {
    const { ledger } = await this.#loadVerified();
    const serializedBytes = Buffer.byteLength(JSON.stringify(ledger), "utf8");
    return {
      snapshotCount: ledger.snapshots.length,
      maxSnapshots: this.maxSnapshots,
      remainingSnapshots: Math.max(0, this.maxSnapshots - ledger.snapshots.length),
      serializedBytes,
      maxSerializedBytes: this.maxSerializedBytes,
    };
  }

  #enqueue(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  #assertEncryptedPersistence() {
    if (this.store.persistent !== true) {
      throw new Error("系统加密存储不可用，组合快照未写入磁盘。");
    }
  }

  async #loadVerified() {
    const raw = await this.store.get(STORE_KEY);
    const loaded = migrateLedger(raw, { now: this.now, maxHoldings: this.maxHoldings });
    const verification = verifyLedger(loaded.ledger);
    if (!verification.valid) throw integrityError(verification);
    return loaded;
  }

  #assertCapacity(ledger) {
    if (ledger.snapshots.length > this.maxSnapshots) {
      throw new Error("组合快照账本超过快照容量上限。");
    }
    if (Buffer.byteLength(JSON.stringify(ledger), "utf8") > this.maxSerializedBytes) {
      throw new Error("组合快照账本超过加密存储容量上限；不会自动删除历史快照。");
    }
  }
}

export const PORTFOLIO_SNAPSHOT_STORE_KEY = STORE_KEY;
export const PORTFOLIO_SNAPSHOT_SCHEMA_VERSION = SCHEMA_VERSION;
export const PORTFOLIO_SNAPSHOT_KINDS = Object.freeze([...SNAPSHOT_KINDS]);

function normalizeSnapshotInput(input, { maxHoldings }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("组合快照内容无效。");
  }
  const kind = enumValue(input.kind, SNAPSHOT_KINDS, "快照类型无效。");
  const capturedAt = requiredIso(input.capturedAt, "快照时间无效。");
  const timezone = requiredTimezone(input.timezone);
  const tradingDate = localDate(capturedAt, timezone);
  if (input.tradingDate != null && requiredDate(input.tradingDate, "交易日无效。") !== tradingDate) {
    throw new Error("交易日与快照时间及其时区不一致。");
  }
  const accountScope = normalizeAccountScope(input.accountScope);
  const summary = normalizeSummary(input.summary);
  const holdings = normalizeHoldings(input.holdings, maxHoldings);
  const accountRefs = new Set(accountScope.accounts.map((item) => item.accountRef));
  if (holdings.some((item) => !accountRefs.has(item.accountRef))) {
    throw new Error("持仓摘要引用了账户范围之外的账户。");
  }
  const provenance = normalizeProvenance(input.provenance, capturedAt);
  const valuation = normalizeValuation(input.valuation, { kind, capturedAt });
  const fx = normalizeFx(input.fx, summary.reportingCurrency);
  const dataQuality = normalizeDataQuality(input.dataQuality, {
    holdings,
    reportingCurrency: summary.reportingCurrency,
    fx,
    valuation,
    provenance,
  });
  return {
    idempotencyKey: requiredIdempotencyKey(input.idempotencyKey),
    kind,
    capturedAt,
    timezone,
    tradingDate,
    accountScope,
    summary: { ...summary, positionCount: holdings.length },
    holdings,
    dataQuality,
    fx,
    valuation,
    provenance,
    note: cleanText(input.note, 1_000),
  };
}

function normalizeValuation(value, { kind, capturedAt }) {
  const source = value && typeof value === "object" ? value : {};
  const quoteAsOf = optionalIso(source.quoteAsOf, "最早估值行情时间无效。");
  const quoteLatestAsOf = optionalIso(source.quoteLatestAsOf, "最晚估值行情时间无效。");
  if (quoteAsOf && quoteLatestAsOf && quoteAsOf > quoteLatestAsOf) {
    throw new Error("最早估值行情时间不能晚于最晚估值行情时间。");
  }
  return {
    session: enumValue(
      source.session ?? "unknown",
      VALUATION_SESSIONS,
      "估值会话无效。",
    ),
    quoteAsOf,
    quoteLatestAsOf,
    observedAt: requiredIso(source.observedAt ?? capturedAt, "估值观察时间无效。"),
    totalAssetsBasis: enumValue(
      source.totalAssetsBasis ?? "broker_observed",
      TOTAL_ASSET_BASES,
      "总资产估值口径无效。",
    ),
    brokerObservedNetAssets: optionalNonNegativeNumber(source.brokerObservedNetAssets),
    afterHoursMarksExcluded: Boolean(source.afterHoursMarksExcluded),
    methodVersion: cleanText(source.methodVersion, 80),
  };
}

function normalizeAccountScope(value) {
  if (!value || typeof value !== "object") throw new Error("账户范围不能为空。");
  const scopeId = requiredId(value.scopeId, "账户范围 ID 无效。");
  const broker = requiredText(value.broker, 80, "券商来源不能为空。");
  const accounts = Array.isArray(value.accounts) ? value.accounts.map((account) => ({
    accountRef: requiredId(account?.accountRef, "账户引用无效。"),
    accountType: cleanText(account?.accountType, 40),
    baseCurrency: optionalCurrency(account?.baseCurrency),
  })) : [];
  if (!accounts.length) throw new Error("账户范围至少需要一个账户引用。");
  accounts.sort((left, right) => left.accountRef.localeCompare(right.accountRef));
  if (new Set(accounts.map((item) => item.accountRef)).size !== accounts.length) {
    throw new Error("账户范围包含重复账户引用。");
  }
  return { scopeId, broker, accounts };
}

function normalizeSummary(value) {
  if (!value || typeof value !== "object") throw new Error("组合汇总不能为空。");
  return {
    reportingCurrency: requiredCurrency(value.reportingCurrency ?? "USD"),
    totalAssets: nonNegativeNumber(value.totalAssets, "总资产无效。"),
    cash: finiteNumber(value.cash, "现金金额无效。"),
    grossExposure: nonNegativeNumber(value.grossExposure, "毛敞口无效。"),
    netExposure: finiteNumber(value.netExposure, "净敞口无效。"),
    longExposure: optionalNonNegativeNumber(value.longExposure),
    shortExposure: optionalNonNegativeNumber(value.shortExposure),
    buyingPower: optionalFiniteNumber(value.buyingPower),
    marginDebt: optionalNonNegativeNumber(value.marginDebt),
  };
}

function normalizeHoldings(value, maxHoldings) {
  if (!Array.isArray(value)) throw new Error("持仓摘要必须是数组。");
  if (value.length > maxHoldings) throw new Error("单次快照的持仓数量超过上限。");
  const holdings = value.map((item) => ({
    accountRef: requiredId(item?.accountRef, "持仓账户引用无效。"),
    symbol: requiredText(item?.symbol, 80, "持仓代码不能为空。").toUpperCase(),
    assetType: cleanText(item?.assetType, 40) ?? "unknown",
    currency: requiredCurrency(item?.currency),
    quantity: finiteNumber(item?.quantity, "持仓数量无效。"),
    marketPrice: optionalNonNegativeNumber(item?.marketPrice),
    marketValue: optionalFiniteNumber(item?.marketValue),
    valueInReportingCurrency: optionalFiniteNumber(item?.valueInReportingCurrency),
    costBasis: optionalFiniteNumber(item?.costBasis),
    unrealizedPnl: optionalFiniteNumber(item?.unrealizedPnl),
    weight: optionalFiniteNumber(item?.weight),
  }));
  holdings.sort((left, right) => (
    `${left.accountRef}\0${left.symbol}\0${left.assetType}`
      .localeCompare(`${right.accountRef}\0${right.symbol}\0${right.assetType}`)
  ));
  const keys = holdings.map((item) => `${item.accountRef}\0${item.symbol}\0${item.assetType}`);
  if (new Set(keys).size !== keys.length) throw new Error("快照包含重复的持仓摘要。");
  return holdings;
}

function normalizeProvenance(value, capturedAt) {
  if (!value || typeof value !== "object") throw new Error("快照数据来源不能为空。");
  return {
    provider: requiredText(value.provider, 80, "数据提供方不能为空。"),
    transport: requiredText(value.transport, 40, "数据传输来源不能为空。"),
    fetchedAt: requiredIso(value.fetchedAt ?? capturedAt, "数据获取时间无效。"),
    sourceSnapshotId: cleanText(value.sourceSnapshotId, 200),
    freshness: enumValue(value.freshness ?? "live", new Set(["live", "cached", "manual"]), "数据新鲜度无效。"),
    cacheAgeMs: value.cacheAgeMs == null ? null : nonNegativeNumber(value.cacheAgeMs, "缓存年龄无效。"),
  };
}

function normalizeFx(value, reportingCurrency) {
  const source = value && typeof value === "object" ? value : {};
  const rates = Array.isArray(source.rates) ? source.rates.map((rate) => ({
    base: requiredCurrency(rate?.base),
    quote: requiredCurrency(rate?.quote),
    rate: positiveNumber(rate?.rate, "汇率无效。"),
    asOf: requiredIso(rate?.asOf, "汇率时间无效。"),
    source: requiredText(rate?.source, 120, "汇率来源不能为空。"),
  })) : [];
  rates.sort((left, right) => `${left.base}/${left.quote}`.localeCompare(`${right.base}/${right.quote}`));
  return {
    reportingCurrency,
    status: enumValue(source.status ?? (rates.length ? "complete" : "not_required"), FX_STATUSES, "汇率状态无效。"),
    source: cleanText(source.source, 120),
    retrievedAt: source.retrievedAt == null ? null : requiredIso(source.retrievedAt, "汇率获取时间无效。"),
    rates,
  };
}

function normalizeDataQuality(value, context) {
  const source = value && typeof value === "object" ? value : {};
  const declaredStatus = enumValue(source.status ?? "partial", QUALITY_STATUSES, "数据质量状态无效。");
  const issues = Array.isArray(source.issues)
    ? source.issues.map(normalizeQualityIssue).filter(Boolean)
    : [];
  const currencies = new Set(context.holdings.map((item) => item.currency));
  currencies.delete(context.reportingCurrency);
  for (const currency of currencies) {
    const covered = context.fx.rates.some((rate) => (
      (rate.base === currency && rate.quote === context.reportingCurrency)
      || (rate.quote === currency && rate.base === context.reportingCurrency)
    ));
    if (!covered) {
      issues.push({
        code: `fx_rate_missing:${currency}`,
        message: `${currency} 缺少到 ${context.reportingCurrency} 的可追溯汇率。`,
        field: "fx.rates",
      });
    }
  }
  if (context.provenance.freshness === "cached") {
    issues.push({
      code: "portfolio_source_cached",
      message: "组合数据来自缓存，不代表本次实时同步。",
      field: "provenance.freshness",
    });
  }
  const uniqueIssues = [...new Map(issues.map((item) => [
    `${item.code}\0${item.field ?? ""}`,
    item,
  ])).values()];
  if (context.holdings.some((item) => (
    item.marketValue == null || item.valueInReportingCurrency == null
  ))) {
    uniqueIssues.push({
      code: "holding_value_missing",
      message: "部分持仓缺少可核验市值；数量仍保留，但组合收益与敞口计算需降级。",
      field: "holdings.valueInReportingCurrency",
    });
  }
  const status = effectiveQualityStatus(declaredStatus, uniqueIssues);
  return {
    declaredStatus,
    status,
    issues: uniqueIssues,
    completeForPeriodReturn: status === "complete" && Boolean(source.completeForPeriodReturn),
  };
}

function effectiveQualityStatus(declaredStatus, issues) {
  if (declaredStatus === "unavailable") return "unavailable";
  if (!issues.length) return declaredStatus;
  if (issues.some((item) => item.code.startsWith("fx_rate_missing:"))) return "degraded";
  return declaredStatus === "complete" ? "partial" : declaredStatus;
}

function normalizeQualityIssue(value) {
  const code = cleanText(value?.code, 120);
  const message = cleanText(value?.message, 500);
  if (!code || !message) return null;
  return { code, message, field: cleanText(value?.field, 160) };
}

function filterSnapshots(snapshots, filters) {
  const scopeId = cleanId(filters.scopeId);
  const accountRef = cleanId(filters.accountRef);
  const kinds = normalizeKinds(filters.kinds);
  const fromAt = filters.fromAt == null ? null : requiredIso(filters.fromAt, "查询起点无效。");
  const toAt = filters.toAt == null ? null : requiredIso(filters.toAt, "查询终点无效。");
  const fromTradingDate = filters.fromTradingDate == null
    ? null
    : requiredDate(filters.fromTradingDate, "交易日起点无效。");
  const toTradingDate = filters.toTradingDate == null
    ? null
    : requiredDate(filters.toTradingDate, "交易日终点无效。");
  const limit = filters.limit == null ? 1_000 : positiveInteger(filters.limit, "查询数量无效。");
  const order = filters.order ?? "desc";
  if (!["asc", "desc"].includes(order)) throw new Error("快照排序方式无效。");
  const result = snapshots.filter((item) => (
    (!scopeId || item.accountScope.scopeId === scopeId)
    && (!accountRef || item.accountScope.accounts.some((account) => account.accountRef === accountRef))
    && (!kinds || kinds.has(item.kind))
    && (!fromAt || item.capturedAt >= fromAt)
    && (!toAt || item.capturedAt <= toAt)
    && (!fromTradingDate || item.tradingDate >= fromTradingDate)
    && (!toTradingDate || item.tradingDate <= toTradingDate)
  ));
  result.sort((left, right) => {
    const delta = Date.parse(left.capturedAt) - Date.parse(right.capturedAt);
    return order === "asc" ? delta || left.sequence - right.sequence : -delta || right.sequence - left.sequence;
  });
  return result.slice(0, Math.min(limit, snapshots.length));
}

function normalizeKinds(value) {
  if (value == null) return null;
  const list = Array.isArray(value) ? value : [value];
  const kinds = new Set(list.map((kind) => enumValue(kind, SNAPSHOT_KINDS, "快照类型无效。")));
  return kinds;
}

function periodCoverage({ count, openingBaseline = null, firstWithin = null, lastWithin = null }) {
  const warnings = [];
  if (!count) warnings.push("period_has_no_snapshot");
  if (!openingBaseline) warnings.push("opening_baseline_missing");
  if (!firstWithin) warnings.push("period_start_snapshot_missing");
  if (!lastWithin) warnings.push("period_end_snapshot_missing");
  const relevantSnapshots = [openingBaseline, firstWithin, lastWithin].filter(Boolean);
  const qualityStatuses = relevantSnapshots
    .filter(Boolean)
    .map((item) => item.dataQuality.status);
  if (qualityStatuses.some((status) => status !== "complete")) warnings.push("snapshot_quality_incomplete");
  const distinctWithinEndpoints = Boolean(firstWithin && lastWithin)
    && firstWithin.snapshotId !== lastWithin.snapshotId;
  const distinctPeriodEndpoints = Boolean(openingBaseline && lastWithin)
    && openingBaseline.snapshotId !== lastWithin.snapshotId;
  const completePeriodEndpoints = distinctPeriodEndpoints
    && [openingBaseline, lastWithin].every((item) => (
      item.dataQuality.status === "complete" && item.dataQuality.completeForPeriodReturn
    ));
  if (completePeriodEndpoints) warnings.push("external_cash_flows_and_fees_not_reconciled");
  return {
    snapshotCount: count,
    canCalculateSnapshotToSnapshotDelta: distinctWithinEndpoints
      && [firstWithin, lastWithin].every((item) => item.dataQuality.status === "complete"),
    canCalculateDeterministicDelta: completePeriodEndpoints,
    canCalculatePeriodReturn: false,
    warnings: [...new Set(warnings)],
  };
}

function migrateLedger(raw, { now, maxHoldings = DEFAULT_MAX_HOLDINGS }) {
  if (raw == null) {
    const createdAt = requiredIso(now(), "系统记录时间无效。");
    return {
      migrated: false,
      fromVersion: null,
      ledger: sealLedger({
        schemaVersion: SCHEMA_VERSION,
        createdAt,
        updatedAt: createdAt,
        migratedFromVersion: null,
        snapshots: [],
        headHash: GENESIS_HASH,
      }),
    };
  }
  if (raw.schemaVersion === SCHEMA_VERSION) {
    return { migrated: false, fromVersion: SCHEMA_VERSION, ledger: structuredClone(raw) };
  }
  const isLegacy = raw.version === 1 && Array.isArray(raw.snapshots);
  if (!isLegacy) throw new Error("组合快照账本版本不受支持，未修改原文件。");
  const migratedAt = requiredIso(now(), "系统记录时间无效。");
  let previousHash = GENESIS_HASH;
  const snapshots = raw.snapshots.map((legacy, index) => {
    assertNoCredentialFields(legacy);
    const normalized = normalizeSnapshotInput(legacy, { maxHoldings });
    const entry = {
      schemaVersion: SCHEMA_VERSION,
      snapshotId: requiredId(legacy.snapshotId, "旧快照缺少有效 ID，无法迁移。"),
      sequence: index + 1,
      recordedAt: requiredIso(legacy.recordedAt, "旧快照缺少记录时间，无法安全迁移。"),
      ...normalized,
    };
    entry.integrity = sealEntry(entry, previousHash);
    previousHash = entry.integrity.entryHash;
    return entry;
  });
  return {
    migrated: true,
    fromVersion: 1,
    ledger: sealLedger({
      schemaVersion: SCHEMA_VERSION,
      createdAt: requiredIso(raw.createdAt ?? migratedAt, "旧账本创建时间无效。"),
      updatedAt: migratedAt,
      migratedFromVersion: 1,
      snapshots,
      headHash: previousHash,
    }),
  };
}

function verifyLedger(ledger) {
  const issues = [];
  if (!ledger || ledger.schemaVersion !== SCHEMA_VERSION || !Array.isArray(ledger.snapshots)) {
    return { valid: false, recordCount: 0, headHash: null, issues: ["ledger_schema_invalid"] };
  }
  let previousHash = GENESIS_HASH;
  const ids = new Set();
  const idempotencyKeys = new Set();
  const valuationIdentities = new Set();
  for (let index = 0; index < ledger.snapshots.length; index += 1) {
    const entry = ledger.snapshots[index];
    if (entry.sequence !== index + 1) issues.push(`sequence_invalid:${index + 1}`);
    if (ids.has(entry.snapshotId)) issues.push(`snapshot_id_duplicate:${entry.snapshotId}`);
    ids.add(entry.snapshotId);
    const idempotencyIdentity = `${entry.accountScope?.scopeId ?? ""}\0${entry.idempotencyKey ?? ""}`;
    if (idempotencyKeys.has(idempotencyIdentity)) issues.push(`idempotency_key_duplicate:${index + 1}`);
    idempotencyKeys.add(idempotencyIdentity);
    const methodVersion = cleanText(entry.valuation?.methodVersion, 80);
    if (entry.kind === "eod" && methodVersion) {
      const valuationIdentity = `${entry.accountScope?.scopeId ?? ""}\0${entry.tradingDate ?? ""}\0${methodVersion}`;
      if (valuationIdentities.has(valuationIdentity)) {
        issues.push(`eod_valuation_version_duplicate:${index + 1}`);
      }
      valuationIdentities.add(valuationIdentity);
    }
    const expected = sealEntry(withoutIntegrity(entry), previousHash);
    if (entry.integrity?.algorithm !== "sha256-chain-v1") issues.push(`integrity_algorithm_invalid:${index + 1}`);
    if (entry.integrity?.previousHash !== previousHash) issues.push(`previous_hash_invalid:${index + 1}`);
    if (entry.integrity?.contentHash !== expected.contentHash) issues.push(`content_hash_invalid:${index + 1}`);
    if (entry.integrity?.entryHash !== expected.entryHash) issues.push(`entry_hash_invalid:${index + 1}`);
    previousHash = entry.integrity?.entryHash ?? "";
  }
  if (ledger.headHash !== previousHash) issues.push("head_hash_invalid");
  const expectedLedgerHash = hash(stableStringify(ledgerEnvelopeMaterial(ledger)));
  if (ledger.ledgerHash !== expectedLedgerHash) issues.push("ledger_hash_invalid");
  return {
    valid: issues.length === 0,
    recordCount: ledger.snapshots.length,
    headHash: ledger.headHash,
    issues,
  };
}

export function isCurrentRegularCloseSnapshot(value) {
  return value?.kind === "eod"
    && value?.valuation?.session === "regular_close"
    && value?.valuation?.afterHoursMarksExcluded === true
    && value?.valuation?.methodVersion === REGULAR_CLOSE_VALUATION_METHOD_VERSION;
}

function snapshotComparable(entry) {
  const { schemaVersion: _schemaVersion, snapshotId: _snapshotId, sequence: _sequence,
    recordedAt: _recordedAt, integrity: _integrity, ...input } = entry;
  return input;
}

function sealEntry(entry, previousHash) {
  const contentHash = hash(stableStringify(withoutIntegrity(entry)));
  return {
    algorithm: "sha256-chain-v1",
    previousHash,
    contentHash,
    entryHash: hash(`${previousHash}:${contentHash}`),
  };
}

function sealLedger(value) {
  const ledger = { ...value, recordCount: value.snapshots.length };
  ledger.ledgerHash = hash(stableStringify(ledgerEnvelopeMaterial(ledger)));
  return ledger;
}

function ledgerEnvelopeMaterial(ledger) {
  return {
    schemaVersion: ledger.schemaVersion,
    createdAt: ledger.createdAt,
    updatedAt: ledger.updatedAt,
    migratedFromVersion: ledger.migratedFromVersion ?? null,
    recordCount: ledger.recordCount,
    headHash: ledger.headHash,
  };
}

function withoutIntegrity(entry) {
  const { integrity: _integrity, ...value } = entry;
  return value;
}

function integrityError(verification) {
  const error = new Error("组合快照账本完整性校验失败；已停止返回可能被修改的数据。");
  error.code = "PORTFOLIO_SNAPSHOT_INTEGRITY_FAILED";
  error.issues = verification.issues;
  return error;
}

function assertNoCredentialFields(value, path = "snapshot", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, "");
    if (CREDENTIAL_KEYS.has(normalizedKey)) {
      throw new Error(`组合快照禁止保存凭证字段：${path}.${key}`);
    }
    assertNoCredentialFields(child, `${path}.${key}`, seen);
  }
}

function localDate(iso, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function requiredTimezone(value) {
  const timezone = requiredText(value, 120, "快照时区不能为空。");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new Error("快照时区无效。");
  }
  return timezone;
}

function requiredIso(value, message) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(message);
  return date.toISOString();
}

function optionalIso(value, message) {
  return value == null || value === "" ? null : requiredIso(value, message);
}

function requiredDate(value, message) {
  const date = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(message);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error(message);
  return date;
}

function requiredIdempotencyKey(value) {
  const key = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9:._/@-]{5,239}$/.test(key)) {
    throw new Error("快照幂等键无效。");
  }
  return key;
}

function requiredId(value, message) {
  const id = cleanId(value);
  if (!id) throw new Error(message);
  return id;
}

function cleanId(value) {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,239}$/.test(id) ? id : null;
}

function requiredText(value, maxLength, message) {
  const text = cleanText(value, maxLength);
  if (!text) throw new Error(message);
  return text;
}

function cleanText(value, maxLength) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function requiredCurrency(value) {
  const currency = optionalCurrency(value);
  if (!currency) throw new Error("币种无效。");
  return currency;
}

function optionalCurrency(value) {
  if (value == null || value === "") return null;
  const currency = String(value).trim().toUpperCase();
  return /^[A-Z]{3,8}$/.test(currency) ? currency : null;
}

function enumValue(value, allowed, message) {
  const normalized = String(value ?? "").trim();
  if (!allowed.has(normalized)) throw new Error(message);
  return normalized;
}

function finiteNumber(value, message) {
  if (value == null || value === "") throw new Error(message);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(message);
  return number;
}

function nonNegativeNumber(value, message) {
  const number = finiteNumber(value, message);
  if (number < 0) throw new Error(message);
  return number;
}

function positiveNumber(value, message) {
  const number = finiteNumber(value, message);
  if (number <= 0) throw new Error(message);
  return number;
}

function optionalFiniteNumber(value) {
  return value == null || value === "" ? null : finiteNumber(value, "数值无效。");
}

function optionalNonNegativeNumber(value) {
  return value == null || value === "" ? null : nonNegativeNumber(value, "数值无效。");
}

function positiveInteger(value, message) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(message);
  return number;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(",")}}`;
}
