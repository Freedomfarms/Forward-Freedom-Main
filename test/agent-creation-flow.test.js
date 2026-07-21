import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceCreationSession,
  looksLikeScheduleOrEmailOnly,
  parseSchedule,
  startCreationSession,
} from "../server/agents/creationFlow.js";

function turn(state, message) {
  return advanceCreationSession(state, message);
}

function startWith(message) {
  const started = startCreationSession();
  return turn(started.state, message);
}

test("parseSchedule accepts day names without an explicit weekly keyword", () => {
  assert.deepEqual(parseSchedule("every monday"), {
    schedulePreset: "weekly",
    scheduleWeekday: "monday",
    scheduleWeekdays: ["monday"],
  });
  assert.deepEqual(parseSchedule("mondays and thursdays at 9pm"), {
    schedulePreset: "weekly",
    scheduleWeekday: null,
    scheduleWeekdays: ["monday", "thursday"],
  });
  assert.deepEqual(parseSchedule("weekly on friday"), {
    schedulePreset: "weekly",
    scheduleWeekday: "friday",
    scheduleWeekdays: ["friday"],
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

test("happy path still works in order", () => {
  let session = startWith("I want a finance agent");
  assert.match(session.reply, /focus on/i);
  assert.equal(session.state.draft.agentType, "finance");
  assert.equal(session.state.draft.instructions, undefined);

  session = turn(session.state, "Watch my monthly spending and flag unusual changes");
  assert.match(session.reply, /data/i);

  session = turn(session.state, "My transactions and account balances");
  assert.match(session.reply, /how often/i);

  session = turn(session.state, "weekly on friday");
  assert.match(session.reply, /definition of done/i);
  assert.equal(session.state.draft.scheduleWeekday, "friday");

  session = turn(session.state, "A weekly spending observations report is produced");
  assert.match(session.reply, /haiku|sonnet|opus|model/i);

  session = turn(session.state, "skip");
  assert.match(session.reply, /Here's the agent I'll create/);
  assert.match(session.reply, /weekly \(friday\)/);
  assert.match(session.reply, /Sonnet/i);

  session = turn(session.state, "confirm");
  assert.equal(session.createPayload.agentType, "finance");
  assert.equal(session.createPayload.scheduleWeekday, "friday");
  assert.equal(session.createPayload.model, "claude-sonnet-4-5");
  assert.match(session.createPayload.instructions, /monthly spending/);
  assert.match(session.createPayload.instructions, /Data focus: My transactions/);
  assert.match(session.createPayload.definitionOfDone, /observations report/);
});

test("opening message can fill type + purpose and skip the purpose question", () => {
  const session = startWith(
    "can you research the AI market and give me a report to my email?"
  );
  assert.equal(session.state.draft.agentType, "research");
  assert.match(session.state.draft.instructions, /AI market/i);
  assert.equal(session.state.draft.emailRequested, true);
  assert.match(session.reply, /data or area/i);
  assert.doesNotMatch(session.reply, /focus on\?/i);
});

test("schedule + email on the data step do not become Data focus", () => {
  let session = startWith("research agent");
  session = turn(session.state, "Track emerging AI platforms and apps");
  session = turn(
    session.state,
    "i want the report emailed to me every monday and thursday night at 9pm. please email to forwardfreedomfinancial@gmail.com"
  );

  assert.equal(session.state.draft.dataFocus, undefined);
  assert.deepEqual(session.state.draft.pendingWeekdays, ["monday", "thursday"]);
  assert.equal(session.state.draft.emailAddress, "forwardfreedomfinancial@gmail.com");
  assert.equal(session.state.draft.requestedTime, "9pm");
  assert.match(session.reply, /monday or thursday/i);
  assert.doesNotMatch(session.reply, /Data focus:/i);
});

test("reported CEO transcript assigns fields correctly", () => {
  let session = startWith(
    "can you research the AI market and give me a report to my email?"
  );
  assert.equal(session.state.draft.agentType, "research");

  session = turn(
    session.state,
    "i want to know the latest platforms / apps, whats trending in the space and anything else you feel important"
  );
  assert.match(session.state.draft.dataFocus, /platforms/i);
  assert.match(session.reply, /how often|weekly|schedule|monday or thursday/i);

  session = turn(
    session.state,
    "i want the report emailed to me every monday and thursday night at 9pm. please email to forwardfreedomfinancial@gmail.com"
  );
  assert.doesNotMatch(session.state.draft.dataFocus || "", /forwardfreedomfinancial/i);
  assert.deepEqual(session.state.draft.pendingWeekdays, ["monday", "thursday"]);

  // Previously failed to parse; now recognized as multi-day weekly.
  session = turn(session.state, "i just said monday and thursday nights at 8pm");
  assert.deepEqual(session.state.draft.pendingWeekdays, ["monday", "thursday"]);
  assert.equal(session.state.draft.requestedTime, "8pm");

  session = turn(session.state, "weekly on every monday and thursday");
  assert.match(session.reply, /monday or thursday/i);

  session = turn(session.state, "monday");
  assert.equal(session.state.draft.scheduleWeekday, "monday");
  assert.equal(session.state.draft.scheduleResolved, true);
  assert.match(session.reply, /definition of done/i);

  // Previously stuffed into definitionOfDone.
  session = turn(session.state, "can you send email at 8pm?");
  assert.equal(session.state.draft.definitionOfDone, undefined);
  assert.match(session.reply, /definition of done/i);

  session = turn(
    session.state,
    "A concise AI platforms and trends report is produced each scheduled run"
  );
  assert.match(session.reply, /haiku|sonnet|opus|model/i);

  session = turn(session.state, "opus");
  assert.match(session.reply, /Here's the agent I'll create/);
  assert.match(session.reply, /Schedule: weekly \(monday\)/);
  assert.match(session.reply, /platforms/);
  assert.match(session.reply, /definition of done: A concise AI platforms/i);
  assert.match(session.reply, /Opus/i);
  assert.doesNotMatch(session.reply, /Data focus: i want the report emailed/i);
  // Research agents can now email reports — to the verified account address
  // only; the third-party address is called out as unusable.
  assert.match(session.reply, /emailed to your own verified account address/i);
  assert.match(session.reply, /forwardfreedomfinancial@gmail.com/i);
  assert.match(session.reply, /13:00 UTC/i);

  session = turn(session.state, "confirm");
  assert.equal(session.createPayload.schedulePreset, "weekly");
  assert.equal(session.createPayload.scheduleWeekday, "monday");
  assert.equal(session.createPayload.model, "claude-opus-4-1");
  assert.match(session.createPayload.definitionOfDone, /concise AI platforms/);
  assert.deepEqual(session.createPayload.toolAccess, { email: true });
});

test("reminders + email on data step still enables account email delivery", () => {
  let session = startWith("reminders agent");
  session = turn(session.state, "Remind me to review cash flow");
  session = turn(session.state, "Cash flow checklist, and email me");
  assert.equal(session.state.draft.toolAccess?.email, true);
  assert.match(session.state.draft.dataFocus, /Cash flow checklist/i);
});

test("finance + email request enables account email delivery", () => {
  let session = startWith("finance agent");
  session = turn(session.state, "Watch my monthly spending and email me the report");
  assert.equal(session.state.draft.toolAccess?.email, true);
});

test("email requested before the type is chosen still enables delivery", () => {
  let session = startWith("I want reports emailed to me");
  assert.equal(session.state.draft.emailRequested, true);
  session = turn(session.state, "research");
  assert.equal(session.state.draft.agentType, "research");
  assert.equal(session.state.draft.toolAccess?.email, true);
});
