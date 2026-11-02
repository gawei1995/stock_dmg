import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { buildSystemHealthSnapshot } from "../src/runtime/system-health.mjs";

const script = await readFile(new URL("../renderer/health.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(script, context);
const { createController, renderSnapshot, validateSnapshot, textValue } = context.CockpitHealthUI;

class Node {
  constructor(tag = "div") { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.events = new Map(); this.isConnected = true; this.open = false; this.focused = false; }
  set textContent(value) { this.value = String(value); this.children = []; }
  get textContent() { return (this.value ?? "") + this.children.map((node) => node.textContent).join(" "); }
  set innerHTML(_) { throw new Error("HTML injection path is forbidden"); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.value = ""; this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.events.set(name, [...(this.events.get(name) ?? []), callback]); }
  async dispatch(name, event = {}) { for (const callback of this.events.get(name) ?? []) await callback(event); }
  showModal() { this.open = true; }
  close() { this.open = false; void this.dispatch("close"); }
  focus() { this.focused = true; }
}
function fixture(api) {
  const activeElement = new Node("button");
  const document = { activeElement, createElement: (tag) => new Node(tag), createDocumentFragment: () => new Node("fragment") };
  const elements = Object.fromEntries(["open", "dialog", "close", "refresh", "asof", "message", "body"].map((name) => [name, new Node(name)]));
  const controller = createController({ api, elements, document });
  controller.bind();
  return { controller, elements, document, activeElement };
}
function snapshot(overrides = {}) {
  return { schemaVersion: 1, generatedAt: "2026-09-18T01:02:03Z", status: "healthy", sections: [{ id: "data", title: "连接与数据", state: "healthy", summary: "本机状态", cards: [{ id: "longbridge", title: "长桥", state: "healthy", summary: "已连接不代表行情实时", observedAt: "2026-09-17T20:00:00Z", fields: [{ label: "字节数", value: null }, { label: "已确认", value: 0 }], details: ["仅本地读取"], source: "本机缓存" }] }], capabilities: [{ id: "ibkr", label: "IBKR", items: [{ id: "history", label: "复盘历史", support: "not_supported", state: "unavailable", detail: "未接入复盘" }] }], ...overrides };
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function allNodes(node) { return [node, ...node.children.flatMap(allNodes)]; }

test("health renderer uses semantic local states, safe text and explicit unknown numbers", () => {
  const { document, elements } = fixture({});
  const model = snapshot({ status: "unknown" });
  model.sections[0].cards[0].title = '<img src=x onerror="steal()">';
  model.sections[0].cards[0].state = "new_unrecognized_state";
  renderSnapshot(document, elements.body, model);
  assert.match(elements.body.textContent, /<img src=x onerror="steal\(\)">/);
  assert.match(elements.body.textContent, /字节数 未取得/);
  assert.match(elements.body.textContent, /已确认 0/);
  assert.match(elements.body.textContent, /本机观测时间/);
  assert.match(elements.body.textContent, /暂不支持.*未接入复盘/);
  const cardBadge = allNodes(elements.body).find((node) => node.dataset.status === "unknown");
  assert.equal(cardBadge.textContent, "未知");
  assert.equal(textValue(Number.NaN), "未取得");
  assert.equal(textValue({ netAsset: 123 }), "未取得");
});

test("actual host health model renders all six sections without changing unknown into healthy", () => {
  const model = buildSystemHealthSnapshot({ now: new Date("2026-09-18T02:03:04Z"), version: "0.24.2" });
  const { document, elements } = fixture({});
  renderSnapshot(document, elements.body, model);
  assert.equal(model.sections.length, 6);
  assert.equal(model.sections.find((item) => item.id === "storage").cards.length, 6);
  assert.match(elements.body.textContent, /本机加密存储.*持仓、估值与汇率.*收盘快照连续性/s);
  assert.match(elements.body.textContent, /本机加密存储检查/);
  assert.match(elements.body.textContent, /应用索引与最近结果/);
  assert.doesNotMatch(elements.body.textContent, /EncryptedStore\.health|brokerUiSnapshot\.views/);
  assert.ok(allNodes(elements.body).some((node) => node.dataset.status === "unknown"));
});

test("backup wording distinguishes application indexes from external full transcripts and local authority", async () => {
  const html = await readFile(new URL("../renderer/index.html", import.meta.url), "utf8");
  const review = await readFile(new URL("../renderer/review.js", import.meta.url), "utf8");
  const backupCopy = html.slice(html.indexOf('<section class="review-recovery-controls"'), html.indexOf('<details class="review-snapshot-coverage"'));
  assert.match(backupCopy, /应用内对话索引与最近结果/);
  assert.match(backupCopy, /不含登录凭证、TradingView 登录状态或 Codex 外部完整对话/);
  assert.match(backupCopy, /同一 macOS 钥匙串身份.*不是跨设备灾备/);
  assert.match(backupCopy, /后台运行、登录启动和账户身份校验沿用本机设置/);
  assert.match(backupCopy, /旧版四文件包保留当前应用索引/);
  const definitions = ["exportTrustedBackup", "restoreTrustedBackup"].map((name) => {
    const start = review.indexOf(`  async function ${name}(`);
    assert.ok(start >= 0);
    const remaining = review.slice(start + 1);
    const end = remaining.search(/\n  (?:async )?function \w+\(/);
    return end < 0 ? review.slice(start) : review.slice(start, start + end + 1);
  }).join("\n");
  const messages = [];
  let restoreResult = { ok: true, restarting: true };
  const scope = vm.createContext({ state: { loading: false }, runAction: async (_label, action) => action(), showNotice: (message) => messages.push(message), api: { review: {
    exportTrustedBackup: async () => ({ ok: true, fileCount: 5 }),
    restoreTrustedBackup: async () => restoreResult,
  } } });
  vm.runInContext(definitions, scope);
  await scope.exportTrustedBackup();
  assert.match(messages.at(-1), /应用索引与最近结果按清单保存.*不含登录凭证或 Codex 外部完整对话/);
  await scope.restoreTrustedBackup();
  assert.match(messages.at(-1), /本机后台、登录启动和账户校验设置保留.*完整对话仍依赖原服务/);
  restoreResult = { ok: true, unchanged: true };
  await scope.restoreTrustedBackup();
  assert.match(messages.at(-1), /旧版包未包含的应用索引.*保持不变/);
});

test("opening hides native TV before modal and only requests a local health snapshot", async () => {
  const calls = [];
  const { controller, elements } = fixture({ setOpen: async (value) => { calls.push(["visibility", value]); return { ok: true }; }, snapshot: async () => { calls.push(["snapshot"]); return snapshot(); } });
  const originalShow = elements.dialog.showModal.bind(elements.dialog);
  elements.dialog.showModal = () => { calls.push(["modal"]); originalShow(); };
  await controller.open();
  assert.deepEqual(calls, [["visibility", true], ["modal"], ["snapshot"]]);
  assert.equal(elements.dialog.open, true);
  assert.equal(elements.close.focused, true);
  assert.match(elements.asof.textContent, /本地汇总生成于.*非行情时间/);
  assert.match(elements.message.textContent, /正常/);
});

test("failed refresh clears prior healthy indicators and keeps a visible failure", async () => {
  let reads = 0;
  const { controller, elements } = fixture({ setOpen: async () => ({ ok: true }), snapshot: async () => { if (reads++) throw new Error("private token must not be shown"); return snapshot(); } });
  await controller.open();
  assert.ok(allNodes(elements.body).some((node) => node.dataset.status === "healthy"));
  await controller.refresh();
  assert.equal(elements.body.children.length, 0);
  assert.equal(elements.message.dataset.state, "error");
  assert.match(elements.message.textContent, /本次读取失败.*未保留旧的正常标记/);
  assert.doesNotMatch(elements.message.textContent, /private token/);
  assert.equal(elements.refresh.disabled, false);
});

test("refresh loading clears stale results and late responses cannot repopulate a closed modal", async () => {
  const pending = deferred();
  let reads = 0;
  const calls = [];
  const { controller, elements } = fixture({ setOpen: async (value) => { calls.push(value); return { ok: true }; }, snapshot: async () => reads++ ? pending.promise : snapshot() });
  await controller.open();
  const refresh = controller.refresh();
  assert.equal(elements.body.children.length, 0);
  assert.equal(elements.refresh.disabled, true);
  await controller.refresh();
  assert.equal(reads, 2, "no duplicate in-flight refresh");
  await controller.close();
  pending.resolve(snapshot());
  await refresh;
  assert.equal(elements.dialog.open, false);
  assert.equal(elements.body.children.length, 0);
  assert.deepEqual(calls, [true, false]);
});

test("Escape follows the host restore path and returns focus without touching workspace fields", async () => {
  const calls = [];
  const { controller, elements, activeElement, document } = fixture({ setOpen: async (value) => { calls.push(value); return { ok: true }; }, snapshot: async () => snapshot() });
  document.workspaceMode = "review";
  document.draft = "user's unfinished note";
  await controller.open();
  let prevented = false;
  await elements.dialog.dispatch("cancel", { preventDefault() { prevented = true; } });
  await Promise.resolve();
  assert.equal(prevented, true);
  assert.equal(elements.dialog.open, false);
  assert.equal(activeElement.focused, true);
  assert.equal(document.workspaceMode, "review");
  assert.equal(document.draft, "user's unfinished note");
  assert.deepEqual(calls, [true, false]);
});

test("failed native view restoration keeps close retry available and does not leave a green panel", async () => {
  let refuseClose = true;
  const { controller, elements } = fixture({ setOpen: async (open) => ({ ok: open || !refuseClose }), snapshot: async () => snapshot() });
  await controller.open();
  await controller.close();
  assert.equal(elements.dialog.open, true);
  assert.equal(elements.body.children.length, 0);
  assert.equal(elements.close.disabled, false);
  assert.match(elements.message.textContent, /再次点击关闭/);
  refuseClose = false;
  await controller.close();
  assert.equal(elements.dialog.open, false);
});

test("malformed or unknown snapshots cannot be displayed as a healthy result", async () => {
  assert.throws(() => validateSnapshot({ status: "healthy" }), /HEALTH_MODEL_INVALID/);
  const { controller, elements } = fixture({ setOpen: async () => ({ ok: true }), snapshot: async () => snapshot({ status: "unrecognized" }) });
  await controller.open();
  assert.match(elements.message.textContent, /本机记录：未知/);
  assert.doesNotMatch(elements.message.textContent, /本机记录：正常/);
});

test("health markup is independently scrollable, labeled and does not replace the workspace", async () => {
  const [html, css] = await Promise.all([
    readFile(new URL("../renderer/index.html", import.meta.url), "utf8"),
    readFile(new URL("../renderer/health.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="system-health-open"[^>]*aria-haspopup="dialog"/);
  assert.match(html, /<dialog[^>]*id="system-health-dialog"[^>]*aria-labelledby="system-health-title"/);
  assert.match(html, /id="system-health-body"[^>]*tabindex="0"/);
  assert.match(html, /src="\.\/health\.js"/);
  assert.match(css, /\.system-health-body\s*\{[^}]*overflow-y: auto/s);
  assert.doesNotMatch(script, /localStorage|sessionStorage|workspace\.setMode|fetch\(|innerHTML\s*=/);
});
