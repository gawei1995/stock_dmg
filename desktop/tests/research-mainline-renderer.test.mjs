import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../renderer/research.js", import.meta.url), "utf8");
const review = await readFile(new URL("../renderer/review.js", import.meta.url), "utf8");
const html = await readFile(new URL("../renderer/index.html", import.meta.url), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));

class Element {
  constructor(tag = "div") { this.tagName = tag; this.children = []; this.listeners = new Map(); this.attributes = {}; this.dataset = {}; this.value = ""; this.checked = false; this.disabled = false; this.hidden = false; this.ownText = ""; }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(""); }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.ownText = ""; this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
  async emit(type, options = {}) { return Promise.all((this.listeners.get(type) ?? []).map((fn) => fn({ target: this, preventDefault() {}, ...options }))); }
  querySelectorAll(selector) {
    const selectors = selector.split(",");
    const matches = (element) => selectors.some((item) => {
      const [tag, property] = item.trim().split("[");
      if (element.tagName !== tag) return false;
      if (!property) return true;
      const [key, value] = property.replace(/\]$/, "").split("=");
      return element[key] === value;
    });
    const result = [];
    for (const child of this.children) { if (matches(child)) result.push(child); result.push(...child.querySelectorAll(selector)); }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  focus() { this.focused = true; }
  reset() { for (const input of this.querySelectorAll("input,textarea")) input.value = ""; }
}

function thesis(id = "a", overrides = {}) {
  return {
    id, name: `研究 ${id}`, symbol: "TEST.US", revision: 1, status: "active", updatedAt: "2026-10-22T01:00:00.000Z",
    versions: [{ version: 1, recordedAt: "2026-10-22T01:00:00.000Z", origin: "user", fields: { myView: "原始判断", marketBelief: "市场预期", stage: "unknown" } }],
    evidence: [], observations: [], reviewLinks: [], proposals: [], ...overrides,
  };
}

function boot(initial = { revision: 1, theses: [thesis()], reviewCycles: [] }, overrides = {}) {
  const ids = ["review-panel-research", "research-list", "research-detail", "research-notice", "research-refresh", "research-create-form", "research-create-symbol", "research-create-view", "research-search", "research-show-archived", "research-tab-count", "research-status-filter", "research-due-only"];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  elements["research-status-filter"].value = "all";
  elements["research-create-form"].append(elements["research-create-symbol"], elements["research-create-view"]);
  const submit = new Element("button"); submit.type = "submit"; elements["research-create-form"].append(submit);
  const events = new Map(), requests = [], emitted = [];
  let snapshot = clone(initial), onAgentResult;
  const api = {
    snapshot: async () => { requests.push(["snapshot"]); return { snapshot: clone(snapshot) }; },
    ...Object.fromEntries(["create", "revise", "addEvidence", "addObservation", "setStatus", "linkReview", "acceptProposal"].map((name) => [name, async (request) => { requests.push([name, clone(request)]); return { thesis: snapshot.theses[0], snapshot: clone(snapshot) }; }])),
    ...overrides,
  };
  const window = {
    location: { hash: "" }, confirm: () => true, cockpit: { research: api, onAgentResult: (listener) => { onAgentResult = listener; } },
    addEventListener(type, callback) { if (!events.has(type)) events.set(type, []); events.get(type).push(callback); },
    dispatchEvent(event) { emitted.push(event); for (const fn of events.get(event.type) ?? []) fn(event); return true; },
  };
  const context = { window, document: { querySelector: (selector) => elements[selector.slice(1)], createElement: (tag) => new Element(tag) }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }, URL, Date, console };
  vm.runInNewContext(source, context);
  const emit = async (type, detail) => { window.dispatchEvent({ type, detail }); await flush(); };
  const activate = () => emit("cockpit:review-tab-changed", { tab: "research", mode: "review" });
  const open = async (index = 0) => { await elements["research-list"].querySelectorAll("button")[index].emit("click"); await flush(); };
  return { elements, requests, emitted, api, window, activate, open, emit, setSnapshot(value) { snapshot = clone(value); }, agentResult(envelope) { onAgentResult(envelope); } };
}

