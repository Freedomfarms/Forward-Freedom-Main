import { CREATABLE_AGENT_TYPES } from "./registry.js";
import { WEEKDAY_NAMES } from "./schedule.js";

// ─────────────────────────────────────────────────────────────────────────────
// "+ New Agent" creation via CEO chat: a deterministic multi-turn state
// machine (no LLM call, no new table). The state lives as a hidden message in
// the user's encrypted CEO chat thread — an AGENT-role AgentChatMessage whose
// content starts with CREATION_STATE_SENTINEL. The chat transcript renderer
// filters those rows out, so state never reaches a prompt or the client.
//
// Required fields: type → purpose → data → schedule → definition of done →
// review → (confirm creates the agent). Each turn extracts ANY recognizable
// fields from the user's message (schedule, email intent, purpose, etc.), so
// answers given out of order or bundled together are not stuffed into the
// wrong slot. Only still-missing fields are asked next.
//
// On confirm the draft goes through the SAME validation + creation path as
// POST /api/agents (validateAgentCreatePayload → createAgentConfig), so the
// READ_ONLY / ACTIVE safety pin cannot be bypassed from chat.
// ─────────────────────────────────────────────────────────────────────────────

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

const TYPE_LABELS = Object.freeze({
  finance: "Finance",
  research: "Research",
  reminders: "Reminders",
  email: "Email",
});

const SCHEDULE_QUESTION =
  'How often should it run? Say "daily", "weekly" (optionally with a weekday, e.g. "weekly on friday"), "monthly", or "on demand" if you only want to trigger it manually.';

const STEP_QUESTIONS = Object.freeze({
  choose_type: `What kind of agent should I set up? Available types: ${CREATABLE_AGENT_TYPES.join(", ")}. (You can say "cancel" at any point.)`,
  clarify_purpose: "What should this agent focus on? Describe its purpose in a sentence or two.",
  clarify_data:
    "What data or area should it pay attention to? (For a reminders agent, mention email if you also want the reminder emailed to your account address.)",
  clarify_schedule: SCHEDULE_QUESTION,
  definition_of_done:
    "Last question: give me one specific, measurable sentence that defines success for this agent (its definition of done).",
});

const EMAIL_ADDRESS_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i;
const SCHEDULE_NOISE_RE =
  /\b(every|night|nights|morning|mornings|evening|evenings|afternoon|afternoons|at|on|and|the|a|an|to|for|please|me|my|report|reports|emailed?|email|send|sent|weekly|daily|monthly|on.?demand|manual(?:ly)?)\b/gi;

function matchesCancel(message) {
  return /\b(cancel|nevermind|never mind|abort|forget it)\b/i.test(message);
}

function extractWeekdays(lower) {
  return WEEKDAY_NAMES.filter((name) => new RegExp(`\\b${name}s?\\b`).test(lower));
}

function extractEmailAddress(message) {
  const match = String(message || "").match(EMAIL_ADDRESS_RE);
  return match ? match[0] : null;
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

/** True when the message is mostly schedule / email / time wording. */
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
  // Residual tokens that are just soft filler still count as schedule/email-only.
  return residual.split(/\s+/).filter(Boolean).length <= 2;
}

/**
 * Parses schedule language. Accepts day names without an explicit "weekly"
 * keyword ("every monday", "mondays and thursdays"). Multiple weekdays are
 * returned as scheduleWeekdays so the stepper can ask the user to pick one
 * (the stored schedule model supports a single weekly weekday).
 */
export function parseSchedule(message) {
  const lower = String(message || "").toLowerCase();
  if (/\b(on.?demand|manual(?:ly)?|none|no schedule|only when i ask)\b/.test(lower)) {
    return { schedulePreset: null, scheduleWeekday: null };
  }
  if (/\b(daily|every ?day)\b/.test(lower)) {
    return { schedulePreset: "daily", scheduleWeekday: null };
  }
  if (/\bmonthly\b/.test(lower)) {
    return { schedulePreset: "monthly", scheduleWeekday: null };
  }

  const weekdays = extractWeekdays(lower);
  const mentionsWeekly = /\b(weekly|every ?week)\b/.test(lower);
  if (mentionsWeekly || weekdays.length > 0) {
    if (weekdays.length > 1) {
      return { schedulePreset: "weekly", scheduleWeekday: null, scheduleWeekdays: weekdays };
    }
    return {
      schedulePreset: "weekly",
      scheduleWeekday: weekdays[0] || null,
      scheduleWeekdays: weekdays.length ? weekdays : null,
    };
  }
  return undefined;
}

