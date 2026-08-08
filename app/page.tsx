"use client";

import { useMemo, useState } from "react";
import type { CSSProperties } from "react";

type AgentTab = "agent" | "risk" | "plan";
type ReviewStage = "review" | "test" | "rule" | "approval";
type EmaPeriod = 3 | 5 | 8 | 13 | 21 | 144 | 169;

type Instrument = {
  symbol: string;
  name: string;
  price: string;
  change: string;
  direction: "up" | "down";
  position: number;
  pnl: string;
  stage: string;
  temperature: number;
  verdict: string;
  thesis: string;
  zone: string;
  invalidation: string;
  trigger: string;
  action: string;
  candles: number[];
  quantity: number;
  available: number;
  avgCost: number;
  marketValue: string;
  fibLow: number;
  fibHigh: number;
  fibC: number;
  ema: Record<EmaPeriod, number>;
  shortSlope: string;
  longSlope: string;
  emaEvent: string;
};

const instruments: Instrument[] = [
  {
    symbol: "NVDA",
    name: "NVIDIA",
    price: "173.42",
    change: "+1.84%",
    direction: "up",
    position: 8.2,
    pnl: "+12.6%",
    stage: "Stage 3",
    temperature: 7,
    verdict: "趋势持有，等待回踩",
    thesis: "主升结构仍在，但短线不适合追价。保留核心仓，战术仓等待价格回到确认区。",
    zone: "168–171",
    invalidation: "日线跌破 162",
    trigger: "回踩 170 附近缩量企稳",
    action: "核心仓不动；确认后增加 1.0% 战术仓",
    candles: [42, 51, 48, 58, 66, 61, 72, 77, 69, 82, 88, 79, 91, 96, 89, 101, 106, 99, 113, 119, 111, 124, 132, 127],
    quantity: 580,
    available: 580,
    avgCost: 154.02,
    marketValue: "$100,584",
    fibLow: 148.6,
    fibHigh: 173.4,
    fibC: 162.3,
    ema: { 3: 172.8, 5: 171.6, 8: 170.2, 13: 168.4, 21: 165.7, 144: 138.5, 169: 132.1 },
    shortSlope: "五条快线向上扩散",
    longSlope: "144 / 169 同向上行",
    emaEvent: "价格运行于 EMA3 上方",
  },
  {
    symbol: "GOOGL",
    name: "Alphabet",
    price: "208.15",
    change: "+0.62%",
    direction: "up",
    position: 7.4,
    pnl: "+8.3%",
    stage: "Stage 3",
    temperature: 6,
    verdict: "核心持有，不在中位加仓",
    thesis: "叙事稳定、技术中性偏强。等待区间边缘，而不是在无风险收益比的位置增加暴露。",
    zone: "201–204",
    invalidation: "周线跌破 194",
    trigger: "重新站上 210 且量能扩张",
    action: "维持 7.4%；突破确认后再评估上限",
    candles: [59, 62, 57, 65, 68, 71, 66, 73, 76, 74, 81, 85, 82, 88, 91, 87, 94, 98, 93, 101, 104, 99, 108, 111],
    quantity: 440,
    available: 440,
    avgCost: 192.14,
    marketValue: "$91,586",
    fibLow: 187.2,
    fibHigh: 208.15,
    fibC: 199.4,
    ema: { 3: 207.6, 5: 206.8, 8: 205.4, 13: 203.1, 21: 200.6, 144: 181.3, 169: 176.8 },
    shortSlope: "快线温和向上，扩散有限",
    longSlope: "144 / 169 稳定上行",
    emaEvent: "价格收复 EMA3 / 5",
  },
  {
    symbol: "AVGO",
    name: "Broadcom",
    price: "321.68",
    change: "-1.16%",
    direction: "down",
    position: 6.1,
    pnl: "+4.1%",
    stage: "Stage 3→4P",
    temperature: 4,
    verdict: "冻结加仓，观察去拥挤",
    thesis: "基本面叙事没有直接破坏，但价格正在消化拥挤度。先降低行动频率，等待板块同步止跌。",
    zone: "304–312",
    invalidation: "日线跌破 296",
    trigger: "收复 330 且半导体板块转强",
    action: "不补仓；失效后削减 1.5% 战术暴露",
    candles: [105, 111, 118, 116, 126, 131, 137, 142, 135, 146, 151, 147, 157, 162, 154, 149, 142, 145, 137, 132, 128, 134, 129, 124],
    quantity: 237,
    available: 187,
    avgCost: 309.11,
    marketValue: "$76,242",
    fibLow: 287.4,
    fibHigh: 348.2,
    fibC: 321.7,
    ema: { 3: 326.0, 5: 329.2, 8: 332.8, 13: 336.4, 21: 338.1, 144: 287.0, 169: 276.2 },
    shortSlope: "五条快线同步向下",
    longSlope: "144 / 169 仍保持上行",
    emaEvent: "价格低于全部短周期 EMA",
  },
  {
    symbol: "AAPL",
    name: "Apple",
    price: "247.91",
    change: "-0.28%",
    direction: "down",
    position: 5.3,
    pnl: "+2.7%",
    stage: "Stage 2",
    temperature: 5,
    verdict: "区间管理，等待方向",
    thesis: "结构没有明确趋势优势。把它作为区间仓位管理，不把横盘误读成突破前夜。",
    zone: "240–244",
    invalidation: "日线跌破 235",
    trigger: "放量突破 252 并回踩确认",
    action: "维持现有仓位；只在区间边缘行动",
    candles: [72, 68, 74, 78, 75, 81, 84, 80, 86, 89, 85, 91, 94, 90, 96, 98, 93, 97, 101, 99, 103, 100, 105, 102],
    quantity: 267,
    available: 267,
    avgCost: 241.38,
    marketValue: "$66,192",
    fibLow: 229.5,
    fibHigh: 252.1,
    fibC: 241.2,
    ema: { 3: 248.4, 5: 247.9, 8: 247.1, 13: 245.9, 21: 244.8, 144: 228.6, 169: 221.7 },
    shortSlope: "3 / 5 / 8 收敛，斜率趋平",
    longSlope: "144 / 169 缓慢上行",
    emaEvent: "价格围绕 EMA3 / 5 震荡",
  },
];

