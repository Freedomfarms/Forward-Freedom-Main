import { withUserContext } from "../../../../../server/db/prisma.js";
import { ensureCeoAgentConfig } from "../../../../../server/agents/apiHelpers.js";
import { handleConversationMessages } from "../../../../../server/agents/conversationHttp.js";

// GET /api/agents/ceo/conversations/:conversationId/messages

async function resolveCeoTarget(_request, userId) {
  const ceo = await withUserContext(userId, (tx) => ensureCeoAgentConfig(tx, userId));
  return { ceoAgentConfigId: ceo.id, agentConfigId: null };
}

export default async function handler(request, response) {
  return handleConversationMessages(request, response, {
    resolveTarget: resolveCeoTarget,
    logLabel: "api/agents/ceo/conversations/[conversationId]/messages",
  });
}
