// Real conversations against the existing move, plan, and reply guard.
// These check behavior, not a scripted answer.

import test from "node:test";
import assert from "node:assert/strict";

import { assembleSystemPrompt } from "../server/chief/context/assemble.js";
import { conversationMove, MOVE, settleReply } from "../server/chief/context/behavior.js";
import { createChiefTurnServices } from "../server/chief/context/wire.js";
import { orchestrateContext, planContext } from "../server/chief/context/orchestrate.js";
import { MemoryFactStore } from "../server/chief/memory/facts.js";
import { buildWorkingMemory } from "../server/chief/memory/working.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { TurnMachine } from "../server/chief/runtime/turn.js";
import { CHIEF_STATUS } from "../src/utils/chiefProtocol.js";
import { normalizeChiefPreferences } from "../src/utils/chiefPreferences.js";
import { speakCompletedReply } from "../src/utils/chiefReplySpeech.js";

const webCall = { callId: "web-1", name: "web_search", arguments: { query: "xrp" } };
const financeCall = { callId: "fin-1", name: "finance_summary", arguments: {} };

function walk(turns) {
  const transcript = [];
  const steps = [];
  for (const turn of turns) {
    transcript.push({ role: "user", content: turn.user });
    const move = conversationMove(transcript);
    const plan = planContext(turn.user, { transcript });
    const settled = settleReply({
      transcript,
      text: turn.model ?? "",
      toolCalls: turn.tools ?? [],
      pack: turn.pack ?? null,
    });
    steps.push({ move, plan, settled });
    transcript.push({ role: "assistant", content: turn.reply ?? settled.text });
  }
  return steps;
}

test("a finance conversation keeps the subject, then stops", () => {
  const live = {
    plan: { currentState: true },
    authority: [{ origin: "live", available: true, text: "XRP quantity 2500" }],
  };
  const steps = walk([
    {
      user: "How much XRP do I own?",
      model:
        "Certainly! Based on the information available, you own 2,500 XRP. This represents a meaningful position. Would you like me to analyze it?",
      pack: live,
      reply: "You own 2,500 XRP.",
    },
    {
      user: "What's it worth?",
      model:
        "I checked the market. At the current price, that's about $6,750. I can also review the rest.",
      tools: [financeCall, webCall],
      pack: live,
      reply: "At the current price, that's about $6,750.",
    },
    {
      user: "What if it hits five bucks?",
      model: "Looking that up. At $5, your 2,500 XRP would be worth $12,500.",
      tools: [webCall],
      pack: live,
      reply: "At $5, your 2,500 XRP would be worth $12,500.",
    },
    {
      user: "Damn.",
      model: "I can also pull a full market report. Would you like me to?",
      tools: [webCall],
    },
    {
      user: "What about my house?",
      model: "The house is about $647,000.",
      reply: "The house is about $647,000.",
    },
    {
      user: "What if Zillow says it's worth $100k less?",
      model: "I'll search Zillow now. It would be about $100,000 less.",
      tools: [webCall],
      pack: live,
    },
    {
      user: "Yeah, check it.",
      model: "Looking now.",
      tools: [webCall],
      reply: "Zillow has it lower.",
    },
    {
      user: "Thanks.",
      model: "You're welcome. I can also analyze your portfolio.",
      tools: [financeCall],
    },
  ]);

  assert.deepEqual(steps[0].plan.live, ["finance"]);
  assert.match(steps[0].settled.text, /2,500 XRP/);
  assert.doesNotMatch(steps[0].settled.text, /Certainly|meaningful position|Would you like/);

  assert.equal(steps[1].move.kind, MOVE.CONTINUE);
  assert.equal(steps[1].move.referent, "XRP");
  assert.deepEqual(steps[1].plan.live, ["finance", "web"]);
  assert.equal(steps[1].settled.toolCalls.length, 2);

  assert.equal(steps[2].move.referent, "XRP");
  assert.equal(steps[2].plan.live.includes("finance"), true);
  assert.equal(steps[2].plan.live.includes("web"), false);
  assert.deepEqual(steps[2].settled.toolCalls, []);
  assert.match(steps[2].settled.text, /\$12,500/);
  assert.doesNotMatch(steps[2].settled.text, /Looking that up/);

  assert.equal(steps[3].move.kind, MOVE.ACKNOWLEDGE);
  assert.deepEqual(steps[3].plan.live, []);
  assert.deepEqual(steps[3].settled.toolCalls, []);
  assert.doesNotMatch(steps[3].settled.text, /Would you like|report/);

  assert.equal(steps[4].move.kind, MOVE.CONTINUE);
  assert.equal(steps[4].move.referent, "house");
  assert.equal(steps[4].plan.live.includes("finance"), true);
  assert.equal(steps[4].plan.live.includes("web"), false);

  assert.equal(steps[5].move.kind, MOVE.CONTINUE);
  assert.equal(steps[5].plan.live.includes("web"), false);
  assert.deepEqual(steps[5].settled.toolCalls, []);
  assert.match(steps[5].settled.text, /\$100,000/);

  assert.equal(steps[6].move.kind, MOVE.CONFIRM);
  assert.equal(steps[6].move.pullsPublicSource, true);
  assert.equal(steps[6].plan.live.includes("web"), true);
  assert.equal(steps[6].settled.toolCalls[0].name, "web_search");

  assert.equal(steps[7].move.kind, MOVE.ACKNOWLEDGE);
  assert.deepEqual(steps[7].plan.live, []);
  assert.deepEqual(steps[7].settled.toolCalls, []);
  assert.doesNotMatch(steps[7].settled.text, /portfolio|analyze/);
});

