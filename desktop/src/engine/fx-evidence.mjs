/** Captions are evidence too: a combined portfolio must not relabel every
 * exchange-rate source as a live Longbridge observation. */
export function fxEvidenceMetadata(portfolio) {
  const status = portfolio.dataQuality?.fxStatus ?? "unavailable";
  const sources = portfolio.fx?.sources ?? [];
  const mixed = portfolio.fx?.providerCode === "多券商" || sources.length > 0;
  const provider = portfolio.fx?.providerCode
    ?? (portfolio.brokerScope === "ibkr" ? "IBKR" : "长桥");
  const available = ["live", "reference", "not_required"].includes(status);
  return {
    status,
    evidenceStatus: available ? "succeeded" : ["reference_cached", "cached", "mixed"].includes(status) ? "degraded" : "failed",
    source: status === "not_required" ? "USD 单币种估值"
      : mixed ? "多券商汇率来源汇总"
      : status === "live" ? `${provider}账户汇率` : `${portfolio.fx?.providerCode ?? "参考"} 参考汇率`,
    tool: status === "not_required" ? "fx_not_required" : mixed ? "broker_fx_sources"
      : ["reference", "reference_cached"].includes(status) ? "ecb_reference_rates" : "exchange_rate",
    asOf: status === "not_required" ? portfolio.syncedAt : portfolio.fx?.asOf ?? null,
    summary: status === "not_required" ? "组合仅涉及 USD · 无需汇率换算"
      : mixed ? `各券商独立估值，不重复换汇；汇总状态 ${status}；${sources.map(item => `${item.broker ?? item.label ?? "券商"}: ${item.status ?? item.fxStatus ?? "unknown"} / ${item.asOf ?? "来源日期未提供"}`).join("；")}`
      : status === "live" ? `${provider}账户汇率图`
      : ["reference", "reference_cached"].includes(status)
        ? `${portfolio.fx?.providerCode ?? "参考"} ${portfolio.fx?.asOf ?? "来源日期未提供"} 参考汇率${status === "reference_cached" ? "（缓存）" : ""}`
        : "跨币种估值暂停，汇率来源不足",
  };
}
