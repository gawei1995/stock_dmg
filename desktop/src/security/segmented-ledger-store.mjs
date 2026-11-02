import { createHash, randomUUID } from "node:crypto";
import { linkSync } from "node:fs";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

export const SEGMENTED_LEDGER_SCHEMA_VERSION = "segmented-encrypted-ledger/v1";
export const LEDGER_SEGMENT_SCHEMA_VERSION = "encrypted-ledger-segment/v1";
export const LEDGER_SEGMENT_NAME_PATTERN = /^ledger-segment-([a-f0-9]{64})\.bin$/;
export const SEGMENTED_LEDGER_POLICIES = Object.freeze({
  portfolio: Object.freeze({ key: "portfolioSnapshotLedgerV2", recordsKey: "snapshots", fileName: "portfolio-snapshots.bin" }),
  radar: Object.freeze({ key: "technicalRadarLedgerV1", recordsKey: "batches", fileName: "technical-radar.bin" }),
});
const FILE_IO = { lstat, mkdir, open, readFile, rm, linkSync };
const HASH = /^[a-f0-9]{64}$/;
const MAX_SEGMENT_BYTES = 128 * 1024 * 1024;
const MAX_SEGMENTS = 20_000;

/**
 * A transparent adapter for two append-only domain ledgers. Domain hashes are
 * never regenerated: get() returns the original complete ledger verbatim.
 * Segments are immutable ciphertext. The backing store's single atomic root
 * publication is the ONLY archive commit point. Unreferenced segments are not
 * data and are never automatically collected or mistaken for committed data.
 */
export class SegmentedLedgerStore {
  constructor({ store, kind, directory = store?.directory, safeStorage = store?.safeStorage,
    canWrite = () => true, fileIO = {} } = {}) {
    this.policy = requirePolicy(kind);
    if (!store?.get || !store?.set || !store?.update || !store?.readAll
        || !path.isAbsolute(String(directory ?? "")) || typeof canWrite !== "function") {
      throw new TypeError("SegmentedLedgerStore requires an encrypted backing store and an absolute directory.");
    }
    if (store.filePath && path.basename(store.filePath) !== this.policy.fileName) {
      throw problem("SEGMENT_STORE_MISMATCH", "分段账本与根存储文件不匹配。");
    }
    this.store = store;
    this.kind = kind;
    this.directory = directory;
    this.safeStorage = safeStorage;
    this.canWrite = canWrite;
    this.fileIO = { ...FILE_IO, ...fileIO };
    this.mutationQueue = Promise.resolve();
    this.lastError = null;
  }

  get persistent() { return this.store.persistent === true; }
  get filePath() { return this.store.filePath; }
  get recoveryBackupPath() { return this.store.recoveryBackupPath; }
  health() {
    const status = this.store.health?.() ?? { state: "unknown", encrypted: this.persistent };
    return this.lastError && status.state !== "unavailable"
      ? { ...status, state: "degraded", errorCode: this.lastError.code } : status;
  }

  async get(key) {
    if (key !== this.policy.key) return this.store.get(key);
    return this.#observe(async () => (await this.#load()).ledger);
  }

