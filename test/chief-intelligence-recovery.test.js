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
  const result = await runTurn({
    query,
    eventBus: bus,
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
  const result = await runTurn({ query: "What model is default for you?", engine });
  const answer = result.checkpoint.transcript.at(-1).content;
  assert.match(answer, /configured default is Grok Default \(`grok-default`\)/);
  assert.match(answer, /automatic routing/);
  assert.match(answer, /this reply is running on Claude Active \(`claude-active`\)/);
  assert.match(answer, /configured routing fallback is Grok Fallback \(`grok-fallback`\)/);
  assert.doesNotMatch(answer, /API_KEY|secret|credential/i);
  assert.doesNotMatch(answer, /I think I am GPT/);
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
    { reason: "response_rewritten_formatting", count: 1 },
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
