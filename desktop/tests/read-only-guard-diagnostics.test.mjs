import assert from "node:assert/strict";
import test from "node:test";
import { buildReadOnlyGuardDiagnostic } from "../src/engine/read-only-guard-diagnostics.mjs";

const tool = { server: "codex_apps", tool: "ibkr/place_order" };
function current(overrides = {}) {
  return { threadId: "synthetic-thread", generation: 3, revision: 7,
    proof: { generation: 3, revision: 7, updatedAt: 1_800_000_000_000, residualTools: [] }, ...overrides };
}
function coldReceipt(overrides = {}) {
  return { generation: 3, revision: 7, origin: "start",
    bindings: [{ ...tool, appId: "broker_app", operation: "place_order" }],
    config: { apps: { broker_app: { tools: { place_order: { enabled: false } } } } }, ...overrides };
}

test("idle has an actionable recheck and never claims readiness without proof", () => {
  assert.deepEqual(buildReadOnlyGuardDiagnostic(), {
    state: "idle", code: "no_session", title: "尚未核验分析会话",
    message: "当前没有已建立的分析会话。重新检查会尝试建立连接并核验只读保护。",
    action: "recheck", actionLabel: "重新检查", tools: [], checkedAt: null,
  });
  assert.equal(buildReadOnlyGuardDiagnostic({ threadId: "thread", ready: true }).code, "verification_missing");
});

test("checking supersedes cached startup and inventory failures", () => {
  for (const input of [{}, { startupFailure: { code: "runtime_unavailable" }, inventoryError: "ETIMEDOUT" }]) {
    const result = buildReadOnlyGuardDiagnostic({ ...input, checking: true, residualTools: [tool] });
    assert.equal(result.state, "checking");
    assert.equal(result.action, null);
    assert.equal(result.errorCategory, undefined);
    assert.deepEqual(result.tools, []);
  }
  assert.equal(buildReadOnlyGuardDiagnostic({ inventoryError: "ETIMEDOUT" }).state, "failed");
});

test("valid ready proof is unaffected by optional TradingView auth and runtime failures", () => {
  for (const server of [{ name: "tradingview", authStatus: "notLoggedIn" },
    { name: "tradingview", runtimeStatus: "failed", toolsUnavailable: true, toolsError: "OAuth failed" }]) {
    const result = buildReadOnlyGuardDiagnostic(current({ ready: true, servers: [server] }));
    assert.equal(result.state, "ready");
    assert.equal(result.action, null);
    assert.equal(result.checkedAt, 1_800_000_000_000);
  }
});

test("proof and receipt generation/revision mismatch require a new session", () => {
  for (const input of [current({ proof: { generation: 2, revision: 7 } }),
    current({ proof: { generation: 3, revision: 6 } }),
    current({ receipt: coldReceipt({ revision: 6 }) }),
    current({ receipt: coldReceipt({ generation: 2 }) })]) {
    const result = buildReadOnlyGuardDiagnostic({ ...input, ready: true });
    assert.equal(result.code, "session_configuration_stale");
    assert.equal(result.action, "new_session");
    assert.match(result.message, /历史记录会保留/);
  }
});

test("visible risky tools without a cold exact receipt require a new session", () => {
  for (const receipt of [null, coldReceipt({ origin: "hot_resume" }), coldReceipt({ bindings: [] }),
    coldReceipt({ config: { apps: { broker_app: { tools: { place_order: { enabled: true } } } } } })]) {
    const result = buildReadOnlyGuardDiagnostic(current({ receipt, residualTools: [tool] }));
    assert.equal(result.state, "blocked");
    assert.equal(result.code, "session_configuration_missing");
    assert.equal(result.action, "new_session");
    assert.deepEqual(result.tools, [tool]);
  }
});

test("newly discovered tool cannot borrow another tool's current cold receipt", () => {
  const result = buildReadOnlyGuardDiagnostic(current({ receipt: coldReceipt(),
    residualTools: [tool, { server: "codex_apps", tool: "ibkr/transfer" }] }));
  assert.equal(result.action, "new_session");
  assert.equal(result.code, "session_configuration_missing");
});

test("a conflicting ready flag cannot hide residual tools recorded in the proof", () => {
  const result = buildReadOnlyGuardDiagnostic(current({ ready: true,
    proof: { generation: 3, revision: 7, residualTools: [tool] } }));
  assert.equal(result.state, "blocked");
  assert.equal(result.action, "new_session");
  assert.deepEqual(result.tools, [tool]);
});

test("still-residual exact cold-denied tools recommend restart without promising success", () => {
  for (const origin of ["start", "cold_resume"]) {
    const result = buildReadOnlyGuardDiagnostic(current({ receipt: coldReceipt({ origin }), residualTools: [tool] }));
    assert.equal(result.state, "blocked");
    assert.equal(result.code, "policy_not_enforced");
    assert.equal(result.action, "restart");
    assert.match(result.message, /不保证恢复/);
    assert.deepEqual(result.tools, [tool]);
  }
});

