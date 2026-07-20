// Schedule presets for sub-agents. The UI-facing API only speaks presets
// (daily / weekly [+ weekday] / monthly) — raw cron strings are a storage
// detail on AgentConfig.schedule and are never accepted from or exposed to
// clients in this phase. The dispatcher understands EXACTLY the three cron
// shapes this module generates and treats anything else as never-due
// (fail closed), so a hand-edited row cannot produce surprise runs.

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

// All preset schedules fire at 13:00 UTC (morning across US time zones); the
// dispatcher runs every 15 minutes and picks the run up on its next pass.
const RUN_HOUR_UTC = 13;
const DEFAULT_WEEKLY_WEEKDAY = 1; // Monday

export function isValidSchedulePreset(preset) {
  return SCHEDULE_PRESETS.includes(preset);
}

export function isValidScheduleWeekday(weekday) {
  return WEEKDAY_NAMES.includes(weekday);
}

/**
 * Maps a schedule preset (+ optional weekday for weekly) to the cron string
 * stored on AgentConfig.schedule. Returns null for anything invalid.
 */
export function schedulePresetToCron(preset, weekday = null) {
  if (preset === "daily") return `0 ${RUN_HOUR_UTC} * * *`;
  if (preset === "weekly") {
    const dayNumber = weekday == null ? DEFAULT_WEEKLY_WEEKDAY : WEEKDAY_NAMES.indexOf(weekday);
    if (dayNumber < 0) return null;
    return `0 ${RUN_HOUR_UTC} * * ${dayNumber}`;
  }
  if (preset === "monthly") return `0 ${RUN_HOUR_UTC} 1 * *`;
  return null;
}

function parseField(field) {
  if (field === "*") return null;
  if (!/^\d{1,2}$/.test(field)) return undefined;
  return Number(field);
}

// Parses the restricted cron shapes this platform generates:
//   "m h * * *"  (daily)   "m h * * dow"  (weekly)   "m h dom * *"  (monthly)
// Returns null for anything else, which callers treat as "never due".
export function parseRestrictedCron(cron) {
  const fields = String(cron || "").trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteField, hourField, domField, monthField, dowField] = fields;
  if (monthField !== "*") return null;

  const minute = parseField(minuteField);
  const hour = parseField(hourField);
  const dayOfMonth = parseField(domField);
  const dayOfWeek = parseField(dowField);
  if (
    minute === undefined || minute === null || minute > 59 ||
    hour === undefined || hour === null || hour > 23 ||
    dayOfMonth === undefined || dayOfWeek === undefined
  ) {
    return null;
  }

  if (dayOfMonth === null && dayOfWeek === null) return { kind: "daily", minute, hour };
  if (dayOfMonth === null && dayOfWeek !== null && dayOfWeek <= 6) {
    return { kind: "weekly", minute, hour, dayOfWeek };
  }
  // Days 29-31 do not exist in every month; the API only ever writes day 1,
  // so anything above 28 is rejected rather than guessed at.
  if (dayOfWeek === null && dayOfMonth !== null && dayOfMonth >= 1 && dayOfMonth <= 28) {
    return { kind: "monthly", minute, hour, dayOfMonth };
  }
  return null;
}

/** Preset view of a stored cron string for API responses (null if unknown). */
export function cronToSchedulePreset(cron) {
  const parsed = parseRestrictedCron(cron);
  if (!parsed) return null;
  if (parsed.kind === "daily") return { preset: "daily" };
  if (parsed.kind === "weekly") {
    return { preset: "weekly", weekday: WEEKDAY_NAMES[parsed.dayOfWeek] };
  }
  return { preset: "monthly" };
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
      while (new Date(candidate).getUTCDay() !== parsed.dayOfWeek) {
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
