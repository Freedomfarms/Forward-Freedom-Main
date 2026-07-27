import test, { before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// Freedom Brain vertical slice: plain-text reasoning loop (no JSON envelope),
// tool calling through allowlisted server ops, and async memory extraction
// via the BrainJob queue. All model calls are mocked.
//
// Requires: node --test --experimental-test-module-mocks (npm test).

let setupError = null;
let brainTurn;
let isBrainChatEnabled;
let processBrainJob;
let sweepPendingBrainJobs;
let BRAIN_SYSTEM_PROMPT;
let setLlmImplementationForTesting;
let createFakeDb;
let envelope;

let currentDb;
let llmCalls;

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
    ({ createFakeDb } = await import("./helpers/fakeAgentDb.js"));
    envelope = await import("../server/security/envelope.js");
    ({ brainTurn, isBrainChatEnabled } = await import("../server/brain/index.js"));
    ({ processBrainJob, sweepPendingBrainJobs } = await import("../server/brain/jobs.js"));
    ({ BRAIN_SYSTEM_PROMPT } = await import("../server/brain/prompts.js"));
    ({ setLlmImplementationForTesting } = await import("../server/agents/llm.js"));
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

function seedDb({ profile = null } = {}) {
  currentDb = createFakeDb({
    user: [{ id: USER_ID, email: "user@example.com", timezone: "America/Chicago" }],
    ceoAgentConfig: [
      {
        id: "ceo-1",
        userId: USER_ID,
        name: "CEO Agent",
        personalityPreset: "DIRECT_EFFICIENT",
        model: "claude-sonnet-4-5",
        defaultSubAgentModel: "claude-sonnet-4-5",
        ...(profile ? { profileCiphertext: envelope.encryptJson(profile) } : {}),
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
        updatedAt: new Date("2026-07-20T00:00:00Z"),
      },
    ],
  });
  llmCalls = [];
}

function installLlm({ generateText, generateObject } = {}) {
  setLlmImplementationForTesting({
    generateText: async (options) => {
      llmCalls.push({ method: "generateText", options });
      if (generateText) return generateText(options);
      return { text: "(default reply)", usage: {} };
    },
    generateObject: async (options) => {
      llmCalls.push({ method: "generateObject", options });
      if (generateObject) return generateObject(options);
      return { object: { ops: [] }, usage: {} };
    },
  });
}

beforeEach(() => {
  if (setupError) return;
  process.env.ANTHROPIC_API_KEY = "test-key";
  seedDb();
  installLlm();
});

test("isBrainChatEnabled defaults ON; opt out with 0/false", (t) => {
  if (!requireSetup(t)) return;
  const original = process.env.FREEDOM_BRAIN_CHAT;
  try {
    delete process.env.FREEDOM_BRAIN_CHAT;
    assert.equal(isBrainChatEnabled(), true);
    process.env.FREEDOM_BRAIN_CHAT = "0";
    assert.equal(isBrainChatEnabled(), false);
    process.env.FREEDOM_BRAIN_CHAT = "false";
    assert.equal(isBrainChatEnabled(), false);
    process.env.FREEDOM_BRAIN_CHAT = "1";
    assert.equal(isBrainChatEnabled(), true);
    process.env.FREEDOM_BRAIN_CHAT = "true";
    assert.equal(isBrainChatEnabled(), true);
  } finally {
    if (original === undefined) delete process.env.FREEDOM_BRAIN_CHAT;
    else process.env.FREEDOM_BRAIN_CHAT = original;
  }
});

test("brain turn: plain-text reply, no JSON envelope, tools offered, extraction queued", async (t) => {
  if (!requireSetup(t)) return;
  installLlm({
    generateText: async () => ({ text: "You have two agents on the team.", usage: {} }),
  });

  const outcome = await brainTurn({
    userId: USER_ID,
    ceoAgentConfigId: "ceo-1",
    conversationId: "ceo-convo-1",
    message: "Which agents do I have?",
  });

  assert.equal(outcome.reply, "You have two agents on the team.");
  assert.equal(outcome.conversationId, "ceo-convo-1");
  assert.ok(outcome.messageId);

  // The conversational call is free text: no output schema, no envelope.
  const textCall = llmCalls.find((call) => call.method === "generateText");
  assert.ok(textCall, "expected a generateText call");
  assert.equal(textCall.options.output, undefined);
  assert.equal(textCall.options.schema, undefined);
  assert.equal(textCall.options.system, BRAIN_SYSTEM_PROMPT);

  // Platform operations are tools, available mid-turn.
  for (const name of [
    "create_agent",
    "update_agent",
    "run_agent",
    "delete_agent",
    "set_timezone",
    "update_digest",
  ]) {
    assert.ok(textCall.options.tools?.[name], `expected tool ${name}`);
  }

  // Both sides of the exchange persisted encrypted.
  const messages = currentDb.tables.agentChatMessage;
  assert.equal(messages.length, 2);
  assert.equal(envelope.decrypt(messages[0].contentCiphertext), "Which agents do I have?");
  assert.equal(
    envelope.decrypt(messages[1].contentCiphertext),
    "You have two agents on the team."
  );

  // Memory extraction was queued as a BrainJob — never done inline.
  const jobs = currentDb.tables.brainJob;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, "memory_extraction");
  assert.equal(jobs[0].payload.conversationId, "ceo-convo-1");
});

