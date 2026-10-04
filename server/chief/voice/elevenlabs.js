// Server-side ElevenLabs voice list and streaming speech.
// The API key stays in ELEVENLABS_API_KEY. Callers pass env in tests so this
// module never reads a secret from the client.

import dotenv from "dotenv";

export const ELEVENLABS_VOICES_URL = "https://api.elevenlabs.io/v2/voices";
export const ELEVENLABS_SPEECH_URL = "https://api.elevenlabs.io/v1/text-to-speech";
export const ELEVENLABS_PROVIDER = "ElevenLabs";
export const SPEECH_CHAR_LIMIT = 4000;

const VOICE_ID_PATTERN = /^[A-Za-z0-9]{10,40}$/;
const PAGE_SIZE = 100;
const PAGE_LIMIT = 5;

const SPEECH_ATTEMPTS = Object.freeze([
  Object.freeze({ model: "eleven_flash_v2_5", format: "pcm_24000" }),
  Object.freeze({ model: "eleven_multilingual_v2", format: "mp3_44100_128" }),
]);

export function readElevenLabsApiKey(env = process.env) {
  const direct = typeof env?.ELEVENLABS_API_KEY === "string" ? env.ELEVENLABS_API_KEY.trim() : "";
  if (direct || env !== process.env) return direct;
  dotenv.config({ path: ".env.local" });
  return typeof process.env.ELEVENLABS_API_KEY === "string"
    ? process.env.ELEVENLABS_API_KEY.trim()
    : "";
}

export function isVoiceId(value) {
  return typeof value === "string" && VOICE_ID_PATTERN.test(value);
}

export function redactSecret(value, apiKey) {
  const text = typeof value === "string" ? value : "";
  if (!apiKey) return text;
  return text.split(apiKey).join("[redacted]");
}

export function upstreamDetail(bodyText, apiKey) {
  let raw = redactSecret(typeof bodyText === "string" ? bodyText : "", apiKey);
  let detail = "";
  try {
    const parsed = JSON.parse(raw);
    const node = parsed?.detail;
    if (typeof node === "string") detail = node;
    else if (node && typeof node.message === "string") detail = node.message;
    else if (typeof parsed?.message === "string") detail = parsed.message;
    else if (node && typeof node.status === "string") detail = node.status;
  } catch {
    detail = raw;
  }
  detail = redactSecret(detail, apiKey).replace(/\s+/g, " ").trim();
  if (detail.length > 160) detail = `${detail.slice(0, 157)}...`;
  return detail;
}

export function voiceListFailureMessage(status, detail) {
  const suffix = detail ? `: ${detail}` : "";
  const lead =
    status === 401 || status === 403
      ? `ElevenLabs rejected the API key (${status})`
      : `ElevenLabs voice list failed (${status})`;
  return `${lead}${suffix}`.slice(0, 180);
}

export function speechFailureMessage(status, detail) {
  const suffix = detail ? `: ${detail}` : "";
  const lead =
    status === 401 || status === 403
      ? `ElevenLabs rejected the API key (${status})`
      : `ElevenLabs speech failed (${status})`;
  return `${lead}${suffix}`.slice(0, 180);
}

export function publicVoices(payload) {
  const rows = Array.isArray(payload?.voices) ? payload.voices : [];
  const seen = new Set();
  const voices = [];
  for (const row of rows) {
    const voiceId = typeof row?.voice_id === "string" ? row.voice_id.trim() : "";
    const name = typeof row?.name === "string" ? row.name.trim() : "";
    if (!isVoiceId(voiceId) || !name || seen.has(voiceId)) continue;
    seen.add(voiceId);
    voices.push({
      voice_id: voiceId,
      name,
      category: typeof row?.category === "string" ? row.category : "",
    });
  }
  return voices;
}

export function plainSpeechText(value) {
  const source = typeof value === "string" ? value : "";
  const spoken = source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return spoken.slice(0, SPEECH_CHAR_LIMIT);
}

