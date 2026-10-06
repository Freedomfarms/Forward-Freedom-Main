// Situational awareness is derived at turn time from readings CHIEF already has.
// It does not store a world model or take an action.

import test from "node:test";
import assert from "node:assert/strict";

import { settleReply } from "../server/chief/context/behavior.js";
import { orchestrateContext, planContext, renderContextPackage } from "../server/chief/context/orchestrate.js";
import {
  QUIET_FAILURES,
  QUIET_LINE,
  UNCHECKED_LINE,
  synthesizeSituation,
} from "../server/chief/context/situation.js";
import {
  ANTHROPIC_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  XAI_PROVIDER_ID,
} from "../server/chief/models/providers.js";
import { CHIEF_STATUS } from "../src/utils/chiefProtocol.js";
import { speakCompletedReply } from "../src/utils/chiefReplySpeech.js";

const NOW = new Date("2026-10-06T15:00:00.000Z");
const SOON = "2026-10-06T18:00:00.000Z";
const LATER = "2026-11-06T15:00:00.000Z";

function tool(name, payload) {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolName: name,
        output: { type: "text", value: JSON.stringify(payload) },
      },
    ],
  };
}

function ask(query, payloads, text, extra = {}) {
  return settleReply({
    transcript: [{ role: "user", content: query }, ...payloads],
    text,
    pack: { query, now: NOW, items: extra.items ?? [], plan: extra.plan ?? { currentState: true, memory: [] }, unavailable: extra.unavailable ?? [] },
    toolCalls: extra.toolCalls ?? [],
    ...extra.settle,
  });
}

function quietWorld() {
  return [
    tool("workforce_status", {
      connected: true,
      agents: [
        { id: "finance-bot", name: "Finance", status: "idle", currentWork: null, currentFailure: null },
        {
          id: "research-bot",
          name: "Research",
          status: "active",
          currentWork: { task: "Notes", status: "in_progress" },
          currentFailure: null,
        },
      ],
    }),
    tool("finance_summary", {
      position: {
        status: "available",
        holdings: [{ symbol: "XRP", quantity: 100 }],
        currentMonth: { spent: 10, budget: 100 },
      },
      activity: {
        status: "available",
        plaid: { requiresAttentionCount: 0 },
        categoryDeltas: [
          { category: "Groceries", momChangePct: 4, latestTotal: 20, previousTotal: 19 },
        ],
      },
    }),
    tool("schedule_list", {
      tasks: [{ id: "task-1", name: "Review", status: "ACTIVE", nextRunAt: LATER }],
    }),
    tool("schedule_runs", {
      runs: [{ id: "run-1", status: "SUCCEEDED", scheduledTaskId: "task-1", completedAt: "2026-10-01T12:00:00.000Z" }],
    }),
  ];
}

test("attention reads finance, workforce, and schedules, and skips web, email, and calendar", async () => {
  const plan = planContext("What should I be paying attention to?");
  assert.equal(plan.live.includes("finance"), true);
  assert.equal(plan.live.includes("agents"), true);
  assert.equal(plan.live.includes("schedule"), true);
  assert.equal(plan.live.includes("web"), false);
  assert.equal(plan.live.includes("email"), false);
  assert.equal(plan.live.includes("calendar"), false);

  const pack = await orchestrateContext({
    query: "What should I be paying attention to?",
    userId: "user-a",
    now: NOW,
  });
  const rendered = renderContextPackage(pack);
  assert.match(rendered, /lead with what stands out/);
  assert.equal(rendered.includes("I don't have your calendar"), false);
  assert.equal(rendered.includes("I don't have your email"), false);
});

test("a quiet connected world does not become a report", () => {
  const query = "What should I be paying attention to?";
  const situation = synthesizeSituation({ query, transcript: [{ role: "user", content: query }, ...quietWorld()], now: NOW });
  assert.equal(situation.line, QUIET_LINE);
  assert.equal(situation.signals.length, 0);
  const settled = ask(query, quietWorld(), "You should urgently reconsider your entire financial life and your XRP position.");
  assert.equal(settled.text, QUIET_LINE);
  assert.equal(settled.text.includes("XRP"), false);
  assert.equal(settled.text.includes("urgent"), false);
});

