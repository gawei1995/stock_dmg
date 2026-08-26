import { createHash, randomUUID } from "node:crypto";

const NO_MUTATION = Symbol("review-cycle-store-no-mutation");

const STORE_KEY = "reviewCyclesV1";
const SCHEMA_VERSION = 1;

export const REVIEW_CYCLE_TYPES = Object.freeze([
  "catalyst",
  "position_lifecycle",
  "monthly_portfolio",
  "trade_window",
]);

const CYCLE_TYPES = new Set(REVIEW_CYCLE_TYPES);
const CYCLE_STATUSES = new Set([
  "draft",
  "active",
  "sealed",
  "blind_reviewed",
  "completed",
  "cancelled",
]);
const STATUS_TRANSITIONS = Object.freeze({
  draft: new Set(["active", "sealed", "completed", "cancelled"]),
  active: new Set(["sealed", "completed", "cancelled"]),
  sealed: new Set(["active", "blind_reviewed", "completed", "cancelled"]),
  blind_reviewed: new Set(["sealed", "completed", "cancelled"]),
  completed: new Set(),
  cancelled: new Set(),
});

const MAX_CYCLES = 500;
const MAX_SYMBOLS = 100;
const MAX_BROKER_RECORDS = 5_000;
const MAX_BROKER_LINK_VERSIONS = 1_000;
const MAX_CHECKPOINTS = 2_000;
const MAX_EX_ANTE_VERSIONS = 100;
const MAX_RETROSPECTIVE_VERSIONS = 200;
const MAX_RUNS_PER_PHASE = 200;
const MAX_EVIDENCE_ITEMS = 200;
const MAX_RUN_RESULT_CHARS = 200_000;

/**
 * Durable, append-oriented ledger for catalyst, position-lifecycle, and monthly
 * portfolio review cycles. All returned values are detached clones. Mutations
 * are serialized so concurrent calls through one host instance cannot lose
 * another cycle's write.
 */
export class ReviewCycleStore {
  constructor({ store, now = () => new Date(), idFactory = randomUUID } = {}) {
    if (!store?.get || !store?.set) throw new Error("ReviewCycleStore requires a persistent store.");
    this.store = store;
    this.now = now;
    this.idFactory = idFactory;
    this.queue = Promise.resolve();
  }

  /**
   * Returns `{ schemaVersion, revision, updatedAt, cycles }`.
   *
   * `snapshot({ cycleId, phase: "blind", exAnteVersion })` creates an
   * auditable temporal-firewall view. It omits drafts, outcome runs, untimed
   * broker links, and every checkpoint/evidence item not known strictly before
   * that sealed version's `knowledgeCutoffAt`.
   */
  async snapshot(options = {}) {
    await this.queue;
    const workspace = normalizeWorkspace(await this.store.get(STORE_KEY));
    const request = typeof options === "string" ? { cycleId: options } : (options ?? {});
    const cycleId = cleanId(request.cycleId);
    if (!cycleId && !request.phase) return structuredClone(workspace);
    if (!cycleId) throw new Error("阶段快照需要 cycleId。");
    const cycle = requiredCycle(workspace, cycleId);
    if (!request.phase || request.phase === "full") {
      return structuredClone({ ...workspace, cycles: [cycle] });
    }
    if (request.phase === "outcome") {
      if (!cycle.endAt || Date.parse(this.#nowIso()) < Date.parse(cycle.endAt)) {
        throw new Error("结果阶段快照只能在周期结束后读取。");
      }
      const latestVersion = cycle.exAnteVersions.at(-1)?.version ?? null;
      const blindRun = cycle.phaseRuns.blind.filter((item) => (
        item.status === "completed"
        && item.integrityStatus === "valid"
        && item.exAnteVersion === latestVersion
        && blindRunMatchesCurrentEvidence(cycle, item)
      )).at(-1);
      if (!blindRun) {
        throw new Error("结果阶段快照需要已完成且完整的盲态复盘运行。");
      }
      return structuredClone({
        ...workspace,
        snapshotHash: sha256(stableStringify(buildOutcomeCycleSnapshot(cycle, blindRun))),
        cycles: [cycle],
      });
    }
    if (request.phase === "retrospective") {
      if (!cycle.endAt || Date.parse(this.#nowIso()) < Date.parse(cycle.endAt)) {
        throw new Error("直接事后复盘只能在周期结束后读取。");
      }
      if (!cycle.brokerLinks.recordIds.length) {
        throw new Error("直接事后复盘需要先关联真实长桥订单或成交。");
      }
      requireRetrospectiveVersion(cycle);
      const retrospective = buildRetrospectiveCycleSnapshot(cycle);
      return structuredClone({
        ...workspace,
        phase: "retrospective",
        snapshotHash: sha256(stableStringify(retrospective)),
        cycles: [cycle],
      });
    }
    if (request.phase !== "blind") throw new Error("复盘阶段无效。");
    const blind = buildBlindCycleSnapshot(cycle, request.exAnteVersion);
    return structuredClone({
      schemaVersion: workspace.schemaVersion,
      revision: workspace.revision,
      updatedAt: null,
      phase: "blind",
      asOf: blind.knowledgeCutoffAt,
      snapshotHash: sha256(stableStringify(blind)),
      cycles: [blind],
    });
  }

  async create(input) {
    return this.#mutate((workspace) => {
      if (workspace.cycles.length + workspace.quarantinedCycles.length >= MAX_CYCLES) {
        throw new Error(`复盘周期最多保留 ${MAX_CYCLES} 个。`);
      }
      const createdAt = this.#nowIso();
      const id = requiredNewId(this.idFactory(), workspace);
      const cycle = buildCycle({ id, createdAt, input });
      workspace.cycles.unshift(cycle);
      return cycle;
    });
  }

  async createCycle(input) {
    return this.create(input);
  }

