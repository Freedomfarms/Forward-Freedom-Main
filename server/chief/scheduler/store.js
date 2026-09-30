// CHIEF scheduled-task store — the database is the scheduler's only state.
//
// ADAPT of möbius (citizenhicks, Apache-2.0)
//   Upstream: https://github.com/citizenhicks/mobius
//   Source file: src/backend/bots.rs (try_routine_lock, claim-time schedule
//     advance, recover_interrupted_runs, Running/Succeeded/Failed/Skipped)
//   Commit: 3e1aaf5039f5069c3142861cb145fc0fb5521284
//
// Preserved upstream semantics:
//   - a run is claimed under a lock, and the schedule is advanced in the same
//     write, before the turn starts
//   - a run left RUNNING by a crashed invocation is marked failed on the next
//     pass and is not re-run (it may have had side effects)
// Adaptations:
//   - The lock is a compare-and-swap on the task row (expected nextRunAt,
//     lockedAt null or stale) instead of an in-process mutex. Two overlapping
//     serverless ticks cannot both win: updateMany reports count 1 to one of
//     them.
//   - Runs add AWAITING_APPROVAL (the turn suspended on an approval request)
//     and RETRYING (a bounded Hermes-style re-run is parked on the task).
//   - Only enumeration crosses users. Every read or write of a task or run
//     happens inside withUserContext, so RLS applies.

import { withUserContext } from "../../db/prisma.js";
import { getServicePrismaClient } from "../../db/servicePrisma.js";
import { encryptJson } from "../../security/envelope.js";
import { advanceAtClaim, initialNextRun } from "./schedule.js";

export const RunStatus = Object.freeze({
  RUNNING: "RUNNING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  RETRYING: "RETRYING",
});

const TERMINAL = new Set([
  RunStatus.SUCCEEDED,
  RunStatus.FAILED,
  RunStatus.SKIPPED,
  RunStatus.AWAITING_APPROVAL,
]);

function lockIsFree(task, staleBefore) {
  return !task.lockedAt || new Date(task.lockedAt).getTime() < staleBefore.getTime();
}

function isDue(task, now, staleBefore) {
  return (
    task.status === "ACTIVE" &&
    task.nextRunAt != null &&
    new Date(task.nextRunAt).getTime() <= now.getTime() &&
    lockIsFree(task, staleBefore)
  );
}

function finishedTaskData({ status, retryAt, completeTask, now }) {
  const data = { lockedAt: null, lastRunAt: now };
  if (status === RunStatus.RETRYING && retryAt) data.nextRunAt = retryAt;
  if (completeTask) {
    data.status = "COMPLETED";
    data.nextRunAt = null;
  }
  return data;
}

export class MemoryTaskStore {
  constructor({ tasks = [] } = {}) {
    this.tasks = tasks;
    this.runs = [];
    this._seq = 0;
  }

  _task(userId, taskId) {
    return this.tasks.find((task) => task.id === taskId && task.userId === userId) ?? null;
  }

  async listStaleRuns(staleBefore, limit = 20) {
    return this.runs
      .filter(
        (run) =>
          run.status === RunStatus.RUNNING &&
          new Date(run.startedAt).getTime() < staleBefore.getTime()
      )
      .slice(0, limit)
      .map((run) => ({ id: run.id, userId: run.userId }));
  }

  async recoverRun(userId, runId, now) {
    const run = this.runs.find((row) => row.id === runId && row.userId === userId);
    if (!run || run.status !== RunStatus.RUNNING) return null;
    Object.assign(run, { status: RunStatus.FAILED, error: "interrupted", completedAt: now });
    const task = run.scheduledTaskId ? this._task(userId, run.scheduledTaskId) : null;
    if (task) {
      task.lockedAt = null;
      if (task.kind === "ONCE" && task.status === "ACTIVE") task.status = "COMPLETED";
    }
    return { ...run };
  }

  async listUnscheduled(limit = 20) {
    return this.tasks
      .filter((task) => task.status === "ACTIVE" && task.nextRunAt == null && !task.lockedAt)
      .slice(0, limit)
      .map((task) => ({ id: task.id, userId: task.userId }));
  }

  async initialize(userId, taskId, now) {
    const task = this._task(userId, taskId);
    if (!task || task.status !== "ACTIVE" || task.nextRunAt != null) return null;
    try {
      task.nextRunAt = initialNextRun(task, now);
      return { nextRunAt: task.nextRunAt };
    } catch (error) {
      task.status = "PAUSED";
      return { paused: true, reason: error.message };
    }
  }

