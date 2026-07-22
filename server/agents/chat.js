import { jsonSchema } from "ai";

import { withUserContext } from "../db/prisma.js";
import { decrypt, decryptJson, encrypt } from "../security/envelope.js";
import { CEO_AGENT_CONFIG_SAFE_SELECT } from "./apiHelpers.js";
import { isCreationStateContent } from "./creationFlow.js";
import { resolveConversationForWrite, touchConversation } from "./conversations.js";
import {
  applySnippetTitleIfNeeded,
  scheduleConversationTitle,
} from "./conversationTitle.js";
import { loadDocumentsForPrompt } from "./documents.js";
import { AgentError } from "./errors.js";
import { CEO_AGENT_MODEL, generateAgentObject } from "./llm.js";
import {
  applySubAgentTaskAction,
  sanitizeTaskAction,
  TASK_ACTION_JSON_SCHEMA,
} from "./chatActions.js";
import {
  applyCeoDigestAction,
  DIGEST_ACTION_JSON_SCHEMA,
  sanitizeDigestAction,
} from "./digest.js";
import { cronToSchedulePreset, formatHourUtcLabel } from "./schedule.js";
import { isEmailDeliveryEnabled } from "./emailDelivery.js";
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
//   • Always-include context (profile, docs, run summaries) is shared across
//     conversations for that agent. Conversation-scoped context is only the
//     message history for the active conversationId.
// ─────────────────────────────────────────────────────────────────────────────

const CHAT_HISTORY_LIMIT = 50;
const RUN_SUMMARY_LIMIT = 20;

const CEO_CHAT_REPLY_SCHEMA = jsonSchema({
  type: "object",
  properties: {
    reply: { type: "string", description: "Your conversational reply to the user's message." },
    profileOps: PROFILE_OPS_JSON_SCHEMA,
    digestAction: DIGEST_ACTION_JSON_SCHEMA,
  },
  required: ["reply", "profileOps", "digestAction"],
  additionalProperties: false,
});

const SUB_AGENT_CHAT_REPLY_SCHEMA = jsonSchema({
  type: "object",
  properties: {
    reply: { type: "string", description: "Your conversational reply to the user's message." },
    profileOps: PROFILE_OPS_JSON_SCHEMA,
    taskAction: TASK_ACTION_JSON_SCHEMA,
  },
  required: ["reply", "profileOps", "taskAction"],
  additionalProperties: false,
});

const SUB_AGENT_CHAT_SYSTEM_PROMPT = [
  "You are one of the user's agents inside Freedom OS, chatting with the user about your own work. Your identity, current settings, and recent activity are provided as data sections.",
  "Answer questions about your runs and findings using only the provided context.",
  "You CAN manage your own task: when the user asks you to change YOUR schedule, instructions, definition of done, name, pause/resume, enable/disable emailing them your reports, run yourself now, or email them a report — set taskAction accordingly and confirm the change in your reply. The server applies taskAction; do not claim you are unable to do these things, and do not redirect the user to the CEO Agent for your own settings.",
  "Supported schedules for YOU: on-demand, daily, weekly on one or more weekdays (e.g. monday+wednesday+friday), or monthly — each with an optional hour in UTC (0–23; default 13). Use scheduleWeekdays for multiple days and scheduleHourUtc for the clock hour. There is no separate CEO-only \"advanced schedule\"; do not invent one or bounce the user to the CEO Agent for scheduling.",
  "If the user asks for something outside those options (raw cron, every N hours, per-minute runs, or non-UTC timezones), say so honestly and offer the closest supported schedule.",
  "If the request is about another agent's work or creating a new agent, say so and point the user to their CEO Agent. Never invent side effects outside taskAction.",
  "Never give directives such as buy/sell/move money and never make investment recommendations.",
  "Also return profileOps: durable facts about the user revealed in this conversation (usually an empty array). Set taskAction to null when the user is only asking a question.",
  "Safety rules:",
  `- ${PROMPT_SAFETY_RULES}`,
].join("\n");

