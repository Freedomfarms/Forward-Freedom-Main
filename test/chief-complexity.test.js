// CHIEF complexity / classification tests — translated from OpenJarvis
// tests/learning/routing/test_complexity.py and test_utils.py (commit
// 5e5f5ef) so the ported scoring stays verifiably faithful, plus the
// documented CHIEF adaptation (catalog-declared reasoning models).

import test from "node:test";
import assert from "node:assert/strict";

import { ModelRegistry } from "../server/chief/core/registry.js";
import {
  ComplexityQueryAnalyzer,
  TOKEN_TIERS,
  adjustTokensForModel,
  isReasoningModel,
  isThinkingModel,
  scoreComplexity,
} from "../server/chief/models/complexity.js";
import { QueryClass, classifyQuery } from "../server/chief/models/classify.js";
import { createModelSpec, REASONING_KEY } from "../server/chief/models/types.js";

// --- score_complexity -------------------------------------------------------

test("trivial query", () => {
  const result = scoreComplexity("Hi");
  assert.equal(result.tier, "trivial");
  assert.ok(result.score < 0.15);
});

test("simple query", () => {
  const result = scoreComplexity("What is the capital of France?");
  assert.ok(["trivial", "simple"].includes(result.tier));
  assert.ok(result.score < 0.3);
});

test("code signal", () => {
  const result = scoreComplexity("def hello():\n    return 'world'");
  assert.equal(result.signals.has_code, true);
  assert.ok(result.score > 0.0);
});

test("math signal", () => {
  const result = scoreComplexity("Solve the integral of x^2 dx");
  assert.equal(result.signals.has_math, true);
  assert.ok(result.score > 0.0);
});

test("code and math gives high domain", () => {
  const result = scoreComplexity("```python\nimport numpy\n```\nSolve the integral of x^2");
  assert.equal(result.signals.has_code, true);
  assert.equal(result.signals.has_math, true);
  assert.equal(result.signals.domain, 1.0);
});

test("reasoning signal", () => {
  const result = scoreComplexity("Explain why the sky is blue step by step");
  assert.equal(result.signals.has_reasoning, true);
});

test("multi-step signal", () => {
  const result = scoreComplexity("First do X, then do Y, then do Z");
  assert.equal(result.signals.has_multi_step, true);
});

test("reasoning and multi-step combined", () => {
  const result = scoreComplexity("Explain why X works, then analyze Y, then compare them");
  assert.equal(result.signals.has_reasoning, true);
  assert.equal(result.signals.has_multi_step, true);
  assert.equal(result.signals.reasoning, 1.0);
});

test("multi-part questions", () => {
  const result = scoreComplexity("What is X? What is Y? What is Z? What is W?");
  assert.equal(result.signals.n_questions, 4);
  assert.equal(result.signals.multi_part, 1.0);
});

test("creative signal", () => {
  const result = scoreComplexity("Write an essay about climate change");
  assert.equal(result.signals.has_creative, true);
});

test("very complex query", () => {
  const query =
    "Explain step by step how to solve the integral of x^2, " +
    "then write Python code to compute it numerically. " +
    "1. Derive the analytical solution\n" +
    "2. Implement numerical integration\n" +
    "3. Compare the results and analyze the error";
  const result = scoreComplexity(query);
  assert.ok(["complex", "very_complex"].includes(result.tier));
  assert.ok(result.score >= 0.55);
});

test("score clamped to unit interval", () => {
  const result = scoreComplexity("x".repeat(2000));
  assert.ok(result.score >= 0.0 && result.score <= 1.0);
});

test("result type", () => {
  const result = scoreComplexity("hello");
  assert.equal(typeof result.score, "number");
  assert.equal(typeof result.tier, "string");
  assert.ok(Number.isInteger(result.suggestedMaxTokens));
  assert.equal(typeof result.signals, "object");
  assert.ok(Object.isFrozen(result));
});

test("token tiers increase with complexity", () => {
  const trivial = scoreComplexity("Hi");
  const complex = scoreComplexity(
    "Explain step by step how to solve the integral of x^2 " +
      "and write code to compute the derivative of the matrix equation"
  );
  assert.ok(complex.suggestedMaxTokens >= trivial.suggestedMaxTokens);
  assert.equal(trivial.suggestedMaxTokens, TOKEN_TIERS.trivial);
});

test("subtask counting", () => {
  const result = scoreComplexity("1. First task\n2. Second task\n- Bullet item");
  assert.equal(result.signals.n_subtasks, 3);
});

test("exact score for the low-complexity math regression case", () => {
  // Upstream asserts complexity_score == 0.20 for "calculate 2+2"; the
  // router's rule 2 (<= 0.20) depends on this exact value.
  const result = scoreComplexity("calculate 2+2");
  assert.equal(result.signals.has_math, true);
  assert.equal(result.score, 0.2);
});

test("non-string input is rejected", () => {
  assert.throws(() => scoreComplexity(null), TypeError);
});

