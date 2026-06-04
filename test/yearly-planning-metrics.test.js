import test from "node:test";
import assert from "node:assert/strict";

import { buildYearlyPlanningMetrics } from "../src/utils/yearlyPlanningMetrics.js";

const seed = [
  {
    month: "Jan",
    income: 8000,
    actualIncome: 7900,
    recurringIncome: 8000,
    oneTimeIncome: 0,
    budget: 6000,
    spent: 5500,
  },
];

const budgetRows = [
  {
    budget: 6000,
    months: ["Jan"],
  },
];

const incomeStreams = [
  {
    name: "Payroll",
    amount: "$8,000",
    months: ["Jan"],
  },
];

test("yearly planning metrics do not show demo actuals without live transactions", () => {
  const [january] = buildYearlyPlanningMetrics({
    transactions: [],
    budgetRows,
    incomeStreams,
    yearlyOpsSeed: seed,
    year: 2026,
  });

  assert.equal(january.plannedIncome, 8000);
  assert.equal(january.budget, 6000);
  assert.equal(january.actualIncome, 0);
  assert.equal(january.spent, 0);
});

test("yearly planning metrics can explicitly use demo fallback actuals", () => {
  const [january] = buildYearlyPlanningMetrics({
    transactions: [],
    budgetRows,
    incomeStreams,
    yearlyOpsSeed: seed,
    useSeedFallback: true,
    year: 2026,
  });

  assert.equal(january.actualIncome, 7900);
  assert.equal(january.spent, 5500);
});
