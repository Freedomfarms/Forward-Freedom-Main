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

export function frontierActivity({
  listening = false,
  assistantState = "idle",
  scenePhase = "idle",
  status = "",
} = {}) {
  if (listening || assistantState === "listening") return "listening";
  if (
    scenePhase === "responding" ||
    assistantState === "speaking" ||
    status === CHIEF_STATUS.RESPONDING
  ) {
    return "responding";
  }
  if (scenePhase === "thinking" || assistantState === "thinking" || THINKING_STATUS.has(status)) {
    return "thinking";
  }
  return "idle";
}

export function frontierStatusCopy(activity, status) {
  const base = COPY[activity] || COPY.idle;
  const text = typeof status === "string" ? status.trim() : "";
  const specific = Boolean(text) && text !== "Ready" && text !== "Sign in" && text !== base.title;
  return {
    title: specific ? text : base.title,
    subtitle: base.subtitle,
    presence: specific ? text : base.presence,
    label: base.label,
  };
}
