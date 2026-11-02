import { portfolioFreshness } from "../data/freshness.mjs";

const STORES = [
  ["secure", "账户授权与会话", "secure-state.bin"],
  ["business", "应用索引与最近结果", "business-state.bin"],
  ["reviews", "复盘与验证", "review-data.bin"],
  ["market_history", "历史行情缓存", "market-history.bin"],
  ["portfolio_snapshots", "组合快照账本", "portfolio-snapshots.bin"],
  ["technical_radar", "技术雷达账本", "technical-radar.bin"],
];
const BROKERS = [["longbridge", "长桥"], ["ibkr", "IBKR"], ["all", "多券商汇总"]];
const CAPACITIES = {
  review_cases: "旧复盘案例", review_cycles: "复盘周期", portfolio_snapshots: "组合快照账本",
  technical_radar: "技术雷达批次", market_history: "历史行情缓存", agent_results: "Agent 结果缓存",
};

/** Pure, allowlisted projection. No reads, network, reconciliation or writes occur here. */
export function buildSystemHealthSnapshot({ now = new Date(), version = null, storage = null,
  longbridge = null, brokers = null, portfolioSnapshots = null, codex = null,
  lastAgentResult = null, activeAgents = null, capacities = [] } = {}) {
  const generatedAt = timestamp(now);
  if (!generatedAt) throw new Error("健康快照时间无效。");
  const sections = [
    storageSection(storage),
    dataSection(brokers?.views, Date.parse(generatedAt), longbridge, brokers?.ibkr),
    eodSection(portfolioSnapshots),
    agentSection(codex, lastAgentResult, activeAgents),
    capacitySection(capacities, portfolioSnapshots),
    versionSection(version, codex),
  ];
  return {
    schemaVersion: 1, generatedAt, status: aggregateState(sections.map((item) => item.state)),
    sections, capabilities: capabilityMatrix({ longbridge, brokers, now: Date.parse(generatedAt) }),
  };
}

function storageSection(storage) {
  const cards = STORES.map(([id, title, file]) => {
    const matches = (Array.isArray(storage?.stores) ? storage.stores : []).filter((item) => item?.file === file);
    const value = matches.length === 1 ? matches[0] : null;
    const state = !value ? "unknown" : value.encrypted === false || value.state === "unavailable" ? "unavailable"
      : value.state === "degraded" || value.recoveryAvailable === true ? "degraded"
        : value.encrypted === true && value.state === "healthy" ? "healthy" : "unknown";
    return card(id, title, state, !value ? "尚未读取此存储健康状态。"
      : state === "healthy" ? "加密存储已可读；不代表外部数据实时。"
        : state === "unavailable" ? "本机加密存储不可用，不能确认新写入。"
          : state === "degraded" ? "存储发生错误或有待恢复记录；请处理后再信任后续保存。" : "尚未完成读取验证。", {
      observedAt: timestamp(value?.lastSavedAt), source: "EncryptedStore.health",
      fields: [field("加密可用", booleanLabel(value?.encrypted)), field("有恢复副本", booleanLabel(value?.recoveryAvailable)), field("上次成功保存", timestamp(value?.lastSavedAt))],
      details: value?.errorCode ? ["存在存储错误；健康视图不展示账户、路径或原始错误内容。"] : [],
    });
  });
  return section("storage", "本机加密存储", cards, "六类存储独立检查；应用索引与凭证分开，尚未初始化不会显示为正常。");
}

