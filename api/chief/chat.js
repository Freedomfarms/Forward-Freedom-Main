// CHIEF chat — one turn invocation over SSE.
//
// BUILD NEW thin shell (docs/CHIEF_ARCHITECTURE.md §8.4): auth, then the
// ported turn machine. No domain decisions live here. Model calls go through
// ChiefModelEngine; tools go through ToolExecutor.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { EventBus } from "../../server/chief/core/events.js";
import { PrismaBudgetStore } from "../../server/chief/models/budget.js";
import { createModelEngine } from "../../server/chief/models/engine.js";
import {
  encodeSseEvent,
  eventMsg,
  EventMsgType,
  makeEvent,
} from "../../server/chief/protocol/index.js";
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

function defaultDeps() {
  return {
    store: new PrismaCheckpointStore(),
    engine: createModelEngine({ budget: new PrismaBudgetStore() }),
    toolExecutor: null,
    taskStore: new PrismaTaskStore(),
    authenticate: authenticateRequest,
  };
}

export async function handleChiefChat(request, response, deps = {}) {
  applySecurityHeaders(response);
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;
  if (request.method !== "POST") {
    response.status(405).json({ error: "POST required" });
    return;
  }

  const authenticate = deps.authenticate ?? authenticateRequest;
  let userId;
  try {
    userId = (await authenticate(request)).uid;
  } catch (error) {
    response.status(error.status || 401).json({ error: error.message || "Unauthorized" });
    return;
  }

  const body = request.body ?? {};
  if (!body.submission) {
    response.status(400).json({ error: "submission is required" });
    return;
  }

  response.status(200);
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  const controller = new AbortController();
  request.on?.("close", () => controller.abort());

  const store = deps.store ?? new PrismaCheckpointStore();
  const eventBus = deps.eventBus ?? new EventBus();
  const engine = deps.engine ?? createModelEngine({ budget: new PrismaBudgetStore(), eventBus });
  const traceStore = Object.hasOwn(deps, "traceStore")
    ? deps.traceStore
    : deps.engine
      ? null
      : new PrismaTraceStore();
  let toolExecutor = deps.toolExecutor ?? null;
  let toolSpecs = deps.toolSpecs ?? null;
  let facts = deps.facts ?? null;
  let capabilityPolicy = null;
  if (!toolExecutor) {
    facts = facts ?? deps.stores?.facts ?? new PrismaFactStore();
    const tooling = await createChiefTooling({
      userId,
      stores: deps.stores ?? { facts },
      policy: deps.policy,
      audit: deps.audit,
      bus: eventBus,
    });
    toolExecutor = tooling.executor;
    toolSpecs = deps.toolSpecs ?? tooling.specs;
    capabilityPolicy = tooling.policy;
  }
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
    (facts && !deps.toolExecutor
      ? createChiefTurnServices({
          facts,
          engine,
          checkpointStore: store,
          capabilityPolicy,
          eventBus,
          moduleAccess: deps.moduleAccess ?? new PrismaModuleAccess(),
        })
      : {});

  const machine = new TurnMachine({
    store,
    engine,
    approvals: new ApprovalCoordinator(),
    toolExecutor,
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
      sessionId: body.session_id ?? null,
      submission: body.submission,
      signal: controller.signal,
      toolSpecs: toolSpecs ?? [],
      onEvent: (event) => {
        if (event?.msg?.type === EventMsgType.TURN_ABORTED) abortReason = event.msg.reason ?? null;
        response.write(encodeSseEvent(event));
      },
    });
  } catch (error) {
    turnError = error;
  }
  if (awaiting && taskStore && body.session_id) {
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
    response.write(
      encodeSseEvent(
        makeEvent(
          eventMsg.error({
            kind: "internal",
            message: "The turn could not be completed.",
            retryable: true,
          })
        )
      )
    );
    console.error("[chief/chat]", turnError?.name || "Error");
  } else {
    response.write(
      encodeSseEvent(
        makeEvent({
          type: "session_configured",
          session_id: result.sessionId,
          status: result.status,
        })
      )
    );
  }
  response.end();
}

export default function handler(request, response) {
  return handleChiefChat(request, response, defaultDeps());
}
