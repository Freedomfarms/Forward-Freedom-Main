// Presentation projection of the CHIEF status the room already has.
// This does not store a turn, a session, or a second intelligence.

import { CHIEF_STATUS } from "../../utils/chiefProtocol.js";

const TOOL_LANES = Object.freeze({
  [CHIEF_STATUS.WEB_SEARCH]: "research",
  [CHIEF_STATUS.FINANCE]: "finance",
  [CHIEF_STATUS.MODULE_ACCESS]: "systems",
  [CHIEF_STATUS.MODULE_ACCESS_SET]: "systems",
  [CHIEF_STATUS.TOOL]: "tools",
  [CHIEF_STATUS.APPROVAL]: "hold",
});

export function worldPhase({ status, listening = false, speaking = false } = {}) {
  if (listening) return "listening";
  if (speaking) return "responding";
  if (status === CHIEF_STATUS.RESPONDING) return "responding";
  if (status === CHIEF_STATUS.WORKING) return "thinking";
  if (Object.prototype.hasOwnProperty.call(TOOL_LANES, status)) return "working";
  return "idle";
}

export function phaseWeights(phase) {
  return {
    idle: phase === "idle" ? 1 : 0,
    listen: phase === "listening" ? 1 : 0,
    think: phase === "thinking" ? 1 : 0,
    work: phase === "working" ? 1 : 0,
    respond: phase === "responding" ? 1 : 0,
  };
}

// One real status becomes one spatial station. Ready, thinking, and
// responding produce none — those are atmosphere, not invented workers.
export function activityForStatus(status) {
  const lane = TOOL_LANES[status];
  if (!lane) return null;
  return {
    id: lane,
    label: typeof status === "string" ? status : "",
    lane,
  };
}

export function resolveEntities(activity, entities) {
  if (Array.isArray(entities)) {
    return entities.filter((entity) => entity && typeof entity.id === "string" && entity.id);
  }
  return activity ? [activity] : [];
}

export function railsForRoster(roster) {
  const left = [];
  const right = [];
  if (!Array.isArray(roster)) return { left, right };
  for (const node of roster) {
    if (!Array.isArray(node) || typeof node[0] !== "string") continue;
    const item = { key: node[0], name: typeof node[1] === "string" ? node[1] : node[0] };
    const x = Number(node[3]);
    if (Number.isFinite(x) && x >= 360) right.push(item);
    else left.push(item);
  }
  return { left, right };
}

export function resolveWorldMotion(preference, intensity, reduced) {
  if (intensity === "off" || preference === "reduce" || (preference === "system" && reduced)) {
    return "off";
  }
  return intensity === "low" ? "low" : "full";
}
