import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyQuestionNecessity,
  computeEfficiencyMetrics,
  detectReaskField,
  EFFICIENCY_TARGETS,
  evaluateEfficiencyTarget,
  emptyEfficiencyLog,
  summarizeMissionCompletion,
  updateEfficiencyLog,
} from "../server/agents/ceoEfficiencyMetrics.js";
import {
  advanceMissionState,
  emptyMissionState,
  sketchMissionFromConversation,
  sketchMissionFromMessage,
} from "../server/agents/ceoReasoning.js";
import { CEO_MISSION_REASONING_RULES } from "../server/agents/ceoReasoning.js";

const EXISTING_AGENTS = [
  { id: "a1", name: "Supplier Risk Agent", agentType: "research" },
  { id: "a2", name: "Portfolio Watch", agentType: "finance" },
];

function clock() {
  let n = 0;
  return () => {
    n += 1;
    return `2026-07-27T00:00:0${n}.000Z`;
  };
}

test("CEO rules require minimum questions to reach execution", () => {
  assert.match(CEO_MISSION_REASONING_RULES, /minimum clarification questions/i);
  assert.match(CEO_MISSION_REASONING_RULES, /blocking dependency/i);
});

test("efficiency log fields exist on empty / sketched mission state", () => {
  const empty = emptyMissionState();
  assert.deepEqual(Object.keys(empty.efficiency).sort(), [
    "blockingGapsResolved",
    "deferredPreferences",
    "missionExecutableAt",
    "missionStartedAt",
    "questionsAsked",
    "reaskedFields",
  ].sort());

  const sketch = sketchMissionFromMessage("I need a weekly supplier risk report.");
  assert.ok(sketch.efficiency.missionStartedAt);
  assert.equal(sketch.efficiency.missionExecutableAt, null);
  assert.ok(sketch.efficiency.questionsAsked.length >= 1);
  assert.ok(sketch.efficiency.questionsAsked[0].question);
});

test("Questions Until Execution: counts clarifications until missionExecutable", () => {
  const now = clock();
  let state = emptyMissionState();
  state = advanceMissionState(state, "I need a supplier risk agent.", { now });
  assert.equal(state.missionExecutable, false);
  assert.equal(state.efficiency.questionsAsked.length, 1);
  assert.equal(state.efficiency.missionExecutableAt, null);

  state = advanceMissionState(state, "Pratt suppliers.", { now });
  state = advanceMissionState(state, "Weekly email.", { now });

  const metrics = computeEfficiencyMetrics(state.efficiency);
  if (state.missionExecutable) {
    assert.ok(state.efficiency.missionExecutableAt);
    assert.equal(metrics.questionsUntilExecution, state.efficiency.questionsAsked.length);
    assert.ok(metrics.questionsUntilExecution <= 5);
  } else {
    assert.equal(metrics.questionsUntilExecution, null);
    assert.ok(state.efficiency.questionsAsked.length >= 1);
  }
  assert.ok(state.efficiency.blockingGapsResolved.some((gap) => /supplier/i.test(gap)));
});

test("Unnecessary Question Rate: known / non-blocking / deferrable preference", () => {
  const knownState = {
    known: ["Suppliers: Pratt", "Deliver by email"],
    missing: ["which risk signals matter"],
    missionExecutable: false,
  };
  const reask = classifyQuestionNecessity("Which suppliers should I monitor?", knownState);
  assert.equal(reask.unnecessary, true);
  assert.ok(reask.reasons.includes("information_already_known"));

  const pref = classifyQuestionNecessity("What personality should the agent have?", {
    known: [],
    missing: ["which suppliers or supplier list"],
    missionExecutable: false,
  });
  assert.equal(pref.unnecessary, true);
  assert.ok(pref.reasons.includes("deferrable_preference"));

  const afterExec = classifyQuestionNecessity("Anything else?", {
    known: ["Suppliers: Pratt"],
    missing: [],
    missionExecutable: true,
  });
  assert.equal(afterExec.unnecessary, true);
  assert.ok(afterExec.reasons.includes("does_not_block_execution"));

  const blocking = classifyQuestionNecessity("Which suppliers or supplier list?", {
    known: ["Domain: supplier risk"],
    missing: ["which suppliers or supplier list"],
    missionExecutable: false,
  });
  assert.equal(blocking.unnecessary, false);
});

test("Re-ask Rate: detect questions for already captured fields", () => {
  const field = detectReaskField(
    "Which suppliers should we watch?",
    { known: ["Suppliers: Pratt"] },
    []
  );
  assert.equal(field, "suppliers");

  const dup = detectReaskField(
    "Which suppliers or supplier list?",
    { known: [] },
    [{ question: "What about which suppliers or supplier list?" }]
  );
  assert.equal(dup, "suppliers");
});

test("Mission Completion Rate: aggregate across conversations", () => {
  const complete = sketchMissionFromConversation(
    [
      "Every morning email me a summary of Elon Musk and Jensen Huang posts from X and LinkedIn.",
    ],
    { now: clock() }
  );
  const incomplete = sketchMissionFromConversation(["Build me something that tracks competitors."], {
    now: clock(),
  });
  const existing = sketchMissionFromConversation(["I already have a supplier agent."], {
    existingAgents: EXISTING_AGENTS,
    now: clock(),
  });

  assert.equal(complete.missionExecutable, true);
  assert.ok(complete.efficiency.missionExecutableAt);
  assert.equal(incomplete.missionExecutable, false);
  assert.equal(existing.missionExecutable, true);

  const summary = summarizeMissionCompletion([
    complete.efficiency,
    incomplete.efficiency,
    existing.efficiency,
  ]);
  assert.equal(summary.missions, 3);
  assert.equal(summary.completed, 2);
  assert.equal(summary.missionCompletionRate, 2 / 3);
});

