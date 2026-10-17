// Phase 2 regressions for conversation understanding.
// These stay on the exported intent, working-memory, and reply functions.
// Retrieval ranking and the episodic gate are not in this file.

import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationMove,
  MOVE,
  renderConversationMove,
  settleReply,
} from "../server/chief/context/behavior.js";
import { planContext } from "../server/chief/context/orchestrate.js";
import {
  buildWorkingMemory,
  renderWorkingMemory,
  resolveReference,
} from "../server/chief/memory/working.js";

test("the other one switches to the previous user subject", () => {
  const places = [
    { role: "user", content: "How much XRP do I own?" },
    { role: "user", content: "What about my house?" },
    { role: "user", content: "the other one" },
  ];
  const memory = buildWorkingMemory(places);
  assert.equal(memory.referent, "XRP");
  assert.equal(memory.unresolvedOther, false);
  assert.equal(resolveReference(memory, "the other one"), "XRP");
  assert.match(renderWorkingMemory(memory), /refer to XRP/);
});

test("the other one stays unresolved when the conversation names only one subject", () => {
  const transcript = [
    { role: "user", content: "How much equity do I have in the house?" },
    { role: "assistant", content: "About $321K, using the mortgage and the current value." },
    { role: "user", content: "What about the other one?" },
  ];
  const memory = buildWorkingMemory(transcript);
  assert.equal(memory.referent, null);
  assert.equal(memory.unresolvedOther, true);
  assert.match(renderWorkingMemory(memory), /not named in this conversation/);
  assert.doesNotMatch(renderWorkingMemory(memory), /refer to house/);

  const move = conversationMove(transcript);
  assert.equal(move.kind, MOVE.CONTINUE);
  assert.equal(move.referent, null);
  assert.equal(move.unresolvedOther, true);
  assert.match(renderConversationMove(transcript), /does not name it/);
  assert.deepEqual(planContext("What about the other one?", { transcript }).live, []);
});

test("a same-subject follow-up still inherits the live domain", () => {
  const holding = [
    { role: "user", content: "How much XRP do I own?" },
    { role: "assistant", content: "You own 2,500 XRP." },
    { role: "user", content: "what about that?" },
  ];
  assert.equal(conversationMove(holding).referent, "XRP");
  assert.deepEqual(planContext("what about that?", { transcript: holding }).live, ["finance"]);

  const equity = [
    { role: "user", content: "What's my house worth?" },
    { role: "assistant", content: "Your current estimate is around $647K." },
    { role: "user", content: "What about equity?" },
  ];
  assert.deepEqual(planContext("What about equity?", { transcript: equity }).live, ["finance"]);

  const house = [
    { role: "user", content: "How much XRP do I own?" },
    { role: "assistant", content: "59,000 XRP." },
    { role: "user", content: "What about my house?" },
  ];
  const planned = planContext("What about my house?", { transcript: house });
  assert.deepEqual(planned.live, ["finance"]);
  assert.equal(planned.live.includes("web"), false);
});

test("thanks and got it stay short unless the model stated a concrete figure", () => {
  const thanks = settleReply({
    transcript: [{ role: "user", content: "Thanks." }],
    text: "Would you like me to pull the full breakdown?",
    toolCalls: [{ name: "finance_summary", callId: "finance" }],
  });
  assert.equal(thanks.text, "Anytime.");
  assert.deepEqual(thanks.toolCalls, []);

  const gotIt = [
    { role: "user", content: "How much equity do I have in the house?" },
    { role: "assistant", content: "About $321K, using the mortgage and the current value." },
    { role: "user", content: "Got it." },
  ];
  const stopped = settleReply({
    transcript: gotIt,
    text: "I will pull the finance summary again.",
    toolCalls: [{ name: "finance_summary", callId: "again" }],
  });
  assert.doesNotMatch(stopped.text, /would you like/i);
  assert.deepEqual(stopped.toolCalls, []);
  assert.equal(conversationMove(gotIt).kind, MOVE.ACKNOWLEDGE);
  assert.deepEqual(planContext("Got it.", { transcript: gotIt }).live, []);

  const figure = settleReply({
    transcript: [{ role: "user", content: "Thanks." }],
    text: "The lake cabin equity is $410,000. Would you like me to break that down?",
    toolCalls: [{ name: "finance_summary", callId: "finance" }],
  });
  assert.match(figure.text, /\$410,000/);
  assert.doesNotMatch(figure.text, /would you like/i);
  assert.deepEqual(figure.toolCalls, []);
});

test("a concrete figure on a reaction still has to come from a current reading", () => {
  const blocked = settleReply({
    transcript: [{ role: "user", content: "Thanks." }],
    text: "The lake cabin equity is $410,000.",
    pack: { plan: { currentState: true }, authority: [{ origin: "live", available: false }] },
  });
  assert.equal(
    blocked.text,
    "I'm missing the current mortgage balance and current home value needed to calculate home equity."
  );
  assert.doesNotMatch(blocked.text, /410/);

  const grounded = settleReply({
    transcript: [{ role: "user", content: "Thanks." }],
    text: "The lake cabin equity is $410,000.",
    pack: {
      plan: { currentState: true },
      authority: [
        {
          origin: "live",
          available: true,
          source: "freedom_financial",
          sourceType: "live_financial_state",
          text: "cabin equity 410000",
        },
      ],
    },
  });
  assert.match(grounded.text, /\$410,000/);

  const unattributed = settleReply({
    transcript: [{ role: "user", content: "Thanks." }],
    text: "The lake cabin equity is $410,000.",
    pack: {
      plan: { currentState: true, live: ["finance"] },
      authority: [{ origin: "live", available: true, text: "cabin equity 410000" }],
    },
  });
  assert.doesNotMatch(unattributed.text, /410/);
});
