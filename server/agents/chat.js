import { jsonSchema, Output, stepCountIs } from "ai";

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
import {
  CEO_AGENT_MODEL,
  generateAgentObject,
  generateAgentText,
  getWebSearchTools,
} from "./llm.js";
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
import {
  applyCeoActions,
  CEO_ACTIONS_JSON_SCHEMA,
} from "./ceoOps.js";
import {
  CEO_MISSION_REASONING_RULES,
  logCeoReasoning,
  sketchMissionFromConversation,
} from "./ceoReasoning.js";
import { cronToSchedulePreset, formatHourUtcLabel } from "./schedule.js";
import { isEmailDeliveryEnabled } from "./emailDelivery.js";
import {
  buildExecutionEvidence,
  classifyAgentRequest,
  guardAgentReply,
  isMutatingActionAllowed,
  logExecutionGuard,
  renderRequestClassificationSection,
  renderSubAgentAuthoritySection,
} from "./executionContract.js";
import { CHAT_PLAIN_TEXT_RULE, dataSection, PROMPT_SAFETY_RULES } from "./prompts.js";
import {
  loadPrimaryActivePlan,
  renderPlanMission,
  toActiveMissionFromPlan,
} from "../brain/plans.js";
import {
  extractFromChatReply,
  normalizeProfile,
  PROFILE_OPS_JSON_SCHEMA,
  renderProfileForPrompt,
} from "./profile.js";
import {
  loadTeamAgents,
  renderNamedRunSummaries,
  renderTeamRoster,
} from "./teamContext.js";
import {
  DEFAULT_USER_TIMEZONE,
  isMissingTimezoneColumnError,
  isValidIanaTimeZone,
} from "./timezone.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared chat engine for the CEO Agent chat and every sub-agent chat.
//
// Scoping contract (enforced in the queries, inside the user's RLS context):
//   • a sub-agent chat may read ONLY its own runs and its own chat messages;
//   • the CEO chat reads the live sub-agent roster + run summaries across ALL
//     the user's agents — cross-agent questions are its job — plus the living
//     profile, which is how it answers "what do you know about me?".
//   • Always-include context (profile, docs, team roster, run summaries) is
//     shared across conversations for that agent. Conversation-scoped context
//     is only the message history for the active conversationId.
// ─────────────────────────────────────────────────────────────────────────────

const CHAT_HISTORY_LIMIT = 50;
const RUN_SUMMARY_LIMIT = 20;
/** Max read-only Anthropic web searches per CEO chat turn (live facts). */
const CEO_WEB_SEARCH_MAX_USES = 5;
/** Tool rounds + final structured reply (structured output counts as a step). */
const CEO_CHAT_MAX_STEPS = 8;

const CEO_CHAT_REPLY_SCHEMA = jsonSchema({
  type: "object",
  properties: {
    reply: { type: "string", description: "Your conversational reply to the user's message." },
    profileOps: PROFILE_OPS_JSON_SCHEMA,
    digestAction: DIGEST_ACTION_JSON_SCHEMA,
    ceoActions: CEO_ACTIONS_JSON_SCHEMA,
  },
  required: ["reply", "profileOps", "digestAction", "ceoActions"],
  additionalProperties: false,
});

const EMPTY_REPLY_FALLBACK =
  "A generation error occurred and I could not complete that reply. Please ask again, or try rephrasing.";
const CEO_CHAT_GENERATE_ATTEMPTS = 2;

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
  CHAT_PLAIN_TEXT_RULE,
  "Safety rules:",
  `- ${PROMPT_SAFETY_RULES}`,
].join("\n");

