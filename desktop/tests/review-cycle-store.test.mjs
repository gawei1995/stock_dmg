import assert from "node:assert/strict";
import test from "node:test";
import { ReviewCycleStore, REVIEW_CYCLE_TYPES } from "../src/data/review-cycle-store.mjs";

const STORE_KEY = "reviewCyclesV1";

class MemoryStore {
  constructor(seed) {
    this.values = new Map(seed === undefined ? [] : [[STORE_KEY, structuredClone(seed)]]);
  }
  async get(key) { return structuredClone(this.values.get(key)); }
  async set(key, value) { this.values.set(key, structuredClone(value)); }
}

class DelayedStore extends MemoryStore {
  constructor(delayMs = 4) {
    super();
    this.delayMs = delayMs;
    this.activeReads = 0;
    this.maxConcurrentReads = 0;
  }
  async get(key) {
    this.activeReads += 1;
    this.maxConcurrentReads = Math.max(this.maxConcurrentReads, this.activeReads);
    const value = await super.get(key);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.activeReads -= 1;
    return value;
  }
  async set(key, value) {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return super.set(key, value);
  }
}

function harness(initialNow = "2026-08-01T00:00:00.000Z", repository = new MemoryStore()) {
  let now = initialNow;
  let id = 0;
  const store = new ReviewCycleStore({
    store: repository,
    now: () => new Date(now),
    idFactory: () => `id-${++id}`,
  });
  return { store, repository, setNow: (value) => { now = value; } };
}

function completeExAnte(extra = {}) {
  return {
    myView: "我的判断",
    marketView: "市场当前预期",
    plannedAction: "按计划执行",
    invalidation: "核心假设失效",
    fundamentalView: "基本面证据",
    technicalView: "技术结构证据",
    ...extra,
  };
}

async function catalystCycle(store, extra = {}) {
  return store.create({
    type: "catalyst",
    symbols: ["nvda.us"],
    benchmark: "qqq.us",
    startAt: "2026-08-01T00:00:00.000Z",
    catalystAt: "2026-08-20T20:00:00.000Z",
    endAt: "2026-08-31T23:59:59.999Z",
    exAnte: completeExAnte(),
    ...extra,
  });
}

test("the public contract declares the rigorous and order-first cycle types", () => {
  assert.deepEqual(REVIEW_CYCLE_TYPES, ["catalyst", "position_lifecycle", "monthly_portfolio", "trade_window"]);
});

test("creates normalized catalyst, position lifecycle, and monthly portfolio samples", async () => {
  const { store } = harness();
  const catalyst = await catalystCycle(store);
  const position = await store.createCycle({
    cycleType: "position_lifecycle",
    symbol: "aapl.us",
    startAt: "2026-08-02T14:30:00Z",
    startCondition: "首次建仓",
    endCondition: "清仓或逻辑失效",
  });
  const monthly = await store.create({
    type: "monthly_portfolio",
    symbols: ["msft.us", "GOOG.US"],
    startAt: "2026-08-01T00:00:00Z",
  });

  assert.equal(catalyst.type, "catalyst");
  assert.equal(catalyst.scope, "single_symbol");
  assert.deepEqual(catalyst.symbols, ["NVDA.US"]);
  assert.equal(catalyst.benchmark, "QQQ.US");
  assert.equal(position.scope, "single_symbol");
  assert.equal(position.endAt, null);
  assert.equal(position.startCondition, "首次建仓");
  assert.equal(position.endCondition, "清仓或逻辑失效");
  assert.equal(monthly.scope, "portfolio");
  assert.equal(monthly.month, "2026-08");
  assert.equal(monthly.timezone, "Asia/Shanghai");
  assert.equal(monthly.endAt, "2026-08-31T15:59:59.999Z");
  assert.equal((await store.snapshot()).cycles.length, 3);
});

test("monthly boundaries and labels follow the declared timezone across UTC and year edges", async () => {
  const { store } = harness();
  const august = await store.create({
    type: "monthly_portfolio",
    month: "2026-08",
    startAt: "2026-07-31T16:00:00.000Z",
    timezone: "Asia/Shanghai",
  });
  assert.equal(august.month, "2026-08");
  assert.equal(august.startAt, "2026-07-31T16:00:00.000Z");
  assert.equal(august.endAt, "2026-08-31T15:59:59.999Z");
  assert.match(august.title, /^2026-08 /);

  const december = await store.create({
    type: "monthly_portfolio",
    month: "2026-12",
    startAt: "2026-11-30T16:00:00.000Z",
    timezone: "Asia/Shanghai",
  });
  assert.equal(december.endAt, "2026-12-31T15:59:59.999Z");

  await assert.rejects(store.create({
    type: "monthly_portfolio",
    month: "2026-07",
    startAt: "2026-07-31T16:00:00.000Z",
    timezone: "Asia/Shanghai",
  }), /声明时区一致/);
});

test("rejects invalid cycle-specific ranges and symbol cardinality", async () => {
  const { store } = harness();
  await assert.rejects(store.create({
    type: "catalyst",
    symbols: ["NVDA.US"],
    startAt: "2026-08-01Z",
    endAt: "2026-08-31Z",
  }), /catalystAt/);
  await assert.rejects(store.create({
    type: "position_lifecycle",
    symbols: ["AAPL.US", "MSFT.US"],
    startAt: "2026-08-01Z",
  }), /只能包含一个标的/);
  await assert.rejects(store.create({
    type: "monthly_portfolio",
    startAt: "2026-08-31Z",
    endAt: "2026-08-01Z",
  }), /结束时间不能早于/);
  await assert.rejects(store.create({
    type: "unknown",
    startAt: "2026-08-01Z",
  }), /类型无效/);
});

test("update aliases replace existing canonical plan fields and event timestamps", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store);
  setNow("2026-08-02T00:00:00Z");
  await store.update(cycle.id, {
    exAnte: {
      thesis: "别名替换后的判断",
      marketExpectation: "别名替换后的市场预期",
      action: "别名替换后的动作",
      fundamental: "别名基本面",
      technical: "别名技术面",
    },
  });
  setNow("2026-08-03T00:00:00Z");
  const updated = await store.update(cycle.id, { eventAt: "2026-08-21T20:00:00Z" });
  assert.equal(updated.exAnteDraft.myView, "别名替换后的判断");
  assert.equal(updated.exAnteDraft.marketView, "别名替换后的市场预期");
  assert.equal(updated.exAnteDraft.plannedAction, "别名替换后的动作");
  assert.equal(updated.exAnteDraft.fundamentalView, "别名基本面");
  assert.equal(updated.exAnteDraft.technicalView, "别名技术面");
  assert.equal(updated.catalystAt, "2026-08-21T20:00:00.000Z");
  assert.equal(updated.exAnteUpdatedAt, "2026-08-03T00:00:00.000Z");
});

test("catalyst versions sealed before the event are full ex-ante, hashed, and detached", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store);
  setNow("2026-08-10T12:00:00.000Z");
  const version = await store.sealCycle({ cycleId: cycle.id, reason: "事前封存" });
  version.snapshot.exAnte.myView = "尝试篡改返回值";
  const saved = (await store.snapshot()).cycles[0].exAnteVersions[0];

  assert.equal(saved.timing, "ex_ante");
  assert.equal(saved.formalEligibility, "full");
  assert.equal(saved.eligibleForFormalStats, true);
  assert.equal(saved.formalEligibilityDeadlineAt, "2026-08-20T20:00:00.000Z");
  assert.equal(saved.knowledgeCutoffAt, "2026-08-10T12:00:00.000Z");
  assert.match(saved.hash, /^[a-f0-9]{64}$/);
  assert.equal(saved.snapshot.exAnte.myView, "我的判断");
});

test("a catalyst version sealed at or after catalystAt is retrospective and never formal", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store);
  setNow("2026-08-20T20:00:00.000Z");
  const version = await store.seal(cycle.id);
  assert.equal(version.timing, "retrospective");
  assert.equal(version.formalEligibility, "ineligible");
  assert.equal(version.eligibleForFormalStats, false);
  assert.match(version.coverageLimitation, /催化剂时点之后/);
});

test("a position plan sealed after the known first-position time is retrospective", async () => {
  const { store } = harness("2026-08-03T00:00:00.000Z");
  const cycle = await store.create({
    type: "position_lifecycle",
    symbols: ["MU.US"],
    startAt: "2026-08-02T14:30:00.000Z",
    exAnte: completeExAnte(),
  });
  const version = await store.seal(cycle.id);
  assert.equal(version.timing, "retrospective");
  assert.equal(version.eligibleForFormalStats, false);
  assert.match(version.coverageLimitation, /首次建仓/);
});

test("a monthly plan sealed mid-month is partial ex-ante with an explicit eligibleFromAt", async () => {
  const { store } = harness("2026-08-15T06:00:00.000Z");
  const cycle = await store.create({
    type: "monthly_portfolio",
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-31T23:59:59.999Z",
    exAnte: completeExAnte(),
  });
  const version = await store.seal(cycle.id);
  assert.equal(version.timing, "partial_ex_ante");
  assert.equal(version.formalEligibility, "partial");
  assert.equal(version.eligibleForFormalStats, true);
  assert.equal(version.eligibleFromAt, "2026-08-15T06:00:00.000Z");
  assert.match(version.coverageLimitation, /此前动作属于已知历史/);
});

test("a monthly plan sealed before month start is full ex-ante; one sealed after month end is retrospective", async () => {
  const fullHarness = harness("2026-07-31T20:00:00.000Z");
  const fullCycle = await fullHarness.store.create({
    type: "monthly_portfolio",
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-31T23:59:59.999Z",
    exAnte: completeExAnte(),
  });
  assert.equal((await fullHarness.store.seal(fullCycle.id)).formalEligibility, "full");

  const lateHarness = harness("2026-09-01T00:00:00.000Z");
  const lateCycle = await lateHarness.store.create({
    type: "monthly_portfolio",
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-31T23:59:59.999Z",
    exAnte: completeExAnte(),
  });
  assert.equal((await lateHarness.store.seal(lateCycle.id)).timing, "retrospective");
});

