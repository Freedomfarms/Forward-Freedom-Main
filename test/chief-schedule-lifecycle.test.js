// Phase 12 schedule lifecycle. List, pause, resume, and cancel go through
// the existing tool executor and the existing schedule store. The tick is
// not started by these tools.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import { MemoryFactStore } from "../server/chief/memory/facts.js";
import { MemoryGraphStore } from "../server/chief/memory/graph.js";
import { ApprovalCoordinator } from "../server/chief/runtime/approvals.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { TurnMachine } from "../server/chief/runtime/turn.js";
import { quietAttention } from "../server/chief/scheduler/operative.js";
import { initialNextRun } from "../server/chief/scheduler/schedule.js";
import { completeAwaitingScheduledRun } from "../server/chief/scheduler/resume.js";
import { MemoryTaskStore, RunStatus } from "../server/chief/scheduler/store.js";
import { runChiefTick } from "../server/chief/scheduler/tick.js";
import { MemoryAuditLog } from "../server/chief/security/audit.js";
import { createChiefTooling } from "../server/chief/tools/builtin.js";
import { CHIEF_TOOL_INVENTORY } from "../server/chief/tools/inventory.js";
import { MemoryScheduleStore, PrismaScheduleStore } from "../server/chief/tools/schedule-store.js";

const T0 = new Date("2026-09-30T12:00:00.000Z");
const RESULT_MARKER = "PHASE12_RESULT_MARKER";
const PROMPT_MARKER = "PHASE12_PROMPT_MARKER";

function textStep(text) {
  return { parts: [{ type: "text-delta", text }], text };
}

function toolStep(name, input, id = "c1") {
  return { parts: [{ type: "tool-call", toolCallId: id, toolName: name, input }] };
}

function scripted(steps) {
  let index = 0;
  return {
    async openStream() {
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      if (step.throws) throw step.throws;
      return {
        fullStream: (async function* stream() {
          for (const part of step.parts ?? []) yield part;
        })(),
        finalize: async () => ({
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          content: step.text ?? "",
          tool_calls: [],
          finish_reason: "stop",
        }),
      };
    },
  };
}

function task(fields = {}) {
  return {
    id: fields.id ?? "task-1",
    userId: fields.userId ?? "user-1",
    name: fields.name ?? "check well",
    kind: fields.kind ?? "INTERVAL",
    intervalSeconds: fields.intervalSeconds ?? 3600,
    cronExpr: fields.cronExpr ?? null,
    runAt: fields.runAt ?? null,
    payload: fields.payload ?? { prompt: PROMPT_MARKER },
    status: fields.status ?? "ACTIVE",
    nextRunAt: fields.nextRunAt === undefined ? T0 : fields.nextRunAt,
    lastRunAt: fields.lastRunAt ?? null,
    lockedAt: fields.lockedAt ?? null,
  };
}

function policy() {
  const granted = new CapabilityPolicy({ defaultDeny: true });
  granted.grant("chief", Capability.SCHEDULE_CREATE);
  granted.grant("chief", Capability.MEMORY_READ);
  return granted;
}

function world(rows = [task()]) {
  const taskStore = new MemoryTaskStore({ tasks: rows });
  const schedule = new MemoryScheduleStore({ tasks: taskStore.tasks, runs: taskStore.runs });
  const audit = new MemoryAuditLog();
  return { taskStore, schedule, audit };
}

async function tooling(schedule, granted = policy()) {
  return createChiefTooling({
    userId: "user-1",
    policy: granted,
    audit: new MemoryAuditLog(),
    stores: {
      facts: new MemoryFactStore(),
      graph: new MemoryGraphStore(),
      schedule,
    },
  });
}

