import { AgentError } from "./errors.js";
import { WEEKDAY_NAMES, schedulePresetToCron } from "./schedule.js";
import {
  DEFAULT_USER_TIMEZONE,
  isMissingTimezoneColumnError,
  isValidIanaTimeZone,
  normalizeIanaTimeZone as normalizePlatformTimeZone,
  resolveUserTimeZone,
} from "../platform/timezone.js";

export {
  DEFAULT_USER_TIMEZONE,
  isMissingTimezoneColumnError,
  isValidIanaTimeZone,
  resolveUserTimeZone,
};

// ─────────────────────────────────────────────────────────────────────────────
// Agent-schedule timezone helpers. Profile validation lives in
// server/platform/timezone.js so /api/me does not import this module.
// Schedules are stored as UTC cron internally, but users speak local wall-clock
// time ("7 AM where I am").
// ─────────────────────────────────────────────────────────────────────────────

/** True when AgentRun lineage columns (trigger / conversation / parent) are missing. */
export function isMissingAgentRunLineageColumnError(error) {
  const message = String(error?.message || "");
  return (
    (error?.code === "P2022" || /does not exist|Unknown column|column .* missing/i.test(message)) &&
    /(trigger|triggeredByConversationId|parentRunId)/i.test(message)
  );
}

const WEEKDAY_SHORT_TO_NAME = Object.freeze({
  Sun: "sunday",
  Mon: "monday",
  Tue: "tuesday",
  Wed: "wednesday",
  Thu: "thursday",
  Fri: "friday",
  Sat: "saturday",
});

/** Agent-platform wrapper: invalid zones stay AgentError for CEO tool handling. */
export function normalizeIanaTimeZone(value) {
  try {
    return normalizePlatformTimeZone(value);
  } catch (error) {
    if (error?.code === "INVALID_TIMEZONE") {
      throw new AgentError(error.message, error.code, error.status || 400);
    }
    throw error;
  }
}

/** Offset of `timeZone` at `date`: wallClockAsUtcMs - instantMs. */
function getTimeZoneOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - date.getTime();
}

/**
 * Converts a local wall-clock Y-M-D H:00 in `timeZone` to a UTC Date.
 */
export function zonedLocalTimeToUtc(timeZone, year, month, day, hour, minute = 0) {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 4; i += 1) {
    const offset = getTimeZoneOffsetMs(new Date(utcMs), timeZone);
    utcMs = Date.UTC(year, month - 1, day, hour, minute, 0) - offset;
  }
  return new Date(utcMs);
}

function partsInTimeZone(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    weekday: WEEKDAY_SHORT_TO_NAME[parts.weekday] || null,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** Find the next local calendar date (Y-M-D) whose weekday matches `weekdayName`. */
function nextLocalDateForWeekday(timeZone, weekdayName, from = new Date()) {
  const target = WEEKDAY_NAMES.indexOf(weekdayName);
  if (target < 0) return null;
  for (let add = 0; add < 8; add += 1) {
    const probe = new Date(from.getTime() + add * 24 * 60 * 60 * 1000);
    const local = partsInTimeZone(probe, timeZone);
    if (WEEKDAY_NAMES.indexOf(local.weekday) === target) {
      return { year: local.year, month: local.month, day: local.day };
    }
  }
  return null;
}

function modeInt(values) {
  const counts = new Map();
  let best = values[0];
  let bestCount = 0;
  for (const value of values) {
    const next = (counts.get(value) || 0) + 1;
    counts.set(value, next);
    if (next > bestCount) {
      best = value;
      bestCount = next;
    }
  }
  return best;
}

/**
 * Maps a local-time schedule into the UTC cron string stored on AgentConfig.
 * Returns { cron, hourUtc, weekdaysUtc }. Missing timezone → America/New_York.
 */
export function localScheduleToUtcCron({
  preset,
  weekday = null,
  weekdays = null,
  hourLocal,
  timeZone,
  now = new Date(),
}) {
  timeZone = resolveUserTimeZone(timeZone);
  if (!Number.isInteger(hourLocal) || hourLocal < 0 || hourLocal > 23) {
    throw new AgentError(
      "scheduleHourLocal must be an integer from 0 to 23.",
      "INVALID_SCHEDULE_HOUR",
      400
    );
  }

  const localDays =
    preset === "weekly"
      ? weekdays?.length
        ? weekdays
        : weekday
          ? [weekday]
          : ["monday"]
      : preset === "daily"
        ? [...WEEKDAY_NAMES]
        : ["monday"]; // monthly: sample one day for hour conversion

  const utcHours = [];
  const utcWeekdays = new Set();

  for (const dayName of localDays) {
    const localDate = nextLocalDateForWeekday(timeZone, dayName, now);
    if (!localDate) continue;
    const utc = zonedLocalTimeToUtc(
      timeZone,
      localDate.year,
      localDate.month,
      localDate.day,
      hourLocal,
      0
    );
    utcHours.push(utc.getUTCHours());
    utcWeekdays.add(WEEKDAY_NAMES[utc.getUTCDay()]);
  }

  if (!utcHours.length) {
    throw new AgentError(
      "Could not resolve that local schedule into UTC.",
      "INVALID_SCHEDULE",
      400
    );
  }

  const hourUtc = modeInt(utcHours);
  if (preset === "daily") {
    return {
      cron: schedulePresetToCron("daily", { hourUtc }),
      hourUtc,
      weekdaysUtc: null,
    };
  }
  if (preset === "monthly") {
    return {
      cron: schedulePresetToCron("monthly", { hourUtc }),
      hourUtc,
      weekdaysUtc: null,
    };
  }

  const weekdaysUtc = [...utcWeekdays].sort(
    (a, b) => WEEKDAY_NAMES.indexOf(a) - WEEKDAY_NAMES.indexOf(b)
  );
  return {
    cron: schedulePresetToCron("weekly", { weekdays: weekdaysUtc, hourUtc }),
    hourUtc,
    weekdaysUtc,
  };
}

/** Formats an hour in the user's timezone for user-facing copy. */
export function formatHourLocalLabel(hourLocal, timeZone) {
  if (!Number.isInteger(hourLocal) || hourLocal < 0 || hourLocal > 23) return null;
  const suffix = timeZone && isValidIanaTimeZone(timeZone) ? ` ${timeZone}` : " local time";
  const hour12 = hourLocal % 12 === 0 ? 12 : hourLocal % 12;
  const ampm = hourLocal < 12 ? "AM" : "PM";
  return `${hour12}:00 ${ampm}${suffix}`;
}
