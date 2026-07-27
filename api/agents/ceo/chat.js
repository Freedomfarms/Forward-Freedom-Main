import { authenticateRequest } from "../../../server/auth/verifyAuth.js";
import { withUserContext } from "../../../server/db/prisma.js";
import { decrypt, encrypt } from "../../../server/security/envelope.js";
import {
  agentLlmRateLimit,
  enforceRateLimit,
  generalApiRateLimit,
} from "../../../server/http/rateLimit.js";
import { readJsonBody } from "../../../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../../../server/http/responseHelpers.js";
import { AgentError } from "../../../server/agents/errors.js";
import {
  createAgentConfig,
  ensureCeoAgentConfig,
  respondAgentApiError,
  validateAgentCreatePayload,
} from "../../../server/agents/apiHelpers.js";
import { respondToChat } from "../../../server/agents/chat.js";
import { brainTurn, isBrainChatEnabled } from "../../../server/brain/index.js";
import {
  listChatHistory,
  serializeChatHistoryMessages,
} from "../../../server/agents/chatHistory.js";
import {
  buildCreationSuccessReply,
  completeCreationSession,
  decodeCreationState,
  encodeCreationState,
  isCreationStateContent,
  publicCreationDraft,
  runCreationTurn,
  startCreationSession,
} from "../../../server/agents/creationFlow.js";
import {
  ensureSystemConversation,
  touchConversation,
} from "../../../server/agents/conversations.js";
import { announceAgentCreatedToCeoChat } from "../../../server/agents/teamContext.js";

// GET  /api/agents/ceo/chat — visible message history for the active CEO thread
//      (?conversationId= optional; defaults to newest non-system conversation)
// POST /api/agents/ceo/chat — send a message (or drive "+ New Agent" creation).
// Sending { mode: "create_agent" } starts/continues the conversational creation
// interview (LLM) on an isSystem conversation. Everything else → respondToChat.
//
// Product rule: the "+ New Agent" UI does not load creation history. If the
// user leaves without creating, the unfinished draft is deleted (not kept for
// resume). Clients call ({ mode: "create_agent", discard: true }) on close;
// startFresh on the first Aim answer is a safety net.

const CREATION_STATE_LOOKBACK = 60;
const CREATION_TRANSCRIPT_LOOKBACK = 24;

async function findActiveCreationState(tx, userId, ceoAgentConfigId, conversationId) {
  const recent = await tx.agentChatMessage.findMany({
    where: {
      userId,
      ceoAgentConfigId,
      agentConfigId: null,
      conversationId,
      role: "AGENT",
    },
    orderBy: { createdAt: "desc" },
    take: CREATION_STATE_LOOKBACK,
    select: { contentCiphertext: true },
  });
  // Messages written in one turn share the same createdAt (Postgres now() is
  // the transaction timestamp), so row order alone cannot identify the latest
  // state. Each state row carries its own marker (savedAtMs + a per-process
  // sequence, set in handleCreationTurn); the newest one wins.
  let latest = null;
  for (const row of recent) {
    let content;
    try {
      content = decrypt(row.contentCiphertext);
    } catch {
      continue;
    }
    const state = decodeCreationState(content);
    if (state && (!latest || isNewerState(state, latest))) {
      latest = state;
    }
  }
  // Only the LATEST state counts; completed/cancelled sessions are over.
  return latest?.status === "active" ? latest : null;
}

function isNewerState(a, b) {
  if ((a.savedAtMs || 0) !== (b.savedAtMs || 0)) {
    return (a.savedAtMs || 0) > (b.savedAtMs || 0);
  }
  return (a.savedAtSeq || 0) > (b.savedAtSeq || 0);
}

// Same-millisecond tiebreaker for state rows. Only meaningful within one
// process; across serverless invocations savedAtMs alone already differs.
let stateSequence = 0;

async function loadCreationTranscript(
  tx,
  { userId, ceoConfigId, conversationId, sinceMs = null }
) {
  const rows = await tx.agentChatMessage.findMany({
    where: {
      userId,
      ceoAgentConfigId: ceoConfigId,
      agentConfigId: null,
      conversationId,
    },
    orderBy: { createdAt: "desc" },
    take: CREATION_TRANSCRIPT_LOOKBACK,
    select: { role: true, contentCiphertext: true, createdAt: true },
  });
  const messages = [];
  for (const row of [...rows].reverse()) {
    if (sinceMs != null) {
      const createdAtMs = row.createdAt ? new Date(row.createdAt).getTime() : 0;
      if (createdAtMs < sinceMs) continue;
    }
    let content;
    try {
      content = decrypt(row.contentCiphertext);
    } catch {
      continue;
    }
    if (isCreationStateContent(content)) continue;
    messages.push({ role: row.role, text: content });
  }
  return messages;
}

