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
import { brainTurn } from "../../../server/brain/index.js";
import { assertSafeActivityEvent } from "../../../server/brain/activityStream.js";
import {
  listChatHistory,
  serializeChatHistoryMessages,
} from "../../../server/agents/chatHistory.js";

// GET  /api/agents/ceo/chat — visible message history for the active CEO thread
// POST /api/agents/ceo/chat — ONE CEO brain path (world model + tools).
//      Optional body.stream=true → SSE activity events, then a final result.
//      Activity labels are backend-controlled (never LLM / chain-of-thought).

function readOptionalConversationId(payloadOrQuery) {
  const raw = payloadOrQuery?.conversationId;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function serializeCeoOutcome(outcome) {
  return {
    reply: outcome.reply,
    messageId: outcome.messageId,
    conversationId: outcome.conversationId,
    conversationTitle: outcome.conversationTitle,
    activities: Array.isArray(outcome.activities)
      ? outcome.activities.filter(assertSafeActivityEvent)
      : [],
    ...(outcome.digest ? { digest: outcome.digest } : {}),
    ...(outcome.agent ? { agent: outcome.agent } : {}),
    ...(outcome.run ? { run: outcome.run } : {}),
  };
}

function writeSse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
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
    const stream = payload?.stream === true;

    const ceoConfig = await withUserContext(decodedToken.uid, (tx) =>
      ensureCeoAgentConfig(tx, decodedToken.uid)
    );

    if (stream) {
      applySecurityHeaders(response);
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("Connection", "keep-alive");
      if (typeof response.flushHeaders === "function") response.flushHeaders();

      const outcome = await brainTurn({
        userId: decodedToken.uid,
        ceoAgentConfigId: ceoConfig.id,
        conversationId,
        message,
        relatedRunId,
        onActivity: (event) => {
          if (!assertSafeActivityEvent(event)) return;
          writeSse(response, { type: "activity", activity: event });
        },
      });
      writeSse(response, { type: "done", result: serializeCeoOutcome(outcome) });
      response.end();
      return undefined;
    }

    const outcome = await brainTurn({
      userId: decodedToken.uid,
      ceoAgentConfigId: ceoConfig.id,
      conversationId,
      message,
      relatedRunId,
    });
    return response.status(200).json(serializeCeoOutcome(outcome));
  } catch (error) {
    if (!response.headersSent) {
      return respondAgentApiError(
        response,
        "api/agents/ceo/chat",
        error,
        "Unable to process the CEO Agent chat message."
      );
    }
    try {
      writeSse(response, {
        type: "error",
        message: error?.message || "Unable to process the CEO Agent chat message.",
      });
      response.end();
    } catch {
      // ignore
    }
    return undefined;
  }
}

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (request.method === "GET") return handleHistory(request, response);
  if (request.method === "POST") return handleSend(request, response);
  response.setHeader("Allow", "GET, POST");
  return response.status(405).json({ error: true, message: "Method not allowed." });
}