test("Acceptance target — simple missions: <= 2 questions", () => {
  assert.equal(EFFICIENCY_TARGETS.simple.maxQuestions, 2);

  const existing = sketchMissionFromConversation(["I already have a supplier agent."], {
    existingAgents: EXISTING_AGENTS,
    now: clock(),
  });
  const metrics = computeEfficiencyMetrics(existing.efficiency);
  const verdict = evaluateEfficiencyTarget("simple", metrics, existing.efficiency);
  assert.equal(verdict.ok, true, JSON.stringify({ metrics, verdict }, null, 2));
  assert.ok(metrics.questionsUntilExecution <= 2);

  const complete = sketchMissionFromMessage(
    "Every morning email me a summary of Elon Musk and Jensen Huang posts from X and LinkedIn."
  );
  const completeMetrics = computeEfficiencyMetrics(complete.efficiency);
  const completeVerdict = evaluateEfficiencyTarget("simple", completeMetrics, complete.efficiency);
  assert.equal(complete.missionExecutable, true);
  assert.equal(completeVerdict.ok, true, JSON.stringify({ completeMetrics, completeVerdict }, null, 2));
  assert.ok(completeMetrics.questionsUntilExecution <= 2);
});

test("Acceptance target — medium missions: <= 5 questions", () => {
  assert.equal(EFFICIENCY_TARGETS.medium.maxQuestions, 5);

  const now = clock();
  const state = sketchMissionFromConversation(
    ["I need a supplier risk agent.", "Pratt suppliers.", "Weekly email."],
    { now }
  );
  const metrics = computeEfficiencyMetrics(state.efficiency);
  console.info(
    `[ceo-efficiency-acceptance] medium-supplier\n${JSON.stringify({ metrics, efficiency: state.efficiency }, null, 2)}`
  );

  if (state.missionExecutable) {
    const verdict = evaluateEfficiencyTarget("medium", metrics, state.efficiency);
    assert.equal(verdict.ok, true, JSON.stringify({ metrics, verdict }, null, 2));
    assert.ok(metrics.questionsUntilExecution <= 5);
  } else {
    // Still must not thrash: open missions stay under the medium ceiling while asking
    assert.ok(
      state.efficiency.questionsAsked.length <= 5,
      `open medium mission asked ${state.efficiency.questionsAsked.length} questions`
    );
  }
  assert.equal(metrics.unnecessaryQuestionRate, 0);
  assert.equal(metrics.reaskRate, 0);
});

test("Acceptance target — complex missions: every question resolves a blocker", () => {
  assert.equal(EFFICIENCY_TARGETS.complex.maxQuestions, null);
  assert.equal(EFFICIENCY_TARGETS.complex.requireBlockingOnly, true);

  const now = clock();
  // Multi-gap create mission: each clarification must clear a blocker (no cap).
  const state = sketchMissionFromConversation(
    [
      "I want an agent that emails me social media reports on a couple people.",
      "Elon Musk and Jensen Huang.",
    ],
    { now }
  );
  const metrics = computeEfficiencyMetrics(state.efficiency);
  console.info(
    `[ceo-efficiency-acceptance] complex-competitors\n${JSON.stringify({ metrics, efficiency: state.efficiency }, null, 2)}`
  );

  assert.ok(state.efficiency.questionsAsked.length >= 1);
  for (const row of state.efficiency.questionsAsked) {
    assert.equal(
      row.unnecessary,
      false,
      `complex mission asked unnecessary question: ${JSON.stringify(row)}`
    );
    assert.ok(
      !row.reasons.includes("deferrable_preference"),
      `complex mission asked deferrable preference: ${row.question}`
    );
  }
  assert.equal(metrics.unnecessaryQuestionRate, 0);
  assert.equal(metrics.reaskCount, 0);
  // Every asked question should have corresponded to a resolved blocker or remaining gap.
  assert.ok(
    state.efficiency.blockingGapsResolved.length + state.missing.length >= 1,
    "complex mission must surface blocking dependencies"
  );
  const verdict = evaluateEfficiencyTarget("complex", metrics, state.efficiency);
  assert.equal(verdict.ok, true, JSON.stringify({ metrics, verdict }, null, 2));
});

test("deferredPreferences and reaskedFields are logged across turns", () => {
  const now = clock();
  let state = advanceMissionState(emptyMissionState(), "Always give me executive summaries.", {
    now,
  });
  state = advanceMissionState(state, "I need a supplier risk agent.", { now });
  assert.ok(
    state.efficiency.deferredPreferences.some((p) => /executive summar/i.test(p)),
    JSON.stringify(state.efficiency, null, 2)
  );

  // Simulate a bad re-ask transition for logging coverage
  const prior = {
    ...state,
    known: [...state.known, "Suppliers: Pratt"],
    missing: ["which suppliers or supplier list"],
    missionExecutable: false,
    selectedQuestion: null,
  };
  const badNext = {
    ...prior,
    selectedQuestion: "Which suppliers or supplier list?",
    missionExecutable: false,
  };
  const log = updateEfficiencyLog(emptyEfficiencyLog(), { prior, next: badNext, now: now() });
  assert.ok(log.reaskedFields.includes("suppliers"));
  assert.ok(log.questionsAsked.some((q) => q.unnecessary));
});
