import test, { before, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { spawnSync } from "node:child_process";

// Proves a full Plaid refresh sync works against a database that has NOT
// received the privacy-encryption migration. The production failure mode:
// persistPlaidTransactions called prisma.transaction.create()/update()
// without a legacy select, and Prisma RETURNINGs every schema column by
// default, so the query failed with P2022 on Transaction.merchantCiphertext
// even though the data payload never referenced ciphertext columns.
// Self-skips without DATABASE_URL / module mocks.

const HAS_DB = Boolean(process.env.DATABASE_URL);
const skip = !HAS_DB;
const DB_NAME = process.env.COMPAT_DB_NAME || "ff_compat";

let setupError = null;
let handlers;
let prisma;
let envelope;

const UID = "sync-compat-user";
const WORKSPACE = "ws-sync-compat";
const ITEM_ID = "item-sync-compat";

// Mutable Plaid responses so each test can drive the create vs update path.
globalThis.__SYNC_COMPAT_ADDED = [];
globalThis.__SYNC_COMPAT_MODIFIED = [];

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
      return this;
    },
  };
}

function psql(...args) {
  return spawnSync("psql", ["-h", "/tmp", "-p", "5433", "-U", "postgres", "-d", DB_NAME, ...args], {
    encoding: "utf8",
  });
}

const PLAID_TRANSACTION = {
  transaction_id: "tx-sync-compat-1",
  account_id: "acct-sync-compat",
  name: "Compat Coffee Shop",
  merchant_name: "Compat Coffee Shop",
  amount: 4.5,
  date: "2026-07-01",
  authorized_date: "2026-07-01",
  pending: false,
  personal_finance_category: { primary: "FOOD_AND_DRINK" },
};

before(async () => {
  if (!HAS_DB) return;

  process.env.FFF_ENCRYPTION_KEYS =
    process.env.FFF_ENCRYPTION_KEYS || `1:${crypto.randomBytes(32).toString("base64")}`;
  process.env.FFF_ENCRYPTION_ACTIVE_VERSION = process.env.FFF_ENCRYPTION_ACTIVE_VERSION || "1";
  process.env.PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || "test-client";
  process.env.PLAID_SECRET = process.env.PLAID_SECRET || "test-secret";
  process.env.PLAID_ENV = "sandbox";

  class AuthError extends Error {
    constructor(message, status = 401) {
      super(message);
      this.name = "AuthError";
      this.status = status;
    }
  }
  const currentToken = () => ({
    uid: UID,
    email: `${UID}@example.com`,
    email_verified: true,
    name: "Sync Compat User",
    picture: null,
  });

  try {
    mock.module("../server/auth/verifyAuth.js", {
      namedExports: {
        AuthError,
        readBearerToken: () => "test-token",
        authenticateRequest: async () => currentToken(),
        authenticateVerifiedRequest: async () => currentToken(),
      },
    });

    mock.module("../server/plaidClient.js", {
      namedExports: {
        isPlaidConfigured: () => true,
        getPlaidConfig: () => ({
          configured: true,
          environment: "sandbox",
          capabilities: {},
        }),
        resolvePlaidOAuthRedirectUri: () => undefined,
        getPlaidLinkTokenRequest: (input) => input,
        getPlaidClient: () => ({
          accountsGet: async () => ({
            data: {
              accounts: [
                {
                  account_id: "acct-sync-compat",
                  name: "Compat Checking",
                  official_name: "Compat Checking",
                  type: "depository",
                  subtype: "checking",
                  balances: { current: 1234.56, available: 1234.56 },
                },
              ],
            },
          }),
          transactionsSync: async () => ({
            data: {
              added: globalThis.__SYNC_COMPAT_ADDED,
              modified: globalThis.__SYNC_COMPAT_MODIFIED,
              removed: [],
              next_cursor: "cursor-1",
              has_more: false,
            },
          }),
          liabilitiesGet: async () => ({ data: { liabilities: {} } }),
        }),
      },
    });
  } catch (error) {
    setupError = error;
    return;
  }

  // Reset the DB to init-only (no encryption columns).
  spawnSync("createdb", ["-h", "/tmp", "-p", "5433", "-U", "postgres", DB_NAME], {
    encoding: "utf8",
  });
  const reset = psql("-c", "DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  if (reset.status !== 0) {
    setupError = new Error(reset.stderr || "failed to reset compat DB");
    return;
  }
  const init = psql("-f", "prisma/migrations/20250604120000_init/migration.sql");
  if (init.status !== 0) {
    setupError = new Error(init.stderr || "failed to apply init migration");
    return;
  }

  const { resetKeyProviderCache } = await import("../server/security/keyProvider.js");
  resetKeyProviderCache();
  const { resetSchemaCapabilitiesCache } = await import("../server/db/schemaCapabilities.js");
  resetSchemaCapabilitiesCache();

  envelope = await import("../server/security/envelope.js");
  handlers = await import("../server/plaid/handlers.js");
  const { getPrismaClient } = await import("../server/db/prisma.js");
  prisma = getPrismaClient();

  await prisma.user.upsert({
    where: { id: UID },
    update: {},
    create: { id: UID, email: `${UID}@example.com` },
  });
  await prisma.plaidItem.create({
    data: {
      userId: UID,
      workspaceUserId: WORKSPACE,
      itemId: ITEM_ID,
      institutionName: "Compat Bank",
      accessTokenCiphertext: envelope.encrypt("access-sync-compat"),
      status: "CONNECTED",
    },
  });
});

test(
  "refresh sync creates accounts and transactions on an un-migrated database",
  { skip },
  async (t) => {
    if (setupError) return t.skip(`setup failed: ${setupError.message}`);

    globalThis.__SYNC_COMPAT_ADDED = [PLAID_TRANSACTION];
    globalThis.__SYNC_COMPAT_MODIFIED = [];

    const res = mockRes();
    await handlers.handleSyncPlaidWorkspace(
      { method: "GET", query: { workspaceUserId: WORKSPACE, refresh: "1" }, headers: {}, body: {} },
      res
    );

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.accounts.length, 1);
    assert.equal(res.body.accounts[0].name, "Compat Checking");
    assert.equal(res.body.accounts[0].balance, 1234.56);
    assert.equal(res.body.transactions.length, 1);
    assert.equal(res.body.transactions[0].merchant, "Compat Coffee Shop");
    assert.equal(res.body.transactions[0].amount, -4.5);

    // Data was written to the plaintext legacy columns.
    const rows = await prisma.$queryRaw`SELECT merchant, amount::text AS amount FROM "Transaction" WHERE "plaidTransactionId" = ${PLAID_TRANSACTION.transaction_id}`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].merchant, "Compat Coffee Shop");
  }
);

test(
  "re-syncing the same transaction (update path) works on an un-migrated database",
  { skip },
  async (t) => {
    if (setupError) return t.skip(`setup failed: ${setupError.message}`);

    globalThis.__SYNC_COMPAT_ADDED = [];
    globalThis.__SYNC_COMPAT_MODIFIED = [
      { ...PLAID_TRANSACTION, merchant_name: "Compat Coffee Shop v2", name: "Compat Coffee Shop v2" },
    ];

    const res = mockRes();
    await handlers.handleSyncPlaidWorkspace(
      { method: "GET", query: { workspaceUserId: WORKSPACE, refresh: "1" }, headers: {}, body: {} },
      res
    );

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.transactions.length, 1);
    assert.equal(res.body.transactions[0].merchant, "Compat Coffee Shop v2");
  }
);
