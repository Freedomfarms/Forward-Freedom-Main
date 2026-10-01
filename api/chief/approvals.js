// CHIEF approvals — list pending tool batches and submit a decision.
//
// BUILD NEW thin shell. The decision is an ExecApproval op run by the same
// turn machine as /api/chief/chat, so resume-from-approval has one implementation.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { EventBus } from "../../server/chief/core/events.js";
import { PrismaBudgetStore } from "../../server/chief/models/budget.js";
import { createModelEngine } from "../../server/chief/models/engine.js";
import { EventMsgType } from "../../server/chief/protocol/index.js";
import { ApprovalCoordinator } from "../../server/chief/runtime/approvals.js";
import { createChiefTurnServices } from "../../server/chief/context/wire.js";
import { PrismaModuleAccess } from "../../server/chief/security/module-access.js";
import { PrismaFactStore } from "../../server/chief/memory/facts.js";
import { PrismaCheckpointStore } from "../../server/chief/runtime/checkpoint.js";
import { TurnMachine } from "../../server/chief/runtime/turn.js";
import { PrismaTraceStore } from "../../server/chief/traces/store.js";
import { createChiefTooling } from "../../server/chief/tools/builtin.js";
import { PrismaTaskStore } from "../../server/chief/scheduler/store.js";
import {
  completeAwaitingScheduledRun,
  scheduledCaller,
} from "../../server/chief/scheduler/resume.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";

async function toolingFor(deps, userId, eventBus) {
  if (deps.toolExecutor) {
    if (!deps.toolExecutor.gatesInstalled) return { error: "CHIEF tooling is unavailable." };
    return {
      toolExecutor: deps.toolExecutor,
      toolSpecs: deps.toolSpecs ?? [],
      facts: null,
      policy: null,
    };
  }
  const facts = deps.facts ?? new PrismaFactStore();
  try {
    const tooling = await (deps.createTooling ?? createChiefTooling)({
      userId,
      stores: deps.stores ?? { facts },
      policy: deps.policy,
      audit: deps.audit,
      bus: eventBus,
      mcpClient: deps.mcpClient,
    });
    if (!tooling?.executor?.gatesInstalled) return { error: "CHIEF tooling is unavailable." };
    return {
      toolExecutor: tooling.executor,
      toolSpecs: deps.toolSpecs ?? tooling.specs ?? [],
      facts,
      policy: tooling.policy ?? null,
    };
  } catch {
    return { error: "CHIEF tooling is unavailable." };
  }
}

export async function handleChiefApprovals(request, response, deps = {}) {
  applySecurityHeaders(response);
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;
  const authenticate = deps.authenticate ?? authenticateRequest;
  let userId;
  try {
    userId = (await authenticate(request)).uid;
  } catch (error) {
    response.status(error.status || 401).json({ error: error.message || "Unauthorized" });
    return;
  }

  const store = deps.store ?? new PrismaCheckpointStore();

  if (request.method === "GET") {
    const pending = await store.listPending(userId);
    response.status(200).json({
      approvals: pending.map((entry) => ({
        sessionId: entry.sessionId,
        id: entry.approval.id,
        turnId: entry.approval.turnId,
        reason: entry.approval.reason,
        calls: entry.approval.calls,
      })),
    });
    return;
  }

  if (request.method !== "POST") {
    response.status(405).json({ error: "GET or POST required" });
    return;
  }

  const body = request.body ?? {};
  if (!body.session_id || !body.submission) {
    response.status(400).json({ error: "session_id and submission are required" });
    return;
  }

  const eventBus = deps.eventBus ?? new EventBus();
  const built = await toolingFor(deps, userId, eventBus);
  if (built.error) {
    response.status(503).json({ error: built.error });
    return;
  }
  const engine = deps.engine ?? createModelEngine({ budget: new PrismaBudgetStore(), eventBus });
  const traceStore = Object.hasOwn(deps, "traceStore")
    ? deps.traceStore
    : deps.engine
      ? null
      : new PrismaTraceStore();
  const taskStore = Object.hasOwn(deps, "taskStore")
    ? deps.taskStore
    : deps.engine
      ? null
      : new PrismaTaskStore();
  const awaiting =
    taskStore && body.session_id
      ? await taskStore.findAwaitingBySession(userId, body.session_id)
      : null;
  const caller = scheduledCaller(awaiting) ?? {};
  const turnServices =
    deps.turnServices ??
    (built.facts && !deps.toolExecutor
      ? createChiefTurnServices({
          facts: built.facts,
          engine,
          checkpointStore: store,
          capabilityPolicy: built.policy,
          eventBus,
          moduleAccess: deps.moduleAccess ?? new PrismaModuleAccess(),
        })
      : {});
  const machine = new TurnMachine({
    store,
    engine,
    approvals: new ApprovalCoordinator(),
    toolExecutor: built.toolExecutor,
    contextAssembler: turnServices.contextAssembler ?? null,
    compaction: turnServices.compaction ?? null,
    onTurnComplete: turnServices.onTurnComplete ?? null,
    traceStore,
    eventBus,
    ...caller,
  });

  let abortReason = null;
  let result = null;
  let turnError = null;
  try {
    result = await machine.run({
      userId,
      sessionId: body.session_id,
      submission: body.submission,
      toolSpecs: built.toolSpecs,
      onEvent(event) {
        if (event?.msg?.type === EventMsgType.TURN_ABORTED) abortReason = event.msg.reason ?? null;
      },
    });
  } catch (error) {
    turnError = error;
  }
  if (taskStore) {
    try {
      await completeAwaitingScheduledRun({
        userId,
        sessionId: body.session_id,
        taskStore,
        checkpointStore: store,
        turnResult: result,
        error: turnError,
        abortReason,
        clock: deps.clock,
      });
    } catch {
      // The run stays AWAITING_APPROVAL when the finish write fails.
    }
  }
  if (turnError) {
    response.status(400).json({ error: turnError.message || "approval failed" });
    return;
  }
  response.status(200).json({
    sessionId: result.sessionId,
    status: result.status,
    pendingApproval: result.checkpoint.pendingApproval
      ? {
          id: result.checkpoint.pendingApproval.id,
          turnId: result.checkpoint.pendingApproval.turnId,
        }
      : null,
  });
}

export default function handler(request, response) {
  return handleChiefApprovals(request, response);
}
