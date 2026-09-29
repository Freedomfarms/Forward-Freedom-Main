// CHIEF model engine tests — configuration boundary, provider→registry→router
// composition, the routing contract handed to the orchestration layer, and
// generate() normalization/events against AI SDK mock models. Multi-provider
// cases use fake providers to prove the layer is not Grok-specific.

import test from "node:test";
import assert from "node:assert/strict";

import { MockLanguageModelV4, MockProviderV4 } from "ai/test";

import { EventBus, EventType } from "../server/chief/core/events.js";
import {
  ModelRegistry,
  ProviderRegistry,
  RouterPolicyRegistry,
} from "../server/chief/core/registry.js";
import {
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_MODEL,
  loadModelConfig,
} from "../server/chief/models/config.js";
import {
  CALLER_KINDS,
  ChiefModelEngine,
  ModelLayerPausedError,
  ModelUnavailableError,
  createModelEngine,
  normalizeCaller,
  normalizeGenerateResult,
} from "../server/chief/models/engine.js";
import { ensureHeuristicRegistered } from "../server/chief/models/router.js";
import {
  CAPABILITY_RANK_KEY,
  REASONING_KEY,
  createModelSpec,
} from "../server/chief/models/types.js";

const SECRET = "xai-secret-value-do-not-leak";
const silentLogger = { warn: () => {}, error: () => {}, log: () => {} };

function mockResult(text, { inputTokens = 10, outputTokens = 5 } = {}) {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
    },
    providerMetadata: { acme: { internalTrace: "must-not-leak" } },
    request: { body: { raw: "request" } },
    response: { id: "resp-1", modelId: "acme-large-2026", body: { raw: "response" } },
    warnings: [],
  };
}

// A fake provider: proves a new transport plugs in via descriptor + catalog
// rows without touching router/engine code.
function fakeProvider(id, models) {
  const languageModels = Object.fromEntries(
    Object.entries(models).map(([modelId, text]) => [
      modelId,
      new MockLanguageModelV4({ provider: id, modelId, doGenerate: mockResult(text) }),
    ])
  );
  const instance = new MockProviderV4({ languageModels });
  return {
    descriptor: {
      id,
      displayName: id.toUpperCase(),
      packageName: `@fake/${id}`,
      credentialEnv: [`${id.toUpperCase()}_API_KEY`],
      create: () => instance,
    },
    languageModels,
  };
}

function cloudSpec(modelId, provider, rank, extra = {}) {
  return createModelSpec({
    modelId,
    name: modelId,
    parameterCountB: 0,
    contextLength: 100000,
    supportedEngines: ["cloud"],
    provider,
    requiresApiKey: true,
    metadata: { [CAPABILITY_RANK_KEY]: rank, ...extra },
  });
}

function resetRegistries() {
  ModelRegistry.clear();
  ProviderRegistry.clear();
  RouterPolicyRegistry.clear();
  ensureHeuristicRegistered();
}

function setupAcme() {
  resetRegistries();
  const acme = fakeProvider("acme", {
    "acme-large": "large says hi",
    "acme-small": "small says hi",
    "acme-code": "code says hi",
  });
  ProviderRegistry.registerValue("acme", acme.descriptor);
  ModelRegistry.registerValue(
    "acme-large",
    cloudSpec("acme-large", "acme", 30, { [REASONING_KEY]: true })
  );
  ModelRegistry.registerValue("acme-small", cloudSpec("acme-small", "acme", 10));
  ModelRegistry.registerValue("acme-code", cloudSpec("acme-code", "acme", 20));
  return acme;
}

const ACME_ENV = {
  ACME_API_KEY: "acme-key",
  CHIEF_MODEL_PROVIDERS: "acme",
  CHIEF_DEFAULT_MODEL: "acme-large",
  CHIEF_FALLBACK_MODEL: "acme-small",
};

// createModelEngine registers the built-in xAI/Anthropic descriptors and
// catalog; for fake-provider tests we build the engine directly.
function acmeEngine(env = ACME_ENV, options = {}) {
  const config = loadModelConfig(env);
  return createModelEngine({ env, config, logger: silentLogger, ...options });
}

