// Presentation only. No indicators, thresholds, market scores or trade rules
// are calculated here; use the host's existing card/comparison evidence.
(() => {
function radarChanges(card, ranked) {
  const comparison = card?.comparison;
  if (["state_changed", "new_symbol"].includes(comparison?.kind)) return comparison;
  return ranked?.get(String(card?.symbol ?? "")) ?? null;
}
function radarHasGap(card) {
  return card?.status !== "complete" || (Array.isArray(card?.degradedReasons) && card.degradedReasons.length > 0);
}
function radarVisibleCards(cards, { filter = "all", query = "", changes = new Map() } = {}) {
  const search = String(query).trim().toUpperCase();
  return cards.filter((card) => (!search || String(card.symbol).toUpperCase().includes(search))
    && (filter !== "changed" || radarChanges(card, changes))
    && (filter !== "gaps" || radarHasGap(card)))
    .map((card, index) => ({ card, index }))
    .sort((a, b) => Number(Boolean(radarChanges(b.card, changes))) - Number(Boolean(radarChanges(a.card, changes))) || a.index - b.index)
    .map(({ card }) => card);
}
function radarFieldLabel(field) {
  const extended = { technicalStatus: "技术数据", dailySequenceStatus: "日线序列", weeklyDirection: "周线方向", weeklySwing: "周线摆动", costMigration: "筹码迁移", cost14Location: "14日成本位置", cost14Acceptance: "14日价格接受度", cost28Location: "28日成本位置", cost28Acceptance: "28日价格接受度", qqqExcess5State: "QQQ相对强弱 · 5日", qqqExcess20State: "QQQ相对强弱 · 20日", sectorExcess20State: "行业相对强弱 · 20日" };
  if (extended[field]) return extended[field];
  return ({ coverageStatus: "数据覆盖", universeMembership: "观察范围", shortStructure: "短线结构", longStructure: "长线结构", priceVsEma21: "价格 / EMA21", priceVsEma144: "价格 / EMA144", priceVsEma169: "价格 / EMA169", weeklyTrend: "周线趋势", weeklyState: "周线结构", relativeStrengthState: "相对强弱", costProfileState: "筹码结构", marketEvidenceState: "市场证据" })[field] ?? String(field ?? "状态");
}
function radarStateLabel(value) {
  if (value == null || value === "" || value === "N/A") return "未取得";
  return ({
    above: "均线上方", below: "均线下方", at: "贴近均线",
    complete: "数据完整", available: "可用", partial: "部分可用", degraded: "部分缺失", unavailable: "无可用数据", warming: "预热中",
    holding: "持仓", watchlist: "自选", "holding+watchlist": "持仓 + 自选",
    compression_inside_28: "14日价值区在28日区间内收窄", overlapping: "14 / 28日成本区重叠", new_regime_outside_28: "14日 POC 移出28日价值区", upward: "成本区上移", downward: "成本区下移",
    above_value_area: "价值区上方", below_value_area: "价值区下方", inside_value_area: "价值区内部",
    accepted_above: "连续收盘在价值区上方", probing_above: "首次收盘在价值区上方", accepted_below: "连续收盘在价值区下方", probing_below: "首次收盘在价值区下方",
    rejected_from_above: "从上方回到价值区", rejected_from_below: "从下方回到价值区", accepted_inside: "连续收盘在价值区内", mixed_inside: "回到价值区内，尚未连续确认",
    advancing: "周线向上", declining: "周线向下", ranging_or_transitional: "周线震荡 / 过渡",
    higher_high_higher_low: "高低点同步抬升", lower_high_lower_low: "高低点同步下移", mixed_or_range: "高低点方向不一致 / 区间波动",
    positive: "跑赢基准", negative: "跑输基准", flat: "与基准持平", sizing_ready: "仓位计算证据就绪", decision_ready: "决策证据就绪", research_only: "仅研究可用",
  })[value] ?? String(value);
}
function radarInteger(value) {
  if (value == null || typeof value === "boolean" || String(value).trim() === "") return null;
  const n = Number(value); return Number.isInteger(n) && n >= 0 ? n : null;
}
function radarEmaNote(metric) {
  if (metric?.status !== "available" || metric.maturity === "mature") return "";
  return metric.maturity === "warming" ? "预热中" : "成熟度未知";
}
globalThis.CockpitRadarView = Object.freeze({ radarChanges, radarHasGap, radarVisibleCards, radarFieldLabel, radarStateLabel, radarInteger, radarEmaNote });
})();
