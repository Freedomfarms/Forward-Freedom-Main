// Real self-report path into a CHIEF turn.
// The Grok Bot provider reads the journal. The model is scripted so a false
// answer has to be corrected by the turn. Platform telemetry is not invented.

import test from "node:test";
import assert from "node:assert/strict";

import { createAgentRuntime } from "../server/chief/agents/index.js";
import { createGrokBotRuntime } from "../server/chief/agents/grokbot.js";
import { Capability } from "../server/chief/core/capabilities.js";
import { orchestrateContext } from "../server/chief/context/orchestrate.js";
import { createChiefTurnServices } from "../server/chief/context/wire.js";
import { baselineCapabilities } from "../server/chief/control/plane.js";
import { MemoryFactStore } from "../server/chief/memory/facts.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { TurnMachine } from "../server/chief/runtime/turn.js";
import { loadCapabilityPolicy, saveCapabilityGrant } from "../server/chief/security/grants.js";
import {
  handleWorkforceReport,
  handleWorkforceReportKey,
} from "../server/chief/workforce/reportRoute.js";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const encrypt = (text) => `sealed:${text}`;
const allow = async () => true;

function memoryJournal() {
  const bindings = new Map();
  const events = new Map();
  const agents = new Map();
  let ids = 0;
  const nextId = () => `id-${++ids}`;
  return {
    bindings,
    events,
    agents,
    workforceBinding: {
      async findUnique({ where }) {
        return bindings.get(where.userId) ?? null;
      },
      async create({ data }) {
        const row = { id: nextId(), reportKeyHash: null, reportKeyIssuedAt: null, ...data };
        bindings.set(data.userId, row);
        return row;
      },
      async update({ where, data }) {
        const row = bindings.get(where.userId);
        Object.assign(row, data);
        return row;
      },
    },
    activityEvent: {
      async findUnique({ where }) {
        const key = where.userId_source_sourceEventId;
        return events.get(`${key.userId}|${key.source}|${key.sourceEventId}`) ?? null;
      },
      async create({ data }) {
        const key = `${data.userId}|${data.source}|${data.sourceEventId}`;
        if (events.has(key)) {
          const error = new Error("unique");
          error.code = "P2002";
          throw error;
        }
        const row = { id: nextId(), sequence: data.sequence ?? null, ...data };
        events.set(key, row);
        return row;
      },
      async findMany(args = {}) {
        let rows = [...events.values()].filter((row) => row.userId === args.where?.userId);
        if (args.where?.agentExternalId) {
          rows = rows.filter((row) => row.agentExternalId === args.where.agentExternalId);
        }
        if (args.where?.occurredAt?.gte) {
          const gte = new Date(args.where.occurredAt.gte).getTime();
          rows = rows.filter((row) => new Date(row.occurredAt).getTime() >= gte);
        }
        rows.sort((left, right) => new Date(right.occurredAt) - new Date(left.occurredAt));
        if (args.distinct?.includes("source")) {
          const seen = new Set();
          rows = rows.filter((row) => {
            if (seen.has(row.source)) return false;
            seen.add(row.source);
            return true;
          });
        }
        if (args.take) rows = rows.slice(0, args.take);
        if (args.select) {
          rows = rows.map((row) => {
            const picked = {};
            for (const key of Object.keys(args.select)) {
              if (args.select[key]) picked[key] = row[key];
            }
            return picked;
          });
        }
        return rows;
      },
    },
    observedAgent: {
      async findUnique({ where }) {
        const key = where.userId_externalId;
        return agents.get(`${key.userId}|${key.externalId}`) ?? null;
      },
      async create({ data }) {
        const row = { id: nextId(), ...data };
        agents.set(`${data.userId}|${data.externalId}`, row);
        return row;
      },
      async update({ where, data }) {
        const key = where.userId_externalId;
        const row = { ...agents.get(`${key.userId}|${key.externalId}`), ...data };
        agents.set(`${key.userId}|${key.externalId}`, row);
        return row;
      },
      async findMany({ where }) {
        return [...agents.values()].filter((row) => row.userId === where.userId);
      },
    },
  };
}

