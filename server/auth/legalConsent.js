import { LEGAL_CONSENT_VERSION } from "../../src/content/legalContent.js";

// Server-side legal-consent enforcement (H-9). The client checkbox is a UX
// gate only; these helpers make consent a hard requirement before sensitive
// financial mutations and force re-acceptance when the legal version changes.

export { LEGAL_CONSENT_VERSION };

export class LegalConsentError extends Error {
  constructor(message = "Legal consent is required before continuing.", { requiredVersion } = {}) {
    super(message);
    this.name = "LegalConsentError";
    this.status = 403;
    this.requiresLegalConsent = true;
    this.requiredVersion = requiredVersion || LEGAL_CONSENT_VERSION;
  }
}

// True when the P2022 error is caused by the consent columns not existing yet
// (a database that has not received the user_legal_consent migration).
export function isMissingConsentColumnError(error) {
  return error?.code === "P2022" && /legalConsent/i.test(String(error?.message || ""));
}

// True when the consent history table has not been created yet (a database
// that has not received the legal_consent_history migration).
export function isMissingConsentHistoryTableError(error) {
  return (
    (error?.code === "P2021" || error?.code === "P2022") &&
    /LegalConsentEvent/i.test(String(error?.message || ""))
  );
}

export function hasValidLegalConsent(userRecord, requiredVersion = LEGAL_CONSENT_VERSION) {
  return Boolean(userRecord?.legalConsentAt) && userRecord?.legalConsentVersion === requiredVersion;
}

function buildConsentErrorMessage(userRecord) {
  if (userRecord?.legalConsentAt) {
    return "The Terms of Service and Privacy Policy have been updated. Please review and accept the current version before continuing.";
  }
  return "You must accept the Terms of Service and Privacy Policy before continuing.";
}

/**
 * Throws LegalConsentError (HTTP 403) when the authenticated user has not
 * accepted the current legal version.
 *
 * Fail-open cases (returns { enforced: false }) — deliberately lenient so a
 * lagging migration or unconfigured database never locks every user out,
 * consistent with the schema-capability tolerance used elsewhere:
 *   - no Prisma client / database not configured
 *   - the consent columns do not exist yet (un-migrated database)
 */
export async function requireLegalConsent(prisma, userId) {
  if (!prisma || !userId) {
    return { enforced: false, reason: "no-database" };
  }

  let userRecord;
  try {
    userRecord = await prisma.user.findUnique({
      where: { id: userId },
      select: { legalConsentAt: true, legalConsentVersion: true },
    });
  } catch (error) {
    if (isMissingConsentColumnError(error)) {
      console.warn(
        "[legal-consent] Consent columns are missing; enforcement skipped until the migration is applied."
      );
      return { enforced: false, reason: "schema-unmigrated" };
    }
    throw error;
  }

  if (!hasValidLegalConsent(userRecord)) {
    throw new LegalConsentError(buildConsentErrorMessage(userRecord), {
      requiredVersion: LEGAL_CONSENT_VERSION,
    });
  }

  return { enforced: true, userRecord };
}

// Uniform 403 body so every client can detect the consent requirement and
// route the user back into the acceptance flow.
export function respondLegalConsentRequired(response, error) {
  return response.status(403).json({
    error: true,
    requiresLegalConsent: true,
    requiredVersion: error?.requiredVersion || LEGAL_CONSENT_VERSION,
    message: error?.message || "Legal consent is required before continuing.",
  });
}
