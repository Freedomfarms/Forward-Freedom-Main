import { readPathParam } from "../../../../server/http/requestHelpers.js";
import { AgentError } from "../../../../server/agents/errors.js";
import { handleConversationItem } from "../../../../server/agents/conversationHttp.js";

// PATCH  /api/agents/:id/conversations/:conversationId
// DELETE /api/agents/:id/conversations/:conversationId

async function resolveAgentTarget(request) {
  const agentId = readPathParam(request, "id");
  if (!agentId) {
    throw new AgentError("An agent id is required.", "INVALID_AGENT_PAYLOAD", 400);
  }
  if (agentId === "ceo") {
    throw new AgentError(
      "Use /api/agents/ceo/conversations for CEO Agent chats.",
      "INVALID_CHAT_TARGET",
      400
    );
  }
  return { agentConfigId: agentId, ceoAgentConfigId: null };
}

export default async function handler(request, response) {
  return handleConversationItem(request, response, {
    resolveTarget: resolveAgentTarget,
    logLabel: "api/agents/[id]/conversations/[conversationId]",
  });
}
