const DEFAULT_SIZING_MAX_AGE_MS = 2 * 60 * 1000;
const SESSION_FINALIZATION_BUFFER_MINUTES = 5;

const MARKET_SESSION = Object.freeze({
  US: { timeZone: "America/New_York", closeMinute: 16 * 60 },
  HK: { timeZone: "Asia/Hong_Kong", closeMinute: 16 * 60 },
  CN: { timeZone: "Asia/Shanghai", closeMinute: 15 * 60 },
  SH: { timeZone: "Asia/Shanghai", closeMinute: 15 * 60 },
  SZ: { timeZone: "Asia/Shanghai", closeMinute: 15 * 60 },
  SG: { timeZone: "Asia/Singapore", closeMinute: 17 * 60 },
});

/**
 * Convert candle provenance into explicit research/decision/sizing gates.
 * A cached official data set may still support research, but only a current,
 * live-lineage data set can support executable sizing.
 */
export function assessDailyCandleEvidence({
  coverage,
  technical,
  symbol,
  analysisTime = new Date().toISOString(),
  sizingMaxAgeMs = DEFAULT_SIZING_MAX_AGE_MS,
} = {}) {
  if (!coverage || typeof coverage !== "object") return null;
  const market = marketFromSymbol(symbol, technical?.lastBar?.market);
  const expectedLatestTradeDate = expectedLastCompletedTradingDate({
    market,
    analysisTime,
  });
  const latestTradeDate = validDateString(
    coverage.latestTradeDate ?? technical?.asOfTradingDate,
  );
  const source = String(coverage.source ?? "unknown");
  const originSource = String(coverage.originSource ?? "");
  const partialReasons = Array.isArray(coverage.partialReasons)
    ? coverage.partialReasons.map(String)
    : [];
  const blockingReasons = partialReasons.filter((reason) => ![
    "insufficient_history",
    "persistence_failed",
    "persistence_unavailable",
  ].includes(reason));
  const currentTradingDate = Boolean(
    latestTradeDate
    && expectedLatestTradeDate
    && latestTradeDate === expectedLatestTradeDate,
  );
  const closedDailyBar = technical?.lastBar?.status === "CLOSED"
    && technical?.timeframe === "1D";
  const fallback = source === "persistent_fallback";
  const liveLineage = source === "live"
    || (source === "memory" && originSource === "live");
  const cacheAgeMs = finiteOrNull(coverage.cacheAgeMs);
  const researchReady = closedDailyBar && Boolean(latestTradeDate);
  const decisionReady = researchReady
    && currentTradingDate
    && !fallback
    && blockingReasons.length === 0;
  const sizingReady = decisionReady
    && liveLineage
    && cacheAgeMs != null
    && cacheAgeMs <= Math.max(0, Number(sizingMaxAgeMs) || DEFAULT_SIZING_MAX_AGE_MS);
  const reasonCodes = [];
  if (!closedDailyBar) reasonCodes.push("no_confirmed_daily_bar");
  if (!latestTradeDate) reasonCodes.push("latest_trade_date_unknown");
  if (latestTradeDate && expectedLatestTradeDate && !currentTradingDate) {
    reasonCodes.push("latest_completed_trade_date_missing");
  }
  if (fallback) reasonCodes.push("persistent_fallback_research_only");
  if (decisionReady && !liveLineage) reasonCodes.push("non_live_lineage_no_sizing");
  if (decisionReady && liveLineage && !sizingReady) reasonCodes.push("live_evidence_expired_for_sizing");
  reasonCodes.push(...blockingReasons);

  return {
    schemaVersion: "market-evidence/v1",
    providerOfficial: Boolean(coverage.endpoint),
    coverageComplete: coverage.complete === true,
    freshForResearch: researchReady,
    freshForDecision: decisionReady,
    freshForSizing: sizingReady,
    market,
    expectedLatestTradeDate,
    latestTradeDate,
    source,
    originSource: originSource || null,
    fetchedAt: coverage.fetchedAt ?? null,
    cacheAgeMs,
    endpoint: coverage.endpoint ?? null,
    fallbackReason: coverage.fallbackReason ?? null,
    partialReasons,
    reasonCodes: [...new Set(reasonCodes)],
  };
}

