// Tiny sentinel helpers with no agent-module dependencies. Kept separate so
// chat message decoding can filter creation-state rows without importing the
// full creationFlow state machine (which pulls in the agent registry).

export const CREATION_STATE_SENTINEL = "[[FREEDOM_OS_AGENT_CREATION_STATE]]";

export function isCreationStateContent(text) {
  return typeof text === "string" && text.startsWith(CREATION_STATE_SENTINEL);
}

export function encodeCreationState(state) {
  return `${CREATION_STATE_SENTINEL}${JSON.stringify(state)}`;
}

export function decodeCreationState(text) {
  if (!isCreationStateContent(text)) return null;
  try {
    const state = JSON.parse(text.slice(CREATION_STATE_SENTINEL.length));
    return state && typeof state === "object" ? state : null;
  } catch {
    return null;
  }
}
