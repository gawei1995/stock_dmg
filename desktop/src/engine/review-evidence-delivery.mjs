import { createHash } from "node:crypto";

// Independent source-to-wire checks. Transport hashes alone can only attest
// what was sent, not whether the producer forgot a required source field.
export function validateReviewEvidenceDelivery(evidence, contexts, limits) {
  const docs = decodeDocuments(contexts);
  const checks = [];
  const consumed = new Set();
  const scoped = evidence?.scopedContext ?? {};
  const same = (path, expected, actual) => {
    if (actual === undefined || hash(expected) !== hash(actual)) fail(`复盘证据交付未覆盖必需字段 ${path}`);
    checks.push({ sourcePath: path, status: "verified", sha256: `sha256:${hash(expected)}` });
  };
  const one = key => { consumed.add(key); return docs.get(key); };
  const rows = (prefix, field, metadata = {}) => {
    const entries = [...docs.entries()].filter(([key]) => key === prefix || new RegExp(`^${prefix}-\\d+$`).test(key))
      .sort(([, a], [, b]) => (a?.part ?? 1) - (b?.part ?? 1));
    const values = entries.map(([, value]) => value);
    if (!values.length) fail(`复盘证据缺少 ${prefix}`);
    if (entries.some(([key, value], index) => !Array.isArray(value?.[field])
      || (key === prefix
        ? values.length !== 1 || value[field].length !== 0 || value.part !== undefined || value.parts !== undefined
        : key !== `${prefix}-${index + 1}` || value[field].length === 0
          || value.parts !== values.length || value.part !== index + 1))) fail(`复盘数组分片不完整 ${prefix}`);
    const actualMetadata = values.map(value => {
      const result = { ...value };
      delete result[field]; delete result.part; delete result.parts;
      return result;
    });
    same(`${prefix}.metadata`, values.map(() => metadata), actualMetadata);
    for (const [key] of entries) consumed.add(key);
    return values.flatMap(value => value[field]);
  };
  const overview = one("trading-cockpit-evidence");
  if (scoped.reviewProtocol === "decision_cycle") {
    const cycle = scoped.cycle ?? {};
    const prefix = "trading-cockpit-review-cycle";
    const phase = scoped.phase ?? null;
    const timeline = Array.isArray(cycle.decisionTimeline) ? cycle.decisionTimeline : [];
    const core = { ...cycle };
    for (const key of ["orders", "executions", "checkpoints", "decisionTimeline", "sealedExAnte", "blindAssessment", "outcome", "startingPortfolio", "endingPortfolio", "currentPortfolioContext", "portfolioCoverage"]) delete core[key];
    const scopedCore = { ...scoped, cycle: core };
    delete scopedCore.pointInTimeTechnical;
    delete scopedCore.deterministicOutcomeMetrics;
    const expectedOverview = { ...evidence, scopedContext: scopedCore, evidenceDelivery: {
      format: "semantic_application_blocks", protocol: "review-decision-cycles", phase: scoped.phase,
      note: phase === "blind" && timeline.length
        ? "All blocks are valid JSON. The model receives all chronological node evidence capsules in this request, but each capsule contains only facts strictly earlier than that node's own knowledgeCutoffAt; cycle outcomes and facts after the last delivered node remain excluded."
        : "All blocks are valid JSON. Blind blocks have already had post-cutoff facts physically removed by the host.",
    } };
    delete expectedOverview.userTask;
    same("review.overview", expectedOverview, overview);
    const cycleMetadata = { cycleId: cycle.id ?? null, phase };
    same("review.sealed", {
      cycleId: cycle.id ?? null, phase, timeFirewall: scoped.timeFirewall ?? null,
      sealedExAnte: cycle.sealedExAnte ?? null, evidenceGrade: cycle.evidenceGrade ?? null,
      startingPortfolio: cycle.startingPortfolio ?? null,
    }, one(`${prefix}-sealed`));
    if (phase === "blind" && timeline.length) {
      const nodes = timeline.slice().sort((a, b) => Number(a?.timelineIndex ?? 0) - Number(b?.timelineIndex ?? 0));
      nodes.forEach((node, index) => {
        const actual = one(`${prefix}-timeline-node-${String(index + 1).padStart(3, "0")}`);
        same(`review.timeline.${index}.node`, node, actual?.node);
        same(`review.timeline.${index}.identity`, { cycleId: cycle.id ?? null, phase, sequence: index + 1, totalNodes: nodes.length },
          actual && { cycleId: actual.cycleId, phase: actual.phase, sequence: actual.sequence, totalNodes: actual.totalNodes });
        same(`review.timeline.${index}.capsule`, {
          capsuleKind: "decision_timeline_node", sequence: index + 1, totalNodes: nodes.length,
          cycleId: cycle.id ?? null, phase: "blind",
          instruction: "只用本节点胶囊内、严格早于本节点 knowledgeCutoffAt 的事实评价该时点决策；完成并冻结本节点评价后，才处理下一节点。",
          node,
        }, actual);
      });
    } else {
      same("review.broker.records", [...(cycle.orders ?? []), ...(cycle.executions ?? [])], rows(`${prefix}-broker`, "records", cycleMetadata));
      same("review.checkpoints", cycle.checkpoints ?? [], rows(`${prefix}-checkpoints`, "checkpoints", cycleMetadata));
      const technicalMetadata = { ...cycleMetadata };
      const technicalFields = [["status", "unavailable"], ["asOf", null], ["cutoffPolicy", null], ["requestedSymbols", []], ["omittedSymbols", []], ["warnings", []]];
      for (const [key, fallback] of technicalFields) technicalMetadata[key] = scoped.pointInTimeTechnical?.[key] ?? fallback;
      same("review.pointInTimeTechnical.snapshots", scoped.pointInTimeTechnical?.snapshots ?? [], rows(`${prefix}-technical`, "snapshots", technicalMetadata));
      const metadata = [...docs.entries()].find(([key]) => key === `${prefix}-technical` || new RegExp(`^${prefix}-technical-\\d+$`).test(key))?.[1];
      for (const [key] of technicalFields) {
        same(`review.pointInTimeTechnical.${key}`, technicalMetadata[key], metadata?.[key]);
      }
    }
    if (["outcome", "retrospective"].includes(phase)) {
      const metrics = scoped.deterministicOutcomeMetrics ?? {
        status: "unavailable", coverage: { reasons: ["host_metrics_not_provided"] },
        provenance: { deterministicHostCalculation: true, modelLookupAllowedAsMetricSubstitute: false },
      };
      const path = metrics.tradePricePath ?? null;
      const metricsBlock = one(`${prefix}-outcome-metrics`);
      same("review.outcomeMetrics", path ? { ...metrics, tradePricePath: undefined } : metrics, metricsBlock?.metrics);
      same("review.outcomeMetrics.block", { cycleId: cycle.id ?? null,
        metrics: path ? { ...metrics, tradePricePath: undefined } : metrics }, metricsBlock);
      same("review.outcome", { cycleId: cycle.id ?? null, blindAssessment: cycle.blindAssessment ?? null,
        outcome: cycle.outcome ?? null, endingPortfolio: cycle.endingPortfolio ?? null,
        currentPortfolioContext: cycle.currentPortfolioContext ?? null, portfolioCoverage: cycle.portfolioCoverage ?? null }, one(`${prefix}-outcome`));
      if (path) {
        const cycles = project(path.cycles, limits.cycles).map(item => ({ ...item, pricePath: item?.pricePath ? {
          ...item.pricePath, trend: item.pricePath.trend ? { ...item.pricePath.trend, segments: undefined } : null,
        } : null }));
        const coverage = {
          activities: sequenceCoverage(path.activities, limits.activities),
          lots: sequenceCoverage(path.lots, limits.lots),
          fifoCycles: sequenceCoverage(path.cycles, limits.cycles),
          overallSegments: sequenceCoverage(path.pricePath?.trend?.segments, limits.segments),
        };
        const fifoSegmentCount = (path.cycles ?? []).reduce((count, item) => count
          + (Array.isArray(item?.pricePath?.trend?.segments) ? item.pricePath.trend.segments.length : 0), 0);
        coverage.fifoCycleSegments = { sourceCount: fifoSegmentCount, deliveredCount: 0,
          omittedCount: fifoSegmentCount, deliveryPolicy: "omitted_duplicate_detail" };
        same("review.tradePath.activities", project(path.activities, limits.activities), rows(`${prefix}-trade-path-activities`, "activities", { ...cycleMetadata, ...coverage.activities }));
        same("review.tradePath.lots", project(path.lots, limits.lots), rows(`${prefix}-trade-path-lots`, "lots", { ...cycleMetadata, ...coverage.lots }));
        same("review.tradePath.cycles", cycles, rows(`${prefix}-trade-path-cycles`, "cycles", { ...cycleMetadata, ...coverage.fifoCycles }));
        same("review.tradePath.segments", project(path.pricePath?.trend?.segments, limits.segments), rows(`${prefix}-trade-path-segments`, "segments", {
          ...cycleMetadata, granularity: path.pricePath?.trend?.granularity ?? null,
          segmentTradingDays: path.pricePath?.trend?.segmentTradingDays ?? null, ...coverage.overallSegments,
        }));
        const summary = { ...path, activities: undefined, lots: undefined, cycles: undefined,
          pricePath: path.pricePath ? { ...path.pricePath, trend: path.pricePath.trend ? { ...path.pricePath.trend, segments: undefined } : null } : null };
        const meta = one(`${prefix}-trade-path-meta`);
        same("review.tradePath.summary", summary, meta?.tradePricePath);
        same("review.tradePath.metadata", {
          ...cycleMetadata,
          evidenceRevision: cycle.brokerAssociation?.evidenceRevision ?? cycle.evidenceRevision ?? null,
          instruction: "Only the explicitly selected order/fill anchors define this Buy-to-Sell window. Supplemental parent or sibling records never expand it. Analyze the supplied daily or three-trading-session trend without substituting another historical window. If an agent-context sequence reports omittedCount, do not infer the omitted rows; use the complete host summary and explicitly disclose that row-level evidence was bounded.",
          agentContextProjection: coverage, tradePricePath: summary,
        }, meta);
      }
    } else if ([...docs.keys()].some(key => key.startsWith(`${prefix}-outcome`) || key.startsWith(`${prefix}-trade-path`))) {
      fail("盲态复盘不得携带结果证据块");
    }
  } else {
    const cases = scoped.cases ?? [];
    cases.forEach((item, index) => {
      const ref = `case-${index + 1}`;
      const prefix = `trading-cockpit-review-${ref}`;
      same(`review.${ref}.broker`, [...(item.orders ?? []), ...(item.executions ?? [])], rows(`${prefix}-broker`, "records", {
        caseRef: ref, id: item.id ?? null, symbol: item.symbol ?? null, fiscalQuarter: item.fiscalQuarter ?? null,
        event: item.event ?? null, brokerAssociation: item.brokerAssociation ?? null,
      }));
      const decision = { caseRef: ref };
      for (const key of ["id", "symbol", "strategyType", "benchmark", "primaryHorizon", "status", "createdAt", "updatedAt", "exAnteDraft", "outcome", "review"]) decision[key] = item[key] ?? null;
      for (const key of ["exAnteVersions", "ruleIds"]) decision[key] = item[key] ?? [];
      same(`review.${ref}.decision`, decision, one(`${prefix}-decision`));
    });
    same("review.tests", project(scoped.tests, 36), rows("trading-cockpit-review-tests", "tests", sequenceCoverage(scoped.tests, 36)));
    same("review.rules", scoped.rules ?? [], rows("trading-cockpit-review-rules", "rules"));
    same("review.caseIndex", cases.map((item, index) => ({ caseRef: `case-${index + 1}`, id: item.id ?? null,
      symbol: item.symbol ?? null, fiscalQuarter: item.fiscalQuarter ?? null, orderCount: (item.orders ?? []).length,
      executionCount: (item.executions ?? []).length })), overview?.scopedContext?.caseIndex);
    const expectedOverview = { ...evidence, scopedContext: { ...scoped, cases: undefined, tests: undefined, rules: undefined,
      caseIndex: cases.map((item, index) => ({ caseRef: `case-${index + 1}`, id: item.id ?? null,
        symbol: item.symbol ?? null, fiscalQuarter: item.fiscalQuarter ?? null,
        orderCount: (item.orders ?? []).length, executionCount: (item.executions ?? []).length })),
    }, evidenceDelivery: {
      format: "semantic_application_blocks", brokerFacts: "trading-cockpit-review-case-*-broker-*",
      decisionEvidence: "trading-cockpit-review-case-*-decision-*",
      note: "Each block is valid JSON; combine blocks with the same caseRef before judging evidence completeness.",
    } };
    delete expectedOverview.userTask;
    same("review.overview", expectedOverview, overview);
  }
  const unexpected = [...docs.keys()].filter(key => !consumed.has(key));
  if (unexpected.length) fail(`复盘证据存在阶段之外的未声明文档：${unexpected.join(", ")}`);
  return checks;
}

