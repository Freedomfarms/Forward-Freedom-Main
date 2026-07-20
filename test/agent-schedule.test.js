import test from "node:test";
import assert from "node:assert/strict";

import {
  cronToSchedulePreset,
  getPreviousCronOccurrence,
  isAgentDue,
  parseRestrictedCron,
  schedulePresetToCron,
} from "../server/agents/schedule.js";

// Pure-function tests for the schedule preset ↔ cron mapping and the cron
// dispatcher's due-check. Presets are the only schedule surface the API
// exposes; unknown cron shapes must never be treated as due (fail closed).

test("presets map to the restricted cron shapes and round-trip back", () => {
  assert.equal(schedulePresetToCron("daily"), "0 13 * * *");
  assert.equal(schedulePresetToCron("weekly"), "0 13 * * 1");
  assert.equal(schedulePresetToCron("weekly", "friday"), "0 13 * * 5");
  assert.equal(schedulePresetToCron("monthly"), "0 13 1 * *");
  assert.equal(schedulePresetToCron("hourly"), null);
  assert.equal(schedulePresetToCron("weekly", "notaday"), null);

  assert.deepEqual(cronToSchedulePreset("0 13 * * *"), { preset: "daily" });
  assert.deepEqual(cronToSchedulePreset("0 13 * * 5"), { preset: "weekly", weekday: "friday" });
  assert.deepEqual(cronToSchedulePreset("0 13 1 * *"), { preset: "monthly" });
  assert.equal(cronToSchedulePreset("*/15 * * * *"), null);
  assert.equal(cronToSchedulePreset(null), null);
});

test("parseRestrictedCron rejects everything outside the generated shapes", () => {
  assert.equal(parseRestrictedCron("*/15 * * * *"), null);
  assert.equal(parseRestrictedCron("0 13 * 6 *"), null); // month restriction
  assert.equal(parseRestrictedCron("0 13 1 * 1"), null); // both dom and dow
  assert.equal(parseRestrictedCron("0 13 29 * *"), null); // dom > 28
  assert.equal(parseRestrictedCron("0 25 * * *"), null); // invalid hour
  assert.equal(parseRestrictedCron("a b * * *"), null);
  assert.equal(parseRestrictedCron(""), null);
  assert.deepEqual(parseRestrictedCron("0 13 * * *"), { kind: "daily", minute: 0, hour: 13 });
});

test("getPreviousCronOccurrence finds the latest occurrence at or before now", () => {
  // 2026-07-20 is a Monday.
  const now = new Date("2026-07-20T15:00:00Z");
  assert.deepEqual(getPreviousCronOccurrence("0 13 * * *", now), new Date("2026-07-20T13:00:00Z"));
  // Before today's fire time → yesterday's occurrence.
  assert.deepEqual(
    getPreviousCronOccurrence("0 13 * * *", new Date("2026-07-20T09:00:00Z")),
    new Date("2026-07-19T13:00:00Z")
  );
  // Weekly friday → the previous friday.
  assert.deepEqual(getPreviousCronOccurrence("0 13 * * 5", now), new Date("2026-07-17T13:00:00Z"));
  // Monthly on the 1st.
  assert.deepEqual(getPreviousCronOccurrence("0 13 1 * *", now), new Date("2026-07-01T13:00:00Z"));
  // Monthly, before this month's fire time → previous month (with year wrap).
  assert.deepEqual(
    getPreviousCronOccurrence("0 13 1 * *", new Date("2026-01-01T09:00:00Z")),
    new Date("2025-12-01T13:00:00Z")
  );
  assert.equal(getPreviousCronOccurrence("*/15 * * * *", now), null);
});

test("isAgentDue compares the last run against the previous occurrence", () => {
  const now = new Date("2026-07-20T15:00:00Z");
  // Never ran → due once an occurrence has passed.
  assert.equal(isAgentDue("0 13 * * *", null, now), true);
  // Ran before today's occurrence → due.
  assert.equal(isAgentDue("0 13 * * *", new Date("2026-07-19T13:05:00Z"), now), true);
  // Ran after today's occurrence (including a manual run) → not due.
  assert.equal(isAgentDue("0 13 * * *", new Date("2026-07-20T13:05:00Z"), now), false);
  // Unknown cron shapes are never due (fail closed).
  assert.equal(isAgentDue("*/15 * * * *", null, now), false);
  assert.equal(isAgentDue(null, null, now), false);
});
