import test, { before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import { createRequest, createResponse } from "./helpers/httpMocks.js";

// Tests for the Vercel Cron dispatcher (api/cron/agent-dispatch.js): secret
// auth (header + query fallback, fail closed when unconfigured), the due-agent
// selection, the per-invocation cap, and the best-effort digest refresh.
//
// Requires: node --test --experimental-test-module-mocks (npm test).

let setupError = null;
let handler;
let createFakeDb;

let currentDb;
let runnerCalls;
let runnerBehavior;
let digestCalls;

before(async () => {
  try {
    mock.module("../server/db/servicePrisma.js", {
      namedExports: {
        // The fake tx implements the same delegate surface the service client
        // uses here (findMany incl. distinct).
        getServicePrismaClient: () => currentDb.tx,
        isServiceDatabaseConfigured: () => true,
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

    mock.module("../server/agents/runner.js", {
      namedExports: {
        runAgent: async (args) => {
          runnerCalls.push(args);
          return runnerBehavior(args);
        },
      },
    });

    mock.module("../server/agents/digest.js", {
      namedExports: {
        generateDigest: async (userId) => {
          digestCalls.push(userId);
          return { digest: "digest", generatedAt: new Date(), model: null, usage: null };
        },
        NO_ACTIVITY_DIGEST: "nothing yet",
      },
    });

    ({ createFakeDb } = await import("./helpers/fakeAgentDb.js"));
    handler = (await import("../api/cron/agent-dispatch.js")).default;
  } catch (error) {
    setupError = error;
  }
});

beforeEach(() => {
  if (setupError) return;
  process.env.CRON_SECRET = "test-cron-secret";
  runnerCalls = [];
  digestCalls = [];
  runnerBehavior = () => ({ status: "SUCCEEDED" });
  currentDb = createFakeDb({});
});

function requireSetup(t) {
  if (setupError) {
    t.skip(`requires --experimental-test-module-mocks (${setupError.message})`);
    return false;
  }
  return true;
}

async function invoke(request) {
  const response = createResponse();
  await handler(request, response);
  return response;
}

const TEN_DAYS_AGO = () => new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

function seedScheduledAgent({ id = "agent-1", userId = "u1", schedule = "0 13 * * *", status = "ACTIVE", lastRunAt } = {}) {
  currentDb.tables.agentConfig.push({
    id,
    userId,
    ceoAgentConfigId: `ceo-${userId}`,
    agentType: "finance",
    name: "Finance Agent",
    permissionLevel: "READ_ONLY",
    schedule,
    status,
  });
  if (lastRunAt) {
    currentDb.tables.agentRun.push({
      id: `${id}-last-run`,
      userId,
      agentConfigId: id,
      agentType: "finance",
      status: "SUCCEEDED",
      startedAt: lastRunAt,
    });
  }
}

test("cron dispatch fails closed when CRON_SECRET is not configured", async (t) => {
  if (!requireSetup(t)) return;
  delete process.env.CRON_SECRET;
  const response = await invoke(
    createRequest({ method: "GET", headers: { authorization: "Bearer anything" } })
  );
  assert.equal(response.statusCode, 503);
  assert.equal(runnerCalls.length, 0);
});

test("cron dispatch rejects a missing or wrong secret", async (t) => {
  if (!requireSetup(t)) return;
  seedScheduledAgent({ lastRunAt: TEN_DAYS_AGO() });

  const missing = await invoke(createRequest({ method: "GET" }));
  assert.equal(missing.statusCode, 401);

  const wrong = await invoke(
    createRequest({ method: "GET", headers: { authorization: "Bearer wrong-secret" } })
  );
  assert.equal(wrong.statusCode, 401);
  assert.equal(runnerCalls.length, 0);
});

test("cron dispatch runs due agents (header auth) and refreshes their users' digests", async (t) => {
  if (!requireSetup(t)) return;
  // Due: last run long before the previous scheduled occurrence.
  seedScheduledAgent({ id: "agent-due", userId: "u1", lastRunAt: TEN_DAYS_AGO() });
  // Never ran → also due.
  seedScheduledAgent({ id: "agent-never-ran", userId: "u2" });
  // Ran just now → not due.
  seedScheduledAgent({ id: "agent-fresh", userId: "u3", lastRunAt: new Date() });
  // Paused / unscheduled agents are never dispatched.
  seedScheduledAgent({ id: "agent-paused", userId: "u4", status: "PAUSED", lastRunAt: TEN_DAYS_AGO() });
  seedScheduledAgent({ id: "agent-on-demand", userId: "u5", schedule: null });
  // Unknown cron shapes are never due (fail closed).
  seedScheduledAgent({ id: "agent-weird-cron", userId: "u6", schedule: "*/5 * * * *" });

  const response = await invoke(
    createRequest({ method: "GET", headers: { authorization: "Bearer test-cron-secret" } })
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { processed: 2, skipped: 0, errors: [] });
  assert.deepEqual(
    runnerCalls.map((call) => call.agentConfigId).sort(),
    ["agent-due", "agent-never-ran"]
  );
  assert.ok(runnerCalls.every((call) => call.trigger === "cron"));
  assert.equal(runnerCalls.find((c) => c.agentConfigId === "agent-due").userId, "u1");
  assert.deepEqual([...digestCalls].sort(), ["u1", "u2"]);
});

test("cron dispatch accepts the ?secret= fallback", async (t) => {
  if (!requireSetup(t)) return;
  seedScheduledAgent({ lastRunAt: TEN_DAYS_AGO() });
  const response = await invoke(
    createRequest({ method: "GET", query: { secret: "test-cron-secret" } })
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.processed, 1);
});

test("cron dispatch caps work per invocation and reports the remainder as skipped", async (t) => {
  if (!requireSetup(t)) return;
  for (let i = 0; i < 25; i += 1) {
    seedScheduledAgent({ id: `agent-${i}`, userId: `u${i}`, lastRunAt: TEN_DAYS_AGO() });
  }
  const response = await invoke(
    createRequest({ method: "GET", headers: { authorization: "Bearer test-cron-secret" } })
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.processed, 20);
  assert.equal(response.body.skipped, 5);
  assert.equal(runnerCalls.length, 20);
});

test("one failing run is reported in errors without failing the dispatch", async (t) => {
  if (!requireSetup(t)) return;
  seedScheduledAgent({ id: "agent-ok", userId: "u1", lastRunAt: TEN_DAYS_AGO() });
  seedScheduledAgent({ id: "agent-broken", userId: "u2", lastRunAt: TEN_DAYS_AGO() });
  runnerBehavior = (args) => {
    if (args.agentConfigId === "agent-broken") throw new Error("runner exploded");
    return { status: "SUCCEEDED" };
  };

  const response = await invoke(
    createRequest({ method: "GET", headers: { authorization: "Bearer test-cron-secret" } })
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.processed, 1);
  assert.equal(response.body.errors.length, 1);
  assert.match(response.body.errors[0], /agent-broken/);
  assert.match(response.body.errors[0], /runner exploded/);
  // Digest refresh only for users whose runs succeeded.
  assert.deepEqual(digestCalls, ["u1"]);
});

test("failed (non-throwing) runs do not trigger a digest refresh", async (t) => {
  if (!requireSetup(t)) return;
  seedScheduledAgent({ id: "agent-1", userId: "u1", lastRunAt: TEN_DAYS_AGO() });
  runnerBehavior = () => ({ status: "FAILED" });

  const response = await invoke(
    createRequest({ method: "GET", headers: { authorization: "Bearer test-cron-secret" } })
  );
  assert.equal(response.body.processed, 1);
  assert.deepEqual(digestCalls, []);
});
