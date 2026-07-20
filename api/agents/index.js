import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { withUserContext } from "../../server/db/prisma.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";
import { readJsonBody } from "../../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import {
  createAgentConfig,
  respondAgentApiError,
  serializeAgentConfig,
  validateAgentCreatePayload,
} from "../../server/agents/apiHelpers.js";

// GET  /api/agents — the user's sub-agents, each with its latest run summary.
// POST /api/agents — create a sub-agent. permissionLevel READ_ONLY and status
// ACTIVE are pinned inside createAgentConfig (never read from the payload).

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
        });
        // One query: latest run per agent via distinct on agentConfigId over
        // the startedAt-descending order.
        const latestRunRows = agentRows.length
          ? await tx.agentRun.findMany({
              where: { userId: decodedToken.uid, agentConfigId: { not: null } },
              orderBy: { startedAt: "desc" },
              distinct: ["agentConfigId"],
            })
          : [];
        return { agents: agentRows, latestRuns: latestRunRows };
      });

      const latestByAgentId = new Map(latestRuns.map((run) => [run.agentConfigId, run]));
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
