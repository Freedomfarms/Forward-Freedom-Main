import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handleChiefChat } from "../api/chief/chat.js";
import { drainManagedWork } from "../server/chief/managed/chatTurn.js";
import {
  BUILTIN_AGENT_TOOL_NAMES,
  METADATA_VALUE_MAX,
  agentKeyFor,
  localToolName,
  productionAgentBody,
  toolFingerprint,
} from "../server/chief/managed/productionAgent.js";
import { providerErrorFields } from "../server/chief/managed/redact.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import { createChiefTools } from "../server/chief/tools/builtin.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";
import { createWebSearchClient, createWebSearchTool } from "../server/chief/tools/web-search.js";
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

test("resume_session continues the same Managed Agents session without a second prompt", async () => {
  const store = new MemoryCheckpointStore();
  const client = scriptedManagedClient([{ running: true }]);
  const http = mockResponse();
  await handleChiefChat(
    request({
      submission: { id: "s1", op: { type: "message", message: { text: "Plan the feeder." } } },
    }),
    http.response,
    {
      store,
      client,
      authenticate: auth,
      toolExecutor: new ToolExecutor(),
      budgetMs: 0,
      sleepFn: async () => {},
    }
  );
  const first = frames(http.chunks);
  const sessionId = first.at(-1).msg.session_id;
  assert.equal(first.at(-1).msg.status, "continuing");
  assert.equal(client.state.sessions.size, 1);
  const session = [...client.state.sessions.values()][0];
  session.status = "idle";
  session.events.push({
    id: "later",
    type: "agent.message",
    content: [{ type: "text", text: "The feeder plan is ready." }],
  });
  session.events.push({ id: "idle-later", type: "session.status_idle" });
  const http2 = mockResponse();
  await handleChiefChat(
    request({
      session_id: sessionId,
      submission: { id: "s2", op: { type: "resume_session", session_id: sessionId } },
    }),
    http2.response,
    {
      store,
      client,
      authenticate: auth,
      toolExecutor: new ToolExecutor(),
      sleepFn: async () => {},
    }
  );
  const second = frames(http2.chunks);
  assert.equal(second.at(-1).msg.status, "completed");
  assert.equal(
    second.some(
      (event) =>
        event.msg?.type === "assistant_content_delta" &&
        event.msg.delta.includes("The feeder plan is ready.")
    ),
    true
  );
  assert.equal(client.state.sessions.size, 1);
  assert.equal(
    client.state.sent.some((item) =>
      (item.events || []).some((event) => event.type === "user.message")
    ),
    false
  );
  const record = await store.load("user-1", sessionId);
  assert.equal(record.checkpoint.context.turnStatus, "completed");
  assert.equal(record.checkpoint.transcript.filter((message) => message.role === "user").length, 1);
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
  const search = custom.find((tool) => tool.name === "chief_web_search");
  const reserved = new Set(BUILTIN_AGENT_TOOL_NAMES);
  const names = new Set();
  assert.equal(
    custom.some((tool) => tool.name === "web_search"),
    false
  );
  for (const tool of custom) {
    assert.match(tool.name, /^[A-Za-z0-9_-]{1,128}$/);
    assert.equal(reserved.has(tool.name), false);
    assert.equal(names.has(tool.name), false);
    names.add(tool.name);
    assert.equal(tool.description.length >= 1 && tool.description.length <= 1000, true);
  }
  assert.equal(localToolName("chief_web_search"), "web_search");
  assert.equal(localToolName("memory_read"), "memory_read");
  const localSearch = specs.find((spec) => spec.name === "web_search");
  const schedule = specs.find((spec) => spec.name === "schedule_create");
  assert.equal(localSearch.requiresConfirmation, false);
  assert.deepEqual([...localSearch.requiredCapabilities], ["web:search"]);
  assert.equal(schedule.requiresConfirmation, true);
  assert.deepEqual(search.input_schema.required, ["query"]);
  assert.equal(search.input_schema.properties.query.type, "string");
  assert.equal(Object.hasOwn(search.input_schema, "additionalProperties"), false);
});

test("chief_web_search runs the Brave-backed web_search tool", async () => {
  const requests = [];
  const tool = createWebSearchTool(
    createWebSearchClient({
      env: { BRAVE_SEARCH_API_KEY: "BSA-test-key-should-never-leak" },
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), token: init.headers["X-Subscription-Token"] });
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              web: {
                results: [
                  {
                    title: "Hay prices",
                    url: "https://example.com/hay",
                    description: "Prices are steady.",
                  },
                ],
              },
            };
          },
        };
      },
    })
  );
  const policy = new CapabilityPolicy({ defaultDeny: true });
  policy.grant("chief", Capability.WEB_SEARCH);
  const http = mockResponse();
  await handleChiefChat(
    request({
      submission: { id: "s1", op: { type: "message", message: { text: "hay prices" } } },
    }),
    http.response,
    {
      store: new MemoryCheckpointStore(),
      client: scriptedManagedClient([
        { tool: { id: "tool-search", name: "chief_web_search", input: { query: "hay prices" } } },
        { text: "Hay prices are steady." },
      ]),
      authenticate: auth,
      toolExecutor: new ToolExecutor({ tools: [tool], policy }),
      toolSpecs: [tool.spec],
    }
  );
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).origin, "https://api.search.brave.com");
  assert.equal(requests[0].url.includes("BSA-test-key"), false);
  assert.equal(requests[0].token, "BSA-test-key-should-never-leak");
  const events = frames(http.chunks);
  const began = events.find((event) => event.msg.type === "tool_call_begin");
  assert.equal(began.msg.name, "web_search");
  assert.equal(events.at(-1).msg.status, "completed");
  assert.match(events.map((event) => event.msg.delta || "").join(""), /Hay prices are steady/);
  assert.equal(http.chunks.join("").includes("BSA-test-key"), false);
});

test("a provider failure is logged without secrets or the user text", async () => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => {
    lines.push(args.map((part) => String(part)).join(" "));
  };
  const http = mockResponse();
  try {
    const client = {
      async listAgents() {
        const error = new Error(
          "createAgent rejected sk-ant-api03-secretvalue for user farmer@example.com"
        );
        error.status = 400;
        error.operation = "createAgent";
        throw error;
      },
    };
    await handleChiefChat(
      request({
        submission: {
          id: "s1",
          op: { type: "message", message: { text: "private account 88421" } },
        },
      }),
      http.response,
      {
        store: new MemoryCheckpointStore(),
        client,
        authenticate: auth,
        toolExecutor: new ToolExecutor(),
      }
    );
  } finally {
    console.error = original;
  }
  const body = http.chunks.join("");
  const log = lines.join("\n");
  assert.match(body, /The turn could not be completed/);
  assert.equal(body.includes("sk-ant-api03"), false);
  assert.equal(body.includes("farmer@example.com"), false);
  assert.equal(body.includes("88421"), false);
  assert.match(log, /\[chief\/chat\] createAgent 400/);
  assert.match(log, /<redacted>/);
  assert.equal(log.includes("sk-ant-api03"), false);
  assert.equal(log.includes("farmer@example.com"), false);
  assert.equal(log.includes("88421"), false);
  const fields = providerErrorFields({
    operation: "createAgent",
    status: 400,
    message: "bad sk-ant-api03-secretvalue",
  });
  assert.equal(fields.message.includes("sk-ant-api03"), false);
});
