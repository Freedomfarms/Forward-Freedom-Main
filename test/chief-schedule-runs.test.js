// Phase 13 schedule_runs. A read of the caller's run ledger. It does not
// decrypt a result, deliver anything, or change a task.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import { MemoryFactStore } from "../server/chief/memory/facts.js";
import { MemoryGraphStore } from "../server/chief/memory/graph.js";
import { quietAttention } from "../server/chief/scheduler/operative.js";
import { RunStatus } from "../server/chief/scheduler/store.js";
import { MemoryAuditLog } from "../server/chief/security/audit.js";
import { createChiefTooling } from "../server/chief/tools/builtin.js";
import { CHIEF_TOOL_INVENTORY } from "../server/chief/tools/inventory.js";
import {
  MemoryScheduleStore,
  PrismaScheduleStore,
  SCHEDULE_RUN_LIST_LIMIT,
} from "../server/chief/tools/schedule-store.js";

const SUMMARY_MARKER = "PHASE13_SUMMARY_MARKER";
const PROMPT_MARKER = "PHASE13_PROMPT_MARKER";
const CIPHER_MARKER = "PHASE13_CIPHER_MARKER";
const ERROR_MARKER = "PHASE13_ERROR_MARKER";
const SESSION_MARKER = "PHASE13_SESSION_MARKER";

const RUN_FIELDS = ["attempts", "completedAt", "id", "scheduledTaskId", "startedAt", "status"];

function task(fields = {}) {
  return {
    id: fields.id ?? "task-1",
    userId: fields.userId ?? "user-1",
    name: fields.name ?? "check well",
    kind: "INTERVAL",
    intervalSeconds: 3600,
    payload: { prompt: PROMPT_MARKER },
    status: fields.status ?? "ACTIVE",
    nextRunAt: fields.nextRunAt ?? new Date("2026-09-30T12:00:00.000Z"),
    lastRunAt: null,
    lockedAt: null,
  };
}

function run(fields = {}) {
  return {
    id: fields.id ?? "run-1",
    userId: fields.userId ?? "user-1",
    scheduledTaskId: fields.scheduledTaskId ?? "task-1",
    sessionId: fields.sessionId ?? SESSION_MARKER,
    status: fields.status ?? RunStatus.SUCCEEDED,
    attempts: fields.attempts ?? 1,
    error: fields.error ?? ERROR_MARKER,
    resultCiphertext: CIPHER_MARKER,
    result: { summary: SUMMARY_MARKER, attention: false },
    startedAt: fields.startedAt ?? new Date("2026-09-30T12:00:00.000Z"),
    completedAt:
      fields.completedAt === undefined ? new Date("2026-09-30T12:01:00.000Z") : fields.completedAt,
  };
}

function policy() {
  const granted = new CapabilityPolicy({ defaultDeny: true });
  granted.grant("chief", Capability.SCHEDULE_CREATE);
  granted.grant("chief", Capability.SCHEDULE_READ);
  granted.grant("chief", Capability.MEMORY_READ);
  return granted;
}

function world(rows, runs) {
  const schedule = new MemoryScheduleStore({ tasks: rows, runs });
  return { schedule };
}

async function tooling(schedule) {
  return createChiefTooling({
    userId: "user-1",
    policy: policy(),
    audit: new MemoryAuditLog(),
    stores: {
      facts: new MemoryFactStore(),
      graph: new MemoryGraphStore(),
      schedule,
    },
  });
}

function assertLedger(output) {
  assert.equal(output.includes(SUMMARY_MARKER), false);
  assert.equal(output.includes(PROMPT_MARKER), false);
  assert.equal(output.includes(CIPHER_MARKER), false);
  assert.equal(output.includes(ERROR_MARKER), false);
  assert.equal(output.includes(SESSION_MARKER), false);
  assert.equal(output.includes("user-1"), false);
  assert.equal(output.includes("operator"), false);
  assert.equal(output.includes("resultCiphertext"), false);
}

