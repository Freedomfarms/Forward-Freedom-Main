import test, { before, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// Finance agent tests: aggregate computation from ENCRYPTED fixtures (with
// legacy-plaintext fallback), and proof that no merchant / account-name /
// institution / Plaid-identifier string ever reaches the model payload.
//
// Requires: node --test --experimental-test-module-mocks (npm test).

let setupError = null;
let finance;
let setLlmImplementationForTesting;
let createFakeDb;
let envelope;

let currentDb;

const USER_ID = "user-1";
const NOW = new Date("2026-07-15T12:00:00Z");

const SECRET_STRINGS = [
  "SECRET_MERCHANT_COFFEE_HUT",
  "SECRET_ACCOUNT_NAME",
  "SECRET_BANK_NAME",
  "plaid-secret-account-id",
  "plaid-secret-transaction-id",
];

before(async () => {
  process.env.FFF_ENCRYPTION_KEYS = `1:${crypto.randomBytes(32).toString("base64")}`;
  process.env.FFF_ENCRYPTION_ACTIVE_VERSION = "1";
  const { resetKeyProviderCache } = await import("../server/security/keyProvider.js");
  resetKeyProviderCache();

  try {
    mock.module("../server/db/prisma.js", {
      namedExports: {
        withUserContext: async (userId, fn) => fn(currentDb.tx),
      },
    });
    ({ createFakeDb } = await import("./helpers/fakeAgentDb.js"));
    finance = await import("../server/agents/types/finance.js");
    ({ setLlmImplementationForTesting } = await import("../server/agents/llm.js"));
    envelope = await import("../server/security/envelope.js");
  } catch (error) {
    setupError = error;
  }
});

function requireSetup(t) {
  if (setupError) {
    t.skip(`requires --experimental-test-module-mocks (${setupError.message})`);
    return false;
  }
  return true;
}

function encryptedTransaction({ month, day = 10, category, amount, merchant = "SECRET_MERCHANT_COFFEE_HUT" }) {
  return {
    id: crypto.randomUUID(),
    userId: USER_ID,
    // Merchant fields are present on the row (and encrypted, like production
    // data) — the agent must never read or forward them.
    merchant: null,
    merchantCiphertext: envelope.encrypt(merchant),
    category: null,
    categoryCiphertext: envelope.encrypt(category),
    amount: null,
    amountCiphertext: envelope.encryptNumber(amount),
    postedAt: new Date(`${month}-${String(day).padStart(2, "0")}T12:00:00Z`),
    pending: false,
    plaidTransactionId: "plaid-secret-transaction-id",
  };
}

function legacyPlaintextTransaction({ month, day = 12, category, amount }) {
  return {
    id: crypto.randomUUID(),
    userId: USER_ID,
    merchant: "SECRET_MERCHANT_COFFEE_HUT",
    merchantCiphertext: null,
    category,
    categoryCiphertext: null,
    amount,
    amountCiphertext: null,
    postedAt: new Date(`${month}-${String(day).padStart(2, "0")}T12:00:00Z`),
    pending: false,
    plaidTransactionId: null,
  };
}

function fixtureTransactions() {
  return [
    // Dining: Apr -100, May -300, Jun -200, Jul -400 (encrypted rows).
    encryptedTransaction({ month: "2026-04", category: "Dining", amount: -100 }),
    encryptedTransaction({ month: "2026-05", category: "Dining", amount: -300 }),
    encryptedTransaction({ month: "2026-06", category: "Dining", amount: -200 }),
    encryptedTransaction({ month: "2026-07", category: "Dining", amount: -250 }),
    encryptedTransaction({ month: "2026-07", day: 11, category: "Dining", amount: -150 }),
    // Groceries via the legacy plaintext fallback path.
    legacyPlaintextTransaction({ month: "2026-07", category: "Groceries", amount: -150 }),
    // Outside the 6-month window → ignored.
    encryptedTransaction({ month: "2025-12", category: "Dining", amount: -999 }),
  ];
}

function fixtureAccounts() {
  return [
    {
      id: "acct-1",
      userId: USER_ID,
      name: "SECRET_ACCOUNT_NAME",
      institution: "SECRET_BANK_NAME",
      plaidAccountId: "plaid-secret-account-id",
      type: "Checking",
      balance: null,
      balanceCiphertext: envelope.encryptNumber(1000),
    },
    {
      id: "acct-2",
      userId: USER_ID,
      name: "SECRET_ACCOUNT_NAME",
      institution: "SECRET_BANK_NAME",
      plaidAccountId: null,
      type: "Checking",
      balance: 500, // legacy plaintext fallback
      balanceCiphertext: null,
    },
    {
      id: "acct-3",
      userId: USER_ID,
      name: "SECRET_ACCOUNT_NAME",
      institution: "SECRET_BANK_NAME",
      plaidAccountId: null,
      type: "Credit Card",
      balance: null,
      balanceCiphertext: envelope.encryptNumber(-250),
    },
  ];
}

test("computes monthly category totals, deltas and account-type balances from encrypted fixtures", (t) => {
  if (!requireSetup(t)) return;
  const aggregates = finance.computeFinanceAggregates({
    transactions: fixtureTransactions(),
    accounts: fixtureAccounts(),
    now: NOW,
  });

  assert.deepEqual(aggregates.months, [
    "2026-02",
    "2026-03",
    "2026-04",
    "2026-05",
    "2026-06",
    "2026-07",
  ]);
  // The out-of-window transaction is excluded.
  assert.equal(aggregates.transactionCount, 6);

  const julyDining = aggregates.monthlyCategoryTotals.find(
    (entry) => entry.month === "2026-07" && entry.category === "Dining"
  );
  assert.equal(julyDining.total, -400);
  const julyGroceries = aggregates.monthlyCategoryTotals.find(
    (entry) => entry.month === "2026-07" && entry.category === "Groceries"
  );
  assert.equal(julyGroceries.total, -150);

  const diningDelta = aggregates.categoryDeltas.find((entry) => entry.category === "Dining");
  assert.equal(diningDelta.latestTotal, -400);
  assert.equal(diningDelta.previousTotal, -200);
  // |−400| vs |−200| month-over-month → +100%.
  assert.equal(diningDelta.momChangePct, 100);
  // Apr/May/Jun average = −200 → +100% vs the 3-month average.
  assert.equal(diningDelta.threeMonthAverage, -200);
  assert.equal(diningDelta.vsThreeMonthAvgPct, 100);

  // Groceries has no history: percentage deltas fail closed to null.
  const groceriesDelta = aggregates.categoryDeltas.find((entry) => entry.category === "Groceries");
  assert.equal(groceriesDelta.momChangePct, null);
  assert.equal(groceriesDelta.vsThreeMonthAvgPct, null);

  // Balance totals are grouped by account TYPE only — no names anywhere.
  assert.deepEqual(aggregates.accountBalancesByType, [
    { accountType: "Checking", totalBalance: 1500, accountCount: 2 },
    { accountType: "Credit Card", totalBalance: -250, accountCount: 1 },
  ]);
  assert.ok(!JSON.stringify(aggregates).includes("SECRET_"));
});

test("no merchant, account-name, institution or Plaid identifier ever reaches the prompt payload", async (t) => {
  if (!requireSetup(t)) return;
  currentDb = createFakeDb({
    transaction: fixtureTransactions(),
    account: fixtureAccounts(),
  });

  let captured = null;
  setLlmImplementationForTesting({
    generateObject: async (options) => {
      captured = options;
      return {
        object: { report: "Report.", summary: "Summary." },
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    },
  });

  const config = {
    id: "agent-1",
    model: "claude-sonnet-4-5",
    instructions: "Watch my dining spend.",
    definitionOfDone: "A weekly observations report.",
  };
  const result = await finance.runFinanceAgent({ userId: USER_ID, config });

  assert.ok(captured, "the model should have been called once");
  const payload = JSON.stringify(captured);
  for (const secret of SECRET_STRINGS) {
    assert.ok(!payload.includes(secret), `prompt payload must not contain ${secret}`);
  }
  // The aggregates DID make it into the payload.
  assert.ok(payload.includes("Dining"));
  assert.ok(payload.includes("accountBalancesByType"));

  // The observations-only system prompt forbids directives.
  assert.match(captured.system, /NEVER give prescriptive advice/);
  assert.match(captured.system, /buy X, sell Y, move money to Z/);
  assert.match(captured.system, /investment recommendation/);

  // The DB query never even selects merchant or identifier columns.
  const transactionQuery = currentDb.calls.find(
    (call) => call.table === "transaction" && call.method === "findMany"
  );
  for (const column of ["merchant", "merchantCiphertext", "plaidTransactionId", "accountId"]) {
    assert.ok(!(column in transactionQuery.args.select), `transaction select must omit ${column}`);
  }
  const accountQuery = currentDb.calls.find(
    (call) => call.table === "account" && call.method === "findMany"
  );
  for (const column of ["name", "institution", "plaidAccountId"]) {
    assert.ok(!(column in accountQuery.args.select), `account select must omit ${column}`);
  }

  // Run result stays minimized too.
  const resultPayload = JSON.stringify(result);
  for (const secret of SECRET_STRINGS) {
    assert.ok(!resultPayload.includes(secret), `run result must not contain ${secret}`);
  }
  assert.equal(result.summary, "Summary.");
  assert.equal(result.output, "Report.");
  // The out-of-window fixture row is filtered by the query itself.
  assert.equal(result.dataAccessed.transactions.count, 6);
});
