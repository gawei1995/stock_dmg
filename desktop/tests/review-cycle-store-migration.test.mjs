import assert from "node:assert/strict";
import test from "node:test";
import { ReviewCycleStore } from "../src/data/review-cycle-store.mjs";
import { buildLegacyCaseMigration, normalizeReviewEventMetadata } from "../src/review/review-case-migration.mjs";

const KEY = "reviewCyclesV1";
const SCOPE = "lb:account-0001";
const NOW = "2026-09-15T12:00:00Z";

class MemoryStore {
  constructor() { this.values = new Map(); this.writes = 0; this.beforeCommit = null; }
  async get(key) { return structuredClone(this.values.get(key)); }
  async set(key, value, { commitGuard } = {}) {
    await this.beforeCommit?.();
    if (commitGuard && commitGuard() !== true) throw new Error("scope changed at commit");
    this.values.set(key, structuredClone(value));
    this.writes += 1;
  }
}

function fixture() {
  const reviewCase = {
    id: "legacy-aaoi", symbol: "AAOI.US", fiscalQuarter: "FY2026 Q2", benchmark: "QQQ.US",
    eventAt: "2026-08-06T00:00:00Z", eventDate: "2026-08-06", eventTimePrecision: "session", eventSession: "amc", timezone: "America/New_York",
    eventMetadata: { source: "longbridge_calendar", status: "matched", confidence: "high", eventCandidateId: "calendar-aaoi-q2" },
    exAnteDraft: { myView: "当时判断：订单增长", marketView: "市场预期已高", plannedAction: "买100，财报后卖20", invalidation: "收入落后预期" },
    brokerLinks: { accountScopeId: SCOPE, revision: 2, orderIds: ["buy-1", "sell-2"], executionIds: ["fill-1", "fill-2"] },
    brokerLinkVersions: [
      { revision: 1, changedAt: "2026-08-08T12:00:00Z", accountScopeId: SCOPE, orderIds: ["buy-1"], executionIds: ["fill-1"] },
      { revision: 2, changedAt: "2026-08-09T12:00:00Z", accountScopeId: SCOPE, orderIds: ["buy-1", "sell-2"], executionIds: ["fill-1", "fill-2"] },
    ],
    exAnteVersions: [{ version: 1, sealedAt: "2026-08-05T12:00:00Z", hash: "legacy-seal-hash", snapshot: { myView: "历史封存原文" } }],
    outcome: { actualSummary: "旧结果", t5ReturnPercent: 4.5 }, review: { nextTrigger: "旧复盘记录" },
    updatedAt: "2026-08-10T12:00:00Z", archived: false,
  };
  const records = [
    { recordId: "order:buy-1", kind: "order", symbol: "AAOI.US", side: "BUY", quantity: 100, price: 20, currency: "USD", status: "Filled", activityAt: "2026-08-05T15:00:00Z" },
    { recordId: "execution:fill-1", kind: "execution", relatedOrderRecordId: "order:buy-1", symbol: "AAOI.US", side: "BUY", quantity: 100, price: 20, currency: "USD", activityAt: "2026-08-05T15:01:00Z" },
    { recordId: "order:sell-2", kind: "order", symbol: "AAOI.US", side: "SELL", quantity: 20, price: 23, currency: "USD", status: "Filled", activityAt: "2026-08-07T00:15:00Z" },
    { recordId: "execution:fill-2", kind: "execution", relatedOrderRecordId: "order:sell-2", symbol: "AAOI.US", side: "SELL", quantity: 20, price: 23, currency: "USD", activityAt: "2026-08-07T00:15:01Z" },
  ];
  return { reviewCase, selection: { accountScopeId: SCOPE, records, recordIds: records.map((item) => item.recordId), requestedRecordIds: records.map((item) => item.recordId) } };
}

function harness() {
  const repository = new MemoryStore();
  let id = 0;
  const store = new ReviewCycleStore({ store: repository, now: () => new Date(NOW), idFactory: () => `cycle-${++id}` });
  return { repository, store };
}
function prepare(values = fixture(), extra = {}) { return buildLegacyCaseMigration({ ...values, accountScopeId: SCOPE, now: NOW, ...extra }); }
function migrate(store, migration, extra = {}) { return store.migrateLegacyCase({ migration, expectedSourceHash: migration.preview.sourceHash, confirmed: true, ...extra }); }