function button(root, label) { const found = root.querySelectorAll("button").find((item) => item.textContent === label); assert.ok(found, `button ${label}`); return found; }
function field(root, label) { const found = root.querySelectorAll("label").find((item) => item.ownText === label); assert.ok(found, `field ${label}`); return found.querySelectorAll("input,textarea,select")[0]; }
async function input(root, label, value) { const element = field(root, label); element.value = value; await element.emit(element.tagName === "select" ? "change" : "input"); return element; }
async function submitByButton(root, label) { let form = button(root, label); while (form && form.tagName !== "form") form = form.parent; assert.ok(form); await form.emit("submit"); await flush(); }

test("research opens lazily, filters active/watch/due/archive and uses text nodes for untrusted input", async () => {
  const fixture = boot({ revision: 4, theses: [thesis("a", { name: "<img src=x onerror=alert(1)>" }), thesis("b", { status: "watching", versions: [{ version: 1, recordedAt: "2026-10-01T00:00:00Z", fields: { myView: "待检验", nextReviewAt: "2026-01-01T00:00:00Z" } }] }), thesis("c", { status: "archived" })], reviewCycles: [] });
  assert.equal(fixture.requests.length, 0, "boot never reads full review, broker or research until selected");
  await fixture.activate();
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.elements["research-list"].querySelectorAll("button").length, 2);
  assert.match(fixture.elements["research-list"].textContent, /<img src=x/);
  assert.equal(fixture.elements["research-list"].querySelectorAll("img").length, 0);
  fixture.elements["research-due-only"].checked = true; await fixture.elements["research-due-only"].emit("change");
  assert.equal(fixture.elements["research-list"].querySelectorAll("button").length, 1);
  fixture.elements["research-due-only"].checked = false; fixture.elements["research-status-filter"].value = "watching"; await fixture.elements["research-status-filter"].emit("change");
  assert.match(fixture.elements["research-list"].textContent, /研究 b/);
  assert.doesNotMatch(fixture.elements["research-list"].textContent, /研究 c/);
  fixture.elements["research-status-filter"].value = "all"; fixture.elements["research-show-archived"].checked = true; await fixture.elements["research-show-archived"].emit("change");
  assert.equal(fixture.elements["research-list"].querySelectorAll("button").length, 3);
});

test("fast create persists one line without an account or a hidden model call", async () => {
  const created = thesis("created");
  const calls = [];
  const fixture = boot({ revision: 0, theses: [], reviewCycles: [] }, { create: async (request) => { calls.push(clone(request)); return { thesis: created, snapshot: { revision: 1, theses: [created], reviewCycles: [] } }; } });
  fixture.elements["research-create-symbol"].value = "test.us";
  fixture.elements["research-create-view"].value = "我认为市场低估了收入兑现速度";
  await fixture.elements["research-create-form"].emit("submit");
  assert.deepEqual(calls, [{ symbol: "TEST.US", myView: "我认为市场低估了收入兑现速度" }]);
  assert.match(fixture.elements["research-detail"].textContent, /判断历史/);
  assert.equal(fixture.emitted.filter((event) => event.type === "cockpit:research-analysis-prepared").length, 0);
});

test("refresh preserves an unsaved judgment, and CAS failure never hides or replaces it", async () => {
  let request;
  const fixture = boot(undefined, { revise: async (payload) => { request = clone(payload); throw new Error("研究记录已变化"); } });
  await fixture.activate(); await fixture.open();
  await input(fixture.elements["research-detail"], "我目前的判断", "尚未保存的新判断");
  const newer = thesis("a", { revision: 2, versions: [{ version: 1, recordedAt: "2026-10-22T01:00:00Z", fields: { myView: "原始判断" } }, { version: 2, recordedAt: "2026-10-22T02:00:00Z", fields: { myView: "另一个窗口保存的判断" } }] });
  fixture.setSnapshot({ revision: 2, theses: [newer], reviewCycles: [] });
  await fixture.elements["research-refresh"].emit("click");
  assert.equal(field(fixture.elements["research-detail"], "我目前的判断").value, "尚未保存的新判断");
  await submitByButton(fixture.elements["research-detail"], "保存为新判断版本");
  assert.equal(request.expectedRevision, 1);
  assert.equal(request.myView, "尚未保存的新判断");
  assert.match(fixture.elements["research-notice"].textContent, /草稿仍保留/);
  assert.equal(field(fixture.elements["research-detail"], "我目前的判断").value, "尚未保存的新判断");
  assert.match(fixture.elements["research-detail"].textContent, /另一个窗口保存的判断/);
});

