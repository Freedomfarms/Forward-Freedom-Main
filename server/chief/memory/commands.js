// Explicit remember, correct, and forget commands on the existing fact store.
//
// Automatic extraction stays in memory/extract.js. This path runs only when
// the user asks to remember, correct, or forget. memory_write remains the
// approval-gated tool for facts the user did not explicitly ask to store.
// A direct user instruction is already the user's request. An unclear
// "remember this" is not stored. A forgotten fact is not written again.

import { fencesOutput, scanInjection } from "../security/injection.js";
import { factDedupeKey } from "./facts.js";
import { personalSource, qualifiesForLongTermMemory } from "./qualify.js";

const REMEMBER = /^\s*(?:chief[,:]?\s+)?(?:please\s+)?remember(?:\s+that)?\s+(.+?)\s*[.!?]*\s*$/i;
const FORGET = /^\s*(?:chief[,:]?\s+)?(?:please\s+)?forget(?:\s+that)?\s+(.+?)\s*[.!?]*\s*$/i;
const CORRECT =
  /^\s*(?:chief[,:]?\s+)?(?:please\s+)?(?:correct|update|change)(?:\s+(?:that|it|this))?\s*[:,]?\s+(.+?)\s*[.!?]*\s*$/i;
const REFERENCE_ONLY =
  /^(?:this|that|it|this decision|that decision|the decision|this preference|that preference|what i (?:just )?said|what we (?:just )?(?:said|decided))(?:\s+for(?:\s+(?:future|later))?\s+conversations)?$/i;
const DURABLE_START =
  /^(?:i|we)\s+(?:always|never|prefer|decided)\b|^(?:my name is|call me|from now on)\b/i;

