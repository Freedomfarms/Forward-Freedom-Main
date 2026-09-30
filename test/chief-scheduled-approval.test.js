// Phase 11: a scheduled turn that is waiting on approval resumes the same
// session and finishes the same ChiefTaskRun. Nothing here opens Postgres.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handleChiefApprovals } from "../api/chief/approvals.js";
import { handleChiefChat } from "../api/chief/chat.js";
import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import { MemoryFactStore } from "../server/chief/memory/facts.js";
import { MemoryGraphStore } from "../server/chief/memory/graph.js";
import { BudgetExceededError } from "../server/chief/models/budget.js";
import { ModelLayerPausedError } from "../server/chief/models/engine.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { operatorStateKey, quietAttention } from "../server/chief/scheduler/operative.js";
import { completeAwaitingScheduledRun } from "../server/chief/scheduler/resume.js";
import { MemoryTaskStore, PrismaTaskStore, RunStatus } from "../server/chief/scheduler/store.js";
import { runChiefTick } from "../server/chief/scheduler/tick.js";
import { MemoryAuditLog } from "../server/chief/security/audit.js";
import { createChiefTooling } from "../server/chief/tools/builtin.js";
import { CHIEF_TOOL_INVENTORY } from "../server/chief/tools/inventory.js";
import { MemoryScheduleStore } from "../server/chief/tools/schedule-store.js";

const T0 = new Date("2026-09-30T12:00:00.000Z");

function textStep(text) {
  return { parts: [{ type: "text-delta", text }], text };
}

function toolStep(name, input, id = "w1") {
  return { parts: [{ type: "tool-call", toolCallId: id, toolName: name, input }] };
}

function scripted(steps, calls) {
  let index = 0;
  return {
    async openStream(_messages, options) {
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      calls.push({ caller: options.caller });
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
    id: "task-1",
    userId: "user-1",
    name: "check well",
    kind: "ONCE",
    intervalSeconds: null,
    cronExpr: null,
    runAt: T0,
    payload: { prompt: "Record the well level." },
    status: "ACTIVE",
    nextRunAt: T0,
    lastRunAt: null,
    lockedAt: null,
    ...fields,
  };
}

function policy() {
  const granted = new CapabilityPolicy({ defaultDeny: true });
  granted.grant("chief", Capability.MEMORY_READ);
  granted.grant("chief", Capability.MEMORY_WRITE);
  return granted;
}

function harness({ tasks, steps, clock = () => T0 } = {}) {
  const taskStore = new MemoryTaskStore({ tasks });
  const checkpointStore = new MemoryCheckpointStore();
  const audit = new MemoryAuditLog();
  const facts = new MemoryFactStore();
  const stores = { facts, graph: new MemoryGraphStore(), schedule: new MemoryScheduleStore() };
  const engineCalls = [];
  const engine = scripted(steps, engineCalls);
  const granted = policy();
  const deps = {
    taskStore,
    checkpointStore,
    audit,
    clock,
    createEngine: () => engine,
    createTooling: ({ userId }) => createChiefTooling({ userId, policy: granted, audit, stores }),
  };
  return {
    deps,
    taskStore,
    checkpointStore,
    audit,
    facts,
    stores,
    granted,
    engine,
    engineCalls,
    tick: () => runChiefTick(deps),
  };
}

function mockResponse() {
  const chunks = [];
  const state = { statusCode: null, body: null, ended: false };
  const response = {
    headersSent: false,
    setHeader() {},
    getHeader() {},
    status(code) {
      state.statusCode = code;
      response.headersSent = true;
      return response;
    },
    json(payload) {
      state.body = payload;
      return response;
    },
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end() {
      state.ended = true;
    },
  };
  return { response, state, chunks };
}

function frames(chunks) {
  return chunks
    .join("")
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.replace(/^data: /, "")));
}

const auth = (uid) => async () => ({ uid });

