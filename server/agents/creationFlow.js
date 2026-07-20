import { CREATABLE_AGENT_TYPES } from "./registry.js";
import { WEEKDAY_NAMES } from "./schedule.js";

// ─────────────────────────────────────────────────────────────────────────────
// "+ New Agent" creation via CEO chat: a deterministic multi-turn state
// machine (no LLM call, no new table). The state lives as a hidden message in
// the user's encrypted CEO chat thread — an AGENT-role AgentChatMessage whose
// content starts with CREATION_STATE_SENTINEL. The chat transcript renderer
// filters those rows out, so state never reaches a prompt or the client.
//
// Steps: choose_type → clarify_purpose → clarify_data → clarify_schedule →
// definition_of_done → review → (confirm creates the agent).
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
  clarify_data: "What data or area should it pay attention to? (For a reminders agent, mention email if you also want the reminder emailed to your account address.)",
  clarify_schedule: SCHEDULE_QUESTION,
  definition_of_done: "Last question: give me one specific, measurable sentence that defines success for this agent (its definition of done).",
});

function matchesCancel(message) {
  return /\b(cancel|nevermind|never mind|abort|forget it)\b/i.test(message);
}

function renderReview(draft) {
  const scheduleLabel = draft.schedulePreset
    ? draft.schedulePreset === "weekly"
      ? `weekly (${draft.scheduleWeekday || "monday"})`
      : draft.schedulePreset
    : "on demand only";
  const lines = [
    "Here's the agent I'll create:",
    `- Type: ${TYPE_LABELS[draft.agentType] || draft.agentType}`,
    `- Name: ${draft.name}`,
    `- Focus: ${draft.instructions}`,
    `- Schedule: ${scheduleLabel}`,
    `- Definition of done: ${draft.definitionOfDone}`,
    "- Permissions: read-only (all new agents start read-only)",
  ];
  if (draft.agentType === "email") {
    lines.push(
      "- Note: the email agent type can be configured now but cannot run yet — its runtime is not available in this phase."
    );
  }
  if (draft.toolAccess?.email) {
    lines.push("- Email delivery: reminders will also be emailed to your own account address.");
  }
  lines.push('Reply "confirm" to create it, or "cancel" to discard.');
  return lines.join("\n");
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

function parseSchedule(message) {
  const lower = message.toLowerCase();
  if (/\b(on.?demand|manual(ly)?|none|no schedule|only when i ask)\b/.test(lower)) {
    return { schedulePreset: null, scheduleWeekday: null };
  }
  if (/\b(daily|every ?day)\b/.test(lower)) {
    return { schedulePreset: "daily", scheduleWeekday: null };
  }
  if (/\bmonthly\b/.test(lower)) {
    return { schedulePreset: "monthly", scheduleWeekday: null };
  }
  if (/\b(weekly|every ?week)\b/.test(lower)) {
    const weekday = WEEKDAY_NAMES.find((name) => lower.includes(name)) || null;
    return { schedulePreset: "weekly", scheduleWeekday: weekday };
  }
  return undefined;
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

  if (matchesCancel(text)) {
    next.status = "cancelled";
    return {
      state: next,
      reply: "No problem — I've discarded that agent draft. Ask me anytime to set up a new one.",
    };
  }

  switch (state.step) {
    case "choose_type": {
      const agentType = parseAgentType(text);
      if (!agentType) {
        return {
          state: next,
          reply: `I didn't catch a valid agent type. ${STEP_QUESTIONS.choose_type}`,
        };
      }
      next.draft.agentType = agentType;
      next.draft.name = `${TYPE_LABELS[agentType]} Agent`;
      next.step = "clarify_purpose";
      return {
        state: next,
        reply: `A ${TYPE_LABELS[agentType]} agent it is. ${STEP_QUESTIONS.clarify_purpose}`,
      };
    }

    case "clarify_purpose": {
      if (!text) return { state: next, reply: STEP_QUESTIONS.clarify_purpose };
      next.draft.instructions = text.slice(0, 1500);
      next.step = "clarify_data";
      return { state: next, reply: `Got it. ${STEP_QUESTIONS.clarify_data}` };
    }

    case "clarify_data": {
      if (!text) return { state: next, reply: STEP_QUESTIONS.clarify_data };
      next.draft.instructions = `${next.draft.instructions}\nData focus: ${text}`.slice(0, 2000);
      if (next.draft.agentType === "reminders" && /\bemail\b/i.test(text)) {
        next.draft.toolAccess = { email: true };
      }
      next.step = "clarify_schedule";
      return { state: next, reply: `Understood. ${SCHEDULE_QUESTION}` };
    }

    case "clarify_schedule": {
      const parsed = parseSchedule(text);
      if (parsed === undefined) {
        return { state: next, reply: `I couldn't parse that schedule. ${SCHEDULE_QUESTION}` };
      }
      next.draft.schedulePreset = parsed.schedulePreset;
      next.draft.scheduleWeekday = parsed.scheduleWeekday;
      next.step = "definition_of_done";
      return { state: next, reply: STEP_QUESTIONS.definition_of_done };
    }

    case "definition_of_done": {
      if (!text) return { state: next, reply: STEP_QUESTIONS.definition_of_done };
      next.draft.definitionOfDone = text.slice(0, 500);
      next.step = "review";
      return { state: next, reply: renderReview(next.draft) };
    }

    case "review": {
      if (/\b(confirm|yes|create it|create|go ahead|do it|looks good)\b/i.test(text)) {
        return {
          state: next,
          reply: null,
          createPayload: {
            agentType: next.draft.agentType,
            name: next.draft.name,
            instructions: next.draft.instructions,
            definitionOfDone: next.draft.definitionOfDone,
            schedulePreset: next.draft.schedulePreset ?? null,
            scheduleWeekday: next.draft.scheduleWeekday ?? null,
            toolAccess: next.draft.toolAccess ?? null,
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
        reply: `${renderReview(next.draft)}`,
      };
    }

    default: {
      // Unknown step (e.g. state written by newer code) — fail closed by
      // cancelling the session instead of guessing.
      next.status = "cancelled";
      return {
        state: next,
        reply: "Something went wrong with that agent draft, so I've discarded it. Ask me to start again.",
      };
    }
  }
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
  return [
    `Done — I've created "${agent.name}" (${agent.agentType}). It starts read-only and is active now.`,
    agent.agentType === "email"
      ? "Heads up: email agents cannot run yet in this phase; the configuration is saved for when the runtime ships."
      : "You can trigger a run from its page or let its schedule pick it up.",
  ].join(" ");
}