const exposures = [
  { label: "AI / 半导体", value: 48, tone: "cobalt" },
  { label: "平台科技", value: 31, tone: "sage" },
  { label: "消费硬件", value: 17, tone: "amber" },
  { label: "对冲与其他策略", value: 40, tone: "other" },
];

const timeframes = ["15m", "1H", "4H", "1D", "1W"];
const evidenceStack = [
  { label: "量价与市场结构", status: "确认", detail: "突破后缩量回踩，卖压未扩张", tone: "positive" },
  { label: "筹码 / 成交量分布", status: "确认", detail: "高成交节点位于现价下方，成本带仍有承接", tone: "positive" },
  { label: "相对强弱", status: "确认", detail: "相对 QQQ 与板块 ETF 维持领先", tone: "positive" },
  { label: "锚定 VWAP", status: "观察", detail: "财报锚点上方，但斜率趋缓", tone: "mixed" },
  { label: "期权与波动率", status: "冲突", detail: "短端 IV 偏高，追价赔率被压缩", tone: "bear" },
  { label: "板块 / 同行联动", status: "确认", detail: "半导体扩散仍在，存储链出现分化", tone: "positive" },
  { label: "事件后的价格反应", status: "观察", detail: "好消息被接受，仍需后续量能确认", tone: "mixed" },
  { label: "EMA / Fibonacci", status: "可选", detail: "仅在当前结构有解释力时纳入，不设固定权重", tone: "optional" },
];

const reviewStages = [
  { key: "review" as const, index: "01", label: "复盘", eyebrow: "RECONSTRUCT", title: "还原当时的决定", copy: "先冻结财报前判断，再连接真实订单、逐笔成交与持仓快照；盈亏不能覆盖当时的信息集。" },
  { key: "test" as const, index: "02", label: "测试", eyebrow: "MEASURE", title: "用同一口径比较", copy: "以一个财报事件为一个样本，固定 T+1 / T+5 / T+20，统计净 R、MAE、MFE 与反事实路径。" },
  { key: "rule" as const, index: "03", label: "规则", eyebrow: "PROMOTE", title: "把发现写成假设", copy: "只有可观察、可执行、可证伪且跨季度稳定的结论，才从观察升级为暂行规则。" },
  { key: "approval" as const, index: "04", label: "Review", eyebrow: "HUMAN GATE", title: "由你批准进入系统", copy: "Agent 提供证据、反例和置信度；规则是否启用、降级或停用，始终由你确认。" },
];

const orderHistory = [
  { time: "07-22 10:14:08", symbol: "NVDA", side: "买入", quantity: "180", average: "$168.72", role: "财报前战术仓", state: "已匹配" },
  { time: "07-24 09:41:36", symbol: "NVDA", side: "卖出", quantity: "80", average: "$176.38", role: "事件后兑现", state: "已匹配" },
  { time: "07-24 15:52:11", symbol: "QQQ 保护", side: "买入", quantity: "12", average: "$6.15", role: "组合对冲", state: "待确认" },
];

