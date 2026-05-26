import { useState } from "react";
import { styles } from "../styles.js";
import { buildBudgetMonthlySpendSeries, buildMonthlyActualIncomeSeries } from "../utils/budgetReview.js";
import { getCurrentBudgetPeriod } from "../utils/date.js";
import { cleanMoneyInput, money, parseMoney, wholeDollars } from "../utils/format.js";
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

const SCORECARD_BAR_AREA_PX = 236;
const SCORECARD_BAR_MIN_PX = 10;

function scorecardBarHeightPercent(value, maxValue) {
  const max = Math.max(Number(maxValue) || 1, 1);
  const v = Math.max(0, Number(value) || 0);
  if (v <= 0) return 0;
  const raw = (v / max) * SCORECARD_BAR_AREA_PX;
  return Math.round(Math.max(SCORECARD_BAR_MIN_PX, Math.min(SCORECARD_BAR_AREA_PX, raw)));
}

function finiteMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function buildScorecardTrendPaths(values, { minValue, maxValue, width, height, paddingX = 16, paddingY = 14 }) {
  const count = values.length;
  if (!count || width <= 0 || height <= 0) return [];

  const usableWidth = Math.max(width - paddingX * 2, 0);
  const usableHeight = Math.max(height - paddingY * 2, 0);
  const span = Math.max(Number(maxValue) - Number(minValue), 1);

  const points = values.map((value, index) => {
    if (value === null || value === undefined) return null;
    const x = paddingX + (count === 1 ? usableWidth / 2 : (index / (count - 1)) * usableWidth);
    const y = paddingY + ((Number(maxValue) - Number(value)) / span) * usableHeight;
    return { x, y };
  });

  const segments = [];
  let currentSegment = [];

  points.forEach((point) => {
    if (!point) {
      if (currentSegment.length > 1) segments.push(currentSegment);
      currentSegment = [];
      return;
    }
    currentSegment.push(point);
  });

  if (currentSegment.length > 1) segments.push(currentSegment);

  return segments.map((segment) =>
    segment
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(" ")
  );
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
  const yearlySurplus = yearlyIncome - yearlyBudget;
  const subscriptionOverview = buildSubscriptionOverview(subscriptions);
  const scorecardPeak = Math.max(
    ...dynamicYearlyOpsData.flatMap((month) => [
      finiteMoney(month.plannedIncome),
      finiteMoney(month.budget),
      finiteMoney(month.spent),
      finiteMoney(month.actualIncome),
    ]),
    0
  );
  const maxValue = Math.max(scorecardPeak, 1);

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
  const chartTrendWidth = 1000;
  const chartTrendHeight = SCORECARD_BAR_AREA_PX;
  const profitValues = scorecardMonths.map((entry) => entry.profit);
  const profitRange = {
    min: Math.min(...profitValues, 0),
    max: Math.max(...profitValues, 0),
  };
  const profitTrendPaths = buildScorecardTrendPaths(profitValues, {
    minValue: profitRange.min,
    maxValue: profitRange.max,
    width: chartTrendWidth,
    height: chartTrendHeight,
  });
  const trueCashEntries = scorecardMonths
    .map((entry) => entry.trueCash)
    .filter((value) => value !== null && value !== undefined);
  const trueCashRange = {
    min: Math.min(...trueCashEntries, 0),
    max: Math.max(...trueCashEntries, 1),
  };
  const trueCashTrendPaths = buildScorecardTrendPaths(
    scorecardMonths.map((entry) => entry.trueCash),
    {
      minValue: trueCashRange.min,
      maxValue: trueCashRange.max,
      width: chartTrendWidth,
      height: chartTrendHeight,
    }
  );
  const scorecardScaleMarks = [1, 0.75, 0.5, 0.25, 0].map((ratio) => ({
    ratio,
    label: money(maxValue * ratio),
  }));

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
          ["Total Income", money(yearlyIncome), "#00f59b"],
          ["Total Budget", money(yearlyBudget), "#00d8ff"],
          ["Yearly Profit", money(yearlySurplus), yearlySurplus >= 0 ? "#00f59b" : "#ff5d7a"],
          [
            "Recurring Commitments",
            money(subscriptionOverview.activeMonthly),
            "#ffb65d",
            `${money(subscriptionOverview.yearlyCommitment)} annualized`,
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
                marginBottom: 24,
                gap: 18,
                flexWrap: "wrap",
              }}
            >
              <div>
                <div style={{ color: "white", fontSize: 22, fontWeight: 900 }}>Monthly Scorecard</div>
                <div style={{ color: "#8ea8ca", marginTop: 8, fontSize: 14, lineHeight: 1.55 }}>
                  Mission-control view for monthly income, budget execution, and trend momentum.
                  {!planConfigured ? (
                    <span style={{ display: "block", marginTop: 8, color: "#94a3b8", fontSize: 13 }}>
                      No plan data set for {activePlanningYear} yet; planned/budget/spent values use
                      sample baselines while actual income remains transaction-driven.
                    </span>
                  ) : null}
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  flexWrap: "wrap",
                  justifyContent: "flex-end",
                  alignItems: "center",
                }}
              >
                {[
                  ["Planned", "linear-gradient(180deg,#7fffd4,#34d399)", "#7fffd4"],
                  ["Actual", "linear-gradient(180deg,#0f766e,#064e3b)", "#5eead4"],
                  ["Budget", "linear-gradient(180deg,#fdba74,#fb923c)", "#fdba74"],
                  ["Spent", "linear-gradient(180deg,#9a3412,#7c2d12)", "#f97316"],
                  ["Profit Trend", "linear-gradient(90deg,#22c55e,#00f59b)", "#4ade80"],
                  ["True Cash Trend", "linear-gradient(90deg,#0ea5e9,#00d8ff)", "#38bdf8"],
                ].map(([label, swatch, glow]) => (
                  <span
                    key={label}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "5px 10px",
                      borderRadius: 999,
                      border: `1px solid ${glow}44`,
                      background: "rgba(2,12,24,.64)",
                      color: "#b9d4f2",
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    <span
                      style={{
                        width: 14,
                        height: 4,
                        borderRadius: 999,
                        background: swatch,
                        boxShadow: `0 0 10px ${glow}66`,
                      }}
                    />
                    {label}
                  </span>
                ))}
              </div>
            </div>

            <div
              onMouseLeave={() => setHoveredCommandMonth(null)}
              style={{
                position: "relative",
                borderRadius: 14,
                border: "1px solid rgba(0,216,255,.2)",
                background:
                  "linear-gradient(160deg, rgba(4,20,40,.86), rgba(3,12,24,.92) 52%, rgba(2,8,18,.95))",
                boxShadow:
                  "inset 0 0 28px rgba(0,136,255,.12), 0 14px 28px rgba(0,0,0,.2), 0 0 0 1px rgba(0,216,255,.05)",
                padding: "18px 14px 12px",
                overflow: "hidden",
              }}
            >
              {hoveredCommandMonth ? (
                <div
                  style={{
                    position: "absolute",
                    top: 16,
                    left: `${Math.min(
                      87,
                      Math.max(14, ((hoveredCommandMonth.index + 0.5) / scorecardMonths.length) * 100)
                    )}%`,
                    transform: "translateX(-50%)",
                    zIndex: 7,
                    minWidth: 220,
                    border: "1px solid rgba(0,216,255,.28)",
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
                    ["Actual income", hoveredCommandMonth.data.actualIncome, "#0f766e"],
                    ["Budget", hoveredCommandMonth.data.budget, "#fdba74"],
                    ["Spent", hoveredCommandMonth.data.spent, "#9a3412"],
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

              <div style={{ position: "relative", paddingLeft: 58 }}>
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 34,
                    bottom: 36,
                    width: 50,
                    display: "grid",
                    gridTemplateRows: "repeat(5, 1fr)",
                    alignContent: "stretch",
                    pointerEvents: "none",
                  }}
                >
                  {scorecardScaleMarks.map((mark) => (
                    <div
                      key={mark.ratio}
                      style={{
                        display: "flex",
                        alignItems: mark.ratio === 0 ? "end" : "center",
                        justifyContent: "flex-end",
                        paddingRight: 8,
                        color: "#6482a7",
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: 0.3,
                      }}
                    >
                      {mark.label}
                    </div>
                  ))}
                </div>

                <div style={{ overflowX: "auto", overflowY: "hidden", paddingBottom: 2 }}>
                  <div style={{ position: "relative", minWidth: 980, paddingRight: 6 }}>
                    <div
                      aria-hidden
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        top: 34,
                        height: SCORECARD_BAR_AREA_PX,
                        pointerEvents: "none",
                      }}
                    >
                      {scorecardScaleMarks.map((mark) => (
                        <div
                          key={`grid-${mark.ratio}`}
                          style={{
                            position: "absolute",
                            left: 0,
                            right: 0,
                            top: `${(1 - mark.ratio) * 100}%`,
                            borderTop:
                              mark.ratio === 0
                                ? "1px solid rgba(148,163,184,0.32)"
                                : "1px dashed rgba(148,163,184,0.14)",
                          }}
                        />
                      ))}
                    </div>

                    <svg
                      aria-hidden
                      viewBox={`0 0 ${chartTrendWidth} ${chartTrendHeight}`}
                      preserveAspectRatio="none"
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        top: 34,
                        height: SCORECARD_BAR_AREA_PX,
                        width: "100%",
                        zIndex: 1,
                        pointerEvents: "none",
                      }}
                    >
                      <defs>
                        <linearGradient id="ops-profit-line" x1="0%" y1="0%" x2="100%" y2="0%">
                          <stop offset="0%" stopColor="#22c55e" />
                          <stop offset="100%" stopColor="#00f59b" />
                        </linearGradient>
                        <linearGradient id="ops-true-cash-line" x1="0%" y1="0%" x2="100%" y2="0%">
                          <stop offset="0%" stopColor="#0ea5e9" />
                          <stop offset="100%" stopColor="#00d8ff" />
                        </linearGradient>
                      </defs>
                      {profitTrendPaths.map((path, index) => (
                        <path
                          key={`profit-glow-${index}`}
                          d={path}
                          fill="none"
                          stroke="rgba(0,245,155,0.18)"
                          strokeWidth="7"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      ))}
                      {profitTrendPaths.map((path, index) => (
                        <path
                          key={`profit-${index}`}
                          d={path}
                          fill="none"
                          stroke="url(#ops-profit-line)"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      ))}
                      {trueCashTrendPaths.map((path, index) => (
                        <path
                          key={`cash-glow-${index}`}
                          d={path}
                          fill="none"
                          stroke="rgba(0,216,255,0.16)"
                          strokeWidth="6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      ))}
                      {trueCashTrendPaths.map((path, index) => (
                        <path
                          key={`cash-${index}`}
                          d={path}
                          fill="none"
                          stroke="url(#ops-true-cash-line)"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeDasharray="5 4"
                        />
                      ))}
                    </svg>

                    <div
                      style={{
                        position: "relative",
                        zIndex: 2,
                        display: "grid",
                        gridTemplateColumns: "repeat(12, minmax(56px, 1fr))",
                        gap: 8,
                        alignItems: "end",
                      }}
                    >
                      {scorecardMonths.map((entry) => (
                        <div
                          key={entry.month.month}
                          onMouseEnter={() => setHoveredCommandMonth({ data: entry.month, index: entry.index })}
                          style={{
                            minWidth: 0,
                            display: "flex",
                            flexDirection: "column",
                            justifyContent: "flex-end",
                            alignItems: "center",
                            gap: 8,
                            cursor: "pointer",
                          }}
                        >
                          <div
                            style={{
                              color: entry.profit >= 0 ? "#63f6ad" : "#ff8aa0",
                              border: `1px solid ${entry.profit >= 0 ? "rgba(0,245,155,.26)" : "rgba(255,93,122,.32)"}`,
                              background: entry.profit >= 0 ? "rgba(0,245,155,.09)" : "rgba(255,93,122,.1)",
                              borderRadius: 999,
                              padding: "2px 8px",
                              fontSize: 10,
                              fontWeight: 900,
                              letterSpacing: 0.35,
                              minHeight: 20,
                            }}
                          >
                            {entry.profit >= 0 ? "+" : ""}
                            {wholeDollars(entry.profit)}
                          </div>

                          <div
                            style={{
                              height: SCORECARD_BAR_AREA_PX,
                              width: "100%",
                              display: "flex",
                              alignItems: "end",
                              justifyContent: "center",
                              gap: 5,
                              padding: "0 2px",
                            }}
                          >
                            {[
                              [
                                "Planned",
                                entry.plannedIncome,
                                "linear-gradient(180deg,#7fffd4,#34d399)",
                                "rgba(167,255,230,0.38)",
                                "0 -2px 14px rgba(52,211,153,0.45)",
                              ],
                              [
                                "Actual",
                                entry.actualIncome,
                                "linear-gradient(180deg,#0f766e,#064e3b)",
                                "rgba(45,120,110,0.62)",
                                "inset 0 1px 0 rgba(110,255,210,0.12)",
                              ],
                              [
                                "Budget",
                                entry.budget,
                                "linear-gradient(180deg,#fdba74,#fb923c)",
                                "rgba(255,220,180,0.35)",
                                "0 -2px 10px rgba(251,146,60,0.32)",
                              ],
                              [
                                "Spent",
                                entry.spent,
                                "linear-gradient(180deg,#9a3412,#7c2d12)",
                                "rgba(120,45,25,0.58)",
                                "inset 0 1px 0 rgba(253,186,116,0.11)",
                              ],
                            ].map(([label, value, background, border, shadow]) => (
                              <div
                                key={label}
                                title={`${label} ${money(value)}`}
                                style={{
                                  width: 10,
                                  height: "100%",
                                  borderRadius: 8,
                                  background: "rgba(5,16,30,.66)",
                                  border: "1px solid rgba(0,216,255,.08)",
                                  position: "relative",
                                  overflow: "hidden",
                                }}
                              >
                                <div
                                  style={{
                                    position: "absolute",
                                    left: 0,
                                    right: 0,
                                    bottom: 0,
                                    height: scorecardBarHeightPercent(value, maxValue),
                                    borderRadius: "6px 6px 2px 2px",
                                    background,
                                    border: `1px solid ${border}`,
                                    boxShadow: shadow,
                                  }}
                                />
                              </div>
                            ))}
                          </div>

                          <div
                            style={{
                              color: "#7ba2cf",
                              fontSize: 11,
                              fontWeight: 800,
                              letterSpacing: 0.4,
                              textTransform: "uppercase",
                              padding: "3px 8px",
                              borderRadius: 999,
                              background: "rgba(0,96,180,.12)",
                              border: "1px solid rgba(0,216,255,.16)",
                            }}
                          >
                            {entry.month.month}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
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
