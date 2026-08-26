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

test("an order-first case derives broker dates and event metadata before the user writes a thesis", async () => {
  let id = 0;
  const store = new ReviewStore({
    store: new MemoryStore(),
    now: () => new Date("2026-08-01T00:00:00.000Z"),
    idFactory: () => `id-${++id}`,
  });
  const reviewCase = await store.createCaseFromBrokerRecords({
    symbol: "NVDA.US",
    activityStartAt: "2026-07-30T14:00:00.000Z",
    activityEndAt: "2026-07-30T14:01:00.000Z",
    orderIds: ["o-1"],
    executionIds: ["t-1"],
    recordIds: ["order:o-1", "execution:t-1"],
    event: {
      eventCandidateId: "nvda-event",
      eventAt: "2026-08-20T00:00:00.000Z",
      eventDate: "2026-08-20",
      eventTimePrecision: "session",
      eventSession: "amc",
      timezone: "America/New_York",
      fiscalQuarter: "FY2026 Q2",
    },
    eventAssociation: {
      status: "matched",
      source: "Longbridge finance_calendar",
      confidence: "high",
    },
  });

  assert.equal(reviewCase.origin, "longbridge_records");
  assert.equal(reviewCase.symbol, "NVDA.US");
  assert.equal(reviewCase.fiscalQuarter, "FY2026 Q2");
  assert.equal(reviewCase.brokerActivity.startAt, "2026-07-30T14:00:00.000Z");
  assert.deepEqual(reviewCase.brokerLinks.orderIds, ["o-1"]);
  assert.equal(reviewCase.brokerLinks.revision, 1);
  assert.deepEqual(reviewCase.brokerLinkVersions, [{
    revision: 1,
    changedAt: "2026-08-01T00:00:00.000Z",
    reason: "创建案例时关联",
    orderIds: ["o-1"],
    executionIds: ["t-1"],
  }]);
  assert.equal(reviewCase.exAnteDraft.myView, null);
});

test("broker associations are replaceable, append-only versioned, and idempotent without touching ex-ante evidence", async () => {
  let now = "2026-08-01T00:00:00.000Z";
  let id = 0;
  const repository = new MemoryStore();
  const store = new ReviewStore({
    store: repository,
    now: () => new Date(now),
    idFactory: () => `id-${++id}`,
  });
  const reviewCase = await store.createCaseFromBrokerRecords({
    symbol: "AAOI.US",
    activityStartAt: "2026-07-30T14:00:00.000Z",
    activityEndAt: "2026-07-30T14:01:00.000Z",
    orderIds: ["o-1"],
    executionIds: ["t-1"],
    recordIds: ["order:o-1", "execution:t-1"],
    event: {
      eventAt: "2026-08-20T20:00:00.000Z",
      eventDate: "2026-08-20",
      eventTimePrecision: "exact",
      fiscalQuarter: "FY2026 Q2",
    },
    exAnte: {
      myView: "需求可能超预期",
      marketView: "市场预期平稳",
      plannedAction: "事件前小仓",
      invalidation: "指引下修",
    },
  });
  const frozen = await store.freezeCase(reviewCase.id);
  const frozenHash = frozen.hash;

  now = "2026-08-02T00:00:00.000Z";
  const replaced = await store.replaceBrokerRecords(reviewCase.id, {
    orderIds: ["o-2"],
    executionIds: ["t-2", "t-3"],
    reason: "补充盘后卖出并移除误关联订单",
  });
  assert.equal(replaced.revision, 2);
  assert.deepEqual(replaced.orderIds, ["o-2"]);
  assert.deepEqual(replaced.executionIds, ["t-2", "t-3"]);

  const afterReplace = (await store.snapshot()).cases[0];
  assert.deepEqual(afterReplace.brokerLinkVersions.map((item) => item.revision), [1, 2]);
  assert.deepEqual(afterReplace.brokerLinkVersions[0].orderIds, ["o-1"]);
  assert.deepEqual(afterReplace.brokerLinkVersions[0].executionIds, ["t-1"]);
  assert.equal(afterReplace.brokerLinkVersions[0].supersededBy, 2);
  assert.equal(afterReplace.brokerLinkVersions[0].supersededAt, "2026-08-02T00:00:00.000Z");
  assert.equal(afterReplace.brokerLinkVersions[1].supersededBy, undefined);
  assert.equal(afterReplace.brokerLinkVersions[1].reason, "补充盘后卖出并移除误关联订单");
  assert.equal(afterReplace.exAnteVersions[0].hash, frozenHash);
  const caseUpdatedAt = afterReplace.updatedAt;
  const workspaceUpdatedAt = (await store.snapshot()).updatedAt;

  now = "2026-08-03T00:00:00.000Z";
  const idempotent = await store.updateBrokerRecords(reviewCase.id, {
    orderIds: ["o-2", "o-2"],
    executionIds: ["t-3", "t-2"],
    reason: "重复提交不应建立版本",
  });
  const afterIdempotent = (await store.snapshot()).cases[0];
  assert.equal(idempotent.revision, 2);
  assert.equal(afterIdempotent.brokerLinkVersions.length, 2);
  assert.equal(afterIdempotent.updatedAt, caseUpdatedAt);
  assert.equal((await store.snapshot()).updatedAt, workspaceUpdatedAt);

  await assert.rejects(
    store.replaceBrokerRecords(reviewCase.id, { orderIds: [], executionIds: [] }),
    /至少需要关联一笔/,
  );
  assert.equal((await store.snapshot()).cases[0].brokerLinkVersions.length, 2);
});

