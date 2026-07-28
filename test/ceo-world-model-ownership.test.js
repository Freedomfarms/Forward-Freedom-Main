import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_REQUEST_KINDS,
  buildExecutionEvidence,
  groundedExecutionReply,
  guardAgentReply,
} from "../server/agents/executionContract.js";
import { classifyIntent, CEO_INTENTS } from "../server/brain/controlPlane.js";
import {
  WORLD_MODEL_OWNERS,
  buildWorldModelFacts,
  enforceWorldModelOwnership,
  extractRequestedAgentTopic,
  groundedOwnershipReply,
  validateConversationConsistency,
  validateCreationFulfillment,
  validateSourceOfTruthConsistency,
} from "../server/brain/worldModelOwnership.js";
import { renderNamedRunSummaries } from "../server/agents/teamContext.js";

const FED_RUN = {
  id: "run-fed-1",
  agentConfigId: null,
  agentType: "research",
  summary: "Federal Reserve Monitor: FOMC held rates; weekly brief ready.",
  startedAt: "2026-07-20T12:00:00.000Z",
};

function emptyRegistryFacts(overrides = {}) {
  return buildWorldModelFacts({
    teamAgents: [],
    runs: [FED_RUN],
    priorAssistantReplies: ["You don't have any agents."],
    ...overrides,
  });
}

test("ownership map is explicit and registry-only for agent existence", () => {
  assert.equal(WORLD_MODEL_OWNERS.AGENT_EXISTENCE, "agent_registry");
  assert.equal(WORLD_MODEL_OWNERS.AGENT_CONFIGURATION, "agent_registry");
  assert.equal(WORLD_MODEL_OWNERS.PLAN_STATE, "plan_store");
  assert.equal(WORLD_MODEL_OWNERS.MISSION_STATE, "mission_store");
  assert.equal(WORLD_MODEL_OWNERS.HISTORICAL_EXECUTION, "run_history");
  assert.equal(WORLD_MODEL_OWNERS.USER_PREFERENCES, "memory");
});

test("create Federal Reserve intent classifies as new_agent_creation", () => {
  assert.equal(
    classifyIntent("I'd like to create a Federal Reserve agent."),
    CEO_INTENTS.NEW_AGENT_CREATION
  );
  assert.equal(extractRequestedAgentTopic("I'd like to create a Federal Reserve agent."), "Federal Reserve");
});

test("orphaned Fed run is labeled history-only in RUN HISTORY rendering", () => {
  const rendered = renderNamedRunSummaries([FED_RUN], []);
  assert.match(rendered, /orphaned_run/);
  assert.match(rendered, /not an active agent — history only/);
  assert.match(rendered, /Federal Reserve Monitor/);
});

