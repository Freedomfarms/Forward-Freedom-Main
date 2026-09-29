// CHIEF query complexity analyzer — scores queries and suggests token budgets.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis  (see THIRD_PARTY_NOTICES.md)
//   Source file: src/openjarvis/learning/routing/complexity.py
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//   License text: licenses/OPENJARVIS-LICENSE-APACHE-2.0.txt
//
// Preserved upstream semantics:
//   - every signal regex (code, math, reasoning, multi-step, creative,
//     thinking-model names), verbatim, including case-insensitivity and the
//     DOTALL flag on the multi-step pattern
//   - the weighted score: length 0.20 · domain 0.25 · reasoning 0.25 ·
//     multi-part 0.15 · creative 0.15, with the exact per-signal step values,
//     clamped to [0, 1] and rounded to 3 decimals
//   - tier thresholds (<0.15 trivial, <0.30 simple, <0.55 moderate,
//     <0.80 complex, else very_complex) and the token budget per tier
//   - the `signals` record keys, verbatim (snake_case: they are data that the
//     trace store and the later LearnedRouterPolicy port read back)
//   - is_thinking_model / adjust_tokens_for_model (×2 headroom)
//   - ComplexityQueryAnalyzer: urgency passthrough with non-numeric → 0.5,
//     model passthrough with non-string → null, metadata { complexity_tier,
//     signals }
// Documented adaptations (CHIEF-specific reasons):
//   - adjustTokensForModel also honors a catalog-declared reasoning flag
//     (ModelSpec.metadata[REASONING_KEY]) in addition to upstream's
//     name-pattern list. Upstream's list predates the Grok 4.x family, whose
//     reasoning tokens are billed as output tokens exactly like the models the
//     rule was written for; extending the *regex* would fork upstream text,
//     so the catalog carries the flag instead. isThinkingModel itself stays
//     verbatim.
//   - Python `re.findall` counts become `String.prototype.match` counts.

import { ModelRegistry } from "../core/registry.js";
import { createRoutingContext, REASONING_KEY } from "./types.js";

// ---------------------------------------------------------------------------
// Signal patterns (verbatim from upstream)
// ---------------------------------------------------------------------------