function composedInstructions(draft) {
  const purpose = String(draft.instructions || "").trim();
  const dataFocus = String(draft.dataFocus || "").trim();
  if (!dataFocus) return purpose.slice(0, 2000);
  if (!purpose) return `Data focus: ${dataFocus}`.slice(0, 2000);
  return `${purpose}\nData focus: ${dataFocus}`.slice(0, 2000);
}

function scheduleLabel(draft) {
  if (!draft.scheduleResolved) return "not set";
  if (!draft.schedulePreset) return "on demand only";
  if (draft.schedulePreset === "weekly") {
    return `weekly (${draft.scheduleWeekday || "monday"})`;
  }
  return draft.schedulePreset;
}

function renderReview(draft) {
  const lines = [
    "Here's the agent I'll create:",
    `- Type: ${TYPE_LABELS[draft.agentType] || draft.agentType}`,
    `- Name: ${draft.name}`,
    `- Focus: ${composedInstructions(draft)}`,
    `- Schedule: ${scheduleLabel(draft)}`,
    `- Definition of done: ${draft.definitionOfDone}`,
    "- Permissions: read-only (all new agents start read-only)",
  ];
  if (draft.requestedTime) {
    lines.push(
      `- Note: you asked for ${draft.requestedTime}, but scheduled runs currently fire at 13:00 UTC (custom times aren't configurable yet).`
    );
  }
  if (draft.agentType === "email") {
    lines.push(
      "- Note: the email agent type can be configured now but cannot run yet — its runtime is not available in this phase."
    );
  }
  if (draft.toolAccess?.email) {
    lines.push(
      draft.agentType === "reminders"
        ? "- Email delivery: reminders will also be emailed to your own verified account address."
        : "- Email delivery: each run's report will also be emailed to your own verified account address."
    );
    if (draft.emailAddress) {
      lines.push(
        `- Note: agents can only email YOUR account address (and only once it's verified) — ${draft.emailAddress} can't be used unless it IS your account email.`
      );
    }
  } else if (draft.emailRequested || draft.emailAddress) {
    const dest = draft.emailAddress ? ` to ${draft.emailAddress}` : "";
    lines.push(
      `- Note: emailing reports${dest} isn't available for this agent type; you'll see outputs in Freedom OS.`
    );
  }
  lines.push('Reply "confirm" to create it, or "cancel" to discard.');
  return lines.join("\n");
}

function questionForMissing(draft) {
  if (!draft.agentType) return STEP_QUESTIONS.choose_type;
  if (!draft.instructions) return STEP_QUESTIONS.clarify_purpose;
  // Finish an in-flight multi-day schedule choice before other slots so we
  // don't drop "monday and thursday" on the floor while re-asking for data.
  if (draft.pendingWeekdays?.length) {
    return `I can schedule weekly on one day right now. Which day should I use — ${draft.pendingWeekdays.join(" or ")}?`;
  }
  if (!draft.dataFocus) return STEP_QUESTIONS.clarify_data;
  if (!draft.scheduleResolved) return SCHEDULE_QUESTION;
  if (!draft.definitionOfDone) return STEP_QUESTIONS.definition_of_done;
  return null;
}

function stepForDraft(draft) {
  if (!draft.agentType) return "choose_type";
  if (!draft.instructions) return "clarify_purpose";
  if (draft.pendingWeekdays?.length) return "clarify_schedule";
  if (!draft.dataFocus) return "clarify_data";
  if (!draft.scheduleResolved) return "clarify_schedule";
  if (!draft.definitionOfDone) return "definition_of_done";
  return "review";
}

