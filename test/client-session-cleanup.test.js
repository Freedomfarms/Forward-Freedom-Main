import test from "node:test";
import assert from "node:assert/strict";

import {
  PLAID_PENDING_LINK_STORAGE_KEY,
  clearSignedOutClientState,
} from "../src/utils/clientSessionCleanup.js";
import {
  readChiefActiveSessionId,
  writeChiefActiveSessionId,
} from "../src/utils/chiefActiveSession.js";

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
}

test("sign-out clears this user's CHIEF key, Plaid pending link, and legal marker", () => {
  const sessionStore = memoryStorage();
  const localStore = memoryStorage();
  writeChiefActiveSessionId("user-a", "session-a", sessionStore);
  writeChiefActiveSessionId("user-b", "session-b", sessionStore);
  sessionStore.setItem(PLAID_PENDING_LINK_STORAGE_KEY, '{"itemId":"pending"}');
  sessionStore.setItem("plaid_oauth_received_uri", "https://example.test/return");
  localStore.setItem("fff::pendingLegalConsent", '{"version":"2026"}');
  localStore.setItem("fff-app-state-v1:user-a", '{"users":[]}');
  localStore.setItem("fff-app-state-v1:user-b", '{"users":[]}');

  clearSignedOutClientState("user-a", { sessionStore, localStore });

  assert.equal(readChiefActiveSessionId("user-a", sessionStore), null);
  assert.equal(readChiefActiveSessionId("user-b", sessionStore), "session-b");
  assert.equal(sessionStore.getItem(PLAID_PENDING_LINK_STORAGE_KEY), null);
  assert.equal(sessionStore.getItem("plaid_oauth_received_uri"), "https://example.test/return");
  assert.equal(localStore.getItem("fff::pendingLegalConsent"), null);
  assert.equal(localStore.getItem("fff-app-state-v1:user-a"), '{"users":[]}');
  assert.equal(localStore.getItem("fff-app-state-v1:user-b"), '{"users":[]}');
});
