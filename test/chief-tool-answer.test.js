// A custom tool pauses the Managed Agents session. That pause is not the
// answer. The same session then has to deliver the model's text, and the next
// question has to stay on that session. No provider calls.

import test from "node:test";
import assert from "node:assert/strict";

import { handleChiefChat } from "../api/chief/chat.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { projectInteractiveHistory } from "../server/chief/runtime/history.js";
import { normalizeChiefPreferences } from "../src/utils/chiefPreferences.js";
import {
  applyChiefEvent,
  CHIEF_STATUS,
  initialTurnState,
  isSpeakableTurn,
  MISSING_CHIEF_ANSWER,
  restoredChiefTurn,
} from "../src/utils/chiefProtocol.js";
import { currentTurn } from "../src/utils/chiefRoom.js";
import { classifySettledDelivery, replySpeechText } from "../src/utils/chiefReplySpeech.js";

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
  const body = {
    submission: { id, op: { type: "message", message: { text } } },
  };
  if (sessionId) body.session_id = sessionId;
  return body;
}

function resourceClient() {
  const session = { id: "prov_code", status: "idle", events: [] };
  const sent = [];
  const hooks = { onCreate: null, onSend: null };
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
      return session.events;
    },
    async sendEvents(id, events) {
      sent.push({ sessionId: id, events });
      hooks.onSend?.(session, events);
    },
  };
}

const auth = async (req) => ({ uid: req.uid });
const CODE_ANSWER = "Yes. The site shell is in src/App.jsx.";
const FOLLOW_ANSWER = "That meant the site shell is in src/App.jsx.";

test("a code tool pause is not the answer, and the follow-up stays on that session", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  const calls = [];
  client.hooks.onCreate = (session) => {
    session.status = "running";
    session.events.push({
      id: "tool-code",
      type: "agent.custom_tool_use",
      name: "code_read",
      input: { path: "src/App.jsx" },
    });
    session.events.push({
      id: "idle-tool",
      type: "session.status_idle",
      stop_reason: { type: "requires_action", event_ids: ["tool-code"] },
    });
  };
  client.hooks.onSend = (session, events) => {
    if ((events || []).some((event) => event.type === "user.custom_tool_result")) {
      session.status = "idle";
    }
  };
  const first = mockResponse();
  await handleChiefChat(
    request(messageBody("q1", "Can you see the coding of this site?")),
    first.response,
    {
      store,
      client,
      authenticate: auth,
      toolExecutor: {
        async execute(call) {
          calls.push(call);
          return { output: "src/App.jsx exports the site shell.", isError: false };
        },
      },
      toolSpecs: [{ name: "code_read", requiresConfirmation: false }],
      budgetMs: 1000,
      sleepFn: async () => {},
    }
  );
  const opening = frames(first.chunks);
  assert.equal(opening.at(-1).msg.status, "continuing");
  assert.equal(deltas(opening), "");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "code_read");
  assert.equal(calls[0].arguments.path, "src/App.jsx");
  assert.equal(
    client.sent.some((item) =>
      (item.events || []).some(
        (event) =>
          event.type === "user.custom_tool_result" && event.custom_tool_use_id === "tool-code"
      )
    ),
    true
  );
  const sessionId = opening.at(-1).msg.session_id;
  const paused = projectInteractiveHistory(await store.load("user-1", sessionId));
  assert.deepEqual(
    paused.messages.map((message) => message.role),
    ["user"]
  );
  assert.equal(paused.messages[0].text, "Can you see the coding of this site?");
  assert.notEqual(paused.turnStatus, "completed");

  client.session.events.push({
    id: "answer-1",
    type: "agent.message",
    content: [{ type: "text", text: CODE_ANSWER }],
  });
  client.session.events.push({
    id: "idle-done",
    type: "session.status_idle",
    stop_reason: { type: "end_turn" },
  });
  client.session.status = "idle";
  const resumed = mockResponse();
  await handleChiefChat(
    request({
      session_id: sessionId,
      submission: { id: "resume-1", op: { type: "resume_session", session_id: sessionId } },
    }),
    resumed.response,
    {
      store,
      client,
      authenticate: auth,
      toolExecutor: {
        async execute(call) {
          calls.push(call);
          return { output: "again", isError: false };
        },
      },
      toolSpecs: [{ name: "code_read", requiresConfirmation: false }],
      sleepFn: async () => {},
    }
  );
  const answered = frames(resumed.chunks);
  assert.equal(answered.at(-1).msg.status, "completed");
  assert.equal(deltas(answered), CODE_ANSWER);
  assert.equal(calls.length, 1);
  const afterAnswer = projectInteractiveHistory(await store.load("user-1", sessionId));
  assert.deepEqual(
    afterAnswer.messages.map((message) => [message.role, message.text]),
    [
      ["user", "Can you see the coding of this site?"],
      ["assistant", CODE_ANSWER],
    ]
  );

  client.hooks.onSend = (session, events) => {
    const text = (events || []).find((event) => event.type === "user.message")?.content?.[0]?.text;
    session.events.push({
      id: "answer-2",
      type: "agent.message",
      content: [{ type: "text", text: `${FOLLOW_ANSWER} You asked: ${text}` }],
    });
    session.events.push({
      id: "idle-2",
      type: "session.status_idle",
      stop_reason: { type: "end_turn" },
    });
    session.status = "idle";
  };
  const follow = mockResponse();
  await handleChiefChat(
    request(messageBody("q2", "What did that mean?", sessionId)),
    follow.response,
    {
      store,
      client,
      authenticate: auth,
      toolExecutor: {
        async execute() {
          throw new Error("the follow-up must not invent a tool call");
        },
      },
      toolSpecs: [{ name: "code_read", requiresConfirmation: false }],
      sleepFn: async () => {},
    }
  );
  const followed = frames(follow.chunks);
  assert.equal(followed.at(-1).msg.status, "completed");
  assert.equal(deltas(followed), `${FOLLOW_ANSWER} You asked: What did that mean?`);
  assert.equal(client.session.id, "prov_code");
  assert.equal(client.sent.filter((item) => item.agent).length, 1);
  const done = projectInteractiveHistory(await store.load("user-1", sessionId));
  assert.deepEqual(
    done.messages.map((message) => [message.role, message.text]),
    [
      ["user", "Can you see the coding of this site?"],
      ["assistant", CODE_ANSWER],
      ["user", "What did that mean?"],
      ["assistant", `${FOLLOW_ANSWER} You asked: What did that mean?`],
    ]
  );
  assert.equal(done.messages.filter((message) => message.role === "assistant").length, 2);

  for (const mode of ["text", "voice", "both"]) {
    const preferences = normalizeChiefPreferences({ conversation: { responseMode: mode } });
    const spoken = replySpeechText({
      historyAnswer: CODE_ANSWER,
      streamText: "",
      finished: true,
      status: CHIEF_STATUS.READY,
      turnStatus: "completed",
      preferences,
    });
    const plan = classifySettledDelivery({
      answer: CODE_ANSWER,
      speak: mode !== "text",
      settled: true,
    });
    assert.equal(spoken, mode === "text" ? "" : CODE_ANSWER, mode);
    assert.equal(plan.action, mode === "text" ? "show" : "speak", mode);
    assert.equal(plan.text, CODE_ANSWER, mode);
  }
});

