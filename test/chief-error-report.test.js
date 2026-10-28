// Known CHIEF failures keep a specific user sentence and a structured log.
// An unrecognized failure stays the generic sentence and is not given a cause.

import test from "node:test";
import assert from "node:assert/strict";

import { handleChiefChat } from "../api/chief/chat.js";
import { providerErrorFields } from "../server/chief/managed/redact.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";
import {
  CHIEF_FAILURE_MESSAGE,
  classifyChiefFailure,
  classifyTurnOutcome,
} from "../src/utils/chiefErrors.js";
import { speechErrorMessage } from "../src/utils/chiefSpeech.js";
import { voiceErrorMessage } from "../src/components/chief/voice/voiceMachine.js";
import {
  applyChiefEvent,
  CHIEF_STATUS,
  initialTurnState,
  isSpeakableTurn,
  MISSING_CHIEF_ANSWER,
} from "../src/utils/chiefProtocol.js";
import {
  classifySettledDelivery,
  PLAYBACK_BLOCKED_MESSAGE,
} from "../src/utils/chiefReplySpeech.js";

const GENERIC = CHIEF_FAILURE_MESSAGE.unknown;

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
    on() {},
  };
  return { response, headers, chunks, state };
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

const FIXTURES = [
  {
    name: "managed agent is not configured",
    input: {
      status: 503,
      message: "Claude Managed Agents is not configured. Set ANTHROPIC_API_KEY on the server.",
    },
    category: "managed_agent",
    duration: "permanent",
    message: CHIEF_FAILURE_MESSAGE.managedUnconfigured,
    known: true,
  },
  {
    name: "managed agent connection drop",
    input: {
      name: "TypeError",
      message: "fetch failed",
      operation: "listEvents",
      component: "managed_agent",
    },
    category: "managed_agent",
    duration: "temporary",
    message: CHIEF_FAILURE_MESSAGE.managedTemporary,
    known: true,
    terminal: false,
  },
  {
    name: "workspace denial",
    input: {
      component: "workspace",
      code: "workspace_denied",
      message: "write /etc/passwd",
      operation: "write",
    },
    category: "workspace",
    duration: "permanent",
    message: CHIEF_FAILURE_MESSAGE.workspace,
    known: true,
    secret: "/etc/passwd",
  },
  {
    name: "memory store missing",
    input: { message: "Claude Managed Agents did not return a memory store." },
    category: "memory",
    duration: "permanent",
    message: CHIEF_FAILURE_MESSAGE.memory,
    known: true,
  },
  {
    name: "memory encryption",
    input: { message: "Encryption is not configured", code: "P1001", component: "memory" },
    category: "memory",
    message: CHIEF_FAILURE_MESSAGE.memory,
    known: true,
  },
  {
    name: "approval pause",
    input: { turnStatus: "suspended" },
    category: "approval",
    duration: "approval",
    message: CHIEF_FAILURE_MESSAGE.approval,
    known: true,
    terminal: false,
  },
  {
    name: "stale approval",
    input: { message: "That approval is no longer pending." },
    category: "approval",
    duration: "approval",
    message: CHIEF_FAILURE_MESSAGE.approvalGone,
    known: true,
    terminal: false,
  },
  {
    name: "cursor is not configured",
    input: {
      message: "Cursor coding handoff is not configured. Set CURSOR_API_KEY on the server.",
    },
    category: "cursor",
    duration: "permanent",
    message: "Cursor coding handoff is not configured. Set CURSOR_API_KEY on the server.",
    known: true,
  },
  {
    name: "elevenlabs is not configured",
    input: { message: "ElevenLabs is not configured." },
    category: "elevenlabs",
    message: CHIEF_FAILURE_MESSAGE.elevenlabsUnconfigured,
    known: true,
    terminal: false,
  },
  {
    name: "elevenlabs stack",
    input: {
      component: "elevenlabs",
      message: "ElevenLabs failed sk-ant-api03-secretvalue\n    at speak (node_modules/voice.js)",
    },
    category: "elevenlabs",
    message: CHIEF_FAILURE_MESSAGE.elevenlabs,
    known: true,
    secret: "sk-ant",
    terminal: false,
  },
  {
    name: "microphone missing",
    input: { component: "microphone", code: "mic_unavailable" },
    category: "microphone",
    message: CHIEF_FAILURE_MESSAGE.micUnavailable,
    known: true,
  },
  {
    name: "microphone denied",
    input: { component: "speech", code: "not-allowed" },
    category: "microphone",
    message: CHIEF_FAILURE_MESSAGE.micDenied,
    known: true,
  },
  {
    name: "interrupted turn",
    input: { turnStatus: "failed", message: "I'll start with what's already saved." },
    category: "turn",
    message: CHIEF_FAILURE_MESSAGE.turnInterrupted,
    known: true,
    interrupted: true,
    completed: false,
  },
  {
    name: "empty turn",
    input: { turnStatus: "empty" },
    category: "turn",
    message: CHIEF_FAILURE_MESSAGE.turnEmpty,
    known: true,
    interrupted: false,
    completed: false,
  },
  {
    name: "completed turn",
    input: { turnStatus: "completed", message: "Hello from CHIEF." },
    category: "turn",
    message: "",
    known: true,
    completed: true,
    interrupted: false,
    terminal: false,
  },
  {
    name: "unknown provider failure",
    input: {
      status: 502,
      operation: "listAgents",
      message: "createAgent rejected sk-ant-api03-secretvalue for farmer@example.com",
    },
    category: "unknown",
    message: GENERIC,
    known: false,
    secret: "sk-ant",
  },
];

