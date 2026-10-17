// Focused recovery regressions for classification → TurnMachine → model step
// → ToolExecutor → settlement → persisted transcript. These tests use
// scripted model streams; no provider network or authenticated browser is
// available in the test process.

import assert from "node:assert/strict";
import test from "node:test";

import { createChiefTurnServices } from "../server/chief/context/wire.js";
import { planContext } from "../server/chief/context/orchestrate.js";
import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import { EventBus } from "../server/chief/core/events.js";
import { MemoryFactStore } from "../server/chief/memory/facts.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { TurnMachine } from "../server/chief/runtime/turn.js";
import { MemoryTraceStore } from "../server/chief/traces/store.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";
import { BaseTool } from "../server/chief/tools/spec.js";

function scriptedEngine(
  steps,
  {
    defaultModel = "grok-default",
    fallbackModel = "grok-fallback",
    available = ["grok-default", "grok-fallback", "claude-active"],
  } = {}
) {
  let index = 0;
  const calls = [];
  const catalog = new Map(
    available.map((key) => [
      key,
      {
        key,
        providerId: key.startsWith("claude") ? "anthropic" : "xai",
        spec: {
          name:
            key === "grok-default"
              ? "Grok Default"
              : key === "grok-fallback"
                ? "Grok Fallback"
                : "Claude Active",
        },
      },
    ])
  );
  return {
    calls,
    config: { defaultModel, fallbackModel },
    availableModelKeys: () => [...available],
    listModels: () => [...catalog.values()],
    async openStream(messages, options) {
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      calls.push({ messages, options });
      const modelKey = step.model ?? "claude-active";
      return {
        resolution: { modelKey },
        fullStream: (async function* stream() {
          if (step.text) yield { type: "text-delta", text: step.text };
          for (const call of step.toolCalls ?? []) {
            yield {
              type: "tool-call",
              toolCallId: call.callId,
              toolName: call.name,
              input: call.arguments ?? {},
            };
          }
        })(),
        finalize: async () => ({
          model: modelKey,
          usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
          content: step.text ?? "",
          tool_calls: [],
          finish_reason: step.toolCalls?.length ? "tool-calls" : "stop",
        }),
      };
    },
  };
}

