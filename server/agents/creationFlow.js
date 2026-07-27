import { WEEKDAY_NAMES } from "./schedule.js";

// ─────────────────────────────────────────────────────────────────────────────
// "+ New Agent" creation via CEO chat: mission-driven reasoning intake that
// patches a structured draft every turn. Session state still lives as a
// hidden AGENT message (CREATION_STATE_SENTINEL) on the isSystem conversation.
//
// Flow: Mission → gap questions → draft review → confirm. Schedule / model /
// trust pickers are Slice 2 — confirm uses on-demand + Sonnet defaults for now.
// On confirm the draft uses validateAgentCreatePayload → createAgentConfig
// (READ_ONLY / ACTIVE pin unchanged).
// ─────────────────────────────────────────────────────────────────────────────

export {
  CREATION_STATE_SENTINEL,
  decodeCreationState,
  encodeCreationState,
  isCreationStateContent,
} from "./creationState.js";

export {
  AIM_OPENER,
  applyDraftPatch,
  buildCreatePayloadFromDraft,
  emptyCreationDraft,
  isDraftReadyForReview,
  isMissionExecutable,
  publicCreationDraft,
} from "./creationDraft.js";

export {
  buildCreationSuccessReply,
  completeCreationSession,
  runCreationTurn,
  startCreationSession,
} from "./creationInterview.js";

const EMAIL_ADDRESS_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i;
const SCHEDULE_NOISE_RE =
  /\b(every|night|nights|morning|mornings|evening|evenings|afternoon|afternoons|at|on|and|the|a|an|to|for|please|me|my|report|reports|emailed?|email|send|sent|weekly|daily|monthly|on.?demand|manual(?:ly)?)\b/gi;

function extractWeekdays(lower) {
  return WEEKDAY_NAMES.filter((name) => new RegExp(`\\b${name}s?\\b`).test(lower));
}

function extractRequestedTime(message) {
  const match = String(message || "").match(TIME_RE);
  if (!match) return null;
  const hour = Number(match[1]);
  if (hour < 1 || hour > 12) return null;
  const minutes = match[2] ? `:${match[2]}` : "";
  const meridiem = match[3].replace(/\./g, "").toLowerCase();
  return `${hour}${minutes}${meridiem}`;
}

function requestedTimeToHourUtc(timeStr) {
  if (!timeStr) return null;
  const match = String(timeStr).match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  if (!Number.isInteger(hour) || hour < 1 || hour > 12) return null;
  const meridiem = match[3].toLowerCase();
  if (meridiem === "am") {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }
  return hour;
}

/** True when the message is mostly schedule / email / time wording (Slice 2). */
export function looksLikeScheduleOrEmailOnly(message) {
  const text = String(message || "").trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  const hasScheduleSignal =
    parseSchedule(text) !== undefined ||
    extractWeekdays(lower).length > 0 ||
    TIME_RE.test(text) ||
    /\b(schedule|run|runs|running)\b/i.test(text);
  const hasEmailSignal = /\bemail/i.test(text) || EMAIL_ADDRESS_RE.test(text);
  if (!hasScheduleSignal && !hasEmailSignal) return false;

  const residual = text
    .replace(EMAIL_ADDRESS_RE, " ")
    .replace(TIME_RE, " ")
    .replace(new RegExp(`\\b(${WEEKDAY_NAMES.join("|")})s?\\b`, "gi"), " ")
    .replace(SCHEDULE_NOISE_RE, " ")
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return residual.split(/\s+/).filter(Boolean).length <= 2;
}

/**
 * Parses schedule language. Kept for Slice 2 intake + unit tests; Slice 1
 * does not ask for schedule yet (defaults to on-demand).
 */
export function parseSchedule(message) {
  const lower = String(message || "").toLowerCase();
  const hourUtc = requestedTimeToHourUtc(extractRequestedTime(message));
  if (/\b(on.?demand|manual(?:ly)?|none|no schedule|only when i ask)\b/.test(lower)) {
    return {
      schedulePreset: null,
      scheduleWeekday: null,
      scheduleWeekdays: null,
      scheduleHourUtc: hourUtc,
    };
  }
  if (/\b(daily|every ?day)\b/.test(lower)) {
    return {
      schedulePreset: "daily",
      scheduleWeekday: null,
      scheduleWeekdays: null,
      scheduleHourUtc: hourUtc,
    };
  }
  if (/\bmonthly\b/.test(lower)) {
    return {
      schedulePreset: "monthly",
      scheduleWeekday: null,
      scheduleWeekdays: null,
      scheduleHourUtc: hourUtc,
    };
  }

  const weekdays = extractWeekdays(lower);
  const mentionsWeekly = /\b(weekly|every ?week)\b/.test(lower);
  if (mentionsWeekly || weekdays.length > 0) {
    if (weekdays.length > 1) {
      return {
        schedulePreset: "weekly",
        scheduleWeekday: weekdays[0],
        scheduleWeekdays: weekdays,
        scheduleHourUtc: hourUtc,
      };
    }
    return {
      schedulePreset: "weekly",
      scheduleWeekday: weekdays[0] || null,
      scheduleWeekdays: weekdays.length ? weekdays : null,
      scheduleHourUtc: hourUtc,
    };
  }
  return undefined;
}
