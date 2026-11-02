import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, renameSync, rmSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  inspectPersistedAccountScope,
  isOpaqueBrokerAccountScopeId,
} from "../data/account-scope-identity.mjs";
import { createSegmentedLedgerVerifier, LEDGER_SEGMENT_NAME_PATTERN } from "./segmented-ledger-store.mjs";

/**
 * Trusted encrypted-state backup bundle.
 *
 * The bundle copies Electron safeStorage ciphertext verbatim. It is therefore
 * intended for a desktop profile that can still decrypt the original files;
 * it never decrypts, exports or invents credentials. Integrity hashes detect
 * corruption and incomplete copies, but are not an authenticity signature.
 */

export const TRUSTED_BACKUP_SCHEMA_VERSION = "trading-cockpit-trusted-backup/v4";
const LEGACY_SCHEMA_VERSION = "trading-cockpit-trusted-backup/v2";
const PREVIOUS_SCHEMA_VERSION = "trading-cockpit-trusted-backup/v3";
export const TRUSTED_BACKUP_MANIFEST_FILE = "manifest.json";
export const TRUSTED_BACKUP_PAYLOAD_DIRECTORY = "payload";

export const TRUSTED_BACKUP_LIMITS = Object.freeze({
  maxManifestBytes: 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  maxFiles: 2048,
});

export const TRUSTED_BACKUP_FILE_POLICY = Object.freeze({
  "review-data.bin": Object.freeze({ role: "review_workspace" }),
  "market-history.bin": Object.freeze({ role: "market_history" }),
  "portfolio-snapshots.bin": Object.freeze({ role: "portfolio_snapshot_ledger" }),
  "technical-radar.bin": Object.freeze({ role: "technical_radar" }),
  "business-state.bin": Object.freeze({ role: "application_business_index" }),
});

export const TRUSTED_BACKUP_EXCLUDED_STATE = Object.freeze([
  Object.freeze({
    name: "secure-state.bin",
    reason: "contains_oauth_pkce_codex_session_and_runtime_secrets",
  }),
]);

const APPLICATION_ID = "com.gawei.trading-cockpit";
const EXPORT_POLICY_VERSION = "encrypted-business-state-referenced-segments/v3";
const RESTORE_POLICY_VERSION = "validate-immutable-segments-before-atomic-roots/v4";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ALLOWED_FILE_NAMES = Object.freeze(Object.keys(TRUSTED_BACKUP_FILE_POLICY));
const ALLOWED_FILE_NAME_SET = new Set(ALLOWED_FILE_NAMES);
const LEGACY_FILE_NAMES = Object.freeze(ALLOWED_FILE_NAMES.filter(name => name !== "business-state.bin"));
const LIVE_STAGES = new WeakSet();
const SEGMENT_ROLE = "immutable_ledger_segment";
const LEDGER_ROOT_KINDS = Object.freeze({ "portfolio-snapshots.bin": "portfolio", "technical-radar.bin": "radar" });

const SECURITY_MANIFEST = Object.freeze({
  payloadFormat: "electron-safe-storage-ciphertext",
  portability: "same-safe-storage-identity-required",
  credentialsIncluded: false,
  excludedStateFiles: Object.freeze(TRUSTED_BACKUP_EXCLUDED_STATE.map((item) => item.name)),
  excludedDataClasses: Object.freeze([
    "oauth_tokens",
    "oauth_pkce_material",
    "client_registration_secrets",
    "codex_session_credentials",
  ]),
});

const PROVENANCE_MANIFEST = Object.freeze({
  producer: "trading-cockpit-desktop",
  manifestVersion: TRUSTED_BACKUP_SCHEMA_VERSION,
  hashAlgorithm: "sha256",
  hashSubject: "encrypted_file_bytes",
  exportPolicyVersion: EXPORT_POLICY_VERSION,
  restorePolicyVersion: RESTORE_POLICY_VERSION,
});
const LEGACY_PROVENANCE_MANIFEST = Object.freeze({
  ...PROVENANCE_MANIFEST,
  manifestVersion: LEGACY_SCHEMA_VERSION,
  exportPolicyVersion: "encrypted-business-state-allowlist/v1",
  restorePolicyVersion: "decrypt-validate-explicit-slots-transactional-atomic-replace/v2",
});
const PREVIOUS_PROVENANCE_MANIFEST = Object.freeze({
  ...PROVENANCE_MANIFEST, manifestVersion: PREVIOUS_SCHEMA_VERSION,
  exportPolicyVersion: "encrypted-business-state-allowlist/v2",
  restorePolicyVersion: "decrypt-validate-explicit-slots-transactional-atomic-replace/v3",
});

const isMutation = item => ["create", "replace", "delete"].includes(item.operation);

export class TrustedBackupError extends Error {
  constructor(code, message, details = null, options = undefined) {
    super(message, options);
    this.name = "TrustedBackupError";
    this.code = code;
    if (details) this.details = details;
  }
}

/**
 * Export the fixed business roots and only their referenced immutable segments.
 *
 * Payloads are checked and staged one file at a time before the destination
 * is published. The host must quiesce writers. A destination is never
 * overwritten; identical repeated exports are idempotent.
 */
