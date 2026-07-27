import { jsonSchema } from "ai";

import {
  AGENT_TYPE_COMMIT_CONFIDENCE,
  AIM_OPENER,
  applyDraftPatch,
  buildCreatePayloadFromDraft,
  completeInterviewWithGuesses,
  emptyCreationDraft,
  INTERVIEW_TOPICS,
  isDraftReadyForReview,
  isInterviewComplete,
  isMissionExecutable,
  matchesCreationCancel,
  matchesCreationConfirm,
  matchesCreationEditRequest,
  matchesCreationSkip,
  normalizeCreationPhase,
  publicCreationDraft,
  remainingInterviewTopics,
} from "./creationDraft.js";
import {
  CEO_AGENT_MODEL,
  generateAgentObject,
  generateAgentText,
  PROFILE_EXTRACTION_MODEL,
} from "./llm.js";
import { CHAT_PLAIN_TEXT_RULE, dataSection, PROMPT_SAFETY_RULES } from "./prompts.js";
import { CREATABLE_AGENT_TYPES } from "./registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Mission-driven "+ New Agent" intake (executive reasoning):
// Situation Brief → Mission → Knowledge Model → Gap Analysis → Relevance →
// ask ONE blocking question. Stop when the mission is executable — not when a
// preference checklist is full. Optional fields (tone, escalation, history)
// are never asked before execution blockers.
// Intake turns use ONE text call + trailing NOTES_JSON (no structured-output
// grammar — those timed out Anthropic compilation). Skip/review still uses
// Sonnet text + a lean Haiku extract.
// ─────────────────────────────────────────────────────────────────────────────

const INTERVIEW_NOTES_MARKER = "NOTES_JSON:";

const MISSION_REASONING_RULES = [
  "You are the user's CEO Agent inside Freedom OS — an executive that reasons, not a scripted interviewer.",
  "This session creates ONE NEW worker agent. Do not assume continuity with a prior draft or teammate unless the user says so.",
  "Every turn, silently run this pipeline before you reply:",
  "1) Situation Brief — what is happening, what they want, what changed since last message.",
  "2) Mission Extraction — the real mission in outcome terms.",
  "3) Knowledge Model — known facts vs missing facts vs assumptions (confidence-scored). Never present assumptions as facts.",
  "4) Gap Analysis — everything required to EXECUTE the mission (not every preference).",
  "5) Relevance — rank missing info by execution importance. Highest priority = blocks execution.",
  "6) Ask ONLY ONE question — the single highest-value blocking gap. Then stop.",
  "NEVER prioritize personality, tone, escalation, history-to-learn-from, or optional preferences before core execution requirements (who/what to monitor, platforms, deliverable, frequency, recipients, etc.).",
  "NEVER invent agent types, restrictions, behaviors, permissions, workflows, or requirements the user did not state.",
  "If uncertain, ask. Never summarize requirements that were not explicitly confirmed.",
  "Do not classify/commit an agent type unless confidence is high. Keep tentativeAgentType + agentTypeConfidence; only commit agentType when confidence is high.",
  "Stop gathering as soon as the mission is executable. Minimum info for successful execution — not a full preference survey.",
  "A human executive reading the chat should think: it asked exactly the right next question.",
].join("\n");

const INTERVIEW_TURN_SYSTEM_PROMPT = [
  MISSION_REASONING_RULES,
  "This is a FAST intake turn — reply like a sharp executive (1–3 short sentences). Never present or narrate a full draft.",
  "Acknowledge only what they actually said, then ask ONE blocking question.",
  "Never say \"soul file\", \"system prompt\", \"JSON\", \"interview topics\", \"gap analysis\", or \"knowledge model\" in the user-facing reply.",
  CHAT_PLAIN_TEXT_RULE,
  "After the reply, on its OWN final line, output machine notes exactly like:",
  `${INTERVIEW_NOTES_MARKER}{"mission":"user mission in their words","knownFacts":["..."],"missingFacts":["..."],"assumptions":[{"text":"...","confidence":0.4}],"blockingGaps":["people to monitor","platforms"],"nextQuestionFocus":"people to monitor","missionExecutable":false,"tentativeAgentType":"research","agentTypeConfidence":0.55,"draftPatch":{"definitionOfDone":"user outcome words"},"userCancelled":false}`,
  "draftPatch may ONLY include fields the user explicitly confirmed this turn. Do not invent boundaries, personality, escalation, or agentType in draftPatch unless they said so.",
  `tentativeAgentType one of: ${CREATABLE_AGENT_TYPES.join(", ")} (or omit). agentTypeConfidence 0–1.`,
  "Set missionExecutable true ONLY when blockingGaps is empty and the mission can run with confirmed facts.",
  "Safety rules:",
  `- ${PROMPT_SAFETY_RULES}`,
].join("\n");

