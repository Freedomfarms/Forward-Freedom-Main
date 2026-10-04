// CHIEF interface preferences. Voice synthesis settings stay in voiceSettings.js.
// This document has no credentials and no API keys.

export const CHIEF_PREFERENCES_KEY = "chief.preferences";

export const DEFAULT_CHIEF_PREFERENCES = Object.freeze({
  conversation: Object.freeze({
    voiceResponses: true,
    autoSpeak: false,
    showResponseText: true,
    enterToSend: true,
  }),
  appearance: Object.freeze({
    reducedMotion: "system",
    animationIntensity: "full",
    showTelemetry: true,
    showNavLabels: true,
  }),
});

function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeChiefPreferences(value) {
  const source = value && typeof value === "object" ? value : {};
  const conversation =
    source.conversation && typeof source.conversation === "object" ? source.conversation : {};
  const appearance =
    source.appearance && typeof source.appearance === "object" ? source.appearance : {};
  const reduced = appearance.reducedMotion === "reduce" ? "reduce" : "system";
  const intensity =
    appearance.animationIntensity === "low" || appearance.animationIntensity === "off"
      ? appearance.animationIntensity
      : "full";
  return {
    conversation: {
      voiceResponses: bool(
        conversation.voiceResponses,
        DEFAULT_CHIEF_PREFERENCES.conversation.voiceResponses
      ),
      autoSpeak: bool(conversation.autoSpeak, DEFAULT_CHIEF_PREFERENCES.conversation.autoSpeak),
      showResponseText: bool(
        conversation.showResponseText,
        DEFAULT_CHIEF_PREFERENCES.conversation.showResponseText
      ),
      enterToSend: bool(
        conversation.enterToSend,
        DEFAULT_CHIEF_PREFERENCES.conversation.enterToSend
      ),
    },
    appearance: {
      reducedMotion: reduced,
      animationIntensity: intensity,
      showTelemetry: bool(
        appearance.showTelemetry,
        DEFAULT_CHIEF_PREFERENCES.appearance.showTelemetry
      ),
      showNavLabels: bool(
        appearance.showNavLabels,
        DEFAULT_CHIEF_PREFERENCES.appearance.showNavLabels
      ),
    },
  };
}

export function shouldSpeakReply({ source = "text", preferences } = {}) {
  const next = normalizeChiefPreferences(preferences);
  if (next.conversation.voiceResponses !== true) return false;
  if (source === "voice") return true;
  return next.conversation.autoSpeak === true;
}

function storageOf(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readChiefPreferences(storage) {
  const bin = storageOf(storage);
  if (!bin) return normalizeChiefPreferences(null);
  try {
    const raw = bin.getItem(CHIEF_PREFERENCES_KEY);
    if (!raw) return normalizeChiefPreferences(null);
    return normalizeChiefPreferences(JSON.parse(raw));
  } catch {
    return normalizeChiefPreferences(null);
  }
}

export function writeChiefPreferences(value, storage) {
  const bin = storageOf(storage);
  const next = normalizeChiefPreferences(value);
  if (!bin) return next;
  try {
    bin.setItem(CHIEF_PREFERENCES_KEY, JSON.stringify(next));
  } catch {
    // Private mode can reject storage. The in-memory copy still applies.
  }
  return next;
}
