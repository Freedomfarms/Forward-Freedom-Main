// CHIEF turn status → APEX visual state.
// Listening stays implemented in the vendored orb and is not selected here:
// CHIEF has no listening signal.

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
