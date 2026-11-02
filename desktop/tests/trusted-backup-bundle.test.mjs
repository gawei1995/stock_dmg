import assert from "node:assert/strict";
import test from "node:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { EncryptedStore } from "../src/security/encrypted-store.mjs";
import { BusinessStateStore, validateBusinessStateDocument } from "../src/security/business-state-store.mjs";
import { SegmentedLedgerStore, SEGMENTED_LEDGER_POLICIES, LEDGER_SEGMENT_NAME_PATTERN } from "../src/security/segmented-ledger-store.mjs";
import { TechnicalRadarStore } from "../src/data/technical-radar-store.mjs";
import { PortfolioSnapshotStore } from "../src/data/portfolio-snapshot-store.mjs";
import { deriveBrokerAccountScopeIdentity } from "../src/data/account-scope-identity.mjs";
import {
  TRUSTED_BACKUP_EXCLUDED_STATE,
  TRUSTED_BACKUP_FILE_POLICY,
  TRUSTED_BACKUP_LIMITS,
  TRUSTED_BACKUP_MANIFEST_FILE,
  TRUSTED_BACKUP_PAYLOAD_DIRECTORY,
  TRUSTED_BACKUP_SCHEMA_VERSION,
  applyStagedTrustedBackupRestore,
  createTrustedBackupBundle,
  describeTrustedBackupSource,
  discardStagedTrustedBackupRestore,
  stageTrustedBackupRestore,
} from "../src/security/trusted-backup-bundle.mjs";

const CREATED_AT = "2026-08-31T08:15:30.000Z";
const RAW_ACCOUNT_NUMBER = "RAW-BROKER-ACCOUNT-778899";
const RAW_ACCESS_TOKEN = "oauth-access-token-that-must-not-be-backed-up";

test("every EncryptedStore .bin file is explicitly included or excluded by backup policy", async () => {
  const [mainSource, encryptedStoreSource] = await Promise.all([
    readFile(new URL("../main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/security/encrypted-store.mjs", import.meta.url), "utf8"),
  ]);
  const stateFiles = [...new Set(
    [...`${mainSource}\n${encryptedStoreSource}`.matchAll(/["']([^"']+\.bin)["']/g)]
      .map((match) => match[1]),
  )].sort();
  const classified = [
    ...Object.keys(TRUSTED_BACKUP_FILE_POLICY),
    ...TRUSTED_BACKUP_EXCLUDED_STATE.map((item) => item.name),
  ].sort();
  assert.deepEqual(stateFiles, classified);
  assert.deepEqual(
    TRUSTED_BACKUP_EXCLUDED_STATE,
    [{
      name: "secure-state.bin",
      reason: "contains_oauth_pkce_codex_session_and_runtime_secrets",
    }],
  );
});

test("export uses a fixed business-state allowlist, opaque scope and no credential store", async () => {
  await withFixture(async ({ source, bundle }) => {
    await writeFile(path.join(source, "review-data.bin"), Buffer.from("encrypted-review"));
    await writeFile(path.join(source, "market-history.bin"), Buffer.from("encrypted-market"));
    await writeFile(path.join(source, "portfolio-snapshots.bin"), Buffer.from("encrypted-ledger"));
    await writeFile(path.join(source, "technical-radar.bin"), Buffer.from("encrypted-radar"));
    await writeFile(
      path.join(source, "secure-state.bin"),
      Buffer.from(`${RAW_ACCOUNT_NUMBER}:${RAW_ACCESS_TOKEN}`),
    );
    await writeFile(path.join(source, "future-unknown.bin"), Buffer.from("not-allowlisted"));

    const identity = verifiedScope(RAW_ACCOUNT_NUMBER);
    const result = await createTrustedBackupBundle({
      sourceDirectory: source,
      destinationDirectory: bundle,
      appVersion: "0.22.0",
      // Even unexpected caller metadata must never be copied into the manifest.
      accountScope: {
        ...identity,
        rawAccountNumber: RAW_ACCOUNT_NUMBER,
        accessToken: RAW_ACCESS_TOKEN,
      },
      createdAt: CREATED_AT,
      validatePayload: acceptTestPayload,
    });

    assert.equal(result.created, true);
    assert.equal(result.credentialsIncluded, false);
    assert.match(result.accountScope.opaqueScopeId, /^broker-scope-v1-[0-9a-f]{64}$/);

    const manifestText = await readFile(path.join(bundle, TRUSTED_BACKUP_MANIFEST_FILE), "utf8");
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.schemaVersion, TRUSTED_BACKUP_SCHEMA_VERSION);
    assert.equal(manifest.application.version, "0.22.0");
    assert.equal(manifest.createdAt, CREATED_AT);
    assert.deepEqual(Object.keys(manifest.accountScope).sort(), ["opaqueScopeId", "status"]);
    assert.equal(manifest.accountScope.opaqueScopeId, identity.scopeId);
    assert.equal(manifest.security.credentialsIncluded, false);
    assert.deepEqual(manifest.security.excludedStateFiles, ["secure-state.bin"]);
    assert.equal(manifest.provenance.hashAlgorithm, "sha256");
    assert.equal(manifest.provenance.hashSubject, "encrypted_file_bytes");
    assert.deepEqual(
      manifest.files.map((item) => item.name),
      [
        "review-data.bin",
        "market-history.bin",
        "portfolio-snapshots.bin",
        "technical-radar.bin",
      ],
    );
    assert.deepEqual(manifest.absentFiles, [{ name: "business-state.bin", role: "application_business_index" }]);
    for (const item of manifest.files) {
      assert.match(item.sha256, /^[0-9a-f]{64}$/);
      assert.ok(item.bytes > 0);
    }

    const allBundleBytes = await readBundleText(bundle);
    assert.doesNotMatch(allBundleBytes, new RegExp(RAW_ACCOUNT_NUMBER));
    assert.doesNotMatch(allBundleBytes, new RegExp(RAW_ACCESS_TOKEN));
    await assert.rejects(access(path.join(bundle, TRUSTED_BACKUP_PAYLOAD_DIRECTORY, "secure-state.bin")));
    await assert.rejects(access(path.join(bundle, TRUSTED_BACKUP_PAYLOAD_DIRECTORY, "future-unknown.bin")));
  });
});

