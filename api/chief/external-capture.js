// Capture-token ingest into the existing external archive.
// Firebase sessions do not write here. The body cannot choose userId.

import { readBearerToken } from "../../server/auth/verifyAuth.js";
import { acceptCapturedConversation, CaptureRejected } from "../../server/chief/archive/capture.js";
import { PrismaCaptureCredential } from "../../server/chief/archive/captureStore.js";
import { parseCaptureToken } from "../../server/chief/archive/captureToken.js";
import { PrismaExternalArchive } from "../../server/chief/archive/store.js";
import { PrismaAuditLog } from "../../server/chief/security/audit.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "1mb",
    },
  },
};

function fail(response, status, code) {
  response.status(status).json({ error: "Capture was not stored.", code });
}

export async function handleExternalCapture(request, response, deps = {}) {
  applySecurityHeaders(response);
  const limit = deps.enforceRateLimit ?? enforceRateLimit;
  if (!(await limit(request, response, generalApiRateLimit))) return;
  if (request.method !== "GET" && request.method !== "POST") {
    fail(response, 405, "REJECTED");
    return;
  }

  const parsed = parseCaptureToken(readBearerToken(request));
  if (!parsed) {
    fail(response, 401, "AUTH");
    return;
  }

  const credentials = deps.credentials ?? new PrismaCaptureCredential();
  const now = deps.now ?? new Date();
  let auth;
  try {
    auth = await credentials.authenticate(parsed.userId, parsed.token);
  } catch {
    fail(response, 500, "STORE");
    return;
  }
  if (!auth?.ok) {
    fail(response, auth?.disabled ? 403 : 401, "AUTH");
    return;
  }

  if (request.method === "GET") {
    try {
      response.status(200).json(await credentials.status(parsed.userId));
    } catch {
      fail(response, 500, "STORE");
    }
    return;
  }

  const store = deps.store ?? new PrismaExternalArchive();
  const audit = deps.audit ?? new PrismaAuditLog();
  try {
    const result = await acceptCapturedConversation(parsed.userId, request.body ?? {}, {
      store,
      credentials,
      audit,
      now,
    });
    response.status(200).json(result);
  } catch (error) {
    const rejected = error instanceof CaptureRejected;
    const code = rejected ? error.code : "STORE";
    const status = rejected ? error.status : 500;
    if (code !== "AUTH") {
      try {
        await credentials.recordError(parsed.userId, request.body?.provider, code, now);
      } catch {
        // Status is best-effort. The response still reports the failure.
      }
    }
    fail(response, status, code);
  }
}

export default function handler(request, response) {
  return handleExternalCapture(request, response);
}