test("schedule_list returns only the caller and an approval flag, without run results", async () => {
  const mine = task();
  const other = task({
    id: "task-2",
    userId: "user-2",
    name: "other",
    payload: { prompt: "other prompt" },
  });
  const { taskStore, schedule } = world([mine, other]);
  taskStore.runs.push({
    id: "run-1",
    userId: "user-1",
    scheduledTaskId: mine.id,
    sessionId: "sess-1",
    status: RunStatus.AWAITING_APPROVAL,
    result: { summary: RESULT_MARKER, attention: false },
  });
  const tools = await tooling(schedule);
  const listed = await tools.executor.execute(
    { callId: "l", name: "schedule_list", arguments: {} },
    { userId: "user-1", caller: { kind: "user_turn" } }
  );
  assert.equal(listed.isError, false);
  const body = JSON.parse(listed.output);
  assert.equal(body.tasks.length, 1);
  assert.equal(body.tasks[0].id, "task-1");
  assert.equal(body.tasks[0].name, "check well");
  assert.equal(body.tasks[0].kind, "INTERVAL");
  assert.equal(body.tasks[0].status, "ACTIVE");
  assert.equal(body.tasks[0].awaitingApproval, true);
  assert.equal(listed.output.includes(RESULT_MARKER), false);
  assert.equal(listed.output.includes(PROMPT_MARKER), false);
  assert.equal(listed.output.includes("operator"), false);
  assert.deepEqual(Object.keys(body.tasks[0]).sort(), [
    "awaitingApproval",
    "id",
    "kind",
    "lastRunAt",
    "name",
    "nextRunAt",
    "status",
  ]);
  const hidden = await tools.executor.execute(
    { callId: "l2", name: "schedule_list", arguments: {} },
    { userId: "user-2" }
  );
  assert.equal(JSON.parse(hidden.output).tasks.length, 1);
  assert.equal(JSON.parse(hidden.output).tasks[0].id, "task-2");
  assert.equal(
    tools.specs.find((spec) => spec.name === "schedule_list").requiresConfirmation,
    false
  );
});

test("pause stops future claims without moving nextRunAt or the in-flight run", async () => {
  const row = task();
  const nextRunAt = row.nextRunAt;
  const { taskStore, schedule } = world([row]);
  taskStore.runs.push({
    id: "run-1",
    userId: "user-1",
    scheduledTaskId: row.id,
    status: RunStatus.RUNNING,
    startedAt: T0,
  });
  const tools = await tooling(schedule);
  const denied = await tools.executor.execute(
    { callId: "p0", name: "schedule_pause", arguments: { taskId: row.id } },
    { userId: "user-1" }
  );
  assert.match(denied.output, /requires confirmation/);
  assert.equal(row.status, "ACTIVE");

  const paused = await tools.executor.execute(
    { callId: "p1", name: "schedule_pause", arguments: { taskId: row.id } },
    { userId: "user-1", mutationApproved: true }
  );
  assert.equal(paused.isError, false);
  assert.equal(row.status, "PAUSED");
  assert.equal(row.nextRunAt, nextRunAt);
  assert.equal(taskStore.runs[0].status, RunStatus.RUNNING);
  const again = await tools.executor.execute(
    { callId: "p2", name: "schedule_pause", arguments: { taskId: row.id } },
    { userId: "user-1", mutationApproved: true }
  );
  assert.equal(JSON.parse(again.output).status, "PAUSED");
  assert.equal(row.nextRunAt, nextRunAt);

  const report = await runChiefTick({
    taskStore,
    checkpointStore: new MemoryCheckpointStore(),
    createEngine: () => scripted([textStep("should not run")]),
    createTooling: () => tooling(schedule),
    clock: () => T0,
  });
  assert.equal(report.runs.length, 0);
  assert.equal(taskStore.runs.length, 1);
  assert.equal(row.status, "PAUSED");
});

test("resume sets ACTIVE and nextRunAt from initialNextRun and does not run a turn", async () => {
  const row = task({ status: "PAUSED", nextRunAt: null });
  const { taskStore, schedule } = world([row]);
  const resumed = await schedule.resume({ userId: "user-1", taskId: row.id, now: T0 });
  assert.equal(resumed.task.status, "ACTIVE");
  assert.equal(resumed.task.nextRunAt, initialNextRun(row, T0).toISOString());
  assert.equal(taskStore.runs.length, 0);
  assert.equal(row.status, "ACTIVE");

  const completed = task({ id: "done", status: "COMPLETED", nextRunAt: null });
  const cancelled = task({ id: "gone", status: "CANCELLED", nextRunAt: null });
  const { schedule: terminal } = world([completed, cancelled]);
  assert.equal(
    (await terminal.resume({ userId: "user-1", taskId: "done", now: T0 })).error,
    "not_resumable"
  );
  assert.equal(completed.status, "COMPLETED");
  assert.equal(
    (await terminal.resume({ userId: "user-1", taskId: "gone", now: T0 })).error,
    "not_resumable"
  );
  assert.equal(cancelled.status, "CANCELLED");

  const source = [
    readFileSync("server/chief/tools/schedule-store.js", "utf8"),
    readFileSync("server/chief/tools/builtin.js", "utf8"),
  ].join("\n");
  assert.equal(source.includes("runChiefTick"), false);
  assert.equal(source.includes("new TurnMachine"), false);
});

