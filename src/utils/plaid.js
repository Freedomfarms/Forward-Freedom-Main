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

export async function createPlaidLinkToken({ userId, userName }) {
  const response = await fetch("/api/plaid/link-token/create", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ userId, userName }),
  });

  return parseApiResponse(response);
}

export async function exchangePlaidPublicToken({ userId, publicToken }) {
  const response = await fetch("/api/plaid/exchange-public-token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ userId, publicToken }),
  });

  return parseApiResponse(response);
}

export async function syncPlaidUser(userId) {
  const response = await fetch(`/api/plaid/sync?userId=${encodeURIComponent(userId)}`);
  return parseApiResponse(response);
}
