// POST /api/chief/voice/trace — one privacy-safe voice lifecycle event.
// Transcripts, audio, and provider secrets are rejected.

import { authenticateRequest } from "../../../server/auth/verifyAuth.js";
import { assertDetailSafe } from "../../../server/chief/traces/collector.js";
import { recordVoiceTrace, sanitizeVoiceTrace } from "../../../server/chief/voice/trace.js";
import { applySecurityHeaders } from "../../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../../server/http/rateLimit.js";

function reject(response, status, error) {
  response.status(status).json({ error });
}

export async function handleChiefVoiceTrace(request, response, deps = {}) {
  applySecurityHeaders(response);
  const gate = deps.limit ?? ((req, res) => enforceRateLimit(req, res, generalApiRateLimit));
  if (!(await gate(request, response))) return;
  if (request.method !== "POST") {
    reject(response, 405, "POST required");
    return;
  }

  const authenticate = deps.authenticate ?? authenticateRequest;
  let userId;
  try {
    userId = (await authenticate(request)).uid;
  } catch (error) {
    reject(response, error.status || 401, error.message || "Unauthorized");
    return;
  }
  if (!userId) {
    reject(response, 401, "Unauthorized");
    return;
  }

  const trace = sanitizeVoiceTrace(request.body ?? {});
  if (!trace) {
    reject(response, 400, "voice trace is invalid");
    return;
  }
  try {
    assertDetailSafe(trace.detail);
  } catch {
    reject(response, 400, "voice trace is invalid");
    return;
  }

  const store = deps.store;
  try {
    await recordVoiceTrace({
      userId,
      event: trace.event,
      sessionId: trace.sessionId,
      detail: trace.detail,
      status: trace.status,
      ...(store ? { store } : {}),
    });
    response.status(202).json({ saved: true });
  } catch {
    response.status(202).json({ saved: false });
  }
}

export default function handler(request, response) {
  return handleChiefVoiceTrace(request, response);
}
