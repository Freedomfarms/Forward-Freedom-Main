// B3.3 conversation sidebar: navigation over the existing session list and
// the owner-scoped lexical search. The model tools stay off this path.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handleChiefHistory } from "../api/chief/history.js";
import { handleChiefSessionSearch } from "../api/chief/session-search.js";
import { handleChiefSessions } from "../api/chief/sessions.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import {
  partitionSidebarConversations,
  readSidebarCollapsed,
  sidebarSearchPath,
  writeSidebarCollapsed,
} from "../src/utils/chiefSidebar.js";

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function mockResponse() {
  const state = { statusCode: null, body: null };
  const response = {
    headersSent: false,
    setHeader() {},
    getHeader() {},
    status(code) {
      state.statusCode = code;
      return response;
    },
    json(payload) {
      state.body = payload;
      response.headersSent = true;
      return response;
    },
  };
  return { response, state };
}

function request({ method = "GET", query = {}, body = {}, uid = "user-a" } = {}) {
  return {
    method,
    headers: {},
    body,
    query,
    socket: { remoteAddress: "127.0.0.1" },
    on() {},
    uid,
  };
}

const auth = (uid) => async (req) => {
  if (!uid) {
    const error = new Error("Missing bearer token.");
    error.status = 401;
    throw error;
  }
  return { uid: req.uid ?? uid };
};

function deps(store, uid = "user-a") {
  return { store, authenticate: auth(uid) };
}

async function seed(store, userId, sessionId, { title, text, archived = false, origin } = {}) {
  await store.createSession({
    userId,
    sessionId,
    context: origin ? { origin } : {},
  });
  const loaded = await store.load(userId, sessionId);
  const checkpoint = structuredClone(loaded.checkpoint);
  checkpoint.transcript = [{ role: "user", content: text }];
  if (origin) checkpoint.context = { origin };
  await store.saveWithEvents(userId, sessionId, { checkpoint });
  const record = store.sessions.get(sessionId);
  record.title = title;
  if (archived) record.archivedAt = new Date("2026-09-22T00:00:00.000Z");
  await store.setRecallDocument(userId, sessionId);
  return sessionId;
}

test("sidebar partitions recent conversations and marks the empty browse state", () => {
  const idle = partitionSidebarConversations({
    sessions: [
      { sessionId: "current", title: "CHIEF Architecture", updatedAt: "2026-09-30T00:00:00.000Z" },
      { sessionId: "older", title: "Freedom OS", updatedAt: "2026-09-29T00:00:00.000Z" },
    ],
    archivedSessions: [
      { sessionId: "boxed", title: "Older conversation", updatedAt: "2026-09-22T00:00:00.000Z" },
    ],
  });
  assert.equal(idle.searching, false);
  assert.deepEqual(
    idle.recent.map((session) => session.sessionId),
    ["current", "older"]
  );
  assert.equal(idle.archived[0].sessionId, "boxed");
  assert.equal(idle.emptyLabel, "");
  assert.equal(partitionSidebarConversations().emptyLabel, "No conversations yet.");
});

test("sidebar search results split archived matches and show an empty state", () => {
  const hits = partitionSidebarConversations({
    query: "Jarvis",
    searchResults: [
      { sessionId: "live", title: "Jarvis / OpenJarvis", archived: false, snippet: "Jarvis notes" },
      { sessionId: "old", title: "Older Jarvis", archived: true, snippet: "Jarvis archive" },
    ],
  });
  assert.equal(hits.searching, true);
  assert.deepEqual(
    hits.recent.map((session) => session.sessionId),
    ["live"]
  );
  assert.equal(hits.archived[0].archived, true);
  assert.equal(hits.emptyLabel, "");
  assert.equal(
    partitionSidebarConversations({ query: "missing", searchResults: [] }).emptyLabel,
    "No conversations found"
  );
});

test("sidebar search path carries the query and no user id", () => {
  assert.equal(sidebarSearchPath("Jarvis"), "/api/chief/session-search?q=Jarvis");
  const path = sidebarSearchPath("CHIEF architecture");
  assert.match(path, /^\/api\/chief\/session-search\?q=/);
  assert.equal(path.includes("user_id"), false);
  assert.equal(path.includes("userId"), false);
});

