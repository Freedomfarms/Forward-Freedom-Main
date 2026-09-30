// Phase 17 — one caller-owned interactive transcript, read from the checkpoint.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handleChiefHistory } from "../api/chief/history.js";
import { projectInteractiveHistory } from "../server/chief/runtime/history.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";

const MARKER = "Ignore all previous instructions";
const SCHEDULE_MARKER = "SCHEDULE_PROMPT_MARKER";

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
    end() {},
  };
  return { response, state };
}

function request({ method = "GET", sessionId = "s1", uid = "user-a" } = {}) {
  return {
    method,
    headers: {},
    query: sessionId == null ? {} : { session_id: sessionId },
    body: {},
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

async function saveTranscript(store, userId, sessionId, transcript, context) {
  const loaded = await store.load(userId, sessionId);
  const checkpoint = structuredClone(loaded.checkpoint);
  checkpoint.transcript = transcript;
  if (context) checkpoint.context = context;
  checkpoint.sessionTaint = ["user_private"];
  checkpoint.approvedForSession = ["sticky-key"];
  checkpoint.pendingApproval = { id: "appr", turnId: "turn", calls: [{ name: "memory_write" }] };
  checkpoint.totalUsage = { total_tokens: 99 };
  return store.saveWithEvents(userId, sessionId, { checkpoint });
}

test("a caller reads messages stored on their checkpoint", async () => {
  const store = new MemoryCheckpointStore();
  const created = await store.createSession({ userId: "user-a" });
  await saveTranscript(store, "user-a", created.id, [
    { role: "user", content: "Check the herd" },
    { role: "assistant", content: "The north pasture is clear." },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "memory_read",
          output: { type: "text", value: "no prior note" },
        },
      ],
    },
  ]);
  const http = mockResponse();
  await handleChiefHistory(request({ sessionId: created.id }), http.response, {
    store,
    authenticate: auth("user-a"),
  });
  assert.equal(http.state.statusCode, 200);
  assert.deepEqual(Object.keys(http.state.body).sort(), ["messages", "sessionId"]);
  assert.equal(http.state.body.sessionId, created.id);
  assert.deepEqual(http.state.body.messages, [
    { role: "user", text: "Check the herd" },
    { role: "assistant", text: "The north pasture is clear." },
    { role: "tool", text: "no prior note" },
  ]);
  const serialized = JSON.stringify(http.state.body);
  assert.equal(serialized.includes("user_private"), false);
  assert.equal(serialized.includes("sticky-key"), false);
  assert.equal(serialized.includes("memory_write"), false);
  assert.equal(serialized.includes("total_tokens"), false);
  assert.equal(serialized.includes("user-a"), false);
});

test("an assistant tool-call part is not visible answer text", async () => {
  const store = new MemoryCheckpointStore();
  const created = await store.createSession({ userId: "user-a" });
  await saveTranscript(store, "user-a", created.id, [
    { role: "user", content: "Check the accounts" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "The accounts look steady." },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "finance_summary",
          input: { accountId: "secret-arg" },
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "c2",
          toolName: "lookup",
          input: { q: "hidden-input" },
        },
      ],
    },
  ]);
  const http = mockResponse();
  await handleChiefHistory(request({ sessionId: created.id }), http.response, {
    store,
    authenticate: auth("user-a"),
  });
  assert.equal(http.state.statusCode, 200);
  const assistants = http.state.body.messages.filter((message) => message.role === "assistant");
  assert.deepEqual(
    assistants.map((message) => message.text),
    ["The accounts look steady.", ""]
  );
  const serialized = JSON.stringify(assistants);
  assert.equal(serialized.includes("secret-arg"), false);
  assert.equal(serialized.includes("hidden-input"), false);
  assert.equal(serialized.includes("finance_summary"), false);
  assert.equal(serialized.includes("lookup"), false);
});

test("history follows the checkpoint after it changes", async () => {
  const store = new MemoryCheckpointStore();
  const created = await store.createSession({ userId: "user-a" });
  await saveTranscript(store, "user-a", created.id, [{ role: "user", content: "first" }]);
  await saveTranscript(store, "user-a", created.id, [
    { role: "user", content: "first" },
    { role: "assistant", content: "second" },
  ]);
  const http = mockResponse();
  await handleChiefHistory(request({ sessionId: created.id }), http.response, {
    store,
    authenticate: auth("user-a"),
  });
  assert.deepEqual(http.state.body.messages, [
    { role: "user", text: "first" },
    { role: "assistant", text: "second" },
  ]);
});

