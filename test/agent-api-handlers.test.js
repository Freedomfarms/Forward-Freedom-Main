import test, { before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

import { createRequest, createResponse } from "./helpers/httpMocks.js";

// Handler tests for the Phase 5 agent-platform API. The Phase 4 agent core
// (runner, chat, digest) and the database/auth/rate-limit layers are replaced
// with module mocks, so these tests exercise exactly the handler logic:
// auth required, validation, owner scoping, and delegation to the core.
//
// Requires: node --test --experimental-test-module-mocks (npm test).

let setupError = null;
let handlers = {};
let createFakeDb;
let envelope;

let currentDb;
let currentServiceClient;
let runnerCalls;
let runnerResult;
let chatCalls;
let digestCalls;
let narrativeProfileCalls;

class FakeAuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

function fakeReadBearerToken(request) {
  const header = request?.headers?.authorization || "";
  const match = /^Bearer\s+(.+)$/.exec(String(header).trim());
  return match?.[1] || null;
}

before(async () => {
  process.env.FFF_ENCRYPTION_KEYS = `1:${crypto.randomBytes(32).toString("base64")}`;
  process.env.FFF_ENCRYPTION_ACTIVE_VERSION = "1";
  process.env.ANTHROPIC_API_KEY = "test-key-never-used";

  try {
    const { resetKeyProviderCache } = await import("../server/security/keyProvider.js");
    resetKeyProviderCache();

    mock.module("../server/auth/verifyAuth.js", {
      namedExports: {
        AuthError: FakeAuthError,
        readBearerToken: fakeReadBearerToken,
        authenticateRequest: async (request) => {
          const uid = fakeReadBearerToken(request);
          if (!uid) throw new FakeAuthError("Missing bearer token.", 401);
          return { uid, email: `${uid}@example.com`, email_verified: true };
        },
        authenticateVerifiedRequest: async (request) => {
          const uid = fakeReadBearerToken(request);
          if (!uid) throw new FakeAuthError("Missing bearer token.", 401);
          return { uid, email: `${uid}@example.com`, email_verified: true };
        },
      },
    });

    mock.module("../server/db/prisma.js", {
      namedExports: {
        withUserContext: async (userId, fn) => {
          if (typeof userId !== "string" || !userId.trim()) {
            throw new Error("withUserContext requires a non-empty userId.");
          }
          return fn(currentDb.tx);
        },
        getPrismaClient: () => ({}),
        isDatabaseConfigured: () => true,
        Prisma: { DbNull: Symbol("DbNull") },
      },
    });

    mock.module("../server/http/rateLimit.js", {
      namedExports: {
        enforceRateLimit: async () => true,
        generalApiRateLimit: {},
        workspaceWriteRateLimit: {},
        agentLlmRateLimit: {},
        agentRunRateLimit: {},
        plaidLinkRateLimit: {},
        plaidExchangeRateLimit: {},
        plaidSyncRateLimit: {},
        plaidWebhookRateLimit: {},
        expressServerBackstopRateLimit: {},
      },
    });

    mock.module("../server/db/servicePrisma.js", {
      namedExports: {
        getServicePrismaClient: () => currentServiceClient,
        isServiceDatabaseConfigured: () => true,
      },
    });

    mock.module("../server/agents/runner.js", {
      namedExports: {
        runAgent: async (args) => {
          runnerCalls.push(args);
          return runnerResult;
        },
      },
    });

    mock.module("../server/agents/chat.js", {
      namedExports: {
        respondToChat: async (args) => {
          chatCalls.push(args);
          return { reply: "mock chat reply", messageId: "msg-123", model: "m", usage: null };
        },
      },
    });

    mock.module("../server/agents/digest.js", {
      namedExports: {
        DIGEST_ACTION_TYPES: Object.freeze(["set_content", "regenerate"]),
        DIGEST_MAX_LENGTH: 4000,
        DIGEST_ACTION_JSON_SCHEMA: {
          anyOf: [{ type: "null" }, { type: "object" }],
        },
        generateDigest: async (userId) => {
          digestCalls.push(userId);
          return {
            digest: "freshly generated digest",
            generatedAt: new Date("2026-07-20T12:00:00Z"),
            model: null,
            usage: null,
          };
        },
        sanitizeDigestAction: (action) => action ?? null,
        applyCeoDigestAction: async () => ({
          digest: "updated digest",
          generatedAt: new Date("2026-07-20T12:00:00Z"),
        }),
        NO_ACTIVITY_DIGEST: "nothing yet",
      },
    });

    mock.module("../server/agents/narrativeProfile.js", {
      namedExports: {
        generateNarrativeProfile: async (userId) => {
          narrativeProfileCalls.push(userId);
          return {
            profile: "Generated long-form newsletter profile about the user.",
            generatedAt: new Date("2026-07-21T12:00:00Z"),
            insufficient: false,
            persisted: true,
            model: "mock-model",
            usage: null,
            wordCount: 8,
          };
        },
        readNarrativeProfile: async (userId) => {
          const row = currentDb.tables.ceoAgentConfig.find((item) => item.userId === userId);
          if (!row?.narrativeProfileCiphertext) {
            return { profile: null, generatedAt: null, insufficient: false };
          }
          return {
            profile: envelope.decrypt(row.narrativeProfileCiphertext),
            generatedAt: row.narrativeProfileAt ?? null,
            insufficient: false,
          };
        },
        saveNarrativeProfile: async () => ({
          profile: "",
          generatedAt: new Date(),
          insufficient: false,
          persisted: true,
        }),
        hasAnyNarrativeSourceMaterial: () => false,
        isMissingNarrativeProfileColumnError: () => false,
        INSUFFICIENT_PROFILE_MESSAGE:
          "I don't have enough information yet to build your profile — chat with me a bit more or create an agent, and I'll be able to write one.",
      },
    });

    // Stub LLM for onboarding summaries + conversational agent creation intake.
    mock.module("../server/agents/llm.js", {
      namedExports: {
        PROFILE_EXTRACTION_MODEL: "mock-model",
        CEO_AGENT_MODEL: "mock-model",
        setLlmImplementationForTesting: () => {},
        // Keep false so onboarding stays on the template summary path; creation
        // still uses the generateAgent* stubs below directly.
        isLlmConfigured: () => false,
        getWebSearchTools: () => ({}),
        // Intake turns: text + trailing NOTES_JSON. Skip/review uses Sonnet text
        // + generateAgentObject extract.
        generateAgentText: async ({ prompt } = {}) => {
          // Skip/review turns ask the model to present the draft; interview turns
          // explicitly say not to. Match the instruction line, not the word "skip"
          // buried in JSON keys like userAskedToSkipRemaining.
          const askingToDraft =
            typeof prompt === "string" &&
            /Present the draft review now/i.test(prompt);
          if (askingToDraft) {
            return {
              text: "Here's a draft from what we have. Look good to create?",
              usage: null,
            };
          }
          return {
            text:
              "Got it — what spending accounts or categories should it watch?\n" +
              'NOTES_JSON:{"mission":"A weekly spending observations report is produced","knownFacts":["Weekly spending observations"],"blockingGaps":["accounts or categories to watch"],"nextQuestionFocus":"accounts or categories to watch","missionExecutable":false,"tentativeAgentType":"finance","agentTypeConfidence":0.85,"draftPatch":{"definitionOfDone":"A weekly spending observations report is produced","tentativeAgentType":"finance","agentTypeConfidence":0.85},"userCancelled":false}',
            usage: null,
          };
        },
        generateAgentObject: async () => ({
          object: {
            profileOps: [],
            draftPatch: {
              agentType: "finance",
              name: "Finance Agent",
              roleLine: "Watches monthly spending",
              instructions: "Watch my monthly spending and flag unusual changes",
              definitionOfDone: "A weekly spending observations report is produced",
              mission: "A weekly spending observations report is produced",
              missionExecutable: false,
              blockingGaps: ["accounts or categories to watch"],
              coveredTopics: ["outcome"],
            },
            phase: "interview",
            topicsCoveredThisTurn: ["outcome"],
            userSkippedRemaining: false,
            userConfirmed: false,
            userCancelled: false,
            userWantsEdits: false,
          },
          usage: null,
        }),
      },
    });

    ({ createFakeDb } = await import("./helpers/fakeAgentDb.js"));
    envelope = await import("../server/security/envelope.js");

    handlers = {
      me: (await import("../api/me.js")).default,
      agents: (await import("../api/agents.js")).default,
      agentById: (await import("../api/agents/[id].js")).default,
      agentRun: (await import("../api/agents/[id]/run.js")).default,
      agentRuns: (await import("../api/agents/[id]/runs.js")).default,
      agentRunById: (await import("../api/agents/[id]/runs/[runId].js")).default,
      agentChat: (await import("../api/agents/[id]/chat.js")).default,
      ceo: (await import("../api/agents/ceo.js")).default,
      ceoProfile: (await import("../api/agents/ceo/profile.js")).default,
      ceoNarrativeProfile: (await import("../api/agents/ceo/profile/narrative.js")).default,
      ceoDigest: (await import("../api/agents/ceo/digest.js")).default,
      ceoChat: (await import("../api/agents/ceo/chat.js")).default,
      ceoConversations: (await import("../api/agents/ceo/conversations.js")).default,
      ceoConversationById: (await import("../api/agents/ceo/conversations/[conversationId].js"))
        .default,
      ceoConversationMessages: (
        await import("../api/agents/ceo/conversations/[conversationId]/messages.js")
      ).default,
      agentConversations: (await import("../api/agents/[id]/conversations.js")).default,
      agentConversationById: (
        await import("../api/agents/[id]/conversations/[conversationId].js")
      ).default,
      agentConversationMessages: (
        await import("../api/agents/[id]/conversations/[conversationId]/messages.js")
      ).default,
      ceoDocuments: (await import("../api/agents/ceo/documents.js")).default,
      onboarding: (await import("../api/agents/onboarding.js")).default,
      notifications: (await import("../api/notifications.js")).default,
      notificationById: (await import("../api/notifications/[id].js")).default,
      adminUsage: (await import("../api/admin/usage.js")).default,
    };
  } catch (error) {
    setupError = error;
  }
});

beforeEach(() => {
  if (setupError) return;
  // These tests stub respondToChat — keep Brain opt-out unless a case enables it.
  process.env.FREEDOM_BRAIN_CHAT = "0";
  runnerCalls = [];
  chatCalls = [];
  digestCalls = [];
  narrativeProfileCalls = [];
  runnerResult = {
    id: "run-1",
    agentConfigId: "agent-1",
    agentType: "finance",
    status: "SUCCEEDED",
    summary: "Mock run summary.",
    startedAt: new Date("2026-07-20T10:00:00Z"),
    completedAt: new Date("2026-07-20T10:01:00Z"),
  };
  currentServiceClient = null;
  currentDb = createFakeDb({
    user: [
      { id: "u1", email: "u1@example.com", isAdmin: null },
      { id: "u2", email: "u2@example.com", isAdmin: null },
    ],
  });
});

function requireSetup(t) {
  if (setupError) {
    t.skip(`requires --experimental-test-module-mocks (${setupError.message})`);
    return false;
  }
  return true;
}

function authedRequest(uid, options = {}) {
  return createRequest({
    ...options,
    headers: { authorization: `Bearer ${uid}`, ...(options.headers || {}) },
  });
}

async function invoke(handler, request) {
  const response = createResponse();
  await handler(request, response);
  return response;
}

function seedAgent(overrides = {}) {
  const ceo = { id: "ceo-1", userId: "u1", name: "CEO Agent", personalityPreset: "DIRECT_EFFICIENT" };
  const agent = {
    id: "agent-1",
    userId: "u1",
    ceoAgentConfigId: "ceo-1",
    agentType: "finance",
    name: "Finance Agent",
    instructions: "Watch spending.",
    definitionOfDone: "Weekly report.",
    permissionLevel: "READ_ONLY",
    model: "claude-sonnet-4-5",
    toolAccess: null,
    schedule: null,
    status: "ACTIVE",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
  currentDb.tables.ceoAgentConfig.push(ceo);
  currentDb.tables.agentConfig.push(agent);
  return agent;
}

// ── Auth required on every user route ────────────────────────────────────────

test("every user-facing agent route rejects requests without a bearer token", async (t) => {
  if (!requireSetup(t)) return;
  const cases = [
    [handlers.agents, createRequest({ method: "GET" })],
    [handlers.agents, createRequest({ method: "POST", body: {} })],
    [handlers.agentById, createRequest({ method: "PATCH", params: { id: "x" }, body: {} })],
    [handlers.agentRun, createRequest({ method: "POST", params: { id: "x" } })],
    [handlers.agentRuns, createRequest({ method: "GET", params: { id: "x" } })],
    [handlers.agentRunById, createRequest({ method: "GET", params: { id: "x", runId: "y" } })],
    [handlers.agentChat, createRequest({ method: "POST", params: { id: "x" }, body: { message: "hi" } })],
    [handlers.ceo, createRequest({ method: "GET" })],
    [handlers.ceoProfile, createRequest({ method: "GET" })],
    [handlers.ceoDigest, createRequest({ method: "GET" })],
    [handlers.ceoChat, createRequest({ method: "POST", body: { message: "hi" } })],
    [handlers.onboarding, createRequest({ method: "POST", body: {} })],
    [handlers.notifications, createRequest({ method: "GET" })],
    [handlers.notificationById, createRequest({ method: "PATCH", params: { id: "x" } })],
    [handlers.adminUsage, createRequest({ method: "GET" })],
  ];
  for (const [handler, request] of cases) {
    const response = await invoke(handler, request);
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.error, true);
  }
});

// ── /api/me isAdmin ──────────────────────────────────────────────────────────

test("GET /api/me includes isAdmin from the User row (false when unset)", async (t) => {
  if (!requireSetup(t)) return;
  currentDb.tables.user.find((row) => row.id === "u1").isAdmin = true;

  const adminResponse = await invoke(handlers.me, authedRequest("u1", { method: "GET" }));
  assert.equal(adminResponse.statusCode, 200);
  assert.equal(adminResponse.body.user.isAdmin, true);

  const normalResponse = await invoke(handlers.me, authedRequest("u2", { method: "GET" }));
  assert.equal(normalResponse.statusCode, 200);
  assert.equal(normalResponse.body.user.isAdmin, false);
});

// ── CEO Agent config ─────────────────────────────────────────────────────────

test("GET /api/agents/ceo auto-creates the CEO config with defaults", async (t) => {
  if (!requireSetup(t)) return;
  const response = await invoke(handlers.ceo, authedRequest("u1", { method: "GET" }));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ceoAgent.name, "CEO Agent");
  assert.equal(response.body.ceoAgent.personalityPreset, "DIRECT_EFFICIENT");
  assert.equal(currentDb.tables.ceoAgentConfig.length, 1);
  assert.equal(currentDb.tables.ceoAgentConfig[0].userId, "u1");
  // Never leaks ciphertext columns.
  assert.equal("profileCiphertext" in response.body.ceoAgent, false);
  assert.equal("lastDigestCiphertext" in response.body.ceoAgent, false);
});

