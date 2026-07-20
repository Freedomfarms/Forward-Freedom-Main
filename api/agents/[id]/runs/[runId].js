import { authenticateRequest } from "../../../../server/auth/verifyAuth.js";
import { withUserContext } from "../../../../server/db/prisma.js";
import { enforceRateLimit, generalApiRateLimit } from "../../../../server/http/rateLimit.js";
import { readPathParam } from "../../../../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../../../../server/http/responseHelpers.js";
import { AgentError } from "../../../../server/agents/errors.js";
import {
  respondAgentApiError,
  serializeAgentRun,
} from "../../../../server/agents/apiHelpers.js";

// GET /api/agents/:id/runs/:runId — one run with the decrypted full output
// for the detail view. This is the only endpoint that returns run output.

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (request.method !== "GET") {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  try {
    const decodedToken = await authenticateRequest(request);
    const agentId = readPathParam(request, "id");
    const runId = readPathParam(request, "runId");
    if (!agentId || !runId) {
      throw new AgentError("An agent id and run id are required.", "INVALID_AGENT_PAYLOAD", 400);
    }

    const run = await withUserContext(decodedToken.uid, (tx) =>
      tx.agentRun.findFirst({
        where: { id: runId, agentConfigId: agentId, userId: decodedToken.uid },
      })
    );
    if (!run) {
      throw new AgentError("Run not found.", "RUN_NOT_FOUND", 404);
    }

    return response.status(200).json({ run: serializeAgentRun(run, { includeOutput: true }) });
  } catch (error) {
    return respondAgentApiError(
      response,
      "api/agents/[id]/runs/[runId]",
      error,
      "Unable to load the run."
    );
  }
}
