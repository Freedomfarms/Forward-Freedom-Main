import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

async function loadApiModule({ currentToken = null } = {}) {
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
export async function waitForUserIdToken(user){
  if (!user || typeof user.getIdToken !== "function") return ${JSON.stringify(currentToken)};
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = await user.getIdToken(attempt === 3);
    if (token) return token;
  }
  return null;
}`;
          }
          return null;
        },
      },
    ],
  });

  try {
    const api = await server.ssrLoadModule("/src/utils/api.js");
    return { api, close: () => server.close() };
  } catch (error) {
    await server.close();
    throw error;
  }
}

function createJsonResponse({ ok = true, status = 200, payload = {} } = {}) {
  return {
    ok,
    status,
    headers: {
      get: () => null,
    },
    json: async () => payload,
  };
}

test("workspace requests use the provided Firebase user token during startup", async () => {
  const { api, close } = await loadApiModule({ currentToken: null });
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return createJsonResponse({ payload: { snapshot: null } });
  };

  try {
    await api.fetchWorkspaceSnapshot({
      user: {
        getIdToken: async () => "user-token",
      },
    });
  } finally {
    global.fetch = originalFetch;
    await close();
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/workspace");
  assert.equal(calls[0].init.headers.Authorization, "Bearer user-token");
});

test("protected workspace requests are not sent when no auth token is available", async () => {
  const { api, close } = await loadApiModule({ currentToken: null });
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called");
  };

  try {
    await assert.rejects(
      () => api.fetchWorkspaceSnapshot(),
      (error) =>
        error.name === "ApiRequestError" &&
        error.status === 401 &&
        error.message.includes("sign-in session is still restoring")
    );
  } finally {
    global.fetch = originalFetch;
    await close();
  }

  assert.equal(fetchCalled, false);
});

test("generic 401 workspace responses become actionable session errors", async () => {
  const { api, close } = await loadApiModule({ currentToken: "fallback-token" });
  const originalFetch = global.fetch;
  global.fetch = async () =>
    createJsonResponse({
      ok: false,
      status: 401,
      payload: { message: "Unable to verify the provided auth token." },
    });

  try {
    await assert.rejects(
      () => api.fetchWorkspaceSnapshot(),
      (error) =>
        error.name === "ApiRequestError" &&
        error.status === 401 &&
        error.message.includes("Unable to verify the provided auth token.")
    );
  } finally {
    global.fetch = originalFetch;
    await close();
  }
});

test("workspace requests retry until a Firebase user token becomes available", async () => {
  const { api, close } = await loadApiModule({ currentToken: null });
  const calls = [];
  let tokenAttempts = 0;
  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return createJsonResponse({ payload: { snapshot: null } });
  };

  try {
    await api.fetchWorkspaceSnapshot({
      user: {
        getIdToken: async () => {
          tokenAttempts += 1;
          return tokenAttempts >= 2 ? "delayed-user-token" : null;
        },
      },
    });
  } finally {
    global.fetch = originalFetch;
    await close();
  }

  assert.equal(tokenAttempts, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Authorization, "Bearer delayed-user-token");
});
