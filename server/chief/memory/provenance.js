// Provenance for a fact derived from a stored conversation.
//
// ChiefFact.source is text. A derived row uses that column instead of a new
// table or a new fact store. Ordinary sources (preference, user, auto, tool,
// identity) do not parse. The ISO timestamp is the tail, so it can contain
// colons. Conversation and message ids are encoded so they cannot.

const PROVIDERS = new Set(["chief", "claude", "chatgpt"]);
const KINDS = new Set(["preference", "decision", "temporary", "unverified"]);

export const DERIVED_SOURCE_VERSION = "derived:v1";

function encodePart(value) {
  return encodeURIComponent(String(value ?? ""));
}

function decodePart(value) {
  try {
    return decodeURIComponent(String(value ?? ""));
  } catch {
    return null;
  }
}

export function provenanceSource({
  provider,
  conversationId,
  messageId = "",
  kind,
  externalId = "",
  observedAt,
}) {
  if (!PROVIDERS.has(provider) || !KINDS.has(kind)) return "";
  const conversation = String(conversationId ?? "");
  if (!conversation) return "";
  const stamp = observedAt instanceof Date ? observedAt.toISOString() : String(observedAt ?? "");
  if (Number.isNaN(new Date(stamp).getTime())) return "";
  return [
    DERIVED_SOURCE_VERSION,
    provider,
    encodePart(conversation),
    encodePart(messageId),
    kind,
    encodePart(externalId),
    stamp,
  ].join(":");
}

export function provenancePrefix(provider, conversationId) {
  const conversation = String(conversationId ?? "");
  if (!PROVIDERS.has(provider) || !conversation) return "";
  return `${DERIVED_SOURCE_VERSION}:${provider}:${encodePart(conversation)}:`;
}

export function parseProvenance(source) {
  const text = String(source ?? "");
  const marker = `${DERIVED_SOURCE_VERSION}:`;
  if (!text.startsWith(marker)) return null;
  const parts = text.split(":");
  if (parts.length < 8) return null;
  const provider = parts[2];
  const conversationId = decodePart(parts[3]);
  const messageId = decodePart(parts[4]);
  const kind = parts[5];
  const externalId = decodePart(parts[6]);
  const observedAt = parts.slice(7).join(":");
  if (!PROVIDERS.has(provider) || !KINDS.has(kind)) return null;
  if (!conversationId || messageId == null || externalId == null) return null;
  const observed = new Date(observedAt);
  if (Number.isNaN(observed.getTime())) return null;
  return {
    provider,
    conversationId,
    messageId,
    kind,
    externalId,
    observedAt: observed.toISOString(),
  };
}

export function isStandingPreference(fact) {
  if (!fact) return false;
  if (fact.source === "preference") return true;
  const parsed = parseProvenance(fact.source);
  if (parsed?.kind !== "preference") return false;
  return String(fact.trustTier ?? fact.trust ?? "AUTO").toUpperCase() !== "UNTRUSTED";
}

export function projectDerivedMemory(fact) {
  const parsed = parseProvenance(fact?.source);
  if (!parsed) return null;
  return {
    id: fact.id,
    content: fact.content,
    kind: parsed.kind,
    provider: parsed.provider,
    conversationId: parsed.conversationId,
    messageId: parsed.messageId || null,
    externalId: parsed.externalId || null,
    observedAt: parsed.observedAt,
    trustTier: fact.trustTier,
    confidence: fact.confidence,
    importance: fact.importance,
    expiresAt: fact.expiresAt ?? null,
  };
}