test("an end_turn with no assistant text is a failed turn, not a spoken success", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  client.hooks.onCreate = (session) => {
    session.events.push({
      id: "idle-empty",
      type: "session.status_idle",
      stop_reason: { type: "end_turn" },
    });
    session.status = "idle";
  };
  const http = mockResponse();
  await handleChiefChat(
    request(messageBody("q1", "Can you see the coding of this site?")),
    http.response,
    {
      store,
      client,
      authenticate: auth,
      toolExecutor: { async execute() {} },
      budgetMs: 1000,
      sleepFn: async () => {},
    }
  );
  const events = frames(http.chunks);
  assert.equal(events.at(-1).msg.status, "empty");
  assert.equal(
    events.some(
      (event) => event.msg?.type === "error" && event.msg.message === MISSING_CHIEF_ANSWER
    ),
    true
  );
  assert.equal(deltas(events), "");
  const sessionId = events.at(-1).msg.session_id;
  const history = projectInteractiveHistory(await store.load("user-1", sessionId));
  assert.equal(history.turnStatus, "empty");
  assert.equal(history.turnError, MISSING_CHIEF_ANSWER);
  assert.equal(
    history.messages.some((message) => message.role === "assistant"),
    false
  );
  const restored = applyChiefEvent(
    applyChiefEvent(initialTurnState(sessionId), {
      msg: { type: "error", message: MISSING_CHIEF_ANSWER },
    }),
    { msg: { type: "session_configured", session_id: sessionId, status: "empty" } }
  );
  assert.equal(restored.status, CHIEF_STATUS.ERROR);
  assert.equal(restored.error, MISSING_CHIEF_ANSWER);
  assert.equal(restored.turnStatus, "empty");
  assert.equal(isSpeakableTurn(restored.turnStatus), false);
  assert.equal(
    classifySettledDelivery({
      answer: "",
      speak: true,
      settled: false,
    }).action,
    "pending"
  );

  client.hooks.onSend = (session, events) => {
    const text = (events || []).find((event) => event.type === "user.message")?.content?.[0]?.text;
    session.events.push({
      id: "answer-why",
      type: "agent.message",
      content: [{ type: "text", text: "I am unsure what reached you." }],
    });
    session.events.push({
      id: "idle-why",
      type: "session.status_idle",
      stop_reason: { type: "end_turn" },
    });
    session.status = "idle";
    session.lastPrompt = text;
  };
  const follow = mockResponse();
  await handleChiefChat(
    request(messageBody("q2", "What did that mean? Why did you say that response?", sessionId)),
    follow.response,
    {
      store,
      client,
      authenticate: auth,
      toolExecutor: { async execute() {} },
      sleepFn: async () => {},
    }
  );
  assert.match(client.session.lastPrompt, /No assistant answer was shown/);
  assert.match(client.session.lastPrompt, new RegExp(MISSING_CHIEF_ANSWER.replace(/[.]/g, "\\.")));
  assert.match(client.session.lastPrompt, /What did that mean\? Why did you say that response\?/);
  assert.equal(client.session.lastPrompt.includes("too technical"), false);
  const explained = projectInteractiveHistory(await store.load("user-1", sessionId));
  assert.equal(
    explained.messages.at(-2).text,
    "What did that mean? Why did you say that response?"
  );
  assert.equal(explained.messages.at(-1).text, "I am unsure what reached you.");
  assert.equal(explained.turnStatus, "completed");
  assert.equal(JSON.stringify(explained.messages).includes("Application notice"), false);
});

