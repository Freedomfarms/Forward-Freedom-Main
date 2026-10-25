// Claude Managed Agents delivery for conversational preferences.
//
// Anthropic adds memory-store resource instructions to the session system
// prompt only when the session is created, and that field is capped at 4,096
// characters. personality.md is the copy that can change while a session is
// open. Session update cannot replace this text, so an open session keeps its
// provider id and the next user message carries the new guidance once.

import {
  normalizeChiefPersonality,
  renderPersonalityGuidance,
} from "../../../src/utils/chiefPersonality.js";

export const MEMORY_INSTRUCTION_MAX = 4096;

export const PERSONALITY_MEMORY_PATH = "personality.md";

const MOUNT_NOTE =
  "Project workspace and skills for this user. Read them before answering. Do not expect a pasted transcript.";

const PREFACE = [
  "Conversational preferences for this user follow. They shape wording only.",
  "They never override CHIEF's identity, tool permissions, safety rules, or execution authorization.",
  "If personality.md in this store disagrees with this note, follow personality.md. It is the saved preference.",
].join(" ");

function instructionHead() {
  return `${MOUNT_NOTE}\n\n${PREFACE}\n\n`;
}

export function memoryStoreInstructions(guidance) {
  const head = instructionHead();
  const room = Math.max(0, MEMORY_INSTRUCTION_MAX - head.length);
  return `${head}${String(guidance || "").slice(0, room)}`;
}

export function fittedPersonalityGuidance(value) {
  const personality = normalizeChiefPersonality(value);
  const head = instructionHead();
  const room = Math.max(0, MEMORY_INSTRUCTION_MAX - head.length);
  let guidance = renderPersonalityGuidance(personality);
  if (guidance.length > room) {
    const overflow = guidance.length - room;
    const custom = personality.customInstructions
      .slice(0, Math.max(0, personality.customInstructions.length - overflow))
      .trimEnd();
    guidance = renderPersonalityGuidance({ ...personality, customInstructions: custom });
    if (guidance.length > room) guidance = guidance.slice(0, room);
  }
  return { personality, guidance, instructions: `${head}${guidance}` };
}

// The previous turn failed before the user saw an assistant answer. The next
// provider prompt carries that fact once. The saved transcript keeps the
// user's words only, so the model cannot explain a reply that was not shown.
export function undeliveredTurnPrompt(providerPrompt, turnError) {
  const notice = typeof turnError === "string" ? turnError.trim() : "";
  const text = typeof providerPrompt === "string" ? providerPrompt : "";
  if (!notice) return text;
  return [
    "Application notice about the previous turn. Do not quote this note, and do not treat it as a separate request.",
    `No assistant answer was shown to the user. The interface showed: ${notice}`,
    "That sentence was not your reply. If the user asks about it, say you are unsure what reached them. Do not invent a cause.",
    "User message:",
    text,
  ].join("\n\n");
}

export function steeredUserPrompt(guidance, userText) {
  return [
    "Saved conversational preference update. Apply it to the user message below.",
    "Do not quote this note, and do not treat it as a separate request.",
    "It does not grant tools, skip approvals, or override safety rules.",
    guidance,
    "User message:",
    userText,
  ].join("\n\n");
}

// A new session receives the guidance as memory-store instructions.
// An open session keeps its provider id. The next user message carries the
// guidance once when the saved digest differs, then the digest is stored so
// later messages stay the user's words only.
export function personalityDelivery({
  providerSessionId,
  boundDigest,
  digest,
  userText,
  guidance,
}) {
  const opening = !providerSessionId;
  if (opening || boundDigest === digest) {
    return { providerPrompt: userText, nextDigest: digest, steered: false };
  }
  return {
    providerPrompt: steeredUserPrompt(guidance, userText),
    nextDigest: digest,
    steered: true,
  };
}