  /** Atomically creates an order-first cycle with its validated broker closure. */
  async createLinkedCycle({ cycle: input, links, retrospectiveNote = null } = {}) {
    return this.#mutate((workspace) => {
      if (workspace.cycles.length + workspace.quarantinedCycles.length >= MAX_CYCLES) {
        throw new Error(`复盘周期最多保留 ${MAX_CYCLES} 个。`);
      }
      const createdAt = this.#nowIso();
      const id = requiredNewId(this.idFactory(), workspace);
      const cycle = buildCycle({ id, createdAt, input });
      mergeBrokerLinks(cycle, links ?? {}, createdAt, {
        reason: cleanText(links?.reason, 500) || "创建周期时关联券商证据",
      });
      if (retrospectiveNote != null) {
        if (cycle.reviewMode !== "lightweight") {
          throw new Error("严谨周期不能把事后记录写入事前封存字段。");
        }
        appendRetrospectiveNote(cycle, retrospectiveNote, createdAt);
      }
      workspace.cycles.unshift(cycle);
      return cycle;
    });
  }

  async update(cycleId, patch = {}) {
    return this.#mutate((workspace) => {
      const cycle = requiredCycle(workspace, cycleId);
      const updatedAt = this.#nowIso();
      if (["completed", "cancelled"].includes(cycle.status)) {
        throw new Error("已完成或已取消的复盘周期不能修改。");
      }
      if (patch?.startingPortfolio != null || patch?.portfolioSnapshot != null) {
        throw new Error("周期起点组合快照创建后不可改写。");
      }
      const immutableFactsChanged = [
        "type", "cycleType", "scope", "symbol", "symbols", "benchmark", "startAt", "endAt", "catalystAt", "eventAt",
        "eventKind", "startCondition", "endCondition", "month",
      ].some((key) => patch?.[key] != null);
      const hasImmutableEvidence = cycle.exAnteVersions.length
        || cycle.checkpoints.length
        || cycle.brokerLinks.recordIds.length
        || cycle.phaseRuns.blind.length
        || cycle.phaseRuns.outcome.length;
      const immutableKeysExceptEnd = [
        "type", "cycleType", "scope", "symbol", "symbols", "benchmark", "startAt", "catalystAt", "eventAt",
        "eventKind", "startCondition", "endCondition", "month", "timezone",
      ];
      const closesOpenPosition = cycle.cycleType === "position_lifecycle"
        && cycle.endAt == null
        && patch?.endAt != null
        && !immutableKeysExceptEnd.some((key) => patch?.[key] != null);
      if (cycle.cycleType === "position_lifecycle" && cycle.endAt != null && patch?.endAt != null) {
        const requestedEndAt = requiredIso(patch.endAt, "复盘周期结束时间无效。");
        if (requestedEndAt !== cycle.endAt) throw new Error("持仓生命周期结束时间只能补录一次，不能改写。");
      }
      if (immutableFactsChanged && hasImmutableEvidence && !closesOpenPosition) {
        throw new Error("已有检查点、券商记录或封存版本后不能改写周期范围或标的事实。");
      }

      if (immutableFactsChanged) {
        const requestedType = patch?.cycleType ?? patch?.type;
        if (requestedType != null && normalizeCycleType(requestedType) !== cycle.cycleType) {
          throw new Error("复盘周期类型创建后不能更改。");
        }
        const corePatch = { ...patch };
        if (patch?.catalystAt == null && patch?.eventAt != null) corePatch.catalystAt = patch.eventAt;
        if (patch?.symbols == null && patch?.symbol != null) corePatch.symbols = [patch.symbol];
        const normalized = normalizeCycleCore({ ...cycle, ...corePatch }, cycle.cycleType);
        cycle.scope = normalized.scope;
        cycle.symbols = normalized.symbols;
        cycle.benchmark = normalized.benchmark;
        cycle.startAt = normalized.startAt;
        cycle.endAt = normalized.endAt;
        cycle.catalystAt = normalized.catalystAt;
        cycle.eventKind = normalized.eventKind;
        cycle.startCondition = normalized.startCondition;
        cycle.endCondition = normalized.endCondition;
        cycle.month = normalized.month;
        cycle.timezone = normalized.timezone;
        if (closesOpenPosition) {
          const lastKnownActivityAt = latestKnownActivityAt(cycle);
          if (lastKnownActivityAt && Date.parse(cycle.endAt) < Date.parse(lastKnownActivityAt)) {
            throw new Error("持仓生命周期结束时间不能早于已记录的订单或决策检查点。");
          }
          if (Date.parse(cycle.endAt) > Date.parse(updatedAt)) {
            throw new Error("持仓生命周期结束时间不能晚于当前时间。");
          }
        }
      }
      const sealedPlanContentChanged = immutableFactsChanged
        || patch?.title != null
        || patch?.description != null
        || patch?.exAnte != null
        || patch?.exAnteDraft != null;
      if (patch?.title != null) cycle.title = cleanText(patch.title, 160) || cycle.title;
      if (patch?.description != null) cycle.description = cleanText(patch.description, 2_000);
      if (patch?.exAnte != null || patch?.exAnteDraft != null) {
        cycle.exAnteDraft = normalizeExAnte({
          ...cycle.exAnteDraft,
          ...normalizeExAntePatch(patch.exAnte ?? patch.exAnteDraft),
        });
      }
      // This timestamp covers every mutable field copied into a sealed plan,
      // not only the four primary ex-ante text fields. It prevents a title,
      // scope fact, or description authored later from crossing an older
      // knowledgeCutoffAt under an innocent-looking field name.
      if (sealedPlanContentChanged) cycle.exAnteUpdatedAt = updatedAt;
      if (patch?.status != null) {
        if (patch.status !== cycle.status && patch.status !== "cancelled") {
          throw new Error("sealed、blind_reviewed 和 completed 只能由封存及两阶段运行结果推进。");
        }
        if (patch.status === "cancelled") transitionStatus(cycle, "cancelled");
      }
      cycle.updatedAt = updatedAt;
      return cycle;
    });
  }

  async updateCycle(cycleOrRequest, patch = null) {
    if (cycleOrRequest && typeof cycleOrRequest === "object") {
      return this.update(cycleOrRequest.cycleId ?? cycleOrRequest.id, cycleOrRequest.patch ?? patch ?? {});
    }
    return this.update(cycleOrRequest, patch ?? {});
  }

  async closeCycle(cycleOrRequest, options = null) {
    if (cycleOrRequest && typeof cycleOrRequest === "object") {
      return this.update(cycleOrRequest.cycleId ?? cycleOrRequest.id, {
        endAt: cycleOrRequest.endAt ?? cycleOrRequest.closedAt,
      });
    }
    return this.update(cycleOrRequest, { endAt: options?.endAt ?? options?.closedAt });
  }

  /**
   * Saves an immutable, explicitly retrospective user note. The recalled
   * judgment never becomes ex-ante evidence; the forward hypothesis only
   * becomes prospective from this version's savedAt timestamp.
   */
  async saveRetrospectiveNote(cycleOrRequest, input = null) {
    const request = cycleOrRequest && typeof cycleOrRequest === "object"
      ? cycleOrRequest
      : { ...(input ?? {}), cycleId: cycleOrRequest };
    return this.#mutate((workspace) => {
      const cycle = requiredCycle(workspace, request.cycleId ?? request.id);
      if (cycle.status === "cancelled") throw new Error("已取消的周期不能保存复盘记录。");
      if (cycle.reviewMode !== "lightweight") {
        throw new Error("这组三段式记录只用于直接事后复盘；严谨周期请使用事前封存字段。");
      }
      const requestedSnapshot = normalizeRetrospectiveNote(
        request.note ?? request.reflection ?? request.retrospectiveNote ?? request,
      );
      validateRetrospectiveNote(requestedSnapshot);
      const latest = cycle.retrospectiveVersions.at(-1) ?? null;
      if (latest && stableStringify(latest.snapshot) === stableStringify(requestedSnapshot)) {
        return noMutation(latest);
      }
      const savedAt = this.#nowIso();
      const version = appendRetrospectiveNote(
        cycle,
        requestedSnapshot,
        savedAt,
      );
      cycle.updatedAt = savedAt;
      return version;
    });
  }

  async seal(cycleId, options = {}) {
    return this.#mutate((workspace) => {
      const cycle = requiredCycle(workspace, cycleId);
      if (["completed", "cancelled"].includes(cycle.status)) {
        throw new Error("已完成或已取消的复盘周期不能封存新版本。");
      }
      if (cycle.exAnteVersions.length >= MAX_EX_ANTE_VERSIONS) {
        throw new Error(`每个周期最多封存 ${MAX_EX_ANTE_VERSIONS} 个事前版本。`);
      }
      const sealedAt = this.#nowIso();
      const knowledgeCutoffAt = inputIsoOrDefault(
        options.knowledgeCutoffAt ?? options.cutoffAt,
        sealedAt,
        "knowledgeCutoffAt 无效。",
      );
      if (Date.parse(knowledgeCutoffAt) > Date.parse(sealedAt)) {
        throw new Error("knowledgeCutoffAt 不能晚于实际封存时间。");
      }
      if (Date.parse(knowledgeCutoffAt) < Date.parse(cycle.exAnteUpdatedAt)) {
        throw new Error("knowledgeCutoffAt 不能早于事前四字段最后编辑时间；请按真实知识时点封存。");
      }
      const normalizedDraft = normalizeExAnte(cycle.exAnteDraft);
      const excludedEvidenceCount = normalizedDraft.evidence.filter((item) => (
        !item.observedAt || Date.parse(item.observedAt) >= Date.parse(knowledgeCutoffAt)
      )).length;
      const exAnte = {
        ...normalizedDraft,
        evidence: normalizedDraft.evidence.filter((item) => (
          item.observedAt && Date.parse(item.observedAt) < Date.parse(knowledgeCutoffAt)
        )),
      };
      const eligibility = calculateEligibility(cycle, sealedAt, exAnte, excludedEvidenceCount);
      const snapshot = {
        title: cycle.title,
        description: cycle.description,
        cycleType: cycle.cycleType,
        reviewMode: cycle.reviewMode,
        scope: cycle.scope,
        symbols: cycle.symbols,
        benchmark: cycle.benchmark,
        startAt: cycle.startAt,
        endAt: cycle.endAt,
        catalystAt: cycle.catalystAt,
        eventKind: cycle.eventKind,
        startCondition: cycle.startCondition,
        endCondition: cycle.endCondition,
        month: cycle.month,
        timezone: cycle.timezone,
        startingPortfolio: cycle.startingPortfolio?.snapshotAt
          && Date.parse(cycle.startingPortfolio.snapshotAt) < Date.parse(knowledgeCutoffAt)
          ? cycle.startingPortfolio
          : null,
        exAnte,
      };
      const reason = cleanText(options.reason, 500) || "用户封存决策周期事前版本";
      const version = {
        hashVersion: 2,
        version: Math.max(0, ...cycle.exAnteVersions.map((item) => item.version)) + 1,
        sealedAt,
        knowledgeCutoffAt,
        exAnteUpdatedAt: cycle.exAnteUpdatedAt,
        formalEligibilityDeadlineAt: eligibility.deadlineAt,
        timing: eligibility.timing,
        eligibleFromAt: eligibility.eligibleFromAt,
        eligibleForFormalStats: eligibility.eligibleForFormalStats,
        formalEligibility: eligibility.formalEligibility,
        coverageLimitation: eligibility.coverageLimitation,
        eligibilityReasons: eligibility.eligibilityReasons,
        excludedEvidenceCount,
        reason,
        snapshot,
      };
      version.hash = sha256(stableStringify(versionHashPayload(version)));
      version.integrityStatus = "valid";
      cycle.exAnteVersions.push(version);
      if (cycle.status !== "sealed") transitionStatus(cycle, "sealed");
      cycle.updatedAt = sealedAt;
      return version;
    });
  }

  async sealCycle(cycleOrRequest, options = null) {
    if (cycleOrRequest && typeof cycleOrRequest === "object") {
      const { cycleId, id, ...rest } = cycleOrRequest;
      return this.seal(cycleId ?? id, options ?? rest);
    }
    return this.seal(cycleOrRequest, options ?? {});
  }

  /** Append-only: supplied links are merged, never used to erase old links. */
  async linkBrokerRecords(cycleId, input = {}) {
    return this.#mutate((workspace) => {
      const cycle = requiredCycle(workspace, cycleId);
      if (cycle.status === "cancelled") throw new Error("已取消的复盘周期不能关联券商记录。");
      const linkedAt = this.#nowIso();
      const changed = mergeBrokerLinks(cycle, input, linkedAt, {
        reason: cleanText(input?.reason, 500) || "追加关联券商证据",
      });
      if (!changed) return noMutation(cycle.brokerLinks);
      cycle.updatedAt = linkedAt;
      return cycle.brokerLinks;
    });
  }

  async linkCycleRecords(cycleOrRequest, input = null) {
    if (cycleOrRequest && typeof cycleOrRequest === "object") {
      const { cycleId, id, ...rest } = cycleOrRequest;
      return this.linkBrokerRecords(cycleId ?? id, input ?? rest);
    }
    return this.linkBrokerRecords(cycleOrRequest, input ?? {});
  }

  /**
   * Replaces the complete active broker-evidence selection while preserving
   * every superseded selection and its immutable record facts. This is the
   * correction path for an existing review whose original order closure was
   * incomplete or included the wrong order.
   */
  async replaceBrokerRecords(cycleId, input = {}) {
    return this.#mutate((workspace) => {
      const cycle = requiredCycle(workspace, cycleId);
      if (cycle.status === "cancelled") throw new Error("已取消的复盘周期不能替换券商记录。");
      const changedAt = this.#nowIso();
      const changed = replaceBrokerLinks(cycle, input, changedAt, {
        reason: cleanText(input?.reason, 500) || "重新选择关联券商证据",
      });
      if (!changed) return noMutation(cycle.brokerLinks);
      cycle.updatedAt = changedAt;
      return cycle.brokerLinks;
    });
  }

  async replaceCycleBrokerRecords(cycleOrRequest, input = null) {
    if (cycleOrRequest && typeof cycleOrRequest === "object") {
      const { cycleId, id, ...rest } = cycleOrRequest;
      return this.replaceBrokerRecords(cycleId ?? id, input ?? rest);
    }
    return this.replaceBrokerRecords(cycleOrRequest, input ?? {});
  }

  /** Returns whether an immutable phase run still cites the current evidence revision. */
  async validatePhaseRunSource(cycleOrRequest, runId = null) {
    await this.queue;
    const workspace = normalizeWorkspace(await this.store.get(STORE_KEY));
    const request = cycleOrRequest && typeof cycleOrRequest === "object"
      ? cycleOrRequest
      : { cycleId: cycleOrRequest, runId };
    const cycle = requiredCycle(workspace, request.cycleId ?? request.id);
    const requestedRunId = cleanId(request.runId ?? request.phaseRunId);
    const runs = [
      ...cycle.phaseRuns.blind,
      ...cycle.phaseRuns.outcome,
      ...cycle.phaseRuns.retrospective,
    ];
    const run = requestedRunId
      ? runs.find((item) => item.id === requestedRunId)
      : cycle.phaseRuns.retrospective.at(-1);
    if (!run) throw new Error("未找到复盘阶段运行记录。");
    const currentEvidenceRevision = cycle.evidenceRevision ?? cycle.brokerLinks.evidenceRevision ?? null;
    const citedEvidenceRevision = run.evidenceRevision
      ?? (cycle.brokerLinkVersions.length === 1 ? cycle.brokerLinkVersions[0].evidenceRevision : null);
    const reasons = [];
    if (run.integrityStatus !== "valid") reasons.push("run_integrity_not_valid");
    if (run.phase === "blind" && !blindRunMatchesCurrentEvidence(cycle, run)) {
      reasons.push("blind_input_snapshot_changed");
    }
    if (["outcome", "retrospective"].includes(run.phase)
      && citedEvidenceRevision !== currentEvidenceRevision) {
      reasons.push("broker_evidence_revision_changed");
    }
    if (run.phase === "retrospective") {
      const currentRetrospectiveVersion = cycle.retrospectiveVersions.at(-1)?.version ?? null;
      if (run.retrospectiveVersion !== currentRetrospectiveVersion) {
        reasons.push("retrospective_note_version_changed");
      }
    }
    return structuredClone({
      cycleId: cycle.id,
      runId: run.id,
      phase: run.phase,
      isCurrent: reasons.length === 0,
      status: reasons.length ? "stale" : "current",
      citedEvidenceRevision,
      currentEvidenceRevision,
      reasons,
    });
  }

  /** Append-only decision ledger. There is intentionally no update API. */
  async addCheckpoint(cycleId, input = {}) {
    return this.#mutate((workspace) => {
      const cycle = requiredCycle(workspace, cycleId);
      if (["completed", "cancelled"].includes(cycle.status)) {
        throw new Error("已完成或已取消的周期不能新增决策检查点。");
      }
      if (cycle.checkpoints.length >= MAX_CHECKPOINTS) {
        throw new Error(`每个周期最多保留 ${MAX_CHECKPOINTS} 个检查点。`);
      }
      const recordedAt = this.#nowIso();
      const occurredAt = requiredIso(input.occurredAt ?? input.at, "检查点时间无效。");
      if (Date.parse(occurredAt) > Date.parse(recordedAt)) throw new Error("检查点发生时间不能晚于记录时间。");
      if (Date.parse(occurredAt) < Date.parse(cycle.startAt)) throw new Error("检查点不能早于复盘周期开始时间。");
      if (cycle.endAt && Date.parse(occurredAt) > Date.parse(cycle.endAt)) {
        throw new Error("检查点不能晚于复盘周期结束时间。");
      }
      const checkpoint = normalizeCheckpoint({
        ...input,
        id: requiredNewCheckpointId(this.idFactory(), cycle),
        occurredAt,
        recordedAt,
        sequence: cycle.nextCheckpointSequence,
      });
      checkpoint.hash = sha256(stableStringify(checkpointHashPayload(checkpoint)));
      checkpoint.integrityStatus = "valid";
      cycle.nextCheckpointSequence += 1;
      cycle.checkpoints.push(checkpoint);
      cycle.checkpoints.sort(compareCheckpoints);
      if (cycle.status === "draft") transitionStatus(cycle, "active");
      cycle.updatedAt = recordedAt;
      return checkpoint;
    });
  }

  async addCycleCheckpoint(cycleOrRequest, input = null) {
    if (cycleOrRequest && typeof cycleOrRequest === "object") {
      return this.addCheckpoint(
        cycleOrRequest.cycleId ?? cycleOrRequest.id,
        cycleOrRequest.checkpoint ?? input ?? cycleOrRequest,
      );
    }
    return this.addCheckpoint(cycleOrRequest, input ?? {});
  }

  /**
   * Records immutable histories for blind and outcome phases. Outcome runs must
   * cite a completed blind run in this cycle. The host computes input hashes;
   * callers cannot claim a different evidence snapshot.
   */
  async recordPhaseRun(cycleOrRequest, input = null) {
    const request = cycleOrRequest && typeof cycleOrRequest === "object"
      ? cycleOrRequest
      : { ...(input ?? {}), cycleId: cycleOrRequest };
    return this.#mutate((workspace) => {
      const cycle = requiredCycle(workspace, request.cycleId ?? request.id);
      if (cycle.status === "cancelled") throw new Error("已取消的周期不能记录复盘运行。");
      const phase = enumValue(request.phase, ["blind", "outcome", "retrospective"], null);
      if (!phase) throw new Error("复盘运行阶段无效。");
      if (cycle.phaseRuns[phase].length >= MAX_RUNS_PER_PHASE) {
        throw new Error(`每个阶段最多保留 ${MAX_RUNS_PER_PHASE} 次运行。`);
      }
      const recordedAt = this.#nowIso();
      const startedAt = inputIsoOrDefault(request.startedAt, recordedAt, "运行开始时间无效。");
      const completedAt = inputIsoOrDefault(request.completedAt, recordedAt, "运行完成时间无效。");
      if (Date.parse(startedAt) > Date.parse(completedAt)) throw new Error("运行完成时间不能早于开始时间。");
      if (Date.parse(completedAt) > Date.parse(recordedAt)) throw new Error("运行完成时间不能晚于实际记录时间。");
      if (request.status != null && !["completed", "failed", "cancelled"].includes(request.status)) {
        throw new Error("复盘运行状态无效。");
      }
      const status = enumValue(request.status, ["completed", "failed", "cancelled"], "completed");
      if (request.expectedEvidenceRevision != null) {
        const expectedEvidenceRevision = positiveInteger(
          request.expectedEvidenceRevision,
          "预期券商证据版本无效。",
        );
        const currentEvidenceRevision = cycle.evidenceRevision ?? cycle.brokerLinks.evidenceRevision ?? null;
        if (expectedEvidenceRevision !== currentEvidenceRevision) {
          throw new Error("券商证据已在 Agent 分析期间更新；旧结果不能登记，请按最新订单重新运行复盘。");
        }
      }
      let exAnteVersion = null;
      let retrospectiveVersion = null;
      let blindRunId = null;
      let inputSnapshot;
      if (phase === "blind") {
        inputSnapshot = buildBlindCycleSnapshot(cycle, request.exAnteVersion);
        exAnteVersion = inputSnapshot.exAnteVersions[0].version;
      } else if (phase === "outcome") {
        if (!cycle.endAt) throw new Error("阶段二只能在周期结束后运行；开放持仓请先补录 endAt。");
        if (Date.parse(recordedAt) < Date.parse(cycle.endAt) || Date.parse(completedAt) < Date.parse(cycle.endAt)) {
          throw new Error("阶段二不能在复盘周期 endAt 之前记录。");
        }
        const latestVersion = cycle.exAnteVersions.at(-1)?.version ?? null;
        const completedBlindRuns = cycle.phaseRuns.blind.filter((item) => (
          item.status === "completed"
          && item.integrityStatus === "valid"
          && item.exAnteVersion === latestVersion
          && blindRunMatchesCurrentEvidence(cycle, item)
        ));
        const blindRun = request.blindRunId
          ? completedBlindRuns.find((item) => item.id === cleanId(request.blindRunId))
          : completedBlindRuns.at(-1);
        if (!blindRun) throw new Error("阶段二必须引用本周期已完成的盲态复盘运行。");
        blindRunId = blindRun.id;
        exAnteVersion = blindRun.exAnteVersion;
        inputSnapshot = buildOutcomeCycleSnapshot(cycle, blindRun);
      } else {
        if (!cycle.endAt || Date.parse(recordedAt) < Date.parse(cycle.endAt)) {
          throw new Error("直接事后复盘只能在周期结束后记录。");
        }
        if (!cycle.brokerLinks.recordIds.length) {
          throw new Error("直接事后复盘需要真实长桥订单或成交证据。");
        }
        retrospectiveVersion = requireRetrospectiveVersion(cycle).version;
        if (request.expectedRetrospectiveVersion != null) {
          const expectedRetrospectiveVersion = positiveInteger(
            request.expectedRetrospectiveVersion,
            "预期事后记录版本无效。",
          );
          if (expectedRetrospectiveVersion !== retrospectiveVersion) {
            throw new Error("判断、感悟或未来预判已在 Agent 分析期间更新；旧结果不能登记，请重新运行复盘。");
          }
        }
        inputSnapshot = buildRetrospectiveCycleSnapshot(cycle);
      }
      const inputSnapshotHash = sha256(stableStringify(inputSnapshot));
      const expectedInputSnapshotHash = cleanText(request.expectedInputSnapshotHash, 128);
      if (expectedInputSnapshotHash && expectedInputSnapshotHash !== inputSnapshotHash) {
        throw new Error("复盘证据快照已在 Agent 分析期间变化；旧结果不能登记，请重新运行复盘。");
      }
      const result = sanitizeRunResult(request.result ?? request.output ?? request.summary ?? null);
      const run = {
        id: requiredNewRunId(this.idFactory(), cycle),
        phase,
        status,
        startedAt,
        completedAt,
        recordedAt,
        threadId: cleanText(request.threadId, 200),
        model: cleanText(request.model, 120),
        exAnteVersion,
        retrospectiveVersion,
        evidenceRevision: cycle.evidenceRevision ?? cycle.brokerLinks.evidenceRevision ?? null,
        evidenceFilterPolicyVersion: nonNegativeInteger(request.evidenceFilterPolicyVersion, 0) || null,
        blindRunId,
        inputSnapshotHash,
        result,
        resultHash: sha256(stableStringify(result)),
      };
      run.hash = sha256(stableStringify(runHashPayload(run)));
      run.integrityStatus = "valid";
      cycle.phaseRuns[phase].push(run);
      if (status === "completed" && phase === "blind" && cycle.status === "sealed") {
        transitionStatus(cycle, "blind_reviewed");
      }
      if (status === "completed" && phase === "outcome" && cycle.status === "blind_reviewed") {
        transitionStatus(cycle, "completed");
      }
      if (status === "completed" && phase === "retrospective" && cycle.status !== "completed") {
        transitionStatus(cycle, "completed");
      }
      cycle.updatedAt = recordedAt;
      return run;
    });
  }

  async #mutate(operation) {
    const mutation = this.queue.then(async () => {
      const workspace = normalizeWorkspace(await this.store.get(STORE_KEY));
      if (workspace.quarantinedCycles.length) {
        throw new Error("检测到损坏或冲突的复盘周期；已隔离原始数据并停止写入，请先完成恢复。");
      }
      const result = operation(workspace);
      if (result?.[NO_MUTATION] === true) return structuredClone(result.value);
      workspace.revision += 1;
      workspace.updatedAt = this.#nowIso();
      await this.store.set(STORE_KEY, workspace);
      return structuredClone(result);
    });
    this.queue = mutation.then(() => undefined, () => undefined);
    return mutation;
  }

  #nowIso() {
    const date = this.now();
    const millis = date instanceof Date ? date.getTime() : Date.parse(String(date));
    if (!Number.isFinite(millis)) throw new Error("系统时间无效。");
    return new Date(millis).toISOString();
  }
}