test("every known failure has its own category and is not given another category's sentence", () => {
  const seen = new Map();
  for (const fixture of FIXTURES) {
    const got = classifyChiefFailure(fixture.input);
    assert.equal(got.category, fixture.category, fixture.name);
    assert.equal(got.known, fixture.known, fixture.name);
    if (fixture.duration) assert.equal(got.duration, fixture.duration, fixture.name);
    if (fixture.message !== undefined) assert.equal(got.message, fixture.message, fixture.name);
    if (fixture.terminal !== undefined) assert.equal(got.terminal, fixture.terminal, fixture.name);
    if (fixture.completed !== undefined)
      assert.equal(got.completed, fixture.completed, fixture.name);
    if (fixture.interrupted !== undefined) {
      assert.equal(got.interrupted, fixture.interrupted, fixture.name);
    }
    if (fixture.secret) assert.equal(got.message.includes(fixture.secret), false, fixture.name);
    if (fixture.category !== "unknown") assert.notEqual(got.message, GENERIC, fixture.name);
    const prior = seen.get(got.message);
    if (prior && prior !== got.category && got.message) {
      assert.fail(`${fixture.name} reused ${prior}'s message`);
    }
    if (got.message) seen.set(got.message, got.category);
  }
  assert.equal(classifyChiefFailure(FIXTURES[0].input).category === "memory", false);
  assert.equal(classifyChiefFailure(FIXTURES[3].input).category === "workspace", false);
  assert.equal(classifyChiefFailure(FIXTURES[6].input).category === "turn", false);
  assert.equal(classifyChiefFailure(FIXTURES[9].input).category === "turn", false);
  assert.equal(classifyChiefFailure(FIXTURES[10].input).category === "elevenlabs", false);
});

test("a preamble is not a completed answer, and a finished answer can be spoken", () => {
  const partial = classifyTurnOutcome({
    status: "failed",
    text: "I'll start with what's already saved in your workspace.",
  });
  assert.equal(partial.completed, false);
  assert.equal(partial.interrupted, true);
  assert.equal(partial.category, "turn");
  assert.match(partial.message, /CHIEF could not complete that request/);
  assert.equal(partial.message.includes("I'll start"), false);
  assert.equal(isSpeakableTurn("failed"), false);

  const done = classifyTurnOutcome({ status: "completed", text: "Hello from CHIEF." });
  assert.equal(done.completed, true);
  assert.equal(done.interrupted, false);
  assert.equal(done.message, "");
  assert.equal(isSpeakableTurn("completed"), true);

  const empty = classifyTurnOutcome({ status: "empty", text: "" });
  assert.equal(empty.message, MISSING_CHIEF_ANSWER);
  assert.equal(empty.completed, false);
  assert.notEqual(empty.message, CHIEF_FAILURE_MESSAGE.turnInterrupted);
});

