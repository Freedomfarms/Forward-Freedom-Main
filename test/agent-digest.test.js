import test from "node:test";
import assert from "node:assert/strict";

import {
  DIGEST_MAX_LENGTH,
  normalizeDigestText,
  sanitizeDigestAction,
} from "../server/agents/digest.js";

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
