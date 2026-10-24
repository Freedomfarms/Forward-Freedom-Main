// CHIEF turn correlation. Managed Agents is mocked. No provider calls.

import test from "node:test";
import assert from "node:assert/strict";

import { handleChiefChat } from "../api/chief/chat.js";
import { runManagedChiefTurn } from "../server/chief/managed/chatTurn.js";
import { providerErrorFields } from "../server/chief/managed/redact.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { projectInteractiveHistory } from "../server/chief/runtime/history.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";
import { scriptedManagedClient } from "./chief-managed-client-fixture.js";
import {
  acceptChiefSubmission,
  applyChiefEvent,
  initialTurnState,
  restoredChiefTurn,
} from "../src/utils/chiefProtocol.js";
import { currentTurn } from "../src/utils/chiefRoom.js";
import {
  normalizeChiefPreferences,
  shouldShowAssistantText,
} from "../src/utils/chiefPreferences.js";
import { replySpeechText } from "../src/utils/chiefReplySpeech.js";

function mockResponse() {
  const chunks = [];
  const listeners = {};
  const state = { statusCode: null, ended: false };
  const response = {
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
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
      response.writableEnded = true;
      response.writableFinished = true;
    },
    on(event, cb) {
      (listeners[event] ||= []).push(cb);
    },
    emitClose() {
      for (const cb of listeners.close || []) cb();
    },
  };
  return { response, chunks, state };
}

