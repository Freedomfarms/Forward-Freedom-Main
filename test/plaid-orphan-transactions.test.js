import test, { before, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { LEGAL_CONSENT_VERSION } from "../src/content/legalContent.js";

// Orphaned Plaid transactions: rows whose account was deleted (the relation's
// onDelete sets accountId NULL). They used to be returned by the sync payload
// with the fallback account name "Plaid Account", surfacing a phantom account
// in the client's Transactions view. These tests prove, against a REAL
// migrated Postgres, that:
//   • the stored sync payload excludes account-less transactions, and
//   • a live refresh sync purges them from the database.
// Self-skips unless DATABASE_URL is set and node was started with
// --experimental-test-module-mocks.
//
// Run locally with:
//   DATABASE_URL=... FFF_ENCRYPTION_KEYS=1:<base64-32> \
//     node --test --experimental-test-module-mocks test/plaid-orphan-transactions.test.js

const HAS_DB = Boolean(process.env.DATABASE_URL);
const skip = !HAS_DB;

const UID = "orphan-user";
const WORKSPACE = "ws-orphan";
const ITEM_ID = "item-orphan";
const PLAID_ACCOUNT_ID = "acct-orphan";

let setupError = null;
let handlers;
let prisma;
let envelope;

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

function mockReq({ query = {}, body = {} } = {}) {
  return { query, body, headers: {} };
}

before(async () => {
  if (!HAS_DB) return;

  process.env.FFF_ENCRYPTION_KEYS =
    process.env.FFF_ENCRYPTION_KEYS || `1:${crypto.randomBytes(32).toString("base64")}`;
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
    name: "Orphan Test User",
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
                  account_id: PLAID_ACCOUNT_ID,
                  name: "Orphan Checking",
                  official_name: "Orphan Checking",
                  type: "depository",
                  subtype: "checking",
                  balances: { current: 500, available: 500 },
                },
              ],
            },
          }),
          transactionsSync: async () => ({
            data: {
              added: [],
              modified: [],
              removed: [],
              next_cursor: "cursor-orphan-1",
              has_more: false,
            },
          }),
          liabilitiesGet: async () => ({ data: { liabilities: {} } }),
          itemRemove: async () => ({ data: {} }),
        }),
      },
    });
  } catch (error) {
    setupError = error;
    return;
  }

  envelope = await import("../server/security/envelope.js");
  const keyProvider = await import("../server/security/keyProvider.js");
  keyProvider.resetKeyProviderCache();
  handlers = await import("../server/plaid/handlers.js");
  const { getPrismaClient } = await import("../server/db/prisma.js");
  prisma = getPrismaClient();

  // Clean slate, then seed one healthy linked transaction and one orphan.
  await prisma.transaction.deleteMany({ where: { userId: UID } });
  await prisma.account.deleteMany({ where: { userId: UID } });
  await prisma.plaidItem.deleteMany({ where: { userId: UID } });
  await prisma.user.deleteMany({ where: { id: UID } });

  await prisma.user.create({
    data: {
      id: UID,
      email: `${UID}@example.com`,
      legalConsentAt: new Date(),
      legalConsentVersion: LEGAL_CONSENT_VERSION,
    },
  });
  const item = await prisma.plaidItem.create({
    data: {
      userId: UID,
      workspaceUserId: WORKSPACE,
      itemId: ITEM_ID,
      institutionName: "Orphan Bank",
      accessTokenCiphertext: envelope.encrypt(`access-${UID}`),
      status: "CONNECTED",
    },
  });
  const account = await prisma.account.create({
    data: {
      userId: UID,
      workspaceUserId: WORKSPACE,
      plaidItemRecordId: item.id,
      plaidAccountId: PLAID_ACCOUNT_ID,
      name: "Orphan Checking",
      type: "Checking",
      institution: "Orphan Bank",
      status: "Synced",
      syncSource: "Plaid",
      balance: null,
      balanceCiphertext: envelope.encryptNumber(500),
      metadata: undefined,
      metadataCiphertext: envelope.encryptJson({ plaidItemId: ITEM_ID }),
    },
  });
  await prisma.transaction.create({
    data: {
      userId: UID,
      workspaceUserId: WORKSPACE,
      plaidItemRecordId: item.id,
      accountId: account.id,
      plaidTransactionId: `tx-${UID}-linked`,
      source: "PLAID",
      syncSource: "Plaid",
      merchant: null,
      merchantCiphertext: envelope.encrypt("Linked Coffee"),
      category: null,
      categoryCiphertext: envelope.encrypt("Restaurants"),
      amount: null,
      amountCiphertext: envelope.encryptNumber(-4.5),
      postedAt: new Date("2026-02-01T12:00:00Z"),
    },
  });
  // The orphan: its account was deleted, so accountId (and item reference)
  // were set NULL by the relations' onDelete. Previously this row surfaced
  // as a phantom "Plaid Account" entry.
  await prisma.transaction.create({
    data: {
      userId: UID,
      workspaceUserId: WORKSPACE,
      plaidItemRecordId: null,
      accountId: null,
      plaidTransactionId: `tx-${UID}-ghost`,
      source: "PLAID",
      syncSource: "Plaid",
      merchant: null,
      merchantCiphertext: envelope.encrypt("Ghost Merchant"),
      category: null,
      categoryCiphertext: envelope.encrypt("Other"),
      amount: null,
      amountCiphertext: envelope.encryptNumber(-9.99),
      postedAt: new Date("2026-01-20T12:00:00Z"),
    },
  });
});

test("stored sync excludes orphaned (account-less) Plaid transactions", { skip }, async (t) => {
  if (setupError) return t.skip(`setup failed: ${setupError.message}`);

  const res = mockRes();
  await handlers.handleSyncPlaidWorkspace(mockReq({ query: { workspaceUserId: WORKSPACE } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(
    res.body.transactions.some((tx) => tx.merchant === "Linked Coffee"),
    true
  );
  assert.equal(
    res.body.transactions.some((tx) => tx.merchant === "Ghost Merchant"),
    false
  );
  assert.equal(
    res.body.transactions.some((tx) => tx.account === "Plaid Account"),
    false
  );

  // A stored read is non-destructive: the orphan row is only purged by a
  // live refresh sync, not by hydration reads.
  const orphanCount = await prisma.transaction.count({
    where: { userId: UID, accountId: null },
  });
  assert.equal(orphanCount, 1);
});

test("live refresh sync purges orphaned Plaid transactions", { skip }, async (t) => {
  if (setupError) return t.skip(`setup failed: ${setupError.message}`);

  const res = mockRes();
  await handlers.handleSyncPlaidWorkspace(
    mockReq({ query: { workspaceUserId: WORKSPACE, refresh: "1" } }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(
    res.body.transactions.some((tx) => tx.merchant === "Linked Coffee"),
    true
  );
  assert.equal(
    res.body.transactions.some((tx) => tx.account === "Plaid Account"),
    false
  );

  const orphanCount = await prisma.transaction.count({
    where: { userId: UID, accountId: null },
  });
  assert.equal(orphanCount, 0);

  // The healthy linked transaction survives the purge.
  const linkedCount = await prisma.transaction.count({
    where: { userId: UID, accountId: { not: null } },
  });
  assert.equal(linkedCount, 1);
});
