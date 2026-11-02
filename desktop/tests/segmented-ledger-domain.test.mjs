import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EncryptedStore } from "../src/security/encrypted-store.mjs";
import { SegmentedLedgerStore, SEGMENTED_LEDGER_POLICIES } from "../src/security/segmented-ledger-store.mjs";
import { PortfolioSnapshotStore } from "../src/data/portfolio-snapshot-store.mjs";
import { TechnicalRadarStore } from "../src/data/technical-radar-store.mjs";
import { deriveBrokerAccountScopeIdentity } from "../src/data/account-scope-identity.mjs";
import { createTrustedBackupBundle, stageTrustedBackupRestore,
  applyStagedTrustedBackupRestore, discardStagedTrustedBackupRestore } from "../src/security/trusted-backup-bundle.mjs";

// Isolated reversible fixture cipher, never Electron/Keychain or a real profile.
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`domain-fixture:${Buffer.from(value).toString("base64")}`),
  decryptString: bytes => {
    const text = bytes.toString();
    assert.ok(text.startsWith("domain-fixture:"));
    return Buffer.from(text.slice("domain-fixture:".length), "base64").toString();
  },
};
const sha256 = value => createHash("sha256").update(value).digest("hex");
const decodePayload = ({ payload }) => ({ document: JSON.parse(safeStorage.decryptString(payload)) });
const scopes = ["fixture-alpha", "fixture-beta"].map(value => deriveBrokerAccountScopeIdentity({
  broker: "longbridge", environment: "production", accountIdentifiers: [{ kind: "account_number", value }],
}));
const scopeAt = index => scopes[index % scopes.length];
const dateAt = index => `2026-09-${String(index + 1).padStart(2, "0")}`;

function openDomain(directory, kind) {
  const policy = SEGMENTED_LEDGER_POLICIES[kind];
  const base = new EncryptedStore({ directory, fileName: policy.fileName, safeStorage });
  const store = new SegmentedLedgerStore({ store: base, kind });
  const domain = kind === "portfolio"
    ? new PortfolioSnapshotStore({ store, maxSnapshots: 4,
      now: () => new Date("2026-09-18T00:00:00.000Z") })
    : new TechnicalRadarStore({ store, maxBatches: 4 });
  return { directory, kind, policy, base, store, domain };
}

function evidence(index, kind) {
  const date = dateAt(index), at = `${date}T21:30:00.000Z`, scope = scopeAt(index);
  if (kind === "radar") return {
    accountScopeId: scope.scopeId, tradingDate: date, computedAt: at, recordedAt: at,
    inputHash: sha256(`radar-input-${index}`), scannerVersion: "isolated-domain/v1",
    summary: { symbolCount: 1, completeCount: 1 },
    items: [{ symbol: "AAPL.US", observation: `record-${index}`, close: 200 + index }], limitations: [],
  };
  return {
    idempotencyKey: `manual:${scope.scopeId}:${date}`, kind: "manual", capturedAt: at,
    timezone: "America/New_York", accountScope: { ...scope,
      accounts: [{ accountRef: "verified-broker-scope", accountType: "margin", baseCurrency: "USD" }] },
    summary: { reportingCurrency: "USD", totalAssets: 100_000 + index * 100, cash: 80_000,
      grossExposure: 20_000 + index * 100, netExposure: 20_000 + index * 100,
      longExposure: 20_000 + index * 100, shortExposure: 0 },
    holdings: [{ accountRef: "verified-broker-scope", symbol: "AAPL.US", assetType: "equity", currency: "USD",
      quantity: 100, marketPrice: 200 + index, marketValue: 20_000 + index * 100,
      valueInReportingCurrency: 20_000 + index * 100, weight: (20_000 + index * 100) / (100_000 + index * 100) }],
    dataQuality: { status: "complete", completeForPeriodReturn: true, issues: [] },
    fx: { status: "not_required", rates: [] },
    provenance: { provider: "longbridge", transport: "isolated-test", fetchedAt: at,
      sourceSnapshotId: `source-${index}`, freshness: "live" },
  };
}

function append(item, index) {
  return item.kind === "portfolio" ? item.domain.appendSnapshot(evidence(index, item.kind))
    : item.domain.appendBatch(evidence(index, item.kind));
}
function allRecords(item, scopeId = null) {
  return item.kind === "portfolio" ? item.domain.listSnapshots({ ...(scopeId ? { scopeId } : {}), order: "asc", limit: null })
    : item.domain.listBatches({ accountScopeId: scopeId, limit: null });
}
const recordHash = (record, kind) => kind === "portfolio" ? record.integrity.entryHash : record.recordHash;