function dataSection(views, now, longbridge, ibkr) {
  const cards = BROKERS.map(([id, title]) => {
    const portfolio = views?.[id];
    if (!portfolio) return card(id, title, "unknown", "尚无可用的本地持仓观测；未触发刷新。", { source: "brokerUiSnapshot.views" });
    let freshness;
    try { freshness = portfolioFreshness(portfolio, { now }); } catch { freshness = { state: "unknown", ageMs: null, freshForSizing: false }; }
    const quality = portfolio.dataQuality ?? {};
    const state = ["cached", "stale"].includes(freshness.state) || quality.valuationComplete === false
      || count(quality.unpricedPositionCount) > 0 || (Array.isArray(portfolio.missingBrokers) && portfolio.missingBrokers.length > 0)
      || ["unavailable", "partial", "reference_cached"].includes(quality.fxStatus)
      || (Array.isArray(quality.sourceErrors) && quality.sourceErrors.length > 0)
      ? "degraded" : freshness.state === "fresh" && quality.valuationComplete === true ? "healthy" : "unknown";
    const fxSources = Array.isArray(portfolio.fx?.sources) ? portfolio.fx.sources : [];
    return card(id, title, state, "这是券商独立观测，不是持续实时行情；汇总不合并购买力或保证金。", {
      source: "broker portfolio / freshness / dataQuality", observedAt: timestamp(portfolio.syncedAt),
      fields: [field("持仓观测时间", timestamp(portfolio.syncedAt)), field("观测距今（秒）", freshness.ageMs == null ? null : Math.floor(freshness.ageMs / 1000)),
        field("新鲜度", mapped(freshness.state, { fresh: "新近观测", cached: "缓存", stale: "已过期", unknown: "未确认" })),
        field("估值完整", booleanLabel(quality.valuationComplete)), field("未定价持仓", count(quality.unpricedPositionCount)),
        field("汇率状态", fxState(quality.fxStatus)), field("汇率来源", fxProvider(portfolio.fx?.providerCode)),
        field("汇率参考时间", timestamp(portfolio.fx?.asOf)), field("汇率读取时间", timestamp(portfolio.fx?.fetchedAt)),
        field("确定性计仓门禁", id === "longbridge" ? (freshness.freshForSizing === true ? "通过当前门禁" : "未通过或未验证") : "未接入此券商范围的计仓门禁")],
      details: [
        ...(fxSources.length ? fxSources.slice(0, 3).map((item) => `${brokerLabel(item.broker)}：${fxState(item.status)}；参考时间 ${timestamp(item.asOf) ?? "未知"}。`) : []),
        ...(Array.isArray(quality.sourceErrors) && quality.sourceErrors.length ? ["存在券商读取错误；部分资料可能缺失。"] : []),
        ...(Array.isArray(quality.sourceWarnings) && quality.sourceWarnings.length ? ["存在来源质量提示；请结合原数据页确认。"] : []),
        ...(id === "ibkr" ? ["TWS 账户估值存在更新间隔；同步时间不能证明每个期权报价和 Greeks 的实时性。"] : []),
      ],
    });
  });
  cards.unshift(
    card("longbridge_connection", "长桥连接", longbridge?.connected === true ? "healthy" : longbridge?.connected === false ? "unavailable" : "unknown",
      "连接状态与持仓缓存分开；本页不连接或重新授权。", { source: "local broker connection state", fields: [
        field("连接状态", longbridge?.connected === true ? "已连接" : longbridge?.connected === false ? "未连接" : null),
        field("已发现只读工具", Array.isArray(longbridge?.tools) ? longbridge.tools.length : null),
        field("交易写权限", longbridge?.orderWrite === false ? "关闭" : "未确认"),
      ] }),
    card("ibkr_connection", "IBKR 连接", ibkr?.config?.enabled !== true ? "unknown" : ibkr?.syncing === true ? "running"
      : ["ready", "connected"].includes(ibkr?.state) ? "healthy" : ["error", "disconnected"].includes(ibkr?.state) ? "unavailable" : "unknown",
      "未启用的可选接入不表示已有数据丢失；不展示账户号或端口。", { source: "local broker connection state", fields: [
        field("已启用接入", booleanLabel(ibkr?.config?.enabled)),
        field("连接状态", mapped(ibkr?.state, { ready: "已连接", connected: "已连接", disconnected: "未连接", error: "连接失败", syncing: "同步中", discovering: "检查中" })),
        field("连接方式", mapped(ibkr?.config?.transport, { tws: "TWS / IB Gateway", gateway: "Client Portal 网关" })),
        field("交易写权限", ibkr?.orderWrite === false ? "关闭" : "未确认"),
      ] }),
  );
  return section("data", "持仓、估值与汇率", cards, "只展示已有连接与数据的来源时刻和质量，不通过健康检查刷新券商。");
}

