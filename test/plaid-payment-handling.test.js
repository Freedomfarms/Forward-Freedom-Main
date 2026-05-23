import test from "node:test";
import assert from "node:assert/strict";

import { mapPlaidTransactionsToAppTransactions } from "../server/mappers.js";
import { isSpendTransaction, sumSpendTransactions } from "../src/utils/transactions.js";

test("credit card payments map as positive transfer activity", () => {
  const transactions = mapPlaidTransactionsToAppTransactions(
    [
      {
        transaction_id: "tx-1",
        account_id: "acct-1",
        date: "2026-04-30",
        merchant_name: "BA ELECTRONIC PAYMENT",
        name: "BA ELECTRONIC PAYMENT",
        amount: 2000,
        pending: false,
        personal_finance_category: {
          primary: "GENERAL_SERVICES",
          detailed: "GENERAL_SERVICES",
        },
      },
    ],
    {
      "acct-1": {
        name: "Corp Card",
        type: "Credit Card",
      },
    }
  );

  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].category, "Transfers");
  assert.equal(transactions[0].amount, 2000);
});

test("transfer activity is excluded from spend calculations", () => {
  assert.equal(isSpendTransaction({ amount: -2000, category: "Transfers" }), false);
  assert.equal(isSpendTransaction({ amount: -75, category: "Groceries" }), true);

  const spendTotal = sumSpendTransactions([
    { amount: -2000, category: "Transfers" },
    { amount: -75, category: "Groceries" },
  ]);

  assert.equal(spendTotal, 75);
});