test("brain turn: update_digest tool executes during the turn and surfaces the digest", async (t) => {
  if (!requireSetup(t)) return;
  installLlm({
    generateText: async (options) => {
      const result = await options.tools.update_digest.execute({
        type: "set_content",
        content: "Markets were quiet today.",
      });
      assert.equal(result.ok, true);
      return { text: "Done — your digest now covers today's markets.", usage: {} };
    },
  });

  const outcome = await brainTurn({
    userId: USER_ID,
    ceoAgentConfigId: "ceo-1",
    conversationId: "ceo-convo-1",
    message: "Replace my digest with a markets note.",
  });

  assert.equal(outcome.reply, "Done — your digest now covers today's markets.");
  assert.equal(outcome.digest.digest, "Markets were quiet today.");
  assert.equal(outcome.digest.refreshed, true);

  const ceoRow = currentDb.tables.ceoAgentConfig[0];
  assert.equal(envelope.decrypt(ceoRow.lastDigestCiphertext), "Markets were quiet today.");
});

test("brain turn: create_agent tool creates a real agent; empty reply falls back to confirmations without retry", async (t) => {
  if (!requireSetup(t)) return;
  installLlm({
    generateText: async (options) => {
      const result = await options.tools.create_agent.execute({
        agentType: "research",
        name: "Fed Watcher",
        instructions: "Track Federal Reserve announcements.",
        definitionOfDone: "A concise Fed summary.",
      });
      assert.equal(result.ok, true);
      assert.ok(result.agent?.id);
      // Model returns empty text after acting — the Brain must NOT retry
      // (that would duplicate the side effect) and must fall back to the
      // authoritative server confirmation.
      return { text: "", usage: {} };
    },
  });

  const outcome = await brainTurn({
    userId: USER_ID,
    ceoAgentConfigId: "ceo-1",
    conversationId: "ceo-convo-1",
    message: "Create a research agent that tracks the Fed.",
  });

  // Count only Brain reasoning-loop calls (the async conversation-title call
  // uses a different system prompt and may also land in llmCalls).
  const brainCalls = llmCalls.filter(
    (call) => call.method === "generateText" && call.options.system === BRAIN_SYSTEM_PROMPT
  );
  assert.equal(brainCalls.length, 1, "must not retry after side effects");

  assert.match(outcome.reply, /Created "Fed Watcher"/);
  assert.equal(outcome.agent?.name, "Fed Watcher");

  const agents = currentDb.tables.agentConfig;
  assert.equal(agents.length, 1);
  assert.equal(agents[0].agentType, "research");
});

