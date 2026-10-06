// Read-only view of the workforce observation journal.
//
// ObservedAgent and ActivityEvent are the source of truth. This module does
// not append, rename, schedule, or command an agent. Liveness is recomputed
// at read time. An old event is history, not current status.

import { decrypt as openSealedText } from "../../security/envelope.js";
import { withUserContext } from "../../db/prisma.js";
import {
  LIVENESS,
  describeCoverage,
  livenessAt,
  normalizeSourceToken,
} from "./journal.js";

export const WORKFORCE_UNAVAILABLE_LINE = "I don't have live agent status connected yet.";

const TEXT_CAP = 160;
const SUMMARY_ACTIVITY = 3;
const AGENT_ACTIVITY = 5;
const HISTORY_CAP = 8;
const AGENT_CAP = 24;

const FAILED = new Set(["failure", "failed", "error", "errored"]);
const COMPLETED = new Set(["success", "succeeded", "completed", "complete", "done", "ok"]);
const RUNNING = new Set(["in_progress", "running", "working", "active", "started"]);
const FILTER_SKIP = new Set(["the", "bot", "bots", "agent", "agents", "one"]);

function unavailableReading(now) {
  return {
    connected: false,
    telemetry: "unavailable",
    reason: "unavailable",
    line: WORKFORCE_UNAVAILABLE_LINE,
    coverage: null,
    agents: [],
    asOf: now.toISOString(),
    writeAccess: false,
  };
}

function parseTime(value) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function statusToken(liveness) {
  if (liveness === LIVENESS.ACTIVE) return "active";
  if (liveness === LIVENESS.IDLE) return "idle";
  if (liveness === LIVENESS.STALE) return "stale";
  return "unknown";
}

function trustToken(value) {
  if (value === "UNTRUSTED" || value === "untrusted") return "untrusted";
  if (value === "PLATFORM" || value === "platform") return "platform";
  return null;
}

function sourceToken(value) {
  try {
    return normalizeSourceToken(value);
  } catch {
    return null;
  }
}

function clip(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.slice(0, TEXT_CAP);
}

function openText(ciphertext, decrypt) {
  if (!ciphertext || typeof decrypt !== "function") return null;
  try {
    return clip(decrypt(ciphertext));
  } catch {
    return null;
  }
}

function outcomeOf(coded) {
  if (!coded || typeof coded !== "object" || Array.isArray(coded)) return null;
  const raw = coded.outcome ?? coded.status ?? null;
  if (typeof raw !== "string") return null;
  const token = raw.trim().toLowerCase();
  if (FAILED.has(token)) return "failed";
  if (COMPLETED.has(token)) return "completed";
  if (RUNNING.has(token)) return "in_progress";
  return null;
}

function taskOf(coded, text) {
  if (coded && typeof coded === "object" && !Array.isArray(coded)) {
    for (const key of ["task", "summary", "title", "work"]) {
      const task = clip(coded[key]);
      if (task) return task;
    }
  }
  return text;
}

function isWork(kind) {
  return kind === "freedom.report.work" || (typeof kind === "string" && kind.startsWith("cursor."));
}

function matchesAgent(agent, query) {
  const needle = String(query ?? "")
    .trim()
    .toLowerCase();
  if (!needle) return true;
  const hay = [agent.externalId, agent.displayName, agent.role]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" ")
    .toLowerCase();
  if (hay.includes(needle)) return true;
  const words = needle
    .split(/\s+/)
    .filter((word) => word.length > 2 && !FILTER_SKIP.has(word));
  return words.length > 0 && words.every((word) => hay.includes(word));
}

function inWindow(event, since, before) {
  const at = new Date(event.occurredAt).getTime();
  if (Number.isNaN(at)) return false;
  if (since && at < since.getTime()) return false;
  if (before && at >= before.getTime()) return false;
  return true;
}

function activityItem(event, decrypt) {
  const text = openText(event.textCiphertext, decrypt);
  const outcome = outcomeOf(event.coded);
  const at = new Date(event.occurredAt);
  return {
    kind: event.kind,
    outcome,
    at: Number.isNaN(at.getTime()) ? null : at.toISOString(),
    text: text ?? taskOf(event.coded, null),
    source: sourceToken(event.source),
    trust: trustToken(event.trust),
  };
}