/** Patch fields the skip/review extractor may return (optional strings — no null unions). */
const DRAFT_PATCH_FIELDS = {
  agentType: {
    type: "string",
    description: `One of: ${CREATABLE_AGENT_TYPES.join(", ")}. Only when confidence is high from explicit user intent.`,
  },
  name: { type: "string" },
  roleLine: {
    type: "string",
    description: "One-line name & role for the draft review.",
  },
  instructions: {
    type: "string",
    description: "How the agent should do the job — only from confirmed facts.",
  },
  definitionOfDone: {
    type: "string",
    description: "Measurable outcome / definition of done, preferably user words.",
  },
  mission: {
    type: "string",
    description: "The real mission in outcome terms.",
  },
  personalityNotes: {
    type: "string",
    description: "Only if the user explicitly described tone/behavior.",
  },
  boundaries: {
    type: "string",
    description: 'Explicit "will never" list only if the user stated restrictions.',
  },
  workingFromNotes: {
    type: "string",
    description: "Only if the user described history/examples to learn from.",
  },
  dataFocus: { type: "string" },
  actorsNotes: {
    type: "string",
    description: "Who/what the agent acts with or on — only if stated.",
  },
  escalationNotes: {
    type: "string",
    description: "Only if the user described escalation rules.",
  },
  knownFacts: {
    type: "array",
    items: { type: "string" },
    description: "Facts the user explicitly confirmed.",
  },
  missingFacts: {
    type: "array",
    items: { type: "string" },
  },
  blockingGaps: {
    type: "array",
    items: { type: "string" },
    description: "Execution blockers ranked highest-first.",
  },
  nextQuestionFocus: { type: "string" },
  tentativeAgentType: {
    type: "string",
    description: `One of: ${CREATABLE_AGENT_TYPES.join(", ")}.`,
  },
  agentTypeConfidence: {
    type: "number",
    description: "0–1 confidence for tentativeAgentType.",
  },
  missionExecutable: {
    type: "boolean",
    description: "True only when the mission can execute with confirmed facts.",
  },
  coveredTopics: {
    type: "array",
    items: { type: "string", enum: [...INTERVIEW_TOPICS] },
    description: "Optional soft tags; do not use as a checklist to force questions.",
  },
  guessedFields: {
    type: "array",
    items: { type: "string" },
    description: "Only when the user skipped and minimum fields were filled.",
  },
};

const DRAFT_PATCH_SCHEMA = jsonSchema({
  type: "object",
  properties: {
    draftPatch: {
      type: "object",
      description: "Fields to merge into the structured agent draft. Omit unchanged fields.",
      properties: DRAFT_PATCH_FIELDS,
      additionalProperties: false,
    },
    phase: {
      type: "string",
      enum: ["aim", "interview", "review"],
      description:
        "Use review ONLY when the mission is executable or the user skipped remaining questions.",
    },
    topicsCoveredThisTurn: {
      type: "array",
      items: { type: "string", enum: [...INTERVIEW_TOPICS] },
    },
    userSkippedRemaining: {
      type: "boolean",
      description: "True when the user wants to stop gathering and see the draft.",
    },
    userConfirmed: {
      type: "boolean",
      description: "True only when the user clearly approved the draft review to create the agent.",
    },
    userCancelled: {
      type: "boolean",
      description: "True when the user wants to discard the draft.",
    },
    userWantsEdits: {
      type: "boolean",
      description: "True when the user wants to change something in the draft review.",
    },
  },
  required: [
    "draftPatch",
    "phase",
    "topicsCoveredThisTurn",
    "userSkippedRemaining",
    "userConfirmed",
    "userCancelled",
    "userWantsEdits",
  ],
  additionalProperties: false,
});

