import test from "node:test";
import assert from "node:assert/strict";

import { renderInferredMission } from "../server/brain/identity.js";
import {
  assessControlPlaneRequest,
  renderCapabilitySituationBrief,
  validateCapabilityConsistency,
  CEO_INTENTS,
} from "../server/brain/controlPlane.js";
import {
  BRAIN_SYSTEM_PROMPT,
  CEO_EXECUTIVE_CONTRACT,
} from "../server/brain/prompts.js";
import {
  CEO_REASONING_HOT_PATH,
  CEO_REASONING_MIGRATION_STATUS,
} from "../server/brain/ceoReasoningDependencies.js";
import { isBrainChatEnabled } from "../server/brain/index.js";
import { CEO_MISSION_REASONING_RULES } from "../server/agents/ceoReasoning.js";

test("ACTIVE MISSION render is inferred metadata — not forced question ordering", () => {
  const rendered = renderInferredMission({
    mission: "Monitor social posts for several creators",
    missionKind: "create",
    missionExecutable: false,
    known: ["Domain: social media reporting", "Platforms: Instagram"],
    missing: ["people to monitor", "frequency / schedule"],
    selectedQuestion: "Who should I monitor?",
  });

  assert.match(rendered, /authority: inferred_from_conversation/);
  assert.match(rendered, /possible_objective:/);
  assert.match(rendered, /confidence:/);
  assert.match(rendered, /Validate if relevant/i);
  assert.doesNotMatch(rendered, /executable:/);
  assert.doesNotMatch(rendered, /missing:/);
  assert.doesNotMatch(rendered, /Ask .* next/i);
  assert.doesNotMatch(rendered, /Who should I monitor/);
});

test("CONTROL PLANE ASSESSMENT is allow/deny safety — not judgment steering", () => {
  const controlPlane = assessControlPlaneRequest({
    message:
      "Create an agent to review Instagram posts daily. Run Monday-Friday at 6 PM.",
  });
  const brief = renderCapabilitySituationBrief({
    controlPlane,
    includeRegistry: false,
  }).join("\n");

  assert.match(brief, /mutations_allowed: no/);
  assert.match(brief, /allow\/deny safety/i);
  assert.doesNotMatch(brief, /intent:/);
  assert.doesNotMatch(brief, /system_action:/);
  assert.doesNotMatch(brief, /next_step:/);
  assert.doesNotMatch(brief, /highest-value|clarify_then_create|Ask:/i);
  assert.equal(controlPlane.systemAction.possible, true);
  assert.equal(controlPlane.systemAction.mutationsAllowed, false);
});

test("control plane does not consume sketcher missionState for steering", () => {
  const withNoise = assessControlPlaneRequest({
    message: "Create me a stock trading agent.",
    // Extra fields must be ignored (API no longer accepts missionState).
    missionState: {
      missionKind: "execute",
      missionExecutable: true,
      selectedQuestion: "Which brokerage?",
      createsNewCapability: true,
    },
  });
  assert.equal(withNoise.intent, CEO_INTENTS.NEW_AGENT_CREATION);
  assert.equal(withNoise.capabilityAssessment.allAvailable, false);
  assert.ok(!("nextStep" in (withNoise.systemAction || {})));
});

test("BRAIN_SYSTEM_PROMPT uses executive contract — not interview pipeline rules", () => {
  assert.match(CEO_EXECUTIVE_CONTRACT, /Ask only questions that truly block progress/i);
  assert.match(BRAIN_SYSTEM_PROMPT, /CEO_EXECUTIVE_CONTRACT|Understand the user's objective|Ask only questions that truly block/i);
  assert.match(BRAIN_SYSTEM_PROMPT, /inferred metadata only/i);
  assert.match(BRAIN_SYSTEM_PROMPT, /allow\/deny safety/i);
  // Old interview-style rules must not appear in the live system prompt.
  assert.doesNotMatch(BRAIN_SYSTEM_PROMPT, /ONE highest-value question/i);
  assert.doesNotMatch(BRAIN_SYSTEM_PROMPT, /Situation Brief → Mission Model/i);
  assert.doesNotMatch(BRAIN_SYSTEM_PROMPT, /gather execution blockers first/i);
  // Module may still export legacy constant for offline tests — but prompt must not include it.
  assert.ok(typeof CEO_MISSION_REASONING_RULES === "string");
  assert.ok(!BRAIN_SYSTEM_PROMPT.includes(CEO_MISSION_REASONING_RULES));
});

test("CEO Brain path is always enabled — no FREEDOM_BRAIN_CHAT opt-out", () => {
  const previous = process.env.FREEDOM_BRAIN_CHAT;
  try {
    process.env.FREEDOM_BRAIN_CHAT = "0";
    assert.equal(isBrainChatEnabled(), true);
    process.env.FREEDOM_BRAIN_CHAT = "false";
    assert.equal(isBrainChatEnabled(), true);
    delete process.env.FREEDOM_BRAIN_CHAT;
    assert.equal(isBrainChatEnabled(), true);
  } finally {
    if (previous == null) delete process.env.FREEDOM_BRAIN_CHAT;
    else process.env.FREEDOM_BRAIN_CHAT = previous;
  }
});

test("migration status: no decision shaping / question ranking on hot path", () => {
  assert.equal(CEO_REASONING_MIGRATION_STATUS.phase, "2A");
  assert.equal(CEO_REASONING_MIGRATION_STATUS.decisionShaping, false);
  assert.equal(CEO_REASONING_MIGRATION_STATUS.questionRankingInHotPath, false);
  assert.equal(CEO_REASONING_MIGRATION_STATUS.missionClassificationInHotPath, false);
  assert.ok(CEO_REASONING_HOT_PATH.every((d) => d.authority !== "steering_copy"));
});

test("regression: Done still blocked without capabilities (safety retained)", () => {
  const controlPlane = assessControlPlaneRequest({
    message: "Create me a stock trading agent.",
  });
  const bad = validateCapabilityConsistency("Done. Your stock trading agent is live.", {
    userMessage: "Create me a stock trading agent.",
    intent: controlPlane.intent,
    capabilityAssessment: controlPlane.capabilityAssessment,
  });
  assert.equal(bad.ok, false);

  const good = validateCapabilityConsistency(
    "I can design this agent, but these capabilities are not currently connected.",
    {
      userMessage: "Create me a stock trading agent.",
      intent: controlPlane.intent,
      capabilityAssessment: controlPlane.capabilityAssessment,
    }
  );
  assert.equal(good.ok, true, JSON.stringify(good));
});
