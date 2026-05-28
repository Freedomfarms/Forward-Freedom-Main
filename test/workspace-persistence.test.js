import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeWorkspaceStateForPersistence } from "../src/utils/workspacePersistence.js";

test("workspace persistence strips synced Plaid data but keeps repair metadata", () => {
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
          { id: "plaid-tx", account: "Plaid Checking", amount: -25, source: "plaid" },
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

  assert.equal(user.accounts.length, 1);
  assert.equal(user.accounts[0].name, "Cash");
  assert.equal(user.transactions.length, 1);
  assert.equal(user.transactions[0].id, "manual-tx");
  assert.equal(user.selectedAccount, null);
  assert.deepEqual(user.plaidItems, [
    {
      itemId: "item-1",
      institutionName: "Chase",
      accountIds: ["acc-1"],
      lastSyncAt: "2026-05-28T00:00:00.000Z",
      status: "requires_attention",
    },
  ]);
});
