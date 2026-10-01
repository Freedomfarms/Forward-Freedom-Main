// Sign-out residue that is not already namespaced by Firebase uid.
// Workspace cache stays at fff-app-state-v1:<uid> and is not touched here.

import { clearChiefActiveSessionId } from "./chiefActiveSession.js";
import { PENDING_LINK_KEY } from "./plaidOAuth.js";

export const PENDING_LEGAL_CONSENT_STORAGE_KEY = "fff::pendingLegalConsent";
export const PLAID_PENDING_LINK_STORAGE_KEY = PENDING_LINK_KEY;

function removeKey(store, key) {
  if (!store || typeof store.removeItem !== "function") return;
  try {
    store.removeItem(key);
  } catch {
    // Ignore storage failures.
  }
}

export function clearSignedOutClientState(uid, { sessionStore = null, localStore = null } = {}) {
  const session = sessionStore || (typeof sessionStorage === "undefined" ? null : sessionStorage);
  const local = localStore || (typeof localStorage === "undefined" ? null : localStorage);
  clearChiefActiveSessionId(uid, session);
  removeKey(session, PLAID_PENDING_LINK_STORAGE_KEY);
  removeKey(local, PENDING_LEGAL_CONSENT_STORAGE_KEY);
}
