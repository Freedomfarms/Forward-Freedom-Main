// Reproduces the production turn-completion and voice-playback failures.
// Managed Agents and ElevenLabs are mocked. No provider calls.

import test from "node:test";
import assert from "node:assert/strict";

import { handleChiefChat } from "../api/chief/chat.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { projectInteractiveHistory } from "../server/chief/runtime/history.js";
import { scriptedManagedClient } from "./chief-managed-client-fixture.js";
import {
  applyChiefEvent,
  CHIEF_STATUS,
  initialTurnState,
  isSpeakableTurn,
} from "../src/utils/chiefProtocol.js";
import { normalizeChiefPreferences } from "../src/utils/chiefPreferences.js";
import { classifySettledDelivery, replySpeechText } from "../src/utils/chiefReplySpeech.js";
import { frontierStatusCopy, chiefLiveActivity } from "../src/components/chief/frontier/frontierActivity.js";
import { playPcmStream } from "../src/utils/chiefSpeech.js";

const GENERIC = "The turn could not be completed.";
const GREETING =
  "I don't really have days, but things are quiet and running fine on my end. What can I help you with?";
const PREAMBLE = "I'll start with what's already saved in your workspace.";
const STRATEGY = "The three priorities are turn completion, voice playback, and memory.";

function mockResponse() {
  const chunks = [];
  const response = {
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
    setHeader() {},
    status(code) {
      response.statusCode = code;
      return response;
    },
    json(payload) {
      response.body = payload;
      response.headersSent = true;
      return response;
    },
    write(chunk) {
      chunks.push(String(chunk));
      response.headersSent = true;
    },
    end() {
      response.writableEnded = true;
      response.writableFinished = true;
    },
    on() {},
  };
  return { response, chunks };
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

function deltas(events) {
  return events
    .filter(
      (event) => event.msg?.type === "assistant_content_delta" && event.msg.phase !== "reasoning"
    )
    .map((event) => event.msg.delta)
    .join("");
}

function messageBody(id, text, sessionId = null) {
  const body = { submission: { id, op: { type: "message", message: { text } } } };
  if (sessionId) body.session_id = sessionId;
  return body;
}

function resumeBody(sessionId, id) {
  return {
    session_id: sessionId,
    submission: { id, op: { type: "resume_session", session_id: sessionId } },
  };
}

const auth = async (req) => ({ uid: req.uid });

function resourceClient() {
  const session = { id: "prov_rel", status: "idle", events: [] };
  const sent = [];
  const hooks = { onCreate: null, onSend: null, onList: null };
  return {
    session,
    sent,
    hooks,
    async listAgents() {
      return [];
    },
    async createAgent(body) {
      return { id: "agent_1", version: "1", metadata: body?.metadata };
    },
    async retrieveAgent() {
      return { id: "agent_1", version: "1" };
    },
    async listEnvironments() {
      return [];
    },
    async createEnvironment(body) {
      return { id: "env_1", metadata: body?.metadata };
    },
    async retrieveEnvironment() {
      return { id: "env_1" };
    },
    async listMemoryStores() {
      return [];
    },
    async createMemoryStore(body) {
      return { id: "mem_1", metadata: body?.metadata };
    },
    async listMemories() {
      return [];
    },
    async createMemory() {
      return { id: "memfile" };
    },
    async createSession(body) {
      sent.push(body);
      session.status = "running";
      hooks.onCreate?.(session, body);
      return session;
    },
    async retrieveSession() {
      return session;
    },
    async listEvents() {
      hooks.onList?.(session);
      return session.events;
    },
    async sendEvents(id, events) {
      sent.push({ sessionId: id, events });
      hooks.onSend?.(session, events);
    },
  };
}

function chatDeps(store, client, extra = {}) {
  return {
    store,
    client,
    authenticate: auth,
    toolExecutor: extra.toolExecutor || { async execute() { return { output: "ok" }; } },
    toolSpecs: extra.toolSpecs || [],
    sleepFn: async () => {},
    budgetMs: extra.budgetMs ?? 1000,
    ...extra,
  };
}

function confirmations(client) {
  return client.sent.flatMap((item) => item.events || []).filter((event) => event.type === "user.tool_confirmation");
}

test("a greeting that is already streaming survives a later provider fault", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  let lists = 0;
  client.hooks.onCreate = (session) => {
    session.status = "running";
  };
  client.listEvents = async () => {
    lists += 1;
    if (lists === 1) {
      return [
        {
          id: "greet-1",
          type: "agent.message",
          content: [{ type: "text", text: GREETING }],
        },
      ];
    }
    if (lists === 2) {
      const error = new Error("listEvents rejected the cursor");
      error.status = 400;
      error.operation = "listEvents";
      throw error;
    }
    return client.session.events;
  };
  const first = mockResponse();
  await handleChiefChat(request(messageBody("q1", "How is your day?")), first.response, chatDeps(store, client));
  const opening = frames(first.chunks);
  const body = first.chunks.join("");
  assert.equal(body.includes(GENERIC), false);
  assert.equal(deltas(opening), GREETING);
  assert.equal(opening.at(-1).msg.type, "session_configured");
  assert.equal(opening.at(-1).msg.status, "continuing");
  const sessionId = opening.at(-1).msg.session_id;

  client.session.events.push({
    id: "greet-1",
    type: "agent.message",
    content: [{ type: "text", text: GREETING }],
  });
  client.session.events.push({
    id: "idle-greet",
    type: "session.status_idle",
    stop_reason: { type: "end_turn" },
  });
  client.session.status = "idle";
  const resumed = mockResponse();
  await handleChiefChat(request(resumeBody(sessionId, "resume-1")), resumed.response, chatDeps(store, client));
  const recovered = frames(resumed.chunks);
  assert.equal(resumed.chunks.join("").includes(GENERIC), false);
  assert.equal(recovered.at(-1).msg.status, "completed");
  const history = projectInteractiveHistory(await store.load("user-1", sessionId));
  assert.equal(history.turnStatus, "completed");
  assert.equal(history.turnError, null);
  assert.equal(history.messages.at(-1).text, GREETING);

  client.hooks.onSend = (session, events) => {
    const text = (events || []).find((event) => event.type === "user.message")?.content?.[0]?.text;
    if (!text) return;
    session.events.push({
      id: "second",
      type: "agent.message",
      content: [{ type: "text", text: `Second reply to ${text}` }],
    });
    session.events.push({
      id: "idle-second",
      type: "session.status_idle",
      stop_reason: { type: "end_turn" },
    });
    session.status = "idle";
  };
  const second = mockResponse();
  await handleChiefChat(
    request(messageBody("q2", "What should we do next?", sessionId)),
    second.response,
    chatDeps(store, client)
  );
  assert.equal(second.chunks.join("").includes(GENERIC), false);
  assert.equal(frames(second.chunks).at(-1).msg.status, "completed");
  assert.equal(deltas(frames(second.chunks)), "Second reply to What should we do next?");
});