/** Avoid treating "monthly spending" / prose as a schedule answer. */
function shouldAbsorbSchedule(message, asSlot) {
  if (looksLikeScheduleOrEmailOnly(message)) return true;
  // Explicitly on the schedule step (including pending weekday disambiguation).
  if (asSlot === null || asSlot === undefined) return true;
  const lower = String(message || "").toLowerCase();
  if (/\b(on.?demand|only when i ask|no schedule)\b/.test(lower)) return true;
  if (/\b(weekly\s+on|every\s+week|every\s+day|scheduled?\s+as|runs?\s+(daily|weekly|monthly))\b/.test(lower)) {
    return true;
  }
  if (
    extractWeekdays(lower).length > 0 &&
    /\b(every|each|night|nights|morning|evening|schedule|scheduled|runs?)\b/.test(lower)
  ) {
    return true;
  }
  return false;
}

function applyScheduleParse(draft, parsed) {
  if (!parsed) return null;
  if (parsed.scheduleWeekdays?.length > 1) {
    draft.pendingWeekdays = parsed.scheduleWeekdays;
    draft.schedulePreset = "weekly";
    draft.scheduleWeekday = null;
    draft.scheduleResolved = false;
    return `I heard ${parsed.scheduleWeekdays.join(" and ")}. I can schedule weekly on one day right now — which should I use?`;
  }
  draft.schedulePreset = parsed.schedulePreset;
  draft.scheduleWeekday = parsed.scheduleWeekday;
  draft.scheduleResolved = true;
  draft.pendingWeekdays = null;
  return null;
}

// Types whose run output can be emailed to the user's own verified address.
// Mirrors EMAIL_CAPABLE_AGENT_TYPES in emailDelivery.js (kept local so this
// module stays pure / dependency-free for unit tests).
const EMAIL_CAPABLE_TYPES = Object.freeze(["finance", "research", "reminders"]);

function applyPendingEmailRequest(draft) {
  if (draft.emailRequested && EMAIL_CAPABLE_TYPES.includes(draft.agentType)) {
    draft.toolAccess = { ...(draft.toolAccess || {}), email: true };
  }
}

function applyEmailSignals(draft, message) {
  const address = extractEmailAddress(message);
  if (address) draft.emailAddress = address;
  if (/\bemail/i.test(message) || address) {
    draft.emailRequested = true;
    applyPendingEmailRequest(draft);
  }
  const time = extractRequestedTime(message);
  if (time) draft.requestedTime = time;
}

/**
 * Merge recognizable signals from a free-form message into the draft.
 * Returns { ackNotes: string[], consumedAsNonSlot: boolean } where
 * consumedAsNonSlot means the message was schedule/email-only and should not
 * fill the current text slot (purpose / data / DoD).
 */
function absorbMessage(draft, message, { asSlot } = {}) {
  const text = String(message || "").trim();
  const ackNotes = [];
  if (!text) return { ackNotes, consumedAsNonSlot: false };

  applyEmailSignals(draft, text);

  // Resolve a pending multi-day choice only when the user names exactly one
  // of the candidate days ("monday and thursday" keeps the question open).
  if (draft.pendingWeekdays?.length) {
    const mentioned = extractWeekdays(text.toLowerCase()).filter((day) =>
      draft.pendingWeekdays.includes(day)
    );
    if (mentioned.length === 1) {
      draft.schedulePreset = "weekly";
      draft.scheduleWeekday = mentioned[0];
      draft.scheduleResolved = true;
      draft.pendingWeekdays = null;
      ackNotes.push(`Scheduled weekly on ${mentioned[0]}.`);
    }
  }

  const scheduleOnly = looksLikeScheduleOrEmailOnly(text);
  const absorbSchedule = shouldAbsorbSchedule(text, asSlot);
  const parsed = absorbSchedule ? parseSchedule(text) : undefined;
  if (parsed !== undefined && !draft.scheduleResolved) {
    const note = applyScheduleParse(draft, parsed);
    if (note) ackNotes.push(note);
    else if (draft.scheduleResolved) {
      ackNotes.push(`Schedule set to ${scheduleLabel(draft)}.`);
    }
  } else if (parsed !== undefined && draft.scheduleResolved && scheduleOnly) {
    // Allow schedule corrections when the user is clearly talking schedule.
    const note = applyScheduleParse(draft, parsed);
    if (note) ackNotes.push(note);
    else ackNotes.push(`Updated schedule to ${scheduleLabel(draft)}.`);
  }

  if (scheduleOnly) {
    return { ackNotes, consumedAsNonSlot: true };
  }

  // Fill the intended text slot when the message has real content for it.
  if (asSlot === "purpose" && !draft.instructions) {
    draft.instructions = text.slice(0, 1500);
  } else if (asSlot === "data" && !draft.dataFocus) {
    draft.dataFocus = text.slice(0, 1500);
  } else if (asSlot === "definition_of_done" && !draft.definitionOfDone) {
    draft.definitionOfDone = text.slice(0, 500);
  } else if (asSlot === "purpose_or_opening" && !draft.instructions) {
    // Opening messages often name the type and the purpose together.
    draft.instructions = text.slice(0, 1500);
  }

  return { ackNotes, consumedAsNonSlot: false };
}

