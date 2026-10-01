// Path table for the Freedom OS SPA. Vercel rewrites these paths to index.html.
// /api/* and /plaid-oauth.html are not application screens.

const AUTH_ENTRY_PATHS = new Set(["/", "/login", "/signup"]);

export function normalizeAppPath(pathname) {
  const raw = typeof pathname === "string" ? pathname : "/";
  const withoutHash = raw.split("#")[0] || "/";
  const withoutQuery = withoutHash.split("?")[0] || "/";
  if (!withoutQuery.startsWith("/")) return "/";
  if (withoutQuery.length > 1 && withoutQuery.endsWith("/")) {
    return withoutQuery.slice(0, -1);
  }
  return withoutQuery || "/";
}

export function isReservedPath(pathname) {
  const path = normalizeAppPath(pathname);
  return path === "/api" || path.startsWith("/api/") || path === "/plaid-oauth.html";
}

function destination(kind, path, redirectTo = null) {
  return { kind, path, redirectTo };
}

/**
 * Decide which screen a path represents.
 * `search` is accepted so callers can pass the real location, and is ignored:
 * a `next` query must never choose the destination.
 */
export function resolveAppRoute(pathname, { authenticated = false } = {}) {
  const path = normalizeAppPath(pathname);
  if (isReservedPath(path)) {
    return destination("reserved", path);
  }

  if (!authenticated) {
    if (path === "/") return destination("public-home", path);
    if (path === "/login") return destination("login", path);
    if (path === "/signup") return destination("signup", path);
    if (path === "/finance") return destination("finance-marketing", path);
    if (path === "/demo") return destination("demo", path);
    if (path === "/os" || path.startsWith("/os/")) return destination("redirect", path, "/login");
    return destination("redirect", path, "/");
  }

  if (AUTH_ENTRY_PATHS.has(path)) return destination("redirect", path, "/os");
  if (path === "/finance") return destination("finance-marketing", path);
  if (path === "/demo") return destination("demo", path);
  if (path === "/os") return destination("os-shell", path);
  if (path === "/os/chief") return destination("os-chief", path);
  if (path === "/os/agents") return destination("os-agents", path);
  if (path === "/os/finance") return destination("os-finance", path);
  if (path.startsWith("/os/")) return destination("redirect", path, "/os");
  return destination("redirect", path, "/os");
}

export function authRestoreHold({ configured = false, ready = false } = {}) {
  return Boolean(configured) && ready !== true;
}

export function osSurfaceForKind(kind) {
  if (kind === "os-shell") return "shell";
  if (kind === "os-chief") return "chief";
  if (kind === "os-agents") return "agents";
  if (kind === "os-finance") return "finance";
  return null;
}

/**
 * What the app should mount. Protected surfaces stay behind the restore hold
 * so a direct /os/* load cannot paint the workspace before Firebase resolves.
 */
export function presentationForRoute({
  configured = false,
  ready = false,
  authenticated = false,
  pathname = "/",
} = {}) {
  if (isReservedPath(pathname)) return { screen: "reserved", redirectTo: null, surface: null };
  if (authRestoreHold({ configured, ready })) {
    return { screen: "restoring", redirectTo: null, surface: null };
  }
  const route = resolveAppRoute(pathname, { authenticated });
  if (route.kind === "redirect") {
    return { screen: "redirect", redirectTo: route.redirectTo, surface: null };
  }
  return {
    screen: route.kind,
    redirectTo: null,
    surface: osSurfaceForKind(route.kind),
  };
}
