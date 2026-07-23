import { jsonSchema } from "ai";

import {
  AIM_OPENER,
  applyDraftPatch,
  buildCreatePayloadFromDraft,
  emptyCreationDraft,
  isDraftReadyForReview,
  matchesCreationCancel,
  matchesCreationConfirm,
  matchesCreationEditRequest,
  normalizeCreationPhase,
  publicCreationDraft,
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
// Conversational "+ New Agent" interview (Slice 1): Aim → interview → review →
// confirm. Natural CEO voice via generateAgentText; draft patches via a cheap
// Haiku structured call afterward so the live draft panel stays truthful.
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
          description: "What was learned from history/examples, if anything.",
        },
        dataFocus: { type: ["string", "null"] },
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
      description: "Where the conversation should be after this turn.",
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
  required: ["draftPatch", "phase", "userConfirmed", "userCancelled", "userWantsEdits"],
  additionalProperties: false,
});

const CONVERSATION_SYSTEM_PROMPT = [
  "You are the user's CEO Agent inside Freedom OS, helping them create ONE scoped worker agent through a natural conversation.",
  "Sound like a normal, competent human colleague — warm, concise, never robotic. Never say \"soul file\", \"system prompt\", or \"JSON\".",
  "Slice 1 flow only:",
  "1) AIM — land a measurable outcome (definition of done). If they give tasks/steps, push back once or twice: ask what \"done\" looks like specifically enough to know success vs failure.",
  "2) INTERVIEW — ask plain questions as needed (not a rigid script): who it acts for/with; what's off-limits; any history/examples to learn from; tone/behavior; who to flag and when. Accept answers out of order. If they skip or answer indirectly, say \"got it\", capture what you can, and keep going — fill reasonable guesses rather than stalling.",
  "3) REVIEW — when you have enough, present a short human draft: name & role (one line), personality bullets, will-never boundaries, working-from notes if any, and the outcome. Ask them to say it looks good or what to edit. Never silently create.",
  "Do NOT ask about schedule, model tier, or autonomy/trust yet — those come later. Assume on-demand + balanced model for now if asked.",
  "Infer agent type as one of: finance, research, reminders, email.",
  "Keep replies short (a few sentences). One question at a time when interviewing, unless acknowledging multiple answers they already gave.",
  "Safety rules:",
  `- ${PROMPT_SAFETY_RULES}`,
].join("\n");

const EXTRACTION_SYSTEM_PROMPT = [
  "You extract a structured agent-creation draft patch from a CEO Agent intake turn.",
  "Return only fields that should change based on the latest user message and the assistant reply.",
  "definitionOfDone must be an outcome/result, not a step list — prefer the user's words when they are measurable.",
  "If the assistant guessed missing details, list those field names in guessedFields.",
  "Set phase to review only when the draft is ready for the user to approve (outcome + enough identity to create).",
  "userConfirmed is true ONLY for clear approval to create after a review. userCancelled for discard. userWantsEdits when they want changes.",
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

/** Starts a fresh session on the Aim screen (no LLM call). */
export function startCreationSession() {
  return {
    state: {
      v: 2,
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
  const baseDraft = applyDraftPatch(emptyCreationDraft(), state?.draft || {});
  let phase = normalizeCreationPhase(state?.phase || state?.step || "aim", baseDraft);

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
    phase = "interview";
  }

  const conversationPrompt = [
    dataSection("CURRENT PHASE", phase),
    dataSection("DRAFT SO FAR", renderDraftForPrompt(baseDraft)),
    dataSection("RECENT TRANSCRIPT", renderTranscript(recentMessages)),
    dataSection("USER MESSAGE", text),
    "Reply as the CEO Agent. Acknowledge what they answered (including indirect answers), update the plan mentally, and ask only for what is still needed — or present the draft review when ready.",
  ].join("\n\n");

  const { text: replyText } = await generateAgentText({
    model: CEO_AGENT_MODEL,
    system: CONVERSATION_SYSTEM_PROMPT,
    prompt: conversationPrompt,
    maxOutputTokens: 700,
  });

  const reply = String(replyText || "").trim() || "Got it — tell me a bit more about the outcome you want.";

  const { object } = await generateAgentObject({
    model: PROFILE_EXTRACTION_MODEL,
    system: EXTRACTION_SYSTEM_PROMPT,
    prompt: [
      dataSection("PHASE BEFORE TURN", phase),
      dataSection("DRAFT BEFORE TURN", renderDraftForPrompt(baseDraft)),
      dataSection("USER MESSAGE", text),
      dataSection("ASSISTANT REPLY", reply),
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

  let draft = applyDraftPatch(baseDraft, object?.draftPatch || {});
  let nextPhase = normalizeCreationPhase(object?.phase || phase, draft);
  if (object?.userWantsEdits) nextPhase = "interview";
  if (isDraftReadyForReview(draft) && (object?.phase === "review" || phase === "review")) {
    nextPhase = "review";
  }

  const nextState = {
    ...state,
    v: 2,
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