export async function createTrustedBackupBundle({
  sourceDirectory,
  destinationDirectory,
  appVersion,
  accountScope,
  createdAt = new Date(),
  validatePayload,
  commitGuard = null,
}) {
  assertRestoreCommitGuard(commitGuard);
  const source = requiredDirectoryPath(sourceDirectory, "sourceDirectory");
  const destination = requiredDirectoryPath(destinationDirectory, "destinationDirectory");
  if (sameOrNestedPath(source, destination) || sameOrNestedPath(destination, source)) {
    throw backupError("INVALID_PATH", "备份源目录与目标目录不得相同或相互嵌套。");
  }
  await assertExistingRealDirectory(source, "备份源目录");
  const version = normalizeAppVersion(appVersion);
  const scope = verifiedOpaqueScope(accountScope);
  const timestamp = normalizeCreatedAt(createdAt);

  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const stagingDirectory = await mkdtemp(path.join(path.dirname(destination), ".trusted-backup-export-"));
  try {
    const payloadDirectory = path.join(stagingDirectory, TRUSTED_BACKUP_PAYLOAD_DIRECTORY);
    await mkdir(payloadDirectory, { mode: 0o700 });
    const payloads = await processPayloadGraph({ directory: source, validatePayload,
      version: TRUSTED_BACKUP_SCHEMA_VERSION, copyTo: payloadDirectory });
    if (!payloads.length) throw backupError("NO_BACKUP_DATA", "没有找到可备份的加密业务状态文件。");
    const manifest = buildManifest({ version, scope, timestamp, payloads,
      absentFiles: ALLOWED_FILE_NAMES.filter(name => !payloads.some(item => item.name === name)) });
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    if (manifestBytes.length > TRUSTED_BACKUP_LIMITS.maxManifestBytes) throw backupError("SIZE_LIMIT", "备份清单超过安全上限。");
    await writeDurableFile(path.join(stagingDirectory, TRUSTED_BACKUP_MANIFEST_FILE), manifestBytes);
    syncDirectory(payloadDirectory);
    syncDirectory(stagingDirectory);
    if (await optionalLstat(destination)) {
      if (await existingBundleMatches({ destination, manifestBytes, payloads })) {
        assertRestoreCommitGuard(commitGuard);
        return exportResult({ destination, manifest, created: false, idempotent: true });
      }
      throw backupError("DESTINATION_EXISTS", "目标位置已有不同备份，已拒绝覆盖。");
    }
    try {
      // No asynchronous boundary between identity validation and publication.
      // Stale export work may leave a private staging directory only, never a
      // newly published backup carrying the superseding account's identity.
      assertRestoreCommitGuard(commitGuard);
      renameSync(stagingDirectory, destination);
      syncDirectory(path.dirname(destination));
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY"].includes(error?.code)) {
        const idempotent = await existingBundleMatches({ destination, manifestBytes, payloads });
        if (idempotent) {
          assertRestoreCommitGuard(commitGuard);
          return exportResult({ destination, manifest, created: false, idempotent: true });
        }
        throw backupError("DESTINATION_EXISTS", "目标位置已被其他备份占用，已拒绝覆盖。", null, error);
      }
      throw error;
    }
    return exportResult({ destination, manifest, created: true, idempotent: false });
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

/** Local read-only preflight; describes exact referenced ciphertext, never orphan files. */
export async function describeTrustedBackupSource({ sourceDirectory, validatePayload } = {}) {
  const directory = requiredDirectoryPath(sourceDirectory, "sourceDirectory");
  await assertExistingRealDirectory(directory, "备份源目录");
  let references = [];
  const files = await processPayloadGraph({ directory, version: TRUSTED_BACKUP_SCHEMA_VERSION,
    validatePayload, onReferences: value => { references = value; } });
  return deepFreeze({ schemaVersion: TRUSTED_BACKUP_SCHEMA_VERSION, fileCount: files.length,
    ciphertextBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files, references, limits: { ...TRUSTED_BACKUP_LIMITS } });
}

/**
 * Validate a bundle into an isolated temporary directory and return a dry-run
 * plan. This function never creates or modifies target state files.
 */
export async function stageTrustedBackupRestore({
  bundleDirectory,
  targetDirectory,
  expectedAccountScope,
  temporaryRoot = os.tmpdir(),
  validatePayload,
}) {
  const bundle = requiredDirectoryPath(bundleDirectory, "bundleDirectory");
  const target = requiredDirectoryPath(targetDirectory, "targetDirectory");
  const temporary = requiredDirectoryPath(temporaryRoot, "temporaryRoot");
  if (sameOrNestedPath(bundle, target) || sameOrNestedPath(target, bundle)) {
    throw backupError("INVALID_PATH", "备份目录与恢复目标不得相同或相互嵌套。");
  }
  const expectedScope = verifiedOpaqueScope(expectedAccountScope);
  const verified = await readVerifiedBundle(bundle);
  if (verified.manifest.accountScope.opaqueScopeId !== expectedScope.opaqueScopeId) {
    throw backupError("ACCOUNT_SCOPE_MISMATCH", "备份所属账户范围与当前已验证账户不一致，已拒绝恢复。", {
      backupOpaqueScope: verified.manifest.accountScope.opaqueScopeId,
      expectedOpaqueScope: expectedScope.opaqueScopeId,
    });
  }
  if (typeof validatePayload !== "function") {
    throw backupError("PAYLOAD_VALIDATOR_REQUIRED", "恢复前必须验证当前系统能够解密并解析全部业务状态文件。");
  }
  await assertOptionalRealDirectory(target, "恢复目标目录");
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  const stagingDirectory = await mkdtemp(path.join(temporary, "trading-cockpit-restore-"));
  try {
    const stagedPayloadDirectory = path.join(stagingDirectory, TRUSTED_BACKUP_PAYLOAD_DIRECTORY);
    await mkdir(stagedPayloadDirectory, { mode: 0o700 });
    await processPayloadGraph({ directory: verified.payloadDirectory, expectedFiles: verified.files,
      version: verified.manifest.schemaVersion, validatePayload, copyTo: stagedPayloadDirectory });
    await writeDurableFile(
      path.join(stagingDirectory, TRUSTED_BACKUP_MANIFEST_FILE),
      verified.manifestBytes,
    );

    const operations = [];
    const verifiedByName = new Map(verified.files.map((entry) => [entry.name, entry]));
    for (const name of [...verified.files.filter(item => isSegmentName(item.name)).map(item => item.name), ...ALLOWED_FILE_NAMES]) {
      const entry = verifiedByName.get(name) ?? null;
      const existing = await readOptionalStableRegularFile(directChild(target, name), {
        maxBytes: TRUSTED_BACKUP_LIMITS.maxFileBytes,
        label: `现有状态文件 ${name}`,
      });
      const before = existing
        ? { exists: true, bytes: existing.length, sha256: sha256(existing) }
        : { exists: false, bytes: 0, sha256: null };
      // An absent application index is never a tombstone: v2 did not define
      // this slot, and deleting it would defeat the migration receipt guard.
      const preserve = !entry && name === "business-state.bin";
      if (isSegmentName(name) && existing && (before.sha256 !== entry.sha256 || before.bytes !== entry.bytes)) {
        throw backupError("IMMUTABLE_SEGMENT_CONFLICT", "目标存在内容不匹配的同名归档片段；未覆盖任何文件。");
      }
      const operation = preserve ? "preserve" : entry
        ? before.sha256 === entry.sha256 && before.bytes === entry.bytes
          ? "unchanged"
          : before.exists ? "replace" : "create"
        : before.exists ? "delete" : "unchanged";
      operations.push(Object.freeze({
        name,
        role: fileRole(name),
        operation,
        before: Object.freeze(before),
        after: Object.freeze(preserve ? { ...before } : entry
          ? { exists: true, bytes: entry.bytes, sha256: entry.sha256 }
          : { exists: false, bytes: 0, sha256: null }),
      }));
    }

    const plan = deepFreeze({
      status: "ready",
      dryRun: true,
      schemaVersion: TRUSTED_BACKUP_SCHEMA_VERSION,
      bundleManifestSha256: sha256(verified.manifestBytes),
      createdAt: verified.manifest.createdAt,
      applicationVersion: verified.manifest.application.version,
      accountScope: { ...verified.manifest.accountScope },
      credentialsIncluded: false,
      targetDirectory: target,
      wouldChange: operations.some(isMutation),
      operations,
      limitations: [
        "ciphertext_requires_same_safe_storage_identity",
        "sha256_integrity_does_not_authenticate_bundle_author",
        "unreferenced_existing_segments_are_preserved",
      ],
    });
    const staged = Object.freeze({
      kind: "trusted-backup-staged-restore/v1",
      bundleDirectory: bundle,
      targetDirectory: target,
      stagingDirectory,
      plan,
      manifest: deepFreeze(cloneJson(verified.manifest)),
    });
    LIVE_STAGES.add(staged);
    return staged;
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Apply a previously validated plan. Every replacement uses a same-directory
 * atomic rename. Originals are copied aside before the commit and rolled back
 * if any rename fails; validation and concurrent-target checks finish before
 * the first target file is touched.
 */
export async function applyStagedTrustedBackupRestore(staged, { commitGuard = null } = {}) {
  assertLiveStage(staged);
  assertRestoreCommitGuard(commitGuard);
  const verified = await readVerifiedBundle(staged.stagingDirectory);
  if (sha256(verified.manifestBytes) !== staged.plan.bundleManifestSha256) {
    throw backupError("STAGE_TAMPERED", "临时恢复区清单已变化，已拒绝恢复。");
  }
  if (verified.manifest.accountScope.opaqueScopeId !== staged.plan.accountScope.opaqueScopeId) {
    throw backupError("STAGE_TAMPERED", "临时恢复区账户范围已变化，已拒绝恢复。");
  }
  await assertOptionalRealDirectory(staged.targetDirectory, "恢复目标目录");

  const actions = [];
  const verifiedByName = new Map(verified.files.map((entry) => [entry.name, entry]));
  for (const planned of staged.plan.operations) {
    if (planned.operation === "preserve") continue;
    const entry = verifiedByName.get(planned.name) ?? null;
    const current = await readOptionalStableRegularFile(directChild(staged.targetDirectory, planned.name), {
      maxBytes: TRUSTED_BACKUP_LIMITS.maxFileBytes,
      label: `现有状态文件 ${planned.name}`,
    });
    const fingerprint = current
      ? { exists: true, bytes: current.length, sha256: sha256(current) }
      : { exists: false, bytes: 0, sha256: null };
    const alreadyAfter = entry
      ? fingerprint.sha256 === entry.sha256 && fingerprint.bytes === entry.bytes
      : !fingerprint.exists;
    if (alreadyAfter) {
      actions.push({
        entry: entry ?? { name: planned.name, role: planned.role, payload: null },
        operation: "unchanged",
        fingerprint,
      });
      continue;
    }
    if (isSegmentName(planned.name) && fingerprint.exists) {
      throw backupError("IMMUTABLE_SEGMENT_CONFLICT", "目标存在内容不匹配的同名归档片段；未覆盖任何文件。");
    }
    if (!sameFingerprint(fingerprint, planned.before)) {
      throw backupError("TARGET_CHANGED", `状态文件 ${planned.name} 在 dry-run 后发生变化，已拒绝恢复。`);
    }
    actions.push({
      entry: entry ?? { name: planned.name, role: planned.role, payload: null },
      operation: entry ? fingerprint.exists ? "replace" : "create" : "delete",
      fingerprint,
    });
  }

  const mutations = actions.filter((item) => item.operation !== "unchanged");
  if (!mutations.length) {
    assertRestoreCommitGuard(commitGuard);
    return deepFreeze({
      ok: true,
      changed: false,
      idempotent: true,
      restoredFiles: [],
      removedFiles: [],
      accountScope: { ...staged.plan.accountScope },
      schemaVersion: TRUSTED_BACKUP_SCHEMA_VERSION,
    });
  }

  await mkdir(staged.targetDirectory, { recursive: true, mode: 0o700 });
  const transactionId = randomUUID();
  const prepared = [];
  try {
    // Prepare all new ciphertext and rollback copies before the first commit.
    for (const action of mutations) {
      const targetPath = directChild(staged.targetDirectory, action.entry.name);
      const newPath = action.operation === "delete" ? null : directChild(
        staged.targetDirectory,
        `.trusted-restore-${transactionId}-${action.entry.name}.new`,
      );
      const oldPath = directChild(
        staged.targetDirectory,
        `.trusted-restore-${transactionId}-${action.entry.name}.old`,
      );
      const preparedItem = { ...action, targetPath, newPath, oldPath, installed: false };
      prepared.push(preparedItem);
      if (newPath) {
        const payload = await readExpectedPayload(verified.payloadDirectory, action.entry);
        await writeDurableFile(newPath, payload);
      }
      if (action.fingerprint.exists) {
        const current = await readStableRegularFile(targetPath, { maxBytes: TRUSTED_BACKUP_LIMITS.maxFileBytes, label: "恢复前原文件" });
        if (sha256(current) !== action.fingerprint.sha256 || current.length !== action.fingerprint.bytes) {
          throw backupError("TARGET_CHANGED", "恢复前原文件已变化，未提交。");
        }
        await writeDurableFile(oldPath, current);
      }
    }

    // Narrow the dry-run/apply race: target writers must still be quiesced by
    // the integration, but no commit starts if a file changed while the
    // transaction copies were being prepared.
    for (const item of prepared) {
      const current = await readOptionalStableRegularFile(item.targetPath, {
        maxBytes: TRUSTED_BACKUP_LIMITS.maxFileBytes,
        label: `现有状态文件 ${item.entry.name}`,
      });
      const fingerprint = current
        ? { exists: true, bytes: current.length, sha256: sha256(current) }
        : { exists: false, bytes: 0, sha256: null };
      if (!sameFingerprint(fingerprint, item.fingerprint)) {
        throw backupError("TARGET_CHANGED", `状态文件 ${item.entry.name} 在恢复准备期间发生变化，已拒绝提交。`);
      }
    }

    // The account/authorization guard and the short multi-file commit have
    // no asynchronous gap. Integration keeps all writers paused until exit.
    assertRestoreCommitGuard(commitGuard);
    let segmentDirectorySynced = false;
    for (const item of prepared) {
      if (isSegmentName(item.entry.name)) {
        // Never replace an immutable file. New orphan segments are harmless
        // if a later root commit fails, and are deliberately retained.
        linkSync(item.newPath, item.targetPath);
        item.installed = true;
        continue;
      }
      if (!segmentDirectorySynced && prepared.some(value => isSegmentName(value.entry.name))) {
        syncDirectory(staged.targetDirectory);
        segmentDirectorySynced = true;
      }
      if (item.operation === "delete") rmSync(item.targetPath, { force: true });
      else renameSync(item.newPath, item.targetPath);
      item.installed = true;
    }
    if (!segmentDirectorySynced && prepared.some(value => isSegmentName(value.entry.name))) syncDirectory(staged.targetDirectory);
  } catch (error) {
    const rollbackFailures = [];
    for (const item of [...prepared].reverse()) {
      try {
        if (isSegmentName(item.entry.name)) continue;
        if (item.installed && item.fingerprint.exists) await rename(item.oldPath, item.targetPath);
        else if (item.installed) await rm(item.targetPath, { force: true });
      } catch (rollbackError) {
        rollbackFailures.push({ name: item.entry.name, recoveryPath: item.oldPath, error: rollbackError });
      }
    }
    for (const item of prepared) {
      if (item.newPath) await rm(item.newPath, { force: true }).catch(() => {});
      if (!rollbackFailures.some((failure) => failure.name === item.entry.name)) {
        await rm(item.oldPath, { force: true }).catch(() => {});
      }
    }
    if (rollbackFailures.length) {
      throw backupError(
        "RESTORE_ROLLBACK_FAILED",
        "恢复提交失败，且部分原文件需要从保留的 recoveryPath 手动恢复。",
        { recovery: rollbackFailures.map(({ name, recoveryPath }) => ({ name, recoveryPath })) },
        error,
      );
    }
    throw backupError("RESTORE_COMMIT_FAILED", "恢复提交失败；原状态文件已回滚。", null, error);
  }

  const cleanupWarnings = [];
  for (const item of prepared) {
    try {
      if (item.newPath && isSegmentName(item.entry.name)) await rm(item.newPath, { force: true });
      await rm(item.oldPath, { force: true });
    } catch {
      cleanupWarnings.push(`保留了恢复前副本：${item.oldPath}`);
    }
  }
  return deepFreeze({
    ok: true,
    changed: true,
    idempotent: false,
    restoredFiles: mutations.filter((item) => item.operation !== "delete").map((item) => item.entry.name),
    removedFiles: mutations.filter((item) => item.operation === "delete").map((item) => item.entry.name),
    accountScope: { ...staged.plan.accountScope },
    schemaVersion: TRUSTED_BACKUP_SCHEMA_VERSION,
    cleanupWarnings,
  });
}

export async function discardStagedTrustedBackupRestore(staged) {
  assertLiveStage(staged);
  LIVE_STAGES.delete(staged);
  await rm(staged.stagingDirectory, { recursive: true, force: true });
}

async function readVerifiedBundle(bundleDirectory) {
  await assertExistingRealDirectory(bundleDirectory, "备份目录");
  const rootEntries = await readdir(bundleDirectory, { withFileTypes: true });
  assertExactEntrySet(rootEntries, [TRUSTED_BACKUP_MANIFEST_FILE, TRUSTED_BACKUP_PAYLOAD_DIRECTORY], "备份根目录");
  const manifestEntry = rootEntries.find((item) => item.name === TRUSTED_BACKUP_MANIFEST_FILE);
  const payloadEntry = rootEntries.find((item) => item.name === TRUSTED_BACKUP_PAYLOAD_DIRECTORY);
  if (!manifestEntry?.isFile() || manifestEntry.isSymbolicLink()) {
    throw backupError("INVALID_BUNDLE", "备份清单必须是普通文件且不能是符号链接。");
  }
  if (!payloadEntry?.isDirectory() || payloadEntry.isSymbolicLink()) {
    throw backupError("INVALID_BUNDLE", "备份 payload 必须是真实目录且不能是符号链接。");
  }

  const manifestPath = path.join(bundleDirectory, TRUSTED_BACKUP_MANIFEST_FILE);
  const manifestBytes = await readStableRegularFile(manifestPath, {
    maxBytes: TRUSTED_BACKUP_LIMITS.maxManifestBytes,
    label: "备份清单",
  });
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw backupError("INVALID_MANIFEST", "备份清单不是有效 JSON。", null, error);
  }
  validateManifest(manifest);

  const payloadDirectory = path.join(bundleDirectory, TRUSTED_BACKUP_PAYLOAD_DIRECTORY);
  const payloadEntries = await readdir(payloadDirectory, { withFileTypes: true });
  assertExactEntrySet(payloadEntries, manifest.files.map((item) => item.name), "备份 payload 目录");

  let totalBytes = 0;
  const files = [];
  for (const expected of manifest.files) {
    const dirent = payloadEntries.find((item) => item.name === expected.name);
    if (!dirent?.isFile() || dirent.isSymbolicLink()) {
      throw backupError("INVALID_BUNDLE", `备份状态文件 ${expected.name} 必须是普通文件且不能是符号链接。`);
    }
    const payload = await readStableRegularFile(directChild(payloadDirectory, expected.name), {
      maxBytes: TRUSTED_BACKUP_LIMITS.maxFileBytes,
      label: `备份状态文件 ${expected.name}`,
    });
    totalBytes += payload.length;
    if (totalBytes > TRUSTED_BACKUP_LIMITS.maxTotalBytes) {
      throw backupError("SIZE_LIMIT", "备份 payload 总大小超过安全上限。");
    }
    if (payload.length !== expected.bytes || sha256(payload) !== expected.sha256) {
      throw backupError("HASH_MISMATCH", `备份状态文件 ${expected.name} 的大小或 SHA-256 不匹配。`);
    }
    files.push({ ...expected });
  }
  return { manifest, manifestBytes, files, payloadDirectory };
}

/** Read, validate and copy one encrypted file at a time; never retain a whole bundle in RAM. */
async function processPayloadGraph({ directory, expectedFiles = null, version, validatePayload, copyTo, onReferences }) {
  const descriptors = [], verifiers = [], references = new Map();
  const expected = expectedFiles && new Map(expectedFiles.map(item => [item.name, item]));
  let totalBytes = 0;
  const add = entry => {
    totalBytes += entry.bytes;
    if (totalBytes > TRUSTED_BACKUP_LIMITS.maxTotalBytes || descriptors.length + 1 > TRUSTED_BACKUP_LIMITS.maxFiles) {
      throw backupError("SIZE_LIMIT", "备份总大小或文件数超过显式安全上限。");
    }
    descriptors.push(entry);
  };
  for (const name of ALLOWED_FILE_NAMES) {
    if (expected && !expected.has(name)) continue;
    const payload = expected ? await readExpectedPayload(directory, expected.get(name))
      : await readOptionalStableRegularFile(directChild(directory, name), { maxBytes: TRUSTED_BACKUP_LIMITS.maxFileBytes, label: `状态文件 ${name}` });
    if (!payload) continue;
    const entry = { name, role: fileRole(name), bytes: payload.length, sha256: sha256(payload) };
    const kind = LEDGER_ROOT_KINDS[name];
    const result = await validatePayloadValue(validatePayload, entry, payload,
      { requireDocument: Boolean(kind) && version === TRUSTED_BACKUP_SCHEMA_VERSION });
    if (kind && result?.document) {
      const verifier = createSegmentedLedgerVerifier(result.document, { kind });
      if (verifier) {
        if (version !== TRUSTED_BACKUP_SCHEMA_VERSION) throw backupError("SEGMENT_SCHEMA_REQUIRED", "带历史片段的账本必须使用完整 v4 恢复包。");
        for (const reference of verifier.references) {
          if (references.has(reference.name)) throw backupError("SEGMENT_REFERENCE_INVALID", "不同账本不能声明重复的历史片段。");
          references.set(reference.name, { reference, verifier });
        }
        verifiers.push(verifier);
      }
    }
    add(entry);
    if (copyTo) await writeDurableFile(directChild(copyTo, name), payload);
  }
  if (expected) {
    const declared = expectedFiles.filter(item => isSegmentName(item.name)).map(item => item.name).sort();
    if (JSON.stringify(declared) !== JSON.stringify([...references.keys()].sort())) {
      throw backupError("SEGMENT_REFERENCE_MISMATCH", "备份中的历史片段与根账本引用不一致；存在缺段或未引用片段。");
    }
  }
  if (descriptors.length + references.size > TRUSTED_BACKUP_LIMITS.maxFiles
      || totalBytes + [...references.values()].reduce((sum, { reference }) => sum + reference.bytes, 0) > TRUSTED_BACKUP_LIMITS.maxTotalBytes) {
    throw backupError("SIZE_LIMIT", "根账本引用的历史片段超过备份安全上限。");
  }
  for (const [name, { reference, verifier }] of references) {
    const entry = { name, role: SEGMENT_ROLE, bytes: reference.bytes, sha256: reference.sha256 };
    if (expected && (expected.get(name)?.bytes !== entry.bytes || expected.get(name)?.sha256 !== entry.sha256)) {
      throw backupError("SEGMENT_REFERENCE_MISMATCH", "历史片段声明与加密根账本不匹配。");
    }
    const payload = await readExpectedPayload(directory, entry);
    const result = await validatePayloadValue(validatePayload, entry, payload, { requireDocument: true });
    verifier.acceptSegment(reference, result.document);
    add(entry);
    if (copyTo) await writeDurableFile(directChild(copyTo, name), payload);
  }
  for (const verifier of verifiers) verifier.finish();
  onReferences?.([...references.values()].map(({ reference }) => cloneJson(reference)));
  return descriptors;
}

async function validatePayloadValue(validatePayload, entry, payload, { requireDocument = false } = {}) {
  try {
    const result = typeof validatePayload === "function"
      ? await validatePayload({ name: entry.name, role: entry.role, payload }) : null;
    if (result === false) throw new Error("payload validator rejected the state file");
    if (requireDocument && (!result?.document || typeof result.document !== "object" || Array.isArray(result.document))) {
      throw backupError("PAYLOAD_DOCUMENT_REQUIRED", "完整备份需要解密后的账本或片段文档，不能只返回校验通过。");
    }
    return result;
  } catch (error) {
    if (error?.code === "PAYLOAD_DOCUMENT_REQUIRED") throw error;
    throw backupError("PAYLOAD_UNREADABLE", `当前系统无法解密或解析备份状态文件 ${entry.name}，恢复已在覆盖前停止。`,
      { name: entry.name, role: entry.role }, error);
  }
}

async function readExpectedPayload(directory, entry) {
  const payload = await readStableRegularFile(directChild(directory, entry.name), {
    maxBytes: TRUSTED_BACKUP_LIMITS.maxFileBytes, label: `状态文件 ${entry.name}`,
  });
  if (payload.length !== entry.bytes || sha256(payload) !== entry.sha256) {
    throw backupError("HASH_MISMATCH", `状态文件 ${entry.name} 的大小或 SHA-256 不匹配。`);
  }
  return payload;
}

function isSegmentName(name) { return typeof name === "string" && LEDGER_SEGMENT_NAME_PATTERN.test(name); }
function fileRole(name) { return isSegmentName(name) ? SEGMENT_ROLE : TRUSTED_BACKUP_FILE_POLICY[name]?.role; }
function syncDirectory(directory) {
  const descriptor = openSync(directory, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function buildManifest({ version, scope, timestamp, payloads, absentFiles }) {
  return {
    schemaVersion: TRUSTED_BACKUP_SCHEMA_VERSION,
    application: {
      id: APPLICATION_ID,
      version,
    },
    createdAt: timestamp,
    accountScope: {
      status: "verified_opaque",
      opaqueScopeId: scope.opaqueScopeId,
    },
    files: payloads.map(({ name, role, bytes, sha256: digest }) => ({
      name,
      role,
      bytes,
      sha256: digest,
    })),
    absentFiles: absentFiles.map((name) => ({
      name,
      role: TRUSTED_BACKUP_FILE_POLICY[name].role,
    })),
    security: cloneJson(SECURITY_MANIFEST),
    provenance: cloneJson(PROVENANCE_MANIFEST),
  };
}

function validateManifest(manifest) {
  assertPlainObject(manifest, "备份清单");
  assertExactKeys(manifest, [
    "accountScope",
    "absentFiles",
    "application",
    "createdAt",
    "files",
    "provenance",
    "schemaVersion",
    "security",
  ], "备份清单");
  const legacy = manifest.schemaVersion === LEGACY_SCHEMA_VERSION;
  const previous = manifest.schemaVersion === PREVIOUS_SCHEMA_VERSION;
  const segmented = manifest.schemaVersion === TRUSTED_BACKUP_SCHEMA_VERSION;
  if (!segmented && !legacy && !previous) {
    throw backupError("UNSUPPORTED_VERSION", "备份清单版本未知，已拒绝恢复。");
  }

  assertPlainObject(manifest.application, "application");
  assertExactKeys(manifest.application, ["id", "version"], "application");
  if (manifest.application.id !== APPLICATION_ID) {
    throw backupError("INVALID_MANIFEST", "备份来源应用不受支持。");
  }
  normalizeAppVersion(manifest.application.version);
  normalizeCreatedAt(manifest.createdAt);

  assertPlainObject(manifest.accountScope, "accountScope");
  assertExactKeys(manifest.accountScope, ["opaqueScopeId", "status"], "accountScope");
  if (
    manifest.accountScope.status !== "verified_opaque"
    || !isOpaqueBrokerAccountScopeId(manifest.accountScope.opaqueScopeId)
  ) {
    throw backupError("INVALID_ACCOUNT_SCOPE", "备份缺少已验证的不透明账户范围。");
  }

  if (!Array.isArray(manifest.files) || !manifest.files.length) {
    throw backupError("INVALID_MANIFEST", "备份清单没有状态文件。");
  }
  if (manifest.files.length > (segmented ? TRUSTED_BACKUP_LIMITS.maxFiles : 5)) {
    throw backupError("SIZE_LIMIT", "备份状态文件数量超过安全上限。");
  }
  const seen = new Set();
  let declaredTotal = 0;
  for (const entry of manifest.files) {
    assertPlainObject(entry, "files[]");
    assertExactKeys(entry, ["bytes", "name", "role", "sha256"], "files[]");
    assertAllowedFileName(entry.name, { allowSegment: segmented });
    if (seen.has(entry.name)) throw backupError("INVALID_MANIFEST", "备份清单包含重复状态文件。");
    seen.add(entry.name);
    if (entry.role !== fileRole(entry.name)) {
      throw backupError("INVALID_MANIFEST", `状态文件 ${entry.name} 的角色声明无效。`);
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw backupError("INVALID_MANIFEST", `状态文件 ${entry.name} 的字节数无效。`);
    }
    if (entry.bytes > TRUSTED_BACKUP_LIMITS.maxFileBytes) {
      throw backupError("SIZE_LIMIT", `状态文件 ${entry.name} 超过安全大小上限。`);
    }
    if (!SHA256_PATTERN.test(entry.sha256)) {
      throw backupError("INVALID_MANIFEST", `状态文件 ${entry.name} 的 SHA-256 无效。`);
    }
    if (isSegmentName(entry.name) && entry.sha256 !== entry.name.match(LEDGER_SEGMENT_NAME_PATTERN)[1]) {
      throw backupError("HASH_MISMATCH", "归档片段文件名必须与密文 SHA-256 一致。");
    }
    declaredTotal += entry.bytes;
  }
  if (declaredTotal > TRUSTED_BACKUP_LIMITS.maxTotalBytes) {
    throw backupError("SIZE_LIMIT", "备份清单声明的总大小超过安全上限。");
  }

  if (!Array.isArray(manifest.absentFiles)) {
    throw backupError("INVALID_MANIFEST", "备份清单缺少显式的空状态槽位。");
  }
  for (const entry of manifest.absentFiles) {
    assertPlainObject(entry, "absentFiles[]");
    assertExactKeys(entry, ["name", "role"], "absentFiles[]");
    assertAllowedFileName(entry.name);
    if (seen.has(entry.name)) {
      throw backupError("INVALID_MANIFEST", "同一状态文件不能同时声明为存在与缺失。");
    }
    seen.add(entry.name);
    if (entry.role !== TRUSTED_BACKUP_FILE_POLICY[entry.name].role) {
      throw backupError("INVALID_MANIFEST", `空状态槽位 ${entry.name} 的角色声明无效。`);
    }
  }
  const expectedSlots = [...(legacy ? LEGACY_FILE_NAMES : ALLOWED_FILE_NAMES)].sort();
  const declaredSlots = [...seen].filter(name => !isSegmentName(name)).sort();
  if (JSON.stringify(declaredSlots) !== JSON.stringify(expectedSlots)) {
    throw backupError("INVALID_MANIFEST", "备份清单必须显式声明每一个业务状态槽位。");
  }

  assertPlainObject(manifest.security, "security");
  assertExactKeys(manifest.security, [
    "credentialsIncluded",
    "excludedDataClasses",
    "excludedStateFiles",
    "payloadFormat",
    "portability",
  ], "security");
  if (JSON.stringify(manifest.security) !== JSON.stringify(SECURITY_MANIFEST)) {
    throw backupError("CREDENTIAL_POLICY", "备份未满足凭证排除策略。");
  }

  assertPlainObject(manifest.provenance, "provenance");
  assertExactKeys(manifest.provenance, [
    "exportPolicyVersion",
    "hashAlgorithm",
    "hashSubject",
    "manifestVersion",
    "producer",
    "restorePolicyVersion",
  ], "provenance");
  if (JSON.stringify(manifest.provenance) !== JSON.stringify(legacy ? LEGACY_PROVENANCE_MANIFEST : previous ? PREVIOUS_PROVENANCE_MANIFEST : PROVENANCE_MANIFEST)) {
    throw backupError("INVALID_PROVENANCE", "备份 provenance 无效或不受支持。");
  }
}

function assertRestoreCommitGuard(guard) {
  if (guard == null) return;
  if (typeof guard !== "function" || guard() !== true) {
    throw backupError("RESTORE_CONTEXT_CHANGED", "备份或恢复期间账户或授权状态已变化；未继续提交，请重新预检。");
  }
}

async function existingBundleMatches({ destination, manifestBytes, payloads }) {
  const stat = await optionalLstat(destination);
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  let verified;
  try {
    verified = await readVerifiedBundle(destination);
  } catch {
    return false;
  }
  if (sha256(verified.manifestBytes) !== sha256(manifestBytes)) return false;
  if (verified.files.length !== payloads.length) return false;
  return verified.files.every((entry, index) => (
    entry.name === payloads[index].name
    && entry.bytes === payloads[index].bytes
    && entry.sha256 === payloads[index].sha256
  ));
}

function verifiedOpaqueScope(value) {
  const inspection = inspectPersistedAccountScope(value);
  if (!inspection.verified || !isOpaqueBrokerAccountScopeId(inspection.scopeId)) {
    throw backupError("INVALID_ACCOUNT_SCOPE", "备份或恢复需要已验证的不透明券商账户范围；禁止 aggregate 回退。");
  }
  return Object.freeze({ opaqueScopeId: inspection.scopeId });
}

async function readOptionalStableRegularFile(filePath, options) {
  const stat = await optionalLstat(filePath);
  if (!stat) return null;
  return readStableRegularFile(filePath, options);
}

async function readStableRegularFile(filePath, { maxBytes, label }) {
  const before = await lstat(filePath).catch((error) => {
    throw backupError("FILE_READ_FAILED", `${label} 无法读取。`, null, error);
  });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw backupError("UNSAFE_FILE", `${label} 必须是普通文件且不能是符号链接。`);
  }
  if (before.size > maxBytes) throw backupError("SIZE_LIMIT", `${label} 超过安全大小上限。`);
  const value = await readFile(filePath).catch((error) => {
    throw backupError("FILE_READ_FAILED", `${label} 无法完整读取。`, null, error);
  });
  const after = await lstat(filePath).catch((error) => {
    throw backupError("SOURCE_CHANGED", `${label} 在读取期间发生变化。`, null, error);
  });
  if (
    after.isSymbolicLink()
    || !after.isFile()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || value.length !== before.size
  ) {
    throw backupError("SOURCE_CHANGED", `${label} 在读取期间发生变化，已拒绝继续。`);
  }
  return value;
}

async function writeDurableFile(filePath, value) {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertExistingRealDirectory(directory, label) {
  const stat = await optionalLstat(directory);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw backupError("UNSAFE_DIRECTORY", `${label}必须是真实存在的目录且不能是符号链接。`);
  }
}

async function assertOptionalRealDirectory(directory, label) {
  const stat = await optionalLstat(directory);
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    throw backupError("UNSAFE_DIRECTORY", `${label}必须是目录且不能是符号链接。`);
  }
}

async function optionalLstat(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertExactEntrySet(entries, expectedNames, label) {
  const expected = [...expectedNames].sort();
  const actual = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw backupError("UNKNOWN_FILE", `${label}包含未知、缺失或重复文件，已拒绝恢复。`, {
      expected,
      actual,
    });
  }
}

function assertAllowedFileName(name, { allowSegment = false } = {}) {
  if (
    typeof name !== "string"
    || path.basename(name) !== name
    || name.includes("/")
    || name.includes("\\")
    || !(ALLOWED_FILE_NAME_SET.has(name) || (allowSegment && isSegmentName(name)))
  ) {
    throw backupError("PATH_TRAVERSAL_OR_UNKNOWN_FILE", "备份清单包含路径穿越或未授权文件名。");
  }
}

function directChild(parent, name) {
  if (typeof name !== "string" || path.basename(name) !== name || name.includes("/") || name.includes("\\")) {
    throw backupError("PATH_TRAVERSAL", "拒绝访问目录之外的路径。");
  }
  const result = path.resolve(parent, name);
  if (path.dirname(result) !== path.resolve(parent)) {
    throw backupError("PATH_TRAVERSAL", "拒绝访问目录之外的路径。");
  }
  return result;
}

function requiredDirectoryPath(value, field) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new TypeError(`${field} 必须是非空目录路径。`);
  }
  return path.resolve(value);
}

function sameOrNestedPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeAppVersion(value) {
  if (typeof value !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(value.trim())) {
    throw backupError("INVALID_APP_VERSION", "应用版本无效。");
  }
  return value.trim();
}

function normalizeCreatedAt(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw backupError("INVALID_CREATED_AT", "备份创建时间无效。");
  return date.toISOString();
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw backupError("INVALID_MANIFEST", `${label} 必须是对象。`);
  }
}

function assertExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw backupError("INVALID_MANIFEST", `${label} 字段不符合当前版本。`);
  }
}

function assertLiveStage(staged) {
  if (!staged || !LIVE_STAGES.has(staged) || staged.kind !== "trusted-backup-staged-restore/v1") {
    throw backupError("INVALID_STAGE", "恢复操作必须使用本进程已验证的临时计划。");
  }
}

function sameFingerprint(left, right) {
  return Boolean(
    left
    && right
    && left.exists === right.exists
    && left.bytes === right.bytes
    && left.sha256 === right.sha256
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exportResult({ destination, manifest, created, idempotent }) {
  return deepFreeze({
    ok: true,
    created,
    idempotent,
    bundleDirectory: destination,
    schemaVersion: TRUSTED_BACKUP_SCHEMA_VERSION,
    createdAt: manifest.createdAt,
    accountScope: { ...manifest.accountScope },
    files: manifest.files.map((item) => ({ ...item })),
    credentialsIncluded: false,
  });
}

function backupError(code, message, details = null, cause = undefined) {
  return new TrustedBackupError(code, message, details, cause ? { cause } : undefined);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}
