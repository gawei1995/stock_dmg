import { inferDailyCandleTradeDate } from "../data/normalize.mjs";

export const EMA_PERIODS = [3, 5, 8, 13, 21, 144, 169];
export const FIB_RATIOS = [0.382, 0.618, 1, 1.618];
export const EMA_MATURITY_MULTIPLIER = 3;

const DAILY_SESSION_CONFIG = {
  US: { timeZone: "America/New_York", closeMinute: 16 * 60, label: "16:00 ET" },
  HK: { timeZone: "Asia/Hong_Kong", closeMinute: 16 * 60, label: "16:00 HKT" },
  CN: { timeZone: "Asia/Shanghai", closeMinute: 15 * 60, label: "15:00 CST" },
  SH: { timeZone: "Asia/Shanghai", closeMinute: 15 * 60, label: "15:00 CST" },
  SZ: { timeZone: "Asia/Shanghai", closeMinute: 15 * 60, label: "15:00 CST" },
  SG: { timeZone: "Asia/Singapore", closeMinute: 17 * 60, label: "17:00 SGT" },
};

const SESSION_FINALIZATION_BUFFER_MINUTES = 5;

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

export function calculateTechnical(candles, options = {}) {
  const sourceCandles = Array.isArray(candles) ? candles : [];
  const inputCandles = sourceCandles.map((bar) => enrichDailyBarMetadata(bar, options));
  const lastBar = classifyLastDailyBar(inputCandles.at(-1), options);
  const completedCandles = lastBar.status === "CLOSED"
    ? inputCandles
    : inputCandles.slice(0, -1);
  const provenance = buildCalculationProvenance(inputCandles, completedCandles, lastBar);
  const provisional = buildProvisionalMetadata(inputCandles.at(-1), lastBar);

  if (!completedCandles.length) {
    return emptyTechnical({
      reason: inputCandles.length
        ? "最后一根日 K 尚未确认收盘，且没有更早的已完成 K 线"
        : "没有可用的长桥 K 线",
      candleCount: inputCandles.length,
      lastBar,
      provisional,
      provenance,
    });
  }

  const closes = completedCandles.map((bar) => Number(bar.close));
  const lastPrice = closes.at(-1);
  const ema = {};
  const emaSlope5d = {};
  const emaMaturity = {};
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
    emaMaturity[period] = describeEmaMaturity(completedCandles.length, period);
  }

  const shortValues = [lastPrice, ema[3], ema[5], ema[8], ema[13], ema[21]];
  const shortBull = isStrictDescending(shortValues);
  const shortBear = isStrictAscending(shortValues);
  const longAvailable = ema[144] != null && ema[169] != null;
  const longBull = longAvailable && lastPrice > ema[144] && ema[144] > ema[169];
  const longBear = longAvailable && lastPrice < ema[144] && ema[144] < ema[169];
  const prior20 = completedCandles.slice(-21, -1);
  const prior20Low = prior20.length
    ? Math.min(...prior20.map((bar) => Number(bar.low)))
    : null;
  const prior20High = prior20.length
    ? Math.max(...prior20.map((bar) => Number(bar.high)))
    : null;
  const allSlopesAvailable = emaSlope5d[169] != null;
  const longMature = emaMaturity[144].mature && emaMaturity[169].mature;
  const status = longAvailable && allSlopesAvailable && longMature
    ? "complete"
    : completedCandles.length >= 21
      ? "partial"
      : "degraded";
  const fib = calculateFib(completedCandles);

  return {
    status,
    reason:
      status === "complete"
        ? null
        : status === "partial"
          ? longAvailable && !longMature
            ? `EMA144/169 已可计算但预热不足；完整成熟至少需要 ${EMA_MATURITY_MULTIPLIER * 169} 根已完成日 K，当前 ${completedCandles.length} 根`
            : longAvailable
              ? "EMA144/169 可计算，但 5 日斜率尚不完整"
            : "K 线不足 169 根，短周期可判断，EMA144/169 暂不可用"
          : "K 线不足 21 根，结构只能部分判断",
    candleCount: inputCandles.length,
    calculationBarCount: completedCandles.length,
    timeframe: "1D",
    adjustType: "forward",
    tradeSession: "regular_hours",
    asOf: completedCandles.at(-1).timestamp,
    asOfTradingDate: completedCandles.at(-1).tradeDate ?? null,
    lastPrice: round(lastPrice),
    lastBar,
    provisional,
    calculation: provenance,
    emaMethod: {
      inputSource: "close",
      seed: "SMA",
      multiplier: "2 / (period + 1)",
    },
    ema,
    emaSlope5d,
    emaMaturity,
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
      fastEmaMature: emaMaturity[21].mature,
      longEmaMature: longMature,
      fib: Boolean(fib),
      officialBar: true,
      provisionalBar: provisional.available,
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
    method: "automated",
    role: "advisory",
    automated: true,
    advisory: true,
    decisionAuthority: "LLM",
    source: `自动 ${lookback} 日主波段，C 点至少经过 ${confirmBars} 根右侧 K 线确认；仅作候选，LLM 可采用、覆盖或忽略`,
  };
}

