import { createHash, randomUUID } from "node:crypto";

const STORE_KEY = "reviewWorkspaceV1";
const SCHEMA_VERSION = 1;
const CASE_STATUSES = new Set([
  "draft",
  "frozen",
  "event_occurred",
  "review_due",
  "reviewed",
  "closed",
  "retrospective",
  "cancelled",
]);
const RULE_STATUSES = new Set([
  "hypothesis",
  "testing",
  "provisional",
  "validated",
  "retired",
]);
const RULE_TRANSITIONS = Object.freeze({
  hypothesis: new Set(["testing", "retired"]),
  testing: new Set(["provisional", "retired"]),
  provisional: new Set(["validated", "testing", "retired"]),
  validated: new Set(["testing", "retired"]),
  retired: new Set(["testing"]),
});

/** Durable local ledger for the Review → Test → Rule → Review loop. */
export class ReviewStore {
  constructor({ store, now = () => new Date(), idFactory = randomUUID }) {
    this.store = store;
    this.now = now;
    this.idFactory = idFactory;
    this.queue = Promise.resolve();
  }

  async snapshot() {
    const value = await this.store.get(STORE_KEY);
    return normalizeWorkspace(value);
  }

  async createCase(input) {
    return this.#mutate((workspace) => {
      const now = this.now().toISOString();
      const reviewCase = buildReviewCase({
        id: this.idFactory(),
        now,
        input,
        eventAt: requiredIso(input?.eventAt, "财报时间无效。"),
        origin: "manual",
      });
      workspace.cases.unshift(reviewCase);
      return reviewCase;
    });
  }

  /**
   * Host-only constructor for an order-first review. The Electron main process
   * must resolve these values from the encrypted broker archive before calling
   * this method; renderer-provided symbols and timestamps are never accepted.
   */
  async createCaseFromBrokerRecords(input) {
    return this.#mutate((workspace) => {
      const now = this.now().toISOString();
      const activityStartAt = requiredIso(input?.activityStartAt, "长桥记录开始时间无效。");
      const activityEndAt = requiredIso(input?.activityEndAt, "长桥记录结束时间无效。");
      if (Date.parse(activityStartAt) > Date.parse(activityEndAt)) {
        throw new Error("长桥记录时间范围无效。");
      }
      const eventAt = optionalIso(input?.event?.eventAt);
      const reviewCase = buildReviewCase({
        id: this.idFactory(),
        now,
        input: {
          symbol: input?.symbol,
          fiscalQuarter: input?.event?.fiscalQuarter,
          eventDate: input?.event?.eventDate,
          eventTimePrecision: input?.event?.eventTimePrecision,
          eventSession: input?.event?.eventSession,
          timezone: input?.event?.timezone,
          strategyType: input?.strategyType,
          benchmark: input?.benchmark,
          primaryHorizon: input?.primaryHorizon,
          exAnte: input?.exAnte,
        },
        eventAt,
        origin: "longbridge_records",
        brokerLinks: {
          orderIds: uniqueIds(input?.orderIds),
          executionIds: uniqueIds(input?.executionIds),
          confirmedAt: now,
        },
        brokerActivity: {
          startAt: activityStartAt,
          endAt: activityEndAt,
          recordCount: uniqueIds(input?.recordIds).length,
          symbols: uniqueSymbols(input?.relatedSymbols ?? [input?.symbol]),
        },
        eventMetadata: {
          status: enumValue(input?.eventAssociation?.status, [
            "matched", "needs_confirmation", "unavailable",
          ], eventAt ? "matched" : "needs_confirmation"),
          source: cleanText(input?.eventAssociation?.source, 120),
          confidence: enumValue(input?.eventAssociation?.confidence, ["high", "candidate", "low"], null),
          eventCandidateId: cleanId(input?.event?.eventCandidateId),
          message: cleanText(input?.eventAssociation?.message, 500),
        },
      });
      workspace.cases.unshift(reviewCase);
      return reviewCase;
    });
  }

  async updateCase(caseId, patch) {
    return this.#mutate((workspace) => {
      const reviewCase = requiredCase(workspace, caseId);
      // For order-first cases these fields are host-derived broker/event facts.
      // The renderer may echo their current readonly values, but it cannot
      // rewrite them through a crafted update payload.
      if (reviewCase.origin !== "longbridge_records") {
        if (patch?.symbol != null) reviewCase.symbol = requiredSymbol(patch.symbol);
        if (patch?.fiscalQuarter != null) reviewCase.fiscalQuarter = cleanText(patch.fiscalQuarter, 40) || reviewCase.fiscalQuarter;
        if (patch?.eventAt != null) {
          reviewCase.eventAt = requiredIso(patch.eventAt, "财报时间无效。");
          reviewCase.eventDate = reviewCase.eventAt.slice(0, 10);
          reviewCase.eventTimePrecision = "exact";
        }
        if (patch?.eventSession != null) reviewCase.eventSession = enumValue(patch.eventSession, ["bmo", "amc", "intraday", "unknown"], reviewCase.eventSession);
      }
      if (patch?.strategyType != null) reviewCase.strategyType = enumValue(patch.strategyType, [
        "pre_add", "pre_hold", "pre_reduce", "pre_hedge", "post_confirm_entry", "post_reversal_exit", "other",
      ], reviewCase.strategyType);
      if (patch?.benchmark != null) reviewCase.benchmark = cleanText(patch.benchmark, 40) || reviewCase.benchmark;
      if (patch?.primaryHorizon != null) reviewCase.primaryHorizon = enumValue(patch.primaryHorizon, ["t1", "t3", "t5", "t20", "next_quarter"], reviewCase.primaryHorizon);
      if (patch?.exAnte) reviewCase.exAnteDraft = normalizeExAnte({ ...reviewCase.exAnteDraft, ...patch.exAnte });
      if (patch?.outcome) reviewCase.outcome = normalizeOutcome({ ...reviewCase.outcome, ...patch.outcome });
      if (patch?.review) reviewCase.review = normalizeReview({ ...reviewCase.review, ...patch.review });
      if (patch?.status != null) {
        const status = enumValue(patch.status, [...CASE_STATUSES], null);
        if (!status) throw new Error("复盘案例状态无效。");
        reviewCase.status = status;
      }
      reviewCase.updatedAt = this.now().toISOString();
      return reviewCase;
    });
  }

  async freezeCase(caseId, { reason = "用户封存财报前计划" } = {}) {
    return this.#mutate((workspace) => {
      const reviewCase = requiredCase(workspace, caseId);
      if (["cancelled", "closed"].includes(reviewCase.status)) {
        throw new Error("已取消或关闭的案例不能封存新版本。");
      }
      if (!reviewCase.eventAt || !Number.isFinite(Date.parse(reviewCase.eventAt))) {
        throw new Error("财报事件尚未确认，不能封存为事前计划。");
      }
      const sealedAt = this.now().toISOString();
      const snapshot = {
        symbol: reviewCase.symbol,
        fiscalQuarter: reviewCase.fiscalQuarter,
        eventAt: reviewCase.eventAt,
        eventDate: reviewCase.eventDate,
        eventTimePrecision: reviewCase.eventTimePrecision,
        eventSession: reviewCase.eventSession,
        timezone: reviewCase.timezone,
        strategyType: reviewCase.strategyType,
        benchmark: reviewCase.benchmark,
        primaryHorizon: reviewCase.primaryHorizon,
        exAnte: normalizeExAnte(reviewCase.exAnteDraft),
      };
      validateExAnteSnapshot(snapshot.exAnte);
      const eligibleForFormalStats = isConservativelyExAnte(sealedAt, reviewCase);
      const version = {
        version: reviewCase.exAnteVersions.length + 1,
        sealedAt,
        reason: cleanText(reason, 240) || "用户封存财报前计划",
        timing: eligibleForFormalStats ? "ex_ante" : "retrospective",
        eligibleForFormalStats,
        hash: sha256(stableStringify(snapshot)),
        snapshot,
      };
      reviewCase.exAnteVersions.push(version);
      reviewCase.status = version.eligibleForFormalStats ? "frozen" : "retrospective";
      reviewCase.updatedAt = sealedAt;
      return version;
    });
  }

  async linkBrokerRecords(caseId, { orderIds = [], executionIds = [] } = {}) {
    return this.#mutate((workspace) => {
      const reviewCase = requiredCase(workspace, caseId);
      reviewCase.brokerLinks = {
        orderIds: uniqueIds(orderIds),
        executionIds: uniqueIds(executionIds),
        confirmedAt: this.now().toISOString(),
      };
      reviewCase.updatedAt = reviewCase.brokerLinks.confirmedAt;
      return reviewCase.brokerLinks;
    });
  }

  async registerTest(input) {
    return this.#mutate((workspace) => {
      const now = this.now().toISOString();
      const caseId = cleanId(input?.caseId);
      if (caseId) requiredCase(workspace, caseId);
      const ruleId = cleanId(input?.ruleId);
      if (ruleId) requiredRule(workspace, ruleId);
      const primaryHorizon = enumValue(input?.primaryHorizon, ["t1", "t3", "t5", "t20", "next_quarter"], "t5");
      if (caseId && ruleId && workspace.tests.some((item) =>
        item.caseId === caseId
        && item.ruleId === ruleId
        && item.primaryHorizon === primaryHorizon
        && item.status !== "cancelled")) {
        throw new Error("同一财报案例、规则和主评价窗口只能登记一个独立样本。");
      }
      const test = {
        id: this.idFactory(),
        caseId,
        ruleId,
        title: cleanText(input?.title, 160) || "未命名测试",
        hypothesis: cleanText(input?.hypothesis, 2_000),
        primaryMetric: enumValue(input?.primaryMetric, [
          "net_r",
          "relative_return",
          "drawdown",
          "hedge_value",
          "win_rate",
          "payoff_ratio",
          "expectancy_r",
          "mae_r",
          "mfe_r",
          "action_adherence",
          "invalidation_latency",
          "peak_gross_exposure",
        ], "net_r"),
        primaryHorizon,
        status: "registered",
        registeredAt: now,
        completedAt: null,
        outcomeR: null,
        outcomeSource: null,
        outcomeVerified: false,
        benchmarkReturnPercent: null,
        notes: cleanText(input?.notes, 2_000),
        censored: false,
      };
      workspace.tests.unshift(test);
      if (ruleId) {
        const rule = requiredRule(workspace, ruleId);
        if (!rule.testIds.includes(test.id)) rule.testIds.push(test.id);
      }
      return test;
    });
  }

  async completeTest(testId, input) {
    return this.#mutate((workspace) => {
      const test = requiredTest(workspace, testId);
      test.censored = Boolean(input?.censored);
      test.outcomeR = test.censored ? null : finiteOrNull(input?.outcomeR);
      if (!test.censored && test.outcomeR == null) throw new Error("完成测试需要有效的净 R 结果。");
      test.benchmarkReturnPercent = finiteOrNull(input?.benchmarkReturnPercent);
      // Renderer-entered outcomes are always observational. A future
      // deterministic outcome engine must use a separate host-only path;
      // accepting a client-provided "broker_engine" flag would let manual
      // inputs bypass the formal rule-promotion gate.
      test.outcomeSource = "manual";
      test.outcomeVerified = false;
      test.notes = cleanText(input?.notes, 2_000) || test.notes;
      test.status = test.censored ? "censored" : "completed";
      test.completedAt = this.now().toISOString();
      return test;
    });
  }

  async createRule(input) {
    return this.#mutate((workspace) => {
      const now = this.now().toISOString();
      const rule = {
        id: this.idFactory(),
        title: cleanText(input?.title, 160) || "未命名候选规则",
        condition: cleanText(input?.condition, 2_000),
        action: cleanText(input?.action, 2_000),
        falsification: cleanText(input?.falsification, 2_000),
        scope: cleanText(input?.scope, 1_000),
        status: "hypothesis",
        version: 1,
        createdAt: now,
        updatedAt: now,
        testIds: [],
        caseIds: uniqueIds(input?.caseIds),
        history: [{ at: now, from: null, to: "hypothesis", reason: "建立候选规则" }],
      };
      workspace.rules.unshift(rule);
      for (const caseId of rule.caseIds) {
        const reviewCase = requiredCase(workspace, caseId);
        if (!reviewCase.ruleIds.includes(rule.id)) reviewCase.ruleIds.push(rule.id);
      }
      return rule;
    });
  }

  async transitionRule(ruleId, { status, reason }) {
    return this.#mutate((workspace) => {
      const rule = requiredRule(workspace, ruleId);
      const next = enumValue(status, [...RULE_STATUSES], null);
      if (!next || !RULE_TRANSITIONS[rule.status]?.has(next)) {
        throw new Error(`规则不能从 ${rule.status} 转为 ${status}。`);
      }
      const metrics = calculateRuleMetrics(workspace, rule.id);
      if (next === "provisional" && (metrics?.verifiedSampleCount ?? 0) < 20) {
        throw new Error("暂行原则至少需要 20 个由确定性引擎核验的独立事件样本。");
      }
      if (next === "validated" && (metrics?.verifiedSampleCount ?? 0) < 50) {
        throw new Error("已验证规则至少需要 50 个由确定性引擎核验的独立事件样本。");
      }
      if (["provisional", "validated"].includes(next) && !(metrics?.verifiedExpectancyR > 0)) {
        throw new Error("规则的已核验样本净期望值尚未大于 0，不能晋升。");
      }
      const at = this.now().toISOString();
      rule.history.push({
        at,
        from: rule.status,
        to: next,
        reason: cleanText(reason, 1_000) || "人工复核后调整",
      });
      rule.status = next;
      rule.version += 1;
      rule.updatedAt = at;
      return rule;
    });
  }

  async addRuleReview(ruleId, input) {
    return this.#mutate((workspace) => {
      const rule = requiredRule(workspace, ruleId);
      const now = this.now().toISOString();
      const review = {
        id: this.idFactory(),
        ruleId: rule.id,
        ruleVersion: rule.version,
        decision: enumValue(input?.decision, ["keep", "change", "retire"], "keep"),
        evidence: cleanText(input?.evidence, 4_000),
        change: cleanText(input?.change, 2_000),
        nextTrigger: cleanText(input?.nextTrigger, 2_000),
        reviewedAt: now,
      };
      workspace.ruleReviews.unshift(review);
      rule.updatedAt = now;
      return review;
    });
  }

  async #mutate(operation) {
    const mutation = this.queue.then(async () => {
      const workspace = await this.snapshot();
      const result = operation(workspace);
      workspace.updatedAt = this.now().toISOString();
      await this.store.set(STORE_KEY, workspace);
      return structuredClone(result);
    });
    this.queue = mutation.catch(() => {});
    return mutation;
  }
}

