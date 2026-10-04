// GET /api/chief/voices — ElevenLabs voices for the signed-in CHIEF user.
// Returns voice_id and display name only. The API key never leaves the server.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import {
  ELEVENLABS_PROVIDER,
  listElevenLabsVoices,
  readElevenLabsApiKey,
} from "../../server/chief/voice/elevenlabs.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";

export async function handleChiefVoices(request, response, deps = {}) {
  applySecurityHeaders(response);
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;
  if (request.method !== "GET") {
    response.status(405).json({ error: "GET required" });
    return;
  }

  const authenticate = deps.authenticate ?? authenticateRequest;
  try {
    await authenticate(request);
  } catch (error) {
    response.status(error.status || 401).json({ error: error.message || "Unauthorized" });
    return;
  }

  const logger = deps.logger ?? console;
  const apiKey = readElevenLabsApiKey(deps.env ?? process.env);
  const result = await listElevenLabsVoices({
    fetchImpl: deps.fetchImpl ?? fetch,
    apiKey,
  });
  if (!result.ok) {
    logger.error?.("[chief-voice] ElevenLabs voice list failed", {
      status: result.status,
      detail: result.detail || "",
    });
    const upstream = result.status || 502;
    const httpStatus = upstream === 401 || upstream === 403 ? 502 : upstream;
    response.status(httpStatus).json({
      error: result.message || "ElevenLabs voice list failed.",
      provider: ELEVENLABS_PROVIDER,
      status: upstream,
    });
    return;
  }

  response.status(200).json({
    provider: ELEVENLABS_PROVIDER,
    voices: result.voices,
  });
}

export default function handler(request, response) {
  return handleChiefVoices(request, response);
}
