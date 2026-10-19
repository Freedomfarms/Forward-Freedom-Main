// One investigation note for the turn that is already running.
//
// The context orchestrator still chooses sources. TurnMachine still calls
// the model once for an ordinary question. This note tells that call which
// evidence is in hand, which authorized read is still missing, and where
// historical sources disagree. It does not call a tool or a model.

import { conversationMove } from "./behavior.js";

const LIVE_NEED = Object.freeze({
  finance: "a current Freedom Financial reading",
  web: "a public web reading",
  code: "an authorized code read",
  settings: "an authorized settings read",
  agents: "current agent state",
  schedule: "the current schedule",
  calendar: "the current calendar",
  email: "the current inbox",
});

function stance(text) {
  const raw = String(text ?? "");
  const keep = /\bkeep(?:ing|t)?\b/i.test(raw);
  const sell = /\bsell(?:ing)?\b/i.test(raw) && !/\bnot sell/i.test(raw);
  if (keep && !sell) return "keep";
  if (sell && !keep) return "sell";
  return null;
}

function describeConflict(items) {
  const seen = new Set();
  for (const item of items) {
    const side = stance(item?.text);
    if (side) seen.add(side);
  }
  if (seen.size < 2) return "";
  return "Historical sources disagree. Examine what each one says, including its date. A newer conversation does not erase an older decision.";
}

export function buildInvestigationBrief({
  query = "",
  plan = null,
  items = [],
  transcript = null,
} = {}) {
  const asked = String(query ?? "").trim();
  const move = Array.isArray(transcript) ? conversationMove(transcript, asked) : null;
  if (move?.unresolvedOther) {
    return "Investigation. The other one is not named in this conversation. Ask which one they mean. Do not read the previous subject's live data.";
  }
  const live = Array.isArray(plan?.live) ? plan.live : [];
  const memory = Array.isArray(plan?.memory) ? plan.memory : [];
  const investigates =
    live.length > 0 || memory.includes("episodic") || memory.includes("decision");
  if (!investigates) return "";

  const lines = ["Investigation. Answer from this evidence. Do not start another lookup loop."];
  if (asked) lines.push(`Question: ${asked}`);
  if (move?.referent) lines.push(`Subject: ${move.referent}.`);
  const needs = [];
  for (const domain of live) needs.push(LIVE_NEED[domain] || domain);
  if (memory.includes("episodic") || memory.includes("decision")) {
    needs.push("the prior decision or conversation");
  }
  if (needs.length) lines.push(`Evidence needed: ${needs.join("; ")}.`);

  const historical = (items ?? []).filter(
    (item) => item?.origin === "memory" && item.available !== false && item.text
  );
  if (historical.length) {
    lines.push(
      `Retrieved ${historical.length} historical item${historical.length === 1 ? "" : "s"}. Use them as memory, not as a current reading.`
    );
  }
  const conflict = describeConflict(historical);
  if (conflict) lines.push(conflict);

  const liveReady = (items ?? []).some(
    (item) => item?.origin === "live" && item.available !== false && item.text
  );
  if (live.length && !liveReady) {
    lines.push(
      "If a required live reading is missing, say it is unavailable. Do not invent the current figure."
    );
  } else if (live.length) {
    lines.push(
      "Use the authorized read for the current part. Do not answer that part from memory."
    );
  }
  lines.push("Stop when the question is answered or the missing evidence is named.");
  return lines.join("\n");
}
