// Workforce journal: both sources, derived trust, and coverage wording.
// No ingress and no CHIEF tool.

import test from "node:test";
import assert from "node:assert/strict";

import {
  describeCoverage,
  normalizeObservation,
  projectAgent,
} from "../server/chief/workforce/journal.js";
import { appendObservation, openWorkforceBinding } from "../server/chief/workforce/store.js";

function memoryTx() {
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
        const row = { id: nextId(), ...data };
        bindings.set(data.userId, row);
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
    },
  };
}

const encrypt = (text) => `sealed:${text}`;

test("platform telemetry and self-report keep separate trust and kinds", () => {
  const platform = normalizeObservation({
    source: "otel",
    sourceEventId: "evt-1",
    kind: "cursor.grok_bot.tool_result",
    occurredAt: "2026-10-02T12:00:00.000Z",
    agentExternalId: "bot-1",
    provenance: "server",
    coded: { outcome: "success" },
  });
  assert.equal(platform.trust, "platform");
  assert.equal(platform.dbSource, "OTEL");
  assert.equal(platform.dbTrust, "PLATFORM");

  const report = normalizeObservation({
    source: "self_report",
    sourceEventId: "evt-1",
    kind: "freedom.report.finding",
    occurredAt: "2026-10-02T12:05:00.000Z",
    agentExternalId: "bot-1",
    text: "The draft is ready.",
  });
  assert.equal(report.trust, "untrusted");
  assert.equal(report.provenance, "report");
  assert.equal(report.dbTrust, "UNTRUSTED");

  assert.throws(
    () =>
      normalizeObservation({
        source: "self_report",
        sourceEventId: "evt-2",
        kind: "cursor.grok_bot.tool_result",
        occurredAt: "2026-10-02T12:00:00.000Z",
        agentExternalId: "bot-1",
      }),
    /freedom\.report/
  );
  assert.throws(
    () =>
      normalizeObservation({
        source: "otel",
        sourceEventId: "evt-2",
        kind: "freedom.report.work",
        occurredAt: "2026-10-02T12:00:00.000Z",
        agentExternalId: "bot-1",
      }),
    /cursor\./
  );
  assert.throws(
    () =>
      normalizeObservation({
        source: "self_report",
        sourceEventId: "evt-3",
        kind: "freedom.report.agent",
        occurredAt: "2026-10-02T12:00:00.000Z",
        agentExternalId: "bot-1",
        provenance: "server",
      }),
    /platform provenance/
  );
  assert.throws(
    () =>
      normalizeObservation({
        source: "otel",
        sourceEventId: "evt-4",
        kind: "cursor.grok_bot.tool_result",
        occurredAt: "2026-10-02T12:00:00.000Z",
        agentExternalId: "bot-1",
        trust: "platform",
      }),
    /not accepted/
  );
});

test("coverage names the missing platform feed", () => {
  assert.equal(
    describeCoverage(["self_report"]).line,
    "Agent status is based on self-reported activity; platform telemetry is unavailable."
  );
  assert.equal(describeCoverage(["SELF_REPORT"]).coverage, "self_report");
  assert.equal(describeCoverage(["otel"]).coverage, "platform");
  assert.equal(describeCoverage(["otel", "self_report"]).coverage, "platform+report");
  assert.equal(describeCoverage([]).coverage, "none");
});

test("append keeps both sources and does not replace a duplicate", async () => {
  const tx = memoryTx();
  await openWorkforceBinding(tx, "user-1", { cursorAccountId: "cursor-9" });
  await assert.rejects(() => openWorkforceBinding(tx, "user-1", { email: "a@b.c" }));
  const now = new Date("2026-10-02T12:20:00.000Z");
  const first = await appendObservation(
    tx,
    "user-1",
    {
      source: "otel",
      sourceEventId: "same",
      kind: "cursor.grok_bot.tool_result",
      occurredAt: "2026-10-02T12:00:00.000Z",
      agentExternalId: "bot-1",
      provenance: "server",
      text: "secret command",
    },
    { encrypt, now }
  );
  assert.equal(first.duplicate, false);
  assert.equal(first.event.trust, "PLATFORM");
  assert.equal(first.event.textCiphertext, "sealed:secret command");

  const retry = await appendObservation(
    tx,
    "user-1",
    {
      source: "otel",
      sourceEventId: "same",
      kind: "cursor.grok_bot.tool_result",
      occurredAt: "2026-10-02T12:30:00.000Z",
      agentExternalId: "bot-1",
      provenance: "server",
      text: "replaced",
    },
    { encrypt, now }
  );
  assert.equal(retry.duplicate, true);
  assert.equal(retry.event.textCiphertext, "sealed:secret command");

  const report = await appendObservation(
    tx,
    "user-1",
    {
      source: "self_report",
      sourceEventId: "same",
      kind: "freedom.report.agent",
      occurredAt: "2026-10-02T12:10:00.000Z",
      agentExternalId: "bot-1",
      coded: { displayName: "Research", role: "Finds sources" },
    },
    { encrypt, now }
  );
  assert.equal(report.duplicate, false);
  assert.equal(report.event.trust, "UNTRUSTED");
  const agent = tx.agents.get("user-1|bot-1");
  assert.equal(agent.displayName, "Research");
  assert.equal(agent.identityTrust, "UNTRUSTED");
  assert.equal(agent.liveness, "ACTIVE");
  assert.equal(tx.events.size, 2);
});

test("an older event does not move the agent backward, and OTEL does not name it", () => {
  const named = projectAgent(
    null,
    normalizeObservation({
      source: "self_report",
      sourceEventId: "a",
      kind: "freedom.report.agent",
      occurredAt: "2026-10-02T12:00:00.000Z",
      agentExternalId: "bot-1",
      coded: { displayName: "Research" },
    }),
    new Date("2026-10-02T12:05:00.000Z")
  );
  assert.equal(named.displayName, "Research");
  const older = projectAgent(
    named,
    normalizeObservation({
      source: "otel",
      sourceEventId: "b",
      kind: "cursor.grok_bot.shell_command",
      occurredAt: "2026-10-02T11:00:00.000Z",
      agentExternalId: "bot-1",
      provenance: "client",
      coded: { displayName: "Should not apply" },
    }),
    new Date("2026-10-02T12:05:00.000Z")
  );
  assert.equal(older.displayName, "Research");
  assert.equal(older.lastEventAt.toISOString(), "2026-10-02T12:00:00.000Z");
});

test("append refuses a missing binding", async () => {
  const tx = memoryTx();
  await assert.rejects(
    () =>
      appendObservation(tx, "user-1", {
        source: "self_report",
        sourceEventId: "a",
        kind: "freedom.report.attention",
        occurredAt: "2026-10-02T12:00:00.000Z",
        agentExternalId: "bot-1",
      }),
    /not active/
  );
});
