import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  DesktopOAuthProvider,
  LONGBRIDGE_READ_SCOPE,
} from "./oauth-provider.mjs";
import { OAuthLoopbackServer } from "./loopback-callback.mjs";

const AUTHORIZATION_PROFILE = "v2-read-6-10";
const LEGACY_AUTHORIZATION_PROFILES = [null];

const READ_ONLY_TOOLS = new Set([
  "account_balance",
  "candlesticks",
  "exchange_rate",
  "finance_calendar",
  "history_executions",
  "history_orders",
  "order_detail",
  "option_quote",
  "quote",
  "stock_positions",
  "today_executions",
  "today_orders",
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
  finance_calendar: 20_000,
  history_executions: 20_000,
  history_orders: 20_000,
  order_detail: 12_000,
  option_quote: 12_000,
  quote: 12_000,
  stock_positions: 12_000,
  today_executions: 12_000,
  today_orders: 12_000,
});

export class LongbridgeClient {
  constructor({
    endpoint = "https://mcp.longbridge.com/v2",
    store,
    openExternal,
    onStatus = () => {},
    clientVersion = "0.5.0",
    toolTimeouts = {},
    fetchFn = globalThis.fetch,
    networkStack = "node-fetch",
    authFn = auth,
    clientFactory = (info, options) => new Client(info, options),
    transportFactory = (url, options) => new StreamableHTTPClientTransport(url, options),
    callbackFactory = () => new OAuthLoopbackServer({ port: 0 }),
  }) {
    this.endpoint = validateEndpoint(endpoint);
    if (typeof fetchFn !== "function") {
      throw new TypeError("Longbridge fetchFn must be a function.");
    }
    this.credentialBasePrefix = `longbridge:${new URL(this.endpoint).hostname}`;
    this.credentialPrefix = `${this.credentialBasePrefix}:${AUTHORIZATION_PROFILE}`;
    this.store = store;
    this.openExternal = openExternal;
    this.onStatus = onStatus;
    this.clientVersion = clientVersion;
    this.fetchFn = fetchFn;
    this.networkStack = String(networkStack || "custom-fetch");
    this.authFn = authFn;
    this.clientFactory = clientFactory;
    this.transportFactory = transportFactory;
    this.callbackFactory = callbackFactory;
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
    this.connectingGeneration = null;
    this.connectionGeneration = 0;
    this.authorizationCallbacks = new Set();
    this.closedAuthorizationCallbacks = new WeakSet();
  }

  get connected() {
    return Boolean(this.client && this.transport);
  }

  async hasSavedAuthorization() {
    return Boolean(await this.store.get(`${this.credentialPrefix}:tokens`));
  }

  async needsAuthorizationUpgrade() {
    if (await this.hasSavedAuthorization()) return false;
    for (const profile of LEGACY_AUTHORIZATION_PROFILES) {
      const prefix = profile ? `${this.credentialBasePrefix}:${profile}` : this.credentialBasePrefix;
      if (await this.store.get(`${prefix}:tokens`)) return true;
    }
    return false;
  }

