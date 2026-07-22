import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { DesktopOAuthProvider } from "./oauth-provider.mjs";
import { OAuthLoopbackServer } from "./loopback-callback.mjs";

const READ_ONLY_TOOLS = new Set([
  "account_balance",
  "candlesticks",
  "exchange_rate",
  "option_quote",
  "quote",
  "stock_positions",
]);
const REQUIRED_TOOLS = new Set([
  "account_balance",
  "candlesticks",
  "exchange_rate",
  "quote",
  "stock_positions",
]);

const ORDER_TOOL_PATTERN = /(submit|replace|cancel|order|dca|alert_add|alert_delete)/i;

const DEFAULT_TOOL_TIMEOUT_MS = Object.freeze({
  account_balance: 12_000,
  candlesticks: 15_000,
  exchange_rate: 10_000,
  option_quote: 12_000,
  quote: 12_000,
  stock_positions: 12_000,
});

export class LongbridgeClient {
  constructor({
    endpoint = process.env.LONGBRIDGE_MCP_URL || "https://mcp.longbridge.com/v2",
    store,
    openExternal,
    onStatus = () => {},
    clientVersion = "0.5.0",
    toolTimeouts = {},
  }) {
    this.endpoint = validateEndpoint(endpoint);
    this.credentialPrefix = `longbridge:${new URL(this.endpoint).hostname}`;
    this.store = store;
    this.openExternal = openExternal;
    this.onStatus = onStatus;
    this.clientVersion = clientVersion;
    this.toolTimeouts = Object.fromEntries(
      [...READ_ONLY_TOOLS].map((name) => [
        name,
        normalizeTimeoutMs(toolTimeouts[name], DEFAULT_TOOL_TIMEOUT_MS[name]),
      ]),
    );
    this.client = null;
    this.transport = null;
    this.tools = new Map();
    this.connecting = null;
  }

  get connected() {
    return Boolean(this.client && this.transport);
  }

  async hasSavedAuthorization() {
    return Boolean(await this.store.get(`${this.credentialPrefix}:tokens`));
  }

  async connect({ interactive = true } = {}) {
    if (this.connected) return this.status();
    if (this.connecting) return this.connecting;
    this.connecting = this.#connect({ interactive }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async #connect({ interactive }) {
    const callback = new OAuthLoopbackServer({ port: 0 });
    await callback.start();
    const provider = new DesktopOAuthProvider({
      redirectUrl: callback.redirectUrl,
      store: this.store,
      keyPrefix: this.credentialPrefix,
      onRedirect: async (url) => {
        if (!interactive) {
          throw new Error("Longbridge authorization is required.");
        }
        this.onStatus({ state: "awaiting_auth", message: "等待长桥浏览器授权" });
        await this.openExternal(url.toString());
      },
    });
    callback.setExpectedState(provider.state());

    try {
      this.onStatus({ state: "connecting", message: "正在连接长桥只读 MCP" });
      const authResult = await auth(provider, {
        serverUrl: new URL(this.endpoint),
        scope: "6",
      });
      if (authResult === "REDIRECT") {
        if (!interactive) throw new Error("Longbridge authorization is required.");
        const { code, state } = await callback.waitForCallback();
        if (!provider.validateState(state)) {
          throw new Error("Longbridge OAuth state validation failed.");
        }
        await auth(provider, {
          serverUrl: new URL(this.endpoint),
          authorizationCode: code,
          scope: "6",
        });
      }
      await this.#attempt(provider);
      const listed = await this.client.listTools();
      this.tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
      const forbidden = ["submit_order", "replace_order", "cancel_order"].filter((name) =>
        this.tools.has(name),
      );
      if (forbidden.length) {
        throw new Error(`Longbridge endpoint exposed forbidden trade tools: ${forbidden.join(", ")}`);
      }
      const missing = [...REQUIRED_TOOLS].filter((name) => !this.tools.has(name));
      if (missing.length) {
        throw new Error(`Longbridge read-only endpoint is missing required tools: ${missing.join(", ")}`);
      }
      const exposedOrderTools = listed.tools.filter((tool) => ORDER_TOOL_PATTERN.test(tool.name));
      this.onStatus({
        state: "connected",
        message: "长桥已连接 · 查询权限",
        readOnlyTools: [...READ_ONLY_TOOLS].filter((name) => this.tools.has(name)),
        blockedToolCount: listed.tools.length
          - [...READ_ONLY_TOOLS].filter((name) => this.tools.has(name)).length,
        exposedOrderToolCount: exposedOrderTools.length,
      });
      return this.status();
    } catch (error) {
      this.tools.clear();
      await this.#closeClient();
      throw error;
    } finally {
      await callback.close();
    }
  }

