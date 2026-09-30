// Phase 9 traces. The collector watches a turn that already ran. It does not
// call the model, execute a tool, or fork a session.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import { EventBus, EventType } from "../server/chief/core/events.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { TurnMachine } from "../server/chief/runtime/turn.js";
import { MemoryTaskStore } from "../server/chief/scheduler/store.js";
import { runChiefTick } from "../server/chief/scheduler/tick.js";
import { TraceCollector, assertDetailSafe } from "../server/chief/traces/collector.js";
import { MemoryTraceStore, PrismaTraceStore } from "../server/chief/traces/store.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";
import { BaseTool } from "../server/chief/tools/spec.js";

const USER_TEXT = "user-private-note-xyz";
const TOOL_OUTPUT = "dollar-secret-42";
const ANSWER = "assistant-secret-answer";

function message(text, id = "sub-1") {
  return { id, op: { type: "message", message: { text } } };
}

function publishingEngine(bus, steps) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async openStream(_messages, options) {
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      calls.push({ caller: options.caller });
      bus.publish(EventType.INFERENCE_START, {
        model: "grok-test",
        engine: "chief",
        provider: "xai",
        query: USER_TEXT,
        caller: options.caller,
      });
      if (step.error) throw step.error;
      return {
        fullStream: (async function* stream() {
          for (const part of step.parts ?? []) yield part;
        })(),
        finalize: async () => {
          bus.publish(EventType.INFERENCE_END, {
            model: "grok-test",
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
            content: step.answer ?? ANSWER,
            tool_calls: (step.parts ?? []).filter((part) => part.type === "tool-call"),
            caller: options.caller,
          });
          return {
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
            content: step.answer ?? ANSWER,
            tool_calls: [],
            finish_reason: "stop",
          };
        },
      };
    },
  };
}

function textStep(answer = ANSWER) {
  return { parts: [{ type: "text-delta", text: answer }], answer };
}

function financeTool({ onExecute, grant = false } = {}) {
  const policy = new CapabilityPolicy({ defaultDeny: true });
  if (grant) policy.grant("chief", Capability.FINANCE_READ);
  let runs = 0;
  const tool = new BaseTool({
    isLocal: true,
    spec: {
      name: "finance_summary",
      description: "read aggregates",
      requiresConfirmation: false,
      requiredCapabilities: [Capability.FINANCE_READ],
      timeoutSeconds: 5,
      parameters: { type: "object", properties: { note: { type: "string" } } },
    },
    async execute(params) {
      runs += 1;
      onExecute?.(params);
      return { output: TOOL_OUTPUT };
    },
  });
  return {
    runs: () => runs,
    executor(bus) {
      return new ToolExecutor({ tools: [tool], policy, bus });
    },
    spec: tool.spec,
  };
}

async function runTurn({
  steps,
  text = USER_TEXT,
  tool = null,
  traceStore = new MemoryTraceStore(),
}) {
  const bus = new EventBus();
  const engine = publishingEngine(bus, steps);
  const machine = new TurnMachine({
    store: new MemoryCheckpointStore(),
    engine,
    toolExecutor: tool ? tool.executor(bus) : new ToolExecutor({ bus }),
    traceStore,
    eventBus: bus,
  });
  const result = await machine.run({
    userId: "user-1",
    submission: message(text),
    toolSpecs: tool ? [tool.spec] : [],
  });
  return { result, engine, traceStore, bus };
}

function dumped(traceStore) {
  return JSON.stringify(traceStore.traces);
}

test("one user turn writes one trace with GENERATE and RESPOND", async () => {
  const { result, engine, traceStore } = await runTurn({ steps: [textStep()] });
  assert.equal(result.status, "completed");
  assert.equal(traceStore.traces.length, 1);
  const steps = traceStore.traces[0].steps.map((step) => step.stepType);
  assert.deepEqual(steps, ["ROUTE", "GENERATE", "RESPOND"]);
  assert.equal(traceStore.traces[0].outcome, "completed");
  assert.equal(traceStore.traces[0].feedback, null);
  assert.equal(result.checkpoint.executionStats.modelSteps, 1);
  assert.equal(engine.calls.length, 1);
  assert.equal(dumped(traceStore).includes(USER_TEXT), false);
  assert.equal(dumped(traceStore).includes(ANSWER), false);
});

test("one tool call records one TOOL_CALL step and runs the body once", async () => {
  const tool = financeTool({ grant: true });
  const { result, engine, traceStore } = await runTurn({
    tool,
    steps: [
      {
        parts: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "finance_summary",
            input: { note: USER_TEXT },
          },
        ],
      },
      textStep(),
    ],
  });
  assert.equal(result.status, "completed");
  assert.equal(tool.runs(), 1);
  assert.equal(engine.calls.length, result.checkpoint.executionStats.modelSteps);
  const toolSteps = traceStore.traces[0].steps.filter((step) => step.stepType === "TOOL_CALL");
  assert.equal(toolSteps.length, 1);
  assert.equal(toolSteps[0].name, "finance_summary");
  assert.equal(toolSteps[0].detail.success, true);
  assert.equal(dumped(traceStore).includes(TOOL_OUTPUT), false);
  assert.equal(dumped(traceStore).includes(USER_TEXT), false);
  assert.equal(dumped(traceStore).includes(ANSWER), false);
});

