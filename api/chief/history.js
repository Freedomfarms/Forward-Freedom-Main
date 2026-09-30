// GET /api/chief/history?session_id= — one owned interactive transcript.
//
// BUILD NEW thin shell. The checkpoint store is the only transcript source.
// This route does not start a turn, a tick, or a tool.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { projectInteractiveHistory } from "../../server/chief/runtime/history.js";
import { PrismaCheckpointStore } from "../../server/chief/runtime/checkpoint.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";

function sessionIdOf(request) {
  const value = request.query?.session_id ?? request.query?.sessionId;
  return typeof value === "string" ? value.trim() : "";
}

export async function handleChiefHistory(request, response, deps = {}) {
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

  const sessionId = sessionIdOf(request);
  if (!sessionId) {
    response.status(400).json({ error: "session_id is required" });
    return;
  }

  const store = deps.store ?? new PrismaCheckpointStore();
  const record = await store.load(userId, sessionId);
  const history = projectInteractiveHistory(record);
  if (history.error) {
    response.status(404).json({ error: "session not found" });
    return;
  }
  response.status(200).json({ sessionId: history.sessionId, messages: history.messages });
}

export default function handler(request, response) {
  return handleChiefHistory(request, response);
}
