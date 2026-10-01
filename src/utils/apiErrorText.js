// Shared HTTP error text for parseApiResponse. CHIEF routes put the sentence
// in `error`; most other routes use `message`. A boolean `error` is a flag
// (legal consent, method-not-allowed), not text. HTTP 403 with neither string
// means the body did not come from the app.

export function readApiErrorText(payload) {
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  if (message) return message;
  const error = typeof payload?.error === "string" ? payload.error.trim() : "";
  return error;
}

export function describeBodylessHttpError(status) {
  // App handlers return JSON. A body-less / HTML 403 means the request never
  // reached our function (Vercel Firewall / Attack Challenge / a route the
  // deployment did not register). Same pattern documented for Plaid in plaid.js.
  if (status === 403) {
    return (
      "Request blocked before reaching the server (HTTP 403). This is usually a " +
      "hosting firewall block (Vercel Firewall / Attack Challenge Mode), not an " +
      "app permission error. Check Vercel → Project → Firewall, then retry."
    );
  }
  if (status >= 500) {
    return `Server error (${status}). Try again in a moment.`;
  }
  if (status) {
    return `Request failed (${status}).`;
  }
  return "Request failed.";
}

export function apiFailureMessage(status, payload) {
  return readApiErrorText(payload) || describeBodylessHttpError(status);
}
