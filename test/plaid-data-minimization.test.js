import test from "node:test";
import assert from "node:assert/strict";

import { mapPlaidAccountsToAppAccounts } from "../server/mappers.js";
import { getPlaidConfig, getPlaidLinkTokenRequest } from "../server/plaidClient.js";

test("Plaid config only enables transactions and liabilities", () => {
  const config = getPlaidConfig();

  assert.deepEqual(config.products, ["transactions", "liabilities"]);
  assert.deepEqual(config.optionalProducts, []);
  assert.equal(config.capabilities.transactions, true);
  assert.equal(config.capabilities.liabilities, true);
  assert.equal(config.capabilities.investments, false);
});

test("Link token request does not ask for optional products", () => {
  const request = getPlaidLinkTokenRequest({
    userId: "user-123",
    userName: "Taylor User",
  });

  assert.deepEqual(request.products, ["transactions", "liabilities"]);
  assert.equal("optional_products" in request, false);
  assert.deepEqual(request.transactions, { days_requested: 365 });
});

test("Mapped Plaid accounts keep payment details but omit account masks", () => {
  const mappedAccounts = mapPlaidAccountsToAppAccounts({
    itemId: "item-123",
    institutionName: "Forward Bank",
    liabilityLookup: new Map([
      [
        "loan-1",
        {
          account_id: "loan-1",
          interest_rate: { percentage: 5.5 },
          minimum_payment_amount: 247.13,
        },
      ],
    ]),
    accounts: [
      {
        account_id: "loan-1",
        type: "loan",
        subtype: "mortgage",
        name: "Home Loan",
        official_name: "Mortgage 1234",
        mask: "1234",
        balances: { current: 315000.42 },
      },
    ],
  });

  assert.equal(mappedAccounts.length, 1);
  assert.equal(Object.hasOwn(mappedAccounts[0], "plaidMask"), false);
  assert.equal(mappedAccounts[0].name, "Home Loan");
  assert.equal(mappedAccounts[0].loanCategory, "Mortgage");
  assert.equal(mappedAccounts[0].interestRate, "5.5");
  assert.equal(mappedAccounts[0].monthlyPayment, "247.13");
});
