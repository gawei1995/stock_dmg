// A transaction-capability boundary, not a general shell/network sandbox.
export const BROKERAGE_WRITE_TOOLS = new Set([
  "submit_order", "replace_order", "cancel_order", "place_order", "send_order", "execute_order",
  "transmit_order", "modify_order", "amend_order", "update_order", "withdraw_order",
  "cancel_all_orders", "cancel_open_orders", "close_position", "close_all_positions", "liquidate_position",
  "exercise_option", "exercise_options", "exerciseOptions", "placeOrder", "cancelOrder", "reqGlobalCancel",
  "global_cancel", "transfer_funds", "transfer_cash", "transfer_securities", "transfer_positions",
  "withdraw_funds", "withdraw_cash", "create_transfer", "submit_transfer", "initiate_transfer", "wire_transfer",
  "dca_create", "dca_pause", "dca_resume", "dca_update", "dca_modify", "dca_cancel", "dca_delete",
  "dca_enable", "dca_disable", "create_dca", "modify_dca", "update_dca", "cancel_dca", "delete_dca",
  "create_order_instruction", "delete_order_instruction",
]);

export function canonicalBrokerIdentifier(value) {
  return String(value ?? "").replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "_").replace(/^_+|_+$/g, "");
}

const EXACT_WRITES = new Set([...BROKERAGE_WRITE_TOOLS].map(canonicalBrokerIdentifier));
const WRITE_VERBS = new Set(["submit", "place", "send", "execute", "transmit", "replace", "modify", "amend",
  "update", "withdraw", "cancel", "close", "liquidate", "exercise", "create", "delete", "pause", "resume",
  "enable", "disable", "buy", "sell", "transfer", "initiate"]);
const TRADE_OBJECTS = new Set(["order", "orders", "position", "positions", "option", "options", "dca",
  "stock", "stocks", "equity", "equities", "share", "shares", "trade", "trades", "funds", "cash", "securities", "wire"]);
const READ_PREFIX = /^(?:get|list|query|read|fetch|search|lookup|req|request|preview|estimate|calculate)_/;
const READ_NAMES = new Set(["quote", "quotes", "portfolio", "positions", "account_summary", "account_balance",
  "stock_positions", "option_chain", "option_quote", "market_data", "candlesticks", "history_orders",
  "history_executions", "today_orders", "today_executions", "order_detail", "contract_details", "exchange_rate", "finance_calendar"]);

export function isBrokerageServer(server = {}) {
  const identity = canonicalBrokerIdentifier([server.name, server.title, server.url, server.websiteUrl,
    server.command, ...(Array.isArray(server.args) ? server.args : [])].filter(Boolean).join(" "));
  return /(?:^|_)(?:ibkr|interactive_?brokers?|longbridge|long_bridge|broker|brokerage|alpaca|tradier|futu|moomoo|schwab|tiger)(?:_|$)/.test(identity)
    || /长桥|盈透|券商/.test(identity);
}

export function classifyBrokerageTool(server, tool = {}) {
  // Codex Apps exposes names such as interactive_brokers_ibkr.get_positions.
  // The namespace is identity, not a verb: classify the actual operation so
  // read queries containing words like "cancel" remain queries.
  const qualifiedName = String(tool.name ?? "").split(".");
  const name = canonicalBrokerIdentifier(qualifiedName.at(-1));
  const tokens = new Set(name.split("_"));
  const broker = isBrokerageServer(server) || qualifiedName.length > 1
    && isBrokerageServer({ name: qualifiedName.slice(0, -1).join(".") });
  if (EXACT_WRITES.has(name)) return "transaction_write";
  const declaredWrite = tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true;
  const readName = READ_NAMES.has(name) || READ_PREFIX.test(name);
  // A read-only annotation can never override a write name. Conversely,
  // get_order_cancel_status is a query, not a cancellation operation.
  if (readName && !declaredWrite) return "query";
  if ([...tokens].some((token) => WRITE_VERBS.has(token))
    && [...tokens].some((token) => TRADE_OBJECTS.has(token))) return "transaction_write";
  const description = String(tool.description ?? "").toLowerCase();
  if (/\b(?:submit|place|modify|cancel|execute|transmit)\b.{0,50}\b(?:trading|brokerage|stock|option|market|limit)?\s*orders?\b/.test(description)
    || /\b(?:transfer|withdraw)\b.{0,35}\b(?:funds|cash|money|securities|positions)\b/.test(description)
    || /\bexercise\b.{0,30}\boptions?\b/.test(description)) return "transaction_write";
  const fields = Object.keys(tool.inputSchema?.properties ?? {}).map(canonicalBrokerIdentifier);
  const tradingPayload = fields.some((field) => ["order", "orders", "order_id", "conid", "side", "order_type", "funds", "transfer_amount"].includes(field));
  if (declaredWrite && (broker || tradingPayload)) return "unverified_transaction_capability";
  if (readName) return "query";
  return broker ? "unverified_broker_capability" : "research";
}

