const SAFE_IDENTIFIER = /^[a-zA-Z0-9_.:/-]{1,120}$/;
const MAX_TOOL_DETAILS = 12;
const ACTION_LABELS = { recheck: "重新检查", new_session: "新建安全对话", restart: "退出后重新打开驾驶舱" };

// Diagnostics are display-only. No arbitrary error, App name, endpoint or
// configuration value may cross this boundary into a UI message.
export function buildReadOnlyGuardDiagnostic({
  ready = false, checking = false, threadId = null, proof = null, receipt = null,
  generation = 0, revision = 0, residualTools = [], residualApps = [],
  inventoryError = null, startupFailure = null, servers = [],
} = {}) {
  const checkedAt = safeTimestamp(proof?.updatedAt);
  const unresolvedTools = [
    ...(Array.isArray(residualTools) ? residualTools : []),
    ...(Array.isArray(proof?.residualTools) ? proof.residualTools : []),
  ];
  const tools = safeTools(unresolvedTools);
  const diagnostic = (state, code, title, message, action = null, extra = {}) => ({
    state, code, title, message, action, actionLabel: ACTION_LABELS[action] ?? null,
    tools, checkedAt, ...extra,
  });

  // A fresh in-flight check supersedes stale errors, but is not a ready proof.
  if (checking) return diagnostic("checking", "checking", "正在核验只读保护",
    "正在读取当前会话的工具清单并核对只读配置；完成前不会开始新的分析。", null, { tools: [] });

  if (startupFailure) {
    const failures = {
      config_unavailable: ["无法读取只读配置", "无法读取或验证 Agent 的有效配置，尚未建立安全的分析会话。请检查应用内连接配置后重新检查。", "recheck"],
      app_identity_unavailable: ["无法确认券商工具身份", "无法完整确认券商 App 与工具的对应关系，不能安全应用精确的禁用规则。请检查券商连接与授权后重新检查。", "recheck"],
      preflight_unavailable: ["只读预检未完成", "无法完成当前会话的只读预检，分析保持暂停。请先重新检查；若仍失败，在其他任务结束后退出并重新打开驾驶舱（不是刷新页面）。原对话保留。", "recheck"],
      runtime_unavailable: ["Agent 运行时不可用", "Agent 连接或启动失败，未能核验只读保护。请在其他任务结束后退出并重新打开驾驶舱（不是刷新页面），再重新检查；原对话保留。", "restart"],
    };
    const code = typeof startupFailure?.code === "string" && Object.hasOwn(failures, startupFailure.code)
      ? startupFailure.code : "startup_unavailable";
    const [title, message, action] = failures[code]
      ?? ["只读保护启动失败", "只读保护尚未完成启动，分析保持暂停。请重新检查应用内连接状态。", "recheck"];
    return diagnostic("failed", code, title, message, action);
  }

  const error = inventoryError ?? proof?.error;
  if (error) {
    const category = classifyInventoryError(error);
    const advice = {
      timeout: ["工具清单读取超时", "当前会话的工具清单读取超时，无法确认只读保护。请确认 Agent 和相关服务响应正常后重新检查；不会把超时当作没有写工具。"],
      auth: ["工具清单授权未完成", "当前会话的工具清单因登录或授权问题无法核验。请在对应连接中完成登录或恢复授权，再重新检查；不需要放开写权限。"],
      protocol: ["工具清单返回不完整", "当前会话的工具清单格式或分页不完整，无法确认只读保护。请重新检查；若持续出现，请检查 Agent 与相关服务的兼容性和连接状态。"],
      network: ["工具清单连接失败", "读取当前会话的工具清单时连接失败，无法确认只读保护。请检查应用内 Agent 网络设置、相关服务连接和系统网络后重新检查；不要关闭证书校验。"],
      unknown: ["工具清单核验失败", "无法读取或核验当前会话的工具清单，分析保持暂停。请检查 Agent 与相关服务的连接状态后重新检查。"],
    };
    const [title, message] = advice[category];
    return diagnostic("failed", `inventory_${category}`, title, message, "recheck", { errorCategory: category });
  }

  if (!threadId) return diagnostic("idle", "no_session", "尚未核验分析会话",
    "当前没有已建立的分析会话。重新检查会尝试建立连接并核验只读保护。", "recheck");

  const proofStale = proof && !isCurrent(proof, generation, revision);
  const receiptStale = receipt && !isCurrent(receipt, generation, revision);
  if (proofStale || receiptStale) return diagnostic("blocked", "session_configuration_stale", "会话只读配置已过期",
    "当前会话的核验记录与最新连接或只读规则不一致。请新建会话以加载最新限制；原会话和历史记录会保留。", "new_session");

  const hasResidualTools = unresolvedTools.length > 0;
  const hasResidualApps = Array.isArray(residualApps) && residualApps.length > 0;
  if (hasResidualTools || hasResidualApps) {
    const hasColdReceipt = receipt && isCurrent(receipt, generation, revision)
      && ["start", "cold_resume"].includes(receipt.origin);
    const allCovered = hasColdReceipt && !hasResidualApps
      && unresolvedTools.every(tool => receiptCoversTool(receipt, tool));
    if (!allCovered) return diagnostic("blocked", "session_configuration_missing", "当前会话未加载完整只读限制",
      "检测到尚未取得当前冷启动禁用记录的写入或未核实工具，分析已暂停。请新建安全对话；原对话保留。若新对话仍被拦截，请查看下列工具并修复对应配置或兼容性，不要放宽权限。", "new_session");
    return diagnostic("blocked", "policy_not_enforced", "只读限制尚未得到确认",
      "已有这些工具的冷启动禁用记录，但核验仍未通过。请在其他任务结束后退出并重新打开驾驶舱，再重新检查；重启不保证恢复，若仍失败需检查运行时对禁用规则的支持，不能关闭防护。", "restart");
  }

  // Optional research-server authentication/runtime status does not invalidate
  // a successful guard proof. The service owns guarded-inventory completeness.
  void servers;
  if (ready && proof && isCurrent(proof, generation, revision)) return diagnostic("ready", "ready", "只读保护已核验",
    "当前会话的只读保护已核验，可以开始分析。可选数据源的登录状态单独显示。");

  return diagnostic("blocked", "verification_missing", "只读保护尚未核验",
    "当前会话尚无有效的只读核验记录，分析保持暂停。请重新检查当前会话的工具清单与限制。", "recheck");
}