test("brain turn: tool errors come back as results the model can report, not turn failures", async (t) => {
  if (!requireSetup(t)) return;
  installLlm({
    generateText: async (options) => {
      const result = await options.tools.run_agent.execute({ agentId: "missing-agent" });
      assert.equal(result.ok, false);
      assert.match(result.error, /not found/i);
      return { text: "I couldn't find that agent — want me to list your team?", usage: {} };
    },
  });

  const outcome = await brainTurn({
    userId: USER_ID,
    ceoAgentConfigId: "ceo-1",
    conversationId: "ceo-convo-1",
    message: "Run the marketing agent.",
  });
  assert.match(outcome.reply, /couldn't find that agent/);
});

test("memory extraction job applies profile ops asynchronously", async (t) => {
  if (!requireSetup(t)) return;
  seedDb({ profile: { categories: {}, tombstones: [] } });
  currentDb.tables.agentChatMessage.push(
    {
      id: "m-1",
      userId: USER_ID,
      conversationId: "ceo-convo-1",
      ceoAgentConfigId: "ceo-1",
      role: "USER",
      contentCiphertext: envelope.encrypt("I want to buy a lake cabin within five years."),
      createdAt: new Date("2026-07-25T00:00:00Z"),
    },
    {
      id: "m-2",
      userId: USER_ID,
      conversationId: "ceo-convo-1",
      ceoAgentConfigId: "ceo-1",
      role: "AGENT",
      contentCiphertext: envelope.encrypt("Noted — that's a great goal."),
      createdAt: new Date("2026-07-25T00:00:01Z"),
    }
  );
  currentDb.tables.brainJob.push({
    id: "job-1",
    userId: USER_ID,
    kind: "memory_extraction",
    payload: { conversationId: "ceo-convo-1" },
    status: "PENDING",
    attempts: 0,
    runAfter: new Date(Date.now() - 1000),
    lockedAt: null,
    createdAt: new Date(),
  });
  installLlm({
    generateObject: async (options) => {
      assert.match(options.prompt, /lake cabin/);
      return {
        object: {
          ops: [{ op: "add", category: "financialGoals", text: "Wants to buy a lake cabin within five years" }],
        },
        usage: {},
      };
    },
  });

  const outcome = await processBrainJob({ userId: USER_ID, jobId: "job-1" });
  assert.equal(outcome, "completed");

  const job = currentDb.tables.brainJob[0];
  assert.equal(job.status, "COMPLETED");
  assert.ok(job.completedAt);

  const profile = envelope.decryptJson(currentDb.tables.ceoAgentConfig[0].profileCiphertext);
  assert.equal(profile.categories.financialGoals.length, 1);
  assert.match(profile.categories.financialGoals[0].text, /lake cabin/);
  assert.equal(profile.categories.financialGoals[0].source, "brain_chat");
});

test("brain jobs retry with backoff and fail closed after max attempts", async (t) => {
  if (!requireSetup(t)) return;
  currentDb.tables.agentChatMessage.push({
    id: "m-1",
    userId: USER_ID,
    conversationId: "ceo-convo-1",
    ceoAgentConfigId: "ceo-1",
    role: "USER",
    contentCiphertext: envelope.encrypt("hello"),
    createdAt: new Date(),
  });
  const seedJob = (id, attempts) => ({
    id,
    userId: USER_ID,
    kind: "memory_extraction",
    payload: { conversationId: "ceo-convo-1" },
    status: "PENDING",
    attempts,
    runAfter: new Date(Date.now() - 1000),
    lockedAt: null,
    createdAt: new Date(),
  });
  currentDb.tables.brainJob.push(seedJob("job-retry", 0), seedJob("job-exhausted", 2));
  installLlm({
    generateObject: async () => {
      throw new Error("extraction model unavailable");
    },
  });

  assert.equal(await processBrainJob({ userId: USER_ID, jobId: "job-retry" }), "retrying");
  const retried = currentDb.tables.brainJob.find((job) => job.id === "job-retry");
  assert.equal(retried.status, "PENDING");
  assert.equal(retried.attempts, 1);
  assert.match(retried.lastError, /unavailable/);
  assert.ok(retried.runAfter > new Date(), "backoff pushes runAfter into the future");

  assert.equal(await processBrainJob({ userId: USER_ID, jobId: "job-exhausted" }), "failed");
  const failed = currentDb.tables.brainJob.find((job) => job.id === "job-exhausted");
  assert.equal(failed.status, "FAILED");

  // A claimed/backed-off job is not claimable again right now.
  assert.equal(await processBrainJob({ userId: USER_ID, jobId: "job-retry" }), "skipped");
});

test("cron sweep processes due jobs and requeues stale RUNNING jobs", async (t) => {
  if (!requireSetup(t)) return;
  const past = new Date(Date.now() - 60_000);
  currentDb.tables.brainJob.push(
    {
      id: "job-due",
      userId: USER_ID,
      kind: "memory_extraction",
      payload: { conversationId: "ceo-convo-1" },
      status: "PENDING",
      attempts: 0,
      runAfter: past,
      lockedAt: null,
      createdAt: past,
    },
    {
      id: "job-stale",
      userId: USER_ID,
      kind: "memory_extraction",
      payload: { conversationId: "ceo-convo-1" },
      status: "RUNNING",
      attempts: 1,
      runAfter: past,
      lockedAt: new Date(Date.now() - 20 * 60 * 1000),
      createdAt: past,
    },
    {
      id: "job-active",
      userId: USER_ID,
      kind: "memory_extraction",
      payload: { conversationId: "ceo-convo-1" },
      status: "RUNNING",
      attempts: 1,
      runAfter: past,
      lockedAt: new Date(),
      createdAt: past,
    }
  );

  // Conversation has no messages → the extraction handler no-ops cleanly.
  const summary = await sweepPendingBrainJobs(currentDb.tx, { limit: 10 });
  assert.equal(summary.requeuedStale, 1);
  assert.equal(summary.processed, 2, "due + requeued-stale jobs both processed");
  assert.equal(summary.failed, 0);

  assert.equal(
    currentDb.tables.brainJob.find((job) => job.id === "job-due").status,
    "COMPLETED"
  );
  assert.equal(
    currentDb.tables.brainJob.find((job) => job.id === "job-stale").status,
    "COMPLETED"
  );
  assert.equal(
    currentDb.tables.brainJob.find((job) => job.id === "job-active").status,
    "RUNNING"
  );
});
