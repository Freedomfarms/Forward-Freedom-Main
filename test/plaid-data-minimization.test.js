import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { mapPlaidAccountsToAppAccounts } from "../server/mappers.js";
import { getPlaidConfig, getPlaidLinkTokenRequest } from "../server/plaidClient.js";

test("Plaid config only enables transactions and liabilities", () => {
  const config = getPlaidConfig();

  assert.deepEqual(config.products, ["transactions"]);
  assert.deepEqual(config.optionalProducts, ["liabilities"]);
  assert.equal(config.capabilities.transactions, true);
  assert.equal(config.capabilities.liabilities, true);
  assert.equal(config.capabilities.investments, false);
});

test("Link token request treats liabilities as optional and supports OAuth redirect", () => {
  const request = getPlaidLinkTokenRequest({
    userId: "user-123",
    userName: "Taylor User",
    redirectUri: "https://www.forwardfreedomfinancial.com/plaid-oauth.html",
  });

  assert.deepEqual(request.products, ["transactions"]);
  assert.deepEqual(request.optional_products, ["liabilities"]);
  assert.equal(request.redirect_uri, "https://www.forwardfreedomfinancial.com/plaid-oauth.html");
  assert.deepEqual(request.transactions, { days_requested: 365 });
});

test("Link token repair mode can request additional accounts from an existing item", () => {
  const request = getPlaidLinkTokenRequest({
    userId: "user-123",
    userName: "Taylor User",
    accessToken: "access-token",
    enableAccountSelection: true,
  });

  assert.equal(request.access_token, "access-token");
  assert.deepEqual(request.update, { account_selection_enabled: true });
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

test("Plaid handlers do not keep extra mask or raw payload access", () => {
  const handlerSource = fs.readFileSync(new URL("../server/plaid/handlers.js", import.meta.url), "utf8");

  assert.equal(handlerSource.includes("investmentsHoldingsGet"), false);
  assert.equal(handlerSource.includes("plaidMask: accountRecord.plaidMask"), false);
  assert.equal(handlerSource.includes("plaidMask: account.plaidMask"), false);
  assert.equal(handlerSource.includes("raw: transaction"), false);
  assert.equal(handlerSource.includes("plaidMask: null"), true);
  assert.equal(handlerSource.includes("raw: null"), true);
});
