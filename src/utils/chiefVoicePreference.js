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

const LIBRARY_VOICE_CATEGORIES = new Set(["professional", "famous", "high_quality"]);

// Voice Library voices answer 402 on the Free API plan. Premade, cloned, and
// generated voices are the ones that plan can speak.
export function voiceAllowedOnFreePlan(voice) {
  if (!voice || typeof voice.voice_id !== "string" || !voice.voice_id.trim()) return false;
  if (voice.free_users_allowed === false) return false;
  const category = typeof voice.category === "string" ? voice.category : "";
  return !LIBRARY_VOICE_CATEGORIES.has(category);
}

// Keep a saved voice when the Free plan can speak it. Otherwise use the
// configured ELEVENLABS_VOICE_ID when that id is in the free-tier list, then
// the first premade voice the account API returned.
export function selectChiefVoiceId(voices, { stored = "", configured = "" } = {}) {
  const list = Array.isArray(voices) ? voices : [];
  const allowed = list.filter(voiceAllowedOnFreePlan);
  if (stored && allowed.some((voice) => voice.voice_id === stored)) return stored;
  if (configured && allowed.some((voice) => voice.voice_id === configured)) return configured;
  const premade = allowed.find((voice) => voice.category === "premade");
  return (premade || allowed[0])?.voice_id || "";
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
