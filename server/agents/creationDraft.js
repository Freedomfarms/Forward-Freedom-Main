import { DEFAULT_AGENT_MODEL } from "./models.js";
import { CREATABLE_AGENT_TYPES } from "./registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Structured draft for "+ New Agent" conversational intake (Slice 1).
// Interview topics are asked through first; the draft/review UI only opens
// after every topic is covered or the user skips the rest. Schedule / model /
// trust pickers land in a later slice — defaults: on-demand + Sonnet.
// ─────────────────────────────────────────────────────────────────────────────

export const CREATION_PHASES = Object.freeze(["aim", "interview", "review"]);

/** Topics the CEO should cover before opening the draft review. */
export const INTERVIEW_TOPICS = Object.freeze([
  "outcome",
  "actors",
  "boundaries",
  "history",
  "tone",
  "escalation",
]);

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
  "actorsNotes",
  "escalationNotes",
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
    actorsNotes: null,
    escalationNotes: null,
    coveredTopics: [],
    interviewComplete: false,
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

function mergeCoveredTopics(prior, next) {
  const merged = [
    ...new Set(
      [...(Array.isArray(prior) ? prior : []), ...(Array.isArray(next) ? next : [])]
        .map((item) => String(item || "").trim().toLowerCase())
        .filter((item) => INTERVIEW_TOPICS.includes(item))
    ),
  ];
  return merged;
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
    next[key] = trimTo(patch[key], max);
  }

  if ("coveredTopics" in patch && patch.coveredTopics != null) {
    next.coveredTopics = mergeCoveredTopics(next.coveredTopics, patch.coveredTopics);
  }

  if (typeof patch.interviewComplete === "boolean") {
    next.interviewComplete = patch.interviewComplete;
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

  // Auto-cover topics when the corresponding field was filled.
  const inferred = [];
  if (next.definitionOfDone) inferred.push("outcome");
  if (next.actorsNotes) inferred.push("actors");
  if (next.boundaries) inferred.push("boundaries");
  if (next.workingFromNotes != null && String(next.workingFromNotes).trim() !== "") {
    inferred.push("history");
  }
  if (next.personalityNotes) inferred.push("tone");
  if (next.escalationNotes) inferred.push("escalation");
  next.coveredTopics = mergeCoveredTopics(next.coveredTopics, inferred);

  if (!next.name && next.agentType) {
    next.name = `${TYPE_LABELS[next.agentType]} Agent`;
  }

  if (!next.interviewComplete && isInterviewTopicsComplete(next)) {
    next.interviewComplete = true;
  }

  return next;
}

export function isInterviewTopicsComplete(draft) {
  const covered = new Set(draft?.coveredTopics || []);
  return INTERVIEW_TOPICS.every((topic) => covered.has(topic));
}

export function isInterviewComplete(draft) {
  return Boolean(draft?.interviewComplete) || isInterviewTopicsComplete(draft);
}

export function remainingInterviewTopics(draft) {
  const covered = new Set(draft?.coveredTopics || []);
  return INTERVIEW_TOPICS.filter((topic) => !covered.has(topic));
}

/**
 * Mark remaining interview topics covered via guesses so review can open.
 * Fills thin defaults only where a field is still empty.
 */
export function completeInterviewWithGuesses(draft) {
  const next = applyDraftPatch(draft, {});
  const remaining = remainingInterviewTopics(next);
  const patch = {
    coveredTopics: INTERVIEW_TOPICS.slice(),
    interviewComplete: true,
    guessedFields: remaining.slice(),
  };

  if (!next.actorsNotes && remaining.includes("actors")) {
    patch.actorsNotes = "Acts on behalf of the user within this scoped job.";
  }
  if (!next.boundaries && remaining.includes("boundaries")) {
    patch.boundaries =
      "Never move money\nNever send anything externally without asking\nNever delete data";
  }
  if (
    (next.workingFromNotes == null || !String(next.workingFromNotes).trim()) &&
    remaining.includes("history")
  ) {
    patch.workingFromNotes = "No prior history provided — starting fresh.";
  }
  if (!next.personalityNotes && remaining.includes("tone")) {
    patch.personalityNotes = "Clear\nPractical\nConcise";
  }
  if (!next.escalationNotes && remaining.includes("escalation")) {
    patch.escalationNotes = "Flag the user only for urgent or ambiguous issues.";
  }
  if (!next.agentType) {
    patch.agentType = "research";
    patch.guessedFields = [...(patch.guessedFields || []), "agentType"];
  }
  if (!next.roleLine && next.definitionOfDone) {
    patch.roleLine = String(next.definitionOfDone).trim().slice(0, 80);
  }
  if (!next.instructions && next.definitionOfDone) {
    patch.instructions = String(next.definitionOfDone).trim();
  }

  return applyDraftPatch(next, patch);
}

