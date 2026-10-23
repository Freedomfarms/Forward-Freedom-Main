// Scheduled CHIEF work uses Claude Managed Agents. No network and no provider key.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handleChiefDispatch } from "../api/cron/chief-dispatch.js";
import { drainManagedWork } from "../server/chief/managed/chatTurn.js";
import { createMemoryWorkQueue } from "../server/chief/managed/workQueue.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { runChiefTick, settleScheduledSession } from "../server/chief/scheduler/tick.js";
import { MemoryTaskStore, RunStatus } from "../server/chief/scheduler/store.js";
import { scriptedManagedClient } from "./chief-managed-client-fixture.js";

const T0 = new Date("2026-09-30T12:00:00.000Z");

function at(offsetMs) {
  return new Date(T0.getTime() + offsetMs);
}

function task(fields = {}) {
  return {
    id: fields.id ?? "task-1",
    userId: fields.userId ?? "user-1",
    name: fields.name ?? "briefing",
    kind: fields.kind ?? "INTERVAL",
    intervalSeconds: fields.intervalSeconds ?? 3600,
    cronExpr: null,
    runAt: fields.runAt ?? null,
    payload: fields.payload ?? { prompt: fields.prompt ?? "Summarize the day." },
    status: "ACTIVE",
    nextRunAt: fields.nextRunAt === undefined ? T0 : fields.nextRunAt,
    lastRunAt: null,
    lockedAt: fields.lockedAt ?? null,
  };
}

function prompts(client) {
  return client.state.sent
    .filter((item) => Array.isArray(item.initial_events))
    .map((item) => item.initial_events[0]?.content?.[0]?.text || "");
}

test("a missed interval fires once and the next slot moves forward", async () => {
  const store = new MemoryTaskStore({
    tasks: [task({ nextRunAt: at(-25 * 60 * 1000), intervalSeconds: 600 })],
  });
  const client = scriptedManagedClient([{ text: "Caught up." }]);
  const report = await runChiefTick({
    taskStore: store,
    checkpointStore: new MemoryCheckpointStore(),
    client,
    clock: () => T0,
    createTooling: async () => ({ executor: null, specs: [] }),
  });
  assert.equal(report.runs[0].status, RunStatus.SUCCEEDED);
  assert.equal(store.runs.length, 1);
  assert.equal(store.tasks[0].nextRunAt.toISOString(), "2026-09-30T12:05:00.000Z");
  assert.match(prompts(client)[0], /Summarize the day/);
});

test("a recurring task can run again on its next slot", async () => {
  let now = T0;
  const steps = [{ text: "Morning." }];
  const client = scriptedManagedClient(steps);
  const store = new MemoryTaskStore({ tasks: [task()] });
  const checkpointStore = new MemoryCheckpointStore();
  await runChiefTick({
    taskStore: store,
    checkpointStore,
    client,
    clock: () => now,
    createTooling: async () => ({ executor: null, specs: [] }),
  });
  now = at(3600_000);
  steps.push({ text: "Evening." });
  await runChiefTick({
    taskStore: store,
    checkpointStore,
    client,
    clock: () => now,
    createTooling: async () => ({ executor: null, specs: [] }),
  });
  assert.equal(store.runs.length, 2);
  assert.equal(store.runs[0].status, RunStatus.SUCCEEDED);
  assert.equal(store.runs[1].status, RunStatus.SUCCEEDED);
  assert.notEqual(store.runs[0].sessionId, store.runs[1].sessionId);
});

test("an interrupted managed session resumes instead of failing", async () => {
  const jobs = createMemoryWorkQueue();
  const steps = [{ running: true }];
  const client = scriptedManagedClient(steps);
  const store = new MemoryTaskStore({ tasks: [task({ kind: "ONCE", runAt: T0, nextRunAt: T0 })] });
  const checkpointStore = new MemoryCheckpointStore();
  const first = await runChiefTick({
    taskStore: store,
    checkpointStore,
    client,
    jobs,
    clock: () => T0,
    turnTimeoutMs: 0,
    createTooling: async () => ({ executor: null, specs: [] }),
  });
  assert.equal(first.runs[0].status, "continuing");
  assert.equal(store.runs[0].status, RunStatus.RUNNING);
  assert.equal(jobs.rows.size, 1);

  store.runs[0].startedAt = at(-16 * 60 * 1000);
  store.tasks[0].lockedAt = at(-16 * 60 * 1000);
  store.tasks[0].nextRunAt = at(3600_000);
  const second = await runChiefTick({
    taskStore: store,
    checkpointStore,
    client,
    jobs,
    clock: () => at(60_000),
    createTooling: async () => ({ executor: null, specs: [] }),
  });
  assert.equal(second.recovered, 0);
  assert.equal(second.resumed, 1);
  assert.equal(store.runs.length, 1);
  assert.equal(store.runs[0].status, RunStatus.RUNNING);
  assert.equal(jobs.rows.size, 1);

  const session = [...client.state.sessions.values()][0];
  session.status = "idle";
  session.events.push({
    id: "later",
    type: "agent.message",
    content: [{ type: "text", text: "The briefing is ready." }],
  });
  session.events.push({ id: "idle-later", type: "session.status_idle" });
  const drained = await drainManagedWork({
    jobs,
    client,
    store: checkpointStore,
    createTooling: async () => ({ executor: null, specs: [] }),
    afterTurn: ({ job, result, error }) =>
      settleScheduledSession({
        userId: job.userId,
        sessionId: job.threadId,
        taskStore: store,
        checkpointStore,
        turnResult: result,
        error,
        clock: () => at(60_000),
      }),
  });
  assert.equal(drained.drained, 1);
  assert.equal(store.runs[0].status, RunStatus.SUCCEEDED);
  assert.match(store.runs[0].result.summary, /briefing is ready/);
  assert.equal(store.tasks[0].status, "COMPLETED");
});

