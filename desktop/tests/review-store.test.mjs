import assert from "node:assert/strict";
import test from "node:test";
import { calculateRuleMetrics, ReviewStore } from "../src/data/review-store.mjs";

class MemoryStore {
  constructor() { this.values = new Map(); }
  async get(key) { return structuredClone(this.values.get(key)); }
  async set(key, value) { this.values.set(key, structuredClone(value)); }
}

function clock(...values) {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]);
}

test("pre-earnings snapshots are immutable, hashed, and versioned", async () => {
  let id = 0;
  const store = new ReviewStore({
    store: new MemoryStore(),
    now: clock(
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
      "2026-08-03T00:00:00.000Z",
      "2026-08-03T00:00:00.000Z",
      "2026-08-04T00:00:00.000Z",
      "2026-08-04T00:00:00.000Z",
    ),
    idFactory: () => `id-${++id}`,
  });
  const reviewCase = await store.createCase({
    symbol: "NVDA.US",
    fiscalQuarter: "FY26 Q2",
    eventAt: "2026-08-20T20:00:00.000Z",
    exAnte: {
      myView: "增长超预期",
      marketView: "市场预期高增长",
      plannedAction: "持有",
      invalidation: "指引下修",
      riskBudgetR: 1,
    },
  });
  const first = await store.freezeCase(reviewCase.id);
  await store.updateCase(reviewCase.id, { exAnte: { myView: "增长符合预期" } });
  const second = await store.freezeCase(reviewCase.id, { reason: "新公开证据" });
  const snapshot = await store.snapshot();

  assert.equal(first.version, 1);
  assert.equal(first.eligibleForFormalStats, true);
  assert.equal(first.snapshot.exAnte.myView, "增长超预期");
  assert.equal(second.version, 2);
  assert.notEqual(first.hash, second.hash);
  assert.equal(snapshot.cases[0].exAnteVersions[0].snapshot.exAnte.myView, "增长超预期");
});

test("a snapshot sealed after the event is retrospective and excluded from formal evidence", async () => {
  let id = 0;
  const store = new ReviewStore({
    store: new MemoryStore(),
    now: () => new Date("2026-08-21T00:00:00.000Z"),
    idFactory: () => `id-${++id}`,
  });
  const reviewCase = await store.createCase({
    symbol: "AAPL.US",
    eventAt: "2026-08-20T20:00:00.000Z",
    exAnte: {
      myView: "需求稳定",
      marketView: "市场预期温和增长",
      plannedAction: "观察",
      invalidation: "指引下修",
      riskBudgetR: 1,
    },
  });
  const version = await store.freezeCase(reviewCase.id);
  assert.equal(version.timing, "retrospective");
  assert.equal(version.eligibleForFormalStats, false);
  assert.equal((await store.snapshot()).cases[0].status, "retrospective");
});

test("rule metrics count one registered event result and label small samples as observational", async () => {
  let id = 0;
  const repository = new MemoryStore();
  const store = new ReviewStore({
    store: repository,
    now: () => new Date("2026-08-01T00:00:00.000Z"),
    idFactory: () => `id-${++id}`,
  });
  const reviewCase = await store.createCase({
    symbol: "MSFT.US",
    eventAt: "2026-08-20T20:00:00.000Z",
    exAnte: {
      myView: "云业务加速",
      marketView: "市场预期稳定",
      plannedAction: "财报后确认",
      invalidation: "云增速下修",
      riskBudgetR: 1,
    },
  });
  await store.freezeCase(reviewCase.id);
  const secondCase = await store.createCase({
    symbol: "MSFT.US",
    fiscalQuarter: "FY26 Q4",
    eventAt: "2026-10-20T20:00:00.000Z",
    exAnte: {
      myView: "云业务加速",
      marketView: "市场预期稳定",
      plannedAction: "财报后确认",
      invalidation: "云增速下修",
      riskBudgetR: 1,
    },
  });
  await store.freezeCase(secondCase.id);
  const rule = await store.createRule({
    title: "财报后确认再买",
    condition: "T+1 相对强度转正",
    action: "建立战术仓",
    caseIds: [reviewCase.id],
  });
  const testOne = await store.registerTest({ caseId: reviewCase.id, ruleId: rule.id });
  const testTwo = await store.registerTest({ caseId: secondCase.id, ruleId: rule.id });
  await store.completeTest(testOne.id, { outcomeR: 2 });
  await store.completeTest(testTwo.id, { outcomeR: -1, outcomeSource: "broker_engine" });
  const metrics = calculateRuleMetrics(await store.snapshot(), rule.id);

  assert.equal(metrics.sampleCount, 2);
  assert.equal(metrics.verifiedSampleCount, 0);
  assert.equal(metrics.winRatePercent, 50);
  assert.equal(metrics.expectancyR, 0.5);
  assert.equal(metrics.profitFactor, 2);
  assert.equal(metrics.evidenceLabel, "观察性发现 · 含待核验人工结果");
  assert.equal((await store.snapshot()).tests.every((item) => item.outcomeSource === "manual"), true);
});

test("rule promotion follows the explicit human-reviewed state machine", async () => {
  let id = 0;
  const store = new ReviewStore({
    store: new MemoryStore(),
    now: () => new Date("2026-08-01T00:00:00.000Z"),
    idFactory: () => `id-${++id}`,
  });
  const rule = await store.createRule({ title: "候选规则" });
  await assert.rejects(
    store.transitionRule(rule.id, { status: "validated" }),
    /不能从 hypothesis 转为 validated/,
  );
  const testing = await store.transitionRule(rule.id, { status: "testing", reason: "开始样本外测试" });
  assert.equal(testing.status, "testing");
  await assert.rejects(
    store.transitionRule(rule.id, { status: "provisional" }),
    /至少需要 20 个.*核验/,
  );
  const review = await store.addRuleReview(rule.id, {
    decision: "keep",
    evidence: "结果尚稳定",
    nextTrigger: "下个财报季",
  });
  assert.equal(review.decision, "keep");
});
