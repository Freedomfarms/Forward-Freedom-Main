import test, { before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// Relevance Engine (Freedom Brain v2, rollout step 1): scored, budgeted
// memory selection with provenance annotations (why / confidence / source /
// last confirmed). Pure functions are tested directly; integration is tested
// through brainTurn with a mocked model.
//
// Requires: node --test --experimental-test-module-mocks (npm test).

let setupError = null;
let selectRelevantMemories;
let renderMemoriesWithProvenance;
let deriveConfidence;
let extractTopicTerms;
let MEMORY_BUDGET;
let brainTurn;
let setLlmImplementationForTesting;
let createFakeDb;
let envelope;

let currentDb;
let llmCalls;

const USER_ID = "user-1";
const NOW = new Date("2026-07-25T00:00:00Z");

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
    ({
      selectRelevantMemories,
      renderMemoriesWithProvenance,
      deriveConfidence,
      extractTopicTerms,
      MEMORY_BUDGET,
    } = await import("../server/brain/relevance.js"));
    ({ brainTurn } = await import("../server/brain/index.js"));
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

function entry(id, text, { source = "user_edit", updatedAt = "2026-07-01T00:00:00Z" } = {}) {
  return { id, text, source, addedAt: updatedAt, updatedAt };
}

function profileWith(categories) {
  return { categories, tombstones: [] };
}

beforeEach(() => {
  if (setupError) return;
  process.env.ANTHROPIC_API_KEY = "test-key";
  llmCalls = [];
});

test("small stores pass through whole, each item annotated with provenance", (t) => {
  if (!requireSetup(t)) return;
  const profile = profileWith({
    financialGoals: [entry("g1", "Wants aggressive debt payoff")],
    statedPreferences: [entry("p1", "Prefers weekly summaries", { source: "finance" })],
  });

  const selected = selectRelevantMemories(profile, {
    message: "Should I make this purchase given my debt payoff goal?",
    now: NOW,
  });

  assert.equal(selected.length, 2, "below budget → everything included");
  const goal = selected.find((item) => item.entry.id === "g1");
  assert.match(goal.annotation.reason, /matches current topic/);
  assert.match(goal.annotation.reason, /debt|payoff/);
  assert.equal(goal.annotation.source, "user confirmed (profile edit)");
  assert.equal(goal.annotation.lastConfirmed, "2026-07-01");
  assert.ok(goal.annotation.confidence > 0.8, "fresh user-confirmed entry scores high");

  const pref = selected.find((item) => item.entry.id === "p1");
  assert.equal(pref.annotation.source, "observed by finance capability");
  assert.ok(
    pref.annotation.confidence < goal.annotation.confidence,
    "extracted entries trail user-confirmed ones"
  );
});

test("large stores are budgeted: topical items survive, off-topic filler does not", (t) => {
  if (!requireSetup(t)) return;
  const filler = Array.from({ length: 40 }, (_, i) =>
    entry(`f${i}`, `Miscellaneous background item number ${i}`, {
      source: "research",
      updatedAt: "2025-01-01T00:00:00Z",
    })
  );
  const profile = profileWith({
    financialGoals: [
      entry("g1", "Pay off the mortgage early"),
      ...filler.slice(0, 20),
    ],
    lifeContext: [
      entry("l1", "Planning a kitchen renovation this fall", { source: "brain_chat" }),
      ...filler.slice(20),
    ],
  });

  const selected = selectRelevantMemories(profile, {
    message: "How does the kitchen renovation affect the mortgage payoff?",
    now: NOW,
  });

  assert.ok(selected.length <= MEMORY_BUDGET, "budget respected");
  assert.ok(
    selected.some((item) => item.entry.id === "g1"),
    "topical mortgage goal selected"
  );
  assert.ok(
    selected.some((item) => item.entry.id === "l1"),
    "topical renovation context selected"
  );
});

test("confidence derives from source and decays with age", (t) => {
  if (!requireSetup(t)) return;
  const fresh = deriveConfidence(entry("a", "x", { updatedAt: "2026-07-20T00:00:00Z" }), {
    now: NOW,
  });
  const halfLife = deriveConfidence(entry("b", "x", { updatedAt: "2026-01-26T00:00:00Z" }), {
    now: NOW,
  });
  const ancient = deriveConfidence(entry("c", "x", { updatedAt: "2020-01-01T00:00:00Z" }), {
    now: NOW,
  });
  assert.ok(fresh > 0.85, "fresh user-confirmed ≈ 0.9");
  assert.ok(halfLife > 0.4 && halfLife < 0.5, "≈ half after one half-life");
  assert.equal(ancient, 0.3, "clamped at the confidence floor");
});

test("rendering includes category labels and why/confidence/source/last-confirmed lines", (t) => {
  if (!requireSetup(t)) return;
  const selected = selectRelevantMemories(
    profileWith({ financialGoals: [entry("g1", "Wants aggressive debt payoff")] }),
    { message: "thinking about my debt", now: NOW }
  );
  const rendered = renderMemoriesWithProvenance(selected);
  assert.match(rendered, /Financial goals:/);
  assert.match(rendered, /- \[g1\] Wants aggressive debt payoff/);
  assert.match(
    rendered,
    /\(why: .*; confidence 0\.\d+; source: user confirmed \(profile edit\); last confirmed 2026-07-01\)/
  );
  assert.equal(
    renderMemoriesWithProvenance([]),
    "(no profile information recorded yet)"
  );
});

test("topic terms ignore stop words and short tokens", (t) => {
  if (!requireSetup(t)) return;
  const terms = extractTopicTerms("Should I pay off my debt with the bonus?");
  assert.ok(terms.has("debt"));
  assert.ok(terms.has("bonus"));
  assert.ok(!terms.has("should"));
  assert.ok(!terms.has("pay"));
});

test("brainTurn injects the relevance-selected profile with provenance into the prompt", async (t) => {
  if (!requireSetup(t)) return;
  currentDb = createFakeDb({
    user: [{ id: USER_ID, email: "user@example.com", timezone: "America/Chicago" }],
    ceoAgentConfig: [
      {
        id: "ceo-1",
        userId: USER_ID,
        name: "CEO Agent",
        personalityPreset: "DIRECT_EFFICIENT",
        model: "claude-sonnet-4-5",
        profileCiphertext: envelope.encryptJson(
          profileWith({
            financialGoals: [entry("g1", "Wants aggressive debt payoff")],
          })
        ),
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
  setLlmImplementationForTesting({
    generateText: async (options) => {
      llmCalls.push({ method: "generateText", options });
      return { text: "Given your debt payoff goal, I'd hold off.", usage: {} };
    },
    generateObject: async () => ({ object: { ops: [] }, usage: {} }),
  });

  const outcome = await brainTurn({
    userId: USER_ID,
    ceoAgentConfigId: "ceo-1",
    conversationId: "ceo-convo-1",
    message: "Should I buy this given my debt situation?",
  });

  assert.match(outcome.reply, /debt payoff goal/);
  const prompt = llmCalls[0].options.prompt;
  assert.match(prompt, /USER PROFILE \(long-term memory, selected for relevance\)/);
  assert.match(prompt, /Wants aggressive debt payoff/);
  assert.match(prompt, /\(why: matches current topic/);
  assert.match(prompt, /confidence 0\.\d+; source: user confirmed \(profile edit\)/);
});