function noMutation(value) {
  return { [NO_MUTATION]: true, value };
}

function buildCycle({ id, createdAt, input }) {
  const cycleType = normalizeCycleType(input?.cycleType ?? input?.type);
  const core = normalizeCycleCore(input, cycleType);
  return {
    id,
    cycleType,
    type: cycleType,
    reviewMode: normalizeReviewMode(input?.reviewMode, cycleType === "trade_window" ? "lightweight" : "rigorous"),
    title: cleanText(input?.title, 160) || defaultTitle(cycleType, core.symbols, core.startAt, core.month),
    description: cleanText(input?.description, 2_000),
    ...core,
    status: "draft",
    createdAt,
    updatedAt: createdAt,
    exAnteDraft: normalizeExAnte(input?.exAnte ?? input?.exAnteDraft),
    exAnteUpdatedAt: createdAt,
    startingPortfolio: normalizeStartingPortfolio(
      input?.startingPortfolio ?? input?.portfolioSnapshot,
      core.startAt,
      createdAt,
    ),
    exAnteVersions: [],
    retrospectiveDraft: normalizeRetrospectiveNote(input?.retrospectiveNote ?? input?.reflection),
    retrospectiveUpdatedAt: createdAt,
    retrospectiveVersions: [],
    brokerLinks: emptyBrokerLinks(),
    brokerLinkVersions: [],
    evidenceRevision: null,
    checkpoints: [],
    nextCheckpointSequence: 1,
    phaseRuns: { blind: [], outcome: [], retrospective: [] },
  };
}

function normalizeCycleCore(input, cycleType) {
  const symbols = uniqueSymbols(input?.symbols ?? (input?.symbol ? [input.symbol] : []));
  const startAt = requiredIso(input?.startAt, "复盘周期开始时间无效。");
  const timezone = normalizeTimeZone(input?.timezone);
  let endAt = optionalIso(input?.endAt);
  let catalystAt = null;
  if (cycleType === "catalyst") {
    if (!symbols.length) throw new Error("财报/催化剂周期至少需要一个标的。");
    catalystAt = requiredIso(input?.catalystAt ?? input?.eventAt, "财报/催化剂周期需要明确 catalystAt。");
    if (!endAt) throw new Error("财报/催化剂周期需要结束时间。");
  } else if (cycleType === "position_lifecycle") {
    if (symbols.length !== 1) throw new Error("单一持仓生命周期必须且只能包含一个标的。");
  } else if (cycleType === "trade_window") {
    if (symbols.length !== 1) throw new Error("单标的订单区间必须且只能包含一个标的。");
    if (!endAt) throw new Error("单标的订单区间需要结束时间。");
  } else {
    if (!endAt) endAt = endOfMonthInTimeZone(startAt, timezone);
  }
  if (endAt && Date.parse(endAt) < Date.parse(startAt)) throw new Error("复盘周期结束时间不能早于开始时间。");
  if (catalystAt && (Date.parse(catalystAt) < Date.parse(startAt) || Date.parse(catalystAt) > Date.parse(endAt))) {
    throw new Error("catalystAt 必须位于复盘周期范围内。");
  }
  const durationDays = endAt ? (Date.parse(endAt) - Date.parse(startAt)) / 86_400_000 : null;
  if (cycleType === "monthly_portfolio" && durationDays > 35) throw new Error("月度组合周期不能超过 35 天。");
  if (cycleType === "catalyst" && durationDays > 370) throw new Error("财报/催化剂周期不能超过 370 天。");
  if (cycleType === "position_lifecycle" && durationDays != null && durationDays > 5_500) {
    throw new Error("单一持仓生命周期不能超过 15 年。");
  }
  if (cycleType === "trade_window" && durationDays > 5_500) {
    throw new Error("单标的订单区间不能超过 15 年。");
  }
  const expectedScope = cycleType === "monthly_portfolio"
    ? "portfolio"
    : (symbols.length === 1 ? "single_symbol" : "symbol_set");
  if (input?.scope != null && !["single_symbol", "symbol_set", "portfolio"].includes(input.scope)) {
    throw new Error("复盘周期 scope 无效。");
  }
  const scope = enumValue(input?.scope, ["single_symbol", "symbol_set", "portfolio"], expectedScope);
  if (["position_lifecycle", "trade_window"].includes(cycleType) && scope !== "single_symbol") {
    throw new Error("单标的复盘周期的 scope 必须是 single_symbol。");
  }
  if (cycleType === "monthly_portfolio" && scope !== "portfolio") {
    throw new Error("月度组合周期的 scope 必须是 portfolio。");
  }
  const suppliedMonth = cleanText(input?.month, 7);
  if (suppliedMonth && !/^\d{4}-\d{2}$/.test(suppliedMonth)) throw new Error("复盘月份格式无效。");
  const startMonth = monthKeyInTimeZone(startAt, timezone);
  const month = cycleType === "monthly_portfolio" ? (suppliedMonth || startMonth) : null;
  if (month && month !== startMonth) throw new Error("复盘月份必须与周期开始时间及声明时区一致。");
  return {
    scope,
    symbols,
    benchmark: normalizeBenchmark(input?.benchmark),
    startAt,
    endAt,
    catalystAt,
    eventKind: cycleType === "catalyst"
      ? enumValue(input?.eventKind ?? input?.event?.kind, ["earnings", "fomc", "product", "regulatory", "other"], "other")
      : null,
    startCondition: cycleType === "position_lifecycle" ? cleanText(input?.startCondition, 2_000) : null,
    endCondition: cycleType === "position_lifecycle" ? cleanText(input?.endCondition, 2_000) : null,
    month,
    timezone,
  };
}

function normalizeExAnte(value) {
  return {
    myView: cleanText(value?.myView ?? value?.thesis, 8_000),
    marketView: cleanText(value?.marketView ?? value?.marketExpectation, 8_000),
    plannedAction: cleanText(value?.plannedAction ?? value?.action, 6_000),
    invalidation: cleanText(value?.invalidation, 6_000),
    fundamentalView: cleanText(value?.fundamentalView ?? value?.fundamental, 8_000),
    technicalView: cleanText(value?.technicalView ?? value?.technical, 8_000),
    portfolioContext: cleanText(value?.portfolioContext, 6_000),
    riskNotes: cleanText(value?.riskNotes, 6_000),
    notes: cleanText(value?.notes, 8_000),
    riskBudgetR: finiteOrNull(value?.riskBudgetR),
    evidence: normalizeEvidence(value?.evidence),
  };
}

function normalizeExAntePatch(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const patch = {};
  const textAliases = [
    ["myView", "thesis"],
    ["marketView", "marketExpectation"],
    ["plannedAction", "action"],
    ["invalidation"],
    ["fundamentalView", "fundamental"],
    ["technicalView", "technical"],
    ["portfolioContext"],
    ["riskNotes"],
    ["notes"],
  ];
  const limits = [8_000, 8_000, 6_000, 6_000, 8_000, 8_000, 6_000, 6_000, 8_000];
  textAliases.forEach((aliases, index) => {
    const suppliedKey = aliases.find((key) => hasOwn(source, key));
    if (suppliedKey) patch[aliases[0]] = cleanText(source[suppliedKey], limits[index]);
  });
  if (hasOwn(source, "riskBudgetR")) patch.riskBudgetR = finiteOrNull(source.riskBudgetR);
  if (hasOwn(source, "evidence")) patch.evidence = normalizeEvidence(source.evidence);
  return patch;
}

function normalizeRetrospectiveNote(value) {
  return {
    recalledJudgment: cleanText(
      value?.recalledJudgment ?? value?.recalledView ?? value?.judgment,
      6_000,
    ),
    lesson: cleanText(value?.lesson ?? value?.insight, 6_000),
    forwardHypothesis: cleanText(
      value?.forwardHypothesis ?? value?.forwardView ?? value?.prediction,
      6_000,
    ),
  };
}

function validateRetrospectiveNote(value) {
  const missing = [
    ["recalledJudgment", "当时判断（事后回忆）"],
    ["lesson", "本次感悟"],
    ["forwardHypothesis", "未来预判"],
  ].filter(([key]) => !value?.[key]).map(([, label]) => label);
  if (missing.length) throw new Error(`开始事后复盘前请补充：${missing.join("、")}。`);
}

function appendRetrospectiveNote(cycle, input, savedAt) {
  const snapshot = normalizeRetrospectiveNote(input);
  validateRetrospectiveNote(snapshot);
  cycle.retrospectiveDraft = snapshot;
  cycle.retrospectiveUpdatedAt = savedAt;
  const latest = cycle.retrospectiveVersions.at(-1) ?? null;
  if (latest && stableStringify(latest.snapshot) === stableStringify(snapshot)) return latest;
  if (cycle.retrospectiveVersions.length >= MAX_RETROSPECTIVE_VERSIONS) {
    throw new Error(`每个周期最多保留 ${MAX_RETROSPECTIVE_VERSIONS} 个事后记录版本。`);
  }
  const version = {
    version: Math.max(0, ...cycle.retrospectiveVersions.map((item) => item.version)) + 1,
    savedAt,
    forwardEffectiveAt: savedAt,
    evidenceTiming: "retrospective",
    snapshot,
  };
  version.hash = sha256(stableStringify(retrospectiveVersionHashPayload(version)));
  version.integrityStatus = "valid";
  cycle.retrospectiveVersions.push(version);
  return version;
}

function normalizeStartingPortfolio(value, fallbackSnapshotAt, latestSnapshotAt = fallbackSnapshotAt) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("周期起点组合快照无效。");
  }
  const rawPositions = Array.isArray(value.positions) ? value.positions : [];
  if (rawPositions.length > 500) throw new Error("周期起点组合快照最多包含 500 个持仓。");
  const positions = rawPositions.map(normalizePortfolioPosition).filter(Boolean);
  const suppliedTop1 = value.top1 && typeof value.top1 === "object"
    ? normalizePortfolioPosition(value.top1)
    : null;
  const top1 = suppliedTop1 ?? [...positions].sort((left, right) => (
    Math.abs(right.weight ?? 0) - Math.abs(left.weight ?? 0)
  ))[0] ?? null;
  const cashRatio = boundedNumber(value.cashRatio ?? value.cashRatioPercent ?? value.cashWeight, -500, 500);
  const grossExposure = boundedNumber(value.grossExposure ?? value.grossExposurePercent, 0, 500);
  const top1WeightPercent = boundedNumber(value.top1WeightPercent ?? value.top1Weight ?? top1?.weight, -500, 500);
  const snapshotAt = requiredIso(value.snapshotAt ?? value.asOf ?? fallbackSnapshotAt, "周期起点组合快照时间无效。");
  const startAt = requiredIso(fallbackSnapshotAt, "复盘周期开始时间无效。");
  if (Date.parse(snapshotAt) > Date.parse(startAt)) {
    throw new Error("周期起点组合快照不能晚于周期开始时间。");
  }
  if (Date.parse(snapshotAt) > Date.parse(requiredIso(latestSnapshotAt, "周期创建时间无效。"))) {
    throw new Error("周期起点组合快照不能晚于周期创建时间。");
  }
  return {
    snapshotAt,
    baseCurrency: normalizeCurrency(value.baseCurrency ?? value.currency ?? "USD"),
    netAssets: finiteOrNull(value.netAssets ?? value.totalAssets),
    cashRatio,
    cashRatioPercent: cashRatio,
    grossExposure,
    grossExposurePercent: grossExposure,
    top1,
    top1WeightPercent,
    positions,
  };
}

function normalizePortfolioPosition(value) {
  const symbol = optionalSymbol(value?.symbol);
  if (!symbol) return null;
  return {
    symbol,
    quantity: finiteOrNull(value?.quantity),
    weight: boundedNumber(value?.weight ?? value?.weightPercent, -500, 500),
    marketValue: finiteOrNull(value?.marketValue),
    currency: normalizeCurrency(value?.currency ?? "USD"),
    group: cleanText(value?.group ?? value?.sector ?? value?.theme, 200),
  };
}

