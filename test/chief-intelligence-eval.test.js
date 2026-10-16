// Phase 1 baseline for CHIEF intelligence. Offline only.
//
// Each scenario calls the current exported functions and scores them against
// the intended pass criteria from the 16 Oct 2026 roadmap. The assertions lock
// today's pass/fail record. A failing check is a recorded gap, not a production
// change. This file does not open a network connection, a database, or a model.

import assert from "node:assert/strict";
import test from "node:test";

import { conversationMove, settleReply } from "../server/chief/context/behavior.js";
import { planContext } from "../server/chief/context/orchestrate.js";
import {
  needsEpisodicMemory,
  planMemoryRetrieval,
  rankEpisodes,
  selectPersonalFacts,
} from "../server/chief/memory/retrieve.js";
import { buildWorkingMemory } from "../server/chief/memory/working.js";
import { lexicalRank } from "../server/chief/runtime/recall.js";
import {
  CONTROL_PLANE,
  ControlEffect,
  ControlStatus,
  isForbiddenControlTool,
} from "../server/chief/control/plane.js";

const USER = "user-a";

const PREFERENCE = fact("pref", "The user prefers concise answers.", "preference");
const CABIN_FACT = fact("cabin", "The lake cabin was purchased in 2019.", "user");
const OAK_FACT = fact("oak", "The primary residence is the house on Oak Street.", "user");
const OTHER_RESIDENCE = fact("other", "The lake cabin is the other residence.", "user");

const KEEP_EPISODE = episode(
  "keep",
  "Cabin decision",
  "We decided to keep the lake cabin and not sell it.",
  "2026-05-01T00:00:00.000Z",
  0.6
);
const SELL_EPISODE = episode(
  "sell",
  "Cabin sale",
  "On 2026-09-01 we discussed selling the lake cabin.",
  "2026-09-01T00:00:00.000Z",
  0.6
);
const KEEP_DATED = episode(
  "keep-dated",
  "Keep",
  "On 2026-01-01 we decided to keep the lake cabin.",
  "2026-01-01T00:00:00.000Z",
  0.5
);

