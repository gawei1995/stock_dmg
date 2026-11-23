import assert from "node:assert/strict";
import test from "node:test";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DesktopOAuthProvider } from "../src/mcp/oauth-provider.mjs";
import { classifyLongbridgeError } from "../src/mcp/longbridge-client.mjs";
import { createProxyAwareFetch } from "../src/mcp/proxy-aware-fetch.mjs";

const issuer = "https://openapi.longbridge.com";
const prefix = "synthetic";
function fixture(entries = {}) {
  const values = new Map(Object.entries(entries).map(([k, v]) => [`${prefix}:${k}`, structuredClone(v)]));
  const provider = new DesktopOAuthProvider({ keyPrefix: prefix,
    redirectUrl: "http://127.0.0.1:54321/oauth/callback", onRedirect: async () => {},
    store: { get: async k => structuredClone(values.get(k)),
      set: async (k, v) => values.set(k, structuredClone(v)), delete: async k => values.delete(k) } });
  return { provider, values };
}
const discoveryState = {
  authorizationServerUrl: issuer,
  resourceMetadata: { resource: "https://mcp.longbridge.com/v2", authorization_servers: [issuer] },
  authorizationServerMetadata: { issuer, authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`, response_types_supported: ["code"],
    token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] },
};

test("superseded providers cannot read replacement credentials before or during an awaited store read", async () => {
  for (const method of ["clientInformation", "tokens"]) {
    let current = true, reads = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    const provider = new DesktopOAuthProvider({ redirectUrl: "http://127.0.0.1/callback", onRedirect: async () => {},
      commitGuard: () => current, store: { get: async () => { reads++; await gate; return { issuer, access_token: "replacement" }; } } });
    const pending = provider[method]();
    current = false; release();
    await assert.rejects(pending, { code: "STALE_LONGBRIDGE_AUTHORIZATION_GENERATION" });
    await assert.rejects(provider[method](), { code: "STALE_LONGBRIDGE_AUTHORIZATION_GENERATION" });
    assert.equal(reads, 1);
  }
});

test("legacy unbound client information or tokens never leave storage through actual SDK auth", async () => {
  for (const legacyField of ["clientInformation", "tokens"]) {
    const entries = { discoveryState,
      clientInformation: { client_id: "synthetic-client", issuer },
      tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh", token_type: "Bearer", issuer } };
    delete entries[legacyField].issuer;
    const { provider, values } = fixture(entries), before = structuredClone(values);
    let requests = 0;
    await assert.rejects(auth(provider, { serverUrl: "https://mcp.longbridge.com/v2",
      fetchFn: async () => { requests++; throw new Error("unexpected request"); } }), error => {
      assert.equal(error.code, "LONGBRIDGE_OAUTH_ISSUER_REQUIRED");
      assert.deepEqual(classifyLongbridgeError(error), { kind: "auth", code: 401, retryable: false, reauth: true });
      return true;
    });
    assert.equal(requests, 0);
    assert.deepEqual(values, before);
  }
});

test("issuer stamps survive storage and refresh token carry is limited to the same issuer", async () => {
  const { provider } = fixture();
  const client = { client_id: "synthetic-client", issuer, custom: "preserved" };
  await provider.saveClientInformation(client);
  assert.deepEqual(await provider.clientInformation(), client);
  await provider.saveTokens({ access_token: "a", refresh_token: "same-issuer-refresh", issuer });
  await provider.saveTokens({ access_token: "b", issuer: `${issuer}/` });
  assert.equal((await provider.tokens()).refresh_token, "same-issuer-refresh");
  await provider.saveTokens({ access_token: "c", issuer: "https://other.example" });
  assert.equal((await provider.tokens()).refresh_token, undefined);
  for (const invalid of [undefined, "", "http://auth.example", "https://user:pass@auth.example", "https://auth.example?x=1"]) {
    await assert.rejects(provider.saveTokens({ access_token: "bad", issuer: invalid }), { code: "LONGBRIDGE_OAUTH_ISSUER_REQUIRED" });
  }
});

test("actual SDK refresh retains issuer binding through the Electron fetch adapter", async () => {
  const { provider } = fixture({ discoveryState, clientInformation: { client_id: "synthetic-client", issuer },
    tokens: { access_token: "before", refresh_token: "synthetic-refresh", token_type: "Bearer", issuer } });
  const calls = [];
  const fetchFn = createProxyAwareFetch(async (input, init) => {
    calls.push({ input, init });
    return Response.json({ access_token: "after", token_type: "Bearer" });
  });
  assert.equal(await auth(provider, { serverUrl: "https://mcp.longbridge.com/v2", fetchFn }), "AUTHORIZED");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, `${issuer}/oauth2/token`);
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal((await provider.tokens()).issuer, issuer);
  assert.equal((await provider.tokens()).refresh_token, "synthetic-refresh");
});

test("actual SDK HTTP transport refuses cross-origin 307 without forwarding body or headers", async () => {
  const calls = [];
  const transport = new StreamableHTTPClientTransport(new URL("https://mcp.longbridge.com/v2"), {
    fetch: createProxyAwareFetch(async (input, init) => {
      calls.push({ input, init });
      return new Response(null, { status: 307, headers: { location: "https://foreign.example/collect" } });
    }), requestInit: { headers: { "X-Synthetic-Key": "fake-value" } },
  });
  await assert.rejects(transport.send({ jsonrpc: "2.0", id: 1, method: "ping" }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "https://mcp.longbridge.com/v2");
  assert.equal(calls[0].init.redirect, "manual");
  await transport.close();
});
