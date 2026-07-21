import {
  handleConversationItem,
  resolveCeoConversationTarget,
} from "../../../../server/agents/conversationHttp.js";

// PATCH  /api/agents/ceo/conversations/:conversationId — rename / archive
// DELETE /api/agents/ceo/conversations/:conversationId — hard delete

export default async function handler(request, response) {
  return handleConversationItem(request, response, {
    resolveTarget: resolveCeoConversationTarget,
    logLabel: "api/agents/ceo/conversations/[conversationId]",
  });
}
