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

function reject(response, status, error) {
  response.status(status).json({ error, message: error });
}

export async function handleChiefModuleAccess(request, response, deps = {}) {
  applySecurityHeaders(response);
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;
  if (request.method !== "GET" && request.method !== "POST") {
    reject(response, 405, "GET or POST required");
    return;
  }

  const authenticate = deps.authenticate ?? authenticateRequest;
  let userId;
  try {
    userId = (await authenticate(request)).uid;
  } catch (error) {
    // The only application 403 on this route is authenticateRequest (a
    // disabled account). A normal read-only grant does not return 403.
    // `message` is set so the client does not describe that JSON as a
    // body-less firewall block. This route never grants a write.
    reject(response, error.status || 401, error.message || "Unauthorized");
    return;
  }
  if (!userId) {
    reject(response, 401, "Unauthorized");
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
      reject(response, 400, "module02Read must be a boolean");
      return;
    }
    const saved = await store.setModule02ReadEnabled(userId, body.module02Read);
    response.status(200).json(publicAccess(saved));
  } catch (error) {
    const status = error.status || 500;
    reject(
      response,
      status,
      status >= 500
        ? "Freedom Financial access could not be saved."
        : error.message || "Freedom Financial access could not be saved."
    );
  }
}

export default function handler(request, response) {
  return handleChiefModuleAccess(request, response);
}
