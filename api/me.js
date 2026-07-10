import { authenticateRequest, AuthError } from "../server/auth/verifyAuth.js";
import { getPrismaClient, isDatabaseConfigured } from "../server/db/prisma.js";
import { respondInternalError } from "../server/http/errorHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../server/http/rateLimit.js";
import { readJsonBody } from "../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../server/http/responseHelpers.js";

const LEGAL_CONSENT_VERSION_MAX_LENGTH = 64;

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

function isMissingConsentColumnError(error) {
  return error?.code === "P2022" && /legalConsent/i.test(String(error?.message || ""));
}

function buildUserPayload(decodedToken, userRecord = null) {
  return {
    id: decodedToken.uid,
    email: decodedToken.email || userRecord?.email || null,
    displayName: decodedToken.name || userRecord?.displayName || null,
    photoURL: decodedToken.picture || userRecord?.photoURL || null,
    emailVerified: Boolean(decodedToken.email_verified),
    role: userRecord?.role || "OWNER",
    legalConsentAt: userRecord?.legalConsentAt || null,
    legalConsentVersion: userRecord?.legalConsentVersion || null,
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

async function upsertUserRecord(prisma, decodedToken, extraColumns = {}) {
  const profileColumns = buildProfileColumns(decodedToken);
  const data = { ...profileColumns, ...extraColumns };

  try {
    return await prisma.user.upsert({
      where: { id: decodedToken.uid },
      update: data,
      create: { id: decodedToken.uid, ...data },
    });
  } catch (error) {
    // Un-migrated database: the consent columns do not exist yet. For a plain
    // profile sync we can still succeed by not touching (or selecting) them.
    if (isMissingConsentColumnError(error) && !Object.keys(extraColumns).length) {
      return prisma.user.upsert({
        where: { id: decodedToken.uid },
        update: profileColumns,
        create: { id: decodedToken.uid, ...profileColumns },
        select: LEGACY_USER_SELECT,
      });
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

  return { version };
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

      let userRecord;
      try {
        // The consent timestamp is stamped with the server clock so it can
        // serve as durable proof of acceptance, independent of client clocks.
        userRecord = await upsertUserRecord(prisma, decodedToken, {
          legalConsentAt: new Date(),
          legalConsentVersion: consent.version,
        });
      } catch (error) {
        if (isMissingConsentColumnError(error)) {
          return response.status(503).json({
            error: true,
            message:
              "Legal consent cannot be recorded until the pending database migration is applied. Please retry shortly.",
          });
        }
        throw error;
      }

      return response.status(200).json({
        user: buildUserPayload(decodedToken, userRecord),
      });
    }

    let userRecord = null;
    if (databaseReady) {
      userRecord = await upsertUserRecord(prisma, decodedToken);
    }

    return response.status(200).json({
      user: buildUserPayload(decodedToken, userRecord),
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
