import {
  handleConversationCollection,
  resolveAgentConversationTarget,
} from "../../../server/agents/conversationHttp.js";

// GET  /api/agents/:id/conversations — list non-system conversations for one agent
// POST /api/agents/:id/conversations — create a new conversation for one agent
//
// When Vercel binds /api/agents/ceo/conversations here (id="ceo"), the shared
// resolver treats it as the CEO surface so chats keep working.

export default async function handler(request, response) {
  return handleConversationCollection(request, response, {
    resolveTarget: resolveAgentConversationTarget,
    logLabel: "api/agents/[id]/conversations",
  });
}
