// Cross-system source selection. Readers and tools that exist are joined.
// A system with no reader and no tool stays missing.

import test from "node:test";
import assert from "node:assert/strict";

import { assembleSystemPrompt } from "../server/chief/context/assemble.js";
import {
  conversationMove,
  MOVE,
  renderConversationMove,
  settleReply,
} from "../server/chief/context/behavior.js";
import {
  orchestrateContext,
  planContext,
  renderContextPackage,
} from "../server/chief/context/orchestrate.js";
import { buildWorkingMemory } from "../server/chief/memory/working.js";
import { CHIEF_STATUS } from "../src/utils/chiefProtocol.js";
import { normalizeChiefPreferences } from "../src/utils/chiefPreferences.js";
import { speakCompletedReply } from "../src/utils/chiefReplySpeech.js";

function memoryOf(rows, writes) {
  return {
    async search() {
      return rows;
    },
    remember() {
      writes.count += 1;
    },
  };
}

test("finance, price, history, and a current review use different sources", async () => {
  const holding = planContext("How much XRP do I own?");
  assert.deepEqual(holding.live, ["finance"]);
  assert.equal(holding.live.includes("web"), false);

  const worth = [
    { role: "user", content: "How much XRP do I own?" },
    { role: "assistant", content: "You own 2,500 XRP." },
    { role: "user", content: "What's it worth?" },
  ];
  assert.deepEqual(planContext("What's it worth?", { transcript: worth }).live, ["finance", "web"]);

  const decided = [
    ...worth,
    { role: "assistant", content: "About $6,750." },
    { role: "user", content: "What did I decide about selling it?" },
  ];
  const decision = planContext("What did I decide about selling it?", { transcript: decided });
  assert.equal(conversationMove(decided).kind, MOVE.CONTINUE);
  assert.equal(conversationMove(decided).referent, "XRP");
  assert.equal(conversationMove(decided).historical, true);
  assert.equal(decision.currentState, false);
  assert.equal(decision.live.includes("finance"), false);
  assert.equal(decision.live.includes("web"), false);
  assert.equal(decision.memory.includes("decision"), true);
  assert.equal(decision.memory.includes("episodic"), true);
  assert.match(renderConversationMove(decided), /today's numbers/);

  const review = [
    ...decided,
    { role: "assistant", content: "You decided to hold." },
    { role: "user", content: "Does that still make sense?" },
  ];
  const current = planContext("Does that still make sense?", { transcript: review });
  assert.equal(current.currentState, true);
  assert.equal(current.live.includes("finance"), true);
  assert.equal(current.memory.includes("decision"), true);

  const writes = { count: 0 };
  const pack = await orchestrateContext({
    query: "Does that still make sense?",
    userId: "user-a",
    transcript: review,
    memory: memoryOf(
      [{ layer: "EPISODIC", text: "You decided to hold XRP.", sourceId: "decision-1", score: 1 }],
      writes
    ),
    readers: {
      finance: async () => [{ text: "XRP quantity 2500", sourceId: "now" }],
    },
  });
  assert.equal(writes.count, 0);
  assert.equal(pack.authority[0].text, "XRP quantity 2500");
  assert.equal(pack.authority[0].origin, "live");
  const remembered = pack.items.find((item) => item.sourceId === "decision-1");
  assert.equal(remembered.temporalState, "historical");
  assert.match(renderContextPackage(pack), /override historical memory/);
  assert.match(renderContextPackage(pack), /past decision still holds/);
});

test("a house value can use finance, and a hypothetical does not search", () => {
  const worth = planContext("What's my house worth?");
  assert.equal(worth.live.includes("finance"), true);
  assert.equal(worth.live.includes("web"), true);

  const lower = [
    { role: "user", content: "What's my house worth?" },
    { role: "assistant", content: "The mortgage is about $326,800." },
    { role: "user", content: "What if Zillow is 10% lower?" },
  ];
  const hypothetical = planContext("What if Zillow is 10% lower?", { transcript: lower });
  assert.equal(hypothetical.live.includes("web"), false);
  assert.equal(conversationMove(lower).kind, MOVE.CONTINUE);

  const check = [
    ...lower,
    { role: "assistant", content: "I can pull Zillow if you want." },
    { role: "user", content: "Yeah, check it." },
  ];
  assert.equal(planContext("Yeah, check it.", { transcript: check }).live.includes("web"), true);
  const searched = settleReply({
    transcript: lower,
    text: "Looking that up. It would be about 10% less.",
    toolCalls: [{ callId: "web-1", name: "web_search", arguments: {} }],
  });
  assert.equal(searched.toolCalls.length, 0);
  assert.match(searched.text, /10%/);
  assert.doesNotMatch(searched.text, /Looking that up/);

  const unreadWeb = settleReply({
    transcript: [{ role: "user", content: "What's my house worth?" }],
    text: "Zillow says the house is worth $500,000.",
    pack: {
      plan: worth,
      unavailable: ["web"],
      items: [],
      authority: [{ origin: "live", available: true, text: "mortgage 326800" }],
    },
  });
  assert.equal(unreadWeb.text, "I can't check the public web for that right now.");
});

test("spending uses finance activity and an old decision does not replace it", async () => {
  const spent = planContext("How much did I spend last month?");
  assert.equal(spent.live.includes("finance"), true);
  assert.equal(spent.currentState, true);
  assert.equal(spent.memory.includes("episodic"), false);

  const pack = await orchestrateContext({
    query: "How much XRP do I own?",
    userId: "user-a",
    memory: {
      async search() {
        return [
          { layer: "EPISODIC", text: "The well pump failed.", sourceId: "well", score: 1 },
          { layer: "PERSONAL", text: "User owns 2000 XRP.", sourceId: "old", score: 1 },
        ];
      },
    },
    readers: {
      finance: async () => [{ text: "XRP quantity 2500", sourceId: "now" }],
    },
  });
  assert.equal(
    pack.items.some((item) => item.sourceId === "well"),
    false
  );
  assert.equal(pack.items.find((item) => item.sourceId === "old").superseded, true);
  assert.equal(pack.authority[0].sourceId, "now");
});

test("agents and schedules join, and a missing agent is not invented", async () => {
  const bots = [{ role: "user", content: "What are my Grok bots doing?" }];
  assert.deepEqual(planContext(bots[0].content, { transcript: bots }).live, ["agents"]);

  const working = [
    ...bots,
    { role: "assistant", content: "I don't currently have a live agent status for that." },
    { role: "user", content: "What are they working on?" },
  ];
  assert.equal(conversationMove(working).kind, MOVE.CONTINUE);
  assert.deepEqual(planContext("What are they working on?", { transcript: working }).live, [
    "agents",
  ]);
  assert.equal(buildWorkingMemory(working).referent, "grok");

  const scheduled = [
    ...working,
    { role: "assistant", content: "I still don't have a live agent status." },
    { role: "user", content: "Is any of that scheduled?" },
  ];
  const plan = planContext("Is any of that scheduled?", { transcript: scheduled });
  assert.equal(plan.live.includes("agents"), true);
  assert.equal(plan.live.includes("schedule"), true);
  assert.equal(plan.live.includes("finance"), false);
  assert.equal(plan.live.includes("calendar"), false);

  const missing = await orchestrateContext({
    query: "What are my Grok bots doing?",
    userId: "user-a",
    transcript: bots,
    availableTools: ["schedule_list"],
  });
  assert.equal(missing.unavailable.includes("agents"), true);
  assert.equal(missing.authority.length, 0);
  const invented = settleReply({
    transcript: bots,
    text: "Your Grokbot is currently working on the well.",
    pack: missing,
  });
  assert.equal(invented.text, "I don't currently have a live agent status for that.");

  const noSchedule = await orchestrateContext({
    query: "What is scheduled today?",
    userId: "user-a",
  });
  const guessed = settleReply({
    transcript: [{ role: "user", content: "What is scheduled today?" }],
    text: "The review is scheduled for today at 3.",
    pack: noSchedule,
  });
  assert.equal(guessed.text, "I don't have a schedule reading for that.");
  const called = settleReply({
    transcript: [{ role: "user", content: "What is scheduled today?" }],
    text: "Looking.",
    toolCalls: [{ callId: "s1", name: "schedule_list", arguments: {} }],
    pack: noSchedule,
  });
  assert.equal(called.toolCalls[0].name, "schedule_list");

  const connected = await orchestrateContext({
    query: "What are my Grok bots doing and is anything scheduled?",
    userId: "user-a",
    readers: {
      agents: async () => [{ text: "Grokbot is on the supplier review.", sourceId: "agent-1" }],
      schedule: async () => [
        {
          text: "Supplier review runs today.",
          sourceId: "task-1",
          dueAt: "2026-10-06T15:00:00.000Z",
        },
      ],
    },
  });
  assert.equal(
    connected.authority.some((item) => item.source === "grokbot"),
    true
  );
  assert.equal(
    connected.authority.some((item) => item.source === "scheduler"),
    true
  );
  const kept = settleReply({
    transcript: [
      { role: "user", content: "What are my Grok bots doing and is anything scheduled?" },
    ],
    text: "Grokbot is on the supplier review. It runs today.",
    pack: connected,
  });
  assert.match(kept.text, /supplier review/);
});

test("earlier conversations stay historical and a missing one is not filled in", async () => {
  const asked = [
    { role: "user", content: "How much XRP do I own?" },
    { role: "assistant", content: "You own 2,500 XRP." },
    { role: "user", content: "What did I tell you about that last month?" },
  ];
  const plan = planContext(asked.at(-1).content, { transcript: asked });
  assert.equal(conversationMove(asked).historical, true);
  assert.equal(conversationMove(asked).referent, "XRP");
  assert.equal(plan.currentState, false);
  assert.equal(plan.live.includes("finance"), false);
  assert.equal(plan.memory.includes("episodic"), true);
  assert.match(renderConversationMove(asked), /that period/);

  const found = await orchestrateContext({
    query: asked.at(-1).content,
    userId: "user-a",
    transcript: asked,
    memory: {
      async search() {
        return [
          {
            layer: "EPISODIC",
            text: "Last month you said you would hold XRP.",
            sourceId: "talk-1",
            score: 1,
          },
        ];
      },
    },
  });
  assert.equal(found.authority[0].sourceId, "talk-1");
  assert.equal(found.authority[0].temporalState, "historical");
  const repeated = settleReply({
    transcript: asked,
    text: "Last month you said you would hold.",
    pack: found,
  });
  assert.match(repeated.text, /hold/);

  const empty = await orchestrateContext({
    query: "What did I decide about selling it?",
    userId: "user-a",
    transcript: [
      { role: "user", content: "How much XRP do I own?" },
      { role: "user", content: "What did I decide about selling it?" },
    ],
    memory: {
      async search() {
        return [];
      },
    },
  });
  const invented = settleReply({
    transcript: empty.query
      ? [{ role: "user", content: "What did I decide about selling it?" }]
      : [],
    text: "You decided to sell half.",
    pack: empty,
  });
  assert.equal(invented.text, "I don't have a record of that.");
});

test("a current comparison keeps the decision and the live position", () => {
  const transcript = [
    { role: "user", content: "What did I decide about selling my XRP?" },
    { role: "assistant", content: "You decided to hold." },
    { role: "user", content: "How does that compare with where I am now?" },
  ];
  const plan = planContext(transcript.at(-1).content, { transcript });
  assert.equal(plan.currentState, true);
  assert.equal(plan.live.includes("finance"), true);
  assert.equal(plan.memory.includes("decision"), true);
  assert.equal(plan.memory.includes("episodic"), true);
});

test("attention uses finance and schedule, and unconnected systems stay unconnected", async () => {
  const plan = planContext("What should I be paying attention to?");
  assert.equal(plan.live.includes("finance"), true);
  assert.equal(plan.live.includes("schedule"), true);
  assert.equal(plan.live.includes("agents"), false);
  assert.equal(plan.live.includes("web"), false);
  assert.equal(plan.live.includes("email"), false);
  assert.equal(plan.live.includes("calendar"), false);

  const calendar = await orchestrateContext({
    query: "What's on my calendar today?",
    userId: "user-a",
  });
  assert.equal(calendar.plan.live.includes("calendar"), true);
  const invented = settleReply({
    transcript: [{ role: "user", content: "What's on my calendar today?" }],
    text: "Your calendar shows a meeting today at 2.",
    pack: calendar,
  });
  assert.equal(invented.text, "I don't have your calendar connected here.");

  const mail = await orchestrateContext({
    query: "What's in my email?",
    userId: "user-a",
  });
  const unread = settleReply({
    transcript: [{ role: "user", content: "What's in my email?" }],
    text: "Your inbox shows 3 unread messages from Ada.",
    pack: mail,
  });
  assert.equal(unread.text, "I don't have your email connected here.");

  assert.deepEqual(planContext("Where is that implemented in the codebase?").live, ["code"]);
});

test("the same cross-system plan is given to every provider, and voice speaks it", async () => {
  const transcript = [
    { role: "user", content: "How much XRP do I own?" },
    { role: "assistant", content: "You own 2,500 XRP." },
    { role: "user", content: "What did I decide about selling it?" },
  ];
  const facts = {
    async read() {
      return [];
    },
  };
  const plans = [];
  const prompts = [];
  for (const provider of ["xai", "anthropic", "openai"]) {
    plans.push(JSON.stringify(planContext(transcript.at(-1).content, { transcript, provider })));
    prompts.push(
      await assembleSystemPrompt({
        userId: "user-a",
        query: transcript.at(-1).content,
        facts,
        transcript,
        provider,
      })
    );
  }
  assert.equal(plans[0], plans[1]);
  assert.equal(plans[1], plans[2]);
  assert.equal(prompts[0], prompts[1]);
  assert.equal(prompts[1], prompts[2]);
  assert.equal(JSON.parse(plans[0]).live.includes("finance"), false);
  assert.equal(JSON.parse(plans[0]).memory.includes("decision"), true);

  const settled = settleReply({
    transcript: [{ role: "user", content: "What are my Grok bots doing?" }],
    text: "Your Grokbot is currently working on the well.",
    pack: {
      plan: { currentState: true, memory: [] },
      unavailable: ["agents"],
      items: [],
      authority: [],
    },
  });
  const voice = {
    calls: [],
    speakAnswer(text) {
      this.calls.push(text);
    },
  };
  const spoken = speakCompletedReply(voice, {
    streamText: settled.text,
    finished: true,
    status: CHIEF_STATUS.READY,
    source: "voice",
    preferences: normalizeChiefPreferences(null),
  });
  assert.equal(spoken, "I don't currently have a live agent status for that.");
  assert.deepEqual(voice.calls, [spoken]);
});