function eodSection(value) {
  const readable = ["available", "empty"].includes(value?.status) && value?.integrity?.valid === true;
  const calendar = readable && Array.isArray(value?.coverageCalendar) ? value.coverageCalendar : null;
  const states = { confirmed: 0, degraded: 0, gap: 0, pending: 0, attempting: 0, missing: 0, unverified: 0 };
  for (const entry of calendar ?? []) {
    if (entry?.status === "confirmed") {
      if (typeof entry.confirmedSnapshotId === "string" && entry.confirmedSnapshotId.trim() && entry.snapshotReferenceVerified === true) states.confirmed += 1;
      else states.unverified += 1;
    } else if (Object.hasOwn(states, entry?.status)) states[entry.status] += 1;
    else states.unverified += 1;
  }
  const known = calendar !== null;
  const hasWindow = known && calendar.length > 0;
  const todo = states.pending + states.attempting + states.missing;
  const runtime = value?.captureRuntime;
  const policy = value?.capturePolicy;
  const latest = value?.latest;
  const cards = [
    card("durable", "已保存的收盘证据", !readable && value?.status === "invalid" ? "unavailable" : hasWindow ? (states.unverified ? "degraded" : "healthy") : "unknown",
      "仅账本完整性通过、覆盖条目已确认且快照引用已核验同账户同交易日的收盘记录，才计为成功；运行时成功消息不代替落盘证据。", {
        source: "verified portfolio ledger + persisted coverage calendar", observedAt: timestamp(latest?.capturedAt),
        fields: [field("当前检查窗口交易日", known ? calendar.length : null), field("已确认落盘日", known ? states.confirmed : null),
          field("确认引用待核验", known ? states.unverified : null), field("最近快照采集时间", timestamp(latest?.capturedAt)),
          field("最近快照类型", mapped(latest?.kind, { eod: "收盘", post_trade: "成交后", manual: "手动" })),
          field("最近估值时段", mapped(latest?.valuationSession, { regular_close: "常规收盘价", regular: "常规盘中", pre_market: "盘前", post_market: "盘后", overnight: "隔夜", mixed: "混合", unknown: "未知" }))],
      }),
    card("gaps", "历史缺口与降级", known ? states.gap + states.degraded + states.unverified > 0 ? "degraded" : hasWindow ? "healthy" : "unknown" : "unknown",
      "缺口不会用当前持仓补造；降级证据与完整收盘成功分开计数。", { source: "persisted coverage calendar",
        fields: [field("已确认缺口", known ? states.gap : null), field("降级证据日", known ? states.degraded : null)] }),
    card("pending", "待采集与待确认", known ? todo > 0 ? "running" : hasWindow ? "healthy" : "unknown" : "unknown",
      "待办不是已保存，也不意味着程序当前正在运行或日后必能补齐。", { source: "coverage calendar + capture runtime",
        fields: [field("排队待办", known ? states.pending : null), field("正在尝试", known ? states.attempting : null), field("尚无覆盖条目", known ? states.missing : null),
          field("上次尝试", timestamp(runtime?.lastAttemptAt)), field("运行时上次成功提示", timestamp(runtime?.lastSuccessAt))] }),
    card("policy", "自动保存边界", policy ? "healthy" : "unknown", "自动保存仅覆盖已接入的长桥账户；健康页不会进行补采或对账。", {
      source: "capture policy / background preferences",
      fields: [field("自动收盘保存", booleanLabel(policy?.automaticEod)), field("要求应用运行", booleanLabel(policy?.requiresAppRunning)),
        field("要求长桥连接", booleanLabel(policy?.requiresLongbridgeConnection)), field("检查间隔（分钟）", count(policy?.checkIntervalMinutes)),
        field("每交易日成功份数", count(policy?.eodSnapshotsPerTradingDate)), field("追造历史缺日", booleanLabel(policy?.missedDayBackfill)),
        field("后台模式已启用", booleanLabel(value?.backgroundCapture?.preferences?.enabled))],
      details: policy?.extendedHoursHandling === "separate_observation_never_overwrite_eod" ? ["盘后价格另记观察，不覆盖已确认的常规收盘估值。"] : [],
    }),
  ];
  return section("eod", "收盘快照连续性", cards, "该状态只覆盖已观测的交易日窗口，不能保证退出、睡眠、断网期间必有记录。");
}