test("PUT /api/agents/ceo rejects unknown personality presets and free-text fields", async (t) => {
  if (!requireSetup(t)) return;
  const bad = await invoke(
    handlers.ceo,
    authedRequest("u1", { method: "PUT", body: { personalityPreset: "SASSY_PIRATE" } })
  );
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.message, /personalityPreset/);

  const good = await invoke(
    handlers.ceo,
    authedRequest("u1", { method: "PUT", body: { name: "Ops Chief", personalityPreset: "FORMAL" } })
  );
  assert.equal(good.statusCode, 200);
  assert.equal(good.body.ceoAgent.name, "Ops Chief");
  assert.equal(good.body.ceoAgent.personalityPreset, "FORMAL");
});

test("PUT /api/agents/ceo accepts model and defaultSubAgentModel allowlist", async (t) => {
  if (!requireSetup(t)) return;
  currentDb.tables.ceoAgentConfig.push({
    id: "ceo-1",
    userId: "u1",
    name: "CEO Agent",
    personalityPreset: "DIRECT_EFFICIENT",
    model: "claude-sonnet-4-5",
    defaultSubAgentModel: "claude-sonnet-4-5",
  });

  const bad = await invoke(
    handlers.ceo,
    authedRequest("u1", { method: "PUT", body: { model: "gpt-4" } })
  );
  assert.equal(bad.statusCode, 400);
  assert.match(String(bad.body.message || ""), /model/);

  const good = await invoke(
    handlers.ceo,
    authedRequest("u1", {
      method: "PUT",
      body: { model: "claude-opus-4-1", defaultSubAgentModel: "claude-haiku-4-5" },
    })
  );
  assert.equal(good.statusCode, 200);
  assert.equal(good.body.ceoAgent.model, "claude-opus-4-1");
  assert.equal(good.body.ceoAgent.defaultSubAgentModel, "claude-haiku-4-5");
});