test("a new topic does not inherit the previous subject", () => {
  const steps = walk([
    { user: "How much XRP do I own?", reply: "You own 2,500 XRP." },
    { user: "What's the weather?" },
    { user: "What about my house?" },
  ]);
  assert.equal(steps[1].move.kind, MOVE.DIRECT);
  assert.equal(steps[1].plan.live.includes("finance"), false);
  assert.equal(steps[1].move.referent === "XRP", false);
  assert.equal(steps[2].move.referent, "house");
  assert.equal(steps[2].plan.live.includes("finance"), true);
  assert.equal(
    buildWorkingMemory([
      { role: "user", content: "How much XRP do I own?" },
      { role: "assistant", content: "You own 2,500 XRP." },
      { role: "user", content: "What's the weather?" },
      { role: "user", content: "What about my house?" },
    ]).referent,
    "house"
  );
});

test("a correction repairs the reference and keeps the task", () => {
  const steps = walk([
    { user: "How much is my house worth?", reply: "The house is about $647,000." },
    { user: "No, I meant the rental property." },
  ]);
  assert.equal(steps[1].move.kind, MOVE.CONTINUE);
  assert.equal(steps[1].move.repairs, true);
  assert.equal(steps[1].move.referent, "rental");
  assert.equal(steps[1].plan.live.includes("finance"), true);
  assert.match(steps[1].plan.memory.join(" "), /working/);
});

