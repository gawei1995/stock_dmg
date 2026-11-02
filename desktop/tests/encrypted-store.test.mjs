import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { access, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EncryptedStore } from "../src/security/encrypted-store.mjs";

const reversibleSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, "utf8"),
  decryptString: (value) => value.toString("utf8"),
};

test("encrypted store serializes concurrent mutations without losing keys", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cockpit-store-"));
  try {
    const store = new EncryptedStore({ directory, safeStorage: reversibleSafeStorage });
    await Promise.all([store.set("a", 1), store.set("b", 2), store.set("c", 3)]);
    assert.deepEqual(await store.readAll(), { a: 1, b: 2, c: 3 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restore barrier blocks a pending writer at final commit and drain never rewrites", async () => {
  let frozen = false;
  await withStore(async ({ store, filePath }) => {
    await store.set("revision", 1);
    const originalOpen = store.fileIO.open;
    store.fileIO.open = async (...args) => {
      const file = await originalOpen(...args);
      const sync = file.sync.bind(file);
      file.sync = async () => { await sync(); frozen = true; };
      return file;
    };
    await assert.rejects(store.set("revision", 2), { code: "STALE_STORAGE_COMMIT" });
    await store.drain();
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { revision: 1 });
    assert.equal(await store.get("revision"), 1);
  }, { canWrite: () => !frozen });
});

test("physical encrypted byte measurement distinguishes missing files from unreadable files", async () => {
  await withStore(async ({ store, filePath }) => {
    assert.equal((await store.diskUsage()).bytes, 0);
    assert.equal((await store.diskUsage()).exists, false);
    await store.set("payload", "密文计量测试");
    const expected = (await readFile(filePath)).length;
    const measured = await store.diskUsage();
    assert.equal(measured.bytes, expected);
    assert.equal(measured.exists, true);
    store.fileIO.lstat = async () => { throw new Error("controlled metadata failure"); };
    assert.equal((await store.diskUsage()).bytes, null);
  });
});

test("temporarily unreadable state stays in place and retries instead of starting clean", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cockpit-store-"));
  try {
    const filePath = path.join(directory, "secure-state.bin");
    await writeFile(filePath, Buffer.from('{"revision":1}'));
    let unlocked = false;
    const store = new EncryptedStore({
      directory,
      safeStorage: {
        ...reversibleSafeStorage,
        decryptString: (value) => {
          if (!unlocked) throw new Error("key unavailable");
          return value.toString("utf8");
        },
      },
    });
    await assert.rejects(store.readAll(), { code: "STORAGE_DECRYPT_FAILED" });
    await assert.rejects(store.set("revision", 2), { code: "STORAGE_DECRYPT_FAILED" });
    assert.equal(await readFile(filePath, "utf8"), '{"revision":1}');
    assert.equal(store.cache, null);
    unlocked = true;
    assert.deepEqual(await store.readAll(), { revision: 1 });
    assert.equal(store.health().state, "healthy");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function withStore(run, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cockpit-store-"));
  try {
    const store = new EncryptedStore({ directory, safeStorage: reversibleSafeStorage, ...options });
    await run({ store, directory, filePath: path.join(directory, "secure-state.bin") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("corrupt plaintext never turns into an empty writable workspace", async () => {
  await withStore(async ({ store, filePath }) => {
    await writeFile(filePath, "not valid JSON");
    await assert.rejects(store.readAll(), { code: "STORAGE_RECOVERY_REQUIRED" });
    await assert.rejects(store.set("new", true), { code: "STORAGE_RECOVERY_REQUIRED" });
    assert.equal(await readFile(filePath, "utf8"), "not valid JSON");
    await access(store.recoveryBackupPath);
    assert.equal(await readFile(store.recoveryBackupPath, "utf8"), "not valid JSON");
    assert.equal(store.health().recoveryAvailable, true);
  });
});

test("failed encryption preserves both committed memory and disk and the queue can retry", async () => {
  let fail = false;
  await withStore(async ({ store, filePath }) => {
    await store.set("revision", 1);
    fail = true;
    await assert.rejects(store.update({ revision: 2, extra: true }), { code: "STORAGE_ENCRYPT_FAILED" });
    assert.deepEqual(await store.readAll(), { revision: 1 });
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { revision: 1 });
    fail = false;
    await store.set("next", 3);
    assert.deepEqual(await store.readAll(), { revision: 1, next: 3 });
  }, { safeStorage: { ...reversibleSafeStorage, encryptString: (value) => {
    if (fail) throw new Error("simulated failure");
    return Buffer.from(value);
  } } });
});

test("unavailable encryption rejects writes instead of claiming memory-only success", async () => {
  let available = true;
  await withStore(async ({ store, filePath, directory }) => {
    await store.set("revision", 1);
    available = false;
    await assert.rejects(store.set("revision", 2), { code: "STORAGE_ENCRYPTION_UNAVAILABLE" });
    await assert.rejects(store.delete("revision"), { code: "STORAGE_ENCRYPTION_UNAVAILABLE" });
    assert.deepEqual(await store.readAll(), { revision: 1 });
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { revision: 1 });
    const restarted = new EncryptedStore({ directory, safeStorage: store.safeStorage });
    await assert.rejects(restarted.readAll(), { code: "STORAGE_ENCRYPTION_UNAVAILABLE" });
    available = true;
    assert.deepEqual(await restarted.readAll(), { revision: 1 });
  }, { safeStorage: { ...reversibleSafeStorage, isEncryptionAvailable: () => available } });
});

for (const phase of ["write", "sync", "rename"]) {
  test(`${phase} failure does not change cache or disk and cleans only its temporary file`, async () => {
    await withStore(async ({ store, filePath, directory }) => {
      await store.set("revision", 1);
      const originalIO = { ...store.fileIO };
      if (phase === "rename") store.fileIO.renameSync = () => { throw new Error("rename failed"); };
      else store.fileIO.open = async (...args) => {
        const handle = await open(...args);
        const operation = phase === "write" ? "writeFile" : "sync";
        handle[operation] = async () => { throw new Error(`${phase} failed`); };
        return handle;
      };
      await assert.rejects(store.set("revision", 2), { code: "STORAGE_WRITE_FAILED" });
      assert.deepEqual(await store.readAll(), { revision: 1 });
      assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { revision: 1 });
      assert.deepEqual(await readdir(directory), ["secure-state.bin"]);
      store.fileIO = originalIO;
      await store.set("revision", 3);
      assert.deepEqual(await new EncryptedStore({ directory, safeStorage: reversibleSafeStorage }).readAll(), { revision: 3 });
    });
  });
}

test("commit guard is rechecked after asynchronous IO and before atomic publication", async () => {
  await withStore(async ({ store, filePath, directory }) => {
    await store.set("revision", 1);
    let current = true;
    store.fileIO.open = async (...args) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); current = false; };
      return handle;
    };
    await assert.rejects(store.set("revision", 2, { commitGuard: () => current }), { code: "STALE_STORAGE_COMMIT" });
    assert.deepEqual(await store.readAll(), { revision: 1 });
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { revision: 1 });
    assert.deepEqual(await readdir(directory), ["secure-state.bin"]);
  });
});