test("legacy broker links migrate into revision one and remain replaceable", async () => {
  const repository = new MemoryStore();
  await repository.set("reviewWorkspaceV1", {
    schemaVersion: 1,
    updatedAt: "2026-08-01T00:00:00.000Z",
    cases: [{
      id: "legacy-case",
      origin: "longbridge_records",
      symbol: "NVDA.US",
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      brokerLinks: {
        orderIds: ["legacy-order"],
        executionIds: ["legacy-fill"],
        confirmedAt: "2026-08-01T00:00:00.000Z",
      },
      exAnteDraft: { myView: "保留原始判断" },
      exAnteVersions: [{ version: 1, hash: "legacy-ex-ante" }],
    }],
    tests: [],
    rules: [],
    ruleReviews: [],
  });
  const store = new ReviewStore({
    store: repository,
    now: () => new Date("2026-08-02T00:00:00.000Z"),
    idFactory: () => "unused",
  });

  const migrated = (await store.snapshot()).cases[0];
  assert.equal(migrated.brokerLinks.revision, 1);
  assert.equal(migrated.brokerLinkVersions[0].reason, "迁移旧版关联");
  assert.deepEqual(migrated.brokerLinkVersions[0].orderIds, ["legacy-order"]);
  assert.equal(migrated.exAnteDraft.myView, "保留原始判断");
  assert.equal(migrated.exAnteVersions[0].hash, "legacy-ex-ante");

  await store.linkBrokerRecords("legacy-case", {
    orderIds: ["replacement-order"],
    reason: "修正历史关联",
  });
  const replaced = (await store.snapshot()).cases[0];
  assert.equal(replaced.brokerLinks.revision, 2);
  assert.deepEqual(replaced.brokerLinks.orderIds, ["replacement-order"]);
  assert.deepEqual(replaced.brokerLinks.executionIds, []);
  assert.deepEqual(replaced.brokerLinkVersions.map((item) => item.revision), [1, 2]);
  assert.equal(replaced.exAnteVersions[0].hash, "legacy-ex-ante");
});

