// CHIEF schedule arithmetic — when a task is due and where it goes next.
//
// ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis
//   Source file: src/openjarvis/scheduler/scheduler.py (_compute_next_run,
//     _compute_next_cron)
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
// and möbius (citizenhicks, Apache-2.0)
//   Upstream: https://github.com/citizenhicks/mobius
//   Source file: src/backend/bots.rs (advance_interval, claim-time advance)
//   Commit: 3e1aaf5039f5069c3142861cb145fc0fb5521284
//
// Preserved upstream semantics:
//   - once: the first run is runAt; a runAt in the past is due immediately
//   - interval: the first run is now + interval
//   - cron: evaluated in the task's IANA timezone, stored as UTC
//   - the schedule is advanced when the run is claimed, before it runs, so a
//     crash mid-run cannot re-fire the same slot (möbius)
//   - an interval that missed several slots fires once and skips the missed
//     ones (möbius advance_interval)
// Adaptations:
//   - Cron parsing uses the cron-parser package instead of OpenJarvis's
//     hand-written field matcher. Five fields only; seconds are rejected
//     because the dispatch tick has minute granularity at best.
//   - Interval floor is 60s. A shorter interval cannot be honored by a cron
//     tick and would only pile up skipped slots.

import { CronExpressionParser } from "cron-parser";

export const MIN_INTERVAL_SECONDS = 60;
export const DEFAULT_TIMEZONE = "UTC";

export function isValidTimezone(timezone) {
  if (typeof timezone !== "string" || !timezone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function taskTimezone(task) {
  const timezone = task?.payload?.timezone;
  return isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
}

function parseCron(expr, { currentDate, timezone }) {
  const text = String(expr ?? "").trim();
  if (text.split(/\s+/).length !== 5) {
    throw new TypeError("cron expressions must have exactly five fields");
  }
  return CronExpressionParser.parse(text, { currentDate, tz: timezone });
}

export function nextCronAfter(expr, after, timezone = DEFAULT_TIMEZONE) {
  return parseCron(expr, { currentDate: after, timezone }).next().toDate();
}

// Throws TypeError when the stored definition cannot be scheduled. The tick
// pauses such a task instead of retrying it every invocation.
export function validateTaskSchedule(task) {
  const timezone = task?.payload?.timezone;
  if (timezone != null && !isValidTimezone(timezone)) {
    throw new TypeError(`unknown timezone '${timezone}'`);
  }
  switch (task?.kind) {
    case "ONCE": {
      const runAt = new Date(task.runAt);
      if (!task.runAt || Number.isNaN(runAt.getTime())) {
        throw new TypeError("once schedules require a valid runAt");
      }
      return;
    }
    case "INTERVAL": {
      const seconds = Number(task.intervalSeconds);
      if (!Number.isFinite(seconds) || seconds < MIN_INTERVAL_SECONDS) {
        throw new TypeError(
          `interval schedules require intervalSeconds >= ${MIN_INTERVAL_SECONDS}`
        );
      }
      return;
    }
    case "CRON":
      nextCronAfter(task.cronExpr, new Date(), taskTimezone(task));
      return;
    default:
      throw new TypeError(`unknown schedule kind '${task?.kind}'`);
  }
}

export function initialNextRun(task, now = new Date()) {
  validateTaskSchedule(task);
  switch (task.kind) {
    case "ONCE":
      return new Date(task.runAt);
    case "INTERVAL":
      return new Date(now.getTime() + Number(task.intervalSeconds) * 1000);
    default:
      return nextCronAfter(task.cronExpr, now, taskTimezone(task));
  }
}

// The nextRunAt written at claim time. null means the task has no further
// occurrence (a once task that is now running).
export function advanceAtClaim(task, now = new Date()) {
  switch (task.kind) {
    case "ONCE":
      return null;
    case "INTERVAL": {
      const everyMs = Number(task.intervalSeconds) * 1000;
      const scheduled = task.nextRunAt ? new Date(task.nextRunAt).getTime() : now.getTime();
      if (scheduled > now.getTime()) return new Date(scheduled);
      const missed = Math.floor((now.getTime() - scheduled) / everyMs);
      return new Date(scheduled + everyMs * (missed + 1));
    }
    case "CRON":
      return nextCronAfter(task.cronExpr, now, taskTimezone(task));
    default:
      throw new TypeError(`unknown schedule kind '${task?.kind}'`);
  }
}