test("export is idempotent only for an identical immutable destination", async () => {
  await withFixture(async ({ source, bundle }) => {
    await writeFile(path.join(source, "review-data.bin"), Buffer.from("review-v1"));
    const request = {
      sourceDirectory: source,
      destinationDirectory: bundle,
      appVersion: "0.22.0",
      accountScope: verifiedScope(),
      createdAt: CREATED_AT,
    };
    const first = await createTrustedBackupBundle(request);
    const second = await createTrustedBackupBundle(request);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.idempotent, true);

    await writeFile(path.join(source, "review-data.bin"), Buffer.from("review-v2"));
    await assert.rejects(
      createTrustedBackupBundle(request),
      (error) => error?.code === "DESTINATION_EXISTS",
    );
    assert.equal(
      (await readFile(path.join(bundle, TRUSTED_BACKUP_PAYLOAD_DIRECTORY, "review-data.bin"))).toString(),
      "review-v1",
    );
  });
});

test("export identity guards reject before any work and again immediately before destination publication", async () => {
  for (const phase of ["initial", "during-validation"]) await withFixture(async ({ source, bundle, root }) => {
    await writeFile(path.join(source, "review-data.bin"), "isolated business data");
    let current = phase !== "initial", calls = 0;
    await assert.rejects(createTrustedBackupBundle({ sourceDirectory: source, destinationDirectory: bundle,
      appVersion: "0.24.5", accountScope: verifiedScope(), createdAt: CREATED_AT,
      commitGuard: () => current,
      validatePayload: () => { calls++; current = false; return true; },
    }), { code: "RESTORE_CONTEXT_CHANGED" });
    assert.equal(calls, phase === "initial" ? 0 : 1);
    await assert.rejects(access(bundle), { code: "ENOENT" });
    assert.equal((await readdir(root)).some(name => name.startsWith(".trusted-backup-export-")), false);
    assert.equal(await readFile(path.join(source, "review-data.bin"), "utf8"), "isolated business data");
  });
});

test("a stale idempotent export cannot claim success or change an existing destination", async () => {
  await withFixture(async ({ source, bundle, root }) => {
    await writeFile(path.join(source, "review-data.bin"), "unchanged fixture");
    const args = { sourceDirectory: source, destinationDirectory: bundle, appVersion: "0.24.5",
      accountScope: verifiedScope(), createdAt: CREATED_AT };
    await createTrustedBackupBundle(args);
    const before = await readFile(path.join(bundle, "manifest.json"));
    let current = true;
    await assert.rejects(createTrustedBackupBundle({ ...args, commitGuard: () => current,
      validatePayload: () => { current = false; return true; } }), { code: "RESTORE_CONTEXT_CHANGED" });
    assert.deepEqual(await readFile(path.join(bundle, "manifest.json")), before);
    assert.equal(await readFile(path.join(bundle, "payload", "review-data.bin"), "utf8"), "unchanged fixture");
    assert.equal((await readdir(root)).some(name => name.startsWith(".trusted-backup-export-")), false);
  });
});

test("restore stages a dry-run, atomically replaces allowlisted files and is idempotent", async () => {
  await withFixture(async ({ source, bundle, target, temporary }) => {
    await writeFile(path.join(source, "review-data.bin"), Buffer.from("new-review"));
    await writeFile(path.join(source, "portfolio-snapshots.bin"), Buffer.from("new-ledger"));
    await writeFile(path.join(target, "review-data.bin"), Buffer.from("old-review"));
    await writeFile(path.join(target, "unmanaged.bin"), Buffer.from("must-survive"));
    const identity = verifiedScope();
    await createTrustedBackupBundle({
      sourceDirectory: source,
      destinationDirectory: bundle,
      appVersion: "0.22.0",
      accountScope: identity,
      createdAt: CREATED_AT,
      validatePayload: acceptTestPayload,
    });

    const staged = await stageTrustedBackupRestore({
      bundleDirectory: bundle,
      targetDirectory: target,
      expectedAccountScope: identity,
      validatePayload: acceptTestPayload,
      temporaryRoot: temporary,
    });
    assert.equal(staged.plan.dryRun, true);
    assert.equal(staged.plan.wouldChange, true);
    assert.deepEqual(
      staged.plan.operations.map(({ name, operation }) => ({ name, operation })),
      [
        { name: "review-data.bin", operation: "replace" },
        { name: "market-history.bin", operation: "unchanged" },
        { name: "portfolio-snapshots.bin", operation: "create" },
        { name: "technical-radar.bin", operation: "unchanged" },
        { name: "business-state.bin", operation: "preserve" },
      ],
    );
    assert.equal((await readFile(path.join(target, "review-data.bin"))).toString(), "old-review");

    const applied = await applyStagedTrustedBackupRestore(staged);
    assert.equal(applied.changed, true);
    assert.deepEqual(applied.restoredFiles, ["review-data.bin", "portfolio-snapshots.bin"]);
    assert.equal((await readFile(path.join(target, "review-data.bin"))).toString(), "new-review");
    assert.equal((await readFile(path.join(target, "portfolio-snapshots.bin"))).toString(), "new-ledger");
    assert.equal((await readFile(path.join(target, "unmanaged.bin"))).toString(), "must-survive");

    const repeated = await applyStagedTrustedBackupRestore(staged);
    assert.equal(repeated.changed, false);
    assert.equal(repeated.idempotent, true);
    await discardStagedTrustedBackupRestore(staged);
  });
});