test("an AI learning proposal creates one linked test and candidate rule only after user confirmation", async () => {
  let id = 0;
  const store = new ReviewStore({
    store: new MemoryStore(),
    now: () => new Date("2026-08-18T06:00:00.000Z"),
    idFactory: () => `learning-${++id}`,
  });
  const proposal = {
    hypothesis: "等待量价确认再加仓可降低 MAE，而不明显牺牲 T+20 收益",
    evidenceSummary: "来自一次事后复盘，只能作为待验证假设。",
    testDesign: {
      metric: "mae_r",
      window: "T+20",
      minCases: 12,
      inclusion: "同类突破回踩交易",
      exclusion: "停牌或数据不完整",
      successCriteria: "中位 MAE 改善至少 0.2R",
    },
    candidateRule: {
      title: "确认后再加仓",
      action: "量价确认后才增加风险",
      invalidation: "等待导致收益显著下降且 MAE 无改善",
      scope: "高波动成长股突破回踩",
    },
    confidence: "medium",
    caveats: [],
    evidencePosture: "retrospective_not_ex_ante",
  };
  await assert.rejects(
    store.acceptLearningProposal({ proposal, confirmed: false }),
    /明确确认/,
  );
  assert.equal((await store.snapshot()).tests.length, 0);

  const accepted = await store.acceptLearningProposal({
    proposal,
    confirmed: true,
    reviewCycleId: "cycle-1",
    runId: "run-1",
  });
  assert.equal(accepted.rule.status, "testing");
  assert.equal(accepted.test.status, "collecting");
  assert.equal(accepted.test.observationStartedAt, "2026-08-18T06:00:00.000Z");
  assert.equal(accepted.test.decisionSampleTarget, 12);
  assert.equal(accepted.test.testKind, "protocol");
  assert.deepEqual(accepted.test.samples, []);
  assert.equal(accepted.test.ruleId, accepted.rule.id);
  assert.equal(accepted.test.minimumCases, 12);
  assert.equal(accepted.test.primaryHorizon, "t20");
  assert.equal(accepted.validationPackage.confirmedBy, "user");
  assert.equal(accepted.validationPackage.userEdited, false);
  assert.equal(accepted.validationPackage.proposal.evidencePosture, "retrospective_not_ex_ante");
  assert.match(accepted.validationPackage.proposal.caveats.at(-1), /不得冒充、覆盖或回写为事前判断/);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.validationPackages.length, 1);
  assert.equal(snapshot.rules.length, 1);
  assert.equal(snapshot.tests.length, 1);

  const repeated = await store.acceptLearningProposal({
    proposal,
    confirmed: true,
    reviewCycleId: "cycle-1",
    runId: "run-1",
  });
  assert.equal(repeated.validationPackage.id, accepted.validationPackage.id);
  const afterRepeat = await store.snapshot();
  assert.equal(afterRepeat.validationPackages.length, 1);
  assert.equal(afterRepeat.rules.length, 1);
  assert.equal(afterRepeat.tests.length, 1);

  await assert.rejects(
    store.completeTest(accepted.test.id, { outcomeR: 1.25, notes: "未关联观察" }),
    /必须关联一个已完成的复盘周期或案例/,
  );
  await assert.rejects(
    store.completeTest(accepted.test.id, { reviewCycleId: "cycle-1", outcomeR: 1.25 }),
    /来源周期不能同时作为样本外验证/,
  );
  await store.completeTest(accepted.test.id, { reviewCycleId: "cycle-2", outcomeR: 1.25, notes: "第一条观察" });
  await assert.rejects(
    store.completeTest(accepted.test.id, { reviewCycleId: "cycle-2", outcomeR: 2 }),
    /不能覆盖或重复登记/,
  );
  await store.completeTest(accepted.test.id, { reviewCycleId: "cycle-3", outcomeR: -0.5, notes: "第二条观察" });
  const collecting = (await store.snapshot()).tests[0];
  assert.equal(collecting.status, "collecting");
  assert.equal(collecting.completedAt, null);
  assert.equal(collecting.samples.length, 2);
  assert.deepEqual(collecting.samples.map((item) => item.outcomeR), [1.25, -0.5]);
  assert.deepEqual(collecting.samples.map((item) => item.reviewCycleId), ["cycle-2", "cycle-3"]);
  assert.equal(collecting.samples.every((item) => item.outcomeVerified === false), true);
  assert.equal(collecting.samples.every((item) => item.formalEligible === false), true);
  assert.equal(collecting.outcomeR, null);
  const observations = calculateRuleMetrics(await store.snapshot(), accepted.rule.id);
  assert.equal(observations.sampleCount, 2);
  assert.equal(observations.unlinkedObservationCount, 0);
  assert.equal(observations.observationCount, 2);
});

