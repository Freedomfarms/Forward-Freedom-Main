// Answers CHIEF had to show after speech failed or was stopped.
// The transcript stays on the server. This browser record only remembers
// which assistant text in which conversation should stay visible in Voice mode.
// It does not change response mode and it does not store a second copy of the reply.

export const CHIEF_REVEALED_PREFIX = "chief.revealedAnswers:";

const SESSION_LIMIT = 30;
const ANSWER_LIMIT = 40;

function storageOf(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function ownerKey(uid) {
  const id = typeof uid === "string" ? uid.trim() : "";
  if (!id) return null;
  return `${CHIEF_REVEALED_PREFIX}${id}`;
}

function sessionIdOf(sessionId) {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  return id || "";
}

export function revealedAnswerKey(text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return "";
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return `${value.length}:${(hash >>> 0).toString(16)}`;
}

function readMap(uid, storage) {
  const bin = storageOf(storage);
  const key = ownerKey(uid);
  if (!bin || !key) return {};
  try {
    const raw = bin.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function writeMap(uid, value, storage) {
  const bin = storageOf(storage);
  const key = ownerKey(uid);
  if (!bin || !key) return;
  try {
    bin.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode can reject storage. The open view still reveals the answer.
  }
}

function keysFor(map, sessionId) {
  const list = map?.[sessionId];
  if (!Array.isArray(list)) return [];
  return list.filter((item) => typeof item === "string" && item);
}

export function readRevealedAnswers(uid, sessionId, storage) {
  const id = sessionIdOf(sessionId);
  if (!id) return [];
  return keysFor(readMap(uid, storage), id);
}

export function isRevealedAnswer(keys, text) {
  const key = revealedAnswerKey(text);
  if (!key || !Array.isArray(keys)) return false;
  return keys.includes(key);
}

export function rememberRevealedAnswer(uid, sessionId, text, storage) {
  const id = sessionIdOf(sessionId);
  const key = revealedAnswerKey(text);
  if (!id || !key) return null;
  const map = readMap(uid, storage);
  const current = keysFor(map, id);
  const nextKeys = current.includes(key) ? current : [...current, key].slice(-ANSWER_LIMIT);
  const next = {};
  for (const [session, saved] of Object.entries(map)) {
    if (session !== id && Array.isArray(saved)) next[session] = saved;
  }
  next[id] = nextKeys;
  const sessions = Object.keys(next);
  while (sessions.length > SESSION_LIMIT) {
    const oldest = sessions.shift();
    delete next[oldest];
  }
  writeMap(uid, next, storage);
  return nextKeys;
}
