// Controlled derivation of durable notes from a stored conversation.
//
// ADR-0030. Archives and CHIEF transcripts stay the source of truth. This
// module does not run on import, on search, or on every turn. A person, or a
// confirmed memory_write that names the owned conversation, asks to retain.
//
// Policy where the existing memory rules are silent:
// - Only the user's words can become a note. Assistant, tool, and system
//   text is historical and is not promoted.
// - A sentence that fails the injection fence is dropped. It is not stored
//   and it is not executed.
// - Sensitive personal attributes are not inferred. A sentence that states
//   one is skipped.
// - Secrets and volatile snapshots use qualifiesForLongTermMemory and are
//   skipped. Derivation is not an explicit "remember that" command.
// - Uncertain language is stored UNTRUSTED and is not durable knowledge.
// - Temporary language expires in 14 days and is labeled as not established.
// - A matching dedupe key returns the existing row unchanged.
// - A newer sentence that overlaps or contradicts an existing note is stored
//   as a new UNTRUSTED fact. It does not update the earlier row.
// - At most one qualifying sentence per user message, and at most eight
//   notes, are considered.

import { fencesOutput, scanInjection } from "../security/injection.js";
import { qualifiesForLongTermMemory } from "./qualify.js";
import { provenanceSource } from "./provenance.js";

const MAX_DERIVED = 8;
const TEMPORARY_MS = 14 * 24 * 60 * 60 * 1000;

const UNCERTAIN = /\b(?:i think|i guess|maybe|not sure|might|perhaps|possibly)\b/i;
const TEMPORARY = /\b(?:for now|this week|temporarily|until|short-term|short term)\b/i;
const PREFERENCE = /\b(?:i prefer|i always|i never|please always|please never|call me)\b/i;
const DECISION =
  /\b(?:we decided|the decision is|we agreed|the constraint is|we will not|must not|the plan is)\b/i;
const SENSITIVE =
  /\b(?:diagnosed|diagnosis|medication|prescription|religion|religious|ethnicity|sexual orientation|political affiliation|pregnan(?:t|cy))\b|\b(?:my|his|her|their) race\b/i;
