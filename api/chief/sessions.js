// /api/chief/sessions — caller-scoped conversation management.
//
// BUILD NEW thin shell. ChiefSession remains the only conversation record.
// GET lists interactive sessions. PATCH renames or archives. DELETE removes
// one owned session after confirm: true. A new conversation is still
// POST /api/chief/chat without session_id. Ownership is the authenticated
// user. A user id in the body is ignored.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { PrismaCheckpointStore } from "../../server/chief/runtime/checkpoint.js";
import { validateUserTitle } from "../../server/chief/runtime/conversationTitle.js";
import { projectInteractiveSessions } from "../../server/chief/runtime/sessions.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";

const NOT_FOUND = { error: "session not found" };

function sessionIdFrom(body) {
  return typeof body?.session_id === "string" ? body.session_id.trim() : "";
}

function archivedQuery(request) {
  const value = request.query?.archived;
  return value === "1" || value === "true";
}

function projectOne(record) {
  if (!record) return null;
  const [session] = projectInteractiveSessions(
    [
      {
        id: record.id,
        title: record.title ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        archivedAt: record.archivedAt ?? null,
        context: record.checkpoint?.context ?? record.contextJson ?? {},
      },
    ],
    { archived: Boolean(record.archivedAt) }
  );
  return session ?? null;
}

export async function handleChiefSessions(request, response, deps = {}) {
  applySecurityHeaders(response);
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  const method = request.method;
  if (method !== "GET" && method !== "PATCH" && method !== "DELETE") {
    response.status(405).json({ error: "GET, PATCH, or DELETE required" });
    return;
  }

  const authenticate = deps.authenticate ?? authenticateRequest;
  let userId;
  try {
    userId = (await authenticate(request)).uid;
  } catch (error) {
    response.status(error.status || 401).json({ error: error.message || "Unauthorized" });
    return;
  }

  const store = deps.store ?? new PrismaCheckpointStore();
  if (method === "GET") {
    const sessions = projectInteractiveSessions(await store.listOwnedSessions(userId), {
      archived: archivedQuery(request),
    });
    response.status(200).json({ sessions });
    return;
  }

  const body = request.body ?? {};
  const sessionId = sessionIdFrom(body);
  if (!sessionId) {
    response.status(400).json({ error: "session_id is required" });
    return;
  }

  if (method === "DELETE") {
    if (body.confirm !== true) {
      response.status(400).json({ error: "confirm must be true to delete a conversation" });
      return;
    }
    const deleted = await store.deleteOwnedSession(userId, sessionId);
    if (!deleted) {
      response.status(404).json(NOT_FOUND);
      return;
    }
    response.status(200).json({ deleted: true, sessionId });
    return;
  }

  const hasTitle = Object.hasOwn(body, "title");
  const hasArchived = Object.hasOwn(body, "archived");
  if (!hasTitle && !hasArchived) {
    response.status(400).json({ error: "title or archived is required" });
    return;
  }
  if (hasArchived && typeof body.archived !== "boolean") {
    response.status(400).json({ error: "archived must be a boolean" });
    return;
  }

  let title;
  if (hasTitle) {
    const validated = validateUserTitle(body.title);
    if (validated.error) {
      response.status(400).json({ error: validated.error });
      return;
    }
    title = validated.title;
  }

  let record = null;
  if (hasTitle) {
    record = await store.renameSession(userId, sessionId, title);
    if (!record) {
      response.status(404).json(NOT_FOUND);
      return;
    }
  }
  if (hasArchived) {
    record = await store.setArchived(userId, sessionId, body.archived);
    if (!record) {
      response.status(404).json(NOT_FOUND);
      return;
    }
  }

  const session = projectOne(record);
  if (!session) {
    response.status(404).json(NOT_FOUND);
    return;
  }
  response.status(200).json({ session });
}

export default function handler(request, response) {
  return handleChiefSessions(request, response);
}
