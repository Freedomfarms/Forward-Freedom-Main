import test from "node:test";
import assert from "node:assert/strict";

import { mapPlaidTransactionsToAppTransactions } from "../server/mappers.js";
import { buildBudgetRowsWithSpend, isSpendTransaction } from "../src/utils/budgetReview.js";

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

  const rows = buildBudgetRowsWithSpend(
    [
      { date: "April 30, 2026", amount: -2000, category: "Transfers" },
      { date: "April 30, 2026", amount: -75, category: "Groceries" },
    ],
    [
      {
        id: "budget-groceries",
        name: "Groceries",
        budget: 500,
        color: "#a855f7",
        transactionCategories: ["Groceries"],
        months: ["April"],
      },
      {
        id: "budget-other",
        name: "Other",
        budget: 500,
        color: "#94a3b8",
        transactionCategories: [],
        months: ["April"],
      },
    ],
    "April",
    2026
  );

  const groceriesRow = rows.find((row) => row.name === "Groceries");
  const otherRow = rows.find((row) => row.name === "Other");

  assert.equal(groceriesRow?.spent, 75);
  assert.equal(otherRow?.spent, 0);
});
