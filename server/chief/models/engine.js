// CHIEF model engine — the model-layer contract the orchestration layer
// (Phase 3 turn machine, agents) consumes. Composes: configured providers
// (providers.js) → AI SDK provider registry → catalog (catalog.js) → router
// (router.js). Everything above this module sees only model KEYS and AI SDK
// `LanguageModel` instances, never a vendor SDK.
//
// REUSE DIRECTLY: Vercel AI SDK (`ai`, Apache-2.0) — createProviderRegistry
//   for "provider:model" lookup and generateText for completions.
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis  (see THIRD_PARTY_NOTICES.md)
//   Source files: src/openjarvis/engine/_stubs.py (InferenceEngine surface:
//                 generate / list_models / health; engine_id, is_cloud),
//                 src/openjarvis/cli/ask.py (router integration: candidate
//                 list → preferred/fallback → build_routing_context →
//                 select_model → accept only if in candidates),
//                 src/openjarvis/agents/_stubs.py (INFERENCE_START/END
//                 payloads; `_publishes_events` handshake)
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//   License text: licenses/OPENJARVIS-LICENSE-APACHE-2.0.txt
//
// Preserved upstream semantics:
//   - generate() returns { content, usage: { prompt_tokens, completion_tokens,
//     total_tokens }, model, tool_calls, finish_reason } — the dict shape
//     every OpenJarvis engine returns and every agent consumes
//   - INFERENCE_START { model, engine } / INFERENCE_END { model, usage,
//     content, tool_calls, finish_reason } published on the injected bus;
//     `publishesEvents = true` tells the (later) agent port not to double-publish
//   - routing integration order from cli/ask.py: an explicit model wins over
//     routing; otherwise preferred = configured default if available else
//     first candidate; the selected key is used only if it is a candidate
//   - unknown/unregistered router policy → routing skipped, preferred used
// Documented adaptations (CHIEF-specific reasons):
//   - Provider transports are AI SDK providers, not ported HTTP clients
//     (audit §2.3). Model lookup goes through the AI SDK registry with
//     "provider:model" ids; catalog keys stay bare model ids so router
//     rules ("code"/"coder" tag match) and the later LearnedRouterPolicy see
//     the same keys upstream does.
//   - Only catalog models whose provider is enabled AND has credentials are
//     candidates. No candidates → ModelUnavailableError (fail closed; upstream
//     falls through to a configured local default that cannot exist here).
//   - normalizeGenerateResult drops provider-private fields (providerMetadata,
//     raw request/response bodies): möbius rule "provider-private data never
//     enters checkpoints" (docs/CHIEF_ARCHITECTURE.md §2 models/).
//   - resolve() reports `maxTokens` re-adjusted for the *selected* model in
//     addition to the upstream context (which adjusts for the preferred
//     model only); the RoutingContext itself is left as upstream computes it.
//   - `languageModelMiddleware` is passed through to the AI SDK registry: the
//     seam where ChiefBudget enforcement attaches in a later phase without
//     touching callers. Every caller — interactive turns and the future
//     autonomous loop (docs/CHIEF_ARCHITECTURE.md §5.5) — must obtain models
//     through this engine so that middleware cannot be bypassed.
//   - stream() is intentionally absent: the Phase 3 turn machine drives AI
//     SDK streamText on the resolved `languageModel` directly.
//   - Caller-agnostic contract (§5.5). resolve()/generate() do not require a
//     user chat turn: `query` is whatever text the caller is routing on (a
//     user message, an operative instruction, an event summary). An optional
//     `caller` { kind, id, trigger } is copied onto inference events so a
//     scheduled tick, an event reaction, and a delegation are auditable on
//     the same EventBus. Kinds are user_turn | schedule | event | delegation.
//     This is correlation metadata only — the engine does not schedule,
//     decide, or approve anything.
//   - CHIEF_MODELS_ENABLED=false makes resolve/generate/languageModel throw
//     ModelLayerPausedError. One pause covers prompted and autonomous use.