test("missing minimum human fields can be sealed but are excluded from formal statistics", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store, { exAnte: { myView: "只有一句判断" } });
  setNow("2026-08-10T00:00:00Z");
  const version = await store.seal(cycle.id);
  assert.equal(version.timing, "ex_ante");
  assert.equal(version.eligibleForFormalStats, false);
  assert.match(version.eligibilityReasons.join(" "), /missing_core_fields/);
});

test("knowledgeCutoffAt is auditable, may be earlier, and can never claim future knowledge", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store);
  setNow("2026-08-10T00:00:00Z");
  const version = await store.seal(cycle.id, { knowledgeCutoffAt: "2026-08-09T00:00:00Z" });
  assert.equal(version.knowledgeCutoffAt, "2026-08-09T00:00:00.000Z");
  await assert.rejects(
    store.seal(cycle.id, { knowledgeCutoffAt: "2026-08-11T00:00:00Z" }),
    /不能晚于实际封存时间/,
  );
  await assert.rejects(
    store.seal(cycle.id, { knowledgeCutoffAt: "not-a-date" }),
    /knowledgeCutoffAt 无效/,
  );
});

test("a backdated cutoff cannot contain plan text or metadata authored later", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store);
  setNow("2026-08-09T00:00:00Z");
  await store.update(cycle.id, {
    title: "8 月 9 日才形成的标题",
    exAnte: { myView: "8 月 9 日才形成的判断" },
  });
  setNow("2026-08-10T00:00:00Z");
  await assert.rejects(
    store.seal(cycle.id, { knowledgeCutoffAt: "2026-08-05T00:00:00Z" }),
    /不能早于事前四字段最后编辑时间/,
  );
  const sealed = await store.seal(cycle.id, {
    knowledgeCutoffAt: "2026-08-09T00:00:00Z",
    reason: "封存时才写下、不得泄漏到盲态的说明",
  });
  assert.equal(sealed.exAnteUpdatedAt, "2026-08-09T00:00:00.000Z");
  const blind = await store.snapshot({ cycleId: cycle.id, phase: "blind" });
  assert.equal(blind.cycles[0].exAnteVersions[0].reason, null);
  assert.doesNotMatch(JSON.stringify(blind), /不得泄漏到盲态/);
});

test("sealing excludes untimed and future-dated evidence from the immutable version", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store, {
    exAnte: completeExAnte({
      evidence: [
        { id: "past", observedAt: "2026-08-08T00:00:00Z", summary: "已知证据" },
        { id: "future", observedAt: "2026-08-11T00:00:00Z", summary: "未来证据" },
        { id: "untimed", summary: "没有时间" },
      ],
    }),
  });
  setNow("2026-08-10T00:00:00Z");
  const version = await store.seal(cycle.id);
  assert.deepEqual(version.snapshot.exAnte.evidence.map((item) => item.id), ["past"]);
  assert.equal(version.excludedEvidenceCount, 2);
  assert.match(version.coverageLimitation, /2 条无时间或不早于/);
});

test("decision checkpoints are append-only, chronologically sorted, and returned as detached objects", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store);
  setNow("2026-08-05T12:00:00Z");
  const later = await store.addCycleCheckpoint({
    cycleId: cycle.id,
    checkpoint: { at: "2026-08-05T10:00:00Z", kind: "position_change", action: "加仓", note: "确认" },
  });
  setNow("2026-08-04T12:00:00Z");
  await store.addCheckpoint(cycle.id, { at: "2026-08-04T10:00:00Z", kind: "technical_signal", note: "突破" });
  later.action = "篡改";
  const saved = (await store.snapshot()).cycles[0].checkpoints;
  assert.deepEqual(saved.map((item) => item.occurredAt.slice(0, 10)), ["2026-08-04", "2026-08-05"]);
  assert.equal(saved[1].action, "加仓");
  assert.match(saved[1].hash, /^[a-f0-9]{64}$/);
  assert.equal(saved[1].integrityStatus, "valid");
});

test("the blind snapshot strictly excludes future, same-cutoff, and retrospectively backfilled checkpoints and evidence", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store);
  setNow("2026-08-08T00:00:00Z");
  await store.addCheckpoint(cycle.id, {
    at: "2026-08-07T00:00:00Z",
    kind: "thesis_update",
    note: "事前检查点",
    evidence: [
      { id: "known", at: "2026-08-06T00:00:00Z", summary: "截止前" },
      { id: "future", at: "2026-08-11T00:00:00Z", summary: "截止后" },
    ],
  });
  setNow("2026-08-10T00:00:00Z");
  const version = await store.seal(cycle.id);
  await store.addCheckpoint(cycle.id, { at: "2026-08-10T00:00:00Z", note: "恰好截止点" });
  setNow("2026-08-12T00:00:00Z");
  await store.addCheckpoint(cycle.id, { at: "2026-08-05T00:00:00Z", note: "事后回填" });
  await store.addCheckpoint(cycle.id, { at: "2026-08-11T00:00:00Z", note: "未来动作" });

  const blind = await store.snapshot({ cycleId: cycle.id, phase: "blind", exAnteVersion: version.version });
  const view = blind.cycles[0];
  assert.equal(view.knowledgeCutoffAt, "2026-08-10T00:00:00.000Z");
  assert.deepEqual(view.checkpoints.map((item) => item.note), ["事前检查点"]);
  assert.deepEqual(view.checkpoints[0].evidence.map((item) => item.id), ["known"]);
  assert.equal(view.exAnteDraft, null);
  assert.deepEqual(view.phaseRuns, { blind: [], outcome: [] });
});

test("blind decisionTimeline exposes each immutable action only at its own cutoff", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store);
  setNow("2026-08-02T00:00:00Z");
  await store.seal(cycle.id);
  await store.linkBrokerRecords(cycle.id, {
    records: [{ recordId: "order:before-plan", kind: "order", occurredAt: "2026-08-01T12:00:00Z" }],
  });
  setNow("2026-08-05T00:00:00Z");
  await store.addCheckpoint(cycle.id, {
    at: "2026-08-05T00:00:00Z",
    action: "第一次减仓",
    note: "第一节点不应知道第二次动作",
    evidence: [
      { id: "first-safe", observedAt: "2026-08-04T23:59:59Z", summary: "第一节点已知" },
      { id: "first-equal", observedAt: "2026-08-05T00:00:00Z", summary: "同刻证据不可见" },
    ],
  });
  await store.linkBrokerRecords(cycle.id, {
    records: [{ recordId: "execution:between-1", kind: "execution", occurredAt: "2026-08-04T00:00:00Z" }],
  });
  setNow("2026-08-08T00:00:00Z");
  await store.addCheckpoint(cycle.id, {
    at: "2026-08-08T00:00:00Z",
    action: "第二次减仓",
    note: "只在第二节点出现",
  });
  await store.linkBrokerRecords(cycle.id, {
    records: [
      { recordId: "order:between-2", kind: "order", occurredAt: "2026-08-07T00:00:00Z" },
      { recordId: "order:after-all", kind: "order", occurredAt: "2026-08-09T00:00:00Z" },
    ],
  });

  const blind = (await store.snapshot({ cycleId: cycle.id, phase: "blind" })).cycles[0];
  assert.deepEqual(blind.checkpoints, []);
  assert.deepEqual(blind.decisionTimeline.map((node) => node.nodeType), [
    "initial_plan",
    "decision_checkpoint",
    "decision_checkpoint",
  ]);
  const [initial, first, second] = blind.decisionTimeline;
  assert.deepEqual(initial.brokerFactsIntroduced.recordIds, ["order:before-plan"]);
  assert.deepEqual(first.brokerFactsIntroduced.recordIds, ["execution:between-1"]);
  assert.deepEqual(second.brokerFactsIntroduced.recordIds, ["order:between-2"]);
  assert.equal(first.action, "第一次减仓");
  assert.equal(second.action, "第二次减仓");
  assert.deepEqual(first.evidence.map((item) => item.id), ["first-safe"]);
  assert.doesNotMatch(JSON.stringify(initial), /第一次减仓|第二次减仓|只在第二节点出现/);
  assert.doesNotMatch(JSON.stringify(first), /第二次减仓|只在第二节点出现/);
  assert.doesNotMatch(JSON.stringify(blind.decisionTimeline), /after-all/);
  assert.match(blind.decisionTimelineHash, /^[a-f0-9]{64}$/);
  assert.equal(blind.decisionTimeline.every((node) => node.integrityStatus === "valid"), true);
});

test("late-synced facts before a checkpoint cutoff invalidate its prior blind timeline run", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store);
  setNow("2026-08-02T00:00:00Z");
  await store.seal(cycle.id);
  setNow("2026-08-08T00:00:00Z");
  await store.addCheckpoint(cycle.id, { at: "2026-08-08T00:00:00Z", action: "检查仓位" });
  const blindRun = await store.recordPhaseRun({ cycleId: cycle.id, phase: "blind", result: "旧时间线" });
  setNow("2026-08-10T00:00:00Z");
  await store.linkBrokerRecords(cycle.id, {
    records: [{ recordId: "execution:late-for-node", kind: "execution", occurredAt: "2026-08-07T00:00:00Z" }],
  });
  setNow("2026-09-01T00:00:00Z");
  await assert.rejects(
    store.recordPhaseRun({ cycleId: cycle.id, phase: "outcome", blindRunId: blindRun.id }),
    /必须引用.*已完成的盲态/,
  );
  const refreshed = await store.recordPhaseRun({ cycleId: cycle.id, phase: "blind", result: "刷新时间线" });
  const outcome = await store.recordPhaseRun({
    cycleId: cycle.id,
    phase: "outcome",
    blindRunId: refreshed.id,
    result: "可进入结果阶段",
  });
  assert.equal(outcome.blindRunId, refreshed.id);
});

