// Conversation lifecycle — list the caller's interactive sessions, then use
// Phase 17 history and the existing chat path to open and continue one.

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
import { projectInteractiveSessions } from "../server/chief/runtime/sessions.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";

const SCHEDULE_MARKER = "SCHEDULE_PROMPT_MARKER";
const TAINT_MARKER = "user_private_taint";
const APPROVAL_MARKER = "approval-call-secret";
const CIPHER_MARKER = "ciphertext-should-not-leak";

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
  const headers = {};
  const chunks = [];
  const state = { statusCode: null, body: null, ended: false };
  const response = {
    headersSent: false,
    setHeader(name, value) {
      headers[name] = value;
    },
    getHeader(name) {
      return headers[name];
    },
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
  return { response, headers, chunks, state };
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

function frames(chunks) {
  return chunks
    .join("")
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.replace(/^data: /, "")));
}

const auth = (uid) => async (req) => {
  if (!uid) {
    const error = new Error("Missing bearer token.");
    error.status = 401;
    throw error;
  }
  return { uid: req.uid ?? uid };
};

function stamp(store, sessionId, { createdAt, updatedAt, title } = {}) {
  const record = store.sessions.get(sessionId);
  if (createdAt) record.createdAt = new Date(createdAt);
  if (updatedAt) record.updatedAt = new Date(updatedAt);
  if (title !== undefined) record.title = title;
}

async function seed(
  store,
  userId,
  sessionId,
  { context, transcript, title, createdAt, updatedAt } = {}
) {
  const created = await store.createSession({ userId, sessionId, context });
  if (transcript || context) {
    const loaded = await store.load(userId, sessionId);
    const checkpoint = structuredClone(loaded.checkpoint);
    if (transcript) checkpoint.transcript = transcript;
    if (context) checkpoint.context = context;
    checkpoint.sessionTaint = [TAINT_MARKER];
    checkpoint.pendingApproval = {
      id: APPROVAL_MARKER,
      turnId: "turn",
      calls: [{ name: "memory_write" }],
    };
    checkpoint.approvedForSession = ["sticky-key"];
    await store.saveWithEvents(userId, sessionId, { checkpoint });
  }
  stamp(store, created.id, { createdAt, updatedAt, title });
  return created.id;
}

function chatDeps(store, uid = "user-a") {
  return {
    store,
    engine: textEngine("Noted"),
    authenticate: auth(uid),
    toolExecutor: new ToolExecutor(),
  };
}

test("an authenticated caller lists only their interactive sessions", async () => {
  const store = new MemoryCheckpointStore();
  const mine = await seed(store, "user-a", "session-mine", {
    title: "Freedom OS",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
    transcript: [{ role: "user", content: "private herd note" }],
    context: { workspace: "should-not-leak" },
  });
  await seed(store, "user-b", "session-foreign", {
    title: "Other household",
    updatedAt: "2026-09-30T00:00:00.000Z",
    transcript: [{ role: "user", content: "foreign note" }],
  });
  await seed(store, "user-a", "session-scheduled", {
    context: { origin: "schedule", scheduledTaskId: "task-1", runId: "run-1" },
    transcript: [{ role: "user", content: SCHEDULE_MARKER }],
    updatedAt: "2026-09-30T12:00:00.000Z",
  });

  const http = mockResponse();
  await handleChiefSessions(request(), http.response, {
    store,
    authenticate: auth("user-a"),
  });
  assert.equal(http.state.statusCode, 200);
  assert.deepEqual(http.state.body.sessions, [
    {
      sessionId: mine,
      title: "Freedom OS",
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-28T00:00:00.000Z",
    },
  ]);
  const serialized = JSON.stringify(http.state.body);
  assert.equal(serialized.includes("session-foreign"), false);
  assert.equal(serialized.includes("foreign note"), false);
  assert.equal(serialized.includes("Other household"), false);
  assert.equal(serialized.includes("user-b"), false);
  assert.equal(serialized.includes(SCHEDULE_MARKER), false);
  assert.equal(serialized.includes("task-1"), false);
  assert.equal(serialized.includes("run-1"), false);
  assert.equal(serialized.includes("schedule"), false);
  assert.equal(serialized.includes("private herd note"), false);
  assert.equal(serialized.includes("should-not-leak"), false);
  assert.equal(serialized.includes(TAINT_MARKER), false);
  assert.equal(serialized.includes(APPROVAL_MARKER), false);
  assert.equal(serialized.includes("sticky-key"), false);
  assert.equal(serialized.includes("user-a"), false);
  assert.deepEqual(Object.keys(http.state.body.sessions[0]).sort(), [
    "createdAt",
    "sessionId",
    "title",
    "updatedAt",
  ]);
});

