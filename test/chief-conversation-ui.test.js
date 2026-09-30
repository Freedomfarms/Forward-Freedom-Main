// One conversation lifecycle: chat SSE through the frontend reducer, then
// history, a continued session, and an approval resume. The engine and
// checkpoint are in memory. Firebase and Postgres are not used.

import test from "node:test";
import assert from "node:assert/strict";

import { handleChiefApprovals } from "../api/chief/approvals.js";
import { handleChiefChat } from "../api/chief/chat.js";
import { handleChiefHistory } from "../api/chief/history.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import {
  applyChiefEvent,
  initialTurnState,
  publicTranscriptMessages,
} from "../src/utils/chiefProtocol.js";
import { lookupExecutor } from "./chief-tool-fixture.js";

function scriptedEngine(steps) {
  let index = 0;
  return {
    async openStream() {
      const step = steps[index] ?? { parts: [] };
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

function request({ method = "POST", body = {}, query = {}, uid = "user-1" } = {}) {
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

function reduceFrames(events, sessionId = null) {
  return events.reduce(
    (state, event) => applyChiefEvent(state, event),
    initialTurnState(sessionId)
  );
}

const auth = (uid) => async (req) => ({ uid: req.uid ?? uid });

test("chat, history, continue, and approval stay on one session without tool-call text", async () => {
  const store = new MemoryCheckpointStore();
  const executed = [];
  const deps = {
    store,
    authenticate: auth("user-1"),
    toolExecutor: lookupExecutor({
      onExecute: (call) => executed.push(call.name),
      output: "found",
    }),
    engine: scriptedEngine([
      {
        parts: [
          { type: "reasoning-delta", text: "hidden-reasoning" },
          { type: "text-delta", text: "The accounts look steady." },
        ],
      },
      {
        parts: [
          { type: "text-delta", text: "Looking now." },
          { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: { q: "secret-arg" } },
        ],
      },
      {
        parts: [{ type: "text-delta", text: "Here is the result." }],
      },
    ]),
  };

  const started = mockResponse();
  await handleChiefChat(
    request({
      body: {
        submission: {
          id: "m1",
          op: { type: "message", message: { text: "How are the accounts?" } },
        },
      },
    }),
    started.response,
    deps
  );
  const startedEvents = frames(started.chunks);
  const startedTurn = reduceFrames(startedEvents);
  const sessionId = startedEvents.at(-1).msg.session_id;
  assert.equal(startedEvents.at(-1).msg.type, "session_configured");
  assert.equal(startedEvents.at(-1).msg.status, "completed");
  assert.equal(typeof sessionId, "string");
  assert.equal(startedTurn.sessionId, sessionId);
  assert.equal(startedTurn.finished, true);
  assert.equal(startedTurn.streamText, "The accounts look steady.");
  assert.equal(startedTurn.streamText.includes("hidden-reasoning"), false);
  assert.equal(
    startedEvents.some(
      (event) => event.msg.type === "assistant_content_delta" && event.msg.phase === "reasoning"
    ),
    true
  );
  assert.equal(
    startedEvents.some(
      (event) => event.msg.type === "assistant_content_delta" && event.msg.phase === "commentary"
    ),
    false
  );

  const opened = mockResponse();
  await handleChiefHistory(
    request({ method: "GET", query: { session_id: sessionId } }),
    opened.response,
    deps
  );
  assert.deepEqual(publicTranscriptMessages(opened.state.body.messages), [
    {
      id: "user-0",
      role: "user",
      text: "How are the accounts?",
    },
    {
      id: "assistant-1",
      role: "assistant",
      text: "The accounts look steady.",
    },
  ]);

  const continued = mockResponse();
  await handleChiefChat(
    request({
      body: {
        session_id: sessionId,
        submission: {
          id: "m2",
          op: { type: "message", message: { text: "Look up the vendor." } },
        },
      },
    }),
    continued.response,
    deps
  );
  const continuedEvents = frames(continued.chunks);
  const continuedTurn = reduceFrames(continuedEvents, sessionId);
  assert.equal(continuedEvents.at(-1).msg.session_id, sessionId);
  assert.equal(continuedEvents.at(-1).msg.status, "suspended");
  assert.equal(continuedTurn.sessionId, sessionId);
  assert.equal(continuedTurn.finished, false);
  assert.equal(continuedTurn.status, "Waiting for approval");
  assert.equal(typeof continuedTurn.approval?.id, "string");
  assert.equal(continuedTurn.streamText, "Looking now.");
  assert.equal(JSON.stringify(continuedTurn).includes("secret-arg"), false);
  assert.equal(JSON.stringify(continuedTurn).includes("lookup"), false);

  const suspended = mockResponse();
  await handleChiefHistory(
    request({ method: "GET", query: { session_id: sessionId } }),
    suspended.response,
    deps
  );
  const suspendedAssistants = suspended.state.body.messages.filter(
    (message) => message.role === "assistant"
  );
  assert.deepEqual(
    suspendedAssistants.map((message) => message.text),
    ["The accounts look steady.", "Looking now."]
  );
  assert.equal(JSON.stringify(suspendedAssistants).includes("secret-arg"), false);
  assert.equal(JSON.stringify(suspendedAssistants).includes("lookup"), false);

  const decided = mockResponse();
  await handleChiefApprovals(
    request({
      body: {
        session_id: sessionId,
        submission: {
          id: "m3",
          op: {
            type: "exec_approval",
            id: continuedTurn.approval.id,
            decision: "approved",
          },
        },
      },
    }),
    decided.response,
    deps
  );
  assert.equal(decided.state.statusCode, 200);
  assert.equal(decided.state.body.sessionId, sessionId);
  assert.equal(decided.state.body.status, "completed");
  assert.equal(decided.state.body.pendingApproval, null);
  assert.deepEqual(executed, ["lookup"]);

  const pending = mockResponse();
  await handleChiefApprovals(request({ method: "GET" }), pending.response, deps);
  assert.deepEqual(pending.state.body.approvals, []);

  const finished = mockResponse();
  await handleChiefHistory(
    request({ method: "GET", query: { session_id: sessionId } }),
    finished.response,
    deps
  );
  const visible = publicTranscriptMessages(finished.state.body.messages);
  assert.deepEqual(
    visible.map((message) => message.text),
    [
      "How are the accounts?",
      "The accounts look steady.",
      "Look up the vendor.",
      "Looking now.",
      "Here is the result.",
    ]
  );
  const assistantHistory = finished.state.body.messages.filter(
    (message) => message.role === "assistant"
  );
  const serialized = JSON.stringify(assistantHistory);
  assert.equal(serialized.includes("secret-arg"), false);
  assert.equal(serialized.includes("lookup"), false);
  assert.equal(serialized.includes("hidden-reasoning"), false);
  assert.equal(serialized.includes("Here is the result."), true);
});
