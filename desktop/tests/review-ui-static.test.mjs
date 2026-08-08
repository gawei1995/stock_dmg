import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rendererUrl = new URL("../renderer/", import.meta.url);

async function source(name) {
  return readFile(new URL(name, rendererUrl), "utf8");
}

test("review workspace is a same-window flow with four explicit stages", async () => {
  const [html, css] = await Promise.all([
    source("index.html"),
    source("review.css"),
  ]);

  assert.match(html, /id="workspace-cockpit"[^>]*data-workspace-mode="cockpit"/);
  assert.match(html, /id="workspace-review"[^>]*data-workspace-mode="review"/);
  assert.match(html, /id="review-workspace"[^>]*hidden/);
  for (const tab of ["cases", "tests", "rules", "governance"]) {
    assert.match(html, new RegExp(`data-review-tab="${tab}"`));
    assert.match(html, new RegExp(`id="review-panel-${tab}"`));
  }
  assert.match(html, /案例复盘/);
  assert.match(html, />测试\s*</);
  assert.match(html, />规则\s*</);
  assert.match(html, />Review\s*</);
  assert.match(html, /href="\.\/review\.css"/);
  assert.match(html, /src="\.\/review\.js"/);
  assert.match(css, /\.review-workspace[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\.review-panel[\s\S]*overflow:\s*auto/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test("review UI supports frozen cases, broker confirmation, tests, rules, and governance", async () => {
  const [html, script] = await Promise.all([
    source("index.html"),
    source("review.js"),
  ]);

  for (const id of [
    "review-case-form",
    "review-freeze-case",
    "review-broker-matches",
    "review-link-records",
    "review-test-form",
    "review-rule-form",
    "review-governance-form",
  ]) assert.match(html, new RegExp(`id="${id}"`));

  assert.match(script, /^\(\(\) => \{[\s\S]*"use strict";/);
  assert.match(script, /api\.workspace\.setMode\(nextMode\)/);
  for (const method of [
    "snapshot",
    "createCase",
    "updateCase",
    "freezeCase",
    "linkBrokerRecords",
    "syncTradeHistory",
    "registerTest",
    "completeTest",
    "createRule",
    "transitionRule",
    "addRuleReview",
  ]) assert.match(script, new RegExp(`callReview\\("${method}"`));

  assert.match(script, /CASE_FROZEN_STATES/);
  assert.match(script, /财报前字段不可覆盖/);
  assert.match(script, /自动匹配仅作为候选/);
  assert.match(script, /旧规则版本未被覆盖/);
  assert.match(script, /keep:\s*elements\.governanceKeep/);
  assert.match(script, /change:\s*elements\.governanceChange/);
  assert.match(script, /nextTrigger:\s*elements\.governanceNext/);
  assert.doesNotMatch(script, /window\.(?:reviewState|state)\s*=/);
});