export function calculateRuleMetrics(workspace, ruleId) {
  const rule = (workspace?.rules ?? []).find((item) => item.id === ruleId);
  if (!rule) return null;
  const eligibleTests = (workspace?.tests ?? [])
    .filter((item) => item.ruleId === ruleId && item.status === "completed" && !item.censored)
    .filter((item) => {
      if (!item.caseId) return true;
      const reviewCase = (workspace?.cases ?? []).find((candidate) => candidate.id === item.caseId);
      return reviewCase?.exAnteVersions?.some((version) => version.eligibleForFormalStats) === true;
    });
  const onePerEvent = new Map();
  for (const item of eligibleTests) {
    const sampleKey = item.caseId || item.id;
    const current = onePerEvent.get(sampleKey);
    if (!current || Date.parse(item.completedAt ?? "") > Date.parse(current.completedAt ?? "")) {
      onePerEvent.set(sampleKey, item);
    }
  }
  const values = [...onePerEvent.values()]
    .map((item) => item.outcomeR)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const verifiedValues = [...onePerEvent.values()]
    .filter((item) => item.outcomeVerified === true)
    .map((item) => item.outcomeR)
    .filter(Number.isFinite);
  const wins = values.filter((value) => value > 0);
  const losses = values.filter((value) => value < 0);
  const grossProfit = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  const averageWinR = wins.length ? round(sum(wins) / wins.length) : null;
  const averageLossR = losses.length ? round(Math.abs(sum(losses) / losses.length)) : null;
  const payoffRatio = averageWinR != null && averageLossR > 0
    ? round(averageWinR / averageLossR)
    : null;
  return {
    ruleId,
    sampleCount: values.length,
    verifiedSampleCount: verifiedValues.length,
    manualSampleCount: values.length - verifiedValues.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRatePercent: values.length ? round(wins.length / values.length * 100) : null,
    averageWinR,
    averageLossR,
    medianWinR: wins.length ? round(median(wins)) : null,
    medianLossR: losses.length ? round(Math.abs(median(losses))) : null,
    payoffRatio,
    breakEvenWinRatePercent: payoffRatio != null
      ? round(100 / (1 + payoffRatio))
      : null,
    expectancyR: values.length ? round(sum(values) / values.length) : null,
    verifiedExpectancyR: verifiedValues.length
      ? round(sum(verifiedValues) / verifiedValues.length)
      : null,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : grossProfit > 0 ? null : 0,
    medianR: values.length ? round(median(values)) : null,
    worstR: values.length ? round(values[0]) : null,
    tailLossRatePercent: values.length
      ? round(values.filter((value) => value < -1).length / values.length * 100)
      : null,
    evidenceLabel: verifiedValues.length < 20
      ? values.length > verifiedValues.length
        ? "观察性发现 · 含待核验人工结果"
        : "观察性发现"
      : verifiedValues.length < 50
        ? "可评估暂行原则"
        : "可进入正式规则稳定性复核",
  };
}

