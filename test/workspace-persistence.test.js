import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeWorkspaceStateForPersistence } from "../src/utils/workspacePersistence.js";

test("workspace persistence keeps manual ledger data but drops all Plaid-derived data", () => {
  const input = {
    users: [
      {
        id: "user-1",
        name: "User 1",
        selectedAccount: "Plaid Checking",
        accounts: [
          { id: "manual-1", name: "Cash", type: "Manual Cash", status: "Manual", balance: 75 },
          {
            id: "plaid-1",
            name: "Plaid Checking",
            type: "Checking",
            status: "Synced",
            balance: 4200,
            syncSource: "Plaid",
            plaidAccountId: "acc-1",
            plaidItemId: "item-1",
            plaidMask: "1234",
            accessTokenCiphertext: "encrypted-secret",
          },
          {
            id: "demo-1",
            name: "Demo Credit Card",
            type: "Credit Card",
            status: "Synced",
            balance: -100,
          },
        ],
        transactions: [
          { id: "manual-tx", account: "Cash", amount: 10, source: "manual" },
          {
            id: "plaid-tx",
            account: "Plaid Checking",
            amount: -25,
            source: "plaid",
            raw: { merchant_name: "Sensitive Raw Payload" },
          },
          { id: "demo-tx", account: "Demo Credit Card", amount: -40 },
        ],
        plaidItems: [
          {
            itemId: "item-1",
            institutionName: "Chase",
            accountIds: ["acc-1"],
            lastSyncAt: "2026-05-28T00:00:00.000Z",
            status: "requires_attention",
            lastSyncError: "This should not persist",
          },
        ],
      },
    ],
    activeUserId: "user-1",
  };

  const sanitized = sanitizeWorkspaceStateForPersistence(input);
  const [user] = sanitized.users;

  // Plaid-derived accounts are never persisted in the snapshot (single source of
  // truth is the encrypted normalized tables). Only manual/demo accounts remain.
  assert.deepEqual(
    user.accounts.map((account) => account.name),
    ["Cash", "Demo Credit Card"]
  );
  // Plaid-derived transactions are dropped; manual/demo transactions remain.
  assert.deepEqual(
    user.transactions.map((transaction) => transaction.id),
    ["manual-tx", "demo-tx"]
  );
  // The Plaid item list is not duplicated into the snapshot either.
  assert.deepEqual(user.plaidItems, []);
  // Sensitive fields never survive persistence.
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes("encrypted-secret"), false);
  assert.equal(serialized.includes("Sensitive Raw Payload"), false);
  assert.equal(serialized.includes("plaidMask"), false);
  assert.equal(user.selectedAccount, "Plaid Checking");
});
