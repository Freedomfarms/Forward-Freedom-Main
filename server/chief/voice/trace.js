// Privacy-safe voice lifecycle traces.
// Detail is an allowlist. Audio, transcripts, and secrets never qualify.

import { TRACE_STEP } from "../traces/collector.js";
import { PrismaTraceStore } from "../traces/store.js";

export const VOICE_TRACE_EVENTS = Object.freeze([
  "voice.listen_started",
  "voice.transcription_completed",
  "voice.request_submitted",
  "voice.tts_started",
  "voice.tts_stopped",
  "voice.tts_completed",
  "voice.interrupted",
  "voice.error",
]);

const STAGES = new Set(["stt", "tts", "playback", "turn", "mic"]);
const PROVIDERS = new Set(["elevenlabs", "browser"]);
const CODE = /^[a-z0-9_]{1,64}$/;

export function sanitizeVoiceTrace(body) {
  const event = typeof body?.event === "string" ? body.event : "";
  if (!VOICE_TRACE_EVENTS.includes(event)) return null;
  const source =
    body?.detail && typeof body.detail === "object" && !Array.isArray(body.detail)
      ? body.detail
      : {};
  const detail = {};
  if (typeof source.stage === "string" && STAGES.has(source.stage)) detail.stage = source.stage;
  if (typeof source.code === "string" && CODE.test(source.code)) detail.code = source.code;
  if (typeof source.provider === "string" && PROVIDERS.has(source.provider)) {
    detail.provider = source.provider;
  }
  if (event === "voice.error" && !detail.code) return null;
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
  return {
    event,
    sessionId: sessionId ? sessionId.slice(0, 128) : null,
    detail,
    status: event === "voice.error" ? "error" : "ok",
  };
}

export async function recordVoiceTrace({
  userId,
  event,
  sessionId = null,
  detail = {},
  status = "ok",
  store = new PrismaTraceStore(),
} = {}) {
  if (!userId) throw new TypeError("voice trace requires userId");
  const saved = await store.save({
    userId,
    sessionId,
    turnId: null,
    agentId: "chief",
    model: null,
    tokensInput: null,
    tokensOutput: null,
    outcome: event,
    feedback: null,
    startedAt: new Date(),
    completedAt: new Date(),
    steps: [
      {
        stepType: TRACE_STEP.VOICE,
        name: event,
        status,
        detail,
        startedAt: new Date(),
        completedAt: new Date(),
      },
    ],
  });
  return saved;
}