test("a measured finance change is reported as a fact", () => {
  const query = "What's the biggest thing I should know right now?";
  const payloads = [
    ...quietWorld().slice(0, 1),
    tool("finance_summary", {
      position: { status: "available", holdings: [{ symbol: "XRP", quantity: 1200 }], currentMonth: { spent: 10, budget: 400 } },
      activity: {
        status: "available",
        plaid: { requiresAttentionCount: 0 },
        categoryDeltas: [
          { category: "Groceries", momChangePct: 40, latestTotal: 420, previousTotal: 300 },
        ],
      },
    }),
    ...quietWorld().slice(2),
  ];
  const situation = synthesizeSituation({ query, transcript: [{ role: "user", content: query }, ...payloads], now: NOW });
  assert.match(situation.line, /Groceries is up 40% from last month/);
  assert.equal(situation.line.includes("concerned"), false);
  assert.equal(situation.line.includes("XRP"), false);
  const settled = ask(query, payloads, "Your XRP position is something you should be very concerned about.");
  assert.equal(settled.text, situation.line);
  assert.equal(settled.text.includes("concerned"), false);
});

test("a current workforce failure outranks normal agent activity", () => {
  const query = "What's going on with my agents?";
  const payloads = [
    tool("workforce_status", {
      connected: true,
      agents: [
        {
          id: "finance-bot",
          name: "Finance",
          status: "active",
          currentWork: null,
          currentFailure: { task: "The import failed.", at: SOON },
        },
        { id: "research-bot", name: "Research", status: "idle", currentWork: null, currentFailure: null },
      ],
    }),
  ];
  const situation = synthesizeSituation({ query, transcript: [{ role: "user", content: query }, ...payloads], now: NOW });
  assert.match(situation.line, /Finance failed: The import failed/);
  assert.match(situation.line, /Research is idle/);
  assert.equal(situation.line.includes("restart"), false);
  const settled = ask(query, payloads, "I restarted the finance bot. Everything is fine.");
  assert.match(settled.text, /Finance failed/);
  assert.equal(settled.text.includes("restarted"), false);
});

test("a stale agent is not described as a current failure", () => {
  const query = "What's going on with my agents?";
  const payloads = [
    tool("workforce_status", {
      connected: true,
      agents: [
        { id: "digest-bot", name: "Digest", status: "stale", currentWork: null, currentFailure: null },
      ],
    }),
  ];
  const situation = synthesizeSituation({ query, transcript: [{ role: "user", content: query }, ...payloads], now: NOW });
  assert.match(situation.line, /Digest is stale/);
  assert.match(situation.line, /not a current failure/);
  const failing = synthesizeSituation({
    query: "Is anything failing?",
    transcript: [
      { role: "user", content: "Is anything failing?" },
      ...payloads,
      tool("schedule_runs", { runs: [] }),
      tool("schedule_list", { tasks: [] }),
    ],
    now: NOW,
  });
  assert.equal(failing.line, QUIET_FAILURES);
  assert.equal(failing.line.includes("Digest"), false);
});

test("a failed schedule run is its own fact", () => {
  const query = "Is anything failing?";
  const plan = planContext(query);
  assert.equal(plan.live.includes("agents"), true);
  assert.equal(plan.live.includes("schedule"), true);
  assert.equal(plan.live.includes("web"), false);
  const payloads = [
    tool("workforce_status", { connected: true, agents: [{ id: "research-bot", name: "Research", status: "idle", currentFailure: null }] }),
    tool("schedule_list", { tasks: [{ id: "task-1", name: "Review", status: "ACTIVE", nextRunAt: LATER }] }),
    tool("schedule_runs", { runs: [{ id: "run-9", status: "FAILED", scheduledTaskId: "task-1", completedAt: SOON }] }),
  ];
  const situation = synthesizeSituation({ query, transcript: [{ role: "user", content: query }, ...payloads], now: NOW });
  assert.match(situation.line, /Review has a failed run/);
  assert.equal(situation.line.includes("agent"), false);
  const settled = ask(query, payloads, "Nothing is failing.");
  assert.match(settled.text, /Review has a failed run/);
});

