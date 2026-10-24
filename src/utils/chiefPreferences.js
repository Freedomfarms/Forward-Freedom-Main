// CHIEF interface preferences. Voice synthesis settings stay in voiceSettings.js.
// This document has no credentials and no API keys.

export const CHIEF_PREFERENCES_KEY = "chief.preferences";

export const CHIEF_RESPONSE_MODES = Object.freeze(["text", "voice", "both"]);

export const DEFAULT_CHIEF_PREFERENCES = Object.freeze({
  conversation: Object.freeze({
    voiceResponses: true,
    responseMode: "both",
    autoSpeak: true,
    speechChoice: true,
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

export function isResponseMode(value) {
  return value === "text" || value === "voice" || value === "both";
}

function flagsForResponseMode(mode) {
  if (mode === "text") return { autoSpeak: false, showResponseText: true };
  if (mode === "voice") return { autoSpeak: true, showResponseText: false };
  return { autoSpeak: true, showResponseText: true };
}

// Missing responseMode follows the last saved speech and text flags.
// An explicit responseMode wins, and the legacy flags are rewritten from it.
export function responseModeFromConversation(conversation) {
  const source = conversation && typeof conversation === "object" ? conversation : {};
  if (isResponseMode(source.responseMode)) return source.responseMode;
  const explicitChoice = source.speechChoice === true || source.speechChoice === false;
  const textShown = source.showResponseText !== false;
  if (source.autoSpeak === false && explicitChoice && textShown) return "text";
  if (source.showResponseText === false && source.autoSpeak !== false) return "voice";
  return "both";
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
  const responseMode = responseModeFromConversation(conversation);
  const flags = flagsForResponseMode(responseMode);
  return {
    conversation: {
      voiceResponses: responseMode !== "text",
      responseMode,
      autoSpeak: flags.autoSpeak,
      speechChoice: conversation.speechChoice === false ? false : true,
      showResponseText: flags.showResponseText,
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

// Input method does not decide delivery. Text and microphone turns share this gate.
// The response mode is the delivery choice. voiceResponses is kept in step with
// it so an older mute flag cannot silence Voice or Text + Voice.
export function shouldSpeakReply({ preferences } = {}) {
  const next = normalizeChiefPreferences(preferences);
  return next.conversation.responseMode === "voice" || next.conversation.responseMode === "both";
}

// Voice mode hides assistant text until the reader asks to reveal it.
export function shouldShowAssistantText({ preferences, reveal = false } = {}) {
  const next = normalizeChiefPreferences(preferences);
  if (reveal) return true;
  return next.conversation.responseMode !== "voice";
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
    const parsed = JSON.parse(raw);
    const conversation =
      parsed?.conversation && typeof parsed.conversation === "object" ? parsed.conversation : null;
    // The first speech preference defaulted typed replies to silent. A saved
    // autoSpeak:false without an explicit choice is that default, not an opt-out.
    const legacySilent =
      conversation?.autoSpeak === false &&
      conversation.speechChoice !== true &&
      conversation.speechChoice !== false;
    const seeded = legacySilent
      ? {
          ...parsed,
          conversation: { ...conversation, autoSpeak: true, speechChoice: true },
        }
      : parsed;
    const next = normalizeChiefPreferences(seeded);
    const flagsDiffer =
      legacySilent ||
      conversation?.responseMode !== next.conversation.responseMode ||
      conversation?.autoSpeak !== next.conversation.autoSpeak ||
      conversation?.showResponseText !== next.conversation.showResponseText;
    if (flagsDiffer) {
      try {
        bin.setItem(CHIEF_PREFERENCES_KEY, JSON.stringify(next));
      } catch {
        // The in-memory copy still applies.
      }
    }
    return next;
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