/**
 * Split user-facing reply from trailing NOTES_JSON:{...} machine line.
 * Falls back to the full text as reply when the marker is missing/broken.
 */
export function parseInterviewTurnText(text) {
  const raw = String(text || "").trim();
  const markerIndex = raw.lastIndexOf(INTERVIEW_NOTES_MARKER);
  if (markerIndex < 0) {
    return {
      reply: raw,
      object: { draftPatch: {}, topicsCoveredThisTurn: [], userCancelled: false },
    };
  }

  const reply = raw.slice(0, markerIndex).trim();
  const jsonPart = raw.slice(markerIndex + INTERVIEW_NOTES_MARKER.length).trim();
  try {
    const parsed = JSON.parse(jsonPart);
    const draftPatch =
      parsed?.draftPatch && typeof parsed.draftPatch === "object" && !Array.isArray(parsed.draftPatch)
        ? { ...parsed.draftPatch }
        : {};

    // Knowledge-model fields may sit at the NOTES_JSON root — fold into patch.
    for (const key of [
      "mission",
      "knownFacts",
      "missingFacts",
      "assumptions",
      "blockingGaps",
      "nextQuestionFocus",
      "missionExecutable",
      "tentativeAgentType",
      "agentTypeConfidence",
    ]) {
      if (key in parsed && parsed[key] != null && draftPatch[key] == null) {
        draftPatch[key] = parsed[key];
      }
    }

    return {
      reply: reply || raw,
      object: {
        draftPatch,
        topicsCoveredThisTurn: Array.isArray(parsed?.topicsCoveredThisTurn)
          ? parsed.topicsCoveredThisTurn
          : [],
        userCancelled: Boolean(parsed?.userCancelled),
        missionExecutable: Boolean(parsed?.missionExecutable || draftPatch.missionExecutable),
      },
    };
  } catch {
    return {
      reply: reply || raw,
      object: { draftPatch: {}, topicsCoveredThisTurn: [], userCancelled: false },
    };
  }
}

const CONVERSATION_SYSTEM_PROMPT = [
  MISSION_REASONING_RULES,
  "Sound like a normal, competent executive colleague — warm, concise, never robotic.",
  "Never say \"soul file\", \"system prompt\", \"JSON\", \"interview topics\", or \"gap analysis\".",
  CHAT_PLAIN_TEXT_RULE,
  "Flow:",
  "1) AIM / MISSION — land what \"done\" looks like. If they give only vague steps, push once for the outcome.",
  "2) GATHER — after each answer, recompute Situation Brief + gaps. Ask the next blocking question only. Do not walk a fixed topic list.",
  "3) REVIEW — only when the mission is executable OR they skipped. Present a short human draft from CONFIRMED facts only. Label any skip-time minimums as guesses. Ask if it looks good or what to edit. Never silently create.",
  "If they stall / skip / you-decide: draft from confirmed facts with minimal guesses — do not invent a personality or restriction list.",
  "Do NOT ask about schedule, model tier, or autonomy/trust yet. Assume on-demand + balanced model if asked.",
  "Keep replies short.",
  "Safety rules:",
  `- ${PROMPT_SAFETY_RULES}`,
].join("\n");

const EXTRACTION_SYSTEM_PROMPT = [
  "You extract a structured agent-creation draft patch from a CEO Agent intake turn.",
  "Return only fields the user EXPLICITLY confirmed. Do not invent personality, boundaries, actors, history, escalation, or agent type.",
  "Prefer mission + knownFacts + blockingGaps over filling optional identity fields.",
  "definitionOfDone / mission must reflect the user's outcome words when measurable.",
  "Set missionExecutable / phase review ONLY when blocking execution gaps are gone OR userSkippedRemaining is true.",
  "Do NOT set guessedFields or invent answers unless userSkippedRemaining is true — and even then only minimum create fields.",
  "userSkippedRemaining is true when they want to stop gathering and see the draft.",
  "userConfirmed is true ONLY for clear approval to create AFTER a review. userCancelled for discard. userWantsEdits when they want draft changes.",
  `tentativeAgentType / agentType one of: ${CREATABLE_AGENT_TYPES.join(", ")} only with real signal; include agentTypeConfidence 0–1.`,
].join("\n");

