// Turn-time relevance.
//
// A priority is an explicit sentence already stored in chief_fact, or said in
// the open conversation. A live signal does not become a goal. A shared word
// is an inference, not a measured consequence.

import { messageText } from "../runtime/compaction.js";

const STATED_PRIORITY =
  /\b(?:i(?:'m| am)|we(?:'re| are)|user is) (?:trying to|working on|focused on)\b|\b(?:my|our|the) (?:goal|priority|objective) is\b|\b(?:is|are) (?:my|our) (?:goal|priority|objective)\b|\b(?:i|we) (?:want|need) to (?:cut|reduce|lower|keep|finish|save|track|increase|protect)\b|\b(?:important|matters) to me\b|\bwants to (?:cut|reduce|lower|keep|finish|save|track)\b/i;

const FOLLOWUP =
  /^why[.?!]?$|\bwhich (?:one )?matters(?: most)?\b|\bdoes (?:this|that|it) matter\b|\b(?:should i|i should) worry\b|\bwhat should i do(?: about (?:it|this|that))?\b/i;

const STOP = new Set([
  "that",
  "this",
  "with",
  "from",
  "last",
  "month",
  "today",
  "your",
  "have",
  "been",
  "what",
  "when",
  "which",
  "failed",
  "failure",
  "agent",
  "schedule",
  "about",
  "into",
  "than",
  "then",
  "they",
  "them",
  "just",
  "only",
  "more",
  "most",
  "some",
  "current",
  "latest",
  "right",
  "still",
  "said",
  "you",
  "working",
  "trying",
  "focused",
  "important",
  "priority",
  "objective",
  "goal",
  "change",
]);

const RELATION_ORDER = { conflicts: 0, concerns: 1, supports: 2, none: 3 };

export function isStatedPriority(text) {
  return STATED_PRIORITY.test(String(text ?? ""));
}

export function relevanceFollowup(text) {
  return FOLLOWUP.test(String(text ?? "").trim());
}

export function followupKind(text) {
  const raw = String(text ?? "").trim();
  if (/\bwhich (?:one )?matters(?: most)?\b/i.test(raw)) return "most";
  if (/^why[.?!]?$/i.test(raw)) return "why";
  if (/\b(?:should i|i should) worry\b/i.test(raw)) return "worry";
  if (/\bdoes (?:this|that|it) matter\b/i.test(raw)) return "matter";
  if (/\bwhat should i do\b/i.test(raw)) return "do";
  return null;
}

function clip(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function bare(value) {
  return clip(value).replace(/[.!\s]+$/g, "");
}

function stem(word) {
  if (word.endsWith("ies") && word.length > 5) return `${word.slice(0, -3)}y`;
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 4) return word.slice(0, -1);
  return word;
}

export function contentTokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(stem)
    .filter((word) => word.length > 3 && !STOP.has(word));
}

function signalDirection(text) {
  const raw = String(text ?? "").toLowerCase();
  if (/\b(?:was due|overdue|failed|up|increased|higher)\b/.test(raw)) return "up";
  if (/\b(?:down|decreased|lower)\b/.test(raw)) return "down";
  return null;
}

function priorityAim(text) {
  const raw = String(text ?? "").toLowerCase();
  if (/\b(?:cut|reduce|reducing|lower|less|decrease)\b/.test(raw)) return "reduce";
  if (/\b(?:increase|increasing|grow|raise)\b/.test(raw)) return "increase";
  if (/\b(?:keep|maintain|manageable|protect)\b/.test(raw)) return "keep";
  return null;
}

const ABANDON = /\b(?:forget (?:that|this|it)|never mind|scratch that)\b/i;

export function relateSignal(signalText, priorityText) {
  const signalTokens = new Set(contentTokens(signalText));
  const shared = contentTokens(priorityText).filter((word) => signalTokens.has(word));
  const spending =
    /\b(?:spend(?:ing)?|expenses?)\b/i.test(String(priorityText ?? "")) &&
    /\b(?:up|down) \d/i.test(String(signalText ?? ""));
  if (spending) shared.push("spend");
  if (shared.length === 0) return { relation: "none", shared };
  const direction = signalDirection(signalText);
  const aim = priorityAim(priorityText);
  let relation = "concerns";
  if (
    (aim === "reduce" && direction === "up") ||
    (aim === "increase" && direction === "down") ||
    (aim === "keep" && direction === "up")
  ) {
    relation = "conflicts";
  } else if ((aim === "reduce" && direction === "down") || (aim === "increase" && direction === "up")) {
    relation = "supports";
  }
  return { relation, shared };
}

