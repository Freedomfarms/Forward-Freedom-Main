import test from "node:test";
import assert from "node:assert/strict";

import {
  applyDraftPatch,
  buildCreatePayloadFromDraft,
  emptyCreationDraft,
  isDraftReadyForReview,
  isMissionExecutable,
  looksLikeScheduleOrEmailOnly,
  parseSchedule,
  publicCreationDraft,
  startCreationSession,
} from "../server/agents/creationFlow.js";
import {
  completeInterviewWithGuesses,
  INTERVIEW_TOPICS,
  isInterviewComplete,
  matchesCreationConfirm,
  matchesCreationSkip,
} from "../server/agents/creationDraft.js";
import {
  parseInterviewTurnText,
  runCreationTurn,
  sanitizeExtractionForInterview,
} from "../server/agents/creationInterview.js";
import { setLlmImplementationForTesting } from "../server/agents/llm.js";

function executableMissionPatch(extra = {}) {
  return {
    agentType: "research",
    name: "Market Scout",
    roleLine: "Tracks cattle market moves",
    definitionOfDone: "Every Monday I know what moved in cattle markets and why.",
    mission: "Every Monday I know what moved in cattle markets and why.",
    instructions: "Scan public market sources and summarize material changes",
    knownFacts: ["Weekly cattle-market brief", "Monday delivery"],
    blockingGaps: [],
    missingFacts: [],
    missionExecutable: true,
    interviewComplete: true,
    agentTypeConfidence: 0.9,
    tentativeAgentType: "research",
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
  assert.match(started.reply, /what should this agent own/i);
  assert.equal(started.state.draft.definitionOfDone, null);
  assert.equal(started.state.draft.missionExecutable, false);
  assert.equal(typeof started.state.sessionStartedAtMs, "number");
  assert.ok(started.state.sessionStartedAtMs > 0);
});

test("partial answers do not open draft review until the mission is executable", () => {
  const draft = applyDraftPatch(emptyCreationDraft(), {
    agentType: "research",
    definitionOfDone: "I have a clear weekly brief on cattle prices by Monday 9am.",
    mission: "I have a clear weekly brief on cattle prices by Monday 9am.",
    personalityNotes: "Terse\nPractical",
    boundaries: "Never send emails externally\nNever move money",
    missionExecutable: false,
    blockingGaps: ["which markets", "delivery channel"],
  });
  assert.equal(draft.agentType, "research");
  assert.equal(isMissionExecutable(draft), false);
  assert.equal(isInterviewComplete(draft), false);
  assert.equal(isDraftReadyForReview(draft), false);
  const pub = publicCreationDraft({ phase: "interview", draft });
  assert.equal(pub.phase, "interview");
  assert.equal(pub.readyForReview, false);
});

