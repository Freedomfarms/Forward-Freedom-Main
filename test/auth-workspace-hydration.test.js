import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

async function loadAppStateModule() {
  const server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { hmr: false, middlewareMode: true },
  });

  try {
    return await server.ssrLoadModule("/src/utils/appState.js");
  } finally {
    await server.close();
  }
}

function installLocalStorage() {
  const store = new Map();
  global.window = {
    localStorage: {
      getItem: (key) => store.get(key) || null,
      setItem: (key, value) => {
        store.set(key, String(value));
      },
      removeItem: (key) => {
        store.delete(key);
      },
    },
  };

  return store;
}

test("scoped authenticated workspace does not hydrate unscoped demo cache", async () => {
  const {
    APP_STATE_STORAGE_KEY,
    buildScopedAppStateStorageKey,
    loadPersistedAppStateRecord,
    persistAppState,
  } = await loadAppStateModule();
  installLocalStorage();
  persistAppState(
    {
      users: [
        {
          id: "demo-user",
          name: "Demo User",
          accounts: [{ id: "demo-account", name: "Demo Checking", type: "Checking" }],
          transactions: [{ id: "demo-tx", amount: -42 }],
          incomeStreams: [{ name: "Demo Income", amount: "$8,000" }],
          metricSnapshots: { "2026-01-31": { trueCash: 50000 } },
        },
      ],
      activeUserId: "demo-user",
    },
    APP_STATE_STORAGE_KEY
  );

  const scopedRecord = loadPersistedAppStateRecord(buildScopedAppStateStorageKey("auth-user"), {
    fallbackToDefaultStorageKey: false,
    includeLegacyMetricSnapshots: false,
    useSeedData: false,
  });
  const [user] = scopedRecord.state.users;

  assert.equal(scopedRecord.hasPersistedState, false);
  assert.equal(user.accounts.length, 0);
  assert.equal(user.transactions.length, 0);
  assert.equal(user.incomeStreams.length, 0);
  assert.deepEqual(user.metricSnapshots, {});
});

test("authenticated normalization does not fill missing fields with demo data", async () => {
  const { buildScopedAppStateStorageKey, loadPersistedAppStateRecord, persistAppState } =
    await loadAppStateModule();
  installLocalStorage();
  const scopedKey = buildScopedAppStateStorageKey("auth-user");
  persistAppState(
    {
      users: [
        {
          id: "auth-user-profile",
          name: "Real User",
        },
      ],
      activeUserId: "auth-user-profile",
    },
    scopedKey
  );

  const scopedRecord = loadPersistedAppStateRecord(scopedKey, {
    fallbackToDefaultStorageKey: false,
    includeLegacyMetricSnapshots: false,
    useSeedData: false,
  });
  const [user] = scopedRecord.state.users;

  assert.equal(scopedRecord.hasPersistedState, true);
  assert.equal(user.accounts.length, 0);
  assert.equal(user.transactions.length, 0);
  assert.equal(user.incomeStreams.length, 0);
  assert.deepEqual(user.metricSnapshots, {});
});

test("authenticated legacy snapshots do not inherit legacy metric chart data", async () => {
  const {
    LEGACY_METRIC_SNAPSHOT_STORAGE_KEY,
    buildScopedAppStateStorageKey,
    loadPersistedAppStateRecord,
  } = await loadAppStateModule();
  installLocalStorage();
  const scopedKey = buildScopedAppStateStorageKey("auth-user");
  window.localStorage.setItem(
    LEGACY_METRIC_SNAPSHOT_STORAGE_KEY,
    JSON.stringify({ "2026-01-31": { trueCash: 50000 } })
  );
  window.localStorage.setItem(
    scopedKey,
    JSON.stringify({
      id: "legacy-user",
      name: "Legacy User",
    })
  );

  const scopedRecord = loadPersistedAppStateRecord(scopedKey, {
    fallbackToDefaultStorageKey: false,
    includeLegacyMetricSnapshots: false,
    useSeedData: false,
  });
  const [user] = scopedRecord.state.users;

  assert.equal(scopedRecord.hasPersistedState, true);
  assert.deepEqual(user.metricSnapshots, {});
});
