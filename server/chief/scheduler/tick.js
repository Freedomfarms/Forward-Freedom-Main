// CHIEF operative tick — due scheduled tasks become schedule-caller turns.
//
// BUILD NEW (docs/adr/0005-chief-scheduler-tick.md). Concepts adapted from
// OpenJarvis scheduler._execute_task (log the run, recompute next_run, mark a
// finished once task completed), möbius run_routine_with_state (a fresh
// session per run, Skipped when a limit rejects the run) and Hermes
// cron/unreachable_retry.py (see retry.js).
//
// This is not a second agent loop. Each claimed task is one TurnMachine.run
// with caller kind "schedule". The model call goes through ChiefModelEngine
// (budget, pause flag, Grok default routing) and every tool call goes through
// ToolExecutor. A scheduled turn has no sticky approvals: its session is new,
// so any requiresConfirmation tool suspends the turn for the user.

import { ApprovalCoordinator } from "../runtime/approvals.js";
import { TurnMachine } from "../runtime/turn.js";
import { EventMsgType } from "../protocol/index.js";
import {
  lastAssistantText,
  operatorStateKey,
  prepareScheduledMessage,
  stateFromResponse,
} from "./operative.js";
import { planRetry } from "./retry.js";
import { RunStatus } from "./store.js";

export const LOCK_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_TICK_LIMIT = 3;
export const DEFAULT_TURN_TIMEOUT_MS = 45_000;
export const DEFAULT_TICK_BUDGET_MS = 50_000;

const ACTOR = "chief:schedule";
const SKIP_REASONS = new Set(["budget_exceeded", "ModelLayerPausedError"]);

function errorSummary(error) {
  const name = error?.name || "Error";
  const message = String(error?.message ?? "").slice(0, 300);
  return message ? `${name}: ${message}` : name;
}

async function safeAudit(audit, entry) {
  try {
    await audit?.write({ actor: ACTOR, ...entry });
  } catch {
    // An audit outage must not strand a claimed run in RUNNING.
  }
}

export async function runChiefTick({
  taskStore,
  checkpointStore,
  createEngine,
  createTooling,
  createTurnServices = null,
  audit = null,
  clock = () => new Date(),
  limit = DEFAULT_TICK_LIMIT,
  turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  tickBudgetMs = DEFAULT_TICK_BUDGET_MS,
} = {}) {
  if (!taskStore || !checkpointStore || !createEngine || !createTooling) {
    throw new TypeError(
      "runChiefTick requires taskStore, checkpointStore, createEngine, createTooling"
    );
  }
  const startedAt = clock();
  const staleBefore = new Date(startedAt.getTime() - LOCK_TTL_MS);
  const report = { recovered: 0, initialized: 0, paused: 0, runs: [] };

  for (const stale of await taskStore.listStaleRuns(staleBefore)) {
    const recovered = await taskStore.recoverRun(stale.userId, stale.id, startedAt);
    if (!recovered) continue;
    report.recovered += 1;
    await safeAudit(audit, {
      userId: stale.userId,
      action: "schedule.run_interrupted",
      resource: recovered.scheduledTaskId ?? null,
      summary: `run ${stale.id} was left RUNNING and is marked failed`,
    });
  }

  for (const pending of await taskStore.listUnscheduled()) {
    const initialized = await taskStore.initialize(pending.userId, pending.id, startedAt);
    if (initialized?.paused) {
      report.paused += 1;
      await safeAudit(audit, {
        userId: pending.userId,
        action: "schedule.paused",
        resource: pending.id,
        summary: `invalid schedule: ${initialized.reason}`,
      });
    } else if (initialized?.nextRunAt) {
      report.initialized += 1;
    }
  }

  const due = await taskStore.listDue(startedAt, staleBefore, limit);
  for (const candidate of due) {
    if (clock().getTime() - startedAt.getTime() > tickBudgetMs) break;
    let outcome;
    try {
      outcome = await runScheduledTask({
        candidate,
        taskStore,
        checkpointStore,
        createEngine,
        createTooling,
        createTurnServices,
        audit,
        clock,
        staleBefore,
        turnTimeoutMs,
      });
    } catch (error) {
      // The run (if one was claimed) stays RUNNING with the task locked;
      // the next tick after LOCK_TTL_MS recovers it as interrupted.
      outcome = { taskId: candidate.id, status: "error", error: errorSummary(error) };
    }
    report.runs.push(outcome);
  }
  return report;
}

