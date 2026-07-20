import { jsonSchema } from "ai";

import { withUserContext } from "../db/prisma.js";
import { decrypt, decryptJson, encrypt } from "../security/envelope.js";
import { isCreationStateContent } from "./creationFlow.js";
import { AgentError } from "./errors.js";
import { CEO_AGENT_MODEL, generateAgentObject } from "./llm.js";
import { dataSection, PROMPT_SAFETY_RULES } from "./prompts.js";
import {
  extractFromChatReply,
  normalizeProfile,
  PROFILE_OPS_JSON_SCHEMA,
  renderProfileForPrompt,
} from "./profile.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared chat engine for the CEO Agent chat and every sub-agent chat.
//
// Scoping contract (enforced in the queries, inside the user's RLS context):
//   • a sub-agent chat may read ONLY its own runs and its own chat messages;
//   • the CEO chat reads run summaries across ALL the user's agents —
//     cross-agent questions are its job — plus the living profile, which is
//     how it answers "what do you know about me?".
// ─────────────────────────────────────────────────────────────────────────────

const CHAT_HISTORY_LIMIT = 50;
const RUN_SUMMARY_LIMIT = 20;

const CHAT_REPLY_SCHEMA = jsonSchema({
  type: "object",
  properties: {
    reply: { type: "string", description: "Your conversational reply to the user's message." },
    profileOps: PROFILE_OPS_JSON_SCHEMA,
  },
  required: ["reply", "profileOps"],
  additionalProperties: false,
});

const SUB_AGENT_CHAT_SYSTEM_PROMPT = [
  "You are one of the user's read-only agents inside Freedom OS, chatting with the user about your own work. Your identity, purpose and recent activity are provided as data sections.",
  "Answer questions about your runs and findings using only the provided context. If something is outside your scope (another agent's work, actions to take), say so and point the user to their CEO Agent.",
  "You cannot take actions of any kind. Never give directives such as buy/sell/move money and never make investment recommendations.",
  "Also return profileOps: durable facts about the user revealed in this conversation (usually an empty array).",
  "Safety rules:",
  `- ${PROMPT_SAFETY_RULES}`,
].join("\n");

const CEO_CHAT_SYSTEM_PROMPT = [
  "You are the user's CEO Agent inside Freedom OS: the orchestrator of their team of read-only agents, and their main point of contact.",
  "Answer using the provided context: recent run summaries from ALL of the user's agents (cross-agent questions are your job) and the user's long-term profile. When asked what you know about the user, answer from the profile data section.",
  "You cannot take actions of any kind. Never give directives such as buy/sell/move money and never make investment recommendations.",
  "Also return profileOps: durable facts about the user revealed in this conversation (usually an empty array).",
  "Safety rules:",
  `- ${PROMPT_SAFETY_RULES}`,
].join("\n");

function renderTranscript(messages) {
  const lines = messages
    .map((message) => {
      let content;
      try {
        content = decrypt(message.contentCiphertext);
      } catch {
        content = "(message could not be decrypted)";
      }
      // Hidden agent-creation state rows (see creationFlow.js) are internal
      // bookkeeping, never conversation — they must not reach a prompt.
      if (isCreationStateContent(content)) return null;
      return `${message.role === "USER" ? "User" : "Agent"}: ${content}`;
    })
    .filter(Boolean);
  return lines.length ? lines.join("\n") : "(no previous messages)";
}

function renderRunSummaries(runs) {
  if (!runs.length) return "(no completed runs yet)";
  return runs
    .map((run) => {
      const day = new Date(run.startedAt).toISOString().slice(0, 10);
      return `[${day}] (${run.agentType}, run ${run.id}) ${run.summary || "(no summary)"}`;
    })
    .join("\n");
}

/**
 * Persists the user's message (encrypted), assembles the scoped chat context,
 * makes one structured model call, persists and returns the reply. Exactly
 * one of agentConfigId / ceoAgentConfigId must be provided.
 */
