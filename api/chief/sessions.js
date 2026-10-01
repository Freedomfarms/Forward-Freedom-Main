// GET /api/chief/sessions — caller-scoped interactive conversation discovery.
//
// BUILD NEW thin shell. The checkpoint store is the only session record.
// This route does not start a turn, read a transcript, or create a session.
// A new conversation is still POST /api/chief/chat without session_id.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { PrismaCheckpointStore } from "../../server/chief/runtime/checkpoint.js";
import { projectInteractiveSessions } from "../../server/chief/runtime/sessions.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";

export async function handleChiefSessions(request, response, deps = {}) {
  applySecurityHeaders(response);
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;
  if (request.method !== "GET") {
    response.status(405).json({ error: "GET required" });
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
  const archivedOnly = request.query?.archived === "1" || request.query?.archived === "true";
  const sessions = projectInteractiveSessions(await store.listOwnedSessions(userId), {
    archivedOnly,
  });
  response.status(200).json({ sessions });
}

export default function handler(request, response) {
  return handleChiefSessions(request, response);
}
