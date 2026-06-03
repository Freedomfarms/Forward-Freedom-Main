import { budgetMonths } from "../data/constants.jsx";
import { parseMoney } from "./format.js";
import {
  buildBudgetMonthlySpendSeries,
  buildMonthlyActualIncomeSeries,
} from "./budgetReview.js";

function finiteMoney(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function resolveActualValue(liveValue, seedValue) {
  const live = finiteMoney(liveValue);
  const seed = finiteMoney(seedValue);
  return live > 0 ? live : seed;
}

export function buildYearlyPlanningMetrics({
  transactions = [],
  budgetRows = [],
  incomeStreams = [],
  yearlyOpsSeed = [],
  year,
}) {
  const safeTransactions = Array.isArray(transactions) ? transactions : [];
  const monthlySpendSeries = buildBudgetMonthlySpendSeries(safeTransactions, budgetRows, year);
  const monthlyActualIncomeSeries = buildMonthlyActualIncomeSeries(safeTransactions, year);
  const planConfigured =
    incomeStreams.length > 0 || budgetRows.some((row) => finiteMoney(row.budget) > 0);

  return budgetMonths.map((month) => {
    const seedMonth = yearlyOpsSeed.find((entry) => entry.month === month) || { month };
    const activeStreams = incomeStreams.filter((stream) =>
      (stream.months || budgetMonths).includes(month)
    );
    const plannedFromStreams = activeStreams.reduce((sum, stream) => sum + parseMoney(stream.amount), 0);
    const oneTimeFromStreams = activeStreams
      .filter((stream) => stream.type === "One-Time")
      .reduce((sum, stream) => sum + parseMoney(stream.amount), 0);
    const activeBudgetCategories = budgetRows.filter((category) =>
      (category.months || budgetMonths).includes(month)
    );
    const budgetFromRows = activeBudgetCategories.reduce(
      (sum, category) => sum + finiteMoney(category.budget),
      0
    );
    const spentLive =
      monthlySpendSeries.find((entry) => entry.month === month)?.spent || 0;
    const actualIncomeLive =
      monthlyActualIncomeSeries.find((entry) => entry.month === month)?.actualIncome || 0;

    const plannedIncome = planConfigured
      ? finiteMoney(plannedFromStreams)
      : finiteMoney(seedMonth.income);
    const budget = planConfigured ? finiteMoney(budgetFromRows) : finiteMoney(seedMonth.budget);
    const spent = planConfigured
      ? resolveActualValue(spentLive, seedMonth.spent)
      : finiteMoney(seedMonth.spent);
    const actualIncome = planConfigured
      ? resolveActualValue(actualIncomeLive, seedMonth.income)
      : finiteMoney(seedMonth.income);
    const oneTimeIncome = planConfigured
      ? finiteMoney(oneTimeFromStreams)
      : finiteMoney(seedMonth.oneTimeIncome);
    const recurringIncome = planConfigured
      ? plannedIncome - oneTimeIncome
      : finiteMoney(seedMonth.recurringIncome);

    return {
      ...seedMonth,
      month,
      income: plannedIncome,
      plannedIncome,
      actualIncome,
      budget,
      spent,
      baseBudget: budget,
      profit: plannedIncome - budget,
      recurringIncome,
      oneTimeIncome,
    };
  });
}