// --- is_thinking_model / adjust_tokens_for_model -----------------------------

test("thinking model name patterns", () => {
  assert.equal(isThinkingModel("deepseek-r1-32b"), true);
  assert.equal(isThinkingModel("o1-preview"), true);
  assert.equal(isThinkingModel("o3-mini"), true);
  assert.equal(isThinkingModel("qwq-32b"), true);
  assert.equal(isThinkingModel("llama-3.1-8b"), false);
  assert.equal(isThinkingModel("gpt-4o"), false);
});

test("thinking model doubles the token budget", () => {
  assert.equal(adjustTokensForModel(1024, "deepseek-r1-32b"), 2048);
  assert.equal(adjustTokensForModel(1024, "llama-3.1-8b"), 1024);
  assert.equal(adjustTokensForModel(1024), 1024);
  assert.equal(adjustTokensForModel(1024, null), 1024);
});

test("CHIEF adaptation: catalog-declared reasoning models also get headroom", () => {
  ModelRegistry.clear();
  ModelRegistry.registerValue(
    "acme-thinker",
    createModelSpec({
      modelId: "acme-thinker",
      name: "Acme Thinker",
      parameterCountB: 0,
      contextLength: 1000,
      supportedEngines: ["cloud"],
      metadata: { [REASONING_KEY]: true },
    })
  );
  ModelRegistry.registerValue(
    "acme-plain",
    createModelSpec({
      modelId: "acme-plain",
      name: "Acme Plain",
      parameterCountB: 0,
      contextLength: 1000,
      supportedEngines: ["cloud"],
    })
  );
  // Upstream name detection is untouched…
  assert.equal(isThinkingModel("acme-thinker"), false);
  // …the catalog flag extends it.
  assert.equal(isReasoningModel("acme-thinker"), true);
  assert.equal(isReasoningModel("acme-plain"), false);
  assert.equal(isReasoningModel("unregistered"), false);
  assert.equal(adjustTokensForModel(1024, "acme-thinker"), 2048);
  assert.equal(adjustTokensForModel(1024, "acme-plain"), 1024);
  ModelRegistry.clear();
});

// --- ComplexityQueryAnalyzer ------------------------------------------------

test("analyzer returns a routing context", () => {
  const ctx = new ComplexityQueryAnalyzer().analyze("Hello world");
  assert.equal(ctx.query, "Hello world");
  assert.equal(ctx.queryLength, "Hello world".length);
});

test("analyzer populates complexity and reasoning", () => {
  const ctx = new ComplexityQueryAnalyzer().analyze(
    "Explain step by step how photosynthesis works"
  );
  assert.ok(ctx.complexityScore > 0.0);
  assert.equal(ctx.hasReasoning, true);
});

test("analyzer detects code and math", () => {
  const analyzer = new ComplexityQueryAnalyzer();
  assert.equal(analyzer.analyze("def foo(): pass").hasCode, true);
  assert.equal(analyzer.analyze("solve the equation x^2 = 4").hasMath, true);
});

test("analyzer urgency passthrough and invalid urgency default", () => {
  const analyzer = new ComplexityQueryAnalyzer();
  assert.equal(analyzer.analyze("test", { urgency: 0.9 }).urgency, 0.9);
  assert.equal(analyzer.analyze("test", { urgency: "invalid" }).urgency, 0.5);
});

test("analyzer adjusts tokens for thinking models", () => {
  const analyzer = new ComplexityQueryAnalyzer();
  const normal = analyzer.analyze("Hello", { model: "llama-3.1-8b" });
  const thinking = analyzer.analyze("Hello", { model: "deepseek-r1-32b" });
  assert.equal(thinking.suggestedMaxTokens, normal.suggestedMaxTokens * 2);
});

test("analyzer metadata contains tier and signals", () => {
  const ctx = new ComplexityQueryAnalyzer().analyze("Hi");
  assert.ok("complexity_tier" in ctx.metadata);
  assert.ok("signals" in ctx.metadata);
});

// --- classify_query (tests/learning/routing/test_utils.py) -------------------

test("classify_query: code", () => {
  assert.equal(classifyQuery("def hello(): pass"), QueryClass.CODE);
  assert.equal(classifyQuery("```python\nprint()```"), QueryClass.CODE);
  assert.equal(classifyQuery("import os"), QueryClass.CODE);
});

test("classify_query: math", () => {
  assert.equal(classifyQuery("solve this equation for x"), QueryClass.MATH);
  assert.equal(classifyQuery("compute the integral"), QueryClass.MATH);
});

test("classify_query: short / long / general", () => {
  assert.equal(classifyQuery("hello"), QueryClass.SHORT);
  assert.equal(classifyQuery("what time is it?"), QueryClass.SHORT);
  assert.equal(classifyQuery("a".repeat(501)), QueryClass.LONG);
  assert.equal(
    classifyQuery("Tell me about the history of artificial intelligence research"),
    QueryClass.GENERAL
  );
});
