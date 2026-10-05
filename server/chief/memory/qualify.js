// Gates what may become a long-term personal fact.
//
// ChiefFact remains the store. This module decides whether a candidate is
// worth writing. Automatic extraction must not keep live balances, prices, or
// small talk. An explicit remember request is the user's instruction to store
// a fact, and it still refuses secrets.

const SECRET = /\b(?:password|passphrase|api[\s_-]*key|secret|access[\s_-]*token|credential)s?\b/i;

const TRANSIENT = /^(?:ok|okay|thanks|thank you|sure|yes|no|hi|hello|hey)[.!]?$/i;

export function isVolatileSnapshot(content) {
  const text = String(content ?? "");
  if (/\$\s?\d/.test(text)) return true;
  if (/\b\d[\d,]*(?:\.\d+)?\s*(?:xrp|btc|eth|sol|usd|shares|ounces)\b/i.test(text)) return true;
  if (/\b(?:owns?|owned|holds?|holding|balance|worth)\b/i.test(text) && /\d/.test(text)) {
    return true;
  }
  return false;
}

export function isSecretMemory(content) {
  return SECRET.test(String(content ?? ""));
}

export function isSnapshotFact(content) {
  return isVolatileSnapshot(content);
}

export function qualifiesForLongTermMemory(content, { explicit = false } = {}) {
  const text = String(content ?? "").trim();
  if (text.length < 8 || text.length > 500) return false;
  if (isSecretMemory(text)) return false;
  if (!explicit && isVolatileSnapshot(text)) return false;
  if (!explicit && TRANSIENT.test(text)) return false;
  return true;
}

export function isStaleFact(fact, now = new Date()) {
  if (!fact?.expiresAt) return false;
  const expires = new Date(fact.expiresAt);
  if (Number.isNaN(expires.getTime())) return false;
  return expires.getTime() <= now.getTime();
}

export function personalSource(content) {
  if (/\b(?:prefer|preference|always|never|call me|concise|brief)\b/i.test(content)) {
    return "preference";
  }
  return "user";
}
