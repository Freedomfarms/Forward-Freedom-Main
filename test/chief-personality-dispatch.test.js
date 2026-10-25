// Personality delivery on the turn-synchronizing dispatcher. Managed Agents is mocked.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { runManagedChiefTurn } from "../server/chief/managed/chatTurn.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";
import { defaultChiefPersonality } from "../src/utils/chiefPersonality.js";

const COACH = Object.freeze({
  ...defaultChiefPersonality(),
  preset: "coach",
  responseLength: "concise",
  humor: 20,
  directness: 90,
  proactiveness: 80,
});

const STEER = "Saved conversational preference update";

function message(text, id) {
  return { id, op: { type: "message", message: { text } } };
}

function resume(sessionId, id) {
  return { id, op: { type: "resume_session", session_id: sessionId } };
}

function resourceClient() {
  const session = { id: "prov_1", status: "idle", events: [] };
  const sent = [];
  const hooks = { onCreate: null, onSend: null, onList: null };
  const counts = { memories: 0, creates: 0 };
  return {
    session,
    sent,
    hooks,
    counts,
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
      counts.memories += 1;
      return [];
    },
    async createMemory() {
      counts.creates += 1;
      return { id: `memfile-${counts.creates}` };
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

function providerUserTexts(client) {
  const texts = [];
  for (const item of client.sent) {
    const events = item.events || item.initial_events || [];
    for (const event of events) {
      if (event.type === "user.message") texts.push(event.content?.[0]?.text || "");
    }
  }
  return texts;
}

function visible(transcript) {
  return (transcript || [])
    .filter((entry) => entry.role === "user" || entry.role === "assistant")
    .map((entry) => [entry.role, entry.content]);
}

function userLines(transcript) {
  return (transcript || []).filter((entry) => entry.role === "user").map((entry) => entry.content);
}

function answerFor(session, id, text) {
  session.events.push({
    id,
    type: "agent.message",
    content: [{ type: "text", text }],
  });
  session.events.push({ id: `idle-${id}`, type: "session.status_idle" });
  session.status = "idle";
}

test("chiefApi keeps turn sync and personality exports", () => {
  const source = readFileSync(new URL("../src/utils/chiefApi.js", import.meta.url), "utf8");
  assert.match(source, /acceptChiefSubmission/);
  assert.match(source, /restoredChiefTurn/);
  assert.match(source, /export function fetchChiefPersonality/);
  assert.match(source, /export function saveChiefPersonalitySettings/);
});

test("a held follow-up stays raw until dispatch and is steered once", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  let personality = defaultChiefPersonality();
  const readPersonality = async () => ({ personality });
  client.hooks.onCreate = (session) => {
    session.status = "running";
  };
  const first = await runManagedChiefTurn({
    userId: "user-1",
    submission: message("Question 1", "q1"),
    store,
    client,
    toolExecutor: new ToolExecutor(),
    readPersonality,
    budgetMs: 0,
    sleepFn: async () => {},
  });
  assert.equal(first.status, "continuing");
  personality = COACH;
  const second = await runManagedChiefTurn({
    userId: "user-1",
    sessionId: first.sessionId,
    submission: message("Question 2", "q2"),
    store,
    client,
    toolExecutor: new ToolExecutor(),
    readPersonality,
    budgetMs: 0,
    sleepFn: async () => {},
  });
  assert.equal(second.status, "continuing");
  assert.deepEqual(second.checkpoint.context.heldPrompts, ["Question 2"]);
  assert.equal(
    providerUserTexts(client).some((text) => text.includes("Question 2")),
    false
  );
  assert.equal(userLines(second.checkpoint.transcript).includes(STEER), false);
  assert.deepEqual(userLines(second.checkpoint.transcript), ["Question 1"]);

  answerFor(client.session, "a1", "Answer 1.");
  const caughtUp = await runManagedChiefTurn({
    userId: "user-1",
    sessionId: first.sessionId,
    submission: resume(first.sessionId, "resume-1"),
    store,
    client,
    toolExecutor: new ToolExecutor(),
    readPersonality,
    budgetMs: 0,
    sleepFn: async () => {},
  });
  assert.deepEqual(visible(caughtUp.checkpoint.transcript), [
    ["user", "Question 1"],
    ["assistant", "Answer 1."],
  ]);
  assert.deepEqual(caughtUp.checkpoint.context.heldPrompts, ["Question 2"]);
  const digestWhileHeld = caughtUp.checkpoint.context.managed.personalityDigest;

  client.hooks.onSend = (session, events) => {
    const text = events.find((event) => event.type === "user.message")?.content?.[0]?.text || "";
    assert.match(text, new RegExp(STEER));
    assert.match(text, /Question 2/);
    answerFor(session, "a2", "Answer for Question 2");
  };
  const sent = await runManagedChiefTurn({
    userId: "user-1",
    sessionId: first.sessionId,
    submission: resume(first.sessionId, "resume-2"),
    store,
    client,
    toolExecutor: new ToolExecutor(),
    readPersonality,
    sleepFn: async () => {},
  });
  assert.equal(sent.status, "completed");
  assert.deepEqual(visible(sent.checkpoint.transcript), [
    ["user", "Question 1"],
    ["assistant", "Answer 1."],
    ["user", "Question 2"],
    ["assistant", "Answer for Question 2"],
  ]);
  assert.equal(
    userLines(sent.checkpoint.transcript).some((line) => line.includes(STEER)),
    false
  );
  assert.notEqual(sent.checkpoint.context.managed.personalityDigest, digestWhileHeld);

  client.hooks.onSend = (session, events) => {
    const text = events.find((event) => event.type === "user.message")?.content?.[0]?.text || "";
    assert.equal(text, "Question 3");
    answerFor(session, "a3", "Answer for Question 3");
  };
  const third = await runManagedChiefTurn({
    userId: "user-1",
    sessionId: first.sessionId,
    submission: message("Question 3", "q3"),
    store,
    client,
    toolExecutor: new ToolExecutor(),
    readPersonality,
    sleepFn: async () => {},
  });
  assert.equal(third.sessionId, first.sessionId);
  assert.deepEqual(userLines(third.checkpoint.transcript), [
    "Question 1",
    "Question 2",
    "Question 3",
  ]);
  assert.equal(visible(third.checkpoint.transcript).at(-1)[1], "Answer for Question 3");
});

test("two dispatches in one run steer only the first successful send", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  let personality = defaultChiefPersonality();
  const readPersonality = async () => ({ personality });
  client.hooks.onCreate = (session) => {
    answerFor(session, "a1", "Answer 1.");
  };
  const first = await runManagedChiefTurn({
    userId: "user-1",
    submission: message("Question 1", "q1"),
    store,
    client,
    toolExecutor: new ToolExecutor(),
    readPersonality,
    sleepFn: async () => {},
  });
  personality = COACH;
  const saved = await store.load("user-1", first.sessionId);
  saved.checkpoint.context.heldPrompts = ["Question 3"];
  await store.saveWithEvents("user-1", first.sessionId, { checkpoint: saved.checkpoint });
  const sent = [];
  client.counts.memories = 0;
  client.hooks.onSend = (session, events) => {
    const text = events.find((event) => event.type === "user.message")?.content?.[0]?.text || "";
    sent.push(text);
    const label = text.includes("Question 3") ? "Question 3" : "Question 2";
    answerFor(session, `a-${sent.length}`, `Answer for ${label}`);
  };
  const second = await runManagedChiefTurn({
    userId: "user-1",
    sessionId: first.sessionId,
    submission: message("Question 2", "q2"),
    store,
    client,
    toolExecutor: new ToolExecutor(),
    readPersonality,
    sleepFn: async () => {},
  });
  assert.equal(second.status, "completed");
  assert.equal(sent.length, 2);
  assert.match(sent[0], new RegExp(STEER));
  assert.match(sent[0], /Question 2/);
  assert.equal(sent[1], "Question 3");
  assert.equal(client.counts.memories, 1);
  assert.deepEqual(visible(second.checkpoint.transcript), [
    ["user", "Question 1"],
    ["assistant", "Answer 1."],
    ["user", "Question 2"],
    ["assistant", "Answer for Question 2"],
    ["user", "Question 3"],
    ["assistant", "Answer for Question 3"],
  ]);
  assert.deepEqual(second.checkpoint.context.heldPrompts, []);
});