function grantStore() {
  const rows = [];
  return {
    rows,
    async findMany({ where }) {
      return rows.filter((row) => row.userId === where.userId);
    },
    async findFirst({ where }) {
      return (
        rows.find(
          (row) =>
            row.userId === where.userId &&
            row.agentId === where.agentId &&
            row.capability === where.capability
        ) ?? null
      );
    },
    async create({ data }) {
      const row = { id: `grant-${rows.length + 1}`, ...data };
      rows.push(row);
      return row;
    },
    async update({ where, data }) {
      const row = rows.find((item) => item.id === where.id);
      Object.assign(row, data);
      return row;
    },
  };
}

function response() {
  const state = { statusCode: null, body: null, headers: {} };
  return {
    state,
    response: {
      setHeader(name, value) {
        state.headers[name] = value;
      },
      status(code) {
        state.statusCode = code;
        return this;
      },
      json(body) {
        state.body = body;
        return this;
      },
    },
  };
}

function request(method, { token, body, user } = {}) {
  return {
    method,
    body: body ?? {},
    headers: token ? { authorization: `Bearer ${token}` } : {},
    socket: { remoteAddress: "127.0.0.1" },
    user,
  };
}

function scoped(tx) {
  return async (_userId, fn) => fn(tx);
}

function message(text) {
  return { id: "sub-1", op: { type: "message", message: { text } } };
}

