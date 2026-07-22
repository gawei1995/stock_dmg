import assert from "node:assert/strict";
import test from "node:test";
import {
  LongbridgeClient,
  LongbridgeToolError,
  classifyLongbridgeError,
} from "../src/mcp/longbridge-client.mjs";
import { OAuthLoopbackServer } from "../src/mcp/loopback-callback.mjs";

const memoryStore = {
  persistent: true,
  async get() { return null; },
  async set() {},
  async delete() {},
};

test("Longbridge MCP only accepts official HTTPS /v2 endpoints", () => {
  assert.throws(() => new LongbridgeClient({
    endpoint: "https://evil.example/v2",
    store: memoryStore,
    openExternal: async () => {},
  }), /official HTTPS \/v2/);
  assert.doesNotThrow(() => new LongbridgeClient({
    endpoint: "https://mcp.longbridge.cn/v2",
    store: memoryStore,
    openExternal: async () => {},
  }));
});

test("Longbridge client rejects every tool outside the query allowlist before connecting", async () => {
  const client = new LongbridgeClient({
    endpoint: "https://mcp.longbridge.com/v2",
    store: memoryStore,
    openExternal: async () => {},
  });
  await assert.rejects(client.call("submit_order", {}), /not in the desktop read-only allowlist/);
  await assert.rejects(client.call("watchlist_create", {}), /not in the desktop read-only allowlist/);
});

test("OAuth loopback callback ignores the wrong state and accepts the expected state", async () => {
  const server = new OAuthLoopbackServer({ port: 0, timeoutMs: 2_000 });
  await server.start();
  server.setExpectedState("expected-state");
  try {
    const wrong = await fetch(`${server.redirectUrl}?code=wrong&state=attacker`);
    assert.equal(wrong.status, 400);
    const accepted = fetch(`${server.redirectUrl}?code=good&state=expected-state`);
    const [response, result] = await Promise.all([accepted, server.waitForCallback()]);
    assert.equal(response.status, 200);
    assert.deepEqual(result, { code: "good", state: "expected-state" });
  } finally {
    await server.close();
  }
});

test("Longbridge error classification never treats gateway 463 as expired authorization", () => {
  const cases = [
    ["MCP error -32603: status error: 463 <unknown status code>", "gateway", false],
    ["openapi error 401003 token expired", "auth", true],
    ["invalid_token", "auth", true],
    ["invalid_grant", "auth", true],
    ["403 insufficient_scope", "permission", false],
    ["429002 api request is limited", "rate_limit", false],
    ["Streamable HTTP error: Error POSTing to endpoint: 463", "transport", false],
  ];
  for (const [message, kind, reauth] of cases) {
    const classification = classifyLongbridgeError(new Error(message));
    assert.equal(classification.kind, kind, message);
    assert.equal(classification.reauth, reauth, message);
  }
});

test("tool-level 463 preserves the live MCP session and encrypted OAuth state", async () => {
  const values = new Map();
  const tokenKey = "longbridge:mcp.longbridge.cn:tokens";
  const tokens = { access_token: "encrypted-at-rest-access", refresh_token: "encrypted-at-rest-refresh" };
  values.set(tokenKey, structuredClone(tokens));
  const deleted = [];
  const store = {
    persistent: true,
    async get(key) { return structuredClone(values.get(key)); },
    async set(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { deleted.push(key); values.delete(key); },
  };
  let closeCount = 0;
  let browserOpenCount = 0;
  const client = new LongbridgeClient({
    endpoint: "https://mcp.longbridge.cn/v2",
    store,
    openExternal: async () => { browserOpenCount += 1; },
  });
  client.client = {
    async callTool() {
      throw new Error("MCP error -32603: status error: 463 <unknown status code>");
    },
  };
  client.transport = { async close() { closeCount += 1; } };
  client.tools.set("exchange_rate", {});

  await assert.rejects(
    client.call("exchange_rate", {}),
    (error) => error instanceof LongbridgeToolError
      && error.kind === "gateway"
      && error.code === 463
      && error.reauth === false,
  );
  assert.equal(client.connected, true);
  assert.equal(closeCount, 0);
  assert.equal(browserOpenCount, 0);
  assert.deepEqual(await store.get(tokenKey), tokens);
  assert.deepEqual(deleted, []);
});

test("auth-level tool errors close the session so the next connection can refresh OAuth", async () => {
  let closeCount = 0;
  const client = new LongbridgeClient({
    endpoint: "https://mcp.longbridge.com/v2",
    store: memoryStore,
    openExternal: async () => {},
  });
  client.client = { async callTool() { throw new Error("401003 token expired"); } };
  client.transport = { async close() { closeCount += 1; } };
  client.tools.set("stock_positions", {});

  await assert.rejects(
    client.call("stock_positions", {}),
    (error) => error.kind === "auth" && error.reauth === true,
  );
  assert.equal(client.connected, false);
  assert.equal(closeCount, 1);
});

test("tool calls use injected SDK timeouts and preserve the session after timeout", async () => {
  let requestOptions;
  let closeCount = 0;
  const client = new LongbridgeClient({
    endpoint: "https://mcp.longbridge.cn/v2",
    store: memoryStore,
    openExternal: async () => {},
    toolTimeouts: { candlesticks: 15 },
  });
  client.client = {
    async callTool(_request, _schema, options) {
      requestOptions = options;
      await new Promise((_, reject) => {
        setTimeout(() => reject(new Error("MCP error -32001: Request timed out")), options.timeout);
      });
    },
  };
  client.transport = { async close() { closeCount += 1; } };
  client.tools.set("candlesticks", {});

  const startedAt = Date.now();
  await assert.rejects(
    client.call("candlesticks", { symbol: "AAPL.US" }),
    (error) => error instanceof LongbridgeToolError
      && error.kind === "timeout"
      && error.retryable === true
      && error.reauth === false,
  );

  assert.equal(requestOptions.timeout, 15);
  assert.equal(requestOptions.maxTotalTimeout, 15);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(client.connected, true);
  assert.equal(closeCount, 0);
});

test("a caller abort signal is passed to the MCP SDK request", async () => {
  const controller = new AbortController();
  let capturedSignal;
  const client = new LongbridgeClient({
    endpoint: "https://mcp.longbridge.com/v2",
    store: memoryStore,
    openExternal: async () => {},
  });
  client.client = {
    async callTool(_request, _schema, options) {
      capturedSignal = options.signal;
      return { content: [{ type: "text", text: "[]" }] };
    },
  };
  client.transport = { async close() {} };
  client.tools.set("quote", {});

  await client.call("quote", { symbols: ["AAPL.US"] }, { signal: controller.signal, timeoutMs: 25 });
  assert.equal(capturedSignal, controller.signal);
});
