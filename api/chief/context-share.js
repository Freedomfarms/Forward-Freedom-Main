// Explicit context handoff. Propose does not share. Handoff copies nothing
// until confirm is true, and it does not write a durable memory.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { PrismaExternalArchive } from "../../server/chief/archive/store.js";
import { handoffContextPackage, proposeContextPackage } from "../../server/chief/context/share.js";
import { PrismaFactStore } from "../../server/chief/memory/facts.js";
import { PrismaCheckpointStore } from "../../server/chief/runtime/checkpoint.js";
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
  const error =
    code === "STALE"
      ? "The context changed. Find context again before copying."
      : "Context was not shared.";
  response.status(status).json({ error, code });
}

export async function handleContextShare(request, response, deps = {}) {
  applySecurityHeaders(response);
  const limit = deps.enforceRateLimit ?? enforceRateLimit;
  if (!(await limit(request, response, generalApiRateLimit))) return;
  if (request.method !== "POST") {
    fail(response, 405, "REJECTED");
    return;
  }

  const authenticate = deps.authenticate ?? authenticateRequest;
  let userId;
  try {
    userId = (await authenticate(request)).uid;
  } catch (error) {
    fail(response, error.status || 401, "AUTH");
    return;
  }
  if (!userId) {
    fail(response, 401, "AUTH");
    return;
  }

  const body = request.body ?? {};
  const stores = {
    facts: deps.facts ?? new PrismaFactStore(),
    checkpoints: deps.checkpoints ?? new PrismaCheckpointStore(),
    archive: deps.archive ?? new PrismaExternalArchive(),
    audit: deps.audit ?? new PrismaAuditLog(),
  };
  try {
    if (body.action === "propose") {
      const proposed = await proposeContextPackage(userId, body.query, stores, deps.now);
      if (proposed.error) {
        fail(response, proposed.status || 400, proposed.error);
        return;
      }
      response.status(200).json(proposed);
      return;
    }
    if (body.action === "handoff") {
      const handed = await handoffContextPackage(userId, body, stores, deps.now);
      if (handed.error) {
        fail(response, handed.status || 400, handed.error);
        return;
      }
      response.status(200).json(handed);
      return;
    }
    fail(response, 400, "REJECTED");
  } catch {
    fail(response, 500, "STORE");
  }
}

export default function handler(request, response) {
  return handleContextShare(request, response);
}
