// CHIEF HTTP shell — auth, SSE chat, and the approvals resume path.
// Dependencies are injected. The default handler is not invoked, so these
// tests do not touch Firebase or Postgres.

import test from "node:test";
import assert from "node:assert/strict";

import { handleChiefChat } from "../api/chief/chat.js";
import { handleChiefApprovals } from "../api/chief/approvals.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { lookupExecutor } from "./chief-tool-fixture.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";

function textEngine(text = "Hello") {
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

function request({ method = "POST", body = {}, uid = "user-1" } = {}) {
  return {
    method,
    headers: {},
    body,
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

test("chat requires POST and a verified user", async () => {
  const store = new MemoryCheckpointStore();
  const deps = {
    store,
    engine: textEngine(),
    authenticate: auth(null),
    toolExecutor: new ToolExecutor(),
  };
  const get = mockResponse();
  await handleChiefChat(request({ method: "GET" }), get.response, deps);
  assert.equal(get.state.statusCode, 405);

  const denied = mockResponse();
  await handleChiefChat(request(), denied.response, deps);
  assert.equal(denied.state.statusCode, 401);
  assert.match(denied.state.body.error, /bearer/i);
});

test("chat streams the turn and ends with session_configured", async () => {
  const store = new MemoryCheckpointStore();
  const http = mockResponse();
  await handleChiefChat(
    request({
      body: { submission: { id: "s1", op: { type: "message", message: { text: "Hi" } } } },
    }),
    http.response,
    {
      store,
      engine: textEngine("Hello"),
      authenticate: auth("user-1"),
      toolExecutor: new ToolExecutor(),
    }
  );
  assert.equal(http.state.statusCode, 200);
  assert.match(http.headers["Content-Type"], /text\/event-stream/);
  const events = frames(http.chunks);
  assert.equal(events[0].msg.type, "turn_started");
  assert.equal(
    events.some((event) => event.msg.type === "assistant_content_delta"),
    true
  );
  const tail = events.at(-1).msg;
  assert.equal(tail.type, "session_configured");
  assert.equal(tail.status, "completed");
  assert.equal(typeof tail.session_id, "string");
  assert.equal(http.state.ended, true);
});

test("a thrown turn error is redacted on the SSE stream", async () => {
  const http = mockResponse();
  const engine = {
    async openStream() {
      throw new Error("provider secret sk-live-should-not-leak");
    },
  };
  await handleChiefChat(
    request({
      body: { submission: { id: "s1", op: { type: "message", message: { text: "Hi" } } } },
    }),
    http.response,
    {
      store: new MemoryCheckpointStore(),
      engine,
      authenticate: auth("user-1"),
      toolExecutor: new ToolExecutor(),
    }
  );
  const body = http.chunks.join("");
  assert.equal(body.includes("sk-live"), false);
  const events = frames(http.chunks);
  assert.equal(events.at(-1).msg.kind, "internal");
  assert.equal(events.at(-1).msg.message, "The turn could not be completed.");
});

test("approvals lists a pending batch and a decision resumes it", async () => {
  const store = new MemoryCheckpointStore();
  const steps = [
    { parts: [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: { q: "a" } }] },
    { parts: [{ type: "text-delta", text: "done" }] },
  ];
  let index = 0;
  const engine = {
    async openStream() {
      const step = steps[index];
      index += 1;
      return {
        fullStream: (async function* stream() {
          for (const part of step.parts) yield part;
        })(),
        finalize: async () => ({
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          content: "",
          tool_calls: [],
          finish_reason: "stop",
        }),
      };
    },
  };
  const executed = [];
  const deps = {
    store,
    engine,
    authenticate: auth("user-1"),
    toolExecutor: lookupExecutor({
      onExecute: (call) => executed.push(call.name),
      output: "ok",
    }),
  };
  const chat = mockResponse();
  await handleChiefChat(
    request({
      body: { submission: { id: "s1", op: { type: "message", message: { text: "find" } } } },
    }),
    chat.response,
    deps
  );
  const configured = frames(chat.chunks).at(-1).msg;
  assert.equal(configured.status, "suspended");

  const listed = mockResponse();
  await handleChiefApprovals(request({ method: "GET" }), listed.response, deps);
  assert.equal(listed.state.statusCode, 200);
  assert.equal(listed.state.body.approvals.length, 1);
  assert.equal(listed.state.body.approvals[0].calls[0].name, "lookup");

  const decided = mockResponse();
  await handleChiefApprovals(
    request({
      body: {
        session_id: configured.session_id,
        submission: {
          id: "s2",
          op: {
            type: "exec_approval",
            id: listed.state.body.approvals[0].id,
            decision: "approved",
          },
        },
      },
    }),
    decided.response,
    deps
  );
  assert.equal(decided.state.statusCode, 200);
  assert.equal(decided.state.body.status, "completed");
  assert.equal(decided.state.body.pendingApproval, null);
  assert.deepEqual(executed, ["lookup"]);
});
