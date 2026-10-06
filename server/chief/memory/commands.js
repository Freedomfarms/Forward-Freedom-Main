// Explicit remember and forget commands on the existing fact store.
//
// Automatic extraction stays in memory/extract.js. This path runs only when
// the user asks to remember or forget. memory_write remains the approval-gated
// tool. A direct user instruction is already the user's request.

import { fencesOutput, scanInjection } from "../security/injection.js";
import { personalSource, qualifiesForLongTermMemory } from "./qualify.js";

const REMEMBER = /^\s*(?:chief[,:]?\s+)?(?:please\s+)?remember(?:\s+that)?\s+(.+?)\s*[.!?]*\s*$/i;
const FORGET = /^\s*(?:chief[,:]?\s+)?(?:please\s+)?forget(?:\s+that)?\s+(.+?)\s*[.!?]*\s*$/i;

function commandText(pattern, userText) {
  const match = String(userText ?? "")
    .trim()
    .match(pattern);
  return match?.[1]?.trim() ?? "";
}

export async function applyMemoryCommands({ facts, provider = null, userId, userText }) {
  try {
    if ((!facts && !provider) || !userId) return { action: null };
    const forgetText = commandText(FORGET, userText);
    if (forgetText) {
      if (provider) {
        const result = await provider.forget({ userId, content: forgetText });
        return { action: "forget", deleted: result?.deleted ?? 0 };
      }
      if (typeof facts.forget !== "function") return { action: "forget", deleted: 0 };
      const result = await facts.forget({ userId, content: forgetText });
      return { action: "forget", deleted: result?.deleted ?? 0 };
    }
    const remembered = commandText(REMEMBER, userText);
    if (!remembered) return { action: null };
    if (fencesOutput(scanInjection(remembered).threatLevel)) {
      return { action: "rejected", reason: "injection" };
    }
    if (!qualifiesForLongTermMemory(remembered, { explicit: true })) {
      return { action: "rejected", reason: "not-durable" };
    }
    if (provider) {
      const stored = await provider.remember({
        userId,
        source: "user",
        kind: "explicit",
        text: remembered,
        occurredAt: new Date(),
        sessionId: null,
        agentId: null,
        trust: "AUTO",
      });
      if (!stored?.stored) return { action: "rejected", reason: stored?.reason ?? "not-durable" };
      return { action: "remember", id: stored.id ?? null, duplicate: false };
    }
    const stored = await facts.write({
      userId,
      content: remembered,
      trustTier: "AUTO",
      source: personalSource(remembered),
      importance: 0.8,
      confidence: 0.9,
    });
    return { action: "remember", id: stored?.id ?? null, duplicate: false };
  } catch {
    return { action: null, skipped: "error" };
  }
}
