// Local embeddings for CHIEF episodic and personal recall.
//
// chief_fact.embedding and chief_knowledge_entity.embedding already exist for
// pgvector, and fact text is encrypted, so Postgres cannot rank fact bodies.
// This hasher runs in process over text the caller already decrypted or over
// ChiefSession.recallDocument. A provider embedder can be passed in later.
// No second database and no new vector service.

const DIMENSIONS = 128;

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "cant",
  "cannot",
  "chief",
  "did",
  "do",
  "does",
  "for",
  "how",
  "i",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "that",
  "the",
  "this",
  "to",
  "was",
  "we",
  "what",
  "when",
  "why",
  "with",
  "you",
  "your",
]);

const SYNONYM_GROUPS = [
  ["finance", "finances", "financial", "money"],
  ["see", "view", "access", "read", "reader"],
  ["disabled", "unavailable", "blocked"],
  ["house", "home", "mortgage"],
  ["prefer", "preference", "concise", "brief", "short"],
  ["fix", "fixed", "repair", "repaired"],
];

const SYNONYMS = new Map();
for (const group of SYNONYM_GROUPS) {
  for (const word of group) SYNONYMS.set(word, group);
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function memoryTokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

export function expandedTokens(text) {
  const tokens = new Set();
  for (const token of memoryTokens(text)) {
    const group = SYNONYMS.get(token) ?? [token];
    for (const word of group) tokens.add(word);
  }
  return tokens;
}

export function embedText(text) {
  const vector = new Float64Array(DIMENSIONS);
  for (const token of expandedTokens(text)) {
    const hash = fnv1a(token);
    const slot = hash % DIMENSIONS;
    vector[slot] += (hash & 1) === 0 ? 1 : -1;
  }
  return vector;
}

export function cosineSimilarity(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const size = Math.min(left?.length ?? 0, right?.length ?? 0);
  for (let index = 0; index < size; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function semanticSimilarity(left, right, embed = embedText) {
  return cosineSimilarity(embed(left), embed(right));
}
