import { withUserContext } from "../db/prisma.js";
import { decrypt, decryptJson, encrypt } from "../security/envelope.js";
import { CEO_AGENT_CONFIG_SAFE_SELECT } from "../agents/apiHelpers.js";
import { isCreationStateContent } from "../agents/creationFlow.js";
import { resolveConversationForWrite, touchConversation } from "../agents/conversations.js";
import { applySnippetTitleIfNeeded } from "../agents/conversationTitle.js";
import { loadDocumentsForPrompt } from "../agents/documents.js";
import { AgentError } from "../agents/errors.js";
import { CEO_AGENT_MODEL } from "../agents/llm.js";
import { dataSection } from "../agents/prompts.js";
import { normalizeProfile } from "../agents/profile.js";
import {
  buildIdentityNamespaces,
  renderIdentitySituationBrief,
  selectOwnedUserMemories,
} from "./identity.js";
import { selectRelevantMemories } from "./relevance.js";
import { sketchMissionFromConversation } from "../agents/ceoReasoning.js";
import {
  loadTeamAgents,
  renderNamedRunSummaries,
  renderTeamRoster,
} from "../agents/teamContext.js";
import { isMissingTimezoneColumnError, isValidIanaTimeZone } from "../agents/timezone.js";

// ─────────────────────────────────────────────────────────────────────────────
// Context Assembler — the single component responsible for context quality.
//
// Before every Brain model call, this module SELECTS the information relevant
// to the current request (recent conversation, long-term memory, workspace
// state, capability roster, current digest) and returns a curated context
// package — never the raw database. All future retrieval improvements (memory
// ranking, embeddings, relevance filters) land here, in one place.
//
// Curation in the vertical slice mirrors the tuned limits the legacy chat
// engine already uses (they define current production quality):
//   • last 50 messages of the ACTIVE conversation only
//   • last 20 run summaries across the user's agents
//   • relevance-selected memories with provenance annotations (the
//     Relevance Engine, server/brain/relevance.js — v2 step 1)
//   • up to 8 reference documents, capped per document
//   • the cached Daily Digest (never regenerated on the chat path)
// ─────────────────────────────────────────────────────────────────────────────

const CHAT_HISTORY_LIMIT = 50;
const RUN_SUMMARY_LIMIT = 20;

function renderTranscript(messages) {
  const lines = messages
    .map((message) => {
      let content;
      try {
        content = decrypt(message.contentCiphertext);
      } catch {
        content = "(message could not be decrypted)";
      }
      // Hidden agent-creation state rows are internal bookkeeping — never
      // conversation — and must not reach a prompt.
      if (isCreationStateContent(content)) return null;
      return `${message.role === "USER" ? "User" : "Assistant"}: ${content}`;
    })
    .filter(Boolean);
  return lines.length ? lines.join("\n") : "(no previous messages)";
}

/**
 * Observe + Assemble Context + Recall Relevant Memory.
 *
 * One RLS-scoped transaction that persists the user's message and gathers the
 * conversation-scoped rows, followed by decryption/rendering outside the
 * transaction. Returns the curated context package the Brain reasons over:
 * `{ ceoConfig, conversationId, conversationTitle, isFirstExchange, model,
 *    promptSections, lastUserMessage }`.
 */