function agentSection(codex, envelope, activeAgents) {
  const guard = codex?.readOnlyGuardDiagnostic;
  const result = envelope?.run?.modelAnalysis ?? envelope?.modelAnalysis ?? envelope;
  const contract = codex?.additionalContextContract;
  const runContract = result?.additionalContextContract;
  const delivery = result?.resultDelivery;
  const diagnostics = result?.contextDiagnostics;
  const activeCount = Array.isArray(activeAgents) ? activeAgents.length : count(codex?.activeCount);
  const terminalKnown = delivery?.complete === true && delivery?.terminalStatus === "completed";
  return section("agent", "Agent 上下文与结果交接", [
    card("runtime", "本地分析服务", codex?.available === false ? "unavailable" : activeCount > 0 ? "running" : codex?.readOnlyGuardReady === false ? "degraded" : codex?.ready === true ? "healthy" : "unknown",
      "仅反映已有本地服务状态；不发送模型请求或探测 MCP。", { source: "CodexWorkspace.status / active operations",
        fields: [field("运行中任务", activeCount), field("券商只读防护已验证", booleanLabel(codex?.readOnlyGuardReady)),
          field("研究模式", codex?.researchMode?.kind === "restricted" ? "研究可用·外部工具受限" : codex?.researchMode?.kind === "full" ? "完整工具研究" : null),
          field("已发现 Skills", count(codex?.skillCount)), field("已发现 MCP 服务", count(codex?.mcpServerCount))] }),
    card("read_only_guard", "只读隔离与修复", codex?.readOnlyGuardReady === true ? "healthy" : guard?.state === "checking" ? "running" : guard ? "degraded" : "unknown",
      guard?.message ?? "尚无本对话的只读隔离核验结果；可在 Agent 面板重新检查。", {
        source: "CodexWorkspace read-only guard diagnostic", observedAt: timestamp(typeof guard?.checkedAt === "number" ? new Date(guard.checkedAt) : guard?.checkedAt),
        fields: [field("核验状态", guard?.title ?? null), field("建议操作", guard?.actionLabel ?? null)],
        details: (guard?.tools ?? []).slice(0, 6).map(tool => `${tool.server}/${tool.tool}`),
      }),
    card("context", "上下文传递契约", diagnostics?.deliveryStatus === "rejected_budget" || diagnostics?.silentlyTruncated === true ? "degraded" : contractState(contract), "契约确认与每次数据新鲜度是两件事；已发现 MCP 不代表本轮已成功访问。", {
      source: "additionalContextContract / contextDiagnostics", observedAt: timestamp(envelope?.completedAt),
      fields: [field("当前契约", contractLabel(contract)), field("最近结果契约", contractLabel(runContract)),
        field("最近上下文字节", count(diagnostics?.totalUtf8Bytes)), field("最近上下文块数", count(diagnostics?.totalBlockCount)),
        field("静默截断", booleanLabel(diagnostics?.silentlyTruncated))],
      details: diagnostics?.deliveryStatus === "rejected_budget" ? ["最近上下文超出预算，被明确拒绝发送。"] : [],
    }),
    card("delivery", "最近结果终态", !delivery ? "unknown" : terminalKnown ? delivery.historyStatus === "verified" ? "healthy" : "degraded" : "degraded",
      !delivery ? "尚无最近结果的终态证据。" : terminalKnown ? "已接收完成终态；历史回收是否完整单独列示。" : "结果尚未得到完整完成终态确认。", {
        source: "last Agent result envelope / resultDelivery", observedAt: timestamp(envelope?.completedAt),
        fields: [field("已确认完成", delivery ? booleanLabel(terminalKnown) : null), field("终态来源", mapped(delivery?.terminalSource, {
          turn_completed_notification: "完成通知", persisted_turn_state: "持久化任务状态", remote_response: "服务响应",
        })), field("历史回收", mapped(delivery?.historyStatus, { verified: "已核验", streamed_unverified: "流式结果，未完整核验历史", incomplete: "不完整" }))],
      }),
  ], "这里不显示对话正文、账户标识、工作区路径或工具原始错误。");
}