function normalizeEvidence(values) {
  if (Array.isArray(values) && values.length > MAX_EVIDENCE_ITEMS) {
    throw new Error(`每个证据集合最多包含 ${MAX_EVIDENCE_ITEMS} 条记录。`);
  }
  const result = [];
  for (const [index, value] of (Array.isArray(values) ? values : []).entries()) {
    if (result.length >= MAX_EVIDENCE_ITEMS) break;
    const summary = cleanText(value?.summary ?? value?.note ?? value?.text, 8_000);
    if (!summary) continue;
    result.push({
      id: cleanId(value?.id) || `evidence-${index + 1}`,
      kind: enumValue(value?.kind, ["fundamental", "technical", "market", "broker", "news", "other"], "other"),
      observedAt: optionalIso(value?.observedAt ?? value?.at),
      source: cleanText(value?.source, 500),
      title: cleanText(value?.title, 500),
      summary,
      uri: cleanText(value?.uri ?? value?.url, 2_000),
    });
  }
  return result;
}

function calculateEligibility(cycle, sealedAt, exAnte, excludedEvidenceCount) {
  const missingCoreFields = ["myView", "marketView", "plannedAction", "invalidation"]
    .filter((key) => !exAnte[key]);
  let timing;
  let eligibleFromAt = null;
  let deadlineAt;
  let coverageLimitation = null;

  if (cycle.cycleType === "catalyst") {
    deadlineAt = cycle.catalystAt;
    timing = Date.parse(sealedAt) < Date.parse(deadlineAt) ? "ex_ante" : "retrospective";
    if (timing === "ex_ante") eligibleFromAt = sealedAt;
    else coverageLimitation = "封存发生在催化剂时点之后，只能作为事后重建。";
  } else if (["position_lifecycle", "trade_window"].includes(cycle.cycleType)) {
    deadlineAt = cycle.startAt;
    timing = Date.parse(sealedAt) <= Date.parse(deadlineAt) ? "ex_ante" : "retrospective";
    if (timing === "ex_ante") eligibleFromAt = sealedAt;
    else coverageLimitation = "封存晚于已知首次建仓/周期开始时点，不能评价此前动作的事前决策质量。";
  } else {
    deadlineAt = cycle.startAt;
    if (Date.parse(sealedAt) <= Date.parse(cycle.startAt)) {
      timing = "ex_ante";
      eligibleFromAt = sealedAt;
    } else if (cycle.endAt && Date.parse(sealedAt) <= Date.parse(cycle.endAt)) {
      timing = "partial_ex_ante";
      eligibleFromAt = sealedAt;
      coverageLimitation = `仅覆盖 ${sealedAt} 及之后的月度决策；此前动作属于已知历史，不能按事前计划评分。`;
    } else {
      timing = "retrospective";
      coverageLimitation = "封存晚于月度周期结束，只能作为事后重建。";
    }
  }

  const eligibilityReasons = [];
  if (timing === "retrospective") eligibilityReasons.push("sealed_after_formal_deadline");
  if (missingCoreFields.length) eligibilityReasons.push(`missing_core_fields:${missingCoreFields.join(",")}`);
  if (excludedEvidenceCount) eligibilityReasons.push(`excluded_future_or_untimed_evidence:${excludedEvidenceCount}`);
  const eligibleForFormalStats = timing !== "retrospective" && missingCoreFields.length === 0;
  if (missingCoreFields.length) {
    const missingMessage = `缺少 ${missingCoreFields.join("、")}，不能进入正式判断质量统计。`;
    coverageLimitation = coverageLimitation ? `${coverageLimitation} ${missingMessage}` : missingMessage;
  }
  if (excludedEvidenceCount) {
    const evidenceMessage = `${excludedEvidenceCount} 条无时间或不早于 knowledgeCutoffAt 的证据未写入封存快照。`;
    coverageLimitation = coverageLimitation ? `${coverageLimitation} ${evidenceMessage}` : evidenceMessage;
  }
  return {
    deadlineAt,
    timing,
    eligibleFromAt,
    eligibleForFormalStats,
    formalEligibility: eligibleForFormalStats
      ? (timing === "partial_ex_ante" ? "partial" : "full")
      : "ineligible",
    coverageLimitation,
    eligibilityReasons,
  };
}

function mergeBrokerLinks(cycle, input, linkedAt, { reason = "追加关联券商证据" } = {}) {
  const suppliedRecordCount = Array.isArray(input.records) ? input.records.length : 0;
  if (suppliedRecordCount > MAX_BROKER_RECORDS) {
    throw new Error(`每次最多关联 ${MAX_BROKER_RECORDS} 条券商记录。`);
  }
  const incomingRecords = normalizeBrokerRecords(input.records, linkedAt);
  const suppliedPublicRecordIds = normalizePublicRecordIds(input.recordIds);
  const suppliedRequestedRecordIds = normalizePublicRecordIds(input.requestedRecordIds);
  const incomingOrderIds = normalizeIncomingRawBrokerIds(input.orderIds, "order");
  const incomingExecutionIds = normalizeIncomingRawBrokerIds(input.executionIds, "execution");
  const orderIds = mergeIdsWithLimit(cycle.brokerLinks.orderIds, [
    ...incomingOrderIds,
    ...suppliedPublicRecordIds.filter((id) => id.startsWith("order:"))
      .map((id) => stripRecordPrefix(id, "order")),
    ...incomingRecords.filter((item) => item.kind === "order")
      .map((item) => stripRecordPrefix(item.id, "order")),
  ], "订单");
  const executionIds = mergeIdsWithLimit(cycle.brokerLinks.executionIds, [
    ...incomingExecutionIds,
    ...suppliedPublicRecordIds.filter((id) => id.startsWith("execution:"))
      .map((id) => stripRecordPrefix(id, "execution")),
    ...incomingRecords.filter((item) => item.kind === "execution")
      .map((item) => stripRecordPrefix(item.id, "execution")),
  ], "成交");
  const archiveById = brokerRecordArchive(cycle);
  mergeImmutableBrokerFacts(archiveById, incomingRecords);
  const recordIds = uniqueIds([
    ...cycle.brokerLinks.recordIds,
    ...suppliedPublicRecordIds,
    ...incomingRecords.map((item) => item.id),
    ...incomingOrderIds.map((id) => `order:${id}`),
    ...incomingExecutionIds.map((id) => `execution:${id}`),
  ], MAX_BROKER_RECORDS);
  const allRequestedIds = uniqueIds([
    ...cycle.brokerLinks.recordIds,
    ...suppliedPublicRecordIds,
    ...incomingRecords.map((item) => item.id),
    ...incomingOrderIds.map((id) => `order:${id}`),
    ...incomingExecutionIds.map((id) => `execution:${id}`),
  ], Number.MAX_SAFE_INTEGER);
  if (allRequestedIds.length > MAX_BROKER_RECORDS) {
    throw new Error(`每个周期最多关联 ${MAX_BROKER_RECORDS} 条券商记录。`);
  }
  if (!recordIds.length && !orderIds.length && !executionIds.length) return false;
  const requestedRecordIds = uniqueIdsWithGuard([
    ...cycle.brokerLinks.requestedRecordIds,
    ...suppliedRequestedRecordIds,
  ], MAX_BROKER_RECORDS, "用户框选券商记录 ID");
  if (requestedRecordIds.some((id) => !recordIds.includes(id))) {
    throw new Error("用户框选券商记录必须属于已解析的订单与成交闭包。");
  }
  const activeIds = new Set(recordIds);
  const selection = {
    requestedRecordIds,
    recordIds,
    orderIds,
    executionIds,
    records: [...archiveById.values()].filter((item) => activeIds.has(item.id)).sort(compareBrokerRecords),
    activityStartAt: cycle.cycleType === "trade_window" ? cycle.startAt : null,
    activityEndAt: cycle.cycleType === "trade_window" ? cycle.endAt : null,
  };
  if (sameBrokerEvidence(cycle.brokerLinks, selection)) return false;
  appendBrokerLinkVersion(cycle, selection, linkedAt, reason);
  cycle.updatedAt = linkedAt;
  return true;
}

function replaceBrokerLinks(cycle, input, changedAt, { reason = "重新选择关联券商证据" } = {}) {
  const suppliedRecordCount = Array.isArray(input.records) ? input.records.length : 0;
  if (suppliedRecordCount > MAX_BROKER_RECORDS) {
    throw new Error(`每次最多关联 ${MAX_BROKER_RECORDS} 条券商记录。`);
  }
  const incomingRecords = normalizeBrokerRecords(input.records, changedAt);
  const suppliedPublicRecordIds = normalizePublicRecordIds(input.recordIds);
  const requestedRecordIds = normalizePublicRecordIds(
    input.requestedRecordIds == null ? input.recordIds : input.requestedRecordIds,
  );
  const rawOrderIds = normalizeIncomingRawBrokerIds(input.orderIds, "order");
  const rawExecutionIds = normalizeIncomingRawBrokerIds(input.executionIds, "execution");
  const recordIds = uniqueIdsWithGuard([
    ...suppliedPublicRecordIds,
    ...incomingRecords.map((item) => item.id),
    ...rawOrderIds.map((id) => `order:${id}`),
    ...rawExecutionIds.map((id) => `execution:${id}`),
  ], MAX_BROKER_RECORDS, "公开券商记录 ID");
  const orderIds = uniqueIdsWithGuard([
    ...rawOrderIds,
    ...recordIds.filter((id) => id.startsWith("order:")).map((id) => stripRecordPrefix(id, "order")),
  ], MAX_BROKER_RECORDS, "订单 ID");
  const executionIds = uniqueIdsWithGuard([
    ...rawExecutionIds,
    ...recordIds.filter((id) => id.startsWith("execution:")).map((id) => stripRecordPrefix(id, "execution")),
  ], MAX_BROKER_RECORDS, "成交 ID");
  if (!recordIds.length && !orderIds.length && !executionIds.length) {
    throw new Error("复盘周期至少需要关联一笔长桥订单或成交。");
  }
  if (requestedRecordIds.some((id) => !recordIds.includes(id))) {
    throw new Error("用户框选券商记录必须属于已解析的订单与成交闭包。");
  }
  const archiveById = brokerRecordArchive(cycle);
  mergeImmutableBrokerFacts(archiveById, incomingRecords);
  const activeIds = new Set(recordIds);
  const activityRange = replacementActivityRange(cycle, input, changedAt);
  const selection = {
    requestedRecordIds,
    recordIds,
    orderIds,
    executionIds,
    records: [...archiveById.values()].filter((item) => activeIds.has(item.id)).sort(compareBrokerRecords),
    ...activityRange,
  };
  validateExplicitExecutionAnchorsWithinRange(selection, activityRange);
  validateRetainedFactsWithinReplacementRange(cycle, activityRange);
  if (sameBrokerEvidence(cycle.brokerLinks, selection)) return false;
  appendBrokerLinkVersion(cycle, selection, changedAt, reason);
  if (cycle.cycleType === "trade_window") {
    cycle.startAt = activityRange.activityStartAt;
    cycle.endAt = activityRange.activityEndAt;
  }
  return true;
}

function replacementActivityRange(cycle, input, changedAt) {
  const suppliedStart = input?.activityStartAt ?? input?.startAt;
  const suppliedEnd = input?.activityEndAt ?? input?.endAt;
  const supplied = suppliedStart != null || suppliedEnd != null;
  if (cycle.cycleType !== "trade_window") {
    if (supplied) throw new Error("只有订单区间复盘可以随券商证据重算活动范围。");
    return { activityStartAt: null, activityEndAt: null };
  }
  if (supplied && (suppliedStart == null || suppliedEnd == null)) {
    throw new Error("重算订单区间时必须同时提供 activityStartAt 与 activityEndAt。");
  }
  const activityStartAt = supplied
    ? requiredIso(suppliedStart, "订单活动开始时间无效。")
    : cycle.startAt;
  const activityEndAt = supplied
    ? requiredIso(suppliedEnd, "订单活动结束时间无效。")
    : cycle.endAt;
  if (!activityEndAt) throw new Error("订单区间复盘需要明确活动结束时间。");
  if (Date.parse(activityStartAt) > Date.parse(activityEndAt)) {
    throw new Error("订单活动结束时间不能早于开始时间。");
  }
  if (Date.parse(activityStartAt) > Date.parse(changedAt) || Date.parse(activityEndAt) > Date.parse(changedAt)) {
    throw new Error("订单活动范围不能晚于本次实际证据更新时间。");
  }
  return { activityStartAt, activityEndAt };
}

function validateExplicitExecutionAnchorsWithinRange(selection, { activityStartAt, activityEndAt }) {
  if (!activityStartAt || !activityEndAt) return;
  const startMs = Date.parse(activityStartAt);
  const endMs = Date.parse(activityEndAt);
  const explicitlySelected = new Set(selection?.requestedRecordIds ?? []);
  // Parent orders and sibling fills may be retained as provenance outside the
  // selected execution window. Only a directly selected fill is required to
  // sit inside the host-derived Buy→Sell boundary.
  const outside = (selection?.records ?? []).find((record) => (
    record.kind === "execution"
    && explicitlySelected.has(record.id)
    && record.occurredAt
    && (
    Date.parse(record.occurredAt) < startMs || Date.parse(record.occurredAt) > endMs
    )
  ));
  if (outside) throw new Error(`券商记录 ${outside.id} 不在新的订单活动范围内。`);
}

function validateRetainedFactsWithinReplacementRange(cycle, { activityStartAt, activityEndAt }) {
  if (cycle.cycleType !== "trade_window" || !activityStartAt || !activityEndAt) return;
  const startMs = Date.parse(activityStartAt);
  const endMs = Date.parse(activityEndAt);
  const startingSnapshotAt = Date.parse(String(cycle?.startingPortfolio?.snapshotAt ?? ""));
  if (Number.isFinite(startingSnapshotAt) && startingSnapshotAt > startMs) {
    throw new Error("新的首笔订单早于既有周期起点组合快照；为避免伪造历史起点，请新建周期或显式迁移起点快照。");
  }
  const outsideCheckpoint = cycle.checkpoints.find((checkpoint) => {
    const occurredAt = Date.parse(String(checkpoint?.occurredAt ?? checkpoint?.at ?? ""));
    return !Number.isFinite(occurredAt) || occurredAt < startMs || occurredAt > endMs;
  });
  if (outsideCheckpoint) {
    throw new Error("新的订单区间不能排除既有决策检查点；请保留覆盖范围或新建周期。");
  }
}

