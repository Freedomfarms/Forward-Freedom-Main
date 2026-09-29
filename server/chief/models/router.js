// CHIEF heuristic model router — selects a model key from query characteristics.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis  (see THIRD_PARTY_NOTICES.md)
//   Source files: src/openjarvis/learning/routing/router.py,
//                 src/openjarvis/learning/routing/heuristic_policy.py,
//                 src/openjarvis/learning/_stubs.py (RouterPolicy, QueryAnalyzer)
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//   License text: licenses/OPENJARVIS-LICENSE-APACHE-2.0.txt
//
// Preserved upstream semantics:
//   - RouterPolicy contract: selectModel(context) → model key (string)
//   - HeuristicRouter rule order, verbatim:
//       5. urgency > 0.8            → smallest model (overrides everything)
//       1. has_code                 → first key containing "code" then
//                                     "coder"; else largest model
//       2. complexity_score <= 0.20 → smallest model (checked BEFORE math so
//                                     "calculate 2+2" does not escalate)
//       3. has_math                 → largest model
//       4. complexity_score >= 0.55 or has_reasoning → largest model
//       6. default_model if available → fallback_model if available →
//          available[0]
//   - empty available list → default || fallback || ""
//   - available_models defaults to every key in ModelRegistry
//   - _model_rank tiers: positive parameter count → (1, size); a "cloud"
//     supported engine → (2, ·) so an explicitly cloud-backed model is never
//     treated as smaller than a known local model; unknown → (0, 0)
//   - _smallest_model considers only positive parameter counts
//   - _find_model_by_tag is a case-insensitive substring match on the key
//   - build_routing_context populates RoutingContext from score_complexity
//     and adjusts the token budget for the preferred model
//   - DefaultQueryAnalyzer semantics (urgency/model coercion)
//   - heuristic_policy.ensure_registered(): idempotent registration under
//     the key "heuristic" in RouterPolicyRegistry
// Documented adaptations (CHIEF-specific reasons):
//   - Cloud tie-break. Upstream ranks every cloud model identically at
//     (2, 0.0) because cloud vendors publish no parameter counts, so with a
//     cloud-only catalog "largest" and "smallest" both degrade to "first
//     available". CHIEF's catalog is cloud-only (Grok primary), so the
//     second tuple element for cloud models is ModelSpec.metadata
//     [CAPABILITY_RANK_KEY] (default 0 — identical to upstream when unset),
//     and _smallest_model falls back to the lowest capability rank ONLY when
//     no candidate has a positive parameter count. Upstream orderings for
//     local models, and local-vs-cloud precedence, are unchanged.
//   - Python's `(tier, size)` tuple comparison is spelled out as compareRank.
//   - RouterPolicy/QueryAnalyzer ABCs become base classes whose abstract
//     methods throw; JS has no abstract-instantiation check.

import { ModelRegistry, RouterPolicyRegistry } from "../core/registry.js";
import { adjustTokensForModel, coerceUrgency, scoreComplexity } from "./complexity.js";
import { CAPABILITY_RANK_KEY, createRoutingContext } from "./types.js";

export const HEURISTIC_POLICY_KEY = "heuristic";

export class RouterPolicy {
  // eslint-disable-next-line no-unused-vars
  selectModel(context) {
    throw new TypeError(`${this.constructor.name} must implement selectModel(context)`);
  }
}

export class QueryAnalyzer {
  // eslint-disable-next-line no-unused-vars
  analyze(query, options = {}) {
    throw new TypeError(`${this.constructor.name} must implement analyze(query, options)`);
  }
}

export function buildRoutingContext(query, { urgency = 0.5, model = null } = {}) {
  const result = scoreComplexity(query);
  const tokens = adjustTokensForModel(result.suggestedMaxTokens, model);
  return createRoutingContext({
    query,
    queryLength: query.length,
    hasCode: result.signals.has_code,
    hasMath: result.signals.has_math,
    hasReasoning: result.signals.has_reasoning,
    urgency,
    complexityScore: result.score,
    suggestedMaxTokens: tokens,
    metadata: { complexity_tier: result.tier, signals: result.signals },
  });
}

function specFor(key) {
  return ModelRegistry.contains(key) ? ModelRegistry.get(key) : null;
}

function modelSize(key) {
  const size = specFor(key)?.parameterCountB;
  return typeof size === "number" && Number.isFinite(size) ? size : 0.0;
}