test("a provider refusal is a failed turn and does not keep the client polling", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  client.hooks.onCreate = (session) => {
    session.events.push({
      id: "idle-refusal",
      type: "session.status_idle",
      stop_reason: { type: "refusal" },
    });
    session.status = "idle";
  };
  const http = mockResponse();
  await handleChiefChat(request(messageBody("q1", "Question 1")), http.response, {
    store,
    client,
    authenticate: auth,
    toolExecutor: { async execute() {} },
    budgetMs: 1000,
    sleepFn: async () => {},
  });
  const events = frames(http.chunks);
  assert.equal(events.at(-1).msg.status, "failed");
  assert.equal(
    events.some((event) => event.msg?.type === "error" && /declined/.test(event.msg.message)),
    true
  );
  const sessionId = events.at(-1).msg.session_id;
  const history = projectInteractiveHistory(await store.load("user-1", sessionId));
  assert.equal(history.turnStatus, "failed");
  assert.match(history.turnError, /declined/);
  const restored = restoredChiefTurn({
    messages: history.messages,
    turnStatus: history.turnStatus,
    heldPrompt: "Question 2",
    turnError: history.turnError,
  });
  assert.equal(restored.follow, false);
  assert.equal(restored.status, CHIEF_STATUS.ERROR);
  assert.equal(restored.heldPrompt, "Question 2");
  assert.equal(isSpeakableTurn("failed"), false);
});

test("code and web tools pause until the answer, across ten paired turns", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  const calls = [];
  const toolFor = {
    3: "code_read",
    4: "code_search",
    5: "code_tree",
    6: "web_search",
  };
  function finish(session, n) {
    session.events.push({
      id: `answer-${n}`,
      type: "agent.message",
      content: [{ type: "text", text: `Answer ${n}` }],
    });
    session.events.push({
      id: `idle-${n}`,
      type: "session.status_idle",
      stop_reason: { type: "end_turn" },
    });
    session.status = "idle";
  }
  client.hooks.onCreate = (session) => finish(session, 1);
  client.hooks.onSend = (session, events) => {
    const result = (events || []).find((event) => event.type === "user.custom_tool_result");
    if (result) {
      finish(session, session.pending);
      return;
    }
    const text = (events || []).find((event) => event.type === "user.message")?.content?.[0]?.text;
    const n = Number(String(text).replace("Question ", ""));
    const tool = toolFor[n];
    if (tool) {
      session.pending = n;
      session.events.push({
        id: `tool-${n}`,
        type: "agent.custom_tool_use",
        name: tool === "web_search" ? "chief_web_search" : tool,
        input: { path: "src/App.jsx", query: "site shell" },
      });
      session.events.push({
        id: `pause-${n}`,
        type: "session.status_idle",
        stop_reason: { type: "requires_action", event_ids: [`tool-${n}`] },
      });
      session.status = "idle";
      return;
    }
    finish(session, n);
  };
  let sessionId = null;
  for (let n = 1; n <= 10; n += 1) {
    const http = mockResponse();
    await handleChiefChat(
      request(messageBody(`q${n}`, `Question ${n}`, sessionId)),
      http.response,
      {
        store,
        client,
        authenticate: auth,
        toolExecutor: {
          async execute(call) {
            calls.push(call.name);
            return { output: `checked ${call.name}`, isError: false };
          },
        },
        toolSpecs: ["code_read", "code_search", "code_tree", "web_search"].map((name) => ({
          name,
          requiresConfirmation: false,
        })),
        budgetMs: 1000,
        sleepFn: async () => {},
      }
    );
    const events = frames(http.chunks);
    assert.equal(events.at(-1).msg.status, "completed", `turn ${n}`);
    assert.equal(deltas(events), `Answer ${n}`, `turn ${n}`);
    sessionId = events.at(-1).msg.session_id;
  }
  assert.deepEqual(calls, ["code_read", "code_search", "code_tree", "web_search"]);
  const history = projectInteractiveHistory(await store.load("user-1", sessionId));
  const pairs = [];
  for (let n = 1; n <= 10; n += 1)
    pairs.push(["user", `Question ${n}`], ["assistant", `Answer ${n}`]);
  assert.deepEqual(
    history.messages.map((message) => [message.role, message.text]),
    pairs
  );
  const view = currentTurn(history.messages);
  assert.equal(view.userLine, "Question 10");
  assert.equal(view.answer, "Answer 10");
  assert.equal(client.sent.filter((item) => item.agent).length, 1);
});