/** Fields allowed from explicit user answers during open intake (not skip/review). */
const EXPLICIT_DRAFT_FIELDS = Object.freeze([
  "definitionOfDone",
  "mission",
  "instructions",
  "roleLine",
  "dataFocus",
  "actorsNotes",
  "boundaries",
  "workingFromNotes",
  "personalityNotes",
  "escalationNotes",
  "name",
  "knownFacts",
  "missingFacts",
  "blockingGaps",
  "assumptions",
  "nextQuestionFocus",
  "tentativeAgentType",
  "agentTypeConfidence",
  "missionExecutable",
]);

/**
 * Strip invented draft fields. Never commit agentType without high confidence.
 * Never trust the model to open review mid-intake.
 */
export function sanitizeExtractionForInterview({ phase, userSkipped, object }) {
  if (!object || typeof object !== "object") return object;
  if (userSkipped || phase === "review") return object;

  const rawPatch = object.draftPatch && typeof object.draftPatch === "object" ? object.draftPatch : {};
  const draftPatch = {};

  for (const key of EXPLICIT_DRAFT_FIELDS) {
    if (rawPatch[key] != null) draftPatch[key] = rawPatch[key];
  }

  // Soft topic tags are optional breadcrumbs only.
  if (Array.isArray(rawPatch.coveredTopics)) {
    draftPatch.coveredTopics = rawPatch.coveredTopics;
  } else if (Array.isArray(object.topicsCoveredThisTurn)) {
    draftPatch.coveredTopics = object.topicsCoveredThisTurn;
  }

  const tentative =
    draftPatch.tentativeAgentType ||
    rawPatch.tentativeAgentType ||
    rawPatch.agentType ||
    null;
  let confidence = Number(
    draftPatch.agentTypeConfidence ?? rawPatch.agentTypeConfidence ?? object.agentTypeConfidence
  );
  if (!Number.isFinite(confidence)) confidence = tentative ? 0.4 : 0;
  if (tentative && CREATABLE_AGENT_TYPES.includes(String(tentative).toLowerCase())) {
    draftPatch.tentativeAgentType = String(tentative).toLowerCase();
    draftPatch.agentTypeConfidence = Math.max(0, Math.min(1, confidence));
    // Only commit agentType when confidence is high — never invent Finance Agent.
    if (draftPatch.agentTypeConfidence >= AGENT_TYPE_COMMIT_CONFIDENCE) {
      draftPatch.agentType = draftPatch.tentativeAgentType;
    }
  }
  // Drop low-confidence agentType from the raw patch.
  if (rawPatch.agentType && !(draftPatch.agentTypeConfidence >= AGENT_TYPE_COMMIT_CONFIDENCE)) {
    delete draftPatch.agentType;
  }

  // Aim: capture mission/outcome + explicit facts, but never open review / invent identity.
  if (phase === "aim") {
    delete draftPatch.personalityNotes;
    delete draftPatch.boundaries;
    delete draftPatch.escalationNotes;
    delete draftPatch.workingFromNotes;
    delete draftPatch.guessedFields;
    draftPatch.missionExecutable = false;
    if (!draftPatch.coveredTopics?.length && (draftPatch.definitionOfDone || draftPatch.mission)) {
      draftPatch.coveredTopics = ["outcome"];
    }
  }

  return {
    ...object,
    draftPatch,
    topicsCoveredThisTurn: Array.isArray(draftPatch.coveredTopics) ? draftPatch.coveredTopics : [],
    phase: "interview",
    userSkippedRemaining: false,
    userConfirmed: false,
  };
}

