import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

async function loadDashboardModule() {
  const server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { hmr: false, middlewareMode: true },
  });

  try {
    return await server.ssrLoadModule("/src/ForwardFreedomDashboard.jsx");
  } finally {
    await server.close();
  }
}

test("successful silent Plaid sync clears stale transport errors", async () => {
  const { isStalePlaidSyncError } = await loadDashboardModule();

  assert.equal(
    isStalePlaidSyncError("Request blocked before reaching the server (HTTP 403)."),
    true
  );
  assert.equal(isStalePlaidSyncError("Request failed."), true);
  assert.equal(isStalePlaidSyncError("Unable to sync Plaid data right now."), true);
  assert.equal(isStalePlaidSyncError("Email verification is required before linking bank accounts."), false);
});