export async function assembleBrainContext({
  userId,
  ceoAgentConfigId,
  conversationId = null,
  message,
  relatedRunId = null,
}) {
  const text = String(message || "").trim();
  if (!userId || !text) {
    throw new AgentError(
      "assembleBrainContext requires userId and a non-empty message.",
      "INVALID_ARGUMENT",
      400
    );
  }
  if (!ceoAgentConfigId) {
    throw new AgentError("assembleBrainContext requires ceoAgentConfigId.", "INVALID_ARGUMENT", 400);
  }

  const gathered = await withUserContext(userId, async (tx) => {
    const ceoConfig = await tx.ceoAgentConfig.findFirst({
      where: { id: ceoAgentConfigId, userId },
      select: CEO_AGENT_CONFIG_SAFE_SELECT,
    });
    if (!ceoConfig) {
      throw new AgentError("CEO Agent not found.", "CEO_AGENT_NOT_FOUND", 404);
    }

    const conversation = await resolveConversationForWrite(tx, {
      userId,
      ceoAgentConfigId: ceoConfig.id,
      conversationId,
      allowSystem: false,
    });

    // Conversation-scoped recall: only the active thread's recent messages.
    const history = await tx.agentChatMessage.findMany({
      where: { userId, conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
      take: CHAT_HISTORY_LIMIT,
      select: { role: true, contentCiphertext: true, createdAt: true },
    });
    const isFirstExchange = history.length === 0;

    await tx.agentChatMessage.create({
      data: {
        userId,
        conversationId: conversation.id,
        ceoAgentConfigId: ceoConfig.id,
        agentConfigId: null,
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

    // Workspace state: live capability roster + recent activity across all
    // of the user's agents (the Brain's cross-agent view).
    const teamAgents = await loadTeamAgents(tx, userId);
    const runs = await tx.agentRun.findMany({
      where: { userId },
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
        where: { id: relatedRunId, userId },
      });
      if (!relatedRun) {
        throw new AgentError(
          "The referenced run does not exist or is not accessible from this chat.",
          "RUN_NOT_ACCESSIBLE",
          404
        );
      }
    }

    let userRow;
    try {
      userRow = await tx.user.findUnique({
        where: { id: userId },
        select: { timezone: true, displayName: true, email: true },
      });
    } catch (error) {
      // Timezone / displayName column lag must not take down Brain chat.
      if (!isMissingTimezoneColumnError(error) && !isMissingUserIdentityColumnError(error)) {
        throw error;
      }
      try {
        userRow = await tx.user.findUnique({
          where: { id: userId },
          select: { timezone: true },
        });
      } catch (fallbackError) {
        if (!isMissingTimezoneColumnError(fallbackError)) throw fallbackError;
        userRow = null;
      }
    }

    return {
      ceoConfig,
      conversationId: conversation.id,
      conversationTitle,
      isFirstExchange,
      history,
      teamAgents,
      runs,
      relatedRun,
      userRow,
    };
  });

  const { ceoConfig, teamAgents, runs, relatedRun, userRow } = gathered;
  const userTimezone = userRow?.timezone ?? null;
  const history = [...gathered.history].reverse();

  // Recall Relevant Memory — via the Relevance Engine (v2 step 1): scored,
  // budgeted selection with provenance annotations instead of a raw dump.
  // The living profile is still the underlying store; step 2 (UserMemory
  // lifecycle) swaps the candidate side without touching anything outside
  // relevance.js.
  let profile;
  try {
    profile = normalizeProfile(
      ceoConfig.profileCiphertext ? decryptJson(ceoConfig.profileCiphertext) : null
    );
  } catch {
    profile = normalizeProfile(null);
  }

  // Topic signal for relevance scoring: the new message plus the user's last
  // few messages in this thread.
  const recentUserMessages = [];
  for (let i = history.length - 1; i >= 0 && recentUserMessages.length < 3; i -= 1) {
    if (history[i].role !== "USER") continue;
    try {
      const content = decrypt(history[i].contentCiphertext);
      if (!isCreationStateContent(content)) recentUserMessages.push(content);
    } catch {
      // Undecryptable rows contribute no topic signal.
    }
  }
  const selectedMemories = selectRelevantMemories(profile, {
    message: text,
    recentUserMessages,
  });

  let currentDigest = null;
  if (ceoConfig.lastDigestCiphertext) {
    try {
      currentDigest = decrypt(ceoConfig.lastDigestCiphertext);
    } catch {
      currentDigest = null;
    }
  }

  const tzLabel =
    userTimezone && isValidIanaTimeZone(userTimezone)
      ? userTimezone
      : "(unknown — detect from browser or ask the user for an IANA timezone; do not assume UTC)";

  const documents = await loadDocumentsForPrompt(userId);

  // Identity namespaces — assistant / user / workspace stay separated.
  // Assistant name (e.g. Harry) never enters USER IDENTITY or RELEVANT MEMORIES.
  const identities = buildIdentityNamespaces({
    ceoConfig,
    user: {
      displayName: userRow?.displayName ?? null,
      email: userRow?.email ?? null,
      timezone: userTimezone && isValidIanaTimeZone(userTimezone) ? userTimezone : null,
    },
    teamAgents,
    profile,
  });
  const ownedMemories = selectOwnedUserMemories(selectedMemories, {
    assistantName: identities.assistantIdentity.name,
  });

  // Plaintext user turns already in this thread (oldest → newest), for mission
  // continuity sketches. Does not include the new message yet.
  const userMessagesInOrder = [];
  for (const row of history) {
    if (row.role !== "USER") continue;
    try {
      const content = decrypt(row.contentCiphertext);
      if (!isCreationStateContent(content)) userMessagesInOrder.push(content);
    } catch {
      // skip undecryptable
    }
  }
  const activeMission = sketchMissionFromConversation([...userMessagesInOrder, text], {
    existingAgents: teamAgents || [],
  });

  const promptSections = [
    "Reply to the user's new message using the structured context below.",
    ...renderIdentitySituationBrief({
      identities,
      activeMission,
      relevantMemories: ownedMemories,
    }),
    dataSection("YOUR CAPABILITIES (specialist agent roster)", renderTeamRoster(teamAgents)),
    dataSection("RECENT RUN SUMMARIES", renderNamedRunSummaries(runs, teamAgents)),
    dataSection("USER TIMEZONE", tzLabel),
    dataSection(
      "CURRENT DAILY DIGEST (shown on Freedom OS home)",
      currentDigest || "(empty — not set yet)"
    ),
    dataSection("USER REFERENCE DOCUMENTS", documents),
  ];

  if (relatedRun) {
    let relatedOutput;
    try {
      relatedOutput = relatedRun.outputCiphertext ? decrypt(relatedRun.outputCiphertext) : null;
    } catch {
      relatedOutput = null;
    }
    promptSections.push(
      dataSection(
        "RELATED RUN (full output)",
        `Run ${relatedRun.id} (${relatedRun.agentType}, ${relatedRun.status})\nSummary: ${relatedRun.summary || "(none)"}\nOutput:\n${relatedOutput || "(no stored output)"}`
      )
    );
  }

  promptSections.push(
    dataSection("CONVERSATION SO FAR", renderTranscript(history)),
    dataSection("NEW USER MESSAGE", text)
  );

  return {
    ceoConfig,
    conversationId: gathered.conversationId,
    conversationTitle: gathered.conversationTitle,
    isFirstExchange: gathered.isFirstExchange,
    model: ceoConfig.model || CEO_AGENT_MODEL,
    promptSections,
    lastUserMessage: text,
    userMessagesInOrder,
    teamAgents,
    identities,
    activeMission,
  };
}

function isMissingUserIdentityColumnError(error) {
  const message = String(error?.message || "");
  return (
    error?.code === "P2022" &&
    (/displayName/i.test(message) || /email/i.test(message) || /User/i.test(message))
  );
}
