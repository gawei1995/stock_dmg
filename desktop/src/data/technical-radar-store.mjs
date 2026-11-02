import { createHash, randomUUID } from "node:crypto";

export const TECHNICAL_RADAR_STORE_KEY = "technicalRadarLedgerV1";
export const TECHNICAL_RADAR_SCHEMA_VERSION = "technical-radar-ledger/v1";
// The default accommodates roughly one trading year of a full 50-symbol
// compact radar universe plus a bounded number of same-day revisions. The
// ledger refuses new writes at the cap instead of silently pruning evidence.
export const TECHNICAL_RADAR_MAX_BATCHES = 400;
export const TECHNICAL_RADAR_MAX_BYTES = 96 * 1024 * 1024;

/**
 * Tamper-evident, append-only persistence for deterministic Tier-A scans.
 *
 * Raw bars are intentionally not duplicated here. Every batch keeps the
 * scanner input hash/cache key and immutable compact outputs; the encrypted
 * market-history store remains the source of the OHLCV evidence itself.
 */
export class TechnicalRadarStore {
  constructor({
    store,
    key = TECHNICAL_RADAR_STORE_KEY,
    maxBatches = TECHNICAL_RADAR_MAX_BATCHES,
    maxBytes = TECHNICAL_RADAR_MAX_BYTES,
  } = {}) {
    if (!store?.get || !store?.set) {
      throw new TypeError("TechnicalRadarStore requires an encrypted key-value store.");
    }
    this.store = store;
    this.key = String(key || TECHNICAL_RADAR_STORE_KEY);
    this.maxBatches = positiveInteger(maxBatches, TECHNICAL_RADAR_MAX_BATCHES);
    this.maxBytes = positiveInteger(maxBytes, TECHNICAL_RADAR_MAX_BYTES);
    this.writeQueue = Promise.resolve();
  }

