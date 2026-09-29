// CHIEF chat — one turn invocation over SSE.
//
// BUILD NEW thin shell (docs/CHIEF_ARCHITECTURE.md §8.4): auth, then the
// ported turn machine. No domain decisions live here. Model calls go through
// ChiefModelEngine; tools go through ToolExecutor.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { PrismaBudgetStore } from "../../server/chief/models/budget.js";
import { createModelEngine } from "../../server/chief/models/engine.js";
import { encodeSseEvent, eventMsg, makeEvent } from "../../server/chief/protocol/index.js";
import { ApprovalCoordinator } from "../../server/chief/runtime/approvals.js";
import { PrismaCheckpointStore } from "../../server/chief/runtime/checkpoint.js";
import { TurnMachine } from "../../server/chief/runtime/turn.js";
import { createChiefTooling } from "../../server/chief/tools/builtin.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";

function defaultDeps() {
  return {
    store: new PrismaCheckpointStore(),
    engine: createModelEngine({ budget: new PrismaBudgetStore() }),
    toolExecutor: null,
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

  let toolExecutor = deps.toolExecutor ?? null;
  let toolSpecs = deps.toolSpecs ?? null;
  if (!toolExecutor) {
    const tooling = await createChiefTooling({ userId });
    toolExecutor = tooling.executor;
    toolSpecs = deps.toolSpecs ?? tooling.specs;
  }

  const machine = new TurnMachine({
    store: deps.store ?? new PrismaCheckpointStore(),
    engine: deps.engine ?? createModelEngine({ budget: new PrismaBudgetStore() }),
    approvals: new ApprovalCoordinator(),
    toolExecutor,
  });

  try {
    const result = await machine.run({
      userId,
      sessionId: body.session_id ?? null,
      submission: body.submission,
      signal: controller.signal,
      toolSpecs: toolSpecs ?? [],
      onEvent: (event) => {
        response.write(encodeSseEvent(event));
      },
    });
    response.write(
      encodeSseEvent(
        makeEvent({
          type: "session_configured",
          session_id: result.sessionId,
          status: result.status,
        })
      )
    );
  } catch (error) {
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
    console.error("[chief/chat]", error?.name || "Error");
  }
  response.end();
}

export default function handler(request, response) {
  return handleChiefChat(request, response, defaultDeps());
}
