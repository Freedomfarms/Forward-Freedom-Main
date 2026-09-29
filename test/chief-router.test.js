// CHIEF heuristic router tests — translated from OpenJarvis
// tests/learning/test_router.py, tests/learning/test_routing_models.py
// (cloud-model cases) and tests/learning/test_router_stubs.py (commit
// 5e5f5ef), plus the documented CHIEF adaptation: capability-rank tie-break
// among cloud models (server/chief/models/router.js header).

import test from "node:test";
import assert from "node:assert/strict";

import { ModelRegistry, RouterPolicyRegistry } from "../server/chief/core/registry.js";
import {
  DefaultQueryAnalyzer,
  HEURISTIC_POLICY_KEY,
  HeuristicRouter,
  QueryAnalyzer,
  RouterPolicy,
  buildRoutingContext,
  ensureHeuristicRegistered,
  largestModel,
  modelRank,
  smallestModel,
} from "../server/chief/models/router.js";
import {
  CAPABILITY_RANK_KEY,
  createModelSpec,
  createRoutingContext,
} from "../server/chief/models/types.js";

function localSpec(modelId, parameterCountB, extra = {}) {
  return createModelSpec({
    modelId,
    name: modelId,
    parameterCountB,
    contextLength: 4096,
    supportedEngines: ["ollama"],
    ...extra,
  });
}

function cloudSpec(modelId, rank = undefined) {
  return createModelSpec({
    modelId,
    name: modelId,
    parameterCountB: 0.0,
    contextLength: 200000,
    supportedEngines: ["cloud"],
    requiresApiKey: true,
    metadata: rank === undefined ? {} : { [CAPABILITY_RANK_KEY]: rank },
  });
}

// Mirrors upstream `_register_models()`.
function registerModels() {
  ModelRegistry.clear();
  ModelRegistry.registerValue("small", localSpec("small", 3.0));
  ModelRegistry.registerValue("large", localSpec("large", 70.0));
  ModelRegistry.registerValue("coder", localSpec("coder", 16.0));
}

// --- build_routing_context ---------------------------------------------------

test("build_routing_context detects code / math / length / urgency", () => {
  const code = buildRoutingContext("def hello():\n    pass");
  assert.equal(code.hasCode, true);
  assert.equal(code.hasMath, false);
  const math = buildRoutingContext("solve the integral of x^2");
  assert.equal(math.hasMath, true);
  assert.equal(math.hasCode, false);
  assert.equal(buildRoutingContext("Hi").queryLength, 2);
  assert.equal(buildRoutingContext("test").urgency, 0.5);
});

// --- HeuristicRouter (test_router.py) ----------------------------------------

test("short query prefers small", () => {
  registerModels();
  const router = new HeuristicRouter({ availableModels: ["small", "large", "coder"] });
  assert.equal(router.selectModel(createRoutingContext({ query: "Hi", queryLength: 2 })), "small");
});

test("code prefers coder", () => {
  registerModels();
  const router = new HeuristicRouter({ availableModels: ["small", "large", "coder"] });
  const ctx = createRoutingContext({ query: "def foo():", queryLength: 10, hasCode: true });
  assert.equal(router.selectModel(ctx), "coder");
});

test("math prefers large", () => {
  registerModels();
  const router = new HeuristicRouter({ availableModels: ["small", "large", "coder"] });
  const ctx = buildRoutingContext("solve the integral of x^2 dx");
  assert.equal(ctx.hasMath, true);
  assert.ok(ctx.complexityScore > 0.2);
  assert.equal(router.selectModel(ctx), "large");
});

test("unknown local model does not beat known local model", () => {
  registerModels();
  ModelRegistry.registerValue("unknown-local", localSpec("unknown-local", 0.0));
  const router = new HeuristicRouter({ availableModels: ["small", "unknown-local"] });
  const ctx = createRoutingContext({
    query: "solve this carefully",
    queryLength: 20,
    hasMath: true,
    complexityScore: 0.4,
  });
  assert.equal(router.selectModel(ctx), "small");
});

test("low complexity math prefers small (regression: calculate 2+2)", () => {
  registerModels();
  const router = new HeuristicRouter({ availableModels: ["small", "large", "coder"] });
  const ctx = buildRoutingContext("calculate 2+2");
  assert.equal(ctx.hasMath, true);
  assert.equal(ctx.complexityScore, 0.2);
  assert.equal(router.selectModel(ctx), "small");
});

test("high complexity prefers large", () => {
  registerModels();
  const router = new HeuristicRouter({ availableModels: ["small", "large", "coder"] });
  const ctx = createRoutingContext({
    query: "x".repeat(501),
    queryLength: 501,
    complexityScore: 0.7,
  });
  assert.equal(router.selectModel(ctx), "large");
});

