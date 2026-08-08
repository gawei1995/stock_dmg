import assert from "node:assert/strict";
import test from "node:test";
import { EvidenceRegistry } from "../src/review/evidence/registry.mjs";

test("evidence providers are optional and failures do not block other evidence", async () => {
  const registry = new EvidenceRegistry([
    {
      id: "market-structure",
      version: "2",
      supports: () => true,
      async collect() {
        return {
          type: "technical",
          asOf: "2026-08-08T20:00:00.000Z",
          quality: "verified",
          source: "closed OHLCV",
          features: { relativeStrength: 1.2, chipDistribution: "concentrated" },
        };
      },
    },
    {
      id: "optional-ema-fib",
      async collect() { throw new Error("indicator unavailable"); },
    },
  ]);
  const evidence = await registry.collect({ symbol: "NVDA.US" });
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].features.chipDistribution, "concentrated");
  assert.equal(evidence[0].providerId, "market-structure");
  assert.equal(evidence[1].status, "failed");
  assert.match(evidence[1].limitation, /indicator unavailable/);
  assert.equal(evidence.every((item) => /^[a-f0-9]{64}$/.test(item.contentHash)), true);
});
