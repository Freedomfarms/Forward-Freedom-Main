import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { navigateApp, sanitizeInternalPath } from "../src/routing/appLocation.js";
import {
  authRestoreHold,
  isReservedPath,
  presentationForRoute,
  resolveAppRoute,
} from "../src/routing/appRoutes.js";

const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const dashboardSource = readFileSync(
  new URL("../src/ForwardFreedomDashboard.jsx", import.meta.url),
  "utf8"
);
const chiefPageSource = readFileSync(
  new URL("../src/components/chief/ChiefPage.jsx", import.meta.url),
  "utf8"
);
const homeSource = readFileSync(
  new URL("../src/components/FreedomOsLanding.jsx", import.meta.url),
  "utf8"
);
const gatewaySource = readFileSync(
  new URL("../src/components/entry/MadFuturicsGateway.jsx", import.meta.url),
  "utf8"
);
const demoSource = readFileSync(
  new URL("../src/components/DemoWorkspaceApp.jsx", import.meta.url),
  "utf8"
);
const vercelSource = readFileSync(new URL("../vercel.json", import.meta.url), "utf8");

function screen(pathname, { authenticated = false, configured = true, ready = true } = {}) {
  return presentationForRoute({ configured, ready, authenticated, pathname }).screen;
}

test("signed-out / is the public homepage", () => {
  assert.equal(screen("/"), "public-home");
  assert.equal(resolveAppRoute("/").kind, "public-home");
  assert.match(homeSource, /export function PublicFreedomOsHome/);
  assert.match(homeSource, /MadFuturicsGateway/);
  assert.match(gatewaySource, /ENTER THE SYSTEM/);
  assert.match(gatewaySource, /Create account/);
  assert.match(appSource, /navigateApp\("\/login"\)/);
  assert.match(appSource, /navigateApp\("\/signup"\)/);
});

test("signed-out /login and /signup render auth modes", () => {
  assert.equal(screen("/login"), "login");
  assert.equal(screen("/signup"), "signup");
  assert.match(appSource, /initialMode=\{screen === "signup" \? "register" : "login"\}/);
});

test("signed-out /finance and /demo keep the marketing page and demo sandbox", () => {
  assert.equal(screen("/finance"), "finance-marketing");
  assert.equal(screen("/demo"), "demo");
  assert.match(appSource, /<LandingPage/);
  assert.match(appSource, /<DemoWorkspaceApp/);
  assert.match(demoSource, /persistLocally=\{false\}/);
  assert.match(demoSource, /isDemoMode/);
});

test("authenticated entry paths redirect to /os and do not follow next", () => {
  for (const path of ["/", "/login", "/signup"]) {
    const route = resolveAppRoute(path, { authenticated: true });
    assert.equal(route.kind, "redirect");
    assert.equal(route.redirectTo, "/os");
    assert.equal(route.redirectTo.includes("next"), false);
  }
  assert.equal(screen("/", { authenticated: true }), "redirect");
  assert.equal(screen("/login", { authenticated: true }), "redirect");
  assert.equal(screen("/signup", { authenticated: true }), "redirect");
});

test("authenticated surfaces follow the path", () => {
  assert.equal(screen("/os", { authenticated: true }), "os-shell");
  assert.equal(screen("/os/chief", { authenticated: true }), "os-chief");
  assert.equal(screen("/os/agents", { authenticated: true }), "os-agents");
  assert.equal(screen("/os/finance", { authenticated: true }), "os-finance");
  const finance = presentationForRoute({
    configured: true,
    ready: true,
    authenticated: true,
    pathname: "/os/finance",
  });
  assert.equal(finance.surface, "finance");
  assert.match(dashboardSource, /osSurface === "finance"/);
  assert.match(dashboardSource, /osSurface === "chief"/);
  assert.match(dashboardSource, /osSurface === "agents"/);
  assert.match(dashboardSource, /AuthenticatedFreedomOsShell/);
});

