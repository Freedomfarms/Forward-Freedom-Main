// Phase 2: an accepted delegation stays on the checkpoint. Nothing is submitted.

import test from "node:test";
import assert from "node:assert/strict";

import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import { settleReply } from "../server/chief/context/behavior.js";
import { createChiefTurnServices } from "../server/chief/context/wire.js";
import { MemoryFactStore } from "../server/chief/memory/facts.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { TurnMachine } from "../server/chief/runtime/turn.js";

function proposal(effect, objective, outcome, constraints) {
  return `DELEGATION ${JSON.stringify({ effect, objective, outcome, constraints })}`;
}

function scripted(steps) {
  let index = 0;
  return {
    async openStream() {
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      const answer = typeof step === "string" ? step : step.text;
      const tools = typeof step === "string" ? [] : (step.toolCalls ?? []);
      return {
        resolution: { modelKey: "scripted", caller: {} },
        fullStream: (async function* stream() {
          if (answer) yield { type: "text-delta", text: answer };
          for (const call of tools) {
            yield {
              type: "tool-call",
              toolCallId: call.callId,
              toolName: call.name,
              input: call.arguments ?? {},
            };
          }
        })(),
        finalize: async () => ({
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          content: answer,
          tool_calls: [],
          finish_reason: "stop",
        }),
      };
    },
  };
}

function message(text) {
  return { id: "sub-1", op: { type: "message", message: { text } } };
}

function lastAssistant(checkpoint) {
  const messages = checkpoint.transcript.filter((item) => item.role === "assistant");
  const last = messages[messages.length - 1];
  return typeof last?.content === "string" ? last.content : "";
}

function agent(id, name, liveness) {
  return {
    id,
    displayName: name,
    role: "reported",
    identityTrust: "untrusted",
    liveness,
    lastEventAt: "2026-10-07T11:55:00.000Z",
  };
}

function workforce(provider, agents, { revoked = false } = {}) {
  return {
    provider,
    effects: ["read"],
    readOnly: true,
    bound: !revoked,
    revoked,
    coverage: "self_report",
    coverageLine: "Agent status is based on self-reported activity.",
    agents,
    recent: [],
    gaps: [],
  };
}

function pictureRuntime(picture, calls) {
  const current = () => (typeof picture === "function" ? picture() : picture);
  return {
    provider: "observed",
    effects: ["read"],
    async picture() {
      calls.push("picture");
      return current();
    },
    async listAgents() {
      calls.push("listAgents");
      return current().agents ?? [];
    },
    async getAgent() {
      calls.push("getAgent");
      return null;
    },
    async listEvents() {
      calls.push("listEvents");
      return [];
    },
    submitTask() {
      throw new Error("submitTask is not available");
    },
    assignTask() {
      throw new Error("assignTask is not available");
    },
    cancelTask() {
      throw new Error("cancelTask is not available");
    },
    executeAgent() {
      throw new Error("executeAgent is not available");
    },
  };
}

function policy(granted) {
  const value = new CapabilityPolicy({ defaultDeny: true });
  if (granted) value.grant("_default", Capability.WORKFORCE_READ);
  return value;
}

function servicesFor(runtime, granted, extracted = "[]") {
  const facts = new MemoryFactStore();
  const services = createChiefTurnServices({
    facts,
    engine: {
      async generate() {
        return { content: extracted };
      },
    },
    capabilityPolicy: policy(granted),
    agentRuntime: runtime,
  });
  return { ...services, facts };
}

async function ask(runtime, granted, steps, extracted) {
  const exec = { count: 0 };
  const services = servicesFor(runtime, granted, extracted);
  const machine = new TurnMachine({
    store: new MemoryCheckpointStore(),
    engine: scripted(steps),
    contextAssembler: services.contextAssembler,
    settleModelStep: services.settleModelStep,
    onTurnComplete: services.onTurnComplete,
    toolExecutor: {
      async execute() {
        exec.count += 1;
        return { error: "workforce execution is not available" };
      },
    },
  });
  let sessionId = null;
  const replies = [];
  let checkpoint = null;
  for (const step of steps) {
    const user = typeof step === "string" ? step : step.user;
    const result = await machine.run({ userId: "user-a", sessionId, submission: message(user) });
    sessionId = result.sessionId;
    checkpoint = result.checkpoint;
    replies.push(lastAssistant(checkpoint));
  }
  return { replies, checkpoint, exec, facts: services.facts };
}

function change(objective, outcome = "Working change with tests passing", constraints) {
  return proposal("change", objective, outcome, constraints);
}