export function isDraftReadyForReview(draft) {
  const d = draft || {};
  return Boolean(
    isInterviewComplete(d) &&
      d.definitionOfDone &&
      String(d.definitionOfDone).trim() &&
      d.agentType &&
      (d.instructions || d.roleLine || d.definitionOfDone)
  );
}

/**
 * Phase rules: never open review until the interview is complete (all topics
 * covered or user skipped the rest). Having draft fields filled early must
 * NOT jump to review mid-interview.
 */
export function normalizeCreationPhase(phase, draft) {
  if (phase === "review") {
    if (isDraftReadyForReview(draft)) return "review";
    return draft?.definitionOfDone ? "interview" : "aim";
  }
  if (phase === "interview") {
    if (isDraftReadyForReview(draft)) return "review";
    return "interview";
  }
  if (phase === "aim") {
    if (draft?.definitionOfDone && String(draft.definitionOfDone).trim()) {
      return isDraftReadyForReview(draft) ? "review" : "interview";
    }
    return "aim";
  }
  if (isDraftReadyForReview(draft)) return "review";
  if (draft?.definitionOfDone) return "interview";
  return "aim";
}

/** Client-safe draft snapshot for the draft panel (shown only in review). */
export function publicCreationDraft(state) {
  const draft = state?.draft || emptyCreationDraft();
  const phase = normalizeCreationPhase(state?.phase, draft);
  return {
    phase,
    readyForReview: isDraftReadyForReview(draft),
    interviewComplete: isInterviewComplete(draft),
    coveredTopics: Array.isArray(draft.coveredTopics) ? draft.coveredTopics : [],
    remainingTopics: remainingInterviewTopics(draft),
    agentType: draft.agentType || null,
    name: draft.name || null,
    roleLine: draft.roleLine || null,
    definitionOfDone: draft.definitionOfDone || null,
    instructions: draft.instructions || null,
    personalityNotes: draft.personalityNotes || null,
    boundaries: draft.boundaries || null,
    workingFromNotes: draft.workingFromNotes || null,
    actorsNotes: draft.actorsNotes || null,
    escalationNotes: draft.escalationNotes || null,
    guessedFields: Array.isArray(draft.guessedFields) ? draft.guessedFields : [],
  };
}

function composedInstructions(draft) {
  const parts = [];
  const role = String(draft.roleLine || "").trim();
  const purpose = String(draft.instructions || "").trim();
  const dataFocus = String(draft.dataFocus || "").trim();
  const actors = String(draft.actorsNotes || "").trim();
  const escalation = String(draft.escalationNotes || "").trim();
  if (role) parts.push(role);
  if (purpose && purpose !== role) parts.push(purpose);
  if (dataFocus) parts.push(`Data focus: ${dataFocus}`);
  if (actors) parts.push(`Acts with/for: ${actors}`);
  if (escalation) parts.push(`Escalation: ${escalation}`);
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

/** User wants to skip remaining interview questions and go to the draft. */
export function matchesCreationSkip(message) {
  return /\b(skip(?:\s+(?:the\s+rest|remaining|this|ahead))?|that's enough|thats enough|move on|just draft(?:\s+it)?|draft it|good enough|no more questions|finish(?:\s+up)?)\b/i.test(
    String(message || "")
  );
}

export { TYPE_LABELS };
