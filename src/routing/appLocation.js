// In-app navigation for the Vite SPA. Paths stay on this origin.
// A caller-supplied `next` query is stripped and never followed.

function isExternalTarget(value) {
  return value.startsWith("//") || value.startsWith("\\") || /^[a-z][a-z0-9+.-]*:/i.test(value);
}

export function sanitizeInternalPath(to) {
  const value = String(to || "").trim();
  if (!value.startsWith("/") || isExternalTarget(value)) return null;
  let url;
  try {
    url = new URL(value, "https://freedom-os.local");
  } catch {
    return null;
  }
  if (url.origin !== "https://freedom-os.local") return null;
  url.searchParams.delete("next");
  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
}

export function navigateApp(to, { replace = false, state = null } = {}) {
  if (typeof window === "undefined" || !window.history) return false;
  const target = sanitizeInternalPath(to);
  if (!target) return false;
  const method = replace ? "replaceState" : "pushState";
  window.history[method](state, "", target);
  const event =
    typeof PopStateEvent === "function" ? new PopStateEvent("popstate") : new Event("popstate");
  window.dispatchEvent(event);
  return true;
}

export function readSignupInitialForm() {
  if (typeof window === "undefined") return null;
  const form = window.history.state?.initialForm;
  if (!form || typeof form !== "object") return null;
  return {
    fullName: typeof form.fullName === "string" ? form.fullName : "",
    email: typeof form.email === "string" ? form.email : "",
  };
}
