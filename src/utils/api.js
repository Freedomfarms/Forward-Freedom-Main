import { getCurrentUserIdToken, waitForUserIdToken } from "./firebase.js";

export class ApiRequestError extends Error {
  constructor(message, { status, retryAfterMs, payload } = {}) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    // Raw response body, e.g. the current server snapshot on 409 conflicts.
    this.payload = payload;
  }
}

export const AUTHENTICATION_REQUIRED_MESSAGE =
  "Your sign-in session is still restoring, so the secure request was not sent. Refresh or sign out and sign back in, then retry.";

const AUTH_TOKEN_RETRY_DELAYS_MS = [0, 400, 1000, 2000];

function sleep(ms) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function createAuthenticationError() {
  return new ApiRequestError(AUTHENTICATION_REQUIRED_MESSAGE, { status: 401 });
}

export function isApiAuthenticationError(error) {
  return error instanceof ApiRequestError && error.status === 401;
}

function readRateLimitRetryAfterMs(response) {
  if (response.status !== 429) {
    return undefined;
  }

  const retryAfterHeader = Number(response.headers.get("Retry-After"));
  if (Number.isFinite(retryAfterHeader) && retryAfterHeader > 0) {
    return retryAfterHeader * 1000;
  }

  const rateLimitReset = Number(response.headers.get("RateLimit-Reset"));
  if (Number.isFinite(rateLimitReset) && rateLimitReset > 0) {
    return rateLimitReset * 1000;
  }

  return undefined;
}

function buildUnauthorizedErrorMessage(payload) {
  const serverMessage = typeof payload?.message === "string" ? payload.message.trim() : "";
  if (!serverMessage || serverMessage === "Missing bearer token.") {
    return AUTHENTICATION_REQUIRED_MESSAGE;
  }

  return `Secure workspace request was rejected: ${serverMessage}`;
}

async function parseApiResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiRequestError(
      response.status === 401
        ? buildUnauthorizedErrorMessage(payload)
        : payload.message || "Request failed.",
      {
        status: response.status,
        retryAfterMs: readRateLimitRetryAfterMs(response),
        payload,
      }
    );
  }

  return payload;
}

async function readAuthenticatedToken(user, forceRefresh = false) {
  if (typeof user?.getIdToken === "function") {
    return user.getIdToken(forceRefresh);
  }

  return getCurrentUserIdToken(forceRefresh);
}

async function resolveAuthenticatedToken(user) {
  if (typeof user?.getIdToken === "function") {
    const token = await waitForUserIdToken(user);
    if (token) {
      return token;
    }
  }

  for (let attempt = 0; attempt < AUTH_TOKEN_RETRY_DELAYS_MS.length; attempt += 1) {
    const forceRefresh = attempt === AUTH_TOKEN_RETRY_DELAYS_MS.length - 1;
    const token = await readAuthenticatedToken(user, forceRefresh);
    if (token) {
      return token;
    }

    if (attempt < AUTH_TOKEN_RETRY_DELAYS_MS.length - 1) {
      await sleep(AUTH_TOKEN_RETRY_DELAYS_MS[attempt + 1] - AUTH_TOKEN_RETRY_DELAYS_MS[attempt]);
    }
  }

  return null;
}

export async function buildAuthenticatedHeaders(headers = {}, { user = null } = {}) {
  const token = await resolveAuthenticatedToken(user);

  if (!token) {
    throw createAuthenticationError();
  }

  const authenticatedHeaders = {
    ...headers,
    Authorization: `Bearer ${token}`,
  };

  return authenticatedHeaders;
}

export async function fetchAuthenticatedUserProfile(options = {}) {
  const response = await fetch("/api/me", {
    headers: await buildAuthenticatedHeaders({}, options),
  });

  return parseApiResponse(response);
}

export async function fetchWorkspaceSnapshot(options = {}) {
  const response = await fetch("/api/workspace", {
    headers: await buildAuthenticatedHeaders(
      {
        "Cache-Control": "no-store",
      },
      options
    ),
  });

  return parseApiResponse(response);
}

export async function saveWorkspaceSnapshot(
  { state, source, lastClientUpdatedAt, baseSnapshotUpdatedAt = null },
  options = {}
) {
  const response = await fetch("/api/workspace", {
    method: "PUT",
    headers: await buildAuthenticatedHeaders(
      {
        "Content-Type": "application/json",
      },
      options
    ),
    body: JSON.stringify({
      state,
      source,
      lastClientUpdatedAt,
      // Optimistic-concurrency marker: the server `updatedAt` this state is
      // based on (null when the client believes no snapshot exists yet). The
      // server rejects the save with a 409 if another session saved first.
      baseSnapshotUpdatedAt,
    }),
  });

  return parseApiResponse(response);
}

export function isWorkspaceConflictError(error) {
  return error instanceof ApiRequestError && error.status === 409;
}

// Server-side legal-consent gate (H-9): any sensitive route can reject a
// request with 403 + { requiresLegalConsent: true } when consent is missing or
// the accepted version is out of date.
export function isLegalConsentRequiredError(error) {
  return (
    error instanceof ApiRequestError &&
    error.status === 403 &&
    Boolean(error.payload?.requiresLegalConsent)
  );
}

export async function recordLegalConsent({ version, method = null }, options = {}) {
  const response = await fetch("/api/me", {
    method: "POST",
    headers: await buildAuthenticatedHeaders(
      {
        "Content-Type": "application/json",
      },
      options
    ),
    body: JSON.stringify({
      legalConsent: { version, ...(method ? { method } : {}) },
    }),
  });

  return parseApiResponse(response);
}
