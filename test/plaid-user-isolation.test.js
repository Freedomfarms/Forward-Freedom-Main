import test, { before, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// Cross-user isolation integration test. It exercises the REAL Plaid handlers
// against a REAL Postgres database, proving that one user can never read or
// mutate another user's financial data, and that financial data is encrypted at
// rest. It self-skips unless:
//   • DATABASE_URL points at a reachable Postgres, and
//   • node was started with --experimental-test-module-mocks (needed to stub
//     Firebase auth so we can act as a specific user).
//
// Run locally with:
//   DATABASE_URL=... FFF_ENCRYPTION_KEYS=1:<base64-32> \
//     node --test --experimental-test-module-mocks test/plaid-user-isolation.test.js

const HAS_DB = Boolean(process.env.DATABASE_URL);

let setupError = null;
let handlers;
let prisma;
let envelope;

// The uid the mocked auth layer will report for the "current" request.
globalThis.__ISOLATION_UID = "user-a";

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
  // Dummy Plaid creds so isPlaidConfigured() is true; the ownership checks we
  // test run BEFORE any Plaid network call is made.
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
    uid: globalThis.__ISOLATION_UID,
    email: `${globalThis.__ISOLATION_UID}@example.com`,
    email_verified: true,
    name: "Test User",
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

  // Clean slate for a deterministic test.
  await prisma.transaction.deleteMany({ where: { userId: { in: ["user-a", "user-b"] } } });
  await prisma.account.deleteMany({ where: { userId: { in: ["user-a", "user-b"] } } });
  await prisma.plaidItem.deleteMany({ where: { userId: { in: ["user-a", "user-b"] } } });
  await prisma.user.deleteMany({ where: { id: { in: ["user-a", "user-b"] } } });

  async function seedUser(uid, { itemId, accountName, balance, merchant, amount }) {
    await prisma.user.create({ data: { id: uid, email: `${uid}@example.com` } });
    const item = await prisma.plaidItem.create({
      data: {
        userId: uid,
        itemId,
        institutionName: "Test Bank",
        accessTokenCiphertext: envelope.encrypt(`access-${uid}`),
        status: "CONNECTED",
      },
    });
    await prisma.account.create({
      data: {
        userId: uid,
        plaidItemRecordId: item.id,
        plaidAccountId: `acct-${uid}`,
        name: accountName,
        type: "Checking",
        institution: "Test Bank",
        status: "Synced",
        syncSource: "Plaid",
        balance: null,
        balanceCiphertext: envelope.encryptNumber(balance),
        metadata: undefined,
        metadataCiphertext: envelope.encryptJson({ plaidItemId: itemId }),
      },
    });
    await prisma.transaction.create({
      data: {
        userId: uid,
        plaidItemRecordId: item.id,
        plaidTransactionId: `tx-${uid}`,
        source: "PLAID",
        syncSource: "Plaid",
        merchant: null,
        merchantCiphertext: envelope.encrypt(merchant),
        category: null,
        categoryCiphertext: envelope.encrypt("Restaurants"),
        amount: null,
        amountCiphertext: envelope.encryptNumber(amount),
        postedAt: new Date("2026-01-15T12:00:00Z"),
      },
    });
  }

  await seedUser("user-a", {
    itemId: "item-a",
    accountName: "A Checking",
    balance: 1000,
    merchant: "A Coffee Shop",
    amount: -5.25,
  });
  await seedUser("user-b", {
    itemId: "item-b",
    accountName: "B Savings",
    balance: 2000,
    merchant: "B Landlord",
    amount: -2000,
  });
});

const skip = !HAS_DB;

test("stored sync returns only the requesting user's data (decrypted)", { skip }, async (t) => {
  if (setupError) return t.skip("module mocking unavailable");

  globalThis.__ISOLATION_UID = "user-a";
  const res = mockRes();
  await handlers.handleSyncPlaidWorkspace(mockReq({ query: {} }), res);

  assert.equal(res.statusCode, 200);
  const serialized = JSON.stringify(res.body);
  // A's data present and decrypted correctly.
  assert.equal(res.body.accounts.some((a) => a.name === "A Checking" && a.balance === 1000), true);
  assert.equal(res.body.transactions.some((tx) => tx.merchant === "A Coffee Shop"), true);
  // None of B's data leaks across the user boundary.
  assert.equal(serialized.includes("B Savings"), false);
  assert.equal(serialized.includes("B Landlord"), false);
  assert.equal(serialized.includes("2000"), false);
});

test("a user cannot delete another user's Plaid item", { skip }, async (t) => {
  if (setupError) return t.skip("module mocking unavailable");

  globalThis.__ISOLATION_UID = "user-a";
  const res = mockRes();
  await handlers.handleDeletePlaidItem(mockReq({ query: { itemId: "item-b" } }), res);

  assert.equal(res.statusCode, 404);
  // B's item must still exist untouched.
  const stillThere = await prisma.plaidItem.findUnique({ where: { itemId: "item-b" } });
  assert.ok(stillThere);
  assert.equal(stillThere.userId, "user-b");
});

test("a user cannot open a link-token update for another user's item", { skip }, async (t) => {
  if (setupError) return t.skip("module mocking unavailable");

  globalThis.__ISOLATION_UID = "user-a";
  const res = mockRes();
  await handlers.handleCreatePlaidLinkToken(
    mockReq({ body: { plaidItemId: "item-b" } }),
    res
  );

  assert.equal(res.statusCode, 404);
});

test("financial columns are encrypted at rest (no plaintext in the database)", { skip }, async (t) => {
  if (setupError) return t.skip("module mocking unavailable");

  const account = await prisma.account.findUnique({ where: { plaidAccountId: "acct-user-a" } });
  assert.equal(account.balance, null);
  assert.ok(account.balanceCiphertext);
  assert.equal(account.balanceCiphertext.includes("1000"), false);

  const tx = await prisma.transaction.findUnique({ where: { plaidTransactionId: "tx-user-a" } });
  assert.equal(tx.merchant, null);
  assert.equal(tx.amount, null);
  assert.ok(tx.merchantCiphertext && tx.amountCiphertext);
  assert.equal(tx.merchantCiphertext.includes("A Coffee Shop"), false);
});
