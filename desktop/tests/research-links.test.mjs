import test from "node:test";
import assert from "node:assert/strict";
import { ResearchThesisStore } from "../src/data/research-thesis-store.mjs";
import { assertResearchReviewLink, buildLinkedResearchReferences, eligibleResearchReviewCycles } from "../src/review/research-links.mjs";

function fixture() {
  const values = new Map(); let sequence = 0;
  const store = new ResearchThesisStore({ store: {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value, options) => { options?.commitGuard?.(); values.set(key, structuredClone(value)); },
  }, now: () => new Date("2026-10-22T08:00:00Z"), idFactory: () => `test-${++sequence}` });
  return { store };
}

test("research association eligibility never borrows another account or cancelled review", () => {
  const a = { id: "a", title: "AAPL", symbols: ["AAPL.US"], brokerLinks: { accountScopeId: "scope-a" } };
  const b = { ...a, id: "b", brokerLinks: { accountScopeId: "scope-b" } };
  const cancelled = { ...a, id: "cancelled", status: "cancelled" };
  assert.deepEqual(eligibleResearchReviewCycles([a, b, cancelled], "scope-a").map(x => x.id), ["a"]);
  assert.deepEqual(eligibleResearchReviewCycles([a], null), []);
  assert.equal(assertResearchReviewLink({ thesis: { symbol: "AAPL.US" }, cycle: a, accountScopeId: "scope-a" }), true);
  assert.equal(assertResearchReviewLink({ thesis: { symbol: "AAPL" }, cycle: a, accountScopeId: "scope-a" }), true);
  assert.equal(assertResearchReviewLink({ thesis: { symbol: "NASDAQ:AAPL" }, cycle: a, accountScopeId: "scope-a" }), true);
  assert.throws(() => assertResearchReviewLink({ thesis: { symbol: "AAPL.HK" }, cycle: a, accountScopeId: "scope-a" }), /不一致/);
  assert.throws(() => assertResearchReviewLink({ thesis: { symbol: "MSFT.US" }, cycle: a, accountScopeId: "scope-a" }), /研究标的.*不一致/);
  assert.throws(() => assertResearchReviewLink({ thesis: {}, cycle: b, accountScopeId: "scope-a" }), /订单归属/);
});

test("linked review delivers exact recorded research rather than latest rewritten belief", async () => {
  const { store } = fixture();
  let thesis = await store.create({ name: "AAPL demand", symbol: "AAPL.US", myView: "original belief" });
  thesis = await store.linkReview(thesis.id, { expectedRevision: thesis.revision, confirmed: true,
    cycleId: "cycle-a", cycleTitle: "AAPL trade", accountScopeId: "scope-a" });
  const hash = thesis.reviewLinks[0].contextHash;
  thesis = await store.revise(thesis.id, { expectedRevision: thesis.revision, myView: "later outcome-contaminated view" });
  const result = buildLinkedResearchReferences({ theses: [thesis], cycleId: "cycle-a", accountScopeId: "scope-a", phase: "retrospective" });
  assert.equal(result.items[0].context.fields.myView, "original belief");
  assert.equal(result.items[0].contextHash, hash);
  assert.equal(result.items[0].thesisVersion, 1);
  assert.match(result.interpretation, /不改变正式评分资格/);
  result.items[0].context.fields.myView = "detached";
  assert.equal(thesis.reviewLinks[0].contextSnapshot.fields.myView, "original belief");
});

test("blind phase physically omits all research associations, later claims and source dates", () => {
  const secret = { reviewLinks: [{ cycleId: "cycle", accountScopeId: "scope", contextSnapshot: { futureOutcome: 999 } }] };
  assert.equal(buildLinkedResearchReferences({ theses: [secret], cycleId: "cycle", accountScopeId: "scope", phase: "blind" }), null);
  assert.equal(buildLinkedResearchReferences({ theses: [], cycleId: "cycle", accountScopeId: "scope", phase: "outcome" }), null);
  assert.equal(buildLinkedResearchReferences({ theses: [secret], cycleId: "other", accountScopeId: "scope", phase: "outcome" }), null);
});

test("bounded research references disclose omitted records and reject missing immutable source", () => {
  const theses = Array.from({ length: 7 }, (_, i) => ({ id: `thesis-${i}`, reviewLinks: [{ cycleId: "cycle", accountScopeId: "scope",
    linkedAt: `2026-10-${String(i + 10).padStart(2, "0")}T00:00:00Z`, thesisVersion: 1,
    contextHash: `hash-${i}`, contextSnapshot: { fields: { myView: `claim-${i}` } } }] }));
  const result = buildLinkedResearchReferences({ theses, cycleId: "cycle", accountScopeId: "scope", phase: "outcome", maxItems: 2 });
  assert.deepEqual(result.coverage, { sourceCount: 7, deliveredCount: 2, omittedCount: 5,
    omittedByItemLimit: 5, omittedBySize: 0, maxChars: 16_000 });
  assert.equal(result.items[0].thesisId, "thesis-6");
  const malformed = structuredClone(theses); delete malformed[0].reviewLinks[0].contextHash;
  assert.throws(() => buildLinkedResearchReferences({ theses: malformed, cycleId: "cycle", accountScopeId: "scope", phase: "outcome" }), /指纹/);
});

test("linked research limits aggregate size without cutting snapshots or hiding omissions", () => {
  const theses = Array.from({ length: 4 }, (_, i) => ({ id: `thesis-${i}`, reviewLinks: [{ cycleId: "cycle", accountScopeId: "scope",
    linkedAt: `2026-10-${String(i + 10).padStart(2, "0")}T00:00:00Z`, thesisVersion: 1,
    contextHash: `hash-${i}`, contextSnapshot: { fields: { myView: "claim".repeat(1400) } } }] }));
  const result = buildLinkedResearchReferences({ theses, cycleId: "cycle", accountScopeId: "scope", phase: "outcome", maxChars: 9000 });
  assert.equal(result.coverage.sourceCount, 4);
  assert.equal(result.coverage.deliveredCount, 1);
  assert.equal(result.coverage.omittedBySize, 3);
  assert.ok(JSON.stringify(result.items).length <= 9000);
  assert.equal(result.items[0].context.fields.myView.length, 7000);
});
