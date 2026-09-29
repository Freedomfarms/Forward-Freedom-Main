// CHIEF model-layer types — ModelSpec and RoutingContext value objects.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis  (see THIRD_PARTY_NOTICES.md)
//   Source file: src/openjarvis/core/types.py (ModelSpec, Quantization, RoutingContext)
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//   License text: licenses/OPENJARVIS-LICENSE-APACHE-2.0.txt
//
// Preserved upstream semantics:
//   - ModelSpec field set and defaults: model_id, name, parameter_count_b,
//     context_length (required); active_parameter_count_b=None,
//     quantization=NONE, min_vram_gb=0.0, supported_engines=(), provider="",
//     requires_api_key=False, metadata={}
//   - Quantization enum values, verbatim
//   - RoutingContext field set and defaults: query="", query_length=0,
//     has_code/has_math/has_reasoning=False, language="en", urgency=0.5,
//     complexity_score=0.0, suggested_max_tokens=1024, metadata={}
// Documented adaptations (CHIEF-specific reasons):
//   - Python dataclasses become frozen plain objects built by factory
//     functions with camelCase keys (JS convention established in Phase 1).
//     Keys inside `metadata` (e.g. "pricing_input", "complexity_tier",
//     "signals") keep upstream's snake_case verbatim because they are data
//     that later ports (traces, LearnedRouterPolicy) read back.
//   - Required fields are validated at construction (dataclasses trust the
//     caller); a catalog entry with a missing id must not reach the router.
//   - CHIEF-specific metadata keys used by the router adaptation are named
//     here as constants so no module hard-codes the strings:
//       CAPABILITY_RANK_KEY  — relative capability ordering among cloud
//                              models (upstream has no such ordering; see
//                              server/chief/models/router.js)
//       REASONING_KEY        — catalog-declared chain-of-thought model
//                              (extends upstream's name-pattern detection;
//                              see server/chief/models/complexity.js)

export const Quantization = Object.freeze({
  NONE: "none",
  FP8: "fp8",
  INT8: "int8",
  INT4: "int4",
  GGUF_Q4: "gguf_q4",
  GGUF_Q8: "gguf_q8",
});

const QUANTIZATION_VALUES = new Set(Object.values(Quantization));

export const CAPABILITY_RANK_KEY = "capability_rank";
export const REASONING_KEY = "reasoning";

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`ModelSpec.${field} must be a nonempty string`);
  }
  return value;
}

function requireFiniteNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`ModelSpec.${field} must be a finite number`);
  }
  return value;
}

export function createModelSpec({
  modelId,
  name,
  parameterCountB,
  contextLength,
  activeParameterCountB = null,
  quantization = Quantization.NONE,
  minVramGb = 0.0,
  supportedEngines = [],
  provider = "",
  requiresApiKey = false,
  metadata = {},
} = {}) {
  requireNonEmptyString(modelId, "modelId");
  requireNonEmptyString(name, "name");
  requireFiniteNumber(parameterCountB, "parameterCountB");
  requireFiniteNumber(contextLength, "contextLength");
  if (activeParameterCountB !== null) {
    requireFiniteNumber(activeParameterCountB, "activeParameterCountB");
  }
  if (!QUANTIZATION_VALUES.has(quantization)) {
    throw new TypeError(`ModelSpec.quantization must be one of ${[...QUANTIZATION_VALUES]}`);
  }
  if (!Array.isArray(supportedEngines) || supportedEngines.some((e) => typeof e !== "string")) {
    throw new TypeError("ModelSpec.supportedEngines must be an array of strings");
  }
  if (typeof provider !== "string") {
    throw new TypeError("ModelSpec.provider must be a string");
  }
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new TypeError("ModelSpec.metadata must be an object");
  }
  return Object.freeze({
    modelId,
    name,
    parameterCountB,
    contextLength,
    activeParameterCountB,
    quantization,
    minVramGb,
    supportedEngines: Object.freeze([...supportedEngines]),
    provider,
    requiresApiKey: Boolean(requiresApiKey),
    metadata: Object.freeze({ ...metadata }),
  });
}

export function createRoutingContext({
  query = "",
  queryLength = 0,
  hasCode = false,
  hasMath = false,
  hasReasoning = false,
  language = "en",
  urgency = 0.5,
  complexityScore = 0.0,
  suggestedMaxTokens = 1024,
  metadata = {},
} = {}) {
  return Object.freeze({
    query,
    queryLength,
    hasCode: Boolean(hasCode),
    hasMath: Boolean(hasMath),
    hasReasoning: Boolean(hasReasoning),
    language,
    urgency,
    complexityScore,
    suggestedMaxTokens,
    metadata: { ...metadata },
  });
}
