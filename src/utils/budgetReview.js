import { budgetMonthNames, budgetMonths } from "../data/constants.jsx";
import { getCurrentBudgetPeriod } from "./date.js";
import { parseMoney } from "./format.js";
import { isSpendTransaction, sumSpendTransactions } from "./transactions.js";

const monthNameToBudgetMonth = Object.fromEntries(
  budgetMonths.flatMap((month) => [
    [budgetMonthNames[month], month],
    [month, month],
  ])
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

function normalizeIncomeMatchToken(value) {
  return String(value ?? "").trim().toLowerCase();
}

function buildIncomeStreamMatchTokens(stream) {
  const extras = Array.isArray(stream.transactionMerchants) ? stream.transactionMerchants : [];
  const nameParts = String(stream.name || "")
    .split(/[\s/|,&]+/)
    .map(normalizeIncomeMatchToken)
    .filter((part) => part.length > 2);
  const merged = [...extras, ...nameParts, stream.name, stream.description];
  return [...new Set(merged.map(normalizeIncomeMatchToken).filter(Boolean))];
}

function merchantMatchesIncomeTokens(merchant, tokens) {
  const merchantNorm = normalizeIncomeMatchToken(merchant);
  if (!merchantNorm || tokens.length === 0) return false;
  return tokens.some(
    (token) => merchantNorm.includes(token) || (token.length > 1 && token.includes(merchantNorm))
  );
}

function isIncomeDepositTransaction(transaction) {
  const amount = Number(transaction?.amount) || 0;
  if (amount <= 0) return false;
  const category = String(transaction?.category || "").trim().toLowerCase();
  if (category === "transfers") return false;
  return true;
}

/**
 * For each active income stream in `month`, sums positive (inflow) transactions in that month.
 * Matches deposits when merchant text matches stream name, description, or `transactionMerchants`.
 * Uncategorized `Income` category deposits only roll into a stream when it is the sole active stream for the month.
 */
export function buildIncomeStreamsWithReceived(transactions, incomeStreams, month, year) {
  const activeStreams = incomeStreams.filter((stream) => (stream.months || budgetMonths).includes(month));
  const depositsInMonth = transactions.filter(
    (tx) => isTransactionInBudgetMonth(tx, month, year) && isIncomeDepositTransaction(tx)
  );

  const streamTokens = activeStreams.map((stream) => ({
    stream,
    tokens: buildIncomeStreamMatchTokens(stream),
  }));

  const receivedById = Object.fromEntries(activeStreams.map((s) => [s.id, 0]));

  for (const tx of depositsInMonth) {
    const merchant = tx.merchant;
    const category = String(tx.category || "").trim().toLowerCase();

    let matchedId = null;
    for (const { stream, tokens } of streamTokens) {
      if (merchantMatchesIncomeTokens(merchant, tokens)) {
        matchedId = stream.id;
        break;
      }
    }

    if (!matchedId && category === "income" && activeStreams.length === 1) {
      matchedId = activeStreams[0].id;
    }

    if (matchedId) {
      receivedById[matchedId] += Number(tx.amount) || 0;
    }
  }

  return activeStreams.map((stream) => ({
    ...stream,
    expected: parseMoney(stream.amount),
    received: receivedById[stream.id] || 0,
  }));
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
  const list = Array.isArray(transactions) ? transactions : [];
  return budgetMonths.map((month) => {
    const snapshot = buildMonthlySpendSnapshot(list, budgetRows, { month, year });

    return {
      month,
      year,
      spent: snapshot.monthlySpend,
    };
  });
}

/** Positive inflows for the month (excludes Transfers category). */
export function sumActualIncomeForMonth(transactions, month, year) {
  const list = Array.isArray(transactions) ? transactions : [];
  return list
    .filter((tx) => isTransactionInBudgetMonth(tx, month, year))
    .reduce((sum, tx) => {
      const amount = Number(tx.amount) || 0;
      if (amount <= 0) return sum;
      const category = String(tx.category || "").trim().toLowerCase();
      if (category === "transfers") return sum;
      return sum + amount;
    }, 0);
}

export function buildMonthlyActualIncomeSeries(transactions, year) {
  return budgetMonths.map((month) => ({
    month,
    year,
    actualIncome: sumActualIncomeForMonth(transactions, month, year),
  }));
}
