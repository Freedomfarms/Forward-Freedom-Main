// Grok Bot read provider.
//
// Grok Bot owns execution outside this process. Freedom OS stores what was
// observed in the workforce journal. This provider reads that journal.
// It does not call xAI, Cursor, or a bot, and it does not append events.

import { decrypt as openText } from "../../security/envelope.js";
import { describeCoverage, livenessAt } from "../workforce/journal.js";

const AGENT_EFFECTS = Object.freeze(["read"]);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const TEXT_MAX = 500;
const RECENT_MAX = 8;

const NOTABLE_KINDS = new Set([
  "freedom.report.work",
  "freedom.report.finding",
  "freedom.report.attention",
]);

const NOTABLE_OUTCOMES = new Set(["error", "denied", "cancelled", "failed", "held"]);

function limitOf(value) {
  const limit = value == null ? DEFAULT_LIMIT : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error("agent event limit must be an integer from 1 to 50");
  }
  return limit;
}

function sinceOf(value) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("agent event since is invalid");
  return date;
}

function agentIdOf(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "" || value.length > 256) {
    throw new Error("agent id must be a nonempty string");
  }
  return value.trim();
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function trustName(value) {
  if (value === "PLATFORM" || value === "platform") return "platform";
  if (value == null) return null;
  return "untrusted";
}

function sourceName(value) {
  if (value === "OTEL" || value === "otel") return "otel";
  return "self_report";
}

function clip(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim().slice(0, TEXT_MAX);
}

function readText(ciphertext, decrypt) {
  if (ciphertext == null) return { text: null, failed: false };
  try {
    return { text: clip(decrypt(ciphertext)), failed: false };
  } catch {
    return { text: null, failed: true };
  }
}

function agentView(row, now) {
  return {
    id: row.externalId,
    displayName: row.displayName ?? null,
    role: row.role ?? null,
    identityTrust: trustName(row.identityTrust),
    liveness: String(livenessAt(row.lastEventAt, now)).toLowerCase(),
    lastEventAt: iso(row.lastEventAt),
    lastTurnId: row.lastTurnId ?? null,
  };
}

function eventView(row, decrypt) {
  const opened = readText(row.textCiphertext, decrypt);
  return {
    event: {
      id: row.id,
      kind: row.kind,
      occurredAt: iso(row.occurredAt),
      agentId: row.agentExternalId,
      turnId: row.turnId ?? null,
      source: sourceName(row.source),
      trust: trustName(row.trust),
      outcome:
        typeof row.coded?.outcome === "string"
          ? row.coded.outcome
          : typeof row.coded?.status === "string"
            ? row.coded.status
            : null,
      text: opened.text,
    },
    unreadable: opened.failed,
  };
}

function byRecent(left, right) {
  const at = new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime();
  if (at !== 0) return at;
  return (right.sequence ?? -1) - (left.sequence ?? -1);
}

function notable(event) {
  if (NOTABLE_KINDS.has(event.kind)) return true;
  return typeof event.outcome === "string" && NOTABLE_OUTCOMES.has(event.outcome.toLowerCase());
}

function gapsFor({ binding, agents, events, coverage, limit }) {
  const gaps = [];
  if (!binding) gaps.push("No workforce binding is active.");
  else if (binding.status === "REVOKED") {
    gaps.push("The workforce binding is revoked. History remains. New reports are refused.");
  }
  if (agents.some((agent) => !agent.displayName)) {
    gaps.push("One or more agents have no reported name.");
  }
  const windowComplete = events.length < limit;
  if (binding && windowComplete && !events.some((event) => event.kind === "freedom.report.work")) {
    gaps.push("There is no task list. Observed activity is events and turns.");
  }
  if (coverage === "self_report" || coverage === "none") {
    gaps.push("Liveness is inferred from the last observed event.");
  }
  return gaps;
}

export function createGrokBotRuntime({
  withUser = null,
  decrypt = openText,
  now = () => new Date(),
} = {}) {
  async function userScope(userId, fn) {
    if (withUser) return withUser(userId, fn);
    const { withUserContext } = await import("../../db/prisma.js");
    return withUserContext(userId, fn);
  }

  async function read(userId, query = {}) {
    if (typeof userId !== "string" || userId.trim() === "") {
      throw new Error("agent runtime requires a user");
    }
    const agentId = agentIdOf(query.agentId);
    const since = sinceOf(query.since);
    const limit = limitOf(query.limit);
    const at = query.now instanceof Date ? query.now : now();
    return userScope(userId, async (tx) => {
      const binding = await tx.workforceBinding.findUnique({ where: { userId } });
      const agentRows = binding ? await tx.observedAgent.findMany({ where: { userId } }) : [];
      const where = { userId };
      if (agentId) where.agentExternalId = agentId;
      if (since) where.occurredAt = { gte: since };
      const eventRows = binding
        ? await tx.activityEvent.findMany({
            where,
            orderBy: [{ occurredAt: "desc" }, { sequence: "desc" }],
            take: limit,
          })
        : [];
      const sourceRows = binding
        ? await tx.activityEvent.findMany({
            where: { userId },
            distinct: ["source"],
            select: { source: true },
          })
        : [];
      let unreadable = false;
      const events = eventRows
        .sort(byRecent)
        .slice(0, limit)
        .map((row) => {
          const viewed = eventView(row, decrypt);
          if (viewed.unreadable) unreadable = true;
          return viewed.event;
        });
      const agents = agentRows
        .map((row) => agentView(row, at))
        .sort((left, right) => {
          const l = left.lastEventAt ? new Date(left.lastEventAt).getTime() : 0;
          const r = right.lastEventAt ? new Date(right.lastEventAt).getTime() : 0;
          return r - l;
        });
      const coverage = describeCoverage(sourceRows.map((row) => row.source));
      const gaps = gapsFor({
        binding,
        agents,
        events,
        coverage: coverage.coverage,
        limit,
      });
      if (unreadable) gaps.push("Some report text could not be read.");
      return {
        binding,
        agents: agentId ? agents.filter((agent) => agent.id === agentId) : agents,
        events,
        coverage,
        gaps: gaps.slice(0, 4),
        asOf: at.toISOString(),
      };
    });
  }

  function pictureFrom(loaded) {
    const notableEvents = loaded.events.filter(notable);
    const recent = [];
    const seen = new Set();
    for (const event of [...notableEvents, ...loaded.events]) {
      if (seen.has(event.id) || recent.length >= RECENT_MAX) continue;
      seen.add(event.id);
      recent.push(event);
    }
    return {
      provider: "grokbot",
      effects: AGENT_EFFECTS,
      readOnly: true,
      asOf: loaded.asOf,
      bound: loaded.binding?.status === "ACTIVE",
      revoked: loaded.binding?.status === "REVOKED",
      coverage: loaded.coverage.coverage,
      coverageLine: loaded.coverage.line,
      agents: loaded.agents,
      recent,
      gaps: loaded.gaps,
    };
  }

  return {
    provider: "grokbot",
    effects: AGENT_EFFECTS,
    async listAgents(userId) {
      const loaded = await read(userId, { limit: 1 });
      return loaded.agents;
    },
    async getAgent(userId, agentId) {
      const loaded = await read(userId, { agentId, limit: DEFAULT_LIMIT });
      const agent = loaded.agents[0] ?? null;
      if (!agent) return null;
      return { ...agent, recent: loaded.events };
    },
    async listEvents(userId, query = {}) {
      const loaded = await read(userId, query);
      return loaded.events;
    },
    async picture(userId, query = {}) {
      return pictureFrom(await read(userId, query));
    },
  };
}