test("legacy preparation hashes case, association versions and full resolved numeric evidence but not preparation time", () => {
  const input = fixture();
  const untouched = structuredClone(input);
  const first = prepare(input);
  assert.deepEqual(input, untouched);
  assert.equal(first.preview.sourceHash, prepare(input, { now: "2026-09-16T00:00:00Z" }).preview.sourceHash);
  assert.equal(first.preview.recordCount, 4);
  assert.equal(first.preview.orderCount, 2);
  assert.equal(first.preview.executionCount, 2);
  for (const change of [
    (value) => { value.reviewCase.exAnteDraft.myView = "重新判断"; },
    (value) => { value.reviewCase.brokerLinkVersions[1].reason = "另一关联版本"; },
    (value) => { value.selection.records[1].price = 21; },
    (value) => { value.selection.records[1].quantity = 90; },
    (value) => { value.selection.records[1].side = "SELL"; },
  ]) {
    const altered = structuredClone(input); change(altered);
    assert.notEqual(first.preview.sourceHash, prepare(altered).preview.sourceHash);
  }
});

test("migration is explicit, atomic, concurrent-idempotent and leaves the original case unchanged", async () => {
  const { store, repository } = harness();
  const original = fixture();
  const untouched = structuredClone(original);
  const migration = prepare(original);
  await assert.rejects(migrate(store, migration, { confirmed: false }), /明确确认/);
  const results = await Promise.all([migrate(store, migration), migrate(store, migration)]);
  assert.equal(results.filter((item) => item.created).length, 1);
  assert.equal(results[0].cycle.id, results[1].cycle.id);
  assert.equal(repository.writes, 1);
  assert.deepEqual(original, untouched);
  const cycle = (await store.snapshot()).cycles[0];
  assert.equal(cycle.status, "draft");
  assert.equal(cycle.reviewMode, "lightweight");
  assert.equal(cycle.retrospectiveDraft.recalledJudgment, original.reviewCase.exAnteDraft.myView);
  assert.equal(cycle.retrospectiveDraft.lesson, null);
  assert.equal(cycle.retrospectiveDraft.forwardHypothesis, null);
  assert.equal(cycle.exAnteDraft.myView, null);
  assert.deepEqual(cycle.exAnteVersions, []);
  assert.deepEqual(cycle.retrospectiveVersions, []);
  assert.deepEqual(cycle.phaseRuns, { blind: [], outcome: [], retrospective: [] });
  assert.deepEqual(cycle.legacySource.originalJudgment, original.reviewCase.exAnteDraft);
  assert.deepEqual(cycle.legacySource.associationVersions, original.reviewCase.brokerLinkVersions);
  assert.equal(cycle.legacySource.sealedVersionReferences[0].hash, "legacy-seal-hash");
  assert.equal(cycle.legacySource.resultReferences.length, 2);
  assert.equal(cycle.legacySource.sampleSourceIdentity, "case:legacy-aaoi");
  assert.equal(cycle.brokerLinks.records[0].occurredAt != null, true);
  await assert.rejects(store.snapshot({ cycleId: cycle.id, phase: "retrospective" }), /完整的判断/);
});

test("date/session metadata survives reload without fabricated midnight catalyst timestamps", async () => {
  const { store } = harness();
  const { cycle } = await migrate(store, prepare());
  assert.equal(cycle.cycleType, "catalyst");
  assert.equal(cycle.catalystAt, null);
  assert.equal(cycle.eventMetadata.eventAt, null);
  assert.equal(cycle.eventMetadata.eventDate, "2026-08-06");
  assert.equal(cycle.eventMetadata.timePrecision, "session");
  assert.equal(cycle.eventMetadata.session, "amc");
  assert.equal(cycle.eventMetadata.fiscalQuarter, "FY2026 Q2");
  assert.equal(cycle.eventMetadata.eventCandidateId, "calendar-aaoi-q2");
  assert.equal(cycle.eventMetadata.symbol, "AAOI.US");
  assert.equal(cycle.endAt, "2026-08-07T03:59:59.999Z");
  assert.deepEqual((await store.snapshot()).cycles[0].eventMetadata, cycle.eventMetadata);
});

