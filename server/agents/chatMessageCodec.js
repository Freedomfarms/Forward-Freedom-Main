import { decrypt } from "../security/envelope.js";
import { isCreationStateContent } from "./creationState.js";

export const CHAT_HISTORY_DEFAULT_LIMIT = 50;

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

/** JSON-safe chat history rows for API responses. */
export function serializeChatHistoryMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((row) => ({
    id: row.id,
    role: row.role,
    text: row.text,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : row.createdAt ?? null,
  }));
}