// ── Sub-agent CRUD ───────────────────────────────────────────────────────────

test("POST /api/agents creates a READ_ONLY ACTIVE agent linked to the CEO config", async (t) => {
  if (!requireSetup(t)) return;
  const response = await invoke(
    handlers.agents,
    authedRequest("u1", {
      method: "POST",
      body: {
        agentType: "finance",
        name: "Spending Watcher",
        instructions: "Watch categories.",
        definitionOfDone: "A weekly observations report.",
        schedulePreset: "weekly",
        scheduleWeekday: "friday",
      },
    })
  );
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.agent.permissionLevel, "READ_ONLY");
  assert.equal(response.body.agent.status, "ACTIVE");
  assert.equal(response.body.agent.model, "claude-sonnet-4-5");
  assert.deepEqual(response.body.agent.schedule, {
    preset: "weekly",
    weekday: "friday",
    weekdays: ["friday"],
    hourUtc: 13,
  });

  const row = currentDb.tables.agentConfig[0];
  assert.equal(row.permissionLevel, "READ_ONLY");
  assert.equal(row.status, "ACTIVE");
  assert.equal(row.model, "claude-sonnet-4-5");
  assert.equal(row.schedule, "0 13 * * 5"); // raw cron stays server-side
  assert.equal(row.ceoAgentConfigId, currentDb.tables.ceoAgentConfig[0].id);
});

test("POST /api/agents uses defaultSubAgentModel unless model is provided", async (t) => {
  if (!requireSetup(t)) return;
  currentDb.tables.ceoAgentConfig.push({
    id: "ceo-1",
    userId: "u1",
    name: "CEO Agent",
    personalityPreset: "DIRECT_EFFICIENT",
    model: "claude-opus-4-1",
    defaultSubAgentModel: "claude-haiku-4-5",
  });

  const fromDefault = await invoke(
    handlers.agents,
    authedRequest("u1", {
      method: "POST",
      body: {
        agentType: "research",
        name: "Trend Scout",
        definitionOfDone: "A weekly trends brief.",
      },
    })
  );
  assert.equal(fromDefault.statusCode, 201);
  assert.equal(fromDefault.body.agent.model, "claude-haiku-4-5");

  const explicit = await invoke(
    handlers.agents,
    authedRequest("u1", {
      method: "POST",
      body: {
        agentType: "reminders",
        name: "Cash Nudge",
        definitionOfDone: "A reminder is delivered on schedule.",
        model: "claude-opus-4-1",
      },
    })
  );
  assert.equal(explicit.statusCode, 201);
  assert.equal(explicit.body.agent.model, "claude-opus-4-1");
});

test("POST /api/agents rejects invalid types and permissionLevel injection", async (t) => {
  if (!requireSetup(t)) return;
  const badType = await invoke(
    handlers.agents,
    authedRequest("u1", {
      method: "POST",
      body: { agentType: "crypto-trader", name: "X", definitionOfDone: "Y" },
    })
  );
  assert.equal(badType.statusCode, 400);
  assert.match(badType.body.message, /agentType/);

  const badPermission = await invoke(
    handlers.agents,
    authedRequest("u1", {
      method: "POST",
      body: {
        agentType: "finance",
        name: "X",
        definitionOfDone: "Y",
        permissionLevel: "AUTONOMOUS",
      },
    })
  );
  assert.equal(badPermission.statusCode, 400);
  assert.match(badPermission.body.message, /permissionLevel/);
  assert.equal(currentDb.tables.agentConfig.length, 0);
});

