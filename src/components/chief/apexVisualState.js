// CHIEF turn status → APEX visual state.
// Listening overrides the turn. Speaking is ElevenLabs playback only.
// Token streaming stays thinking.

import { fieldKindForStatus } from "../../utils/chiefRoom.js";

export function visualStateForStatus(status, voicePhase = "idle") {
  if (voicePhase === "speaking") return "speaking";
  if (voicePhase === "listening") return "listening";
  if (voicePhase === "thinking") return "thinking";
  const kind = fieldKindForStatus(status);
  if (kind === "ready" || kind === "approval" || kind === "error") return "idle";
  return "thinking";
}

export function webStateForStatus(status, voicePhase = "idle") {
  const orb = visualStateForStatus(status, voicePhase);
  if (orb === "speaking") return "speaking";
  if (orb === "listening") return "listening";
  if (orb === "thinking") return "processing";
  return "standby";
}

export function visualStateForInteraction({ status, listening = false, speaking = false } = {}) {
  if (listening) return "listening";
  if (speaking) return "speaking";
  return visualStateForStatus(status);
}

export function webStateForInteraction(input) {
  const orb = visualStateForInteraction(input);
  if (orb === "listening") return "listening";
  if (orb === "thinking") return "processing";
  if (orb === "speaking") return "speaking";
  return "standby";
}
