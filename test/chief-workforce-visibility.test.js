// Read-only workforce visibility. The observation journal is the source of truth.
// The tool does not start, stop, edit, or remember an agent.

import test from "node:test";
import assert from "node:assert/strict";

import { settleReply } from "../server/chief/context/behavior.js";
import { orchestrateContext, planContext } from "../server/chief/context/orchestrate.js";
import {
  ANTHROPIC_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  XAI_PROVIDER_ID,
} from "../server/chief/models/providers.js";
import { toolSpecsToAiTools } from "../server/chief/runtime/turn.js";
import { createChiefTools } from "../server/chief/tools/builtin.js";
import { appendObservation, openWorkforceBinding } from "../server/chief/workforce/store.js";
import { WORKFORCE_UNAVAILABLE_LINE, readWorkforce } from "../server/chief/workforce/read.js";
import { CHIEF_STATUS } from "../src/utils/chiefProtocol.js";
import { speakCompletedReply } from "../src/utils/chiefReplySpeech.js";

const NOW = new Date("2026-10-06T15:00:00.000Z");
const encrypt = (text) => `sealed:${text}`;
const decrypt = (value) => (String(value).startsWith("sealed:") ? String(value).slice(7) : null);

function memoryTx() {
  const bindings = new Map();
  const events = new Map();
  const agents = new Map();
  let ids = 0;
  const nextId = () => `id-${++ids}`;
  const tx = {
    armed: false,
    agents,
    workforceBinding: {
      async findUnique({ where }) {
        return bindings.get(where.userId) ?? null;
      },
      async create({ data }) {
        if (tx.armed) throw new Error("workforce read must not write");
        const row = { id: nextId(), ...data };
        bindings.set(data.userId, row);
        return row;
      },
      async update({ where, data }) {
        if (tx.armed) throw new Error("workforce read must not write");
        const row = { ...bindings.get(where.userId), ...data };
        bindings.set(where.userId, row);
        return row;
      },
    },
    activityEvent: {
      async findUnique({ where }) {
        const key = where.userId_source_sourceEventId;
        return events.get(`${key.userId}|${key.source}|${key.sourceEventId}`) ?? null;
      },
      async findMany({ where } = {}) {
        return [...events.values()].filter((row) => !where?.userId || row.userId === where.userId);
      },
      async create({ data }) {
        if (tx.armed) throw new Error("workforce read must not write");
        const key = `${data.userId}|${data.source}|${data.sourceEventId}`;
        if (events.has(key)) {
          const error = new Error("unique");
          error.code = "P2002";
          throw error;
        }
        const row = { id: nextId(), ...data };
        events.set(key, row);
        return row;
      },
    },
    observedAgent: {
      async findUnique({ where }) {
        const key = where.userId_externalId;
        return agents.get(`${key.userId}|${key.externalId}`) ?? null;
      },
      async findMany({ where } = {}) {
        return [...agents.values()].filter((row) => !where?.userId || row.userId === where.userId);
      },
      async create({ data }) {
        if (tx.armed) throw new Error("workforce read must not write");
        const row = { id: nextId(), ...data };
        agents.set(`${data.userId}|${data.externalId}`, row);
        return row;
      },
      async update({ where, data }) {
        if (tx.armed) throw new Error("workforce read must not write");
        const key = `${where.userId_externalId.userId}|${where.userId_externalId.externalId}`;
        const row = { ...agents.get(key), ...data };
        agents.set(key, row);
        return row;
      },
    },
  };
  return tx;
}

function report(agentExternalId, fields) {
  return {
    source: "self_report",
    sourceEventId: `${agentExternalId}-${fields.kind}-${fields.occurredAt}`,
    agentExternalId,
    ...fields,
  };
}

