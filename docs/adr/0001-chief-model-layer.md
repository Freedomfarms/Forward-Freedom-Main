# ADR-0001: CHIEF model layer — provider registry, Grok transport, router port

- Status: proposed (Phase 2 deliverable, awaiting review)
- Date: 2026-09-29
- Scope: CHIEF (Module 03), `server/chief/models/**`

## Context

[CHIEF_ARCHITECTURE.md](../CHIEF_ARCHITECTURE.md) §2 (`server/chief/models`) and §9 Phase 2
call for: an AI SDK provider registry with xAI Grok as the primary provider, a PORT of the
OpenJarvis `HeuristicRouter` + complexity scorer, and a model catalog. The audit
([CHIEF_GITHUB_REUSE_AUDIT.md](../CHIEF_GITHUB_REUSE_AUDIT.md) §2.3) classifies the
OpenJarvis engine zoo as **REUSE DIRECTLY via the Vercel AI SDK** and the routing logic as
**PORT/ADAPT**. This ADR records the CHIEF-specific adaptations made while porting, and the
decisions that keep the layer provider-agnostic.

## Reuse check (mandatory)

| Concern                    | Decision                                                                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider transports        | **REUSE DIRECTLY**: `@ai-sdk/xai` (new dep, Apache-2.0) and the pre-existing `@ai-sdk/anthropic`. No HTTP client code written.                                                                                                                                                |
| "provider:model" lookup    | **REUSE DIRECTLY**: `createProviderRegistry` from `ai`. Its `languageModelMiddleware` option is retained as the seam for later budget enforcement.                                                                                                                            |
| Completion call            | **REUSE DIRECTLY**: `generateText` from `ai`; result normalized to the OpenJarvis engine dict shape.                                                                                                                                                                          |
| Registry of providers      | **PORT/ADAPT**: `ProviderRegistry` is a two-line subclass of the Phase 1 `RegistryBase` (upstream `EngineRegistry`).                                                                                                                                                          |
| Router, scorer, classifier | **PORT/ADAPT** of `learning/routing/router.py`, `complexity.py`, `_utils.py`, `heuristic_policy.py`, `learning/_stubs.py` at commit `5e5f5ef`. Rule order, thresholds, regexes, weights, tiers and registration key preserved verbatim; upstream tests translated.            |
| Catalog                    | **PORT/ADAPT** of `intelligence/model_catalog.py` semantics (`register_builtin_models`, `merge_discovered_models`, cloud spec shape). Anthropic rows are upstream data; xAI rows are new data (upstream has none).                                                            |
| Configuration              | **PORT/ADAPT** of `core/config.py` `IntelligenceConfig`/`RoutingLearningConfig` defaults; storage moves from TOML to `CHIEF_*` environment variables.                                                                                                                         |
| BUILD NEW                  | Only the provider _descriptor_ contract (`{ id, credentialEnv, baseUrlEnv, create }`) and credential resolution. Reason: the AI SDK exposes no notion of "which env var unlocks this provider" or of credential-status diagnostics, and upstream's equivalent is Python-only. |

## Decision

1. **Provider abstraction.** A provider is a frozen descriptor registered in `ProviderRegistry`.
   Its `create()` must return an AI SDK provider (anything exposing `languageModel(id)`).
   `instantiateProviders` enables only providers listed in `CHIEF_MODEL_PROVIDERS` **and**
   holding a credential; unknown ids fail closed, missing credentials are reported (not
   thrown). Adding a provider = descriptor + catalog rows; router and engine are untouched
   (proved in `test/chief-model-engine.test.js` with two fake providers).
2. **Credential boundary.** Secrets are read only in `providers.js`, only from the injected
   `env`, and only leave as the provider instance. Diagnostics (`health()`,
   `describeProviderCredentials`) carry the variable _name_, never the value. `CHIEF_`-prefixed
   variables take precedence over platform ones.
3. **Grok-primary, not Grok-only.** Default `CHIEF_MODEL_PROVIDERS=xai`; Anthropic is
   registered but opt-in so Module 01's platform key does not silently pull its vendor into
   CHIEF. `CHIEF_DEFAULT_MODEL=grok-4.7`, `CHIEF_FALLBACK_MODEL=grok-4.6`.
4. **Router contract.** `engine.resolve(query, { urgency, model, routerPolicy })` returns
   `{ modelKey, spec, providerId, languageModel, routingContext, maxTokens, routed, policy }`.
   The orchestration layer depends on this object and the AI SDK `LanguageModel` interface
   only.
5. **Documented adaptations of upstream routing semantics** (each additive; behaviour is
   identical to upstream when the CHIEF metadata is absent):
   - _Cloud tie-break._ Upstream ranks every cloud model at `(2, 0.0)` (no parameter counts),
     so a cloud-only catalog degrades "largest"/"smallest" to "first available". CHIEF uses
     `ModelSpec.metadata.capability_rank` as the second tuple element for cloud models and, in
     `smallestModel`, falls back to the lowest rank **only** when no candidate has a positive
     parameter count. Local ordering and local-vs-cloud precedence are unchanged.
   - _Catalog-declared reasoning models._ `adjustTokensForModel` honours
     `ModelSpec.metadata.reasoning` in addition to upstream's name-pattern list (which predates
     Grok 4.x). `isThinkingModel` itself is verbatim.
   - _Selected-model token budget._ `resolve()` additionally reports `maxTokens` re-adjusted
     for the model actually selected; the `RoutingContext` keeps upstream's preferred-model
     adjustment.
   - _Routing skipped, not failed, on an unregistered policy_ (upstream CLI behaviour), warned
     once per process; `CHIEF_ROUTER_POLICY=none` disables routing.
   - _Fail closed on no candidates._ Upstream falls through to a local default that cannot
     exist here; CHIEF throws `ModelUnavailableError`.
6. **Provider-private data never enters CHIEF state** (möbius rule adopted in the
   architecture): `normalizeGenerateResult` drops `providerMetadata` and raw request/response
   bodies.

## Consequences

- Positive: one place to add providers; routing is provider-agnostic; orchestration (Phase 3)
  can be written against `resolve()`/`LanguageModel` and never import a vendor SDK; catalog
  data (pricing per 1M tokens) is already in the shape budget accounting needs.
- Negative / follow-ups:
  - `ChiefBudget` enforcement (architecture §9 Phase 2 bullet) is **deferred**: the seam
    (`languageModelMiddleware`) exists, but no DB-backed check is wired. Track for Phase 3/8.
  - `@ai-sdk/xai@5` pulls a nested `@ai-sdk/provider@4.0.19` next to `ai@7`'s `4.0.3`
    (same major; duck-typed `specificationVersion: "v4"`). Bump `ai` when convenient to
    dedupe.
  - The xAI catalog rows (context windows, pricing, `capability_rank`) are operator-maintained
    data verified against docs.x.ai on 2026-09-29; long-context (≥200k prompt) pricing tiers
    are not modelled.
  - `THIRD_PARTY_NOTICES.md` updated (Phase 2 ported modules; `@ai-sdk/xai` installed);
    `.env.example` documents the `CHIEF_*` variables.
- The same engine is the reasoning step of the future autonomous loop. That loop,
  its constraints, and the caller/pause contract are recorded in
  [ADR-0002](./0002-chief-autonomous-loop.md).