test("schedule_runs returns only the caller's runs, newest first, capped at 10", async () => {
  assert.equal(SCHEDULE_RUN_LIST_LIMIT, 10);
  const mine = task();
  const otherTask = task({ id: "task-2", userId: "user-2", name: "other" });
  const runs = [];
  for (let i = 0; i < 11; i += 1) {
    runs.push(
      run({
        id: `run-${i}`,
        startedAt: new Date(Date.UTC(2026, 8, 30, 12, i, 0)),
        completedAt: new Date(Date.UTC(2026, 8, 30, 12, i, 30)),
      })
    );
  }
  runs.push(
    run({
      id: "run-other",
      userId: "user-2",
      scheduledTaskId: "task-2",
      startedAt: new Date("2026-09-30T18:00:00.000Z"),
    })
  );
  const { schedule } = world([mine, otherTask], runs);
  const tools = await tooling(schedule);
  const listed = await tools.executor.execute(
    { callId: "r", name: "schedule_runs", arguments: {} },
    { userId: "user-1" }
  );
  assert.equal(listed.isError, false);
  const body = JSON.parse(listed.output);
  assert.equal(body.runs.length, 10);
  assert.deepEqual(
    body.runs.map((row) => row.id),
    ["run-10", "run-9", "run-8", "run-7", "run-6", "run-5", "run-4", "run-3", "run-2", "run-1"]
  );
  assert.equal(
    body.runs.some((row) => row.id === "run-0"),
    false
  );
  assert.equal(
    body.runs.some((row) => row.id === "run-other"),
    false
  );
  assertLedger(listed.output);
  for (const row of body.runs) {
    assert.deepEqual(Object.keys(row).sort(), RUN_FIELDS);
  }

  const hidden = await tools.executor.execute(
    { callId: "r2", name: "schedule_runs", arguments: {} },
    { userId: "user-2" }
  );
  const hiddenBody = JSON.parse(hidden.output);
  assert.equal(hiddenBody.runs.length, 1);
  assert.equal(hiddenBody.runs[0].id, "run-other");
  assert.equal(hidden.output.includes("run-10"), false);
});

test("taskId filtering is owner-scoped and another user's task is not found", async () => {
  const first = task({ id: "task-a" });
  const second = task({ id: "task-b" });
  const foreign = task({ id: "task-x", userId: "user-2" });
  const runs = [
    run({
      id: "a-old",
      scheduledTaskId: "task-a",
      startedAt: new Date("2026-09-30T12:00:00.000Z"),
    }),
    run({
      id: "a-new",
      scheduledTaskId: "task-a",
      startedAt: new Date("2026-09-30T13:00:00.000Z"),
      status: RunStatus.FAILED,
    }),
    run({
      id: "b-1",
      scheduledTaskId: "task-b",
      startedAt: new Date("2026-09-30T14:00:00.000Z"),
    }),
    run({
      id: "x-1",
      userId: "user-2",
      scheduledTaskId: "task-x",
      startedAt: new Date("2026-09-30T15:00:00.000Z"),
    }),
    run({
      id: "a-foreign-user",
      userId: "user-2",
      scheduledTaskId: "task-a",
      startedAt: new Date("2026-09-30T16:00:00.000Z"),
    }),
  ];
  const { schedule } = world([first, second, foreign], runs);
  const tools = await tooling(schedule);
  const filtered = await tools.executor.execute(
    { callId: "f", name: "schedule_runs", arguments: { taskId: "  task-a  " } },
    { userId: "user-1" }
  );
  const body = JSON.parse(filtered.output);
  assert.deepEqual(
    body.runs.map((row) => row.id),
    ["a-new", "a-old"]
  );
  assert.equal(filtered.output.includes("b-1"), false);
  assert.equal(filtered.output.includes("x-1"), false);
  assert.equal(filtered.output.includes("a-foreign-user"), false);
  assertLedger(filtered.output);

  const missing = await tools.executor.execute(
    { callId: "m", name: "schedule_runs", arguments: { taskId: "task-x" } },
    { userId: "user-1" }
  );
  assert.equal(missing.isError, true);
  assert.match(missing.output, /not found/);
  assert.equal(missing.output.includes("x-1"), false);
  assert.equal(first.status, "ACTIVE");
  assert.equal(runs[0].status, RunStatus.SUCCEEDED);
});

