import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexEvidence,
  buildWorkspacePrompt,
} from "../src/engine/codex-workspace.mjs";

const portfolio = {
  status: "live",
  syncedAt: "2026-07-21T03:00:00.000Z",
  account: { baseCurrency: "USD", netAssets: 10_000 },
  totals: { cashRatio: 40, top1Weight: 35, top5Weight: 60 },
  dataQuality: { valuationComplete: true, fxStatus: "live" },
  fx: { provider: "Longbridge", asOf: "2026-07-21" },
  groupExposure: { Technology: 60 },
  positions: [
    { symbol: "AAPL.US", ticker: "AAPL", name: "Apple", group: "Technology", instrumentType: "equity", currency: "USD", quantity: 10, weight: 35 },
    { symbol: "MSFT.US", ticker: "MSFT", name: "Microsoft", group: "Technology", instrumentType: "equity", currency: "USD", quantity: 5, weight: 25 },
  ],
};

function run(scope, symbol, analysisContext) {
  return {
    task: "分析",
    context: { scope, symbol, snapshotAt: portfolio.syncedAt },
    analysisContext,
    risk: { riskBudgetPercent: 0.8 },
    technical: { ema: { 21: 200 } },
    plan: { available: true, scenarios: [] },
    evidence: [],
  };
}

test("Codex context is scoped instead of injecting all holdings into every turn", () => {
  const position = buildCodexEvidence({
    portfolio,
    run: run("position", "AAPL.US", {
      scope: "position",
      portfolioSummary: { top1WeightPercent: 35 },
      target: { symbol: "AAPL.US" },
      risk: {},
    }),
  });
  assert.equal(position.selectedPosition.symbol, "AAPL.US");
  assert.equal(position.scopedContext.positions, undefined);
  assert.equal("portfolioPositions" in position, false);

  const candidate = buildCodexEvidence({
    portfolio,
    run: run("candidate", "NVDA.US", {
      scope: "candidate",
      portfolioSummary: { cashRatioPercent: 40 },
      target: { symbol: "NVDA.US", isHeld: false },
      risk: {},
    }),
  });
  assert.equal(candidate.selectedPosition, null);
  assert.equal(candidate.candidateTarget.symbol, "NVDA.US");
  assert.equal(candidate.scopedContext.positions, undefined);

  const portfolioRun = buildCodexEvidence({
    portfolio,
    run: run("portfolio", null, {
      scope: "portfolio",
      portfolioSummary: { top1WeightPercent: 35 },
      target: null,
      positions: portfolio.positions,
      risk: {},
    }),
  });
  assert.equal(portfolioRun.scopedContext.positions.length, 2);
  assert.equal(portfolioRun.technical, null);
  assert.equal("portfolioPositions" in portfolioRun, false);
});

test("workspace prompt declares independent session and the selected analysis scope", () => {
  const prompt = buildWorkspacePrompt({
    analysisScope: "candidate",
    userTask: "分析 NVDA",
  });
  assert.match(prompt, /独立的持久 Codex thread/);
  assert.match(prompt, /候选买入分析/);
  assert.match(prompt, /不得把候选标的写成现有仓位/);
});