  async readAll() {
    return this.#observe(async () => {
      const values = await this.store.readAll();
      if (Object.hasOwn(values, this.policy.key)) {
        values[this.policy.key] = (await this.#decode(values[this.policy.key])).ledger;
      }
      return values;
    });
  }

  set(key, value, options = {}) {
    const detached = value === undefined ? undefined : cloneJson(value);
    return this.#enqueue(async () => {
      const next = key === this.policy.key ? await this.#encodeUpdate(detached) : detached;
      await this.store.set(key, next, this.#options(options));
    });
  }

  update(values, options = {}) {
    if (!plainObject(values)) throw new TypeError("Ledger update requires a JSON object.");
    const detached = Object.fromEntries(Object.entries(values)
      .map(([key, value]) => [key, value === undefined ? undefined : cloneJson(value)]));
    return this.#enqueue(async () => {
      if (Object.hasOwn(detached, this.policy.key)) {
        detached[this.policy.key] = await this.#encodeUpdate(detached[this.policy.key]);
      }
      await this.store.update(detached, this.#options(options));
    });
  }

  delete(key, options = {}) { return this.set(key, undefined, options); }

  async drain() { await this.mutationQueue; await this.store.drain?.(); }
  async flush(options = {}) {
    return this.#enqueue(async () => {
      await this.#load(); // Refuse to flush a root whose referenced history cannot be read.
      await this.store.flush(this.#options(options));
    });
  }

  /** Logical bytes/counts for domain capacity checks, not process memory usage. */
  async measureLedger(newLedger) {
    return this.#observe(async () => {
      const loaded = await this.#load();
      const ledger = ledgerObject(newLedger, this.policy);
      assertArchivedPrefix(loaded, ledger, this.policy);
      return measure(ledger, this.policy.recordsKey, loaded.envelope?.archivedCount ?? 0);
    });
  }

  /** A local, read-only description. Only referenced segment files are counted. */
  async describe() {
    return this.#observe(async () => {
      const loaded = await this.#load();
      const root = await this.#readFile(this.policy.fileName, { optional: true, limit: Number.MAX_SAFE_INTEGER });
      let rootLedger;
      if (root) {
        this.#requireEncryption();
        rootLedger = JSON.parse(this.safeStorage.decryptString(root))[this.policy.key];
      }
      const diskContentHash = rootLedger == null ? null
        : isEnvelope(rootLedger) ? rootLedger.contentHash : hash(stableStringify(rootLedger));
      if (diskContentHash !== loaded.contentHash
        || isEnvelope(rootLedger) !== Boolean(loaded.envelope)
        || (loaded.envelope && stableStringify(rootLedger) !== stableStringify(loaded.envelope))) {
        throw problem("SEGMENT_MEASUREMENT_CHANGED", "读取容量时账本版本发生变化；本次未返回混合版本统计，请重试。");
      }
      const ciphertextFiles = [
        ...(root ? [{ name: this.policy.fileName, bytes: root.length, sha256: hash(root), role: "active_root", kind: this.kind }] : []),
        ...(loaded.envelope?.segments ?? []).map(ref => ({ ...ref, role: "immutable_prefix_segment" })),
      ];
      return {
        kind: this.kind,
        segmented: Boolean(loaded.envelope),
        revision: loaded.envelope?.revision ?? 0,
        contentHash: loaded.contentHash,
        ...(loaded.ledger == null ? emptyMeasure() : measure(loaded.ledger, this.policy.recordsKey, loaded.envelope?.archivedCount ?? 0)),
        rootCiphertextBytes: root?.length ?? 0,
        ciphertextBytes: ciphertextFiles.reduce((sum, item) => sum + item.bytes, 0),
        ciphertextFiles,
      };
    });
  }

  async diskUsage() {
    try {
      const description = await this.describe();
      return { bytes: description.ciphertextBytes, exists: description.ciphertextFiles.length > 0,
        fileCount: description.ciphertextFiles.length, observedAt: new Date().toISOString(),
        basis: "encrypted_root_and_referenced_segments" };
    } catch {
      return { bytes: null, exists: null, fileCount: null,
        observedAt: new Date().toISOString(), basis: "unavailable" };
    }
  }

  async planArchive({ retainActiveCount } = {}) {
    return this.#observe(async () => buildPlan(await this.#load(), this.kind, this.policy, retainActiveCount));
  }

  /** Measures ciphertext without publishing it; randomized hashes never enter planHash. */
  async estimateArchivePublication({ plan } = {}) {
    const request = plan == null ? null : cloneJson(plan);
    return this.#observe(async () => {
      const loaded = await this.#load(), currentPlan = this.#assertPlan(loaded, request);
      if (!currentPlan.archiveCount) {
        const root = await this.#readFile(this.policy.fileName);
        return { kind: this.kind, planHash: currentPlan.planHash, revision: currentPlan.revision,
          basis: "measured_preview_ciphertext", phase: "preview", segment: null,
          root: { name: this.policy.fileName, bytes: root.length, sha256: hash(root) } };
      }
      const prepared = await this.#preparePublication(loaded, currentPlan);
      return { ...prepared.publication, phase: "preview" };
    });
  }

  archive({ plan, confirmed = false, commitGuard = null, writePermit = null, publicationGuard = null } = {}) {
    // Detach the approval, but do not persist or trust any caller-created paths.
    const request = plan == null ? null : cloneJson(plan);
    return this.#enqueue(async () => {
      if (confirmed !== true) throw problem("ARCHIVE_CONFIRMATION_REQUIRED", "历史归档需要明确确认；未自动归档。");
      this.#guard(commitGuard, writePermit);
      const loaded = await this.#load();
      const currentPlan = this.#assertPlan(loaded, request);
      if (!currentPlan.archiveCount) {
        this.#guard(commitGuard, writePermit);
        return { archived: false, archiveCount: 0, revision: currentPlan.revision, contentHash: currentPlan.contentHash };
      }
      const prepared = await this.#preparePublication(loaded, currentPlan);
      const validatePublication = (publication) => {
        this.#guard(commitGuard, writePermit);
        assertPublicationGuard(publicationGuard, publication);
        this.#guard(commitGuard, writePermit);
      };
      const reference = await this.#publishSegment(prepared, { commitGuard, writePermit,
        validatePublication: () => validatePublication({ ...prepared.publication, phase: "segment_prepublication" }) });
      const next = prepared.next;
      // No history is removed until this encrypted root atomically commits.
      await this.store.set(this.policy.key, next, this.#options({ commitGuard, writePermit,
        validateCiphertext: ({ phase, ...root }) => {
          validatePublication({ ...prepared.publication, basis: "actual_root_ciphertext", phase: "root_ciphertext",
            rootCommitPhase: phase, root });
          return true;
        } }));
      return { archived: true, archiveCount: currentPlan.archiveCount,
        revision: next.revision, contentHash: next.contentHash,
        archivedCount: next.archivedCount, activeCount: next.activeRecords.length,
        segment: structuredClone(reference) };
    });
  }

  #assertPlan(loaded, request) {
    const currentPlan = buildPlan(loaded, this.kind, this.policy, request?.retainActiveCount);
    if (!request || stableStringify(request) !== stableStringify(currentPlan)) {
      throw problem("ARCHIVE_PLAN_STALE", "账本内容或归档预览已经变化；请重新预览并确认。");
    }
    return currentPlan;
  }

  async #preparePublication(loaded, currentPlan) {
    this.#requireEncryption();
    const startIndex = loaded.envelope?.archivedCount ?? 0;
    const segment = { schemaVersion: LEDGER_SEGMENT_SCHEMA_VERSION, kind: this.kind,
      ledgerKey: this.policy.key, recordsKey: this.policy.recordsKey, startIndex,
      recordCount: currentPlan.archiveCount,
      records: loaded.ledger[this.policy.recordsKey].slice(startIndex, startIndex + currentPlan.archiveCount) };
    const { bytes, reference } = this.#encryptSegment(segment);
    const next = buildEnvelope(loaded.ledger, this.kind, this.policy,
      [...(loaded.envelope?.segments ?? []), reference], (loaded.envelope?.revision ?? 0) + 1);
    const state = await this.store.readAll();
    this.#assertPlan(await this.#decode(state[this.policy.key]), currentPlan);
    let rootBytes;
    try { rootBytes = this.safeStorage.encryptString(JSON.stringify({ ...state, [this.policy.key]: next })); }
    catch { throw problem("SEGMENT_ENCRYPT_FAILED", "预计账本加密失败；未发布归档片段。"); }
    if (!Buffer.isBuffer(rootBytes)) throw problem("SEGMENT_ENCRYPT_FAILED", "预计账本密文无效；未发布归档片段。");
    return { segment, bytes, reference, next, publication: {
      kind: this.kind, planHash: currentPlan.planHash, revision: currentPlan.revision,
      basis: "measured_preview_ciphertext",
      root: { name: this.policy.fileName, bytes: rootBytes.length, sha256: hash(rootBytes) },
      segment: structuredClone(reference),
    } };
  }

  async #encodeUpdate(value) {
    const loaded = await this.#load();
    if (!loaded.envelope) {
      if (isEnvelope(value)) throw problem("SEGMENT_DIRECT_ENVELOPE_REJECTED", "不能通过普通账本更新写入归档清单。");
      return value;
    }
    if (value == null) throw problem("SEGMENT_HISTORY_IMMUTABLE", "已有归档历史的账本不能被清空或删除。");
    const ledger = ledgerObject(value, this.policy);
    assertArchivedPrefix(loaded, ledger, this.policy);
    return buildEnvelope(ledger, this.kind, this.policy, loaded.envelope.segments, loaded.envelope.revision + 1);
  }

  async #load() { return this.#decode(await this.store.get(this.policy.key)); }

  async #decode(raw) {
    if (!isEnvelope(raw)) return { ledger: raw, envelope: null, contentHash: raw == null ? null : hash(stableStringify(raw)) };
    const envelope = validateEnvelope(raw, this.kind);
    const records = [];
    for (const reference of envelope.segments) {
      const bytes = await this.#readFile(reference.name);
      if (bytes.length !== reference.bytes || hash(bytes) !== reference.sha256) {
        throw problem("SEGMENT_CIPHERTEXT_MISMATCH", "归档片段密文校验失败；未返回不完整历史。");
      }
      const segment = this.#decryptSegment(bytes, reference);
      records.push(...segment.records);
    }
    records.push(...envelope.activeRecords);
    const ledger = { ...envelope.ledgerMetadata, [this.policy.recordsKey]: records };
    if (records.length !== envelope.totalCount || hash(stableStringify(ledger)) !== envelope.contentHash) {
      throw problem("SEGMENT_LEDGER_MISMATCH", "分段账本重建不完整或内容已变化；未返回截断历史。");
    }
    return { ledger, envelope, contentHash: envelope.contentHash };
  }

  #decryptSegment(bytes, reference) {
    this.#requireEncryption();
    let value;
    try { value = JSON.parse(this.safeStorage.decryptString(bytes)); }
    catch { throw problem("SEGMENT_DECRYPT_FAILED", "归档片段无法解密或解析；原数据保持不变。"); }
    exactKeys(value, ["schemaVersion", "kind", "ledgerKey", "recordsKey", "startIndex", "recordCount", "records"]);
    if (value.schemaVersion !== LEDGER_SEGMENT_SCHEMA_VERSION || value.kind !== this.kind
        || value.ledgerKey !== this.policy.key || value.recordsKey !== this.policy.recordsKey
        || value.startIndex !== reference.startIndex || value.recordCount !== reference.recordCount
        || !Array.isArray(value.records) || value.records.length !== reference.recordCount
        || hash(stableStringify(value)) !== reference.contentHash
        || stableStringify(chainSummary(value.records, this.kind)) !== stableStringify(reference.chain)) {
      throw problem("SEGMENT_CONTENT_MISMATCH", "归档片段内容、顺序或链摘要不匹配。");
    }
    return value;
  }

  #encryptSegment(segment) {
    this.#requireEncryption();
    const plaintext = stableStringify(segment);
    if (Buffer.byteLength(plaintext) > MAX_SEGMENT_BYTES) throw problem("SEGMENT_SIZE_LIMIT", "归档片段超过安全容量，请分批归档。");
    let bytes;
    try { bytes = this.safeStorage.encryptString(plaintext); }
    catch { throw problem("SEGMENT_ENCRYPT_FAILED", "归档加密失败；原账本保持不变。"); }
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_SEGMENT_BYTES) throw problem("SEGMENT_SIZE_LIMIT", "归档密文大小无效或超过安全容量。");
    const sha256 = hash(bytes), name = `ledger-segment-${sha256}.bin`;
    const reference = {
      name, sha256, bytes: bytes.length, kind: this.kind,
      startIndex: segment.startIndex, recordCount: segment.recordCount,
      contentHash: hash(plaintext), chain: chainSummary(segment.records, this.kind),
    };
    return { bytes, reference };
  }

  async #publishSegment({ bytes, reference }, { commitGuard, writePermit, validatePublication }) {
    this.#guard(commitGuard, writePermit);
    validatePublication();
    const { name, sha256 } = reference;
    await this.fileIO.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const targetPath = path.join(this.directory, name);
    const tempPath = path.join(this.directory, `.ledger-segment-${randomUUID()}.tmp`);
    try {
      const handle = await this.fileIO.open(tempPath, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
      const verified = await this.#readFile(path.basename(tempPath), { allowTemporary: true });
      if (hash(verified) !== sha256) throw problem("SEGMENT_WRITE_VERIFY_FAILED", "归档片段未通过磁盘复核；未更新账本。");
      this.#decryptSegment(verified, reference);
      validatePublication();
      this.#guard(commitGuard, writePermit);
      // A hard-link publication is atomic and never replaces an existing hash
      // file, unlike rename. A crash can leave an unreferenced immutable file.
      try { this.fileIO.linkSync(tempPath, targetPath); }
      catch (error) { if (error?.code !== "EEXIST") throw error; }
      const published = await this.#readFile(name);
      if (published.length !== reference.bytes || hash(published) !== sha256) {
        throw problem("SEGMENT_WRITE_VERIFY_FAILED", "归档目标片段冲突或未完整落盘；未更新账本。");
      }
      this.#decryptSegment(published, reference);
      // Ensure the immutable reference survives a process/power interruption
      // before committing a root which depends on its directory entry.
      const directory = await this.fileIO.open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      this.#guard(commitGuard, writePermit);
      return reference;
    } finally { await this.fileIO.rm(tempPath, { force: true }).catch(() => {}); }
  }

  async #readFile(name, { optional = false, limit = MAX_SEGMENT_BYTES, allowTemporary = false } = {}) {
    if (name !== this.policy.fileName && !LEDGER_SEGMENT_NAME_PATTERN.test(name)
        && !(allowTemporary && /^\.ledger-segment-[a-f0-9-]{36}\.tmp$/.test(name))) {
      throw problem("SEGMENT_PATH_INVALID", "归档文件名无效；拒绝读取非账本文件。");
    }
    const filePath = path.join(this.directory, name);
    let before;
    try { before = await this.fileIO.lstat(filePath); }
    catch (error) { if (optional && error?.code === "ENOENT") return null; throw problem("SEGMENT_FILE_UNAVAILABLE", "归档所需文件无法读取；未创建空历史。", error); }
    if (!before.isFile() || before.isSymbolicLink() || before.size > limit) {
      throw problem("SEGMENT_FILE_INVALID", "归档必须是受限大小的普通文件，不能使用符号链接。");
    }
    const bytes = await this.fileIO.readFile(filePath);
    const after = await this.fileIO.lstat(filePath);
    if (!after.isFile() || after.isSymbolicLink() || before.ino !== after.ino || before.dev !== after.dev
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
      throw problem("SEGMENT_FILE_CHANGED", "归档文件在读取时发生变化；请核验后重试。");
    }
    return bytes;
  }

  #requireEncryption() {
    if (!this.persistent || this.safeStorage?.isEncryptionAvailable?.() !== true) {
      throw problem("STORAGE_ENCRYPTION_UNAVAILABLE", "系统加密暂不可用；未读写归档明文替代文件。");
    }
  }

  #guard(commitGuard, writePermit = null) {
    if (commitGuard != null && typeof commitGuard !== "function") throw new TypeError("commitGuard must be synchronous.");
    if (this.canWrite({ writePermit }) !== true || (commitGuard != null && commitGuard() !== true)) {
      throw problem("STALE_SEGMENT_COMMIT", "归档期间账户或恢复状态已变化；未继续提交。");
    }
    return true;
  }
  #options(options) { return { ...options, commitGuard: () => this.#guard(options?.commitGuard, options?.writePermit) }; }
  async #observe(operation) {
    try { const result = await operation(); this.lastError = null; return result; }
    catch (error) { this.lastError = { code: error.code ?? "SEGMENT_STORAGE_FAILED" }; throw error; }
  }
  #enqueue(operation) {
    const next = this.mutationQueue.then(() => this.#observe(operation));
    this.mutationQueue = next.catch(() => {});
    return next;
  }
}