test("blind broker evidence uses trusted occurrence time while retaining late link time only as provenance", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store);
  setNow("2026-08-08T00:00:00Z");
  await store.linkCycleRecords({
    cycleId: cycle.id,
    recordIds: ["other:untimed"],
    records: [
      { id: "order-before", kind: "order", occurredAt: "2026-08-07T00:00:00Z", symbol: "NVDA.US" },
      { id: "order-future", kind: "order", occurredAt: "2026-08-11T00:00:00Z", symbol: "NVDA.US" },
    ],
  });
  setNow("2026-08-10T00:00:00Z");
  await store.seal(cycle.id);
  setNow("2026-08-12T00:00:00Z");
  await store.linkBrokerRecords(cycle.id, {
    records: [{ id: "late-link", kind: "execution", occurredAt: "2026-08-07T00:00:00Z" }],
  });
  const blind = (await store.snapshot({ cycleId: cycle.id, phase: "blind" })).cycles[0];
  assert.deepEqual(blind.brokerLinks.recordIds, ["execution:late-link", "order:order-before"]);
  assert.deepEqual(blind.brokerLinks.orderIds, ["order-before"]);
  assert.deepEqual(blind.brokerLinks.executionIds, ["late-link"]);
});

test("broker canonical IDs keep recordIds separate from raw order and execution IDs", async () => {
  const { store } = harness();
  const cycle = await catalystCycle(store);
  const links = await store.linkBrokerRecords(cycle.id, {
    recordIds: ["order:o1", "execution:e1"],
    orderIds: ["o1"],
    executionIds: ["e1"],
    records: [
      { recordId: "order:o1", kind: "order", occurredAt: "2026-08-02T00:00:00Z" },
      { recordId: "execution:e1", kind: "execution", occurredAt: "2026-08-02T00:01:00Z" },
    ],
  });
  assert.deepEqual(links.recordIds, ["order:o1", "execution:e1"]);
  assert.deepEqual(links.orderIds, ["o1"]);
  assert.deepEqual(links.executionIds, ["e1"]);
  await assert.rejects(
    store.linkBrokerRecords(cycle.id, { recordIds: ["bare-id"] }),
    /公开记录前缀/,
  );
});

test("relinking an existing broker ID with changed facts is rejected", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store);
  await store.linkBrokerRecords(cycle.id, {
    records: [{ recordId: "order:order-1", kind: "order", occurredAt: "2026-08-02T00:00:00Z" }],
  });
  setNow("2026-08-03T00:00:00Z");
  await assert.rejects(store.linkBrokerRecords(cycle.id, {
    records: [{ recordId: "order:order-1", kind: "order", occurredAt: "2026-08-02T00:01:00Z" }],
  }), /不能改写/);
});

test("broker record prefixes cannot contradict kind and raw ID collections stay raw", async () => {
  const { store } = harness();
  const cycle = await catalystCycle(store);
  await assert.rejects(store.linkBrokerRecords(cycle.id, {
    records: [{ recordId: "order:o1", kind: "execution", occurredAt: "2026-08-02T00:00:00Z" }],
  }), /前缀 order: 与 kind=execution 不一致/);
  await assert.rejects(store.linkBrokerRecords(cycle.id, {
    orderIds: ["order:o1"],
  }), /必须保存裸券商 ID/);
});

test("blind and outcome runs have independent immutable histories, and outcome cites a completed blind run", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store);
  await assert.rejects(
    store.recordPhaseRun({ cycleId: cycle.id, phase: "blind", result: "too early" }),
    /先封存事前版本/,
  );
  setNow("2026-08-10T00:00:00Z");
  const version = await store.seal(cycle.id);
  const versionHash = version.hash;
  const blind = await store.recordPhaseRun({
    cycleId: cycle.id,
    phase: "blind",
    threadId: "thread-blind",
    evidenceFilterPolicyVersion: 2,
    result: { judgment: "当时信息下计划合理" },
  });
  assert.equal(blind.exAnteVersion, version.version);
  assert.equal(blind.evidenceFilterPolicyVersion, 2);
  assert.match(blind.inputSnapshotHash, /^[a-f0-9]{64}$/);
  setNow("2026-09-01T00:00:00Z");
  const outcome = await store.recordPhaseRun({
    cycleId: cycle.id,
    phase: "outcome",
    blindRunId: blind.id,
    threadId: "thread-outcome",
    result: { attribution: "执行贡献" },
  });
  const saved = (await store.snapshot()).cycles[0];
  assert.equal(outcome.blindRunId, blind.id);
  assert.equal(saved.phaseRuns.blind.length, 1);
  assert.equal(saved.phaseRuns.blind[0].evidenceFilterPolicyVersion, 2);
  assert.equal(saved.phaseRuns.outcome.length, 1);
  assert.equal(saved.exAnteVersions[0].hash, versionHash);
  assert.equal(saved.status, "completed");
});

test("outcome cannot run without a completed blind run and cannot cite another ID", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store);
  setNow("2026-08-10T00:00:00Z");
  await store.seal(cycle.id);
  await store.recordPhaseRun({ cycleId: cycle.id, phase: "blind", status: "failed", result: "失败" });
  setNow("2026-09-01T00:00:00Z");
  await assert.rejects(
    store.recordPhaseRun({ cycleId: cycle.id, phase: "outcome", blindRunId: "not-this-cycle" }),
    /必须引用.*已完成的盲态/,
  );
});

test("all three cycle types reject outcome before endAt", async () => {
  for (const type of REVIEW_CYCLE_TYPES) {
    const { store, setNow } = harness("2026-07-31T00:00:00Z");
    const input = type === "catalyst"
      ? {
        type,
        symbols: ["NVDA.US"],
        startAt: "2026-08-01T00:00:00Z",
        catalystAt: "2026-08-15T00:00:00Z",
        endAt: "2026-08-20T00:00:00Z",
      }
      : ["position_lifecycle", "trade_window"].includes(type)
        ? {
          type,
          symbols: ["NVDA.US"],
          startAt: "2026-08-01T00:00:00Z",
          endAt: "2026-08-20T00:00:00Z",
        }
        : {
          type,
          startAt: "2026-08-01T00:00:00Z",
          endAt: "2026-08-31T23:59:59Z",
        };
    const cycle = await store.create({ ...input, exAnte: completeExAnte() });
    await store.seal(cycle.id);
    await store.recordPhaseRun({ cycleId: cycle.id, phase: "blind", result: "盲态完成" });
    setNow("2026-08-10T00:00:00Z");
    await assert.rejects(
      store.recordPhaseRun({ cycleId: cycle.id, phase: "outcome", result: "提前偷看" }),
      /不能在复盘周期 endAt 之前/,
      type,
    );
  }
});

test("an open position lifecycle rejects outcome, can be closed exactly once, and then accepts outcome", async () => {
  const { store, setNow } = harness("2026-07-31T00:00:00Z");
  const cycle = await store.create({
    type: "position_lifecycle",
    symbols: ["MU.US"],
    startAt: "2026-08-01T00:00:00Z",
    exAnte: completeExAnte(),
  });
  await store.seal(cycle.id);
  await store.recordPhaseRun({ cycleId: cycle.id, phase: "blind", result: "盲态完成" });
  setNow("2026-08-20T00:00:00Z");
  await assert.rejects(
    store.recordPhaseRun({ cycleId: cycle.id, phase: "outcome", result: "没有终点" }),
    /开放持仓请先补录 endAt/,
  );
  const closed = await store.closeCycle({ cycleId: cycle.id, endAt: "2026-08-15T00:00:00Z" });
  assert.equal(closed.endAt, "2026-08-15T00:00:00.000Z");
  await assert.rejects(
    store.update(cycle.id, { endAt: "2026-08-16T00:00:00Z" }),
    /只能补录一次/,
  );
  const outcome = await store.recordPhaseRun({ cycleId: cycle.id, phase: "outcome", result: "正式结果" });
  assert.equal(outcome.phase, "outcome");
  assert.equal((await store.snapshot()).cycles[0].status, "completed");
});

test("closing a position cannot precede known activity or claim a future close", async () => {
  const { store, setNow } = harness("2026-08-10T00:00:00Z");
  const cycle = await store.create({
    type: "position_lifecycle",
    symbols: ["MU.US"],
    startAt: "2026-08-01T00:00:00Z",
  });
  await store.addCheckpoint(cycle.id, { at: "2026-08-08T00:00:00Z", note: "减仓" });
  await assert.rejects(store.closeCycle(cycle.id, { endAt: "2026-08-07T00:00:00Z" }), /不能早于已记录/);
  await assert.rejects(store.closeCycle(cycle.id, { endAt: "2026-08-11T00:00:00Z" }), /不能晚于当前时间/);
  setNow("2026-08-12T00:00:00Z");
  assert.equal((await store.closeCycle(cycle.id, { endAt: "2026-08-11T00:00:00Z" })).endAt, "2026-08-11T00:00:00.000Z");
});

test("starting portfolio is normalized, bounded, sealed when known, and immutable", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store, {
    eventKind: "earnings",
    startingPortfolio: {
      snapshotAt: "2026-08-01T00:00:00Z",
      baseCurrency: "usd",
      netAssets: 100_000,
      cashRatio: 25,
      grossExposure: 90,
      positions: [
        { symbol: "nvda.us", quantity: 100, weight: 20, marketValue: 20_000, currency: "usd", group: "AI" },
        { symbol: "aapl.us", quantity: 50, weight: 10, marketValue: 10_000, currency: "usd", group: "Consumer" },
      ],
    },
  });
  assert.equal(cycle.eventKind, "earnings");
  assert.equal(cycle.startingPortfolio.baseCurrency, "USD");
  assert.equal(cycle.startingPortfolio.top1.symbol, "NVDA.US");
  assert.equal(cycle.startingPortfolio.top1WeightPercent, 20);
  assert.equal(cycle.startingPortfolio.positions[0].quantity, 100);
  await assert.rejects(store.update(cycle.id, { startingPortfolio: { netAssets: 1 } }), /不可改写/);
  setNow("2026-08-10T00:00:00Z");
  const version = await store.seal(cycle.id);
  assert.equal(version.snapshot.startingPortfolio.netAssets, 100_000);
  const blind = (await store.snapshot({ cycleId: cycle.id, phase: "blind" })).cycles[0];
  assert.equal(blind.startingPortfolio.positions.length, 2);
});