function request({ method = "POST", body = {} } = {}) {
  return {
    method,
    body,
    headers: {},
    query: {},
    socket: { remoteAddress: "127.0.0.1" },
    on() {},
  };
}

function toolFacts(facts) {
  return facts.rows.filter((row) => row.source === "tool" && row.content === "well is 12 ft");
}

async function suspend(fields = {}) {
  const steps = [toolStep("memory_write", { content: "well is 12 ft" })];
  const h = harness({ tasks: [task(fields)], steps });
  const report = await h.tick();
  assert.equal(report.runs[0].status, RunStatus.AWAITING_APPROVAL);
  return { h, steps, run: h.taskStore.runs[0] };
}

function approvalDeps(h, extra = {}) {
  return {
    store: h.checkpointStore,
    engine: h.engine,
    authenticate: auth("user-1"),
    taskStore: h.taskStore,
    facts: h.facts,
    stores: h.stores,
    policy: h.granted,
    audit: h.audit,
    traceStore: null,
    clock: () => T0,
    ...extra,
  };
}

async function postApproval(h, decision, extra = {}) {
  const run = h.taskStore.runs[0];
  const session = await h.checkpointStore.load("user-1", run.sessionId);
  const http = mockResponse();
  await handleChiefApprovals(
    request({
      body: {
        session_id: run.sessionId,
        submission: {
          id: `decision-${decision && decision.denied ? "deny" : decision}`,
          op: {
            type: "exec_approval",
            id: session.checkpoint.pendingApproval?.id ?? "missing",
            decision,
          },
        },
      },
    }),
    http.response,
    approvalDeps(h, extra)
  );
  return http;
}

test("a scheduled memory_write suspends with no success result and leaves the once task active", async () => {
  const { h, run } = await suspend();
  assert.equal(run.result, null);
  assert.equal(run.completedAt, null);
  assert.equal(toolFacts(h.facts).length, 0);
  assert.equal(h.taskStore.tasks[0].status, "ACTIVE");
  assert.equal(h.taskStore.tasks[0].lockedAt, null);
  const again = await h.tick();
  assert.equal(again.runs.length, 0);
  assert.equal(h.engineCalls.length, 1);
  assert.equal(h.taskStore.runs.length, 1);
  assert.equal(h.taskStore.runs[0].status, RunStatus.AWAITING_APPROVAL);
  assert.equal(h.taskStore.tasks[0].status, "ACTIVE");
});

test("an approved memory_write runs once on the same schedule session and completes the once task", async () => {
  const { h, steps, run } = await suspend();
  const sessionId = run.sessionId;
  const nextRunAt = h.taskStore.tasks[0].nextRunAt;
  steps.push(textStep("Stored the well level."));
  let sawInventory = false;
  const http = await postApproval(h, "approved", {
    createTooling: async (options) => {
      const tooling = await createChiefTooling({
        ...options,
        policy: h.granted,
        audit: h.audit,
        stores: h.stores,
      });
      assert.equal(tooling.executor.gatesInstalled, true);
      assert.ok(
        tooling.specs.some((spec) => spec.name === "memory_write" && spec.requiresConfirmation)
      );
      assert.ok(tooling.specs.some((spec) => spec.name === "finance_summary"));
      assert.ok(tooling.specs.some((spec) => spec.name === "skill_view"));
      sawInventory = true;
      return tooling;
    },
  });
  assert.equal(sawInventory, true);
  assert.equal(http.state.statusCode, 200);
  assert.equal(http.state.body.sessionId, sessionId);
  assert.equal(http.state.body.status, "completed");
  assert.equal(http.state.body.pendingApproval, null);
  assert.equal(toolFacts(h.facts).length, 1);
  assert.equal(h.taskStore.runs[0].id, run.id);
  assert.equal(h.taskStore.runs[0].sessionId, sessionId);
  assert.equal(h.taskStore.runs[0].status, RunStatus.SUCCEEDED);
  assert.equal(h.taskStore.runs[0].result.attention, false);
  assert.equal(h.taskStore.runs[0].result.summary, "Stored the well level.");
  assert.equal(quietAttention(), false);
  const state = await h.checkpointStore.loadMiddlewareState(
    "user-1",
    sessionId,
    operatorStateKey("task-1")
  );
  assert.equal(state.summary, "Stored the well level.");
  assert.equal(h.taskStore.tasks[0].status, "COMPLETED");
  assert.equal(h.taskStore.tasks[0].nextRunAt, nextRunAt);
  assert.equal(h.engineCalls.at(-1).caller.kind, "schedule");
  assert.equal(h.engineCalls.at(-1).caller.trigger, "schedule:task-1");
  assert.equal(h.engineCalls.filter((call) => call.caller.kind !== "schedule").length, 0);
});