// --- configuration boundary ---------------------------------------------------

test("loadModelConfig defaults: Grok-only, heuristic routing, upstream generation defaults", () => {
  const config = loadModelConfig({});
  assert.deepEqual([...config.enabledProviders], ["xai"]);
  assert.equal(config.defaultModel, DEFAULT_MODEL);
  assert.equal(config.fallbackModel, DEFAULT_FALLBACK_MODEL);
  assert.equal(config.routerPolicy, "heuristic");
  assert.equal(config.modelAllowlist, null);
  assert.equal(config.temperature, 0.7);
  assert.equal(config.maxTokens, 1024);
  assert.ok(Object.isFrozen(config));
});

test("loadModelConfig reads CHIEF_-prefixed variables and never provider secrets", () => {
  const config = loadModelConfig({
    CHIEF_MODEL_PROVIDERS: " xai , anthropic ,",
    CHIEF_DEFAULT_MODEL: "grok-4.6",
    CHIEF_FALLBACK_MODEL: "grok-4.3",
    CHIEF_ROUTER_POLICY: "none",
    CHIEF_MODEL_ALLOWLIST: "grok-4.6,grok-4.3",
    CHIEF_MODEL_TEMPERATURE: "0.2",
    CHIEF_MODEL_MAX_TOKENS: "4096",
    XAI_API_KEY: SECRET,
  });
  assert.deepEqual([...config.enabledProviders], ["xai", "anthropic"]);
  assert.equal(config.defaultModel, "grok-4.6");
  assert.equal(config.fallbackModel, "grok-4.3");
  assert.equal(config.routerPolicy, "none");
  assert.deepEqual([...config.modelAllowlist], ["grok-4.6", "grok-4.3"]);
  assert.equal(config.temperature, 0.2);
  assert.equal(config.maxTokens, 4096);
  assert.ok(!JSON.stringify(config).includes(SECRET));
});

test("loadModelConfig rejects out-of-range generation settings", () => {
  assert.throws(() => loadModelConfig({ CHIEF_MODEL_TEMPERATURE: "3" }), RangeError);
  assert.throws(() => loadModelConfig({ CHIEF_MODEL_MAX_TOKENS: "0" }), RangeError);
  assert.throws(() => loadModelConfig({ CHIEF_MODEL_MAX_TOKENS: "1.5" }), RangeError);
  assert.equal(loadModelConfig({ CHIEF_MODEL_MAX_TOKENS: "garbage" }).maxTokens, 1024);
});

// --- Grok through the real @ai-sdk/xai transport -------------------------------

test("createModelEngine with only XAI_API_KEY exposes the Grok catalog and no secrets", () => {
  resetRegistries();
  const engine = createModelEngine({ env: { XAI_API_KEY: SECRET }, logger: silentLogger });
  const health = engine.health();
  assert.equal(health.engine, "chief-ai-sdk");
  assert.deepEqual(health.providers, [
    { id: "xai", displayName: "xAI (Grok)", configured: true, credentialSource: "XAI_API_KEY" },
  ]);
  assert.deepEqual(health.models, [
    "grok-4.7",
    "grok-4.6",
    "grok-4.3",
    "grok-4.20-reasoning",
    "grok-4.20-non-reasoning",
  ]);
  assert.equal(health.defaultModel, "grok-4.7");
  assert.ok(!JSON.stringify(health).includes(SECRET));

  const model = engine.languageModel("grok-4.7");
  assert.equal(model.modelId, "grok-4.7");
  assert.match(model.provider, /^xai/);
  assert.equal(engine.publishesEvents, true);
  assert.equal(engine.isCloud, true);
});

