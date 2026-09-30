// CHIEF budget caps — model-layer check (ADR-0003). The cap is not a turn-machine
// feature: generate and openStream both refuse before the provider is contacted.

import test from "node:test";
import assert from "node:assert/strict";

import { MockLanguageModelV4, MockProviderV4 } from "ai/test";

import { EventBus, EventType } from "../server/chief/core/events.js";
import {
  ModelRegistry,
  ProviderRegistry,
  RouterPolicyRegistry,
} from "../server/chief/core/registry.js";
import { loadModelConfig } from "../server/chief/models/config.js";
import {
  BudgetExceededError,
  MemoryBudgetStore,
  PrismaBudgetStore,
  estimateCallUsd,
  periodWindowStart,
} from "../server/chief/models/budget.js";
import { createModelEngine } from "../server/chief/models/engine.js";
import { ensureHeuristicRegistered } from "../server/chief/models/router.js";
import { CAPABILITY_RANK_KEY, createModelSpec } from "../server/chief/models/types.js";

const silentLogger = { warn: () => {}, error: () => {}, log: () => {} };

function resetRegistries() {
  ModelRegistry.clear();
  ProviderRegistry.clear();
  RouterPolicyRegistry.clear();
  ensureHeuristicRegistered();
}

function mockResult(text, { inputTokens = 10, outputTokens = 5 } = {}) {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
    },
    warnings: [],
  };
}

function acmeEngine({ budget, eventBus, pricing = {}, outputTokens = 5, maxTokens } = {}) {
  resetRegistries();
  const model = new MockLanguageModelV4({
    provider: "acme",
    modelId: "acme-small",
    doGenerate: mockResult("hi", { outputTokens }),
  });
  ProviderRegistry.registerValue("acme", {
    id: "acme",
    displayName: "ACME",
    packageName: "@fake/acme",
    credentialEnv: ["ACME_API_KEY"],
    create: () => new MockProviderV4({ languageModels: { "acme-small": model } }),
  });
  ModelRegistry.registerValue(
    "acme-small",
    createModelSpec({
      modelId: "acme-small",
      name: "acme-small",
      parameterCountB: 0,
      contextLength: 100000,
      supportedEngines: ["cloud"],
      provider: "acme",
      requiresApiKey: true,
      metadata: {
        [CAPABILITY_RANK_KEY]: 10,
        pricing_input: 0,
        pricing_output: 0,
        ...pricing,
      },
    })
  );
  const env = {
    ACME_API_KEY: "acme-key",
    CHIEF_MODEL_PROVIDERS: "acme",
    CHIEF_DEFAULT_MODEL: "acme-small",
    CHIEF_FALLBACK_MODEL: "acme-small",
    CHIEF_ROUTER_POLICY: "none",
    ...(maxTokens ? { CHIEF_MODEL_MAX_TOKENS: String(maxTokens) } : {}),
  };
  return {
    model,
    engine: createModelEngine({
      env,
      config: loadModelConfig(env),
      logger: silentLogger,
      eventBus,
      budget,
    }),
  };
}

test("estimateCallUsd prices input and output per million tokens", () => {
  const usd = estimateCallUsd(
    { metadata: { pricing_input: 2, pricing_output: 8 } },
    { inputTokens: 1_000_000, outputTokens: 500_000 }
  );
  assert.equal(usd, 6);
  assert.equal(estimateCallUsd(null, { inputTokens: 10, outputTokens: 10 }), 0);
});

test("a missing budget row allows the call", async () => {
  const store = new MemoryBudgetStore();
  await store.assertCanSpend("user", 10);
  assert.deepEqual(await store.recordSpend("user", 1), []);
});

test("under the cap is allowed and spend is recorded on every stacked row", async () => {
  const now = new Date("2026-09-15T12:00:00Z");
  const store = new MemoryBudgetStore([
    {
      userId: "user",
      scope: "global",
      periodType: "month",
      capUsd: 2,
      spentUsd: 0.5,
      periodStart: now,
    },
    {
      userId: "user",
      scope: "model",
      periodType: "day",
      capUsd: 2,
      spentUsd: 0.25,
      periodStart: now,
    },
    { userId: "other", scope: "global", periodType: "month", capUsd: 0, spentUsd: 0 },
  ]);
  await store.assertCanSpend("user", 0.4, { now });
  await store.recordSpend("user", 0.4, { now });
  assert.equal(store.rows[0].spentUsd, 0.9);
  assert.equal(store.rows[1].spentUsd, 0.65);
  assert.equal(store.rows[2].spentUsd, 0);
});

test("over the cap blocks before any spend is recorded", async () => {
  const store = new MemoryBudgetStore([
    { userId: "user", scope: "global", periodType: "month", capUsd: 1, spentUsd: 0.9 },
  ]);
  await assert.rejects(store.assertCanSpend("user", 0.2), (error) => {
    assert.ok(error instanceof BudgetExceededError);
    assert.equal(error.scope, "global");
    assert.equal(error.periodType, "month");
    assert.equal(store.rows[0].spentUsd, 0.9);
    return true;
  });
});