function normalizeWorkspace(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION) {
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: null,
      cases: [],
      tests: [],
      rules: [],
      ruleReviews: [],
    };
  }
  return structuredClone({
    schemaVersion: SCHEMA_VERSION,
    updatedAt: value.updatedAt ?? null,
    cases: Array.isArray(value.cases) ? value.cases : [],
    tests: Array.isArray(value.tests) ? value.tests : [],
    rules: Array.isArray(value.rules) ? value.rules : [],
    ruleReviews: Array.isArray(value.ruleReviews) ? value.ruleReviews : [],
  });
}

function buildReviewCase({
  id,
  now,
  input,
  eventAt,
  origin,
  brokerLinks = { orderIds: [], executionIds: [], confirmedAt: null },
  brokerActivity = null,
  eventMetadata = null,
}) {
  return {
    id,
    origin,
    symbol: requiredSymbol(input?.symbol),
    fiscalQuarter: cleanText(input?.fiscalQuarter, 40) || "待确认季度",
    eventAt,
    eventDate: cleanDate(input?.eventDate) || eventAt?.slice(0, 10) || null,
    eventTimePrecision: enumValue(input?.eventTimePrecision, ["exact", "session", "date"], origin === "manual" ? "exact" : "date"),
    eventSession: enumValue(input?.eventSession, ["bmo", "amc", "intraday", "unknown"], "unknown"),
    timezone: cleanText(input?.timezone, 80) || "America/New_York",
    strategyType: enumValue(input?.strategyType, [
      "pre_add",
      "pre_hold",
      "pre_reduce",
      "pre_hedge",
      "post_confirm_entry",
      "post_reversal_exit",
      "other",
    ], "other"),
    benchmark: cleanText(input?.benchmark, 40) || "QQQ.US",
    primaryHorizon: enumValue(input?.primaryHorizon, ["t1", "t3", "t5", "t20", "next_quarter"], "t5"),
    status: "draft",
    createdAt: now,
    updatedAt: now,
    exAnteDraft: normalizeExAnte(input?.exAnte),
    exAnteVersions: [],
    outcome: normalizeOutcome(null),
    review: normalizeReview(null),
    brokerLinks,
    brokerActivity,
    eventMetadata,
    ruleIds: [],
    archived: false,
  };
}

