import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemHealthSnapshot } from "../src/runtime/system-health.mjs";
import { buildBrokerViews } from "../src/data/broker-portfolios.mjs";
import { assessPortfolioValuationGate } from "../src/data/portfolio-valuation-gate.mjs";

const NOW = "2026-09-17T20:30:00.000Z";
const files = ["secure-state.bin", "business-state.bin", "review-data.bin", "market-history.bin", "portfolio-snapshots.bin", "technical-radar.bin"];
const view = (snapshot, section, card) => snapshot.sections.find((item) => item.id === section).cards.find((item) => item.id === card);
const value = (card, label) => card.fields.find((item) => item.label === label)?.value;
const capability = (snapshot, broker, id) => snapshot.capabilities.find((item) => item.id === broker).items.find((item) => item.id === id);
const build = (input = {}) => buildSystemHealthSnapshot({ now: NOW, ...input });

function storageFixture() {
  return { state: "healthy", encrypted: true, stores: files.map((file) => ({ file, encrypted: true, state: "healthy", lastSavedAt: "2026-09-17T19:00:00Z", recoveryAvailable: false })) };
}
function portfolioFixture(extra = {}) {
  return { status: "live", holdingsStatus: "live", syncedAt: NOW, source: "Longbridge", positions: [],
    account: { netAssets: 1000, totalCash: 1000, baseCurrency: "USD", valuationComplete: true },
    totals: { positionCount: 0 }, dataQuality: { valuationComplete: true, fxStatus: "not_required", unpricedPositionCount: 0 },
    ...extra,
  };
}
function eodFixture() {
  return { status: "available", snapshotCount: 2, integrity: { valid: true, ledgerRecordCount: 2 },
    latest: { kind: "manual", capturedAt: "2026-09-17T20:20:00Z", valuationSession: "post_market" },
    coverageCalendar: [
      { tradingDate: "2026-09-10", status: "confirmed", confirmedSnapshotId: "stored-eod", snapshotReferenceVerified: true },
      { tradingDate: "2026-09-11", status: "degraded", confirmedSnapshotId: "partial" },
      { tradingDate: "2026-09-14", status: "gap" },
      { tradingDate: "2026-09-15", status: "pending" },
      { tradingDate: "2026-09-16", status: "attempting" },
      { tradingDate: "2026-09-17", status: "missing" },
    ],
    captureRuntime: { lastAttemptAt: "2026-09-17T20:20:00Z", lastSuccessAt: "2026-09-17T20:20:00Z" },
    capturePolicy: { automaticEod: true, requiresAppRunning: true, requiresLongbridgeConnection: true, checkIntervalMinutes: 15, eodSnapshotsPerTradingDate: 1, missedDayBackfill: false, extendedHoursHandling: "separate_observation_never_overwrite_eod" },
  };
}

test("an empty health input stays unknown and produces six independent unknown storage cards", () => {
  const result = build();
  assert.equal(result.status, "unknown");
  assert.equal(result.generatedAt, NOW);
  assert.equal(result.sections.find((item) => item.id === "storage").cards.length, 6);
  assert.ok(result.sections.every((item) => item.state === "unknown"));
  assert.equal(value(view(result, "capacity", "portfolio_snapshots"), "当前账户快照数"), null);
});

test("all six encrypted stores must be individually known; a healthy aggregate cannot hide an unread store", () => {
  const storage = storageFixture();
  storage.stores.pop();
  let result = build({ storage });
  assert.equal(view(result, "storage", "secure").state, "healthy");
  assert.equal(view(result, "storage", "technical_radar").state, "unknown");
  assert.equal(result.sections.find((item) => item.id === "storage").state, "unknown");
  storage.stores[1].state = "degraded";
  storage.stores[1].errorCode = "STORAGE_DECRYPT_FAILED";
  result = build({ storage });
  assert.equal(view(result, "storage", "business").state, "degraded");
  assert.equal(result.status, "degraded");
  storage.stores[0].encrypted = false;
  assert.equal(build({ storage }).status, "unavailable");
});

