import { withPortfolioFreshness } from "./freshness.mjs";

export const BROKER_LABELS = Object.freeze({ longbridge: "长桥", ibkr: "IBKR" });
export function brokerScope(value = "all") {
  if (!["all", "longbridge", "ibkr"].includes(value)) throw new Error("账户范围无效。");
  return value;
}
export const finite = (value) => value == null || value === "" || typeof value === "boolean"
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const completeSum = (values) => values.length && values.every((v) => finite(v) != null)
  ? values.reduce((sum, v) => sum + Number(v), 0) : null;

// Values are already USD here. Never apply FX again, sum buying power, or net
// away opposite positions held at separate brokers.
export function buildBrokerViews({ longbridge = null, ibkr = null, ibkrEnabled = false, now = Date.now() } = {}) {
  const views = { longbridge: annotate(longbridge, "longbridge", now), ibkr: annotate(ibkr, "ibkr", now) };
  const available = Object.values(views).filter(Boolean);
  if (!available.length) return { ...views, all: null };
  const expected = ["longbridge", ...(ibkrEnabled || ibkr ? ["ibkr"] : [])];
  const missing = expected.filter((broker) => !views[broker]);
  if (available.length === 1 && !missing.length) {
    return { ...views, all: { ...available[0], brokerScope: "all", expectedBrokers: expected, missingBrokers: [] } };
  }
  const accounts = available.flatMap((p) => p.brokerAccounts);
  const netAssets = missing.length ? null : completeSum(accounts.map((a) => a.netAssets));
  const totalCash = missing.length ? null : completeSum(accounts.map((a) => a.totalCash));
  const groups = new Map();
  for (const p of available.flatMap((p) => p.positions)) {
    // Cross-broker option identity is NOT inferred from ticker/strike alone.
    const key = p.instrumentType === "equity" && /\.(US|HK)$/.test(p.symbol)
      ? `${p.symbol}:${p.currency}` : `${p.broker}:${p.positionId ?? p.symbol}`;
    const row = groups.get(key);
    if (!row) groups.set(key, structuredClone(p));
    else groups.set(key, mergeEquities(row, p));
  }
  const positions = [...groups.values()];
  const totals = calculateBrokerTotals(positions, { netAssets, totalCash });
  const oldest = available.map((p) => p.syncedAt).filter(Boolean).sort()[0] ?? null;
  const complete = !missing.length && available.every((p) => p.dataQuality?.valuationComplete === true);
  const fxSources = available.map((p) => ({
    broker: p.brokerScope,
    status: p.dataQuality?.fxStatus ?? "unknown",
    provider: p.fx?.provider ?? p.source ?? BROKER_LABELS[p.brokerScope],
    providerCode: p.fx?.providerCode ?? BROKER_LABELS[p.brokerScope],
    asOf: p.fx?.asOf ?? null,
    fetchedAt: p.fx?.fetchedAt ?? null,
    sourceUrl: p.fx?.sourceUrl ?? null,
    snapshotAt: p.syncedAt ?? null,
  }));
  const sourceDiagnostics = (field) => available.flatMap((p) =>
    (Array.isArray(p.dataQuality?.[field]) ? p.dataQuality[field] : []).map((item) => (
      item && typeof item === "object" ? { ...item, broker: p.brokerScope }
        : { broker: p.brokerScope, tool: p.brokerScope, message: String(item) }
    )));
  const combined = {
    source: "券商独立快照汇总（USD）", brokerScope: "all", brokerAccounts: accounts,
    expectedBrokers: expected, missingBrokers: missing,
    status: available.some((p) => ["cached", "stale"].includes(p.freshness?.state)) ? "stale" : "degraded",
    holdingsStatus: missing.length ? "partial" : "live", syncedAt: oldest,
    account: { baseCurrency: "USD", netAssets, totalCash, buyPower: null, initMargin: null,
      maintenanceMargin: null, riskLevel: "各账户独立", cashInfos: [], valuationComplete: complete },
    positions, ...totals,
    dataQuality: { valuationComplete: complete, accountValuationComplete: !missing.length && netAssets != null,
      fxStatus: aggregateFxStatus(fxSources, missing),
      sourceErrors: [...sourceDiagnostics("sourceErrors"), ...missing.map((b) => ({ broker: b, tool: b, message: `${BROKER_LABELS[b]} 尚无持仓快照，汇总不完整` }))],
      sourceWarnings: sourceDiagnostics("sourceWarnings"),
      quoteErrors: available.flatMap((p) => (p.dataQuality?.quoteErrors ?? []).map((error) => `[${BROKER_LABELS[p.brokerScope]}] ${String(error)}`)),
      unpricedPositionCount: totals.totals.unpricedPositionCount },
    fx: { provider: "多券商独立汇率来源", providerCode: "多券商", usage: "broker_values_already_converted_to_usd", sources: fxSources,
      asOf: fxSources.every((source) => source.asOf) ? fxSources.map((source) => source.asOf).sort()[0] : null },
    limitations: available.flatMap((p) => (p.limitations ?? []).map((message) => `[${BROKER_LABELS[p.brokerScope]}] ${message}`)),
    valuationSchemaVersion: 2, orderWrite: false,
    aggregationPolicy: "USD values summed once; broker buying power and margin remain separate; option premium exposure is not delta exposure",
    // A combined valuation gate must not masquerade as the Longbridge gate.
    // Broker-local gates remain attached below for research and audit.
    valuationGate: null,
  };
  return { ...views, all: withPortfolioFreshness(combined, { now }) };
}

