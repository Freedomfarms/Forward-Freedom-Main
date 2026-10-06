// Regressions for P0/P1 failures found in the adversarial evaluation.
// These lock the failed behavior. They do not add a new reasoning layer.

import test from "node:test";
import assert from "node:assert/strict";

import { conversationMove, settleReply } from "../server/chief/context/behavior.js";
import { planContext } from "../server/chief/context/orchestrate.js";
import { collectPriorities } from "../server/chief/context/relevance.js";
import { synthesizeSituation } from "../server/chief/context/situation.js";
import { applyMemoryCommands } from "../server/chief/memory/commands.js";
import { MemoryFactStore } from "../server/chief/memory/facts.js";

const NOW = new Date("2026-10-06T15:00:00.000Z");

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

test("forget that does not delete every fact that contains the word", async () => {
  const facts = new MemoryFactStore();
  await facts.write({
    userId: "user-a",
    content: "You decided that the refinance can wait",
    trustTier: "AUTO",
    source: "user",
  });
  const wiped = await applyMemoryCommands({ facts, userId: "user-a", userText: "Forget that." });
  assert.equal(wiped.action, null);
  const left = await facts.read({ userId: "user-a", limit: 10 });
  assert.equal(left.length, 1);

  const removed = await applyMemoryCommands({
    facts,
    userId: "user-a",
    userText: "Forget that the refinance can wait.",
  });
  assert.equal(removed.action, "forget");
  assert.equal(removed.deleted, 1);
});

test("a past intention stays historical and an invented decision is not kept", () => {
  const transcript = [
    { role: "user", content: "How much XRP do I have?" },
    { role: "assistant", content: "You have about 12,400 XRP." },
    { role: "user", content: "What was I thinking about doing with it?" },
  ];
  const plan = planContext(transcript.at(-1).content, { transcript });
  assert.equal(plan.currentState, false);
  assert.equal(plan.live.includes("finance"), false);
  assert.equal(plan.memory.includes("decision"), true);
  const settled = settleReply({
    transcript,
    text: "You decided to sell it last month.",
    pack: { query: transcript.at(-1).content, plan, items: [], now: NOW },
  });
  assert.equal(settled.text, "I don't have a record of that.");
});

test("two open subjects are not resolved by guessing, and one subject is", () => {
  const competing = [
    { role: "user", content: "Tell me about XRP." },
    { role: "assistant", content: "XRP is a holding." },
    { role: "user", content: "Tell me about the house." },
    { role: "assistant", content: "The house has a mortgage." },
    { role: "user", content: "How much is it worth?" },
  ];
  const unsure = conversationMove(competing);
  assert.equal(unsure.ambiguous, true);
  assert.equal(unsure.referent, null);
  assert.deepEqual(planContext("How much is it worth?", { transcript: competing }).live, []);
  const asked = settleReply({
    transcript: competing,
    text: "The house is worth $647,000.",
    toolCalls: [{ callId: "f", name: "finance_summary", arguments: {} }],
  });
  assert.equal(asked.toolCalls.length, 0);
  assert.match(asked.text, /XRP/);
  assert.match(asked.text, /house/);

  const clear = [
    { role: "user", content: "How much XRP do I have?" },
    { role: "assistant", content: "You have about 12,400 XRP." },
    { role: "user", content: "What is it worth?" },
  ];
  const sure = conversationMove(clear);
  assert.equal(sure.ambiguous, false);
  assert.equal(sure.referent, "XRP");
  assert.equal(planContext("What is it worth?", { transcript: clear }).live.includes("web"), true);
});