function assertPublicationGuard(guard, publication) {
  if (guard == null) return;
  if (typeof guard !== "function" || guard.constructor?.name === "AsyncFunction") {
    throw new TypeError("Archive publicationGuard must be a synchronous function.");
  }
  const result = guard(structuredClone(publication));
  if (result?.then) {
    Promise.resolve(result).catch(() => {});
    throw new TypeError("Archive publicationGuard must not return a Promise.");
  }
  if (result !== true) throw problem("ARCHIVE_PUBLICATION_REJECTED", "归档未通过备份容量复核；原账本保持不变。");
}

/** Pure inspection for backup allowlisting; no paths, credentials or IO. */
export function inspectSegmentedLedgerReferences(rootValue, { kind } = {}) {
  const policy = requirePolicy(kind);
  if (!plainObject(rootValue)) throw problem("SEGMENT_ROOT_INVALID", "加密根存储必须是对象。");
  const value = rootValue[policy.key];
  if (!isEnvelope(value)) return [];
  return structuredClone(validateEnvelope(value, kind).segments);
}

/**
 * Bounded-memory backup verification: the caller supplies one decrypted
 * segment at a time. No historical records are retained by this verifier.
 * The complete canonical ledger digest AND original domain hash chain must
 * match before finish() succeeds. The caller separately checks ciphertext.
 */
