// Conversation management on the existing ChiefSession store.
// Ownership is the authenticated user. A body user id is ignored.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handleChiefChat } from "../api/chief/chat.js";
import { handleChiefHistory } from "../api/chief/history.js";
import { handleChiefSessions } from "../api/chief/sessions.js";
import {
  MemoryCheckpointStore,
  PrismaCheckpointStore,
} from "../server/chief/runtime/checkpoint.js";
import {
  sanitizeConversationTitle,
  titleFromTranscript,
} from "../server/chief/runtime/conversationTitle.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";

function textEngine(text = "Noted") {
  return {
    async openStream() {
      return {
        fullStream: (async function* stream() {
          yield { type: "text-delta", text };
        })(),
        finalize: async () => ({
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          content: text,
          tool_calls: [],
          finish_reason: "stop",
        }),
      };
    },
  };
}

function mockResponse() {
  const state = { statusCode: null, body: null, ended: false };
  const chunks = [];
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
    write(chunk) {
      chunks.push(String(chunk));
      response.headersSent = true;
    },
    end() {
      state.ended = true;
    },
  };
  return { response, chunks, state };
}

function request({ method = "GET", body = {}, query = {}, uid = "user-a" } = {}) {
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

async function seed(store, userId, sessionId, { transcript, context, title } = {}) {
  await store.createSession({ userId, sessionId, context });
  if (transcript) {
    const loaded = await store.load(userId, sessionId);
    const checkpoint = structuredClone(loaded.checkpoint);
    checkpoint.transcript = transcript;
    if (context) checkpoint.context = context;
    await store.saveWithEvents(userId, sessionId, { checkpoint });
  }
  if (title !== undefined) store.sessions.get(sessionId).title = title;
  return sessionId;
}

async function chat(store, body, uid = "user-a") {
  const http = mockResponse();
  await handleChiefChat(request({ method: "POST", body, uid }), http.response, {
    store,
    engine: textEngine("Noted"),
    authenticate: auth(uid),
    toolExecutor: new ToolExecutor(),
  });
  return http;
}

test("titles stay empty until a real exchange and skip private financial detail", () => {
  assert.equal(sanitizeConversationTitle("  "), null);
  assert.equal(sanitizeConversationTitle("Ok"), null);
  assert.equal(titleFromTranscript([{ role: "user", content: "What's my True Cash?" }]), null);
  assert.equal(
    titleFromTranscript([
      { role: "user", content: "What's my True Cash?" },
      { role: "assistant", content: "True Cash is the liquid position." },
    ]),
    "What's my True Cash"
  );
  assert.equal(sanitizeConversationTitle("Checking account ending 1234 has $42,381"), null);
  assert.equal(
    sanitizeConversationTitle("Freedom Financial Budget Review"),
    "Freedom Financial Budget Review"
  );
  assert.equal(sanitizeConversationTitle("password hunter2"), null);
  assert.equal(
    titleFromTranscript([
      { role: "user", content: "<compacted_context> old notes" },
      { role: "assistant", content: "Ready" },
    ]),
    null
  );
});

test("the first completed exchange titles the session once", async () => {
  const store = new MemoryCheckpointStore();
  const started = await chat(store, {
    submission: { id: "m1", op: { type: "message", message: { text: "What's my True Cash?" } } },
  });
  assert.equal(started.state.statusCode, 200);
  const sessionId = store.sessions.keys().next().value;
  assert.equal(store.sessions.get(sessionId).title, "What's my True Cash");

  await chat(store, {
    session_id: sessionId,
    submission: {
      id: "m2",
      op: { type: "message", message: { text: "Continue the budget review" } },
    },
  });
  assert.equal(store.sessions.get(sessionId).title, "What's my True Cash");
});

test("a sensitive first message stays untitled", async () => {
  const store = new MemoryCheckpointStore();
  await chat(store, {
    submission: {
      id: "m1",
      op: {
        type: "message",
        message: { text: "Checking account ending 1234 has $42,381" },
      },
    },
  });
  const session = [...store.sessions.values()][0];
  assert.equal(session.title, null);
});

test("rename is owner-scoped, trimmed, and kept after the next turn", async () => {
  const store = new MemoryCheckpointStore();
  await seed(store, "user-a", "session-a", {
    title: "Old",
    transcript: [
      { role: "user", content: "Budget" },
      { role: "assistant", content: "Ready" },
    ],
  });
  await seed(store, "user-b", "session-b", { title: "Theirs" });

  const foreign = mockResponse();
  await handleChiefSessions(
    request({
      method: "PATCH",
      body: { session_id: "session-b", title: "Stolen", userId: "user-b" },
    }),
    foreign.response,
    deps(store)
  );
  assert.equal(foreign.state.statusCode, 404);
  assert.equal(store.sessions.get("session-b").title, "Theirs");

  const renamed = mockResponse();
  await handleChiefSessions(
    request({
      method: "PATCH",
      body: {
        session_id: "session-a",
        title: "  Freedom Financial Budget Review  ",
        userId: "user-b",
      },
    }),
    renamed.response,
    deps(store)
  );
  assert.equal(renamed.state.statusCode, 200);
  assert.equal(renamed.state.body.session.title, "Freedom Financial Budget Review");
  assert.equal(store.sessions.get("session-a").title, "Freedom Financial Budget Review");

  await chat(store, {
    session_id: "session-a",
    submission: { id: "m3", op: { type: "message", message: { text: "A different topic" } } },
  });
  assert.equal(store.sessions.get("session-a").title, "Freedom Financial Budget Review");
});

test("invalid titles are rejected", async () => {
  const store = new MemoryCheckpointStore();
  await seed(store, "user-a", "session-a", { title: "Keep" });
  for (const title of [
    "",
    "   ",
    "x".repeat(81),
    "Balance is $42,381",
    "ending 1234",
    "api key sk-live",
  ]) {
    const http = mockResponse();
    await handleChiefSessions(
      request({ method: "PATCH", body: { session_id: "session-a", title } }),
      http.response,
      deps(store)
    );
    assert.equal(http.state.statusCode, 400, title);
    assert.equal(store.sessions.get("session-a").title, "Keep");
  }
});

test("archive leaves the checkpoint, hides the session, and can be restored", async () => {
  const store = new MemoryCheckpointStore();
  await seed(store, "user-a", "session-live", {
    transcript: [
      { role: "user", content: "Keep this transcript" },
      { role: "assistant", content: "Kept" },
    ],
  });
  await seed(store, "user-a", "session-other", {
    transcript: [{ role: "user", content: "Other conversation" }],
  });
  store.sessions.get("session-live").status = "PENDING_APPROVAL";

  const archived = mockResponse();
  await handleChiefSessions(
    request({
      method: "PATCH",
      body: { session_id: "session-live", archived: true, userId: "user-b" },
    }),
    archived.response,
    deps(store)
  );
  assert.equal(archived.state.statusCode, 200);
  assert.equal(store.sessions.get("session-live").status, "PENDING_APPROVAL");
  assert.ok(store.sessions.get("session-live").archivedAt);

  const active = mockResponse();
  await handleChiefSessions(request(), active.response, deps(store));
  assert.deepEqual(
    active.state.body.sessions.map((session) => session.sessionId),
    ["session-other"]
  );
  assert.deepEqual(Object.keys(active.state.body.sessions[0]).sort(), [
    "createdAt",
    "sessionId",
    "title",
    "updatedAt",
  ]);

  const hidden = mockResponse();
  await handleChiefSessions(request({ query: { archived: "1" } }), hidden.response, deps(store));
  assert.deepEqual(
    hidden.state.body.sessions.map((session) => session.sessionId),
    ["session-live"]
  );

  const history = mockResponse();
  await handleChiefHistory(
    request({ query: { session_id: "session-live" } }),
    history.response,
    deps(store)
  );
  assert.equal(history.state.statusCode, 200);
  assert.equal(history.state.body.messages[0].text, "Keep this transcript");

  const blocked = await chat(store, {
    session_id: "session-live",
    submission: { id: "m4", op: { type: "message", message: { text: "Still there?" } } },
  });
  assert.equal(blocked.state.statusCode, 409);
  assert.match(blocked.state.body.error, /Restore it before sending/);
  assert.equal(
    store.sessions
      .get("session-live")
      .checkpoint.transcript.some((message) => String(message.content).includes("Still there?")),
    false
  );

  const foreign = mockResponse();
  await handleChiefSessions(
    request({
      method: "PATCH",
      uid: "user-b",
      body: { session_id: "session-live", archived: false },
    }),
    foreign.response,
    deps(store, "user-b")
  );
  assert.equal(foreign.state.statusCode, 404);
  assert.ok(store.sessions.get("session-live").archivedAt);

  const restored = mockResponse();
  await handleChiefSessions(
    request({ method: "PATCH", body: { session_id: "session-live", archived: false } }),
    restored.response,
    deps(store)
  );
  assert.equal(restored.state.statusCode, 200);
  assert.equal(store.sessions.get("session-live").archivedAt, null);

  const listed = mockResponse();
  await handleChiefSessions(request(), listed.response, deps(store));
  assert.equal(
    listed.state.body.sessions.some((session) => session.sessionId === "session-live"),
    true
  );
});

test("a checkpoint save does not unarchive a conversation", async () => {
  const store = new MemoryCheckpointStore();
  await seed(store, "user-a", "session-live", {
    transcript: [{ role: "user", content: "Hello" }],
  });
  await store.setArchived("user-a", "session-live", true);
  const loaded = await store.load("user-a", "session-live");
  const checkpoint = structuredClone(loaded.checkpoint);
  checkpoint.pendingApproval = null;
  checkpoint.transcript.push({ role: "assistant", content: "Still archived" });
  await store.saveWithEvents("user-a", "session-live", { checkpoint });
  assert.ok(store.sessions.get("session-live").archivedAt);
  assert.equal(store.sessions.get("session-live").status, "ACTIVE");
});

test("delete requires confirmation and removes only that session's checkpoint and approvals", async () => {
  const store = new MemoryCheckpointStore();
  await seed(store, "user-a", "session-gone", {
    transcript: [
      { role: "user", content: "Delete me" },
      { role: "assistant", content: "Ok" },
    ],
  });
  await seed(store, "user-a", "session-stay", {
    transcript: [{ role: "user", content: "Leave me" }],
  });
  await seed(store, "user-b", "session-foreign", {
    transcript: [{ role: "user", content: "Not yours" }],
  });
  store.approvals = [
    { sessionId: "session-gone", callsCiphertext: "secret-call" },
    { sessionId: "session-stay", callsCiphertext: "keep-call" },
  ];

  const unconfirmed = mockResponse();
  await handleChiefSessions(
    request({ method: "DELETE", body: { session_id: "session-gone" } }),
    unconfirmed.response,
    deps(store)
  );
  assert.equal(unconfirmed.state.statusCode, 400);
  assert.ok(store.sessions.has("session-gone"));

  const wrong = mockResponse();
  await handleChiefSessions(
    request({
      method: "DELETE",
      uid: "user-b",
      body: { session_id: "session-gone", confirm: true, userId: "user-a" },
    }),
    wrong.response,
    deps(store, "user-b")
  );
  assert.equal(wrong.state.statusCode, 404);
  assert.ok(store.sessions.has("session-gone"));

  const missing = mockResponse();
  await handleChiefSessions(
    request({ method: "DELETE", body: { session_id: "missing", confirm: true } }),
    missing.response,
    deps(store)
  );
  assert.equal(missing.state.statusCode, 404);

  const removed = mockResponse();
  await handleChiefSessions(
    request({
      method: "DELETE",
      body: { session_id: "session-gone", confirm: true, userId: "user-b" },
    }),
    removed.response,
    deps(store)
  );
  assert.equal(removed.state.statusCode, 200);
  assert.equal(removed.state.body.deleted, true);
  assert.equal(store.sessions.has("session-gone"), false);
  assert.deepEqual(
    store.approvals.map((approval) => approval.sessionId),
    ["session-stay"]
  );

  const history = mockResponse();
  await handleChiefHistory(
    request({ query: { session_id: "session-gone" } }),
    history.response,
    deps(store)
  );
  assert.equal(history.state.statusCode, 404);

  const kept = mockResponse();
  await handleChiefHistory(
    request({ query: { session_id: "session-stay" } }),
    kept.response,
    deps(store)
  );
  assert.equal(kept.state.body.messages[0].text, "Leave me");
  assert.equal(store.sessions.get("session-foreign").checkpoint.transcript[0].content, "Not yours");
});

test("scheduled sessions are not archived or deleted as conversations", async () => {
  const store = new MemoryCheckpointStore();
  await seed(store, "user-a", "session-job", {
    context: { origin: "schedule", scheduledTaskId: "task-1" },
    transcript: [{ role: "user", content: "nightly" }],
  });
  const archived = mockResponse();
  await handleChiefSessions(
    request({ method: "PATCH", body: { session_id: "session-job", archived: true } }),
    archived.response,
    deps(store)
  );
  assert.equal(archived.state.statusCode, 404);
  const removed = mockResponse();
  await handleChiefSessions(
    request({ method: "DELETE", body: { session_id: "session-job", confirm: true } }),
    removed.response,
    deps(store)
  );
  assert.equal(removed.state.statusCode, 404);
  assert.ok(store.sessions.has("session-job"));
  const listed = mockResponse();
  await handleChiefSessions(request({ query: { archived: "1" } }), listed.response, deps(store));
  assert.deepEqual(listed.state.body, { sessions: [] });
});

test("prisma delete drops approvals for that session and leaves traces alone", async () => {
  const calls = [];
  const store = new PrismaCheckpointStore({
    withUser: async (userId, fn) =>
      fn({
        chiefSession: {
          async findFirst({ where }) {
            calls.push(["find", userId, where.userId, where.id]);
            if (where.userId === "user-a" && where.id === "mine") {
              return { id: "mine", contextJson: { workspace: "home" } };
            }
            return null;
          },
          async delete({ where }) {
            calls.push(["session", where.id]);
          },
        },
        chiefApproval: {
          async deleteMany({ where }) {
            calls.push(["approval", where.userId, where.sessionId]);
          },
        },
        chiefTrace: {
          delete() {
            throw new Error("trace delete");
          },
        },
      }),
    encrypt: (value) => value,
    decrypt: (value) => value,
  });
  assert.equal(await store.deleteOwnedSession("user-b", "mine"), false);
  assert.equal(await store.deleteOwnedSession("user-a", "mine"), true);
  assert.deepEqual(calls, [
    ["find", "user-b", "user-b", "mine"],
    ["find", "user-a", "user-a", "mine"],
    ["approval", "user-a", "mine"],
    ["session", "mine"],
  ]);
});

test("conversation capabilities use the checkpoint store and do not add a second store", () => {
  const route = readFileSync(new URL("../api/chief/sessions.js", import.meta.url), "utf8");
  const tools = readFileSync(new URL("../server/chief/tools/builtin.js", import.meta.url), "utf8");
  const checkpoint = readFileSync(
    new URL("../server/chief/runtime/checkpoint.js", import.meta.url),
    "utf8"
  );
  assert.equal(route.includes("AgentConversation"), false);
  assert.equal(route.includes("userId: body"), false);
  assert.equal(tools.includes("conversation_list"), false);
  assert.equal(tools.includes("conversation_rename"), true);
  assert.equal(tools.includes("conversation_archive"), true);
  assert.equal(tools.includes("conversation_restore"), true);
  assert.equal(tools.includes("conversation_delete"), true);
  assert.equal(tools.includes("renameSession"), true);
  assert.equal(tools.includes("setArchived"), true);
  assert.equal(tools.includes("deleteOwnedSession"), true);
  assert.equal(tools.includes("AgentConversation"), false);
  assert.equal(checkpoint.includes("agentConversation"), false);
  assert.equal(checkpoint.includes("chiefTrace.delete"), false);
});
