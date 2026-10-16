// Phase 3 retrieval regressions. No database, network, or model.

import assert from "node:assert/strict";
import test from "node:test";

import {
  authoritativeDomain,
  needsEpisodicMemory,
  planMemoryRetrieval,
  rankEpisodes,
  selectPersonalFacts,
} from "../server/chief/memory/retrieve.js";
import { lexicalRank } from "../server/chief/runtime/recall.js";

const USER = "user-a";

function fact(id, content, source = "user") {
  return {
    id,
    content,
    source,
    trustTier: "TRUSTED",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

test("a decision question opens episodic recall without the old past-tense list", () => {
  const query = "What did we decide about the vacation property?";
  assert.equal(needsEpisodicMemory(query), true);
  assert.equal(planMemoryRetrieval(query).episodic, true);
  assert.equal(needsEpisodicMemory("How much XRP do I own?"), false);
  assert.equal(needsEpisodicMemory("What is 2 + 2?"), false);
});

test("vacation property retrieves the cabin decision and not an unrelated episode", () => {
  const keep = {
    id: "keep",
    userId: USER,
    title: "Cabin decision",
    content: "We decided to keep the lake cabin and not sell it.",
    updatedAt: "2026-05-01T00:00:00.000Z",
    importance: 0.6,
  };
  const sell = {
    id: "sell",
    userId: USER,
    title: "Cabin sale",
    content: "On 2026-09-01 we discussed selling the lake cabin.",
    updatedAt: "2026-09-01T00:00:00.000Z",
    importance: 0.6,
  };
  const otherUser = { ...keep, id: "other", userId: "user-b" };
  const ranked = rankEpisodes("What did we decide about the vacation property?", [sell, otherUser, keep], {
    userId: USER,
  });
  assert.equal(ranked[0]?.episode.id, "keep");
  assert.equal(
    ranked.some((hit) => hit.episode.userId === "user-b"),
    false
  );
  assert.equal(lexicalRank("vacation property decision", keep.content), 0);
});

test("different wording keeps the cabin fact and drops Oak Street", () => {
  const selected = selectPersonalFacts("Tell me about the vacation property.", [
    fact("pref", "The user prefers concise answers.", "preference"),
    fact("cabin", "The lake cabin was purchased in 2019."),
    fact("oak", "The primary residence is the house on Oak Street."),
  ]);
  const ids = selected.map((row) => row.id);
  assert.equal(ids.includes("cabin"), true);
  assert.equal(ids.includes("oak"), false);
  assert.equal(ids.includes("pref"), true);
});

test("the other residence is retrieved and Oak Street is not", () => {
  const selected = selectPersonalFacts("What about the other one?", [
    fact("pref", "The user prefers concise answers.", "preference"),
    fact("other", "The lake cabin is the other residence."),
    fact("oak", "The primary residence is the house on Oak Street."),
  ]);
  const ids = selected.map((row) => row.id);
  assert.equal(ids.includes("other"), true);
  assert.equal(ids.includes("oak"), false);
});

test("conflicting cabin episodes are both returned and the newer one ranks first", () => {
  const keepDated = {
    id: "keep-dated",
    userId: USER,
    title: "Keep",
    content: "On 2026-01-01 we decided to keep the lake cabin.",
    updatedAt: "2026-01-01T00:00:00.000Z",
    importance: 0.5,
  };
  const sell = {
    id: "sell",
    userId: USER,
    title: "Cabin sale",
    content: "On 2026-09-01 we discussed selling the lake cabin.",
    updatedAt: "2026-09-01T00:00:00.000Z",
    importance: 0.6,
  };
  const query = "Are we keeping the lake cabin or selling it?";
  assert.equal(needsEpisodicMemory(query), true);
  const ranked = rankEpisodes(query, [keepDated, sell], { userId: USER });
  const ids = ranked.map((hit) => hit.episode.id);
  assert.deepEqual(ids.includes("keep-dated") && ids.includes("sell"), true);
  assert.equal(ids[0], "sell");
});

test("a repository path is a code read and a balance question stays finance", () => {
  assert.equal(
    authoritativeDomain(
      "What changed in server/chief/runtime/turn.js since we last talked about the turn loop?"
    ),
    "code"
  );
  assert.equal(
    needsEpisodicMemory(
      "What changed in server/chief/runtime/turn.js since we last talked about the turn loop?"
    ),
    true
  );
  assert.equal(authoritativeDomain("How much XRP do I own?"), "finance");
  assert.equal(authoritativeDomain("What is the XRP price today?"), "web");
  assert.equal(
    authoritativeDomain("Where is finance access implemented in the codebase?"),
    "code"
  );
});

test("episode ranking still prefers the finance fix over an unrelated note", () => {
  const older = {
    id: "old",
    userId: USER,
    title: "Freedom Financial access",
    content:
      "Fixed Freedom Financial read access. The finance reader was disabled until the user turned it on.",
    updatedAt: "2026-01-01T00:00:00.000Z",
    importance: 0.4,
  };
  const newer = { ...older, id: "new", updatedAt: "2026-08-01T00:00:00.000Z", importance: 0.4 };
  const important = { ...older, id: "important", updatedAt: "2026-01-01T00:00:00.000Z", importance: 0.95 };
  const unrelated = {
    id: "well",
    userId: USER,
    title: "Well pump",
    content: "The well pump is electric and the barn door sticks.",
    updatedAt: "2026-09-01T00:00:00.000Z",
    importance: 1,
  };
  const query = "why can't you see my finances?";
  const ranked = rankEpisodes(query, [unrelated, older], { userId: USER });
  assert.equal(ranked[0].episode.id, "old");
  assert.equal(
    ranked.some((hit) => hit.episode.id === "well"),
    false
  );
  assert.equal(rankEpisodes(query, [older, newer], { userId: USER })[0].episode.id, "new");
  assert.equal(rankEpisodes(query, [older, important], { userId: USER })[0].episode.id, "important");
});

test("personal recall keeps a matching fact and drops a stale or unrelated one", () => {
  const selected = selectPersonalFacts("how is the well", [
    fact("well", "The north well pump is solar"),
    fact("xrp", "User owns 59000 XRP"),
    {
      ...fact("stale", "Old gate code was rotated"),
      expiresAt: "2020-01-01T00:00:00.000Z",
    },
  ]);
  const ids = selected.map((row) => row.id);
  assert.equal(ids.includes("well"), true);
  assert.equal(ids.includes("stale"), false);
  assert.equal(ids.includes("xrp"), false);

  const finance = selectPersonalFacts("How much XRP do I own?", [
    fact("balance", "User owns 59000 XRP"),
    fact("pref", "Keep replies short", "preference"),
  ]);
  assert.equal(
    finance.some((row) => /59000/.test(row.content)),
    false
  );
  assert.equal(
    finance.some((row) => row.source === "preference"),
    true
  );
});
