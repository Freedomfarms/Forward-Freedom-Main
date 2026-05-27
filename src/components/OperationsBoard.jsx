import { useState } from "react";
import { styles } from "../styles.js";
import { buildBudgetMonthlySpendSeries, buildMonthlyActualIncomeSeries } from "../utils/budgetReview.js";
import { getCurrentBudgetPeriod } from "../utils/date.js";
import {
  buildAreaPath,
  buildLinePath,
  cleanMoneyInput,
  money,
  parseMoney,
  wholeDollars,
} from "../utils/format.js";
import { budgetMonths, yearlyOpsData } from "../data/constants.jsx";
import { buildProjectedTrueCashSeries, buildReconciledTrueCashSeries } from "../utils/planning.js";
import { buildSubscriptionOverview } from "../utils/subscriptions.js";
import { HouseholdProfilesControl } from "./Common.jsx";

function formatAdjustmentValue(value) {
  return String(Math.round(Number(value) || 0));
}

function normalizeAdjustmentInput(value) {
  const rawValue = String(value);
  const isNegative = rawValue.includes("-");
  const digits = rawValue.replace(/\D/g, "");

  if (!digits) return isNegative ? "-" : "";
  if (isNegative && Number(digits) === 0) return "-";

  return `${isNegative ? "-" : ""}${Number(digits)}`;
}

function getLastNonNullValue(values, fallback = 0) {
  const lastValue = [...values].reverse().find((value) => value !== null && value !== undefined);
  return lastValue ?? fallback;
}

const SCORECARD_CHART_W = 940;
const SCORECARD_CHART_H = 300;
const SCORECARD_MONTH_X = Object.fromEntries(
  budgetMonths.map((month, index) => [
    month,
    24 + index * ((SCORECARD_CHART_W - 48) / (budgetMonths.length - 1)),
  ])
);

function finiteMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function buildScorecardRange(values) {
  const highestValue = Math.max(...values, 1);
  const paddedMaximum = highestValue < 1000 ? 1000 : Math.ceil((highestValue * 1.14) / 500) * 500;
  return {
    max: paddedMaximum,
    min: 0,
  };
}

function scorecardToY(value, max, min) {
  const range = Math.max(max - min, 1);
  return Math.max(0, Math.min(SCORECARD_CHART_H, SCORECARD_CHART_H - ((value - min) / range) * SCORECARD_CHART_H));
}

function buildScorecardYLabels(max, min, count = 5) {
  return Array.from({ length: count }, (_, index) => {
    const value = max - ((max - min) / (count - 1)) * index;
    return wholeDollars(value);
  });
}