test("learning proposals preserve composite metric and window specs instead of silently coercing them", async () => {
  let id = 0;
  const store = new ReviewStore({
    store: new MemoryStore(),
    now: () => new Date("2026-08-18T06:00:00.000Z"),
    idFactory: () => `spec-${++id}`,
  });
  const sourceProposal = {
    hypothesis: "组合指标需要一起改善",
    evidenceSummary: "仅作为待验证假设",
    testDesign: {
      metric: "T+5 超额收益与 MAE",
      window: "财报后 T+1 至 T+5",
      minCases: 12,
      inclusion: "完整事件路径",
      exclusion: "数据缺失",
      successCriteria: "中位超额收益提高且 MAE 下降",
    },
    candidateRule: {
      title: "组合指标规则",
      action: "等待确认",
      invalidation: "组合指标未改善",
      scope: "财报交易",
    },
    confidence: "medium",
    caveats: [],
  };
  const accepted = await store.acceptLearningProposal({
    confirmed: true,
    reviewCycleId: "cycle-spec",
    runId: "run-spec",
    sourceProposal,
    proposal: {
      ...sourceProposal,
      candidateRule: { ...sourceProposal.candidateRule, action: "等待量价确认" },
    },
  });

  assert.equal(accepted.test.metricSpec, "T+5 超额收益与 MAE");
  assert.equal(accepted.test.windowSpec, "财报后 T+1 至 T+5");
  assert.equal(accepted.test.primaryMetric, null);
  assert.equal(accepted.test.primaryHorizon, null);
  assert.equal(accepted.validationPackage.proposal.testDesign.metric, "T+5 超额收益与 MAE");
  assert.equal(accepted.validationPackage.userEdited, true);
  assert.notEqual(accepted.validationPackage.sourceProposalHash, accepted.validationPackage.proposalHash);
});

test("stopping a validation archives it without deleting its lineage or samples", async () => {
  let id = 0;
  const store = new ReviewStore({
    store: new MemoryStore(),
    now: () => new Date("2026-08-21T08:00:00.000Z"),
    idFactory: () => `archive-${++id}`,
  });
  const accepted = await store.acceptLearningProposal({
    confirmed: true,
    reviewCycleId: "source-cycle",
    runId: "source-run",
    proposal: {
      hypothesis: "只在确认后加仓能改善下行路径",
      evidenceSummary: "回顾性假设",
      testDesign: {
        metric: "net_r",
        window: "T+5",
        minCases: 10,
        inclusion: "同类交易",
        exclusion: "数据不完整",
        successCriteria: "净期望为正",
      },
      candidateRule: {
        title: "确认后加仓",
        action: "等待确认",
        invalidation: "下行路径没有改善",
        scope: "高波动交易",
      },
      confidence: "medium",
      caveats: [],
    },
  });
  await store.completeTest(accepted.test.id, {
    reviewCycleId: "sample-cycle",
    outcomeR: 0.5,
    observationTiming: "historical",
  });

  await assert.rejects(
    store.archiveValidation({ testId: accepted.test.id, confirmed: false }),
    /明确确认/,
  );
  const archived = await store.archiveValidation({
    validationPackageId: accepted.validationPackage.id,
    testId: accepted.test.id,
    ruleId: accepted.rule.id,
    reason: "用户认为观察前提不再成立",
    confirmed: true,
  });
  assert.equal(archived.rule.status, "retired");
  assert.equal(archived.test.status, "retired");
  assert.equal(archived.validationPackage.status, "retired");
  assert.equal(archived.validationPackage.archivedBy, "user");
  assert.equal(archived.test.samples.length, 1);
  assert.equal(archived.ruleReview.archiveOperation, true);

  const snapshot = await store.snapshot();
  assert.equal(snapshot.tests.length, 1);
  assert.equal(snapshot.rules.length, 1);
  assert.equal(snapshot.validationPackages.length, 1);
  assert.equal(snapshot.ruleReviews.length, 1);
  assert.equal(snapshot.tests[0].samples[0].reviewCycleId, "sample-cycle");
  assert.equal(snapshot.tests[0].samples[0].observationTiming, "historical");
  assert.match(snapshot.validationPackages[0].archiveReason, /前提不再成立/);

  const repeated = await store.archiveValidation({ testId: accepted.test.id, confirmed: true });
  assert.equal(repeated.ruleReview, null);
  assert.equal((await store.snapshot()).ruleReviews.length, 1);
});

