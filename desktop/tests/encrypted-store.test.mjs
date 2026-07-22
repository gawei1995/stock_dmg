import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("unreadable encrypted state is preserved before starting clean", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cockpit-store-"));
  try {
    const filePath = path.join(directory, "secure-state.bin");
    await writeFile(filePath, Buffer.from("unreadable"));
    const store = new EncryptedStore({
      directory,
      safeStorage: {
        ...reversibleSafeStorage,
        decryptString: () => { throw new Error("key unavailable"); },
      },
    });
    assert.deepEqual(await store.readAll(), {});
    assert.ok(store.recoveryBackupPath);
    await access(store.recoveryBackupPath);
    assert.equal((await readFile(store.recoveryBackupPath)).toString(), "unreadable");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
