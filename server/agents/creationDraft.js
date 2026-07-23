import { DEFAULT_AGENT_MODEL } from "./models.js";
import { CREATABLE_AGENT_TYPES } from "./registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Structured draft for "+ New Agent" conversational intake (Slice 1).
// Schedule / model / trust pickers land in a later slice — defaults here are
// on-demand + Sonnet so confirm can create without asking those yet.
// ─────────────────────────────────────────────────────────────────────────────

export const CREATION_PHASES = Object.freeze(["aim", "interview", "review"]);

export const AIM_OPENER =
  "What's the one outcome this agent is responsible for? Not the steps — the result.\n\n" +
  'For example: "Every morning my inbox is empty, replies are drafted in my voice, and anything urgent is flagged."';

const TYPE_LABELS = Object.freeze({
  finance: "Finance",
  research: "Research",
  reminders: "Reminders",
  email: "Email",
});

const STRING_FIELDS = Object.freeze([
  "name",
  "roleLine",
  "instructions",
  "definitionOfDone",
  "personalityNotes",
  "boundaries",
  "workingFromNotes",
  "dataFocus",
]);

function trimTo(value, max) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.slice(0, max);
}

export function emptyCreationDraft() {
  return {
    agentType: null,
    name: null,
    roleLine: null,
    instructions: null,
    definitionOfDone: null,
    personalityNotes: null,
    boundaries: null,
    workingFromNotes: null,
    dataFocus: null,
    guessedFields: [],
    // Slice 2 will ask; Slice 1 defaults.
    model: DEFAULT_AGENT_MODEL,
    schedulePreset: null,
    scheduleWeekday: null,
    scheduleWeekdays: null,
    scheduleHourUtc: null,
    toolAccess: null,
  };
}

/**
 * Merge a model (or test) patch into the draft. Empty strings clear a field;
 * null/undefined leave it unchanged. agentType must be creatable.
 */
export function applyDraftPatch(draft, patch) {
  const next = { ...emptyCreationDraft(), ...(draft || {}) };
  if (!patch || typeof patch !== "object") return next;

  if ("agentType" in patch && patch.agentType != null) {
    const type = String(patch.agentType).trim().toLowerCase();
    if (CREATABLE_AGENT_TYPES.includes(type)) {
      next.agentType = type;
      if (!next.name) next.name = `${TYPE_LABELS[type]} Agent`;
    }
  }

  for (const key of STRING_FIELDS) {
    if (!(key in patch) || patch[key] == null) continue;
    const max =
      key === "definitionOfDone" ? 500 : key === "name" || key === "roleLine" ? 80 : 2000;
    const trimmed = trimTo(patch[key], max);
    // Allow explicit clear with "".
    next[key] = trimmed;
  }

  if (Array.isArray(patch.guessedFields)) {
    const prior = Array.isArray(next.guessedFields) ? next.guessedFields : [];
    next.guessedFields = [
      ...new Set(
        [...prior, ...patch.guessedFields]
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      ),
    ].slice(0, 20);
  }

  if (!next.name && next.agentType) {
    next.name = `${TYPE_LABELS[next.agentType]} Agent`;
  }
  return next;
}

export function isDraftReadyForReview(draft) {
  const d = draft || {};
  return Boolean(
    d.definitionOfDone &&
      String(d.definitionOfDone).trim() &&
      d.agentType &&
      (d.instructions || d.roleLine || d.definitionOfDone)
  );
}

export function normalizeCreationPhase(phase, draft) {
  if (phase === "review" && isDraftReadyForReview(draft)) return "review";
  if (phase === "interview") return "interview";
  if (phase === "aim") {
    // Once we have a measurable outcome, move into interview even if the model
    // forgot to bump the phase.
    if (draft?.definitionOfDone && String(draft.definitionOfDone).trim()) {
      return "interview";
    }
    return "aim";
  }
  if (isDraftReadyForReview(draft)) return "review";
  if (draft?.definitionOfDone) return "interview";
  return "aim";
}

/** Client-safe draft snapshot for the live "draft so far" panel. */
export function publicCreationDraft(state) {
  const draft = state?.draft || emptyCreationDraft();
  const phase = normalizeCreationPhase(state?.phase, draft);
  return {
    phase,
    readyForReview: isDraftReadyForReview(draft),
    agentType: draft.agentType || null,
    name: draft.name || null,
    roleLine: draft.roleLine || null,
    definitionOfDone: draft.definitionOfDone || null,
    instructions: draft.instructions || null,
    personalityNotes: draft.personalityNotes || null,
    boundaries: draft.boundaries || null,
    workingFromNotes: draft.workingFromNotes || null,
    guessedFields: Array.isArray(draft.guessedFields) ? draft.guessedFields : [],
  };
}

function composedInstructions(draft) {
  const parts = [];
  const role = String(draft.roleLine || "").trim();
  const purpose = String(draft.instructions || "").trim();
  const dataFocus = String(draft.dataFocus || "").trim();
  if (role) parts.push(role);
  if (purpose && purpose !== role) parts.push(purpose);
  if (dataFocus) parts.push(`Data focus: ${dataFocus}`);
  if (!parts.length && draft.definitionOfDone) {
    parts.push(String(draft.definitionOfDone).trim());
  }
  return parts.join("\n").slice(0, 2000);
}

/**
 * Build the payload for validateAgentCreatePayload. Returns null when the
 * draft is not complete enough to create (caller should keep interviewing).
 */
export function buildCreatePayloadFromDraft(draft) {
  if (!isDraftReadyForReview(draft)) return null;
  const agentType = draft.agentType;
  const name =
    String(draft.name || "").trim() ||
    (agentType ? `${TYPE_LABELS[agentType]} Agent` : null);
  if (!agentType || !name) return null;

  return {
    agentType,
    name: name.slice(0, 80),
    instructions: composedInstructions(draft) || String(draft.definitionOfDone).trim().slice(0, 2000),
    definitionOfDone: String(draft.definitionOfDone).trim().slice(0, 500),
    personalityNotes: trimTo(draft.personalityNotes, 2000),
    boundaries: trimTo(draft.boundaries, 2000),
    workingFromNotes: trimTo(draft.workingFromNotes, 2000),
    schedulePreset: draft.schedulePreset ?? null,
    scheduleWeekday: draft.scheduleWeekday ?? null,
    scheduleWeekdays: draft.scheduleWeekdays ?? null,
    scheduleHourUtc: draft.scheduleHourUtc ?? null,
    toolAccess: draft.toolAccess ?? null,
    model: draft.model || DEFAULT_AGENT_MODEL,
  };
}

export function matchesCreationCancel(message) {
  return /\b(cancel|nevermind|never mind|abort|forget it|start over)\b/i.test(
    String(message || "")
  );
}

export function matchesCreationConfirm(message) {
  return /\b(confirm|yes|create it|create|go ahead|do it|looks good|lock it in|ship it)\b/i.test(
    String(message || "")
  );
}

export function matchesCreationEditRequest(message) {
  return /\b(edit|change|update|tweak|fix|revise|let me edit|not quite|wrong)\b/i.test(
    String(message || "")
  );
}

export { TYPE_LABELS };