test("0 agents + Fed run history: create request never answers with completed run on record", () => {
  const userMessage = "I'd like to create a Federal Reserve agent.";
  const intent = classifyIntent(userMessage);
  const facts = emptyRegistryFacts();
  const evidence = buildExecutionEvidence({
    turnState: {},
    recentRuns: [FED_RUN],
  });

  const guarded = guardAgentReply({
    reply: "I've created a Federal Reserve agent based on your previous Fed report.",
    userMessage,
    evidence,
    requestKind: AGENT_REQUEST_KINDS.ACTION_REQUEST,
    intent,
    worldModelFacts: facts,
  });

  assert.equal(guarded.rewritten, true);
  assert.doesNotMatch(guarded.reply, /completed run on record/i);
  assert.match(guarded.reply, /don't currently have a Federal Reserve agent/i);
  assert.match(guarded.reply, /previously ran a similar report/i);
  assert.match(guarded.reply, /create a new recurring agent/i);
});

test("groundedExecutionReply scopes historical runs out of create intents", () => {
  const evidence = buildExecutionEvidence({
    turnState: {},
    recentRuns: [FED_RUN],
  });
  const reply = groundedExecutionReply(evidence, {
    requestKind: AGENT_REQUEST_KINDS.ACTION_REQUEST,
    failures: ["unsupported_claim:created"],
    intent: CEO_INTENTS.NEW_AGENT_CREATION,
    userMessage: "Create me a Federal Reserve agent",
    worldModelFacts: emptyRegistryFacts(),
    draftReply: "I've created a Federal Reserve agent.",
  });
  assert.doesNotMatch(reply, /completed run on record/i);
  assert.match(reply, /Federal Reserve agent/i);
  assert.match(reply, /create/i);
});

test("status questions may still cite run history", () => {
  const evidence = buildExecutionEvidence({
    turnState: {},
    relatedRun: { id: "run-fed-1", status: "SUCCEEDED", summary: FED_RUN.summary },
    recentRuns: [FED_RUN],
  });
  const reply = groundedExecutionReply(evidence, {
    requestKind: AGENT_REQUEST_KINDS.STATUS_QUESTION,
    failures: ["unsupported_claim:emailed"],
    intent: CEO_INTENTS.INFORMATION_REQUEST,
    userMessage: "Did you email the last run?",
  });
  assert.match(reply, /completed run on record|do not have evidence that an email was sent/i);
});

test("source-of-truth validation blocks run evidence → agent claim", () => {
  const facts = emptyRegistryFacts();
  const check = validateSourceOfTruthConsistency(
    "You already have a Federal Reserve agent from a completed run.",
    facts,
    {
      intent: CEO_INTENTS.NEW_AGENT_CREATION,
      userMessage: "I'd like to create a Federal Reserve agent.",
    }
  );
  assert.equal(check.ok, false);
  assert.ok(check.failures.includes("run_evidence_used_for_agent_claim") || check.failures.includes("agent_existence_without_registry"));
});

test("source-of-truth validation blocks plan → execution claim without this-turn run", () => {
  const facts = emptyRegistryFacts({
    activeMission: {
      authority: "plan",
      planId: "plan-1",
      mission: "Monitor Federal Reserve announcements weekly",
    },
  });
  const check = validateSourceOfTruthConsistency(
    "Your plan already ran and execution is complete for the Federal Reserve mission.",
    facts,
    { intent: CEO_INTENTS.INFORMATION_REQUEST, userMessage: "Is the plan done?" }
  );
  assert.equal(check.ok, false);
  assert.ok(check.failures.includes("plan_used_for_execution_claim"));
});

test("conversation consistency: prior no-agents + run-as-agent requires clarification", () => {
  const facts = emptyRegistryFacts();
  const check = validateConversationConsistency(
    "I have a completed Federal Reserve agent run on record.",
    facts
  );
  assert.equal(check.ok, false);
  assert.ok(check.failures.includes("conversation_consistency_run_vs_registry"));

  const enforced = enforceWorldModelOwnership({
    reply: "You already have a Federal Reserve agent — I have a completed Federal Reserve agent run.",
    facts,
    intent: CEO_INTENTS.INFORMATION_REQUEST,
    requestKind: AGENT_REQUEST_KINDS.CLARIFICATION_NEEDED,
    userMessage: "You just told me there were no agents",
    turnState: {},
  });
  assert.equal(enforced.rewritten, true);
  assert.match(enforced.reply, /historical run evidence|history only/i);
  assert.match(enforced.reply, /not an active agent|no agents on your registry|don't currently have/i);
  assert.match(enforced.reply, /Federal Reserve/i);
  assert.doesNotMatch(enforced.reply, /^I have a completed run on record/i);
});

test("creation fulfillment: must be created, missing info, or blocked — never run history", () => {
  const userMessage = "Create me a Federal Reserve agent";
  const facts = emptyRegistryFacts();

  const runHistory = validateCreationFulfillment("I have a completed run on record.", {
    intent: CEO_INTENTS.NEW_AGENT_CREATION,
    userMessage,
    facts,
    turnState: {},
  });
  assert.equal(runHistory.ok, false);
  assert.equal(runHistory.path, "run_history");

  const created = validateCreationFulfillment("Created your Federal Reserve agent.", {
    intent: CEO_INTENTS.NEW_AGENT_CREATION,
    userMessage,
    facts,
    turnState: { agent: { id: "agent-1", name: "Federal Reserve Agent", agentType: "research" } },
  });
  assert.equal(created.ok, true);
  assert.equal(created.path, "created");

  const missing = validateCreationFulfillment(
    "I don't currently have a Federal Reserve agent. Would you like me to create one now?",
    {
      intent: CEO_INTENTS.NEW_AGENT_CREATION,
      userMessage,
      facts,
      turnState: {},
    }
  );
  assert.equal(missing.ok, true);
  assert.equal(missing.path, "missing_info");

  const blocked = validateCreationFulfillment(
    "I can design this agent, but required capabilities are not currently connected.",
    {
      intent: CEO_INTENTS.NEW_AGENT_CREATION,
      userMessage,
      facts,
      turnState: {},
      capabilityAssessment: { allAvailable: false },
    }
  );
  assert.equal(blocked.ok, true);
  assert.equal(blocked.path, "blocked");
});

test("end-to-end ownership: 0 agents + Fed orphan run → create path offers recreate, not existence", () => {
  const userMessage = "I'd like to create a Federal Reserve agent.";
  const facts = emptyRegistryFacts();
  const grounded = groundedOwnershipReply({
    facts,
    userMessage,
    failures: ["creation_answered_with_run_history"],
  });
  assert.match(grounded, /don't currently have a Federal Reserve agent/i);
  assert.match(grounded, /previously ran a similar report/i);
  assert.match(grounded, /create a new recurring agent based on that/i);

  // When create_agent actually ran, ownership allows the success claim path.
  const afterCreate = enforceWorldModelOwnership({
    reply: "Created your Federal Reserve agent and registered it on your team.",
    facts: buildWorldModelFacts({
      teamAgents: [],
      runs: [FED_RUN],
      turnState: { agent: { id: "a1", name: "Federal Reserve Agent", agentType: "research" } },
      priorAssistantReplies: ["You don't have any agents."],
    }),
    intent: CEO_INTENTS.NEW_AGENT_CREATION,
    userMessage,
    turnState: { agent: { id: "a1", name: "Federal Reserve Agent", agentType: "research" } },
  });
  assert.equal(afterCreate.ok, true);
  assert.equal(afterCreate.rewritten, false);
  assert.equal(afterCreate.creationPath, "created");
});