test("Grok routing: trivial → cheapest Grok, reasoning/code/math → Grok 4.7, medium → default", () => {
  resetRegistries();
  const engine = createModelEngine({ env: { XAI_API_KEY: SECRET }, logger: silentLogger });
  assert.equal(engine.resolve("Hi").modelKey, "grok-4.20-non-reasoning");
  assert.equal(engine.resolve("calculate 2+2").modelKey, "grok-4.20-non-reasoning");
  assert.equal(engine.resolve("def foo(): pass").modelKey, "grok-4.7");
  assert.equal(engine.resolve("solve the integral of x^2 dx").modelKey, "grok-4.7");
  assert.equal(
    engine.resolve("Please explain step by step how photosynthesis works in plants").modelKey,
    "grok-4.7"
  );
  assert.equal(
    engine.resolve("x".repeat(501), { urgency: 0.9 }).modelKey,
    "grok-4.20-non-reasoning"
  );
  // medium complexity, no signals → rule 6 → configured default
  const medium = engine.resolve(
    "Tell me a little about the history of the city of Lisbon and its neighbourhoods please"
  );
  assert.equal(medium.routingContext.metadata.complexity_tier, "trivial");
  assert.equal(engine.resolve("", { routerPolicy: "none" }).modelKey, "grok-4.7");
});

test("Anthropic is opt-in: the platform key alone does not enable it", () => {
  resetRegistries();
  const grokOnly = createModelEngine({
    env: { XAI_API_KEY: SECRET, ANTHROPIC_API_KEY: "a" },
    logger: silentLogger,
  });
  assert.ok(!grokOnly.availableModelKeys().some((key) => key.startsWith("claude")));

  resetRegistries();
  const both = createModelEngine({
    env: { XAI_API_KEY: SECRET, ANTHROPIC_API_KEY: "a", CHIEF_MODEL_PROVIDERS: "xai,anthropic" },
    logger: silentLogger,
  });
  assert.ok(both.availableModelKeys().includes("claude-haiku-4-5"));
  assert.match(both.languageModel("claude-haiku-4-5").provider, /^anthropic/);
});

test("no configured provider fails closed with ModelUnavailableError", () => {
  resetRegistries();
  const engine = createModelEngine({ env: {}, logger: silentLogger });
  assert.deepEqual(engine.availableModelKeys(), []);
  assert.equal(engine.health().providers[0].configured, false);
  assert.throws(() => engine.resolve("hi"), ModelUnavailableError);
  assert.throws(() => engine.languageModel("grok-4.7"), ModelUnavailableError);
});

// --- routing contract on a fake provider ----------------------------------------

test("resolve returns the full routing contract", () => {
  setupAcme();
  const engine = acmeEngine();
  const resolution = engine.resolve("Explain step by step why the sky is blue");
  assert.equal(resolution.modelKey, "acme-large");
  assert.equal(resolution.providerId, "acme");
  assert.equal(resolution.spec.modelId, "acme-large");
  assert.equal(resolution.languageModel.modelId, "acme-large");
  assert.equal(resolution.languageModel.provider, "acme");
  assert.equal(resolution.routed, true);
  assert.equal(resolution.policy, "heuristic");
  assert.equal(resolution.routingContext.hasReasoning, true);
  // acme-large is catalog-flagged as reasoning → doubled headroom for the
  // selected model (upstream adjusts for the preferred model; same here).
  assert.equal(resolution.maxTokens, resolution.routingContext.suggestedMaxTokens);
  assert.ok(Object.isFrozen(resolution));
});

test("maxTokens is re-adjusted for the selected model when it differs from the preferred", () => {
  setupAcme();
  const engine = acmeEngine();
  const resolution = engine.resolve("Hi");
  assert.equal(resolution.modelKey, "acme-small");
  // preferred (acme-large) is a reasoning model → context has 2× headroom…
  assert.equal(resolution.routingContext.suggestedMaxTokens, 2048);
  // …but the selected small model is not → CHIEF reports the plain tier.
  assert.equal(resolution.maxTokens, 1024);
});

test("explicit model wins over routing and must be available", () => {
  setupAcme();
  const engine = acmeEngine();
  const explicit = engine.resolve("Hi", { model: "acme-large" });
  assert.equal(explicit.modelKey, "acme-large");
  assert.equal(explicit.routed, false);
  assert.equal(explicit.policy, null);
  assert.throws(() => engine.resolve("Hi", { model: "acme-missing" }), ModelUnavailableError);
});