function appendBrokerLinkVersion(cycle, selection, changedAt, reason) {
  if (cycle.brokerLinkVersions.length >= MAX_BROKER_LINK_VERSIONS) {
    throw new Error(`每个周期最多保留 ${MAX_BROKER_LINK_VERSIONS} 个券商证据版本。`);
  }
  const previous = cycle.brokerLinkVersions.at(-1) ?? null;
  const evidenceRevision = Math.max(
    0,
    ...cycle.brokerLinkVersions.map((item) => item.evidenceRevision ?? item.revision ?? 0),
  ) + 1;
  const previousSelection = previous ?? emptyBrokerLinks();
  const added = brokerSelectionDifference(selection, previousSelection);
  const removed = brokerSelectionDifference(previousSelection, selection);
  if (previous) {
    previous.supersededBy = evidenceRevision;
    previous.supersededAt = changedAt;
  }
  const version = {
    revision: evidenceRevision,
    evidenceRevision,
    changedAt,
    reason: cleanText(reason, 500) || "更新关联券商证据",
    requestedRecordIds: [...selection.requestedRecordIds],
    recordIds: [...selection.recordIds],
    orderIds: [...selection.orderIds],
    executionIds: [...selection.executionIds],
    records: selection.records.map((item) => structuredClone(item)),
    activityStartAt: selection.activityStartAt ?? null,
    activityEndAt: selection.activityEndAt ?? null,
    added,
    removed,
    supersededBy: null,
    supersededAt: null,
  };
  cycle.brokerLinkVersions.push(version);
  cycle.evidenceRevision = evidenceRevision;
  cycle.brokerLinks = brokerLinksFromVersion(version);
  return version;
}

function brokerLinksFromVersion(version) {
  return {
    revision: version.evidenceRevision,
    evidenceRevision: version.evidenceRevision,
    requestedRecordIds: [...(version.requestedRecordIds ?? [])],
    recordIds: [...version.recordIds],
    orderIds: [...version.orderIds],
    executionIds: [...version.executionIds],
    records: version.records.map((item) => structuredClone(item)),
    activityStartAt: version.activityStartAt ?? null,
    activityEndAt: version.activityEndAt ?? null,
    lastLinkedAt: version.changedAt,
    confirmedAt: version.changedAt,
  };
}

function brokerRecordArchive(cycle) {
  const archive = new Map();
  for (const record of [
    ...cycle.brokerLinkVersions.flatMap((item) => Array.isArray(item.records) ? item.records : []),
    ...cycle.brokerLinks.records,
  ]) {
    const existing = archive.get(record.id);
    if (existing && stableStringify(brokerRecordFact(existing)) !== stableStringify(brokerRecordFact(record))) {
      throw new Error(`券商记录 ${record.id} 的历史事实冲突。`);
    }
    if (!existing) archive.set(record.id, record);
  }
  return archive;
}

function mergeImmutableBrokerFacts(archiveById, incomingRecords) {
  for (const record of incomingRecords) {
    const existing = archiveById.get(record.id);
    if (existing && stableStringify(brokerRecordFact(existing)) !== stableStringify(brokerRecordFact(record))) {
      throw new Error(`券商记录 ${record.id} 已关联，不能改写。`);
    }
    if (!existing) archiveById.set(record.id, record);
  }
}

function brokerSelectionDifference(left, right) {
  const difference = (key) => {
    const excluded = new Set(right?.[key] ?? []);
    return (left?.[key] ?? []).filter((id) => !excluded.has(id));
  };
  return {
    requestedRecordIds: difference("requestedRecordIds"),
    recordIds: difference("recordIds"),
    orderIds: difference("orderIds"),
    executionIds: difference("executionIds"),
  };
}

function sameBrokerEvidence(left, right) {
  const normalized = (value) => ({
    requestedRecordIds: [...(value?.requestedRecordIds ?? [])].sort(),
    recordIds: [...(value?.recordIds ?? [])].sort(),
    orderIds: [...(value?.orderIds ?? [])].sort(),
    executionIds: [...(value?.executionIds ?? [])].sort(),
    records: [...(value?.records ?? [])]
      .map(brokerRecordFact)
      .sort((a, b) => a.id.localeCompare(b.id)),
    activityStartAt: value?.activityStartAt ?? null,
    activityEndAt: value?.activityEndAt ?? null,
  });
  return stableStringify(normalized(left)) === stableStringify(normalized(right));
}

function normalizeBrokerRecords(values, linkedAt) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (result.length >= MAX_BROKER_RECORDS) break;
    const rawId = value?.recordId ?? value?.id ?? value?.orderId ?? value?.executionId;
    const kind = normalizeRecordKind(
      value?.kind ?? value?.type ?? (value?.orderId ? "order" : (value?.executionId ? "execution" : null)),
      rawId,
    );
    const id = canonicalRecordId(rawId, kind);
    if (!id) continue;
    result.push({
      id,
      kind,
      occurredAt: optionalIso(value?.occurredAt ?? value?.at ?? value?.submittedAt ?? value?.executedAt),
      symbol: optionalSymbol(value?.symbol),
      linkedAt,
      source: cleanText(value?.source, 200) || "longbridge",
    });
  }
  return result;
}

function brokerRecordFact(value) {
  return {
    id: value.id,
    kind: value.kind,
    occurredAt: value.occurredAt,
    symbol: value.symbol,
    source: value.source,
  };
}

function canonicalRecordId(value, kind) {
  const id = cleanId(value);
  if (!id) return null;
  const prefix = recordIdPrefix(id);
  if (prefix && prefix !== kind) throw new Error(`券商记录前缀 ${prefix}: 与 kind=${kind} 不一致。`);
  if (prefix) return id;
  return `${kind}:${id}`;
}

function normalizeRecordKind(value, id) {
  const allowed = ["order", "execution", "position", "cash", "other"];
  const explicit = value == null || value === "" ? null : String(value);
  if (explicit && !allowed.includes(explicit)) throw new Error("券商记录 kind 无效。");
  const prefix = recordIdPrefix(id);
  if (explicit && prefix && explicit !== prefix) {
    throw new Error(`券商记录前缀 ${prefix}: 与 kind=${explicit} 不一致。`);
  }
  return explicit ?? prefix ?? "other";
}

function recordIdPrefix(value) {
  return /^(order|execution|position|cash|other):/.exec(String(value ?? ""))?.[1] ?? null;
}

function normalizePublicRecordIds(values) {
  const ids = uniqueIds(values, Number.MAX_SAFE_INTEGER);
  const invalid = ids.find((id) => !/^(order|execution|position|cash|other):.+/.test(id));
  if (invalid) throw new Error("recordIds 必须使用 order:/execution: 等公开记录前缀。");
  return ids;
}

function stripRecordPrefix(value, kind) {
  const prefix = `${kind}:`;
  return String(value ?? "").startsWith(prefix) ? String(value).slice(prefix.length) : String(value ?? "");
}

function normalizeCheckpoint(value) {
  return {
    id: cleanId(value?.id),
    sequence: nonNegativeInteger(value?.sequence, 0),
    occurredAt: requiredIso(value?.occurredAt ?? value?.at, "检查点时间无效。"),
    recordedAt: requiredIso(value?.recordedAt, "检查点记录时间无效。"),
    kind: enumValue(value?.kind, [
      "thesis_update", "market_expectation", "technical_signal", "position_change",
      "risk_change", "invalidation", "catalyst", "review_note", "other",
    ], "other"),
    title: cleanText(value?.title, 500),
    decision: cleanText(value?.decision, 6_000),
    action: cleanText(value?.action ?? value?.plannedAction, 6_000),
    invalidation: cleanText(value?.invalidation, 6_000),
    fundamental: cleanText(value?.fundamental ?? value?.fundamentalEvidence, 8_000),
    technical: cleanText(value?.technical ?? value?.technicalEvidence, 8_000),
    note: cleanText(value?.note ?? value?.notes, 8_000),
    evidence: normalizeEvidence(value?.evidence),
  };
}

function checkpointHashPayload(value) {
  const { hash: _hash, integrityStatus: _integrityStatus, ...payload } = value;
  return payload;
}

function buildBlindCycleSnapshot(cycle, requestedVersion) {
  const version = selectVersion(cycle, requestedVersion);
  if (version.integrityStatus === "mismatch") throw new Error("封存版本完整性校验失败，不能用于盲态复盘。");
  if (version.integrityStatus !== "valid") throw new Error("迁移封存版本需要重新封存后再运行盲态复盘。");
  // `reason` is written at seal time and can therefore be later than an
  // explicitly backdated knowledgeCutoffAt. Keep it hash-bound in the full
  // audit ledger, but never expose its free text through the blind firewall.
  const blindEligibility = calculateEligibility(
    version.snapshot,
    version.sealedAt,
    version.snapshot.exAnte,
    0,
  );
  const blindVersion = {
    ...version,
    formalEligibilityDeadlineAt: blindEligibility.deadlineAt,
    timing: blindEligibility.timing,
    eligibleFromAt: blindEligibility.eligibleFromAt,
    eligibleForFormalStats: blindEligibility.eligibleForFormalStats,
    formalEligibility: blindEligibility.formalEligibility,
    coverageLimitation: blindEligibility.coverageLimitation,
    eligibilityReasons: blindEligibility.eligibilityReasons,
    excludedEvidenceCount: null,
    reason: null,
    blindRedactions: ["reason", "excludedEvidenceCount", "future_or_untimed_evidence_metadata"],
  };
  const cutoffMs = Date.parse(version.knowledgeCutoffAt);
  const checkpoints = cycle.checkpoints
    .filter((item) => (
      item.integrityStatus === "valid"
      && Date.parse(item.occurredAt) < cutoffMs
      && Date.parse(item.recordedAt) < cutoffMs
    ))
    .map((item) => ({
      ...item,
      coveredBySealedPlan: !version.eligibleFromAt || Date.parse(item.occurredAt) >= Date.parse(version.eligibleFromAt),
      evidence: item.evidence.filter((evidence) => (
        evidence.observedAt && Date.parse(evidence.observedAt) < cutoffMs
      )),
    }));
  const records = cycle.brokerLinks.records.filter((item) => (
    item.occurredAt
    && Date.parse(item.occurredAt) < cutoffMs
  ));
  const decisionTimeline = buildBlindDecisionTimeline(cycle, version, blindVersion);
  return {
    id: cycle.id,
    cycleType: version.snapshot.cycleType,
    type: version.snapshot.cycleType,
    reviewMode: version.snapshot.reviewMode ?? "rigorous",
    title: version.snapshot.title,
    description: version.snapshot.description,
    scope: version.snapshot.scope,
    symbols: version.snapshot.symbols,
    benchmark: version.snapshot.benchmark,
    startAt: version.snapshot.startAt,
    endAt: version.snapshot.endAt,
    catalystAt: version.snapshot.catalystAt,
    eventKind: version.snapshot.eventKind,
    startCondition: version.snapshot.startCondition,
    endCondition: version.snapshot.endCondition,
    month: version.snapshot.month,
    timezone: version.snapshot.timezone,
    startingPortfolio: version.snapshot.startingPortfolio,
    status: "blind_snapshot",
    knowledgeCutoffAt: version.knowledgeCutoffAt,
    formalCoverage: {
      timing: blindVersion.timing,
      eligibleFromAt: blindVersion.eligibleFromAt,
      eligibleForFormalStats: blindVersion.eligibleForFormalStats,
      formalEligibility: blindVersion.formalEligibility,
      coverageLimitation: blindVersion.coverageLimitation,
    },
    exAnteDraft: null,
    exAnteVersions: [blindVersion],
    brokerLinks: blindBrokerLinks(records),
    checkpoints,
    decisionTimeline,
    decisionTimelineHash: sha256(stableStringify(decisionTimeline)),
    phaseRuns: { blind: [], outcome: [] },
  };
}

/**
 * Builds a chronological, append-only blind ledger of the initial sealed plan
 * and every integrity-valid decision checkpoint. Each node is a self-contained
 * focal decision: its free-text action is visible, while evidence and broker
 * facts must have occurred strictly before that node's own knowledge cutoff.
 * Broker facts are emitted once, at the earliest node where they were knowable,
 * keeping the maximum snapshot size linear instead of checkpoints × records.
 */
function buildBlindDecisionTimeline(cycle, version, blindVersion) {
  const candidates = [
    {
      nodeType: "initial_plan",
      sourceId: `ex-ante:${version.version}`,
      sourceHash: version.hash,
      sourceSequence: 0,
      occurredAt: version.exAnteUpdatedAt,
      recordedAt: version.sealedAt,
      knowledgeCutoffAt: version.knowledgeCutoffAt,
      kind: "initial_plan",
      title: version.snapshot.title,
      decision: version.snapshot.exAnte.myView,
      marketView: version.snapshot.exAnte.marketView,
      action: version.snapshot.exAnte.plannedAction,
      invalidation: version.snapshot.exAnte.invalidation,
      fundamental: version.snapshot.exAnte.fundamentalView,
      technical: version.snapshot.exAnte.technicalView,
      portfolioContext: version.snapshot.exAnte.portfolioContext,
      riskNotes: version.snapshot.exAnte.riskNotes,
      note: version.snapshot.exAnte.notes,
      evidence: version.snapshot.exAnte.evidence.filter((item) => (
        item.observedAt && Date.parse(item.observedAt) < Date.parse(version.knowledgeCutoffAt)
      )),
      coveredBySealedPlan: true,
      formalCoverage: {
        timing: blindVersion.timing,
        eligibleFromAt: blindVersion.eligibleFromAt,
        eligibleForFormalStats: blindVersion.eligibleForFormalStats,
        formalEligibility: blindVersion.formalEligibility,
        coverageLimitation: blindVersion.coverageLimitation,
      },
    },
    ...cycle.checkpoints
      .filter((checkpoint) => checkpoint.integrityStatus === "valid")
      .map((checkpoint) => ({
        nodeType: "decision_checkpoint",
        sourceId: checkpoint.id,
        sourceHash: checkpoint.hash,
        sourceSequence: checkpoint.sequence,
        occurredAt: checkpoint.occurredAt,
        recordedAt: checkpoint.recordedAt,
        knowledgeCutoffAt: checkpoint.recordedAt,
        kind: checkpoint.kind,
        title: checkpoint.title,
        decision: checkpoint.decision,
        marketView: null,
        action: checkpoint.action,
        invalidation: checkpoint.invalidation,
        fundamental: checkpoint.fundamental,
        technical: checkpoint.technical,
        portfolioContext: null,
        riskNotes: null,
        note: checkpoint.note,
        evidence: checkpoint.evidence.filter((item) => (
          item.observedAt && Date.parse(item.observedAt) < Date.parse(checkpoint.recordedAt)
        )),
        coveredBySealedPlan: !blindVersion.eligibleFromAt
          || Date.parse(checkpoint.occurredAt) >= Date.parse(blindVersion.eligibleFromAt),
        formalCoverage: null,
      })),
  ].sort(compareBlindTimelineCandidates);

  const introducedRecordIds = new Set();
  return candidates.map((candidate, timelineIndex) => {
    const cutoffMs = Date.parse(candidate.knowledgeCutoffAt);
    const introducedRecords = cycle.brokerLinks.records.filter((record) => (
      !introducedRecordIds.has(record.id)
      && record.occurredAt
      && Date.parse(record.occurredAt) < cutoffMs
    ));
    introducedRecords.forEach((record) => introducedRecordIds.add(record.id));
    const recordingLagMs = Math.max(0, Date.parse(candidate.recordedAt) - Date.parse(candidate.occurredAt));
    const node = {
      nodeId: `${candidate.nodeType}:${candidate.sourceId}`,
      timelineIndex,
      ...candidate,
      // A datetime-local control normally rounds occurredAt to a minute while
      // recordedAt retains seconds. Preserve the neutral lag instead of
      // labeling a few seconds of UI precision difference as retrospective.
      recordedAfterOccurrence: recordingLagMs > 0,
      recordingLagMs,
      brokerFactsIntroduced: blindBrokerLinks(introducedRecords),
    };
    node.hash = sha256(stableStringify(timelineNodeHashPayload(node)));
    node.integrityStatus = "valid";
    return node;
  });
}

