import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { validateNumericEvidence } from "../src/engine/numeric-evidence.mjs";
import {
  TIER_B_TECHNICAL_EVIDENCE_SCHEMA_VERSION,
  TierBTechnicalEvidenceInputError,
  buildTierBTechnicalEvidence,
} from "../src/engine/tier-b-technical-evidence.mjs";

const CUTOFF_DATE = "2026-08-28";
const CUTOFF_AT = "2026-08-28T23:30:00.000Z";
const HASH = /^sha256:[a-f0-9]{64}$/;

test("builds a complete, class-separated Tier-B envelope from explicit evidence", () => {
  const input = completeInput();
  const untouched = structuredClone(input);
  const result = buildTierBTechnicalEvidence(input);

  assert.deepEqual(input, untouched);
  assert.equal(result.schemaVersion, TIER_B_TECHNICAL_EVIDENCE_SCHEMA_VERSION);
  assert.equal(result.status, "complete");
  assert.match(result.inputHash, HASH);
  assert.match(result.outputHash, HASH);
  assert.equal(result.cutoff.dailyPolicy, "exact_shared_trade_date_no_forward_fill");
  assert.equal(result.cutoff.knowledgeCutoffAt, CUTOFF_AT);
  assert.equal(result.inference.generated, false);
  assert.equal(result.inference.decisionAuthority, "LLM");

  for (const layer of [
    "daily",
    "weekly",
    "benchmark",
    "execution60m",
    "sector",
    "peers",
    "anchoredVwap",
    "options",
    "catalyst",
  ]) {
    assert.equal(result.observed.capabilities[layer].evidenceClass, "observed");
    assert.equal(result.calculated.capabilities[layer].evidenceClass, "calculated");
    assert.equal(result.inference.capabilities[layer].evidenceClass, "inference");
    assert.match(result.layers[layer].hashes.observed, HASH);
    assert.match(result.layers[layer].hashes.calculated, HASH);
    assert.match(result.layers[layer].hashes.inference, HASH);
  }

  assert.equal(result.calculated.evidence.multiTimeframe.weekly.status, "available");
  assert.equal(result.calculated.evidence.multiTimeframe.execution60m.status, "available");
  assert.equal(result.calculated.evidence.benchmarkRelativeStrength.status, "complete");
  assert.equal(result.calculated.evidence.sectorRelativeStrength.status, "complete");
  assert.equal(result.calculated.evidence.peerRelativeStrength.availablePeerCount, 2);
  assert.equal(result.observed.evidence.peers.count, 2);

  assert.equal(result.observed.evidence.anchoredVwap.anchor.reason, "earnings gap accepted by user");
  assert.equal(result.observed.evidence.anchoredVwap.anchor.source, "user:selected-event");
  assert.equal(result.calculated.evidence.anchoredVwap.method.anchorSelection, "caller_explicit_only");
  assert.equal(result.calculated.evidence.anchoredVwap.priceRelation.state, "above");

  assert.equal(result.calculated.evidence.options.chain.callOpenInterest, 0);
  assert.equal(result.calculated.evidence.options.chain.putOpenInterest, 250);
  assert.equal(result.calculated.evidence.options.chain.putCallOpenInterestRatio, null);
  assert.equal(result.calculated.evidence.options.volatility.ivMinusRvPercentPoints, 18);
  assert.equal(result.calculated.evidence.options.dealerGamma.value, null);
  assert.equal(result.calculated.evidence.options.dealerGamma.display, "N/A");
  assert.ok(result.calculated.evidence.options.dealerGamma.reasonCodes.includes(
    "dealer_gamma_not_inferred_from_open_interest",
  ));
  assert.equal(result.inference.outputs.dealerGamma.value, null);

  assert.equal(result.observed.evidence.catalyst.facts.length, 2);
  assert.equal(result.calculated.evidence.catalyst.occurredByCutoffCount, 1);
  assert.equal(result.calculated.evidence.catalyst.scheduledAfterCutoffCount, 1);
  assert.ok(result.observed.numericEvidence.facts.every((fact) => fact.kind === "observed_fact"));
  assert.ok(result.calculated.numericEvidence.facts.every((fact) => fact.kind === "derived_metric"));
  for (const fact of [
    ...result.observed.numericEvidence.facts,
    ...result.calculated.numericEvidence.facts,
  ]) validateNumericEvidence(fact);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.calculated.evidence), true);
});

