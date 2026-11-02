import { createHash } from "node:crypto";

/**
 * Broker account scope identity
 *
 * The scope is derived only from explicit broker/account-subject evidence. It
 * deliberately cannot be derived from holdings, balances, currencies or any
 * other mutable portfolio content. Raw account identifiers are used only as
 * in-memory hash input and are never returned by this module.
 */

export const ACCOUNT_SCOPE_IDENTITY_VERSION = "account-scope-identity/v1";
export const ACCOUNT_SCOPE_HASH_DOMAIN = "com.gawei.trading-cockpit/account-scope/v1";
export const ACCOUNT_SCOPE_HASH_ALGORITHM = "sha256";
export const ACCOUNT_SCOPE_CANONICALIZATION_VERSION = "nfkc-trim-upper-sort-dedupe/v1";

const SCOPE_ID_PREFIX = "broker-scope-v1-";
const SCOPE_ID_PATTERN = /^broker-scope-v1-[0-9a-f]{64}$/;
const LOCAL_ANONYMOUS_SCOPE_PATTERN = /^lb-ledger-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_AGGREGATE_SCOPE_IDS = new Set([
  "aggregate",
  "longbridge-primary-usd-v1",
]);
const LEGACY_AGGREGATE_ACCOUNT_REFS = new Set(["aggregate"]);

const BROKER_ALIASES = new Map([
  ["longbridge", "longbridge"],
  ["long bridge", "longbridge"],
  ["longbridge securities", "longbridge"],
]);

const ENVIRONMENT_ALIASES = new Map([
  ["production", "production"],
  ["prod", "production"],
  ["live", "production"],
  ["real", "production"],
  ["paper", "paper"],
  ["paper trading", "paper"],
  ["simulation", "paper"],
  ["simulated", "paper"],
  ["sandbox", "sandbox"],
  ["test", "sandbox"],
  ["testing", "sandbox"],
]);

const IDENTIFIER_KIND_ALIASES = new Map([
  ["account_id", "account_id"],
  ["accountid", "account_id"],
  ["account_number", "account_number"],
  ["accountnumber", "account_number"],
  ["account_no", "account_number"],
  ["accountno", "account_number"],
  ["broker_account_id", "broker_account_id"],
  ["brokeraccountid", "broker_account_id"],
  ["brokerage_account_id", "broker_account_id"],
  ["securities_account_id", "securities_account_id"],
  ["securitiesaccountid", "securities_account_id"],
  ["portfolio_id", "portfolio_id"],
  ["portfolioid", "portfolio_id"],
  ["member_id", "member_id"],
  ["memberid", "member_id"],
  ["user_id", "user_id"],
  ["userid", "user_id"],
  ["oauth_subject", "oauth_subject"],
  ["oauthsubject", "oauth_subject"],
  ["subject", "oauth_subject"],
]);

const PLACEHOLDER_IDENTIFIERS = new Set([
  "AGGREGATE",
  "DEFAULT",
  "PRIMARY",
  "UNKNOWN",
  "UNAVAILABLE",
  "NONE",
  "NULL",
  "N/A",
  "NA",
]);

const ALLOWED_DERIVATION_INPUT_KEYS = new Set([
  "broker",
  "environment",
  "accountIdentifiers",
]);

const MUTABLE_PORTFOLIO_KEYS = /(?:holding|position|symbol|ticker|balance|cash|asset|currency|order|execution|trade|quantity|market.?value|cost)/i;

/**
 * Derive a stable opaque scope from explicit, immutable account identity.
 *
 * @param {{
 *   broker: string,
 *   environment: string,
 *   accountIdentifiers: Array<{kind: string, value: string|number}>
 * }} input
 */