function commandText(pattern, userText) {
  const match = String(userText ?? "")
    .trim()
    .match(pattern);
  return match?.[1]?.trim() ?? "";
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content.trim();
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function isReferenceOnly(text) {
  const normalized = String(text ?? "")
    .trim()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
  if (!normalized) return false;
  if (REFERENCE_ONLY.test(normalized)) return true;
  return (
    /^(?:this|that)\s+(?:decision|preference|fact)\b/i.test(normalized) &&
    !/\b(?:i|we)\s+(?:decided|prefer|will)\b/i.test(normalized)
  );
}

function isMemoryCommand(text) {
  const value = String(text ?? "").trim();
  return REMEMBER.test(value) || FORGET.test(value) || CORRECT.test(value);
}

function sentences(text) {
  return String(text ?? "")
    .split(/\n+|(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function durableSentences(text) {
  return sentences(text).filter(
    (sentence) =>
      !isMemoryCommand(sentence) &&
      !isReferenceOnly(sentence) &&
      !sentence.endsWith("?") &&
      qualifiesForLongTermMemory(sentence, { explicit: true })
  );
}

function priorMessages(transcript, userText) {
  const messages = Array.isArray(transcript) ? [...transcript] : [];
  const last = messages.at(-1);
  if (last?.role === "user" && messageText(last) === String(userText ?? "").trim()) {
    messages.pop();
  }
  return messages;
}

export function resolveRememberedFact(userText, transcript = []) {
  const payload = commandText(REMEMBER, userText);
  if (!payload) return { content: "", clarify: false };
  if (!isReferenceOnly(payload)) return { content: payload, clarify: false };
  const messages = priorMessages(transcript, userText);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    const found = durableSentences(messageText(message));
    if (found.length === 1) return { content: found[0], clarify: false };
    if (found.length > 1) return { content: "", clarify: true };
  }
  return { content: "", clarify: true };
}

function words(text) {
  return new Set(String(text ?? "").toLowerCase().match(/[a-z0-9]{4,}/g) || []);
}

function overlap(left, right) {
  const tokens = words(right);
  let count = 0;
  for (const word of words(left)) if (tokens.has(word)) count += 1;
  return count;
}

function splitCorrection(payload) {
  const match = String(payload ?? "").match(/^(.*?)\s+(?:instead of|rather than)\s+(.*?)$/i);
  if (!match) return { next: String(payload ?? "").trim(), previous: "" };
  return { next: match[1].trim(), previous: match[2].trim() };
}

function rejection(reason) {
  return { action: "rejected", reason, id: null };
}

async function writeExplicit(facts, provider, userId, content) {
  if (fencesOutput(scanInjection(content).threatLevel)) return rejection("injection");
  if (!qualifiesForLongTermMemory(content, { explicit: true })) return rejection("not-durable");
  if (provider) {
    const stored = await provider.remember({
      userId,
      source: "user",
      kind: "explicit",
      text: content,
      occurredAt: new Date(),
      sessionId: null,
      agentId: null,
      trust: "AUTO",
    });
    if (!stored?.stored) return rejection(stored?.reason ?? "not-durable");
    return { action: "remember", id: stored.id ?? null, duplicate: false, content };
  }
  const stored = await facts.write({
    userId,
    content,
    trustTier: "AUTO",
    source: personalSource(content),
    importance: 0.8,
    confidence: 0.9,
  });
  if (stored?.forgotten || stored?.deletedAt) {
    return { action: "rejected", reason: "forgotten", id: stored.id ?? null, content };
  }
  return { action: "remember", id: stored?.id ?? null, duplicate: false, content };
}

async function correctFact({ facts, userId, payload }) {
  const { next, previous } = splitCorrection(payload);
  if (!next || isReferenceOnly(next)) return { action: "clarify", reason: "unresolved" };
  if (fencesOutput(scanInjection(next).threatLevel)) return rejection("injection");
  if (!qualifiesForLongTermMemory(next, { explicit: true })) return rejection("not-durable");
  if (previous) {
    let removed = 0;
    if (typeof facts.forget === "function") {
      const result = await facts.forget({ userId, content: previous });
      removed = result?.deleted ?? 0;
    }
    const written = await writeExplicit(facts, null, userId, next);
    if (written.action === "remember" && removed > 0) {
      return { ...written, action: "correct", superseded: previous };
    }
    return written;
  }
  const rows = typeof facts.read === "function" ? await facts.read({ userId, query: "", limit: 50 }) : [];
  const matches = (rows || []).filter((row) => row?.content && overlap(next, row.content) >= 2);
  if (matches.length > 1) return { action: "clarify", reason: "ambiguous" };
  if (matches.length === 1 && typeof facts.update === "function") {
    const updated = await facts.update({ userId, id: matches[0].id, content: next });
    if (updated?.forgotten || updated?.deletedAt) {
      return { action: "rejected", reason: "forgotten", id: matches[0].id, content: next };
    }
    if (updated?.content === next) {
      return { action: "correct", id: updated.id, content: next, superseded: matches[0].content };
    }
    if (updated?.duplicate) return { action: "remember", id: updated.id, duplicate: true, content: next };
  }
  return writeExplicit(facts, null, userId, next);
}

export async function applyMemoryCommands({
  facts,
  provider = null,
  userId,
  userText,
  transcript = null,
}) {
  try {
    if ((!facts && !provider) || !userId) return { action: null };
    const forgetText = commandText(FORGET, userText);
    if (forgetText) {
      if (isReferenceOnly(forgetText)) return { action: "clarify", reason: "unresolved" };
      if (provider) {
        const result = await provider.forget({ userId, content: forgetText });
        return { action: "forget", deleted: result?.deleted ?? 0, content: forgetText };
      }
      if (typeof facts.forget !== "function") return { action: "forget", deleted: 0, content: forgetText };
      const result = await facts.forget({ userId, content: forgetText });
      return { action: "forget", deleted: result?.deleted ?? 0, content: forgetText };
    }
    const correction = commandText(CORRECT, userText);
    if (correction) {
      if (!facts) return rejection("not-durable");
      return await correctFact({ facts, userId, payload: correction });
    }
    if (!commandText(REMEMBER, userText)) return { action: null };
    const resolved = resolveRememberedFact(userText, transcript);
    if (resolved.clarify || !resolved.content) return { action: "clarify", reason: "unresolved" };
    return await writeExplicit(facts, provider, userId, resolved.content);
  } catch {
    return { action: null, skipped: "error" };
  }
}

export function proposeDurableFact(userText) {
  if (isMemoryCommand(userText)) return "";
  const found = sentences(userText).filter(
    (sentence) =>
      !sentence.endsWith("?") &&
      DURABLE_START.test(sentence) &&
      qualifiesForLongTermMemory(sentence, { explicit: false })
  );
  if (found.length !== 1) return "";
  return found[0];
}

function noticeFor(result, proposals = []) {
  if (result?.skipped === "error") {
    return "Not stored. Persistence failed. Do not tell the user this was remembered.";
  }
  if (result?.action === "clarify") {
    return "Not stored. The request did not identify one specific fact. Ask which fact to keep. Do not say it was remembered.";
  }
  if (result?.action === "rejected" && result.reason === "forgotten") {
    return "Not stored. That fact was forgotten and stays forgotten. Do not say it was remembered.";
  }
  if (result?.action === "rejected") {
    return "Not stored. The fact was not saved. Do not say it was remembered.";
  }
  if (result?.action === "forget") {
    if ((result.deleted ?? 0) < 1) {
      return "No matching stored fact was removed. Do not say it was forgotten.";
    }
    return `Forgotten. ${result.deleted} matching fact${result.deleted === 1 ? "" : "s"} removed. A forgotten fact stays forgotten.`;
  }
  if (result?.action === "remember" || result?.action === "correct") {
    const saved = result.content || "";
    if (!saved) return "Not stored. Persistence failed. Do not tell the user this was remembered.";
    const superseded = result.superseded ? ` It supersedes "${result.superseded}".` : "";
    return `Stored. Accepted memory now includes "${saved}".${superseded} Do not claim a different fact was saved.`;
  }
  if (proposals.length === 1) {
    return `Not stored. A durable preference or decision was noticed: "${proposals[0]}". Call memory_write with that text so the user can approve it. Do not say it was remembered until memory_write succeeds. Do not mark it trusted.`;
  }
  return "";
}

export async function planUserMemory({ facts, provider = null, userId, userText, transcript = null }) {
  const command = await applyMemoryCommands({ facts, provider, userId, userText, transcript });
  if (command?.action || command?.skipped) {
    return {
      ...command,
      stored: command.action === "remember" || command.action === "correct",
      proposals: [],
      notice: noticeFor(command),
    };
  }
  const proposal = proposeDurableFact(userText);
  if (!proposal || !facts || !userId) {
    return { action: null, stored: false, proposals: [], notice: "" };
  }
  let rows;
  try {
    rows = typeof facts.read === "function" ? await facts.read({ userId, query: "", limit: 50 }) : [];
  } catch {
    return {
      action: null,
      skipped: "error",
      stored: false,
      proposals: [],
      notice: noticeFor({ skipped: "error" }),
    };
  }
  if ((rows || []).some((row) => factDedupeKey(row?.content || "") === factDedupeKey(proposal))) {
    return { action: null, stored: false, proposals: [], notice: "" };
  }
  const conflict = (rows || []).find((row) => row?.content && overlap(proposal, row.content) >= 2);
  const notice = conflict
    ? `${noticeFor(null, [proposal])} This would supersede "${conflict.content}" only after that approval.`
    : noticeFor(null, [proposal]);
  return { action: "proposal", stored: false, proposals: [proposal], notice, content: proposal };
}
