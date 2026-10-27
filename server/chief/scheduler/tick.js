// CHIEF operative tick — the scheduler decides when. Claude Managed Agents
// decides how. Claim, recurrence, and run records stay here. There is no
// legacy reasoning fallback.
//
// A due task is claimed, then a managed-schedule session is queued. The same
// cron request starts the session. If the provider is still working when the
// request budget ends, the durable work row resumes it on a later cron.
// A requiresConfirmation tool suspends the run for the signed-in user.
//
// When an execution ledger is supplied, this tick also reads nonterminal
// coding runs. That read does not submit, grant, merge, or deploy.

import { runManagedChiefTurn } from "../managed/chatTurn.js";
import { codingRuntimeFor, pollCodingExecutions } from "./codingFollow.js";
import { MANAGED_SCHEDULE_ORIGIN } from "../managed/productionAgent.js";
import {
  lastAssistantText,
  operatorStateKey,
  prepareScheduledMessage,
  quietAttention,
  stateFromResponse,
} from "./operative.js";
import { isTransientNetworkError, planRetry, reachedModel } from "./retry.js";
import { completeAwaitingScheduledRun } from "./resume.js";
import { RunStatus } from "./store.js";

export const LOCK_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_TICK_LIMIT = 3;
export const DEFAULT_TURN_TIMEOUT_MS = 20_000;
const MAX_SCHEDULE_RESUMES = 3;
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
  createTooling,
  client = null,
  jobs = null,
  bindings = null,
  threads = null,
  runTurn = runManagedChiefTurn,
  audit = null,
  clock = () => new Date(),
  limit = DEFAULT_TICK_LIMIT,
  turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  tickBudgetMs = DEFAULT_TICK_BUDGET_MS,
  executionStore = null,
  codingRuntime = null,
  documentStore = null,
} = {}) {
  if (!taskStore || !checkpointStore) {
    throw new TypeError("runChiefTick requires taskStore and checkpointStore");
  }
  const startedAt = clock();
  const staleBefore = new Date(startedAt.getTime() - LOCK_TTL_MS);
  const report = { recovered: 0, resumed: 0, initialized: 0, paused: 0, runs: [] };

  for (const stale of await taskStore.listStaleRuns(staleBefore)) {
    const resumed = await resumeInterruptedRun({
      stale,
      taskStore,
      checkpointStore,
      jobs,
      clock,
    });
    if (resumed) {
      report.resumed += 1;
      continue;
    }
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

  if (executionStore) {
    try {
      report.coding = await pollCodingExecutions({
        executionStore,
        runtime: codingRuntime || codingRuntimeFor(process.env, executionStore),
        documentStore,
        checkpointStore,
        jobs,
      });
    } catch {
      report.coding = { polled: 0, skipped: "error", reported: 0, enqueued: 0 };
    }
  }

  if (!client) {
    report.blocked = "ANTHROPIC_API_KEY";
    return report;
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
        createTooling,
        client,
        jobs,
        bindings,
        threads,
        runTurn,
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
  createTooling,
  client,
  jobs,
  bindings,
  threads,
  runTurn,
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
      now: clock(),
      ...fields,
      // A suspended turn is not finished. A ONCE task stays ACTIVE until the
      // approval resume reaches a terminal outcome (ADR-0011).
      completeTask:
        task.kind === "ONCE" &&
        fields.status !== RunStatus.RETRYING &&
        fields.status !== RunStatus.AWAITING_APPROVAL,
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

  const scheduleCaller = { kind: "schedule", trigger: `schedule:${task.id}` };
  let sessionId = null;
  try {
    const session = await checkpointStore.createSession({
      userId,
      context: {
        origin: MANAGED_SCHEDULE_ORIGIN,
        scheduledTaskId: task.id,
        runId: run.id,
        pendingPrompt: prepared.text,
        scheduleCaller,
        scheduleKind: task.kind,
      },
    });
    sessionId = session.id;
    session.checkpoint.sessionTaint = prepared.sessionTaint;
    await checkpointStore.saveWithEvents(userId, sessionId, { checkpoint: session.checkpoint });
    await taskStore.attachSession(userId, run.id, sessionId);
  } catch (error) {
    return failRun(error, sessionId);
  }

  let tooling = { executor: null, specs: [] };
  try {
    if (createTooling) tooling = await createTooling({ userId });
  } catch (error) {
    return failRun(error, sessionId);
  }

  let result;
  try {
    result = await runTurn({
      userId,
      sessionId,
      store: checkpointStore,
      client,
      toolExecutor: tooling.executor ?? tooling.toolExecutor ?? null,
      toolSpecs: tooling.specs ?? [],
      jobs,
      bindings,
      threads,
      resume: true,
      caller: scheduleCaller,
      budgetMs: turnTimeoutMs,
    });
  } catch (error) {
    return failRun(error, sessionId);
  }

  if (result?.status === "continuing") {
    return { taskId: task.id, runId: run.id, sessionId, status: "continuing" };
  }
  const settled = await settleScheduledSession({
    userId,
    sessionId,
    taskStore,
    checkpointStore,
    audit,
    turnResult: result,
    clock,
  });
  return {
    taskId: task.id,
    runId: run.id,
    sessionId,
    status: settled.status ?? result?.status,
  };
}

export async function settleScheduledSession({
  userId,
  sessionId,
  taskStore,
  checkpointStore = null,
  audit = null,
  turnResult = null,
  error = null,
  clock = () => new Date(),
} = {}) {
  if (!userId || !sessionId || !taskStore?.findOpenBySession) {
    return { updated: false, keepQueued: false };
  }
  const open = await taskStore.findOpenBySession(userId, sessionId);
  if (!open) return { updated: false, keepQueued: false };
  if (turnResult?.status === "continuing") return { updated: false, keepQueued: true, status: "continuing" };

  const loaded = checkpointStore ? await checkpointStore.load(userId, sessionId) : null;
  const checkpoint = turnResult?.checkpoint ?? loaded?.checkpoint ?? null;
  if (error && isTransientNetworkError(error) && reachedModel(checkpoint)) {
    return { updated: false, keepQueued: true };
  }

  if (open.run.status === RunStatus.AWAITING_APPROVAL) {
    const updated = await completeAwaitingScheduledRun({
      userId,
      sessionId,
      taskStore,
      checkpointStore,
      turnResult,
      error,
      abortReason: turnResult?.abortReason ?? null,
      clock,
    });
    return { ...updated, keepQueued: false };
  }

  if (error) {
    const retryAt = planRetry({
      task: open.task,
      error,
      checkpoint,
      attempts: open.run.attempts,
      naturalNext: open.task.nextRunAt,
      now: clock(),
    });
    const status = retryAt ? RunStatus.RETRYING : RunStatus.FAILED;
    await taskStore.finish(userId, {
      taskId: open.task.id,
      runId: open.run.id,
      status,
      error: errorSummary(error),
      retryAt,
      completeTask: open.task.kind === "ONCE" && !retryAt,
      now: clock(),
    });
    await safeAudit(audit, {
      userId,
      action: retryAt ? "schedule.run_retrying" : "schedule.run_failed",
      resource: open.task.id,
      summary: `run ${open.run.id} attempt ${open.run.attempts}: ${errorSummary(error)}`,
    });
    return { updated: true, keepQueued: false, status };
  }

  const abortReason = turnResult?.abortReason ?? null;
  let status;
  let failure = null;
  if (turnResult?.status === "completed") status = RunStatus.SUCCEEDED;
  else if (turnResult?.status === "suspended") status = RunStatus.AWAITING_APPROVAL;
  else if (SKIP_REASONS.has(abortReason)) {
    status = RunStatus.SKIPPED;
    failure = abortReason;
  } else {
    status = RunStatus.FAILED;
    failure = abortReason ?? turnResult?.status ?? "aborted";
  }
  const summaryText = lastAssistantText(checkpoint?.transcript);
  const result =
    status === RunStatus.AWAITING_APPROVAL
      ? null
      : {
          sessionId,
          turnStatus: turnResult?.status ?? null,
          abortReason,
          modelSteps: checkpoint?.executionStats?.modelSteps ?? 0,
          toolCalls: checkpoint?.executionStats?.toolCalls ?? 0,
          totalTokens: checkpoint?.totalUsage?.total_tokens ?? 0,
          summary: summaryText.slice(0, 1000),
          attention: quietAttention(),
        };
  const now = clock();
  await taskStore.finish(userId, {
    taskId: open.task.id,
    runId: open.run.id,
    status,
    error: failure,
    result,
    completeTask:
      open.task.kind === "ONCE" &&
      status !== RunStatus.RETRYING &&
      status !== RunStatus.AWAITING_APPROVAL,
    now,
  });
  if (status === RunStatus.SUCCEEDED && checkpointStore) {
    const state = stateFromResponse(summaryText, { runId: open.run.id, at: now });
    if (state) {
      await checkpointStore.saveMiddlewareState(
        userId,
        sessionId,
        operatorStateKey(open.task.id),
        state
      );
    }
  }
  await safeAudit(audit, {
    userId,
    action: `schedule.run_${status.toLowerCase()}`,
    resource: open.task.id,
    summary: `run ${open.run.id} session ${sessionId}${failure ? `: ${failure}` : ""}`,
  });
  return { updated: true, keepQueued: false, status };
}

async function resumeInterruptedRun({ stale, checkpointStore, jobs }) {
  if (!jobs || !stale.sessionId) return false;
  const record = await checkpointStore.load(stale.userId, stale.sessionId);
  const context = record?.checkpoint?.context;
  if (context?.origin !== MANAGED_SCHEDULE_ORIGIN) return false;
  const managed = context.managed;
  if (!managed?.providerSessionId && !context.pendingPrompt) return false;
  const resumes = context.scheduleResumes ?? 0;
  if (resumes >= MAX_SCHEDULE_RESUMES) return false;
  record.checkpoint.context = { ...context, scheduleResumes: resumes + 1 };
  await checkpointStore.saveWithEvents(stale.userId, stale.sessionId, {
    checkpoint: record.checkpoint,
  });
  try {
    await jobs.enqueue({ userId: stale.userId, threadId: stale.sessionId });
  } catch {
    // The checkpoint still points at the provider session. The next tick retries.
  }
  return true;
}
