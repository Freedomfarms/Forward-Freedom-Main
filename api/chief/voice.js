// CHIEF voice — ElevenLabs speech synthesis and public voice configuration.
// The API key is read on the server and is never written to the response.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import {
  elevenLabsApiKey,
  elevenLabsConfigured,
  publicVoiceConfig,
  sanitizeSpeechRequest,
  synthesizeElevenSpeech,
} from "../../server/chief/voice/elevenlabs.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import {
  agentLlmRateLimit,
  enforceRateLimit,
  generalApiRateLimit,
} from "../../server/http/rateLimit.js";

function reject(response, status, error, code) {
  response.status(status).json({ error, code });
}

async function requireUser(request, response, authenticate) {
  try {
    const userId = (await authenticate(request)).uid;
    if (!userId) {
      reject(response, 401, "Unauthorized", "unauthorized");
      return null;
    }
    return userId;
  } catch (error) {
    reject(response, error.status || 401, error.message || "Unauthorized", "unauthorized");
    return null;
  }
}

export async function handleChiefVoice(request, response, deps = {}) {
  applySecurityHeaders(response);
  const method = request.method || "GET";
  const limit = method === "POST" ? agentLlmRateLimit : generalApiRateLimit;
  const gate = deps.limit ?? ((req, res) => enforceRateLimit(req, res, limit));
  if (!(await gate(request, response))) return;
  if (method !== "GET" && method !== "POST") {
    reject(response, 405, "GET or POST required", "method");
    return;
  }

  const authenticate = deps.authenticate ?? authenticateRequest;
  const userId = await requireUser(request, response, authenticate);
  if (!userId) return;

  const env = deps.env ?? process.env;
  if (method === "GET") {
    response.status(200).json(publicVoiceConfig(env));
    return;
  }

  if (!elevenLabsConfigured(env)) {
    reject(response, 503, "Voice is not configured.", "not_configured");
    return;
  }
  const speech = sanitizeSpeechRequest(request.body ?? {}, env);
  if (speech.error) {
    reject(response, speech.status, speech.error, speech.code);
    return;
  }
  let result;
  try {
    result = await synthesizeElevenSpeech({
      apiKey: elevenLabsApiKey(env),
      voiceId: speech.voiceId,
      text: speech.text,
      modelId: speech.modelId,
      settings: speech.settings,
      fetchImpl: deps.fetchImpl ?? fetch,
    });
  } catch {
    reject(response, 502, "Voice could not be reached.", "network");
    return;
  }
  if (!result.ok) {
    const status = result.status === 401 || result.status === 403 ? 502 : result.status || 502;
    reject(
      response,
      status >= 400 && status < 600 ? status : 502,
      "Voice could not speak.",
      result.code
    );
    return;
  }
  response.status(200);
  response.setHeader("Content-Type", "audio/mpeg");
  response.setHeader("Cache-Control", "no-store");
  response.end(result.audio);
}

export default function handler(request, response) {
  return handleChiefVoice(request, response);
}
