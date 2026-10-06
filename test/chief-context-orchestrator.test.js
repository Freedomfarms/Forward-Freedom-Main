// Context orchestration stays above the memory provider.
// Live readings win. Missing sources stay empty. Nothing retrieved is stored.

import test from "node:test";
import assert from "node:assert/strict";

import { createChiefTurnServices } from "../server/chief/context/wire.js";
import {
  orchestrateContext,
  planContext,
  renderContextPackage,
  temporalStateForSchedule,
} from "../server/chief/context/orchestrate.js";
import { MemoryFactStore } from "../server/chief/memory/facts.js";
import { createMemoryAccess } from "../server/chief/memory/provider.js";

const NOW = new Date("2026-10-05T18:00:00.000Z");

function fields(item) {
  for (const key of [
    "source",
    "sourceType",
    "temporalState",
    "occurredAt",
    "text",
    "sourceId",
    "trust",
  ]) {
    assert.equal(Object.hasOwn(item, key), true);
  }
}

test("current financial state outranks stale holding memory", async () => {
  let remembered = 0;
  const pack = await orchestrateContext({
    query: "What crypto do I own?",
    userId: "user-a",
    now: NOW,
    memory: {
      async search() {
        return [{ layer: "PERSONAL", text: "User owns Bitcoin", sourceId: "old-coin", score: 1 }];
      },
      remember() {
        remembered += 1;
      },
    },
    readers: {
      finance: async () => [
        {
          text: "XRP quantity 59000",
          sourceId: "hold-1",
          occurredAt: "2026-10-05T12:00:00.000Z",
          trust: "live",
        },
      ],
    },
  });
  assert.equal(remembered, 0);
  assert.equal(pack.readOnly, true);
  assert.equal(pack.authority.length, 1);
  assert.equal(pack.authority[0].source, "freedom_financial");
  assert.equal(pack.authority[0].sourceType, "live_financial_state");
  assert.equal(pack.authority[0].temporalState, "current");
  assert.match(pack.authority[0].text, /59000/);
  const stale = pack.items.find((item) => item.sourceId === "old-coin");
  assert.equal(stale.temporalState, "historical");
  assert.equal(stale.superseded, true);
  assert.equal(stale.trust, "memory");
  for (const item of pack.items) fields(item);
  const rendered = renderContextPackage(pack);
  assert.ok(rendered.indexOf("59000") < rendered.indexOf("Bitcoin"));
  assert.match(rendered, /Historical, not current/);
  assert.equal(planContext("What crypto do I own?").live.includes("agents"), false);
});

