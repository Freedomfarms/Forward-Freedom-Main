import test from "node:test";
import assert from "node:assert/strict";

import {
  LEGACY_CHIEF_ACTIVE_SESSION_KEY,
  chiefActiveSessionKey,
  clearChiefActiveSessionId,
  readChiefActiveSessionId,
  writeChiefActiveSessionId,
} from "../src/utils/chiefActiveSession.js";

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    store,
  };
}

test("the active session key is namespaced by Firebase uid", () => {
  assert.equal(chiefActiveSessionKey("user-a"), "chief.activeSessionId:user-a");
  assert.equal(chiefActiveSessionKey("user-b"), "chief.activeSessionId:user-b");
  assert.equal(chiefActiveSessionKey("  "), null);
  assert.notEqual(chiefActiveSessionKey("user-a"), LEGACY_CHIEF_ACTIVE_SESSION_KEY);
});

test("user B does not read user A's active session id", () => {
  const storage = memoryStorage();
  writeChiefActiveSessionId("user-a", "session-a", storage);
  writeChiefActiveSessionId("user-b", "session-b", storage);

  assert.equal(readChiefActiveSessionId("user-a", storage), "session-a");
  assert.equal(readChiefActiveSessionId("user-b", storage), "session-b");

  clearChiefActiveSessionId("user-a", storage);
  assert.equal(readChiefActiveSessionId("user-a", storage), null);
  assert.equal(readChiefActiveSessionId("user-b", storage), "session-b");
});

test("the legacy unscoped key is ignored and removed on clear", () => {
  const storage = memoryStorage();
  storage.setItem(LEGACY_CHIEF_ACTIVE_SESSION_KEY, "session-a");
  assert.equal(readChiefActiveSessionId("user-b", storage), null);
  clearChiefActiveSessionId("user-b", storage);
  assert.equal(storage.getItem(LEGACY_CHIEF_ACTIVE_SESSION_KEY), null);
});