test("legacy missing precision never promotes a placeholder timestamp and event day ranges preserve the declared zone", () => {
  const missing = fixture(); delete missing.reviewCase.eventTimePrecision;
  const migration = prepare(missing);
  assert.equal(migration.cycle.eventMetadata.timePrecision, "date");
  assert.equal(migration.cycle.catalystAt, null);
  const utc = fixture(); utc.reviewCase.timezone = "UTC";
  assert.equal(prepare(utc).cycle.eventMetadata.timezone, "UTC");
  const unsupported = fixture(); unsupported.reviewCase.timezone = "Invalid/Zone";
  assert.throws(() => prepare(unsupported), /时区无效/);
  assert.throws(() => normalizeReviewEventMetadata({ eventAt: "2026-08-06T20:00:00", timePrecision: "exact" }), /时区/);
});

test("stale source hash and modified migration payload are rejected before writes", async () => {
  const { store, repository } = harness();
  const original = prepare();
  const freshInput = fixture(); freshInput.selection.records[0].price = 22;
  const fresh = prepare(freshInput);
  await assert.rejects(migrate(store, fresh, { expectedSourceHash: original.preview.sourceHash }), /重新预览/);
  const altered = structuredClone(original); altered.cycle.retrospectiveNote.lesson = "伪造感悟";
  await assert.rejects(migrate(store, altered), /重新预览/);
  assert.equal(repository.writes, 0);
  assert.equal((await store.snapshot()).cycles.length, 0);
});

test("migration refuses unbound, mismatched and mixed-account evidence and missing selections", () => {
  const cases = [
    (input) => { input.reviewCase.brokerLinks.accountScopeId = null; },
    (input) => { input.reviewCase.brokerLinks.accountScopeId = "lb:other-account"; },
    (input) => { input.selection.accountScopeId = "lb:other-account"; },
    (input) => { input.selection.records[0].accountScopeId = "lb:other-account"; },
    (input) => { input.reviewCase.brokerLinkVersions[0].accountScopeId = "lb:other-account"; },
    (input) => { input.selection.records.pop(); },
    (input) => { input.selection.requestedRecordIds = ["order:new-holding"]; },
    (input) => { input.selection.records[0].activityAt = null; },
  ];
  for (const change of cases) { const input = fixture(); change(input); assert.throws(() => prepare(input)); }
});

test("already migrated previews remain openable when the historical archive is unavailable", async () => {
  const { store, repository } = harness();
  const first = await migrate(store, prepare());
  const existingCycles = (await store.snapshot()).cycles;
  const preview = prepare({ reviewCase: fixture().reviewCase, selection: null }, { existingCycles });
  assert.equal(preview.preview.existingCycleId, first.cycle.id);
  assert.equal(preview.cycle, null);
  assert.equal((await migrate(store, preview)).created, false);
  assert.equal(repository.writes, 1);
});

test("store failure and authorization change at the persistent commit leave no partial cycle or links", async () => {
  const { store, repository } = harness();
  const migration = prepare();
  repository.beforeCommit = () => { throw new Error("disk failure"); };
  await assert.rejects(migrate(store, migration), /disk failure/);
  assert.equal((await store.snapshot()).cycles.length, 0);
  let current = true;
  repository.beforeCommit = () => { current = false; };
  await assert.rejects(migrate(store, migration, { commitGuard: () => current }), /scope changed/);
  assert.equal((await store.snapshot()).cycles.length, 0);
  assert.equal(repository.writes, 0);
  current = true; repository.beforeCommit = null;
  assert.equal((await migrate(store, migration, { commitGuard: () => current })).created, true);
});

test("linked creation forwards a strict synchronous commit guard to the persistent store", async () => {
  const { store, repository } = harness();
  const migration = prepare();
  let current = true;
  repository.beforeCommit = () => { current = false; };
  await assert.rejects(store.createLinkedCycle({ cycle: migration.cycle, links: migration.links, commitGuard: () => current }), /scope changed/);
  assert.equal(repository.writes, 0);
  repository.beforeCommit = null;
  await assert.rejects(store.createLinkedCycle({ cycle: migration.cycle, links: migration.links, commitGuard: async () => true }), /授权已变化/);
});