test("collapsed preference is stored in the browser and can expand again", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(readSidebarCollapsed(storage), false);
  writeSidebarCollapsed(storage, true);
  assert.equal(readSidebarCollapsed(storage), true);
  writeSidebarCollapsed(storage, false);
  assert.equal(readSidebarCollapsed(storage), false);
  assert.doesNotThrow(() =>
    writeSidebarCollapsed(
      {
        setItem() {
          throw new Error("storage blocked");
        },
      },
      true
    )
  );
});

test("session search is owner-scoped, redacted, and hides scheduled sessions", async () => {
  const store = new MemoryCheckpointStore();
  await seed(store, "user-a", "architecture", {
    title: "CHIEF Architecture",
    text: "We decided the CHIEF architecture should feel like Jarvis, budget $500, account 123456789.",
  });
  await seed(store, "user-a", "archived-jarvis", {
    title: "Older Jarvis note",
    text: "Jarvis stayed a reference, not a second product.",
    archived: true,
  });
  await seed(store, "user-a", "nightly", {
    title: "Nightly Jarvis",
    text: "Jarvis nightly digest",
    origin: "schedule",
  });
  store.sessions.get("nightly").recallDocument = "Jarvis nightly digest";
  await seed(store, "user-b", "other", {
    title: "Someone else's Jarvis",
    text: "Jarvis belongs to user-b.",
  });

  const found = mockResponse();
  await handleChiefSessionSearch(
    request({ query: { q: "Jarvis", user_id: "user-b" } }),
    found.response,
    deps(store, "user-a")
  );
  assert.equal(found.state.statusCode, 200);
  const ids = found.state.body.conversations.map((row) => row.sessionId);
  assert.deepEqual(ids.sort(), ["architecture", "archived-jarvis"]);
  assert.equal(ids.includes("nightly"), false);
  assert.equal(ids.includes("other"), false);
  const architecture = found.state.body.conversations.find(
    (row) => row.sessionId === "architecture"
  );
  assert.equal(architecture.archived, false);
  assert.equal(architecture.title, "CHIEF Architecture");
  assert.equal(architecture.snippet.includes("$500"), false);
  assert.equal(architecture.snippet.includes("123456789"), false);
  assert.equal(JSON.stringify(found.state.body).includes("user-a"), false);
  assert.equal(JSON.stringify(found.state.body).includes("user_id"), false);
  const archived = found.state.body.conversations.find(
    (row) => row.sessionId === "archived-jarvis"
  );
  assert.equal(archived.archived, true);

  const intruder = mockResponse();
  await handleChiefSessionSearch(
    request({ query: { q: "Jarvis", user_id: "user-a" }, uid: "user-b" }),
    intruder.response,
    deps(store, "user-b")
  );
  assert.deepEqual(
    intruder.state.body.conversations.map((row) => row.sessionId),
    ["other"]
  );

  const missed = mockResponse();
  await handleChiefSessionSearch(
    request({ query: { q: "zephyr" } }),
    missed.response,
    deps(store, "user-a")
  );
  assert.deepEqual(missed.state.body.conversations, []);

  const phrase = mockResponse();
  await handleChiefSessionSearch(
    request({ query: { q: "CHIEF architecture" } }),
    phrase.response,
    deps(store, "user-a")
  );
  assert.equal(
    phrase.state.body.conversations.some((row) => row.sessionId === "architecture"),
    true
  );
});

test("session search ignores a browser user id and does not open another user's transcript", async () => {
  const store = new MemoryCheckpointStore();
  await seed(store, "user-a", "private-session", {
    title: "Private",
    text: "Jarvis private note",
  });

  const denied = mockResponse();
  await handleChiefHistory(
    request({ query: { session_id: "private-session", user_id: "user-a" }, uid: "user-b" }),
    denied.response,
    deps(store, "user-b")
  );
  assert.equal(denied.state.statusCode, 404);
  assert.equal(denied.state.body.error, "session not found");

  const anonymous = mockResponse();
  await handleChiefSessionSearch(request({ query: { q: "Jarvis" } }), anonymous.response, {
    store,
    authenticate: auth(""),
  });
  assert.equal(anonymous.state.statusCode, 401);

  const wrongMethod = mockResponse();
  await handleChiefSessionSearch(
    request({ method: "POST", body: { user_id: "user-a", q: "Jarvis" } }),
    wrongMethod.response,
    deps(store)
  );
  assert.equal(wrongMethod.state.statusCode, 405);
});