/** Resolve only discovered, unambiguous App identities. These are deny-only
 * session overrides, never a persisted user config or evidence of enforcement.
 * The caller must apply them and re-read the server inventory before allowing
 * a turn. Unknown/ambiguous mappings deliberately remain unhandled. */
export function discoveredBrokerAppToolOverrides({ servers = [], apps = [] } = {}) {
  const overrides = {}, bindings = [], unresolved = [];
  for (const server of servers) {
    if (server.name !== "codex_apps") continue;
    for (const tool of server.tools ?? []) {
      if (!["transaction_write", "unverified_transaction_capability", "unverified_broker_capability"]
        .includes(classifyBrokerageTool(server, tool))) continue;
      const match = /^([a-z0-9_]+)\.([A-Za-z0-9_/-]+)$/.exec(String(tool.name ?? ""));
      const candidates = match ? [...new Map(apps.filter(app => typeof app.id === "string" && app.id
        && !["__proto__", "constructor", "prototype"].includes(app.id)
        && canonicalBrokerIdentifier(app.name) === match[1]).map(app => [app.id, app])).values()] : [];
      if (candidates.length !== 1) {
        unresolved.push({ server: server.name, tool: tool.name, reason: candidates.length ? "ambiguous_app_identity" : "app_identity_unavailable" });
        continue;
      }
      const appId = candidates[0].id;
      overrides[appId] ??= { tools: {} };
      // Preserve the literal dotted inventory key. Also deny the operation key
      // used by per-App catalogs; both are scoped to this exact discovered App.
      for (const key of [tool.name, match[2]]) overrides[appId].tools[key] = { enabled: false };
      bindings.push({ server: server.name, tool: tool.name, appId, operation: match[2] });
    }
  }
  return { overrides, bindings, unresolved };
}

export function isBrokerageWriteApproval(value = {}) {
  const toolName = value.tool ?? value.toolName ?? value.name;
  const server = { name: value.server ?? value.serverName ?? "", url: value.url ?? "" };
  if (toolName && ["transaction_write", "unverified_transaction_capability"]
    .includes(classifyBrokerageTool(server, { name: toolName, inputSchema: value.inputSchema, annotations: value.annotations }))) return true;
  let raw;
  try { raw = JSON.stringify(value); } catch { return false; }
  const command = Array.isArray(value.command) ? value.command.join(" ") : String(value.command ?? raw);
  // Preserve ordinary source inspection. Compound shell commands are not
  // covered by this exemption and still pass through the transaction checks.
  if (/^(?:rg|grep|cat|head|tail|sed)\s/.test(command) && !/[;&|`\n]/.test(command)) return false;
  const methodCall = /\b([a-zA-Z][\w]*)\s*\(/g;
  for (const match of command.matchAll(methodCall)) {
    if (classifyBrokerageTool(server, { name: match[1] }) === "transaction_write") return true;
  }
  if (/\b(?:POST|PUT|PATCH|DELETE)\b/i.test(command)
    && /\/(?:iserver\/account\/[^\s/]+\/)?(?:orders?|transfers?|withdrawals?)(?:[/?\s'"\\]|$)/i.test(command)) return true;
  const brokerMentioned = isBrokerageServer({ name: raw });
  return brokerMentioned && /\b(?:submit|place|replace|modify|amend|cancel|withdraw|close|liquidate|exercise|transfer)[_ -]?(?:an?[_ -]?)?(?:orders?|positions?|options?|funds|cash|securities)\b/i.test(command);
}
