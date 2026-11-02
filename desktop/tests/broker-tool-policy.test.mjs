import assert from "node:assert/strict";
import test from "node:test";
import { classifyBrokerageTool, discoveredBrokerAppToolOverrides, isBrokerageServer, isBrokerageWriteApproval } from "../src/engine/broker-tool-policy.mjs";

test("broker identity recognizes IBKR and broker URLs without treating ordinary research as a broker", () => {
  assert.equal(isBrokerageServer({ name: "ibkr" }), true);
  assert.equal(isBrokerageServer({ name: "account-data", url: "https://api.interactivebrokers.com/v1" }), true);
  assert.equal(isBrokerageServer({ name: "market", url: "https://research.example.com" }), false);
});

test("IBKR and unknown servers cannot relabel transaction names as read-only", () => {
  for (const server of [{ name: "ibkr" }, { name: "unknown-venue" }]) {
    for (const name of ["submit_order", "placeOrder", "modify_order", "cancel_order", "exerciseOptions",
      "transfer_funds", "transfer_securities", "place_bracket_order", "buy_stock", "sell_option"]) {
      assert.equal(classifyBrokerageTool(server, { name, annotations: { readOnlyHint: true, destructiveHint: false } }),
        "transaction_write", `${server.name}/${name}`);
    }
  }
});

test("opaque transaction capabilities are detected by description or financial payload metadata", () => {
  assert.equal(classifyBrokerageTool({ name: "unknown" }, { name: "action", description: "Submit trading orders to the exchange" }), "transaction_write");
  assert.equal(classifyBrokerageTool({ name: "unknown" }, { name: "action", description: "Transfer funds between accounts" }), "transaction_write");
  assert.equal(classifyBrokerageTool({ name: "unknown" }, { name: "action", annotations: { readOnlyHint: false }, inputSchema: { properties: { orderId: {}, side: {} } } }), "unverified_transaction_capability");
  assert.equal(classifyBrokerageTool({ name: "ibkr" }, { name: "opaque_action" }), "unverified_broker_capability");
});

test("position/option research and task cancellation remain available", () => {
  for (const name of ["reqPositions", "get_option_chain", "get_order_cancel_status", "quote", "account_summary"])
    assert.equal(classifyBrokerageTool({ name: "ibkr" }, { name }), "query", name);
  for (const name of ["cancel_task", "create_note", "transfer_file", "search_web"])
    assert.ok(["research", "query"].includes(classifyBrokerageTool({ name: "research" }, { name })), name);
});

test("explicit brokerage approvals deny transaction calls and fund transfer endpoints", () => {
  for (const request of [
    { server: "ibkr", tool: "placeOrder" },
    { server: "unknown", tool: "transfer_funds" },
    { command: ["python", "-c", "ib.placeOrder(contract, order)"] },
    { command: ["python", "-c", "api.exerciseOptions(contract)"] },
    { command: "curl -X POST https://api.unknown.example/v1/orders" },
    { command: "curl -X POST https://localhost/iserver/account/U123/transfer" },
  ]) assert.equal(isBrokerageWriteApproval(request), true, JSON.stringify(request));
});

test("ordinary research commands and source inspection do not become transaction approvals", () => {
  for (const request of [
    { command: ["python", "research.py"] },
    { command: "rg place_order src" },
    { command: "cat docs/ibkr-place_order.md" },
    { command: ["python", "-c", "client.get_order_cancel_status(order_id)"] },
    { server: "tasks", tool: "cancel_task" },
    { permissions: { fileSystem: { write: ["/tmp/research"] } } },
  ]) assert.equal(isBrokerageWriteApproval(request), false, JSON.stringify(request));
});

test("shared App dotted order instructions require exact discovered App identity and deny both key forms", () => {
  const names = ["interactive_brokers_ibkr.create_order_instruction", "interactive_brokers_ibkr.delete_order_instruction"];
  const servers = [{ name: "codex_apps", tools: names.map(name => ({ name,
    description: "Manage an order instruction, not a live order", annotations: { destructiveHint: false, readOnlyHint: false } })) }];
  const apps = [{ id: "asdk_app_fixture_ibkr", name: "Interactive Brokers (IBKR)" }];
  const result = discoveredBrokerAppToolOverrides({ servers, apps });
  assert.equal(result.bindings.length, 2);
  assert.equal(discoveredBrokerAppToolOverrides({ servers, apps: [...apps, { ...apps[0], name: "interactive_brokers_ibkr" }] }).bindings.length, 2);
  assert.deepEqual(result.unresolved, []);
  for (const name of names) {
    assert.equal(result.overrides.asdk_app_fixture_ibkr.tools[name].enabled, false);
    assert.equal(result.overrides.asdk_app_fixture_ibkr.tools[name.split(".").at(-1)].enabled, false);
  }
  for (const unknownApps of [[], [{ id: "other", name: "Unrelated broker" }], [...apps, { ...apps[0], id: "second" }]]) {
    const unknown = discoveredBrokerAppToolOverrides({ servers, apps: unknownApps });
    assert.deepEqual(unknown.overrides, {});
    assert.equal(unknown.unresolved.length, 2);
  }
});

test("dotted App operation classification preserves query tools and ordinary task cancellation", () => {
  for (const name of ["interactive_brokers_ibkr.get_positions", "interactive_brokers_ibkr.get_order_cancel_status"])
    assert.equal(classifyBrokerageTool({ name: "codex_apps" }, { name }), "query");
  assert.equal(classifyBrokerageTool({ name: "codex_apps" }, { name: "tasks.cancel_task" }), "research");
  assert.equal(classifyBrokerageTool({ name: "codex_apps" }, { name: "interactive_brokers_ibkr.dispatch" }), "unverified_broker_capability");
  assert.deepEqual(discoveredBrokerAppToolOverrides({ servers: [{ name: "codex_apps", tools: [
    { name: "interactive_brokers_ibkr.get_positions" }, { name: "tasks.cancel_task" },
  ] }], apps: [{ id: "fixture", name: "Interactive Brokers (IBKR)" }] }).overrides, {});
});
