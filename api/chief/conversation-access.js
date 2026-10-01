// GET/POST /api/chief/conversation-access — the authenticated user's three
// conversation switches. A missing row is off. This route does not read or
// change Module 02 access, and the body cannot name another user.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import {
  CONVERSATION_ACCESS_KEYS,
  PrismaConversationAccess,
} from "../../server/chief/security/conversation-access.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";
import { readJsonBody } from "../../server/http/requestHelpers.js";

function publicAccess(row) {
  return {
    conversationRead: row?.conversationRead === true,
    conversationOrganize: row?.conversationOrganize === true,
    conversationDelete: row?.conversationDelete === true,
  };
}

export async function handleChiefConversationAccess(request, response, deps = {}) {
  applySecurityHeaders(response);
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;
  if (request.method !== "GET" && request.method !== "POST") {
    response.status(405).json({ error: "GET or POST required" });
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
  if (!userId) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  const store = deps.store ?? new PrismaConversationAccess();
  try {
    if (request.method === "GET") {
      response.status(200).json(publicAccess(await store.get(userId)));
      return;
    }
    const body = await readJsonBody(request);
    const patch = {};
    for (const key of CONVERSATION_ACCESS_KEYS) {
      if (Object.hasOwn(body, key)) patch[key] = body[key];
    }
    const saved = await store.set(userId, patch);
    response.status(200).json(publicAccess(saved));
  } catch (error) {
    const status = error.status || 500;
    response.status(status).json({
      error: status >= 500 ? "Conversation access could not be saved." : error.message,
    });
  }
}

export default function handler(request, response) {
  return handleChiefConversationAccess(request, response);
}
