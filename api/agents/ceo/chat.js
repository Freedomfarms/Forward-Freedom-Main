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
import {
  listChatHistory,
  serializeChatHistoryMessages,
} from "../../../server/agents/chatHistory.js";
import {
  advanceCreationSession,
  buildCreationSuccessReply,
  completeCreationSession,
  decodeCreationState,
  encodeCreationState,
  startCreationSession,
} from "../../../server/agents/creationFlow.js";
import {
  ensureDefaultConversation,
  touchConversation,
} from "../../../server/agents/conversations.js";

// GET  /api/agents/ceo/chat — visible message history for the CEO thread
// POST /api/agents/ceo/chat — send a message (or drive "+ New Agent" creation).
// Sending { mode: "create_agent" } starts a deterministic multi-turn creation
// session (state hidden in the encrypted chat thread — see creationFlow.js).
// While a session is active every message is routed to it (no LLM call); the
// stepper extracts fields opportunistically so answers need not follow the
// question order. Everything else goes through respondToChat.

const CREATION_STATE_LOOKBACK = 60;

async function findActiveCreationState(tx, userId, ceoAgentConfigId) {
  const recent = await tx.agentChatMessage.findMany({
    where: { userId, ceoAgentConfigId, agentConfigId: null, role: "AGENT" },
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

async function handleCreationTurn({ userId, ceoConfigId, activeState, message }) {
  return withUserContext(userId, async (tx) => {
    // Phase 1: creation turns stay on the default CEO thread. Phase 3 will
    // pin this flow to an isSystem conversation instead.
    const conversation = await ensureDefaultConversation(tx, {
      userId,
      ceoAgentConfigId: ceoConfigId,
    });
    const messageBase = {
      userId,
      conversationId: conversation.id,
      ceoAgentConfigId: ceoConfigId,
      agentConfigId: null,
    };
    await tx.agentChatMessage.create({
      data: { ...messageBase, role: "USER", contentCiphertext: encrypt(message) },
    });
    await touchConversation(tx, conversation.id);

    let turn;
    if (activeState) {
      turn = advanceCreationSession(activeState, message);
    } else {
      turn = startCreationSession();
      // If the opening message already names a type ("I want a finance
      // agent"), skip straight past the type question.
      const attempt = advanceCreationSession(turn.state, message);
      if (attempt.state?.draft?.agentType || attempt.state?.status !== "active") {
        turn = attempt;
      }
    }

    let { state, reply } = turn;
    let agentCreated = null;
    if (turn.createPayload) {
      // Same validation + creation path as POST /api/agents — the READ_ONLY /
      // ACTIVE pin is enforced inside createAgentConfig.
      const validated = validateAgentCreatePayload(turn.createPayload);
      const agent = await createAgentConfig(tx, userId, validated);
      state = completeCreationSession(state, agent);
      reply = buildCreationSuccessReply(agent);
      agentCreated = { id: agent.id, name: agent.name, agentType: agent.agentType };
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
    await touchConversation(tx, conversation.id);

    return { reply, messageId: replyMessage.id, agentCreated };
  });
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
    const message = typeof payload?.message === "string" ? payload.message.trim() : "";
    if (!message) {
      throw new AgentError("A non-empty message is required.", "INVALID_AGENT_PAYLOAD", 400);
    }
    const relatedRunId =
      typeof payload?.relatedRunId === "string" && payload.relatedRunId.trim()
        ? payload.relatedRunId.trim()
        : null;
    const createMode = payload?.mode === "create_agent";

    const { ceoConfig, activeState } = await withUserContext(decodedToken.uid, async (tx) => {
      const config = await ensureCeoAgentConfig(tx, decodedToken.uid);
      return {
        ceoConfig: config,
        activeState: await findActiveCreationState(tx, decodedToken.uid, config.id),
      };
    });

    if (createMode || activeState) {
      const outcome = await handleCreationTurn({
        userId: decodedToken.uid,
        ceoConfigId: ceoConfig.id,
        activeState,
        message,
      });
      return response.status(200).json({
        reply: outcome.reply,
        messageId: outcome.messageId,
        ...(outcome.agentCreated ? { agentCreated: outcome.agentCreated } : {}),
      });
    }

    const { reply, messageId } = await respondToChat({
      userId: decodedToken.uid,
      ceoAgentConfigId: ceoConfig.id,
      message,
      relatedRunId,
    });
    return response.status(200).json({ reply, messageId });
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
  return response.status(405).json({ error: true, message: "Method not allowed." });
}
