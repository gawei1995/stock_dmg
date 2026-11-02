import { createHash } from "node:crypto";
import { canonicalReviewEvidenceIdentity } from "./review-learning-source.mjs";
import { currentValidationReviewRun } from "./review-validation-candidates.mjs";

export const REVIEW_SET_METRICS_SCHEMA_VERSION = "review-set-metrics/v1";

/**
 * Aggregate only host-verified, non-censored R samples. The model receives the
 * result to interpret; it must never derive win rate or expectancy from a long
 * table of rows itself.
 */
export function buildReviewSetMetrics({ cases = [], cycles = [], tests = [] } = {}) {
  const selectedCaseIds = uniqueStrings(cases.map((item) => item?.id));
  const selectedCycleIds = uniqueStrings(cycles.map((item) => item?.id));
  const caseById = new Map(cases.map((item) => [String(item?.id ?? ""), item]));
  const cycleById = new Map(cycles.map((item) => [String(item?.id ?? ""), item]));
  const eligibleRows = [];
  const exclusions = new Map();

  for (const test of Array.isArray(tests) ? tests : []) {
    const caseId = cleanText(test?.caseId, 200);
    const cycleId = cleanText(test?.reviewCycleId, 200);
    const selectedRecord = cycleId ? cycleById.get(cycleId) : caseById.get(caseId);
    if (!selectedRecord) {
      increment(exclusions, "not_bound_to_selected_case");
      continue;
    }
    const kind = cycleId || selectedRecord.legacySource ? "cycle" : "case";
    const identity = canonicalReviewEvidenceIdentity(selectedRecord, { kind });
    if (!identity.key) { increment(exclusions, identity.reason); continue; }
    if (kind === "cycle" && !currentValidationReviewRun(selectedRecord)) {
      increment(exclusions, "no_current_cycle_phase_run");
      continue;
    }
    if (test?.censored === true) {
      increment(exclusions, "censored");
      continue;
    }
    if (test?.outcomeVerified !== true) {
      increment(exclusions, "outcome_not_host_verified");
      continue;
    }
    const outcomeR = strictFiniteOrNull(test?.outcomeR);
    if (outcomeR == null) {
      increment(exclusions, "net_r_missing_or_invalid");
      continue;
    }
    eligibleRows.push({
      caseId,
      cycleId,
      canonicalEvidenceIdentity: identity,
      testId: cleanText(test?.id, 200),
      outcomeR,
      completedAt: validIsoOrNull(test?.completedAt ?? test?.recordedAt),
    });
  }

  // One statistical unit is one selected decision package. Duplicate rows are
  // usable only when every row has an ordering timestamp and the newest row is
  // unique. Otherwise the case is excluded instead of letting array order pick
  // a financially different outcome.
  const rowsByIdentity = new Map();
  for (const row of eligibleRows) {
    const key = row.canonicalEvidenceIdentity.key;
    if (!rowsByIdentity.has(key)) rowsByIdentity.set(key, []);
    rowsByIdentity.get(key).push(row);
  }
  const samples = [];
  for (const identityKey of [...rowsByIdentity.keys()].sort()) {
    const rows = rowsByIdentity.get(identityKey);
    const crossesAliases = new Set(rows.map((row) => row.cycleId ? `cycle:${row.cycleId}` : `case:${row.caseId}`)).size > 1;
    const duplicateReason = crossesAliases ? "duplicate_evidence_observation" : "duplicate_case_observation";
    if (rows.length === 1) {
      samples.push(rows[0]);
      continue;
    }
    if (rows.some((row) => row.completedAt == null)) {
      incrementBy(exclusions, `${duplicateReason}_order_ambiguous`, rows.length);
      continue;
    }
    const newestTimestamp = Math.max(...rows.map((row) => timestamp(row.completedAt)));
    const newest = rows.filter((row) => timestamp(row.completedAt) === newestTimestamp);
    if (newest.length !== 1) {
      incrementBy(exclusions, `${duplicateReason}_order_ambiguous`, rows.length);
      continue;
    }
    samples.push(newest[0]);
    incrementBy(exclusions, `${duplicateReason}_superseded`, rows.length - 1);
  }
  const values = samples.map((item) => item.outcomeR).sort((left, right) => left - right);
  const wins = values.filter((value) => value > 0);
  const losses = values.filter((value) => value < 0);
  const flats = values.filter((value) => value === 0);
  const grossProfit = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  const averageWinR = wins.length ? mean(wins) : null;
  const averageLossR = losses.length ? Math.abs(mean(losses)) : null;
  const payoffRatio = averageWinR != null && averageLossR > 0
    ? averageWinR / averageLossR
    : null;

  const body = {
    schemaVersion: REVIEW_SET_METRICS_SCHEMA_VERSION,
    methodVersion: "verified-one-sample-per-canonical-decision-package/v3",
    status: values.length ? "available" : "unavailable",
    sampleUnit: "selected_decision_package",
    sampleSetHash: hash({
      selectedCaseIds,
      selectedCycleIds,
      samples: samples.map(({ caseId, cycleId, canonicalEvidenceIdentity, testId, outcomeR }) => ({
        caseId, cycleId, canonicalEvidenceKey: canonicalEvidenceIdentity.key, testId, outcomeR,
      })),
    }),
    sampleFunnel: {
      selectedCaseCount: selectedCaseIds.length,
      selectedCycleCount: selectedCycleIds.length,
      deliveredTestCount: Array.isArray(tests) ? tests.length : 0,
      verifiedUniqueSampleCount: values.length,
      excludedCount: [...exclusions.values()].reduce((total, value) => total + value, 0),
      exclusionReasons: Object.fromEntries([...exclusions.entries()].sort()),
    },
    facts: {
      sampleCount: fact(values.length, scalar("count")),
      winCount: fact(wins.length, scalar("count")),
      lossCount: fact(losses.length, scalar("count")),
      flatCount: fact(flats.length, scalar("count")),
      winRate: factOrUnknown(values.length ? wins.length / values.length * 100 : null, percent("verified_samples")),
      averageWinR: factOrUnknown(averageWinR, rUnit()),
      averageLossR: factOrUnknown(averageLossR, rUnit()),
      payoffRatio: factOrUnknown(payoffRatio, ratio("average_win_r / average_loss_r")),
      expectancyR: factOrUnknown(values.length ? mean(values) : null, rUnit()),
      profitFactor: factOrUnknown(
        grossLoss > 0 ? grossProfit / grossLoss : null,
        ratio("gross_positive_r / absolute_gross_negative_r"),
        grossProfit > 0 && grossLoss === 0 ? "no_verified_loss_sample" : null,
      ),
      medianR: factOrUnknown(values.length ? median(values) : null, rUnit()),
      worstR: factOrUnknown(values.length ? values[0] : null, rUnit()),
      tailLossRate: factOrUnknown(
        values.length ? values.filter((value) => value < -1).length / values.length * 100 : null,
        percent("verified_samples_below_minus_1r"),
      ),
    },
    samples: samples.map((item) => ({
      caseId: item.caseId,
      reviewCycleId: item.cycleId,
      canonicalEvidenceIdentity: item.canonicalEvidenceIdentity,
      testId: item.testId,
      outcomeR: round(item.outcomeR),
      unit: rUnit(),
    })),
    invariants: {
      modelMustNotRecalculate: true,
      unknownIsNotZero: true,
      mixedCurrenciesAggregated: false,
      oneSamplePerDecisionPackage: true,
      legacyMigrationDoesNotCreateIndependentSample: true,
    },
  };
  return Object.freeze({ ...body, resultHash: hash(body) });
}

function fact(value, unit) {
  return { availability: "known", value: round(value), unit };
}

function factOrUnknown(value, unit, reason = null) {
  return value == null
    ? { availability: "unknown", value: null, unit, reason: reason ?? "insufficient_verified_samples" }
    : fact(value, unit);
}

function scalar(label) {
  return { kind: "scalar", label };
}

function percent(basis) {
  return { kind: "percent_point", basis };
}

function ratio(basis) {
  return { kind: "ratio", basis };
}

function rUnit() {
  return { kind: "scalar", label: "R_multiple" };
}

function strictFiniteOrNull(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validIsoOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function timestamp(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function mean(values) {
  return sum(values) / values.length;
}

function median(values) {
  const middle = Math.floor(values.length / 2);
  return values.length % 2
    ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean))].sort();
}

function cleanText(value, limit) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, limit) : null;
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function incrementBy(map, key, count) {
  map.set(key, (map.get(key) ?? 0) + count);
}

function hash(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
