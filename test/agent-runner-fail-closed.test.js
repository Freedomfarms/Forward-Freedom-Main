import test, { before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// Unit tests for the agent runner's fail-closed gate and success accounting.
// Database access is replaced with an in-memory fake (via module mocks) and
// every model call is intercepted — the real Anthropic API is never reached.
//
// Requires: node --test --experimental-test-module-mocks (npm test).

let setupError = null;
let runAgent;
let setLlmImplementationForTesting;
let createFakeDb;
let envelope;

let currentDb;
let llmCalls;

const USER_ID = "user-1";

function seedDb({ agentConfig } = {}) {
  currentDb = createFakeDb({
    user: [{ id: USER_ID, email: "user@example.com" }],
    ceoAgentConfig: [
      { id: "ceo-1", userId: USER_ID, personalityPreset: "DIRECT_EFFICIENT", profileCiphertext: null },
    ],
    agentConfig: agentConfig ? [agentConfig] : [],
  });
  return currentDb;
}

function agentConfigRow(overrides = {}) {
  return {
    id: "agent-1",
    userId: USER_ID,
    ceoAgentConfigId: "ceo-1",
    agentType: "finance",
    name: "Finance Agent",
    instructions: "Watch my spending trends.",
    definitionOfDone: "A weekly spending observations report.",
    permissionLevel: "READ_ONLY",
    model: "claude-sonnet-4-5",
    toolAccess: null,
    status: "ACTIVE",
    ...overrides,
  };
}

function installLlmMock({ failExtraction = false } = {}) {
  llmCalls = [];
  setLlmImplementationForTesting({
    generateText: async (options) => {
      llmCalls.push({ kind: "text", options });
      return { text: "mock text", usage: { inputTokens: 100, outputTokens: 50 } };
    },
    generateObject: async (options) => {
      llmCalls.push({ kind: "object", options });
      if (options.model === "claude-haiku-4-5") {
        if (failExtraction) throw new Error("extraction blew up");
        return { object: { ops: [] }, usage: { inputTokens: 10, outputTokens: 5 } };
      }
      return {
        object: { report: "Mock insights report.", summary: "Mock 1-2 sentence summary." },
        usage: { inputTokens: 1000, outputTokens: 200 },
      };
    },
  });
}

before(async () => {
  process.env.FFF_ENCRYPTION_KEYS = `1:${crypto.randomBytes(32).toString("base64")}`;
  process.env.FFF_ENCRYPTION_ACTIVE_VERSION = "1";
  process.env.ANTHROPIC_API_KEY = "test-key-never-used";
  const { resetKeyProviderCache } = await import("../server/security/keyProvider.js");
  resetKeyProviderCache();

  try {
    mock.module("../server/db/prisma.js", {
      namedExports: {
        withUserContext: async (userId, fn) => {
          if (typeof userId !== "string" || !userId.trim()) {
            throw new Error("withUserContext requires a non-empty userId.");
          }
          return fn(currentDb.tx);
        },
      },
    });
    ({ createFakeDb } = await import("./helpers/fakeAgentDb.js"));
    ({ runAgent } = await import("../server/agents/runner.js"));
    ({ setLlmImplementationForTesting } = await import("../server/agents/llm.js"));
    envelope = await import("../server/security/envelope.js");
  } catch (error) {
    setupError = error;
  }
});

beforeEach(() => {
  if (setupError) return;
  installLlmMock();
});

function requireSetup(t) {
  if (setupError) {
    t.skip(`requires --experimental-test-module-mocks (${setupError.message})`);
    return false;
  }
  return true;
}

test("unknown agentType is recorded as SKIPPED and nothing else happens", async (t) => {
  if (!requireSetup(t)) return;
  seedDb({ agentConfig: agentConfigRow({ agentType: "crypto-trader" }) });

  const run = await runAgent({ userId: USER_ID, agentConfigId: "agent-1", trigger: "manual" });
  assert.equal(run.status, "SKIPPED");
  assert.match(run.error, /UNKNOWN_AGENT_TYPE/);
  assert.match(run.error, /crypto-trader/);
  assert.equal(run.agentType, "crypto-trader");
  assert.ok(run.completedAt);
  assert.equal(currentDb.tables.agentRun.length, 1);
  assert.equal(llmCalls.length, 0);
  assert.equal(currentDb.tables.notification.length, 0);
});

test("email agentType is registered but skipped with a typed not-yet-available error", async (t) => {
  if (!requireSetup(t)) return;
  seedDb({ agentConfig: agentConfigRow({ agentType: "email" }) });

  const run = await runAgent({ userId: USER_ID, agentConfigId: "agent-1" });
  assert.equal(run.status, "SKIPPED");
  assert.match(run.error, /AGENT_TYPE_NOT_AVAILABLE/);
  assert.match(run.error, /not yet available/);
  assert.equal(llmCalls.length, 0);
});

test("PAUSED agents are skipped without running anything", async (t) => {
  if (!requireSetup(t)) return;
  seedDb({ agentConfig: agentConfigRow({ status: "PAUSED" }) });

  const run = await runAgent({ userId: USER_ID, agentConfigId: "agent-1" });
  assert.equal(run.status, "SKIPPED");
  assert.match(run.error, /AGENT_PAUSED/);
  assert.equal(llmCalls.length, 0);
});

test("permission levels beyond READ_ONLY/DRAFT_ONLY are rejected", async (t) => {
  if (!requireSetup(t)) return;
  for (const permissionLevel of ["ACTION_REQUIRED_APPROVAL", "AUTONOMOUS", "SOMETHING_ELSE"]) {
    seedDb({ agentConfig: agentConfigRow({ permissionLevel }) });
    const run = await runAgent({ userId: USER_ID, agentConfigId: "agent-1" });
    assert.equal(run.status, "SKIPPED", permissionLevel);
    assert.match(run.error, /PERMISSION_LEVEL_NOT_ALLOWED/);
    assert.match(run.error, new RegExp(permissionLevel));
    assert.equal(llmCalls.length, 0);
  }
});

test("missing agent config raises a typed error and writes no run row", async (t) => {
  if (!requireSetup(t)) return;
  seedDb({});
  await assert.rejects(runAgent({ userId: USER_ID, agentConfigId: "does-not-exist" }), (error) => {
    assert.equal(error.name, "AgentError");
    assert.equal(error.code, "AGENT_NOT_FOUND");
    return true;
  });
  assert.equal(currentDb.tables.agentRun.length, 0);
});

test("a successful run persists encrypted output, usage and combined cost", async (t) => {
  if (!requireSetup(t)) return;
  seedDb({ agentConfig: agentConfigRow() });

  const run = await runAgent({ userId: USER_ID, agentConfigId: "agent-1" });
  assert.equal(run.status, "SUCCEEDED");
  assert.equal(run.summary, "Mock 1-2 sentence summary.");
  assert.equal(run.agentType, "finance");
  assert.equal(run.model, "claude-sonnet-4-5");
  assert.ok(run.completedAt);

  // Output is stored encrypted, never in plaintext.
  assert.ok(run.outputCiphertext);
  assert.ok(!run.outputCiphertext.includes("Mock insights report."));
  assert.equal(envelope.decrypt(run.outputCiphertext), "Mock insights report.");

  // Profile-extraction tokens/cost are charged to the same run row:
  // 1000+10 input, 200+5 output; sonnet(1000/200)=0.006, haiku(10/5)=0.000035.
  assert.equal(run.tokensInput, 1010);
  assert.equal(run.tokensOutput, 205);
  assert.equal(Number(run.estimatedCostUsd), 0.006035);

  assert.ok(run.dataAccessed?.description);
  // Two model calls total: the finance report + the cheap-tier extraction.
  assert.deepEqual(
    llmCalls.map((call) => call.options.model),
    ["claude-sonnet-4-5", "claude-haiku-4-5"]
  );
});

test("profile-extraction failure never fails a successful run", async (t) => {
  if (!requireSetup(t)) return;
  installLlmMock({ failExtraction: true });
  seedDb({ agentConfig: agentConfigRow() });

  const run = await runAgent({ userId: USER_ID, agentConfigId: "agent-1" });
  assert.equal(run.status, "SUCCEEDED");
  assert.equal(run.tokensInput, 1000);
  assert.equal(run.tokensOutput, 200);
  assert.equal(Number(run.estimatedCostUsd), 0.006);
});

test("handler errors are recorded as FAILED with the explanatory error", async (t) => {
  if (!requireSetup(t)) return;
  setLlmImplementationForTesting({
    generateObject: async () => {
      throw new Error("model exploded");
    },
    generateText: async () => {
      throw new Error("model exploded");
    },
  });
  seedDb({ agentConfig: agentConfigRow() });

  const run = await runAgent({ userId: USER_ID, agentConfigId: "agent-1" });
  assert.equal(run.status, "FAILED");
  assert.match(run.error, /model exploded/);
  assert.ok(run.completedAt);
});

test("reminders run succeeds without any LLM call and degrades cleanly without keys", async (t) => {
  if (!requireSetup(t)) return;
  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const previousResendKey = process.env.RESEND_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.RESEND_API_KEY;
  t.after(() => {
    process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
    if (previousResendKey == null) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousResendKey;
  });

  seedDb({
    agentConfig: agentConfigRow({
      agentType: "reminders",
      name: "Bill Reminder",
      instructions: "Pay the water bill.",
      toolAccess: { email: true },
    }),
  });

  const run = await runAgent({ userId: USER_ID, agentConfigId: "agent-1" });
  assert.equal(run.status, "SUCCEEDED");
  assert.equal(run.model, null);
  assert.equal(run.tokensInput, null);
  assert.match(run.summary, /delivered in-app/);
  // Email was configured but the key is missing → skipped with explanation.
  assert.match(run.summary, /email skipped/);
  assert.equal(llmCalls.length, 0);

  // Exactly one IN_APP self-notification, no EMAIL row.
  const notifications = currentDb.tables.notification;
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].channel, "IN_APP");
  assert.equal(notifications[0].userId, USER_ID);
});
