// CHIEF scheduled-approval resume — finish the run that is already waiting.
//
// ADAPT of möbius (citizenhicks, Apache-2.0)
//   Upstream: https://github.com/citizenhicks/mobius
//   Source file: crates/mobius-gateway/src/host/session/events.rs
//     (observe_routine_event)
//   Commit: 3e1aaf5039f5069c3142861cb145fc0fb5521284
//
// Preserved upstream semantics:
//   - an approval request does not finish the routine
//   - the same session continues until the turn completes or aborts
// Adaptations:
//   - This file does not run a model, execute a tool, or decide an approval.
//     TurnMachine resumes the session. ToolExecutor runs the tool.
//     ApprovalCoordinator records the decision.
//   - The signed-in user submits the decision. The caller stays "schedule"
//     so the run keeps its budget, trace, and task identity.
//   - Nothing here claims a task or moves nextRunAt.

import {
  lastAssistantText,
  operatorStateKey,
  quietAttention,
  stateFromResponse,
} from "./operative.js";
import { RunStatus } from "./store.js";

const SKIP_REASONS = new Set(["budget_exceeded", "ModelLayerPausedError"]);

function errorSummary(error) {
  const name = error?.name || "Error";
  const message = String(error?.message ?? "").slice(0, 300);
  return message ? `${name}: ${message}` : name;
}

export function scheduledCaller(awaiting) {
  const taskId = awaiting?.task?.id;
  if (!taskId) return null;
  return { callerKind: "schedule", callerTrigger: `schedule:${taskId}` };
}

export function mapScheduledResume({ status, abortReason = null, thrown = null } = {}) {
  if (thrown) return { status: RunStatus.FAILED, error: errorSummary(thrown) };
  if (status === "completed") return { status: RunStatus.SUCCEEDED, error: null };
  if (status === "suspended") return { status: RunStatus.AWAITING_APPROVAL, error: null };
  if (SKIP_REASONS.has(abortReason)) return { status: RunStatus.SKIPPED, error: abortReason };
  return { status: RunStatus.FAILED, error: abortReason ?? status ?? "aborted" };
}

export async function completeAwaitingScheduledRun({
  userId,
  sessionId,
  taskStore,
  checkpointStore = null,
  turnResult = null,
  error = null,
  abortReason = null,
  clock = () => new Date(),
} = {}) {
  if (!userId || !sessionId || !taskStore?.findAwaitingBySession) return { updated: false };
  const awaiting = await taskStore.findAwaitingBySession(userId, sessionId);
  if (!awaiting) return { updated: false };

  const mapped = mapScheduledResume({
    status: turnResult?.status,
    abortReason,
    thrown: error,
  });
  const terminal =
    mapped.status === RunStatus.SUCCEEDED ||
    mapped.status === RunStatus.FAILED ||
    mapped.status === RunStatus.SKIPPED;
  const checkpoint = turnResult?.checkpoint ?? null;
  const summaryText = checkpoint ? lastAssistantText(checkpoint.transcript) : "";
  const result =
    mapped.status === RunStatus.AWAITING_APPROVAL
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
  const finished = await taskStore.finish(userId, {
    taskId: awaiting.task.id,
    runId: awaiting.run.id,
    status: mapped.status,
    error: mapped.error,
    result,
    completeTask: awaiting.task.kind === "ONCE" && terminal,
    now,
    onlyFrom: RunStatus.AWAITING_APPROVAL,
    preserveNextRunAt: true,
  });
  if (!finished?.updated) {
    return {
      updated: false,
      status: awaiting.run.status,
      runId: awaiting.run.id,
      taskId: awaiting.task.id,
    };
  }
  if (mapped.status === RunStatus.SUCCEEDED && checkpointStore) {
    const state = stateFromResponse(summaryText, { runId: awaiting.run.id, at: now });
    if (state) {
      await checkpointStore.saveMiddlewareState(
        userId,
        sessionId,
        operatorStateKey(awaiting.task.id),
        state
      );
    }
  }
  return { updated: true, status: mapped.status, runId: awaiting.run.id, taskId: awaiting.task.id };
}
