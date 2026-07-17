"use client";

import { useMemo, useState } from "react";
import type { CSSProperties } from "react";

type AgentTab = "agent" | "risk" | "plan";
type FibMode = "up" | "down";
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
  { label: "AI / 半导体", value: 28, tone: "cobalt" },
  { label: "平台科技", value: 19, tone: "sage" },
  { label: "消费硬件", value: 11, tone: "amber" },
  { label: "现金", value: 31, tone: "neutral" },
  { label: "其他策略", value: 11, tone: "other" },
];

const timeframes = ["15m", "1H", "4H", "1D", "1W"];
const fibRatios = [
  { ratio: 0.382, role: "浅回撤 / 早期确认" },
  { ratio: 0.618, role: "黄金决策位" },
  { ratio: 1, role: "等幅目标" },
  { ratio: 1.618, role: "扩展目标 / 减仓风险" },
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
  const [fibMode, setFibMode] = useState<FibMode>("up");

  const selected = useMemo(
    () => instruments.find((instrument) => instrument.symbol === selectedSymbol) ?? instruments[0],
    [selectedSymbol],
  );

  const maxLoss = ((selected.position * riskBudget) / 100).toFixed(2);
  const emaStructure = getEmaStructure(selected);
  const fibLevels = useMemo(() => {
    const range = selected.fibHigh - selected.fibLow;
    return fibRatios.map((item) => ({
      ...item,
      value: fibMode === "up"
        ? selected.fibC + range * item.ratio
        : selected.fibC - range * item.ratio,
    }));
  }, [fibMode, selected]);
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
          <a href="#technical">技术引擎</a>
          <a href="#portfolio">仓位</a>
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
            你继续用 TradingView 观察市场；长桥提供行情与真实仓位；Agent 把两者合并成风险分析和有条件的交易计划。
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
            <div><small>机器数据层</small><strong>长桥行情 / 仓位 / 订单</strong></div>
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
            <strong>风险分析 · 交易计划</strong>
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
                    <div><span>3/5/8/13/21</span><strong className={emaStructure.shortTone}>{emaStructure.shortLabel}</strong></div>
                    <div><span>144 / 169</span><strong className={emaStructure.longTone}>{emaStructure.longLabel}</strong></div>
                  </div>
                  <dl>
                    <div><dt>当前位置</dt><dd>{selected.position}% 组合权重</dd></div>
                    <div><dt>关注区域</dt><dd>{selected.zone}</dd></div>
                    <div><dt>结构失效</dt><dd>{selected.invalidation}</dd></div>
                  </dl>
                  <button type="button" className="primary-action" onClick={() => setActiveTab("risk")}>查看组合风险 <span>→</span></button>
                </div>
              )}

              {activeTab === "risk" && (
                <div className="risk-view">
                  <div className="risk-score"><span>风险预算使用 · 演示策略上限 12%（可配置）</span><strong>{Math.round((selected.position / 12) * 100)}%</strong><i><b style={{ width: `${Math.min(100, (selected.position / 12) * 100)}%` }} /></i></div>
                  <label htmlFor="risk-budget">标的下行假设 <strong>{riskBudget.toFixed(1)}%</strong></label>
                  <input id="risk-budget" type="range" min="0.5" max="8" step="0.1" value={riskBudget} onChange={(event) => setRiskBudget(Number(event.target.value))} />
                  <div className="loss-card"><span>对组合的估算影响</span><strong>-{maxLoss}%</strong><small>{selected.position}% 仓位 × {riskBudget.toFixed(1)}% 下行</small></div>
                  <p className="risk-note">简化估算未计期权、汇率与板块相关性。完整风险由长桥持仓快照重新计算。</p>
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
            <div><p className="eyebrow">Technical structure engine</p><h2 id="technical-title">快线管时点，慢线管周期。</h2></div>
            <p>Agent 用 3/5/8/13/21 EMA 判断趋势温度与入场时点，用 144/169 EMA 管理长周期核心仓，再用 Fibonacci 扩展定义决策区和目标区。</p>
          </div>

          <div className="technical-grid">
            <article className="fib-engine panel" aria-labelledby="fib-title">
              <div className="panel-title">
                <div><span>FIBONACCI MAP · {selected.symbol} · 1D DEMO</span><h3 id="fib-title">三点扩展决策位</h3></div>
                <div className="fib-mode" aria-label="斐波那契计算方向">
                  <button type="button" className={fibMode === "up" ? "active" : ""} onClick={() => setFibMode("up")} aria-pressed={fibMode === "up"}>向上扩展</button>
                  <button type="button" className={fibMode === "down" ? "active" : ""} onClick={() => setFibMode("down")} aria-pressed={fibMode === "down"}>向下扩展</button>
                </div>
              </div>

              <div className="swing-basis">
                <div><span>锚点 A · 起点</span><strong>{selected.fibLow.toFixed(2)}</strong></div>
                <i aria-hidden="true"><b /></i>
                <div><span>锚点 B · 脉冲终点</span><strong>{selected.fibHigh.toFixed(2)}</strong></div>
                <i aria-hidden="true"><b /></i>
                <div><span>锚点 C · 回撤确认</span><strong>{selected.fibC.toFixed(2)}</strong></div>
              </div>

              <div className="fib-levels">
                {fibLevels.map((level) => (
                  <div className={`fib-level ratio-${String(level.ratio).replace(".", "-")}`} key={level.ratio}>
                    <span className="fib-ratio">{level.ratio.toFixed(level.ratio === 1 ? 1 : 3)}</span>
                    <i aria-hidden="true"><b /></i>
                    <strong>{level.value.toFixed(2)}</strong>
                    <small>{level.role}</small>
                  </div>
                ))}
              </div>

              <div className="fib-judgement">
                <span>Agent 判断</span>
                <p>公式为 <strong>C ± (B − A) × 比率</strong>。<strong>0.382 / 0.618</strong> 用来观察早期反应；<strong>1.0</strong> 是等幅完成位；<strong>1.618</strong> 进入扩展与分批兑现风险区。</p>
              </div>
            </article>

            <article className="ema-engine panel" aria-labelledby="ema-title">
              <div className="panel-title">
                <div><span>EMA ARCHITECTURE · {selected.symbol}</span><h3 id="ema-title">双层均线结构</h3></div>
                <span className={`structure-pill ${emaStructure.shortTone}`}>{emaStructure.shortLabel}</span>
              </div>

              <div className="ema-group">
                <div className="ema-group-head"><div><span>交易时点层</span><strong>EMA 3 / 5 / 8 / 13 / 21</strong></div><small>{emaStructure.shortAction}</small></div>
                <div className="ema-ribbon" aria-label={`${selected.symbol} 短周期 EMA 数值`}>
                  {([3, 5, 8, 13, 21] as EmaPeriod[]).map((period, index) => (
                    <div key={period} style={{ "--ema-index": index } as CSSProperties}>
                      <span>EMA {period}</span><strong>{selected.ema[period].toFixed(2)}</strong>
                    </div>
                  ))}
                </div>
                <div className="ema-observations">
                  <div><span>排序</span><strong>{emaStructure.shortLabel}</strong></div>
                  <div><span>斜率 / 扩散</span><strong>{selected.shortSlope}</strong></div>
                  <div><span>结构事件</span><strong>{selected.emaEvent}</strong></div>
                </div>
                <div className="ema-rule"><span>完整多头</span><code>价格 &gt; 3 &gt; 5 &gt; 8 &gt; 13 &gt; 21</code><span>完整空头</span><code>价格 &lt; 3 &lt; 5 &lt; 8 &lt; 13 &lt; 21</code></div>
              </div>

              <div className="ema-group long-cycle">
                <div className="ema-group-head"><div><span>长周期仓位层</span><strong>EMA 144 / 169</strong></div><small>{emaStructure.longAction}</small></div>
                <div className="long-ema-map">
                  <div><span>现价</span><strong>{selected.price}</strong></div>
                  <i aria-hidden="true"><b /></i>
                  <div><span>EMA 144</span><strong>{selected.ema[144].toFixed(2)}</strong></div>
                  <i aria-hidden="true"><b /></i>
                  <div><span>EMA 169</span><strong>{selected.ema[169].toFixed(2)}</strong></div>
                </div>
                <div className={`long-verdict ${emaStructure.longTone}`}><span>{emaStructure.longLabel}</span><p>短周期信号决定“何时动”，144/169 决定“核心仓是否还值得留在场内”。</p></div>
                <p className="long-slope">斜率观察：{selected.longSlope}</p>
              </div>
            </article>
          </div>
        </section>

        <section className="portfolio-section" id="portfolio" aria-labelledby="portfolio-title">
          <div className="section-heading">
            <div><p className="eyebrow">Longbridge portfolio truth</p><h2 id="portfolio-title">先看组合，再看单只股票。</h2></div>
            <p>Agent 不仅判断图形，还把标的放回真实仓位、板块重复暴露与组合风险预算里。</p>
          </div>

          <div className="portfolio-grid">
            <article className="positions panel">
              <div className="panel-title"><div><span>POSITIONS · CORE HOLDINGS EXCERPT</span><h3>长桥仓位字段演示</h3></div><span className="sync-state pending"><i />接口待连接</span></div>
              <div className="account-strip" aria-label="长桥账户摘要演示">
                <div><span>账户净资产 · USD</span><strong>$1,248,620</strong></div>
                <div><span>可用现金</span><strong>$387,072</strong></div>
                <div><span>购买力</span><strong>$421,380</strong></div>
                <div><span>冻结资金</span><strong>$0</strong></div>
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
              <div className="cash-row"><span>当前仅展示 27% 核心持仓；其他持仓 42% 未展开</span><strong>现金 31.0%</strong><small>真实值以长桥回传为准</small></div>
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
              <div className="risk-callout"><span>集中度提醒</span><strong>AI / 半导体为最大重复暴露</strong><p>增加 NVDA 或 AVGO 前，先按板块合并计算风险。</p></div>
            </article>
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
            <article><span>02</span><i className="arch-icon bars" aria-hidden="true" /><h3>长桥</h3><p>Quote / OHLCV / 盘口 / 期权链；资产、持仓、成本与订单</p><strong>行情与账户真相</strong></article>
            <div className="connector"><span>只读 API</span></div>
            <article className="agent-node"><span>03</span><i className="arch-icon orbit" aria-hidden="true">AI</i><h3>交易 Agent</h3><p>Fib、EMA、Stage、技术温度与组合风险</p><strong>分析真相</strong></article>
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
