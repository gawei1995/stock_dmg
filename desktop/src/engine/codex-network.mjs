import { execFile } from "node:child_process";

const SYSTEM_PROXY_FEATURE = "respect_system_proxy";
const INSPECTION_TIMEOUT_MS = 5_000;
const FEATURE_OUTPUT_LIMIT = 128 * 1_024;
const SUPPORTED_STAGES = new Set(["stable", "experimental", "under development", "deprecated"]);

export class CodexNetworkError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CodexNetworkError";
    this.kind = "network_configuration";
    this.code = code;
  }
}

export function normalizeCodexNetworkMode(mode = "inherit") {
  if (mode !== "inherit" && mode !== "system") {
    throw new CodexNetworkError("invalid_mode", "Agent 网络模式无效；仅支持继承启动环境或使用系统代理。");
  }
  return mode;
}

// This is configuration evidence, not a network-connectivity assertion. Never
// expose CLI output, proxy URLs, inherited environment or arbitrary errors.
export function codexNetworkStatus(mode = "inherit", {
  status = "idle", stage = null, errorCode = null,
} = {}) {
  const selectedMode = mode === "inherit" || mode === "system" ? mode : "unsupported";
  const safeStage = selectedMode === "system" && SUPPORTED_STAGES.has(stage) ? stage : null;
  const safeStatus = selectedMode === "unsupported" ? "failed"
    : ["idle", "checking", "ready", "failed"].includes(status) ? status : "idle";
  const safeErrorCode = selectedMode === "unsupported" ? "invalid_mode"
    : ["unsupported", "inspection_failed", "inspection_timeout"].includes(errorCode) ? errorCode : null;
  let message = selectedMode === "inherit"
    ? "Agent 继承启动环境，不额外覆盖 Codex 网络配置。"
    : "仅本应用的 Codex 进程将请求使用系统代理；正在等待运行时能力检查。";
  if (selectedMode === "unsupported") {
    message = "Agent 网络模式无效；请在连接设置中重新选择网络模式。尚未启动分析。";
  } else if (selectedMode === "system" && safeStatus === "checking") {
    message = "正在检查本机 Codex 的系统代理功能；不会修改代理环境变量或全局配置。";
  } else if (selectedMode === "system" && safeStatus === "ready") {
    message = safeStage === "stable"
      ? "已为本应用的 Codex 进程启用系统代理功能；实际连通性以请求结果为准。"
      : "已为本应用的 Codex 进程启用非稳定的系统代理功能；实际连通性以请求结果为准。";
  } else if (safeStatus === "failed") {
    message = safeErrorCode === "inspection_timeout"
      ? "Codex 系统代理能力检查超时；未启动分析，也未静默切换为直连。"
      : safeErrorCode === "unsupported"
        ? "本机 Codex 不支持所选系统代理功能；未启动分析，也未静默切换为直连。"
        : "无法确认 Codex 系统代理能力；未启动分析，也未静默切换为直连。";
  }
  return {
    mode: selectedMode,
    status: safeStatus,
    feature: selectedMode === "system" ? SYSTEM_PROXY_FEATURE : null,
    stage: safeStage,
    experimental: selectedMode === "system" && safeStage !== "stable",
    errorCode: safeErrorCode,
    message,
  };
}

export function parseCodexSystemProxyFeature(output) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > FEATURE_OUTPUT_LIMIT) {
    throw new CodexNetworkError("inspection_failed", "无法确认 Codex 系统代理能力。未启动分析。");
  }
  const matches = output.split(/\r?\n/).map(line => line.trim())
    .filter(line => /^respect_system_proxy(?:\s|$)/.test(line));
  if (matches.length !== 1) {
    throw new CodexNetworkError("unsupported", "本机 Codex 未提供可核验的系统代理功能。未启动分析。");
  }
  const match = matches[0].match(/^respect_system_proxy\s+(stable|experimental|under\s+development|deprecated|removed)\s+(true|false)$/);
  const stage = match?.[1]?.replace(/\s+/g, " ");
  if (!SUPPORTED_STAGES.has(stage)) {
    throw new CodexNetworkError("unsupported", "本机 Codex 的系统代理功能已移除或无法识别。未启动分析。");
  }
  return { stage };
}

export function inspectCodexFeatures({
  codexPath, cwd, env, timeoutMs = INSPECTION_TIMEOUT_MS, execFileImpl = execFile,
}) {
  return new Promise((resolve, reject) => {
    // No shell, user-authored arguments, config writes or environment rewrites.
    execFileImpl(codexPath, ["features", "list"], {
      cwd, env, timeout: timeoutMs, maxBuffer: FEATURE_OUTPUT_LIMIT,
      encoding: "utf8", windowsHide: true, shell: false,
    }, (error, stdout) => {
      if (error) {
        const code = error.killed || error.code === "ETIMEDOUT" ? "inspection_timeout" : "inspection_failed";
        reject(new CodexNetworkError(code, codexNetworkStatus("system", { status: "failed", errorCode: code }).message));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function prepareCodexNetworkLaunch({
  mode = "inherit", codexPath, cwd, env, inspectFeatures = inspectCodexFeatures,
  inspectionTimeoutMs = INSPECTION_TIMEOUT_MS,
}) {
  const selectedMode = normalizeCodexNetworkMode(mode);
  const args = ["app-server", "--stdio"];
  if (selectedMode === "inherit") {
    return { args, network: codexNetworkStatus(selectedMode, { status: "ready" }) };
  }
  const timeoutMs = Number.isFinite(inspectionTimeoutMs) && inspectionTimeoutMs > 0
    ? Math.min(inspectionTimeoutMs, INSPECTION_TIMEOUT_MS) : INSPECTION_TIMEOUT_MS;
  let timer;
  try {
    const output = await Promise.race([
      Promise.resolve().then(() => inspectFeatures({ codexPath, cwd, env, timeoutMs })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new CodexNetworkError(
          "inspection_timeout", codexNetworkStatus("system", { status: "failed", errorCode: "inspection_timeout" }).message,
        )), timeoutMs);
      }),
    ]);
    const { stage } = parseCodexSystemProxyFeature(output);
    return {
      args: [...args, "--enable", SYSTEM_PROXY_FEATURE],
      network: codexNetworkStatus(selectedMode, { status: "ready", stage }),
    };
  } catch (error) {
    if (error instanceof CodexNetworkError) throw error;
    throw new CodexNetworkError("inspection_failed", codexNetworkStatus("system", {
      status: "failed", errorCode: "inspection_failed",
    }).message);
  } finally {
    clearTimeout(timer);
  }
}
