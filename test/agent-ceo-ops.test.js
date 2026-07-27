import test, { before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// CEO ops: create / schedule (local) / run with lineage / pause / delete confirm.
// Requires: node --test --experimental-test-module-mocks (npm test).

let setupError = null;
let applyCeoActions;
let sanitizeCeoActions;
let localScheduleToUtcCron;
let createFakeDb;
let envelope;
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
          const run = await currentDb.tx.agentRun.create({
            data: {
              userId: args.userId,
              agentConfigId: args.agentConfigId,
              agentType: "research",
              status: "SUCCEEDED",
              summary: "Fed summary for test.",
              outputCiphertext: envelope.encrypt("Full Fed report body."),
              trigger: args.trigger || "manual",
              triggeredByConversationId: args.triggeredByConversationId || null,
              parentRunId: args.parentRunId || null,
              completedAt: new Date(),
            },
          });
          if (typeof args.onStarted === "function") args.onStarted(run);
          return run;
        },
      },
    });
    ({ createFakeDb } = await import("./helpers/fakeAgentDb.js"));
    envelope = await import("../server/security/envelope.js");
    ({ applyCeoActions, sanitizeCeoActions } = await import("../server/agents/ceoOps.js"));
    ({ localScheduleToUtcCron } = await import("../server/agents/timezone.js"));
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
  currentDb = createFakeDb({
    user: [{ id: USER_ID, email: "user@example.com", timezone: "America/New_York" }],
    ceoAgentConfig: [
      {
        id: "ceo-1",
        userId: USER_ID,
        name: "CEO Agent",
        personalityPreset: "DIRECT_EFFICIENT",
        defaultSubAgentModel: "claude-sonnet-4-5",
      },
    ],
    agentConversation: [
      {
        id: "ceo-convo-1",
        userId: USER_ID,
        ceoAgentConfigId: "ceo-1",
        agentConfigId: null,
        title: "Main",
        isSystem: false,
      },
    ],
  });
  runAgentCalls = [];
}

beforeEach(() => {
  if (setupError) return;
  seedDb();
});

test("sanitizeCeoActions rejects unknown types", (t) => {
  if (!requireSetup(t)) return;
  assert.throws(() => sanitizeCeoActions([{ type: "wire_money" }]), /ceoActions\[0\]\.type/);
});

test("golden path: create scheduled research agent, run with lineage, pause", async (t) => {
  if (!requireSetup(t)) return;

  const created = await applyCeoActions({
    userId: USER_ID,
    ceoAgentConfigId: "ceo-1",
    conversationId: "ceo-convo-1",
    syncBudgetMs: 30_000,
    actions: [
      {
        type: "create_agent",
        agentType: "research",
        name: "Federal Reserve Report",
        instructions: "Research Federal Reserve announcements and summarize.",
        definitionOfDone: "A concise Fed summary with sources.",
        schedulePreset: "weekly",
        scheduleWeekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
        scheduleHourLocal: 7,
        emailDelivery: true,
      },
      { type: "run_agent" },
    ],
  });

  assert.match(created.reply, /Created "Federal Reserve Report"/i);
  assert.match(created.reply, /finished|Working on it|started/i);
  assert.ok(created.agent?.id);
  assert.equal(created.agent.agentType, "research");
  assert.equal(created.agent.toolAccess?.email, true);
  assert.equal(created.agent.schedule?.preset, "weekly");
  const expected = localScheduleToUtcCron({
    preset: "weekly",
    weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
    hourLocal: 7,
    timeZone: "America/New_York",
  });
  assert.equal(created.agent.schedule?.hourUtc, expected.hourUtc);
  assert.ok(created.run?.id);
  assert.equal(created.run.trigger, "ceo_delegate");
  assert.equal(created.run.triggeredByConversationId, "ceo-convo-1");
  assert.equal(runAgentCalls.length, 1);
  assert.equal(runAgentCalls[0].trigger, "ceo_delegate");
  assert.equal(runAgentCalls[0].triggeredByConversationId, "ceo-convo-1");

  const paused = await applyCeoActions({
    userId: USER_ID,
    ceoAgentConfigId: "ceo-1",
    conversationId: "ceo-convo-1",
    actions: [{ type: "update_agent", agentId: created.agent.id, status: "PAUSED" }],
  });
  assert.match(paused.reply, /Paused/i);
  assert.equal(paused.agent.status, "PAUSED");
});

test("delete_agent requires confirmation before executing", async (t) => {
  if (!requireSetup(t)) return;

  currentDb.tables.agentConfig.push({
    id: "agent-x",
    userId: USER_ID,
    ceoAgentConfigId: "ceo-1",
    agentType: "research",
    name: "Temp Agent",
    instructions: "x",
    definitionOfDone: "y",
    status: "ACTIVE",
    model: "claude-sonnet-4-5",
    permissionLevel: "READ_ONLY",
    toolAccess: null,
    schedule: null,
  });

  const propose = await applyCeoActions({
    userId: USER_ID,
    ceoAgentConfigId: "ceo-1",
    conversationId: "ceo-convo-1",
    actions: [{ type: "delete_agent", agentId: "agent-x", confirmed: false }],
  });
  assert.match(propose.reply, /Confirm/i);
  assert.equal(currentDb.tables.agentConfig.some((row) => row.id === "agent-x"), true);

  const done = await applyCeoActions({
    userId: USER_ID,
    ceoAgentConfigId: "ceo-1",
    conversationId: "ceo-convo-1",
    actions: [{ type: "delete_agent", agentId: "agent-x", confirmed: true }],
  });
  assert.match(done.reply, /Deleted/i);
  assert.equal(currentDb.tables.agentConfig.some((row) => row.id === "agent-x"), false);
});

test("local schedule without timezone asks instead of assuming UTC", async (t) => {
  if (!requireSetup(t)) return;
  currentDb.tables.user[0].timezone = null;

  await assert.rejects(
    applyCeoActions({
      userId: USER_ID,
      ceoAgentConfigId: "ceo-1",
      conversationId: "ceo-convo-1",
      actions: [
        {
          type: "create_agent",
          agentType: "research",
          name: "Needs TZ",
          instructions: "Topic",
          definitionOfDone: "Done",
          schedulePreset: "daily",
          scheduleHourLocal: 7,
        },
      ],
    }),
    /timezone/i
  );
});

test("create_agent refuses live registration when social connectors are unavailable", async (t) => {
  if (!requireSetup(t)) return;

  const before = currentDb.tables.agentConfig.length;
  const result = await applyCeoActions({
    userId: USER_ID,
    ceoAgentConfigId: "ceo-1",
    conversationId: "ceo-convo-1",
    actions: [
      {
        type: "create_agent",
        agentType: "research",
        name: "Social Media Review",
        instructions:
          "Review Instagram, TikTok, and X posts from WendyOcrypto and Raoul Pal.",
        definitionOfDone: "Weekday social media review report.",
        schedulePreset: "weekly",
        scheduleWeekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
        scheduleHourLocal: 18,
      },
    ],
  });

  assert.equal(result.created, false);
  assert.equal(result.agent, null);
  assert.equal(result.plannedAgent?.status, "planned");
  assert.match(result.reply, /not currently connected/i);
  assert.match(result.reply, /No live agent was registered/i);
  assert.ok(result.capabilityAssessment?.unavailable?.some((c) => c.id === "social_media_monitoring"));
  assert.equal(currentDb.tables.agentConfig.length, before);
});
