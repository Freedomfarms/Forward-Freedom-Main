import { getCurrentUserIdToken } from "./firebase.js";

export class ApiRequestError extends Error {
  constructor(message, { status, retryAfterMs } = {}) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
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
    throw new ApiRequestError(payload.message || "Request failed.", {
      status: response.status,
      retryAfterMs: readRateLimitRetryAfterMs(response),
    });
  }

  return payload;
}

export async function buildAuthenticatedHeaders(headers = {}) {
  const token = await getCurrentUserIdToken();

  return {
    ...headers,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function fetchAuthenticatedUserProfile() {
  const response = await fetch("/api/me", {
    headers: await buildAuthenticatedHeaders(),
  });

  return parseApiResponse(response);
}

export async function fetchWorkspaceSnapshot() {
  const response = await fetch("/api/workspace", {
    headers: await buildAuthenticatedHeaders({
      "Cache-Control": "no-store",
    }),
  });

  return parseApiResponse(response);
}

export async function saveWorkspaceSnapshot({ state, source, lastClientUpdatedAt }) {
  const response = await fetch("/api/workspace", {
    method: "PUT",
    headers: await buildAuthenticatedHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({
      state,
      source,
      lastClientUpdatedAt,
    }),
  });

  return parseApiResponse(response);
}
