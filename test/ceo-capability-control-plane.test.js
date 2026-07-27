import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_DEFINITION_STATUS,
  buildAgentDefinition,
  buildPlannedAgentDefinition,
} from "../server/agents/agentDefinition.js";
import { sketchMissionFromMessage } from "../server/agents/ceoReasoning.js";
import {
  assessCapabilities,
  getCapability,
  listCapabilities,
  renderCapabilityRegistry,
  resolveRequiredCapabilities,
} from "../server/capabilities/registry.js";
import {
  assessControlPlaneRequest,
  buildExecutionState,
  CEO_INTENTS,
  classifyIntent,
  renderCapabilitySituationBrief,
  validateCapabilityConsistency,
} from "../server/brain/controlPlane.js";
import { BRAIN_SYSTEM_PROMPT } from "../server/brain/prompts.js";

test("capability registry lists available and unavailable capabilities", () => {
  const caps = listCapabilities();
  assert.ok(caps.some((c) => c.id === "web_research" && c.status === "available"));
  assert.ok(caps.some((c) => c.id === "finance_aggregates" && c.status === "available"));
  assert.ok(caps.some((c) => c.id === "scheduling" && c.status === "available"));

  const social = getCapability("social_media_monitoring");
  assert.equal(social.status, "unavailable");
  assert.deepEqual(social.tools, []);
  assert.deepEqual(social.supported_platforms, []);

  const trading = getCapability("stock_trading");
  assert.equal(trading.status, "unavailable");
});

test("regression: stock trading agent — CEO cannot claim Done", () => {
  const message = "Create me a stock trading agent.";
  const mission = sketchMissionFromMessage(message);
  const controlPlane = assessControlPlaneRequest({ message, missionState: mission });

  assert.equal(controlPlane.intent, CEO_INTENTS.NEW_AGENT_CREATION);
  assert.ok(controlPlane.requiredCapabilities.includes("stock_trading"));
  assert.equal(controlPlane.capabilityAssessment.allAvailable, false);
  assert.equal(controlPlane.systemAction.possible, false);
  assert.equal(controlPlane.systemAction.canClaimComplete, false);
  assert.equal(controlPlane.plannedAgent.status, AGENT_DEFINITION_STATUS.PLANNED);

  const executionState = buildExecutionState({
    intent: controlPlane.intent,
    capabilityAssessment: controlPlane.capabilityAssessment,
    agentDefinition: controlPlane.plannedAgent,
  });
  assert.equal(executionState.canClaimComplete, false);
  assert.equal(executionState.integrationsConnected, false);

  const bad = validateCapabilityConsistency("Done. Your stock trading agent is live.", {
    userMessage: message,
    intent: controlPlane.intent,
    capabilityAssessment: controlPlane.capabilityAssessment,
    executionState,
  });
  assert.equal(bad.ok, false);
  assert.ok(
    bad.failures.includes("claimed_complete_without_capabilities") ||
      bad.failures.includes("claimed_trading_capability") ||
      bad.failures.includes("claimed_agent_live_with_unavailable_capabilities")
  );

  const good = validateCapabilityConsistency(
    "I can design this agent, but these capabilities are not currently connected. No brokerage trading connector is available. Next step: connect a brokerage integration, or I can set up a read-only finance watcher instead.",
    {
      userMessage: message,
      intent: controlPlane.intent,
      capabilityAssessment: controlPlane.capabilityAssessment,
      executionState,
    }
  );
  assert.equal(good.ok, true, JSON.stringify(good));
});

test("regression: social media monitoring — checks capability registry before confirming", () => {
  const message =
    "Create an agent to review Instagram, TikTok, and X posts from WendyOcrypto, Mason Versluis, Patrick Bet-David, and Raoul Pal. Run Monday-Friday at 6 PM.";
  const mission = sketchMissionFromMessage(message);
  const controlPlane = assessControlPlaneRequest({ message, missionState: mission });

  assert.ok(
    controlPlane.intent === CEO_INTENTS.RECURRING_MISSION ||
      controlPlane.intent === CEO_INTENTS.NEW_AGENT_CREATION
  );
  assert.ok(controlPlane.requiredCapabilities.includes("social_media_monitoring"));
  assert.ok(controlPlane.requiredCapabilities.includes("instagram_connector"));
  assert.ok(controlPlane.requiredCapabilities.includes("tiktok_connector"));
  assert.ok(controlPlane.requiredCapabilities.includes("x_connector"));
  assert.equal(controlPlane.capabilityAssessment.allAvailable, false);
  assert.equal(mission.capabilityBlocked, true);
  assert.equal(mission.missionExecutable, false);

  // Situation brief must surface the registry assessment.
  const brief = renderCapabilitySituationBrief({
    controlPlane,
    executionState: buildExecutionState({
      intent: controlPlane.intent,
      capabilityAssessment: controlPlane.capabilityAssessment,
      agentDefinition: controlPlane.plannedAgent,
    }),
  }).join("\n\n");
  assert.match(brief, /PLATFORM CAPABILITIES/);
  assert.match(brief, /social_media_monitoring/);
  assert.match(brief, /status: unavailable/);
  assert.match(brief, /CONTROL PLANE ASSESSMENT/);
  assert.match(brief, /EXECUTION STATE/);
  assert.match(brief, /can_claim_complete: no/);

  const failure = validateCapabilityConsistency(
    "Done. Your Social Media Review agent is live.",
    {
      userMessage: message,
      intent: controlPlane.intent,
      capabilityAssessment: controlPlane.capabilityAssessment,
      executionState: buildExecutionState({
        intent: controlPlane.intent,
        capabilityAssessment: controlPlane.capabilityAssessment,
      }),
    }
  );
  assert.equal(failure.ok, false);
  assert.ok(
    failure.failures.includes("claimed_complete_without_capabilities") ||
      failure.failures.includes("claimed_social_monitoring_live") ||
      failure.failures.includes("claimed_agent_live_with_unavailable_capabilities")
  );
});

