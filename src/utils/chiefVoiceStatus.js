// Connection words for the CHIEF voice catalog. The ElevenLabs key is not an input.

export const VOICE_CONNECTION = Object.freeze({
  CONNECTED: "connected",
  NOT_CONFIGURED: "not_configured",
  AUTHENTICATION_FAILED: "authentication_failed",
  UNAVAILABLE: "unavailable",
});

export const VOICE_CONNECTION_LABEL = Object.freeze({
  connected: "Connected",
  not_configured: "Not configured",
  authentication_failed: "Authentication failed",
  unavailable: "Unable to load voices",
});

export function voiceConnectionState({ configured = null, code = "" } = {}) {
  if (code === "authentication_failed") return VOICE_CONNECTION.AUTHENTICATION_FAILED;
  if (code === "not_configured" || configured === false) return VOICE_CONNECTION.NOT_CONFIGURED;
  if (typeof code === "string" && code) return VOICE_CONNECTION.UNAVAILABLE;
  if (configured === true) return VOICE_CONNECTION.CONNECTED;
  return VOICE_CONNECTION.UNAVAILABLE;
}

export function voiceConnectionLabel(state) {
  return VOICE_CONNECTION_LABEL[state] || VOICE_CONNECTION_LABEL.unavailable;
}