export function deriveBrokerAccountScopeIdentity(input) {
  assertStrictDerivationInput(input);
  const broker = normalizeBroker(input.broker);
  const environment = normalizeEnvironment(input.environment);
  const identifiers = normalizeAccountIdentifiers(input.accountIdentifiers);
  const canonicalPayload = {
    version: ACCOUNT_SCOPE_IDENTITY_VERSION,
    broker,
    environment,
    identifiers,
  };
  const digest = domainSeparatedSha256(canonicalPayload);
  const scopeId = `${SCOPE_ID_PREFIX}${digest}`;
  const identifierKinds = [...new Set(identifiers.map((item) => item.kind))];

  return Object.freeze({
    status: "verified",
    scopeId,
    broker,
    environment,
    identifierKinds: Object.freeze(identifierKinds),
    identifierCount: identifiers.length,
    version: ACCOUNT_SCOPE_IDENTITY_VERSION,
    provenance: Object.freeze({
      source: "explicit_broker_account_identifiers",
      derivation: "domain_separated_sha256",
      domain: ACCOUNT_SCOPE_HASH_DOMAIN,
      algorithm: ACCOUNT_SCOPE_HASH_ALGORITHM,
      version: ACCOUNT_SCOPE_IDENTITY_VERSION,
      canonicalizationVersion: ACCOUNT_SCOPE_CANONICALIZATION_VERSION,
      rawIdentifiersPersisted: false,
      mutablePortfolioContentUsed: false,
    }),
  });
}

/**
 * Compare two derived identities without accepting a bare scope id as proof.
 */
export function compareBrokerAccountScopeIdentities(previous, current) {
  assertDerivedIdentity(previous, "旧账户范围身份无效。");
  assertDerivedIdentity(current, "新账户范围身份无效。");
  if (previous.scopeId === current.scopeId) {
    return {
      status: "stable",
      accountChanged: false,
      brokerChanged: false,
      environmentChanged: false,
      allowAppendToPreviousScope: true,
    };
  }
  const brokerChanged = previous.broker !== current.broker;
  const environmentChanged = previous.environment !== current.environment;
  return {
    status: brokerChanged || environmentChanged ? "broker_environment_changed" : "account_changed",
    accountChanged: !brokerChanged && !environmentChanged,
    brokerChanged,
    environmentChanged,
    allowAppendToPreviousScope: false,
    previousScopeId: previous.scopeId,
    nextScopeId: current.scopeId,
    requiredAction: "isolate_previous_scope_and_activate_new_scope",
  };
}

/**
 * Inspect persisted scope metadata. Legacy aggregate and anonymous local scopes
 * are evidence partitions, not verified broker-account identities.
 */
export function inspectPersistedAccountScope(value) {
  const source = typeof value === "string" ? { scopeId: value } : value;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return unverifiedInspection("missing", null, "initialize_verified_scope");
  }
  const scopeId = cleanText(source.scopeId);
  const accounts = Array.isArray(source.accounts) ? source.accounts : [];
  const hasAggregateAccount = accounts.some((account) => (
    LEGACY_AGGREGATE_ACCOUNT_REFS.has(cleanText(account?.accountRef)?.toLowerCase())
    || cleanText(account?.accountType)?.toLowerCase() === "aggregate_read_only"
  ));
  if (LEGACY_AGGREGATE_SCOPE_IDS.has(scopeId?.toLowerCase()) || hasAggregateAccount) {
    return unverifiedInspection(
      "legacy_aggregate",
      scopeId,
      "isolate_legacy_history_then_initialize_verified_scope",
    );
  }
  if (LOCAL_ANONYMOUS_SCOPE_PATTERN.test(scopeId ?? "")) {
    return unverifiedInspection(
      "anonymous_local_scope",
      scopeId,
      "isolate_anonymous_history_then_initialize_verified_scope",
    );
  }
  if (isDerivedIdentity(source)) {
    return {
      status: "verified_opaque_scope",
      scopeId,
      verified: true,
      usableForNewWrites: true,
      requiresMigration: false,
      requiresIsolation: false,
      version: ACCOUNT_SCOPE_IDENTITY_VERSION,
    };
  }
  if (SCOPE_ID_PATTERN.test(scopeId ?? "")) {
    return unverifiedInspection(
      "opaque_scope_missing_provenance",
      scopeId,
      "recover_verified_provenance_or_isolate_scope",
    );
  }
  return unverifiedInspection(
    scopeId ? "unknown_unverified_scope" : "missing",
    scopeId,
    scopeId ? "isolate_unknown_scope_then_initialize_verified_scope" : "initialize_verified_scope",
  );
}

/**
 * Produce a fail-closed activation decision for startup integration.
 */
