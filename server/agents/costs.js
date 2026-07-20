// USD pricing per MILLION tokens for the model ids the platform uses.
// AgentConfig.model defaults to claude-sonnet-4-5; profile extraction runs on
// the Haiku tier (see PROFILE_EXTRACTION_MODEL in llm.js).
export const MODEL_PRICING_USD_PER_MILLION_TOKENS = Object.freeze({
  "claude-sonnet-4-5": Object.freeze({ input: 3, output: 15 }),
  "claude-haiku-4-5": Object.freeze({ input: 1, output: 5 }),
  "claude-opus-4-1": Object.freeze({ input: 15, output: 75 }),
});

// `usage` is the AI SDK usage result ({ inputTokens, outputTokens }). Returns
// a USD number rounded to 6 decimals (the AgentRun.estimatedCostUsd scale),
// or null when the model has no pricing entry or usage is absent — unknown
// costs are stored as NULL, never guessed.
export function estimateCost(model, usage) {
  const pricing = MODEL_PRICING_USD_PER_MILLION_TOKENS[model];
  if (!pricing || !usage) return null;

  const inputTokens = Number(usage.inputTokens);
  const outputTokens = Number(usage.outputTokens);
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return null;

  const cost =
    ((Number.isFinite(inputTokens) ? inputTokens : 0) * pricing.input +
      (Number.isFinite(outputTokens) ? outputTokens : 0) * pricing.output) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// Sums token usages from multiple calls charged to the same run (e.g. the main
// agent call plus the profile-extraction pass).
export function addUsage(a, b) {
  if (!a && !b) return null;
  return {
    inputTokens: (Number(a?.inputTokens) || 0) + (Number(b?.inputTokens) || 0),
    outputTokens: (Number(a?.outputTokens) || 0) + (Number(b?.outputTokens) || 0),
  };
}

// Sums per-model estimated costs (each may be null).
export function addCosts(a, b) {
  if (a == null && b == null) return null;
  return Math.round(((a || 0) + (b || 0)) * 1_000_000) / 1_000_000;
}
