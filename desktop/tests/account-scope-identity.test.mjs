import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACCOUNT_SCOPE_CANONICALIZATION_VERSION,
  ACCOUNT_SCOPE_HASH_ALGORITHM,
  ACCOUNT_SCOPE_HASH_DOMAIN,
  ACCOUNT_SCOPE_IDENTITY_VERSION,
  compareBrokerAccountScopeIdentities,
  deriveBrokerAccountScopeIdentity,
  deriveLongbridgeAccountScopeIdentity,
  inspectPersistedAccountScope,
  isOpaqueBrokerAccountScopeId,
  planBrokerAccountScopeActivation,
} from "../src/data/account-scope-identity.mjs";

function identity(overrides = {}) {
  return deriveBrokerAccountScopeIdentity({
    broker: "Longbridge",
    environment: "production",
    accountIdentifiers: [
      { kind: "account_id", value: "LB-00981234" },
      { kind: "oauth_subject", value: "user-abc" },
    ],
    ...overrides,
  });
}

test("derives a deterministic opaque scope with provenance and no raw identifier leakage", () => {
  const first = identity();
  const second = deriveBrokerAccountScopeIdentity({
    broker: " long bridge ",
    environment: "LIVE",
    accountIdentifiers: [
      { kind: "subject", value: " USER-ABC " },
      { kind: "accountId", value: " lb-00981234 " },
      { kind: "account_id", value: "LB-00981234" },
    ],
  });

  assert.equal(first.scopeId, second.scopeId);
  assert.match(first.scopeId, /^broker-scope-v1-[0-9a-f]{64}$/);
  assert.equal(isOpaqueBrokerAccountScopeId(first.scopeId), true);
  assert.equal(first.broker, "longbridge");
  assert.equal(first.environment, "production");
  assert.deepEqual(first.identifierKinds, ["account_id", "oauth_subject"]);
  assert.equal(first.identifierCount, 2);
  assert.equal(first.version, ACCOUNT_SCOPE_IDENTITY_VERSION);
  assert.deepEqual(first.provenance, {
    source: "explicit_broker_account_identifiers",
    derivation: "domain_separated_sha256",
    domain: ACCOUNT_SCOPE_HASH_DOMAIN,
    algorithm: ACCOUNT_SCOPE_HASH_ALGORITHM,
    version: ACCOUNT_SCOPE_IDENTITY_VERSION,
    canonicalizationVersion: ACCOUNT_SCOPE_CANONICALIZATION_VERSION,
    rawIdentifiersPersisted: false,
    mutablePortfolioContentUsed: false,
  });
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /LB-00981234/i);
  assert.doesNotMatch(serialized, /USER-ABC/i);
});

test("scope changes for a different account, broker, or environment", () => {
  const base = identity();
  const accountChanged = identity({
    accountIdentifiers: [{ kind: "account_id", value: "LB-OTHER" }],
  });
  const environmentChanged = identity({ environment: "paper" });
  const brokerChanged = identity({ broker: "another-broker" });

  assert.notEqual(base.scopeId, accountChanged.scopeId);
  assert.notEqual(base.scopeId, environmentChanged.scopeId);
  assert.notEqual(base.scopeId, brokerChanged.scopeId);
  assert.equal(compareBrokerAccountScopeIdentities(base, accountChanged).status, "account_changed");
  assert.deepEqual(
    compareBrokerAccountScopeIdentities(base, environmentChanged),
    {
      status: "broker_environment_changed",
      accountChanged: false,
      brokerChanged: false,
      environmentChanged: true,
      allowAppendToPreviousScope: false,
      previousScopeId: base.scopeId,
      nextScopeId: environmentChanged.scopeId,
      requiredAction: "isolate_previous_scope_and_activate_new_scope",
    },
  );
});

test("same verified identity is stable and permits appending only to the same scope", () => {
  const first = identity();
  const second = identity();
  assert.deepEqual(compareBrokerAccountScopeIdentities(first, second), {
    status: "stable",
    accountChanged: false,
    brokerChanged: false,
    environmentChanged: false,
    allowAppendToPreviousScope: true,
  });
});

test("fails closed when broker, environment, or explicit account identifiers are missing", () => {
  assert.throws(() => deriveBrokerAccountScopeIdentity({
    broker: "",
    environment: "production",
    accountIdentifiers: [{ kind: "account_id", value: "A-1" }],
  }), /券商标识/);
  assert.throws(() => deriveBrokerAccountScopeIdentity({
    broker: "Longbridge",
    environment: "unknown",
    accountIdentifiers: [{ kind: "account_id", value: "A-1" }],
  }), /券商环境/);
  assert.throws(() => deriveBrokerAccountScopeIdentity({
    broker: "Longbridge",
    environment: "production",
    accountIdentifiers: [],
  }), /拒绝回退到 aggregate/);
  assert.throws(() => deriveBrokerAccountScopeIdentity({
    broker: "Longbridge",
    environment: "production",
    accountIdentifiers: [{ kind: "account_id", value: "aggregate" }],
  }), /拒绝回退到 aggregate/);
});

