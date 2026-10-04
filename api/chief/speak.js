// POST /api/chief/speak — stream ElevenLabs speech for a CHIEF reply.
// This does not start a turn, grant a tool, or read a provider secret from
// the browser. TurnMachine remains the only conversation path.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { openElevenLabsSpeech, readElevenLabsApiKey } from "../../server/chief/voice/elevenlabs.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";

export async function handleChiefSpeak(request, response, deps = {}) {
  applySecurityHeaders(response);
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;
  if (request.method !== "POST") {
    response.status(405).json({ error: "POST required" });
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
  const controller = new AbortController();
  const onClose = () => controller.abort();
  request.on?.("close", onClose);

  let opened;
  try {
    opened = await openElevenLabsSpeech({
      fetchImpl: deps.fetchImpl ?? fetch,
      apiKey,
      voiceId: request.body?.voice_id,
      text: request.body?.text,
      signal: controller.signal,
      logger,
    });
  } catch (error) {
    if (error?.name === "AbortError") return;
    logger.error?.("[chief-voice] ElevenLabs speech failed", {
      status: 502,
      detail: error?.message || "network error",
    });
    response.status(502).json({ error: "ElevenLabs speech failed (502)." });
    return;
  }

  if (!opened?.ok) {
    logger.error?.("[chief-voice] ElevenLabs speech failed", {
      status: opened?.status || 502,
      detail: opened?.detail || "",
    });
    const upstream = opened?.status || 502;
    const httpStatus = upstream === 401 || upstream === 403 ? 502 : upstream;
    response.status(httpStatus).json({
      error: opened?.message || "ElevenLabs speech failed.",
      status: upstream,
    });
    return;
  }

  const format = opened.format === "mp3_44100_128" ? "mp3" : "pcm_24000";
  response.status(200);
  response.setHeader("Content-Type", format === "mp3" ? "audio/mpeg" : "application/octet-stream");
  response.setHeader("X-Chief-Audio-Format", format);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Accel-Buffering", "no");
  if (typeof response.flushHeaders === "function") response.flushHeaders();

  const reader = opened.response.body.getReader();
  try {
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) response.write(Buffer.from(value));
    }
  } catch (error) {
    if (error?.name !== "AbortError") {
      logger.error?.("[chief-voice] ElevenLabs speech stream broke", {
        detail: error?.message || "stream error",
      });
    }
  } finally {
    reader.releaseLock?.();
    if (!response.writableEnded) response.end();
  }
}

export default function handler(request, response) {
  return handleChiefSpeak(request, response);
}
