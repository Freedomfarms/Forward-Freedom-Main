import test, { before, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// Requires: node --test --experimental-test-module-mocks (npm test).

let setupError = null;
let createFakeDb;
let envelope;
let announceAgentCreatedToCeoChat;
let renderTeamRoster;
let renderNamedRunSummaries;

before(async () => {
  process.env.FFF_ENCRYPTION_KEYS = `1:${crypto.randomBytes(32).toString("base64")}`;
  process.env.FFF_ENCRYPTION_ACTIVE_VERSION = "1";
  const { resetKeyProviderCache } = await import("../server/security/keyProvider.js");
  resetKeyProviderCache();

  try {
    mock.module("../server/db/prisma.js", {
      namedExports: {
        withUserContext: async (_userId, fn) => fn({}),
        getPrismaClient: () => null,
        isDatabaseConfigured: () => false,
        Prisma: {},
      },
    });
    ({ createFakeDb } = await import("./helpers/fakeAgentDb.js"));
    envelope = await import("../server/security/envelope.js");
    ({
      announceAgentCreatedToCeoChat,
      renderTeamRoster,
      renderNamedRunSummaries,
    } = await import("../server/agents/teamContext.js"));
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

test("announceAgentCreatedToCeoChat posts into the main non-system CEO thread", async (t) => {
  if (!requireSetup(t)) return;

  const db = createFakeDb({
    user: [{ id: "user-1", email: "user@example.com" }],
    ceoAgentConfig: [{ id: "ceo-1", userId: "user-1", name: "Harry" }],
    agentConversation: [
      {
        id: "conv-system",
        userId: "user-1",
        agentConfigId: null,
        ceoAgentConfigId: "ceo-1",
        title: "Create agent",
        isSystem: true,
        archivedAt: null,
        createdAt: new Date("2026-07-24T00:00:00Z"),
        updatedAt: new Date("2026-07-24T00:00:00Z"),
      },
      {
        id: "conv-main",
        userId: "user-1",
        agentConfigId: null,
        ceoAgentConfigId: "ceo-1",
        title: "Original thread",
        isSystem: false,
        archivedAt: null,
        createdAt: new Date("2026-07-23T00:00:00Z"),
        updatedAt: new Date("2026-07-23T00:00:00Z"),
      },
    ],
    agentChatMessage: [],
  });

  const result = await announceAgentCreatedToCeoChat(db.tx, {
    userId: "user-1",
    ceoAgentConfigId: "ceo-1",
    agent: {
      id: "agent-fed",
      name: "Federal Reserve Data Agent",
      agentType: "research",
      status: "ACTIVE",
      schedule: null,
      definitionOfDone: "Summarize the latest FOMC statement.",
    },
  });

  assert.equal(result.conversationId, "conv-main");
  assert.equal(db.tables.agentChatMessage.length, 1);
  assert.equal(db.tables.agentChatMessage[0].conversationId, "conv-main");
  assert.equal(db.tables.agentChatMessage[0].role, "AGENT");
  const note = envelope.decrypt(db.tables.agentChatMessage[0].contentCiphertext);
  assert.match(note, /Federal Reserve Data Agent/);
  assert.match(note, /FOMC/);
  assert.match(note, /no completed runs yet/i);
});

test("empty roster is explicit so the CEO cannot invent teammates", (t) => {
  if (!requireSetup(t)) return;
  assert.match(renderTeamRoster([]), /no sub-agents yet/i);
});

test("renderNamedRunSummaries prefers agent names over bare agentType", (t) => {
  if (!requireSetup(t)) return;
  const text = renderNamedRunSummaries(
    [
      {
        id: "run-1",
        agentConfigId: "a1",
        agentType: "research",
        summary: "Rates held steady.",
        startedAt: new Date("2026-07-20T00:00:00Z"),
      },
    ],
    [{ id: "a1", name: "Federal Reserve Data Agent" }]
  );
  assert.match(text, /Federal Reserve Data Agent, research/);
  assert.match(text, /Rates held steady/);
});