function scripted(answers, seen) {
  let index = 0;
  return {
    async openStream(messages) {
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      seen.push(messages.find((item) => item.role === "system")?.content ?? "");
      return {
        resolution: { modelKey: "scripted", caller: {} },
        fullStream: (async function* stream() {
          yield { type: "text-delta", text: answer };
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

function lastAssistant(checkpoint) {
  const messages = checkpoint.transcript.filter((item) => item.role === "assistant");
  return messages[messages.length - 1]?.content ?? "";
}

const OBSERVATIONS = [
  {
    sourceEventId: "coder-name",
    kind: "freedom.report.agent",
    occurredAt: "2026-10-07T11:00:00.000Z",
    agentExternalId: "coder",
    coded: { displayName: "Coder", role: "coding" },
  },
  {
    sourceEventId: "coder-start",
    kind: "freedom.report.work",
    occurredAt: "2026-10-07T11:20:00.000Z",
    agentExternalId: "coder",
    turnId: "turn-coder",
    coded: { status: "started", task: "CHIEF UI" },
    text: "Started working on the CHIEF UI.",
  },
  {
    sourceEventId: "coder-working",
    kind: "freedom.report.work",
    occurredAt: "2026-10-07T11:55:00.000Z",
    agentExternalId: "coder",
    turnId: "turn-coder",
    coded: { status: "working", task: "CHIEF UI" },
    text: "Still working on the CHIEF UI.",
  },
  {
    sourceEventId: "research-name",
    kind: "freedom.report.agent",
    occurredAt: "2026-10-07T09:00:00.000Z",
    agentExternalId: "research",
    coded: { displayName: "Research", role: "research" },
  },
  {
    sourceEventId: "research-start",
    kind: "freedom.report.work",
    occurredAt: "2026-10-07T09:10:00.000Z",
    agentExternalId: "research",
    turnId: "turn-research",
    coded: { status: "started", task: "supplier review" },
    text: "Started the supplier review.",
  },
  {
    sourceEventId: "research-done",
    kind: "freedom.report.work",
    occurredAt: "2026-10-07T10:30:00.000Z",
    agentExternalId: "research",
    turnId: "turn-research",
    coded: { status: "completed", task: "supplier review" },
    text: "Completed the supplier review.",
  },
  {
    sourceEventId: "research-find",
    kind: "freedom.report.finding",
    occurredAt: "2026-10-07T10:31:00.000Z",
    agentExternalId: "research",
    turnId: "turn-research",
    text: "The supplier contract renews in March.",
  },
  {
    sourceEventId: "ops-name",
    kind: "freedom.report.agent",
    occurredAt: "2026-10-07T11:00:00.000Z",
    agentExternalId: "ops",
    coded: { displayName: "Ops", role: "operations" },
  },
  {
    sourceEventId: "ops-fail",
    kind: "freedom.report.work",
    occurredAt: "2026-10-07T11:30:00.000Z",
    agentExternalId: "ops",
    turnId: "turn-ops",
    coded: { status: "failed", task: "deploy check" },
    text: "The deploy check failed before planning a change.",
  },
  {
    sourceEventId: "ops-attn",
    kind: "freedom.report.attention",
    occurredAt: "2026-10-07T11:40:00.000Z",
    agentExternalId: "ops",
    turnId: "turn-ops",
    text: "Need a decision before anything else runs.",
  },
  {
    sourceEventId: "archive-name",
    kind: "freedom.report.agent",
    occurredAt: "2026-10-06T11:00:00.000Z",
    agentExternalId: "archive",
    coded: { displayName: "Archive", role: "archive" },
  },
  {
    sourceEventId: "archive-start",
    kind: "freedom.report.work",
    occurredAt: "2026-10-06T11:05:00.000Z",
    agentExternalId: "archive",
    turnId: "turn-archive",
    coded: { status: "started", task: "old migration" },
    text: "Started the old migration.",
  },
];

async function issueAndReport(tx, userId, bodies) {
  const issued = response();
  await handleWorkforceReportKey(request("POST", { user: userId }), issued.response, {
    enforceRateLimit: allow,
    authenticate: async (req) => ({ uid: req.user }),
    withUser: scoped(tx),
    now: NOW,
  });
  assert.equal(issued.state.statusCode, 201);
  const token = issued.state.body.reportKey;
  for (const body of bodies) {
    const posted = response();
    await handleWorkforceReport(request("POST", { token, body }), posted.response, {
      enforceRateLimit: allow,
      withUser: scoped(tx),
      encrypt,
      now: NOW,
    });
    assert.equal(posted.state.statusCode, 200, JSON.stringify(posted.state.body));
    assert.equal(posted.state.body.source, "self_report");
    assert.equal(posted.state.body.trust, "untrusted");
  }
  return token;
}

test("a stored grant enables workforce:read for one user and the baseline stays closed", async () => {
  assert.equal(baselineCapabilities().includes(Capability.WORKFORCE_READ), false);
  const grants = grantStore();
  const withUser = async (userId, fn) => fn({ chiefCapabilityGrant: grants });
  await saveCapabilityGrant({ chiefCapabilityGrant: grants }, "user-a", {
    capability: Capability.WORKFORCE_READ,
  });
  const granted = await loadCapabilityPolicy("user-a", { withUser, connectors: [] });
  const other = await loadCapabilityPolicy("user-b", { withUser, connectors: [] });
  assert.equal(granted.check("_default", Capability.WORKFORCE_READ), true);
  assert.equal(other.check("_default", Capability.WORKFORCE_READ), false);
  assert.equal(baselineCapabilities().includes(Capability.WORKFORCE_READ), false);
  await saveCapabilityGrant({ chiefCapabilityGrant: grants }, "user-a", {
    capability: Capability.WORKFORCE_READ,
    deny: true,
  });
  const denied = await loadCapabilityPolicy("user-a", { withUser, connectors: [] });
  assert.equal(denied.check("_default", Capability.WORKFORCE_READ), false);
  assert.equal(grants.rows.length, 1);
});

test("CHIEF answers from self-reports through the real Grok Bot runtime", async () => {
  const tx = memoryJournal();
  await issueAndReport(tx, "user-a", OBSERVATIONS);
  for (const row of tx.events.values()) {
    assert.equal(row.source, "SELF_REPORT");
    assert.equal(row.trust, "UNTRUSTED");
    assert.equal(row.provenance, "report");
    assert.equal(String(row.kind).startsWith("cursor."), false);
  }

  const grants = grantStore();
  await saveCapabilityGrant({ chiefCapabilityGrant: grants }, "user-a", {
    capability: Capability.WORKFORCE_READ,
  });
  const withUser = async (userId, fn) => fn({ chiefCapabilityGrant: grants });
  const granted = await loadCapabilityPolicy("user-a", { withUser, connectors: [] });
  const closed = await loadCapabilityPolicy("user-b", { withUser, connectors: [] });

  const reads = [];
  const runtime = createGrokBotRuntime({
    now: () => NOW,
    decrypt: (value) => {
      if (!String(value).startsWith("sealed:")) throw new Error("sealed text required");
      return String(value).slice("sealed:".length);
    },
    withUser: scoped(tx),
  });
  const provider = {
    provider: runtime.provider,
    effects: runtime.effects,
    listAgents: (userId) => runtime.listAgents(userId),
    getAgent: (userId, agentId) => runtime.getAgent(userId, agentId),
    listEvents: (userId, query) => runtime.listEvents(userId, query),
    async picture(userId, query) {
      reads.push(userId);
      return runtime.picture(userId, query);
    },
  };
  assert.equal(provider.provider, "grokbot");
  const picture = await provider.picture("user-a");
  reads.pop();
  assert.equal(picture.coverage, "self_report");
  assert.equal(picture.bound, true);
  assert.match(picture.coverageLine, /self-reported activity/);
  assert.equal(picture.agents.find((agent) => agent.id === "coder").liveness, "active");
  assert.equal(picture.agents.find((agent) => agent.id === "archive").liveness, "stale");

  const prompts = [];
  const answers = [
    "Coder finished the CHIEF UI. Coder committed the code.",
    "Archive completed the old migration. Research is still working on the supplier review.",
    "Coder is stuck on the CHIEF UI.",
    "Nothing failed.",
    "Coder needs my attention.",
    "The coding agent finished the CHIEF UI.",
    "Archive is currently active.",
    "Coder ran the tests. Coder changed the code.",
    "The coding agent finished it.",
    "Yes, it finished.",
    "It found a bug in the auth layer.",
    "Everyone finished, so there is nothing to see.",
    "Coder is currently deploying the CHIEF UI and needs a review.",
    "Never mind, Coder finished the whole migration.",
  ];
  const services = createChiefTurnServices({
    facts: new MemoryFactStore(),
    engine: {
      async generate() {
        return { content: "[]" };
      },
    },
    capabilityPolicy: granted,
    agentRuntime: provider,
  });
  const store = new MemoryCheckpointStore();
  const machine = new TurnMachine({
    store,
    engine: scripted(answers, prompts),
    contextAssembler: services.contextAssembler,
    settleModelStep: services.settleModelStep,
  });

  const questions = [
    "What are my GrokBots working on?",
    "What did my agents do recently?",
    "Is anything currently stuck?",
    "Did any agent report a problem?",
    "Which agent needs my attention?",
    "What did the coding agent accomplish?",
    "Are any agents idle?",
    "What don't we know about the current workforce?",
    "What about the coding agent?",
    "Did it finish?",
    "What did it find?",
    "Should I be concerned?",
    "What's changed since the last time I asked?",
    "Never mind.",
  ];
  let sessionId = null;
  const replies = [];
  for (let index = 0; index < questions.length; index += 1) {
    const result = await machine.run({
      userId: "user-a",
      sessionId,
      submission: message(questions[index]),
    });
    sessionId = result.sessionId;
    replies.push(lastAssistant(result.checkpoint));
  }

  const firstPrompt = prompts[0];
  assert.match(firstPrompt, /Provider grokbot/);
  assert.match(firstPrompt, /self-reported activity/);
  assert.match(firstPrompt, /not platform telemetry/);
  assert.match(firstPrompt, /Observed status working/);
  assert.match(firstPrompt, /Earlier status started is historical/);
  assert.match(firstPrompt, /Observed status completed/);
  assert.match(firstPrompt, /Observed finding/);
  assert.match(firstPrompt, /Observed failure/);
  assert.match(firstPrompt, /Observed attention/);
  assert.match(firstPrompt, /Liveness stale/);
  assert.match(firstPrompt, /No completion observed/);
  assert.doesNotMatch(firstPrompt, /always the provider/);
  assert.equal(firstPrompt.includes("cursor.grok_bot"), false);

  assert.match(replies[0], /No completion was observed/);
  assert.match(replies[0], /No code change was observed/);
  assert.match(replies[1], /No completion was observed/);
  assert.match(replies[1], /live observation says that work completed/);
  assert.match(replies[2], /No failure was observed/);
  assert.match(replies[3], /A failure was observed/);
  assert.match(replies[4], /No attention request was observed/);
  assert.match(replies[5], /No completion was observed/);
  assert.match(replies[6], /not currently active/);
  assert.match(replies[7], /No tool use was observed/);
  assert.match(replies[7], /No code change was observed/);
  assert.match(replies[8], /No completion was observed/);
  assert.match(replies[9], /No completion was observed/);
  assert.match(replies[10], /No finding was observed/);
  assert.match(replies[11], /No completion was observed/);
  assert.match(prompts[8], /Provider grokbot/);
  assert.match(prompts[11], /Provider grokbot/);
  assert.match(prompts[12], /Provider grokbot/);
  assert.match(replies[12], /No deploy was observed/);
  assert.equal(replies[13], "Yep.");
  assert.doesNotMatch(prompts[13], /CHIEF UI/);
  assert.equal(reads.includes("user-b"), false);

  const hiddenPrompts = [];
  const hidden = createChiefTurnServices({
    facts: new MemoryFactStore(),
    engine: {
      async generate() {
        return { content: "[]" };
      },
    },
    capabilityPolicy: closed,
    agentRuntime: provider,
  });
  const hiddenRun = await new TurnMachine({
    store: new MemoryCheckpointStore(),
    engine: scripted(["Coder is working on the CHIEF UI right now."], hiddenPrompts),
    contextAssembler: hidden.contextAssembler,
    settleModelStep: hidden.settleModelStep,
  }).run({
    userId: "user-b",
    submission: message("What are my GrokBots working on?"),
  });
  assert.match(hiddenPrompts[0], /Agent state is not connected/);
  assert.doesNotMatch(hiddenPrompts[0], /CHIEF UI/);
  assert.equal(
    lastAssistant(hiddenRun.checkpoint),
    "Agent state is not connected. No current agent status is available."
  );
  assert.equal(reads.includes("user-b"), false);
});

test("a revoked binding stays historical and live observations outrank memory", async () => {
  const tx = memoryJournal();
  await issueAndReport(tx, "user-revoked", [
    {
      sourceEventId: "scout-name",
      kind: "freedom.report.agent",
      occurredAt: "2026-10-07T11:50:00.000Z",
      agentExternalId: "scout",
      coded: { displayName: "Scout", role: "coding" },
    },
    {
      sourceEventId: "scout-start",
      kind: "freedom.report.work",
      occurredAt: "2026-10-07T11:58:00.000Z",
      agentExternalId: "scout",
      coded: { status: "started", task: "notes" },
      text: "Started the notes.",
    },
  ]);
  tx.bindings.get("user-revoked").status = "REVOKED";
  const runtime = createGrokBotRuntime({
    now: () => NOW,
    decrypt: (value) => String(value).slice("sealed:".length),
    withUser: scoped(tx),
  });
  const picture = await runtime.picture("user-revoked");
  assert.equal(picture.revoked, true);
  assert.equal(picture.bound, false);
  assert.equal(picture.agents[0].displayName, "Scout");

  const grants = grantStore();
  await saveCapabilityGrant({ chiefCapabilityGrant: grants }, "user-revoked", {
    capability: Capability.WORKFORCE_READ,
  });
  const policy = await loadCapabilityPolicy("user-revoked", {
    withUser: async (_userId, fn) => fn({ chiefCapabilityGrant: grants }),
    connectors: [],
  });
  const prompts = [];
  const services = createChiefTurnServices({
    facts: new MemoryFactStore(),
    engine: {
      async generate() {
        return { content: "[]" };
      },
    },
    capabilityPolicy: policy,
    agentRuntime: runtime,
  });
  const result = await new TurnMachine({
    store: new MemoryCheckpointStore(),
    engine: scripted(["Scout is currently active and still working."], prompts),
    contextAssembler: services.contextAssembler,
    settleModelStep: services.settleModelStep,
  }).run({
    userId: "user-revoked",
    submission: message("What are my agents doing?"),
  });
  assert.match(prompts[0], /Binding revoked/);
  assert.match(prompts[0], /Not currently active/);
  assert.match(lastAssistant(result.checkpoint), /not currently active/);
  assert.doesNotMatch(lastAssistant(result.checkpoint), /currently active and/);

  await issueAndReport(tx, "user-live", [
    {
      sourceEventId: "north-name",
      kind: "freedom.report.agent",
      occurredAt: "2026-10-07T11:00:00.000Z",
      agentExternalId: "north",
      coded: { displayName: "North", role: "coding" },
    },
    {
      sourceEventId: "north-start",
      kind: "freedom.report.work",
      occurredAt: "2026-10-07T11:10:00.000Z",
      agentExternalId: "north",
      coded: { status: "started", task: "dashboard" },
      text: "Started the dashboard.",
    },
    {
      sourceEventId: "north-done",
      kind: "freedom.report.work",
      occurredAt: "2026-10-07T11:50:00.000Z",
      agentExternalId: "north",
      coded: { status: "completed", task: "dashboard" },
      text: "Completed the dashboard task.",
    },
  ]);
  const pack = await orchestrateContext({
    query: "What are my agents doing?",
    userId: "user-live",
    now: NOW,
    memory: {
      async search() {
        return [
          {
            layer: "EPISODIC",
            text: "Agent North is working on the dashboard.",
            sourceId: "memory-north",
            score: 1,
          },
        ];
      },
    },
    readers: {
      agents: async (ctx) => {
        const { agentContextReader } = await import("../server/chief/agents/context.js");
        return agentContextReader(runtime)(ctx);
      },
    },
  });
  const live = pack.authority.find((item) => item.sourceId === "north");
  assert.equal(live.source, "grokbot");
  assert.match(live.text, /Observed status completed/);
  const memory = pack.items.find((item) => item.sourceId === "memory-north");
  assert.equal(memory.temporalState, "historical");
  assert.equal(memory.superseded, true);
  const staleAnswer = pack.items
    .filter((item) => item.origin === "live")
    .map((item) => item.text)
    .join(" ");
  assert.match(staleAnswer, /No completion observed|Observed status completed/);
  assert.doesNotMatch(
    pack.authority.map((item) => item.text).join(" "),
    /working on the dashboard/
  );

  const empty = await orchestrateContext({
    query: "What are my agents doing?",
    userId: "user-empty",
    now: NOW,
    memory: {
      async search() {
        return [
          {
            layer: "EPISODIC",
            text: "North finished the migration yesterday.",
            sourceId: "memory-only",
            score: 1,
          },
        ];
      },
    },
    readers: {
      agents: async () => [],
    },
  });
  assert.equal(empty.authority.length, 0);
  assert.match(empty.items.map((item) => item.text).join(" "), /not connected|No current agent/);
  const remembered = empty.items.find((item) => item.sourceId === "memory-only");
  assert.equal(remembered.temporalState, "historical");
  assert.equal(remembered.superseded, false);
});

test("the context label comes from the runtime provider", async () => {
  await assert.rejects(
    async () => createAgentRuntime({ provider: "hermes" }),
    (error) => error.code === "AGENT_RUNTIME_NOT_CONNECTED"
  );
  const tx = memoryJournal();
  await issueAndReport(tx, "user-a", [OBSERVATIONS[0], OBSERVATIONS[2]]);
  const grokbot = createGrokBotRuntime({
    now: () => NOW,
    decrypt: (value) => String(value).slice("sealed:".length),
    withUser: scoped(tx),
  });
  const hermesLabel = {
    provider: "hermes",
    effects: ["read"],
    async picture(userId, query) {
      const picture = await grokbot.picture(userId, query);
      return { ...picture, provider: "hermes" };
    },
  };
  const grants = grantStore();
  await saveCapabilityGrant({ chiefCapabilityGrant: grants }, "user-a", {
    capability: Capability.WORKFORCE_READ,
  });
  const policy = await loadCapabilityPolicy("user-a", {
    withUser: async (_userId, fn) => fn({ chiefCapabilityGrant: grants }),
    connectors: [],
  });
  const services = createChiefTurnServices({
    facts: new MemoryFactStore(),
    engine: {
      async generate() {
        return { content: "[]" };
      },
    },
    capabilityPolicy: policy,
    agentRuntime: hermesLabel,
  });
  const prompt = await services.contextAssembler({
    userId: "user-a",
    transcript: [{ role: "user", content: "What are my agents doing?" }],
  });
  assert.match(prompt, /Provider hermes/);
  assert.match(prompt, /Current \(hermes, live_agent_state/);
  assert.doesNotMatch(prompt, /Provider grokbot/);
  assert.doesNotMatch(prompt, /always the provider/);
});
