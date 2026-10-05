// CHIEF answers like one assistant across a conversation.
// The contract is prompt text. Source choice stays in the context orchestrator.

import test from "node:test";
import assert from "node:assert/strict";

import { assembleSystemPrompt } from "../server/chief/context/assemble.js";
import {
  CHIEF_RESPONSE_CONTRACT,
  conversationMove,
  MOVE,
  renderConversationMove,
} from "../server/chief/context/behavior.js";
import { createChiefTurnServices } from "../server/chief/context/wire.js";
import { orchestrateContext, planContext } from "../server/chief/context/orchestrate.js";
import { MemoryFactStore } from "../server/chief/memory/facts.js";
import { buildWorkingMemory, resolveReference } from "../server/chief/memory/working.js";

const equityThread = [
  { role: "user", content: "Chief, how much equity do I have in my house?" },
  {
    role: "assistant",
    content: "You're sitting on roughly $321K. Mortgage about $326.8K, house around $647.6K.",
  },
  { role: "user", content: "What if Zillow is lower?" },
  {
    role: "assistant",
    content: "Then your equity would be lower too. I can pull Zillow's current estimate if needed.",
  },
  { role: "user", content: "Yeah." },
  {
    role: "assistant",
    content: "Yep. Zillow has it around $610K, putting your equity at roughly $283K.",
  },
  { role: "user", content: "That's not bad." },
];

function readers(seen) {
  return {
    finance: async () => {
      seen.push("finance");
      return [
        {
          text: "mortgage 326800 home 647600",
          sourceId: "home-1",
          occurredAt: "2026-10-05T12:00:00.000Z",
        },
      ];
    },
    web: async () => {
      seen.push("web");
      return [{ text: "Zillow estimate 610000", sourceId: "zillow-1" }];
    },
    agents: async () => {
      seen.push("agents");
      return [{ text: "idle", sourceId: "agent-1" }];
    },
    email: async () => {
      seen.push("email");
      return [{ text: "unread note", sourceId: "mail-1" }];
    },
  };
}

test("follow-ups resolve pronouns and implicit references from the open thread", () => {
  const xrp = [
    { role: "user", content: "How much XRP do I own?" },
    { role: "assistant", content: "59,000 XRP." },
    { role: "user", content: "What's it worth?" },
  ];
  const memory = buildWorkingMemory(xrp);
  assert.equal(resolveReference(memory, "What's it worth?"), "XRP");
  assert.equal(resolveReference(memory, "What if it hits $5?"), "XRP");
  assert.equal(conversationMove(xrp).kind, MOVE.CONTINUE);
  assert.equal(conversationMove(xrp).referent, "XRP");

  const house = [
    ...xrp,
    { role: "assistant", content: "About $120,000 at the current price." },
    { role: "user", content: "What about my house?" },
  ];
  assert.equal(resolveReference(buildWorkingMemory(house), "What about my house?"), "house");
  assert.equal(conversationMove(house, "How much equity?").kind, MOVE.CONTINUE);

  const car = [
    { role: "user", content: "What about my car?" },
    { role: "assistant", content: "The car note is about $18K." },
    { role: "user", content: "What about them?" },
  ];
  assert.equal(resolveReference(buildWorkingMemory(car), "What about them?"), "car");

  const places = [
    { role: "user", content: "How much XRP do I own?" },
    { role: "user", content: "What about my house?" },
    { role: "user", content: "the other one" },
  ];
  assert.equal(resolveReference(buildWorkingMemory(places), "the other one"), "XRP");
  for (const line of ["why?", "what changed?", "is that good?", "what happened next?"]) {
    assert.equal(
      conversationMove(
        [
          { role: "user", content: "How much XRP do I own?" },
          { role: "user", content: line },
        ],
        line
      ).kind,
      MOVE.CONTINUE
    );
  }
});

