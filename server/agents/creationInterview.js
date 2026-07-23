import { jsonSchema } from "ai";

import {
  AIM_OPENER,
  applyDraftPatch,
  buildCreatePayloadFromDraft,
  completeInterviewWithGuesses,
  emptyCreationDraft,
  INTERVIEW_TOPICS,
  isDraftReadyForReview,
  isInterviewComplete,
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
import { dataSection, PROMPT_SAFETY_RULES } from "./prompts.js";
import { CREATABLE_AGENT_TYPES } from "./registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Conversational "+ New Agent" interview (Slice 1):
// Aim → full interview → draft review → confirm.
// The draft UI stays closed until every interview topic is covered or the user
// skips the rest. Clarifying follow-ups during interview are encouraged.
// ─────────────────────────────────────────────────────────────────────────────

const DRAFT_PATCH_SCHEMA = jsonSchema({
  type: "object",
  properties: {
    draftPatch: {
      type: "object",
      description: "Fields to merge into the structured agent draft. Omit unchanged fields.",
      properties: {
        agentType: {
          type: ["string", "null"],
          description: `One of: ${CREATABLE_AGENT_TYPES.join(", ")}. Infer from the outcome when clear.`,
        },
        name: { type: ["string", "null"] },
        roleLine: {
          type: ["string", "null"],
          description: "One-line name & role for the draft review.",
        },
        instructions: {
          type: ["string", "null"],
          description: "How the agent should do the job (purpose / focus).",
        },
        definitionOfDone: {
          type: ["string", "null"],
          description: "Measurable outcome / definition of done, stored verbatim.",
        },
        personalityNotes: {
          type: ["string", "null"],
          description: "2–3 short bullets on how it should sound/behave.",
        },
        boundaries: {
          type: ["string", "null"],
          description: 'Explicit "will never" list, newline-separated.',
        },
        workingFromNotes: {
          type: ["string", "null"],
          description: "What was learned from history/examples, or that there is none.",
        },
        dataFocus: { type: ["string", "null"] },
        actorsNotes: {
          type: ["string", "null"],
          description: "Who the agent interacts with or acts on behalf of.",
        },
        escalationNotes: {
          type: ["string", "null"],
          description: "Who to flag and how urgent something must be before interrupting.",
        },
        coveredTopics: {
          type: "array",
          items: { type: "string", enum: [...INTERVIEW_TOPICS] },
          description: "Interview topics covered by this turn (additively merged).",
        },
        guessedFields: {
          type: "array",
          items: { type: "string" },
          description: "Draft fields filled by inference because the user skipped or was vague.",
        },
      },
      additionalProperties: false,
    },
    phase: {
      type: "string",
      enum: ["aim", "interview", "review"],
      description:
        "Use review ONLY after the interview is complete (all topics covered) or the user skipped remaining questions.",
    },
    topicsCoveredThisTurn: {
      type: "array",
      items: { type: "string", enum: [...INTERVIEW_TOPICS] },
    },
    userSkippedRemaining: {
      type: "boolean",
      description: "True when the user wants to skip remaining interview questions and see the draft.",
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

const CONVERSATION_SYSTEM_PROMPT = [
  "You are the user's CEO Agent inside Freedom OS, helping them create ONE scoped worker agent through a natural conversation.",
  "Sound like a normal, competent human colleague — warm, concise, never robotic. Never say \"soul file\", \"system prompt\", \"JSON\", or \"interview topics\".",
  "Flow (strict order):",
  "1) AIM — land a measurable outcome. If they give tasks/steps, push back once or twice: what does \"done\" look like specifically enough to know success vs failure?",
  "2) INTERVIEW — walk through these questions before you ever present a draft. One main question at a time is fine; ask clarifying follow-ups when an answer is vague. Accept answers out of order / bundled. Topics:",
  "   - Who does this agent need to interact with or act on behalf of?",
  "   - What's explicitly off-limits (money, sending things externally, deleting data, etc.)?",
  "   - Is there existing history to learn from (past emails, a doc, past decisions)? If none, that's fine — note it.",
  "   - How should it sound/behave — formal, casual, terse, warm?",
  "   - Who does it flag problems to, and how urgent before it interrupts?",
  "   Do NOT open or narrate a full draft during interview. You may briefly acknowledge what you heard (\"got it\"), then ask the next unanswered topic — or a short clarifier on the current one.",
  "   If they say skip / that's enough / draft it / move on: acknowledge, fill reasonable guesses for anything unanswered, and THEN present the draft review.",
  "3) REVIEW — only after every interview topic is covered or they skipped the rest. Present a short human draft: name & role, personality, will-never boundaries, working-from notes, outcome. Ask if it looks good or what to edit. Never silently create.",
  "Do NOT ask about schedule, model tier, or autonomy/trust yet. Assume on-demand + balanced model if asked.",
  "Infer agent type as one of: finance, research, reminders, email.",
  "Keep replies short. Natural back-and-forth beats a rigid script.",
  "Safety rules:",
  `- ${PROMPT_SAFETY_RULES}`,
].join("\n");

const EXTRACTION_SYSTEM_PROMPT = [
  "You extract a structured agent-creation draft patch from a CEO Agent intake turn.",
  "Return only fields that should change based on the latest user message and the assistant reply.",
  "definitionOfDone must be an outcome/result — prefer the user's words when measurable.",
  "Track interview topics in topicsCoveredThisTurn / draftPatch.coveredTopics using ONLY these ids: " +
    INTERVIEW_TOPICS.join(", ") +
    ".",
  "Mapping: outcome←definitionOfDone; actors←actorsNotes; boundaries←boundaries; history←workingFromNotes (including \"none\"); tone←personalityNotes; escalation←escalationNotes.",
  "Set phase to review ONLY when the interview is finished (all topics covered) OR userSkippedRemaining is true. Never jump to review mid-interview just because some fields exist.",
  "userSkippedRemaining is true when they want to skip remaining questions and see the draft.",
  "userConfirmed is true ONLY for clear approval to create AFTER a review. userCancelled for discard. userWantsEdits when they want draft changes.",
  `agentType must be one of: ${CREATABLE_AGENT_TYPES.join(", ")} (or null if still unknown).`,
].join("\n");

function renderDraftForPrompt(draft) {
  return JSON.stringify(
    {
      agentType: draft.agentType,
      name: draft.name,
      roleLine: draft.roleLine,
      definitionOfDone: draft.definitionOfDone,
      instructions: draft.instructions,
      personalityNotes: draft.personalityNotes,
      boundaries: draft.boundaries,
      workingFromNotes: draft.workingFromNotes,
      actorsNotes: draft.actorsNotes,
      escalationNotes: draft.escalationNotes,
      dataFocus: draft.dataFocus,
      coveredTopics: draft.coveredTopics,
      interviewComplete: draft.interviewComplete,
      remainingTopics: remainingInterviewTopics(draft),
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

/** Starts a fresh session on the Aim screen (no LLM call). */
export function startCreationSession() {
  return {
    state: {
      v: 3,
      status: "active",
      phase: "aim",
      step: "aim",
      draft: emptyCreationDraft(),
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

  // Deterministic confirm gate while on review — don't rely solely on the model.
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
    // Edits reopen interview, but keep prior coverage so we don't restart from zero.
    phase = "interview";
    baseDraft = applyDraftPatch(baseDraft, { interviewComplete: false });
  }

  // Skip remaining interview questions → fill guesses, then let the model draft.
  if (userSkipped && phase !== "review") {
    if (!baseDraft.definitionOfDone) {
      // Can't draft without an outcome — stay in aim.
      return {
        state: { ...state, status: "active", phase: "aim", step: "aim", draft: baseDraft },
        reply:
          "Happy to skip ahead — I still need the one outcome this agent owns first. What does \"done\" look like?",
        createPayload: null,
        creationDraft: publicCreationDraft({
          ...state,
          phase: "aim",
          draft: baseDraft,
        }),
      };
    }
    baseDraft = completeInterviewWithGuesses(baseDraft);
    phase = "interview"; // model will present review this turn
  }

  const conversationPrompt = [
    dataSection("CURRENT PHASE", phase),
    dataSection(
      "INTERVIEW PROGRESS",
      JSON.stringify(
        {
          coveredTopics: baseDraft.coveredTopics,
          remainingTopics: remainingInterviewTopics(baseDraft),
          interviewComplete: isInterviewComplete(baseDraft),
          userAskedToSkipRemaining: userSkipped,
        },
        null,
        2
      )
    ),
    dataSection(
      "NOTES CAPTURED SO FAR (internal — do not dump as a draft unless phase is review)",
      renderDraftForPrompt(baseDraft)
    ),
    dataSection("RECENT TRANSCRIPT", renderTranscript(recentMessages)),
    dataSection("USER MESSAGE", text),
    userSkipped
      ? "The user wants to skip remaining questions. Present the draft review now from what you have (mention any guesses briefly)."
      : isInterviewComplete(baseDraft) && phase !== "review"
        ? "Interview topics are covered. Present the draft review now and ask if it looks good or what to edit."
        : "Reply as the CEO Agent. Stay in interview until topics are done (or they skip). Clarify when vague; ask the next unanswered topic. Do not present the full draft yet.",
  ].join("\n\n");

  const { text: replyText } = await generateAgentText({
    model: CEO_AGENT_MODEL,
    system: CONVERSATION_SYSTEM_PROMPT,
    prompt: conversationPrompt,
    maxOutputTokens: 700,
  });

  const reply =
    String(replyText || "").trim() ||
    (userSkipped
      ? "Got it — I'll draft from what we have."
      : "Got it — tell me a bit more about the outcome you want.");

  const { object } = await generateAgentObject({
    model: PROFILE_EXTRACTION_MODEL,
    system: EXTRACTION_SYSTEM_PROMPT,
    prompt: [
      dataSection("PHASE BEFORE TURN", phase),
      dataSection("DRAFT BEFORE TURN", renderDraftForPrompt(baseDraft)),
      dataSection("USER MESSAGE", text),
      dataSection("ASSISTANT REPLY", reply),
      dataSection("USER ASKED TO SKIP REMAINING", userSkipped ? "yes" : "no"),
      "Return the draft patch and phase flags for this turn.",
    ].join("\n\n"),
    schema: DRAFT_PATCH_SCHEMA,
    maxOutputTokens: 900,
  });

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

  if (userSkipped || object?.userSkippedRemaining) {
    draft = completeInterviewWithGuesses(draft);
  }

  if (object?.userWantsEdits) {
    draft = applyDraftPatch(draft, { interviewComplete: false });
  }

  let nextPhase = normalizeCreationPhase(object?.phase || phase, draft);
  // Hard gate: never enter review until interview is complete.
  if (nextPhase === "review" && !isInterviewComplete(draft)) {
    nextPhase = draft.definitionOfDone ? "interview" : "aim";
  }
  // Promote to review once interview is complete (skip or all topics).
  if (isInterviewComplete(draft) && isDraftReadyForReview(draft) && !object?.userWantsEdits) {
    nextPhase = "review";
  }

  const nextState = {
    ...state,
    v: 3,
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