async function seed(tx) {
  await openWorkforceBinding(tx, "user-1");
  await appendObservation(
    tx,
    "user-1",
    report("finance-bot", {
      kind: "freedom.report.agent",
      occurredAt: "2026-10-06T14:59:00.000Z",
      coded: { displayName: "Finance", role: "Finance" },
    }),
    { encrypt, now: NOW }
  );
  await appendObservation(
    tx,
    "user-1",
    report("finance-bot", {
      kind: "freedom.report.work",
      occurredAt: "2026-10-06T14:59:30.000Z",
      text: "Working on CHIEF UI.",
    }),
    { encrypt, now: NOW }
  );
  await appendObservation(
    tx,
    "user-1",
    report("research-bot", {
      kind: "freedom.report.agent",
      occurredAt: "2026-10-06T12:00:00.000Z",
      coded: { displayName: "Research", role: "Research" },
    }),
    { encrypt, now: NOW }
  );
  await appendObservation(
    tx,
    "user-1",
    report("research-bot", {
      kind: "freedom.report.work",
      occurredAt: "2026-10-06T13:00:00.000Z",
      text: "Waiting on sources.",
    }),
    { encrypt, now: NOW }
  );
  await appendObservation(
    tx,
    "user-1",
    report("digest-bot", {
      kind: "freedom.report.agent",
      occurredAt: "2026-10-05T17:00:00.000Z",
      coded: { displayName: "Digest", role: "Digest" },
    }),
    { encrypt, now: NOW }
  );
  await appendObservation(
    tx,
    "user-1",
    report("digest-bot", {
      kind: "freedom.report.work",
      occurredAt: "2026-10-05T18:00:00.000Z",
      coded: { outcome: "completed", task: "Finished the daily digest." },
    }),
    { encrypt, now: NOW }
  );
  await appendObservation(
    tx,
    "user-1",
    report("import-bot", {
      kind: "freedom.report.agent",
      occurredAt: "2026-10-06T14:57:00.000Z",
      coded: { displayName: "Import", role: "Imports" },
    }),
    { encrypt, now: NOW }
  );
  await appendObservation(
    tx,
    "user-1",
    report("import-bot", {
      kind: "freedom.report.work",
      occurredAt: "2026-10-06T14:58:00.000Z",
      coded: { outcome: "failed", task: "The import failed." },
    }),
    { encrypt, now: NOW }
  );
  tx.agents.set("user-1|silent", {
    id: "silent-row",
    userId: "user-1",
    externalId: "silent",
    displayName: "Silent",
    role: "Quiet",
    identityTrust: "UNTRUSTED",
    lastEventAt: null,
    liveness: "UNKNOWN",
  });
  tx.armed = true;
}

function read(tx, options = {}) {
  return readWorkforce(tx, "user-1", { decrypt, now: NOW, ...options });
}

function byId(reading, id) {
  return reading.agents.find((agent) => agent.id === id);
}

test("workforce discovery reads the journal and does not invent a schedule", async () => {
  const tx = memoryTx();
  await seed(tx);
  const summary = await read(tx);
  assert.equal(summary.connected, true);
  assert.equal(summary.writeAccess, false);
  assert.equal(summary.reason, "ok");
  assert.equal(summary.telemetry, "self_report");
  assert.match(summary.line, /self-reported activity/);
  assert.equal(summary.agents.length, 5);
  assert.equal(Object.hasOwn(summary, "schedules"), false);
  assert.equal(JSON.stringify(summary).includes("nextRun"), false);
  const finance = byId(summary, "finance-bot");
  assert.equal(finance.name, "Finance");
  assert.equal(finance.role, "Finance");
  assert.equal(finance.identityTrust, "untrusted");
  assert.equal(finance.status, "active");
  assert.equal(finance.currentWork.task, "Working on CHIEF UI.");
  assert.equal(finance.currentWork.status, "in_progress");
  assert.equal(finance.currentWork.elapsedSeconds, 30);
  assert.equal(finance.currentFailure, null);
});