test("stored statuses are visible and the read does not mutate or confirm", async () => {
  const row = task();
  const runs = [
    run({ id: "waiting", status: RunStatus.AWAITING_APPROVAL, completedAt: null, attempts: 1 }),
    run({
      id: "active",
      status: RunStatus.RUNNING,
      startedAt: new Date("2026-09-30T12:05:00.000Z"),
      completedAt: null,
      attempts: 2,
    }),
    run({
      id: "retry",
      status: RunStatus.RETRYING,
      startedAt: new Date("2026-09-30T12:06:00.000Z"),
      attempts: 3,
    }),
    run({
      id: "ok",
      status: RunStatus.SUCCEEDED,
      startedAt: new Date("2026-09-30T12:07:00.000Z"),
    }),
    run({
      id: "bad",
      status: RunStatus.FAILED,
      startedAt: new Date("2026-09-30T12:08:00.000Z"),
    }),
    run({
      id: "skip",
      status: RunStatus.SKIPPED,
      startedAt: new Date("2026-09-30T12:09:00.000Z"),
    }),
  ];
  const beforeTasks = JSON.stringify(row);
  const beforeRuns = JSON.stringify(runs);
  const { schedule } = world([row], runs);
  const tools = await tooling(schedule);
  const spec = tools.specs.find((item) => item.name === "schedule_runs");
  assert.equal(spec.requiresConfirmation, false);
  assert.deepEqual(spec.requiredCapabilities, [Capability.SCHEDULE_READ]);
  assert.deepEqual(CHIEF_TOOL_INVENTORY.schedule_runs, [Capability.SCHEDULE_READ]);
  const listed = await tools.executor.execute(
    { callId: "s", name: "schedule_runs", arguments: {} },
    { userId: "user-1" }
  );
  const body = JSON.parse(listed.output);
  assert.deepEqual(
    body.runs.map((item) => item.status),
    [
      RunStatus.SKIPPED,
      RunStatus.FAILED,
      RunStatus.SUCCEEDED,
      RunStatus.RETRYING,
      RunStatus.RUNNING,
      RunStatus.AWAITING_APPROVAL,
    ]
  );
  assert.equal(body.runs.find((item) => item.id === "waiting").completedAt, null);
  assertLedger(listed.output);
  assert.equal(JSON.stringify(row), beforeTasks);
  assert.equal(JSON.stringify(runs), beforeRuns);

  const finance = tools.specs.find((item) => item.name === "finance_summary");
  assert.deepEqual(finance.requiredCapabilities, [Capability.FINANCE_READ]);
  const blocked = await tools.executor.execute(
    { callId: "fin", name: "finance_summary", arguments: {} },
    { userId: "user-1", caller: { kind: "schedule" } }
  );
  assert.match(blocked.output, /finance:read/);
  assert.equal(quietAttention({ attention: true }), false);
  assert.equal(JSON.stringify(row), beforeTasks);
  assert.equal(JSON.stringify(runs), beforeRuns);
});

test("prisma listRuns selects six columns inside the caller context", async () => {
  const queries = [];
  let seenUser = null;
  const taskRow = { id: "task-1", userId: "user-1" };
  const runRow = {
    id: "run-1",
    userId: "user-1",
    scheduledTaskId: "task-1",
    sessionId: SESSION_MARKER,
    status: RunStatus.AWAITING_APPROVAL,
    attempts: 1,
    error: ERROR_MARKER,
    resultCiphertext: CIPHER_MARKER,
    startedAt: new Date("2026-09-30T12:00:00.000Z"),
    completedAt: null,
  };
  const tx = {
    chiefScheduledTask: {
      findFirst: async ({ where }) =>
        taskRow.id === where.id && taskRow.userId === where.userId ? taskRow : null,
      updateMany: async () => {
        throw new Error("listRuns must not update a task");
      },
    },
    chiefTaskRun: {
      findMany: async (args) => {
        queries.push(args);
        const selected = {};
        for (const key of Object.keys(args.select ?? {})) selected[key] = runRow[key];
        return [selected];
      },
      update: async () => {
        throw new Error("listRuns must not update a run");
      },
    },
  };
  const store = new PrismaScheduleStore({
    withUser: async (userId, fn) => {
      seenUser = userId;
      return fn(tx);
    },
  });
  const listed = await store.listRuns({ userId: "user-1", taskId: "task-1" });
  assert.equal(seenUser, "user-1");
  assert.equal(listed.runs.length, 1);
  assert.equal(listed.runs[0].status, RunStatus.AWAITING_APPROVAL);
  assert.deepEqual(Object.keys(listed.runs[0]).sort(), RUN_FIELDS);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].take, 10);
  assert.deepEqual(queries[0].where, { userId: "user-1", scheduledTaskId: "task-1" });
  assert.deepEqual(Object.keys(queries[0].select).sort(), RUN_FIELDS);
  assert.equal(JSON.stringify(listed).includes(CIPHER_MARKER), false);
  assert.equal(JSON.stringify(listed).includes(ERROR_MARKER), false);
  assert.equal(JSON.stringify(listed).includes(SESSION_MARKER), false);
  const missing = await store.listRuns({ userId: "user-2", taskId: "task-1" });
  assert.equal(missing.error, "not_found");
  assert.equal(queries.length, 1);
});

test("phase 13 does not add a second loop, sender, or module 01 import", () => {
  const files = [
    "server/chief/tools/schedule-store.js",
    "server/chief/tools/builtin.js",
    "server/chief/tools/inventory.js",
    "server/chief/scheduler/tick.js",
    "server/chief/scheduler/resume.js",
    "server/chief/scheduler/operative.js",
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
    readFileSync("server/chief/scheduler/tick.js", "utf8").includes("schedule_runs"),
    false
  );
  assert.equal(
    readFileSync("server/chief/scheduler/resume.js", "utf8").includes("schedule_runs"),
    false
  );
  assert.equal(
    readFileSync("server/chief/tools/schedule-store.js", "utf8").includes("runChiefTick"),
    false
  );
  assert.equal(
    readFileSync("server/chief/tools/builtin.js", "utf8").includes("runChiefTick"),
    false
  );
  const quiet = readFileSync("server/chief/scheduler/operative.js", "utf8");
  assert.match(quiet, /export function quietAttention\(\) \{\s*return false;\s*\}/);
});
