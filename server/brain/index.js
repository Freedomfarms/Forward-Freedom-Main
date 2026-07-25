import { stepCountIs } from "ai";

import { withUserContext } from "../db/prisma.js";
import { encrypt } from "../security/envelope.js";
import { touchConversation } from "../agents/conversations.js";
import { scheduleConversationTitle } from "../agents/conversationTitle.js";
import { generateAgentText } from "../agents/llm.js";
import { assembleBrainContext } from "./context.js";
import { BRAIN_JOB_KINDS, enqueueBrainJob, kickBrainJobSoon } from "./jobs.js";
import { BRAIN_SYSTEM_PROMPT } from "./prompts.js";
import { buildBrainToolBelt } from "./toolBelt.js";

// ─────────────────────────────────────────────────────────────────────────────
// Freedom Brain — the reasoning loop that replaces the legacy one-shot JSON
// envelope for CEO chat. Shallow by design (§0.5 of the plan): no router /
// planner / coordinator layers.
//
//   Observe               → input validation + user-message persistence
//   Assemble Context      → Context Assembler (server/brain/context.js)
//   Recall Relevant Memory→ inside the assembler (profile → UserMemory later)
//   Reason                → one Sonnet-class generateAgentText call …
//   Determine Tools       → … in which the model chooses tools …
//   Execute Tool Calls    → … whose execute() runs allowlisted server code …
//   Reflect On Results    → … and reads each result before composing text
//   Respond To User       → plain-text reply, persisted encrypted
//   Queue Background Work → BrainJob (memory extraction) + async title
//
// Vertical-slice scope: the CEO chat surface only, behind FREEDOM_BRAIN_CHAT.
// Sub-agent chats and the creation interview stay on the legacy path until
// this slice is evaluated against production.
// ─────────────────────────────────────────────────────────────────────────────

/** Tool rounds + the final text step. */
const BRAIN_MAX_STEPS = 8;
const BRAIN_MAX_OUTPUT_TOKENS = 1800;
/** Retry an empty generation once — but only if no side effects ran yet. */
const BRAIN_GENERATE_ATTEMPTS = 2;

const EMPTY_REPLY_FALLBACK =
  "A generation error occurred and I could not complete that reply. Please ask again, or try rephrasing.";

/** Flag gate for the vertical slice; legacy respondToChat is the default. */
export function isBrainChatEnabled() {
  const raw = String(process.env.FREEDOM_BRAIN_CHAT || "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * One full Brain turn. Same inputs/outputs as the legacy respondToChat CEO
 * path, so the API route and frontend need no changes:
 * `{ reply, messageId, conversationId, conversationTitle, model, usage,
 *    agent?, run?, runMode?, digest? }`.
 */
export async function brainTurn({
  userId,
  ceoAgentConfigId,
  conversationId = null,
  message,
  relatedRunId = null,
}) {
  // Observe / Assemble Context / Recall Memory.
  const context = await assembleBrainContext({
    userId,
    ceoAgentConfigId,
    conversationId,
    message,
    relatedRunId,
  });

  // Per-turn side-effect accumulator shared by all tool executes.
  const turnState = {
    agent: null,
    run: null,
    runMode: null,
    digest: null,
    lastCreatedAgentId: null,
    confirmations: [],
  };
  const tools = buildBrainToolBelt({
    userId,
    ceoAgentConfigId,
    conversationId: context.conversationId,
    turnState,
  });

  // Reason / Determine Tools / Execute / Reflect — the model drives all four
  // through the tool loop; its final output is plain conversational text.
  let reply = "";
  let usage = null;
  for (let attempt = 1; attempt <= BRAIN_GENERATE_ATTEMPTS; attempt += 1) {
    const result = await generateAgentText({
      model: context.model,
      system: BRAIN_SYSTEM_PROMPT,
      prompt: context.promptSections.join("\n\n"),
      tools,
      stopWhen: stepCountIs(BRAIN_MAX_STEPS),
      maxOutputTokens: BRAIN_MAX_OUTPUT_TOKENS,
    });
    usage = result.totalUsage ?? result.usage ?? usage;
    reply = String(result.text || "").trim();
    if (reply) break;
    // Never re-run a turn whose tools already mutated state — a second pass
    // could duplicate the side effects. Fall back to the authoritative
    // server confirmations instead.
    if (turnState.confirmations.length) break;
  }
  if (!reply) {
    reply = turnState.confirmations.join("\n\n") || EMPTY_REPLY_FALLBACK;
  }

  // Respond To User.
  const relatedFromOps = turnState.run?.id || relatedRunId || null;
  const replyMessage = await withUserContext(userId, async (tx) => {
    const created = await tx.agentChatMessage.create({
      data: {
        userId,
        conversationId: context.conversationId,
        ceoAgentConfigId,
        agentConfigId: null,
        role: "AGENT",
        contentCiphertext: encrypt(reply),
        relatedRunId: relatedFromOps,
      },
    });
    await touchConversation(tx, context.conversationId);
    return created;
  });

  // Queue Background Work — the reply above is already final; everything
  // below is best-effort and must never fail or delay the chat.
  try {
    const job = await enqueueBrainJob({
      userId,
      kind: BRAIN_JOB_KINDS.MEMORY_EXTRACTION,
      payload: { conversationId: context.conversationId },
    });
    if (job) kickBrainJobSoon({ userId, jobId: job.id });
  } catch {
    // Best-effort by contract.
  }

  if (context.isFirstExchange) {
    scheduleConversationTitle({
      userId,
      conversationId: context.conversationId,
      userMessage: context.lastUserMessage,
      agentReply: reply,
      snippetTitle: context.conversationTitle,
    });
  }

  return {
    reply,
    messageId: replyMessage?.id ?? null,
    conversationId: context.conversationId,
    conversationTitle: context.conversationTitle,
    model: context.model,
    usage,
    ...(turnState.agent ? { agent: turnState.agent } : {}),
    ...(turnState.run ? { run: turnState.run } : {}),
    ...(turnState.runMode ? { runMode: turnState.runMode } : {}),
    ...(turnState.digest ? { digest: turnState.digest } : {}),
  };
}
