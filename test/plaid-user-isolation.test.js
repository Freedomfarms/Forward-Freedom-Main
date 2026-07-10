import test, { before, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { LEGAL_CONSENT_VERSION } from "../src/content/legalContent.js";

// Cross-user isolation integration test. It exercises the REAL Plaid handlers
// against a REAL Postgres database, proving that one user can never read or
// mutate another user's financial data, that a client-supplied workspaceUserId
// can never cross the authenticated-user boundary, and that financial data is
// encrypted at rest. It self-skips unless:
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
// The item_id the mocked Plaid client returns from a public-token exchange.
globalThis.__ISOLATION_EXCHANGE_ITEM_ID = "item-a";

// Each authenticated Firebase user owns one or more client-side "workspace"
// profiles (household members). workspaceUserId is a sub-scope WITHIN a single
// authenticated user; it is never another Firebase user's id. These constants
// let the tests spoof another user's workspaceUserId to prove it is powerless.
const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";

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

    // Stub the Plaid network client so we can drive handleExchangePlaidPublicToken
    // without real Plaid calls. The exchange returns a caller-controlled item_id,
    // letting us prove the server refuses to re-home another user's item.
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
          itemPublicTokenExchange: async () => ({
            data: {
              access_token: "access-exchanged",
              item_id: globalThis.__ISOLATION_EXCHANGE_ITEM_ID,
            },
          }),
          itemGet: async () => ({
            data: {
              item: {
                institution_id: "ins_test",
                available_products: [],
                billed_products: [],
              },
            },
          }),
          institutionsGetById: async () => ({
            data: { institution: { name: "Test Bank" } },
          }),
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

  await resetFixtures();
});

async function resetFixtures() {
  // Clean slate for a deterministic test.
  await prisma.transaction.deleteMany({ where: { userId: { in: ["user-a", "user-b"] } } });
  await prisma.account.deleteMany({ where: { userId: { in: ["user-a", "user-b"] } } });
  await prisma.plaidItem.deleteMany({ where: { userId: { in: ["user-a", "user-b"] } } });
  await prisma.user.deleteMany({ where: { id: { in: ["user-a", "user-b"] } } });

  await seedUser("user-a", {
    itemId: "item-a",
    workspaceUserId: WORKSPACE_A,
    accountName: "A Checking",
    balance: 1000,
    merchant: "A Coffee Shop",
    amount: -5.25,
  });
  await seedUser("user-b", {
    itemId: "item-b",
    workspaceUserId: WORKSPACE_B,
    accountName: "B Savings",
    balance: 2000,
    merchant: "B Landlord",
    amount: -2000,
  });
}