function projectRead(agent, events, { now, decrypt, activityLimit }) {
  const ordered = [...events].sort(
    (left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime()
  );
  const liveness = livenessAt(agent.lastEventAt, now);
  const status = statusToken(liveness);
  const newestWork = ordered.find((event) => isWork(event.kind)) ?? null;
  let latestOutcome = null;
  let latestOutcomeCurrent = false;
  let latestOutcomeAt = null;
  if (newestWork) {
    const stamped = livenessAt(newestWork.occurredAt, now) === LIVENESS.ACTIVE;
    const outcome = outcomeOf(newestWork.coded);
    latestOutcome = outcome ?? (stamped ? "in_progress" : null);
    latestOutcomeCurrent = stamped && latestOutcome != null;
    const at = new Date(newestWork.occurredAt);
    latestOutcomeAt = Number.isNaN(at.getTime()) ? null : at.toISOString();
  }
  const workText = newestWork ? openText(newestWork.textCiphertext, decrypt) : null;
  const task = newestWork ? taskOf(newestWork.coded, workText) : null;
  let currentWork = null;
  let currentFailure = null;
  if (latestOutcomeCurrent && latestOutcome === "in_progress" && latestOutcomeAt) {
    const started = new Date(latestOutcomeAt).getTime();
    const elapsedSeconds = Number.isNaN(started)
      ? null
      : Math.max(0, Math.round((now.getTime() - started) / 1000));
    currentWork = {
      task,
      status: "in_progress",
      startedAt: latestOutcomeAt,
      elapsedSeconds,
    };
  } else if (latestOutcomeCurrent && latestOutcome === "failed") {
    currentFailure = { task, at: latestOutcomeAt };
  }
  const recent = ordered.slice(0, activityLimit).map((event) => activityItem(event, decrypt));
  return {
    id: agent.externalId,
    name: clip(agent.displayName),
    role: clip(agent.role),
    status,
    identityTrust: trustToken(agent.identityTrust),
    lastActivityAt: agent.lastEventAt ? new Date(agent.lastEventAt).toISOString() : null,
    latestOutcome,
    latestOutcomeAt,
    latestOutcomeCurrent,
    currentWork,
    currentFailure,
    recentActivity: recent,
    activity: recent.length > 0 ? "available" : "none",
  };
}

export async function readWorkforce(
  tx,
  userId,
  { decrypt = openSealedText, now = new Date(), agent = null, since = null, before = null } = {}
) {
  const at = now instanceof Date ? now : new Date(now);
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    return unavailableReading(new Date());
  }
  if (typeof userId !== "string" || userId.trim() === "") return unavailableReading(at);
  const binding = await tx.workforceBinding.findUnique({ where: { userId } });
  if (!binding || binding.status !== "ACTIVE") return unavailableReading(at);

  const agents = await tx.observedAgent.findMany({ where: { userId } });
  const events = await tx.activityEvent.findMany({ where: { userId } });
  const coverage = describeCoverage((events ?? []).map((event) => event.source));
  const windowStart = parseTime(since);
  const windowEnd = parseTime(before);
  const filtered = (agents ?? []).filter((row) => matchesAgent(row, agent)).sort((left, right) => {
    const leftAt = left.lastEventAt ? new Date(left.lastEventAt).getTime() : 0;
    const rightAt = right.lastEventAt ? new Date(right.lastEventAt).getTime() : 0;
    return rightAt - leftAt;
  });
  const activityLimit = agent ? AGENT_ACTIVITY : SUMMARY_ACTIVITY;
  const byAgent = new Map();
  for (const event of events ?? []) {
    const list = byAgent.get(event.agentExternalId) ?? [];
    list.push(event);
    byAgent.set(event.agentExternalId, list);
  }
  const projected = filtered.slice(0, AGENT_CAP).map((row) => {
    const owned = byAgent.get(row.externalId) ?? [];
    const view = projectRead(row, owned, { now: at, decrypt, activityLimit });
    const history = owned
      .filter((event) => inWindow(event, windowStart, windowEnd))
      .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())
      .slice(0, HISTORY_CAP)
      .map((event) => activityItem(event, decrypt));
    return {
      ...view,
      history,
      historyWindow: windowStart || windowEnd ? "bounded" : "recent",
    };
  });

  if ((agents ?? []).length === 0) {
    return {
      connected: true,
      telemetry: coverage.coverage,
      reason: "no_agents",
      line: coverage.line,
      coverage: coverage.coverage,
      agents: [],
      asOf: at.toISOString(),
      writeAccess: false,
    };
  }
  if (agent && projected.length === 0) {
    return {
      connected: true,
      telemetry: coverage.coverage,
      reason: "no_match",
      line: "No observed agent matches that name.",
      coverage: coverage.coverage,
      agents: [],
      asOf: at.toISOString(),
      writeAccess: false,
    };
  }
  return {
    connected: true,
    telemetry: coverage.coverage,
    reason: "ok",
    line: coverage.line,
    coverage: coverage.coverage,
    agents: projected,
    asOf: at.toISOString(),
    writeAccess: false,
  };
}

export async function readWorkforceJournal(userId, options = {}) {
  const { withUser = withUserContext, ...rest } = options;
  return withUser(userId, (tx) => readWorkforce(tx, userId, rest));
}
