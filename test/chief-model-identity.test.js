// Model identity answers come from runtime metadata only when the user asks
// what CHIEF itself is configured with or running on. Advice, comparison, and
// recommendation questions about models are left to the model's reasoning.

import assert from "node:assert/strict";
import test from "node:test";

import {
  describeModelIdentity,
  isModelIdentityQuestion,
  renderModelIdentity,
} from "../server/chief/models/identity.js";

const RUNTIME_IDENTITY_QUESTIONS = [
  "What model is default for you?",
  "Which model are you running right now?",
  "What fallback model is configured?",
  "What is your default model?",
  "Which AI model is CHIEF using?",
  "What model are you?",
  "Is Grok your default model?",
  "What model is this conversation pinned to?",
];

const MODEL_ADVICE_QUESTIONS = [
  "Which model should I use for CHIEF's reasoning?",
  "What model would be best for my financial dashboard?",
  "Compare Claude and Grok models for reasoning.",
  "Which model is better for coding, Claude or Grok?",
  "Do you recommend a cheaper model for summaries?",
  "What are the trade-offs between the Grok and Claude models?",
];

const UNRELATED_MODEL_QUESTIONS = [
  "What model is my truck?",
  "What model year is the tractor?",
  "Can you build a financial model for the farm?",
  "What is my current home equity?",
  "Thanks.",
];

test("runtime identity questions are recognised", () => {
  for (const question of RUNTIME_IDENTITY_QUESTIONS) {
    assert.equal(isModelIdentityQuestion(question), true, question);
  }
});

test("model advice and comparison questions are not identity questions", () => {
  for (const question of MODEL_ADVICE_QUESTIONS) {
    assert.equal(isModelIdentityQuestion(question), false, question);
  }
});

test("other uses of the word model are not identity questions", () => {
  for (const question of UNRELATED_MODEL_QUESTIONS) {
    assert.equal(isModelIdentityQuestion(question), false, question);
  }
});

test("the rendered identity exposes catalog labels only", () => {
  const engine = {
    config: {
      defaultModel: "grok-default",
      fallbackModel: "grok-fallback",
      apiKey: "sk-not-for-output",
    },
    availableModelKeys: () => ["grok-default", "claude-active"],
    listModels: () => [
      { key: "grok-default", providerId: "xai", spec: { name: "Grok Default" } },
      { key: "grok-fallback", providerId: "xai", spec: { name: "Grok Fallback" } },
      { key: "claude-active", providerId: "anthropic", spec: { name: "Claude Active" } },
    ],
  };
  const identity = describeModelIdentity(engine, { activeModel: "claude-active" });
  assert.equal(identity.configuredDefault.id, "grok-default");
  assert.equal(identity.configuredFallback.available, false);
  assert.equal(identity.routingMode, "automatic");
  const text = renderModelIdentity(identity);
  assert.match(text, /configured default is Grok Default \(`grok-default`\)/);
  assert.match(text, /running on Claude Active \(`claude-active`\)/);
  assert.match(text, /fallback is Grok Fallback \(`grok-fallback`\)\. It is not callable/);
  assert.doesNotMatch(JSON.stringify(identity) + text, /sk-not-for-output|apiKey/);
});