  async connect({ interactive = true } = {}) {
    if (this.connected) return this.status();
    const generation = this.connectionGeneration;
    if (this.connecting && this.connectingGeneration === generation) return this.connecting;
    const connecting = this.#connect({ interactive, generation }).finally(() => {
      if (this.connecting === connecting) {
        this.connecting = null;
        this.connectingGeneration = null;
      }
    });
    this.connecting = connecting;
    this.connectingGeneration = generation;
    return connecting;
  }

  async #connect({ interactive, generation }) {
    const callback = this.callbackFactory();
    this.authorizationCallbacks.add(callback);
    await callback.start();
    this.#assertConnectionGeneration(generation);
    const provider = new DesktopOAuthProvider({
      redirectUrl: callback.redirectUrl,
      store: this.store,
      keyPrefix: this.credentialPrefix,
      commitGuard: () => generation === this.connectionGeneration,
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
      const authResult = await this.authFn(provider, {
        serverUrl: new URL(this.endpoint),
        scope: LONGBRIDGE_READ_SCOPE,
        fetchFn: this.fetchFn,
      });
      this.#assertConnectionGeneration(generation);
      if (authResult === "REDIRECT") {
        if (!interactive) throw new Error("Longbridge authorization is required.");
        const { code, state } = await callback.waitForCallback();
        this.#assertConnectionGeneration(generation);
        if (!provider.validateState(state)) {
          throw new Error("Longbridge OAuth state validation failed.");
        }
        await this.authFn(provider, {
          serverUrl: new URL(this.endpoint),
          authorizationCode: code,
          scope: LONGBRIDGE_READ_SCOPE,
          fetchFn: this.fetchFn,
        });
        this.#assertConnectionGeneration(generation);
      }
      await this.#attempt(provider, generation);
      this.#assertConnectionGeneration(generation);
      const activeClient = this.client;
      const listed = await activeClient.listTools();
      this.#assertConnectionGeneration(generation);
      if (activeClient !== this.client) throw staleConnectionGenerationError();
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
        networkStack: this.networkStack,
      });
      return this.status();
    } catch (error) {
      if (generation === this.connectionGeneration) {
        this.tools.clear();
        await this.#closeClient();
      }
      throw error;
    } finally {
      await this.#closeAuthorizationCallback(callback);
    }
  }

  async #attempt(provider, generation) {
    const candidateClient = this.clientFactory(
      { name: "trading-cockpit-desktop", version: this.clientVersion },
      { capabilities: {} },
    );
    const candidateTransport = this.transportFactory(new URL(this.endpoint), {
      authProvider: provider,
      fetch: this.fetchFn,
    });
    try {
      await candidateClient.connect(candidateTransport);
      this.#assertConnectionGeneration(generation);
    } catch (error) {
      try {
        await candidateTransport?.close?.();
      } catch {
        // Best effort cleanup of a connection invalidated during setup.
      }
      throw error;
    }
    this.client = candidateClient;
    this.transport = candidateTransport;
  }

  status() {
    return {
      connected: this.connected,
      endpoint: this.endpoint,
      tools: [...this.tools.keys()].filter((name) => READ_ONLY_TOOLS.has(name)),
      orderWrite: false,
      persistentAuth: this.store.persistent,
      networkStack: this.networkStack,
    };
  }

  supports(name) {
    return READ_ONLY_TOOLS.has(name) && this.tools.has(name);
  }

  async call(name, args = {}, { signal, timeoutMs } = {}) {
    if (!READ_ONLY_TOOLS.has(name)) {
      throw new Error(`Tool ${name} is not in the desktop read-only allowlist.`);
    }
    if (!this.connected) await this.connect({ interactive: false });
    if (!this.tools.has(name)) {
      throw new Error(`Longbridge tool ${name} is unavailable for this account.`);
    }
    const generation = this.connectionGeneration;
    const activeClient = this.client;
    let result;
    try {
      const timeout = normalizeTimeoutMs(timeoutMs, this.toolTimeouts[name]);
      result = await activeClient.callTool(
        { name, arguments: args },
        undefined,
        { signal, timeout, maxTotalTimeout: timeout },
      );
    } catch (error) {
      if (generation !== this.connectionGeneration || activeClient !== this.client) {
        throw staleConnectionGenerationError();
      }
      throw await this.#handleToolError(name, error);
    }
    if (generation !== this.connectionGeneration || activeClient !== this.client) {
      throw staleConnectionGenerationError();
    }
    if (result.isError) {
      throw await this.#handleToolError(
        name,
        new Error(extractErrorText(result) || `${name} failed.`),
      );
    }
    const data = extractToolData(result);
    // Some broker failures arrive as successful MCP envelopes (isError=false).
    // Never turn their empty placeholder fields into a successful data refresh.
    if (data && !Array.isArray(data) && typeof data === "object"
        && data.error_code != null && String(data.error_code).trim() !== ""
        && String(data.error_code) !== "0") {
      const code = String(data.error_code).slice(0, 40);
      const detail = String(data.message || "券商返回业务错误").slice(0, 500);
      const error = new Error(`${code}: ${detail}`);
      error.code = data.error_code;
      throw await this.#handleToolError(name, error);
    }
    return data;
  }

  async #handleToolError(name, error) {
    const classification = classifyLongbridgeError(error);
    if (classification.kind === "auth" || classification.kind === "transport" || classification.reauth) {
      this.tools.clear();
      await this.#closeClient();
    }
    return new LongbridgeToolError(name, error, classification);
  }

  async disconnect({ forget = false } = {}) {
    this.connectionGeneration += 1;
    this.connecting = null;
    this.connectingGeneration = null;
    const callbacks = [...this.authorizationCallbacks];
    this.authorizationCallbacks.clear();
    await Promise.allSettled(callbacks.map((callback) => this.#closeAuthorizationCallback(callback)));
    await this.#closeClient();
    this.tools.clear();
    if (forget) {
      const prefixes = [
        this.credentialPrefix,
        ...LEGACY_AUTHORIZATION_PROFILES.map((profile) =>
          profile ? `${this.credentialBasePrefix}:${profile}` : this.credentialBasePrefix),
      ];
      for (const prefix of prefixes) {
        for (const name of ["tokens", "clientInformation", "codeVerifier", "discoveryState"]) {
          await this.store.delete(`${prefix}:${name}`);
        }
      }
    }
    this.onStatus({ state: "disconnected", message: "长桥未连接" });
  }

  #assertConnectionGeneration(generation) {
    if (generation !== this.connectionGeneration) throw staleConnectionGenerationError();
  }

  async #closeAuthorizationCallback(callback) {
    this.authorizationCallbacks.delete(callback);
    if (!callback || this.closedAuthorizationCallbacks.has(callback)) return;
    this.closedAuthorizationCallbacks.add(callback);
    await callback.close();
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
  const explicitCode = Number(error?.code);
  if (
    error?.name === "StreamableHTTPError"
    || /streamable http error|failed to fetch|fetch failed|econnreset|socket|network|session (?:closed|expired)|transport|net::err_[a-z0-9_]+|err_(?:connection|proxy|tunnel|name_not_resolved|internet_disconnected)/.test(normalized)
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
  if (
    explicitCode === 403308
    || /403308|target api(?:'s)? scope is not in authorized scopes|scope is not in authorized scopes/.test(normalized)
  ) {
    return { kind: "permission", code: 403308, retryable: false, reauth: true };
  }
  if (explicitCode === 301604 || /\b301604\b|no quote access/.test(normalized)) {
    return { kind: "permission", code: 301604, retryable: false, reauth: false };
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

function staleConnectionGenerationError() {
  const error = new Error("Longbridge authorization changed while the connection was opening.");
  error.code = "STALE_LONGBRIDGE_AUTHORIZATION_GENERATION";
  return error;
}

function validateEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "mcp.longbridge.com" || url.pathname !== "/v2") {
    throw new Error("Longbridge MCP endpoint must be the global HTTPS /v2 read-only endpoint.");
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
