// GET/PUT /api/chief/personality — conversational preferences for the signed-in user.
// The body cannot name another user. Custom instructions are not logged.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import {
  readChiefPersonality,
  saveChiefPersonality,
} from "../../server/chief/personality/store.js";
import { CHIEF_PERSONALITY_FIELDS } from "../../src/utils/chiefPersonality.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";
import { readJsonBody } from "../../server/http/requestHelpers.js";

function reject(response, status, error) {
  response.status(status).json({ error });
}

function publicPersonality(result) {
  return {
    ...result.personality,
    persisted: result.persisted === true,
    schemaReady: result.schemaReady !== false,
  };
}

export async function handleChiefPersonality(request, response, deps = {}) {
  applySecurityHeaders(response);
  if (deps.limit) {
    if (!(await deps.limit())) return;
  } else if (!(await enforceRateLimit(request, response, generalApiRateLimit))) {
    return;
  }
  if (request.method !== "GET" && request.method !== "PUT") {
    reject(response, 405, "GET or PUT required");
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

  const withUser = deps.withUser;
  try {
    if (request.method === "GET") {
      const result = await (deps.read ?? readChiefPersonality)(userId, { withUser });
      response.status(200).json(publicPersonality(result));
      return;
    }
    const body = deps.body ?? (await readJsonBody(request));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      reject(response, 400, "Personality settings must be an object.");
      return;
    }
    // userId in the body is ignored. The authenticated id is the only scope.
    const patch = {};
    for (const key of CHIEF_PERSONALITY_FIELDS) {
      if (Object.hasOwn(body, key)) patch[key] = body[key];
    }
    const allowed = new Set([...CHIEF_PERSONALITY_FIELDS, "userId", "persisted", "schemaReady"]);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      reject(response, 400, "Unknown personality setting.");
      return;
    }
    const result = await (deps.save ?? saveChiefPersonality)(userId, patch, { withUser });
    response.status(200).json(publicPersonality(result));
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) {
      console.error("[chief/personality]", error?.code || error?.name || "failed");
    }
    reject(
      response,
      status,
      status >= 500
        ? "Personality settings could not be saved."
        : error.message || "Invalid personality settings."
    );
  }
}

export default function handler(request, response) {
  return handleChiefPersonality(request, response);
}