function buildReply(draft, ackNotes, prefix) {
  const missingQ = questionForMissing(draft);
  const lead = [prefix, ackNotes?.length ? ackNotes.join(" ") : null]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!missingQ) {
    const review = renderReview(draft);
    return lead ? `${lead}\n\n${review}` : review;
  }
  if (!lead) return missingQ;
  return `${lead} ${missingQ}`.replace(/\s+/g, " ").trim();
}

/** Starts a fresh creation session: initial state + the CEO's first question. */
export function startCreationSession() {
  return {
    state: { v: 1, status: "active", step: "choose_type", draft: {} },
    reply: `Great — let's set up a new agent. ${STEP_QUESTIONS.choose_type}`,
  };
}

function parseAgentType(message) {
  const lower = message.toLowerCase();
  return CREATABLE_AGENT_TYPES.find((type) => new RegExp(`\\b${type}\\b`).test(lower)) || null;
}

/**
 * Advances an active creation session with the user's message (pure — no
 * database access). Returns:
 *   { state, reply }                    — session continues (or was cancelled)
 *   { state, reply, createPayload }     — user confirmed; the caller must run
 *     the payload through validateAgentCreatePayload + createAgentConfig and
 *     then mark the session completed via completeCreationSession().
 */
export function advanceCreationSession(state, message) {
  const text = String(message || "").trim();
  const next = { ...state, draft: { ...(state.draft || {}) } };
  const draft = next.draft;

  if (matchesCancel(text)) {
    next.status = "cancelled";
    return {
      state: next,
      reply: "No problem — I've discarded that agent draft. Ask me anytime to set up a new one.",
    };
  }

  // Review / confirm is a deliberate gate — don't re-absorb fields here.
  if (state.step === "review" || (!questionForMissing(draft) && draft.definitionOfDone)) {
    next.step = "review";
    if (/\b(confirm|yes|create it|create|go ahead|do it|looks good)\b/i.test(text)) {
      return {
        state: next,
        reply: null,
        createPayload: {
          agentType: draft.agentType,
          name: draft.name,
          instructions: composedInstructions(draft),
          definitionOfDone: draft.definitionOfDone,
          schedulePreset: draft.schedulePreset ?? null,
          scheduleWeekday: draft.scheduleWeekday ?? null,
          toolAccess: draft.toolAccess ?? null,
        },
      };
    }
    if (/\b(no|discard)\b/i.test(text)) {
      next.status = "cancelled";
      return {
        state: next,
        reply: "Okay, I've discarded that draft. Ask me anytime to set up a new agent.",
      };
    }
    return {
      state: next,
      reply: renderReview(draft),
    };
  }

  let prefix = null;

  if (!draft.agentType) {
    const agentType = parseAgentType(text);
    if (!agentType) {
      // Still capture email/time intent so it isn't lost while the type is
      // being clarified (applied once a type is chosen).
      applyEmailSignals(draft, text);
      return {
        state: next,
        reply: `I didn't catch a valid agent type. ${STEP_QUESTIONS.choose_type}`,
      };
    }
    draft.agentType = agentType;
    draft.name = `${TYPE_LABELS[agentType]} Agent`;
    prefix = `A ${TYPE_LABELS[agentType]} agent it is.`;
    // Email may have been requested before the type was known.
    applyPendingEmailRequest(draft);
    // Same message may also carry purpose / schedule / email.
    const { ackNotes } = absorbMessage(draft, text, { asSlot: "purpose_or_opening" });
    next.step = stepForDraft(draft);
    if (!questionForMissing(draft)) {
      return { state: next, reply: buildReply(draft, ackNotes, prefix) };
    }
    // If the opening was only "I want a research agent", don't keep that as purpose.
    if (
      draft.instructions &&
      looksLikeTypeOnlyPurpose(draft.instructions, agentType)
    ) {
      draft.instructions = undefined;
      next.step = stepForDraft(draft);
    }
    return { state: next, reply: buildReply(draft, ackNotes, prefix) };
  }

  // Determine which text slot (if any) this turn is trying to fill.
  // Keep this aligned with stepForDraft / questionForMissing priority.
  let asSlot = null;
  if (!draft.instructions) asSlot = "purpose";
  else if (draft.pendingWeekdays?.length || (draft.dataFocus && !draft.scheduleResolved)) {
    asSlot = null; // schedule / weekday disambiguation
  } else if (!draft.dataFocus) asSlot = "data";
  else if (!draft.definitionOfDone) asSlot = "definition_of_done";

  if (!text) {
    next.step = stepForDraft(draft);
    return { state: next, reply: questionForMissing(draft) || renderReview(draft) };
  }

  const beforeSchedule = draft.scheduleResolved;
  const { ackNotes, consumedAsNonSlot } = absorbMessage(draft, text, { asSlot });

  if (consumedAsNonSlot) {
    // User answered with schedule/email while we were asking for purpose/data/DoD.
    if (asSlot === "definition_of_done") {
      ackNotes.push("I'll need a definition of done in a measurable sentence — not the delivery time.");
    } else if (asSlot === "data" && !draft.dataFocus) {
      ackNotes.push("Thanks — still need the data/area focus.");
    } else if (asSlot === "purpose" && !draft.instructions) {
      ackNotes.push("Thanks — still need the purpose.");
    }
    if (draft.requestedTime && beforeSchedule === draft.scheduleResolved) {
      // Time alone without a parseable cadence.
      if (!draft.scheduleResolved && !parseSchedule(text)) {
        ackNotes.push(
          `Noted ${draft.requestedTime}, but I still need a cadence (daily / weekly / monthly / on demand). Custom times aren't configurable yet — runs fire at 13:00 UTC.`
        );
      }
    }
    next.step = stepForDraft(draft);
    return { state: next, reply: buildReply(draft, ackNotes, prefix) };
  }

  if (asSlot === "purpose" && draft.instructions) {
    prefix = prefix || "Got it.";
  } else if (asSlot === "data" && draft.dataFocus) {
    prefix = prefix || "Understood.";
  }

  // Schedule step with unparseable input (and not schedule-only email chatter).
  if (
    draft.instructions &&
    draft.dataFocus &&
    !draft.scheduleResolved &&
    !draft.pendingWeekdays?.length &&
    asSlot === null &&
    parseSchedule(text) === undefined &&
    !looksLikeScheduleOrEmailOnly(text)
  ) {
    next.step = "clarify_schedule";
    return {
      state: next,
      reply: `I couldn't parse that schedule. ${SCHEDULE_QUESTION}`,
    };
  }

  next.step = stepForDraft(draft);
  if (next.step === "review") {
    return { state: next, reply: renderReview(draft) };
  }
  return { state: next, reply: buildReply(draft, ackNotes, prefix) };
}

function looksLikeTypeOnlyPurpose(instructions, agentType) {
  const lower = String(instructions || "").toLowerCase().trim();
  // "I want a research agent" / "research agent" — no real purpose content.
  const stripped = lower
    .replace(/\b(i want|i need|i'd like|please|set up|create|make|a|an|the|my|new|agent)\b/g, " ")
    .replace(new RegExp(`\\b${agentType}\\b`, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length < 8;
}

/** Marks a session completed after the agent row was created. */
export function completeCreationSession(state, agent) {
  return {
    ...state,
    status: "completed",
    step: "done",
    createdAgentId: agent.id,
  };
}

export function buildCreationSuccessReply(agent) {
  const parts = [
    `Done — I've created "${agent.name}" (${agent.agentType}). It starts read-only and is active now.`,
    agent.agentType === "email"
      ? "Heads up: email agents cannot run yet in this phase; the configuration is saved for when the runtime ships."
      : "You can trigger a run from its page or let its schedule pick it up.",
  ];
  if (agent.toolAccess?.email === true) {
    parts.push(
      "Each run will also be emailed to your account address once it's verified."
    );
  }
  return parts.join(" ");
}
