import { buildAuthenticatedHeaders } from "./api.js";

async function parseApiResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || "Plaid request failed.");
  }

  return payload;
}

export async function getPlaidStatus() {
  const response = await fetch("/api/plaid/status");
  return parseApiResponse(response);
}

export async function createPlaidLinkToken({ workspaceUserId, userName }) {
  const response = await fetch("/api/plaid/link-token/create", {
    method: "POST",
    headers: await buildAuthenticatedHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({ workspaceUserId, userName }),
  });

  return parseApiResponse(response);
}

export async function exchangePlaidPublicToken({ workspaceUserId, publicToken }) {
  const response = await fetch("/api/plaid/exchange-public-token", {
    method: "POST",
    headers: await buildAuthenticatedHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({ workspaceUserId, publicToken }),
  });

  return parseApiResponse(response);
}

export async function syncPlaidUser(workspaceUserId) {
  const search = workspaceUserId
    ? `?workspaceUserId=${encodeURIComponent(workspaceUserId)}`
    : "";
  const response = await fetch(`/api/plaid/sync${search}`, {
    headers: await buildAuthenticatedHeaders(),
  });
  return parseApiResponse(response);
}

export async function deletePlaidUser(workspaceUserId) {
  const search = workspaceUserId
    ? `?workspaceUserId=${encodeURIComponent(workspaceUserId)}`
    : "";
  const response = await fetch(`/api/plaid/user${search}`, {
    method: "DELETE",
    headers: await buildAuthenticatedHeaders(),
  });
  return parseApiResponse(response);
}

export async function deletePlaidItem({ itemId, workspaceUserId }) {
  const searchParams = new URLSearchParams();
  if (itemId) searchParams.set("itemId", itemId);
  if (workspaceUserId) searchParams.set("workspaceUserId", workspaceUserId);

  const search = searchParams.toString() ? `?${searchParams.toString()}` : "";
  const response = await fetch(`/api/plaid/item${search}`, {
    method: "DELETE",
    headers: await buildAuthenticatedHeaders(),
  });
  return parseApiResponse(response);
}
