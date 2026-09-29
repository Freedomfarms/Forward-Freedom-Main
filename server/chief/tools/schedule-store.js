// Records a scheduled task. This is not a scheduler: nothing here claims a
// lock, computes a tick, or runs the task. Phase 5 owns dispatch.

import { randomUUID } from "node:crypto";

import { withUserContext } from "../../db/prisma.js";

const KINDS = new Set(["ONCE", "INTERVAL", "CRON"]);

export function normalizeSchedule(params) {
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
  return {
    name,
    kind,
    cronExpr: kind === "CRON" ? String(params.cronExpr).trim() : null,
    intervalSeconds: kind === "INTERVAL" ? Number(params.intervalSeconds) : null,
    runAt: kind === "ONCE" ? new Date(params.runAt) : null,
    payload: params?.payload ?? null,
  };
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
      nextRunAt: null,
      lastRunAt: null,
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
          nextRunAt: null,
        },
      })
    );
  }
}
