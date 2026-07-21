import {
  handleConversationItem,
  resolveAgentConversationTarget,
} from "../../../../server/agents/conversationHttp.js";

// PATCH  /api/agents/:id/conversations/:conversationId
// DELETE /api/agents/:id/conversations/:conversationId
//
// When Vercel binds /api/agents/ceo/conversations/:conversationId here
// (id="ceo"), the shared resolver treats it as the CEO surface.

export default async function handler(request, response) {
  return handleConversationItem(request, response, {
    resolveTarget: resolveAgentConversationTarget,
    logLabel: "api/agents/[id]/conversations/[conversationId]",
  });
}
