// Provider-neutral voice configuration. The ElevenLabs key is not stored here.

export const VOICE_SETTINGS_KEY = "chief.voice.settings";

export const DEFAULT_VOICE_SETTINGS = Object.freeze({
  provider: "elevenlabs",
  voiceId: "",
  modelId: "",
  speed: 1,
  stability: 0.7,
  similarityBoost: 0.75,
  style: 0.3,
  fallbackEnabled: false,
});

function clamp(value, min, max, fallback) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function cleanId(value, pattern) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return pattern.test(trimmed) ? trimmed : "";
}

export function normalizeVoiceSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    provider: "elevenlabs",
    voiceId: cleanId(source.voiceId, /^[A-Za-z0-9]{0,64}$/),
    modelId: cleanId(source.modelId, /^[A-Za-z0-9_]{0,64}$/),
    speed: clamp(source.speed, 0.7, 1.2, DEFAULT_VOICE_SETTINGS.speed),
    stability: clamp(source.stability, 0, 1, DEFAULT_VOICE_SETTINGS.stability),
    similarityBoost: clamp(source.similarityBoost, 0, 1, DEFAULT_VOICE_SETTINGS.similarityBoost),
    style: clamp(source.style, 0, 1, DEFAULT_VOICE_SETTINGS.style),
    fallbackEnabled: source.fallbackEnabled === true,
  };
}

function storageOf(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readVoiceSettings(storage) {
  const bin = storageOf(storage);
  if (!bin) return { ...DEFAULT_VOICE_SETTINGS };
  try {
    const raw = bin.getItem(VOICE_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_VOICE_SETTINGS };
    return normalizeVoiceSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS };
  }
}

export function writeVoiceSettings(value, storage) {
  const bin = storageOf(storage);
  const next = normalizeVoiceSettings(value);
  if (!bin) return next;
  try {
    bin.setItem(VOICE_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // Private mode can reject storage. The in-memory copy still applies.
  }
  return next;
}