function capabilityRank(spec) {
  const rank = Number(spec?.metadata?.[CAPABILITY_RANK_KEY]);
  return Number.isFinite(rank) ? rank : 0.0;
}

export function modelRank(key) {
  const spec = specFor(key);
  if (!spec) return [0, 0.0];
  const size = spec.parameterCountB;
  if (typeof size === "number" && size > 0) return [1, size];
  if (Array.isArray(spec.supportedEngines) && spec.supportedEngines.includes("cloud")) {
    return [2, capabilityRank(spec)];
  }
  return [0, 0.0];
}

function compareRank(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
}

export function findModelByTag(available, tag) {
  const tagLower = tag.toLowerCase();
  for (const key of available) {
    if (key.toLowerCase().includes(tagLower)) return key;
  }
  return null;
}

export function largestModel(available) {
  if (!available.length) return null;
  let best = available[0];
  let bestRank = modelRank(best);
  for (const key of available.slice(1)) {
    const rank = modelRank(key);
    if (compareRank(rank, bestRank) > 0) {
      best = key;
      bestRank = rank;
    }
  }
  return best;
}

export function smallestModel(available) {
  if (!available.length) return null;
  let best = available[0];
  let bestSize = modelSize(best) || Infinity;
  for (const key of available.slice(1)) {
    const size = modelSize(key);
    if (size > 0 && size < bestSize) {
      best = key;
      bestSize = size;
    }
  }
  if (bestSize !== Infinity) return best;

  // CHIEF adaptation: no candidate publishes a parameter count. Among
  // cloud-backed candidates pick the lowest capability rank; ties (and the
  // all-unranked case, i.e. upstream data) keep the first available.
  let cheapest = null;
  let cheapestRank = Infinity;
  for (const key of available) {
    const rank = modelRank(key);
    if (rank[0] !== 2) continue;
    if (rank[1] < cheapestRank) {
      cheapest = key;
      cheapestRank = rank[1];
    }
  }
  return cheapest ?? available[0];
}

export class HeuristicRouter extends RouterPolicy {
  constructor({ availableModels = null, defaultModel = "", fallbackModel = "" } = {}) {
    super();
    this._available = Array.isArray(availableModels) ? [...availableModels] : [];
    this._default = defaultModel;
    this._fallback = fallbackModel;
  }

  get availableModels() {
    return [...this._available];
  }

  selectModel(context) {
    const available = this._available.length ? this._available : ModelRegistry.keys();
    if (!available.length) {
      return this._default || this._fallback || "";
    }

    // Rule 5: High urgency overrides everything → smallest model
    if (context.urgency > 0.8) {
      return smallestModel(available) || available[0];
    }

    // Rule 1: Code detected → prefer model with code/coder in name
    if (context.hasCode) {
      const codeModel = findModelByTag(available, "code") || findModelByTag(available, "coder");
      if (codeModel) return codeModel;
      // Fall through to larger model for code
      return largestModel(available) || available[0];
    }

    // Rule 2: Low complexity → prefer smaller model (checked before the math
    // rule so simple arithmetic doesn't escalate to the largest model)
    if (context.complexityScore <= 0.2) {
      return smallestModel(available) || available[0];
    }

    // Rule 3: Math detected → prefer larger model
    if (context.hasMath) {
      return largestModel(available) || available[0];
    }

    // Rule 4: High complexity or reasoning → prefer larger model
    if (context.complexityScore >= 0.55 || context.hasReasoning) {
      return largestModel(available) || available[0];
    }

    // Rule 6: Default fallback
    if (this._default && available.includes(this._default)) return this._default;
    if (this._fallback && available.includes(this._fallback)) return this._fallback;
    return available[0];
  }
}

export class DefaultQueryAnalyzer extends QueryAnalyzer {
  analyze(query, { urgency = 0.5, model = null } = {}) {
    return buildRoutingContext(query, {
      urgency: coerceUrgency(urgency),
      model: typeof model === "string" ? model : null,
    });
  }
}

// heuristic_policy.ensure_registered(): idempotent, runs at import upstream.
export function ensureHeuristicRegistered() {
  if (!RouterPolicyRegistry.contains(HEURISTIC_POLICY_KEY)) {
    RouterPolicyRegistry.registerValue(HEURISTIC_POLICY_KEY, HeuristicRouter);
  }
}

ensureHeuristicRegistered();
