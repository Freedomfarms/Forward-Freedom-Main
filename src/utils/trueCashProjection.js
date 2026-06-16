import { budgetMonthNames, budgetMonths } from "../data/constants.jsx";
import { getCurrentBudgetPeriod } from "./date.js";
import { money, parseMoney, wholeDollars } from "./format.js";
import { buildProjectedTrueCashSeries } from "./planning.js";

const FALLBACK_OPEN_YEAR = 2026;

const monthNameToBudgetMonth = Object.fromEntries(
  budgetMonths.map((month) => [budgetMonthNames[month], month])
);

export function parseChartDate(date) {
  const match = /^([A-Za-z]+)\s+\d{1,2},\s+(\d{4})$/.exec(date || "");
  if (!match) {
    return { year: FALLBACK_OPEN_YEAR };
  }

  const [, monthName, year] = match;
  return {
    month: monthNameToBudgetMonth[monthName],
    year: Number(year) || FALLBACK_OPEN_YEAR,
  };
}

export function buildSyncedTrueCashChart(baseChart, trueCash, valueToChartY) {
  const numericValues = baseChart.values.map((value) => parseMoney(value));
  const lastMockValue = numericValues[numericValues.length - 1] || trueCash;
  const offset = trueCash - lastMockValue;
  const adjustedValues = numericValues.map((value) => value + offset);
  const firstValue = adjustedValues[0] || trueCash;
  const change = trueCash - firstValue;
  const percentChange = firstValue ? (change / firstValue) * 100 : 0;

  return {
    ...baseChart,
    value: money(trueCash),
    change: `${change >= 0 ? "+" : "-"}${money(Math.abs(change))} (${percentChange.toFixed(2)}%)`,
    points: valueToChartY
      ? baseChart.points.map((point, index) => [
          point[0],
          valueToChartY(adjustedValues[index] ?? trueCash),
        ])
      : baseChart.points,
    values: adjustedValues.map((value) => money(value)),
  };
}

export function buildTrueCashProjectionSchedule({
  chart,
  incomeStreams,
  budgetRows,
  startingMonth = budgetMonths[0],
  startingTrueCash,
}) {
  if (!chart.supportsProjection) return [];

  const { year: projectionYear } = parseChartDate(chart.date);
  const openingBalance =
    typeof startingTrueCash === "number" || typeof startingTrueCash === "string"
      ? Number(startingTrueCash) || 0
      : parseMoney(chart.values[0] || chart.value);

  return buildProjectedTrueCashSeries({
    targetYear: projectionYear,
    incomeStreams,
    budgetRows,
    startingMonth,
    startingTrueCash: openingBalance,
  })
    .filter((point) => point.value !== null)
    .map((point) => ({
      month: point.month,
      year: point.year,
      date: `${point.month} ${point.year} Projection`,
      value: point.value,
      formattedValue: wholeDollars(point.value),
      profit: point.profit,
      type: "projected",
    }));
}

export function buildForwardTrueCashProjection({
  openingBalance,
  incomeStreams,
  budgetRows,
  startMonth = getCurrentBudgetPeriod().month,
  startYear = getCurrentBudgetPeriod().year,
}) {
  const startMonthIndex = budgetMonths.indexOf(startMonth);
  const projectionMonths =
    startMonthIndex >= 0 ? budgetMonths.slice(startMonthIndex + 1) : budgetMonths;
  let projectedValue = Number(openingBalance) || 0;

  return projectionMonths.map((month) => {
    const activeStreams = incomeStreams.filter((stream) =>
      (stream.months || budgetMonths).includes(month)
    );
    const income = activeStreams.reduce((sum, stream) => sum + parseMoney(stream.amount), 0);
    const budget = budgetRows
      .filter((category) => (category.months || budgetMonths).includes(month))
      .reduce((sum, category) => sum + Number(category.budget || 0), 0);
    const profit = income - budget;
    projectedValue += profit;

    return {
      month,
      year: startYear,
      date: `${month} ${startYear} Projection`,
      value: projectedValue,
      formattedValue: wholeDollars(projectedValue),
      profit,
      type: "projected",
    };
  });
}