test("a previously completed multi-case protocol migrates its result into a collecting sample", async () => {
  const repository = new MemoryStore();
  await repository.set("reviewWorkspaceV1", {
    schemaVersion: 1,
    updatedAt: "2026-08-18T06:00:00.000Z",
    cases: [],
    rules: [],
    ruleReviews: [],
    validationPackages: [],
    tests: [{
      id: "old-protocol",
      ruleId: null,
      caseId: null,
      minimumCases: 12,
      primaryMetric: "net_r",
      primaryHorizon: "t5",
      status: "completed",
      registeredAt: "2026-08-17T06:00:00.000Z",
      completedAt: "2026-08-18T06:00:00.000Z",
      outcomeR: 2,
      outcomeSource: "manual",
      outcomeVerified: false,
      censored: false,
    }],
  });
  const store = new ReviewStore({ store: repository });
  const migrated = (await store.snapshot()).tests[0];

  assert.equal(migrated.testKind, "protocol");
  assert.equal(migrated.status, "collecting");
  assert.equal(migrated.completedAt, null);
  assert.equal(migrated.samples.length, 1);
  assert.equal(migrated.samples[0].outcomeR, 2);
});

test("session-only earnings dates conservatively reject same-local-day snapshots as ex-ante", async () => {
  let now = "2026-08-20T14:00:00.000Z";
  let id = 0;
  const store = new ReviewStore({
    store: new MemoryStore(),
    now: () => new Date(now),
    idFactory: () => `id-${++id}`,
  });
  const reviewCase = await store.createCaseFromBrokerRecords({
    symbol: "NVDA.US",
    activityStartAt: "2026-08-10T14:00:00.000Z",
    activityEndAt: "2026-08-10T14:00:00.000Z",
    orderIds: ["o-1"],
    recordIds: ["order:o-1"],
    event: {
      eventCandidateId: "event-1",
      eventAt: "2026-08-20T00:00:00.000Z",
      eventDate: "2026-08-20",
      eventTimePrecision: "session",
      eventSession: "amc",
      timezone: "America/New_York",
      fiscalQuarter: "FY2026 Q2",
    },
    eventAssociation: { status: "matched" },
  });
  await store.updateCase(reviewCase.id, {
    exAnte: {
      myView: "增长超预期",
      marketView: "市场预期高增长",
      plannedAction: "持有",
      invalidation: "指引下修",
      riskBudgetR: 1,
    },
  });
  now = "2026-08-20T15:00:00.000Z";
  const version = await store.freezeCase(reviewCase.id);
  assert.equal(version.eligibleForFormalStats, false);
  assert.equal(version.timing, "retrospective");
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
  const collected = await store.snapshot();
  assert.equal(collected.tests.every((item) => item.status === "collecting"), true);
  assert.equal(collected.tests.every((item) => item.samples.length === 1), true);
  const metrics = calculateRuleMetrics(await store.snapshot(), rule.id);

  assert.equal(metrics.sampleCount, 2);
  assert.equal(metrics.verifiedSampleCount, 0);
  assert.equal(metrics.winRatePercent, 50);
  assert.equal(metrics.expectancyR, 0.5);
  assert.equal(metrics.payoffRatio, 2);
  assert.equal(metrics.breakEvenWinRatePercent, 33.3333);
  assert.equal(metrics.profitFactor, 2);
  assert.equal(metrics.evidenceLabel, "观察性发现 · 含待核验人工结果");
  assert.equal((await store.snapshot()).tests.every((item) => (
    item.samples.every((sample) => sample.outcomeSource === "manual")
  )), true);
});

