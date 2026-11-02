import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EncryptedStore } from "../src/security/encrypted-store.mjs";
import { AgentResultStore } from "../src/data/agent-result-store.mjs";
import { buildAnalysisEvidence } from "../src/engine/agent.mjs";
import { BusinessStateStore, BUSINESS_STATE_FILE, BUSINESS_STATE_KEYS,
  BUSINESS_STATE_MIGRATION_RECEIPT_KEY, validateBusinessStateDocument } from "../src/security/business-state-store.mjs";

const safeStorage = { isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`encrypted:${text}`),
  decryptString: (bytes) => {
    const text = bytes.toString();
    if (!text.startsWith("encrypted:")) throw new Error("wrong key");
    return text.slice(10);
  } };
const workspaceDirectory = "/fixture/stock-agent";

async function fixture(fn, initial = {}, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cockpit-business-state-"));
  try {
    const legacyStore = new EncryptedStore({ directory, safeStorage });
    await legacyStore.update(initial);
    const options = { directory, safeStorage, legacyStore, workspaceDirectory, ...overrides };
    const store = new BusinessStateStore(options);
    await fn({ directory, legacyStore, options, store,
      filePath: path.join(directory, BUSINESS_STATE_FILE),
      disk: async () => JSON.parse(safeStorage.decryptString(await readFile(path.join(directory, BUSINESS_STATE_FILE)))) });
  } finally { await rm(directory, { force: true, recursive: true }); }
}

test("migration selects exactly seven business keys and never enumerates credentials or runtime authority", async () => {
  await fixture(async ({ store, legacyStore, disk }) => {
    const originalGet = legacyStore.get.bind(legacyStore);
    const requested = [];
    legacyStore.get = async (key) => { requested.push(key); return originalGet(key); };
    const result = await store.initialize();
    assert.equal(result.legacyFallbackEnabled, false);
    assert.deepEqual(requested, [BUSINESS_STATE_MIGRATION_RECEIPT_KEY, ...BUSINESS_STATE_KEYS]);
    assert.deepEqual((await disk()).values, { watchPlans: [{ id: "p1" }], tradingViewLastUrl: "https://www.tradingview.com/chart/" });
    assert.deepEqual(await originalGet("oauthTokens"), { access_token: "secret-fixture" });
    assert.deepEqual(await originalGet("watchPlans"), [{ id: "p1" }]);
    assert.ok(await originalGet(BUSINESS_STATE_MIGRATION_RECEIPT_KEY));
    await assert.rejects(store.get("portfolioLedgerScopeIdV1"), { code: "BUSINESS_STATE_KEY_FORBIDDEN" });
    await assert.rejects(store.set("portfolioSnapshotBackgroundPreferencesV1", { enabled: true }), { code: "BUSINESS_STATE_KEY_FORBIDDEN" });
  }, { watchPlans: [{ id: "p1" }], tradingViewLastUrl: "https://www.tradingview.com/chart/",
    oauthTokens: { access_token: "secret-fixture" }, portfolioLedgerScopeIdV1: "old-scope",
    portfolioSnapshotBackgroundPreferencesV1: { enabled: true } });
});

test("normal writes and deletes never resurrect the retained legacy values, including after restart", async () => {
  await fixture(async ({ store, legacyStore, options, disk }) => {
    await store.initialize();
    await store.set("watchPlans", [{ id: "current" }]);
    await store.delete("lastAgentResult");
    await legacyStore.set("watchPlans", [{ id: "stale-copy" }]);
    const restarted = new BusinessStateStore(options);
    assert.deepEqual(await restarted.get("watchPlans"), [{ id: "current" }]);
    assert.equal(await restarted.get("lastAgentResult"), undefined);
    assert.equal(Object.hasOwn((await disk()).values, "lastAgentResult"), false);
  }, { watchPlans: [{ id: "old" }], lastAgentResult: { threadId: "legacy" } });
});

