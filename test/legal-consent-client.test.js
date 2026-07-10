import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

// Client-side legal-consent staging (H-9): acceptance selected in the auth UI
// (before a Firebase session exists) is staged in localStorage, then flushed to
// POST /api/me once authenticated. A failed flush keeps the record pending so
// the next session retries; a successful flush clears it.

async function loadConsentModule({ currentToken = "test-token" } = {}) {
  const server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { hmr: false, middlewareMode: true },
    plugins: [
      {
        name: "mock-firebase-token",
        enforce: "pre",
        resolveId(source, importer) {
          if (source === "./firebase.js" && importer?.includes("/src/utils/api.js")) {
            return "\0mock-firebase-token";
          }
          return null;
        },
        load(id) {
          if (id === "\0mock-firebase-token") {
            return `export async function getCurrentUserIdToken(){ return ${JSON.stringify(currentToken)}; }
export async function waitForUserIdToken(){ return ${JSON.stringify(currentToken)}; }`;
          }
          return null;
        },
      },
    ],
  });

  try {
    const mod = await server.ssrLoadModule("/src/utils/legalConsent.js");
    const content = await server.ssrLoadModule("/src/content/legalContent.js");
    return { mod, version: content.LEGAL_CONSENT_VERSION, close: () => server.close() };
  } catch (error) {
    await server.close();
    throw error;
  }
}

function installFakeWindow() {
  const store = new Map();
  const original = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
  };
  return {
    store,
    restore: () => {
      globalThis.window = original;
    },
  };
}

test("staged consent is flushed to /api/me and then cleared", async () => {
  const { mod, version, close } = await loadConsentModule();
  const fakeWindow = installFakeWindow();
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: {} }) };
  };

  try {
    mod.markPendingLegalConsent("email-signup");
    const flushed = await mod.flushPendingLegalConsent();

    assert.equal(flushed, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/me");
    assert.equal(calls[0].body.legalConsent.version, version);
    assert.equal(calls[0].body.legalConsent.method, "email-signup");

    // A second flush is a no-op because the pending record was cleared.
    const second = await mod.flushPendingLegalConsent();
    assert.equal(second, false);
    assert.equal(calls.length, 1);
  } finally {
    global.fetch = originalFetch;
    fakeWindow.restore();
    await close();
  }
});

test("a failed flush keeps consent pending so the next session retries", async () => {
  const { mod, version, close } = await loadConsentModule();
  const fakeWindow = installFakeWindow();
  let attempts = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return {
        ok: false,
        status: 503,
        headers: { get: () => null },
        json: async () => ({ error: true, message: "unavailable" }),
      };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: {} }) };
  };

  try {
    mod.markPendingLegalConsent("google");

    const first = await mod.flushPendingLegalConsent();
    assert.equal(first, false, "failed flush returns false");

    // Retry succeeds and records the still-pending consent.
    const retry = await mod.flushPendingLegalConsent();
    assert.equal(retry, true, "pending consent is retried on the next attempt");
    assert.equal(attempts, 2);

    // Now cleared.
    const third = await mod.flushPendingLegalConsent();
    assert.equal(third, false);
    assert.equal(version.length > 0, true);
  } finally {
    global.fetch = originalFetch;
    fakeWindow.restore();
    await close();
  }
});