test("a financial conversation stays one thread and picks only the sources it needs", async () => {
  const seen = [];
  const memory = {
    async search(_query, scope) {
      seen.push(`search:${scope.layers.join("+")}`);
      return [
        {
          layer: "EPISODIC",
          text: "The well pump failed last spring.",
          sourceId: "well",
          score: 1,
        },
      ];
    },
  };

  const holding = planContext("How much XRP do I own?");
  assert.deepEqual(holding.live, ["finance"]);
  assert.equal(holding.live.includes("web"), false);

  const worthTranscript = [
    { role: "user", content: "How much XRP do I own?" },
    { role: "assistant", content: "59,000 XRP." },
    { role: "user", content: "What's it worth?" },
  ];
  const worth = planContext("What's it worth?", { transcript: worthTranscript });
  assert.deepEqual(worth.live, ["finance", "web"]);
  assert.equal(worth.memory.includes("episodic"), false);

  const houseTranscript = [
    ...worthTranscript.slice(0, 2),
    { role: "user", content: "What about my house?" },
  ];
  const house = planContext("What about my house?", { transcript: houseTranscript });
  assert.deepEqual(house.live, ["finance"]);
  assert.equal(house.live.includes("web"), false);
  assert.equal(house.live.includes("email"), false);

  const equityTranscript = [
    { role: "user", content: "What's my house worth?" },
    { role: "assistant", content: "Your current estimate is around $647K." },
    { role: "user", content: "What about equity?" },
  ];
  assert.deepEqual(planContext("What about equity?", { transcript: equityTranscript }).live, [
    "finance",
  ]);

  const hypothetical = equityThread.slice(0, 3);
  const lower = planContext("What if Zillow is lower?", { transcript: hypothetical });
  assert.deepEqual(lower.live, ["finance"]);
  assert.equal(lower.live.includes("web"), false);

  const confirmed = equityThread.slice(0, 5);
  const yeah = planContext("Yeah.", { transcript: confirmed });
  assert.deepEqual(yeah.live, ["finance", "web"]);

  seen.length = 0;
  const pack = await orchestrateContext({
    query: "What's it worth?",
    userId: "user-a",
    transcript: worthTranscript,
    memory,
    readers: readers(seen),
    availableTools: ["finance_summary", "web_search"],
  });
  assert.deepEqual(
    seen.filter((call) => !call.startsWith("search")),
    ["finance", "web"]
  );
  assert.equal(seen.includes("agents"), false);
  assert.equal(seen.includes("email"), false);
  assert.equal(
    seen.some((call) => call.includes("EPISODIC")),
    false
  );
  assert.equal(pack.plan.currentState, true);
  assert.equal(
    pack.authority.every((item) => item.origin === "live"),
    true
  );
  assert.equal(
    pack.items.some((item) => item.sourceId === "well"),
    false
  );
});

test("the canonical equity exchange keeps context, then stops", () => {
  const opening = planContext(equityThread[0].content, { transcript: equityThread.slice(0, 1) });
  assert.deepEqual(opening.live, ["finance"]);
  assert.equal(
    conversationMove(equityThread.slice(0, 3), "What if Zillow is lower?").kind,
    MOVE.CONTINUE
  );
  assert.equal(conversationMove(equityThread.slice(0, 5), "Yeah.").kind, MOVE.CONFIRM);
  assert.equal(conversationMove(equityThread.slice(0, 5), "Yeah.").pullsPublicSource, true);
  assert.equal(conversationMove(equityThread, "That's not bad.").kind, MOVE.ACKNOWLEDGE);
  assert.deepEqual(planContext("That's not bad.", { transcript: equityThread }).live, []);
  const reaction = renderConversationMove(equityThread, "That's not bad.");
  assert.match(reaction, /not a new task/);
  assert.match(reaction, /Do not call a tool/);
  assert.match(reaction, /Do not offer more work/);
});

test("a past decision uses episodic memory and a current balance uses live data", async () => {
  const history = await orchestrateContext({
    query: "What did we decide about CHIEF memory?",
    userId: "user-a",
    transcript: [
      { role: "user", content: "How much XRP do I own?" },
      { role: "assistant", content: "59,000 XRP." },
      { role: "user", content: "What did we decide about CHIEF memory?" },
    ],
    memory: {
      async search() {
        return [
          {
            layer: "EPISODIC",
            text: "We decided CHIEF keeps one session record.",
            sourceId: "decision-1",
            score: 1,
          },
        ];
      },
    },
    readers: {
      finance: async () => [{ text: "XRP quantity 59000", sourceId: "hold-1" }],
    },
  });
  assert.deepEqual(history.plan.live, []);
  assert.equal(history.plan.currentState, false);
  assert.equal(history.items[0].temporalState, "historical");
  assert.equal(history.items[0].source, "chief_session");
  assert.equal(history.authority[0].sourceId, "decision-1");

  let writes = 0;
  const current = await orchestrateContext({
    query: "Do I own Bitcoin?",
    userId: "user-a",
    memory: {
      async search() {
        return [
          { layer: "PERSONAL", text: "User did not own Bitcoin.", sourceId: "old", score: 1 },
        ];
      },
      remember() {
        writes += 1;
      },
    },
    readers: {
      finance: async () => [{ text: "BTC quantity 2", sourceId: "btc-now" }],
    },
  });
  assert.equal(writes, 0);
  assert.equal(current.authority[0].text, "BTC quantity 2");
  assert.equal(current.authority[0].source, "freedom_financial");
  const stale = current.items.find((item) => item.sourceId === "old");
  assert.equal(stale.superseded, true);
  assert.equal(stale.temporalState, "historical");
});

