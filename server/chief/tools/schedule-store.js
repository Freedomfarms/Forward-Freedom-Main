// Records a scheduled task, its lifecycle, a read of its run ledger, and a
// read of one run's stored outcome. This is not a scheduler: nothing here
// claims a lock, runs a turn, or aborts one. The dispatch tick
// (server/chief/scheduler/tick.js) claims ACTIVE rows later.
// listRuns does not decrypt a result. getOutcome decrypts only to read
// result.summary.
//
// ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis
//   Source file: src/openjarvis/scheduler/tools.py,
//     src/openjarvis/scheduler/scheduler.py (list_tasks, pause_task,
//     resume_task, cancel_task), and
//     src/openjarvis/scheduler/store.py (get_run_logs)
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//   get_run_logs returns result and error text. listRuns does not.
//   getOutcome returns one row's summary and error after the injection scan.

import { randomUUID } from "node:crypto";

import { withUserContext } from "../../db/prisma.js";
import { decryptJson } from "../../security/envelope.js";
import { PROMPT_MAX_CHARS } from "../scheduler/operative.js";
import { initialNextRun, isValidTimezone } from "../scheduler/schedule.js";
import { fencesOutput, scanInjection } from "../security/injection.js";

const KINDS = new Set(["ONCE", "INTERVAL", "CRON"]);
const AWAITING_APPROVAL = "AWAITING_APPROVAL";
const NO_SUMMARY_STATUSES = new Set(["AWAITING_APPROVAL", "RUNNING", "RETRYING"]);
export const SCHEDULE_RUN_LIST_LIMIT = 10;
export const SCHEDULE_SUMMARY_MAX_CHARS = 1000;

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

export function publicScheduledRun(run) {
  return {
    id: run.id,
    scheduledTaskId: run.scheduledTaskId ?? null,
    status: run.status,
    attempts: run.attempts ?? 0,
    startedAt: iso(run.startedAt),
    completedAt: iso(run.completedAt),
  };
}

function scannedOrWithheld(text) {
  const scan = scanInjection(text);
  if (fencesOutput(scan.threatLevel)) return { withheld: true, text: null };
  return { withheld: false, text };
}

// Projects one stored run. `result` is the decrypted object, or null.
// Open runs do not read it. A fenced summary is not copied onto the return.
export function projectScheduledOutcome(run, result) {
  const ledger = publicScheduledRun(run);
  let summary = null;
  let withheld = false;
  if (!NO_SUMMARY_STATUSES.has(run.status)) {
    const stored = typeof result?.summary === "string" ? result.summary : "";
    const capped = stored.slice(0, SCHEDULE_SUMMARY_MAX_CHARS);
    if (capped) {
      const scanned = scannedOrWithheld(capped);
      withheld = scanned.withheld;
      summary = scanned.text;
    }
  }
  const storedError = typeof run.error === "string" ? run.error : "";
  const error = storedError ? scannedOrWithheld(storedError).text : null;
  return {
    withheld,
    outcome: {
      ...ledger,
      summary,
      error,
    },
  };
}

function runStartedAt(run) {
  const time = new Date(run?.startedAt).getTime();
  return Number.isNaN(time) ? 0 : time;
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

const UPDATE_FIELDS = Object.freeze([
  "name",
  "prompt",
  "kind",
  "cronExpr",
  "intervalSeconds",
  "runAt",
  "timezone",
]);

function providedScheduleUpdates(params) {
  const picked = {};
  if (!params || typeof params !== "object") return picked;
  for (const key of UPDATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(params, key) && params[key] != null) {
      picked[key] = params[key];
    }
  }
  return picked;
}

function definitionFromTask(task) {
  return {
    name: task.name,
    kind: task.kind,
    cronExpr: task.cronExpr,
    intervalSeconds: task.intervalSeconds,
    runAt: task.runAt,
    prompt: task?.payload?.prompt,
    timezone: task?.payload?.timezone,
  };
}

function prepareScheduleUpdate(task, params, now) {
  const patch = providedScheduleUpdates(params);
  if (Object.keys(patch).length === 0) return { error: "no_updates" };
  try {
    return { fields: normalizeSchedule({ ...definitionFromTask(task), ...patch }, now) };
  } catch (error) {
    return { error: "invalid_schedule", message: error.message };
  }
}

function updateBlocked(task, awaiting) {
  if (!task) return { error: "not_found" };
  if (task.status !== "ACTIVE" && task.status !== "PAUSED") return { error: "not_updatable" };
  if (task.lockedAt || awaiting) return { error: "in_flight" };
  return null;
}

