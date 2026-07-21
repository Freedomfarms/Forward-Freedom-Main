import { withUserContext } from "../../../../server/db/prisma.js";
import { ensureCeoAgentConfig } from "../../../../server/agents/apiHelpers.js";
import { handleConversationItem } from "../../../../server/agents/conversationHttp.js";

// PATCH  /api/agents/ceo/conversations/:conversationId — rename / archive
// DELETE /api/agents/ceo/conversations/:conversationId — hard delete

async function resolveCeoTarget(_request, userId) {
  const ceo = await withUserContext(userId, (tx) => ensureCeoAgentConfig(tx, userId));
  return { ceoAgentConfigId: ceo.id, agentConfigId: null };
}

export default async function handler(request, response) {
  return handleConversationItem(request, response, {
    resolveTarget: resolveCeoTarget,
    logLabel: "api/agents/ceo/conversations/[conversationId]",
  });
}
