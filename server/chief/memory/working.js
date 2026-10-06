// Working memory for the conversation that is open right now.
//
// Derived from the checkpoint transcript and handoff notes. It is not a table.
// The transcript remains the source of truth. This projection is bounded so
// the model sees the active task, entities, and recent tool results without a
// second copy of the whole conversation.

import { countTokens } from "../context/inject.js";
import { compactedSummary, isCompactedMessage, messageText } from "../runtime/compaction.js";

export const WORKING_TOKEN_BUDGET = 600;
const TOOL_EXCERPT = 180;

const STOP_ENTITY = new Set([
  "thing",
  "one",
  "way",
  "time",
  "user",
  "price",
  "worth",
  "question",
  "answer",
  "part",
  "lot",
  "bit",
  "rest",
  "same",
  "other",
  "current",
  "number",
]);

const TICKERS = /\b(XRP|BTC|ETH|SOL|ADA|DOGE|GOLD|SILVER)\b/g;

function noteLine(notes, label) {
  const match = String(notes ?? "").match(new RegExp(`(?:^|\\n)\\s*${label}:\\s*([^\\n]+)`, "i"));
  return match?.[1]?.trim() ?? "";
}

export function extractEntities(text) {
  const found = [];
  const raw = String(text ?? "");
  for (const match of raw.matchAll(TICKERS)) found.push(match[1].toUpperCase());
  for (const match of raw.matchAll(/\b(?:my|the|that)\s+([a-z][a-z0-9-]{2,32})\b/gi)) {
    const word = match[1].toLowerCase();
    if (STOP_ENTITY.has(word)) continue;
    found.push(word);
  }
  return found;
}

export function isAnaphoric(text) {
  return /\b(it|that|this|them|those|there|the other one|the thing|what we (?:just|were)|go back)\b/i.test(
    String(text ?? "")
  );
}

function prose(message) {
  if (isCompactedMessage(message)) return compactedSummary(message) ?? "";
  return messageText(message);
}

function pushEntity(order, name) {
  const key = name.toLowerCase();
  const existing = order.findIndex((item) => item.name.toLowerCase() === key);
  if (existing >= 0) order.splice(existing, 1);
  order.push({ name, kind: name === name.toUpperCase() ? "asset" : "topic" });
}

export function buildWorkingMemory(
  transcript,
  { notes = null, maxTokens = WORKING_TOKEN_BUDGET } = {}
) {
  const messages = Array.isArray(transcript) ? transcript : [];
  const kept = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const cost = Math.max(1, countTokens(prose(messages[index])));
    if (kept.length > 0 && used + cost > maxTokens) break;
    kept.push(messages[index]);
    used += cost;
  }
  kept.reverse();

  let lastUser = "";
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user" || isCompactedMessage(messages[index])) continue;
    lastUser = messageText(messages[index]).trim();
    lastUserIndex = index;
    break;
  }

  const entities = [];
  let priorReferent = null;
  messages.forEach((message, index) => {
    for (const name of extractEntities(prose(message))) {
      pushEntity(entities, name);
      if (index < lastUserIndex) priorReferent = name;
    }
  });

  const introduced = extractEntities(lastUser);
  const goal = noteLine(notes, "Goal");
  let referent = null;
  if (/\bthe other one\b/i.test(lastUser) && entities.length >= 2) {
    referent = entities[entities.length - 2].name;
  } else if (introduced.length) referent = introduced[introduced.length - 1];
  else if (isAnaphoric(lastUser)) referent = priorReferent;
  const currentTask = isAnaphoric(lastUser) && goal ? goal : lastUser;
  const toolResults = [];
  for (const message of kept) {
    if (message?.role !== "tool") continue;
    const excerpt = prose(message).replace(/\s+/g, " ").trim().slice(0, TOOL_EXCERPT);
    if (excerpt) toolResults.push({ excerpt });
  }

  return {
    recentTurns: kept,
    entities,
    referent: referent ?? null,
    currentTask,
    decisions: noteLine(notes, "Key Decisions"),
    pending: noteLine(notes, "Next Steps"),
    toolResults: toolResults.slice(-2),
    tokens: used,
  };
}

export function resolveReference(memory, text) {
  const query = String(text ?? "");
  const named = extractEntities(query);
  if (named.length) return named[named.length - 1];
  if (isAnaphoric(query)) return memory?.referent ?? null;
  return null;
}

export function renderWorkingMemory(memory) {
  if (!memory) return "";
  const lines = ["Working context for this conversation only:"];
  if (memory.currentTask) lines.push(`Current request: ${memory.currentTask}`);
  if (memory.referent) {
    lines.push(`"it", "that", "this", and "them" refer to ${memory.referent}.`);
  }
  if (memory.entities?.length) {
    lines.push(`Active entities: ${memory.entities.map((entity) => entity.name).join(", ")}.`);
  }
  if (memory.decisions) lines.push(`Decisions: ${memory.decisions}`);
  if (memory.pending) lines.push(`Pending: ${memory.pending}`);
  if (memory.toolResults?.length) {
    lines.push(
      `Recent tool results: ${memory.toolResults.map((item) => item.excerpt).join(" | ")}`
    );
  }
  lines.push("Working context is not a live financial, market, web, or code reading.");
  return lines.join("\n");
}