function applyScheduleUpdate(task, fields) {
  task.name = fields.name;
  task.kind = fields.kind;
  task.cronExpr = fields.cronExpr;
  task.intervalSeconds = fields.intervalSeconds;
  task.runAt = fields.runAt;
  task.payload = fields.payload;
  if (task.status === "ACTIVE") task.nextRunAt = fields.nextRunAt;
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

  async listRuns({ userId, taskId } = {}) {
    const filterId = String(taskId ?? "").trim();
    if (filterId && !this._own(userId, filterId)) return { error: "not_found" };
    const runs = this.runs
      .filter((run) => run.userId === userId && (!filterId || run.scheduledTaskId === filterId))
      .sort((a, b) => runStartedAt(b) - runStartedAt(a) || String(b.id).localeCompare(String(a.id)))
      .slice(0, SCHEDULE_RUN_LIST_LIMIT)
      .map((run) => publicScheduledRun(run));
    return { runs };
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

  async update({ userId, taskId, params, now = new Date() } = {}) {
    const id = String(taskId ?? "").trim();
    const task = this._own(userId, id);
    const awaiting = awaitingIds(this.runs, userId).has(id);
    const blocked = updateBlocked(task, awaiting);
    if (blocked) return blocked;
    const prepared = prepareScheduleUpdate(task, params, now);
    if (prepared.error) return prepared;
    applyScheduleUpdate(task, prepared.fields);
    return { task: publicScheduledTask(task) };
  }

  async getOutcome({ userId, runId } = {}) {
    const id = String(runId ?? "").trim();
    if (!userId || !id) return { error: "not_found" };
    const run = this.runs.find((row) => row.id === id && row.userId === userId);
    if (!run) return { error: "not_found" };
    if (run.scheduledTaskId) {
      const task = this._own(userId, run.scheduledTaskId);
      if (!task) return { error: "not_found" };
    }
    const result =
      run.result && typeof run.result === "object" && !Array.isArray(run.result)
        ? run.result
        : null;
    return projectScheduledOutcome(run, result);
  }
}

export class PrismaScheduleStore {
  constructor({ withUser = withUserContext, decrypt = decryptJson } = {}) {
    this._withUser = withUser;
    this._decrypt = decrypt;
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

  async listRuns({ userId, taskId } = {}) {
    const filterId = String(taskId ?? "").trim();
    return this._withUser(userId, async (tx) => {
      if (filterId) {
        const task = await tx.chiefScheduledTask.findFirst({
          where: { id: filterId, userId },
          select: { id: true },
        });
        if (!task) return { error: "not_found" };
      }
      const runs = await tx.chiefTaskRun.findMany({
        where: { userId, ...(filterId ? { scheduledTaskId: filterId } : {}) },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        take: SCHEDULE_RUN_LIST_LIMIT,
        select: {
          id: true,
          scheduledTaskId: true,
          status: true,
          attempts: true,
          startedAt: true,
          completedAt: true,
        },
      });
      return { runs: runs.map((run) => publicScheduledRun(run)) };
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

  async update({ userId, taskId, params, now = new Date() } = {}) {
    const id = String(taskId ?? "").trim();
    return this._withUser(userId, async (tx) => {
      const task = await tx.chiefScheduledTask.findFirst({ where: { id, userId } });
      if (!task) return { error: "not_found" };
      const waiting = await tx.chiefTaskRun.findMany({
        where: { userId, scheduledTaskId: id, status: AWAITING_APPROVAL },
        select: { id: true },
        take: 1,
      });
      const blocked = updateBlocked(task, waiting.length > 0);
      if (blocked) return blocked;
      const prepared = prepareScheduleUpdate(task, params, now);
      if (prepared.error) return prepared;
      const data = {
        name: prepared.fields.name,
        kind: prepared.fields.kind,
        cronExpr: prepared.fields.cronExpr,
        intervalSeconds: prepared.fields.intervalSeconds,
        runAt: prepared.fields.runAt,
        payload: prepared.fields.payload,
      };
      if (task.status === "ACTIVE") data.nextRunAt = prepared.fields.nextRunAt;
      const { count } = await tx.chiefScheduledTask.updateMany({
        where: { id, userId, status: task.status, lockedAt: null },
        data,
      });
      if (count !== 1) return { error: "in_flight" };
      return {
        task: publicScheduledTask({
          ...task,
          ...data,
          status: task.status,
          nextRunAt: task.status === "ACTIVE" ? data.nextRunAt : task.nextRunAt,
        }),
      };
    });
  }

  async getOutcome({ userId, runId } = {}) {
    const id = String(runId ?? "").trim();
    if (!id) return { error: "not_found" };
    return this._withUser(userId, async (tx) => {
      const run = await tx.chiefTaskRun.findFirst({ where: { id, userId } });
      if (!run) return { error: "not_found" };
      if (run.scheduledTaskId) {
        const task = await tx.chiefScheduledTask.findFirst({
          where: { id: run.scheduledTaskId, userId },
          select: { id: true },
        });
        if (!task) return { error: "not_found" };
      }
      let result = null;
      if (run.resultCiphertext) {
        try {
          const decoded = this._decrypt(run.resultCiphertext);
          if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) result = decoded;
        } catch {
          result = null;
        }
      }
      return projectScheduledOutcome(run, result);
    });
  }
}