function normalizeExAnte(value) {
  return {
    myView: cleanText(value?.myView, 6_000),
    marketView: cleanText(value?.marketView, 6_000),
    expectationGap: cleanText(value?.expectationGap, 4_000),
    narrativeStage: cleanText(value?.narrativeStage, 40),
    marketTemperature: finiteOrNull(value?.marketTemperature),
    technicalEvidence: cleanText(value?.technicalEvidence, 6_000),
    supportingEvidence: cleanText(value?.supportingEvidence, 6_000),
    contradictingEvidence: cleanText(value?.contradictingEvidence, 6_000),
    plannedAction: cleanText(value?.plannedAction, 4_000),
    invalidation: cleanText(value?.invalidation, 4_000),
    riskBudgetR: finiteOrNull(value?.riskBudgetR),
    bullProbability: boundedProbability(value?.bullProbability),
    baseProbability: boundedProbability(value?.baseProbability),
    bearProbability: boundedProbability(value?.bearProbability),
    bullPayoffR: finiteOrNull(value?.bullPayoffR),
    basePayoffR: finiteOrNull(value?.basePayoffR),
    bearPayoffR: finiteOrNull(value?.bearPayoffR),
  };
}

function normalizeOutcome(value) {
  return {
    actualSummary: cleanText(value?.actualSummary, 6_000),
    marketReaction: cleanText(value?.marketReaction, 4_000),
    t1ReturnPercent: finiteOrNull(value?.t1ReturnPercent),
    t5ReturnPercent: finiteOrNull(value?.t5ReturnPercent),
    t20ReturnPercent: finiteOrNull(value?.t20ReturnPercent),
    benchmarkReturnPercent: finiteOrNull(value?.benchmarkReturnPercent),
    netR: finiteOrNull(value?.netR),
    maeR: finiteOrNull(value?.maeR),
    mfeR: finiteOrNull(value?.mfeR),
    actionAdherencePercent: boundedPercent(value?.actionAdherencePercent),
    invalidationLatencyMinutes: nonNegativeOrNull(value?.invalidationLatencyMinutes),
    peakGrossExposurePercent: boundedPercent(value?.peakGrossExposurePercent, 200),
    planViolationCount: nonNegativeIntegerOrNull(value?.planViolationCount),
    censored: Boolean(value?.censored),
  };
}

