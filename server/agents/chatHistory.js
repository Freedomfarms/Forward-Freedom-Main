import { withUserContext } from "../db/prisma.js";
import {
  chatMessageConversationWhere,
  ensureDefaultConversation,
  isMissingAgentConversationError,
  LEGACY_SINGLE_THREAD_ID,
} from "./conversations.js";
import {
  CHAT_HISTORY_DEFAULT_LIMIT,
  decodeVisibleChatMessages,
} from "./chatMessageCodec.js";
import { AgentError, isAgentError } from "./errors.js";

// Shared chat-history loader for CEO and sub-agent chats. The UI previously
// kept messages in local React state only; these helpers restore the durable
// thread stored in AgentChatMessage (minus hidden creation-state rows).

export {
  CHAT_HISTORY_DEFAULT_LIMIT,
  decodeVisibleChatMessages,
  serializeChatHistoryMessages,
} from "./chatMessageCodec.js";

const CHAT_HISTORY_FETCH_CAP = 200;

/**
 * Loads visible chat history for exactly one of agentConfigId / ceoAgentConfigId.
 * When conversationId is omitted, uses the newest non-system conversation
 * (creating an Original thread if needed) so GET /chat stays single-thread
 * compatible until the UI switches to /conversations/:id/messages.
 *
 * When AgentConversation / conversationId are unmigrated, falls back to the
 * pre-multi-chat agent-XOR message scope so CEO chat still loads.
 */
export async function listChatHistory({
  userId,
  agentConfigId = null,
  ceoAgentConfigId = null,
  conversationId = null,
  limit = CHAT_HISTORY_DEFAULT_LIMIT,
} = {}) {
  if (!userId) {
    throw new AgentError("listChatHistory requires userId.", "INVALID_ARGUMENT", 400);
  }
  if (Boolean(agentConfigId) === Boolean(ceoAgentConfigId)) {
    throw new AgentError(
      "Provide exactly one of agentConfigId or ceoAgentConfigId.",
      "INVALID_CHAT_TARGET",
      400
    );
  }

  const take = Math.min(
    CHAT_HISTORY_FETCH_CAP,
    Math.max(Number(limit) || CHAT_HISTORY_DEFAULT_LIMIT, 1) * 3
  );

  return withUserContext(userId, async (tx) => {
    if (agentConfigId) {
      const agent = await tx.agentConfig.findFirst({
        where: { id: agentConfigId, userId },
        select: { id: true },
      });
      if (!agent) throw new AgentError("Agent not found.", "AGENT_NOT_FOUND", 404);
    } else {
      const ceo = await tx.ceoAgentConfig.findFirst({
        where: { id: ceoAgentConfigId, userId },
        select: { id: true },
      });
      if (!ceo) throw new AgentError("CEO Agent not found.", "CEO_AGENT_NOT_FOUND", 404);
    }

    let resolvedConversationId = conversationId;
    if (resolvedConversationId === LEGACY_SINGLE_THREAD_ID) {
      resolvedConversationId = LEGACY_SINGLE_THREAD_ID;
    } else if (resolvedConversationId) {
      try {
        const conversation = await tx.agentConversation.findFirst({
          where: {
            id: resolvedConversationId,
            userId,
            agentConfigId: agentConfigId ?? null,
            ceoAgentConfigId: ceoAgentConfigId ?? null,
            isSystem: false,
          },
          select: { id: true },
        });
        if (!conversation) {
          throw new AgentError("Conversation not found.", "CONVERSATION_NOT_FOUND", 404);
        }
        resolvedConversationId = conversation.id;
      } catch (error) {
        if (isAgentError(error)) throw error;
        if (!isMissingAgentConversationError(error)) throw error;
        // Unmigrated: ignore the requested id and use legacy agent scope.
        resolvedConversationId = LEGACY_SINGLE_THREAD_ID;
      }
    } else {
      const conversation = await ensureDefaultConversation(tx, {
        userId,
        agentConfigId,
        ceoAgentConfigId,
      });
      resolvedConversationId = conversation.id;
    }

    try {
      const rows = await tx.agentChatMessage.findMany({
        where: chatMessageConversationWhere(resolvedConversationId, {
          userId,
          agentConfigId,
          ceoAgentConfigId,
        }),
        orderBy: { createdAt: "desc" },
        take,
        select: { id: true, role: true, contentCiphertext: true, createdAt: true },
      });

      return decodeVisibleChatMessages(rows, { limit });
    } catch (error) {
      if (!isMissingAgentConversationError(error)) throw error;
      // conversationId column missing — query the pre-multi-chat shape.
      const rows = await tx.agentChatMessage.findMany({
        where: {
          userId,
          agentConfigId: agentConfigId ?? null,
          ceoAgentConfigId: ceoAgentConfigId ?? null,
        },
        orderBy: { createdAt: "desc" },
        take,
        select: { id: true, role: true, contentCiphertext: true, createdAt: true },
      });
      return decodeVisibleChatMessages(rows, { limit });
    }
  });
}