test("GET /api/agents lists only the caller's agents with their latest run", async (t) => {
  if (!requireSetup(t)) return;
  seedAgent();
  currentDb.tables.agentRun.push(
    {
      id: "run-old",
      userId: "u1",
      agentConfigId: "agent-1",
      agentType: "finance",
      status: "SUCCEEDED",
      summary: "old",
      startedAt: new Date("2026-07-01T13:00:00Z"),
    },
    {
      id: "run-new",
      userId: "u1",
      agentConfigId: "agent-1",
      agentType: "finance",
      status: "SUCCEEDED",
      summary: "new",
      startedAt: new Date("2026-07-15T13:00:00Z"),
    }
  );

  const owner = await invoke(handlers.agents, authedRequest("u1", { method: "GET" }));
  assert.equal(owner.statusCode, 200);
  assert.equal(owner.body.agents.length, 1);
  assert.equal(owner.body.agents[0].latestRun.id, "run-new");

  const other = await invoke(handlers.agents, authedRequest("u2", { method: "GET" }));
  assert.equal(other.statusCode, 200);
  assert.deepEqual(other.body.agents, []);
});

test("PATCH and DELETE /api/agents/:id are scoped to the owning user", async (t) => {
  if (!requireSetup(t)) return;
  seedAgent();

  const foreignPatch = await invoke(
    handlers.agentById,
    authedRequest("u2", { method: "PATCH", params: { id: "agent-1" }, body: { status: "PAUSED" } })
  );
  assert.equal(foreignPatch.statusCode, 404);

  const foreignDelete = await invoke(
    handlers.agentById,
    authedRequest("u2", { method: "DELETE", params: { id: "agent-1" } })
  );
  assert.equal(foreignDelete.statusCode, 404);
  assert.equal(currentDb.tables.agentConfig.length, 1);

  const patch = await invoke(
    handlers.agentById,
    authedRequest("u1", { method: "PATCH", params: { id: "agent-1" }, body: { status: "PAUSED" } })
  );
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.body.agent.status, "PAUSED");

  const permissionAttempt = await invoke(
    handlers.agentById,
    authedRequest("u1", {
      method: "PATCH",
      params: { id: "agent-1" },
      body: { permissionLevel: "AUTONOMOUS" },
    })
  );
  assert.equal(permissionAttempt.statusCode, 400);
  assert.equal(currentDb.tables.agentConfig[0].permissionLevel, "READ_ONLY");

  const remove = await invoke(
    handlers.agentById,
    authedRequest("u1", { method: "DELETE", params: { id: "agent-1" } })
  );
  assert.equal(remove.statusCode, 200);
  assert.equal(currentDb.tables.agentConfig.length, 0);
});

// ── Runs ─────────────────────────────────────────────────────────────────────