test("high urgency overrides to small", () => {
  registerModels();
  const router = new HeuristicRouter({ availableModels: ["small", "large", "coder"] });
  const ctx = createRoutingContext({ query: "x".repeat(501), queryLength: 501, urgency: 0.9 });
  assert.equal(router.selectModel(ctx), "small");
});

test("fallback chain uses default for medium queries", () => {
  registerModels();
  const router = new HeuristicRouter({
    availableModels: ["small", "large"],
    defaultModel: "large",
    fallbackModel: "small",
  });
  const ctx = createRoutingContext({
    query: "Tell me about cats",
    queryLength: 60,
    complexityScore: 0.35,
  });
  assert.equal(router.selectModel(ctx), "large");
});

test("fallback chain: default missing → fallback → first available", () => {
  registerModels();
  const ctx = createRoutingContext({ query: "medium", queryLength: 60, complexityScore: 0.35 });
  assert.equal(
    new HeuristicRouter({
      availableModels: ["small", "large"],
      defaultModel: "absent",
      fallbackModel: "large",
    }).selectModel(ctx),
    "large"
  );
  assert.equal(
    new HeuristicRouter({
      availableModels: ["small", "large"],
      defaultModel: "absent",
      fallbackModel: "absent-too",
    }).selectModel(ctx),
    "small"
  );
});

test("no available models returns default then fallback then empty", () => {
  ModelRegistry.clear();
  const ctx = createRoutingContext({ query: "test", queryLength: 4 });
  assert.equal(
    new HeuristicRouter({ availableModels: [], defaultModel: "fallback-model" }).selectModel(ctx),
    "fallback-model"
  );
  assert.equal(
    new HeuristicRouter({ availableModels: [], fallbackModel: "gpt-5-mini" }).selectModel(ctx),
    "gpt-5-mini"
  );
  assert.equal(new HeuristicRouter({ availableModels: [] }).selectModel(ctx), "");
});

test("available models default to every registry key", () => {
  registerModels();
  const router = new HeuristicRouter();
  assert.deepEqual(router.availableModels, []);
  const ctx = createRoutingContext({ query: "Hi", queryLength: 2 });
  assert.equal(router.selectModel(ctx), "small");
});

test("reasoning keywords prefer large", () => {
  registerModels();
  const router = new HeuristicRouter({ availableModels: ["small", "large"] });
  const ctx = buildRoutingContext(
    "Please explain step by step how the process of photosynthesis works in plants"
  );
  assert.equal(router.selectModel(ctx), "large");
});

test("code without coder falls to large", () => {
  registerModels();
  const router = new HeuristicRouter({ availableModels: ["small", "large"] });
  const ctx = createRoutingContext({ query: "def foo():", queryLength: 10, hasCode: true });
  assert.equal(router.selectModel(ctx), "large");
});

test("code tag match is case-insensitive substring on the key", () => {
  registerModels();
  ModelRegistry.registerValue("DeepSeek-Coder-V2", localSpec("DeepSeek-Coder-V2", 16.0));
  const router = new HeuristicRouter({ availableModels: ["small", "large", "DeepSeek-Coder-V2"] });
  const ctx = createRoutingContext({ query: "import numpy", queryLength: 12, hasCode: true });
  assert.equal(router.selectModel(ctx), "DeepSeek-Coder-V2");
});

// --- cloud tiers (test_routing_models.py) -------------------------------------

test("unknown cloud model escalates over known local", () => {
  registerModels();
  ModelRegistry.registerValue("qwen3:8b", localSpec("qwen3:8b", 8.2));
  ModelRegistry.registerValue("gpt-5-mini", cloudSpec("gpt-5-mini"));
  const router = new HeuristicRouter({ availableModels: ["qwen3:8b", "gpt-5-mini"] });
  const ctx = createRoutingContext({
    query: "prove this carefully",
    queryLength: 20,
    hasMath: true,
    complexityScore: 0.4,
  });
  assert.equal(router.selectModel(ctx), "gpt-5-mini");
});

test("model rank tuples match upstream tiers", () => {
  registerModels();
  ModelRegistry.registerValue("cloudy", cloudSpec("cloudy"));
  ModelRegistry.registerValue("unknown-local", localSpec("unknown-local", 0.0));
  assert.deepEqual(modelRank("large"), [1, 70.0]);
  assert.deepEqual(modelRank("cloudy"), [2, 0.0]);
  assert.deepEqual(modelRank("unknown-local"), [0, 0.0]);
  assert.deepEqual(modelRank("never-registered"), [0, 0.0]);
});

