// Turn machine — phases, suspension, resume, and the ToolExecutor boundary.
// Scripted engines cover the state machine. One test drives the real
// ChiefModelEngine.openStream path (AI SDK streamText on a mock model).

import test from "node:test";
import assert from "node:assert/strict";

import { convertArrayToReadableStream, MockLanguageModelV4, MockProviderV4 } from "ai/test";

import { EventBus, EventType } from "../server/chief/core/events.js";
import {
  ModelRegistry,
  ProviderRegistry,
  RouterPolicyRegistry,
} from "../server/chief/core/registry.js";
import { loadModelConfig } from "../server/chief/models/config.js";
import { BudgetExceededError } from "../server/chief/models/budget.js";
import { createModelEngine } from "../server/chief/models/engine.js";
import { ensureHeuristicRegistered } from "../server/chief/models/router.js";
import { CAPABILITY_RANK_KEY, createModelSpec } from "../server/chief/models/types.js";
import { ApprovalCoordinator, ApprovalPolicy } from "../server/chief/runtime/approvals.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { TurnMachine, toolSpecsToAiTools } from "../server/chief/runtime/turn.js";
import { lookupExecutor } from "./chief-tool-fixture.js";

const silentLogger = { warn: () => {}, error: () => {}, log: () => {} };

function message(text, id = "sub-1") {
  return { id, op: { type: "message", message: { text } } };
}

function textStream(text, usage = { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }) {
  return {
    fullStream: (async function* stream() {
      yield { type: "text-delta", text };
    })(),
    finalize: async () => ({ usage, content: text, tool_calls: [], finish_reason: "stop" }),
  };
}

function scriptedEngine(steps) {
  const seen = [];
  let index = 0;
  return {
    seen,
    async openStream(messages, options) {
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      seen.push({ messages, options, index });
      if (step.error) throw step.error;
      return {
        resolution: { modelKey: "scripted", caller: options.caller },
        fullStream: (async function* stream() {
          for (const part of step.parts ?? []) yield part;
        })(),
        finalize: async () => step.finalized ?? textStream("").finalize(),
      };
    },
  };
}

function machine({
  engine,
  store = new MemoryCheckpointStore(),
  toolExecutor,
  approvals,
  maxModelSteps,
  callerKind,
} = {}) {
  return new TurnMachine({
    store,
    engine,
    toolExecutor,
    approvals,
    maxModelSteps,
    callerKind,
  });
}

function types(events) {
  return events.map((event) => event.msg.type);
}

test("tool specs are declared without an execute callback", () => {
  const tools = toolSpecsToAiTools([
    { name: "lookup", description: "find", parameters: { type: "object" } },
  ]);
  assert.equal(typeof tools.lookup.execute, "undefined");
  assert.throws(
    () => toolSpecsToAiTools([{ name: "bad", execute() {} }]),
    /refusing executable tool spec 'bad'/
  );
});

test("a text turn streams deltas, completes, and stores no provider-private fields", async () => {
  const store = new MemoryCheckpointStore();
  const events = [];
  const engine = scriptedEngine([
    {
      parts: [
        { type: "reasoning-delta", text: "think" },
        { type: "text-delta", text: "Hello", providerMetadata: { leak: "no" } },
      ],
      finalized: {
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, reasoning_tokens: 1 },
        content: "Hello",
        tool_calls: [],
        finish_reason: "stop",
      },
    },
  ]);
  const result = await machine({ store, engine }).run({
    userId: "user",
    submission: message("Hi"),
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.checkpoint.activeExecution, null);
  assert.equal(result.checkpoint.transcript[1].content, "Hello");
  assert.equal(result.checkpoint.totalUsage.output_tokens, 2);
  assert.equal(result.checkpoint.totalUsage.reasoning_output_tokens, 1);
  assert.equal(JSON.stringify(result.checkpoint).includes("leak"), false);
  assert.ok(types(events).includes("assistant_content_delta"));
  assert.ok(types(events).includes("token_count"));
  assert.equal(events.at(-1).msg.type, "turn_complete");
  assert.equal(engine.seen[0].options.caller.kind, "user_turn");
});

