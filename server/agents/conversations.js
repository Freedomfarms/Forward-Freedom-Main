import { AgentError } from "./errors.js";

/**
 * Resolve the active default conversation for a CEO or sub-agent chat target.
 *
 * Phase 1 compatibility: message writes require conversationId after the
 * AgentConversation migration. Until multi-conversation APIs/UI land, callers
 * omit an explicit id and we attach to the newest non-system, non-archived
 * conversation (creating an "Original thread" when none exists).
 */
export async function ensureDefaultConversation(
  tx,
  { userId, agentConfigId = null, ceoAgentConfigId = null, title = "Original thread" }
) {
  if (!userId) {
    throw new AgentError("ensureDefaultConversation requires userId.", "INVALID_ARGUMENT", 400);
  }
  if (Boolean(agentConfigId) === Boolean(ceoAgentConfigId)) {
    throw new AgentError(
      "Provide exactly one of agentConfigId or ceoAgentConfigId.",
      "INVALID_CHAT_TARGET",
      400
    );
  }

  const existing = await tx.agentConversation.findFirst({
    where: {
      userId,
      agentConfigId: agentConfigId ?? null,
      ceoAgentConfigId: ceoAgentConfigId ?? null,
      isSystem: false,
      archivedAt: null,
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (existing) return existing;

  return tx.agentConversation.create({
    data: {
      userId,
      agentConfigId: agentConfigId ?? null,
      ceoAgentConfigId: ceoAgentConfigId ?? null,
      title,
      isSystem: false,
    },
    select: { id: true },
  });
}

/** Bump conversation activity timestamp (list ordering). */
export async function touchConversation(tx, conversationId) {
  if (!conversationId) return;
  await tx.agentConversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });
}
