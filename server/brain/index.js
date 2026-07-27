import { stepCountIs } from "ai";

import { withUserContext } from "../db/prisma.js";
import { encrypt } from "../security/envelope.js";
import { touchConversation } from "../agents/conversations.js";
import { scheduleConversationTitle } from "../agents/conversationTitle.js";
import { generateAgentText } from "../agents/llm.js";
import { assembleBrainContext } from "./context.js";
import { BRAIN_JOB_KINDS, enqueueBrainJob, kickBrainJobSoon } from "./jobs.js";
import { logCeoReasoning, sketchMissionFromConversation } from "../agents/ceoReasoning.js";
import { BRAIN_SYSTEM_PROMPT } from "./prompts.js";
import { buildBrainToolBelt } from "./toolBelt.js";

// ─────────────────────────────────────────────────────────────────────────────
// Freedom Brain — the ONE CEO reasoning loop for Freedom OS.
// Agent creation is a tool capability inside this conversation — there is no
// separate "+ New Agent" interview engine.
//
//   Observe → Assemble Context → Reason (mission pipeline in system prompt)
//   → Tools when executable → Respond → Background memory jobs
// ─────────────────────────────────────────────────────────────────────────────

/** Tool rounds + the final text step. */
const BRAIN_MAX_STEPS = 8;
const BRAIN_MAX_OUTPUT_TOKENS = 1800;
/** Retry an empty generation once — but only if no side effects ran yet. */
const BRAIN_GENERATE_ATTEMPTS = 2;

const EMPTY_REPLY_FALLBACK =
  "A generation error occurred and I could not complete that reply. Please ask again, or try rephrasing.";

/**
 * CEO chat uses Freedom Brain by default (one brain). Set FREEDOM_BRAIN_CHAT=0
 * or false to force the legacy respondToChat JSON envelope.
 */
export function isBrainChatEnabled() {
  const raw = String(process.env.FREEDOM_BRAIN_CHAT || "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "on") return true;
  // Default ON — separate create_agent interview mode is retired.
  return true;
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

  // Dev observability: multi-turn mission continuity + efficiency (not shown to user).
  logCeoReasoning(
    sketchMissionFromConversation([...(context.userMessagesInOrder || []), message], {
      existingAgents: context.teamAgents || [],
    })
  );

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