function normalizeReview(value) {
  return {
    thesisQuality: cleanText(value?.thesisQuality, 2_000),
    marketBeliefRead: cleanText(value?.marketBeliefRead, 2_000),
    sizing: cleanText(value?.sizing, 2_000),
    protection: cleanText(value?.protection, 2_000),
    execution: cleanText(value?.execution, 2_000),
    discipline: cleanText(value?.discipline, 2_000),
    keep: cleanText(value?.keep, 2_000),
    change: cleanText(value?.change, 2_000),
    nextTrigger: cleanText(value?.nextTrigger, 2_000),
    doNotOverlearn: cleanText(value?.doNotOverlearn, 2_000),
  };
}

function validateExAnteSnapshot(value) {
  const missing = [
    ["myView", "我的判断"],
    ["marketView", "市场预期"],
    ["plannedAction", "计划动作"],
    ["invalidation", "失效条件"],
  ].filter(([key]) => !value[key]).map(([, label]) => label);
  if (missing.length) throw new Error(`封存前请补全：${missing.join("、")}。`);
  const probabilities = [value.bullProbability, value.baseProbability, value.bearProbability];
  const supplied = probabilities.filter((item) => item != null);
  if (supplied.length !== 0 && supplied.length !== 3) {
    throw new Error("牛/基准/熊概率必须同时填写或全部留空。");
  }
  if (supplied.length === 3 && Math.abs(sum(supplied) - 100) > 0.01) {
    throw new Error("牛/基准/熊概率合计必须为 100%。");
  }
}

