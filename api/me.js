import { authenticateRequest, AuthError } from "../server/auth/verifyAuth.js";
import {
  isMissingConsentColumnError,
  isMissingConsentHistoryTableError,
} from "../server/auth/legalConsent.js";
import { getPrismaClient, isDatabaseConfigured } from "../server/db/prisma.js";
import { respondInternalError } from "../server/http/errorHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../server/http/rateLimit.js";
import { readJsonBody } from "../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../server/http/responseHelpers.js";

const LEGAL_CONSENT_VERSION_MAX_LENGTH = 64;
const LEGAL_CONSENT_METHOD_MAX_LENGTH = 32;

// Column set that predates the user_legal_consent migration. Used to keep
// /api/me working against a production database that has not been migrated
// yet (deploys can briefly run new code against an older schema).
const LEGACY_USER_SELECT = {
  id: true,
  email: true,
  displayName: true,
  photoURL: true,
  role: true,
  isDisabled: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
};

function buildUserPayload(decodedToken, userRecord = null, { consentColumnsMissing = false } = {}) {
  return {
    id: decodedToken.uid,
    email: decodedToken.email || userRecord?.email || null,
    displayName: decodedToken.name || userRecord?.displayName || null,
    photoURL: decodedToken.picture || userRecord?.photoURL || null,
    emailVerified: Boolean(decodedToken.email_verified),
    role: userRecord?.role || "OWNER",
    legalConsentAt: userRecord?.legalConsentAt || null,
    legalConsentVersion: userRecord?.legalConsentVersion || null,
    // False while the user_legal_consent migration is pending on this
    // database. The client must not block sign-in on the consent gate in that
    // state (server-side enforcement also fails open until migrated).
    legalConsentSchemaReady: !consentColumnsMissing,
  };
}

function buildProfileColumns(decodedToken) {
  return {
    email: decodedToken.email || null,
    displayName: decodedToken.name || null,
    photoURL: decodedToken.picture || null,
    lastLoginAt: new Date(),
  };
}

function buildLegacyProfileUpsert(decodedToken) {
  const profileColumns = buildProfileColumns(decodedToken);
  return {
    where: { id: decodedToken.uid },
    update: profileColumns,
    create: { id: decodedToken.uid, ...profileColumns },
    select: LEGACY_USER_SELECT,
  };
}

async function upsertUserRecord(prisma, decodedToken) {
  const profileColumns = buildProfileColumns(decodedToken);

  try {
    const record = await prisma.user.upsert({
      where: { id: decodedToken.uid },
      update: profileColumns,
      create: { id: decodedToken.uid, ...profileColumns },
    });
    return { record, consentColumnsMissing: false };
  } catch (error) {
    // Un-migrated database: the consent columns do not exist yet. A plain
    // profile sync can still succeed by not touching (or selecting) them.
    if (isMissingConsentColumnError(error)) {
      const record = await prisma.user.upsert(buildLegacyProfileUpsert(decodedToken));
      return { record, consentColumnsMissing: true };
    }
    throw error;
  }
}

function parseLegalConsentPayload(payload) {
  const consent = payload?.legalConsent;
  if (!consent || typeof consent !== "object" || Array.isArray(consent)) {
    return null;
  }

  const version = typeof consent.version === "string" ? consent.version.trim() : "";
  if (!version || version.length > LEGAL_CONSENT_VERSION_MAX_LENGTH) {
    return null;
  }

  const rawMethod = typeof consent.method === "string" ? consent.method.trim() : "";
  const method = rawMethod.slice(0, LEGAL_CONSENT_METHOD_MAX_LENGTH) || null;

  return { version, method };
}

// Records the acceptance both as the latest consent on User (fast path for
// enforcement) and as an immutable audit-trail row. Written atomically so the
// two never diverge. Falls back gracefully when only part of the newer schema
// has been migrated.
async function recordLegalConsent(prisma, decodedToken, consent) {
  const profileColumns = buildProfileColumns(decodedToken);
  const consentColumns = {
    legalConsentAt: new Date(),
    legalConsentVersion: consent.version,
  };
  const userUpsert = {
    where: { id: decodedToken.uid },
    update: { ...profileColumns, ...consentColumns },
    create: { id: decodedToken.uid, ...profileColumns, ...consentColumns },
  };

  try {
    const [userRecord] = await prisma.$transaction([
      prisma.user.upsert(userUpsert),
      prisma.legalConsentEvent.create({
        data: {
          userId: decodedToken.uid,
          version: consent.version,
          method: consent.method,
        },
      }),
    ]);
    return { userRecord, persisted: true, consentColumnsMissing: false };
  } catch (transactionError) {
    let error = transactionError;

    // History table not migrated yet: still persist the latest consent so
    // enforcement works, but skip the audit row until the migration runs.
    if (isMissingConsentHistoryTableError(error)) {
      console.warn(
        "[api/me] Consent history table missing; recording latest consent only until the migration is applied."
      );
      try {
        const userRecord = await prisma.user.upsert(userUpsert);
        return { userRecord, persisted: true, consentColumnsMissing: false };
      } catch (retryError) {
        if (!isMissingConsentColumnError(retryError)) throw retryError;
        error = retryError;
      }
    }

    // Fully un-migrated database: the consent columns themselves are missing.
    // Sync the profile without them and report the consent as not yet
    // persisted so the client keeps its pending marker and retries after the
    // migration lands. A hard failure here would lock every user out at
    // sign-on, even though server-side enforcement deliberately fails open in
    // this same state.
    if (isMissingConsentColumnError(error)) {
      console.warn(
        "[api/me] Consent columns missing; consent acceptance deferred until the migration is applied."
      );
      const userRecord = await prisma.user.upsert(buildLegacyProfileUpsert(decodedToken));
      return { userRecord, persisted: false, consentColumnsMissing: true };
    }

    throw error;
  }
}

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  if (!["GET", "POST"].includes(request.method || "")) {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }

  try {
    const decodedToken = await authenticateRequest(request);
    const prisma = getPrismaClient();
    const databaseReady = Boolean(prisma) && isDatabaseConfigured();

    if (request.method === "POST") {
      const payload = await readJsonBody(request);
      const consent = parseLegalConsentPayload(payload);

      if (!consent) {
        return response.status(400).json({
          error: true,
          message: "A legalConsent object with a version string is required.",
        });
      }

      if (!databaseReady) {
        return response.status(503).json({
          error: true,
          message: "Database is not configured, so legal consent cannot be recorded yet.",
        });
      }

      // The consent timestamp is stamped with the server clock so it can
      // serve as durable proof of acceptance, independent of client clocks.
      const { userRecord, persisted, consentColumnsMissing } = await recordLegalConsent(
        prisma,
        decodedToken,
        consent
      );

      return response.status(200).json({
        user: buildUserPayload(decodedToken, userRecord, { consentColumnsMissing }),
        legalConsentPersisted: persisted,
      });
    }

    let userRecord = null;
    let consentColumnsMissing = false;
    if (databaseReady) {
      ({ record: userRecord, consentColumnsMissing } = await upsertUserRecord(
        prisma,
        decodedToken
      ));
    }

    return response.status(200).json({
      user: buildUserPayload(decodedToken, userRecord, { consentColumnsMissing }),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return response.status(error.status).json({
        error: true,
        message: error.message,
      });
    }

    if (error?.status === 400) {
      return response.status(400).json({ error: true, message: error.message });
    }

    return respondInternalError(
      response,
      "api/me",
      error,
      "Unable to load the authenticated workspace profile."
    );
  }
}
