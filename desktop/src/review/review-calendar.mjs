const DEFAULT_REVIEW_TIMEZONE = "America/New_York";
const ALLOWED_REVIEW_TIMEZONES = new Set([
  "America/New_York",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Singapore",
]);

/** A calendar interval, never a substitute for an unknown event timestamp. */
export function reviewDayRange(value, timezone = DEFAULT_REVIEW_TIMEZONE) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("事件日期无效。");
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new Error("事件日期无效。");
  const timeZone = String(timezone ?? DEFAULT_REVIEW_TIMEZONE).trim();
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(date); } catch { throw new Error("事件时区无效。"); }
  const next = new Date(date.getTime() + 86_400_000);
  const startMs = zonedLocalMidnightUtc({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), timeZone });
  const nextMs = zonedLocalMidnightUtc({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), timeZone });
  return { date: text, timezone: timeZone, startAt: new Date(startMs).toISOString(), endAt: new Date(nextMs - 1).toISOString() };
}

export function reviewMonthRange(value, timezone = DEFAULT_REVIEW_TIMEZONE) {
  const { year, month, normalized } = parseMonth(value);
  const timeZone = normalizeReviewTimezone(timezone);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const startMs = zonedLocalMidnightUtc({ year, month, day: 1, timeZone });
  const nextMs = zonedLocalMidnightUtc({
    year: nextYear,
    month: nextMonth,
    day: 1,
    timeZone,
  });
  return {
    month: normalized,
    timezone: timeZone,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(nextMs - 1).toISOString(),
  };
}

export function activityFallsInReviewMonth(value, month, timezone = DEFAULT_REVIEW_TIMEZONE) {
  const time = Date.parse(String(value ?? ""));
  if (!Number.isFinite(time)) return false;
  let normalized;
  try {
    normalized = parseMonth(month).normalized;
  } catch {
    return false;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: normalizeReviewTimezone(timezone),
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(time));
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}` === normalized;
}

export function normalizeReviewTimezone(value) {
  const timezone = String(value ?? "").trim();
  return ALLOWED_REVIEW_TIMEZONES.has(timezone) ? timezone : DEFAULT_REVIEW_TIMEZONE;
}
function parseMonth(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) throw new Error("请选择有效复盘月份。");
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2000 || year > 2200 || month < 1 || month > 12) {
    throw new Error("请选择有效复盘月份。");
  }
  return { year, month, normalized: `${year}-${String(month).padStart(2, "0")}` };
}

function zonedLocalMidnightUtc({ year, month, day, timeZone }) {
  const target = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let candidate = target;
  // Intl has no inverse conversion. Iteratively correct the UTC candidate
  // until its formatted wall-clock parts equal the requested local midnight.
  for (let index = 0; index < 4; index += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(candidate));
    const part = (type) => Number(parts.find((item) => item.type === type)?.value);
    const represented = Date.UTC(
      part("year"),
      part("month") - 1,
      part("day"),
      part("hour"),
      part("minute"),
      part("second"),
    );
    const correction = target - represented;
    candidate += correction;
    if (correction === 0) return candidate;
  }
  throw new Error(`无法解析复盘时区边界：${timeZone}`);
}