test("a workspace read pause is confirmed and the strategy answer completes", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  client.hooks.onCreate = (session) => {
    session.status = "idle";
    session.events.push({
      id: "preamble",
      type: "agent.message",
      content: [{ type: "text", text: PREAMBLE }],
    });
    session.events.push({
      id: "read-1",
      type: "agent.tool_use",
      name: "read",
      input: { path: "/notes.md" },
      evaluated_permission: "ask",
    });
    session.events.push({
      id: "idle-ask",
      type: "session.status_idle",
      stop_reason: { type: "requires_action", event_ids: ["read-1"] },
    });
  };
  client.hooks.onSend = (session, events) => {
    if (!(events || []).some((event) => event.type === "user.tool_confirmation")) return;
    session.events.push({
      id: "strategy",
      type: "agent.message",
      content: [{ type: "text", text: STRATEGY }],
    });
    session.events.push({
      id: "idle-done",
      type: "session.status_idle",
      stop_reason: { type: "end_turn" },
    });
    session.status = "idle";
  };
  const http = mockResponse();
  await handleChiefChat(
    request(messageBody("q1", "Assess Freedom OS 3.0 and name three priorities.")),
    http.response,
    chatDeps(store, client)
  );
  const events = frames(http.chunks);
  assert.equal(http.chunks.join("").includes(GENERIC), false);
  assert.equal(events.at(-1).msg.status, "completed");
  assert.equal(deltas(events), `${PREAMBLE}${STRATEGY}`);
  assert.deepEqual(
    confirmations(client).map((event) => [event.tool_use_id, event.result]),
    [["read-1", "allow"]]
  );
  const toolBegin = events.find((event) => event.msg?.type === "tool_call_begin");
  assert.equal(toolBegin.msg.name, "read");
  const activity = chiefLiveActivity({ status: CHIEF_STATUS.TOOL, turnStatus: "running" });
  assert.equal(frontierStatusCopy(activity, CHIEF_STATUS.TOOL).title, "Reasoning");
  const sessionId = events.at(-1).msg.session_id;
  const history = projectInteractiveHistory(await store.load("user-1", sessionId));
  assert.equal(history.messages.at(-1).text, STRATEGY);
  assert.equal(history.turnError, null);
});