test("approval, temporary connection, and voice failure do not close a written answer", () => {
  const answer = "Yes. The books are balanced.";
  let state = applyChiefEvent(initialTurnState(null), {
    msg: { type: "assistant_content_delta", phase: "final_answer", delta: answer },
  });

  const waiting = applyChiefEvent(state, {
    msg: { type: "session_configured", status: "suspended" },
  });
  assert.equal(waiting.error, "");
  assert.equal(waiting.turnStatus, "suspended");
  assert.equal(waiting.status, CHIEF_STATUS.APPROVAL);
  assert.equal(waiting.streamText, answer);
  assert.equal(isSpeakableTurn(waiting.turnStatus), false);

  const dropped = applyChiefEvent(state, {
    msg: {
      type: "error",
      message: CHIEF_FAILURE_MESSAGE.managedTemporary,
      retryable: true,
      category: "managed_agent",
      duration: "temporary",
    },
  });
  assert.equal(dropped.error, CHIEF_FAILURE_MESSAGE.managedTemporary);
  assert.equal(dropped.finished, false);
  assert.equal(dropped.turnStatus, "continuing");
  assert.equal(dropped.streamText, answer);
  assert.notEqual(dropped.error, GENERIC);

  const spoken = applyChiefEvent(
    { ...state, finished: true, turnStatus: "completed", status: CHIEF_STATUS.READY },
    {
      msg: {
        type: "error",
        message: CHIEF_FAILURE_MESSAGE.elevenlabs,
        category: "elevenlabs",
        retryable: false,
      },
    }
  );
  assert.equal(spoken.streamText, answer);
  assert.equal(spoken.turnStatus, "completed");
  assert.equal(spoken.error, "");
  assert.equal(isSpeakableTurn(spoken.turnStatus), true);

  const playback = classifySettledDelivery({
    answer,
    settled: true,
    speak: true,
    playback: { ok: false, code: "playback_blocked", error: PLAYBACK_BLOCKED_MESSAGE },
  });
  assert.equal(playback.action, "blocked");
  assert.equal(playback.category, "elevenlabs");
  assert.equal(playback.text, answer);
  assert.notEqual(playback.message, CHIEF_FAILURE_MESSAGE.turnInterrupted);

  const tts = classifySettledDelivery({
    answer,
    settled: true,
    speak: true,
    playback: {
      ok: false,
      error: "ElevenLabs failed sk-ant-api03-secretvalue\n    at node_modules/voice.js",
    },
  });
  assert.equal(tts.action, "tts_failed");
  assert.equal(tts.category, "elevenlabs");
  assert.equal(tts.text, answer);
  assert.equal(tts.message, CHIEF_FAILURE_MESSAGE.elevenlabs);
  assert.equal(tts.message.includes("sk-ant"), false);
  assert.equal(tts.message.includes("node_modules"), false);
});

test("microphone and voice codes stay on their own messages", () => {
  assert.equal(voiceErrorMessage("mic_unavailable"), "No microphone is available.");
  assert.equal(
    voiceErrorMessage("unsupported"),
    "This browser cannot hear speech. Type to CHIEF instead."
  );
  assert.equal(voiceErrorMessage("not_configured"), "Spoken voice is not configured.");
  assert.equal(voiceErrorMessage("rate_limited"), "Spoken voice is busy. Try again in a moment.");
  assert.equal(speechErrorMessage("audio-capture"), "No microphone was found.");
  assert.equal(speechErrorMessage("not-allowed"), "Microphone permission was denied.");
  assert.equal(speechErrorMessage("network"), "Speech recognition needs a network connection.");
  assert.equal(speechErrorMessage("aborted"), "");
  assert.equal(
    classifyChiefFailure({ component: "microphone", code: "mic_unavailable" }).category,
    "microphone"
  );
  assert.notEqual(
    classifyChiefFailure({ message: "ElevenLabs is not configured." }).category,
    "microphone"
  );
  assert.notEqual(voiceErrorMessage("mic_unavailable"), GENERIC);
  assert.notEqual(voiceErrorMessage("not_configured"), CHIEF_FAILURE_MESSAGE.turnInterrupted);
});

