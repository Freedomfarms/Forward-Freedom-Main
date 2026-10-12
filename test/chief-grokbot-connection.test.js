// Grok Bot connectivity is the workforce journal, not the xAI model API.
// These tests do not call api.x.ai or create a bot task.

import test from "node:test";
import assert from "node:assert/strict";

import { assertReadRuntime, createAgentRuntime } from "../server/chief/agents/index.js";
import { probeGrokBotConnection } from "../server/chief/agents/grokbotConnection.js";
import { getPrismaClient } from "../server/db/prisma.js";

const NOW = new Date("2026-10-12T18:00:00.000Z");
const MODEL_KEY = "xai-model-key-must-stay-hidden";

function decrypt(value) {
  if (typeof value !== "string" || !value.startsWith("sealed:")) {
    throw new Error("sealed text required");
  }
  return value.slice("sealed:".length);
}

function journalRuntime(seed, options = {}) {
  const bindings = new Map(seed.bindings ?? []);
  const agents = [...(seed.agents ?? [])];
  const events = [...(seed.events ?? [])];
  return createAgentRuntime({
    provider: "grokbot",
    now: () => NOW,
    decrypt: options.decrypt ?? decrypt,
    withUser:
      options.withUser ??
      (async (_userId, fn) =>
        fn({
          workforceBinding: {
            async findUnique({ where }) {
              return bindings.get(where.userId) ?? null;
            },
          },
          observedAgent: {
            async findMany({ where }) {
              return agents.filter((row) => row.userId === where.userId);
            },
          },
          activityEvent: {
            async findMany(args = {}) {
              let rows = events.filter((row) => row.userId === args.where?.userId);
              if (args.where?.agentExternalId) {
                rows = rows.filter((row) => row.agentExternalId === args.where.agentExternalId);
              }
              if (args.distinct?.includes("source")) {
                const seen = new Set();
                rows = rows.filter((row) => {
                  if (seen.has(row.source)) return false;
                  seen.add(row.source);
                  return true;
                });
              }
              return rows;
            },
          },
        })),
  });
}

const observed = {
  bindings: [["user-a", { userId: "user-a", status: "ACTIVE", reportKeyHash: "hash-hidden" }]],
  agents: [
    {
      userId: "user-a",
      externalId: "bot-1",
      displayName: "North",
      role: "inspector",
      identityTrust: "UNTRUSTED",
      lastEventAt: new Date("2026-10-12T17:50:00.000Z"),
      lastTurnId: "turn-9",
    },
  ],
  events: [
    {
      id: "evt-1",
      userId: "user-a",
      source: "SELF_REPORT",
      trust: "UNTRUSTED",
      kind: "freedom.report.finding",
      occurredAt: new Date("2026-10-12T17:50:00.000Z"),
      agentExternalId: "bot-1",
      turnId: "turn-9",
      sequence: 1,
      coded: { outcome: "completed" },
      textCiphertext: "sealed:The north well is clear.",
    },
  ],
};

test("a journal read discovers an agent and does not authenticate a Grok Bot service", async () => {
  const runtime = assertReadRuntime(journalRuntime(observed));
  const calls = [];
  runtime.submit = undefined;
  const report = await probeGrokBotConnection({
    runtime,
    userId: "user-a",
    agentId: "bot-1",
    env: { XAI_API_KEY: MODEL_KEY, CURSOR_API_KEY: "cursor-cloud-key" },
    now: NOW,
  });
  calls.push("probed");
  assert.equal(report.product, "Grok Bot");
  assert.equal(report.mechanism, "workforce-journal");
  assert.equal(report.serviceApi, false);
  assert.equal(report.serviceAuthenticated, false);
  assert.equal(report.serviceReachable, false);
  assert.equal(report.xaiModelKeyPresent, true);
  assert.equal(report.xaiAuthorizesGrokBot, false);
  assert.equal(report.cursorApiKeyPresent, true);
  assert.equal(report.cursorApiAuthorizesGrokBot, false);
  assert.equal(report.platformTelemetry, "not_configured");
  assert.equal(report.selfReportIngress, "implemented");
  assert.equal(report.platformIngress, "not_configured");
  assert.equal(report.readOnly, true);
  assert.equal(report.canSubmit, false);
  assert.equal(report.journal, "read");
  assert.equal(report.observedAgents, 1);
  assert.equal(report.agents[0].id, "bot-1");
  assert.equal(report.agents[0].displayName, "North");
  assert.equal(report.agents[0].liveness, "active");
  assert.equal(report.agent.id, "bot-1");
  assert.equal(report.agent.recent[0].text, "The north well is clear.");
  assert.equal(report.agent.recent[0].outcome, "completed");
  assert.equal(report.failure, null);
  assert.equal(JSON.stringify(report).includes(MODEL_KEY), false);
  assert.equal(JSON.stringify(report).includes("cursor-cloud-key"), false);
  assert.equal(JSON.stringify(report).includes("hash-hidden"), false);
  assert.equal(calls.length, 1);

  const listed = await runtime.listAgents("user-a");
  assert.deepEqual(
    listed.map((agent) => agent.id),
    ["bot-1"]
  );
  const events = await runtime.listEvents("user-a");
  assert.equal(events[0].kind, "freedom.report.finding");
  assert.equal(runtime.submit, undefined);
});