async function assertCompleteDomain(item, expected) {
  const records = expected[item.policy.recordsKey];
  assert.deepEqual(await item.store.get(item.policy.key), expected, "the original complete ledger is reconstructed unchanged");
  assert.deepEqual(await allRecords(item), records, "domain queries include archived prefixes and the active tail");
  assert.equal((await item.domain.verifyIntegrity()).valid, true);
  for (const scope of scopes) {
    const selected = records.filter(record => (item.kind === "portfolio" ? record.accountScope.scopeId : record.accountScopeId) === scope.scopeId);
    assert.deepEqual(await allRecords(item, scope.scopeId), selected, "no account partition is lost or mixed during reconstruction");
  }
  if (item.kind === "portfolio") {
    assert.deepEqual(await item.domain.getSnapshot(records[0].snapshotId), records[0]);
    const period = await item.domain.queryTradingPeriod({ scopeId: scopes[0].scopeId,
      startTradingDate: "2026-09-01", endTradingDate: "2026-09-06" });
    assert.deepEqual(period.snapshots, records.filter(record => record.accountScope.scopeId === scopes[0].scopeId));
    assert.deepEqual(await item.domain.findNearestSnapshot({ scopeId: scopes[0].scopeId,
      at: "2026-09-01T22:00:00.000Z" }), records[0]);
  } else {
    assert.deepEqual(await item.domain.listBatches({ toTradingDate: "2026-09-02", limit: null }), records.slice(0, 2));
    assert.deepEqual(await item.domain.latest({ accountScopeId: scopes[1].scopeId }), records[5]);
  }
  const capacity = await item.domain.capacity();
  assert.equal(capacity.activeCount, 2);
  assert.equal(capacity.archivedCount, 4);
  assert.equal(capacity[item.kind === "portfolio" ? "snapshotCount" : "batchCount"], 6);
  assert.equal(capacity[item.kind === "portfolio" ? "remainingSnapshots" : "remainingBatches"], 2);
  assert.equal(capacity.totalSerializedBytes, Buffer.byteLength(JSON.stringify(expected)));
  assert.ok(capacity.serializedBytes < capacity.totalSerializedBytes);
  const description = await item.store.describe();
  assert.equal(description.activeBytes, capacity.serializedBytes);
  assert.equal(description.totalBytes, capacity.totalSerializedBytes);
  assert.equal(description.totalCount, 6);
  assert.equal(description.ciphertextFiles.filter(file => file.role === "immutable_prefix_segment").length, 2);
}

for (const kind of ["portfolio", "radar"]) {
  test(`${kind}: real domains append across archive, restart, v4 restore and another restart without losing historical evidence`, async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), `cockpit-domain-${kind}-`));
    const source = path.join(temporary, "source"), target = path.join(temporary, "restored"), bundle = path.join(temporary, "backup.tcbackup");
    let staged = null;
    try {
      await mkdir(source); await mkdir(target);
      const original = openDomain(source, kind);
      const sidecarKey = kind === "portfolio" ? "snapshotCoverageFixture" : "watchlistFixture";
      const sidecar = { revision: 7, observedAt: "2026-09-18T00:00:00.000Z", items: ["AAPL.US"] };
      await original.store.set(sidecarKey, sidecar);
      for (let index = 0; index < 4; index++) await append(original, index);
      const initial = await original.store.get(original.policy.key), initialFile = await readFile(original.base.filePath);
      await assert.rejects(append(original, 4), /容量|capacity|limit/i);
      assert.deepEqual(await readFile(original.base.filePath), initialFile, "capacity rejection does not mutate the encrypted root");
      await original.store.archive({ plan: await original.store.planArchive({ retainActiveCount: 1 }), confirmed: true });
      assert.deepEqual(await original.store.get(original.policy.key), initial, "archival itself cannot change any domain or ledger hash");
      const firstReference = (await original.base.get(original.policy.key)).segments[0];
      const firstCiphertext = await readFile(path.join(source, firstReference.name));
      for (const index of [4, 5]) await append(original, index);
      const expected = await original.store.get(original.policy.key);
      assert.deepEqual(expected[original.policy.recordsKey].slice(0, 4), initial[original.policy.recordsKey]);
      assert.equal((await original.domain.capacity()).activeCount, 3);
      assert.equal((await original.domain.capacity()).archivedCount, 3);
      const beforeSecondArchiveHash = (await original.store.describe()).contentHash;
      await original.store.archive({ plan: await original.store.planArchive({ retainActiveCount: 2 }), confirmed: true });
      assert.equal((await original.store.describe()).contentHash, beforeSecondArchiveHash);
      assert.deepEqual(await readFile(path.join(source, firstReference.name)), firstCiphertext, "append and later archive never rewrite an existing immutable segment");

      // Recreate every layer; no cached decrypted ledger survives the restart.
      const restarted = openDomain(source, kind);
      await assertCompleteDomain(restarted, expected);
      assert.deepEqual(await restarted.store.get(sidecarKey), sidecar);
      const idempotent = await append(restarted, 0);
      assert.equal(idempotent.appended, false, "domain idempotency also searches archived records");
      const exported = await createTrustedBackupBundle({ sourceDirectory: source, destinationDirectory: bundle,
        appVersion: "0.24.5", accountScope: scopes[0], createdAt: "2026-09-18T00:00:00.000Z", validatePayload: decodePayload });
      assert.equal(exported.created, true);
      staged = await stageTrustedBackupRestore({ bundleDirectory: bundle, targetDirectory: target,
        expectedAccountScope: scopes[0], validatePayload: decodePayload });
      await applyStagedTrustedBackupRestore(staged);
      await discardStagedTrustedBackupRestore(staged); staged = null;

      const restored = openDomain(target, kind);
      await assertCompleteDomain(restored, expected);
      assert.deepEqual(await restored.store.get(sidecarKey), sidecar);
      assert.deepEqual(await readFile(path.join(target, firstReference.name)), firstCiphertext);
      const earlierHashes = expected[original.policy.recordsKey].map(record => recordHash(record, kind));
      assert.equal((await append(restored, 6)).appended, true, "restored domain remains writable with the same original chain");
      const finalRestart = openDomain(target, kind);
      const complete = await allRecords(finalRestart);
      assert.equal(complete.length, 7);
      assert.deepEqual(complete.slice(0, 6).map(record => recordHash(record, kind)), earlierHashes);
      assert.equal(kind === "portfolio" ? complete[6].integrity.previousHash : complete[6].previousHash, earlierHashes.at(-1));
      assert.equal((await finalRestart.domain.verifyIntegrity()).valid, true);
      assert.equal((await finalRestart.domain.capacity()).activeCount, 3);
      assert.equal((await finalRestart.domain.capacity()).archivedCount, 4);
    } finally {
      if (staged) await discardStagedTrustedBackupRestore(staged);
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
