const PENDING_LINK_KEY = "plaid_pending_link";
const RECEIVED_URI_KEY = "plaid_oauth_received_uri";

export function savePendingPlaidLinkState(state) {
  try {
    sessionStorage.setItem(PENDING_LINK_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures; OAuth resume is best-effort.
  }
}

export function loadPendingPlaidLinkState() {
  try {
    const raw = sessionStorage.getItem(PENDING_LINK_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearPendingPlaidLinkState() {
  try {
    sessionStorage.removeItem(PENDING_LINK_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function consumeOAuthReceivedRedirectUri() {
  try {
    const uri = sessionStorage.getItem(RECEIVED_URI_KEY);
    if (uri) {
      sessionStorage.removeItem(RECEIVED_URI_KEY);
    }
    return uri || null;
  } catch {
    return null;
  }
}

export function hasOAuthStateInUrl() {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("oauth_state_id");
}

export function clearOAuthStateFromUrl() {
  if (typeof window === "undefined" || !hasOAuthStateInUrl()) return;

  const url = new URL(window.location.href);
  url.searchParams.delete("oauth_state_id");
  const nextSearch = url.searchParams.toString();
  const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ""}${url.hash}`;
  window.history.replaceState({}, document.title, nextUrl);
}
