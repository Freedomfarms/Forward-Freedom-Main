import { withUserContext } from "../db/prisma.js";
import {
  isLegacyConversationId,
  isMissingAgentConversationError,
} from "./conversations.js";
import { PROFILE_EXTRACTION_MODEL, generateAgentText, isLlmConfigured } from "./llm.js";

const SNIPPET_MAX_CHARS = 40;
const TITLE_TIMEOUT_MS = 8_000;
const TITLE_MAX_CHARS = 80;

/** Immediate plaintext title from the first user message (no LLM). */
export function buildSnippetTitle(text, maxChars = SNIPPET_MAX_CHARS) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "New chat";
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function sanitizeGeneratedTitle(raw) {
  let title = String(raw || "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Models sometimes prefix with "Title:" — strip that.
  title = title.replace(/^(title)\s*[:\-–—]\s*/i, "").trim();
  if (!title) return null;
  if (title.length > TITLE_MAX_CHARS) {
    title = `${title.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
  }
  return title;
}

/**
 * If the conversation has no title yet (and is not a system thread), set a
 * snippet from the first user message. Returns the title string to surface.
 */
export async function applySnippetTitleIfNeeded(tx, { conversationId, messageText }) {
  if (isLegacyConversationId(conversationId)) return null;
  try {
    const row = await tx.agentConversation.findFirst({
      where: { id: conversationId },
      select: { id: true, title: true, isSystem: true },
    });
    if (!row || row.isSystem) return row?.title ?? null;
    if (typeof row.title === "string" && row.title.trim()) return row.title;

    const title = buildSnippetTitle(messageText);
    await tx.agentConversation.update({
      where: { id: conversationId },
      data: { title, updatedAt: new Date() },
    });
    return title;
  } catch (error) {
    if (isMissingAgentConversationError(error)) return null;
    throw error;
  }
}

/**
 * After the first full exchange, generate a short title asynchronously.
 * Never blocks the chat critical path; falls back to keeping the snippet.
 */
export function scheduleConversationTitle({
  userId,
  conversationId,
  userMessage,
  agentReply,
  snippetTitle = null,
} = {}) {
  if (!userId || isLegacyConversationId(conversationId) || !isLlmConfigured()) return;
  void generateAndSaveTitle({
    userId,
    conversationId,
    userMessage,
    agentReply,
    snippetTitle,
  }).catch(() => {
    // Best-effort — snippet (if any) remains.
  });
}

async function generateAndSaveTitle({
  userId,
  conversationId,
  userMessage,
  agentReply,
  snippetTitle,
}) {
  const titlePromise = generateAgentText({
    model: PROFILE_EXTRACTION_MODEL,
    system:
      "You write short chat thread titles. Reply with ONLY the title — at most 6 words, no quotes, no trailing punctuation.",
    prompt: `User message:\n${String(userMessage || "").slice(0, 500)}\n\nAssistant reply:\n${String(agentReply || "").slice(0, 500)}`,
    maxOutputTokens: 40,
  });

  const timed = await Promise.race([
    titlePromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("title generation timed out")), TITLE_TIMEOUT_MS);
    }),
  ]);

  const title = sanitizeGeneratedTitle(timed?.text);
  if (!title) return;

  try {
    await withUserContext(userId, async (tx) => {
      const row = await tx.agentConversation.findFirst({
        where: { id: conversationId, userId },
        select: { id: true, title: true, isSystem: true },
      });
      if (!row || row.isSystem) return;
      // Don't clobber a user rename that landed after the snippet was set.
      if (
        snippetTitle &&
        typeof row.title === "string" &&
        row.title.trim() &&
        row.title.trim() !== snippetTitle.trim()
      ) {
        return;
      }
      await tx.agentConversation.update({
        where: { id: row.id },
        data: { title, updatedAt: new Date() },
      });
    });
  } catch (error) {
    if (isMissingAgentConversationError(error)) return;
    throw error;
  }
}
