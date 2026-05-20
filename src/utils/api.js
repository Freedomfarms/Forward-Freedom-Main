import { getCurrentUserIdToken } from "./firebase.js";

async function parseApiResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || "Request failed.");
  }

  return payload;
}

async function buildAuthenticatedHeaders(headers = {}) {
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
