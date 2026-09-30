// Records a scheduled task. This is not a scheduler: nothing here claims a
// lock or runs the task. It computes the first nextRunAt so the dispatch
// tick (server/chief/scheduler/tick.js) can find the task.

import { randomUUID } from "node:crypto";

import { withUserContext } from "../../db/prisma.js";
import { PROMPT_MAX_CHARS } from "../scheduler/operative.js";
import { initialNextRun, isValidTimezone } from "../scheduler/schedule.js";
import { fencesOutput, scanInjection } from "../security/injection.js";

const KINDS = new Set(["ONCE", "INTERVAL", "CRON"]);

export function normalizeSchedule(params, now = new Date()) {
  const kind = String(params?.kind ?? "")
    .trim()
    .toUpperCase();
  if (!KINDS.has(kind)) {
    throw new TypeError("schedule kind must be once, interval, or cron");
  }
  const name = String(params?.name ?? "").trim();
  if (!name) throw new TypeError("schedule name is required");
  if (kind === "ONCE" && !params?.runAt) throw new TypeError("once schedules require runAt");
  if (kind === "INTERVAL" && !(Number(params?.intervalSeconds) > 0)) {
    throw new TypeError("interval schedules require intervalSeconds");
  }
  if (kind === "CRON" && !String(params?.cronExpr ?? "").trim()) {
    throw new TypeError("cron schedules require cronExpr");
  }
  const basePayload =
    params?.payload && typeof params.payload === "object" && !Array.isArray(params.payload)
      ? params.payload
      : {};
  const prompt = String(params?.prompt ?? basePayload.prompt ?? "").trim();
  if (!prompt) throw new TypeError("schedules require a prompt");
  if (prompt.length > PROMPT_MAX_CHARS) {
    throw new TypeError(`schedule prompt exceeds ${PROMPT_MAX_CHARS} characters`);
  }
  if (fencesOutput(scanInjection(prompt).threatLevel)) {
    throw new TypeError("schedule prompt failed the injection scan");
  }
  const timezone = params?.timezone ?? basePayload.timezone;
  if (timezone != null && !isValidTimezone(timezone)) {
    throw new TypeError(`unknown timezone '${timezone}'`);
  }
  const fields = {
    name,
    kind,
    cronExpr: kind === "CRON" ? String(params.cronExpr).trim() : null,
    intervalSeconds: kind === "INTERVAL" ? Number(params.intervalSeconds) : null,
    runAt: kind === "ONCE" ? new Date(params.runAt) : null,
    payload: { ...basePayload, prompt, ...(timezone != null ? { timezone } : {}) },
  };
  fields.nextRunAt = initialNextRun(fields, now);
  return fields;
}

export class MemoryScheduleStore {
  constructor() {
    this.tasks = [];
  }

  async create({ userId, ...fields }) {
    const task = {
      id: randomUUID(),
      userId,
      ...fields,
      status: "ACTIVE",
      nextRunAt: fields.nextRunAt ?? null,
      lastRunAt: null,
      lockedAt: null,
    };
    this.tasks.push(task);
    return { ...task };
  }
}

export class PrismaScheduleStore {
  constructor({ withUser = withUserContext } = {}) {
    this._withUser = withUser;
  }

  async create({ userId, ...fields }) {
    return this._withUser(userId, (tx) =>
      tx.chiefScheduledTask.create({
        data: {
          userId,
          name: fields.name,
          kind: fields.kind,
          cronExpr: fields.cronExpr,
          intervalSeconds: fields.intervalSeconds,
          runAt: fields.runAt,
          payload: fields.payload ?? undefined,
          status: "ACTIVE",
          nextRunAt: fields.nextRunAt ?? null,
        },
      })
    );
  }
}