test("restore validates decryptability before touching targets and applies explicit absent-slot tombstones", async () => {
  await withFixture(async ({ source, bundle, target, temporary }) => {
    await writeFile(path.join(source, "review-data.bin"), Buffer.from("readable-review"));
    await writeFile(path.join(target, "review-data.bin"), Buffer.from("old-review"));
    await writeFile(path.join(target, "market-history.bin"), Buffer.from("future-market-cache"));
    const identity = verifiedScope();
    await exportFixture({ source, bundle, identity });

    await assert.rejects(
      stageTrustedBackupRestore({
        bundleDirectory: bundle,
        targetDirectory: target,
        expectedAccountScope: identity,
        temporaryRoot: temporary,
        validatePayload: async () => {
          throw new Error("different safeStorage identity");
        },
      }),
      (error) => error?.code === "PAYLOAD_UNREADABLE",
    );
    assert.equal((await readFile(path.join(target, "review-data.bin"))).toString(), "old-review");
    assert.equal((await readFile(path.join(target, "market-history.bin"))).toString(), "future-market-cache");

    const staged = await stageTrustedBackupRestore({
      bundleDirectory: bundle,
      targetDirectory: target,
      expectedAccountScope: identity,
      temporaryRoot: temporary,
      validatePayload: acceptTestPayload,
    });
    assert.equal(
      staged.plan.operations.find((item) => item.name === "market-history.bin")?.operation,
      "delete",
    );
    const applied = await applyStagedTrustedBackupRestore(staged);
    assert.deepEqual(applied.restoredFiles, ["review-data.bin"]);
    assert.deepEqual(applied.removedFiles, ["market-history.bin"]);
    await assert.rejects(access(path.join(target, "market-history.bin")));
    await discardStagedTrustedBackupRestore(staged);
  });
});

test("tampered payload fails before target files are touched", async () => {
  await withFixture(async ({ source, bundle, target, temporary }) => {
    await writeFile(path.join(source, "review-data.bin"), Buffer.from("trusted"));
    await writeFile(path.join(target, "review-data.bin"), Buffer.from("original"));
    const identity = verifiedScope();
    await exportFixture({ source, bundle, identity });
    await writeFile(
      path.join(bundle, TRUSTED_BACKUP_PAYLOAD_DIRECTORY, "review-data.bin"),
      Buffer.from("tampered"),
    );

    await assert.rejects(
      stageTrustedBackupRestore({
        bundleDirectory: bundle,
        targetDirectory: target,
        expectedAccountScope: identity,
        validatePayload: acceptTestPayload,
        temporaryRoot: temporary,
      }),
      (error) => error?.code === "HASH_MISMATCH",
    );
    assert.equal((await readFile(path.join(target, "review-data.bin"))).toString(), "original");
  });
});

test("unknown payload files and credential-store injection fail closed", async () => {
  await withFixture(async ({ source, bundle, target, temporary }) => {
    await writeFile(path.join(source, "review-data.bin"), Buffer.from("trusted"));
    const identity = verifiedScope();
    await exportFixture({ source, bundle, identity });
    await writeFile(
      path.join(bundle, TRUSTED_BACKUP_PAYLOAD_DIRECTORY, "secure-state.bin"),
      Buffer.from(RAW_ACCESS_TOKEN),
    );

    await assert.rejects(
      stageTrustedBackupRestore({
        bundleDirectory: bundle,
        targetDirectory: target,
        expectedAccountScope: identity,
        validatePayload: acceptTestPayload,
        temporaryRoot: temporary,
      }),
      (error) => error?.code === "UNKNOWN_FILE",
    );
    assert.deepEqual(await readdir(target), []);
  });
});

test("path traversal, unknown schema version and oversized declarations are rejected", async (t) => {
  await t.test("path traversal", async () => {
    await withFixture(async ({ source, bundle, target, temporary }) => {
      await writeFile(path.join(source, "review-data.bin"), Buffer.from("trusted"));
      const identity = verifiedScope();
      await exportFixture({ source, bundle, identity });
      await mutateManifest(bundle, (manifest) => {
        manifest.files[0].name = "../secure-state.bin";
      });
      await assert.rejects(
        stageTrustedBackupRestore({
          bundleDirectory: bundle,
          targetDirectory: target,
          expectedAccountScope: identity,
          validatePayload: acceptTestPayload,
          temporaryRoot: temporary,
        }),
        (error) => error?.code === "PATH_TRAVERSAL_OR_UNKNOWN_FILE",
      );
    });
  });

  await t.test("unknown version", async () => {
    await withFixture(async ({ source, bundle, target, temporary }) => {
      await writeFile(path.join(source, "review-data.bin"), Buffer.from("trusted"));
      const identity = verifiedScope();
      await exportFixture({ source, bundle, identity });
      await mutateManifest(bundle, (manifest) => {
        manifest.schemaVersion = "trading-cockpit-trusted-backup/v999";
      });
      await assert.rejects(
        stageTrustedBackupRestore({
          bundleDirectory: bundle,
          targetDirectory: target,
          expectedAccountScope: identity,
          validatePayload: acceptTestPayload,
          temporaryRoot: temporary,
        }),
        (error) => error?.code === "UNSUPPORTED_VERSION",
      );
    });
  });

  await t.test("size limit", async () => {
    await withFixture(async ({ source, bundle, target, temporary }) => {
      await writeFile(path.join(source, "review-data.bin"), Buffer.from("trusted"));
      const identity = verifiedScope();
      await exportFixture({ source, bundle, identity });
      await mutateManifest(bundle, (manifest) => {
        manifest.files[0].bytes = TRUSTED_BACKUP_LIMITS.maxFileBytes + 1;
      });
      await assert.rejects(
        stageTrustedBackupRestore({
          bundleDirectory: bundle,
          targetDirectory: target,
          expectedAccountScope: identity,
          validatePayload: acceptTestPayload,
          temporaryRoot: temporary,
        }),
        (error) => error?.code === "SIZE_LIMIT",
      );
    });
  });
});