test("order-first event facts remain immutable while the four human fields can be frozen without optional R", async () => {
  let id = 0;
  const store = new ReviewStore({
    store: new MemoryStore(),
    now: () => new Date("2026-08-01T00:00:00.000Z"),
    idFactory: () => `id-${++id}`,
  });
  const reviewCase = await store.createCaseFromBrokerRecords({
    symbol: "NVDA.US",
    activityStartAt: "2026-07-30T14:00:00.000Z",
    activityEndAt: "2026-07-30T14:01:00.000Z",
    orderIds: ["o-1"],
    recordIds: ["order:o-1"],
    event: {
      eventCandidateId: "event-1",
      eventAt: "2026-08-20T00:00:00.000Z",
      eventDate: "2026-08-20",
      eventTimePrecision: "session",
      eventSession: "amc",
      timezone: "America/New_York",
      fiscalQuarter: "FY2026 Q2",
    },
    eventAssociation: { status: "matched", source: "Longbridge finance_calendar" },
  });
  await store.updateCase(reviewCase.id, {
    symbol: "AAPL.US",
    fiscalQuarter: "FY1999 Q1",
    eventAt: "1999-01-01T00:00:00.000Z",
    eventSession: "bmo",
    exAnte: {
      myView: "增长超预期",
      marketView: "市场预期已高",
      plannedAction: "只在确认后加仓",
      invalidation: "指引下修",
    },
  });
  const version = await store.freezeCase(reviewCase.id);
  const saved = (await store.snapshot()).cases[0];

  assert.equal(saved.symbol, "NVDA.US");
  assert.equal(saved.fiscalQuarter, "FY2026 Q2");
  assert.equal(saved.eventAt, "2026-08-20T00:00:00.000Z");
  assert.equal(saved.eventSession, "amc");
  assert.equal(version.snapshot.exAnte.riskBudgetR, null);
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
  await assert.rejects(
    store.transitionRule(rule.id, { status: "testing", reason: "开始样本外测试" }),
    /至少需要关联一个已登记测试/,
  );
  await store.registerTest({
    ruleId: rule.id,
    primaryMetric: "net_r",
    primaryHorizon: "t5",
    minimumCases: 32,
    successCriteria: "已核验净期望 R 大于 0",
  });
  const testing = await store.transitionRule(rule.id, { status: "testing", reason: "开始样本外测试" });
  assert.equal(testing.status, "testing");
  await assert.rejects(
    store.transitionRule(rule.id, { status: "provisional" }),
    /至少需要 32 个.*核验/,
  );
  const review = await store.addRuleReview(rule.id, {
    decision: "keep",
    evidence: "结果尚稳定",
    nextTrigger: "下个财报季",
  });
  assert.equal(review.decision, "keep");
  const change = await store.addRuleReview(rule.id, {
    decision: "change",
    evidence: "样本定义需要收窄",
    change: "仅纳入流动性充足标的",
    nextTrigger: "生成新版本",
  });
  assert.equal(change.applicationStatus, "proposal_only");
  assert.equal((await store.snapshot()).rules[0].status, "testing");

  const retired = await store.addRuleReview(rule.id, {
    decision: "retire",
    evidence: "适用前提已经消失",
    nextTrigger: "基本面环境重新出现",
  });
  const retiredRule = (await store.snapshot()).rules[0];
  assert.equal(retired.applicationStatus, "applied");
  assert.equal(retiredRule.status, "retired");
  assert.equal(retiredRule.history.at(-1).to, "retired");
});

