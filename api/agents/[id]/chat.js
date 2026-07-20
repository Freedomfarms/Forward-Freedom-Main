import { authenticateRequest } from "../../../server/auth/verifyAuth.js";
import { agentLlmRateLimit, enforceRateLimit } from "../../../server/http/rateLimit.js";
import { readJsonBody, readPathParam } from "../../../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../../../server/http/responseHelpers.js";
import { AgentError } from "../../../server/agents/errors.js";
import { respondAgentApiError } from "../../../server/agents/apiHelpers.js";
import { respondToChat } from "../../../server/agents/chat.js";

// POST /api/agents/:id/chat — chat scoped to one sub-agent. respondToChat
// enforces ownership and scoping (this agent's own runs and messages only).

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (request.method !== "POST") {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }
  if (!(await enforceRateLimit(request, response, agentLlmRateLimit))) return;

  try {
    const decodedToken = await authenticateRequest(request);
    const agentId = readPathParam(request, "id");
    if (!agentId) {
      throw new AgentError("An agent id is required.", "INVALID_AGENT_PAYLOAD", 400);
    }

    const payload = await readJsonBody(request);
    const message = typeof payload?.message === "string" ? payload.message.trim() : "";
    if (!message) {
      throw new AgentError("A non-empty message is required.", "INVALID_AGENT_PAYLOAD", 400);
    }
    const relatedRunId =
      typeof payload?.relatedRunId === "string" && payload.relatedRunId.trim()
        ? payload.relatedRunId.trim()
        : null;

    const { reply, messageId } = await respondToChat({
      userId: decodedToken.uid,
      agentConfigId: agentId,
      message,
      relatedRunId,
    });
    return response.status(200).json({ reply, messageId });
  } catch (error) {
    return respondAgentApiError(
      response,
      "api/agents/[id]/chat",
      error,
      "Unable to process the agent chat message."
    );
  }
}
