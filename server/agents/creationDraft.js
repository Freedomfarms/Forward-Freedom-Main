import { DEFAULT_AGENT_MODEL } from "./models.js";
import { CREATABLE_AGENT_TYPES } from "./registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// DEPRECATED draft helpers for the retired create_agent interview path.
// Live CEO reasoning uses `server/agents/ceoReasoning.js` + Brain tools.
// INTERVIEW_TOPICS / remainingInterviewTopics are legacy — do not drive CEO Q&A.
// ─────────────────────────────────────────────────────────────────────────────

export const CREATION_PHASES = Object.freeze(["aim", "interview", "review"]);

/**
 * @deprecated Kept for publicCreationDraft / older session rows. Completeness
 * is no longer "all topics covered" — use missionExecutable instead.
 */
export const INTERVIEW_TOPICS = Object.freeze([
  "outcome",
  "actors",
  "boundaries",
  "history",
  "tone",
  "escalation",
]);

/** Commit tentative agentType onto the draft only at/above this confidence. */
export const AGENT_TYPE_COMMIT_CONFIDENCE = 0.75;

export const AIM_OPENER =
  "What should this agent own for you — the outcome that means it's working?\n\n" +
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
  "mission",
  "nextQuestionFocus",
]);

function trimTo(value, max) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.slice(0, max);
}

function normalizeStringList(value, { max = 20, maxLen = 240 } = {}) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .map((item) => item.slice(0, maxLen))
    ),
  ].slice(0, max);
}

function normalizeAssumptions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const text = String(item.text || item.fact || "").trim().slice(0, 240);
      if (!text) return null;
      let confidence = Number(item.confidence);
      if (!Number.isFinite(confidence)) confidence = 0.3;
      confidence = Math.max(0, Math.min(1, confidence));
      return { text, confidence };
    })
    .filter(Boolean)
    .slice(0, 20);
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
    // Mission-driven knowledge model (executive intake).
    mission: null,
    knownFacts: [],
    missingFacts: [],
    assumptions: [],
    tentativeAgentType: null,
    agentTypeConfidence: 0,
    blockingGaps: [],
    nextQuestionFocus: null,
    missionExecutable: false,
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
      next.tentativeAgentType = type;
      if (!next.name) next.name = `${TYPE_LABELS[type]} Agent`;
    }
  }

  if ("tentativeAgentType" in patch && patch.tentativeAgentType != null) {
    const type = String(patch.tentativeAgentType).trim().toLowerCase();
    if (CREATABLE_AGENT_TYPES.includes(type)) {
      next.tentativeAgentType = type;
    }
  } else if ("tentativeAgentType" in patch && patch.tentativeAgentType === null) {
    next.tentativeAgentType = null;
  }

  if ("agentTypeConfidence" in patch && patch.agentTypeConfidence != null) {
    const confidence = Number(patch.agentTypeConfidence);
    if (Number.isFinite(confidence)) {
      next.agentTypeConfidence = Math.max(0, Math.min(1, confidence));
    }
  }

  for (const key of STRING_FIELDS) {
    if (!(key in patch) || patch[key] == null) continue;
    const max =
      key === "definitionOfDone" || key === "mission"
        ? 500
        : key === "name" || key === "roleLine" || key === "nextQuestionFocus"
          ? 120
          : 2000;
    next[key] = trimTo(patch[key], max);
  }

  if ("knownFacts" in patch && patch.knownFacts != null) {
    next.knownFacts = normalizeStringList(patch.knownFacts);
  }
  if ("missingFacts" in patch && patch.missingFacts != null) {
    next.missingFacts = normalizeStringList(patch.missingFacts);
  }
  if ("blockingGaps" in patch && patch.blockingGaps != null) {
    next.blockingGaps = normalizeStringList(patch.blockingGaps);
  }
  if ("assumptions" in patch && patch.assumptions != null) {
    next.assumptions = normalizeAssumptions(patch.assumptions);
  }

  if ("coveredTopics" in patch && patch.coveredTopics != null) {
    next.coveredTopics = mergeCoveredTopics(next.coveredTopics, patch.coveredTopics);
  }

  if (typeof patch.interviewComplete === "boolean") {
    next.interviewComplete = patch.interviewComplete;
  }
  if (typeof patch.missionExecutable === "boolean") {
    next.missionExecutable = patch.missionExecutable;
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

  // Soft topic tags for older UI — do NOT auto-complete the interview from these.
  const inferred = [];
  if (next.definitionOfDone || next.mission) inferred.push("outcome");
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

  // Mission text doubles as definitionOfDone when the user stated an outcome.
  if (!next.definitionOfDone && next.mission) {
    next.definitionOfDone = next.mission;
  }
  if (!next.mission && next.definitionOfDone) {
    next.mission = next.definitionOfDone;
  }

  // Only treat the mission as executable when we still have a committed type
  // and outcome — never from topic coverage alone.
  if (next.missionExecutable && !hasExecutableCore(next)) {
    next.missionExecutable = false;
  }

  return next;
}

function hasExecutableCore(draft) {
  const outcome = String(draft?.definitionOfDone || draft?.mission || "").trim();
  return Boolean(outcome && draft?.agentType);
}

export function isInterviewTopicsComplete(draft) {
  // Legacy helper — mission intake no longer requires the six-topic checklist.
  return isMissionExecutable(draft);
}

/** True when intake has enough to execute — not when every preference is filled. */
export function isMissionExecutable(draft) {
  if (!draft) return false;
  if (draft.interviewComplete && hasExecutableCore(draft)) return true;
  if (!draft.missionExecutable) return false;
  return hasExecutableCore(draft);
}

export function isInterviewComplete(draft) {
  return isMissionExecutable(draft);
}