test("missing real event dates migrate to trade windows instead of inventing an earnings event", async () => {
  const { store } = harness();
  const input = fixture(); input.reviewCase.eventDate = null;
  const migration = prepare(input);
  assert.equal(migration.cycle.cycleType, "trade_window");
  assert.equal(migration.cycle.catalystAt, null);
  assert.equal(migration.cycle.startAt, "2026-08-05T15:00:00.000Z");
  assert.equal(migration.cycle.endAt, "2026-08-07T00:15:01.000Z");
  assert.equal((await migrate(store, migration)).cycle.cycleType, "trade_window");
});

test("new catalyst cycles allow date-only lightweight review but rigorous review still requires an exact timestamp", async () => {
  const { store } = harness();
  const input = { cycleType: "catalyst", symbols: ["AAOI.US"], startAt: "2026-08-05T00:00:00Z", endAt: "2026-08-08T00:00:00Z", timezone: "America/New_York", eventMetadata: { eventDate: "2026-08-06", timePrecision: "date", session: "amc", fiscalQuarter: "FY2026 Q2" } };
  await assert.rejects(store.create(input), /catalystAt/);
  const lightweight = await store.create({ ...input, reviewMode: "lightweight", catalystAt: "2026-08-06T00:00:00Z" });
  assert.equal(lightweight.catalystAt, null);
  assert.equal(lightweight.eventMetadata.fiscalQuarter, "FY2026 Q2");
  await assert.rejects(store.create({ ...input, reviewMode: "lightweight", eventMetadata: { timePrecision: "date" } }), /真实事件日期/);
  await assert.rejects(store.create({ ...input, eventMetadata: null, catalystAt: "2026-08-06" }), /真实时分/);
  assert.throws(() => normalizeReviewEventMetadata({ eventDate: "2026-02-30", timePrecision: "date" }), /日期无效/);
});

test("exact event metadata is retained in sealed snapshots with valid integrity", async () => {
  const { store } = harness();
  const cycle = await store.create({ cycleType: "catalyst", symbols: ["AAOI.US"], startAt: "2026-08-05T00:00:00Z", endAt: "2026-08-08T00:00:00Z", catalystAt: "2026-08-06T20:15:00Z", timezone: "America/New_York", eventMetadata: { eventDate: "2026-08-06", timePrecision: "exact", session: "amc", fiscalQuarter: "FY2026 Q2" } });
  await store.seal(cycle.id);
  const reloaded = (await store.snapshot()).cycles[0];
  assert.equal(reloaded.exAnteVersions[0].integrityStatus, "valid");
  assert.equal(reloaded.exAnteVersions[0].snapshot.eventMetadata.eventAt, "2026-08-06T20:15:00.000Z");
});

test("duplicate persisted legacy sources are quarantined instead of counted twice", async () => {
  const { store, repository } = harness();
  await migrate(store, prepare());
  const raw = await repository.get(KEY);
  raw.cycles.push({ ...structuredClone(raw.cycles[0]), id: "duplicate-cycle" });
  repository.values.set(KEY, raw);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.cycles.length, 1);
  assert.equal(snapshot.quarantinedCycles[0].reason, "duplicate_legacy_source");
  await assert.rejects(migrate(store, prepare()), /已隔离/);
});