test("skip / completeInterviewWithGuesses opens review without inventing personality", () => {
  assert.equal(matchesCreationSkip("skip the rest"), true);
  assert.equal(matchesCreationSkip("draft it"), true);
  assert.equal(matchesCreationSkip("whatever"), true);
  assert.equal(matchesCreationSkip("you decide"), true);
  assert.equal(matchesCreationSkip("idk"), true);
  assert.equal(
    matchesCreationSkip(
      "It should act for me with vendors and never send anything externally without asking first"
    ),
    false
  );
  const partial = applyDraftPatch(emptyCreationDraft(), {
    definitionOfDone: "A weekly spending observations report is produced",
    mission: "A weekly spending observations report is produced",
    instructions: "Watch spending",
    tentativeAgentType: "finance",
    agentTypeConfidence: 0.6,
  });
  const draft = completeInterviewWithGuesses(partial);
  assert.equal(isMissionExecutable(draft), true);
  assert.equal(isDraftReadyForReview(draft), true);
  assert.equal(draft.agentType, "finance");
  // Minimum create fields only — do not invent identity preferences.
  assert.equal(draft.personalityNotes, null);
  assert.equal(draft.boundaries, null);
  assert.equal(draft.escalationNotes, null);
  assert.ok(draft.guessedFields.includes("agentType") || draft.agentType === "finance");
  const payload = buildCreatePayloadFromDraft(draft);
  assert.equal(payload.schedulePreset, null);
  assert.equal(payload.model, "claude-sonnet-4-5");
  assert.equal(payload.personalityNotes, null);
  assert.equal(payload.boundaries, null);
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
    const mid = {
      ...started.state,
      phase: "interview",
      step: "interview",
      draft: applyDraftPatch(emptyCreationDraft(), {
        tentativeAgentType: "research",
        agentTypeConfidence: 0.7,
        definitionOfDone: "Every Monday I know what moved in cattle markets and why.",
        mission: "Every Monday I know what moved in cattle markets and why.",
        actorsNotes: "Acts on behalf of the user",
        knownFacts: ["Monday cattle brief"],
        blockingGaps: ["which sources"],
      }),
    };
    const skipped = await runCreationTurn(mid, "whatever");
    assert.equal(skipped.state.phase, "review");
    assert.equal(skipped.creationDraft.readyForReview, true);
    assert.equal(isMissionExecutable(skipped.state.draft), true);
    assert.match(skipped.reply, /draft/i);
  } finally {
    setLlmImplementationForTesting(null);
    if (previousKey == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test("buildCreatePayloadFromDraft uses on-demand + Sonnet defaults for Slice 1", () => {
  const draft = applyDraftPatch(emptyCreationDraft(), {
    ...executableMissionPatch({
      agentType: "finance",
      name: "Spend Watch",
      roleLine: "Flags unusual monthly spending",
      instructions: "Watch transactions and call out surprises",
      definitionOfDone: "A weekly spending observations report is produced",
      mission: "A weekly spending observations report is produced",
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

test("sanitizeExtractionForInterview never invents identity or low-confidence types", () => {
  const sanitized = sanitizeExtractionForInterview({
    phase: "aim",
    userSkipped: false,
    object: {
      draftPatch: {
        agentType: "finance",
        tentativeAgentType: "finance",
        agentTypeConfidence: 0.4,
        name: "Finance Agent",
        definitionOfDone: "Email me social media reports on a couple people.",
        mission: "Email me social media reports on a couple people.",
        personalityNotes: "Warm\nTerse",
        boundaries: "Never send externally",
        actorsNotes: "Acts for the user",
        workingFromNotes: "Past sent mail",
        escalationNotes: "Flag urgent only",
        knownFacts: ["Deliver reports by email"],
        blockingGaps: ["people to monitor", "platforms"],
        nextQuestionFocus: "people to monitor",
        missionExecutable: true,
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
  assert.equal(sanitized.phase, "interview");
  assert.equal(sanitized.userSkippedRemaining, false);
  assert.equal(sanitized.userConfirmed, false);
  assert.equal(sanitized.draftPatch.definitionOfDone, "Email me social media reports on a couple people.");
  assert.equal(sanitized.draftPatch.agentType, undefined);
  assert.equal(sanitized.draftPatch.tentativeAgentType, "finance");
  assert.equal(sanitized.draftPatch.personalityNotes, undefined);
  assert.equal(sanitized.draftPatch.boundaries, undefined);
  assert.equal(sanitized.draftPatch.missionExecutable, false);
  assert.deepEqual(sanitized.draftPatch.blockingGaps, ["people to monitor", "platforms"]);
});

test("sanitizeExtractionForInterview commits agentType only at high confidence", () => {
  const sanitized = sanitizeExtractionForInterview({
    phase: "interview",
    userSkipped: false,
    object: {
      draftPatch: {
        tentativeAgentType: "research",
        agentTypeConfidence: 0.9,
        definitionOfDone: "Weekly social digest emailed to me",
        knownFacts: ["Email delivery", "Public social accounts"],
        blockingGaps: [],
        missionExecutable: true,
      },
      phase: "interview",
      topicsCoveredThisTurn: ["outcome"],
      userSkippedRemaining: false,
      userConfirmed: false,
      userCancelled: false,
      userWantsEdits: false,
    },
  });
  assert.equal(sanitized.draftPatch.agentType, "research");
  assert.equal(sanitized.draftPatch.agentTypeConfidence, 0.9);
});

test("parseInterviewTurnText strips NOTES_JSON and folds knowledge fields", () => {
  const parsed = parseInterviewTurnText(
    'Got it — which people should it monitor?\nNOTES_JSON:{"mission":"Social media reports emailed to me","knownFacts":["Deliver by email"],"blockingGaps":["people to monitor"],"nextQuestionFocus":"people to monitor","missionExecutable":false,"tentativeAgentType":"research","agentTypeConfidence":0.6,"draftPatch":{"definitionOfDone":"Social media reports emailed to me"},"userCancelled":false}'
  );
  assert.equal(parsed.reply, "Got it — which people should it monitor?");
  assert.equal(parsed.object.draftPatch.mission, "Social media reports emailed to me");
  assert.deepEqual(parsed.object.draftPatch.knownFacts, ["Deliver by email"]);
  assert.deepEqual(parsed.object.draftPatch.blockingGaps, ["people to monitor"]);
  assert.equal(parsed.object.draftPatch.tentativeAgentType, "research");
  assert.equal(parsed.object.userCancelled, false);

  const broken = parseInterviewTurnText("Just a reply\nNOTES_JSON:{not-json");
  assert.equal(broken.reply, "Just a reply");
  assert.deepEqual(broken.object.draftPatch, {});
});

test("runCreationTurn keeps **bold** markers for the chat UI to render", async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  setLlmImplementationForTesting({
    generateText: async () => ({
      text:
        "Got it — switching to a **federal reserve report**. **Who should receive it?**\n" +
        'NOTES_JSON:{"mission":"Fed rate brief","knownFacts":["Email delivery"],"blockingGaps":["recipient"],"nextQuestionFocus":"recipient","missionExecutable":false,"tentativeAgentType":"research","agentTypeConfidence":0.7,"draftPatch":{"definitionOfDone":"Fed rate brief"},"userCancelled":false}',
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

test("runCreationTurn rejects invented Aim overfill and asks a blocking gap", async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  let generateObjectCalls = 0;
  let generateTextCalls = 0;
  setLlmImplementationForTesting({
    generateText: async () => {
      generateTextCalls += 1;
      return {
        text:
          "Got it — which people should those social reports cover?\n" +
          `NOTES_JSON:${JSON.stringify({
            mission: "Email me social media reports on a couple people.",
            knownFacts: ["Deliver reports by email"],
            missingFacts: ["people to monitor", "platforms", "frequency"],
            blockingGaps: ["people to monitor", "platforms"],
            nextQuestionFocus: "people to monitor",
            missionExecutable: false,
            tentativeAgentType: "research",
            agentTypeConfidence: 0.55,
            draftPatch: {
              agentType: "finance",
              name: "Finance Agent",
              definitionOfDone: "Email me social media reports on a couple people.",
              personalityNotes: "Warm",
              boundaries: "Never leave sandbox",
              missionExecutable: true,
              coveredTopics: [...INTERVIEW_TOPICS],
              guessedFields: ["tone", "boundaries"],
            },
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
      "I want an agent that emails me social media reports on a couple people."
    );
    assert.equal(aim.state.phase, "interview");
    assert.equal(aim.creationDraft.phase, "interview");
    assert.equal(aim.creationDraft.readyForReview, false);
    assert.equal(isMissionExecutable(aim.state.draft), false);
    assert.equal(aim.state.draft.agentType, null);
    assert.equal(aim.state.draft.personalityNotes, null);
    assert.equal(aim.state.draft.boundaries, null);
    assert.match(aim.state.draft.definitionOfDone, /social media/i);
    assert.deepEqual(aim.state.draft.blockingGaps.slice(0, 1), ["people to monitor"]);
    assert.match(aim.reply, /people/i);
    assert.doesNotMatch(aim.reply, /NOTES_JSON/);
    assert.doesNotMatch(aim.reply, /Finance Agent/i);
    assert.equal(generateTextCalls, 1);
    assert.equal(generateObjectCalls, 0);
  } finally {
    setLlmImplementationForTesting(null);
    if (previousKey == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test("runCreationTurn stays gathering until executable, then confirms on review", async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  let mode = "partial";
  setLlmImplementationForTesting({
    generateText: async () => {
      if (mode === "partial") {
        return {
          text:
            "Got it — which people should it monitor?\n" +
            'NOTES_JSON:{"mission":"Every Monday I know what moved in cattle markets and why.","knownFacts":["Monday cattle brief"],"blockingGaps":["sources"],"nextQuestionFocus":"sources","missionExecutable":false,"tentativeAgentType":"research","agentTypeConfidence":0.7,"draftPatch":{"definitionOfDone":"Every Monday I know what moved in cattle markets and why."},"userCancelled":false}',
        };
      }
      return { text: "Here's the draft. Say looks good if you want me to create it." };
    },
    generateObject: async () => {
      return {
        object: {
          draftPatch: executableMissionPatch(),
          phase: "review",
          topicsCoveredThisTurn: ["outcome"],
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
    assert.match(aim.reply, /people|sources|monitor/i);

    mode = "skip";
    const skipped = await runCreationTurn(aim.state, "skip the rest");
    assert.equal(skipped.state.phase, "review");
    assert.equal(skipped.creationDraft.readyForReview, true);
    assert.equal(isMissionExecutable(skipped.state.draft), true);

    assert.equal(matchesCreationConfirm("looks good"), true);
    const confirm = await runCreationTurn(skipped.state, "looks good");
    assert.ok(confirm.createPayload);
    assert.equal(confirm.createPayload.agentType, "research");
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
