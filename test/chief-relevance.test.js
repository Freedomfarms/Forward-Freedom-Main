// Relevance is a turn-time reading of facts CHIEF already has.
// A stated priority comes from chief_fact or an explicit sentence.
// A live signal does not become a goal, and a shared word stays an inference.

import test from "node:test";
import assert from "node:assert/strict";

import { settleReply } from "../server/chief/context/behavior.js";
import { orchestrateContext, planContext } from "../server/chief/context/orchestrate.js";
import { collectPriorities, isStatedPriority } from "../server/chief/context/relevance.js";
import { synthesizeSituation } from "../server/chief/context/situation.js";
import { selectPersonalFacts } from "../server/chief/memory/retrieve.js";
import {
  ANTHROPIC_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  XAI_PROVIDER_ID,
} from "../server/chief/models/providers.js";
import { CHIEF_STATUS } from "../src/utils/chiefProtocol.js";
import { speakCompletedReply } from "../src/utils/chiefReplySpeech.js";

const NOW = new Date("2026-10-06T15:00:00.000Z");
const SOON = "2026-10-06T18:00:00.000Z";
const OVERDUE = "2026-10-06T12:00:00.000Z";
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

function priority(text) {
  return {
    origin: "memory",
    available: true,
    source: "chief_fact",
    sourceType: "personal_memory",
    text,
    temporalState: "historical",
  };
}

function financeDelta(pct, latest, previous) {
  return tool("finance_summary", {
    position: {
      status: "available",
      holdings: [{ symbol: "XRP", quantity: 100 }],
      currentMonth: { spent: 10, budget: 400 },
    },
    activity: {
      status: "available",
      plaid: { requiresAttentionCount: 0 },
      categoryDeltas: [{ category: "Groceries", momChangePct: pct, latestTotal: latest, previousTotal: previous }],
    },
  });
}

function agents(rows) {
  return tool("workforce_status", { connected: true, agents: rows });
}

function schedules(tasks, runs = []) {
  return [tool("schedule_list", { tasks }), tool("schedule_runs", { runs })];
}

function ask(query, payloads, text, items = [], transcript = null) {
  const messages = transcript ?? [{ role: "user", content: query }, ...payloads];
  return settleReply({
    transcript: messages,
    text,
    pack: {
      query,
      now: NOW,
      items,
      plan: { currentState: true, memory: ["personal"] },
      unavailable: [],
    },
  });
}

test("a measured change without a stated priority stays a fact", () => {
  assert.equal(isStatedPriority("What's my grocery spending?"), false);
  const query = "What should I be paying attention to?";
  const payloads = [
    agents([{ id: "finance-bot", name: "Finance", status: "idle" }]),
    financeDelta(40, 420, 300),
    ...schedules([{ id: "task-1", name: "Review", status: "ACTIVE", nextRunAt: LATER }]),
  ];
  const situation = synthesizeSituation({
    query,
    transcript: [{ role: "user", content: query }, ...payloads],
    now: NOW,
  });
  assert.match(situation.line, /Groceries is up 40% from last month/);
  assert.equal(situation.relevant, null);
  assert.equal(situation.line.includes("concerned"), false);
  assert.equal(situation.line.includes("conflicts"), false);
  const settled = ask(query, payloads, "You should be concerned about groceries.");
  assert.equal(settled.text, situation.line);
  assert.equal(settled.text.includes("concerned"), false);
});

test("a change that lines up with a stated priority says so as an inference", () => {
  const query = "What should I be paying attention to?";
  const items = [priority("I'm trying to cut grocery spending.")];
  const payloads = [financeDelta(-40, 180, 300)];
  const situation = synthesizeSituation({
    query,
    transcript: [{ role: "user", content: query }, ...payloads],
    items,
    now: NOW,
  });
  assert.match(situation.line, /Groceries is down 40% from last month/);
  assert.match(situation.line, /lines up with/);
  assert.match(situation.line, /inferred/);
  assert.match(situation.line, /verified/);
  assert.match(situation.line, /cut grocery spending/);
  assert.equal(situation.line.includes("concerned"), false);
});