  async appendBatch(input = {}) {
    const operation = this.writeQueue.then(async () => {
      const ledger = normalizeLedger(await this.store.get(this.key));
      const normalized = normalizeBatchInput(input);
      const duplicate = ledger.batches.find((item) => (
        item.accountScopeId === normalized.accountScopeId
        && item.tradingDate === normalized.tradingDate
        && item.inputHash === normalized.inputHash
      ));
      if (duplicate) return { appended: false, batch: structuredClone(duplicate) };

      const revision = 1 + ledger.batches.filter((item) => (
        item.accountScopeId === normalized.accountScopeId
        && item.tradingDate === normalized.tradingDate
      )).reduce((max, item) => Math.max(max, item.revision), 0);
      const previousHash = ledger.batches.at(-1)?.recordHash ?? null;
      const body = {
        schemaVersion: TECHNICAL_RADAR_SCHEMA_VERSION,
        batchId: `technical-radar-${randomUUID()}`,
        revision,
        previousHash,
        ...normalized,
      };
      const batch = {
        ...body,
        recordHash: sha256(stableStringify(body)),
      };
      const next = {
        ...ledger,
        updatedAt: batch.recordedAt,
        batches: [...ledger.batches, batch],
      };
      const measured = await this.#measure(next);
      if (measured.activeCount > this.maxBatches) throw storeLimitError("batch_count_limit", this.maxBatches);
      if (measured.activeBytes > this.maxBytes) {
        throw storeLimitError("byte_limit", this.maxBytes);
      }
      await this.store.set(this.key, next);
      return { appended: true, batch: structuredClone(batch) };
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async latest({ accountScopeId = null } = {}) {
    const ledger = normalizeLedger(await this.store.get(this.key));
    const scope = accountScopeId == null ? null : normalizeScopeId(accountScopeId);
    const values = scope
      ? ledger.batches.filter((item) => item.accountScopeId === scope)
      : ledger.batches;
    return structuredClone(values.at(-1) ?? null);
  }

  async listBatches({
    accountScopeId = null,
    fromTradingDate = null,
    toTradingDate = null,
    latestRevisionOnly = false,
    limit = 260,
  } = {}) {
    const ledger = normalizeLedger(await this.store.get(this.key));
    const scope = accountScopeId == null ? null : normalizeScopeId(accountScopeId);
    const from = fromTradingDate == null ? null : normalizeTradingDate(fromTradingDate);
    const to = toTradingDate == null ? null : normalizeTradingDate(toTradingDate);
    const boundedLimit = limit === null ? ledger.batches.length : Math.max(1, positiveInteger(limit, 260));
    let values = ledger.batches.filter((item) => (
      (!scope || item.accountScopeId === scope)
      && (!from || item.tradingDate >= from)
      && (!to || item.tradingDate <= to)
    ));
    if (latestRevisionOnly) {
      const newest = new Map();
      for (const item of values) {
        const key = `${item.accountScopeId}|${item.tradingDate}`;
        const previous = newest.get(key);
        if (!previous || item.revision > previous.revision) newest.set(key, item);
      }
      values = [...newest.values()];
    }
    values.sort(compareBatches);
    return structuredClone(values.slice(-boundedLimit));
  }

  async #measure(ledger) {
    if (typeof this.store.measureLedger === "function") return this.store.measureLedger(ledger);
    const bytes = Buffer.byteLength(JSON.stringify(ledger), "utf8");
    return { activeCount: ledger.batches.length, archivedCount: 0, activeBytes: bytes, totalBytes: bytes };
  }

  async capacity() {
    const integrity = await this.verifyIntegrity();
    if (!integrity.valid) throw inputError("ledger_integrity_invalid", "雷达账本完整性未通过，容量未估算。");
    const ledger = normalizeLedger(await this.store.get(this.key));
    const measured = await this.#measure(ledger);
    return { batchCount: ledger.batches.length, activeCount: measured.activeCount,
      archivedCount: measured.archivedCount, maxBatches: this.maxBatches,
      remainingBatches: Math.max(0, this.maxBatches - measured.activeCount),
      serializedBytes: measured.activeBytes, totalSerializedBytes: measured.totalBytes, maxBytes: this.maxBytes };
  }

  async verifyIntegrity() {
    let ledger;
    try {
      ledger = normalizeLedger(await this.store.get(this.key));
    } catch (error) {
      return {
        valid: false,
        batchCount: 0,
        firstInvalidIndex: 0,
        reason: String(error?.code ?? error?.message ?? error),
      };
    }
    let previousHash = null;
    for (let index = 0; index < ledger.batches.length; index += 1) {
      const item = ledger.batches[index];
      const { recordHash, ...body } = item;
      if (body.previousHash !== previousHash || sha256(stableStringify(body)) !== recordHash) {
        return {
          valid: false,
          batchCount: ledger.batches.length,
          firstInvalidIndex: index,
          reason: body.previousHash !== previousHash ? "hash_chain_mismatch" : "record_hash_mismatch",
        };
      }
      previousHash = recordHash;
    }
    return {
      valid: true,
      batchCount: ledger.batches.length,
      firstInvalidIndex: null,
      reason: null,
      headHash: previousHash,
      updatedAt: ledger.updatedAt,
    };
  }
}

function normalizeBatchInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw inputError("batch_not_object", "Technical radar batch must be an object.");
  }
  const accountScopeId = normalizeScopeId(input.accountScopeId);
  const tradingDate = normalizeTradingDate(input.tradingDate);
  const computedAt = normalizeIso(input.computedAt, "computed_at_invalid");
  const recordedAt = normalizeIso(input.recordedAt ?? new Date().toISOString(), "recorded_at_invalid");
  if (Date.parse(recordedAt) < Date.parse(computedAt)) {
    throw inputError("recorded_before_computed", "Technical radar batch cannot be recorded before it was computed.");
  }
  const inputHash = normalizeHash(input.inputHash, "input_hash_invalid");
  const scannerVersion = boundedText(input.scannerVersion, 100, "scanner_version_missing");
  const source = boundedText(input.source ?? "tier_a_deterministic_scan", 100, "source_missing");
  const items = normalizeItems(input.items);
  const summary = normalizeJsonObject(input.summary ?? {}, "summary_invalid");
  const limitations = normalizeStringArray(input.limitations, 100, 240);
  return {
    accountScopeId,
    tradingDate,
    computedAt,
    recordedAt,
    inputHash,
    scannerVersion,
    source,
    summary,
    items,
    limitations,
  };
}

function normalizeItems(value) {
  if (!Array.isArray(value) || value.length > 120) {
    throw inputError("items_invalid", "Technical radar items must be an array of at most 120 rows.");
  }
  const seen = new Set();
  return value.map((item, index) => {
    const normalized = normalizeJsonObject(item, `item_${index + 1}_invalid`);
    const symbol = String(normalized.symbol ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9._-]{1,32}$/.test(symbol) || seen.has(symbol)) {
      throw inputError("item_symbol_invalid", `Technical radar item ${index + 1} has an invalid or duplicate symbol.`);
    }
    seen.add(symbol);
    return { ...normalized, symbol };
  });
}

