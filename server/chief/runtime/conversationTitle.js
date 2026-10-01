// One title for a CHIEF conversation, taken from the first user message.
//
// Hermes treats a title as session metadata the user can keep. This is not
// Hermes session_search, and it does not call a model. CHIEF cannot import
// the CEO conversation title path (server/agents). A title is written once,
// only while ChiefSession.title is still null.

export const CHIEF_TITLE_MAX = 80;

function hasPrivateTitleDetail(value) {
  if (/\$\s?\d/.test(value)) return true;
  if (/\b(?:password|passphrase|secret|token|api\s*key|credential)s?\b/i.test(value)) return true;
  if (/\b(?:ending|account\s*(?:number|#|no\.?)|routing|acct)\b[^.]{0,40}\d{2,}/i.test(value)) {
    return true;
  }
  if (/\b\d{5,}\b/.test(value)) return true;
  const fours = value.match(/\b\d{4}\b/g) ?? [];
  return fours.some((digits) => !/^(?:19|20)\d{2}$/.test(digits));
}

export function sanitizeConversationTitle(value) {
  if (typeof value !== "string") return null;
  const original = value.replace(/\s+/g, " ").trim();
  if (original.length < 3) return null;
  if (hasPrivateTitleDetail(original)) return null;
  const sentence = original.split(/[.!?]/)[0].replace(/\s+/g, " ").trim();
  const candidate = (sentence.length >= 3 ? sentence : original).slice(0, CHIEF_TITLE_MAX).trim();
  if (candidate.length < 3 || hasPrivateTitleDetail(candidate)) return null;
  return candidate;
}

export function validateUserTitle(value) {
  if (typeof value !== "string") return { error: "title must be a string" };
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return { error: "title cannot be empty" };
  if (trimmed.length > CHIEF_TITLE_MAX) {
    return { error: `title must be ${CHIEF_TITLE_MAX} characters or fewer` };
  }
  if (hasPrivateTitleDetail(trimmed)) {
    return { error: "title cannot include account numbers, amounts, or secrets" };
  }
  return { title: trimmed };
}

function visibleMessageText(message) {
  if (typeof message?.content === "string") return message.content.trim();
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((part) => part?.type !== "tool-call" && part?.type !== "tool-result")
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isCompactedUser(message) {
  return message?.role === "user" && visibleMessageText(message).includes("<compacted_context>");
}

// Null until a user message and a later assistant reply both exist.
// The title comes from the user message so a finance reply cannot leak into it.
export function titleFromTranscript(transcript) {
  let userText = "";
  for (const message of transcript ?? []) {
    if (!userText) {
      if (message?.role !== "user" || isCompactedUser(message)) continue;
      const text = visibleMessageText(message);
      if (text) userText = text;
      continue;
    }
    if (message?.role === "assistant" && visibleMessageText(message)) {
      return sanitizeConversationTitle(userText);
    }
  }
  return null;
}
