import { readPathParam } from "../../../server/http/requestHelpers.js";
import { AgentError } from "../../../server/agents/errors.js";
import { handleConversationCollection } from "../../../server/agents/conversationHttp.js";

// GET  /api/agents/:id/conversations — list non-system conversations for one agent
// POST /api/agents/:id/conversations — create a new conversation for one agent

async function resolveAgentTarget(request) {
  const agentId = readPathParam(request, "id");
  if (!agentId) {
    throw new AgentError("An agent id is required.", "INVALID_AGENT_PAYLOAD", 400);
  }
  return { agentConfigId: agentId, ceoAgentConfigId: null };
}

export default async function handler(request, response) {
  return handleConversationCollection(request, response, {
    resolveTarget: resolveAgentTarget,
    logLabel: "api/agents/[id]/conversations",
  });
}
