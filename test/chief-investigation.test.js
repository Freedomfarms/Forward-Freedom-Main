// Phase 4 investigation regressions. No database, network, or model.

import assert from "node:assert/strict";
import test from "node:test";

import { settleReply } from "../server/chief/context/behavior.js";
import { buildInvestigationBrief } from "../server/chief/context/investigate.js";
import { planContext } from "../server/chief/context/orchestrate.js";
import { planMemoryRetrieval } from "../server/chief/memory/retrieve.js";
import { isForbiddenControlTool } from "../server/chief/control/plane.js";

test("a simple question keeps the answer and drops an unneeded web search", () => {
  const query = "What is 2 + 2?";
  const transcript = [{ role: "user", content: query }];
  const plan = planContext(query, { transcript });
  assert.deepEqual(plan.live, []);
  assert.equal(planMemoryRetrieval(query).episodic, false);
  assert.equal(buildInvestigationBrief({ query, plan, transcript }), "");
  const reply = settleReply({
    transcript,
    text: "4.",
    toolCalls: [{ name: "web_search", callId: "search" }],
    pack: { plan, items: [], authority: [] },
  });
  assert.equal(reply.text, "4.");
  assert.deepEqual(reply.toolCalls, []);
});

test("a current value keeps the decision and drops the unverified price", () => {
  const query = "Is the cabin worth selling?";
  const transcript = [{ role: "user", content: query }];
  const plan = planContext(query, { transcript });
  assert.equal(plan.live.includes("finance"), true);
  assert.equal(planMemoryRetrieval(query).episodic, true);
  const reply = settleReply({
    transcript,
    text: "You decided to keep the lake cabin. It is worth $500000.",
    toolCalls: [],
    pack: { plan, items: [], authority: [] },
  });
  assert.match(reply.text, /keep the lake cabin/i);
  assert.doesNotMatch(reply.text, /500000/);
  const brief = buildInvestigationBrief({
    query,
    plan,
    transcript,
    items: [
      { origin: "live", available: false, text: "Freedom Financial is not connected." },
      {
        origin: "memory",
        available: true,
        text: "We decided to keep the lake cabin and not sell it.",
      },
    ],
  });
  assert.match(brief, /Freedom Financial/);
  assert.match(brief, /prior decision/);
  assert.match(brief, /unavailable/);
  assert.doesNotMatch(brief, /500000/);
});

test("conflicting history is named and a missing reading is not filled in", () => {
  const query = "Are we keeping the lake cabin or selling it?";
  const transcript = [{ role: "user", content: query }];
  const plan = planContext(query, { transcript });
  const brief = buildInvestigationBrief({
    query,
    plan,
    transcript,
    items: [
      {
        origin: "memory",
        available: true,
        text: "On 2026-01-01 we decided to keep the lake cabin.",
      },
      {
        origin: "memory",
        available: true,
        text: "On 2026-09-01 we discussed selling the lake cabin.",
      },
    ],
  });
  assert.match(brief, /disagree/);
  assert.match(brief, /does not erase an older decision/);
  const worth = "What is the cabin worth?";
  const worthTranscript = [{ role: "user", content: worth }];
  const invented = settleReply({
    transcript: worthTranscript,
    text: "The cabin is worth $410000.",
    pack: { plan: planContext(worth, { transcript: worthTranscript }), items: [], authority: [] },
  });
  assert.equal(
    invented.text,
    "I'm missing a current property-value reading, so I can't verify that estimate."
  );
  assert.doesNotMatch(invented.text, /410/);
});

test("a repository question plans a code read and does not unlock writes", () => {
  const query =
    "What changed in server/chief/runtime/turn.js since we last talked about the turn loop?";
  const transcript = [{ role: "user", content: query }];
  const plan = planContext(query, { transcript });
  assert.equal(plan.live.includes("code"), true);
  assert.equal(plan.live.includes("finance"), false);
  assert.equal(isForbiddenControlTool("git_commit"), true);
  assert.equal(isForbiddenControlTool("deploy"), true);
  const reply = settleReply({
    transcript,
    text: "I will commit that.",
    toolCalls: [
      { name: "code_read", callId: "read" },
      { name: "web_search", callId: "web" },
    ],
    pack: { plan, items: [], authority: [] },
  });
  assert.deepEqual(reply.toolCalls.map((call) => call.name), ["code_read", "web_search"]);
  assert.deepEqual(reply.diagnostics, [
    { reason: "tool_plan_mismatch_preserved", count: 1 },
  ]);
  const brief = buildInvestigationBrief({ query, plan, transcript });
  assert.match(brief, /code read/);
  assert.match(brief, /prior decision or conversation/);
});

test("an unresolved follow-up does not investigate the previous subject", () => {
  const transcript = [
    { role: "user", content: "How much equity do I have in the house?" },
    { role: "assistant", content: "About $321K, using the mortgage and the current value." },
    { role: "user", content: "What about the other one?" },
  ];
  const query = "What about the other one?";
  const plan = planContext(query, { transcript });
  assert.deepEqual(plan.live, []);
  const brief = buildInvestigationBrief({ query, plan, transcript });
  assert.match(brief, /not named/);
  const reply = settleReply({
    transcript,
    text: "The house equity is $321,000.",
    toolCalls: [{ name: "finance_summary", callId: "finance" }],
    pack: { plan, items: [], authority: [] },
  });
  assert.deepEqual(reply.toolCalls, []);
});

test("authorized reads survive when the heuristic plan did not request their domain", () => {
  const transcript = [{ role: "user", content: "How much XRP do I own?" }];
  const plan = planContext("How much XRP do I own?", { transcript });
  const reply = settleReply({
    transcript,
    text: "Checking that now.",
    toolCalls: [
      { name: "finance_summary", callId: "finance" },
      { name: "web_search", callId: "web" },
    ],
    pack: { plan, items: [], authority: [] },
  });
  assert.deepEqual(reply.toolCalls.map((call) => call.name), [
    "finance_summary",
    "web_search",
  ]);
  assert.deepEqual(reply.diagnostics, [
    { reason: "tool_plan_mismatch_preserved", count: 1 },
  ]);
});
