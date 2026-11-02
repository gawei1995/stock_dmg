import { createHash, randomUUID } from "node:crypto";

export const RESEARCH_THESIS_STORE_KEY = "researchThesesV1";
export const RESEARCH_THESIS_SCHEMA_VERSION = "research-theses/v1";
export const RESEARCH_THESIS_FIELDS = Object.freeze([
  "myView", "marketBelief", "expectationGap", "counterEvidence", "nextTrigger",
  "horizon", "invalidation", "stage", "nextReviewAt",
]);
export const RESEARCH_THESIS_STAGES = Object.freeze(["0", "1", "2", "3", "4P", "4E", "4F", "2R", "3R", "unknown"]);
const FIELDS = new Set(RESEARCH_THESIS_FIELDS);
const STAGES = new Set(RESEARCH_THESIS_STAGES);
const STATUSES = new Set(["active", "watching", "archived"]);
const OBSERVATION_STATUSES = new Set(["pending", "confirmed", "contradicted", "inconclusive"]);
const LIMITS = Object.freeze({ theses: 200, versions: 100, evidence: 300, observations: 300, proposals: 100, reviewLinks: 100 });

/** Account-independent research judgments, not positions, orders or an execution harness. */
export class ResearchThesisStore {
  constructor({ store, now = () => new Date(), idFactory = randomUUID, canWrite = () => true } = {}) {
    if (typeof store?.get !== "function" || typeof store?.set !== "function") throw new TypeError("ResearchThesisStore requires a persistent store.");
    if (typeof now !== "function" || typeof idFactory !== "function" || typeof canWrite !== "function") throw new TypeError("Research store callbacks must be functions.");
    this.store = store;
    this.now = now;
    this.idFactory = idFactory;
    this.canWrite = canWrite;
    this.queue = Promise.resolve();
  }

  async snapshot({ includeArchived = false } = {}) {
    await this.queue;
    const state = readState(await this.store.get(RESEARCH_THESIS_STORE_KEY));
    return clone({ ...state, theses: state.theses.filter((item) => includeArchived || item.status !== "archived") });
  }