test("POST /api/agents/:id/run invokes the runner with a manual trigger", async (t) => {
  if (!requireSetup(t)) return;
  seedAgent();
  const response = await invoke(
    handlers.agentRun,
    authedRequest("u1", { method: "POST", params: { id: "agent-1" } })
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(runnerCalls, [{ userId: "u1", agentConfigId: "agent-1", trigger: "manual" }]);
  assert.equal(response.body.run.id, "run-1");
  assert.equal(response.body.run.status, "SUCCEEDED");
  assert.equal("output" in response.body.run, false);
});

test("GET /api/agents/:id/runs paginates and enforces ownership", async (t) => {
  if (!requireSetup(t)) return;
  seedAgent();
  for (let i = 1; i <= 5; i += 1) {
    currentDb.tables.agentRun.push({
      id: `run-${i}`,
      userId: "u1",
      agentConfigId: "agent-1",
      agentType: "finance",
      status: "SUCCEEDED",
      summary: `summary ${i}`,
      startedAt: new Date(`2026-07-1${i}T13:00:00Z`),
    });
  }

  const foreign = await invoke(
    handlers.agentRuns,
    authedRequest("u2", { method: "GET", params: { id: "agent-1" } })
  );
  assert.equal(foreign.statusCode, 404);

  const page = await invoke(
    handlers.agentRuns,
    authedRequest("u1", { method: "GET", params: { id: "agent-1" }, query: { limit: "2" } })
  );
  assert.equal(page.statusCode, 200);
  assert.deepEqual(page.body.runs.map((run) => run.id), ["run-5", "run-4"]);
  assert.equal(page.body.hasMore, true);

  const older = await invoke(
    handlers.agentRuns,
    authedRequest("u1", {
      method: "GET",
      params: { id: "agent-1" },
      query: { limit: "10", before: "2026-07-13T13:00:00Z" },
    })
  );
  assert.deepEqual(older.body.runs.map((run) => run.id), ["run-2", "run-1"]);
  assert.equal(older.body.hasMore, false);
});

test("GET /api/agents/:id/runs/:runId returns the decrypted output (owner only)", async (t) => {
  if (!requireSetup(t)) return;
  seedAgent();
  currentDb.tables.agentRun.push({
    id: "run-1",
    userId: "u1",
    agentConfigId: "agent-1",
    agentType: "finance",
    status: "SUCCEEDED",
    summary: "the summary",
    outputCiphertext: envelope.encrypt("the full report"),
    startedAt: new Date("2026-07-15T13:00:00Z"),
  });

  const foreign = await invoke(
    handlers.agentRunById,
    authedRequest("u2", { method: "GET", params: { id: "agent-1", runId: "run-1" } })
  );
  assert.equal(foreign.statusCode, 404);

  const response = await invoke(
    handlers.agentRunById,
    authedRequest("u1", { method: "GET", params: { id: "agent-1", runId: "run-1" } })
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.run.output, "the full report");
});

test("POST /api/agents/:id/runs/:runId (email me this run) fails closed", async (t) => {
  if (!requireSetup(t)) return;
  const previousResendKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  t.after(() => {
    if (previousResendKey == null) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousResendKey;
  });

  seedAgent();
  currentDb.tables.agentRun.push({
    id: "run-1",
    userId: "u1",
    agentConfigId: "agent-1",
    agentType: "finance",
    status: "SUCCEEDED",
    summary: "the summary",
    outputCiphertext: envelope.encrypt("the full report"),
    startedAt: new Date("2026-07-15T13:00:00Z"),
  });

  // Ownership is enforced before anything else.
  const foreign = await invoke(
    handlers.agentRunById,
    authedRequest("u2", { method: "POST", params: { id: "agent-1", runId: "run-1" } })
  );
  assert.equal(foreign.statusCode, 404);

  // Email service missing → typed 503, nothing sent.
  const noService = await invoke(
    handlers.agentRunById,
    authedRequest("u1", { method: "POST", params: { id: "agent-1", runId: "run-1" } })
  );
  assert.equal(noService.statusCode, 503);
  assert.equal(noService.body.code, "EMAIL_SERVICE_UNAVAILABLE");

  // Service configured but the account email cannot be verified (Firebase
  // Admin is not configured in tests) → typed 403, nothing sent.
  process.env.RESEND_API_KEY = "test-key-never-used";
  const unverified = await invoke(
    handlers.agentRunById,
    authedRequest("u1", { method: "POST", params: { id: "agent-1", runId: "run-1" } })
  );
  assert.equal(unverified.statusCode, 403);
  assert.equal(unverified.body.code, "EMAIL_NOT_VERIFIED");
});

// ── Chat ─────────────────────────────────────────────────────────────────────

test("POST /api/agents/:id/chat delegates to respondToChat scoped to the agent", async (t) => {
  if (!requireSetup(t)) return;
  seedAgent();
  const response = await invoke(
    handlers.agentChat,
    authedRequest("u1", {
      method: "POST",
      params: { id: "agent-1" },
      body: { message: "what did you find?", relatedRunId: "run-9" },
    })
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.reply, "mock chat reply");
  assert.equal(response.body.messageId, "msg-123");
  assert.deepEqual(chatCalls, [
    {
      userId: "u1",
      agentConfigId: "agent-1",
      conversationId: null,
      message: "what did you find?",
      relatedRunId: "run-9",
    },
  ]);
});

test("POST /api/agents/:id/chat 'email me the report' is handled without an LLM call", async (t) => {
  if (!requireSetup(t)) return;
  const previousResendKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  t.after(() => {
    if (previousResendKey == null) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousResendKey;
  });

  seedAgent();

  // No completed run yet → helpful reply, no LLM call.
  const noRuns = await invoke(
    handlers.agentChat,
    authedRequest("u1", {
      method: "POST",
      params: { id: "agent-1" },
      body: { message: "can you email me the report?" },
    })
  );
  assert.equal(noRuns.statusCode, 200);
  assert.match(noRuns.body.reply, /no completed run/i);
  assert.equal(chatCalls.length, 0);

  // With a completed run but no email service → explains the skip in chat.
  currentDb.tables.agentRun.push({
    id: "run-1",
    userId: "u1",
    agentConfigId: "agent-1",
    agentType: "finance",
    status: "SUCCEEDED",
    summary: "the summary",
    outputCiphertext: envelope.encrypt("the full report"),
    startedAt: new Date("2026-07-15T13:00:00Z"),
  });
  const skipped = await invoke(
    handlers.agentChat,
    authedRequest("u1", {
      method: "POST",
      params: { id: "agent-1" },
      body: { message: "email me the report" },
    })
  );
  assert.equal(skipped.statusCode, 200);
  assert.match(skipped.body.reply, /couldn't email it/i);
  assert.match(skipped.body.reply, /email service is not configured/i);
  assert.equal(chatCalls.length, 0);

  // Both chat turns were persisted to the durable thread.
  const chatRows = currentDb.tables.agentChatMessage.filter(
    (row) => row.agentConfigId === "agent-1"
  );
  assert.equal(chatRows.filter((row) => row.role === "USER").length, 2);
  assert.equal(chatRows.filter((row) => row.role === "AGENT").length, 2);

  // A normal question still goes through the LLM chat path.
  const normal = await invoke(
    handlers.agentChat,
    authedRequest("u1", {
      method: "POST",
      params: { id: "agent-1" },
      body: { message: "what did you find?" },
    })
  );
  assert.equal(normal.statusCode, 200);
  assert.equal(normal.body.reply, "mock chat reply");
  assert.equal(chatCalls.length, 1);
});

test("POST /api/agents/ceo/chat delegates to respondToChat scoped to the CEO config", async (t) => {
  if (!requireSetup(t)) return;
  const response = await invoke(
    handlers.ceoChat,
    authedRequest("u1", { method: "POST", body: { message: "how are my finances?" } })
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.reply, "mock chat reply");
  assert.equal(chatCalls.length, 1);
  assert.equal(chatCalls[0].ceoAgentConfigId, currentDb.tables.ceoAgentConfig[0].id);
  assert.equal(chatCalls[0].message, "how are my finances?");
});

test("GET /api/agents/ceo/chat returns visible history and hides creation-state rows", async (t) => {
  if (!requireSetup(t)) return;

  // Ensure the CEO config exists (same path the GET handler uses).
  await invoke(handlers.ceo, authedRequest("u1", { method: "GET" }));
  const ceoId = currentDb.tables.ceoAgentConfig[0].id;
  const { CREATION_STATE_SENTINEL } = await import("../server/agents/creationFlow.js");

  currentDb.tables.agentConversation.push({
    id: "conv-ceo",
    userId: "u1",
    ceoAgentConfigId: ceoId,
    agentConfigId: null,
    title: "Original thread",
    isSystem: false,
    archivedAt: null,
    createdAt: new Date("2026-07-20T09:00:00Z"),
    updatedAt: new Date("2026-07-20T12:00:00Z"),
  });

  currentDb.tables.agentChatMessage.push(
    {
      id: "m1",
      userId: "u1",
      conversationId: "conv-ceo",
      ceoAgentConfigId: ceoId,
      agentConfigId: null,
      role: "USER",
      contentCiphertext: envelope.encrypt("What should I focus on this week?"),
      createdAt: new Date("2026-07-20T10:00:00Z"),
    },
    {
      id: "m2",
      userId: "u1",
      conversationId: "conv-ceo",
      ceoAgentConfigId: ceoId,
      agentConfigId: null,
      role: "AGENT",
      contentCiphertext: envelope.encrypt(`${CREATION_STATE_SENTINEL}{"v":1,"status":"completed"}`),
      createdAt: new Date("2026-07-20T10:00:01Z"),
    },
    {
      id: "m3",
      userId: "u1",
      conversationId: "conv-ceo",
      ceoAgentConfigId: ceoId,
      agentConfigId: null,
      role: "AGENT",
      contentCiphertext: envelope.encrypt("Start with cash flow and upcoming bills."),
      createdAt: new Date("2026-07-20T10:00:02Z"),
    }
  );

  const response = await invoke(handlers.ceoChat, authedRequest("u1", { method: "GET" }));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.messages.length, 2);
  assert.equal(response.body.messages[0].role, "user");
  assert.match(response.body.messages[0].text, /focus on this week/);
  assert.equal(response.body.messages[1].role, "agent");
  assert.match(response.body.messages[1].text, /cash flow/);
  assert.equal(chatCalls.length, 0);
});

test("GET /api/agents/:id/chat returns that agent's history only", async (t) => {
  if (!requireSetup(t)) return;
  currentDb.tables.agentConfig.push(
    {
      id: "agent-1",
      userId: "u1",
      agentType: "research",
      name: "Research Agent",
      definitionOfDone: "done",
      permissionLevel: "READ_ONLY",
      status: "ACTIVE",
    },
    {
      id: "agent-2",
      userId: "u1",
      agentType: "finance",
      name: "Finance Agent",
      definitionOfDone: "done",
      permissionLevel: "READ_ONLY",
      status: "ACTIVE",
    }
  );
  currentDb.tables.agentConversation.push(
    {
      id: "conv-a1",
      userId: "u1",
      agentConfigId: "agent-1",
      ceoAgentConfigId: null,
      title: "Original thread",
      isSystem: false,
      archivedAt: null,
      createdAt: new Date("2026-07-20T10:00:00Z"),
      updatedAt: new Date("2026-07-20T11:00:00Z"),
    },
    {
      id: "conv-a2",
      userId: "u1",
      agentConfigId: "agent-2",
      ceoAgentConfigId: null,
      title: "Original thread",
      isSystem: false,
      archivedAt: null,
      createdAt: new Date("2026-07-20T10:00:00Z"),
      updatedAt: new Date("2026-07-20T11:01:00Z"),
    }
  );
  currentDb.tables.agentChatMessage.push(
    {
      id: "a1",
      userId: "u1",
      conversationId: "conv-a1",
      agentConfigId: "agent-1",
      ceoAgentConfigId: null,
      role: "USER",
      contentCiphertext: envelope.encrypt("any updates on AI tools?"),
      createdAt: new Date("2026-07-20T11:00:00Z"),
    },
    {
      id: "a2",
      userId: "u1",
      conversationId: "conv-a2",
      agentConfigId: "agent-2",
      ceoAgentConfigId: null,
      role: "USER",
      contentCiphertext: envelope.encrypt("spending question for finance"),
      createdAt: new Date("2026-07-20T11:01:00Z"),
    }
  );

  const response = await invoke(
    handlers.agentChat,
    authedRequest("u1", { method: "GET", params: { id: "agent-1" } })
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.messages.length, 1);
  assert.match(response.body.messages[0].text, /AI tools/);
});

test("CEO chat ignores legacy mode:create_agent and uses the one CEO brain path", async (t) => {
  if (!requireSetup(t)) return;

  // Force legacy respondToChat so the handler test stays deterministic without
  // spinning the full Brain tool loop (mocked as chatCalls).
  const previousBrain = process.env.FREEDOM_BRAIN_CHAT;
  process.env.FREEDOM_BRAIN_CHAT = "0";
  try {
    const response = await invoke(
      handlers.ceoChat,
      authedRequest("u1", {
        method: "POST",
        body: {
          mode: "create_agent",
          message: "I want an agent that emails me social media reports on a couple people.",
        },
      })
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.reply, "mock chat reply");
    assert.equal(response.body.creationDraft, undefined);
    assert.equal(response.body.agentCreated, undefined);
    assert.equal(chatCalls.length, 1);
    assert.match(chatCalls[0].message, /social media reports/i);
    assert.ok(chatCalls[0].ceoAgentConfigId);
  } finally {
    if (previousBrain == null) delete process.env.FREEDOM_BRAIN_CHAT;
    else process.env.FREEDOM_BRAIN_CHAT = previousBrain;
  }
});

test("CEO conversations CRUD + messages; system threads stay hidden", async (t) => {
  if (!requireSetup(t)) return;

  // Seed a system conversation (as creation would) — must never appear in list.
  await invoke(handlers.ceo, authedRequest("u1", { method: "GET" }));
  const ceoId = currentDb.tables.ceoAgentConfig[0].id;
  currentDb.tables.agentConversation.push({
    id: "sys-1",
    userId: "u1",
    ceoAgentConfigId: ceoId,
    agentConfigId: null,
    title: "New Agent",
    isSystem: true,
    archivedAt: null,
    createdAt: new Date("2026-07-20T09:00:00Z"),
    updatedAt: new Date("2026-07-20T09:00:00Z"),
  });

  const created = await invoke(
    handlers.ceoConversations,
    authedRequest("u1", { method: "POST", body: {} })
  );
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.conversation.isSystem, false);
  assert.equal(created.body.conversation.ceoAgentConfigId, ceoId);
  const conversationId = created.body.conversation.id;

  const listed = await invoke(handlers.ceoConversations, authedRequest("u1", { method: "GET" }));
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.conversations.length, 1);
  assert.equal(listed.body.conversations[0].id, conversationId);
  assert.ok(!listed.body.conversations.some((row) => row.isSystem));

  currentDb.tables.agentChatMessage.push({
    id: "cm1",
    userId: "u1",
    conversationId,
    ceoAgentConfigId: ceoId,
    agentConfigId: null,
    role: "USER",
    contentCiphertext: envelope.encrypt("hello from conversation"),
    createdAt: new Date("2026-07-20T12:00:00Z"),
  });

  const messages = await invoke(
    handlers.ceoConversationMessages,
    authedRequest("u1", {
      method: "GET",
      params: { conversationId },
    })
  );
  assert.equal(messages.statusCode, 200);
  assert.equal(messages.body.messages.length, 1);
  assert.match(messages.body.messages[0].text, /hello from conversation/);

  const renamed = await invoke(
    handlers.ceoConversationById,
    authedRequest("u1", {
      method: "PATCH",
      params: { conversationId },
      body: { title: "Budget review" },
    })
  );
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.body.conversation.title, "Budget review");

  const archived = await invoke(
    handlers.ceoConversationById,
    authedRequest("u1", {
      method: "PATCH",
      params: { conversationId },
      body: { archived: true },
    })
  );
  assert.equal(archived.statusCode, 200);
  assert.ok(archived.body.conversation.archivedAt);

  const listedDefault = await invoke(
    handlers.ceoConversations,
    authedRequest("u1", { method: "GET" })
  );
  assert.equal(listedDefault.body.conversations.length, 0);

  const listedArchived = await invoke(
    handlers.ceoConversations,
    authedRequest("u1", { method: "GET", query: { includeArchived: "true" } })
  );
  assert.equal(listedArchived.body.conversations.length, 1);

  const deleted = await invoke(
    handlers.ceoConversationById,
    authedRequest("u1", { method: "DELETE", params: { conversationId } })
  );
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.body.deleted, true);

  const systemPatch = await invoke(
    handlers.ceoConversationById,
    authedRequest("u1", {
      method: "PATCH",
      params: { conversationId: "sys-1" },
      body: { title: "nope" },
    })
  );
  assert.equal(systemPatch.statusCode, 400);
});