function normalizeLedger(value) {
  if (value == null) {
    return {
      schemaVersion: TECHNICAL_RADAR_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      batches: [],
    };
  }
  if (!value || value.schemaVersion !== TECHNICAL_RADAR_SCHEMA_VERSION || !Array.isArray(value.batches)) {
    throw inputError("ledger_invalid", "Technical radar ledger is malformed or has an unsupported version.");
  }
  const batches = value.batches.map((item, index) => normalizeStoredBatch(item, index));
  return {
    schemaVersion: TECHNICAL_RADAR_SCHEMA_VERSION,
    createdAt: normalizeIso(value.createdAt, "ledger_created_at_invalid"),
    updatedAt: value.updatedAt == null ? null : normalizeIso(value.updatedAt, "ledger_updated_at_invalid"),
    batches,
  };
}

function normalizeStoredBatch(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw inputError("stored_batch_invalid", `Stored technical radar batch ${index + 1} is invalid.`);
  }
  const revision = positiveInteger(value.revision, 0);
  if (revision < 1) throw inputError("stored_revision_invalid", "Stored technical radar revision is invalid.");
  return {
    schemaVersion: TECHNICAL_RADAR_SCHEMA_VERSION,
    batchId: boundedText(value.batchId, 100, "stored_batch_id_missing"),
    revision,
    previousHash: value.previousHash == null ? null : normalizeHash(value.previousHash, "previous_hash_invalid"),
    ...normalizeBatchInput(value),
    recordHash: normalizeHash(value.recordHash, "record_hash_invalid"),
  };
}

function normalizeJsonObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw inputError(code, "Expected a JSON object.");
  }
  let cloned;
  try {
    cloned = structuredClone(value);
    assertFiniteJson(cloned);
    const encoded = JSON.stringify(cloned);
    if (typeof encoded !== "string") throw new TypeError("not_json");
  } catch {
    throw inputError(code, "Value must be finite, serializable JSON.");
  }
  return cloned;
}

function assertFiniteJson(value, seen = new Set()) {
  if (value == null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non_finite_number");
    return;
  }
  if (typeof value !== "object" || seen.has(value)) throw new TypeError("non_json_value");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertFiniteJson(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("non_plain_object");
    for (const [key, item] of Object.entries(value)) {
      if (!key || item === undefined) throw new TypeError("undefined_json_value");
      assertFiniteJson(item, seen);
    }
  }
  seen.delete(value);
}

function normalizeScopeId(value) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(text)) {
    throw inputError("account_scope_invalid", "A verified or explicitly degraded account scope is required.");
  }
  return text;
}

function normalizeTradingDate(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(`${text}T00:00:00.000Z`))) {
    throw inputError("trading_date_invalid", "Technical radar tradingDate must be YYYY-MM-DD.");
  }
  return text;
}

function normalizeIso(value, code) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) throw inputError(code, "Timestamp must be a valid ISO instant.");
  return new Date(parsed).toISOString();
}

function normalizeHash(value, code) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw inputError(code, "Expected a SHA-256 hex digest.");
  return text;
}

function boundedText(value, maxLength, code) {
  const text = String(value ?? "").trim();
  if (!text) throw inputError(code, "Required text is missing.");
  return text.slice(0, maxLength);
}

function normalizeStringArray(value, maxItems, maxLength) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw inputError("limitations_invalid", "Limitations must be an array.");
  return [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))]
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxLength));
}

function compareBatches(left, right) {
  return left.tradingDate.localeCompare(right.tradingDate)
    || left.revision - right.revision
    || left.recordedAt.localeCompare(right.recordedAt);
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function inputError(code, message) {
  const error = new Error(message);
  error.name = "TechnicalRadarStoreError";
  error.code = code;
  return error;
}

function storeLimitError(kind, limit) {
  const error = inputError(
    "technical_radar_store_limit_reached",
    `Technical radar ledger reached its ${kind} (${limit}); history was preserved and the new batch was refused.`,
  );
  error.kind = kind;
  error.limit = limit;
  return error;
}