function compareBlindTimelineCandidates(left, right) {
  return Date.parse(left.knowledgeCutoffAt) - Date.parse(right.knowledgeCutoffAt)
    || Number(left.nodeType !== "initial_plan") - Number(right.nodeType !== "initial_plan")
    || left.sourceSequence - right.sourceSequence
    || left.sourceId.localeCompare(right.sourceId);
}

function timelineNodeHashPayload(node) {
  const { hash: _hash, integrityStatus: _integrityStatus, ...payload } = node;
  return payload;
}

function blindBrokerLinks(records) {
  const sorted = [...records].sort(compareBrokerRecords);
  const linkedTimes = sorted.map((item) => item.linkedAt).filter(Boolean).sort((left, right) => Date.parse(left) - Date.parse(right));
  return {
    recordIds: sorted.map((item) => item.id),
    orderIds: sorted.filter((item) => item.kind === "order").map((item) => stripRecordPrefix(item.id, "order")),
    executionIds: sorted.filter((item) => item.kind === "execution").map((item) => stripRecordPrefix(item.id, "execution")),
    records: sorted,
    lastLinkedAt: linkedTimes.at(-1) ?? null,
  };
}

function buildOutcomeCycleSnapshot(cycle, blindRun) {
  return {
    ...structuredClone(cycle),
    exAnteDraft: null,
    referencedBlindRun: structuredClone(blindRun),
    phaseRuns: {
      blind: cycle.phaseRuns.blind.map((item) => ({ ...item, result: null })),
      outcome: [],
    },
  };
}

function buildRetrospectiveCycleSnapshot(cycle) {
  const version = requireRetrospectiveVersion(cycle);
  return {
    ...structuredClone(cycle),
    reviewMode: "lightweight",
    exAnteDraft: null,
    exAnteVersions: [],
    retrospectiveDraft: null,
    retrospectiveVersions: [structuredClone(version)],
    checkpoints: [],
    phaseRuns: {
      blind: [],
      outcome: [],
      retrospective: cycle.phaseRuns.retrospective.map((item) => ({ ...item, result: null })),
    },
    retrospectiveEvidencePolicy: {
      evidenceGrade: "retrospective",
      blindAssessmentAvailable: false,
      eligibleForFormalExAnteStatistics: false,
    },
  };
}

function selectVersion(cycle, requestedVersion) {
  if (!cycle.exAnteVersions.length) throw new Error("阶段一需要先封存事前版本。");
  const number = requestedVersion == null ? null : Number(requestedVersion);
  const version = number == null
    ? cycle.exAnteVersions.at(-1)
    : cycle.exAnteVersions.find((item) => item.version === number);
  if (!version) throw new Error("未找到可用的封存版本。");
  return structuredClone(version);
}

function blindRunMatchesCurrentEvidence(cycle, run) {
  try {
    const currentSnapshot = buildBlindCycleSnapshot(cycle, run.exAnteVersion);
    return run.inputSnapshotHash === sha256(stableStringify(currentSnapshot));
  } catch {
    return false;
  }
}

function sanitizeRunResult(value) {
  if (value == null) return null;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("复盘运行结果必须可以序列化。");
  }
  if (serialized === undefined) return null;
  if (serialized.length > MAX_RUN_RESULT_CHARS) throw new Error("复盘运行结果过大。");
  return JSON.parse(serialized);
}

function normalizeWorkspace(value) {
  const source = Array.isArray(value)
    ? { cycles: value }
    : (value && typeof value === "object" ? value : {});
  const cycles = [];
  const ids = new Set();
  const quarantinedCycles = (Array.isArray(source.quarantinedCycles) ? source.quarantinedCycles : [])
    .map((item) => structuredClone(item));
  const overflowCycles = [];
  for (const [sourceIndex, raw] of (Array.isArray(source.cycles) ? source.cycles : []).entries()) {
    if (cycles.length >= MAX_CYCLES) {
      overflowCycles.push(structuredClone(raw));
      continue;
    }
    let normalizationError = null;
    const cycle = normalizePersistedCycle(raw, (error) => { normalizationError = error; });
    if (!cycle || ids.has(cycle.id)) {
      quarantinedCycles.push({
        id: cleanId(raw?.id),
        reason: ids.has(cleanId(raw?.id)) ? "duplicate_cycle_id" : "malformed_cycle",
        detail: cleanText(
          ids.has(cleanId(raw?.id))
            ? `复盘周期 ID ${cleanId(raw?.id)} 重复。`
            : (normalizationError?.message || "复盘周期无法读取。"),
          1_000,
        ),
        sourceIndex,
        raw: structuredClone(raw),
      });
      continue;
    }
    ids.add(cycle.id);
    cycles.push(cycle);
  }
  if (overflowCycles.length) {
    quarantinedCycles.push({
      id: null,
      reason: "cycle_limit_exceeded",
      detail: `持久化账本含 ${cycles.length + overflowCycles.length} 个可读周期，超过 ${MAX_CYCLES} 个活动周期上限；溢出原始数据已完整隔离，写入已停止。`,
      sourceIndex: MAX_CYCLES,
      raw: overflowCycles,
    });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: nonNegativeInteger(source.revision, 0),
    updatedAt: optionalIso(source.updatedAt),
    cycles,
    quarantinedCycles,
  };
}

function normalizePersistedCycle(raw, onError = () => {}) {
  try {
    const cycleType = normalizeCycleType(raw?.cycleType ?? raw?.type);
    const createdAt = requiredIso(raw?.createdAt ?? raw?.startAt, "invalid");
    const core = normalizeCycleCore(raw, cycleType);
    const brokerState = normalizePersistedBrokerState(
      raw?.brokerLinks,
      raw?.brokerLinkVersions,
      optionalIso(raw?.updatedAt) ?? createdAt,
      cycleType === "trade_window" ? { activityStartAt: core.startAt, activityEndAt: core.endAt } : null,
    );
    const cycle = {
      id: cleanId(raw?.id),
      cycleType,
      type: cycleType,
      reviewMode: normalizeReviewMode(raw?.reviewMode, cycleType === "trade_window" ? "lightweight" : "rigorous"),
      title: cleanText(raw?.title, 160) || defaultTitle(cycleType, core.symbols, core.startAt, core.month),
      description: cleanText(raw?.description, 2_000),
      ...core,
      status: enumValue(raw?.status, [...CYCLE_STATUSES], "draft"),
      createdAt,
      updatedAt: optionalIso(raw?.updatedAt) ?? createdAt,
      exAnteDraft: normalizeExAnte(raw?.exAnteDraft ?? raw?.exAnte),
      exAnteUpdatedAt: optionalIso(raw?.exAnteUpdatedAt ?? raw?.updatedAt) ?? createdAt,
      startingPortfolio: normalizeStartingPortfolio(
        raw?.startingPortfolio ?? raw?.portfolioSnapshot,
        core.startAt,
        createdAt,
      ),
      exAnteVersions: [],
      retrospectiveDraft: normalizeRetrospectiveNote(raw?.retrospectiveDraft ?? raw?.retrospectiveNote),
      retrospectiveUpdatedAt: optionalIso(raw?.retrospectiveUpdatedAt ?? raw?.updatedAt) ?? createdAt,
      retrospectiveVersions: normalizeRetrospectiveVersions(raw?.retrospectiveVersions),
      brokerLinks: brokerState.brokerLinks,
      brokerLinkVersions: brokerState.brokerLinkVersions,
      evidenceRevision: brokerState.evidenceRevision,
      checkpoints: [],
      nextCheckpointSequence: 1,
      phaseRuns: normalizePhaseRuns(raw?.phaseRuns),
    };
    if (!cycle.id) throw new Error("复盘周期 ID 无效。");
    cycle.exAnteVersions = normalizeVersions(raw?.exAnteVersions, cycle);
    cycle.checkpoints = normalizeCheckpoints(raw?.checkpoints, cycle);
    const allRunIds = [
      ...cycle.phaseRuns.blind,
      ...cycle.phaseRuns.outcome,
      ...cycle.phaseRuns.retrospective,
    ].map((item) => item.id);
    if (new Set(allRunIds).size !== allRunIds.length) throw new Error("复盘阶段之间存在重复运行 ID。");
    cycle.nextCheckpointSequence = Math.max(
      nonNegativeInteger(raw?.nextCheckpointSequence, 1),
      ...cycle.checkpoints.map((item) => item.sequence + 1),
      1,
    );
    return cycle;
  } catch (error) {
    onError(error);
    return null;
  }
}

function normalizeVersions(values, cycle) {
  if (Array.isArray(values) && values.length > MAX_EX_ANTE_VERSIONS) {
    throw new Error(`封存版本超过 ${MAX_EX_ANTE_VERSIONS} 条上限。`);
  }
  const result = [];
  let previousVersion = 0;
  let previousSealedAt = null;
  for (const [index, raw] of (Array.isArray(values) ? values : []).entries()) {
    const sealedAt = requiredIso(raw?.sealedAt, "封存版本 sealedAt 无效。");
    const knowledgeCutoffAt = raw?.knowledgeCutoffAt != null || raw?.cutoffAt != null
      ? requiredIso(raw?.knowledgeCutoffAt ?? raw?.cutoffAt, "封存版本 knowledgeCutoffAt 无效。")
      : sealedAt;
    if (Date.parse(knowledgeCutoffAt) > Date.parse(sealedAt)) {
      throw new Error("封存版本 knowledgeCutoffAt 晚于 sealedAt。");
    }
    const exAnteUpdatedAt = raw?.exAnteUpdatedAt != null
      ? requiredIso(raw.exAnteUpdatedAt, "封存版本 exAnteUpdatedAt 无效。")
      : knowledgeCutoffAt;
    if (Date.parse(knowledgeCutoffAt) < Date.parse(exAnteUpdatedAt)) {
      throw new Error("封存版本 knowledgeCutoffAt 早于其事前内容编辑时间。");
    }
    const exAnte = normalizeExAnte(raw?.snapshot?.exAnte ?? raw?.exAnte);
    const storedSnapshot = raw?.snapshot && typeof raw.snapshot === "object" ? raw.snapshot : {};
    const snapshot = {
      title: hasOwn(storedSnapshot, "title") ? cleanText(storedSnapshot.title, 160) : cycle.title,
      description: hasOwn(storedSnapshot, "description") ? cleanText(storedSnapshot.description, 2_000) : cycle.description,
      cycleType: hasOwn(storedSnapshot, "cycleType") ? normalizeCycleType(storedSnapshot.cycleType) : cycle.cycleType,
      ...(hasOwn(storedSnapshot, "reviewMode")
        ? { reviewMode: normalizeReviewMode(storedSnapshot.reviewMode, cycle.reviewMode) }
        : {}),
      scope: hasOwn(storedSnapshot, "scope")
        ? enumValue(storedSnapshot.scope, ["single_symbol", "symbol_set", "portfolio"], cycle.scope)
        : cycle.scope,
      symbols: hasOwn(storedSnapshot, "symbols") ? uniqueSymbols(storedSnapshot.symbols) : cycle.symbols,
      benchmark: hasOwn(storedSnapshot, "benchmark") ? normalizeBenchmark(storedSnapshot.benchmark) : cycle.benchmark,
      startAt: hasOwn(storedSnapshot, "startAt")
        ? requiredIso(storedSnapshot.startAt, "invalid version start")
        : cycle.startAt,
      endAt: hasOwn(storedSnapshot, "endAt") ? optionalIso(storedSnapshot.endAt) : cycle.endAt,
      catalystAt: hasOwn(storedSnapshot, "catalystAt") ? optionalIso(storedSnapshot.catalystAt) : cycle.catalystAt,
      eventKind: hasOwn(storedSnapshot, "eventKind")
        ? enumValue(storedSnapshot.eventKind, ["earnings", "fomc", "product", "regulatory", "other"], null)
        : cycle.eventKind,
      startCondition: hasOwn(storedSnapshot, "startCondition")
        ? cleanText(storedSnapshot.startCondition, 2_000)
        : cycle.startCondition,
      endCondition: hasOwn(storedSnapshot, "endCondition")
        ? cleanText(storedSnapshot.endCondition, 2_000)
        : cycle.endCondition,
      month: hasOwn(storedSnapshot, "month") ? cleanText(storedSnapshot.month, 7) : cycle.month,
      timezone: hasOwn(storedSnapshot, "timezone")
        ? normalizeTimeZone(storedSnapshot.timezone)
        : cycle.timezone,
      startingPortfolio: hasOwn(storedSnapshot, "startingPortfolio")
        ? normalizeStartingPortfolio(storedSnapshot.startingPortfolio, cycle.startAt, cycle.createdAt)
        : (cycle.startingPortfolio?.snapshotAt
          && Date.parse(cycle.startingPortfolio.snapshotAt) < Date.parse(knowledgeCutoffAt)
          ? cycle.startingPortfolio
          : null),
      exAnte,
    };
    const versionNumber = raw?.version == null
      ? index + 1
      : positiveInteger(raw.version, "封存版本编号无效。");
    if (versionNumber <= previousVersion) throw new Error("封存版本编号重复或非递增。");
    if (previousSealedAt && Date.parse(sealedAt) < Date.parse(previousSealedAt)) {
      throw new Error("封存版本时间与版本编号顺序冲突。");
    }
    previousVersion = versionNumber;
    previousSealedAt = sealedAt;
    const reason = cleanText(raw?.reason, 500) || "迁移的封存版本";
    if (raw?.hashVersion != null && raw.hashVersion !== 2) {
      throw new Error("封存版本 hashVersion 无效。");
    }
    const excludedEvidenceCount = nonNegativeInteger(raw?.excludedEvidenceCount, 0);
    const expectedHash = sha256(stableStringify(versionHashPayload({
      hashVersion: 2,
      version: versionNumber,
      sealedAt,
      knowledgeCutoffAt,
      exAnteUpdatedAt,
      excludedEvidenceCount,
      reason,
      snapshot,
    })));
    const legacyExpectedHash = sha256(stableStringify(legacyVersionHashPayload({
      version: versionNumber,
      sealedAt,
      knowledgeCutoffAt,
      exAnteUpdatedAt,
      reason,
      snapshot,
    })));
    const suppliedHash = cleanText(raw?.hash, 128);
    let integrityStatus;
    if (!suppliedHash || raw?.integrityStatus === "migrated") {
      integrityStatus = "migrated";
    } else if (raw?.hashVersion === 2) {
      integrityStatus = suppliedHash === expectedHash ? "valid" : "mismatch";
    } else {
      integrityStatus = suppliedHash === legacyExpectedHash ? "migrated" : "mismatch";
    }
    const eligibility = calculateEligibility({
      cycleType: snapshot.cycleType,
      startAt: snapshot.startAt,
      endAt: snapshot.endAt,
      catalystAt: snapshot.catalystAt,
    }, sealedAt, exAnte, excludedEvidenceCount);
    result.push({
      hashVersion: raw?.hashVersion === 2 || !suppliedHash ? 2 : null,
      version: versionNumber,
      sealedAt,
      knowledgeCutoffAt,
      exAnteUpdatedAt,
      formalEligibilityDeadlineAt: eligibility.deadlineAt,
      timing: eligibility.timing,
      eligibleFromAt: eligibility.eligibleFromAt,
      eligibleForFormalStats: integrityStatus === "valid" ? eligibility.eligibleForFormalStats : false,
      formalEligibility: integrityStatus === "valid" ? eligibility.formalEligibility : "ineligible",
      coverageLimitation: integrityStatus === "mismatch"
        ? "封存快照哈希不匹配，不能作为正式证据。"
        : integrityStatus === "migrated"
          ? "迁移版本缺少当前账本签名，需要用户重新封存后才能进入正式统计或盲态复盘。"
          : eligibility.coverageLimitation,
      eligibilityReasons: uniqueStrings([
        ...eligibility.eligibilityReasons,
        ...(integrityStatus === "mismatch" ? ["integrity_hash_mismatch"] : []),
        ...(integrityStatus === "migrated" ? ["migration_requires_reseal"] : []),
      ], 30, 200),
      excludedEvidenceCount,
      reason,
      snapshot,
      hash: suppliedHash || expectedHash,
      integrityStatus,
    });
  }
  result.sort((left, right) => left.version - right.version || Date.parse(left.sealedAt) - Date.parse(right.sealedAt));
  return result;
}