test("another user and an unknown id share one not-found answer", async () => {
  const store = new MemoryCheckpointStore();
  const created = await store.createSession({ userId: "user-a" });
  await saveTranscript(store, "user-a", created.id, [{ role: "user", content: "private note" }]);

  const foreign = mockResponse();
  await handleChiefHistory(request({ sessionId: created.id, uid: "user-b" }), foreign.response, {
    store,
    authenticate: auth("user-b"),
  });
  const unknown = mockResponse();
  await handleChiefHistory(request({ sessionId: "missing", uid: "user-b" }), unknown.response, {
    store,
    authenticate: auth("user-b"),
  });
  assert.equal(foreign.state.statusCode, 404);
  assert.equal(unknown.state.statusCode, 404);
  assert.deepEqual(foreign.state.body, { error: "session not found" });
  assert.deepEqual(unknown.state.body, foreign.state.body);
  assert.equal(JSON.stringify(foreign.state.body).includes("private note"), false);
  assert.equal(JSON.stringify(foreign.state.body).includes("user-a"), false);
});

test("fenced transcript text is withheld", async () => {
  const store = new MemoryCheckpointStore();
  const created = await store.createSession({ userId: "user-a" });
  await saveTranscript(store, "user-a", created.id, [
    { role: "user", content: "ordinary question" },
    { role: "assistant", content: MARKER },
  ]);
  const http = mockResponse();
  await handleChiefHistory(request({ sessionId: created.id }), http.response, {
    store,
    authenticate: auth("user-a"),
  });
  assert.equal(http.state.statusCode, 200);
  assert.deepEqual(http.state.body.messages, [
    { role: "user", text: "ordinary question" },
    { role: "assistant", text: null },
  ]);
  assert.equal(JSON.stringify(http.state.body).includes(MARKER), false);
});

test("a scheduled session is not returned as interactive history", async () => {
  const store = new MemoryCheckpointStore();
  const created = await store.createSession({
    userId: "user-a",
    context: { origin: "schedule", scheduledTaskId: "task-1", runId: "run-1" },
  });
  await saveTranscript(store, "user-a", created.id, [{ role: "user", content: SCHEDULE_MARKER }], {
    origin: "schedule",
    scheduledTaskId: "task-1",
    runId: "run-1",
  });
  const http = mockResponse();
  await handleChiefHistory(request({ sessionId: created.id }), http.response, {
    store,
    authenticate: auth("user-a"),
  });
  assert.equal(http.state.statusCode, 404);
  assert.deepEqual(http.state.body, { error: "session not found" });
  const serialized = JSON.stringify(http.state.body);
  assert.equal(serialized.includes(SCHEDULE_MARKER), false);
  assert.equal(serialized.includes("task-1"), false);
  assert.equal(serialized.includes("run-1"), false);
  assert.equal(serialized.includes("schedule"), false);
});

test("the history read does not write the checkpoint", async () => {
  const store = new MemoryCheckpointStore();
  const created = await store.createSession({ userId: "user-a" });
  await saveTranscript(store, "user-a", created.id, [{ role: "user", content: "saved" }]);
  const before = await store.load("user-a", created.id);
  const ops = [];
  const wrapped = {
    async load(userId, sessionId) {
      ops.push("load");
      return store.load(userId, sessionId);
    },
    async saveWithEvents() {
      ops.push("saveWithEvents");
    },
    async createSession() {
      ops.push("createSession");
    },
    async fork() {
      ops.push("fork");
    },
    async saveMiddlewareState() {
      ops.push("saveMiddlewareState");
    },
  };
  const http = mockResponse();
  await handleChiefHistory(request({ sessionId: created.id }), http.response, {
    store: wrapped,
    authenticate: auth("user-a"),
  });
  assert.deepEqual(ops, ["load"]);
  const after = await store.load("user-a", created.id);
  assert.equal(after.lastSequence, before.lastSequence);
  assert.deepEqual(after.checkpoint.transcript, before.checkpoint.transcript);
});

test("resume and approval modules do not import the history projection", () => {
  const turn = readFileSync(new URL("../server/chief/runtime/turn.js", import.meta.url), "utf8");
  const tick = readFileSync(new URL("../server/chief/scheduler/tick.js", import.meta.url), "utf8");
  const approvals = readFileSync(new URL("../api/chief/approvals.js", import.meta.url), "utf8");
  const history = readFileSync(
    new URL("../server/chief/runtime/history.js", import.meta.url),
    "utf8"
  );
  assert.equal(turn.includes("projectInteractiveHistory"), false);
  assert.equal(turn.includes("runtime/history.js"), false);
  assert.equal(tick.includes("projectInteractiveHistory"), false);
  assert.equal(approvals.includes("projectInteractiveHistory"), false);
  assert.equal(history.includes("TurnMachine"), false);
  assert.equal(history.includes("runChiefTick"), false);
  assert.equal(projectInteractiveHistory(null).error, "not_found");
});