test("an abandoned spending goal does not outrank the priority that replaced it", () => {
  const groceries = tool("finance_summary", {
    position: { status: "available", currentMonth: { spent: 10, budget: 400 } },
    activity: {
      status: "available",
      plaid: { requiresAttentionCount: 0 },
      categoryDeltas: [{ category: "Groceries", momChangePct: 40, latestTotal: 420, previousTotal: 300 }],
    },
  });
  const quietAgents = tool("workforce_status", { connected: true, agents: [] });
  const quietSchedule = [
    tool("schedule_list", { tasks: [] }),
    tool("schedule_runs", { runs: [] }),
  ];
  const before = [
    { role: "user", content: "I'm trying to cut spending." },
    { role: "user", content: "What should I be paying attention to?" },
    groceries,
    quietAgents,
    ...quietSchedule,
  ];
  const connected = synthesizeSituation({
    query: "What should I be paying attention to?",
    transcript: before,
    now: NOW,
  });
  assert.match(connected.line, /Groceries is up 40% from last month/);
  assert.match(connected.line, /cut spending/);
  assert.match(connected.line, /conflicts/);

  const after = [
    { role: "user", content: "I'm trying to cut spending." },
    { role: "user", content: "Actually, forget that. I'm focused on paying off the mortgage now." },
    { role: "user", content: "What should I be paying attention to?" },
    groceries,
    quietAgents,
    ...quietSchedule,
  ];
  const priorities = collectPriorities({ transcript: after });
  assert.equal(priorities.some((item) => /cut spending/.test(item.text)), false);
  assert.equal(priorities.some((item) => /mortgage/.test(item.text)), true);
  const line = synthesizeSituation({
    query: "What should I be paying attention to?",
    transcript: after,
    now: NOW,
  }).line;
  assert.equal(line.includes("cut spending"), false);
});

test("since then stays on the financial decision, and a bare status check can be quiet", () => {
  const transcript = [
    { role: "user", content: "What did I decide about refinancing?" },
    { role: "assistant", content: "You decided to wait." },
    { role: "user", content: "What's changed since then?" },
  ];
  const plan = planContext("What's changed since then?", { transcript });
  assert.deepEqual(plan.live, ["finance"]);
  assert.equal(plan.currentState, true);
  assert.equal(plan.live.includes("agents"), false);

  const world = planContext("What's going on?");
  assert.equal(world.live.includes("finance"), true);
  assert.equal(world.live.includes("agents"), true);
  assert.equal(world.live.includes("schedule"), true);
  const house = planContext("What's going on with the house?");
  assert.equal(house.live.includes("finance"), true);

  const care = [
    { role: "user", content: "What's going on with my bots?" },
    { role: "assistant", content: "Finance is active." },
    { role: "user", content: "Which one matters?" },
  ];
  const follow = planContext("Which one matters?", { transcript: care });
  assert.deepEqual(follow.live, []);
  const noticed = planContext("What should I care about?");
  assert.equal(noticed.live.includes("finance"), true);
  assert.equal(noticed.live.includes("agents"), true);
});

test("a reaction does not keep a tool, and a cancellation does not keep the search", () => {
  const transcript = [
    { role: "user", content: "My XRP position is up." },
    { role: "assistant", content: "It is up." },
    { role: "user", content: "That's the number I was looking for." },
  ];
  const move = conversationMove(transcript);
  assert.equal(move.kind, "acknowledge");
  const settled = settleReply({
    transcript,
    text: "Good.",
    toolCalls: [{ callId: "f", name: "finance_summary", arguments: {} }],
  });
  assert.equal(settled.toolCalls.length, 0);

  const question = conversationMove([
    { role: "user", content: "My XRP position is up." },
    { role: "user", content: "That's good — what does that mean for my portfolio?" },
  ]);
  assert.equal(question.kind, "continue");

  const cancelled = settleReply({
    transcript: [
      { role: "user", content: "What if Zillow is 100 grand lower?" },
      { role: "user", content: "Never mind." },
    ],
    text: "Checking Zillow now.",
    toolCalls: [{ callId: "w", name: "web_search", arguments: { q: "zillow" } }],
  });
  assert.equal(cancelled.toolCalls.length, 0);
  assert.equal(cancelled.text, "Okay.");
});
