import { LEGAL_CONSENT_VERSION } from "../content/legalContent.js";
import { recordLegalConsent } from "./api.js";
import { PENDING_LEGAL_CONSENT_STORAGE_KEY } from "./clientSessionCleanup.js";

// Legal consent is checked in the auth UI before the Firebase session exists,
// so the acceptance is staged in localStorage and flushed to the server (with
// an authenticated request) as soon as a session is available. This gives a
// durable server-side record of when and which document revision the user
// accepted, and survives reloads or popup/redirect sign-in flows where the
// immediate post-sign-in request could be interrupted.
//
// When an email is known, it is stored on the marker. A later flush for a
// different signed-in email discards the marker instead of recording it.

function normalizeConsentEmail(email) {
  const value = String(email || "")
    .trim()
    .toLowerCase();
  return value || null;
}

function consentEmailFrom(options) {
  if (typeof options === "string") return normalizeConsentEmail(options);
  return normalizeConsentEmail(options?.email);
}

export function markPendingLegalConsent(method = null, options = {}) {
  const email = consentEmailFrom(options);
  const record = {
    version: LEGAL_CONSENT_VERSION,
    method: method || null,
    agreedAt: new Date().toISOString(),
  };
  if (email) record.email = email;
  try {
    window.localStorage.setItem(PENDING_LEGAL_CONSENT_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage unavailable (private mode/quota): the flush below will be a
    // no-op, but consent is still enforced by the auth form itself.
  }
}

export function bindPendingLegalConsentEmail(email) {
  const pending = readPendingLegalConsent();
  const normalized = normalizeConsentEmail(email);
  if (!pending || !normalized) return false;
  if (pending.email && pending.email !== normalized) return false;
  try {
    window.localStorage.setItem(
      PENDING_LEGAL_CONSENT_STORAGE_KEY,
      JSON.stringify({ ...pending, email: normalized })
    );
    return true;
  } catch {
    return false;
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

export function clearPendingLegalConsent() {
  try {
    window.localStorage.removeItem(PENDING_LEGAL_CONSENT_STORAGE_KEY);
  } catch {
    // Ignore storage failures; a stale record is retried and re-cleared later.
  }
}

export async function flushPendingLegalConsent(options = {}) {
  const pending = readPendingLegalConsent();
  if (!pending) return false;

  const userEmail = normalizeConsentEmail(options.user?.email);
  if (pending.email) {
    if (userEmail && pending.email !== userEmail) {
      clearPendingLegalConsent();
      return false;
    }
  } else if (userEmail) {
    // Unbound marker plus a known account would stamp whoever happens to be
    // signed in. Leave it unapplied. Sign-out deletes the marker.
    return false;
  }

  let payload;
  try {
    payload = await recordLegalConsent(
      { version: pending.version, method: pending.method },
      options
    );
  } catch (error) {
    // Keep the pending record so the next authenticated session retries.
    console.warn("[legal-consent] Unable to record consent on the server yet.", error);
    return false;
  }

  // The server accepted the request but could not durably persist consent
  // (its database has not been migrated yet). Keep the pending marker so a
  // later session flushes it once the migration is applied.
  if (payload?.legalConsentPersisted === false) {
    console.warn(
      "[legal-consent] Server deferred consent recording until its database is migrated."
    );
    return false;
  }

  clearPendingLegalConsent();
  return true;
}

// Records consent for the currently authenticated session (used by the
// in-app re-consent gate when the accepted version is out of date). Clears any
// stale pending marker on success.
export async function submitLegalConsent({ method = "reconsent" } = {}, options = {}) {
  const payload = await recordLegalConsent({ version: LEGAL_CONSENT_VERSION, method }, options);

  // Deferred by an un-migrated server database: stage the acceptance locally
  // so it is flushed on a later session, and let the gate close now (the
  // server fails open on enforcement in this same state).
  if (payload?.legalConsentPersisted === false) {
    markPendingLegalConsent(method, { email: options.user?.email });
    return true;
  }

  clearPendingLegalConsent();
  return true;
}
