import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPlaidNicknamesToAccounts,
  buildPlaidNicknameMap,
  normalizePlaidNicknameMap,
} from "../src/utils/plaidNicknames.js";
import { sanitizeWorkspaceStateForPersistence } from "../src/utils/workspacePersistence.js";

test("plaid nickname helpers preserve only valid plaid nickname preferences", () => {
  const nicknameMap = buildPlaidNicknameMap([
    {
      id: "manual-1",
      name: "Cash",
      nickname: "Pocket Cash",
      status: "Manual",
    },
    {
      id: "plaid-1",
      plaidAccountId: "acct-1",
      name: "Primary Checking",
      nickname: "Bills Account",
      syncSource: "Plaid",
    },
    {
      id: "plaid-2",
      plaidAccountId: "acct-2",
      name: "Savings",
      nickname: "   ",
      syncSource: "Plaid",
    },
  ]);

  assert.deepEqual(nicknameMap, {
    "acct-1": "Bills Account",
  });
  assert.deepEqual(normalizePlaidNicknameMap({ "acct-1": " Bills Account ", "acct-2": "" }), {
    "acct-1": "Bills Account",
  });
});

test("workspace persistence retains plaid nickname preferences with plaid account summaries", () => {
  const sanitized = sanitizeWorkspaceStateForPersistence({
    users: [
      {
        id: "user-1",
        name: "User 1",
        accounts: [
          {
            id: "plaid-1",
            plaidAccountId: "acct-1",
            name: "Primary Checking",
            nickname: "Bills Account",
            status: "Synced",
            syncSource: "Plaid",
            balance: 4200,
            plaidMask: "1234",
          },
        ],
        transactions: [],
        plaidItems: [
          {
            itemId: "item-1",
            institutionName: "Chase",
            status: "connected",
          },
        ],
        plaidNicknames: {
          "acct-1": "Bills Account",
        },
      },
    ],
    activeUserId: "user-1",
  });

  assert.equal(sanitized.users[0].accounts.length, 1);
  assert.equal(sanitized.users[0].accounts[0].nickname, "Bills Account");
  assert.equal(Object.hasOwn(sanitized.users[0].accounts[0], "plaidMask"), false);
  assert.deepEqual(sanitized.users[0].plaidNicknames, {
    "acct-1": "Bills Account",
  });
});

test("saved plaid nicknames are reapplied after a refreshed sync payload", () => {
  const accounts = applyPlaidNicknamesToAccounts(
    [
      {
        id: "plaid-acct-1",
        plaidAccountId: "acct-1",
        name: "Primary Checking",
        syncSource: "Plaid",
      },
    ],
    {
      "acct-1": "Bills Account",
    }
  );

  assert.equal(accounts[0].name, "Primary Checking");
  assert.equal(accounts[0].nickname, "Bills Account");
});