function isCurrent(value, generation, revision) {
  return Number.isSafeInteger(value?.generation) && value.generation >= 0
    && Number.isSafeInteger(value?.revision) && value.revision >= 0
    && value.generation === generation && value.revision === revision;
}

function receiptCoversTool(receipt, tool) {
  if (!tool || typeof tool.server !== "string" || typeof tool.tool !== "string") return false;
  if (tool.server === "codex_apps") return Array.isArray(receipt.bindings)
    && receipt.bindings.some(binding => binding?.server === tool.server && binding?.tool === tool.tool
      && receipt.config?.apps?.[binding.appId]?.tools?.[binding.operation]?.enabled === false);
  const policy = receipt.config?.mcp_servers?.[tool.server];
  return Array.isArray(policy?.disabled_tools) && policy.disabled_tools.includes(tool.tool)
    || Array.isArray(policy?.enabled_tools) && !policy.enabled_tools.includes(tool.tool);
}

function safeTimestamp(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    && value <= 8_640_000_000_000_000 ? value : null;
}

function safeIdentifier(value, fallback) {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) return fallback;
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|file|ftp|wss?):|\/|~\/|[a-z]:[\\/]|(?:Users|home|private|var|tmp|Applications)\/)/i.test(value)) return fallback;
  if (/(?:^|[_.:/-])(?:U\d{5,}|DU\d{5,}|sk[-_][a-z0-9_-]{10,})(?:$|[_.:/-])/i.test(value)) return fallback;
  if (/^\d+$/.test(value) || /^[a-f0-9]{32,}$/i.test(value) || /^eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(value)) return fallback;
  return value;
}

function safeTools(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const tool = { server: safeIdentifier(item?.server, "未知服务"), tool: safeIdentifier(item?.tool, "未知工具") };
    const key = `${tool.server}\n${tool.tool}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tool);
    if (result.length === MAX_TOOL_DETAILS) break;
  }
  return result;
}

function classifyInventoryError(error) {
  const fragments = typeof error === "string" ? [error]
    : error && typeof error === "object" ? [error.code, error.kind, error.message] : [];
  const message = fragments.filter(value => typeof value === "string").map(value => value.slice(0, 4_096)).join(" ");
  if (/time(?:d)?[\s_-]*out|etimedout|超时/i.test(message)) return "timeout";
  if (/(?:\b|_)(?:401|403)(?:\b|_)|unauth|forbidden|authentication|authorization|notloggedin|oauth|credential|认证(?:失败|错误|过期)|(?:未|需要|重新)授权|授权(?:失败|失效|过期)|(?:未|需要|重新)登录/i.test(message)) return "auth";
  if (/protocol|malformed|invalid (?:response|json|pagination)|json parse|unexpected token|cursor|pagination|循环分页|分页(?:数据|游标)|协议|清单(?:未完整|不完整)|返回.{0,8}(?:无效|缺失|异常)/i.test(message)) return "protocol";
  if (/econnreset|econnrefused|enotfound|eai_again|enetunreach|network|socket|dns|fetch failed|connection (?:closed|refused|lost)|连接(?:失败|断开|中断)|网络|证书|certificate|tls/i.test(message)) return "network";
  return "unknown";
}