test("a claimed starting portfolio from after cycle start is rejected", async () => {
  const { store } = harness();
  await assert.rejects(catalystCycle(store, {
    startingPortfolio: {
      snapshotAt: "2026-08-02T00:00:00Z",
      positions: [],
    },
  }), /不能晚于周期开始时间/);
});

test("a future-dated starting portfolio cannot be fabricated for a cycle created before it starts", async () => {
  const { store } = harness("2026-07-20T00:00:00Z");
  await assert.rejects(catalystCycle(store, {
    startingPortfolio: {
      snapshotAt: "2026-07-25T00:00:00Z",
      positions: [],
    },
  }), /不能晚于周期创建时间/);
});

test("blind snapshots preserve sealed title and open-lifecycle end state instead of leaking later edits", async () => {
  const { store, setNow } = harness("2026-07-31T00:00:00Z");
  const cycle = await store.create({
    type: "position_lifecycle",
    title: "封存标题",
    symbols: ["MU.US"],
    startAt: "2026-08-01T00:00:00Z",
    exAnte: completeExAnte(),
  });
  await store.seal(cycle.id);
  await store.update(cycle.id, { title: "事后标题" });
  setNow("2026-08-20T00:00:00Z");
  await store.closeCycle(cycle.id, { endAt: "2026-08-15T00:00:00Z" });
  const blind = (await store.snapshot({ cycleId: cycle.id, phase: "blind" })).cycles[0];
  assert.equal(blind.title, "封存标题");
  assert.equal(blind.endAt, null);
});

test("outcome snapshot itself is gated by cycle end and an intact completed blind run", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store);
  setNow("2026-08-10T00:00:00Z");
  await store.seal(cycle.id);
  await store.recordPhaseRun({ cycleId: cycle.id, phase: "blind", result: "盲态" });
  await assert.rejects(store.snapshot({ cycleId: cycle.id, phase: "outcome" }), /只能在周期结束后/);
  setNow("2026-09-01T00:00:00Z");
  const outcomeView = await store.snapshot({ cycleId: cycle.id, phase: "outcome" });
  assert.equal(outcomeView.cycles[0].id, cycle.id);
  assert.match(outcomeView.snapshotHash, /^[a-f0-9]{64}$/);
});

test("an outcome run is rejected if broker evidence changes while the Agent is running", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store);
  setNow("2026-08-10T00:00:00Z");
  await store.seal(cycle.id);
  await store.linkBrokerRecords(cycle.id, {
    recordIds: ["order:post-cutoff-1"],
    orderIds: ["post-cutoff-1"],
    records: [{
      id: "order:post-cutoff-1",
      kind: "order",
      occurredAt: "2026-08-15T00:00:00Z",
      symbol: "NVDA.US",
    }],
  });
  await store.recordPhaseRun({ cycleId: cycle.id, phase: "blind", result: "盲态" });
  setNow("2026-09-01T00:00:00Z");
  const outcomeView = await store.snapshot({ cycleId: cycle.id, phase: "outcome" });
  await store.linkBrokerRecords(cycle.id, {
    recordIds: ["order:post-cutoff-2"],
    orderIds: ["post-cutoff-2"],
    records: [{
      id: "order:post-cutoff-2",
      kind: "order",
      occurredAt: "2026-08-16T00:00:00Z",
      symbol: "NVDA.US",
    }],
  });
  await assert.rejects(store.recordPhaseRun({
    cycleId: cycle.id,
    phase: "outcome",
    expectedEvidenceRevision: 1,
    expectedInputSnapshotHash: outcomeView.snapshotHash,
    result: "不得记到新证据版本",
  }), /证据已在 Agent 分析期间更新/);
});

test("a newly sealed ex-ante version requires a matching new blind run before outcome", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store);
  setNow("2026-08-10T00:00:00Z");
  await store.seal(cycle.id);
  const blindV1 = await store.recordPhaseRun({ cycleId: cycle.id, phase: "blind", result: "v1" });
  setNow("2026-08-11T00:00:00Z");
  await store.update(cycle.id, { exAnte: { myView: "v2 判断" } });
  const versionV2 = await store.seal(cycle.id);
  setNow("2026-09-01T00:00:00Z");
  await assert.rejects(
    store.recordPhaseRun({ cycleId: cycle.id, phase: "outcome", blindRunId: blindV1.id }),
    /必须引用.*已完成的盲态/,
  );
  await assert.rejects(store.snapshot({ cycleId: cycle.id, phase: "outcome" }), /需要已完成且完整/);
  const blindV2 = await store.recordPhaseRun({ cycleId: cycle.id, phase: "blind", result: "v2" });
  assert.equal(blindV2.exAnteVersion, versionV2.version);
  const outcome = await store.recordPhaseRun({ cycleId: cycle.id, phase: "outcome", blindRunId: blindV2.id });
  assert.equal(outcome.exAnteVersion, versionV2.version);
});

test("late-synced pre-cutoff broker facts invalidate a stale blind input until blind is rerun", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store);
  setNow("2026-08-10T00:00:00Z");
  await store.seal(cycle.id);
  const staleBlind = await store.recordPhaseRun({ cycleId: cycle.id, phase: "blind", result: "旧证据" });
  setNow("2026-08-12T00:00:00Z");
  await store.linkBrokerRecords(cycle.id, {
    records: [{ recordId: "order:late-sync", kind: "order", occurredAt: "2026-08-05T00:00:00Z" }],
  });
  setNow("2026-09-01T00:00:00Z");
  await assert.rejects(
    store.recordPhaseRun({ cycleId: cycle.id, phase: "outcome", blindRunId: staleBlind.id }),
    /必须引用.*已完成的盲态/,
  );
  await assert.rejects(store.snapshot({ cycleId: cycle.id, phase: "outcome" }), /需要已完成且完整/);
  const refreshedBlind = await store.recordPhaseRun({ cycleId: cycle.id, phase: "blind", result: "补齐历史事实" });
  assert.notEqual(refreshedBlind.inputSnapshotHash, staleBlind.inputSnapshotHash);
  const outcome = await store.recordPhaseRun({ cycleId: cycle.id, phase: "outcome", blindRunId: refreshedBlind.id });
  assert.equal(outcome.blindRunId, refreshedBlind.id);
});

test("tampered blind run history is marked and cannot authorize outcome", async () => {
  const { store, repository, setNow } = harness();
  const cycle = await catalystCycle(store);
  setNow("2026-08-10T00:00:00Z");
  await store.seal(cycle.id);
  await store.recordPhaseRun({ cycleId: cycle.id, phase: "blind", result: { judgment: "原始" } });
  const raw = await repository.get(STORE_KEY);
  raw.cycles[0].phaseRuns.blind[0].result.judgment = "篡改";
  await repository.set(STORE_KEY, raw);
  const saved = (await store.snapshot()).cycles[0];
  assert.equal(saved.phaseRuns.blind[0].integrityStatus, "mismatch");
  setNow("2026-09-01T00:00:00Z");
  await assert.rejects(
    store.recordPhaseRun({ cycleId: cycle.id, phase: "outcome", result: "不得运行" }),
    /必须引用.*已完成的盲态/,
  );
});

test("stored eligibility labels are recomputed from deadlines and cannot be forged", async () => {
  const { store, repository } = harness("2026-08-21T00:00:00Z");
  const cycle = await catalystCycle(store);
  await store.seal(cycle.id);
  const raw = await repository.get(STORE_KEY);
  raw.cycles[0].exAnteVersions[0].timing = "ex_ante";
  raw.cycles[0].exAnteVersions[0].eligibleForFormalStats = true;
  raw.cycles[0].exAnteVersions[0].formalEligibility = "full";
  await repository.set(STORE_KEY, raw);
  const version = (await store.snapshot()).cycles[0].exAnteVersions[0];
  assert.equal(version.timing, "retrospective");
  assert.equal(version.eligibleForFormalStats, false);
  assert.equal(version.formalEligibility, "ineligible");
});

test("formal eligibility is recomputed from the frozen version snapshot, not mutable cycle dates", async () => {
  const { store, repository, setNow } = harness();
  const cycle = await catalystCycle(store, {
    catalystAt: "2026-08-05T20:00:00Z",
    endAt: "2026-08-31T23:59:59Z",
  });
  setNow("2026-08-06T00:00:00Z");
  await store.seal(cycle.id);
  const raw = await repository.get(STORE_KEY);
  raw.cycles[0].catalystAt = "2026-08-20T20:00:00.000Z";
  await repository.set(STORE_KEY, raw);
  const version = (await store.snapshot()).cycles[0].exAnteVersions[0];
  assert.equal(version.snapshot.catalystAt, "2026-08-05T20:00:00.000Z");
  assert.equal(version.formalEligibilityDeadlineAt, "2026-08-05T20:00:00.000Z");
  assert.equal(version.timing, "retrospective");
  assert.equal(version.eligibleForFormalStats, false);
});

