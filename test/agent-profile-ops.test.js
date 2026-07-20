import test from "node:test";
import assert from "node:assert/strict";

import {
  applyOps,
  createEmptyProfile,
  MAX_ENTRIES_PER_CATEGORY,
  normalizeProfile,
  renderProfileForPrompt,
  sanitizeProfileOps,
} from "../server/agents/profile.js";

test("applyOps add creates entries with id, source and timestamps", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  const profile = applyOps(
    createEmptyProfile(),
    [{ op: "add", category: "financialGoals", text: "Wants to pay off the mortgage early" }],
    { source: "finance", now }
  );
  const entries = profile.categories.financialGoals;
  assert.equal(entries.length, 1);
  assert.ok(entries[0].id);
  assert.equal(entries[0].text, "Wants to pay off the mortgage early");
  assert.equal(entries[0].source, "finance");
  assert.equal(entries[0].addedAt, now.toISOString());
  assert.equal(entries[0].updatedAt, now.toISOString());
});

test("remove tombstones the entry and tombstoned entries are never re-added or updated", () => {
  let profile = applyOps(
    createEmptyProfile(),
    [{ op: "add", category: "statedPreferences", text: "Prefers monthly summaries" }],
    { source: "ceo_chat" }
  );
  const entryId = profile.categories.statedPreferences[0].id;

  profile = applyOps(profile, [{ op: "remove", id: entryId }], { source: "user_edit" });
  assert.equal(profile.categories.statedPreferences.length, 0);
  assert.deepEqual(profile.tombstones, [entryId]);

  // Automatic merging must never resurrect what the user deleted.
  profile = applyOps(
    profile,
    [
      { op: "add", category: "statedPreferences", id: entryId, text: "Prefers monthly summaries" },
      { op: "update", id: entryId, text: "Prefers weekly summaries" },
    ],
    { source: "finance" }
  );
  assert.equal(profile.categories.statedPreferences.length, 0);
  assert.deepEqual(profile.tombstones, [entryId]);
});

test("adding an existing fact refreshes it instead of duplicating", () => {
  const first = new Date("2026-06-01T00:00:00Z");
  const second = new Date("2026-07-01T00:00:00Z");
  let profile = applyOps(
    createEmptyProfile(),
    [{ op: "add", category: "lifeContext", text: "Has two kids" }],
    { source: "onboarding", now: first }
  );
  profile = applyOps(profile, [{ op: "add", category: "lifeContext", text: "has two kids" }], {
    source: "ceo_chat",
    now: second,
  });
  assert.equal(profile.categories.lifeContext.length, 1);
  assert.equal(profile.categories.lifeContext[0].updatedAt, second.toISOString());
  assert.equal(profile.categories.lifeContext[0].addedAt, first.toISOString());
});

test("categories are capped, pruning the oldest-updated entries without tombstoning them", () => {
  let profile = createEmptyProfile();
  for (let i = 0; i < MAX_ENTRIES_PER_CATEGORY + 5; i += 1) {
    profile = applyOps(
      profile,
      [{ op: "add", category: "recurringConcerns", text: `Concern number ${i}` }],
      { source: "finance", now: new Date(Date.UTC(2026, 0, 1 + i)) }
    );
  }
  const entries = profile.categories.recurringConcerns;
  assert.equal(entries.length, MAX_ENTRIES_PER_CATEGORY);
  // Oldest five were pruned; newest survive.
  assert.ok(!entries.some((entry) => entry.text === "Concern number 0"));
  assert.ok(!entries.some((entry) => entry.text === "Concern number 4"));
  assert.ok(entries.some((entry) => entry.text === "Concern number 19"));
  // Pruning is not user deletion — no tombstones were created.
  assert.deepEqual(profile.tombstones, []);
});

test("update rewrites text and stamps the new source and updatedAt", () => {
  const now = new Date("2026-07-10T00:00:00Z");
  let profile = applyOps(
    createEmptyProfile(),
    [{ op: "add", category: "financialGoals", text: "Save for a house" }],
    { source: "onboarding", now: new Date("2026-01-01T00:00:00Z") }
  );
  const id = profile.categories.financialGoals[0].id;
  profile = applyOps(profile, [{ op: "update", id, text: "Save for a house by 2028" }], {
    source: "ceo_chat",
    now,
  });
  const entry = profile.categories.financialGoals[0];
  assert.equal(entry.text, "Save for a house by 2028");
  assert.equal(entry.source, "ceo_chat");
  assert.equal(entry.updatedAt, now.toISOString());
});

test("applyOps ignores malformed ops and unknown categories", () => {
  const profile = applyOps(
    createEmptyProfile(),
    [
      null,
      { op: "add", category: "notARealCategory", text: "should be dropped" },
      { op: "add", category: "financialGoals", text: "   " },
      { op: "update", id: "missing-id", text: "no such entry" },
      { op: "remove", id: "" },
      { op: "explode" },
    ],
    { source: "finance" }
  );
  assert.deepEqual(profile, createEmptyProfile());
});

test("normalizeProfile tolerates junk and legacy payloads", () => {
  const normalized = normalizeProfile({
    categories: { financialGoals: [{ text: "Retire at 55" }, { text: "" }, "junk"] },
    tombstones: ["abc", 42, null],
  });
  assert.equal(normalized.categories.financialGoals.length, 1);
  assert.ok(normalized.categories.financialGoals[0].id);
  assert.deepEqual(normalized.categories.statedPreferences, []);
  assert.deepEqual(normalized.tombstones, ["abc", "42"]);
  assert.deepEqual(normalizeProfile(null), createEmptyProfile());
});

test("renderProfileForPrompt renders compact text with entry ids", () => {
  const profile = applyOps(
    createEmptyProfile(),
    [{ op: "add", category: "financialGoals", text: "Retire at 55" }],
    { source: "onboarding" }
  );
  const rendered = renderProfileForPrompt(profile);
  assert.match(rendered, /Financial goals:/);
  assert.match(rendered, /Retire at 55/);
  assert.match(rendered, new RegExp(profile.categories.financialGoals[0].id));
  assert.equal(renderProfileForPrompt(createEmptyProfile()), "(no profile information recorded yet)");
});

test("sanitizeProfileOps drops malformed model output", () => {
  const ops = sanitizeProfileOps([
    { op: "add", category: "lifeContext", text: "Recently moved" },
    { op: "add", category: "bogus", text: "dropped" },
    { op: "update", id: "", text: "dropped" },
    { op: "remove", id: "some-id" },
    "junk",
  ]);
  assert.equal(ops.length, 2);
  assert.equal(sanitizeProfileOps(undefined).length, 0);
});