const CEO_CHAT_SYSTEM_PROMPT = [
  "You are the user's CEO Agent inside Freedom OS: the orchestrator of their team of financially read-only agents, and their main point of contact.",
  "Answer using the provided context: recent run summaries from ALL of the user's agents (cross-agent questions are your job) and the user's long-term profile. When asked what you know about the user, answer from the profile data section.",
  "You CAN edit the Daily Digest shown on the Freedom OS home when the user asks: set digestAction to set_content with the full body text they want there (rewrite, replace, shorten, or write whatever they request), or regenerate to rebuild the default briefing from recent agent runs. The server applies digestAction — do not claim you cannot change the digest. Output digest body only (no \"Status Update\" / \"Daily Digest\" heading). Set digestAction to null when they are not asking to change the digest.",
  "You cannot edit a sub-agent's schedule, instructions, email settings, or trigger its runs from this chat. When the user wants those changes for a specific agent, tell them to open that agent's own chat and ask the agent directly — that agent can apply those task changes itself. Do not claim the sub-agent is powerless, and do not imply that you will make the edit from here.",
  "Sub-agent schedules support: on-demand, daily, weekly on one or more weekdays, or monthly, with an optional UTC hour. There is no CEO-only advanced scheduler — do not invent one or bounce the user back and forth.",
  "Never give directives such as buy/sell/move money and never make investment recommendations.",
  "Also return profileOps: durable facts about the user revealed in this conversation (usually an empty array).",
  "Safety rules:",
  `- ${PROMPT_SAFETY_RULES}`,
].join("\n");

