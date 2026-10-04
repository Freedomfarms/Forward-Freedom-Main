// CHIEF voice lifecycle. This is the peripheral around the existing session.
// It does not start a turn, choose a model, or store a transcript.

export const VOICE_PHASE = Object.freeze({
  IDLE: "idle",
  LISTENING: "listening",
  THINKING: "thinking",
  SPEAKING: "speaking",
  ERROR: "error",
});

const PHASES = new Set(Object.values(VOICE_PHASE));

export function voicePhaseOrIdle(phase) {
  return PHASES.has(phase) ? phase : VOICE_PHASE.IDLE;
}

// Tap the core. Listening cancels. Speaking and thinking barge in to listening.
// Idle and error begin listening.
export function phaseAfterCoreTap(phase) {
  const current = voicePhaseOrIdle(phase);
  if (current === VOICE_PHASE.LISTENING) return VOICE_PHASE.IDLE;
  return VOICE_PHASE.LISTENING;
}

export function isWakePhraseOnly(text) {
  const normalized = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[.!?,]+/g, "")
    .replace(/\s+/g, " ");
  return normalized === "hey chief";
}

// Only a non-empty final transcript is a turn. "Hey chief" by itself is not.
export function transcriptForTurn(text) {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  if (!trimmed || isWakePhraseOnly(trimmed)) return "";
  return trimmed;
}

export function spokenText(text) {
  const source = typeof text === "string" ? text : "";
  const withoutCode = source.replace(/```[\s\S]*?```/g, " ");
  const withoutLinks = withoutCode.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  const plain = withoutLinks
    .replace(/[`*_#>~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= 4500) return plain;
  const slice = plain.slice(0, 4500);
  const sentence = slice.lastIndexOf(". ");
  return (sentence > 2000 ? slice.slice(0, sentence + 1) : slice).trim();
}

export function voiceErrorMessage(code) {
  switch (code) {
    case "unsupported":
      return "This browser cannot hear speech. Type to CHIEF instead.";
    case "permission_denied":
      return "Microphone permission is off.";
    case "mic_unavailable":
      return "No microphone is available.";
    case "not_configured":
      return "Spoken voice is not configured.";
    case "voice_required":
      return "Choose a voice before CHIEF can speak.";
    case "authentication_failed":
      return "Spoken voice could not sign in.";
    case "rate_limited":
      return "Spoken voice is busy. Try again in a moment.";
    case "playback_failed":
      return "CHIEF could not play that response.";
    case "network":
      return "CHIEF could not reach voice.";
    default:
      return "CHIEF voice stopped.";
  }
}

export function recognitionErrorCode(error) {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "permission_denied";
    case "audio-capture":
      return "mic_unavailable";
    case "network":
      return "network";
    case "no-speech":
    case "aborted":
      return "";
    default:
      return "stt_error";
  }
}
