import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const THREAD_STORE_KEY = "codexWorkspaceThread";
const THREAD_REGISTRY_STORE_KEY = "codexWorkspaceThreadRegistry";
const HISTORY_INDEX_STORE_KEY = "codexWorkspaceRecentHistoryIndex";
const RPC_STARTUP_TIMEOUT_MS = 20_000;
const RPC_REQUEST_TIMEOUT_MS = 30_000;
const TURN_RECONCILE_INTERVAL_MS = 5_000;
const TURN_RECONCILE_REQUEST_TIMEOUT_MS = 5_000;
const TURN_FINAL_RECONCILE_DELAY_MS = 350;
const TURN_FINAL_STABLE_SETTLE_MS = 5_000;
const INVENTORY_TTL_MS = 10 * 60 * 1_000;
const INVENTORY_EVENT_COOLDOWN_MS = 30_000;
const INVENTORY_EVENT_DEBOUNCE_MS = 1_500;
const MAX_STDERR_BYTES = 32_000;
const MAX_STREAM_TEXT_BYTES = 2_000_000;
const HISTORY_RETENTION_DAYS = 30;
const HISTORY_RETENTION_MS = HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const HISTORY_THREAD_NAME = "交易驾驶舱 Agent";
const SESSION_NAME_MAX_LENGTH = 80;
const MAX_HISTORY_THREADS = 40;
const MAX_HISTORY_TEXT_BYTES = 60_000;
const MAX_HISTORY_INDEX_TEXT_BYTES = 500_000;
const MAX_HISTORY_TURNS_PER_THREAD = 240;
const MAX_HISTORY_ENTRY_BYTES = 12_000;
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
const BROKERAGE_WRITE_TOOLS = new Set([
  "submit_order",
  "replace_order",
  "cancel_order",
  "place_order",
  "send_order",
  "execute_order",
  "transmit_order",
  "modify_order",
  "amend_order",
  "update_order",
  "withdraw_order",
  "cancel_all_orders",
  "cancel_open_orders",
  "close_position",
  "close_all_positions",
  "liquidate_position",
  "exercise_option",
  "dca_create",
  "dca_pause",
  "dca_resume",
  "dca_update",
  "dca_modify",
  "dca_cancel",
  "dca_delete",
  "dca_enable",
  "dca_disable",
  "create_dca",
  "modify_dca",
  "update_dca",
  "cancel_dca",
  "delete_dca",
]);
const OFFICIAL_LONGBRIDGE_HOSTS = new Set([
  "mcp.longbridge.com",
  "mcp.longbridge.cn",
]);

export class CodexWorkspaceService {
  constructor({
    codexPath = null,
    workspaceDirectory,
    store,
    clientVersion = "0.0.0",
    rpcFactory = (options) => new CodexAppServerRpc(options),
    onStatus = () => {},
    onStream = () => {},
  }) {
    this.codexPath = codexPath;
    this.workspaceDirectory = workspaceDirectory;
    this.store = store;
    this.clientVersion = clientVersion;
    this.rpcFactory = rpcFactory;
    this.onStatus = onStatus;
    this.onStream = onStream;
    this.rpc = null;
    this.threadId = null;
    this.threadMetadata = null;
    this.skills = [];
    this.mcpServers = [];
    this.apps = [];
    // A single App Server/RPC connection owns every cockpit thread. Runtime
    // state is keyed by thread so independent conversations can run in
    // parallel without creating a second harness or tool inventory.
    this.activeTurns = new Map();
    this.pendingOperations = new Map();
    this.startPromise = null;
    this.inventoryPromise = null;
    this.inventoryUpdatedAt = 0;
    this.inventoryRefreshTimer = null;
    this.inventoryRefreshForceReload = false;
    this.guardPromise = null;
    this.skillsPromise = null;
    this.tokenUsageByThread = new Map();
    this.compactingThreads = new Set();
    this.initialTurnsPages = new Map();
    this.ownedThreadCache = new Map();
    this.historyMutationQueue = Promise.resolve();
    this.sessionTransitionActive = false;
    this.threadConfigOverride = {};
    this.readOnlyGuard = emptyReadOnlyGuard();
  }

  get available() {
    return Boolean(this.codexPath);
  }