import { createProviderRegistry, generateText } from "ai";

import { EventType } from "../core/events.js";
import { ModelRegistry, RouterPolicyRegistry } from "../core/registry.js";
import { registerBuiltinModels } from "./catalog.js";
import { adjustTokensForModel, TOKEN_TIERS } from "./complexity.js";
import { loadModelConfig, ROUTER_POLICY_NONE } from "./config.js";
import { ensureBuiltinProvidersRegistered, instantiateProviders } from "./providers.js";
import { buildRoutingContext, ensureHeuristicRegistered } from "./router.js";

export const ENGINE_ID = "chief-ai-sdk";
const MODEL_ID_SEPARATOR = ":";

// Who asked for this inference. Kept closed so event payloads stay a stable
// contract the trace collector and the Constellation bridge can rely on.
export const CALLER_KINDS = Object.freeze({
  USER_TURN: "user_turn",
  SCHEDULE: "schedule",
  EVENT: "event",
  DELEGATION: "delegation",
});

const CALLER_KIND_VALUES = new Set(Object.values(CALLER_KINDS));

export function normalizeCaller(caller) {
  if (caller == null) return null;
  if (typeof caller !== "object" || Array.isArray(caller)) {
    throw new TypeError("caller must be an object { kind, id?, trigger? }");
  }
  if (!CALLER_KIND_VALUES.has(caller.kind)) {
    throw new TypeError(`caller.kind must be one of ${[...CALLER_KIND_VALUES].join(", ")}`);
  }
  return Object.freeze({
    kind: caller.kind,
    id: caller.id == null ? null : String(caller.id),
    trigger: caller.trigger == null ? null : String(caller.trigger),
  });
}

function withCaller(data, caller) {
  return caller ? { ...data, caller } : data;
}

export class ModelLayerPausedError extends Error {
  constructor() {
    super("CHIEF model layer is paused (CHIEF_MODELS_ENABLED=false)");
    this.name = "ModelLayerPausedError";
  }
}

export class ModelUnavailableError extends Error {
  constructor(message, { modelKey = null, candidates = [] } = {}) {
    super(message);
    this.name = "ModelUnavailableError";
    this.modelKey = modelKey;
    this.candidates = [...candidates];
  }
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
    }
  }
  return "";
}

function usageNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function normalizeGenerateResult(result, { modelKey, providerId }) {
  const usage = result?.usage ?? {};
  const promptTokens = usageNumber(usage.inputTokens);
  const completionTokens = usageNumber(usage.outputTokens);
  return {
    content: typeof result?.text === "string" ? result.text : "",
    tool_calls: (result?.toolCalls ?? []).map((call) => ({
      id: call.toolCallId ?? null,
      name: call.toolName ?? "",
      arguments: call.input ?? null,
    })),
    finish_reason: result?.finishReason ?? "",
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: usageNumber(usage.totalTokens) || promptTokens + completionTokens,
      reasoning_tokens: usageNumber(usage.outputTokenDetails?.reasoningTokens),
      cached_prompt_tokens: usageNumber(usage.inputTokenDetails?.cacheReadTokens),
    },
    model: modelKey,
    provider: providerId,
    response_model: result?.response?.modelId ?? null,
  };
}

export class ChiefModelEngine {
  constructor({
    config,
    providers,
    skippedProviders = [],
    eventBus = null,
    logger = console,
    languageModelMiddleware = undefined,
  }) {
    if (!config) throw new TypeError("ChiefModelEngine requires a config (loadModelConfig)");
    if (!(providers instanceof Map)) {
      throw new TypeError("ChiefModelEngine requires a Map of instantiated providers");
    }
    this.engineId = ENGINE_ID;
    this.isCloud = true;
    this.publishesEvents = true;
    this._config = config;
    this._providers = providers;
    this._skipped = [...skippedProviders];
    this._bus = eventBus;
    this._logger = logger;
    this._warnedPolicies = new Set();
    this._registry = createProviderRegistry(
      Object.fromEntries([...providers].map(([id, entry]) => [id, entry.instance])),
      {
        separator: MODEL_ID_SEPARATOR,
        ...(languageModelMiddleware ? { languageModelMiddleware } : {}),
      }
    );
  }

