import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assessArchiveBackupCapacity, ARCHIVE_MANIFEST_METADATA_UPPER_BOUND_BYTES } from "../src/security/archive-backup-capacity.mjs";
import { TRUSTED_BACKUP_SCHEMA_VERSION, TRUSTED_BACKUP_LIMITS, TRUSTED_BACKUP_FILE_POLICY,
  createTrustedBackupBundle } from "../src/security/trusted-backup-bundle.mjs";
import { deriveBrokerAccountScopeIdentity } from "../src/data/account-scope-identity.mjs";

const digest = index => index.toString(16).padStart(64, "0");
const root = (bytes = 100) => ({ name: "portfolio-snapshots.bin", role: "portfolio_snapshot_ledger", bytes, sha256: digest(0) });
const segment = (index, bytes = 100) => ({ name: `ledger-segment-${digest(index)}.bin`, role: "immutable_ledger_segment",
  bytes, sha256: digest(index), kind: "portfolio" });
const baseline = files => ({ schemaVersion: TRUSTED_BACKUP_SCHEMA_VERSION, files });
const publication = (overrides = {}) => ({ kind: "portfolio", planHash: digest(42), revision: 0,
  basis: "actual_root_ciphertext", phase: "root_ciphertext", root: root(50), segment: segment(9999), ...overrides });

test("archive budget replaces the active root, adds only the new referenced segment, and never trusts cached totals", () => {
  const sourceDescription = { ...baseline([root(1000), segment(1, 400)]), ciphertextBytes: 0, fileCount: 0 };
  const result = assessArchiveBackupCapacity({ sourceDescription, publication: publication({ root: root(200), segment: segment(2, 600) }) });
  assert.equal(result.allowed, true);
  assert.equal(result.totalBytes, 1200);
  assert.equal(result.fileCount, 3);
  assert.deepEqual(result.limits, TRUSTED_BACKUP_LIMITS);
  assert.equal(result.manifestSizeBasis, "conservative_v4_metadata_upper_bound");
  assert.equal(sourceDescription.files[0].bytes, 1000, "the frozen baseline is not mutated");
  const reused = assessArchiveBackupCapacity({ sourceDescription, publication: publication({ segment: segment(1, 400) }) });
  assert.equal(reused.fileCount, 2); assert.equal(reused.totalBytes, 450);
  const noOp = assessArchiveBackupCapacity({ sourceDescription, publication: publication({ root: root(1000), segment: null }) });
  assert.equal(noOp.fileCount, 2); assert.equal(noOp.totalBytes, 1400);
});

test("fixed file, total-byte and count limits are inclusive and cannot be weakened by input limits", () => {
  const maximum = TRUSTED_BACKUP_LIMITS.maxFileBytes;
  const sourceDescription = baseline([root(maximum), ...Array.from({ length: 31 }, (_, index) => segment(index + 1, maximum))]);
  const exact = publication({ root: root(maximum), segment: segment(9999, 0) });
  assert.equal(assessArchiveBackupCapacity({ sourceDescription, publication: exact }).totalBytes, TRUSTED_BACKUP_LIMITS.maxTotalBytes);
  assert.throws(() => assessArchiveBackupCapacity({ sourceDescription, publication: { ...exact, segment: segment(9999, 1) } }),
    { code: "ARCHIVE_BACKUP_TOTAL_SIZE_LIMIT" });
  assert.throws(() => assessArchiveBackupCapacity({ sourceDescription: baseline([root()]),
    publication: publication({ root: root(maximum + 1) }), limits: { maxFileBytes: Infinity } }), { code: "ARCHIVE_BACKUP_FILE_SIZE_LIMIT" });
  assert.throws(() => assessArchiveBackupCapacity({ sourceDescription: baseline([root()]),
    publication: publication({ segment: segment(9999, maximum + 1) }) }), { code: "ARCHIVE_BACKUP_FILE_SIZE_LIMIT" });
  const atCount = baseline([root(1), ...Array.from({ length: 2046 }, (_, index) => segment(index + 1, 1))]);
  const maximumCount = assessArchiveBackupCapacity({ sourceDescription: atCount, publication: publication() });
  assert.equal(maximumCount.fileCount, 2048);
  assert.ok(maximumCount.manifestUpperBoundBytes < TRUSTED_BACKUP_LIMITS.maxManifestBytes);
  atCount.files.push(segment(2047, 1));
  assert.throws(() => assessArchiveBackupCapacity({ sourceDescription: atCount, publication: publication() }),
    { code: "ARCHIVE_BACKUP_FILE_COUNT_LIMIT" });
});

