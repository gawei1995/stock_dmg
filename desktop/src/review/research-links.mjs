import { createHash } from "node:crypto";

// Research is account-independent; only explicit, immutable associations to
// the current account may supply supplementary context to a completed review.
export function eligibleResearchReviewCycles(cycles, accountScopeId) {
  if (!accountScopeId) return [];
  return (Array.isArray(cycles) ? cycles : [])
    .filter(cycle => cycle?.brokerLinks?.accountScopeId === accountScopeId && cycle?.status !== "cancelled")
    .map(cycle => ({ id: cycle.id, title: cycle.title || cycle.id,
      symbols: [...(cycle.symbols ?? [])], startAt: cycle.startAt ?? null,
      endAt: cycle.endAt ?? null, cycleType: cycle.cycleType ?? cycle.type,
      evidenceRevision: cycle.evidenceRevision ?? null }));
}

export function assertResearchReviewLink({ thesis, cycle, accountScopeId }) {
  if (!cycle || !accountScopeId || cycle?.brokerLinks?.accountScopeId !== accountScopeId) {
    throw new Error("请先在当前账户的复盘周期中关联真实订单，再连接研究记录；不会猜测订单归属。");
  }
  if (cycle.status === "cancelled") throw new Error("已取消的复盘周期不能新增研究关联。");
  const symbols = (cycle.symbols ?? []).map(researchSymbolKey);
  if (thesis?.symbol && symbols.length && !symbols.includes(researchSymbolKey(thesis.symbol))) {
    throw new Error("研究标的与该复盘周期不一致；请选择相同标的的周期，或包含它的组合周期。");
  }
  return true;
}

export function buildLinkedResearchReferences({ theses, cycleId, accountScopeId, phase, maxItems = 5, maxChars = 16_000 } = {}) {
  // Never introduce current research, later user recollection or an association
  // selected with hindsight into the physical blind-phase context.
  if (phase === "blind") return null;
  if (!["outcome", "retrospective"].includes(phase)) throw new Error("研究关联的复盘阶段无效。");
  if (!cycleId || !accountScopeId) return null;
  const matches = [];
  for (const thesis of Array.isArray(theses) ? theses : []) {
    for (const link of thesis.reviewLinks ?? []) {
      if (link.cycleId !== cycleId || link.accountScopeId !== accountScopeId) continue;
      if (!link.contextSnapshot || !link.contextHash) throw new Error("研究关联缺少已冻结的上下文与指纹，请重新检查原研究记录。");
      matches.push({ thesisId: thesis.id, thesisVersion: link.thesisVersion,
        linkedAt: link.linkedAt, contextHash: link.contextHash,
        context: structuredClone(link.contextSnapshot),
        interpretation: "supplementary_recorded_judgment_not_ex_ante_baseline" });
    }
  }
  if (!matches.length) return null;
  matches.sort((left, right) => String(right.linkedAt).localeCompare(String(left.linkedAt)));
  const limit = Number.isInteger(maxItems) && maxItems > 0 ? Math.min(maxItems, 10) : 5;
  const budget = Number.isInteger(maxChars) && maxChars >= 4_000 ? Math.min(maxChars, 30_000) : 16_000;
  const items = [];
  let omittedBySize = 0;
  for (const reference of matches.slice(0, limit)) {
    // Do not send a truncated JSON snapshot whose recorded hash appears to
    // cover the original. Omit the whole reference and disclose the omission.
    if (JSON.stringify([...items, reference]).length > budget) { omittedBySize++; continue; }
    items.push(reference);
  }
  return { schemaVersion: "research-review-references/v1", cycleId, phase, items,
    coverage: { sourceCount: matches.length, deliveredCount: items.length, omittedCount: matches.length - items.length,
      omittedByItemLimit: Math.max(0, matches.length - limit), omittedBySize, maxChars: budget },
    interpretation: "用户明确关联时保存的研究版本，仅作补充判断记录；不替代冻结事前基线，不改变正式评分资格。声明的来源日期不等于已核验的历史可得性。",
    hash: `sha256:${createHash("sha256").update(JSON.stringify(items)).digest("hex")}` };
}

// Comparison-only aliases: retain the user's input in the notebook and never
// infer a different instrument for data retrieval. US tickers are commonly
// entered bare; explicit non-US suffixes stay distinct.
function researchSymbolKey(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  const tvUs = symbol.match(/^(NASDAQ|NYSE|AMEX):(.+)$/);
  if (tvUs) return `${tvUs[2]}.US`;
  const tvHk = symbol.match(/^HKEX:(\d+)$/);
  if (tvHk) return `${Number(tvHk[1])}.HK`;
  if (/^\d+\.HK$/.test(symbol)) return `${Number(symbol.slice(0, -3))}.HK`;
  if (/^[A-Z][A-Z0-9_-]*$/.test(symbol)) return `${symbol}.US`;
  return symbol;
}