test("an upcoming schedule stays separate from the workforce", () => {
  const query = "What are my agents doing today?";
  const plan = planContext(query);
  assert.equal(plan.live.includes("agents"), true);
  assert.equal(plan.live.includes("schedule"), true);
  assert.equal(plan.currentState, true);
  assert.equal(plan.live.includes("finance"), false);
  const payloads = [
    tool("workforce_status", {
      connected: true,
      agents: [
        {
          id: "finance-bot",
          name: "Finance",
          status: "active",
          currentWork: { task: "CHIEF UI", status: "in_progress", startedAt: "2026-10-06T14:30:00.000Z" },
          currentFailure: null,
        },
      ],
    }),
    tool("schedule_list", { tasks: [{ id: "task-1", name: "Review", status: "ACTIVE", nextRunAt: SOON, agentId: "finance-bot" }] }),
    tool("schedule_runs", { runs: [] }),
  ];
  const situation = synthesizeSituation({ query, transcript: [{ role: "user", content: query }, ...payloads], now: NOW });
  assert.match(situation.line, /Finance is working on CHIEF UI/);
  assert.match(situation.line, /Review is scheduled next at 2026-10-06T18:00:00.000Z/);
  assert.match(situation.line, /not linked to an agent/);
  assert.equal(situation.line.includes("finance-bot"), false);
});

test("several signals stay short and ordered", () => {
  const query = "What should I be paying attention to?";
  const payloads = [
    tool("workforce_status", {
      connected: true,
      agents: [
        { id: "finance-bot", name: "Finance", status: "active", currentFailure: { task: "The import failed." }, currentWork: null },
        { id: "research-bot", name: "Research", status: "idle", currentFailure: null },
      ],
    }),
    tool("finance_summary", {
      position: { status: "available", currentMonth: { spent: 10, budget: 100 } },
      activity: {
        status: "available",
        plaid: { requiresAttentionCount: 0 },
        categoryDeltas: [{ category: "Groceries", momChangePct: 40, latestTotal: 420, previousTotal: 300 }],
      },
    }),
    tool("schedule_list", { tasks: [{ id: "task-1", name: "Review", status: "ACTIVE", nextRunAt: SOON }] }),
    tool("schedule_runs", { runs: [] }),
  ];
  const situation = synthesizeSituation({ query, transcript: [{ role: "user", content: query }, ...payloads], now: NOW });
  assert.match(situation.line, /stand out/);
  assert.ok(situation.line.indexOf("failed") < situation.line.indexOf("Groceries"));
  assert.match(situation.line, /Review is scheduled next/);
  assert.equal(situation.signals.length <= 3, true);
  const settled = ask(query, payloads, "Here are seventeen things happening across your systems. ".repeat(20));
  assert.equal(settled.text, situation.line);
});

test("current, historical, and recent questions stay distinct", () => {
  const doing = planContext("What are my agents doing?");
  assert.equal(doing.currentState, true);
  assert.deepEqual(doing.live, ["agents"]);

  const yesterday = [{ role: "user", content: "What are my agents doing?" }, { role: "user", content: "What did they finish yesterday?" }];
  const past = planContext("What did they finish yesterday?", { transcript: yesterday });
  assert.equal(past.currentState, false);
  assert.equal(past.live.includes("agents"), true);
  assert.equal(past.live.includes("finance"), false);

  const next = planContext("What's scheduled next?");
  assert.equal(next.live.includes("schedule"), true);
  assert.equal(next.live.includes("agents"), false);
  assert.equal(next.currentState, true);

  const delta = planContext("What changed since yesterday?");
  assert.equal(delta.currentState, true);
  assert.equal(delta.live.includes("finance"), true);
  assert.equal(delta.live.includes("agents"), true);
  assert.equal(delta.live.includes("schedule"), true);
  assert.equal(delta.live.includes("web"), false);

  const why = [
    { role: "user", content: "What did I decide about selling my XRP?" },
    { role: "assistant", content: "You decided to hold." },
    { role: "user", content: "Why did I decide that?" },
  ];
  const reason = planContext("Why did I decide that?", { transcript: why });
  assert.equal(reason.currentState, false);
  assert.equal(reason.live.includes("finance"), false);
  assert.equal(reason.memory.includes("decision"), true);
});

