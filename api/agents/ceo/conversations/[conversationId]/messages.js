import {
  handleConversationMessages,
  resolveCeoConversationTarget,
} from "../../../../../server/agents/conversationHttp.js";

// GET /api/agents/ceo/conversations/:conversationId/messages

export default async function handler(request, response) {
  return handleConversationMessages(request, response, {
    resolveTarget: resolveCeoConversationTarget,
    logLabel: "api/agents/ceo/conversations/[conversationId]/messages",
  });
}