test("raw, aggregate or mismatched account scope cannot export or restore", async () => {
  await withFixture(async ({ source, bundle, target, temporary }) => {
    await writeFile(path.join(source, "review-data.bin"), Buffer.from("trusted"));
    await assert.rejects(
      createTrustedBackupBundle({
        sourceDirectory: source,
        destinationDirectory: bundle,
        appVersion: "0.22.0",
        accountScope: { accountNumber: RAW_ACCOUNT_NUMBER },
        createdAt: CREATED_AT,
      }),
      (error) => error?.code === "INVALID_ACCOUNT_SCOPE",
    );
    await assert.rejects(access(bundle));

    const firstIdentity = verifiedScope("account-A");
    const secondIdentity = verifiedScope("account-B");
    await exportFixture({ source, bundle, identity: firstIdentity });
    await assert.rejects(
      stageTrustedBackupRestore({
        bundleDirectory: bundle,
        targetDirectory: target,
        expectedAccountScope: secondIdentity,
        validatePayload: acceptTestPayload,
        temporaryRoot: temporary,
      }),
      (error) => error?.code === "ACCOUNT_SCOPE_MISMATCH",
    );
    assert.deepEqual(await readdir(target), []);
  });
});

test("target changes after dry-run abort the entire restore before any replacement", async () => {
  await withFixture(async ({ source, bundle, target, temporary }) => {
    await writeFile(path.join(source, "review-data.bin"), Buffer.from("new-review"));
    await writeFile(path.join(source, "market-history.bin"), Buffer.from("new-market"));
    await writeFile(path.join(target, "review-data.bin"), Buffer.from("old-review"));
    await writeFile(path.join(target, "market-history.bin"), Buffer.from("old-market"));
    const identity = verifiedScope();
    await exportFixture({ source, bundle, identity });
    const staged = await stageTrustedBackupRestore({
      bundleDirectory: bundle,
      targetDirectory: target,
      expectedAccountScope: identity,
      validatePayload: acceptTestPayload,
      temporaryRoot: temporary,
    });

    await writeFile(path.join(target, "market-history.bin"), Buffer.from("concurrent-change"));
    await assert.rejects(
      applyStagedTrustedBackupRestore(staged),
      (error) => error?.code === "TARGET_CHANGED",
    );
    assert.equal((await readFile(path.join(target, "review-data.bin"))).toString(), "old-review");
    assert.equal((await readFile(path.join(target, "market-history.bin"))).toString(), "concurrent-change");
    await discardStagedTrustedBackupRestore(staged);
  });
});

test("v2 four-slot backup restores its data but preserves the newer business index", async () => {
  await withFixture(async ({ source, bundle, target, temporary }) => {
    await writeFile(path.join(source, "review-data.bin"), "old-backup-review");
    await writeFile(path.join(target, "business-state.bin"), "current-business-index");
    const identity = verifiedScope();
    await exportFixture({ source, bundle, identity });
    await mutateManifest(bundle, manifest => {
      manifest.schemaVersion = "trading-cockpit-trusted-backup/v2";
      manifest.absentFiles = manifest.absentFiles.filter(item => item.name !== "business-state.bin");
      manifest.provenance.manifestVersion = manifest.schemaVersion;
      manifest.provenance.exportPolicyVersion = "encrypted-business-state-allowlist/v1";
      manifest.provenance.restorePolicyVersion = "decrypt-validate-explicit-slots-transactional-atomic-replace/v2";
    });
    const staged = await stageTrustedBackupRestore({ bundleDirectory: bundle, targetDirectory: target,
      expectedAccountScope: identity, temporaryRoot: temporary, validatePayload: acceptTestPayload });
    assert.equal(staged.plan.operations.find(item => item.name === "business-state.bin").operation, "preserve");
    await applyStagedTrustedBackupRestore(staged);
    assert.equal(await readFile(path.join(target, "business-state.bin"), "utf8"), "current-business-index");
    await discardStagedTrustedBackupRestore(staged);
  });
});

test("account guard rechecks after staging and after preparing all files, with no partial commit", async () => {
  for (const rejectAt of [1, 2]) await withFixture(async ({ source, bundle, target, temporary }) => {
    await writeFile(path.join(source, "review-data.bin"), "new");
    await writeFile(path.join(target, "review-data.bin"), "original");
    const identity = verifiedScope(); await exportFixture({ source, bundle, identity });
    const staged = await stageTrustedBackupRestore({ bundleDirectory: bundle, targetDirectory: target,
      expectedAccountScope: identity, temporaryRoot: temporary, validatePayload: acceptTestPayload });
    let checks = 0;
    await assert.rejects(applyStagedTrustedBackupRestore(staged, { commitGuard: () => ++checks !== rejectAt }),
      error => error.code === "RESTORE_CONTEXT_CHANGED" || error.cause?.code === "RESTORE_CONTEXT_CHANGED");
    assert.equal(await readFile(path.join(target, "review-data.bin"), "utf8"), "original");
    assert.deepEqual(await readdir(target), ["review-data.bin"]);
    await discardStagedTrustedBackupRestore(staged);
  });
});