  async listDue(now, staleBefore, limit = 3) {
    return this.tasks
      .filter((task) => isDue(task, now, staleBefore))
      .sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt))
      .slice(0, limit)
      .map((task) => ({ id: task.id, userId: task.userId }));
  }

  async claim(userId, taskId, now, staleBefore) {
    const task = this._task(userId, taskId);
    if (!task || !isDue(task, now, staleBefore)) return null;
    let advanced;
    try {
      advanced = advanceAtClaim(task, now);
    } catch (error) {
      Object.assign(task, { status: "PAUSED", lockedAt: null });
      return { paused: true, reason: error.message };
    }
    Object.assign(task, { lockedAt: now, nextRunAt: advanced });
    let run = this.runs.find(
      (row) => row.scheduledTaskId === task.id && row.status === RunStatus.RETRYING
    );
    if (run) {
      Object.assign(run, { status: RunStatus.RUNNING, attempts: run.attempts + 1, error: null });
    } else {
      this._seq += 1;
      run = {
        id: `run-${this._seq}`,
        userId,
        scheduledTaskId: task.id,
        sessionId: null,
        status: RunStatus.RUNNING,
        attempts: 1,
        error: null,
        result: null,
        startedAt: now,
        completedAt: null,
      };
      this.runs.push(run);
    }
    return { task: { ...task }, run: { ...run } };
  }

  async attachSession(userId, runId, sessionId) {
    const run = this.runs.find((row) => row.id === runId && row.userId === userId);
    if (run) run.sessionId = sessionId;
  }

  async finish(
    userId,
    {
      taskId,
      runId,
      status,
      error = null,
      result = null,
      retryAt = null,
      completeTask = false,
      now,
    }
  ) {
    const run = this.runs.find((row) => row.id === runId && row.userId === userId);
    if (run) {
      Object.assign(run, {
        status,
        error,
        result,
        completedAt: TERMINAL.has(status) ? now : null,
      });
    }
    const task = this._task(userId, taskId);
    if (task) Object.assign(task, finishedTaskData({ status, retryAt, completeTask, now }));
  }

  async pause(userId, taskId) {
    const task = this._task(userId, taskId);
    if (task) Object.assign(task, { status: "PAUSED", lockedAt: null });
  }

  async lastSucceededSession(userId, taskId) {
    const runs = this.runs.filter(
      (run) =>
        run.userId === userId &&
        run.scheduledTaskId === taskId &&
        run.status === RunStatus.SUCCEEDED &&
        run.sessionId
    );
    return runs.length ? runs[runs.length - 1].sessionId : null;
  }
}

export class PrismaTaskStore {
  constructor({
    withUser = withUserContext,
    service = getServicePrismaClient,
    encrypt = encryptJson,
  } = {}) {
    this._withUser = withUser;
    this._service = service;
    this._encrypt = encrypt;
  }

  _serviceClient() {
    const client = this._service();
    if (!client) {
      const error = new Error("Database client is not configured.");
      error.status = 503;
      throw error;
    }
    return client;
  }

  // Service role (BYPASSRLS): the cron tick has no user, so it can only find
  // interrupted runs across users. It reads ids and owners; recoverRun does
  // the write inside withUserContext.
  async listStaleRuns(staleBefore, limit = 20) {
    return this._serviceClient().chiefTaskRun.findMany({
      where: { status: RunStatus.RUNNING, startedAt: { lt: staleBefore } },
      select: { id: true, userId: true },
      orderBy: { startedAt: "asc" },
      take: limit,
    });
  }

  async recoverRun(userId, runId, now) {
    return this._withUser(userId, async (tx) => {
      const run = await tx.chiefTaskRun.findFirst({ where: { id: runId, userId } });
      if (!run || run.status !== RunStatus.RUNNING) return null;
      const updated = await tx.chiefTaskRun.update({
        where: { id: runId },
        data: { status: RunStatus.FAILED, error: "interrupted", completedAt: now },
      });
      if (run.scheduledTaskId) {
        const task = await tx.chiefScheduledTask.findFirst({
          where: { id: run.scheduledTaskId, userId },
        });
        if (task) {
          const data = { lockedAt: null };
          if (task.kind === "ONCE" && task.status === "ACTIVE") data.status = "COMPLETED";
          await tx.chiefScheduledTask.update({ where: { id: task.id }, data });
        }
      }
      return updated;
    });
  }

