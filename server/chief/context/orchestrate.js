// Read-only context above the memory provider.
//
// The provider still owns recall. This module decides which live systems and
// which memory scopes a question needs, reads only those, and labels every
// item with its source. It does not write facts, sessions, tools, or schedules.
// A missing reader is an unavailable source. It is not a guess.
// Current live state outranks historical memory for a current-state question.

import { conversationMove, MOVE } from "./behavior.js";
import { isSnapshotFact } from "../memory/qualify.js";
import { MEMORY_LAYER, authoritativeDomain, needsEpisodicMemory } from "../memory/retrieve.js";

export const CONTEXT_SCOPE = Object.freeze({
  WORKING: "working",
  PERSONAL: "personal",
  EPISODIC: "episodic",
  AGENT: "agent",
  DECISION: "decision",
  PREFERENCE: "preference",
  TEMPORAL: "temporal",
  RELATIONSHIP: "relationship",
});

export const TEMPORAL_STATE = Object.freeze({
  CURRENT: "current",
  RECENT: "recent",
  HISTORICAL: "historical",
  SCHEDULED: "scheduled",
  COMPLETED: "completed",
  PENDING: "pending",
  OVERDUE: "overdue",
});

const TEMPORAL_VALUES = new Set(Object.values(TEMPORAL_STATE));
const BEYOND_PROMPT = new Set([
  CONTEXT_SCOPE.EPISODIC,
  CONTEXT_SCOPE.AGENT,
  CONTEXT_SCOPE.DECISION,
  CONTEXT_SCOPE.RELATIONSHIP,
  CONTEXT_SCOPE.TEMPORAL,
]);

const HOLDING = /\b(owns?|owned|holds?|holding|holdings|balance|worth|bitcoin|btc|xrp|eth)\b/i;
const AGENT_TEXT = /\b(grok\s*bots?|agents?)\b/i;
const DECISION_TEXT = /\b(decid(?:e|ed|ing)|decision|agreed)\b/i;
const PREFERENCE_TEXT = /\b(prefer|preference)\b/i;
const RELATION_TEXT = /\b(related to|came from|because of|same issue)\b/i;

const LIVE = Object.freeze({
  finance: {
    source: "freedom_financial",
    sourceType: "live_financial_state",
    scope: CONTEXT_SCOPE.TEMPORAL,
    tools: ["finance_summary"],
    missing: "Freedom Financial is not connected. No current balances or holdings are available.",
    deferred:
      "No current Freedom Financial reading is in this context. Use the live finance tool. Do not answer current balances from memory.",
  },
  agents: {
    source: "grokbot",
    sourceType: "live_agent_state",
    scope: CONTEXT_SCOPE.AGENT,
    tools: [],
    missing: "Agent state is not connected. No current agent status is available.",
    deferred: "No current agent reading is in this context. Do not invent what an agent is doing.",
  },
  schedule: {
    source: "scheduler",
    sourceType: "live_schedule",
    scope: CONTEXT_SCOPE.TEMPORAL,
    tools: ["schedule_list", "schedule_runs"],
    missing: "Schedule state is not connected. No tasks are available.",
    deferred:
      "No current schedule reading is in this context. Use the live schedule tool. Do not invent tasks.",
  },
  calendar: {
    source: "calendar",
    sourceType: "live_calendar",
    scope: CONTEXT_SCOPE.TEMPORAL,
    tools: ["calendar_list"],
    missing: "Calendar is not connected. No events are available.",
    deferred: "No current calendar reading is in this context. Do not invent events.",
  },
  email: {
    source: "email",
    sourceType: "live_email",
    scope: CONTEXT_SCOPE.TEMPORAL,
    tools: ["email_search"],
    missing: "Email is not connected. No messages are available.",
    deferred: "No current email reading is in this context. Do not invent messages.",
  },
  web: {
    source: "web",
    sourceType: "live_web",
    scope: CONTEXT_SCOPE.TEMPORAL,
    tools: ["web_search"],
    missing: "Web search is not connected. No results are available.",
    deferred:
      "No web reading is in this context. Use the live web search tool. Do not invent sources.",
  },
  code: {
    source: "code",
    sourceType: "live_code",
    scope: CONTEXT_SCOPE.TEMPORAL,
    tools: ["code_read", "code_search", "code_tree"],
    missing: "Code reading is not connected. No source listing is available.",
    deferred:
      "No code reading is in this context. Use the live code reader. Do not invent file contents.",
  },
});