test("failure installing the new fifth file rolls back every earlier replacement", async () => {
  await withFixture(async ({ source, bundle, target, temporary }) => {
    const names = Object.keys(TRUSTED_BACKUP_FILE_POLICY);
    for (const name of names) {
      await writeFile(path.join(source, name), `new-${name}`);
      await writeFile(path.join(target, name), `original-${name}`);
    }
    const identity = verifiedScope(); await exportFixture({ source, bundle, identity });
    const staged = await stageTrustedBackupRestore({ bundleDirectory: bundle, targetDirectory: target,
      expectedAccountScope: identity, temporaryRoot: temporary, validatePayload: acceptTestPayload });
    let checks = 0;
    await assert.rejects(applyStagedTrustedBackupRestore(staged, { commitGuard: () => {
      if (++checks === 2) {
        // Controlled filesystem failure inside this isolated fixture only.
        const prepared = readdirSync(target).find(name => name.endsWith("-business-state.bin.new"));
        assert.ok(prepared); unlinkSync(path.join(target, prepared));
      }
      return true;
    } }), { code: "RESTORE_COMMIT_FAILED" });
    for (const name of names) assert.equal(await readFile(path.join(target, name), "utf8"), `original-${name}`);
    assert.deepEqual((await readdir(target)).sort(), names.sort());
    await discardStagedTrustedBackupRestore(staged);
  });
});

test("isolated encrypted business restore retains device preferences and never revives legacy indices", async () => {
  await withFixture(async ({ source, bundle, target, temporary, root }) => {
    // Reversible fixture double; no system keychain or real account is read.
    const safeStorage = { isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(`fixture:${value}`),
      decryptString: bytes => { assert.ok(bytes.toString().startsWith("fixture:")); return bytes.toString().slice(8); } };
    const workspaceDirectory = path.join(root, "workspace");
    const legacy = new EncryptedStore({ directory: source, safeStorage });
    await legacy.update({ watchPlans: [{ id: "stale-legacy-plan" }], accessToken: RAW_ACCESS_TOKEN,
      portfolioSnapshotBackgroundPreferencesV1: { enabled: true, launchAtLogin: true } });
    const business = new BusinessStateStore({ directory: source, safeStorage, legacyStore: legacy, workspaceDirectory });
    await business.initialize(); await business.set("watchPlans", [{ id: "saved-plan" }]);
    const targetLegacy = new EncryptedStore({ directory: target, safeStorage });
    await targetLegacy.update({ watchPlans: [{ id: "target-legacy" }], accessToken: "local-credential",
      portfolioSnapshotBackgroundPreferencesV1: { enabled: false, launchAtLogin: false } });
    const targetBusiness = new BusinessStateStore({ directory: target, safeStorage, legacyStore: targetLegacy, workspaceDirectory });
    await targetBusiness.initialize();
    const identity = verifiedScope(); await exportFixture({ source, bundle, identity });
    const staged = await stageTrustedBackupRestore({ bundleDirectory: bundle, targetDirectory: target,
      expectedAccountScope: identity, temporaryRoot: temporary,
      validatePayload: ({ name, payload }) => { assert.equal(name, "business-state.bin");
        validateBusinessStateDocument(JSON.parse(safeStorage.decryptString(payload)), { workspaceDirectory }); return true; } });
    await applyStagedTrustedBackupRestore(staged);
    const restarted = new BusinessStateStore({ directory: target, safeStorage, legacyStore: targetLegacy, workspaceDirectory });
    assert.deepEqual(await restarted.get("watchPlans"), [{ id: "saved-plan" }]);
    assert.equal(await targetLegacy.get("accessToken"), "local-credential");
    assert.deepEqual(await targetLegacy.get("portfolioSnapshotBackgroundPreferencesV1"), { enabled: false, launchAtLogin: false });
    const payload = await readFile(path.join(bundle, "payload", "business-state.bin"));
    assert.doesNotMatch(safeStorage.decryptString(payload), /oauth-access-token|portfolioSnapshotBackgroundPreferencesV1/);
    await restarted.delete("watchPlans");
    assert.equal(await restarted.get("watchPlans"), undefined);
    await discardStagedTrustedBackupRestore(staged);
  });
});

const segmentCipher = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`isolated:${Buffer.from(value).toString("base64")}`),
  decryptString: bytes => {
    const text = bytes.toString(); assert.ok(text.startsWith("isolated:"));
    return Buffer.from(text.slice(9), "base64").toString();
  },
};
const decodePayload = ({ payload }) => ({ document: JSON.parse(segmentCipher.decryptString(payload)) });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

async function seedSegmented(directory, kind) {
  const policy = SEGMENTED_LEDGER_POLICIES[kind];
  const base = new EncryptedStore({ directory, fileName: policy.fileName, safeStorage: segmentCipher });
  const store = new SegmentedLedgerStore({ store: base, kind });
  let sequence = 0;
  const domain = kind === "radar" ? new TechnicalRadarStore({ store })
    : new PortfolioSnapshotStore({ store, now: () => new Date("2026-09-18T00:00:00.000Z"), idFactory: () => `snapshot-${++sequence}` });
  for (let index = 1; index <= 4; index++) {
    const date = `2026-09-0${index}`, at = `${date}T21:30:00.000Z`;
    if (kind === "radar") await domain.appendBatch({ accountScopeId: "lb-account:test", tradingDate: date,
      computedAt: at, recordedAt: at, inputHash: digest(`input-${index}`), scannerVersion: "test/v1",
      summary: { symbolCount: 1 }, items: [{ symbol: "AAPL.US", observation: `observation-${index}` }] });
    else await domain.appendSnapshot({ idempotencyKey: `manual:${date}`, kind: "manual", capturedAt: at,
      timezone: "America/New_York", accountScope: { scopeId: "scope-a", broker: "longbridge",
        accounts: [{ accountRef: "test-account", accountType: "margin", baseCurrency: "USD" }] },
      summary: { reportingCurrency: "USD", totalAssets: 100, cash: 100, grossExposure: 0, netExposure: 0,
        longExposure: 0, shortExposure: 0 }, holdings: [],
      dataQuality: { status: "complete", completeForPeriodReturn: true, issues: [] }, fx: { status: "not_required", rates: [] },
      provenance: { provider: "longbridge", transport: "openapi", fetchedAt: at, sourceSnapshotId: `source-${index}`, freshness: "live" } });
  }
  await store.set(kind === "radar" ? "watchlist" : "coverage", { revision: 7 });
  const full = await store.get(policy.key);
  await store.archive({ plan: await store.planArchive({ retainActiveCount: 2 }), confirmed: true });
  await store.archive({ plan: await store.planArchive({ retainActiveCount: 1 }), confirmed: true });
  return { base, store, domain, full, policy, references: (await base.get(policy.key)).segments };
}