test("is deterministic, does not mutate inputs, and remains fast for a full evidence stack", () => {
  const input = completeInput();
  const first = buildTierBTechnicalEvidence(input);
  const startedAt = performance.now();
  let latest = first;
  for (let index = 0; index < 20; index += 1) {
    latest = buildTierBTechnicalEvidence(input);
    assert.deepEqual(latest, first);
  }
  const elapsedMs = performance.now() - startedAt;

  assert.equal(latest.outputHash, first.outputHash);
  assert.ok(elapsedMs < 2_000, `20 full Tier-B runs took ${elapsedMs.toFixed(1)}ms`);
});

test("excludes future bars and post-cutoff catalyst knowledge before hashes and calculations", () => {
  const left = completeInput();
  const right = completeInput();
  addFutureEvidence(left, { close: 999, summary: "future result A" });
  addFutureEvidence(right, { close: 12, summary: "future result B" });

  const first = buildTierBTechnicalEvidence(left);
  const second = buildTierBTechnicalEvidence(right);

  assert.deepEqual(first, second);
  assert.equal(first.calculated.evidence.daily.asOfTradingDate, CUTOFF_DATE);
  assert.equal(first.observed.evidence.daily.ignoredAfterCutoffCount, 1);
  assert.equal(first.observed.evidence.execution60m.ignoredAfterCutoffCount, 1);
  assert.equal(first.observed.evidence.catalyst.ignoredAfterCutoffCount, 1);
  assert.equal(first.observed.evidence.catalyst.facts.some((fact) => (
    fact.summary.includes("future result")
  )), false);

  const lateOptionsA = completeInput();
  const lateOptionsB = completeInput();
  lateOptionsA.options.asOf = "2026-08-29T01:00:00.000Z";
  lateOptionsB.options.asOf = "2026-08-29T01:00:00.000Z";
  lateOptionsA.options.chain[0].openInterest = 9_999;
  lateOptionsB.options.chain[0].openInterest = 1;
  const optionA = buildTierBTechnicalEvidence(lateOptionsA);
  const optionB = buildTierBTechnicalEvidence(lateOptionsB);
  assert.deepEqual(optionA.layers.options, optionB.layers.options);
  assert.deepEqual(optionA.observed.evidence.options, optionB.observed.evidence.options);
  assert.equal(optionA.layers.options.status, "unavailable");
  assert.ok(optionA.layers.options.reasonCodes.includes("options_as_of_after_knowledge_cutoff"));
});

test("requires exact comparator cutoff dates and never forward-fills QQQ, sector, or peers", () => {
  const input = completeInput();
  input.benchmark.daily.bars.pop();
  input.sector.daily.bars.pop();
  input.peers[0].daily.bars.pop();

  const result = buildTierBTechnicalEvidence(input);

  assert.equal(result.status, "unavailable");
  assert.equal(result.layers.benchmark.status, "unavailable");
  assert.equal(result.layers.sector.status, "unavailable");
  assert.equal(result.layers.peers.status, "partial");
  assert.ok(result.observed.evidence.benchmark.reasonCodes.includes(
    "exact_cutoff_bar_missing_no_forward_fill",
  ));
  assert.ok(result.observed.evidence.sector.reasonCodes.includes(
    "exact_cutoff_bar_missing_no_forward_fill",
  ));
  assert.equal(result.calculated.evidence.benchmarkRelativeStrength.value, null);
  assert.equal(result.calculated.evidence.benchmarkRelativeStrength.display, "N/A");
  assert.equal(result.calculated.evidence.sectorRelativeStrength.value, null);
  assert.equal(result.calculated.evidence.sectorRelativeStrength.display, "N/A");
  assert.equal(
    result.calculated.evidence.peerRelativeStrength.items
      .find((item) => item.symbol === "SNDK.US").value,
    null,
  );
});