function request(body, { closeDuringTurn = false } = {}) {
  return {
    method: "POST",
    headers: {},
    body,
    socket: { remoteAddress: "127.0.0.1" },
    on(event, cb) {
      if (event === "close" && closeDuringTurn) queueMicrotask(() => cb());
    },
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

function deltas(events, turnId = null) {
  return events
    .filter((event) => {
      if (event.msg?.type !== "assistant_content_delta") return false;
      if (event.msg.phase === "reasoning") return false;
      if (turnId && event.msg.turn_id !== turnId) return false;
      return true;
    })
    .map((event) => event.msg.delta)
    .join("");
}

function visible(transcript) {
  return (transcript || [])
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => [message.role, message.content]);
}

const auth = async (req) => ({ uid: req.uid });

function messageBody(id, text, sessionId = null) {
  const body = {
    submission: { id, op: { type: "message", message: { text } } },
  };
  if (sessionId) body.session_id = sessionId;
  return body;
}

function deps(store, client, extra = {}) {
  return {
    store,
    client,
    authenticate: auth,
    toolExecutor: new ToolExecutor(),
    sleepFn: async () => {},
    ...extra,
  };
}

function resourceClient() {
  const session = { id: "prov_1", status: "idle", events: [] };
  const sent = [];
  const hooks = { onCreate: null, onSend: null, onList: null };
  const client = {
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
  return client;
}

test("five consecutive questions each receive their own answer", async () => {
  const store = new MemoryCheckpointStore();
  const answers = ["Answer one.", "Answer two.", "Answer three.", "Answer four.", "Answer five."];
  const client = scriptedManagedClient(answers.map((text) => ({ text })));
  let sessionId = null;
  const turnIds = [];
  for (let index = 0; index < answers.length; index += 1) {
    const http = mockResponse();
    await handleChiefChat(
      request(messageBody(`q-${index + 1}`, `Question ${index + 1}`, sessionId)),
      http.response,
      deps(store, client)
    );
    const events = frames(http.chunks);
    assert.equal(events[0].msg.type, "turn_started");
    assert.equal(events.at(-1).msg.status, "completed");
    assert.equal(deltas(events), answers[index]);
    const ids = [
      ...new Set(
        events
          .filter((event) => event.msg?.type === "assistant_content_delta")
          .map((event) => event.msg.turn_id)
      ),
    ];
    assert.equal(ids.length, 1);
    turnIds.push(ids[0]);
    sessionId = events.at(-1).msg.session_id;
  }
  assert.equal(new Set(turnIds).size, answers.length);
  const record = await store.load("user-1", sessionId);
  assert.deepEqual(
    visible(record.checkpoint.transcript),
    answers.flatMap((answer, index) => [
      ["user", `Question ${index + 1}`],
      ["assistant", answer],
    ])
  );
});

test("a historical idle event cannot complete a new turn", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  client.hooks.onCreate = (session) => {
    session.events.push({
      id: "a1",
      type: "agent.message",
      content: [{ type: "text", text: "First answer." }],
    });
    session.events.push({ id: "idle-old", type: "session.status_idle" });
    session.status = "idle";
  };
  const first = mockResponse();
  await handleChiefChat(
    request(messageBody("q1", "Question 1")),
    first.response,
    deps(store, client)
  );
  assert.equal(frames(first.chunks).at(-1).msg.status, "completed");
  client.hooks.onSend = (session) => {
    session.status = "running";
  };
  const second = mockResponse();
  await handleChiefChat(
    request(messageBody("q2", "Question 2", frames(first.chunks).at(-1).msg.session_id)),
    second.response,
    deps(store, client, { budgetMs: 0 })
  );
  const events = frames(second.chunks);
  assert.equal(events.at(-1).msg.status, "continuing");
  assert.equal(deltas(events), "");
  assert.equal(
    client.sent.some((item) =>
      (item.events || []).some(
        (event) => event.type === "user.message" && event.content?.[0]?.text === "Question 2"
      )
    ),
    true
  );
});

test("a delayed answer is not displayed as the next question's answer", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  client.hooks.onCreate = (session) => {
    session.status = "running";
  };
  const first = mockResponse();
  await handleChiefChat(
    request(messageBody("q1", "Question 1")),
    first.response,
    deps(store, client, { budgetMs: 0 })
  );
  const sessionId = frames(first.chunks).at(-1).msg.session_id;
  assert.equal(frames(first.chunks).at(-1).msg.status, "continuing");
  const second = mockResponse();
  await handleChiefChat(
    request(messageBody("q2", "Question 2", sessionId)),
    second.response,
    deps(store, client, { budgetMs: 0 })
  );
  const held = frames(second.chunks);
  assert.equal(held.at(-1).msg.status, "continuing");
  assert.equal(deltas(held), "");
  assert.equal(
    held.some((event) => event.msg?.type === "message" && event.msg.delivery === "queue"),
    true
  );
  assert.equal(
    client.sent.some((item) =>
      (item.events || []).some((event) => event.content?.[0]?.text === "Question 2")
    ),
    false
  );
  client.session.events.push({
    id: "a1",
    type: "agent.message",
    content: [{ type: "text", text: "Answer 1." }],
  });
  client.session.events.push({ id: "idle-1", type: "session.status_idle" });
  client.session.status = "idle";
  const resumed = mockResponse();
  await handleChiefChat(
    request({
      session_id: sessionId,
      submission: { id: "resume-1", op: { type: "resume_session", session_id: sessionId } },
    }),
    resumed.response,
    deps(store, client, { budgetMs: 0 })
  );
  const resumedEvents = frames(resumed.chunks);
  assert.equal(deltas(resumedEvents), "Answer 1.");
  assert.equal(
    resumedEvents.some(
      (event) => event.msg?.delivery === "turn" && event.msg?.text === "Question 2"
    ),
    false
  );
  const record = await store.load("user-1", sessionId);
  assert.deepEqual(visible(record.checkpoint.transcript), [
    ["user", "Question 1"],
    ["assistant", "Answer 1."],
  ]);
  assert.equal(record.checkpoint.context.heldPrompts.includes("Question 2"), true);

  client.hooks.onSend = (session, events) => {
    const text = events.find((event) => event.type === "user.message")?.content?.[0]?.text;
    session.events.push({
      id: `a-${text}`,
      type: "agent.message",
      content: [{ type: "text", text: `Answer for ${text}` }],
    });
    session.events.push({ id: `idle-${text}`, type: "session.status_idle" });
    session.status = "idle";
  };
  const third = mockResponse();
  await handleChiefChat(
    request({
      session_id: sessionId,
      submission: { id: "resume-2", op: { type: "resume_session", session_id: sessionId } },
    }),
    third.response,
    deps(store, client)
  );
  const thirdEvents = frames(third.chunks);
  assert.equal(thirdEvents.at(-1).msg.status, "completed");
  assert.equal(deltas(thirdEvents), "Answer for Question 2");
  const done = await store.load("user-1", sessionId);
  assert.deepEqual(visible(done.checkpoint.transcript), [
    ["user", "Question 1"],
    ["assistant", "Answer 1."],
    ["user", "Question 2"],
    ["assistant", "Answer for Question 2"],
  ]);
});