const CEO_CHAT_SYSTEM_PROMPT = [
  "You are the user's CEO Agent inside Freedom OS — the single conversation through which they operate the platform. There is no separate agent-builder mode.",
  CEO_MISSION_REASONING_RULES,
  "Answer using the provided context: YOUR SUB-AGENTS (the live team roster), recent run summaries from ALL of the user's agents, the current Daily Digest, USER TIMEZONE, and the user's long-term profile. When asked what you know about the user, answer from the profile data section.",
  "You have read-only web search for live / current information. When the user asks something that needs up-to-date facts, use web search before answering. Never claim you lack internet access.",
  "When the user asks which agents they have: answer ONLY from YOUR SUB-AGENTS. Never invent agents that are not listed. A newly created agent may have zero runs — prefer the roster over run summaries for membership.",
  "OPERATE the platform via ceoActions (server-applied). You CAN: create_agent, update_agent (pause/resume/schedule/instructions/email/model), run_agent (delegate work to a specialist), delete_agent (only with confirmed=true after explicit user confirmation), set_timezone. For create_agent: ask only execution blockers first; call create_agent only when the mission is executable — never invent type, restrictions, or personality.",
  "Schedules are always in the user's LOCAL timezone. Use scheduleHourLocal (0–23) and the USER TIMEZONE context. Never ask the user to think in UTC. If timezone is unknown, the platform defaults to America/New_York (Eastern); prefer set_timezone when the user states a different zone.",
  "Research agents already use web search; enabling email delivery is emailDelivery=true on create/update. After create_agent in the same turn you may run_agent with agentId \"__last_created__\" or omitted.",
  "Delegate automatically when a specialist should do the work: set run_agent. The server monitors short jobs and returns results in this conversation; longer jobs notify later in this same conversation. Do not tell the user to open another screen or another agent chat for routine ops — specialist chats exist for deep SME follow-up on a report, not as a required detour.",
  "Truthfulness: state facts from tool/context confidently; label inferences as inferences; if you do not know, say so. Never invent operational facts (agents, schedules, run statuses, triggers).",
  "You CAN edit the Daily Digest via digestAction (set_content or regenerate). Set digestAction to null when not changing it. Output digest body only (no \"Daily Digest\" heading).",
  "Destructive actions (delete_agent): never set confirmed=true unless the user explicitly confirmed in this conversation. Propose first, then execute on confirmation.",
  "Never give directives such as buy/sell/move money and never make investment recommendations.",
  "Also return profileOps: durable facts about the user revealed in this conversation (usually an empty array). Set ceoActions to null when the user is only asking a question.",
  CHAT_PLAIN_TEXT_RULE,
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

  if (ceoAgentConfigId) {
    // Single-message sketch for legacy path; Brain uses full thread continuity.
    logCeoReasoning(sketchMissionFromConversation([text]));
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
    // the live team roster plus summaries across every agent the user owns.
    const teamAgents = agentConfig ? [] : await loadTeamAgents(tx, userId);
    const runs = await tx.agentRun.findMany({
      where: { userId, ...(agentConfig ? { agentConfigId: agentConfig.id } : {}) },
      orderBy: { startedAt: "desc" },
      take: RUN_SUMMARY_LIMIT,
      select: {
        id: true,
        agentConfigId: true,
        agentType: true,
        summary: true,
        startedAt: true,
      },
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

    let userTimezone;
    try {
      const userRow = await tx.user.findUnique({
        where: { id: userId },
        select: { timezone: true },
      });
      userTimezone = userRow?.timezone ?? null;
    } catch (error) {
      // Timezone column lag must not take down CEO chat.
      if (!isMissingTimezoneColumnError(error)) throw error;
      userTimezone = null;
    }

    return {
      agentConfig,
      ceoConfig,
      conversationId: conversation.id,
      conversationTitle,
      isFirstExchange,
      history,
      teamAgents,
      runs,
      relatedRun,
      profileSource,
      userTimezone,
    };
  });

  const {
    agentConfig,
    ceoConfig,
    conversationId: resolvedConversationId,
    conversationTitle: snippetTitle,
    isFirstExchange,
    teamAgents,
    runs,
    relatedRun,
    userTimezone,
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
    ? [
        `Agent name: ${agentConfig.name}`,
        `Agent type: ${agentConfig.agentType}`,
        `Instructions: ${agentConfig.instructions || "(none)"}`,
        agentConfig.personalityNotes
          ? `Personality: ${agentConfig.personalityNotes}`
          : null,
        agentConfig.boundaries ? `Boundaries (will never): ${agentConfig.boundaries}` : null,
        agentConfig.workingFromNotes
          ? `Working from: ${agentConfig.workingFromNotes}`
          : null,
      ]
        .filter(Boolean)
        .join("\n")
    : `Agent name: ${ceoConfig.name}\nRole: CEO Agent (orchestrator)`;

  const requestKind = classifyAgentRequest(text);

  const sections = [
    "Reply to the user's new message using the context below.",
    dataSection("AGENT IDENTITY", identity),
    dataSection("REQUEST CLASSIFICATION", renderRequestClassificationSection(requestKind)),
  ];
  if (agentConfig) {
    sections.push(
      dataSection("AGENT AUTHORITY (CEO control plane)", renderSubAgentAuthoritySection())
    );
    sections.push(dataSection("CURRENT SETTINGS (this agent)", renderAgentSettings(agentConfig)));
    sections.push(dataSection("DEFINITION OF DONE (user-configured)", agentConfig.definitionOfDone));
    // Read-only CEO Plan context — sub-agents cannot create/update Plans.
    try {
      const primaryPlan = await loadPrimaryActivePlan(userId);
      if (primaryPlan) {
        const mission = toActiveMissionFromPlan(primaryPlan.row, primaryPlan.body);
        sections.push(
          dataSection(
            "CEO ACTIVE PLAN (executive intent — read-only)",
            [
              renderPlanMission(mission),
              "note: You may reason against this intent and return evidence. You cannot create or update Plans.",
            ].join("\n")
          )
        );
      }
    } catch {
      // Plan load is best-effort for sub-agent context.
    }
  }
  sections.push(dataSection("USER PROFILE (long-term memory)", renderProfileForPrompt(profile)));
  const runLabelAgents = agentConfig ? [agentConfig] : teamAgents;
  // Live team roster / digest stay CEO-scoped. Reference documents are shared
  // so uploads from CEO or sub-agent chat are available in both.
  if (ceoConfig && !agentConfig) {
    sections.push(dataSection("YOUR SUB-AGENTS (current team)", renderTeamRoster(teamAgents)));
    sections.push(
      dataSection("RECENT RUN SUMMARIES", renderNamedRunSummaries(runs, runLabelAgents))
    );
    const tzLabel =
      userTimezone && isValidIanaTimeZone(userTimezone)
        ? userTimezone
        : `${DEFAULT_USER_TIMEZONE} (platform default — Eastern Time; user may override)`;
    sections.push(dataSection("USER TIMEZONE", tzLabel));
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
  } else {
    sections.push(
      dataSection("RECENT RUN SUMMARIES", renderNamedRunSummaries(runs, runLabelAgents))
    );
  }
  const documents = await loadDocumentsForPrompt(userId);
  sections.push(dataSection("USER REFERENCE DOCUMENTS", documents));
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

  // CEO chat: structured reply + Anthropic provider-executed web search so
  // live questions (schedules, news, etc.) can be looked up. Sub-agent chat
  // stays scoped to its own context without web search.
  let object;
  let usage;
  if (ceoConfig) {
    for (let attempt = 1; attempt <= CEO_CHAT_GENERATE_ATTEMPTS; attempt += 1) {
      const result = await generateAgentText({
        model,
        system: CEO_CHAT_SYSTEM_PROMPT,
        prompt: sections.join("\n\n"),
        tools: getWebSearchTools({ maxUses: CEO_WEB_SEARCH_MAX_USES }),
        output: Output.object({ schema: CEO_CHAT_REPLY_SCHEMA }),
        stopWhen: stepCountIs(CEO_CHAT_MAX_STEPS),
        maxOutputTokens: 1800,
        // jsonTool avoids native grammar compile timeouts when tools + schema run together.
        providerOptions: {
          anthropic: { structuredOutputMode: "jsonTool" },
        },
      });
      object = result.output;
      usage = result.usage;
      if (String(object?.reply || "").trim()) break;
    }
  } else {
    const result = await generateAgentObject({
      model,
      system: SUB_AGENT_CHAT_SYSTEM_PROMPT,
      prompt: sections.join("\n\n"),
      schema: SUB_AGENT_CHAT_REPLY_SCHEMA,
      maxOutputTokens: 1200,
    });
    object = result.object;
    usage = result.usage;
  }

  let reply = String(object?.reply || "").trim() || EMPTY_REPLY_FALLBACK;
  let actionResult = null;
  let digestResult = null;
  let ceoOpsResult = null;
  let appliedTaskActionType = null;

  // Sub-agent taskAction is applied server-side after the model reply. The
  // model must not invent side effects — only this allowlisted path mutates.
  // Status / information asks never execute mutating actions (intent ≠ execution).
  if (agentConfig) {
    try {
      const action = sanitizeTaskAction(object?.taskAction ?? null);
      if (action) {
        if (!isMutatingActionAllowed(requestKind, action.type)) {
          logExecutionGuard({
            event: "task_action_blocked",
            requestKind,
            actionBlocked: true,
            failures: [`blocked_action:${action.type}`],
          });
        } else {
          appliedTaskActionType = action.type;
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
      }
    } catch (error) {
      if (error instanceof AgentError) {
        reply = `${reply}\n\n(I couldn't apply that change: ${error.message})`;
      } else {
        reply = `${reply}\n\n(I couldn't apply that change right now.)`;
      }
    }
  } else if (ceoConfig) {
    // CEO digestAction + ceoActions — allowlisted server-apply only.
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

    try {
      ceoOpsResult = await applyCeoActions({
        userId,
        ceoAgentConfigId: ceoConfig.id,
        conversationId: resolvedConversationId,
        actions: object?.ceoActions ?? null,
      });
      if (ceoOpsResult?.reply) {
        // Prefer authoritative ops confirmation; keep a short model preface if useful.
        const modelPreface = String(object?.reply || "").trim();
        reply =
          modelPreface && modelPreface !== EMPTY_REPLY_FALLBACK
            ? `${modelPreface}\n\n${ceoOpsResult.reply}`
            : ceoOpsResult.reply;
      }
    } catch (error) {
      if (error instanceof AgentError) {
        reply = `${reply}\n\n(I couldn't complete that operation: ${error.message})`;
      } else {
        reply = `${reply}\n\n(I couldn't complete that operation right now.)`;
      }
    }
  }

  // Shared execution-contract guard — CEO and sub-agents inherit the same rules.
  const evidence = buildExecutionEvidence({
    actionResult,
    taskActionType: appliedTaskActionType,
    turnState: ceoOpsResult
      ? {
          agent: ceoOpsResult.agent || null,
          run: ceoOpsResult.run || null,
          confirmations: ceoOpsResult.reply ? [ceoOpsResult.reply] : [],
        }
      : null,
    relatedRun,
    recentRuns: runs,
    emailDeliveryEnabled: agentConfig
      ? isEmailDeliveryEnabled(agentConfig.toolAccess)
      : false,
  });
  const guarded = guardAgentReply({
    reply,
    userMessage: text,
    evidence,
    requestKind,
  });
  reply = guarded.reply;

  const relatedFromOps =
    ceoOpsResult?.run?.id || actionResult?.run?.id || relatedRunId || null;

  const replyMessage = await withUserContext(userId, async (tx) => {
    const created = await tx.agentChatMessage.create({
      data: {
        userId,
        conversationId: resolvedConversationId,
        agentConfigId: agentConfig?.id ?? null,
        ceoAgentConfigId: ceoConfig?.id ?? null,
        role: "AGENT",
        contentCiphertext: encrypt(reply),
        relatedRunId: relatedFromOps,
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
    ...(actionResult?.agent || ceoOpsResult?.agent
      ? { agent: actionResult?.agent || ceoOpsResult?.agent }
      : {}),
    ...(actionResult?.run || ceoOpsResult?.run
      ? { run: actionResult?.run || ceoOpsResult?.run }
      : {}),
    ...(ceoOpsResult?.mode ? { runMode: ceoOpsResult.mode } : {}),
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