test("manual evidence submits literal zero with units, period, currency and denominator and labels it unverified", async () => {
  let request;
  const fixture = boot(undefined, { addEvidence: async (payload) => { request = clone(payload); return { snapshot: { revision: 2, theses: [thesis("a", { revision: 2, evidence: [{ ...payload, recordedAt: "2026-10-22T02:00:00Z", thesisVersion: 1 }] })], reviewCycles: [] } }; } });
  await fixture.activate(); await fixture.open();
  const root = fixture.elements["research-detail"];
  await input(root, "证据 / 反证内容", "边际净新增订单为零");
  for (const [label, value] of [["原始数值", "0"], ["单位，如 % / 百万美元", "%"], ["所属期间，如 FY2026 Q2", "FY2026 Q2"], ["币种，如 USD", "usd"], ["分母 / 比较口径", "0"], ["来源链接（可选，https/http）", "https://example.com/filing"]]) await input(root, label, value);
  await submitByButton(root, "保存证据记录");
  assert.equal(request.expectedRevision, 1);
  assert.deepEqual(request.numeric, { value: 0, unit: "%", period: "FY2026 Q2", currency: "USD", denominator: "0" });
  assert.match(root.textContent, /原始数值 0 %/);
  assert.match(root.textContent, /来源未独立核验/);
  assert.match(root.querySelectorAll("a")[0].textContent, /example.com/);
  assert.doesNotMatch(root.querySelectorAll("a")[0].textContent, /https:\/\//);
});

test("AI updates remain editable proposals until an explicit checkbox and field adoption", async () => {
  const proposal = { id: "p", status: "pending", recordedAt: "2026-10-22T03:00:00Z", baseRevision: 1, baseThesisVersion: 1, fields: { myView: null, marketBelief: "AI 归纳的市场预期" }, evidence: [{ claim: "来源声称营收同比增长", stance: "context", kind: "fact", url: "https://example.com/release" }], openQuestions: ["一致预期尚需核验"] };
  let request;
  const fixture = boot({ revision: 2, theses: [thesis("a", { revision: 2, proposals: [proposal] })], reviewCycles: [] }, { acceptProposal: async (payload) => { request = clone(payload); return { snapshot: { revision: 3, theses: [thesis("a", { revision: 3, proposals: [{ ...proposal, status: "adopted" }] })], reviewCycles: [] } }; } });
  await fixture.activate(); await fixture.open();
  const root = fixture.elements["research-detail"];
  assert.equal(field(root, "我目前的判断").value, "原始判断");
  await submitByButton(root, "确认采纳勾选字段");
  assert.equal(request, undefined);
  assert.match(fixture.elements["research-notice"].textContent, /请勾选/);
  const proposalForm = button(root, "确认采纳勾选字段").parent;
  const nullField = proposalForm.querySelectorAll("label").find((label) => label.textContent.includes("采纳：我目前的判断"));
  assert.equal(nullField.querySelector("input").checked, false, "null AI fields must never clear user judgments by default");
  const editable = field(proposalForm, "市场目前相信什么"); editable.value = "我修正后的市场预期"; await editable.emit("input");
  const sourceCheckbox = proposalForm.querySelectorAll("label").find((label) => label.textContent.includes("纳入证据账本"));
  assert.equal(sourceCheckbox.querySelector("input").checked, false, "AI sources are never silently admitted");
  sourceCheckbox.querySelector("input").checked = true; await sourceCheckbox.querySelector("input").emit("change");
  const confirm = proposalForm.querySelectorAll("label").find((label) => label.textContent.includes("我已核对勾选字段"));
  confirm.querySelector("input").checked = true;
  await proposalForm.emit("submit"); await flush();
  assert.deepEqual(request, { id: "a", expectedRevision: 2, proposalId: "p", fields: { marketBelief: "我修正后的市场预期" }, selectedEvidenceIndexes: [0], confirmed: true });
});

test("stale async snapshot and mutation replies cannot roll the store backwards", async () => {
  const reads = [];
  const fixture = boot(undefined, { snapshot: () => new Promise((resolve) => reads.push(resolve)) });
  const activate = fixture.activate(); await flush();
  const refresh = fixture.elements["research-refresh"].emit("click");
  reads[1]({ snapshot: { revision: 3, theses: [thesis("new")], reviewCycles: [] } }); await refresh;
  reads[0]({ snapshot: { revision: 1, theses: [thesis("old")], reviewCycles: [] } }); await activate;
  assert.match(fixture.elements["research-list"].textContent, /研究 new/);
  assert.doesNotMatch(fixture.elements["research-list"].textContent, /研究 old/);
  await fixture.open();
  fixture.api.setStatus = async () => ({ snapshot: { revision: 2, theses: [thesis("older")], reviewCycles: [] } });
  await button(fixture.elements["research-detail"], "转为观察中").emit("click"); await flush();
  assert.match(fixture.elements["research-list"].textContent, /研究 new/);
});

test("only matching research results refresh, and explicit analysis creates one new-session request", async () => {
  const fixture = boot(); await fixture.activate(); await fixture.open();
  const initialReads = fixture.requests.length;
  fixture.agentResult({ run: { context: { researchThesisId: "other" } } }); await flush();
  assert.equal(fixture.requests.length, initialReads);
  fixture.agentResult({ run: { context: { researchThesisId: "a" } } }); await flush();
  assert.equal(fixture.requests.length, initialReads + 1);
  await button(fixture.elements["research-detail"], "新对话研究并生成草案").emit("click");
  const requests = fixture.emitted.filter((event) => event.type === "cockpit:research-analysis-prepared");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].detail.researchThesisId, "a");
  assert.equal(requests[0].detail.researchIntent, "update");
  assert.match(requests[0].detail.task, /方法不限于 EMA\/Fib/);
});