test("a resumed one-time task whose runAt is past is due on the next tick", async () => {
  const past = new Date("2026-09-01T00:00:00.000Z");
  const row = task({
    kind: "ONCE",
    intervalSeconds: null,
    runAt: past,
    status: "PAUSED",
    nextRunAt: null,
    payload: { prompt: "Record the well." },
  });
  const { taskStore, schedule } = world([row]);
  await schedule.resume({ userId: "user-1", taskId: row.id, now: T0 });
  assert.equal(row.status, "ACTIVE");
  assert.equal(row.nextRunAt.toISOString(), past.toISOString());
  const report = await runChiefTick({
    taskStore,
    checkpointStore: new MemoryCheckpointStore(),
    audit: new MemoryAuditLog(),
    createEngine: () => scripted([textStep("due")]),
    createTooling: ({ userId }) =>
      createChiefTooling({
        userId,
        policy: policy(),
        audit: new MemoryAuditLog(),
        stores: {
          facts: new MemoryFactStore(),
          graph: new MemoryGraphStore(),
          schedule,
        },
      }),
    clock: () => T0,
  });
  assert.equal(report.runs[0].status, RunStatus.SUCCEEDED);
  assert.equal(taskStore.runs.length, 1);
});

test("cancel keeps the row, clears nextRunAt, and leaves Phase 11 resume intact", async () => {
  const row = task();
  const { taskStore, schedule } = world([row]);
  taskStore.runs.push({
    id: "run-1",
    userId: "user-1",
    scheduledTaskId: row.id,
    sessionId: "sess-1",
    status: RunStatus.AWAITING_APPROVAL,
    result: { summary: RESULT_MARKER },
    attempts: 1,
  });
  const tools = await tooling(schedule);
  const cancelled = await tools.executor.execute(
    { callId: "x", name: "schedule_cancel", arguments: { taskId: row.id } },
    {
      userId: "user-1",
      mutationApproved: true,
      caller: { kind: "schedule", trigger: "schedule:task-1" },
    }
  );
  assert.equal(JSON.parse(cancelled.output).status, "CANCELLED");
  assert.equal(row.nextRunAt, null);
  assert.equal(taskStore.tasks.length, 1);
  assert.equal(taskStore.runs[0].status, RunStatus.AWAITING_APPROVAL);
  assert.equal(taskStore.runs[0].result.summary, RESULT_MARKER);
  const repeat = await schedule.cancel({ userId: "user-1", taskId: row.id });
  assert.equal(repeat.unchanged, true);
  assert.equal(row.status, "CANCELLED");

  const finished = await completeAwaitingScheduledRun({
    userId: "user-1",
    sessionId: "sess-1",
    taskStore,
    turnResult: {
      status: "completed",
      checkpoint: {
        transcript: [{ role: "assistant", content: "done" }],
        executionStats: { modelSteps: 1, toolCalls: 0 },
        totalUsage: { total_tokens: 2 },
      },
    },
    clock: () => T0,
  });
  assert.equal(finished.updated, true);
  assert.equal(taskStore.runs[0].status, RunStatus.SUCCEEDED);
  assert.equal(row.status, "CANCELLED");
  assert.equal(row.nextRunAt, null);

  const done = task({ id: "done", status: "COMPLETED" });
  const { schedule: terminal } = world([done]);
  assert.equal(
    (await terminal.cancel({ userId: "user-1", taskId: "done" })).error,
    "not_cancellable"
  );
  assert.equal(done.status, "COMPLETED");

  const report = await runChiefTick({
    taskStore,
    checkpointStore: new MemoryCheckpointStore(),
    createEngine: () => scripted([textStep("no")]),
    createTooling: () => tooling(schedule),
    clock: () => T0,
  });
  assert.equal(report.runs.length, 0);
});