test("capacity rejects unknown files, unverified baselines, malformed bytes and cross-kind publications", () => {
  for (const sourceDescription of [null, { files: [root()] }, baseline([]), baseline([root(), root()]),
    baseline([{ ...root(), name: "secure-state.bin" }]), baseline([{ ...root(), name: "../portfolio-snapshots.bin" }]),
    baseline([{ ...root(), bytes: null }]), baseline([{ ...root(), bytes: Number.NaN }]), baseline([{ ...root(), bytes: -1 }]),
    baseline([{ ...root(), bytes: 1.5 }]), baseline([segment(1)])]) {
    assert.throws(() => assessArchiveBackupCapacity({ sourceDescription, publication: publication() }));
  }
  for (const proposed of [publication({ kind: "radar" }), publication({ planHash: "unverified" }), publication({ revision: -1 }),
    publication({ segment: { ...segment(2), kind: "radar" } }), publication({ segment: { ...segment(2), sha256: digest(3) } })]) {
    assert.throws(() => assessArchiveBackupCapacity({ sourceDescription: baseline([root()]), publication: proposed }));
  }
  assert.throws(() => assessArchiveBackupCapacity({ sourceDescription: baseline([root(), segment(9999, 200)]), publication: publication() }),
    { code: "ARCHIVE_BACKUP_IMMUTABLE_CONFLICT" });
});

test("manifest bound covers all v4 fixed-slot combinations and maximum-length permitted metadata, not just one sample", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cockpit-manifest-upper-bound-"));
  const source = path.join(directory, "source"), names = Object.keys(TRUSTED_BACKUP_FILE_POLICY);
  const accountScope = deriveBrokerAccountScopeIdentity({ broker: "longbridge", environment: "production",
    accountIdentifiers: [{ kind: "account_number", value: "isolated-capacity-fixture" }] });
  try {
    await mkdir(source);
    // Every nonempty present/absent combination of all 5 permitted roots.
    // App version has the permitted maximum 64 ASCII characters; the largest
    // representable JS date emits the longest (27 byte) supported ISO format.
    for (let mask = 1; mask < 2 ** names.length; mask++) {
      for (const [index, name] of names.entries()) {
        const filename = path.join(source, name);
        if (mask & (1 << index)) await writeFile(filename, Buffer.from("{}"));
        else await rm(filename, { force: true });
      }
      const bundle = path.join(directory, `bundle-${mask}`);
      await createTrustedBackupBundle({ sourceDirectory: source, destinationDirectory: bundle,
        appVersion: "V".repeat(64), accountScope, createdAt: new Date(8_640_000_000_000_000),
        validatePayload: ({ payload }) => ({ document: JSON.parse(payload.toString()) }) });
      const manifestBytes = await readFile(path.join(bundle, "manifest.json"));
      const manifest = JSON.parse(manifestBytes);
      const filesBytes = Buffer.byteLength(JSON.stringify({ files: manifest.files }, null, 2));
      assert.ok(manifestBytes.length - filesBytes <= ARCHIVE_MANIFEST_METADATA_UPPER_BOUND_BYTES,
        `fixed metadata exceeds bound for allowed slot combination ${mask}`);
    }
    // Under the file-count policy even all-long segment names with the largest
    // possible 9-digit allowed file sizes stay within the independent manifest
    // limit. File descriptors are measured directly; the bound covers headers.
    const worstFiles = Array.from({ length: TRUSTED_BACKUP_LIMITS.maxFiles }, (_, index) => segment(index + 1, TRUSTED_BACKUP_LIMITS.maxFileBytes));
    const bound = Buffer.byteLength(JSON.stringify({ files: worstFiles.map(({ kind, ...file }) => file) }, null, 2))
      + ARCHIVE_MANIFEST_METADATA_UPPER_BOUND_BYTES;
    assert.ok(bound < TRUSTED_BACKUP_LIMITS.maxManifestBytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