test("v4 exports only referenced segments and restores both complete domain chains with sidecars", async () => {
  await withFixture(async ({ source, bundle, target, temporary }) => {
    const portfolio = await seedSegmented(source, "portfolio"), radar = await seedSegmented(source, "radar");
    const orphan = segmentCipher.encryptString(JSON.stringify({ unreferenced: true }));
    const orphanName = `ledger-segment-${digest(orphan)}.bin`;
    await writeFile(path.join(source, orphanName), orphan);
    await writeFile(path.join(target, orphanName), orphan);
    const firstRef = portfolio.references[0];
    await writeFile(path.join(target, firstRef.name), await readFile(path.join(source, firstRef.name)));
    const identity = verifiedScope();
    const beforePreflight = (await readdir(source)).sort();
    const capacity = await describeTrustedBackupSource({ sourceDirectory: source, validatePayload: decodePayload });
    assert.equal(capacity.fileCount, 6);
    assert.equal(capacity.references.length, 4);
    assert.equal(capacity.ciphertextBytes, capacity.files.reduce((sum, file) => sum + file.bytes, 0));
    assert.equal(capacity.limits.maxTotalBytes, 4 * 1024 ** 3);
    assert.deepEqual((await readdir(source)).sort(), beforePreflight, "preflight is read-only");
    const exported = await createTrustedBackupBundle({ sourceDirectory: source, destinationDirectory: bundle,
      appVersion: "0.24.5", accountScope: identity, validatePayload: decodePayload, createdAt: CREATED_AT });
    assert.equal(exported.schemaVersion, "trading-cockpit-trusted-backup/v4");
    assert.equal(exported.files.length, 6);
    assert.equal(exported.files.some(item => item.name === orphanName), false);
    assert.equal(exported.files.filter(item => item.role === "immutable_ledger_segment").length, 4);
    const staged = await stageTrustedBackupRestore({ bundleDirectory: bundle, targetDirectory: target,
      expectedAccountScope: identity, temporaryRoot: temporary, validatePayload: decodePayload });
    assert.equal(staged.plan.operations.find(item => item.name === firstRef.name).operation, "unchanged");
    await applyStagedTrustedBackupRestore(staged);
    for (const [kind, previous] of [["portfolio", portfolio], ["radar", radar]]) {
      const base = new EncryptedStore({ directory: target, fileName: previous.policy.fileName, safeStorage: segmentCipher });
      const store = new SegmentedLedgerStore({ store: base, kind });
      assert.deepEqual(await store.get(previous.policy.key), previous.full);
      const domain = kind === "portfolio" ? new PortfolioSnapshotStore({ store }) : new TechnicalRadarStore({ store });
      assert.equal((await domain.verifyIntegrity()).valid, true);
      assert.deepEqual(await store.get(kind === "radar" ? "watchlist" : "coverage"), { revision: 7 });
    }
    assert.deepEqual(await readFile(path.join(target, orphanName)), orphan);
    assert.equal((await applyStagedTrustedBackupRestore(staged)).idempotent, true);
    await discardStagedTrustedBackupRestore(staged);
  });
});

test("v4 requires decoded ledger documents, and missing source segments leave no published bundle", async () => {
  await withFixture(async ({ source, bundle }) => {
    const item = await seedSegmented(source, "radar");
    const args = { sourceDirectory: source, destinationDirectory: bundle, appVersion: "0.24.5", accountScope: verifiedScope() };
    await assert.rejects(createTrustedBackupBundle(args), { code: "PAYLOAD_DOCUMENT_REQUIRED" });
    await assert.rejects(createTrustedBackupBundle({ ...args, validatePayload: () => true }), { code: "PAYLOAD_DOCUMENT_REQUIRED" });
    await rm(path.join(source, item.references[0].name));
    await assert.rejects(createTrustedBackupBundle({ ...args, validatePayload: decodePayload }), { code: "FILE_READ_FAILED" });
    await assert.rejects(access(bundle), { code: "ENOENT" });
  });
});

test("missing, corrupt or declared-but-unreferenced segments are rejected before any target mutation", async () => {
  for (const mode of ["missing", "corrupt", "unreferenced"]) await withFixture(async ({ source, bundle, target, temporary }) => {
    const item = await seedSegmented(source, "radar"), identity = verifiedScope();
    await createTrustedBackupBundle({ sourceDirectory: source, destinationDirectory: bundle, appVersion: "0.24.5",
      accountScope: identity, validatePayload: decodePayload });
    const segmentPath = path.join(bundle, "payload", item.references[0].name);
    if (mode === "missing") await rm(segmentPath);
    else if (mode === "corrupt") await writeFile(segmentPath, "corrupt");
    else {
      const payload = segmentCipher.encryptString(JSON.stringify({ orphan: true })), name = `ledger-segment-${digest(payload)}.bin`;
      await writeFile(path.join(bundle, "payload", name), payload);
      await mutateManifest(bundle, manifest => manifest.files.push({ name, role: "immutable_ledger_segment", bytes: payload.length, sha256: digest(payload) }));
    }
    await assert.rejects(stageTrustedBackupRestore({ bundleDirectory: bundle, targetDirectory: target,
      expectedAccountScope: identity, temporaryRoot: temporary, validatePayload: decodePayload }),
    error => ["UNKNOWN_FILE", "HASH_MISMATCH", "SEGMENT_REFERENCE_MISMATCH"].includes(error.code));
    assert.deepEqual(await readdir(target), []);
  });
});

