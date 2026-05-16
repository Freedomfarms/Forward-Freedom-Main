import { budgetMonths } from "../data/constants.jsx";
import { getCurrentBudgetPeriod } from "./date.js";
import { parseMoney } from "./format.js";

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

export function buildPlanYearData({
  budgetRows = [],
  incomeStreams = [],
  projectionAdjustments = {},
  startingMonth = getCurrentBudgetPeriod().month,
  startingTrueCash = 0,
} = {}) {
  return {
    budgetRows: cloneValue(budgetRows),
    incomeStreams: cloneValue(incomeStreams),
    projectionAdjustments: cloneValue(projectionAdjustments),
    startingMonth,
    startingTrueCash: Number(startingTrueCash) || 0,
  };
}

export function normalizePlansByYear(rawPlansByYear, fallbackPlanData) {
  const currentYear = getCurrentBudgetPeriod().year;
  const fallback = buildPlanYearData(fallbackPlanData);

  if (!rawPlansByYear || typeof rawPlansByYear !== "object") {
    return { [currentYear]: fallback };
  }

  const normalizedEntries = Object.entries(rawPlansByYear).map(([year, plan]) => [
    String(year),
    buildPlanYearData(plan),
  ]);

  if (normalizedEntries.length === 0) {
    return { [currentYear]: fallback };
  }

  return Object.fromEntries(normalizedEntries);
}

export function ensurePlanYearData(plansByYear, targetYear, fallbackPlanData) {
  const normalizedPlans = normalizePlansByYear(plansByYear, fallbackPlanData);
  const targetKey = String(targetYear);
  if (normalizedPlans[targetKey]) return normalizedPlans;

  const currentYear = getCurrentBudgetPeriod().year;
  const availableYears = Object.keys(normalizedPlans)
    .map(Number)
    .filter((year) => Number.isFinite(year))
    .sort((a, b) => a - b);
  const referenceYear =
    availableYears.find((year) => year === currentYear) ??
    availableYears.filter((year) => year < targetYear).at(-1) ??
    availableYears.find((year) => year > targetYear) ??
    availableYears[availableYears.length - 1];
  const referencePlan =
    normalizedPlans[String(referenceYear)] || buildPlanYearData(fallbackPlanData);
  const fallback = buildPlanYearData(fallbackPlanData);
  const defaultStartingMonth = targetYear === currentYear ? fallback.startingMonth : "Jan";
  const defaultStartingTrueCash = fallback.startingTrueCash;

  return {
    ...normalizedPlans,
    [targetKey]: buildPlanYearData({
      ...referencePlan,
      startingMonth: defaultStartingMonth,
      startingTrueCash: defaultStartingTrueCash,
    }),
  };
}

export function getPlanYearData(plansByYear, targetYear, fallbackPlanData) {
  const ensuredPlans = ensurePlanYearData(plansByYear, targetYear, fallbackPlanData);
  return {
    plansByYear: ensuredPlans,
    planData: ensuredPlans[String(targetYear)],
  };
}

export function buildPlanningYearOptions(plansByYear, currentYear = getCurrentBudgetPeriod().year) {
  const years = new Set([
    currentYear - 1,
    currentYear,
    currentYear + 1,
    currentYear + 2,
    ...Object.keys(plansByYear || {})
      .map(Number)
      .filter((year) => Number.isFinite(year)),
  ]);

  return [...years].sort((a, b) => a - b);
}

function buildMonthlyNetForYear(planData, month) {
  const income = (planData?.incomeStreams || [])
    .filter((stream) => (stream.months || budgetMonths).includes(month))
    .reduce((sum, stream) => sum + parseMoney(stream.amount), 0);
  const budget = (planData?.budgetRows || [])
    .filter((row) => (row.months || budgetMonths).includes(month))
    .reduce((sum, row) => sum + Number(row.budget || 0), 0);
  const adjustment = parseMoney(planData?.projectionAdjustments?.[month]);

  return income - budget + adjustment;
}

export function buildFullYearProjectionSeries({
  targetYear,
  plansByYear = {},
  fallbackPlanData = {},
}) {
  const targetPlan =
    ensurePlanYearData(plansByYear, targetYear, fallbackPlanData)[String(targetYear)] ||
    buildPlanYearData(fallbackPlanData);
  const startMonthIndex = Math.max(
    0,
    budgetMonths.indexOf(targetPlan.startingMonth || getCurrentBudgetPeriod().month)
  );
  let runningBalance = Number(targetPlan.startingTrueCash) || 0;

  return budgetMonths.map((month) => {
    const monthIndex = budgetMonths.indexOf(month);
    if (monthIndex >= startMonthIndex) {
      runningBalance += buildMonthlyNetForYear(targetPlan, month);
    }

    return {
      month,
      year: targetYear,
      value: runningBalance,
    };
  });
}
