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
  INTERVIEW_TOPICS,
  isInterviewComplete,
  matchesCreationConfirm,
  matchesCreationSkip,
} from "../server/agents/creationDraft.js";
import { runCreationTurn } from "../server/agents/creationInterview.js";
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

test("skip / completeInterviewWithGuesses opens review with guessed remaining topics", () => {
  assert.equal(matchesCreationSkip("skip the rest"), true);
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

test("runCreationTurn stays in interview until topics are done, then confirms on review", async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  let mode = "partial";
  setLlmImplementationForTesting({
    generateText: async () => {
      if (mode === "partial") {
        return { text: "Got it — who should this agent act on behalf of?" };
      }
      return { text: "Here's the draft. Say looks good if you want me to create it." };
    },
    generateObject: async () => {
      if (mode === "partial") {
        return {
          object: {
            draftPatch: {
              agentType: "research",
              definitionOfDone: "Every Monday I know what moved in cattle markets and why.",
              coveredTopics: ["outcome"],
            },
            phase: "review", // model tries to jump — server must block
            topicsCoveredThisTurn: ["outcome"],
            userSkippedRemaining: false,
            userConfirmed: false,
            userCancelled: false,
            userWantsEdits: false,
          },
          usage: { inputTokens: 10, outputTokens: 20 },
        };
      }
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
