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
import { matchesCreationConfirm } from "../server/agents/creationDraft.js";
import { runCreationTurn } from "../server/agents/creationInterview.js";
import { setLlmImplementationForTesting } from "../server/agents/llm.js";

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

test("applyDraftPatch merges identity fields and infers a default name", () => {
  const draft = applyDraftPatch(emptyCreationDraft(), {
    agentType: "research",
    definitionOfDone: "I have a clear weekly brief on cattle prices by Monday 9am.",
    personalityNotes: "Terse\nPractical",
    boundaries: "Never send emails externally\nNever move money",
    guessedFields: ["personalityNotes"],
  });
  assert.equal(draft.agentType, "research");
  assert.equal(draft.name, "Research Agent");
  assert.match(draft.definitionOfDone, /cattle prices/);
  assert.deepEqual(draft.guessedFields, ["personalityNotes"]);
  assert.equal(isDraftReadyForReview(draft), true);
});

test("buildCreatePayloadFromDraft uses on-demand + Sonnet defaults for Slice 1", () => {
  const draft = applyDraftPatch(emptyCreationDraft(), {
    agentType: "finance",
    name: "Spend Watch",
    roleLine: "Flags unusual monthly spending",
    instructions: "Watch transactions and call out surprises",
    definitionOfDone: "A weekly spending observations report is produced",
    personalityNotes: "Direct",
    boundaries: "Never recommend trades",
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

test("publicCreationDraft exposes a client-safe snapshot", () => {
  const started = startCreationSession();
  const draft = applyDraftPatch(started.state.draft, {
    agentType: "reminders",
    definitionOfDone: "Nothing important slips past Friday.",
  });
  const pub = publicCreationDraft({ ...started.state, phase: "interview", draft });
  assert.equal(pub.phase, "interview");
  assert.equal(pub.agentType, "reminders");
  assert.equal(pub.readyForReview, true);
  assert.equal(pub.definitionOfDone, "Nothing important slips past Friday.");
});

test("runCreationTurn patches the draft from LLM output and confirms on review", async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  let calls = 0;
  setLlmImplementationForTesting({
    generateText: async () => {
      calls += 1;
      return { text: "Got it — that outcome is clear. Quick one: how should this agent sound?" };
    },
    generateObject: async () => {
      calls += 1;
      return {
        object: {
          draftPatch: {
            agentType: "research",
            name: "Market Scout",
            roleLine: "Tracks cattle market moves",
            definitionOfDone: "Every Monday I know what moved in cattle markets and why.",
            instructions: "Scan public market sources and summarize material changes",
            personalityNotes: "Calm\nSpecific",
            boundaries: "Never invent prices\nNever send messages externally",
            guessedFields: ["boundaries"],
          },
          phase: "review",
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
    const turn = await runCreationTurn(
      started.state,
      "Every Monday I know what moved in cattle markets and why."
    );
    assert.equal(turn.state.phase, "review");
    assert.equal(turn.state.draft.agentType, "research");
    assert.equal(turn.createPayload, null);
    assert.match(turn.reply, /outcome is clear/i);
    assert.equal(turn.creationDraft.readyForReview, true);
    assert.ok(calls >= 2);

    assert.equal(matchesCreationConfirm("looks good"), true);
    const confirm = await runCreationTurn(turn.state, "looks good");
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