test("current agent state outranks historical agent memory", async () => {
  const pack = await orchestrateContext({
    query: "What are my Grokbots doing right now?",
    userId: "user-a",
    now: NOW,
    memory: {
      async search() {
        return [
          {
            layer: "EPISODIC",
            text: "Grokbot finished the supplier review yesterday.",
            sourceId: "past-agent",
            score: 1,
          },
        ];
      },
    },
    readers: {
      agents: async () => [
        {
          text: "Grokbot is inspecting the north well.",
          sourceId: "agent-1",
          occurredAt: "2026-10-05T17:55:00.000Z",
          trust: "platform",
          relatesTo: ["task-3", "session-9"],
        },
      ],
    },
  });
  assert.equal(pack.authority.length, 1);
  assert.equal(pack.authority[0].source, "grokbot");
  assert.equal(pack.authority[0].temporalState, "current");
  assert.match(pack.authority[0].text, /north well/);
  assert.deepEqual(pack.authority[0].relatesTo, ["task-3", "session-9"]);
  const past = pack.items.find((item) => item.sourceId === "past-agent");
  assert.equal(past.scope, "agent");
  assert.equal(past.temporalState, "historical");
  assert.equal(past.superseded, true);
  assert.equal(past.source, "chief_session");
  const rendered = renderContextPackage(pack);
  assert.match(rendered, /Current \(grokbot, live_agent_state/);
  assert.match(rendered, /Historical, not current/);
  assert.doesNotMatch(rendered, /Current \(chief_session/);
});

test("a past decision stays historical context and is not current truth", async () => {
  const pack = await orchestrateContext({
    query: "What did we decide last week?",
    userId: "user-a",
    now: NOW,
    memory: {
      async search() {
        return [
          {
            layer: "EPISODIC",
            text: "We decided to keep a single CHIEF session record.",
            sourceId: "week-old",
            score: 1,
          },
        ];
      },
    },
  });
  assert.equal(pack.plan.currentState, false);
  assert.deepEqual(pack.plan.live, []);
  assert.equal(pack.items.length, 1);
  assert.equal(pack.items[0].temporalState, "historical");
  assert.equal(pack.items[0].scope, "decision");
  assert.equal(pack.items[0].source, "chief_session");
  assert.equal(pack.authority[0].sourceId, "week-old");
  const rendered = renderContextPackage(pack);
  assert.match(rendered, /Historical context \(chief_session, episodic_memory, historical/);
  assert.doesNotMatch(rendered, /Current \(/);
});

test("search and reader failures fail open without fabricated data", async () => {
  const pack = await orchestrateContext({
    query: "What crypto do I own?",
    userId: "user-a",
    memory: {
      async search() {
        throw new Error("memory down");
      },
    },
    readers: {
      finance: async () => {
        throw new Error("finance down");
      },
    },
  });
  assert.equal(pack.authority.length, 0);
  assert.equal(pack.items.length, 1);
  assert.equal(pack.items[0].available, false);
  assert.equal(pack.items[0].trust, "unavailable");
  assert.doesNotMatch(pack.items[0].text, /59000|Bitcoin|\$/);
  assert.equal(pack.unavailable[0], "finance");
});

test("a missing connector does not invent mailbox contents", async () => {
  const seen = [];
  const pack = await orchestrateContext({
    query: "What's in my email?",
    userId: "user-a",
    readers: {
      finance: async () => {
        seen.push("finance");
        return [{ text: "should not be read", sourceId: "nope" }];
      },
    },
  });
  assert.deepEqual(seen, []);
  assert.equal(pack.plan.live.includes("email"), true);
  assert.equal(pack.plan.live.includes("finance"), false);
  assert.equal(pack.items.length, 1);
  assert.equal(pack.items[0].available, false);
  assert.equal(pack.items[0].source, "email");
  assert.match(pack.items[0].text, /not connected/);
  assert.doesNotMatch(pack.items[0].text, /subject|unread|hello@/i);
  assert.equal(pack.authority.length, 0);
});

test("provenance is still present after the turn assembler builds the prompt", async () => {
  const services = createChiefTurnServices({
    facts: new MemoryFactStore(),
    engine: {
      async generate() {
        return { content: "[]" };
      },
    },
    contextReaders: {
      finance: async () => [
        {
          text: "XRP quantity 59000",
          sourceId: "hold-1",
          occurredAt: "2026-10-05T12:00:00.000Z",
          trust: "live",
        },
      ],
    },
  });
  const prompt = await services.contextAssembler({
    userId: "user-a",
    sessionId: "session-a",
    transcript: [{ role: "user", content: "What crypto do I own?" }],
    availableTools: ["finance_summary"],
  });
  assert.match(prompt, /freedom_financial/);
  assert.match(prompt, /live_financial_state/);
  assert.match(prompt, /trust live/);
  assert.match(prompt, /id hold-1/);
  assert.match(prompt, /2026-10-05T12:00:00.000Z/);
  assert.match(prompt, /XRP quantity 59000/);
  assert.match(prompt, /override historical memory/);
});

test("episodic recall drops the current session and keeps the earlier one", async () => {
  let scope = null;
  const pack = await orchestrateContext({
    query: "What did we decide last week?",
    userId: "user-a",
    sessionId: "current",
    memory: {
      async search(_query, received) {
        scope = received;
        return [
          {
            layer: "EPISODIC",
            text: "We decided to keep one session.",
            sourceId: "current",
            score: 1,
          },
          {
            layer: "EPISODIC",
            text: "We decided to repair the north well.",
            sourceId: "past",
            score: 0.9,
          },
        ];
      },
    },
  });
  assert.equal(scope.sessionId, "current");
  assert.equal(scope.userId, "user-a");
  assert.equal(
    pack.items.some((item) => item.sourceId === "current"),
    false
  );
  assert.equal(
    pack.items.some((item) => item.sourceId === "past"),
    true
  );
});

test("one question can combine agent state, schedule, and a past decision", async () => {
  const pack = await orchestrateContext({
    query: "What are my Grokbots working on and is anything behind schedule?",
    userId: "user-a",
    now: NOW,
    memory: {
      async search() {
        return [
          {
            layer: "EPISODIC",
            text: "We decided the supplier review belongs to Grokbot.",
            sourceId: "decision-1",
            score: 1,
          },
        ];
      },
    },
    readers: {
      agents: async () => [
        {
          text: "Grokbot is still on the supplier review.",
          sourceId: "agent-1",
          relatesTo: ["task-3", "session-9"],
          occurredAt: NOW,
        },
      ],
      schedule: async () => [
        {
          text: "Supplier review was due yesterday.",
          sourceId: "task-3",
          status: "pending",
          dueAt: "2026-10-04T15:00:00.000Z",
          relatesTo: ["session-9"],
        },
      ],
    },
  });
  const sources = new Set(pack.items.map((item) => item.source));
  assert.equal(sources.has("grokbot"), true);
  assert.equal(sources.has("scheduler"), true);
  assert.equal(sources.has("chief_session"), true);
  const task = pack.items.find((item) => item.sourceId === "task-3");
  assert.equal(task.temporalState, "overdue");
  assert.equal(task.scope, "temporal");
  assert.deepEqual(task.relatesTo, ["session-9"]);
  assert.equal(pack.plan.live.includes("finance"), false);
  assert.equal(pack.plan.live.includes("email"), false);
  const rendered = renderContextPackage(pack);
  assert.match(rendered, /grokbot/);
  assert.match(rendered, /scheduler/);
  assert.match(rendered, /chief_session/);
});

test("context selection follows the question and does not read every system", async () => {
  const seen = [];
  const readers = {
    finance: async () => {
      seen.push("finance");
      return [{ text: "XRP quantity 1", sourceId: "f" }];
    },
    agents: async () => {
      seen.push("agents");
      return [{ text: "idle", sourceId: "a" }];
    },
    email: async () => {
      seen.push("email");
      return [{ text: "hello", sourceId: "e" }];
    },
    schedule: async () => {
      seen.push("schedule");
      return [{ text: "none", sourceId: "s" }];
    },
  };
  const memory = {
    async search(_query, scope) {
      seen.push(`search:${scope.layers.join("+")}`);
      return [];
    },
  };
  seen.length = 0;
  await orchestrateContext({
    query: "How much XRP do I own?",
    userId: "user-a",
    readers,
    memory,
  });
  assert.deepEqual(seen, ["finance", "search:PERSONAL"]);

  seen.length = 0;
  await orchestrateContext({
    query: "What are my Grokbots doing right now?",
    userId: "user-a",
    readers,
    memory,
  });
  assert.equal(seen.includes("finance"), false);
  assert.equal(seen.includes("email"), false);
  assert.equal(seen[0], "agents");
  assert.equal(
    seen.some((call) => call.startsWith("search:")),
    true
  );
  assert.equal(
    seen.some((call) => call.includes("EPISODIC")),
    true
  );

  seen.length = 0;
  const ordinary = await orchestrateContext({
    query: "How is the well?",
    userId: "user-a",
    readers,
    memory,
  });
  assert.deepEqual(seen, []);
  assert.equal(ordinary.items.length, 0);
  assert.equal(renderContextPackage(ordinary), "");
});

test("a live reading is not written into long-term memory", async () => {
  const facts = new MemoryFactStore();
  await facts.write({
    userId: "user-a",
    content: "User owns Bitcoin",
    trustTier: "AUTO",
    source: "user",
  });
  await facts.write({
    userId: "user-b",
    content: "User owns Ethereum",
    trustTier: "AUTO",
    source: "user",
  });
  const access = createMemoryAccess({ facts });
  let remembers = 0;
  const pack = await orchestrateContext({
    query: "What crypto do I own?",
    userId: "user-a",
    now: NOW,
    memory: {
      search: (query, scope) => access.search(query, scope),
      remember() {
        remembers += 1;
      },
    },
    readers: {
      finance: async () => [{ text: "XRP quantity 59000", sourceId: "hold-1", occurredAt: NOW }],
    },
  });
  assert.equal(remembers, 0);
  assert.equal(pack.authority[0].text, "XRP quantity 59000");
  const rows = await facts.read({ userId: "user-a", limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(
    rows.some((row) => /59000/.test(row.content)),
    false
  );
  assert.equal(
    rows.some((row) => row.userId === "user-b"),
    false
  );
  assert.equal(
    pack.items.some((item) => /Ethereum/.test(item.text)),
    false
  );
});

test("schedule time is completed, pending, scheduled, or overdue", () => {
  assert.equal(temporalStateForSchedule({ status: "completed" }, NOW), "completed");
  assert.equal(temporalStateForSchedule({ status: "pending" }, NOW), "pending");
  assert.equal(
    temporalStateForSchedule({ status: "pending", dueAt: "2026-10-06T00:00:00.000Z" }, NOW),
    "scheduled"
  );
  assert.equal(
    temporalStateForSchedule({ status: "pending", dueAt: "2026-10-04T00:00:00.000Z" }, NOW),
    "overdue"
  );
});
