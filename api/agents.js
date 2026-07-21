import { authenticateRequest } from "../server/auth/verifyAuth.js";
import { withUserContext } from "../server/db/prisma.js";
import { enforceRateLimit, generalApiRateLimit } from "../server/http/rateLimit.js";
import { readJsonBody } from "../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../server/http/responseHelpers.js";
import {
  createAgentConfig,
  respondAgentApiError,
  serializeAgentConfig,
  validateAgentCreatePayload,
} from "../server/agents/apiHelpers.js";

// GET  /api/agents — the user's sub-agents, each with its latest run summary.
// POST /api/agents — create a sub-agent. permissionLevel READ_ONLY and status
// ACTIVE are pinned inside createAgentConfig (never read from the payload).
//
// This file lives at api/agents.js (sibling to api/agents/) — the same layout
// as api/notifications.js — so Vercel registers /api/agents as a function.
// api/agents/index.js is intentionally not used; directory index handlers can
// surface as body-less 403s on some Vercel deployments.

const AGENT_LIST_SELECT = Object.freeze({
  id: true,
  agentType: true,
  name: true,
  instructions: true,
  definitionOfDone: true,
  permissionLevel: true,
  status: true,
  toolAccess: true,
  schedule: true,
  createdAt: true,
  updatedAt: true,
});

const LATEST_RUN_SELECT = Object.freeze({
  id: true,
  agentConfigId: true,
  agentType: true,
  status: true,
  summary: true,
  error: true,
  dataAccessed: true,
  model: true,
  tokensInput: true,
  tokensOutput: true,
  estimatedCostUsd: true,
  startedAt: true,
  completedAt: true,
});

/** Latest run per agent without Prisma `distinct` (fragile on Postgres). */
function pickLatestRunByAgentId(runs) {
  const latestByAgentId = new Map();
  for (const run of runs) {
    if (!run?.agentConfigId || latestByAgentId.has(run.agentConfigId)) continue;
    latestByAgentId.set(run.agentConfigId, run);
  }
  return latestByAgentId;
}

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!["GET", "POST"].includes(request.method || "")) {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  try {
    const decodedToken = await authenticateRequest(request);

    if (request.method === "GET") {
      const { agents, latestRuns } = await withUserContext(decodedToken.uid, async (tx) => {
        const agentRows = await tx.agentConfig.findMany({
          where: { userId: decodedToken.uid },
          orderBy: { createdAt: "asc" },
          select: AGENT_LIST_SELECT,
        });
        const agentIds = agentRows.map((agent) => agent.id);
        const latestRunRows = agentIds.length
          ? await tx.agentRun.findMany({
              where: { userId: decodedToken.uid, agentConfigId: { in: agentIds } },
              orderBy: { startedAt: "desc" },
              select: LATEST_RUN_SELECT,
            })
          : [];
        return { agents: agentRows, latestRuns: latestRunRows };
      });

      const latestByAgentId = pickLatestRunByAgentId(latestRuns);
      return response.status(200).json({
        agents: agents.map((agent) =>
          serializeAgentConfig(agent, { latestRun: latestByAgentId.get(agent.id) ?? null })
        ),
      });
    }

    const validated = validateAgentCreatePayload(await readJsonBody(request));
    const agent = await withUserContext(decodedToken.uid, (tx) =>
      createAgentConfig(tx, decodedToken.uid, validated)
    );
    return response.status(201).json({ agent: serializeAgentConfig(agent, { latestRun: null }) });
  } catch (error) {
    return respondAgentApiError(
      response,
      "api/agents",
      error,
      "Unable to list or create agents."
    );
  }
}