test("sub-agent conversations are scoped to that agent", async (t) => {
  if (!requireSetup(t)) return;
  currentDb.tables.agentConfig.push(
    {
      id: "agent-1",
      userId: "u1",
      agentType: "research",
      name: "Research Agent",
      definitionOfDone: "done",
      permissionLevel: "READ_ONLY",
      status: "ACTIVE",
    },
    {
      id: "agent-2",
      userId: "u1",
      agentType: "finance",
      name: "Finance Agent",
      definitionOfDone: "done",
      permissionLevel: "READ_ONLY",
      status: "ACTIVE",
    }
  );

  const created = await invoke(
    handlers.agentConversations,
    authedRequest("u1", { method: "POST", params: { id: "agent-1" }, body: {} })
  );
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.conversation.agentConfigId, "agent-1");

  const cross = await invoke(
    handlers.agentConversationById,
    authedRequest("u1", {
      method: "PATCH",
      params: { id: "agent-2", conversationId: created.body.conversation.id },
      body: { title: "stolen" },
    })
  );
  assert.equal(cross.statusCode, 400);
  assert.match(String(cross.body?.message || cross.body?.error || ""), /does not belong/i);
});

test("agent conversation routes with id=ceo act as CEO (Vercel misroute compat)", async (t) => {
  if (!requireSetup(t)) return;
  // Nested /api/agents/ceo/conversations/* can land on the dynamic :id handlers
  // in production. Those must serve CEO chats, not reject with INVALID_CHAT_TARGET.
  const listed = await invoke(
    handlers.agentConversations,
    authedRequest("u1", { method: "GET", params: { id: "ceo" } })
  );
  assert.equal(listed.statusCode, 200);
  assert.ok(Array.isArray(listed.body?.conversations));

  const created = await invoke(
    handlers.agentConversations,
    authedRequest("u1", { method: "POST", params: { id: "ceo" }, body: { title: "Via :id" } })
  );
  assert.equal(created.statusCode, 201);
  assert.ok(created.body?.conversation?.ceoAgentConfigId);
  assert.equal(created.body?.conversation?.agentConfigId ?? null, null);

  const messages = await invoke(
    handlers.agentConversationMessages,
    authedRequest("u1", {
      method: "GET",
      params: { id: "ceo", conversationId: created.body.conversation.id },
    })
  );
  assert.equal(messages.statusCode, 200);
  assert.ok(Array.isArray(messages.body?.messages));

  const deleted = await invoke(
    handlers.agentConversationById,
    authedRequest("u1", {
      method: "DELETE",
      params: { id: "ceo", conversationId: created.body.conversation.id },
    })
  );
  assert.equal(deleted.statusCode, 200);

  // Chat still has an explicit redirect — only conversation nesting is ambiguous.
  const chat = await invoke(
    handlers.agentChat,
    authedRequest("u1", { method: "GET", params: { id: "ceo" } })
  );
  assert.equal(chat.statusCode, 400);
  assert.match(String(chat.body?.message || ""), /ceo\/chat/i);
});