test("signed-out protected paths redirect to /login", () => {
  for (const path of ["/os", "/os/chief", "/os/agents", "/os/finance"]) {
    const route = resolveAppRoute(path, { authenticated: false });
    assert.equal(route.redirectTo, "/login", path);
    assert.equal(screen(path), "redirect");
    assert.equal(
      presentationForRoute({
        configured: true,
        ready: true,
        authenticated: false,
        pathname: path,
      }).surface,
      null
    );
  }
});

test("protected UI does not mount while Firebase is restoring", () => {
  assert.equal(authRestoreHold({ configured: true, ready: false }), true);
  assert.equal(screen("/os/chief", { authenticated: false, ready: false }), "restoring");
  assert.equal(screen("/os/finance", { authenticated: true, ready: false }), "restoring");
  assert.equal(screen("/", { ready: false }), "restoring");
  assert.equal(authRestoreHold({ configured: false, ready: false }), false);
});

test("unknown paths fall back without leaving the app", () => {
  assert.equal(resolveAppRoute("/nope").redirectTo, "/");
  assert.equal(resolveAppRoute("/nope", { authenticated: true }).redirectTo, "/os");
  assert.equal(resolveAppRoute("/os/unknown", { authenticated: true }).redirectTo, "/os");
  assert.equal(resolveAppRoute("/os/unknown").redirectTo, "/login");
});

test("next is stripped and external targets are refused", () => {
  assert.equal(sanitizeInternalPath("/login?next=https://evil.example"), "/login");
  assert.equal(sanitizeInternalPath("/os/chief?next=/os/finance"), "/os/chief");
  assert.equal(sanitizeInternalPath("https://evil.example/os"), null);
  assert.equal(sanitizeInternalPath("//evil.example"), null);
  assert.equal(resolveAppRoute("/login?next=https://evil.example").kind, "login");
  assert.equal(
    resolveAppRoute("/login?next=https://evil.example", { authenticated: true }).redirectTo,
    "/os"
  );

  const calls = [];
  const original = globalThis.window;
  globalThis.window = {
    location: { pathname: "/login", search: "?next=https://evil.example", hash: "" },
    history: {
      replaceState(_state, _title, url) {
        calls.push(url);
      },
      pushState() {},
    },
    dispatchEvent() {
      return true;
    },
  };
  try {
    assert.equal(navigateApp("/login?next=https://evil.example", { replace: true }), true);
    assert.deepEqual(calls, ["/login"]);
    assert.equal(navigateApp("https://evil.example"), false);
  } finally {
    globalThis.window = original;
  }
});

test("reserved API and Plaid paths are not application screens", () => {
  assert.equal(isReservedPath("/api/workspace"), true);
  assert.equal(isReservedPath("/plaid-oauth.html"), true);
  assert.equal(screen("/api/chief/history"), "reserved");
  assert.equal(screen("/plaid-oauth.html"), "reserved");
  assert.match(vercelSource, /sitemap/);
  assert.match(vercelSource, /index\.html/);
  assert.doesNotMatch(appSource, /react-router/);
  assert.doesNotMatch(dashboardSource, /react-router/);
});

test("authentication no longer forces the CHIEF tab", () => {
  assert.doesNotMatch(dashboardSource, /activeTab: APP_TABS\.CHIEF/);
  assert.match(appSource, /fallbackToDefaultStorageKey: false/);
});

test("CHIEF still opens a conversation through the uid-scoped browser key", () => {
  assert.match(chiefPageSource, /readChiefActiveSessionId\(sessionUid\)/);
  assert.match(chiefPageSource, /writeChiefActiveSessionId\(sessionUid, sessionId\)/);
  assert.match(chiefPageSource, /loadHistory\(sessionId, token\)/);
  assert.doesNotMatch(
    chiefPageSource,
    /sessionStorage\.setItem\(\s*["']chief\.activeSessionId["']/
  );
});
