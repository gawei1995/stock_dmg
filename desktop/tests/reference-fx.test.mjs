import assert from "node:assert/strict";
import test from "node:test";
import { findConversionRate } from "../src/data/normalize.mjs";
import {
  ECB_REFERENCE_FX_URL,
  EcbReferenceFxProvider,
  fetchEcbReferenceRates,
  parseEcbReferenceRates,
} from "../src/data/reference-fx.mjs";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01">
  <Cube>
    <Cube time='2026-07-17'>
      <Cube currency='USD' rate='1.1435'/>
      <Cube currency='HKD' rate='8.9653'/>
      <Cube currency='CNY' rate='7.7501'/>
      <Cube currency='SGD' rate='1.4765'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

test("parses ECB euro reference XML into cross-currency graph inputs", () => {
  const result = parseEcbReferenceRates(XML);
  assert.equal(result.asOf, "2026-07-17");
  assert.equal(result.exchanges.length, 4);
  assert.ok(
    Math.abs(findConversionRate("HKD", "USD", result) - (1.1435 / 8.9653)) < 1e-12,
  );
  assert.ok(
    Math.abs(findConversionRate("CNY", "USD", result) - (1.1435 / 7.7501)) < 1e-12,
  );
});

test("fetches and stamps the latest official ECB reference snapshot", async () => {
  const seen = [];
  const result = await fetchEcbReferenceRates({
    now: () => Date.parse("2026-07-19T08:00:00.000Z"),
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      return { ok: true, status: 200, async text() { return XML; } };
    },
  });
  assert.equal(seen[0].url, ECB_REFERENCE_FX_URL);
  assert.equal(seen[0].options.method, "GET");
  assert.equal(result.providerCode, "ECB");
  assert.equal(result.asOf, "2026-07-17");
  assert.equal(result.fetchedAt, "2026-07-19T08:00:00.000Z");
  assert.equal(result.usage, "reference_only");
});

test("provider caches a successful ECB snapshot and reuses a fresh cache on failure", async () => {
  let cached = null;
  let shouldFail = false;
  const provider = new EcbReferenceFxProvider({
    now: () => Date.parse("2026-07-19T08:00:00.000Z"),
    readCache: async () => cached,
    writeCache: async (value) => { cached = value; },
    fetchImpl: async () => {
      if (shouldFail) throw new Error("offline");
      return { ok: true, status: 200, async text() { return XML; } };
    },
  });

  const fresh = await provider.latest();
  assert.equal(fresh.status, "reference");
  assert.equal(cached.providerCode, "ECB");

  shouldFail = true;
  const fallback = await provider.latest();
  assert.equal(fallback.status, "reference_cached");
  assert.equal(fallback.asOf, "2026-07-17");
  assert.match(fallback.cacheWarning, /offline/);
});

test("provider rejects an expired cache when ECB cannot be reached", async () => {
  const stale = {
    ...parseEcbReferenceRates(XML),
    provider: "European Central Bank",
    providerCode: "ECB",
    fetchedAt: "2026-07-10T08:00:00.000Z",
    sourceUrl: ECB_REFERENCE_FX_URL,
    usage: "reference_only",
  };
  const provider = new EcbReferenceFxProvider({
    now: () => Date.parse("2026-07-27T08:00:00.000Z"),
    readCache: async () => stale,
    fetchImpl: async () => { throw new Error("offline"); },
  });
  await assert.rejects(provider.latest(), /无法获取 ECB 最新参考汇率.*offline/);
});

test("ECB fetch has a bounded timeout", async () => {
  await assert.rejects(
    fetchEcbReferenceRates({
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    }),
    /timed out after 5ms/,
  );
});

test("parser rejects malformed or incomplete ECB payloads", () => {
  assert.throws(() => parseEcbReferenceRates(""), /empty XML/);
  assert.throws(
    () => parseEcbReferenceRates("<Cube time='2026-07-17'><Cube currency='HKD' rate='8'/></Cube>"),
    /USD rate/,
  );
});