test("a valid ciphertext hash cannot hide a wrong logical ledger hash", async () => {
  await withFixture(async ({ source, bundle, target, temporary }) => {
    const item = await seedSegmented(source, "radar"), identity = verifiedScope();
    await createTrustedBackupBundle({ sourceDirectory: source, destinationDirectory: bundle, appVersion: "0.24.5",
      accountScope: identity, validatePayload: decodePayload });
    const rootPath = path.join(bundle, "payload", item.policy.fileName);
    const root = decodePayload({ payload: await readFile(rootPath) }).document;
    root[item.policy.key].contentHash = "0".repeat(64);
    const tampered = segmentCipher.encryptString(JSON.stringify(root));
    await writeFile(rootPath, tampered);
    await mutateManifest(bundle, manifest => Object.assign(manifest.files.find(entry => entry.name === item.policy.fileName),
      { bytes: tampered.length, sha256: digest(tampered) }));
    await assert.rejects(stageTrustedBackupRestore({ bundleDirectory: bundle, targetDirectory: target,
      expectedAccountScope: identity, temporaryRoot: temporary, validatePayload: decodePayload }), { code: "SEGMENT_LEDGER_MISMATCH" });
    assert.deepEqual(await readdir(target), []);
  });
});

test("updating transport and logical hashes still cannot hide a damaged original domain record chain", async () => {
  await withFixture(async ({ source, bundle, target, temporary }) => {
    const item = await seedSegmented(source, "radar"), identity = verifiedScope();
    await createTrustedBackupBundle({ sourceDirectory: source, destinationDirectory: bundle, appVersion: "0.24.5",
      accountScope: identity, validatePayload: decodePayload });
    const rootPath = path.join(bundle, "payload", item.policy.fileName);
    const root = decodePayload({ payload: await readFile(rootPath) }).document;
    const envelope = root[item.policy.key], reference = envelope.segments[0];
    const oldName = reference.name, segmentPath = path.join(bundle, "payload", oldName);
    const segment = decodePayload({ payload: await readFile(segmentPath) }).document;
    segment.records[0].items[0].observation = "forged observation";
    const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
      : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
        : JSON.stringify(value);
    const segmentBytes = segmentCipher.encryptString(canonical(segment));
    reference.sha256 = digest(segmentBytes);
    reference.name = `ledger-segment-${reference.sha256}.bin`;
    reference.bytes = segmentBytes.length;
    reference.contentHash = digest(canonical(segment));
    const full = structuredClone(item.full);
    full.batches[0].items[0].observation = "forged observation";
    envelope.contentHash = digest(canonical(full));
    const rootBytes = segmentCipher.encryptString(JSON.stringify(root));
    await rm(segmentPath);
    await writeFile(path.join(bundle, "payload", reference.name), segmentBytes);
    await writeFile(rootPath, rootBytes);
    await mutateManifest(bundle, manifest => {
      Object.assign(manifest.files.find(entry => entry.name === oldName), { name: reference.name, bytes: reference.bytes, sha256: reference.sha256 });
      Object.assign(manifest.files.find(entry => entry.name === item.policy.fileName), { bytes: rootBytes.length, sha256: digest(rootBytes) });
    });
    await assert.rejects(stageTrustedBackupRestore({ bundleDirectory: bundle, targetDirectory: target,
      expectedAccountScope: identity, temporaryRoot: temporary, validatePayload: decodePayload }), { code: "SEGMENT_RECORD_HASH_MISMATCH" });
    assert.deepEqual(await readdir(target), []);
  });
});

test("v4 package file-count and aggregate-byte limits reject before reading declared segment payloads", async () => {
  for (const mode of ["count", "bytes"]) await withFixture(async ({ source, bundle, target, temporary }) => {
    await writeFile(path.join(source, "review-data.bin"), "original");
    const identity = verifiedScope(); await exportFixture({ source, bundle, identity });
    await mutateManifest(bundle, manifest => {
      const count = mode === "count" ? TRUSTED_BACKUP_LIMITS.maxFiles : 33;
      for (let index = 0; index < count; index++) {
        const hash = digest(`fake-segment-${index}`);
        manifest.files.push({ name: `ledger-segment-${hash}.bin`, role: "immutable_ledger_segment",
          sha256: hash, bytes: mode === "count" ? 1 : TRUSTED_BACKUP_LIMITS.maxFileBytes });
      }
    });
    await assert.rejects(stageTrustedBackupRestore({ bundleDirectory: bundle, targetDirectory: target,
      expectedAccountScope: identity, temporaryRoot: temporary, validatePayload: decodePayload }), { code: "SIZE_LIMIT" });
    assert.deepEqual(await readdir(target), []);
  });
});

test("an account change at the final restore guard does not publish any new segment or root", async () => {
  await withFixture(async ({ source, bundle, target, temporary }) => {
    await seedSegmented(source, "radar"); const identity = verifiedScope();
    await createTrustedBackupBundle({ sourceDirectory: source, destinationDirectory: bundle, appVersion: "0.24.5",
      accountScope: identity, validatePayload: decodePayload });
    const staged = await stageTrustedBackupRestore({ bundleDirectory: bundle, targetDirectory: target,
      expectedAccountScope: identity, temporaryRoot: temporary, validatePayload: decodePayload });
    let checks = 0;
    await assert.rejects(applyStagedTrustedBackupRestore(staged, { commitGuard: () => ++checks < 2 }),
      error => error.code === "RESTORE_CONTEXT_CHANGED" || error.cause?.code === "RESTORE_CONTEXT_CHANGED");
    assert.deepEqual(await readdir(target), []);
    await discardStagedTrustedBackupRestore(staged);
  });
});