function capacitySection(values, snapshots) {
  const inputs = Array.isArray(values) ? values : [];
  const cards = inputs.filter((item) => Object.hasOwn(CAPACITIES, item?.id)).map((item) => {
    const used = count(item.count), limit = count(item.limit), bytes = count(item.bytes), byteLimit = count(item.byteLimit);
    const measured = used != null || bytes != null;
    const full = (used != null && limit > 0 && used >= limit) || (bytes != null && byteLimit > 0 && bytes >= byteLimit);
    const ratios = [used != null && limit > 0 ? used / limit : null, bytes != null && byteLimit > 0 ? bytes / byteLimit : null].filter(value => value != null);
    const nearing = ratios.some(value => value >= 0.75);
    const fullyChecked = used != null && limit > 0 && bytes != null && byteLimit > 0;
    const summary = full ? "至少一项已达到活跃账本容量上限；新写入可能停止，旧记录不会自动删除。"
      : nearing ? "至少一项已使用 75% 以上；建议导出恢复包并预览历史封存。不会自动删除旧证据。"
      : fullyChecked ? "本次已知条数与字节数均未达到配置上限；不保证后续写入一定成功。"
        : measured ? "容量仅部分可核验；已知条数不代表剩余空间安全，未测量的字节或缺失限额仍保持未知。"
          : "尚无可核验容量数据；未取得不等于零，也不表示没有上限。";
    return card(item.id, CAPACITIES[item.id], full || nearing ? "degraded" : fullyChecked ? "healthy" : "unknown", summary, {
      source: "explicit host counts / configured limits", observedAt: timestamp(item.observedAt),
      fields: [field("活跃条目数", used), field("活跃条目上限", limit), field("活跃逻辑字节", bytes), field("活跃字节上限", byteLimit),
        field("全部历史条目", count(item.totalCount)), field("已封存条目", count(item.archivedCount)),
        field("全部逻辑字节", count(item.totalBytes)), field("账本密文合计", count(item.diskBytes)),
        field("条数上限核验", used == null || !(limit > 0) ? "未完成" : used >= limit ? "已达上限" : "本次未达上限"),
        field("字节上限核验", bytes == null || !(byteLimit > 0) ? "未完成" : bytes >= byteLimit ? "已达上限" : "本次未达上限")],
    });
  });
  if (!cards.some((item) => item.id === "portfolio_snapshots")) {
    const readable = ["available", "empty"].includes(snapshots?.status) && snapshots?.integrity?.valid === true;
    cards.push(card("portfolio_snapshots", "组合快照账本", "unknown", "账户内条数与整个账本条数分开；未核验文件大小和容量上限，不能据此判断剩余空间安全。", {
      source: "portfolio snapshot ledger status", fields: [field("当前账户快照数", readable ? count(snapshots.snapshotCount) : null),
        field("整个账本记录数", readable ? count(snapshots.integrity.ledgerRecordCount) : null), field("已测字节", null), field("字节上限", null)],
    }));
  }
  return section("capacity", "已知容量", cards, "条数与字节容量独立核验；部分观测不代表剩余容量安全，缺少资料不表示为零或未设上限。");
}

function versionSection(version, codex) {
  const appVersion = versionNumber(typeof version === "string" ? version : version?.appVersion);
  const codexVersion = versionNumber(version?.codexVersion)
    ?? extractCodexVersion(codex?.additionalContextContract?.serverUserAgent);
  return section("version", "版本与检查边界", [card("version", "本地版本", appVersion ? "healthy" : "unknown", "健康摘要不是联网探测、发布认证或实际交易验收。", {
    source: "host version / observed server handshake", fields: [field("应用版本", appVersion), field("已观测 Codex 版本", codexVersion)],
  })], "页面生成时间仅表示本次本地汇总时间，不会改变底层资料的观测时间。");
}