function renderAgentSettings(agentConfig) {
  const schedule = cronToSchedulePreset(agentConfig.schedule);
  let scheduleLabel = "on-demand (no schedule)";
  const hourLabel = formatHourUtcLabel(schedule?.hourUtc);
  if (schedule?.preset === "weekly") {
    const days = schedule.weekdays?.length
      ? schedule.weekdays.join(", ")
      : schedule.weekday || "monday";
    scheduleLabel = hourLabel ? `weekly (${days}) at ${hourLabel}` : `weekly (${days})`;
  } else if (schedule?.preset) {
    scheduleLabel = hourLabel ? `${schedule.preset} at ${hourLabel}` : schedule.preset;
  }
  const emailOn = isEmailDeliveryEnabled(agentConfig.toolAccess);
  return [
    `Status: ${agentConfig.status}`,
    `Schedule: ${scheduleLabel}`,
    `Email reports after each run: ${emailOn ? "enabled" : "disabled"}`,
    `Model: ${agentConfig.model || "(default)"}`,
  ].join("\n");
}

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
  conversationId = null,
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
      ceoConfig = await tx.ceoAgentConfig.findFirst({
        where: { id: ceoAgentConfigId, userId },
        select: CEO_AGENT_CONFIG_SAFE_SELECT,
      });
      if (!ceoConfig) {
        throw new AgentError("CEO Agent not found.", "CEO_AGENT_NOT_FOUND", 404);
      }
    }

    // Explicit conversationId when provided; otherwise newest non-system thread.
    const conversation = await resolveConversationForWrite(tx, {
      userId,
      agentConfigId: agentConfig?.id ?? null,
      ceoAgentConfigId: ceoConfig?.id ?? null,
      conversationId,
      allowSystem: false,
    });

    // Conversation-scoped context only — profile / docs / runs load separately.
    const history = await tx.agentChatMessage.findMany({
      where: {
        userId,
        conversationId: conversation.id,
      },
      orderBy: { createdAt: "desc" },
      take: CHAT_HISTORY_LIMIT,
      select: { role: true, contentCiphertext: true, createdAt: true },
    });
    const isFirstExchange = history.length === 0;

    await tx.agentChatMessage.create({
      data: {
        userId,
        conversationId: conversation.id,
        agentConfigId: agentConfig?.id ?? null,
        ceoAgentConfigId: ceoConfig?.id ?? null,
        role: "USER",
        contentCiphertext: encrypt(text),
        relatedRunId,
      },
    });
    await touchConversation(tx, conversation.id);
    const conversationTitle = await applySnippetTitleIfNeeded(tx, {
      conversationId: conversation.id,
      messageText: text,
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

    return {
      agentConfig,
      ceoConfig,
      conversationId: conversation.id,
      conversationTitle,
      isFirstExchange,
      history,
      runs,
      relatedRun,
      profileSource,
    };
  });

  const {
    agentConfig,
    ceoConfig,
    conversationId: resolvedConversationId,
    conversationTitle: snippetTitle,
    isFirstExchange,
    runs,
    relatedRun,
  } = context;
  const history = [...context.history].reverse();
  let profile;
  try {
    profile = normalizeProfile(
      context.profileSource?.profileCiphertext
        ? decryptJson(context.profileSource.profileCiphertext)
        : null
    );
  } catch {
    profile = normalizeProfile(null);
  }

  const identity = agentConfig
    ? `Agent name: ${agentConfig.name}\nAgent type: ${agentConfig.agentType}\nInstructions: ${agentConfig.instructions || "(none)"}`
    : `Agent name: ${ceoConfig.name}\nRole: CEO Agent (orchestrator)`;

  const sections = [
    "Reply to the user's new message using the context below.",
    dataSection("AGENT IDENTITY", identity),
  ];
  if (agentConfig) {
    sections.push(dataSection("CURRENT SETTINGS (this agent)", renderAgentSettings(agentConfig)));
    sections.push(dataSection("DEFINITION OF DONE (user-configured)", agentConfig.definitionOfDone));
  }
  sections.push(
    dataSection("USER PROFILE (long-term memory)", renderProfileForPrompt(profile)),
    dataSection("RECENT RUN SUMMARIES", renderRunSummaries(runs))
  );
  // Reference documents are CEO-scoped context (uploaded during onboarding /
  // from the profile page). Sub-agent chats stay on their own run scope.
  if (ceoConfig && !agentConfig) {
    let currentDigest = null;
    if (ceoConfig.lastDigestCiphertext) {
      try {
        currentDigest = decrypt(ceoConfig.lastDigestCiphertext);
      } catch {
        currentDigest = null;
      }
    }
    sections.push(
      dataSection(
        "CURRENT DAILY DIGEST (shown on Freedom OS home)",
        currentDigest || "(empty — not set yet)"
      )
    );
    const documents = await loadDocumentsForPrompt(userId);
    sections.push(dataSection("USER REFERENCE DOCUMENTS", documents));
  }
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

  const model = agentConfig
    ? agentConfig.model || CEO_AGENT_MODEL
    : ceoConfig?.model || CEO_AGENT_MODEL;
  const { object, usage } = await generateAgentObject({
    model,
    system: agentConfig ? SUB_AGENT_CHAT_SYSTEM_PROMPT : CEO_CHAT_SYSTEM_PROMPT,
    prompt: sections.join("\n\n"),
    schema: agentConfig ? SUB_AGENT_CHAT_REPLY_SCHEMA : CEO_CHAT_REPLY_SCHEMA,
    maxOutputTokens: 1200,
  });

  let reply = String(object?.reply || "").trim() || "Sorry — I could not generate a reply.";
  let actionResult = null;
  let digestResult = null;

  // Sub-agent taskAction is applied server-side after the model reply. The
  // model must not invent side effects — only this allowlisted path mutates.
  if (agentConfig) {
    try {
      const action = sanitizeTaskAction(object?.taskAction ?? null);
      if (action) {
        actionResult = await applySubAgentTaskAction({
          userId,
          agentConfigId: agentConfig.id,
          conversationId: resolvedConversationId,
          message: text,
          action,
          relatedRunId,
          persist: false,
        });
        // Prefer the authoritative server confirmation over a hedged model reply.
        if (actionResult?.reply) {
          reply = actionResult.reply;
        }
      }
    } catch (error) {
      if (error instanceof AgentError) {
        reply = `${reply}\n\n(I couldn't apply that change: ${error.message})`;
      } else {
        reply = `${reply}\n\n(I couldn't apply that change right now.)`;
      }
    }
  } else if (ceoConfig) {
    // CEO digestAction — same allowlisted server-apply pattern as taskAction.
    try {
      const action = sanitizeDigestAction(object?.digestAction ?? null);
      if (action) {
        digestResult = await applyCeoDigestAction(userId, action);
        if (digestResult?.reply) {
          reply = digestResult.reply;
        }
      }
    } catch (error) {
      if (error instanceof AgentError) {
        reply = `${reply}\n\n(I couldn't update the Daily Digest: ${error.message})`;
      } else {
        reply = `${reply}\n\n(I couldn't update the Daily Digest right now.)`;
      }
    }
  }

  const replyMessage = await withUserContext(userId, async (tx) => {
    const created = await tx.agentChatMessage.create({
      data: {
        userId,
        conversationId: resolvedConversationId,
        agentConfigId: agentConfig?.id ?? null,
        ceoAgentConfigId: ceoConfig?.id ?? null,
        role: "AGENT",
        contentCiphertext: encrypt(reply),
        relatedRunId: actionResult?.run?.id || relatedRunId,
      },
    });
    await touchConversation(tx, resolvedConversationId);
    return created;
  });

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

  // Title upgrade after the first exchange — never blocks the reply.
  if (isFirstExchange) {
    scheduleConversationTitle({
      userId,
      conversationId: resolvedConversationId,
      userMessage: text,
      agentReply: reply,
      snippetTitle,
    });
  }

  return {
    reply,
    messageId: replyMessage?.id ?? null,
    conversationId: resolvedConversationId,
    conversationTitle: snippetTitle,
    model,
    usage,
    ...(actionResult?.agent ? { agent: actionResult.agent } : {}),
    ...(actionResult?.run ? { run: actionResult.run } : {}),
    ...(digestResult
      ? {
          digest: {
            digest: digestResult.digest,
            generatedAt: digestResult.generatedAt,
            refreshed: true,
          },
        }
      : {}),
  };
}
