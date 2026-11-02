import assert from "node:assert/strict";
import test from "node:test";
import { calculateRuleMetrics, reconcileSampleEvidenceIdentities, ReviewStore } from "../src/data/review-store.mjs";
import { canonicalReviewEvidenceIdentity } from "../src/review/review-learning-source.mjs";

class MemoryStore {
  constructor() { this.values = new Map(); }
  async get(key) { return structuredClone(this.values.get(key)); }
  async set(key, value) { this.values.set(key, structuredClone(value)); }
}

function clock(...values) {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]);
}

function verifiedProtocolSample(reviewCycleId, outcomeR, index = 1) {
  return {
    reviewCycleId,
    canonicalEvidenceIdentity: canonicalReviewEvidenceIdentity({ id: reviewCycleId, brokerLinks: { accountScopeId: "test-account-scope" } }),
    outcomeR,
    benchmarkReturnPercent: 0,
    verification: {
      engine: "deterministic_review_fixture_v1",
      sourceRunId: `run-${index}`,
      sourceEvidenceRevision: index,
      resultHash: index.toString(16).padStart(64, "0"),
      sourceCompletedAt: "2026-08-18T05:59:00.000Z",
    },
  };
}

async function protocolFixtureForIdentityAudit() {
  let id = 0;
  const repository = new MemoryStore();
  const store = new ReviewStore({ store: repository, now: () => new Date("2026-09-01T00:00:00Z"), idFactory: () => `identity-${++id}` });
  const rule = await store.createRule({ title: "独立样本身份验证" });
  const protocol = await store.registerTest({ ruleId: rule.id, primaryMetric: "net_r", minimumCases: 20,
    successCriteria: "净 R > 0", successOperator: "gt", successThreshold: 0 });
  await store.transitionRule(rule.id, { status: "testing" });
  return { repository, store, rule, protocol };
}

function migratedIdentityCycle(id, { sourceCaseId = "original-case", accountScopeId = "test-account-scope", revision = 1 } = {}) {
  return { id, evidenceRevision: revision, brokerLinks: { accountScopeId, evidenceRevision: revision },
    legacySource: { sourceCaseId, accountScopeId, sourceHash: `source-${id}`, migratedAt: "2026-08-01T00:00:00Z" } };
}

function legacyFormalSample(reviewCycleId, index, { caseId = null, recordedAt } = {}) {
  const verified = verifiedProtocolSample(reviewCycleId, 1);
  delete verified.canonicalEvidenceIdentity;
  return { ...verified, id: `old-sample-${index}`, reviewCycleId, caseId, formalEligible: true,
    outcomeVerified: true, observationTiming: "forward", censored: false,
    recordedAt: recordedAt ?? new Date(Date.UTC(2026, 7, 20, 0, index)).toISOString(),
    outcomeSource: verified.verification.engine };
}

test("host sample registration requires a self-consistent identity and rejects migration aliases", async () => {
  const { store, protocol } = await protocolFixtureForIdentityAudit();
  const first = migratedIdentityCycle("migration-one");
  const alias = migratedIdentityCycle("migration-two");
  const cycles = [first, alias];
  const sample = verifiedProtocolSample(first.id, 1);
  await assert.rejects(store.recordVerifiedProtocolSample({ ...sample, testId: protocol.id, canonicalEvidenceIdentity: null }), /原始证据身份/);
  await assert.rejects(store.recordVerifiedProtocolSample({ ...sample, testId: protocol.id,
    canonicalEvidenceIdentity: { ...sample.canonicalEvidenceIdentity, key: "forged" } }), /原始证据身份/);
  await store.recordVerifiedProtocolSample({ ...sample, testId: protocol.id, cycles,
    canonicalEvidenceIdentity: canonicalReviewEvidenceIdentity(first) });
  await assert.rejects(store.recordVerifiedProtocolSample({ ...verifiedProtocolSample(alias.id, 1), testId: protocol.id, cycles,
    canonicalEvidenceIdentity: canonicalReviewEvidenceIdentity(alias) }), /同一原始案例/);
  const saved = (await store.snapshot({ cycles })).tests.find((test) => test.id === protocol.id);
  assert.equal(saved.samples.length, 1);
  assert.equal(saved.samples[0].canonicalEvidenceIdentity.sourceCaseId, "original-case");
  assert.equal(saved.samples[0].formalEligible, true);
});