export function remainingInterviewTopics(draft) {
  // Prefer live blocking gaps from the knowledge model.
  const gaps = Array.isArray(draft?.blockingGaps) ? draft.blockingGaps : [];
  if (gaps.length) return gaps.slice(0, 6);
  const covered = new Set(draft?.coveredTopics || []);
  return INTERVIEW_TOPICS.filter((topic) => !covered.has(topic));
}

/**
 * User asked to skip — fill only the minimum required to create a payload.
 * Do NOT invent personality, boundaries, escalation, or history as facts.
 */
export function completeInterviewWithGuesses(draft) {
  const next = applyDraftPatch(draft, {});
  const guessed = [];
  const patch = {
    interviewComplete: true,
    missionExecutable: true,
    blockingGaps: [],
    missingFacts: [],
  };

  const type =
    next.agentType ||
    (CREATABLE_AGENT_TYPES.includes(next.tentativeAgentType) ? next.tentativeAgentType : null) ||
    "research";
  if (!next.agentType) {
    patch.agentType = type;
    guessed.push("agentType");
  }
  if (!next.tentativeAgentType) {
    patch.tentativeAgentType = type;
  }
  if (!(next.agentTypeConfidence >= AGENT_TYPE_COMMIT_CONFIDENCE)) {
    patch.agentTypeConfidence = AGENT_TYPE_COMMIT_CONFIDENCE;
  }

  const outcome = String(next.definitionOfDone || next.mission || "").trim();
  if (outcome) {
    if (!next.mission) patch.mission = outcome;
    if (!next.definitionOfDone) patch.definitionOfDone = outcome;
    if (!next.roleLine) {
      patch.roleLine = outcome.slice(0, 80);
      guessed.push("roleLine");
    }
    if (!next.instructions) {
      patch.instructions = outcome;
      guessed.push("instructions");
    }
  }

  patch.guessedFields = guessed;
  return applyDraftPatch(next, patch);
}

export function isDraftReadyForReview(draft) {
  const d = draft || {};
  return Boolean(
    isMissionExecutable(d) &&
      (d.definitionOfDone || d.mission) &&
      String(d.definitionOfDone || d.mission || "").trim() &&
      d.agentType &&
      (d.instructions || d.roleLine || d.definitionOfDone || d.mission)
  );
}

/**
 * Phase rules: never open review until the mission is executable (or skipped).
 * Having a few fields filled must NOT jump to review mid-intake.
 */
export function normalizeCreationPhase(phase, draft) {
  if (phase === "review") {
    if (isDraftReadyForReview(draft)) return "review";
    return draft?.definitionOfDone || draft?.mission ? "interview" : "aim";
  }
  if (phase === "interview") {
    if (isDraftReadyForReview(draft)) return "review";
    return "interview";
  }
  if (phase === "aim") {
    if (draft?.definitionOfDone || draft?.mission) {
      return isDraftReadyForReview(draft) ? "review" : "interview";
    }
    return "aim";
  }
  if (isDraftReadyForReview(draft)) return "review";
  if (draft?.definitionOfDone || draft?.mission) return "interview";
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
    missionExecutable: isMissionExecutable(draft),
    coveredTopics: Array.isArray(draft.coveredTopics) ? draft.coveredTopics : [],
    remainingTopics: remainingInterviewTopics(draft),
    mission: draft.mission || null,
    knownFacts: Array.isArray(draft.knownFacts) ? draft.knownFacts : [],
    missingFacts: Array.isArray(draft.missingFacts) ? draft.missingFacts : [],
    blockingGaps: Array.isArray(draft.blockingGaps) ? draft.blockingGaps : [],
    assumptions: Array.isArray(draft.assumptions) ? draft.assumptions : [],
    tentativeAgentType: draft.tentativeAgentType || null,
    agentTypeConfidence: draft.agentTypeConfidence || 0,
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
  const known = Array.isArray(draft.knownFacts) ? draft.knownFacts.filter(Boolean) : [];
  if (role) parts.push(role);
  if (purpose && purpose !== role) parts.push(purpose);
  if (dataFocus) parts.push(`Data focus: ${dataFocus}`);
  if (actors) parts.push(`Acts with/for: ${actors}`);
  if (escalation) parts.push(`Escalation: ${escalation}`);
  if (known.length) parts.push(`Confirmed facts:\n- ${known.join("\n- ")}`);
  if (!parts.length && (draft.definitionOfDone || draft.mission)) {
    parts.push(String(draft.definitionOfDone || draft.mission).trim());
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
  const definitionOfDone = String(draft.definitionOfDone || draft.mission || "").trim();
  if (!definitionOfDone) return null;

  return {
    agentType,
    name: name.slice(0, 80),
    instructions: composedInstructions(draft) || definitionOfDone.slice(0, 2000),
    definitionOfDone: definitionOfDone.slice(0, 500),
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

/**
 * User wants to stop gathering gaps and go to the draft.
 */
export function matchesCreationSkip(message) {
  const text = String(message || "").trim();
  if (!text) return false;
  if (
    /\b(skip(?:\s+(?:the\s+rest|remaining|this|ahead))?|that's enough|thats enough|move on|just draft(?:\s+it)?|draft it|good enough|no more questions|finish(?:\s+up)?|stop asking|enough questions)\b/i.test(
      text
    )
  ) {
    return true;
  }
  if (text.length > 80) return false;
  return /^(idk|i don'?t know|not sure|whatever|you decide|up to you|don'?t care|i don'?t care|doesn'?t matter|no preference|just (?:make|build|create) (?:one|it)|surprise me)[.!?]*$/i.test(
    text
  );
}

export { TYPE_LABELS };