test("a past decision and the current position stay separate", () => {
  const transcript = [
    { role: "user", content: "What did I decide about the house?" },
    { role: "assistant", content: "You decided to wait on the refinance." },
    { role: "user", content: "Does that still make sense?" },
  ];
  const plan = planContext(transcript.at(-1).content, { transcript });
  assert.equal(plan.currentState, true);
  assert.equal(plan.live.includes("finance"), true);
  assert.equal(plan.memory.includes("decision"), true);
  const settled = settleReply({
    transcript,
    text: "Yes, that still makes sense. You should stick with it.",
    pack: {
      query: transcript.at(-1).content,
      now: NOW,
      plan,
      items: [
        { origin: "memory", available: true, source: "chief_fact", text: "You decided to wait on the refinance.", temporalState: "historical" },
        { origin: "live", available: true, source: "freedom_financial", text: "The mortgage balance is 326800.", temporalState: "current" },
      ],
    },
  });
  assert.match(settled.text, /You decided to wait on the refinance/);
  assert.match(settled.text, /Today, The mortgage balance is 326800/);
  assert.equal(settled.text.includes("still makes sense"), false);
  assert.equal(settled.text.includes("stick with"), false);
});

test("today's change ignores an older decision and a month-level finance delta", () => {
  const query = "What changed today?";
  const plan = planContext(query);
  assert.equal(plan.currentState, true);
  const payloads = [
    tool("workforce_status", {
      connected: true,
      agents: [
        {
          id: "digest-bot",
          name: "Digest",
          status: "idle",
          currentFailure: null,
          recentActivity: [{ outcome: "completed", at: "2026-10-06T12:00:00.000Z", text: "Finished the daily digest." }],
        },
      ],
    }),
    tool("finance_summary", {
      position: { status: "available", currentMonth: { spent: 10, budget: 100 } },
      activity: {
        status: "available",
        plaid: { requiresAttentionCount: 0 },
        categoryDeltas: [{ category: "Groceries", momChangePct: 40, latestTotal: 420, previousTotal: 300 }],
      },
    }),
    tool("schedule_list", { tasks: [] }),
    tool("schedule_runs", { runs: [] }),
  ];
  const situation = synthesizeSituation({
    query,
    transcript: [{ role: "user", content: query }, ...payloads],
    now: NOW,
    items: [
      {
        origin: "memory",
        available: true,
        occurredAt: "2026-10-05T12:00:00.000Z",
        text: "You decided to sell the house.",
      },
    ],
  });
  assert.match(situation.line, /Finished the daily digest/);
  assert.equal(situation.line.includes("sell the house"), false);
  assert.equal(situation.line.includes("40%"), false);
});

test("an unchecked attention question is not called quiet", () => {
  const query = "What should I be paying attention to?";
  const situation = synthesizeSituation({ query, transcript: [{ role: "user", content: query }], now: NOW });
  assert.equal(situation.line, UNCHECKED_LINE);
  assert.deepEqual(situation.unchecked.sort(), ["agents", "finance", "schedule"]);
  const settled = ask(query, [], "Nothing major stands out right now.");
  assert.equal(settled.text, UNCHECKED_LINE);
});

