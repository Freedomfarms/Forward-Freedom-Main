import { authenticateRequest } from "../../../server/auth/verifyAuth.js";
import {
  agentLlmRateLimit,
  enforceRateLimit,
  generalApiRateLimit,
} from "../../../server/http/rateLimit.js";
import { readJsonBody, readPathParam } from "../../../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../../../server/http/responseHelpers.js";
import { AgentError } from "../../../server/agents/errors.js";
import { respondAgentApiError } from "../../../server/agents/apiHelpers.js";
import { serializeAgentRun } from "../../../server/agents/apiHelpers.js";
import {
  applySubAgentTaskAction,
  matchDeterministicTaskIntent,
} from "../../../server/agents/chatActions.js";
import { respondToChat } from "../../../server/agents/chat.js";
import {
  emailRunReportFromChat,
  isEmailReportRequest,
} from "../../../server/agents/emailDelivery.js";
import {
  listChatHistory,
  serializeChatHistoryMessages,
} from "../../../server/agents/chatHistory.js";

function serializeChatOutcome(outcome) {
  return {
    reply: outcome.reply,
    messageId: outcome.messageId,
    conversationId: outcome.conversationId,
    conversationTitle: outcome.conversationTitle,
    ...(outcome.agent ? { agent: outcome.agent } : {}),
    ...(outcome.run ? { run: serializeAgentRun(outcome.run) } : {}),
  };
}

// GET  /api/agents/:id/chat — visible history (?conversationId= optional)
// POST /api/agents/:id/chat — send a message ({ conversationId? }). respondToChat
// enforces ownership and scoping. Task-scoped self-management (run now,
// schedule/instructions/pause/email toggles) and "email me the report" are
// handled deterministically when phrasing is clear; otherwise the LLM may
// emit a validated taskAction that the server applies.

function readOptionalConversationId(source) {
  const raw = source?.conversationId;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!["GET", "POST"].includes(request.method || "")) {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }

  const limiter = request.method === "GET" ? generalApiRateLimit : agentLlmRateLimit;
  if (!(await enforceRateLimit(request, response, limiter))) return;

  try {
    const decodedToken = await authenticateRequest(request);
    const agentId = readPathParam(request, "id");
    if (!agentId) {
      throw new AgentError("An agent id is required.", "INVALID_AGENT_PAYLOAD", 400);
    }
    if (agentId === "ceo") {
      throw new AgentError(
        "Use /api/agents/ceo/chat for CEO Agent chats.",
        "INVALID_CHAT_TARGET",
        400
      );
    }

    if (request.method === "GET") {
      const messages = await listChatHistory({
        userId: decodedToken.uid,
        agentConfigId: agentId,
        conversationId: readOptionalConversationId(request.query),
      });
      return response.status(200).json({ messages: serializeChatHistoryMessages(messages) });
    }

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

    // "Email me the report/draft" → deterministic email of the (related or
    // latest) run to the user's own verified address, no LLM call.
    if (isEmailReportRequest(message)) {
      const outcome = await emailRunReportFromChat({
        userId: decodedToken.uid,
        agentConfigId: agentId,
        conversationId,
        message,
        relatedRunId,
      });
      return response.status(200).json(serializeChatOutcome(outcome));
    }

    // Clear self-management asks (run now, pause/resume, schedule, email
    // toggle) apply immediately — no LLM, no CEO handoff.
    const deterministicAction = matchDeterministicTaskIntent(message);
    if (deterministicAction) {
      const outcome = await applySubAgentTaskAction({
        userId: decodedToken.uid,
        agentConfigId: agentId,
        conversationId,
        message,
        action: deterministicAction,
        relatedRunId,
        persist: true,
      });
      return response.status(200).json(serializeChatOutcome(outcome));
    }

    const outcome = await respondToChat({
      userId: decodedToken.uid,
      agentConfigId: agentId,
      conversationId,
      message,
      relatedRunId,
    });
    return response.status(200).json(serializeChatOutcome(outcome));
  } catch (error) {
    return respondAgentApiError(
      response,
      "api/agents/[id]/chat",
      error,
      request.method === "GET"
        ? "Unable to load the agent chat history."
        : "Unable to process the agent chat message."
    );
  }
}
