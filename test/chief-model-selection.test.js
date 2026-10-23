// User-selected CHIEF models stay on the existing session. Missing provider
// keys drop that family only. Firebase and Postgres are not used.

import test from "node:test";
import assert from "node:assert/strict";

import { handleChiefChat } from "../api/chief/chat.js";
import { handleChiefHistory } from "../api/chief/history.js";
import { handleChiefModels } from "../api/chief/models.js";
import { createModelEngine } from "../server/chief/models/engine.js";
import { MANAGED_MODEL_ROUTE } from "../server/chief/managed/productionAgent.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";
import { scriptedManagedClient } from "./chief-managed-client-fixture.js";

const silentLogger = { warn() {}, error() {}, log() {} };

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
  return { response, chunks, state };
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

const auth = (uid) => async (req) => ({ uid: req.uid ?? uid });

function submission(op) {
  return { id: `sub-${op.type}-${op.route ?? "message"}`, op };
}

async function postChat(deps, body) {
  const http = mockResponse();
  await handleChiefChat(request({ body }), http.response, deps);
  return { http, events: frames(http.chunks) };
}

test("Claude still answers when OpenAI and xAI keys are missing", () => {
  const engine = createModelEngine({
    env: { ANTHROPIC_API_KEY: "anthropic-secret" },
    logger: silentLogger,
  });
  const keys = engine.availableModelKeys();
  assert.ok(keys.includes("claude-sonnet-4-6"));
  assert.ok(keys.every((key) => key.startsWith("claude")));
  const answer = engine.resolve("How are the accounts?");
  assert.equal(answer.providerId, "anthropic");
  assert.ok(answer.modelKey.startsWith("claude"));
  const pinned = engine.resolve("def foo(): pass", { model: "claude-haiku-4-5" });
  assert.equal(pinned.modelKey, "claude-haiku-4-5");
  assert.equal(pinned.routed, false);
  assert.equal(engine.resolve("def foo(): pass").routed, true);
});

test("the model list exposes only providers that have credentials", async () => {
  const engine = createModelEngine({
    env: { CHIEF_ANTHROPIC_API_KEY: "anthropic-secret" },
    logger: silentLogger,
  });
  const http = mockResponse();
  await handleChiefModels(request({ method: "GET" }), http.response, {
    authenticate: auth("user-1"),
    engine,
  });
  assert.equal(http.state.statusCode, 200);
  assert.deepEqual(
    http.state.body.models.map((model) => model.group),
    ["Claude", "Claude", "Claude"]
  );
  assert.deepEqual(
    http.state.body.models.map((model) => model.id),
    ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]
  );
  assert.equal(http.state.body.defaultModel, null);
  const serialized = JSON.stringify(http.state.body);
  assert.equal(serialized.includes("anthropic-secret"), false);
  assert.equal(serialized.includes("API_KEY"), false);
  assert.equal(serialized.includes("credential"), false);
});

test("set_model stays on the managed Claude agent and keeps history", async () => {
  const store = new MemoryCheckpointStore();
  const client = scriptedManagedClient([{ text: "First answer." }, { text: "Second answer." }]);
  const deps = {
    store,
    authenticate: auth("user-1"),
    client,
    toolExecutor: new ToolExecutor(),
  };
  const first = await postChat(deps, {
    submission: submission({ type: "message", message: { text: "Hello" } }),
  });
  const sessionId = first.events.at(-1).msg.session_id;
  assert.equal(first.events.at(-1).msg.status, "completed");

  const pinned = await postChat(deps, {
    session_id: sessionId,
    submission: submission({ type: "set_model", route: MANAGED_MODEL_ROUTE }),
  });
  assert.equal(pinned.events.at(-1).msg.session_id, sessionId);
  assert.equal(
    pinned.events.some(
      (event) => event.msg.type === "model_changed" && event.msg.route === MANAGED_MODEL_ROUTE
    ),
    true
  );

  const second = await postChat(deps, {
    session_id: sessionId,
    submission: submission({ type: "message", message: { text: "Next" } }),
  });
  assert.equal(second.events.at(-1).msg.session_id, sessionId);
  const continued = client.state.sent.find((entry) => entry.sessionId);
  assert.equal(continued.events[0].content[0].text, "Next");
  assert.equal(JSON.stringify(continued).includes("Hello"), false);

  const history = mockResponse();
  await handleChiefHistory(
    request({ method: "GET", query: { session_id: sessionId } }),
    history.response,
    { store, authenticate: auth("user-1") }
  );
  assert.equal(history.state.body.modelRoute, MANAGED_MODEL_ROUTE);
  assert.deepEqual(
    history.state.body.messages.map((message) => message.text),
    ["Hello", "First answer.", "Next", "Second answer."]
  );
});

test("a non-Claude route is rejected and does not change the session", async () => {
  const store = new MemoryCheckpointStore();
  const client = scriptedManagedClient([{ text: "First answer." }]);
  const deps = {
    store,
    authenticate: auth("user-1"),
    client,
    toolExecutor: new ToolExecutor(),
  };
  const created = await postChat(deps, {
    submission: submission({ type: "message", message: { text: "Hello" } }),
  });
  const sessionId = created.events.at(-1).msg.session_id;
  assert.equal(typeof sessionId, "string");

  const rejected = await postChat(deps, {
    session_id: sessionId,
    submission: submission({ type: "set_model", route: "gpt-not-real" }),
  });
  assert.equal(
    rejected.events.some((event) => event.msg.type === "submission_rejected"),
    true
  );
  assert.equal(
    rejected.events.some((event) => event.msg.type === "model_changed"),
    false
  );
  assert.equal(rejected.events.at(-1).msg.session_id, sessionId);

  const absent = await postChat(deps, {
    submission: submission({ type: "set_model", route: "gpt-not-real" }),
  });
  assert.equal(
    absent.events.some((event) => event.msg.type === "submission_rejected"),
    true
  );
  assert.equal(absent.events.at(-1).msg.session_id, undefined);

  const history = mockResponse();
  await handleChiefHistory(
    request({ method: "GET", query: { session_id: sessionId } }),
    history.response,
    { store, authenticate: auth("user-1") }
  );
  assert.equal(history.state.body.modelRoute, MANAGED_MODEL_ROUTE);
  assert.deepEqual(
    history.state.body.messages.map((message) => message.text),
    ["Hello", "First answer."]
  );
  assert.equal((await store.listOwnedSessions("user-1")).length, 1);
});