test("an interval task does not move nextRunAt when the approval resumes", async () => {
  const { h, steps } = await suspend({ kind: "INTERVAL", intervalSeconds: 3600 });
  const nextRunAt = h.taskStore.tasks[0].nextRunAt.toISOString();
  assert.equal(nextRunAt, "2026-09-30T13:00:00.000Z");
  assert.equal(h.taskStore.tasks[0].status, "ACTIVE");
  steps.push(textStep("Stored the well level."));
  const http = await postApproval(h, "approved");
  assert.equal(http.state.statusCode, 200);
  assert.equal(h.taskStore.runs[0].status, RunStatus.SUCCEEDED);
  assert.equal(h.taskStore.tasks[0].status, "ACTIVE");
  assert.equal(h.taskStore.tasks[0].nextRunAt.toISOString(), nextRunAt);
});

test("denial returns the synthetic error, does not run the tool, and still succeeds the turn", async () => {
  const { h, steps } = await suspend();
  steps.push(textStep("I did not store it."));
  const http = await postApproval(h, { denied: { rejection: "no" } });
  assert.equal(http.state.statusCode, 200);
  assert.equal(http.state.body.status, "completed");
  assert.equal(toolFacts(h.facts).length, 0);
  const session = await h.checkpointStore.load("user-1", h.taskStore.runs[0].sessionId);
  const denied = session.checkpoint.transcript.some((message) =>
    JSON.stringify(message).includes("denied: no")
  );
  assert.equal(denied, true);
  assert.equal(h.taskStore.runs[0].status, RunStatus.SUCCEEDED);
  assert.equal(h.taskStore.runs[0].result.attention, false);
  assert.equal(h.taskStore.tasks[0].status, "COMPLETED");
});

test("abort and a thrown resume fail the run; budget and pause skip it", async () => {
  const aborted = await suspend();
  const abortHttp = await postApproval(aborted.h, "abort");
  assert.equal(abortHttp.state.body.status, "aborted");
  assert.equal(aborted.h.taskStore.runs[0].status, RunStatus.FAILED);
  assert.equal(aborted.h.taskStore.runs[0].error, "approval_abort");
  assert.equal(toolFacts(aborted.h.facts).length, 0);
  assert.equal(aborted.h.taskStore.tasks[0].status, "COMPLETED");

  const thrown = await suspend();
  thrown.steps.push({ throws: new Error("provider down") });
  const thrownHttp = await postApproval(thrown.h, "approved");
  assert.equal(thrownHttp.state.statusCode, 400);
  assert.equal(thrown.h.taskStore.runs[0].status, RunStatus.FAILED);
  assert.match(thrown.h.taskStore.runs[0].error, /provider down/);
  assert.equal(toolFacts(thrown.h.facts).length, 0);
  assert.equal(thrown.h.taskStore.tasks[0].status, "COMPLETED");

  for (const error of [
    new BudgetExceededError("over", {
      scope: "global",
      periodType: "month",
      capUsd: 1,
      spentUsd: 1,
    }),
    new ModelLayerPausedError(),
  ]) {
    const skipped = await suspend();
    skipped.steps.push({ throws: error });
    const http = await postApproval(skipped.h, "approved");
    assert.equal(http.state.statusCode, 200);
    assert.equal(http.state.body.status, "aborted");
    assert.equal(skipped.h.taskStore.runs[0].status, RunStatus.SKIPPED);
    assert.equal(skipped.h.taskStore.tasks[0].status, "COMPLETED");
    assert.equal(skipped.h.taskStore.tasks[0].nextRunAt, null);
  }
});