test("existing receipt with missing or corrupt target stops rather than remigrating stale source", async () => {
  await fixture(async ({ store, filePath, options }) => {
    await store.initialize();
    await rm(filePath);
    await assert.rejects(new BusinessStateStore(options).initialize(), { code: "BUSINESS_STATE_RECOVERY_REQUIRED" });
    await writeFile(filePath, safeStorage.encryptString("{}"));
    await assert.rejects(new BusinessStateStore(options).initialize(), { code: "BUSINESS_STATE_INVALID" });
    assert.equal(safeStorage.decryptString(await readFile(filePath)), "{}");
  }, { watchPlans: [{ id: "old" }] });
});

test("crash after target publication resumes target and completes receipt without reading stale business values", async () => {
  await fixture(async ({ store, legacyStore, options, disk }) => {
    const set = legacyStore.set.bind(legacyStore);
    legacyStore.set = async (key, ...args) => {
      if (key === BUSINESS_STATE_MIGRATION_RECEIPT_KEY) throw new Error("receipt write unavailable");
      return set(key, ...args);
    };
    await assert.rejects(store.initialize(), /receipt write unavailable/);
    assert.equal(store.document, null);
    const committed = await disk();
    await set("watchPlans", [{ id: "do-not-import" }]);
    legacyStore.set = set;
    const restarted = new BusinessStateStore(options);
    assert.deepEqual(await restarted.get("watchPlans"), [{ id: "initial" }]);
    assert.deepEqual(await disk(), committed);
  }, { watchPlans: [{ id: "initial" }] });
});

test("a valid restored document is allowed despite another migration receipt ID", async () => {
  await fixture(async ({ store, filePath, options, disk }) => {
    await store.initialize();
    const backup = await disk();
    await store.set("watchPlans", [{ id: "newer" }]);
    backup.migration.id = "11111111-1111-4111-8111-111111111111";
    await writeFile(filePath, safeStorage.encryptString(JSON.stringify(backup)));
    assert.deepEqual(await new BusinessStateStore(options).get("watchPlans"), [{ id: "backup" }]);
  }, { watchPlans: [{ id: "backup" }] });
});

test("migration validates the whole batch before any target or receipt is committed", async () => {
  await fixture(async ({ store, directory, legacyStore }) => {
    await assert.rejects(store.initialize(), { code: "BUSINESS_STATE_SECRET_FORBIDDEN" });
    assert.deepEqual(await readdir(directory), ["secure-state.bin"]);
    assert.equal(await legacyStore.get(BUSINESS_STATE_MIGRATION_RECEIPT_KEY), undefined);
    assert.equal((await legacyStore.get("lastAgentResult")).run.nested.access_token, "secret-fixture");
  }, { watchPlans: [{ id: "safe" }], lastAgentResult: { run: { nested: { access_token: "secret-fixture" } } } });
});

test("independent disk verification catches corruption before routing or receipt activation", async () => {
  await fixture(async ({ directory, legacyStore, options }) => {
    let targetReads = 0;
    const store = new BusinessStateStore({ ...options, fileIO: {
      readFile: async (file) => {
        if (file === path.join(directory, BUSINESS_STATE_FILE) && ++targetReads >= 3) return safeStorage.encryptString("{}");
        return readFile(file);
      },
    } });
    await assert.rejects(store.initialize(), { code: "BUSINESS_STATE_INVALID" });
    assert.equal(store.document, null);
    assert.equal(await legacyStore.get(BUSINESS_STATE_MIGRATION_RECEIPT_KEY), undefined);
    assert.deepEqual(await new BusinessStateStore(options).get("watchPlans"), []);
  }, { watchPlans: [] });
});

for (const phase of ["write", "sync", "rename"]) {
  test(`migration ${phase} failure leaves only the source and can retry`, async () => {
    await fixture(async ({ directory, legacyStore, options }) => {
      const fileIO = phase === "rename" ? { renameSync: () => { throw new Error("fixture"); } } : {
        open: async (...args) => {
          const file = await open(...args);
          file[phase === "write" ? "writeFile" : "sync"] = async () => { throw new Error("fixture"); };
          return file;
        },
      };
      await assert.rejects(new BusinessStateStore({ ...options, fileIO }).initialize(), { code: "STORAGE_WRITE_FAILED" });
      assert.deepEqual(await readdir(directory), ["secure-state.bin"]);
      assert.equal(await legacyStore.get(BUSINESS_STATE_MIGRATION_RECEIPT_KEY), undefined);
      assert.deepEqual(await new BusinessStateStore(options).get("watchPlans"), []);
    }, { watchPlans: [] });
  });
}