export function classifyLastDailyBar(bar, options = {}) {
  if (!bar) {
    return {
      status: "UNKNOWN",
      basis: "no_bar",
      analysisTime: normalizeAnalysisTime(options.analysisTime),
      market: resolveMarket(options, bar),
      timeZone: null,
      sessionClose: null,
      tradingDate: null,
      timestampBasis: null,
    };
  }

  const analysisTime = normalizeAnalysisTime(options.analysisTime);
  const explicit = explicitBarStatus(bar);
  const market = resolveMarket(options, bar);
  const session = DAILY_SESSION_CONFIG[market] ?? null;
  const dateMetadata = resolveDailyBarDateMetadata(bar, options);
  if (explicit) {
    return {
      status: explicit.status,
      basis: explicit.basis,
      analysisTime,
      market: market || null,
      timeZone: session?.timeZone ?? null,
      sessionClose: session?.label ?? null,
      tradingDate: dateMetadata.tradeDate,
      timestampBasis: dateMetadata.timestampBasis,
    };
  }

  const evaluatedAt = parseDate(analysisTime);
  if (!dateMetadata.tradeDate || !evaluatedAt) {
    return {
      status: "UNKNOWN",
      basis: "missing_or_invalid_time",
      analysisTime,
      market: market || null,
      timeZone: session?.timeZone ?? null,
      sessionClose: session?.label ?? null,
      tradingDate: dateMetadata.tradeDate,
      timestampBasis: dateMetadata.timestampBasis,
    };
  }

  if (session) {
    const analysisLocal = zonedParts(evaluatedAt, session.timeZone);
    const analysisDate = dateKey(analysisLocal);
    const dateComparison = dateMetadata.tradeDate.localeCompare(analysisDate);
    if (dateComparison < 0) {
      return dailyBarClassification(
        "CLOSED",
        "prior_exchange_date",
        analysisTime,
        market,
        session,
        dateMetadata,
      );
    }
    if (dateComparison > 0) {
      return dailyBarClassification(
        "UNKNOWN",
        "bar_date_after_analysis_time",
        analysisTime,
        market,
        session,
        dateMetadata,
      );
    }
    const analysisMinute = analysisLocal.hour * 60 + analysisLocal.minute;
    const finalizedMinute = session.closeMinute + SESSION_FINALIZATION_BUFFER_MINUTES;
    return dailyBarClassification(
      analysisMinute >= finalizedMinute ? "CLOSED" : "FORMING",
      analysisMinute >= finalizedMinute ? "exchange_session_finalized" : "exchange_session_open",
      analysisTime,
      market,
      session,
      dateMetadata,
    );
  }

  const analysisDate = utcDateKey(evaluatedAt);
  if (dateMetadata.tradeDate < analysisDate) {
    return {
      status: "CLOSED",
      basis: "prior_utc_date_without_market",
      analysisTime,
      market: market || null,
      timeZone: null,
      sessionClose: null,
      tradingDate: dateMetadata.tradeDate,
      timestampBasis: dateMetadata.timestampBasis,
    };
  }
  return {
    status: "UNKNOWN",
    basis: dateMetadata.tradeDate > analysisDate
      ? "bar_date_after_analysis_time"
      : "same_date_without_market_metadata",
    analysisTime,
    market: market || null,
    timeZone: null,
    sessionClose: null,
    tradingDate: dateMetadata.tradeDate,
    timestampBasis: dateMetadata.timestampBasis,
  };
}

function emptyTechnical({
  reason,
  candleCount,
  lastBar,
  provisional,
  provenance,
}) {
  const emaMaturity = Object.fromEntries(
    EMA_PERIODS.map((period) => [period, describeEmaMaturity(0, period)]),
  );
  return {
    status: "degraded",
    reason,
    candleCount,
    calculationBarCount: 0,
    timeframe: "1D",
    adjustType: "forward",
    tradeSession: "regular_hours",
    asOf: null,
    asOfTradingDate: null,
    lastPrice: null,
    lastBar,
    provisional,
    calculation: provenance,
    emaMethod: {
      inputSource: "close",
      seed: "SMA",
      multiplier: "2 / (period + 1)",
    },
    ema: {},
    emaSlope5d: {},
    emaMaturity,
    fib: null,
    range20: { priorLow: null, priorHigh: null },
    capabilities: {
      fastEma: false,
      longEma: false,
      longEmaSlope: false,
      fastEmaMature: false,
      longEmaMature: false,
      fib: false,
      officialBar: false,
      provisionalBar: provisional.available,
    },
  };
}