test("evidence, broker IDs, and explicit run status enforce upper and enum guards", async () => {
  const { store } = harness();
  await assert.rejects(catalystCycle(store, {
    exAnte: completeExAnte({
      evidence: Array.from({ length: 201 }, (_, index) => ({ summary: `e-${index}` })),
    }),
  }), /最多包含 200 条/);
  const cycle = await catalystCycle(store);
  await assert.rejects(
    store.linkBrokerRecords(cycle.id, {
      orderIds: Array.from({ length: 5_001 }, (_, index) => `order-${index}`),
    }),
    /超过 5000 条上限/,
  );
  await store.seal(cycle.id);
  await assert.rejects(
    store.recordPhaseRun({ cycleId: cycle.id, phase: "blind", status: "success" }),
    /运行状态无效/,
  );
});

test("run result size, serialization, and phase are guarded", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store);
  setNow("2026-08-10T00:00:00Z");
  await store.seal(cycle.id);
  const circular = {};
  circular.self = circular;
  await assert.rejects(
    store.recordPhaseRun({ cycleId: cycle.id, phase: "blind", result: circular }),
    /必须可以序列化/,
  );
  await assert.rejects(
    store.recordPhaseRun({ cycleId: cycle.id, phase: "blind", result: "x".repeat(210_000) }),
    /结果过大/,
  );
  await assert.rejects(
    store.recordPhaseRun({ cycleId: cycle.id, phase: "blind", startedAt: "not-a-date" }),
    /运行开始时间无效/,
  );
  await assert.rejects(
    store.recordPhaseRun({ cycleId: cycle.id, phase: "blind", completedAt: "not-a-date" }),
    /运行完成时间无效/,
  );
  await assert.rejects(
    store.recordPhaseRun({ cycleId: cycle.id, phase: "future" }),
    /阶段无效/,
  );
  await assert.rejects(
    store.recordPhaseRun({
      cycleId: cycle.id,
      phase: "blind",
      completedAt: "2026-08-11T00:00:00Z",
    }),
    /不能晚于实际记录时间/,
  );
});

test("status transitions and sealed scope facts are guarded", async () => {
  const { store, setNow } = harness();
  const cycle = await catalystCycle(store);
  for (const status of ["sealed", "blind_reviewed", "completed", "active"]) {
    await assert.rejects(store.update(cycle.id, { status }), /只能由封存及两阶段运行结果推进/);
  }
  setNow("2026-08-10T00:00:00Z");
  await store.seal(cycle.id);
  await assert.rejects(store.updateCycle({
    cycleId: cycle.id,
    patch: { symbols: ["AAPL.US"] },
  }), /不能改写周期范围/);
  const cancelledHarness = harness();
  const cancelled = await catalystCycle(cancelledHarness.store);
  await cancelledHarness.store.update(cancelled.id, { status: "cancelled" });
  await assert.rejects(cancelledHarness.store.addCheckpoint(cancelled.id, {
    at: "2026-08-02T00:00:00Z",
  }), /已完成或已取消/);
});

test("a checkpoint cannot claim that a future event has already occurred", async () => {
  const { store } = harness("2026-08-02T00:00:00Z");
  const cycle = await catalystCycle(store);
  await assert.rejects(
    store.addCheckpoint(cycle.id, { at: "2026-08-03T00:00:00Z", note: "未来事实" }),
    /发生时间不能晚于记录时间/,
  );
});

test("tampered sealed versions and checkpoints are marked and cannot cross the blind firewall", async () => {
  const { store, repository, setNow } = harness();
  const cycle = await catalystCycle(store);
  setNow("2026-08-05T00:00:00Z");
  await store.addCheckpoint(cycle.id, { at: "2026-08-04T00:00:00Z", note: "原始" });
  setNow("2026-08-10T00:00:00Z");
  await store.seal(cycle.id);
  const raw = await repository.get(STORE_KEY);
  raw.cycles[0].exAnteVersions[0].snapshot.exAnte.myView = "篡改版本";
  raw.cycles[0].checkpoints[0].note = "篡改检查点";
  await repository.set(STORE_KEY, raw);
  const normalized = (await store.snapshot()).cycles[0];
  assert.equal(normalized.exAnteVersions[0].integrityStatus, "mismatch");
  assert.equal(normalized.exAnteVersions[0].eligibleForFormalStats, false);
  assert.equal(normalized.checkpoints[0].integrityStatus, "mismatch");
  await assert.rejects(store.snapshot({ cycleId: cycle.id, phase: "blind" }), /完整性校验失败/);
});

test("knowledgeCutoffAt is covered by the seal hash and cannot be forged to admit future facts", async () => {
  const { store, repository, setNow } = harness();
  const cycle = await catalystCycle(store);
  setNow("2026-08-08T00:00:00Z");
  await store.addCheckpoint(cycle.id, { at: "2026-08-08T00:00:00Z", note: "晚于声明的知识截止" });
  setNow("2026-08-10T00:00:00Z");
  await store.seal(cycle.id, { knowledgeCutoffAt: "2026-08-05T00:00:00Z" });
  const raw = await repository.get(STORE_KEY);
  raw.cycles[0].exAnteVersions[0].knowledgeCutoffAt = "2026-08-10T00:00:00.000Z";
  await repository.set(STORE_KEY, raw);
  const version = (await store.snapshot()).cycles[0].exAnteVersions[0];
  assert.equal(version.integrityStatus, "mismatch");
  await assert.rejects(store.snapshot({ cycleId: cycle.id, phase: "blind" }), /完整性校验失败/);
});

test("excluded future-evidence counts are hash-bound and redacted from blind input", async () => {
  const { store, repository, setNow } = harness();
  const cycle = await catalystCycle(store, {
    exAnte: completeExAnte({
      evidence: [{ id: "future", observedAt: "2026-08-11T00:00:00Z", summary: "未来结果" }],
    }),
  });
  setNow("2026-08-10T00:00:00Z");
  await store.seal(cycle.id);
  const safeBlind = await store.snapshot({ cycleId: cycle.id, phase: "blind" });
  assert.equal(safeBlind.cycles[0].exAnteVersions[0].excludedEvidenceCount, null);
  assert.doesNotMatch(JSON.stringify(safeBlind), /未来结果|excluded_future_or_untimed_evidence:1/);

  const raw = await repository.get(STORE_KEY);
  raw.cycles[0].exAnteVersions[0].excludedEvidenceCount = 0;
  await repository.set(STORE_KEY, raw);
  const version = (await store.snapshot()).cycles[0].exAnteVersions[0];
  assert.equal(version.integrityStatus, "mismatch");
  assert.equal(version.eligibleForFormalStats, false);
});

test("normal legacy arrays migrate without becoming trusted and remain writable", async () => {
  const seed = [
    {
      id: "legacy-cycle",
      type: "catalyst",
      symbols: ["nvda.us"],
      startAt: "2026-08-01T00:00:00Z",
      eventAt: "2026-08-20T20:00:00Z",
      endAt: "2026-08-31T00:00:00Z",
      createdAt: "2026-07-31T00:00:00Z",
      exAnte: completeExAnte(),
      exAnteVersions: [{
        version: 1,
        sealedAt: "2026-08-10T00:00:00Z",
        cutoffAt: "2026-08-09T00:00:00Z",
        snapshot: { exAnte: completeExAnte() },
      }],
      checkpoints: [
        { id: "later", at: "2026-08-05T00:00:00Z", recordedAt: "2026-08-05T01:00:00Z", note: "later" },
        { id: "earlier", at: "2026-08-04T00:00:00Z", recordedAt: "2026-08-04T01:00:00Z", note: "earlier" },
      ],
    },
  ];
  const repository = new MemoryStore(seed);
  const store = new ReviewCycleStore({
    store: repository,
    now: () => new Date("2026-08-11T00:00:00Z"),
    idFactory: () => "legacy-new-id",
  });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.cycles.length, 1);
  assert.deepEqual(snapshot.quarantinedCycles, []);
  assert.equal(snapshot.cycles[0].exAnteVersions[0].knowledgeCutoffAt, "2026-08-09T00:00:00.000Z");
  assert.equal(snapshot.cycles[0].exAnteVersions[0].integrityStatus, "migrated");
  assert.equal(snapshot.cycles[0].exAnteVersions[0].eligibleForFormalStats, false);
  assert.match(snapshot.cycles[0].exAnteVersions[0].eligibilityReasons.join(" "), /migration_requires_reseal/);
  assert.deepEqual(snapshot.cycles[0].checkpoints.map((item) => item.id), ["earlier", "later"]);
  assert.equal(snapshot.cycles[0].checkpoints.every((item) => item.integrityStatus === "migrated"), true);
  await assert.rejects(
    store.snapshot({ cycleId: "legacy-cycle", phase: "blind" }),
    /迁移封存版本需要重新封存/,
  );
  await store.update("legacy-cycle", { title: "触发持久化迁移" });
  const persisted = (await store.snapshot()).cycles[0];
  assert.equal(persisted.exAnteVersions[0].integrityStatus, "migrated");
  assert.equal(persisted.checkpoints.every((item) => item.integrityStatus === "migrated"), true);
});

test("malformed ledger entries are quarantined with recovery metadata and block all writes", async () => {
  const malformed = { id: "bad-cycle", type: "nonsense", privateRecoveryFact: "do-not-drop" };
  const repository = new MemoryStore([malformed]);
  const store = new ReviewCycleStore({ store: repository });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.cycles.length, 0);
  assert.equal(snapshot.quarantinedCycles.length, 1);
  assert.equal(snapshot.quarantinedCycles[0].id, "bad-cycle");
  assert.equal(snapshot.quarantinedCycles[0].reason, "malformed_cycle");
  assert.match(snapshot.quarantinedCycles[0].detail, /类型无效/);
  assert.equal(snapshot.quarantinedCycles[0].sourceIndex, 0);
  assert.equal(snapshot.quarantinedCycles[0].raw.privateRecoveryFact, "do-not-drop");
  await assert.rejects(
    store.create({ type: "monthly_portfolio", startAt: "2026-08-01T00:00:00Z" }),
    /已隔离原始数据并停止写入/,
  );
  assert.deepEqual(await repository.get(STORE_KEY), [malformed]);
});

