import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

async function loadPlaidModule() {
  const server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { hmr: false, middlewareMode: true },
  });

  try {
    return await server.ssrLoadModule("/src/utils/plaid.js");
  } finally {
    await server.close();
  }
}

test("plaid status only loads for authenticated app sessions", async () => {
  const { shouldFetchPlaidStatus } = await loadPlaidModule();

  assert.equal(
    shouldFetchPlaidStatus({
      currentView: "landing",
      isDemoMode: false,
      sessionUser: { uid: "user-1" },
    }),
    false
  );

  assert.equal(
    shouldFetchPlaidStatus({
      currentView: "app",
      isDemoMode: true,
      sessionUser: { uid: "demo-user" },
    }),
    false
  );

  assert.equal(
    shouldFetchPlaidStatus({
      currentView: "app",
      isDemoMode: false,
      sessionUser: null,
    }),
    false
  );

  assert.equal(
    shouldFetchPlaidStatus({
      currentView: "app",
      isDemoMode: false,
      sessionUser: { uid: "auth-user" },
    }),
    true
  );
});