async function seedUser(uid, { itemId, workspaceUserId, accountName, balance, merchant, amount }) {
  // Seed current legal consent so server-side consent enforcement (H-9) passes
  // and these tests stay focused on cross-user isolation, not the consent gate.
  await prisma.user.create({
    data: {
      id: uid,
      email: `${uid}@example.com`,
      legalConsentAt: new Date(),
      legalConsentVersion: LEGAL_CONSENT_VERSION,
    },
  });
  const item = await prisma.plaidItem.create({
    data: {
      userId: uid,
      workspaceUserId,
      itemId,
      institutionName: "Test Bank",
      accessTokenCiphertext: envelope.encrypt(`access-${uid}`),
      status: "CONNECTED",
    },
  });
  await prisma.account.create({
    data: {
      userId: uid,
      workspaceUserId,
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
      workspaceUserId,
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
  return item;
}

const skip = !HAS_DB;

test("stored sync returns only the requesting user's data (decrypted)", { skip }, async (t) => {
  if (setupError) return t.skip("module mocking unavailable");

  globalThis.__ISOLATION_UID = "user-a";
  const res = mockRes();
  await handlers.handleSyncPlaidWorkspace(mockReq({ query: { workspaceUserId: WORKSPACE_A } }), res);

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

test(
  "sync with another user's workspaceUserId cannot read that user's data",
  { skip },
  async (t) => {
    if (setupError) return t.skip("module mocking unavailable");

    // User A authenticates but spoofs User B's workspaceUserId in the query.
    // Because every query is scoped by the verified Firebase uid, the compound
    // (userId, workspaceUserId) filter can only ever match User A's own rows —
    // and A owns nothing under WORKSPACE_B, so the result is empty.
    globalThis.__ISOLATION_UID = "user-a";
    const res = mockRes();
    await handlers.handleSyncPlaidWorkspace(
      mockReq({ query: { workspaceUserId: WORKSPACE_B } }),
      res
    );

    assert.equal(res.statusCode, 200);
    const serialized = JSON.stringify(res.body);
    assert.deepEqual(res.body.accounts, []);
    assert.deepEqual(res.body.transactions, []);
    assert.deepEqual(res.body.plaidItems, []);
    assert.equal(serialized.includes("B Savings"), false);
    assert.equal(serialized.includes("B Landlord"), false);
  }
);

test("sync with an unknown/invalid workspaceUserId returns no data", { skip }, async (t) => {
  if (setupError) return t.skip("module mocking unavailable");

  globalThis.__ISOLATION_UID = "user-a";
  const res = mockRes();
  await handlers.handleSyncPlaidWorkspace(
    mockReq({ query: { workspaceUserId: "does-not-exist-🤖" } }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.accounts, []);
  assert.deepEqual(res.body.transactions, []);
  assert.deepEqual(res.body.plaidItems, []);
});

test("a user cannot delete another user's Plaid item (spoofing itemId)", { skip }, async (t) => {
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

test(
  "a user cannot delete another user's Plaid item (spoofing itemId + workspaceUserId)",
  { skip },
  async (t) => {
    if (setupError) return t.skip("module mocking unavailable");

    // Spoof BOTH the itemId and the workspaceUserId of User B.
    globalThis.__ISOLATION_UID = "user-a";
    const res = mockRes();
    await handlers.handleDeletePlaidItem(
      mockReq({ query: { itemId: "item-b", workspaceUserId: WORKSPACE_B } }),
      res
    );

    assert.equal(res.statusCode, 404);
    const stillThere = await prisma.plaidItem.findUnique({ where: { itemId: "item-b" } });
    assert.ok(stillThere);
    assert.equal(stillThere.userId, "user-b");
  }
);

test("deleting an own item with the wrong workspaceUserId is rejected", { skip }, async (t) => {
  if (setupError) return t.skip("module mocking unavailable");

  // User A owns item-a under WORKSPACE_A. Supplying a mismatched workspace scope
  // must NOT delete it — the (userId, workspaceUserId, itemId) filter misses.
  globalThis.__ISOLATION_UID = "user-a";
  const res = mockRes();
  await handlers.handleDeletePlaidItem(
    mockReq({ query: { itemId: "item-a", workspaceUserId: "wrong-workspace" } }),
    res
  );

  assert.equal(res.statusCode, 404);
  const stillThere = await prisma.plaidItem.findUnique({ where: { itemId: "item-a" } });
  assert.ok(stillThere);
  assert.equal(stillThere.userId, "user-a");
});

test(
  "delete-user-data with another user's workspaceUserId deletes nothing",
  { skip },
  async (t) => {
    if (setupError) return t.skip("module mocking unavailable");

    globalThis.__ISOLATION_UID = "user-a";
    const res = mockRes();
    await handlers.handleDeletePlaidWorkspace(
      mockReq({ query: { workspaceUserId: WORKSPACE_B } }),
      res
    );

    // The endpoint succeeds but is scoped to A's own (empty) WORKSPACE_B slice,
    // so B's data is untouched.
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.deletedItemCount, 0);
    const bItem = await prisma.plaidItem.findUnique({ where: { itemId: "item-b" } });
    assert.ok(bItem);
    assert.equal(bItem.userId, "user-b");
    const bAccount = await prisma.account.findUnique({ where: { plaidAccountId: "acct-user-b" } });
    assert.ok(bAccount);
  }
);

test("a user cannot open a link-token update for another user's item", { skip }, async (t) => {
  if (setupError) return t.skip("module mocking unavailable");

  globalThis.__ISOLATION_UID = "user-a";
  const res = mockRes();
  await handlers.handleCreatePlaidLinkToken(
    mockReq({ body: { plaidItemId: "item-b", workspaceUserId: WORKSPACE_B } }),
    res
  );

  assert.equal(res.statusCode, 404);
});

test(
  "a link-token update for an own item with the wrong workspaceUserId is rejected",
  { skip },
  async (t) => {
    if (setupError) return t.skip("module mocking unavailable");

    globalThis.__ISOLATION_UID = "user-a";
    const res = mockRes();
    await handlers.handleCreatePlaidLinkToken(
      mockReq({ body: { plaidItemId: "item-a", workspaceUserId: "wrong-workspace" } }),
      res
    );

    assert.equal(res.statusCode, 404);
  }
);

test(
  "exchange-public-token cannot re-home an item that belongs to another user",
  { skip },
  async (t) => {
    if (setupError) return t.skip("module mocking unavailable");

    // User A exchanges a token whose item_id resolves to User B's existing item.
    // The ownership guard must reject with 409 and leave B's item owner intact.
    globalThis.__ISOLATION_UID = "user-a";
    globalThis.__ISOLATION_EXCHANGE_ITEM_ID = "item-b";
    const res = mockRes();
    await handlers.handleExchangePlaidPublicToken(
      mockReq({ body: { publicToken: "public-sandbox", workspaceUserId: WORKSPACE_A } }),
      res
    );

    assert.equal(res.statusCode, 409);
    const bItem = await prisma.plaidItem.findUnique({ where: { itemId: "item-b" } });
    assert.ok(bItem);
    assert.equal(bItem.userId, "user-b");
    assert.equal(bItem.workspaceUserId, WORKSPACE_B);

    globalThis.__ISOLATION_EXCHANGE_ITEM_ID = "item-a";
  }
);

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