test("bash and already-allowed file tools are not auto-confirmed", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  client.hooks.onCreate = (session) => {
    session.status = "idle";
    session.events.push({
      id: "note",
      type: "agent.message",
      content: [{ type: "text", text: "I will not run that." }],
    });
    session.events.push({
      id: "bash-1",
      type: "agent.tool_use",
      name: "bash",
      evaluated_permission: "ask",
    });
    session.events.push({
      id: "read-allow",
      type: "agent.tool_use",
      name: "read",
      evaluated_permission: "allow",
    });
    session.events.push({
      id: "idle-deny",
      type: "session.status_idle",
      stop_reason: { type: "requires_action", event_ids: ["bash-1"] },
    });
  };
  const http = mockResponse();
  await handleChiefChat(request(messageBody("q1", "Run a command.")), http.response, chatDeps(store, client));
  assert.equal(confirmations(client).length, 0);
  assert.equal(http.chunks.join("").includes(GENERIC), false);
  assert.equal(frames(http.chunks).at(-1).msg.status, "continuing");
  assert.equal(deltas(frames(http.chunks)), "I will not run that.");
});

test("several memory reads then a final answer stay on one session", async () => {
  const store = new MemoryCheckpointStore();
  const calls = [];
  const client = scriptedManagedClient([
    { tool: { id: "mem-1", name: "memory_read", input: { query: "freedom os" } } },
    { tool: { id: "mem-2", name: "memory_read", input: { query: "voice" } } },
    { text: "Memory shows both priorities." },
  ]);
  const http = mockResponse();
  await handleChiefChat(request(messageBody("q1", "What do you remember?")), http.response, {
    ...chatDeps(store, client),
    toolExecutor: {
      async execute(call) {
        calls.push(call.name);
        return { output: `found ${call.name}`, isError: false };
      },
    },
    toolSpecs: [{ name: "memory_read", requiresConfirmation: false }],
  });
  const events = frames(http.chunks);
  assert.equal(http.chunks.join("").includes(GENERIC), false);
  assert.equal(events.at(-1).msg.status, "completed");
  assert.deepEqual(calls, ["memory_read", "memory_read"]);
  assert.equal(deltas(events), "Memory shows both priorities.");
});

test("a tool error still lets the model answer the user", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  client.hooks.onCreate = (session) => {
    session.status = "running";
    session.events.push({
      id: "tool-1",
      type: "agent.custom_tool_use",
      name: "memory_read",
      input: { query: "missing" },
    });
  };
  client.hooks.onSend = (session, events) => {
    const result = (events || []).find((event) => event.type === "user.custom_tool_result");
    if (!result) return;
    assert.equal(result.is_error, true);
    session.events.push({
      id: "after-tool",
      type: "agent.message",
      content: [{ type: "text", text: "I could not read that memory, so I am answering directly." }],
    });
    session.events.push({
      id: "idle-after",
      type: "session.status_idle",
      stop_reason: { type: "end_turn" },
    });
    session.status = "idle";
  };
  const http = mockResponse();
  await handleChiefChat(request(messageBody("q1", "Recall the last plan.")), http.response, {
    ...chatDeps(store, client),
    toolExecutor: {
      async execute() {
        return { output: "memory store unavailable", isError: true };
      },
    },
    toolSpecs: [{ name: "memory_read", requiresConfirmation: false }],
  });
  assert.equal(http.chunks.join("").includes(GENERIC), false);
  assert.equal(frames(http.chunks).at(-1).msg.status, "completed");
  assert.match(deltas(frames(http.chunks)), /answering directly/);
});