test("day and month windows reset spent; a run cap does not", async () => {
  const day = new MemoryBudgetStore([
    {
      userId: "user",
      periodType: "day",
      capUsd: 1,
      spentUsd: 50,
      periodStart: new Date("2026-09-28T00:00:00Z"),
    },
  ]);
  const now = new Date("2026-09-29T03:00:00Z");
  await day.assertCanSpend("user", 0.1, { now });
  assert.equal(day.rows[0].spentUsd, 50);
  await day.recordSpend("user", 0.2, { now });
  assert.equal(day.rows[0].spentUsd, 0.2);
  assert.equal(day.rows[0].periodStart.getTime(), periodWindowStart("day", now).getTime());

  const month = new MemoryBudgetStore([
    {
      userId: "user",
      periodType: "month",
      capUsd: 1,
      spentUsd: 50,
      periodStart: new Date("2026-08-01T00:00:00Z"),
    },
  ]);
  await month.recordSpend("user", 0.1, { now });
  assert.equal(month.rows[0].spentUsd, 0.1);

  const run = new MemoryBudgetStore([
    {
      userId: "user",
      periodType: "run",
      capUsd: 1,
      spentUsd: 0.4,
      periodStart: new Date("2020-01-01T00:00:00Z"),
    },
  ]);
  await run.recordSpend("user", 0.1, { now });
  assert.equal(run.rows[0].spentUsd, 0.5);
  assert.equal(run.rows[0].periodStart.getTime(), new Date("2020-01-01T00:00:00Z").getTime());
});

test("recordSpend that crosses the cap keeps the spend and throws", async () => {
  const store = new MemoryBudgetStore([
    { userId: "user", scope: "global", periodType: "month", capUsd: 1, spentUsd: 0.8 },
  ]);
  await assert.rejects(store.recordSpend("user", 0.3), BudgetExceededError);
  assert.equal(store.rows[0].spentUsd, 1.1);
});

test("generate and openStream refuse an over-cap call before the provider", async () => {
  const budget = new MemoryBudgetStore([
    { userId: "user", scope: "global", periodType: "month", capUsd: 1, spentUsd: 0 },
  ]);
  const bus = new EventBus({ recordHistory: true });
  const { model, engine } = acmeEngine({
    budget,
    eventBus: bus,
    pricing: { pricing_output: 1_000_000 },
  });
  const messages = [{ role: "user", content: "Hi" }];
  await assert.rejects(engine.generate(messages, { userId: "user" }), BudgetExceededError);
  await assert.rejects(engine.openStream(messages, { userId: "user" }), BudgetExceededError);
  assert.equal(model.doGenerateCalls.length, 0);
  assert.equal(model.doStreamCalls.length, 0);
  assert.equal(budget.rows[0].spentUsd, 0);
  assert.deepEqual(
    bus.history.map((event) => event.eventType),
    [EventType.AGENT_BUDGET_EXCEEDED, EventType.AGENT_BUDGET_EXCEEDED]
  );
});

test("an allowed call records spend, and a post-call overrun is kept", async () => {
  const allowed = new MemoryBudgetStore([
    { userId: "user", scope: "global", periodType: "month", capUsd: 20, spentUsd: 0 },
  ]);
  const { model, engine } = acmeEngine({
    budget: allowed,
    pricing: { pricing_input: 1_000_000, pricing_output: 1_000_000 },
  });
  await engine.generate([{ role: "user", content: "Hi" }], { userId: "user", maxTokens: 1 });
  assert.equal(model.doGenerateCalls.length, 1);
  // mock usage is 10 prompt + 5 completion tokens at $1 per token.
  assert.equal(allowed.rows[0].spentUsd, 15);

  const overrun = new MemoryBudgetStore([
    { userId: "user", scope: "global", periodType: "month", capUsd: 2, spentUsd: 0 },
  ]);
  const second = acmeEngine({
    budget: overrun,
    pricing: { pricing_input: 0, pricing_output: 1_000_000 },
    outputTokens: 5,
  });
  await assert.rejects(
    second.engine.generate([{ role: "user", content: "Hi" }], { userId: "user", maxTokens: 1 }),
    BudgetExceededError
  );
  assert.equal(second.model.doGenerateCalls.length, 1);
  assert.equal(overrun.rows[0].spentUsd, 5);
});

test("PrismaBudgetStore commits a post-call overrun instead of rolling it back", async () => {
  const rows = [
    {
      id: "b1",
      userId: "user",
      scope: "global",
      periodType: "month",
      capUsd: 1,
      spentUsd: 0.9,
      periodStart: new Date("2026-09-01T00:00:00Z"),
    },
  ];
  let committed = false;
  const withUser = async (_userId, fn) => {
    const tx = {
      chiefBudget: {
        findMany: async () => rows.map((row) => ({ ...row })),
        update: async ({ where, data }) => {
          Object.assign(
            rows.find((row) => row.id === where.id),
            data
          );
          return data;
        },
      },
    };
    const result = await fn(tx);
    committed = true;
    return result;
  };
  const now = new Date("2026-09-15T00:00:00Z");
  const store = new PrismaBudgetStore({ withUser, now: () => now });
  await assert.rejects(store.assertCanSpend("user", 0.2, { now }), BudgetExceededError);
  assert.equal(committed, false);
  assert.equal(rows[0].spentUsd, 0.9);

  await assert.rejects(store.recordSpend("user", 0.2, { now }), BudgetExceededError);
  assert.equal(committed, true);
  assert.equal(rows[0].spentUsd, 1.1);
});