test("formal promotion is bound to the protocol sample set, declared metric, minimum and verified criteria", async () => {
  let id = 0;
  const repository = new MemoryStore();
  const store = new ReviewStore({
    store: repository,
    now: () => new Date("2026-08-18T06:00:00.000Z"),
    idFactory: () => `formal-${++id}`,
  });
  const cases = [];
  for (let index = 0; index < 20; index += 1) {
    const reviewCase = await store.createCase({
      symbol: `T${index}.US`,
      eventAt: "2026-09-20T20:00:00.000Z",
      exAnte: {
        myView: "判断",
        marketView: "预期",
        plannedAction: "动作",
        invalidation: "失效",
      },
    });
    await store.freezeCase(reviewCase.id);
    cases.push(reviewCase.id);
  }
  const rule = await store.createRule({ title: "正式门槛规则" });
  const protocol = await store.registerTest({
    ruleId: rule.id,
    primaryMetric: "net_r",
    primaryHorizon: "t5",
    minimumCases: 20,
    successCriteria: "已核验净期望 R 大于 0",
  });
  await store.transitionRule(rule.id, { status: "testing" });

  const raw = await repository.get("reviewWorkspaceV1");
  const rawProtocol = raw.tests.find((item) => item.id === protocol.id);
  rawProtocol.status = "completed";
  rawProtocol.samples = cases.map((caseId, index) => ({
    id: `verified-${index}`,
    caseId,
    recordedAt: `2026-08-18T06:00:${String(index).padStart(2, "0")}.000Z`,
    outcomeR: 1,
    benchmarkReturnPercent: 0,
    outcomeSource: "deterministic_fixture",
    outcomeVerified: true,
    notes: null,
    censored: false,
  }));
  await repository.set("reviewWorkspaceV1", raw);

  await assert.rejects(
    store.transitionRule(rule.id, { status: "provisional" }),
    /尚未由确定性引擎.*核验通过/,
  );

  const withEvaluation = await repository.get("reviewWorkspaceV1");
  const evaluated = withEvaluation.tests.find((item) => item.id === protocol.id);
  evaluated.protocolEvaluation = {
    verified: true,
    passed: true,
    primaryMetric: "net_r",
    evaluatedSampleCount: 20,
    sampleSetHash: "wrong-sample-set",
  };
  await repository.set("reviewWorkspaceV1", withEvaluation);
  await assert.rejects(
    store.transitionRule(rule.id, { status: "provisional" }),
    /尚未由确定性引擎.*核验通过/,
  );
  await assert.rejects(
    store.completeTest(protocol.id, { reviewCycleId: "cycle-observation", outcomeR: 0.5, notes: "新到观察" }),
    /先由你决定/,
  );
  const invalidated = (await store.snapshot()).tests.find((item) => item.id === protocol.id);
  assert.equal(invalidated.status, "decision_due");
  assert.equal(invalidated.samples.length, 20);
});