export async function respondToChat({
  userId,
  agentConfigId = null,
  ceoAgentConfigId = null,
  message,
  relatedRunId = null,
}) {
  const text = String(message || "").trim();
  if (!userId || !text) {
    throw new AgentError("respondToChat requires userId and a non-empty message.", "INVALID_ARGUMENT", 400);
  }
  if (Boolean(agentConfigId) === Boolean(ceoAgentConfigId)) {
    throw new AgentError(
      "Provide exactly one of agentConfigId or ceoAgentConfigId.",
      "INVALID_CHAT_TARGET",
      400
    );
  }

  const context = await withUserContext(userId, async (tx) => {
    let agentConfig = null;
    let ceoConfig = null;

    if (agentConfigId) {
      agentConfig = await tx.agentConfig.findFirst({ where: { id: agentConfigId, userId } });
      if (!agentConfig) {
        throw new AgentError("Agent not found.", "AGENT_NOT_FOUND", 404);
      }
    } else {
      ceoConfig = await tx.ceoAgentConfig.findFirst({ where: { id: ceoAgentConfigId, userId } });
      if (!ceoConfig) {
        throw new AgentError("CEO Agent not found.", "CEO_AGENT_NOT_FOUND", 404);
      }
    }

    // History is captured before persisting the new message so the transcript
    // and the current question stay distinct in the prompt.
    const history = await tx.agentChatMessage.findMany({
      where: {
        userId,
        agentConfigId: agentConfig?.id ?? null,
        ceoAgentConfigId: ceoConfig?.id ?? null,
      },
      orderBy: { createdAt: "desc" },
      take: CHAT_HISTORY_LIMIT,
      select: { role: true, contentCiphertext: true, createdAt: true },
    });

    await tx.agentChatMessage.create({
      data: {
        userId,
        agentConfigId: agentConfig?.id ?? null,
        ceoAgentConfigId: ceoConfig?.id ?? null,
        role: "USER",
        contentCiphertext: encrypt(text),
        relatedRunId,
      },
    });

    // Sub-agent chats are scoped to that agent's own runs; the CEO chat reads
    // summaries across every agent the user owns.
    const runs = await tx.agentRun.findMany({
      where: { userId, ...(agentConfig ? { agentConfigId: agentConfig.id } : {}) },
      orderBy: { startedAt: "desc" },
      take: RUN_SUMMARY_LIMIT,
      select: { id: true, agentType: true, summary: true, startedAt: true },
    });

    let relatedRun = null;
    if (relatedRunId) {
      relatedRun = await tx.agentRun.findFirst({
        where: {
          id: relatedRunId,
          userId,
          ...(agentConfig ? { agentConfigId: agentConfig.id } : {}),
        },
      });
      if (!relatedRun) {
        // Fail closed: a sub-agent chat may not read another agent's run.
        throw new AgentError(
          "The referenced run does not exist or is not accessible from this chat.",
          "RUN_NOT_ACCESSIBLE",
          404
        );
      }
    }

    // The living profile lives on the CEO config regardless of which chat
    // this is; sub-agents read it too (shared memory).
    const profileSource =
      ceoConfig ??
      (await tx.ceoAgentConfig.findFirst({
        where: { userId },
        select: { profileCiphertext: true },
      }));

    return { agentConfig, ceoConfig, history, runs, relatedRun, profileSource };
  });

  const { agentConfig, ceoConfig, runs, relatedRun } = context;
  const history = [...context.history].reverse();
  const profile = normalizeProfile(
    context.profileSource?.profileCiphertext
      ? decryptJson(context.profileSource.profileCiphertext)
      : null
  );

  const identity = agentConfig
    ? `Agent name: ${agentConfig.name}\nAgent type: ${agentConfig.agentType}\nInstructions: ${agentConfig.instructions || "(none)"}`
    : `Agent name: ${ceoConfig.name}\nRole: CEO Agent (orchestrator)`;

  const sections = [
    "Reply to the user's new message using the context below.",
    dataSection("AGENT IDENTITY", identity),
  ];
  if (agentConfig) {
    sections.push(dataSection("DEFINITION OF DONE (user-configured)", agentConfig.definitionOfDone));
  }
  sections.push(
    dataSection("USER PROFILE (long-term memory)", renderProfileForPrompt(profile)),
    dataSection("RECENT RUN SUMMARIES", renderRunSummaries(runs))
  );
  if (relatedRun) {
    let relatedOutput;
    try {
      relatedOutput = relatedRun.outputCiphertext ? decrypt(relatedRun.outputCiphertext) : null;
    } catch {
      relatedOutput = null;
    }
    sections.push(
      dataSection(
        "RELATED RUN (full output)",
        `Run ${relatedRun.id} (${relatedRun.agentType}, ${relatedRun.status})\nSummary: ${relatedRun.summary || "(none)"}\nOutput:\n${relatedOutput || "(no stored output)"}`
      )
    );
  }
  sections.push(
    dataSection("CONVERSATION SO FAR", renderTranscript(history)),
    dataSection("NEW USER MESSAGE", text)
  );

  const model = agentConfig ? agentConfig.model : CEO_AGENT_MODEL;
  const { object, usage } = await generateAgentObject({
    model,
    system: agentConfig ? SUB_AGENT_CHAT_SYSTEM_PROMPT : CEO_CHAT_SYSTEM_PROMPT,
    prompt: sections.join("\n\n"),
    schema: CHAT_REPLY_SCHEMA,
    maxOutputTokens: 1200,
  });

  const reply = String(object?.reply || "").trim() || "Sorry — I could not generate a reply.";
  const replyMessage = await withUserContext(userId, (tx) =>
    tx.agentChatMessage.create({
      data: {
        userId,
        agentConfigId: agentConfig?.id ?? null,
        ceoAgentConfigId: ceoConfig?.id ?? null,
        role: "AGENT",
        contentCiphertext: encrypt(reply),
        relatedRunId,
      },
    })
  );

  // Profile ops arrive inside the same structured reply (no second model
  // call); applying them is best-effort and never fails the chat.
  try {
    await extractFromChatReply({
      userId,
      profileOps: object?.profileOps,
      source: agentConfig ? agentConfig.agentType : "ceo_chat",
    });
  } catch {
    // Best-effort by contract.
  }

  return { reply, messageId: replyMessage?.id ?? null, model, usage };
}
