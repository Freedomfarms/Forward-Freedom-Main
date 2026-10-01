// Signed-in user actions on one owned CHIEF conversation.
// Ownership is the checkpoint store. These routes are the user, not CHIEF.
// Delete requires confirm: true. Scheduled sessions are not conversations.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { PrismaCheckpointStore } from "../../server/chief/runtime/checkpoint.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";
import { readJsonBody } from "../../server/http/requestHelpers.js";

function sessionIdOf(body) {
  return typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
}

function sendResult(response, result) {
  if (result?.error === "not_found") {
    response.status(404).json({ error: "session not found" });
    return;
  }
  if (result?.error === "pending_approval") {
    response.status(409).json({ error: "This conversation is waiting for approval and cannot be archived." });
    return;
  }
  if (result?.error === "not_archived") {
    response.status(409).json({ error: "That conversation is not archived." });
    return;
  }
  if (result?.error === "invalid_title") {
    response.status(400).json({ error: "A conversation title must be 1 to 120 characters." });
    return;
  }
  if (!result?.ok) {
    response.status(400).json({ error: "conversation update failed" });
    return;
  }
  response.status(200).json({
    sessionId: result.sessionId,
    ...(result.title != null ? { title: result.title } : {}),
    ...(result.status ? { status: result.status } : {}),
    ...(result.deleted ? { deleted: true } : {}),
  });
}

export async function handleChiefConversation(request, response, deps = {}) {
  applySecurityHeaders(response);
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;
  if (!["PATCH", "POST", "DELETE"].includes(request.method)) {
    response.status(405).json({ error: "PATCH, POST, or DELETE required" });
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
  const body = await readJsonBody(request);
  const sessionId = sessionIdOf(body);
  if (!sessionId) {
    response.status(400).json({ error: "sessionId is required" });
    return;
  }

  if (request.method === "DELETE" && body.confirm !== true) {
    response.status(400).json({ error: "Delete requires confirm: true" });
    return;
  }

  try {
    if (request.method === "PATCH") {
      sendResult(response, await store.renameSession(userId, sessionId, body.title));
      return;
    }
    if (request.method === "DELETE") {
      sendResult(response, await store.deleteSession(userId, sessionId));
      return;
    }
    if (body.action === "archive") {
      sendResult(response, await store.archiveSession(userId, sessionId));
      return;
    }
    if (body.action === "restore") {
      sendResult(response, await store.restoreSession(userId, sessionId));
      return;
    }
    response.status(400).json({ error: "action must be archive or restore" });
  } catch (error) {
    response.status(error.status || 500).json({ error: "conversation update failed" });
  }
}

export default function handler(request, response) {
  return handleChiefConversation(request, response);
}
