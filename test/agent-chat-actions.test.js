import test, { before, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// Unit tests for sub-agent task-scoped chat actions: intent matching,
// sanitization, and applying update_config / run_now without an LLM.
//
// Requires: node --test --experimental-test-module-mocks (npm test).

let setupError = null;
let chatActions;
let createFakeDb;
let currentDb;
let runAgentCalls;

const USER_ID = "user-1";

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
    mock.module("../server/agents/runner.js", {
      namedExports: {
        runAgent: async (args) => {
          runAgentCalls.push(args);
          return {
            id: "run-1",
            agentConfigId: args.agentConfigId,
            agentType: "research",
            status: "SUCCEEDED",
            summary: "Fresh findings.",
            error: null,
            startedAt: new Date(),
            completedAt: new Date(),
          };
        },
      },
    });
    ({ createFakeDb } = await import("./helpers/fakeAgentDb.js"));
    chatActions = await import("../server/agents/chatActions.js");
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

function seedAgent(overrides = {}) {
  currentDb = createFakeDb({
    user: [{ id: USER_ID, email: "user@example.com" }],
    ceoAgentConfig: [{ id: "ceo-1", userId: USER_ID, name: "CEO Agent" }],
    agentConfig: [
      {
        id: "agent-1",
        userId: USER_ID,
        ceoAgentConfigId: "ceo-1",
        agentType: "research",
        name: "Research Agent",
        instructions: "Research personal finance.",
        definitionOfDone: "A research report.",
        status: "ACTIVE",
        schedule: "0 13 * * 1",
        toolAccess: null,
        model: "claude-sonnet-4-5",
        ...overrides,
      },
    ],
    agentConversation: [
      {
        id: "conv-1",
        userId: USER_ID,
        agentConfigId: "agent-1",
        ceoAgentConfigId: null,
        title: "Thread",
        isSystem: false,
        archivedAt: null,
        updatedAt: new Date(),
      },
    ],
    agentChatMessage: [],
    agentRun: [],
  });
  runAgentCalls = [];
}

test("matchDeterministicTaskIntent covers run/pause/schedule/email-toggle", (t) => {
  if (!requireSetup(t)) return;
  const { matchDeterministicTaskIntent } = chatActions;

  assert.equal(matchDeterministicTaskIntent("run now")?.type, "run_now");
  assert.equal(matchDeterministicTaskIntent("can you run yourself now?")?.type, "run_now");
  assert.deepEqual(matchDeterministicTaskIntent("please pause"), {
    type: "update_config",
    data: { status: "PAUSED" },
    payload: { status: "PAUSED" },
  });
  assert.equal(matchDeterministicTaskIntent("resume")?.data?.status, "ACTIVE");
  assert.equal(matchDeterministicTaskIntent("change schedule to daily")?.data?.schedule, "0 13 * * *");
  assert.equal(
    matchDeterministicTaskIntent("make it weekly on thursday")?.data?.schedule,
    "0 13 * * 4"
  );
  assert.equal(matchDeterministicTaskIntent("clear schedule")?.data?.schedule, null);
  assert.deepEqual(matchDeterministicTaskIntent("enable email after each run")?.data?.toolAccess, {
    email: true,
  });
  assert.equal(matchDeterministicTaskIntent("disable email")?.data?.toolAccess, null);

  // One-off "email me the report" is not a settings intent.
  assert.equal(matchDeterministicTaskIntent("email me the report"), null);
  assert.equal(matchDeterministicTaskIntent("what's my latest summary?"), null);
});

test("sanitizeTaskAction rejects unknown types and empty updates", (t) => {
  if (!requireSetup(t)) return;
  const { sanitizeTaskAction } = chatActions;

  assert.equal(sanitizeTaskAction(null), null);
  assert.throws(() => sanitizeTaskAction({ type: "wire_money" }), /taskAction\.type/);
  assert.throws(() => sanitizeTaskAction({ type: "update_config" }), /no updatable fields/);
  const ok = sanitizeTaskAction({
    type: "update_config",
    instructions: "Research fintech platforms",
  });
  assert.equal(ok.type, "update_config");
  assert.match(ok.data.instructions, /fintech/);
});

test("applySubAgentTaskAction updates this agent's schedule via chat", async (t) => {
  if (!requireSetup(t)) return;
  seedAgent();
  const action = chatActions.sanitizeTaskAction({
    type: "update_config",
    schedulePreset: "weekly",
    scheduleWeekday: "thursday",
  });
  const outcome = await chatActions.applySubAgentTaskAction({
    userId: USER_ID,
    agentConfigId: "agent-1",
    conversationId: "conv-1",
    message: "change schedule to weekly on thursday",
    action,
    persist: true,
  });
  assert.match(outcome.reply, /weekly \(thursday\)/i);
  assert.equal(currentDb.tables.agentConfig[0].schedule, "0 13 * * 4");
  assert.equal(outcome.agent.schedule.preset, "weekly");
  assert.equal(outcome.agent.schedule.weekday, "thursday");
  assert.equal(currentDb.tables.agentChatMessage.length, 2);
});

test("applySubAgentTaskAction run_now triggers the runner for this agent only", async (t) => {
  if (!requireSetup(t)) return;
  seedAgent();
  const outcome = await chatActions.applySubAgentTaskAction({
    userId: USER_ID,
    agentConfigId: "agent-1",
    conversationId: "conv-1",
    message: "run now",
    action: { type: "run_now" },
    persist: true,
  });
  assert.equal(runAgentCalls.length, 1);
  assert.equal(runAgentCalls[0].agentConfigId, "agent-1");
  assert.match(outcome.reply, /just ran/i);
  assert.equal(outcome.run.id, "run-1");
});

test("isEmailReportRequest still covers send-email phrasings", async (t) => {
  if (!requireSetup(t)) return;
  // Imported after mocks so it shares the same test env.
  const emailDelivery = await import("../server/agents/emailDelivery.js");
  assert.equal(emailDelivery.isEmailReportRequest("can you send email now so i can see draft?"), true);
  assert.equal(emailDelivery.isEmailReportRequest("email me the report"), true);
  assert.equal(emailDelivery.isEmailReportRequest("enable email after each run"), false);
  assert.equal(emailDelivery.isEmailReportRequest("disable email"), false);
});