test("chat shows a known failure and logs category, component, operation, and correlation id", async () => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => {
    lines.push(args.map((part) => String(part)).join(" "));
  };
  try {
    const http = mockResponse();
    const client = {
      async listAgents() {
        const error = new Error("Claude Managed Agents did not return a memory store.");
        error.operation = "createMemoryStore";
        throw error;
      },
    };
    await handleChiefChat(
      request({ submission: { id: "sub-mem", op: { type: "message", message: { text: "Hi" } } } }),
      http.response,
      {
        store: new MemoryCheckpointStore(),
        client,
        authenticate: auth,
        toolExecutor: new ToolExecutor(),
      }
    );
    const event = frames(http.chunks).at(-1).msg;
    assert.equal(event.category, "memory");
    assert.equal(event.message, CHIEF_FAILURE_MESSAGE.memory);
    assert.equal(event.retryable, false);
    assert.equal(event.message.includes("memory store"), false);
    const log = lines.join("\n");
    assert.match(log, /\[chief\/chat\] createMemoryStore/);
    assert.match(log, /memory memory sub-mem/);
    assert.equal(log.includes("sk-"), false);
  } finally {
    console.error = original;
  }
});

test("an unknown chat failure stays generic and the log redacts secrets and stacks", async () => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => {
    lines.push(args.map((part) => String(part)).join(" "));
  };
  try {
    const http = mockResponse();
    const client = {
      async listAgents() {
        const error = new Error(
          "createAgent rejected sk-ant-api03-secretvalue for farmer@example.com\n    at Client (node_modules/sdk.js)"
        );
        error.status = 502;
        error.operation = "listAgents";
        throw error;
      },
    };
    await handleChiefChat(
      request({
        submission: { id: "sub-9", op: { type: "message", message: { text: "private 88421" } } },
      }),
      http.response,
      {
        store: new MemoryCheckpointStore(),
        client,
        authenticate: auth,
        toolExecutor: new ToolExecutor(),
      }
    );
    const event = frames(http.chunks).at(-1).msg;
    assert.equal(event.message, GENERIC);
    assert.equal(event.category, "unknown");
    assert.equal(event.retryable, true);
    const body = http.chunks.join("");
    assert.equal(body.includes("sk-ant"), false);
    assert.equal(body.includes("node_modules"), false);
    assert.equal(body.includes("88421"), false);
    const log = lines.join("\n");
    assert.match(log, /\[chief\/chat\] listAgents 502 ensure_resources sub-9/);
    assert.match(log, /unknown managed_agent sub-9/);
    assert.equal(log.includes("sk-ant"), false);
    assert.equal(log.includes("node_modules"), false);
    assert.equal(log.includes("88421"), false);
    const fields = providerErrorFields(
      {
        operation: "listAgents",
        status: 502,
        message: "bad sk-ant-api03-secretvalue\n    at stack (node_modules/sdk.js)",
        submissionId: "sub-9",
      },
      { component: "managed_agent", correlationId: "sub-9" }
    );
    assert.equal(fields.operation, "listAgents");
    assert.equal(fields.category, "unknown");
    assert.equal(fields.component, "managed_agent");
    assert.equal(fields.correlationId, "sub-9");
    assert.equal(fields.message.includes("sk-ant"), false);
    assert.equal(fields.message.includes("node_modules"), false);
    assert.equal(Object.hasOwn(fields, "stack"), false);
  } finally {
    console.error = original;
  }
});