function getEmaStructure(instrument: Instrument) {
  const price = Number(instrument.price);
  const ema = instrument.ema;
  const fullBull = price > ema[3] && ema[3] > ema[5] && ema[5] > ema[8] && ema[8] > ema[13] && ema[13] > ema[21];
  const fullBear = price < ema[3] && ema[3] < ema[5] && ema[5] < ema[8] && ema[8] < ema[13] && ema[13] < ema[21];
  const longBull = price > ema[144] && ema[144] > ema[169];
  const longBear = price < ema[144] && ema[144] < ema[169];

  return {
    shortLabel: fullBull ? "完整多头排列" : fullBear ? "完整空头排列" : "均线交错 / 过渡",
    shortTone: fullBull ? "bull" : fullBear ? "bear" : "mixed",
    shortAction: fullBull ? "顺势持有，回踩 8/13 EMA 再评估加仓" : fullBear ? "反弹先按修复，不把触及 EMA 当成反转" : "降低行动频率，等待 3/5/8 重新定序",
    longLabel: longBull ? "长周期多头" : longBear ? "长周期空头" : "长周期转换",
    longTone: longBull ? "bull" : longBear ? "bear" : "mixed",
    longAction: longBull ? "144 在 169 上方，核心仓可继续按长周期管理" : longBear ? "144 在 169 下方，优先控制总暴露" : "144/169 收敛，避免用短线信号放大长期仓位",
  };
}

