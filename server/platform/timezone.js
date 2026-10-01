// User-profile IANA timezone helpers. Shared by /api/me. This module does not
// import the retired agent platform or its schedule helpers.

/** Default IANA timezone when the user has not set one (Eastern Time). */
export const DEFAULT_USER_TIMEZONE = "America/New_York";

function timezoneRequestError(message, code, status) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

/** True when Prisma/Postgres reports User.timezone is not migrated yet. */
export function isMissingTimezoneColumnError(error) {
  const message = String(error?.message || "");
  return (
    (error?.code === "P2022" || /does not exist|Unknown column|column .* missing/i.test(message)) &&
    /timezone/i.test(message)
  );
}

export function isValidIanaTimeZone(value) {
  if (typeof value !== "string") return false;
  const tz = value.trim();
  if (!tz || tz.length > 64) return false;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Trim and validate an IANA timezone.
 * null / empty → null. Non-strings and unknown zones throw an HTTP-tagged error
 * (`error.status` 400, `error.code` INVALID_TIMEZONE).
 */
export function normalizeIanaTimeZone(value) {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw timezoneRequestError("timezone must be a string.", "INVALID_TIMEZONE", 400);
  }
  const tz = value.trim();
  if (!tz) return null;
  if (!isValidIanaTimeZone(tz)) {
    throw timezoneRequestError(
      "timezone must be a valid IANA timezone (e.g. America/New_York).",
      "INVALID_TIMEZONE",
      400
    );
  }
  return tz;
}

/**
 * Prefer a valid user/browser value; otherwise America/New_York (Eastern).
 */
export function resolveUserTimeZone(value) {
  if (typeof value === "string") {
    const tz = value.trim();
    if (tz && isValidIanaTimeZone(tz)) return tz;
  }
  return DEFAULT_USER_TIMEZONE;
}