export function createSegmentedLedgerVerifier(rootValue, { kind } = {}) {
  const policy = requirePolicy(kind);
  if (!plainObject(rootValue)) throw problem("SEGMENT_ROOT_INVALID", "加密根存储必须是对象。");
  if (!isEnvelope(rootValue[policy.key])) return null;
  const envelope = validateEnvelope(rootValue[policy.key], kind);
  const keys = [...Object.keys(envelope.ledgerMetadata), policy.recordsKey].sort();
  const recordKeyIndex = keys.indexOf(policy.recordsKey);
  const digest = createHash("sha256");
  const fields = keys.slice(0, recordKeyIndex).map(key => `${JSON.stringify(key)}:${stableStringify(envelope.ledgerMetadata[key])}`);
  digest.update(`{${fields.length ? `${fields.join(",")},` : ""}${JSON.stringify(policy.recordsKey)}:[`);
  let nextSegment = 0, count = 0, finished = false;
  let previousHash = kind === "portfolio" ? "0".repeat(64) : null;
  const acceptRecord = record => {
    if (!plainObject(record)) throw problem("SEGMENT_RECORD_INVALID", "归档记录不是对象。");
    if (recordPreviousHash(record, kind) !== previousHash) throw problem("SEGMENT_CHAIN_MISMATCH", "归档记录链不连续。");
    if (kind === "portfolio") {
      const { integrity, ...body } = record;
      const contentHash = hash(stableStringify(body));
      if (record.sequence !== count + 1 || integrity?.algorithm !== "sha256-chain-v1"
          || integrity.contentHash !== contentHash || integrity.entryHash !== hash(`${previousHash}:${contentHash}`)) {
        throw problem("SEGMENT_RECORD_HASH_MISMATCH", "组合历史记录校验链无效。");
      }
    } else {
      const { recordHash: recordedHash, ...body } = record;
      if (recordedHash !== hash(stableStringify(body))) throw problem("SEGMENT_RECORD_HASH_MISMATCH", "雷达历史记录校验链无效。");
    }
    if (count) digest.update(",");
    digest.update(stableStringify(record));
    previousHash = recordHash(record, kind);
    count++;
  };
  return {
    references: structuredClone(envelope.segments),
    ciphertextBytes: envelope.segments.reduce((sum, reference) => sum + reference.bytes, 0),
    acceptSegment(reference, document) {
      const expected = envelope.segments[nextSegment];
      if (finished || !expected || stableStringify(reference) !== stableStringify(expected)) {
        throw problem("SEGMENT_REFERENCE_INVALID", "备份片段顺序或引用不匹配。");
      }
      exactKeys(document, ["schemaVersion", "kind", "ledgerKey", "recordsKey", "startIndex", "recordCount", "records"]);
      if (document.schemaVersion !== LEDGER_SEGMENT_SCHEMA_VERSION || document.kind !== kind
          || document.ledgerKey !== policy.key || document.recordsKey !== policy.recordsKey
          || document.startIndex !== expected.startIndex || document.recordCount !== expected.recordCount
          || !Array.isArray(document.records) || document.records.length !== expected.recordCount
          || hash(stableStringify(document)) !== expected.contentHash
          || stableStringify(chainSummary(document.records, kind)) !== stableStringify(expected.chain)) {
        throw problem("SEGMENT_CONTENT_MISMATCH", "备份片段内容、范围或链摘要不匹配。");
      }
      for (const record of document.records) acceptRecord(record);
      nextSegment++;
    },
    finish() {
      if (finished || nextSegment !== envelope.segments.length) throw problem("SEGMENT_REFERENCE_INVALID", "备份缺少必要片段或校验已结束。");
      for (const record of envelope.activeRecords) acceptRecord(record);
      digest.update("]");
      for (const key of keys.slice(recordKeyIndex + 1)) digest.update(`,${JSON.stringify(key)}:${stableStringify(envelope.ledgerMetadata[key])}`);
      digest.update("}");
      finished = true;
      const contentHash = digest.digest("hex");
      if (count !== envelope.totalCount || contentHash !== envelope.contentHash) throw problem("SEGMENT_LEDGER_MISMATCH", "备份不能完整重建原账本。");
      if (kind === "portfolio") {
        const metadata = envelope.ledgerMetadata;
        const material = { schemaVersion: metadata.schemaVersion, createdAt: metadata.createdAt,
          updatedAt: metadata.updatedAt, migratedFromVersion: metadata.migratedFromVersion ?? null,
          recordCount: metadata.recordCount, headHash: metadata.headHash };
        if (metadata.schemaVersion !== 2 || metadata.recordCount !== count || metadata.headHash !== previousHash
            || metadata.ledgerHash !== hash(stableStringify(material))) throw problem("SEGMENT_LEDGER_MISMATCH", "组合历史根校验不匹配。");
      } else if (envelope.ledgerMetadata.schemaVersion !== "technical-radar-ledger/v1") {
        throw problem("SEGMENT_LEDGER_MISMATCH", "雷达历史根版本不匹配。");
      }
      return { valid: true, kind, recordCount: count, contentHash, headHash: previousHash };
    },
  };
}

