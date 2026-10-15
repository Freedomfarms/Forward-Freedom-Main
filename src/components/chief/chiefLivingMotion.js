// Maps the existing CHIEF turn and voice lifecycle onto the living scene.
// Speeds are multipliers of idle. Nothing here invents activity.

export const LIVING_VIEW = Object.freeze({
  width: 1000,
  height: 920,
  cx: 500,
  cy: 408,
  core: 148,
});

export const LIVING_SPEED = Object.freeze({
  idle: 1,
  listening: 1.15,
  thinking: 2.5,
  responding: 1.4,
  error: 0.6,
});

const VIOLET = Object.freeze({
  idle: 0.16,
  listening: 0.2,
  thinking: 0.32,
  responding: 0.75,
  error: 0.12,
});

export function systemActivity({
  scenePhase = "idle",
  assistantState = "idle",
  status = "",
  statusTone = "ready",
} = {}) {
  const text = typeof status === "string" ? status : "";
  const thinking = scenePhase === "thinking";
  const searching = thinking && /search/i.test(text);
  const connecting = thinking && /access/i.test(text);
  const processing = thinking && !searching && !connecting && /tool|financial/i.test(text);
  const reasoning = thinking && !searching && !connecting && !processing;
  return {
    listening: assistantState === "listening",
    processing,
    reasoning,
    searching,
    connecting,
    responding: scenePhase === "responding" || assistantState === "speaking",
    error: statusTone === "error",
  };
}

export function livingPace(activity, scenePhase) {
  if (activity.listening) return "listening";
  if (activity.responding) return "responding";
  if (scenePhase === "thinking") return "thinking";
  if (activity.error) return "error";
  return "idle";
}

export function motionForPace(pace) {
  const key = Object.prototype.hasOwnProperty.call(LIVING_SPEED, pace) ? pace : "idle";
  return {
    pace: key,
    speed: LIVING_SPEED[key],
    violet: VIOLET[key],
  };
}

export function livingMotion(input = {}) {
  const activity = systemActivity(input);
  const pace = livingPace(activity, input.scenePhase || "idle");
  return { ...motionForPace(pace), activity };
}
