// Local capture queue. State is JSON so it survives a browser restart.
// Success is recorded only after the server accepts the archive write.

import { payloadTooLarge } from "./transport.js";

const DELAYS = [1000, 5000, 30000, 120000];
const MAX_ATTEMPTS = 4;
const MAX_MESSAGE_CHARS = 100_000;

export function emptyState() {
  return {
    token: "",
    origin: "",
    paused: false,
    providers: { claude: false, chatgpt: false },
    items: [],
    accepted: {},
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    authExpired: false,
  };
}

export function fingerprint(snapshot) {
  const payload = JSON.stringify({
    provider: snapshot.provider,
    externalId: snapshot.externalId,
    messages: (snapshot.messages ?? []).map((message) => ({
      role: message.role,
      externalId: message.externalId ?? "",
      text: message.text ?? "",
    })),
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function clone(state) {
  return JSON.parse(JSON.stringify(state ?? emptyState()));
}

function itemKey(provider, externalId) {
  return `${provider}:${externalId}`;
}

function stamp(now) {
  return new Date(now).toISOString();
}

export function enqueue(state, snapshot, now = Date.now()) {
  const next = clone({
    ...emptyState(),
    ...state,
    providers: { ...emptyState().providers, ...state?.providers },
  });
  if (!snapshot?.provider || !snapshot.externalId) return next;
  if (next.paused || next.authExpired || !next.token || !next.origin) return next;
  if (!next.providers?.[snapshot.provider]) return next;
  const hash = fingerprint(snapshot);
  const key = itemKey(snapshot.provider, snapshot.externalId);
  if (next.accepted[key] === hash) return next;
  const pending = next.items.find((item) => item.key === key);
  if (pending && pending.hash === hash) return next;
  const item = {
    key,
    provider: snapshot.provider,
    externalId: snapshot.externalId,
    title: typeof snapshot.title === "string" ? snapshot.title.slice(0, 300) : "",
    messages: (snapshot.messages ?? []).map((message) => ({
      role: message.role,
      text: String(message.text ?? "").slice(0, MAX_MESSAGE_CHARS),
      ...(message.externalId ? { externalId: message.externalId } : {}),
      ...(message.sourceCreatedAt ? { sourceCreatedAt: message.sourceCreatedAt } : {}),
    })),
    hash,
    attempts: 0,
    nextAttemptAt: now,
    stopped: false,
    lastCode: null,
  };
  next.items = next.items.filter((entry) => entry.key !== key);
  if (payloadTooLarge(item)) {
    item.stopped = true;
    item.nextAttemptAt = null;
    item.lastCode = "OVERSIZED";
    next.lastErrorAt = stamp(now);
    next.lastErrorCode = "OVERSIZED";
  }
  next.items.push(item);
  return next;
}

export function dueItems(state, now = Date.now()) {
  if (!state || state.authExpired || state.paused || !state.token || !state.origin) return [];
  return (state.items ?? []).filter(
    (item) => !item.stopped && item.attempts < MAX_ATTEMPTS && (item.nextAttemptAt ?? 0) <= now
  );
}

export function applyResult(state, item, result, now = Date.now()) {
  const next = clone(state);
  const current = next.items.find((entry) => entry.key === item.key);
  if (!current) return next;
  if (result?.ok) {
    next.items = next.items.filter((entry) => entry.key !== item.key);
    next.accepted[item.key] = item.hash;
    next.lastSuccessAt = stamp(now);
    next.lastErrorAt = null;
    next.lastErrorCode = null;
    next.authExpired = false;
    return next;
  }
  const code = result?.code || "TRANSIENT";
  current.lastCode = code;
  current.attempts += 1;
  next.lastErrorAt = stamp(now);
  next.lastErrorCode = code;
  if (code === "AUTH") {
    next.authExpired = true;
    current.stopped = true;
    current.nextAttemptAt = null;
    return next;
  }
  if (code === "PAUSED") {
    next.paused = true;
    current.stopped = true;
    current.nextAttemptAt = null;
    return next;
  }
  if (!result?.retry || current.attempts >= MAX_ATTEMPTS) {
    current.stopped = true;
    current.nextAttemptAt = null;
    return next;
  }
  const delay = DELAYS[Math.min(current.attempts - 1, DELAYS.length - 1)];
  current.nextAttemptAt = now + delay;
  return next;
}

export function setToken(state, token, now = Date.now()) {
  const next = clone({ ...emptyState(), ...state });
  next.token = typeof token === "string" ? token.trim() : "";
  if (!next.token) {
    next.authExpired = true;
    return next;
  }
  next.authExpired = false;
  next.items = next.items.map((item) =>
    item.lastCode === "AUTH"
      ? { ...item, stopped: false, attempts: 0, nextAttemptAt: now, lastCode: null }
      : item
  );
  return next;
}

export function setPaused(state, paused, now = Date.now()) {
  const next = clone({ ...emptyState(), ...state });
  next.paused = Boolean(paused);
  if (!next.paused) {
    next.items = next.items.map((item) =>
      item.lastCode === "PAUSED"
        ? { ...item, stopped: false, attempts: 0, nextAttemptAt: now, lastCode: null }
        : item
    );
  }
  return next;
}

export function setProviderEnabled(state, provider, enabled) {
  const next = clone({
    ...emptyState(),
    ...state,
    providers: { ...emptyState().providers, ...state?.providers },
  });
  if (provider !== "claude" && provider !== "chatgpt") return next;
  next.providers[provider] = Boolean(enabled);
  return next;
}

export function setOrigin(state, origin) {
  const next = clone({ ...emptyState(), ...state });
  next.origin = typeof origin === "string" ? origin : "";
  return next;
}

const PERMANENT = new Set(["AUTH", "PAUSED", "PARTIAL", "OVERSIZED", "REJECTED", "DISABLED"]);

export function retryFailed(state, now = Date.now()) {
  const next = clone(state);
  if (next.authExpired || next.paused) return next;
  next.items = next.items.map((item) => {
    if (!item.stopped || PERMANENT.has(item.lastCode)) return item;
    return { ...item, stopped: false, attempts: 0, nextAttemptAt: now, lastCode: null };
  });
  return next;
}

export function settingsView(state) {
  return {
    origin: state?.origin || "",
    paused: Boolean(state?.paused),
    hasToken: Boolean(state?.token),
    providers: {
      claude: Boolean(state?.providers?.claude),
      chatgpt: Boolean(state?.providers?.chatgpt),
    },
  };
}

export function visibleStatus(state) {
  const items = state?.items ?? [];
  const failed = items.filter((item) => item.stopped && item.lastCode);
  const retrying = items.filter((item) => !item.stopped);
  let label = "Idle";
  if (state?.authExpired || !state?.token) label = "Signed out";
  else if (failed.length) label = "Failed";
  else if (retrying.length) label = "Retrying";
  else if (state?.lastSuccessAt) label = "Captured";
  return {
    label,
    pending: items.length,
    retrying: retrying.length,
    failed: failed.length,
    lastSuccessAt: state?.lastSuccessAt ?? null,
    lastErrorAt: state?.lastErrorAt ?? null,
    lastErrorCode: state?.lastErrorCode ?? null,
    paused: Boolean(state?.paused),
    providers: {
      claude: Boolean(state?.providers?.claude),
      chatgpt: Boolean(state?.providers?.chatgpt),
    },
  };
}