  get config() {
    return this._config;
  }

  // Catalog models served by a configured provider, in catalog order.
  listModels() {
    const allow = this._config.modelAllowlist;
    return ModelRegistry.items()
      .filter(([key, spec]) => {
        if (!spec || typeof spec.provider !== "string") return false;
        if (!this._providers.has(spec.provider)) return false;
        return allow ? allow.includes(key) : true;
      })
      .map(([key, spec]) => ({ key, spec, providerId: spec.provider }));
  }

  availableModelKeys() {
    return this.listModels().map((entry) => entry.key);
  }

  health() {
    return {
      engine: this.engineId,
      providers: [
        ...[...this._providers.values()].map(({ descriptor, credentialSource }) => ({
          id: descriptor.id,
          displayName: descriptor.displayName ?? descriptor.id,
          configured: true,
          credentialSource,
        })),
        ...this._skipped.map((entry) => ({
          id: entry.id,
          configured: false,
          reason: entry.reason,
          credentialEnv: entry.credentialEnv,
        })),
      ],
      models: this.availableModelKeys(),
      defaultModel: this._config.defaultModel,
      fallbackModel: this._config.fallbackModel,
      routerPolicy: this._config.routerPolicy,
      modelsEnabled: this._config.modelsEnabled !== false,
    };
  }

  _assertEnabled() {
    if (this._config.modelsEnabled === false) {
      throw new ModelLayerPausedError();
    }
  }

  languageModel(modelKey) {
    this._assertEnabled();
    const candidates = this.availableModelKeys();
    if (!candidates.includes(modelKey)) {
      throw new ModelUnavailableError(
        `model '${modelKey}' is not available (configured providers: ${[...this._providers.keys()].join(", ") || "none"})`,
        { modelKey, candidates }
      );
    }
    const spec = ModelRegistry.get(modelKey);
    return this._registry.languageModel(`${spec.provider}${MODEL_ID_SEPARATOR}${spec.modelId}`);
  }

  _policyFor(policyKey) {
    if (!policyKey || policyKey === ROUTER_POLICY_NONE) return null;
    if (!RouterPolicyRegistry.contains(policyKey)) {
      if (!this._warnedPolicies.has(policyKey)) {
        this._warnedPolicies.add(policyKey);
        this._logger.warn(
          `CHIEF router policy '${policyKey}' is not registered; using the default model`
        );
      }
      return null;
    }
    return policyKey;
  }

  resolve(
    query = "",
    { urgency = 0.5, model = null, routerPolicy = undefined, caller = null } = {}
  ) {
    this._assertEnabled();
    const normalizedCaller = normalizeCaller(caller);
    const candidates = this.availableModelKeys();
    if (!candidates.length) {
      throw new ModelUnavailableError(
        "no CHIEF model is available: enable a provider (CHIEF_MODEL_PROVIDERS) and set its API key",
        { candidates }
      );
    }
    const text = typeof query === "string" ? query : "";

    if (model) {
      if (!candidates.includes(model)) {
        throw new ModelUnavailableError(`requested model '${model}' is not available`, {
          modelKey: model,
          candidates,
        });
      }
      const routingContext = buildRoutingContext(text, { urgency, model });
      return this._resolution(model, routingContext, {
        routed: false,
        policy: null,
        caller: normalizedCaller,
      });
    }

    const preferred = candidates.includes(this._config.defaultModel)
      ? this._config.defaultModel
      : candidates[0];
    const fallback = candidates.includes(this._config.fallbackModel)
      ? this._config.fallbackModel
      : candidates[0];
    const routingContext = buildRoutingContext(text, { urgency, model: preferred });

    const policyKey = this._policyFor(routerPolicy ?? this._config.routerPolicy);
    let selected = preferred;
    let routed = false;
    if (policyKey) {
      const policy = RouterPolicyRegistry.create(policyKey, {
        availableModels: candidates,
        defaultModel: preferred,
        fallbackModel: fallback,
      });
      const choice = policy.selectModel(routingContext);
      if (candidates.includes(choice)) {
        selected = choice;
        routed = true;
      }
    }
    return this._resolution(selected, routingContext, {
      routed,
      policy: policyKey,
      caller: normalizedCaller,
    });
  }