test("a stale idle event does not finish the steered question early", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  let personality = defaultChiefPersonality();
  const readPersonality = async () => ({ personality });
  client.hooks.onCreate = (session) => {
    answerFor(session, "a1", "Answer 1.");
  };
  const first = await runManagedChiefTurn({
    userId: "user-1",
    submission: message("Question 1", "q1"),
    store,
    client,
    toolExecutor: new ToolExecutor(),
    readPersonality,
    sleepFn: async () => {},
  });
  personality = COACH;
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
    answerFor(session, "a2", "Answer 2.");
  };
  const second = await runManagedChiefTurn({
    userId: "user-1",
    sessionId: first.sessionId,
    submission: message("Question 2", "q2"),
    store,
    client,
    toolExecutor: new ToolExecutor(),
    readPersonality,
    budgetMs: 5_000,
    sleepFn: async () => {},
  });
  assert.equal(second.status, "completed");
  assert.ok(pollsAfterSend >= 3);
  const payloads = providerUserTexts(client);
  assert.match(payloads.at(-1), new RegExp(STEER));
  assert.match(payloads.at(-1), /Question 2/);
  assert.deepEqual(visible(second.checkpoint.transcript), [
    ["user", "Question 1"],
    ["assistant", "Answer 1."],
    ["user", "Question 2"],
    ["assistant", "Answer 2."],
  ]);
  assert.equal(
    userLines(second.checkpoint.transcript).some((line) => line.includes(STEER)),
    false
  );
});