function unique(values) {
  const seen = new Set();
  const list = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    list.push(value);
  }
  return list;
}

function toolSet(availableTools) {
  if (availableTools == null) return null;
  return availableTools instanceof Set ? availableTools : new Set(availableTools);
}

function hasTool(tools, names) {
  if (!tools || names.length === 0) return false;
  return names.some((name) => tools.has(name));
}

function wantsHoldingValue(text) {
  if (/\bnet worth\b/i.test(text)) return false;
  return /\bworth\b/i.test(text);
}

function classifyQuery(query) {
  const text = String(query ?? "");
  const domain = authoritativeDomain(text);
  const episodic = needsEpisodicMemory(text);
  const decision = DECISION_TEXT.test(text);
  const agents = AGENT_TEXT.test(text);
  const schedule = /\b(schedul(?:e|ed|ing)|behind schedule|overdue)\b/i.test(text);
  const calendar = /\b(calendar|meeting|appointment)\b/i.test(text);
  const email = /\b(e-?mail|inbox)\b/i.test(text);
  const relationship = RELATION_TEXT.test(text);
  const live = [];
  if (domain === "finance") live.push("finance");
  if (domain === "web" || wantsHoldingValue(text)) live.push("web");
  if (domain === "code") live.push("code");
  if (agents) live.push("agents");
  if (schedule) live.push("schedule");
  if (calendar) live.push("calendar");
  if (email) live.push("email");

  const memory = [CONTEXT_SCOPE.WORKING];
  if (text.trim()) memory.push(CONTEXT_SCOPE.PERSONAL);
  if (episodic || decision || relationship || agents) memory.push(CONTEXT_SCOPE.EPISODIC);
  if (decision) memory.push(CONTEXT_SCOPE.DECISION);
  if (agents) memory.push(CONTEXT_SCOPE.AGENT);
  if (PREFERENCE_TEXT.test(text) || domain === "finance") memory.push(CONTEXT_SCOPE.PREFERENCE);
  if (relationship) memory.push(CONTEXT_SCOPE.RELATIONSHIP);
  if (schedule || calendar) memory.push(CONTEXT_SCOPE.TEMPORAL);

  const layers = [];
  if (memory.includes(CONTEXT_SCOPE.PERSONAL) || memory.includes(CONTEXT_SCOPE.PREFERENCE)) {
    layers.push(MEMORY_LAYER.PERSONAL);
  }
  if (memory.some((scope) => BEYOND_PROMPT.has(scope) && scope !== CONTEXT_SCOPE.TEMPORAL)) {
    layers.push(MEMORY_LAYER.EPISODIC);
  }

  return {
    live: unique(live),
    memory: unique(memory),
    layers: unique(layers),
    currentState: live.length > 0,
  };
}

function inheritedLive(priorUserTexts) {
  for (const text of priorUserTexts ?? []) {
    const earlier = classifyQuery(text);
    if (earlier.live.length === 0) continue;
    if (wantsHoldingValue(text)) return earlier.live.filter((system) => system !== "web");
    return earlier.live;
  }
  return [];
}

export function planContext(query, options = {}) {
  const planned = classifyQuery(query);
  if (!Array.isArray(options?.transcript)) return planned;
  const move = conversationMove(options.transcript, query);
  if (move.kind === MOVE.ACKNOWLEDGE) {
    return {
      live: [],
      memory: [CONTEXT_SCOPE.WORKING],
      layers: [],
      currentState: false,
    };
  }
  if ((move.kind === MOVE.CONTINUE || move.kind === MOVE.CONFIRM) && planned.live.length === 0) {
    let live = inheritedLive(move.priorUserTexts);
    if (move.pullsPublicSource) live = unique([...live, "web"]);
    return {
      ...planned,
      live,
      currentState: live.length > 0,
    };
  }
  return planned;
}

function blankItem(fields) {
  return {
    source: fields.source,
    sourceType: fields.sourceType,
    temporalState: fields.temporalState,
    occurredAt: fields.occurredAt ?? null,
    text: fields.text,
    sourceId: fields.sourceId ?? null,
    trust: fields.trust,
    scope: fields.scope,
    available: fields.available !== false,
    superseded: fields.superseded === true,
    relatesTo: fields.relatesTo ?? [],
    origin: fields.origin,
  };
}