function buildPlan(loaded, kind, policy, retainActiveCount) {
  if (!Number.isSafeInteger(retainActiveCount) || retainActiveCount < 0) {
    throw problem("ARCHIVE_SELECTION_INVALID", "需要明确指定保留在活跃账本的记录数量。");
  }
  const ledger = ledgerObject(loaded.ledger, policy);
  const archivedCount = loaded.envelope?.archivedCount ?? 0;
  const activeCount = ledger[policy.recordsKey].length - archivedCount;
  const archiveCount = Math.max(0, activeCount - retainActiveCount);
  const plan = {
    schemaVersion: "ledger-archive-plan/v1", kind,
    revision: loaded.envelope?.revision ?? 0, contentHash: loaded.contentHash,
    retainActiveCount, archiveCount, archivedCount,
    before: measure(ledger, policy.recordsKey, archivedCount),
    after: measure(ledger, policy.recordsKey, archivedCount + archiveCount),
  };
  return { ...plan, planHash: hash(stableStringify(plan)) };
}

function buildEnvelope(ledger, kind, policy, segments, revision) {
  const archivedCount = segments.reduce((sum, ref) => sum + ref.recordCount, 0);
  const { [policy.recordsKey]: records, ...ledgerMetadata } = ledger;
  return validateEnvelope({
    schemaVersion: SEGMENTED_LEDGER_SCHEMA_VERSION, kind,
    ledgerKey: policy.key, recordsKey: policy.recordsKey,
    revision, contentHash: hash(stableStringify(ledger)),
    ledgerMetadata, segments: structuredClone(segments),
    activeRecords: records.slice(archivedCount), archivedCount, totalCount: records.length,
  }, kind);
}

