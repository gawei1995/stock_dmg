import assert from "node:assert/strict";
import test from "node:test";
import { createProxyAwareFetch } from "../src/mcp/proxy-aware-fetch.mjs";

test("proxy-aware fetch converts MCP URL inputs and preserves request init", async () => {
  const calls = [];
  const response = new Response(null, { status: 401 });
  const electronFetch = async (input, init) => {
    calls.push({ input, init });
    return response;
  };
  const fetchFn = createProxyAwareFetch(electronFetch);
  const controller = new AbortController();
  const init = {
    method: "POST",
    headers: { accept: "application/json" },
    signal: controller.signal,
    body: "{}",
  };

  const result = await fetchFn(new URL("https://mcp.longbridge.com/v2"), init);

  assert.equal(result, response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "https://mcp.longbridge.com/v2");
  assert.equal(calls[0].init, init);
  assert.equal(calls[0].init.signal, controller.signal);
});

test("proxy-aware fetch preserves Request inputs for Electron", async () => {
  let capturedInput = null;
  const fetchFn = createProxyAwareFetch(async (input) => {
    capturedInput = input;
    return new Response(null, { status: 204 });
  });
  const request = new Request("https://mcp.longbridge.com/v2", {
    method: "GET",
  });

  await fetchFn(request);

  assert.equal(capturedInput, request);
});

test("proxy-aware fetch preserves streaming bodies, duplex, signal, and response identity", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("payload"));
      controller.close();
    },
  });
  const responseStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event: ready\n\n"));
      controller.close();
    },
  });
  const response = new Response(responseStream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const controller = new AbortController();
  let capturedInit = null;
  const fetchFn = createProxyAwareFetch(async (_input, init) => {
    capturedInit = init;
    return response;
  });
  const init = {
    method: "POST",
    body: stream,
    duplex: "half",
    signal: controller.signal,
  };

  const result = await fetchFn(new URL("https://mcp.longbridge.com/v2"), init);

  assert.equal(capturedInit, init);
  assert.equal(capturedInit.body, stream);
  assert.equal(capturedInit.duplex, "half");
  assert.equal(capturedInit.signal, controller.signal);
  assert.equal(result, response);
  assert.equal(result.body, responseStream);
  assert.equal(result.body.locked, false);
});

test("proxy-aware fetch rejects a missing Electron fetch implementation", () => {
  assert.throws(() => createProxyAwareFetch(null), /must be a function/);
});