test("keeps every missing Tier-B layer explicit and does not auto-select AVWAP", () => {
  const target = dailyBars({ count: 220, end: CUTOFF_DATE, base: 100, slope: 0.2 });
  const qqq = dailyBars({ count: 220, end: CUTOFF_DATE, base: 300, slope: 0.1 });
  const result = buildTierBTechnicalEvidence({
    symbol: "MU.US",
    cutoffTradingDate: CUTOFF_DATE,
    knowledgeCutoffAt: CUTOFF_AT,
    daily: descriptor(target, "1D", "target-feed"),
    benchmark: { symbol: "QQQ.US", daily: descriptor(qqq, "1D", "qqq-feed") },
  });

  assert.equal(result.status, "partial");
  for (const layer of ["weekly", "execution60m", "sector", "peers", "anchoredVwap", "options", "catalyst"]) {
    assert.equal(result.layers[layer].status, "unavailable");
    assert.ok(result.layers[layer].reasonCodes.length > 0);
  }
  assert.equal(result.calculated.evidence.multiTimeframe.weekly.status, "unavailable");
  assert.equal(result.calculated.evidence.anchoredVwap.value, null);
  assert.equal(result.calculated.evidence.anchoredVwap.display, "N/A");
  assert.ok(result.layers.anchoredVwap.reasonCodes.includes("explicit_anchor_not_provided"));
  assert.equal(result.calculated.evidence.options.volatility, undefined);
  assert.equal(result.invariants.missingNumericEvidenceIsNullNotZero, true);
});

test("fails invalid peer contracts and degrades explicitly unattested or forming bars", () => {
  const input = completeInput();
  input.peers = input.peers.slice(0, 1);
  assert.throws(
    () => buildTierBTechnicalEvidence(input),
    (error) => error instanceof TierBTechnicalEvidenceInputError
      && error.code === "peer_count_out_of_range",
  );

  const unattested = completeInput();
  unattested.daily.completedBarsOnly = false;
  const unavailable = buildTierBTechnicalEvidence(unattested);
  assert.equal(unavailable.layers.daily.status, "unavailable");
  assert.ok(unavailable.layers.daily.reasonCodes.includes(
    "completed_bars_not_explicitly_attested",
  ));

  const forming = completeInput();
  forming.intraday60m.bars.at(-1).isClosed = false;
  const degraded = buildTierBTechnicalEvidence(forming);
  assert.equal(degraded.layers.execution60m.status, "unavailable");
  assert.ok(degraded.layers.execution60m.reasonCodes.includes("forming_bar_not_allowed"));
});

function completeInput() {
  const target = dailyBars({ count: 520, end: CUTOFF_DATE, base: 100, slope: 0.18 });
  const qqq = dailyBars({ count: 520, end: CUTOFF_DATE, base: 300, slope: 0.1 });
  const sector = dailyBars({ count: 520, end: CUTOFF_DATE, base: 200, slope: 0.14 });
  const sndk = dailyBars({ count: 520, end: CUTOFF_DATE, base: 80, slope: 0.12 });
  const wdc = dailyBars({ count: 520, end: CUTOFF_DATE, base: 70, slope: 0.08 });
  const weekly = intervalBars({
    count: 20,
    endAt: "2026-08-23T21:00:00.000Z",
    stepMs: 7 * 86_400_000,
    base: 100,
    slope: 2,
  });
  const hourly = intervalBars({
    count: 30,
    endAt: "2026-08-28T20:00:00.000Z",
    stepMs: 3_600_000,
    base: 180,
    slope: 0.3,
  });
  const anchorBar = target.at(-35);
  return {
    symbol: "MU.US",
    currency: "USD",
    cutoffTradingDate: CUTOFF_DATE,
    knowledgeCutoffAt: CUTOFF_AT,
    horizon: "swing",
    daily: descriptor(target, "1D", "target-feed"),
    weekly: descriptor(weekly, "1W", "weekly-feed"),
    intraday60m: descriptor(hourly, "60m", "hourly-feed"),
    benchmark: { symbol: "QQQ.US", daily: descriptor(qqq, "1D", "qqq-feed") },
    sector: { symbol: "SMH.US", daily: descriptor(sector, "1D", "sector-feed") },
    peers: [
      { symbol: "SNDK.US", daily: descriptor(sndk, "1D", "peer-feed") },
      { symbol: "WDC.US", daily: descriptor(wdc, "1D", "peer-feed") },
    ],
    anchoredVwap: {
      sourceLayer: "daily",
      anchor: {
        barId: anchorBar.barId,
        timestamp: anchorBar.timestamp,
        reason: "earnings gap accepted by user",
        source: "user:selected-event",
      },
    },
    options: {
      source: "current-option-feed",
      asOf: "2026-08-28T20:15:00.000Z",
      chain: [
        {
          contractSymbol: "MU260918C200",
          expiry: "2026-09-18",
          strike: 200,
          type: "call",
          bid: 5,
          ask: 5.2,
          volume: 100,
          openInterest: 0,
          impliedVolatilityPercent: 62,
        },
        {
          contractSymbol: "MU260918P180",
          expiry: "2026-09-18",
          strike: 180,
          type: "put",
          bid: 4,
          ask: 4.3,
          volume: 90,
          openInterest: 250,
          impliedVolatilityPercent: 64,
        },
      ],
      iv: { valuePercent: 62, horizonDays: 21 },
      rv: { valuePercent: 44, lookbackDays: 20 },
    },
    catalysts: {
      source: "point-in-time-calendar",
      facts: [
        {
          id: "earnings-release",
          type: "earnings",
          knownAt: "2026-08-20T12:00:00.000Z",
          eventAt: "2026-08-27T20:05:00.000Z",
          summary: "Quarterly earnings release scheduled and subsequently occurred.",
          fiscalPeriod: "FY2026-Q4",
        },
        {
          id: "conference",
          type: "investor_conference",
          knownAt: "2026-08-22T12:00:00.000Z",
          eventAt: "2026-09-08T14:00:00.000Z",
          summary: "Management conference was scheduled before the cutoff.",
        },
      ],
    },
  };
}

