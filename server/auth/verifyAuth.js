import { getFirebaseAdminAuth, isFirebaseAdminConfigured } from "./firebaseAdmin.js";
import { getPrismaClient, isDatabaseConfigured, withUserContext } from "../db/prisma.js";

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export function readBearerToken(request) {
  const authorizationHeader =
    request?.headers?.authorization || request?.headers?.Authorization || "";
  const match = /^Bearer\s+(.+)$/.exec(String(authorizationHeader).trim());
  return match?.[1] || null;
}

export async function authenticateRequest(request) {
  if (!isFirebaseAdminConfigured()) {
    throw new AuthError("Firebase Admin is not configured on the server.", 503);
  }

  const token = readBearerToken(request);
  if (!token) {
    throw new AuthError("Missing bearer token.", 401);
  }

  const adminAuth = getFirebaseAdminAuth();
  if (!adminAuth) {
    throw new AuthError("Firebase Admin could not be initialized.", 503);
  }

  try {
    const decodedToken = await adminAuth.verifyIdToken(token);

    if (isDatabaseConfigured() && getPrismaClient()) {
      // The uid is already proven by the decoded Firebase token, so the
      // disabled-flag lookup runs in that user's RLS context like every other
      // user-scoped query.
      const userRecord = await withUserContext(decodedToken.uid, (tx) =>
        tx.user.findUnique({
          where: { id: decodedToken.uid },
          select: { isDisabled: true },
        })
      );
      if (userRecord?.isDisabled) {
        throw new AuthError("This account has been disabled.", 403);
      }
    }

    return decodedToken;
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }
    throw new AuthError(error?.message || "Unable to verify the provided auth token.", 401);
  }
}

/**
 * Like authenticateRequest but also requires the user's email to be verified.
 * Used for sensitive operations (Plaid bank linking) to prevent unverified accounts
 * from connecting financial institutions.
 */
export async function authenticateVerifiedRequest(request) {
  const decodedToken = await authenticateRequest(request);
  if (!decodedToken.email_verified) {
    throw new AuthError(
      "Email verification is required before linking bank accounts. Please verify your email address and try again.",
      403
    );
  }
  return decodedToken;
}
