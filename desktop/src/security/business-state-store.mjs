import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { EncryptedStore, EncryptedStoreError } from "./encrypted-store.mjs";
import { isTradingViewUrl } from "./navigation.mjs";

export const BUSINESS_STATE_FILE = "business-state.bin";
export const BUSINESS_STATE_SCHEMA_VERSION = "trading-cockpit-business-state/v1";
export const BUSINESS_STATE_MIGRATION_RECEIPT_KEY = "businessStateMigrationReceiptV1";
export const BUSINESS_STATE_KEYS = Object.freeze([
  "codexWorkspaceThread", "codexWorkspaceThreadRegistry", "codexWorkspaceRecentHistoryIndex",
  "agentResultsByThreadV1", "lastAgentResult", "watchPlans", "tradingViewLastUrl",
]);
const ALLOWED_KEYS = new Set(BUSINESS_STATE_KEYS);
const SECRET_FIELDS = new Set([
  "accesstoken", "refreshtoken", "idtoken", "token", "tokens", "apikey", "apisecret",
  "secret", "clientsecret", "password", "passwd", "passphrase", "privatekey",
  "authorization", "cookie", "cookies", "credentials", "credential", "pkce",
  "codeverifier", "clientregistration", "oauth", "oauthtokens", "sessioncookie",
]);
const DOCUMENT_FIELDS = new Set(["schemaVersion", "workspace", "migration", "updatedAt", "values"]);
const MAX_BYTES = 96 * 1024 * 1024;

/**
 * An encrypted business-only store, not a credential router. Runtime account
 * authority and background-collector preferences deliberately stay outside it.
 * Restoring these indices does not restore the external Codex transcript.
 */
export class BusinessStateStore {
  constructor({ directory, safeStorage, legacyStore, workspaceDirectory, fileIO = {},
    onHealthChange = () => {}, canWrite = () => true } = {}) {
    if (!path.isAbsolute(String(workspaceDirectory ?? ""))) throw invalid("需要明确的工作区目录。");
    if (!legacyStore?.get || !legacyStore?.set) throw invalid("缺少原加密存储。");
    if (typeof canWrite !== "function") throw new TypeError("canWrite must be a synchronous function.");
    this.workspaceDirectory = path.resolve(workspaceDirectory);
    this.legacyStore = legacyStore;
    this.safeStorage = safeStorage;
    this.fileIO = { readFile, ...fileIO };
    this.canWrite = canWrite;
    this.onHealthChange = onHealthChange;
    this.store = new EncryptedStore({ directory, safeStorage, fileName: BUSINESS_STATE_FILE, fileIO,
      onHealthChange: () => this.#notifyHealth() });
    this.filePath = this.store.filePath;
    this.document = null;
    this.initialization = null;
    this.mutationQueue = Promise.resolve();
    this.lastError = null;
  }

  get persistent() { return this.store.persistent; }

  health() {
    const inner = this.store.health();
    return { ...inner, state: inner.state === "unavailable" ? "unavailable"
      : this.lastError || inner.state === "degraded" ? "degraded"
        : this.document ? "healthy" : "uninitialized", errorCode: this.lastError?.code ?? inner.errorCode,
    migrated: Boolean(this.document), legacyFallbackEnabled: false };
  }

  #notifyHealth() { try { this.onHealthChange(this.health()); } catch { /* Observers cannot change persistence. */ } }

  async initialize(options = {}) {
    if (this.document) return this.#initializationResult();
    if (this.initialization) return this.initialization;
    this.initialization = this.#initialize(options).catch((error) => {
      this.lastError = { code: error.code ?? "BUSINESS_STATE_INITIALIZATION_FAILED" };
      this.#notifyHealth();
      throw error;
    }).finally(() => { this.initialization = null; });
    return this.initialization;
  }