  status() {
    const readOnlyGuardReady = this.readOnlyGuard.inventoryVerified
      && this.readOnlyGuard.residualTools.length === 0
      && this.readOnlyGuard.residualApps.length === 0;
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
      sandbox: "danger-full-access",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      historyRetentionDays: HISTORY_RETENTION_DAYS,
      skillCount: this.skills.length,
      mcpServerCount: this.mcpServers.length,
      appCount: this.apps.length,
      readOnlyGuardReady,
      brokerageWriteToolBlockCount: this.readOnlyGuard.blockedTools.length,
      brokerageWriteAppBlockCount: this.readOnlyGuard.blockedApps.length,
    };
  }

  async prepare() {
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
    await this.#ensureStarted();
    return this.status();
  }

  async #ensureStarted() {
    if (this.rpc?.ready && this.threadId) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async #start() {
    this.rpc?.dispose();
    this.rpc = this.rpcFactory({
      codexPath: this.codexPath,
      cwd: this.workspaceDirectory,
      clientVersion: this.clientVersion,
      onNotification: (message) => this.#handleNotification(message),
      onServerRequest: (message) => this.#handleServerRequest(message),
      onStderr: (message) => this.#handleStderr(message),
      onExit: (error) => this.#handleExit(error),
    });
    await this.rpc.start();
    await this.#prepareReadOnlyGuard();
    let saved = await this.store?.get?.(THREAD_STORE_KEY);
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
    if (saved?.threadId && saved.cwd === this.workspaceDirectory) {
      try {
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
          config: this.threadConfigOverride,
          dynamicTools: cockpitDynamicTools(),
        });
        if (String(resumed?.thread?.id ?? "") !== String(saved.threadId)) {
          throw new CodexWorkspaceError("protocol", "Codex 恢复了错误的持久线程。");
        }
        response = resumed;
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
      response = await this.rpc.request("thread/start", {
        cwd: this.workspaceDirectory,
        ephemeral: false,
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "danger-full-access",
        config: this.threadConfigOverride,
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
    this.threadMetadata = {
      threadId: this.threadId,
      cwd: response.cwd ?? this.workspaceDirectory,
      name: createdThreadName ?? saved?.name ?? HISTORY_THREAD_NAME,
      preview: String(saved?.preview ?? "").slice(0, 500),
      model: response.model ?? null,
      modelProvider: response.modelProvider ?? null,
      instructionSources: response.instructionSources ?? [],
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
      effectiveConfig = configResult?.config ?? {};
    } catch (error) {
      notify(this.onStatus, {
        phase: "codex_read_only_guard_warning",
        message: `Codex 配置预检未返回；将在工具清单阶段继续只读校验：${cleanError(error)}`,
      });
    }
    const guard = buildReadOnlyToolGuard({ effectiveConfig });
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
        message: "Codex 分析能力保持完整；破坏性 App 动作已关闭，已识别的长桥交易写工具已在线程配置层禁用",
      });
    }
  }

  async refreshInventory({ forceReload = false, threadId = this.threadId } = {}) {
    await this.#ensureStarted();
    if (this.inventoryPromise) return this.inventoryPromise;
    const inventoryFresh = this.readOnlyGuard.inventoryVerified
      && Date.now() - this.inventoryUpdatedAt < INVENTORY_TTL_MS;
    if (!forceReload && inventoryFresh) return this.capabilities();

    const inventoryPromise = this.#loadInventory({ forceReload, threadId })
      .finally(() => {
        if (this.inventoryPromise === inventoryPromise) this.inventoryPromise = null;
      });
    this.inventoryPromise = inventoryPromise;
    return inventoryPromise;
  }

  async #loadInventory({ forceReload, threadId }) {
    const previouslyVerified = this.readOnlyGuard.inventoryVerified;
    const skillRequest = this.rpc.request("skills/list", {
        cwds: [this.workspaceDirectory],
        forceReload,
      }).then((value) => {
        this.skills = (value?.data ?? [])
          .flatMap((entry) => entry.skills ?? [])
          .filter((skill) => skill.enabled !== false)
          .map(normalizeSkill)
          .filter(Boolean);
        return value;
      });
    const mcpRequest = this.rpc.request("mcpServerStatus/list", {
        threadId,
        detail: "toolsAndAuthOnly",
        limit: 100,
      }).then((value) => {
        this.mcpServers = (value?.data ?? []).map(normalizeMcpServer);
        this.readOnlyGuard.inventoryVerified = true;
        this.readOnlyGuard.residualTools = visibleBrokerageWriteTools(
          this.mcpServers,
          this.readOnlyGuard.guardedServerNames,
        );
        return value;
      }).catch((error) => {
        // A transient connector inventory failure must not invalidate a guard
        // that was already verified for this App Server configuration.
        if (!previouslyVerified) this.readOnlyGuard.inventoryVerified = false;
        throw error;
      });
    const appRequest = this.rpc.request("app/list", {
        threadId,
        cursor: null,
        limit: 100,
        forceRefetch: forceReload,
      }).then((value) => {
        this.apps = (value?.data ?? [])
        .filter((app) => app.isAccessible === true && app.isEnabled !== false)
        .map(normalizeApp)
        .filter(Boolean);
        // Apps SDK destructive tools are disabled for this entire cockpit
        // thread; research/query Apps do not gate starting a turn.
        this.readOnlyGuard.residualApps = [];
        return value;
      });
    const trackedGuard = mcpRequest.catch(() => null).finally(() => {
      if (this.guardPromise === trackedGuard) this.guardPromise = null;
    });
    const trackedSkills = skillRequest.catch(() => null).finally(() => {
      if (this.skillsPromise === trackedSkills) this.skillsPromise = null;
    });
    this.guardPromise = trackedGuard;
    this.skillsPromise = trackedSkills;
    await Promise.allSettled([skillRequest, mcpRequest, appRequest]);
    if (this.readOnlyGuard.inventoryVerified) this.inventoryUpdatedAt = Date.now();
    return this.capabilities();
  }

  #scheduleInventoryRefresh({ forceReload = false, threadId = this.threadId } = {}) {
    if (this.inventoryPromise) return;
    if (this.inventoryUpdatedAt
      && Date.now() - this.inventoryUpdatedAt < INVENTORY_EVENT_COOLDOWN_MS) return;
    this.inventoryRefreshForceReload ||= forceReload;
    if (this.inventoryRefreshTimer) return;
    this.inventoryRefreshTimer = setTimeout(() => {
      this.inventoryRefreshTimer = null;
      const reload = this.inventoryRefreshForceReload;
      this.inventoryRefreshForceReload = false;
      this.refreshInventory({ forceReload: reload, threadId }).catch((error) => notify(this.onStatus, {
        phase: "codex_inventory_warning",
        threadId,
        message: `Codex 能力变更稍后重试：${cleanError(error)}`,
      }));
    }, INVENTORY_EVENT_DEBOUNCE_MS);
    this.inventoryRefreshTimer.unref?.();
  }

  capabilities() {
    const guardedServerNames = new Set(this.readOnlyGuard.guardedServerNames);
    return {
      ...this.status(),
      threadShortId: this.threadId ? this.threadId.slice(0, 12) : null,
      skills: this.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        displayName: skill.displayName,
        scope: skill.scope,
      })),
      mcpServers: this.mcpServers.map((server) => ({
        name: server.name,
        authStatus: server.authStatus,
        tools: server.tools
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
      apps: this.apps.map((app) => ({
        id: app.id,
        name: app.name,
        description: app.description,
      })),
      readOnlyGuard: {
        ready: this.status().readOnlyGuardReady,
        scope: "Longbridge brokerage execution only",
        blockedTools: this.readOnlyGuard.blockedTools.map((tool) => ({
          server: tool.server,
          tool: tool.tool,
        })),
        blockedApps: this.readOnlyGuard.blockedApps.map((app) => ({
          id: app.id,
          name: app.name,
        })),
        residualTools: this.readOnlyGuard.residualTools,
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

  async createSession({ name = null } = {}) {
    // thread/start is already isolated by the App Server. Do not serialize it
    // behind an unrelated open/switch transition: different conversations can
    // be provisioned while other threads continue running.
    await this.#ensureStarted();
    const sessionName = normalizeSessionName(name) ?? defaultSessionName();
    const response = await this.rpc.request("thread/start", {
        cwd: this.workspaceDirectory,
        ephemeral: false,
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "danger-full-access",
        config: this.threadConfigOverride,
        serviceName: "trading_cockpit",
        dynamicTools: cockpitDynamicTools(),
      });
    const threadId = String(response?.thread?.id ?? "");
    if (!threadId) throw new CodexWorkspaceError("protocol", "Codex 没有返回新会话线程 ID。");
    if (response.thread?.ephemeral === true) {
      throw new CodexWorkspaceError("protocol", "Codex 返回了临时线程，已拒绝创建交易驾驶舱会话。");
    }
    await this.#activateThread(response, {
        expectedThreadId: threadId,
        name: sessionName,
        preview: "",
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
      if (targetThreadId === String(this.threadId ?? "")) {
        return activeSessionResponse(this.threadMetadata);
      }
      const registry = await this.#loadOwnedThreadRegistry();
      const owned = registry.threads.find((entry) => entry.threadId === targetThreadId);
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
      const response = await this.rpc.request("thread/resume", {
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
        config: this.threadConfigOverride,
        dynamicTools: cockpitDynamicTools(),
      });
      await this.#activateThread(response, {
        expectedThreadId: targetThreadId,
        name: owned.name ?? HISTORY_THREAD_NAME,
        preview: owned.preview ?? "",
        createdAt: owned.createdAt,
        updatedAt: owned.updatedAt,
      });
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
    createdAt = null,
    updatedAt = null,
    deferPersistence = false,
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
    await this.#archiveExpiredHistory();
    const cutoffMs = Date.now() - HISTORY_RETENTION_MS;
    const normalizedQuery = String(query ?? "").trim().toLowerCase();
    const [liveThreads, index] = await Promise.all([
      this.#listCockpitThreads(),
      this.#loadRecentHistoryIndex(),
    ]);
    const records = new Map(
      index.threads
        .map((thread) => pruneHistoryRecord(thread, cutoffMs))
        .filter((thread) => thread.turns.length > 0)
        .map((thread) => [thread.id, thread]),
    );

    // A text search or a tool read must inspect all owned live threads before
    // applying the result limit. Slicing metadata first silently missed hits.
    if (includeTurns || normalizedQuery) {
      const hydrated = await mapWithConcurrency(liveThreads, 4, async (thread) => {
        try {
          return await this.#readRecentThreadRecord(thread.id, thread, cutoffMs);
        } catch (error) {
          notify(this.onStatus, {
            phase: "codex_history_warning",
            message: `最近历史暂未读全：${cleanError(error)}`,
          });
          return null;
        }
      });
      const available = hydrated.filter(Boolean);
      for (const record of available) {
        records.set(record.id, mergeHistoryRecords(records.get(record.id), record));
      }
      if (available.length) await this.#mergeRecentHistoryRecords(available);
    } else {
      for (const thread of liveThreads) {
        const normalized = normalizeHistoryThread(thread, this.threadId);
        if (!normalized.id || normalized.recencyMs < cutoffMs) continue;
        const indexed = records.get(normalized.id);
        records.set(normalized.id, mergeHistoryMetadata(indexed, normalized));
      }
    }

    const matching = [...records.values()]
      .map((record) => pruneHistoryRecord(record, cutoffMs))
      .filter((record) => record.turns.length > 0 || record.recencyMs >= cutoffMs)
      .filter((record) => !normalizedQuery || historyRecordText(record).includes(normalizedQuery))
      .sort((left, right) => right.recencyMs - left.recencyMs);
    const selected = matching.slice(0, clampInteger(limit, 1, MAX_HISTORY_THREADS));
    const responseBudget = Math.floor(MAX_HISTORY_TEXT_BYTES / Math.max(1, selected.length));
    return {
      retentionDays: HISTORY_RETENTION_DAYS,
      threads: selected.map((record) => historyRecordResponse(record, {
        includeTurns,
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

  async #listCockpitThreads() {
    const registry = await this.#loadOwnedThreadRegistry();
    const ownedIds = new Set(registry.threads.map((thread) => thread.threadId));
    if (!ownedIds.size) return [];
    const threads = [];
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.rpc.request("thread/list", {
        cursor,
        limit: 100,
        sortKey: "recency_at",
        sortDirection: "desc",
        sourceKinds: ["appServer", "vscode", "cli", "exec", "unknown"],
        archived: false,
        cwd: [this.workspaceDirectory],
        useStateDbOnly: true,
      });
      const data = Array.isArray(result?.data) ? result.data : [];
      // Ownership is established only by the encrypted app registry. A user
      // thread with the same name or cwd must never be exposed to this app.
      threads.push(...data.filter((thread) => ownedIds.has(String(thread?.id ?? ""))));
      cursor = result?.nextCursor ?? null;
      if (!cursor) break;
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
    await this.#ownedThreadMetadata(callerThreadId).catch(() => {
      throw new CodexWorkspaceError("tool", "拒绝从非交易驾驶舱线程查询近期对话。");
    });
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
    } = {},
  ) {
    const turns = [];
    let cursor = null;
    for (let page = 0; page < 20 && turns.length < maxTurns; page += 1) {
      const result = await this.rpc.request("thread/turns/list", {
        threadId,
        cursor,
        limit: Math.min(pageSize, maxTurns - turns.length),
        sortDirection: "desc",
        itemsView,
      }, { timeoutMs });
      const data = Array.isArray(result?.data) ? result.data : [];
      let crossedCutoff = false;
      for (const turn of data) {
        const turnMs = historyTurnTimestampMs(turn);
        if (turnMs > 0 && turnMs < cutoffMs) {
          crossedCutoff = true;
          continue;
        }
        const normalized = normalizeHistoryTurn(turn, cutoffMs);
        if (normalized) turns.push(normalized);
      }
      cursor = result?.nextCursor ?? null;
      if (!cursor || crossedCutoff || data.length === 0) break;
    }
    const base = normalizeHistoryThread({ ...metadata, id: threadId }, this.threadId);
    return historyRecordFromTurns(base, turns, {
      archived: Boolean(metadata?.archived),
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

  #assertReadOnlyGuard() {
    if (!this.readOnlyGuard.inventoryVerified) {
      throw new CodexWorkspaceError(
        "read_only_guard",
        "Codex MCP 工具清单尚未完成只读校验；请刷新能力清单或重启交易驾驶舱后再试。",
      );
    }
    const residual = [
      ...this.readOnlyGuard.residualTools.map((item) => `${item.server}/${item.tool}`),
      ...this.readOnlyGuard.residualApps.map((item) => `App:${item.name}`),
    ];
    if (residual.length) {
      throw new CodexWorkspaceError(
        "read_only_guard",
        `检测到尚未被线程配置禁用的长桥交易写能力：${residual.slice(0, 6).join("、")}。本轮未启动；行情查询、Skills 与其他分析工具不受限制。`,
      );
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
    const analysisThreadId = String(threadId ?? this.threadId ?? "").trim();
    const analysisThreadMetadata = await this.#ownedThreadMetadata(analysisThreadId);
    if (this.activeTurns.has(analysisThreadId)) {
      throw new CodexWorkspaceError("busy", "该 Codex 对话已有一轮分析正在运行。");
    }
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
    if (!this.readOnlyGuard.inventoryVerified && this.guardPromise) {
      await this.guardPromise;
    }
    if (this.skillsPromise) await this.skillsPromise;
    if (!this.readOnlyGuard.inventoryVerified) {
      await this.refreshInventory({ threadId: analysisThreadId });
    }
    throwIfAborted(signal);
    this.#assertReadOnlyGuard();
    const startedAt = Date.now();
    const expandedTask = expandAgentCommand(task);
    const evidence = buildCodexEvidence({ portfolio, run, task: expandedTask });
    const prompt = buildWorkspacePrompt(evidence);
    const requestedSkills = analysisSkillsForScope(task, this.skills, evidence.analysisScope);
    const requestedApps = findRequestedApps(task, this.apps);
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
    const toolEvents = [];
    const runtime = {
      threadId: analysisThreadId,
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
      finalPreviewText: "",
      fullHistoryRecovered: false,
      ledgerRevision: 0,
      heartbeatTimer: null,
      reconcileTimer: null,
      reconcilePromise: null,
      finalReconcileTimer: null,
      stableFinalTimer: null,
    };
    this.activeTurns.set(analysisThreadId, runtime);
    this.clearPendingOperation({ threadId: analysisThreadId, operationId: normalizedOperationId });
    notify(this.onStatus, {
      phase: "codex_turn_start",
      threadId: analysisThreadId,
      operationId: runtime.operationId,
      message: "正在持久 Codex 项目线程中分析；Skills、MCP 与项目配置均已启用",
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
          : {}),
        additionalContext: {
          "trading-cockpit-instructions": {
            kind: "application",
            value: prompt,
          },
          "trading-cockpit-evidence": {
            kind: "application",
            value: JSON.stringify(evidence),
          },
        },
      });
      const startOutcome = await Promise.race([
        startRequest.then(
          (started) => ({ kind: "started", started }),
          (error) => ({ kind: "failed", error }),
        ),
        runtime.preStartCompletion.promise.then((turn) => ({ kind: "terminal", turn })),
        // A stable final answer can settle locally even when both the
        // turn/start response and turn/completed notification were lost.
        runtime.completion.promise.then((turn) => ({ kind: "terminal", turn })),
      ]);
      if (startOutcome.kind === "failed" && runtime.turnId !== "pending") {
        // A transport timeout can lose the turn/start response even though the
        // App Server already announced the concrete turn through item events.
        // Once that ID is adopted, persisted turn state is authoritative.
        completed = await runtime.completion.promise;
      } else if (startOutcome.kind === "failed") {
        throw startOutcome.error;
      } else if (startOutcome.kind === "terminal") {
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
      this.#stopTurnHeartbeat(runtime);
      this.#stopTurnReconciler(runtime);
      if (this.activeTurns.get(analysisThreadId) === runtime) {
        this.activeTurns.delete(analysisThreadId);
      }
    }
    if (completed.status !== "completed") {
      throw new CodexWorkspaceError(
        completed.status === "interrupted" ? "cancelled" : "runtime",
        completed.status === "interrupted"
          ? "Codex 分析已取消；持久线程与历史记录仍保留。"
          : cleanError(completed.error?.message ?? completed.error ?? "Codex turn failed."),
      );
    }
    this.#mergeRecoveredTurn(runtime, completed);
    if (!runtime.fullHistoryRecovered) {
      try {
        const persisted = await this.#readPersistedTurnItems(analysisThreadId, completed.id);
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
    const finalResponse = assembleTurnFinalResponse(runtime, completed.items);
    if (!finalResponse.trim()) {
      throw new CodexWorkspaceError("protocol", "Codex 没有返回最终分析文本。");
    }
    const parsedResponse = parseWorkspaceTurnResponse(finalResponse);
    const responseText = parsedResponse.text;
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
      requestedApps: requestedApps.map((app) => app.id),
      toolEvents,
      toolsUsed: toolEvents.length > 0,
      skillCount: this.skills.length,
      mcpServerCount: this.mcpServers.length,
      appCount: this.apps.length,
      tokenUsage: this.tokenUsageByThread.get(analysisThreadId) ?? null,
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
    await this.#ownedThreadMetadata(targetThreadId);
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
      items = await this.#readPersistedTurnItems(targetThreadId, turn.id)
        .then((persisted) => persisted.items)
        .catch(() => items);
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

  dispose() {
    if (this.inventoryRefreshTimer) clearTimeout(this.inventoryRefreshTimer);
    this.inventoryRefreshTimer = null;
    this.inventoryRefreshForceReload = false;
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
    this.pendingOperations.clear();
    this.rpc?.dispose();
    this.rpc = null;
  }

  #handleNotification(message) {
    const { method, params = {} } = message;
    if (method === "skills/changed") {
      this.#scheduleInventoryRefresh({ forceReload: true });
      return;
    }
    if (method === "app/list/updated") {
      this.#scheduleInventoryRefresh({ forceReload: false });
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
    const runtime = eventThreadId ? this.activeTurns.get(eventThreadId) : null;
    if (method === "thread/status/changed") {
      if (runtime && ["idle", "notLoaded", "systemError"].includes(params.status?.type)) {
        this.#scheduleTurnReconcile(runtime, 0);
      }
      return;
    }
    if (!runtime) return;
    if (eventTurnId && runtime.turnId === "pending") {
      // Item/turn notifications can beat or outlive the turn/start response.
      // Adopt their concrete ID immediately so the history reconciler can
      // recover a terminal turn even if the request response is lost.
      runtime.turnId = eventTurnId;
      this.#startTurnReconciler(runtime);
      if (method === "turn/completed" && params.turn) {
        runtime.preStartCompletion.resolve(params.turn);
      }
      for (const pending of runtime.pendingNotifications.splice(0)) {
        if (notificationTurnId(pending) === eventTurnId) this.#handleNotification(pending);
      }
    }
    if (eventTurnId && eventTurnId !== runtime.turnId) return;
    if (method === "item/agentMessage/delta") {
      const delta = String(params.delta ?? "");
      if (!delta) return;
      runtime.lastActivityAt = Date.now();
      runtime.ledgerRevision += 1;
      if (runtime.finalPreviewText) this.#scheduleStableFinalSettle(runtime);
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
      if (runtime.finalPreviewText) this.#scheduleStableFinalSettle(runtime);
      if (runtime.firstActivityAt == null) {
        runtime.firstActivityAt = Date.now();
      }
      if (item.type === "agentMessage" && method === "item/completed") {
        this.#recordCompletedAgentMessage(runtime, item, eventTurnId);
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

  #handleServerRequest(message) {
    const method = message.method;
    if (method === "item/tool/call") {
      const rpc = this.rpc;
      this.#executeDynamicTool(message.params)
        .then((result) => rpc?.respondResult(message.id, result))
        .catch((error) => rpc?.respondResult(message.id, {
            success: false,
            contentItems: [{ type: "inputText", text: cleanError(error) }],
          }));
      return;
    }
    if (method === "tool/requestUserInput" || method === "mcpServer/elicitation/request") {
      this.rpc.respondError(
        message.id,
        -32001,
        "交易驾驶舱当前尚未实现结构化确认表单；请在提示中改用无需确认的只读工具。",
      );
      notify(this.onStatus, {
        phase: "codex_input_required",
        message: "某个 MCP 工具需要结构化确认；本轮已拒绝该动作，其他分析能力不受影响",
      });
      return;
    }
    this.rpc.respondError(message.id, -32601, `Unsupported client request: ${method}`);
  }

  #handleStderr(message) {
    if (/stream disconnected|retrying sampling request/i.test(message)) {
      notify(this.onStatus, {
        phase: "codex_retry",
        message: "Codex 服务连接波动；持久线程会保留，当前轮可随时取消",
      });
    }
  }

  #handleExit(error) {
    if (this.inventoryRefreshTimer) clearTimeout(this.inventoryRefreshTimer);
    this.inventoryRefreshTimer = null;
    this.inventoryRefreshForceReload = false;
    this.inventoryPromise = null;
    for (const runtime of this.activeTurns.values()) {
      this.#stopTurnHeartbeat(runtime);
      this.#stopTurnReconciler(runtime);
      const runtimeError = new CodexWorkspaceError(
        "runtime",
        cleanError(error ?? "Codex App Server 已退出。"),
      );
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
    });
    notify(this.onStatus, {
      phase: "codex_final_received",
      threadId: runtime.threadId,
      operationId: runtime.operationId,
      message: "Codex 最终结论已收到，正在确认持久线程终态",
    });
    this.#scheduleTurnReconcile(runtime, TURN_FINAL_RECONCILE_DELAY_MS);
    this.#scheduleStableFinalSettle(runtime);
  }

  #scheduleStableFinalSettle(runtime) {
    if (runtime.stableFinalTimer) clearTimeout(runtime.stableFinalTimer);
    runtime.stableFinalTimer = setTimeout(async () => {
      runtime.stableFinalTimer = null;
      if (this.activeTurns.get(runtime.threadId) !== runtime
        || runtime.turnId === "pending"
        || !runtime.finalPreviewText.trim()) return;
      const quietForMs = Date.now() - Number(runtime.lastActivityAt ?? runtime.startedAt);
      if (quietForMs < TURN_FINAL_STABLE_SETTLE_MS) {
        this.#scheduleStableFinalSettle(runtime);
        return;
      }
      const revisionBeforeReconcile = runtime.ledgerRevision;
      if (await this.#reconcileTurn(runtime).catch(() => false)) return;
      if (this.activeTurns.get(runtime.threadId) !== runtime) return;
      const quietAfterReconcile = Date.now() - Number(runtime.lastActivityAt ?? runtime.startedAt);
      if (runtime.ledgerRevision !== revisionBeforeReconcile
        || quietAfterReconcile < TURN_FINAL_STABLE_SETTLE_MS) {
        this.#scheduleStableFinalSettle(runtime);
        return;
      }
      const finalItems = runtime.agentMessageOrder
        .map((itemId) => runtime.agentMessages.get(itemId))
        .filter((item) => item?.phase === "final_answer" && item.completed)
        .map((item) => ({
          id: item.id,
          type: "agentMessage",
          phase: "final_answer",
          text: item.text,
        }));
      if (!finalItems.length) return;
      notify(this.onStatus, {
        phase: "codex_final_locally_settled",
        threadId: runtime.threadId,
        operationId: runtime.operationId,
        message: "最终答案已稳定并从完整 item 序列交付；迟到终态将在后台清理",
      });
      const locallyCompletedTurn = {
        id: runtime.turnId,
        status: "completed",
        recoveredFromStableFinal: true,
        items: finalItems,
      };
      runtime.completion.resolve(locallyCompletedTurn);
      runtime.preStartCompletion.resolve(locallyCompletedTurn);
      // Only clean up after a full quiet window and a failed persisted-terminal
      // reconciliation. This cannot cut off an immediately following final
      // segment the way the former first-final timer could.
      this.rpc?.request?.("turn/interrupt", {
        threadId: runtime.threadId,
        turnId: runtime.turnId,
      }, { timeoutMs: TURN_RECONCILE_REQUEST_TIMEOUT_MS }).catch(() => {});
    }, TURN_FINAL_STABLE_SETTLE_MS);
    runtime.stableFinalTimer.unref?.();
  }

  #mergeRecoveredTurn(runtime, turn, { authoritativeItemOrder = false } = {}) {
    if (!turn || String(turn.id ?? "") !== String(runtime.turnId ?? "")) return;
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
      const turn = (response?.data ?? []).find((item) => String(item?.id ?? "") === turnId);
      if (!turn) return false;
      if (this.activeTurns.get(threadId) !== runtime || String(runtime.turnId) !== turnId) {
        return false;
      }
      this.#mergeRecoveredTurn(runtime, turn);
      if (!["completed", "interrupted", "failed"].includes(turn.status)) return false;

      let recoveredTurn = turn;
      try {
        const persisted = await this.#readPersistedTurnItems(threadId, turnId);
        if (persisted.items.length) {
          runtime.fullHistoryRecovered = persisted.complete;
          recoveredTurn = { ...turn, items: persisted.items };
          this.#mergeRecoveredTurn(runtime, recoveredTurn, { authoritativeItemOrder: true });
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
    const trackedReconciliation = reconciliation.finally(() => {
      if (runtime.reconcilePromise === trackedReconciliation) runtime.reconcilePromise = null;
    });
    runtime.reconcilePromise = trackedReconciliation;
    return runtime.reconcilePromise;
  }

  async #readPersistedTurnItems(threadId, turnId) {
    const items = [];
    let cursor = null;
    let paginationError = null;
    try {
      for (let page = 0; page < 20; page += 1) {
        const response = await this.rpc.request("thread/items/list", {
          threadId,
          turnId,
          cursor,
          limit: 200,
          sortDirection: "asc",
        }, { timeoutMs: TURN_RECONCILE_REQUEST_TIMEOUT_MS });
        const entries = Array.isArray(response?.data) ? response.data : [];
        for (const entry of entries) {
          if (String(entry?.turnId ?? turnId) !== String(turnId)) continue;
          if (entry?.item) items.push(entry.item);
        }
        cursor = response?.nextCursor ?? null;
        if (!cursor) {
          if (items.length) return { items, complete: true };
          break;
        }
        if (entries.length === 0) break;
      }
    } catch (error) {
      paginationError = error;
    }
    try {
      // Some active stores do not support item pagination. A full turn view is
      // also the fallback when paging stopped midway, so a prefix is never
      // mislabeled as the complete final answer.
      const response = await this.rpc.request("thread/turns/list", {
        threadId,
        limit: 12,
        sortDirection: "desc",
        itemsView: "full",
      }, { timeoutMs: TURN_RECONCILE_REQUEST_TIMEOUT_MS });
      const turn = (response?.data ?? []).find((entry) => String(entry?.id ?? "") === String(turnId));
      if (Array.isArray(turn?.items)) return { items: turn.items, complete: true };
    } catch (fullTurnError) {
      if (items.length) return { items, complete: false };
      throw paginationError ?? fullTurnError;
    }
    if (items.length) return { items, complete: false };
    if (paginationError) throw paginationError;
    return { items: [], complete: true };
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
    // armed stable settlement. Restart only periodic polling; do not cancel
    // the final reconciliation or stable-final timers.
    if (runtime.reconcileTimer) clearInterval(runtime.reconcileTimer);
    runtime.reconcileTimer = setInterval(() => {
      this.#reconcileTurn(runtime).catch(() => {});
    }, TURN_RECONCILE_INTERVAL_MS);
    runtime.reconcileTimer.unref?.();
  }

  #stopTurnReconciler(runtime) {
    if (runtime.reconcileTimer) clearInterval(runtime.reconcileTimer);
    if (runtime.finalReconcileTimer) clearTimeout(runtime.finalReconcileTimer);
    if (runtime.stableFinalTimer) clearTimeout(runtime.stableFinalTimer);
    runtime.reconcileTimer = null;
    runtime.finalReconcileTimer = null;
    runtime.stableFinalTimer = null;
  }

  #compactWhenNearlyFull(threadId, operationId = null) {
    const tokenUsage = this.tokenUsageByThread.get(threadId);
    if (this.compactingThreads.has(threadId) || !tokenUsage || !threadId) return;
    const windowSize = Number(tokenUsage.modelContextWindow);
    const activeTokens = Number(
      tokenUsage.last?.totalTokens
      ?? tokenUsage.last?.inputTokens,
    );
    if (!Number.isFinite(windowSize) || !Number.isFinite(activeTokens) || windowSize <= 0) return;
    if (activeTokens / windowSize < 0.98) return;
    this.compactingThreads.add(threadId);
    notify(this.onStatus, {
      phase: "codex_compacting",
      threadId,
      operationId,
      message: "Codex 项目线程剩余上下文低于 2%，正在自动压缩并保留关键历史",
    });
    this.rpc.request("thread/compact/start", { threadId })
      .catch((error) => notify(this.onStatus, {
        phase: "codex_warning",
        threadId,
        operationId,
        message: `Codex 自动压缩未完成：${cleanError(error)}`,
      }))
      .finally(() => {
        this.compactingThreads.delete(threadId);
      });
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
    const cached = this.ownedThreadCache.get(String(threadId));
    if (cached && !cached.archivedAt && cached.cwd === this.workspaceDirectory) {
      return { ...cached };
    }
    const registry = await this.#loadOwnedThreadRegistry();
    const owned = registry.threads.find((entry) => entry.threadId === threadId);
    if (!owned || owned.archivedAt || owned.cwd !== this.workspaceDirectory) {
      throw new CodexWorkspaceError("session", "该会话不属于交易驾驶舱，或已超过 30 天并归档。");
    }
    this.ownedThreadCache.set(String(threadId), owned);
    return owned;
  }
}

export class CodexAppServerRpc {
  constructor({
    codexPath,
    cwd,
    clientVersion,
    spawnImpl = spawn,
    onNotification = () => {},
    onServerRequest = () => {},
    onStderr = () => {},
    onExit = () => {},
  }) {
    this.codexPath = codexPath;
    this.cwd = cwd;
    this.clientVersion = clientVersion;
    this.spawnImpl = spawnImpl;
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
  }

  async start() {
    if (this.ready) return;
    this.process = this.spawnImpl(this.codexPath, ["app-server", "--stdio"], {
      cwd: this.cwd,
      env: { ...process.env },
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
    await this.request("initialize", {
      clientInfo: {
        name: "trading_cockpit",
        title: "交易驾驶舱",
        version: this.clientVersion,
      },
      capabilities: { experimentalApi: true },
    }, { timeoutMs: RPC_STARTUP_TIMEOUT_MS });
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
      this.pending.set(id, { resolve, reject, timeout });
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
  constructor(kind, message, options) {
    super(message, options);
    this.name = "CodexWorkspaceError";
    this.kind = kind;
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
    platform === "darwin" ? "/Applications/ChatGPT.app/Contents/Resources/codex" : null,
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
  const scope = ["position", "candidate", "portfolio"].includes(run?.context?.scope)
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
  return {
    userTask: String(task ?? run.task ?? "分析当前持仓").slice(0, 1_000),
    project: {
      mode: "persistent_codex_workspace",
      workspace: "trading-agent-workspace",
      portfolioBaseCurrency: portfolio.account?.baseCurrency ?? "USD",
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
      baseCurrency: portfolio.account?.baseCurrency ?? "USD",
      cashRatioPercent: finiteOrNull(portfolio.totals?.cashRatio),
      top1WeightPercent: finiteOrNull(portfolio.totals?.top1Weight),
      top5WeightPercent: finiteOrNull(portfolio.totals?.top5Weight),
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
    technical: scope === "portfolio" ? null : run.technical,
    locallyVerifiedConditionalPlan: run.plan,
    dataQuality: {
      portfolioStatus: portfolio.status,
      valuationComplete: portfolio.dataQuality?.valuationComplete !== false,
      fxStatus: portfolio.dataQuality?.fxStatus ?? "unknown",
      fxProvider: portfolio.fx?.provider ?? null,
      fxAsOf: portfolio.fx?.asOf ?? null,
      marketDataAsOf: run.context?.marketDataAsOf ?? null,
    },
    localEvidenceTrace: run.evidence,
  };
}

export function buildWorkspacePrompt(evidence) {
  const scopeInstruction = evidence.analysisScope === "candidate"
    ? "本轮是候选买入分析：目标可能完全未持有。使用适用的叙事/技术 Skills 与只读 MCP 核验主题、结构和市场证据，再结合 portfolioConstraints 给出 setup、触发、失效、建议初始新增、最大总/新增仓位与杠杆判断；不得把候选标的写成现有仓位，也不得突破本地确定性引擎给出的零仓位、现金或集中度上限。结构化 candidateSizing 中的 candidateGroupKey 必须是 portfolioConstraints.groupExposure 里已有的精确 key，无法可靠映射则填 null；仓位数字只能维持或收紧本地上限，绝不能放大。analysisMarkdown 保持适合深色界面的清晰 Markdown。"
    : evidence.analysisScope === "portfolio"
      ? "本轮是全组合分析：必须评价集中度、主题/币种重复暴露、现金、保证金、估值缺口和最大的组合级失败模式；不要逐只虚构技术结论。"
      : "本轮是已持仓分析：围绕选中真实仓位、技术结构以及它对组合的边际风险给出条件计划。";
  return [
    "你是交易驾驶舱中的 Codex Agent。当前窗口对应一个独立的持久 Codex thread；只延续该 thread 的对话上下文，不要自动混入其他会话。",
    "你可以自由使用本机 Codex 已配置的 Skills、MCP、Apps、网页、文件、Shell 和其他工具来补充或核验分析；不要把自己限制为下方 JSON 的摘要器。",
    `分析范围：${evidence.analysisScope}。${scopeInstruction}`,
    "本轮 additionalContext 中的 trading-cockpit-evidence 是驾驶舱本地引擎刚刚生成的范围化证据包。稳定规则来自项目与 Skills；当前数量、成本、权重、价格、汇率、EMA/Fib 与风险数值只以这份最新快照为准。若工具得到更新数据，请明确标注来源和时间差异。",
    "输出应直接回答用户任务，说明证据冲突、不确定性、风险影响与可执行的条件计划。不要伪造实时数据，也不要承诺收益。驾驶舱的长桥连接本身只读；如讨论订单，只能给出供用户手动确认的计划。",
    "如果 Longbridge 或其他 MCP 返回 463、超时、断线或单个工具失败，把它记录为证据降级；同一失败工具不要循环重试，不得因此延迟最终回答。使用已有持仓快照、其他只读来源或明确的不确定性继续完成本轮。",
    "如用户询问过去的讨论、上次判断或历史复盘，必须调用 query_recent_history；该工具只返回最近 30 天，禁止自行读取归档目录。",
    `用户当前任务：${evidence.userTask}`,
  ].join("\n\n");
}

function candidateWorkspaceOutputSchema() {
  const nullableNumber = {
    anyOf: [
      { type: "number", minimum: 0, maximum: 100 },
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
          "recommendedInitialAdditionalWeightPercent",
          "recommendedMaxTotalWeightPercent",
          "leverageDecision",
          "rationale",
        ],
        properties: {
          candidateGroupKey: { type: ["string", "null"] },
          classificationConfidence: {
            type: "string",
            enum: ["high", "medium", "low", "unknown"],
          },
          recommendedInitialAdditionalWeightPercent: nullableNumber,
          recommendedMaxTotalWeightPercent: nullableNumber,
          leverageDecision: {
            type: "string",
            enum: ["cash_only", "disabled"],
          },
          rationale: { type: "string" },
        },
      },
    },
  };
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
      };
    }
  } catch {
    // Older App Server/model combinations can ignore outputSchema. Keep the
    // human-readable answer and treat the structured recommendation as absent.
  }
  return { text: raw, candidateSizing: null };
}

function normalizeCandidateModelSizing(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const confidence = ["high", "medium", "low", "unknown"].includes(value.classificationConfidence)
    ? value.classificationConfidence
    : "unknown";
  const leverageDecision = value.leverageDecision === "cash_only" ? "cash_only" : "disabled";
  return {
    candidateGroupKey: value.candidateGroupKey == null
      ? null
      : String(value.candidateGroupKey).trim().slice(0, 120) || null,
    classificationConfidence: confidence,
    recommendedInitialAdditionalWeightPercent: boundedPercentOrNull(
      value.recommendedInitialAdditionalWeightPercent,
    ),
    recommendedMaxTotalWeightPercent: boundedPercentOrNull(
      value.recommendedMaxTotalWeightPercent,
    ),
    leverageDecision,
    rationale: String(value.rationale ?? "").trim().slice(0, 1_000),
  };
}

function codexPosition(item) {
  return {
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
  const adjustedRun = applyCandidateSizingReview(run, analysis.candidateSizing);
  const headline = analysisHeadline(analysis.text);
  return {
    ...adjustedRun,
    elapsedMs: Number(adjustedRun.elapsedMs ?? 0) + Number(analysis.elapsedMs ?? 0),
    conclusion: {
      headline,
      body: analysis.text,
      posture: "Codex 持久项目分析",
    },
    modelAnalysis: {
      provider: analysis.provider,
      persistent: true,
      ephemeral: false,
      threadId: analysis.threadId,
      workspaceDirectory: analysis.workspaceDirectory,
      requestedSkills: analysis.requestedSkills,
      requestedApps: analysis.requestedApps,
      toolEvents: analysis.toolEvents,
      toolsUsed: analysis.toolsUsed,
      skillCount: analysis.skillCount,
      mcpServerCount: analysis.mcpServerCount,
      appCount: analysis.appCount,
      tokenUsage: analysis.tokenUsage,
      firstActivityMs: analysis.firstActivityMs,
    },
    evidence: [
      ...adjustedRun.evidence,
      {
        source: "Codex 持久项目线程",
        tool: "codex:app-server",
        asOf: new Date().toISOString(),
        records: 1 + analysis.toolEvents.length,
        status: "succeeded",
        summary: `${analysis.requestedSkills.length} Skills · ${analysis.requestedApps.length} Apps 显式引用 · ${analysis.toolEvents.length} 工具事件 · 历史已保留`,
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
      mcp: true,
    },
  };
}

function applyCandidateSizingReview(run, review) {
  if (run?.context?.scope !== "candidate" || !review || !run?.risk) return run;
  const risk = run.risk;
  if (!risk.supported) {
    return {
      ...run,
      risk: {
        ...risk,
        sizingReview: {
          status: "unavailable",
          source: "Codex Skills/MCP",
          candidateGroupKey: null,
          requestedGroupKey: review.candidateGroupKey ?? null,
          classificationConfidence: review.classificationConfidence,
          rationale: risk.limitation || review.rationale,
          deterministicCeilingPreserved: true,
        },
      },
    };
  }
  const groupRows = Array.isArray(risk.portfolioConstraints?.groupExposure)
    ? risk.portfolioConstraints.groupExposure
    : [];
  const requestedGroup = String(review.candidateGroupKey ?? "").trim();
  const matchedGroup = requestedGroup
    ? groupRows.find((item) => String(item?.key ?? "").trim() === requestedGroup)
    : null;
  const confidenceAccepted = ["high", "medium"].includes(review.classificationConfidence);
  const localMaxTotal = finiteOrNull(risk.recommendedMaxWeightPercent);
  const existingWeight = Math.max(0, finiteOrNull(risk.existingPositionWeight) ?? 0);
  const modelMaxTotal = finiteOrNull(review.recommendedMaxTotalWeightPercent);
  const modelInitialAdditional = finiteOrNull(review.recommendedInitialAdditionalWeightPercent);
  const groupWeight = finiteOrNull(matchedGroup?.weight);
  const groupThreshold = finiteOrNull(risk.portfolioConstraints?.policyThresholds?.groupWarningPercent);
  const groupMaxTotal = groupWeight != null && groupThreshold != null
    ? existingWeight + Math.max(0, groupThreshold - groupWeight)
    : null;
  const ceilings = [localMaxTotal, modelMaxTotal, groupMaxTotal]
    .filter((value) => Number.isFinite(value));
  const reviewCanSize = risk.supported
    && risk.entryAllowed
    && review.leverageDecision !== "disabled"
    && ceilings.length > 0;
  const maxTotal = reviewCanSize
    ? Math.max(existingWeight, Math.min(...ceilings))
    : existingWeight;
  const maxAdditional = Math.max(0, maxTotal - existingWeight);
  const initialCeilings = [
    finiteOrNull(risk.recommendedInitialAdditionalWeightPercent),
    modelInitialAdditional,
    maxAdditional,
  ].filter((value) => Number.isFinite(value));
  const initialAdditional = reviewCanSize && initialCeilings.length
    ? Math.max(0, Math.min(...initialCeilings))
    : 0;
  const entryAllowed = reviewCanSize && maxAdditional > 0 && initialAdditional > 0;
  const netAssets = finiteOrNull(run.analysisContext?.portfolioSummary?.netAssets);
  const moveToReference = finiteOrNull(risk.moveToReferencePercent);
  const reviewed = Boolean(matchedGroup && confidenceAccepted
    && modelMaxTotal != null && modelInitialAdditional != null);
  const reviewStatus = reviewed ? "skill_mcp_reviewed" : "provisional";
  const reviewReason = review.rationale
    || (!matchedGroup && requestedGroup
      ? `Skill/MCP 返回的主题「${requestedGroup}」不在当前组合主题 key 中，未把它当成可验证分类。`
      : "Skill/MCP 尚未给出可验证的候选主题与仓位数字。");
  const entryBlockReasons = [...(risk.entryBlockReasons ?? [])];
  if (!entryAllowed && review.leverageDecision === "disabled" && reviewReason) {
    entryBlockReasons.push(reviewReason);
  }
  const nextRisk = {
    ...risk,
    entryAllowed,
    entryBlockReasons: [...new Set(entryBlockReasons)],
    group: matchedGroup?.key ?? risk.group,
    candidateGroupKnown: Boolean(matchedGroup),
    groupWeight: groupWeight == null ? risk.groupWeight : rounded(groupWeight),
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
    portfolioImpactAtReferencePercent: moveToReference == null
      ? risk.portfolioImpactAtReferencePercent
      : rounded(maxAdditional * moveToReference / 100),
    leverage: {
      ...risk.leverage,
      decision: entryAllowed ? "cash_only" : "disabled",
      additionalLeverageAllowed: false,
      maxAdditionalBorrowedWeightPercent: 0,
      modelReviewDecision: review.leverageDecision,
      disabledReasons: [...new Set([
        ...(risk.leverage?.disabledReasons ?? []),
        ...(!entryAllowed && reviewReason ? [reviewReason] : []),
      ])],
    },
    sizingReview: {
      status: reviewStatus,
      source: "Codex Skills/MCP",
      candidateGroupKey: matchedGroup?.key ?? null,
      requestedGroupKey: requestedGroup || null,
      classificationConfidence: review.classificationConfidence,
      rationale: reviewReason,
      deterministicCeilingPreserved: true,
    },
  };
  return {
    ...run,
    risk: nextRisk,
    plan: applyReviewedCandidateSizingToPlan(run.plan, nextRisk),
    evidence: [
      ...(run.evidence ?? []),
      {
        source: "Codex Skills/MCP 候选复核",
        tool: "codex:candidate-sizing-review",
        asOf: new Date().toISOString(),
        records: 1,
        status: reviewed ? "succeeded" : "degraded",
        summary: reviewed
          ? `主题 ${matchedGroup.key} 已映射；初始新增 ${rounded(initialAdditional)}%，最大总仓位 ${rounded(maxTotal)}%，且未突破本地上限`
          : `结构化仓位仍为 provisional；${reviewReason}`,
      },
    ],
  };
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
    leverageDecision: risk.leverage?.decision,
    maxAdditionalBorrowedWeightPercent: 0,
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
          if: risk.sizingReview?.rationale || "Skill/MCP 与组合约束未共同确认可用仓位",
          then: "建议初始新增仓位 0%；保留观察，待新快照与主题分类复核",
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
        then: `Skill/MCP 复核后：初始新增 ${rounded(risk.recommendedInitialAdditionalWeightPercent)}%，最大总仓位 ${rounded(risk.recommendedMaxWeightPercent)}%；仅允许现金覆盖，成交前用最新快照重算`,
        impact: `触及参考失效位时，静态组合影响不高于约 ${rounded(risk.portfolioImpactAtReferencePercent)}%`,
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

function analysisSkillsForScope(text, skills, scope) {
  const explicit = findRequestedSkills(text, skills);
  const automaticNames = scope === "portfolio"
    ? new Set(["analyze-market-narratives"])
    : new Set(["analyze-market-narratives", "analyze-technical-structure"]);
  const automatic = skills.filter((skill) => automaticNames.has(skill.name));
  return [...new Map([...explicit, ...automatic].map((skill) => [skill.name, skill])).values()];
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
    technical: "重点分析当前持仓的 EMA 3/5/8/13/21、EMA 144/169 与 Fibonacci 扩展结构。",
    risk: "重点检查当前持仓权重、组合集中度、主题重复暴露、汇率口径与风险预算。",
    plan: "基于当前证据生成牛、基准、熊三种条件计划，并列出触发、动作、失效和组合影响。",
    history: "调用 query_recent_history，只查询并总结最近 30 天的交易驾驶舱对话；不要读取归档目录。",
  };
  return `${commands[match[1].toLowerCase()]} ${text.slice(match[0].length)}`.trim();
}

export function agentCommands() {
  return [
    { name: "/full", description: "完整技术、风险与条件计划" },
    { name: "/technical", description: "聚焦 EMA 与 Fibonacci 结构" },
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
    inventoryVerified: false,
    residualTools: [],
    residualApps: [],
  };
}

export function buildReadOnlyToolGuard({ effectiveConfig = {} } = {}) {
  const config = {
    apps: {
      _default: { destructive_enabled: false },
    },
  };
  const blockedTools = [];
  const blockedApps = [{ id: "_default", name: "Destructive App actions" }];
  const guardedServerNames = new Set();
  const directServers = plainObject(effectiveConfig?.mcp_servers);
  for (const [serverId, serverConfigValue] of Object.entries(directServers)) {
    const serverConfig = plainObject(serverConfigValue);
    if (!isLongbridgeServerConfig(serverId, serverConfig)) continue;
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
      if (!isLongbridgeServerConfig(`${pluginId}/${serverId}`, serverConfig)) continue;
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

  const configuredApps = plainObject(effectiveConfig?.apps);
  for (const [appId, appConfigValue] of Object.entries(configuredApps)) {
    if (appId === "_default") continue;
    const appConfig = plainObject(appConfigValue);
    if (appConfig.destructive_enabled === true) {
      config.apps[appId] = { destructive_enabled: false };
      blockedApps.push({ id: appId, name: appId });
    }
  }

  return {
    config,
    blockedTools,
    blockedApps,
    guardedServerNames: [...guardedServerNames],
  };
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

function isLongbridgeServerConfig(serverId, serverConfig) {
  return isLongbridgeIdentifier(serverId)
    || isOfficialLongbridgeUrl(serverConfig?.url)
    || isOfficialLongbridgeUrl(serverConfig?.websiteUrl);
}

function addGuardedServerAliases(target, name) {
  const raw = String(name ?? "").trim();
  if (!raw) return;
  target.add(raw);
  target.add(canonicalIdentifier(raw));
}

function isBrokerageWriteToolName(name) {
  return BROKERAGE_WRITE_TOOLS.has(canonicalIdentifier(name));
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
  return isBrokerageWriteToolName(tool?.name)
    && (serverIsGuarded(server, guardedServerNames) || isLongbridgeInventoryServer(server));
}

function visibleBrokerageWriteTools(servers, guardedServerNames) {
  const guarded = new Set(guardedServerNames);
  const residual = [];
  for (const server of servers) {
    if (!isLongbridgeInventoryServer(server) || serverIsGuarded(server, guarded)) continue;
    for (const tool of server.tools) {
      if (isBrokerageWriteToolName(tool.name)) {
        residual.push({ server: server.name, tool: tool.name });
      }
    }
  }
  return residual;
}

function normalizeMcpServer(server) {
  return {
    name: String(server?.name ?? "unknown"),
    title: String(server?.serverInfo?.title ?? server?.name ?? "unknown"),
    websiteUrl: String(server?.serverInfo?.websiteUrl ?? ""),
    authStatus: String(server?.authStatus ?? "unknown"),
    tools: Object.values(server?.tools ?? {}).map((tool) => ({
      name: String(tool?.name ?? "unknown"),
      title: String(tool?.title ?? tool?.name ?? "unknown"),
      description: String(tool?.description ?? ""),
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
    const text = entry.text.slice(-remaining);
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
  };
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
  });
}

function normalizeHistoryTurn(turn, cutoffMs) {
  const timestamp = historyTurnTimestampMs(turn);
  // Unknown timestamps cannot be proven to fall inside the 30-day boundary.
  if (timestamp <= 0 || timestamp < cutoffMs) return null;
  const entries = (Array.isArray(turn?.entries) ? turn.entries : extractHistoryTurnEntries(turn))
    .map((entry) => ({
      role: entry?.role === "assistant" ? "assistant" : "user",
      text: sanitizeHistoryText(entry?.text, entry?.role),
    }))
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
  return text.slice(0, MAX_HISTORY_ENTRY_BYTES);
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

function historyRecordFromTurns(base, turns, { archived = false, archivedAt = null } = {}) {
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
    turns: orderedTurns,
  };
}

function historyRecordFromTurnsPage(threadId, metadata, page, cutoffMs, currentThreadId) {
  const turns = (Array.isArray(page?.data) ? page.data : [])
    .map((turn) => normalizeHistoryTurn(turn, cutoffMs))
    .filter(Boolean);
  const base = normalizeHistoryThread({ ...metadata, id: threadId }, currentThreadId);
  return historyRecordFromTurns(base, turns, {
    archived: Boolean(metadata?.archived),
    archivedAt: metadata?.archivedAt ?? null,
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
        if (text) entries.push({ role: entry.role, text });
      }
      if (entries.length) turns.push({ ...turn, entries: entries.reverse() });
    }
    if (turns.length) capped.push({ ...record, turns: turns.reverse() });
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

function historyRecordResponse(record, { includeTurns, maxBytes }) {
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
  };
  if (includeTurns) {
    response.transcript = extractThreadTranscript(record.turns, { maxBytes });
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
  const content = `# Trading Agent Workspace\n\n- This is the persistent Codex project for the Trading Cockpit desktop app.\n- Codex App Server is the only conversational and tool harness; Longbridge, FX, EMA/Fib, and portfolio risk are read-only evidence capabilities.\n- Use configured Skills, MCP servers, Apps, web access, files, and tools whenever they improve the analysis.\n- Treat each <cockpit-evidence> block as a timestamped portfolio snapshot; identify stale or conflicting external data explicitly.\n- For prior cockpit discussion, call query_recent_history. It returns at most the most recent 30 days; do not surface archived older cockpit conversations.\n- Never invent holdings, prices, FX rates, EMA/Fib levels, or portfolio weights.\n- The current <cockpit-evidence> already contains the authoritative Longbridge portfolio snapshot and local EMA/Fib/risk calculations. Do not query Longbridge again for data already present there.\n- Treat a Longbridge/MCP timeout as missing evidence and continue to a final answer. Do not retry the same failed query or batch multiple Longbridge calls into one aggregate wrapper.\n- The desktop Longbridge bridge is read-only. Discuss trade plans, but do not submit, modify, or cancel brokerage orders.\n- The desktop host disables recognized Longbridge brokerage-write tools in the App Server thread config. Do not seek alternative order-writing tools or attempt to bypass that boundary.\n- Prefer concise Chinese unless the user requests another language.\n`;
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

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function boundedPercentOrNull(value) {
  const numeric = finiteOrNull(value);
  return numeric == null ? null : Math.min(100, Math.max(0, numeric));
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason instanceof Error
    ? signal.reason
    : new Error("Codex 分析已取消。");
  throw reason;
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