test("immutable target name conflicts are refused at preflight and after preflight without overwrite", async () => {
  for (const timing of ["preflight", "after"]) await withFixture(async ({ source, bundle, target, temporary }) => {
    const item = await seedSegmented(source, "radar"), identity = verifiedScope();
    await createTrustedBackupBundle({ sourceDirectory: source, destinationDirectory: bundle, appVersion: "0.24.5",
      accountScope: identity, validatePayload: decodePayload });
    const ref = item.references[0], targetPath = path.join(target, ref.name);
    if (timing === "preflight") await writeFile(targetPath, "must-survive");
    const request = { bundleDirectory: bundle, targetDirectory: target, expectedAccountScope: identity,
      temporaryRoot: temporary, validatePayload: decodePayload };
    if (timing === "preflight") await assert.rejects(stageTrustedBackupRestore(request), { code: "IMMUTABLE_SEGMENT_CONFLICT" });
    else {
      const staged = await stageTrustedBackupRestore(request);
      await writeFile(targetPath, "must-survive");
      await assert.rejects(applyStagedTrustedBackupRestore(staged), { code: "IMMUTABLE_SEGMENT_CONFLICT" });
      await discardStagedTrustedBackupRestore(staged);
    }
    assert.equal(await readFile(targetPath, "utf8"), "must-survive");
    await assert.rejects(access(path.join(target, item.policy.fileName)), { code: "ENOENT" });
  });
});

test("root commit failure preserves newly published segments as orphans and restores original roots", async () => {
  await withFixture(async ({ source, bundle, target, temporary }) => {
    const item = await seedSegmented(source, "radar"), identity = verifiedScope();
    const original = segmentCipher.encryptString(JSON.stringify({ original: true }));
    await writeFile(path.join(target, item.policy.fileName), original);
    await createTrustedBackupBundle({ sourceDirectory: source, destinationDirectory: bundle, appVersion: "0.24.5",
      accountScope: identity, validatePayload: decodePayload });
    const staged = await stageTrustedBackupRestore({ bundleDirectory: bundle, targetDirectory: target,
      expectedAccountScope: identity, temporaryRoot: temporary, validatePayload: decodePayload });
    let checks = 0;
    await assert.rejects(applyStagedTrustedBackupRestore(staged, { commitGuard: () => {
      if (++checks === 2) {
        const rootTemporary = readdirSync(target).find(name => name.endsWith(`-${item.policy.fileName}.new`));
        assert.ok(rootTemporary); unlinkSync(path.join(target, rootTemporary));
      }
      return true;
    } }), { code: "RESTORE_COMMIT_FAILED" });
    assert.deepEqual(await readFile(path.join(target, item.policy.fileName)), original);
    assert.equal((await readdir(target)).filter(name => LEDGER_SEGMENT_NAME_PATTERN.test(name)).length, 2);
    await discardStagedTrustedBackupRestore(staged);
  });
});

test("v3 plain backups remain compatible with boolean validation and preserve unreferenced segment files", async () => {
  await withFixture(async ({ source, bundle, target, temporary }) => {
    await writeFile(path.join(source, "review-data.bin"), "old-review");
    const identity = verifiedScope(); await exportFixture({ source, bundle, identity });
    await mutateManifest(bundle, manifest => {
      manifest.schemaVersion = "trading-cockpit-trusted-backup/v3";
      manifest.provenance.manifestVersion = manifest.schemaVersion;
      manifest.provenance.exportPolicyVersion = "encrypted-business-state-allowlist/v2";
      manifest.provenance.restorePolicyVersion = "decrypt-validate-explicit-slots-transactional-atomic-replace/v3";
    });
    const orphan = Buffer.from("old orphan"), name = `ledger-segment-${digest(orphan)}.bin`;
    await writeFile(path.join(target, name), orphan);
    const staged = await stageTrustedBackupRestore({ bundleDirectory: bundle, targetDirectory: target,
      expectedAccountScope: identity, temporaryRoot: temporary, validatePayload: () => true });
    await applyStagedTrustedBackupRestore(staged);
    assert.deepEqual(await readFile(path.join(target, name)), orphan);
    await discardStagedTrustedBackupRestore(staged);
  });
});

function verifiedScope(value = RAW_ACCOUNT_NUMBER) {
  return deriveBrokerAccountScopeIdentity({
    broker: "Longbridge",
    environment: "production",
    accountIdentifiers: [{ kind: "account_id", value }],
  });
}

async function acceptTestPayload({ payload }) {
  // Tests using opaque sentinel bytes explicitly declare an unsegmented root.
  return Buffer.isBuffer(payload) && payload.length > 0 ? { document: {} } : false;
}

async function exportFixture({ source, bundle, identity }) {
  return createTrustedBackupBundle({
    sourceDirectory: source,
    destinationDirectory: bundle,
    appVersion: "0.22.0",
    accountScope: identity,
    createdAt: CREATED_AT,
    validatePayload: acceptTestPayload,
  });
}

async function mutateManifest(bundle, update) {
  const manifestPath = path.join(bundle, TRUSTED_BACKUP_MANIFEST_FILE);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  update(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function readBundleText(bundle) {
  const values = [await readFile(path.join(bundle, TRUSTED_BACKUP_MANIFEST_FILE))];
  const payloadDirectory = path.join(bundle, TRUSTED_BACKUP_PAYLOAD_DIRECTORY);
  for (const name of await readdir(payloadDirectory)) {
    values.push(await readFile(path.join(payloadDirectory, name)));
  }
  return Buffer.concat(values).toString("utf8");
}

async function withFixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "trusted-backup-test-"));
  const source = path.join(root, "source");
  const bundle = path.join(root, "bundle");
  const target = path.join(root, "target");
  const temporary = path.join(root, "temporary");
  await Promise.all([
    mkdir(source, { recursive: true }),
    mkdir(target, { recursive: true }),
    mkdir(temporary, { recursive: true }),
  ]);
  try {
    await callback({ root, source, bundle, target, temporary });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
