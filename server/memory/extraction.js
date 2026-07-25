import { jsonSchema } from "ai";

import { withUserContext } from "../db/prisma.js";
import { decrypt } from "../security/envelope.js";
import { isCreationStateContent } from "../agents/creationFlow.js";
import { generateAgentObject, isLlmConfigured, PROFILE_EXTRACTION_MODEL } from "../agents/llm.js";
import {
  applyOps,
  getProfile,
  PROFILE_OPS_JSON_SCHEMA,
  renderProfileForPrompt,
  sanitizeProfileOps,
  saveProfile,
} from "../agents/profile.js";
import { dataSection, PROMPT_SAFETY_RULES } from "../agents/prompts.js";

// ─────────────────────────────────────────────────────────────────────────────
// Asynchronous memory extraction — the Brain's "Queue Background Work" stage.
//
// The legacy chat forced the conversational model to emit profileOps inside
// its reply JSON. Here extraction is a separate cheap-tier (Haiku) call that
// runs AFTER the reply was sent, consuming a BrainJob. The chat response never
// waits on it, and a failed extraction only ever means a missed memory —
// never a broken conversation.
//
// The slice still writes to the existing living-profile store (applyOps /
// saveProfile — all existing business logic, including tombstones and
// category caps). Phase 2 redirects the write side to UserMemory rows behind
// this same function.
// ─────────────────────────────────────────────────────────────────────────────

/** How much of the tail of the conversation the extractor examines. */
const EXTRACTION_MESSAGE_LOOKBACK = 10;
const EXTRACTION_MAX_OUTPUT_TOKENS = 800;

const EXTRACTION_SCHEMA = jsonSchema({
  type: "object",
  properties: { ops: PROFILE_OPS_JSON_SCHEMA },
  required: ["ops"],
  additionalProperties: false,
});

const EXTRACTION_SYSTEM_PROMPT = [
  "You maintain the long-term memory profile of a Freedom OS user, based on their conversation with Freedom Brain (their assistant).",
  "You are given the current profile and the tail of one conversation. Decide whether the USER revealed anything DURABLE about themselves — goals, preferences, decisions, recurring concerns, life context, or relationships between their finances.",
  "Return profile operations only for genuinely durable facts stated or confirmed by the user. Most exchanges reveal nothing durable: return an empty ops array in that case.",
  "Never store the assistant's own suggestions or plans as user facts. Facts must be short, plain statements. Never store merchant names, account names or numbers, or institution names.",
  "Safety rules:",
  `- ${PROMPT_SAFETY_RULES}`,
].join("\n");

async function loadRecentExchange(userId, conversationId) {
  const rows = await withUserContext(userId, (tx) =>
    tx.agentChatMessage.findMany({
      where: { userId, conversationId },
      orderBy: { createdAt: "desc" },
      take: EXTRACTION_MESSAGE_LOOKBACK,
      select: { role: true, contentCiphertext: true },
    })
  );
  const lines = [];
  for (const row of [...rows].reverse()) {
    let content;
    try {
      content = decrypt(row.contentCiphertext);
    } catch {
      continue;
    }
    if (isCreationStateContent(content)) continue;
    lines.push(`${row.role === "USER" ? "User" : "Assistant"}: ${content}`);
  }
  return lines.join("\n");
}

/**
 * BrainJob handler for kind "memory_extraction". One cheap-tier structured
 * call over the conversation tail; applies resulting ops to the living
 * profile. Returns { ops } (empty when nothing durable) or null when there was
 * nothing to examine / the LLM is unconfigured.
 */
export async function extractMemoryFromConversation({ userId, conversationId }) {
  if (!userId || !conversationId) return null;
  if (!isLlmConfigured()) return null;

  const transcript = await loadRecentExchange(userId, conversationId);
  if (!transcript.trim()) return null;

  const profile = await getProfile(userId);
  const { object } = await generateAgentObject({
    model: PROFILE_EXTRACTION_MODEL,
    system: EXTRACTION_SYSTEM_PROMPT,
    prompt: [
      "Review this conversation tail and return profile ops for any durable facts about the user (or an empty array).",
      dataSection("CURRENT PROFILE", renderProfileForPrompt(profile)),
      dataSection("RECENT CONVERSATION", transcript),
    ].join("\n\n"),
    schema: EXTRACTION_SCHEMA,
    maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
  });

  const ops = sanitizeProfileOps(object?.ops);
  if (ops.length) {
    await saveProfile(userId, applyOps(profile, ops, { source: "brain_chat" }));
  }
  return { ops };
}
