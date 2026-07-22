// Schedule presets for sub-agents. The UI-facing API speaks presets
// (daily / weekly [+ one or more weekdays] / monthly) plus an optional UTC
// hour — raw cron strings are a storage detail on AgentConfig.schedule and
// are never accepted from or exposed to clients. The dispatcher understands
// EXACTLY the cron shapes this module generates and treats anything else as
// never-due (fail closed), so a hand-edited row cannot produce surprise runs.

export const SCHEDULE_PRESETS = Object.freeze(["daily", "weekly", "monthly"]);

export const WEEKDAY_NAMES = Object.freeze([
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
]);

// Default fire time when the caller does not specify an hour. 13:00 UTC is
// morning across US time zones; the dispatcher runs every 15 minutes and
// picks the run up on its next pass.
export const DEFAULT_RUN_HOUR_UTC = 13;
const DEFAULT_WEEKLY_WEEKDAY = 1; // Monday

export function isValidSchedulePreset(preset) {
  return SCHEDULE_PRESETS.includes(preset);
}

export function isValidScheduleWeekday(weekday) {
  return WEEKDAY_NAMES.includes(weekday);
}

export function isValidScheduleHourUtc(hour) {
  return Number.isInteger(hour) && hour >= 0 && hour <= 23;
}

/**
 * Normalizes weekday input from API/chat into a sorted unique list of
 * weekday names. Accepts a single `weekday`, an array `weekdays`, or both.
 */
export function normalizeScheduleWeekdays(weekday = null, weekdays = null) {
  const collected = [];
  if (Array.isArray(weekdays)) {
    for (const day of weekdays) {
      if (typeof day === "string") collected.push(day.toLowerCase());
    }
  }
  if (typeof weekday === "string" && weekday) {
    collected.push(weekday.toLowerCase());
  }
  if (!collected.length) return null;

  const unique = [];
  for (const day of collected) {
    if (!isValidScheduleWeekday(day)) return null;
    if (!unique.includes(day)) unique.push(day);
  }
  return unique.sort((a, b) => WEEKDAY_NAMES.indexOf(a) - WEEKDAY_NAMES.indexOf(b));
}

function resolveHourUtc(hourUtc) {
  if (hourUtc == null) return DEFAULT_RUN_HOUR_UTC;
  if (!isValidScheduleHourUtc(hourUtc)) return null;
  return hourUtc;
}

/**
 * Maps a schedule preset (+ optional weekday(s) / hour) to the cron string
 * stored on AgentConfig.schedule. The second argument may be a weekday string
 * (legacy) or an options object:
 *   { weekday?, weekdays?, hourUtc? }
 * Returns null for anything invalid.
 */
export function schedulePresetToCron(preset, weekdayOrOptions = null) {
  let weekday;
  let weekdays;
  let hourUtc = DEFAULT_RUN_HOUR_UTC;

  if (typeof weekdayOrOptions === "string" || weekdayOrOptions == null) {
    weekday = weekdayOrOptions;
    weekdays = null;
  } else if (typeof weekdayOrOptions === "object") {
    weekday = weekdayOrOptions.weekday ?? null;
    weekdays = weekdayOrOptions.weekdays ?? null;
    const resolvedHour = resolveHourUtc(
      weekdayOrOptions.hourUtc === undefined ? null : weekdayOrOptions.hourUtc
    );
    if (resolvedHour == null) return null;
    hourUtc = resolvedHour;
  } else {
    return null;
  }

  if (preset === "daily") return `0 ${hourUtc} * * *`;

  if (preset === "weekly") {
    const hasWeekdayInput =
      (typeof weekday === "string" && weekday.length > 0) ||
      (Array.isArray(weekdays) && weekdays.length > 0);
    if (hasWeekdayInput) {
      const names = normalizeScheduleWeekdays(weekday, weekdays);
      if (!names) return null;
      return `0 ${hourUtc} * * ${names.map((name) => WEEKDAY_NAMES.indexOf(name)).join(",")}`;
    }
    return `0 ${hourUtc} * * ${DEFAULT_WEEKLY_WEEKDAY}`;
  }

  if (preset === "monthly") return `0 ${hourUtc} 1 * *`;
  return null;
}

function parseField(field) {
  if (field === "*") return null;
  if (!/^\d{1,2}$/.test(field)) return undefined;
  return Number(field);
}

