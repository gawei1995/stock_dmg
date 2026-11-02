import https from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeIbkrPortfolio } from "../data/ibkr-portfolio.mjs";
import { withPortfolioFreshness } from "../data/freshness.mjs";
import { readTws } from "./ibkr-tws.mjs";

const CONFIG_KEY = "ibkrGatewayConfigV1";
const SNAPSHOT_KEY = "ibkrPortfolioSnapshotV1";
const FIELDS = "31,84,86,6509,7308,7309,7310,7311,7633,7638";
export function normalizeGatewayConfig(input = {}) {
  const transport = input.transport ?? "tws";
  if (!["tws", "gateway"].includes(transport)) throw new Error("IBKR 连接类型无效。");
  const port = Number(input.port ?? (transport === "tws" ? 7496 : 5001));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("本机端口必须为 1024–65535。");
  const accountId = String(input.accountId ?? "");
  if (accountId && !/^[A-Z][A-Z0-9-]{2,30}$/.test(accountId)) throw new Error("IBKR 账户标识无效。");
  return { transport, port, accountId, enabled: input.enabled === true, trustLocalCertificate: transport === "gateway" && input.trustLocalCertificate === true };
}

// No generic URL, method, broker order, reply, exercise, transfer or session
// takeover capability is exposed. The only POST is a contract SEARCH query.
export function assertIbkrReadOnlyRequest(path, method = "GET") {
  if (typeof path !== "string" || path.includes("%") || path.includes("..") || path.includes("#")) throw new Error("IBKR 查询路径无效。");
  const pathname = path.split("?")[0];
  const allowed = method === "GET" && (
    ["/portfolio/accounts", "/iserver/accounts", "/iserver/marketdata/snapshot"].includes(pathname)
    || /^\/portfolio\/[A-Z][A-Z0-9-]{2,30}\/(summary|ledger|positions\/\d{1,2})$/.test(pathname)
    || /^\/iserver\/contract\/\d{1,16}\/info$/.test(pathname)
  ) || method === "POST" && pathname === "/iserver/secdef/search";
  if (!allowed) throw new Error("该 IBKR 操作不在只读查询白名单内。");
}

export function gatewayRequest({ config, path, method = "GET", body, signal }) {
  assertIbkrReadOnlyRequest(path, method);
  const normalized = normalizeGatewayConfig(config);
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = https.request({
      // Never resolve an arbitrary hostname or follow a redirect. The TLS
      // exception, when explicitly enabled, is confined to this loopback port.
      hostname: "127.0.0.1", servername: "localhost", port: normalized.port,
      path: `/v1/api${path}`, method, rejectUnauthorized: !normalized.trustLocalCertificate,
      signal, headers: { Accept: "application/json", ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      const chunks = [];
      let length = 0;
      res.on("data", (chunk) => {
        length += chunk.length;
        if (length > 8 * 1024 * 1024) req.destroy(new Error("IBKR 响应超过安全大小限制。"));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        if ([401, 403].includes(res.statusCode)) return reject(new Error("IBKR 登录已失效，请在本机网关页面登录后重新同步。"));
        if (res.statusCode === 429) return reject(new Error("IBKR 查询频率受限，请稍后刷新；不会自动密集重试。"));
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`IBKR 网关返回 HTTP ${res.statusCode}，未跟随重定向。`));
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (result?.error || result?.status === "fail") throw new Error("IBKR 返回业务错误；请检查网关登录、交易会话与行情权限。");
          resolve(result);
        } catch (error) {
          reject(error instanceof SyntaxError ? new Error("IBKR 返回的不是账户 JSON 数据，请确认端口属于 Client Portal Gateway（不是 TWS Socket）。") : error);
        }
      });
    });
    req.setTimeout(8_000, () => req.destroy(new Error("IBKR 网关查询超时；已停止等待。")));
    req.on("error", (error) => {
      if (error.code === "ECONNREFUSED") reject(new Error("未找到本机 IBKR Client Portal Gateway，请先启动网关并登录。"));
      else if (["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "CERT_HAS_EXPIRED"].includes(error.code)) reject(new Error("本机网关使用自签名证书。确认它是你的 IBKR 网关后，勾选仅信任本机网关证书。"));
      else reject(error);
    });
    req.end(payload ?? undefined);
  });
}

