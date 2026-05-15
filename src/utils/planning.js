import { getCurrentBudgetPeriod } from "./date.js";

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

export function buildPlanYearData({
  budgetRows = [],
  incomeStreams = [],
  projectionAdjustments = {},
} = {}) {
  return {
    budgetRows: cloneValue(budgetRows),
    incomeStreams: cloneValue(incomeStreams),
    projectionAdjustments: cloneValue(projectionAdjustments),
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

  const availableYears = Object.keys(normalizedPlans)
    .map(Number)
    .filter((year) => Number.isFinite(year))
    .sort((a, b) => a - b);
  const referenceYear =
    availableYears.filter((year) => year < targetYear).at(-1) ??
    availableYears[availableYears.length - 1];
  const referencePlan =
    normalizedPlans[String(referenceYear)] || buildPlanYearData(fallbackPlanData);

  return {
    ...normalizedPlans,
    [targetKey]: buildPlanYearData(referencePlan),
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
