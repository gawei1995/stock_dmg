import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmedTechnicalLinkage,
  TechnicalLinkageStore,
} from "../src/data/technical-linkage-store.mjs";

test("technical linkage uses only user-confirmed profiles for deterministic requests", async () => {
  const profiles = new TechnicalLinkageStore({ store: memoryStore() });
  await profiles.propose({
    symbol: "nvda",
    sectorSymbol: "smh",
    peerSymbols: ["AMD", "AVGO", "AMD.US"],
    rationale: "model suggestion",
    proposedAt: "2026-08-31T01:00:00Z",
  });
  const proposed = await profiles.get("NVDA.US");
  assert.equal(proposed.state, "proposed");
  assert.equal(confirmedTechnicalLinkage(proposed), null);

  await profiles.confirm({
    symbol: "NVDA.US",
    sectorSymbol: "SMH.US",
    peerSymbols: ["AVGO.US", "AMD.US"],
    rationale: "user checked the comparison set",
    confirmedAt: "2026-08-31T02:00:00Z",
  });
  const confirmed = await profiles.get("NVDA");
  assert.equal(confirmed.state, "confirmed");
  assert.equal(confirmed.source, "user_confirmed");
  assert.deepEqual(confirmed.peerSymbols, ["AMD.US", "AVGO.US"]);
  assert.equal(confirmedTechnicalLinkage(confirmed).inputHash, confirmed.inputHash);
});

test("a model proposal cannot overwrite a confirmed linkage", async () => {
  const profiles = new TechnicalLinkageStore({ store: memoryStore() });
  const confirmedState = await profiles.confirm({
    symbol: "MU",
    sectorSymbol: "SMH",
    peerSymbols: ["WDC", "STX"],
    confirmedAt: "2026-08-31T02:00:00Z",
  });
  const revision = confirmedState.revision;
  const afterProposal = await profiles.propose({
    symbol: "MU.US",
    sectorSymbol: "QQQ",
    peerSymbols: ["AAPL"],
    proposedAt: "2026-08-31T03:00:00Z",
  });
  assert.equal(afterProposal.revision, revision);
  assert.equal((await profiles.get("MU")).sectorSymbol, "SMH.US");
});

test("technical linkage refuses empty, oversized, duplicate and invalid state", async () => {
  const backing = memoryStore();
  const profiles = new TechnicalLinkageStore({ store: backing, maxProfiles: 1 });
  await assert.rejects(
    profiles.confirm({ symbol: "AAPL", confirmedAt: "2026-08-31T01:00:00Z" }),
    (error) => error.code === "technical_linkage_empty",
  );
  await assert.rejects(
    profiles.confirm({
      symbol: "AAPL",
      sectorSymbol: "XLK",
      peerSymbols: ["MSFT"],
      confirmedAt: "2026-08-31T01:00:00Z",
    }),
    (error) => error.code === "technical_linkage_peer_group_too_small",
  );
  await assert.rejects(
    profiles.confirm({
      symbol: "AAPL",
      peerSymbols: ["MSFT", "GOOG", "META", "AMZN", "NVDA", "AMD"],
      confirmedAt: "2026-08-31T01:00:00Z",
    }),
    (error) => error.code === "technical_linkage_peer_limit_reached",
  );
  await profiles.confirm({
    symbol: "AAPL",
    sectorSymbol: "XLK",
    confirmedAt: "2026-08-31T01:00:00Z",
  });
  await assert.rejects(
    profiles.confirm({ symbol: "MSFT", sectorSymbol: "XLK", confirmedAt: "2026-08-31T02:00:00Z" }),
    (error) => error.code === "technical_linkage_limit_reached",
  );
  await assert.rejects(
    profiles.confirm({ symbol: "../secret", sectorSymbol: "XLK", confirmedAt: "2026-08-31T02:00:00Z" }),
    (error) => error.code === "technical_symbol_invalid",
  );
});

test("technical linkage hash is deterministic and removal is idempotent", async () => {
  const profiles = new TechnicalLinkageStore({ store: memoryStore() });
  await profiles.confirm({
    symbol: "GOOG",
    sectorSymbol: "XLC",
    peerSymbols: ["META", "MSFT"],
    confirmedAt: "2026-08-31T01:00:00Z",
  });
  const first = await profiles.get("GOOG.US");
  await profiles.confirm({
    symbol: "GOOG.US",
    sectorSymbol: "XLC.US",
    peerSymbols: ["MSFT.US", "META.US"],
    confirmedAt: "2026-08-31T01:00:00Z",
  });
  assert.equal((await profiles.get("GOOG")).inputHash, first.inputHash);
  const once = await profiles.remove("GOOG", { removedAt: "2026-08-31T03:00:00Z" });
  const twice = await profiles.remove("GOOG", { removedAt: "2026-08-31T04:00:00Z" });
  assert.deepEqual(once, twice);
});

function memoryStore() {
  const values = new Map();
  return {
    async get(key) { return structuredClone(values.get(key)); },
    async set(key, value) { values.set(key, structuredClone(value)); },
  };
}