export function collectPriorities({ items = [], transcript = [] } = {}) {
  const found = [];
  const push = (text, confidence) => {
    const line = clip(text);
    if (!line || !isStatedPriority(line)) return;
    if (found.some((row) => row.text.toLowerCase() === line.toLowerCase())) return;
    found.push({ text: line, confidence });
  };
  for (const item of items ?? []) {
    if (!item || item.available === false || item.origin !== "memory") continue;
    if (item.source === "chief_session") continue;
    push(item.text, "remembered");
  }
  const users = (Array.isArray(transcript) ? transcript : [])
    .filter((message) => message?.role === "user")
    .map((message) => messageText(message));
  const { active, dropped } = statedAfterAbandon(users);
  const droppedKeys = new Set(dropped.map((text) => text.toLowerCase()));
  for (let index = found.length - 1; index >= 0; index -= 1) {
    if (droppedKeys.has(found[index].text.toLowerCase())) found.splice(index, 1);
  }
  for (const text of active) push(text, "stated");
  return found.slice(0, 3);
}

function statedAfterAbandon(users) {
  const active = [];
  const dropped = [];
  for (const text of users) {
    if (ABANDON.test(text)) {
      dropped.push(...active.splice(0, active.length));
      const after = text.split(ABANDON).pop() ?? "";
      if (isStatedPriority(after)) active.push(after.replace(/^[\s.,;:!-]+/, "").trim());
      continue;
    }
    if (isStatedPriority(text)) active.push(text);
  }
  return { active, dropped };
}

export function rankLinks(signals, priorities) {
  const annotated = (signals ?? [])
    .filter((signal) => signal && signal.rank < 3)
    .map((signal) => {
      let best = { relation: "none", priority: null };
      for (const priority of priorities ?? []) {
        const link = relateSignal(signal.text, priority.text);
        if (RELATION_ORDER[link.relation] < RELATION_ORDER[best.relation]) {
          best = { relation: link.relation, priority };
        }
      }
      return { signal, relation: best.relation, priority: best.priority };
    });
  annotated.sort((left, right) => {
    const gap = RELATION_ORDER[left.relation] - RELATION_ORDER[right.relation];
    if (gap !== 0) return gap;
    return (left.signal.rank ?? 9) - (right.signal.rank ?? 9);
  });
  return annotated;
}

export function bestLink(signals, priorities) {
  return rankLinks(signals, priorities).find((row) => row.relation !== "none") ?? null;
}

function said(priority) {
  return priority?.confidence === "remembered" ? "I remember you said" : "You said";
}

export function relevanceClause(link) {
  if (!link?.priority || link.relation === "none") return "";
  const fact = bare(link.signal?.text) || "this";
  const stated = bare(link.priority.text);
  if (link.relation === "conflicts") {
    return `${said(link.priority)}: ${stated}. That conflicts with ${fact}. The connection is inferred. The change itself is verified.`;
  }
  if (link.relation === "supports") {
    return `${said(link.priority)}: ${stated}. That lines up with ${fact}. The connection is inferred. The change itself is verified.`;
  }
  return `${said(link.priority)}: ${stated}. That may relate to ${fact}. The connection is inferred, not a measured consequence. The fact itself is verified.`;
}

export function relevanceAnswer(kind, annotated) {
  const linked = (annotated ?? []).find((row) => row.relation !== "none") ?? null;
  const top = linked ?? annotated?.[0] ?? null;
  if (!top) return "";
  const fact = bare(top.signal?.text);
  const stated = bare(linked?.priority?.text);
  if (kind === "most") {
    if (!linked) {
      return `None of these is tied to a priority I have on record. The strongest verified fact is: ${fact}.`;
    }
    const because =
      linked.relation === "conflicts"
        ? "it conflicts with"
        : linked.relation === "supports"
          ? "it lines up with"
          : "it may relate to";
    return `${fact}. That matters most because ${because} what you said: ${stated}. That link is inferred. The fact is verified.`;
  }
  if (kind === "why") {
    if (!linked) {
      return `${fact}. That is verified. I don't have a stated priority that explains why it would matter more than that.`;
    }
    return `${fact}. That is verified. ${said(linked.priority)}: ${stated}. The connection is inferred. I don't have evidence of a further consequence.`;
  }
  if (kind === "worry" || kind === "matter") {
    const caution = kind === "worry" ? "I wouldn't treat that as a worry beyond the facts. " : "";
    if (!linked) {
      return `${caution}${fact}. That is verified. I don't have a stated priority that this affects.`;
    }
    const verb =
      linked.relation === "conflicts" ? "conflict with" : linked.relation === "supports" ? "line up with" : "relate to";
    return `${caution}${fact}. That is verified. ${said(linked.priority)}: ${stated}. It may ${verb} that. I don't have evidence of a further consequence.`;
  }
  if (kind === "do") {
    if (!linked) {
      return `I don't have a stated priority for this. The verified fact is: ${fact}. I wouldn't add a next step beyond that.`;
    }
    return `The useful next step is to look at this against what you said: ${stated}. The verified fact is: ${fact}. I can't change it from here.`;
  }
  return "";
}