test("a second claim and a second queue row do not duplicate the run", async () => {
  const jobs = createMemoryWorkQueue();
  const first = await jobs.enqueue({ userId: "user-1", threadId: "thread-1" });
  const second = await jobs.enqueue({ userId: "user-1", threadId: "thread-1" });
  assert.equal(first.id, second.id);
  assert.equal(jobs.rows.size, 1);

  const store = new MemoryTaskStore({ tasks: [task()] });
  const checkpointStore = new MemoryCheckpointStore();
  const client = scriptedManagedClient([{ running: true }]);
  await runChiefTick({
    taskStore: store,
    checkpointStore,
    client,
    jobs,
    clock: () => T0,
    turnTimeoutMs: 0,
    createTooling: async () => ({ executor: null, specs: [] }),
  });
  store.tasks[0].lockedAt = at(-16 * 60 * 1000);
  store.tasks[0].nextRunAt = T0;
  const again = await runChiefTick({
    taskStore: store,
    checkpointStore,
    client,
    jobs,
    clock: () => at(60_000),
    createTooling: async () => ({ executor: null, specs: [] }),
  });
  assert.equal(store.runs.length, 1);
  assert.equal(again.runs.length, 0);
});

test("a missing provider key does not claim work or fall back", async () => {
  const store = new MemoryTaskStore({ tasks: [task()] });
  const report = await runChiefTick({
    taskStore: store,
    checkpointStore: new MemoryCheckpointStore(),
    client: null,
    clock: () => T0,
    createTooling: async () => ({ executor: null, specs: [] }),
  });
  assert.equal(report.blocked, "ANTHROPIC_API_KEY");
  assert.equal(report.runs.length, 0);
  assert.equal(store.runs.length, 0);
  assert.equal(store.tasks[0].status, "ACTIVE");
  assert.equal(store.tasks[0].nextRunAt.toISOString(), T0.toISOString());

  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "correct-secret";
  try {
    const response = {
      headersSent: false,
      setHeader() {},
      getHeader() {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
    await handleChiefDispatch(
      {
        method: "GET",
        headers: { authorization: "Bearer correct-secret" },
        query: {},
        socket: { remoteAddress: "127.0.0.3" },
      },
      response,
      {
        taskStore: store,
        checkpointStore: new MemoryCheckpointStore(),
        client: null,
        jobs: createMemoryWorkQueue(),
        createTooling: async () => ({ executor: null, specs: [] }),
      }
    );
    assert.equal(response.statusCode, 503);
    assert.match(response.body.error, /ANTHROPIC_API_KEY/);
    assert.equal(store.runs.length, 0);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test("scheduled prompts stay inside the owning user", async () => {
  const store = new MemoryTaskStore({
    tasks: [
      task({ id: "a", userId: "user-a", payload: { prompt: "ALPHA-ONLY" } }),
      task({ id: "b", userId: "user-b", payload: { prompt: "BETA-ONLY" } }),
    ],
  });
  const checkpointStore = new MemoryCheckpointStore();
  const client = scriptedManagedClient([{ text: "Done A." }, { text: "Done B." }]);
  await runChiefTick({
    taskStore: store,
    checkpointStore,
    client,
    clock: () => T0,
    createTooling: async () => ({ executor: null, specs: [] }),
  });
  const runA = store.runs.find((run) => run.userId === "user-a");
  const runB = store.runs.find((run) => run.userId === "user-b");
  const sessionA = await checkpointStore.load("user-a", runA.sessionId);
  const sessionB = await checkpointStore.load("user-b", runB.sessionId);
  assert.match(JSON.stringify(sessionA.checkpoint.transcript), /ALPHA-ONLY/);
  assert.equal(JSON.stringify(sessionA.checkpoint.transcript).includes("BETA-ONLY"), false);
  assert.match(JSON.stringify(sessionB.checkpoint.transcript), /BETA-ONLY/);
  assert.equal(await checkpointStore.load("user-a", runB.sessionId), null);
  assert.equal(await checkpointStore.load("user-b", runA.sessionId), null);
});

test("active runtime entry points do not call the legacy reasoning classes", () => {
  const files = [
    "api/chief/chat.js",
    "api/chief/approvals.js",
    "api/cron/chief-dispatch.js",
    "server/chief/scheduler/tick.js",
    "server/chief/scheduler/resume.js",
    "server/chief/managed/chatTurn.js",
  ];
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.equal(source.includes("new TurnMachine("), false);
  assert.equal(source.includes("createModelEngine"), false);
  assert.equal(source.includes("ChiefModelEngine"), false);
  assert.match(readFileSync("api/chief/chat.js", "utf8"), /runManagedChiefTurn/);
  assert.match(readFileSync("api/chief/approvals.js", "utf8"), /runManagedChiefTurn/);
  assert.match(readFileSync("server/chief/scheduler/tick.js", "utf8"), /runManagedChiefTurn/);
  assert.match(readFileSync("api/cron/chief-dispatch.js", "utf8"), /drainManagedWork/);
});