function capabilityMatrix({ longbridge, brokers, now }) {
  const connected = longbridge?.connected;
  const tools = Array.isArray(longbridge?.tools) ? new Set(longbridge.tools) : null;
  const feature = (id, label, support, state, detail) => ({ id, label, support, state, detail });
  const lbHistory = tools && connected === true ? ["history_orders", "history_executions"].some((name) => tools.has(name)) ? "healthy" : "unavailable" : connected === false ? "unavailable" : "unknown";
  const sizingReady = brokers?.views?.longbridge ? portfolioFreshness(brokers.views.longbridge, { now }).freshForSizing : false;
  const observedState = (id) => {
    const value = brokers?.views?.[id];
    if (!value) return "unknown";
    const fresh = portfolioFreshness(value, { now });
    return ["stale", "cached"].includes(fresh.state) || value.dataQuality?.valuationComplete === false
      || value.missingBrokers?.length ? "degraded" : fresh.state === "fresh" ? "healthy" : "unknown";
  };
  return BROKERS.map(([id, label]) => ({ id, label, items: [
    feature("positions", "持仓与账户观测", "implemented", observedState(id), id === "all" ? "只聚合已读取的独立券商快照；缺一个预期账户时汇总不完整。" : "已实现只读持仓；可见本地快照不代表当前连接或实时报价。"),
    feature("options", "期权持仓信息", "conditional", "unknown", "依实际合约、乘数和行情权限展示；Greeks、逐笔实时报价与完整期权链不作保证。"),
    feature("history", "历史订单与复盘证据", id === "longbridge" ? "conditional" : "not_supported", id === "longbridge" ? lbHistory : "unavailable", id === "longbridge" ? "本机已实现长桥订单/成交归档；服务声明工具不等于本次同步成功。" : "当前应用未接入此范围的历史订单归档与复盘闭环。"),
    feature("eod", "自动收盘快照", id === "longbridge" ? "implemented" : "not_supported", id === "longbridge" ? connected === true ? "healthy" : connected === false ? "unavailable" : "unknown" : "unavailable", id === "longbridge" ? "长桥账户收盘快照；实际是否保存以覆盖账本为准。" : "当前不会为 IBKR 或多券商汇总生成收盘快照。"),
    feature("sizing", "确定性计仓门禁", id === "longbridge" ? "conditional" : "not_supported", id === "longbridge" ? sizingReady ? "healthy" : "unknown" : "unavailable", id === "longbridge" ? "必须通过本轮持仓新鲜度、估值和来源门禁；不能仅因连通就计仓。" : "可研究账户信息，但不能复用长桥计仓门禁或自动批准仓位。"),
    feature("order_write", "真实下单", "disabled", "unavailable", "应用禁用真实订单提交、改单和撤单。"),
  ] }));
}

function card(id, title, state, summary, extra = {}) { return { id, title, state, summary, observedAt: null, fields: [], details: [], source: "local observed state", ...extra }; }
function section(id, title, cards, summary) { return { id, title, state: aggregateState(cards.map((item) => item.state)), summary, cards }; }
function aggregateState(values) { for (const state of ["unavailable", "degraded", "unknown", "running"]) if (values.includes(state)) return state; return values.length ? "healthy" : "unknown"; }
function field(label, value) { return { label, value: value ?? null }; }
function count(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function timestamp(value) { if (value == null || value === "") return null; const n = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(n) ? new Date(n).toISOString() : null; }
function booleanLabel(value) { return value === true ? "是" : value === false ? "否" : null; }
function mapped(value, labels) { return Object.hasOwn(labels, value) ? labels[value] : null; }
function brokerLabel(value) { return mapped(value, { longbridge: "长桥", ibkr: "IBKR", all: "多券商汇总" }) ?? "未识别券商来源"; }
function fxState(value) { return mapped(value, { live: "券商汇率", reference: "参考汇率", reference_cached: "参考汇率缓存", not_required: "无需换汇", unavailable: "不可用", partial: "部分覆盖", complete: "完整" }) ?? "未知"; }
function fxProvider(value) { return mapped(value, { Longbridge: "长桥", ECB: "欧洲央行参考汇率", IBKR: "IBKR", "多券商": "各券商独立来源" }) ?? null; }
function contractState(value) { return value?.status === "verified" ? "healthy" : value?.status === "unsupported" ? "unavailable" : value?.error ? "degraded" : "unknown"; }
function contractLabel(value) { return mapped(value?.status, { verified: "已验证", unsupported: "不受支持", unverified: "尚未验证" }); }
function versionNumber(value) { return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,50})?$/.test(value) ? value : null; }
function extractCodexVersion(value) {
  // initialize returns the upstream UA, whose product prefix is clientInfo.name.
  // Accept our known client prefix, not arbitrary version-like text elsewhere
  // (e.g. the trailing application version). This is an observation, not a
  // claim that the App Server protocol guarantees a separate runtimeVersion.
  return typeof value === "string"
    ? versionNumber(value.match(/^(?:codex(?:[_-][a-z0-9]+)*|trading_cockpit)[ /](\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,50})?)(?=\s|$)/i)?.[1])
    : null;
}