function requiredCase(workspace, id) {
  const value = workspace.cases.find((item) => item.id === String(id ?? ""));
  if (!value) throw new Error("未找到复盘案例。");
  return value;
}

function requiredRule(workspace, id) {
  const value = workspace.rules.find((item) => item.id === String(id ?? ""));
  if (!value) throw new Error("未找到规则。");
  return value;
}

function requiredTest(workspace, id) {
  const value = workspace.tests.find((item) => item.id === String(id ?? ""));
  if (!value) throw new Error("未找到测试。");
  return value;
}

function requiredSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9._:-]{1,40}$/.test(symbol)) throw new Error("标的代码无效。");
  return symbol;
}

function requiredIso(value, message) {
  const millis = Date.parse(String(value ?? ""));
  if (!Number.isFinite(millis)) throw new Error(message);
  return new Date(millis).toISOString();
}

function optionalIso(value) {
  if (value == null || value === "") return null;
  const millis = Date.parse(String(value));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function isConservativelyExAnte(sealedAt, reviewCase) {
  if (!reviewCase.eventTimePrecision || reviewCase.eventTimePrecision === "exact") {
    return Date.parse(sealedAt) < Date.parse(reviewCase.eventAt);
  }
  const eventDate = cleanDate(reviewCase.eventDate) || reviewCase.eventAt?.slice(0, 10);
  if (!eventDate) return false;
  // A date/session-only calendar entry does not identify the exact release
  // timestamp. Treat same-local-day snapshots as retrospective rather than
  // awarding false ex-ante eligibility.
  return dateInTimezone(sealedAt, reviewCase.timezone) < eventDate;
}

function dateInTimezone(value, timezone) {
  const date = new Date(value);
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function cleanDate(value) {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function enumValue(value, choices, fallback) {
  return choices.includes(value) ? value : fallback;
}

function cleanText(value, limit) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, limit) : null;
}

function cleanId(value) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 160) : null;
}

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(cleanId).filter(Boolean))].slice(0, 2_000);
}

function uniqueSymbols(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((item) => String(item ?? "").trim().toUpperCase())
    .filter((item) => /^[A-Z0-9._:-]{1,40}$/.test(item)))].slice(0, 100);
}

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedProbability(value) {
  const number = finiteOrNull(value);
  return number == null ? null : Math.min(Math.max(number, 0), 100);
}

function boundedPercent(value, maximum = 100) {
  const number = finiteOrNull(value);
  return number == null ? null : Math.min(Math.max(number, 0), maximum);
}

function nonNegativeOrNull(value) {
  const number = finiteOrNull(value);
  return number == null ? null : Math.max(number, 0);
}

function nonNegativeIntegerOrNull(value) {
  const number = nonNegativeOrNull(value);
  return number == null ? null : Math.trunc(number);
}

function median(values) {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}