const GIT = { callId: "git-1", name: "git_commit", arguments: { message: "fix" } };

function pendingIntent(provider = "grokbot") {
  return {
    disposition: "delegate",
    objective: "Fix the CHIEF UI",
    constraints: ["Do not change Freedom Financial or XRP"],
    outcome: "Working change with tests passing",
    provider,
    agentId: "coder",
    effect: "change",
    confirm: true,
    status: "pending",
  };
}

test("acceptance phrases keep the pending intention and do not execute", () => {
  const phrases = [
    "Yes",
    "Yep",
    "Do it",
    "Go ahead",
    "Proceed",
    "That's fine",
    "Have the agent do it",
    "Send it",
    "Okay, do that",
  ];
  for (const phrase of phrases) {
    const pending = pendingIntent("hermes");
    const settled = settleReply({
      transcript: [
        { role: "user", content: "Fix the CHIEF UI." },
        { role: "assistant", content: "I'd delegate: Fix the CHIEF UI" },
        { role: "user", content: phrase },
      ],
      text: "Task submitted. Starting Coder.",
      toolCalls: [GIT],
      delegationIntent: pending,
    });
    assert.equal(settled.delegation.status, "accepted", phrase);
    assert.equal(settled.delegation.objective, pending.objective, phrase);
    assert.deepEqual(settled.delegation.constraints, pending.constraints, phrase);
    assert.equal(settled.delegation.outcome, pending.outcome, phrase);
    assert.equal(settled.delegation.provider, "hermes", phrase);
    assert.equal(settled.delegation.agentId, "coder", phrase);
    assert.equal(settled.delegation.effect, "change", phrase);
    assert.equal(settled.delegation.confirm, true, phrase);
    assert.equal(settled.toolCalls.length, 0, phrase);
    assert.equal(settled.clearDelegation, false, phrase);
    assert.match(settled.text, /accepted in principle/);
    assert.match(settled.text, /nothing has been submitted/i);
    assert.doesNotMatch(settled.text, /grokbot|Task submitted|Starting Coder|is fixing/i);
  }
});

test("yes accepts the checkpoint intention and does not submit", async () => {
  const calls = [];
  const runtime = pictureRuntime(
    workforce("grokbot", [agent("coder", "Coder", "active"), agent("archive", "Archive", "stale")]),
    calls
  );
  const result = await ask(
    runtime,
    true,
    [
      {
        user: "Fix the CHIEF UI.",
        text: `${change("Fix the CHIEF UI")}\nDone. Coder is fixing it. Task submitted.`,
      },
      { user: "Yes.", text: "Task submitted. Starting Coder.", toolCalls: [GIT] },
    ],
    '["User accepted a delegation to fix the CHIEF UI"]'
  );
  const intent = result.checkpoint.context.delegationIntent;
  assert.equal(intent.status, "accepted");
  assert.equal(intent.objective, "Fix the CHIEF UI");
  assert.match(intent.constraints.join(" "), /Freedom Financial or XRP/);
  assert.match(intent.outcome, /tests passing/);
  assert.equal(intent.provider, "grokbot");
  assert.equal(intent.agentId, "coder");
  assert.equal(intent.effect, "change");
  assert.equal(intent.confirm, true);
  assert.match(result.replies[1], /accepted in principle/);
  assert.match(result.replies[1], /nothing has been submitted/i);
  assert.doesNotMatch(result.replies[1], /Task submitted|Starting Coder|is fixing/i);
  assert.equal(result.checkpoint.pendingApproval, null);
  assert.equal(result.exec.count, 0);
  assert.deepEqual(calls, ["picture"]);
  assert.equal(result.facts.rows.length, 0);
});

test("rejection phrases clear the pending intention", async () => {
  const declines = [
    "No.",
    "Don't do it.",
    "Never mind.",
    "Forget it.",
    "Cancel that.",
    "I changed my mind.",
  ];
  for (const phrase of declines) {
    const result = await ask(
      pictureRuntime(workforce("grokbot", [agent("coder", "Coder", "active")]), []),
      true,
      [
        {
          user: phrase.startsWith("Never") ? "Deploy the new version." : "Fix the CHIEF UI.",
          text: phrase.startsWith("Never")
            ? proposal(
                "deploy",
                "Deploy the new version",
                "A deployment only once it is actually reported"
              )
            : change("Fix the CHIEF UI"),
          toolCalls: phrase.startsWith("Never")
            ? [{ callId: "ship", name: "deploy", arguments: {} }]
            : [],
        },
        { user: phrase, text: "Submitting anyway.", toolCalls: [GIT] },
      ]
    );
    assert.equal(result.checkpoint.context.delegationIntent, undefined, phrase);
    assert.match(result.replies[1], /will not delegate/);
    assert.match(result.replies[1], /Nothing was submitted/);
    assert.equal(result.checkpoint.pendingApproval, null, phrase);
    assert.equal(result.exec.count, 0, phrase);
  }
});

