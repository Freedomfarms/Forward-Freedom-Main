import { buildAuthenticatedHeaders } from "./api.js";

function formatPlaidApiError(payload, fallbackMessage) {
  const message = payload.message || fallbackMessage;
  const code = payload.code || null;
  if (code && message && !message.includes(code)) {
    return { message: `${message} (${code})`, code, payload };
  }
  return { message, code, payload };
}

// Builds the message shown when an error response has no JSON body. Our API
// handlers always answer with { message, code }, so a body-less error means the
// request was rejected at the edge (Vercel Firewall / Attack Challenge Mode /
// WAF rule) before it ever reached our function. No app code change can fix
// that — it is a hosting setting — so the message points straight at the cause.
function describeEdgeError(status) {
  if (status === 403) {
    return (
      "Request blocked before reaching the server (HTTP 403). This is a hosting " +
      "firewall block (Vercel Firewall — e.g. Attack Challenge Mode or a WAF " +
      "rule), not an app error. Disable it in Vercel → your project → Firewall " +
      "(turn off Attack Challenge Mode or add an Allow rule for /api/plaid/*), " +
      "then retry."
    );
  }
  return `Plaid request failed (HTTP ${status}).`;
}

async function parseApiResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // A 401 here means the request carried no valid Firebase session (missing or
    // expired/invalid token). The raw server text ("Missing bearer token.") is
    // not actionable for users, and this is the common failure when the site is
    // opened on a domain where you are not signed in (e.g. a custom domain that
    // is not in Firebase Authentication > Authorized domains). Point at the fix.
    if (response.status === 401) {
      const error = new Error(
        "You are not signed in on this site, so the bank connection request was rejected. " +
          "Sign out and sign back in here, then try again. (If this only happens on your custom " +
          "domain, add it to Firebase Authentication > Settings > Authorized domains.)"
      );
      error.code = payload.code || "UNAUTHENTICATED";
      error.status = 401;
      error.payload = payload;
      throw error;
    }

    // When the body has no JSON message the failure did not come from our API
    // handler (which always returns { message, code }); it is an edge/platform
    // error page. Surface the HTTP status and likely cause so it is diagnosable.
    const fallbackMessage = payload.message
      ? "Plaid request failed."
      : describeEdgeError(response.status);
    const formatted = formatPlaidApiError(payload, fallbackMessage);
    const error = new Error(formatted.message);
    error.code = formatted.code;
    error.status = response.status;
    error.payload = formatted.payload;
    throw error;
  }

  return payload;
}

export function shouldFetchPlaidStatus({
  currentView = "landing",
  isDemoMode = false,
  sessionUser = null,
} = {}) {
  return currentView === "app" && !isDemoMode && typeof sessionUser?.getIdToken === "function";
}

export async function getPlaidStatus(options = {}) {
  const response = await fetch("/api/plaid/status", {
    headers: await buildAuthenticatedHeaders({}, options),
  });
  return parseApiResponse(response);
}

export async function createPlaidLinkToken({ workspaceUserId, plaidItemId }, options = {}) {
  const response = await fetch("/api/plaid/link-token/create", {
    method: "POST",
    headers: await buildAuthenticatedHeaders(
      {
        "Content-Type": "application/json",
      },
      options
    ),
    body: JSON.stringify({ workspaceUserId, plaidItemId }),
  });

  return parseApiResponse(response);
}

export async function exchangePlaidPublicToken(
  { workspaceUserId, publicToken, plaidItemId, linkMetadata },
  options = {}
) {
  const response = await fetch("/api/plaid/exchange-public-token", {
    method: "POST",
    headers: await buildAuthenticatedHeaders(
      {
        "Content-Type": "application/json",
      },
      options
    ),
    body: JSON.stringify({ workspaceUserId, publicToken, plaidItemId, linkMetadata }),
  });

  return parseApiResponse(response);
}

export async function syncPlaidUser(workspaceUserId, options = {}) {
  // `live: true` triggers a real Plaid pull (Refresh button / after linking).
  // The default reads already-synced encrypted data from the database, so it is
  // safe to call on every login without incurring Plaid API cost.
  const { live = false, ...requestOptions } = options;
  const params = new URLSearchParams();
  if (workspaceUserId) params.set("workspaceUserId", workspaceUserId);
  if (live) params.set("refresh", "1");
  const search = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(`/api/plaid/sync${search}`, {
    headers: await buildAuthenticatedHeaders({}, requestOptions),
  });
  return parseApiResponse(response);
}

export async function deletePlaidUser(workspaceUserId, options = {}) {
  const search = workspaceUserId ? `?workspaceUserId=${encodeURIComponent(workspaceUserId)}` : "";
  const response = await fetch(`/api/plaid/user${search}`, {
    method: "DELETE",
    headers: await buildAuthenticatedHeaders({}, options),
  });
  return parseApiResponse(response);
}

export async function deletePlaidItem({ itemId, workspaceUserId }, options = {}) {
  const searchParams = new URLSearchParams();
  if (itemId) searchParams.set("itemId", itemId);
  if (workspaceUserId) searchParams.set("workspaceUserId", workspaceUserId);

  const search = searchParams.toString() ? `?${searchParams.toString()}` : "";
  const response = await fetch(`/api/plaid/item${search}`, {
    method: "DELETE",
    headers: await buildAuthenticatedHeaders({}, options),
  });
  return parseApiResponse(response);
}
