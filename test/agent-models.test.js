import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_AGENT_MODEL,
  isValidAgentModel,
  normalizeAgentModel,
  parseAgentModelChoice,
} from "../server/agents/models.js";

test("allowlist accepts only Haiku, Sonnet, and Opus ids", () => {
  assert.equal(isValidAgentModel("claude-haiku-4-5"), true);
  assert.equal(isValidAgentModel("claude-sonnet-4-5"), true);
  assert.equal(isValidAgentModel("claude-opus-4-1"), true);
  assert.equal(isValidAgentModel("gpt-4"), false);
  assert.equal(isValidAgentModel(""), false);
  assert.equal(normalizeAgentModel(undefined), DEFAULT_AGENT_MODEL);
  assert.equal(normalizeAgentModel("claude-opus-4-1"), "claude-opus-4-1");
});

test("parseAgentModelChoice prefers explicit names over skip synonyms", () => {
  assert.equal(parseAgentModelChoice("haiku"), "claude-haiku-4-5");
  assert.equal(parseAgentModelChoice("use opus please"), "claude-opus-4-1");
  assert.equal(parseAgentModelChoice("sonnet"), "claude-sonnet-4-5");
  assert.equal(parseAgentModelChoice("skip"), "claude-sonnet-4-5");
  assert.equal(parseAgentModelChoice("default"), "claude-sonnet-4-5");
  assert.equal(parseAgentModelChoice("opus recommended"), "claude-opus-4-1");
  assert.equal(parseAgentModelChoice("maybe later"), null);
});
