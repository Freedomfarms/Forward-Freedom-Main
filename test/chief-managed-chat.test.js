import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handleChiefChat } from "../api/chief/chat.js";
import { drainManagedWork } from "../server/chief/managed/chatTurn.js";
import {
  METADATA_VALUE_MAX,
  agentKeyFor,
  productionAgentBody,
  toolFingerprint,
} from "../server/chief/managed/productionAgent.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { createChiefTools } from "../server/chief/tools/builtin.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";
import { scriptedManagedClient } from "./chief-managed-client-fixture.js";
import { createMemoryWorkQueue } from "../server/chief/managed/workQueue.js";

function mockResponse() {
  const chunks = [];
  const state = { statusCode: null, ended: false };
  const response = {
    headersSent: false,
    setHeader() {},
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

function request(body) {
  return {
    method: "POST",
    headers: {},
    body,
    socket: { remoteAddress: "127.0.0.1" },
    on() {},
    uid: "user-1",
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

const auth = async (req) => ({ uid: req.uid });

test("chat does not call the legacy turn machine", () => {
  const source = readFileSync(new URL("../api/chief/chat.js", import.meta.url), "utf8");
  assert.equal(source.includes("new TurnMachine("), false);
  assert.equal(source.includes("ChiefModelEngine"), false);
  assert.equal(source.includes("createModelEngine"), false);
  assert.match(source, /runManagedChiefTurn/);
});

test("an old transcript is not sent to Claude", async () => {
  const store = new MemoryCheckpointStore();
  const seeded = await store.createSession({
    userId: "user-1",
    sessionId: "old-session",
    context: { origin: "legacy" },
  });
  seeded.checkpoint.transcript = [{ role: "user", content: "OLD-TRANSCRIPT-SECRET" }];
  await store.saveWithEvents("user-1", "old-session", { checkpoint: seeded.checkpoint });
  const client = scriptedManagedClient([{ text: "Fresh answer." }]);
  const http = mockResponse();
  await handleChiefChat(
    request({
      session_id: "old-session",
      submission: { id: "s1", op: { type: "message", message: { text: "New question" } } },
    }),
    http.response,
    { store, client, authenticate: auth, toolExecutor: new ToolExecutor() }
  );
  const payload = JSON.stringify(client.state.sent);
  assert.equal(payload.includes("OLD-TRANSCRIPT-SECRET"), false);
  assert.match(payload, /New question/);
  assert.equal(frames(http.chunks).at(-1).msg.status, "completed");
});

test("a schedule session is not resumed by chat", async () => {
  const store = new MemoryCheckpointStore();
  await store.createSession({
    userId: "user-1",
    sessionId: "sched",
    context: { origin: "schedule" },
  });
  const client = scriptedManagedClient([{ text: "nope" }]);
  const http = mockResponse();
  await handleChiefChat(
    request({
      session_id: "sched",
      submission: { id: "s1", op: { type: "message", message: { text: "continue" } } },
    }),
    http.response,
    { store, client, authenticate: auth, toolExecutor: new ToolExecutor() }
  );
  assert.equal(client.state.sent.length, 0);
  assert.equal(
    frames(http.chunks).some((event) => event.msg.type === "submission_rejected"),
    true
  );
});

test("a still-running session is queued and the drain resumes it", async () => {
  const store = new MemoryCheckpointStore();
  const client = scriptedManagedClient([{ running: true }]);
  const jobs = createMemoryWorkQueue();
  const http = mockResponse();
  await handleChiefChat(
    request({
      submission: { id: "s1", op: { type: "message", message: { text: "Plan the feeder." } } },
    }),
    http.response,
    {
      store,
      client,
      jobs,
      authenticate: auth,
      toolExecutor: new ToolExecutor(),
      budgetMs: 0,
      sleepFn: async () => {},
    }
  );
  assert.equal(frames(http.chunks).at(-1).msg.status, "continuing");
  assert.equal(jobs.rows.size, 1);
  const session = [...client.state.sessions.values()][0];
  session.status = "idle";
  session.events.push({
    id: "later",
    type: "agent.message",
    content: [{ type: "text", text: "The feeder plan is ready." }],
  });
  session.events.push({ id: "idle-later", type: "session.status_idle" });
  const drained = await drainManagedWork({ jobs, client, store, sleepFn: async () => {} });
  assert.equal(drained.drained, 1);
  assert.equal([...jobs.rows.values()][0].status, "succeeded");
  const record = await store.load("user-1", frames(http.chunks).at(-1).msg.session_id);
  assert.match(JSON.stringify(record.checkpoint.transcript), /feeder plan is ready/);
});

test("a missing provider configuration does not fall back", async () => {
  const http = mockResponse();
  await handleChiefChat(
    request({
      submission: { id: "s1", op: { type: "message", message: { text: "Hi" } } },
    }),
    http.response,
    {
      store: new MemoryCheckpointStore(),
      client: null,
      authenticate: auth,
      toolExecutor: new ToolExecutor(),
    }
  );
  const body = http.chunks.join("");
  assert.match(body, /ANTHROPIC_API_KEY/);
  assert.equal(body.includes("TurnMachine"), false);
});

test("the production agent body stays inside the Managed Agents limits", () => {
  const specs = createChiefTools().map((tool) => tool.spec);
  const raw = `agent:chief:production:${toolFingerprint(specs)}`;
  assert.ok(raw.length > METADATA_VALUE_MAX);
  const key = agentKeyFor(specs);
  assert.ok(key.length <= METADATA_VALUE_MAX);
  assert.match(key, /^agent:chief:production:[a-f0-9]{64}$/);
  const body = productionAgentBody({
    toolSpecs: specs,
    idempotencyKey: key,
  });
  assert.equal(body.metadata.freedom_os_key, key);
  const custom = body.tools.filter((tool) => tool.type === "custom");
  assert.equal(custom.length, specs.length);
  for (const tool of custom) {
    for (const name of Object.keys(tool.input_schema)) {
      assert.ok(name === "type" || name === "properties" || name === "required");
    }
    assert.equal(tool.input_schema.type, "object");
    assert.equal(Object.hasOwn(tool.input_schema, "additionalProperties"), false);
  }
  const search = custom.find((tool) => tool.name === "web_search");
  assert.deepEqual(search.input_schema.required, ["query"]);
  assert.equal(search.input_schema.properties.query.type, "string");
});