test("cloud-only catalog without ranks behaves exactly like upstream (first available)", () => {
  ModelRegistry.clear();
  const models = ["cloud-a", "cloud-b", "cloud-c"];
  for (const id of models) ModelRegistry.registerValue(id, cloudSpec(id));
  assert.equal(largestModel(models), "cloud-a");
  assert.equal(smallestModel(models), "cloud-a");
  const router = new HeuristicRouter({ availableModels: models });
  assert.ok(
    models.includes(router.selectModel(createRoutingContext({ query: "hi", queryLength: 2 })))
  );
  assert.ok(
    models.includes(
      router.selectModel(createRoutingContext({ query: "solve x", queryLength: 7, hasMath: true }))
    )
  );
});

// --- CHIEF adaptation: capability rank among cloud models ---------------------

test("CHIEF adaptation: capability rank orders cloud models for largest/smallest", () => {
  ModelRegistry.clear();
  ModelRegistry.registerValue("grok-mid", cloudSpec("grok-mid", 30));
  ModelRegistry.registerValue("grok-fast", cloudSpec("grok-fast", 10));
  ModelRegistry.registerValue("grok-top", cloudSpec("grok-top", 40));
  const models = ["grok-mid", "grok-fast", "grok-top"];
  assert.equal(largestModel(models), "grok-top");
  assert.equal(smallestModel(models), "grok-fast");

  const router = new HeuristicRouter({ availableModels: models, defaultModel: "grok-mid" });
  assert.equal(
    router.selectModel(createRoutingContext({ query: "Hi", queryLength: 2 })),
    "grok-fast"
  );
  assert.equal(
    router.selectModel(
      createRoutingContext({ query: "x".repeat(501), queryLength: 501, urgency: 0.9 })
    ),
    "grok-fast"
  );
  assert.equal(
    router.selectModel(createRoutingContext({ query: "def f():", queryLength: 8, hasCode: true })),
    "grok-top"
  );
  assert.equal(
    router.selectModel(
      createRoutingContext({ query: "prove", queryLength: 5, hasMath: true, complexityScore: 0.4 })
    ),
    "grok-top"
  );
  assert.equal(
    router.selectModel(
      createRoutingContext({ query: "medium", queryLength: 60, complexityScore: 0.35 })
    ),
    "grok-mid"
  );
});

test("CHIEF adaptation never changes local-vs-cloud precedence or local ordering", () => {
  ModelRegistry.clear();
  ModelRegistry.registerValue("small", localSpec("small", 3.0));
  ModelRegistry.registerValue("large", localSpec("large", 70.0));
  ModelRegistry.registerValue("cloud-ranked", cloudSpec("cloud-ranked", 99));
  const models = ["small", "large", "cloud-ranked"];
  // largest: cloud tier (2, ·) still beats any local size — upstream rule.
  assert.equal(largestModel(models), "cloud-ranked");
  // smallest: positive parameter counts win; the rank fallback is unused.
  assert.equal(smallestModel(models), "small");
});

// --- RouterPolicy / QueryAnalyzer contracts (test_router_stubs.py) -----------

test("RouterPolicy and QueryAnalyzer base classes require implementations", () => {
  assert.throws(() => new RouterPolicy().selectModel({}), TypeError);
  assert.throws(() => new QueryAnalyzer().analyze("q"), TypeError);
  class Dummy extends RouterPolicy {
    selectModel() {
      return "test-model";
    }
  }
  assert.equal(new Dummy().selectModel(createRoutingContext({ query: "hello" })), "test-model");
});

test("DefaultQueryAnalyzer coerces urgency and model", () => {
  const analyzer = new DefaultQueryAnalyzer();
  const ctx = analyzer.analyze("Hello world", { urgency: "bad", model: 42 });
  assert.equal(ctx.urgency, 0.5);
  assert.equal(ctx.query, "Hello world");
  assert.equal(ctx.queryLength, 11);
  assert.equal(analyzer.analyze("Hi", { urgency: 0.9 }).urgency, 0.9);
});

// --- heuristic_policy.ensure_registered --------------------------------------

test("heuristic policy is registered idempotently and constructible via the registry", () => {
  RouterPolicyRegistry.clear();
  ensureHeuristicRegistered();
  ensureHeuristicRegistered();
  assert.equal(RouterPolicyRegistry.get(HEURISTIC_POLICY_KEY), HeuristicRouter);
  registerModels();
  const policy = RouterPolicyRegistry.create(HEURISTIC_POLICY_KEY, {
    availableModels: ["small", "large"],
    defaultModel: "large",
  });
  assert.ok(policy instanceof HeuristicRouter);
  assert.equal(policy.selectModel(createRoutingContext({ query: "Hi", queryLength: 2 })), "small");
});