export function expectedLastCompletedTradingDate({
  market = "US",
  analysisTime = new Date().toISOString(),
} = {}) {
  const session = MARKET_SESSION[market] ?? MARKET_SESSION.US;
  const instant = new Date(analysisTime);
  if (!Number.isFinite(instant.getTime())) return null;
  const parts = zonedDateParts(instant, session.timeZone);
  let date = parts.date;
  const isTradingDay = market === "US"
    ? isUsTradingDay(date)
    : isWeekday(date);
  const closeMinute = market === "US" ? usCloseMinute(date) : session.closeMinute;
  const completedToday = isTradingDay
    && parts.minuteOfDay >= closeMinute + SESSION_FINALIZATION_BUFFER_MINUTES;
  if (completedToday) return date;
  do {
    date = addDays(date, -1);
  } while (!(market === "US" ? isUsTradingDay(date) : isWeekday(date)));
  return date;
}

export function isUsTradingDay(date) {
  const normalized = validDateString(date);
  if (!normalized || !isWeekday(normalized)) return false;
  const year = Number(normalized.slice(0, 4));
  const holidays = new Set([
    ...usMarketHolidays(year - 1),
    ...usMarketHolidays(year),
    ...usMarketHolidays(year + 1),
  ]);
  return !holidays.has(normalized);
}

export function usMarketHolidays(year) {
  const values = [
    observedFixedHoliday(year, 1, 1),
    nthWeekday(year, 1, 1, 3),
    nthWeekday(year, 2, 1, 3),
    addDays(easterSunday(year), -2),
    lastWeekday(year, 5, 1),
    ...(year >= 2022 ? [observedFixedHoliday(year, 6, 19)] : []),
    observedFixedHoliday(year, 7, 4),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 11, 4, 4),
    observedFixedHoliday(year, 12, 25),
  ];
  return [...new Set(values.filter(Boolean))];
}

export function usCloseMinute(date) {
  if (!isUsTradingDay(date)) return MARKET_SESSION.US.closeMinute;
  const year = Number(date.slice(0, 4));
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  const blackFriday = addDays(thanksgiving, 1);
  const christmasEve = `${year}-12-24`;
  const independenceObserved = observedFixedHoliday(year, 7, 4);
  let priorIndependenceTradingDay = addDays(independenceObserved, -1);
  while (!isUsTradingDay(priorIndependenceTradingDay)) {
    priorIndependenceTradingDay = addDays(priorIndependenceTradingDay, -1);
  }
  return [blackFriday, christmasEve, priorIndependenceTradingDay].includes(date)
    ? 13 * 60
    : MARKET_SESSION.US.closeMinute;
}

function marketFromSymbol(symbol, fallback) {
  const explicit = String(fallback ?? "").toUpperCase();
  if (MARKET_SESSION[explicit]) return explicit;
  const suffix = String(symbol ?? "").trim().toUpperCase().split(".").at(-1);
  if (["US", "HK", "SG", "SH", "SZ", "CN"].includes(suffix)) return suffix;
  return "US";
}

function zonedDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minuteOfDay: Number(values.hour) * 60 + Number(values.minute),
  };
}

function observedFixedHoliday(year, month, day) {
  const date = formatDate(year, month, day);
  const weekday = utcDate(date).getUTCDay();
  if (weekday === 6) return addDays(date, -1);
  if (weekday === 0) return addDays(date, 1);
  return date;
}

function nthWeekday(year, month, weekday, nth) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return formatDate(year, month, 1 + offset + (nth - 1) * 7);
}

function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return formatDate(year, month, last.getUTCDate() - offset);
}

// Anonymous Gregorian algorithm; returned as YYYY-MM-DD in UTC calendar terms.
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return formatDate(year, month, day);
}

function isWeekday(date) {
  const weekday = utcDate(date).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

function addDays(date, days) {
  const value = utcDate(date);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function utcDate(date) {
  return new Date(`${date}T00:00:00.000Z`);
}

function formatDate(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function validDateString(value) {
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function finiteOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