test("tool calls go through ToolExecutor and never an AI SDK execute callback", async () => {
  const executed = [];
  const engine = scriptedEngine([
    {
      parts: [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: { q: "a" } }],
    },
    { parts: [{ type: "text-delta", text: "done" }] },
  ]);
  const result = await machine({
    engine,
    approvals: new ApprovalCoordinator(ApprovalPolicy.ALLOW),
    toolExecutor: lookupExecutor({
      onExecute: (call, context) => executed.push({ call, context }),
    }),
  }).run({ userId: "user", submission: message("find a") });
  assert.equal(result.status, "completed");
  assert.equal(executed.length, 1);
  assert.equal(executed[0].call.name, "lookup");
  assert.equal(executed[0].context.userId, "user");
  assert.equal(
    result.checkpoint.transcript.some((item) => JSON.stringify(item).includes("found")),
    true
  );
});

test("the default executor fail-closes and a stream tool-result is refused", async () => {
  const closed = await machine({
    engine: scriptedEngine([
      { parts: [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: {} }] },
      { parts: [{ type: "text-delta", text: "after" }] },
    ]),
    approvals: new ApprovalCoordinator(ApprovalPolicy.ALLOW),
  }).run({ userId: "user", submission: message("go") });
  assert.equal(closed.status, "completed");
  assert.equal(JSON.stringify(closed.checkpoint.transcript).includes("Unknown tool: lookup"), true);

  const store = new MemoryCheckpointStore();
  await assert.rejects(
    machine({
      store,
      engine: scriptedEngine([{ parts: [{ type: "tool-result", toolCallId: "c1" }] }]),
    }).run({ userId: "user", submission: message("go") }),
    /model stream executed a tool outside ToolExecutor/
  );
});

test("ask policy suspends the whole batch and an approval resumes through ToolExecutor", async () => {
  const store = new MemoryCheckpointStore();
  const executed = [];
  const engine = scriptedEngine([
    { parts: [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: { q: "a" } }] },
    { parts: [{ type: "text-delta", text: "done" }] },
  ]);
  const executor = lookupExecutor({
    onExecute: (call) => executed.push(call.callId),
    output: "ok",
  });
  const first = await machine({ store, engine, toolExecutor: executor }).run({
    userId: "user",
    submission: message("find"),
  });
  assert.equal(first.status, "suspended");
  assert.equal(first.checkpoint.pendingApproval.calls.length, 1);
  assert.equal(executed.length, 0);
  assert.equal((await store.listPending("user")).length, 1);

  const second = await machine({ store, engine, toolExecutor: executor }).run({
    userId: "user",
    sessionId: first.sessionId,
    submission: {
      id: "sub-2",
      op: { type: "exec_approval", id: first.checkpoint.pendingApproval.id, decision: "approved" },
    },
  });
  assert.equal(second.status, "completed");
  assert.deepEqual(executed, ["c1"]);
  assert.equal(second.checkpoint.pendingApproval, null);
  assert.equal(second.checkpoint.transcript.at(-1).content, "done");
});

test("approved_for_session survives onto the next invocation", async () => {
  const store = new MemoryCheckpointStore();
  const executed = [];
  const engine = scriptedEngine([
    { parts: [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: { q: "a" } }] },
    { parts: [{ type: "text-delta", text: "first" }] },
    { parts: [{ type: "tool-call", toolCallId: "c2", toolName: "lookup", input: { q: "a" } }] },
    { parts: [{ type: "text-delta", text: "second" }] },
  ]);
  const toolExecutor = lookupExecutor({
    onExecute: (call) => executed.push(call.callId),
    output: "ok",
  });
  const first = await machine({ store, engine, toolExecutor }).run({
    userId: "user",
    submission: message("find"),
  });
  const approved = await machine({ store, engine, toolExecutor }).run({
    userId: "user",
    sessionId: first.sessionId,
    submission: {
      id: "sub-2",
      op: {
        type: "exec_approval",
        id: first.checkpoint.pendingApproval.id,
        decision: "approved_for_session",
      },
    },
  });
  assert.equal(approved.status, "completed");
  assert.equal(approved.checkpoint.approvedForSession.length, 1);

  const second = await machine({ store, engine, toolExecutor }).run({
    userId: "user",
    sessionId: first.sessionId,
    submission: message("find again", "sub-3"),
  });
  assert.equal(second.status, "completed");
  assert.deepEqual(executed, ["c1", "c2"]);
  assert.equal(second.checkpoint.pendingApproval, null);
});