export function planBrokerAccountScopeActivation({ persistedScope = null, candidateIdentity }) {
  assertDerivedIdentity(candidateIdentity, "候选账户范围身份无效。");
  const persisted = inspectPersistedAccountScope(persistedScope);
  if (persisted.status === "missing") {
    return {
      status: "initialize",
      nextScopeId: candidateIdentity.scopeId,
      allowAppendToPersistedScope: false,
      requiresIsolation: false,
    };
  }
  if (!persisted.verified) {
    return {
      status: "migration_required",
      previousScopeId: persisted.scopeId,
      nextScopeId: candidateIdentity.scopeId,
      allowAppendToPersistedScope: false,
      requiresIsolation: true,
      requiredAction: persisted.requiredAction,
      reason: persisted.status,
    };
  }
  const comparison = compareBrokerAccountScopeIdentities(persistedScope, candidateIdentity);
  if (comparison.status === "stable") {
    return {
      status: "reuse",
      nextScopeId: candidateIdentity.scopeId,
      allowAppendToPersistedScope: true,
      requiresIsolation: false,
    };
  }
  return {
    status: "account_switch_detected",
    previousScopeId: persisted.scopeId,
    nextScopeId: candidateIdentity.scopeId,
    allowAppendToPersistedScope: false,
    requiresIsolation: true,
    requiredAction: comparison.requiredAction,
    comparison,
  };
}

export function isOpaqueBrokerAccountScopeId(value) {
  return SCOPE_ID_PATTERN.test(String(value ?? "").trim());
}

/**
 * Derive a Longbridge scope only when the raw, pre-aggregation MCP payloads
 * expose an explicit account subject. Account channels (cash/margin),
 * currencies and mutable portfolio values are deliberately ignored.
 *
 * Raw identifiers remain inside this call and are not returned.
 */
export function deriveLongbridgeAccountScopeIdentity({
  positionsPayload = null,
  balancePayload = null,
  oauthSubject = null,
  environment = "production",
} = {}) {
  const identifiers = [
    ...explicitAccountIdentifiers(positionsPayload),
    ...explicitAccountIdentifiers(balancePayload),
  ];
  if (oauthSubject != null && String(oauthSubject).trim()) {
    identifiers.push({ kind: "oauth_subject", value: oauthSubject });
  }
  return deriveBrokerAccountScopeIdentity({
    broker: "Longbridge",
    environment,
    accountIdentifiers: identifiers,
  });
}

function explicitAccountIdentifiers(payload) {
  const rows = explicitIdentityRows(payload);
  const aliases = [
    ["account_id", "account_id"],
    ["accountId", "account_id"],
    ["account_no", "account_number"],
    ["accountNo", "account_number"],
    ["account_number", "account_number"],
    ["accountNumber", "account_number"],
    ["broker_account_id", "broker_account_id"],
    ["brokerAccountId", "broker_account_id"],
    ["securities_account_id", "securities_account_id"],
    ["securitiesAccountId", "securities_account_id"],
    ["member_id", "member_id"],
    ["memberId", "member_id"],
    ["user_id", "user_id"],
    ["userId", "user_id"],
  ];
  const result = [];
  for (const row of rows) {
    for (const [field, kind] of aliases) {
      const value = row?.[field];
      if (value != null && String(value).trim()) result.push({ kind, value });
    }
  }
  return result;
}

function explicitIdentityRows(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return Array.isArray(payload)
      ? payload.filter((item) => item && typeof item === "object" && !Array.isArray(item)).slice(0, 100)
      : [];
  }
  const rows = [payload];
  for (const field of ["list", "balances", "accounts", "account_list"]) {
    if (Array.isArray(payload[field])) rows.push(...payload[field].slice(0, 100));
  }
  // stock_positions commonly groups rows by account channel. The group object
  // may carry an account id; individual stock_info rows are mutable holdings
  // and must never become identity input.
  if (Array.isArray(payload.list)) {
    rows.push(...payload.list.filter((item) => item && typeof item === "object").slice(0, 100));
  }
  return rows.filter((item) => item && typeof item === "object" && !Array.isArray(item)).slice(0, 200);
}

function assertStrictDerivationInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("账户范围派生输入必须是对象。");
  }
  for (const key of Object.keys(input)) {
    if (MUTABLE_PORTFOLIO_KEYS.test(key)) {
      throw new Error("账户范围禁止使用持仓、余额、订单或其他可变组合内容派生。");
    }
    if (!ALLOWED_DERIVATION_INPUT_KEYS.has(key)) {
      throw new Error("账户范围派生输入包含未授权字段。");
    }
  }
}