  async create(input = {}) {
    return this.#mutate((state, at) => {
      capacity(state.theses, LIMITS.theses, "研究记录");
      if (input.fields != null) assertFieldPatch(input.fields);
      const fields = normalizeFields(input.fields ?? input);
      const name = text(input.name, 160) ?? text(input.symbol, 40) ?? fields.myView?.slice(0, 64) ?? "未命名研究";
      const symbol = normalizeSymbol(input.symbol);
      const id = uniqueId(this.idFactory(), state.theses.map((item) => item.id));
      const version = seal({ version: 1, recordedAt: at, name, symbol, fields, origin: "user", fieldOrigins: fieldOrigins(fields, { origin: "user", recordedAt: at }) });
      const thesis = { id, name, symbol, revision: 1, status: "active", createdAt: at, updatedAt: at, versions: [version], evidence: [], observations: [], proposals: [], reviewLinks: [], statusHistory: [seal({ status: "active", recordedAt: at, revision: 1 })] };
      state.theses.unshift(thesis);
      return thesis;
    }, input);
  }

  async revise(id, input = {}) {
    return this.#mutateThesis(id, input, (thesis, at) => {
      assertActive(thesis);
      capacity(thesis.versions, LIMITS.versions, "判断版本");
      const previous = thesis.versions.at(-1);
      const patch = input.fields ?? input;
      if (input.fields != null) assertFieldPatch(input.fields);
      const fields = normalizeFields(patch, previous.fields);
      const name = Object.hasOwn(input, "name") ? requiredText(input.name, 160, "研究名称") : previous.name;
      const symbol = Object.hasOwn(input, "symbol") ? normalizeSymbol(input.symbol) : previous.symbol;
      const origins = clone(previous.fieldOrigins);
      for (const field of RESEARCH_THESIS_FIELDS) if (Object.hasOwn(patch, field)) origins[field] = { origin: "user", recordedAt: at };
      thesis.versions.push(seal({ version: previous.version + 1, recordedAt: at, name, symbol, fields, origin: "user", fieldOrigins: origins }));
      thesis.name = name;
      thesis.symbol = symbol;
    });
  }

  async addEvidence(id, input = {}) {
    return this.#mutateThesis(id, input, (thesis, at) => {
      assertActive(thesis);
      capacity(thesis.evidence, LIMITS.evidence, "研究证据");
      thesis.evidence.push(seal({ id: this.#newId(thesis.evidence), thesisVersion: thesis.versions.at(-1).version, ...normalizeEvidence(input, at), recordedAt: at }));
    });
  }

  async addObservation(id, input = {}) {
    return this.#mutateThesis(id, input, (thesis, at) => {
      assertActive(thesis);
      capacity(thesis.observations, LIMITS.observations, "观察记录");
      const status = input.status ?? "pending";
      if (!OBSERVATION_STATUSES.has(status)) fail("research_observation_invalid", "观察结果无效。");
      const note = requiredText(input.note ?? input.outcome, 5000, "观察内容");
      thesis.observations.push(seal({ id: this.#newId(thesis.observations), thesisVersion: thesis.versions.at(-1).version, status, note, eventAt: optionalIso(input.eventAt), recordedAt: at, origin: "user", interpretation: "recorded_observation_not_stage_promotion" }));
    });
  }

  async setStatus(id, input = {}) {
    return this.#mutateThesis(id, input, (thesis, at) => {
      if (!STATUSES.has(input.status)) fail("research_status_invalid", "研究状态无效。");
      capacity(thesis.statusHistory, 300, "状态记录");
      thesis.status = input.status;
      thesis.statusHistory.push(seal({ status: input.status, recordedAt: at, revision: thesis.revision + 1 }));
    });
  }

  async saveProposal(id, input = {}) {
    return this.#mutateThesis(id, input, (thesis, at) => {
      assertActive(thesis);
      capacity(thesis.proposals, LIMITS.proposals, "AI 草案");
      const normalized = normalizeProposal(input.proposal, at);
      thesis.proposals.push(seal({ id: this.#newId(thesis.proposals), ...normalized, baseThesisVersion: thesis.versions.at(-1).version, baseRevision: thesis.revision, recordedAt: at, status: "pending", origin: "ai_proposal", sourceRunId: requiredText(input.sourceRunId, 160, "分析运行标识"), sourceThreadId: requiredText(input.sourceThreadId, 160, "分析对话标识"), adoption: null, supersededAt: null }));
    });
  }

  async acceptProposal(id, input = {}) {
    if (input.confirmed !== true) fail("research_confirmation_required", "请先编辑并明确确认要采用的 AI 草案字段。");
    return this.#mutateThesis(id, input, (thesis, at) => {
      assertActive(thesis);
      const proposal = thesis.proposals.find((item) => item.id === input.proposalId);
      if (proposal?.status === "superseded") fail("research_proposal_stale", "草案生成后研究记录已有变化，请重新生成或手动保存判断。");
      if (!proposal || proposal.status !== "pending") fail("research_proposal_missing", "待确认的 AI 草案不存在。");
      if (proposal.baseRevision + 1 !== thesis.revision || proposal.baseThesisVersion !== thesis.versions.at(-1).version) fail("research_proposal_stale", "草案生成后研究记录已有变化，请重新生成或手动保存判断。");
      const patch = input.fields ?? input.patch;
      if (!isObject(patch) || !Object.keys(patch).length || Object.keys(patch).some((key) => !FIELDS.has(key))) fail("research_proposal_fields_invalid", "请明确选择要采用的研究字段，证据不会自动采用。");
      const selectedIndexes = input.selectedEvidenceIndexes ?? [];
      if (!Array.isArray(selectedIndexes) || selectedIndexes.some((index) => !Number.isInteger(index) || index < 0 || index >= proposal.evidence.length) || new Set(selectedIndexes).size !== selectedIndexes.length) fail("research_proposal_evidence_invalid", "请选择有效且不重复的 AI 来源条目。");
      if (thesis.evidence.length + selectedIndexes.length > LIMITS.evidence) fail("research_capacity", "所选证据超过研究证据容量，未裁剪或部分采用。");
      const fingerprints = new Set(thesis.evidence.map(evidenceFingerprint));
      for (const index of selectedIndexes) {
        const fingerprint = evidenceFingerprint(proposal.evidence[index]);
        if (fingerprints.has(fingerprint)) fail("research_evidence_duplicate", "所选来源与已有证据或其他勾选来源重复，请取消重复条目。");
        fingerprints.add(fingerprint);
      }
      capacity(thesis.versions, LIMITS.versions, "判断版本");
      const previous = thesis.versions.at(-1);
      const fields = normalizeFields(patch, previous.fields);
      const origins = clone(previous.fieldOrigins);
      const origin = { origin: "accepted_ai_proposal", proposalId: proposal.id, sourceRunId: proposal.sourceRunId, sourceThreadId: proposal.sourceThreadId, recordedAt: at };
      for (const key of Object.keys(patch)) origins[key] = clone(origin);
      thesis.versions.push(seal({ version: previous.version + 1, recordedAt: at, name: previous.name, symbol: previous.symbol, fields, origin: "accepted_ai_proposal", fieldOrigins: origins }));
      const adoptedEvidence = selectedIndexes.map((index) => {
        const evidence = seal({
          id: this.#newId(thesis.evidence), thesisVersion: previous.version + 1,
          ...normalizeEvidence(proposal.evidence[index], at, true),
          provenance: "ai_accepted_unverified",
          acceptance: { proposalId: proposal.id, sourceRunId: proposal.sourceRunId, sourceThreadId: proposal.sourceThreadId, proposalEvidenceIndex: index, acceptedByUser: true, recordedAt: at },
          recordedAt: at,
        });
        thesis.evidence.push(evidence);
        return evidence;
      });
      proposal.status = "adopted";
      proposal.adoption = { recordedAt: at, thesisVersion: previous.version + 1, fields: Object.keys(patch).sort(), selectedEvidenceIndexes: [...selectedIndexes], evidenceIds: adoptedEvidence.map((item) => item.id) };
      proposal.contentHash = digest(proposal);
    });
  }

  async linkReview(id, input = {}) {
    if (input.confirmed !== true) fail("research_confirmation_required", "请明确确认关联到所选复盘周期。");
    return this.#mutateThesis(id, input, (thesis, at) => {
      assertActive(thesis);
      capacity(thesis.reviewLinks, LIMITS.reviewLinks, "复盘关联");
      const cycleId = requiredText(input.cycleId, 160, "复盘周期标识");
      const accountScopeId = requiredText(input.accountScopeId, 160, "复盘账户范围");
      if (thesis.reviewLinks.some((item) => item.cycleId === cycleId && item.accountScopeId === accountScopeId && item.thesisVersion === thesis.versions.at(-1).version)) fail("research_review_duplicate", "此判断版本已关联该复盘周期。");
      const contextSnapshot = buildResearchThesisContext(thesis, { asOf: at });
      thesis.reviewLinks.push(seal({ id: this.#newId(thesis.reviewLinks), cycleId, accountScopeId, cycleTitle: requiredText(input.cycleTitle, 240, "复盘周期名称"), thesisVersion: thesis.versions.at(-1).version, thesisRecordedAt: thesis.versions.at(-1).recordedAt, linkedAt: at, contextSnapshot, contextHash: sha256(stableStringify(contextSnapshot)), interpretation: "supplementary_recorded_judgment_not_ex_ante_baseline" }));
    });
  }

  async context(id, options = {}) {
    await this.queue;
    const state = readState(await this.store.get(RESEARCH_THESIS_STORE_KEY));
    return buildResearchThesisContext(requiredThesis(state, id), { ...options, asOf: options.asOf ?? nowIso(this.now) });
  }

  #newId(items) { return uniqueId(this.idFactory(), items.map((item) => item.id)); }

  async #mutateThesis(id, input, updater) {
    return this.#mutate((state, at) => {
      const thesis = requiredThesis(state, id);
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== thesis.revision) fail("research_revision_conflict", "研究记录已变化，请刷新后重试，未覆盖新内容。");
      updater(thesis, at);
      thesis.revision += 1;
      thesis.updatedAt = at;
      for (const proposal of thesis.proposals) {
        if (proposal.status === "pending" && proposal.baseRevision + 1 !== thesis.revision) {
          proposal.status = "superseded";
          proposal.supersededAt = at;
          proposal.contentHash = digest(proposal);
        }
      }
      return thesis;
    }, input);
  }

  async #mutate(updater, { commitGuard = null } = {}) {
    const operation = this.queue.then(async () => {
      const guard = () => {
        assertSyncGuard(this.canWrite);
        if (commitGuard != null) assertSyncGuard(commitGuard);
        return true;
      };
      guard();
      const state = readState(await this.store.get(RESEARCH_THESIS_STORE_KEY));
      guard();
      const at = nowIso(this.now);
      if (state.updatedAt && at < state.updatedAt) fail("research_clock_regression", "系统时间早于已有研究记录，已停止写入以免倒填历史。");
      const result = updater(state, at);
      state.revision += 1;
      state.updatedAt = at;
      validateState(state);
      guard();
      await this.store.set(RESEARCH_THESIS_STORE_KEY, state, { commitGuard: guard });
      guard();
      return clone(result);
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

/** A bounded research packet, never proof of historical market knowledge. */
export function buildResearchThesisContext(thesis, options = {}) {
  validateThesis(thesis);
  const asOf = requiredIso(options.asOf ?? thesis.updatedAt);
  const maxEvidence = boundedInteger(options.maxEvidence, 12, 0, 40);
  const maxObservations = boundedInteger(options.maxObservations, 8, 0, 30);
  const maxTextChars = boundedInteger(options.maxTextChars, 1200, 80, 5000);
  const maxChars = boundedInteger(options.maxChars, 12000, 3000, 50000);
  const versions = thesis.versions.filter((item) => item.recordedAt <= asOf);
  const version = versions.at(-1) ?? null;
  const knownEvidence = thesis.evidence.filter((item) => item.recordedAt <= asOf);
  const knownObservations = thesis.observations.filter((item) => item.recordedAt <= asOf);
  let truncatedTextFields = 0;
  const shorten = (value, limit = maxTextChars) => {
    if (typeof value !== "string" || value.length <= limit) return value;
    truncatedTextFields += 1;
    return `${value.slice(0, limit - 1)}…`;
  };
  const fields = version ? Object.fromEntries(Object.entries(version.fields).map(([key, value]) => [key, shorten(value)])) : null;
  const result = {
    schemaVersion: "research-thesis-context/v1", id: thesis.id,
    name: version?.name ?? null, symbol: version?.symbol ?? null,
    asOf, recordedAt: version?.recordedAt ?? null, version: version?.version ?? null,
    revision: asOf >= thesis.updatedAt ? thesis.revision : null,
    revisionAsOfUnverified: asOf < thesis.updatedAt,
    available: Boolean(version), fields,
    fieldOrigins: version ? clone(version.fieldOrigins) : null,
    evidence: knownEvidence.slice(-maxEvidence || knownEvidence.length).filter(() => maxEvidence > 0).map((item) => ({
      id: item.id, thesisVersion: item.thesisVersion, claim: shorten(item.claim), stance: item.stance,
      kind: item.kind, sourceTitle: item.sourceTitle, url: item.url, publishedAt: item.publishedAt,
      knownAt: item.knownAt, knownAtVerified: false, recordedAt: item.recordedAt, retrievedAt: null, retrievalStatus: "not_host_verified",
      provenance: item.provenance, acceptance: clone(item.acceptance), pointInTimeEligible: false, numeric: clone(item.numeric),
    })),
    observations: knownObservations.slice(-maxObservations || knownObservations.length).filter(() => maxObservations > 0).map((item) => ({ id: item.id, thesisVersion: item.thesisVersion, status: item.status, note: shorten(item.note), eventAt: item.eventAt, recordedAt: item.recordedAt })),
    coverage: { versionsAvailable: versions.length, evidenceTotal: thesis.evidence.length, evidenceKnownByCutoff: knownEvidence.length, evidenceIncluded: 0, evidenceOmitted: 0, evidenceAfterCutoff: thesis.evidence.length - knownEvidence.length, observationsTotal: thesis.observations.length, observationsKnownByCutoff: knownObservations.length, observationsIncluded: 0, observationsOmitted: 0, observationsAfterCutoff: thesis.observations.length - knownObservations.length, truncatedTextFields: 0, truncated: false, maxChars },
    limitations: ["仅为明确选择的研究记录；不是自动导入的账户或其他会话。", "记录时间是本机保存时间，不是来源抓取时间；本机未核验实际抓取、来源发布日期及自报知悉时间，不能据此认定事前已知。", "补充判断不替代封存的事前基线，不赋予正式复盘评分资格。", "AI 草案和未采用的建议不属于用户判断；观察结果不自动升级 Stage。"],
    historicalPointInTimeVerified: false,
  };
  const refreshCoverage = () => {
    Object.assign(result.coverage, { evidenceIncluded: result.evidence.length, evidenceOmitted: knownEvidence.length - result.evidence.length, observationsIncluded: result.observations.length, observationsOmitted: knownObservations.length - result.observations.length, truncatedTextFields, truncated: knownEvidence.length > result.evidence.length || knownObservations.length > result.observations.length || truncatedTextFields > 0 });
  };
  refreshCoverage();
  while (JSON.stringify(result).length > maxChars && (result.evidence.length || result.observations.length)) {
    if (result.evidence.length >= result.observations.length) result.evidence.shift(); else result.observations.shift();
    refreshCoverage();
  }
  if (JSON.stringify(result).length > maxChars && result.fields) {
    for (const key of RESEARCH_THESIS_FIELDS) {
      if (JSON.stringify(result).length <= maxChars) break;
      if (typeof result.fields[key] === "string" && result.fields[key].length > 80) result.fields[key] = shorten(result.fields[key], 80);
    }
    refreshCoverage();
  }
  // A metadata-rich packet may need less origin detail; it is already preserved in the durable version.
  if (JSON.stringify(result).length > maxChars) {
    result.fieldOrigins = null;
    result.coverage.originsOmitted = true;
    result.coverage.truncated = true;
  }
  if (JSON.stringify(result).length > maxChars) fail("research_context_limit", "研究上下文元数据超过所选上限，请提高容量；未静默截断。");
  return clone(result);
}

function normalizeFields(input, previous = null) {
  if (!isObject(input)) fail("research_fields_invalid", "研究字段格式无效。");
  const fields = previous ? clone(previous) : Object.fromEntries(RESEARCH_THESIS_FIELDS.map((key) => [key, null]));
  for (const key of RESEARCH_THESIS_FIELDS) {
    if (!Object.hasOwn(input, key)) continue;
    if (key === "stage") {
      const value = input[key] == null || input[key] === "" ? null : String(input[key]);
      if (value != null && !STAGES.has(value)) fail("research_stage_invalid", "Stage 必须是明确阶段或 unknown，不能凭观察自动推断。");
      fields[key] = value;
    } else if (key === "nextReviewAt") fields[key] = optionalIso(input[key]);
    else fields[key] = text(input[key], key === "horizon" ? 500 : 5000);
  }
  return fields;
}

function normalizeEvidence(input, at, suggested = false) {
  if (!isObject(input)) fail("research_evidence_invalid", "证据格式无效。");
  const stance = input.stance ?? "context";
  const kind = input.kind ?? "inference";
  if (!["support", "counter", "context"].includes(stance) || !["fact", "inference"].includes(kind)) fail("research_evidence_invalid", "证据立场或事实/推断分类无效。");
  return { claim: requiredText(input.claim, 5000, "证据内容"), stance, kind,
    sourceTitle: text(input.sourceTitle, 300), url: safeUrl(input.url), publishedAt: optionalIso(input.publishedAt), knownAt: optionalIso(input.knownAt),
    // Saving a user's URL or a model-suggested source does not prove that the
    // host fetched it. Keep capture time separate from source-retrieval facts.
    knownAtVerified: false, retrievedAt: null, retrievalStatus: "not_host_verified", provenance: suggested ? "ai_suggested_unverified" : "manual_unverified", acceptance: null, pointInTimeEligible: false, numeric: normalizeNumeric(input.numeric) };
}

function normalizeProposal(input, at) {
  if (!isObject(input)) fail("research_proposal_invalid", "AI 草案格式无效。");
  if (!isObject(input.fields) || Object.keys(input.fields).some((key) => !FIELDS.has(key))) fail("research_proposal_invalid", "AI 草案含不支持的研究字段。");
  const normalizedFields = normalizeFields(input.fields);
  const fields = Object.fromEntries(Object.keys(input.fields).map((key) => [key, normalizedFields[key]]));
  const evidence = input.evidence ?? [];
  const openQuestions = input.openQuestions ?? [];
  if (!Array.isArray(evidence) || evidence.length > 24 || !Array.isArray(openQuestions) || openQuestions.length > 20) fail("research_proposal_invalid", "AI 草案数量超出上限。");
  if (!Object.keys(fields).length && !evidence.length && !openQuestions.length) fail("research_proposal_invalid", "AI 草案没有可展示的内容。");
  return { fields, evidence: evidence.map((item) => normalizeEvidence(item, at, true)), openQuestions: openQuestions.map((item) => requiredText(item, 1200, "待验证问题")) };
}

function normalizeNumeric(input) {
  if (input == null) return null;
  if (!isObject(input) || !Object.hasOwn(input, "value") || typeof input.value !== "number" || !Number.isFinite(input.value)) fail("research_numeric_invalid", "数值证据必须包含有限数字，缺失不能当作零。");
  const denominator = input.denominator == null ? null : typeof input.denominator === "number" ? input.denominator : text(input.denominator, 300);
  if (typeof denominator === "number" && !Number.isFinite(denominator)) fail("research_numeric_invalid", "数值证据分母无效。");
  const currency = text(input.currency, 12);
  if (currency && !/^[A-Z]{3}$/.test(currency)) fail("research_numeric_invalid", "币种需使用三位大写代码。");
  return { value: input.value, unit: text(input.unit, 80), period: text(input.period, 160), currency, denominator };
}

/** Validate a known backup key without opening a store or changing its contents. */
export function validateResearchThesisState(value) {
  // Absence is handled by the backup manifest. A present known key may not be
  // replaced with an empty ledger by treating null/undefined as a fresh store.
  if (value == null) invalidState();
  return readState(value);
}

function readState(value) {
  if (value == null) return { schemaVersion: RESEARCH_THESIS_SCHEMA_VERSION, revision: 0, updatedAt: null, theses: [] };
  validateState(value);
  return clone(value);
}

function validateState(state) {
  if (!isObject(state) || state.schemaVersion !== RESEARCH_THESIS_SCHEMA_VERSION || !Number.isInteger(state.revision) || state.revision < 0 || !Array.isArray(state.theses) || state.theses.length > LIMITS.theses) invalidState();
  if (state.updatedAt != null) exactIso(state.updatedAt);
  if (state.revision === 0 && (state.updatedAt != null || state.theses.length)) invalidState();
  if (state.revision > 0 && !state.updatedAt) invalidState();
  const ids = new Set();
  for (const thesis of state.theses) {
    validateThesis(thesis);
    if (ids.has(thesis.id) || state.updatedAt < thesis.updatedAt || state.revision < thesis.revision) invalidState();
    ids.add(thesis.id);
  }
}

function validateThesis(thesis) {
  if (!isObject(thesis) || !validId(thesis.id) || !Number.isInteger(thesis.revision) || thesis.revision < 1 || !STATUSES.has(thesis.status)) invalidState();
  exactIso(thesis.createdAt); exactIso(thesis.updatedAt);
  if (thesis.updatedAt < thesis.createdAt) invalidState();
  for (const [key, maximum] of Object.entries(LIMITS)) if (key !== "theses" && (!Array.isArray(thesis[key]) || thesis[key].length > maximum)) invalidState();
  if (!Array.isArray(thesis.statusHistory) || !thesis.statusHistory.length || thesis.statusHistory.length > 300 || !thesis.versions.length) invalidState();
  const last = thesis.versions.at(-1);
  if (thesis.name !== last.name || thesis.symbol !== last.symbol || thesis.createdAt !== thesis.versions[0].recordedAt || thesis.status !== thesis.statusHistory.at(-1).status) invalidState();
  let priorAt = thesis.createdAt;
  thesis.versions.forEach((version, index) => {
    verifySeal(version);
    if (version.version !== index + 1 || !["user", "accepted_ai_proposal"].includes(version.origin)) invalidState();
    exactIso(version.recordedAt);
    if (version.recordedAt < priorAt || version.recordedAt > thesis.updatedAt || requiredText(version.name, 160, "名称") !== version.name || normalizeSymbol(version.symbol) !== version.symbol || !same(normalizeFields(version.fields), version.fields)) invalidState();
    if (!isObject(version.fieldOrigins) || Object.keys(version.fieldOrigins).some((key) => !FIELDS.has(key))) invalidState();
    for (const [key, origin] of Object.entries(version.fieldOrigins)) {
      if (!isObject(origin) || !["user", "accepted_ai_proposal"].includes(origin.origin) || !Object.hasOwn(version.fields, key)) invalidState();
      exactIso(origin.recordedAt);
      if (origin.recordedAt > version.recordedAt) invalidState();
    }
    priorAt = version.recordedAt;
  });
  for (const [key, timestamp] of [["evidence", "recordedAt"], ["observations", "recordedAt"], ["proposals", "recordedAt"], ["reviewLinks", "linkedAt"], ["statusHistory", "recordedAt"]]) {
    const ids = new Set();
    let previous = thesis.createdAt;
    for (const item of thesis[key]) {
      verifySeal(item); exactIso(item[timestamp]);
      if (item[timestamp] < previous || item[timestamp] > thesis.updatedAt) invalidState();
      previous = item[timestamp];
      if (key !== "statusHistory") {
        if (!validId(item.id) || ids.has(item.id)) invalidState();
        ids.add(item.id);
      }
      if (["evidence", "observations", "reviewLinks"].includes(key)) {
        const version = thesis.versions[item.thesisVersion - 1];
        if (!Number.isInteger(item.thesisVersion) || !version || version.recordedAt > item[timestamp]) invalidState();
      }
      if (key === "evidence") {
        const expected = normalizeEvidence(item, item.recordedAt);
        if (item.provenance === "ai_accepted_unverified") {
          validateEvidenceAcceptance(item, thesis);
          expected.provenance = "ai_accepted_unverified";
          expected.acceptance = clone(item.acceptance);
        }
        if (!same(expected, Object.fromEntries(Object.keys(expected).map((field) => [field, item[field]]))) || item.retrievedAt !== null || item.retrievalStatus !== "not_host_verified") invalidState();
      } else if (key === "observations") {
        if (!OBSERVATION_STATUSES.has(item.status) || item.origin !== "user" || item.note !== requiredText(item.note, 5000, "观察")) invalidState();
        if (item.eventAt != null) exactIso(item.eventAt);
      } else if (key === "proposals") validateProposal(item, thesis);
      else if (key === "reviewLinks") {
        if (!validId(item.cycleId) || !validId(item.accountScopeId) || item.contextHash !== sha256(stableStringify(item.contextSnapshot)) || item.interpretation !== "supplementary_recorded_judgment_not_ex_ante_baseline") invalidState();
        if (item.thesisRecordedAt !== thesis.versions[item.thesisVersion - 1].recordedAt || item.contextSnapshot?.version !== item.thesisVersion || item.contextSnapshot?.asOf !== item.linkedAt || item.contextSnapshot?.id !== thesis.id || item.contextSnapshot?.historicalPointInTimeVerified !== false) invalidState();
      } else if (!STATUSES.has(item.status) || !Number.isInteger(item.revision) || item.revision < 1 || item.revision > thesis.revision) invalidState();
    }
  }
  // Explicitly adopted source rows commit atomically with their judgment version,
  // not as independent user mutations or separately incremented revisions.
  const eventCount = thesis.versions.length + thesis.evidence.filter((item) => item.provenance !== "ai_accepted_unverified").length + thesis.observations.length + thesis.proposals.length + thesis.reviewLinks.length + thesis.statusHistory.length - 1;
  if (thesis.revision !== eventCount) invalidState();
}

function validateProposal(item, thesis) {
  if (item.origin !== "ai_proposal" || !["pending", "adopted", "superseded"].includes(item.status) || !Number.isInteger(item.baseRevision) || item.baseRevision < 1 || item.baseRevision >= thesis.revision || !Number.isInteger(item.baseThesisVersion) || !thesis.versions[item.baseThesisVersion - 1]) invalidState();
  requiredText(item.sourceRunId, 160, "运行"); requiredText(item.sourceThreadId, 160, "对话");
  const expected = normalizeProposal(item, item.recordedAt);
  if (!same(expected, { fields: item.fields, evidence: item.evidence, openQuestions: item.openQuestions })) invalidState();
  if (item.status === "adopted") {
    if (!isObject(item.adoption) || !Array.isArray(item.adoption.fields) || !item.adoption.fields.length || item.adoption.fields.some((field) => !FIELDS.has(field))) invalidState();
    exactIso(item.adoption.recordedAt);
    const version = thesis.versions[item.adoption.thesisVersion - 1];
    if (!version || version.origin !== "accepted_ai_proposal" || version.recordedAt !== item.adoption.recordedAt || version.recordedAt < item.recordedAt) invalidState();
    for (const key of item.adoption.fields) if (version.fieldOrigins[key]?.proposalId !== item.id) invalidState();
    if (!Array.isArray(item.adoption.selectedEvidenceIndexes) || !Array.isArray(item.adoption.evidenceIds) || item.adoption.selectedEvidenceIndexes.length !== item.adoption.evidenceIds.length || new Set(item.adoption.selectedEvidenceIndexes).size !== item.adoption.selectedEvidenceIndexes.length || new Set(item.adoption.evidenceIds).size !== item.adoption.evidenceIds.length) invalidState();
    item.adoption.selectedEvidenceIndexes.forEach((index, position) => {
      if (!Number.isInteger(index) || !item.evidence[index]) invalidState();
      const evidence = thesis.evidence.find((entry) => entry.id === item.adoption.evidenceIds[position]);
      if (!evidence || evidence.acceptance?.proposalId !== item.id || evidence.acceptance?.proposalEvidenceIndex !== index) invalidState();
    });
  } else if (item.adoption != null) invalidState();
  if (item.status === "superseded") {
    exactIso(item.supersededAt);
    if (item.supersededAt < item.recordedAt || item.supersededAt > thesis.updatedAt) invalidState();
  } else if (item.supersededAt != null) invalidState();
}

function validateEvidenceAcceptance(item, thesis) {
  const acceptance = item.acceptance;
  if (!isObject(acceptance) || acceptance.acceptedByUser !== true || acceptance.recordedAt !== item.recordedAt || !Number.isInteger(acceptance.proposalEvidenceIndex)) invalidState();
  const proposal = thesis.proposals.find((entry) => entry.id === acceptance.proposalId);
  const source = proposal?.evidence?.[acceptance.proposalEvidenceIndex];
  if (!proposal || proposal.status !== "adopted" || !source || acceptance.sourceRunId !== proposal.sourceRunId || acceptance.sourceThreadId !== proposal.sourceThreadId || proposal.adoption?.recordedAt !== item.recordedAt || proposal.adoption?.thesisVersion !== item.thesisVersion || evidenceSourceFingerprint(item) !== evidenceSourceFingerprint(source)) invalidState();
}

function evidenceFingerprint(item) { return stableStringify({ claim: item.claim, url: item.url, publishedAt: item.publishedAt, numeric: item.numeric }); }
function evidenceSourceFingerprint(item) { return stableStringify(Object.fromEntries(["claim", "stance", "kind", "sourceTitle", "url", "publishedAt", "knownAt", "numeric"].map((key) => [key, item[key]]))); }

function fieldOrigins(fields, origin) { return Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null).map(([key]) => [key, clone(origin)])); }
function assertFieldPatch(value) { if (!isObject(value) || Object.keys(value).some((key) => !FIELDS.has(key))) fail("research_fields_invalid", "研究字段含不支持的键，未静默忽略。"); }
function assertActive(thesis) { if (thesis.status === "archived") fail("research_archived", "研究已归档，请先恢复后再编辑。"); }
function requiredThesis(state, id) { const result = state.theses.find((item) => item.id === id); if (!result) fail("research_not_found", "研究记录不存在。"); return result; }
function capacity(items, max, label) { if (items.length >= max) fail("research_capacity", `${label}达到 ${max} 条上限；原记录未裁剪。`); }
function safeUrl(value) { if (value == null || value === "") return null; const raw = requiredText(value, 2048, "来源 URL"); let url; try { url = new URL(raw); } catch { fail("research_url_invalid", "来源需为 http(s) 网页地址。"); } if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) fail("research_url_invalid", "来源地址不支持此协议或携带凭证。"); return url.href; }
function normalizeSymbol(value) { const result = text(value, 40)?.toUpperCase() ?? null; if (result && !/^[A-Z0-9][A-Z0-9._:^=-]{0,39}$/.test(result)) fail("research_symbol_invalid", "研究标的格式无效；主题研究可留空。"); return result; }
function text(value, max) { if (value == null || value === "") return null; if (typeof value !== "string") fail("research_text_invalid", "研究文本必须为字符串。"); const result = value.trim(); if (!result) return null; if (result.length > max) fail("research_text_limit", `研究文本超过 ${max} 字上限，未静默裁剪。`); return result; }
function requiredText(value, max, label) { const result = text(value, max); if (!result) fail("research_required", `${label}不能为空。`); return result; }
function requiredIso(value) {
  const match = typeof value === "string" ? value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/) : null;
  if (!match || !Number.isFinite(Date.parse(value)) || Number(match[2]) < 1 || Number(match[2]) > 12 || Number(match[3]) < 1 || Number(match[3]) > new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate() || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) fail("research_timestamp_invalid", "研究时间需为包含时区的有效时间。");
  return new Date(value).toISOString();
}
function optionalIso(value) { return value == null || value === "" ? null : requiredIso(value); }
function exactIso(value) { if (requiredIso(value) !== value) invalidState(); }
function nowIso(callback) { const value = callback(); const millis = value instanceof Date ? value.getTime() : Date.parse(String(value)); if (!Number.isFinite(millis)) fail("research_timestamp_invalid", "系统时间无效。"); return new Date(millis).toISOString(); }
function boundedInteger(value, fallback, min, max) { if (value == null) return fallback; if (!Number.isInteger(value) || value < min || value > max) fail("research_context_limit", "研究上下文容量参数无效。"); return value; }
function validId(value) { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f]/.test(value); }
function uniqueId(value, existing) { if (!validId(value) || existing.includes(value)) fail("research_id_invalid", "研究记录标识无效或重复。"); return value; }
function assertSyncGuard(callback) { if (typeof callback !== "function" || callback() !== true) fail("research_stale_commit", "研究数据来源已变化或暂不可写，请刷新后重试。"); }
function seal(value) { return { ...value, contentHash: digest(value) }; }
function verifySeal(value) { if (!isObject(value) || typeof value.contentHash !== "string" || digest(value) !== value.contentHash) invalidState(); }
function digest(value) { return sha256(stableStringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "contentHash")))); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function same(left, right) { return stableStringify(left) === stableStringify(right); }
function stableStringify(value) { if (value == null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`; }
function isObject(value) { return value != null && typeof value === "object" && !Array.isArray(value); }
function clone(value) { return structuredClone(value); }
function invalidState() { fail("research_state_invalid", "研究账本损坏或版本不兼容；已停止读取和写入，未覆盖原始记录。"); }
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
