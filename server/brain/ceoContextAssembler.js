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
import { sketchMissionFromConversation, logCeoReasoning } from "../agents/ceoReasoning.js";
import {
  loadTeamAgents,
  renderNamedRunSummaries,
  renderTeamRoster,
} from "../agents/teamContext.js";
import { isMissingTimezoneColumnError, isValidIanaTimeZone } from "../agents/timezone.js";
import {
  listCapabilities,
  renderCapabilityRegistry,
} from "../capabilities/registry.js";
import {
  buildIdentityNamespaces,
  renderIdentitySituationBrief,
  selectOwnedUserMemories,
} from "./identity.js";
import {
  assessControlPlaneRequest,
  buildExecutionState,
  renderCapabilitySituationBrief,
} from "./controlPlane.js";
import { selectRelevantMemories } from "./relevance.js";
import { buildApplicationWorldModel } from "./worldModel.js";
import { logCeoContextAssembly } from "./observability.js";
import { CEO_REASONING_MIGRATION_STATUS } from "./ceoReasoningDependencies.js";

// ─────────────────────────────────────────────────────────────────────────────
// CEOContextAssembler — every CEO turn receives a structured snapshot of reality
// before reasoning.
//
// CODE OWNS TRUTH · DATABASE OWNS STATE · TOOLS OWN CAPABILITIES · CEO OWNS JUDGMENT
//
// ceoReasoning.js remains a transitional continuity sketch only (Phase 1).
// It must not override world-model truth or CEO judgment.
// ─────────────────────────────────────────────────────────────────────────────

const CHAT_HISTORY_LIMIT = 50;
const RUN_SUMMARY_LIMIT = 20;

/** Real Brain-callable tools (must match toolBelt). */
export const CEO_ENABLED_TOOLS = Object.freeze([
  "web_search",
  "create_agent",
  "update_agent",
  "run_agent",
  "delete_agent",
  "set_timezone",
  "update_digest",
]);

/**
 * Assemble the full CEO world-model context for one turn.
 * Prefer this over calling sketch/control-plane helpers ad hoc.
 */
