import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRestrictedToolPolicy,
  requiredRestrictedFeatures,
  supportsRestrictedToolFeatures,
  verifyRestrictedToolIsolation,
} from "../src/engine/restricted-tool-policy.mjs";

test("restricted policy emits minimal deny deltas without replaying effective runtime defaults", () => {
  const config = {
    apps: { _default: { enabled: true }, known: { enabled: true, tools: { query: { enabled: true } } } },
    mcp_servers: { direct: { enabled: true, url: "https://private.invalid", tool_timeout_sec: null } },
    plugins: { "fixture@local": { enabled: true, mcp_servers: { bundled: { enabled: true, command: "private" } } } },
    features: { apps: true, plugins: true, remote_plugin: true, web_search: true },
    unrelated: "not replayed",
  };
  const before = structuredClone(config);
  assert.deepEqual(buildRestrictedToolPolicy(config), {
    apps: {
      _default: { enabled: false, destructive_enabled: false },
      known: { enabled: false, destructive_enabled: false },
    },
    mcp_servers: { direct: { enabled: false } },
    plugins: { "fixture@local": { enabled: false, mcp_servers: { bundled: { enabled: false } } } },
    features: { apps: false, plugins: false, remote_plugin: false },
  });
  assert.deepEqual(config, before);
});

test("empty optional maps still deny every App and required runtime integration feature", () => {
  assert.deepEqual(buildRestrictedToolPolicy({ apps: null, mcp_servers: null, plugins: null }), {
    apps: { _default: { enabled: false, destructive_enabled: false } },
    mcp_servers: {}, plugins: {}, features: { apps: false, plugins: false, remote_plugin: false },
  });
  assert.equal(Object.isFrozen(requiredRestrictedFeatures), true);
});

test("restricted builder rejects malformed configuration and nested maps", () => {
  for (const value of [null, undefined, [], "config", 1, new Date(),
    { apps: [] }, { mcp_servers: [] }, { plugins: [] }, { apps: { fixture: [] } },
    { mcp_servers: { fixture: null } }, { plugins: { fixture: false } },
    { plugins: { fixture: { mcp_servers: [] } } }, { plugins: { fixture: { mcp_servers: { nested: [] } } } }]) {
    assert.throws(() => buildRestrictedToolPolicy(value), TypeError);
  }
});

test("deny maps preserve literal identity keys without changing object prototypes", () => {
  const input = JSON.parse('{"apps":{"__proto__":{"enabled":true}},"mcp_servers":{"constructor":{}},"plugins":{"prototype":{}}}');
  const result = buildRestrictedToolPolicy(input);
  assert.equal(Object.hasOwn(result.apps, "__proto__"), true);
  assert.deepEqual(result.apps.__proto__, { enabled: false, destructive_enabled: false });
  assert.equal(Object.getPrototypeOf(result.apps), Object.prototype);
  assert.deepEqual(result.mcp_servers.constructor, { enabled: false });
});

test("restricted feature support requires one recognized active-lifecycle row for all three flags", () => {
  const output = "apps stable true\nplugins stable true\nremote_plugin stable false\nother removed true";
  assert.equal(supportsRestrictedToolFeatures(output), true);
  assert.equal(supportsRestrictedToolFeatures(output.replace("plugins stable", "plugins under development")), true);
  for (const value of [null, output.replace("plugins stable true", ""), `${output}\napps stable false`,
    output.replace("plugins stable", "plugins removed"), output.replace("plugins stable", "plugins deprecated"),
    output.replace("plugins stable true", "plugins stable yes"), "x".repeat(1_000_001)]) {
    assert.equal(supportsRestrictedToolFeatures(value), false);
  }
});

test("restricted proof accepts complete disabled raw or normalized server rows and non-callable Apps", () => {
  for (const tools of [[], {}]) {
    assert.deepEqual(verifyRestrictedToolIsolation({
      servers: [{ name: "direct", tools, runtimeStatus: "disabled" }],
      apps: [{ id: "fixture", enabled: false, callable: false }],
    }), { ready: true, reason: "verified", unavailableTools: [] });
  }
  assert.deepEqual(verifyRestrictedToolIsolation({ servers: [], apps: [] }), { ready: true, reason: "verified", unavailableTools: [] });
});

test("incomplete inventories and malformed or errored tools can never become empty safe inventories", () => {
  for (const value of [{}, { servers: [], apps: [], complete: false }, { servers: {}, apps: [] },
    { servers: [], apps: {} }, { servers: [null], apps: [] },
    ...[undefined, null, "", 0].map(tools => ({ servers: [{ name: "broken", runtimeStatus: "disabled", tools }], apps: [] })),
    { servers: [{ name: "broken", runtimeStatus: "disabled", tools: {}, toolsError: "failure" }], apps: [] },
    { servers: [{ name: "broken", runtimeStatus: "disabled", tools: [], toolsUnavailable: true }], apps: [] }]) {
    const result = verifyRestrictedToolIsolation(value);
    assert.equal(result.ready, false);
    assert.equal(result.reason, "inventory_unavailable");
  }
});

test("any visible external tool, including ordinary research, blocks restricted isolation", () => {
  for (const tools of [[{ name: "get_quote" }], { get_quote: { name: "get_quote" } }]) {
    assert.equal(verifyRestrictedToolIsolation({ servers: [{ name: "fixture", tools, runtimeStatus: "disabled" }], apps: [] }).reason,
      "external_tools_visible");
  }
});

test("all App enabled and callable values must be explicitly false", () => {
  for (const app of [null, {}, { enabled: true, callable: false }, { enabled: false, callable: true },
    { enabled: false }, { callable: false }, { enabled: 0, callable: 0 }]) {
    assert.equal(verifyRestrictedToolIsolation({ servers: [], apps: [app] }).reason, "apps_callable");
  }
});

test("missing or non-disabled runtime state rejects even an empty research server", () => {
  for (const runtimeStatus of [undefined, null, "", "connected", "failed", "notStarted", "authenticationRequired"]) {
    assert.deepEqual(verifyRestrictedToolIsolation({ servers: [{ name: "fixture", runtimeStatus, tools: [] }], apps: [] }),
      { ready: false, reason: "server_not_disabled", unavailableTools: ["fixture"] });
  }
});
