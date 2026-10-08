// Phase 1: CHIEF can say what it would delegate. It cannot submit that work.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import { settleReply } from "../server/chief/context/behavior.js";
import { createChiefTurnServices } from "../server/chief/context/wire.js";
import { baselineCapabilities } from "../server/chief/control/plane.js";
import { MemoryFactStore } from "../server/chief/memory/facts.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { TurnMachine } from "../server/chief/runtime/turn.js";

function proposal(effect, objective, outcome) {
  return `DELEGATION ${JSON.stringify({ effect, objective, outcome })}`;
}

function scripted(steps, seen) {
  let index = 0;
  return {
    async openStream(messages) {
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      const answer = typeof step === "string" ? step : step.text;
      const tools = typeof step === "string" ? [] : (step.toolCalls ?? []);
      seen.push(messages.find((item) => item.role === "system")?.content ?? "");
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

function pictureRuntime(picture, calls) {
  return {
    provider: picture.provider,
    effects: ["read"],
    async picture() {
      calls.push("picture");
      return picture;
    },
    async listAgents() {
      calls.push("listAgents");
      return picture.agents ?? [];
    },
    async getAgent() {
      calls.push("getAgent");
      return null;
    },
    async listEvents() {
      calls.push("listEvents");
      return picture.recent ?? [];
    },
  };
}

function policy(granted) {
  const value = new CapabilityPolicy({ defaultDeny: true });
  if (granted) value.grant("_default", Capability.WORKFORCE_READ);
  return value;
}

function servicesFor(runtime, granted) {
  return createChiefTurnServices({
    facts: new MemoryFactStore(),
    engine: {
      async generate() {
        return { content: "[]" };
      },
    },
    capabilityPolicy: policy(granted),
    agentRuntime: runtime,
  });
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

async function ask(runtime, granted, steps) {
  const calls = [];
  const exec = { count: 0 };
  const services = servicesFor(runtime ?? pictureRuntime(workforce("grokbot", []), calls), granted);
  const machine = new TurnMachine({
    store: new MemoryCheckpointStore(),
    engine: scripted(steps, []),
    contextAssembler: services.contextAssembler,
    settleModelStep: services.settleModelStep,
    toolExecutor: {
      async execute() {
        exec.count += 1;
        return { error: "workforce execution is not available" };
      },
    },
    facts: services.memory,
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
  return { replies, checkpoint, exec, calls: runtime ? calls : [], services };
}

function line(name, { liveness = "active", revoked = false, role = "coding" } = {}) {
  if (revoked) {
    return `${name} (reported name, untrusted). Role ${role}. Binding revoked. Not currently active. Historical observation only. Last event 2026-10-07T11:55:00.000Z. Observed status started: Started the notes. No completion observed. No failure observed. No finding observed. No attention request observed.`;
  }
  return `${name} (reported name, untrusted). Role ${role}. Liveness ${liveness}. Liveness is inferred from the last event, not from a task status. Last event 2026-10-07T11:55:00.000Z. Observed status working: Still working. No completion observed. No failure observed. No finding observed. No attention request observed.`;
}

function packWith(agents, preferences = []) {
  return {
    plan: { live: ["agents"], currentState: true },
    items: [
      ...agents.map((agentLine) => ({
        origin: "live",
        available: true,
        sourceType: "live_agent_state",
        source: "hermes",
        sourceId: agentLine.id,
        text: agentLine.text,
      })),
      ...preferences.map((text) => ({
        origin: "memory",
        available: true,
        sourceType: "preference",
        scope: "preference",
        sourceId: "pref",
        text,
      })),
    ],
  };
}

test("delegation source does not special-case a provider or add a command", () => {
  const source = readFileSync(
    new URL("../server/chief/context/delegation.js", import.meta.url),
    "utf8"
  );
  assert.equal(source.includes('provider === "grokbot"'), false);
  assert.equal(source.includes("submitTask"), false);
  assert.equal(source.includes("assignTask"), false);
  assert.equal(source.includes("cancelTask"), false);
  assert.equal(source.includes("executeAgent"), false);
  assert.equal(source.includes("ApprovalCoordinator"), false);
  assert.equal(baselineCapabilities().includes(Capability.WORKFORCE_READ), false);
});

test("a repository change is an intention, and a question is not", async () => {
  const calls = [];
  const runtime = pictureRuntime(
    workforce("grokbot", [agent("coder", "Coder", "active"), agent("archive", "Archive", "stale")]),
    calls
  );
  const fix = await ask(runtime, true, [
    {
      user: "Fix the CHIEF UI.",
      text: `${proposal("change", "Fix the CHIEF UI", "Working change with tests passing")}\nDone. Coder is fixing it. Task submitted.`,
    },
  ]);
  const intent = fix.checkpoint.context.delegationIntent;
  assert.equal(intent.disposition, "delegate");
  assert.equal(intent.effect, "change");
  assert.equal(intent.confirm, true);
  assert.equal(intent.provider, "grokbot");
  assert.equal(intent.agentId, "coder");
  assert.equal(intent.objective, "Fix the CHIEF UI");
  assert.match(intent.outcome, /tests passing/);
  assert.match(intent.constraints.join(" "), /Freedom Financial or XRP/);
  assert.match(fix.replies[0], /I'd delegate: Fix the CHIEF UI/);
  assert.match(fix.replies[0], /current observed agent is Coder/);
  assert.match(fix.replies[0], /approval before execution/);
  assert.match(fix.replies[0], /Nothing has been submitted/);
  assert.doesNotMatch(fix.replies[0], /Done|Task submitted|is fixing it|grokbot/i);
  assert.equal(fix.checkpoint.pendingApproval, null);
  assert.equal(fix.exec.count, 0);
  assert.deepEqual(calls, ["picture"]);

  const question = await ask(
    pictureRuntime(workforce("grokbot", [agent("coder", "Coder", "active")]), []),
    true,
    [
      {
        user: "What's wrong with the CHIEF UI?",
        text: "The layout collapses when the panel is narrow.",
      },
    ]
  );
  assert.equal(question.checkpoint.context.delegationIntent, undefined);
  assert.match(question.replies[0], /layout collapses/);
  assert.doesNotMatch(question.replies[0], /I'd delegate|I would delegate/);
  assert.equal(question.exec.count, 0);

  const inspect = settleReply({
    transcript: [{ role: "user", content: "Inspect the CHIEF code and tell me what's wrong." }],
    text: `${proposal("read", "Explain the CHIEF UI", "An explanation")}\nThe panel state is stored in two places.`,
    toolCalls: [{ callId: "read-1", name: "code_read", arguments: { path: "src/chief" } }],
  });
  assert.equal(inspect.delegation, undefined);
  assert.equal(inspect.toolCalls[0].name, "code_read");
  assert.match(inspect.text, /stored in two places/);
  assert.doesNotMatch(inspect.text, /I'd delegate|I would delegate/);
});

test("test-and-fix and deploy are delegated intentions with confirmation", async () => {
  const runtime = pictureRuntime(workforce("grokbot", [agent("coder", "Coder", "active")]), []);
  const run = await ask(runtime, true, [
    {
      user: "Run the tests and fix whatever fails.",
      text: proposal(
        "change",
        "Run the tests and fix whatever fails",
        "Working change with tests passing"
      ),
    },
  ]);
  assert.equal(run.checkpoint.context.delegationIntent.effect, "change");
  assert.match(run.replies[0], /I'd delegate: Run the tests and fix whatever fails/);
  assert.equal(run.checkpoint.pendingApproval, null);
  assert.equal(run.exec.count, 0);

  const deploy = await ask(
    pictureRuntime(workforce("grokbot", [agent("coder", "Coder", "active")]), []),
    true,
    [
      {
        user: "Deploy the new version.",
        text: "Shipping it now. Done.",
        toolCalls: [{ callId: "deploy-1", name: "deploy", arguments: {} }],
      },
    ]
  );
  const intent = deploy.checkpoint.context.delegationIntent;
  assert.equal(intent.effect, "deploy");
  assert.equal(intent.confirm, true);
  assert.match(deploy.replies[0], /I'd delegate: Deploy the new version/);
  assert.match(deploy.replies[0], /Nothing has been submitted/);
  assert.doesNotMatch(deploy.replies[0], /Done|Shipping it now/);
  assert.equal(deploy.checkpoint.pendingApproval, null);
  assert.equal(deploy.exec.count, 0);
});

test("an external send stays on the CHIEF path", () => {
  const settled = settleReply({
    transcript: [{ role: "user", content: "Send this update to the team." }],
    text: `${proposal("external", "Send this update to the team", "The team receives it")} I'll have the workforce send it.`,
    toolCalls: [{ callId: "mail-1", name: "email_send", arguments: { to: "team" } }],
  });
  assert.equal(settled.delegation, undefined);
  assert.equal(settled.toolCalls[0].name, "email_send");
  assert.match(settled.text, /not handing it to the workforce/);
  assert.doesNotMatch(settled.text, /I'd delegate|DELEGATION/);
});

test("a workforce question is not a delegation", async () => {
  const calls = [];
  const runtime = pictureRuntime(workforce("grokbot", [agent("coder", "Coder", "active")]), calls);
  const result = await ask(runtime, true, [
    { user: "What are my GrokBots doing?", text: "Coder finished the CHIEF UI. Task submitted." },
  ]);
  assert.equal(result.checkpoint.context.delegationIntent, undefined);
  assert.doesNotMatch(result.replies[0], /I'd delegate|Task submitted|finished the CHIEF UI/);
  assert.equal(result.checkpoint.pendingApproval, null);
  assert.equal(result.exec.count, 0);
  assert.deepEqual(calls, ["picture"]);
});

test("agent selection is one eligible observed agent, or nobody", async () => {
  const one = await ask(
    pictureRuntime(
      workforce("grokbot", [
        agent("coder", "Coder", "active"),
        agent("archive", "Archive", "stale"),
      ]),
      []
    ),
    true,
    [
      {
        user: "Fix the CHIEF UI.",
        text: proposal("change", "Fix the CHIEF UI", "Working change with tests passing"),
      },
    ]
  );
  assert.equal(one.checkpoint.context.delegationIntent.agentId, "coder");

  const many = await ask(
    pictureRuntime(
      workforce("grokbot", [
        agent("coder", "Coder", "active"),
        agent("research", "Research", "active"),
      ]),
      []
    ),
    true,
    [
      {
        user: "Fix the CHIEF UI.",
        text: proposal("change", "Fix the CHIEF UI", "Working change with tests passing"),
      },
    ]
  );
  assert.equal(many.checkpoint.context.delegationIntent.agentId, "");
  assert.match(many.replies[0], /don't have a single suitable observed agent/);
  assert.doesNotMatch(many.replies[0], /observed agent is Coder/);

  const revoked = await ask(
    pictureRuntime(
      workforce("grokbot", [agent("scout", "Scout", "active")], { revoked: true }),
      []
    ),
    true,
    [
      {
        user: "Fix the notes.",
        text: proposal("change", "Fix the notes", "Working change with tests passing"),
      },
    ]
  );
  assert.equal(revoked.checkpoint.context.delegationIntent.agentId, "");
  assert.doesNotMatch(revoked.replies[0], /Scout/);

  const stale = await ask(
    pictureRuntime(workforce("grokbot", [agent("archive", "Archive", "stale")]), []),
    true,
    [
      {
        user: "Fix the archive.",
        text: proposal("change", "Fix the archive", "Working change with tests passing"),
      },
    ]
  );
  assert.equal(stale.checkpoint.context.delegationIntent.agentId, "");
  assert.doesNotMatch(stale.replies[0], /observed agent is Archive/);

  const closedCalls = [];
  const hidden = pictureRuntime(
    workforce("grokbot", [agent("coder", "Coder", "active")]),
    closedCalls
  );
  const noGrant = await ask(hidden, false, [
    {
      user: "Fix the CHIEF UI.",
      text: `${proposal("change", "Fix the CHIEF UI", "Working change with tests passing")} Coder will do it.`,
    },
  ]);
  assert.equal(noGrant.checkpoint.context.delegationIntent.agentId, "");
  assert.equal(noGrant.checkpoint.context.delegationIntent.provider, "");
  assert.match(noGrant.replies[0], /don't have a single suitable observed agent/);
  assert.doesNotMatch(noGrant.replies[0], /Coder/);
  assert.deepEqual(closedCalls, []);

  const tied = settleReply({
    transcript: [{ role: "user", content: "Fix the CHIEF UI." }],
    text: proposal("change", "Fix the CHIEF UI", "Working change with tests passing"),
    pack: packWith(
      [
        { id: "coder", text: line("Coder") },
        { id: "research", text: line("Research", { role: "research" }) },
      ],
      ["Coder should handle UI work."]
    ),
  });
  assert.equal(tied.delegation.provider, "hermes");
  assert.equal(tied.delegation.agentId, "coder");
  assert.match(tied.text, /observed agent is Coder/);
  assert.doesNotMatch(tied.text, /grokbot/i);
});

test("a relabeled provider is copied through and never treated as GrokBot", async () => {
  const result = await ask(
    pictureRuntime(workforce("hermes", [agent("coder", "Coder", "active")]), []),
    true,
    [
      {
        user: "Implement the new dashboard.",
        text: proposal(
          "change",
          "Implement the new dashboard",
          "Working change with tests passing"
        ),
      },
    ]
  );
  assert.equal(result.checkpoint.context.delegationIntent.provider, "hermes");
  assert.equal(result.checkpoint.context.delegationIntent.agentId, "coder");
  assert.doesNotMatch(result.replies[0], /grokbot/i);
  assert.match(result.replies[0], /I'd delegate: Implement the new dashboard/);
});

test("yes and no do not submit, approve, or execute", async () => {
  const calls = [];
  const runtime = pictureRuntime(workforce("grokbot", [agent("coder", "Coder", "active")]), calls);
  const accepted = await ask(runtime, true, [
    {
      user: "Debug this repository.",
      text: proposal("change", "Debug this repository", "Working change with tests passing"),
    },
    {
      user: "Yes.",
      text: "Task submitted. Starting Coder.",
      toolCalls: [{ callId: "git-1", name: "git_commit", arguments: { message: "fix" } }],
    },
  ]);
  assert.match(accepted.replies[1], /accepted in principle/);
  assert.match(accepted.replies[1], /nothing has been submitted/i);
  assert.doesNotMatch(accepted.replies[1], /Task submitted|Starting Coder/);
  assert.equal(accepted.checkpoint.context.delegationIntent.status, "accepted");
  assert.equal(accepted.checkpoint.context.delegationIntent.objective, "Debug this repository");
  assert.equal(accepted.checkpoint.context.delegationIntent.agentId, "coder");
  assert.equal(accepted.checkpoint.context.delegationIntent.provider, "grokbot");
  assert.equal(accepted.checkpoint.context.delegationIntent.effect, "change");
  assert.equal(accepted.checkpoint.context.delegationIntent.confirm, true);
  assert.equal(accepted.checkpoint.pendingApproval, null);
  assert.equal(accepted.exec.count, 0);
  assert.deepEqual(calls, ["picture"]);

  const declined = await ask(
    pictureRuntime(workforce("grokbot", [agent("coder", "Coder", "active")]), []),
    true,
    [
      {
        user: "Fix the CHIEF UI.",
        text: proposal("change", "Fix the CHIEF UI", "Working change with tests passing"),
      },
      {
        user: "No.",
        text: "Submitting anyway.",
        toolCalls: [{ callId: "git-2", name: "git_push", arguments: {} }],
      },
    ]
  );
  assert.match(declined.replies[1], /will not delegate/);
  assert.match(declined.replies[1], /Nothing was submitted/);
  assert.equal(declined.checkpoint.context.delegationIntent, undefined);
  assert.equal(declined.checkpoint.pendingApproval, null);
  assert.equal(declined.exec.count, 0);
});

test("a forbidden tool call becomes an intention and is not executed", async () => {
  const result = await ask(pictureRuntime(workforce("grokbot", []), []), true, [
    {
      user: "Fix the CHIEF UI.",
      text: "On it. Done. Task submitted.",
      toolCalls: [{ callId: "git-3", name: "git_commit", arguments: {} }],
    },
  ]);
  assert.equal(result.checkpoint.context.delegationIntent.effect, "change");
  assert.equal(result.checkpoint.context.delegationIntent.objective, "Fix the CHIEF UI.");
  assert.equal(result.checkpoint.context.delegationIntent.agentId, "");
  assert.match(result.replies[0], /I would delegate to the technical workforce: Fix the CHIEF UI/);
  assert.match(result.replies[0], /Nothing has been submitted/);
  assert.doesNotMatch(result.replies[0], /Done|Task submitted/);
  assert.equal(result.checkpoint.pendingApproval, null);
  assert.equal(result.exec.count, 0);
});