test("an answer that arrives after the request window resumes once", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  client.hooks.onCreate = (session) => {
    session.status = "running";
  };
  const opened = mockResponse();
  await handleChiefChat(
    request(messageBody("q1", "Question 1")),
    opened.response,
    deps(store, client, { budgetMs: 0 })
  );
  const sessionId = frames(opened.chunks).at(-1).msg.session_id;
  client.session.events.push({
    id: "part-1",
    type: "agent.message",
    content: [{ type: "text", text: "Hello" }],
  });
  const middle = mockResponse();
  await handleChiefChat(
    request({
      session_id: sessionId,
      submission: { id: "resume-1", op: { type: "resume_session", session_id: sessionId } },
    }),
    middle.response,
    deps(store, client, { budgetMs: 0 })
  );
  assert.equal(frames(middle.chunks).at(-1).msg.status, "continuing");
  assert.equal(deltas(frames(middle.chunks)), "Hello");
  client.session.events.push({
    id: "part-2",
    type: "agent.message",
    content: [{ type: "text", text: " world" }],
  });
  client.session.events.push({ id: "idle-late", type: "session.status_idle" });
  client.session.status = "idle";
  const finished = mockResponse();
  await handleChiefChat(
    request({
      session_id: sessionId,
      submission: { id: "resume-2", op: { type: "resume_session", session_id: sessionId } },
    }),
    finished.response,
    deps(store, client)
  );
  const events = frames(finished.chunks);
  assert.equal(events.at(-1).msg.status, "completed");
  assert.equal(deltas(events), " world");
  const record = await store.load("user-1", sessionId);
  const answers = record.checkpoint.transcript
    .filter((message) => message.role === "assistant")
    .map((message) => message.content);
  assert.deepEqual(answers, ["Hello", " world"]);
  assert.equal(answers.filter((text) => text === "Hello").length, 1);
});

test("leaving and returning follows the unfinished question", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  client.hooks.onCreate = (session) => {
    session.status = "running";
  };
  const opened = mockResponse();
  await handleChiefChat(
    request(messageBody("q1", "Question 1")),
    opened.response,
    deps(store, client, { budgetMs: 0 })
  );
  const sessionId = frames(opened.chunks).at(-1).msg.session_id;
  const before = projectInteractiveHistory(await store.load("user-1", sessionId));
  const restored = restoredChiefTurn({
    messages: before.messages,
    turnStatus: before.turnStatus,
    heldPrompt: before.heldPrompt,
  });
  assert.equal(restored.error, "");
  assert.equal(restored.follow, true);
  assert.equal(restored.turnStatus, "continuing");
  assert.equal(restored.messages.at(-1).text, "Question 1");
  client.session.events.push({
    id: "a1",
    type: "agent.message",
    content: [{ type: "text", text: "Answer 1." }],
  });
  client.session.events.push({ id: "idle-1", type: "session.status_idle" });
  client.session.status = "idle";
  const returned = mockResponse();
  await handleChiefChat(
    request({
      session_id: sessionId,
      submission: { id: "resume-back", op: { type: "resume_session", session_id: sessionId } },
    }),
    returned.response,
    deps(store, client)
  );
  assert.equal(deltas(frames(returned.chunks)), "Answer 1.");
  const after = projectInteractiveHistory(await store.load("user-1", sessionId));
  assert.deepEqual(
    after.messages.map((message) => [message.role, message.text]),
    [
      ["user", "Question 1"],
      ["assistant", "Answer 1."],
    ]
  );
});

test("a temporary provider error keeps the message and retries", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  let lists = 0;
  client.hooks.onCreate = (session) => {
    session.events.push({
      id: "a1",
      type: "agent.message",
      content: [{ type: "text", text: "Recovered answer." }],
    });
    session.events.push({ id: "idle-1", type: "session.status_idle" });
    session.status = "idle";
  };
  client.hooks.onList = () => {
    lists += 1;
    if (lists === 1) {
      const error = new Error("provider unavailable sk-ant-api03-secret");
      error.status = 503;
      error.operation = "listEvents";
      throw error;
    }
  };
  const failed = mockResponse();
  await handleChiefChat(
    request(messageBody("q1", "Question 1 private 88421")),
    failed.response,
    deps(store, client)
  );
  const failedBody = failed.chunks.join("");
  assert.equal(failedBody.includes("The turn could not be completed."), false);
  assert.equal(failedBody.includes("88421"), false);
  assert.equal(failedBody.includes("sk-ant-api03"), false);
  assert.equal(frames(failed.chunks).at(-1).msg.status, "continuing");
  const sessionId = frames(failed.chunks).at(-1).msg.session_id;
  const waiting = await store.load("user-1", sessionId);
  assert.equal(
    waiting.checkpoint.transcript.filter((message) => message.role === "user").length,
    1
  );
  const recovered = mockResponse();
  await handleChiefChat(
    request({
      session_id: sessionId,
      submission: { id: "resume-1", op: { type: "resume_session", session_id: sessionId } },
    }),
    recovered.response,
    deps(store, client)
  );
  assert.equal(deltas(frames(recovered.chunks)), "Recovered answer.");
  const done = await store.load("user-1", sessionId);
  assert.deepEqual(visible(done.checkpoint.transcript), [
    ["user", "Question 1 private 88421"],
    ["assistant", "Recovered answer."],
  ]);
});

