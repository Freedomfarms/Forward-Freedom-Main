// CHIEF turn status → APEX visual state.
// Speaking means TTS playback. Token streaming stays thinking.

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
