import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_USER_TIMEZONE,
  isMissingTimezoneColumnError,
  isValidIanaTimeZone,
  normalizeIanaTimeZone,
  resolveUserTimeZone,
} from "../server/platform/timezone.js";

test("isValidIanaTimeZone accepts real zones and rejects junk", () => {
  assert.equal(isValidIanaTimeZone("America/New_York"), true);
  assert.equal(isValidIanaTimeZone("UTC"), true);
  assert.equal(isValidIanaTimeZone("Not/A_Zone"), false);
  assert.equal(isValidIanaTimeZone(""), false);
  assert.equal(isValidIanaTimeZone(null), false);
});

test("normalizeIanaTimeZone trims and validates without the agent error type", () => {
  assert.equal(normalizeIanaTimeZone("  America/Chicago "), "America/Chicago");
  assert.equal(normalizeIanaTimeZone(null), null);
  assert.equal(normalizeIanaTimeZone(""), null);
  assert.throws(() => normalizeIanaTimeZone("Mars/Olympus"), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, "INVALID_TIMEZONE");
    assert.match(error.message, /IANA timezone/);
    assert.notEqual(error.name, "AgentError");
    return true;
  });
  assert.throws(() => normalizeIanaTimeZone(12), (error) => {
    assert.equal(error.code, "INVALID_TIMEZONE");
    return true;
  });
});

test("isMissingTimezoneColumnError detects Prisma P2022 on timezone only", () => {
  assert.equal(
    isMissingTimezoneColumnError({
      code: "P2022",
      message: "The column `timezone` does not exist in the current database.",
    }),
    true
  );
  assert.equal(
    isMissingTimezoneColumnError({
      code: "P2022",
      message: "The column `email` does not exist in the current database.",
    }),
    false
  );
});

test("resolveUserTimeZone defaults to America/New_York", () => {
  assert.equal(DEFAULT_USER_TIMEZONE, "America/New_York");
  assert.equal(resolveUserTimeZone(null), "America/New_York");
  assert.equal(resolveUserTimeZone(""), "America/New_York");
  assert.equal(resolveUserTimeZone("America/Chicago"), "America/Chicago");
});