test("business indexes are independently checked even when all five older stores are healthy", () => {
  const storage = storageFixture();
  storage.stores = storage.stores.filter((item) => item.file !== "business-state.bin");
  let result = build({ storage });
  assert.equal(view(result, "storage", "business").state, "unknown");
  assert.equal(result.sections.find((item) => item.id === "storage").state, "unknown");
  storage.stores.push({ file: "business-state.bin", encrypted: true, state: "degraded", errorCode: "STORAGE_WRITE_FAILED" });
  result = build({ storage });
  assert.equal(view(result, "storage", "business").state, "degraded");
  assert.equal(result.status, "degraded");
  assert.match(result.sections.find((item) => item.id === "storage").summary, /六类.*应用索引与凭证分开/);
});

test("health consumes actual broker aggregation evidence and keeps mixed FX sources and conservative valuation labels", () => {
  const longbridge = portfolioFixture({ dataQuality: { valuationComplete: true, fxStatus: "reference_cached", unpricedPositionCount: 0 }, fx: { providerCode: "ECB", asOf: "2026-09-15T16:00:00Z", fetchedAt: "2026-09-16T12:00:00Z" } });
  const ibkr = portfolioFixture({ dataQuality: { valuationComplete: true, fxStatus: "live", unpricedPositionCount: 0 }, fx: { providerCode: "IBKR", asOf: NOW } });
  const views = buildBrokerViews({ longbridge, ibkr, ibkrEnabled: true, now: Date.parse(NOW) });
  const result = build({ brokers: { views } });
  const aggregate = view(result, "data", "all");
  assert.equal(aggregate.state, "degraded");
  assert.equal(value(aggregate, "汇率状态"), "参考汇率缓存");
  assert.equal(value(aggregate, "汇率参考时间"), "2026-09-15T16:00:00.000Z");
  assert.match(aggregate.details.join(" "), /长桥.*参考汇率缓存.*IBKR.*券商汇率/);
  assert.match(value(aggregate, "确定性计仓门禁"), /未接入/);
});

test("cached and old holdings never turn fresh because the page was opened or cached flags claimed sizing readiness", () => {
  const cached = portfolioFixture({ status: "cached", syncedAt: "2026-09-01T12:00:00Z", freshness: { freshForSizing: true, state: "fresh" } });
  const result = build({ brokers: { views: { longbridge: cached } }, longbridge: { connected: true } });
  assert.equal(view(result, "data", "longbridge").state, "degraded");
  assert.equal(value(view(result, "data", "longbridge"), "持仓观测时间"), "2026-09-01T12:00:00.000Z");
  assert.notEqual(capability(result, "longbridge", "sizing").state, "healthy");
});

test("connection truth is independent of cached holdings and optional IBKR configuration", () => {
  const result = build({ longbridge: { connected: false, orderWrite: false, tools: [] },
    brokers: { views: { longbridge: portfolioFixture() }, ibkr: { config: { enabled: false, transport: "tws" }, state: "disconnected", orderWrite: false } } });
  assert.equal(view(result, "data", "longbridge_connection").state, "unavailable");
  assert.equal(value(view(result, "data", "longbridge_connection"), "连接状态"), "未连接");
  assert.equal(value(view(result, "data", "longbridge_connection"), "交易写权限"), "关闭");
  assert.equal(view(result, "data", "ibkr_connection").state, "unknown");
  assert.equal(value(view(result, "data", "ibkr_connection"), "已启用接入"), "否");
});

test("only an actual validated Longbridge valuation gate can make the sizing capability ready", () => {
  const portfolio = portfolioFixture();
  portfolio.valuationGate = assessPortfolioValuationGate({ portfolio, assessedAt: NOW });
  const result = build({ brokers: { views: { longbridge: portfolio, ibkr: portfolio, all: portfolio } } });
  assert.equal(capability(result, "longbridge", "sizing").state, "healthy");
  for (const broker of ["ibkr", "all"]) {
    for (const feature of ["history", "eod", "sizing"]) assert.equal(capability(result, broker, feature).support, "not_supported");
    assert.equal(capability(result, broker, "order_write").support, "disabled");
    assert.equal(capability(result, broker, "options").support, "conditional");
  }
});

test("EOD persisted success, gaps, degraded evidence and todo states are separate and a post-market manual snapshot is not called EOD", () => {
  const result = build({ portfolioSnapshots: eodFixture() });
  assert.equal(value(view(result, "eod", "durable"), "已确认落盘日"), 1);
  assert.equal(value(view(result, "eod", "durable"), "最近快照类型"), "手动");
  assert.equal(value(view(result, "eod", "durable"), "最近估值时段"), "盘后");
  assert.equal(value(view(result, "eod", "gaps"), "已确认缺口"), 1);
  assert.equal(value(view(result, "eod", "gaps"), "降级证据日"), 1);
  for (const label of ["排队待办", "正在尝试", "尚无覆盖条目"]) assert.equal(value(view(result, "eod", "pending"), label), 1);
  assert.equal(view(result, "eod", "pending").state, "running");
  assert.match(view(result, "eod", "policy").details.join(""), /不覆盖/);
});