test("cycle overflow is preserved in quarantine and can never be truncated by an unrelated write", async () => {
  const cycles = Array.from({ length: 501 }, (_, index) => ({
    id: `overflow-${index}`,
    type: "monthly_portfolio",
    scope: "portfolio",
    startAt: "2026-08-01T00:00:00Z",
    endAt: "2026-08-31T23:59:59Z",
    createdAt: "2026-07-31T00:00:00Z",
  }));
  const repository = new MemoryStore({ cycles });
  const store = new ReviewCycleStore({ store: repository });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.cycles.length, 500);
  assert.equal(snapshot.quarantinedCycles.length, 1);
  assert.equal(snapshot.quarantinedCycles[0].reason, "cycle_limit_exceeded");
  assert.equal(snapshot.quarantinedCycles[0].raw.length, 1);
  assert.equal(snapshot.quarantinedCycles[0].raw[0].id, "overflow-500");
  await assert.rejects(store.update("overflow-0", { title: "不得触发截断回写" }), /写入已停止|停止写入/);
  const untouched = await repository.get(STORE_KEY);
  assert.equal(untouched.cycles.length, 501);
  assert.equal(untouched.cycles[500].id, "overflow-500");
});

test("legacy high version numbers advance monotonically and duplicate versions quarantine the cycle", async () => {
  const base = {
    id: "legacy-high",
    type: "catalyst",
    symbols: ["NVDA.US"],
    startAt: "2026-08-01T00:00:00Z",
    catalystAt: "2026-08-20T20:00:00Z",
    endAt: "2026-08-31T00:00:00Z",
    createdAt: "2026-07-31T00:00:00Z",
    exAnte: completeExAnte(),
    exAnteVersions: [{
      version: 99,
      sealedAt: "2026-08-09T00:00:00Z",
      cutoffAt: "2026-08-09T00:00:00Z",
      snapshot: { exAnte: completeExAnte() },
    }],
  };
  const repository = new MemoryStore([base]);
  const store = new ReviewCycleStore({
    store: repository,
    now: () => new Date("2026-08-10T00:00:00Z"),
  });
  const next = await store.seal("legacy-high");
  assert.equal(next.version, 100);
  assert.equal((await store.snapshot()).cycles[0].exAnteVersions.at(-1).version, 100);

  const duplicate = structuredClone(base);
  duplicate.exAnteVersions.push({ ...structuredClone(base.exAnteVersions[0]), sealedAt: "2026-08-10T00:00:00Z" });
  const duplicateStore = new ReviewCycleStore({ store: new MemoryStore([duplicate]) });
  const quarantined = await duplicateStore.snapshot();
  assert.equal(quarantined.cycles.length, 0);
  assert.equal(quarantined.quarantinedCycles[0].reason, "malformed_cycle");
  assert.match(quarantined.quarantinedCycles[0].detail, /版本编号重复或非递增/);
});

test("concurrent writes through one store are serialized without losing cycles", async () => {
  const repository = new DelayedStore();
  let id = 0;
  const store = new ReviewCycleStore({
    store: repository,
    now: () => new Date("2026-08-01T00:00:00Z"),
    idFactory: () => `concurrent-${++id}`,
  });
  await Promise.all([
    catalystCycle(store, { symbols: ["NVDA.US"] }),
    catalystCycle(store, { symbols: ["AAPL.US"] }),
    store.create({ type: "monthly_portfolio", startAt: "2026-08-01T00:00:00Z" }),
  ]);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.cycles.length, 3);
  assert.equal(snapshot.revision, 3);
  assert.equal(repository.maxConcurrentReads, 1);
});

test("duplicate host IDs are rejected instead of overwriting an existing cycle", async () => {
  const repository = new MemoryStore();
  const store = new ReviewCycleStore({
    store: repository,
    now: () => new Date("2026-08-01T00:00:00Z"),
    idFactory: () => "same-id",
  });
  await catalystCycle(store);
  await assert.rejects(catalystCycle(store, { symbols: ["AAPL.US"] }), /ID 冲突/);
});

test("order-first trade windows are created atomically with broker closure and support direct retrospective runs", async () => {
  const { store } = harness("2026-08-18T00:00:00Z");
  const cycle = await store.createLinkedCycle({
    cycle: {
      type: "trade_window",
      reviewMode: "lightweight",
      symbol: "NVDA.US",
      startAt: "2026-08-01T12:00:00Z",
      endAt: "2026-08-05T12:00:00Z",
    },
    links: {
      requestedRecordIds: ["order:buy-1"],
      recordIds: ["order:buy-1", "execution:fill-1"],
      orderIds: ["buy-1"],
      executionIds: ["fill-1"],
      records: [
        { id: "order:buy-1", kind: "order", occurredAt: "2026-08-01T12:00:00Z", symbol: "NVDA.US" },
        { id: "execution:fill-1", kind: "execution", occurredAt: "2026-08-01T12:01:00Z", symbol: "NVDA.US" },
      ],
    },
    retrospectiveNote: {
      recalledJudgment: "当时认为回踩会被承接",
      lesson: "订单节奏也属于风险",
      forwardHypothesis: "下一次等待量价确认再加仓",
    },
  });
  assert.equal(cycle.cycleType, "trade_window");
  assert.equal(cycle.reviewMode, "lightweight");
  assert.deepEqual(cycle.brokerLinks.requestedRecordIds, ["order:buy-1"]);
  assert.deepEqual(cycle.brokerLinks.recordIds, ["order:buy-1", "execution:fill-1"]);
  const note = cycle.retrospectiveVersions[0];
  assert.equal(note.version, 1);
  assert.equal(note.evidenceTiming, "retrospective");
  assert.equal(note.forwardEffectiveAt, note.savedAt);
  const view = await store.snapshot({ cycleId: cycle.id, phase: "retrospective" });
  assert.equal(view.phase, "retrospective");
  assert.match(view.snapshotHash, /^[a-f0-9]{64}$/);
  assert.equal(view.cycles[0].exAnteVersions.length, 0);
  const run = await store.recordPhaseRun({
    cycleId: cycle.id,
    phase: "retrospective",
    expectedEvidenceRevision: 1,
    expectedRetrospectiveVersion: 1,
    expectedInputSnapshotHash: view.snapshotHash,
    result: { conclusion: "只做事后归因" },
  });
  assert.equal(run.phase, "retrospective");
  assert.equal(run.exAnteVersion, null);
  assert.equal(run.retrospectiveVersion, 1);
  assert.equal(run.blindRunId, null);
  assert.match(run.inputSnapshotHash, /^[a-f0-9]{64}$/);
  const saved = (await store.snapshot()).cycles.find((item) => item.id === cycle.id);
  assert.equal(saved.status, "completed");
  assert.equal(saved.phaseRuns.blind.length, 0);
  assert.equal(saved.phaseRuns.retrospective.length, 1);
});