test("a scheduled caller suspends on pause, approval writes once, and denial does not", async () => {
  const approved = task({ id: "approve-me" });
  const denied = task({ id: "deny-me", nextRunAt: new Date("2026-09-30T15:00:00.000Z") });
  const { schedule } = world([approved, denied]);
  const checkpoint = new MemoryCheckpointStore();
  const built = await tooling(schedule);
  let pauses = 0;
  const pause = schedule.pause.bind(schedule);
  schedule.pause = async (args) => {
    pauses += 1;
    return pause(args);
  };
  const steps = [toolStep("schedule_pause", { taskId: approved.id }), textStep("Paused.")];
  const engine = scripted(steps);
  const first = await new TurnMachine({
    store: checkpoint,
    engine,
    approvals: new ApprovalCoordinator(),
    toolExecutor: built.executor,
    callerKind: "schedule",
    callerTrigger: "schedule:task-1",
  }).run({
    userId: "user-1",
    submission: { id: "s1", op: { type: "message", message: { text: "pause it" } } },
    toolSpecs: built.specs,
  });
  assert.equal(first.status, "suspended");
  assert.equal(approved.status, "ACTIVE");
  assert.equal(pauses, 0);
  assert.deepEqual(first.checkpoint.approvedForSession, []);

  const second = await new TurnMachine({
    store: checkpoint,
    engine,
    approvals: new ApprovalCoordinator(),
    toolExecutor: built.executor,
    callerKind: "schedule",
    callerTrigger: "schedule:task-1",
  }).run({
    userId: "user-1",
    sessionId: first.sessionId,
    submission: {
      id: "s2",
      op: {
        type: "exec_approval",
        id: first.checkpoint.pendingApproval.id,
        decision: "approved",
      },
    },
    toolSpecs: built.specs,
  });
  assert.equal(second.status, "completed");
  assert.equal(approved.status, "PAUSED");
  assert.equal(pauses, 1);

  const denySteps = [toolStep("schedule_pause", { taskId: denied.id }, "d1"), textStep("Left it.")];
  const denyEngine = scripted(denySteps);
  const denyStore = new MemoryCheckpointStore();
  const waiting = await new TurnMachine({
    store: denyStore,
    engine: denyEngine,
    approvals: new ApprovalCoordinator(),
    toolExecutor: built.executor,
    callerKind: "schedule",
    callerTrigger: "schedule:task-1",
  }).run({
    userId: "user-1",
    submission: { id: "d1", op: { type: "message", message: { text: "pause the other" } } },
    toolSpecs: built.specs,
  });
  assert.equal(waiting.status, "suspended");
  const refused = await new TurnMachine({
    store: denyStore,
    engine: denyEngine,
    approvals: new ApprovalCoordinator(),
    toolExecutor: built.executor,
    callerKind: "schedule",
    callerTrigger: "schedule:task-1",
  }).run({
    userId: "user-1",
    sessionId: waiting.sessionId,
    submission: {
      id: "d2",
      op: {
        type: "exec_approval",
        id: waiting.checkpoint.pendingApproval.id,
        decision: { denied: { rejection: "no" } },
      },
    },
    toolSpecs: built.specs,
  });
  assert.equal(refused.status, "completed");
  assert.equal(denied.status, "ACTIVE");
  assert.equal(denied.nextRunAt.toISOString(), "2026-09-30T15:00:00.000Z");
  assert.match(JSON.stringify(refused.checkpoint.transcript), /denied: no/);
  assert.equal(pauses, 1);
});

test("another user cannot pause or cancel a task", async () => {
  const row = task();
  const { schedule } = world([row]);
  const tools = await tooling(schedule);
  const paused = await tools.executor.execute(
    { callId: "p", name: "schedule_pause", arguments: { taskId: row.id } },
    { userId: "user-2", mutationApproved: true }
  );
  assert.equal(paused.isError, true);
  assert.match(paused.output, /not found/);
  const cancelled = await tools.executor.execute(
    { callId: "x", name: "schedule_cancel", arguments: { taskId: row.id } },
    { userId: "user-2", mutationApproved: true }
  );
  assert.match(cancelled.output, /not found/);
  assert.equal(row.status, "ACTIVE");
  assert.equal(row.nextRunAt, T0);
});