test("session order is updatedAt descending, then sessionId ascending", async () => {
  const store = new MemoryCheckpointStore();
  await seed(store, "user-a", "session-b", {
    updatedAt: "2026-09-22T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  await seed(store, "user-a", "session-a", {
    updatedAt: "2026-09-22T00:00:00.000Z",
    createdAt: "2026-09-02T00:00:00.000Z",
  });
  await seed(store, "user-a", "session-c", {
    updatedAt: "2026-09-25T00:00:00.000Z",
    createdAt: "2026-09-03T00:00:00.000Z",
  });
  const http = mockResponse();
  await handleChiefSessions(request(), http.response, { store, authenticate: auth("user-a") });
  assert.deepEqual(
    http.state.body.sessions.map((session) => session.sessionId),
    ["session-c", "session-a", "session-b"]
  );
});

test("an empty session list is an empty array", async () => {
  const store = new MemoryCheckpointStore();
  const http = mockResponse();
  await handleChiefSessions(request(), http.response, { store, authenticate: auth("user-a") });
  assert.equal(http.state.statusCode, 200);
  assert.deepEqual(http.state.body, { sessions: [] });
});

test("a blank title stays null and is not generated", async () => {
  const store = new MemoryCheckpointStore();
  await seed(store, "user-a", "session-blank", {
    title: "   ",
    transcript: [{ role: "user", content: "Name me" }],
  });
  const http = mockResponse();
  await handleChiefSessions(request(), http.response, { store, authenticate: auth("user-a") });
  assert.equal(http.state.body.sessions[0].title, null);
  assert.equal(JSON.stringify(http.state.body).includes("Name me"), false);
});

test("a listed session id opens that session's Phase 17 history", async () => {
  const store = new MemoryCheckpointStore();
  await seed(store, "user-a", "session-one", {
    updatedAt: "2026-09-20T00:00:00.000Z",
    transcript: [
      { role: "user", content: "first conversation" },
      { role: "assistant", content: "first reply" },
    ],
  });
  await seed(store, "user-a", "session-two", {
    updatedAt: "2026-09-21T00:00:00.000Z",
    transcript: [{ role: "user", content: "second conversation" }],
  });
  const listed = mockResponse();
  await handleChiefSessions(request(), listed.response, { store, authenticate: auth("user-a") });
  const selected = listed.state.body.sessions[0].sessionId;
  assert.equal(selected, "session-two");

  const history = mockResponse();
  await handleChiefHistory(request({ query: { session_id: selected } }), history.response, {
    store,
    authenticate: auth("user-a"),
  });
  assert.equal(history.state.statusCode, 200);
  assert.equal(history.state.body.sessionId, selected);
  assert.deepEqual(history.state.body.messages, [{ role: "user", text: "second conversation" }]);

  const foreign = mockResponse();
  await handleChiefHistory(
    request({ query: { session_id: selected }, uid: "user-b" }),
    foreign.response,
    { store, authenticate: auth("user-b") }
  );
  assert.equal(foreign.state.statusCode, 404);
  assert.equal(JSON.stringify(foreign.state.body).includes("second conversation"), false);
});

test("chat without session_id creates a session the list can open and resume", async () => {
  const store = new MemoryCheckpointStore();
  const started = mockResponse();
  await handleChiefChat(
    request({
      method: "POST",
      body: {
        submission: {
          id: "m1",
          op: { type: "message", message: { text: "Start a new conversation" } },
        },
      },
    }),
    started.response,
    chatDeps(store)
  );
  const sessionId = frames(started.chunks).at(-1).msg.session_id;
  assert.equal(typeof sessionId, "string");

  const listed = mockResponse();
  await handleChiefSessions(request(), listed.response, { store, authenticate: auth("user-a") });
  assert.deepEqual(
    listed.state.body.sessions.map((session) => session.sessionId),
    [sessionId]
  );

  const opened = mockResponse();
  await handleChiefHistory(request({ query: { session_id: sessionId } }), opened.response, {
    store,
    authenticate: auth("user-a"),
  });
  assert.equal(opened.state.body.messages[0].text, "Start a new conversation");

  const continued = mockResponse();
  await handleChiefChat(
    request({
      method: "POST",
      body: {
        session_id: sessionId,
        submission: { id: "m2", op: { type: "message", message: { text: "Continue it" } } },
      },
    }),
    continued.response,
    chatDeps(store)
  );
  assert.equal(frames(continued.chunks).at(-1).msg.session_id, sessionId);

  const after = mockResponse();
  await handleChiefSessions(request(), after.response, { store, authenticate: auth("user-a") });
  assert.equal(after.state.body.sessions.length, 1);
  assert.equal(after.state.body.sessions[0].sessionId, sessionId);

  const history = mockResponse();
  await handleChiefHistory(request({ query: { session_id: sessionId } }), history.response, {
    store,
    authenticate: auth("user-a"),
  });
  assert.deepEqual(
    history.state.body.messages.map((message) => message.text),
    ["Start a new conversation", "Noted", "Continue it", "Noted"]
  );
});