test("review linkage is explicit, records the selected cycle and opens the original cycle", async () => {
  let request;
  const fixture = boot({ revision: 1, theses: [thesis()], reviewCycles: [{ id: "cycle-a", title: "已选订单窗口", symbols: ["TEST.US"], startAt: "2026-10-01T00:00:00Z", endAt: "2026-10-21T00:00:00Z" }] }, { linkReview: async (payload) => { request = clone(payload); return { snapshot: { revision: 2, theses: [thesis("a", { revision: 2, reviewLinks: [{ cycleId: "cycle-a", thesisVersion: 1, linkedAt: "2026-10-22T03:00:00Z", contextSnapshot: { revision: 1 } }] })], reviewCycles: [{ id: "cycle-a", title: "已选订单窗口", symbols: ["TEST.US"] }] } }; } });
  await fixture.activate(); await fixture.open();
  const root = fixture.elements["research-detail"];
  const form = button(root, "确认关联").parent;
  form.querySelector("select").value = "cycle-a";
  await form.emit("submit"); assert.equal(request, undefined);
  form.querySelector("input").checked = true; await form.emit("submit"); await flush();
  assert.deepEqual(request, { id: "a", expectedRevision: 1, cycleId: "cycle-a", confirmed: true });
  assert.match(root.textContent, /事后关联，不回填事前判断/);
  await button(root, "打开原复盘周期").emit("click");
  assert.equal(fixture.emitted.at(-1).detail.cycleId, "cycle-a");
});

test("research is a native review tab with keyboard navigation and no heavy review snapshot dependency", () => {
  assert.match(html, /data-review-tab="research"/);
  assert.match(html, /src="\.\/research\.js"/);
  assert.match(review, /if \(state\.activeTab !== "research"\) await loadSnapshot\(\)/);
  assert.match(review, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|fetch\(/);
  assert.match(source, /检查日期是待办记录，不会后台自动运行 Agent/);
});
