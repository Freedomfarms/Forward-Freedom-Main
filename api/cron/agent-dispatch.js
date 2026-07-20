import crypto from "crypto";

import { readBearerToken } from "../../server/auth/verifyAuth.js";
import { getServicePrismaClient } from "../../server/db/servicePrisma.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { respondInternalError } from "../../server/http/errorHelpers.js";
import { isAgentDue } from "../../server/agents/schedule.js";
import { runAgent } from "../../server/agents/runner.js";
import { generateDigest } from "../../server/agents/digest.js";

// GET /api/cron/agent-dispatch — the Vercel Cron entry point (vercel.json
// schedules it every 15 minutes). No Firebase auth: authenticated by
// CRON_SECRET via "Authorization: Bearer <secret>" (what Vercel Cron sends
// when the CRON_SECRET env var is set) or, as a fallback, ?secret=.
//
// The service-role client (BYPASSRLS) is used ONLY to enumerate due agents
// across users — the moment a due agent's owner is known, the actual run
// executes through runAgent, which does all its work inside
// withUserContext(userId, ...). Every safety gate (PAUSED, permission level,
// unbuilt types) is re-checked by the runner per run.

// Cap work per invocation to stay inside the serverless function timeout;
// remaining due agents are picked up by the next 15-minute tick.
const MAX_RUNS_PER_INVOCATION = 20;

function timingSafeEquals(a, b) {
  const hashA = crypto.createHash("sha256").update(String(a)).digest();
  const hashB = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function isAuthorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed when unconfigured
  const provided = readBearerToken(request) || request.query?.secret || "";
  return Boolean(provided) && timingSafeEquals(provided, secret);
}

async function findDueAgents(service, now) {
  const candidates = await service.agentConfig.findMany({
    where: { status: "ACTIVE", schedule: { not: null } },
    select: { id: true, userId: true, schedule: true },
  });
  if (!candidates.length) return [];

  // Latest run per candidate agent in one query (any trigger counts — a
  // manual run inside the window also satisfies the schedule).
  const latestRuns = await service.agentRun.findMany({
    where: { agentConfigId: { in: candidates.map((agent) => agent.id) } },
    orderBy: { startedAt: "desc" },
    distinct: ["agentConfigId"],
    select: { agentConfigId: true, startedAt: true },
  });
  const lastRunByAgentId = new Map(latestRuns.map((run) => [run.agentConfigId, run.startedAt]));

  return candidates.filter((agent) =>
    isAgentDue(agent.schedule, lastRunByAgentId.get(agent.id) ?? null, now)
  );
}

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (request.method !== "GET") {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  if (!process.env.CRON_SECRET) {
    return response
      .status(503)
      .json({ error: true, message: "Cron dispatch is not configured (missing CRON_SECRET)." });
  }
  if (!isAuthorized(request)) {
    return response.status(401).json({ error: true, message: "Invalid cron secret." });
  }

  try {
    const service = getServicePrismaClient();
    if (!service) {
      return response
        .status(503)
        .json({ error: true, message: "Database is not configured for cron dispatch." });
    }

    const now = new Date();
    const dueAgents = await findDueAgents(service, now);
    const toRun = dueAgents.slice(0, MAX_RUNS_PER_INVOCATION);

    let processed = 0;
    const errors = [];
    const successfulUserIds = new Set();
    for (const agent of toRun) {
      try {
        const run = await runAgent({
          userId: agent.userId,
          agentConfigId: agent.id,
          trigger: "cron",
        });
        processed += 1;
        if (run?.status === "SUCCEEDED") {
          successfulUserIds.add(agent.userId);
        }
      } catch (error) {
        errors.push(`agent ${agent.id}: ${error?.message || "unknown error"}`);
      }
    }

    // Best-effort digest refresh for users whose agents produced new results,
    // so their next dashboard visit shows a current digest without an
    // on-request LLM call. Failures never fail the dispatch.
    for (const userId of successfulUserIds) {
      try {
        await generateDigest(userId);
      } catch {
        // Best-effort by contract.
      }
    }

    return response.status(200).json({
      processed,
      skipped: dueAgents.length - toRun.length,
      errors,
    });
  } catch (error) {
    return respondInternalError(
      response,
      "api/cron/agent-dispatch",
      error,
      "Cron dispatch failed."
    );
  }
}