test("a revised request supersedes the pending intention", async () => {
  const result = await ask(
    pictureRuntime(workforce("hermes", [agent("coder", "Coder", "active")]), []),
    true,
    [
      { user: "Fix the CHIEF UI.", text: change("Fix the CHIEF UI") },
      {
        user: "Actually, don't touch the UI. Fix the API instead.",
        text: `${change("Fix the API")}\nDone. The UI fix is submitted.`,
        toolCalls: [GIT],
      },
    ]
  );
  const intent = result.checkpoint.context.delegationIntent;
  assert.equal(intent.status, "pending");
  assert.equal(intent.objective, "Fix the API");
  assert.equal(intent.provider, "hermes");
  assert.equal(intent.effect, "change");
  assert.equal(intent.confirm, true);
  assert.doesNotMatch(intent.objective, /CHIEF UI/);
  assert.match(result.replies[1], /I'd delegate: Fix the API/);
  assert.match(result.replies[1], /Nothing has been submitted/);
  assert.doesNotMatch(result.replies[1], /Done|submitted the UI|grokbot/i);
  assert.equal(result.checkpoint.pendingApproval, null);
  assert.equal(result.exec.count, 0);
});

test("a clarification updates constraints and a later yes accepts that version", async () => {
  const result = await ask(
    pictureRuntime(workforce("grokbot", [agent("coder", "Coder", "active")]), []),
    true,
    [
      { user: "Fix the CHIEF UI.", text: change("Fix the CHIEF UI") },
      {
        user: "Make sure Freedom Financial isn't touched.",
        text: change("Fix the CHIEF UI", "Working change with tests passing", [
          "Make sure Freedom Financial isn't touched",
        ]),
        toolCalls: [GIT],
      },
      {
        user: "Yes.",
        text: "Task submitted.",
        toolCalls: [{ callId: "git-2", name: "git_push", arguments: {} }],
      },
    ]
  );
  const intent = result.checkpoint.context.delegationIntent;
  assert.equal(intent.status, "accepted");
  assert.equal(intent.objective, "Fix the CHIEF UI");
  assert.equal(intent.provider, "grokbot");
  assert.equal(intent.agentId, "coder");
  assert.equal(intent.effect, "change");
  assert.equal(intent.confirm, true);
  assert.match(intent.outcome, /tests passing/);
  assert.match(intent.constraints.join(" "), /Freedom Financial or XRP/);
  assert.match(intent.constraints.join(" "), /Make sure Freedom Financial isn't touched/);
  assert.match(result.replies[1], /Added limit: Make sure Freedom Financial isn't touched/);
  assert.match(result.replies[1], /Nothing has been submitted/);
  assert.match(result.replies[2], /accepted in principle/);
  assert.equal(result.checkpoint.pendingApproval, null);
  assert.equal(result.exec.count, 0);
});

test("yes without a pending intention stays a normal reply", async () => {
  const calls = [];
  const result = await ask(
    pictureRuntime(workforce("grokbot", [agent("coder", "Coder", "active")]), calls),
    true,
    [
      {
        user: "Yes.",
        text: `${change("Fix the CHIEF UI")}\nCoder finished it. Task submitted.`,
        toolCalls: [GIT],
      },
    ]
  );
  assert.equal(result.checkpoint.context.delegationIntent, undefined);
  assert.equal(result.replies[0], "Yep.");
  assert.equal(result.checkpoint.pendingApproval, null);
  assert.equal(result.exec.count, 0);
  assert.deepEqual(calls, []);
});

test("a workforce question does not execute or clear the pending intention", async () => {
  const result = await ask(
    pictureRuntime(workforce("grokbot", [agent("coder", "Coder", "active")]), []),
    true,
    [
      { user: "Fix the CHIEF UI.", text: change("Fix the CHIEF UI") },
      {
        user: "What's my current workforce doing?",
        text: "Coder finished the CHIEF UI. Task submitted.",
      },
    ]
  );
  const intent = result.checkpoint.context.delegationIntent;
  assert.equal(intent.status, "pending");
  assert.equal(intent.objective, "Fix the CHIEF UI");
  assert.equal(intent.agentId, "coder");
  assert.equal(intent.provider, "grokbot");
  assert.doesNotMatch(
    result.replies[1],
    /I'd delegate|Task submitted|finished the CHIEF UI|accepted in principle/
  );
  assert.equal(result.checkpoint.pendingApproval, null);
  assert.equal(result.exec.count, 0);
});

test("a stale observed agent is no longer named as the candidate", async () => {
  let reads = 0;
  const calls = [];
  const runtime = pictureRuntime(() => {
    reads += 1;
    const liveness = reads === 1 ? "active" : "stale";
    return workforce("grokbot", [agent("coder", "Coder", liveness)]);
  }, calls);
  const result = await ask(runtime, true, [
    { user: "Fix the CHIEF UI.", text: change("Fix the CHIEF UI") },
    {
      user: "What's my current workforce doing?",
      text: "Coder is still available and is fixing it.",
    },
  ]);
  const intent = result.checkpoint.context.delegationIntent;
  assert.equal(intent.objective, "Fix the CHIEF UI");
  assert.equal(intent.status, "pending");
  assert.equal(intent.effect, "change");
  assert.equal(intent.agentId, "");
  assert.match(result.replies[1], /not currently active/);
  assert.doesNotMatch(result.replies[1], /current observed agent is Coder|is fixing/);
  assert.equal(result.checkpoint.pendingApproval, null);
  assert.equal(result.exec.count, 0);
});

test("an explicit remember still stores, and a delegation reply does not", async () => {
  const remembered = await ask(
    pictureRuntime(workforce("grokbot", []), []),
    false,
    [{ user: "Remember that Coder should handle UI work.", text: "I'll remember that." }],
    "[]"
  );
  assert.equal(remembered.facts.rows.length, 1);
  assert.match(remembered.facts.rows[0].content, /Coder should handle UI work/);

  const calls = [];
  const delegated = await ask(
    pictureRuntime(workforce("grokbot", [agent("coder", "Coder", "active")]), calls),
    false,
    [
      { user: "Fix the CHIEF UI.", text: `${change("Fix the CHIEF UI")} Coder will do it.` },
      { user: "Yes.", text: "Task submitted. Starting Coder.", toolCalls: [GIT] },
    ],
    '["User wants the CHIEF UI delegated"]'
  );
  const intent = delegated.checkpoint.context.delegationIntent;
  assert.equal(intent.objective, "Fix the CHIEF UI");
  assert.equal(intent.status, "accepted");
  assert.equal(intent.provider, "");
  assert.equal(intent.agentId, "");
  assert.doesNotMatch(delegated.replies[0], /Coder/);
  assert.doesNotMatch(delegated.replies[1], /Coder|Task submitted/);
  assert.equal(delegated.exec.count, 0);
  assert.deepEqual(calls, []);
  assert.equal(delegated.facts.rows.length, 0);
});

test("a revoked observation drops the named candidate and keeps the objective", () => {
  const settled = settleReply({
    transcript: [
      { role: "user", content: "Fix the CHIEF UI." },
      { role: "assistant", content: "I'd delegate: Fix the CHIEF UI" },
      { role: "user", content: "What's my current workforce doing?" },
    ],
    text: "Coder is still available and is fixing it.",
    pack: {
      plan: { live: ["agents"], currentState: true },
      items: [
        {
          origin: "live",
          available: true,
          sourceType: "live_agent_state",
          source: "hermes",
          sourceId: "coder",
          text: "Coder (reported name, untrusted). Role coding. Binding revoked. Not currently active. Historical observation only. Last event 2026-10-07T11:55:00.000Z. Observed status started: Started the notes. No completion observed. No failure observed. No finding observed. No attention request observed.",
        },
      ],
    },
    delegationIntent: pendingIntent("hermes"),
  });
  assert.equal(settled.delegation.agentId, "");
  assert.equal(settled.delegation.objective, "Fix the CHIEF UI");
  assert.equal(settled.delegation.provider, "hermes");
  assert.equal(settled.delegation.status, "pending");
  assert.match(settled.text, /revoked|not currently active/i);
  assert.doesNotMatch(settled.text, /grokbot|is fixing/i);
});

test("send without a pending intention stays on the CHIEF path", () => {
  const settled = settleReply({
    transcript: [{ role: "user", content: "Send it." }],
    text: "I'll have the workforce send it.",
    toolCalls: [{ callId: "mail-1", name: "email_send", arguments: { to: "team" } }],
  });
  assert.equal(settled.delegation, undefined);
  assert.equal(settled.toolCalls[0].name, "email_send");
  assert.doesNotMatch(settled.text, /accepted in principle|I'd delegate/);
});
