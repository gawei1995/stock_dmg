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
  assert.match(script, /stripBrokerRecordPrefix/);
  assert.match(script, /`order:\$\{raw\}`/);
  assert.match(script, /`execution:\$\{raw\}`/);
  assert.match(script, /旧规则版本未被覆盖/);
  assert.match(script, /keep:\s*elements\.governanceKeep/);
  assert.match(script, /change:\s*elements\.governanceChange/);
  assert.match(script, /nextTrigger:\s*elements\.governanceNext/);
  assert.doesNotMatch(script, /window\.(?:reviewState|state)\s*=/);
});

test("review analysis reuses the existing Codex operation and recovery harness", async () => {
  const [script, reviewScript] = await Promise.all([
    source("renderer.js"),
    source("review.js"),
  ]);

  assert.match(script, /cockpit:review-analysis-prepared/);
  assert.match(script, /submitPreparedReviewAnalysis/);
  assert.match(script, /startAgentOperation\(\{/);
  assert.match(script, /scope:\s*"review"/);
  assert.match(script, /reviewCaseIds/);
  assert.match(script, /api\.runAgent\(\{/);
  assert.match(script, /scheduleAgentResultRecovery/);
  assert.match(script, /view\.scope = "review"/);
  assert.match(script, /reviewContext/);
  assert.match(script, /state\.analysisScope !== "review" && !state\.portfolio/);
  assert.match(reviewScript, /setTimeout\(\(\) => \{[\s\S]{0,220}cockpit:review-analysis-prepared/);
});

test("review intake searches the host and paginates beyond the first page", async () => {
  const [html, script] = await Promise.all([
    source("index.html"),
    source("review.js"),
  ]);

  assert.match(html, /id="review-intake-load-more"/);
  assert.match(html, /id="review-intake-page-status"/);
  assert.match(script, /INTAKE_PAGE_LIMIT/);
  assert.match(script, /loadIntakePage\(\{ append: true \}\)/);
  assert.match(script, /const offset = append \? previous\.nextOffset : 0/);
  assert.match(script, /const requestQuery = state\.intakeSearch/);
  assert.match(script, /query:\s*requestQuery/);
  assert.match(script, /mergeIntakePages/);
  assert.match(script, /selectedRecordCache/);
  assert.match(script, /nextOffset:\s*nullableNonNegativeInteger/);
  assert.match(script, /completeness:\s*source\?\.completeness/);
  assert.match(script, /\["stale", "best_effort", "not_synced"\]/);
  assert.doesNotMatch(script, /limit:\s*2_000/);
});

test("review analysis accepts only explicitly confirmed broker-backed cases", async () => {
  const script = await source("review.js");

  assert.match(script, /function caseHasConfirmedBrokerRecords\(item\)/);
  assert.match(script, /links\?\.confirmedAt/);
  assert.match(script, /casePeriod\(item\) === state\.quarterFilter && caseHasConfirmedBrokerRecords\(item\)/);
  assert.match(script, /尚未确认关联长桥订单或成交/);
  assert.match(script, /autoIncludedRecordCount/);
  assert.match(script, /自动补齐了/);
});

test("main process builds review evidence from encrypted cases without requiring a live portfolio", async () => {
  const main = await readFile(new URL("../main.mjs", import.meta.url), "utf8");

  assert.match(main, /scope !== "review" && !portfolio/);
  assert.match(main, /selectReviewCaseIds\(reviewWorkspace/);
  assert.match(main, /buildReviewAnalysisRun\(\{/);
  assert.match(main, /archive:\s*reviewArchive/);
  assert.match(main, /caseIds:\s*reviewCaseIds/);
  assert.match(main, /scope === "review"[\s\S]{0,900}reviewStore\.snapshot\(\)/);
  assert.match(main, /\["position", "candidate", "portfolio", "review"\]/);
});