function stamp(value) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function temporalStateForSchedule(record, now = new Date()) {
  const status = String(record?.status ?? "").toLowerCase();
  if (status === "completed" || status === "succeeded" || status === "done") {
    return TEMPORAL_STATE.COMPLETED;
  }
  if (!record?.dueAt) {
    return status === "pending" || status === "waiting"
      ? TEMPORAL_STATE.PENDING
      : TEMPORAL_STATE.SCHEDULED;
  }
  const due = new Date(record.dueAt);
  if (Number.isNaN(due.getTime())) return TEMPORAL_STATE.SCHEDULED;
  if (due.getTime() < now.getTime()) return TEMPORAL_STATE.OVERDUE;
  return TEMPORAL_STATE.SCHEDULED;
}

function relatesTo(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function liveItem(system, raw, now) {
  const spec = LIVE[system];
  const text = String(raw?.text ?? "")
    .trim()
    .slice(0, 500);
  if (!text) return null;
  let temporal = TEMPORAL_VALUES.has(raw?.temporalState)
    ? raw.temporalState
    : TEMPORAL_STATE.CURRENT;
  if (system === "schedule" || system === "calendar") {
    temporal = TEMPORAL_VALUES.has(raw?.temporalState)
      ? raw.temporalState
      : temporalStateForSchedule(raw, now);
  }
  return blankItem({
    source: raw?.source || spec.source,
    sourceType: raw?.sourceType || spec.sourceType,
    temporalState: temporal,
    occurredAt: stamp(raw?.occurredAt),
    text,
    sourceId: raw?.sourceId ?? null,
    trust: raw?.trust ?? "live",
    scope: raw?.scope || spec.scope,
    available: true,
    relatesTo: relatesTo(raw?.relatesTo),
    origin: "live",
  });
}

function unavailableItem(system, tools) {
  const spec = LIVE[system];
  const deferred = hasTool(tools, spec.tools);
  return blankItem({
    source: spec.source,
    sourceType: spec.sourceType,
    temporalState: TEMPORAL_STATE.CURRENT,
    text: deferred ? spec.deferred : spec.missing,
    trust: deferred ? "tool" : "unavailable",
    scope: spec.scope,
    available: false,
    origin: "live",
  });
}

function memoryScope(hit) {
  const text = String(hit?.text ?? "");
  if (hit?.layer === MEMORY_LAYER.WORKING) return CONTEXT_SCOPE.WORKING;
  if (PREFERENCE_TEXT.test(text)) return CONTEXT_SCOPE.PREFERENCE;
  if (DECISION_TEXT.test(text)) return CONTEXT_SCOPE.DECISION;
  if (AGENT_TEXT.test(text)) return CONTEXT_SCOPE.AGENT;
  if (RELATION_TEXT.test(text)) return CONTEXT_SCOPE.RELATIONSHIP;
  if (hit?.layer === MEMORY_LAYER.EPISODIC) return CONTEXT_SCOPE.EPISODIC;
  return CONTEXT_SCOPE.PERSONAL;
}

function memorySource(scope, layer) {
  if (layer === MEMORY_LAYER.EPISODIC) {
    return { source: "chief_session", sourceType: "episodic_memory" };
  }
  if (scope === CONTEXT_SCOPE.PREFERENCE) return { source: "chief_fact", sourceType: "preference" };
  if (scope === CONTEXT_SCOPE.DECISION) return { source: "chief_fact", sourceType: "decision" };
  return { source: "chief_fact", sourceType: "personal_memory" };
}

function memoryItem(hit) {
  const text = String(hit?.text ?? "")
    .trim()
    .slice(0, 500);
  if (!text) return null;
  const scope = memoryScope(hit);
  const named = memorySource(scope, hit?.layer);
  return blankItem({
    source: named.source,
    sourceType: named.sourceType,
    temporalState:
      scope === CONTEXT_SCOPE.PREFERENCE ? TEMPORAL_STATE.CURRENT : TEMPORAL_STATE.HISTORICAL,
    text,
    sourceId: hit?.sourceId ?? null,
    trust: "memory",
    scope,
    origin: "memory",
  });
}

async function searchMemory(memory, query, scope) {
  if (!memory || typeof memory.search !== "function") return [];
  try {
    const rows = await memory.search(query, scope);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function readSystem(system, reader, ctx, tools) {
  if (typeof reader !== "function") return [unavailableItem(system, tools)];
  try {
    const result = await reader(ctx);
    const rows = Array.isArray(result) ? result : result == null ? [] : [result];
    const items = rows.map((row) => liveItem(system, row, ctx.now)).filter(Boolean);
    if (items.length === 0) return [unavailableItem(system, tools)];
    return items;
  } catch {
    return [unavailableItem(system, tools)];
  }
}

function demote(items, plan) {
  const liveFinance = items.some(
    (item) => item.origin === "live" && item.available && item.source === LIVE.finance.source
  );
  const liveAgents = items.some(
    (item) =>
      item.origin === "live" &&
      item.available &&
      (item.sourceType === LIVE.agents.sourceType || item.source === LIVE.agents.source)
  );
  return items.map((item) => {
    if (item.origin !== "memory" || item.scope === CONTEXT_SCOPE.PREFERENCE) return item;
    const financeConflict =
      plan.live.includes("finance") && (isSnapshotFact(item.text) || HOLDING.test(item.text));
    const agentConflict = plan.live.includes("agents") && AGENT_TEXT.test(item.text);
    if (!financeConflict && !agentConflict) return item;
    return {
      ...item,
      temporalState: TEMPORAL_STATE.HISTORICAL,
      superseded: financeConflict ? liveFinance : liveAgents,
    };
  });
}

function authorityFor(items, plan) {
  if (plan.currentState) {
    return items.filter((item) => item.origin === "live" && item.available && !item.superseded);
  }
  return items.filter((item) => item.origin === "memory" && item.available && !item.superseded);
}

export async function orchestrateContext({
  query = "",
  userId = null,
  sessionId = null,
  transcript = null,
  memory = null,
  readers = {},
  availableTools = null,
  now = new Date(),
} = {}) {
  const plan = planContext(query, { transcript });
  const tools = toolSet(availableTools);
  const beyond = plan.memory.some((scope) => BEYOND_PROMPT.has(scope));
  if (!userId || (plan.live.length === 0 && !beyond)) {
    return {
      readOnly: true,
      query: String(query ?? ""),
      plan,
      items: [],
      authority: [],
      unavailable: [],
    };
  }
  const items = [];
  const unavailable = [];
  const ctx = { userId, query, sessionId, now };
  for (const system of plan.live) {
    const read = await readSystem(system, readers?.[system], ctx, tools);
    for (const item of read) {
      items.push(item);
      if (!item.available) unavailable.push(system);
    }
  }
  if (plan.layers.length > 0) {
    const hits = await searchMemory(memory, query, {
      userId,
      sessionId,
      layers: plan.layers,
    });
    const allowedLayers = new Set(plan.layers);
    for (const hit of hits) {
      if (hit?.layer && !allowedLayers.has(hit.layer)) continue;
      if (hit?.layer === MEMORY_LAYER.EPISODIC && sessionId && hit.sourceId === sessionId) continue;
      if (hit?.layer === MEMORY_LAYER.WORKING) continue;
      const item = memoryItem(hit);
      if (item) items.push(item);
    }
  }
  const merged = demote(items, plan).slice(0, 12);
  return {
    readOnly: true,
    query: String(query ?? ""),
    plan,
    items: merged,
    authority: authorityFor(merged, plan),
    unavailable: unique(unavailable),
  };
}

function renderLine(item) {
  const when = item.occurredAt ? `, ${item.occurredAt}` : "";
  const id = item.sourceId ? `, id ${item.sourceId}` : "";
  const links = item.relatesTo?.length ? `, relatesTo ${item.relatesTo.join(" ")}` : "";
  const label = !item.available
    ? "Unavailable"
    : item.superseded
      ? "Historical, not current"
      : item.origin === "live"
        ? "Current"
        : item.scope === CONTEXT_SCOPE.PREFERENCE
          ? "Standing preference"
          : "Historical context";
  return `${label} (${item.source}, ${item.sourceType}, ${item.temporalState}, trust ${item.trust}${id}${when}${links}): ${item.text}`;
}

export function shouldRenderContextItem(item) {
  if (!item || item.scope === CONTEXT_SCOPE.WORKING) return false;
  if (item.origin === "live" || item.available === false || item.superseded) return true;
  return item.scope !== CONTEXT_SCOPE.PERSONAL;
}

export function renderContextPackage(pack) {
  const lines = (pack?.items ?? []).filter(shouldRenderContextItem).slice(0, 8).map(renderLine);
  if (lines.length === 0) return "";
  return [
    "Connected context is read-only reference. Current live readings override historical memory. An unavailable source has no data.",
    ...lines,
  ].join("\n");
}