test("runtime success messages and missing snapshot references never become durable EOD success", () => {
  const input = eodFixture();
  input.status = "unavailable"; input.integrity = null;
  let result = build({ portfolioSnapshots: input });
  assert.equal(value(view(result, "eod", "durable"), "已确认落盘日"), null);
  assert.notEqual(view(result, "eod", "durable").state, "healthy");
  const broken = eodFixture(); delete broken.coverageCalendar[0].confirmedSnapshotId;
  result = build({ portfolioSnapshots: broken });
  assert.equal(value(view(result, "eod", "durable"), "已确认落盘日"), 0);
  assert.equal(value(view(result, "eod", "durable"), "确认引用待核验"), 1);
  assert.equal(view(result, "eod", "durable").state, "degraded");
  for (const verification of [false, null, undefined]) {
    const mismatched = eodFixture(); mismatched.coverageCalendar[0].snapshotReferenceVerified = verification;
    assert.equal(value(view(build({ portfolioSnapshots: mismatched }), "eod", "durable"), "已确认落盘日"), 0);
  }
});

test("Agent contract, result terminal and history completeness remain independent observations", () => {
  const input = { codex: { available: true, ready: true, activeCount: 0, readOnlyGuardReady: true, additionalContextContract: { status: "verified", serverUserAgent: "codex_cli_rs/0.118.0" } },
    lastAgentResult: { completedAt: NOW, run: { modelAnalysis: { additionalContextContract: { status: "verified" }, contextDiagnostics: { totalUtf8Bytes: 4096, totalBlockCount: 4, silentlyTruncated: false }, resultDelivery: { complete: true, terminalStatus: "completed", terminalSource: "persisted_turn_state", historyStatus: "streamed_unverified" } } } } };
  let result = build(input);
  assert.equal(view(result, "agent", "context").state, "healthy");
  assert.equal(view(result, "agent", "delivery").state, "degraded");
  assert.equal(value(view(result, "agent", "context"), "最近上下文字节"), 4096);
  assert.equal(value(view(result, "version", "version"), "已观测 Codex 版本"), "0.118.0");
  input.lastAgentResult.run.modelAnalysis.resultDelivery.historyStatus = "verified";
  result = build(input);
  assert.equal(view(result, "agent", "delivery").state, "healthy");
  input.lastAgentResult.run.modelAnalysis.contextDiagnostics.deliveryStatus = "rejected_budget";
  assert.equal(view(build(input), "agent", "context").state, "degraded");
});

test("a transport-ready Agent with an unverified guard is degraded with explicit repair advice", () => {
  const snapshot = build({ codex: { available: true, ready: true, readOnlyGuardReady: false,
    readOnlyGuardDiagnostic: { state: "blocked", title: "旧对话需重新加载只读配置", message: "请新建安全对话；原对话保留。",
      actionLabel: "新建安全对话", tools: [{ server: "broker_data", tool: "submit_order" }] } } });
  assert.equal(view(snapshot, "agent", "runtime").state, "degraded");
  const guard = view(snapshot, "agent", "read_only_guard");
  assert.equal(guard.state, "degraded");
  assert.match(guard.summary, /原对话保留/);
  assert.equal(value(guard, "建议操作"), "新建安全对话");
  assert.deepEqual(guard.details, ["broker_data/submit_order"]);
});

test("runtime version recognizes the observed cockpit UA without mistaking app or unrelated versions for Codex", () => {
  const observed = (serverUserAgent) => value(view(build({ codex: { additionalContextContract: { serverUserAgent } } }), "version", "version"), "已观测 Codex 版本");
  assert.equal(observed("trading_cockpit/0.154.0-alpha.6.2 (Mac OS 15.7.3; arm64) unknown (trading_cockpit; 0.24.6)"), "0.154.0-alpha.6.2");
  assert.equal(observed("codex_cli_rs/0.118.0"), "0.118.0");
  assert.equal(observed("unknown/1.2.3 (trading_cockpit; 0.24.6)"), null);
  assert.equal(observed("/private/codex/1.2.3"), null);
  assert.equal(observed("trading_cockpit/unknown (application/0.24.6)"), null);
  assert.equal(observed("trading_cockpit/0.154.0<script>"), null);
});