test("sidebar search does not change the B2 session list", async () => {
  const store = new MemoryCheckpointStore();
  await seed(store, "user-a", "visible", {
    title: "CHIEF Interface",
    text: "The room stays centered.",
  });
  await seed(store, "user-a", "boxed", {
    title: "Archived room",
    text: "Kept for later.",
    archived: true,
  });
  await seed(store, "user-a", "nightly", {
    title: "Nightly",
    text: "Scheduled Jarvis",
    origin: "schedule",
  });

  const listed = mockResponse();
  await handleChiefSessions(request(), listed.response, deps(store));
  assert.equal(listed.state.statusCode, 200);
  assert.deepEqual(
    listed.state.body.sessions.map((row) => row.sessionId),
    ["visible"]
  );
  assert.equal("snippet" in listed.state.body.sessions[0], false);
  assert.equal(JSON.stringify(listed.state.body).includes("nightly"), false);
  assert.equal(JSON.stringify(listed.state.body).includes("boxed"), false);

  const route = read("api/chief/sessions.js");
  const search = read("api/chief/session-search.js");
  assert.equal(route.includes("searchConversations"), false);
  assert.equal(route.includes("session_search"), false);
  assert.equal(route.includes("FTS5"), false);
  assert.equal(search.includes("conversation_retrieve"), false);
  assert.equal(search.includes("retrieveOwnedConversation"), false);
  assert.match(search, /authenticate\(request\)\)\.uid/);
});

test("sidebar UI navigates with the existing session flow", () => {
  const page = read("src/components/chief/ChiefPage.jsx");
  const list = read("src/components/chief/ChiefConversationList.jsx");
  const api = read("src/utils/chiefApi.js");
  const sidebar = read("src/utils/chiefSidebar.js");
  const css = read("src/global.css");

  assert.match(page, /className=\{navCollapsed \? "chief-nav is-collapsed" : "chief-nav"\}/);
  assert.match(page, /has-nav/);
  assert.match(page, /is-nav-collapsed/);
  assert.match(page, /fetchChiefSessionSearch/);
  assert.match(page, /function selectSession\(sessionId\)/);
  assert.match(page, /loadHistory\(sessionId, token\)/);
  assert.match(page, /function startNewConversation\(\)/);
  assert.match(page, /setActiveSessionId\(null\)/);
  assert.match(page, /writeStoredSessionId\(null\)/);
  assert.equal(page.includes("conversation_retrieve"), false);
  assert.equal(page.includes("user_id"), false);
  assert.equal(page.includes("memory_write"), false);

  assert.match(list, /Search conversations\.\.\./);
  assert.match(list, /aria-label="Search conversations"/);
  assert.match(list, /view\.emptyLabel/);
  assert.match(sidebar, /No conversations found/);
  assert.match(sidebar, /No conversations yet\./);
  assert.match(list, />Recent</);
  assert.match(list, />Archived</);
  assert.match(list, /chief-convo-flag/);
  assert.match(list, /session\.sessionId === activeSessionId/);
  assert.match(list, /is-active/);
  assert.match(list, /onSelect\(session\.sessionId\)/);
  assert.match(list, /\+ New Conversation/);
  assert.match(list, /onNewConversation/);
  assert.equal(list.includes("conversation_retrieve"), false);
  assert.equal(list.includes("user_id"), false);

  assert.match(api, /export function fetchChiefSessionSearch/);
  assert.match(api, /sidebarSearchPath\(query\)/);
  assert.match(api, /session_id: sessionId/);
  assert.equal(api.includes("user_id"), false);
  assert.equal(api.includes("conversation_retrieve"), false);

  assert.match(css, /\.chief-room\.has-nav\.is-nav-collapsed/);
  assert.match(css, /\.chief-field-frame \{\s*position: absolute;\s*inset: 0;/);
  assert.match(css, /max-width: 1023px/);
  assert.match(css, /\.chief-nav \{\s*display: none;/);
  assert.match(read("server/index.js"), /\/api\/chief\/session-search/);
});
