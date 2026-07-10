import { LEGAL_CONSENT_VERSION } from "../content/legalContent.js";
import { recordLegalConsent } from "./api.js";

// Legal consent is checked in the auth UI before the Firebase session exists,
// so the acceptance is staged in localStorage and flushed to the server (with
// an authenticated request) as soon as a session is available. This gives a
// durable server-side record of when and which document revision the user
// accepted, and survives reloads or popup/redirect sign-in flows where the
// immediate post-sign-in request could be interrupted.
const PENDING_LEGAL_CONSENT_STORAGE_KEY = "fff::pendingLegalConsent";

export function markPendingLegalConsent() {
  try {
    window.localStorage.setItem(
      PENDING_LEGAL_CONSENT_STORAGE_KEY,
      JSON.stringify({
        version: LEGAL_CONSENT_VERSION,
        agreedAt: new Date().toISOString(),
      })
    );
  } catch {
    // Storage unavailable (private mode/quota): the flush below will be a
    // no-op, but consent is still enforced by the auth form itself.
  }
}

function readPendingLegalConsent() {
  try {
    const raw = window.localStorage.getItem(PENDING_LEGAL_CONSENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.version !== "string" || !parsed.version) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function clearPendingLegalConsent() {
  try {
    window.localStorage.removeItem(PENDING_LEGAL_CONSENT_STORAGE_KEY);
  } catch {
    // Ignore storage failures; a stale record is retried and re-cleared later.
  }
}

export async function flushPendingLegalConsent(options = {}) {
  const pending = readPendingLegalConsent();
  if (!pending) return false;

  try {
    await recordLegalConsent({ version: pending.version }, options);
  } catch (error) {
    // Keep the pending record so the next authenticated session retries.
    console.warn("[legal-consent] Unable to record consent on the server yet.", error);
    return false;
  }

  clearPendingLegalConsent();
  return true;
}