function annotate(portfolio, broker, now) {
  if (!portfolio) return null;
  const value = withPortfolioFreshness(structuredClone(portfolio), { now });
  value.brokerScope = broker;
  value.brokerAccounts = [{ broker, label: BROKER_LABELS[broker], scopeId: value.accountScopeIdentity?.scopeId ?? null,
    accountLabel: value.accountLabel ?? BROKER_LABELS[broker], ...value.account,
    syncedAt: value.syncedAt, status: value.freshness.state, source: value.source,
    dataQuality: value.dataQuality ?? null, fx: value.fx ?? null, limitations: value.limitations ?? [],
    valuationGate: value.valuationGate, readyForSizing: value.freshness.freshForSizing }];
  value.positions = value.positions.map((p) => ({ ...p, broker,
    positionId: p.positionId ?? `${broker}:${p.symbol}`,
    brokerLegs: [{ broker, label: value.accountLabel ?? BROKER_LABELS[broker], scopeId: value.accountScopeIdentity?.scopeId ?? null,
      symbol: p.symbol, quantity: p.quantity, costPrice: p.costPrice, currency: p.currency,
      marketValueBase: p.marketValueBase, grossMarketValueBase: p.grossMarketValueBase,
      lastPrice: p.lastPrice, quoteTimestamp: p.quoteTimestamp, quoteAvailability: p.quoteAvailability ?? null,
      contractMultiplier: p.contractMultiplier, option: p.option ?? null, syncedAt: value.syncedAt }],
  }));
  return value;
}

function aggregateFxStatus(sources, missing) {
  if (missing.length) return "unavailable";
  const states = sources.map((source) => source.status);
  const understood = new Set(["live", "reference", "reference_cached", "not_required"]);
  if (states.some((status) => !understood.has(status))) return "unavailable";
  if (states.includes("reference_cached")) return "reference_cached";
  if (states.includes("reference")) return "reference";
  return states.includes("live") ? "live" : "not_required";
}

function mergeEquities(a, b) {
  const legs = [...a.brokerLegs, ...b.brokerLegs];
  const quantity = a.quantity + b.quantity;
  const grossQuantity = (a.grossQuantity ?? Math.abs(a.quantity)) + (b.grossQuantity ?? Math.abs(b.quantity));
  const opposite = legs.some((p) => p.quantity > 0) && legs.some((p) => p.quantity < 0);
  const cost = !opposite && legs.every((p) => finite(p.costPrice) != null) && grossQuantity > 0
    ? legs.reduce((sum, p) => sum + Math.abs(p.quantity) * p.costPrice, 0) / grossQuantity : null;
  return { ...a, broker: "multiple", brokerLegs: legs, quantity, grossQuantity,
    hasOffsettingLegs: opposite, direction: opposite ? "hedged" : quantity > 0 ? "long" : "short",
    costPrice: cost, costBasisStatus: cost == null ? "missing" : "available",
    costBasisLimitation: opposite ? "跨账户多空分别保留，合并成本不适用；展开查看各券商。" : null,
    marketValueBase: completeSum(legs.map((p) => p.marketValueBase)),
    grossMarketValueBase: completeSum(legs.map((p) => p.grossMarketValueBase)),
    pnlBase: completeSum([a.pnlBase, b.pnlBase]), pnlPercent: null,
    // Do not pick an arbitrary broker's mark as the merged instrument price.
    lastPrice: null, quoteTimestamp: null, quoteSession: null, changePercent: null,
    valuationStatus: [a, b].every((p) => p.valuationStatus === "priced") ? "priced" : "unpriced",
  };
}

export function calculateBrokerTotals(positions, account) {
  const netAssets = finite(account.netAssets);
  const groupExposure = {}, groupNetExposure = {};
  for (const p of positions) {
    p.weight = netAssets > 0 && finite(p.grossMarketValueBase) != null ? p.grossMarketValueBase / netAssets * 100 : null;
    p.netWeight = netAssets > 0 && finite(p.marketValueBase) != null ? p.marketValueBase / netAssets * 100 : null;
    if (p.weight != null) groupExposure[p.group ?? "其他"] = (groupExposure[p.group ?? "其他"] ?? 0) + p.weight;
    if (p.netWeight != null) groupNetExposure[p.group ?? "其他"] = (groupNetExposure[p.group ?? "其他"] ?? 0) + p.netWeight;
  }
  positions.sort((a, b) => (b.grossMarketValueBase ?? -1) - (a.grossMarketValueBase ?? -1));
  const unpriced = positions.filter((p) => finite(p.marketValueBase) == null).length;
  return { groupExposure, groupNetExposure, totals: {
    positionCount: positions.length, pricedPositionCount: positions.length - unpriced, unpricedPositionCount: unpriced,
    positionsNetMarketValueBase: positions.length ? completeSum(positions.map((p) => p.marketValueBase)) : 0,
    positionsGrossMarketValueBase: positions.length ? completeSum(positions.map((p) => p.grossMarketValueBase)) : 0,
    top1Weight: positions[0]?.weight ?? null,
    top5Weight: completeSum(positions.slice(0, 5).map((p) => p.weight)),
    cashRatio: netAssets > 0 && finite(account.totalCash) != null ? account.totalCash / netAssets * 100 : null,
  } };
}