test("a cancellation stops the work", async () => {
  const steps = walk([
    { user: "Check Zillow for my house.", reply: "I can check Zillow." },
    {
      user: "Actually, never mind.",
      model: "I'll keep searching Zillow and I can also summarize the house.",
      tools: [webCall],
    },
  ]);
  assert.equal(steps[0].plan.live.includes("web"), true);
  assert.equal(steps[1].move.kind, MOVE.CANCEL);
  assert.deepEqual(steps[1].plan.live, []);
  assert.deepEqual(steps[1].settled.toolCalls, []);
  assert.doesNotMatch(steps[1].settled.text, /searching|summarize/);

  const executed = [];
  const engine = {
    async openStream() {
      return {
        fullStream: (async function* stream() {
          yield { type: "text-delta", text: "I'll keep searching Zillow." };
          yield { type: "tool-call", toolCallId: "web-1", toolName: "web_search", input: {} };
        })(),
        finalize: async () => ({
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      };
    },
    async generate() {
      return { content: "[]" };
    },
  };
  const services = createChiefTurnServices({ facts: new MemoryFactStore(), engine });
  const result = await new TurnMachine({
    store: new MemoryCheckpointStore(),
    engine,
    toolExecutor: {
      async execute(call) {
        executed.push(call.name);
        return { output: "should not run", isError: false };
      },
    },
    contextAssembler: services.contextAssembler,
    settleModelStep: services.settleModelStep,
  }).run({
    userId: "user-a",
    submission: {
      id: "sub-cancel",
      op: { type: "message", message: { text: "Actually, never mind." } },
    },
    toolSpecs: [
      {
        name: "web_search",
        description: "search",
        parameters: { type: "object", properties: {} },
        requiresConfirmation: false,
      },
    ],
  });
  assert.deepEqual(executed, []);
  assert.equal(JSON.stringify(result.checkpoint.transcript).includes("web_search"), false);
});

test("a reaction stays a reaction, and a reaction plus a question does not", () => {
  const prior = [
    { role: "user", content: "How much is my house worth?" },
    { role: "assistant", content: "The house is about $647,000." },
  ];
  for (const line of [
    "Thanks.",
    "Great.",
    "That's actually not bad.",
    "Damn.",
    "Interesting.",
    "That changes things.",
    "That's exactly what I needed.",
  ]) {
    const transcript = [...prior, { role: "user", content: line }];
    const move = conversationMove(transcript);
    const settled = settleReply({
      transcript,
      text: "### Summary\nI checked the mortgage and I can also keep going. Would you like me to?",
      toolCalls: [financeCall],
    });
    assert.equal(move.kind, MOVE.ACKNOWLEDGE, line);
    assert.deepEqual(planContext(line, { transcript }).live, [], line);
    assert.deepEqual(settled.toolCalls, [], line);
    assert.doesNotMatch(settled.text, /Summary|Would you like|mortgage/);
  }

  const question = [
    ...prior,
    { role: "user", content: "That's not bad — what does that do to my monthly payment?" },
  ];
  const asked = conversationMove(question);
  const answered = settleReply({
    transcript: question,
    text: "The payment would drop by about $420 a month.",
    toolCalls: [financeCall],
  });
  assert.equal(asked.kind, MOVE.CONTINUE);
  assert.equal(asked.kind === MOVE.ACKNOWLEDGE, false);
  assert.equal(answered.toolCalls[0].name, "finance_summary");
  assert.match(answered.text, /\$420/);
});

test("an unclear subject is asked, and a clear one is not", () => {
  const ambiguous = [
    { role: "user", content: "Look at my XRP and my house." },
    { role: "assistant", content: "You have 2,500 XRP, and the house is about $647K." },
    { role: "user", content: "How much is it worth?" },
  ];
  const move = conversationMove(ambiguous);
  assert.equal(move.ambiguous, true);
  assert.equal(move.referent, null);
  assert.deepEqual(planContext("How much is it worth?", { transcript: ambiguous }).live, []);
  const guessed = settleReply({
    transcript: ambiguous,
    text: "The house is worth $647,000.",
    toolCalls: [financeCall, webCall],
  });
  assert.deepEqual(guessed.toolCalls, []);
  assert.match(guessed.text, /\?/);
  assert.match(guessed.text, /XRP/);
  assert.match(guessed.text, /house/);
  assert.doesNotMatch(guessed.text, /647,000/);

  const asking = settleReply({
    transcript: ambiguous,
    text: "Do you mean the house or the XRP?",
    toolCalls: [webCall],
  });
  assert.equal(asking.text, "Do you mean the house or the XRP?");
  assert.deepEqual(asking.toolCalls, []);

  const clear = [
    { role: "user", content: "How much XRP do I own?" },
    { role: "assistant", content: "You own 2,500 XRP." },
    { role: "user", content: "What's it worth?" },
  ];
  assert.equal(conversationMove(clear).ambiguous, false);
  assert.equal(conversationMove(clear).referent, "XRP");
  assert.deepEqual(planContext("What's it worth?", { transcript: clear }).live, ["finance", "web"]);

  const missing = [{ role: "user", content: "How much is it worth?" }];
  const invented = settleReply({
    transcript: missing,
    text: "It's worth $6,750.",
    toolCalls: [webCall],
    pack: { plan: { currentState: true }, authority: [] },
  });
  assert.deepEqual(invented.toolCalls, []);
  assert.equal(invented.text, "Which one do you mean?");
  assert.doesNotMatch(invented.text, /6,750/);
});

test("recall, explanation, and a current review are different operations", () => {
  const recall = [{ role: "user", content: "What did I decide about refinancing?" }];
  const recalled = planContext(recall[0].content, { transcript: recall });
  assert.equal(recalled.currentState, false);
  assert.equal(recalled.live.includes("finance"), false);
  assert.equal(recalled.memory.includes("decision"), true);

  const why = [
    ...recall,
    { role: "assistant", content: "You decided to wait for a lower rate." },
    { role: "user", content: "Why did I decide that?" },
  ];
  const explanation = planContext("Why did I decide that?", { transcript: why });
  assert.equal(conversationMove(why).kind, MOVE.CONTINUE);
  assert.equal(explanation.currentState, false);
  assert.equal(explanation.memory.includes("decision"), true);
  assert.equal(explanation.live.includes("finance"), false);

  const today = [
    ...why,
    { role: "assistant", content: "The rate at the time was higher than you wanted." },
    { role: "user", content: "Does that still make sense today?" },
  ];
  const review = planContext("Does that still make sense today?", { transcript: today });
  assert.equal(review.currentState, true);
  assert.equal(review.live.includes("finance"), true);
  assert.equal(review.memory.includes("decision"), true);
});

test("live data outranks memory, and a missing reading is not replaced with it", async () => {
  const memory = {
    async search() {
      return [{ layer: "PERSONAL", text: "User owns 2000 XRP.", sourceId: "old-xrp", score: 1 }];
    },
  };
  const current = await orchestrateContext({
    query: "How much XRP do I own?",
    userId: "user-a",
    transcript: [{ role: "user", content: "How much XRP do I own?" }],
    memory,
    readers: { finance: async () => [{ text: "XRP quantity 2500", sourceId: "now" }] },
  });
  assert.equal(current.authority[0].text, "XRP quantity 2500");
  assert.equal(current.authority[0].origin, "live");
  const stale = current.items.find((item) => item.sourceId === "old-xrp");
  assert.equal(stale.temporalState, "historical");
  assert.equal(stale.superseded, true);
  const answered = settleReply({
    transcript: [{ role: "user", content: "How much XRP do I own?" }],
    text: "You own 2,500 XRP.",
    pack: current,
  });
  assert.match(answered.text, /2,500/);

  const missing = await orchestrateContext({
    query: "How much XRP do I own?",
    userId: "user-a",
    transcript: [{ role: "user", content: "How much XRP do I own?" }],
    memory,
    readers: { finance: async () => [] },
  });
  assert.equal(
    missing.authority.some((item) => /2000/.test(item.text)),
    false
  );
  assert.equal(
    missing.items.some((item) => item.available === false),
    true
  );
  const blocked = settleReply({
    transcript: [{ role: "user", content: "How much XRP do I own?" }],
    text: "You own 2,000 XRP.",
    pack: missing,
  });
  assert.equal(blocked.text, "I can't verify that from a current reading.");
  assert.doesNotMatch(blocked.text, /2,000|2000/);

  const history = settleReply({
    transcript: [{ role: "user", content: "What did I decide about refinancing?" }],
    text: "You decided to wait.",
    pack: { plan: { currentState: false }, authority: [] },
  });
  assert.match(history.text, /wait/);
});

test("voice speaks the settled reply and every provider gets the same behavior", async () => {
  const transcript = [
    { role: "user", content: "How much XRP do I own?" },
    { role: "assistant", content: "You own 2,500 XRP." },
    { role: "user", content: "What's it worth?" },
  ];
  const model =
    "Certainly! I analyzed the position. You own 2,500 XRP. Would you like me to go on?";
  const settled = settleReply({
    transcript: [{ role: "user", content: "How much XRP do I own?" }],
    text: model,
    pack: {
      plan: { currentState: true },
      authority: [{ origin: "live", available: true, text: "XRP quantity 2500" }],
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
    historyAnswer: model,
    finished: true,
    status: CHIEF_STATUS.READY,
    source: "voice",
    preferences: normalizeChiefPreferences(null),
  });
  assert.equal(spoken, settled.text);
  assert.deepEqual(voice.calls, [settled.text]);
  assert.doesNotMatch(spoken, /Certainly|Would you like|analyzed/);

  const thanks = settleReply({
    transcript: [...transcript, { role: "user", content: "Thanks." }],
    text: "I can also pull Zillow.",
    toolCalls: [webCall],
  });
  const spokenThanks = speakCompletedReply(voice, {
    streamText: thanks.text,
    finished: true,
    status: CHIEF_STATUS.READY,
    source: "voice",
    preferences: normalizeChiefPreferences(null),
  });
  assert.equal(spokenThanks, thanks.text);
  assert.deepEqual(thanks.toolCalls, []);

  const facts = {
    async read() {
      return [];
    },
  };
  const prompts = [];
  const plans = [];
  for (const provider of ["xai", "anthropic", "openai"]) {
    prompts.push(
      await assembleSystemPrompt({
        userId: "user-a",
        query: "What's it worth?",
        facts,
        transcript,
        provider,
      })
    );
    plans.push(JSON.stringify(planContext("What's it worth?", { transcript, provider })));
  }
  assert.equal(prompts[0], prompts[1]);
  assert.equal(prompts[1], prompts[2]);
  assert.equal(plans[0], plans[1]);
  assert.equal(plans[1], plans[2]);
  assert.match(prompts[0], /GPT, Claude, and Grok are the same assistant/);
  assert.equal(JSON.parse(plans[0]).live.includes("finance"), true);
  assert.equal(JSON.parse(plans[0]).live.includes("web"), true);
});