test("provider failures log ids and status without private content", async () => {
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
          "createAgent rejected sk-ant-api03-secretvalue for farmer@example.com"
        );
        error.status = 502;
        error.operation = "listAgents";
        throw error;
      },
    };
    await handleChiefChat(
      request(messageBody("sub-9", "private account 88421")),
      http.response,
      deps(new MemoryCheckpointStore(), client)
    );
  } finally {
    console.error = original;
  }
  const log = lines.join("\n");
  const body = http.chunks.join("");
  assert.match(body, /The turn could not be completed/);
  assert.match(log, /\[chief\/chat\] listAgents 502 ensure_resources sub-9/);
  assert.equal(log.includes("sk-ant-api03"), false);
  assert.equal(log.includes("farmer@example.com"), false);
  assert.equal(log.includes("88421"), false);
  assert.equal(body.includes("88421"), false);
  const fields = providerErrorFields({
    operation: "listEvents",
    status: 503,
    stage: "collect",
    submissionId: "sub-9",
    turnId: "turn-1",
    sessionId: "session-1",
    providerStatus: "running",
    message: "bad sk-ant-api03-secretvalue",
  });
  assert.equal(fields.stage, "collect");
  assert.equal(fields.submissionId, "sub-9");
  assert.equal(fields.turnId, "turn-1");
  assert.equal(fields.sessionId, "session-1");
  assert.equal(fields.providerStatus, "running");
  assert.equal(fields.message.includes("sk-ant-api03"), false);
});

test("a finished request close does not abort the turn", async () => {
  const store = new MemoryCheckpointStore();
  const client = scriptedManagedClient([{ text: "Still here." }]);
  const http = mockResponse();
  await handleChiefChat(
    request(messageBody("q1", "Question 1"), { closeDuringTurn: true }),
    http.response,
    deps(store, client)
  );
  const events = frames(http.chunks);
  assert.equal(events.at(-1).msg.status, "completed");
  assert.equal(deltas(events), "Still here.");
});

test("a client disconnect aborts collection and keeps the question", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  client.hooks.onCreate = (session) => {
    session.status = "running";
  };
  const http = mockResponse();
  await handleChiefChat(request(messageBody("q1", "Question 1")), http.response, {
    ...deps(store, client, { budgetMs: 5_000 }),
    sleepFn: async () => {
      http.response.writableEnded = false;
      http.response.writableFinished = false;
      http.response.emitClose();
    },
  });
  assert.equal(frames(http.chunks).at(-1).msg.status, "continuing");
  const sessionId = frames(http.chunks).at(-1).msg.session_id;
  const record = await store.load("user-1", sessionId);
  assert.equal(record.checkpoint.transcript[0].content, "Question 1");
  assert.equal(record.checkpoint.context.turnStatus, "continuing");
});

test("later deltas cannot fill an earlier question's stream", () => {
  let state = applyChiefEvent(initialTurnState(null), {
    msg: { type: "message", delivery: "queue", text: "Question 2" },
  });
  state = applyChiefEvent(state, { msg: { type: "turn_started", turn_id: "turn-1" } });
  state = applyChiefEvent(state, {
    msg: {
      type: "assistant_content_delta",
      turn_id: "turn-1",
      phase: "final_answer",
      delta: "Answer 1",
    },
  });
  assert.equal(state.streamText, "");
  assert.equal(state.held, true);
  state = applyChiefEvent(state, {
    msg: { type: "message", delivery: "turn", turn_id: "turn-2", text: "Question 2" },
  });
  state = applyChiefEvent(state, {
    msg: {
      type: "assistant_content_delta",
      turn_id: "turn-1",
      phase: "final_answer",
      delta: "Answer 1",
    },
  });
  assert.equal(state.streamText, "");
  state = applyChiefEvent(state, {
    msg: {
      type: "assistant_content_delta",
      turn_id: "turn-2",
      phase: "final_answer",
      delta: "Answer 2",
    },
  });
  assert.equal(state.streamText, "Answer 2");
  assert.equal(state.acceptedUserText, "Question 2");
});