// ── CEO profile ──────────────────────────────────────────────────────────────

test("CEO profile PATCH applies user edits and tombstoned deletes", async (t) => {
  if (!requireSetup(t)) return;
  currentDb.tables.ceoAgentConfig.push({
    id: "ceo-1",
    userId: "u1",
    name: "CEO Agent",
    personalityPreset: "DIRECT_EFFICIENT",
    profileCiphertext: envelope.encryptJson({
      categories: {
        financialGoals: [
          { id: "goal-1", text: "Pay off the car", source: "onboarding", addedAt: "2026-01-01", updatedAt: "2026-01-01" },
          { id: "goal-2", text: "Build 6-month reserve", source: "finance", addedAt: "2026-01-01", updatedAt: "2026-01-01" },
        ],
      },
      tombstones: [],
    }),
  });

  const response = await invoke(
    handlers.ceoProfile,
    authedRequest("u1", {
      method: "PATCH",
      body: {
        ops: [
          { action: "update", category: "financialGoals", id: "goal-1", text: "Pay off the truck" },
          { action: "delete", category: "financialGoals", id: "goal-2" },
        ],
      },
    })
  );
  assert.equal(response.statusCode, 200);
  const goals = response.body.profile.categories.financialGoals;
  assert.equal(goals.length, 1);
  assert.equal(goals[0].text, "Pay off the truck");
  assert.equal(goals[0].source, "user_edit");
  assert.equal(response.body.profile.tombstones.count, 1);

  const stored = envelope.decryptJson(currentDb.tables.ceoAgentConfig[0].profileCiphertext);
  assert.deepEqual(stored.tombstones, ["goal-2"]);
});

// ── Digest ───────────────────────────────────────────────────────────────────

test("GET /api/agents/ceo/digest serves the fresh cache and regenerates when stale or forced", async (t) => {
  if (!requireSetup(t)) return;
  currentDb.tables.ceoAgentConfig.push({
    id: "ceo-1",
    userId: "u1",
    name: "CEO Agent",
    personalityPreset: "DIRECT_EFFICIENT",
    lastDigestCiphertext: envelope.encrypt("cached digest"),
    lastDigestAt: new Date(Date.now() - 60 * 60 * 1000),
  });

  const cached = await invoke(handlers.ceoDigest, authedRequest("u1", { method: "GET" }));
  assert.equal(cached.statusCode, 200);
  assert.equal(cached.body.digest, "cached digest");
  assert.equal(cached.body.refreshed, false);
  assert.equal(digestCalls.length, 0);

  const forced = await invoke(
    handlers.ceoDigest,
    authedRequest("u1", { method: "GET", query: { refresh: "true" } })
  );
  assert.equal(forced.body.digest, "freshly generated digest");
  assert.equal(forced.body.refreshed, true);
  assert.deepEqual(digestCalls, ["u1"]);

  currentDb.tables.ceoAgentConfig[0].lastDigestAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const stale = await invoke(handlers.ceoDigest, authedRequest("u1", { method: "GET" }));
  assert.equal(stale.body.refreshed, true);
  assert.equal(digestCalls.length, 2);

  const posted = await invoke(handlers.ceoDigest, authedRequest("u1", { method: "POST" }));
  assert.equal(posted.body.refreshed, true);
  assert.equal(digestCalls.length, 3);
});

test("GET/POST /api/agents/ceo/profile/narrative serve cache and regenerate", async (t) => {
  if (!requireSetup(t)) return;
  currentDb.tables.ceoAgentConfig.push({
    id: "ceo-1",
    userId: "u1",
    name: "CEO Agent",
    personalityPreset: "DIRECT_EFFICIENT",
    narrativeProfileCiphertext: envelope.encrypt("Cached newsletter profile."),
    narrativeProfileAt: new Date("2026-07-21T10:00:00Z"),
  });

  const cached = await invoke(
    handlers.ceoNarrativeProfile,
    authedRequest("u1", { method: "GET" })
  );
  assert.equal(cached.statusCode, 200);
  assert.equal(cached.body.narrativeProfile.profile, "Cached newsletter profile.");
  assert.equal(narrativeProfileCalls.length, 0);

  const profileGet = await invoke(handlers.ceoProfile, authedRequest("u1", { method: "GET" }));
  assert.equal(profileGet.statusCode, 200);
  assert.equal(profileGet.body.narrativeProfile.profile, "Cached newsletter profile.");

  const refreshed = await invoke(
    handlers.ceoNarrativeProfile,
    authedRequest("u1", { method: "POST" })
  );
  assert.equal(refreshed.statusCode, 200);
  assert.equal(refreshed.body.refreshed, true);
  assert.match(String(refreshed.body.narrativeProfile.profile || ""), /newsletter profile/i);
  assert.equal(narrativeProfileCalls.length, 1);
});

// ── Onboarding ───────────────────────────────────────────────────────────────