test("order-first broker evidence is revisioned, replaceable, and makes an old retrospective run stale", async () => {
  let now = "2026-08-18T00:00:00Z";
  const repository = new MemoryStore();
  let id = 0;
  const store = new ReviewCycleStore({
    store: repository,
    now: () => new Date(now),
    idFactory: () => `broker-revision-${++id}`,
  });
  const cycle = await store.createLinkedCycle({
    cycle: {
      type: "trade_window",
      reviewMode: "lightweight",
      symbol: "AAOI.US",
      startAt: "2026-08-01T14:30:00Z",
      endAt: "2026-08-04T20:00:00Z",
    },
    links: {
      requestedRecordIds: ["order:buy-100", "order:wrong-order"],
      recordIds: ["order:buy-100", "order:wrong-order"],
      orderIds: ["buy-100", "wrong-order"],
      records: [
        { id: "order:buy-100", kind: "order", occurredAt: "2026-08-01T14:30:00Z", symbol: "AAOI.US" },
        { id: "order:wrong-order", kind: "order", occurredAt: "2026-08-03T14:30:00Z", symbol: "AAOI.US" },
      ],
    },
    retrospectiveNote: {
      recalledJudgment: "当时预期财报后仍会延续",
      lesson: "必须把盘后减仓纳入完整路径",
      forwardHypothesis: "下次先核对买卖闭环再归因",
    },
  });
  assert.equal(cycle.evidenceRevision, 1);
  assert.equal(cycle.brokerLinks.evidenceRevision, 1);
  assert.equal(cycle.brokerLinkVersions.length, 1);
  assert.deepEqual(cycle.brokerLinkVersions[0].added.recordIds, ["order:buy-100", "order:wrong-order"]);

  const oldRun = await store.recordPhaseRun({
    cycleId: cycle.id,
    phase: "retrospective",
    result: { conclusion: "基于错误关联的旧结论" },
  });
  assert.equal((await store.validatePhaseRunSource(cycle.id, oldRun.id)).status, "current");

  now = "2026-08-19T00:00:00Z";
  const replaced = await store.replaceCycleBrokerRecords({
    cycleId: cycle.id,
    reason: "移除误关联订单并补入盘后卖出 20 股",
    activityStartAt: "2026-08-01T14:30:00Z",
    activityEndAt: "2026-08-05T21:30:00Z",
    requestedRecordIds: ["order:buy-100", "execution:sell-20"],
    recordIds: ["order:buy-100", "execution:sell-20"],
    orderIds: ["buy-100"],
    executionIds: ["sell-20"],
    records: [
      { id: "order:buy-100", kind: "order", occurredAt: "2026-08-01T14:30:00Z", symbol: "AAOI.US" },
      { id: "execution:sell-20", kind: "execution", occurredAt: "2026-08-05T21:30:00Z", symbol: "AAOI.US" },
    ],
  });
  assert.equal(replaced.evidenceRevision, 2);
  assert.deepEqual(replaced.requestedRecordIds, ["order:buy-100", "execution:sell-20"]);
  assert.deepEqual(replaced.recordIds, ["order:buy-100", "execution:sell-20"]);
  const afterReplace = (await store.snapshot()).cycles[0];
  assert.equal(afterReplace.startAt, "2026-08-01T14:30:00.000Z");
  assert.equal(afterReplace.endAt, "2026-08-05T21:30:00.000Z");
  assert.equal(afterReplace.brokerLinkVersions.length, 2);
  assert.deepEqual(afterReplace.brokerLinkVersions[0].records.map((item) => item.id), [
    "order:buy-100",
    "order:wrong-order",
  ]);
  assert.equal(afterReplace.brokerLinkVersions[0].supersededBy, 2);
  assert.equal(afterReplace.brokerLinkVersions[0].supersededAt, "2026-08-19T00:00:00.000Z");
  assert.equal(afterReplace.brokerLinkVersions[1].reason, "移除误关联订单并补入盘后卖出 20 股");
  assert.deepEqual(afterReplace.brokerLinkVersions[1].added.recordIds, ["execution:sell-20"]);
  assert.deepEqual(afterReplace.brokerLinkVersions[1].removed.recordIds, ["order:wrong-order"]);
  assert.equal(afterReplace.brokerLinkVersions[1].supersededBy, null);
  const stale = await store.validatePhaseRunSource({ cycleId: cycle.id, runId: oldRun.id });
  assert.equal(stale.status, "stale");
  assert.equal(stale.citedEvidenceRevision, 1);
  assert.equal(stale.currentEvidenceRevision, 2);
  assert.deepEqual(stale.reasons, ["broker_evidence_revision_changed"]);

  const beforeIdempotent = await store.snapshot();
  now = "2026-08-20T00:00:00Z";
  const same = await store.replaceBrokerRecords(cycle.id, {
    reason: "相同集合不应生成新版本",
    activityStartAt: "2026-08-01T14:30:00Z",
    activityEndAt: "2026-08-05T21:30:00Z",
    requestedRecordIds: ["execution:sell-20", "order:buy-100"],
    recordIds: ["execution:sell-20", "order:buy-100"],
    executionIds: ["sell-20"],
    orderIds: ["buy-100"],
    records: [
      { id: "execution:sell-20", kind: "execution", occurredAt: "2026-08-05T21:30:00Z", symbol: "AAOI.US" },
      { id: "order:buy-100", kind: "order", occurredAt: "2026-08-01T14:30:00Z", symbol: "AAOI.US" },
    ],
  });
  const afterIdempotent = await store.snapshot();
  assert.equal(same.evidenceRevision, 2);
  assert.equal(afterIdempotent.revision, beforeIdempotent.revision);
  assert.equal(afterIdempotent.updatedAt, beforeIdempotent.updatedAt);
  assert.equal(afterIdempotent.cycles[0].brokerLinkVersions.length, 2);

  await assert.rejects(store.recordPhaseRun({
    cycleId: cycle.id,
    phase: "retrospective",
    expectedEvidenceRevision: 1,
    expectedRetrospectiveVersion: 1,
    result: { conclusion: "运行期间证据已变化的旧结果" },
  }), /证据已在 Agent 分析期间更新/);
  await assert.rejects(store.recordPhaseRun({
    cycleId: cycle.id,
    phase: "retrospective",
    expectedEvidenceRevision: 2,
    expectedRetrospectiveVersion: 1,
    expectedInputSnapshotHash: "0".repeat(64),
    result: { conclusion: "快照不匹配的旧结果" },
  }), /证据快照已在 Agent 分析期间变化/);
  const refreshedRun = await store.recordPhaseRun({
    cycleId: cycle.id,
    phase: "retrospective",
    expectedEvidenceRevision: 2,
    expectedRetrospectiveVersion: 1,
    result: { conclusion: "按修订后证据重新复盘" },
  });
  assert.equal(refreshedRun.evidenceRevision, 2);
  assert.equal((await store.validatePhaseRunSource(cycle.id, refreshedRun.id)).status, "current");
});

test("broker evidence cannot cross an opaque account scope", async () => {
  const { store } = harness("2026-08-18T00:00:00Z");
  const cycle = await store.createLinkedCycle({
    cycle: {
      type: "trade_window",
      symbol: "AAPL.US",
      startAt: "2026-08-01T14:30:00Z",
      endAt: "2026-08-02T20:00:00Z",
    },
    links: {
      accountScopeId: "scope-account-a",
      requestedRecordIds: ["order:buy-a"],
      recordIds: ["order:buy-a"],
      orderIds: ["buy-a"],
      records: [{ id: "order:buy-a", kind: "order", occurredAt: "2026-08-01T14:30:00Z", symbol: "AAPL.US" }],
    },
  });
  assert.equal(cycle.brokerLinks.accountScopeId, "scope-account-a");
  await assert.rejects(store.replaceCycleBrokerRecords({
    cycleId: cycle.id,
    accountScopeId: "scope-account-b",
    requestedRecordIds: ["order:buy-b"],
    recordIds: ["order:buy-b"],
    orderIds: ["buy-b"],
    records: [{ id: "order:buy-b", kind: "order", occurredAt: "2026-08-01T15:30:00Z", symbol: "AAPL.US" }],
    activityStartAt: "2026-08-01T15:30:00Z",
    activityEndAt: "2026-08-02T20:00:00Z",
  }), /跨账户合并/);
  const saved = (await store.snapshot()).cycles.find((item) => item.id === cycle.id);
  assert.equal(saved.brokerLinks.accountScopeId, "scope-account-a");
  assert.deepEqual(saved.brokerLinks.orderIds, ["buy-a"]);
});

test("the user's explicit broker selection is versioned separately from the resolved evidence closure", async () => {
  let now = "2026-08-18T00:00:00Z";
  const repository = new MemoryStore();
  const store = new ReviewCycleStore({
    store: repository,
    now: () => new Date(now),
    idFactory: () => "explicit-selection-cycle",
  });
  const cycle = await store.createLinkedCycle({
    cycle: {
      type: "trade_window",
      reviewMode: "lightweight",
      symbol: "AAOI.US",
      startAt: "2026-08-01T14:30:00Z",
      endAt: "2026-08-05T20:00:00Z",
    },
    links: {
      requestedRecordIds: ["order:buy"],
      recordIds: ["order:buy", "execution:buy-fill", "order:sell", "execution:sell-fill"],
      orderIds: ["buy", "sell"],
      executionIds: ["buy-fill", "sell-fill"],
      records: [
        { id: "order:buy", kind: "order", occurredAt: "2026-08-01T14:30:00Z", symbol: "AAOI.US" },
        { id: "execution:buy-fill", kind: "execution", occurredAt: "2026-08-01T14:31:00Z", symbol: "AAOI.US" },
        { id: "order:sell", kind: "order", occurredAt: "2026-08-05T19:59:00Z", symbol: "AAOI.US" },
        { id: "execution:sell-fill", kind: "execution", occurredAt: "2026-08-05T20:00:00Z", symbol: "AAOI.US" },
      ],
    },
  });
  assert.deepEqual(cycle.brokerLinks.requestedRecordIds, ["order:buy"]);
  now = "2026-08-19T00:00:00Z";
  const replaced = await store.replaceCycleBrokerRecords({
    cycleId: cycle.id,
    requestedRecordIds: ["order:buy", "order:sell"],
    recordIds: ["order:buy", "execution:buy-fill", "order:sell", "execution:sell-fill"],
    orderIds: ["buy", "sell"],
    executionIds: ["buy-fill", "sell-fill"],
    records: [
      { id: "order:buy", kind: "order", occurredAt: "2026-08-01T14:30:00Z", symbol: "AAOI.US" },
      { id: "execution:buy-fill", kind: "execution", occurredAt: "2026-08-01T14:31:00Z", symbol: "AAOI.US" },
      { id: "order:sell", kind: "order", occurredAt: "2026-08-05T19:59:00Z", symbol: "AAOI.US" },
      { id: "execution:sell-fill", kind: "execution", occurredAt: "2026-08-05T20:00:00Z", symbol: "AAOI.US" },
    ],
    activityStartAt: "2026-08-01T14:31:00Z",
    activityEndAt: "2026-08-05T20:00:00Z",
  });
  assert.equal(replaced.evidenceRevision, 2);
  assert.deepEqual(replaced.requestedRecordIds, ["order:buy", "order:sell"]);
  assert.deepEqual(replaced.recordIds, cycle.brokerLinks.recordIds);
  const saved = (await store.snapshot()).cycles[0];
  assert.deepEqual(saved.brokerLinkVersions[1].added.requestedRecordIds, ["order:sell"]);
  assert.equal(saved.startAt, "2026-08-01T14:31:00.000Z", "parent order submission may precede the selected fill boundary");
});

test("broker evidence replacement rejects empty, future, and out-of-range selections atomically", async () => {
  const { store } = harness("2026-08-18T00:00:00Z");
  const cycle = await store.createLinkedCycle({
    cycle: {
      type: "trade_window", reviewMode: "lightweight", symbol: "AAOI.US",
      startAt: "2026-08-01T14:30:00Z", endAt: "2026-08-05T21:30:00Z",
    },
    links: {
      recordIds: ["order:buy-1"], orderIds: ["buy-1"],
      records: [{ id: "order:buy-1", kind: "order", occurredAt: "2026-08-01T14:30:00Z", symbol: "AAOI.US" }],
    },
  });
  const before = await store.snapshot();
  await assert.rejects(store.replaceBrokerRecords(cycle.id, {}), /至少需要关联一笔/);
  await assert.rejects(store.replaceBrokerRecords(cycle.id, {
    activityStartAt: "2026-08-01T14:30:00Z",
    activityEndAt: "2026-08-20T00:00:00Z",
    orderIds: ["buy-1"],
  }), /不能晚于本次实际证据更新时间/);
  await assert.rejects(store.replaceBrokerRecords(cycle.id, {
    activityStartAt: "2026-08-02T00:00:00Z",
    activityEndAt: "2026-08-05T00:00:00Z",
    requestedRecordIds: ["execution:buy-fill-1"],
    recordIds: ["order:buy-1", "execution:buy-fill-1"],
    orderIds: ["buy-1"],
    executionIds: ["buy-fill-1"],
    records: [
      { id: "order:buy-1", kind: "order", occurredAt: "2026-08-01T14:30:00Z", symbol: "AAOI.US" },
      { id: "execution:buy-fill-1", kind: "execution", occurredAt: "2026-08-01T14:30:00Z", symbol: "AAOI.US" },
    ],
  }), /不在新的订单活动范围内/);
  const after = await store.snapshot();
  assert.equal(after.revision, before.revision);
  assert.equal(after.cycles[0].evidenceRevision, 1);
  assert.equal(after.cycles[0].brokerLinkVersions.length, 1);
});