test("reads during a pending write expose only committed state, with caller values detached", async () => {
  await withStore(async ({ store, filePath }) => {
    await store.set("revision", 1);
    let release;
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    store.fileIO.open = async (...args) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { ready(); await pending; await sync(); };
      return handle;
    };
    const value = { count: 2 };
    const write = store.set("payload", value);
    value.count = 99;
    await started;
    assert.deepEqual(await store.readAll(), { revision: 1 });
    release();
    await write;
    assert.deepEqual(await store.readAll(), { revision: 1, payload: { count: 2 } });
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), await store.readAll());
  });
});

test("storage health reports failed saves and recovery without leaking values or letting the UI reject a commit", async () => {
  const notifications = [];
  await withStore(async ({ store }) => {
    await store.set("privatePayload", "sensitive fixture");
    const savedAt = store.health().lastSavedAt;
    const originalEncrypt = store.safeStorage.encryptString;
    store.safeStorage = { ...store.safeStorage, encryptString: () => { throw new Error("private detail"); } };
    await assert.rejects(store.set("revision", 2), { code: "STORAGE_ENCRYPT_FAILED" });
    assert.equal(notifications.at(-1).state, "degraded");
    assert.equal(notifications.at(-1).lastSavedAt, savedAt);
    assert.equal(notifications.at(-1).errorCode, "STORAGE_ENCRYPT_FAILED");
    assert.doesNotMatch(JSON.stringify(notifications), /sensitive fixture|private detail/);
    store.safeStorage = { ...store.safeStorage, encryptString: originalEncrypt };
    await store.set("revision", 3);
    assert.equal(notifications.at(-1).state, "healthy");
    assert.equal(notifications.at(-1).errorCode, null);
    store.onHealthChange = () => { throw new Error("renderer detached"); };
    await store.set("revision", 4);
    assert.equal(await store.get("revision"), 4);
  }, { onHealthChange: value => notifications.push(value) });
});