const CODE_PATTERNS =
  /```|`[^`]+`|\bdef\s|\bclass\s|\bimport\s|\bfunction\s|\bconst\s|\bvar\s|\blet\s|\bif\s*\(|->|=>|\{\s*\}|\bfor\s+\w+\s+in\s|#include|System\.out/i;
const MATH_PATTERNS =
  /\bsolve\b|\bintegral\b|\bequation\b|\bproof\b|\bderivative\b|\bmatrix\b|\btheorem\b|\bcalculate\b|\bcompute\b|\bsigma\b|\bsum\b|\blimit\b|\bprobability\b/i;
const REASONING_PATTERNS =
  /\bexplain\b|\banalyze\b|\bcompare\b|\bwhy\b|\bstep[- ]by[- ]step\b|\breason\b|\bthink\b|\bpros\s+and\s+cons\b|\btrade-?\s*offs?\b|\bevaluate\b/i;
const MULTI_STEP_PATTERNS =
  /\bthen\b.*\bthen\b|\bfirst\b.*\bnext\b|\bstep\s*\d|\b(?:and\s+also|additionally|furthermore)\b|\b\d+\.\s/is;
const CREATIVE_PATTERNS =
  /\bwrite\b.*\b(?:essay|story|article|report|poem)\b|\bgenerate\b.*\b(?:code|script|program)\b|\bcreate\b|\bdesign\b|\bdraft\b|\bcompose\b/i;

// Models known to use internal chain-of-thought that consumes output tokens.
const THINKING_MODEL_PATTERNS = /qwen3\.5|qwq|deepseek-r1|o1-|o3-|o4-/i;

// ---------------------------------------------------------------------------
// Token budget tiers
// ---------------------------------------------------------------------------

export const TOKEN_TIERS = Object.freeze({
  trivial: 1024, // greetings, yes/no, factoid lookups
  simple: 2048, // short answers, definitions
  moderate: 4096, // explanations, summaries
  complex: 8192, // analysis, code generation, multi-step
  very_complex: 16384, // long-form, multi-part reasoning
});

// Thinking models need extra headroom for internal chain-of-thought.
const THINKING_TOKEN_MULTIPLIER = 2;

// ---------------------------------------------------------------------------
// Complexity scoring
// ---------------------------------------------------------------------------

function countQuestions(query) {
  return (query.match(/\?/g) || []).length;
}

function countSubTasks(query) {
  const numbered = (query.match(/^\s*\d+[.)]\s/gm) || []).length;
  const bulleted = (query.match(/^\s*[-*]\s/gm) || []).length;
  return numbered + bulleted;
}

export function scoreComplexity(query) {
  if (typeof query !== "string") {
    throw new TypeError("scoreComplexity expects a string query");
  }
  const signals = {};
  let score = 0.0;

  // --- Length signal (0–0.20) ---
  const length = query.length;
  let lengthScore;
  if (length < 20) lengthScore = 0.0;
  else if (length < 100) lengthScore = 0.3;
  else if (length < 300) lengthScore = 0.6;
  else if (length < 800) lengthScore = 0.8;
  else lengthScore = 1.0;
  signals.length = lengthScore;
  score += 0.2 * lengthScore;

  // --- Domain signals (0–0.25) ---
  const hasCode = CODE_PATTERNS.test(query);
  const hasMath = MATH_PATTERNS.test(query);
  let domainScore = 0.0;
  if (hasCode) domainScore = Math.max(domainScore, 0.7);
  if (hasMath) domainScore = Math.max(domainScore, 0.8);
  if (hasCode && hasMath) domainScore = 1.0;
  signals.domain = domainScore;
  signals.has_code = hasCode;
  signals.has_math = hasMath;
  score += 0.25 * domainScore;

  // --- Reasoning signal (0–0.25) ---
  const hasReasoning = REASONING_PATTERNS.test(query);
  const hasMultiStep = MULTI_STEP_PATTERNS.test(query);
  let reasoningScore = 0.0;
  if (hasReasoning) reasoningScore = 0.6;
  if (hasMultiStep) reasoningScore = Math.max(reasoningScore, 0.8);
  if (hasReasoning && hasMultiStep) reasoningScore = 1.0;
  signals.reasoning = reasoningScore;
  signals.has_reasoning = hasReasoning;
  signals.has_multi_step = hasMultiStep;
  score += 0.25 * reasoningScore;

  // --- Question / sub-task count (0–0.15) ---
  const nQuestions = countQuestions(query);
  const nSubtasks = countSubTasks(query);
  const multiPart = nQuestions + nSubtasks;
  let multiScore;
  if (multiPart <= 1) multiScore = 0.0;
  else if (multiPart <= 3) multiScore = 0.5;
  else multiScore = 1.0;
  signals.multi_part = multiScore;
  signals.n_questions = nQuestions;
  signals.n_subtasks = nSubtasks;
  score += 0.15 * multiScore;

  // --- Creative / generative signal (0–0.15) ---
  const hasCreative = CREATIVE_PATTERNS.test(query);
  const creativeScore = hasCreative ? 0.7 : 0.0;
  signals.creative = creativeScore;
  signals.has_creative = hasCreative;
  score += 0.15 * creativeScore;

  // Clamp
  score = Math.max(0.0, Math.min(1.0, score));

  // Map to tier
  let tier;
  if (score < 0.15) tier = "trivial";
  else if (score < 0.3) tier = "simple";
  else if (score < 0.55) tier = "moderate";
  else if (score < 0.8) tier = "complex";
  else tier = "very_complex";

  return Object.freeze({
    score: Math.round(score * 1000) / 1000,
    tier,
    suggestedMaxTokens: TOKEN_TIERS[tier],
    signals: Object.freeze(signals),
  });
}

export function isThinkingModel(modelName) {
  return typeof modelName === "string" && THINKING_MODEL_PATTERNS.test(modelName);
}

// CHIEF adaptation: a registered catalog entry may declare itself a reasoning
// model; upstream's name-pattern list is honored unchanged first.
export function isReasoningModel(modelName) {
  if (isThinkingModel(modelName)) return true;
  if (typeof modelName !== "string" || !ModelRegistry.contains(modelName)) return false;
  const spec = ModelRegistry.get(modelName);
  return Boolean(spec?.metadata?.[REASONING_KEY]);
}

export function adjustTokensForModel(suggested, modelName = null) {
  if (modelName && isReasoningModel(modelName)) {
    return suggested * THINKING_TOKEN_MULTIPLIER;
  }
  return suggested;
}

// ---------------------------------------------------------------------------
// QueryAnalyzer implementation
// ---------------------------------------------------------------------------

export function coerceUrgency(urgency) {
  return typeof urgency === "number" && Number.isFinite(urgency) ? urgency : 0.5;
}

export class ComplexityQueryAnalyzer {
  analyze(query, { urgency = 0.5, model = null } = {}) {
    const safeUrgency = coerceUrgency(urgency);
    const modelName = typeof model === "string" ? model : null;

    const result = scoreComplexity(query);
    const tokens = adjustTokensForModel(result.suggestedMaxTokens, modelName);

    return createRoutingContext({
      query,
      queryLength: query.length,
      hasCode: result.signals.has_code,
      hasMath: result.signals.has_math,
      hasReasoning: result.signals.has_reasoning,
      urgency: safeUrgency,
      complexityScore: result.score,
      suggestedMaxTokens: tokens,
      metadata: { complexity_tier: result.tier, signals: result.signals },
    });
  }
}
