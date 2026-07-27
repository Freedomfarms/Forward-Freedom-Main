import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_USER_TIMEZONE,
  isValidIanaTimeZone,
  localScheduleToUtcCron,
  normalizeIanaTimeZone,
  resolveUserTimeZone,
  zonedLocalTimeToUtc,
} from "../server/agents/timezone.js";

test("isValidIanaTimeZone accepts real zones and rejects junk", () => {
  assert.equal(isValidIanaTimeZone("America/New_York"), true);
  assert.equal(isValidIanaTimeZone("UTC"), true);
  assert.equal(isValidIanaTimeZone("Not/A_Zone"), false);
  assert.equal(isValidIanaTimeZone(""), false);
  assert.equal(isValidIanaTimeZone(null), false);
});

test("normalizeIanaTimeZone trims and validates", () => {
  assert.equal(normalizeIanaTimeZone("  America/Chicago "), "America/Chicago");
  assert.equal(normalizeIanaTimeZone(null), null);
  assert.throws(() => normalizeIanaTimeZone("Mars/Olympus"), /IANA timezone/);
});

test("local weekday 7 AM America/New_York maps to a UTC cron (winter sample)", () => {
  // 2026-01-12 is a Monday; EST is UTC-5 → 7 AM local = 12:00 UTC.
  const now = new Date("2026-01-12T15:00:00Z");
  const resolved = localScheduleToUtcCron({
    preset: "weekly",
    weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
    hourLocal: 7,
    timeZone: "America/New_York",
    now,
  });
  assert.equal(resolved.hourUtc, 12);
  assert.equal(resolved.cron, "0 12 * * 1,2,3,4,5");
});

test("zonedLocalTimeToUtc converts America/Los_Angeles wall clock", () => {
  // 2026-07-15 07:00 PDT = UTC-7 → 14:00 UTC
  const utc = zonedLocalTimeToUtc("America/Los_Angeles", 2026, 7, 15, 7, 0);
  assert.equal(utc.toISOString(), "2026-07-15T14:00:00.000Z");
});

test("resolveUserTimeZone defaults to America/New_York (Eastern)", () => {
  assert.equal(DEFAULT_USER_TIMEZONE, "America/New_York");
  assert.equal(resolveUserTimeZone(null), "America/New_York");
  assert.equal(resolveUserTimeZone(""), "America/New_York");
  assert.equal(resolveUserTimeZone("America/Chicago"), "America/Chicago");
});

test("localScheduleToUtcCron defaults missing timezone to Eastern", () => {
  const now = new Date("2026-01-12T15:00:00Z");
  const resolved = localScheduleToUtcCron({
    preset: "daily",
    hourLocal: 7,
    timeZone: null,
    now,
  });
  // 7 AM America/New_York in January = 12:00 UTC
  assert.equal(resolved.hourUtc, 12);
});