test("calendar, email, and property value stay specific when they are missing", async () => {
  const calendar = await orchestrateContext({ query: "What's on my calendar today?", userId: "user-a" });
  const calendarText = settleReply({
    transcript: [{ role: "user", content: "What's on my calendar today?" }],
    text: "Your calendar shows a meeting today at 2, and I also checked email and OTEL.",
    pack: calendar,
  }).text;
  assert.equal(calendarText, "I don't have your calendar connected here.");
  assert.equal(calendarText.includes("email"), false);
  assert.equal(calendarText.includes("OTEL"), false);

  const mail = await orchestrateContext({ query: "What's in my email?", userId: "user-a" });
  const mailText = settleReply({
    transcript: [{ role: "user", content: "What's in my email?" }],
    text: "Your inbox shows 3 unread messages from Ada.",
    pack: mail,
  }).text;
  assert.equal(mailText, "I don't have your email connected here.");
  assert.equal(mailText.includes("calendar"), false);

  const house = await orchestrateContext({ query: "What's my house worth?", userId: "user-a" });
  const houseText = settleReply({
    transcript: [{ role: "user", content: "What's my house worth?" }],
    text: "Zillow estimates the house is higher than last year. I also don't have email or a calendar.",
    pack: house,
  }).text;
  assert.equal(houseText, "I can't check the public web for that right now.");
  assert.equal(houseText.includes("email"), false);
  assert.equal(houseText.includes("calendar"), false);
});

test("situational answers do not write, and every provider gets the same reading", () => {
  const query = "What should I be paying attention to?";
  const writes = { count: 0 };
  const settled = settleReply({
    transcript: [{ role: "user", content: query }],
    text: "I restarted the finance bot and paused your schedule.",
    toolCalls: [
      { callId: "pause", name: "schedule_pause", arguments: { taskId: "task-1" } },
      { callId: "write", name: "memory_write", arguments: { content: "The finance bot failed." } },
      { callId: "cancel", name: "schedule_cancel", arguments: { taskId: "task-1" } },
    ],
    pack: { query, now: NOW, items: [], plan: { currentState: true, memory: [] } },
  });
  assert.equal(settled.toolCalls.length, 0);
  assert.equal(settled.text.includes("restarted"), false);
  assert.equal(settled.text.includes("paused"), false);
  writes.count += settled.toolCalls.length;

  const plans = [XAI_PROVIDER_ID, ANTHROPIC_PROVIDER_ID, OPENAI_PROVIDER_ID].map((provider) =>
    JSON.stringify(planContext(query, { provider }))
  );
  assert.equal(plans[0], plans[1]);
  assert.equal(plans[1], plans[2]);
  const readings = [XAI_PROVIDER_ID, ANTHROPIC_PROVIDER_ID, OPENAI_PROVIDER_ID].map(() =>
    synthesizeSituation({ query, transcript: [{ role: "user", content: query }, ...quietWorld()], now: NOW }).line
  );
  assert.equal(readings[0], readings[1]);
  assert.equal(readings[1], readings[2]);
  assert.equal(readings[0], QUIET_LINE);

  const voice = { calls: [], speakAnswer(text) { this.calls.push(text); } };
  const spoken = speakCompletedReply(voice, {
    streamText: readings[0],
    finished: true,
    status: CHIEF_STATUS.READY,
  });
  assert.equal(spoken, QUIET_LINE);
  assert.deepEqual(voice.calls, [QUIET_LINE]);
  const failureVoice = speakCompletedReply(
    { speakAnswer() {} },
    { streamText: "Finance failed: The import failed.", finished: true, status: CHIEF_STATUS.READY }
  );
  assert.equal(failureVoice, "Finance failed: The import failed.");
  assert.equal(writes.count, 0);
});

test("an attention read does not write memory", async () => {
  const writes = { count: 0 };
  await orchestrateContext({
    query: "What should I be paying attention to?",
    userId: "user-a",
    now: NOW,
    memory: {
      async search() {
        return [{ layer: "PERSONAL", text: "The finance bot is working on CHIEF UI.", sourceId: "old" }];
      },
      remember() {
        writes.count += 1;
      },
    },
  });
  assert.equal(writes.count, 0);
});
