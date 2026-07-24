import test from "node:test";
import assert from "node:assert/strict";

import {
  DIGEST_MAX_LENGTH,
  normalizeDigestText,
  sanitizeDigestAction,
} from "../server/agents/digest.js";
import {
  renderNamedRunSummaries,
  renderTeamRoster,
} from "../server/agents/teamContext.js";

test("normalizeDigestText strips leading Status Update / Daily Digest chrome", () => {
  assert.equal(
    normalizeDigestText("# Status Update\n\nYour research agent finished a scan."),
    "Your research agent finished a scan."
  );
  assert.equal(
    normalizeDigestText("## Daily Digest\nMarkets moved."),
    "Markets moved."
  );
  assert.equal(
    normalizeDigestText("**Status Update**\n\nHello"),
    "Hello"
  );
  assert.equal(normalizeDigestText("Plain body with no heading."), "Plain body with no heading.");
});

test("normalizeDigestText enforces max length and drops null bytes", () => {
  const long = `${"a".repeat(DIGEST_MAX_LENGTH + 50)}`;
  assert.equal(normalizeDigestText(long).length, DIGEST_MAX_LENGTH);
  assert.equal(normalizeDigestText("ok\u0000day"), "okday");
  assert.equal(normalizeDigestText("   "), "");
});

test("sanitizeDigestAction accepts set_content and regenerate", () => {
  assert.equal(sanitizeDigestAction(null), null);
  assert.deepEqual(sanitizeDigestAction({ type: "regenerate" }), { type: "regenerate" });
  assert.deepEqual(
    sanitizeDigestAction({
      type: "set_content",
      content: "# Status Update\n\nCustom note for tomorrow.",
    }),
    { type: "set_content", content: "Custom note for tomorrow." }
  );
  assert.throws(() => sanitizeDigestAction({ type: "set_content", content: "  " }), /content/);
  assert.throws(() => sanitizeDigestAction({ type: "wire_money" }), /digestAction\.type/);
});

test("renderTeamRoster names current sub-agents for CEO/digest prompts", () => {
  assert.match(renderTeamRoster([]), /no sub-agents yet/i);
  const roster = renderTeamRoster([
    {
      id: "a1",
      name: "Federal Reserve Data Agent",
      agentType: "research",
      status: "ACTIVE",
      schedule: null,
      definitionOfDone: "Summarize the latest FOMC statement.",
    },
  ]);
  assert.match(roster, /Federal Reserve Data Agent/);
  assert.match(roster, /FOMC/);
  assert.match(roster, /on-demand/);
});

test("renderNamedRunSummaries prefers agent names over bare agentType", () => {
  const text = renderNamedRunSummaries(
    [
      {
        id: "run-1",
        agentConfigId: "a1",
        agentType: "research",
        summary: "Rates held steady.",
        startedAt: new Date("2026-07-20T00:00:00Z"),
      },
    ],
    [{ id: "a1", name: "Federal Reserve Data Agent" }]
  );
  assert.match(text, /Federal Reserve Data Agent, research/);
  assert.match(text, /Rates held steady/);
});