const NEGATION = /\b(?:not|never|no|don't|dont|won't|wont|cannot|can't)\b/i;

function scanOrNull(text) {
  try {
    return scanInjection(text);
  } catch {
    return null;
  }
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  const blocks = Array.isArray(message?.content)
    ? message.content
    : Array.isArray(message?.blocks)
      ? message.blocks
      : [];
  return blocks
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object" || block.type === "thinking") return "";
      if (typeof block.text === "string") return block.text;
      if (typeof block.code === "string") return block.code;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function sentences(text) {
  return String(text ?? "")
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function tokenSet(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .match(/[a-z0-9']+/g) ?? []
  );
}

function contradicts(candidate, existing) {
  const left = tokenSet(candidate);
  const right = tokenSet(existing);
  if (left.size < 2 || right.size < 2) return false;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  if (shared < 2) return false;
  const overlap = shared / Math.min(left.size, right.size);
  if (NEGATION.test(candidate) !== NEGATION.test(existing)) return true;
  const normalized = (value) => value.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized(candidate) === normalized(existing)) return false;
  return overlap >= 0.75;
}

function classify(sentence) {
  const text = String(sentence ?? "").trim();
  if (!text) return null;
  const scan = scanOrNull(text);
  if (!scan || fencesOutput(scan.threatLevel)) return null;
  if (SENSITIVE.test(text)) return null;
  if (!qualifiesForLongTermMemory(text)) return null;
  if (!scan.isClean || UNCERTAIN.test(text)) {
    return { kind: "unverified", trustTier: "UNTRUSTED", importance: 0.2, confidence: 0.2 };
  }
  if (TEMPORARY.test(text)) {
    return { kind: "temporary", trustTier: "AUTO", importance: 0.3, confidence: 0.4 };
  }
  if (PREFERENCE.test(text)) {
    return { kind: "preference", trustTier: "AUTO", importance: 0.8, confidence: 0.7 };
  }
  if (DECISION.test(text)) {
    return { kind: "decision", trustTier: "AUTO", importance: 0.7, confidence: 0.6 };
  }
  return null;
}

function observedAtFor(message, now) {
  const raw = message?.sourceCreatedAt ?? message?.createdAt ?? null;
  const date = raw ? new Date(raw) : now;
  return Number.isNaN(date.getTime()) ? now : date;
}

export async function loadOwnedTranscript({
  userId,
  provider,
  conversationId,
  archive = null,
  checkpoints = null,
} = {}) {
  if (!userId || !conversationId) return null;
  if (provider === "claude" || provider === "chatgpt") {
    if (typeof archive?.ownership !== "function" || typeof archive?.get !== "function") return null;
    const owned = await archive.ownership(userId, conversationId);
    if (!owned || owned.provider !== provider) return null;
    const detail = await archive.get(userId, owned.id);
    if (!detail) return null;
    return {
      provider: owned.provider,
      conversationId: owned.id,
      externalId: owned.externalId ?? "",
      messages: detail.messages ?? [],
    };
  }
  if (provider !== "chief" || typeof checkpoints?.load !== "function") return null;
  const record = await checkpoints.load(userId, conversationId);
  if (!record || record.checkpoint?.context?.origin === "schedule") return null;
  const transcript = Array.isArray(record.checkpoint?.transcript)
    ? record.checkpoint.transcript
    : [];
  return {
    provider: "chief",
    conversationId: record.id,
    externalId: "",
    messages: transcript.map((message, index) => ({
      role: message?.role,
      externalId: message?.id ?? `ordinal:${index}`,
      sourceCreatedAt: message?.createdAt ?? record.updatedAt,
      content: message?.content,
    })),
  };
}

export async function retainConversationMemories({
  facts,
  userId,
  provider,
  conversationId,
  externalId = "",
  messages = [],
  now = new Date(),
} = {}) {
  const counts = {
    retained: 0,
    temporary: 0,
    unverified: 0,
    duplicate: 0,
    conflicting: 0,
    capped: false,
  };
  if (!facts || !userId || typeof facts.write !== "function" || typeof facts.read !== "function") {
    return counts;
  }
  const owned = await facts.read({ userId, query: "", limit: 500, now });
  const known = new Map((owned ?? []).filter((fact) => fact?.id).map((fact) => [fact.id, fact]));
  let considered = 0;
  for (const message of messages ?? []) {
    if (considered >= MAX_DERIVED) break;
    if (String(message?.role ?? "").toLowerCase() !== "user") continue;
    let chosen = null;
    for (const sentence of sentences(messageText(message))) {
      const decision = classify(sentence);
      if (decision) {
        chosen = { sentence, decision };
        break;
      }
    }
    if (!chosen) continue;
    considered += 1;
    let decision = chosen.decision;
    const conflict = [...known.values()].some(
      (fact) => fact?.content && contradicts(chosen.sentence, fact.content)
    );
    if (conflict) {
      decision = { kind: "unverified", trustTier: "UNTRUSTED", importance: 0.2, confidence: 0.2 };
    }
    const source = provenanceSource({
      provider,
      conversationId,
      messageId: message?.externalId ?? message?.id ?? "",
      kind: decision.kind,
      externalId,
      observedAt: observedAtFor(message, now),
    });
    if (!source) continue;
    let written;
    try {
      written = await facts.write({
        userId,
        content: chosen.sentence,
        trustTier: decision.trustTier,
        source,
        importance: decision.importance,
        confidence: decision.confidence,
        expiresAt: decision.kind === "temporary" ? new Date(now.getTime() + TEMPORARY_MS) : null,
      });
    } catch (error) {
      if (error?.code === "FACT_CAP") {
        counts.capped = true;
        break;
      }
      throw error;
    }
    if (!written?.id || known.has(written.id)) {
      counts.duplicate += 1;
      continue;
    }
    known.set(written.id, written);
    if (conflict) counts.conflicting += 1;
    if (decision.kind === "temporary") counts.temporary += 1;
    else if (decision.kind === "unverified") counts.unverified += 1;
    else counts.retained += 1;
  }
  return counts;
}