test("trade-window replacement cannot strand a starting snapshot or checkpoint outside the new range", async () => {
  const repository = new MemoryStore();
  const { store } = harness("2026-08-18T00:00:00Z", repository);
  const cycle = await store.createLinkedCycle({
    cycle: {
      type: "trade_window",
      reviewMode: "lightweight",
      symbol: "AAOI.US",
      startAt: "2026-08-01T14:30:00Z",
      endAt: "2026-08-05T21:30:00Z",
      startingPortfolio: {
        snapshotAt: "2026-08-01T14:00:00Z",
        baseCurrency: "USD",
        positions: [],
      },
    },
    links: {
      recordIds: ["order:buy-1"],
      orderIds: ["buy-1"],
      records: [{ id: "order:buy-1", kind: "order", occurredAt: "2026-08-01T14:30:00Z", symbol: "AAOI.US" }],
    },
  });
  await store.addCheckpoint(cycle.id, {
    occurredAt: "2026-08-04T14:30:00Z",
    kind: "reduce",
    action: "减仓",
  });
  const before = await store.snapshot();
  await assert.rejects(store.replaceBrokerRecords(cycle.id, {
    activityStartAt: "2026-08-01T13:30:00Z",
    activityEndAt: "2026-08-05T21:30:00Z",
    recordIds: ["order:early"],
    orderIds: ["early"],
    records: [{ id: "order:early", kind: "order", occurredAt: "2026-08-01T13:30:00Z", symbol: "AAOI.US" }],
  }), /早于既有周期起点组合快照/);
  await assert.rejects(store.replaceBrokerRecords(cycle.id, {
    activityStartAt: "2026-08-01T14:30:00Z",
    activityEndAt: "2026-08-03T21:30:00Z",
    recordIds: ["order:buy-1"],
    orderIds: ["buy-1"],
    records: [{ id: "order:buy-1", kind: "order", occurredAt: "2026-08-01T14:30:00Z", symbol: "AAOI.US" }],
  }), /不能排除既有决策检查点/);
  const after = await store.snapshot();
  assert.equal(after.revision, before.revision);
  const reloaded = await new ReviewCycleStore({ store: repository }).snapshot();
  assert.equal(reloaded.quarantinedCycles.length, 0);
  assert.equal(reloaded.cycles[0].startAt, "2026-08-01T14:30:00.000Z");
  assert.equal(reloaded.cycles[0].endAt, "2026-08-05T21:30:00.000Z");
});

test("legacy cycles with broker links migrate safely to evidence revision one", async () => {
  const source = harness("2026-08-18T00:00:00Z");
  await source.store.createLinkedCycle({
    cycle: {
      type: "trade_window", reviewMode: "lightweight", symbol: "AAOI.US",
      startAt: "2026-08-01T14:30:00Z", endAt: "2026-08-05T21:30:00Z",
    },
    links: {
      recordIds: ["order:legacy-buy"], orderIds: ["legacy-buy"],
      records: [{ id: "order:legacy-buy", kind: "order", occurredAt: "2026-08-01T14:30:00Z", symbol: "AAOI.US" }],
    },
  });
  const raw = await source.repository.get(STORE_KEY);
  delete raw.cycles[0].brokerLinkVersions;
  delete raw.cycles[0].evidenceRevision;
  delete raw.cycles[0].brokerLinks.evidenceRevision;
  delete raw.cycles[0].brokerLinks.revision;
  delete raw.cycles[0].brokerLinks.activityStartAt;
  delete raw.cycles[0].brokerLinks.activityEndAt;
  const migratedStore = new ReviewCycleStore({
    store: new MemoryStore(raw),
    now: () => new Date("2026-08-18T00:00:00Z"),
    idFactory: () => "unused",
  });
  const migrated = (await migratedStore.snapshot()).cycles[0];
  assert.equal(migrated.evidenceRevision, 1);
  assert.equal(migrated.brokerLinks.evidenceRevision, 1);
  assert.equal(migrated.brokerLinkVersions.length, 1);
  assert.equal(migrated.brokerLinkVersions[0].reason, "迁移旧版券商关联");
  assert.deepEqual(migrated.brokerLinkVersions[0].recordIds, ["order:legacy-buy"]);
  assert.equal(migrated.brokerLinkVersions[0].activityStartAt, migrated.startAt);
  assert.equal(migrated.brokerLinkVersions[0].activityEndAt, migrated.endAt);
});

test("retrospective notes are complete, immutable, versioned, and idempotent", async () => {
  let now = "2026-08-18T00:00:00Z";
  const repository = new MemoryStore();
  let id = 0;
  const store = new ReviewCycleStore({
    store: repository,
    now: () => new Date(now),
    idFactory: () => `reflection-${++id}`,
  });
  const cycle = await store.createLinkedCycle({
    cycle: {
      type: "trade_window", reviewMode: "lightweight", symbol: "NVDA.US",
      startAt: "2026-08-01T12:00:00Z", endAt: "2026-08-05T12:00:00Z",
    },
    links: {
      recordIds: ["order:o1"], orderIds: ["o1"],
      records: [{ id: "order:o1", kind: "order", occurredAt: "2026-08-01T12:00:00Z", symbol: "NVDA.US" }],
    },
  });
  await assert.rejects(store.saveRetrospectiveNote({
    cycleId: cycle.id,
    note: { recalledJudgment: "回忆", lesson: "感悟" },
  }), /未来预判/);
  const input = {
    recalledJudgment: "回忆",
    lesson: "感悟",
    forwardHypothesis: "以后只在确认后行动",
  };
  const first = await store.saveRetrospectiveNote({ cycleId: cycle.id, note: input });
  const beforeSame = await store.snapshot();
  now = "2026-08-18T01:00:00Z";
  const same = await store.saveRetrospectiveNote({ cycleId: cycle.id, note: input });
  assert.equal(same.version, first.version);
  const afterSame = await store.snapshot();
  assert.equal(afterSame.revision, beforeSame.revision);
  assert.equal(afterSame.updatedAt, beforeSame.updatedAt);
  assert.equal(afterSame.cycles[0].updatedAt, beforeSame.cycles[0].updatedAt);
  now = "2026-08-18T02:00:00Z";
  const second = await store.saveRetrospectiveNote({
    cycleId: cycle.id,
    note: { ...input, forwardHypothesis: "以后只在量价与风险都确认后行动" },
  });
  assert.equal(second.version, 2);
  const saved = (await store.snapshot()).cycles[0];
  assert.equal(saved.retrospectiveVersions.length, 2);
  assert.equal(saved.retrospectiveVersions[0].snapshot.forwardHypothesis, input.forwardHypothesis);
});

test("direct retrospective refuses cycles without real broker evidence", async () => {
  const { store } = harness("2026-08-18T00:00:00Z");
  const cycle = await store.createCycle({
    type: "trade_window",
    reviewMode: "lightweight",
    symbol: "NVDA.US",
    startAt: "2026-08-01T12:00:00Z",
    endAt: "2026-08-05T12:00:00Z",
  });
  await assert.rejects(
    store.snapshot({ cycleId: cycle.id, phase: "retrospective" }),
    /真实长桥订单或成交/,
  );
});

test("an invalid order-first broker closure leaves no partial cycle behind", async () => {
  const { store } = harness("2026-08-18T00:00:00Z");
  await assert.rejects(
    store.createLinkedCycle({
      cycle: {
        type: "trade_window",
        reviewMode: "lightweight",
        symbol: "NVDA.US",
        startAt: "2026-08-01T12:00:00Z",
        endAt: "2026-08-05T12:00:00Z",
      },
      links: {
        recordIds: ["order:fill-1"],
        orderIds: [],
        executionIds: ["fill-1"],
        records: [{ id: "order:fill-1", kind: "execution", occurredAt: "2026-08-01T12:01:00Z", symbol: "NVDA.US" }],
      },
    }),
    /前缀 .* 与 kind=.* 不一致|原始订单\/成交 ID/,
  );
  const snapshot = await store.snapshot();
  assert.equal(snapshot.cycles.length, 0);
  assert.equal(snapshot.revision, 0);
});

test("a rigorous monthly prediction may be created before any broker activity exists", async () => {
  const { store } = harness("2026-07-20T00:00:00Z");
  const cycle = await store.createLinkedCycle({
    cycle: {
      type: "monthly_portfolio",
      reviewMode: "rigorous",
      month: "2026-08",
      startAt: "2026-07-31T16:00:00Z",
      endAt: "2026-08-31T15:59:59.999Z",
      timezone: "Asia/Shanghai",
      exAnte: completeExAnte(),
    },
    links: { recordIds: [], orderIds: [], executionIds: [], records: [] },
  });
  assert.equal(cycle.reviewMode, "rigorous");
  assert.deepEqual(cycle.brokerLinks.recordIds, []);
  const version = await store.sealCycle({ cycleId: cycle.id });
  assert.equal(version.timing, "ex_ante");
  assert.equal(version.eligibleForFormalStats, true);
});
