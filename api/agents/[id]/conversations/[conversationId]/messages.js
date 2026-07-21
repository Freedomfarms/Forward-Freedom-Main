import {
  handleConversationMessages,
  resolveAgentConversationTarget,
} from "../../../../../server/agents/conversationHttp.js";

// GET /api/agents/:id/conversations/:conversationId/messages
//
// When Vercel binds /api/agents/ceo/conversations/:conversationId/messages here
// (id="ceo"), the shared resolver treats it as the CEO surface.

export default async function handler(request, response) {
  return handleConversationMessages(request, response, {
    resolveTarget: resolveAgentConversationTarget,
    logLabel: "api/agents/[id]/conversations/[conversationId]/messages",
  });
}
