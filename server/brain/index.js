import { stepCountIs } from "ai";

import { withUserContext } from "../db/prisma.js";
import { encrypt } from "../security/envelope.js";
import { touchConversation } from "../agents/conversations.js";
import { scheduleConversationTitle } from "../agents/conversationTitle.js";
import { generateAgentText } from "../agents/llm.js";
import { assembleBrainContext } from "./context.js";
import {
  renderIdentityValidationRetry,
  validateIdentityConsistency,
} from "./identity.js";
import {
  buildExecutionState,
  renderCapabilityValidationRetry,
  validateCapabilityConsistency,
} from "./controlPlane.js";
import { BRAIN_JOB_KINDS, enqueueBrainJob, kickBrainJobSoon } from "./jobs.js";
import { logCeoReasoning } from "../agents/ceoReasoning.js";
import { dataSection } from "../agents/prompts.js";
import { BRAIN_SYSTEM_PROMPT } from "./prompts.js";
import { buildBrainToolBelt } from "./toolBelt.js";

// ─────────────────────────────────────────────────────────────────────────────
// Freedom Brain — the ONE CEO reasoning loop for Freedom OS.
// Agent creation is a tool capability inside this conversation — there is no
// separate "+ New Agent" interview engine.
//
//   Observe → Assemble Context → Reason (mission pipeline in system prompt)
//   → Tools when executable → Identity + capability self-check → Respond
//   → Background jobs
// ─────────────────────────────────────────────────────────────────────────────

