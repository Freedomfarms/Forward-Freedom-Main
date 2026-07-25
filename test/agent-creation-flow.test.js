import test from "node:test";
import assert from "node:assert/strict";

import {
  applyDraftPatch,
  buildCreatePayloadFromDraft,
  emptyCreationDraft,
  isDraftReadyForReview,
  looksLikeScheduleOrEmailOnly,
  parseSchedule,
  publicCreationDraft,
  startCreationSession,
} from "../server/agents/creationFlow.js";
import {
  completeInterviewWithGuesses,
  inferInterviewAnswerFromMessage,
  INTERVIEW_TOPICS,
  isInterviewComplete,
  matchesAlreadyAnsweredComplaint,
  matchesCreationConfirm,
  matchesCreationSkip,
  matchesToneDeferral,
} from "../server/agents/creationDraft.js";
import {
  lastAgentQuestionFromTranscript,
  mergeInterviewFallback,
  parseInterviewTurnText,
  runCreationTurn,
  sanitizeExtractionForInterview,
} from "../server/agents/creationInterview.js";
import { PLATFORM_CAPABILITIES } from "../server/agents/prompts.js";
import { setLlmImplementationForTesting } from "../server/agents/llm.js";

function fullyInterviewedPatch(extra = {}) {
  return {
    agentType: "research",
    name: "Market Scout",
    roleLine: "Tracks cattle market moves",
    definitionOfDone: "Every Monday I know what moved in cattle markets and why.",
    instructions: "Scan public market sources and summarize material changes",
    personalityNotes: "Calm\nSpecific",
    boundaries: "Never invent prices\nNever send messages externally",
    workingFromNotes: "No prior history — starting fresh.",
    actorsNotes: "Acts on behalf of the user",
    escalationNotes: "Flag the user for urgent market moves only",
    coveredTopics: [...INTERVIEW_TOPICS],
    interviewComplete: true,
    ...extra,
  };
}

test("parseSchedule accepts day names without an explicit weekly keyword", () => {
  assert.deepEqual(parseSchedule("every monday"), {
    schedulePreset: "weekly",
    scheduleWeekday: "monday",
    scheduleWeekdays: ["monday"],
    scheduleHourUtc: null,
  });
  assert.deepEqual(parseSchedule("mondays and thursdays at 9pm"), {
    schedulePreset: "weekly",
    scheduleWeekday: "monday",
    scheduleWeekdays: ["monday", "thursday"],
    scheduleHourUtc: 21,
  });
  assert.deepEqual(parseSchedule("weekly on friday"), {
    schedulePreset: "weekly",
    scheduleWeekday: "friday",
    scheduleWeekdays: ["friday"],
    scheduleHourUtc: null,
  });
  assert.equal(parseSchedule("sometime soon maybe"), undefined);
});

test("looksLikeScheduleOrEmailOnly detects delivery/schedule answers", () => {
  assert.equal(
    looksLikeScheduleOrEmailOnly(
      "i want the report emailed to me every monday and thursday night at 9pm. please email to forwardfreedomfinancial@gmail.com"
    ),
    true
  );
  assert.equal(looksLikeScheduleOrEmailOnly("can you send email at 8pm?"), true);
  assert.equal(
    looksLikeScheduleOrEmailOnly(
      "i want to know the latest platforms / apps, whats trending in the space"
    ),
    false
  );
});

test("startCreationSession opens on Aim with an empty draft", () => {
  const started = startCreationSession();
  assert.equal(started.state.phase, "aim");
  assert.equal(started.state.status, "active");
  assert.match(started.reply, /one outcome/i);
  assert.equal(started.state.draft.definitionOfDone, null);
});

test("partial answers do not open draft review until interview is complete", () => {
  const draft = applyDraftPatch(emptyCreationDraft(), {
    agentType: "research",
    definitionOfDone: "I have a clear weekly brief on cattle prices by Monday 9am.",
    personalityNotes: "Terse\nPractical",
    boundaries: "Never send emails externally\nNever move money",
  });
  assert.equal(draft.agentType, "research");
  assert.equal(draft.name, "Research Agent");
  assert.equal(isInterviewComplete(draft), false);
  assert.equal(isDraftReadyForReview(draft), false);
  const pub = publicCreationDraft({ phase: "interview", draft });
  assert.equal(pub.phase, "interview");
  assert.equal(pub.readyForReview, false);
});

