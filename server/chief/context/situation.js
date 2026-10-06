// Turn-time situational reading.
//
// Derived from the live tool payloads and context items already selected.
// It does not store a world model, write memory, or call a tool.

import { messageText } from "../runtime/compaction.js";
import { WORKFORCE_UNAVAILABLE_LINE } from "../workforce/read.js";
import {
  bestLink,
  collectPriorities,
  followupKind,
  rankLinks,
  relevanceAnswer,
  relevanceClause,
  relevanceFollowup,
} from "./relevance.js";

export const QUIET_LINE = "Nothing major stands out right now.";
export const QUIET_FAILURES = "Nothing is failing in the workforce or schedules I can read.";
export const UNCHECKED_LINE = "I don't have a current reading for that yet.";

const SOON_MS = 24 * 60 * 60 * 1000;
const SPEND_SHIFT_PCT = 25;
const SPEND_SHIFT_DOLLARS = 100;
const OVER_BUDGET_DOLLARS = 100;

const ATTENTION_TEXT =
  /\b(?:paying attention|pay attention|needs attention|biggest thing|should know right now|what matters right now)\b/i;
const FAILURE_TEXT = /\b(?:anything failing|is anything fail(?:ing|ed)?|what(?:'s| is) failing)\b/i;
const DELTA_TEXT =
  /\bwhat(?:'s| has)? changed\b/i;
const DELTA_WHEN = /\b(?:today|since|yesterday)\b/i;
const AGENT_DAY =
  /\b(?:doing|working|going on|up to)\b/i;
const REVIEW_WHEN = /\b(?:still|anymore|today|right now|currently|where i am now)\b/i;
const REVIEW_INTENT = /\b(?:make sense|compare|comparison|changed|worth it|hold up|good idea)\b/i;
const URGENCY =
  /\b(?:very concerned|urgent(?:ly)?|alarming|emergency|disaster|immediately|critical)\b/i;
const FEAR = /\b(?:should be concerned|you should worry|worry about)\b/i;
const CONSEQUENCE = /\b(?:will be delayed|you should sell|still holds|still makes sense)\b/i;
const WRITE_CLAIM =
  /\bI (?:restarted|paused|cancelled|canceled|sent|edited|deleted|updated|changed) (?:the|your|that|an)\b/i;

const SITUATION_READS = new Set([
  "workforce_status",
  "finance_summary",
  "schedule_list",
  "schedule_runs",
  "schedule_outcome",
  "conversation_search",
  "conversation_retrieve",
  "memory_read",
  "kg_lookup",
]);

export function attentionQuery(text) {
  return ATTENTION_TEXT.test(String(text ?? ""));
}

export function failureQuery(text) {
  return FAILURE_TEXT.test(String(text ?? ""));
}

export function recentDelta(text) {
  const raw = String(text ?? "");
  return DELTA_TEXT.test(raw) && DELTA_WHEN.test(raw);
}

export function agentDayQuery(text) {
  const raw = String(text ?? "");
  return /\b(?:grok\s*bots?|agents?|bots?)\b/i.test(raw) && /\btoday\b/i.test(raw) && AGENT_DAY.test(raw);
}

export function reviewQuery(text) {
  const raw = String(text ?? "");
  return REVIEW_WHEN.test(raw) && REVIEW_INTENT.test(raw);
}

export function situationKind(text) {
  if (attentionQuery(text)) return "attention";
  if (failureQuery(text)) return "failures";
  if (recentDelta(text)) return "delta";
  if (/\bwhat(?:'s| is) going on\b/i.test(String(text ?? "")) && /\b(?:grok\s*bots?|agents?|bots?)\b/i.test(text)) {
    return "workforce";
  }
  if (agentDayQuery(text) || (/\b(?:what are|what're)\b/i.test(text) && /\b(?:grok\s*bots?|agents?|bots?)\b/i.test(text))) {
    return "workforce";
  }
  if (reviewQuery(text)) return "review";
  return null;
}

export function situationHint(query) {
  if (relevanceFollowup(query)) {
    return "Relevance: use the signals already read and any stated priority. A connection is inferred. Do not store the signal as a goal.";
  }
  const kind = situationKind(query);
  if (kind === "review") {
    return "State the earlier decision and the current reading separately. Do not say the decision still holds unless the current reading supports it.";
  }
  if (!kind) return "";
  return "Situational reading: lead with what stands out. Leave out normal activity unless the user asked what is going on. Do not add urgency that is not in the evidence. Answer only from the sources in this reading.";
}

export function keepSituationTools(calls) {
  return (Array.isArray(calls) ? calls : []).filter((call) => SITUATION_READS.has(call?.name));
}

function clip(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function label(agent) {
  return clip(agent?.name) || clip(agent?.id) || "An agent";
}

function sameDay(value, now) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

function toolPayloads(transcript) {
  const found = [];
  const messages = Array.isArray(transcript) ? transcript : [];
  for (const message of messages) {
    if (message?.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type !== "tool-result") continue;
      const raw = String(part.output?.value ?? "");
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
      found.push({ name: part.toolName, payload, raw });
    }
  }
  return found;
}

function push(signals, rank, source, text) {
  const line = clip(text);
  if (!line) return;
  signals.push({ rank, source, text: line });
}

function workforceSignals(payload, { kind, now }) {
  const signals = [];
  if (!payload || payload.connected === false) return { signals, unavailable: true, agents: [] };
  const agents = Array.isArray(payload.agents) ? payload.agents : [];
  for (const agent of agents) {
    if (agent?.currentFailure) {
      const task = clip(agent.currentFailure.task) || "the latest run failed";
      push(signals, 0, "agents", `${label(agent)} failed: ${task}`);
      continue;
    }
    if (kind === "delta") {
      const today = (agent.recentActivity ?? agent.history ?? []).find((item) => sameDay(item?.at, now));
      if (today?.outcome === "failed") {
        push(signals, 0, "agents", `${label(agent)} failed today: ${clip(today.text || today.outcome)}`);
      } else if (today?.outcome === "completed") {
        push(signals, 2, "agents", `${label(agent)} completed ${clip(today.text) || "work"} today`);
      }
      continue;
    }
    if (agent?.status === "stale" && kind !== "failures") {
      push(signals, 2, "agents", `${label(agent)} is stale, which is not a current failure`);
    }
  }
  return { signals, unavailable: false, agents };
}

function workforceBrief(agents, signals) {
  const active = agents.filter((agent) => agent?.status === "active" && agent.currentWork && !agent.currentFailure);
  const idle = agents.filter((agent) => agent?.status === "idle");
  for (const agent of active.slice(0, 2)) {
    push(signals, 2, "agents", `${label(agent)} is working on ${clip(agent.currentWork.task) || "a current task"}`);
  }
  if (idle.length === 1) push(signals, 3, "agents", `${label(idle[0])} is idle`);
  else if (idle.length > 1) push(signals, 3, "agents", `${idle.length} agents are idle`);
}

function financeSignals(payload, kind) {
  const signals = [];
  if (!payload || typeof payload !== "object") return { signals, unavailable: false, checked: false };
  const position = payload.position ?? null;
  const activity = payload.activity ?? null;
  const positionDown = !position || position.status === "unavailable";
  const activityDown = !activity || activity.status === "unavailable";
  if (positionDown && activityDown) return { signals, unavailable: true, checked: true };
  if (kind === "delta") return { signals, unavailable: false, checked: true };
  const count = Number(activity?.plaid?.requiresAttentionCount);
  if (Number.isFinite(count) && count > 0) {
    push(
      signals,
      0,
      "finance",
      count === 1
        ? "A linked finance connection needs attention"
        : `${count} linked finance connections need attention`
    );
  }
  const deltas = Array.isArray(activity?.categoryDeltas) ? activity.categoryDeltas : [];
  let best = null;
  for (const row of deltas) {
    const pct = Number(row?.momChangePct);
    const latest = Number(row?.latestTotal);
    const previous = Number(row?.previousTotal);
    if (!Number.isFinite(pct) || Math.abs(pct) < SPEND_SHIFT_PCT) continue;
    if (!Number.isFinite(latest) || !Number.isFinite(previous)) continue;
    const swing = Math.abs(latest - previous);
    if (swing < SPEND_SHIFT_DOLLARS) continue;
    if (!best || swing > best.swing) best = { row, pct, swing };
  }
  if (best) {
    const direction = best.pct > 0 ? "up" : "down";
    push(
      signals,
      2,
      "finance",
      `${best.row.category} is ${direction} ${Math.abs(best.pct)}% from last month`
    );
  }
  const spent = Number(position?.currentMonth?.spent);
  const budget = Number(position?.currentMonth?.budget);
  if (Number.isFinite(spent) && Number.isFinite(budget) && spent - budget >= OVER_BUDGET_DOLLARS) {
    push(signals, 2, "finance", `This month's spending is ${Math.round(spent - budget)} over the budget`);
  }
  return { signals, unavailable: false, checked: true };
}

function taskName(tasks, id) {
  const task = (tasks ?? []).find((row) => row?.id === id);
  return clip(task?.name) || "";
}

function scheduleSignals(tasksPayload, runsPayload, { kind, now }) {
  const signals = [];
  const tasks = Array.isArray(tasksPayload?.tasks)
    ? tasksPayload.tasks
    : Array.isArray(tasksPayload)
      ? tasksPayload
      : [];
  const runs = Array.isArray(runsPayload?.runs) ? runsPayload.runs : [];
  const checked = Boolean(tasksPayload) || Boolean(runsPayload);
  const failed = new Map();
  for (const run of runs) {
    const status = String(run?.status ?? "").toUpperCase();
    if (status !== "FAILED") continue;
    if (kind === "delta" && !sameDay(run.completedAt || run.startedAt, now)) continue;
    const key = run?.scheduledTaskId || run?.id || "schedule";
    const list = failed.get(key) ?? [];
    list.push(run);
    failed.set(key, list);
  }
  for (const [id, list] of failed) {
    const name = taskName(tasks, id) || "A schedule";
    const text = list.length > 1 ? `${name} has ${list.length} failed runs` : `${name} has a failed run`;
    push(signals, 0, "schedule", text);
  }
  if (kind === "delta") {
    for (const run of runs) {
      const status = String(run?.status ?? "").toUpperCase();
      if (status !== "SUCCEEDED" || !sameDay(run.completedAt || run.startedAt, now)) continue;
      const name = taskName(tasks, run.scheduledTaskId) || "A schedule";
      push(signals, 2, "schedule", `${name} completed a run today`);
    }
    return { signals, checked };
  }
  if (kind === "failures") return { signals, checked };
  let overdue = null;
  let upcoming = null;
  let paused = null;
  for (const task of tasks) {
    const status = String(task?.status ?? "").toUpperCase();
    if (status === "PAUSED" && !paused) paused = task;
    if (status !== "ACTIVE" || !task?.nextRunAt) continue;
    const at = new Date(task.nextRunAt).getTime();
    if (Number.isNaN(at)) continue;
    if (at < now.getTime()) {
      if (!overdue || at < new Date(overdue.nextRunAt).getTime()) overdue = task;
    } else if (at - now.getTime() <= SOON_MS) {
      if (!upcoming || at < new Date(upcoming.nextRunAt).getTime()) upcoming = task;
    }
  }
  if (overdue) push(signals, 1, "schedule", `${clip(overdue.name) || "A schedule"} was due at ${overdue.nextRunAt}`);
  if (upcoming) {
    push(signals, 2, "schedule", `${clip(upcoming.name) || "A schedule"} is scheduled next at ${upcoming.nextRunAt}`);
  }
  if (paused && kind === "attention") {
    push(signals, 2, "schedule", `${clip(paused.name) || "A schedule"} is paused`);
  }
  return { signals, checked };
}

function proseSignals(items, kind) {
  const signals = [];
  for (const item of items ?? []) {
    if (!item || item.available === false || item.origin !== "live") continue;
    const text = clip(item.text);
    if (!text) continue;
    if (item.source === "grokbot" && /\bfail(?:ed|ure)\b/i.test(text)) {
      push(signals, 0, "agents", text);
    } else if (item.source === "grokbot" && /\bstale\b/i.test(text) && kind !== "failures") {
      push(signals, 2, "agents", text);
    } else if (item.source === "scheduler" && /\bfail(?:ed|ure)\b/i.test(text)) {
      push(signals, 0, "schedule", text);
    } else if (item.source === "freedom_financial" && /\b(?:up|down) \d+(?:\.\d+)?%/i.test(text) && kind !== "delta") {
      push(signals, 2, "finance", text);
    }
  }
  return signals;
}

function todayConversations(items, now) {
  const signals = [];
  for (const item of items ?? []) {
    if (item?.origin !== "memory" || item.available === false) continue;
    if (!sameDay(item.occurredAt, now)) continue;
    push(signals, 2, "conversation", clip(item.text));
  }
  return signals;
}

function standoutLine(signals, { linkedSchedule, includeNormal }) {
  const shown = signals
    .filter((signal) => includeNormal || signal.rank < 3)
    .slice(0, includeNormal ? 4 : 3);
  if (shown.length === 0) return "";
  const parts = shown.map((signal) => String(signal.text).replace(/[.!\s]+$/g, ""));
  let line = parts.length === 1 ? `${parts[0]}.` : `${parts.length === 2 ? "Two" : parts.length === 3 ? "Three" : "Four"} things stand out: ${parts.join(". ")}.`;
  if (
    linkedSchedule &&
    shown.some((signal) => signal.source === "schedule") &&
    shown.some((signal) => signal.source === "agents")
  ) {
    line = `${line} That schedule is not linked to an agent in the data I have.`;
  }
  return line;
}

export function synthesizeSituation({ query = "", transcript = null, items = [], now = new Date() } = {}) {
  const kind = situationKind(query);
  if (!kind || kind === "review") return null;
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const payloads = toolPayloads(transcript);
  const workforcePayload = payloads.find((row) => row.name === "workforce_status")?.payload ?? null;
  const financePayload = payloads.find((row) => row.name === "finance_summary")?.payload ?? null;
  const tasksPayload = payloads.find((row) => row.name === "schedule_list")?.payload ?? null;
  const runsPayload = payloads.find((row) => row.name === "schedule_runs")?.payload ?? null;
  const wantsSchedule = kind === "attention" || kind === "delta" || kind === "failures" || agentDayQuery(query);
  const workforce = workforcePayload
    ? workforceSignals(workforcePayload, { kind, now: at })
    : { signals: [], unavailable: false, agents: [] };
  if (kind === "workforce" && workforcePayload?.connected !== false) {
    workforceBrief(workforce.agents, workforce.signals);
  }
  const finance = financePayload ? financeSignals(financePayload, kind) : { signals: [], unavailable: false, checked: false };
  const schedule = wantsSchedule
    ? scheduleSignals(tasksPayload, runsPayload, { kind, now: at })
    : { signals: [], checked: false };
  const structured = workforcePayload || financePayload || tasksPayload || runsPayload;
  const signals = structured
    ? [...workforce.signals, ...finance.signals, ...schedule.signals]
    : proseSignals(items, kind);
  if (kind === "delta") signals.push(...todayConversations(items, at));
  signals.sort((left, right) => left.rank - right.rank);
  const visible = signals.filter((signal) => kind === "workforce" || signal.rank < 3);

  const checked = {
    agents: Boolean(workforcePayload) || (items ?? []).some((item) => item?.source === "grokbot" && item.origin === "live"),
    finance: finance.checked || (items ?? []).some((item) => item?.source === "freedom_financial" && item.origin === "live"),
    schedule: schedule.checked || (items ?? []).some((item) => item?.source === "scheduler" && item.origin === "live"),
  };
  const required =
    kind === "failures"
      ? ["agents", "schedule"]
      : kind === "workforce"
        ? wantsSchedule
          ? ["agents", "schedule"]
          : ["agents"]
        : ["finance", "agents", "schedule"];
  const unchecked = required.filter((source) => !checked[source]);
  let line = standoutLine(visible, {
    linkedSchedule: kind === "workforce" && wantsSchedule,
    includeNormal: kind === "workforce",
  });
  if (kind === "workforce" && workforce.unavailable) {
    line = line ? `${WORKFORCE_UNAVAILABLE_LINE} ${line}` : WORKFORCE_UNAVAILABLE_LINE;
  } else if (!line && workforce.unavailable && (kind === "attention" || kind === "failures" || kind === "delta")) {
    line = WORKFORCE_UNAVAILABLE_LINE;
  } else if (!line && finance.unavailable && (kind === "attention" || kind === "delta")) {
    line = "Freedom Financial isn't available in this reading.";
  } else if (!line && unchecked.length > 0) {
    line = UNCHECKED_LINE;
  } else if (!line) {
    line = kind === "failures" ? QUIET_FAILURES : QUIET_LINE;
  }
  const priorities = collectPriorities({ items, transcript });
  const link = bestLink(
    visible.filter((signal) => signal.rank < 3),
    priorities
  );
  const quiet =
    !line ||
    line === QUIET_LINE ||
    line === QUIET_FAILURES ||
    line === UNCHECKED_LINE ||
    line === WORKFORCE_UNAVAILABLE_LINE ||
    line.startsWith("Freedom Financial");
  const clause = !quiet && link ? relevanceClause(link) : "";
  return {
    kind,
    signals: visible.filter((signal) => signal.rank < 3 || kind === "workforce").slice(0, 4),
    unchecked,
    line: clause ? `${line} ${clause}` : line,
    relevant: clause ? link.priority.text : null,
    readOnly: true,
  };
}

function covers(answer, signal) {
  const words = String(signal?.text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9%]+/)
    .filter((word) => word.length > 3);
  const hay = String(answer ?? "").toLowerCase();
  return words.some((word) => hay.includes(word));
}

function settleReview(answer, items, transcript) {
  const affirms =
    /\b(?:still makes sense|still a good idea|you should still|stick with (?:it|that)|that(?:'s| is) still (?:right|correct))\b/i.test(
      answer
    );
  if (!affirms) return answer;
  const decision = (items ?? []).find((item) => item?.origin === "memory" && item.available !== false && /\bdecid/i.test(item.text));
  const finance = (items ?? []).find(
    (item) => item?.origin === "live" && item?.source === "freedom_financial" && item.available !== false
  );
  const past = decision ? clip(decision.text) : "I don't have the earlier decision.";
  const current = finance ? clip(finance.text) : "I don't have a current Freedom Financial reading.";
  const base = `${past} Today, ${current}.`;
  const reasoned = /\b(?:because|manageable|keep the house|keep it)\b/i.test(past);
  const changed = /\b(?:increased|higher|went up|is up)\b/i.test(current);
  if (!reasoned || !changed) return base;
  const goal = collectPriorities({ items, transcript }).find(
    (priority) => relateTouches(current, priority.text)
  );
  const goalLine = goal ? ` You also said: ${goal.text}.` : "";
  return `${base} That change touches the reason in the decision.${goalLine} I can't say the decision still holds from that alone.`;
}

function relateTouches(current, priorityText) {
  return bestLink([{ text: current, rank: 0 }], [{ text: priorityText, confidence: "remembered" }]) != null;
}

function priorSituationQuery(transcript) {
  const users = [];
  for (const message of Array.isArray(transcript) ? transcript : []) {
    if (message?.role !== "user") continue;
    const text = messageText(message).trim();
    if (text) users.push(text);
  }
  for (let index = users.length - 2; index >= 0; index -= 1) {
    if (situationKind(users[index])) return users[index];
  }
  return null;
}

export function situationReadsPresent(transcript) {
  return toolPayloads(transcript).some((row) =>
    ["workforce_status", "finance_summary", "schedule_list", "schedule_runs"].includes(row.name)
  );
}

function judgeFollowup({ query, transcript, items, now }) {
  const kind = followupKind(query);
  const prior = priorSituationQuery(transcript);
  const readingQuery = prior || (situationReadsPresent(transcript) ? "What should I be paying attention to?" : null);
  if (!readingQuery) return { line: UNCHECKED_LINE, relevant: null, chosen: null };
  const situation = synthesizeSituation({ query: readingQuery, transcript, items, now });
  const annotated = rankLinks(situation?.signals ?? [], collectPriorities({ items, transcript }));
  const chosen = annotated.find((row) => row.relation !== "none") ?? annotated[0] ?? null;
  return {
    line: relevanceAnswer(kind, annotated) || situation?.line || UNCHECKED_LINE,
    relevant: chosen?.relation && chosen.relation !== "none" ? chosen.priority?.text ?? null : null,
    chosen: chosen?.signal ?? null,
  };
}

function settleJudged(answer, judged) {
  const text = String(answer ?? "").trim();
  if (!judged?.line) return text;
  if (WRITE_CLAIM.test(text) || URGENCY.test(text) || FEAR.test(text) || CONSEQUENCE.test(text)) return judged.line;
  if (judged.chosen && !covers(text, judged.chosen)) return judged.line;
  if (judged.relevant && !covers(text, { text: judged.relevant })) return judged.line;
  return text;
}

export function settleSituation(answer, { query = "", transcript = null, items = [], now = new Date() } = {}) {
  const kind = situationKind(query);
  if (!kind && followupKind(query)) {
    return settleJudged(answer, judgeFollowup({ query, transcript, items, now }));
  }
  if (!kind) return String(answer ?? "").trim();
  if (kind === "review") return settleReview(String(answer ?? "").trim(), items, transcript);
  const situation = synthesizeSituation({ query, transcript, items, now });
  const text = String(answer ?? "").trim();
  if (!situation) return text;
  if (WRITE_CLAIM.test(text) || URGENCY.test(text) || FEAR.test(text)) return situation.line;
  if (situation.relevant && !covers(text, { text: situation.relevant })) return situation.line;
  if (/\bnothing (?:major|is failing|stands out)\b/i.test(text)) {
    if (situation.signals.length || situation.unchecked.length) return situation.line;
    return situation.line;
  }
  if (situation.signals.length && !covers(text, situation.signals[0])) return situation.line;
  if (!situation.signals.length && situation.unchecked.length === 0 && text.length > 280) return situation.line;
  return text;
}