test("a denial becomes a synthetic error and does not call the executor", async () => {
  const store = new MemoryCheckpointStore();
  const executed = [];
  const engine = scriptedEngine([
    { parts: [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: { q: "a" } }] },
    { parts: [{ type: "text-delta", text: "noted" }] },
  ]);
  const first = await machine({
    store,
    engine,
    toolExecutor: lookupExecutor({
      onExecute: (call) => executed.push(call.callId),
    }),
  }).run({ userId: "user", submission: message("find") });

  const second = await machine({
    store,
    engine,
    toolExecutor: lookupExecutor({
      onExecute: (call) => executed.push(call.callId),
    }),
  }).run({
    userId: "user",
    sessionId: first.sessionId,
    submission: {
      id: "sub-2",
      op: {
        type: "exec_approval",
        id: first.checkpoint.pendingApproval.id,
        decision: { denied: { rejection: "no" } },
      },
    },
  });
  assert.equal(second.status, "completed");
  assert.deepEqual(executed, []);
  assert.equal(JSON.stringify(second.checkpoint.transcript).includes("denied: no"), true);
});

test("abort ends the turn and a message during approval is queued", async () => {
  const store = new MemoryCheckpointStore();
  const engine = scriptedEngine([
    { parts: [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: {} }] },
  ]);
  const first = await machine({ store, engine }).run({
    userId: "user",
    submission: message("find"),
  });
  const queued = await machine({ store, engine }).run({
    userId: "user",
    sessionId: first.sessionId,
    submission: message("also this", "sub-q"),
  });
  assert.equal(queued.status, "suspended");
  assert.equal(queued.checkpoint.pendingMessages.length, 1);
  assert.equal(queued.checkpoint.pendingApproval.id, first.checkpoint.pendingApproval.id);

  const aborted = await machine({ store, engine }).run({
    userId: "user",
    sessionId: first.sessionId,
    submission: {
      id: "sub-abort",
      op: { type: "exec_approval", id: first.checkpoint.pendingApproval.id, decision: "abort" },
    },
  });
  assert.equal(aborted.status, "aborted");
  assert.equal(aborted.checkpoint.activeExecution, null);
  assert.equal(aborted.checkpoint.pendingApproval, null);
});

test("resume_session repeats a model step that crashed after the checkpoint", async () => {
  const store = new MemoryCheckpointStore();
  let calls = 0;
  const engine = {
    async openStream() {
      calls += 1;
      if (calls === 1) throw new Error("crash-secret");
      return textStream("ok");
    },
  };
  await assert.rejects(
    machine({ store, engine }).run({ userId: "user", submission: message("Hi") }),
    /crash-secret/
  );
  const sessionId = [...store.sessions.keys()][0];
  const crashed = await store.load("user", sessionId);
  assert.equal(crashed.checkpoint.transcript.length, 1);
  assert.equal(crashed.checkpoint.activeExecution.phase, "model");

  const resumed = await machine({ store, engine }).run({
    userId: "user",
    sessionId,
    submission: { id: "sub-2", op: { type: "resume_session", session_id: sessionId } },
  });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.checkpoint.transcript.filter((item) => item.role === "user").length, 1);
  assert.equal(resumed.checkpoint.transcript.at(-1).content, "ok");
});