test("an empty tool result is retried once and the turn still completes", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  let toolSends = 0;
  client.hooks.onCreate = (session) => {
    session.status = "running";
    session.events.push({
      id: "tool-empty",
      type: "agent.custom_tool_use",
      name: "memory_read",
      input: {},
    });
  };
  client.sendEvents = async (id, events) => {
    client.sent.push({ sessionId: id, events });
    const result = (events || []).find((event) => event.type === "user.custom_tool_result");
    if (!result) return;
    toolSends += 1;
    if (toolSends === 1) {
      const error = new Error("text must not be empty");
      error.status = 400;
      throw error;
    }
    assert.equal(result.content[0].text, "Tool result could not be delivered.");
    assert.equal(result.is_error, true);
    client.session.events.push({
      id: "after-empty",
      type: "agent.message",
      content: [{ type: "text", text: "Nothing was stored there." }],
    });
    client.session.events.push({
      id: "idle-empty-tool",
      type: "session.status_idle",
      stop_reason: { type: "end_turn" },
    });
    client.session.status = "idle";
  };
  const http = mockResponse();
  await handleChiefChat(request(messageBody("q1", "Read memory.")), http.response, {
    ...chatDeps(store, client),
    toolExecutor: {
      async execute() {
        return { output: "", isError: false };
      },
    },
    toolSpecs: [{ name: "memory_read", requiresConfirmation: false }],
  });
  assert.equal(toolSends, 2);
  assert.equal(http.chunks.join("").includes(GENERIC), false);
  assert.equal(frames(http.chunks).at(-1).msg.status, "completed");
  assert.equal(deltas(frames(http.chunks)), "Nothing was stored there.");
});

test("a checkpoint write failure does not erase a completed answer", async () => {
  const store = new MemoryCheckpointStore();
  store.saveWithEvents = async () => {
    const error = new Error("transaction");
    error.code = "P2028";
    throw error;
  };
  const client = scriptedManagedClient([{ text: `Quiet day.\u0000` }]);
  const http = mockResponse();
  await handleChiefChat(request(messageBody("q1", "Hello")), http.response, chatDeps(store, client));
  const events = frames(http.chunks);
  assert.equal(http.chunks.join("").includes(GENERIC), false);
  assert.equal(events.at(-1).msg.status, "completed");
  assert.match(deltas(events), /Quiet day/);
});

test("a failed provider stop settles the watch so the next message can send", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  client.hooks.onCreate = (session) => {
    session.status = "idle";
    session.events.push({
      id: "idle-fail",
      type: "session.status_idle",
      stop_reason: { type: "retries_exhausted" },
    });
  };
  const failed = mockResponse();
  await handleChiefChat(request(messageBody("q1", "First")), failed.response, chatDeps(store, client));
  const first = frames(failed.chunks);
  assert.equal(failed.chunks.join("").includes(GENERIC), false);
  assert.equal(first.at(-1).msg.status, "failed");
  assert.match(first.map((event) => event.msg?.message).join(" "), /could not finish/);
  const sessionId = first.at(-1).msg.session_id;
  const waiting = await store.load("user-1", sessionId);
  assert.equal(waiting.checkpoint.context.turnWatch.settled, true);

  client.hooks.onSend = (session, events) => {
    const text = (events || []).find((event) => event.type === "user.message")?.content?.[0]?.text;
    assert.equal(text.includes("First"), false);
    session.events.push({
      id: "recovered",
      type: "agent.message",
      content: [{ type: "text", text: "Recovered on the next question." }],
    });
    session.events.push({
      id: "idle-recovered",
      type: "session.status_idle",
      stop_reason: { type: "end_turn" },
    });
    session.status = "idle";
  };
  const next = mockResponse();
  await handleChiefChat(
    request(messageBody("q2", "Try again", sessionId)),
    next.response,
    chatDeps(store, client)
  );
  assert.equal(next.chunks.join("").includes(GENERIC), false);
  assert.equal(frames(next.chunks).at(-1).msg.status, "completed");
  assert.equal(deltas(frames(next.chunks)), "Recovered on the next question.");
});