test("capacity exposes only supplied measured counts; unread data, unmeasured bytes and absent limits remain null", () => {
  const result = build({ capacities: [{ id: "technical_radar", count: 4, limit: 400, bytes: null, byteLimit: 96 * 1024 * 1024 }, { id: "review_cycles", count: null, limit: 500 }, { id: "private-secret", label: "secret", count: 99 }], portfolioSnapshots: { status: "unavailable", snapshotCount: 0 } });
  const radar = view(result, "capacity", "technical_radar");
  assert.equal(value(radar, "活跃条目数"), 4);
  assert.equal(value(radar, "活跃逻辑字节"), null);
  assert.equal(radar.state, "unknown");
  assert.match(radar.summary, /仅部分可核验.*不代表剩余空间安全/);
  assert.equal(value(radar, "条数上限核验"), "本次未达上限");
  assert.equal(value(radar, "字节上限核验"), "未完成");
  assert.equal(value(view(result, "capacity", "review_cycles"), "活跃条目数"), null);
  assert.equal(view(result, "capacity", "review_cycles").state, "unknown");
  assert.equal(view(result, "capacity", "private-secret"), undefined);
});

test("capacity requires both checks for normal; a known full dimension overrides incomplete data", () => {
  const capacity = (extra) => view(build({ capacities: [{ id: "technical_radar", count: 4, limit: 400, bytes: null, byteLimit: 96, ...extra }] }), "capacity", "technical_radar");
  assert.equal(capacity({ bytes: 0 }).state, "healthy", "measured zero is not unknown");
  assert.equal(capacity({ bytes: 20, byteLimit: null }).state, "unknown");
  assert.equal(capacity({ bytes: 20, count: null }).state, "unknown");
  assert.equal(capacity({ count: 400 }).state, "degraded");
  assert.equal(capacity({ bytes: 96, count: null }).state, "degraded");
  assert.equal(view(build({ portfolioSnapshots: eodFixture() }), "capacity", "portfolio_snapshots").state, "unknown", "a readable ledger count does not measure capacity");
});

test("capacity warns at 75 percent of either active limit without confusing archive or disk bytes", () => {
  const input = { id: "technical_radar", count: 300, limit: 400, bytes: 50, byteLimit: 100,
    totalCount: 900, archivedCount: 600, totalBytes: 9000, diskBytes: 88 };
  const measured = view(build({ capacities: [input] }), "capacity", "technical_radar");
  assert.equal(measured.state, "degraded");
  assert.match(measured.summary, /75%/);
  assert.equal(value(measured, "全部历史条目"), 900);
  assert.equal(value(measured, "账本密文合计"), 88);
  assert.equal(view(build({ capacities: [{ ...input, count: 299 }] }), "capacity", "technical_radar").state, "healthy");
  assert.equal(view(build({ capacities: [{ ...input, count: null, bytes: 75 }] }), "capacity", "technical_radar").state, "degraded");
});

test("health is an immutable safe projection: account identifiers, paths, tokens, raw errors and conversation text never reach the UI", () => {
  const marker = "SECRET-MARKER-123";
  const input = { storage: storageFixture(), version: { appVersion: "0.24.2", codexVersion: "/private/SECRET-MARKER-123" },
    longbridge: { connected: false, endpoint: `https://${marker}` },
    brokers: { views: { longbridge: portfolioFixture({ accountScopeIdentity: { scopeId: marker }, account: { id: marker }, fx: { providerCode: marker, sourceUrl: marker }, dataQuality: { sourceErrors: [{ message: marker }] } }) }, ibkr: { config: { accountId: marker, token: marker } } },
    codex: { workspaceDirectory: marker, additionalContextContract: { status: "unsupported", error: marker, serverUserAgent: marker } },
    lastAgentResult: { result: marker, threadId: marker, run: { modelAnalysis: { text: marker, resultDelivery: { historyReason: marker } } } },
  };
  input.storage.stores[0].errorCode = marker;
  const before = structuredClone(input);
  const result = build(input);
  assert.deepEqual(input, before);
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(value(view(result, "version", "version"), "应用版本"), "0.24.2");
});
