// Browser pointer to the ElevenLabs voice_id the person picked.
// The id is not a credential. Speech still goes through the authenticated
// CHIEF speak route, which holds the API key.

export const CHIEF_VOICE_PREFIX = "chief.voiceId:";

function storageOf(storage) {
  if (storage) return storage;
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

export function chiefVoiceKey(uid) {
  const id = typeof uid === "string" ? uid.trim() : "";
  if (!id) return null;
  return `${CHIEF_VOICE_PREFIX}${id}`;
}

export function readChiefVoiceId(uid, storage) {
  const store = storageOf(storage);
  const key = chiefVoiceKey(uid);
  if (!store || !key) return "";
  try {
    const value = store.getItem(key);
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

export function writeChiefVoiceId(uid, voiceId, storage) {
  const store = storageOf(storage);
  const key = chiefVoiceKey(uid);
  if (!store || !key) return;
  try {
    if (voiceId) store.setItem(key, voiceId);
    else store.removeItem(key);
  } catch {
    // Private browsing can reject storage. The open tab still works.
  }
}
