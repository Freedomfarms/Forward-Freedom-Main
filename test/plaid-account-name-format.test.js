import test from "node:test";
import assert from "node:assert/strict";

import { mapPlaidAccountsToAppAccounts } from "../server/mappers.js";

test("Plaid account names are normalized for display", () => {
  const mappedAccounts = mapPlaidAccountsToAppAccounts({
    itemId: "item-123",
    institutionName: "Capital One",
    liabilityLookup: new Map(),
    accounts: [
      {
        account_id: "credit-1",
        type: "credit",
        subtype: "credit card",
        name: "creditAccount 6488",
        balances: { current: 70 },
      },
    ],
  });

  assert.equal(mappedAccounts.length, 1);
  assert.equal(mappedAccounts[0].name, "Credit Account 6488");
});
