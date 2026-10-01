// Browser pointer to the open CHIEF conversation. The id is not a credential.
// The server still loads a session only when it belongs to the Firebase uid.
// The key is namespaced so user B cannot reopen user A's id from sessionStorage.

export const CHIEF_ACTIVE_SESSION_PREFIX = "chief.activeSessionId:";
export const LEGACY_CHIEF_ACTIVE_SESSION_KEY = "chief.activeSessionId";

function storageOf(storage) {
  if (storage) return storage;
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage;
}

export function chiefActiveSessionKey(uid) {
  const id = typeof uid === "string" ? uid.trim() : "";
  if (!id) return null;
  return `${CHIEF_ACTIVE_SESSION_PREFIX}${id}`;
}

export function readChiefActiveSessionId(uid, storage) {
  const store = storageOf(storage);
  const key = chiefActiveSessionKey(uid);
  if (!store || !key) return null;
  try {
    const value = store.getItem(key);
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

export function writeChiefActiveSessionId(uid, sessionId, storage) {
  const store = storageOf(storage);
  const key = chiefActiveSessionKey(uid);
  if (!store || !key) return;
  try {
    if (sessionId) store.setItem(key, sessionId);
    else store.removeItem(key);
  } catch {
    // Private browsing can reject storage. The open tab still works.
  }
}

export function clearChiefActiveSessionId(uid, storage) {
  writeChiefActiveSessionId(uid, null, storage);
  discardLegacyChiefActiveSessionKey(storage);
}

export function discardLegacyChiefActiveSessionKey(storage) {
  const store = storageOf(storage);
  if (!store) return;
  try {
    store.removeItem(LEGACY_CHIEF_ACTIVE_SESSION_KEY);
  } catch {
    // Ignore storage failures.
  }
}