export async function assembleCeoContext({
  userId,
  ceoAgentConfigId,
  conversationId = null,
  message,
  relatedRunId = null,
}) {
  const text = String(message || "").trim();
  if (!userId || !text) {
    throw new AgentError(
      "assembleCeoContext requires userId and a non-empty message.",
      "INVALID_ARGUMENT",
      400
    );
  }
  if (!ceoAgentConfigId) {
    throw new AgentError("assembleCeoContext requires ceoAgentConfigId.", "INVALID_ARGUMENT", 400);
  }

  const gathered = await gatherConversationAndWorkspaceRows({
    userId,
    ceoAgentConfigId,
    conversationId,
    text,
    relatedRunId,
  });

  const { ceoConfig, teamAgents, runs, relatedRun, userRow } = gathered;
  const userTimezone = userRow?.timezone ?? null;
  const history = [...gathered.history].reverse();

  let profile;
  try {
    profile = normalizeProfile(
      ceoConfig.profileCiphertext ? decryptJson(ceoConfig.profileCiphertext) : null
    );
  } catch {
    profile = normalizeProfile(null);
  }

  const recentUserMessages = [];
  for (let i = history.length - 1; i >= 0 && recentUserMessages.length < 3; i -= 1) {
    if (history[i].role !== "USER") continue;
    try {
      const content = decrypt(history[i].contentCiphertext);
      if (!isCreationStateContent(content)) recentUserMessages.push(content);
    } catch {
      // skip
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
  // Permissions constitution — always READ_ONLY for financial side effects.
  identities.permissions = {
    financial: "READ_ONLY",
    agentPermissionLevelDefault: "READ_ONLY",
    canMoveMoney: false,
    canTrade: false,
  };

  const ownedMemories = selectOwnedUserMemories(selectedMemories, {
    assistantName: identities.assistantIdentity.name,
  });

  const userMessagesInOrder = [];
  for (const row of history) {
    if (row.role !== "USER") continue;
    try {
      const content = decrypt(row.contentCiphertext);
      if (!isCreationStateContent(content)) userMessagesInOrder.push(content);
    } catch {
      // skip
    }
  }

  // Transitional continuity sketch — NOT the judgment authority.
  const activeMission = sketchMissionFromConversation([...userMessagesInOrder, text], {
    existingAgents: teamAgents || [],
  });
  if (activeMission) {
    activeMission.authority = CEO_REASONING_MIGRATION_STATUS.role;
    activeMission.judgmentOwner = CEO_REASONING_MIGRATION_STATUS.judgmentOwner;
  }
  logCeoReasoning(activeMission);

  const controlPlane = assessControlPlaneRequest({
    message: text,
    missionState: activeMission,
  });
  const executionState = buildExecutionState({
    intent: controlPlane.intent,
    capabilityAssessment: controlPlane.capabilityAssessment,
    agentDefinition: controlPlane.plannedAgent,
  });

  // Trusted application world model (DB-backed summaries only).
  const applicationState = await buildApplicationWorldModel(userId);

  const capabilities = listCapabilities();
  const availableCaps = capabilities.filter((c) => c.status === "available").map((c) => c.id);
  const unavailableCaps = capabilities.filter((c) => c.status === "unavailable").map((c) => c.id);

  const worldModel = {
    identity: identities,
    capabilities: {
      registry: capabilities,
      available: availableCaps,
      unavailable: unavailableCaps,
      enabledTools: [...CEO_ENABLED_TOOLS],
    },
    application: applicationState,
    memory: {
      relevant: ownedMemories,
      activeMission,
      // Previous decisions / unresolved questions: transitional from sketch only.
      previousDecisions: activeMission?.decision ? [activeMission.decision] : [],
      unresolvedQuestions: activeMission?.selectedQuestion
        ? [activeMission.selectedQuestion]
        : activeMission?.missing || [],
    },
    operations: {
      agentRoster: teamAgents,
      recentRuns: runs,
      executionState,
      controlPlane,
    },
  };

  const promptSections = buildCeoPromptSections({
    identities,
    activeMission,
    ownedMemories,
    controlPlane,
    executionState,
    applicationState,
    teamAgents,
    runs,
    tzLabel,
    currentDigest,
    documents,
    relatedRun,
    history,
    text,
  });

  logCeoContextAssembly({
    conversationId: gathered.conversationId,
    contextSections: extractSectionLabels(promptSections),
    capabilitiesAvailable: availableCaps,
    capabilitiesUnavailable: unavailableCaps,
    toolsEnabled: [...CEO_ENABLED_TOOLS],
    worldModelMeta: {
      lightFinancialStatus: applicationState.financial?.lightHealth?.status || null,
      aggregatesStatus: applicationState.financial?.aggregates?.status || null,
      aggregatesCacheHit: applicationState.financial?.aggregates?.cache?.hit === true,
      workspaceStatus: applicationState.workspace?.status || null,
      hasSnapshot: applicationState.workspace?.hasSnapshot === true,
      plaidItemCount: applicationState.connectedServices?.plaid?.itemCount ?? null,
      unavailableDomains: [
        "budgetStatusVsActual",
        "trueCash",
        "forecast",
        "operationsBoard",
      ],
    },
    activeMissionKind: activeMission?.missionKind || null,
    missionExecutable: activeMission?.missionExecutable === true,
    memoryCount: ownedMemories.length,
  });

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
    controlPlane,
    executionState,
    worldModel,
    applicationState,
  };
}

/** @deprecated Prefer assembleCeoContext — kept as the stable Brain entry name. */
export async function assembleBrainContext(args) {
  return assembleCeoContext(args);
}

function buildCeoPromptSections({
  identities,
  activeMission,
  ownedMemories,
  controlPlane,
  executionState,
  applicationState,
  teamAgents,
  runs,
  tzLabel,
  currentDigest,
  documents,
  relatedRun,
  history,
  text,
}) {
  const sections = [
    "Reply to the user's new message using the structured context below.",
    "APPLICATION STATE and PLATFORM CAPABILITIES are authoritative. The ACTIVE MISSION sketch is transitional continuity support only — it must not override world-model truth or invent capabilities.",
    ...renderIdentitySituationBrief({
      identities,
      activeMission: activeMission
        ? {
            ...activeMission,
            mission: activeMission.mission,
            missionKind: activeMission.missionKind,
            // Surface authority so the model does not treat the sketch as law.
            known: [
              ...(activeMission.known || []),
              `Mission sketch authority: ${activeMission.authority || "transitional_sketch"}`,
            ],
            missing: activeMission.missing,
            missionExecutable: activeMission.missionExecutable,
          }
        : null,
      relevantMemories: ownedMemories,
    }),
    dataSection(
      "PERMISSIONS (constitution)",
      [
        "financial: READ_ONLY",
        "can_move_money: no",
        "can_trade: no",
        "agent_default_permission_level: READ_ONLY",
      ].join("\n")
    ),
    dataSection(
      "PLATFORM CAPABILITIES (authoritative registry)",
      renderCapabilityRegistry(listCapabilities())
    ),
    dataSection(
      "ENABLED TOOLS (callable this turn)",
      CEO_ENABLED_TOOLS.map((name) => `- ${name}`).join("\n")
    ),
    ...renderCapabilitySituationBrief({
      controlPlane,
      executionState,
      includeRegistry: false,
    }),
    dataSection(
      "APPLICATION STATE (Freedom Financial world model)",
      renderApplicationState(applicationState)
    ),
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

  return sections;
}

export function renderApplicationState(applicationState = {}) {
  const financial = applicationState.financial || {};
  const workspace = applicationState.workspace || {};
  const connected = applicationState.connectedServices || {};

  const payload = {
    financial: {
      lightHealth: financial.lightHealth || { status: "unavailable_server_summary" },
      aggregates: financial.aggregates || { status: "unavailable_server_summary" },
      budgetStatusVsActual: financial.budgetStatusVsActual || {
        status: "unavailable_server_summary",
      },
      trueCash: financial.trueCash || { status: "unavailable_server_summary" },
      forecast: financial.forecast || { status: "unavailable_server_summary" },
      operationsBoard: financial.operationsBoard || { status: "unavailable_server_summary" },
    },
    workspace,
    connectedServices: connected,
  };

  return JSON.stringify(payload, null, 2);
}

function extractSectionLabels(sections) {
  const labels = [];
  for (const section of sections || []) {
    const match = String(section).match(/=== BEGIN (.+?) ===/);
    if (match) labels.push(match[1]);
  }
  return labels;
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
      if (isCreationStateContent(content)) return null;
      return `${message.role === "USER" ? "User" : "Assistant"}: ${content}`;
    })
    .filter(Boolean);
  return lines.length ? lines.join("\n") : "(no previous messages)";
}

async function gatherConversationAndWorkspaceRows({
  userId,
  ceoAgentConfigId,
  conversationId,
  text,
  relatedRunId,
}) {
  return withUserContext(userId, async (tx) => {
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
}

function isMissingUserIdentityColumnError(error) {
  const message = String(error?.message || "");
  return (
    error?.code === "P2022" &&
    (/displayName/i.test(message) || /email/i.test(message) || /User/i.test(message))
  );
}