test("a second confirming tool suspends the same run and leaves the once task active", async () => {
  const { h, steps, run } = await suspend();
  const nextRunAt = h.taskStore.tasks[0].nextRunAt;
  steps.push(toolStep("memory_write", { content: "second write" }, "w2"));
  const http = await postApproval(h, "approved");
  assert.equal(http.state.statusCode, 200);
  assert.equal(http.state.body.status, "suspended");
  assert.equal(http.state.body.sessionId, run.sessionId);
  assert.equal(toolFacts(h.facts).length, 1);
  assert.equal(
    h.facts.rows.some((row) => row.content === "second write"),
    false
  );
  assert.equal(h.taskStore.runs.length, 1);
  assert.equal(h.taskStore.runs[0].id, run.id);
  assert.equal(h.taskStore.runs[0].status, RunStatus.AWAITING_APPROVAL);
  assert.equal(h.taskStore.runs[0].result, null);
  assert.equal(h.taskStore.tasks[0].status, "ACTIVE");
  assert.equal(h.taskStore.tasks[0].nextRunAt, nextRunAt);
  const again = await h.tick();
  assert.equal(again.runs.length, 0);
  assert.equal(h.taskStore.runs[0].status, RunStatus.AWAITING_APPROVAL);
});

test("two approval finishes cannot both complete the run", async () => {
  const { h, run } = await suspend();
  const session = await h.checkpointStore.load("user-1", run.sessionId);
  session.checkpoint.transcript.push({ role: "assistant", content: "Stored the well level." });
  const input = {
    userId: "user-1",
    sessionId: run.sessionId,
    taskStore: h.taskStore,
    checkpointStore: h.checkpointStore,
    turnResult: { status: "completed", checkpoint: session.checkpoint },
    clock: () => T0,
  };
  const [first, second] = await Promise.all([
    completeAwaitingScheduledRun(input),
    completeAwaitingScheduledRun(input),
  ]);
  assert.equal([first, second].filter((item) => item.updated).length, 1);
  assert.equal(h.taskStore.runs[0].status, RunStatus.SUCCEEDED);
  assert.equal(h.taskStore.tasks[0].status, "COMPLETED");
  const third = await completeAwaitingScheduledRun(input);
  assert.equal(third.updated, false);
  assert.equal(h.taskStore.runs[0].status, RunStatus.SUCCEEDED);
});

test("a later approval decision does not overwrite a finished run", async () => {
  const { h, steps, run } = await suspend();
  steps.push(textStep("Stored the well level."));
  await postApproval(h, "approved");
  assert.equal(toolFacts(h.facts).length, 1);
  const again = await postApproval(h, "approved");
  assert.equal(again.state.statusCode, 200);
  assert.equal(h.taskStore.runs[0].id, run.id);
  assert.equal(h.taskStore.runs[0].status, RunStatus.SUCCEEDED);
  assert.equal(toolFacts(h.facts).length, 1);
  assert.equal(h.taskStore.tasks[0].status, "COMPLETED");
});