function normalizeRetrospectiveVersions(values) {
  if (Array.isArray(values) && values.length > MAX_RETROSPECTIVE_VERSIONS) {
    throw new Error(`事后记录版本超过 ${MAX_RETROSPECTIVE_VERSIONS} 条上限。`);
  }
  const result = [];
  let previousVersion = 0;
  let previousSavedAt = null;
  for (const raw of Array.isArray(values) ? values : []) {
    const version = positiveInteger(raw?.version, "事后记录版本号无效。");
    const savedAt = requiredIso(raw?.savedAt, "事后记录 savedAt 无效。");
    if (version <= previousVersion) throw new Error("事后记录版本号必须严格递增。");
    if (previousSavedAt && Date.parse(savedAt) < Date.parse(previousSavedAt)) {
      throw new Error("事后记录 savedAt 必须按时间递增。");
    }
    const snapshot = normalizeRetrospectiveNote(raw?.snapshot ?? raw);
    validateRetrospectiveNote(snapshot);
    const normalized = {
      version,
      savedAt,
      forwardEffectiveAt: inputIsoOrDefault(
        raw?.forwardEffectiveAt,
        savedAt,
        "未来预判生效时间无效。",
      ),
      evidenceTiming: "retrospective",
      snapshot,
    };
    if (normalized.forwardEffectiveAt !== savedAt) {
      throw new Error("未来预判只能从该版本实际保存时间开始生效。");
    }
    const expectedHash = sha256(stableStringify(retrospectiveVersionHashPayload(normalized)));
    const suppliedHash = cleanText(raw?.hash, 128);
    normalized.hash = suppliedHash || expectedHash;
    normalized.integrityStatus = suppliedHash
      ? suppliedHash === expectedHash ? "valid" : "mismatch"
      : "migrated";
    result.push(normalized);
    previousVersion = version;
    previousSavedAt = savedAt;
  }
  return result;
}

function versionHashPayload(value) {
  return {
    hashVersion: value.hashVersion,
    version: value.version,
    sealedAt: value.sealedAt,
    knowledgeCutoffAt: value.knowledgeCutoffAt,
    exAnteUpdatedAt: value.exAnteUpdatedAt,
    excludedEvidenceCount: value.excludedEvidenceCount,
    reason: value.reason,
    snapshot: value.snapshot,
  };
}

function retrospectiveVersionHashPayload(value) {
  return {
    version: value.version,
    savedAt: value.savedAt,
    forwardEffectiveAt: value.forwardEffectiveAt,
    evidenceTiming: value.evidenceTiming,
    snapshot: value.snapshot,
  };
}

function legacyVersionHashPayload(value) {
  return {
    version: value.version,
    sealedAt: value.sealedAt,
    knowledgeCutoffAt: value.knowledgeCutoffAt,
    exAnteUpdatedAt: value.exAnteUpdatedAt,
    reason: value.reason,
    snapshot: value.snapshot,
  };
}

function normalizePersistedBrokerLinks(value) {
  const rawRecords = Array.isArray(value?.records) ? value.records : [];
  if (rawRecords.length > MAX_BROKER_RECORDS) {
    throw new Error(`券商记录超过 ${MAX_BROKER_RECORDS} 条上限。`);
  }
  const records = [];
  const recordIdSet = new Set();
  const storedOrderIds = normalizePersistedRawBrokerIds(value?.orderIds, "order");
  const storedExecutionIds = normalizePersistedRawBrokerIds(value?.executionIds, "execution");
  for (const raw of rawRecords) {
    const rawId = raw?.recordId ?? raw?.id;
    const kind = normalizeRecordKind(raw?.kind, rawId);
    const id = canonicalRecordId(rawId, kind);
    if (!id) throw new Error("券商记录 ID 无效。");
    if (recordIdSet.has(id)) throw new Error(`券商记录 ${id} 重复。`);
    const linkedAt = requiredIso(raw?.linkedAt ?? value?.lastLinkedAt ?? value?.confirmedAt, "券商记录 linkedAt 无效。");
    const occurredAt = raw?.occurredAt == null || raw?.occurredAt === ""
      ? null
      : requiredIso(raw.occurredAt, "券商记录 occurredAt 无效。");
    recordIdSet.add(id);
    records.push({
      id,
      kind,
      occurredAt,
      symbol: optionalSymbol(raw?.symbol),
      linkedAt,
      source: cleanText(raw?.source, 200) || "longbridge",
    });
  }
  records.sort(compareBrokerRecords);
  const storedRecordIds = uniqueIdsWithGuard(value?.recordIds, MAX_BROKER_RECORDS, "公开券商记录 ID");
  const migratedRecordIds = storedRecordIds.map((id) => {
    if (/^(order|execution|position|cash|other):/.test(id)) return id;
    if (storedOrderIds.includes(id)) return `order:${id}`;
    if (storedExecutionIds.includes(id)) return `execution:${id}`;
    return `other:${id}`;
  });
  const allRecordIds = uniqueIdsWithGuard(
    [...migratedRecordIds, ...records.map((item) => item.id)],
    MAX_BROKER_RECORDS,
    "公开券商记录 ID",
  );
  const requestedRecordIds = uniqueIdsWithGuard(
    value?.requestedRecordIds,
    MAX_BROKER_RECORDS,
    "用户框选券商记录 ID",
  );
  if (requestedRecordIds.some((id) => !allRecordIds.includes(id))) {
    throw new Error("持久化的用户框选记录不属于券商证据闭包。");
  }
  const orderIds = uniqueIdsWithGuard([
    ...storedOrderIds,
    ...allRecordIds.filter((id) => id.startsWith("order:")).map((id) => stripRecordPrefix(id, "order")),
    ...records.filter((item) => item.kind === "order").map((item) => stripRecordPrefix(item.id, "order")),
  ], MAX_BROKER_RECORDS, "订单 ID");
  const executionIds = uniqueIdsWithGuard([
    ...storedExecutionIds,
    ...allRecordIds.filter((id) => id.startsWith("execution:")).map((id) => stripRecordPrefix(id, "execution")),
    ...records.filter((item) => item.kind === "execution").map((item) => stripRecordPrefix(item.id, "execution")),
  ], MAX_BROKER_RECORDS, "成交 ID");
  return {
    revision: positiveIntegerOrNull(value?.evidenceRevision ?? value?.revision),
    evidenceRevision: positiveIntegerOrNull(value?.evidenceRevision ?? value?.revision),
    requestedRecordIds,
    recordIds: allRecordIds,
    orderIds,
    executionIds,
    records,
    activityStartAt: optionalIso(value?.activityStartAt),
    activityEndAt: optionalIso(value?.activityEndAt),
    lastLinkedAt: optionalIso(value?.lastLinkedAt),
    confirmedAt: optionalIso(value?.confirmedAt ?? value?.lastLinkedAt),
  };
}

function normalizePersistedBrokerState(rawLinks, rawVersions, fallbackChangedAt, fallbackActivityRange = null) {
  const normalizedLegacyLinks = normalizePersistedBrokerLinks(rawLinks);
  const legacyLinks = {
    ...normalizedLegacyLinks,
    activityStartAt: normalizedLegacyLinks.activityStartAt ?? fallbackActivityRange?.activityStartAt ?? null,
    activityEndAt: normalizedLegacyLinks.activityEndAt ?? fallbackActivityRange?.activityEndAt ?? null,
  };
  if (Array.isArray(rawVersions) && rawVersions.length > MAX_BROKER_LINK_VERSIONS) {
    throw new Error(`券商证据版本超过 ${MAX_BROKER_LINK_VERSIONS} 条上限。`);
  }
  const versions = [];
  const archive = new Map();
  let previousRevision = 0;
  let previousSelection = emptyBrokerLinks();
  for (const [index, raw] of (Array.isArray(rawVersions) ? rawVersions : []).entries()) {
    const evidenceRevision = positiveIntegerOrNull(raw?.evidenceRevision ?? raw?.revision) ?? index + 1;
    if (evidenceRevision <= previousRevision) throw new Error("券商证据版本编号必须严格递增。");
    const changedAt = requiredIso(
      raw?.changedAt ?? raw?.confirmedAt ?? fallbackChangedAt,
      "券商证据版本 changedAt 无效。",
    );
    const selection = normalizePersistedBrokerLinks({
      ...raw,
      lastLinkedAt: raw?.changedAt ?? raw?.lastLinkedAt ?? changedAt,
      confirmedAt: raw?.changedAt ?? raw?.confirmedAt ?? changedAt,
    });
    if (!hasBrokerEvidence(selection)) throw new Error("券商证据版本不能为空。");
    mergeImmutableBrokerFacts(archive, selection.records);
    const version = {
      revision: evidenceRevision,
      evidenceRevision,
      changedAt,
      reason: cleanText(raw?.reason, 500) || "历史券商证据版本",
      requestedRecordIds: [...selection.requestedRecordIds],
      recordIds: [...selection.recordIds],
      orderIds: [...selection.orderIds],
      executionIds: [...selection.executionIds],
      records: selection.records.map((item) => structuredClone(item)),
      activityStartAt: optionalIso(raw?.activityStartAt) ?? fallbackActivityRange?.activityStartAt ?? null,
      activityEndAt: optionalIso(raw?.activityEndAt) ?? fallbackActivityRange?.activityEndAt ?? null,
      added: brokerSelectionDifference(selection, previousSelection),
      removed: brokerSelectionDifference(previousSelection, selection),
      supersededBy: null,
      supersededAt: null,
    };
    versions.push(version);
    previousSelection = version;
    previousRevision = evidenceRevision;
  }
  const legacyHasEvidence = hasBrokerEvidence(legacyLinks);
  const latest = versions.at(-1) ?? null;
  if (legacyHasEvidence && (!latest || !sameBrokerEvidence(latest, legacyLinks))) {
    mergeImmutableBrokerFacts(archive, legacyLinks.records);
    const evidenceRevision = previousRevision + 1;
    const changedAt = legacyLinks.confirmedAt ?? legacyLinks.lastLinkedAt ?? fallbackChangedAt;
    versions.push({
      revision: evidenceRevision,
      evidenceRevision,
      changedAt,
      reason: latest ? "迁移当前券商关联快照" : "迁移旧版券商关联",
      requestedRecordIds: [...legacyLinks.requestedRecordIds],
      recordIds: [...legacyLinks.recordIds],
      orderIds: [...legacyLinks.orderIds],
      executionIds: [...legacyLinks.executionIds],
      records: legacyLinks.records.map((item) => structuredClone(item)),
      activityStartAt: optionalIso(rawLinks?.activityStartAt) ?? fallbackActivityRange?.activityStartAt ?? null,
      activityEndAt: optionalIso(rawLinks?.activityEndAt) ?? fallbackActivityRange?.activityEndAt ?? null,
      added: brokerSelectionDifference(legacyLinks, latest ?? emptyBrokerLinks()),
      removed: brokerSelectionDifference(latest ?? emptyBrokerLinks(), legacyLinks),
      supersededBy: null,
      supersededAt: null,
    });
  }
  for (let index = 0; index < versions.length - 1; index += 1) {
    versions[index].supersededBy = versions[index + 1].evidenceRevision;
    versions[index].supersededAt = versions[index + 1].changedAt;
  }
  const current = versions.at(-1) ?? null;
  return {
    brokerLinks: current ? brokerLinksFromVersion(current) : emptyBrokerLinks(),
    brokerLinkVersions: versions,
    evidenceRevision: current?.evidenceRevision ?? null,
  };
}