test("writes serialize; readonly flush does not mutate target or require write permission", async () => {
  let allowed = true;
  await fixture(async ({ store, filePath, options }) => {
    await store.initialize();
    await Promise.all([store.set("watchPlans", [{ id: "new" }]), store.set("lastAgentResult", { id: "latest" })]);
    assert.deepEqual(await store.readAll(), { watchPlans: [{ id: "new" }], lastAgentResult: { id: "latest" } });
    const before = await readFile(filePath);
    allowed = false;
    await assert.rejects(store.delete("watchPlans"), { code: "STALE_STORAGE_COMMIT" });
    await store.flush();
    assert.deepEqual(await readFile(filePath), before);
    const restarted = new BusinessStateStore(options);
    assert.deepEqual(await restarted.get("watchPlans"), [{ id: "new" }]);
  }, {}, { canWrite: () => allowed });
});

test("commitGuard combines caller identity and restore lock, and is rechecked after IO", async () => {
  let allowed = true;
  await fixture(async ({ store, filePath, options }) => {
    await store.initialize();
    await assert.rejects(store.set("watchPlans", [], { commitGuard: () => false }), { code: "STALE_STORAGE_COMMIT" });
    const before = await readFile(filePath);
    const locked = new BusinessStateStore({ ...options, canWrite: () => allowed, fileIO: {
      open: async (...args) => {
        const file = await open(...args);
        const sync = file.sync.bind(file);
        file.sync = async () => { await sync(); allowed = false; };
        return file;
      },
    } });
    await assert.rejects(locked.set("watchPlans", [{ id: "stale" }]), { code: "STALE_STORAGE_COMMIT" });
    assert.deepEqual(await readFile(filePath), before);
  }, { watchPlans: [] });
});

test("recursive secret fields, credential strings and URL credentials are rejected atomically", async () => {
  await fixture(async ({ store, disk }) => {
    await store.initialize();
    const before = await disk();
    for (const forbidden of [
      { context: [{ api_key: "fixture" }] }, { context: { codeVerifier: "fixture" } },
      { text: "Bearer abcdefghijklmnopqrstuvwxyz" }, { text: "-----BEGIN PRIVATE KEY-----" },
    ]) await assert.rejects(store.set("lastAgentResult", forbidden), { code: "BUSINESS_STATE_SECRET_FORBIDDEN" });
    await assert.rejects(store.set("tradingViewLastUrl", "https://www.tradingview.com/chart/?access_token=fixture"), { code: "BUSINESS_STATE_SECRET_FORBIDDEN" });
    await assert.rejects(store.update({ watchPlans: [], arbitrary: true }), { code: "BUSINESS_STATE_KEY_FORBIDDEN" });
    assert.deepEqual(await disk(), before);
    await store.set("lastAgentResult", { tokenUsage: { inputTokens: 42, outputTokens: 8 }, diagnostic: "OAuth service unavailable" });
  });
});

test("workspace provenance is required; unknown and external thread references stay preserved but confer no runtime ownership", async () => {
  const threads = [
    { threadId: "owned-thread", cwd: workspaceDirectory, name: "mine" },
    { threadId: "unknown-thread", name: "unproven" },
    { threadId: "foreign-thread", cwd: "/fixture/other", name: "foreign" },
  ];
  await fixture(async ({ store, disk }) => {
    assert.equal(await store.get("codexWorkspaceThread"), null);
    assert.deepEqual((await store.get("codexWorkspaceThreadRegistry")).threads, [threads[0]]);
    const document = await disk();
    assert.deepEqual(document.values.codexWorkspaceThreadRegistry.threads, threads);
    assert.equal(document.values.codexWorkspaceThread.threadId, "unknown-thread");
    assert.equal((await store.get("codexWorkspaceRecentHistoryIndex")).threads[0].id, "unknown-thread");
    assert.throws(() => validateBusinessStateDocument(document, { workspaceDirectory: "/fixture/other" }), { code: "BUSINESS_STATE_WORKSPACE_MISMATCH" });
    delete document.workspace;
    assert.throws(() => validateBusinessStateDocument(document), { code: "BUSINESS_STATE_INVALID" });
  }, { codexWorkspaceThread: threads[1], codexWorkspaceThreadRegistry: { version: 1, threads },
    codexWorkspaceRecentHistoryIndex: { version: 1, threads: [{ id: "unknown-thread", turns: [] }] } });
});