test("chat resume keeps the schedule caller and a normal chat does not touch a task run", async () => {
  const { h, steps, run } = await suspend();
  steps.push(textStep("Stored the well level."));
  const session = await h.checkpointStore.load("user-1", run.sessionId);
  const http = mockResponse();
  await handleChiefChat(
    request({
      body: {
        session_id: run.sessionId,
        submission: {
          id: "chat-decision",
          op: {
            type: "exec_approval",
            id: session.checkpoint.pendingApproval.id,
            decision: "approved",
          },
        },
      },
    }),
    http.response,
    approvalDeps(h)
  );
  const configured = frames(http.chunks).at(-1).msg;
  assert.equal(configured.session_id, run.sessionId);
  assert.equal(configured.status, "completed");
  assert.equal(h.taskStore.runs[0].status, RunStatus.SUCCEEDED);
  assert.equal(h.taskStore.runs[0].result.attention, false);
  assert.equal(toolFacts(h.facts).length, 1);
  assert.equal(h.engineCalls.at(-1).caller.kind, "schedule");
  assert.equal(h.engineCalls.at(-1).caller.trigger, "schedule:task-1");
  assert.equal(h.taskStore.tasks[0].status, "COMPLETED");

  const normalStore = new MemoryTaskStore();
  const normalCalls = [];
  const normal = mockResponse();
  await handleChiefChat(
    request({
      body: { submission: { id: "s1", op: { type: "message", message: { text: "hello" } } } },
    }),
    normal.response,
    {
      store: new MemoryCheckpointStore(),
      engine: scripted([textStep("hello")], normalCalls),
      authenticate: auth("user-1"),
      taskStore: normalStore,
      traceStore: null,
      toolExecutor: (
        await createChiefTooling({
          userId: "user-1",
          policy: policy(),
          audit: new MemoryAuditLog(),
          stores: {
            facts: new MemoryFactStore(),
            graph: new MemoryGraphStore(),
            schedule: new MemoryScheduleStore(),
          },
        })
      ).executor,
    }
  );
  assert.equal(frames(normal.chunks).at(-1).msg.status, "completed");
  assert.equal(normalStore.runs.length, 0);
  assert.equal(normalCalls[0].caller.kind, "user_turn");
  assert.equal(normalCalls[0].caller.trigger, "turn");
});

test("finance_summary still requires finance:read and confirming tools still suspend", async () => {
  const loaded = [];
  const tooling = await createChiefTooling({
    userId: "user-1",
    policy: policy(),
    audit: new MemoryAuditLog(),
    stores: {
      facts: new MemoryFactStore(),
      graph: new MemoryGraphStore(),
      schedule: new MemoryScheduleStore(),
    },
  });
  const finance = tooling.tools.find((tool) => tool.spec.name === "finance_summary");
  finance.execute = async () => {
    loaded.push("called");
    return { output: "should not run" };
  };
  const blocked = await tooling.executor.execute(
    { callId: "f", name: "finance_summary", arguments: {} },
    { userId: "user-1", caller: { kind: "schedule", trigger: "schedule:task-1" } }
  );
  assert.match(blocked.output, /finance:read/);
  assert.equal(blocked.isError, true);
  assert.deepEqual(loaded, []);
  assert.equal(
    tooling.specs.find((spec) => spec.name === "memory_write").requiresConfirmation,
    true
  );
  assert.equal(quietAttention({ attention: true }), false);
});

test("tooling that cannot be reconstructed does not execute the waiting tool", async () => {
  const { h } = await suspend();
  const http = await postApproval(h, "approved", {
    createTooling: async () => {
      throw new Error("inventory missing");
    },
  });
  assert.equal(http.state.statusCode, 503);
  assert.equal(h.taskStore.runs[0].status, RunStatus.AWAITING_APPROVAL);
  assert.equal(h.taskStore.tasks[0].status, "ACTIVE");
  assert.equal(toolFacts(h.facts).length, 0);
  assert.equal(h.engineCalls.length, 1);
});

