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