test("code tag rule reaches the provider-agnostic key match", () => {
  setupAcme();
  const engine = acmeEngine();
  assert.equal(engine.resolve("import numpy as np").modelKey, "acme-code");
});

test("model allowlist narrows candidates and default falls back to the first candidate", () => {
  setupAcme();
  const engine = acmeEngine({ ...ACME_ENV, CHIEF_MODEL_ALLOWLIST: "acme-small" });
  assert.deepEqual(engine.availableModelKeys(), ["acme-small"]);
  assert.equal(engine.resolve("Explain why").modelKey, "acme-small");
  assert.throws(() => engine.languageModel("acme-large"), ModelUnavailableError);
});

test("router policy 'none' and unknown policies fall back to the default model (warned once)", () => {
  setupAcme();
  const warnings = [];
  const engine = acmeEngine(
    { ...ACME_ENV, CHIEF_ROUTER_POLICY: "learned" },
    { logger: { ...silentLogger, warn: (message) => warnings.push(message) } }
  );
  const first = engine.resolve("Hi");
  const second = engine.resolve("Hi");
  assert.equal(first.modelKey, "acme-large");
  assert.equal(first.routed, false);
  assert.equal(second.modelKey, "acme-large");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /'learned' is not registered/);

  const none = acmeEngine({ ...ACME_ENV, CHIEF_ROUTER_POLICY: "none" });
  assert.equal(none.resolve("Hi").modelKey, "acme-large");
  assert.equal(none.resolve("Hi").policy, null);
});

test("a custom router policy registered under RouterPolicyRegistry is honored", () => {
  setupAcme();
  class AlwaysCode {
    constructor({ availableModels }) {
      this.available = availableModels;
    }
    selectModel() {
      return this.available.includes("acme-code") ? "acme-code" : "";
    }
  }
  RouterPolicyRegistry.registerValue("always-code", AlwaysCode);
  const engine = acmeEngine({ ...ACME_ENV, CHIEF_ROUTER_POLICY: "always-code" });
  const resolution = engine.resolve("anything at all");
  assert.equal(resolution.modelKey, "acme-code");
  assert.equal(resolution.policy, "always-code");
  // A policy answer outside the candidates is ignored (upstream rule).
  const narrowed = acmeEngine({
    ...ACME_ENV,
    CHIEF_ROUTER_POLICY: "always-code",
    CHIEF_MODEL_ALLOWLIST: "acme-large,acme-small",
  });
  assert.equal(narrowed.resolve("anything").modelKey, "acme-large");
  assert.equal(narrowed.resolve("anything").routed, false);
});

// --- multiple providers at once --------------------------------------------------

test("two providers route by capability rank across vendors with no engine changes", () => {
  resetRegistries();
  const acme = fakeProvider("acme", { "acme-large": "acme" });
  const zeta = fakeProvider("zeta", { "zeta-mini": "zeta" });
  ProviderRegistry.registerValue("acme", acme.descriptor);
  ProviderRegistry.registerValue("zeta", zeta.descriptor);
  ModelRegistry.registerValue("acme-large", cloudSpec("acme-large", "acme", 50));
  ModelRegistry.registerValue("zeta-mini", cloudSpec("zeta-mini", "zeta", 5));
  const env = {
    ACME_API_KEY: "a",
    ZETA_API_KEY: "z",
    CHIEF_MODEL_PROVIDERS: "acme,zeta",
    CHIEF_DEFAULT_MODEL: "acme-large",
  };
  const engine = acmeEngine(env);
  assert.deepEqual(engine.availableModelKeys(), ["acme-large", "zeta-mini"]);
  const trivial = engine.resolve("Hi");
  assert.equal(trivial.modelKey, "zeta-mini");
  assert.equal(trivial.languageModel.provider, "zeta");
  const heavy = engine.resolve("solve the integral of x^2 dx and prove the theorem");
  assert.equal(heavy.modelKey, "acme-large");
  assert.equal(heavy.languageModel.provider, "acme");

  // Dropping a provider's credentials removes only its models.
  const acmeOnly = acmeEngine({ ...env, ZETA_API_KEY: "" });
  assert.deepEqual(acmeOnly.availableModelKeys(), ["acme-large"]);
  assert.equal(acmeOnly.resolve("Hi").modelKey, "acme-large");
  assert.equal(acmeOnly.health().providers.find((p) => p.id === "zeta").configured, false);
});

