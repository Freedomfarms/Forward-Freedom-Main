import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_REPORT_STYLE_RULE } from "../server/agents/prompts.js";
import { RESEARCH_SYSTEM_PROMPT } from "../server/agents/types/research.js";
import { FINANCE_SYSTEM_PROMPT } from "../server/agents/types/finance.js";

test("DEFAULT_REPORT_STYLE_RULE describes the clean desk-brief default", () => {
  assert.match(DEFAULT_REPORT_STYLE_RULE, /Default format/i);
  assert.match(DEFAULT_REPORT_STYLE_RULE, /desk brief/i);
  assert.match(DEFAULT_REPORT_STYLE_RULE, /## Summary/);
  assert.match(DEFAULT_REPORT_STYLE_RULE, /\*\*Bold\*\*/i);
  assert.match(DEFAULT_REPORT_STYLE_RULE, /plain, precise, and calm/i);
});

test("research and finance prompts use the shared default report style", () => {
  assert.ok(RESEARCH_SYSTEM_PROMPT.includes(DEFAULT_REPORT_STYLE_RULE));
  assert.ok(FINANCE_SYSTEM_PROMPT.includes(DEFAULT_REPORT_STYLE_RULE));
  assert.match(RESEARCH_SYSTEM_PROMPT, /different format or style/i);
  assert.match(FINANCE_SYSTEM_PROMPT, /different format or style/i);
});