test("a 409 send keeps the raw question and steers once on retry", async () => {
  const store = new MemoryCheckpointStore();
  const client = resourceClient();
  let personality = defaultChiefPersonality();
  const readPersonality = async () => ({ personality });
  client.hooks.onCreate = (session) => {
    answerFor(session, "a1", "Answer 1.");
  };
  const first = await runManagedChiefTurn({
    userId: "user-1",
    submission: message("Question 1", "q1"),
    store,
    client,
    toolExecutor: new ToolExecutor(),
    readPersonality,
    sleepFn: async () => {},
  });
  const digestAfterOpen = first.checkpoint.context.managed.personalityDigest;
  personality = COACH;
  let sends = 0;
  client.hooks.onSend = (session, events) => {
    sends += 1;
    const text = events.find((event) => event.type === "user.message")?.content?.[0]?.text || "";
    if (sends === 1) {
      assert.match(text, new RegExp(STEER));
      assert.match(text, /Question 2/);
      session.status = "running";
      const error = new Error("session busy");
      error.status = 409;
      throw error;
    }
    assert.match(text, new RegExp(STEER));
    assert.match(text, /Question 2/);
    answerFor(session, "a2", "Answer for Question 2");
  };
  const blocked = await runManagedChiefTurn({
    userId: "user-1",
    sessionId: first.sessionId,
    submission: message("Question 2", "q2"),
    store,
    client,
    toolExecutor: new ToolExecutor(),
    readPersonality,
    budgetMs: 0,
    sleepFn: async () => {},
  });
  assert.equal(blocked.status, "continuing");
  assert.equal(sends, 1);
  assert.deepEqual(blocked.checkpoint.context.heldPrompts, ["Question 2"]);
  assert.equal(blocked.checkpoint.context.managed.personalityDigest, digestAfterOpen);
  assert.deepEqual(userLines(blocked.checkpoint.transcript), ["Question 1"]);
  assert.equal(
    userLines(blocked.checkpoint.transcript).some((line) => line.includes(STEER)),
    false
  );

  client.session.status = "idle";
  const retried = await runManagedChiefTurn({
    userId: "user-1",
    sessionId: first.sessionId,
    submission: resume(first.sessionId, "resume-409"),
    store,
    client,
    toolExecutor: new ToolExecutor(),
    readPersonality,
    sleepFn: async () => {},
  });
  assert.equal(retried.status, "completed");
  assert.equal(sends, 2);
  assert.notEqual(retried.checkpoint.context.managed.personalityDigest, digestAfterOpen);
  assert.deepEqual(visible(retried.checkpoint.transcript), [
    ["user", "Question 1"],
    ["assistant", "Answer 1."],
    ["user", "Question 2"],
    ["assistant", "Answer for Question 2"],
  ]);

  client.hooks.onSend = (session, events) => {
    const text = events.find((event) => event.type === "user.message")?.content?.[0]?.text || "";
    assert.equal(text, "Question 3");
    answerFor(session, "a3", "Answer for Question 3");
  };
  const third = await runManagedChiefTurn({
    userId: "user-1",
    sessionId: first.sessionId,
    submission: message("Question 3", "q3"),
    store,
    client,
    toolExecutor: new ToolExecutor(),
    readPersonality,
    sleepFn: async () => {},
  });
  assert.deepEqual(userLines(third.checkpoint.transcript), [
    "Question 1",
    "Question 2",
    "Question 3",
  ]);
  assert.equal(new Set(userLines(third.checkpoint.transcript)).size, 3);
  assert.equal(visible(third.checkpoint.transcript).at(-1)[1], "Answer for Question 3");
});