test("a capability denial is a failed TOOL_CALL and the body does not run", async () => {
  const tool = financeTool({ grant: false });
  const { traceStore } = await runTurn({
    tool,
    steps: [
      {
        parts: [{ type: "tool-call", toolCallId: "c1", toolName: "finance_summary", input: {} }],
      },
      textStep(),
    ],
  });
  assert.equal(tool.runs(), 0);
  const toolSteps = traceStore.traces[0].steps.filter((step) => step.stepType === "TOOL_CALL");
  assert.equal(toolSteps.length, 1);
  assert.equal(toolSteps[0].detail.success, false);
  assert.equal(toolSteps[0].status, "error");
  assert.equal(dumped(traceStore).includes(TOOL_OUTPUT), false);
});

test("a trace-store failure does not change a successful turn", async () => {
  const traceStore = new MemoryTraceStore();
  traceStore.failSave = true;
  const { result, engine } = await runTurn({ steps: [textStep()], traceStore });
  assert.equal(result.status, "completed");
  assert.equal(result.checkpoint.executionStats.modelSteps, 1);
  assert.equal(engine.calls.length, 1);
  assert.equal(traceStore.traces.length, 0);
});

test("a turn failure still propagates", async () => {
  const traceStore = new MemoryTraceStore();
  const bus = new EventBus();
  const engine = publishingEngine(bus, [{ error: new Error("model blew up") }]);
  const machine = new TurnMachine({
    store: new MemoryCheckpointStore(),
    engine,
    traceStore,
    eventBus: bus,
  });
  await assert.rejects(
    () =>
      machine.run({
        userId: "user-1",
        submission: message(USER_TEXT),
      }),
    /model blew up/
  );
  assert.equal(traceStore.traces.length, 1);
  assert.equal(traceStore.traces[0].outcome, "failure");
  assert.equal(dumped(traceStore).includes(USER_TEXT), false);
});

test("a scheduled turn uses the same writer and does not add a task", async () => {
  const traceStore = new MemoryTraceStore();
  const tasks = [
    {
      id: "task-1",
      userId: "user-1",
      name: "review",
      kind: "INTERVAL",
      intervalSeconds: 3600,
      cronExpr: null,
      runAt: null,
      payload: { prompt: USER_TEXT },
      status: "ACTIVE",
      nextRunAt: new Date("2026-09-30T12:00:00.000Z"),
      lastRunAt: null,
      lockedAt: null,
    },
  ];
  const report = await runChiefTick({
    taskStore: new MemoryTaskStore({ tasks }),
    checkpointStore: new MemoryCheckpointStore(),
    traceStore,
    clock: () => new Date("2026-09-30T12:00:00.000Z"),
    createEngine: ({ eventBus }) => publishingEngine(eventBus, [textStep()]),
    createTooling: ({ eventBus }) => ({
      executor: new ToolExecutor({ bus: eventBus }),
      specs: [],
      policy: null,
    }),
  });
  assert.equal(tasks.length, 1);
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].status, "SUCCEEDED");
  assert.equal(traceStore.traces.length, 1);
  assert.equal(traceStore.traces[0].outcome, "completed");
  assert.equal(dumped(traceStore).includes(USER_TEXT), false);
  assert.equal(dumped(traceStore).includes(ANSWER), false);
});

test("prisma save is user-scoped and stores no transcript fields", async () => {
  const encrypted = [];
  let seenUser = null;
  let created = null;
  const store = new PrismaTraceStore({
    encrypt(value) {
      encrypted.push(value);
      return `cipher:${encrypted.length}`;
    },
    async withUser(userId, fn) {
      seenUser = userId;
      return fn({
        chiefTrace: {
          async create({ data }) {
            created = data;
            return { id: "trace-1", ...data };
          },
        },
      });
    },
  });
  const bus = new EventBus();
  const collector = new TraceCollector({
    bus,
    store,
    userId: "user-1",
    sessionId: "session-1",
  });
  collector.start();
  bus.publish(EventType.INFERENCE_END, {
    model: "grok-test",
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    content: ANSWER,
    caller: { id: "turn-1" },
  });
  bus.publish(EventType.TOOL_CALL_END, {
    tool: "finance_summary",
    success: true,
    result: TOOL_OUTPUT,
  });
  await collector.finish({ outcome: "completed" });
  assert.equal(seenUser, "user-1");
  assert.equal(created.feedback, null);
  assert.equal(Object.hasOwn(created, "query"), false);
  assert.equal(Object.hasOwn(created, "result"), false);
  assert.equal(Object.hasOwn(created, "messages"), false);
  assert.equal(JSON.stringify(encrypted).includes(ANSWER), false);
  assert.equal(JSON.stringify(encrypted).includes(TOOL_OUTPUT), false);
  assert.equal(JSON.stringify(created).includes(TOOL_OUTPUT), false);
  assert.equal(created.steps.create[1].detailCiphertext.startsWith("cipher:"), true);
});

test("the collector does not construct a turn, an executor, or a fork", () => {
  const source = ["server/chief/traces/collector.js", "server/chief/traces/store.js"]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  assert.equal(source.includes("new TurnMachine"), false);
  assert.equal(source.includes("new ToolExecutor"), false);
  assert.equal(source.includes(".fork("), false);
  assert.equal(source.includes("openStream"), false);
  assert.equal(source.includes("SkillExecutor"), false);
  assert.throws(() => assertDetailSafe({ query: USER_TEXT }), /cannot store 'query'/);
});