function validateEnvelope(value, kind) {
  const policy = requirePolicy(kind);
  exactKeys(value, ["schemaVersion", "kind", "ledgerKey", "recordsKey", "revision", "contentHash",
    "ledgerMetadata", "segments", "activeRecords", "archivedCount", "totalCount"]);
  if (value.schemaVersion !== SEGMENTED_LEDGER_SCHEMA_VERSION || value.kind !== kind
      || value.ledgerKey !== policy.key || value.recordsKey !== policy.recordsKey
      || !positiveInteger(value.revision) || !HASH.test(value.contentHash)
      || !plainObject(value.ledgerMetadata) || Object.hasOwn(value.ledgerMetadata, policy.recordsKey)
      || !Array.isArray(value.segments) || !value.segments.length || value.segments.length > MAX_SEGMENTS
      || !Array.isArray(value.activeRecords) || !positiveInteger(value.archivedCount)
      || !Number.isSafeInteger(value.totalCount) || value.totalCount !== value.archivedCount + value.activeRecords.length) {
    throw problem("SEGMENT_MANIFEST_INVALID", "分段账本清单结构或版本无效。");
  }
  let expectedStart = 0, previous = null;
  const names = new Set();
  for (const reference of value.segments) {
    exactKeys(reference, ["name", "sha256", "bytes", "kind", "startIndex", "recordCount", "contentHash", "chain"]);
    const match = typeof reference.name === "string" && reference.name.match(LEDGER_SEGMENT_NAME_PATTERN);
    if (!match || reference.sha256 !== match[1] || names.has(reference.name)
        || reference.kind !== kind || reference.startIndex !== expectedStart
        || !positiveInteger(reference.recordCount) || !positiveInteger(reference.bytes) || reference.bytes > MAX_SEGMENT_BYTES
        || !HASH.test(reference.contentHash)) throw problem("SEGMENT_REFERENCE_INVALID", "归档片段引用、顺序或大小无效。");
    exactKeys(reference.chain, ["previousHash", "firstRecordHash", "lastRecordHash"]);
    if (!HASH.test(reference.chain.firstRecordHash) || !HASH.test(reference.chain.lastRecordHash)
        || !(reference.chain.previousHash === null || HASH.test(reference.chain.previousHash))
        || (previous !== null && reference.chain.previousHash !== previous)) {
      throw problem("SEGMENT_CHAIN_MISMATCH", "归档片段的链边界不连续。");
    }
    previous = reference.chain.lastRecordHash;
    expectedStart += reference.recordCount;
    if (!Number.isSafeInteger(expectedStart)) throw problem("SEGMENT_REFERENCE_INVALID", "归档记录数量无效。");
    names.add(reference.name);
  }
  if (expectedStart !== value.archivedCount
      || (value.activeRecords.length && recordPreviousHash(value.activeRecords[0], kind) !== previous)) {
    throw problem("SEGMENT_CHAIN_MISMATCH", "归档与活跃账本的边界不连续。");
  }
  return cloneJson(value);
}