function normalizeBroker(value) {
  const normalized = cleanText(value)?.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
  if (!normalized) throw new Error("账户范围缺少明确券商标识。");
  const broker = BROKER_ALIASES.get(normalized) ?? normalized.replace(/[^a-z0-9._-]+/g, "-");
  if (!broker || broker.length > 80 || ["unknown", "default", "broker"].includes(broker)) {
    throw new Error("账户范围券商标识无效。");
  }
  return broker;
}

function normalizeEnvironment(value) {
  const normalized = cleanText(value)?.normalize("NFKC").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  const environment = ENVIRONMENT_ALIASES.get(normalized);
  if (!environment) throw new Error("账户范围缺少明确且受支持的券商环境。");
  return environment;
}

function normalizeAccountIdentifiers(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("账户范围缺少明确账户标识；已拒绝回退到 aggregate。");
  }
  if (value.length > 32) throw new Error("账户范围包含过多账户标识。");
  const identifiers = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("账户标识格式无效。");
    }
    const itemKeys = Object.keys(item);
    if (itemKeys.some((key) => MUTABLE_PORTFOLIO_KEYS.test(key))) {
      throw new Error("账户标识禁止包含持仓或其他可变组合内容。");
    }
    if (itemKeys.some((key) => !["kind", "value"].includes(key))) {
      throw new Error("账户标识包含未授权字段。");
    }
    const kindKey = cleanText(item.kind)?.normalize("NFKC").toLowerCase().replace(/[\s.-]+/g, "_");
    const kind = IDENTIFIER_KIND_ALIASES.get(kindKey);
    if (!kind) throw new Error("账户标识类型不受支持。");
    const identifier = normalizeIdentifierValue(item.value);
    return { kind, value: identifier };
  });
  identifiers.sort((left, right) => (
    left.kind.localeCompare(right.kind) || left.value.localeCompare(right.value)
  ));
  const unique = identifiers.filter((item, index) => (
    index === 0
    || item.kind !== identifiers[index - 1].kind
    || item.value !== identifiers[index - 1].value
  ));
  if (!unique.length) throw new Error("账户范围缺少可用账户标识。");
  return unique;
}

function normalizeIdentifierValue(value) {
  if (value == null || typeof value === "object" || typeof value === "boolean") {
    throw new Error("账户标识值无效。");
  }
  const normalized = String(value).normalize("NFKC").trim().toUpperCase();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("账户标识值无效。");
  }
  if (PLACEHOLDER_IDENTIFIERS.has(normalized)) {
    throw new Error("账户标识是占位值；已拒绝回退到 aggregate。");
  }
  return normalized;
}

function domainSeparatedSha256(payload) {
  const canonical = JSON.stringify(payload);
  return createHash(ACCOUNT_SCOPE_HASH_ALGORITHM)
    .update(`${ACCOUNT_SCOPE_HASH_DOMAIN}\0${canonical}`, "utf8")
    .digest("hex");
}

function assertDerivedIdentity(value, message) {
  if (!isDerivedIdentity(value)) throw new Error(message);
}

function isDerivedIdentity(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.status === "verified"
    && SCOPE_ID_PATTERN.test(String(value.scopeId ?? ""))
    && typeof value.broker === "string"
    && typeof value.environment === "string"
    && value.version === ACCOUNT_SCOPE_IDENTITY_VERSION
    && value.provenance?.domain === ACCOUNT_SCOPE_HASH_DOMAIN
    && value.provenance?.algorithm === ACCOUNT_SCOPE_HASH_ALGORITHM
    && value.provenance?.version === ACCOUNT_SCOPE_IDENTITY_VERSION
    && value.provenance?.rawIdentifiersPersisted === false
    && value.provenance?.mutablePortfolioContentUsed === false
  );
}

function unverifiedInspection(status, scopeId, requiredAction) {
  return {
    status,
    scopeId,
    verified: false,
    usableForNewWrites: false,
    requiresMigration: status !== "missing",
    requiresIsolation: status !== "missing",
    requiredAction,
    version: null,
  };
}

function cleanText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}
