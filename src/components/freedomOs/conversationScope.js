// Client-side conversation scope helpers. Server already enforces XOR targeting
// (CEO vs sub-agent); these keep the UI from holding / sending a foreign id.

const RECOVERABLE_CONVERSATION_CODES = new Set([
  "CONVERSATION_TARGET_MISMATCH",
  "CONVERSATION_NOT_FOUND",
  "CONVERSATION_ARCHIVED",
]);

/**
 * True when a conversation row belongs to this AgentChat mode/target.
 * Rejects clearly foreign rows (wrong FK). Rows missing FKs are accepted when
 * they don't contradict the current mode (optimistic stubs / older payloads).
 */
export function isConversationInScope(conversation, { mode, agentId = null } = {}) {
  if (!conversation || typeof conversation !== "object") return false;
  if (conversation.isSystem) return false;

  if (mode === "agent") {
    if (!agentId) return false;
    // CEO-owned threads must never appear in a sub-agent list.
    if (conversation.ceoAgentConfigId) return false;
    if (conversation.agentConfigId && conversation.agentConfigId !== agentId) return false;
    return true;
  }

  if (mode === "ceo") {
    // Sub-agent threads must never appear in the CEO list.
    if (conversation.agentConfigId) return false;
    return true;
  }

  return false;
}

export function filterConversationsInScope(rows, scope) {
  return (Array.isArray(rows) ? rows : []).filter((row) => isConversationInScope(row, scope));
}

export function isRecoverableConversationError(error) {
  const code = error?.payload?.code || error?.code;
  if (RECOVERABLE_CONVERSATION_CODES.has(code)) return true;
  const message = String(error?.message || "");
  return /does not belong to this agent chat|conversation not found|is archived/i.test(message);
}
