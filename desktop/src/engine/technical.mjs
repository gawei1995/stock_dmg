export const EMA_PERIODS = [3, 5, 8, 13, 21, 144, 169];
export const FIB_RATIOS = [0.382, 0.618, 1, 1.618];

export function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const multiplier = 2 / (period + 1);
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const result = Array(period - 1).fill(null);
  let previous = seed;
  result.push(seed);
  for (let index = period; index < values.length; index += 1) {
    previous = (values[index] - previous) * multiplier + previous;
    result.push(previous);
  }
  return result;
}

export function calculateTechnical(candles) {
  if (!candles?.length) {
    return {
      status: "degraded",
      reason: "没有可用的长桥 K 线",
      candleCount: 0,
      ema: {},
      emaSlope5d: {},
      fib: null,
      range20: { priorLow: null, priorHigh: null },
      capabilities: {
        fastEma: false,
        longEma: false,
        longEmaSlope: false,
        fib: false,
      },
    };
  }

  const closes = candles.map((bar) => Number(bar.close));
  const lastPrice = closes.at(-1);
  const ema = {};
  const emaSlope5d = {};
  const seriesByPeriod = {};

  for (const period of EMA_PERIODS) {
    const series = emaSeries(closes, period);
    seriesByPeriod[period] = series;
    const current = series.at(-1);
    const past = series.at(-6);
    ema[period] = Number.isFinite(current) ? round(current) : null;
    emaSlope5d[period] =
      Number.isFinite(current) && Number.isFinite(past) && past !== 0
        ? round(((current - past) / past) * 100)
        : null;
  }

  const shortValues = [lastPrice, ema[3], ema[5], ema[8], ema[13], ema[21]];
  const shortBull = isStrictDescending(shortValues);
  const shortBear = isStrictAscending(shortValues);
  const longAvailable = ema[144] != null && ema[169] != null;
  const longBull = longAvailable && lastPrice > ema[144] && ema[144] > ema[169];
  const longBear = longAvailable && lastPrice < ema[144] && ema[144] < ema[169];
  const prior20 = candles.slice(-21, -1);
  const prior20Low = prior20.length
    ? Math.min(...prior20.map((bar) => Number(bar.low)))
    : null;
  const prior20High = prior20.length
    ? Math.max(...prior20.map((bar) => Number(bar.high)))
    : null;
  const allSlopesAvailable = emaSlope5d[169] != null;
  const status = longAvailable && allSlopesAvailable
    ? "complete"
    : candles.length >= 21
      ? "partial"
      : "degraded";
  const fib = calculateFib(candles);

  return {
    status,
    reason:
      status === "complete"
        ? null
        : status === "partial"
          ? longAvailable
            ? "K 线不足 174 根，EMA144/169 可计算但 5 日斜率尚不完整"
            : "K 线不足 169 根，短周期可判断，EMA144/169 暂不可用"
          : "K 线不足 21 根，结构只能部分判断",
    candleCount: candles.length,
    timeframe: "1D",
    adjustType: "forward",
    tradeSession: "intraday",
    asOf: candles.at(-1).timestamp,
    lastPrice: round(lastPrice),
    ema,
    emaSlope5d,
    shortStructure: shortBull ? "完整多头" : shortBear ? "完整空头" : "交错 / 过渡",
    longStructure: !longAvailable
      ? "数据不足"
      : longBull
        ? "长周期多头"
        : longBear
          ? "长周期空头"
          : "长周期转换",
    range20: {
      priorLow: Number.isFinite(prior20Low) ? round(prior20Low) : null,
      priorHigh: Number.isFinite(prior20High) ? round(prior20High) : null,
    },
    fib,
    capabilities: {
      fastEma: ema[21] != null,
      longEma: longAvailable,
      longEmaSlope: allSlopesAvailable,
      fib: Boolean(fib),
    },
  };
}

export function calculateFib(candles, lookback = 180, confirmBars = 3) {
  if (!candles?.length) return null;
  const bars = candles.slice(-lookback);
  if (bars.length < 21) return null;

  let highIndex = 0;
  let lowIndex = 0;
  for (let index = 1; index < bars.length; index += 1) {
    if (bars[index].high > bars[highIndex].high) highIndex = index;
    if (bars[index].low < bars[lowIndex].low) lowIndex = index;
  }

  const direction = lowIndex < highIndex ? "up" : "down";
  let a;
  let b;
  let c;
  if (direction === "up") {
    a = point(bars[lowIndex], "low");
    b = point(bars[highIndex], "high");
    const after = bars.slice(highIndex + 1, bars.length - confirmBars);
    if (!after.length) return null;
    const cBar = after.reduce((lowest, bar) => (bar.low < lowest.low ? bar : lowest));
    c = point(cBar, "low");
    if (!(a.price < c.price && c.price < b.price)) return null;
  } else {
    a = point(bars[highIndex], "high");
    b = point(bars[lowIndex], "low");
    const after = bars.slice(lowIndex + 1, bars.length - confirmBars);
    if (!after.length) return null;
    const cBar = after.reduce((highest, bar) => (bar.high > highest.high ? bar : highest));
    c = point(cBar, "high");
    if (!(a.price > c.price && c.price > b.price)) return null;
  }

  const levels = {};
  for (const ratio of FIB_RATIOS) {
    levels[String(ratio)] = round(c.price + (b.price - a.price) * ratio);
  }

  return {
    direction,
    anchors: { a, b, c },
    levels,
    formula: "C + (B - A) × ratio",
    source: `自动 ${lookback} 日主波段，C 点至少经过 ${confirmBars} 根右侧 K 线确认；可在后续版本手工修正`,
  };
}

function point(bar, field) {
  return {
    price: round(Number(bar[field])),
    date: String(bar.timestamp).slice(0, 10),
  };
}

function isStrictDescending(values) {
  return values.every(
    (value, index) => Number.isFinite(value) && (index === 0 || values[index - 1] > value),
  );
}

function isStrictAscending(values) {
  return values.every(
    (value, index) => Number.isFinite(value) && (index === 0 || values[index - 1] < value),
  );
}

export function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
