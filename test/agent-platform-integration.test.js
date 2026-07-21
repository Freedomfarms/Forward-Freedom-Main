import test, { before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

import { createRequest, createResponse } from "./helpers/httpMocks.js";

// End-to-end integration across the Phase 5 handlers and the REAL Phase 4
// agent core (runner, digest, profile extraction): create the CEO config,
// create a finance agent, run it manually, and see its summary flow into the
// CEO digest. Only the database (in-memory fake), auth, rate limiting and
// the model call itself are mocked — no real Anthropic API is ever reached.
//
// Requires: node --test --experimental-test-module-mocks (npm test).

let setupError = null;
let handlers = {};
let createFakeDb;
let setLlmImplementationForTesting;
let envelope;

let currentDb;
let llmCalls;

const RUN_SUMMARY = "Dining spend is 40% above your 3-month average.";
const DIGEST_TEXT = "Your finance agent flagged elevated dining spend this week.";

class FakeAuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
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
        readBearerToken: () => null,
        authenticateRequest: async (request) => {
          const match = /^Bearer\s+(.+)$/.exec(String(request?.headers?.authorization || ""));
          if (!match) throw new FakeAuthError("Missing bearer token.", 401);
          return { uid: match[1], email: `${match[1]}@example.com`, email_verified: true };
        },
        authenticateVerifiedRequest: async () => {
          throw new FakeAuthError("not used", 401);
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

    ({ createFakeDb } = await import("./helpers/fakeAgentDb.js"));
    ({ setLlmImplementationForTesting } = await import("../server/agents/llm.js"));
    envelope = await import("../server/security/envelope.js");

    handlers = {
      ceo: (await import("../api/agents/ceo.js")).default,
      agents: (await import("../api/agents.js")).default,
      agentRun: (await import("../api/agents/[id]/run.js")).default,
      ceoDigest: (await import("../api/agents/ceo/digest.js")).default,
    };
  } catch (error) {
    setupError = error;
  }
});

beforeEach(() => {
  if (setupError) return;
  llmCalls = [];
  currentDb = createFakeDb({ user: [{ id: "u1", email: "u1@example.com" }] });
  setLlmImplementationForTesting({
    generateObject: async (options) => {
      llmCalls.push({ kind: "object", options });
      if (options.model === "claude-haiku-4-5") {
        // Profile extraction pass — nothing durable revealed.
        return { object: { ops: [] }, usage: { inputTokens: 10, outputTokens: 5 } };
      }
      return {
        object: { report: "Full mock insights report.", summary: RUN_SUMMARY },
        usage: { inputTokens: 1000, outputTokens: 200 },
      };
    },
    generateText: async (options) => {
      llmCalls.push({ kind: "text", options });
      return { text: DIGEST_TEXT, usage: { inputTokens: 500, outputTokens: 100 } };
    },
  });
});

function requireSetup(t) {
  if (setupError) {
    t.skip(`requires --experimental-test-module-mocks (${setupError.message})`);
    return false;
  }
  return true;
}

async function invoke(handler, options) {
  const response = createResponse();
  await handler(
    createRequest({ ...options, headers: { authorization: "Bearer u1", ...(options.headers || {}) } }),
    response
  );
  return response;
}

test("CEO config → finance agent → manual run → digest includes the run's findings", async (t) => {
  if (!requireSetup(t)) return;

  // 1. First visit auto-creates the CEO config.
  const ceo = await invoke(handlers.ceo, { method: "GET" });
  assert.equal(ceo.statusCode, 200);
  assert.equal(ceo.body.ceoAgent.name, "CEO Agent");

  // 2. Create a finance agent.
  const created = await invoke(handlers.agents, {
    method: "POST",
    body: {
      agentType: "finance",
      name: "Spending Watcher",
      instructions: "Watch my spending trends.",
      definitionOfDone: "A weekly spending observations report.",
      schedulePreset: "daily",
    },
  });
  assert.equal(created.statusCode, 201);
  const agentId = created.body.agent.id;
  assert.equal(created.body.agent.permissionLevel, "READ_ONLY");

  // 3. Manual run through the REAL runner (LLM mocked).
  const run = await invoke(handlers.agentRun, { method: "POST", params: { id: agentId } });
  assert.equal(run.statusCode, 200);
  assert.equal(run.body.run.status, "SUCCEEDED");
  assert.equal(run.body.run.summary, RUN_SUMMARY);
  // The stored output is encrypted at rest and never in the list payload.
  const runRow = currentDb.tables.agentRun.find((row) => row.id === run.body.run.id);
  assert.ok(runRow.outputCiphertext);
  assert.equal(envelope.decrypt(runRow.outputCiphertext), "Full mock insights report.");
  assert.equal("output" in run.body.run, false);

  // 4. The digest (REAL generateDigest) is built from the run summary.
  const digest = await invoke(handlers.ceoDigest, { method: "POST" });
  assert.equal(digest.statusCode, 200);
  assert.equal(digest.body.digest, DIGEST_TEXT);
  assert.equal(digest.body.refreshed, true);

  const digestCall = llmCalls.find((call) => call.kind === "text");
  assert.ok(digestCall, "digest made a text model call");
  assert.ok(
    digestCall.options.prompt.includes(RUN_SUMMARY),
    "the run summary was included in the digest prompt"
  );

  // The digest is cached encrypted on the CEO config...
  const ceoRow = currentDb.tables.ceoAgentConfig[0];
  assert.ok(ceoRow.lastDigestAt);
  assert.equal(envelope.decrypt(ceoRow.lastDigestCiphertext), DIGEST_TEXT);

  // ...and a follow-up GET serves the cache without another model call.
  const callsBefore = llmCalls.length;
  const cached = await invoke(handlers.ceoDigest, { method: "GET" });
  assert.equal(cached.body.digest, DIGEST_TEXT);
  assert.equal(cached.body.refreshed, false);
  assert.equal(llmCalls.length, callsBefore);
});
