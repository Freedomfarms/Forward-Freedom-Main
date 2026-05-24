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
  const liveStartingMonth = getCurrentBudgetPeriod().month;
  const defaultStartingTrueCash = fallback.startingTrueCash;

  return {
    ...normalizedPlans,
    [targetKey]: buildPlanYearData({
      ...referencePlan,
      startingMonth: liveStartingMonth,
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
    currentYear,
    currentYear + 1,
    currentYear + 2,
    ...Object.keys(plansByYear || {})
      .map(Number)
      .filter((year) => Number.isFinite(year)),
  ]);

  return [...years].filter((year) => year >= currentYear).sort((a, b) => a - b);
}

function buildMonthlyProjectionInputs({
  incomeStreams = [],
  budgetRows = [],
  projectionAdjustments = {},
  month,
}) {
  const income = incomeStreams
    .filter((stream) => (stream.months || budgetMonths).includes(month))
    .reduce((sum, stream) => sum + parseMoney(stream.amount), 0);
  const budget = budgetRows
    .filter((row) => (row.months || budgetMonths).includes(month))
    .reduce((sum, row) => sum + Number(row.budget || 0), 0);
  const profit = income - budget;
  const adjustment = parseMoney(projectionAdjustments?.[month]);

  return {
    income,
    budget,
    profit,
    adjustment,
    delta: profit + adjustment,
  };
}

export function buildProjectedTrueCashSeries({
  targetYear,
  incomeStreams = [],
  budgetRows = [],
  projectionAdjustments = {},
  startingMonth = getCurrentBudgetPeriod().month,
  startingTrueCash = 0,
}) {
  const startMonthIndex = Math.max(0, budgetMonths.indexOf(startingMonth || getCurrentBudgetPeriod().month));
  let runningBalance = Number(startingTrueCash) || 0;

  return budgetMonths.map((month, monthIndex) => {
    if (monthIndex < startMonthIndex) {
      return {
        month,
        year: targetYear,
        value: null,
        profit: null,
        adjustment: null,
      };
    }

    const { profit, adjustment, delta } = buildMonthlyProjectionInputs({
      incomeStreams,
      budgetRows,
      projectionAdjustments,
      month,
    });
    runningBalance += delta;

    return {
      month,
      year: targetYear,
      value: runningBalance,
      profit,
      adjustment,
    };
  });
}

export function buildReconciledTrueCashSeries({
  targetYear,
  incomeStreams = [],
  budgetRows = [],
  projectionAdjustments = {},
  startingMonth = getCurrentBudgetPeriod().month,
  startingTrueCash = 0,
  liveCurrentTrueCash = 0,
  currentMonthIndex = getCurrentBudgetPeriod().monthIndex,
  currentYear = getCurrentBudgetPeriod().year,
}) {
  const baseSeries = buildProjectedTrueCashSeries({
    targetYear,
    incomeStreams,
    budgetRows,
    projectionAdjustments: {},
    startingMonth,
    startingTrueCash,
  });
  const anchorMonthIndex = Math.max(
    0,
    budgetMonths.indexOf(startingMonth || getCurrentBudgetPeriod().month)
  );
  const currentBaseValue =
    baseSeries[currentMonthIndex]?.value ?? (Number(startingTrueCash) || 0);
  const currentYearResidual =
    targetYear === currentYear ? Number(liveCurrentTrueCash) - currentBaseValue : 0;

  return baseSeries.map((entry, index) => {
    if (entry.value === null) return entry;
    if (targetYear === currentYear && index > currentMonthIndex) {
      return { ...entry, value: null };
    }

    const progress =
      targetYear === currentYear && currentMonthIndex > anchorMonthIndex
        ? Math.max(0, (index - anchorMonthIndex) / (currentMonthIndex - anchorMonthIndex))
        : targetYear === currentYear && index >= anchorMonthIndex
          ? 1
          : 0;
    const reconciledValue =
      targetYear === currentYear ? entry.value + currentYearResidual * progress : entry.value;
    const adjustment = parseMoney(projectionAdjustments[entry.month]);

    return {
      ...entry,
      adjustment,
      value: reconciledValue + adjustment,
    };
  });
}

export function buildFullYearProjectionSeries({
  targetYear,
  plansByYear = {},
  fallbackPlanData = {},
}) {
  const currentYear = getCurrentBudgetPeriod().year;
  const targetPlan =
    targetYear === currentYear
      ? buildPlanYearData(fallbackPlanData)
      : ensurePlanYearData(plansByYear, targetYear, fallbackPlanData)[String(targetYear)] ||
        buildPlanYearData(fallbackPlanData);

  return buildProjectedTrueCashSeries({
    targetYear,
    incomeStreams: targetPlan.incomeStreams,
    budgetRows: targetPlan.budgetRows,
    projectionAdjustments: targetPlan.projectionAdjustments,
    startingMonth: getCurrentBudgetPeriod().month,
    startingTrueCash: targetPlan.startingTrueCash,
  }).map(({ month, year, value }) => ({
    month,
    year,
    value,
  }));
}
