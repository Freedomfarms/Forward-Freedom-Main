import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceMissionState,
  emptyMissionState,
  isHighestValueQuestion,
  sketchMissionFromConversation,
} from "../server/agents/ceoReasoning.js";

const PREFERENCE_RE = /personality|tone|voice|style|escalat|boundar/i;

const EXISTING_AGENTS = [
  { id: "a1", name: "Supplier Risk Agent", agentType: "research" },
  { id: "a2", name: "Portfolio Watch", agentType: "finance" },
];

function capture(label, state) {
  return {
    label,
    "Conversation history": state.conversationHistory,
    "Current Situation": state.situation,
    "Updated Mission": state.mission,
    "Changed Facts": state.changedFacts,
    "Remaining Gaps": state.missing,
    Decision: state.decision,
    "Question chosen": state.selectedQuestion,
    "Highest-value?": isHighestValueQuestion(state.selectedQuestion, state.missing, {
      known: state.known,
    }),
    missionExecutable: state.missionExecutable,
    createsNewCapability: state.createsNewCapability,
    preferences: state.preferences,
    deliveryChannel: state.deliveryChannel,
  };
}

function assertNoPreferenceRestart(report, state) {
  assert.doesNotMatch(state.selectedQuestion || "", PREFERENCE_RE, JSON.stringify(report, null, 2));
  assert.ok(
    !(state.missing || []).some((gap) => PREFERENCE_RE.test(gap)),
    JSON.stringify(report, null, 2)
  );
  assert.equal(report["Highest-value?"], true, JSON.stringify(report, null, 2));
}

test("Continuity Test 1: progressive mission building (supplier risk)", () => {
  let state = emptyMissionState();

  state = advanceMissionState(state, "I need a supplier risk agent.");
  let report = capture("turn-1", state);
  console.info(`[ceo-continuity]\n${JSON.stringify(report, null, 2)}`);
  assert.match(state.mission || "", /supplier/i);
  assert.equal(state.missionKind, "create");
  assert.ok(state.missing.some((gap) => /supplier/i.test(gap)));
  assert.match(state.selectedQuestion || "", /supplier/i);
  assert.doesNotMatch(state.selectedQuestion || "", PREFERENCE_RE);
  assertNoPreferenceRestart(report, state);

  state = advanceMissionState(state, "Pratt suppliers.");
  report = capture("turn-2", state);
  console.info(`[ceo-continuity]\n${JSON.stringify(report, null, 2)}`);
  assert.match(state.mission || "", /supplier/i, "must remember supplier risk mission");
  assert.ok(
    state.known.some((fact) => /Pratt/i.test(fact)),
    `expected Pratt in known\n${JSON.stringify(report, null, 2)}`
  );
  assert.ok(
    !state.missing.some((gap) => /which suppliers/i.test(gap)),
    `must not re-ask which suppliers\n${JSON.stringify(report, null, 2)}`
  );
  assert.doesNotMatch(state.selectedQuestion || "", /which suppliers/i);
  assertNoPreferenceRestart(report, state);

  state = advanceMissionState(state, "Weekly email.");
  report = capture("turn-3", state);
  console.info(`[ceo-continuity]\n${JSON.stringify(report, null, 2)}`);
  assert.match(state.mission || "", /supplier/i);
  assert.ok(state.known.some((fact) => /weekly/i.test(fact)));
  assert.ok(state.known.some((fact) => /email/i.test(fact)));
  assert.ok(state.known.some((fact) => /Pratt/i.test(fact)), "scope remembered");
  // Only remaining blockers (if any) — not suppliers / not preferences
  assert.ok(!state.missing.some((gap) => /supplier/i.test(gap)));
  assert.doesNotMatch(state.selectedQuestion || "", /supplier|personality|tone/i);
  if (state.missionExecutable) {
    assert.equal(state.selectedQuestion, null);
  } else {
    assert.ok(state.selectedQuestion, "ask only remaining blocker");
  }
  assertNoPreferenceRestart(report, state);
});