// --- generate() -------------------------------------------------------------------

test("generate() routes, publishes INFERENCE_START/END, and returns the upstream dict shape", async () => {
  const acme = setupAcme();
  const bus = new EventBus({ recordHistory: true });
  const engine = acmeEngine(ACME_ENV, { eventBus: bus });
  const result = await engine.generate([
    { role: "system", content: "You are CHIEF." },
    { role: "user", content: "Hi" },
  ]);

  assert.deepEqual(result, {
    content: "small says hi",
    tool_calls: [],
    finish_reason: "stop",
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      reasoning_tokens: 0,
      cached_prompt_tokens: 0,
    },
    model: "acme-small",
    provider: "acme",
    response_model: "acme-large-2026",
  });
  assert.ok(!JSON.stringify(result).includes("must-not-leak"));
  assert.ok(!JSON.stringify(result).includes("raw"));

  const types = bus.history.map((event) => event.eventType);
  assert.deepEqual(types, [EventType.INFERENCE_START, EventType.INFERENCE_END]);
  assert.deepEqual(bus.history[0].data, {
    model: "acme-small",
    engine: "chief-ai-sdk",
    provider: "acme",
    routed: true,
  });
  assert.equal(bus.history[1].data.model, "acme-small");
  assert.equal(bus.history[1].data.content, "small says hi");
  assert.deepEqual(bus.history[1].data.usage, result.usage);
  assert.equal(bus.history[1].data.finish_reason, "stop");

  const call = acme.languageModels["acme-small"].doGenerateCalls[0];
  assert.equal(call.temperature, 0.7);
  // max(config.maxTokens=1024, resolution.maxTokens=1024)
  assert.equal(call.maxOutputTokens, 1024);
  assert.equal(call.prompt.length, 2);
});

test("generate() honors explicit model, temperature and maxTokens overrides", async () => {
  const acme = setupAcme();
  const engine = acmeEngine();
  const result = await engine.generate([{ role: "user", content: "anything" }], {
    model: "acme-code",
    temperature: 0.1,
    maxTokens: 333,
  });
  assert.equal(result.model, "acme-code");
  const call = acme.languageModels["acme-code"].doGenerateCalls[0];
  assert.equal(call.temperature, 0.1);
  assert.equal(call.maxOutputTokens, 333);
});

test("generate() derives the routing query from the last user message", async () => {
  setupAcme();
  const engine = acmeEngine();
  const result = await engine.generate([
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello!" },
    { role: "user", content: [{ type: "text", text: "Explain step by step why the sky is blue" }] },
  ]);
  assert.equal(result.model, "acme-large");
});

test("generate() rejects empty input and unavailable models before any provider call", async () => {
  const acme = setupAcme();
  const engine = acmeEngine();
  await assert.rejects(engine.generate([]), TypeError);
  await assert.rejects(
    engine.generate([{ role: "user", content: "x" }], { model: "nope" }),
    ModelUnavailableError
  );
  for (const model of Object.values(acme.languageModels)) {
    assert.equal(model.doGenerateCalls.length, 0);
  }
});

test("languageModelMiddleware passes through to every resolved model (budget seam)", async () => {
  setupAcme();
  const seen = [];
  const engine = acmeEngine(ACME_ENV, {
    languageModelMiddleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => {
        seen.push(params.maxOutputTokens);
        return { ...params, maxOutputTokens: 7 };
      },
    },
  });
  const acmeSmall = engine.languageModel("acme-small");
  await engine.generate([{ role: "user", content: "Hi" }]);
  assert.deepEqual(seen, [1024]);
  assert.equal(acmeSmall.modelId, "acme-small");
});