  async #attempt(provider) {
    this.client = new Client(
      { name: "trading-cockpit-desktop", version: this.clientVersion },
      { capabilities: {} },
    );
    this.transport = new StreamableHTTPClientTransport(new URL(this.endpoint), {
      authProvider: provider,
    });
    await this.client.connect(this.transport);
  }

  status() {
    return {
      connected: this.connected,
      endpoint: this.endpoint,
      tools: [...this.tools.keys()].filter((name) => READ_ONLY_TOOLS.has(name)),
      orderWrite: false,
      persistentAuth: this.store.persistent,
    };
  }

  async call(name, args = {}, { signal, timeoutMs } = {}) {
    if (!READ_ONLY_TOOLS.has(name)) {
      throw new Error(`Tool ${name} is not in the desktop read-only allowlist.`);
    }
    if (!this.connected) await this.connect({ interactive: false });
    if (!this.tools.has(name)) {
      throw new Error(`Longbridge tool ${name} is unavailable for this account.`);
    }
    let result;
    try {
      const timeout = normalizeTimeoutMs(timeoutMs, this.toolTimeouts[name]);
      result = await this.client.callTool(
        { name, arguments: args },
        undefined,
        { signal, timeout, maxTotalTimeout: timeout },
      );
    } catch (error) {
      throw await this.#handleToolError(name, error);
    }
    if (result.isError) {
      throw await this.#handleToolError(
        name,
        new Error(extractErrorText(result) || `${name} failed.`),
      );
    }
    return extractToolData(result);
  }

  async #handleToolError(name, error) {
    const classification = classifyLongbridgeError(error);
    if (classification.kind === "auth" || classification.kind === "transport") {
      this.tools.clear();
      await this.#closeClient();
    }
    return new LongbridgeToolError(name, error, classification);
  }

  async disconnect({ forget = false } = {}) {
    await this.#closeClient();
    this.tools.clear();
    if (forget) {
      for (const name of ["tokens", "clientInformation", "codeVerifier", "discoveryState"]) {
        const key = `${this.credentialPrefix}:${name}`;
        await this.store.delete(key);
      }
    }
    this.onStatus({ state: "disconnected", message: "长桥未连接" });
  }

  async #closeClient() {
    try {
      await this.transport?.close?.();
    } catch {
      // The remote server may already have closed the session.
    }
    this.client = null;
    this.transport = null;
  }
}

export class LongbridgeToolError extends Error {
  constructor(tool, cause, classification = classifyLongbridgeError(cause)) {
    const detail = cause instanceof Error ? cause.message : String(cause ?? "未知错误");
    super(`Longbridge ${tool}: ${detail}`, { cause });
    this.name = "LongbridgeToolError";
    this.tool = tool;
    this.kind = classification.kind;
    this.code = classification.code;
    this.retryable = classification.retryable;
    this.reauth = classification.reauth;
  }
}

export function classifyLongbridgeError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  if (
    error?.name === "StreamableHTTPError"
    || /streamable http error|failed to fetch|fetch failed|econnreset|socket|network|session (?:closed|expired)|transport/.test(normalized)
  ) {
    return { kind: "transport", code: null, retryable: true, reauth: false };
  }
  if (/request timed out|request timeout|maximum total timeout exceeded|\btimed out\b/.test(normalized)) {
    return { kind: "timeout", code: null, retryable: true, reauth: false };
  }
  if (/\b463\b/.test(normalized)) {
    return { kind: "gateway", code: 463, retryable: true, reauth: false };
  }
  if (/429001|429002|\b429\b|rate.?limit|too many requests/.test(normalized)) {
    return { kind: "rate_limit", code: 429, retryable: true, reauth: false };
  }
  if (/401003|invalid[_ ]token|token expired|invalid[_ ]grant|unauthori[sz]ed/.test(normalized)) {
    return { kind: "auth", code: 401, retryable: true, reauth: true };
  }
  if (/insufficient[_ ]scope|permission denied|\b403\b/.test(normalized)) {
    return { kind: "permission", code: 403, retryable: false, reauth: false };
  }
  if (/status error: 5\d\d|\b50[0234]\b/.test(normalized)) {
    return { kind: "gateway", code: Number(normalized.match(/\b(50[0234])\b/)?.[1]) || null, retryable: true, reauth: false };
  }
  return { kind: "tool", code: null, retryable: false, reauth: false };
}

function normalizeTimeoutMs(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(Math.max(Math.trunc(parsed), 1), 120_000);
  }
  return fallback;
}

function validateEndpoint(value) {
  const url = new URL(value);
  const allowedHosts = new Set(["mcp.longbridge.com", "mcp.longbridge.cn"]);
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) || url.pathname !== "/v2") {
    throw new Error("Longbridge MCP endpoint must be an official HTTPS /v2 read-only endpoint.");
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function extractToolData(result) {
  if (result?.structuredContent && Object.keys(result.structuredContent).length) {
    return result.structuredContent;
  }
  const texts = (result?.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text.trim())
    .filter(Boolean);
  for (const value of texts) {
    try {
      return JSON.parse(value);
    } catch {
      // Continue; some MCP servers return explanatory text before JSON.
    }
  }
  return texts.length === 1 ? texts[0] : texts;
}

function extractErrorText(result) {
  return (result?.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}
