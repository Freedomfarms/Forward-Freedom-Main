import { authenticateRequest } from "../auth/verifyAuth.js";
import { withUserContext } from "../db/prisma.js";
import { enforceRateLimit, generalApiRateLimit } from "../http/rateLimit.js";
import { readJsonBody, readPathParam } from "../http/requestHelpers.js";
import { applySecurityHeaders } from "../http/responseHelpers.js";
import { respondAgentApiError } from "./apiHelpers.js";
import { AgentError } from "./errors.js";
import {
  assertConversationMatchesTarget,
  createConversation,
  deleteConversation,
  listConversationMessages,
  listConversations,
  updateConversation,
} from "./conversations.js";

/**
 * Shared HTTP helpers for nested conversation routes under
 * /api/agents/ceo/conversations and /api/agents/:id/conversations.
 *
 * resolveTarget(request, userId) → { agentConfigId?, ceoAgentConfigId? }
 */

export async function handleConversationCollection(request, response, { resolveTarget, logLabel }) {
  applySecurityHeaders(response);
  if (!["GET", "POST"].includes(request.method || "")) {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  try {
    const decodedToken = await authenticateRequest(request);
    const target = await resolveTarget(request, decodedToken.uid);

    if (request.method === "GET") {
      const includeArchived =
        String(request.query?.includeArchived || "").toLowerCase() === "true";
      const result = await listConversations({
        userId: decodedToken.uid,
        ...target,
        limit: request.query?.limit,
        before: request.query?.before,
        includeArchived,
      });
      return response.status(200).json(result);
    }

    const payload = await readJsonBody(request);
    const title = typeof payload?.title === "string" ? payload.title : null;
    const conversation = await createConversation({
      userId: decodedToken.uid,
      ...target,
      title,
    });
    return response.status(201).json({ conversation });
  } catch (error) {
    return respondAgentApiError(
      response,
      logLabel,
      error,
      request.method === "GET"
        ? "Unable to list conversations."
        : "Unable to create a conversation."
    );
  }
}

export async function handleConversationItem(request, response, { resolveTarget, logLabel }) {
  applySecurityHeaders(response);
  if (!["PATCH", "DELETE"].includes(request.method || "")) {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  try {
    const decodedToken = await authenticateRequest(request);
    const conversationId = readPathParam(request, "conversationId");
    if (!conversationId) {
      throw new AgentError("A conversation id is required.", "INVALID_AGENT_PAYLOAD", 400);
    }
    const target = await resolveTarget(request, decodedToken.uid);

    await withUserContext(decodedToken.uid, (tx) =>
      assertConversationMatchesTarget(tx, {
        userId: decodedToken.uid,
        conversationId,
        ...target,
      })
    );

    if (request.method === "DELETE") {
      const result = await deleteConversation({
        userId: decodedToken.uid,
        conversationId,
      });
      return response.status(200).json(result);
    }

    const payload = await readJsonBody(request);
    const patch = { userId: decodedToken.uid, conversationId };
    if (Object.prototype.hasOwnProperty.call(payload || {}, "title")) {
      patch.title = payload.title;
    }
    if (Object.prototype.hasOwnProperty.call(payload || {}, "archived")) {
      patch.archived = payload.archived;
    }
    const conversation = await updateConversation(patch);
    return response.status(200).json({ conversation });
  } catch (error) {
    return respondAgentApiError(
      response,
      logLabel,
      error,
      request.method === "DELETE"
        ? "Unable to delete the conversation."
        : "Unable to update the conversation."
    );
  }
}

export async function handleConversationMessages(request, response, { resolveTarget, logLabel }) {
  applySecurityHeaders(response);
  if (request.method !== "GET") {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  try {
    const decodedToken = await authenticateRequest(request);
    const conversationId = readPathParam(request, "conversationId");
    if (!conversationId) {
      throw new AgentError("A conversation id is required.", "INVALID_AGENT_PAYLOAD", 400);
    }
    const target = await resolveTarget(request, decodedToken.uid);

    await withUserContext(decodedToken.uid, (tx) =>
      assertConversationMatchesTarget(tx, {
        userId: decodedToken.uid,
        conversationId,
        ...target,
      })
    );

    const result = await listConversationMessages({
      userId: decodedToken.uid,
      conversationId,
      limit: request.query?.limit,
      before: request.query?.before,
    });
    return response.status(200).json(result);
  } catch (error) {
    return respondAgentApiError(
      response,
      logLabel,
      error,
      "Unable to load conversation messages."
    );
  }
}