test("validation observation reaches a human decision gate and continue advances an append-only target", async () => {
  let id = 0;
  const store = new ReviewStore({
    store: new MemoryStore(),
    now: () => new Date("2026-08-20T00:00:00.000Z"),
    idFactory: () => `gate-${++id}`,
  });
  const accepted = await store.acceptLearningProposal({
    confirmed: true,
    reviewCycleId: "source-cycle",
    runId: "source-run",
    proposal: {
      hypothesis: "确认后再加仓改善赔率",
      evidenceSummary: "事后复盘形成，等待验证",
      testDesign: {
        metric: "net_r", window: "T+5", minCases: 2,
        inclusion: "同类确认交易", exclusion: "数据缺失", successCriteria: "净期望为正",
      },
      candidateRule: {
        title: "确认后加仓", action: "确认后加仓", invalidation: "赔率不改善", scope: "成长股",
      },
      confidence: "medium", caveats: [],
    },
  });
  await store.completeTest(accepted.test.id, { reviewCycleId: "cycle-a", outcomeR: 1 });
  await store.completeTest(accepted.test.id, { reviewCycleId: "cycle-b", outcomeR: -0.5 });
  let snapshot = await store.snapshot();
  assert.equal(snapshot.tests[0].status, "decision_due");
  assert.equal(calculateRuleMetrics(snapshot, accepted.rule.id).decisionDue, true);
  assert.equal(calculateRuleMetrics(snapshot, accepted.rule.id).progressPercent, 100);

  const review = await store.addRuleReview(accepted.rule.id, {
    decision: "keep",
    evidence: "样本仍少",
    nextTrigger: "下一轮门槛",
  });
  snapshot = await store.snapshot();
  assert.equal(review.applicationStatus, "applied");
  assert.equal(snapshot.tests[0].status, "collecting");
  assert.equal(snapshot.tests[0].decisionRound, 2);
  assert.equal(snapshot.tests[0].decisionSampleTarget, 7);
  assert.equal(snapshot.tests[0].samples.length, 2, "继续观察不得改写既有样本");
});

test("retiring a validation freezes its protocol while v2 rules retain lineage", async () => {
  let id = 0;
  const store = new ReviewStore({
    store: new MemoryStore(),
    now: () => new Date("2026-08-20T00:00:00.000Z"),
    idFactory: () => `lineage-${++id}`,
  });
  const parent = await store.createRule({ title: "v1", condition: "条件", action: "动作" });
  const child = await store.createRule({
    parentRuleId: parent.id,
    title: "v2",
    condition: "新条件",
    action: "新动作",
  });
  assert.equal(child.version, 1);
  assert.equal(child.contentVersion, 2);
  assert.equal(child.parentRuleId, parent.id);
  assert.equal(child.lineageRootRuleId, parent.id);
});

test("a decision-due validation creates v2 atomically without rewriting v1 samples", async () => {
  let id = 0;
  const store = new ReviewStore({
    store: new MemoryStore(),
    now: () => new Date("2026-08-20T00:00:00.000Z"),
    idFactory: () => `v2-${++id}`,
  });
  const accepted = await store.acceptLearningProposal({
    confirmed: true,
    reviewCycleId: "source",
    runId: "run",
    proposal: {
      hypothesis: "旧条件", evidenceSummary: "事后假设",
      testDesign: {
        metric: "net_r", window: "T+5", minCases: 1,
        inclusion: "同类", exclusion: "缺数据", successCriteria: "期望为正",
      },
      candidateRule: { title: "v1", action: "旧动作", invalidation: "旧失效", scope: "成长股" },
      caveats: [],
    },
  });
  await store.completeTest(accepted.test.id, { reviewCycleId: "sample-cycle", outcomeR: -1 });
  const created = await store.createValidationVersion({
    ruleId: accepted.rule.id,
    testId: accepted.test.id,
    title: "v2",
    condition: "新条件",
    action: "新动作",
    falsification: "新失效",
  });
  const snapshot = await store.snapshot();
  const oldTest = snapshot.tests.find((item) => item.id === accepted.test.id);
  assert.equal(created.rule.status, "testing");
  assert.equal(created.rule.contentVersion, 2);
  assert.equal(created.test.status, "collecting");
  assert.deepEqual(created.test.samples, []);
  assert.equal(oldTest.status, "retired");
  assert.equal(oldTest.samples.length, 1);
  assert.equal(snapshot.rules.find((item) => item.id === accepted.rule.id).status, "retired");
  assert.equal(snapshot.ruleReviews[0].applicationStatus, "applied");
});