function addFutureEvidence(input, { close, summary }) {
  for (const series of [
    input.daily,
    input.benchmark.daily,
    input.sector.daily,
    ...input.peers.map((peer) => peer.daily),
  ]) {
    const prior = series.bars.at(-1);
    series.bars.push({
      ...prior,
      barId: `${prior.barId}-future`,
      timestamp: "2026-08-29T21:00:00.000Z",
      tradeDate: "2026-08-29",
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 9_999_999,
    });
  }
  const priorHour = input.intraday60m.bars.at(-1);
  input.intraday60m.bars.push({
    ...priorHour,
    barId: `${priorHour.barId}-future`,
    timestamp: "2026-08-29T01:00:00.000Z",
    tradeDate: "2026-08-29",
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 8_888,
  });
  input.catalysts.facts.push({
    id: "future-unavailable-result",
    type: "news",
    knownAt: "2026-08-29T12:00:00.000Z",
    eventAt: "2026-08-29T11:00:00.000Z",
    summary,
  });
}

function descriptor(bars, interval, source) {
  return {
    bars,
    interval,
    completedBarsOnly: true,
    source,
    fetchedAt: CUTOFF_AT,
    coverage: {
      source,
      complete: true,
      partial: false,
      partialReasons: [],
      fetchedAt: CUTOFF_AT,
      endpoint: "fixture://ohlcv",
      period: interval,
      adjustment: "forward",
      tradeSessions: "intraday",
    },
  };
}

function dailyBars({ count, end, base, slope }) {
  const endDate = new Date(`${end}T00:00:00.000Z`);
  const start = new Date(endDate.getTime() - (count - 1) * 86_400_000);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start.getTime() + index * 86_400_000);
    const tradeDate = date.toISOString().slice(0, 10);
    const close = base + index * slope;
    return {
      barId: `${tradeDate}:daily`,
      timestamp: `${tradeDate}T21:00:00.000Z`,
      tradeDate,
      open: close - 0.25,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000_000 + index * 100,
      isClosed: true,
    };
  });
}

function intervalBars({ count, endAt, stepMs, base, slope }) {
  const end = Date.parse(endAt);
  const start = end - (count - 1) * stepMs;
  return Array.from({ length: count }, (_, index) => {
    const timestamp = new Date(start + index * stepMs).toISOString();
    const close = base + index * slope;
    return {
      barId: `${timestamp}:bar`,
      timestamp,
      tradeDate: timestamp.slice(0, 10),
      open: close - 0.2,
      high: close + 0.8,
      low: close - 0.8,
      close,
      volume: 100_000 + index * 100,
      isClosed: true,
    };
  });
}
