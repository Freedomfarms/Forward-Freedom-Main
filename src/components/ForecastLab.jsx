import { useState } from "react";
import {
  LEGACY_UNCATEGORIZED_CATEGORIES,
  UNCATEGORIZED_CATEGORY,
  budgetMonths,
  isUncategorizedCategoryName,
} from "../data/constants.jsx";
import { parseBudgetReviewDate } from "../utils/budgetReview.js";
import { sumSpendTransactions } from "../utils/transactions.js";
import { getCurrentBudgetPeriod, getBudgetPeriodAtOffset } from "../utils/date.js";
import { buildAreaPath, buildLinePath, wholeDollars } from "../utils/format.js";
import { styles } from "../styles.js";
import { HouseholdProfilesControl } from "./Common.jsx";

const CHART_W = 940;
const CHART_H = 300;
const CATEGORY_COLORS = [
  "#00d8ff",
  "#00f59b",
  "#ffb65d",
  "#8b5cf6",
  "#ff7a45",
  "#f97316",
  "#38bdf8",
  "#ec4899",
  "#22c55e",
  "#94a3b8",
];
const CHART_PADDING_LEFT = 56;
const CHART_PADDING_RIGHT = 24;
const MONTH_SPACING =
  (CHART_W - CHART_PADDING_LEFT - CHART_PADDING_RIGHT) / (budgetMonths.length - 1);
const BAR_WIDTH = MONTH_SPACING * 0.58;
const MONTH_X = Object.fromEntries(
  budgetMonths.map((month, index) => [month, CHART_PADDING_LEFT + index * MONTH_SPACING])
);

function sumSpending(transactions) {
  return sumSpendTransactions(transactions);
}

function buildChartRange(values) {
  const highestValue = Math.max(...values, 1);
  const paddedMaximum = highestValue < 250 ? 250 : Math.ceil((highestValue * 1.18) / 250) * 250;
  return {
    max: paddedMaximum,
    min: 0,
  };
}

function toY(value, max, min) {
  const range = Math.max(max - min, 1);
  return Math.max(0, Math.min(CHART_H, CHART_H - ((value - min) / range) * CHART_H));
}

function buildYLabels(max, min, count = 5) {
  return Array.from({ length: count }, (_, index) => {
    const value = max - ((max - min) / (count - 1)) * index;
    return wholeDollars(value);
  });
}

function getLatestMonthWithSpend(monthlySeries, fallbackMonth) {
  return [...monthlySeries].reverse().find((row) => row.spent > 0)?.month || fallbackMonth;
}

function buildHistorical12MonthAverage({
  spendingTransactions,
  category,
  budgetCategoryDefinitions,
  endYear,
  endMonthIndex,
}) {
  const endDate = new Date(endYear, endMonthIndex, 1);
  const trailingPeriods = Array.from({ length: 12 }, (_, index) =>
    getBudgetPeriodAtOffset(index - 11, endDate)
  );
  const trailingSpend = trailingPeriods.reduce((sum, period) => {
    return (
      sum +
      sumSpending(
        spendingTransactions.filter(
          (transaction) =>
            transaction.parsed.year === period.year &&
            transaction.parsed.month === period.month &&
            matchesCategory(transaction, category, budgetCategoryDefinitions)
        )
      )
    );
  }, 0);

  return trailingSpend / 12;
}

function buildCategoryDefinitions(budgetRows, spendingTransactions) {
  const primaryBudgetCategories = budgetRows
    .filter((row) => !isUncategorizedCategoryName(row.name))
    .map((row, index) => ({
      id: `budget:${row.id || row.name}`,
      name: row.name,
      type: "budget",
      color: row.color || CATEGORY_COLORS[index % CATEGORY_COLORS.length],
      matcherSet: new Set([row.name, ...(row.transactionCategories || [])].filter(Boolean)),
      budgetRow: row,
      description: "Budget-aligned category",
    }));

  const otherBudgetRow = budgetRows.find((row) => isUncategorizedCategoryName(row.name));
  const matchedBudgetCategories = new Set(
    primaryBudgetCategories.flatMap((definition) => Array.from(definition.matcherSet))
  );
  if (otherBudgetRow) {
    matchedBudgetCategories.add(UNCATEGORIZED_CATEGORY);
    LEGACY_UNCATEGORIZED_CATEGORIES.forEach((category) => matchedBudgetCategories.add(category));
  }

  const extraCategories = Array.from(
    new Set(spendingTransactions.map((transaction) => transaction.category).filter(Boolean))
  )
    .filter((category) => !matchedBudgetCategories.has(category))
    .sort((left, right) => left.localeCompare(right))
    .map((category, index) => ({
      id: `transaction:${category}`,
      name: category,
      type: "transaction",
      color:
        CATEGORY_COLORS[(primaryBudgetCategories.length + index + 2) % CATEGORY_COLORS.length],
      matcherSet: null,
      budgetRow: null,
      description: "Live transaction category",
    }));

  return [
    {
      id: "all-spending",
      name: "All Spending",
      type: "all",
      color: "#00d8ff",
      matcherSet: null,
      budgetRow: null,
      description: "Every outgoing transaction",
    },
    ...primaryBudgetCategories,
    ...(otherBudgetRow
      ? [
          {
            id: `budget:${otherBudgetRow.id || "other"}`,
            name: otherBudgetRow.name,
            type: "budget-other",
            color: otherBudgetRow.color || "#94a3b8",
            matcherSet: null,
            budgetRow: otherBudgetRow,
            description: "Unmapped spending",
          },
        ]
      : []),
    ...extraCategories,
  ];
}