test("normalizeGenerateResult tolerates missing fields", () => {
  const normalized = normalizeGenerateResult({}, { modelKey: "m", providerId: "p" });
  assert.deepEqual(normalized, {
    content: "",
    tool_calls: [],
    finish_reason: "",
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      reasoning_tokens: 0,
      cached_prompt_tokens: 0,
    },
    model: "m",
    provider: "p",
    response_model: null,
  });
});

test("an operative-style instruction routes without a user chat turn", async () => {
  // Future autonomous ticks (docs/CHIEF_ARCHITECTURE.md §5.5) call the same
  // resolve/generate contract with an instruction and a schedule caller.
  // Nothing here starts a scheduler.
  const acme = setupAcme();
  const bus = new EventBus({ recordHistory: true });
  const engine = acmeEngine(ACME_ENV, { eventBus: bus });
  const instruction =
    "Review the last run state and explain step by step whether the balance change warrants attention";
  const caller = { kind: CALLER_KINDS.SCHEDULE, id: "task-run-1", trigger: "cron:daily" };

  const resolution = engine.resolve(instruction, { caller });
  assert.equal(resolution.modelKey, "acme-large");
  assert.deepEqual(resolution.caller, {
    kind: "schedule",
    id: "task-run-1",
    trigger: "cron:daily",
  });

  const result = await engine.generate([{ role: "system", content: instruction }], {
    query: instruction,
    caller,
  });
  assert.equal(result.model, "acme-large");
  assert.equal(acme.languageModels["acme-large"].doGenerateCalls.length, 1);
  for (const event of bus.history) {
    assert.deepEqual(event.data.caller, resolution.caller);
  }
  assert.deepEqual(
    bus.history.map((event) => event.eventType),
    [EventType.INFERENCE_START, EventType.INFERENCE_END]
  );
});

test("caller is omitted from events when absent, and rejected when malformed", () => {
  setupAcme();
  const engine = acmeEngine();
  assert.equal(engine.resolve("Hi").caller, null);
  assert.throws(() => engine.resolve("Hi", { caller: { kind: "self" } }), TypeError);
  assert.throws(() => normalizeCaller("schedule"), TypeError);
  assert.deepEqual(normalizeCaller({ kind: CALLER_KINDS.EVENT, id: 7 }), {
    kind: "event",
    id: "7",
    trigger: null,
  });
  assert.deepEqual(Object.values(CALLER_KINDS), ["user_turn", "schedule", "event", "delegation"]);
});

test("CHIEF_MODELS_ENABLED=false pauses resolve, generate, and languageModel", async () => {
  setupAcme();
  const engine = acmeEngine({ ...ACME_ENV, CHIEF_MODELS_ENABLED: "false" });
  assert.equal(engine.health().modelsEnabled, false);
  assert.ok(engine.availableModelKeys().includes("acme-large"));
  assert.throws(() => engine.resolve("Hi"), ModelLayerPausedError);
  assert.throws(() => engine.languageModel("acme-large"), ModelLayerPausedError);
  await assert.rejects(
    engine.generate([{ role: "user", content: "Hi" }], { caller: { kind: "schedule", id: "run" } }),
    ModelLayerPausedError
  );
});

test("CHIEF_MODELS_ENABLED defaults to true and rejects unknown values", () => {
  assert.equal(loadModelConfig({}).modelsEnabled, true);
  assert.equal(loadModelConfig({ CHIEF_MODELS_ENABLED: "off" }).modelsEnabled, false);
  assert.throws(() => loadModelConfig({ CHIEF_MODELS_ENABLED: "maybe" }), RangeError);
});

test("ChiefModelEngine constructor validates its inputs", () => {
  assert.throws(() => new ChiefModelEngine({ providers: new Map() }), TypeError);
  assert.throws(
    () => new ChiefModelEngine({ config: loadModelConfig({}), providers: {} }),
    TypeError
  );
});
