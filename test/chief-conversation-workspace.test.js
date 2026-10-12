import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildConversationView,
  conversationAgeBucket,
  conversationWhen,
} from "../src/utils/chiefConversationWorkspace.js";

function at(year, month, day, hour = 12) {
  return new Date(year, month, day, hour, 0, 0, 0).toISOString();
}

test("conversation groups follow local calendar days", () => {
  const now = new Date(2026, 9, 12, 15, 0, 0, 0).getTime();
  assert.equal(conversationAgeBucket(new Date(2026, 9, 12, 8).getTime(), now), "today");
  assert.equal(conversationAgeBucket(new Date(2026, 9, 11, 23).getTime(), now), "yesterday");
  assert.equal(conversationAgeBucket(new Date(2026, 9, 8, 9).getTime(), now), "week");
  assert.equal(conversationAgeBucket(new Date(2026, 9, 4, 9).getTime(), now), "older");
  assert.equal(conversationAgeBucket(0, now), "older");
});

test("workspace groups active conversations and keeps archived on their own view", () => {
  const now = new Date(2026, 9, 12, 15, 0, 0, 0).getTime();
  const sessions = [
    { sessionId: "today", title: "Planning", updatedAt: at(2026, 9, 12, 9) },
    { sessionId: "yesterday", title: null, updatedAt: at(2026, 9, 11, 18) },
    { sessionId: "week", title: "Vendors", updatedAt: at(2026, 9, 7, 11) },
    { sessionId: "old", title: "Taxes", updatedAt: at(2026, 8, 2, 11) },
  ];
  const archivedSessions = [
    { sessionId: "boxed", title: "Old plan", updatedAt: at(2026, 9, 12, 8) },
  ];

  const all = buildConversationView({ sessions, archivedSessions, now });
  assert.equal(all.searching, false);
  assert.equal(all.filter, "all");
  assert.deepEqual(
    all.groups.map((group) => [group.label, group.sessions.map((session) => session.sessionId)]),
    [
      ["Today", ["today"]],
      ["Yesterday", ["yesterday"]],
      ["Previous 7 Days", ["week"]],
      ["Older", ["old"]],
    ]
  );
  assert.equal(all.emptyLabel, "");

  const recent = buildConversationView({ sessions, archivedSessions, filter: "recent", now });
  assert.deepEqual(
    recent.groups.flatMap((group) => group.sessions.map((session) => session.sessionId)),
    ["today", "yesterday", "week"]
  );
  assert.equal(
    buildConversationView({
      sessions: [{ sessionId: "old", updatedAt: at(2026, 8, 2) }],
      filter: "recent",
      now,
    }).emptyLabel,
    "No recent conversations."
  );

  const archived = buildConversationView({ sessions, archivedSessions, filter: "archived", now });
  assert.deepEqual(
    archived.groups[0].sessions.map((session) => session.sessionId),
    ["boxed"]
  );
  assert.equal(
    buildConversationView({ filter: "archived", now }).emptyLabel,
    "No archived conversations."
  );
  assert.equal(buildConversationView().emptyLabel, "No conversations yet.");
});

test("search keeps owner-scoped hits, applies the active view, and reports no matches", () => {
  const now = new Date(2026, 9, 12, 15, 0, 0, 0).getTime();
  const searchResults = [
    {
      sessionId: "live",
      title: "Jarvis notes",
      updatedAt: at(2026, 9, 12, 10),
      archived: false,
      snippet: "Jarvis notes",
    },
    {
      sessionId: "old-live",
      title: "Older Jarvis",
      updatedAt: at(2026, 8, 1, 10),
      archived: false,
      snippet: "older",
    },
    {
      sessionId: "boxed",
      title: "Archived Jarvis",
      updatedAt: at(2026, 9, 11, 10),
      archived: true,
      snippet: "archive",
    },
  ];

  const all = buildConversationView({ query: "Jarvis", searchResults, now });
  assert.equal(all.searching, true);
  assert.deepEqual(
    all.groups.flatMap((group) => group.sessions.map((session) => session.sessionId)),
    ["live", "boxed", "old-live"]
  );

  const recent = buildConversationView({
    query: "Jarvis",
    searchResults,
    filter: "recent",
    now,
  });
  assert.deepEqual(
    recent.groups.flatMap((group) => group.sessions.map((session) => session.sessionId)),
    ["live"]
  );

  const archived = buildConversationView({
    query: "Jarvis",
    searchResults,
    filter: "archived",
    now,
  });
  assert.deepEqual(
    archived.groups[0].sessions.map((session) => session.sessionId),
    ["boxed"]
  );
  assert.equal(
    buildConversationView({ query: "missing", searchResults: [], now }).emptyLabel,
    "No conversations found"
  );
});

test("relative timestamps stay short and untitled labels are not invented here", () => {
  const updated = new Date(2026, 9, 12, 12, 0, 0, 0).toISOString();
  const now = new Date(updated).getTime();
  assert.equal(conversationWhen({ updatedAt: updated }, now + 20_000), "now");
  assert.equal(conversationWhen({ updatedAt: updated }, now + 5 * 60_000), "5m ago");
  assert.equal(conversationWhen({ title: "   " }), "");
});

test("the conversation workspace stays on the CHIEF shell and the session routes", () => {
  const page = readFileSync(
    new URL("../src/components/chief/ChiefPage.jsx", import.meta.url),
    "utf8"
  );
  const face = readFileSync(
    new URL("../src/components/chief/ChiefInterface.jsx", import.meta.url),
    "utf8"
  );
  const list = readFileSync(
    new URL("../src/components/chief/ChiefConversationList.jsx", import.meta.url),
    "utf8"
  );

  assert.match(page, /from "\.\/ChiefInterface\.jsx"/);
  assert.match(page, /workspace=\{room === "convos" \? conversationList : null\}/);
  assert.match(
    face,
    /workspace \? <div className="chief-workspace-slot">\{workspace\}<\/div> : null/
  );
  assert.match(list, /aria-label="Conversations"/);
  assert.match(list, /Today|group\.label/);
  assert.match(list, /role="menu"/);
  assert.match(list, /Rename/);
  assert.match(list, /Archive/);
  assert.match(list, /Restore/);
  assert.match(list, /Delete/);
  assert.match(list, /event\.key !== "Escape"/);
  assert.match(list, /maxLength=\{80\}/);
  assert.equal(list.includes("pinned"), false);
  assert.equal(page.includes("conversation_retrieve"), false);
});
