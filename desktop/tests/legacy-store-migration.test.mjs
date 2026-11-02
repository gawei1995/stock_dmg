import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { EncryptedStore } from "../src/security/encrypted-store.mjs";

// Execute the real startup migration, without Electron, a user profile,
// keychain access, broker connections, or mutations of production files.
const main = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
const start = main.indexOf("async function migrateEncryptedStoreKey(");
const end = main.indexOf("\nasync function initializePortfolioLedgerScope(", start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({});
vm.runInContext(main.slice(start, end), context);
const migrate = input => context.migrateEncryptedStoreKey(input);
const policies = [
  { key: "marketHistoryCacheV1", fileName: "market-history.bin", receiptKey: "marketHistoryCacheV1DedicatedAuthorityV1" },
  { key: "portfolioSnapshotLedgerV2", fileName: "portfolio-snapshots.bin", receiptKey: "portfolioSnapshotLedgerV2DedicatedAuthorityV1" },
];
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value, "utf8"),
  decryptString: value => value.toString("utf8"),
};

async function fixture(policy, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cockpit-legacy-migration-test-"));
  const restart = () => ({
    source: new EncryptedStore({ directory, safeStorage }),
    target: new EncryptedStore({ directory, safeStorage, fileName: policy.fileName }),
    key: policy.key,
  });
  try { await callback({ ...restart(), directory, restart }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

for (const policy of policies) {
  test(`${policy.key}: a conflict marks dedicated authority; deleting its file cannot revive retained legacy records`, async () => {
    await fixture(policy, async ({ source, target, key, directory, restart }) => {
      const oldValue = { revision: 1, records: ["old-record"] };
      const current = { revision: 2, records: ["current-record"] };
      await source.set(key, oldValue);
      await target.set(key, current);
      const result = await migrate({ source, target, key });
      assert.equal(result.conflict, true);
      assert.equal(result.migrated, false);
      assert.deepEqual(await target.get(key), current);
      assert.deepEqual(await source.get(key), oldValue, "legacy material remains recoverable");
      const receipt = await source.get(policy.receiptKey);
      assert.equal(receipt.authority, "dedicated");
      assert.equal(receipt.targetFile, policy.fileName);
      await rm(path.join(directory, policy.fileName));
      const afterRestart = restart();
      const repeated = await migrate(afterRestart);
      assert.equal(repeated.legacyFallbackEnabled, false);
      assert.equal(repeated.targetPresent, false);
      assert.equal(await afterRestart.target.get(key), undefined);
      assert.deepEqual(await afterRestart.source.get(key), oldValue);
      await assert.rejects(readFile(path.join(directory, policy.fileName)), { code: "ENOENT" });
    });
  });

  test(`${policy.key}: a verified empty installation blocks legacy material arriving later`, async () => {
    await fixture(policy, async ({ source, target, key, restart }) => {
      const first = await migrate({ source, target, key });
      assert.equal(first.targetPresent, false);
      assert.ok(await source.get(policy.receiptKey));
      await source.set(key, { revision: 1, records: ["late-old-record"] });
      const afterRestart = restart();
      assert.equal((await migrate(afterRestart)).migrated, false);
      assert.equal(await afterRestart.target.get(key), undefined);
      assert.deepEqual(await afterRestart.source.get(key), { revision: 1, records: ["late-old-record"] });
    });
  });

  test(`${policy.key}: first migration is durable and repeated startup neither rewrites nor deletes evidence`, async () => {
    await fixture(policy, async ({ source, target, key, directory, restart }) => {
      const original = { revision: 3, records: ["source-record"] };
      await source.set(key, original);
      assert.equal((await migrate({ source, target, key })).migrated, true);
      const beforeSource = await readFile(source.filePath);
      const beforeTarget = await readFile(target.filePath);
      const afterRestart = restart();
      assert.equal((await migrate(afterRestart)).migrated, false);
      assert.deepEqual(await afterRestart.target.get(key), original);
      assert.deepEqual(await afterRestart.source.get(key), original);
      assert.deepEqual(await readFile(path.join(directory, "secure-state.bin")), beforeSource);
      assert.deepEqual(await readFile(path.join(directory, policy.fileName)), beforeTarget);
    });
  });

  test(`${policy.key}: failed target publication cannot create an authority receipt or claim migration`, async () => {
    await fixture(policy, async ({ source, target, key, restart }) => {
      const original = { revision: 1 };
      await source.set(key, original);
      target.fileIO.renameSync = () => { throw new Error("isolated target publication failure"); };
      await assert.rejects(migrate({ source, target, key }), { code: "STORAGE_WRITE_FAILED" });
      assert.equal(await source.get(policy.receiptKey), undefined);
      assert.deepEqual(await source.get(key), original);
      assert.equal(await target.get(key), undefined);
      const retry = restart();
      assert.equal((await migrate(retry)).migrated, true);
      assert.deepEqual(await retry.target.get(key), original);
      assert.ok(await retry.source.get(policy.receiptKey));
    });
  });

  test(`${policy.key}: receipt failure rejects completion but retry keeps the already-published target`, async () => {
    await fixture(policy, async ({ source, target, key, restart }) => {
      const original = { revision: 1 };
      await source.set(key, original);
      source.fileIO.renameSync = () => { throw new Error("isolated receipt publication failure"); };
      await assert.rejects(migrate({ source, target, key }), { code: "STORAGE_WRITE_FAILED" });
      assert.deepEqual(await target.get(key), original, "successful target publication remains recoverable");
      assert.equal(await source.get(policy.receiptKey), undefined);
      assert.deepEqual(await source.get(key), original);
      const retry = restart();
      const result = await migrate(retry);
      assert.equal(result.migrated, false);
      assert.equal(result.conflict, false);
      assert.deepEqual(await retry.target.get(key), original);
      assert.ok(await retry.source.get(policy.receiptKey));
      assert.deepEqual(await retry.source.get(key), original);
    });
  });
}

test("target read failures never persist authority, including when source data exists", async () => {
  const policy = policies[0];
  await fixture(policy, async ({ source, target, key }) => {
    await source.set(key, { revision: 1 });
    target.fileIO.readFile = async () => { throw Object.assign(new Error("isolated unreadable target"), { code: "EACCES" }); };
    await assert.rejects(migrate({ source, target, key }), { code: "STORAGE_READ_FAILED" });
    assert.equal(await source.get(policy.receiptKey), undefined);
    assert.deepEqual(await source.get(key), { revision: 1 });
  });
});

test("malformed or mismatched receipts reject fallback without modifying either store", async () => {
  const policy = policies[0];
  for (const receipt of [null, {}, { schemaVersion: "future/v2" }, {
    schemaVersion: "dedicated-encrypted-store-authority/v1", key: policies[1].key,
    targetFile: policies[1].fileName, authority: "dedicated", activatedAt: "2026-09-18T00:00:00.000Z",
  }]) await fixture(policy, async ({ source, target, key }) => {
    await source.set(key, { revision: 1 });
    await source.set(policy.receiptKey, receipt);
    const bytes = await readFile(source.filePath);
    await assert.rejects(migrate({ source, target, key }), { code: "LEGACY_STORE_AUTHORITY_INVALID" });
    assert.deepEqual(await readFile(source.filePath), bytes);
    assert.equal(await target.get(key), undefined);
  });
});

test("authority receipts are independent per fixed key and never authorize arbitrary migration", async () => {
  const writes = [], reads = [];
  const source = { get: async key => { reads.push(key); }, set: async (key, value) => writes.push({ key, value }) };
  const target = { get: async key => { reads.push(key); }, set: async () => { throw new Error("unexpected target write"); } };
  for (const policy of policies) await migrate({ source, target, key: policy.key });
  assert.deepEqual(writes.map(item => item.key), policies.map(item => item.receiptKey));
  assert.notEqual(writes[0].value.key, writes[1].value.key);
  assert.ok(writes.every(item => item.key !== "businessStateMigrationReceiptV1"));
  const before = { reads: reads.length, writes: writes.length };
  for (const key of ["accessToken", "__proto__", "businessStateMigrationReceiptV1"]) {
    await assert.rejects(migrate({ source, target, key }), /不支持的旧数据迁移键/);
  }
  assert.equal(reads.length, before.reads);
  assert.equal(writes.length, before.writes);
});