test("rejects portfolio content and unsupported identifiers as identity evidence", () => {
  assert.throws(() => deriveBrokerAccountScopeIdentity({
    broker: "Longbridge",
    environment: "production",
    accountIdentifiers: [{ kind: "account_id", value: "A-1" }],
    positions: [{ symbol: "AAPL.US", quantity: 10 }],
  }), /禁止使用持仓/);
  assert.throws(() => deriveBrokerAccountScopeIdentity({
    broker: "Longbridge",
    environment: "production",
    accountIdentifiers: [{ kind: "symbol", value: "AAPL.US" }],
  }), /不受支持/);
  assert.throws(() => deriveBrokerAccountScopeIdentity({
    broker: "Longbridge",
    environment: "production",
    accountIdentifiers: [{ kind: "account_id", value: "A-1", holdings: [] }],
  }), /禁止包含持仓/);
});

test("marks legacy aggregate and anonymous local scopes for isolation instead of reuse", () => {
  assert.deepEqual(inspectPersistedAccountScope({
    scopeId: "longbridge-primary-usd-v1",
    accounts: [{ accountRef: "aggregate", accountType: "aggregate_read_only" }],
  }), {
    status: "legacy_aggregate",
    scopeId: "longbridge-primary-usd-v1",
    verified: false,
    usableForNewWrites: false,
    requiresMigration: true,
    requiresIsolation: true,
    requiredAction: "isolate_legacy_history_then_initialize_verified_scope",
    version: null,
  });

  const anonymous = inspectPersistedAccountScope(
    "lb-ledger-11111111-2222-4333-8444-555555555555",
  );
  assert.equal(anonymous.status, "anonymous_local_scope");
  assert.equal(anonymous.usableForNewWrites, false);
  assert.equal(anonymous.requiresMigration, true);
  assert.equal(anonymous.requiresIsolation, true);
});

test("does not trust an opaque-looking scope id without matching provenance", () => {
  const derived = identity();
  const inspection = inspectPersistedAccountScope(derived.scopeId);
  assert.equal(inspection.status, "opaque_scope_missing_provenance");
  assert.equal(inspection.verified, false);
  assert.equal(inspection.usableForNewWrites, false);

  const verified = inspectPersistedAccountScope(derived);
  assert.equal(verified.status, "verified_opaque_scope");
  assert.equal(verified.verified, true);
  assert.equal(verified.usableForNewWrites, true);
});

test("activation planning isolates legacy history and detects account switching", () => {
  const current = identity();
  const migration = planBrokerAccountScopeActivation({
    persistedScope: {
      scopeId: "longbridge-primary-usd-v1",
      accounts: [{ accountRef: "aggregate", accountType: "aggregate_read_only" }],
    },
    candidateIdentity: current,
  });
  assert.deepEqual(migration, {
    status: "migration_required",
    previousScopeId: "longbridge-primary-usd-v1",
    nextScopeId: current.scopeId,
    allowAppendToPersistedScope: false,
    requiresIsolation: true,
    requiredAction: "isolate_legacy_history_then_initialize_verified_scope",
    reason: "legacy_aggregate",
  });

  assert.deepEqual(planBrokerAccountScopeActivation({
    persistedScope: current,
    candidateIdentity: identity(),
  }), {
    status: "reuse",
    nextScopeId: current.scopeId,
    allowAppendToPersistedScope: true,
    requiresIsolation: false,
  });

  const switched = identity({
    accountIdentifiers: [{ kind: "account_number", value: "SECOND-ACCOUNT" }],
  });
  const switchPlan = planBrokerAccountScopeActivation({
    persistedScope: current,
    candidateIdentity: switched,
  });
  assert.equal(switchPlan.status, "account_switch_detected");
  assert.equal(switchPlan.previousScopeId, current.scopeId);
  assert.equal(switchPlan.nextScopeId, switched.scopeId);
  assert.equal(switchPlan.allowAppendToPersistedScope, false);
  assert.equal(switchPlan.requiresIsolation, true);
});

test("activation planning initializes a verified scope when there is no prior scope", () => {
  const candidate = identity();
  assert.deepEqual(planBrokerAccountScopeActivation({ candidateIdentity: candidate }), {
    status: "initialize",
    nextScopeId: candidate.scopeId,
    allowAppendToPersistedScope: false,
    requiresIsolation: false,
  });
});

test("derives directly from explicit raw Longbridge account fields before aggregation", () => {
  const derived = deriveLongbridgeAccountScopeIdentity({
    positionsPayload: {
      list: [{
        account_channel: "margin",
        account_id: "LB-REAL-1",
        stock_info: [{ symbol: "AAPL.US", quantity: "10" }],
      }],
    },
    balancePayload: [{ accountId: "LB-REAL-1", currency: "USD", net_assets: "999" }],
  });
  assert.equal(derived.status, "verified");
  assert.deepEqual(derived.identifierKinds, ["account_id"]);
  assert.equal(derived.identifierCount, 1);
  assert.doesNotMatch(JSON.stringify(derived), /LB-REAL-1/);
});

test("raw Longbridge derivation ignores channel, holdings, balances and currencies", () => {
  assert.throws(() => deriveLongbridgeAccountScopeIdentity({
    positionsPayload: {
      list: [{
        account_channel: "margin",
        stock_info: [{ symbol: "AAPL.US", quantity: "10" }],
      }],
    },
    balancePayload: [{ currency: "USD", net_assets: "999" }],
  }), /拒绝回退到 aggregate/);
});
