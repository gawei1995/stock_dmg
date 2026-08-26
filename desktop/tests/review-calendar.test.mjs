import assert from "node:assert/strict";
import test from "node:test";
import {
  activityFallsInReviewMonth,
  normalizeReviewTimezone,
  reviewMonthRange,
} from "../src/review/review-calendar.mjs";

test("US monthly reviews include the complete New York trading month", () => {
  const range = reviewMonthRange("2026-07", "America/New_York");
  assert.deepEqual(range, {
    month: "2026-07",
    timezone: "America/New_York",
    startAt: "2026-07-01T04:00:00.000Z",
    endAt: "2026-08-01T03:59:59.999Z",
  });
  assert.equal(activityFallsInReviewMonth("2026-08-01T00:30:00.000Z", "2026-07", range.timezone), true);
  assert.equal(activityFallsInReviewMonth("2026-08-01T04:00:00.000Z", "2026-07", range.timezone), false);
});

test("review month boundaries respect daylight-saving changes", () => {
  const range = reviewMonthRange("2026-03", "America/New_York");
  assert.equal(range.startAt, "2026-03-01T05:00:00.000Z");
  assert.equal(range.endAt, "2026-04-01T03:59:59.999Z");
});

test("legacy Asian review timezones remain explicit and invalid values default to New York", () => {
  assert.equal(normalizeReviewTimezone("Asia/Shanghai"), "Asia/Shanghai");
  assert.equal(normalizeReviewTimezone("invalid"), "America/New_York");
  assert.equal(reviewMonthRange("2026-07", "Asia/Shanghai").startAt, "2026-06-30T16:00:00.000Z");
});