function renderDraftForPrompt(draft) {
  return JSON.stringify(
    {
      mission: draft.mission,
      definitionOfDone: draft.definitionOfDone,
      knownFacts: draft.knownFacts,
      missingFacts: draft.missingFacts,
      assumptions: draft.assumptions,
      blockingGaps: draft.blockingGaps,
      nextQuestionFocus: draft.nextQuestionFocus,
      missionExecutable: draft.missionExecutable,
      tentativeAgentType: draft.tentativeAgentType,
      agentTypeConfidence: draft.agentTypeConfidence,
      agentType: draft.agentType,
      name: draft.name,
      roleLine: draft.roleLine,
      instructions: draft.instructions,
      personalityNotes: draft.personalityNotes,
      boundaries: draft.boundaries,
      workingFromNotes: draft.workingFromNotes,
      actorsNotes: draft.actorsNotes,
      escalationNotes: draft.escalationNotes,
      dataFocus: draft.dataFocus,
      guessedFields: draft.guessedFields,
    },
    null,
    2
  );
}

function renderTranscript(messages) {
  if (!Array.isArray(messages) || !messages.length) return "(no prior turns)";
  return messages
    .slice(-12)
    .map((row) => {
      const role = row.role === "USER" || row.role === "user" ? "User" : "CEO Agent";
      return `${role}: ${String(row.text || "").trim()}`;
    })
    .filter((line) => !line.endsWith(":"))
    .join("\n\n");
}

function fallbackBlockingQuestion(draft) {
  const focus = String(draft?.nextQuestionFocus || "").trim();
  if (focus) return `Got it — ${focus.endsWith("?") ? focus : `what's the ${focus}?`}`;
  const gap = Array.isArray(draft?.blockingGaps) ? draft.blockingGaps[0] : null;
  if (gap) return `Got it — ${String(gap).trim()}?`;
  return "Got it — what does successful execution look like for this agent?";
}

/** Starts a fresh session on the Aim screen (no LLM call). */
export function startCreationSession() {
  return {
    state: {
      v: 4,
      status: "active",
      phase: "aim",
      step: "aim",
      draft: emptyCreationDraft(),
      sessionStartedAtMs: Date.now(),
    },
    reply: AIM_OPENER,
    createPayload: null,
  };
}

export function completeCreationSession(state, agent) {
  return {
    ...state,
    status: "completed",
    phase: "done",
    step: "done",
    createdAgentId: agent.id,
  };
}

export function buildCreationSuccessReply(agent) {
  const parts = [
    `Done — I've created "${agent.name}" (${agent.agentType}). It starts read-only and is active now.`,
    agent.agentType === "email"
      ? "Heads up: email agents cannot run yet in this phase; the configuration is saved for when the runtime ships."
      : "Open its chat anytime to refine the outcome, personality, or boundaries — or trigger a run from its page.",
  ];
  return parts.join(" ");
}

/**
 * One conversational creation turn. Pure aside from LLM calls.
 * Returns { state, reply, createPayload?, creationDraft }.
 */