function fact(id, content, source) {
  return {
    id,
    content,
    source,
    trustTier: "TRUSTED",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function episode(id, title, content, updatedAt, importance) {
  return { id, userId: USER, title, content, updatedAt, importance };
}

function idsOf(rows) {
  return (rows ?? []).map((row) => row.id);
}

function toolEntry(name) {
  return CONTROL_PLANE.find((entry) => entry.tool === name) ?? null;
}

function replyPack(plan) {
  return { plan, items: [], authority: [] };
}

// Intended criteria are fixed. `pass` is whether today's functions meet them.
export function evaluateIntelligenceFixtures() {
  return [
    ambiguousFollowUp(),
    earlierConversation(),
    differentWording(),
    multipleSources(),
    authorizedRead(),
    conflictingEvidence(),
    insufficientEvidence(),
    simpleQuestion(),
    genericRewrite(),
    wastefulInvestigation(),
  ].map(finish);
}

function finish(scenario) {
  const failed = scenario.checks.filter((check) => check.pass !== true).map((check) => check.id);
  return {
    id: scenario.id,
    pass: failed.length === 0,
    failed,
    observed: scenario.observed,
  };
}

function ambiguousFollowUp() {
  const transcript = [
    { role: "user", content: "How much equity do I have in the house?" },
    {
      role: "assistant",
      content: "About $321K, using the mortgage and the current value.",
    },
    { role: "user", content: "What about the other one?" },
  ];
  const query = "What about the other one?";
  const move = conversationMove(transcript, query);
  const memory = buildWorkingMemory(transcript);
  const context = planContext(query, { transcript });
  const selected = idsOf(selectPersonalFacts(query, [PREFERENCE, OTHER_RESIDENCE, OAK_FACT]));
  const observed = {
    move: move.kind,
    referent: memory.referent,
    live: context.live,
    selected,
  };
  return {
    id: "ambiguous-follow-up",
    observed,
    checks: [
      { id: "continues-thread", pass: move.kind === "continue" },
      {
        id: "referent-is-cabin-or-unresolved",
        pass: memory.referent === "cabin" || memory.referent == null,
      },
      { id: "cabin-fact-retrieved", pass: selected.includes("other") },
      { id: "oak-fact-excluded", pass: !selected.includes("oak") },
      { id: "finance-waits-for-subject", pass: !context.live.includes("finance") },
    ],
  };
}

function earlierConversation() {
  const query = "What did we decide about the vacation property?";
  const plan = planMemoryRetrieval(query);
  const ranked = rankEpisodes(query, [SELL_EPISODE, KEEP_EPISODE], { userId: USER });
  const observed = {
    episodic: plan.episodic,
    gate: needsEpisodicMemory(query),
    ranked: ranked.map((hit) => hit.episode.id),
    lexical: lexicalRank("vacation property decision", KEEP_EPISODE.content),
  };
  return {
    id: "earlier-conversation",
    observed,
    checks: [
      { id: "episodic-gate-opens", pass: plan.episodic === true },
      { id: "ranker-finds-cabin-decision", pass: ranked[0]?.episode.id === "keep" },
    ],
  };
}

function differentWording() {
  const query = "Tell me about the vacation property.";
  const selected = idsOf(selectPersonalFacts(query, [PREFERENCE, CABIN_FACT, OAK_FACT]));
  const observed = { selected };
  return {
    id: "different-wording",
    observed,
    checks: [
      { id: "cabin-fact-retrieved", pass: selected.includes("cabin") },
      { id: "oak-fact-excluded", pass: !selected.includes("oak") },
      { id: "preference-may-ride-along", pass: selected.includes("pref") },
    ],
  };
}

function multipleSources() {
  const query = "Is the cabin worth selling?";
  const transcript = [{ role: "user", content: query }];
  const context = planContext(query, { transcript });
  const plan = planMemoryRetrieval(query);
  const ranked = rankEpisodes(query, [KEEP_EPISODE], { userId: USER });
  const reply = settleReply({
    transcript,
    text: "You decided to keep the lake cabin. It is worth $500000.",
    toolCalls: [],
    pack: replyPack(context),
  });
  const observed = {
    live: context.live,
    episodic: plan.episodic,
    ranked: ranked.map((hit) => hit.episode.id),
    reply: reply.text,
  };
  return {
    id: "multiple-sources",
    observed,
    checks: [
      { id: "live-value-source-planned", pass: context.live.includes("finance") },
      { id: "decision-episode-searched", pass: plan.episodic === true },
      {
        id: "decision-survives-unguarded-price",
        pass: /keep the lake cabin/i.test(reply.text) && !/\$?\s?500000/.test(reply.text),
      },
    ],
  };
}

function authorizedRead() {
  const query =
    "What changed in server/chief/runtime/turn.js since we last talked about the turn loop?";
  const transcript = [{ role: "user", content: query }];
  const context = planContext(query, { transcript });
  const plan = planMemoryRetrieval(query);
  const codeRead = toolEntry("code_read");
  const observed = {
    live: context.live,
    episodic: plan.episodic,
    codeRead: codeRead?.status ?? null,
    codeEffect: codeRead?.effect ?? null,
    gitCommitForbidden: isForbiddenControlTool("git_commit"),
    deployForbidden: isForbiddenControlTool("deploy"),
  };
  return {
    id: "authorized-read",
    observed,
    checks: [
      {
        id: "code-read-is-live-read",
        pass: codeRead?.status === ControlStatus.LIVE && codeRead?.effect === ControlEffect.READ,
      },
      {
        id: "repository-writes-forbidden",
        pass: observed.gitCommitForbidden === true && observed.deployForbidden === true,
      },
      { id: "code-tool-planned", pass: context.live.includes("code") },
      { id: "prior-conversation-searched", pass: plan.episodic === true },
    ],
  };
}

function conflictingEvidence() {
  const query = "Are we keeping the lake cabin or selling it?";
  const plan = planMemoryRetrieval(query);
  const ranked = rankEpisodes(query, [KEEP_DATED, SELL_EPISODE], { userId: USER });
  const rankedIds = ranked.map((hit) => hit.episode.id);
  const observed = { episodic: plan.episodic, ranked: rankedIds };
  return {
    id: "conflicting-evidence",
    observed,
    checks: [
      { id: "both-episodes-considered", pass: plan.episodic === true },
      {
        id: "both-episodes-returned",
        pass: rankedIds.includes("keep-dated") && rankedIds.includes("sell"),
      },
      { id: "newer-episode-ranks-first", pass: rankedIds[0] === "sell" },
    ],
  };
}

function insufficientEvidence() {
  const query = "What is the cabin worth?";
  const transcript = [{ role: "user", content: query }];
  const context = planContext(query, { transcript });
  const reply = settleReply({
    transcript,
    text: "The cabin is worth $410000.",
    toolCalls: [],
    pack: replyPack(context),
  });
  const observed = { live: context.live, currentState: context.currentState, reply: reply.text };
  return {
    id: "insufficient-evidence",
    observed,
    checks: [
      { id: "live-reading-required", pass: context.currentState === true },
      { id: "invented-figure-removed", pass: !/410000|\$\s?\d/.test(reply.text) },
      {
        id: "gap-is-stated",
        pass: /can't verify|unavailable/i.test(reply.text),
      },
    ],
  };
}

function simpleQuestion() {
  const query = "What is 2 + 2?";
  const transcript = [{ role: "user", content: query }];
  const move = conversationMove(transcript, query);
  const context = planContext(query, { transcript });
  const plan = planMemoryRetrieval(query);
  const selected = idsOf(selectPersonalFacts(query, [PREFERENCE, CABIN_FACT, OAK_FACT]));
  const reply = settleReply({
    transcript,
    text: "4.",
    toolCalls: [{ name: "web_search", callId: "search" }],
    pack: replyPack(context),
  });
  const observed = {
    move: move.kind,
    live: context.live,
    episodic: plan.episodic,
    selected,
    tools: reply.toolCalls.map((call) => call.name),
    reply: reply.text,
  };
  return {
    id: "simple-question",
    observed,
    checks: [
      { id: "direct-move", pass: move.kind === "direct" },
      { id: "no-live-tool-domain", pass: context.live.length === 0 },
      { id: "no-episode-search", pass: plan.episodic === false },
      {
        id: "no-unrelated-property-facts",
        pass: !selected.includes("cabin") && !selected.includes("oak"),
      },
      { id: "no-tool-call-kept", pass: reply.toolCalls.length === 0 },
      { id: "short-answer-kept", pass: reply.text === "4." },
    ],
  };
}

function genericRewrite() {
  const thanks = [{ role: "user", content: "Thanks." }];
  const bare = settleReply({
    transcript: thanks,
    text: "Would you like me to pull the full breakdown?",
    toolCalls: [{ name: "finance_summary", callId: "finance" }],
    pack: null,
  });
  const figure = settleReply({
    transcript: thanks,
    text: "The lake cabin equity is $410,000. Would you like me to break that down?",
    toolCalls: [{ name: "finance_summary", callId: "finance" }],
    pack: null,
  });
  const observed = {
    bare: bare.text,
    bareTools: bare.toolCalls.map((call) => call.name),
    figure: figure.text,
    figureTools: figure.toolCalls.map((call) => call.name),
  };
  return {
    id: "generic-rewrite",
    observed,
    checks: [
      { id: "bare-thanks-drops-tool", pass: bare.toolCalls.length === 0 },
      { id: "bare-thanks-drops-offer", pass: !/would you like/i.test(bare.text) },
      { id: "supported-figure-preserved", pass: /410/.test(figure.text) },
      { id: "figure-reply-drops-offer", pass: !/would you like/i.test(figure.text) },
    ],
  };
}

function wastefulInvestigation() {
  const transcript = [
    { role: "user", content: "How much equity do I have in the house?" },
    {
      role: "assistant",
      content: "About $321K, using the mortgage and the current value.",
    },
    { role: "user", content: "Got it." },
  ];
  const query = "Got it.";
  const move = conversationMove(transcript, query);
  const context = planContext(query, { transcript });
  const reply = settleReply({
    transcript,
    text: "I will pull the finance summary again.",
    toolCalls: [{ name: "finance_summary", callId: "again" }],
    pack: replyPack(context),
  });
  const observed = {
    move: move.kind,
    live: context.live,
    memory: context.memory,
    tools: reply.toolCalls.map((call) => call.name),
  };
  return {
    id: "wasteful-investigation",
    observed,
    checks: [
      { id: "reaction-not-a-task", pass: move.kind === "acknowledge" },
      { id: "no-inherited-live-tools", pass: context.live.length === 0 },
      {
        id: "working-memory-only",
        pass: context.memory.length === 1 && context.memory[0] === "working",
      },
      { id: "tool-call-dropped", pass: reply.toolCalls.length === 0 },
    ],
  };
}

// Locked after the first offline run on 16 Oct 2026. Update this only when the
// scored functions change and the new outcomes have been reviewed.
export const INTELLIGENCE_BASELINE = Object.freeze([
  {
    id: "ambiguous-follow-up",
    pass: false,
    failed: ["referent-is-cabin-or-unresolved", "oak-fact-excluded", "finance-waits-for-subject"],
  },
  {
    id: "earlier-conversation",
    pass: false,
    failed: ["episodic-gate-opens"],
  },
  {
    id: "different-wording",
    pass: false,
    failed: ["oak-fact-excluded"],
  },
  {
    id: "multiple-sources",
    pass: false,
    failed: ["decision-episode-searched", "decision-survives-unguarded-price"],
  },
  {
    id: "authorized-read",
    pass: false,
    failed: ["code-tool-planned", "prior-conversation-searched"],
  },
  {
    id: "conflicting-evidence",
    pass: false,
    failed: ["both-episodes-considered"],
  },
  {
    id: "insufficient-evidence",
    pass: true,
    failed: [],
  },
  {
    id: "simple-question",
    pass: false,
    failed: ["no-tool-call-kept"],
  },
  {
    id: "generic-rewrite",
    pass: false,
    failed: ["supported-figure-preserved"],
  },
  {
    id: "wasteful-investigation",
    pass: true,
    failed: [],
  },
]);

function compact(card) {
  return card.map((row) => ({ id: row.id, pass: row.pass, failed: row.failed }));
}

test("phase 1 fixtures cover ten classes and match the locked scorecard", () => {
  const card = evaluateIntelligenceFixtures();
  assert.deepEqual(
    card.map((row) => row.id),
    INTELLIGENCE_BASELINE.map((row) => row.id)
  );
  assert.deepEqual(compact(card), INTELLIGENCE_BASELINE);
});

test("phase 1 failure list is the locked gap record", () => {
  const failures = compact(evaluateIntelligenceFixtures()).filter((row) => row.pass === false);
  assert.deepEqual(
    failures,
    INTELLIGENCE_BASELINE.filter((row) => row.pass === false)
  );
  assert.equal(failures.length, 8);
  assert.equal(INTELLIGENCE_BASELINE.filter((row) => row.pass).length, 2);
});
