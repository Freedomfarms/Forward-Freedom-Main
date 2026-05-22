import { budgetMonthNames, budgetMonths } from "../data/constants.jsx";
import { getCurrentBudgetPeriod } from "./date.js";
import { isSpendTransaction } from "./transactions.js";

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

export function buildBudgetRowsWithSpend(transactions, budgetRows, month, year) {
  const matchedBudgetCategories = budgetRows
    .filter((row) => row.name !== "Other")
    .flatMap((row) => row.transactionCategories);

  const activeMonthTransactions = transactions.filter((tx) =>
    isTransactionInBudgetMonth(tx, month, year)
  );

  return budgetRows
    .filter((row) => (row.months || budgetMonths).includes(month))
    .map((row) => {
      const spent = activeMonthTransactions
        .filter((tx) => {
          if (!isSpendTransaction(tx)) return false;
          if (row.name === "Other") return !matchedBudgetCategories.includes(tx.category);
          return row.transactionCategories.includes(tx.category);
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
}

export function buildMonthlyBudgetReview(transactions, budgetRows) {
  const currentBudgetPeriod = getCurrentBudgetPeriod();
  const latestTransaction = transactions
    .map((tx) => ({ tx, parsed: parseBudgetReviewDate(tx.date) }))
    .filter((item) => item.parsed)
    .sort((a, b) => {
      const aIndex = budgetMonths.indexOf(a.parsed.month);
      const bIndex = budgetMonths.indexOf(b.parsed.month);
      return a.parsed.year === b.parsed.year ? bIndex - aIndex : b.parsed.year - a.parsed.year;
    })[0];

  const activeMonth = latestTransaction?.parsed?.month || currentBudgetPeriod.month;
  const activeYear = latestTransaction?.parsed?.year || currentBudgetPeriod.year;
  const rows = buildBudgetRowsWithSpend(transactions, budgetRows, activeMonth, activeYear);

  const monthlyBudget = rows.reduce((sum, row) => sum + Number(row.budget || 0), 0);
  const monthlySpent = rows.reduce((sum, row) => sum + row.spent, 0);

  return {
    month: activeMonth,
    year: activeYear,
    rows,
    monthlyBudget,
    monthlySpent,
    remaining: monthlyBudget - monthlySpent,
  };
}

export function buildBudgetMonthlySpendSeries(transactions, budgetRows, year) {
  return budgetMonths.map((month) => {
    const rows = buildBudgetRowsWithSpend(transactions, budgetRows, month, year);
    const spent = rows.reduce((sum, row) => sum + row.spent, 0);

    return {
      month,
      year,
      spent,
    };
  });
}