test("an in-flight turn preserves the next question instead of sending it", () => {
  assert.deepEqual(acceptChiefSubmission({ busy: true, text: " Question 2 " }), {
    action: "preserve",
    draft: "Question 2",
  });
  assert.deepEqual(acceptChiefSubmission({ turnStatus: "continuing", text: "Question 3" }), {
    action: "preserve",
    draft: "Question 3",
  });
  assert.deepEqual(acceptChiefSubmission({ turnStatus: "completed", text: "Question 4" }), {
    action: "send",
    draft: "",
  });
});

test("voice, text, and both modes use the same matched answer", () => {
  const messages = [
    { role: "user", text: "Question 1" },
    { role: "assistant", text: "Answer 1" },
    { role: "user", text: "Question 2" },
    { role: "assistant", text: "Answer 2" },
  ];
  const matched = currentTurn(messages, "").answer;
  assert.equal(matched, "Answer 2");
  for (const mode of ["text", "voice", "both"]) {
    const preferences = normalizeChiefPreferences({ conversation: { responseMode: mode } });
    const spoken = replySpeechText({
      historyAnswer: matched,
      streamText: "",
      finished: true,
      status: "Ready",
      turnStatus: "completed",
      preferences,
    });
    const shown = shouldShowAssistantText({ preferences });
    assert.equal(matched, "Answer 2");
    if (mode === "text") assert.equal(spoken, "");
    else assert.equal(spoken, "Answer 2");
    if (mode === "voice") assert.equal(shown, false);
    else assert.equal(shown, true);
  }
});

test("a stale idle status waits for this turn's provider activity", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  client.hooks.onCreate = (session) => {
    session.events.push({
      id: "a1",
      type: "agent.message",
      content: [{ type: "text", text: "Answer 1." }],
    });
    session.events.push({ id: "idle-old", type: "session.status_idle" });
    session.status = "idle";
  };
  const first = mockResponse();
  await handleChiefChat(
    request(messageBody("q1", "Question 1")),
    first.response,
    deps(store, client)
  );
  const sessionId = frames(first.chunks).at(-1).msg.session_id;
  let sent = false;
  let pollsAfterSend = 0;
  client.hooks.onSend = () => {
    sent = true;
  };
  client.hooks.onList = (session) => {
    if (!sent) return;
    pollsAfterSend += 1;
    if (pollsAfterSend < 3) return;
    if (session.events.some((event) => event.id === "a2")) return;
    session.events.push({
      id: "a2",
      type: "agent.message",
      content: [{ type: "text", text: "Answer 2." }],
    });
    session.events.push({ id: "idle-new", type: "session.status_idle" });
    session.status = "idle";
  };
  const second = mockResponse();
  await handleChiefChat(
    request(messageBody("q2", "Question 2", sessionId)),
    second.response,
    deps(store, client, { budgetMs: 5_000 })
  );
  const events = frames(second.chunks);
  assert.equal(events.at(-1).msg.status, "completed");
  assert.equal(deltas(events), "Answer 2.");
  assert.ok(pollsAfterSend >= 3);
  const record = await store.load("user-1", sessionId);
  assert.deepEqual(visible(record.checkpoint.transcript), [
    ["user", "Question 1"],
    ["assistant", "Answer 1."],
    ["user", "Question 2"],
    ["assistant", "Answer 2."],
  ]);
});

test("runManagedChiefTurn keeps a disconnected resume continuable", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  client.hooks.onCreate = (session) => {
    session.status = "running";
  };
  const opened = await runManagedChiefTurn({
    userId: "user-1",
    submission: { id: "q1", op: { type: "message", message: { text: "Question 1" } } },
    store,
    client,
    toolExecutor: new ToolExecutor(),
    budgetMs: 0,
    sleepFn: async () => {},
  });
  const controller = new AbortController();
  controller.abort();
  const resumed = await runManagedChiefTurn({
    userId: "user-1",
    sessionId: opened.sessionId,
    submission: { id: "resume", op: { type: "resume_session", session_id: opened.sessionId } },
    store,
    client,
    signal: controller.signal,
    toolExecutor: new ToolExecutor(),
    sleepFn: async () => {},
  });
  assert.equal(resumed.status, "continuing");
  assert.equal(
    resumed.checkpoint.transcript.filter((message) => message.role === "user").length,
    1
  );
});