function describeEmaMaturity(barCount, period) {
  const requiredBarCount = period * EMA_MATURITY_MULTIPLIER;
  const available = barCount >= period;
  const mature = barCount >= requiredBarCount;
  return {
    period,
    barCount,
    seedBarCount: period,
    warmupBarCount: Math.max(0, barCount - period),
    requiredBarCount,
    requiredWarmupBarCount: period * (EMA_MATURITY_MULTIPLIER - 1),
    available,
    mature,
    status: !available ? "unavailable" : mature ? "mature" : "warming",
  };
}

function buildCalculationProvenance(inputCandles, completedCandles, lastBar) {
  return {
    inputSource: "close",
    emaSeed: "SMA",
    inputBarCount: inputCandles.length,
    completedBarCount: completedCandles.length,
    excludedBarCount: inputCandles.length - completedCandles.length,
    officialBarsOnly: true,
    latestInputBarStatus: lastBar.status,
    latestInputTradingDate: lastBar.tradingDate ?? null,
    timestampBasis: lastBar.timestampBasis ?? null,
  };
}

function buildProvisionalMetadata(bar, lastBar) {
  const available = Boolean(bar) && lastBar.status !== "CLOSED";
  return {
    available,
    status: available ? lastBar.status : null,
    excludedFromOfficial: available,
    asOf: available ? bar.timestamp ?? null : null,
    close: available && Number.isFinite(Number(bar.close)) ? round(Number(bar.close)) : null,
    basis: available ? lastBar.basis : null,
  };
}

function explicitBarStatus(bar) {
  const booleanFields = [
    ["isClosed", bar.isClosed],
    ["is_closed", bar.is_closed],
    ["closed", bar.closed],
    ["complete", bar.complete],
    ["confirmed", bar.confirmed],
    ["final", bar.final],
  ];
  for (const [field, value] of booleanFields) {
    if (typeof value === "boolean") {
      return {
        status: value ? "CLOSED" : "FORMING",
        basis: `bar_metadata.${field}`,
      };
    }
  }

  const statusFields = [
    ["barStatus", bar.barStatus],
    ["bar_status", bar.bar_status],
    ["status", bar.status],
    ["state", bar.state],
  ];
  for (const [field, value] of statusFields) {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (["closed", "complete", "completed", "final", "confirmed"].includes(normalized)) {
      return { status: "CLOSED", basis: `bar_metadata.${field}` };
    }
    if (["forming", "open", "partial", "updating", "realtime", "live"].includes(normalized)) {
      return { status: "FORMING", basis: `bar_metadata.${field}` };
    }
  }
  return null;
}

function resolveMarket(options, bar) {
  const explicit = String(options.market ?? bar?.market ?? "").trim().toUpperCase();
  if (explicit) return explicit === "CN" ? "CN" : explicit;
  const symbol = String(options.symbol ?? bar?.symbol ?? "").trim().toUpperCase();
  const suffix = symbol.includes(".") ? symbol.split(".").at(-1) : "";
  return suffix === "CN" ? "CN" : suffix;
}

function enrichDailyBarMetadata(bar, options) {
  const metadata = resolveDailyBarDateMetadata(bar, options);
  return {
    ...bar,
    tradeDate: metadata.tradeDate,
    timestampBasis: metadata.timestampBasis,
    market: resolveMarket(options, bar) || bar?.market || null,
  };
}

function resolveDailyBarDateMetadata(bar, options) {
  return inferDailyCandleTradeDate({
    timestamp: bar?.timestamp,
    tradeDate: bar?.tradeDate ?? bar?.trade_date,
    timestampBasis: bar?.timestampBasis ?? bar?.timestamp_basis,
    market: resolveMarket(options, bar),
    symbol: options.symbol ?? bar?.symbol,
  });
}

function normalizeAnalysisTime(value) {
  const date = value == null ? new Date() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

function utcDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function dateKey(parts) {
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function dailyBarClassification(
  status,
  basis,
  analysisTime,
  market,
  session,
  dateMetadata,
) {
  return {
    status,
    basis,
    analysisTime,
    market,
    timeZone: session.timeZone,
    sessionClose: session.label,
    tradingDate: dateMetadata.tradeDate,
    timestampBasis: dateMetadata.timestampBasis,
  };
}

function point(bar, field) {
  return {
    price: round(Number(bar[field])),
    date: bar.tradeDate ?? String(bar.timestamp).slice(0, 10),
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