test("intent classification separates information, tasks, missions, create, modify", () => {
  assert.equal(
    classifyIntent("What agents do I have?"),
    CEO_INTENTS.INFORMATION_REQUEST
  );
  assert.equal(
    classifyIntent("Research the latest Fed announcement for me."),
    CEO_INTENTS.ONE_TIME_TASK
  );
  assert.equal(
    classifyIntent("Create a research agent for AI chip news."),
    CEO_INTENTS.NEW_AGENT_CREATION
  );
  assert.equal(
    classifyIntent(
      "Create an agent to review Instagram posts daily at 6pm.",
      { missionKind: "create", createsNewCapability: true }
    ),
    CEO_INTENTS.RECURRING_MISSION
  );
  assert.equal(
    classifyIntent("Make my supplier agent send reports earlier.", {
      missionKind: "modify",
      modifiesExisting: true,
    }),
    CEO_INTENTS.AGENT_MODIFICATION
  );
});

test("agent definition model is structured — not a conversation prompt", () => {
  const planned = buildPlannedAgentDefinition({
    name: "Social Intelligence Agent",
    type: "research",
    purpose: "Review social posts and summarize sentiment",
    requiredCapabilities: [
      "social_media_monitoring",
      "web_research",
    ],
  });
  assert.equal(planned.status, AGENT_DEFINITION_STATUS.PLANNED);
  assert.ok(planned.capabilities.includes("social_media_monitoring"));
  assert.ok(planned.blockers.length > 0);
  assert.equal(planned.id, null);

  const live = buildAgentDefinition({
    id: "agent-1",
    type: "research",
    name: "Chip News",
    purpose: "Summarize AI chip news",
    capabilities: ["web_research"],
    status: "active",
  });
  assert.equal(live.status, AGENT_DEFINITION_STATUS.ACTIVE);
  assert.ok(live.tools.includes("web_search"));
});

test("execution state requires object + integrations before Done", () => {
  const assessment = assessCapabilities(["web_research", "scheduling"]);
  const incomplete = buildExecutionState({
    intent: CEO_INTENTS.RECURRING_MISSION,
    capabilityAssessment: assessment,
    turnState: null,
  });
  assert.equal(incomplete.objectCreated, false);
  assert.equal(incomplete.canClaimComplete, false);

  const complete = buildExecutionState({
    intent: CEO_INTENTS.RECURRING_MISSION,
    capabilityAssessment: assessment,
    turnState: {
      agent: {
        id: "a1",
        agentType: "research",
        schedule: { preset: "weekly", weekdays: ["monday"], hourUtc: 18 },
      },
    },
  });
  assert.equal(complete.objectCreated, true);
  assert.equal(complete.agentRegistered, true);
  assert.equal(complete.scheduleCreated, true);
  assert.equal(complete.canClaimComplete, true);
});

test("resolveRequiredCapabilities maps social platforms and trading", () => {
  const social = resolveRequiredCapabilities({
    message: "Monitor Instagram and TikTok posts daily",
    platforms: ["Instagram", "TikTok"],
  });
  assert.ok(social.includes("social_media_monitoring"));
  assert.ok(social.includes("instagram_connector"));
  assert.ok(social.includes("tiktok_connector"));

  const trading = resolveRequiredCapabilities({
    message: "Create me a stock trading agent.",
  });
  assert.ok(trading.includes("stock_trading"));

  const research = resolveRequiredCapabilities({
    message: "Watch competitors using Reuters",
    missionKind: "create",
    tentativeAgentType: "research",
  });
  assert.ok(research.includes("web_research"));
  assert.ok(!research.includes("social_media_monitoring"));
});

test("Brain system prompt points at control-plane sections, not ad-hoc capability patches", () => {
  assert.match(BRAIN_SYSTEM_PROMPT, /PLATFORM CAPABILITIES/);
  assert.match(BRAIN_SYSTEM_PROMPT, /CONTROL PLANE ASSESSMENT/);
  assert.match(BRAIN_SYSTEM_PROMPT, /EXECUTION STATE/);
  assert.match(BRAIN_SYSTEM_PROMPT, /intent from execution/i);
  // Registry content is data, not hardcoded Instagram/trading exception lists in the system prompt.
  assert.doesNotMatch(BRAIN_SYSTEM_PROMPT, /WendyOcrypto/);
  assert.doesNotMatch(BRAIN_SYSTEM_PROMPT, /never say Done.*Instagram/i);
});

test("capability registry render is structured data", () => {
  const rendered = renderCapabilityRegistry();
  assert.match(rendered, /id: social_media_monitoring/);
  assert.match(rendered, /status: unavailable/);
  assert.match(rendered, /id: web_research/);
  assert.match(rendered, /status: available/);
});