  // Service role (BYPASSRLS): enumerates ACTIVE tasks that have never been
  // given a nextRunAt across users. Ids and owners only; initialize() writes
  // inside withUserContext.
  async listUnscheduled(limit = 20) {
    return this._serviceClient().chiefScheduledTask.findMany({
      where: { status: "ACTIVE", nextRunAt: null, lockedAt: null },
      select: { id: true, userId: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
  }

  async initialize(userId, taskId, now) {
    return this._withUser(userId, async (tx) => {
      const task = await tx.chiefScheduledTask.findFirst({ where: { id: taskId, userId } });
      if (!task || task.status !== "ACTIVE" || task.nextRunAt != null) return null;
      let nextRunAt;
      try {
        nextRunAt = initialNextRun(task, now);
      } catch (error) {
        await tx.chiefScheduledTask.update({ where: { id: taskId }, data: { status: "PAUSED" } });
        return { paused: true, reason: error.message };
      }
      const { count } = await tx.chiefScheduledTask.updateMany({
        where: { id: taskId, status: "ACTIVE", nextRunAt: null },
        data: { nextRunAt },
      });
      return count === 1 ? { nextRunAt } : null;
    });
  }

  // Service role (BYPASSRLS): the due-task query spans users by design. It
  // returns ids and owners only; claim() re-reads and locks the row inside
  // withUserContext.
  async listDue(now, staleBefore, limit = 3) {
    return this._serviceClient().chiefScheduledTask.findMany({
      where: {
        status: "ACTIVE",
        nextRunAt: { lte: now },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
      },
      select: { id: true, userId: true },
      orderBy: { nextRunAt: "asc" },
      take: limit,
    });
  }

  async claim(userId, taskId, now, staleBefore) {
    return this._withUser(userId, async (tx) => {
      const task = await tx.chiefScheduledTask.findFirst({ where: { id: taskId, userId } });
      if (!task || !isDue(task, now, staleBefore)) return null;
      let advanced;
      try {
        advanced = advanceAtClaim(task, now);
      } catch (error) {
        await tx.chiefScheduledTask.update({
          where: { id: taskId },
          data: { status: "PAUSED", lockedAt: null },
        });
        return { paused: true, reason: error.message };
      }
      const { count } = await tx.chiefScheduledTask.updateMany({
        where: {
          id: taskId,
          status: "ACTIVE",
          nextRunAt: task.nextRunAt,
          OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
        },
        data: { lockedAt: now, nextRunAt: advanced },
      });
      if (count !== 1) return null;
      const retrying = await tx.chiefTaskRun.findFirst({
        where: { scheduledTaskId: taskId, userId, status: RunStatus.RETRYING },
        orderBy: { startedAt: "desc" },
      });
      const run = retrying
        ? await tx.chiefTaskRun.update({
            where: { id: retrying.id },
            data: { status: RunStatus.RUNNING, attempts: { increment: 1 }, error: null },
          })
        : await tx.chiefTaskRun.create({
            data: {
              userId,
              scheduledTaskId: taskId,
              status: RunStatus.RUNNING,
              attempts: 1,
              startedAt: now,
            },
          });
      return { task: { ...task, lockedAt: now, nextRunAt: advanced }, run };
    });
  }

  async attachSession(userId, runId, sessionId) {
    await this._withUser(userId, (tx) =>
      tx.chiefTaskRun.update({ where: { id: runId }, data: { sessionId } })
    );
  }

  async finish(
    userId,
    {
      taskId,
      runId,
      status,
      error = null,
      result = null,
      retryAt = null,
      completeTask = false,
      now,
    }
  ) {
    await this._withUser(userId, async (tx) => {
      await tx.chiefTaskRun.update({
        where: { id: runId },
        data: {
          status,
          error,
          resultCiphertext: result == null ? null : this._encrypt(result),
          completedAt: TERMINAL.has(status) ? now : null,
        },
      });
      await tx.chiefScheduledTask.updateMany({
        where: { id: taskId, userId },
        data: finishedTaskData({ status, retryAt, completeTask, now }),
      });
    });
  }

  async pause(userId, taskId) {
    await this._withUser(userId, (tx) =>
      tx.chiefScheduledTask.updateMany({
        where: { id: taskId, userId },
        data: { status: "PAUSED", lockedAt: null },
      })
    );
  }

  async lastSucceededSession(userId, taskId) {
    return this._withUser(userId, async (tx) => {
      const run = await tx.chiefTaskRun.findFirst({
        where: {
          scheduledTaskId: taskId,
          userId,
          status: RunStatus.SUCCEEDED,
          sessionId: { not: null },
        },
        orderBy: { startedAt: "desc" },
        select: { sessionId: true },
      });
      return run?.sessionId ?? null;
    });
  }
}
