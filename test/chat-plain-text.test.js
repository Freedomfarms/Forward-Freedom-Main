import test from "node:test";
import assert from "node:assert/strict";

import { stripChatMarkdown } from "../server/agents/prompts.js";

test("stripChatMarkdown removes paired bold markers the chat UI cannot render", () => {
  assert.equal(
    stripChatMarkdown(
      "Got it — switching focus to a **federal reserve report** (not crypto). **Who should receive this?**"
    ),
    "Got it — switching focus to a federal reserve report (not crypto). Who should receive this?"
  );
  assert.equal(stripChatMarkdown("No emphasis here"), "No emphasis here");
  assert.equal(stripChatMarkdown("__underscored__ and **bold**"), "underscored and bold");
  assert.equal(stripChatMarkdown(""), "");
});
