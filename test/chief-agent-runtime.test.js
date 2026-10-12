// CHIEF reads the workforce through the agent runtime.
// The runtime does not submit work. workforce:read stays off the baseline.
// A turn sees the journal only when that grant is present.

import test from "node:test";
import assert from "node:assert/strict";

import { createAgentRuntime } from "../server/chief/agents/index.js";
import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import { createChiefTurnServices } from "../server/chief/context/wire.js";
import { orchestrateContext } from "../server/chief/context/orchestrate.js";
import { MemoryFactStore } from "../server/chief/memory/facts.js";

const NOW = new Date("2026-10-05T18:00:00.000Z");

function decrypt(value) {
  if (typeof value !== "string" || !value.startsWith("sealed:")) {
    throw new Error("sealed text required");
  }
  return value.slice("sealed:".length);
}

function memoryTx(seed) {
  const bindings = new Map(seed.bindings ?? []);
  const agents = [...(seed.agents ?? [])];
  const events = [...(seed.events ?? [])];
  return {
    tx: {
      workforceBinding: {
        async findUnique({ where }) {
          return bindings.get(where.userId) ?? null;
        },
      },
      observedAgent: {
        async findMany({ where }) {
          return agents.filter((row) => row.userId === where.userId);
        },
      },
      activityEvent: {
        async findMany(args = {}) {
          let rows = events.filter((row) => row.userId === args.where?.userId);
          if (args.where?.agentExternalId) {
            rows = rows.filter((row) => row.agentExternalId === args.where.agentExternalId);
          }
          if (args.where?.occurredAt?.gte) {
            const gte = new Date(args.where.occurredAt.gte).getTime();
            rows = rows.filter((row) => new Date(row.occurredAt).getTime() >= gte);
          }
          rows = [...rows].sort(
            (left, right) => new Date(right.occurredAt) - new Date(left.occurredAt)
          );
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
    },
  };
}

function runtimeFor(seed) {
  const db = memoryTx(seed);
  return createAgentRuntime({
    provider: "grokbot",
    now: () => NOW,
    decrypt,
    withUser: async (_userId, fn) => fn(db.tx),
  });
}

const journal = {
  bindings: [
    [
      "user-a",
      {
        id: "binding-1",
        userId: "user-a",
        status: "ACTIVE",
        reportKeyHash: "hash-must-stay-hidden",
      },
    ],
  ],
  agents: [
    {
      id: "obs-1",
      userId: "user-a",
      externalId: "bot-1",
      displayName: "North",
      role: "inspector",
      identityTrust: "UNTRUSTED",
      lastEventAt: new Date("2026-10-05T17:50:00.000Z"),
      lastTurnId: "turn-9",
    },
    {
      id: "obs-2",
      userId: "user-a",
      externalId: "bot-2",
      displayName: null,
      role: null,
      identityTrust: null,
      lastEventAt: new Date("2026-10-05T14:00:00.000Z"),
      lastTurnId: null,
    },
  ],
  events: [
    {
      id: "evt-old",
      userId: "user-a",
      source: "SELF_REPORT",
      trust: "UNTRUSTED",
      kind: "freedom.report.agent",
      occurredAt: new Date("2026-10-05T09:00:00.000Z"),
      agentExternalId: "bot-2",
      turnId: null,
      sequence: 1,
      coded: { displayName: "South" },
      textCiphertext: null,
    },
    {
      id: "evt-find",
      userId: "user-a",
      source: "SELF_REPORT",
      trust: "UNTRUSTED",
      kind: "freedom.report.finding",
      occurredAt: new Date("2026-10-05T17:50:00.000Z"),
      agentExternalId: "bot-1",
      turnId: "turn-9",
      sequence: 2,
      coded: null,
      textCiphertext: "sealed:The north well is clear.",
    },
    {
      id: "evt-tool",
      userId: "user-a",
      source: "OTEL",
      trust: "PLATFORM",
      kind: "cursor.grok_bot.tool_result",
      occurredAt: new Date("2026-10-05T17:40:00.000Z"),
      agentExternalId: "bot-1",
      turnId: "turn-9",
      sequence: 1,
      coded: { outcome: "error" },
      textCiphertext: null,
    },
  ],
};

test("the grokbot runtime is a read of the journal", async () => {
  const runtime = runtimeFor(journal);
  assert.equal(runtime.provider, "grokbot");
  assert.deepEqual(runtime.effects, ["read"]);
  assert.equal(runtime.submitTask, undefined);
  assert.equal(runtime.cancelRun, undefined);
  assert.equal(runtime.subscribeToEvents, undefined);

  const agents = await runtime.listAgents("user-a");
  assert.deepEqual(
    agents.map((agent) => agent.id),
    ["bot-1", "bot-2"]
  );
  assert.equal(agents[0].displayName, "North");
  assert.equal(agents[0].identityTrust, "untrusted");
  assert.equal(agents[0].liveness, "active");
  assert.equal(agents[1].liveness, "idle");
  assert.equal(agents[1].displayName, null);

  const agent = await runtime.getAgent("user-a", "bot-1");
  assert.equal(agent.lastTurnId, "turn-9");
  assert.equal(agent.recent[0].text, "The north well is clear.");
  assert.equal(
    agent.recent.some((event) => event.agentId === "bot-2"),
    false
  );

  const events = await runtime.listEvents("user-a", {
    since: "2026-10-05T12:00:00.000Z",
  });
  assert.deepEqual(
    events.map((event) => event.id),
    ["evt-find", "evt-tool"]
  );

  const picture = await runtime.picture("user-a");
  assert.equal(picture.bound, true);
  assert.equal(picture.readOnly, true);
  assert.equal(picture.coverage, "platform+report");
  assert.match(picture.coverageLine, /Self-reported notes are contextual and untrusted/);
  assert.equal(picture.recent[0].kind, "freedom.report.finding");
  assert.match(picture.gaps.join(" "), /no reported name/);
  const serialized = JSON.stringify(picture);
  assert.equal(serialized.includes("sealed:"), false);
  assert.equal(serialized.includes("textCiphertext"), false);
  assert.equal(serialized.includes("hash-must-stay-hidden"), false);
  assert.equal(serialized.includes("reportKeyHash"), false);
  assert.equal(await runtime.getAgent("user-a", "missing"), null);
});

test("an unbound user has an empty picture and hermes is not a provider", async () => {
  const runtime = runtimeFor({ bindings: [], agents: [], events: [] });
  const picture = await runtime.picture("user-a");
  assert.equal(picture.bound, false);
  assert.equal(picture.coverage, "none");
  assert.deepEqual(picture.agents, []);
  assert.deepEqual(picture.recent, []);
  assert.match(picture.gaps.join(" "), /No workforce binding/);
  let missing = null;
  try {
    createAgentRuntime({ provider: "hermes" });
  } catch (error) {
    missing = error;
  }
  assert.equal(missing?.code, "AGENT_RUNTIME_NOT_CONNECTED");
  assert.match(missing?.message ?? "", /hermes/);
});

test("a revoked binding keeps history and refuses to look active", async () => {
  const runtime = runtimeFor({
    bindings: [["user-a", { userId: "user-a", status: "REVOKED" }]],
    agents: journal.agents,
    events: journal.events,
  });
  const picture = await runtime.picture("user-a");
  assert.equal(picture.bound, false);
  assert.equal(picture.revoked, true);
  assert.equal(picture.agents.length, 2);
  assert.match(picture.gaps.join(" "), /revoked/);
});

test("unreadable report text is a gap and not a thrown picture", async () => {
  const runtime = createAgentRuntime({
    now: () => NOW,
    decrypt() {
      throw new Error("key missing");
    },
    withUser: async (_userId, fn) =>
      fn(
        memoryTx({
          bindings: [["user-a", { userId: "user-a", status: "ACTIVE" }]],
          agents: [journal.agents[0]],
          events: [journal.events[1]],
        }).tx
      ),
  });
  const picture = await runtime.picture("user-a");
  assert.equal(picture.recent[0].text, null);
  assert.match(picture.gaps.join(" "), /could not be read/);
});

test("a turn reads the runtime only when workforce:read is granted", async () => {
  let reads = 0;
  const runtime = {
    provider: "grokbot",
    effects: ["read"],
    async picture() {
      reads += 1;
      return {
        provider: "grokbot",
        effects: ["read"],
        readOnly: true,
        asOf: NOW.toISOString(),
        bound: true,
        revoked: false,
        coverage: "self_report",
        coverageLine:
          "Agent status is based on self-reported activity; platform telemetry is unavailable.",
        agents: [
          {
            id: "bot-1",
            displayName: "North",
            role: "inspector",
            identityTrust: "untrusted",
            liveness: "active",
            lastEventAt: "2026-10-05T17:50:00.000Z",
            lastTurnId: "turn-9",
          },
        ],
        recent: [],
        gaps: ["Liveness is inferred from the last observed event."],
      };
    },
  };
  const granted = new CapabilityPolicy({ defaultDeny: true });
  granted.grant("_default", Capability.WORKFORCE_READ);
  const closed = new CapabilityPolicy({ defaultDeny: true });

  const silent = createChiefTurnServices({
    facts: new MemoryFactStore(),
    engine: { async generate() {} },
    capabilityPolicy: closed,
    agentRuntime: runtime,
  });
  const hidden = await silent.contextAssembler({
    userId: "user-a",
    transcript: [{ role: "user", content: "What are my agents doing?" }],
  });
  assert.equal(reads, 0);
  assert.match(hidden, /Agent state is not connected/);

  const open = createChiefTurnServices({
    facts: new MemoryFactStore(),
    engine: { async generate() {} },
    capabilityPolicy: granted,
    agentRuntime: runtime,
  });
  const shown = await open.contextAssembler({
    userId: "user-a",
    transcript: [{ role: "user", content: "What are my agents doing?" }],
  });
  assert.equal(reads, 1);
  assert.match(shown, /self-reported activity/);
  assert.match(shown, /North \(reported name, untrusted\)/);
  assert.match(shown, /Liveness active/);
  assert.match(shown, /Provider grokbot/);
  assert.match(shown, /trust untrusted/);

  const custom = createChiefTurnServices({
    facts: new MemoryFactStore(),
    engine: { async generate() {} },
    capabilityPolicy: granted,
    agentRuntime: runtime,
    contextReaders: {
      agents: async () => [{ text: "Custom agent line.", sourceId: "custom" }],
    },
  });
  const kept = await custom.contextAssembler({
    userId: "user-a",
    transcript: [{ role: "user", content: "What are my agents doing?" }],
  });
  assert.equal(reads, 1);
  assert.match(kept, /Custom agent line/);
});

test("live agent state outranks memory for any workforce provider", async () => {
  const pack = await orchestrateContext({
    query: "What are the agents doing?",
    userId: "user-a",
    now: NOW,
    memory: {
      async search() {
        return [
          {
            layer: "EPISODIC",
            text: "The agent finished yesterday.",
            sourceId: "past-agent",
            score: 1,
          },
        ];
      },
    },
    readers: {
      agents: async () => [
        {
          text: "The workforce is inspecting the north well.",
          source: "hermes",
          sourceType: "live_agent_state",
          sourceId: "bot-1",
          trust: "untrusted",
        },
      ],
    },
  });
  assert.equal(pack.authority[0].source, "hermes");
  assert.equal(pack.authority[0].sourceType, "live_agent_state");
  const past = pack.items.find((item) => item.sourceId === "past-agent");
  assert.equal(past.superseded, true);
});
