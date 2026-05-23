import test from "node:test";
import assert from "node:assert/strict";

import { createManualAccount, updateManualAccountInUser } from "../src/utils/manualAccounts.js";

test("manual account edits keep the same id and rename linked local data", () => {
  const originalAccount = createManualAccount(
    {
      name: "House Cash",
      type: "Checking",
      institution: "Home Safe",
      balance: 300,
    },
    0,
    { timestamp: 1000 }
  );
  const user = {
    accounts: [originalAccount],
    transactions: [
      { id: "tx-1", account: "House Cash", amount: 25 },
      { id: "tx-2", account: "Other Account", amount: 10 },
    ],
    subscriptions: [
      { id: "sub-1", account: "House Cash", accountId: originalAccount.id },
      { id: "sub-2", account: "House Cash" },
      { id: "sub-3", account: "Other Account" },
    ],
    selectedAccount: "House Cash",
  };

  const updatedUser = updateManualAccountInUser(
    user,
    originalAccount.id,
    {
      name: "Emergency Cash",
      type: "Checking",
      institution: "Home Safe",
      balance: 450,
    },
    { timestamp: 2000 }
  );

  assert.equal(updatedUser.accounts[0].id, originalAccount.id);
  assert.equal(updatedUser.accounts[0].name, "Emergency Cash");
  assert.equal(updatedUser.accounts[0].balance, 450);
  assert.equal(updatedUser.transactions[0].account, "Emergency Cash");
  assert.equal(updatedUser.transactions[1].account, "Other Account");
  assert.deepEqual(
    updatedUser.subscriptions.map((subscription) => ({
      id: subscription.id,
      account: subscription.account,
      accountId: subscription.accountId || "",
    })),
    [
      { id: "sub-1", account: "Emergency Cash", accountId: originalAccount.id },
      { id: "sub-2", account: "Emergency Cash", accountId: "" },
      { id: "sub-3", account: "Other Account", accountId: "" },
    ]
  );
  assert.equal(updatedUser.selectedAccount, "Emergency Cash");
});

test("manual crypto edits update quantity and derived balance", () => {
  const originalAccount = createManualAccount(
    {
      name: "XRP Wallet",
      type: "Crypto",
      institution: "Ledger",
      balance: 125,
      quantity: 50,
      cryptoAssetId: "ripple",
      cryptoName: "XRP",
      cryptoSymbol: "XRP",
      lastPriceUsd: 2.5,
      lastPriceUpdatedAt: 3000,
      priceSource: "CoinGecko",
    },
    0,
    { timestamp: 3000 }
  );
  const user = {
    accounts: [originalAccount],
    transactions: [],
    subscriptions: [],
    selectedAccount: null,
  };

  const updatedUser = updateManualAccountInUser(
    user,
    originalAccount.id,
    {
      name: "XRP Wallet",
      type: "Crypto",
      institution: "Ledger",
      balance: 250,
      quantity: 100,
      cryptoAssetId: "ripple",
      cryptoName: "XRP",
      cryptoSymbol: "XRP",
      lastPriceUsd: 2.5,
      lastPriceUpdatedAt: 4000,
      priceSource: "CoinGecko",
    },
    { timestamp: 4000 }
  );

  assert.equal(updatedUser.accounts[0].id, originalAccount.id);
  assert.equal(updatedUser.accounts[0].quantity, 100);
  assert.equal(updatedUser.accounts[0].balance, 250);
  assert.equal(updatedUser.accounts[0].lastPriceUsd, 2.5);
});

test("manual real estate edits keep linked loans and updated values", () => {
  const originalAccount = createManualAccount(
    {
      name: "Main Home Equity",
      type: "Real Estate",
      institution: "Family Holdings",
      balance: 200000,
      propertyAddress: "123 Oak Street",
      propertyType: "Primary Residence",
      propertyMarketValue: 500000,
      equitySource: "Derived",
      linkedLoanId: "loan-1",
    },
    0,
    { timestamp: 5000 }
  );
  const user = {
    accounts: [originalAccount],
    transactions: [],
    subscriptions: [],
    selectedAccount: null,
  };

  const updatedUser = updateManualAccountInUser(
    user,
    originalAccount.id,
    {
      name: "Main Home Equity",
      type: "Real Estate",
      institution: "Family Holdings",
      balance: 350000,
      propertyAddress: "123 Oak Street",
      propertyType: "Primary Residence",
      propertyMarketValue: 650000,
      equitySource: "Derived",
      linkedLoanId: "loan-1",
    },
    { timestamp: 6000 }
  );

  assert.equal(updatedUser.accounts[0].id, originalAccount.id);
  assert.equal(updatedUser.accounts[0].propertyMarketValue, 650000);
  assert.equal(updatedUser.accounts[0].balance, 350000);
  assert.equal(updatedUser.accounts[0].linkedLoanId, "loan-1");
});