export function OperationsBoard({
  subscriptions,
  transactions,
  trueCash,
  householdProfilesProps,
  currentPlanYear,
  availablePlanningYears,
  getBudgetRowsForYear,
  getIncomeStreamsForYear,
  getProjectionAdjustmentsForYear,
  setProjectionAdjustmentsForYear,
  ensurePlanningYear,
  getPlanningAnchorForYear,
  setPlanningAnchorForYear,
}) {
  const [hoveredCommandMonth, setHoveredCommandMonth] = useState(null);
  const currentBudgetPeriod = getCurrentBudgetPeriod();
  const [activePlanningYear, setActivePlanningYear] = useState(currentPlanYear);
  const safeTransactions = Array.isArray(transactions) ? transactions : [];
  const planningBudgetRows = getBudgetRowsForYear(activePlanningYear);
  const planningIncomeStreams = getIncomeStreamsForYear(activePlanningYear);
  const planningProjectionAdjustments = getProjectionAdjustmentsForYear(activePlanningYear);
  const planningAnchor = getPlanningAnchorForYear(activePlanningYear);
  const monthlySpendSeries = buildBudgetMonthlySpendSeries(
    safeTransactions,
    planningBudgetRows,
    activePlanningYear
  );
  const monthlyActualIncomeSeries = buildMonthlyActualIncomeSeries(safeTransactions, activePlanningYear);
  const updatePlanningYear = (value) => {
    const nextValue = Number(value);
    ensurePlanningYear(nextValue);
    setHoveredCommandMonth(null);
    setActivePlanningYear(nextValue);
  };
  const updatePlanningAnchor = (field, value) => {
    if (field !== "startingTrueCash") return;
    setPlanningAnchorForYear(activePlanningYear, {
      startingTrueCash: cleanMoneyInput(value),
    });
  };

  const planConfigured =
    planningIncomeStreams.length > 0 ||
    planningBudgetRows.some((row) => finiteMoney(row.budget) > 0);

  const dynamicYearlyOpsData = yearlyOpsData.map((seedMonth) => {
    const activeStreams = planningIncomeStreams.filter((stream) =>
      (stream.months || budgetMonths).includes(seedMonth.month)
    );
    const plannedFromStreams = activeStreams.reduce((sum, stream) => sum + parseMoney(stream.amount), 0);
    const oneTimeFromStreams = activeStreams
      .filter((stream) => stream.type === "One-Time")
      .reduce((sum, stream) => sum + parseMoney(stream.amount), 0);

    const activeBudgetCategories = planningBudgetRows.filter((category) =>
      (category.months || budgetMonths).includes(seedMonth.month)
    );

    const budgetFromRows = activeBudgetCategories.reduce(
      (sum, category) => sum + finiteMoney(category.budget),
      0
    );

    const spentLive =
      monthlySpendSeries.find((entry) => entry.month === seedMonth.month)?.spent || 0;
    const actualIncome =
      monthlyActualIncomeSeries.find((entry) => entry.month === seedMonth.month)?.actualIncome || 0;

    const plannedIncome = planConfigured
      ? finiteMoney(plannedFromStreams)
      : finiteMoney(seedMonth.income);
    const budget = planConfigured ? finiteMoney(budgetFromRows) : finiteMoney(seedMonth.budget);
    const spent = planConfigured ? finiteMoney(spentLive) : finiteMoney(seedMonth.spent);
    const oneTimeIncome = planConfigured
      ? finiteMoney(oneTimeFromStreams)
      : finiteMoney(seedMonth.oneTimeIncome);
    const recurringIncome = planConfigured
      ? plannedIncome - oneTimeIncome
      : finiteMoney(seedMonth.recurringIncome);

    return {
      ...seedMonth,
      income: plannedIncome,
      plannedIncome,
      actualIncome: finiteMoney(actualIncome),
      budget,
      spent,
      baseBudget: budget,
      profit: plannedIncome - budget,
      recurringIncome,
      oneTimeIncome,
    };
  });

  const yearlyIncome = dynamicYearlyOpsData.reduce((sum, month) => sum + month.income, 0);
  const yearlyBudget = dynamicYearlyOpsData.reduce((sum, month) => sum + month.budget, 0);
  const yearlyActualIncome = dynamicYearlyOpsData.reduce(
    (sum, month) => sum + finiteMoney(month.actualIncome),
    0
  );
  const yearlySpent = dynamicYearlyOpsData.reduce(
    (sum, month) => sum + finiteMoney(month.spent),
    0
  );
  const yearlySurplus = yearlyIncome - yearlyBudget;
  const subscriptionOverview = buildSubscriptionOverview(subscriptions);
  const incomeOutlookRows = planningIncomeStreams.map((stream) => {
    const monthlyValues = budgetMonths.map((month) =>
      (stream.months || budgetMonths).includes(month) ? parseMoney(stream.amount) : 0
    );
    return {
      label: stream.name,
      color: stream.color || "#00f59b",
      values: monthlyValues,
      total: monthlyValues.reduce((sum, value) => sum + value, 0),
    };
  });
  const adjustmentValues = budgetMonths.map((month) =>
    parseMoney(planningProjectionAdjustments[month])
  );
  const anchorStartingMonth = currentBudgetPeriod.month;
  const anchorStartingTrueCash =
    planningAnchor.startingTrueCash !== undefined && planningAnchor.startingTrueCash !== null
      ? Number(planningAnchor.startingTrueCash) || 0
      : trueCash;
  const baseTrueCashSeries = buildProjectedTrueCashSeries({
    targetYear: activePlanningYear,
    incomeStreams: planningIncomeStreams,
    budgetRows: planningBudgetRows,
    projectionAdjustments: {},
    startingMonth: anchorStartingMonth,
    startingTrueCash: anchorStartingTrueCash,
  }).map((entry) => entry.value);
  const trueCashValues = buildReconciledTrueCashSeries({
    targetYear: activePlanningYear,
    incomeStreams: planningIncomeStreams,
    budgetRows: planningBudgetRows,
    projectionAdjustments: planningProjectionAdjustments,
    startingMonth: anchorStartingMonth,
    startingTrueCash: anchorStartingTrueCash,
    liveCurrentTrueCash: trueCash,
    currentMonthIndex: currentBudgetPeriod.monthIndex,
    currentYear: currentBudgetPeriod.year,
  }).map((entry) => entry.value);
  const projectedTrueCashValues = baseTrueCashSeries.map((value) => {
    if (value === null) return null;
    return value;
  });
  const trueCashYearEndValue = getLastNonNullValue(trueCashValues, trueCash);
  const projectedYearEndTrueCash = getLastNonNullValue(projectedTrueCashValues, trueCashYearEndValue);
  const scorecardMonths = dynamicYearlyOpsData.map((month, index) => {
    const plannedIncome = finiteMoney(month.plannedIncome ?? month.income);
    const actualIncome = finiteMoney(month.actualIncome);
    const budget = finiteMoney(month.budget);
    const spent = finiteMoney(month.spent);
    const profit = plannedIncome - budget;
    return {
      month,
      index,
      plannedIncome,
      actualIncome,
      budget,
      spent,
      profit,
      trueCash: trueCashValues[index],
    };
  });
  const scorecardAverageSpent =
    scorecardMonths.reduce((sum, entry) => sum + entry.spent, 0) / Math.max(scorecardMonths.length, 1);
  const scorecardChartValues = [
    ...scorecardMonths.flatMap((entry) => [
      entry.plannedIncome,
      entry.actualIncome,
      entry.budget,
      entry.spent,
    ]),
    scorecardAverageSpent,
  ];
  const { max: scorecardChartMax, min: scorecardChartMin } = buildScorecardRange(scorecardChartValues);
  const scorecardYLabels = buildScorecardYLabels(scorecardChartMax, scorecardChartMin);
  const scorecardPlannedPoints = scorecardMonths.map((entry) => [
    SCORECARD_MONTH_X[entry.month.month],
    scorecardToY(entry.plannedIncome, scorecardChartMax, scorecardChartMin),
  ]);
  const scorecardActualPoints = scorecardMonths.map((entry) => [
    SCORECARD_MONTH_X[entry.month.month],
    scorecardToY(entry.actualIncome, scorecardChartMax, scorecardChartMin),
  ]);
  const scorecardBudgetPoints = scorecardMonths.map((entry) => [
    SCORECARD_MONTH_X[entry.month.month],
    scorecardToY(entry.budget, scorecardChartMax, scorecardChartMin),
  ]);
  const scorecardSpentPoints = scorecardMonths.map((entry) => [
    SCORECARD_MONTH_X[entry.month.month],
    scorecardToY(entry.spent, scorecardChartMax, scorecardChartMin),
  ]);
  const scorecardPlannedPath =
    scorecardPlannedPoints.length > 1 ? buildLinePath(scorecardPlannedPoints) : "";
  const scorecardActualPath =
    scorecardActualPoints.length > 1 ? buildLinePath(scorecardActualPoints) : "";
  const scorecardBudgetPath =
    scorecardBudgetPoints.length > 1 ? buildLinePath(scorecardBudgetPoints) : "";
  const scorecardSpentPath = scorecardSpentPoints.length > 1 ? buildLinePath(scorecardSpentPoints) : "";
  const scorecardSpentArea = scorecardSpentPoints.length > 1 ? buildAreaPath(scorecardSpentPoints) : "";
  const scorecardAverageSpentY = scorecardToY(scorecardAverageSpent, scorecardChartMax, scorecardChartMin);
  const scorecardFocusX = hoveredCommandMonth ? SCORECARD_MONTH_X[hoveredCommandMonth.data.month] : null;

  return (
    <div>
      <header style={styles.pageHeader}>
        <div>
          <h1 style={styles.pageTitle}>Operations Board</h1>
          <p style={styles.pageSubtitle}>
            Yearly command view of income streams, budget plan, and projected profit.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <HouseholdProfilesControl {...householdProfilesProps} />
          <select
            value={activePlanningYear}
            onChange={(event) => updatePlanningYear(event.target.value)}
            style={{
              color: "#00d8ff",
              background: "rgba(0,104,255,.18)",
              border: "1px solid rgba(0,216,255,.55)",
              borderRadius: 7,
              padding: "10px 12px",
              minWidth: 96,
              fontWeight: 900,
              boxShadow: "0 0 18px rgba(0,136,255,.22)",
            }}
          >
            {availablePlanningYears.map((year) => (
              <option key={year} value={year} style={{ background: "#061224", color: "#eaf3ff" }}>
                {year}
              </option>
            ))}
          </select>
        </div>
      </header>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 16,
          marginBottom: 18,
        }}
      >
        {[
          ["Total Income Earned", wholeDollars(yearlyActualIncome), "#00f59b"],
          ["Total Spent", wholeDollars(yearlySpent), "#00d8ff"],
          ["Projected Yearly Profit", wholeDollars(yearlySurplus), yearlySurplus >= 0 ? "#00f59b" : "#ff5d7a"],
          [
            "Recurring Commitments",
            wholeDollars(subscriptionOverview.activeMonthly),
            "#ffb65d",
            `${wholeDollars(subscriptionOverview.yearlyCommitment)} annualized`,
          ],
        ].map((item) => (
          <div key={item[0]} style={{ ...styles.panel, padding: 20 }}>
            <div
              style={{
                color: "#8fb1d9",
                fontSize: 12,
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
            >
              {item[0]}
            </div>
            <div
              style={{
                color: item[2],
                fontSize: 30,
                fontWeight: 900,
                marginTop: 12,
                textShadow: `0 0 18px ${item[2]}55`,
              }}
            >
              {item[1]}
            </div>
            {item[3] ? (
              <div style={{ color: "#8ea8ca", fontSize: 12, marginTop: 10 }}>{item[3]}</div>
            ) : null}
          </div>
        ))}

        <div style={{ ...styles.panel, padding: 20 }}>
          <div
            style={{ color: "#8fb1d9", fontSize: 12, textTransform: "uppercase", letterSpacing: 1 }}
          >
            Planning Anchor
          </div>

          <div
            style={{
              marginTop: 12,
              display: "grid",
              gap: 10,
            }}
          >
            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ color: "#8fb1d9", fontSize: 11, textTransform: "uppercase" }}>
                Starting True Cash
              </span>
              <input
                value={money(planningAnchor.startingTrueCash ?? trueCash)}
                onChange={(event) => updatePlanningAnchor("startingTrueCash", event.target.value)}
                style={{
                  color: "#eaf3ff",
                  background: "rgba(0,136,255,.08)",
                  border: "1px solid rgba(0,216,255,.22)",
                  borderRadius: 9,
                  padding: "10px 12px",
                  fontWeight: 900,
                  outline: "none",
                }}
              />
            </label>
            <div style={{ color: "#8ea8ca", fontSize: 12, lineHeight: 1.5, marginTop: 2 }}>
              Projections use the current calendar month as the anchor (no backdating).
              Enter the true-cash balance that should anchor the plan for this year; Command Center uses
              the same anchor and starting value for its projection line.
            </div>
          </div>
        </div>
      </section>

      <section
        style={{
          ...styles.panel,
          padding: 22,
          marginBottom: 18,
          position: "relative",
          overflow: "visible",
          zIndex: 2,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at top right, rgba(0,216,255,.13), transparent 36%)",
          }}
        />
        <div
          style={{
            position: "relative",
            display: "grid",
            gap: 22,
          }}
        >
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 18,
                flexWrap: "wrap",
                marginBottom: 18,
              }}
            >
              <div>
                <div style={{ color: "white", fontSize: 22, fontWeight: 900 }}>Monthly Scorecard</div>
                <div style={{ color: "#9fb0c9", marginTop: 6, lineHeight: 1.5 }}>
                  Spending Intelligence-style trend surface for plan vs actual execution.
                  {!planConfigured ? (
                    <span style={{ display: "block", marginTop: 8, color: "#94a3b8", fontSize: 13 }}>
                      No plan data set for {activePlanningYear}; sample planned/budget/spent values are
                      shown while actual income remains live from transactions.
                    </span>
                  ) : null}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                {[
                  ["Planned Income", "rgba(0,245,155,.9)", "dashed", "rgba(0,245,155,.24)"],
                  ["Earned Income", "rgba(0,245,155,.9)", "solid", "rgba(0,245,155,.24)"],
                  ["Budget", "rgba(0,216,255,.95)", "dashed", "rgba(0,216,255,.3)"],
                  ["Spent", "rgba(0,216,255,.95)", "solid", "rgba(0,216,255,.3)"],
                  ["Avg Spent", "rgba(143,234,255,.95)", "dashed", "rgba(143,234,255,.2)"],
                ].map(([label, color, type, glow]) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, color: "#9fb0c9" }}>
                    <div
                      style={{
                        width: 24,
                        borderTop: `2px ${type === "dashed" ? "dashed" : "solid"} ${color}`,
                        boxShadow: `0 0 10px ${glow}`,
                      }}
                    />
                    {label}
                  </div>
                ))}
              </div>
            </div>

            <div
              onMouseLeave={() => setHoveredCommandMonth(null)}
              style={{
                position: "relative",
                borderRadius: 14,
                border: "1px solid rgba(0,216,255,.2)",
                background: "rgba(2,16,34,.7)",
                boxShadow: "inset 0 0 28px rgba(0,136,255,.08)",
                padding: "18px 16px 6px",
              }}
            >
              {hoveredCommandMonth ? (
                <div
                  style={{
                    position: "absolute",
                    top: 14,
                    left: `${Math.min(
                      88,
                      Math.max(14, ((hoveredCommandMonth.index + 0.5) / scorecardMonths.length) * 100)
                    )}%`,
                    transform: "translateX(-50%)",
                    zIndex: 6,
                    minWidth: 220,
                    border: "1px solid rgba(0,216,255,.3)",
                    borderRadius: 10,
                    background: "rgba(4,16,31,0.96)",
                    boxShadow: "0 14px 30px rgba(0,0,0,0.45)",
                    padding: "12px 14px",
                    pointerEvents: "none",
                    backdropFilter: "blur(6px)",
                  }}
                >
                  <div
                    style={{
                      color: "#e2f4ff",
                      fontSize: 13,
                      marginBottom: 8,
                      fontWeight: 800,
                      borderBottom: "1px solid rgba(0,216,255,.16)",
                      paddingBottom: 7,
                    }}
                  >
                    {hoveredCommandMonth.data.month}
                  </div>
                  {[
                    [
                      "Planned income",
                      hoveredCommandMonth.data.plannedIncome ?? hoveredCommandMonth.data.income,
                      "#5eead4",
                    ],
                    ["Actual income", hoveredCommandMonth.data.actualIncome, "#00f59b"],
                    ["Budget", hoveredCommandMonth.data.budget, "#fdba74"],
                    ["Spent", hoveredCommandMonth.data.spent, "#ff7a45"],
                    ["True Cash", trueCashValues[hoveredCommandMonth.index], "#38bdf8"],
                    [
                      "Profit",
                      (hoveredCommandMonth.data.plannedIncome ?? hoveredCommandMonth.data.income) -
                        hoveredCommandMonth.data.budget,
                      (hoveredCommandMonth.data.plannedIncome ?? hoveredCommandMonth.data.income) -
                        hoveredCommandMonth.data.budget >=
                      0
                        ? "#4ade80"
                        : "#f87171",
                    ],
                    [
                      "Adjustments",
                      adjustmentValues[hoveredCommandMonth.index],
                      adjustmentValues[hoveredCommandMonth.index] >= 0 ? "#fbbf24" : "#f97316",
                    ],
                    [
                      "Projected Cash",
                      projectedTrueCashValues[hoveredCommandMonth.index],
                      "#fbbf24",
                    ],
                  ].map(([label, value, color]) => (
                    <div
                      key={label}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 16,
                        color: "#cbd5e1",
                        fontSize: 12,
                        fontWeight: 700,
                        marginTop: 6,
                      }}
                    >
                      <span style={{ color: "#8ea8ca" }}>{label}</span>
                      <span style={{ color }}>
                        {(label === "Profit" || label === "Adjustments") && value >= 0 ? "+" : ""}
                        {(label === "Projected Cash" || label === "True Cash") && value === null
                          ? "—"
                          : label === "Adjustments"
                            ? formatAdjustmentValue(value)
                            : label === "Projected Cash" || label === "True Cash"
                              ? wholeDollars(value)
                              : money(value)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 0 }}>
                <div
                  style={{
                    width: 72,
                    flexShrink: 0,
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    paddingBottom: 44,
                  }}
                >
                  {scorecardYLabels.map((label) => (
                    <span key={label} style={{ color: "#5e7da0", fontSize: 11, textAlign: "right" }}>
                      {label}
                    </span>
                  ))}
                </div>

                <div style={{ flex: 1, position: "relative" }}>
                  <svg viewBox={`0 0 ${SCORECARD_CHART_W} ${SCORECARD_CHART_H + 40}`} style={{ width: "100%" }}>
                    <defs>
                      <linearGradient id="opsScorecardAreaGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#00d8ff" stopOpacity="0.4" />
                        <stop offset="100%" stopColor="#00d8ff" stopOpacity="0.06" />
                      </linearGradient>
                    </defs>

                    {scorecardYLabels.map((_, index) => {
                      const y = (index / (scorecardYLabels.length - 1)) * SCORECARD_CHART_H;
                      return (
                        <line
                          key={index}
                          x1={0}
                          y1={y}
                          x2={SCORECARD_CHART_W}
                          y2={y}
                          stroke="rgba(0,136,255,.1)"
                          strokeWidth={1}
                        />
                      );
                    })}

                    {scorecardMonths.map((entry) => (
                      <line
                        key={`v-${entry.month.month}`}
                        x1={SCORECARD_MONTH_X[entry.month.month]}
                        y1={0}
                        x2={SCORECARD_MONTH_X[entry.month.month]}
                        y2={SCORECARD_CHART_H}
                        stroke="rgba(0,136,255,.06)"
                        strokeWidth={1}
                      />
                    ))}

                    {scorecardSpentArea ? (
                      <path d={scorecardSpentArea} fill="url(#opsScorecardAreaGradient)" />
                    ) : null}
                    <line
                      x1={0}
                      y1={scorecardAverageSpentY}
                      x2={SCORECARD_CHART_W}
                      y2={scorecardAverageSpentY}
                      stroke="rgba(143,234,255,.95)"
                      strokeWidth={1.8}
                      strokeDasharray="6 5"
                    />
                    {scorecardBudgetPath ? (
                      <path
                        d={scorecardBudgetPath}
                        fill="none"
                        stroke="#00d8ff"
                        strokeWidth={2}
                        strokeDasharray="7 5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    ) : null}
                    {scorecardActualPath ? (
                      <path
                        d={scorecardActualPath}
                        fill="none"
                        stroke="#00f59b"
                        strokeWidth={2.4}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    ) : null}
                    {scorecardSpentPath ? (
                      <path
                        d={scorecardSpentPath}
                        fill="none"
                        stroke="#00d8ff"
                        strokeWidth={3}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    ) : null}
                    {scorecardPlannedPath ? (
                      <path
                        d={scorecardPlannedPath}
                        fill="none"
                        stroke="#00f59b"
                        strokeWidth={2.2}
                        strokeDasharray="7 5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    ) : null}

                    {scorecardFocusX != null ? (
                      <line
                        x1={scorecardFocusX}
                        y1={0}
                        x2={scorecardFocusX}
                        y2={SCORECARD_CHART_H}
                        stroke="rgba(0,216,255,.42)"
                        strokeWidth={1}
                        strokeDasharray="3 4"
                      />
                    ) : null}

                    {scorecardMonths.map((entry) => {
                      const x = SCORECARD_MONTH_X[entry.month.month];
                      const plannedY = scorecardToY(
                        entry.plannedIncome,
                        scorecardChartMax,
                        scorecardChartMin
                      );
                      const spentY = scorecardToY(entry.spent, scorecardChartMax, scorecardChartMin);
                      const isActive = hoveredCommandMonth?.data?.month === entry.month.month;

                      return (
                        <g key={entry.month.month}>
                          <circle
                            cx={x}
                            cy={plannedY}
                            r={isActive ? 5.4 : 4}
                            fill="#00f59b"
                            stroke="white"
                            strokeWidth={isActive ? 1.8 : 1.3}
                            style={{ cursor: "pointer" }}
                            onMouseEnter={() => setHoveredCommandMonth({ data: entry.month, index: entry.index })}
                          />
                          <circle
                            cx={x}
                            cy={spentY}
                            r={isActive ? 6.2 : 4.8}
                            fill="#00d8ff"
                            stroke="rgba(255,255,255,.9)"
                            strokeWidth={isActive ? 1.6 : 1.2}
                            style={{ cursor: "pointer" }}
                            onMouseEnter={() => setHoveredCommandMonth({ data: entry.month, index: entry.index })}
                          />
                          <text
                            x={x}
                            y={SCORECARD_CHART_H + 24}
                            textAnchor="middle"
                            style={{
                              fill: isActive ? "#eaf3ff" : "#5e7da0",
                              fontSize: 11,
                              fontWeight: isActive ? 800 : 500,
                              cursor: "pointer",
                            }}
                            onMouseEnter={() => setHoveredCommandMonth({ data: entry.month, index: entry.index })}
                          >
                            {entry.month.month}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section style={{ ...styles.panel, padding: 24, marginTop: 8 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 18,
          }}
        >
          <div>
            <div style={{ color: "white", fontSize: 24, fontWeight: 900 }}>Yearly Outlook</div>
            <div style={{ color: "#8ea8ca", fontSize: 14, marginTop: 6 }}>
              Monthly income streams, budget plan, and projected profit across the full year.
            </div>
          </div>
          <div
            style={{
              color: yearlySurplus >= 0 ? "#00f59b" : "#ff5d7a",
              fontSize: 22,
              fontWeight: 950,
              textShadow:
                yearlySurplus >= 0
                  ? "0 0 16px rgba(0,245,155,.35)"
                  : "0 0 16px rgba(255,93,122,.35)",
            }}
          >
            {yearlySurplus >= 0 ? "+" : ""}
            {money(yearlySurplus)} Profit
          </div>
        </div>

        <div
          style={{
            overflowX: "auto",
            border: "1px solid rgba(0,136,255,.18)",
            borderRadius: 14,
            background: "rgba(2,14,28,.54)",
            boxShadow: "inset 0 0 22px rgba(0,80,160,.08)",
          }}
        >
          <div style={{ minWidth: 980 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "120px repeat(12, 1fr) 120px",
                padding: "13px 16px",
                color: "#7ea6d8",
                fontSize: 14,
                fontWeight: 900,
                textTransform: "uppercase",
                letterSpacing: 0.8,
                borderBottom: "1px solid rgba(0,136,255,.14)",
              }}
            >
              <div>Metric</div>
              {dynamicYearlyOpsData.map((month) => (
                <div key={month.month} style={{ textAlign: "right" }}>
                  {month.month}
                </div>
              ))}
              <div style={{ textAlign: "right", color: "#dcecff" }}>Total</div>
            </div>

            {[
              ...incomeOutlookRows,
              {
                label: "Budget",
                color: "#00d8ff",
                values: dynamicYearlyOpsData.map((month) => month.baseBudget),
                total: dynamicYearlyOpsData.reduce((sum, month) => sum + month.baseBudget, 0),
              },
            ].map((row) => (
              <div
                key={row.label}
                style={{
                  display: "grid",
                  gridTemplateColumns: "120px repeat(12, 1fr) 120px",
                  padding: "14px 16px",
                  borderBottom: "1px solid rgba(0,136,255,.08)",
                  alignItems: "center",
                }}
              >
                <div style={{ color: row.color, fontSize: 16, fontWeight: 950 }}>{row.label}</div>
                {row.values.map((value, valueIndex) => (
                  <div
                    key={valueIndex}
                    style={{
                      color: "#dcecff",
                      textAlign: "right",
                      fontSize: 14,
                      fontWeight: 850,
                    }}
                  >
                    {money(value)}
                  </div>
                ))}
                <div
                  style={{ color: row.color, textAlign: "right", fontSize: 16, fontWeight: 950 }}
                >
                  {money(row.total)}
                </div>
              </div>
            ))}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "120px repeat(12, 1fr) 120px",
                padding: "16px",
                alignItems: "center",
                background: "linear-gradient(90deg, rgba(0,136,255,.10), rgba(0,245,155,.06))",
              }}
            >
              <div style={{ color: "white", fontSize: 17, fontWeight: 950 }}>Profit</div>
              {dynamicYearlyOpsData.map((month) => {
                const profit = month.income - month.budget;
                return (
                  <div
                    key={month.month}
                    style={{
                      color: profit >= 0 ? "#00f59b" : "#ff5d7a",
                      textAlign: "right",
                      fontSize: 14,
                      fontWeight: 900,
                    }}
                  >
                    {profit >= 0 ? "+" : ""}
                    {money(profit)}
                  </div>
                );
              })}
              <div
                style={{
                  color: yearlySurplus >= 0 ? "#00f59b" : "#ff5d7a",
                  textAlign: "right",
                  fontSize: 15,
                  fontWeight: 950,
                }}
              >
                {yearlySurplus >= 0 ? "+" : ""}
                {money(yearlySurplus)}
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "120px repeat(12, 1fr) 120px",
                padding: "14px 16px",
                alignItems: "center",
                borderTop: "1px solid rgba(255,159,28,.16)",
                background: "rgba(255,159,28,.04)",
              }}
            >
              <div style={{ color: "#ffb347", fontSize: 17, fontWeight: 950 }}>Adjustments</div>
              {budgetMonths.map((month, index) => (
                <input
                  key={month}
                  value={
                    planningProjectionAdjustments[month] === undefined
                      ? "0"
                      : String(planningProjectionAdjustments[month])
                  }
                  onChange={(event) => {
                    const nextValue = normalizeAdjustmentInput(event.target.value);
                    setProjectionAdjustmentsForYear(activePlanningYear, (current) => ({
                      ...current,
                      [month]: nextValue,
                    }));
                  }}
                  style={{
                    color: adjustmentValues[index] >= 0 ? "#ffd08a" : "#ff9a76",
                    textAlign: "right",
                    fontSize: 14,
                    fontWeight: 900,
                    background: "transparent",
                    border: "1px solid transparent",
                    borderRadius: 7,
                    padding: "6px 4px",
                    outline: "none",
                    width: "100%",
                    boxSizing: "border-box",
                  }}
                  onFocus={(event) => {
                    event.currentTarget.select();
                    event.currentTarget.style.border = "1px solid rgba(255,159,28,.45)";
                    event.currentTarget.style.background = "rgba(255,159,28,.08)";
                  }}
                  onBlur={(event) => {
                    event.currentTarget.style.border = "1px solid transparent";
                    event.currentTarget.style.background = "transparent";
                  }}
                />
              ))}
              <div
                style={{
                  color: "#ffb347",
                  textAlign: "right",
                  fontSize: 15,
                  fontWeight: 950,
                }}
              >
                {formatAdjustmentValue(adjustmentValues.reduce((sum, value) => sum + value, 0))}
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "120px repeat(12, 1fr) 120px",
                padding: "16px",
                alignItems: "center",
                background: "linear-gradient(90deg, rgba(0,216,255,.16), rgba(0,216,255,.04))",
                borderTop: "1px solid rgba(0,216,255,.2)",
                boxShadow: "inset 0 0 22px rgba(0,216,255,.06)",
              }}
            >
              <div style={{ color: "#8feaff", fontSize: 17, fontWeight: 950 }}>True Cash</div>
              {trueCashValues.map((value, index) => (
                <div
                  key={budgetMonths[index]}
                  style={{
                    color:
                      value === null
                        ? "#6d819c"
                        : index === currentBudgetPeriod.monthIndex && activePlanningYear === currentBudgetPeriod.year
                          ? "#d9f7ff"
                          : "#8feaff",
                    textAlign: "right",
                    fontSize: 14,
                    fontWeight: 900,
                    textShadow: value === null ? "none" : "0 0 10px rgba(0,216,255,.28)",
                  }}
                >
                  {value === null ? "—" : wholeDollars(value)}
                </div>
              ))}
              <div
                style={{
                  color: "#8feaff",
                  textAlign: "right",
                  fontSize: 15,
                  fontWeight: 950,
                  textShadow: "0 0 14px rgba(0,216,255,.32)",
                }}
              >
                {wholeDollars(trueCashYearEndValue)}
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "120px repeat(12, 1fr) 120px",
                padding: "16px",
                alignItems: "center",
                background: "linear-gradient(90deg, rgba(255,159,28,.16), rgba(255,159,28,.05))",
                borderTop: "1px solid rgba(255,159,28,.22)",
                boxShadow: "inset 0 0 22px rgba(255,159,28,.07)",
              }}
            >
              <div style={{ color: "#ffb347", fontSize: 17, fontWeight: 950 }}>
                Projected True Cash
              </div>
              {projectedTrueCashValues.map((value, index) => (
                <div
                  key={budgetMonths[index]}
                  style={{
                    color:
                      value === null
                        ? "#6d819c"
                        : index === currentBudgetPeriod.monthIndex
                          ? "#ff9f1c"
                          : "#ffd08a",
                    textAlign: "right",
                    fontSize: 14,
                    fontWeight: 900,
                    textShadow: value === null ? "none" : "0 0 10px rgba(255,159,28,.32)",
                  }}
                >
                  {value === null ? "—" : wholeDollars(value)}
                </div>
              ))}
              <div
                style={{
                  color: "#ff9f1c",
                  textAlign: "right",
                  fontSize: 15,
                  fontWeight: 950,
                  textShadow: "0 0 14px rgba(255,159,28,.38)",
                }}
              >
                {wholeDollars(projectedYearEndTrueCash)}
              </div>
            </div>
          </div>
        </div>
      </section>

    </div>
  );
}
