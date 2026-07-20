import { withUserContext } from "../db/prisma.js";
import { decrypt } from "../security/envelope.js";
import { isCreationStateContent } from "./creationFlow.js";
import { AgentError } from "./errors.js";

// Shared chat-history loader for CEO and sub-agent chats. The UI previously
// kept messages in local React state only; these helpers restore the durable
// thread stored in AgentChatMessage (minus hidden creation-state rows).

export const CHAT_HISTORY_DEFAULT_LIMIT = 50;
const CHAT_HISTORY_FETCH_CAP = 200;

/**
 * Decrypts rows newest-first, drops creation-state sentinels and undecryptable
 * rows, then returns up to `limit` messages in chronological order for the UI.
 */
export function decodeVisibleChatMessages(rows, { limit = CHAT_HISTORY_DEFAULT_LIMIT } = {}) {
  const visible = [];
  for (const row of rows || []) {
    let text;
    try {
      text = decrypt(row.contentCiphertext);
    } catch {
      continue;
    }
    if (isCreationStateContent(text)) continue;
    visible.push({
      id: row.id,
      role: row.role === "USER" ? "user" : "agent",
      text,
      createdAt: row.createdAt,
    });
    if (visible.length >= limit) break;
  }
  return visible.reverse();
}

/**
 * Loads visible chat history for exactly one of agentConfigId / ceoAgentConfigId.
 * Verifies the target config belongs to the user before reading messages.
 */
export async function listChatHistory({
  userId,
  agentConfigId = null,
  ceoAgentConfigId = null,
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
  });
}