test("old case plus nineteen migration aliases stay one sample across display, evaluation, and promotion", async () => {
  const { repository, store, protocol, rule } = await protocolFixtureForIdentityAudit();
  const persisted = await repository.get("reviewWorkspaceV1");
  persisted.cases.push({ id: "original-case", createdAt: "2026-08-01T00:00:00Z",
    brokerLinks: { accountScopeId: "test-account-scope", orderIds: ["order-1"], executionIds: [], revision: 1 },
    exAnteVersions: [{ eligibleForFormalStats: true }] });
  const aliases = Array.from({ length: 19 }, (_, index) => migratedIdentityCycle(`migration-${index}`));
  const test = persisted.tests.find((item) => item.id === protocol.id);
  test.samples = [legacyFormalSample(null, 0, { caseId: "original-case" }),
    ...aliases.map((cycle, index) => legacyFormalSample(cycle.id, index + 1))];
  await repository.set("reviewWorkspaceV1", persisted);
  const beforeRead = await repository.get("reviewWorkspaceV1");
  const snapshot = await store.snapshot({ cycles: aliases });
  assert.deepEqual(await repository.get("reviewWorkspaceV1"), beforeRead, "snapshot projection is read-only");
  const projectedTest = snapshot.tests.find((item) => item.id === protocol.id);
  assert.equal(projectedTest.samples.length, 20, "raw observations remain in the ledger");
  assert.equal(new Set(projectedTest.samples.map((sample) => sample.canonicalEvidenceIdentity.key)).size, 1);
  assert.equal(projectedTest.formalUniqueSampleCount, 1);
  assert.equal(projectedTest.formalIdentityMethod, "canonical-review-evidence/v1");
  const metrics = calculateRuleMetrics(snapshot, rule.id);
  assert.equal(metrics.verifiedSampleCount, 1);
  assert.equal(metrics.sampleCount, 1);
  assert.equal(metrics.progressPercent, 5);
  assert.equal(projectedTest.status, "collecting");
  await assert.rejects(store.evaluateProtocol({ testId: protocol.id, cycles: aliases }), /至少需要 20/);
  await assert.rejects(store.transitionRule(rule.id, { status: "provisional", cycles: aliases }), /20.*独立事件样本/);
  assert.deepEqual(await repository.get("reviewWorkspaceV1"), beforeRead, "failed mutations do not commit projections");
});

test("unresolvable old sample identities remain visible but never acquire formal eligibility", async () => {
  const { repository, store, protocol, rule } = await protocolFixtureForIdentityAudit();
  const persisted = await repository.get("reviewWorkspaceV1");
  const test = persisted.tests.find((item) => item.id === protocol.id);
  test.samples = [legacyFormalSample("missing-cycle", 1), legacyFormalSample("changed-cycle", 2)];
  await repository.set("reviewWorkspaceV1", persisted);
  const cycles = [migratedIdentityCycle("changed-cycle", { revision: 2 })];
  const snapshot = await store.snapshot({ cycles });
  const projected = snapshot.tests[0];
  assert.equal(projected.samples[0].evidenceIdentityReason, "sample_source_cycle_missing");
  assert.equal(projected.samples[1].evidenceIdentityReason, "sample_evidence_revision_not_current");
  assert.ok(projected.samples.every((sample) => sample.formalEligible === false && sample.outcomeR === 1));
  assert.equal(calculateRuleMetrics(snapshot, rule.id).verifiedSampleCount, 0);
  assert.equal(projected.protocolEvaluation, null);
});

test("canonical conflicts invalidate old protocol evaluations and cannot reuse the former sample-set hash", async () => {
  const { store, protocol, rule } = await protocolFixtureForIdentityAudit();
  for (let index = 1; index <= 20; index += 1) await store.recordVerifiedProtocolSample({
    testId: protocol.id, ...verifiedProtocolSample(`cycle-${index}`, 1, index),
  });
  const evaluation = await store.evaluateProtocol({ testId: protocol.id });
  assert.equal(evaluation.protocolEvaluation.engine, "deterministic_review_protocol_v3_canonical");
  const cycles = Array.from({ length: 20 }, (_, index) => ({ id: `cycle-${index + 1}`, evidenceRevision: index + 1,
    brokerLinks: { accountScopeId: "test-account-scope" } }));
  cycles[0].legacySource = migratedIdentityCycle(cycles[0].id).legacySource;
  const projected = await store.snapshot({ cycles });
  assert.equal(projected.tests[0].samples[0].evidenceIdentityStatus, "conflict");
  assert.equal(projected.tests[0].protocolEvaluation, null);
  assert.equal(calculateRuleMetrics(projected, rule.id).verifiedSampleCount, 19);
  await assert.rejects(store.evaluateProtocol({ testId: protocol.id, cycles }), /至少需要 20/);
});