function decodeDocuments(contexts) {
  const docs = new Map(), fragments = new Map();
  for (const [key, block] of Object.entries(contexts)) {
    // Instructions and the transport manifest are generated separately. Every
    // semantic evidence document must be consumed by a phase-specific check.
    if (key === "trading-cockpit-instructions" || /^trading-cockpit-context-manifest(?:-\d+)?$/.test(key)) continue;
    if (!key.startsWith("trading-cockpit-evidence") && !key.startsWith("trading-cockpit-review-")) fail(`复盘证据存在未知文档：${key}`);
    let value;
    try { value = JSON.parse(block.value); } catch { fail(`复盘证据块不是有效 JSON：${key}`); }
    if (value?.encoding === "json-fragment") {
      const suffix = key.match(/-(\d+)$/);
      if (!suffix || !Number.isInteger(value.part) || value.part < 1 || String(value.part) !== suffix[1]
        || !Number.isInteger(value.parts) || value.parts < value.part || typeof value.fragment !== "string"
        || Object.keys(value).some(field => !["encoding", "part", "parts", "fragment"].includes(field))) fail(`复盘 JSON 分片标识不完整：${key}`);
      const group = key.replace(/-\d+$/, "");
      if (!fragments.has(group)) fragments.set(group, []);
      fragments.get(group).push(value);
    } else docs.set(key, value);
  }
  for (const [key, parts] of fragments) {
    parts.sort((a, b) => a.part - b.part);
    if (docs.has(key) || parts.length !== parts[0].parts || parts.some((item, index) => item.part !== index + 1 || item.parts !== parts.length)) fail(`复盘 JSON 分片不完整：${key}`);
    try { docs.set(key, JSON.parse(parts.map(item => item.fragment).join(""))); } catch { fail(`复盘 JSON 分片无法还原：${key}`); }
  }
  return docs;
}
function project(values, limit) {
  const source = Array.isArray(values) ? values : [];
  if (source.length <= limit) return source;
  const head = Math.ceil(limit / 2);
  const tail = limit - head;
  return [...source.slice(0, head), ...(tail ? source.slice(-tail) : [])];
}
function sequenceCoverage(values, limit) {
  const sourceCount = Array.isArray(values) ? values.length : 0;
  const deliveredCount = Math.min(sourceCount, limit);
  return { sourceCount, deliveredCount, omittedCount: sourceCount - deliveredCount,
    deliveryPolicy: sourceCount <= limit ? "complete" : "bounded_head_and_tail_preserving_window_boundaries" };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function hash(value) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function fail(message) { throw Object.assign(new Error(message), { code: "REVIEW_CONTEXT_CONTRACT" }); }
