import { TRUSTED_BACKUP_SCHEMA_VERSION, TRUSTED_BACKUP_LIMITS,
  TRUSTED_BACKUP_FILE_POLICY } from "./trusted-backup-bundle.mjs";
import { LEDGER_SEGMENT_NAME_PATTERN, SEGMENTED_LEDGER_POLICIES } from "./segmented-ledger-store.mjs";

// Conservative v4-only bound for everything outside the `files` array:
// fixed application/schema/security/provenance/key names and JSON punctuation;
// a <=64 ASCII application version; <=27 ASCII ISO timestamp; fixed-length
// broker-scope-v1- + 64 hex scope; and <=5 fixed name/role absent-file slots.
// All variable strings are restricted by the v4 exporter. No user text,
// source paths, decrypted ledger metadata, or per-record data enters this
// metadata. The exhaustive fixed-slot export test also guards schema drift.
export const ARCHIVE_MANIFEST_METADATA_UPPER_BOUND_BYTES = 8 * 1024;

/**
 * Pure assessment against a frozen, fully verified v4 source description.
 * The source must be captured after the host drains and freezes every writer.
 * Preview ciphertext is only a measurement; call again with actual root
 * ciphertext at publication. No caller-controlled limits may weaken policy.
 */
export function assessArchiveBackupCapacity({ sourceDescription, publication } = {}) {
  if (sourceDescription?.schemaVersion !== TRUSTED_BACKUP_SCHEMA_VERSION
      || !Array.isArray(sourceDescription.files) || !sourceDescription.files.length) {
    throw capacityError("ARCHIVE_BACKUP_BASELINE_INVALID", "归档缺少完整且已核验的备份容量基线，请重新预检。");
  }
  const policy = SEGMENTED_LEDGER_POLICIES[publication?.kind];
  if (!policy || publication?.root?.name !== policy.fileName
      || !/^[a-f0-9]{64}$/.test(publication?.planHash ?? "")
      || !Number.isSafeInteger(publication?.revision) || publication.revision < 0) {
    throw capacityError("ARCHIVE_BACKUP_PUBLICATION_INVALID", "归档提交容量描述无效，未允许发布。");
  }
  const files = new Map();
  for (const source of sourceDescription.files) {
    const file = normalizeFile(source);
    if (files.has(file.name)) throw capacityError("ARCHIVE_BACKUP_BASELINE_INVALID", "备份容量基线存在重复文件，请重新核验。");
    files.set(file.name, file);
  }
  if (!files.has(policy.fileName)) throw capacityError("ARCHIVE_BACKUP_BASELINE_INVALID", "备份容量基线缺少正在归档的根账本。");
  const root = normalizeFile({ ...publication.root, role: TRUSTED_BACKUP_FILE_POLICY[policy.fileName].role });
  files.set(root.name, root);
  if (publication.segment != null) {
    if (publication.segment.kind !== publication.kind || !LEDGER_SEGMENT_NAME_PATTERN.test(publication.segment.name)) {
      throw capacityError("ARCHIVE_BACKUP_PUBLICATION_INVALID", "归档片段的种类或文件名无效。");
    }
    const segment = normalizeFile({ ...publication.segment, role: "immutable_ledger_segment" });
    const previous = files.get(segment.name);
    if (previous && (previous.bytes !== segment.bytes || previous.sha256 !== segment.sha256)) {
      throw capacityError("ARCHIVE_BACKUP_IMMUTABLE_CONFLICT", "同名不可变归档片段的容量或校验值冲突，未允许提交。");
    }
    files.set(segment.name, segment);
  }
  const descriptors = [...files.values()].sort((a, b) => a.name.localeCompare(b.name));
  const limits = TRUSTED_BACKUP_LIMITS;
  if (descriptors.length > limits.maxFiles) {
    throw capacityError("ARCHIVE_BACKUP_FILE_COUNT_LIMIT", "归档后备份文件数量将超过 2048 个，未允许提交。");
  }
  for (const file of descriptors) {
    if (file.bytes > limits.maxFileBytes) {
      throw capacityError("ARCHIVE_BACKUP_FILE_SIZE_LIMIT", "归档后单个备份文件将超过 128 MiB，请减少本次归档范围。");
    }
  }
  const totalBytes = descriptors.reduce((sum, file) => sum + file.bytes, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
    throw capacityError("ARCHIVE_BACKUP_TOTAL_SIZE_LIMIT", "归档后完整备份将超过 4 GiB，未允许提交。");
  }
  const manifestUpperBoundBytes = Buffer.byteLength(JSON.stringify({ files: descriptors }, null, 2), "utf8")
    + ARCHIVE_MANIFEST_METADATA_UPPER_BOUND_BYTES;
  if (manifestUpperBoundBytes > limits.maxManifestBytes) {
    throw capacityError("ARCHIVE_BACKUP_MANIFEST_SIZE_LIMIT", "归档后的备份清单保守上界超过 1 MiB，未允许提交。");
  }
  return { allowed: true, fileCount: descriptors.length, totalBytes, manifestUpperBoundBytes,
    manifestSizeBasis: "conservative_v4_metadata_upper_bound", limits: { ...limits } };
}

function normalizeFile(file) {
  const segment = typeof file?.name === "string" && LEDGER_SEGMENT_NAME_PATTERN.exec(file.name);
  const expectedRole = segment ? "immutable_ledger_segment" : TRUSTED_BACKUP_FILE_POLICY[file?.name]?.role;
  if (!expectedRole || file.role !== expectedRole || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || !/^[a-f0-9]{64}$/.test(file.sha256 ?? "") || (segment && segment[1] !== file.sha256)) {
    throw capacityError("ARCHIVE_BACKUP_DESCRIPTOR_INVALID", "备份容量文件描述无效；不会估算凭证文件、未知路径或缺失大小。");
  }
  return { name: file.name, role: expectedRole, bytes: file.bytes, sha256: file.sha256 };
}

function capacityError(code, message) {
  return Object.assign(new Error(message), { name: "ArchiveBackupCapacityError", code });
}
