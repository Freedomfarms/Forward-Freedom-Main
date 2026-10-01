// GET /api/chief/session-search?q= — owner-scoped conversation navigation search.
//
// Reuses ChiefSession lexical search (recallDocument). This is not a second
// transcript store and not the model tool. The browser never supplies the
// user id. Scheduled sessions stay out of the result.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { PrismaCheckpointStore } from "../../server/chief/runtime/checkpoint.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";

const QUERY_MAX = 200;

function searchQuery(request) {
  const value = request.query?.q;
  if (typeof value !== "string") return "";
  return value.trim().slice(0, QUERY_MAX);
}

function publicConversation(row) {
  return {
    sessionId: row.sessionId,
    title: typeof row.title === "string" && row.title.trim() ? row.title.trim() : null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    archived: Boolean(row.archived),
    snippet: typeof row.snippet === "string" ? row.snippet : "",
  };
}

export async function handleChiefSessionSearch(request, response, deps = {}) {
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

  const query = searchQuery(request);
  const store = deps.store ?? new PrismaCheckpointStore();
  const result = await store.searchConversations(userId, { query });
  if (result?.error) {
    response.status(400).json({ error: result.error });
    return;
  }
  const conversations = (Array.isArray(result?.conversations) ? result.conversations : []).map(
    publicConversation
  );
  response.status(200).json({ conversations });
}

export default function handler(request, response) {
  return handleChiefSessionSearch(request, response);
}