/**
 * Delete an unfinished creation draft (state + interview turns) when the user
 * leaves "+ New Agent" without creating. No resume — the blank UI never shows
 * that history.
 *
 * Re-reads the latest active row first. Optional match* guards stop a slow
 * delete from wiping a newer session that started in the meantime.
 */
async function deleteActiveCreationDraft({
  userId,
  ceoConfigId,
  conversationId,
  matchSessionStartedAtMs = undefined,
  matchSavedAtMs = undefined,
}) {
  return withUserContext(userId, async (tx) => {
    const latest = await findActiveCreationState(
      tx,
      userId,
      ceoConfigId,
      conversationId
    );
    if (!latest) {
      return { deleted: false, deletedCount: 0 };
    }
    if (
      matchSessionStartedAtMs !== undefined &&
      latest.sessionStartedAtMs !== matchSessionStartedAtMs
    ) {
      return { deleted: false, deletedCount: 0 };
    }
    if (matchSavedAtMs !== undefined && latest.savedAtMs !== matchSavedAtMs) {
      return { deleted: false, deletedCount: 0 };
    }

    // Bound the delete so a concurrent new session (messages after now) survives.
    const deleteBefore = new Date();
    const sinceMs = latest.sessionStartedAtMs || null;
    const createdAtFilter = {
      lte: deleteBefore,
      ...(sinceMs ? { gte: new Date(sinceMs) } : {}),
    };

    const result = await tx.agentChatMessage.deleteMany({
      where: {
        userId,
        ceoAgentConfigId: ceoConfigId,
        conversationId,
        createdAt: createdAtFilter,
      },
    });
    await touchConversation(tx, conversationId);
    return {
      deleted: result.count > 0,
      deletedCount: result.count,
    };
  });
}

async function handleCreationTurn({
  userId,
  ceoConfigId,
  conversationId,
  activeState,
  message,
  startFresh = false,
}) {
  // Run the LLM interview outside the write transaction so we don't hold a
  // DB connection open across model latency.
  // "+ New Agent" UI always means a brand-new worker — abandon any leftover
  // active draft on the shared isSystem thread when the client asks to start fresh.
  if (startFresh && activeState) {
    await deleteActiveCreationDraft({
      userId,
      ceoConfigId,
      conversationId,
      matchSessionStartedAtMs: activeState.sessionStartedAtMs,
      matchSavedAtMs: activeState.savedAtMs,
    });
  }
  const sessionState = startFresh ? null : activeState;
  let recentMessages = [];
  if (sessionState) {
    recentMessages = await withUserContext(userId, (tx) =>
      loadCreationTranscript(tx, {
        userId,
        ceoConfigId,
        conversationId,
        sinceMs: sessionState.sessionStartedAtMs || null,
      })
    );
  }

  let turn;
  if (sessionState) {
    turn = await runCreationTurn(sessionState, message, { recentMessages });
  } else {
    const started = startCreationSession();
    // Opening user message answers Aim — don't bounce the canned opener back.
    turn = await runCreationTurn(started.state, message, { recentMessages: [] });
  }

  return withUserContext(userId, async (tx) => {
    const messageBase = {
      userId,
      conversationId,
      ceoAgentConfigId: ceoConfigId,
      agentConfigId: null,
    };
    await tx.agentChatMessage.create({
      data: { ...messageBase, role: "USER", contentCiphertext: encrypt(message) },
    });
    await touchConversation(tx, conversationId);

    let { state, reply } = turn;
    let agentCreated = null;
    if (turn.createPayload) {
      // Same validation + creation path as POST /api/agents — the READ_ONLY /
      // ACTIVE pin is enforced inside createAgentConfig.
      const validated = validateAgentCreatePayload(turn.createPayload);
      const agent = await createAgentConfig(tx, userId, validated);
      state = completeCreationSession(state, agent);
      reply = buildCreationSuccessReply(agent);
      agentCreated = {
        id: agent.id,
        name: agent.name,
        agentType: agent.agentType,
        model: agent.model,
      };
      // Creation lives on a hidden isSystem thread — also pin a short note into
      // the main CEO conversation so Harry can see the new teammate next turn.
      await announceAgentCreatedToCeoChat(tx, {
        userId,
        ceoAgentConfigId: ceoConfigId,
        agent,
      });
    }

    // savedAtMs/savedAtSeq disambiguate state rows across turns (see
    // findActiveCreationState); a fresh state always supersedes older ones.
    stateSequence += 1;
    await tx.agentChatMessage.create({
      data: {
        ...messageBase,
        role: "AGENT",
        contentCiphertext: encrypt(
          encodeCreationState({ ...state, savedAtMs: Date.now(), savedAtSeq: stateSequence })
        ),
      },
    });
    const replyMessage = await tx.agentChatMessage.create({
      data: { ...messageBase, role: "AGENT", contentCiphertext: encrypt(reply) },
    });
    await touchConversation(tx, conversationId);

    return {
      reply,
      messageId: replyMessage.id,
      agentCreated,
      creationDraft: turn.creationDraft || publicCreationDraft(state),
    };
  });
}

