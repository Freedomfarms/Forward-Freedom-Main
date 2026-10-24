// Maps the live CHIEF turn onto the Frontier scene's four activities.
// Status strings stay the real ones. This does not invent a fifth state.

import { CHIEF_STATUS } from "../../../utils/chiefProtocol.js";

const THINKING_STATUS = new Set([
  CHIEF_STATUS.WORKING,
  CHIEF_STATUS.TOOL,
  CHIEF_STATUS.FINANCE,
  CHIEF_STATUS.WEB_SEARCH,
  CHIEF_STATUS.MODULE_ACCESS,
  CHIEF_STATUS.MODULE_ACCESS_SET,
]);

const COPY = Object.freeze({
  idle: Object.freeze({
    title: "Standing by",
    subtitle: "A space for your next thought.",
    presence: "Ready when you are.",
    label: "STANDING BY",
  }),
  listening: Object.freeze({
    title: "Listening",
    subtitle: "CHIEF is listening.",
    presence: "Listening.",
    label: "LISTENING",
  }),
  thinking: Object.freeze({
    title: "Reasoning",
    subtitle: "Working through that.",
    presence: "A moment to think it through.",
    label: "REASONING",
  }),
  responding: Object.freeze({
    title: "Responding",
    subtitle: "Bringing a thought into view.",
    presence: "Responding.",
    label: "RESPONDING",
  }),
});

// One activity for the SYSTEM panel, the core, and the status line.
// Listening, playback, streamed text, and the Managed Agents turn status are
// the inputs. Tool names stay detail text; they do not invent a fifth activity.
export function chiefLiveActivity({
  listening = false,
  assistantState = "idle",
  scenePhase = "idle",
  status = "",
  playback = "idle",
  speaking = false,
  turnStatus = "",
} = {}) {
  if (listening || assistantState === "listening") return "listening";
  if (
    playback === "preparing" ||
    playback === "playing" ||
    speaking === true ||
    status === CHIEF_STATUS.RESPONDING ||
    scenePhase === "responding" ||
    assistantState === "speaking"
  ) {
    return "responding";
  }
  if (status === CHIEF_STATUS.APPROVAL || status === CHIEF_STATUS.ERROR) return "idle";
  if (
    turnStatus === "continuing" ||
    turnStatus === "running" ||
    scenePhase === "thinking" ||
    assistantState === "thinking" ||
    THINKING_STATUS.has(status)
  ) {
    return "thinking";
  }
  return "idle";
}

export function frontierActivity(input) {
  return chiefLiveActivity(input);
}

const GENERIC_STATUS = new Set(["Ready", "Sign in", "Working", "Responding"]);

export function frontierStatusCopy(activity, status) {
  const base = COPY[activity] || COPY.idle;
  const text = typeof status === "string" ? status.trim() : "";
  const specific = Boolean(text) && !GENERIC_STATUS.has(text) && text !== base.title;
  return {
    title: base.title,
    subtitle: specific ? text : base.subtitle,
    presence: specific ? text : base.presence,
    label: base.label,
  };
}
