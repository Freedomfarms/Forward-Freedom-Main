// CHIEF approvals — list pending tool batches and submit a decision.
//
// BUILD NEW thin shell. The decision is an ExecApproval op run by the same
// turn machine as /api/chief/chat, so resume-from-approval has one implementation.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { createManagedClient, runManagedChiefTurn } from "../../server/chief/managed/chatTurn.js";
import { MANAGED_ORIGIN, MANAGED_SCHEDULE_ORIGIN } from "../../server/chief/managed/productionAgent.js";
import { PrismaFactStore } from "../../server/chief/memory/facts.js";
import { PrismaCheckpointStore } from "../../server/chief/runtime/checkpoint.js";
import { PrismaTaskStore } from "../../server/chief/scheduler/store.js";
import { settleScheduledSession } from "../../server/chief/scheduler/tick.js";
import { createChiefTooling } from "../../server/chief/tools/builtin.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";

async function toolingFor(deps, userId) {
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

  const existing = await store.load(userId, body.session_id);
  const origin = existing?.checkpoint?.context?.origin;
  if (origin !== MANAGED_ORIGIN && origin !== MANAGED_SCHEDULE_ORIGIN) {
    response.status(409).json({
      error: "This approval belongs to the previous CHIEF runtime. Start a new conversation.",
    });
    return;
  }

  const built = await toolingFor(deps, userId);
  if (built.error) {
    response.status(503).json({ error: built.error });
    return;
  }
  let client = Object.hasOwn(deps, "client") ? deps.client : null;
  if (!client && !Object.hasOwn(deps, "client")) {
    try {
      client = (deps.createClient ?? createManagedClient)();
    } catch (error) {
      response.status(error.status || 503).json({
        error: "Claude Managed Agents is not configured. Set ANTHROPIC_API_KEY on the server.",
      });
      return;
    }
  }
  const taskStore = Object.hasOwn(deps, "taskStore")
    ? deps.taskStore
    : origin === MANAGED_SCHEDULE_ORIGIN
      ? new PrismaTaskStore()
      : null;
  let result = null;
  let turnError = null;
  try {
    result = await runManagedChiefTurn({
      userId,
      sessionId: body.session_id,
      submission: body.submission,
      store,
      client,
      toolExecutor: built.toolExecutor,
      toolSpecs: built.toolSpecs,
      bindings: deps.bindings,
      threads: deps.threads,
      jobs: deps.jobs,
      sleepFn: deps.sleepFn,
      budgetMs: deps.budgetMs,
    });
  } catch (error) {
    turnError = error;
  }
  if (origin === MANAGED_SCHEDULE_ORIGIN && taskStore) {
    try {
      await (deps.settleScheduledSession ?? settleScheduledSession)({
        userId,
        sessionId: body.session_id,
        taskStore,
        checkpointStore: store,
        turnResult: result,
        error: turnError,
        clock: deps.clock,
      });
    } catch {
      // The run stays open when the finish write fails.
    }
  }
  if (turnError) {
    response.status(400).json({ error: turnError.message || "approval failed" });
    console.error("[chief/approvals]", turnError?.name || "Error");
    return;
  }
  response.status(200).json({
    sessionId: result.sessionId,
    status: result.status,
    pendingApproval: result.checkpoint?.pendingApproval
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
