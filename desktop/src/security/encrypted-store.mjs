import { copyFile, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { renameSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const FILE_IO = Object.freeze({ copyFile, lstat, mkdir, open, readFile, rm, renameSync });

export class EncryptedStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EncryptedStoreError";
    this.code = code;
  }
}

/**
 * Minimal encrypted JSON store backed by Electron safeStorage.
 * No plaintext fallback is used for financial data or OAuth credentials.
 */
export class EncryptedStore {
  constructor({ directory, safeStorage, fileName = "secure-state.bin", fileIO = {}, onHealthChange = () => {}, canWrite = () => true }) {
    this.directory = directory;
    this.filePath = path.join(directory, fileName);
    this.safeStorage = safeStorage;
    this.cache = null;
    this.loadPromise = null;
    this.mutationQueue = Promise.resolve();
    this.recoveryBackupPath = null;
    this.fileIO = { ...FILE_IO, ...fileIO };
    this.lastError = null;
    this.lastSavedAt = null;
    this.onHealthChange = onHealthChange;
    this.canWrite = canWrite;
  }

  get persistent() {
    try { return Boolean(this.safeStorage?.isEncryptionAvailable?.()); }
    catch { return false; }
  }

  #notifyHealth() {
    try { this.onHealthChange(this.health()); } catch { /* UI cannot alter a commit result. */ }
  }

  health() {
    return {
      file: path.basename(this.filePath),
      encrypted: this.persistent,
      state: !this.persistent ? "unavailable"
        : this.lastError ? "degraded" : this.cache === null ? "uninitialized" : "healthy",
      errorCode: this.lastError?.code ?? null,
      lastSavedAt: this.lastSavedAt,
      recoveryAvailable: Boolean(this.recoveryBackupPath),
    };
  }

  async diskUsage() {
    try {
      const stat = await this.fileIO.lstat(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not_regular_file");
      return { bytes: stat.size, exists: true, observedAt: new Date().toISOString(), basis: "encrypted_file_bytes" };
    } catch (error) {
      if (error?.code === "ENOENT") return { bytes: 0, exists: false, observedAt: new Date().toISOString(), basis: "encrypted_file_bytes" };
      return { bytes: null, exists: null, observedAt: new Date().toISOString(), basis: "unavailable" };
    }
  }

  #requireEncryption() {
    if (!this.persistent) {
      throw new EncryptedStoreError("STORAGE_ENCRYPTION_UNAVAILABLE", "本机加密暂不可用；未保存更改，原数据保持不变。请解锁系统钥匙串后重试。");
    }
  }

  async readAll() {
    if (this.cache) return structuredClone(this.cache);
    if (this.loadPromise) return structuredClone(await this.loadPromise);
    this.loadPromise = this.#load();
    try {
      return structuredClone(await this.loadPromise);
    } finally {
      this.loadPromise = null;
    }
  }

  async #load() {
    try {
      this.#requireEncryption();
      let encrypted;
      try {
        encrypted = await this.fileIO.readFile(this.filePath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw new EncryptedStoreError("STORAGE_READ_FAILED", "本机加密数据暂时无法读取；未创建空白数据或覆盖原记录。");
        }
        this.cache = {};
        this.lastError = null;
        this.#notifyHealth();
        return {};
      }
      let plain;
      try {
        plain = this.safeStorage.decryptString(encrypted);
      } catch {
        // A locked or unavailable Keychain is not evidence of corrupted data.
        // Keep the original in place and allow the next read to retry it.
        throw new EncryptedStoreError("STORAGE_DECRYPT_FAILED", "本机加密数据无法解密；原文件保持不变。请确认系统钥匙串可用后重试，或使用受信任备份恢复。");
      }
      let parsed;
      try {
        parsed = JSON.parse(plain);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid state");
      } catch {
        if (!this.recoveryBackupPath) {
          const backupPath = `${this.filePath}.unreadable-${randomUUID()}`;
          try {
            await this.fileIO.copyFile(this.filePath, backupPath);
            this.recoveryBackupPath = backupPath;
          } catch {
            // The original is deliberately never renamed or replaced.
          }
        }
        throw new EncryptedStoreError("STORAGE_RECOVERY_REQUIRED", "加密数据内容校验失败；已停止读写，原文件保持不变。请恢复受信任备份，不会自动新建空白工作区。");
      }
      this.cache = parsed;
      this.lastError = null;
      this.#notifyHealth();
      return structuredClone(this.cache);
    } catch (error) {
      this.lastError = { code: error.code ?? "STORAGE_READ_FAILED" };
      this.#notifyHealth();
      throw error;
    }
  }

  async get(key) {
    const state = await this.readAll();
    return state[key];
  }

  async set(key, value, options = {}) {
    const nextValue = structuredClone(value);
    return this.#enqueueMutation(async () => {
      const state = await this.readAll();
      if (nextValue === undefined) delete state[key];
      else state[key] = nextValue;
      await this.#commit(state, options);
    });
  }

  async update(values, options = {}) {
    const nextValues = structuredClone(values);
    return this.#enqueueMutation(async () => {
      const state = await this.readAll();
      await this.#commit({ ...state, ...nextValues }, options);
    });
  }

  async delete(key, options = {}) {
    await this.set(key, undefined, options);
  }

  async flush(options = {}) {
    return this.#enqueueMutation(async () => this.#commit(await this.readAll(), options));
  }

  async drain() {
    await this.mutationQueue;
  }

  #enqueueMutation(operation) {
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.catch(() => {});
    return next;
  }

  async #commit(state, { commitGuard = null, writePermit = null, validateCiphertext = null } = {}) {
    let tempPath = null;
    let guardFailure = false;
    const checkGuard = () => {
      try { assertCommitGuard(() => this.canWrite({ writePermit })); assertCommitGuard(commitGuard); }
      catch (error) { guardFailure = true; throw error; }
    };
    const validate = (descriptor, phase) => {
      if (validateCiphertext == null) return;
      try {
        assertSynchronousValidation(validateCiphertext, Object.freeze({ ...descriptor, phase }));
      } catch (error) { guardFailure = true; throw error; }
    };
    try {
      checkGuard();
      this.#requireEncryption();
      const serialized = JSON.stringify(state);
      const committedState = JSON.parse(serialized);
      let encrypted;
      try {
        encrypted = this.safeStorage.encryptString(serialized);
      } catch {
        throw new EncryptedStoreError("STORAGE_ENCRYPT_FAILED", "数据加密失败；本次更改未保存，原记录保持不变。");
      }
      if (!Buffer.isBuffer(encrypted)) throw new EncryptedStoreError("STORAGE_ENCRYPT_FAILED", "加密结果无效；未保存更改。");
      const ciphertext = { name: path.basename(this.filePath), bytes: encrypted.length,
        sha256: validateCiphertext == null ? null : createHash("sha256").update(encrypted).digest("hex") };
      checkGuard();
      validate(ciphertext, "before_write");
      checkGuard();
      await this.fileIO.mkdir(this.directory, { recursive: true, mode: 0o700 });
      tempPath = `${this.filePath}.tmp-${randomUUID()}`;
      const file = await this.fileIO.open(tempPath, "wx", 0o600);
      try {
        await file.writeFile(encrypted);
        await file.sync();
      } finally {
        await file.close();
      }
      this.#requireEncryption();
      checkGuard();
      validate(ciphertext, "before_commit");
      checkGuard();
      // No await between the final identity check, atomic rename, and cache
      // commit: an authorization change cannot interleave at this boundary.
      this.fileIO.renameSync(tempPath, this.filePath);
      tempPath = null;
      this.cache = committedState;
      this.lastSavedAt = new Date().toISOString();
      this.lastError = null;
      this.#notifyHealth();
    } catch (error) {
      this.lastError = { code: error.code ?? "STORAGE_WRITE_FAILED" };
      this.#notifyHealth();
      if (guardFailure || error instanceof EncryptedStoreError || error?.code?.startsWith("STALE_")
        || error instanceof TypeError) throw error;
      throw new EncryptedStoreError("STORAGE_WRITE_FAILED", "加密数据写入失败；本次更改未保存，原记录保持不变。请检查可用空间与文件权限后重试。");
    } finally {
      if (tempPath) await this.fileIO.rm(tempPath, { force: true }).catch(() => {});
    }
  }
}

function assertSynchronousValidation(validate, descriptor) {
  if (typeof validate !== "function" || validate.constructor?.name === "AsyncFunction") {
    throw new TypeError("Storage validateCiphertext must be a synchronous function.");
  }
  const result = validate(descriptor);
  if (result?.then) {
    Promise.resolve(result).catch(() => {});
    throw new TypeError("Storage validateCiphertext must not return a Promise.");
  }
  if (result !== true) throw new EncryptedStoreError("STORAGE_CIPHERTEXT_REJECTED", "加密数据未通过提交前容量校验；原记录保持不变。");
}

function assertCommitGuard(guard) {
  if (guard == null) return;
  if (typeof guard !== "function") throw new TypeError("Storage commitGuard must be a synchronous function.");
  if (guard() !== true) {
    throw new EncryptedStoreError("STALE_STORAGE_COMMIT", "数据来源在保存前已经变化；旧操作已停止，原记录保持不变。请重新同步。");
  }
}