export default function Home() {
  const [selectedSymbol, setSelectedSymbol] = useState("NVDA");
  const [activeTab, setActiveTab] = useState<AgentTab>("agent");
  const [riskBudget, setRiskBudget] = useState(1.2);
  const [planReady, setPlanReady] = useState(false);
  const [reviewStage, setReviewStage] = useState<ReviewStage>("review");

  const selected = useMemo(
    () => instruments.find((instrument) => instrument.symbol === selectedSymbol) ?? instruments[0],
    [selectedSymbol],
  );

  const maxLoss = ((selected.position * riskBudget) / 100).toFixed(2);
  const emaStructure = getEmaStructure(selected);
  const activeReview = reviewStages.find((stage) => stage.key === reviewStage) ?? reviewStages[0];
  const priceAxis = useMemo(() => {
    const price = Number(selected.price);
    return [1.06, 1.02, 0.98, 0.94].map((factor) => (price * factor).toFixed(0));
  }, [selected.price]);

  function selectInstrument(symbol: string) {
    setSelectedSymbol(symbol);
    setPlanReady(false);
  }

  return (
    <div className="app-shell" id="top">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="交易驾驶舱首页">
          <span className="brand-mark" aria-hidden="true"><i /><i /></span>
          <span>交易驾驶舱 <small>TRADING OS</small></span>
        </a>
        <nav aria-label="主要导航">
          <a href="#workspace">工作台</a>
          <a href="#technical">证据栈</a>
          <a href="#portfolio">仓位</a>
          <a href="#review">复盘</a>
          <a href="#architecture">架构</a>
        </nav>
        <div className="header-status">
          <span className="demo-pill">演示快照</span>
          <span className="readonly-pill"><i />只读模式</span>
        </div>
      </header>

      <main>
        <section className="intro" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">Chart → position → decision</p>
            <h1 id="page-title">一个界面，从看盘到交易计划。</h1>
          </div>
          <p>
            TradingView 保留你的看盘界面；长桥只读同步行情、真实仓位、历史订单与逐笔成交；Agent 组织证据、控制组合暴露，并让每次决定进入可复用的复盘闭环。
          </p>
        </section>

        <section className="source-rail" aria-label="数据源连接状态">
          <article>
            <span className="source-logo tv-logo" aria-hidden="true">TV</span>
            <div><small>视觉工作流</small><strong>TradingView 看板</strong></div>
            <span className="source-state manual">人工观察</span>
          </article>
          <div className="rail-arrow" aria-hidden="true">+</div>
          <article>
            <span className="source-logo lb-logo" aria-hidden="true">LB</span>
            <div><small>账户事实层</small><strong>长桥仓位 / 历史订单 / 成交</strong></div>
            <span className="source-state pending">接口待连接</span>
          </article>
          <div className="rail-arrow" aria-hidden="true">→</div>
          <article className="agent-source">
            <span className="source-logo ai-logo" aria-hidden="true">AI</span>
            <div><small>决策组织层</small><strong>交易 Agent</strong></div>
            <span className="source-state analysing">演示分析</span>
          </article>
          <div className="rail-output">
            <span>输出</span>
            <strong>计划 · 复盘 · 规则</strong>
          </div>
        </section>

        <section className="workspace" id="workspace" aria-label="交易工作台演示">
          <aside className="watchlist panel" aria-labelledby="watchlist-title">
            <div className="panel-title">
              <div><span>WATCHLIST</span><h2 id="watchlist-title">关注与持仓</h2></div>
              <span className="prototype-label">原型数据</span>
            </div>
            <div className="watchlist-items">
              {instruments.map((instrument) => (
                <button
                  type="button"
                  key={instrument.symbol}
                  className={selected.symbol === instrument.symbol ? "watch-row selected" : "watch-row"}
                  onClick={() => selectInstrument(instrument.symbol)}
                  aria-pressed={selected.symbol === instrument.symbol}
                >
                  <span className="ticker-avatar">{instrument.symbol.slice(0, 1)}</span>
                  <span className="watch-name"><strong>{instrument.symbol}</strong><small>{instrument.name}</small></span>
                  <span className="watch-price"><strong>{instrument.price}</strong><small className={instrument.direction}>{instrument.change}</small></span>
                </button>
              ))}
            </div>
            <div className="watch-summary">
              <span>组合净值 <strong>$1,248,620</strong></span>
              <span>今日 <strong className="positive">+0.74%</strong></span>
            </div>
          </aside>

          <section className="chart-panel panel" aria-labelledby="chart-title">
            <div className="chart-head">
              <div>
                <div className="symbol-line"><h2 id="chart-title">{selected.symbol}</h2><span>{selected.name}</span></div>
                <div className="quote-line"><strong>{selected.price}</strong><span className={selected.direction}>{selected.change}</span><small>USD · 演示数据</small></div>
              </div>
              <div className="timeframe-tabs" aria-label="图表周期">
                {timeframes.map((item) => (
                  <button key={item} type="button" className={item === "1D" ? "active" : ""} disabled={item !== "1D"} aria-pressed={item === "1D"} aria-label={item === "1D" ? "日线演示数据" : `${item} 周期将在 TradingView 接入后启用`}>{item}</button>
                ))}
              </div>
            </div>

            <div className="chart-canvas" role="img" aria-label={`${selected.symbol} 日线演示行情图，价格 ${selected.price} 美元，变动 ${selected.change}，决策区 ${selected.zone}，短周期结构为 ${emaStructure.shortLabel}`}>
              <div className="price-axis" aria-hidden="true">{priceAxis.map((label) => <span key={label}>{label}</span>)}</div>
              <div className="decision-zone" aria-hidden="true"><span>{selected.zone} 决策区</span></div>
              <div className="candles" aria-hidden="true">
                {selected.candles.map((height, index) => {
                  const previous = index === 0 ? height - 3 : selected.candles[index - 1];
                  const rising = height >= previous;
                  const body = 9 + (index % 5) * 2;
                  const style = {
                    "--candle-height": `${Math.max(34, height)}px`,
                    "--body-height": `${body}px`,
                    "--offset": `${(index % 4) * 5}px`,
                  } as CSSProperties;
                  return <span key={`${selected.symbol}-${index}`} className={rising ? "candle rising" : "candle falling"} style={style}><i /></span>;
                })}
              </div>
              <div className="chart-crosshair" aria-hidden="true"><span>{selected.price}</span></div>
              <div className="chart-labels" aria-hidden="true"><span>EMA 8</span><span>EMA 21</span><span>AVWAP</span></div>
            </div>

            <div className="chart-footer">
              <span><i className="legend-dot cobalt" />EMA 8</span>
              <span><i className="legend-dot coral" />EMA 21</span>
              <span><i className="legend-dot sage" />AVWAP</span>
              <strong>TradingView 视觉布局位置</strong>
            </div>
          </section>

          <aside className="agent-panel panel" aria-labelledby="agent-title">
            <div className="agent-head">
              <div><span>TRADING AGENT</span><h2 id="agent-title">决策面板</h2></div>
              <span className="agent-live"><i />演示上下文</span>
            </div>

            <div className="agent-tabs" aria-label="Agent 模块切换">
              {([
                ["agent", "判断"],
                ["risk", "风险"],
                ["plan", "计划"],
              ] as Array<[AgentTab, string]>).map(([key, label]) => (
                <button key={key} type="button" aria-pressed={activeTab === key} className={activeTab === key ? "active" : ""} onClick={() => setActiveTab(key)}>{label}</button>
              ))}
            </div>

            <div className="agent-content" aria-live="polite">
              {activeTab === "agent" && (
                <div className="agent-view">
                  <div className="decision-badges"><span>{selected.stage}</span><span>技术温度 {selected.temperature}/10</span></div>
                  <h3>{selected.verdict}</h3>
                  <p>{selected.thesis}</p>
                  <div className="agent-tech-snapshot">
                    <div><span>证据覆盖</span><strong className="bull">6 / 8 项可用</strong></div>
                    <div><span>冲突证据</span><strong className="mixed">期权赔率偏弱</strong></div>
                  </div>
                  <dl>
                    <div><dt>当前位置</dt><dd>{selected.position}% 组合权重</dd></div>
                    <div><dt>关注区域</dt><dd>{selected.zone}</dd></div>
                    <div><dt>核心证据</dt><dd>筹码承接 · 相对强弱</dd></div>
                    <div><dt>结构失效</dt><dd>{selected.invalidation}</dd></div>
                  </dl>
                  <button type="button" className="primary-action" onClick={() => setActiveTab("risk")}>查看组合风险 <span>→</span></button>
                </div>
              )}

              {activeTab === "risk" && (
                <div className="risk-view">
                  <div className="risk-score"><span>组合 Gross Exposure · 120% 预警 / 150% 硬上限</span><strong>136%</strong><i className="gross-meter"><b style={{ width: "90.7%" }} /><em /></i><small>已越过预警线 16%，距硬上限剩余 14%</small></div>
                  <label htmlFor="risk-budget">标的下行假设 <strong>{riskBudget.toFixed(1)}%</strong></label>
                  <input id="risk-budget" type="range" min="0.5" max="8" step="0.1" value={riskBudget} onChange={(event) => setRiskBudget(Number(event.target.value))} />
                  <div className="loss-card"><span>对组合的估算影响</span><strong>-{maxLoss}%</strong><small>{selected.position}% 仓位 × {riskBudget.toFixed(1)}% 下行</small></div>
                  <p className="risk-note">新增仓位先经过 gross exposure 硬约束，再结合净敞口、期权 Delta、汇率与板块相关性评估；达到 150% 时不生成增仓计划。</p>
                  <button type="button" className="primary-action" onClick={() => setActiveTab("plan")}>形成交易计划 <span>→</span></button>
                </div>
              )}

              {activeTab === "plan" && (
                <div className="plan-view">
                  <div className="plan-status"><span className={planReady ? "ready" : "draft"}>{planReady ? "计划已锁定" : "草案 · 待确认"}</span><small>{selected.symbol}</small></div>
                  <div className="plan-row"><span>如果</span><strong>{selected.trigger}</strong></div>
                  <div className="plan-row"><span>那么</span><strong>{selected.action}</strong></div>
                  <div className="plan-row danger"><span>失效</span><strong>{selected.invalidation}</strong></div>
                  <div className="manual-check"><i aria-hidden="true">✓</i><span><strong>不生成真实订单</strong><small>最终执行回到长桥，由你手动确认</small></span></div>
                  <button type="button" className={planReady ? "primary-action confirmed" : "primary-action"} onClick={() => setPlanReady((value) => !value)}>{planReady ? "取消锁定" : "锁定为观察计划"}<span>{planReady ? "×" : "✓"}</span></button>
                </div>
              )}
            </div>
          </aside>
        </section>

        <section className="technical-section" id="technical" aria-labelledby="technical-title">
          <div className="section-heading">
            <div><p className="eyebrow">Open evidence stack</p><h2 id="technical-title">证据先汇合，指标不设唯一答案。</h2></div>
            <p>Agent 根据标的、周期和事件动态选择有解释力的证据。筹码、量价、相对强弱、AVWAP、期权与板块联动可以互相确认或否定；EMA 和 Fibonacci 只是可选工具，不是固定结论模板。</p>
          </div>

          <div className="evidence-layout">
            <article className="evidence-panel panel" aria-labelledby="evidence-title">
              <div className="panel-title">
                <div><span>EVIDENCE MATRIX · {selected.symbol} · DYNAMIC</span><h3 id="evidence-title">开放技术证据栈</h3></div>
                <span className="structure-pill mixed">6 项有效 · 1 项冲突</span>
              </div>
              <div className="evidence-list">
                {evidenceStack.map((evidence, index) => (
                  <div className="evidence-row" key={evidence.label}>
                    <span className="evidence-index">{String(index + 1).padStart(2, "0")}</span>
                    <div><strong>{evidence.label}</strong><small>{evidence.detail}</small></div>
                    <span className={`evidence-state ${evidence.tone}`}>{evidence.status}</span>
                  </div>
                ))}
              </div>
            </article>

            <article className="synthesis-panel panel" aria-labelledby="synthesis-title">
              <div className="panel-title"><div><span>AGENT SYNTHESIS</span><h3 id="synthesis-title">证据如何形成判断</h3></div><span className="prototype-label">非固定权重</span></div>
              <div className="synthesis-body">
                <div className="synthesis-score"><span>当前证据质量</span><strong>74<small>/100</small></strong><p>方向证据一致，但事件溢价与期权成本降低了追价赔率。</p></div>
                <div className="evidence-buckets">
                  <div><span>主导证据</span><strong>筹码承接 · 相对强弱 · 板块扩散</strong></div>
                  <div><span>反方证据</span><strong>短端 IV 偏高 · 上方供应仍在</strong></div>
                  <div><span>暂不采用</span><strong>单一 EMA 穿越 · 未确认的 Fib 锚点</strong></div>
                </div>
                <div className="method-note"><span>方法边界</span><p>每次分析都保存实际采用的数据、指标、参数、锚点与时间戳。后续复盘按“当时用了什么”检验，而不是事后套用另一套指标解释结果。</p></div>
              </div>
            </article>
          </div>
        </section>

        <section className="portfolio-section" id="portfolio" aria-labelledby="portfolio-title">
          <div className="section-heading">
            <div><p className="eyebrow">Longbridge portfolio truth</p><h2 id="portfolio-title">先看组合，再看单只股票。</h2></div>
            <p>长桥作为账户事实源：真实持仓、历史订单和逐笔成交只读导入。Agent 先检查组合 gross exposure，再讨论任何单只标的的新增仓位。</p>
          </div>

          <div className="portfolio-grid">
            <article className="positions panel">
              <div className="panel-title"><div><span>POSITIONS · CORE HOLDINGS EXCERPT</span><h3>长桥仓位字段演示</h3></div><span className="sync-state pending"><i />接口待连接</span></div>
              <div className="account-strip" aria-label="长桥账户摘要演示">
                <div><span>账户净资产 · USD</span><strong>$1,248,620</strong></div>
                <div><span>可用现金</span><strong>$387,072</strong></div>
                <div><span>Gross Exposure</span><strong className="warning-text">136%</strong></div>
                <div><span>Net Exposure</span><strong>92%</strong></div>
              </div>
              <div className="positions-table">
                <table>
                  <caption className="sr-only">长桥核心持仓字段演示，当前仅列出部分持仓</caption>
                  <thead><tr><th scope="col">标的</th><th scope="col">数量 / 可卖</th><th scope="col">平均成本</th><th scope="col">市值</th><th scope="col">权重</th><th scope="col">浮动盈亏</th><th scope="col">Stage</th><th scope="col">Agent 动作</th></tr></thead>
                  <tbody>
                    {instruments.map((instrument) => (
                      <tr key={instrument.symbol} className={selected.symbol === instrument.symbol ? "active" : ""}>
                        <td><button type="button" className="position-select" onClick={() => selectInstrument(instrument.symbol)} aria-pressed={selected.symbol === instrument.symbol}><strong>{instrument.symbol}</strong><small>{instrument.name}</small></button></td>
                        <td>{instrument.quantity} / {instrument.available}</td>
                        <td>${instrument.avgCost.toFixed(2)}</td>
                        <td>{instrument.marketValue}</td>
                        <td>{instrument.position}%</td>
                        <td className="positive">{instrument.pnl}</td>
                        <td>{instrument.stage}</td>
                        <td>{instrument.verdict}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="cash-row"><span>当前仅展示 27% 核心持仓；其他现货、期权与对冲未展开</span><strong>现金 31.0%</strong><small>统一折算 USD</small></div>
            </article>

            <article className="exposure panel" aria-labelledby="exposure-title">
              <div className="panel-title"><div><span>RISK MAP</span><h3 id="exposure-title">组合暴露</h3></div><span className="risk-level">中性偏高</span></div>
              <div className="exposure-list">
                {exposures.map((exposure) => (
                  <div key={exposure.label}>
                    <span>{exposure.label}</span><strong>{exposure.value}%</strong>
                    <i><b className={exposure.tone} style={{ width: `${exposure.value}%` }} /></i>
                  </div>
                ))}
              </div>
              <div className="gross-policy" aria-label="组合总暴露限制">
                <div className="gross-summary"><span>Gross Exposure · 120% 预警 / 150% 硬上限</span><strong>136%</strong><small>14% 可用空间</small></div>
                <div className="gross-track"><i className="gross-fill" /><i className="gross-warning" /><span className="warning-mark">120</span><span className="limit-mark">150</span></div>
                <div className="gross-legend"><span><i className="safe-dot" />0–120% 正常</span><span><i className="warn-dot" />120–150% 预警</span></div>
              </div>
              <div className="risk-callout"><span>组合约束已触发</span><strong>Gross 已超过 120% 预警线</strong><p>新增风险必须说明资金来源和风险释放路径；达到 150% 时，Agent 只允许减仓、替换或对冲方案。</p></div>
            </article>
          </div>

          <article className="orders-panel panel" aria-labelledby="orders-title">
            <div className="panel-title">
              <div><span>LONG BRIDGE · READ-ONLY IMPORT</span><h3 id="orders-title">历史订单与逐笔成交</h3></div>
              <span className="readonly-pill"><i />只读同步</span>
            </div>
            <div className="orders-summary">
              <div><span>导入范围</span><strong>财报前 21 天 → 财报后 20 天</strong></div>
              <div><span>归因单元</span><strong>股票 × 财报季度 × 决策包</strong></div>
              <div><span>写操作</span><strong>永久关闭</strong></div>
            </div>
            <div className="orders-table">
              <table>
                <caption className="sr-only">长桥历史成交只读导入演示</caption>
                <thead><tr><th scope="col">成交时间</th><th scope="col">标的</th><th scope="col">方向</th><th scope="col">数量</th><th scope="col">成交均价</th><th scope="col">复盘角色</th><th scope="col">案例归因</th></tr></thead>
                <tbody>
                  {orderHistory.map((order) => (
                    <tr key={`${order.time}-${order.symbol}`}>
                      <td>{order.time}</td><td><strong>{order.symbol}</strong></td><td>{order.side}</td><td>{order.quantity}</td><td>{order.average}</td><td>{order.role}</td><td><span className={order.state === "已匹配" ? "match-state matched" : "match-state"}>{order.state}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="orders-note"><strong>事实与解释分离</strong><p>订单号、成交号、数量、价格、费用和时间来自长桥，只读保留；Agent 只能建议它属于哪一个财报决策包，最终关联由你确认。</p></div>
          </article>
        </section>

        <section className="review-section" id="review" aria-labelledby="review-title">
          <div className="section-heading">
            <div><p className="eyebrow">Decision learning loop</p><h2 id="review-title">复盘不是结案，是下一条规则的起点。</h2></div>
            <p>保留财报前的原始判断，用长桥真实成交还原执行，再用固定观察窗口测试赔率、胜率和尾部风险。Agent 可以提出规律，但不能替你批准规律。</p>
          </div>

          <div className="review-flow" aria-label="复盘到规则的工作流">
            {reviewStages.map((stage, index) => (
              <button key={stage.key} type="button" className={reviewStage === stage.key ? "review-step active" : "review-step"} onClick={() => setReviewStage(stage.key)} aria-pressed={reviewStage === stage.key}>
                <span>{stage.index}</span><strong>{stage.label}</strong><small>{stage.eyebrow}</small>{index < reviewStages.length - 1 && <i aria-hidden="true">→</i>}
              </button>
            ))}
          </div>

          <div className="review-workspace">
            <article className="case-panel panel" aria-labelledby="case-title">
              <div className="panel-title"><div><span>EARNINGS CASE · NVDA FY26 Q2</span><h3 id="case-title">财报决策包</h3></div><span className="case-status">EX-ANTE 已封存</span></div>
              <div className="case-timeline" aria-label="财报案例时间线">
                <div className="done"><span>T−21</span><strong>案例建立</strong><small>市场预期 / 初始仓位</small></div>
                <div className="done"><span>T−3</span><strong>计划封存</strong><small>情景概率 / 1R / 失效位</small></div>
                <div className="current"><span>T+1</span><strong>成交归因</strong><small>订单 / 逐笔成交 / 费用</small></div>
                <div><span>T+5</span><strong>主窗口</strong><small>净 R / MAE / MFE</small></div>
                <div><span>T+20</span><strong>Review</strong><small>规则候选 / 反例</small></div>
              </div>
              <div className="case-comparison">
                <div><span>财报前判断</span><strong>主升叙事延续，但预期拥挤</strong><p>Base 50% · Bull 30% · Bear 20%<br />计划：核心仓不动，战术仓不超过 2.0%</p></div>
                <div><span>真实执行</span><strong>净增 100 股 + QQQ 保护</strong><p>3 笔成交已导入，2 笔自动匹配；对冲成交等待人工确认。</p></div>
              </div>
            </article>

            <aside className="review-detail panel" aria-live="polite">
              <div className="review-detail-head"><span>{activeReview.index} · {activeReview.eyebrow}</span><strong>{activeReview.title}</strong><p>{activeReview.copy}</p></div>
              <div className="review-metrics">
                <div><span>净结果</span><strong className="positive">+1.34R</strong><small>已计手续费与对冲成本</small></div>
                <div><span>最大不利波动</span><strong>−0.42R</strong><small>MAE · T+1 至 T+5</small></div>
                <div><span>最大有利波动</span><strong>+1.91R</strong><small>MFE · 兑现效率 70%</small></div>
                <div><span>相对基准</span><strong className="positive">+0.78R</strong><small>相对 QQQ</small></div>
              </div>
              <div className="rule-candidate">
                <span>候选规则 · 仅测试中</span>
                <strong>高预期财报前，不因单一突破增加核心仓</strong>
                <p>当前样本 8 / 目标 30。需继续跨股票、跨市场环境验证；暂不进入交易前硬约束。</p>
                <div><span>HYPOTHESIS</span><i><b /></i><span>VALIDATED</span></div>
              </div>
              <button type="button" className="review-action">打开完整 Review <span>↗</span></button>
            </aside>
          </div>

          <div className="review-principles">
            <article><span>01</span><strong>先看决策质量</strong><p>盈利不自动证明判断正确，亏损也不自动证明过程错误。</p></article>
            <article><span>02</span><strong>固定评价窗口</strong><p>主窗口事前选择，T+1 / T+5 / T+20 不允许事后挑最好看的结果。</p></article>
            <article><span>03</span><strong>记录未交易信号</strong><p>符合条件但没有下单的案例同样进入样本，避免幸存者偏差。</p></article>
            <article><span>04</span><strong>规则必须可停用</strong><p>市场环境改变或样本失效时，规则自动降级并等待人工 Review。</p></article>
          </div>
        </section>

        <section className="architecture-section" id="architecture" aria-labelledby="architecture-title">
          <div className="section-heading compact">
            <div><p className="eyebrow">System architecture</p><h2 id="architecture-title">每一层，只负责一种真相。</h2></div>
            <p>图表、账户、分析和执行分层，避免 Agent 把视觉印象当成持仓事实，也避免自动化越过你的确认。</p>
          </div>
          <div className="architecture-flow">
            <article><span>01</span><i className="arch-icon chart" aria-hidden="true" /><h3>TradingView</h3><p>版面、画线、指标与告警</p><strong>图表真相</strong></article>
            <div className="connector"><span>Webhook / 截图</span></div>
            <article><span>02</span><i className="arch-icon bars" aria-hidden="true" /><h3>长桥</h3><p>行情、真实持仓、历史订单与逐笔成交的只读同步</p><strong>账户与执行真相</strong></article>
            <div className="connector"><span>只读 API</span></div>
            <article className="agent-node"><span>03</span><i className="arch-icon orbit" aria-hidden="true">AI</i><h3>交易 Agent</h3><p>开放证据栈、叙事 Stage、组合风险与复盘规则</p><strong>分析与学习</strong></article>
            <div className="connector"><span>条件化计划</span></div>
            <article><span>04</span><i className="arch-icon check" aria-hidden="true">✓</i><h3>手动确认</h3><p>回到长桥检查并执行</p><strong>执行真相</strong></article>
          </div>
          <div className="safety-banner"><span className="lock" aria-hidden="true"><i /></span><div><strong>真实交易写操作默认关闭</strong><p>Agent 可以读取、计算、解释和生成拟执行卡，但不能提交、修改或取消真实订单。</p></div><span>READ ONLY</span></div>
        </section>
      </main>

      <footer>
        <div className="footer-brand"><span className="brand-mark small" aria-hidden="true"><i /><i /></span><strong>交易驾驶舱</strong></div>
        <p>当前页面为产品原型，所有行情、持仓与盈亏均为演示数据，不构成投资建议。</p>
        <a href="#top">回到顶部 ↑</a>
      </footer>
    </div>
  );
}