test("safeStorage unavailable never creates plaintext or silently serves retained source", async () => {
  await fixture(async ({ store, directory }) => {
    await assert.rejects(store.initialize(), { code: "STORAGE_ENCRYPTION_UNAVAILABLE" });
    assert.deepEqual(await readdir(directory), ["secure-state.bin"]);
  }, { watchPlans: [] }, { safeStorage: { ...safeStorage, isEncryptionAvailable: () => false } });
});

test("wrapper health reports post-initialization keychain failure and validation errors without payloads", async () => {
  let available = true;
  const notifications = [];
  await fixture(async ({ store, filePath }) => {
    await store.initialize();
    assert.equal(store.health().state, "healthy");
    available = false;
    assert.equal(store.health().state, "unavailable");
    await assert.rejects(store.flush(), { code: "STORAGE_ENCRYPTION_UNAVAILABLE" });
    assert.equal(notifications.at(-1).state, "unavailable");
    available = true;
    await writeFile(filePath, safeStorage.encryptString("{}"));
    await assert.rejects(store.flush(), { code: "BUSINESS_STATE_INVALID" });
    assert.equal(notifications.at(-1).state, "degraded");
    assert.equal(JSON.stringify(notifications).includes("sensitive-fixture"), false);
  }, { watchPlans: [{ id: "sensitive-fixture" }] }, {
    safeStorage: { ...safeStorage, isEncryptionAvailable: () => available },
    onHealthChange: (value) => notifications.push(value),
  });
});

test("out-of-band valid replacement or deletion is not overwritten by cached business values", async () => {
  await fixture(async ({ store, filePath, disk, options }) => {
    await store.initialize();
    const replacement = await disk();
    replacement.values.watchPlans = [{ id: "external-backup" }];
    await writeFile(filePath, safeStorage.encryptString(JSON.stringify(replacement)));
    await assert.rejects(store.flush(), { code: "BUSINESS_STATE_CHANGED_EXTERNALLY" });
    await assert.rejects(store.set("lastAgentResult", { id: "new" }), { code: "BUSINESS_STATE_CHANGED_EXTERNALLY" });
    assert.deepEqual(await disk(), replacement);
    assert.deepEqual(await new BusinessStateStore(options).get("watchPlans"), [{ id: "external-backup" }]);
    await rm(filePath);
    await assert.rejects(store.set("watchPlans", []), { code: "BUSINESS_STATE_RECOVERY_REQUIRED" });
  }, { watchPlans: [] });
});

test("real numeric portfolio evidence passes through AgentResultStore and survives restart", async () => {
  await fixture(async ({ store, options }) => {
    const timestamp = new Date().toISOString();
    const run = await buildAnalysisEvidence({ scope: "portfolio", portfolio: {
      status: "live", syncedAt: timestamp,
      positions: [{ symbol: "AAPL.US", ticker: "AAPL", instrumentType: "equity", quantity: 10,
        lastPrice: 200, quoteTimestamp: timestamp, quoteSession: "intraday", weight: 20,
        group: "Technology", pnlPercent: 10 }],
      account: { netAssets: 10_000, marginCall: null },
      dataQuality: { fxStatus: "live", sourceErrors: [], valuationComplete: true },
      fx: { currencyCount: 1 }, groupExposure: { Technology: 20 },
      totals: { top1Weight: 20, top5Weight: 20, cashRatio: 50 },
    } });
    const envelope = { threadId: "thread_real_evidence", operationId: "operation_real_evidence", completedAt: timestamp, run };
    await new AgentResultStore({ store }).save(envelope);
    const restored = await new AgentResultStore({ store: new BusinessStateStore(options) }).latest(envelope.threadId);
    assert.deepEqual(restored, envelope);
    assert.ok(restored.run.analysisContext.numericEvidence);
  });
});
