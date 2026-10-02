// User settings shared by PATCH /api/me and the CHIEF settings capabilities.
// The only supported field is User.timezone. Identity, admin, and legal-consent
// columns are not settings and are never selected or written here unless the
// HTTP profile sync explicitly passes its own profile columns.

import { isMissingTimezoneColumnError, normalizeIanaTimeZone } from "./timezone.js";

export const USER_SETTINGS_FIELDS = Object.freeze(["timezone"]);

function settingsError(message, code, status) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function requireUserId(userId) {
  if (typeof userId !== "string" || userId.trim() === "") {
    throw settingsError("Authenticated user is required.", "UNAUTHENTICATED", 401);
  }
  return userId;
}

function normalizeTimezone(timezone) {
  const normalized = normalizeIanaTimeZone(timezone);
  if (!normalized) {
    throw settingsError(
      "timezone must be a valid IANA timezone (e.g. America/New_York).",
      "INVALID_TIMEZONE",
      400
    );
  }
  return normalized;
}

function rethrowSchemaGap(error) {
  if (!isMissingTimezoneColumnError(error)) throw error;
  throw settingsError(
    "Timezone support is not available on this database yet.",
    "TIMEZONE_SCHEMA_MISSING",
    503
  );
}

/** Timezone only. Does not create a user and does not return other columns. */
export async function readUserSettings(userId, { withUser } = {}) {
  const id = requireUserId(userId);
  if (typeof withUser !== "function") {
    throw new TypeError("readUserSettings requires withUser");
  }
  try {
    const record = await withUser(id, (tx) =>
      tx.user.findUnique({
        where: { id },
        select: { timezone: true },
      })
    );
    return { timezone: record?.timezone || null };
  } catch (error) {
    rethrowSchemaGap(error);
  }
}

/**
 * Persist a validated IANA timezone for one user.
 * profileColumns is only for the /api/me profile sync. Callers that do not
 * pass it update timezone and nothing else.
 */
export async function updateUserTimezone(
  userId,
  timezone,
  { profileColumns = null, withUser } = {}
) {
  const id = requireUserId(userId);
  if (typeof withUser !== "function") {
    throw new TypeError("updateUserTimezone requires withUser");
  }
  const normalized = normalizeTimezone(timezone);
  const profile =
    profileColumns && typeof profileColumns === "object" && !Array.isArray(profileColumns)
      ? profileColumns
      : {};
  try {
    return await withUser(id, (tx) =>
      tx.user.upsert({
        where: { id },
        update: { timezone: normalized, ...profile },
        create: { id, ...profile, timezone: normalized },
      })
    );
  } catch (error) {
    rethrowSchemaGap(error);
  }
}