/** Tool rounds + the final text step. */
const BRAIN_MAX_STEPS = 8;
const BRAIN_MAX_OUTPUT_TOKENS = 1800;
/** Retry an empty generation once — but only if no side effects ran yet. */
const BRAIN_GENERATE_ATTEMPTS = 2;
/** One regenerate when identity self-consistency fails (no tool re-run). */
const IDENTITY_REGENERATE_ATTEMPTS = 1;
/** One regenerate when capability/execution-state self-consistency fails. */
const CAPABILITY_REGENERATE_ATTEMPTS = 1;

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
  // Observe / Assemble Context / Recall Memory (identity namespaces included).
  const context = await assembleBrainContext({
    userId,
    ceoAgentConfigId,
    conversationId,
    message,
    relatedRunId,
  });

  // Dev observability: multi-turn mission continuity + efficiency (not shown to user).
  if (context.activeMission) {
    logCeoReasoning(context.activeMission);
  }

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

  let prompt = context.promptSections.join("\n\n");

  // Reason / Determine Tools / Execute / Reflect — the model drives all four
  // through the tool loop; its final output is plain conversational text.
  let reply = "";
  let usage = null;
  for (let attempt = 1; attempt <= BRAIN_GENERATE_ATTEMPTS; attempt += 1) {
    const result = await generateAgentText({
      model: context.model,
      system: BRAIN_SYSTEM_PROMPT,
      prompt,
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

  // Self-consistency: catch assistant↔user identity swaps before persist.
  // Regenerate once without tools when no side effects have run yet.
  const identityPass = await enforceIdentityConsistency({
    reply,
    context,
    prompt,
    turnState,
  });
  reply = identityPass.reply;
  if (identityPass.usage) usage = identityPass.usage;

  // Control-plane self-consistency: never claim Done/live without registry +
  // execution state. Architectural guard (not a prompt rule).
  const capabilityPass = await enforceCapabilityConsistency({
    reply,
    context,
    prompt,
    turnState,
  });
  reply = capabilityPass.reply;
  if (capabilityPass.usage) usage = capabilityPass.usage;

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

/**
 * Validate the draft reply against structured identity namespaces.
 * On failure, regenerate once (text-only) with a namespace correction section.
 */
async function enforceIdentityConsistency({ reply, context, prompt, turnState }) {
  let nextReply = String(reply || "").trim();
  let usage = null;
  const identities = context.identities;
  if (!identities) return { reply: nextReply, usage };

  for (let attempt = 0; attempt <= IDENTITY_REGENERATE_ATTEMPTS; attempt += 1) {
    const check = validateIdentityConsistency(nextReply, identities, {
      userMessage: context.lastUserMessage,
    });
    if (check.ok) return { reply: nextReply, usage };

    // Never re-enter the tool loop after side effects.
    if (turnState.confirmations.length || turnState.agent || turnState.run) {
      console.info(
        `[ceo-identity] validation failed after tools; skipping regenerate: ${check.failures.join(", ")}`
      );
      return { reply: nextReply, usage };
    }
    if (attempt >= IDENTITY_REGENERATE_ATTEMPTS) {
      console.info(
        `[ceo-identity] validation still failing after regenerate: ${check.failures.join(", ")}`
      );
      return { reply: nextReply, usage };
    }

    console.info(`[ceo-identity] regenerating once: ${check.failures.join(", ")}`);
    const retryPrompt = [
      prompt,
      renderIdentityValidationRetry(identities, check.failures),
      dataSection("PRIOR DRAFT (rejected for identity inconsistency)", nextReply),
    ].join("\n\n");

    const result = await generateAgentText({
      model: context.model,
      system: BRAIN_SYSTEM_PROMPT,
      prompt: retryPrompt,
      // Text-only regenerate — no tools.
      maxOutputTokens: BRAIN_MAX_OUTPUT_TOKENS,
    });
    usage = result.totalUsage ?? result.usage ?? usage;
    const regenerated = String(result.text || "").trim();
    if (regenerated) nextReply = regenerated;
  }
  return { reply: nextReply, usage };
}

/**
 * Validate the draft reply against the capability registry + execution state.
 * On failure, regenerate once (text-only) with a control-plane correction.
 */
async function enforceCapabilityConsistency({ reply, context, prompt, turnState }) {
  let nextReply = String(reply || "").trim();
  let usage = null;
  const controlPlane = context.controlPlane;
  if (!controlPlane) return { reply: nextReply, usage };

  const executionState = buildExecutionState({
    intent: controlPlane.intent,
    capabilityAssessment: controlPlane.capabilityAssessment,
    turnState,
    agentDefinition: controlPlane.plannedAgent,
  });

  for (let attempt = 0; attempt <= CAPABILITY_REGENERATE_ATTEMPTS; attempt += 1) {
    const check = validateCapabilityConsistency(nextReply, {
      userMessage: context.lastUserMessage,
      intent: controlPlane.intent,
      capabilityAssessment: controlPlane.capabilityAssessment,
      executionState,
    });
    if (check.ok) return { reply: nextReply, usage };

    // After tools ran, rewrite from authoritative state rather than re-entering
    // the tool loop (side effects must not duplicate).
    if (turnState.confirmations.length || turnState.agent || turnState.run) {
      console.info(
        `[ceo-capability] validation failed after tools; applying grounded reply: ${check.failures.join(", ")}`
      );
      nextReply = groundedCapabilityGapReply(controlPlane, executionState, turnState);
      return { reply: nextReply, usage };
    }

    if (attempt >= CAPABILITY_REGENERATE_ATTEMPTS) {
      console.info(
        `[ceo-capability] validation still failing after regenerate: ${check.failures.join(", ")}`
      );
      nextReply = groundedCapabilityGapReply(controlPlane, executionState, turnState);
      return { reply: nextReply, usage };
    }

    console.info(`[ceo-capability] regenerating once: ${check.failures.join(", ")}`);
    const retryPrompt = [
      prompt,
      renderCapabilityValidationRetry(controlPlane, check.failures, executionState),
      dataSection("PRIOR DRAFT (rejected for capability inconsistency)", nextReply),
    ].join("\n\n");

    const result = await generateAgentText({
      model: context.model,
      system: BRAIN_SYSTEM_PROMPT,
      prompt: retryPrompt,
      maxOutputTokens: BRAIN_MAX_OUTPUT_TOKENS,
    });
    usage = result.totalUsage ?? result.usage ?? usage;
    const regenerated = String(result.text || "").trim();
    if (regenerated) nextReply = regenerated;
  }
  return { reply: nextReply, usage };
}

/** Deterministic fallback when the model still hallucinates completion. */
function groundedCapabilityGapReply(controlPlane, executionState, turnState) {
  const blockers = [
    ...(controlPlane?.capabilityAssessment?.blockers || []),
    ...(executionState?.blockers || []),
  ].filter(Boolean);
  const uniqueBlockers = [...new Set(blockers)];
  const planned = controlPlane?.plannedAgent;
  const lines = [
    "I can design this agent, but these capabilities are not currently connected.",
  ];
  if (planned?.purpose) {
    lines.push(`Proposed purpose: ${planned.purpose}`);
  }
  if (planned?.status) {
    lines.push(`Agent definition status: ${planned.status} (not live).`);
  }
  if (uniqueBlockers.length) {
    lines.push(`Blockers: ${uniqueBlockers.join(" ")}`);
  }
  if (turnState?.agent?.id) {
    lines.push(
      `Note: a specialist config was written (id=${turnState.agent.id}), but unavailable platform connectors mean the requested mission is not fully live.`
    );
  } else {
    lines.push(
      "Next step: connect the missing integrations, or I can set up a limited substitute using only available capabilities (clearly labeled as limited)."
    );
  }
  return lines.join("\n");
}