test("platform capabilities forbid Coinbase / third-party API connectors", () => {
  assert.match(PLATFORM_CAPABILITIES, /Coinbase/i);
  assert.match(PLATFORM_CAPABILITIES, /READ_ONLY/i);
  assert.match(PLATFORM_CAPABILITIES, /answer NO/i);
  assert.match(PLATFORM_CAPABILITIES, /no Coinbase/i);
});

test("skip / completeInterviewWithGuesses opens review with guessed remaining topics", () => {
  assert.equal(matchesCreationSkip("skip the rest"), true);
  assert.equal(matchesCreationSkip("draft it"), true);
  assert.equal(matchesCreationSkip("whatever"), true);
  assert.equal(matchesCreationSkip("you decide"), true);
  assert.equal(matchesCreationSkip("idk"), true);
  // "no preference" answers tone when that is the next topic — not a full skip.
  assert.equal(matchesToneDeferral("no preference"), true);
  assert.equal(
    matchesCreationSkip("no preference", { remainingTopics: ["tone", "escalation"] }),
    false
  );
  assert.equal(
    matchesCreationSkip("no preference", { remainingTopics: ["actors", "tone"] }),
    true
  );
  // Substantive answers are not skips even if they mention drafting later.
  assert.equal(
    matchesCreationSkip(
      "It should act for me with vendors and never send anything externally without asking first"
    ),
    false
  );
  const partial = applyDraftPatch(emptyCreationDraft(), {
    agentType: "finance",
    definitionOfDone: "A weekly spending observations report is produced",
    instructions: "Watch spending",
  });
  const draft = completeInterviewWithGuesses(partial);
  assert.equal(isInterviewComplete(draft), true);
  assert.equal(isDraftReadyForReview(draft), true);
  assert.ok(draft.guessedFields.length > 0);
  const payload = buildCreatePayloadFromDraft(draft);
  assert.equal(payload.schedulePreset, null);
  assert.equal(payload.model, "claude-sonnet-4-5");
});

