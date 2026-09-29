// CHIEF model catalog + ModelSpec tests — the register/merge semantics come
// from OpenJarvis intelligence/model_catalog.py (commit 5e5f5ef); the
// catalog-consistency checks guard the CHIEF data (provider keys, ranks).

import test from "node:test";
import assert from "node:assert/strict";

import { ModelRegistry } from "../server/chief/core/registry.js";
import {
  BUILTIN_MODELS,
  mergeDiscoveredModels,
  registerBuiltinModels,
  registeredModelsForProvider,
} from "../server/chief/models/catalog.js";
import { BUILTIN_PROVIDERS } from "../server/chief/models/providers.js";
import {
  CAPABILITY_RANK_KEY,
  Quantization,
  REASONING_KEY,
  createModelSpec,
  createRoutingContext,
} from "../server/chief/models/types.js";

// --- ModelSpec / RoutingContext value objects --------------------------------

test("createModelSpec applies upstream defaults and freezes", () => {
  const spec = createModelSpec({
    modelId: "m",
    name: "M",
    parameterCountB: 7,
    contextLength: 4096,
  });
  assert.equal(spec.activeParameterCountB, null);
  assert.equal(spec.quantization, Quantization.NONE);
  assert.equal(spec.minVramGb, 0.0);
  assert.deepEqual(spec.supportedEngines, []);
  assert.equal(spec.provider, "");
  assert.equal(spec.requiresApiKey, false);
  assert.deepEqual(spec.metadata, {});
  assert.ok(Object.isFrozen(spec));
  assert.ok(Object.isFrozen(spec.metadata));
});

test("createModelSpec validates required fields", () => {
  assert.throws(
    () => createModelSpec({ name: "x", parameterCountB: 0, contextLength: 1 }),
    TypeError
  );
  assert.throws(
    () => createModelSpec({ modelId: "x", parameterCountB: 0, contextLength: 1 }),
    TypeError
  );
  assert.throws(
    () => createModelSpec({ modelId: "x", name: "x", parameterCountB: "0", contextLength: 1 }),
    TypeError
  );
  assert.throws(
    () =>
      createModelSpec({
        modelId: "x",
        name: "x",
        parameterCountB: 0,
        contextLength: 1,
        quantization: "q3",
      }),
    TypeError
  );
});

test("createRoutingContext applies upstream defaults", () => {
  const ctx = createRoutingContext();
  assert.equal(ctx.query, "");
  assert.equal(ctx.queryLength, 0);
  assert.equal(ctx.hasCode, false);
  assert.equal(ctx.hasMath, false);
  assert.equal(ctx.hasReasoning, false);
  assert.equal(ctx.language, "en");
  assert.equal(ctx.urgency, 0.5);
  assert.equal(ctx.complexityScore, 0.0);
  assert.equal(ctx.suggestedMaxTokens, 1024);
  assert.deepEqual(ctx.metadata, {});
});

// --- catalog data -------------------------------------------------------------

test("every built-in model is a cloud spec served by a registered provider", () => {
  const providerIds = new Set(BUILTIN_PROVIDERS.map((p) => p.id));
  assert.ok(BUILTIN_MODELS.length > 0);
  const ids = new Set();
  for (const spec of BUILTIN_MODELS) {
    assert.ok(!ids.has(spec.modelId), `duplicate model id ${spec.modelId}`);
    ids.add(spec.modelId);
    assert.equal(spec.parameterCountB, 0.0, spec.modelId);
    assert.deepEqual(spec.supportedEngines, ["cloud"], spec.modelId);
    assert.equal(spec.requiresApiKey, true, spec.modelId);
    assert.ok(providerIds.has(spec.provider), `${spec.modelId} provider '${spec.provider}'`);
    assert.ok(spec.contextLength > 0, spec.modelId);
    assert.equal(typeof spec.metadata.pricing_input, "number", spec.modelId);
    assert.equal(typeof spec.metadata.pricing_output, "number", spec.modelId);
    assert.equal(typeof spec.metadata[CAPABILITY_RANK_KEY], "number", spec.modelId);
    assert.equal(typeof spec.metadata[REASONING_KEY], "boolean", spec.modelId);
  }
});

test("Grok is the primary provider: first catalog entries are xAI and ranks are strict per provider", () => {
  assert.equal(BUILTIN_MODELS[0].provider, "xai");
  const byProvider = new Map();
  for (const spec of BUILTIN_MODELS) {
    const ranks = byProvider.get(spec.provider) ?? [];
    ranks.push(spec.metadata[CAPABILITY_RANK_KEY]);
    byProvider.set(spec.provider, ranks);
  }
  for (const [provider, ranks] of byProvider) {
    assert.equal(new Set(ranks).size, ranks.length, `${provider} ranks must be distinct`);
  }
});

// --- register_builtin_models / merge_discovered_models ------------------------

test("registerBuiltinModels populates the registry idempotently", () => {
  ModelRegistry.clear();
  registerBuiltinModels();
  assert.equal(ModelRegistry.keys().length, BUILTIN_MODELS.length);
  registerBuiltinModels();
  assert.equal(ModelRegistry.keys().length, BUILTIN_MODELS.length);
  assert.equal(ModelRegistry.get("grok-4.7").provider, "xai");
});

test("registerBuiltinModels does not overwrite an existing entry", () => {
  ModelRegistry.clear();
  const custom = createModelSpec({
    modelId: "grok-4.7",
    name: "Custom",
    parameterCountB: 0,
    contextLength: 1,
  });
  ModelRegistry.registerValue("grok-4.7", custom);
  registerBuiltinModels();
  assert.equal(ModelRegistry.get("grok-4.7"), custom);
});

test("mergeDiscoveredModels adds minimal specs only for unknown ids", () => {
  ModelRegistry.clear();
  registerBuiltinModels();
  mergeDiscoveredModels("sidecar", ["grok-4.7", "local-llm"], { provider: "sidecar" });
  assert.equal(ModelRegistry.get("grok-4.7").provider, "xai");
  const merged = ModelRegistry.get("local-llm");
  assert.equal(merged.parameterCountB, 0.0);
  assert.equal(merged.contextLength, 0);
  assert.deepEqual(merged.supportedEngines, ["sidecar"]);
  assert.equal(merged.provider, "sidecar");
});

test("registeredModelsForProvider filters by provider key", () => {
  ModelRegistry.clear();
  registerBuiltinModels();
  const xai = registeredModelsForProvider("xai");
  assert.ok(xai.includes("grok-4.7"));
  assert.ok(!xai.includes("claude-opus-4-6"));
  assert.deepEqual(registeredModelsForProvider("nobody"), []);
});
