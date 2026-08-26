import { createHash, randomUUID } from "node:crypto";

const STORE_KEY = "reviewWorkspaceV1";
const SCHEMA_VERSION = 1;
const NO_MUTATION = Symbol("review-store-no-mutation");
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
      if (!hasBrokerLinkSelection(reviewCase.brokerLinks)) {
        throw new Error("复盘案例至少需要关联一笔长桥订单或成交。");
      }
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

  async replaceBrokerRecords(caseId, {
    orderIds = [],
    executionIds = [],
    reason = "更新关联订单与成交",
  } = {}) {
    return this.#mutate((workspace) => {
      const reviewCase = requiredCase(workspace, caseId);
      const selection = normalizeBrokerLinkSelection({ orderIds, executionIds });
      if (!hasBrokerLinkSelection(selection)) {
        throw new Error("复盘案例至少需要关联一笔长桥订单或成交。");
      }
      if (sameBrokerLinkSelection(reviewCase.brokerLinks, selection)) {
        return noMutation(reviewCase.brokerLinks);
      }
      const changedAt = this.now().toISOString();
      const revision = nextBrokerLinkRevision(reviewCase.brokerLinkVersions);
      const previous = reviewCase.brokerLinkVersions.at(-1) ?? null;
      if (previous) {
        previous.supersededBy = revision;
        previous.supersededAt = changedAt;
      }
      const version = buildBrokerLinkVersion({
        revision,
        changedAt,
        reason,
        ...selection,
      });
      reviewCase.brokerLinkVersions.push(version);
      reviewCase.brokerLinks = brokerLinksFromVersion(version);
      reviewCase.updatedAt = changedAt;
      return reviewCase.brokerLinks;
    });
  }

  async updateBrokerRecords(caseId, input = {}) {
    return this.replaceBrokerRecords(caseId, input);
  }

  async linkBrokerRecords(caseId, input = {}) {
    return this.replaceBrokerRecords(caseId, input);
  }

  /** Atomically turns an Agent proposal into a linked candidate rule + test. */
  async acceptLearningProposal(input = {}) {
    return this.#mutate((workspace) => {
      if (input?.confirmed !== true) throw new Error("AI 验证草案必须由用户明确确认后才能登记。");
      const now = this.now().toISOString();
      const proposal = normalizeLearningProposal(input?.proposal);
      const sourceProposal = normalizeLearningProposal(input?.sourceProposal ?? input?.proposal);
      const sourceReviewCycleId = cleanId(input?.reviewCycleId ?? input?.cycleId);
      const sourceRunId = cleanId(input?.runId);
      const sourcePhaseRunId = cleanId(input?.sourcePhaseRunId);
      const sourceEvidenceRevision = nonNegativeIntegerOrNull(input?.sourceEvidenceRevision) || null;
      const sourceRetrospectiveVersion = nonNegativeIntegerOrNull(input?.sourceRetrospectiveVersion) || null;
      if (!sourceReviewCycleId || !sourceRunId) {
        throw new Error("AI 验证草案必须绑定可核验的复盘周期与运行结果。");
      }
      const proposalHash = sha256(stableStringify(proposal));
      const sourceProposalHash = sha256(stableStringify(sourceProposal));
      const existing = workspace.validationPackages.find((item) => (
        item.sourceReviewCycleId === sourceReviewCycleId && item.sourceRunId === sourceRunId
      ));
      if (existing) {
        if (existing.proposalHash !== proposalHash) {
          throw new Error("同一复盘结果已登记不同的验证草案，已拒绝覆盖。");
        }
        const rule = workspace.rules.find((item) => item.id === existing.ruleId);
        const test = workspace.tests.find((item) => item.id === existing.testId);
        if (!rule || !test) throw new Error("已登记验证包的规则或测试缺失，请先恢复台账。");
        return noMutation({ validationPackage: existing, rule, test });
      }
      const packageId = this.idFactory();
      const ruleId = this.idFactory();
      const testId = this.idFactory();
      const rule = {
        id: ruleId,
        title: cleanText(proposal.candidateRule.title, 160),
        condition: proposal.hypothesis,
        action: proposal.candidateRule.action,
        falsification: proposal.candidateRule.invalidation,
        scope: proposal.candidateRule.scope,
        status: "testing",
        version: 1,
        contentVersion: 1,
        createdAt: now,
        updatedAt: now,
        testIds: [testId],
        caseIds: [],
        validationPackageId: packageId,
        sourceReviewCycleId,
        sourceRunId,
        sourcePhaseRunId,
        sourceEvidenceRevision,
        sourceRetrospectiveVersion,
        history: [{ at: now, from: null, to: "testing", reason: "用户确认 Agent 验证草案并开始观察" }],
      };
      const test = {
        id: testId,
        testKind: "protocol",
        caseId: null,
        ruleId,
        title: cleanText(proposal.candidateRule.title, 160),
        hypothesis: proposal.hypothesis,
        metricSpec: proposal.testDesign.metric,
        windowSpec: proposal.testDesign.window,
        primaryMetric: normalizeProposalMetric(proposal.testDesign.metric),
        primaryHorizon: normalizeProposalHorizon(proposal.testDesign.window),
        minimumCases: proposal.testDesign.minCases,
        cohort: proposal.testDesign.inclusion,
        exclusions: proposal.testDesign.exclusion,
        successCriteria: proposal.testDesign.successCriteria,
        strategyFamily: "agent_review_learning",
        status: "collecting",
        registeredAt: now,
        observationStartedAt: now,
        decisionSampleTarget: proposal.testDesign.minCases,
        decisionRound: 1,
        decisionDueAt: null,
        completedAt: null,
        outcomeR: null,
        outcomeSource: null,
        outcomeVerified: false,
        benchmarkReturnPercent: null,
        notes: proposal.evidenceSummary,
        censored: false,
        samples: [],
        protocolEvaluation: null,
        validationPackageId: packageId,
        sourceReviewCycleId,
        sourceRunId,
        sourcePhaseRunId,
        sourceEvidenceRevision,
        sourceRetrospectiveVersion,
      };
      const validationPackage = {
        id: packageId,
        createdAt: now,
        confirmedAt: now,
        confirmedBy: "user",
        status: "observing",
        sourceReviewCycleId,
        sourceRunId,
        sourcePhaseRunId,
        sourceEvidenceRevision,
        sourceRetrospectiveVersion,
        ruleId,
        testId,
        proposal,
        proposalHash,
        sourceProposalHash,
        userEdited: sourceProposalHash !== proposalHash,
      };
      workspace.rules.unshift(rule);
      workspace.tests.unshift(test);
      workspace.validationPackages.unshift(validationPackage);
      return { validationPackage, rule, test };
    });
  }

  /**
   * Stops an active validation without deleting its hypothesis, samples, or
   * source lineage. This is the user-facing "delete" operation: an auditable
   * archive/retirement, never physical removal.
   */
  async archiveValidation(input = {}) {
    return this.#mutate((workspace) => {
      if (input?.confirmed !== true) {
        throw new Error("停止观察需要用户明确确认；历史与样本不会被物理删除。");
      }
      const packageId = cleanId(input?.validationPackageId ?? input?.packageId);
      const requestedTestId = cleanId(input?.testId);
      const requestedRuleId = cleanId(input?.ruleId);
      const validationPackage = workspace.validationPackages.find((item) => (
        (packageId && item.id === packageId)
        || (requestedTestId && item.testId === requestedTestId)
        || (requestedRuleId && item.ruleId === requestedRuleId)
      )) ?? null;
      const testId = requestedTestId || cleanId(validationPackage?.testId);
      const test = testId ? requiredTest(workspace, testId) : null;
      const ruleId = requestedRuleId || cleanId(validationPackage?.ruleId) || cleanId(test?.ruleId);
      const rule = ruleId ? requiredRule(workspace, ruleId) : null;
      if (!test || !rule || !isProtocolTest(test) || test.ruleId !== rule.id) {
        throw new Error("未找到可停止的观察验证。");
      }
      if (test.status === "retired" && rule.status === "retired") {
        return noMutation({ validationPackage, rule, test, ruleReview: null });
      }

      const archivedAt = this.now().toISOString();
      const reason = cleanText(input?.reason, 2_000) || "用户主动停止并归档观察决策";
      const fromStatus = rule.status;
      if (rule.status !== "retired") {
        rule.history.push({
          at: archivedAt,
          from: rule.status,
          to: "retired",
          reason,
        });
        rule.status = "retired";
        rule.version += 1;
        rule.updatedAt = archivedAt;
      }
      retireLinkedValidation(workspace, rule, archivedAt);
      test.archiveReason = reason;
      if (validationPackage) {
        validationPackage.status = "retired";
        validationPackage.archivedAt = archivedAt;
        validationPackage.archivedBy = "user";
        validationPackage.archiveReason = reason;
      }
      const ruleReview = {
        id: this.idFactory(),
        ruleId: rule.id,
        ruleVersion: rule.version,
        decision: "retire",
        evidence: reason,
        change: "",
        nextTrigger: "如需重新观察，请建立或恢复一个明确版本",
        reviewedAt: archivedAt,
        applicationStatus: "applied",
        appliedRuleVersion: rule.version,
        archiveOperation: true,
        previousRuleStatus: fromStatus,
      };
      workspace.ruleReviews.unshift(ruleReview);
      return { validationPackage, rule, test, ruleReview };
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
        testKind: "protocol",
        caseId,
        ruleId,
        title: cleanText(input?.title, 160) || "未命名测试",
        hypothesis: cleanText(input?.hypothesis, 2_000),
        strategyFamily: cleanText(input?.strategyFamily, 120),
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
        metricSpec: cleanText(input?.metricSpec ?? input?.primaryMetric, 500),
        primaryHorizon,
        windowSpec: cleanText(input?.windowSpec ?? primaryHorizon, 500),
        minimumCases: Math.min(Math.max(nonNegativeIntegerOrNull(input?.minimumCases) ?? 20, 1), 10_000),
        cohort: cleanText(input?.cohort, 3_000),
        exclusions: cleanText(input?.exclusions, 2_000),
        successCriteria: cleanText(input?.successCriteria, 2_000),
        status: "registered",
        registeredAt: now,
        completedAt: null,
        outcomeR: null,
        outcomeSource: null,
        outcomeVerified: false,
        benchmarkReturnPercent: null,
        notes: cleanText(input?.notes, 2_000),
        censored: false,
        samples: [],
        protocolEvaluation: null,
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
      if (isProtocolTest(test)) {
        const currentDecisionTarget = positiveIntegerOrDefault(
          test.decisionSampleTarget,
          positiveIntegerOrDefault(test.minimumCases, 20),
        );
        const gateReached = protocolObservedEventCount(test) >= currentDecisionTarget;
        if (["decision_due", "completed", "retired"].includes(test.status) || gateReached) {
          throw new Error(test.status === "retired"
            ? "已退役的验证不能继续追加样本。"
            : "该验证已达到本轮观察门槛，请先由你决定继续观察、创建 v2、暂行采用或退役。");
        }
        if (test.samples.length >= 10_000) {
          throw new Error("单个测试协议最多保留 10000 条观察样本。");
        }
        const recordedAt = this.now().toISOString();
        const censored = Boolean(input?.censored);
        const outcomeR = censored ? null : finiteOrNull(input?.outcomeR);
        if (!censored && outcomeR == null) throw new Error("记录观察样本需要有效的净 R，或标记为删失样本。");
        const requestedCaseId = cleanId(input?.caseId);
        if (requestedCaseId) requiredCase(workspace, requestedCaseId);
        const requestedReviewCycleId = cleanId(input?.reviewCycleId);
        if (!requestedCaseId && !requestedReviewCycleId && !test.caseId) {
          throw new Error("观察样本必须关联一个已完成的复盘周期或案例。");
        }
        if (requestedReviewCycleId && requestedReviewCycleId === test.sourceReviewCycleId) {
          throw new Error("形成假设的来源周期不能同时作为样本外验证；请选择后续复盘周期。");
        }
        if (requestedReviewCycleId && test.samples.some((sample) => sample.reviewCycleId === requestedReviewCycleId)) {
          throw new Error("该复盘周期已经纳入本验证；样本为追加式记录，不能覆盖或重复登记。");
        }
        const sample = {
          id: this.idFactory(),
          caseId: requestedCaseId || test.caseId || null,
          reviewCycleId: requestedReviewCycleId || null,
          formalEligible: false,
          recordedAt,
          outcomeR,
          benchmarkReturnPercent: finiteOrNull(input?.benchmarkReturnPercent),
          outcomeSource: "manual",
          outcomeVerified: false,
          observationTiming: enumValue(input?.observationTiming, [
            "forward", "overlapping", "historical", "unknown",
          ], "unknown"),
          notes: cleanText(input?.notes, 2_000),
          censored,
        };
        test.samples.push(sample);
        // A renderer-entered result is one append-only observational sample,
        // never completion or verification of the multi-case protocol.
        const decisionSampleTarget = positiveIntegerOrDefault(
          test.decisionSampleTarget,
          positiveIntegerOrDefault(test.minimumCases, 20),
        );
        const observedEventCount = protocolObservedEventCount(test);
        test.status = observedEventCount >= decisionSampleTarget ? "decision_due" : "collecting";
        test.decisionSampleTarget = decisionSampleTarget;
        test.decisionDueAt = test.status === "decision_due" ? recordedAt : null;
        test.completedAt = null;
        test.outcomeR = null;
        test.outcomeSource = null;
        test.outcomeVerified = false;
        test.benchmarkReturnPercent = null;
        test.censored = false;
        test.protocolEvaluation = null;
        return test;
      }
      if (["completed", "censored"].includes(test.status)) {
        throw new Error("测试结果已经冻结，不能覆盖；如需新口径请登记新的测试。");
      }
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
      const parentRuleId = cleanId(input?.parentRuleId ?? input?.supersedesRuleId);
      const parentRule = parentRuleId ? requiredRule(workspace, parentRuleId) : null;
      const rule = {
        id: this.idFactory(),
        title: cleanText(input?.title, 160) || "未命名候选规则",
        condition: cleanText(input?.condition, 2_000),
        action: cleanText(input?.action, 2_000),
        falsification: cleanText(input?.falsification, 2_000),
        scope: cleanText(input?.scope, 1_000),
        status: "hypothesis",
        version: 1,
        contentVersion: parentRule ? positiveIntegerOrDefault(parentRule.contentVersion, 1) + 1 : 1,
        parentRuleId: parentRule?.id ?? null,
        supersedesRuleId: parentRule?.id ?? null,
        lineageRootRuleId: parentRule?.lineageRootRuleId ?? parentRule?.id ?? null,
        createdAt: now,
        updatedAt: now,
        testIds: [],
        caseIds: uniqueIds(input?.caseIds),
        history: [{
          at: now,
          from: null,
          to: "hypothesis",
          reason: parentRule ? `根据规则 v${parentRule.contentVersion ?? 1} 建立新版本草案` : "建立候选规则",
        }],
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
      const linkedTests = workspace.tests.filter((item) => (
        item.ruleId === rule.id && item.status !== "cancelled"
      ));
      if (next === "testing" && !linkedTests.length) {
        throw new Error("规则至少需要关联一个已登记测试，才能进入 testing。");
      }
      const metrics = calculateRuleMetrics(workspace, rule.id);
      if (["provisional", "validated"].includes(next)) {
        const protocols = linkedTests.filter(isProtocolTest);
        if (!protocols.length) throw new Error("正式晋级需要至少一个已登记的验证协议。");
        const stateFloor = next === "validated" ? 50 : 20;
        const declaredMinimum = Math.max(
          stateFloor,
          ...protocols.map((item) => positiveIntegerOrDefault(item.minimumCases, 1)),
        );
        if ((metrics?.verifiedSampleCount ?? 0) < declaredMinimum) {
          throw new Error(`${next === "validated" ? "已验证规则" : "暂行原则"}至少需要 ${declaredMinimum} 个由确定性引擎核验的独立事件样本。`);
        }
        for (const protocol of protocols) {
          if (!protocol.primaryMetric) {
            throw new Error("测试协议的原始主指标尚未明确映射为可计算指标，不能正式晋级。");
          }
          if (!cleanText(protocol.successCriteria, 2_000)) {
            throw new Error("测试协议缺少冻结的成功标准，不能正式晋级。");
          }
          const evaluation = protocol.protocolEvaluation;
          const evaluatedMinimum = positiveIntegerOrDefault(protocol.minimumCases, 1);
          if (protocol.status !== "completed"
            || evaluation?.verified !== true
            || evaluation?.passed !== true
            || evaluation?.primaryMetric !== protocol.primaryMetric
            || evaluation?.sampleSetHash !== protocolSampleSetHash(protocol)
            || positiveIntegerOrDefault(evaluation?.evaluatedSampleCount, 0) !== protocolVerifiedEventCount(workspace, protocol)
            || positiveIntegerOrDefault(evaluation?.evaluatedSampleCount, 0) < evaluatedMinimum) {
            throw new Error("当前测试协议尚未由确定性引擎按声明指标、样本门槛和成功标准核验通过，不能正式晋级。");
          }
        }
        const requiresPositiveExpectancy = protocols.some((item) => (
          ["net_r", "expectancy_r"].includes(item.primaryMetric)
        ));
        if (requiresPositiveExpectancy && !(metrics?.verifiedExpectancyR > 0)) {
          throw new Error("以净 R / 期望 R 为主指标的协议，其已核验净期望值尚未大于 0，不能晋升。");
        }
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
      if (next === "retired") retireLinkedValidation(workspace, rule, at);
      if (next === "testing") reopenLinkedValidation(workspace, rule, at);
      if (["provisional", "validated"].includes(next)) {
        updateValidationPackageStatuses(workspace, rule, next);
      }
      return rule;
    });
  }

  async addRuleReview(ruleId, input) {
    return this.#mutate((workspace) => {
      const rule = requiredRule(workspace, ruleId);
      const now = this.now().toISOString();
      const decision = enumValue(input?.decision, ["keep", "change", "retire"], "keep");
      const reviewedRuleVersion = rule.version;
      const review = {
        id: this.idFactory(),
        ruleId: rule.id,
        ruleVersion: reviewedRuleVersion,
        decision,
        evidence: cleanText(input?.evidence, 4_000),
        change: cleanText(input?.change, 2_000),
        nextTrigger: cleanText(input?.nextTrigger, 2_000),
        reviewedAt: now,
        applicationStatus: decision === "change" ? "proposal_only" : "recorded",
      };
      if (decision === "retire" && rule.status !== "retired") {
        rule.history.push({
          at: now,
          from: rule.status,
          to: "retired",
          reason: review.evidence || review.change || "人工 Review 决定退役",
        });
        rule.status = "retired";
        rule.version += 1;
        review.applicationStatus = "applied";
        review.appliedRuleVersion = rule.version;
        retireLinkedValidation(workspace, rule, now);
      } else if (decision === "keep") {
        const reopened = reopenLinkedValidation(workspace, rule, now, { advanceTarget: true });
        if (reopened) review.applicationStatus = "applied";
      }
      workspace.ruleReviews.unshift(review);
      rule.updatedAt = now;
      return review;
    });
  }

  /** Atomically supersede a decision-due validation with an editable v2. */
  async createValidationVersion(input = {}) {
    return this.#mutate((workspace) => {
      const parentRule = requiredRule(workspace, input?.ruleId ?? input?.parentRuleId);
      const parentTest = requiredTest(workspace, input?.testId);
      if (!isProtocolTest(parentTest) || parentTest.ruleId !== parentRule.id) {
        throw new Error("v2 必须从同一条规则的验证协议建立。");
      }
      if (parentTest.status !== "decision_due") {
        throw new Error("只有达到本轮样本门槛并进入待决策的验证才能创建 v2。");
      }
      const now = this.now().toISOString();
      const childRuleId = this.idFactory();
      const childTestId = this.idFactory();
      const reviewId = this.idFactory();
      const title = cleanText(input?.title, 160) || parentRule.title;
      const condition = cleanText(input?.condition, 2_000) || parentRule.condition;
      const action = cleanText(input?.action, 2_000) || parentRule.action;
      const falsification = cleanText(input?.falsification ?? input?.invalidation, 2_000)
        || parentRule.falsification;
      if (![title, condition, action, falsification].every(Boolean)) {
        throw new Error("v2 需要明确名称、条件、动作与失效条件。");
      }
      const childRule = {
        ...structuredClone(parentRule),
        id: childRuleId,
        title,
        condition,
        action,
        falsification,
        scope: cleanText(input?.scope, 1_000) || parentRule.scope,
        status: "testing",
        version: 1,
        contentVersion: positiveIntegerOrDefault(parentRule.contentVersion, 1) + 1,
        parentRuleId: parentRule.id,
        supersedesRuleId: parentRule.id,
        lineageRootRuleId: parentRule.lineageRootRuleId ?? parentRule.id,
        createdAt: now,
        updatedAt: now,
        testIds: [childTestId],
        validationPackageId: null,
        sourceReviewCycleId: null,
        sourceRunId: null,
        sourcePhaseRunId: null,
        sourceValidationRuleId: parentRule.id,
        sourceValidationTestId: parentTest.id,
        history: [{ at: now, from: null, to: "testing", reason: "用户在验证决策门槛确认创建 v2 并开始观察" }],
      };
      const childTest = {
        ...structuredClone(parentTest),
        id: childTestId,
        ruleId: childRuleId,
        title,
        hypothesis: condition,
        status: "collecting",
        registeredAt: now,
        observationStartedAt: now,
        completedAt: null,
        decisionSampleTarget: positiveIntegerOrDefault(parentTest.minimumCases, 20),
        decisionRound: 1,
        decisionDueAt: null,
        retiredAt: null,
        samples: [],
        protocolEvaluation: null,
        validationPackageId: null,
        sourceReviewCycleId: null,
        sourceRunId: null,
        sourcePhaseRunId: null,
        sourceValidationRuleId: parentRule.id,
        sourceValidationTestId: parentTest.id,
      };
      const review = {
        id: reviewId,
        ruleId: parentRule.id,
        ruleVersion: parentRule.version,
        decision: "change",
        evidence: cleanText(input?.evidence, 4_000) || "验证达到人工决策门槛",
        change: `${condition}\n动作：${action}\n失效：${falsification}`,
        nextTrigger: "v2 达到新的独立样本门槛",
        reviewedAt: now,
        applicationStatus: "applied",
        createdRuleId: childRuleId,
        createdTestId: childTestId,
      };
      parentRule.history.push({
        at: now,
        from: parentRule.status,
        to: "retired",
        reason: `由 v${childRule.contentVersion} 取代`,
      });
      parentRule.status = "retired";
      parentRule.version += 1;
      parentRule.updatedAt = now;
      parentTest.status = "retired";
      parentTest.retiredAt = now;
      parentTest.decisionDueAt = null;
      updateValidationPackageStatuses(workspace, parentRule, "superseded");
      workspace.rules.unshift(childRule);
      workspace.tests.unshift(childTest);
      workspace.ruleReviews.unshift(review);
      return { review, rule: childRule, test: childTest };
    });
  }

  async #mutate(operation) {
    const mutation = this.queue.then(async () => {
      const workspace = await this.snapshot();
      const result = operation(workspace);
      if (result?.[NO_MUTATION] === true) return structuredClone(result.value);
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
  const eligibleSamples = [];
  const unlinkedObservations = [];
  for (const test of (workspace?.tests ?? []).filter((item) => item.ruleId === ruleId)) {
    if (isProtocolTest(test)) {
      for (const sample of test.samples) {
        if (sample.censored) continue;
        const caseId = sample.caseId || test.caseId || null;
        const reviewCycleId = sample.reviewCycleId || null;
        if (!caseId && !reviewCycleId) {
          if (Number.isFinite(sample.outcomeR)) unlinkedObservations.push(sample);
          continue;
        }
        if (caseId && !caseEligibleForMetrics(workspace, caseId)) continue;
        eligibleSamples.push({
          ...sample,
          sampleKey: reviewCycleId ? `cycle:${reviewCycleId}` : `case:${caseId}`,
        });
      }
      continue;
    }
    if (test.status !== "completed" || test.censored || !caseEligibleForMetrics(workspace, test.caseId)) {
      continue;
    }
    eligibleSamples.push({ ...test, sampleKey: test.caseId || test.id });
  }
  const onePerEvent = new Map();
  for (const item of eligibleSamples) {
    const sampleKey = item.sampleKey;
    const current = onePerEvent.get(sampleKey);
    const itemAt = item.recordedAt ?? item.completedAt ?? "";
    const currentAt = current?.recordedAt ?? current?.completedAt ?? "";
    if (!current || Date.parse(itemAt) >= Date.parse(currentAt)) {
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
  const unlinkedValues = unlinkedObservations
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
  const protocols = (workspace?.tests ?? []).filter((item) => item.ruleId === ruleId && isProtocolTest(item));
  const decisionSampleTarget = protocols.length
    ? Math.max(...protocols.map((item) => positiveIntegerOrDefault(
      item.decisionSampleTarget,
      positiveIntegerOrDefault(item.minimumCases, 20),
    )))
    : null;
  const decisionDue = protocols.some((item) => item.status === "decision_due");
  return {
    ruleId,
    sampleCount: values.length,
    observationCount: values.length + unlinkedValues.length,
    unlinkedObservationCount: unlinkedValues.length,
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
    decisionSampleTarget,
    decisionDue,
    progressPercent: decisionSampleTarget
      ? round(Math.min(100, values.length / decisionSampleTarget * 100))
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
      validationPackages: [],
    };
  }
  return structuredClone({
    schemaVersion: SCHEMA_VERSION,
    updatedAt: value.updatedAt ?? null,
    cases: Array.isArray(value.cases) ? value.cases.map(normalizePersistedReviewCase) : [],
    tests: Array.isArray(value.tests) ? value.tests.map(normalizePersistedTest) : [],
    rules: Array.isArray(value.rules) ? value.rules : [],
    ruleReviews: Array.isArray(value.ruleReviews) ? value.ruleReviews : [],
    validationPackages: Array.isArray(value.validationPackages) ? value.validationPackages : [],
  });
}

function normalizePersistedTest(value) {
  const test = value && typeof value === "object" ? structuredClone(value) : {};
  const hasDeclaredProtocol = test.testKind === "protocol"
    || Array.isArray(test.samples)
    || nonNegativeIntegerOrNull(test.minimumCases) != null;
  if (!hasDeclaredProtocol) {
    test.testKind = test.testKind || "legacy_sample";
    return test;
  }

  test.testKind = "protocol";
  test.minimumCases = Math.min(Math.max(nonNegativeIntegerOrNull(test.minimumCases) ?? 20, 1), 10_000);
  test.metricSpec = cleanText(test.metricSpec ?? test.primaryMetric, 500);
  test.windowSpec = cleanText(test.windowSpec ?? test.primaryHorizon, 500);
  test.primaryMetric = enumValue(test.primaryMetric, [
    "net_r", "relative_return", "drawdown", "hedge_value", "win_rate", "payoff_ratio",
    "expectancy_r", "mae_r", "mfe_r", "action_adherence", "invalidation_latency",
    "peak_gross_exposure",
  ], null);
  test.primaryHorizon = enumValue(test.primaryHorizon, ["t1", "t3", "t5", "t20", "next_quarter"], null);
  test.samples = normalizePersistedTestSamples(test.samples, test);

  // Builds created by the earlier one-result model may have marked an entire
  // multi-case protocol completed. Preserve that immutable observation as the
  // first sample, then reopen the protocol as collecting rather than erasing it.
  if (!test.samples.length && ["completed", "censored"].includes(test.status)
    && (test.outcomeR != null || test.censored)) {
    test.samples.push(normalizePersistedTestSample({
      id: `${cleanId(test.id) || "test"}:migrated-sample-1`,
      caseId: test.caseId,
      recordedAt: test.completedAt ?? test.registeredAt,
      outcomeR: test.outcomeR,
      benchmarkReturnPercent: test.benchmarkReturnPercent,
      outcomeSource: test.outcomeSource,
      outcomeVerified: test.outcomeVerified,
      notes: test.notes,
      censored: test.censored,
    }, test, 0));
  }

  test.observationStartedAt = optionalIso(test.observationStartedAt ?? test.registeredAt);
  test.decisionRound = positiveIntegerOrDefault(test.decisionRound, 1);
  test.decisionSampleTarget = positiveIntegerOrDefault(test.decisionSampleTarget, test.minimumCases);
  test.decisionDueAt = optionalIso(test.decisionDueAt);
  const formallyCompleted = test.protocolEvaluation?.verified === true
    && test.protocolEvaluation?.passed === true
    && test.protocolEvaluation?.primaryMetric === test.primaryMetric
    && test.protocolEvaluation?.sampleSetHash === protocolSampleSetHash(test)
    && positiveIntegerOrDefault(test.protocolEvaluation?.evaluatedSampleCount, 0)
      >= positiveIntegerOrDefault(test.minimumCases, 1);
  if (!formallyCompleted) {
    if (test.status === "retired") {
      test.status = "retired";
    } else if (protocolObservedEventCount(test) >= test.decisionSampleTarget) {
      test.status = "decision_due";
      test.decisionDueAt ??= test.samples.at(-1)?.recordedAt ?? test.registeredAt ?? null;
    } else {
      test.status = test.observationStartedAt ? "collecting" : "registered";
      test.decisionDueAt = null;
    }
    test.completedAt = null;
    test.outcomeR = null;
    test.outcomeSource = null;
    test.outcomeVerified = false;
    test.benchmarkReturnPercent = null;
    test.censored = false;
  }
  return test;
}

function normalizePersistedTestSamples(values, test) {
  const samples = [];
  const ids = new Set();
  for (const [index, raw] of (Array.isArray(values) ? values : []).slice(0, 10_000).entries()) {
    const sample = normalizePersistedTestSample(raw, test, index);
    if (ids.has(sample.id)) sample.id = `${sample.id}:${index + 1}`;
    ids.add(sample.id);
    samples.push(sample);
  }
  return samples;
}

function normalizePersistedTestSample(value, test, index) {
  const recordedAt = optionalIso(value?.recordedAt ?? value?.completedAt ?? test?.registeredAt)
    ?? new Date(0).toISOString();
  const censored = Boolean(value?.censored);
  return {
    id: cleanId(value?.id) || `${cleanId(test?.id) || "test"}:sample-${index + 1}`,
    caseId: cleanId(value?.caseId) || cleanId(test?.caseId),
    reviewCycleId: cleanId(value?.reviewCycleId),
    formalEligible: value?.formalEligible === true,
    recordedAt,
    outcomeR: censored ? null : finiteOrNull(value?.outcomeR),
    benchmarkReturnPercent: finiteOrNull(value?.benchmarkReturnPercent),
    outcomeSource: value?.outcomeVerified === true ? cleanText(value?.outcomeSource, 120) : "manual",
    outcomeVerified: value?.outcomeVerified === true,
    observationTiming: enumValue(value?.observationTiming, [
      "forward", "overlapping", "historical", "unknown",
    ], "unknown"),
    notes: cleanText(value?.notes, 2_000),
    censored,
  };
}

function isProtocolTest(value) {
  return value?.testKind === "protocol" && Array.isArray(value?.samples);
}

function protocolObservedEventCount(protocol) {
  const events = new Set();
  for (const sample of protocol?.samples ?? []) {
    if (sample?.censored === true) continue;
    if (sample?.reviewCycleId) events.add(`cycle:${sample.reviewCycleId}`);
    else if (sample?.caseId || protocol?.caseId) events.add(`case:${sample.caseId || protocol.caseId}`);
  }
  return events.size;
}

function reopenLinkedValidation(workspace, rule, at, { advanceTarget = false } = {}) {
  let changed = false;
  for (const protocol of workspace.tests.filter((item) => item.ruleId === rule.id && isProtocolTest(item))) {
    if (protocol.status === "retired" || protocol.status === "decision_due" || !protocol.observationStartedAt) {
      const observed = protocolObservedEventCount(protocol);
      const minimum = positiveIntegerOrDefault(protocol.minimumCases, 20);
      if (advanceTarget && protocol.status === "decision_due") {
        protocol.decisionRound = positiveIntegerOrDefault(protocol.decisionRound, 1) + 1;
        protocol.decisionSampleTarget = observed + Math.max(5, Math.ceil(minimum / 2));
      } else {
        protocol.decisionSampleTarget = Math.max(
          positiveIntegerOrDefault(protocol.decisionSampleTarget, minimum),
          minimum,
        );
      }
      protocol.status = "collecting";
      protocol.observationStartedAt ??= at;
      protocol.decisionDueAt = null;
      changed = true;
    }
  }
  if (changed) updateValidationPackageStatuses(workspace, rule, "observing");
  return changed;
}

function retireLinkedValidation(workspace, rule, at) {
  for (const protocol of workspace.tests.filter((item) => item.ruleId === rule.id && isProtocolTest(item))) {
    protocol.status = "retired";
    protocol.retiredAt = at;
    protocol.decisionDueAt = null;
  }
  updateValidationPackageStatuses(workspace, rule, "retired");
}

function updateValidationPackageStatuses(workspace, rule, status) {
  for (const item of workspace.validationPackages ?? []) {
    if (item.ruleId === rule.id || item.id === rule.validationPackageId) item.status = status;
  }
}

function protocolSampleSetHash(protocol) {
  return sha256(stableStringify((protocol?.samples ?? []).map((sample) => ({
    id: sample.id,
    caseId: sample.caseId,
    reviewCycleId: sample.reviewCycleId,
    formalEligible: sample.formalEligible === true,
    recordedAt: sample.recordedAt,
    outcomeR: sample.outcomeR,
    benchmarkReturnPercent: sample.benchmarkReturnPercent,
    outcomeSource: sample.outcomeSource,
    outcomeVerified: sample.outcomeVerified === true,
    observationTiming: sample.observationTiming,
    censored: sample.censored === true,
  }))));
}

function protocolVerifiedEventCount(workspace, protocol) {
  const eventIds = new Set();
  for (const sample of protocol?.samples ?? []) {
    const caseId = sample.caseId || protocol.caseId || null;
    const reviewCycleId = sample.reviewCycleId || null;
    if ((!caseId && !reviewCycleId) || sample.censored || sample.outcomeVerified !== true) continue;
    if (reviewCycleId) {
      if (sample.formalEligible !== true) continue;
      eventIds.add(`cycle:${reviewCycleId}`);
      continue;
    }
    if (!caseEligibleForMetrics(workspace, caseId)) continue;
    eventIds.add(`case:${caseId}`);
  }
  return eventIds.size;
}

function caseEligibleForMetrics(workspace, caseId) {
  if (!caseId) return true;
  const reviewCase = (workspace?.cases ?? []).find((candidate) => candidate.id === caseId);
  return reviewCase?.exAnteVersions?.some((version) => version.eligibleForFormalStats) === true;
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
  const initialSelection = normalizeBrokerLinkSelection(brokerLinks);
  const initialVersion = hasBrokerLinkSelection(initialSelection)
    ? buildBrokerLinkVersion({
      revision: 1,
      changedAt: optionalIso(brokerLinks?.confirmedAt) ?? now,
      reason: "创建案例时关联",
      ...initialSelection,
    })
    : null;
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
    brokerLinks: initialVersion ? brokerLinksFromVersion(initialVersion) : emptyBrokerLinks(),
    brokerLinkVersions: initialVersion ? [initialVersion] : [],
    brokerActivity,
    eventMetadata,
    ruleIds: [],
    archived: false,
  };
}

function normalizePersistedReviewCase(value) {
  const reviewCase = value && typeof value === "object" ? structuredClone(value) : {};
  const legacySelection = normalizeBrokerLinkSelection(reviewCase.brokerLinks);
  const fallbackChangedAt = optionalIso(
    reviewCase.brokerLinks?.confirmedAt
      ?? reviewCase.updatedAt
      ?? reviewCase.createdAt,
  );
  const versions = normalizeBrokerLinkVersions(reviewCase.brokerLinkVersions, fallbackChangedAt);
  const latest = versions.at(-1) ?? null;
  if (hasBrokerLinkSelection(legacySelection)
    && (!latest || !sameBrokerLinkSelection(latest, legacySelection))) {
    versions.push(buildBrokerLinkVersion({
      revision: nextBrokerLinkRevision(versions),
      changedAt: fallbackChangedAt,
      reason: latest ? "迁移当前关联快照" : "迁移旧版关联",
      ...legacySelection,
    }));
  }
  const current = versions.at(-1) ?? null;
  reviewCase.brokerLinkVersions = versions;
  reviewCase.brokerLinks = current ? brokerLinksFromVersion(current) : emptyBrokerLinks();
  return reviewCase;
}

function normalizeBrokerLinkVersions(values, fallbackChangedAt = null) {
  const candidates = (Array.isArray(values) ? values : [])
    .map((value, index) => {
      const selection = normalizeBrokerLinkSelection(value);
      if (!hasBrokerLinkSelection(selection)) return null;
      const requestedRevision = Number(value?.revision);
      return {
        requestedRevision: Number.isInteger(requestedRevision) && requestedRevision > 0
          ? requestedRevision
          : index + 1,
        changedAt: optionalIso(value?.changedAt ?? value?.confirmedAt) ?? fallbackChangedAt,
        reason: cleanText(value?.reason, 240) || "历史关联版本",
        ...selection,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.requestedRevision - right.requestedRevision);
  const versions = [];
  for (const candidate of candidates) {
    versions.push(buildBrokerLinkVersion({
      revision: Math.max(candidate.requestedRevision, nextBrokerLinkRevision(versions)),
      changedAt: candidate.changedAt,
      reason: candidate.reason,
      orderIds: candidate.orderIds,
      executionIds: candidate.executionIds,
    }));
  }
  for (let index = 0; index < versions.length - 1; index += 1) {
    versions[index].supersededBy = versions[index + 1].revision;
    versions[index].supersededAt = versions[index + 1].changedAt;
  }
  return versions;
}

function buildBrokerLinkVersion({
  revision,
  changedAt,
  reason,
  orderIds,
  executionIds,
}) {
  return {
    revision,
    changedAt: optionalIso(changedAt),
    reason: cleanText(reason, 240) || "更新关联订单与成交",
    ...normalizeBrokerLinkSelection({ orderIds, executionIds }),
  };
}

function brokerLinksFromVersion(version) {
  return {
    revision: version.revision,
    orderIds: [...version.orderIds],
    executionIds: [...version.executionIds],
    confirmedAt: version.changedAt,
  };
}

function emptyBrokerLinks() {
  return {
    revision: null,
    orderIds: [],
    executionIds: [],
    confirmedAt: null,
  };
}

function normalizeBrokerLinkSelection(value) {
  return {
    orderIds: uniqueIds(value?.orderIds).sort(),
    executionIds: uniqueIds(value?.executionIds).sort(),
  };
}

function hasBrokerLinkSelection(value) {
  return Boolean(value?.orderIds?.length || value?.executionIds?.length);
}

function sameBrokerLinkSelection(left, right) {
  const normalizedLeft = normalizeBrokerLinkSelection(left);
  const normalizedRight = normalizeBrokerLinkSelection(right);
  return stableStringify(normalizedLeft) === stableStringify(normalizedRight);
}

function normalizeLearningProposal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI 验证草案无效。");
  }
  const candidateRule = {
    title: cleanText(value?.candidateRule?.title, 500),
    action: cleanText(value?.candidateRule?.action, 2_000),
    invalidation: cleanText(value?.candidateRule?.invalidation, 2_000),
    scope: cleanText(value?.candidateRule?.scope, 1_000),
  };
  const testDesign = {
    metric: cleanText(value?.testDesign?.metric, 500),
    window: cleanText(value?.testDesign?.window, 500),
    minCases: Math.min(Math.max(nonNegativeIntegerOrNull(value?.testDesign?.minCases) ?? 0, 1), 10_000),
    inclusion: cleanText(value?.testDesign?.inclusion, 3_000),
    exclusion: cleanText(value?.testDesign?.exclusion, 2_000),
    successCriteria: cleanText(value?.testDesign?.successCriteria, 2_000),
  };
  const proposal = {
    hypothesis: cleanText(value?.hypothesis, 4_000),
    evidenceSummary: cleanText(value?.evidenceSummary, 6_000),
    testDesign,
    candidateRule,
    confidence: enumValue(value?.confidence, ["high", "medium", "low", "unknown"], "unknown"),
    caveats: [...new Set((Array.isArray(value?.caveats) ? value.caveats : [])
      .map((item) => cleanText(item, 1_000)).filter(Boolean))].slice(0, 20),
    evidencePosture: "retrospective_not_ex_ante",
  };
  const required = [
    proposal.hypothesis,
    proposal.evidenceSummary,
    testDesign.metric,
    testDesign.window,
    testDesign.inclusion,
    testDesign.exclusion,
    testDesign.successCriteria,
    candidateRule.title,
    candidateRule.action,
    candidateRule.invalidation,
    candidateRule.scope,
  ];
  if (required.some((item) => !item) || !Number.isInteger(testDesign.minCases) || testDesign.minCases < 1) {
    throw new Error("AI 验证草案缺少可证伪假设、测试口径或候选规则字段。");
  }
  if (!proposal.caveats.some((item) => item.includes("事前"))) {
    proposal.caveats.push("该草案来自事后复盘，不得冒充、覆盖或回写为事前判断。");
  }
  return proposal;
}

function normalizeProposalMetric(value) {
  const metric = String(value ?? "").trim().toLowerCase().replace(/[\s+-]+/g, "_");
  const allowed = new Set([
    "net_r", "relative_return", "drawdown", "hedge_value", "win_rate", "payoff_ratio",
    "expectancy_r", "mae_r", "mfe_r", "action_adherence", "invalidation_latency", "peak_gross_exposure",
  ]);
  if (allowed.has(metric)) return metric;
  return null;
}

function normalizeProposalHorizon(value) {
  const window = String(value ?? "").trim().toLowerCase();
  if (/^(?:next[_\s-]*quarter|下次财报)$/.test(window)) return "next_quarter";
  const match = window.match(/^t\s*\+?\s*(1|3|5|20)$/);
  return match ? `t${match[1]}` : null;
}

function nextBrokerLinkRevision(values) {
  return Math.max(0, ...(Array.isArray(values) ? values : []).map((value) => Number(value?.revision) || 0)) + 1;
}

function noMutation(value) {
  return { [NO_MUTATION]: true, value };
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

function positiveIntegerOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
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
