import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { withUserContext } from "../../server/db/prisma.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";
import { readJsonBody, readPathParam } from "../../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { AgentError } from "../../server/agents/errors.js";
import {
  respondAgentApiError,
  serializeAgentConfig,
  validateAgentUpdatePayload,
} from "../../server/agents/apiHelpers.js";

// PATCH  /api/agents/:id — update name / instructions / definitionOfDone /
//        schedule preset / status / toolAccess. permissionLevel and agentType
//        are immutable via the API (validateAgentUpdatePayload rejects them).
// DELETE /api/agents/:id — delete the config; AgentRun rows survive with
//        agentConfigId NULL (schema onDelete: SetNull) as the audit trail.

async function loadOwnedAgent(tx, userId, agentId) {
  // RLS already scopes the transaction to this user; the explicit userId
  // filter is defense in depth.
  const agent = await tx.agentConfig.findFirst({ where: { id: agentId, userId } });
  if (!agent) {
    throw new AgentError("Agent not found.", "AGENT_NOT_FOUND", 404);
  }
  return agent;
}

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!["PATCH", "DELETE"].includes(request.method || "")) {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  try {
    const decodedToken = await authenticateRequest(request);
    const agentId = readPathParam(request, "id");
    if (!agentId) {
      throw new AgentError("An agent id is required.", "INVALID_AGENT_PAYLOAD", 400);
    }

    if (request.method === "PATCH") {
      const data = validateAgentUpdatePayload(await readJsonBody(request));
      const updated = await withUserContext(decodedToken.uid, async (tx) => {
        const agent = await loadOwnedAgent(tx, decodedToken.uid, agentId);
        return tx.agentConfig.update({ where: { id: agent.id }, data });
      });
      return response.status(200).json({ agent: serializeAgentConfig(updated) });
    }

    await withUserContext(decodedToken.uid, async (tx) => {
      const agent = await loadOwnedAgent(tx, decodedToken.uid, agentId);
      await tx.agentConfig.delete({ where: { id: agent.id } });
    });
    return response.status(200).json({ deleted: true });
  } catch (error) {
    return respondAgentApiError(
      response,
      "api/agents/[id]",
      error,
      "Unable to update or delete the agent."
    );
  }
}
