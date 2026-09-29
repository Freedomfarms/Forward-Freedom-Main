// CHIEF model-layer configuration — the only place provider/model settings
// are read from the environment.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis  (see THIRD_PARTY_NOTICES.md)
//   Source file: src/openjarvis/core/config.py (IntelligenceConfig,
//                RoutingLearningConfig)
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//   License text: licenses/OPENJARVIS-LICENSE-APACHE-2.0.txt
//
// Preserved upstream semantics:
//   - IntelligenceConfig.default_model / fallback_model and the generation
//     defaults temperature=0.7, max_tokens=1024
//   - RoutingLearningConfig.policy (default "heuristic")
// Documented adaptations (CHIEF-specific reasons):
//   - Upstream reads a TOML file under ~/.openjarvis; a serverless deployment
//     has no home directory, so settings come from environment variables
//     (all CHIEF_-prefixed) with the same defaults. The `env` object is
//     injected so tests never touch process.env.
//   - enabledProviders (CHIEF_MODEL_PROVIDERS) is new: upstream enables every
//     cloud vendor whose key exists. CHIEF is Grok-primary by policy, so only
//     "xai" is enabled unless an operator opts more in — the Anthropic
//     platform key must not silently pull Module 01's vendor into CHIEF.
//   - modelAllowlist (CHIEF_MODEL_ALLOWLIST) generalizes the CLI's candidate
//     list (cli/ask.py builds candidates from the configured presets).
//   - routerPolicy "none" disables routing (always default model); upstream
//     achieves this by not configuring a policy.
//   - Provider secrets are NOT part of this object; providers.js resolves
//     them from the same `env` at instantiation time so the config can be
//     logged and serialized.
//   - modelsEnabled (CHIEF_MODELS_ENABLED, default true) is the model-layer
//     pause/kill switch (docs/CHIEF_ARCHITECTURE.md §5.5, §10). It gates every
//     caller — a user turn and a future scheduled tick alike — so autonomous
//     runs cannot keep reasoning after the layer is paused.

export const DEFAULT_ENABLED_PROVIDERS = Object.freeze(["xai"]);
export const DEFAULT_MODEL = "grok-4.7";
export const DEFAULT_FALLBACK_MODEL = "grok-4.6";
export const DEFAULT_ROUTER_POLICY = "heuristic";
export const ROUTER_POLICY_NONE = "none";
export const DEFAULT_TEMPERATURE = 0.7;
export const DEFAULT_MAX_TOKENS = 1024;

function csv(value) {
  if (typeof value !== "string") return null;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : null;
}

function nonEmpty(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function numberOr(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanOr(value, fallback, name) {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new RangeError(`${name} must be true or false`);
}

export function loadModelConfig(env = process.env) {
  const config = {
    enabledProviders: csv(env.CHIEF_MODEL_PROVIDERS) ?? [...DEFAULT_ENABLED_PROVIDERS],
    defaultModel: nonEmpty(env.CHIEF_DEFAULT_MODEL, DEFAULT_MODEL),
    fallbackModel: nonEmpty(env.CHIEF_FALLBACK_MODEL, DEFAULT_FALLBACK_MODEL),
    routerPolicy: nonEmpty(env.CHIEF_ROUTER_POLICY, DEFAULT_ROUTER_POLICY),
    modelAllowlist: csv(env.CHIEF_MODEL_ALLOWLIST),
    temperature: numberOr(env.CHIEF_MODEL_TEMPERATURE, DEFAULT_TEMPERATURE),
    maxTokens: numberOr(env.CHIEF_MODEL_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    modelsEnabled: booleanOr(env.CHIEF_MODELS_ENABLED, true, "CHIEF_MODELS_ENABLED"),
  };
  if (config.temperature < 0 || config.temperature > 2) {
    throw new RangeError("CHIEF_MODEL_TEMPERATURE must be between 0 and 2");
  }
  if (!Number.isInteger(config.maxTokens) || config.maxTokens <= 0) {
    throw new RangeError("CHIEF_MODEL_MAX_TOKENS must be a positive integer");
  }
  return Object.freeze({
    ...config,
    enabledProviders: Object.freeze(config.enabledProviders),
    modelAllowlist: config.modelAllowlist ? Object.freeze(config.modelAllowlist) : null,
  });
}