test("another caller's list cannot discover foreign sessions by id", async () => {
  const store = new MemoryCheckpointStore();
  await seed(store, "user-a", "session-private", {
    title: "Private",
    transcript: [{ role: "user", content: "only mine" }],
  });
  const http = mockResponse();
  await handleChiefSessions(
    request({ uid: "user-b", query: { session_id: "session-private" } }),
    http.response,
    { store, authenticate: auth("user-b") }
  );
  assert.deepEqual(http.state.body, { sessions: [] });
  assert.equal(JSON.stringify(http.state.body).includes("session-private"), false);
  assert.equal(JSON.stringify(http.state.body).includes("only mine"), false);
});

test("session discovery requires GET and a verified user", async () => {
  const store = new MemoryCheckpointStore();
  const posted = mockResponse();
  await handleChiefSessions(request({ method: "POST" }), posted.response, {
    store,
    authenticate: auth("user-a"),
  });
  assert.equal(posted.state.statusCode, 405);

  const denied = mockResponse();
  await handleChiefSessions(request(), denied.response, {
    store,
    authenticate: auth(null),
  });
  assert.equal(denied.state.statusCode, 401);
});

test("the prisma list reads owned session metadata inside withUserContext", async () => {
  const seen = [];
  const store = new PrismaCheckpointStore({
    withUser: async (userId, fn) => {
      seen.push(userId);
      return fn({
        chiefSession: {
          async findMany({ where, select }) {
            seen.push({ where, select });
            return [
              {
                id: "mine",
                title: "Herd",
                createdAt: new Date("2026-09-20T00:00:00.000Z"),
                updatedAt: new Date("2026-09-28T00:00:00.000Z"),
                contextJson: {},
                stateCiphertext: CIPHER_MARKER,
              },
              {
                id: "scheduled",
                title: "Nightly",
                createdAt: new Date("2026-09-29T00:00:00.000Z"),
                updatedAt: new Date("2026-09-30T00:00:00.000Z"),
                contextJson: { origin: "schedule", scheduledTaskId: "task-9", runId: "run-9" },
              },
            ];
          },
        },
      });
    },
    encrypt: (value) => value,
    decrypt: (value) => value,
  });
  const rows = await store.listOwnedSessions("user-a");
  assert.equal(seen[0], "user-a");
  assert.equal(seen[1].where.userId, "user-a");
  assert.equal(seen[1].select.id, true);
  assert.equal(seen[1].select.title, true);
  assert.equal(seen[1].select.createdAt, true);
  assert.equal(seen[1].select.updatedAt, true);
  assert.equal(seen[1].select.contextJson, true);
  assert.equal(seen[1].select.stateCiphertext, undefined);
  assert.equal(Object.hasOwn(seen[1].select, "checkpoint"), false);

  const sessions = projectInteractiveSessions(rows);
  assert.deepEqual(sessions, [
    {
      sessionId: "mine",
      title: "Herd",
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-28T00:00:00.000Z",
    },
  ]);
  const serialized = JSON.stringify(sessions);
  assert.equal(serialized.includes(CIPHER_MARKER), false);
  assert.equal(serialized.includes("task-9"), false);
  assert.equal(serialized.includes("Nightly"), false);
});

test("discovery does not add a second transcript store or a search index", () => {
  const sessions = readFileSync(
    new URL("../server/chief/runtime/sessions.js", import.meta.url),
    "utf8"
  );
  const route = readFileSync(new URL("../api/chief/sessions.js", import.meta.url), "utf8");
  const chat = readFileSync(new URL("../api/chief/chat.js", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const turn = readFileSync(new URL("../server/chief/runtime/turn.js", import.meta.url), "utf8");
  const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const source of [code(sessions), code(route)]) {
    assert.equal(source.includes("session_search"), false);
    assert.equal(source.includes("FTS5"), false);
    assert.equal(source.includes("TurnMachine"), false);
    assert.equal(source.includes("runChiefTick"), false);
    assert.equal(source.includes("saveWithEvents"), false);
    assert.equal(source.includes("createSession"), false);
  }
  assert.equal(route.includes("listOwnedSessions"), true);
  assert.equal(route.includes("projectInteractiveHistory"), false);
  assert.match(chat, /sessionId: body\.session_id \?\? null/);
  assert.equal(schema.includes("model ChiefConversation"), false);
  assert.equal(schema.match(/model ChiefSession/g).length, 1);
  assert.equal(turn.includes("projectInteractiveSessions"), false);
  assert.equal(turn.includes("listOwnedSessions"), false);
  assert.deepEqual(projectInteractiveSessions([]), []);
});
