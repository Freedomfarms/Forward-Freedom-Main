import {
  handleConversationCollection,
  resolveCeoConversationTarget,
} from "../../../server/agents/conversationHttp.js";

// GET  /api/agents/ceo/conversations — list non-system CEO conversations
// POST /api/agents/ceo/conversations — create a new CEO conversation

export default async function handler(request, response) {
  return handleConversationCollection(request, response, {
    resolveTarget: resolveCeoConversationTarget,
    logLabel: "api/agents/ceo/conversations",
  });
}
