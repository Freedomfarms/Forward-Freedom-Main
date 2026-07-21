import test from "node:test";
import assert from "node:assert/strict";
import { buildSnippetTitle } from "../server/agents/conversationTitle.js";

test("buildSnippetTitle keeps short messages intact", () => {
  assert.equal(buildSnippetTitle("Hello there"), "Hello there");
});

test("buildSnippetTitle truncates long messages with an ellipsis", () => {
  const long = "Please review my spending for the last three months carefully";
  const title = buildSnippetTitle(long, 40);
  assert.ok(title.endsWith("…"));
  assert.ok(title.length <= 40);
  assert.ok(title.startsWith("Please review"));
});

test("buildSnippetTitle collapses whitespace and falls back for empty", () => {
  assert.equal(buildSnippetTitle("  too   many   spaces  "), "too many spaces");
  assert.equal(buildSnippetTitle("   "), "New chat");
  assert.equal(buildSnippetTitle(null), "New chat");
});
