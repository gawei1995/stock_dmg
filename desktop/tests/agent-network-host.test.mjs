import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { EncryptedStore } from "../src/security/encrypted-store.mjs";

const source = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
const preload = await readFile(new URL("../preload.cjs", import.meta.url), "utf8");
function extract(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}
function fixture({ saved = null, failWrite = false, frozen = false } = {}) {
  const writes = [], handlers = new Map();
  const context = vm.createContext({
    AGENT_NETWORK_PREFS_KEY: "network-test", DEFAULT_AGENT_NETWORK_MODE: "system",
    agentNetworkPreferences: { mode: "inherit" }, effectiveAgentNetworkMode: "inherit",
    assertTrustedSender: () => {},
    assertTrustedRestoreIdle: () => { if (frozen) throw new Error("restore frozen"); },
    secureStore: {
      get: async key => { assert.equal(key, "network-test"); return saved; },
      set: async (key, value, options) => {
        assert.equal(options.commitGuard(), true);
        if (failWrite) throw new Error("save failed");
        writes.push({ key, value: { ...value } });
      },
    },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    codexAnalysis: {
      dispose: () => { throw new Error("settings must not stop an active runtime"); },
      prepare: () => { throw new Error("settings must not start a runtime"); },
    },
  });
  vm.runInContext(extract("async function loadAgentNetworkPreferences(", "\nfunction registerIpc("), context);
  vm.runInContext(extract('  ipcMain.handle("agent:network:preferences"', '\n  ipcMain.handle('), context);
  return { context, writes, save: request => handlers.get("agent:network:preferences")({}, request) };
}

test("Agent network preferences use the user-confirmed default, preserve explicit choices, and reject invalid routing", async () => {
  assert.equal((await fixture().context.loadAgentNetworkPreferences()).mode, "system");
  assert.match(source, /const DEFAULT_AGENT_NETWORK_MODE = "system"/);
  for (const mode of ["inherit", "system"]) {
    assert.equal((await fixture({ saved: { mode } }).context.loadAgentNetworkPreferences()).mode, mode);
  }
  assert.equal((await fixture({ saved: { mode: "invalid --flag" } }).context.loadAgentNetworkPreferences()).mode, "unsupported");
  assert.match(source, /networkMode: effectiveAgentNetworkMode/);
  assert.match(source, /agentNetwork: agentNetworkPreferencesSnapshot\(\)/);
  assert.match(preload, /setAgentNetworkPreferences:.*agent:network:preferences/);
});

test("Agent network save affects next launch only and strips unrecognized payload fields", async () => {
  const { context, writes, save } = fixture();
  const result = await save({ mode: "system", proxyUrl: "https://must-not-be-used.invalid", model: "not-a-setting" });
  assert.equal(result.mode, "system");
  assert.equal(result.effectiveMode, "inherit");
  assert.equal(result.requiresRestart, true);
  assert.deepEqual(writes, [{ key: "network-test", value: { mode: "system" } }]);
  assert.equal(context.effectiveAgentNetworkMode, "inherit");
  const reverted = await save({ mode: "inherit" });
  assert.equal(reverted.requiresRestart, false);
});

test("Agent network validation, failed persistence and restore freeze retain the prior setting", async () => {
  for (const request of [null, {}, { mode: true }, { mode: "system --disable guard" }]) {
    const value = fixture();
    await assert.rejects(value.save(request), /请选择/);
    assert.equal(value.writes.length, 0);
  }
  for (const options of [{ failWrite: true }, { frozen: true }]) {
    const value = fixture(options);
    await assert.rejects(value.save({ mode: "system" }), /save failed|restore frozen/);
    assert.equal(value.context.agentNetworkPreferences.mode, "inherit");
    assert.equal(value.writes.length, 0);
  }
});

test("Agent network setting commits through the production store and survives a fresh store instance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cockpit-network-store-"));
  // Synthetic reversible codec only; no real profile or Keychain data.
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value),
    decryptString: value => value.toString(),
  };
  try {
    const { context, save } = fixture();
    context.secureStore = new EncryptedStore({ directory, safeStorage });
    await context.secureStore.set("unrelated", { retained: true });
    const saved = await save({ mode: "system" });
    assert.equal(saved.requiresRestart, true);
    context.secureStore = new EncryptedStore({ directory, safeStorage });
    assert.equal((await context.loadAgentNetworkPreferences()).mode, "system");
    assert.deepEqual(await context.secureStore.get("unrelated"), { retained: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
