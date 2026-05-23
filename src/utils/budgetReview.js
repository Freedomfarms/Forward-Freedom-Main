import { budgetMonthNames, budgetMonths } from "../data/constants.jsx";
import { getCurrentBudgetPeriod } from "./date.js";
import { isSpendTransaction, sumSpendTransactions } from "./transactions.js";

const monthNameToBudgetMonth = Object.fromEntries(
  budgetMonths.map((month) => [budgetMonthNames[month], month])
);

export function parseBudgetReviewDate(value) {
  const match = /^([A-Za-z]+)\s+\d{1,2},\s+(\d{4})$/.exec(value || "");
  if (!match) return null;

  const [, monthName, year] = match;
  const month = monthNameToBudgetMonth[monthName];
  if (!month) return null;

  return { month, year: Number(year) || getCurrentBudgetPeriod().year };
}

export function isTransactionInBudgetMonth(transaction, month, year) {
  const parsed = parseBudgetReviewDate(transaction?.date);
  return parsed?.month === month && parsed?.year === year;
}

function buildBudgetCategorySet(row) {
  return new Set([row.name, ...(row.transactionCategories || [])].filter(Boolean));
}

export function buildMonthlySpendSnapshot(
  transactions,
  budgetRows,
  { month = getCurrentBudgetPeriod().month, year = getCurrentBudgetPeriod().year, accountName = null } = {}
) {
  const activeBudgetRows = budgetRows.filter((row) => (row.months || budgetMonths).includes(month));
  const activeMonthTransactions = transactions.filter(
    (tx) => isTransactionInBudgetMonth(tx, month, year) && (!accountName || tx.account === accountName)
  );
  const spendTransactions = activeMonthTransactions.filter((tx) => isSpendTransaction(tx));
  const matchedBudgetCategories = new Set(
    activeBudgetRows
      .filter((row) => row.name !== "Other")
      .flatMap((row) => Array.from(buildBudgetCategorySet(row)))
  );
  const unmatchedTransactions = spendTransactions.filter(
    (tx) => !matchedBudgetCategories.has(tx.category)
  );

  const rows = activeBudgetRows
    .map((row) => {
      const rowCategorySet = buildBudgetCategorySet(row);
      const spent = spendTransactions
        .filter((tx) => {
          if (row.name === "Other") return !matchedBudgetCategories.has(tx.category);
          return rowCategorySet.has(tx.category);
        })
        .reduce((sum, tx) => sum + Math.abs(tx.amount), 0);

      return {
        ...row,
        months: row.months || budgetMonths,
        spent,
        remaining: Number(row.budget || 0) - spent,
        color: row.color || "#00d8ff",
      };
    });
  const monthlyBudget = rows.reduce((sum, row) => sum + Number(row.budget || 0), 0);
  const monthlySpend = sumSpendTransactions(activeMonthTransactions);

  return {
    month,
    year,
    monthIndex: budgetMonths.indexOf(month),
    label: `${budgetMonthNames[month]} ${year}`,
    scope: {
      type: accountName ? "account" : "household",
      accountName: accountName || null,
    },
    monthTransactions: activeMonthTransactions,
    spendTransactions,
    rows,
    monthlyBudget,
    monthlySpend,
    monthlySpent: monthlySpend,
    remaining: monthlyBudget - monthlySpend,
    unmatchedSpend: sumSpendTransactions(unmatchedTransactions),
    unmatchedTransactions,
  };
}

export function buildBudgetRowsWithSpend(transactions, budgetRows, month, year) {
  return buildMonthlySpendSnapshot(transactions, budgetRows, { month, year }).rows;
}

export function buildMonthlyBudgetReview(transactions, budgetRows, options = {}) {
  const snapshot = buildMonthlySpendSnapshot(transactions, budgetRows, options);

  return {
    month: snapshot.month,
    year: snapshot.year,
    rows: snapshot.rows,
    monthlyBudget: snapshot.monthlyBudget,
    monthlySpent: snapshot.monthlySpend,
    remaining: snapshot.remaining,
  };
}

export function buildBudgetMonthlySpendSeries(transactions, budgetRows, year) {
  return budgetMonths.map((month) => {
    const snapshot = buildMonthlySpendSnapshot(transactions, budgetRows, { month, year });

    return {
      month,
      year,
      spent: snapshot.monthlySpend,
    };
  });
}