  async #initialize(options) {
    const receipt = await this.legacyStore.get(BUSINESS_STATE_MIGRATION_RECEIPT_KEY);
    if (receipt !== undefined && !validReceipt(receipt)) throw invalid("业务数据迁移凭据无效；未启用旧副本回退。");
    let document = await this.#readDiskDocument();
    if (!document && receipt) {
      throw new EncryptedStoreError("BUSINESS_STATE_RECOVERY_REQUIRED", "业务数据文件缺失；旧副本不会自动回流，请恢复受信任备份。");
    }
    if (!document) {
      const values = {};
      // Intentionally never readAll() the credential store, including for backup.
      for (const key of BUSINESS_STATE_KEYS) {
        const value = await this.legacyStore.get(key);
        if (value !== undefined) values[key] = value;
      }
      const now = new Date().toISOString();
      document = validateBusinessStateDocument({
        schemaVersion: BUSINESS_STATE_SCHEMA_VERSION,
        workspace: { kind: "trading-cockpit", directory: this.workspaceDirectory },
        migration: { id: randomUUID(), source: "secure-state.bin", completedAt: now,
          migratedKeys: Object.keys(values) },
        updatedAt: now,
        values,
      }, { workspaceDirectory: this.workspaceDirectory });
      await this.store.update(document, this.#writeOptions(options));
      const verified = await this.#readDiskDocument();
      if (!verified || digest(verified) !== digest(document)) {
        throw new EncryptedStoreError("BUSINESS_STATE_VERIFY_FAILED", "业务数据迁移未通过磁盘复核；原数据保持不变，请重试。");
      }
      document = verified;
    }
    // A crash after the target commit is recovered from that target, never by
    // copying source values again. The receipt is a tombstone against fallback,
    // NOT a hash lock: later writes and legitimate older backups change content.
    if (!receipt) {
      await this.legacyStore.set(BUSINESS_STATE_MIGRATION_RECEIPT_KEY, {
        schemaVersion: BUSINESS_STATE_SCHEMA_VERSION, targetFile: BUSINESS_STATE_FILE,
        migrationId: document.migration.id, activatedAt: new Date().toISOString(),
      }, this.#writeOptions(options));
    }
    this.document = document;
    this.lastError = null;
    this.#notifyHealth();
    return this.#initializationResult();
  }

  #initializationResult() {
    return { initialized: true, file: BUSINESS_STATE_FILE, schemaVersion: BUSINESS_STATE_SCHEMA_VERSION,
      migratedKeys: [...this.document.migration.migratedKeys], legacyFallbackEnabled: false,
      threadAuthority: "workspace_bound_app_indices_not_external_transcript" };
  }

  async get(key) {
    assertKey(key);
    await this.initialize();
    return projectValue(key, this.document.values[key], this.workspaceDirectory);
  }

  async readAll() {
    await this.initialize();
    return Object.fromEntries(Object.keys(this.document.values)
      .map((key) => [key, projectValue(key, this.document.values[key], this.workspaceDirectory)]));
  }