test("retryable stream errors keep the answer speakable once the turn completes", () => {
  const greeting = GREETING;
  let state = applyChiefEvent(initialTurnState(null), {
    msg: { type: "turn_started", turn_id: "turn-1" },
  });
  state = applyChiefEvent(state, {
    msg: {
      type: "assistant_content_delta",
      turn_id: "turn-1",
      phase: "final_answer",
      delta: greeting,
    },
  });
  state = applyChiefEvent(state, {
    msg: { type: "error", message: GENERIC, retryable: true },
  });
  assert.equal(state.error, "");
  assert.equal(state.finished, false);
  assert.equal(state.turnStatus, "continuing");
  assert.equal(state.streamText, greeting);
  assert.equal(isSpeakableTurn(state.turnStatus), false);

  state = applyChiefEvent(state, {
    msg: { type: "session_configured", session_id: "sess-1", status: "completed" },
  });
  assert.equal(state.error, "");
  assert.equal(state.finished, true);
  assert.equal(state.turnStatus, "completed");
  assert.equal(state.streamText, greeting);
  assert.equal(isSpeakableTurn(state.turnStatus), true);

  const rejected = applyChiefEvent(state, {
    msg: { type: "error", message: "CHIEF could not finish that response.", retryable: false },
  });
  assert.equal(rejected.streamText, greeting);
  assert.equal(rejected.finished, true);
  assert.equal(rejected.turnStatus, "rejected");
  assert.equal(isSpeakableTurn(rejected.turnStatus), false);

  for (const mode of ["text", "voice", "both"]) {
    const preferences = normalizeChiefPreferences({ conversation: { responseMode: mode } });
    const spoken = replySpeechText({
      streamText: state.streamText,
      finished: true,
      status: CHIEF_STATUS.READY,
      turnStatus: "completed",
      preferences,
    });
    const plan = classifySettledDelivery({
      answer: greeting,
      speak: mode !== "text",
      settled: true,
      playback: mode === "text" ? null : { ok: false, error: "ElevenLabs unavailable" },
    });
    assert.equal(spoken, mode === "text" ? "" : greeting, mode);
    if (mode === "text") assert.equal(plan.action, "show");
    else assert.equal(plan.action, "tts_failed");
    assert.equal(plan.text, greeting, mode);
  }

  const listening = frontierStatusCopy(
    chiefLiveActivity({ listening: true, status: CHIEF_STATUS.WORKING }),
    ""
  );
  const responding = frontierStatusCopy(
    chiefLiveActivity({ status: CHIEF_STATUS.RESPONDING, playback: "playing" }),
    ""
  );
  assert.equal(listening.title, "Listening");
  assert.equal(responding.title, "Responding");
});

test("pcm playback uses the device sample rate", async () => {
  const rates = [];
  const audioContext = {
    state: "running",
    currentTime: 0,
    sampleRate: 48000,
    destination: {},
    resume() {
      return Promise.resolve();
    },
    createBuffer(_channels, length, rate) {
      rates.push(rate);
      if (rate !== 48000) throw new Error("NotSupportedError");
      return { duration: length / rate, copyToChannel() {} };
    },
    createBufferSource() {
      return { connect() {}, start() {}, stop() {} };
    },
  };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]));
      controller.close();
    },
  });
  await playPcmStream(body, { audioContext, sampleRate: 24000 });
  assert.ok(rates.length >= 1);
  assert.equal(rates.every((rate) => rate === 48000), true);
});
