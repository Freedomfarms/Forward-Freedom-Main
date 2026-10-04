// ElevenLabs speech synthesis. The API key stays in server env.
// Callers cannot choose the upstream URL.

const VOICES_URL = "https://api.elevenlabs.io/v1/voices";
const SPEECH_URL = "https://api.elevenlabs.io/v1/text-to-speech";

export const ELEVEN_MODELS = Object.freeze([
  "eleven_multilingual_v2",
  "eleven_turbo_v2_5",
  "eleven_turbo_v2",
  "eleven_flash_v2_5",
  "eleven_flash_v2",
  "eleven_monolingual_v1",
]);

const DEFAULT_MODEL = "eleven_multilingual_v2";
const VOICE_ID = /^[A-Za-z0-9]{8,64}$/;

export function elevenLabsApiKey(env = process.env) {
  const key = typeof env.ELEVENLABS_API_KEY === "string" ? env.ELEVENLABS_API_KEY.trim() : "";
  return key || "";
}

export function elevenLabsConfigured(env = process.env) {
  return Boolean(elevenLabsApiKey(env));
}

function clamp(value, min, max, fallback) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function modelIdOf(requested, env) {
  const requestedId = typeof requested === "string" ? requested.trim() : "";
  if (ELEVEN_MODELS.includes(requestedId)) return requestedId;
  const configured =
    typeof env.ELEVENLABS_MODEL_ID === "string" ? env.ELEVENLABS_MODEL_ID.trim() : "";
  if (ELEVEN_MODELS.includes(configured)) return configured;
  return DEFAULT_MODEL;
}

export function sanitizeSpeechRequest(body, env = process.env) {
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return { error: "text is required", code: "invalid_request", status: 400 };
  if (text.length > 5000)
    return { error: "text is too long", code: "invalid_request", status: 400 };
  const requestedVoice = typeof body?.voiceId === "string" ? body.voiceId.trim() : "";
  const configuredVoice =
    typeof env.ELEVENLABS_VOICE_ID === "string" ? env.ELEVENLABS_VOICE_ID.trim() : "";
  const voiceId = requestedVoice || configuredVoice;
  if (!voiceId) return { error: "voice_id is required", code: "voice_required", status: 400 };
  if (!VOICE_ID.test(voiceId)) {
    return { error: "voice_id is invalid", code: "invalid_request", status: 400 };
  }
  const settings = body?.settings && typeof body.settings === "object" ? body.settings : {};
  return {
    text,
    voiceId,
    modelId: modelIdOf(body?.modelId, env),
    settings: {
      speed: clamp(settings.speed, 0.7, 1.2, 1),
      stability: clamp(settings.stability, 0, 1, 0.7),
      similarityBoost: clamp(settings.similarityBoost, 0, 1, 0.75),
      style: clamp(settings.style, 0, 1, 0.3),
    },
  };
}

export function projectElevenVoices(payload) {
  const voices = Array.isArray(payload?.voices) ? payload.voices : [];
  const projected = [];
  for (const voice of voices) {
    if (projected.length >= 100) break;
    const id = typeof voice?.voice_id === "string" ? voice.voice_id.trim() : "";
    if (!VOICE_ID.test(id)) continue;
    const labels = {};
    if (voice?.labels && typeof voice.labels === "object" && !Array.isArray(voice.labels)) {
      for (const [key, value] of Object.entries(voice.labels)) {
        if (!/^[A-Za-z0-9_]{1,32}$/.test(key) || typeof value !== "string") continue;
        const trimmed = value.trim();
        if (!trimmed || trimmed.length > 80) continue;
        labels[key] = trimmed;
      }
    }
    projected.push({
      id,
      name:
        typeof voice.name === "string" && voice.name.trim()
          ? voice.name.trim().slice(0, 80)
          : "Voice",
      language: typeof labels.language === "string" ? labels.language : "",
      labels,
    });
  }
  return projected;
}

function failureCode(status) {
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 429) return "rate_limited";
  return "provider_error";
}

async function discard(response) {
  try {
    await response.arrayBuffer();
  } catch {
    // The error body is intentionally unread.
  }
}

export async function listElevenVoices({ apiKey, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(VOICES_URL, {
    method: "GET",
    headers: { "xi-api-key": apiKey, Accept: "application/json" },
  });
  if (!response.ok) {
    await discard(response);
    return { ok: false, status: response.status, code: failureCode(response.status) };
  }
  const payload = await response.json().catch(() => ({}));
  return { ok: true, voices: projectElevenVoices(payload) };
}

export async function synthesizeElevenSpeech({
  apiKey,
  voiceId,
  text,
  modelId,
  settings,
  fetchImpl = fetch,
} = {}) {
  const response = await fetchImpl(`${SPEECH_URL}/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      Accept: "audio/mpeg",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: {
        stability: settings.stability,
        similarity_boost: settings.similarityBoost,
        style: settings.style,
        speed: settings.speed,
      },
    }),
  });
  const type = String(response.headers?.get?.("content-type") || "");
  if (!response.ok || !type.includes("audio")) {
    await discard(response);
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      code: response.ok ? "provider_error" : failureCode(response.status),
    };
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) return { ok: false, status: 502, code: "provider_error" };
  return { ok: true, audio };
}

export function publicVoiceConfig(env = process.env) {
  const model = modelIdOf("", env);
  const voiceId =
    typeof env.ELEVENLABS_VOICE_ID === "string" && VOICE_ID.test(env.ELEVENLABS_VOICE_ID.trim())
      ? env.ELEVENLABS_VOICE_ID.trim()
      : "";
  return {
    provider: "elevenlabs",
    configured: elevenLabsConfigured(env),
    defaultVoiceId: voiceId,
    defaultModelId: model,
    fallbackAvailable: true,
  };
}
