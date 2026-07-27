import { authenticateRequest } from "../../../server/auth/verifyAuth.js";
import { withUserContext } from "../../../server/db/prisma.js";
import {
  agentLlmRateLimit,
  enforceRateLimit,
  generalApiRateLimit,
} from "../../../server/http/rateLimit.js";
import { readJsonBody } from "../../../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../../../server/http/responseHelpers.js";
import { AgentError } from "../../../server/agents/errors.js";
import {
  ensureCeoAgentConfig,
  respondAgentApiError,
} from "../../../server/agents/apiHelpers.js";
import { respondToChat } from "../../../server/agents/chat.js";
import { brainTurn, isBrainChatEnabled } from "../../../server/brain/index.js";
import {
  listChatHistory,
  serializeChatHistoryMessages,
} from "../../../server/agents/chatHistory.js";

// GET  /api/agents/ceo/chat — visible message history for the active CEO thread
//      (?conversationId= optional; defaults to newest non-system conversation)
// POST /api/agents/ceo/chat — ONE CEO brain for information, execution, create,
//      update, and workflows. There is no separate "+ New Agent" interview mode;
//      legacy { mode: "create_agent" } is ignored and handled as normal CEO chat.

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
    const message = typeof payload?.message === "string" ? payload.message.trim() : "";
    if (!message) {
      throw new AgentError("A non-empty message is required.", "INVALID_AGENT_PAYLOAD", 400);
    }
    const relatedRunId =
      typeof payload?.relatedRunId === "string" && payload.relatedRunId.trim()
        ? payload.relatedRunId.trim()
        : null;
    const conversationId = readOptionalConversationId(payload);

    const ceoConfig = await withUserContext(decodedToken.uid, (tx) =>
      ensureCeoAgentConfig(tx, decodedToken.uid)
    );

    // One CEO brain. Legacy clients may still send mode: "create_agent" — ignore
    // it and use the same engine as every other CEO message.
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
      ...(outcome.agent ? { agent: outcome.agent } : {}),
      ...(outcome.run ? { run: outcome.run } : {}),
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
