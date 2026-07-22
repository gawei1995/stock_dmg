import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Minimal encrypted JSON store backed by Electron safeStorage.
 * No plaintext fallback is used for financial data or OAuth credentials.
 */
export class EncryptedStore {
  constructor({ directory, safeStorage, fileName = "secure-state.bin" }) {
    this.directory = directory;
    this.filePath = path.join(directory, fileName);
    this.safeStorage = safeStorage;
    this.cache = null;
    this.loadPromise = null;
    this.mutationQueue = Promise.resolve();
    this.recoveryBackupPath = null;
  }

  get persistent() {
    return Boolean(this.safeStorage?.isEncryptionAvailable?.());
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
    if (!this.persistent) {
      this.cache = {};
      return {};
    }

    try {
      const encrypted = await readFile(this.filePath);
      const plain = this.safeStorage.decryptString(encrypted);
      this.cache = JSON.parse(plain);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        const backupPath = `${this.filePath}.unreadable-${Date.now()}`;
        try {
          await rename(this.filePath, backupPath);
          this.recoveryBackupPath = backupPath;
          console.warn("Unable to decrypt desktop state; preserved an unreadable recovery copy.");
        } catch {
          throw new Error("Unable to decrypt or preserve the existing desktop state.");
        }
      }
      this.cache = {};
    }

    return structuredClone(this.cache);
  }

  async get(key) {
    const state = await this.readAll();
    return state[key];
  }

  async set(key, value) {
    return this.#enqueueMutation(async () => {
      const state = await this.readAll();
      if (value === undefined) delete state[key];
      else state[key] = value;
      this.cache = state;
      await this.#flushNow();
    });
  }

  async update(values) {
    return this.#enqueueMutation(async () => {
      const state = await this.readAll();
      this.cache = { ...state, ...values };
      await this.#flushNow();
    });
  }

  async delete(key) {
    await this.set(key, undefined);
  }

  async flush() {
    return this.#enqueueMutation(() => this.#flushNow());
  }

  #enqueueMutation(operation) {
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.catch(() => {});
    return next;
  }

  async #flushNow() {
    if (!this.persistent) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const encrypted = this.safeStorage.encryptString(
      JSON.stringify(this.cache ?? {}),
    );
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, encrypted, { mode: 0o600 });
    await rename(tempPath, this.filePath);
  }
}
