// GET /api/chief/voice/voices — names and labels for the configured account.
// The ElevenLabs key is not returned.

import { authenticateRequest } from "../../../server/auth/verifyAuth.js";
import {
  elevenLabsApiKey,
  elevenLabsConfigured,
  listElevenVoices,
} from "../../../server/chief/voice/elevenlabs.js";
import { applySecurityHeaders } from "../../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../../server/http/rateLimit.js";

function reject(response, status, error, code) {
  response.status(status).json({ error, code });
}

export async function handleChiefVoices(request, response, deps = {}) {
  applySecurityHeaders(response);
  const gate = deps.limit ?? ((req, res) => enforceRateLimit(req, res, generalApiRateLimit));
  if (!(await gate(request, response))) return;
  if (request.method !== "GET") {
    reject(response, 405, "GET required", "method");
    return;
  }

  const authenticate = deps.authenticate ?? authenticateRequest;
  let userId;
  try {
    userId = (await authenticate(request)).uid;
  } catch (error) {
    reject(response, error.status || 401, error.message || "Unauthorized", "unauthorized");
    return;
  }
  if (!userId) {
    reject(response, 401, "Unauthorized", "unauthorized");
    return;
  }

  const env = deps.env ?? process.env;
  if (!elevenLabsConfigured(env)) {
    response.status(200).json({ configured: false, voices: [] });
    return;
  }

  try {
    const result = await listElevenVoices({
      apiKey: elevenLabsApiKey(env),
      fetchImpl: deps.fetchImpl ?? fetch,
    });
    if (!result.ok) {
      reject(response, 502, "Voices could not be loaded.", result.code || "provider_error");
      return;
    }
    response.status(200).json({ configured: true, voices: result.voices });
  } catch {
    reject(response, 502, "Voices could not be loaded.", "network");
  }
}

export default function handler(request, response) {
  return handleChiefVoices(request, response);
}
