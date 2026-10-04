// Read-only projection of the access the CHIEF room is allowed to show.
// Money follows the Freedom Financial read flag. Web follows the same capability
// check ToolExecutor uses, plus whether a search credential exists.
// This module does not grant anything and does not return secrets.

import { Capability } from "../core/capabilities.js";

export const ROOM_ACCESS = Object.freeze({
  ON: "on",
  OFF: "off",
  UNAVAILABLE: "unavailable",
});

export function projectMoneyAccess({ enabled, readable = true } = {}) {
  if (readable === false) return ROOM_ACCESS.UNAVAILABLE;
  return enabled === true ? ROOM_ACCESS.ON : ROOM_ACCESS.OFF;
}

export function projectWebAccess({
  granted = false,
  credentialPresent = false,
  readable = true,
} = {}) {
  if (readable === false) return ROOM_ACCESS.UNAVAILABLE;
  if (granted !== true) return ROOM_ACCESS.OFF;
  if (credentialPresent !== true) return ROOM_ACCESS.UNAVAILABLE;
  return ROOM_ACCESS.ON;
}

export function webSearchGranted(policy, agentId = "chief") {
  if (!policy || typeof policy.check !== "function") return false;
  return policy.check(agentId, Capability.WEB_SEARCH, "web_search") === true;
}