  _resolution(modelKey, routingContext, { routed, policy, caller }) {
    const spec = ModelRegistry.get(modelKey);
    const tier = routingContext.metadata?.complexity_tier;
    const baseTokens = TOKEN_TIERS[tier] ?? routingContext.suggestedMaxTokens;
    return Object.freeze({
      modelKey,
      spec,
      providerId: spec.provider,
      languageModel: this.languageModel(modelKey),
      routingContext,
      maxTokens: adjustTokensForModel(baseTokens, modelKey),
      routed,
      policy,
      caller,
    });
  }

  async generate(
    messages,
    {
      model = null,
      query = undefined,
      urgency = 0.5,
      routerPolicy = undefined,
      temperature = this._config.temperature,
      maxTokens = undefined,
      tools = undefined,
      toolChoice = undefined,
      abortSignal = undefined,
      providerOptions = undefined,
      caller = null,
    } = {}
  ) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new TypeError("generate() requires a nonempty messages array");
    }
    const resolution = this.resolve(query ?? lastUserText(messages), {
      urgency,
      model,
      routerPolicy,
      caller,
    });
    const maxOutputTokens = maxTokens ?? Math.max(this._config.maxTokens, resolution.maxTokens);

    this._bus?.publish(
      EventType.INFERENCE_START,
      withCaller(
        {
          model: resolution.modelKey,
          engine: this.engineId,
          provider: resolution.providerId,
          routed: resolution.routed,
        },
        resolution.caller
      )
    );

    const result = await generateText({
      model: resolution.languageModel,
      messages,
      // Upstream engines take the system prompt as a Message(role=SYSTEM) in
      // the list; keep that calling convention for the agent port.
      allowSystemInMessages: true,
      temperature,
      maxOutputTokens,
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { toolChoice } : {}),
      ...(abortSignal ? { abortSignal } : {}),
      ...(providerOptions ? { providerOptions } : {}),
    });

    const normalized = normalizeGenerateResult(result, {
      modelKey: resolution.modelKey,
      providerId: resolution.providerId,
    });

    this._bus?.publish(
      EventType.INFERENCE_END,
      withCaller(
        {
          model: normalized.model,
          usage: normalized.usage,
          content: normalized.content,
          tool_calls: normalized.tool_calls,
          finish_reason: normalized.finish_reason,
        },
        resolution.caller
      )
    );

    return normalized;
  }
}

// Factory used by the API shell and scripts: reads configuration from `env`,
// registers built-in providers/models/policies (idempotent), instantiates the
// configured providers, and returns a ready engine.
export function createModelEngine({
  env = process.env,
  eventBus = null,
  logger = console,
  fetch = undefined,
  languageModelMiddleware = undefined,
  config = undefined,
} = {}) {
  ensureBuiltinProvidersRegistered();
  registerBuiltinModels();
  ensureHeuristicRegistered();
  const resolvedConfig = config ?? loadModelConfig(env);
  const { active, skipped } = instantiateProviders({
    env,
    enabledIds: resolvedConfig.enabledProviders,
    fetch,
  });
  return new ChiefModelEngine({
    config: resolvedConfig,
    providers: active,
    skippedProviders: skipped,
    eventBus,
    logger,
    languageModelMiddleware,
  });
}