test("POST /api/agents/onboarding seeds the profile once and 409s afterwards", async (t) => {
  if (!requireSetup(t)) return;
  const response = await invoke(
    handlers.onboarding,
    authedRequest("u1", {
      method: "POST",
      body: {
        financialGoals: ["Pay off debt", "Save for a farm"],
        lifeContext: "Two kids, one income.",
        additionalNotes: "Keep cash higher before spring expansion.",
        priorities: ["Stability"],
        communicationPrefs: "Short and direct",
        ceoName: "Chief",
        personalityPreset: "WARM_ENCOURAGING",
        documents: [
          {
            filename: "priorities.txt",
            mimeType: "text/plain",
            content: "Reserve runway matters more than growth this year.",
          },
        ],
      },
    })
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ceoAgent.name, "Chief");
  assert.equal(response.body.ceoAgent.personalityPreset, "WARM_ENCOURAGING");
  assert.ok(response.body.ceoAgent.onboardingCompletedAt);
  assert.equal(response.body.profileEntriesSeeded, 6);
  assert.equal(response.body.documents.length, 1);
  assert.equal(response.body.documents[0].filename, "priorities.txt");
  assert.match(response.body.onboardingSummary.summary, /Goals|know/i);
  assert.ok(currentDb.tables.ceoAgentConfig[0].onboardingSummaryCiphertext);

  const stored = envelope.decryptJson(currentDb.tables.ceoAgentConfig[0].profileCiphertext);
  assert.deepEqual(
    stored.categories.financialGoals.map((entry) => entry.text),
    ["Pay off debt", "Save for a farm"]
  );
  assert.ok(stored.categories.financialGoals.every((entry) => entry.source === "onboarding"));
  assert.equal(stored.categories.lifeContext[0].text, "Two kids, one income.");
  assert.match(stored.categories.lifeContext[1].text, /Additional notes/);
  assert.equal(currentDb.tables.ceoDocument.length, 1);

  const profileGet = await invoke(handlers.ceoProfile, authedRequest("u1", { method: "GET" }));
  assert.equal(profileGet.statusCode, 200);
  assert.match(profileGet.body.onboardingSummary.summary, /Goals|know/i);
  assert.equal(profileGet.body.documents.length, 1);

  const repeat = await invoke(
    handlers.onboarding,
    authedRequest("u1", { method: "POST", body: { financialGoals: ["Another goal"] } })
  );
  assert.equal(repeat.statusCode, 409);
});

test("CEO documents can be uploaded and deleted after onboarding", async (t) => {
  if (!requireSetup(t)) return;
  await invoke(handlers.ceo, authedRequest("u1", { method: "GET" }));

  const uploaded = await invoke(
    handlers.ceoDocuments,
    authedRequest("u1", {
      method: "POST",
      body: {
        documents: [
          { filename: "plan.md", mimeType: "text/markdown", content: "# Plan\nHold reserves." },
        ],
      },
    })
  );
  assert.equal(uploaded.statusCode, 200);
  assert.equal(uploaded.body.documents[0].filename, "plan.md");
  const docId = uploaded.body.documents[0].id;

  const listed = await invoke(handlers.ceoDocuments, authedRequest("u1", { method: "GET" }));
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.documents.length, 1);

  const deleted = await invoke(
    handlers.ceoDocuments,
    authedRequest("u1", { method: "DELETE", query: { id: docId } })
  );
  assert.equal(deleted.statusCode, 200);
  assert.equal(currentDb.tables.ceoDocument.length, 0);
});

// ── Notifications ────────────────────────────────────────────────────────────

test("notifications list, unread filter, and mark-read are user-scoped", async (t) => {
  if (!requireSetup(t)) return;
  currentDb.tables.notification.push(
    {
      id: "n1",
      userId: "u1",
      title: "Reminder",
      body: "Pay the bill",
      channel: "IN_APP",
      readAt: null,
      createdAt: new Date("2026-07-19T00:00:00Z"),
    },
    {
      id: "n2",
      userId: "u1",
      title: "Older",
      body: "Read already",
      channel: "IN_APP",
      readAt: new Date("2026-07-18T12:00:00Z"),
      createdAt: new Date("2026-07-18T00:00:00Z"),
    },
    {
      id: "n3",
      userId: "u2",
      title: "Other user",
      body: "Not yours",
      channel: "IN_APP",
      readAt: null,
      createdAt: new Date("2026-07-19T00:00:00Z"),
    }
  );

  const all = await invoke(handlers.notifications, authedRequest("u1", { method: "GET" }));
  assert.deepEqual(all.body.notifications.map((n) => n.id), ["n1", "n2"]);

  const unread = await invoke(
    handlers.notifications,
    authedRequest("u1", { method: "GET", query: { unreadOnly: "true" } })
  );
  assert.deepEqual(unread.body.notifications.map((n) => n.id), ["n1"]);

  const foreign = await invoke(
    handlers.notificationById,
    authedRequest("u1", { method: "PATCH", params: { id: "n3" } })
  );
  assert.equal(foreign.statusCode, 404);

  const marked = await invoke(
    handlers.notificationById,
    authedRequest("u1", { method: "PATCH", params: { id: "n1" } })
  );
  assert.equal(marked.statusCode, 200);
  assert.ok(marked.body.notification.readAt);
});

// ── Admin usage ──────────────────────────────────────────────────────────────

test("GET /api/admin/usage rejects non-admins and aggregates for admins", async (t) => {
  if (!requireSetup(t)) return;
  const forbidden = await invoke(handlers.adminUsage, authedRequest("u1", { method: "GET" }));
  assert.equal(forbidden.statusCode, 403);

  currentDb.tables.user.find((row) => row.id === "u1").isAdmin = true;
  currentServiceClient = {
    user: {
      findMany: async () => [
        { id: "u1", email: "u1@example.com", lastLoginAt: new Date("2026-07-19T00:00:00Z") },
        { id: "u2", email: "u2@example.com", lastLoginAt: null },
      ],
    },
    agentRun: {
      groupBy: async (args) => {
        if (args.by.includes("agentType")) {
          return [
            {
              userId: "u1",
              agentType: "finance",
              _count: { _all: 4 },
              _sum: { tokensInput: 4000, tokensOutput: 800, estimatedCostUsd: 0.024 },
            },
            {
              userId: "u1",
              agentType: "reminders",
              _count: { _all: 2 },
              _sum: { tokensInput: null, tokensOutput: null, estimatedCostUsd: null },
            },
          ];
        }
        return [
          {
            userId: "u1",
            _count: { _all: 3 },
            _sum: { tokensInput: 3000, tokensOutput: 600, estimatedCostUsd: 0.018 },
          },
        ];
      },
    },
  };

  const response = await invoke(handlers.adminUsage, authedRequest("u1", { method: "GET" }));
  assert.equal(response.statusCode, 200);
  const [u1, u2] = response.body.usage;
  assert.equal(u1.userId, "u1");
  assert.equal(u1.runsAllTime, 6);
  assert.equal(u1.runsThisMonth, 3);
  assert.equal(u1.tokensAllTime, 4800);
  assert.equal(u1.tokensThisMonth, 3600);
  assert.equal(u1.costAllTime, 0.024);
  assert.equal(u1.costThisMonth, 0.018);
  assert.deepEqual(u1.byAgentType.finance, { runs: 4, tokens: 4800, cost: 0.024 });
  assert.deepEqual(u1.byAgentType.reminders, { runs: 2, tokens: 0, cost: 0 });
  assert.equal(u2.runsAllTime, 0);
});