function readOptionalConversationId(payloadOrQuery) {
  const raw = payloadOrQuery?.conversationId;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

async function handleHistory(request, response) {
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;
  try {
    const decodedToken = await authenticateRequest(request);
    const ceoConfig = await withUserContext(decodedToken.uid, (tx) =>
      ensureCeoAgentConfig(tx, decodedToken.uid)
    );
    const messages = await listChatHistory({
      userId: decodedToken.uid,
      ceoAgentConfigId: ceoConfig.id,
      conversationId: readOptionalConversationId(request.query),
    });
    return response.status(200).json({ messages: serializeChatHistoryMessages(messages) });
  } catch (error) {
    return respondAgentApiError(
      response,
      "api/agents/ceo/chat",
      error,
      "Unable to load the CEO Agent chat history."
    );
  }
}

async function handleSend(request, response) {
  if (!(await enforceRateLimit(request, response, agentLlmRateLimit))) return;

  try {
    const decodedToken = await authenticateRequest(request);
    const payload = await readJsonBody(request);
    const createMode = payload?.mode === "create_agent";
    // Leaving "+ New Agent" without creating deletes the unfinished draft.
    const discard = createMode && payload?.discard === true;
    const message = typeof payload?.message === "string" ? payload.message.trim() : "";
    if (!message && !discard) {
      throw new AgentError("A non-empty message is required.", "INVALID_AGENT_PAYLOAD", 400);
    }
    const relatedRunId =
      typeof payload?.relatedRunId === "string" && payload.relatedRunId.trim()
        ? payload.relatedRunId.trim()
        : null;
    // First turn after opening "+ New Agent" — discard any unfinished draft on
    // the shared creation thread so Harry doesn't treat a new Aim answer as a
    // pivot away from a prior (e.g. Coinbase/finance) interview.
    const startFresh = createMode && payload?.startFresh === true;
    const conversationId = readOptionalConversationId(payload);

    const ceoConfig = await withUserContext(decodedToken.uid, (tx) =>
      ensureCeoAgentConfig(tx, decodedToken.uid)
    );

    // Creation is opt-in via mode: "create_agent" on every turn (client keeps
    // sending it while NewAgentFlow is open). Abandoned system sessions never
    // hijack the regular CEO chat.
    if (createMode) {
      const systemConversationId = await withUserContext(decodedToken.uid, async (tx) => {
        const system = await ensureSystemConversation(tx, {
          userId: decodedToken.uid,
          ceoAgentConfigId: ceoConfig.id,
        });
        return system.id;
      });

      if (discard) {
        const outcome = await deleteActiveCreationDraft({
          userId: decodedToken.uid,
          ceoConfigId: ceoConfig.id,
          conversationId: systemConversationId,
        });
        return response.status(200).json({
          deleted: outcome.deleted,
          deletedCount: outcome.deletedCount,
        });
      }

      const activeState = await withUserContext(decodedToken.uid, (tx) =>
        findActiveCreationState(
          tx,
          decodedToken.uid,
          ceoConfig.id,
          systemConversationId
        )
      );

      const outcome = await handleCreationTurn({
        userId: decodedToken.uid,
        ceoConfigId: ceoConfig.id,
        conversationId: systemConversationId,
        activeState,
        message,
        startFresh,
      });
      return response.status(200).json({
        reply: outcome.reply,
        messageId: outcome.messageId,
        creationDraft: outcome.creationDraft,
        ...(outcome.agentCreated ? { agentCreated: outcome.agentCreated } : {}),
      });
    }

    // Vertical slice (docs/FREEDOM_BRAIN_PLAN.md §0.6): FREEDOM_BRAIN_CHAT
    // routes CEO chat through the Freedom Brain reasoning loop (plain-text
    // reply + tool calling + async memory extraction). Same response shape;
    // legacy respondToChat remains the default for production comparison.
    const chatEngine = isBrainChatEnabled() ? brainTurn : respondToChat;
    const outcome = await chatEngine({
      userId: decodedToken.uid,
      ceoAgentConfigId: ceoConfig.id,
      conversationId,
      message,
      relatedRunId,
    });
    return response.status(200).json({
      reply: outcome.reply,
      messageId: outcome.messageId,
      conversationId: outcome.conversationId,
      conversationTitle: outcome.conversationTitle,
      ...(outcome.digest ? { digest: outcome.digest } : {}),
    });
  } catch (error) {
    return respondAgentApiError(
      response,
      "api/agents/ceo/chat",
      error,
      "Unable to process the CEO Agent chat message."
    );
  }
}

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (request.method === "GET") return handleHistory(request, response);
  if (request.method === "POST") return handleSend(request, response);
  response.setHeader("Allow", "GET, POST");
  return response.status(405).json({ error: true, message: "Method not allowed." });
}
