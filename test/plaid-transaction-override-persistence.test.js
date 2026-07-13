import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPlaidTransactionOverrides,
  buildPlaidTransactionOverrideMap,
  normalizePlaidTransactionOverrideMap,
  upsertPlaidCategoryOverride,
} from "../src/utils/plaidTransactionOverrides.js";
import { sanitizeWorkspaceStateForPersistence } from "../src/utils/workspacePersistence.js";

test("plaid transaction override helpers preserve user-confirmed categories", () => {
  const overrideMap = buildPlaidTransactionOverrideMap([
    {
      id: "plaid-tx-1",
      plaidTransactionId: "tx-1",
      source: "plaid",
      merchant: "PURCHASE",
      category: "Groceries",
      categorySource: "user",
    },
    {
      id: "manual-1",
      source: "manual",
      merchant: "Farmers Market",
      category: "Groceries",
      categorySource: "user",
    },
  ]);

  assert.deepEqual(overrideMap, {
    "tx-1": { category: "Groceries" },
  });
  assert.deepEqual(normalizePlaidTransactionOverrideMap({ "tx-1": { category: " Groceries " } }), {
    "tx-1": { category: "Groceries" },
  });
});

test("workspace persistence retains plaid transaction overrides without duplicating plaid transactions", () => {
  const sanitized = sanitizeWorkspaceStateForPersistence({
    users: [
      {
        id: "user-1",
        name: "User 1",
        accounts: [],
        transactions: [
          {
            id: "plaid-tx-1",
            plaidTransactionId: "tx-1",
            source: "plaid",
            merchant: "PURCHASE",
            category: "Groceries",
            categorySource: "user",
            amount: -42.5,
          },
        ],
        plaidTransactionOverrides: {
          "tx-1": { category: "Groceries" },
        },
      },
    ],
    activeUserId: "user-1",
  });

  assert.equal(sanitized.users[0].transactions.length, 0);
  assert.deepEqual(sanitized.users[0].plaidTransactionOverrides, {
    "tx-1": { category: "Groceries" },
  });
  assert.equal(JSON.stringify(sanitized).includes("-42.5"), false);
});

test("saved plaid transaction overrides are reapplied after a refreshed sync payload", () => {
  const transactions = applyPlaidTransactionOverrides(
    [
      {
        id: "plaid-tx-1",
        plaidTransactionId: "tx-1",
        source: "plaid",
        merchant: "PURCHASE",
        category: "Uncategorized",
        categorySource: "ai",
        date: "2026-07-11",
        plaidPostedDate: "2026-07-11",
      },
    ],
    {
      "tx-1": { category: "AI Technology" },
    }
  );

  assert.equal(transactions[0].category, "AI Technology");
  assert.equal(transactions[0].categorySource, "user");
});

test("upsertPlaidCategoryOverride stores per-transaction overrides for generic merchants", () => {
  const next = upsertPlaidCategoryOverride({}, {
    id: "plaid-tx-1",
    plaidTransactionId: "tx-1",
    source: "plaid",
    merchant: "PURCHASE",
  }, "AI Technology");

  assert.deepEqual(next, {
    "tx-1": { category: "AI Technology" },
  });
});
