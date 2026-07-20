import test from "node:test";
import assert from "node:assert/strict";

import {
  addCosts,
  addUsage,
  estimateCost,
  MODEL_PRICING_USD_PER_MILLION_TOKENS,
} from "../server/agents/costs.js";

test("pricing table covers the model ids the platform uses", () => {
  assert.ok(MODEL_PRICING_USD_PER_MILLION_TOKENS["claude-sonnet-4-5"]);
  assert.ok(MODEL_PRICING_USD_PER_MILLION_TOKENS["claude-haiku-4-5"]);
});

test("estimateCost prices input and output tokens per million", () => {
  assert.equal(
    estimateCost("claude-sonnet-4-5", { inputTokens: 1_000_000, outputTokens: 0 }),
    3
  );
  assert.equal(
    estimateCost("claude-sonnet-4-5", { inputTokens: 0, outputTokens: 1_000_000 }),
    15
  );
  // (1000 * 3 + 2000 * 15) / 1e6 = 0.033
  assert.equal(estimateCost("claude-sonnet-4-5", { inputTokens: 1000, outputTokens: 2000 }), 0.033);
  assert.equal(estimateCost("claude-haiku-4-5", { inputTokens: 500_000, outputTokens: 100_000 }), 1);
});

test("estimateCost fails closed to null for unknown models or missing usage", () => {
  assert.equal(estimateCost("not-a-real-model", { inputTokens: 1000, outputTokens: 1000 }), null);
  assert.equal(estimateCost("claude-sonnet-4-5", null), null);
  assert.equal(estimateCost("claude-sonnet-4-5", { inputTokens: undefined, outputTokens: undefined }), null);
});

test("estimateCost tolerates partial usage objects", () => {
  assert.equal(estimateCost("claude-sonnet-4-5", { inputTokens: 1_000_000 }), 3);
  assert.equal(estimateCost("claude-sonnet-4-5", { outputTokens: 1_000_000 }), 15);
});

test("addUsage and addCosts combine main-call and profile-extraction accounting", () => {
  assert.deepEqual(addUsage({ inputTokens: 100, outputTokens: 50 }, { inputTokens: 10, outputTokens: 5 }), {
    inputTokens: 110,
    outputTokens: 55,
  });
  assert.deepEqual(addUsage(null, { inputTokens: 10, outputTokens: 5 }), {
    inputTokens: 10,
    outputTokens: 5,
  });
  assert.equal(addUsage(null, null), null);

  assert.equal(addCosts(0.03, 0.001), 0.031);
  assert.equal(addCosts(null, 0.002), 0.002);
  assert.equal(addCosts(null, null), null);
});