export class IbkrClient {
  constructor({ store, request = gatewayRequest, twsRead = readTws, onUpdate = () => {}, clock = () => Date.now(), pacingMs = 120 }) {
    this.store = store; this.request = request; this.onUpdate = onUpdate; this.clock = clock; this.pacingMs = pacingMs;
    this.twsRead = twsRead; this.config = normalizeGatewayConfig(); this.portfolio = null; this.accounts = [];
    this.state = "disconnected"; this.error = null; this.generation = 0; this.controller = null;
    this.running = null; this.queue = Promise.resolve(); this.lastStart = 0; this.lastRefresh = null;
  }
  async initialize() {
    const saved = await this.store.get(CONFIG_KEY);
    this.config = normalizeGatewayConfig(saved ? { transport: "gateway", ...saved } : {});
    const cached = await this.store.get(SNAPSHOT_KEY);
    if (this.config.enabled && cached?.configAccountId === this.config.accountId && cached?.port === this.config.port && (cached.transport ?? "gateway") === this.config.transport) {
      this.portfolio = withPortfolioFreshness({ ...cached.portfolio, status: "cached" }, { now: this.clock(), forceState: "cached" });
    }
  }
  status() { return { config: this.config, state: this.state, error: this.error,
    accounts: this.accounts.map((a) => ({ id: a.id ?? a.accountId, label: `IBKR · ${String(a.id ?? a.accountId).slice(0, 1)}***${String(a.id ?? a.accountId).slice(-3)}`, currency: a.currency })),
    syncing: Boolean(this.running), syncedAt: this.portfolio?.syncedAt ?? null, orderWrite: false }; }
  async configure(input) {
    const next = normalizeGatewayConfig(input);
    if (JSON.stringify(next) === JSON.stringify(this.config)) return;
    this.generation += 1;
    this.controller?.abort();
    // Drain prior work before changing configuration or persistence. Late
    // responses cannot repopulate a new account's cache.
    await this.running?.catch(() => {});
    const identityChanged = next.transport !== this.config.transport || next.port !== this.config.port || next.accountId !== this.config.accountId || !next.enabled;
    this.config = next; this.lastRefresh = null;
    if (identityChanged) { this.portfolio = null; this.accounts = []; await this.store.delete(SNAPSHOT_KEY); }
    await this.store.set(CONFIG_KEY, next);
    this.state = "disconnected"; this.error = null; this.onUpdate();
  }
  async discover() {
    return this.#operation(async (signal, generation) => {
      const accounts = this.config.transport === "tws"
        ? (await this.twsRead({ config: this.config, signal, mode: "accounts" })).accounts
        : await this.#read("/portfolio/accounts", { signal });
      if (!Array.isArray(accounts) || !accounts.length) throw new Error("IBKR 没有返回可用账户；请先登录所选客户端。");
      if (accounts.some((a) => !/^[A-Z][A-Z0-9-]{2,30}$/.test(String(a.id ?? a.accountId)))) throw new Error("IBKR 账户列表格式无效。");
      this.#check(generation); this.accounts = accounts; this.state = "connected";
      return this.status();
    });
  }
  async refresh() {
    if (!this.config.enabled) throw new Error("请先设置并连接本机 IBKR 客户端。");
    if (!this.config.accountId) throw new Error("请先检查连接并选择 IBKR 账户。");
    if (this.running) { await this.running; return this.refresh(); }
    if (this.lastRefresh != null && this.clock() - this.lastRefresh < 6_000 && this.portfolio) return this.portfolio;
    return this.#operation(async (signal, generation) => {
      if (this.config.transport === "tws") {
        const { accounts, snapshot } = await this.twsRead({ config: this.config, signal, mode: "portfolio", clock: this.clock });
        this.#check(generation); this.accounts = accounts;
        return this.#publish(snapshot, generation);
      }
      const accounts = await this.#read("/portfolio/accounts", { signal });
      if (!Array.isArray(accounts)) throw new Error("IBKR 账户列表响应无效。");
      const account = accounts.find((a) => (a.id ?? a.accountId) === this.config.accountId);
      if (!account) throw new Error("当前网关登录不包含已选择的 IBKR 账户，拒绝混用其他账户数据。");
      this.accounts = accounts;
      const prefix = `/portfolio/${this.config.accountId}`;
      const [summary, ledger, positions] = await Promise.all([
        this.#read(`${prefix}/summary`, { signal }), this.#read(`${prefix}/ledger`, { signal }),
        this.#positions(prefix, signal),
      ]);
      if (!summary || !ledger || Array.isArray(summary) || Array.isArray(ledger)) throw new Error("IBKR 资产/汇率响应无效。");
      // Account data is independent of optional quote work. Missing option
      // permissions never erase quantities, costs or broker portfolio values.
      const warnings = [], quotes = [];
      const optionRows = positions.filter((p) => ["OPT", "FOP"].includes(p.assetClass));
      try {
        await this.#read("/iserver/accounts", { signal });
        const incompleteContracts = positions.filter((p) =>
          ["OPT", "FOP"].includes(p.assetClass) && !(Number(p.multiplier) > 0)
          || p.assetClass === "STK" && !p.ticker && !p.isUS && !p.countryCode && !p.listingExchange);
        for (const row of incompleteContracts.slice(0, 20)) {
          try {
            const info = await this.#read(`/iserver/contract/${row.conid}/info`, { signal });
            if (Number(info?.con_id ?? info?.conid) !== Number(row.conid)) continue;
            if (!(Number(row.multiplier) > 0) && Number(info.multiplier) > 0) row.multiplier = info.multiplier;
            row.ticker ??= info.symbol;
            row.listingExchange ??= info.listing_exchange ?? info.exchange;
          } catch (error) { warnings.push(`合约 ${row.conid} 元数据未补全：${error.message}`); }
        }
        const symbols = [...new Set(optionRows.map((p) => String(p.ticker ?? "")).filter((s) => /^[A-Z0-9.-]{1,16}$/.test(s)))];
        for (const symbol of symbols.slice(0, 20)) {
          await this.#read("/iserver/secdef/search", { method: "POST", body: { symbol, name: false }, signal });
        }
        // Quotes only for held contracts. Never download an unbounded chain.
        const ids = positions.map((p) => String(p.conid)).filter((id) => /^\d+$/.test(id));
        for (let i = 0; i < Math.min(ids.length, 200); i += 50) {
          const path = `/iserver/marketdata/snapshot?conids=${ids.slice(i, i + 50).join(",")}&fields=${FIELDS}`;
          const preflight = await this.#read(path, { signal });
          await delay(350, undefined, { signal });
          const response = await this.#read(path, { signal });
          if (!Array.isArray(response)) throw new Error("IBKR 行情响应格式无效。");
          const combined = new Map((Array.isArray(preflight) ? preflight : []).map((q) => [String(q.conid), q]));
          for (const q of response) combined.set(String(q.conid), { ...combined.get(String(q.conid)), ...q });
          quotes.push(...combined.values());
        }
        if (ids.length > 200) warnings.push("本轮仅请求前 200 个持仓的行情补充，全部持仓数量仍完整读取。");
      } catch (error) {
        this.#check(generation);
        warnings.push(`持仓已读取，行情/Greeks 未完整取得：${error.message}`);
      }
      const snapshot = normalizeIbkrPortfolio({ account, summary, ledger, positions, quotes, warnings, now: this.clock() });
      this.#check(generation);
      return this.#publish(snapshot, generation);
    });
  }
  async #publish(snapshot, generation) {
    this.#check(generation);
    await this.store.set(SNAPSHOT_KEY, { configAccountId: this.config.accountId, port: this.config.port, transport: this.config.transport, portfolio: snapshot });
    this.#check(generation);
    this.portfolio = snapshot; this.lastRefresh = this.clock(); this.state = "connected";
    return snapshot;
  }
  async #positions(prefix, signal) {
    const rows = [];
    for (let page = 0; page < 50; page += 1) {
      const result = await this.#read(`${prefix}/positions/${page}`, { signal });
      if (!Array.isArray(result)) throw new Error("IBKR 持仓分页响应无效。");
      rows.push(...result);
      if (result.length < 100) return rows;
    }
    throw new Error("IBKR 持仓分页超过安全上限，未发布不完整账户。");
  }
  async #operation(fn) {
    if (this.running) return this.running;
    const generation = this.generation;
    const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(new Error("IBKR 本轮同步达到 45 秒上限。")), 45_000);
    this.state = "syncing"; this.error = null;
    const work = Promise.resolve().then(() => fn(controller.signal, generation)).catch((error) => {
      if (generation === this.generation) {
        this.error = String(error.message ?? error).slice(0, 500); this.state = "error";
        if (this.portfolio) this.portfolio = withPortfolioFreshness({ ...this.portfolio, status: "stale" }, { forceState: "stale", now: this.clock(), reason: this.error });
      }
      throw error;
    }).finally(() => { clearTimeout(timer); if (this.running === work) this.running = null; this.onUpdate(); });
    this.running = work; this.onUpdate();
    return work;
  }
  #check(generation) { if (generation !== this.generation) throw new Error("IBKR 连接配置已变化，旧请求结果已隔离。"); }
  async #read(path, options) {
    assertIbkrReadOnlyRequest(path, options?.method ?? "GET");
    const slot = this.queue.catch(() => {}).then(async () => {
      options.signal?.throwIfAborted();
      const remaining = this.pacingMs - (Date.now() - this.lastStart);
      if (remaining > 0) await delay(remaining, undefined, { signal: options.signal });
      this.lastStart = Date.now();
    });
    this.queue = slot;
    await slot;
    return this.request({ config: this.config, path, ...options });
  }
}