test("agent selection returns one agent and a miss is not a fabricated agent", async () => {
  const tx = memoryTx();
  await seed(tx);
  const one = await read(tx, { agent: "finance" });
  assert.equal(one.agents.length, 1);
  assert.equal(one.agents[0].id, "finance-bot");
  assert.equal(one.agents[0].currentWork.task, "Working on CHIEF UI.");
  const miss = await read(tx, { agent: "payroll" });
  assert.equal(miss.connected, true);
  assert.equal(miss.reason, "no_match");
  assert.deepEqual(miss.agents, []);
  assert.match(miss.line, /No observed agent/);
});

test("current status distinguishes active, idle, stale, unknown, failed, and completed", async () => {
  const tx = memoryTx();
  await seed(tx);
  const summary = await read(tx);
  const finance = byId(summary, "finance-bot");
  const research = byId(summary, "research-bot");
  const digest = byId(summary, "digest-bot");
  const imported = byId(summary, "import-bot");
  const silent = byId(summary, "silent");
  assert.equal(finance.status, "active");
  assert.equal(finance.currentWork.status, "in_progress");
  assert.equal(research.status, "idle");
  assert.equal(research.currentWork, null);
  assert.equal(research.currentFailure, null);
  assert.equal(research.latestOutcomeCurrent, false);
  assert.equal(digest.status, "stale");
  assert.equal(digest.currentWork, null);
  assert.equal(digest.latestOutcome, "completed");
  assert.equal(digest.latestOutcomeCurrent, false);
  assert.equal(imported.status, "active");
  assert.equal(imported.currentWork, null);
  assert.equal(imported.currentFailure.task, "The import failed.");
  assert.equal(imported.latestOutcome, "failed");
  assert.equal(silent.status, "unknown");
  assert.equal(silent.activity, "none");
  assert.equal(silent.currentWork, null);
  assert.equal(silent.recentActivity.length, 0);
});

test("recent activity stays separate from yesterday's history", async () => {
  const tx = memoryTx();
  await seed(tx);
  const digest = await read(tx, {
    agent: "digest",
    since: "2026-10-05T00:00:00.000Z",
    before: "2026-10-06T00:00:00.000Z",
  });
  assert.equal(digest.agents[0].historyWindow, "bounded");
  assert.equal(digest.agents[0].currentWork, null);
  assert.equal(digest.agents[0].status, "stale");
  assert.equal(digest.agents[0].history.some((item) => item.outcome === "completed"), true);
  assert.match(digest.agents[0].history.find((item) => item.outcome === "completed").text, /digest/);

  const finance = await read(tx, {
    agent: "finance",
    since: "2026-10-05T00:00:00.000Z",
    before: "2026-10-06T00:00:00.000Z",
  });
  assert.equal(finance.agents[0].history.length, 0);
  assert.equal(finance.agents[0].currentWork.task, "Working on CHIEF UI.");
  assert.equal(finance.agents[0].recentActivity.length > 0, true);
});

