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

function resolveActualValue(liveValue, seedValue, useSeedFallback) {
  const live = finiteMoney(liveValue);
  const seed = finiteMoney(seedValue);
  return live > 0 ? live : useSeedFallback ? seed : 0;
}

export function buildYearlyPlanningMetrics({
  transactions = [],
  budgetRows = [],
  incomeStreams = [],
  yearlyOpsSeed = [],
  useSeedFallback = false,
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
    const seedActualIncome = seedMonth.actualIncome ?? seedMonth.income;

    const plannedIncome = planConfigured
      ? finiteMoney(plannedFromStreams)
      : useSeedFallback
        ? finiteMoney(seedMonth.income)
        : 0;
    const budget = planConfigured
      ? finiteMoney(budgetFromRows)
      : useSeedFallback
        ? finiteMoney(seedMonth.budget)
        : 0;
    const spent = planConfigured
      ? resolveActualValue(spentLive, seedMonth.spent, useSeedFallback)
      : useSeedFallback
        ? finiteMoney(seedMonth.spent)
        : 0;
    const actualIncome = planConfigured
      ? resolveActualValue(actualIncomeLive, seedActualIncome, useSeedFallback)
      : useSeedFallback
        ? finiteMoney(seedActualIncome)
        : 0;
    const oneTimeIncome = planConfigured
      ? finiteMoney(oneTimeFromStreams)
      : useSeedFallback
        ? finiteMoney(seedMonth.oneTimeIncome)
        : 0;
    const recurringIncome = planConfigured
      ? plannedIncome - oneTimeIncome
      : useSeedFallback
        ? finiteMoney(seedMonth.recurringIncome)
        : 0;

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