test("ciphertext validation measures the actual full encrypted root before write and immediately before commit", async () => {
  await withStore(async ({ store, filePath }) => {
    await store.set("existingSidecar", { revision: 7 });
    const observed = [];
    await store.set("ledger", { records: [1, 2] }, { validateCiphertext: descriptor => {
      observed.push(descriptor); assert.equal(Object.isFrozen(descriptor), true); return true;
    } });
    const bytes = await readFile(filePath);
    assert.deepEqual(observed.map(item => item.phase), ["before_write", "before_commit"]);
    for (const item of observed) {
      assert.equal(item.name, "secure-state.bin");
      assert.equal(item.bytes, bytes.length);
      assert.equal(item.sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.deepEqual(Object.keys(item).sort(), ["bytes", "name", "phase", "sha256"]);
    }
    assert.deepEqual(await store.get("existingSidecar"), { revision: 7 });
  });
});

test("ciphertext rejection at either boundary preserves disk and cache, including validator errors and async callbacks", async () => {
  for (const phase of ["before_write", "before_commit"]) await withStore(async ({ store, filePath, directory }) => {
    await store.set("revision", 1);
    const original = await readFile(filePath);
    const rejected = Object.assign(new Error("容量校验拒绝"), { code: "FIXTURE_CAPACITY_LIMIT" });
    for (const reject of [() => false, () => { throw rejected; }]) {
      await assert.rejects(store.set("revision", 2, { validateCiphertext: descriptor => descriptor.phase !== phase || reject() }));
      assert.deepEqual(await readFile(filePath), original);
      assert.equal(await store.get("revision"), 1);
      assert.deepEqual(await readdir(directory), ["secure-state.bin"]);
    }
    for (const validateCiphertext of [async () => true, () => Promise.resolve(true), () => Promise.reject(new Error("async rejected"))]) {
      await assert.rejects(store.set("revision", 3, { validateCiphertext }), TypeError);
      assert.deepEqual(await readFile(filePath), original);
    }
  });
});

test("an opaque write permit admits only its specific frozen writer and is rechecked after validation and fsync", async () => {
  const permit = {}, fakePermit = {}; let frozen = false, valid = true;
  await withStore(async ({ store, filePath }) => {
    await store.set("revision", 1); frozen = true;
    await assert.rejects(store.set("revision", 2), { code: "STALE_STORAGE_COMMIT" });
    await assert.rejects(store.set("revision", 2, { writePermit: fakePermit }), { code: "STALE_STORAGE_COMMIT" });
    await store.set("revision", 2, { writePermit: permit, validateCiphertext: () => true });
    const saved = await readFile(filePath);
    for (const phase of ["before_write", "before_commit"]) {
      valid = true;
      await assert.rejects(store.set("revision", 3, { writePermit: permit, validateCiphertext: descriptor => {
        if (descriptor.phase === phase) valid = false;
        return true;
      } }), { code: "STALE_STORAGE_COMMIT" });
      assert.deepEqual(await readFile(filePath), saved);
      assert.equal(await store.get("revision"), 2);
    }
    valid = true;
    const actualOpen = store.fileIO.open;
    store.fileIO.open = async (...args) => {
      const handle = await actualOpen(...args), sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); valid = false; };
      return handle;
    };
    await assert.rejects(store.set("revision", 3, { writePermit: permit }), { code: "STALE_STORAGE_COMMIT" });
    assert.deepEqual(await readFile(filePath), saved);
  }, { canWrite: ({ writePermit }) => !frozen || (valid && writePermit === permit) });
});
