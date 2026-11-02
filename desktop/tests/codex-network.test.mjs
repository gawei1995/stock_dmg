import assert from "node:assert/strict";
import test from "node:test";
import {
  codexNetworkStatus,
  inspectCodexFeatures,
  normalizeCodexNetworkMode,
  parseCodexSystemProxyFeature,
  prepareCodexNetworkLaunch,
} from "../src/engine/codex-network.mjs";

test("network mode is an exact allowlist and rejects argument injection", () => {
  assert.equal(normalizeCodexNetworkMode(), "inherit");
  assert.equal(normalizeCodexNetworkMode("system"), "system");
  for (const value of [null, false, 1, {}, ["system"], " system", "system ", "SYSTEM", "system --disable apps", "--enable", "system;echo bad"]) {
    assert.throws(() => normalizeCodexNetworkMode(value), error => error.code === "invalid_mode");
  }
});

test("inherit mode preserves legacy arguments and never inspects CLI features", async () => {
  const result = await prepareCodexNetworkLaunch({ inspectFeatures: () => assert.fail("must not inspect") });
  assert.deepEqual(result.args, ["app-server", "--stdio"]);
  assert.deepEqual(result.network, codexNetworkStatus("inherit", { status: "ready" }));
});

test("system mode uses one native flag and records under-development status without rewriting environment", async () => {
  const environment = Object.freeze({ HTTPS_PROXY: "", https_proxy: "http://user:private@local.test:9", NO_PROXY: "<local>,localhost", no_proxy: "other", ALL_PROXY: "socks5://local.test:8" });
  let observed;
  const result = await prepareCodexNetworkLaunch({
    mode: "system", codexPath: "/fake/codex", cwd: "/fake/workspace", env: environment,
    inspectFeatures: async options => { observed = options; return "other stable true\nrespect_system_proxy   under development  false\n"; },
  });
  assert.equal(observed.env, environment);
  assert.equal(observed.codexPath, "/fake/codex");
  assert.deepEqual(result.args, ["app-server", "--stdio", "--enable", "respect_system_proxy"]);
  assert.equal(result.network.stage, "under development");
  assert.equal(result.network.experimental, true);
  assert.equal(result.network.status, "ready");
  assert.doesNotMatch(JSON.stringify(result), /private|local\.test|NO_PROXY|https_proxy/);
});

test("feature parsing accepts known runtime lifecycle stages but never removed or ambiguous capabilities", () => {
  for (const stage of ["stable", "experimental", "under development", "deprecated"]) {
    assert.deepEqual(parseCodexSystemProxyFeature(`respect_system_proxy\t${stage}\tfalse\r\n`), { stage });
  }
  for (const output of [
    "respect_system_proxy removed false", "respect_system_proxy preview true", "respect_system_proxy stable maybe",
    "prefix_respect_system_proxy stable true", "respect_system_proxy_extra stable true", "respect_system_proxy stable true extra",
    "respect_system_proxy stable true\nrespect_system_proxy stable false", "", "Warning: respect_system_proxy stable true",
  ]) {
    assert.throws(() => parseCodexSystemProxyFeature(output), error => error.code === "unsupported");
  }
  assert.throws(() => parseCodexSystemProxyFeature("a".repeat(128 * 1024 + 1)), error => error.code === "inspection_failed");
});

test("feature inspection executes an exact read-only command without a shell or changed environment", async () => {
  const environment = { NO_PROXY: "untouched", HTTPS_PROXY: "" };
  let call;
  const result = await inspectCodexFeatures({
    codexPath: "/fake path/codex;literal", cwd: "/fake/workspace", env: environment, timeoutMs: 42,
    execFileImpl: (binary, args, options, callback) => {
      call = { binary, args, options };
      callback(null, "respect_system_proxy under development false", "ignored private stderr");
    },
  });
  assert.equal(call.binary, "/fake path/codex;literal");
  assert.deepEqual(call.args, ["features", "list"]);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.env, environment);
  assert.equal(call.options.timeout, 42);
  assert.equal(call.options.maxBuffer, 128 * 1024);
  assert.equal(result, "respect_system_proxy under development false");
});

test("feature inspection failure and timeout never expose subprocess diagnostics", async () => {
  for (const error of [new Error("private proxy token"), Object.assign(new Error("private"), { killed: true })]) {
    await assert.rejects(inspectCodexFeatures({
      codexPath: "/fake/codex", execFileImpl: (_bin, _args, _options, cb) => cb(error, "private stdout", "private stderr"),
    }), result => {
      assert.equal(result.code, error.killed ? "inspection_timeout" : "inspection_failed");
      assert.doesNotMatch(result.message, /private|token/);
      return true;
    });
  }
});

test("a hanging or throwing feature inspector fails closed with a bounded safe error", async () => {
  await assert.rejects(prepareCodexNetworkLaunch({
    mode: "system", inspectionTimeoutMs: 10, inspectFeatures: () => new Promise(() => {}),
  }), error => error.code === "inspection_timeout");
  await assert.rejects(prepareCodexNetworkLaunch({
    mode: "system", inspectFeatures: () => { throw new Error("private source data"); },
  }), error => error.code === "inspection_failed" && !error.message.includes("private"));
});

test("network status exposes only known fields and never implies a successful connection", () => {
  const result = codexNetworkStatus("system", { status: "ready", stage: "under development", errorCode: "private", url: "secret" });
  assert.equal(result.errorCode, null);
  assert.equal(result.experimental, true);
  assert.match(result.message, /非稳定|实际连通性以请求结果为准/);
  assert.equal(Object.hasOwn(result, "url"), false);
  assert.equal(codexNetworkStatus("system", { stage: "private" }).stage, null);
  assert.equal(codexNetworkStatus("inherit", { stage: "stable" }).stage, null);
  assert.equal(codexNetworkStatus("system", { stage: "stable" }).experimental, false);
  assert.equal(codexNetworkStatus("private input").mode, "unsupported");
  assert.equal(codexNetworkStatus("private input").errorCode, "invalid_mode");
  assert.doesNotMatch(JSON.stringify(codexNetworkStatus("private input")), /private input/);
});
