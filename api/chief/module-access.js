// GET/POST /api/chief/module-access — the authenticated user's Module 02
// read switch. The body cannot name another user, and the flag cannot grant
// a write. CHIEF's module02_access_set uses the same store.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { PrismaModuleAccess } from "../../server/chief/security/module-access.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";
import { readJsonBody } from "../../server/http/requestHelpers.js";

function publicAccess(row) {
  return { module02Read: row?.module02Read === true, writeAccess: false };
}

export async function handleChiefModuleAccess(request, response, deps = {}) {
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

  const store = deps.store ?? new PrismaModuleAccess();
  try {
    if (request.method === "GET") {
      const enabled = await store.isModule02ReadEnabled(userId);
      response.status(200).json(publicAccess({ module02Read: enabled }));
      return;
    }
    const body = await readJsonBody(request);
    if (typeof body.module02Read !== "boolean") {
      response.status(400).json({ error: "module02Read must be a boolean" });
      return;
    }
    const saved = await store.setModule02ReadEnabled(userId, body.module02Read);
    response.status(200).json(publicAccess(saved));
  } catch (error) {
    const status = error.status || 500;
    response.status(status).json({
      error: status >= 500 ? "Module 02 access could not be saved." : error.message,
    });
  }
}

export default function handler(request, response) {
  return handleChiefModuleAccess(request, response);
}