function matchesCategory(transaction, definition, budgetDefinitions) {
  if (!transaction || (Number(transaction.amount) || 0) >= 0) return false;

  const category = transaction.category || UNCATEGORIZED_CATEGORY;
  if (definition.type === "all") return true;
  if (definition.type === "budget") return definition.matcherSet.has(category);
  if (definition.type === "budget-other") {
    return !budgetDefinitions.some((budgetDefinition) => budgetDefinition.matcherSet.has(category));
  }

  return category === definition.name;
}

function getBudgetForMonth(definition, budgetRows, month) {
  if (definition.type === "transaction") return null;

  if (definition.type === "all") {
    return budgetRows
      .filter((row) => (row.months || budgetMonths).includes(month))
      .reduce((sum, row) => sum + Number(row.budget || 0), 0);
  }

  if (!definition.budgetRow) return null;

  return (definition.budgetRow.months || budgetMonths).includes(month)
    ? Number(definition.budgetRow.budget || 0)
    : null;
}

export function ForecastLab({ transactions, budgetRows, householdProfilesProps }) {
  const currentBudgetPeriod = getCurrentBudgetPeriod();
  const spendingTransactions = transactions
    .map((transaction) => {
      const parsed = parseBudgetReviewDate(transaction?.date);
      const amount = Number(transaction?.amount) || 0;
      if (!parsed || amount >= 0) return null;

      return {
        ...transaction,
        amount,
        parsed,
      };
    })
    .filter(Boolean);

  const availableYears = Array.from(
    new Set(spendingTransactions.map((transaction) => transaction.parsed.year))
  ).sort((left, right) => right - left);
  if (availableYears.length === 0) {
    availableYears.push(currentBudgetPeriod.year);
  }

  const categoryDefinitions = buildCategoryDefinitions(budgetRows, spendingTransactions);
  const budgetCategoryDefinitions = categoryDefinitions.filter((definition) => definition.type === "budget");

  const [activeYear, setActiveYear] = useState(availableYears[0]);
  const [activeCategoryId, setActiveCategoryId] = useState("all-spending");
  const [focusMonth, setFocusMonth] = useState(currentBudgetPeriod.month);
  const [monthlySpendChartType, setMonthlySpendChartType] = useState("line");

  const selectedYear = availableYears.includes(activeYear) ? activeYear : availableYears[0];
  const selectedCategory =
    categoryDefinitions.find((definition) => definition.id === activeCategoryId) ||
    categoryDefinitions[0];
  const spendingForYear = spendingTransactions.filter(
    (transaction) => transaction.parsed.year === selectedYear
  );
  const selectedTransactions = spendingForYear.filter((transaction) =>
    matchesCategory(transaction, selectedCategory, budgetCategoryDefinitions)
  );
  const totalSpendForYear = sumSpending(spendingForYear);
  const selectedTotalSpend = sumSpending(selectedTransactions);
  const latestTrackedMonthIndex = spendingForYear.reduce((highestIndex, transaction) => {
    return Math.max(highestIndex, budgetMonths.indexOf(transaction.parsed.month));
  }, -1);
  const reviewedMonthCount =
    selectedYear < currentBudgetPeriod.year
      ? Math.max(latestTrackedMonthIndex + 1, 1)
      : Math.max(currentBudgetPeriod.monthIndex + 1, latestTrackedMonthIndex + 1, 1);
  const historicalAverageEndMonthIndex =
    selectedYear < currentBudgetPeriod.year
      ? 11
      : selectedYear === currentBudgetPeriod.year
        ? currentBudgetPeriod.monthIndex
        : 11;
  const averageMonthlySpend = buildHistorical12MonthAverage({
    spendingTransactions,
    category: selectedCategory,
    budgetCategoryDefinitions,
    endYear: selectedYear,
    endMonthIndex: historicalAverageEndMonthIndex,
  });
  const monthlyBudgets = budgetMonths.map((month) => getBudgetForMonth(selectedCategory, budgetRows, month));
  const hasBudgetContext = monthlyBudgets.some((value) => value !== null);
  const budgetInReviewPeriod = hasBudgetContext
    ? monthlyBudgets.slice(0, reviewedMonthCount).reduce((sum, value) => sum + (value || 0), 0)
    : null;
  const monthlySeries = budgetMonths.map((month, index) => {
    const monthTransactions = selectedTransactions
      .filter((transaction) => transaction.parsed.month === month)
      .sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime());
    const spent = sumSpending(monthTransactions);
    const budget = monthlyBudgets[index];

    return {
      month,
      spent,
      budget,
      transactionCount: monthTransactions.length,
      transactions: monthTransactions,
      deltaFromAverage: spent - averageMonthlySpend,
      deltaFromBudget: budget == null ? null : spent - budget,
    };
  });

  const fallbackFocusMonth =
    selectedYear === currentBudgetPeriod.year ? currentBudgetPeriod.month : budgetMonths[0];
  const latestMonthWithSpend = getLatestMonthWithSpend(monthlySeries, fallbackFocusMonth);
  const selectedFocusMonth = budgetMonths.includes(focusMonth) ? focusMonth : latestMonthWithSpend;
  const focusMonthData =
    monthlySeries.find((row) => row.month === selectedFocusMonth) ||
    monthlySeries.find((row) => row.month === latestMonthWithSpend) ||
    monthlySeries[0];
  const peakMonth = monthlySeries.reduce(
    (highestRow, row) => (row.spent > highestRow.spent ? row : highestRow),
    monthlySeries[0] || {
      month: budgetMonths[0],
      spent: 0,
      budget: null,
      transactionCount: 0,
      transactions: [],
      deltaFromAverage: 0,
      deltaFromBudget: null,
    }
  );
  const focusBudgetDelta = focusMonthData?.deltaFromBudget;
  const categoryShare = totalSpendForYear > 0 ? (selectedTotalSpend / totalSpendForYear) * 100 : 0;
  const getFocusMonthForCategory = (definition, year = selectedYear) => {
    const monthlySpendForCategory = budgetMonths.map((month) => ({
      month,
      spent: sumSpending(
        spendingTransactions.filter(
          (transaction) =>
            transaction.parsed.year === year &&
            transaction.parsed.month === month &&
            matchesCategory(transaction, definition, budgetCategoryDefinitions)
        )
      ),
    }));

    return getLatestMonthWithSpend(
      monthlySpendForCategory,
      year === currentBudgetPeriod.year ? currentBudgetPeriod.month : budgetMonths[0]
    );
  };
  const topMerchants = Object.values(
    selectedTransactions.reduce((merchantMap, transaction) => {
      const key = transaction.merchant || "Unknown Merchant";
      const current = merchantMap[key] || {
        merchant: key,
        total: 0,
        count: 0,
      };
      current.total += Math.abs(Number(transaction.amount) || 0);
      current.count += 1;
      merchantMap[key] = current;
      return merchantMap;
    }, {})
  )
    .sort((left, right) => right.total - left.total)
    .slice(0, 5);
  const categoryCards = categoryDefinitions
    .map((definition) => {
      const total = sumSpending(
        spendingForYear.filter((transaction) =>
          matchesCategory(transaction, definition, budgetCategoryDefinitions)
        )
      );
      return {
        ...definition,
        total,
        share: totalSpendForYear > 0 ? (total / totalSpendForYear) * 100 : 0,
      };
    })
    .sort((left, right) => {
      if (left.id === "all-spending") return -1;
      if (right.id === "all-spending") return 1;
      return right.total - left.total;
    });
  const chartValues = [
    ...monthlySeries.map((row) => row.spent),
    ...monthlySeries.map((row) => row.budget).filter((value) => value !== null),
    averageMonthlySpend,
  ];
  const { max, min } = buildChartRange(chartValues);
  const yLabels = buildYLabels(max, min);
  const spendPoints = monthlySeries.map((row) => [MONTH_X[row.month], toY(row.spent, max, min)]);
  const budgetPoints = monthlySeries
    .filter((row) => row.budget !== null)
    .map((row) => [MONTH_X[row.month], toY(row.budget, max, min)]);
  const spendPath = spendPoints.length > 1 ? buildLinePath(spendPoints) : "";
  const spendArea = spendPoints.length > 1 ? buildAreaPath(spendPoints) : "";
  const budgetPath = budgetPoints.length > 1 ? buildLinePath(budgetPoints) : "";
  const averageY = toY(averageMonthlySpend, max, min);
  const focusX = focusMonthData ? MONTH_X[focusMonthData.month] : null;

  const fieldStyle = {
    color: "#eaf3ff",
    background: "rgba(0,136,255,.08)",
    border: "1px solid rgba(0,216,255,.18)",
    borderRadius: 10,
    padding: "10px 12px",
    outline: "none",
    fontWeight: 800,
    colorScheme: "dark",
    width: "100%",
  };

  return (
    <div>
      <header style={styles.pageHeader}>
        <div>
          <h1 style={styles.pageTitle}>Spending Intelligence</h1>
          <p style={styles.pageSubtitle}>
            Review every category with a crisp monthly lens, average spend signal, and live
            transaction detail.
          </p>
        </div>
        <HouseholdProfilesControl {...householdProfilesProps} />
      </header>

      <div
        style={{
          ...styles.panel,
          padding: "14px 18px",
          marginBottom: 14,
          background:
            "linear-gradient(135deg, rgba(4,18,34,.96), rgba(3,17,32,.9) 52%, rgba(2,10,22,.96))",
          border: "1px solid rgba(0,216,255,.24)",
          boxShadow: "inset 0 0 40px rgba(0,136,255,.07), 0 0 24px rgba(0,80,180,.1)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 20,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <div>
            <div
              style={{
                color: "#8feaff",
                textTransform: "uppercase",
                letterSpacing: 1.4,
                fontSize: 12,
                fontWeight: 900,
              }}
            >
              Spending Command Surface
            </div>
            <div style={{ color: "white", fontSize: 22, fontWeight: 900, marginTop: 2 }}>
              {selectedCategory.name}
            </div>
            <div
              style={{
                color: "#9fb0c9",
                marginTop: 4,
                lineHeight: 1.4,
                fontSize: 13,
              }}
            >
              {selectedCategory.description} — drill in to review pacing, budget pressure, and top
              merchants.
            </div>
          </div>
          <div
            style={{
              minWidth: 180,
              display: "grid",
              gap: 8,
              justifyItems: "end",
            }}
          >
            <label style={{ display: "grid", gap: 7, width: "100%", maxWidth: 190 }}>
              <span
                style={{
                  color: "#8fb1d9",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                  fontWeight: 900,
                }}
              >
                Review Year
              </span>
              <select
                value={selectedYear}
                onChange={(event) => {
                  const nextYear = Number(event.target.value);
                  setActiveYear(nextYear);
                  setFocusMonth(getFocusMonthForCategory(selectedCategory, nextYear));
                }}
                style={fieldStyle}
              >
                {availableYears.map((year) => (
                  <option key={year} value={year} style={{ background: "#061224", color: "#eaf3ff" }}>
                    {year}
                  </option>
                ))}
              </select>
            </label>
            <div
              style={{
                color: "#8feaff",
                fontSize: 12,
                fontWeight: 800,
              }}
            >
              {categoryShare.toFixed(1)}% of {selectedYear} spend
            </div>
          </div>
        </div>
      </div>

      {spendingTransactions.length === 0 ? (
        <div style={{ ...styles.panel, padding: 30 }}>
          <div style={{ color: "white", fontSize: 24, fontWeight: 800, marginBottom: 12 }}>
            No spending data yet
          </div>
          <div style={{ color: "#9fb0c9", lineHeight: 1.7, maxWidth: 780 }}>
            Connect Plaid or add manual transactions to unlock Spending Intelligence. Once spending
            data starts flowing, this workspace will track category trends, monthly averages, and
            merchant-level detail automatically.
          </div>
        </div>
      ) : (
        <div
          className="forecast-layout"
          style={{
            display: "grid",
            gridTemplateColumns: "320px minmax(0, 1fr)",
            gap: 20,
            alignItems: "start",
          }}
        >
          <aside className="forecast-sidebar" style={{ display: "grid", gap: 18 }}>
            <div style={{ ...styles.panel, padding: 20 }}>
              <div
                style={{
                  color: "#8feaff",
                  textTransform: "uppercase",
                  letterSpacing: 1.1,
                  fontSize: 12,
                  fontWeight: 900,
                }}
              >
                Spend Snapshot
              </div>
              <div
                className="responsive-grid-2"
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: 12,
                  marginTop: 16,
                }}
              >
                {[
                  ["Year Total", wholeDollars(totalSpendForYear), "#00d8ff"],
                  ["Tracked Categories", `${categoryCards.length - 1}`, "#8feaff"],
                  ["12-Mo Avg", wholeDollars(averageMonthlySpend), "#00f59b"],
                  ["Peak Month", `${peakMonth.month} ${wholeDollars(peakMonth.spent)}`, "#ffb65d"],
                ].map(([label, value, color]) => (
                  <div
                    key={label}
                    style={{
                      borderRadius: 14,
                      border: "1px solid rgba(0,136,255,.2)",
                      background: "rgba(3,17,32,.68)",
                      padding: 14,
                    }}
                  >
                    <div
                      style={{
                        color: "#7ea6d8",
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: 0.8,
                      }}
                    >
                      {label}
                    </div>
                    <div style={{ color, fontWeight: 900, fontSize: 18, marginTop: 8 }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ ...styles.panel, padding: 16 }}>
              <div
                style={{
                  color: "white",
                  fontSize: 16,
                  fontWeight: 900,
                  marginBottom: 12,
                }}
              >
                Category Radar
              </div>
              <div className="forecast-category-radar" style={{ display: "grid", gap: 10, maxHeight: "68vh", overflowY: "auto" }}>
                {categoryCards.map((category) => {
                  const isActive = category.id === selectedCategory.id;
                  return (
                    <button
                      key={category.id}
                      type="button"
                      onClick={() => {
                        setActiveCategoryId(category.id);
                        setFocusMonth(getFocusMonthForCategory(category, selectedYear));
                      }}
                      style={{
                        border: isActive
                          ? `1px solid ${category.color}`
                          : "1px solid rgba(0,216,255,.14)",
                        background: isActive ? "rgba(0,136,255,.16)" : "rgba(2,12,24,.72)",
                        borderRadius: 14,
                        padding: "14px 14px 12px",
                        textAlign: "left",
                        cursor: "pointer",
                        boxShadow: isActive ? `0 0 18px ${category.color}33` : "none",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                        <div>
                          <div
                            style={{
                              color: isActive ? "white" : "#d7ebff",
                              fontWeight: 800,
                              fontSize: 14,
                            }}
                          >
                            {category.name}
                          </div>
                          <div style={{ color: "#7ea6d8", fontSize: 12, marginTop: 5 }}>
                            {category.description}
                          </div>
                        </div>
                        <div
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: 999,
                            background: category.color,
                            boxShadow: `0 0 16px ${category.color}`,
                            marginTop: 4,
                            flexShrink: 0,
                          }}
                        />
                      </div>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "baseline",
                          gap: 10,
                          marginTop: 14,
                        }}
                      >
                        <div style={{ color: category.color, fontWeight: 900, fontSize: 18 }}>
                          {wholeDollars(category.total)}
                        </div>
                        <div style={{ color: "#9fb0c9", fontSize: 12 }}>
                          {category.share.toFixed(1)}% share
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>

          <div style={{ display: "grid", gap: 20 }}>
            <div
              className="responsive-grid-4 forecast-metric-grid"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                gap: 16,
              }}
            >
              {[
                ["Annual Spend", wholeDollars(selectedTotalSpend), selectedCategory.color],
                ["Average / Month", wholeDollars(averageMonthlySpend), "#8feaff"],
                [
                  "Peak Month",
                  `${peakMonth.month} ${wholeDollars(peakMonth.spent)}`,
                  peakMonth.spent >= averageMonthlySpend ? "#ffb65d" : "#00f59b",
                ],
                [
                  focusMonthData ? `${focusMonthData.month} Review` : "Focused Month",
                  focusMonthData ? wholeDollars(focusMonthData.spent) : wholeDollars(0),
                  focusMonthData?.spent >= averageMonthlySpend ? "#ff7a45" : "#00f59b",
                ],
              ].map(([label, value, color]) => (
                <div
                  key={label}
                  style={{
                    ...styles.panel,
                    padding: 18,
                    border: "1px solid rgba(0,216,255,.18)",
                  }}
                >
                  <div
                    style={{
                      color: "#7ea6d8",
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: 0.8,
                    }}
                  >
                    {label}
                  </div>
                  <div style={{ color, fontWeight: 900, fontSize: 24, marginTop: 10 }}>{value}</div>
                  {label === "Annual Spend" ? (
                    <div style={{ color: "#9fb0c9", fontSize: 12, marginTop: 8 }}>
                      {selectedTransactions.length} reviewed transactions in {selectedYear}
                    </div>
                  ) : label === "Average / Month" ? (
                    <div style={{ color: "#9fb0c9", fontSize: 12, marginTop: 8 }}>
                      Rolling 12-month historical average
                    </div>
                  ) : label === "Peak Month" ? (
                    <div style={{ color: "#9fb0c9", fontSize: 12, marginTop: 8 }}>
                      Highest spend concentration in the selected year
                    </div>
                  ) : (
                    <div style={{ color: "#9fb0c9", fontSize: 12, marginTop: 8 }}>
                      {focusMonthData?.transactionCount || 0} transactions in focus
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="forecast-chart-panel" style={{ ...styles.panel, padding: "24px 24px 0" }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)",
                  alignItems: "center",
                  gap: 18,
                  marginBottom: 18,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 14,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ color: "white", fontSize: 22, fontWeight: 900 }}>
                      Monthly Spend Pattern
                    </div>
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: 3,
                        borderRadius: 8,
                        border: "1px solid rgba(0,136,255,.22)",
                        background: "rgba(0,136,255,.06)",
                      }}
                    >
                      {[
                        ["line", "Line"],
                        ["bar", "Bar"],
                      ].map(([type, label]) => {
                        const isActive = monthlySpendChartType === type;
                        return (
                          <button
                            key={type}
                            type="button"
                            onClick={() => setMonthlySpendChartType(type)}
                            style={{
                              color: isActive ? "#00d8ff" : "#9fb0c9",
                              border: isActive
                                ? "1px solid rgba(0,136,255,.55)"
                                : "1px solid transparent",
                              background: isActive ? "rgba(0,104,255,.18)" : "transparent",
                              borderRadius: 6,
                              padding: "6px 12px",
                              cursor: "pointer",
                              fontSize: 12,
                              fontWeight: 800,
                              letterSpacing: 0.4,
                              boxShadow: isActive ? "0 0 14px rgba(0,136,255,.18)" : "none",
                            }}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div style={{ color: "#9fb0c9", marginTop: 6, lineHeight: 1.5 }}>
                    Track live spend against the 12-month average
                    {hasBudgetContext ? " and your budget target." : "."}
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 10,
                    padding: "0 12px",
                    textAlign: "center",
                  }}
                >
                  <div
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 999,
                      background: selectedCategory.color,
                      flexShrink: 0,
                    }}
                  />
                  <div
                    style={{
                      color: "#eaf3ff",
                      fontSize: 16,
                      fontWeight: 900,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {selectedCategory.name}
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-end",
                    gap: 18,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#9fb0c9" }}>
                    <div
                      style={{
                        width: 24,
                        height: 3,
                        borderRadius: 999,
                        background: selectedCategory.color,
                      }}
                    />
                    Spend
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#9fb0c9" }}>
                    <div
                      style={{
                        width: 24,
                        borderTop: "2px dashed rgba(143,234,255,.9)",
                      }}
                    />
                    Average
                  </div>
                  {hasBudgetContext ? (
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 8, color: "#9fb0c9" }}
                    >
                      <div
                        style={{
                          width: 24,
                          borderTop: "2px dashed rgba(255,182,93,.9)",
                        }}
                      />
                      Budget
                    </div>
                  ) : null}
                </div>
              </div>

              <div style={{ display: "flex", gap: 0 }}>
                <div
                  style={{
                    width: 80,
                    flexShrink: 0,
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    paddingBottom: 44,
                    paddingRight: 8,
                  }}
                >
                  {yLabels.map((label) => (
                    <span key={label} style={{ color: "#5e7da0", fontSize: 11, textAlign: "right" }}>
                      {label}
                    </span>
                  ))}
                </div>

                <div className="forecast-chart-frame" style={{ flex: 1, position: "relative" }}>
                  <svg className="forecast-chart-svg" viewBox={`0 0 ${CHART_W} ${CHART_H + 40}`} style={{ width: "100%" }}>
                    <defs>
                      <linearGradient id="spendingAreaGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={selectedCategory.color} stopOpacity="0.28" />
                        <stop offset="100%" stopColor={selectedCategory.color} stopOpacity="0.02" />
                      </linearGradient>
                    </defs>

                    {yLabels.map((_, index) => {
                      const y = (index / (yLabels.length - 1)) * CHART_H;
                      return (
                        <line
                          key={index}
                          x1={0}
                          y1={y}
                          x2={CHART_W}
                          y2={y}
                          stroke="rgba(0,136,255,.1)"
                          strokeWidth={1}
                        />
                      );
                    })}

                    {budgetMonths.map((month) => (
                      <line
                        key={month}
                        x1={MONTH_X[month]}
                        y1={0}
                        x2={MONTH_X[month]}
                        y2={CHART_H}
                        stroke="rgba(0,136,255,.06)"
                        strokeWidth={1}
                      />
                    ))}

                    {monthlySpendChartType === "line" && spendArea ? (
                      <path d={spendArea} fill="url(#spendingAreaGradient)" />
                    ) : null}
                    <line
                      x1={0}
                      y1={averageY}
                      x2={CHART_W}
                      y2={averageY}
                      stroke="rgba(143,234,255,.95)"
                      strokeWidth={1.8}
                      strokeDasharray="6 5"
                    />
                    {hasBudgetContext && budgetPath ? (
                      <path
                        d={budgetPath}
                        fill="none"
                        stroke="#ffb65d"
                        strokeWidth={2}
                        strokeDasharray="7 5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    ) : null}
                    {monthlySpendChartType === "line" && spendPath ? (
                      <path
                        d={spendPath}
                        fill="none"
                        stroke={selectedCategory.color}
                        strokeWidth={3}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    ) : null}
                    {monthlySpendChartType === "bar"
                      ? monthlySeries.map((row) => {
                          const x = MONTH_X[row.month];
                          const y = toY(row.spent, max, min);
                          const height = Math.max(0, CHART_H - y);
                          const isActive = focusMonthData?.month === row.month;
                          return (
                            <rect
                              key={`bar-${row.month}`}
                              x={x - BAR_WIDTH / 2}
                              y={y}
                              width={BAR_WIDTH}
                              height={height}
                              fill={selectedCategory.color}
                              fillOpacity={isActive ? 0.95 : 0.72}
                              stroke={isActive ? "white" : "none"}
                              strokeWidth={isActive ? 1.5 : 0}
                              rx={4}
                              style={{ cursor: "pointer" }}
                              onClick={() => setFocusMonth(row.month)}
                            />
                          );
                        })
                      : null}

                    {focusX != null ? (
                      <line
                        x1={focusX}
                        y1={0}
                        x2={focusX}
                        y2={CHART_H}
                        stroke="rgba(0,216,255,.42)"
                        strokeWidth={1}
                        strokeDasharray="3 4"
                      />
                    ) : null}

                    {monthlySeries.map((row) => {
                      const y = toY(row.spent, max, min);
                      const isActive = focusMonthData?.month === row.month;
                      return (
                        <g key={row.month}>
                          {monthlySpendChartType === "line" ? (
                            <circle
                              cx={MONTH_X[row.month]}
                              cy={y}
                              r={isActive ? 6 : 4.5}
                              fill={selectedCategory.color}
                              stroke="white"
                              strokeWidth={isActive ? 1.8 : 1.3}
                              style={{ cursor: "pointer" }}
                              onClick={() => setFocusMonth(row.month)}
                            />
                          ) : null}
                          <text
                            x={MONTH_X[row.month]}
                            y={CHART_H + 24}
                            textAnchor="middle"
                            style={{
                              fill: isActive ? "#eaf3ff" : "#5e7da0",
                              fontSize: 11,
                              fontWeight: isActive ? 800 : 500,
                              cursor: "pointer",
                            }}
                            onClick={() => setFocusMonth(row.month)}
                          >
                            {row.month}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>
            </div>

            <div
              className="forecast-detail-grid"
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1.15fr) minmax(300px, .85fr)",
                gap: 20,
                alignItems: "start",
              }}
            >
              <div style={{ ...styles.panel, padding: 24 }}>
                <div
                  style={{
                    color: "white",
                    fontSize: 20,
                    fontWeight: 900,
                    marginBottom: 18,
                  }}
                >
                  Monthly Review Grid
                </div>
                <div
                  className="forecast-review-header"
                  style={{
                    display: "grid",
                    gridTemplateColumns: hasBudgetContext ? "90px 1fr 1fr 1fr 1fr" : "90px 1fr 1fr 1fr",
                    padding: "0 14px 12px",
                    color: "#7294bb",
                    fontSize: 12,
                    textTransform: "uppercase",
                    letterSpacing: 0.9,
                    borderBottom: "1px solid rgba(0,136,255,.14)",
                  }}
                >
                  <div>Month</div>
                  <div style={{ textAlign: "right" }}>Spend</div>
                  <div style={{ textAlign: "right" }}>Vs Avg</div>
                  {hasBudgetContext ? <div style={{ textAlign: "right" }}>Vs Budget</div> : null}
                  <div style={{ textAlign: "right" }}>Tx Count</div>
                </div>

                <div style={{ maxHeight: "58vh", overflowY: "auto" }}>
                  {monthlySeries.map((row, index) => {
                    const isFocused = focusMonthData?.month === row.month;
                    const avgColor = row.deltaFromAverage > 0 ? "#ffb65d" : "#00f59b";
                    const budgetColor =
                      row.deltaFromBudget == null
                        ? "#5e7da0"
                        : row.deltaFromBudget > 0
                          ? "#ff5d7a"
                          : "#00f59b";

                    return (
                      <button
                        key={row.month}
                        type="button"
                        className="forecast-review-row"
                        onClick={() => setFocusMonth(row.month)}
                        style={{
                          width: "100%",
                          border: "none",
                          background: isFocused
                            ? "rgba(0,136,255,.09)"
                            : index % 2 === 0
                              ? "rgba(255,255,255,.01)"
                              : "transparent",
                          borderLeft: isFocused
                            ? "2px solid rgba(0,216,255,.5)"
                            : "2px solid transparent",
                          display: "grid",
                          gridTemplateColumns: hasBudgetContext
                            ? "90px 1fr 1fr 1fr 1fr"
                            : "90px 1fr 1fr 1fr",
                          alignItems: "center",
                          padding: "12px 14px",
                          borderBottom: "1px solid rgba(0,136,255,.08)",
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                      >
                        <div style={{ color: "white", fontWeight: 800 }}>{row.month}</div>
                        <div
                          style={{
                            textAlign: "right",
                            color: row.spent > averageMonthlySpend ? "#ffb65d" : "#eaf3ff",
                            fontWeight: 800,
                          }}
                        >
                          {wholeDollars(row.spent)}
                        </div>
                        <div style={{ textAlign: "right", color: avgColor, fontWeight: 700 }}>
                          {row.deltaFromAverage >= 0 ? "+" : ""}
                          {wholeDollars(row.deltaFromAverage)}
                        </div>
                        {hasBudgetContext ? (
                          <div style={{ textAlign: "right", color: budgetColor, fontWeight: 700 }}>
                            {row.deltaFromBudget == null
                              ? "—"
                              : `${row.deltaFromBudget >= 0 ? "+" : ""}${wholeDollars(
                                  row.deltaFromBudget
                                )}`}
                          </div>
                        ) : null}
                        <div style={{ textAlign: "right", color: "#9fb0c9" }}>{row.transactionCount}</div>
                      </button>
                    );
                  })}
                </div>

                <div
                  className="forecast-review-footer"
                  style={{
                    display: "grid",
                    gridTemplateColumns: hasBudgetContext ? "90px 1fr 1fr 1fr 1fr" : "90px 1fr 1fr 1fr",
                    padding: "14px",
                    borderTop: "1px solid rgba(0,136,255,.18)",
                    background: "rgba(0,136,255,.06)",
                  }}
                >
                  <div
                    style={{
                      color: "#8feaff",
                      fontWeight: 900,
                      fontSize: 12,
                      textTransform: "uppercase",
                    }}
                  >
                    Year
                  </div>
                  <div style={{ textAlign: "right", color: selectedCategory.color, fontWeight: 900 }}>
                    {wholeDollars(selectedTotalSpend)}
                  </div>
                  <div style={{ textAlign: "right", color: "#8feaff", fontWeight: 800 }}>
                    Avg {wholeDollars(averageMonthlySpend)} (12-mo)
                  </div>
                  {hasBudgetContext ? (
                    <div
                      style={{
                        textAlign: "right",
                        color:
                          budgetInReviewPeriod != null && selectedTotalSpend <= budgetInReviewPeriod
                            ? "#00f59b"
                            : "#ff5d7a",
                        fontWeight: 800,
                      }}
                    >
                      {budgetInReviewPeriod == null
                        ? "—"
                        : `${selectedTotalSpend - budgetInReviewPeriod >= 0 ? "+" : ""}${wholeDollars(
                            selectedTotalSpend - budgetInReviewPeriod
                          )}`}
                    </div>
                  ) : null}
                  <div style={{ textAlign: "right", color: "#d7ebff", fontWeight: 800 }}>
                    {selectedTransactions.length}
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gap: 20 }}>
                <div style={{ ...styles.panel, padding: 22 }}>
                  <div
                    style={{
                      color: "#8feaff",
                      fontSize: 12,
                      textTransform: "uppercase",
                      letterSpacing: 1,
                      fontWeight: 900,
                    }}
                  >
                    Month Spotlight
                  </div>
                  <div style={{ color: "white", fontSize: 24, fontWeight: 900, marginTop: 8 }}>
                    {focusMonthData?.month} {selectedYear}
                  </div>
                  <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
                    {[
                      ["Spend", wholeDollars(focusMonthData?.spent || 0), selectedCategory.color],
                      [
                        "Vs Average",
                        `${(focusMonthData?.deltaFromAverage || 0) >= 0 ? "+" : ""}${wholeDollars(
                          focusMonthData?.deltaFromAverage || 0
                        )}`,
                        (focusMonthData?.deltaFromAverage || 0) > 0 ? "#ffb65d" : "#00f59b",
                      ],
                      [
                        hasBudgetContext ? "Vs Budget" : "Budget Context",
                        hasBudgetContext
                          ? focusBudgetDelta == null
                            ? "—"
                            : `${focusBudgetDelta >= 0 ? "+" : ""}${wholeDollars(focusBudgetDelta)}`
                          : "Not tracked",
                        !hasBudgetContext
                          ? "#9fb0c9"
                          : (focusBudgetDelta || 0) > 0
                            ? "#ff5d7a"
                            : "#00f59b",
                      ],
                    ].map(([label, value, color]) => (
                      <div
                        key={label}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 14,
                          padding: "12px 14px",
                          borderRadius: 12,
                          border: "1px solid rgba(0,216,255,.14)",
                          background: "rgba(3,17,32,.72)",
                        }}
                      >
                        <span style={{ color: "#9fb0c9" }}>{label}</span>
                        <span style={{ color, fontWeight: 800 }}>{value}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ ...styles.panel, padding: 22 }}>
                  <div style={{ color: "white", fontSize: 18, fontWeight: 900, marginBottom: 14 }}>
                    Top Merchants
                  </div>
                  <div style={{ display: "grid", gap: 10 }}>
                    {topMerchants.length ? (
                      topMerchants.map((merchant) => (
                        <div
                          key={merchant.merchant}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 12,
                            padding: "11px 0",
                            borderBottom: "1px solid rgba(0,136,255,.1)",
                          }}
                        >
                          <div>
                            <div style={{ color: "white", fontWeight: 700 }}>{merchant.merchant}</div>
                            <div style={{ color: "#7ea6d8", fontSize: 12, marginTop: 4 }}>
                              {merchant.count} transaction{merchant.count === 1 ? "" : "s"}
                            </div>
                          </div>
                          <div style={{ color: "#8feaff", fontWeight: 800 }}>
                            {wholeDollars(merchant.total)}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div style={{ color: "#9fb0c9", lineHeight: 1.6 }}>
                        No merchant signal yet for this category in {selectedYear}.
                      </div>
                    )}
                  </div>
                </div>

                <div style={{ ...styles.panel, padding: 22 }}>
                  <div style={{ color: "white", fontSize: 18, fontWeight: 900, marginBottom: 14 }}>
                    Recent {focusMonthData?.month} Activity
                  </div>
                  <div style={{ display: "grid", gap: 10 }}>
                    {focusMonthData?.transactions?.length ? (
                      focusMonthData.transactions.slice(0, 6).map((transaction) => (
                        <div
                          key={transaction.id}
                          style={{
                            borderRadius: 12,
                            border: "1px solid rgba(0,216,255,.14)",
                            background: "rgba(3,17,32,.68)",
                            padding: "12px 14px",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 12,
                              alignItems: "baseline",
                            }}
                          >
                            <div style={{ color: "white", fontWeight: 800 }}>
                              {transaction.merchant || "Spending entry"}
                            </div>
                            <div style={{ color: "#ffb65d", fontWeight: 900 }}>
                              {wholeDollars(Math.abs(transaction.amount))}
                            </div>
                          </div>
                          <div
                            style={{
                              color: "#7ea6d8",
                              fontSize: 12,
                              marginTop: 6,
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 12,
                              flexWrap: "wrap",
                            }}
                          >
                            <span>{transaction.date}</span>
                            <span>{transaction.account}</span>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div style={{ color: "#9fb0c9", lineHeight: 1.6 }}>
                        Nothing posted in {focusMonthData?.month} for this category. Pick another
                        month on the chart or review grid to scan a different slice of spending.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