test("follow-ups keep the agent subject, including schedule, history, and today", () => {
  const bots = [{ role: "user", content: "What are my Grok bots doing?" }];
  assert.deepEqual(planContext(bots[0].content, { transcript: bots }).live, ["agents"]);

  const finance = [
    ...bots,
    { role: "assistant", content: "Finance is working. Research is idle." },
    { role: "user", content: "What is the finance one working on?" },
  ];
  assert.deepEqual(planContext(finance.at(-1).content, { transcript: finance }).live, ["agents"]);

  const duration = [
    ...finance,
    { role: "assistant", content: "It is working on CHIEF UI." },
    { role: "user", content: "How long has it been working?" },
  ];
  const durationPlan = planContext(duration.at(-1).content, { transcript: duration });
  assert.deepEqual(durationPlan.live, ["agents"]);
  assert.equal(durationPlan.live.includes("web"), false);

  const scheduled = [
    ...duration,
    { role: "assistant", content: "It has been working for 30 seconds." },
    { role: "user", content: "Is any of that scheduled?" },
  ];
  const schedulePlan = planContext(scheduled.at(-1).content, { transcript: scheduled });
  assert.equal(schedulePlan.live.includes("agents"), true);
  assert.equal(schedulePlan.live.includes("schedule"), true);
  assert.equal(schedulePlan.live.includes("web"), false);
  assert.equal(schedulePlan.live.includes("finance"), false);

  const yesterday = [{ role: "user", content: "What did the finance bot finish yesterday?" }];
  const past = planContext(yesterday[0].content, { transcript: yesterday });
  assert.deepEqual(past.live, ["agents"]);
  assert.equal(past.currentState, false);
  assert.equal(past.live.includes("finance"), false);
  assert.equal(past.live.includes("web"), false);

  const today = [
    ...yesterday,
    { role: "assistant", content: "It finished the daily digest yesterday." },
    { role: "user", content: "What about today?" },
  ];
  const todayPlan = planContext(today.at(-1).content, { transcript: today });
  assert.deepEqual(todayPlan.live, ["agents"]);
  assert.equal(todayPlan.currentState, true);

  const failing = planContext("Is anything failing?");
  assert.equal(failing.live.includes("agents"), true);
  assert.equal(failing.live.includes("schedule"), true);
  assert.equal(failing.live.includes("web"), false);

  const attention = planContext("What should I pay attention to?");
  assert.equal(attention.live.includes("agents"), true);
  assert.equal(attention.live.includes("finance"), true);
  assert.equal(attention.live.includes("schedule"), true);
  assert.equal(attention.live.includes("web"), false);
  assert.equal(attention.live.includes("email"), false);
  assert.equal(attention.live.includes("calendar"), false);
});

test("an unavailable workforce source is said plainly and not filled in", async () => {
  const empty = memoryTx();
  const missing = await readWorkforce(empty, "user-1", { decrypt, now: NOW });
  assert.equal(missing.connected, false);
  assert.equal(missing.reason, "unavailable");
  assert.equal(missing.line, WORKFORCE_UNAVAILABLE_LINE);
  assert.deepEqual(missing.agents, []);

  const bound = memoryTx();
  await openWorkforceBinding(bound, "user-1");
  bound.armed = true;
  const none = await readWorkforce(bound, "user-1", { decrypt, now: NOW });
  assert.equal(none.connected, true);
  assert.equal(none.reason, "no_agents");
  assert.deepEqual(none.agents, []);
  assert.match(none.line, /No workforce activity has been observed/);

  const invented = settleReply({
    transcript: [{ role: "user", content: "What are my Grok bots doing?" }],
    text: "Your finance bot is currently working on CHIEF UI.",
    pack: {
      unavailable: ["agents"],
      items: [],
      plan: { currentState: true, memory: [] },
    },
  });
  assert.equal(invented.text, WORKFORCE_UNAVAILABLE_LINE);

  const disconnected = settleReply({
    transcript: [
      { role: "user", content: "What are my Grok bots doing?" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "workforce_status",
            output: {
              type: "text",
              value: JSON.stringify({
                connected: false,
                line: WORKFORCE_UNAVAILABLE_LINE,
                asOf: NOW.toISOString(),
              }),
            },
          },
        ],
      },
    ],
    text: "Your finance bot is currently working on CHIEF UI.",
    pack: {
      unavailable: ["agents"],
      items: [],
      plan: { currentState: true, memory: [] },
    },
  });
  assert.equal(disconnected.text, WORKFORCE_UNAVAILABLE_LINE);

  const deferred = await orchestrateContext({
    query: "What are my Grok bots doing?",
    userId: "user-1",
    availableTools: ["workforce_status"],
  });
  const unread = settleReply({
    transcript: [{ role: "user", content: "What are my Grok bots doing?" }],
    text: "Your finance bot is currently working on CHIEF UI.",
    pack: deferred,
  });
  assert.equal(unread.text, "I don't have a live agent status for that.");
});