function assertArchivedPrefix(loaded, ledger, policy) {
  if (!loaded.envelope) return;
  const archivedCount = loaded.envelope.archivedCount;
  if (ledger[policy.recordsKey].length < archivedCount
      || stableStringify(ledger[policy.recordsKey].slice(0, archivedCount))
        !== stableStringify(loaded.ledger[policy.recordsKey].slice(0, archivedCount))) {
    throw problem("SEGMENT_HISTORY_IMMUTABLE", "更新改变或遗漏了已归档记录；历史保持不变。");
  }
}

function measure(ledger, recordsKey, archivedCount) {
  const activeLedger = archivedCount ? { ...ledger, [recordsKey]: ledger[recordsKey].slice(archivedCount) } : ledger;
  return { totalCount: ledger[recordsKey].length, archivedCount,
    activeCount: ledger[recordsKey].length - archivedCount,
    activeBytes: Buffer.byteLength(JSON.stringify(activeLedger)), totalBytes: Buffer.byteLength(JSON.stringify(ledger)) };
}
function emptyMeasure() { return { totalCount: 0, archivedCount: 0, activeCount: 0, activeBytes: 0, totalBytes: 0 }; }
function ledgerObject(value, policy) {
  if (!plainObject(value) || !Array.isArray(value[policy.recordsKey]) || isEnvelope(value)) {
    throw problem("SEGMENT_LEDGER_INVALID", "归档需要完整的原始领域账本。");
  }
  return cloneJson(value);
}
function chainSummary(records, kind) {
  const value = { previousHash: recordPreviousHash(records[0], kind),
    firstRecordHash: recordHash(records[0], kind), lastRecordHash: recordHash(records.at(-1), kind) };
  if (!(value.previousHash === null || HASH.test(value.previousHash)) || !HASH.test(value.firstRecordHash) || !HASH.test(value.lastRecordHash)) {
    throw problem("SEGMENT_CHAIN_INVALID", "账本缺少原始链摘要；请先校验或迁移账本。");
  }
  return value;
}
function recordPreviousHash(record, kind) { return kind === "portfolio" ? record?.integrity?.previousHash : record?.previousHash; }
function recordHash(record, kind) { return kind === "portfolio" ? record?.integrity?.entryHash : record?.recordHash; }
function isEnvelope(value) { return typeof value?.schemaVersion === "string" && value.schemaVersion.startsWith("segmented-encrypted-ledger/"); }
function requirePolicy(kind) {
  if (!Object.hasOwn(SEGMENTED_LEDGER_POLICIES, kind)) throw new TypeError("Unsupported segmented ledger kind.");
  return SEGMENTED_LEDGER_POLICIES[kind];
}
function plainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) {
  if (!plainObject(value) || stableStringify(Object.keys(value).sort()) !== stableStringify([...keys].sort())) {
    throw problem("SEGMENT_MANIFEST_INVALID", "分段账本包含缺失或未知字段。");
  }
}
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
function cloneJson(value) {
  const bytes = JSON.stringify(value, (_key, item) => {
    if (typeof item === "number" && !Number.isFinite(item)) throw new TypeError("Non-finite ledger evidence.");
    if (["bigint", "function", "symbol"].includes(typeof item)) throw new TypeError("Non-JSON ledger value.");
    return item;
  });
  if (bytes === undefined) throw new TypeError("Expected JSON ledger value.");
  return JSON.parse(bytes);
}
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function problem(code, message, cause) { const error = new Error(message, cause ? { cause } : undefined); error.code = code; return error; }