  async set(key, value, options = {}) {
    assertKey(key);
    const detached = value === undefined ? undefined : validateValue(key, value);
    return this.#mutate((values) => {
      if (detached === undefined) delete values[key]; else values[key] = detached;
    }, options);
  }

  async update(values, options = {}) {
    if (!isObject(values)) throw invalid("业务数据更新必须是键值对象。");
    const detached = {};
    for (const [key, value] of Object.entries(values)) {
      assertKey(key);
      detached[key] = value === undefined ? undefined : validateValue(key, value);
    }
    return this.#mutate((current) => {
      for (const [key, value] of Object.entries(detached)) {
        if (value === undefined) delete current[key]; else current[key] = value;
      }
    }, options);
  }

  async delete(key, options = {}) { return this.set(key, undefined, options); }

  async flush() {
    try {
      await this.mutationQueue;
      await this.initialize();
      await this.#assertUnchangedDisk();
    } catch (error) {
      this.lastError = { code: error.code ?? "STORAGE_READ_FAILED" };
      this.#notifyHealth();
      throw error;
    }
    // A restore barrier must be able to drain and verify without rewriting.
  }

  #mutate(operation, options) {
    const next = this.mutationQueue.then(async () => {
      await this.initialize(options);
      await this.#assertUnchangedDisk();
      const document = structuredClone(this.document);
      operation(document.values);
      document.updatedAt = new Date().toISOString();
      const validated = validateBusinessStateDocument(document, { workspaceDirectory: this.workspaceDirectory });
      await this.store.update(validated, this.#writeOptions(options));
      this.document = validated;
      this.lastError = null;
      this.#notifyHealth();
    });
    this.mutationQueue = next.catch((error) => {
      this.lastError = { code: error.code ?? "STORAGE_WRITE_FAILED" };
      this.#notifyHealth();
    });
    return next;
  }

  #writeOptions(options = {}) {
    if (options.commitGuard != null && typeof options.commitGuard !== "function") throw new TypeError("commitGuard must be a synchronous function.");
    return { ...options, commitGuard: () => this.canWrite() === true
      && (options.commitGuard == null || options.commitGuard() === true) };
  }

  async #assertUnchangedDisk() {
    const current = await this.#readDiskDocument();
    if (!current) throw new EncryptedStoreError("BUSINESS_STATE_RECOVERY_REQUIRED", "业务数据文件缺失；未从缓存重新创建。");
    if (digest(current) !== digest(this.document)) {
      throw new EncryptedStoreError("BUSINESS_STATE_CHANGED_EXTERNALLY", "业务数据已由外部更改；已停止写入，请重启后读取或核验备份。");
    }
  }

  async #readDiskDocument() {
    if (!this.persistent) throw new EncryptedStoreError("STORAGE_ENCRYPTION_UNAVAILABLE", "本机加密暂不可用，业务数据未读取或写入。");
    let bytes;
    try { bytes = await this.fileIO.readFile(this.filePath); }
    catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new EncryptedStoreError("STORAGE_READ_FAILED", "业务数据文件读取失败，未启用旧副本回退。");
    }
    if (bytes.length > MAX_BYTES) throw invalid("业务数据文件超出校验上限。");
    let text;
    try { text = this.safeStorage.decryptString(bytes); }
    catch { throw new EncryptedStoreError("STORAGE_DECRYPT_FAILED", "业务数据解密失败，未启用旧副本回退。"); }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw invalid("业务数据内容无法解析；原文件保持不变。"); }
    return validateBusinessStateDocument(parsed, { workspaceDirectory: this.workspaceDirectory });
  }
}

/** Validates decrypted backup content; returns a detached document, never repairs it. */
export function validateBusinessStateDocument(value, { workspaceDirectory } = {}) {
  if (!isObject(value) || Object.keys(value).some((key) => !DOCUMENT_FIELDS.has(key))
    || value.schemaVersion !== BUSINESS_STATE_SCHEMA_VERSION || !isObject(value.values)) throw invalid("业务数据格式或版本无效。");
  if (!exactKeys(value.workspace, ["kind", "directory"]) || value.workspace.kind !== "trading-cockpit"
    || !path.isAbsolute(String(value.workspace.directory ?? ""))
    || path.resolve(value.workspace.directory) !== value.workspace.directory) throw invalid("业务数据缺少明确工作区来源。");
  if (workspaceDirectory != null && path.resolve(workspaceDirectory) !== value.workspace.directory) {
    throw new EncryptedStoreError("BUSINESS_STATE_WORKSPACE_MISMATCH", "业务索引属于其他工作区；未导入为当前会话权限。");
  }
  if (!exactKeys(value.migration, ["id", "source", "completedAt", "migratedKeys"])
    || !/^[a-f0-9-]{36}$/i.test(value.migration.id ?? "")
    || value.migration.source !== "secure-state.bin" || !validDate(value.migration.completedAt)
    || !Array.isArray(value.migration.migratedKeys)
    || value.migration.migratedKeys.some((key) => !ALLOWED_KEYS.has(key))
    || new Set(value.migration.migratedKeys).size !== value.migration.migratedKeys.length
    || !validDate(value.updatedAt)) throw invalid("业务数据迁移来源无效。");
  for (const [key, item] of Object.entries(value.values)) { assertKey(key); validateValue(key, item); }
  inspectJson(value);
  return structuredClone(value);
}