test("ambiguous same-source observations are excluded deterministically and hypothesis aliases never count", () => {
  const cycles = [migratedIdentityCycle("one"), migratedIdentityCycle("two")];
  const raw = { schemaVersion: 1, cases: [], rules: [{ id: "rule" }], tests: [{ id: "test", ruleId: "rule", testKind: "protocol",
    minimumCases: 20, primaryMetric: "net_r", successOperator: "gt", successThreshold: 0,
    samples: [legacyFormalSample("one", 1, { recordedAt: "2026-08-20T00:00:00Z" }),
      legacyFormalSample("two", 2, { recordedAt: "2026-08-20T00:00:00Z" })],
  }] };
  const projected = reconcileSampleEvidenceIdentities(raw, { cycles });
  assert.equal(calculateRuleMetrics(projected, "rule").verifiedSampleCount, 0);
  assert.equal(calculateRuleMetrics(projected, "rule").sampleCount, 0);
  raw.tests[0].sourceReviewCycleId = "one";
  const sourceBound = reconcileSampleEvidenceIdentities(raw, { cycles });
  assert.ok(sourceBound.tests[0].samples.every((sample) => sample.evidenceIdentityReason === "same_evidence_as_hypothesis_source"));
  assert.ok(sourceBound.tests[0].samples.every((sample) => sample.formalEligible === false));
  delete raw.tests[0].sourceReviewCycleId;
  raw.tests[0].sourceCaseId = "original-case";
  const legacySourceBound = reconcileSampleEvidenceIdentities(raw, { cycles });
  assert.ok(legacySourceBound.tests[0].samples.every((sample) => sample.evidenceIdentityReason === "same_evidence_as_hypothesis_source"));
});

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
    accountScopeId: "scope-primary",
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
  assert.equal(reviewCase.brokerLinks.accountScopeId, "scope-primary");
  assert.deepEqual(reviewCase.brokerLinkVersions, [{
    revision: 1,
    accountScopeId: "scope-primary",
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
    accountScopeId: "scope-primary",
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
    accountScopeId: "scope-primary",
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
    accountScopeId: "scope-primary",
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
    store.replaceBrokerRecords(reviewCase.id, { accountScopeId: "scope-primary", orderIds: [], executionIds: [] }),
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
    accountScopeId: "scope-primary",
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
      metric: "expectancy_r",
      window: "T+20",
      minCases: 12,
      inclusion: "同类突破回踩交易",
      exclusion: "停牌或数据不完整",
      successCriteria: "中位 MAE 改善至少 0.2R",
      successOperator: "gt",
      successThreshold: 0,
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
  assert.equal(accepted.test.decisionSampleTarget, 20);
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
  await store.completeTest(accepted.test.id, {
    reviewCycleId: "cycle-2",
    outcomeR: 1.25,
    notes: "第一条观察",
    technicalValidationRef: {
      status: "complete",
      sampleStatus: "available",
      sampleId: "technical-validation-sample:cycle-2",
      resultHash: "a".repeat(64),
      ruleKey: "technical-state:cycle-2",
      radarTradingDate: "2026-08-15",
      radarRecordedAt: "2026-08-15T21:01:00.000Z",
      entryCutoffAt: "2026-08-16T14:30:00.000Z",
      exitAt: "2026-08-17T19:30:00.000Z",
      protocolTiming: "forward",
      validationMode: "walk_forward_candidate",
      eligibleForFormalStatistics: true,
      formalEligibilityReason: "候选仍需确定性协议核验",
    },
  });
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
  assert.equal(collecting.samples[0].technicalValidationRef.sampleStatus, "available");
  assert.equal(collecting.samples[0].technicalValidationRef.validationMode, "walk_forward_candidate");
  assert.equal(collecting.samples[0].technicalValidationRef.eligibleForFormalStatistics, false);
  assert.equal(collecting.samples[1].technicalValidationRef, null);
  assert.equal(collecting.outcomeR, null);
  const observations = calculateRuleMetrics(await store.snapshot(), accepted.rule.id);
  assert.equal(observations.sampleCount, 2);
  assert.equal(observations.unlinkedObservationCount, 0);
  assert.equal(observations.observationCount, 2);
});

test("learning proposals reject unsupported composite metrics instead of silently coercing them", async () => {
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
      successOperator: "gt",
      successThreshold: 0,
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
  await assert.rejects(store.acceptLearningProposal({
    confirmed: true,
    reviewCycleId: "cycle-spec",
    runId: "run-spec",
    sourceProposal,
    proposal: sourceProposal,
  }), /测试口径/);
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
        successOperator: "gt",
        successThreshold: 0,
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

test("persisted renderer-like flags cannot forge a formal forward sample", async () => {
  const repository = new MemoryStore();
  await repository.set("reviewWorkspaceV1", {
    schemaVersion: 1,
    updatedAt: "2026-08-18T06:00:00.000Z",
    cases: [],
    rules: [{ id: "rule-1", status: "testing" }],
    ruleReviews: [],
    validationPackages: [],
    tests: [{
      id: "protocol-1",
      testKind: "protocol",
      ruleId: "rule-1",
      minimumCases: 1,
      decisionSampleTarget: 1,
      primaryMetric: "net_r",
      status: "decision_due",
      registeredAt: "2026-08-18T05:00:00.000Z",
      samples: [{
        id: "forged",
        reviewCycleId: "cycle-forged",
        formalEligible: true,
        outcomeVerified: true,
        observationTiming: "forward",
        outcomeSource: "renderer_claim",
        outcomeR: 9,
        recordedAt: "2026-08-18T06:00:00.000Z",
      }],
    }],
  });
  const store = new ReviewStore({ store: repository });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.tests[0].samples[0].formalEligible, false);
  assert.equal(snapshot.tests[0].samples[0].outcomeVerified, false);
  assert.equal(snapshot.tests[0].status, "collecting");
  assert.equal(calculateRuleMetrics(snapshot, "rule-1").progressPercent, 0);
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
    accountScopeId: "scope-primary",
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
    accountScopeId: "scope-primary",
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
  const rule = await store.createRule({ title: "正式门槛规则" });
  const protocol = await store.registerTest({
    ruleId: rule.id,
    primaryMetric: "net_r",
    primaryHorizon: "t5",
    minimumCases: 20,
    successCriteria: "已核验净期望 R 大于 0",
    successOperator: "gt",
    successThreshold: 0,
  });
  await store.transitionRule(rule.id, { status: "testing" });

  for (let index = 1; index <= 20; index += 1) {
    await store.recordVerifiedProtocolSample({
      testId: protocol.id,
      ...verifiedProtocolSample(`cycle-${index}`, 1, index),
    });
  }

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
  const committed = await store.evaluateProtocol({ testId: protocol.id, passed: false });
  assert.equal(committed.status, "decision_due");
  assert.equal(committed.protocolEvaluation.evaluatedSampleCount, 20);
  assert.equal(committed.protocolEvaluation.observedValue, 20);
  assert.equal(committed.protocolEvaluation.passed, true, "caller-supplied verdict is ignored");
  assert.match(committed.protocolEvaluation.resultHash, /^[a-f0-9]{64}$/);
  const promoted = await store.transitionRule(rule.id, { status: "provisional" });
  assert.equal(promoted.status, "provisional");
  const invalidated = (await store.snapshot()).tests.find((item) => item.id === protocol.id);
  assert.equal(invalidated.status, "decision_due");
  assert.equal(invalidated.samples.length, 20);
});

test("host evaluation computes the four supported metrics and win rate uses percent units", async () => {
  const fixtures = [
    { metric: "net_r", expected: 5, operator: "gte", threshold: 5 },
    { metric: "expectancy_r", expected: 0.25, operator: "gt", threshold: 0 },
    { metric: "win_rate", expected: 50, operator: "gte", threshold: 50 },
    { metric: "payoff_ratio", expected: 2, operator: "gte", threshold: 2 },
  ];
  for (const fixture of fixtures) {
    let id = 0;
    const store = new ReviewStore({
      store: new MemoryStore(),
      now: () => new Date("2026-08-18T06:00:00.000Z"),
      idFactory: () => `${fixture.metric}-${++id}`,
    });
    const protocol = await store.registerTest({
      primaryMetric: fixture.metric,
      minimumCases: 2,
      successCriteria: "机器可读门槛",
      successOperator: fixture.operator,
      successThreshold: fixture.threshold,
    });
    for (let index = 1; index <= 20; index += 1) {
      await store.recordVerifiedProtocolSample({
        testId: protocol.id,
        ...verifiedProtocolSample(`cycle-${index}`, index % 2 ? 1 : -0.5, index),
      });
    }
    const evaluated = await store.evaluateProtocol({ testId: protocol.id, passed: false });
    assert.equal(evaluated.protocolEvaluation.observedValue, fixture.expected);
    assert.equal(evaluated.protocolEvaluation.passed, true);
    assert.equal(evaluated.protocolEvaluation.minimumRequired, 20);
    assert.match(evaluated.protocolEvaluation.protocolSpecHash, /^[a-f0-9]{64}$/);
    assert.match(evaluated.protocolEvaluation.sampleSetHash, /^[a-f0-9]{64}$/);
    assert.match(evaluated.protocolEvaluation.resultHash, /^[a-f0-9]{64}$/);
  }
});

test("legacy protocols without a machine threshold stay locked but can be superseded by a valid v2", async () => {
  let id = 0;
  const store = new ReviewStore({
    store: new MemoryStore(),
    now: () => new Date("2026-08-18T06:00:00.000Z"),
    idFactory: () => `legacy-v2-${++id}`,
  });
  const rule = await store.createRule({
    title: "旧规则",
    condition: "旧条件",
    action: "旧动作",
    falsification: "旧失效",
  });
  const protocol = await store.registerTest({
    ruleId: rule.id,
    primaryMetric: "mae_r",
    successCriteria: "旧自然语言标准",
  });
  await store.transitionRule(rule.id, { status: "testing" });
  await assert.rejects(store.evaluateProtocol({ testId: protocol.id }), /创建 v2/);
  const created = await store.createValidationVersion({
    ruleId: rule.id,
    testId: protocol.id,
    primaryMetric: "win_rate",
    successOperator: "gte",
    successThreshold: 55,
    successCriteria: "胜率至少 55%",
    minimumCases: 30,
  });
  assert.equal(created.test.primaryMetric, "win_rate");
  assert.equal(created.test.successOperator, "gte");
  assert.equal(created.test.successThreshold, 55);
  assert.equal(created.test.decisionSampleTarget, 30);
  assert.equal((await store.snapshot()).tests.find((item) => item.id === protocol.id).status, "retired");
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
        successOperator: "gt", successThreshold: 0,
      },
      candidateRule: {
        title: "确认后加仓", action: "确认后加仓", invalidation: "赔率不改善", scope: "成长股",
      },
      confidence: "medium", caveats: [],
    },
  });
  await store.completeTest(accepted.test.id, { reviewCycleId: "calibration-a", outcomeR: 1, observationTiming: "historical" });
  let snapshot = await store.snapshot();
  assert.equal(snapshot.tests[0].status, "collecting");
  assert.equal(calculateRuleMetrics(snapshot, accepted.rule.id).progressPercent, 0);
  for (let index = 1; index <= 20; index += 1) {
    await store.recordVerifiedProtocolSample({
      testId: accepted.test.id,
      ...verifiedProtocolSample(`cycle-${index}`, index === 20 ? -0.5 : 1, index),
    });
  }
  snapshot = await store.snapshot();
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
  assert.equal(snapshot.tests[0].decisionSampleTarget, 30);
  assert.equal(snapshot.tests[0].samples.length, 21, "继续观察不得改写既有样本");
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
        successOperator: "gt", successThreshold: 0,
      },
      candidateRule: { title: "v1", action: "旧动作", invalidation: "旧失效", scope: "成长股" },
      caveats: [],
    },
  });
  for (let index = 1; index <= 20; index += 1) {
    await store.recordVerifiedProtocolSample({
      testId: accepted.test.id,
      ...verifiedProtocolSample(`sample-cycle-${index}`, index === 20 ? -1 : 1, index),
    });
  }
  const created = await store.createValidationVersion({
    ruleId: accepted.rule.id,
    testId: accepted.test.id,
    title: "v2",
    condition: "新条件",
    action: "新动作",
    falsification: "新失效",
    primaryMetric: "expectancy_r",
    successOperator: "gt",
    successThreshold: 0,
    successCriteria: "平均期望 R 大于 0",
    minimumCases: 20,
  });
  const snapshot = await store.snapshot();
  const oldTest = snapshot.tests.find((item) => item.id === accepted.test.id);
  assert.equal(created.rule.status, "testing");
  assert.equal(created.rule.contentVersion, 2);
  assert.equal(created.test.status, "collecting");
  assert.deepEqual(created.test.samples, []);
  assert.equal(oldTest.status, "retired");
  assert.equal(oldTest.samples.length, 20);
  assert.equal(snapshot.rules.find((item) => item.id === accepted.rule.id).status, "retired");
  assert.equal(snapshot.ruleReviews[0].applicationStatus, "applied");
});