test("MCP exact deny or allowlist receipts cover residual tools, not unconstrained servers", () => {
  const residualTools = [{ server: "broker", tool: "place_order" }];
  for (const policy of [{ disabled_tools: ["place_order"] }, { enabled_tools: ["get_positions"] }]) {
    const receipt = coldReceipt({ bindings: [], config: { mcp_servers: { broker: policy } } });
    assert.equal(buildReadOnlyGuardDiagnostic(current({ receipt, residualTools })).code, "policy_not_enforced");
  }
  const receipt = coldReceipt({ config: { mcp_servers: { broker: { disabled_tools: ["other"] } } } });
  assert.equal(buildReadOnlyGuardDiagnostic(current({ receipt, residualTools })).action, "new_session");
});

test("unverified residual Apps remain blocked without leaking App names or IDs", () => {
  const result = buildReadOnlyGuardDiagnostic(current({ receipt: coldReceipt(), residualApps: [
    { name: "https://secret.invalid/U1234567", appId: "secret-app-token" },
  ] }));
  assert.equal(result.action, "new_session");
  assert.doesNotMatch(JSON.stringify(result), /secret|U1234567/);
});

test("inventory errors are classified into precise safe advice without echoing secrets", () => {
  const cases = [
    ["ETIMEDOUT https://private.invalid/?token=secret /Users/private U1234567", "timeout", /响应正常/],
    [{ code: "HTTP_401", message: "Unauthorized secret-token" }, "auth", /完成登录或恢复授权/],
    [{ code: "HTTP_403" }, "auth", /完成登录或恢复授权/],
    ["MCP protocol invalid pagination cursor private-secret", "protocol", /格式或分页不完整/],
    ["ECONNRESET https://secret.invalid/token", "network", /不要关闭证书校验/],
    [{ message: "opaque-secret /Users/private U1234567" }, "unknown", /连接状态/],
    ["券商 MCP 工具清单未完整返回；请确认服务连接与授权后重新检查。", "protocol", /不完整/],
  ];
  for (const [inventoryError, category, advice] of cases) {
    const result = buildReadOnlyGuardDiagnostic(current({ inventoryError, ready: true }));
    assert.equal(result.state, "failed");
    assert.equal(result.errorCategory, category);
    assert.equal(result.code, `inventory_${category}`);
    assert.equal(result.action, "recheck");
    assert.match(result.message, advice);
    assert.doesNotMatch(JSON.stringify(result), /secret|private|https:|U1234567|\/Users/);
  }
  assert.equal(buildReadOnlyGuardDiagnostic(current({ proof: { generation: 3, revision: 7, error: "timeout" } })).errorCategory, "timeout");
});

test("known startup failure codes have scoped actions and no raw startup error data", () => {
  for (const code of ["config_unavailable", "app_identity_unavailable", "preflight_unavailable", "runtime_unavailable"]) {
    const result = buildReadOnlyGuardDiagnostic(current({ startupFailure: { code, message: "secret-token /Users/private" } }));
    assert.equal(result.state, "failed");
    assert.equal(result.code, code);
    assert.equal(result.action, code === "runtime_unavailable" ? "restart" : "recheck");
    assert.doesNotMatch(JSON.stringify(result), /secret|private|\/Users/);
  }
  assert.equal(buildReadOnlyGuardDiagnostic({ startupFailure: { code: "secret-token" } }).code, "startup_unavailable");
});

test("tool details reject unsafe identifiers, URLs, paths, account IDs and tokens", () => {
  const unsafe = ["<script>secret</script>", "broker name", "https://private.invalid/path", "/Users/private/token",
    "Users/private/token", "U1234567", "123456789", "file:/Users/private", "sk-abcdefghijklmnopqrstuv", "a".repeat(121), "a".repeat(64),
    "eyJabc.defghi.jklmn", null, { toString() { throw new Error("must not stringify"); } }];
  for (const value of unsafe) {
    const result = buildReadOnlyGuardDiagnostic(current({ residualTools: [{ server: value, tool: value }] }));
    assert.deepEqual(result.tools, [{ server: "未知服务", tool: "未知工具" }]);
    assert.doesNotMatch(JSON.stringify(result), /secret|private|U1234567|sk-abcdefghijkl/);
  }
  const result = buildReadOnlyGuardDiagnostic(current({ residualTools: [tool, tool,
    { server: "mcp.broker-v2", tool: "broker.v2:place_order/safe" }] }));
  assert.deepEqual(result.tools, [tool, { server: "mcp.broker-v2", tool: "broker.v2:place_order/safe" }]);
});

test("tool details and timestamps remain bounded and input data is not mutated", () => {
  const input = current({ residualTools: Array.from({ length: 50 }, (_, index) => ({ server: "broker", tool: `tool_${index}` })) });
  const before = structuredClone(input);
  assert.equal(buildReadOnlyGuardDiagnostic(input).tools.length, 12);
  assert.deepEqual(input, before);
  for (const updatedAt of ["secret-token", -1, Infinity, NaN, 8_640_000_000_000_001]) {
    assert.equal(buildReadOnlyGuardDiagnostic(current({ proof: { generation: 3, revision: 7, updatedAt } })).checkedAt, null);
  }
});
