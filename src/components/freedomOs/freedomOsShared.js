import { ApiRequestError } from "../../utils/api.js";

// Shared presentation helpers for the Freedom OS views. All styling matches
// the existing dashboard visual language (styles.js + inline styles).

export const AGENT_TYPE_META = {
  finance: { label: "Finance", icon: "$", color: "#38bdf8" },
  research: { label: "Research", icon: "🔎", color: "#a855f7" },
  reminders: { label: "Reminders", icon: "⏰", color: "#f59e0b" },
  email: { label: "Email", icon: "✉️", color: "#64748b" },
};

export function getAgentTypeMeta(agentType) {
  return AGENT_TYPE_META[agentType] || { label: agentType || "Agent", icon: "◈", color: "#9fb0c9" };
}

export const PERSONALITY_PRESETS = [
  {
    value: "DIRECT_EFFICIENT",
    label: "Direct & Efficient",
    description: "Short, to the point, focused on the next action.",
  },
  {
    value: "WARM_ENCOURAGING",
    label: "Warm & Encouraging",
    description: "Supportive tone that celebrates progress.",
  },
  {
    value: "FORMAL",
    label: "Formal",
    description: "Professional, measured, businesslike.",
  },
];

export const DEFAULT_AGENT_MODEL = "claude-sonnet-4-5";

/** Capability-focused model labels (no per-user billing language). */
export const AGENT_MODEL_OPTIONS = [
  {
    value: "claude-haiku-4-5",
    shortLabel: "Haiku",
    label: "Haiku — Fastest",
    description: "Quick replies for everyday questions.",
  },
  {
    value: "claude-sonnet-4-5",
    shortLabel: "Sonnet",
    label: "Sonnet — Balanced (recommended)",
    description: "Strong default for most chats and agents.",
  },
  {
    value: "claude-opus-4-1",
    shortLabel: "Opus",
    label: "Opus — Smartest",
    description: "Deepest reasoning for harder decisions.",
  },
];

export function getAgentModelLabel(value) {
  return (
    AGENT_MODEL_OPTIONS.find((option) => option.value === value)?.label ||
    AGENT_MODEL_OPTIONS.find((option) => option.value === DEFAULT_AGENT_MODEL).label
  );
}

export function getPersonalityLabel(value) {
  return PERSONALITY_PRESETS.find((preset) => preset.value === value)?.label || "Direct & Efficient";
}

export const SCHEDULE_PRESET_OPTIONS = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: null, label: "On demand" },
];

function titleCaseWeekday(day) {
  if (!day) return "Monday";
  return `${day.charAt(0).toUpperCase()}${day.slice(1)}`;
}

export function formatSchedule(schedule) {
  if (!schedule || !schedule.preset) return "On demand";
  const hour =
    Number.isInteger(schedule.hourUtc) && schedule.hourUtc >= 0 && schedule.hourUtc <= 23
      ? `${schedule.hourUtc}:00 UTC`
      : null;
  if (schedule.preset === "weekly") {
    const days =
      Array.isArray(schedule.weekdays) && schedule.weekdays.length > 0
        ? schedule.weekdays.map(titleCaseWeekday).join(", ")
        : titleCaseWeekday(schedule.weekday);
    return hour ? `Weekly (${days}) at ${hour}` : `Weekly (${days})`;
  }
  const label = `${schedule.preset.charAt(0).toUpperCase()}${schedule.preset.slice(1)}`;
  return hour ? `${label} at ${hour}` : label;
}

export function formatRelativeTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  const deltaMs = Date.now() - date.getTime();
  if (deltaMs < 60 * 1000) return "Just now";
  const minutes = Math.floor(deltaMs / (60 * 1000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Maps an ApiRequestError to friendly copy. 503 = server-side AI key missing;
 * 429 = rate limited (respects Retry-After when available).
 */
export function describeAgentApiError(error, fallback = "Something went wrong. Try again.") {
  if (error instanceof ApiRequestError) {
    if (error.status === 503) {
      return "The AI service is not available right now (the platform key is not configured). Everything else keeps working — try again later.";
    }
    if (error.status === 429) {
      const waitSeconds = error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : null;
      return waitSeconds
        ? `You've hit the usage limit for now. Try again in about ${waitSeconds} seconds.`
        : "You've hit the usage limit for now. Give it a moment and try again.";
    }
    const code = error.payload?.code;
    if (code === "CONVERSATION_TARGET_MISMATCH") {
      return "That chat belongs to a different agent. Switched you back to this agent's conversations.";
    }
    if (code === "CONVERSATION_NOT_FOUND") {
      return "That chat could not be found. Starting a fresh conversation.";
    }
    if (code === "CONVERSATION_ARCHIVED") {
      return "That chat is archived. Pick another conversation or start a new one.";
    }
    if (error.message) return error.message;
  }
  const raw = typeof error?.message === "string" ? error.message.trim() : "";
  // Browser TypeError when fetch never gets an HTTP response (network reset,
  // CORS on an edge challenge page, aborted connection, offline, etc.).
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    return (
      "Could not reach the server (network error). Check your connection and retry. " +
      "If this keeps happening, a hosting firewall may be blocking the request."
    );
  }
  return raw || fallback;
}

// ── Shared style fragments ───────────────────────────────────────────────────

export const fosStyles = {
  primaryButton: {
    borderRadius: 10,
    border: "1px solid rgba(120,220,255,.45)",
    background: "linear-gradient(90deg,#0077ff,#00d8ff)",
    color: "white",
    padding: "10px 14px",
    cursor: "pointer",
    fontWeight: 900,
    fontSize: 13,
  },
  secondaryButton: {
    borderRadius: 10,
    border: "1px solid rgba(0,216,255,.24)",
    background: "rgba(0,136,255,.08)",
    color: "#eef6ff",
    padding: "10px 14px",
    cursor: "pointer",
    fontWeight: 800,
    fontSize: 13,
  },
  subtleButton: {
    borderRadius: 999,
    border: "1px solid rgba(0,216,255,.18)",
    background: "rgba(0,136,255,.06)",
    color: "#dff7ff",
    padding: "8px 11px",
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 12,
  },
  input: {
    width: "100%",
    borderRadius: 10,
    border: "1px solid rgba(0,216,255,.20)",
    background: "rgba(0,136,255,.07)",
    color: "#eef6ff",
    padding: "11px 13px",
    outline: "none",
    fontSize: 14,
    boxSizing: "border-box",
  },
  sectionLabel: {
    color: "#8feaff",
    fontSize: 12,
    fontWeight: 900,
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
  errorBox: {
    color: "#ffd9df",
    background: "rgba(255,36,77,.08)",
    border: "1px solid rgba(255,93,122,.22)",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 13,
    lineHeight: 1.5,
  },
  noticeBox: {
    color: "#dff7ff",
    background: "rgba(0,136,255,.10)",
    border: "1px solid rgba(0,216,255,.22)",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 13,
    lineHeight: 1.5,
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
};

export function statusBadgeStyle(status) {
  const active = status === "ACTIVE";
  return {
    ...fosStyles.badge,
    border: active ? "1px solid rgba(34,197,94,.4)" : "1px solid rgba(255,182,93,.4)",
    background: active ? "rgba(34,197,94,.12)" : "rgba(255,182,93,.10)",
    color: active ? "#7cf1af" : "#ffd38a",
  };
}

export function runStatusColor(status) {
  if (status === "SUCCEEDED") return "#7cf1af";
  if (status === "FAILED") return "#ff8ba0";
  if (status === "SKIPPED") return "#ffd38a";
  return "#8feaff";
}