function readTool({ name, capability, output, bus, onExecute }) {
  const policy = new CapabilityPolicy({ defaultDeny: true });
  policy.grant("chief", capability);
  const tool = new BaseTool({
    isLocal: true,
    spec: {
      name,
      description: `read through ${name}`,
      requiresConfirmation: false,
      timeoutSeconds: 5,
      requiredCapabilities: [capability],
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
    async execute(params) {
      onExecute?.(params);
      return { output };
    },
  });
  return {
    executor: new ToolExecutor({ tools: [tool], policy, bus }),
    specs: [tool.spec],
  };
}

async function runTurn({
  query,
  engine,
  tooling = { executor: new ToolExecutor(), specs: [] },
  eventBus = new EventBus(),
  traceStore = null,
}) {
  const services = createChiefTurnServices({
    facts: new MemoryFactStore(),
    engine,
    eventBus,
  });
  return new TurnMachine({
    store: new MemoryCheckpointStore(),
    engine,
    toolExecutor: tooling.executor,
    contextAssembler: services.contextAssembler,
    settleModelStep: services.settleModelStep,
    eventBus,
    traceStore,
  }).run({
    userId: "user-recovery",
    submission: {
      id: `submission-${query}`,
      op: { type: "message", message: { text: query } },
    },
    toolSpecs: tooling.specs,
  });
}

test("prior defect: a self-contained savings calculation returns $7,200 without a lookup", async () => {
  const query =
    "If I set aside $400 a month starting this month, how much would I have after 18 months, ignoring interest?";
  const plan = planContext(query, { transcript: [{ role: "user", content: query }] });
  assert.deepEqual(plan.live, []);
  assert.equal(plan.currentState, false);

  let executed = 0;
  const bus = new EventBus();
  const tooling = readTool({
    name: "finance_summary",
    capability: Capability.FINANCE_READ,
    output: "should not run",
    bus,
    onExecute: () => {
      executed += 1;
    },
  });
  const traceStore = new MemoryTraceStore();
  const result = await runTurn({
    query,
    eventBus: bus,
    traceStore,
    tooling,
    engine: scriptedEngine([
      {
        text: "$400 × 18 months is $7,200.",
        toolCalls: [{ callId: "finance-1", name: "finance_summary" }],
      },
    ]),
  });
  assert.equal(executed, 0);
  assert.match(result.checkpoint.transcript.at(-1).content, /\$7,200/);
  const respond = traceStore.traces[0].steps.find((step) => step.stepType === "RESPOND");
  assert.deepEqual(respond.detail.settlementDiagnostics, [
    { reason: "tool_suppressed_self_contained_calculation", count: 1 },
  ]);
});

test("current home equity requires and uses an authorized live financial reading", async () => {
  const query = "What is my current home equity?";
  assert.deepEqual(planContext(query).live, ["finance"]);
  let executed = 0;
  const bus = new EventBus();
  const tooling = readTool({
    name: "finance_summary",
    capability: Capability.FINANCE_READ,
    output: "mortgage balance 300000; current home value 600000",
    bus,
    onExecute: () => {
      executed += 1;
    },
  });
  const result = await runTurn({
    query,
    eventBus: bus,
    tooling,
    engine: scriptedEngine([
      { toolCalls: [{ callId: "finance-1", name: "finance_summary" }] },
      { text: "Your current home equity is $300,000: $600,000 minus $300,000." },
    ]),
  });
  assert.equal(executed, 1);
  assert.match(result.checkpoint.transcript.at(-1).content, /\$300,000/);
  assert.equal(result.checkpoint.executionStats.toolCalls, 1);
});

test("default-model answers come from configured, active, and fallback runtime metadata", async () => {
  const engine = scriptedEngine(
    [{ text: "I think I am GPT." }],
    {
      defaultModel: "grok-default",
      fallbackModel: "grok-fallback",
      available: ["grok-default", "grok-fallback", "claude-active"],
    }
  );
  const traceStore = new MemoryTraceStore();
  const result = await runTurn({
    query: "What model is default for you?",
    engine,
    traceStore,
  });
  const answer = result.checkpoint.transcript.at(-1).content;
  assert.match(answer, /configured default is Grok Default \(`grok-default`\)/);
  assert.match(answer, /automatic routing/);
  assert.match(answer, /this reply is running on Claude Active \(`claude-active`\)/);
  assert.match(answer, /configured routing fallback is Grok Fallback \(`grok-fallback`\)/);
  assert.doesNotMatch(answer, /API_KEY|secret|credential/i);
  assert.doesNotMatch(answer, /I think I am GPT/);
  const respond = traceStore.traces[0].steps.find((step) => step.stepType === "RESPOND");
  assert.deepEqual(respond.detail.settlementDiagnostics, [
    { reason: "response_rewritten_model_identity", count: 1 },
  ]);
});

test("an authorized code read survives a heuristic-plan miss and its full findings are delivered", async () => {
  const query = "Walk me through why a selected operation never reaches its result.";
  assert.deepEqual(planContext(query).live, []);
  let executed = 0;
  const bus = new EventBus();
  const traceStore = new MemoryTraceStore();
  const tooling = readTool({
    name: "code_search",
    capability: Capability.CODE_READ,
    output: "settleReply filters the call before TurnMachine authorization",
    bus,
    onExecute: () => {
      executed += 1;
    },
  });
  const result = await runTurn({
    query,
    eventBus: bus,
    traceStore,
    tooling,
    engine: scriptedEngine([
      {
        text: "I will inspect the path.",
        toolCalls: [
          { callId: "code-1", name: "code_search", arguments: { query: "settleReply" } },
        ],
      },
      {
        text: [
          "### Summary",
          "TurnMachine settles model-selected calls before authorization.",
          "The classifier is now advisory for authorized reads.",
          "ToolExecutor still applies capability and approval gates.",
          "The verified finding reaches transcript delivery without truncation.",
        ].join("\n"),
      },
    ]),
  });
  const answer = result.checkpoint.transcript.at(-1).content;
  assert.equal(executed, 1);
  assert.match(answer, /TurnMachine/);
  assert.match(answer, /ToolExecutor/);
  assert.match(answer, /verified finding reaches transcript delivery/);
  const respond = traceStore.traces[0].steps.find((step) => step.stepType === "RESPOND");
  assert.deepEqual(respond.detail.settlementDiagnostics, [
    { reason: "tool_plan_mismatch_preserved", count: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(respond.detail), /selected operation|settleReply filters/);
});

test("missing current data names the specific equity inputs instead of a generic fallback", async () => {
  const result = await runTurn({
    query: "What is my current home equity?",
    engine: scriptedEngine([{ text: "Your current home equity is $300,000." }]),
  });
  const answer = result.checkpoint.transcript.at(-1).content;
  assert.match(answer, /current mortgage balance/);
  assert.match(answer, /current home value/);
  assert.doesNotMatch(answer, /\$300,000|can't verify that from a current reading/i);
});

test("a dated balance question is a finance reading, not self-contained arithmetic", async () => {
  const query = "What was my mortgage balance on 2025-10-01 and on 2026-10-01?";
  assert.deepEqual(planContext(query).live, ["finance"]);
  let executed = 0;
  const bus = new EventBus();
  const traceStore = new MemoryTraceStore();
  const tooling = readTool({
    name: "finance_summary",
    capability: Capability.FINANCE_READ,
    output: "mortgage balance 2025-10-01: 312000; mortgage balance 2026-10-01: 300000",
    bus,
    onExecute: () => {
      executed += 1;
    },
  });
  const result = await runTurn({
    query,
    eventBus: bus,
    traceStore,
    tooling,
    engine: scriptedEngine([
      { toolCalls: [{ callId: "finance-1", name: "finance_summary" }] },
      { text: "Your mortgage balance was $312,000 on 2025-10-01 and $300,000 on 2026-10-01." },
    ]),
  });
  assert.equal(executed, 1);
  assert.match(result.checkpoint.transcript.at(-1).content, /\$312,000/);
  assert.match(result.checkpoint.transcript.at(-1).content, /\$300,000/);
  const respond = traceStore.traces[0].steps.find((step) => step.stepType === "RESPOND");
  assert.doesNotMatch(
    JSON.stringify(respond.detail.settlementDiagnostics ?? []),
    /tool_suppressed_self_contained_calculation/
  );
});

test("a model recommendation question is answered by the model, not by runtime identity", async () => {
  const advice = "Which model should I use for CHIEF's reasoning?";
  const result = await runTurn({
    query: advice,
    engine: scriptedEngine([
      { text: "For long reasoning chains, a larger reasoning model is the better fit." },
    ]),
  });
  const answer = result.checkpoint.transcript.at(-1).content;
  assert.match(answer, /larger reasoning model is the better fit/);
  assert.doesNotMatch(answer, /configured default|automatic routing/);

  const identity = await runTurn({
    query: "Which model are you running right now?",
    engine: scriptedEngine([{ text: "I am GPT-4." }]),
  });
  const identityAnswer = identity.checkpoint.transcript.at(-1).content;
  assert.match(identityAnswer, /this reply is running on Claude Active \(`claude-active`\)/);
  assert.doesNotMatch(identityAnswer, /GPT-4/);
});

test("an unrelated settings read does not authorize a current balance claim", async () => {
  const query = "What is my current balance?";
  assert.deepEqual(planContext(query).live, ["finance"]);
  let executed = 0;
  const bus = new EventBus();
  const tooling = readTool({
    name: "settings_read",
    capability: Capability.SETTINGS_READ,
    output: '{"timezone":"America/Denver"}',
    bus,
    onExecute: () => {
      executed += 1;
    },
  });
  const result = await runTurn({
    query,
    eventBus: bus,
    tooling,
    engine: scriptedEngine([
      { toolCalls: [{ callId: "settings-1", name: "settings_read" }] },
      { text: "Your current balance is $84,000." },
    ]),
  });
  assert.equal(executed, 1);
  const answer = result.checkpoint.transcript.at(-1).content;
  assert.doesNotMatch(answer, /84,000/);
  assert.match(answer, /missing a current Freedom Financial balance reading/);
});

test("a denied finance read does not authorize a current balance claim", async () => {
  const query = "What is my current balance?";
  const bus = new EventBus();
  const policy = new CapabilityPolicy({ defaultDeny: true });
  const tool = new BaseTool({
    isLocal: true,
    spec: {
      name: "finance_summary",
      description: "read finance",
      requiresConfirmation: false,
      timeoutSeconds: 5,
      requiredCapabilities: [Capability.FINANCE_READ],
      parameters: { type: "object", properties: {} },
    },
    async execute() {
      return { output: "liquid cash 84000" };
    },
  });
  const result = await runTurn({
    query,
    eventBus: bus,
    tooling: { executor: new ToolExecutor({ tools: [tool], policy, bus }), specs: [tool.spec] },
    engine: scriptedEngine([
      { toolCalls: [{ callId: "finance-1", name: "finance_summary" }] },
      { text: "Your current balance is $84,000." },
    ]),
  });
  const toolMessage = result.checkpoint.transcript.find((message) => message.role === "tool");
  assert.match(toolMessage.content[0].output.value, /denied/i);
  const answer = result.checkpoint.transcript.at(-1).content;
  assert.doesNotMatch(answer, /84,000/);
  assert.match(answer, /missing a current Freedom Financial balance reading/);
});

test("an ordinary thanks suppresses tools and stores only a short reaction", async () => {
  let executed = 0;
  const bus = new EventBus();
  const tooling = readTool({
    name: "finance_summary",
    capability: Capability.FINANCE_READ,
    output: "should not run",
    bus,
    onExecute: () => {
      executed += 1;
    },
  });
  const result = await runTurn({
    query: "Thanks.",
    eventBus: bus,
    tooling,
    engine: scriptedEngine([
      {
        text: "You're welcome. I can pull your full balances.",
        toolCalls: [{ callId: "finance-1", name: "finance_summary" }],
      },
    ]),
  });
  assert.equal(executed, 0);
  assert.equal(result.checkpoint.transcript.at(-1).content, "Anytime.");
});
