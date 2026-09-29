// CHIEF built-in model catalog — well-known ModelSpec entries per provider.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis  (see THIRD_PARTY_NOTICES.md)
//   Source file: src/openjarvis/intelligence/model_catalog.py
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//   License text: licenses/OPENJARVIS-LICENSE-APACHE-2.0.txt
//
// Preserved upstream semantics:
//   - BUILTIN_MODELS: a static list of ModelSpec entries keyed by model_id
//   - cloud entries carry parameter_count_b=0.0, supported_engines=("cloud",),
//     requires_api_key=True and pricing in metadata (pricing_input /
//     pricing_output, USD per 1M tokens) — the shape the router's cloud tier
//     and later budget accounting read
//   - register_builtin_models(): idempotent population of ModelRegistry
//   - merge_discovered_models(engine_key, ids): minimal specs
//     (parameter_count_b=0, context_length=0) for ids not yet registered
//   - the Anthropic entries are carried over from upstream's catalog data
// Documented adaptations (CHIEF-specific reasons):
//   - Upstream's ~60 local-model entries (Ollama/vLLM/MLX/Apple FM) are not
//     carried: no local inference exists in this serverless deployment.
//     Upstream's OpenAI/Google/DeepSeek/MiniMax entries are not carried
//     because no such provider adapter is registered yet (docs/
//     CHIEF_ARCHITECTURE.md §9 Phase 6 adds the OpenAI-compatible socket);
//     adding a provider means adding its entries here, nothing else.
//   - xAI Grok entries are new catalog DATA (upstream has none). Context
//     windows and pricing were taken from https://docs.x.ai/developers/models
//     on 2026-09-29 (long-context tiers ≥200k prompt tokens double the rate
//     and are not modelled here).
//   - CHIEF metadata keys: capability_rank (router tie-break among cloud
//     models — higher is more capable) and reasoning (token-headroom flag).
//     See server/chief/models/types.js for why they live in metadata.
//   - `provider` on each spec is the ProviderRegistry key that can serve the
//     model (server/chief/models/providers.js); upstream uses the vendor name
//     only informationally.

import { ModelRegistry } from "../core/registry.js";
import { CAPABILITY_RANK_KEY, createModelSpec, REASONING_KEY } from "./types.js";

const XAI_DOCS_URL = "https://docs.x.ai/developers/models";
const ANTHROPIC_DOCS_URL = "https://docs.anthropic.com/en/docs/about-claude/models";

function cloudSpec({
  modelId,
  name,
  contextLength,
  provider,
  url,
  pricingInput,
  pricingOutput,
  rank,
  reasoning = false,
}) {
  return createModelSpec({
    modelId,
    name,
    parameterCountB: 0.0,
    contextLength,
    supportedEngines: ["cloud"],
    provider,
    requiresApiKey: true,
    metadata: {
      architecture: "proprietary",
      pricing_input: pricingInput,
      pricing_output: pricingOutput,
      url,
      [CAPABILITY_RANK_KEY]: rank,
      [REASONING_KEY]: reasoning,
    },
  });
}

export const BUILTIN_MODELS = Object.freeze([
  // -----------------------------------------------------------------------
  // Cloud models — xAI (Grok) — CHIEF primary provider
  // -----------------------------------------------------------------------
  cloudSpec({
    modelId: "grok-4.7",
    name: "Grok 4.7",
    contextLength: 500000,
    provider: "xai",
    url: XAI_DOCS_URL,
    pricingInput: 2.0,
    pricingOutput: 6.0,
    rank: 40,
    reasoning: true,
  }),
  cloudSpec({
    modelId: "grok-4.6",
    name: "Grok 4.6",
    contextLength: 500000,
    provider: "xai",
    url: XAI_DOCS_URL,
    pricingInput: 2.0,
    pricingOutput: 6.0,
    rank: 30,
    reasoning: true,
  }),
  cloudSpec({
    modelId: "grok-4.3",
    name: "Grok 4.3",
    contextLength: 1000000,
    provider: "xai",
    url: XAI_DOCS_URL,
    pricingInput: 1.25,
    pricingOutput: 2.5,
    rank: 20,
  }),
  cloudSpec({
    modelId: "grok-4.20-reasoning",
    name: "Grok 4.20 (reasoning)",
    contextLength: 1000000,
    provider: "xai",
    url: XAI_DOCS_URL,
    pricingInput: 1.25,
    pricingOutput: 2.5,
    rank: 15,
    reasoning: true,
  }),
  cloudSpec({
    modelId: "grok-4.20-non-reasoning",
    name: "Grok 4.20 (non-reasoning)",
    contextLength: 1000000,
    provider: "xai",
    url: XAI_DOCS_URL,
    pricingInput: 1.25,
    pricingOutput: 2.5,
    rank: 10,
  }),
  // -----------------------------------------------------------------------
  // Cloud models — Anthropic (upstream catalog data)
  // -----------------------------------------------------------------------
  cloudSpec({
    modelId: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    contextLength: 200000,
    provider: "anthropic",
    url: ANTHROPIC_DOCS_URL,
    pricingInput: 5.0,
    pricingOutput: 25.0,
    rank: 40,
  }),
  cloudSpec({
    modelId: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    contextLength: 200000,
    provider: "anthropic",
    url: ANTHROPIC_DOCS_URL,
    pricingInput: 3.0,
    pricingOutput: 15.0,
    rank: 30,
  }),
  cloudSpec({
    modelId: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    contextLength: 200000,
    provider: "anthropic",
    url: ANTHROPIC_DOCS_URL,
    pricingInput: 1.0,
    pricingOutput: 5.0,
    rank: 10,
  }),
]);

export function registerBuiltinModels() {
  for (const spec of BUILTIN_MODELS) {
    if (!ModelRegistry.contains(spec.modelId)) {
      ModelRegistry.registerValue(spec.modelId, spec);
    }
  }
}

export function mergeDiscoveredModels(engineKey, modelIds, { provider = "" } = {}) {
  for (const modelId of modelIds) {
    if (!ModelRegistry.contains(modelId)) {
      ModelRegistry.registerValue(
        modelId,
        createModelSpec({
          modelId,
          name: modelId,
          parameterCountB: 0.0,
          contextLength: 0,
          supportedEngines: [engineKey],
          provider,
        })
      );
    }
  }
}

export function registeredModelsForProvider(providerId) {
  return ModelRegistry.items()
    .filter(([, spec]) => spec?.provider === providerId)
    .map(([key]) => key);
}
