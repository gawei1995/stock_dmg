import assert from "node:assert/strict";
import test from "node:test";

await import("../renderer/markdown.js");

test("dark chat Markdown tokenizer recognizes compact trading output blocks", () => {
  const tokens = globalThis.CockpitMarkdown.tokenizeMarkdown([
    "## 结论",
    "",
    "- 风险 **0.8%**",
    "- 观察 `EMA21`",
    "",
    "| 场景 | 动作 |",
    "| --- | --- |",
    "| 熊 | 保护 |",
  ].join("\n"));
  assert.deepEqual(tokens.map((token) => token.type), ["heading", "list", "table"]);
  assert.deepEqual(tokens[1].items, ["风险 **0.8%**", "观察 `EMA21`"]);
  assert.deepEqual(tokens[2].header, ["场景", "动作"]);
});

test("Markdown renderer creates text nodes instead of interpreting model HTML", () => {
  const previousDocument = globalThis.document;
  const createdTags = [];
  globalThis.document = {
    createElement(tag) {
      createdTags.push(tag);
      return new FakeNode(tag);
    },
    createTextNode(text) {
      return new FakeNode("#text", String(text));
    },
  };
  try {
    const container = new FakeNode("div");
    globalThis.CockpitMarkdown.renderMarkdown(
      container,
      "<img src=x onerror=alert(1)>\n\n**风险优先**",
    );
    assert.equal(createdTags.includes("img"), false);
    assert.match(container.textContent, /<img src=x onerror=alert\(1\)>/);
    assert.match(container.textContent, /风险优先/);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("Markdown links render as safe external anchors without exposing source syntax", async () => {
  const previousDocument = globalThis.document;
  const previousCockpit = globalThis.cockpit;
  const opened = [];
  globalThis.document = fakeDocument();
  globalThis.cockpit = {
    openExternal(url) {
      opened.push(url);
      return Promise.resolve({ ok: true });
    },
  };
  try {
    const container = new FakeNode("div");
    globalThis.CockpitMarkdown.renderMarkdown(container, [
      "官方时间见 [Alphabet 官方公告](https://alphabet2025ir.q4web.com/investor/news/report.aspx)。",
      "详情见 [Reuters 财报前瞻](https://example.com/alphabet_(Q2)?x=1&amp;y=2 \"财报来源\")。",
    ].join("\n"));
    const anchors = findNodes(container, "a");
    assert.equal(anchors.length, 2);
    assert.equal(anchors[0].textContent, "Alphabet 官方公告");
    assert.equal(anchors[0].href, "https://alphabet2025ir.q4web.com/investor/news/report.aspx");
    assert.equal(anchors[1].href, "https://example.com/alphabet_(Q2)?x=1&y=2");
    assert.equal(anchors[1].title, "财报来源");
    assert.doesNotMatch(container.textContent, /\]\(https:\/\//);
    anchors[0].dispatch("click");
    assert.deepEqual(opened, ["https://alphabet2025ir.q4web.com/investor/news/report.aspx"]);
  } finally {
    globalThis.document = previousDocument;
    if (previousCockpit === undefined) delete globalThis.cockpit;
    else globalThis.cockpit = previousCockpit;
  }
});

test("bare, angle and Google redirect links are compact and preserve surrounding punctuation", () => {
  const previousDocument = globalThis.document;
  globalThis.document = fakeDocument();
  try {
    const target = "https://www.sec.gov/Archives/report_(Q2).htm";
    const redirect = `https://www.google.com/url?q=${encodeURIComponent(target)}&sa=U`;
    const container = new FakeNode("div");
    globalThis.CockpitMarkdown.renderMarkdown(
      container,
      `裸链 https://example.com/report_(Q2)?x=1&amp;y=2，搜索 <https://www.google.com/search?q=Alphabet+earnings>；来源 <${redirect}>。`,
    );
    const anchors = findNodes(container, "a");
    assert.equal(anchors.length, 3);
    assert.equal(anchors[0].href, "https://example.com/report_(Q2)?x=1&y=2");
    assert.equal(anchors[1].textContent, "Google 搜索");
    assert.equal(anchors[2].href, target);
    assert.match(container.textContent, /，搜索/);
    assert.match(container.textContent, /；来源/);
    assert.match(container.textContent, /。$/);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("unsafe Markdown destinations remain inert and model HTML is never interpreted", () => {
  const previousDocument = globalThis.document;
  const createdTags = [];
  globalThis.document = {
    ...fakeDocument(),
    createElement(tag) {
      createdTags.push(tag);
      return new FakeNode(tag);
    },
  };
  try {
    const container = new FakeNode("div");
    globalThis.CockpitMarkdown.renderMarkdown(
      container,
      "[脚本](javascript:alert(1))、[明文](http://example.com)、<img src=x onerror=alert(1)>；[安全](https://example.com/a_(b))。",
    );
    const anchors = findNodes(container, "a");
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].href, "https://example.com/a_(b)");
    assert.equal(createdTags.includes("img"), false);
    assert.doesNotMatch(container.textContent, /javascript:|http:\/\//);
    assert.match(container.textContent, /<img src=x onerror=alert\(1\)>/);
  } finally {
    globalThis.document = previousDocument;
  }
});

function fakeDocument() {
  return {
    createElement(tag) {
      return new FakeNode(tag);
    },
    createTextNode(text) {
      return new FakeNode("#text", String(text));
    },
  };
}

function findNodes(root, tag) {
  const matches = [];
  const visit = (node) => {
    if (node.tag === tag) matches.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return matches;
}

class FakeNode {
  constructor(tag, value = "") {
    this.tag = tag;
    this.value = value;
    this.children = [];
    this.dataset = {};
    this.className = "";
    this.attributes = {};
    this.listeners = {};
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener(type, callback) {
    this.listeners[type] = callback;
  }

  dispatch(type) {
    this.listeners[type]?.({
      preventDefault() {},
      stopPropagation() {},
    });
  }

  get textContent() {
    if (this.tag === "#text") return this.value;
    return this.children.map((child) => child.textContent ?? "").join("");
  }

  set textContent(value) {
    this.children = [new FakeNode("#text", String(value))];
  }
}
