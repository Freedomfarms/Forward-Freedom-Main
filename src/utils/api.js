import { getCurrentUserIdToken } from "./firebase.js";

export class ApiRequestError extends Error {
  constructor(message, { status, retryAfterMs } = {}) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const AUTHENTICATION_REQUIRED_MESSAGE =
  "Your sign-in session is still restoring, so the secure request was not sent. Refresh or sign out and sign back in, then retry.";

function createAuthenticationError() {
  return new ApiRequestError(AUTHENTICATION_REQUIRED_MESSAGE, { status: 401 });
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

async function parseApiResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiRequestError(
      response.status === 401
        ? AUTHENTICATION_REQUIRED_MESSAGE
        : payload.message || "Request failed.",
      {
        status: response.status,
        retryAfterMs: readRateLimitRetryAfterMs(response),
      }
    );
  }

  return payload;
}

async function resolveAuthenticatedToken(user) {
  if (typeof user?.getIdToken === "function") {
    return user.getIdToken();
  }

  return getCurrentUserIdToken();
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

export async function saveWorkspaceSnapshot({ state, source, lastClientUpdatedAt }, options = {}) {
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
    }),
  });

  return parseApiResponse(response);
}