test("prisma finish from AWAITING_APPROVAL is compare-and-swap and does not move nextRunAt", async () => {
  let runStatus = RunStatus.AWAITING_APPROVAL;
  const taskWrites = [];
  let seenUser = null;
  const tx = {
    chiefTaskRun: {
      findFirst: async (args) => {
        assert.equal(args.where.status, RunStatus.AWAITING_APPROVAL);
        return {
          id: "run-1",
          userId: "user-1",
          sessionId: "sess-1",
          status: RunStatus.AWAITING_APPROVAL,
          scheduledTaskId: "task-1",
        };
      },
      updateMany: async ({ where, data }) => {
        if (where.status !== runStatus) return { count: 0 };
        runStatus = data.status;
        return { count: 1 };
      },
      update: async () => {
        throw new Error("resume must not use an unconditional run update");
      },
    },
    chiefScheduledTask: {
      findFirst: async () => ({
        id: "task-1",
        userId: "user-1",
        kind: "ONCE",
        status: "ACTIVE",
        nextRunAt: null,
      }),
      updateMany: async (args) => {
        taskWrites.push(args);
        return { count: 1 };
      },
    },
  };
  const store = new PrismaTaskStore({
    withUser: async (userId, fn) => {
      seenUser = userId;
      return fn(tx);
    },
    service: () => null,
    encrypt: (value) => value,
  });
  const found = await store.findAwaitingBySession("user-1", "sess-1");
  assert.equal(seenUser, "user-1");
  assert.equal(found.run.id, "run-1");
  assert.equal(found.task.kind, "ONCE");
  const fields = {
    taskId: "task-1",
    runId: "run-1",
    result: { attention: false },
    completeTask: true,
    now: T0,
    onlyFrom: RunStatus.AWAITING_APPROVAL,
    preserveNextRunAt: true,
  };
  const first = await store.finish("user-1", { ...fields, status: RunStatus.SUCCEEDED });
  const second = await store.finish("user-1", {
    ...fields,
    status: RunStatus.FAILED,
    completeTask: true,
  });
  assert.equal(first.updated, true);
  assert.equal(second.updated, false);
  assert.equal(taskWrites.length, 1);
  assert.equal(taskWrites[0].data.status, "COMPLETED");
  assert.equal(Object.hasOwn(taskWrites[0].data, "nextRunAt"), false);
  assert.equal(runStatus, RunStatus.SUCCEEDED);
});

test("phase 11 does not add a second loop, executor, sender, or module 01 import", () => {
  const resume = readFileSync("server/chief/scheduler/resume.js", "utf8");
  const tick = readFileSync("server/chief/scheduler/tick.js", "utf8");
  const approvals = readFileSync("api/chief/approvals.js", "utf8");
  const chat = readFileSync("api/chief/chat.js", "utf8");
  const store = readFileSync("server/chief/scheduler/store.js", "utf8");
  const source = [resume, tick, approvals, chat, store].join("\n");
  assert.equal(source.includes("server/agents"), false);
  assert.equal(source.includes("server/brain"), false);
  assert.equal(source.includes(".fork("), false);
  assert.equal(source.includes("Notification"), false);
  assert.equal(source.includes("attention: true"), false);
  assert.equal((resume.match(/new TurnMachine\(/g) ?? []).length, 0);
  assert.equal((resume.match(/new ToolExecutor\(/g) ?? []).length, 0);
  assert.equal((tick.match(/new TurnMachine\(/g) ?? []).length, 1);
  assert.equal((approvals.match(/new TurnMachine\(/g) ?? []).length, 1);
  assert.equal((chat.match(/new TurnMachine\(/g) ?? []).length, 1);
  assert.equal((approvals.match(/new ToolExecutor\(/g) ?? []).length, 0);
  assert.match(approvals, /createChiefTooling/);
  assert.match(tick, /attention: quietAttention\(\)/);
  assert.equal(tick.includes("scheduler/resume.js"), false);
  assert.match(store, /onlyFrom/);
  assert.match(store, /findAwaitingBySession/);
});