test("prisma lifecycle writes are user-scoped and do not touch runs", async () => {
  const row = {
    id: "task-1",
    userId: "user-1",
    name: "check well",
    kind: "INTERVAL",
    intervalSeconds: 3600,
    cronExpr: null,
    runAt: null,
    payload: { prompt: PROMPT_MARKER },
    status: "ACTIVE",
    nextRunAt: T0,
    lastRunAt: null,
    lockedAt: new Date("2026-09-30T12:05:00.000Z"),
  };
  const updates = [];
  let seenUser = null;
  const tx = {
    chiefScheduledTask: {
      findFirst: async ({ where }) =>
        row.id === where.id && row.userId === where.userId ? row : null,
      findMany: async ({ where }) => (row.userId === where.userId ? [row] : []),
      updateMany: async (args) => {
        updates.push(args);
        if (args.where.status !== row.status && !args.where.status?.in?.includes(row.status)) {
          return { count: 0 };
        }
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
    chiefTaskRun: {
      findMany: async () => [{ scheduledTaskId: "task-1" }],
      update: async () => {
        throw new Error("lifecycle must not update a run");
      },
    },
  };
  const store = new PrismaScheduleStore({
    withUser: async (userId, fn) => {
      seenUser = userId;
      return fn(tx);
    },
  });
  const listed = await store.list({ userId: "user-1" });
  assert.equal(seenUser, "user-1");
  assert.equal(listed[0].awaitingApproval, true);
  assert.equal(JSON.stringify(listed).includes(RESULT_MARKER), false);
  assert.equal(JSON.stringify(listed).includes(PROMPT_MARKER), false);
  const paused = await store.pause({ userId: "user-1", taskId: "task-1" });
  assert.equal(paused.task.status, "PAUSED");
  assert.equal(updates.length, 1);
  assert.equal(Object.hasOwn(updates[0].data, "nextRunAt"), false);
  assert.equal(Object.hasOwn(updates[0].data, "lockedAt"), false);
  assert.equal(row.lockedAt.toISOString(), "2026-09-30T12:05:00.000Z");
  const second = await store.pause({ userId: "user-1", taskId: "task-1" });
  assert.equal(second.unchanged, true);
  assert.equal(updates.length, 1);
  const missing = await store.cancel({ userId: "user-2", taskId: "task-1" });
  assert.equal(missing.error, "not_found");
  assert.equal(row.status, "PAUSED");
});

test("finance_summary still requires finance:read and lifecycle stays quiet", async () => {
  const schedule = new MemoryScheduleStore();
  const tools = await tooling(schedule);
  const finance = tools.specs.find((spec) => spec.name === "finance_summary");
  assert.deepEqual(finance.requiredCapabilities, [Capability.FINANCE_READ]);
  assert.equal(finance.requiresConfirmation, false);
  assert.deepEqual(CHIEF_TOOL_INVENTORY.schedule_pause, [Capability.SCHEDULE_CREATE]);
  assert.equal(quietAttention({ attention: true }), false);
  const blocked = await tools.executor.execute(
    { callId: "f", name: "finance_summary", arguments: {} },
    { userId: "user-1", caller: { kind: "schedule" } }
  );
  assert.match(blocked.output, /finance:read/);
  for (const name of ["schedule_pause", "schedule_resume", "schedule_cancel"]) {
    assert.equal(tools.specs.find((spec) => spec.name === name).requiresConfirmation, true);
  }
});

test("phase 12 does not add a second loop, sender, or module 01 import", () => {
  const files = [
    "server/chief/tools/schedule-store.js",
    "server/chief/tools/builtin.js",
    "server/chief/tools/inventory.js",
    "server/chief/scheduler/tick.js",
    "server/chief/scheduler/resume.js",
  ];
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.equal(source.includes("server/agents"), false);
  assert.equal(source.includes("server/brain"), false);
  assert.equal(source.includes(".fork("), false);
  assert.equal(source.includes("Notification"), false);
  assert.equal(
    (readFileSync("server/chief/scheduler/tick.js", "utf8").match(/new TurnMachine\(/g) ?? [])
      .length,
    1
  );
  assert.equal(
    (readFileSync("server/chief/tools/builtin.js", "utf8").match(/new TurnMachine\(/g) ?? [])
      .length,
    0
  );
  assert.equal(
    readFileSync("server/chief/scheduler/tick.js", "utf8").includes("schedule_pause"),
    false
  );
  assert.equal(
    readFileSync("server/chief/scheduler/resume.js", "utf8").includes("schedule_cancel"),
    false
  );
});