async function runScheduledTask({
  candidate,
  taskStore,
  checkpointStore,
  createEngine,
  createTooling,
  createTurnServices = null,
  audit,
  clock,
  staleBefore,
  turnTimeoutMs,
}) {
  const { userId } = candidate;
  const firedAt = clock();
  const claimed = await taskStore.claim(userId, candidate.id, firedAt, staleBefore);
  if (!claimed) return { taskId: candidate.id, status: "not_claimed" };
  if (claimed.paused) {
    await safeAudit(audit, {
      userId,
      action: "schedule.paused",
      resource: candidate.id,
      summary: `invalid schedule: ${claimed.reason}`,
    });
    return { taskId: candidate.id, status: "paused" };
  }
  const { task, run } = claimed;
  const finish = (fields) =>
    taskStore.finish(userId, {
      taskId: task.id,
      runId: run.id,
      completeTask: task.kind === "ONCE" && fields.status !== RunStatus.RETRYING,
      now: clock(),
      ...fields,
    });

  let previousState = null;
  const priorSession = await taskStore.lastSucceededSession(userId, task.id);
  if (priorSession) {
    previousState = await checkpointStore.loadMiddlewareState(
      userId,
      priorSession,
      operatorStateKey(task.id)
    );
  }

  const prepared = prepareScheduledMessage({ task, previousState, firedAt });
  if (prepared.rejected) {
    await finish({ status: RunStatus.FAILED, error: prepared.reason });
    await taskStore.pause(userId, task.id);
    await safeAudit(audit, {
      userId,
      action: "schedule.prompt_rejected",
      resource: task.id,
      summary: [prepared.reason, ...(prepared.findings ?? [])].join(" "),
    });
    return { taskId: task.id, runId: run.id, status: RunStatus.FAILED, reason: prepared.reason };
  }
  if (prepared.stateDropped) {
    await safeAudit(audit, {
      userId,
      action: "schedule.state_dropped",
      resource: task.id,
      summary: "previous operator state failed the injection scan",
    });
  }

  const failRun = async (error, sessionId) => {
    const loaded = sessionId ? await checkpointStore.load(userId, sessionId) : null;
    const retryAt = planRetry({
      task,
      error,
      checkpoint: loaded?.checkpoint,
      attempts: run.attempts,
      naturalNext: task.nextRunAt,
      now: clock(),
    });
    const status = retryAt ? RunStatus.RETRYING : RunStatus.FAILED;
    await finish({ status, error: errorSummary(error), retryAt });
    await safeAudit(audit, {
      userId,
      action: retryAt ? "schedule.run_retrying" : "schedule.run_failed",
      resource: task.id,
      summary: `run ${run.id} attempt ${run.attempts}: ${errorSummary(error)}`,
    });
    return {
      taskId: task.id,
      runId: run.id,
      sessionId,
      status,
      retryAt: retryAt?.toISOString() ?? null,
    };
  };

  let sessionId = null;
  let tooling;
  let machine;
  try {
    tooling = await createTooling({ userId });
    const engine = createEngine();
    const turnServices = createTurnServices
      ? await createTurnServices({ userId, engine, checkpointStore })
      : {};
    machine = new TurnMachine({
      store: checkpointStore,
      engine,
      approvals: new ApprovalCoordinator(),
      toolExecutor: tooling.executor,
      callerKind: "schedule",
      callerTrigger: `schedule:${task.id}`,
      contextAssembler: turnServices.contextAssembler ?? null,
      compaction: turnServices.compaction ?? null,
      onTurnComplete: turnServices.onTurnComplete ?? null,
    });
    const session = await checkpointStore.createSession({
      userId,
      context: { origin: "schedule", scheduledTaskId: task.id, runId: run.id },
    });
    sessionId = session.id;
    session.checkpoint.sessionTaint = prepared.sessionTaint;
    await checkpointStore.saveWithEvents(userId, sessionId, { checkpoint: session.checkpoint });
    await taskStore.attachSession(userId, run.id, sessionId);
  } catch (error) {
    return failRun(error, sessionId);
  }

  let abortReason = null;
  let result;
  try {
    result = await machine.run({
      userId,
      sessionId,
      submission: {
        id: `schedule-${run.id}-${run.attempts}`,
        op: { type: "message", message: { text: prepared.text } },
      },
      signal: AbortSignal.timeout(turnTimeoutMs),
      toolSpecs: tooling.specs ?? [],
      onEvent(event) {
        if (event?.msg?.type === EventMsgType.TURN_ABORTED) abortReason = event.msg.reason ?? null;
      },
    });
  } catch (error) {
    return failRun(error, sessionId);
  }

  const checkpoint = result.checkpoint;
  const stats = {
    sessionId,
    turnStatus: result.status,
    abortReason,
    modelSteps: checkpoint.executionStats?.modelSteps ?? 0,
    toolCalls: checkpoint.executionStats?.toolCalls ?? 0,
    totalTokens: checkpoint.totalUsage?.total_tokens ?? 0,
  };
  let status;
  let error = null;
  if (result.status === "completed") {
    status = RunStatus.SUCCEEDED;
  } else if (result.status === "suspended") {
    status = RunStatus.AWAITING_APPROVAL;
  } else if (SKIP_REASONS.has(abortReason)) {
    status = RunStatus.SKIPPED;
    error = abortReason;
  } else {
    status = RunStatus.FAILED;
    error = abortReason ?? "aborted";
  }

  const summaryText = lastAssistantText(checkpoint.transcript);
  if (status === RunStatus.SUCCEEDED) {
    const state = stateFromResponse(summaryText, { runId: run.id, at: clock() });
    if (state) {
      await checkpointStore.saveMiddlewareState(
        userId,
        sessionId,
        operatorStateKey(task.id),
        state
      );
    }
  }
  await finish({
    status,
    error,
    result: { ...stats, summary: summaryText.slice(0, 1000) },
  });
  await safeAudit(audit, {
    userId,
    action: `schedule.run_${status.toLowerCase()}`,
    resource: task.id,
    summary: `run ${run.id} session ${sessionId}${error ? `: ${error}` : ""}`,
  });
  return { taskId: task.id, runId: run.id, sessionId, status };
}
