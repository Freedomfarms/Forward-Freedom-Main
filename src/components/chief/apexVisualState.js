// CHIEF turn status → APEX visual state.
// Listening overrides the turn. Streamed text and ElevenLabs playback are
// both responding. Tool work and a still-open Managed Agents turn are thinking.

import { fieldKindForStatus } from "../../utils/chiefRoom.js";
import { chiefLiveActivity } from "./frontier/frontierActivity.js";

export function visualStateForStatus(status, voicePhase = "idle") {
  if (voicePhase === "speaking") return "speaking";
  if (voicePhase === "listening") return "listening";
  if (voicePhase === "thinking") return "thinking";
  const kind = fieldKindForStatus(status);
  if (kind === "responding") return "speaking";
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

export function visualStateForInteraction(input = {}) {
  const activity = chiefLiveActivity(input);
  if (activity === "listening") return "listening";
  if (activity === "responding") return "speaking";
  if (activity === "thinking") return "thinking";
  return "idle";
}

export function webStateForInteraction(input) {
  const orb = visualStateForInteraction(input);
  if (orb === "listening") return "listening";
  if (orb === "thinking") return "processing";
  if (orb === "speaking") return "speaking";
  return "standby";
}

// Scene core for the CHIEF home. Tool work pulses blue. Answer text and
// speech hold a steady violet core until that delivery actually ends.
export function scenePhaseForInteraction(input = {}) {
  const activity = chiefLiveActivity(input);
  if (activity === "responding") return "responding";
  if (activity === "thinking") return "thinking";
  return "idle";
}
