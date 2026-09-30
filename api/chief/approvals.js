// CHIEF approvals — list pending tool batches and submit a decision.
//
// BUILD NEW thin shell. The decision is an ExecApproval op run by the same
// turn machine as /api/chief/chat, so resume-from-approval has one implementation.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { PrismaBudgetStore } from "../../server/chief/models/budget.js";
import { createModelEngine } from "../../server/chief/models/engine.js";
import { ApprovalCoordinator } from "../../server/chief/runtime/approvals.js";
import { createChiefTurnServices } from "../../server/chief/context/wire.js";
import { PrismaFactStore } from "../../server/chief/memory/facts.js";
import { PrismaCheckpointStore } from "../../server/chief/runtime/checkpoint.js";
import { TurnMachine } from "../../server/chief/runtime/turn.js";
import { ToolExecutor } from "../../server/chief/tools/executor.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";

function machineFrom(deps) {
  const store = deps.store ?? new PrismaCheckpointStore();
  const engine = deps.engine ?? createModelEngine({ budget: new PrismaBudgetStore() });
  const facts = deps.facts ?? (deps.toolExecutor ? null : new PrismaFactStore());
  const turnServices =
    deps.turnServices ??
    (facts && !deps.toolExecutor
      ? createChiefTurnServices({ facts, engine, checkpointStore: store })
      : {});
  return new TurnMachine({
    store,
    engine,
    approvals: new ApprovalCoordinator(),
    toolExecutor: deps.toolExecutor ?? new ToolExecutor(),
    contextAssembler: turnServices.contextAssembler ?? null,
    compaction: turnServices.compaction ?? null,
    onTurnComplete: turnServices.onTurnComplete ?? null,
  });
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

  try {
    const result = await machineFrom({ ...deps, store }).run({
      userId,
      sessionId: body.session_id,
      submission: body.submission,
      toolSpecs: deps.toolSpecs ?? [],
    });
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
  } catch (error) {
    response.status(400).json({ error: error.message || "approval failed" });
  }
}

export default function handler(request, response) {
  return handleChiefApprovals(request, response);
}
