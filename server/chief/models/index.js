// CHIEF model layer — public surface (docs/CHIEF_ARCHITECTURE.md §2 `models/`).
//
// The orchestration layer depends on this module only:
//   createModelEngine(...) → engine.resolve(query) → { modelKey, languageModel, ... }
// and on the AI SDK `LanguageModel` interface the resolution hands back.
// Provider SDKs (@ai-sdk/xai, @ai-sdk/anthropic, ...) are private to
// providers.js; adding a provider never changes this surface.

export {
  Quantization,
  CAPABILITY_RANK_KEY,
  REASONING_KEY,
  createModelSpec,
  createRoutingContext,
} from "./types.js";
export {
  TOKEN_TIERS,
  scoreComplexity,
  isThinkingModel,
  isReasoningModel,
  adjustTokensForModel,
  ComplexityQueryAnalyzer,
} from "./complexity.js";
export { QueryClass, classifyQuery } from "./classify.js";
export {
  HEURISTIC_POLICY_KEY,
  RouterPolicy,
  QueryAnalyzer,
  HeuristicRouter,
  DefaultQueryAnalyzer,
  buildRoutingContext,
  ensureHeuristicRegistered,
} from "./router.js";
export {
  BUILTIN_MODELS,
  MODEL_GROUP_LABELS,
  registerBuiltinModels,
  mergeDiscoveredModels,
  registeredModelsForProvider,
  projectConfiguredModels,
} from "./catalog.js";
export {
  XAI_PROVIDER_ID,
  ANTHROPIC_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  BUILTIN_PROVIDERS,
  xaiProviderDescriptor,
  anthropicProviderDescriptor,
  openaiProviderDescriptor,
  validateProviderDescriptor,
  ensureBuiltinProvidersRegistered,
  resolveProviderCredentials,
  describeProviderCredentials,
  instantiateProviders,
} from "./providers.js";
export {
  DEFAULT_ENABLED_PROVIDERS,
  DEFAULT_MODEL,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_ROUTER_POLICY,
  ROUTER_POLICY_NONE,
  loadModelConfig,
} from "./config.js";
export {
  BudgetExceededError,
  MemoryBudgetStore,
  PrismaBudgetStore,
  estimateCallUsd,
  periodWindowStart,
} from "./budget.js";
export {
  ENGINE_ID,
  CALLER_KINDS,
  normalizeCaller,
  ModelUnavailableError,
  ModelLayerPausedError,
  ChiefModelEngine,
  createModelEngine,
  normalizeGenerateResult,
} from "./engine.js";