test("casual conversation calls nothing, and a missing source is not invented", async () => {
  const seen = [];
  const thanks = await orchestrateContext({
    query: "Thanks.",
    userId: "user-a",
    transcript: [
      { role: "user", content: "How much XRP do I own?" },
      { role: "assistant", content: "59,000 XRP." },
      { role: "user", content: "Thanks." },
    ],
    readers: readers(seen),
    memory: {
      async search() {
        seen.push("search");
        return [];
      },
    },
  });
  assert.deepEqual(seen, []);
  assert.equal(thanks.items.length, 0);
  assert.equal(conversationMove([{ role: "user", content: "Great." }]).kind, MOVE.ACKNOWLEDGE);
  assert.equal(conversationMove([{ role: "user", content: "Fuck." }]).kind, MOVE.ACKNOWLEDGE);

  const missing = await orchestrateContext({
    query: "Yeah.",
    userId: "user-a",
    transcript: equityThread.slice(0, 5),
    readers: {
      finance: async () => [{ text: "mortgage 326800 home 647600", sourceId: "home-1" }],
    },
    availableTools: ["finance_summary"],
  });
  const web = missing.items.find((item) => item.source === "web");
  assert.equal(web.available, false);
  assert.match(web.text, /not connected|No web reading/);
  assert.doesNotMatch(web.text, /610|\$\d/);
  assert.equal(
    missing.authority.some((item) => item.source === "web"),
    false
  );
  assert.equal(missing.authority[0].source, "freedom_financial");
});

test("reading live data does not write memory", async () => {
  const facts = new MemoryFactStore();
  await facts.write({
    userId: "user-a",
    content: "User prefers short answers",
    trustTier: "AUTO",
    source: "preference",
  });
  let remembers = 0;
  await orchestrateContext({
    query: "What's it worth?",
    userId: "user-a",
    transcript: [
      { role: "user", content: "How much XRP do I own?" },
      { role: "user", content: "What's it worth?" },
    ],
    memory: {
      async search() {
        return [];
      },
      remember() {
        remembers += 1;
      },
    },
    readers: {
      finance: async () => [{ text: "XRP quantity 59000", sourceId: "hold-1" }],
      web: async () => [{ text: "XRP price 2.10", sourceId: "px-1" }],
    },
  });
  assert.equal(remembers, 0);
  const rows = await facts.read({ userId: "user-a", limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(
    rows.some((row) => /59000|2\.10/.test(row.content)),
    false
  );
});

test("every provider gets the same response contract", async () => {
  const facts = {
    async read() {
      return [];
    },
  };
  const prompts = [];
  for (const provider of ["openai", "anthropic", "xai"]) {
    prompts.push(
      await assembleSystemPrompt({
        userId: "user-a",
        query: "How much XRP do I own?",
        facts,
        provider,
      })
    );
  }
  assert.equal(prompts[0], prompts[1]);
  assert.equal(prompts[1], prompts[2]);
  const prompt = prompts[0];
  assert.match(prompt, /GPT, Claude, and Grok are the same assistant/);
  assert.match(prompt, /Answer first/);
  assert.match(prompt, /one to three spoken lines/);
  assert.match(prompt, /short structure/);
  assert.match(prompt, /Do not narrate/);
  assert.match(prompt, /Would you like me to/);
  assert.match(prompt, /about \$321K/);
  assert.match(prompt, /Do not invent the figure/);
  assert.match(prompt, /Certainly/);
  assert.doesNotMatch(prompt, /as GPT|as Claude|as Grok|Certainly, Kyle|I'd be happy to assist/);
  assert.equal(prompt.split(CHIEF_RESPONSE_CONTRACT).length, 2);

  const persona = await assembleSystemPrompt({
    userId: "user-a",
    query: "Thanks.",
    facts: {
      async read() {
        return [
          {
            content: "Keep the tone dry.",
            source: "identity",
            trustTier: "TRUSTED",
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        ];
      },
    },
  });
  assert.match(persona, /Keep the tone dry/);
  assert.match(persona, /Response contract/);
});

test("the turn prompt carries the contract, the move, and question-scoped context", async () => {
  const services = createChiefTurnServices({
    facts: new MemoryFactStore(),
    engine: {
      async generate() {
        return { content: "[]" };
      },
    },
    contextReaders: {
      finance: async () => [
        { text: "XRP quantity 59000", sourceId: "hold-1", occurredAt: "2026-10-05T12:00:00.000Z" },
      ],
      web: async () => [{ text: "XRP price 2.10", sourceId: "px-1" }],
    },
  });
  const prompt = await services.contextAssembler({
    userId: "user-a",
    sessionId: "session-a",
    transcript: [
      { role: "user", content: "How much XRP do I own?" },
      { role: "assistant", content: "59,000 XRP." },
      { role: "user", content: "What's it worth?" },
    ],
    availableTools: ["finance_summary", "web_search"],
  });
  assert.match(prompt, /Response contract/);
  assert.match(prompt, /refer to XRP/);
  assert.match(prompt, /continues the same conversation/);
  assert.match(prompt, /freedom_financial/);
  assert.match(prompt, /XRP quantity 59000/);
  assert.match(prompt, /XRP price 2\.10/);
  assert.doesNotMatch(prompt, /I searched|I called the finance tool/);

  const quiet = await services.contextAssembler({
    userId: "user-a",
    sessionId: "session-a",
    transcript: [{ role: "user", content: "Thanks." }],
    availableTools: ["finance_summary", "web_search"],
  });
  assert.match(quiet, /not a new task/);
  assert.doesNotMatch(quiet, /live_financial_state|XRP quantity/);
});
