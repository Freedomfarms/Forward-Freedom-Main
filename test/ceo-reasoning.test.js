import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_TYPE_COMMIT_CONFIDENCE,
  CEO_MISSION_REASONING_RULES,
  rankMissingByRelevance,
  selectHighestValueQuestion,
  shouldCommitAgentType,
  sketchMissionFromMessage,
} from "../server/agents/ceoReasoning.js";
import { BRAIN_SYSTEM_PROMPT, CEO_EXECUTIVE_CONTRACT } from "../server/brain/prompts.js";
import { isBrainChatEnabled } from "../server/brain/index.js";

test("Brain prompt uses executive contract — sketcher rules are offline only", () => {
  // Legacy constant may still exist for offline/metrics tests.
  assert.match(CEO_MISSION_REASONING_RULES, /ONE highest-value question/i);
  assert.doesNotMatch(CEO_MISSION_REASONING_RULES, /INTERVIEW_TOPICS/);
  // Live Brain prompt must NOT include the interview pipeline.
  assert.ok(!BRAIN_SYSTEM_PROMPT.includes(CEO_MISSION_REASONING_RULES));
  assert.match(CEO_EXECUTIVE_CONTRACT, /Ask only questions that truly block progress/i);
  assert.match(BRAIN_SYSTEM_PROMPT, /single executive intelligence/i);
  assert.match(BRAIN_SYSTEM_PROMPT, /never invent unavailable capabilities/i);
  assert.doesNotMatch(BRAIN_SYSTEM_PROMPT, /ONE highest-value question/i);
  assert.doesNotMatch(BRAIN_SYSTEM_PROMPT, /gather execution blockers first/i);
});

test("Brain chat path is always on (CEO world-model path)", () => {
  const previous = process.env.FREEDOM_BRAIN_CHAT;
  try {
    delete process.env.FREEDOM_BRAIN_CHAT;
    assert.equal(isBrainChatEnabled(), true);
    process.env.FREEDOM_BRAIN_CHAT = "0";
    assert.equal(isBrainChatEnabled(), true);
    process.env.FREEDOM_BRAIN_CHAT = "true";
    assert.equal(isBrainChatEnabled(), true);
  } finally {
    if (previous == null) delete process.env.FREEDOM_BRAIN_CHAT;
    else process.env.FREEDOM_BRAIN_CHAT = previous;
  }
});

test("Test 1: social media agent — first gap is people to monitor", () => {
  const sketch = sketchMissionFromMessage(
    "I want an agent that emails me social media reports on a couple people."
  );
  assert.match(sketch.mission || "", /social media/i);
  assert.ok(sketch.known.some((fact) => /email/i.test(fact)));
  assert.equal(sketch.missing[0], "people to monitor");
  assert.match(sketch.selectedQuestion || "", /people|who/i);
  assert.doesNotMatch(sketch.selectedQuestion || "", /personality|tone|escalat|finance/i);
  // Must not invent a committed finance type
  assert.notEqual(sketch.tentativeAgentType, "finance");
  assert.ok(sketch.agentTypeConfidence < AGENT_TYPE_COMMIT_CONFIDENCE);
  assert.equal(shouldCommitAgentType(sketch.agentTypeConfidence, []), false);
});

test("Test 2: ambiguous competitors — ask who/which competitors", () => {
  const sketch = sketchMissionFromMessage("Build me something that watches my competitors.");
  assert.match(sketch.mission || "", /competitor/i);
  assert.ok(sketch.missing.some((gap) => /competitor|industry/i.test(gap)));
  assert.match(sketch.selectedQuestion || "", /competitor|industry|who|which/i);
  assert.doesNotMatch(sketch.selectedQuestion || "", /personality|platform|linkedin/i);
});

test("Test 3: complete social request — info-complete but capability-blocked", () => {
  const sketch = sketchMissionFromMessage(
    "Every morning email me a summary of Elon Musk and Jensen Huang posts from X and LinkedIn."
  );
  assert.ok(sketch.known.some((fact) => /Elon Musk/i.test(fact)));
  assert.ok(sketch.known.some((fact) => /Jensen Huang/i.test(fact)));
  assert.ok(sketch.known.some((fact) => /X|LinkedIn/i.test(fact)));
  assert.ok(!sketch.missing.includes("people to monitor"));
  assert.ok(!sketch.missing.includes("platforms to monitor"));
  // Should not keep collecting personality-style preferences
  assert.ok(
    !sketch.missing.some((gap) => /personality|tone|escalat|boundary/i.test(gap))
  );
  // Native social connectors are unavailable — must not be live-executable.
  assert.equal(sketch.capabilityBlocked, true);
  assert.equal(sketch.missionExecutable, false);
  assert.ok(sketch.requiredCapabilities.includes("social_media_monitoring"));
});

test("rankMissingByRelevance prioritizes execution blockers over personality", () => {
  const ranked = rankMissingByRelevance(
    ["personality / tone", "people to monitor", "escalation rules", "platforms"],
    { known: ["Deliver by email"] }
  );
  assert.equal(ranked[0], "people to monitor");
  assert.ok(ranked.indexOf("platforms") < ranked.indexOf("personality / tone"));
  const selected = selectHighestValueQuestion(ranked);
  assert.match(selected.selectedQuestion, /people/i);
});
