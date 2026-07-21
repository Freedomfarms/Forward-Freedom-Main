import test, { before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// Chat-engine scoping tests: a sub-agent chat may only see its own runs and
// messages; the CEO chat sees run summaries across all agents plus the living
// profile. All model calls are mocked.
//
// Requires: node --test --experimental-test-module-mocks (npm test).

let setupError = null;
let respondToChat;
let setLlmImplementationForTesting;
let createFakeDb;
let envelope;

let currentDb;
let llmCalls;

const USER_ID = "user-1";
const PROFILE_FACT = "PROFILE_FACT_TRAINING_FOR_A_MARATHON";

before(async () => {
  process.env.FFF_ENCRYPTION_KEYS = `1:${crypto.randomBytes(32).toString("base64")}`;
  process.env.FFF_ENCRYPTION_ACTIVE_VERSION = "1";
  const { resetKeyProviderCache } = await import("../server/security/keyProvider.js");
  resetKeyProviderCache();

  try {
    mock.module("../server/db/prisma.js", {
      namedExports: {
        withUserContext: async (userId, fn) => fn(currentDb.tx),
        getPrismaClient: () => null,
        isDatabaseConfigured: () => false,
        Prisma: {},
      },
    });
    ({ createFakeDb } = await import("./helpers/fakeAgentDb.js"));
    ({ respondToChat } = await import("../server/agents/chat.js"));
    ({ setLlmImplementationForTesting } = await import("../server/agents/llm.js"));
    envelope = await import("../server/security/envelope.js");
  } catch (error) {
    setupError = error;
  }
});

function requireSetup(t) {
  if (setupError) {
    t.skip(`requires --experimental-test-module-mocks (${setupError.message})`);
    return false;
  }
  return true;
}

function seedDb() {
  const profile = {
    categories: {
      lifeContext: [
        {
          id: "entry-1",
          text: PROFILE_FACT,
          source: "onboarding",
          addedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
    tombstones: [],
  };
  currentDb = createFakeDb({
    user: [{ id: USER_ID, email: "user@example.com" }],
    ceoAgentConfig: [
      {
        id: "ceo-1",
        userId: USER_ID,
        name: "CEO Agent",
        personalityPreset: "DIRECT_EFFICIENT",
        profileCiphertext: envelope.encryptJson(profile),
      },
    ],
    agentConfig: [
      {
        id: "agent-a",
        userId: USER_ID,
        ceoAgentConfigId: "ceo-1",
        agentType: "finance",
        name: "Finance Agent",
        instructions: "Watch spending.",
        definitionOfDone: "Weekly observations.",
        model: "claude-sonnet-4-5",
      },
      {
        id: "agent-b",
        userId: USER_ID,
        ceoAgentConfigId: "ceo-1",
        agentType: "research",
        name: "Research Agent",
        instructions: "Research index funds.",
        definitionOfDone: "A research report.",
        model: "claude-sonnet-4-5",
      },
    ],
    agentRun: [
      {
        id: "run-a1",
        userId: USER_ID,
        agentConfigId: "agent-a",
        agentType: "finance",
        status: "SUCCEEDED",
        summary: "AGENT_A_SUMMARY_TOKEN",
        outputCiphertext: envelope.encrypt("AGENT_A_FULL_OUTPUT"),
        startedAt: new Date("2026-07-10T00:00:00Z"),
      },
      {
        id: "run-b1",
        userId: USER_ID,
        agentConfigId: "agent-b",
        agentType: "research",
        status: "SUCCEEDED",
        summary: "AGENT_B_SUMMARY_TOKEN",
        outputCiphertext: envelope.encrypt("AGENT_B_FULL_OUTPUT"),
        startedAt: new Date("2026-07-11T00:00:00Z"),
      },
    ],
    agentConversation: [
      {
        id: "conv-a",
        userId: USER_ID,
        agentConfigId: "agent-a",
        ceoAgentConfigId: null,
        title: "Original thread",
        isSystem: false,
        archivedAt: null,
        createdAt: new Date("2026-07-12T00:00:00Z"),
        updatedAt: new Date("2026-07-12T00:00:00Z"),
      },
      {
        id: "conv-b",
        userId: USER_ID,
        agentConfigId: "agent-b",
        ceoAgentConfigId: null,
        title: "Original thread",
        isSystem: false,
        archivedAt: null,
        createdAt: new Date("2026-07-12T00:00:00Z"),
        updatedAt: new Date("2026-07-12T00:00:00Z"),
      },
      {
        id: "conv-ceo",
        userId: USER_ID,
        agentConfigId: null,
        ceoAgentConfigId: "ceo-1",
        title: "Original thread",
        isSystem: false,
        archivedAt: null,
        createdAt: new Date("2026-07-12T00:00:00Z"),
        updatedAt: new Date("2026-07-12T00:00:00Z"),
      },
    ],
    agentChatMessage: [
      {
        id: "msg-a1",
        userId: USER_ID,
        conversationId: "conv-a",
        agentConfigId: "agent-a",
        ceoAgentConfigId: null,
        role: "USER",
        contentCiphertext: envelope.encrypt("A_PRIOR_QUESTION_TOKEN"),
        createdAt: new Date("2026-07-12T00:00:00Z"),
      },
      {
        id: "msg-b1",
        userId: USER_ID,
        conversationId: "conv-b",
        agentConfigId: "agent-b",
        ceoAgentConfigId: null,
        role: "USER",
        contentCiphertext: envelope.encrypt("B_PRIOR_QUESTION_TOKEN"),
        createdAt: new Date("2026-07-12T00:00:00Z"),
      },
    ],
  });
}

function installLlmMock(reply = "Here is my answer.", profileOps = []) {
  llmCalls = [];
  setLlmImplementationForTesting({
    generateObject: async (options) => {
      llmCalls.push(options);
      return {
        object: { reply, profileOps, taskAction: null },
        usage: { inputTokens: 500, outputTokens: 100 },
      };
    },
  });
}

beforeEach(() => {
  if (setupError) return;
  seedDb();
  installLlmMock();
});

test("a sub-agent chat sees only its own runs and messages", async (t) => {
  if (!requireSetup(t)) return;
  const result = await respondToChat({
    userId: USER_ID,
    agentConfigId: "agent-a",
    message: "How is my spending trending?",
  });
  assert.equal(result.reply, "Here is my answer.");
  assert.equal(result.model, "claude-sonnet-4-5");

  assert.equal(llmCalls.length, 1);
  const payload = JSON.stringify(llmCalls[0]);
  assert.ok(payload.includes("AGENT_A_SUMMARY_TOKEN"));
  assert.ok(payload.includes("A_PRIOR_QUESTION_TOKEN"));
  // Another agent's runs and chat history must be invisible here.
  assert.ok(!payload.includes("AGENT_B_SUMMARY_TOKEN"));
  assert.ok(!payload.includes("AGENT_B_FULL_OUTPUT"));
  assert.ok(!payload.includes("B_PRIOR_QUESTION_TOKEN"));

  // Both the user message and the reply are persisted encrypted on this chat.
  const newMessages = currentDb.tables.agentChatMessage.filter(
    (message) => message.agentConfigId === "agent-a" && message.id !== "msg-a1"
  );
  assert.equal(newMessages.length, 2);
  assert.deepEqual(
    newMessages.map((message) => message.role),
    ["USER", "AGENT"]
  );
  for (const message of newMessages) {
    assert.ok(!message.contentCiphertext.includes("spending"));
  }
  assert.equal(envelope.decrypt(newMessages[1].contentCiphertext), "Here is my answer.");
});

test("a sub-agent chat cannot attach another agent's run and fails closed", async (t) => {
  if (!requireSetup(t)) return;
  await assert.rejects(
    respondToChat({
      userId: USER_ID,
      agentConfigId: "agent-a",
      message: "Why did you flag this?",
      relatedRunId: "run-b1",
    }),
    (error) => {
      assert.equal(error.name, "AgentError");
      assert.equal(error.code, "RUN_NOT_ACCESSIBLE");
      return true;
    }
  );
  assert.equal(llmCalls.length, 0);
});

test("a sub-agent chat can attach its own run and gets the decrypted output", async (t) => {
  if (!requireSetup(t)) return;
  await respondToChat({
    userId: USER_ID,
    agentConfigId: "agent-a",
    message: "Tell me more about this run.",
    relatedRunId: "run-a1",
  });
  const payload = JSON.stringify(llmCalls[0]);
  assert.ok(payload.includes("AGENT_A_FULL_OUTPUT"));
  assert.ok(!payload.includes("AGENT_B_FULL_OUTPUT"));
});

test("the CEO chat reads run summaries across all agents and the profile", async (t) => {
  if (!requireSetup(t)) return;
  const result = await respondToChat({
    userId: USER_ID,
    ceoAgentConfigId: "ceo-1",
    message: "What do you know about me, and what did my agents find?",
  });
  assert.equal(result.reply, "Here is my answer.");

  const payload = JSON.stringify(llmCalls[0]);
  // Cross-agent visibility is the CEO's job.
  assert.ok(payload.includes("AGENT_A_SUMMARY_TOKEN"));
  assert.ok(payload.includes("AGENT_B_SUMMARY_TOKEN"));
  // "What do you know about me?" is answered from the rendered profile.
  assert.ok(payload.includes(PROFILE_FACT));
  // Sub-agent chat transcripts do not leak into the CEO chat.
  assert.ok(!payload.includes("A_PRIOR_QUESTION_TOKEN"));
  assert.ok(!payload.includes("B_PRIOR_QUESTION_TOKEN"));

  // The CEO can attach any of the user's runs.
  await respondToChat({
    userId: USER_ID,
    ceoAgentConfigId: "ceo-1",
    message: "Show me that research run.",
    relatedRunId: "run-b1",
  });
  assert.ok(JSON.stringify(llmCalls[1]).includes("AGENT_B_FULL_OUTPUT"));
});

test("profile ops returned in the chat reply update the living profile without a second model call", async (t) => {
  if (!requireSetup(t)) return;
  installLlmMock("Noted!", [
    { op: "add", category: "financialGoals", text: "Wants to max out retirement contributions" },
  ]);

  await respondToChat({ userId: USER_ID, ceoAgentConfigId: "ceo-1", message: "I want to max out my retirement contributions." });
  assert.equal(llmCalls.length, 1, "profile ops must not trigger a second model call");

  const ceoRow = currentDb.tables.ceoAgentConfig[0];
  const savedProfile = envelope.decryptJson(ceoRow.profileCiphertext);
  const goals = savedProfile.categories.financialGoals;
  assert.equal(goals.length, 1);
  assert.equal(goals[0].text, "Wants to max out retirement contributions");
  assert.equal(goals[0].source, "ceo_chat");
  // The pre-existing fact survives untouched.
  assert.equal(savedProfile.categories.lifeContext[0].text, PROFILE_FACT);
});

test("chat targeting is validated: exactly one of agentConfigId / ceoAgentConfigId", async (t) => {
  if (!requireSetup(t)) return;
  await assert.rejects(
    respondToChat({ userId: USER_ID, message: "hello" }),
    /exactly one of agentConfigId or ceoAgentConfigId/i
  );
  await assert.rejects(
    respondToChat({
      userId: USER_ID,
      agentConfigId: "agent-a",
      ceoAgentConfigId: "ceo-1",
      message: "hello",
    }),
    /exactly one of agentConfigId or ceoAgentConfigId/i
  );
});
