import assert from "node:assert/strict";
import test from "node:test";
import {
  LongbridgeClient,
  LongbridgeToolError,
  classifyLongbridgeError,
} from "../src/mcp/longbridge-client.mjs";
import { DesktopOAuthProvider } from "../src/mcp/oauth-provider.mjs";
import { OAuthLoopbackServer } from "../src/mcp/loopback-callback.mjs";

const memoryStore = {
  persistent: true,
  async get() { return null; },
  async set() {},
  async delete() {},
};

test("Longbridge MCP accepts only the global HTTPS /v2 endpoint", () => {
  assert.throws(() => new LongbridgeClient({
    endpoint: "https://evil.example/v2",
    store: memoryStore,
    openExternal: async () => {},
  }), /global HTTPS \/v2/);
  assert.throws(() => new LongbridgeClient({
    endpoint: "https://mcp.longbridge.cn/v2",
    store: memoryStore,
    openExternal: async () => {},
  }), /global HTTPS \/v2/);
  assert.doesNotThrow(() => new LongbridgeClient({
    endpoint: "https://mcp.longbridge.com/v2",
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

test("broker history queries are allowlisted without making them connection requirements", async () => {
  const client = new LongbridgeClient({
    endpoint: "https://mcp.longbridge.com/v2",
    store: memoryStore,
    openExternal: async () => {},
  });
  client.client = {
    async callTool({ name }) {
      return { content: [{ type: "text", text: JSON.stringify({ name, orders: [], trades: [] }) }] };
    },
  };
  client.transport = { async close() {} };
  for (const name of ["history_orders", "history_executions", "today_orders", "today_executions", "order_detail"]) {
    client.tools.set(name, {});
    assert.equal(client.supports(name), true);
    assert.equal((await client.call(name, {})).name, name);
  }
  assert.equal(client.supports("submit_order"), false);
});

test("OAuth discovery and MCP transport share the injected system-proxy fetch", async () => {
  const fetchFn = async () => new Response(null, { status: 401 });
  const authOptions = [];
  let expectedState = null;
  let transportOptions = null;
  let transportUrl = null;
  let createdTransport = null;
  let connectedTransport = null;
  let callbackClosed = false;
  const requiredTools = [
    "account_balance",
    "candlesticks",
    "exchange_rate",
    "quote",
    "stock_positions",
  ].map((name) => ({ name }));
  const client = new LongbridgeClient({
    store: memoryStore,
    openExternal: async () => {},
    fetchFn,
    networkStack: "electron-system-proxy",
    authFn: async (_provider, options) => {
      authOptions.push(options);
      return authOptions.length === 1 ? "REDIRECT" : "AUTHORIZED";
    },
    callbackFactory: () => ({
      redirectUrl: "http://127.0.0.1:54321/callback",
      async start() {},
      setExpectedState(value) { expectedState = value; },
      async waitForCallback() { return { code: "oauth-code", state: expectedState }; },
      async close() { callbackClosed = true; },
    }),
    clientFactory: () => ({
      async connect(transport) { connectedTransport = transport; },
      async listTools() { return { tools: requiredTools }; },
    }),
    transportFactory: (url, options) => {
      transportUrl = url;
      transportOptions = options;
      createdTransport = { async close() {} };
      return createdTransport;
    },
  });

  const status = await client.connect({ interactive: true });

  assert.equal(authOptions.length, 2);
  assert.equal(authOptions[0].fetchFn, fetchFn);
  assert.equal(authOptions[1].fetchFn, fetchFn);
  assert.equal(authOptions[0].serverUrl.toString(), "https://mcp.longbridge.com/v2");
  assert.equal(authOptions[1].serverUrl.toString(), "https://mcp.longbridge.com/v2");
  assert.equal(authOptions[1].authorizationCode, "oauth-code");
  assert.equal(transportOptions.fetch, fetchFn);
  assert.equal(transportUrl.toString(), "https://mcp.longbridge.com/v2");
  assert.equal(connectedTransport, createdTransport);
  assert.equal(callbackClosed, true);
  assert.equal(status.endpoint, "https://mcp.longbridge.com/v2");
  assert.equal(status.networkStack, "electron-system-proxy");
});

test("global OAuth policy rejects mainland authorization hosts", async () => {
  const opened = [];
  const oauth = new DesktopOAuthProvider({
    redirectUrl: "http://127.0.0.1:54321/callback",
    store: memoryStore,
    onRedirect: async (url) => opened.push(url.toString()),
  });
  await assert.rejects(
    oauth.redirectToAuthorization(new URL("https://openapi.longbridge.cn/oauth2/authorize?scope=6")),
    /unexpected Longbridge authorization URL/,
  );
  await oauth.redirectToAuthorization(
    new URL("https://openapi.longbridge.com/oauth2/authorize?scope=6"),
  );
  assert.deepEqual(opened, ["https://openapi.longbridge.com/oauth2/authorize?scope=6"]);
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
    ["fetch failed: unauthorized proxy", "transport", false],
    ["connect ECONNRESET 54.239.163.79:443", "transport", false],
    ["net::ERR_CONNECTION_RESET", "transport", false],
    ["ERR_PROXY_CONNECTION_FAILED", "transport", false],
    ["ERR_TUNNEL_CONNECTION_FAILED", "transport", false],
    ["ERR_NAME_NOT_RESOLVED", "transport", false],
  ];
  for (const [message, kind, reauth] of cases) {
    const classification = classifyLongbridgeError(new Error(message));
    assert.equal(classification.kind, kind, message);
    assert.equal(classification.reauth, reauth, message);
  }
});

test("transport fetch failures close only the live session and preserve global OAuth state", async () => {
  for (const transportFailure of [
    new TypeError("fetch failed"),
    new Error("connect ECONNRESET 54.239.163.79:443"),
  ]) {
    const values = new Map();
    const tokenKey = "longbridge:mcp.longbridge.com:tokens";
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
      store,
      openExternal: async () => { browserOpenCount += 1; },
    });
    client.client = {
      async callTool() {
        throw transportFailure;
      },
    };
    client.transport = { async close() { closeCount += 1; } };
    client.tools.set("quote", {});

    await assert.rejects(
      client.call("quote", { symbols: ["AAPL.US"] }),
      (error) => error instanceof LongbridgeToolError
        && error.kind === "transport"
        && error.retryable === true
        && error.reauth === false,
    );
    assert.equal(client.connected, false);
    assert.equal(closeCount, 1);
    assert.equal(browserOpenCount, 0);
    assert.deepEqual(await store.get(tokenKey), tokens);
    assert.deepEqual(deleted, []);
    assert.equal(client.endpoint, "https://mcp.longbridge.com/v2");
  }
});

test("tool-level 463 preserves the live MCP session and encrypted OAuth state", async () => {
  const values = new Map();
  const tokenKey = "longbridge:mcp.longbridge.com:tokens";
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
    endpoint: "https://mcp.longbridge.com/v2",
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
    endpoint: "https://mcp.longbridge.com/v2",
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
