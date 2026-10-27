// GET /api/cron/chief-dispatch — CHIEF scheduler tick (vercel.json cron).
//
// Cron auth, then runChiefTick. The tick claims due tasks and asks Claude
// Managed Agents to do the work. It does not call the legacy turn machine.
// After the tick, queued managed work — chat continuations and scheduled
// sessions that did not finish in this request — is resumed. A missing
// ANTHROPIC_API_KEY is a 503. There is no legacy fallback.
//
// Authenticated by CRON_SECRET ("Authorization: Bearer <secret>", which
// Vercel Cron sends when CRON_SECRET is set, or ?secret=). Fails closed with
// 503 when CRON_SECRET is unset.

import crypto from "node:crypto";

import { readBearerToken } from "../../server/auth/verifyAuth.js";
import { createPrismaExecutionStore } from "../../server/chief/agents/ledger.js";
import { PrismaFactStore } from "../../server/chief/memory/facts.js";
import { createPrismaWorkspaceDocumentStore } from "../../server/chief/memory/workspaceDocuments.js";
import { createManagedClient, drainManagedWork } from "../../server/chief/managed/chatTurn.js";
import { createPrismaWorkQueue } from "../../server/chief/managed/workQueue.js";
import { PrismaCheckpointStore } from "../../server/chief/runtime/checkpoint.js";
import { PrismaTaskStore } from "../../server/chief/scheduler/store.js";
import { runChiefTick, settleScheduledSession } from "../../server/chief/scheduler/tick.js";
import { PrismaAuditLog } from "../../server/chief/security/audit.js";
import { createChiefTooling } from "../../server/chief/tools/builtin.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";

function secretMatches(provided, secret) {
  const a = crypto.createHash("sha256").update(String(provided)).digest();
  const b = crypto.createHash("sha256").update(String(secret)).digest();
  return crypto.timingSafeEqual(a, b);
}

function defaultDeps() {
  const audit = new PrismaAuditLog();
  const facts = new PrismaFactStore();
  const checkpointStore = new PrismaCheckpointStore();
  return {
    taskStore: new PrismaTaskStore(),
    checkpointStore,
    jobs: createPrismaWorkQueue(),
    createClient: () => createManagedClient(),
    createTooling: ({ userId }) => createChiefTooling({ userId, audit, stores: { facts } }),
    audit,
    executionStore: createPrismaExecutionStore(),
    documentStore: createPrismaWorkspaceDocumentStore(),
  };
}

export async function handleChiefDispatch(request, response, deps = {}) {
  applySecurityHeaders(response);
  if (request.method !== "GET") {
    response.status(405).json({ error: "GET required" });
    return;
  }
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    response.status(503).json({ error: "CHIEF dispatch is not configured (missing CRON_SECRET)" });
    return;
  }
  const provided = readBearerToken(request) || request.query?.secret || "";
  if (!provided || !secretMatches(provided, secret)) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const resolved = deps.taskStore ? deps : { ...defaultDeps(), ...deps };
    let client = Object.hasOwn(resolved, "client") ? resolved.client : null;
    if (!Object.hasOwn(resolved, "client")) {
      try {
        client = (resolved.createClient ?? createManagedClient)();
      } catch (error) {
        client = null;
        if (error?.status !== 503) throw error;
      }
    }
    const jobs = resolved.jobs ?? resolved.managedJobs ?? createPrismaWorkQueue();
    const report = await runChiefTick({ ...resolved, client, jobs });
    if (report.blocked === "ANTHROPIC_API_KEY") {
      response.status(503).json({
        ok: false,
        error: "Claude Managed Agents is not configured. Set ANTHROPIC_API_KEY on the server.",
        ...report,
      });
      return;
    }
    let managedDrain = { drained: 0 };
    try {
      managedDrain = await (deps.drainManagedWork ?? drainManagedWork)({
        store: resolved.checkpointStore,
        client,
        jobs,
        createTooling: resolved.createTooling,
        afterTurn: async ({ job, result, error }) =>
          (deps.settleScheduledSession ?? settleScheduledSession)({
            userId: job.userId,
            sessionId: job.threadId,
            taskStore: resolved.taskStore,
            checkpointStore: resolved.checkpointStore,
            audit: resolved.audit,
            turnResult: result,
            error,
          }),
      });
    } catch (error) {
      console.error("[chief/dispatch] managed", error?.name || "Error");
      managedDrain = { drained: 0, error: "drain_failed" };
    }
    response.status(200).json({ ok: true, ...report, managedDrain });
  } catch (error) {
    console.error("[chief/dispatch]", error?.name || "Error");
    response.status(error?.status === 503 ? 503 : 500).json({ error: "CHIEF tick failed" });
  }
}

export default function handler(request, response) {
  return handleChiefDispatch(request, response);
}