test("a budget refusal aborts before another model step", async () => {
  const engine = scriptedEngine([
    {
      error: new BudgetExceededError("over", {
        scope: "global",
        periodType: "month",
        capUsd: 1,
        spentUsd: 1,
      }),
    },
  ]);
  const events = [];
  const result = await machine({ engine }).run({
    userId: "user",
    submission: message("Hi"),
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.status, "aborted");
  assert.equal(result.checkpoint.activeExecution, null);
  const error = events.find((event) => event.msg.type === "error");
  assert.equal(error.msg.kind, "budget_exceeded");
  assert.equal(
    events.some((event) => event.msg.type === "turn_aborted"),
    true
  );
});

test("a schedule caller uses the same machine without starting a scheduler", async () => {
  const engine = scriptedEngine([{ parts: [{ type: "text-delta", text: "tick" }] }]);
  await machine({ engine, callerKind: "schedule" }).run({
    userId: "user",
    submission: message("operative instruction"),
  });
  assert.equal(engine.seen[0].options.caller.kind, "schedule");
  assert.equal(engine.seen[0].options.caller.trigger, "turn");
});

test("streamText through the resolved LanguageModel is the model step", async () => {
  ModelRegistry.clear();
  ProviderRegistry.clear();
  RouterPolicyRegistry.clear();
  ensureHeuristicRegistered();
  const model = new MockLanguageModelV4({
    provider: "acme",
    modelId: "acme-small",
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Hello", providerMetadata: { leak: "no" } },
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ]),
    }),
  });
  ProviderRegistry.registerValue("acme", {
    id: "acme",
    displayName: "ACME",
    packageName: "@fake/acme",
    credentialEnv: ["ACME_API_KEY"],
    create: () => new MockProviderV4({ languageModels: { "acme-small": model } }),
  });
  ModelRegistry.registerValue(
    "acme-small",
    createModelSpec({
      modelId: "acme-small",
      name: "acme-small",
      parameterCountB: 0,
      contextLength: 100000,
      supportedEngines: ["cloud"],
      provider: "acme",
      requiresApiKey: true,
      metadata: { [CAPABILITY_RANK_KEY]: 10 },
    })
  );
  const env = {
    ACME_API_KEY: "acme-key",
    CHIEF_MODEL_PROVIDERS: "acme",
    CHIEF_DEFAULT_MODEL: "acme-small",
    CHIEF_FALLBACK_MODEL: "acme-small",
    CHIEF_ROUTER_POLICY: "none",
  };
  const bus = new EventBus({ recordHistory: true });
  const engine = createModelEngine({
    env,
    config: loadModelConfig(env),
    logger: silentLogger,
    eventBus: bus,
  });
  const result = await machine({ engine }).run({
    userId: "user",
    submission: message("Hi"),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.checkpoint.transcript.at(-1).content, "Hello");
  assert.equal(JSON.stringify(result.checkpoint).includes("leak"), false);
  assert.equal(model.doStreamCalls.length, 1);
  assert.deepEqual(
    bus.history.map((event) => event.eventType),
    [EventType.INFERENCE_START, EventType.INFERENCE_END]
  );
  assert.equal(bus.history[0].data.caller.kind, "user_turn");
});

test("streamText tool calls are not executed by the AI SDK", async () => {
  ModelRegistry.clear();
  ProviderRegistry.clear();
  RouterPolicyRegistry.clear();
  ensureHeuristicRegistered();
  const usage = {
    inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const streams = [
    [
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: '{"q":"a"}' },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
    ],
    [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "done" },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ],
  ];
  let step = 0;
  const model = new MockLanguageModelV4({
    provider: "acme",
    modelId: "acme-small",
    doStream: async () => ({ stream: convertArrayToReadableStream(streams[step++]) }),
  });
  ProviderRegistry.registerValue("acme", {
    id: "acme",
    displayName: "ACME",
    packageName: "@fake/acme",
    credentialEnv: ["ACME_API_KEY"],
    create: () => new MockProviderV4({ languageModels: { "acme-small": model } }),
  });
  ModelRegistry.registerValue(
    "acme-small",
    createModelSpec({
      modelId: "acme-small",
      name: "acme-small",
      parameterCountB: 0,
      contextLength: 100000,
      supportedEngines: ["cloud"],
      provider: "acme",
      requiresApiKey: true,
      metadata: { [CAPABILITY_RANK_KEY]: 10 },
    })
  );
  const env = {
    ACME_API_KEY: "acme-key",
    CHIEF_MODEL_PROVIDERS: "acme",
    CHIEF_DEFAULT_MODEL: "acme-small",
    CHIEF_FALLBACK_MODEL: "acme-small",
    CHIEF_ROUTER_POLICY: "none",
  };
  const engine = createModelEngine({
    env,
    config: loadModelConfig(env),
    logger: silentLogger,
  });
  const executed = [];
  const result = await machine({
    engine,
    approvals: new ApprovalCoordinator(ApprovalPolicy.ALLOW),
    toolExecutor: lookupExecutor({
      requiresConfirmation: false,
      onExecute: (call) => executed.push(call),
    }),
  }).run({
    userId: "user",
    submission: message("find a"),
    toolSpecs: [
      {
        name: "lookup",
        description: "find",
        requiresConfirmation: false,
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    ],
  });
  assert.equal(result.status, "completed");
  assert.equal(executed.length, 1);
  assert.equal(executed[0].name, "lookup");
  assert.deepEqual(executed[0].arguments, { q: "a" });
  assert.equal(result.checkpoint.transcript.at(-1).content, "done");
  assert.equal(model.doStreamCalls.length, 2);
  await assert.rejects(
    engine.generate([{ role: "user", content: "Hi" }], {
      tools: { lookup: { execute: async () => "no" } },
    }),
    /must not execute inside the model call/
  );
});