test("a change that conflicts with a stated priority is not turned into worry", () => {
  const query = "What should I be paying attention to?";
  const items = [priority("I'm trying to cut grocery spending.")];
  const payloads = [financeDelta(40, 420, 300)];
  const situation = synthesizeSituation({
    query,
    transcript: [{ role: "user", content: query }, ...payloads],
    items,
    now: NOW,
  });
  assert.match(situation.line, /Groceries is up 40% from last month/);
  assert.match(situation.line, /conflicts with/);
  assert.match(situation.line, /I remember you said/);
  assert.match(situation.line, /inferred/);
  assert.equal(situation.line.includes("concerned"), false);
  assert.equal(situation.line.includes("XRP"), false);
});

test("a past decision and a current change stay separate from a recommendation", () => {
  const items = [
    priority("You decided to keep the house because the payment is manageable."),
    {
      origin: "live",
      available: true,
      source: "freedom_financial",
      text: "The mortgage payment increased.",
      temporalState: "current",
    },
  ];
  items[0].text = "You decided to keep the house because the payment is manageable.";
  const settled = settleReply({
    transcript: [{ role: "user", content: "Does that still make sense?" }],
    text: "Yes, that still makes sense. You should stick with it.",
    pack: {
      query: "Does that still make sense?",
      now: NOW,
      items,
      plan: { currentState: true, memory: ["decision"] },
    },
  });
  assert.match(settled.text, /You decided to keep the house because the payment is manageable/);
  assert.match(settled.text, /Today, The mortgage payment increased/);
  assert.match(settled.text, /can't say the decision still holds/);
  assert.equal(settled.text.includes("still makes sense"), false);
  assert.equal(settled.text.includes("sell"), false);
});

test("a known goal is added only when the current reading touches it", () => {
  const settled = settleReply({
    transcript: [{ role: "user", content: "Does that still make sense?" }],
    text: "Yes, that still makes sense.",
    pack: {
      query: "Does that still make sense?",
      now: NOW,
      items: [
        {
          origin: "memory",
          available: true,
          source: "chief_fact",
          text: "You decided to keep the house because the payment is manageable.",
        },
        {
          origin: "memory",
          available: true,
          source: "chief_fact",
          text: "I'm trying to keep the payment manageable.",
        },
        {
          origin: "live",
          available: true,
          source: "freedom_financial",
          text: "The mortgage payment increased.",
        },
      ],
      plan: { currentState: true, memory: ["decision"] },
    },
  });
  assert.match(settled.text, /I'm trying to keep the payment manageable/);
  assert.match(settled.text, /can't say the decision still holds/);
  assert.equal(settled.text.includes("still makes sense"), false);
});

test("a workforce failure matters only when it shares a stated objective", () => {
  const query = "What's going on with my agents?";
  const payloads = [
    agents([
      {
        id: "finance-bot",
        name: "Finance",
        status: "active",
        currentFailure: { task: "The import failed.", at: NOW.toISOString() },
      },
    ]),
  ];
  const related = synthesizeSituation({
    query,
    transcript: [{ role: "user", content: query }, ...payloads],
    items: [priority("I'm working on the finance report.")],
    now: NOW,
  });
  assert.match(related.line, /Finance failed: The import failed/);
  assert.match(related.line, /may relate to/);
  assert.match(related.line, /finance report/);
  assert.equal(related.line.includes("will be delayed"), false);

  const unrelated = synthesizeSituation({
    query,
    transcript: [{ role: "user", content: query }, ...payloads],
    items: [priority("I'm trying to finish the garden plan.")],
    now: NOW,
  });
  assert.match(unrelated.line, /Finance failed: The import failed/);
  assert.equal(unrelated.relevant, null);
  assert.equal(unrelated.line.includes("garden"), false);
  const matter = ask(
    "Does this matter?",
    payloads,
    "The report will be delayed and you should worry about it.",
    [priority("I'm trying to finish the garden plan.")],
    [
      { role: "user", content: query },
      ...payloads,
      { role: "assistant", content: unrelated.line },
      { role: "user", content: "Does this matter?" },
    ]
  );
  assert.match(matter.text, /don't have a stated priority that this affects/);
  assert.equal(matter.text.includes("garden"), false);
  assert.equal(matter.text.includes("will be delayed"), false);
});

test("an overdue schedule is relevant only with a stated project, and a normal one is not", () => {
  const overdue = synthesizeSituation({
    query: "What should I be paying attention to?",
    transcript: [
      { role: "user", content: "What should I be paying attention to?" },
      ...schedules(
        [{ id: "rent", name: "Rent review", status: "ACTIVE", nextRunAt: OVERDUE }],
        [
          { id: "run-1", status: "FAILED", scheduledTaskId: "rent", completedAt: NOW.toISOString() },
          { id: "run-2", status: "FAILED", scheduledTaskId: "rent", completedAt: NOW.toISOString() },
        ]
      ),
    ],
    items: [priority("The rent review is my priority.")],
    now: NOW,
  });
  assert.match(overdue.line, /Rent review has 2 failed runs/);
  assert.match(overdue.line, /was due at/);
  assert.match(overdue.line, /may relate to/);
  assert.equal(overdue.line.includes("agent"), false);

  const normal = synthesizeSituation({
    query: "What should I be paying attention to?",
    transcript: [
      { role: "user", content: "What should I be paying attention to?" },
      ...schedules([{ id: "task-1", name: "Review", status: "ACTIVE", nextRunAt: SOON }]),
    ],
    items: [priority("I'm trying to cut grocery spending.")],
    now: NOW,
  });
  assert.match(normal.line, /Review is scheduled next at/);
  assert.equal(normal.relevant, null);
  assert.equal(normal.line.includes("grocery"), false);
  assert.equal(normal.line.includes("important"), false);
});

test("does this matter, worry, and what should I do stay evidence-based", () => {
  const items = [priority("I'm trying to cut grocery spending.")];
  const payloads = [financeDelta(40, 420, 300)];
  const prior = [
    { role: "user", content: "What should I be paying attention to?" },
    ...payloads,
    { role: "assistant", content: "Groceries is up 40% from last month." },
  ];
  const matter = ask(
    "Does this matter?",
    payloads,
    "Yes, you should be concerned.",
    items,
    [...prior, { role: "user", content: "Does this matter?" }]
  );
  assert.match(matter.text, /verified/);
  assert.match(matter.text, /may conflict with/);
  assert.match(matter.text, /I remember you said/);
  assert.match(matter.text, /don't have evidence of a further consequence/);
  assert.equal(matter.text.includes("concerned"), false);

  const worry = ask(
    "Is this something I should worry about?",
    payloads,
    "This is alarming.",
    items,
    [...prior, { role: "user", content: "Is this something I should worry about?" }]
  );
  assert.match(worry.text, /wouldn't treat that as a worry/);
  assert.match(worry.text, /Groceries is up 40% from last month/);
  assert.equal(worry.text.includes("alarming"), false);

  const action = ask(
    "What should I do?",
    payloads,
    "I restarted the finance bot.",
    items,
    [...prior, { role: "user", content: "What should I do?" }]
  );
  assert.match(action.text, /useful next step/);
  assert.match(action.text, /cut grocery spending/);
  assert.match(action.text, /can't change it from here/);
  assert.equal(action.text.includes("restarted"), false);
  assert.equal(action.toolCalls.length, 0);
});

test("which matters most ranks the discussed signals and why explains that one", () => {
  const items = [priority("I'm working on the finance report.")];
  const payloads = [
    agents([
      {
        id: "finance-bot",
        name: "Finance",
        status: "idle",
        recentActivity: [{ at: NOW.toISOString(), outcome: "failed", text: "The import failed." }],
      },
      {
        id: "digest-bot",
        name: "Digest",
        status: "idle",
        recentActivity: [{ at: NOW.toISOString(), outcome: "completed", text: "Finished the daily digest." }],
      },
    ]),
    financeDelta(40, 420, 300),
  ];
  const transcript = [
    { role: "user", content: "What changed today?" },
    ...payloads,
    { role: "assistant", content: "Two things changed." },
    { role: "user", content: "Which one matters most?" },
  ];
  const plan = planContext("Which one matters most?", { transcript });
  assert.deepEqual(plan.live, []);
  assert.equal(plan.currentState, false);
  const most = settleReply({
    transcript,
    text: "Everything is urgent.",
    pack: { query: "Which one matters most?", now: NOW, items, plan },
  });
  assert.match(most.text, /Finance failed today/);
  assert.match(most.text, /matters most/);
  assert.match(most.text, /finance report/);
  assert.match(most.text, /inferred/);
  assert.match(most.text, /verified/);
  assert.equal(most.text.includes("40%"), false);
  assert.equal(most.text.includes("urgent"), false);
  assert.equal(most.text.includes("will be delayed"), false);

  const whyTranscript = [...transcript, { role: "assistant", content: most.text }, { role: "user", content: "Why?" }];
  const whyPlan = planContext("Why?", { transcript: whyTranscript });
  assert.deepEqual(whyPlan.live, []);
  const why = settleReply({
    transcript: whyTranscript,
    text: "The report will be delayed.",
    pack: { query: "Why?", now: NOW, items, plan: whyPlan },
  });
  assert.match(why.text, /Finance failed today/);
  assert.match(why.text, /I remember you said/);
  assert.match(why.text, /inferred/);
  assert.equal(why.text.includes("will be delayed"), false);

  const doTranscript = [...whyTranscript, { role: "assistant", content: why.text }, { role: "user", content: "What should I do?" }];
  const step = settleReply({
    transcript: doTranscript,
    text: "I restarted the finance bot and paused your schedule.",
    toolCalls: [{ callId: "pause", name: "schedule_pause", arguments: { taskId: "rent" } }],
    pack: { query: "What should I do?", now: NOW, items, plan: planContext("What should I do?", { transcript: doTranscript }) },
  });
  assert.match(step.text, /useful next step/);
  assert.match(step.text, /finance report/);
  assert.match(step.text, /can't change it from here/);
  assert.equal(step.text.includes("restarted"), false);
  assert.equal(step.toolCalls.length, 0);
});

test("an unknown priority is named, and an unrelated answer stays plain", () => {
  const payloads = [financeDelta(40, 420, 300)];
  const unknown = ask(
    "Does this matter?",
    payloads,
    "You should worry about groceries.",
    [],
    [
      { role: "user", content: "What should I be paying attention to?" },
      ...payloads,
      { role: "user", content: "Does this matter?" },
    ]
  );
  assert.match(unknown.text, /don't have a stated priority that this affects/);
  assert.match(unknown.text, /verified/);
  assert.equal(unknown.text.includes("worry"), false);

  const plain = settleReply({
    transcript: [{ role: "user", content: "How is the well?" }],
    text: "The north well is fine.",
    pack: {
      query: "How is the well?",
      now: NOW,
      items: [priority("I'm trying to cut grocery spending.")],
      plan: { currentState: false, memory: ["personal"] },
    },
  });
  assert.equal(plain.text, "The north well is fine.");
  assert.equal(plain.text.includes("grocery"), false);
});

test("a one-off question and an episode do not become priorities, and attention does not write memory", async () => {
  assert.equal(
    collectPriorities({
      transcript: [
        { role: "user", content: "What's my grocery spending?" },
        { role: "user", content: "Does this matter?" },
      ],
    }).length,
    0
  );
  assert.equal(
    collectPriorities({
      items: [
        {
          origin: "memory",
          available: true,
          source: "chief_session",
          text: "I'm trying to cut grocery spending.",
        },
      ],
    }).length,
    0
  );
  const remembered = collectPriorities({ items: [priority("I'm trying to cut grocery spending.")] });
  assert.equal(remembered.length, 1);
  assert.equal(remembered[0].confidence, "remembered");

  const selected = selectPersonalFacts(
    "how is the well",
    [
      { id: "goal", content: "I'm trying to cut grocery spending.", source: "user" },
      { id: "well", content: "The north well pump is solar", source: "user" },
    ],
    { statedPriorities: false }
  );
  assert.equal(selected.some((row) => row.id === "goal"), false);
  const withGoals = selectPersonalFacts(
    "What should I be paying attention to?",
    [{ id: "goal", content: "I'm trying to cut grocery spending.", source: "user" }],
    { statedPriorities: true }
  );
  assert.equal(withGoals.some((row) => row.id === "goal"), true);

  let writes = 0;
  const seen = [];
  const memory = {
    async search(_query, scope) {
      seen.push(scope.statedPriorities === true);
      if (scope.statedPriorities) {
        return [{ layer: "PERSONAL", text: "I'm trying to cut grocery spending.", sourceId: "fact-1" }];
      }
      return [];
    },
    async remember() {
      writes += 1;
      return { stored: true };
    },
  };
  const pack = await orchestrateContext({
    query: "What should I be paying attention to?",
    userId: "user-a",
    memory,
    now: NOW,
  });
  assert.equal(seen[0], true);
  assert.equal(
    pack.items.some((item) => item.text === "I'm trying to cut grocery spending."),
    true
  );
  const well = await orchestrateContext({
    query: "How is the well?",
    userId: "user-a",
    memory,
    now: NOW,
  });
  assert.equal(seen.length, 1);
  assert.equal(
    well.items.some((item) => /grocery/.test(item.text ?? "")),
    false
  );
  assert.equal(writes, 0);
});

test("providers share the relevance plan, and voice speaks the settled line", () => {
  const transcript = [
    { role: "user", content: "What changed today?" },
    { role: "assistant", content: "Finance failed today." },
    { role: "user", content: "Which one matters most?" },
  ];
  const plans = [XAI_PROVIDER_ID, ANTHROPIC_PROVIDER_ID, OPENAI_PROVIDER_ID].map((provider) =>
    JSON.stringify(planContext("Which one matters most?", { transcript, provider }))
  );
  assert.equal(plans[0], plans[1]);
  assert.equal(plans[1], plans[2]);
  const items = [priority("I'm working on the finance report.")];
  const payloads = [
    agents([
      {
        id: "finance-bot",
        name: "Finance",
        status: "idle",
        recentActivity: [{ at: NOW.toISOString(), outcome: "failed", text: "The import failed." }],
      },
    ]),
  ];
  const readings = [XAI_PROVIDER_ID, ANTHROPIC_PROVIDER_ID, OPENAI_PROVIDER_ID].map(() =>
    synthesizeSituation({
      query: "What changed today?",
      transcript: [{ role: "user", content: "What changed today?" }, ...payloads],
      items,
      now: NOW,
    }).line
  );
  assert.equal(readings[0], readings[1]);
  assert.equal(readings[1], readings[2]);
  const voice = { calls: [], speakAnswer(text) { this.calls.push(text); } };
  const spoken = speakCompletedReply(voice, {
    streamText: readings[0],
    finished: true,
    status: CHIEF_STATUS.READY,
  });
  assert.equal(spoken, readings[0]);
  assert.equal(voice.calls[0], readings[0]);
  assert.match(voice.calls[0], /may relate to/);
});