function parseDowField(field) {
  if (field === "*") return null;
  if (/^\d{1,2}$/.test(field)) {
    const day = Number(field);
    if (day > 6) return undefined;
    return [day];
  }
  if (!/^\d{1,2}(,\d{1,2})+$/.test(field)) return undefined;
  const days = field.split(",").map(Number);
  if (days.some((day) => day > 6)) return undefined;
  const unique = [...new Set(days)].sort((a, b) => a - b);
  if (unique.length !== days.length) return undefined;
  return unique;
}

// Parses the restricted cron shapes this platform generates:
//   "m h * * *"           (daily)
//   "m h * * dow"         (weekly, single day)
//   "m h * * d1,d2,..."   (weekly, multiple days)
//   "m h dom * *"         (monthly)
// Returns null for anything else, which callers treat as "never due".
export function parseRestrictedCron(cron) {
  const fields = String(cron || "").trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteField, hourField, domField, monthField, dowField] = fields;
  if (monthField !== "*") return null;

  const minute = parseField(minuteField);
  const hour = parseField(hourField);
  const dayOfMonth = parseField(domField);
  const daysOfWeek = parseDowField(dowField);
  if (
    minute === undefined ||
    minute === null ||
    minute > 59 ||
    hour === undefined ||
    hour === null ||
    hour > 23 ||
    dayOfMonth === undefined ||
    daysOfWeek === undefined
  ) {
    return null;
  }

  if (dayOfMonth === null && daysOfWeek === null) {
    return { kind: "daily", minute, hour };
  }
  if (dayOfMonth === null && daysOfWeek !== null) {
    return { kind: "weekly", minute, hour, daysOfWeek };
  }
  // Days 29-31 do not exist in every month; the API only ever writes day 1,
  // so anything above 28 is rejected rather than guessed at.
  if (daysOfWeek === null && dayOfMonth !== null && dayOfMonth >= 1 && dayOfMonth <= 28) {
    return { kind: "monthly", minute, hour, dayOfMonth };
  }
  return null;
}

/** Preset view of a stored cron string for API responses (null if unknown). */
export function cronToSchedulePreset(cron) {
  const parsed = parseRestrictedCron(cron);
  if (!parsed) return null;
  if (parsed.kind === "daily") {
    return { preset: "daily", hourUtc: parsed.hour };
  }
  if (parsed.kind === "weekly") {
    const weekdays = parsed.daysOfWeek.map((day) => WEEKDAY_NAMES[day]);
    return {
      preset: "weekly",
      weekday: weekdays[0],
      weekdays,
      hourUtc: parsed.hour,
    };
  }
  return {
    preset: "monthly",
    hourUtc: parsed.hour,
    dayOfMonth: parsed.dayOfMonth,
  };
}

/**
 * The most recent scheduled occurrence at or before `now` (UTC), or null when
 * the cron string is not one of the restricted shapes.
 */
export function getPreviousCronOccurrence(cron, now = new Date()) {
  const parsed = parseRestrictedCron(cron);
  if (!parsed) return null;
  const nowMs = now.getTime();
  const DAY_MS = 24 * 60 * 60 * 1000;

  if (parsed.kind === "daily" || parsed.kind === "weekly") {
    let candidate = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      parsed.hour,
      parsed.minute
    );
    if (candidate > nowMs) candidate -= DAY_MS;
    if (parsed.kind === "weekly") {
      const daySet = new Set(parsed.daysOfWeek);
      while (!daySet.has(new Date(candidate).getUTCDay())) {
        candidate -= DAY_MS;
      }
    }
    return new Date(candidate);
  }

  // monthly
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  let candidate = Date.UTC(year, month, parsed.dayOfMonth, parsed.hour, parsed.minute);
  if (candidate > nowMs) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
    candidate = Date.UTC(year, month, parsed.dayOfMonth, parsed.hour, parsed.minute);
  }
  return new Date(candidate);
}

/**
 * Dispatcher due-check: an agent is due when a scheduled occurrence has
 * passed and no run (of any trigger) has started since it. Unknown cron
 * shapes are never due (fail closed).
 */
export function isAgentDue(schedule, lastRunStartedAt, now = new Date()) {
  const previous = getPreviousCronOccurrence(schedule, now);
  if (!previous) return false;
  if (!lastRunStartedAt) return true;
  return new Date(lastRunStartedAt).getTime() < previous.getTime();
}

/** Formats an hour 0–23 as a short UTC clock label (e.g. "8:00 UTC"). */
export function formatHourUtcLabel(hourUtc) {
  if (!isValidScheduleHourUtc(hourUtc)) return null;
  return `${hourUtc}:00 UTC`;
}
