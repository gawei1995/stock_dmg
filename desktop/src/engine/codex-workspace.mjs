import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  codexNetworkStatus,
  prepareCodexNetworkLaunch,
  inspectCodexFeatures,
} from "./codex-network.mjs";
import {
  createDerivedMetric,
  createHostDecision,
  createModelProposal,
  numericEvidenceRef,
} from "./numeric-evidence.mjs";
import {
  auditCandidateSizingClaims,
  candidateNumericAuthorityMarkdown,
  isolateCandidateNarrativeMarkdown,
} from "./numeric-claim-audit.mjs";
import { buildAnchoredVwapEvidence } from "./anchored-vwap.mjs";
import { readCodexTurnItems } from "./codex-turn-history.mjs";
import { fingerprintRequestedSkills } from "./workspace-review-skills.mjs";
import {
  BROKERAGE_WRITE_TOOLS, classifyBrokerageTool, discoveredBrokerAppToolOverrides,
  isBrokerageServer, isBrokerageWriteApproval,
} from "./broker-tool-policy.mjs";
import { appendTechnicalNumericEvidence } from "./technical-numeric-evidence.mjs";
import { validateReviewEvidenceDelivery } from "./review-evidence-delivery.mjs";
import { tradingViewReadOnlyOverride } from "./tradingview-mcp-policy.mjs";
import { buildReadOnlyGuardDiagnostic } from "./read-only-guard-diagnostics.mjs";
import { buildRestrictedToolPolicy, verifyRestrictedToolIsolation, supportsRestrictedToolFeatures } from "./restricted-tool-policy.mjs";
import {
  assertResearchThreadBinding,
  normalizeResearchProposal,
  normalizeResearchThreadBinding,
  researchInstructions,
  researchProposalOutputSchema,
  researchThreadBindingContext,
  researchThreadBindingFromEvidence,
  supportsResearchProposal,
} from "./research-contract.mjs";
import {
  assertReviewThreadBinding,
  normalizeReviewThreadBinding,
  reviewThreadBindingContext,
  reviewThreadBindingFromEvidence,
} from "./review-thread-binding.mjs";

const THREAD_STORE_KEY = "codexWorkspaceThread";
const THREAD_REGISTRY_STORE_KEY = "codexWorkspaceThreadRegistry";
const HISTORY_INDEX_STORE_KEY = "codexWorkspaceRecentHistoryIndex";
const RPC_STARTUP_TIMEOUT_MS = 20_000;
const RPC_REQUEST_TIMEOUT_MS = 30_000;
const TURN_RECONCILE_INTERVAL_MS = 5_000;
const TURN_RECONCILE_REQUEST_TIMEOUT_MS = 5_000;
const TURN_RECONCILE_TRANSPORT_FAILURE_THRESHOLD = 4;
const TURN_FINAL_RECONCILE_DELAY_MS = 350;
const TURN_FINAL_STATUS_CHECK_MS = 5_000;
const MAX_SETTLED_TURN_IDS = 256;
const COMPACTION_TIMEOUT_MS = 120_000;
const INVENTORY_TTL_MS = 10 * 60 * 1_000;
const INVENTORY_EVENT_COOLDOWN_MS = 30_000;
const INVENTORY_EVENT_DEBOUNCE_MS = 1_500;
const MAX_MCP_INVENTORY_PAGES = 100;
const MAX_STDERR_BYTES = 32_000;
const MAX_STREAM_TEXT_BYTES = 2_000_000;
const HISTORY_RETENTION_DAYS = 30;
const HISTORY_RETENTION_MS = HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const HISTORY_THREAD_NAME = "交易驾驶舱 Agent";
const SESSION_NAME_MAX_LENGTH = 80;
const MAX_HISTORY_THREADS = 40;
const MAX_HISTORY_HYDRATION_CANDIDATES = 20;
const HISTORY_QUERY_DEADLINE_MS = 8_000;
const HISTORY_HYDRATION_TIMEOUT_MS = 3_000;
const MAX_HISTORY_TEXT_BYTES = 60_000;
const MAX_HISTORY_INDEX_TEXT_BYTES = 500_000;
const MAX_HISTORY_TURNS_PER_THREAD = 240;
const MAX_HISTORY_ENTRY_BYTES = 12_000;
// Codex App Server may middle-truncate one large application context value.
// Keep every review block comfortably below that boundary so broker facts and
// user-authored decision evidence arrive as valid, independently parseable JSON.
const MAX_APPLICATION_CONTEXT_CHARS = 3_000;
// A per-block ceiling prevents App Server middle truncation, but it does not
// protect the model from an unbounded number of individually valid blocks.
// Keep the complete turn payload below a deterministic envelope and fail
// closed when required review evidence cannot fit. CJK text is commonly much
// denser in tokens than an ASCII char/4 estimate, so this intentionally leaves
// room for workspace instructions, Skills, tools and the model response.
const MAX_WORKSPACE_ADDITIONAL_CONTEXT_CHARS = 96_000;
const MAX_WORKSPACE_ADDITIONAL_CONTEXT_UTF8_BYTES = 384_000;
const MAX_WORKSPACE_ADDITIONAL_CONTEXT_BLOCKS = 128;
const WORKSPACE_CONTEXT_MANIFEST_PREFIX = "trading-cockpit-context-manifest";
const WORKSPACE_CONTEXT_DIAGNOSTICS = Symbol("workspaceContextDiagnostics");
const PRE_TURN_COMPACTION_RATIO = 0.82;
const PRE_TURN_OUTPUT_RESERVE_TOKENS = 20_000;
// Price-path calculations remain complete in the host result. The model gets
// a bounded, auditable head/tail projection so a long selection cannot turn
// one review into an unbounded application-context payload.
const MAX_TRADE_PATH_ACTIVITIES = 160;
const MAX_TRADE_PATH_LOTS = 120;
const MAX_TRADE_PATH_CYCLES = 120;
const MAX_TRADE_PATH_SEGMENTS = 180;
const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
]);
const OFFICIAL_LONGBRIDGE_HOSTS = new Set([
  "mcp.longbridge.com",
  "mcp.longbridge.cn",
]);
const LONGBRIDGE_READ_ONLY_TOOLS = new Set([
  "account_balance",
  "candlesticks",
  "exchange_rate",
  "finance_calendar",
  "history_executions",
  "history_orders",
  "order_detail",
  "option_quote",
  "quote",
  "stock_positions",
  "today_executions",
  "today_orders",
]);

export class CodexWorkspaceService {
  constructor({
    codexPath = null,
    workspaceDirectory,
    store,
    clientVersion = "0.0.0",
    networkMode = "inherit",
    rpcFactory = (options) => new CodexAppServerRpc(options),
    onStatus = () => {},
    onStream = () => {},
    onCapabilities = () => {},
    turnHistoryBudgetMs = 5_000,
    compactionTimeoutMs = COMPACTION_TIMEOUT_MS,
    fingerprintSkills = fingerprintRequestedSkills,
  }) {
    this.codexPath = codexPath;
    this.workspaceDirectory = workspaceDirectory;
    this.store = store;
    this.clientVersion = clientVersion;
    this.networkMode = codexNetworkStatus(networkMode).mode;
    this.networkState = codexNetworkStatus(this.networkMode);
    this.rpcFactory = rpcFactory;
    this.onStatus = onStatus;
    this.onStream = onStream;
    this.onCapabilities = onCapabilities;
    this.capabilitiesPublication = null;
    this.turnHistoryBudgetMs = Math.max(1, Number(turnHistoryBudgetMs) || 5_000);
    this.compactionTimeoutMs = Math.max(1, Number(compactionTimeoutMs) || COMPACTION_TIMEOUT_MS);
    this.fingerprintSkills = fingerprintSkills;
    this.rpc = null;
    this.rpcGeneration = 0;
    this.threadId = null;
    this.threadMetadata = null;
    this.skills = [];
    this.mcpServers = [];
    this.apps = [];
    // A single App Server/RPC connection owns every cockpit thread. Runtime
    // state is keyed by thread so independent conversations can run in
    // parallel without creating a second harness or tool inventory.
    this.activeTurns = new Map();
    this.abandonedTurns = new Map();
    this.settledTurnIds = new Map();
    this.pendingOperations = new Map();
    this.startPromise = null;
    this.inventoryPromise = null;
    this.inventoryPromises = { skills: null, mcp: null, apps: null };
    this.inventoryInFlightResources = new Set();
    this.inventoryState = {
      skills: { updatedAt: 0, error: null },
      mcp: { updatedAt: 0, error: null },
      apps: { updatedAt: 0, error: null },
    };
    this.inventoryRefreshTimer = null;
    this.inventoryRefreshForceReload = false;
    this.inventoryRefreshResources = new Set();
    this.inventoryQueuedResources = new Set();
    this.inventoryRefreshThreadId = null;
    this.guardPromise = null;
    this.skillsPromise = null;
    this.tokenUsageByThread = new Map();
    this.compactingThreads = new Set();
    this.compactionPromises = new Map();
    this.compactionRuns = new Map();
    this.initialTurnsPages = new Map();
    this.ownedThreadCache = new Map();
    this.threadContextBindingPromises = new Map();
    this.analysisRequestsByThread = new Map();
    // A blind-review thread is permanently isolated as soon as an external
    // tool starts.  The in-memory set closes the race with late approvals;
    // the registry copy survives an app restart.
    this.quarantinedReviewThreads = new Map();
    this.quarantinedReviewTurns = new Set();
    this.historyMutationQueue = Promise.resolve();
    this.sessionTransitionActive = false;
    this.threadConfigOverride = {};
    this.brokerAppGuardRevision = 0;
    this.threadBrokerGuardProofs = new Map();
    this.threadBrokerGuardPromises = new Map();
    this.threadConfiguring = new Set();
    this.brokerAppBindings = [];
    this.threadBrokerConfigReceipts = new Map();
    this.knownLoadedThreads = new Set();
    this.brokerPolicyDiscoveryPromise = null;
    this.readOnlyGuard = emptyReadOnlyGuard();
    this.guardStartupFailure = null;
    this.guardRecheckPromise = null;
    this.guardRecheckContext = null;
    this.restrictedThreadConfig = null;
    this.restrictedFeaturesSupported = false;
    this.inspectRestrictedFeatures = inspectCodexFeatures;
    this.additionalContextContract = emptyAdditionalContextContract();
  }

  get available() {
    return Boolean(this.codexPath);
  }

  status() {
    const proof = this.threadBrokerGuardProofs.get(this.threadId);
    const receipt = this.threadBrokerConfigReceipts.get(this.threadId);
    const restricted = receipt?.toolMode === "restricted" || this.threadMetadata?.toolMode === "restricted";
    const restrictedReady = restricted && proof?.isolation?.ready === true
      && receipt?.generation === this.rpcGeneration && proof?.configHash === receipt.configHash;
    const readOnlyGuardReady = Boolean(proof?.generation === this.rpcGeneration
      && (restricted ? restrictedReady : proof?.revision === this.brokerAppGuardRevision)
      && proof.residualTools.length === 0
      && this.readOnlyGuard.residualApps.length === 0
      && (restricted || !this.guardStartupFailure)
      && !(this.guardRecheckPromise && (!this.guardRecheckContext?.threadId || this.guardRecheckContext.threadId === this.threadId))
      && !this.threadConfiguring.has(this.threadId)
      && !this.threadBrokerGuardPromises.has(this.threadId));
    let readOnlyGuardDiagnostic = buildReadOnlyGuardDiagnostic({
      ready: readOnlyGuardReady,
      checking: Boolean(this.startPromise || this.threadConfiguring.has(this.threadId)
        || this.threadBrokerGuardPromises.has(this.threadId)
        || this.guardRecheckPromise && (!this.guardRecheckContext?.threadId || this.guardRecheckContext.threadId === this.threadId)),
      threadId: this.threadId, proof, receipt: this.threadBrokerConfigReceipts.get(this.threadId),
      generation: this.rpcGeneration, revision: restricted ? receipt?.revision ?? 0 : this.brokerAppGuardRevision,
      residualTools: proof?.residualTools ?? (restricted ? [] : this.readOnlyGuard.residualTools),
      residualApps: restricted ? [] : this.readOnlyGuard.residualApps,
      inventoryError: this.inventoryState.mcp.threadId === this.threadId ? this.inventoryState.mcp.error : null,
      startupFailure: restricted ? null : this.guardStartupFailure, servers: this.mcpServers,
    });
    if (restricted && readOnlyGuardReady) readOnlyGuardDiagnostic = {
      ...readOnlyGuardDiagnostic, state: "ready", code: "restricted_ready", title: "受限研究隔离已核验",
      message: "本对话的外部 MCP / Apps 已关闭并独立核验；可继续研究。恢复外部工具请新建完整工具对话，不热改当前权限。",
      action: null, actionLabel: null,
    };
    return {
      available: this.available,
      ready: Boolean(this.available && this.rpc?.ready && this.threadId),
      active: this.activeTurns.size > 0,
      activeCount: this.activeTurns.size,
      activeThreads: [...this.activeTurns.values()].map((runtime) => ({
        threadId: runtime.threadId,
        operationId: runtime.operationId,
        turnId: runtime.turnId === "pending" ? null : runtime.turnId,
        startedAt: new Date(runtime.startedAt).toISOString(),
      })),
      provider: "Codex App Server",
      authentication: this.available ? "ChatGPT/Codex local login" : "unavailable",
      persistent: true,
      ephemeral: false,
      workspaceDirectory: this.workspaceDirectory,
      threadId: this.threadId,
      threadName: this.threadMetadata?.name ?? null,
      toolsEnabled: true,
      inheritsUserConfig: true,
      network: { ...this.networkState },
      sandbox: "danger-full-access",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      historyRetentionDays: HISTORY_RETENTION_DAYS,
      skillCount: this.skills.length,
      mcpServerCount: this.mcpServers.length,
      appCount: this.apps.length,
      readOnlyGuardReady,
      readOnlyGuardDiagnostic,
      researchMode: { kind: restricted ? "restricted" : "full", available: readOnlyGuardReady,
        reason: restricted ? "本对话已关闭外部 MCP / Apps；可继续本地 Skills、网页、文件和宿主提供证据的研究。" : null,
        unavailableTools: restricted ? ["MCP", "Apps"] : [], recoveryAction: restricted ? "new_full_session" : null },
      brokerageWriteToolBlockCount: this.readOnlyGuard.blockedTools.length,
      brokerageWriteAppBlockCount: this.readOnlyGuard.blockedApps.length,
      additionalContextContract: {
        ...this.additionalContextContract,
        serverUserAgent: this.rpc?.initializeInfo?.userAgent ?? null,
      },
    };
  }

  async prepare({ toolMode = "auto" } = {}) {
    if (!["auto", "full", "restricted"].includes(toolMode)) throw new CodexWorkspaceError("configuration", "研究工具模式无效。");
    if (!this.available) {
      throw new CodexWorkspaceError(
        "unavailable",
        "未检测到本机 Codex 运行时；请先安装或登录 ChatGPT/Codex。",
      );
    }
    if (!this.workspaceDirectory || !path.isAbsolute(this.workspaceDirectory)) {
      throw new CodexWorkspaceError("configuration", "Codex 项目工作区必须是绝对路径。");
    }
    await mkdir(this.workspaceDirectory, { recursive: true, mode: 0o700 });
    await ensureWorkspaceGuide(this.workspaceDirectory);
    await this.#ensureStarted({ toolMode });
    return this.status();
  }

  async #ensureStarted({ toolMode = "auto" } = {}) {
    if (this.startPromise) return this.startPromise;
    if (this.rpc?.ready && this.threadId) return;
    const starting = this.#start({ toolMode });
    const generation = this.rpcGeneration;
    const tracked = starting.catch((error) => {
      if (generation === this.rpcGeneration) this.guardStartupFailure ??= { code: error?.kind === "read_only_guard" ? "preflight_unavailable" : "runtime_unavailable" };
      throw error;
    }).finally(() => {
      if (this.startPromise === tracked) this.startPromise = null;
      if (generation === this.rpcGeneration) this.#publishCapabilities();
    });
    this.startPromise = tracked;
    return tracked;
  }

  async #start({ toolMode = "auto" } = {}) {
    const generation = ++this.rpcGeneration;
    if (this.guardRecheckContext?.rpc) {
      this.guardRecheckContext = null;
      this.guardRecheckPromise = null;
    }
    this.abandonedTurns.clear();
    this.settledTurnIds.clear();
    this.brokerAppGuardRevision = 0;
    this.threadBrokerGuardProofs.clear();
    this.threadBrokerGuardPromises.clear();
    this.threadConfiguring.clear();
    this.brokerAppBindings = [];
    this.threadBrokerConfigReceipts.clear();
    this.knownLoadedThreads.clear();
    this.brokerPolicyDiscoveryPromise = null;
    this.readOnlyGuard = emptyReadOnlyGuard();
    this.guardStartupFailure = null;
    this.restrictedFeaturesSupported = false;
    // A transport-ready replacement is not a configured conversation. Keep
    // the encrypted pointer intact, but do not present the previous ID as ready.
    this.threadId = null;
    this.threadMetadata = null;
    const previousRpc = this.rpc;
    this.rpc = null;
    previousRpc?.dispose();
    let rpc = null;
    rpc = this.rpcFactory({
      codexPath: this.codexPath,
      cwd: this.workspaceDirectory,
      clientVersion: this.clientVersion,
      networkMode: this.networkMode,
      onNetworkState: (network) => {
        if (this.rpcGeneration !== generation || this.rpc !== rpc) return;
        this.networkState = codexNetworkStatus(this.networkMode, network);
        notify(this.onStatus, {
          phase: `codex_network_${this.networkState.status}`,
          message: this.networkState.message,
          network: { ...this.networkState },
        });
        this.#publishCapabilities();
      },
      onNotification: (message) => {
        if (this.rpcGeneration === generation && this.rpc === rpc) this.#handleNotification(message);
      },
      onServerRequest: (message) => {
        if (this.rpcGeneration === generation && this.rpc === rpc) {
          this.#handleServerRequest(message, rpc);
        }
      },
      onStderr: (message) => {
        if (this.rpcGeneration === generation && this.rpc === rpc) this.#handleStderr(message);
      },
      onExit: (error) => this.#handleExit(error, { generation, rpc }),
    });
    this.rpc = rpc;
    await rpc.start();
    if (this.rpcGeneration !== generation || this.rpc !== rpc) {
      throw new CodexWorkspaceError("runtime", "Codex App Server 启动已被较新的连接替代。");
    }
    this.inventoryState = {
      skills: { updatedAt: 0, error: null },
      mcp: { updatedAt: 0, error: null },
      apps: { updatedAt: 0, error: null },
    };
    this.additionalContextContract = emptyAdditionalContextContract();
    await this.#prepareReadOnlyGuard();
    const existingRegistry = await this.#loadOwnedThreadRegistry();
    for (const entry of existingRegistry.threads) {
      if (entry.reviewQuarantine) {
        this.quarantinedReviewThreads.set(entry.threadId, entry.reviewQuarantine);
        if (entry.reviewQuarantine.turnId) {
          this.quarantinedReviewTurns.add(entry.reviewQuarantine.turnId);
        }
      }
    }
    let saved = await this.store?.get?.(THREAD_STORE_KEY);
    if (saved?.threadId && this.quarantinedReviewThreads.has(String(saved.threadId))) {
      await this.store?.set?.(THREAD_STORE_KEY, null);
      saved = null;
      notify(this.onStatus, {
        phase: "codex_blind_thread_quarantined",
        message: "上一个盲态复盘线程曾启动外部工具，已永久隔离并改用新对话",
      });
    }
    if (saved?.threadId) {
      // THREAD_STORE_KEY is an app-owned encrypted pointer, so it is safe to
      // migrate that exact ID into the registry. Names and cwd are never used
      // to infer ownership.
      await this.#registerOwnedThread(saved);
    }
    if (saved?.threadId && isOlderThanRetention(saved.updatedAt ?? saved.createdAt)) {
      try {
        // Rotate only after 30 days without activity. A long-running thread
        // that is still used must remain resumable regardless of creation age.
        // The encrypted pointer can lag behind the App Server when the desktop
        // exits after Codex persisted a turn but before local metadata flushes.
        // Confirm exact server recency and the persisted turns before rotating.
        const cutoffMs = Date.now() - HISTORY_RETENTION_MS;
        let actualActivityMs = await this.#readThreadActivityMs(saved.threadId);
        let recentSnapshot = null;
        if (actualActivityMs < cutoffMs) {
          recentSnapshot = await this.#snapshotThreadRecentHistory(saved.threadId, saved);
          actualActivityMs = Math.max(actualActivityMs, recentSnapshot.recencyMs);
        }
        if (actualActivityMs >= cutoffMs) {
          saved = {
            ...saved,
            updatedAt: isoTimestamp(actualActivityMs) ?? saved.updatedAt,
          };
          await this.store?.set?.(THREAD_STORE_KEY, saved);
          await this.#registerOwnedThread(saved);
          notify(this.onStatus, {
            phase: "codex_history_retained",
            message: "Codex 服务端确认该对话最近仍在使用，已保留原线程并继续分析",
          });
        } else {
          // Persist recent summaries before archiving the recoverable JSONL.
          if (!recentSnapshot) await this.#snapshotThreadRecentHistory(saved.threadId, saved);
          await this.rpc.request("thread/archive", { threadId: saved.threadId });
          await this.#markOwnedThreadArchived(saved.threadId);
          await this.store?.set?.(THREAD_STORE_KEY, null);
          saved = null;
          notify(this.onStatus, {
            phase: "codex_history_rotated",
            message: "上一个月度 Codex 线程已安全归档（可恢复），正在创建新线程",
          });
        }
      } catch (error) {
        // If the 30-day active index cannot be written, retain and resume the
        // old thread rather than risking loss of recent searchable context.
        notify(this.onStatus, {
          phase: "codex_history_warning",
          message: `月度线程暂未轮换，原线程与历史仍保留：${cleanError(error)}`,
        });
      }
    }
    let response = null;
    let createdThreadName = null;
    if (saved?.threadId && toolMode !== "auto" && toolMode !== (saved.toolMode === "restricted" ? "restricted" : "full")) {
      // An explicit new mode must never cold-reconfigure the saved transcript.
      // Ownership was registered above; it remains available in history.
      saved = null;
    }
    let selectedToolMode = toolMode === "restricted" || saved?.toolMode === "restricted" && toolMode !== "full" ? "restricted" : "full";
    if (selectedToolMode === "full") {
      try { await this.#discoverBrokerAppPolicy(); }
      catch (error) {
        if (toolMode === "full") throw error;
        try { await this.#prepareRestrictedFeatures(); }
        catch { throw error; }
        selectedToolMode = "restricted";
        // Never change a loaded full conversation's permissions or relabel
        // its old transcript. Preserve it in the registry and open a new one.
        saved = null;
        this.guardStartupFailure = null;
        notify(this.onStatus, { phase: "codex_research_restricted", message: "外部工具核验暂不可用，已改用独立受限研究对话；原对话保留，未放宽交易权限。" });
      }
    }
    if (selectedToolMode === "restricted") await this.#prepareRestrictedFeatures();
    let configuration = this.#captureBrokerThreadConfiguration(selectedToolMode);
    let coldOrigin = "start";
    if (saved?.threadId && saved.cwd === this.workspaceDirectory) {
      try {
        const cold = await this.#isColdThread(saved.threadId);
        configuration = this.#captureBrokerThreadConfiguration(selectedToolMode);
        const resumed = await this.rpc.request("thread/resume", {
          threadId: saved.threadId,
          cwd: this.workspaceDirectory,
          excludeTurns: true,
          initialTurnsPage: {
            limit: 30,
            sortDirection: "desc",
            itemsView: "summary",
          },
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          sandbox: "danger-full-access",
          config: configuration.config,
          dynamicTools: cockpitDynamicTools(),
        });
        if (String(resumed?.thread?.id ?? "") !== String(saved.threadId)) {
          throw new CodexWorkspaceError("protocol", "Codex 恢复了错误的持久线程。");
        }
        response = resumed;
        coldOrigin = cold ? "cold_resume" : null;
        notify(this.onStatus, {
          phase: "codex_thread_resumed",
          message: "已恢复交易驾驶舱的持久 Codex 项目线程",
        });
      } catch (error) {
        notify(this.onStatus, {
          phase: "codex_thread_recreate",
          message: "原 Codex 线程无法恢复，正在创建新的持久项目线程",
          detail: cleanError(error),
        });
      }
    }
    if (!response) {
      createdThreadName = HISTORY_THREAD_NAME;
      configuration = this.#captureBrokerThreadConfiguration(selectedToolMode);
      coldOrigin = "start";
      response = await this.rpc.request("thread/start", {
        cwd: this.workspaceDirectory,
        ephemeral: false,
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "danger-full-access",
        config: configuration.config,
        serviceName: "trading_cockpit",
        dynamicTools: cockpitDynamicTools(),
      });
      notify(this.onStatus, {
        phase: "codex_thread_created",
        message: "已创建交易驾驶舱的持久 Codex 项目线程",
      });
    }
    this.threadId = response?.thread?.id;
    if (!this.threadId) throw new CodexWorkspaceError("protocol", "Codex 没有返回线程 ID。");
    if (response.thread?.ephemeral === true) {
      throw new CodexWorkspaceError("protocol", "Codex 返回了临时线程，已拒绝将其标记为持久项目会话。");
    }
    this.#recordBrokerThreadConfiguration(this.threadId, configuration, coldOrigin);
    this.threadMetadata = {
      threadId: this.threadId,
      cwd: response.cwd ?? this.workspaceDirectory,
      name: createdThreadName ?? saved?.name ?? HISTORY_THREAD_NAME,
      preview: String(saved?.preview ?? "").slice(0, 500),
      model: response.model ?? null,
      modelProvider: response.modelProvider ?? null,
      instructionSources: response.instructionSources ?? [],
      reviewBinding: normalizeReviewThreadBinding(saved?.reviewBinding),
      researchBinding: normalizeResearchThreadBinding(saved?.researchBinding),
      toolMode: selectedToolMode,
      createdAt: response.thread?.createdAt ?? saved?.createdAt ?? null,
      updatedAt: isoTimestamp(response.thread?.updatedAt)
        ?? isoTimestamp(saved?.updatedAt)
        ?? new Date().toISOString(),
    };
    if (response.initialTurnsPage) {
      this.initialTurnsPages.set(this.threadId, response.initialTurnsPage);
    }
    await this.store?.set?.(THREAD_STORE_KEY, this.threadMetadata);
    await this.#registerOwnedThread(this.threadMetadata);
    if (createdThreadName) {
      await this.rpc.request("thread/name/set", {
        threadId: this.threadId,
        name: createdThreadName,
      }).catch(() => {});
    }
    // Skills/MCP/App discovery can be slow when a connector is reconnecting.
    // The persistent thread and local session registry are already usable, so
    // hydrate capability inventory in the background. analyze() waits for this
    // exact promise before enforcing the brokerage write guard.
    this.refreshInventory({ threadId: this.threadId }).catch((error) => {
      notify(this.onStatus, {
        phase: "codex_inventory_warning",
        threadId: this.threadId,
        message: `Codex 能力清单稍后重试：${cleanError(error)}`,
      });
    });
    this.#archiveExpiredHistory().catch((error) => notify(this.onStatus, {
      phase: "codex_history_warning",
      message: `30 天历史归档暂未完成：${cleanError(error)}`,
    }));
  }

  async #prepareReadOnlyGuard() {
    let effectiveConfig = {};
    try {
      const configResult = await this.rpc.request("config/read", {
        includeLayers: false,
        cwd: this.workspaceDirectory,
      });
      if (!configResult?.config || typeof configResult.config !== "object" || Array.isArray(configResult.config)) {
        throw new Error("Codex 未返回有效配置对象");
      }
      effectiveConfig = configResult.config;
    } catch (error) {
      this.guardStartupFailure = { code: "config_unavailable" };
      notify(this.onStatus, {
        phase: "codex_read_only_guard_warning",
        message: "Codex 配置预检未完成，无法确认券商与 TradingView 只读边界；本轮未启动。",
      });
      throw new CodexWorkspaceError("read_only_guard", "无法读取 Codex 有效配置；未创建或恢复缺少只读权限校验的分析会话。", { cause: error });
    }
    const guard = buildReadOnlyToolGuard({ effectiveConfig });
    this.restrictedEffectiveConfig = structuredClone(effectiveConfig);
    this.restrictedThreadConfig = null;
    this.threadConfigOverride = guard.config;
    this.readOnlyGuard = {
      ...guard,
      inventoryVerified: false,
      residualTools: [],
      residualApps: [],
    };
    if (guard.blockedTools.length || guard.blockedApps.length) {
      notify(this.onStatus, {
        phase: "codex_read_only_guard",
        message: "Codex 研究能力保持开放；破坏性 App 动作已关闭，已识别券商的交易写工具已在线程配置层禁用",
      });
    }
  }

  async #discoverBrokerAppPolicy() {
    if (this.brokerPolicyDiscoveryPromise) return this.brokerPolicyDiscoveryPromise;
    const rpc = this.rpc, generation = this.rpcGeneration;
    const operation = (async () => {
      notify(this.onStatus, { phase: "codex_read_only_preflight", message: "正在核对已安装券商 App 的写工具隔离配置；尚未启动模型分析" });
      const installed = await rpc.request("app/installed", { threadId: null, forceRefresh: true });
      if (!Array.isArray(installed?.apps)) throw new CodexWorkspaceError("read_only_guard", "已安装 App 运行时清单未返回；未创建未核验的分析对话。");
      if (rpc !== this.rpc || generation !== this.rpcGeneration) throw new CodexWorkspaceError("runtime", "券商工具预检连接已被替换。");
      // No installed runtime Apps: the per-thread MCP scan still fails closed
      // if an App write capability appears later. Skills remain asynchronous.
      if (!installed.apps.length) return;
      const catalog = await listAllMcpServerStatuses(rpc, { threadId: null });
      if (rpc !== this.rpc || generation !== this.rpcGeneration) throw new CodexWorkspaceError("runtime", "券商工具预检连接已被替换。");
      const servers = (catalog?.data ?? []).map(normalizeMcpServer);
      assertBrokerInventoryAvailable(servers, this.readOnlyGuard.guardedServerNames);
      const runtimeApps = installed.apps.filter(app => typeof app.id === "string" && typeof app.runtimeName === "string")
        .map(app => ({ id: app.id, name: app.runtimeName }));
      let discovered = discoveredBrokerAppToolOverrides({ servers, apps: runtimeApps });
      if (discovered.unresolved.length) {
        // Public metadata may supplement identity, never authorize a tool.
        // Preserve discovery errors; do not invent an App ID from a namespace.
        let publicApps = this.apps;
        try {
          const listed = await rpc.request("app/list", { threadId: null, cursor: null, limit: 100, forceRefetch: false });
          if (!Array.isArray(listed?.data)) throw new Error("App identity list is unavailable");
          publicApps = listed.data.filter(app => app.isAccessible === true).map(normalizeApp).filter(Boolean);
        } catch (error) {
          if (rpc === this.rpc && generation === this.rpcGeneration) this.inventoryState.apps.error = cleanError(error);
        }
        const identities = [...runtimeApps, ...publicApps];
        discovered = discoveredBrokerAppToolOverrides({ servers, apps: identities });
      }
      if (rpc !== this.rpc || generation !== this.rpcGeneration) throw new CodexWorkspaceError("runtime", "券商工具预检连接已被替换。");
      if (discovered.unresolved.length) {
        this.readOnlyGuard.residualTools = discovered.unresolved.map(({ server, tool }) => ({ server, tool }));
        this.guardStartupFailure = { code: "app_identity_unavailable" };
        throw new CodexWorkspaceError("read_only_guard", "券商 App 写工具缺少唯一的已发现身份；本轮未创建分析对话，请刷新能力清单后重试。");
      }
      let changed = false;
      for (const [appId, override] of Object.entries(discovered.overrides)) {
        const current = this.threadConfigOverride.apps?.[appId] ?? {};
        const tools = { ...current.tools };
        for (const [tool, policy] of Object.entries(override.tools)) {
          if (tools[tool]?.enabled !== false) changed = true;
          tools[tool] = { ...tools[tool], ...policy };
        }
        this.threadConfigOverride = { ...this.threadConfigOverride,
          apps: { ...this.threadConfigOverride.apps, [appId]: { ...current, tools } } };
      }
      for (const binding of discovered.bindings) {
        if (!this.brokerAppBindings.some(item => item.server === binding.server && item.tool === binding.tool && item.appId === binding.appId)) {
          this.brokerAppBindings.push(binding);
          this.readOnlyGuard.blockedTools.push({ server: binding.server, tool: binding.tool, appId: binding.appId });
          changed = true;
        }
      }
      if (changed) this.brokerAppGuardRevision += 1;
      this.readOnlyGuard.config = this.threadConfigOverride;
    })();
    const tracked = operation.finally(() => { if (this.brokerPolicyDiscoveryPromise === tracked) this.brokerPolicyDiscoveryPromise = null; });
    this.brokerPolicyDiscoveryPromise = tracked;
    return tracked;
  }

  async #prepareRestrictedFeatures() {
    if (this.restrictedFeaturesSupported) return;
    const rpc = this.rpc, generation = this.rpcGeneration;
    const output = await this.inspectRestrictedFeatures({ codexPath: this.codexPath, cwd: this.workspaceDirectory, env: process.env });
    if (rpc !== this.rpc || generation !== this.rpcGeneration) throw new CodexWorkspaceError("runtime", "受限研究配置检查已被新连接替代。");
    if (!supportsRestrictedToolFeatures(output)) throw new CodexWorkspaceError("read_only_guard", "当前 Codex 不支持完整关闭外部工具的受限研究模式；未绕过只读保护。请更新 Codex 后重试。");
    this.restrictedThreadConfig = buildRestrictedToolPolicy(this.restrictedEffectiveConfig);
    this.restrictedFeaturesSupported = true;
  }

  #captureBrokerThreadConfiguration(toolMode = "full") {
    return { generation: this.rpcGeneration, revision: this.brokerAppGuardRevision,
      toolMode,
      config: structuredClone(toolMode === "restricted" ? this.restrictedThreadConfig : this.threadConfigOverride),
      bindings: toolMode === "restricted" ? [] : structuredClone(this.brokerAppBindings) };
  }

  #isRestrictedThread(threadId) {
    return this.threadBrokerConfigReceipts.get(threadId)?.toolMode === "restricted"
      || (this.threadMetadata?.threadId === threadId && this.threadMetadata?.toolMode === "restricted")
      || this.ownedThreadCache.get(threadId)?.toolMode === "restricted";
  }

  #recordBrokerThreadConfiguration(threadId, snapshot, origin) {
    if (snapshot.generation !== this.rpcGeneration) throw new CodexWorkspaceError("runtime", "对话配置响应来自已替换的连接。");
    if (origin && !this.knownLoadedThreads.has(threadId)) {
      this.threadBrokerConfigReceipts.set(threadId, { ...snapshot, origin,
        configHash: createHash("sha256").update(JSON.stringify(snapshot.config)).digest("hex") });
    }
    this.knownLoadedThreads.add(threadId);
    this.threadBrokerGuardProofs.delete(threadId);
  }

  async #isColdThread(threadId) {
    if (this.knownLoadedThreads.has(threadId)) return false;
    let cursor = null;
    const seen = new Set();
    for (let page = 0; page < MAX_MCP_INVENTORY_PAGES; page++) {
      const loaded = await this.rpc.request("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(loaded?.data)) throw new CodexWorkspaceError("read_only_guard", "无法确认对话是否已加载；拒绝把热恢复标记为冷配置核验。");
      for (const id of loaded.data) this.knownLoadedThreads.add(String(id));
      if (this.knownLoadedThreads.has(threadId)) return false;
      if (!loaded.nextCursor) return true;
      if (seen.has(loaded.nextCursor)) break;
      seen.add(loaded.nextCursor);
      cursor = loaded.nextCursor;
    }
    throw new CodexWorkspaceError("read_only_guard", "已加载对话清单未完整返回；无法确认冷恢复。");
  }

  async refreshInventory({
    forceReload = false,
    threadId = this.threadId,
    resources = ["skills", "mcp", "apps"],
  } = {}) {
    await this.#ensureStarted();
    const requestedResources = normalizeInventoryResources(resources);
    const now = Date.now();
    const staleResources = requestedResources.filter((resource) => forceReload
      || resource === "mcp" && (this.inventoryState.mcp.threadId !== threadId
        || this.threadBrokerGuardProofs.get(threadId)?.revision !== this.brokerAppGuardRevision)
      || !this.inventoryState[resource].updatedAt
      || now - this.inventoryState[resource].updatedAt >= INVENTORY_TTL_MS
      || this.inventoryState[resource].error);
    if (!staleResources.length) return this.capabilities();

    const requests = staleResources.map((resource) => {
      if (resource === "mcp" && this.threadBrokerGuardPromises.has(threadId)) return this.threadBrokerGuardPromises.get(threadId);
      if (resource !== "mcp" && this.inventoryPromises[resource]) return this.inventoryPromises[resource];
      this.inventoryInFlightResources.add(resource);
      const rpc = this.rpc, generation = this.rpcGeneration;
      let resourcePromise = this.#loadInventoryResource(resource, {
        forceReload,
        threadId,
        rpc,
        generation,
      });
      resourcePromise = resourcePromise.finally(() => {
        if (this.inventoryPromises[resource] === resourcePromise) {
          this.inventoryPromises[resource] = null;
          this.inventoryInFlightResources.delete(resource);
          this.#drainQueuedInventoryRefresh();
        }
        this.#publishCapabilities({ rpc, generation });
      });
      this.inventoryPromises[resource] = resourcePromise;
      if (resource === "skills") {
        const trackedSkills = resourcePromise.catch(() => null).finally(() => {
          if (this.skillsPromise === trackedSkills) this.skillsPromise = null;
        });
        this.skillsPromise = trackedSkills;
      } else if (resource === "mcp") {
        const trackedGuard = resourcePromise.catch(() => null).finally(() => {
          if (this.guardPromise === trackedGuard) this.guardPromise = null;
        });
        this.guardPromise = trackedGuard;
      }
      return resourcePromise;
    });
    const inventoryPromise = Promise.allSettled(requests).then(() => this.capabilities());
    this.inventoryPromise = inventoryPromise;
    return inventoryPromise.finally(() => {
      if (this.inventoryPromise === inventoryPromise) this.inventoryPromise = null;
    });
  }

  async recheckReadOnlyGuard() {
    if (this.guardRecheckPromise) return this.guardRecheckPromise;
    const context = { rpc: null, generation: null };
    this.guardRecheckContext = context;
    const isCurrent = () => this.guardRecheckContext === context
      && (!context.rpc || context.rpc === this.rpc && context.generation === this.rpcGeneration);
    const operation = (async () => {
      try {
        await this.prepare();
        if (!isCurrent()) return;
        context.rpc = this.rpc;
        context.generation = this.rpcGeneration;
        const threadId = this.threadId;
        context.threadId = threadId;
        const restricted = this.#isRestrictedThread(threadId);
        const priorCheck = this.threadBrokerGuardPromises.get(threadId);
        if (priorCheck) await priorCheck.catch(() => {});
        if (!isCurrent()) return;
        this.threadBrokerGuardProofs.delete(threadId);
        // Refresh discovery, not authorization or global configuration. A new
        // policy revision requires a new/cold conversation; never hot-bless it.
        if (!restricted) await this.#discoverBrokerAppPolicy();
        if (!isCurrent()) return;
        this.guardStartupFailure = null;
        await this.refreshInventory({ forceReload: true, threadId, resources: ["mcp"] });
      } catch (error) {
        if (isCurrent()) this.guardStartupFailure ??= { code: "preflight_unavailable" };
      }
    })();
    const tracked = operation.finally(() => {
      if (this.guardRecheckPromise === tracked) this.guardRecheckPromise = null;
      if (isCurrent()) {
        this.guardRecheckContext = null;
        this.#publishCapabilities();
      }
    }).then(() => this.capabilities());
    this.guardRecheckPromise = tracked;
    this.#publishCapabilities();
    return tracked;
  }

  async #loadInventoryResource(resource, { forceReload, threadId, rpc, generation }) {
    const isCurrentGeneration = () => this.rpc === rpc && this.rpcGeneration === generation;
    if (resource === "skills") {
      return rpc.request("skills/list", {
        cwds: [this.workspaceDirectory],
        forceReload,
      }).then((value) => {
        if (!isCurrentGeneration()) return value;
        this.skills = (value?.data ?? [])
          .flatMap((entry) => entry.skills ?? [])
          .filter((skill) => skill.enabled !== false)
          .map(normalizeSkill)
          .filter(Boolean);
        this.inventoryState.skills = { updatedAt: Date.now(), error: null };
        return value;
      }).catch((error) => {
        if (isCurrentGeneration()) this.inventoryState.skills.error = cleanError(error);
        throw error;
      });
    }
    if (resource === "mcp") {
      return this.#verifyThreadBrokerGuard({ threadId, rpc, generation });
    }
    if (resource === "apps") {
      return rpc.request("app/list", {
        threadId,
        cursor: null,
        limit: 100,
        forceRefetch: forceReload,
      }).then((value) => {
        if (!isCurrentGeneration()) return value;
        this.apps = (value?.data ?? [])
        .filter((app) => app.isAccessible === true && app.isEnabled !== false)
        .map(normalizeApp)
        .filter(Boolean);
        // Apps SDK destructive tools are disabled for this entire cockpit
        // thread; research/query Apps do not gate starting a turn.
        this.readOnlyGuard.residualApps = [];
        this.inventoryState.apps = { updatedAt: Date.now(), error: null };
        return value;
      }).catch((error) => {
        if (isCurrentGeneration()) this.inventoryState.apps.error = cleanError(error);
        throw error;
      });
    }
    throw new CodexWorkspaceError("configuration", `Unknown inventory resource: ${resource}`);
  }

  #verifyThreadBrokerGuard({ threadId, rpc = this.rpc, generation = this.rpcGeneration }) {
    const pending = this.threadBrokerGuardPromises.get(threadId);
    if (pending) return pending;
    const promise = this.#readAndApplyThreadBrokerGuard({ threadId, rpc, generation }).finally(() => {
      if (this.threadBrokerGuardPromises.get(threadId) === promise) {
        this.threadBrokerGuardPromises.delete(threadId);
      }
      this.#publishCapabilities({ rpc, generation });
    });
    this.threadBrokerGuardPromises.set(threadId, promise);
    return promise;
  }

  async #readAndApplyThreadBrokerGuard({ threadId, rpc, generation }) {
    const isCurrent = () => this.rpc === rpc && this.rpcGeneration === generation;
    const proofRevision = this.brokerAppGuardRevision;
    const receipt = this.threadBrokerConfigReceipts.get(threadId);
    try {
      if (this.#isRestrictedThread(threadId)) {
        if (receipt?.toolMode !== "restricted" || receipt.generation !== generation || !["start", "cold_resume"].includes(receipt.origin)) {
          throw new CodexWorkspaceError("read_only_guard", "受限研究缺少本连接的冷启动隔离回执；请新建受限研究对话。");
        }
        const [value, installed] = await Promise.all([
          listAllMcpServerStatuses(rpc, { threadId }),
          rpc.request("app/installed", { threadId, forceRefresh: false }),
        ]);
        if (!isCurrent()) return value;
        const isolation = verifyRestrictedToolIsolation({ servers: value?.data, apps: installed?.apps,
          complete: value?.nextCursor == null && installed?.nextCursor == null });
        if (!isolation.ready) throw new CodexWorkspaceError("read_only_guard", "受限研究的外部工具关闭未获确认；没有把工具发现失败当作隔离成功。");
        const proof = { generation, revision: receipt.revision, toolMode: "restricted", configHash: receipt.configHash,
          isolation, residualTools: [], rawResidualTools: [], configuredAppDenials: [], configuredMcpDenials: [],
          updatedAt: Date.now(), error: null };
        this.threadBrokerGuardProofs.set(threadId, proof);
        if (threadId === this.threadId) this.mcpServers = value.data.map(normalizeMcpServer);
        this.inventoryState.mcp = { updatedAt: proof.updatedAt, error: null, threadId };
        return value;
      }
      const value = await listAllMcpServerStatuses(rpc, { threadId });
      if (!isCurrent()) return value;
      const servers = (value?.data ?? []).map(normalizeMcpServer);
      assertBrokerInventoryAvailable(servers, this.readOnlyGuard.guardedServerNames);
      const rawResidualTools = [
        ...visibleBrokerageWriteTools(servers, this.readOnlyGuard.guardedServerNames),
        ...visibleTradingViewDisallowedTools(servers, this.readOnlyGuard.tradingViewTools),
      ];
      // The upstream raw catalog retains disabled App tools. app/read is
      // display metadata, and app/installed.callable is App-level existence;
      // neither is a per-tool authorization oracle. This receipt attests only
      // exact deny-only config accepted at start/cold resume, not a write call.
      const configuredAppDenials = rawResidualTools.filter(tool => tool.server === "codex_apps"
        && receipt?.generation === generation && receipt.revision === proofRevision
        && receipt.bindings.some(binding => binding.server === tool.server && binding.tool === tool.tool
          && receipt.config.apps?.[binding.appId]?.tools?.[binding.operation]?.enabled === false));
      // A configured deny-list is evidence only for the exact cold-loaded
      // thread. Raw MCP catalogs can also retain disabled entries; a hot
      // resume must never borrow the process-level config as authorization.
      const configuredMcpDenials = rawResidualTools.filter(tool => tool.server !== "codex_apps"
        && receipt?.generation === generation && receipt.revision === proofRevision
        && receiptDeniesMcpTool(receipt, tool));
      const residual = rawResidualTools.filter(tool => !configuredAppDenials.includes(tool) && !configuredMcpDenials.includes(tool));
      const proof = { generation, revision: proofRevision, residualTools: residual, rawResidualTools,
        configuredAppDenials, configuredMcpDenials, updatedAt: Date.now(), error: null };
      this.mcpServers = servers;
      this.readOnlyGuard.inventoryVerified = true;
      this.readOnlyGuard.residualTools = residual;
      this.threadBrokerGuardProofs.set(threadId, proof);
      this.inventoryState.mcp = { updatedAt: proof.updatedAt, error: null, threadId };
      return value;
    } catch (error) {
      if (isCurrent()) {
        this.threadBrokerGuardProofs.delete(threadId);
        this.readOnlyGuard.inventoryVerified = false;
        this.inventoryState.mcp = { ...this.inventoryState.mcp, threadId, error: cleanError(error) };
      }
      throw error;
    }
  }

  #scheduleInventoryRefresh({
    forceReload = false,
    threadId = this.threadId,
    resources = ["skills", "mcp", "apps"],
  } = {}) {
    const requestedResources = normalizeInventoryResources(resources);
    if (!requestedResources.length) return;
    const inFlightResources = requestedResources
      .filter((resource) => this.inventoryPromises[resource]);
    for (const resource of inFlightResources) this.inventoryQueuedResources.add(resource);
    if (inFlightResources.length) {
      // Force a second read after the current resource-specific request. The
      // update event may have occurred after the response snapshot was taken.
      this.inventoryRefreshThreadId = threadId ?? this.inventoryRefreshThreadId;
    }
    const readyResources = requestedResources
      .filter((resource) => !this.inventoryPromises[resource]);
    if (!readyResources.length) return;
    const now = Date.now();
    const allCoolingDown = readyResources.every((resource) => {
      const updatedAt = this.inventoryState[resource].updatedAt;
      return updatedAt && now - updatedAt < INVENTORY_EVENT_COOLDOWN_MS;
    });
    if (!forceReload && allCoolingDown) return;
    this.inventoryRefreshForceReload ||= forceReload;
    for (const resource of readyResources) this.inventoryRefreshResources.add(resource);
    this.inventoryRefreshThreadId = threadId ?? this.inventoryRefreshThreadId;
    if (this.inventoryRefreshTimer) return;
    this.inventoryRefreshTimer = setTimeout(() => {
      this.inventoryRefreshTimer = null;
      const reload = this.inventoryRefreshForceReload;
      const queuedResources = [...this.inventoryRefreshResources];
      const queuedThreadId = this.inventoryRefreshThreadId ?? this.threadId;
      this.inventoryRefreshForceReload = false;
      this.inventoryRefreshResources.clear();
      this.inventoryRefreshThreadId = null;
      this.refreshInventory({
        forceReload: reload,
        threadId: queuedThreadId,
        resources: queuedResources,
      }).catch((error) => notify(this.onStatus, {
        phase: "codex_inventory_warning",
        threadId: queuedThreadId,
        message: `Codex 能力变更稍后重试：${cleanError(error)}`,
      }));
    }, INVENTORY_EVENT_DEBOUNCE_MS);
    this.inventoryRefreshTimer.unref?.();
  }

  #drainQueuedInventoryRefresh() {
    const resources = [...this.inventoryQueuedResources]
      .filter((resource) => !this.inventoryPromises[resource]);
    if (!resources.length) return;
    for (const resource of resources) this.inventoryQueuedResources.delete(resource);
    const threadId = this.inventoryRefreshThreadId ?? this.threadId;
    this.#scheduleInventoryRefresh({ forceReload: true, threadId, resources });
  }

  #publishCapabilities({ rpc = this.rpc, generation = this.rpcGeneration } = {}) {
    if (!rpc || this.rpc !== rpc || this.rpcGeneration !== generation) return;
    if (this.capabilitiesPublication?.rpc === rpc && this.capabilitiesPublication.generation === generation) return;
    const publication = { rpc, generation };
    this.capabilitiesPublication = publication;
    // Publish after promise/single-flight cleanup, without awaiting the UI.
    // A disposed generation must never overwrite the replacement's readiness.
    setImmediate(() => {
      if (this.capabilitiesPublication === publication) this.capabilitiesPublication = null;
      if (this.rpc !== rpc || this.rpcGeneration !== generation) return;
      try { Promise.resolve(this.onCapabilities(this.capabilities())).catch(() => {}); }
      catch { /* UI delivery must not change core execution. */ }
    });
  }

  capabilities() {
    const guardedServerNames = new Set(this.readOnlyGuard.guardedServerNames);
    const proof = this.threadBrokerGuardProofs.get(this.threadId);
    const receipt = this.threadBrokerConfigReceipts.get(this.threadId);
    const restricted = receipt?.toolMode === "restricted" || this.threadMetadata?.toolMode === "restricted";
    const inventoryState = { ...this.inventoryState, mcp: proof
      ? { updatedAt: proof.updatedAt, error: proof.error }
      : { updatedAt: 0, error: this.inventoryState.mcp.threadId === this.threadId ? this.inventoryState.mcp.error : null } };
    return {
      ...this.status(),
      inventory: Object.fromEntries(Object.entries(inventoryState).map(([resource, state]) => [
        resource,
        {
          fresh: Boolean(state.updatedAt && Date.now() - state.updatedAt < INVENTORY_TTL_MS),
          updatedAt: isoTimestamp(state.updatedAt),
          error: state.error,
        },
      ])),
      threadShortId: this.threadId ? this.threadId.slice(0, 12) : null,
      skills: this.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        displayName: skill.displayName,
        scope: skill.scope,
      })),
      mcpServers: (restricted ? [] : this.mcpServers).map((server) => ({
        name: server.name,
        authStatus: server.authStatus,
        runtimeStatus: server.runtimeStatus ?? null,
        toolsUnavailable: server.toolsUnavailable === true,
        tools: server.tools
          .filter((tool) => isAllowedTradingViewInventoryTool(server, tool, this.readOnlyGuard.tradingViewTools))
          .filter((tool) => !isGuardedBrokerageWriteTool(
            server,
            tool,
            guardedServerNames,
          ))
          .map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          })),
      })),
      apps: (restricted ? [] : this.apps).map((app) => ({
        id: app.id,
        name: app.name,
        description: app.description,
      })),
      readOnlyGuard: {
        ready: this.status().readOnlyGuardReady,
        diagnostic: this.status().readOnlyGuardDiagnostic,
        scope: "Recognized brokerage transactions, official TradingView query allowlists and explicit transaction approvals",
        limitations: ["Not a universal shell, file, network or credential sandbox", "Unknown transaction capabilities fail closed at inventory validation"],
        blockedTools: this.readOnlyGuard.blockedTools.map((tool) => ({
          server: tool.server,
          tool: tool.tool,
        })),
        blockedApps: this.readOnlyGuard.blockedApps.map((app) => ({
          id: app.id,
          name: app.name,
        })),
        verificationBasis: "upstream_cold_thread_configuration_receipt_and_raw_catalog_scan",
        configurationReceipt: receipt ? { generation: receipt.generation, revision: receipt.revision,
          origin: receipt.origin, configHash: receipt.configHash } : null,
        rawResidualTools: proof?.rawResidualTools ?? [],
        configuredAppDenials: proof?.configuredAppDenials ?? [],
        configuredMcpDenials: proof?.configuredMcpDenials ?? [],
        residualTools: proof?.residualTools ?? this.readOnlyGuard.residualTools,
        residualApps: this.readOnlyGuard.residualApps,
      },
      commands: agentCommands(),
    };
  }

  async listSessions() {
    await this.#ensureStarted();
    // Session browsing is a local metadata operation. App Server recency is
    // reconciled on exact open/retention paths; querying thread/list here made
    // every dropdown/history render wait on the server as the list grew.
    const registry = await this.#loadOwnedThreadRegistry();
    const cutoffMs = Date.now() - HISTORY_RETENTION_MS;
    const sessions = registry.threads
      .filter((entry) => !entry.archivedAt && entry.cwd === this.workspaceDirectory)
      .filter((entry) => !entry.reviewQuarantine)
      .map((entry) => {
        const session = normalizeSessionMetadata(
          entry,
          null,
          this.threadId,
        );
        const runtime = this.activeTurns.get(session.id);
        const pendingOperationId = this.pendingOperations.get(session.id) ?? null;
        return {
          ...session,
          runState: runtime || pendingOperationId ? "running" : "idle",
          operationId: runtime?.operationId ?? pendingOperationId,
        };
      })
      .filter((session) => session.current
        || session.updatedAt == null
        || timestampMs(session.updatedAt) >= cutoffMs)
      .sort((left, right) => {
        if (left.current !== right.current) return left.current ? -1 : 1;
        return timestampMs(right.updatedAt) - timestampMs(left.updatedAt);
      });
    return {
      retentionDays: HISTORY_RETENTION_DAYS,
      currentThreadId: this.threadId,
      sessions,
    };
  }

  async createSession({ name = null, toolMode = "auto" } = {}) {
    // thread/start is already isolated by the App Server. Do not serialize it
    // behind an unrelated open/switch transition: different conversations can
    // be provisioned while other threads continue running.
    if (!["auto", "full", "restricted"].includes(toolMode)) throw new CodexWorkspaceError("configuration", "研究工具模式无效。");
    const hadThread = Boolean(this.rpc?.ready && this.threadId);
    await this.#ensureStarted({ toolMode });
    if (!hadThread && toolMode !== "auto" && this.threadBrokerConfigReceipts.get(this.threadId)?.origin === "start") {
      if (normalizeSessionName(name)) {
        this.threadMetadata.name = normalizeSessionName(name);
        await this.store?.set?.(THREAD_STORE_KEY, this.threadMetadata);
        await this.#registerOwnedThread(this.threadMetadata);
        this.rpc.request("thread/name/set", { threadId: this.threadId, name: this.threadMetadata.name }).catch(() => {});
      }
      return activeSessionResponse(this.threadMetadata);
    }
    const selectedToolMode = toolMode === "auto" ? this.threadMetadata?.toolMode ?? "full" : toolMode;
    if (selectedToolMode === "restricted") await this.#prepareRestrictedFeatures();
    else await this.#discoverBrokerAppPolicy();
    const configuration = this.#captureBrokerThreadConfiguration(selectedToolMode);
    const sessionName = normalizeSessionName(name) ?? defaultSessionName();
    const response = await this.rpc.request("thread/start", {
        cwd: this.workspaceDirectory,
        ephemeral: false,
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "danger-full-access",
        config: configuration.config,
        serviceName: "trading_cockpit",
        dynamicTools: cockpitDynamicTools(),
      });
    const threadId = String(response?.thread?.id ?? "");
    if (!threadId) throw new CodexWorkspaceError("protocol", "Codex 没有返回新会话线程 ID。");
    if (response.thread?.ephemeral === true) {
      throw new CodexWorkspaceError("protocol", "Codex 返回了临时线程，已拒绝创建交易驾驶舱会话。");
    }
    this.#recordBrokerThreadConfiguration(threadId, configuration, "start");
    await this.#activateThread(response, {
        expectedThreadId: threadId,
        name: sessionName,
        preview: "",
        toolMode: selectedToolMode,
        deferPersistence: true,
      });
    // A provisional title has no value to the native history. The first real
    // user task will replace it with a concise summary. Custom caller titles
    // still sync, but never delay showing the newly created conversation.
    if (!isProvisionalSessionName(sessionName)) {
      this.rpc.request("thread/name/set", { threadId, name: sessionName }).catch((error) => {
        notify(this.onStatus, {
          phase: "codex_session_name_warning",
          message: `新会话已创建，但 Codex 标题暂未同步：${cleanError(error)}`,
        });
      });
    }
    this.refreshInventory({ threadId }).catch((error) => notify(this.onStatus, {
        phase: "codex_inventory_warning",
        threadId,
        message: `新会话已可用，能力清单稍后刷新：${cleanError(error)}`,
      }));
    notify(this.onStatus, {
        phase: "codex_session_created",
        message: `已创建并切换到 Codex 会话「${sessionName}」`,
      });
    this.#archiveExpiredHistory().catch((error) => notify(this.onStatus, {
        phase: "codex_history_warning",
        message: `30 天历史归档暂未完成：${cleanError(error)}`,
      }));
    return activeSessionResponse(this.threadMetadata);
  }

  async switchSession(threadId) {
    this.#beginSessionTransition();
    try {
      await this.#ensureStarted();
      const targetThreadId = String(threadId ?? "").trim();
      if (!targetThreadId) {
        throw new CodexWorkspaceError("session", "请选择要切换的 Codex 会话。");
      }
      if (this.quarantinedReviewThreads.has(targetThreadId)) {
        throw new CodexWorkspaceError(
          "review_thread_quarantine",
          "该盲态复盘对话已因外部工具污染永久隔离；请新建复盘对话。",
        );
      }
      if (targetThreadId === String(this.threadId ?? "")) {
        return activeSessionResponse(this.threadMetadata);
      }
      const registry = await this.#loadOwnedThreadRegistry();
      const owned = registry.threads.find((entry) => entry.threadId === targetThreadId);
      if (owned?.reviewQuarantine) {
        this.quarantinedReviewThreads.set(targetThreadId, owned.reviewQuarantine);
        throw new CodexWorkspaceError(
          "review_thread_quarantine",
          "该盲态复盘对话已因外部工具污染永久隔离；请新建复盘对话。",
        );
      }
      if (!owned || owned.archivedAt || owned.cwd !== this.workspaceDirectory) {
        throw new CodexWorkspaceError(
          "session",
          "拒绝切换：该线程不属于交易驾驶舱，或已超过 30 天并归档。",
        );
      }
      if (this.activeTurns.has(targetThreadId) || this.pendingOperations.has(targetThreadId)) {
        // The target is already loaded by the one shared App Server. Selecting
        // it must not issue a second resume while its turn is running.
        await this.#activateThread({
          thread: {
            id: targetThreadId,
            ephemeral: false,
            createdAt: owned.createdAt,
            updatedAt: owned.updatedAt,
          },
          cwd: this.workspaceDirectory,
        }, {
          expectedThreadId: targetThreadId,
          name: owned.name ?? HISTORY_THREAD_NAME,
          preview: owned.preview ?? "",
          reviewBinding: owned.reviewBinding ?? null,
          researchBinding: owned.researchBinding ?? null,
          toolMode: owned.toolMode,
          createdAt: owned.createdAt,
          updatedAt: owned.updatedAt,
        });
        notify(this.onStatus, {
          phase: "codex_session_selected",
          threadId: targetThreadId,
          operationId: this.activeTurns.get(targetThreadId)?.operationId
            ?? this.pendingOperations.get(targetThreadId)
            ?? null,
          message: `已显示正在运行的 Codex 会话「${this.threadMetadata.name}」`,
        });
        return activeSessionResponse(this.threadMetadata);
      }
      this.initialTurnsPages.delete(targetThreadId);
      if (this.threadConfiguring.has(targetThreadId)) {
        throw new CodexWorkspaceError("read_only_guard", "该对话正在核验券商工具隔离配置，请稍后重新打开。");
      }
      this.threadConfiguring.add(targetThreadId);
      this.threadBrokerGuardProofs.delete(targetThreadId);
      let response;
      let configuration;
      let cold = false;
      try {
        cold = await this.#isColdThread(targetThreadId);
        const selectedToolMode = owned.toolMode === "restricted" ? "restricted" : "full";
        if (selectedToolMode === "restricted") await this.#prepareRestrictedFeatures();
        else if (cold) await this.#discoverBrokerAppPolicy();
        configuration = this.#captureBrokerThreadConfiguration(selectedToolMode);
        if (this.activeTurns.has(targetThreadId)) throw new CodexWorkspaceError("busy", "该对话已开始分析，不能重新配置。");
        response = await this.rpc.request("thread/resume", {
          threadId: targetThreadId,
          cwd: this.workspaceDirectory,
          excludeTurns: true,
          initialTurnsPage: {
            limit: 30,
            sortDirection: "desc",
            itemsView: "summary",
          },
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          sandbox: "danger-full-access",
          config: configuration.config,
          dynamicTools: cockpitDynamicTools(),
        });
      } finally {
        this.threadConfiguring.delete(targetThreadId);
        // A resume response may arrive after an inventory read that began
        // against the earlier thread configuration. Do not reuse that proof.
        this.threadBrokerGuardProofs.delete(targetThreadId);
      }
      await this.#activateThread(response, {
        expectedThreadId: targetThreadId,
        name: owned.name ?? HISTORY_THREAD_NAME,
        preview: owned.preview ?? "",
        reviewBinding: owned.reviewBinding ?? null,
        researchBinding: owned.researchBinding ?? null,
        toolMode: owned.toolMode,
        createdAt: owned.createdAt,
        updatedAt: owned.updatedAt,
      });
      this.#recordBrokerThreadConfiguration(targetThreadId, configuration, cold ? "cold_resume" : null);
      this.refreshInventory({ threadId: targetThreadId }).catch((error) => notify(this.onStatus, {
        phase: "codex_inventory_warning",
        threadId: targetThreadId,
        message: `对话已打开，能力清单稍后刷新：${cleanError(error)}`,
      }));
      notify(this.onStatus, {
        phase: "codex_session_switched",
        message: `已切换到 Codex 会话「${this.threadMetadata.name}」`,
      });
      return activeSessionResponse(this.threadMetadata);
    } finally {
      this.sessionTransitionActive = false;
    }
  }

  async openSession(threadId) {
    const session = await this.switchSession(threadId);
    const registry = await this.#loadOwnedThreadRegistry();
    const metadata = registry.threads.find((entry) => entry.threadId === session.id) ?? session;
    const cutoffMs = Date.now() - HISTORY_RETENTION_MS;
    const initialPage = this.initialTurnsPages.get(session.id) ?? null;
    this.initialTurnsPages.delete(session.id);
    if (!initialPage && (this.activeTurns.has(session.id) || this.pendingOperations.has(session.id))) {
      // Do not make switching among concurrent spinners wait on persisted App
      // Server history that is still being written. The encrypted index also
      // contains the pending user message, so a recreated renderer can restore
      // prior context immediately while keeping the live spinner.
      const index = await this.#loadRecentHistoryIndex();
      const cached = index.threads.find((entry) => entry.id === session.id);
      return {
        ...session,
        transcript: cached
          ? historyRecordResponse(cached, {
              includeTurns: true,
              maxBytes: MAX_HISTORY_TEXT_BYTES,
            }).transcript ?? []
          : [],
      };
    }
    let record = initialPage
      ? historyRecordFromTurnsPage(session.id, metadata, initialPage, cutoffMs, this.threadId)
      : null;
    let liveReadSucceeded = Boolean(record);
    if (!record) {
      try {
        record = await this.#readRecentThreadRecord(
          session.id,
          metadata,
          cutoffMs,
          {
            itemsView: "summary",
            maxTurns: 30,
            pageSize: 30,
            timeoutMs: 5_000,
          },
        );
        liveReadSucceeded = true;
      } catch (error) {
        // Opening a conversation must remain responsive even when App Server
        // history hydration is slow. The encrypted local index is a safe
        // fallback; the exact Codex thread has already been resumed above.
        const index = await this.#loadRecentHistoryIndex();
        const cached = index.threads.find((entry) => entry.id === session.id);
        record = cached
          ? mergeHistoryMetadata(cached, normalizeHistoryThread({ ...metadata, id: session.id }, this.threadId))
          : historyRecordFromTurns(
            normalizeHistoryThread({ ...metadata, id: session.id }, this.threadId),
            [],
            { archived: false },
          );
        notify(this.onStatus, {
          phase: "codex_history_warning",
          threadId: session.id,
          message: `已打开原 Codex 对话；历史正文暂用本地缓存：${cleanError(error)}`,
        });
      }
    }
    if (liveReadSucceeded) {
      this.#mergeRecentHistoryRecords([record]).catch((error) => notify(this.onStatus, {
        phase: "codex_history_warning",
        threadId: session.id,
        message: `对话已打开，但本地检索索引稍后补齐：${cleanError(error)}`,
      }));
    }
    return {
      ...session,
      transcript: historyRecordResponse(record, {
        includeTurns: true,
        maxBytes: MAX_HISTORY_TEXT_BYTES,
      }).transcript ?? [],
    };
  }

  #beginSessionTransition() {
    if (this.sessionTransitionActive) {
      throw new CodexWorkspaceError("busy", "Codex 会话正在切换，请稍后再试。");
    }
    this.sessionTransitionActive = true;
  }

  async #activateThread(response, {
    expectedThreadId,
    name,
    preview = "",
    reviewBinding = null,
    researchBinding = null,
    createdAt = null,
    updatedAt = null,
    deferPersistence = false,
    toolMode = "full",
  }) {
    const responseThreadId = String(response?.thread?.id ?? "");
    if (!responseThreadId || responseThreadId !== String(expectedThreadId)) {
      throw new CodexWorkspaceError("protocol", "Codex 恢复了错误的会话线程，已拒绝切换。");
    }
    if (response.thread?.ephemeral === true) {
      throw new CodexWorkspaceError("protocol", "Codex 返回了临时线程，已拒绝切换。");
    }
    if (response.cwd && path.resolve(response.cwd) !== path.resolve(this.workspaceDirectory)) {
      throw new CodexWorkspaceError("protocol", "Codex 返回了其他工作区的线程，已拒绝切换。");
    }
    this.threadId = responseThreadId;
    this.threadMetadata = {
      threadId: responseThreadId,
      cwd: response.cwd ?? this.workspaceDirectory,
      name: normalizeSessionName(name) ?? HISTORY_THREAD_NAME,
      preview: String(preview ?? "").replace(/\s+/g, " ").slice(0, 500),
      model: response.model ?? null,
      modelProvider: response.modelProvider ?? null,
      instructionSources: response.instructionSources ?? [],
      reviewBinding: normalizeReviewThreadBinding(reviewBinding),
      researchBinding: normalizeResearchThreadBinding(researchBinding),
      toolMode: toolMode === "restricted" ? "restricted" : "full",
      createdAt: response.thread?.createdAt ?? createdAt ?? null,
      updatedAt: isoTimestamp(response.thread?.updatedAt)
        ?? isoTimestamp(updatedAt)
        ?? new Date().toISOString(),
    };
    if (response.initialTurnsPage) {
      this.initialTurnsPages.set(responseThreadId, response.initialTurnsPage);
    }
    if (deferPersistence) {
      this.#registerOwnedThread(this.threadMetadata).catch((error) => notify(this.onStatus, {
        phase: "codex_history_warning",
        threadId: responseThreadId,
        message: `新对话已可用；本地会话索引稍后补齐：${cleanError(error)}`,
      }));
      this.store?.set?.(THREAD_STORE_KEY, this.threadMetadata).catch((error) => notify(this.onStatus, {
        phase: "codex_history_warning",
        threadId: responseThreadId,
        message: `新对话已可用；活动指针稍后保存：${cleanError(error)}`,
      }));
    } else {
      await this.store?.set?.(THREAD_STORE_KEY, this.threadMetadata);
      await this.#registerOwnedThread(this.threadMetadata);
    }
  }

  async recentHistory({ query = "", limit = 20, includeTurns = false } = {}) {
    await this.#ensureStarted();
    const startedAt = Date.now();
    const deadlineAt = startedAt + HISTORY_QUERY_DEADLINE_MS;
    const cutoffMs = Date.now() - HISTORY_RETENTION_MS;
    const normalizedQuery = String(query ?? "").trim().toLowerCase();
    const selectedLimit = clampInteger(limit, 1, MAX_HISTORY_THREADS);
    let partial = false;
    const partialReasons = new Set();
    let listingPartial = false;
    const [liveOutcome, indexOutcome] = await Promise.allSettled([
      withOverallDeadline(this.#listCockpitThreads({
        deadlineAt,
        onPartial: () => { listingPartial = true; },
      }), deadlineAt, "Codex 会话元数据查询"),
      withOverallDeadline(this.#loadRecentHistoryIndex(), deadlineAt, "Codex 历史索引查询"),
    ]);
    const liveThreads = liveOutcome.status === "fulfilled" ? liveOutcome.value : [];
    const index = indexOutcome.status === "fulfilled"
      ? indexOutcome.value
      : normalizeRecentHistoryIndex(null);
    if (liveOutcome.status === "rejected" || listingPartial) {
      partial = true;
      partialReasons.add("metadata_deadline_or_error");
    }
    if (indexOutcome.status === "rejected") {
      partial = true;
      partialReasons.add("local_index_unavailable");
    }
    const records = new Map(
      index.threads
        .map((thread) => pruneHistoryRecord(thread, cutoffMs))
        .filter((thread) => thread.turns.length > 0)
        .map((thread) => [thread.id, thread]),
    );
    let hydratedThreadCount = 0;
    const liveMetadata = liveThreads
      .map((thread) => normalizeHistoryThread(thread, this.threadId))
      .filter((thread) => thread.id && thread.recencyMs >= cutoffMs)
      .sort((left, right) => right.recencyMs - left.recencyMs);
    for (const metadata of liveMetadata) {
      records.set(metadata.id, mergeHistoryMetadata(records.get(metadata.id), metadata));
    }

    if (includeTurns || normalizedQuery) {
      const directMatches = liveMetadata.filter((thread) => {
        if (!normalizedQuery) return true;
        return historyRecordText(records.get(thread.id) ?? thread).includes(normalizedQuery);
      });
      const discoveryCandidates = normalizedQuery
        ? liveMetadata.filter((thread) => !directMatches.some((item) => item.id === thread.id)
          && historyRecordNeedsHydration(records.get(thread.id), thread, true))
        : [];
      const eligible = [...directMatches, ...discoveryCandidates]
        .filter((thread, indexValue, values) => values.findIndex((item) => item.id === thread.id) === indexValue)
        .filter((thread) => historyRecordNeedsHydration(records.get(thread.id), thread, Boolean(normalizedQuery)));
      const desiredCandidateCount = normalizedQuery
        ? MAX_HISTORY_HYDRATION_CANDIDATES
        : Math.min(MAX_HISTORY_HYDRATION_CANDIDATES, Math.max(8, selectedLimit * 2));
      const hydrationCandidates = eligible.slice(0, desiredCandidateCount);
      if (eligible.length > hydrationCandidates.length) {
        partial = true;
        partialReasons.add("candidate_limit");
      }
      let hydrationFailures = 0;
      const hydrated = await mapWithConcurrency(hydrationCandidates, 4, async (thread) => {
        if (Date.now() >= deadlineAt) {
          hydrationFailures += 1;
          return null;
        }
        try {
          return await withOverallDeadline(this.#readRecentThreadRecord(thread.id, thread, cutoffMs, {
            itemsView: normalizedQuery ? "full" : "summary",
            query: normalizedQuery,
            timeoutMs: Math.max(250, Math.min(
              HISTORY_HYDRATION_TIMEOUT_MS,
              deadlineAt - Date.now(),
            )),
            deadlineAt,
          }), deadlineAt, `Codex 会话 ${thread.id} 历史读取`);
        } catch (error) {
          hydrationFailures += 1;
          notify(this.onStatus, {
            phase: "codex_history_warning",
            message: `最近历史暂未读全：${cleanError(error)}`,
          });
          return null;
        }
      });
      const available = hydrated.filter(Boolean);
      hydratedThreadCount = available.length;
      if (hydrationFailures) {
        partial = true;
        partialReasons.add(Date.now() >= deadlineAt ? "overall_deadline" : "thread_hydration_error");
      }
      for (const record of available) {
        records.set(record.id, mergeHistoryRecords(records.get(record.id), record));
      }
      // Search-centered excerpts must not replace the canonical prefix index.
      const canonicalRecords = available.filter(record => !record.turns.some(turn => turn.entries.some(entry => entry.excerptStart > 0)));
      if (canonicalRecords.length) this.#mergeRecentHistoryRecords(canonicalRecords).catch(() => {});
    }

    if ((includeTurns || normalizedQuery) && [...records.values()].some(record => historyRecordIsPartial(record, Boolean(normalizedQuery)))) {
      partial = true;
      partialReasons.add("history_content_incomplete");
    }
    if ((includeTurns || normalizedQuery) && [...records.values()].some(record => record.coverage?.undatedTurnCount > 0)) {
      partial = true;
      partialReasons.add("undated_turns_excluded");
    }

    const matching = [...records.values()]
      .map((record) => pruneHistoryRecord(record, cutoffMs))
      .filter((record) => record.turns.length > 0 || record.recencyMs >= cutoffMs)
      .filter((record) => !normalizedQuery || historyRecordText(record).includes(normalizedQuery))
      .sort((left, right) => right.recencyMs - left.recencyMs);
    const selected = matching.slice(0, selectedLimit);
    const responseBudget = Math.floor(MAX_HISTORY_TEXT_BYTES / Math.max(1, selected.length));
    return {
      retentionDays: HISTORY_RETENTION_DAYS,
      partial,
      partialReasons: [...partialReasons],
      candidateThreadCount: liveMetadata.length,
      hydratedThreadCount,
      requestedContentView: normalizedQuery ? "full_text_search" : includeTurns ? "summary" : "metadata",
      elapsedMs: Date.now() - startedAt,
      threads: selected.map((record) => historyRecordResponse(record, {
        includeTurns,
        query: normalizedQuery,
        maxBytes: responseBudget,
      })),
    };
  }

  async #readThreadActivityMs(threadId) {
    let exactReadError = null;
    try {
      const result = await this.rpc.request("thread/read", {
        threadId,
        includeTurns: false,
      });
      const thread = result?.thread;
      if (thread && String(thread.id ?? "") === String(threadId)) {
        const exactActivityMs = timestampMs(
          thread.recencyAt ?? thread.updatedAt ?? thread.createdAt,
        );
        if (exactActivityMs > 0) return exactActivityMs;
      }
    } catch (error) {
      exactReadError = error;
    }
    try {
      const liveThreads = await this.#listCockpitThreads();
      const thread = liveThreads.find((entry) => String(entry.id ?? "") === String(threadId));
      return timestampMs(thread?.recencyAt ?? thread?.updatedAt ?? thread?.createdAt);
    } catch (error) {
      throw exactReadError ?? error;
    }
  }

  async #listCockpitThreads({ deadlineAt = Number.POSITIVE_INFINITY, onPartial = () => {} } = {}) {
    const registry = await this.#loadOwnedThreadRegistry();
    const ownedIds = new Set(registry.threads.map((thread) => thread.threadId));
    if (!ownedIds.size) return [];
    const threads = [];
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        onPartial();
        break;
      }
      const result = await this.rpc.request("thread/list", {
        cursor,
        limit: 100,
        sortKey: "recency_at",
        sortDirection: "desc",
        sourceKinds: ["appServer", "vscode", "cli", "exec", "unknown"],
        archived: false,
        cwd: [this.workspaceDirectory],
        useStateDbOnly: true,
      }, { timeoutMs: Math.max(250, Math.min(RPC_REQUEST_TIMEOUT_MS, remainingMs)) });
      const data = Array.isArray(result?.data) ? result.data : [];
      // Ownership is established only by the encrypted app registry. A user
      // thread with the same name or cwd must never be exposed to this app.
      threads.push(...data.filter((thread) => ownedIds.has(String(thread?.id ?? ""))));
      cursor = result?.nextCursor ?? null;
      if (!cursor) break;
      if (page === 9) onPartial();
    }
    return threads;
  }

  async #archiveExpiredHistory() {
    const cutoff = Date.now() - HISTORY_RETENTION_MS;
    const threads = await this.#listCockpitThreads();
    const activeThreadIds = new Set([this.threadId, ...this.activeTurns.keys()].filter(Boolean));
    const expired = threads.filter((thread) => !activeThreadIds.has(String(thread.id))
      && timestampMs(thread.recencyAt ?? thread.updatedAt ?? thread.createdAt) < cutoff);
    let archived = 0;
    for (const thread of expired) {
      try {
        await this.#snapshotThreadRecentHistory(thread.id, thread);
        await this.rpc.request("thread/archive", { threadId: thread.id });
        await this.#markOwnedThreadArchived(thread.id);
        archived += 1;
      } catch (error) {
        // Keep the live thread visible if its encrypted active-history snapshot
        // could not be secured. Native archive remains a recoverable backup.
        notify(this.onStatus, {
          phase: "codex_history_warning",
          message: `Codex 对话尚未归档，原始线程仍保留：${cleanError(error)}`,
        });
      }
    }
    if (archived) {
      notify(this.onStatus, {
        phase: "codex_history_archived",
        message: `${archived} 个超过 30 天的 Codex 对话已归档（可恢复），并从最近历史中隐藏`,
      });
    }
    return archived;
  }

  async #executeDynamicTool(params) {
    const callerThreadId = String(params?.threadId ?? "").trim();
    const callerMetadata = await this.#ownedThreadMetadata(callerThreadId).catch(() => {
      throw new CodexWorkspaceError("tool", "拒绝从非交易驾驶舱线程查询近期对话。");
    });
    const activeRuntime = this.activeTurns.get(callerThreadId);
    const persistedBinding = normalizeReviewThreadBinding(callerMetadata?.reviewBinding);
    if (activeRuntime?.reviewPhase === "blind"
      || (persistedBinding?.protocol === "decision_cycle" && persistedBinding.phase === "blind")) {
      throw new CodexWorkspaceError(
        "blind_time_firewall",
        "阶段一盲态复盘已禁用近期对话查询；不得通过历史对话读取截止点之后的信息。",
      );
    }
    if (params?.tool !== "query_recent_history") {
      throw new CodexWorkspaceError("tool", `Unknown cockpit dynamic tool: ${params?.tool}`);
    }
    const args = normalizeDynamicToolArguments(params.arguments);
    const query = String(args.query ?? "").slice(0, 200);
    const limit = clampInteger(args.limit ?? 8, 1, 12);
    const history = await this.recentHistory({ query, limit, includeTurns: true });
    return {
      success: true,
      contentItems: [{
        type: "inputText",
        text: JSON.stringify(history),
      }],
    };
  }

  async #readRecentThreadRecord(
    threadId,
    metadata = {},
    cutoffMs = Date.now() - HISTORY_RETENTION_MS,
    {
      itemsView = "summary",
      maxTurns = MAX_HISTORY_TURNS_PER_THREAD,
      pageSize = 100,
      timeoutMs = RPC_REQUEST_TIMEOUT_MS,
      deadlineAt = Number.POSITIVE_INFINITY,
      query = "",
    } = {},
  ) {
    const turns = [];
    let cursor = null;
    let reachedBoundary = false;
    let undatedTurnCount = 0;
    for (let page = 0; page < 20 && turns.length < maxTurns; page += 1) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) break;
      const result = await this.rpc.request("thread/turns/list", {
        threadId,
        cursor,
        limit: Math.min(pageSize, maxTurns - turns.length),
        sortDirection: "desc",
        itemsView,
      }, { timeoutMs: Math.max(250, Math.min(timeoutMs, remainingMs)) });
      const data = Array.isArray(result?.data) ? result.data : [];
      let crossedCutoff = false;
      for (const turn of data) {
        const turnMs = historyTurnTimestampMs(turn);
        if (turnMs <= 0) { undatedTurnCount++; continue; }
        if (turnMs > 0 && turnMs < cutoffMs) {
          crossedCutoff = true;
          continue;
        }
        const normalized = normalizeHistoryTurn(turn, cutoffMs, { query });
        if (normalized) turns.push(normalized);
      }
      cursor = result?.nextCursor ?? null;
      if (!cursor || crossedCutoff) { reachedBoundary = true; break; }
      if (data.length === 0) break;
    }
    const base = normalizeHistoryThread({ ...metadata, id: threadId }, this.threadId);
    return historyRecordFromTurns(base, turns, {
      archived: Boolean(metadata?.archived),
      coverage: { schemaVersion: 1, paginationComplete: reachedBoundary,
        rangeComplete: reachedBoundary && undatedTurnCount === 0, itemsView, undatedTurnCount },
    });
  }

  async #snapshotThreadRecentHistory(threadId, metadata = {}) {
    const record = await this.#readRecentThreadRecord(
      threadId,
      metadata,
      Date.now() - HISTORY_RETENTION_MS,
    );
    await this.#mergeRecentHistoryRecords([record]);
    return record;
  }

  async #loadOwnedThreadRegistry() {
    await this.historyMutationQueue;
    return normalizeOwnedThreadRegistry(await this.store?.get?.(THREAD_REGISTRY_STORE_KEY));
  }

  async #registerOwnedThread(metadata) {
    if (!metadata?.threadId) return;
    const cachedPrevious = this.ownedThreadCache.get(String(metadata.threadId));
    const cachedNext = normalizeOwnedThreadRegistry({
      threads: [{
        ...cachedPrevious,
        ...metadata,
        threadId: String(metadata.threadId),
        cwd: String(metadata.cwd ?? cachedPrevious?.cwd ?? this.workspaceDirectory),
        registeredAt: cachedPrevious?.registeredAt ?? new Date().toISOString(),
        archivedAt: null,
      }],
    }).threads[0];
    if (cachedNext) this.ownedThreadCache.set(cachedNext.threadId, cachedNext);
    return this.#queueHistoryMutation(async () => {
      const registry = normalizeOwnedThreadRegistry(
        await this.store?.get?.(THREAD_REGISTRY_STORE_KEY),
      );
      const threadId = String(metadata.threadId);
      const previous = registry.threads.find((entry) => entry.threadId === threadId);
      const next = {
        ...previous,
        threadId,
        cwd: String(metadata.cwd ?? previous?.cwd ?? this.workspaceDirectory),
        name: normalizeSessionName(metadata.name ?? previous?.name) ?? HISTORY_THREAD_NAME,
        preview: String(metadata.preview ?? previous?.preview ?? "")
          .replace(/\s+/g, " ")
          .slice(0, 500),
        createdAt: isoTimestamp(metadata.createdAt ?? previous?.createdAt) ?? previous?.createdAt ?? null,
        updatedAt: isoTimestamp(metadata.updatedAt ?? previous?.updatedAt) ?? new Date().toISOString(),
        registeredAt: previous?.registeredAt ?? new Date().toISOString(),
        archivedAt: null,
        toolMode: metadata.toolMode === "restricted" || metadata.toolMode == null && previous?.toolMode === "restricted" ? "restricted" : "full",
        reviewBinding: normalizeReviewThreadBinding(
          metadata.reviewBinding ?? previous?.reviewBinding,
        ),
        researchBinding: normalizeResearchThreadBinding(
          metadata.researchBinding ?? previous?.researchBinding,
        ),
        reviewQuarantine: normalizeReviewQuarantine(
          metadata.reviewQuarantine ?? previous?.reviewQuarantine,
        ),
      };
      registry.threads = [
        ...registry.threads.filter((entry) => entry.threadId !== threadId),
        next,
      ].slice(-120);
      registry.updatedAt = new Date().toISOString();
      await this.store?.set?.(THREAD_REGISTRY_STORE_KEY, registry);
      this.ownedThreadCache.set(threadId, next);
    });
  }

  async #markOwnedThreadArchived(threadId) {
    return this.#queueHistoryMutation(async () => {
      const archivedAt = new Date().toISOString();
      const registry = normalizeOwnedThreadRegistry(
        await this.store?.get?.(THREAD_REGISTRY_STORE_KEY),
      );
      const entry = registry.threads.find((thread) => thread.threadId === String(threadId));
      if (entry) entry.archivedAt = archivedAt;
      registry.updatedAt = archivedAt;
      await this.store?.set?.(THREAD_REGISTRY_STORE_KEY, registry);
      const index = normalizeRecentHistoryIndex(
        await this.store?.get?.(HISTORY_INDEX_STORE_KEY),
      );
      const record = index.threads.find((thread) => thread.id === String(threadId));
      if (record) {
        record.archived = true;
        record.archivedAt = archivedAt;
        index.updatedAt = archivedAt;
        await this.store?.set?.(HISTORY_INDEX_STORE_KEY, index);
      }
    });
  }

  async #loadRecentHistoryIndex() {
    await this.historyMutationQueue;
    return pruneRecentHistoryIndex(
      normalizeRecentHistoryIndex(await this.store?.get?.(HISTORY_INDEX_STORE_KEY)),
      Date.now() - HISTORY_RETENTION_MS,
    );
  }

  async #mergeRecentHistoryRecords(records) {
    if (!records?.length) return;
    return this.#queueHistoryMutation(async () => {
      const cutoffMs = Date.now() - HISTORY_RETENTION_MS;
      const index = pruneRecentHistoryIndex(
        normalizeRecentHistoryIndex(await this.store?.get?.(HISTORY_INDEX_STORE_KEY)),
        cutoffMs,
      );
      const merged = new Map(index.threads.map((thread) => [thread.id, thread]));
      for (const candidate of records) {
        const record = pruneHistoryRecord(candidate, cutoffMs);
        if (!record.id) continue;
        const previous = merged.get(record.id);
        merged.set(record.id, mergeHistoryRecords(previous, record));
      }
      index.threads = capHistoryIndexRecords([...merged.values()], cutoffMs);
      index.updatedAt = new Date().toISOString();
      await this.store?.set?.(HISTORY_INDEX_STORE_KEY, index);
    });
  }

  #queueHistoryMutation(operation) {
    const next = this.historyMutationQueue.then(operation, operation);
    this.historyMutationQueue = next.catch(() => {});
    return next;
  }

  #assertReadOnlyGuard(threadId = null) {
    const selectedThreadId = threadId ?? this.threadId;
    const receipt = this.threadBrokerConfigReceipts.get(selectedThreadId);
    if (this.#isRestrictedThread(selectedThreadId)) {
      const proof = this.threadBrokerGuardProofs.get(selectedThreadId);
      if (receipt?.toolMode !== "restricted" || receipt.generation !== this.rpcGeneration || proof?.generation !== this.rpcGeneration
        || proof?.configHash !== receipt.configHash || proof?.isolation?.ready !== true
        || this.guardRecheckPromise && (!this.guardRecheckContext?.threadId || this.guardRecheckContext.threadId === selectedThreadId)
        || this.threadConfiguring.has(selectedThreadId) || this.threadBrokerGuardPromises.has(selectedThreadId)) {
        throw new CodexWorkspaceError("read_only_guard", "受限研究的独立工具隔离尚未通过；请查看修复提醒，不会使用普通会话的核验结果。");
      }
      return;
    }
    if (this.guardRecheckPromise || this.guardStartupFailure) {
      throw new CodexWorkspaceError("read_only_guard", "只读隔离正在重新核验或预检未完成；本轮未启动，请查看 Agent 面板的修复提醒。");
    }
    if (threadId && this.threadConfiguring.has(threadId)) {
      throw new CodexWorkspaceError("read_only_guard", "当前对话正在更新工具隔离配置；本轮未启动，请稍后重试。");
    }
    const proof = this.threadBrokerGuardProofs.get(threadId ?? this.threadId);
    if (!proof || proof.generation !== this.rpcGeneration) {
      throw new CodexWorkspaceError(
        "read_only_guard",
        "Codex MCP 工具清单尚未完成只读校验；请刷新能力清单或重启交易驾驶舱后再试。",
      );
    }
    const residual = [
      ...proof.residualTools.map((item) => `${item.server}/${item.tool}`),
      ...this.readOnlyGuard.residualApps.map((item) => `App:${item.name}`),
    ];
    if (residual.length) {
      throw new CodexWorkspaceError(
        "read_only_guard",
        `检测到尚未被线程配置禁用的交易写能力、未核验券商工具或 TradingView 非许可查询工具：${residual.slice(0, 6).join("、")}。本轮未启动；已有对话不会热更新隔离配置，请新建对话或在任务结束后重新连接，再继续使用行情查询、Skills 与研究工具。`,
      );
    }
    if (threadId) {
      if (this.threadBrokerGuardPromises.has(threadId)
        || proof?.revision !== this.brokerAppGuardRevision
        || proof.residualTools.length) {
        throw new CodexWorkspaceError("read_only_guard", "当前对话的券商 App 工具隔离尚未完成回读核验；本轮未启动，请刷新能力清单后重试。");
      }
    }
  }

  async cachePendingUserMessage({ threadId, operationId = null, text = "" }) {
    const targetThreadId = String(threadId ?? "").trim();
    const metadata = await this.#ownedThreadMetadata(targetThreadId);
    const summarizedTitle = isProvisionalSessionName(metadata.name)
      ? summarizeSessionTitle(text)
      : null;
    const activityMetadata = {
      ...metadata,
      threadId: targetThreadId,
      cwd: this.workspaceDirectory,
      ...(summarizedTitle ? { name: summarizedTitle } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (String(this.threadId ?? "") === targetThreadId) {
      this.threadMetadata = { ...this.threadMetadata, ...activityMetadata };
    }
    const normalizedOperationId = String(operationId ?? "").trim();
    if (normalizedOperationId) this.pendingOperations.set(targetThreadId, normalizedOperationId);
    this.initialTurnsPages.delete(targetThreadId);
    const pendingTimestamp = Date.now();
    const pendingHistoryTurn = {
      id: `pending-user-${String(normalizedOperationId || pendingTimestamp).replace(/[^A-Za-z0-9_-]/g, "-")}`,
      startedAt: new Date(pendingTimestamp).toISOString(),
      completedAt: null,
      timestamp: new Date(pendingTimestamp).toISOString(),
      timestampMs: pendingTimestamp,
      entries: [{ role: "user", text: sanitizeHistoryText(text, "user") }],
    };
    // Persisting the crash-recovery index is best effort and must never gate a
    // model turn. This also prevents one slow encrypted write from blocking all
    // conversations that share the same local store.
    (async () => {
      await this.#registerOwnedThread(activityMetadata);
      if (String(this.threadId ?? "") === targetThreadId) {
        await this.store?.set?.(THREAD_STORE_KEY, this.threadMetadata);
      }
      await this.#mergeRecentHistoryRecords([
        historyRecordFromTurns(
          normalizeHistoryThread({ ...activityMetadata, id: targetThreadId }, this.threadId),
          [pendingHistoryTurn],
          { archived: false },
        ),
      ]);
      if (summarizedTitle) {
        await this.rpc?.request?.("thread/name/set", {
          threadId: targetThreadId,
          name: summarizedTitle,
        });
      }
    })().catch((error) => notify(this.onStatus, {
      phase: "codex_history_warning",
      threadId: targetThreadId,
      operationId: normalizedOperationId || null,
      message: `问题已交给 Codex；本地标题或历史索引稍后补齐：${cleanError(error)}`,
    }));
    return {
      threadId: targetThreadId,
      operationId: normalizedOperationId || null,
      title: summarizedTitle,
    };
  }

  clearPendingOperation({ threadId, operationId = null } = {}) {
    const targetThreadId = String(threadId ?? "").trim();
    const currentOperationId = this.pendingOperations.get(targetThreadId);
    if (!currentOperationId) return false;
    if (operationId && String(operationId) !== currentOperationId) return false;
    this.pendingOperations.delete(targetThreadId);
    return true;
  }

  async analyze({ portfolio, run, task, threadId = null, operationId = null, signal = null }) {
    throwIfAborted(signal);
    await this.#ensureStarted();
    throwIfAborted(signal);
    const targetThreadId = String(threadId ?? this.threadId ?? "").trim();
    if (this.analysisRequestsByThread.has(targetThreadId)) {
      throw new CodexWorkspaceError("busy", "该 Codex 对话已有分析正在准备或运行；可新建其他对话并行研究。");
    }
    const requestToken = Symbol("analysis-request");
    this.analysisRequestsByThread.set(targetThreadId, requestToken);
    try {
      return await this.#analyzeOne({ portfolio, run, task, threadId: targetThreadId, operationId, signal });
    } finally {
      if (this.analysisRequestsByThread.get(targetThreadId) === requestToken) this.analysisRequestsByThread.delete(targetThreadId);
    }
  }

  async #analyzeOne({ portfolio, run, task, threadId = null, operationId = null, signal = null }) {
    throwIfAborted(signal);
    await this.#ensureStarted();
    throwIfAborted(signal);
    const analysisThreadId = String(threadId ?? this.threadId ?? "").trim();
    let analysisThreadMetadata = await this.#ownedThreadMetadata(analysisThreadId);
    await this.#assertRemoteTurnSettled(analysisThreadId);
    if (this.activeTurns.has(analysisThreadId)) {
      throw new CodexWorkspaceError("busy", "该 Codex 对话已有一轮分析正在运行。");
    }
    const expandedTask = expandAgentCommand(task);
    const evidence = buildCodexEvidence({ portfolio, run, task: expandedTask });
    analysisThreadMetadata = await this.#bindAnalysisThreadContext(
      analysisThreadMetadata,
      evidence,
    );
    const normalizedOperationId = String(operationId ?? "").trim();
    if (this.pendingOperations.get(analysisThreadId) !== normalizedOperationId) {
      await this.cachePendingUserMessage({
        threadId: analysisThreadId,
        operationId: normalizedOperationId,
        text: task,
      });
    }
    // Any bootstrap page predates the turn that is about to start. Do not let
    // a later reopen mistake it for a complete, current transcript.
    this.initialTurnsPages.delete(analysisThreadId);
    // Only the brokerage read-only guard and local Skill discovery gate a
    // turn. Optional App/connector inventory continues in the background and
    // cannot head-of-line block every conversation.
    const restricted = this.#isRestrictedThread(analysisThreadId);
    if (!restricted && !this.readOnlyGuard.inventoryVerified && this.guardPromise) {
      await this.guardPromise;
    }
    if (this.skillsPromise && (evidence.analysisScope !== "chat" || /(?:^|\s)\$/.test(task))) await this.skillsPromise;
    if (!restricted && !this.readOnlyGuard.inventoryVerified) {
      await this.refreshInventory({ threadId: analysisThreadId });
    }
    // Raw catalogs may change independently of the 10-minute UI cache. Every
    // new turn scans its own thread, so newly exposed write names fail closed.
    // Restricted threads have an independent cold configuration and a strict
    // zero-external-tools proof. Do not re-couple every plain message to the
    // failing global catalogue; explicit recheck still reads a fresh snapshot.
    const isolatedProof = this.threadBrokerGuardProofs.get(analysisThreadId);
    if (!restricted || isolatedProof?.generation !== this.rpcGeneration || !isolatedProof?.isolation?.ready) await this.#verifyThreadBrokerGuard({ threadId: analysisThreadId }).catch(error => {
        if (error?.kind === "read_only_guard") throw error;
        throw new CodexWorkspaceError("read_only_guard", `当前对话的券商 App 工具隔离回读失败；本轮未启动：${cleanError(error)}`, { cause: error });
    });
    throwIfAborted(signal);
    this.#assertReadOnlyGuard(analysisThreadId);
    const startedAt = Date.now();
    const prompt = buildWorkspacePrompt(evidence);
    const researchMode = { kind: restricted ? "restricted" : "full", externalToolsAvailable: !restricted };
    const requestedSkills = analysisSkillsForScope(
      task,
      this.skills,
      evidence.analysisScope,
      evidence?.context?.reviewProtocol,
    );
    const requiredReviewSkill = requiredReviewSkillName(evidence);
    if (requiredReviewSkill
      && !requestedSkills.some((skill) => skill.name === requiredReviewSkill)) {
      throw new CodexWorkspaceError(
        "review_skill_missing",
        `复盘所需 Skill「${requiredReviewSkill}」未安装或未被 Codex 发现；本轮已停止，避免退化为无协议的普通分析。`,
      );
    }
    const skillVersionsCapturedAt = new Date().toISOString();
    const actualSkillVersions = await this.fingerprintSkills(requestedSkills);
    evidence.project = {
      ...evidence.project,
      skillVersions: actualSkillVersions.map(compactSkillVersion),
      skillVersionBoundary: "host_pre_turn_snapshot_not_server_read_attestation",
    };
    // A blind replay receives no connector/App mentions at the request layer;
    // the event firewall remains the fail-closed backstop for configured MCPs.
    const requestedApps = restricted || evidence.analysisScope === "review"
      && evidence?.context?.reviewProtocol === "decision_cycle"
      && evidence?.context?.reviewPhase === "blind"
      ? []
      : findRequestedApps(task, this.apps);
    const modePrompt = restricted ? `${prompt}\n\n本持久对话处于受限研究模式：外部 MCP、Apps 与插件工具已经在原生冷启动配置层关闭。不得声称已调用这些工具，不要通过 Shell/网络改走同一券商接口。仍可使用本地可用 Skills、原生网页研究、文件计算、query_recent_history 和宿主已交付的只读证据。某项当前数据缺失时如实说明，继续回答能够有证据支持的部分。` : prompt;
    const additionalContext = buildWorkspaceAdditionalContext(evidence, modePrompt);
    const contextDiagnostics = workspaceContextDiagnostics(additionalContext);
    const input = [
      // Keep the persisted user message clean so native history and title
      // generation see the user's request, not the cockpit's internal policy.
      { type: "text", text: expandedTask },
      ...requestedSkills.map((skill) => ({
        type: "skill",
        name: skill.name,
        path: skill.path,
      })),
      ...requestedApps.map((app) => ({
        type: "mention",
        name: app.name,
        path: `app://${app.id}`,
      })),
    ];
    await this.#compactBeforeTurnIfNeeded({
      threadId: analysisThreadId,
      operationId: normalizedOperationId || null,
      signal,
      estimatedInputTokens: estimateTurnInputTokens({
        contextDiagnostics,
        task: expandedTask,
        skillCount: requestedSkills.length,
      }),
    });
    const toolEvents = [];
    const runtime = {
      threadId: analysisThreadId,
      generation: this.rpcGeneration,
      operationId: String(operationId ?? "").trim() || null,
      turnId: "pending",
      completion: deferred(),
      preStartCompletion: deferred(),
      pendingNotifications: [],
      cancelRequested: false,
      startedAt,
      firstActivityAt: null,
      lastActivityAt: startedAt,
      toolEvents,
      agentMessages: new Map(),
      agentMessageOrder: [],
      streamedCompletedMessageIds: new Set(),
      finalPreviewText: "",
      fullHistoryRecovered: false,
      historyRecovery: null,
      historyRecoveryPromise: null,
      terminalSource: null,
      analysisScope: evidence.analysisScope,
      researchMode,
      reviewProtocol: evidence?.context?.reviewProtocol ?? null,
      reviewPhase: evidence?.context?.reviewPhase ?? null,
      ledgerRevision: 0,
      heartbeatTimer: null,
      reconcileTimer: null,
      reconcilePromise: null,
      reconcileTransportFailures: 0,
      reconcileTransportTerminal: false,
      finalReconcileTimer: null,
      finalStatusTimer: null,
      quarantinePersistPromise: null,
      remoteTerminationConfirmed: false,
    };
    // Evidence/Skill preparation above can yield while a new tool inventory
    // changes the policy. Recheck immediately before reserving/starting a turn.
    this.#assertReadOnlyGuard(analysisThreadId);
    if (this.activeTurns.has(analysisThreadId)) {
      throw new CodexWorkspaceError("busy", "该 Codex 对话已有一轮分析正在运行。");
    }
    this.activeTurns.set(analysisThreadId, runtime);
    this.clearPendingOperation({ threadId: analysisThreadId, operationId: normalizedOperationId });
    notify(this.onStatus, {
      phase: "codex_turn_start",
      threadId: analysisThreadId,
      operationId: runtime.operationId,
      message: restricted ? "正在持久受限研究对话中分析；外部 MCP / Apps 保持关闭，本地 Skills、网页与文件研究可用。" : "正在持久 Codex 项目线程中分析；Skills、MCP 与项目配置均已启用",
    });
    this.#startTurnHeartbeat(runtime);
    let completed;
    try {
      const rpc = this.rpc;
      throwIfAborted(signal);
      const startRequest = rpc.request("turn/start", {
        threadId: analysisThreadId,
        ...(runtime.operationId ? { clientUserMessageId: runtime.operationId } : {}),
        cwd: this.workspaceDirectory,
        input,
        ...(evidence.analysisScope === "candidate"
          ? { outputSchema: candidateWorkspaceOutputSchema() }
          : supportsReviewLearningProposal(evidence)
            ? { outputSchema: reviewLearningWorkspaceOutputSchema() }
            : supportsResearchProposal(evidence)
              ? { outputSchema: researchProposalOutputSchema() }
              : {}),
        additionalContext,
      });
      const startOutcome = await Promise.race([
        startRequest.then(
          (started) => ({ kind: "started", started }),
          (error) => ({ kind: "failed", error }),
        ),
        runtime.preStartCompletion.promise.then((turn) => ({ kind: "terminal", turn })),
        // Reconciled remote terminal state can beat a lost turn/start response.
        runtime.completion.promise.then((turn) => ({ kind: "terminal", turn })),
      ]);
      if (startOutcome.kind === "failed" && runtime.turnId !== "pending") {
        // A transport timeout can lose the turn/start response even though the
        // App Server already announced the concrete turn through item events.
        // Once that ID is adopted, persisted turn state is authoritative.
        this.additionalContextContract = verifiedAdditionalContextContract();
        completed = await runtime.completion.promise;
      } else if (startOutcome.kind === "failed") {
        if (isAdditionalContextContractFailure(startOutcome.error)) {
          const contractError = createAdditionalContextContractError(startOutcome.error);
          this.additionalContextContract = {
            mode: "experimental_required_fail_closed",
            status: "unsupported",
            error: contractError.message,
          };
          notify(this.onStatus, {
            phase: "codex_context_protocol_error",
            threadId: analysisThreadId,
            operationId: runtime.operationId,
            message: contractError.message,
          });
          throw contractError;
        }
        throw startOutcome.error;
      } else if (startOutcome.kind === "terminal") {
        this.additionalContextContract = verifiedAdditionalContextContract();
        completed = startOutcome.turn;
        const terminalTurnId = String(completed?.id ?? runtime.turnId ?? "");
        if (terminalTurnId && terminalTurnId !== "pending") runtime.turnId = terminalTurnId;
        this.#mergeRecoveredTurn(runtime, completed);
        for (const message of runtime.pendingNotifications.splice(0)) {
          if (!terminalTurnId || notificationTurnId(message) === terminalTurnId) {
            this.#handleNotification(message);
          }
        }
        // The App Server can still accept the turn after local cancellation won
        // the race. Keep a rejection handler attached and interrupt that exact
        // late turn so it cannot continue consuming tools in the background.
        if (completed.status === "interrupted") {
          startRequest.then((lateStarted) => {
            const lateTurnId = lateStarted?.turn?.id;
            if (!lateTurnId) return null;
            const abandoned = this.abandonedTurns.get(analysisThreadId);
            if (abandoned?.runtime === runtime) abandoned.turnId = String(lateTurnId);
            return rpc.request("turn/interrupt", {
              threadId: analysisThreadId,
              turnId: lateTurnId,
            }, { timeoutMs: TURN_RECONCILE_REQUEST_TIMEOUT_MS });
          }).catch((error) => notify(this.onStatus, {
            phase: "codex_warning",
            threadId: analysisThreadId,
            operationId: runtime.operationId,
            message: `Codex 迟到 turn 的取消确认未返回；本地任务已经结束：${cleanError(error)}`,
          }));
        }
      } else {
        const turnId = startOutcome.started?.turn?.id;
        if (!turnId) throw new CodexWorkspaceError("protocol", "Codex 没有返回 turn ID。");
        this.additionalContextContract = verifiedAdditionalContextContract();
        if (runtime.turnId !== "pending" && runtime.turnId !== String(turnId)) {
          throw new CodexWorkspaceError("protocol", "Codex turn/start 与流式事件返回了不同的 turn ID。");
        }
        runtime.turnId = String(turnId);
        this.#startTurnReconciler(runtime);
        for (const message of runtime.pendingNotifications.splice(0)) {
          if (notificationTurnId(message) === String(turnId)) this.#handleNotification(message);
        }
        if (runtime.cancelRequested) {
          runtime.completion.resolve({ id: turnId, status: "interrupted", items: [] });
          rpc.request("turn/interrupt", {
            threadId: analysisThreadId,
            turnId,
          }, { timeoutMs: TURN_RECONCILE_REQUEST_TIMEOUT_MS }).catch((error) => notify(this.onStatus, {
            phase: "codex_warning",
            threadId: analysisThreadId,
            operationId: runtime.operationId,
            message: `Codex 远端取消确认未返回；本地任务已经结束：${cleanError(error)}`,
          }));
        }
        completed = await runtime.completion.promise;
      }
    } finally {
      if (runtime.generation === this.rpcGeneration) this.#rememberSettledTurn(analysisThreadId, runtime.turnId);
      this.#stopTurnHeartbeat(runtime);
      this.#stopTurnReconciler(runtime);
      if (runtime.quarantinePersistPromise) {
        await runtime.quarantinePersistPromise.catch((error) => notify(this.onStatus, {
          phase: "codex_history_warning",
          threadId: runtime.threadId,
          operationId: runtime.operationId,
          message: `盲态复盘线程已在内存中隔离；持久隔离标记稍后重试：${cleanError(error)}`,
        }));
      }
      if (this.activeTurns.get(analysisThreadId) === runtime) {
        this.activeTurns.delete(analysisThreadId);
      }
    }
    if (completed.status !== "completed") {
      if (runtime.deliveryFailure) throw runtime.deliveryFailure;
      throw new CodexWorkspaceError(
        runtime.policyViolation ? "blind_time_firewall"
          : completed.status === "interrupted" ? "cancelled" : "runtime",
        runtime.policyViolation
          ? runtime.policyViolation
          : completed.status === "interrupted"
          ? "Codex 分析已取消；持久线程与历史记录仍保留。"
          : cleanError(completed.error?.message ?? completed.error ?? "Codex turn failed."),
      );
    }
    this.#mergeRecoveredTurn(runtime, completed);
    if (!runtime.fullHistoryRecovered && !runtime.historyRecovery) {
      try {
        const persisted = await this.#recoverTurnHistory(runtime, completed.id);
        if (persisted.items.length) {
          completed = { ...completed, items: persisted.items };
          runtime.fullHistoryRecovered = persisted.complete;
          this.#mergeRecoveredTurn(runtime, completed, { authoritativeItemOrder: true });
        }
      } catch {
        // A completed streamed answer remains a valid compatibility fallback
        // when the active thread store cannot page persisted items.
      }
    }
    if (runtime.policyViolation) {
      if (runtime.quarantinePersistPromise) {
        await runtime.quarantinePersistPromise.catch(() => {});
      }
      throw new CodexWorkspaceError("blind_time_firewall", runtime.policyViolation);
    }
    const finalResponse = assembleTurnFinalResponse(runtime, completed.items);
    if (!runtime.fullHistoryRecovered && (runtime.historyRecovery?.hasUnverifiedPrefix
      || [...runtime.agentMessages.values()].some((item) => !item.completed)
      || (runtime.terminalSource === "persisted_turn_state"
        && [...runtime.agentMessages.values()].some((item) => item.phase === "final_answer"
          && !runtime.streamedCompletedMessageIds.has(item.id))))) {
      throw incompleteTurnError(runtime, "history_incomplete", finalResponse,
        "Codex 已结束，但完整消息历史尚未核验；已保留收到的文本，不能把分页前缀当作完整分析。");
    }
    if (!finalResponse.trim()) {
      throw new CodexWorkspaceError("protocol", "Codex 没有返回最终分析文本。");
    }
    const parsedResponse = parseWorkspaceTurnResponse(finalResponse);
    const responseText = parsedResponse.text;
    const postRunSkillVersions = await this.fingerprintSkills(requestedSkills);
    const skillReproducibility = compareSkillVersions(actualSkillVersions, postRunSkillVersions);
    skillReproducibility.capturedAt = skillVersionsCapturedAt;
    skillReproducibility.checkedAt = new Date().toISOString();
    if (skillReproducibility.status === "changed_during_run") {
      notify(this.onStatus, {
        phase: "codex_skill_version_changed", threadId: analysisThreadId, operationId: runtime.operationId,
        message: "分析期间 Skill 文件发生变化；答案仍保留，但本次研究不能标为固定版本可复现",
      });
    }
    notify(this.onStatus, {
      phase: "codex_turn_complete",
      threadId: analysisThreadId,
      operationId: runtime.operationId,
      message: "Codex 项目分析完成；本轮上下文已保留到持久线程",
    });
    const completionPreview = responseText.replace(/\s+/g, " ").slice(0, 500);
    if (String(this.threadId ?? "") === analysisThreadId) {
      this.threadMetadata = {
        ...this.threadMetadata,
        preview: completionPreview,
        updatedAt: new Date().toISOString(),
      };
    }
    // Result delivery is complete at this point. Registry, pointer and search
    // indexing are recovery conveniences and therefore run behind the UI path.
    (async () => {
      const latestMetadata = await this.#ownedThreadMetadata(analysisThreadId)
        .catch(() => analysisThreadMetadata);
      const updatedMetadata = {
        ...latestMetadata,
        threadId: analysisThreadId,
        cwd: this.workspaceDirectory,
        preview: completionPreview,
        updatedAt: new Date().toISOString(),
      };
      await this.#registerOwnedThread(updatedMetadata);
      if (String(this.threadId ?? "") === analysisThreadId) {
        this.threadMetadata = { ...this.threadMetadata, ...updatedMetadata };
        await this.store?.set?.(THREAD_STORE_KEY, this.threadMetadata);
      }
      await this.#snapshotThreadRecentHistory(analysisThreadId, updatedMetadata);
    })().catch((error) => notify(this.onStatus, {
        phase: "codex_history_warning",
        threadId: analysisThreadId,
        operationId: runtime.operationId,
        message: `本轮历史索引将在下次查询时补齐：${cleanError(error)}`,
      }));
    this.#compactWhenNearlyFull(analysisThreadId, runtime.operationId);
    return {
      text: responseText,
      candidateSizing: evidence.analysisScope === "candidate"
        ? parsedResponse.candidateSizing
        : null,
      learningProposal: supportsReviewLearningProposal(evidence)
        ? parsedResponse.learningProposal
        : null,
      researchProposal: supportsResearchProposal(evidence)
        ? parsedResponse.researchProposal
        : null,
      provider: "Codex App Server",
      elapsedMs: Date.now() - startedAt,
      firstActivityMs: runtime.firstActivityAt == null
        ? null
        : runtime.firstActivityAt - startedAt,
      persistent: true,
      ephemeral: false,
      threadId: analysisThreadId,
      workspaceDirectory: this.workspaceDirectory,
      requestedSkills: requestedSkills.map((skill) => skill.name),
      actualSkillVersions,
      postRunSkillVersions,
      skillReproducibility,
      requestedApps: requestedApps.map((app) => app.id),
      researchMode,
      toolEvents,
      toolsUsed: toolEvents.length > 0,
      skillCount: this.skills.length,
      mcpServerCount: restricted ? 0 : this.mcpServers.length,
      appCount: restricted ? 0 : this.apps.length,
      tokenUsage: this.tokenUsageByThread.get(analysisThreadId) ?? null,
      contextDiagnostics,
      additionalContextContract: {
        ...this.additionalContextContract,
        serverUserAgent: this.rpc?.initializeInfo?.userAgent ?? null,
      },
      serverUserAgent: this.rpc?.initializeInfo?.userAgent ?? null,
      resultDelivery: {
        terminalStatus: "completed",
        terminalSource: runtime.terminalSource ?? "remote_response",
        complete: true,
        historyStatus: runtime.fullHistoryRecovered ? "verified" : "streamed_unverified",
        historyReason: runtime.historyRecovery?.reason ?? null,
      },
    };
  }

  async reconcileActiveTurn({ threadId = null, operationId = null } = {}) {
    const runtime = this.#findActiveRuntime({ threadId, operationId });
    if (!runtime) return { active: false, terminal: false, finalText: "" };
    const terminal = await this.#reconcileTurn(runtime).catch(() => false);
    return {
      active: this.activeTurns.get(runtime.threadId) === runtime,
      terminal,
      finalText: runtime.finalPreviewText,
      threadId: runtime.threadId,
      turnId: runtime.turnId === "pending" ? null : runtime.turnId,
    };
  }

  async recoverLatestTurn({ threadId = null, task = "", operationId = null } = {}) {
    await this.#ensureStarted();
    const targetThreadId = String(threadId ?? this.threadId ?? "").trim();
    const metadata = await this.#ownedThreadMetadata(targetThreadId);
    const reviewBinding = normalizeReviewThreadBinding(metadata?.reviewBinding);
    const response = await this.rpc.request("thread/turns/list", {
      threadId: targetThreadId,
      limit: 12,
      sortDirection: "desc",
      itemsView: "summary",
    }, { timeoutMs: TURN_RECONCILE_REQUEST_TIMEOUT_MS });
    const turns = Array.isArray(response?.data) ? response.data : [];
    const normalizedOperationId = String(operationId ?? "").trim();
    const normalizedTask = normalizeComparableText(task);
    const hasClientIds = turns.some((candidate) => turnUserMessageClientId(candidate));
    const turnByClientId = normalizedOperationId
      ? turns.find((candidate) => turnUserMessageClientId(candidate) === normalizedOperationId)
      : null;
    const mayUseTextFallback = !normalizedOperationId || !hasClientIds;
    const turnByTask = mayUseTextFallback
      ? turns.find((candidate) => {
          if (!normalizedTask) return true;
          const candidateTask = normalizeComparableText(turnUserMessageText(candidate));
          return candidateTask === normalizedTask
            || (normalizedTask.length >= 12 && candidateTask.includes(normalizedTask));
        })
      : null;
    const turn = turnByClientId ?? turnByTask ?? (!normalizedTask && !normalizedOperationId ? turns[0] : null);
    if (!turn) return null;
    let items = Array.isArray(turn.items) ? turn.items : [];
    let text = finalResponseFromAgentMessages(
      items.filter((item) => item?.type === "agentMessage").map((item) => ({ ...item, completed: true })),
    );
    if (turn.status === "completed") {
      const persisted = await this.#readPersistedTurnItems(targetThreadId, turn.id);
      const recoveredBlindTool = reviewBinding?.protocol === "decision_cycle"
        && reviewBinding.phase === "blind"
        ? [...items, ...persisted.items].find((item) => TOOL_ITEM_TYPES.has(item?.type))
        : null;
      if (recoveredBlindTool) {
        await this.#quarantineBlindReviewThread({
          threadId: targetThreadId,
          turnId: String(turn.id ?? ""),
          operationId: String(operationId ?? "") || null,
        }, recoveredBlindTool);
        throw new CodexWorkspaceError(
          "blind_time_firewall",
          "从持久线程回收时发现盲态复盘曾调用外部工具；结果已废弃，线程已永久隔离。",
        );
      }
      if (!persisted.complete) {
        const partialText = finalResponseFromAgentMessages(
          persisted.items.filter((item) => item?.type === "agentMessage")
            .map((item) => ({ ...item, completed: true })),
        );
        throw incompleteTurnError({ threadId: targetThreadId, turnId: String(turn.id), operationId },
          "history_incomplete", partialText || text,
          "Codex 已结束，但完整历史消息尚未取回；保留暂存文本，不能把摘要或分页片段当作完整分析。");
      }
      if (persisted.items.length) items = persisted.items;
      text = finalResponseFromAgentMessages(
        items.filter((item) => item?.type === "agentMessage").map((item) => ({ ...item, completed: true })),
      );
    }
    return {
      threadId: targetThreadId,
      turnId: String(turn.id ?? ""),
      status: String(turn.status ?? "unknown"),
      text,
      terminal: ["completed", "interrupted", "failed"].includes(turn.status),
    };
  }

  async cancel({ threadId = null, operationId = null } = {}) {
    const runtime = this.#findActiveRuntime({ threadId, operationId });
    if (!runtime) return false;
    if (runtime.turnId === "pending") {
      this.#abandonTurn(runtime);
      runtime.cancelRequested = true;
      runtime.preStartCompletion.resolve({
        id: null,
        status: "interrupted",
        items: [],
      });
      return true;
    }
    // A missed terminal notification must not turn an already completed result
    // into a local cancellation. Reconcile the persisted turn first.
    if (await this.#reconcileTurn(runtime).catch(() => false)) return false;
    const turnId = runtime.turnId;
    this.#abandonTurn(runtime);
    runtime.completion.resolve({
      id: turnId,
      status: "interrupted",
      items: [],
    });
    this.rpc.request("turn/interrupt", {
      threadId: runtime.threadId,
      turnId,
    }, { timeoutMs: 5_000 }).catch((error) => notify(this.onStatus, {
      phase: "codex_warning",
      threadId: runtime.threadId,
      operationId: runtime.operationId,
      message: `Codex 远端取消确认未返回；本地任务已经结束：${cleanError(error)}`,
    }));
    return true;
  }

  #rememberSettledTurn(threadId, turnId) {
    if (!turnId || turnId === "pending") return;
    this.settledTurnIds.set(`${threadId}:${turnId}`, true);
    while (this.settledTurnIds.size > MAX_SETTLED_TURN_IDS) {
      this.settledTurnIds.delete(this.settledTurnIds.keys().next().value);
    }
  }

  #abandonTurn(runtime) {
    const abandoned = { runtime, turnId: runtime.turnId, rpc: this.rpc, generation: this.rpcGeneration };
    this.abandonedTurns.set(runtime.threadId, abandoned);
    return abandoned;
  }

  async #assertRemoteTurnSettled(threadId) {
    const abandoned = this.abandonedTurns.get(threadId);
    if (!abandoned) return;
    if (abandoned.turnId !== "pending") {
      const response = await abandoned.rpc.request("thread/turns/list", {
        threadId, limit: 12, sortDirection: "desc", itemsView: "summary",
      }, { timeoutMs: TURN_RECONCILE_REQUEST_TIMEOUT_MS }).catch(() => null);
      const terminal = response?.data?.find(turn => String(turn.id) === abandoned.turnId
        && ["completed", "interrupted", "failed"].includes(turn.status));
      if (terminal && this.abandonedTurns.get(threadId) === abandoned) {
        this.#rememberSettledTurn(threadId, abandoned.turnId);
        this.abandonedTurns.delete(threadId);
      }
    }
    if (this.abandonedTurns.has(threadId)) {
      throw new CodexWorkspaceError("remote_turn_pending",
        "上一轮已停止本地等待，但 Codex 尚未确认远端结束。请稍后重试或新建对话；其他对话不受影响。");
    }
  }

  dispose() {
    // Invalidate callbacks before terminating the child. Its asynchronous
    // `close` event must never tear down a later App Server generation.
    this.rpcGeneration += 1;
    this.analysisRequestsByThread.clear();
    this.threadContextBindingPromises.clear();
    this.guardRecheckPromise = null;
    this.guardRecheckContext = null;
    if (this.inventoryRefreshTimer) clearTimeout(this.inventoryRefreshTimer);
    this.inventoryRefreshTimer = null;
    this.inventoryRefreshForceReload = false;
    this.inventoryRefreshResources.clear();
    this.inventoryQueuedResources.clear();
    this.inventoryRefreshThreadId = null;
    this.inventoryPromise = null;
    this.inventoryPromises = { skills: null, mcp: null, apps: null };
    this.inventoryInFlightResources.clear();
    for (const runtime of this.activeTurns.values()) {
      this.#stopTurnHeartbeat(runtime);
      this.#stopTurnReconciler(runtime);
      const error = new CodexWorkspaceError("runtime", "Codex App Server 已关闭。");
      if (runtime.turnId === "pending") {
        runtime.preStartCompletion.resolve({
          id: null,
          status: "failed",
          error: { message: error.message },
          items: [],
        });
      } else {
        runtime.completion.reject(error);
      }
    }
    this.activeTurns.clear();
    this.abandonedTurns.clear();
    this.settledTurnIds.clear();
    this.pendingOperations.clear();
    this.#rejectCompactions(new CodexWorkspaceError("runtime", "Codex App Server 已关闭。"));
    this.rpc?.dispose();
    this.rpc = null;
  }

  #handleNotification(message) {
    const { method, params = {} } = message;
    if (method === "thread/closed") {
      const threadId = String(params.threadId ?? "");
      const compaction = this.compactionRuns.get(threadId);
      if (compaction) {
        this.#finishCompaction(compaction);
        compaction.completion.reject(new CodexWorkspaceError("runtime", "Codex 对话已卸载，压缩等待已结束；请重新打开对话。"));
      }
      this.knownLoadedThreads.delete(threadId);
      this.threadBrokerConfigReceipts.delete(threadId);
      this.threadBrokerGuardProofs.delete(threadId);
      return;
    }
    if (method === "skills/changed") {
      this.#scheduleInventoryRefresh({ forceReload: true, resources: ["skills"] });
      return;
    }
    if (method === "app/list/updated") {
      // This is the latest merged directory snapshot, emitted as each source
      // finishes loading (including our own app/list request). Refetching here
      // would repeatedly forceRefetch on every response. Metadata is not an
      // authorization proof, nor proof that both directory sources succeeded.
      if (Array.isArray(params.data)) {
        this.apps = params.data.filter(app => app?.isAccessible === true && app.isEnabled !== false)
          .map(normalizeApp).filter(Boolean);
        this.#publishCapabilities();
      }
      return;
    }
    if (method === "mcpServer/startupStatus/updated") {
      if (Object.hasOwn(this.readOnlyGuard.tradingViewTools ?? {}, params.name)
        && ["failed", "cancelled"].includes(params.status)) {
        notify(this.onStatus, { phase: "codex_tradingview_unavailable", threadId: params.threadId ?? null,
          message: params.failureReason === "reauthenticationRequired"
            ? "TradingView 授权已失效，需要重新连接；其他已可用研究工具可继续。"
            : "TradingView MCP 暂不可用，本轮不使用其数据；其他已可用研究工具可继续。" });
      }
      this.#scheduleInventoryRefresh({ forceReload: false, threadId: params.threadId == null ? this.threadId : String(params.threadId), resources: ["mcp"] });
      return;
    }
    if (method === "mcpServer/oauthLogin/completed") {
      this.#scheduleInventoryRefresh({ forceReload: true, resources: ["mcp"] });
      return;
    }
    if (method === "thread/name/updated") {
      const renamedThreadId = String(params.threadId ?? "").trim();
      const renamed = normalizeSessionName(params.threadName ?? params.name);
      if (!renamedThreadId || !renamed) return;
      (async () => {
        const metadata = await this.#ownedThreadMetadata(renamedThreadId);
        const updated = { ...metadata, name: renamed };
        if (String(this.threadId ?? "") === renamedThreadId) {
          this.threadMetadata = { ...this.threadMetadata, name: renamed };
        }
        await this.#registerOwnedThread(updated);
        if (String(this.threadId ?? "") === renamedThreadId) {
          await this.store?.set?.(THREAD_STORE_KEY, this.threadMetadata);
        }
      })().catch(() => {});
      return;
    }
    const eventThreadId = params.threadId == null ? null : String(params.threadId);
    const eventTurnId = notificationTurnId(message);
    if (method === "thread/tokenUsage/updated" && eventThreadId) {
      this.tokenUsageByThread.set(eventThreadId, params.tokenUsage ?? null);
      return;
    }
    const abandoned = this.abandonedTurns.get(eventThreadId);
    if (eventTurnId && this.settledTurnIds.has(`${eventThreadId}:${eventTurnId}`)
      && abandoned?.turnId !== eventTurnId) return;
    if (abandoned && eventTurnId
      && (abandoned.turnId === "pending" || abandoned.turnId === eventTurnId)) {
      const learnedTurnId = abandoned.turnId === "pending";
      abandoned.turnId = eventTurnId;
      if (method === "turn/completed" && ["completed", "interrupted", "failed"].includes(params.turn?.status)) {
        this.#rememberSettledTurn(eventThreadId, eventTurnId);
        this.abandonedTurns.delete(eventThreadId);
      } else if (learnedTurnId) {
        abandoned.rpc.request("turn/interrupt", { threadId: eventThreadId, turnId: eventTurnId },
          { timeoutMs: TURN_RECONCILE_REQUEST_TIMEOUT_MS }).catch(() => {});
      }
      return;
    }
    if (eventTurnId && this.settledTurnIds.has(`${eventThreadId}:${eventTurnId}`)) return;
    if (this.#handleCompactionNotification(message, eventThreadId, eventTurnId)) return;
    const runtime = eventThreadId ? this.activeTurns.get(eventThreadId) : null;
    if (method === "thread/status/changed") {
      if (runtime && ["idle", "notLoaded", "systemError"].includes(params.status?.type)) {
        this.#scheduleTurnReconcile(runtime, 0);
      }
      return;
    }
    if (!runtime) return;
    // Any correlated inbound event proves the transport is alive. Only a run
    // of failed reconciliation requests with no intervening traffic may trip
    // the transport circuit breaker; elapsed model-thinking time never does.
    runtime.reconcileTransportFailures = 0;
    if (eventTurnId && runtime.turnId === "pending") {
      // Item/turn notifications can beat or outlive the turn/start response.
      // Adopt their concrete ID immediately so the history reconciler can
      // recover a terminal turn even if the request response is lost.
      runtime.turnId = eventTurnId;
      this.#startTurnReconciler(runtime);
      if (method === "turn/completed" && params.turn) {
        const recoveredBlindTool = runtime.reviewPhase === "blind"
          ? (params.turn.items ?? []).find((item) => TOOL_ITEM_TYPES.has(item?.type))
          : null;
        if (recoveredBlindTool) {
          this.#violateBlindToolFirewall(runtime, recoveredBlindTool, eventTurnId);
        } else {
          runtime.preStartCompletion.resolve(params.turn);
        }
      }
      for (const pending of runtime.pendingNotifications.splice(0)) {
        if (notificationTurnId(pending) === eventTurnId) this.#handleNotification(pending);
      }
    }
    if (eventTurnId && eventTurnId !== runtime.turnId) return;
    if (runtime.policyViolation) {
      // Tool output or approvals may arrive after the local interrupt wins.
      // Never merge those late items into the result or reusable history.
      if (method === "turn/completed" && params.turn) {
        runtime.remoteTerminationConfirmed = ["interrupted", "failed"]
          .includes(String(params.turn.status ?? ""));
      }
      return;
    }
    if (method === "item/agentMessage/delta") {
      const delta = String(params.delta ?? "");
      if (!delta) return;
      runtime.lastActivityAt = Date.now();
      runtime.ledgerRevision += 1;
      if (runtime.finalPreviewText) this.#scheduleFinalStatusCheck(runtime);
      if (runtime.firstActivityAt == null) {
        runtime.firstActivityAt = Date.now();
      }
      const itemId = String(params.itemId ?? "agent-message");
      const previous = runtime.agentMessages.get(itemId);
      if (!previous) runtime.agentMessageOrder.push(itemId);
      const next = `${previous?.text ?? ""}${delta}`.slice(-MAX_STREAM_TEXT_BYTES);
      runtime.agentMessages.set(itemId, {
        id: itemId,
        phase: previous?.phase ?? null,
        text: next,
        completed: previous?.completed ?? false,
      });
      notify(this.onStream, {
        kind: "text_delta",
        threadId: runtime.threadId,
        operationId: runtime.operationId,
        itemId,
        delta,
        turnId: eventTurnId,
      });
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = params.item;
      if (!item) return;
      runtime.lastActivityAt = Date.now();
      runtime.ledgerRevision += 1;
      if (runtime.finalPreviewText) this.#scheduleFinalStatusCheck(runtime);
      if (runtime.firstActivityAt == null) {
        runtime.firstActivityAt = Date.now();
      }
      if (item.type === "agentMessage" && method === "item/completed") {
        if (item.id != null) runtime.streamedCompletedMessageIds.add(String(item.id));
        this.#recordCompletedAgentMessage(runtime, item, eventTurnId);
      }
      if (runtime.reviewPhase === "blind" && TOOL_ITEM_TYPES.has(item.type)) {
        this.#violateBlindToolFirewall(runtime, item, eventTurnId);
        return;
      }
      if (TOOL_ITEM_TYPES.has(item.type)) {
        const event = summarizeToolItem(item, method === "item/completed" ? "completed" : "started");
        const existingIndex = runtime.toolEvents.findIndex(
          (entry) => entry.itemId === event.itemId,
        );
        if (existingIndex >= 0) runtime.toolEvents[existingIndex] = event;
        else runtime.toolEvents.push(event);
        notify(this.onStream, {
          kind: "tool",
          ...event,
          threadId: runtime.threadId,
          operationId: runtime.operationId,
          turnId: eventTurnId,
        });
      }
      return;
    }
    if (method === "turn/completed") {
      if (eventTurnId === runtime.turnId) {
        runtime.terminalSource = "turn_completed_notification";
        this.#mergeRecoveredTurn(runtime, params.turn);
        runtime.completion.resolve(params.turn);
      }
      return;
    }
    if (method === "error" || method === "warning") {
      notify(this.onStatus, {
        phase: "codex_warning",
        threadId: runtime.threadId,
        operationId: runtime.operationId,
        message: params.message ?? params.error?.message ?? "Codex 项目线程报告了运行警告",
      });
    }
  }

  #handleServerRequest(message, rpc = this.rpc) {
    const method = message.method;
    if (this.#denyBlindServerRequest(message, rpc)) return;
    if (method === "item/tool/call") {
      this.#executeDynamicTool(message.params)
        .then((result) => rpc?.respondResult(message.id, result))
        .catch((error) => rpc?.respondResult(message.id, {
            success: false,
            contentItems: [{ type: "inputText", text: cleanError(error) }],
          }));
      return;
    }
    if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
      // The desktop currently has no trusted form bridge. An empty answer map is
      // the protocol-valid no-input response and lets the model explain what it
      // still needs instead of leaving the JSON-RPC request unresolved forever.
      rpc?.respondResult(message.id, { answers: {} });
      notify(this.onStatus, {
        phase: "codex_input_required",
        threadId: message.params?.threadId ?? null,
        message: "Codex 请求了结构化输入；当前桌面端未代填用户答案，本轮会继续并明确缺失信息",
      });
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      rpc?.respondResult(message.id, { action: "decline", content: null, _meta: null });
      notify(this.onStatus, {
        phase: "codex_input_required",
        threadId: message.params?.threadId ?? null,
        message: "MCP 请求额外用户输入；驾驶舱未冒充用户确认，已按协议拒绝并继续分析",
      });
      return;
    }
    if (method === "item/commandExecution/requestApproval") {
      const denied = isBrokerageWriteApproval(message.params);
      rpc?.respondResult(message.id, { decision: denied ? "decline" : "accept" });
      if (denied) this.#notifyBrokerageWriteDenied(message.params);
      return;
    }
    if (method === "item/fileChange/requestApproval") {
      rpc?.respondResult(message.id, { decision: "accept" });
      return;
    }
    if (method === "item/permissions/requestApproval") {
      const denied = isBrokerageWriteApproval(message.params);
      rpc?.respondResult(message.id, {
        permissions: denied ? {} : grantedPermissionSubset(message.params?.permissions),
        scope: "turn",
        strictAutoReview: false,
      });
      if (denied) this.#notifyBrokerageWriteDenied(message.params);
      return;
    }
    // Legacy request variants remain in the generated protocol and can still
    // be emitted by an older Codex binary during a desktop upgrade.
    if (method === "execCommandApproval") {
      const denied = isBrokerageWriteApproval(message.params);
      rpc?.respondResult(message.id, {
        decision: denied
          ? { denied: { rejection: "Brokerage transaction writes are disabled in this cockpit." } }
          : "approved",
      });
      if (denied) this.#notifyBrokerageWriteDenied(message.params);
      return;
    }
    if (method === "applyPatchApproval") {
      rpc?.respondResult(message.id, { decision: "approved" });
      return;
    }
    if (method === "currentTime/read") {
      rpc?.respondResult(message.id, { currentTimeAt: Math.floor(Date.now() / 1_000) });
      return;
    }
    rpc?.respondError(message.id, -32601, `Unsupported client request: ${method}`);
  }

  #denyBlindServerRequest(message, rpc) {
    const params = message?.params ?? {};
    const threadId = String(params.threadId ?? params.conversationId ?? "").trim();
    const runtime = this.#findActiveRuntime({
      threadId: threadId || null,
      operationId: params.operationId ?? null,
    });
    const cachedBinding = normalizeReviewThreadBinding(
      this.ownedThreadCache.get(threadId)?.reviewBinding,
    );
    const blind = runtime?.reviewPhase === "blind"
      || Boolean(runtime?.policyViolation)
      || this.quarantinedReviewThreads.has(threadId)
      || this.quarantinedReviewTurns.has(String(params.turnId ?? "").trim())
      || (cachedBinding?.protocol === "decision_cycle" && cachedBinding.phase === "blind");
    if (!blind) return false;

    const method = String(message?.method ?? "");
    const reason = "盲态复盘禁止审批、交互输入与外部工具；该请求已由宿主同步拒绝。";
    if (method === "item/tool/call") {
      rpc?.respondResult(message.id, {
        success: false,
        contentItems: [{
          type: "inputText",
          text: "阶段一盲态复盘已禁用近期对话查询；不得通过历史对话读取截止点之后的信息。",
        }],
      });
    } else if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
      rpc?.respondResult(message.id, { answers: {} });
    } else if (method === "mcpServer/elicitation/request") {
      rpc?.respondResult(message.id, { action: "decline", content: null, _meta: null });
    } else if (method === "item/permissions/requestApproval") {
      rpc?.respondResult(message.id, {
        permissions: {},
        scope: "turn",
        strictAutoReview: false,
      });
    } else if (method === "item/commandExecution/requestApproval"
      || method === "item/fileChange/requestApproval") {
      rpc?.respondResult(message.id, { decision: "decline" });
    } else if (method === "execCommandApproval" || method === "applyPatchApproval") {
      rpc?.respondResult(message.id, {
        decision: { denied: { rejection: reason } },
      });
    } else if (/approval/i.test(method) || method === "currentTime/read") {
      rpc?.respondError(message.id, -32000, reason);
    } else {
      return false;
    }
    notify(this.onStatus, {
      phase: "codex_blind_firewall",
      threadId: threadId || runtime?.threadId || null,
      operationId: runtime?.operationId ?? null,
      message: reason,
    });
    return true;
  }

  #notifyBrokerageWriteDenied(params) {
    notify(this.onStatus, {
      phase: "codex_brokerage_write_denied",
      threadId: params?.threadId ?? params?.conversationId ?? null,
      message: "已拒绝券商下单、改单、撤单、行权或资金划转动作；只读分析与本地研究能力不受限制",
    });
  }

  #handleStderr(message) {
    if (/stream disconnected|retrying sampling request/i.test(message)) {
      notify(this.onStatus, {
        phase: "codex_retry",
        message: "Codex 服务连接波动；持久线程会保留，当前轮可随时取消",
      });
    }
  }

  #handleExit(error, { generation = this.rpcGeneration, rpc = this.rpc } = {}) {
    if (generation !== this.rpcGeneration || rpc !== this.rpc) return;
    this.#rejectCompactions(new CodexWorkspaceError("runtime", cleanError(error ?? "Codex App Server 已退出。")));
    if (this.inventoryRefreshTimer) clearTimeout(this.inventoryRefreshTimer);
    this.inventoryRefreshTimer = null;
    this.inventoryRefreshForceReload = false;
    this.inventoryRefreshResources.clear();
    this.inventoryQueuedResources.clear();
    this.inventoryRefreshThreadId = null;
    this.inventoryPromise = null;
    this.inventoryPromises = { skills: null, mcp: null, apps: null };
    this.inventoryInFlightResources.clear();
    for (const runtime of this.activeTurns.values()) {
      this.#stopTurnHeartbeat(runtime);
      this.#stopTurnReconciler(runtime);
      const runtimeError = runtime.finalPreviewText.trim()
        ? incompleteTurnError(runtime, "terminal_unverified", runtime.finalPreviewText,
          "Codex 连接已退出；收到的文本已保留，但整轮终态尚未核验，请重新打开该对话确认。")
        : new CodexWorkspaceError("runtime", cleanError(error ?? "Codex App Server 已退出。"));
      runtime.deliveryFailure = runtimeError;
      if (runtime.turnId === "pending") {
        runtime.preStartCompletion.resolve({
          id: null,
          status: "failed",
          error: { message: runtimeError.message },
          items: [],
        });
      } else {
        runtime.completion.reject(runtimeError);
      }
    }
    this.activeTurns.clear();
    this.threadId = null;
    this.rpc = null;
  }

  #recordCompletedAgentMessage(runtime, item, turnId, { recovered = false } = {}) {
    if (runtime?.policyViolation) return;
    const text = String(item?.text ?? "");
    if (!text.trim()) return;
    const itemId = String(item?.id ?? `agent-message-${runtime.agentMessageOrder.length + 1}`);
    if (!runtime.agentMessages.has(itemId)) runtime.agentMessageOrder.push(itemId);
    runtime.agentMessages.set(itemId, {
      id: itemId,
      phase: item?.phase ?? null,
      text: text.slice(-MAX_STREAM_TEXT_BYTES),
      completed: true,
    });
    if (item?.phase !== "final_answer") return;
    this.#publishFinalMessageAggregate(runtime, itemId, turnId, { recovered });
  }

  #publishFinalMessageAggregate(runtime, itemId, turnId, { recovered = false } = {}) {
    const aggregate = aggregateFinalMessageText(
      runtime.agentMessageOrder.map((id) => runtime.agentMessages.get(id)),
    );
    if (!aggregate || runtime.finalPreviewText === aggregate) return;
    runtime.finalPreviewText = aggregate;
    notify(this.onStream, {
      kind: "final_message",
      threadId: runtime.threadId,
      operationId: runtime.operationId,
      itemId,
      text: aggregate,
      turnId,
      recovered,
      complete: false,
      deliveryStatus: "preview",
    });
    notify(this.onStatus, {
      phase: "codex_final_received",
      threadId: runtime.threadId,
      operationId: runtime.operationId,
      message: "Codex 结论片段已收到，正在确认整轮终态与完整消息",
    });
    this.#scheduleTurnReconcile(runtime, TURN_FINAL_RECONCILE_DELAY_MS);
    this.#scheduleFinalStatusCheck(runtime);
  }

  #scheduleFinalStatusCheck(runtime) {
    if (runtime.finalStatusTimer) clearTimeout(runtime.finalStatusTimer);
    runtime.finalStatusTimer = setTimeout(async () => {
      runtime.finalStatusTimer = null;
      if (this.activeTurns.get(runtime.threadId) !== runtime
        || runtime.turnId === "pending"
        || !runtime.finalPreviewText.trim()) return;
      const quietForMs = Date.now() - Number(runtime.lastActivityAt ?? runtime.startedAt);
      if (quietForMs < TURN_FINAL_STATUS_CHECK_MS) {
        this.#scheduleFinalStatusCheck(runtime);
        return;
      }
      const revisionBeforeReconcile = runtime.ledgerRevision;
      if (await this.#reconcileTurn(runtime).catch(() => false)) return;
      if (this.activeTurns.get(runtime.threadId) !== runtime) return;
      const quietAfterReconcile = Date.now() - Number(runtime.lastActivityAt ?? runtime.startedAt);
      if (runtime.ledgerRevision !== revisionBeforeReconcile
        || quietAfterReconcile < TURN_FINAL_STATUS_CHECK_MS) {
        this.#scheduleFinalStatusCheck(runtime);
        return;
      }
      // A completed message is not a completed turn. A healthy inProgress
      // response must never be converted to success using a quiet window.
      notify(this.onStatus, {
        phase: "codex_final_pending_terminal",
        threadId: runtime.threadId,
        operationId: runtime.operationId,
        message: "已收到可展示的结论片段；Codex 尚未确认整轮结束，继续接收后续内容，可主动取消",
      });
    }, TURN_FINAL_STATUS_CHECK_MS);
    runtime.finalStatusTimer.unref?.();
  }

  #mergeRecoveredTurn(runtime, turn, { authoritativeItemOrder = false } = {}) {
    if (runtime?.policyViolation) return;
    if (!turn || String(turn.id ?? "") !== String(runtime.turnId ?? "")) return;
    if (runtime.reviewPhase === "blind") {
      const recoveredBlindTool = (turn.items ?? [])
        .find((item) => TOOL_ITEM_TYPES.has(item?.type));
      if (recoveredBlindTool) {
        this.#violateBlindToolFirewall(runtime, recoveredBlindTool, String(turn.id ?? ""));
        return;
      }
    }
    const persistedOrder = [];
    let lastPersistedFinalId = null;
    for (const item of turn.items ?? []) {
      if (item?.type === "agentMessage") {
        if (authoritativeItemOrder && item?.id != null) {
          const itemId = String(item.id);
          if (!persistedOrder.includes(itemId)) persistedOrder.push(itemId);
          runtime.agentMessages.set(itemId, {
            id: itemId,
            phase: item?.phase ?? null,
            text: String(item?.text ?? "").slice(-MAX_STREAM_TEXT_BYTES),
            completed: true,
          });
          if (item?.phase === "final_answer") lastPersistedFinalId = itemId;
        } else {
          this.#recordCompletedAgentMessage(runtime, item, turn.id, { recovered: true });
        }
      }
      if (!TOOL_ITEM_TYPES.has(item?.type)) continue;
      const lifecycle = ["completed", "failed", "declined"].includes(item.status)
        ? "completed"
        : "started";
      const event = summarizeToolItem(item, lifecycle);
      const existingIndex = runtime.toolEvents.findIndex(
        (entry) => entry.itemId === event.itemId,
      );
      if (existingIndex >= 0) runtime.toolEvents[existingIndex] = event;
      else runtime.toolEvents.push(event);
      notify(this.onStream, {
        kind: "tool",
        ...event,
        threadId: runtime.threadId,
        operationId: runtime.operationId,
        turnId: turn.id,
        recovered: true,
      });
    }
    if (authoritativeItemOrder && persistedOrder.length) {
      const persistedIds = new Set(persistedOrder);
      runtime.agentMessageOrder = [
        ...persistedOrder,
        ...runtime.agentMessageOrder.filter((itemId) => !persistedIds.has(itemId)),
      ];
      if (lastPersistedFinalId) {
        this.#publishFinalMessageAggregate(runtime, lastPersistedFinalId, turn.id, { recovered: true });
      }
    }
  }

  async #reconcileTurn(runtime) {
    if (!this.rpc?.ready || this.activeTurns.get(runtime.threadId) !== runtime
      || runtime.turnId === "pending") return false;
    if (runtime.reconcilePromise) return runtime.reconcilePromise;
    const rpc = this.rpc;
    const threadId = runtime.threadId;
    const turnId = String(runtime.turnId);
    const reconciliation = (async () => {
      const response = await rpc.request("thread/turns/list", {
        threadId,
        limit: 12,
        sortDirection: "desc",
        itemsView: "summary",
      }, { timeoutMs: TURN_RECONCILE_REQUEST_TIMEOUT_MS });
      runtime.reconcileTransportFailures = 0;
      if (runtime.policyViolation) return false;
      const turn = (response?.data ?? []).find((item) => String(item?.id ?? "") === turnId);
      if (!turn) return false;
      if (this.activeTurns.get(threadId) !== runtime || String(runtime.turnId) !== turnId) {
        return false;
      }
      this.#mergeRecoveredTurn(runtime, turn);
      if (runtime.policyViolation) return true;
      if (!["completed", "interrupted", "failed"].includes(turn.status)) return false;
      runtime.terminalSource = "persisted_turn_state";
      let recoveredTurn = turn;
      try {
        const persisted = await this.#recoverTurnHistory(runtime, turnId);
        if (persisted.items.length) {
          runtime.fullHistoryRecovered = persisted.complete;
          recoveredTurn = { ...turn, items: persisted.items };
          this.#mergeRecoveredTurn(runtime, recoveredTurn, { authoritativeItemOrder: true });
          if (runtime.policyViolation) return true;
        }
      } catch (error) {
        // The terminal summary already contains the display answer on current
        // App Server versions. Full item paging is a precision enhancement for
        // split final messages and must not turn recovery into another hang.
        notify(this.onStatus, {
          phase: "codex_history_warning",
          threadId,
          operationId: runtime.operationId,
          message: `已回收 Codex 终态；完整 item 历史稍后补齐：${cleanError(error)}`,
        });
      }
      notify(this.onStatus, {
        phase: "codex_turn_recovered",
        threadId,
        operationId: runtime.operationId,
        message: "已从 Codex 持久线程回收终态与最终结论",
      });
      runtime.completion.resolve(recoveredTurn);
      runtime.preStartCompletion.resolve(recoveredTurn);
      return true;
    })();
    const trackedReconciliation = reconciliation.catch((error) => {
      this.#recordReconcileTransportFailure(runtime, error);
      throw error;
    }).finally(() => {
      if (runtime.reconcilePromise === trackedReconciliation) runtime.reconcilePromise = null;
    });
    runtime.reconcilePromise = trackedReconciliation;
    return runtime.reconcilePromise;
  }

  #recordReconcileTransportFailure(runtime, error) {
    if (this.activeTurns.get(runtime.threadId) !== runtime || runtime.reconcileTransportTerminal) return;
    if (!isReconcileTransportFailure(error)) return;
    runtime.reconcileTransportFailures = Number(runtime.reconcileTransportFailures ?? 0) + 1;
    if (runtime.reconcileTransportFailures < TURN_RECONCILE_TRANSPORT_FAILURE_THRESHOLD) {
      notify(this.onStatus, {
        phase: "codex_reconcile_retry",
        threadId: runtime.threadId,
        operationId: runtime.operationId,
        message: `Codex 终态传输暂不可用（${runtime.reconcileTransportFailures}/${TURN_RECONCILE_TRANSPORT_FAILURE_THRESHOLD}），正在从持久线程重试`,
      });
      return;
    }
    runtime.reconcileTransportTerminal = true;
    this.#abandonTurn(runtime);
    this.#stopTurnHeartbeat(runtime);
    this.#stopTurnReconciler(runtime);
    const terminalError = runtime.finalPreviewText.trim()
      ? incompleteTurnError(runtime, "terminal_unverified", runtime.finalPreviewText,
        "Codex 终态查询连续失败；已保留收到的文本，但不能确认整轮完成。请重新打开对话核验，不要把暂存片段当作完整分析。")
      : new CodexWorkspaceError(
        "transport",
        `Codex 连接连续 ${TURN_RECONCILE_TRANSPORT_FAILURE_THRESHOLD} 次无法读取持久终态；本轮已停止等待，请重试。持久对话仍保留。最后错误：${cleanError(error)}`,
      );
    runtime.deliveryFailure = terminalError;
    runtime.completion.reject(terminalError);
    runtime.preStartCompletion.resolve({
      id: runtime.turnId,
      status: "failed",
      error: { message: terminalError.message },
      items: [],
    });
    notify(this.onStatus, {
      phase: "codex_transport_terminal",
      threadId: runtime.threadId,
      operationId: runtime.operationId,
      message: "Codex 终态传输连续失败；已结束转圈并保留持久对话，可直接重试",
      detail: cleanError(error),
    });
  }

  async #readPersistedTurnItems(threadId, turnId) {
    return readCodexTurnItems(this.rpc, threadId, turnId, {
      budgetMs: this.turnHistoryBudgetMs,
    });
  }

  #recoverTurnHistory(runtime, turnId) {
    // A terminal notification may arrive while the reconciler is already
    // paging. Share that exact read and deadline with the delivery path.
    if (!runtime.historyRecoveryPromise) {
      runtime.historyRecoveryPromise = this.#readPersistedTurnItems(runtime.threadId, turnId)
        .then((result) => {
          runtime.historyRecovery = result;
          return result;
        });
    }
    return runtime.historyRecoveryPromise;
  }

  #scheduleTurnReconcile(runtime, delayMs = 0) {
    if (runtime.turnId === "pending") return;
    if (runtime.finalReconcileTimer) clearTimeout(runtime.finalReconcileTimer);
    runtime.finalReconcileTimer = setTimeout(() => {
      runtime.finalReconcileTimer = null;
      this.#reconcileTurn(runtime).catch((error) => {
        if (!runtime.finalPreviewText) return;
        notify(this.onStatus, {
          phase: "codex_reconcile_retry",
          threadId: runtime.threadId,
          operationId: runtime.operationId,
          message: `最终结论已收到，持久终态将在后台重试确认：${cleanError(error)}`,
        });
      });
    }, Math.max(0, delayMs));
    runtime.finalReconcileTimer.unref?.();
  }

  #startTurnReconciler(runtime) {
    // A late turn/start response may call this after a final item already
    // armed a status check. Restart only periodic polling; do not cancel
    // the final reconciliation or quiet-status timers.
    if (runtime.reconcileTimer) clearInterval(runtime.reconcileTimer);
    runtime.reconcileTimer = setInterval(() => {
      this.#reconcileTurn(runtime).catch(() => {});
    }, TURN_RECONCILE_INTERVAL_MS);
    runtime.reconcileTimer.unref?.();
  }

  #stopTurnReconciler(runtime) {
    if (runtime.reconcileTimer) clearInterval(runtime.reconcileTimer);
    if (runtime.finalReconcileTimer) clearTimeout(runtime.finalReconcileTimer);
    if (runtime.finalStatusTimer) clearTimeout(runtime.finalStatusTimer);
    runtime.reconcileTimer = null;
    runtime.finalReconcileTimer = null;
    runtime.finalStatusTimer = null;
  }

  #compactWhenNearlyFull(threadId, operationId = null) {
    const tokenUsage = this.tokenUsageByThread.get(threadId);
    if (this.compactionPromises.has(threadId) || !tokenUsage || !threadId) return;
    const windowSize = Number(tokenUsage.modelContextWindow);
    const activeTokens = Number(
      tokenUsage.last?.totalTokens
      ?? tokenUsage.last?.inputTokens,
    );
    if (!Number.isFinite(windowSize) || !Number.isFinite(activeTokens) || windowSize <= 0) return;
    if (activeTokens / windowSize < 0.90) return;
    notify(this.onStatus, {
      phase: "codex_compacting",
      threadId,
      operationId,
      message: "Codex 项目线程上下文已接近安全线，正在自动压缩并保留关键历史",
    });
    this.#startTrackedCompaction(threadId)
      .catch((error) => notify(this.onStatus, {
        phase: "codex_warning",
        threadId,
        operationId,
        message: `Codex 自动压缩未完成：${cleanError(error)}`,
      }));
  }

  async #compactBeforeTurnIfNeeded({ threadId, operationId = null, estimatedInputTokens = 0, signal = null }) {
    // Acceptance of compact/start is not completion. A post-turn compaction
    // must finish even if its token estimate would not trigger another one.
    if (this.compactionPromises.has(threadId)) {
      const compaction = this.compactionRuns.get(threadId);
      if (compaction?.timedOut && compaction.turnId) {
        const response = await awaitWithAbort(compaction.rpc.request("thread/turns/list", {
          threadId, limit: 12, sortDirection: "desc", itemsView: "summary",
        }, { timeoutMs: TURN_RECONCILE_REQUEST_TIMEOUT_MS }).catch(() => null), signal);
        const terminal = response?.data?.find(turn => String(turn.id) === compaction.turnId
          && ["completed", "interrupted", "failed"].includes(turn.status));
        if (terminal && this.compactionRuns.get(threadId) === compaction) {
          this.#finishCompaction(compaction);
          if (terminal.status === "completed") return true;
          throw new CodexWorkspaceError("context_budget", "Codex 持久历史确认上次压缩未成功；请重试。" );
        }
      }
      await awaitWithAbort(this.compactionPromises.get(threadId), signal);
      return true;
    }
    const tokenUsage = this.tokenUsageByThread.get(threadId);
    if (!tokenUsage || !threadId) return false;
    const windowSize = Number(tokenUsage.modelContextWindow);
    const activeTokens = Number(tokenUsage.last?.totalTokens ?? tokenUsage.last?.inputTokens);
    if (!Number.isFinite(windowSize) || windowSize <= 0 || !Number.isFinite(activeTokens)) return false;
    const projectedTokens = activeTokens
      + Math.max(0, Number(estimatedInputTokens) || 0)
      + PRE_TURN_OUTPUT_RESERVE_TOKENS;
    if (projectedTokens / windowSize < PRE_TURN_COMPACTION_RATIO) return false;
    notify(this.onStatus, {
      phase: "codex_compacting",
      threadId,
      operationId,
      message: "本轮证据较大；Codex 正在先完成上下文压缩，再开始分析",
    });
    try {
      await awaitWithAbort(this.#startTrackedCompaction(threadId), signal);
      return true;
    } catch (error) {
      throwIfAborted(signal);
      if (this.compactionRuns.has(threadId) || projectedTokens / windowSize >= 0.95) {
        throw new CodexWorkspaceError(
          "context_budget",
          `预计本轮会超过 Codex 安全上下文，且预压缩失败：${cleanError(error)}`,
        );
      }
      notify(this.onStatus, {
        phase: "codex_warning",
        threadId,
        operationId,
        message: `Codex 预压缩未完成；当前仍有安全余量，本轮继续：${cleanError(error)}`,
      });
      return false;
    }
  }

  #startTrackedCompaction(threadId) {
    const existing = this.compactionPromises.get(threadId);
    if (existing) return existing;
    this.compactingThreads.add(threadId);
    const completion = deferred();
    const compaction = { threadId, completion, turnId: null, rpc: this.rpc, generation: this.rpcGeneration, timer: null, timedOut: false };
    this.compactionRuns.set(threadId, compaction);
    this.compactionPromises.set(threadId, completion.promise);
    compaction.timer = setTimeout(() => {
      // Keep the thread fenced after timeout; a later real terminal event can
      // release it. Never race a new analysis against an unverified compact.
      compaction.timedOut = true;
      completion.reject(new CodexWorkspaceError("context_budget", "Codex 上下文压缩尚未确认完成；重试会回查已知轮次的持久终态，也可使用新对话。"));
    }, this.compactionTimeoutMs);
    compaction.timer.unref?.();
    this.rpc.request("thread/compact/start", { threadId }).catch(error => {
      if (this.compactionRuns.get(threadId) !== compaction) return;
      clearTimeout(compaction.timer);
      compaction.timedOut = true;
      completion.reject(error);
      // An explicit RPC rejection did not accept the operation. An uncertain
      // transport failure must retain the fence until a terminal or reconnect.
      if (Number.isFinite(error?.rpcCode)) this.#finishCompaction(compaction);
    });
    return completion.promise;
  }

  #finishCompaction(compaction) {
    if (this.compactionRuns.get(compaction.threadId) !== compaction) return;
    clearTimeout(compaction.timer);
    this.#rememberSettledTurn(compaction.threadId, compaction.turnId);
    this.compactionRuns.delete(compaction.threadId);
    this.compactionPromises.delete(compaction.threadId);
    this.compactingThreads.delete(compaction.threadId);
  }

  #rejectCompactions(error) {
    for (const compaction of this.compactionRuns.values()) {
      clearTimeout(compaction.timer);
      compaction.completion.reject(error);
    }
    this.compactionRuns.clear();
    this.compactionPromises.clear();
    this.compactingThreads.clear();
  }

  #handleCompactionNotification(message, threadId, turnId) {
    const compaction = this.compactionRuns.get(threadId);
    if (!compaction || !turnId) return false;
    if (compaction.turnId && compaction.turnId !== turnId) return false;
    // The host reserves this thread before issuing compact/start; no analysis
    // is allowed to start until its own turn/completed arrives.
    compaction.turnId = turnId;
    if (message.method === "turn/completed") {
      const turn = message.params?.turn;
      if (!["completed", "interrupted", "failed"].includes(turn?.status)) return true;
      this.#finishCompaction(compaction);
      if (turn.status === "completed") compaction.completion.resolve(turn);
      else compaction.completion.reject(new CodexWorkspaceError("context_budget", "Codex 上下文压缩未成功完成。"));
    }
    return true;
  }

  #startTurnHeartbeat(runtime) {
    this.#stopTurnHeartbeat(runtime);
    runtime.heartbeatTimer = setInterval(() => {
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - runtime.startedAt) / 1_000));
      notify(this.onStatus, {
        phase: "codex_waiting",
        threadId: runtime.threadId,
        operationId: runtime.operationId,
        message: `Codex 已运行 ${elapsedSeconds} 秒；持久线程仍在处理，可随时取消`,
      });
    }, 15_000);
    runtime.heartbeatTimer.unref?.();
  }

  #stopTurnHeartbeat(runtime) {
    if (!runtime.heartbeatTimer) return;
    clearInterval(runtime.heartbeatTimer);
    runtime.heartbeatTimer = null;
  }

  #findActiveRuntime({ threadId = null, operationId = null } = {}) {
    const targetThreadId = String(threadId ?? "").trim();
    const targetOperationId = String(operationId ?? "").trim();
    if (targetThreadId) {
      const runtime = this.activeTurns.get(targetThreadId);
      if (runtime && (!targetOperationId || runtime.operationId === targetOperationId)) return runtime;
      return null;
    }
    if (targetOperationId) {
      return [...this.activeTurns.values()]
        .find((candidate) => candidate.operationId === targetOperationId) ?? null;
    }
    return this.activeTurns.size === 1 ? this.activeTurns.values().next().value : null;
  }

  async #ownedThreadMetadata(threadId) {
    if (!threadId) throw new CodexWorkspaceError("session", "请选择要分析的 Codex 会话。");
    const quarantine = this.quarantinedReviewThreads.get(String(threadId));
    if (quarantine) {
      throw new CodexWorkspaceError(
        "review_thread_quarantine",
        "该盲态复盘对话曾启动外部工具，线程上下文已隔离；请新建复盘对话后重新运行。",
      );
    }
    const cached = this.ownedThreadCache.get(String(threadId));
    if (cached?.reviewQuarantine) {
      this.quarantinedReviewThreads.set(String(threadId), cached.reviewQuarantine);
      throw new CodexWorkspaceError(
        "review_thread_quarantine",
        "该盲态复盘对话曾启动外部工具，线程上下文已隔离；请新建复盘对话后重新运行。",
      );
    }
    if (cached && !cached.archivedAt && cached.cwd === this.workspaceDirectory) {
      return { ...cached };
    }
    const registry = await this.#loadOwnedThreadRegistry();
    const owned = registry.threads.find((entry) => entry.threadId === threadId);
    if (owned?.reviewQuarantine) {
      this.quarantinedReviewThreads.set(String(threadId), owned.reviewQuarantine);
      throw new CodexWorkspaceError(
        "review_thread_quarantine",
        "该盲态复盘对话曾启动外部工具，线程上下文已隔离；请新建复盘对话后重新运行。",
      );
    }
    if (!owned || owned.archivedAt || owned.cwd !== this.workspaceDirectory) {
      throw new CodexWorkspaceError("session", "该会话不属于交易驾驶舱，或已超过 30 天并归档。");
    }
    this.ownedThreadCache.set(String(threadId), owned);
    return owned;
  }

  #quarantineBlindReviewThread(runtime, item) {
    const threadId = String(runtime?.threadId ?? "").trim();
    if (!threadId) return Promise.resolve();
    const quarantine = Object.freeze({
      quarantinedAt: new Date().toISOString(),
      reason: "blind_external_tool_started",
      turnId: String(runtime?.turnId ?? "").trim() || null,
      operationId: String(runtime?.operationId ?? "").trim() || null,
      itemType: String(item?.type ?? "unknown").slice(0, 80),
      itemId: String(item?.id ?? item?.callId ?? "").slice(0, 240) || null,
    });
    this.quarantinedReviewThreads.set(threadId, quarantine);
    if (quarantine.turnId) this.quarantinedReviewTurns.add(quarantine.turnId);
    const cached = this.ownedThreadCache.get(threadId);
    if (cached) this.ownedThreadCache.set(threadId, { ...cached, reviewQuarantine: quarantine });
    if (String(this.threadId ?? "") === threadId && this.threadMetadata) {
      this.threadMetadata = { ...this.threadMetadata, reviewQuarantine: quarantine };
    }
    return this.#queueHistoryMutation(async () => {
      const registry = normalizeOwnedThreadRegistry(
        await this.store?.get?.(THREAD_REGISTRY_STORE_KEY),
      );
      const entry = registry.threads.find((candidate) => candidate.threadId === threadId);
      if (entry) entry.reviewQuarantine = quarantine;
      registry.updatedAt = quarantine.quarantinedAt;
      await this.store?.set?.(THREAD_REGISTRY_STORE_KEY, registry);
      const activePointer = await this.store?.get?.(THREAD_STORE_KEY);
      if (String(activePointer?.threadId ?? "") === threadId) {
        await this.store?.set?.(THREAD_STORE_KEY, null);
      }
    });
  }

  #violateBlindToolFirewall(runtime, item, turnId) {
    if (runtime.policyViolation) return;
    runtime.policyViolation = "盲态复盘尝试调用外部工具，宿主已在结果进入上下文前中止本轮；请重新运行。阶段一只允许使用已冻结的本地证据胶囊。";
    runtime.cancelRequested = true;
    runtime.quarantinePersistPromise = this.#quarantineBlindReviewThread(runtime, item);
    runtime.completion.resolve({
      id: turnId,
      status: "interrupted",
      error: { message: runtime.policyViolation },
      items: [],
    });
    runtime.preStartCompletion.resolve({
      id: turnId,
      status: "interrupted",
      error: { message: runtime.policyViolation },
      items: [],
    });
    if (turnId) {
      this.rpc?.request?.("turn/interrupt", {
        threadId: runtime.threadId,
        turnId,
      }, { timeoutMs: 5_000 }).catch((error) => notify(this.onStatus, {
        phase: "codex_blind_thread_quarantined",
        threadId: runtime.threadId,
        operationId: runtime.operationId,
        message: `远端终止未确认，盲态复盘线程保持永久隔离：${cleanError(error)}`,
      }));
    }
    notify(this.onStatus, {
      phase: "codex_blind_firewall",
      threadId: runtime.threadId,
      operationId: runtime.operationId,
      message: runtime.policyViolation,
    });
  }

  async #bindAnalysisThreadContext(metadata, evidence) {
    const threadId = String(metadata?.threadId ?? "");
    const generation = this.rpcGeneration;
    const previous = this.threadContextBindingPromises.get(threadId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      if (generation !== this.rpcGeneration) throw new CodexWorkspaceError("session", "研究会话连接已变化，请重新运行。");
      // Re-read after the previous binding commits. Two rapid requests cannot
      // both bind the same previously blank thread to different research IDs.
      const latest = await this.#ownedThreadMetadata(threadId);
      if (generation !== this.rpcGeneration) throw new CodexWorkspaceError("session", "研究会话连接已变化，请重新运行。");
      return this.#bindAnalysisThreadContextNow(latest, evidence);
    });
    this.threadContextBindingPromises.set(threadId, operation);
    try { return await operation; }
    finally {
      if (this.threadContextBindingPromises.get(threadId) === operation) this.threadContextBindingPromises.delete(threadId);
    }
  }

  async #bindAnalysisThreadContextNow(metadata, evidence) {
    const requestedBinding = reviewThreadBindingFromEvidence(evidence);
    const existingBinding = normalizeReviewThreadBinding(metadata?.reviewBinding);
    let requestedResearch;
    try { requestedResearch = researchThreadBindingFromEvidence(evidence); }
    catch (error) { throw new CodexWorkspaceError("research_thread_binding", cleanError(error)); }
    const existingResearch = normalizeResearchThreadBinding(metadata?.researchBinding);
    if (requestedResearch || existingResearch) {
      if (requestedBinding || existingBinding) {
        throw new CodexWorkspaceError("research_thread_binding", "研究主线与历史复盘不能共用同一持久对话；请新建独立研究或复盘对话。");
      }
      if (!requestedResearch) {
        throw new CodexWorkspaceError("research_thread_binding", "该对话已绑定研究主线；请先选择对应研究记录再继续，或新建普通研究对话。");
      }
      let researchBinding;
      try { researchBinding = assertResearchThreadBinding(existingResearch, requestedResearch); }
      catch (error) { throw new CodexWorkspaceError("research_thread_binding", cleanError(error)); }
      if (existingResearch) return metadata;
      // The host creates a fresh research session. Do not add a remote history
      // probe here: a locally cached pending user message is not contamination.
      const initialTurns = this.initialTurnsPages.get(String(metadata.threadId))?.data;
      const priorCompletedTurn = Array.isArray(initialTurns)
        && initialTurns.some(turn => ["completed", "interrupted", "failed"].includes(turn?.status));
      if (String(metadata.preview ?? "").trim() || priorCompletedTurn) {
        throw new CodexWorkspaceError("research_thread_binding", "已有分析历史的对话不能首次绑定为研究主线；请新建独立研究对话，避免混入先前组合或其他标的判断。");
      }
      const updated = { ...metadata, researchBinding };
      await this.#registerOwnedThread(updated);
      if (String(this.threadId ?? "") === String(metadata.threadId)) {
        this.threadMetadata = { ...this.threadMetadata, researchBinding };
        await this.store?.set?.(THREAD_STORE_KEY, this.threadMetadata);
      }
      return updated;
    }
    if (!requestedBinding) {
      if (existingBinding) {
        throw new CodexWorkspaceError(
          "review_thread_binding",
          "该 Codex 对话已绑定一个复盘证据版本；请新建普通分析对话，避免把实时持仓与历史复盘混在同一上下文。",
        );
      }
      return metadata;
    }
    let binding;
    try {
      if (!existingBinding
        && requestedBinding.protocol === "decision_cycle"
        && requestedBinding.phase === "blind") {
        await this.#assertThreadEmptyBeforeBlindBinding(metadata);
      }
      binding = assertReviewThreadBinding(existingBinding, requestedBinding);
    } catch (error) {
      throw new CodexWorkspaceError("review_thread_binding", cleanError(error));
    }
    const updated = { ...metadata, reviewBinding: binding };
    await this.#registerOwnedThread(updated);
    if (String(this.threadId ?? "") === String(metadata.threadId)) {
      this.threadMetadata = { ...this.threadMetadata, reviewBinding: binding };
      await this.store?.set?.(THREAD_STORE_KEY, this.threadMetadata);
    }
    return updated;
  }

  async #assertThreadEmptyBeforeBlindBinding(metadata) {
    const threadId = String(metadata?.threadId ?? "").trim();
    if (!threadId) throw new Error("盲态复盘缺少可验证的线程 ID。");
    const initialPage = this.initialTurnsPages.get(threadId);
    if (Array.isArray(initialPage?.data) && initialPage.data.length) {
      throw new Error("已有历史的 Codex 对话不能首次绑定为盲态复盘；请新建空白复盘对话。");
    }
    if (String(metadata?.preview ?? "").trim()) {
      throw new Error("已有历史的 Codex 对话不能首次绑定为盲态复盘；请新建空白复盘对话。");
    }
    let result;
    try {
      result = await this.rpc.request("thread/turns/list", {
        threadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "summary",
      }, { timeoutMs: TURN_RECONCILE_REQUEST_TIMEOUT_MS });
    } catch (error) {
      throw new Error(`无法确认盲态复盘对话为空；已拒绝绑定：${cleanError(error)}`);
    }
    if (!Array.isArray(result?.data)) {
      throw new Error("无法确认盲态复盘对话为空；已拒绝绑定。");
    }
    if (result.data.length) {
      throw new Error("已有历史的 Codex 对话不能首次绑定为盲态复盘；请新建空白复盘对话。");
    }
  }
}

export class CodexAppServerRpc {
  constructor({
    codexPath,
    cwd,
    clientVersion,
    spawnImpl = spawn,
    networkMode = "inherit",
    inspectFeatures,
    networkInspectionTimeoutMs,
    environment = process.env,
    onNetworkState = () => {},
    onNotification = () => {},
    onServerRequest = () => {},
    onStderr = () => {},
    onExit = () => {},
  }) {
    this.codexPath = codexPath;
    this.cwd = cwd;
    this.clientVersion = clientVersion;
    this.spawnImpl = spawnImpl;
    this.networkMode = codexNetworkStatus(networkMode).mode;
    this.inspectFeatures = inspectFeatures;
    this.networkInspectionTimeoutMs = networkInspectionTimeoutMs;
    this.environment = environment;
    this.onNetworkState = onNetworkState;
    this.networkState = codexNetworkStatus(this.networkMode);
    this.onNotification = onNotification;
    this.onServerRequest = onServerRequest;
    this.onStderr = onStderr;
    this.onExit = onExit;
    this.nextId = 1;
    this.pending = new Map();
    this.process = null;
    this.reader = null;
    this.ready = false;
    this.stderr = "";
    this.initializeInfo = null;
    this.startPromise = null;
    this.startGeneration = 0;
  }

  start() {
    if (this.ready) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    const promise = this.#start().finally(() => {
      if (this.startPromise === promise) this.startPromise = null;
    });
    this.startPromise = promise;
    return promise;
  }

  async #start() {
    const generation = ++this.startGeneration;
    const environment = { ...this.environment };
    const publishNetworkState = (network) => {
      this.networkState = network;
      try { Promise.resolve(this.onNetworkState({ ...network })).catch(() => {}); }
      catch { /* observer failures cannot change routing */ }
    };
    if (this.networkMode === "system") {
      publishNetworkState(codexNetworkStatus(this.networkMode, { status: "checking" }));
    }
    let launch;
    try {
      launch = await prepareCodexNetworkLaunch({
        mode: this.networkMode,
        codexPath: this.codexPath,
        cwd: this.cwd,
        env: environment,
        inspectFeatures: this.inspectFeatures,
        inspectionTimeoutMs: this.networkInspectionTimeoutMs,
      });
    } catch (error) {
      publishNetworkState(codexNetworkStatus(this.networkMode, { status: "failed", errorCode: error.code }));
      throw error;
    }
    if (generation !== this.startGeneration) {
      throw new CodexWorkspaceError("runtime", "Codex 启动已取消；未启动新的后台进程。");
    }
    publishNetworkState(launch.network);
    this.process = this.spawnImpl(this.codexPath, launch.args, {
      cwd: this.cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.once("error", (error) => this.#failAll(error));
    this.process.once("close", (code, signal) => {
      const error = new Error(
        `Codex App Server exited${signal ? ` (${signal})` : ` (exit ${code ?? 1})`}${this.stderr ? `: ${this.stderr}` : ""}`,
      );
      this.#failAll(error);
      this.onExit(error);
    });
    this.process.stderr?.setEncoding("utf8");
    this.process.stderr?.on("data", (chunk) => {
      if (this.stderr.length < MAX_STDERR_BYTES) this.stderr += String(chunk).slice(0, MAX_STDERR_BYTES);
      this.onStderr(String(chunk));
    });
    this.reader = readline.createInterface({ input: this.process.stdout });
    this.reader.on("line", (line) => this.#acceptLine(line));
    try {
      this.initializeInfo = await this.request("initialize", {
        clientInfo: {
          name: "trading_cockpit",
          title: "交易驾驶舱",
          version: this.clientVersion,
        },
        capabilities: { experimentalApi: true },
      }, { timeoutMs: RPC_STARTUP_TIMEOUT_MS });
    } catch (error) {
      if (Number(error?.rpcCode) === -32602
        || /experimentalApi|experimental_api/i.test(String(error?.message ?? ""))) {
        throw createExperimentalApiInitializationError(error);
      }
      throw error;
    }
    this.notify("initialized", {});
    this.ready = true;
  }

  request(method, params = {}, { timeoutMs = RPC_REQUEST_TIMEOUT_MS } = {}) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new CodexWorkspaceError("timeout", `${method} 请求超时。`));
        }, timeoutMs)
        : null;
      timeout?.unref?.();
      this.pending.set(id, { resolve, reject, timeout, method });
    });
    try {
      this.#send({ method, id, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending?.timeout) clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending?.reject(error);
    }
    return promise;
  }

  notify(method, params = {}) {
    this.#send({ method, params });
  }

  respondError(id, code, message) {
    this.#send({ id, error: { code, message } });
  }

  respondResult(id, result) {
    this.#send({ id, result });
  }

  dispose() {
    this.startGeneration += 1;
    this.ready = false;
    this.reader?.close();
    this.reader = null;
    if (this.process && !this.process.killed) this.process.kill("SIGTERM");
    this.process = null;
    this.#failAll(new Error("Codex App Server connection closed."));
  }

  #send(message) {
    if (!this.process?.stdin?.writable) {
      throw new CodexWorkspaceError("runtime", "Codex App Server stdin 不可用。");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #acceptLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#failAll(new CodexWorkspaceError("protocol", "Codex App Server 返回了无效 JSON。"));
      return;
    }
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timeout) clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new CodexWorkspaceError(
          "rpc",
          `${message.error.message ?? "Codex RPC failed"} (${message.error.code ?? "unknown"})`,
          {
            rpcCode: message.error.code ?? null,
            rpcMethod: pending.method ?? null,
            rpcData: message.error.data ?? null,
          },
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (Object.hasOwn(message, "id") && message.method) {
      this.onServerRequest(message);
      return;
    }
    if (message.method) this.onNotification(message);
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class CodexWorkspaceError extends Error {
  constructor(kind, message, options = {}) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CodexWorkspaceError";
    this.kind = kind;
    this.rpcCode = options?.rpcCode ?? null;
    this.rpcMethod = options?.rpcMethod ?? null;
    this.rpcData = options?.rpcData ?? null;
  }
}

export async function resolveCodexExecutable({
  env = process.env,
  homeDirectory = os.homedir(),
  platform = process.platform,
} = {}) {
  const executable = platform === "win32" ? "codex.exe" : "codex";
  const candidates = [
    env.TRADING_COCKPIT_CODEX_BIN,
    platform === "darwin"
      ? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
      : null,
    platform === "darwin" ? "/Applications/ChatGPT.app/Contents/Resources/codex" : null,
    platform === "darwin"
      ? path.join(homeDirectory, "Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex")
      : null,
    platform === "darwin"
      ? path.join(homeDirectory, "Applications", "ChatGPT.app", "Contents", "Resources", "codex")
      : null,
    ...String(env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, executable)),
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try next path.
    }
  }
  return null;
}

export function buildCodexEvidence({ portfolio, run, task }) {
  const scope = ["chat", "position", "candidate", "portfolio", "review"].includes(run?.context?.scope)
    ? run.context.scope
    : "position";
  const position = scope === "position"
    ? portfolio?.positions?.find((item) => item.symbol === run?.context?.symbol)
    : null;
  if (scope === "position" && !position) {
    throw new Error("Codex evidence is missing the selected position.");
  }
  const scopedContext = run?.analysisContext ?? {
    scope,
    portfolioSummary: {
      snapshotAt: portfolio?.syncedAt ?? null,
      baseCurrency: portfolio?.account?.baseCurrency ?? "USD",
      cashRatioPercent: finiteOrNull(portfolio?.totals?.cashRatio),
      top1WeightPercent: finiteOrNull(portfolio?.totals?.top1Weight),
      top5WeightPercent: finiteOrNull(portfolio?.totals?.top5Weight),
    },
    target: null,
    risk: run?.risk ?? null,
  };
  assertResearchContextBoundary({ analysisScope: scope, context: run?.context, scopedContext });
  return {
    userTask: String(task ?? run.task ?? "分析当前持仓").slice(0, 1_000),
    project: {
      mode: "persistent_codex_workspace",
      workspace: "trading-agent-workspace",
      portfolioBaseCurrency: portfolio?.account?.baseCurrency ?? "USD",
    },
    analysisScope: scope,
    context: run.context,
    scopedContext,
    selectedPosition: position ? codexPosition(position) : null,
    candidateTarget: scope === "candidate" ? scopedContext.target ?? {
      symbol: run?.context?.symbol ?? null,
      ticker: run?.context?.ticker ?? null,
      isHeld: Boolean(run?.context?.isHeld),
    } : null,
    portfolioRisk: {
      baseCurrency: portfolio?.account?.baseCurrency ?? "USD",
      cashRatioPercent: finiteOrNull(portfolio?.totals?.cashRatio),
      top1WeightPercent: finiteOrNull(portfolio?.totals?.top1Weight),
      top5WeightPercent: finiteOrNull(portfolio?.totals?.top5Weight),
      selectedGroupWeightPercent: finiteOrNull(run.risk?.groupWeight),
      riskBudgetPercent: finiteOrNull(run.risk?.riskBudgetPercent),
      referenceLabel: run.risk?.referenceLabel ?? null,
      referenceLevel: finiteOrNull(run.risk?.referenceLevel),
      portfolioImpactAtReferencePercent: finiteOrNull(run.risk?.portfolioImpactAtReferencePercent),
      limitation: run.risk?.limitation ?? null,
    },
    // Full holdings exist once, inside scopedContext.positions, and only for a
    // portfolio-wide review. Position/candidate turns receive one target plus
    // aggregate risk context, keeping the active thread focused and smaller.
    technical: ["portfolio", "review"].includes(scope) ? null : run.technical,
    locallyVerifiedConditionalPlan: run.plan,
    dataQuality: {
      portfolioStatus: portfolio?.status ?? (scope === "chat" ? "not_attached_to_free_research" : "not_required_for_review"),
      valuationComplete: scope === "chat" ? null : portfolio?.dataQuality?.valuationComplete !== false,
      fxStatus: portfolio?.dataQuality?.fxStatus ?? "unknown",
      fxProvider: portfolio?.fx?.provider ?? null,
      fxAsOf: portfolio?.fx?.asOf ?? null,
      marketDataAsOf: run.context?.marketDataAsOf ?? null,
    },
    localEvidenceTrace: run.evidence,
  };
}

export function buildWorkspaceAdditionalContext(evidence, prompt) {
  assertResearchContextBoundary(evidence);
  const contexts = {
    "trading-cockpit-instructions": applicationContext(prompt),
  };
  const semanticOmissions = [];
  if (evidence?.analysisScope !== "review") {
    addStandardAnalysisContexts(contexts, evidence);
    const coverage = evidence?.scopedContext?.researchThesis?.coverage;
    for (const [collection, knownKey, includedKey, omittedKey] of [
      ["evidence", "evidenceKnownByCutoff", "evidenceIncluded", "evidenceOmitted"],
      ["observations", "observationsKnownByCutoff", "observationsIncluded", "observationsOmitted"],
    ]) {
      if (Number.isInteger(coverage?.[omittedKey]) && coverage[omittedKey] > 0) {
        semanticOmissions.push({ path: `researchThesis.${collection}`, sourceCount: coverage[knownKey],
          deliveredCount: coverage[includedKey], omittedCount: coverage[omittedKey],
          deliveryPolicy: "bounded_selected_thesis_recent_records",
          reason: "Only the explicitly selected bounded thesis context is supplied; the coverage object declares omitted known records. No omitted claim may be inferred.",
        });
      }
    }
    return finalizeWorkspaceAdditionalContext(contexts, evidence, semanticOmissions);
  }

  const scoped = evidence?.scopedContext ?? {};
  if (scoped.reviewProtocol === "decision_cycle") {
    const cycle = scoped?.cycle ?? {};
    const orders = Array.isArray(cycle.orders) ? cycle.orders : [];
    const executions = Array.isArray(cycle.executions) ? cycle.executions : [];
    const checkpoints = Array.isArray(cycle.checkpoints) ? cycle.checkpoints : [];
    const decisionTimeline = Array.isArray(cycle.decisionTimeline) ? cycle.decisionTimeline : [];
    const overview = {
      ...evidence,
      userTask: undefined,
      scopedContext: {
        ...scoped,
        pointInTimeTechnical: undefined,
        cycle: {
          ...cycle,
          orders: undefined,
          executions: undefined,
          checkpoints: undefined,
          decisionTimeline: undefined,
          sealedExAnte: undefined,
          blindAssessment: undefined,
          outcome: undefined,
          startingPortfolio: undefined,
          endingPortfolio: undefined,
          currentPortfolioContext: undefined,
          portfolioCoverage: undefined,
        },
        deterministicOutcomeMetrics: undefined,
      },
      evidenceDelivery: {
        format: "semantic_application_blocks",
        protocol: "review-decision-cycles",
        phase: scoped.phase,
        note: scoped.phase === "blind" && decisionTimeline.length
          ? "All blocks are valid JSON. The model receives all chronological node evidence capsules in this request, but each capsule contains only facts strictly earlier than that node's own knowledgeCutoffAt; cycle outcomes and facts after the last delivered node remain excluded."
          : "All blocks are valid JSON. Blind blocks have already had post-cutoff facts physically removed by the host.",
      },
    };
    addChunkedJsonContext(contexts, "trading-cockpit-evidence", overview);
    addChunkedJsonContext(contexts, "trading-cockpit-review-cycle-sealed", {
      cycleId: cycle.id ?? null,
      phase: scoped.phase ?? null,
      timeFirewall: scoped.timeFirewall ?? null,
      sealedExAnte: cycle.sealedExAnte ?? null,
      evidenceGrade: cycle.evidenceGrade ?? null,
      startingPortfolio: cycle.startingPortfolio ?? null,
    });
    const usesBlindTimelineCapsules = scoped.phase === "blind" && decisionTimeline.length > 0;
    // Timeline capsules already carry each broker fact exactly when it first
    // becomes knowable. Re-sending the latest visible broker set here would
    // duplicate evidence, waste context, and make an early-node double count
    // or backflow easier. Non-timeline and outcome reviews still receive the
    // ordinary global broker block.
    if (!usesBlindTimelineCapsules) {
      addChunkedArrayContext(
        contexts,
        "trading-cockpit-review-cycle-broker",
        { cycleId: cycle.id ?? null, phase: scoped.phase ?? null },
        "records",
        [...orders, ...executions],
      );
    }
    if (usesBlindTimelineCapsules) {
      decisionTimeline
        .slice()
        .sort((left, right) => Number(left?.timelineIndex ?? 0) - Number(right?.timelineIndex ?? 0))
        .forEach((node, index) => {
          addChunkedJsonContext(
            contexts,
            `trading-cockpit-review-cycle-timeline-node-${String(index + 1).padStart(3, "0")}`,
            {
              capsuleKind: "decision_timeline_node",
              sequence: index + 1,
              totalNodes: decisionTimeline.length,
              cycleId: cycle.id ?? null,
              phase: "blind",
              instruction: "只用本节点胶囊内、严格早于本节点 knowledgeCutoffAt 的事实评价该时点决策；完成并冻结本节点评价后，才处理下一节点。",
              node,
            },
          );
        });
    } else {
      addChunkedArrayContext(
        contexts,
        "trading-cockpit-review-cycle-checkpoints",
        { cycleId: cycle.id ?? null, phase: scoped.phase ?? null },
        "checkpoints",
        checkpoints,
      );
      addChunkedArrayContext(
        contexts,
        "trading-cockpit-review-cycle-technical",
        {
          cycleId: cycle.id ?? null,
          phase: scoped.phase ?? null,
          status: scoped?.pointInTimeTechnical?.status ?? "unavailable",
          asOf: scoped?.pointInTimeTechnical?.asOf ?? null,
          cutoffPolicy: scoped?.pointInTimeTechnical?.cutoffPolicy ?? null,
          requestedSymbols: scoped?.pointInTimeTechnical?.requestedSymbols ?? [],
          omittedSymbols: scoped?.pointInTimeTechnical?.omittedSymbols ?? [],
          warnings: scoped?.pointInTimeTechnical?.warnings ?? [],
        },
        "snapshots",
        scoped?.pointInTimeTechnical?.snapshots ?? [],
      );
    }
    if (["outcome", "retrospective"].includes(scoped.phase)) {
      const deterministicOutcomeMetrics = scoped?.deterministicOutcomeMetrics ?? {
        status: "unavailable",
        coverage: { reasons: ["host_metrics_not_provided"] },
        provenance: {
          deterministicHostCalculation: true,
          modelLookupAllowedAsMetricSubstitute: false,
        },
      };
      const tradePricePath = deterministicOutcomeMetrics?.tradePricePath ?? null;
      const outcomeMetricsWithoutTradePath = tradePricePath
        ? { ...deterministicOutcomeMetrics, tradePricePath: undefined }
        : deterministicOutcomeMetrics;
      addChunkedJsonContext(contexts, "trading-cockpit-review-cycle-outcome-metrics", {
        cycleId: cycle.id ?? null,
        metrics: outcomeMetricsWithoutTradePath,
      });
      if (tradePricePath) {
        const activities = boundedSemanticSequence(
          tradePricePath.activities,
          MAX_TRADE_PATH_ACTIVITIES,
        );
        const lots = boundedSemanticSequence(tradePricePath.lots, MAX_TRADE_PATH_LOTS);
        const segments = boundedSemanticSequence(
          Array.isArray(tradePricePath?.pricePath?.trend?.segments)
          ? tradePricePath.pricePath.trend.segments
          : [],
          MAX_TRADE_PATH_SEGMENTS,
        );
        const rawCycles = Array.isArray(tradePricePath.cycles) ? tradePricePath.cycles : [];
        const boundedRawCycles = boundedSemanticSequence(rawCycles, MAX_TRADE_PATH_CYCLES);
        const fifoCycleSegmentSourceCount = rawCycles.reduce((count, item) => (
          count + (Array.isArray(item?.pricePath?.trend?.segments)
            ? item.pricePath.trend.segments.length
            : 0)
        ), 0);
        recordSemanticProjection(semanticOmissions, "tradePricePath.activities", activities);
        recordSemanticProjection(semanticOmissions, "tradePricePath.lots", lots);
        recordSemanticProjection(semanticOmissions, "tradePricePath.cycles", boundedRawCycles);
        recordSemanticProjection(semanticOmissions, "tradePricePath.pricePath.trend.segments", segments);
        if (fifoCycleSegmentSourceCount > 0) {
          semanticOmissions.push({
            path: "tradePricePath.cycles[].pricePath.trend.segments",
            sourceCount: fifoCycleSegmentSourceCount,
            deliveredCount: 0,
            omittedCount: fifoCycleSegmentSourceCount,
            deliveryPolicy: "omitted_duplicate_detail",
            reason: "Use the complete host path summary, bounded overall segments and FIFO cycle summaries; duplicate per-cycle segment rows are not retransmitted.",
          });
        }
        const cycles = boundedRawCycles.items.map((item) => ({
          ...item,
          pricePath: item?.pricePath ? {
            ...item.pricePath,
            trend: item?.pricePath?.trend ? {
              ...item.pricePath.trend,
              segments: undefined,
            } : null,
          } : null,
        }));
        addChunkedJsonContext(contexts, "trading-cockpit-review-cycle-trade-path-meta", {
          cycleId: cycle.id ?? null,
          phase: scoped.phase,
          evidenceRevision: cycle?.brokerAssociation?.evidenceRevision ?? cycle?.evidenceRevision ?? null,
          instruction: "Only the explicitly selected order/fill anchors define this Buy-to-Sell window. Supplemental parent or sibling records never expand it. Analyze the supplied daily or three-trading-session trend without substituting another historical window. If an agent-context sequence reports omittedCount, do not infer the omitted rows; use the complete host summary and explicitly disclose that row-level evidence was bounded.",
          agentContextProjection: {
            activities: semanticSequenceCoverage(activities),
            lots: semanticSequenceCoverage(lots),
            fifoCycles: semanticSequenceCoverage(boundedRawCycles),
            overallSegments: semanticSequenceCoverage(segments),
            fifoCycleSegments: {
              sourceCount: fifoCycleSegmentSourceCount,
              deliveredCount: 0,
              omittedCount: fifoCycleSegmentSourceCount,
              deliveryPolicy: "omitted_duplicate_detail",
            },
          },
          tradePricePath: {
            ...tradePricePath,
            activities: undefined,
            lots: undefined,
            cycles: undefined,
            pricePath: tradePricePath?.pricePath ? {
              ...tradePricePath.pricePath,
              trend: tradePricePath?.pricePath?.trend ? {
                ...tradePricePath.pricePath.trend,
                segments: undefined,
              } : null,
            } : null,
          },
        });
        addChunkedArrayContext(
          contexts,
          "trading-cockpit-review-cycle-trade-path-activities",
          {
            cycleId: cycle.id ?? null,
            phase: scoped.phase,
            ...semanticSequenceCoverage(activities),
          },
          "activities",
          activities.items,
        );
        addChunkedArrayContext(
          contexts,
          "trading-cockpit-review-cycle-trade-path-lots",
          {
            cycleId: cycle.id ?? null,
            phase: scoped.phase,
            ...semanticSequenceCoverage(lots),
          },
          "lots",
          lots.items,
        );
        addChunkedArrayContext(
          contexts,
          "trading-cockpit-review-cycle-trade-path-cycles",
          {
            cycleId: cycle.id ?? null,
            phase: scoped.phase,
            ...semanticSequenceCoverage(boundedRawCycles),
          },
          "cycles",
          cycles,
        );
        addChunkedArrayContext(
          contexts,
          "trading-cockpit-review-cycle-trade-path-segments",
          {
            cycleId: cycle.id ?? null,
            phase: scoped.phase,
            granularity: tradePricePath?.pricePath?.trend?.granularity ?? null,
            segmentTradingDays: tradePricePath?.pricePath?.trend?.segmentTradingDays ?? null,
            ...semanticSequenceCoverage(segments),
          },
          "segments",
          segments.items,
        );
      }
      addChunkedJsonContext(contexts, "trading-cockpit-review-cycle-outcome", {
        cycleId: cycle.id ?? null,
        blindAssessment: cycle.blindAssessment ?? null,
        outcome: cycle.outcome ?? null,
        endingPortfolio: cycle.endingPortfolio ?? null,
        currentPortfolioContext: cycle.currentPortfolioContext ?? null,
        portfolioCoverage: cycle.portfolioCoverage ?? null,
      });
    }
    return finalizeWorkspaceAdditionalContext(contexts, evidence, semanticOmissions);
  }
  const cases = Array.isArray(scoped.cases) ? scoped.cases : [];
  const tests = Array.isArray(scoped.tests) ? scoped.tests : [];
  const rules = Array.isArray(scoped.rules) ? scoped.rules : [];
  // Long validation ledgers are a poor numerical interface for the model.
  // Keep the complete host-calculated reviewSetMetrics in the overview, while
  // sending only an explicitly declared head/tail sample of raw test rows for
  // qualitative inspection.
  const testProjection = boundedSemanticSequence(tests, 36);
  if (testProjection.omittedCount > 0) {
    semanticOmissions.push({
      path: "review.tests",
      ...semanticSequenceCoverage(testProjection),
      reason: "Complete verified statistics remain in reviewSetMetrics; raw test rows are a declared head/tail qualitative projection.",
    });
  }
  const overview = {
    ...evidence,
    userTask: undefined,
    scopedContext: {
      ...scoped,
      cases: undefined,
      tests: undefined,
      rules: undefined,
      caseIndex: cases.map((item, index) => ({
        caseRef: `case-${index + 1}`,
        id: item?.id ?? null,
        symbol: item?.symbol ?? null,
        fiscalQuarter: item?.fiscalQuarter ?? null,
        orderCount: Array.isArray(item?.orders) ? item.orders.length : 0,
        executionCount: Array.isArray(item?.executions) ? item.executions.length : 0,
      })),
    },
    evidenceDelivery: {
      format: "semantic_application_blocks",
      brokerFacts: "trading-cockpit-review-case-*-broker-*",
      decisionEvidence: "trading-cockpit-review-case-*-decision-*",
      note: "Each block is valid JSON; combine blocks with the same caseRef before judging evidence completeness.",
    },
  };
  addChunkedJsonContext(contexts, "trading-cockpit-evidence", overview);

  cases.forEach((item, index) => {
    const caseRef = `case-${index + 1}`;
    const brokerCore = {
      caseRef,
      id: item?.id ?? null,
      symbol: item?.symbol ?? null,
      fiscalQuarter: item?.fiscalQuarter ?? null,
      event: item?.event ?? null,
      brokerAssociation: item?.brokerAssociation ?? null,
    };
    const brokerRecords = [
      ...(Array.isArray(item?.orders) ? item.orders : []),
      ...(Array.isArray(item?.executions) ? item.executions : []),
    ];
    addChunkedArrayContext(
      contexts,
      `trading-cockpit-review-${caseRef}-broker`,
      brokerCore,
      "records",
      brokerRecords,
    );
    addChunkedJsonContext(contexts, `trading-cockpit-review-${caseRef}-decision`, {
      caseRef,
      id: item?.id ?? null,
      symbol: item?.symbol ?? null,
      strategyType: item?.strategyType ?? null,
      benchmark: item?.benchmark ?? null,
      primaryHorizon: item?.primaryHorizon ?? null,
      status: item?.status ?? null,
      createdAt: item?.createdAt ?? null,
      updatedAt: item?.updatedAt ?? null,
      exAnteDraft: item?.exAnteDraft ?? null,
      exAnteVersions: item?.exAnteVersions ?? [],
      outcome: item?.outcome ?? null,
      review: item?.review ?? null,
      ruleIds: item?.ruleIds ?? [],
    });
  });
  addChunkedArrayContext(
    contexts,
    "trading-cockpit-review-tests",
    semanticSequenceCoverage(testProjection),
    "tests",
    testProjection.items,
  );
  addChunkedArrayContext(contexts, "trading-cockpit-review-rules", {}, "rules", rules);
  return finalizeWorkspaceAdditionalContext(contexts, evidence, semanticOmissions);
}

function addStandardAnalysisContexts(contexts, evidence) {
  const scoped = evidence?.scopedContext ?? {};
  const scopedTechnical = scoped?.technical ?? null;
  const priceBars = Array.isArray(scopedTechnical?.priceBars)
    ? scopedTechnical.priceBars
    : [];
  const positions = Array.isArray(scoped?.positions) ? scoped.positions : [];
  const evidenceHash = hashContextValue(evidence);
  const delivery = {
    schemaVersion: "trading-cockpit-context/v2",
    format: "semantic_application_blocks",
    evidenceHash,
    instruction: "每个块都是独立有效 JSON。相同 evidenceHash 的全部块共同组成一次证据快照；不得把 omitted、unavailable 或 null 补写成0或模型事实。",
  };
  addChunkedJsonContext(contexts, "trading-cockpit-evidence", {
    ...delivery,
    block: "index",
    project: evidence?.project ?? null,
    analysisScope: evidence?.analysisScope ?? null,
    context: evidence?.context ?? null,
    dataQuality: evidence?.dataQuality ?? null,
    blockIndex: [
      "portfolio",
      "target",
      "positions",
      ...(evidence?.analysisScope === "portfolio" ? ["technical-radar", "technical-radar-cards"] : []),
      "technical",
      "price-bars",
      "numeric-evidence",
      "risk",
      "conditional-plan",
      "evidence-trace",
      ...(scoped.researchThesis ? ["research-thesis"] : []),
    ],
  });
  addChunkedJsonContext(contexts, "trading-cockpit-evidence-portfolio", {
    ...delivery,
    block: "portfolio",
    portfolioSummary: scoped?.portfolioSummary ?? null,
    portfolioRiskSummary: evidence?.portfolioRisk ?? null,
    groupExposure: scoped?.groupExposure ?? null,
    groupNetExposure: scoped?.groupNetExposure ?? null,
    currencyExposure: scoped?.currencyExposure ?? null,
    cashByCurrency: scoped?.cashByCurrency ?? null,
  });
  addChunkedJsonContext(contexts, "trading-cockpit-evidence-target", {
    ...delivery,
    block: "target",
    target: scoped?.target ?? evidence?.candidateTarget ?? null,
    selectedPosition: evidence?.selectedPosition ?? null,
  });
  if (scoped.researchThesis) {
    addChunkedJsonContext(contexts, "trading-cockpit-evidence-research-thesis", {
      ...delivery,
      block: "research-thesis",
      researchThesis: scoped.researchThesis,
    });
  }
  if (positions.length) {
    addChunkedArrayContext(
      contexts,
      "trading-cockpit-evidence-positions",
      {
        ...delivery,
        block: "positions",
        sourceCount: positions.length,
        deliveredCount: positions.length,
        omittedCount: 0,
      },
      "positions",
      positions,
    );
  }
  if (evidence?.analysisScope === "portfolio") {
    const radar = scoped.technicalRadar ?? { available: false, reason: "technical_radar_not_supplied", cards: [] };
    const { cards = [], ...radarMetadata } = radar;
    addChunkedJsonContext(contexts, "trading-cockpit-evidence-radar", {
      ...delivery, block: "technical-radar", technicalRadar: radarMetadata,
    });
    addChunkedArrayContext(contexts, "trading-cockpit-evidence-radar-cards", {
      ...delivery, block: "technical-radar-cards",
      batchId: radar.batchId ?? null,
      sourceCount: cards.length, deliveredCount: cards.length, omittedCount: 0,
    }, "cards", cards);
  }
  const technical = evidence?.technical
    ? evidence.technical
    : scopedTechnical
      ? { ...scopedTechnical, priceBars: undefined }
      : null;
  addChunkedJsonContext(contexts, "trading-cockpit-evidence-technical", {
    ...delivery,
    block: "technical",
    technical,
  });
  addChunkedArrayContext(
    contexts,
    "trading-cockpit-evidence-price-bars",
    {
      ...delivery,
      block: "price-bars",
      sourceCount: priceBars.length,
      deliveredCount: priceBars.length,
      omittedCount: 0,
      rowsHash: hashContextValue(priceBars),
    },
    "priceBars",
    priceBars,
  );
  addChunkedArrayContext(
    contexts,
    "trading-cockpit-evidence-numeric",
    {
      ...delivery,
      block: "numeric-evidence",
      packageVersion: scoped?.numericEvidence?.packageVersion ?? null,
      schemaVersion: scoped?.numericEvidence?.schemaVersion ?? null,
      status: scoped?.numericEvidence?.status ?? "unavailable",
      sourceCount: Array.isArray(scoped?.numericEvidence?.facts)
        ? scoped.numericEvidence.facts.length
        : 0,
      deliveredCount: Array.isArray(scoped?.numericEvidence?.facts)
        ? scoped.numericEvidence.facts.length
        : 0,
      omittedCount: 0,
      invariants: scoped?.numericEvidence?.invariants ?? null,
    },
    "facts",
    Array.isArray(scoped?.numericEvidence?.facts) ? scoped.numericEvidence.facts : [],
  );
  addChunkedJsonContext(contexts, "trading-cockpit-evidence-risk", {
    ...delivery,
    block: "risk",
    risk: scoped?.risk ?? null,
  });
  addChunkedJsonContext(contexts, "trading-cockpit-evidence-plan", {
    ...delivery,
    block: "conditional-plan",
    locallyVerifiedConditionalPlan: evidence?.locallyVerifiedConditionalPlan ?? null,
  });
  addChunkedArrayContext(
    contexts,
    "trading-cockpit-evidence-trace",
    {
      ...delivery,
      block: "evidence-trace",
      sourceCount: Array.isArray(evidence?.localEvidenceTrace)
        ? evidence.localEvidenceTrace.length
        : 0,
      deliveredCount: Array.isArray(evidence?.localEvidenceTrace)
        ? evidence.localEvidenceTrace.length
        : 0,
      omittedCount: 0,
    },
    "evidenceTrace",
    Array.isArray(evidence?.localEvidenceTrace) ? evidence.localEvidenceTrace : [],
  );
}

function hashContextValue(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Validate source-to-wire semantics, not merely hashes of already-built blocks. */
export function validateWorkspaceEvidenceDelivery(evidence, contexts) {
  assertResearchContextBoundary(evidence);
  if (evidence?.analysisScope === "review") {
    try {
      return validateReviewEvidenceDelivery(evidence, contexts, {
        activities: MAX_TRADE_PATH_ACTIVITIES, lots: MAX_TRADE_PATH_LOTS,
        cycles: MAX_TRADE_PATH_CYCLES, segments: MAX_TRADE_PATH_SEGMENTS,
      });
    } catch (error) {
      throw new CodexWorkspaceError("context_contract", `${error.message}；已拒绝发送。`);
    }
  }
  const documents = [];
  const fragments = new Map();
  for (const [key, block] of Object.entries(contexts)) {
    if (!key.startsWith("trading-cockpit-evidence")) continue;
    let value;
    try { value = JSON.parse(block.value); } catch {
      throw new CodexWorkspaceError("context_contract", `模型证据块不是有效 JSON：${key}`);
    }
    if (value?.encoding === "json-fragment") {
      const group = key.replace(/-\d+$/, "");
      if (!fragments.has(group)) fragments.set(group, []);
      fragments.get(group).push(value);
    } else documents.push(value);
  }
  for (const [key, parts] of fragments) {
    parts.sort((a, b) => a.part - b.part);
    if (parts.length !== parts[0].parts
      || parts.some((part, index) => part.part !== index + 1 || part.parts !== parts.length)) {
      throw new CodexWorkspaceError("context_contract", `模型证据分片不完整：${key}`);
    }
    try { documents.push(JSON.parse(parts.map((part) => part.fragment).join(""))); } catch {
      throw new CodexWorkspaceError("context_contract", `模型证据分片无法还原：${key}`);
    }
  }
  const field = (block, key) => documents.find((document) => document.block === block)?.[key];
  const rows = (block, key) => documents.filter((document) => document.block === block)
    .sort((a, b) => (a.part ?? 0) - (b.part ?? 0)).flatMap((document) => document[key] ?? []);
  const scoped = evidence?.scopedContext ?? {};
  const semanticHash = (value) => hashContextValue(sortJsonKeys(JSON.parse(JSON.stringify(value))));
  const checks = [
    ["project", evidence?.project ?? null, field("index", "project")],
    ["context", evidence?.context ?? null, field("index", "context")],
    ["scopedContext.portfolioSummary", scoped.portfolioSummary ?? null, field("portfolio", "portfolioSummary")],
    ["portfolioRisk", evidence?.portfolioRisk ?? null, field("portfolio", "portfolioRiskSummary")],
    ["scopedContext.target", scoped.target ?? evidence?.candidateTarget ?? null, field("target", "target")],
    ["selectedPosition", evidence?.selectedPosition ?? null, field("target", "selectedPosition")],
    ["technical", evidence?.technical ?? (scoped.technical ? { ...scoped.technical, priceBars: undefined } : null), field("technical", "technical")],
    ["scopedContext.risk", scoped.risk ?? null, field("risk", "risk")],
    ["locallyVerifiedConditionalPlan", evidence?.locallyVerifiedConditionalPlan ?? null, field("conditional-plan", "locallyVerifiedConditionalPlan")],
    ["scopedContext.positions", scoped.positions ?? [], rows("positions", "positions")],
    ["scopedContext.technical.priceBars", scoped.technical?.priceBars ?? [], rows("price-bars", "priceBars")],
    ["scopedContext.numericEvidence.facts", scoped.numericEvidence?.facts ?? [], rows("numeric-evidence", "facts")],
    ["localEvidenceTrace", evidence?.localEvidenceTrace ?? [], rows("evidence-trace", "evidenceTrace")],
  ];
  if (scoped.researchThesis) {
    checks.push(["scopedContext.researchThesis", scoped.researchThesis, field("research-thesis", "researchThesis")]);
  } else if (documents.some(document => document.block === "research-thesis")) {
    throw new CodexWorkspaceError("context_contract", "本轮未显式选择研究记录，不能额外注入研究主线上下文。");
  }
  if (evidence?.analysisScope === "portfolio") {
    const radar = scoped.technicalRadar ?? { available: false, reason: "technical_radar_not_supplied", cards: [] };
    checks.push(["scopedContext.technicalRadar", { ...radar, cards: radar.cards ?? [] }, {
      ...field("technical-radar", "technicalRadar"), cards: rows("technical-radar-cards", "cards"),
    }]);
    for (const key of ["groupExposure", "groupNetExposure", "currencyExposure", "cashByCurrency"]) {
      checks.push([`scopedContext.${key}`, scoped[key] ?? null, field("portfolio", key)]);
    }
  }
  return checks.map(([sourcePath, expected, actual]) => {
    if (actual === undefined || semanticHash(expected) !== semanticHash(actual)) {
      throw new CodexWorkspaceError("context_contract", `模型证据交付未覆盖必需字段 ${sourcePath}；已拒绝发送，避免把缺失证据标为完整。`);
    }
    return { sourcePath, status: "verified", sha256: `sha256:${semanticHash(expected)}` };
  });
}

function assertResearchContextBoundary(evidence) {
  const scoped = evidence?.scopedContext ?? {};
  const phase = evidence?.context?.reviewPhase ?? scoped.phase;
  if (evidence?.analysisScope === "review" && phase === "blind"
    && (scoped.researchReferences != null || scoped.researchThesis != null
      || evidence?.context?.researchThesisId != null)) {
    throw new CodexWorkspaceError("context_contract", "盲态复盘不得携带研究主线或事后关联材料；本轮已停止，未发送可能穿越截止点的信息。");
  }
  if (scoped.researchReferences != null
    && (evidence?.analysisScope !== "review" || !["outcome", "retrospective"].includes(phase))) {
    throw new CodexWorkspaceError("context_contract", "关联研究材料仅可用于明确的结果或直接事后复盘。");
  }
  const selected = scoped.researchThesis;
  const selectedId = evidence?.context?.researchThesisId;
  if (selected == null && selectedId == null) return;
  if (evidence?.analysisScope !== "chat" || !selected || typeof selected !== "object"
    || Array.isArray(selected) || typeof selectedId !== "string" || !selectedId.trim()
    || selected.id !== selectedId
    || !["discuss", "update"].includes(evidence?.context?.researchIntent)) {
    throw new CodexWorkspaceError("context_contract", "研究主线缺少明确匹配的记录 ID、上下文或研究意图；未发送未选择的研究材料。");
  }
  const revision = evidence?.context?.researchThesisRevision;
  if (!Number.isInteger(revision) || revision < 1
    || selected.revision !== revision || selected.available === false) {
    throw new CodexWorkspaceError("context_contract", "研究主线版本与本轮选择不匹配；请重新选择记录后分析。");
  }
}

function sortJsonKeys(value) {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonKeys(value[key])]));
}

function applicationContext(value) {
  return { kind: "application", value: String(value ?? "") };
}

function boundedSemanticSequence(values, maximum) {
  const source = Array.isArray(values) ? values : [];
  const limit = Math.max(1, Math.floor(Number(maximum) || 1));
  if (source.length <= limit) {
    return {
      items: source,
      sourceCount: source.length,
      deliveredCount: source.length,
      omittedCount: 0,
      deliveryPolicy: "complete",
    };
  }
  const headCount = Math.ceil(limit / 2);
  const tailCount = limit - headCount;
  return {
    items: [
      ...source.slice(0, headCount),
      ...(tailCount ? source.slice(-tailCount) : []),
    ],
    sourceCount: source.length,
    deliveredCount: limit,
    omittedCount: source.length - limit,
    // The first Buy and latest Sell / final segment live at the boundaries.
    // Preserve both ends instead of silently truncating the exit evidence.
    deliveryPolicy: "bounded_head_and_tail_preserving_window_boundaries",
  };
}

function semanticSequenceCoverage(value) {
  return {
    sourceCount: value.sourceCount,
    deliveredCount: value.deliveredCount,
    omittedCount: value.omittedCount,
    deliveryPolicy: value.deliveryPolicy,
  };
}

function recordSemanticProjection(omissions, path, projection) {
  if (!projection || Number(projection.omittedCount) <= 0) return;
  omissions.push({
    path,
    sourceCount: projection.sourceCount,
    deliveredCount: projection.deliveredCount,
    omittedCount: projection.omittedCount,
    deliveryPolicy: projection.deliveryPolicy,
    reason: "The host retained the complete deterministic summary and delivered a declared head/tail row projection.",
  });
}

function addChunkedArrayContext(contexts, prefix, metadata, field, items) {
  const values = Array.isArray(items) ? items : [];
  if (!values.length) {
    addChunkedJsonContext(contexts, prefix, { ...metadata, [field]: [] });
    return;
  }
  const chunks = [];
  let current = [];
  for (const item of values) {
    const candidate = [...current, item];
    if (current.length && JSON.stringify({
      ...metadata,
      part: 999,
      parts: 999,
      [field]: candidate,
    }).length > MAX_APPLICATION_CONTEXT_CHARS) {
      chunks.push(current);
      current = [item];
    } else {
      current = candidate;
    }
  }
  if (current.length) chunks.push(current);
  chunks.forEach((chunk, index) => addChunkedJsonContext(
    contexts,
    `${prefix}-${index + 1}`,
    { ...metadata, part: index + 1, parts: chunks.length, [field]: chunk },
  ));
}

function addChunkedJsonContext(contexts, prefix, value) {
  const serialized = JSON.stringify(value);
  if (serialized.length <= MAX_APPLICATION_CONTEXT_CHARS) {
    contexts[prefix] = applicationContext(serialized);
    return;
  }
  const fragments = splitSerializedContext(serialized);
  fragments.forEach((fragment, index) => {
    contexts[`${prefix}-${index + 1}`] = applicationContext(JSON.stringify({
      encoding: "json-fragment",
      part: index + 1,
      parts: fragments.length,
      fragment,
    }));
  });
}

function splitSerializedContext(serialized) {
  const fragments = [];
  let cursor = 0;
  while (cursor < serialized.length) {
    let low = cursor + 1;
    let high = serialized.length;
    let best = low;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = JSON.stringify({
        encoding: "json-fragment",
        part: 999,
        parts: 999,
        fragment: serialized.slice(cursor, middle),
      });
      if (candidate.length <= MAX_APPLICATION_CONTEXT_CHARS) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    fragments.push(serialized.slice(cursor, best));
    cursor = best;
  }
  return fragments;
}

function finalizeWorkspaceAdditionalContext(contexts, evidence, semanticOmissions = []) {
  const requiredFieldCoverage = validateWorkspaceEvidenceDelivery(evidence, contexts);
  if (Object.hasOwn(contexts, WORKSPACE_CONTEXT_MANIFEST_PREFIX)) {
    throw new CodexWorkspaceError("context_manifest", "上下文证据包包含保留的 manifest 名称。");
  }
  const payloadEntries = Object.entries(contexts)
    .sort(([left], [right]) => left.localeCompare(right));
  const blockDescriptors = payloadEntries.map(([key, block]) => ({
    key,
    kind: block?.kind ?? null,
    characters: String(block?.value ?? "").length,
    utf8Bytes: Buffer.byteLength(String(block?.value ?? ""), "utf8"),
    sha256: `sha256:${createHash("sha256").update(String(block?.value ?? "")).digest("hex")}`,
  }));
  const bundleHash = `sha256:${createHash("sha256")
    .update(JSON.stringify(payloadEntries.map(([key, block]) => [
      key,
      block?.kind ?? null,
      String(block?.value ?? ""),
    ])))
    .digest("hex")}`;
  const normalizedOmissions = semanticOmissions
    .filter((item) => item && Number(item.omittedCount) > 0)
    .map((item) => ({
      path: String(item.path ?? "unknown"),
      sourceCount: Math.max(0, Number(item.sourceCount) || 0),
      deliveredCount: Math.max(0, Number(item.deliveredCount) || 0),
      omittedCount: Math.max(0, Number(item.omittedCount) || 0),
      deliveryPolicy: String(item.deliveryPolicy ?? "declared_omission"),
      reason: String(item.reason ?? "Declared semantic projection."),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const payloadCharacters = blockDescriptors.reduce((sum, item) => sum + item.characters, 0);
  const payloadUtf8Bytes = blockDescriptors.reduce((sum, item) => sum + item.utf8Bytes, 0);
  const manifestBase = {
    schemaVersion: "trading-cockpit-context-manifest/v1",
    bundleHash,
    analysisScope: evidence?.analysisScope ?? null,
    reviewProtocol: evidence?.context?.reviewProtocol
      ?? evidence?.scopedContext?.reviewProtocol
      ?? null,
    reviewPhase: evidence?.context?.reviewPhase
      ?? evidence?.scopedContext?.phase
      ?? null,
    deliveryStatus: normalizedOmissions.length
      ? "complete_with_declared_omissions"
      : "complete",
    silentlyTruncated: false,
    semanticOmissions: normalizedOmissions,
    requiredFieldCoverage,
    blocks: blockDescriptors,
  };
  let manifestContexts = {};
  let budget = {
    maximumCharacters: MAX_WORKSPACE_ADDITIONAL_CONTEXT_CHARS,
    maximumUtf8Bytes: MAX_WORKSPACE_ADDITIONAL_CONTEXT_UTF8_BYTES,
    maximumBlocks: MAX_WORKSPACE_ADDITIONAL_CONTEXT_BLOCKS,
    payloadCharacters,
    payloadUtf8Bytes,
    payloadBlockCount: blockDescriptors.length,
    manifestCharacters: 0,
    manifestUtf8Bytes: 0,
    manifestBlockCount: 0,
    totalCharacters: payloadCharacters,
    totalUtf8Bytes: payloadUtf8Bytes,
    totalBlockCount: blockDescriptors.length,
  };
  // The manifest describes its own transport footprint. Rebuild until the
  // digit widths and fragment count stabilize; no timestamps enter the hash.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    manifestContexts = {};
    addChunkedJsonContext(manifestContexts, WORKSPACE_CONTEXT_MANIFEST_PREFIX, {
      ...manifestBase,
      budget,
    });
    const manifestValues = Object.values(manifestContexts).map((item) => String(item?.value ?? ""));
    const nextBudget = {
      ...budget,
      manifestCharacters: manifestValues.reduce((sum, value) => sum + value.length, 0),
      manifestUtf8Bytes: manifestValues.reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0),
      manifestBlockCount: manifestValues.length,
    };
    nextBudget.totalCharacters = payloadCharacters + nextBudget.manifestCharacters;
    nextBudget.totalUtf8Bytes = payloadUtf8Bytes + nextBudget.manifestUtf8Bytes;
    nextBudget.totalBlockCount = blockDescriptors.length + nextBudget.manifestBlockCount;
    if (JSON.stringify(nextBudget) === JSON.stringify(budget)) {
      budget = nextBudget;
      break;
    }
    budget = nextBudget;
  }
  // One final build ensures the embedded budget equals the actual manifest
  // values returned to App Server.
  manifestContexts = {};
  addChunkedJsonContext(manifestContexts, WORKSPACE_CONTEXT_MANIFEST_PREFIX, {
    ...manifestBase,
    budget,
  });
  const manifestValues = Object.values(manifestContexts).map((item) => String(item?.value ?? ""));
  const actualBudget = {
    ...budget,
    manifestCharacters: manifestValues.reduce((sum, value) => sum + value.length, 0),
    manifestUtf8Bytes: manifestValues.reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0),
    manifestBlockCount: manifestValues.length,
  };
  actualBudget.totalCharacters = payloadCharacters + actualBudget.manifestCharacters;
  actualBudget.totalUtf8Bytes = payloadUtf8Bytes + actualBudget.manifestUtf8Bytes;
  actualBudget.totalBlockCount = blockDescriptors.length + actualBudget.manifestBlockCount;

  const rejected = actualBudget.totalCharacters > MAX_WORKSPACE_ADDITIONAL_CONTEXT_CHARS
    || actualBudget.totalUtf8Bytes > MAX_WORKSPACE_ADDITIONAL_CONTEXT_UTF8_BYTES
    || actualBudget.totalBlockCount > MAX_WORKSPACE_ADDITIONAL_CONTEXT_BLOCKS;
  const diagnostics = {
    schemaVersion: manifestBase.schemaVersion,
    bundleHash,
    deliveryStatus: rejected
      ? "rejected_budget"
      : manifestBase.deliveryStatus,
    silentlyTruncated: false,
    ...actualBudget,
    semanticOmissions: normalizedOmissions,
    requiredFieldCoverage,
  };
  if (rejected) {
    const error = new CodexWorkspaceError(
      "context_budget",
      `本轮证据上下文超过安全上限（${actualBudget.totalCharacters}/${MAX_WORKSPACE_ADDITIONAL_CONTEXT_CHARS} 字符，${actualBudget.totalBlockCount}/${MAX_WORKSPACE_ADDITIONAL_CONTEXT_BLOCKS} 块）；系统已拒绝发送且没有静默截断。请缩小复盘范围或拆分周期。`,
    );
    error.contextDiagnostics = diagnostics;
    throw error;
  }

  const result = { ...contexts, ...manifestContexts };
  Object.defineProperty(result, WORKSPACE_CONTEXT_DIAGNOSTICS, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: diagnostics,
  });
  return result;
}

export function workspaceContextDiagnostics(contexts) {
  const diagnostics = contexts?.[WORKSPACE_CONTEXT_DIAGNOSTICS];
  return diagnostics ? structuredClone(diagnostics) : null;
}

export function buildWorkspacePrompt(evidence) {
  const reviewProtocol = evidence?.context?.reviewProtocol
    ?? evidence?.scopedContext?.reviewProtocol;
  const reviewPhase = evidence?.context?.reviewPhase
    ?? evidence?.scopedContext?.phase;
  const scopeInstruction = evidence.analysisScope === "chat"
    ? "本轮是自由研究与讨论：不要求已经持仓、先同步券商或先选择股票。按照用户问题选择基本面、估值、预期差、宏观、技术面、期权或组合方法，不强制输出 EMA/Fib 或交易计划。当前没有自动附加账户、实时价格或技术数据；不得编造持仓、成本、实时数值或可执行数量。可使用本会话可用的 Skills、网页、文件或研究工具，引用具体来源和时间；缺失数据时提供有边界的研究结论和下一步，而不是阻止普通讨论。真实交易始终由用户在券商端确认。"
    : evidence.analysisScope === "candidate"
    ? "本轮是候选买入分析：目标可能完全未持有，不得把候选标的写成现有仓位。你负责结合叙事/技术 Skills、priceBars 与可用只读 MCP，独立判断 Stage、失效依据、持有周期、压力情景、初始新增仓位和最大总仓位。证据框架是开放的：优先交叉核对价格/成交量、趋势与动量、相对强弱、板块和同行、成本分布代理、AVWAP、波动率/期权、催化剂后的价格反应；EMA 与 Fib 只是可选证据，不能机械使用，也不要求每轮输出。如果确有共振再提交 fibReview；不适用时填 null。Fib 覆盖锚点只能引用 priceBars 中真实存在的 barId 与 high/low 字段。若 AVWAP 对判断有真实增量，只能在 anchoredVwapReview 中选择一个 priceBars 的真实 barId，并写清事件/结构理由；宿主将用已完成 HLC3×成交量重新计算，禁止为了贴合结论自动挑锚，不适用时明确 ignore。失效依据可引用真实 bar、可用 EMA、20 日区间或经选择的 Fib；第一阶段 AVWAP 仅为辅助证据，不能直接成为仓位或失效依据。stressTest 必须独立于技术止损，明确 gap、事件、流动性或工具最大损失情景的单标的损失百分比和退出滑点；缺少压力情景时宿主只保留研究，不会接受可执行仓位。仓位数字由你提出，宿主会同时按 planned risk 与 stress risk，再结合最新快照、购买力、现金、集中度、组合毛暴露 150% 硬上限、风险预算、保证金和数据完整性做硬性验证/裁剪。leverageDecision 只有在明确接受融资且投影毛暴露不超过 150% 时选择 margin_within_cap；否则选择 cash_only 或 disabled。candidateGroupKey 可使用已有主题的精确 key，也可在高/中置信度下给出明确的新主题；无法可靠分类时填 null，且不得给出可执行仓位。analysisMarkdown 保持适合深色界面的清晰 Markdown；其中的仓位数字必须称为“LLM 建议”，不得预先声称已被宿主接受，最终有效值以后续 HOST ACCEPTED 卡片为准。"
    : evidence.analysisScope === "portfolio"
      ? "本轮是全组合分析：必须评价集中度、主题/币种重复暴露、现金、保证金、估值缺口和最大的组合级失败模式；不要逐只虚构技术结论。"
      : evidence.analysisScope === "review"
        ? reviewProtocol === "decision_cycle"
          ? reviewPhase === "outcome"
            ? "本轮是决策周期阶段二结果复盘：必须调用 review-decision-cycles Skill。先核对已冻结 blindAssessment 的 resultHash、summaryHash 与 truncated；只有 truncated=false 才能把 summary 作为完整原文引用，否则必须明确标为节选并停止正式归因。随后再揭示后续券商事实、市场路径和组合快照；分别评价判断、技术时点、仓位、执行与运气。trading-cockpit-review-cycle-outcome-metrics 是宿主截至 endAt 用关联成交与长桥日线计算的确定性事实：可用项必须优先引用，不可用项必须保留 null 和 reason，禁止用网页、MCP 临时查询或当前持仓补成确定性指标。若存在 trading-cockpit-review-cycle-trade-path-*，它是用户明确框选订单/成交所定义 Buy→Sell 窗口的唯一宿主路径：系统补充的父订单或同单成交不得扩窗；跨度超过 3 个交易日时，必须按已提供的连续 3 交易日分段分析，禁止另查历史首笔交易或替代窗口。不得覆盖或润色阶段一判断，不得把回顾性记录升级为事前证据。EMA/Fib 只是可选证据，叙事 Stage 与技术温度必须独立。规则只能成为候选或已登记测试，任何晋级等待人工 Review。如证据足以形成可检验学习，可额外返回 learningProposal 验证草案；testDesign.metric 只能是 net_r、expectancy_r、win_rate、payoff_ratio，并必须给出可编辑的 successOperator(gt/gte/lt/lte) 与数值 successThreshold；最终 passed 只由宿主计算，模型不得声明。其 evidencePosture 必须是 retrospective_not_ex_ante，且必须声明它不能冒充或回写为事前判断。"
            : reviewPhase === "retrospective"
              ? "本轮是订单优先的直接事后复盘：必须调用 review-decision-cycles Skill。以关联长桥订单与成交为事实起点，结合 cycleEvidenceEndAt 以前的确定性市场路径、适用的基本面、技术面、筹码、仓位与执行证据完成归因。若存在 trading-cockpit-review-cycle-trade-path-*，它是用户明确框选订单/成交所定义 Buy→Sell 窗口的唯一宿主路径：系统补充的父订单或同单成交不得扩窗；跨度超过 3 个交易日时，必须按已提供的连续 3 交易日分段分析，禁止另查历史首笔交易或替代窗口。该模式没有 knowledge cutoff、冻结事前基线或 blindAssessment；必须明确标为 retrospective，不得把事后解释改写成当时判断，也不得进入正式事前判断质量统计。宿主确定性指标只到 cycleEvidenceEndAt；周期后事实已排除。规则只能成为候选或登记测试，等待人工 Review。如证据足以形成可检验学习，可额外返回 learningProposal 验证草案；testDesign.metric 只能是 net_r、expectancy_r、win_rate、payoff_ratio，并必须给出可编辑的 successOperator(gt/gte/lt/lte) 与数值 successThreshold；最终 passed 只由宿主计算，模型不得声明。其 evidencePosture 必须是 retrospective_not_ex_ante，且 caveats 必须声明它不能冒充或回写为事前判断。"
              : "本轮是决策周期阶段一盲态复盘：必须调用 review-decision-cycles Skill。若提供 decision timeline，单次模型请求会同时承载按时间排序的多个“节点证据胶囊”；不得声称模型在物理上看不到后续胶囊。必须严格从最早节点开始，只用该胶囊中严格早于其 knowledgeCutoffAt 的事实先形成并冻结节点评价，再依序处理下一胶囊；严禁把晚节点行动、券商事实或技术快照倒灌到早节点。宿主已排除周期结果、当前组合及最后节点之后的事实；不得调用网页、MCP、近期历史或其他工具查询、猜测或暗示这些信息。只评价各时点证据下的判断、技术结构、仓位计划与失效纪律；缺少事前封存时明确标 retrospective，不能用后来事实补写。EMA/Fib 只是可选证据，叙事 Stage 与技术温度必须独立。"
          : "本轮是订单驱动的财报交易复盘：必须调用 review-earnings-decisions Skill。先核对用户选中的订单/成交与财报事件关联，再区分券商事实、事件事实、用户事前输入、派生指标和 Agent 推断。单案例只能提出候选规则；季度/跨季度分析必须披露样本漏斗、缺失、选择偏差、主要窗口、胜率、赔率、净期望与尾部风险，且任何规则晋级都要等待人工 Review。不要从订单日期猜财季，不要用当前持仓反推历史成交。"
        : "本轮是已持仓分析：围绕选中真实仓位、技术结构以及它对组合的边际风险给出条件计划。";
  const isReview = evidence.analysisScope === "review";
  const isBlind = isReview && reviewProtocol === "decision_cycle" && reviewPhase === "blind";
  const evidenceContract = isReview
    ? "先读取 trading-cockpit-context-manifest 并核对 bundleHash、块数、逐块哈希、deliveryStatus 与 semanticOmissions；再合并同一 protocol/cycleId 或 caseRef 的全部语义块。任何 omitted、unknown、unavailable 或 null 都不得补写成 0 或模型事实。已确认关联的券商记录和宿主指标是本轮冻结证据集，不得用新的 Longbridge 查询替换。"
    : "先读取 trading-cockpit-context-manifest 并核对 bundleHash、块数、逐块哈希与 deliveryStatus；相同 evidenceHash 的语义块共同构成本轮快照。当前数量、成本、权重、价格、汇率、OHLCV、指标和风险只以该快照为准，unknown、unavailable 与 null 绝不能写成 0。";
  const toolPolicy = isBlind
    ? "本轮启用宿主强制盲态防火墙：禁止网页、MCP、近期历史、Shell、文件或其他外部工具。若尝试调用，宿主会在结果进入上下文前中止本轮。只使用已交付的本地时间胶囊。"
    : isReview
      ? "复盘的订单、成交、周期收益、P&L 与路径指标只能来自本轮冻结证据包。网页或只读 MCP 仅可补充明确带 knownAt/source 的背景事实，不能改写已选择订单、时间边界或宿主确定性指标；失败一次即降级，不循环重试。"
      : "可使用本机已配置的 Skills、只读 MCP、Apps、网页和工具补充分析。Longbridge/MCP 单次失败时记录为证据降级并继续，不循环重试，也不得尝试任何券商写操作。";
  const technicalContract = !isReview
    ? "technicalV2/tierB 是宿主证据契约：仅使用已完成且同截止的 K 线；observed、calculated、inference 分开。14/28 日成本集中是 LOW CONFIDENCE 的 OHLCV 代理，不是逐笔筹码；AVWAP、期权、催化剂缺少来源与 knownAt 时保持 N/A。EMA/Fib 是可选证据，不是默认主框架。"
    : "复盘技术证据必须遵守其历史截止点；planned R、stress R、realized R、百分比与货币值不得混用。reviewSetMetrics、outcomeMetrics 和 technicalValidation 均由宿主计算：模型只解释，不重新汇总长表。historical_calibration 只能生成候选假设，不能冒充前瞻验证或自动晋级规则。";
  return [
    "你是交易驾驶舱中的 Codex Agent。当前窗口对应一个独立的持久 Codex thread；只延续该 thread，不混入其他会话。",
    `分析范围：${evidence.analysisScope}。${scopeInstruction}`,
    evidenceContract,
    toolPolicy,
    ...(!isBlind ? ["TradingView MCP 是可选研究数据源，不是第二个 Agent，也不是券商账户真相。若已连接，可围绕本轮选中标的/候选或组合查询自选、K线、基本面和新闻；先确认 EXCHANGE:TICKER，不把中间网页当前图表、手动画线或私有 Pine 指标视为已读取。TV Beta 行情可能延迟，必须独立注明来源、数据截止/返回时间、币种、周期、复权和交易时段（未返回则写未知），不得覆盖冻结持仓、成本、USD估值或宿主可执行仓位依据。EMA 3/5/8/13/21/144/169 若需要应基于足够已完成K线计算，不能用预置技术评级冒充；Fib 需要明确真实锚点。只允许本项目列出的查询工具，不得创建、激活、修改或删除自选列表/提醒，也不得使用 get_active_watchlist。401/403、429、503或超时出现一次即明确降级，继续给出已有证据支持的回答，不循环重试。当前新闻、分析师预期或财报日历不得倒填为历史时点已知事实。"] : []),
    "研究工具权限不等于交易执行权限：所有券商的提交、修改、撤销订单、行权、资金或证券划转都不在本应用授权范围；不得改走其他 MCP、Shell 或网络接口绕过。普通研究、文件分析、Skills 与只读查询保持开放。",
    technicalContract,
    ...(researchInstructions(evidence) ? [researchInstructions(evidence)] : []),
    "输出直接回答用户本轮输入，清楚区分事实、宿主计算、用户判断和模型推断；说明证据冲突、不确定性与条件动作。不得伪造实时数据、承诺收益或执行真实订单。",
    ...(!isReview ? ["只有当用户明确询问过去讨论时才调用 query_recent_history；它只返回最近 30 天，禁止读取归档目录。"] : []),
  ].join("\n\n");
}

function candidateWorkspaceOutputSchema() {
  const nullableNumber = {
    anyOf: [
      { type: "number", minimum: 0, maximum: 100 },
      { type: "null" },
    ],
  };
  const confidence = {
    type: "string",
    enum: ["high", "medium", "low", "unknown"],
  };
  const nullableAnchor = {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["barId", "field"],
        properties: {
          barId: { type: "string", minLength: 1 },
          field: { type: "string", enum: ["high", "low"] },
        },
      },
      { type: "null" },
    ],
  };
  const nullableString = {
    anyOf: [{ type: "string" }, { type: "null" }],
  };
  const nullableEmaPeriod = {
    anyOf: [
      { type: "integer", enum: [3, 5, 8, 13, 21, 144, 169] },
      { type: "null" },
    ],
  };
  const nullableFibRatio = {
    anyOf: [
      { type: "number", enum: [0.382, 0.618, 1, 1.618] },
      { type: "null" },
    ],
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["analysisMarkdown", "candidateSizing"],
    properties: {
      analysisMarkdown: { type: "string", minLength: 1 },
      candidateSizing: {
        type: "object",
        additionalProperties: false,
        required: [
          "candidateGroupKey",
          "classificationConfidence",
          "narrativeStage",
          "fibReview",
          "anchoredVwapReview",
          "invalidation",
          "holdingHorizon",
          "stressTest",
          "recommendedInitialAdditionalWeightPercent",
          "recommendedMaxTotalWeightPercent",
          "sizingConfidence",
          "leverageDecision",
          "rationale",
        ],
        properties: {
          candidateGroupKey: { type: ["string", "null"] },
          classificationConfidence: confidence,
          narrativeStage: {
            type: "string",
            enum: ["stage_1", "stage_2", "stage_3", "stage_4p", "stage_4e", "stage_4f", "unknown"],
          },
          fibReview: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: [
                  "decision",
                  "direction",
                  "anchors",
                  "emphasizedRatios",
                  "confidence",
                  "rationale",
                ],
                properties: {
                  decision: {
                    type: "string",
                    enum: ["use_auto", "override", "ignore", "insufficient_evidence"],
                  },
                  direction: {
                    type: "string",
                    enum: ["up", "down", "none"],
                  },
                  anchors: {
                    type: "object",
                    additionalProperties: false,
                    required: ["a", "b", "c"],
                    properties: {
                      a: nullableAnchor,
                      b: nullableAnchor,
                      c: nullableAnchor,
                    },
                  },
                  emphasizedRatios: {
                    type: "array",
                    items: { type: "number", enum: [0.382, 0.618, 1, 1.618] },
                    maxItems: 4,
                  },
                  confidence,
                  rationale: { type: "string" },
                },
              },
              { type: "null" },
            ],
          },
          anchoredVwapReview: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: [
                  "decision",
                  "anchorBarId",
                  "anchorReason",
                  "confidence",
                  "rationale",
                ],
                properties: {
                  decision: {
                    type: "string",
                    enum: ["select", "ignore", "insufficient_evidence"],
                  },
                  anchorBarId: nullableString,
                  anchorReason: { type: "string" },
                  confidence,
                  rationale: { type: "string" },
                },
              },
              { type: "null" },
            ],
          },
          invalidation: {
            type: "object",
            additionalProperties: false,
            required: [
              "kind",
              "barId",
              "field",
              "emaPeriod",
              "rangeKey",
              "fibRatio",
              "confirmation",
              "rationale",
            ],
            properties: {
              kind: {
                type: "string",
                enum: ["bar", "ema", "range20", "fib", "none"],
              },
              barId: nullableString,
              field: {
                anyOf: [
                  { type: "string", enum: ["high", "low", "close"] },
                  { type: "null" },
                ],
              },
              emaPeriod: nullableEmaPeriod,
              rangeKey: {
                anyOf: [
                  { type: "string", enum: ["priorLow", "priorHigh"] },
                  { type: "null" },
                ],
              },
              fibRatio: nullableFibRatio,
              confirmation: { type: "string" },
              rationale: { type: "string" },
            },
          },
          holdingHorizon: {
            type: "string",
            enum: ["intraday", "swing", "position", "event", "unknown"],
          },
          stressTest: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "lossPercent", "slippagePercent", "rationale"],
            properties: {
              kind: {
                type: "string",
                enum: ["gap_down", "liquidity_exit", "event_gap", "instrument_max_loss", "none"],
              },
              lossPercent: nullableNumber,
              slippagePercent: nullableNumber,
              rationale: { type: "string" },
            },
          },
          recommendedInitialAdditionalWeightPercent: nullableNumber,
          recommendedMaxTotalWeightPercent: nullableNumber,
          sizingConfidence: confidence,
          leverageDecision: {
            type: "string",
            enum: ["cash_only", "margin_within_cap", "disabled"],
          },
          rationale: { type: "string" },
        },
      },
    },
  };
}

function reviewLearningWorkspaceOutputSchema() {
  const learningProposal = {
    type: "object",
    additionalProperties: false,
    required: [
      "hypothesis",
      "evidenceSummary",
      "testDesign",
      "candidateRule",
      "confidence",
      "caveats",
      "evidencePosture",
    ],
    properties: {
      hypothesis: { type: "string", minLength: 1 },
      evidenceSummary: { type: "string", minLength: 1 },
      testDesign: {
        type: "object",
        additionalProperties: false,
        required: [
          "metric",
          "window",
          "minCases",
          "inclusion",
          "exclusion",
          "successCriteria",
          "successOperator",
          "successThreshold",
        ],
        properties: {
          metric: {
            type: "string",
            enum: ["net_r", "expectancy_r", "win_rate", "payoff_ratio"],
            description: "net_r=正式样本累计净R；expectancy_r=平均净R；win_rate=百分比数值(55表示55%)；payoff_ratio=平均盈利R/平均亏损R绝对值。",
          },
          window: { type: "string", minLength: 1 },
          minCases: { type: "integer", minimum: 1, maximum: 10_000 },
          inclusion: { type: "string", minLength: 1 },
          exclusion: { type: "string", minLength: 1 },
          successCriteria: { type: "string", minLength: 1 },
          successOperator: { type: "string", enum: ["gt", "gte", "lt", "lte"] },
          successThreshold: {
            type: "number",
            description: "与 metric 同单位；win_rate 使用百分比数值，例如 55 表示 55%。",
          },
        },
      },
      candidateRule: {
        type: "object",
        additionalProperties: false,
        required: ["title", "action", "invalidation", "scope"],
        properties: {
          title: { type: "string", minLength: 1 },
          action: { type: "string", minLength: 1 },
          invalidation: { type: "string", minLength: 1 },
          scope: { type: "string", minLength: 1 },
        },
      },
      confidence: { type: "string", enum: ["high", "medium", "low", "unknown"] },
      caveats: {
        type: "array",
        items: { type: "string", minLength: 1 },
        maxItems: 20,
      },
      evidencePosture: {
        type: "string",
        enum: ["retrospective_not_ex_ante"],
      },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["analysisMarkdown", "learningProposal"],
    properties: {
      analysisMarkdown: { type: "string", minLength: 1 },
      learningProposal: {
        anyOf: [learningProposal, { type: "null" }],
      },
    },
  };
}

function supportsReviewLearningProposal(evidence) {
  const protocol = evidence?.context?.reviewProtocol
    ?? evidence?.scopedContext?.reviewProtocol;
  const phase = evidence?.context?.reviewPhase
    ?? evidence?.scopedContext?.phase;
  return evidence?.analysisScope === "review"
    && protocol === "decision_cycle"
    && ["retrospective", "outcome"].includes(phase);
}

function parseWorkspaceTurnResponse(value) {
  const raw = String(value ?? "").trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && typeof parsed.analysisMarkdown === "string"
      && parsed.analysisMarkdown.trim()) {
      return {
        text: parsed.analysisMarkdown.trim(),
        candidateSizing: normalizeCandidateModelSizing(parsed.candidateSizing),
        learningProposal: normalizeLearningProposal(parsed.learningProposal),
        researchProposal: normalizeResearchProposal(parsed.researchProposal),
      };
    }
  } catch {
    // Older App Server/model combinations can ignore outputSchema. Keep the
    // human-readable answer and treat the structured recommendation as absent.
  }
  return { text: raw, candidateSizing: null, learningProposal: null, researchProposal: null };
}

function normalizeLearningProposal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const text = (input, limit) => String(input ?? "").trim().slice(0, limit);
  const hypothesis = text(value.hypothesis, 4_000);
  const evidenceSummary = text(value.evidenceSummary, 6_000);
  const minCases = finiteOrNull(value.testDesign?.minCases);
  const metric = ["net_r", "expectancy_r", "win_rate", "payoff_ratio"]
    .includes(value.testDesign?.metric)
    ? value.testDesign.metric
    : null;
  const successOperator = ["gt", "gte", "lt", "lte"].includes(value.testDesign?.successOperator)
    ? value.testDesign.successOperator
    : null;
  const successThreshold = finiteOrNull(value.testDesign?.successThreshold);
  const testDesign = value.testDesign && typeof value.testDesign === "object" && !Array.isArray(value.testDesign)
    && Number.isInteger(minCases) && minCases >= 1 && minCases <= 10_000
    && metric && successOperator && Number.isFinite(successThreshold)
    ? {
      metric,
      window: text(value.testDesign.window, 500),
      minCases,
      inclusion: text(value.testDesign.inclusion, 2_000),
      exclusion: text(value.testDesign.exclusion, 2_000),
      successCriteria: text(value.testDesign.successCriteria, 2_000),
      successOperator,
      successThreshold,
    }
    : null;
  const candidateRule = value.candidateRule && typeof value.candidateRule === "object" && !Array.isArray(value.candidateRule)
    ? {
      title: text(value.candidateRule.title, 500),
      action: text(value.candidateRule.action, 2_000),
      invalidation: text(value.candidateRule.invalidation, 2_000),
      scope: text(value.candidateRule.scope, 1_000),
    }
    : null;
  if (!hypothesis || !evidenceSummary || !testDesign || !candidateRule
    || Object.values(testDesign).some((item) => item === "")
    || Object.values(candidateRule).some((item) => item === "")) return null;
  const retrospectiveCaveat = "该草案来自事后复盘，只能作为待验证假设，不得冒充、覆盖或回写为事前判断。";
  const caveats = [...new Set([
    ...(Array.isArray(value.caveats) ? value.caveats : []).map((item) => text(item, 1_000)).filter(Boolean),
    retrospectiveCaveat,
  ])].slice(0, 20);
  return {
    hypothesis,
    evidenceSummary,
    testDesign,
    candidateRule,
    confidence: ["high", "medium", "low", "unknown"].includes(value.confidence)
      ? value.confidence
      : "unknown",
    caveats,
    evidencePosture: "retrospective_not_ex_ante",
  };
}

function normalizeCandidateModelSizing(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const confidence = ["high", "medium", "low", "unknown"].includes(value.classificationConfidence)
    ? value.classificationConfidence
    : "unknown";
  const leverageDecision = ["cash_only", "margin_within_cap"].includes(value.leverageDecision)
    ? value.leverageDecision
    : "disabled";
  return {
    candidateGroupKey: value.candidateGroupKey == null
      ? null
      : String(value.candidateGroupKey).trim().slice(0, 120) || null,
    classificationConfidence: confidence,
    narrativeStage: [
      "stage_1",
      "stage_2",
      "stage_3",
      "stage_4p",
      "stage_4e",
      "stage_4f",
      "unknown",
    ].includes(value.narrativeStage)
      ? value.narrativeStage
      : "unknown",
    fibReview: normalizeFibModelReview(value.fibReview),
    anchoredVwapReview: normalizeAnchoredVwapModelReview(value.anchoredVwapReview),
    invalidation: normalizeInvalidationReview(value.invalidation),
    holdingHorizon: ["intraday", "swing", "position", "event", "unknown"].includes(value.holdingHorizon)
      ? value.holdingHorizon
      : "unknown",
    stressTest: normalizeCandidateStressTest(value.stressTest),
    recommendedInitialAdditionalWeightPercent: boundedPercentOrNull(
      value.recommendedInitialAdditionalWeightPercent,
    ),
    recommendedMaxTotalWeightPercent: boundedPercentOrNull(
      value.recommendedMaxTotalWeightPercent,
    ),
    sizingConfidence: ["high", "medium", "low", "unknown"].includes(value.sizingConfidence)
      ? value.sizingConfidence
      : "unknown",
    leverageDecision,
    rationale: String(value.rationale ?? "").trim().slice(0, 1_000),
  };
}

function normalizeAnchoredVwapModelReview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const decision = ["select", "ignore", "insufficient_evidence"].includes(value.decision)
    ? value.decision
    : "insufficient_evidence";
  return {
    decision,
    anchorBarId: String(value.anchorBarId ?? "").trim().slice(0, 240) || null,
    anchorReason: String(value.anchorReason ?? "").trim().slice(0, 1_000),
    confidence: ["high", "medium", "low", "unknown"].includes(value.confidence)
      ? value.confidence
      : "unknown",
    rationale: String(value.rationale ?? "").trim().slice(0, 1_000),
  };
}

function normalizeCandidateStressTest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      kind: "none",
      lossPercent: null,
      slippagePercent: null,
      rationale: "模型未提供压力情景。",
    };
  }
  return {
    kind: ["gap_down", "liquidity_exit", "event_gap", "instrument_max_loss", "none"].includes(value.kind)
      ? value.kind
      : "none",
    lossPercent: boundedPercentOrNull(value.lossPercent),
    slippagePercent: boundedPercentOrNull(value.slippagePercent),
    rationale: String(value.rationale ?? "").trim().slice(0, 1_000),
  };
}

function normalizeFibModelReview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const decisions = ["use_auto", "override", "ignore", "insufficient_evidence"];
  const directions = ["up", "down", "none"];
  const confidence = ["high", "medium", "low", "unknown"].includes(value.confidence)
    ? value.confidence
    : "unknown";
  const normalizeAnchor = (anchor) => {
    if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return null;
    const field = ["high", "low"].includes(anchor.field) ? anchor.field : null;
    const barId = String(anchor.barId ?? "").trim();
    return field && barId ? { barId, field } : null;
  };
  return {
    decision: decisions.includes(value.decision) ? value.decision : "insufficient_evidence",
    direction: directions.includes(value.direction) ? value.direction : "none",
    anchors: {
      a: normalizeAnchor(value.anchors?.a),
      b: normalizeAnchor(value.anchors?.b),
      c: normalizeAnchor(value.anchors?.c),
    },
    emphasizedRatios: [...new Set(
      (Array.isArray(value.emphasizedRatios) ? value.emphasizedRatios : [])
        .filter((ratio) => typeof ratio === "number"
          && Number.isFinite(ratio)
          && [0.382, 0.618, 1, 1.618].includes(ratio)),
    )],
    confidence,
    rationale: String(value.rationale ?? "").trim().slice(0, 1_000),
  };
}

function normalizeInvalidationReview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = ["bar", "ema", "range20", "fib", "none"].includes(value.kind)
    ? value.kind
    : "none";
  const field = ["high", "low", "close"].includes(value.field) ? value.field : null;
  const requestedEmaPeriod = finiteOrNull(value.emaPeriod);
  const emaPeriod = [3, 5, 8, 13, 21, 144, 169].includes(requestedEmaPeriod)
    ? requestedEmaPeriod
    : null;
  const rangeKey = ["priorLow", "priorHigh"].includes(value.rangeKey)
    ? value.rangeKey
    : null;
  const requestedFibRatio = finiteOrNull(value.fibRatio);
  const fibRatio = [0.382, 0.618, 1, 1.618].includes(requestedFibRatio)
    ? requestedFibRatio
    : null;
  return {
    kind,
    barId: String(value.barId ?? "").trim() || null,
    field,
    emaPeriod,
    rangeKey,
    fibRatio,
    confirmation: String(value.confirmation ?? "").trim().slice(0, 500),
    rationale: String(value.rationale ?? "").trim().slice(0, 1_000),
  };
}

function codexPosition(item) {
  return {
    broker: item?.broker ?? "longbridge",
    brokerLegs: item?.brokerLegs ?? null,
    contractMultiplier: finiteOrNull(item?.contractMultiplier),
    option: item?.option ?? null,
    marketData: item?.marketData ?? null,
    valuationSource: item?.valuationSource ?? null,
    symbol: item?.symbol ?? null,
    ticker: item?.ticker ?? null,
    name: item?.name ?? null,
    group: item?.group ?? null,
    instrumentType: item?.instrumentType ?? null,
    currency: item?.currency ?? null,
    quantity: finiteOrNull(item?.quantity),
    availableQuantity: finiteOrNull(item?.availableQuantity),
    costPrice: finiteOrNull(item?.costPrice),
    lastPrice: finiteOrNull(item?.lastPrice),
    weightPercent: finiteOrNull(item?.weight),
    netWeightPercent: finiteOrNull(item?.netWeight),
    pnlPercent: finiteOrNull(item?.pnlPercent),
    valuationStatus: item?.valuationStatus ?? null,
  };
}

export function applyCodexWorkspaceAnalysis(run, analysis) {
  const avwapAdjustedRun = applyCandidateAnchoredVwapReview(
    run,
    analysis.candidateSizing?.anchoredVwapReview,
  );
  const adjustedRun = applyCandidateSizingReview(avwapAdjustedRun, analysis.candidateSizing);
  const learningProposal = supportsReviewLearningProposal({
    analysisScope: run?.context?.scope,
    context: run?.context,
    scopedContext: run?.analysisContext,
  })
    ? normalizeLearningProposal(analysis.learningProposal)
    : null;
  const researchProposal = supportsResearchProposal({
    analysisScope: run?.context?.scope,
    context: run?.context,
    scopedContext: run?.analysisContext,
  }) ? normalizeResearchProposal(analysis.researchProposal) : null;
  const headline = analysisHeadline(analysis.text);
  const numericAuthority = run?.context?.scope === "candidate"
    ? candidateNumericAuthorityMarkdown(adjustedRun.analysisContext?.numericClaimAudit)
    : "";
  const narrativeBody = numericAuthority
    ? isolateCandidateNarrativeMarkdown(analysis.text)
    : analysis.text;
  const conclusionBody = numericAuthority
    ? `${numericAuthority}\n\n${narrativeBody}`
    : narrativeBody;
  return {
    ...adjustedRun,
    elapsedMs: Number(adjustedRun.elapsedMs ?? 0) + Number(analysis.elapsedMs ?? 0),
    conclusion: {
      headline,
      body: conclusionBody,
      posture: "Codex 持久项目分析",
    },
    ...(learningProposal ? { learningProposal } : {}),
    ...(researchProposal ? { researchProposal } : {}),
    modelAnalysis: {
      provider: analysis.provider,
      persistent: true,
      ephemeral: false,
      threadId: analysis.threadId,
      workspaceDirectory: analysis.workspaceDirectory,
      requestedSkills: analysis.requestedSkills,
      actualSkillVersions: analysis.actualSkillVersions ?? [],
      postRunSkillVersions: analysis.postRunSkillVersions ?? [],
      skillReproducibility: analysis.skillReproducibility ?? null,
      requestedApps: analysis.requestedApps,
      researchMode: analysis.researchMode ?? null,
      toolEvents: analysis.toolEvents,
      toolsUsed: analysis.toolsUsed,
      skillCount: analysis.skillCount,
      mcpServerCount: analysis.mcpServerCount,
      appCount: analysis.appCount,
      tokenUsage: analysis.tokenUsage,
      firstActivityMs: analysis.firstActivityMs,
      contextDiagnostics: analysis.contextDiagnostics ?? null,
      resultDelivery: analysis.resultDelivery ?? null,
      additionalContextContract: analysis.additionalContextContract ?? null,
      serverUserAgent: analysis.serverUserAgent ?? null,
    },
    evidence: [
      ...adjustedRun.evidence,
      {
        source: "Codex 持久项目线程",
        tool: "codex:app-server",
        asOf: new Date().toISOString(),
        records: 1 + analysis.toolEvents.length,
        status: "succeeded",
        summary: `${analysis.requestedSkills.length} Skills · ${analysis.requestedApps.length} Apps 显式引用 · ${analysis.toolEvents.length} 工具事件 · 上下文 ${analysis.contextDiagnostics?.totalBlockCount ?? "?"} 块/${analysis.contextDiagnostics?.totalUtf8Bytes ?? "?"} bytes · 历史已保留`,
        skillVersions: (analysis.actualSkillVersions ?? []).map(compactSkillVersion),
        skillReproducibility: analysis.skillReproducibility ?? null,
      },
    ],
    safeguards: {
      ...adjustedRun.safeguards,
      modelNarration: true,
      modelProvider: analysis.provider,
      modelSession: "persistent",
      modelTools: true,
      orderWrite: false,
    },
    capabilities: {
      ...adjustedRun.capabilities,
      modelNarration: true,
      persistentThread: true,
      skills: true,
      mcp: analysis.researchMode?.kind !== "restricted",
    },
  };
}

function applyCandidateAnchoredVwapReview(run, review) {
  if (run?.context?.scope !== "candidate") return run;
  const resolved = resolveModelAnchoredVwapReview(run, review);
  const capability = anchoredVwapCapability(resolved);
  const currentV2 = run?.technical?.technicalV2 ?? null;
  const nextV2 = currentV2
    ? {
        ...currentV2,
        anchoredVwap: resolved,
        capabilityMatrix: {
          ...currentV2.capabilityMatrix,
          anchoredVwap: capability,
        },
        limitations: [
          ...(Array.isArray(currentV2.limitations)
            ? currentV2.limitations.filter((item) => item?.layer !== "anchoredVwap")
            : []),
          ...(capability.status === "complete"
            ? []
            : [{
                layer: "anchoredVwap",
                status: capability.status,
                reasonCodes: capability.reasonCodes,
              }]),
        ],
      }
    : null;
  const nextTechnical = currentV2
    ? { ...run.technical, technicalV2: nextV2 }
    : run.technical;
  const nextContextTechnical = currentV2 && run?.analysisContext?.technical
    ? { ...run.analysisContext.technical, technicalV2: nextV2 }
    : run?.analysisContext?.technical;
  const nextNumericEvidence = currentV2
    ? appendTechnicalNumericEvidence(run?.analysisContext?.numericEvidence, {
        target: run?.analysisContext?.target,
        technical: nextTechnical,
      })
    : run?.analysisContext?.numericEvidence;
  const evidenceStatus = resolved.status === "selected"
    ? "succeeded"
    : resolved.status === "invalid"
      ? "degraded"
      : "skipped";
  const evidenceSummary = resolved.status === "selected"
    ? `LLM 显式锚点 ${resolved.evidence.anchor.barId} 已由宿主按 HLC3×成交量复算；AVWAP ${rounded(resolved.evidence.vwap, 4)}，仅作辅助证据`
    : resolved.status === "invalid"
      ? `LLM AVWAP 锚点未通过宿主核验：${resolved.reason}`
      : resolved.status === "ignored"
        ? "LLM 明确判断本轮 AVWAP 不适用；未计算"
        : "LLM 未提供足够的显式 AVWAP 锚点；未计算";
  return {
    ...run,
    technical: nextTechnical,
    analysisContext: {
      ...run.analysisContext,
      ...(nextContextTechnical ? { technical: nextContextTechnical } : {}),
      ...(nextNumericEvidence ? { numericEvidence: nextNumericEvidence } : {}),
    },
    evidence: [
      ...(run.evidence ?? []),
      {
        source: "宿主核验 Anchored VWAP",
        tool: "local:anchored-vwap",
        asOf: resolved.evidence?.asOf?.timestamp ?? run?.technical?.asOf ?? null,
        records: resolved.evidence?.barCount ?? 0,
        status: evidenceStatus,
        summary: evidenceSummary,
      },
    ],
  };
}

function resolveModelAnchoredVwapReview(run, review) {
  const decision = review?.decision ?? "insufficient_evidence";
  if (decision === "ignore" || decision === "insufficient_evidence") {
    return {
      decision,
      status: decision === "ignore" ? "ignored" : "insufficient_evidence",
      hostVerified: false,
      evidence: null,
      confidence: review?.confidence ?? "unknown",
      rationale: review?.rationale ?? "",
      reason: decision === "ignore"
        ? "LLM 明确判断 AVWAP 对本轮没有增量。"
        : "没有可核验的显式锚点。",
      advisory: true,
      sizingAuthority: false,
    };
  }
  if (decision !== "select") {
    return invalidAnchoredVwapReview(review, "anchored_vwap_decision_invalid", "AVWAP 决策值无效。");
  }
  const anchorBarId = String(review?.anchorBarId ?? "").trim();
  const anchorReason = String(review?.anchorReason ?? "").trim();
  if (!anchorBarId || !anchorReason) {
    return invalidAnchoredVwapReview(
      review,
      "explicit_anchor_incomplete",
      "选择 AVWAP 时必须提供 priceBars 中的 barId 与明确锚定理由。",
    );
  }
  const bars = officialContextBars(run);
  if (!bars.some((bar) => String(bar?.barId) === anchorBarId)) {
    return invalidAnchoredVwapReview(
      review,
      "anchor_not_in_official_context",
      "选择的 AVWAP 锚点不在本轮已完成 priceBars 中。",
    );
  }
  try {
    const evidence = buildAnchoredVwapEvidence({
      bars: bars.map((bar) => ({
        barId: String(bar.barId),
        timestamp: bar.time ?? bar.barId,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        isClosed: true,
      })),
      completedBarsOnly: true,
      anchor: {
        barId: anchorBarId,
        reason: anchorReason,
        source: "Codex structured anchoredVwapReview",
      },
    });
    return {
      decision,
      status: "selected",
      hostVerified: true,
      evidence,
      confidence: review?.confidence ?? "unknown",
      rationale: review?.rationale ?? "",
      reason: null,
      advisory: true,
      sizingAuthority: false,
    };
  } catch (error) {
    return invalidAnchoredVwapReview(
      review,
      String(error?.code ?? "anchored_vwap_host_validation_failed"),
      String(error?.message ?? "宿主无法核验 Anchored VWAP 输入。"),
    );
  }
}

function invalidAnchoredVwapReview(review, code, reason) {
  return {
    decision: review?.decision ?? "insufficient_evidence",
    status: "invalid",
    hostVerified: false,
    evidence: null,
    confidence: review?.confidence ?? "unknown",
    rationale: review?.rationale ?? "",
    reasonCode: code,
    reason,
    advisory: true,
    sizingAuthority: false,
  };
}

function anchoredVwapCapability(review) {
  if (review?.status === "selected" && review.hostVerified === true) {
    return {
      status: "complete",
      minimumBars: 1,
      barCount: review.evidence?.barCount ?? 0,
      source: "host_verified_explicit_llm_anchor",
      asOf: review.evidence?.asOf?.timestamp ?? null,
      method: review.evidence?.methodVersion ?? "anchored-vwap-hlc3-volume/v1",
      reasonCodes: ["advisory_only_no_sizing_authority"],
    };
  }
  return {
    status: "unavailable",
    minimumBars: 1,
    barCount: 0,
    source: "host_verified_explicit_llm_anchor",
    asOf: null,
    method: "anchored-vwap-hlc3-volume/v1",
    reasonCodes: [review?.reasonCode ?? `llm_${review?.status ?? "insufficient_evidence"}`],
  };
}

function applyCandidateSizingReview(run, review) {
  if (run?.context?.scope !== "candidate" || !review || !run?.risk) return run;
  const risk = run.risk;
  const groupRows = Array.isArray(risk.portfolioConstraints?.groupExposure)
    ? risk.portfolioConstraints.groupExposure
    : [];
  const requestedGroup = String(review.candidateGroupKey ?? "").trim();
  const matchedGroup = requestedGroup
    ? groupRows.find((item) => String(item?.key ?? "").trim() === requestedGroup)
    : null;
  const existingWeight = Math.max(0, finiteOrNull(risk.existingPositionWeight) ?? 0);
  const hardMaxTotal = finiteOrNull(risk.hardMaxTotalWeightPercent);
  const cashHeadroom = Math.max(0, finiteOrNull(risk.cashConstrainedWeightPercent) ?? 0);
  const buyPowerWeight = finiteOrNull(risk.buyPowerWeightPercent);
  const currentGross = finiteOrNull(risk.portfolioConstraints?.grossExposurePercent);
  const grossHardMax = finiteOrNull(
    risk.portfolioConstraints?.policyThresholds?.grossHardMaxPercent,
  );
  const grossLimitedTotal = currentGross != null && grossHardMax != null
    ? existingWeight + Math.max(0, grossHardMax - currentGross)
    : null;
  const cashOnlyTotal = existingWeight + cashHeadroom;
  const buyPowerLimitedTotal = buyPowerWeight == null
    ? null
    : existingWeight + Math.max(0, buyPowerWeight);
  const modelMaxTotal = boundedPercentOrNull(review.recommendedMaxTotalWeightPercent);
  const modelInitialAdditional = boundedPercentOrNull(
    review.recommendedInitialAdditionalWeightPercent,
  );
  const matchedGroupWeight = finiteOrNull(matchedGroup?.weight);
  const worstExistingGroupWeight = groupRows
    .map((item) => finiteOrNull(item?.weight))
    .filter((value) => value != null)
    .reduce((worst, value) => Math.max(worst, value), 0);
  const groupMappingStatus = !requestedGroup
    ? "missing"
    : matchedGroup && matchedGroupWeight != null
      ? "matched"
      : groupRows.length
        ? "unmatched_worst_case"
        : "unmatched_no_existing_exposure";
  const guardrailGroupWeight = groupMappingStatus === "matched"
    ? matchedGroupWeight
    : requestedGroup
      ? worstExistingGroupWeight
      : null;
  const groupThreshold = finiteOrNull(risk.portfolioConstraints?.policyThresholds?.groupWarningPercent);
  const groupMaxTotal = guardrailGroupWeight != null && groupThreshold != null
    ? existingWeight + Math.max(0, groupThreshold - guardrailGroupWeight)
    : null;
  const sizingValidUntilMs = Date.parse(String(risk.sizingValidUntil ?? ""));
  const snapshotFreshAtDecision = risk.snapshotFresh === true
    && Number.isFinite(sizingValidUntilMs)
    && Date.now() <= sizingValidUntilMs;
  const reviewedFib = resolveModelFibReview(run, review.fibReview);
  const reviewedAnchoredVwap = run?.technical?.technicalV2?.anchoredVwap ?? null;
  const invalidation = resolveModelInvalidation(run, review.invalidation, reviewedFib);
  const lastPrice = finiteOrNull(run.technical?.lastPrice);
  const riskBudgetPercent = finiteOrNull(risk.riskBudgetPercent);
  const riskDistancePercent = invalidation.valid && lastPrice > 0
    ? rounded(((lastPrice - invalidation.level) / lastPrice) * 100, 4)
    : null;
  const stressLossPercent = boundedPercentOrNull(review.stressTest?.lossPercent);
  const plannedSlippagePercent = boundedPercentOrNull(review.stressTest?.slippagePercent);
  const plannedRiskLossPercent = riskDistancePercent > 0 && plannedSlippagePercent != null
    ? rounded(Math.min(100, riskDistancePercent + plannedSlippagePercent), 4)
    : null;
  const stressRiskLossPercent = stressLossPercent > 0 && plannedRiskLossPercent > 0
    ? rounded(Math.max(stressLossPercent, plannedRiskLossPercent), 4)
    : null;
  const riskBudgetTotal = stressRiskLossPercent > 0 && riskBudgetPercent > 0
    ? rounded((riskBudgetPercent / stressRiskLossPercent) * 100, 4)
    : null;
  const hardLimits = {
    accountAndConcentrationTotalWeightPercent: hardMaxTotal,
    groupTotalWeightPercent: groupMaxTotal == null ? null : rounded(groupMaxTotal),
    plannedRiskLossPercent,
    stressRiskLossPercent,
    riskBudgetTotalWeightPercent: riskBudgetTotal,
    cashOnlyTotalWeightPercent: rounded(cashOnlyTotal),
    buyPowerTotalWeightPercent: buyPowerLimitedTotal == null
      ? null
      : rounded(buyPowerLimitedTotal),
    portfolioGrossHardMaxPercent: grossHardMax,
    portfolioGrossLimitedTotalWeightPercent: grossLimitedTotal == null
      ? null
      : rounded(grossLimitedTotal),
  };
  const confidenceAccepted = ["high", "medium"].includes(review.classificationConfidence);
  const sizingConfidenceAccepted = ["high", "medium"].includes(review.sizingConfidence);
  const holdingHorizonAccepted = ["intraday", "swing", "position", "event"].includes(
    review.holdingHorizon,
  );
  const stressTestAccepted = review.stressTest?.kind !== "none"
    && stressLossPercent > 0
    && plannedSlippagePercent != null
    && String(review.stressTest?.rationale ?? "").trim().length > 0;
  const narrativeStageAccepted = [
    "stage_1",
    "stage_2",
    "stage_3",
    "stage_4p",
    "stage_4e",
    "stage_4f",
  ].includes(review.narrativeStage);
  const modelProposalComplete = modelMaxTotal != null
    && modelInitialAdditional != null
    && modelMaxTotal >= existingWeight
    && modelInitialAdditional >= 0;
  const marginDecisionRequested = review.leverageDecision === "margin_within_cap";
  const leverageDecisionAccepted = ["cash_only", "margin_within_cap"].includes(
    review.leverageDecision,
  );
  const prerequisiteReasons = [
    ...(!risk.supported || !risk.awaitingModelReview
      ? [risk.limitation || risk.entryBlockReasons?.[0] || "本地安全边界不允许生成可执行仓位"]
      : []),
    ...(!snapshotFreshAtDecision ? ["持仓快照在 LLM 返回前已超过 2 分钟；文字结论保留，仓位数值必须刷新后重算"] : []),
    ...(!requestedGroup ? ["LLM 未给出可靠的候选主题分类"] : []),
    ...(!confidenceAccepted ? ["候选主题分类置信度不足"] : []),
    ...(!sizingConfidenceAccepted ? ["仓位建议置信度不足"] : []),
    ...(!holdingHorizonAccepted ? ["LLM 未给出可用的持有周期"] : []),
    ...(!stressTestAccepted
      ? ["LLM 未给出可核验的压力损失与退出滑点；技术止损距离不能代替 stress risk"]
      : []),
    ...(!narrativeStageAccepted ? ["LLM 未给出可用的叙事 Stage"] : []),
    ...(!modelProposalComplete ? ["LLM 未给出完整有效的初始/最大仓位建议"] : []),
    ...(!leverageDecisionAccepted ? ["LLM 未选择 cash_only 或 margin_within_cap"] : []),
    ...(risk.buyPowerValid !== true || buyPowerWeight == null
      ? ["购买力缺失或无效，融资与现金仓位均默认拒绝"]
      : []),
    ...(currentGross == null || grossHardMax == null
      ? ["缺少可验证的组合毛暴露或 150% 硬上限"]
      : []),
    ...(!(riskBudgetPercent > 0)
      ? ["缺少可验证的单笔风险预算，不能把未知值按 0 参与仓位计算"]
      : []),
    ...(marginDecisionRequested && risk.leverage?.marginEligible !== true
      ? ["LLM 请求融资，但账户未通过购买力、保证金、估值、衍生品覆盖和毛敞口前置校验"]
      : []),
    ...(review.leverageDecision === "cash_only" && cashHeadroom <= 0
      ? ["现金缓冲已无可用新增空间；若要使用融资，LLM 必须显式选择 margin_within_cap"]
      : []),
    ...(["use_auto", "override"].includes(review.fibReview?.decision)
      && reviewedFib.status !== "selected"
      ? [reviewedFib.rationale || "LLM 选择的 Fib 未通过宿主锚点校验"]
      : []),
    ...(!invalidation.valid ? [invalidation.reason] : []),
  ].filter(Boolean);
  const reviewCanSize = prerequisiteReasons.length === 0;
  const ceilings = [
    hardMaxTotal,
    groupMaxTotal,
    riskBudgetTotal,
    grossLimitedTotal,
    buyPowerLimitedTotal,
    ...(review.leverageDecision === "cash_only" ? [cashOnlyTotal] : []),
    modelMaxTotal,
  ].filter((value) => Number.isFinite(value));
  const maxTotal = reviewCanSize && ceilings.length
    ? Math.max(existingWeight, Math.min(...ceilings))
    : existingWeight;
  const maxAdditional = Math.max(0, maxTotal - existingWeight);
  const initialAdditional = reviewCanSize && modelInitialAdditional != null
    ? Math.max(0, Math.min(modelInitialAdditional, maxAdditional))
    : 0;
  const entryAllowed = reviewCanSize && maxAdditional > 0 && initialAdditional > 0;
  const maxAdditionalBorrowed = entryAllowed && marginDecisionRequested
    ? Math.max(0, maxAdditional - cashHeadroom)
    : 0;
  const initialAdditionalBorrowed = entryAllowed && marginDecisionRequested
    ? Math.max(0, initialAdditional - cashHeadroom)
    : 0;
  const effectiveLeverageDecision = entryAllowed
    ? maxAdditionalBorrowed > 0
      ? "margin_within_cap"
      : "cash_only"
    : "disabled";
  const projectedGrossAtInitial = currentGross == null
    ? null
    : currentGross + initialAdditional;
  const projectedGrossAtMax = currentGross == null
    ? null
    : currentGross + maxAdditional;
  const netAssets = finiteOrNull(run.analysisContext?.portfolioSummary?.netAssets);
  const limitBindings = [];
  if (reviewCanSize) {
    if (groupMappingStatus === "unmatched_worst_case") {
      limitBindings.push("group_mapping_worst_case");
    }
    if (hardMaxTotal != null && modelMaxTotal > hardMaxTotal) {
      limitBindings.push("account_and_concentration");
    }
    if (groupMaxTotal != null && modelMaxTotal > groupMaxTotal) {
      limitBindings.push("group_exposure");
    }
    if (riskBudgetTotal != null && modelMaxTotal > riskBudgetTotal) {
      limitBindings.push("stress_risk_budget");
    }
    if (grossLimitedTotal != null && modelMaxTotal > grossLimitedTotal) {
      limitBindings.push("gross_exposure");
    }
    if (buyPowerLimitedTotal != null && modelMaxTotal > buyPowerLimitedTotal) {
      limitBindings.push("buy_power");
    }
    if (review.leverageDecision === "cash_only" && modelMaxTotal > cashOnlyTotal) {
      limitBindings.push("cash_only");
    }
    if (modelInitialAdditional > maxAdditional) {
      limitBindings.push("initial_additional");
    }
  }
  const reviewStatus = !entryAllowed
    ? "blocked"
    : limitBindings.length
      ? "bounded"
      : "llm_reviewed";
  const reviewReason = prerequisiteReasons.join("；")
    || review.rationale
    || "LLM 方案已通过本地硬安全边界校验。";
  const decisionAt = new Date().toISOString();
  const entryBlockReasons = [...(risk.entryBlockReasons ?? [])];
  if (!entryAllowed && reviewReason) entryBlockReasons.push(reviewReason);
  const nextRisk = {
    ...risk,
    entryAllowed,
    awaitingModelReview: false,
    entryBlockReasons: [...new Set(entryBlockReasons)],
    group: requestedGroup || risk.group,
    candidateGroupKnown: groupMappingStatus === "matched",
    groupWeight: groupMappingStatus === "matched"
      ? rounded(matchedGroupWeight)
      : risk.groupWeight,
    stageAssumption: review.narrativeStage,
    referenceLevel: invalidation.valid ? rounded(invalidation.level) : null,
    referenceLabel: invalidation.valid ? invalidation.label : "LLM 失效依据未通过校验",
    moveToReferencePercent: riskDistancePercent == null ? null : -riskDistancePercent,
    riskDistancePercent,
    plannedRiskLossPercent,
    stressRiskLossPercent,
    stressLossPercent,
    plannedExitSlippagePercent: plannedSlippagePercent,
    holdingHorizon: review.holdingHorizon,
    riskLimitedWeightPercent: riskBudgetTotal,
    recommendedInitialAdditionalWeightPercent: rounded(initialAdditional),
    recommendedInitialTotalWeightPercent: rounded(existingWeight + initialAdditional),
    recommendedInitialNotionalBase: netAssets == null
      ? null
      : rounded(netAssets * initialAdditional / 100),
    recommendedMaxAdditionalWeightPercent: rounded(maxAdditional),
    recommendedMaxWeightPercent: rounded(maxTotal),
    recommendedMaxAdditionalNotionalBase: netAssets == null
      ? null
      : rounded(netAssets * maxAdditional / 100),
    portfolioImpactAtReferencePercent: riskDistancePercent == null
      ? null
      : rounded(-maxAdditional * riskDistancePercent / 100),
    portfolioStressImpactPercent: stressRiskLossPercent == null
      ? null
      : rounded(-maxAdditional * stressRiskLossPercent / 100),
    fibonacciReview: reviewedFib,
    anchoredVwapReview: reviewedAnchoredVwap,
    leverage: {
      ...risk.leverage,
      decision: effectiveLeverageDecision,
      additionalLeverageAllowed: effectiveLeverageDecision === "margin_within_cap",
      initialAdditionalBorrowedWeightPercent: rounded(initialAdditionalBorrowed),
      maxAdditionalBorrowedWeightPercent: rounded(maxAdditionalBorrowed),
      modelReviewDecision: review.leverageDecision,
      currentGrossExposurePercent: currentGross,
      projectedGrossAtInitialPercent: projectedGrossAtInitial == null
        ? null
        : rounded(projectedGrossAtInitial),
      projectedGrossAtMaxPercent: projectedGrossAtMax == null
        ? null
        : rounded(projectedGrossAtMax),
      disabledReasons: entryAllowed
        ? []
        : [...new Set([
            ...(risk.leverage?.disabledReasons ?? []),
            ...(reviewReason ? [reviewReason] : []),
          ])],
    },
    sizingReview: {
      status: reviewStatus,
      source: "Codex LLM",
      candidateGroupKey: requestedGroup || null,
      requestedGroupKey: requestedGroup || null,
      matchedGroupKey: groupMappingStatus === "matched"
        ? String(matchedGroup?.key ?? "").trim() || null
        : null,
      groupMappingStatus,
      groupGuardrailWeightPercent: guardrailGroupWeight == null
        ? null
        : rounded(guardrailGroupWeight),
      classificationConfidence: review.classificationConfidence,
      sizingConfidence: review.sizingConfidence,
      narrativeStage: review.narrativeStage,
      holdingHorizon: review.holdingHorizon,
      modelProposal: {
        initialAdditionalWeightPercent: modelInitialAdditional,
        maxTotalWeightPercent: modelMaxTotal,
        leverageDecision: review.leverageDecision,
        stressTest: review.stressTest,
      },
      accepted: {
        initialAdditionalWeightPercent: rounded(initialAdditional),
        maxAdditionalWeightPercent: rounded(maxAdditional),
        maxTotalWeightPercent: rounded(maxTotal),
        initialAdditionalBorrowedWeightPercent: rounded(initialAdditionalBorrowed),
        maxAdditionalBorrowedWeightPercent: rounded(maxAdditionalBorrowed),
        leverageDecision: effectiveLeverageDecision,
        referenceLevel: invalidation.valid ? rounded(invalidation.level) : null,
        riskDistancePercent,
        plannedExitSlippagePercent: plannedSlippagePercent,
        plannedRiskLossPercent,
        stressRiskLossPercent,
      },
      hardLimits,
      limitBindings: [...new Set(limitBindings)],
      snapshotFreshAtDecision,
      decisionAt,
      invalidation,
      fibonacciReview: reviewedFib,
      anchoredVwapReview: reviewedAnchoredVwap,
      rationale: reviewReason,
      deterministicCeilingPreserved: true,
    },
  };
  const numericEvidence = appendCandidateSizingNumericEvidence(run, {
    review,
    nextRisk,
    decisionAt,
    snapshotFreshAtDecision,
    entryAllowed,
    modelInitialAdditional,
    modelMaxTotal,
    initialAdditional,
    maxTotal,
    plannedRiskLossPercent,
    stressRiskLossPercent,
  });
  const numericClaimAudit = auditCandidateSizingClaims({
    numericEvidence,
    sizingReview: nextRisk.sizingReview,
    entryAllowed: nextRisk.entryAllowed,
    sizingValidUntil: nextRisk.sizingValidUntil,
  });
  const numericAuditBlocksExecution = nextRisk.entryAllowed
    && numericClaimAudit.executionAuthorized !== true;
  const numericAuditReason = numericAuditBlocksExecution
    ? `Numeric Evidence 审计未通过（${numericClaimAudit.status}）；本轮仓位裁决已安全关闭。`
    : null;
  const auditSafeExistingWeight = Math.max(
    0,
    finiteOrNull(nextRisk.existingPositionWeight) ?? 0,
  );
  const auditedRisk = {
    ...nextRisk,
    ...(numericAuditBlocksExecution ? {
      entryAllowed: false,
      recommendedInitialAdditionalWeightPercent: 0,
      recommendedInitialTotalWeightPercent: rounded(auditSafeExistingWeight),
      recommendedInitialNotionalBase: 0,
      recommendedMaxAdditionalWeightPercent: 0,
      recommendedMaxWeightPercent: rounded(auditSafeExistingWeight),
      recommendedMaxAdditionalNotionalBase: 0,
      portfolioImpactAtReferencePercent: 0,
      portfolioStressImpactPercent: 0,
      entryBlockReasons: [...new Set([
        ...(nextRisk.entryBlockReasons ?? []),
        numericAuditReason,
      ])],
      leverage: {
        ...nextRisk.leverage,
        decision: "disabled",
        additionalLeverageAllowed: false,
        initialAdditionalBorrowedWeightPercent: 0,
        maxAdditionalBorrowedWeightPercent: 0,
        disabledReasons: [...new Set([
          ...(nextRisk.leverage?.disabledReasons ?? []),
          numericAuditReason,
        ])],
      },
    } : {}),
    numericClaimAudit,
    sizingReview: {
      ...nextRisk.sizingReview,
      ...(numericAuditBlocksExecution ? {
        preNumericAuditStatus: nextRisk.sizingReview.status,
        preNumericAuditAccepted: nextRisk.sizingReview.accepted,
        status: "blocked",
        accepted: {
          ...nextRisk.sizingReview.accepted,
          initialAdditionalWeightPercent: 0,
          maxAdditionalWeightPercent: 0,
          maxTotalWeightPercent: rounded(auditSafeExistingWeight),
          initialAdditionalBorrowedWeightPercent: 0,
          maxAdditionalBorrowedWeightPercent: 0,
          leverageDecision: "disabled",
        },
        rationale: `${nextRisk.sizingReview.rationale}；${numericAuditReason}`,
      } : {}),
      numericClaimAuditStatus: numericClaimAudit.status,
      numericClaimAuditHash: numericClaimAudit.auditHash,
      executionAuthorized: numericClaimAudit.executionAuthorized,
    },
  };
  return {
    ...run,
    analysisContext: {
      ...run.analysisContext,
      ...(numericEvidence ? { numericEvidence } : {}),
      numericClaimAudit,
    },
    risk: auditedRisk,
    plan: applyReviewedCandidateSizingToPlan(run.plan, auditedRisk),
    evidence: [
      ...(run.evidence ?? []),
      {
        source: "Codex LLM 策略复核",
        tool: "codex:candidate-sizing-review",
        asOf: decisionAt,
        records: 1,
        status: auditedRisk.entryAllowed ? "succeeded" : "degraded",
        summary: auditedRisk.entryAllowed
          ? `模型建议初始新增 ${rounded(modelInitialAdditional)}% / 最大总仓位 ${rounded(modelMaxTotal)}%；宿主按 planned ${rounded(plannedRiskLossPercent)}% / stress ${rounded(stressRiskLossPercent)}% 接受 ${rounded(initialAdditional)}% / ${rounded(maxTotal)}%${limitBindings.length ? `，约束：${[...new Set(limitBindings)].join("、")}` : ""}`
          : `模型文字分析保留，但结构化仓位被阻止：${numericAuditReason ?? reviewReason}`,
      },
    ],
  };
}

function appendCandidateSizingNumericEvidence(run, {
  review,
  nextRisk,
  decisionAt,
  snapshotFreshAtDecision,
  entryAllowed,
  modelInitialAdditional,
  modelMaxTotal,
  initialAdditional,
  maxTotal,
  plannedRiskLossPercent,
  stressRiskLossPercent,
}) {
  const current = run.analysisContext?.numericEvidence;
  const facts = Array.isArray(current?.facts) ? current.facts : [];
  const preferredMetrics = new Set([
    "portfolio.net_assets",
    "portfolio.total_cash",
    "portfolio.buy_power",
    "portfolio.gross_exposure_percent",
    "policy.risk_budget_percent",
    "market.last_completed_close",
  ]);
  const preferredFacts = facts.filter((fact) => preferredMetrics.has(fact?.metric));
  const referenceFacts = (preferredFacts.length ? preferredFacts : facts).slice(0, 8);
  const inputRefs = referenceFacts.flatMap((fact) => {
    try {
      return [numericEvidenceRef(fact)];
    } catch {
      return [];
    }
  });
  if (!inputRefs.length) return current ?? null;

  const percentUnit = (basis) => ({ kind: "percent_point", basis });
  const asOf = {
    effectiveAt: decisionAt,
    retrievedAt: decisionAt,
    tradingDate: null,
    session: "not_applicable",
    timeZone: "UTC",
  };
  const proposalQuality = {
    freshness: "fresh",
    ageMs: 0,
    complete: true,
    confidence: ["high", "medium", "low", "unknown"].includes(review.sizingConfidence)
      ? review.sizingConfidence
      : "unknown",
    reasonCodes: [],
  };
  const hostReasonCodes = [
    ...(!entryAllowed ? ["host_sizing_blocked"] : []),
    ...(!snapshotFreshAtDecision ? ["portfolio_snapshot_stale_at_decision"] : []),
  ];
  const hostQuality = {
    freshness: snapshotFreshAtDecision ? "fresh" : "stale",
    ageMs: snapshotFreshAtDecision ? 0 : null,
    complete: true,
    confidence: "high",
    reasonCodes: hostReasonCodes,
  };
  const proposalFacts = [];
  const addProposal = (metric, value, basis, label) => {
    if (!Number.isFinite(value)) return;
    proposalFacts.push(createModelProposal({
      factId: `${metric}.${run.id ?? "candidate"}@${decisionAt}`,
      metric,
      value,
      availability: "known",
      unit: percentUnit(basis),
      asOf,
      provenance: {
        source: "Codex App Server",
        tool: "codex:candidate-sizing-review",
        sourceRecordId: run.id ?? null,
        rawFields: [],
        inputRefs,
        formula: null,
        methodVersion: "candidate-sizing-model-proposal/v1",
      },
      quality: proposalQuality,
      display: { precision: 2, label },
    }));
  };

  try {
    addProposal(
      "candidate.sizing.model_initial_additional_weight_percent",
      modelInitialAdditional,
      "portfolio_net_assets",
      "LLM 建议初始新增仓位",
    );
    addProposal(
      "candidate.sizing.model_max_total_weight_percent",
      modelMaxTotal,
      "portfolio_net_assets",
      "LLM 建议最大总仓位",
    );
    addProposal(
      "candidate.sizing.model_stress_loss_percent",
      boundedPercentOrNull(review.stressTest?.lossPercent),
      "candidate_position_notional",
      "LLM 建议压力损失",
    );
    addProposal(
      "candidate.sizing.model_exit_slippage_percent",
      boundedPercentOrNull(review.stressTest?.slippagePercent),
      "candidate_position_notional",
      "LLM 建议退出滑点",
    );
    const decisionRefs = [
      ...inputRefs,
      ...proposalFacts.map(numericEvidenceRef),
    ];
    const hostFacts = [];
    const derivedFacts = [];
    const addHostDecision = (
      metric,
      value,
      basis,
      label,
      formula,
      refs = decisionRefs,
      unit = null,
      rawFields = [],
      sourceRecordId = run.id ?? null,
    ) => {
      if (!Number.isFinite(value)) return;
      hostFacts.push(createHostDecision({
        factId: `${metric}.${run.id ?? "candidate"}@${decisionAt}`,
        metric,
        value,
        availability: "known",
        unit: unit ?? percentUnit(basis),
        asOf,
        provenance: {
          source: "local deterministic risk engine",
          tool: "local:candidate-sizing-guardrail",
          sourceRecordId,
          rawFields,
          inputRefs: refs,
          formula,
          methodVersion: "candidate-sizing-host-decision/v2",
        },
        quality: hostQuality,
        display: { precision: 2, label },
      }));
    };
    const addDerivedMetric = (metric, value, basis, label, formula, refs) => {
      if (!Number.isFinite(value)) return;
      derivedFacts.push(createDerivedMetric({
        factId: `${metric}.${run.id ?? "candidate"}@${decisionAt}`,
        metric,
        value,
        availability: "known",
        unit: percentUnit(basis),
        asOf,
        provenance: {
          source: "local deterministic risk engine",
          tool: "local:candidate-sizing-guardrail",
          sourceRecordId: run.id ?? null,
          rawFields: [],
          inputRefs: refs,
          formula,
          methodVersion: "candidate-sizing-derived-metric/v1",
        },
        quality: hostQuality,
        display: { precision: 4, label },
      }));
    };
    const proposalByMetric = (metric) => proposalFacts.find((fact) => fact.metric === metric);
    const marketFact = referenceFacts.find((fact) => fact.metric === "market.last_completed_close");
    const marketRef = marketFact ? numericEvidenceRef(marketFact) : null;
    const symbol = String(
      run.analysisContext?.target?.symbol
        ?? run.context?.symbol
        ?? run.technical?.symbol
        ?? "UNKNOWN",
    ).trim().toUpperCase().slice(0, 80) || "UNKNOWN";
    const currencyCandidate = String(
      run.analysisContext?.target?.currency ?? nextRisk.baseCurrency ?? "USD",
    ).trim().toUpperCase();
    const priceCurrency = /^[A-Z]{3}$/.test(currencyCandidate) ? currencyCandidate : "USD";
    const invalidationHash = createHash("sha256")
      .update(JSON.stringify(review.invalidation ?? null))
      .digest("hex");
    const acceptedReferenceLevel = finiteOrNull(nextRisk.referenceLevel);
    const acceptedRiskDistancePercent = finiteOrNull(nextRisk.riskDistancePercent);
    let acceptedReferenceFact = null;
    if (marketRef && acceptedReferenceLevel > 0) {
      addHostDecision(
        "candidate.sizing.accepted_invalidation_reference_price",
        acceptedReferenceLevel,
        null,
        "宿主接受失效参考价",
        "resolve_and_validate_structured_model_invalidation_against_market_evidence",
        [...inputRefs, ...proposalFacts.map(numericEvidenceRef)],
        {
          kind: "price",
          currency: priceCurrency,
          symbol,
          tickSize: null,
        },
        ["candidateSizing.invalidation"],
        `${run.id ?? "candidate"}:invalidation:sha256:${invalidationHash}`,
      );
      acceptedReferenceFact = hostFacts.find((fact) => (
        fact.metric === "candidate.sizing.accepted_invalidation_reference_price"
      ));
    }
    if (marketRef && acceptedReferenceFact && acceptedRiskDistancePercent > 0) {
      addDerivedMetric(
        "candidate.sizing.validated_invalidation_distance_percent",
        acceptedRiskDistancePercent,
        "candidate_last_completed_close",
        "宿主验证失效距离",
        "(market_last_completed_close - accepted_invalidation_reference_price) / market_last_completed_close * 100",
        [marketRef, numericEvidenceRef(acceptedReferenceFact)],
      );
    }
    const riskDistanceFact = derivedFacts.find((fact) => (
      fact.metric === "candidate.sizing.validated_invalidation_distance_percent"
    ));
    const modelInitialFact = proposalByMetric(
      "candidate.sizing.model_initial_additional_weight_percent",
    );
    const modelMaxFact = proposalByMetric("candidate.sizing.model_max_total_weight_percent");
    const modelStressFact = proposalByMetric("candidate.sizing.model_stress_loss_percent");
    const modelSlippageFact = proposalByMetric("candidate.sizing.model_exit_slippage_percent");
    if (riskDistanceFact && modelSlippageFact) {
      addHostDecision(
        "candidate.sizing.accepted_planned_risk_loss_percent",
        plannedRiskLossPercent,
        "candidate_position_notional",
        "宿主采用计划失效损失",
        "validated_invalidation_distance + modeled_exit_slippage",
        [numericEvidenceRef(riskDistanceFact), numericEvidenceRef(modelSlippageFact)],
      );
    }
    const plannedRiskFact = hostFacts.find((fact) => (
      fact.metric === "candidate.sizing.accepted_planned_risk_loss_percent"
    ));
    if (modelStressFact && plannedRiskFact) {
      addHostDecision(
        "candidate.sizing.accepted_stress_risk_loss_percent",
        stressRiskLossPercent,
        "candidate_position_notional",
        "宿主采用压力损失",
        "max(model_stress_loss, accepted_planned_risk_loss)",
        [numericEvidenceRef(modelStressFact), numericEvidenceRef(plannedRiskFact)],
      );
    }
    const acceptedStressFact = hostFacts.find((fact) => (
      fact.metric === "candidate.sizing.accepted_stress_risk_loss_percent"
    ));
    addHostDecision(
      "candidate.sizing.accepted_max_total_weight_percent",
      maxTotal,
      "portfolio_net_assets",
      "宿主接受最大总仓位",
      "max(existing_weight, min(model_max_total, account_cap, group_cap, stress_risk_cap, gross_cap, buy_power_cap, cash_cap_if_required))",
      [
        ...inputRefs,
        ...(modelMaxFact ? [numericEvidenceRef(modelMaxFact)] : []),
        ...(acceptedStressFact ? [numericEvidenceRef(acceptedStressFact)] : []),
      ],
    );
    const acceptedMaxFact = hostFacts.find((fact) => (
      fact.metric === "candidate.sizing.accepted_max_total_weight_percent"
    ));
    addHostDecision(
      "candidate.sizing.accepted_initial_additional_weight_percent",
      initialAdditional,
      "portfolio_net_assets",
      "宿主接受初始新增仓位",
      "entry_allowed ? min(model_initial_additional, accepted_max_additional) : 0",
      [
        ...inputRefs,
        ...(modelInitialFact ? [numericEvidenceRef(modelInitialFact)] : []),
        ...(acceptedMaxFact ? [numericEvidenceRef(acceptedMaxFact)] : []),
      ],
    );
    const nextFacts = [...facts, ...proposalFacts, ...hostFacts, ...derivedFacts];
    return {
      ...(current ?? {}),
      packageVersion: current?.packageVersion ?? "core-numeric-evidence/v1",
      schemaVersion: current?.schemaVersion ?? "numeric-evidence/v1",
      status: current?.status === "complete" ? "complete" : "partial",
      facts: nextFacts,
      factCount: nextFacts.length,
      knownCount: nextFacts.filter((fact) => fact.availability === "known").length,
      invariants: {
        ...(current?.invariants ?? {}),
        unknownIsNeverZero: true,
        percentageUnit: "percent_point",
        modelMayCreateHostDecision: false,
      },
      sizingDecision: {
        decisionAt,
        proposalFactIds: proposalFacts.map((fact) => fact.factId),
        hostDecisionFactIds: hostFacts.map((fact) => fact.factId),
        derivedMetricFactIds: derivedFacts.map((fact) => fact.factId),
        entryAllowed: Boolean(nextRisk.entryAllowed),
      },
    };
  } catch {
    return current ?? null;
  }
}

function applyReviewedCandidateSizingToPlan(plan, risk) {
  if (!plan?.available) return plan;
  const sizing = {
    ...(plan.sizing ?? {}),
    initialAdditionalWeightPercent: risk.recommendedInitialAdditionalWeightPercent,
    initialTotalWeightPercent: risk.recommendedInitialTotalWeightPercent,
    initialNotionalBase: risk.recommendedInitialNotionalBase,
    maxAdditionalWeightPercent: risk.recommendedMaxAdditionalWeightPercent,
    maxTotalWeightPercent: risk.recommendedMaxWeightPercent,
    maxAdditionalNotionalBase: risk.recommendedMaxAdditionalNotionalBase,
    holdingHorizon: risk.holdingHorizon,
    plannedRiskLossPercent: risk.plannedRiskLossPercent,
    stressRiskLossPercent: risk.stressRiskLossPercent,
    leverageDecision: risk.leverage?.decision,
    initialAdditionalBorrowedWeightPercent:
      risk.leverage?.initialAdditionalBorrowedWeightPercent ?? 0,
    maxAdditionalBorrowedWeightPercent:
      risk.leverage?.maxAdditionalBorrowedWeightPercent ?? 0,
  };
  if (!risk.entryAllowed) {
    return {
      ...plan,
      state: "candidate_blocked",
      riskSizingAvailable: false,
      sizing,
      leverage: risk.leverage,
      scenarios: [
        {
          name: "暂停新增风险",
          tone: "bear",
          if: risk.sizingReview?.rationale || "LLM 方案未通过本地硬安全边界",
          then: "有效新增仓位为 0%；保留模型研究结论，待证据或账户边界更新后重算",
          invalidation: "风险禁用条件解除，并重新运行候选分析",
          impact: "新增组合影响保持 0",
          status: "snapshot_only",
        },
        ...(plan.scenarios ?? []).filter((item) => item.name !== "允许试探"),
      ],
    };
  }
  const scenarios = (plan.scenarios ?? []).map((item) => item.name === "允许试探"
    ? {
        ...item,
        then: `LLM 建议经硬边界校验后：有效初始新增 ${rounded(risk.recommendedInitialAdditionalWeightPercent)}%，有效最大总仓位 ${rounded(risk.recommendedMaxWeightPercent)}%；${risk.leverage?.decision === "margin_within_cap" ? `允许最多 ${rounded(risk.leverage.maxAdditionalBorrowedWeightPercent)}% 融资新增，组合毛暴露不得超过 150%` : "仅允许现金覆盖"}，成交前用最新快照重算`,
        invalidation: `日线按「${risk.referenceLabel} ${rounded(risk.referenceLevel)}」确认失效`,
        impact: `计划失效影响约 ${rounded(risk.portfolioImpactAtReferencePercent)}%；压力情景组合影响约 ${rounded(risk.portfolioStressImpactPercent)}%`,
      }
    : item);
  return {
    ...plan,
    riskSizingAvailable: true,
    sizing,
    leverage: risk.leverage,
    scenarios,
  };
}

function resolveModelFibReview(run, review) {
  const decision = review?.decision ?? "insufficient_evidence";
  if (decision === "ignore" || decision === "insufficient_evidence") {
    return {
      decision,
      status: decision === "ignore" ? "ignored" : "insufficient_evidence",
      selected: null,
      confidence: review?.confidence ?? "unknown",
      emphasizedRatios: review?.emphasizedRatios ?? [],
      rationale: review?.rationale ?? "",
    };
  }
  if (decision === "use_auto") {
    const auto = run?.technical?.fib;
    if (!auto?.anchors || !auto?.levels) {
      return {
        decision,
        status: "invalid",
        selected: null,
        confidence: review?.confidence ?? "unknown",
        emphasizedRatios: review?.emphasizedRatios ?? [],
        rationale: "LLM 选择了自动 Fib，但本轮没有可用的自动锚点。",
      };
    }
    return {
      decision,
      status: "selected",
      selected: {
        ...auto,
        method: "llm_selected_auto",
        role: "selected",
        advisory: false,
        decisionAuthority: "LLM",
      },
      confidence: review?.confidence ?? "unknown",
      emphasizedRatios: review?.emphasizedRatios ?? [],
      rationale: review?.rationale ?? "",
    };
  }
  if (decision !== "override") {
    return {
      decision: "insufficient_evidence",
      status: "invalid",
      selected: null,
      confidence: "unknown",
      emphasizedRatios: [],
      rationale: "Fib 决策无效。",
    };
  }

  const bars = officialContextBars(run);
  const barIndex = new Map(bars.map((bar, index) => [String(bar.barId), { bar, index }]));
  const direction = review?.direction;
  const expectedFields = direction === "up"
    ? { a: "low", b: "high", c: "low" }
    : direction === "down"
      ? { a: "high", b: "low", c: "high" }
      : null;
  const resolved = {};
  for (const key of ["a", "b", "c"]) {
    const requested = review?.anchors?.[key];
    const found = requested ? barIndex.get(String(requested.barId)) : null;
    if (!found || !expectedFields || requested.field !== expectedFields[key]) {
      return {
        decision,
        status: "invalid",
        selected: null,
        confidence: review?.confidence ?? "unknown",
        emphasizedRatios: review?.emphasizedRatios ?? [],
        rationale: `Fib ${key.toUpperCase()} 锚点不存在、尚未收盘或字段方向不符合 ${direction || "unknown"} 结构。`,
      };
    }
    resolved[key] = {
      barId: String(requested.barId),
      date: found.bar.tradeDate ?? found.bar.time,
      field: requested.field,
      price: finiteOrNull(found.bar[requested.field]),
      index: found.index,
    };
  }
  const chronological = resolved.a.index < resolved.b.index && resolved.b.index < resolved.c.index;
  const directional = direction === "up"
    ? resolved.a.price < resolved.c.price && resolved.c.price < resolved.b.price
    : resolved.a.price > resolved.c.price && resolved.c.price > resolved.b.price;
  if (!chronological || !directional) {
    return {
      decision,
      status: "invalid",
      selected: null,
      confidence: review?.confidence ?? "unknown",
      emphasizedRatios: review?.emphasizedRatios ?? [],
      rationale: "LLM 选择的 Fib A/B/C 时序或价格关系不成立。",
    };
  }
  const levels = {};
  for (const ratio of [0.382, 0.618, 1, 1.618]) {
    levels[String(ratio)] = rounded(
      resolved.c.price + (resolved.b.price - resolved.a.price) * ratio,
      4,
    );
  }
  const publicAnchors = Object.fromEntries(
    Object.entries(resolved).map(([key, anchor]) => [
      key,
      {
        barId: anchor.barId,
        date: anchor.date,
        field: anchor.field,
        price: anchor.price,
      },
    ]),
  );
  return {
    decision,
    status: "selected",
    selected: {
      direction,
      anchors: publicAnchors,
      levels,
      formula: "C + (B - A) × ratio",
      method: "llm_override",
      role: "selected",
      automated: false,
      advisory: false,
      decisionAuthority: "LLM",
    },
    confidence: review?.confidence ?? "unknown",
    emphasizedRatios: review?.emphasizedRatios ?? [],
    rationale: review?.rationale ?? "",
  };
}

function resolveModelInvalidation(run, review, fibReview) {
  if (!review || review.kind === "none") {
    return {
      valid: false,
      kind: "none",
      level: null,
      label: null,
      reason: "LLM 未给出可校验的失效依据",
    };
  }
  let level = null;
  let label = null;
  if (review.kind === "bar") {
    const bar = officialContextBars(run)
      .find((item) => String(item.barId) === String(review.barId));
    level = finiteOrNull(bar?.[review.field]);
    label = bar && level != null
      ? `${review.barId} ${String(review.field).toUpperCase()}`
      : null;
  } else if (review.kind === "ema") {
    if ([144, 169].includes(review.emaPeriod)
      && run?.technical?.emaMaturity?.[review.emaPeriod]?.mature !== true) {
      return {
        valid: false,
        kind: review.kind,
        level: null,
        label: `EMA${review.emaPeriod}`,
        reason: `EMA${review.emaPeriod} 尚未达到成熟样本要求，不能作为结构化仓位的失效依据`,
      };
    }
    level = finiteOrNull(run?.technical?.ema?.[review.emaPeriod]);
    label = level == null ? null : `EMA${review.emaPeriod}`;
  } else if (review.kind === "range20") {
    level = finiteOrNull(run?.technical?.range20?.[review.rangeKey]);
    label = level == null
      ? null
      : review.rangeKey === "priorLow"
        ? "前20日低点"
        : "前20日高点";
  } else if (review.kind === "fib") {
    if (fibReview?.status !== "selected") {
      return {
        valid: false,
        kind: review.kind,
        level: null,
        label: null,
        reason: "Fib 失效依据要求 LLM 先选择并通过宿主校验的 Fib",
      };
    }
    if (!["high", "medium"].includes(fibReview?.confidence)) {
      return {
        valid: false,
        kind: review.kind,
        level: null,
        label: `LLM Fib ${review.fibRatio}`,
        reason: "Fib 失效依据的 LLM 置信度不足，必须为 high 或 medium",
      };
    }
    level = finiteOrNull(fibReview?.selected?.levels?.[String(review.fibRatio)]);
    label = level == null ? null : `LLM Fib ${review.fibRatio}`;
  }
  const lastPrice = finiteOrNull(run?.technical?.lastPrice);
  if (!(level > 0) || !(lastPrice > 0)) {
    return {
      valid: false,
      kind: review.kind,
      level: null,
      label,
      reason: "LLM 失效依据引用了不存在或无效的数据点",
    };
  }
  if (level >= lastPrice) {
    return {
      valid: false,
      kind: review.kind,
      level: rounded(level),
      label,
      reason: "候选多头计划的失效位必须低于当前正式收盘价",
    };
  }
  return {
    valid: true,
    kind: review.kind,
    level: rounded(level),
    label,
    confirmation: review.confirmation,
    rationale: review.rationale,
    reason: null,
  };
}

function officialContextBars(run) {
  const asOfMs = Date.parse(String(run?.technical?.asOf ?? ""));
  const bars = Array.isArray(run?.analysisContext?.technical?.priceBars)
    ? run.analysisContext.technical.priceBars
    : [];
  return bars.filter((bar) => {
    const timeMs = Date.parse(String(bar?.time ?? bar?.barId ?? ""));
    return Number.isFinite(timeMs)
      && Number.isFinite(asOfMs)
      && timeMs <= asOfMs;
  });
}

function rounded(value, digits = 2) {
  const numeric = finiteOrNull(value);
  if (numeric == null) return null;
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
}

export function findRequestedSkills(text, skills) {
  const requested = new Set(
    [...String(text ?? "").matchAll(/(?:^|\s)\$([\w:-]+)/g)].map((match) => match[1]),
  );
  return skills.filter((skill) => requested.has(skill.name));
}

function analysisSkillsForScope(text, skills, scope, reviewProtocol = null) {
  const explicit = findRequestedSkills(text, skills);
  const automaticNames = scope === "chat" ? new Set() : scope === "review"
    ? reviewProtocol === "decision_cycle"
      ? new Set(["review-decision-cycles"])
      : new Set(["review-earnings-decisions"])
    : scope === "portfolio"
      ? new Set(["analyze-market-narratives"])
      : new Set(["analyze-market-narratives", "analyze-technical-structure"]);
  const automatic = skills.filter((skill) => automaticNames.has(skill.name));
  return [...new Map([...explicit, ...automatic].map((skill) => [skill.name, skill])).values()];
}

function requiredReviewSkillName(evidence) {
  if (evidence?.analysisScope !== "review") return null;
  return evidence?.context?.reviewProtocol === "decision_cycle"
    || evidence?.scopedContext?.reviewProtocol === "decision_cycle"
    ? "review-decision-cycles"
    : "review-earnings-decisions";
}

export function findRequestedApps(text, apps) {
  const requested = new Set(
    [...String(text ?? "").matchAll(/(?:^|\s)\$([\w:-]+)/g)]
      .map((match) => match[1].toLowerCase()),
  );
  return apps.filter((app) => requested.has(app.id.toLowerCase()));
}

export function expandAgentCommand(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^\/(full|technical|risk|plan|history)\b\s*/i);
  if (!match) return text;
  const commands = {
    full: "完整分析当前持仓的技术结构、组合风险、叙事冲突与牛/基准/熊条件计划。",
    technical: "综合分析价格/成交量、趋势动量、相对强弱、筹码或成本结构、波动率、板块同行与事件反应；EMA、Fib、AVWAP 等按适用性选用。",
    risk: "重点检查当前持仓权重、组合集中度、主题重复暴露、汇率口径与风险预算。",
    plan: "基于当前证据生成牛、基准、熊三种条件计划，并列出触发、动作、失效和组合影响。",
    history: "调用 query_recent_history，只查询并总结最近 30 天的交易驾驶舱对话；不要读取归档目录。",
  };
  return `${commands[match[1].toLowerCase()]} ${text.slice(match[0].length)}`.trim();
}

export function agentCommands() {
  return [
    { name: "/full", description: "完整技术、风险与条件计划" },
    { name: "/technical", description: "综合技术、筹码与相对强弱证据" },
    { name: "/risk", description: "聚焦仓位、集中度与风险预算" },
    { name: "/plan", description: "聚焦牛/基准/熊条件计划" },
    { name: "/history", description: "查询最近 30 天的 Agent 对话" },
  ];
}

export function cockpitDynamicTools() {
  return [{
    type: "function",
    name: "query_recent_history",
    description: "Search and read only the Trading Cockpit Codex conversations from the most recent 30 days. Older conversations are archived and intentionally unavailable through this tool.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional case-insensitive text to look for in recent conversation messages.",
          maxLength: 200,
        },
        limit: {
          type: "integer",
          description: "Maximum recent threads to inspect.",
          minimum: 1,
          maximum: 12,
          default: 8,
        },
      },
      additionalProperties: false,
    },
  }];
}

function normalizeSkill(skill) {
  if (!skill?.name || !skill?.path) return null;
  return {
    name: String(skill.name),
    path: String(skill.path),
    scope: String(skill.scope ?? "user"),
    description: String(skill.description ?? skill.shortDescription ?? ""),
    displayName: String(skill.interface?.displayName ?? skill.name),
  };
}

function emptyReadOnlyGuard() {
  return {
    config: {},
    blockedTools: [],
    blockedApps: [],
    guardedServerNames: [],
    tradingViewTools: {},
    inventoryVerified: false,
    residualTools: [],
    residualApps: [],
  };
}

function emptyAdditionalContextContract() {
  return {
    mode: "experimental_required_fail_closed",
    status: "unverified",
    error: null,
  };
}

function verifiedAdditionalContextContract() {
  return {
    mode: "experimental_required_fail_closed",
    status: "verified",
    error: null,
  };
}

function isAdditionalContextContractFailure(error) {
  const code = Number(error?.rpcCode);
  const message = String(error?.message ?? "");
  return code === -32602
    || /(?:additionalContext|additional_context).*(?:unsupported|unknown|invalid|unexpected)/i.test(message)
    || /(?:unsupported|unknown|invalid|unexpected).*(?:additionalContext|additional_context)/i.test(message)
    || /invalid params[^\n]*\(-32602\)/i.test(message);
}

function createAdditionalContextContractError(error) {
  const detail = cleanError(error);
  return new CodexWorkspaceError(
    "protocol",
    "Codex App Server 拒绝了包含 additionalContext 的 turn/start 实验协议；为避免把持仓或复盘证据静默降级为普通 text，本轮已停止。请升级或切换到支持 experimentalApi + additionalContext 的 Codex App Server 后重试。"
      + (detail ? ` 原始错误：${detail}` : ""),
    {
      cause: error,
      rpcCode: Number.isFinite(Number(error?.rpcCode)) ? Number(error.rpcCode) : null,
      rpcMethod: "turn/start",
      rpcData: error?.rpcData ?? null,
    },
  );
}

function createExperimentalApiInitializationError(error) {
  const detail = cleanError(error);
  return new CodexWorkspaceError(
    "protocol",
    "Codex App Server 不支持交易驾驶舱所需的 experimentalApi 初始化协议，因此无法安全传输 additionalContext；本轮已停止，且不会把受保护证据改写到普通 text。请升级或切换 Codex App Server 后重试。"
      + (detail ? ` 原始错误：${detail}` : ""),
    {
      cause: error,
      rpcCode: Number.isFinite(Number(error?.rpcCode)) ? Number(error.rpcCode) : null,
      rpcMethod: "initialize",
      rpcData: error?.rpcData ?? null,
    },
  );
}

export function buildReadOnlyToolGuard({ effectiveConfig = {} } = {}) {
  const configuredApps = plainObject(effectiveConfig?.apps);
  const config = {
    apps: {
      ...structuredClone(configuredApps),
      _default: { ...plainObject(configuredApps._default), destructive_enabled: false },
    },
  };
  const blockedTools = [];
  const blockedApps = [{ id: "_default", name: "Destructive App actions" }];
  const guardedServerNames = new Set();
  const tradingViewTools = {};
  const directServers = plainObject(effectiveConfig?.mcp_servers);
  for (const [serverId, serverConfigValue] of Object.entries(directServers)) {
    const serverConfig = plainObject(serverConfigValue);
    const tradingViewPolicy = tradingViewReadOnlyOverride(serverConfig);
    if (tradingViewPolicy) {
      config.mcp_servers ??= {};
      config.mcp_servers[serverId] = tradingViewPolicy;
      tradingViewTools[serverId] = tradingViewPolicy.enabled_tools
        .filter((name) => !tradingViewPolicy.disabled_tools?.includes(name));
      continue;
    }
    if (!isBrokerageServer({ ...serverConfig, name: serverId })) continue;
    const disabledTools = mergeDisabledBrokerageTools(serverConfig.disabled_tools);
    config.mcp_servers ??= {};
    config.mcp_servers[serverId] = { disabled_tools: disabledTools };
    addGuardedServerAliases(guardedServerNames, serverId);
    for (const tool of BROKERAGE_WRITE_TOOLS) blockedTools.push({ server: serverId, tool });
  }

  const plugins = plainObject(effectiveConfig?.plugins);
  for (const [pluginId, pluginConfigValue] of Object.entries(plugins)) {
    const pluginConfig = plainObject(pluginConfigValue);
    const pluginServers = plainObject(pluginConfig.mcp_servers);
    for (const [serverId, serverConfigValue] of Object.entries(pluginServers)) {
      const serverConfig = plainObject(serverConfigValue);
      if (!isBrokerageServer({ ...serverConfig, name: `${pluginId}/${serverId}` })) continue;
      const disabledTools = mergeDisabledBrokerageTools(serverConfig.disabled_tools);
      config.plugins ??= {};
      config.plugins[pluginId] ??= { mcp_servers: {} };
      config.plugins[pluginId].mcp_servers[serverId] = { disabled_tools: disabledTools };
      for (const alias of [serverId, `${pluginId}.${serverId}`, `${pluginId}:${serverId}`, `${pluginId}/${serverId}`]) {
        addGuardedServerAliases(guardedServerNames, alias);
      }
      for (const tool of BROKERAGE_WRITE_TOOLS) {
        blockedTools.push({ server: `${pluginId}/${serverId}`, tool });
      }
    }
  }

  for (const [appId, appConfigValue] of Object.entries(configuredApps)) {
    if (appId === "_default") continue;
    const appConfig = plainObject(appConfigValue);
    if (appConfig.destructive_enabled === true) {
      config.apps[appId] = { ...config.apps[appId], destructive_enabled: false };
      blockedApps.push({ id: appId, name: appId });
    }
  }

  return {
    config,
    blockedTools,
    blockedApps,
    guardedServerNames: [...guardedServerNames],
    tradingViewTools,
  };
}

function isAllowedTradingViewInventoryTool(server, tool, policies = {}) {
  if (!Object.hasOwn(policies, server.name)) return true;
  return policies[server.name].includes(tool.name)
    && tool.annotations?.readOnlyHint !== false
    && tool.annotations?.destructiveHint !== true;
}

function visibleTradingViewDisallowedTools(servers, policies = {}) {
  return servers.flatMap((server) => server.tools
    .filter((tool) => !isAllowedTradingViewInventoryTool(server, tool, policies))
    .map((tool) => ({ server: server.name, tool: tool.name })));
}

function mergeDisabledBrokerageTools(existing) {
  const values = Array.isArray(existing)
    ? existing.map((value) => String(value)).filter(Boolean)
    : [];
  return [...new Set([...values, ...BROKERAGE_WRITE_TOOLS])];
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function canonicalIdentifier(value) {
  return String(value ?? "")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isLongbridgeIdentifier(value) {
  const normalized = canonicalIdentifier(value);
  return normalized.includes("longbridge")
    || normalized.includes("long_bridge")
    || normalized.includes("长桥");
}

function isOfficialLongbridgeUrl(value) {
  if (!value) return false;
  try {
    return OFFICIAL_LONGBRIDGE_HOSTS.has(new URL(String(value)).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function addGuardedServerAliases(target, name) {
  const raw = String(name ?? "").trim();
  if (!raw) return;
  target.add(raw);
  target.add(canonicalIdentifier(raw));
}

function isVerifiedLongbridgeReadTool(tool) {
  return LONGBRIDGE_READ_ONLY_TOOLS.has(canonicalIdentifier(tool?.name));
}

function serverIsGuarded(server, guardedServerNames) {
  return guardedServerNames.has(String(server?.name ?? ""))
    || guardedServerNames.has(canonicalIdentifier(server?.name));
}

function isLongbridgeInventoryServer(server) {
  return isLongbridgeIdentifier(server?.name)
    || isLongbridgeIdentifier(server?.title)
    || isOfficialLongbridgeUrl(server?.websiteUrl);
}

function isGuardedBrokerageWriteTool(server, tool, guardedServerNames) {
  return ["transaction_write", "unverified_transaction_capability", "unverified_broker_capability"]
    .includes(classifyBrokerageTool(server, tool));
}

function visibleBrokerageWriteTools(servers, guardedServerNames) {
  const residual = [];
  for (const server of servers) {
    for (const tool of server.tools) {
      const classification = classifyBrokerageTool(server, tool);
      const mustBlock = ["transaction_write", "unverified_transaction_capability", "unverified_broker_capability"]
        .includes(classification)
        || (isLongbridgeInventoryServer(server) && !isVerifiedLongbridgeReadTool(tool));
      if (mustBlock) {
        residual.push({ server: server.name, tool: tool.name });
      }
    }
  }
  return residual;
}

function assertBrokerInventoryAvailable(servers, guardedServerNames = []) {
  const guarded = new Set(guardedServerNames);
  if (servers.some(server => server.toolsUnavailable
    && (server.name === "codex_apps" || serverIsGuarded(server, guarded) || isBrokerageServer(server)))) {
    throw new CodexWorkspaceError("read_only_guard", "券商 MCP 工具清单未完整返回；请确认服务连接与授权后重新检查。未把缺失清单当作没有写工具。");
  }
}

function receiptDeniesMcpTool(receipt, tool) {
  const policies = [];
  const direct = receipt.config.mcp_servers?.[tool.server];
  if (direct) policies.push(direct);
  for (const [pluginId, plugin] of Object.entries(receipt.config.plugins ?? {})) {
    for (const [serverId, policy] of Object.entries(plugin?.mcp_servers ?? {})) {
      if ([serverId, `${pluginId}.${serverId}`, `${pluginId}:${serverId}`, `${pluginId}/${serverId}`].includes(tool.server)) policies.push(policy);
    }
  }
  // A short alias shared by multiple servers cannot attest which override
  // the runtime accepted. Do not turn an ambiguous match into a receipt.
  if (policies.length !== 1) return false;
  const policy = policies[0];
  return Array.isArray(policy?.disabled_tools) && policy.disabled_tools.includes(tool.tool)
    || Array.isArray(policy?.enabled_tools) && !policy.enabled_tools.includes(tool.tool);
}

async function listAllMcpServerStatuses(rpc, { threadId } = {}) {
  const data = [];
  const seenCursors = new Set();
  let cursor = null;
  for (let page = 0; page < MAX_MCP_INVENTORY_PAGES; page += 1) {
    const value = await rpc.request("mcpServerStatus/list", {
      threadId,
      detail: "toolsAndAuthOnly",
      limit: 100,
      ...(cursor == null ? {} : { cursor }),
    });
    if (!Array.isArray(value?.data)) {
      throw new CodexWorkspaceError(
        "protocol",
        "Codex MCP 能力清单返回了无效分页数据；只读保护未验证。",
      );
    }
    data.push(...value.data);
    const nextCursor = value?.nextCursor == null
      ? null
      : String(value.nextCursor).trim() || null;
    if (!nextCursor) return { data, nextCursor: null };
    if (seenCursors.has(nextCursor)) {
      throw new CodexWorkspaceError(
        "protocol",
        "Codex MCP 能力清单返回了循环分页游标；只读保护未验证。",
      );
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new CodexWorkspaceError(
    "protocol",
    `Codex MCP 能力清单超过 ${MAX_MCP_INVENTORY_PAGES} 页；只读保护未验证。`,
  );
}

function normalizeMcpServer(server) {
  return {
    name: String(server?.name ?? "unknown"),
    title: String(server?.serverInfo?.title ?? server?.name ?? "unknown"),
    websiteUrl: String(server?.serverInfo?.websiteUrl ?? ""),
    authStatus: String(server?.authStatus ?? "unknown"),
    runtimeStatus: ["notStarted", "starting", "connected", "authenticationRequired", "failed", "cancelled", "disabled"].includes(server?.runtimeStatus)
      ? server.runtimeStatus : null,
    toolsUnavailable: Boolean(server?.toolsError),
    tools: Object.values(server?.tools ?? {}).map((tool) => ({
      name: String(tool?.name ?? "unknown"),
      title: String(tool?.title ?? tool?.name ?? "unknown"),
      description: String(tool?.description ?? ""),
      annotations: tool?.annotations ?? null,
      inputSchema: tool?.inputSchema ?? null,
    })),
  };
}

function normalizeApp(app) {
  if (!app?.id || !app?.name) return null;
  return {
    id: String(app.id),
    name: String(app.name),
    description: String(app.description ?? app.appMetadata?.seoDescription ?? ""),
  };
}

function summarizeToolItem(item, lifecycle) {
  const label = item.type === "mcpToolCall"
    ? `${item.server}.${item.tool}`
    : item.type === "commandExecution"
      ? item.command
      : item.type === "webSearch"
        ? item.query
        : item.tool ?? item.path ?? item.type;
  return {
    itemId: String(item.id ?? item.callId ?? `${item.type}:${label ?? "tool"}`),
    type: item.type,
    label: String(label ?? item.type).slice(0, 240),
    lifecycle,
    status: item.status ?? lifecycle,
  };
}

export function extractThreadTranscript(thread, { query = "", maxBytes = 12_000 } = {}) {
  const entries = [];
  const turns = Array.isArray(thread) ? thread : thread?.turns ?? [];
  for (const turn of turns) {
    const turnEntries = Array.isArray(turn?.entries)
      ? turn.entries
      : extractHistoryTurnEntries(turn);
    for (const entry of turnEntries) {
      if (!entry?.text) continue;
      entries.push({ role: entry.role, text: String(entry.text) });
    }
  }
  const normalizedQuery = String(query ?? "").toLowerCase();
  const filtered = normalizedQuery
    ? entries.filter((entry) => entry.text.toLowerCase().includes(normalizedQuery))
    : entries;
  let remaining = Math.max(1_000, Number(maxBytes) || 12_000);
  const result = [];
  for (const entry of filtered.slice(-40).reverse()) {
    if (remaining <= 0) break;
    const match = normalizedQuery ? entry.text.toLowerCase().indexOf(normalizedQuery) : -1;
    const start = match >= 0 ? Math.max(0, match - Math.floor(remaining / 3)) : Math.max(0, entry.text.length - remaining);
    const text = entry.text.slice(start, start + remaining);
    remaining -= text.length;
    result.push({ role: entry.role, text });
  }
  return result.reverse();
}

function normalizeOwnedThreadRegistry(value) {
  const source = Array.isArray(value?.threads)
    ? value.threads
    : value?.threads && typeof value.threads === "object"
      ? Object.values(value.threads)
      : [];
  return {
    version: 1,
    updatedAt: isoTimestamp(value?.updatedAt) ?? null,
    threads: source
      .map((entry) => ({
        threadId: String(entry?.threadId ?? entry?.id ?? ""),
        cwd: String(entry?.cwd ?? ""),
        name: normalizeSessionName(entry?.name) ?? HISTORY_THREAD_NAME,
        preview: String(entry?.preview ?? "").replace(/\s+/g, " ").slice(0, 500),
        createdAt: isoTimestamp(entry?.createdAt),
        updatedAt: isoTimestamp(entry?.updatedAt ?? entry?.registeredAt ?? entry?.createdAt),
        registeredAt: isoTimestamp(entry?.registeredAt) ?? null,
        archivedAt: isoTimestamp(entry?.archivedAt),
        reviewBinding: normalizeReviewThreadBinding(entry?.reviewBinding),
        researchBinding: normalizeResearchThreadBinding(entry?.researchBinding),
        toolMode: entry?.toolMode === "restricted" ? "restricted" : "full",
        reviewQuarantine: normalizeReviewQuarantine(entry?.reviewQuarantine),
      }))
      .filter((entry) => entry.threadId),
  };
}

function normalizeSessionMetadata(registryEntry, liveThread, currentThreadId) {
  const updatedAt = isoTimestamp(
    liveThread?.recencyAt
    ?? liveThread?.updatedAt
    ?? registryEntry?.updatedAt
    ?? registryEntry?.registeredAt
    ?? registryEntry?.createdAt,
  );
  return {
    id: String(registryEntry.threadId),
    name: normalizeSessionName(liveThread?.name ?? registryEntry?.name) ?? HISTORY_THREAD_NAME,
    preview: String(liveThread?.preview ?? registryEntry?.preview ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 500),
    createdAt: isoTimestamp(liveThread?.createdAt ?? registryEntry?.createdAt),
    updatedAt,
    current: String(registryEntry.threadId) === String(currentThreadId ?? ""),
    reviewBinding: normalizeReviewThreadBinding(registryEntry?.reviewBinding),
    researchBinding: normalizeResearchThreadBinding(registryEntry?.researchBinding),
    toolMode: registryEntry?.toolMode === "restricted" ? "restricted" : "full",
    reviewContext: reviewThreadBindingContext(registryEntry?.reviewBinding),
    researchContext: researchThreadBindingContext(registryEntry?.researchBinding),
  };
}

function activeSessionResponse(metadata) {
  if (!metadata?.threadId) return null;
  return {
    id: String(metadata.threadId),
    name: normalizeSessionName(metadata.name) ?? HISTORY_THREAD_NAME,
    preview: String(metadata.preview ?? "").replace(/\s+/g, " ").slice(0, 500),
    createdAt: isoTimestamp(metadata.createdAt),
    updatedAt: isoTimestamp(metadata.updatedAt),
    current: true,
    reviewBinding: normalizeReviewThreadBinding(metadata.reviewBinding),
    researchBinding: normalizeResearchThreadBinding(metadata.researchBinding),
    toolMode: metadata.toolMode === "restricted" ? "restricted" : "full",
    reviewContext: reviewThreadBindingContext(metadata.reviewBinding),
    researchContext: researchThreadBindingContext(metadata.researchBinding),
  };
}

function normalizeReviewQuarantine(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const quarantinedAt = isoTimestamp(value.quarantinedAt);
  if (!quarantinedAt || value.reason !== "blind_external_tool_started") return null;
  const clean = (input, limit) => {
    const text = String(input ?? "").trim();
    return text ? text.slice(0, limit) : null;
  };
  return Object.freeze({
    quarantinedAt,
    reason: "blind_external_tool_started",
    turnId: clean(value.turnId, 240),
    operationId: clean(value.operationId, 240),
    itemType: clean(value.itemType, 80),
    itemId: clean(value.itemId, 240),
  });
}

function normalizeSessionName(value) {
  const name = String(value ?? "").replace(/\s+/g, " ").trim();
  return name ? name.slice(0, SESSION_NAME_MAX_LENGTH) : null;
}

function defaultSessionName() {
  return "新对话";
}

function isProvisionalSessionName(value) {
  const name = normalizeSessionName(value);
  return !name
    || name === "新对话"
    || name === HISTORY_THREAD_NAME
    || /^交易(?:会话|分析)\s+\d{1,2}[/-]\d{1,2}/.test(name);
}

export function summarizeSessionTitle(value) {
  let text = String(value ?? "")
    .replace(/(?:^|\s)[$@][\w:.-]+/g, " ")
    .replace(/(?:^|\s)\/[\w-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  text = text
    .replace(/^(?:请|麻烦)?(?:帮我|给我)?(?:分析|评估|检查|看一下|看看)\s*/u, "")
    .replace(/[。！？!?；;\n].*$/u, "")
    .trim();
  if (!text) return "新对话";
  const characters = Array.from(text);
  const compact = characters.slice(0, 32).join("");
  return characters.length > 32 ? `${compact}…` : compact;
}

function normalizeRecentHistoryIndex(value) {
  const source = Array.isArray(value?.threads)
    ? value.threads
    : value?.threads && typeof value.threads === "object"
      ? Object.values(value.threads)
      : [];
  return {
    version: 1,
    updatedAt: isoTimestamp(value?.updatedAt) ?? null,
    threads: source.map(normalizeStoredHistoryRecord).filter((record) => record.id),
  };
}

function normalizeStoredHistoryRecord(record) {
  const base = normalizeHistoryThread({ ...record, id: record?.id }, null);
  const turns = (record?.turns ?? [])
    .map((turn) => normalizeHistoryTurn(turn, 0))
    .filter(Boolean);
  return historyRecordFromTurns(base, turns, {
    archived: Boolean(record?.archived),
    archivedAt: isoTimestamp(record?.archivedAt),
    coverage: record?.coverage ?? null,
  });
}

function normalizeHistoryTurn(turn, cutoffMs, { query = "" } = {}) {
  const timestamp = historyTurnTimestampMs(turn);
  // Unknown timestamps cannot be proven to fall inside the 30-day boundary.
  if (timestamp <= 0 || timestamp < cutoffMs) return null;
  const entries = (Array.isArray(turn?.entries) ? turn.entries : extractHistoryTurnEntries(turn))
    .map((entry) => {
      const role = entry?.role === "assistant" ? "assistant" : "user";
      const text = sanitizeHistoryText(entry?.text, role);
      const match = query ? text.toLowerCase().indexOf(query) : -1;
      const start = match >= 0 && match + query.length > MAX_HISTORY_ENTRY_BYTES
        ? Math.max(0, match - Math.floor(MAX_HISTORY_ENTRY_BYTES / 3)) : 0;
      return { role, text: text.slice(start, start + MAX_HISTORY_ENTRY_BYTES),
        textComplete: entry?.textComplete !== false && text.length <= MAX_HISTORY_ENTRY_BYTES,
        sourceCharacters: Math.max(Number(entry?.sourceCharacters) || 0, text.length),
        excerptStart: start || Number(entry?.excerptStart) || 0 };
    })
    .filter((entry) => entry.text);
  if (!entries.length) return null;
  return {
    id: String(turn?.id ?? `turn-${timestamp}-${entries[0].text.slice(0, 40)}`),
    startedAt: isoTimestamp(turn?.startedAt ?? turn?.createdAt),
    completedAt: isoTimestamp(turn?.completedAt ?? turn?.updatedAt),
    timestamp: new Date(timestamp).toISOString(),
    timestampMs: timestamp,
    entries,
  };
}

function extractHistoryTurnEntries(turn) {
  const entries = [];
  for (const item of turn?.items ?? []) {
    if (item?.type === "userMessage") {
      const content = Array.isArray(item.content) ? item.content : [];
      const text = content
        .map((part) => typeof part === "string"
          ? part
          : part?.text ?? part?.inputText ?? part?.value ?? "")
        .filter(Boolean)
        .join("\n") || String(item.text ?? "");
      if (text) entries.push({ role: "user", text });
    }
  }
  const assistantText = finalResponseFromAgentMessages(
    (turn?.items ?? [])
      .filter((item) => item?.type === "agentMessage")
      .map((item) => ({ ...item, completed: true })),
  );
  if (assistantText) entries.push({ role: "assistant", text: assistantText });
  return entries;
}

function sanitizeHistoryText(value, role) {
  let text = String(value ?? "").trim();
  if (role === "assistant" && text.startsWith("{")) {
    text = parseWorkspaceTurnResponse(text).text;
  }
  if (role === "user" || /用户当前任务：/.test(text)) {
    const taskMarker = text.lastIndexOf("用户当前任务：");
    if (taskMarker >= 0) text = text.slice(taskMarker + "用户当前任务：".length).trim();
  }
  return text;
}

function historyTurnTimestampMs(turn) {
  return timestampMs(
    turn?.completedAt
    ?? turn?.startedAt
    ?? turn?.updatedAt
    ?? turn?.createdAt
    ?? turn?.timestamp,
  );
}

function historyRecordFromTurns(base, turns, { archived = false, archivedAt = null, coverage = base?.coverage ?? null } = {}) {
  const orderedTurns = [...turns]
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .slice(-MAX_HISTORY_TURNS_PER_THREAD);
  const recencyMs = Math.max(
    Number(base?.recencyMs ?? 0),
    ...orderedTurns.map((turn) => turn.timestampMs),
  );
  const latestEntry = orderedTurns.at(-1)?.entries?.at(-1)?.text ?? base?.preview ?? "";
  return {
    id: String(base?.id ?? ""),
    name: String(base?.name ?? HISTORY_THREAD_NAME),
    preview: String(latestEntry).replace(/\s+/g, " ").slice(0, 500),
    createdAt: base?.createdAt ?? null,
    updatedAt: isoTimestamp(base?.updatedAt) ?? isoTimestamp(recencyMs),
    recencyAt: isoTimestamp(recencyMs),
    recencyMs,
    current: Boolean(base?.current),
    archived: Boolean(archived),
    archivedAt: isoTimestamp(archivedAt),
    coverage: {
      schemaVersion: 1,
      paginationComplete: coverage?.schemaVersion === 1
        && (coverage.paginationComplete ?? coverage.rangeComplete) === true
        && turns.length <= MAX_HISTORY_TURNS_PER_THREAD,
      rangeComplete: coverage?.schemaVersion === 1 && coverage.rangeComplete === true
        && turns.length <= MAX_HISTORY_TURNS_PER_THREAD && !(coverage.undatedTurnCount > 0),
      itemsView: ["full", "summary"].includes(coverage?.itemsView) ? coverage.itemsView : "unknown",
      undatedTurnCount: Math.max(0, Math.floor(Number(coverage?.undatedTurnCount) || 0)),
    },
    turns: orderedTurns,
  };
}

function historyRecordFromTurnsPage(threadId, metadata, page, cutoffMs, currentThreadId) {
  const rawTurns = Array.isArray(page?.data) ? page.data : [];
  const undatedTurnCount = rawTurns.filter(turn => historyTurnTimestampMs(turn) <= 0).length;
  const paginationComplete = !page?.nextCursor
    || rawTurns.some(turn => historyTurnTimestampMs(turn) > 0 && historyTurnTimestampMs(turn) < cutoffMs);
  const turns = rawTurns
    .map((turn) => normalizeHistoryTurn(turn, cutoffMs))
    .filter(Boolean);
  const base = normalizeHistoryThread({ ...metadata, id: threadId }, currentThreadId);
  return historyRecordFromTurns(base, turns, {
    archived: Boolean(metadata?.archived),
    archivedAt: metadata?.archivedAt ?? null,
    coverage: { schemaVersion: 1, paginationComplete,
      rangeComplete: paginationComplete && undatedTurnCount === 0, itemsView: "summary", undatedTurnCount },
  });
}

function mergeHistoryMetadata(record, metadata) {
  if (!record) return historyRecordFromTurns(metadata, [], { archived: false });
  return {
    ...record,
    name: metadata.name || record.name,
    preview: metadata.preview || record.preview,
    createdAt: metadata.createdAt ?? record.createdAt,
    updatedAt: metadata.updatedAt ?? record.updatedAt,
    recencyAt: metadata.recencyAt ?? record.recencyAt,
    recencyMs: Math.max(record.recencyMs, metadata.recencyMs),
    current: metadata.current,
    archived: false,
    archivedAt: null,
  };
}

function mergeHistoryRecords(previous, candidate) {
  if (!previous) return candidate;
  const turns = new Map(previous.turns.map((turn) => [turn.id, turn]));
  const persistedUserTimes = new Map();
  for (const turn of candidate.turns) {
    for (const entry of turn.entries.filter((item) => item.role === "user")) {
      const text = String(entry.text ?? "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      persistedUserTimes.set(text, Math.max(
        persistedUserTimes.get(text) ?? 0,
        Number(turn.timestampMs ?? 0),
      ));
    }
  }
  for (const [turnId, turn] of turns) {
    if (!String(turnId).startsWith("pending-user-")) continue;
    const pendingText = String(
      turn.entries.find((entry) => entry.role === "user")?.text ?? "",
    ).replace(/\s+/g, " ").trim();
    const persistedAt = persistedUserTimes.get(pendingText) ?? 0;
    if (persistedAt >= Number(turn.timestampMs ?? 0) - 60_000) {
      turns.delete(turnId);
    }
  }
  for (const turn of candidate.turns) turns.set(turn.id, turn);
  return historyRecordFromTurns({
    ...previous,
    ...candidate,
    recencyMs: Math.max(previous.recencyMs, candidate.recencyMs),
  }, [...turns.values()], {
    archived: candidate.archived ?? previous.archived,
    archivedAt: candidate.archivedAt ?? previous.archivedAt,
  });
}

function pruneHistoryRecord(record, cutoffMs) {
  const turns = (record?.turns ?? [])
    .map((turn) => normalizeHistoryTurn(turn, cutoffMs))
    .filter(Boolean);
  return historyRecordFromTurns(record, turns, {
    archived: Boolean(record?.archived),
    archivedAt: record?.archivedAt,
  });
}

function pruneRecentHistoryIndex(index, cutoffMs) {
  return {
    version: 1,
    updatedAt: index.updatedAt,
    threads: capHistoryIndexRecords(
      index.threads
        .map((record) => pruneHistoryRecord(record, cutoffMs))
        .filter((record) => record.turns.length > 0),
      cutoffMs,
    ),
  };
}

function capHistoryIndexRecords(records, cutoffMs) {
  let remaining = MAX_HISTORY_INDEX_TEXT_BYTES;
  const capped = [];
  for (const record of [...records]
    .map((item) => pruneHistoryRecord(item, cutoffMs))
    .filter((item) => item.turns.length > 0)
    .sort((left, right) => right.recencyMs - left.recencyMs)
    .slice(0, MAX_HISTORY_THREADS)) {
    const turns = [];
    for (const turn of [...record.turns].reverse()) {
      if (remaining <= 0) break;
      const entries = [];
      for (const entry of [...turn.entries].reverse()) {
        if (remaining <= 0) break;
        const text = entry.text.slice(-remaining);
        remaining -= text.length;
        if (text) entries.push({ ...entry, text, textComplete: entry.textComplete !== false && text.length === entry.text.length });
      }
      if (entries.length) turns.push({ ...turn, entries: entries.reverse() });
    }
    if (turns.length) capped.push({ ...record, turns: turns.reverse(), coverage: {
      ...record.coverage,
      paginationComplete: record.coverage?.paginationComplete === true && turns.length === record.turns.length
        && turns.every(turn => turn.entries.length === record.turns.find(item => item.id === turn.id)?.entries.length),
      rangeComplete: record.coverage?.rangeComplete === true && turns.length === record.turns.length
        && turns.every(turn => turn.entries.length === record.turns.find(item => item.id === turn.id)?.entries.length),
    } });
    if (remaining <= 0) break;
  }
  return capped;
}

function historyRecordText(record) {
  return [
    record.name,
    record.preview,
    ...record.turns.flatMap((turn) => turn.entries.map((entry) => entry.text)),
  ].join("\n").toLowerCase();
}

function historyRecordNeedsHydration(record, metadata, requireFull = false) {
  const turns = Array.isArray(record?.turns) ? record.turns : [];
  if (!turns.length) return true;
  if ((record?.coverage?.paginationComplete ?? record?.coverage?.rangeComplete) !== true
      || (requireFull && historyRecordIsPartial(record, true))) return true;
  const newestIndexedTurn = Math.max(0, ...turns.map((turn) => Number(turn?.timestampMs ?? 0)));
  return Number(metadata?.recencyMs ?? 0) > newestIndexedTurn + 1_000;
}

function historyRecordIsPartial(record, requireFull = false) {
  return record?.coverage?.rangeComplete !== true
    || (requireFull && record?.coverage?.itemsView !== "full")
    || record?.coverage?.undatedTurnCount > 0
    || (record?.turns ?? []).some(turn => (turn.entries ?? []).some(entry => entry.textComplete === false));
}

function historyRecordResponse(record, { includeTurns, maxBytes, query = "" }) {
  const response = {
    id: record.id,
    name: record.name,
    preview: record.preview,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    recencyAt: record.recencyAt,
    current: record.current,
    archived: record.archived,
    archivedAt: record.archivedAt,
    partial: historyRecordIsPartial(record, Boolean(query)),
    transcriptView: record?.coverage?.itemsView ?? "unknown",
  };
  if (includeTurns) {
    response.transcript = extractThreadTranscript(record.turns, { maxBytes, query });
    const sourceEntries = record.turns.flatMap(turn => turn.entries)
      .filter(entry => !query || entry.text.toLowerCase().includes(query));
    response.transcriptPartial = response.partial
      || sourceEntries.length !== response.transcript.length
      || sourceEntries.reduce((sum, entry) => sum + entry.text.length, 0)
        !== response.transcript.reduce((sum, entry) => sum + entry.text.length, 0);
  }
  return response;
}

function normalizeDynamicToolArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeInventoryResources(value) {
  const supported = new Set(["skills", "mcp", "apps"]);
  const source = Array.isArray(value) ? value : [value];
  return [...new Set(source.map((item) => String(item ?? "").trim()).filter((item) => supported.has(item)))];
}

function grantedPermissionSubset(value) {
  const requested = value && typeof value === "object" ? value : {};
  return {
    ...(requested.network && typeof requested.network === "object"
      ? { network: structuredClone(requested.network) }
      : {}),
    ...(requested.fileSystem && typeof requested.fileSystem === "object"
      ? { fileSystem: structuredClone(requested.fileSystem) }
      : {}),
  };
}

function isReconcileTransportFailure(error) {
  const kind = String(error?.kind ?? "").toLowerCase();
  if (["timeout", "runtime", "rpc", "transport"].includes(kind)) return true;
  return /timeout|timed out|socket|stream|connection|transport|stdin|stdout|app server.*(?:exit|closed|unavailable)/i
    .test(String(error?.message ?? error ?? ""));
}

function incompleteTurnError(runtime, deliveryStatus, partialText, message) {
  const error = new CodexWorkspaceError(deliveryStatus, message);
  Object.assign(error, {
    deliveryStatus,
    partial: true,
    complete: false,
    partialText: String(partialText ?? ""),
    threadId: runtime.threadId,
    turnId: runtime.turnId,
    operationId: runtime.operationId,
  });
  return error;
}

function compactSkillVersion(value) {
  return {
    name: value.name, contentHash: value.contentHash ?? null,
    entrypointHash: value.entrypointHash ?? null, status: value.status,
    reason: value.reason ?? null,
  };
}

export function compareSkillVersions(before, after) {
  const finalByName = new Map(after.map((item) => [item.name, item]));
  const changed = before.filter((item) => {
    const next = finalByName.get(item.name);
    return !next || item.contentHash !== next.contentHash || item.entrypointHash !== next.entrypointHash;
  }).map((item) => item.name);
  const complete = [...before, ...after].every((item) => item.status === "verified" && item.contentHash);
  return {
    status: changed.length ? "changed_during_run" : complete ? "verified" : "unverified",
    changedSkills: changed,
    boundary: "local_skill_directory_before_and_after_turn_external_dependencies_not_attested",
  };
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const result = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return result;
}

async function withOverallDeadline(promise, deadlineAt, label) {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new CodexWorkspaceError("timeout", `${label}超过整体时间预算。`);
  }
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(
          new CodexWorkspaceError("timeout", `${label}超过整体时间预算。`),
        ), remainingMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeHistoryThread(thread, currentThreadId) {
  const recency = thread?.recencyAt ?? thread?.updatedAt ?? thread?.createdAt;
  return {
    id: String(thread?.id ?? ""),
    name: String(thread?.name ?? HISTORY_THREAD_NAME),
    preview: String(thread?.preview ?? "").slice(0, 500),
    createdAt: isoTimestamp(thread?.createdAt),
    updatedAt: isoTimestamp(thread?.updatedAt ?? thread?.createdAt),
    recencyAt: isoTimestamp(recency),
    recencyMs: timestampMs(recency),
    current: thread?.id != null && String(thread.id) === String(currentThreadId ?? ""),
  };
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1_000 : value;
  }
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoTimestamp(value) {
  const milliseconds = timestampMs(value);
  return milliseconds > 0 ? new Date(milliseconds).toISOString() : null;
}

function isOlderThanRetention(value) {
  const milliseconds = timestampMs(value);
  return milliseconds > 0 && milliseconds < Date.now() - HISTORY_RETENTION_MS;
}

function clampInteger(value, minimum, maximum) {
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric)) return minimum;
  return Math.min(Math.max(numeric, minimum), maximum);
}

function assembleTurnFinalResponse(runtime, completedItems = []) {
  const orderedIds = [];
  const messages = new Map();
  for (const itemId of runtime?.agentMessageOrder ?? []) {
    const message = runtime.agentMessages.get(itemId);
    if (!message) continue;
    orderedIds.push(itemId);
    messages.set(itemId, { ...message });
  }
  for (const item of completedItems ?? []) {
    if (item?.type !== "agentMessage") continue;
    const itemId = String(item.id ?? `persisted-agent-message-${orderedIds.length + 1}`);
    if (!messages.has(itemId)) orderedIds.push(itemId);
    messages.set(itemId, {
      id: itemId,
      phase: item.phase ?? messages.get(itemId)?.phase ?? null,
      text: String(item.text ?? messages.get(itemId)?.text ?? ""),
      completed: true,
    });
  }
  return finalResponseFromAgentMessages(orderedIds.map((itemId) => messages.get(itemId)));
}

function aggregateFinalMessageText(messages) {
  const texts = (messages ?? [])
    .filter((item) => item?.phase === "final_answer")
    .map((item) => String(item.text ?? "").trim())
    .filter(Boolean);
  return mergeCompletedMessageTexts(texts);
}

function finalResponseFromAgentMessages(messages) {
  const explicitFinals = (messages ?? [])
    .filter((item) => item?.phase === "final_answer")
    .map((item) => String(item.text ?? "").trim())
    .filter(Boolean);
  if (explicitFinals.length) {
    const merged = mergeCompletedMessageTexts(explicitFinals);
    if (isStructuredWorkspaceResponse(merged)) return merged;
    const structured = [...explicitFinals].reverse().find(isStructuredWorkspaceResponse);
    return structured ?? merged;
  }
  // Older App Server versions did not always attach a phase. Keep only the
  // last completed non-commentary message as a compatibility fallback; never
  // promote explicit commentary into the final response.
  const unphased = (messages ?? [])
    .filter((item) => item?.phase !== "commentary" && String(item?.text ?? "").trim());
  const completed = [...unphased].reverse().find((item) => item.completed);
  return String(completed?.text ?? unphased.at(-1)?.text ?? "").trim();
}

function mergeCompletedMessageTexts(values) {
  const parts = [];
  for (const value of values ?? []) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    const previous = parts.at(-1);
    if (!previous) {
      parts.push(text);
    } else if (text === previous || previous.startsWith(text)) {
      continue;
    } else if (text.startsWith(previous)) {
      parts[parts.length - 1] = text;
    } else {
      parts.push(text);
    }
  }
  return parts.join("\n\n");
}

function isStructuredWorkspaceResponse(value) {
  const raw = String(value ?? "").trim();
  if (!raw.startsWith("{") || !raw.endsWith("}")) return false;
  try {
    const parsed = JSON.parse(raw);
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && typeof parsed.analysisMarkdown === "string" && parsed.analysisMarkdown.trim());
  } catch {
    return false;
  }
}

function notificationTurnId(message) {
  const value = message?.params?.turnId ?? message?.params?.turn?.id;
  return value == null ? null : String(value);
}

function turnUserMessageText(turn) {
  const userItem = (turn?.items ?? []).find((item) => item?.type === "userMessage");
  if (!userItem) return "";
  const content = Array.isArray(userItem.content) ? userItem.content : [];
  return content.map((part) => typeof part === "string"
    ? part
    : part?.text ?? part?.inputText ?? part?.value ?? "")
    .filter(Boolean)
    .join("\n") || String(userItem.text ?? "");
}

function turnUserMessageClientId(turn) {
  const userItem = (turn?.items ?? []).find((item) => item?.type === "userMessage");
  return String(userItem?.clientId ?? "").trim();
}

function normalizeComparableText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function analysisHeadline(value) {
  const first = String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").replace(/^[-*]\s*/, "").trim())
    .find(Boolean);
  return (first || "Codex 已完成项目分析").slice(0, 120);
}

async function ensureWorkspaceGuide(workspaceDirectory) {
  const target = path.join(workspaceDirectory, "AGENTS.md");
  const content = `# Trading Agent Workspace\n\n- This is the persistent Codex project for the Trading Cockpit desktop app.\n- Codex App Server is the only conversational and tool harness; Longbridge, FX, market-data indicators, and portfolio risk are read-only evidence capabilities.\n- Use configured Skills, MCP servers, Apps, web access, files, and tools whenever they improve the analysis.\n- Treat each <cockpit-evidence> block as a timestamped portfolio snapshot; identify stale or conflicting external data explicitly.\n- For a candidate, Codex decides Stage, invalidation, proposed sizing, and a cash_only / margin_within_cap / disabled leverage posture. Use an open evidence stack: price/volume, trend and momentum, relative strength, sector/peers, cost or chip distribution, AVWAP, volatility/options, and post-catalyst reaction may all matter. EMA and Fib are optional baseline evidence, not mandatory sections or default rules. The host has no fixed 2%/4% recommendation and enforces validated buying power and hard account/risk limits. margin_within_cap must be explicit; portfolio gross exposure warns at 120% and may never exceed 150%.\n- If Fib is used, overrides must reference supplied closed-bar barId and high/low fields. Local AUTO Fib is advisory unless Codex explicitly selects it.\n- If the portfolio snapshot is cached, stale, or older than two minutes at final sizing, keep the narrative but do not return an executable size.\n- For prior cockpit discussion, call query_recent_history. It returns at most the most recent 30 days; do not surface archived older cockpit conversations.\n- Never invent holdings, prices, FX rates, OHLCV bars, indicator levels, or portfolio weights.\n- The current <cockpit-evidence> already contains the authoritative Longbridge portfolio snapshot and local market/risk calculations. Do not query Longbridge again for data already present there.\n- Treat a Longbridge/MCP timeout as missing evidence and continue to a final answer. Do not retry the same failed query or batch multiple Longbridge calls into one aggregate wrapper.\n- The desktop Longbridge bridge is read-only. Discuss trade plans, but do not submit, modify, or cancel brokerage orders.\n- The desktop host disables recognized Longbridge brokerage-write tools in the App Server thread config. Do not seek alternative order-writing tools or attempt to bypass that boundary.\n- Prefer concise Chinese unless the user requests another language.\n`;
  try {
    await writeFile(target, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function estimateTurnInputTokens({ contextDiagnostics, task, skillCount = 0 } = {}) {
  const contextBytes = Number(contextDiagnostics?.totalUtf8Bytes) || 0;
  const taskBytes = Buffer.byteLength(String(task ?? ""), "utf8");
  // This is deliberately an upper-bound planning estimate, not reported token
  // usage. Skills are references at the protocol layer but their instructions
  // still consume model context after App Server expands them.
  return Math.ceil((contextBytes + taskBytes) / 3)
    + Math.max(0, Number(skillCount) || 0) * 8_000;
}

function finiteOrNull(value) {
  if (value == null || typeof value === "boolean") return null;
  if (typeof value === "string" && !value.trim()) return null;
  if (!["number", "string"].includes(typeof value)) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function boundedPercentOrNull(value) {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= 100
    ? value
    : null;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason instanceof Error
    ? signal.reason
    : new Error("Codex 分析已取消。");
  throw reason;
}

async function awaitWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    // The argument may already have started a shared operation before this
    // helper runs. Observe its eventual rejection before abandoning this
    // waiter, without replacing the original promise or its failure value.
    Promise.resolve(promise).catch(() => {});
    throwIfAborted(signal);
  }
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => {
      try { throwIfAborted(signal); }
      catch (error) { reject(error); }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

function notify(callback, value) {
  try {
    callback(value);
  } catch {
    // UI progress must never affect Codex execution.
  }
}

function cleanError(error) {
  return String(error instanceof Error ? error.message : error ?? "未知错误")
    .replace(/((?:bearer|token|secret|api[_ -]?key)\s*[:=])\s*[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}