test("runCreationTurn jumps to draft when user bails after a couple answers", async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  setLlmImplementationForTesting({
    generateText: async () => ({
      text: "Alright — here's a draft from what we have. Look good?",
    }),
    generateObject: async () => ({
      object: {
        draftPatch: {},
        phase: "review",
        topicsCoveredThisTurn: [],
        userSkippedRemaining: true,
        userConfirmed: false,
        userCancelled: false,
        userWantsEdits: false,
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  });

  try {
    const started = startCreationSession();
    // Seed a light interview (Aim + one topic) without going through LLM Aim.
    const mid = {
      ...started.state,
      phase: "interview",
      step: "interview",
      draft: applyDraftPatch(emptyCreationDraft(), {
        agentType: "research",
        definitionOfDone: "Every Monday I know what moved in cattle markets and why.",
        actorsNotes: "Acts on behalf of the user",
        coveredTopics: ["outcome", "actors"],
      }),
    };
    const skipped = await runCreationTurn(mid, "whatever");
    assert.equal(skipped.state.phase, "review");
    assert.equal(skipped.creationDraft.readyForReview, true);
    assert.equal(isInterviewComplete(skipped.state.draft), true);
    assert.match(skipped.reply, /draft/i);
  } finally {
    setLlmImplementationForTesting(null);
    if (previousKey == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test("buildCreatePayloadFromDraft uses on-demand + Sonnet defaults for Slice 1", () => {
  const draft = applyDraftPatch(emptyCreationDraft(), {
    ...fullyInterviewedPatch({
      agentType: "finance",
      name: "Spend Watch",
      roleLine: "Flags unusual monthly spending",
      instructions: "Watch transactions and call out surprises",
      definitionOfDone: "A weekly spending observations report is produced",
      personalityNotes: "Direct",
      boundaries: "Never recommend trades",
    }),
  });
  const payload = buildCreatePayloadFromDraft(draft);
  assert.equal(payload.agentType, "finance");
  assert.equal(payload.name, "Spend Watch");
  assert.equal(payload.schedulePreset, null);
  assert.equal(payload.model, "claude-sonnet-4-5");
  assert.match(payload.instructions, /Flags unusual/);
  assert.equal(payload.personalityNotes, "Direct");
  assert.equal(payload.boundaries, "Never recommend trades");
});

test("sanitizeExtractionForInterview keeps Aim turns to outcome only", () => {
  const sanitized = sanitizeExtractionForInterview({
    phase: "aim",
    userSkipped: false,
    object: {
      draftPatch: {
        agentType: "email",
        name: "Inbox Agent",
        definitionOfDone: "Inbox zero every morning with drafts in my voice.",
        personalityNotes: "Warm\nTerse",
        boundaries: "Never send externally",
        actorsNotes: "Acts for the user",
        workingFromNotes: "Past sent mail",
        escalationNotes: "Flag urgent only",
        coveredTopics: [...INTERVIEW_TOPICS],
        guessedFields: ["tone", "boundaries"],
        interviewComplete: true,
      },
      phase: "review",
      topicsCoveredThisTurn: [...INTERVIEW_TOPICS],
      userSkippedRemaining: true,
      userConfirmed: true,
      userCancelled: false,
      userWantsEdits: false,
    },
  });
  assert.deepEqual(sanitized.topicsCoveredThisTurn, ["outcome"]);
  assert.equal(sanitized.phase, "interview");
  assert.equal(sanitized.userSkippedRemaining, false);
  assert.equal(sanitized.userConfirmed, false);
  assert.equal(sanitized.draftPatch.definitionOfDone, "Inbox zero every morning with drafts in my voice.");
  assert.equal(sanitized.draftPatch.agentType, "email");
  assert.equal(sanitized.draftPatch.personalityNotes, undefined);
  assert.equal(sanitized.draftPatch.boundaries, undefined);
  assert.equal(sanitized.draftPatch.guessedFields, undefined);
});

test("parseInterviewTurnText strips NOTES_JSON from the user-facing reply", () => {
  const parsed = parseInterviewTurnText(
    'Got it — who should this agent act on behalf of?\nNOTES_JSON:{"topicsCoveredThisTurn":["outcome"],"draftPatch":{"agentType":"research","definitionOfDone":"Markets briefed"},"userCancelled":false}'
  );
  assert.equal(parsed.reply, "Got it — who should this agent act on behalf of?");
  assert.deepEqual(parsed.object.topicsCoveredThisTurn, ["outcome"]);
  assert.equal(parsed.object.draftPatch.agentType, "research");
  assert.equal(parsed.object.userCancelled, false);

  const broken = parseInterviewTurnText("Just a reply\nNOTES_JSON:{not-json");
  assert.equal(broken.reply, "Just a reply");
  assert.deepEqual(broken.object.draftPatch, {});
});

test("inferInterviewAnswerFromMessage maps short yes/no onto the pending topic", () => {
  const actors = inferInterviewAnswerFromMessage("nope", {
    remainingTopics: ["actors", "boundaries"],
    lastAgentQuestion: "Who else might this agent work with besides you?",
  });
  assert.deepEqual(actors.topicsCoveredThisTurn, ["actors"]);
  assert.match(actors.draftPatch.actorsNotes, /user only/i);

  const history = inferInterviewAnswerFromMessage("agent will learn as it goes", {
    remainingTopics: ["history", "tone"],
  });
  assert.deepEqual(history.topicsCoveredThisTurn, ["history"]);
  assert.match(history.draftPatch.workingFromNotes, /learn and adapt/i);
  assert.equal(history.draftPatch.personalityNotes, undefined);

  const tone = inferInterviewAnswerFromMessage("no preference", {
    remainingTopics: ["tone", "escalation"],
  });
  assert.deepEqual(tone.topicsCoveredThisTurn, ["tone"]);
  assert.ok(tone.draftPatch.personalityNotes);

  const escalation = inferInterviewAnswerFromMessage("pause and wait", {
    remainingTopics: ["escalation"],
    lastAgentQuestion:
      "When a trade fails, should the agent pause and wait for your approval, or log it and keep retrying?",
  });
  assert.deepEqual(escalation.topicsCoveredThisTurn, ["escalation"]);
  assert.match(escalation.draftPatch.escalationNotes, /pause and wait/i);

  const yesPause = inferInterviewAnswerFromMessage("yes", {
    remainingTopics: ["escalation"],
    lastAgentQuestion: "Should it pause and wait for your say-so before trying again?",
  });
  assert.deepEqual(yesPause.topicsCoveredThisTurn, ["escalation"]);
  assert.match(yesPause.draftPatch.escalationNotes, /pause and wait/i);
});

test("mergeInterviewFallback fills dropped NOTES_JSON from short answers", () => {
  const merged = mergeInterviewFallback({
    object: { draftPatch: {}, topicsCoveredThisTurn: [], userCancelled: false },
    message: "nope",
    remainingTopics: ["actors", "boundaries"],
    lastAgentQuestion: "Who else should this agent work with?",
  });
  assert.deepEqual(merged.topicsCoveredThisTurn, ["actors"]);
  assert.match(merged.draftPatch.actorsNotes, /user only/i);

  const kept = mergeInterviewFallback({
    object: {
      draftPatch: { actorsNotes: "Vendors" },
      topicsCoveredThisTurn: ["actors"],
      userCancelled: false,
    },
    message: "nope",
    remainingTopics: ["actors"],
    lastAgentQuestion: "Who else?",
  });
  assert.equal(kept.draftPatch.actorsNotes, "Vendors");
});

test("already-answered complaint detection and last agent question helper", () => {
  assert.equal(
    matchesAlreadyAnsweredComplaint("you already asked this question and i gave an answer"),
    true
  );
  assert.equal(matchesAlreadyAnsweredComplaint("pause and wait"), false);
  assert.equal(
    lastAgentQuestionFromTranscript([
      { role: "USER", text: "hi" },
      { role: "AGENT", text: "How should it sound?" },
      { role: "USER", text: "casual" },
    ]),
    "How should it sound?"
  );
});

test("runCreationTurn advances actors on short nope when NOTES_JSON is empty", async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  setLlmImplementationForTesting({
    generateText: async () => ({
      // Broken/missing NOTES_JSON — fallback must still cover actors.
      text: "Got it — anything this agent should never attempt?",
    }),
    generateObject: async () => ({ object: {}, usage: null }),
  });
  try {
    const mid = {
      ...startCreationSession().state,
      phase: "interview",
      step: "interview",
      draft: applyDraftPatch(emptyCreationDraft(), {
        agentType: "research",
        definitionOfDone: "Track sandbox portfolio moves and alert on failures.",
        coveredTopics: ["outcome"],
      }),
    };
    const turn = await runCreationTurn(mid, "nope", {
      recentMessages: [
        {
          role: "AGENT",
          text: "Who else might this agent work with or report to besides you?",
        },
      ],
    });
    assert.ok(turn.state.draft.coveredTopics.includes("actors"));
    assert.match(turn.state.draft.actorsNotes || "", /user only/i);
    assert.equal(turn.state.phase, "interview");
  } finally {
    setLlmImplementationForTesting(null);
    if (previousKey == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test("runCreationTurn records tone deferral instead of skipping the interview", async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  setLlmImplementationForTesting({
    generateText: async () => ({
      text:
        "Got it — who should it alert when something goes wrong?\n" +
        'NOTES_JSON:{"topicsCoveredThisTurn":[],"draftPatch":{},"userCancelled":false}',
    }),
    generateObject: async () => ({ object: {}, usage: null }),
  });
  try {
    const mid = {
      ...startCreationSession().state,
      phase: "interview",
      step: "interview",
      draft: applyDraftPatch(emptyCreationDraft(), {
        agentType: "research",
        definitionOfDone: "Alert on material portfolio moves.",
        actorsNotes: "User only",
        boundaries: "Never place live trades",
        workingFromNotes: "Learn as it goes",
        coveredTopics: ["outcome", "actors", "boundaries", "history"],
      }),
    };
    const turn = await runCreationTurn(mid, "no preference", {
      recentMessages: [
        { role: "AGENT", text: "How should this agent sound when it talks to you?" },
      ],
    });
    assert.equal(turn.state.phase, "interview");
    assert.ok(turn.state.draft.coveredTopics.includes("tone"));
    assert.ok(turn.state.draft.personalityNotes);
    assert.equal(isInterviewComplete(turn.state.draft), false);
  } finally {
    setLlmImplementationForTesting(null);
    if (previousKey == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test("runCreationTurn keeps **bold** markers for the chat UI to render", async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  setLlmImplementationForTesting({
    generateText: async () => ({
      text:
        "Got it — switching to a **federal reserve report**. **Who should receive it?**\n" +
        'NOTES_JSON:{"topicsCoveredThisTurn":["outcome"],"draftPatch":{"agentType":"research","definitionOfDone":"Fed rate brief"},"userCancelled":false}',
    }),
    generateObject: async () => ({ object: {}, usage: null }),
  });
  try {
    const started = startCreationSession();
    const aim = await runCreationTurn(started.state, "federal reserve report to my email");
    assert.match(aim.reply, /\*\*federal reserve report\*\*/i);
    assert.match(aim.reply, /\*\*Who should receive it\?\*\*/);
  } finally {
    setLlmImplementationForTesting(null);
    if (previousKey == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test("runCreationTurn rejects over-extracted Aim answers and stays in interview", async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  let generateObjectCalls = 0;
  let generateTextCalls = 0;
  setLlmImplementationForTesting({
    generateText: async () => {
      generateTextCalls += 1;
      // Interview path is plain text + trailing NOTES_JSON (no structured grammar).
      // Model tries to overfill topics — sanitize + Aim gate must strip them.
      return {
        text:
          "Got it — who should this agent act on behalf of?\n" +
          `NOTES_JSON:${JSON.stringify({
            topicsCoveredThisTurn: [...INTERVIEW_TOPICS],
            draftPatch: fullyInterviewedPatch({
              guessedFields: ["actors", "tone"],
              interviewComplete: true,
            }),
            userCancelled: false,
          })}`,
      };
    },
    generateObject: async () => {
      generateObjectCalls += 1;
      return { object: {}, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  });

  try {
    const started = startCreationSession();
    const aim = await runCreationTurn(
      started.state,
      "Every Monday I know what moved in cattle markets and why."
    );
    assert.equal(aim.state.phase, "interview");
    assert.equal(aim.creationDraft.phase, "interview");
    assert.equal(aim.creationDraft.readyForReview, false);
    assert.equal(isInterviewComplete(aim.state.draft), false);
    assert.deepEqual(aim.state.draft.coveredTopics, ["outcome"]);
    assert.equal(aim.state.draft.personalityNotes, null);
    assert.equal(aim.state.draft.boundaries, null);
    assert.match(aim.reply, /act on behalf/i);
    assert.doesNotMatch(aim.reply, /NOTES_JSON/);
    // Interview turns use one Haiku text call — no structured-object call.
    assert.equal(generateTextCalls, 1);
    assert.equal(generateObjectCalls, 0);
  } finally {
    setLlmImplementationForTesting(null);
    if (previousKey == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test("runCreationTurn stays in interview until topics are done, then confirms on review", async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  let mode = "partial";
  setLlmImplementationForTesting({
    generateText: async () => {
      if (mode === "partial") {
        return {
          text:
            "Got it — who should this agent act on behalf of?\n" +
            'NOTES_JSON:{"topicsCoveredThisTurn":["outcome"],"draftPatch":{"agentType":"research","definitionOfDone":"Every Monday I know what moved in cattle markets and why.","coveredTopics":["outcome"]},"userCancelled":false}',
        };
      }
      // Skip/review draft presentation (Sonnet text path).
      return { text: "Here's the draft. Say looks good if you want me to create it." };
    },
    generateObject: async () => {
      // Used only on skip/review extract.
      return {
        object: {
          draftPatch: fullyInterviewedPatch(),
          phase: "review",
          topicsCoveredThisTurn: [...INTERVIEW_TOPICS],
          userSkippedRemaining: true,
          userConfirmed: false,
          userCancelled: false,
          userWantsEdits: false,
        },
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    },
  });

  try {
    const started = startCreationSession();
    const aim = await runCreationTurn(
      started.state,
      "Every Monday I know what moved in cattle markets and why."
    );
    assert.equal(aim.state.phase, "interview");
    assert.equal(aim.creationDraft.readyForReview, false);
    assert.match(aim.reply, /act on behalf/i);

    mode = "skip";
    const skipped = await runCreationTurn(aim.state, "skip the rest");
    assert.equal(skipped.state.phase, "review");
    assert.equal(skipped.creationDraft.readyForReview, true);
    assert.equal(isInterviewComplete(skipped.state.draft), true);

    assert.equal(matchesCreationConfirm("looks good"), true);
    const confirm = await runCreationTurn(skipped.state, "looks good");
    assert.ok(confirm.createPayload);
    assert.equal(confirm.createPayload.agentType, "research");
    assert.equal(confirm.createPayload.name, "Market Scout");
    assert.match(confirm.createPayload.definitionOfDone, /cattle markets/);
    assert.equal(confirm.createPayload.schedulePreset, null);
  } finally {
    setLlmImplementationForTesting(null);
    if (previousKey == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test("runCreationTurn cancels without creating", async () => {
  const started = startCreationSession();
  const turn = await runCreationTurn(started.state, "cancel");
  assert.equal(turn.state.status, "cancelled");
  assert.equal(turn.createPayload, null);
  assert.match(turn.reply, /discarded/i);
});