export async function runCreationTurn(state, message, { recentMessages = [] } = {}) {
  const text = String(message || "").trim();
  let baseDraft = applyDraftPatch(emptyCreationDraft(), state?.draft || {});
  let phase = normalizeCreationPhase(state?.phase || state?.step || "aim", baseDraft);
  const userSkipped = matchesCreationSkip(text) && phase !== "review";

  if (matchesCreationCancel(text)) {
    const next = {
      ...state,
      status: "cancelled",
      phase: "aim",
      step: "aim",
      draft: baseDraft,
    };
    return {
      state: next,
      reply: "No problem — I've discarded that agent draft. Ask me anytime to set up a new one.",
      createPayload: null,
      creationDraft: publicCreationDraft(next),
    };
  }

  if (phase === "review" && matchesCreationConfirm(text) && !matchesCreationEditRequest(text)) {
    const createPayload = buildCreatePayloadFromDraft(baseDraft);
    if (createPayload) {
      const next = { ...state, status: "active", phase: "review", step: "review", draft: baseDraft };
      return {
        state: next,
        reply: null,
        createPayload,
        creationDraft: publicCreationDraft(next),
      };
    }
  }

  if (phase === "review" && matchesCreationEditRequest(text)) {
    phase = "interview";
    baseDraft = applyDraftPatch(baseDraft, {
      interviewComplete: false,
      missionExecutable: false,
    });
  }

  if (userSkipped && phase !== "review") {
    if (!baseDraft.definitionOfDone && !baseDraft.mission) {
      return {
        state: { ...state, status: "active", phase: "aim", step: "aim", draft: baseDraft },
        reply:
          "Happy to skip ahead — I still need the mission this agent owns first. What does \"done\" look like?",
        createPayload: null,
        creationDraft: publicCreationDraft({
          ...state,
          phase: "aim",
          draft: baseDraft,
        }),
      };
    }
    baseDraft = completeInterviewWithGuesses(baseDraft);
    phase = "interview";
  }

  const interviewStillOpen =
    !userSkipped && !isInterviewComplete(baseDraft) && phase !== "review";
  const conversationPrompt = [
    dataSection("CURRENT PHASE", phase),
    dataSection(
      "KNOWLEDGE MODEL",
      JSON.stringify(
        {
          mission: baseDraft.mission,
          knownFacts: baseDraft.knownFacts,
          missingFacts: baseDraft.missingFacts,
          assumptions: baseDraft.assumptions,
          blockingGaps: baseDraft.blockingGaps,
          nextQuestionFocus: baseDraft.nextQuestionFocus,
          missionExecutable: isMissionExecutable(baseDraft),
          tentativeAgentType: baseDraft.tentativeAgentType,
          agentTypeConfidence: baseDraft.agentTypeConfidence,
          userAskedToSkipRemaining: userSkipped,
        },
        null,
        2
      )
    ),
    dataSection(
      "NOTES CAPTURED SO FAR (internal — confirmed only; do not dump as a draft unless phase is review)",
      renderDraftForPrompt(baseDraft)
    ),
    dataSection("RECENT TRANSCRIPT", renderTranscript(recentMessages)),
    dataSection("USER MESSAGE", text),
    userSkipped
      ? "The user wants to stop gathering and see a draft. Present the draft review from CONFIRMED facts only; mention any minimum guesses briefly. Do not ask another question."
      : isInterviewComplete(baseDraft) && phase !== "review"
        ? "Mission is executable. Present the draft review now from confirmed facts and ask if it looks good or what to edit."
        : "Recompute Situation Brief → Mission → Gaps → Relevance. Reply with a brief acknowledgment of what they confirmed, then ask ONLY the single highest-value blocking question. Do NOT ask about personality/tone/escalation/history before execution blockers. Do NOT invent requirements. Do NOT present a draft yet.",
  ].join("\n\n");

  let reply;
  let object;

  if (interviewStillOpen) {
    const { text: replyText } = await generateAgentText({
      // Executive reasoning quality matters more than Haiku speed here.
      model: CEO_AGENT_MODEL,
      system: INTERVIEW_TURN_SYSTEM_PROMPT,
      prompt: conversationPrompt,
      maxOutputTokens: 420,
    });
    const parsed = parseInterviewTurnText(replyText);
    const sanitized = sanitizeExtractionForInterview({
      phase,
      userSkipped: false,
      object: {
        ...parsed.object,
        phase: "interview",
        userSkippedRemaining: false,
        userConfirmed: false,
        userWantsEdits: false,
      },
    });
    object = sanitized;
    reply = parsed.reply || fallbackBlockingQuestion(baseDraft);
  } else {
    const conversationPromise = generateAgentText({
      model: CEO_AGENT_MODEL,
      system: CONVERSATION_SYSTEM_PROMPT,
      prompt: conversationPrompt,
      maxOutputTokens: 700,
    });
    const extractionPromise = generateAgentObject({
      model: PROFILE_EXTRACTION_MODEL,
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: [
        dataSection("PHASE BEFORE TURN", phase),
        dataSection("DRAFT BEFORE TURN", renderDraftForPrompt(baseDraft)),
        dataSection("USER MESSAGE", text),
        dataSection("USER ASKED TO SKIP REMAINING", userSkipped ? "yes" : "no"),
        "Return the draft patch and phase flags for this turn. Confirmed facts only.",
      ].join("\n\n"),
      schema: DRAFT_PATCH_SCHEMA,
      maxOutputTokens: 900,
      providerOptions: {
        anthropic: { structuredOutputMode: "jsonTool" },
      },
    });
    const [{ text: replyText }, { object: rawObject }] = await Promise.all([
      conversationPromise,
      extractionPromise,
    ]);
    object = sanitizeExtractionForInterview({
      phase,
      userSkipped,
      object: rawObject,
    });
    reply =
      String(replyText || "").trim() ||
      (userSkipped
        ? "Got it — I'll draft from what we have."
        : "Got it — tell me a bit more about the outcome you want.");
  }

  if (object?.userCancelled) {
    const next = {
      ...state,
      status: "cancelled",
      phase: "aim",
      step: "aim",
      draft: baseDraft,
    };
    return {
      state: next,
      reply:
        reply ||
        "No problem — I've discarded that agent draft. Ask me anytime to set up a new one.",
      createPayload: null,
      creationDraft: publicCreationDraft(next),
    };
  }

  let draft = applyDraftPatch(baseDraft, {
    ...(object?.draftPatch || {}),
    coveredTopics: [
      ...(object?.draftPatch?.coveredTopics || []),
      ...(object?.topicsCoveredThisTurn || []),
    ],
  });

  if (userSkipped) {
    draft = completeInterviewWithGuesses(draft);
  }

  if (object?.userWantsEdits) {
    draft = applyDraftPatch(draft, {
      interviewComplete: false,
      missionExecutable: false,
    });
  }

  // First turn: land mission/outcome + explicit facts only — never a full draft.
  if (phase === "aim" && !userSkipped) {
    const outcome =
      draft.definitionOfDone || draft.mission || text.slice(0, 500);
    const knownFacts = Array.isArray(draft.knownFacts) ? draft.knownFacts : [];
    draft = applyDraftPatch(emptyCreationDraft(), {
      mission: draft.mission || outcome || null,
      definitionOfDone: outcome || null,
      instructions: draft.instructions,
      roleLine: draft.roleLine,
      dataFocus: draft.dataFocus,
      actorsNotes: draft.actorsNotes,
      knownFacts,
      missingFacts: draft.missingFacts,
      blockingGaps: draft.blockingGaps,
      assumptions: draft.assumptions,
      nextQuestionFocus: draft.nextQuestionFocus,
      tentativeAgentType: draft.tentativeAgentType,
      agentTypeConfidence: draft.agentTypeConfidence,
      // Only keep committed type if sanitize allowed it (high confidence).
      agentType: draft.agentType,
      name: draft.name,
      coveredTopics: outcome ? ["outcome"] : [],
      interviewComplete: false,
      missionExecutable: false,
    });
  }

  let nextPhase = normalizeCreationPhase(object?.phase || phase, draft);
  if (nextPhase === "review" && !isInterviewComplete(draft)) {
    nextPhase = draft.definitionOfDone || draft.mission ? "interview" : "aim";
  }
  if (
    phase !== "aim" &&
    isInterviewComplete(draft) &&
    isDraftReadyForReview(draft) &&
    !object?.userWantsEdits
  ) {
    nextPhase = "review";
  }
  if (phase === "aim" && !userSkipped) {
    nextPhase = draft.definitionOfDone || draft.mission ? "interview" : "aim";
  }

  const nextState = {
    ...state,
    v: 4,
    status: "active",
    phase: nextPhase,
    step: nextPhase,
    draft,
  };

  if (object?.userConfirmed && nextPhase === "review") {
    const createPayload = buildCreatePayloadFromDraft(draft);
    if (createPayload) {
      return {
        state: nextState,
        reply: null,
        createPayload,
        creationDraft: publicCreationDraft(nextState),
      };
    }
  }

  return {
    state: nextState,
    reply,
    createPayload: null,
    creationDraft: publicCreationDraft(nextState),
  };
}

// Re-export for tests that still import remaining topics helper via interview.
export { remainingInterviewTopics, isMissionExecutable };
