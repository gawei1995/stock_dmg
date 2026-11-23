// Actual Electron net.fetch + installed MCP SDK. Only two synthetic loopback
// servers are reachable; no window, account, saved authorization or user profile.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, net, session } = require("electron");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-mcp-network-"));
const userData = path.join(temporaryRoot, "synthetic-profile");
const sessionData = path.join(temporaryRoot, "synthetic-session");
fs.mkdirSync(userData);
fs.mkdirSync(sessionData);
app.setPath("userData", userData);
app.setPath("sessionData", sessionData);
app.commandLine.appendSwitch("disable-background-networking");

const sourceRequests = [], foreignRequests = [], blockedRequests = [], transports = [];
const fakeKey = "synthetic-key-only";
const fakeSession = "synthetic-session-only";
const fakeAuthorization = "Bearer synthetic-access-only";
let sourceOrigin, foreignOrigin;

function createServer(log, handler) {
  return http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const captured = {
        method: request.method, path: request.url,
        key: request.headers["x-synthetic-key"],
        session: request.headers["mcp-session-id"],
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      log.push(captured);
      handler(captured, response);
    } catch {
      response.writeHead(500).end("Synthetic fixture failure");
    }
  });
}

const foreignServer = createServer(foreignRequests, (_request, response) => {
  response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: "synthetic-cross-origin", result: {} }));
});
const sourceServer = createServer(sourceRequests, (request, response) => {
  if (request.path === "/cross") {
    response.writeHead(307, { Location: `${foreignOrigin}/collect`, Connection: "close" }).end();
  } else if (request.path === "/same") {
    response.writeHead(307, { Location: "/accepted", Connection: "close" }).end();
  } else if (request.path === "/accepted") {
    response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(request.body).id, result: {} }));
  } else {
    response.writeHead(404, { Connection: "close" }).end();
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

app.whenReady().then(async () => {
  let failed = false;
  try {
    foreignOrigin = await listen(foreignServer);
    sourceOrigin = await listen(sourceServer);
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (request, callback) => {
      let allowed = false;
      try {
        const url = new URL(request.url);
        allowed = url.protocol === "http:" && url.hostname === "127.0.0.1"
          && [sourceOrigin, foreignOrigin].includes(url.origin);
      } catch { /* Unknown URL forms stay blocked. */ }
      if (!allowed) blockedRequests.push(request.url);
      callback({ cancel: !allowed });
    });

    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const { createProxyAwareFetch } = await import(pathToFileURL(path.join(__dirname, "../src/mcp/proxy-aware-fetch.mjs")).href);
    const sdkPackage = JSON.parse(fs.readFileSync(path.join(__dirname, "../node_modules/@modelcontextprotocol/sdk/package.json"), "utf8"));
    assert.equal(sdkPackage.version, "1.32.2");
    const fetchFn = createProxyAwareFetch((input, init) => net.fetch(input, init));
    const makeTransport = async (route) => {
      const transport = new StreamableHTTPClientTransport(new URL(`${sourceOrigin}${route}`), {
        fetch: fetchFn, sessionId: fakeSession,
        requestInit: { headers: { "X-Synthetic-Key": fakeKey, Authorization: fakeAuthorization } },
      });
      transports.push(transport);
      await transport.start();
      return transport;
    };

    const cross = await makeTransport("/cross");
    const crossMessage = { jsonrpc: "2.0", id: "synthetic-cross-origin", method: "ping" };
    let timeout = setTimeout(() => { void cross.close(); }, 10_000);
    try {
      await assert.rejects(cross.send(crossMessage), (error) => /redirect/i.test(error.message)
        && (error.code === 307 || error.message === "Redirect was cancelled"));
    } finally { clearTimeout(timeout); }
    assert.equal(foreignRequests.length, 0, "a different loopback port is a different origin and must receive no request");
    assert.equal(sourceRequests.length, 1);

    const same = await makeTransport("/same");
    const receivedMessages = [];
    same.onmessage = (message) => receivedMessages.push(message);
    const sameMessage = { jsonrpc: "2.0", id: "synthetic-same-origin", method: "ping" };
    timeout = setTimeout(() => { void same.close(); }, 10_000);
    let sameOriginOutcome = "followed_within_origin";
    try { await same.send(sameMessage); }
    catch (error) {
      // Chromium's net.fetch can reject a manual redirect rather than expose
      // its response. That is a stricter runtime policy: do not turn follow
      // back on merely to match the Node fetch behavior.
      assert.equal(error.message, "Redirect was cancelled");
      sameOriginOutcome = "runtime_refused_manual_redirect";
    }
    finally { clearTimeout(timeout); }
    assert.deepEqual(receivedMessages, sameOriginOutcome === "followed_within_origin"
      ? [{ jsonrpc: "2.0", id: sameMessage.id, result: {} }] : []);
    assert.deepEqual(sourceRequests.map((request) => request.path), sameOriginOutcome === "followed_within_origin"
      ? ["/cross", "/same", "/accepted"] : ["/cross", "/same"]);
    for (const request of sourceRequests) {
      assert.equal(request.method, "POST");
      assert.equal(request.key, fakeKey);
      assert.equal(request.session, fakeSession);
      assert.equal(request.authorization, fakeAuthorization);
      assert.equal(request.body, JSON.stringify(request.path === "/cross" ? crossMessage : sameMessage));
    }
    assert.equal(foreignRequests.length, 0);
    assert.equal(blockedRequests.length, 0, "the fixture must not attempt external traffic");
    process.stdout.write(`${JSON.stringify({
      status: "passed", sdkVersion: sdkPackage.version, electronVersion: process.versions.electron,
      networkStack: "actual_Electron_net.fetch", sourceRequestCount: sourceRequests.length,
      foreignRequestCount: foreignRequests.length, externalRequestAttempts: blockedRequests.length,
      crossOrigin307: "blocked_without_body_or_headers", sameOrigin307: sameOriginOutcome,
      profile: "fresh_temporary", browserWindowsCreated: 0, realAccountOrAuthorizationRead: false,
    })}\n`);
  } catch (error) {
    failed = true;
    process.stderr.write(`${error.stack}\n`);
  } finally {
    await Promise.allSettled(transports.map((transport) => transport.close()));
    await Promise.allSettled([closeServer(sourceServer), closeServer(foreignServer)]);
    app.once("will-quit", (event) => {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      if (failed) {
        event.preventDefault();
        app.exit(1);
      }
    });
    app.quit();
  }
}).catch(async (error) => {
  process.stderr.write(`${error.stack}\n`);
  await Promise.allSettled([closeServer(sourceServer), closeServer(foreignServer)]);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  app.exit(1);
});