function hasBrokerEvidence(value) {
  return Boolean(value?.recordIds?.length || value?.orderIds?.length || value?.executionIds?.length);
}

function normalizeCheckpoints(values, cycle) {
  if (Array.isArray(values) && values.length > MAX_CHECKPOINTS) {
    throw new Error(`决策检查点超过 ${MAX_CHECKPOINTS} 条上限。`);
  }
  const checkpoints = [];
  const ids = new Set();
  const sequences = new Set();
  for (const [index, raw] of (Array.isArray(values) ? values : []).entries()) {
    const checkpoint = normalizeCheckpoint({ ...raw, sequence: raw?.sequence ?? index + 1 });
    if (!checkpoint.id) throw new Error("决策检查点 ID 无效。");
    if (ids.has(checkpoint.id)) throw new Error(`决策检查点 ID ${checkpoint.id} 重复。`);
    if (sequences.has(checkpoint.sequence)) throw new Error(`决策检查点序号 ${checkpoint.sequence} 重复。`);
    if (Date.parse(checkpoint.occurredAt) > Date.parse(checkpoint.recordedAt)) {
      throw new Error("决策检查点 occurredAt 晚于 recordedAt。");
    }
    if (Date.parse(checkpoint.occurredAt) < Date.parse(cycle.startAt)) {
      throw new Error("决策检查点早于复盘周期开始时间。");
    }
    if (cycle.endAt && Date.parse(checkpoint.occurredAt) > Date.parse(cycle.endAt)) {
      throw new Error("决策检查点晚于复盘周期结束时间。");
    }
    const expectedHash = sha256(stableStringify(checkpointHashPayload(checkpoint)));
    const suppliedHash = cleanText(raw?.hash, 128);
    checkpoint.hash = suppliedHash || expectedHash;
    checkpoint.integrityStatus = suppliedHash && suppliedHash !== expectedHash
      ? "mismatch"
      : (raw?.integrityStatus === "migrated" || !suppliedHash ? "migrated" : "valid");
    ids.add(checkpoint.id);
    sequences.add(checkpoint.sequence);
    checkpoints.push(checkpoint);
  }
  return checkpoints.sort(compareCheckpoints);
}

function normalizePhaseRuns(value) {
  return {
    blind: normalizeRuns(value?.blind, "blind"),
    outcome: normalizeRuns(value?.outcome, "outcome"),
    retrospective: normalizeRuns(value?.retrospective, "retrospective"),
  };
}

function normalizeRuns(values, phase) {
  if (Array.isArray(values) && values.length > MAX_RUNS_PER_PHASE) {
    throw new Error(`${phase} 阶段运行记录超过 ${MAX_RUNS_PER_PHASE} 条上限。`);
  }
  const result = [];
  const ids = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const id = cleanId(raw?.id);
    if (!id) throw new Error(`${phase} 阶段运行 ID 无效。`);
    if (ids.has(id)) throw new Error(`${phase} 阶段运行 ID ${id} 重复。`);
    if (raw?.phase != null && raw.phase !== phase) throw new Error(`${phase} 阶段运行记录的 phase 冲突。`);
    const recordedAt = requiredIso(raw?.recordedAt ?? raw?.completedAt, `${phase} 阶段 recordedAt 无效。`);
    ids.add(id);
    const normalizedResult = sanitizeRunResult(raw?.result);
    const expectedResultHash = sha256(stableStringify(normalizedResult));
    const suppliedResultHash = cleanText(raw?.resultHash, 128);
    const run = {
      id,
      phase,
      status: normalizePersistedRunStatus(raw?.status),
      startedAt: raw?.startedAt == null ? recordedAt : requiredIso(raw.startedAt, `${phase} 阶段 startedAt 无效。`),
      completedAt: raw?.completedAt == null ? recordedAt : requiredIso(raw.completedAt, `${phase} 阶段 completedAt 无效。`),
      recordedAt,
      threadId: cleanText(raw?.threadId, 200),
      model: cleanText(raw?.model, 120),
      exAnteVersion: nonNegativeInteger(raw?.exAnteVersion, 0) || null,
      retrospectiveVersion: nonNegativeInteger(raw?.retrospectiveVersion, 0) || null,
      evidenceRevision: positiveIntegerOrNull(raw?.evidenceRevision),
      evidenceFilterPolicyVersion: positiveIntegerOrNull(raw?.evidenceFilterPolicyVersion),
      blindRunId: cleanId(raw?.blindRunId),
      inputSnapshotHash: cleanText(raw?.inputSnapshotHash, 128),
      result: normalizedResult,
      resultHash: suppliedResultHash || expectedResultHash,
    };
    if (Date.parse(run.startedAt) > Date.parse(run.completedAt)) {
      throw new Error(`${phase} 阶段 completedAt 早于 startedAt。`);
    }
    if (Date.parse(run.completedAt) > Date.parse(run.recordedAt)) {
      throw new Error(`${phase} 阶段 completedAt 晚于 recordedAt。`);
    }
    const expectedHash = sha256(stableStringify(runHashPayload(run)));
    const suppliedHash = cleanText(raw?.hash, 128);
    run.hash = suppliedHash || expectedHash;
    run.integrityStatus = (
      (suppliedResultHash && suppliedResultHash !== expectedResultHash)
      || (suppliedHash && suppliedHash !== expectedHash)
    ) ? "mismatch" : (raw?.integrityStatus === "migrated" || !suppliedHash ? "migrated" : "valid");
    result.push(run);
  }
  return result;
}

function runHashPayload(value) {
  const { hash: _hash, integrityStatus: _integrityStatus, ...payload } = value;
  // Runs written before broker-evidence revisions existed did not hash this
  // field. Omitting null preserves their original integrity signature.
  if (payload.evidenceRevision == null) delete payload.evidenceRevision;
  if (payload.evidenceFilterPolicyVersion == null) delete payload.evidenceFilterPolicyVersion;
  return payload;
}

function transitionStatus(cycle, requested) {
  const next = enumValue(requested, [...CYCLE_STATUSES], null);
  if (!next) throw new Error("复盘周期状态无效。");
  if (next === cycle.status) return;
  if (!STATUS_TRANSITIONS[cycle.status]?.has(next)) {
    throw new Error(`复盘周期不能从 ${cycle.status} 转为 ${next}。`);
  }
  cycle.status = next;
}

function latestKnownActivityAt(cycle) {
  const timestamps = [
    ...cycle.checkpoints.map((item) => item.occurredAt),
    ...cycle.brokerLinks.records.map((item) => item.occurredAt).filter(Boolean),
  ];
  return timestamps.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function normalizeCycleType(value) {
  const type = String(value ?? "").trim();
  if (!CYCLE_TYPES.has(type)) throw new Error("复盘周期类型无效。");
  return type;
}

function requiredCycle(workspace, id) {
  const cycle = workspace.cycles.find((item) => item.id === cleanId(id));
  if (!cycle) throw new Error("未找到复盘周期。");
  return cycle;
}

function requireRetrospectiveVersion(cycle) {
  const version = cycle?.retrospectiveVersions?.at(-1) ?? null;
  if (!version || version.integrityStatus === "mismatch") {
    throw new Error("直接事后复盘前，请先保存完整的判断、感悟与未来预判。");
  }
  validateRetrospectiveNote(version.snapshot);
  return version;
}

function requiredNewId(value, workspace) {
  const id = cleanId(value);
  if (!id) throw new Error("复盘周期 ID 无效。");
  if (workspace.cycles.some((item) => item.id === id)) throw new Error("复盘周期 ID 冲突。");
  return id;
}

function requiredNewCheckpointId(value, cycle) {
  const id = cleanId(value);
  if (!id) throw new Error("检查点 ID 无效。");
  if (cycle.checkpoints.some((item) => item.id === id)) throw new Error("检查点 ID 冲突。");
  return id;
}

function requiredNewRunId(value, cycle) {
  const id = cleanId(value);
  if (!id) throw new Error("运行 ID 无效。");
  if ([...cycle.phaseRuns.blind, ...cycle.phaseRuns.outcome, ...cycle.phaseRuns.retrospective]
    .some((item) => item.id === id)) {
    throw new Error("复盘运行 ID 冲突。");
  }
  return id;
}

function defaultTitle(type, symbols, startAt, month = null) {
  if (type === "catalyst") return `${symbols.join(" / ")} 催化剂周期`;
  if (type === "position_lifecycle") return `${symbols[0]} 持仓生命周期`;
  if (type === "trade_window") return `${symbols[0]} 订单区间复盘`;
  return `${month || startAt.slice(0, 7)} 月度组合复盘`;
}

function normalizeReviewMode(value, fallback = "rigorous") {
  return enumValue(value, ["lightweight", "rigorous"], fallback);
}

function emptyBrokerLinks() {
  return {
    revision: null,
    evidenceRevision: null,
    requestedRecordIds: [],
    recordIds: [],
    orderIds: [],
    executionIds: [],
    records: [],
    activityStartAt: null,
    activityEndAt: null,
    lastLinkedAt: null,
    confirmedAt: null,
  };
}

function normalizeTimeZone(value) {
  const timezone = cleanText(value, 80) || "Asia/Shanghai";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    return timezone;
  } catch {
    throw new Error("复盘周期 timezone 无效。");
  }
}

function monthKeyInTimeZone(value, timezone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("复盘周期月份时间无效。");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}`;
}

function endOfMonthInTimeZone(startAt, timezone) {
  const [yearText, monthText] = monthKeyInTimeZone(startAt, timezone).split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const nextStart = zonedLocalMidnightIso(nextYear, nextMonth, 1, timezone);
  return new Date(Date.parse(nextStart) - 1).toISOString();
}

function zonedLocalMidnightIso(year, month, day, timezone) {
  const desiredUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let guess = desiredUtc;
  for (let index = 0; index < 3; index += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const part = (type) => Number(parts.find((item) => item.type === type)?.value);
    const representedUtc = Date.UTC(
      part("year"),
      part("month") - 1,
      part("day"),
      part("hour"),
      part("minute"),
      part("second"),
    );
    const corrected = guess + (desiredUtc - representedUtc);
    if (corrected === guess) break;
    guess = corrected;
  }
  return new Date(guess).toISOString();
}

function compareCheckpoints(left, right) {
  return Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
    || left.sequence - right.sequence
    || Date.parse(left.recordedAt) - Date.parse(right.recordedAt)
    || left.id.localeCompare(right.id);
}

function compareBrokerRecords(left, right) {
  return (Date.parse(left.occurredAt ?? left.linkedAt) - Date.parse(right.occurredAt ?? right.linkedAt))
    || left.id.localeCompare(right.id);
}

function normalizeBenchmark(value) {
  const benchmark = String(value ?? "QQQ.US").trim().toUpperCase();
  if (!/^[A-Z0-9._:-]{1,40}$/.test(benchmark)) throw new Error("基准代码无效。");
  return benchmark;
}

function optionalSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9._:-]{1,40}$/.test(symbol) ? symbol : null;
}

function uniqueSymbols(values) {
  const result = [...new Set((Array.isArray(values) ? values : [])
    .map(optionalSymbol)
    .filter(Boolean))];
  if (result.length > MAX_SYMBOLS) throw new Error(`每个周期最多包含 ${MAX_SYMBOLS} 个标的。`);
  return result;
}

function uniqueIds(values, maximum) {
  return [...new Set((Array.isArray(values) ? values : []).map(cleanId).filter(Boolean))].slice(0, maximum);
}

function uniqueIdsWithGuard(values, maximum, label) {
  const raw = Array.isArray(values) ? values : [];
  const result = [...new Set(raw.map(cleanId).filter(Boolean))];
  if (result.length > maximum) throw new Error(`${label} 超过 ${maximum} 条上限。`);
  return result;
}

function normalizeIncomingRawBrokerIds(values, expectedKind) {
  return uniqueIdsWithGuard(values, MAX_BROKER_RECORDS, `${expectedKind} ID`).map((id) => {
    const prefix = recordIdPrefix(id);
    if (prefix) {
      throw new Error(`${expectedKind}Ids 必须保存裸券商 ID，不能使用 ${prefix}: 前缀。`);
    }
    return id;
  });
}

function normalizePersistedRawBrokerIds(values, expectedKind) {
  return uniqueIdsWithGuard(values, MAX_BROKER_RECORDS, `${expectedKind} ID`).map((id) => {
    const prefix = recordIdPrefix(id);
    if (prefix && prefix !== expectedKind) {
      throw new Error(`${expectedKind}Ids 包含不匹配的 ${prefix}: 前缀。`);
    }
    return prefix ? stripRecordPrefix(id, expectedKind) : id;
  });
}

function mergeIdsWithLimit(existing, incoming, label) {
  const merged = uniqueIds([...(existing ?? []), ...(Array.isArray(incoming) ? incoming : [])], Number.MAX_SAFE_INTEGER);
  if (merged.length > MAX_BROKER_RECORDS) throw new Error(`每个周期最多关联 ${MAX_BROKER_RECORDS} 条${label}记录。`);
  return merged;
}

function uniqueStrings(values, maximum, limit) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((item) => cleanText(item, limit))
    .filter(Boolean))].slice(0, maximum);
}

function requiredIso(value, message) {
  const millis = Date.parse(String(value ?? ""));
  if (!Number.isFinite(millis)) throw new Error(message);
  return new Date(millis).toISOString();
}

function inputIsoOrDefault(value, fallback, message) {
  return value == null || value === "" ? fallback : requiredIso(value, message);
}

function optionalIso(value) {
  if (value == null || value === "") return null;
  const millis = Date.parse(String(value));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function cleanText(value, limit) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, limit) : null;
}

function cleanId(value) {
  return cleanText(value, 200);
}

function enumValue(value, choices, fallback) {
  return choices.includes(value) ? value : fallback;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedNumber(value, minimum, maximum) {
  const number = finiteOrNull(value);
  return number == null ? null : Math.min(Math.max(number, minimum), maximum);
}

function normalizeCurrency(value) {
  const currency = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3,8}$/.test(currency)) throw new Error("币种代码无效。");
  return currency;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

function positiveInteger(value, message) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(message);
  return number;
}

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizePersistedRunStatus(value) {
  if (value == null) return "failed";
  if (!["completed", "failed", "cancelled"].includes(value)) {
    throw new Error("复盘运行状态无效。");
  }
  return value;
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