function elevenHeaders(apiKey, accept) {
  return {
    "xi-api-key": apiKey,
    Accept: accept,
  };
}

export async function listElevenLabsVoices({
  fetchImpl = fetch,
  apiKey,
  pageLimit = PAGE_LIMIT,
} = {}) {
  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      detail: "",
      message: "ElevenLabs is not configured.",
    };
  }
  const voices = [];
  let token = "";
  for (let page = 0; page < pageLimit; page += 1) {
    const url = new URL(ELEVENLABS_VOICES_URL);
    url.searchParams.set("page_size", String(PAGE_SIZE));
    if (token) url.searchParams.set("next_page_token", token);
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: elevenHeaders(apiKey, "application/json"),
      });
    } catch (error) {
      const detail = redactSecret(error?.message || "network error", apiKey);
      return {
        ok: false,
        status: 502,
        detail,
        message: voiceListFailureMessage(502, detail),
      };
    }
    const bodyText = await response.text();
    if (!response.ok) {
      const detail = upstreamDetail(bodyText, apiKey);
      return {
        ok: false,
        status: response.status,
        detail,
        message: voiceListFailureMessage(response.status, detail),
      };
    }
    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return {
        ok: false,
        status: 502,
        detail: "ElevenLabs returned a voice list that was not JSON.",
        message: "ElevenLabs voice list failed (502): response was not JSON.",
      };
    }
    voices.push(...publicVoices(payload));
    if (!payload?.has_more || typeof payload?.next_page_token !== "string" || !payload.next_page_token) {
      break;
    }
    token = payload.next_page_token;
  }
  return { ok: true, status: 200, voices };
}

async function requestSpeech({ fetchImpl, apiKey, voiceId, text, model, format, signal }) {
  const url = new URL(
    `${ELEVENLABS_SPEECH_URL}/${encodeURIComponent(voiceId)}/stream`
  );
  url.searchParams.set("output_format", format);
  const accept = format.startsWith("mp3") ? "audio/mpeg" : "application/octet-stream";
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        ...elevenHeaders(apiKey, accept),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, model_id: model }),
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const detail = redactSecret(error?.message || "network error", apiKey);
    return { ok: false, status: 502, detail, message: speechFailureMessage(502, detail) };
  }
  if (!response.ok || !response.body) {
    const bodyText = await response.text().catch(() => "");
    const detail = upstreamDetail(bodyText, apiKey);
    return {
      ok: false,
      status: response.status,
      detail,
      message: speechFailureMessage(response.status, detail),
    };
  }
  return { ok: true, response, format, model };
}

export async function openElevenLabsSpeech({
  fetchImpl = fetch,
  apiKey,
  voiceId,
  text,
  signal,
  logger = console,
} = {}) {
  const spoken = plainSpeechText(text);
  if (!apiKey) {
    return { ok: false, status: 503, message: "ElevenLabs is not configured." };
  }
  if (!isVoiceId(voiceId)) {
    return { ok: false, status: 400, message: "Choose an ElevenLabs voice." };
  }
  if (!spoken) {
    return { ok: false, status: 400, message: "There is nothing to speak." };
  }
  let last = null;
  for (let index = 0; index < SPEECH_ATTEMPTS.length; index += 1) {
    const attempt = SPEECH_ATTEMPTS[index];
    const result = await requestSpeech({
      fetchImpl,
      apiKey,
      voiceId,
      text: spoken,
      model: attempt.model,
      format: attempt.format,
      signal,
    });
    if (result.ok) return result;
    last = result;
    const retryable = result.status === 400 || result.status === 422;
    if (retryable && index < SPEECH_ATTEMPTS.length - 1) {
      logger.error?.("[chief-voice] ElevenLabs speech attempt failed", {
        status: result.status,
        detail: result.detail || "",
        model: attempt.model,
        format: attempt.format,
      });
      continue;
    }
    break;
  }
  return last;
}

// Settings and voice-sheet speech. The API key stays in server env.
// This block is separate from the streaming dock helpers above.
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
