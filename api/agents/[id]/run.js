import { authenticateRequest } from "../../../server/auth/verifyAuth.js";
import { agentRunRateLimit, enforceRateLimit } from "../../../server/http/rateLimit.js";
import { readPathParam } from "../../../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../../../server/http/responseHelpers.js";
import { AgentError } from "../../../server/agents/errors.js";
import {
  respondAgentApiError,
  serializeAgentRun,
} from "../../../server/agents/apiHelpers.js";
import { runAgent } from "../../../server/agents/runner.js";

// POST /api/agents/:id/run — trigger a manual run. The runner enforces the
// full fail-closed gate (ownership, PAUSED, permission level, unbuilt types
// such as "email" become SKIPPED runs). Manual runs are the most expensive
// single action, so they use the strictest rate limit (10/hour).

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (request.method !== "POST") {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }
  if (!(await enforceRateLimit(request, response, agentRunRateLimit))) return;

  try {
    const decodedToken = await authenticateRequest(request);
    const agentId = readPathParam(request, "id");
    if (!agentId) {
      throw new AgentError("An agent id is required.", "INVALID_AGENT_PAYLOAD", 400);
    }

    const run = await runAgent({
      userId: decodedToken.uid,
      agentConfigId: agentId,
      trigger: "manual",
    });
    return response.status(200).json({ run: serializeAgentRun(run) });
  } catch (error) {
    return respondAgentApiError(
      response,
      "api/agents/[id]/run",
      error,
      "Unable to run the agent."
    );
  }
}