function validateValue(key, value) {
  inspectJson(value);
  if (key === "tradingViewLastUrl") {
    if (value !== null && (typeof value !== "string" || !isTradingViewUrl(value))) throw invalid("TradingView 地址无效。");
    if (value !== null) {
      const url = new URL(value);
      if (url.username || url.password || [...url.searchParams.keys()].some(isSecretField)) throw forbidden();
    }
  } else if (key === "watchPlans") {
    if (!Array.isArray(value) || value.some((item) => !isObject(item))) throw invalid("观察计划格式无效。");
  } else if (key === "codexWorkspaceThread") {
    if (value !== null && (!isObject(value) || typeof value.threadId !== "string")) throw invalid("会话指针格式无效。");
  } else if (key === "codexWorkspaceThreadRegistry" || key === "codexWorkspaceRecentHistoryIndex") {
    if (!isObject(value) || value.version !== 1 || (!Array.isArray(value.threads) && !isObject(value.threads))) throw invalid("会话索引格式无效。");
  } else if (key === "agentResultsByThreadV1") {
    if (!isObject(value) || value.version !== 1 || !isObject(value.results)) throw invalid("Agent 结果索引格式无效。");
  } else if (key === "lastAgentResult" && value !== null && !isObject(value)) throw invalid("Agent 历史结果格式无效。");
  return structuredClone(value);
}

function projectValue(key, value, workspaceDirectory) {
  const copy = structuredClone(value);
  const belongs = (entry) => entry?.cwd === workspaceDirectory;
  if (key === "codexWorkspaceThread") return copy && belongs(copy) ? copy : null;
  if (key === "codexWorkspaceThreadRegistry" && copy) {
    const entries = Array.isArray(copy.threads) ? copy.threads : Object.values(copy.threads);
    copy.threads = entries.filter(belongs);
  }
  return copy;
}

function inspectJson(value) {
  const seen = new Set();
  let count = 0;
  function visit(item, depth) {
    if (++count > 1_000_000 || depth > 80) throw invalid("业务数据结构超出校验上限。");
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item === "string") {
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{16,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/.test(item)) throw forbidden();
      return;
    }
    if (typeof item !== "object" || (!Array.isArray(item) && !isObject(item)) || seen.has(item)) throw invalid("业务数据必须为无循环的 JSON 值。");
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (isSecretField(key) || ["__proto__", "constructor", "prototype"].includes(key)) throw forbidden();
      visit(child, depth + 1);
    }
    seen.delete(item);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_BYTES) throw invalid("业务数据超出校验上限。");
}

function validReceipt(value) {
  return exactKeys(value, ["schemaVersion", "targetFile", "migrationId", "activatedAt"])
    && value.schemaVersion === BUSINESS_STATE_SCHEMA_VERSION && value.targetFile === BUSINESS_STATE_FILE
    && /^[a-f0-9-]{36}$/i.test(value.migrationId ?? "") && validDate(value.activatedAt);
}
function exactKeys(value, keys) { return isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function isObject(value) { return Boolean(value) && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function validDate(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function isSecretField(key) { return SECRET_FIELDS.has(String(key).replace(/[^A-Za-z0-9]/g, "").toLowerCase()); }
function assertKey(key) { if (!ALLOWED_KEYS.has(key)) throw new EncryptedStoreError("BUSINESS_STATE_KEY_FORBIDDEN", "该数据项不属于业务备份白名单。"); }
function forbidden() { return new EncryptedStoreError("BUSINESS_STATE_SECRET_FORBIDDEN", "业务数据含不允许的凭证字段或凭证模式；未迁移或保存，原值仍留在原存储。"); }
function invalid(message) { return new EncryptedStoreError("BUSINESS_STATE_INVALID", message); }
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
