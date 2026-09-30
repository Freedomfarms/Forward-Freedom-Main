// Records a scheduled task and its lifecycle. This is not a scheduler:
// nothing here claims a lock, runs a turn, or aborts one. The dispatch tick
// (server/chief/scheduler/tick.js) claims ACTIVE rows later.
//
// ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis
//   Source file: src/openjarvis/scheduler/tools.py and
//     src/openjarvis/scheduler/scheduler.py (list_tasks, pause_task,
//     resume_task, cancel_task)
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec

import { randomUUID } from "node:crypto";

import { withUserContext } from "../../db/prisma.js";
import { PROMPT_MAX_CHARS } from "../scheduler/operative.js";
import { initialNextRun, isValidTimezone } from "../scheduler/schedule.js";
import { fencesOutput, scanInjection } from "../security/injection.js";

const KINDS = new Set(["ONCE", "INTERVAL", "CRON"]);
const AWAITING_APPROVAL = "AWAITING_APPROVAL";

function iso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function publicScheduledTask(task, awaitingApproval = false) {
  return {
    id: task.id,
    name: task.name,
    kind: task.kind,
    status: task.status,
    nextRunAt: iso(task.nextRunAt),
    lastRunAt: iso(task.lastRunAt),
    awaitingApproval: Boolean(awaitingApproval),
  };
}

function awaitingIds(runs, userId) {
  return new Set(
    (runs ?? [])
      .filter(
        (run) => run.userId === userId && run.status === AWAITING_APPROVAL && run.scheduledTaskId
      )
      .map((run) => run.scheduledTaskId)
  );
}

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
  constructor({ tasks, runs } = {}) {
    this.tasks = tasks ?? [];
    this.runs = runs ?? [];
  }

  _own(userId, taskId) {
    if (!userId || !taskId) return null;
    return this.tasks.find((task) => task.id === taskId && task.userId === userId) ?? null;
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

  async list({ userId }) {
    const waiting = awaitingIds(this.runs, userId);
    return this.tasks
      .filter((task) => task.userId === userId)
      .map((task) => publicScheduledTask(task, waiting.has(task.id)));
  }

  async pause({ userId, taskId }) {
    const task = this._own(userId, taskId);
    if (!task) return { error: "not_found" };
    if (task.status === "PAUSED") return { task: publicScheduledTask(task), unchanged: true };
    if (task.status !== "ACTIVE") return { error: "not_pausable" };
    task.status = "PAUSED";
    return { task: publicScheduledTask(task) };
  }

  async resume({ userId, taskId, now = new Date() }) {
    const task = this._own(userId, taskId);
    if (!task) return { error: "not_found" };
    if (task.status !== "PAUSED") return { error: "not_resumable" };
    let nextRunAt;
    try {
      nextRunAt = initialNextRun(task, now);
    } catch (error) {
      return { error: "invalid_schedule", message: error.message };
    }
    task.status = "ACTIVE";
    task.nextRunAt = nextRunAt;
    return { task: publicScheduledTask(task) };
  }

  async cancel({ userId, taskId }) {
    const task = this._own(userId, taskId);
    if (!task) return { error: "not_found" };
    if (task.status === "CANCELLED") return { task: publicScheduledTask(task), unchanged: true };
    if (task.status !== "ACTIVE" && task.status !== "PAUSED") return { error: "not_cancellable" };
    task.status = "CANCELLED";
    task.nextRunAt = null;
    return { task: publicScheduledTask(task) };
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

  async list({ userId }) {
    return this._withUser(userId, async (tx) => {
      const tasks = await tx.chiefScheduledTask.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
      });
      const waiting = await tx.chiefTaskRun.findMany({
        where: { userId, status: AWAITING_APPROVAL, scheduledTaskId: { not: null } },
        select: { scheduledTaskId: true },
      });
      const ids = new Set(waiting.map((run) => run.scheduledTaskId));
      return tasks.map((task) => publicScheduledTask(task, ids.has(task.id)));
    });
  }

  async pause({ userId, taskId }) {
    return this._withUser(userId, async (tx) => {
      const task = await tx.chiefScheduledTask.findFirst({ where: { id: taskId, userId } });
      if (!task) return { error: "not_found" };
      if (task.status === "PAUSED") return { task: publicScheduledTask(task), unchanged: true };
      if (task.status !== "ACTIVE") return { error: "not_pausable" };
      const { count } = await tx.chiefScheduledTask.updateMany({
        where: { id: taskId, userId, status: "ACTIVE" },
        data: { status: "PAUSED" },
      });
      if (count !== 1) return { error: "not_pausable" };
      return { task: publicScheduledTask({ ...task, status: "PAUSED" }) };
    });
  }

  async resume({ userId, taskId, now = new Date() }) {
    return this._withUser(userId, async (tx) => {
      const task = await tx.chiefScheduledTask.findFirst({ where: { id: taskId, userId } });
      if (!task) return { error: "not_found" };
      if (task.status !== "PAUSED") return { error: "not_resumable" };
      let nextRunAt;
      try {
        nextRunAt = initialNextRun(task, now);
      } catch (error) {
        return { error: "invalid_schedule", message: error.message };
      }
      const { count } = await tx.chiefScheduledTask.updateMany({
        where: { id: taskId, userId, status: "PAUSED" },
        data: { status: "ACTIVE", nextRunAt },
      });
      if (count !== 1) return { error: "not_resumable" };
      return { task: publicScheduledTask({ ...task, status: "ACTIVE", nextRunAt }) };
    });
  }

  async cancel({ userId, taskId }) {
    return this._withUser(userId, async (tx) => {
      const task = await tx.chiefScheduledTask.findFirst({ where: { id: taskId, userId } });
      if (!task) return { error: "not_found" };
      if (task.status === "CANCELLED") return { task: publicScheduledTask(task), unchanged: true };
      if (task.status !== "ACTIVE" && task.status !== "PAUSED") return { error: "not_cancellable" };
      const { count } = await tx.chiefScheduledTask.updateMany({
        where: { id: taskId, userId, status: { in: ["ACTIVE", "PAUSED"] } },
        data: { status: "CANCELLED", nextRunAt: null },
      });
      if (count !== 1) return { error: "not_cancellable" };
      return { task: publicScheduledTask({ ...task, status: "CANCELLED", nextRunAt: null }) };
    });
  }
}
