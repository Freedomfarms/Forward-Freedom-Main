import test, { before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

import { createFakeDb } from "./helpers/fakeAgentDb.js";

// Unit tests for the long-form CEO narrative profile generator.

let createFakeDbFn;
let envelope;
let narrative;
let currentDb;
let llmConfigured = true;
let lastGenerateTextArgs = null;

before(async () => {
  process.env.FFF_ENCRYPTION_KEYS = `1:${crypto.randomBytes(32).toString("base64")}`;
  process.env.FFF_ENCRYPTION_ACTIVE_VERSION = "1";
  process.env.ANTHROPIC_API_KEY = "test-key-never-used";

  const { resetKeyProviderCache } = await import("../server/security/keyProvider.js");
  resetKeyProviderCache();

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

  mock.module("../server/agents/llm.js", {
    namedExports: {
      PROFILE_EXTRACTION_MODEL: "mock-model",
      CEO_AGENT_MODEL: "mock-model",
      setLlmImplementationForTesting: () => {},
      isLlmConfigured: () => llmConfigured,
      getWebSearchTools: () => ({}),
      generateAgentText: async (args) => {
        lastGenerateTextArgs = args;
        return {
          text: [
            "## Who You Are",
            "You are building a calmer financial life with clear priorities and room to breathe.",
            "",
            "## What You're Building",
            "Your goals center on paying down debt and creating a steadier cash cushion.",
            "",
            "## How You Work",
            "You prefer direct updates and practical next steps over long theory.",
            "",
            "## Your Agents",
            "You already have help on finance so you can stay focused on the bigger picture.",
            "",
            "## What's Next",
            "Keep chatting with your CEO Agent and refine the agents you already created.",
            " ".repeat(1),
            Array.from({ length: 280 }, (_, index) => `detail${index}`).join(" "),
          ].join("\n"),
          usage: null,
        };
      },
      generateAgentObject: async () => ({ object: {}, usage: null }),
    },
  });

  createFakeDbFn = createFakeDb;
  envelope = await import("../server/security/envelope.js");
  narrative = await import("../server/agents/narrativeProfile.js");
});

beforeEach(() => {
  llmConfigured = true;
  lastGenerateTextArgs = null;
  currentDb = createFakeDbFn();
  currentDb.tables.ceoAgentConfig.push({
    id: "ceo-1",
    userId: "u1",
    name: "CEO Agent",
    personalityPreset: "DIRECT_EFFICIENT",
    profileCiphertext: null,
    profileUpdatedAt: null,
    narrativeProfileCiphertext: null,
    narrativeProfileAt: null,
  });
});

test("hasAnyNarrativeSourceMaterial requires at least one source", () => {
  assert.equal(
    narrative.hasAnyNarrativeSourceMaterial({
      profileFactCount: 0,
      agentCount: 0,
      chatMessageCount: 0,
    }),
    false
  );
  assert.equal(
    narrative.hasAnyNarrativeSourceMaterial({
      profileFactCount: 2,
      agentCount: 0,
      chatMessageCount: 0,
    }),
    true
  );
  assert.equal(
    narrative.hasAnyNarrativeSourceMaterial({
      profileFactCount: 0,
      agentCount: 1,
      chatMessageCount: 0,
    }),
    true
  );
  assert.equal(
    narrative.hasAnyNarrativeSourceMaterial({
      profileFactCount: 0,
      agentCount: 0,
      chatMessageCount: 3,
    }),
    true
  );
});

test("generateNarrativeProfile returns insufficient message with no source material", async () => {
  const result = await narrative.generateNarrativeProfile("u1");
  assert.equal(result.profile, narrative.INSUFFICIENT_PROFILE_MESSAGE);
  assert.equal(result.insufficient, true);
  assert.equal(lastGenerateTextArgs, null);
  assert.ok(currentDb.tables.ceoAgentConfig[0].narrativeProfileCiphertext);
  assert.equal(
    envelope.decrypt(currentDb.tables.ceoAgentConfig[0].narrativeProfileCiphertext),
    narrative.INSUFFICIENT_PROFILE_MESSAGE
  );
});

test("generateNarrativeProfile uses profile facts, agents, and chat in the prompt", async () => {
  currentDb.tables.ceoAgentConfig[0].profileCiphertext = envelope.encryptJson({
    categories: {
      financialGoals: [
        {
          id: "g1",
          text: "Build a six-month reserve",
          source: "onboarding",
          addedAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
      ],
      knownAccountsRelationships: [],
      statedPreferences: [
        {
          id: "p1",
          text: "Keep updates short",
          source: "onboarding",
          addedAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
      ],
      recurringConcerns: [],
      lifeContext: [
        {
          id: "l1",
          text: "Growing a small farm business",
          source: "onboarding",
          addedAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
      ],
    },
    tombstones: [],
  });

  currentDb.tables.agentConfig.push({
    id: "agent-1",
    userId: "u1",
    ceoAgentConfigId: "ceo-1",
    agentType: "finance",
    name: "Cash Watch",
    instructions: "Watch cash and runway.",
    definitionOfDone: "Weekly cash summary",
    status: "ACTIVE",
    createdAt: new Date("2026-07-01T00:00:00Z"),
  });

  currentDb.tables.agentConversation.push({
    id: "conv-1",
    userId: "u1",
    ceoAgentConfigId: "ceo-1",
    agentConfigId: null,
    isSystem: false,
    title: "Planning",
    createdAt: new Date("2026-07-10T00:00:00Z"),
    updatedAt: new Date("2026-07-10T00:00:00Z"),
  });

  currentDb.tables.agentChatMessage.push(
    {
      id: "m1",
      userId: "u1",
      ceoAgentConfigId: "ceo-1",
      agentConfigId: null,
      conversationId: "conv-1",
      role: "USER",
      contentCiphertext: envelope.encrypt("I want to grow the farm without taking on more debt."),
      createdAt: new Date("2026-07-10T01:00:00Z"),
    },
    {
      id: "m2",
      userId: "u1",
      ceoAgentConfigId: "ceo-1",
      agentConfigId: null,
      conversationId: "conv-1",
      role: "AGENT",
      contentCiphertext: envelope.encrypt("Got it — I'll keep debt caution front and center."),
      createdAt: new Date("2026-07-10T01:01:00Z"),
    }
  );

  const result = await narrative.generateNarrativeProfile("u1");
  assert.equal(result.insufficient, false);
  assert.ok(result.wordCount >= 300);
  assert.ok(lastGenerateTextArgs);
  assert.match(String(lastGenerateTextArgs.prompt || ""), /Build a six-month reserve/);
  assert.match(String(lastGenerateTextArgs.prompt || ""), /Cash Watch/);
  assert.match(String(lastGenerateTextArgs.prompt || ""), /grow the farm without taking on more debt/);
  assert.match(String(result.profile || ""), /Who You Are|What You're Building/i);

  const cached = await narrative.readNarrativeProfile("u1");
  assert.equal(cached.profile, result.profile);
  assert.ok(cached.generatedAt);
});
