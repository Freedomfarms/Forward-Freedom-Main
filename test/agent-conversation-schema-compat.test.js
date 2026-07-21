import test, { before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// Proves CEO / agent chat keeps working when AgentConversation (and the
// conversationId column) are missing — the production failure mode when
// migrate deploy lags behind the multi-chat code deploy (Prisma P2021).

let setupError = null;
let createFakeDb;
let ensureDefaultConversation;
let listConversations;
let createConversation;
let listChatHistory;
let isMissingAgentConversationError;
let LEGACY_SINGLE_THREAD_ID;
let envelope;

let currentDb;

const USER_ID = "user-compat";

function missingTableError() {
  const error = new Error(
    "Invalid `prisma.agentConversation.findFirst()` invocation:\n\nThe table `public.AgentConversation` does not exist in the current database."
  );
  error.code = "P2021";
  return error;
}

before(async () => {
  process.env.FFF_ENCRYPTION_KEYS = `1:${crypto.randomBytes(32).toString("base64")}`;
  process.env.FFF_ENCRYPTION_ACTIVE_VERSION = "1";
  const { resetKeyProviderCache } = await import("../server/security/keyProvider.js");
  resetKeyProviderCache();

  try {
    mock.module("../server/db/prisma.js", {
      namedExports: {
        withUserContext: async (userId, fn) => fn(currentDb.tx),
      },
    });
    ({ createFakeDb } = await import("./helpers/fakeAgentDb.js"));
    ({
      ensureDefaultConversation,
      listConversations,
      createConversation,
      isMissingAgentConversationError,
      LEGACY_SINGLE_THREAD_ID,
    } = await import("../server/agents/conversations.js"));
    ({ listChatHistory } = await import("../server/agents/chatHistory.js"));
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

function installMissingConversationTable() {
  const original = currentDb.tx.agentConversation;
  currentDb.tx.agentConversation = new Proxy(original, {
    get(_target, prop) {
      if (typeof original[prop] === "function") {
        return async () => {
          throw missingTableError();
        };
      }
      return original[prop];
    },
  });
}

beforeEach(() => {
  if (setupError) return;
  currentDb = createFakeDb({
    user: [{ id: USER_ID, email: "user@example.com" }],
    ceoAgentConfig: [
      {
        id: "ceo-1",
        userId: USER_ID,
        name: "CEO Agent",
        personalityPreset: "DIRECT_EFFICIENT",
      },
    ],
    agentChatMessage: [
      {
        id: "msg-1",
        userId: USER_ID,
        agentConfigId: null,
        ceoAgentConfigId: "ceo-1",
        role: "USER",
        contentCiphertext: envelope.encrypt("hello from before multi-chat"),
        createdAt: new Date("2026-07-12T00:00:00Z"),
      },
      {
        id: "msg-2",
        userId: USER_ID,
        agentConfigId: null,
        ceoAgentConfigId: "ceo-1",
        role: "AGENT",
        contentCiphertext: envelope.encrypt("hi — legacy thread reply"),
        createdAt: new Date("2026-07-12T00:01:00Z"),
      },
    ],
  });
});

test("isMissingAgentConversationError detects Prisma P2021 for AgentConversation", () => {
  assert.equal(isMissingAgentConversationError(missingTableError()), true);
  assert.equal(
    isMissingAgentConversationError({
      code: "P2022",
      message: "The column `AgentChatMessage.conversationId` does not exist in the current database.",
    }),
    true
  );
  assert.equal(
    isMissingAgentConversationError({ code: "P2021", message: "The table `User` does not exist" }),
    false
  );
});

test("ensureDefaultConversation returns legacy sentinel when table is missing", async (t) => {
  if (!requireSetup(t)) return;
  installMissingConversationTable();
  const row = await ensureDefaultConversation(currentDb.tx, {
    userId: USER_ID,
    ceoAgentConfigId: "ceo-1",
  });
  assert.equal(row.id, LEGACY_SINGLE_THREAD_ID);
});

test("listConversations returns a synthetic Original thread when table is missing", async (t) => {
  if (!requireSetup(t)) return;
  installMissingConversationTable();
  const result = await listConversations({
    userId: USER_ID,
    ceoAgentConfigId: "ceo-1",
  });
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].id, LEGACY_SINGLE_THREAD_ID);
  assert.equal(result.conversations[0].title, "Original thread");
  assert.equal(result.hasMore, false);
});

test("createConversation returns the synthetic thread when table is missing", async (t) => {
  if (!requireSetup(t)) return;
  installMissingConversationTable();
  const conversation = await createConversation({
    userId: USER_ID,
    ceoAgentConfigId: "ceo-1",
  });
  assert.equal(conversation.id, LEGACY_SINGLE_THREAD_ID);
});

test("listChatHistory loads agent-scoped messages when AgentConversation is missing", async (t) => {
  if (!requireSetup(t)) return;
  installMissingConversationTable();
  const messages = await listChatHistory({
    userId: USER_ID,
    ceoAgentConfigId: "ceo-1",
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, "hello from before multi-chat");
  assert.equal(messages[1].text, "hi — legacy thread reply");
});
