// CHIEF turn status → APEX visual state.
// Listening and playback sit on top of the turn status so typed and spoken
// turns share the same orb: idle, listening, thinking, speaking.

import { fieldKindForStatus } from "../../utils/chiefRoom.js";

export function visualStateForStatus(status) {
  const kind = fieldKindForStatus(status);
  if (kind === "responding") return "speaking";
  if (kind === "ready" || kind === "approval" || kind === "error") return "idle";
  return "thinking";
}

export function webStateForStatus(status) {
  const orb = visualStateForStatus(status);
  if (orb === "speaking") return "speaking";
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