test("missing credentials, permission, timeout, and malformed reads stay failures", async () => {
  const absent = await probeGrokBotConnection({ env: {} });
  assert.equal(absent.serviceAuthenticated, false);
  assert.equal(absent.failure.code, "not_configured");
  assert.match(absent.failure.message, /xAI model key does not connect Grok Bot/);

  const unsigned = await probeGrokBotConnection({
    runtime: journalRuntime(observed),
    userId: " ",
    env: { CHIEF_XAI_API_KEY: MODEL_KEY },
  });
  assert.equal(unsigned.failure.code, "unauthenticated");
  assert.equal(unsigned.xaiAuthorizesGrokBot, false);
  assert.equal(JSON.stringify(unsigned).includes(MODEL_KEY), false);

  const denied = journalRuntime(observed, {
    withUser: async () => {
      const error = new Error("row-level security refused the query");
      error.status = 403;
      throw error;
    },
  });
  const permission = await probeGrokBotConnection({
    runtime: denied,
    userId: "user-a",
    env: {},
  });
  assert.equal(permission.journal, "failed");
  assert.equal(permission.failure.code, "permission_denied");
  assert.equal(permission.serviceReachable, false);

  const hung = journalRuntime(observed, {
    withUser: () => new Promise(() => {}),
  });
  const timed = await probeGrokBotConnection({
    runtime: hung,
    userId: "user-a",
    timeoutMs: 20,
    env: {},
  });
  assert.equal(timed.failure.code, "timeout");
  assert.equal(timed.observedAgents, null);

  const broken = journalRuntime(observed, {
    withUser: async () => {
      throw new SyntaxError("Unexpected token in journal response");
    },
  });
  const malformed = await probeGrokBotConnection({
    runtime: broken,
    userId: "user-a",
    env: {},
  });
  assert.equal(malformed.failure.code, "malformed");

  const offline = journalRuntime(observed, {
    withUser: async () => {
      const error = new Error("Database client is not configured.");
      error.status = 503;
      throw error;
    },
  });
  const database = await probeGrokBotConnection({
    runtime: offline,
    userId: "user-a",
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example" },
  });
  assert.equal(database.failure.code, "database_unavailable");
  assert.equal(database.platformTelemetry, "credential_present_unwired");
  assert.equal(database.platformIngress, "not_configured");
  assert.equal(JSON.stringify(database).includes("collector.example"), false);
});

test("unreadable report text is a journal read, and an execution runtime is refused", async () => {
  const runtime = journalRuntime(observed, {
    decrypt() {
      throw new Error("sealed text required");
    },
  });
  const report = await probeGrokBotConnection({
    runtime,
    userId: "user-a",
    env: {},
    now: NOW,
  });
  assert.equal(report.journal, "read");
  assert.equal(report.textUnreadable, true);
  assert.equal(report.serviceAuthenticated, false);
  assert.equal(report.failure, null);

  let submitted = false;
  const execution = {
    provider: "cursor-cloud",
    effects: ["execute"],
    async picture() {
      submitted = true;
      return {};
    },
    async listAgents() {},
    async getAgent() {},
    async submit() {
      submitted = true;
    },
    async getResult() {
      submitted = true;
    },
  };
  const refused = await probeGrokBotConnection({
    runtime: execution,
    userId: "user-a",
    env: {},
  });
  assert.equal(refused.failure.code, "not_read_only");
  assert.equal(refused.readOnly, false);
  assert.equal(submitted, false);
});

test("this process is not authenticated to a Grok Bot service", async () => {
  const report = await probeGrokBotConnection({
    runtime: createAgentRuntime({ provider: "grokbot" }),
    userId: "grokbot-connection-probe",
    env: process.env,
    timeoutMs: 4000,
  });
  assert.equal(report.serviceApi, false);
  assert.equal(report.serviceAuthenticated, false);
  assert.equal(report.serviceReachable, false);
  assert.equal(report.xaiAuthorizesGrokBot, false);
  assert.equal(report.cursorApiAuthorizesGrokBot, false);
  assert.equal(report.canSubmit, false);
  assert.equal(report.platformIngress, "not_configured");
  if (report.journal === "read") {
    assert.equal(report.failure, null);
    assert.equal(typeof report.observedAgents, "number");
  } else {
    assert.equal(report.journal, "failed");
    assert.ok(
      [
        "database_unavailable",
        "unauthenticated",
        "permission_denied",
        "timeout",
        "malformed",
        "connectivity_failed",
      ].includes(report.failure.code)
    );
  }
  const dumped = JSON.stringify(report);
  for (const name of ["XAI_API_KEY", "CHIEF_XAI_API_KEY", "CURSOR_API_KEY", "DATABASE_URL"]) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 4) {
      assert.equal(dumped.includes(value), false, name);
    }
  }
  const prisma = getPrismaClient();
  if (prisma) await prisma.$disconnect();
});