test("Continuity Test 2: existing capability awareness — no duplicate", () => {
  const state = sketchMissionFromConversation(["I already have a supplier agent."], {
    existingAgents: EXISTING_AGENTS,
  });
  const report = capture("existing", state);
  console.info(`[ceo-continuity]\n${JSON.stringify(report, null, 2)}`);

  assert.equal(state.modifiesExisting, true);
  assert.equal(state.createsNewCapability, false);
  assert.ok(state.existingAgentReferenced);
  assert.match(state.decision || "", /not create a duplicate|existing/i);
  assert.ok(state.known.some((fact) => /existing|supplier/i.test(fact)));
  assertNoPreferenceRestart(report, state);
});

test("Continuity Test 3: correction updates mission — does not restart intake", () => {
  let state = sketchMissionFromConversation([
    "I need a supplier risk agent.",
    "Pratt suppliers.",
    "Weekly email.",
  ]);
  const beforeMission = state.mission;
  const beforeSuppliers = state.known.filter((fact) => /Pratt|Suppliers/i.test(fact));

  state = advanceMissionState(state, "Actually, not email. Put it in Teams.");
  const report = capture("correction", state);
  console.info(`[ceo-continuity]\n${JSON.stringify(report, null, 2)}`);

  assert.equal(state.mission, beforeMission, "mission must not restart");
  assert.ok(beforeSuppliers.every((fact) => state.known.includes(fact)));
  assert.equal(state.deliveryChannel, "Teams");
  assert.ok(state.known.some((fact) => /Teams/i.test(fact)));
  assert.ok(
    !state.known.some((fact) => /^Deliver by email$/i.test(fact)),
    `email delivery should be cleared\n${JSON.stringify(report, null, 2)}`
  );
  assert.ok(
    state.changedFacts.some((fact) => /Teams|Removed email/i.test(fact)),
    JSON.stringify(report, null, 2)
  );
  // Must not re-ask suppliers or restart with personality
  assert.ok(!state.missing.some((gap) => /supplier/i.test(gap)));
  assert.doesNotMatch(state.selectedQuestion || "", /supplier|personality|tone/i);
  assertNoPreferenceRestart(report, state);
});

test("Continuity Test 4: standing preference applied on later turn", () => {
  let state = advanceMissionState(emptyMissionState(), "Always give me executive summaries.");
  let report = capture("pref-set", state);
  console.info(`[ceo-continuity]\n${JSON.stringify(report, null, 2)}`);
  assert.ok(
    state.preferences.some((pref) => /executive summar/i.test(pref)),
    JSON.stringify(report, null, 2)
  );

  state = advanceMissionState(state, "Review this report.");
  report = capture("pref-apply", state);
  console.info(`[ceo-continuity]\n${JSON.stringify(report, null, 2)}`);
  assert.ok(
    state.preferences.some((pref) => /executive summar/i.test(pref)),
    "preference retained"
  );
  assert.ok(
    state.known.some((fact) => /executive summary/i.test(fact)) ||
      /executive-summary/i.test(state.decision || ""),
    `preference should be applied\n${JSON.stringify(report, null, 2)}`
  );
  assert.match(state.decision || "", /executive|Review/i);
  assertNoPreferenceRestart(report, state);
});

test("Continuity: sketchMissionFromConversation folds progressive supplier build", () => {
  const state = sketchMissionFromConversation([
    "I need a supplier risk agent.",
    "Pratt suppliers.",
    "Weekly email.",
    "Actually, not email. Put it in Teams.",
  ]);
  const report = capture("full-thread", state);
  console.info(`[ceo-continuity]\n${JSON.stringify(report, null, 2)}`);
  assert.match(state.mission || "", /supplier/i);
  assert.ok(state.known.some((fact) => /Pratt/i.test(fact)));
  assert.ok(state.known.some((fact) => /weekly/i.test(fact)));
  assert.equal(state.deliveryChannel, "Teams");
  assert.equal(state.conversationHistory.length, 4);
  assertNoPreferenceRestart(report, state);
});

test("Continuity: follow-up does not invent a new finance mission", () => {
  const state = sketchMissionFromConversation([
    "I need a supplier risk agent.",
    "Pratt suppliers.",
  ]);
  assert.notEqual(state.tentativeAgentType, "finance");
  assert.match(state.mission || "", /supplier/i);
  assert.ok(!state.missing.some((gap) => /which suppliers/i.test(gap)));
});