test("lightweight catalyst reselection expands the selected range, versions evidence and makes prior analysis stale", async () => {
  const { store } = harness();
  const { cycle } = await migrate(store, prepare());
  const metadata = structuredClone(cycle.eventMetadata);
  await store.saveRetrospectiveNote(cycle.id, { recalledJudgment: "当时看好订单", lesson: "持仓时间长于财报日", forwardHypothesis: "观察更长样本" });
  const oldView = await store.snapshot({ cycleId: cycle.id, phase: "retrospective" });
  const oldRun = await store.recordPhaseRun({ cycleId: cycle.id, phase: "retrospective", expectedEvidenceRevision: 1, expectedRetrospectiveVersion: 1, expectedInputSnapshotHash: oldView.snapshotHash, result: { conclusion: "原区间分析" } });
  const links = prepare().links;
  const lastRecord = { recordId: "execution:fill-3", kind: "execution", symbol: "AAOI.US", occurredAt: "2026-08-20T15:00:00Z" };
  await store.replaceBrokerRecords(cycle.id, {
    ...links, recordIds: [...links.recordIds, lastRecord.recordId], executionIds: [...links.executionIds, "fill-3"],
    requestedRecordIds: [...links.requestedRecordIds, lastRecord.recordId], records: [...links.records, lastRecord],
    activityStartAt: cycle.startAt, activityEndAt: "2026-08-20T15:00:00Z",
  });
  const updated = (await store.snapshot()).cycles[0];
  assert.equal(updated.endAt, "2026-08-20T15:00:00.000Z");
  assert.equal(updated.brokerLinkVersions.length, 2);
  assert.equal(updated.evidenceRevision, 2);
  assert.equal(updated.phaseRuns.retrospective.length, 1);
  assert.deepEqual(updated.eventMetadata, metadata);
  assert.equal((await store.validatePhaseRunSource(cycle.id, oldRun.id)).status, "stale");
  assert.notEqual((await store.snapshot({ cycleId: cycle.id, phase: "retrospective" })).snapshotHash, oldView.snapshotHash);
});

test("reselection cannot exclude the original event date or rewrite a rigorous catalyst range", async () => {
  const { store, repository } = harness();
  const migration = prepare();
  const { cycle } = await migrate(store, migration);
  const before = await repository.get(KEY);
  await assert.rejects(store.replaceBrokerRecords(cycle.id, { ...migration.links, activityStartAt: "2026-08-05T00:00:00Z", activityEndAt: "2026-08-06T22:00:00Z", requestedRecordIds: ["order:buy-1"] }), /原事件日期/);
  assert.deepEqual(await repository.get(KEY), before);
  const rigorous = await store.create({ cycleType: "catalyst", symbol: "AAOI.US", startAt: "2026-08-05T00:00:00Z", catalystAt: "2026-08-06T20:00:00Z", endAt: "2026-08-08T00:00:00Z" });
  await assert.rejects(store.replaceBrokerRecords(rigorous.id, { ...migration.links, activityStartAt: cycle.startAt, activityEndAt: cycle.endAt }), /只有订单区间或轻量/);
});

test("lightweight catalyst replacement preserves checkpoint constraints and old sealed facts", async () => {
  const { store } = harness();
  const migration = prepare();
  const { cycle } = await migrate(store, migration);
  await store.seal(cycle.id);
  const sealBefore = (await store.snapshot()).cycles[0].exAnteVersions[0];
  await store.addCheckpoint(cycle.id, { occurredAt: "2026-08-05T16:00:00Z", decision: "保留此时的决策", kind: "observation" });
  await assert.rejects(store.replaceBrokerRecords(cycle.id, { ...migration.links, requestedRecordIds: ["order:sell-2"], activityStartAt: "2026-08-06T04:00:00Z", activityEndAt: cycle.endAt }), /检查点/);
  await store.replaceBrokerRecords(cycle.id, { ...migration.links, activityStartAt: cycle.startAt, activityEndAt: "2026-08-10T00:00:00Z" });
  assert.deepEqual((await store.snapshot()).cycles[0].exAnteVersions[0], sealBefore);
});

test("link and replacement aliases retain the authorization guard at final storage commit", async () => {
  for (const method of ["linkCycleRecords", "replaceCycleBrokerRecords"]) {
    const { store, repository } = harness();
    const migration = prepare();
    const { cycle } = await migrate(store, migration);
    const before = await repository.get(KEY);
    let current = true;
    repository.beforeCommit = () => { current = false; };
    await assert.rejects(store[method]({ cycleId: cycle.id, ...migration.links,
      records: [...migration.links.records, { recordId: "execution:new", kind: "execution", symbol: "AAOI.US", occurredAt: "2026-08-06T15:00:00Z" }],
      commitGuard: () => current,
    }), /scope changed/);
    assert.deepEqual(await repository.get(KEY), before);
  }
});