test("a connected reading can be spoken, and a live read does not write memory", async () => {
  const tx = memoryTx();
  await seed(tx);
  const tool = createChiefTools({
    readWorkforce: (userId, options) => readWorkforce(tx, userId, { decrypt, now: NOW, ...options }),
  }).find((item) => item.spec.name === "workforce_status");
  const result = await tool.execute({ agent: "finance" }, { userId: "user-1" });
  const body = JSON.parse(result.output);
  assert.equal(result.isError, false);
  assert.equal(body.writeAccess, false);
  assert.equal(body.agents[0].currentWork.task, "Working on CHIEF UI.");

  const transcript = [
    { role: "user", content: "What is the finance bot doing?" },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolName: "workforce_status",
          output: { type: "text", value: result.output },
        },
      ],
    },
  ];
  const settled = settleReply({
    transcript,
    text: "Finance is working on CHIEF UI.",
    pack: {
      unavailable: ["agents"],
      items: [],
      plan: { currentState: true, memory: ["agent"] },
    },
  });
  assert.match(settled.text, /CHIEF UI/);
  const voice = { calls: [], speakAnswer(text) { this.calls.push(text); } };
  const spoken = speakCompletedReply(voice, {
    streamText: settled.text,
    finished: true,
    status: CHIEF_STATUS.READY,
  });
  assert.equal(spoken, settled.text);
  assert.deepEqual(voice.calls, [settled.text]);

  const unavailableVoice = speakCompletedReply(
    { speakAnswer() {} },
    {
      streamText: WORKFORCE_UNAVAILABLE_LINE,
      finished: true,
      status: CHIEF_STATUS.READY,
    }
  );
  assert.equal(unavailableVoice, WORKFORCE_UNAVAILABLE_LINE);

  const writes = { count: 0 };
  await orchestrateContext({
    query: "What are my Grok bots doing?",
    userId: "user-1",
    memory: {
      async search() {
        return [{ text: "The finance bot is working on CHIEF UI.", layer: "PERSONAL" }];
      },
      remember() {
        writes.count += 1;
      },
    },
    readers: {
      agents: async () => [{ text: "Finance is working on CHIEF UI.", sourceId: "finance-bot" }],
    },
  });
  assert.equal(writes.count, 0);
  await tool.execute({}, { userId: "user-1" });
  assert.equal(writes.count, 0);
});

test("providers share the read-only workforce tool and cannot mutate agents", () => {
  const tools = createChiefTools({
    readWorkforce: async () => ({
      connected: false,
      agents: [],
      writeAccess: false,
      line: WORKFORCE_UNAVAILABLE_LINE,
    }),
  });
  const names = tools.map((tool) => tool.spec.name);
  assert.equal(names.includes("workforce_status"), true);
  for (const forbidden of [
    "start_agent",
    "stop_agent",
    "restart_agent",
    "edit_agent",
    "agent_command",
    "schedule_agent",
  ]) {
    assert.equal(names.includes(forbidden), false);
  }
  const spec = tools.find((tool) => tool.spec.name === "workforce_status").spec;
  assert.equal(spec.effect, "read");
  assert.equal(spec.requiresConfirmation, false);
  assert.equal(spec.confirmation, "none");
  assert.deepEqual(spec.requiredCapabilities, ["workforce:read"]);
  assert.equal(spec.parameters.additionalProperties, false);
  assert.match(spec.description, /Does not start, stop, edit/);
  const surfaces = [XAI_PROVIDER_ID, ANTHROPIC_PROVIDER_ID, OPENAI_PROVIDER_ID].map(() =>
    Object.keys(toolSpecsToAiTools(tools.map((tool) => tool.spec))).sort()
  );
  assert.deepEqual(surfaces[0], surfaces[1]);
  assert.deepEqual(surfaces[1], surfaces[2]);
  assert.equal(surfaces[0].includes("workforce_status"), true);
  const plans = [XAI_PROVIDER_ID, ANTHROPIC_PROVIDER_ID, OPENAI_PROVIDER_ID].map((provider) =>
    JSON.stringify(planContext("What are my agents doing?", { provider }))
  );
  assert.equal(plans[0], plans[1]);
  assert.equal(plans[1], plans[2]);
  assert.equal(JSON.parse(plans[0]).live.includes("agents"), true);
  assert.equal(JSON.parse(plans[0]).live.includes("web"), false);
});
