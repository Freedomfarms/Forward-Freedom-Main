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

function scorecardBarHeightPercent(value, maxValue) {
  const max = Math.max(Number(maxValue) || 1, 1);
  const v = Math.max(0, Number(value) || 0);
  if (v <= 0) return "0%";
  const pct = (v / max) * 100;
  return `${Math.max(2.8, Math.min(100, pct))}%`;
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

  const dynamicYearlyOpsData = yearlyOpsData.map((month) => {
    const activeStreams = planningIncomeStreams.filter((stream) =>
      (stream.months || budgetMonths).includes(month.month)
    );
    const plannedIncome = activeStreams.reduce((sum, stream) => sum + parseMoney(stream.amount), 0);
    const oneTimeIncome = activeStreams
      .filter((stream) => stream.type === "One-Time")
      .reduce((sum, stream) => sum + parseMoney(stream.amount), 0);

    const activeBudgetCategories = planningBudgetRows.filter((category) =>
      (category.months || budgetMonths).includes(month.month)
    );

    const budget = activeBudgetCategories.reduce(
      (sum, category) => sum + Number(category.budget || 0),
      0
    );

    const spent = monthlySpendSeries.find((entry) => entry.month === month.month)?.spent || 0;
    const actualIncome =
      monthlyActualIncomeSeries.find((entry) => entry.month === month.month)?.actualIncome || 0;

    return {
      ...month,
      income: plannedIncome,
      plannedIncome,
      actualIncome,
      budget,
      spent,
      baseBudget: budget,
      profit: plannedIncome - budget,
      recurringIncome: plannedIncome - oneTimeIncome,
      oneTimeIncome,
    };
  });

  const yearlyIncome = dynamicYearlyOpsData.reduce((sum, month) => sum + month.income, 0);
  const yearlyBudget = dynamicYearlyOpsData.reduce((sum, month) => sum + month.budget, 0);
  const yearlySurplus = yearlyIncome - yearlyBudget;
  const subscriptionOverview = buildSubscriptionOverview(subscriptions);
  const scorecardPeak = Math.max(
    ...dynamicYearlyOpsData.flatMap((month) => [
      month.plannedIncome,
      month.budget,
      month.spent,
      month.actualIncome,
    ]),
    0
  );
  const maxValue = Math.max(scorecardPeak, 1);
  const scorecardHasBars = scorecardPeak > 0;

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
                marginBottom: 26,
              }}
            >
              <div>
                <div style={{ color: "white", fontSize: 22, fontWeight: 800 }}>Monthly Scorecard</div>
                <div style={{ color: "#8ea8ca", marginTop: 8, fontSize: 15, lineHeight: 1.5 }}>
                  Planned income from Income Hub, budget and spent from Budget Lab logic, and actual
                  income from positive in-month deposits (excluding transfers).
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 22,
                  color: "#94a3b8",
                  fontSize: 13,
                  fontWeight: 600,
                  flexWrap: "wrap",
                  justifyContent: "flex-end",
                  letterSpacing: 0.02,
                  alignItems: "center",
                }}
              >
                <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 2,
                        background: "linear-gradient(135deg,#7fffd4,#34d399)",
                        boxShadow: "0 0 10px rgba(52,211,153,0.45)",
                      }}
                    />
                    Planned income
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 2,
                        background: "#0f766e",
                        boxShadow: "inset 0 0 0 1px rgba(110,255,210,0.25)",
                      }}
                    />
                    Actual income
                  </span>
                </div>
                <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 2,
                        background: "linear-gradient(135deg,#fdba74,#fb923c)",
                        boxShadow: "0 0 8px rgba(251,146,60,0.35)",
                      }}
                    />
                    Budget
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 2,
                        background: "#7c2d12",
                        boxShadow: "inset 0 0 0 1px rgba(253,186,116,0.2)",
                      }}
                    />
                    Spent
                  </span>
                </div>
              </div>
            </div>

            <div
              onMouseLeave={() => setHoveredCommandMonth(null)}
              style={{
                position: "relative",
                height: 348,
                borderRadius: 12,
                border: "1px solid rgba(148,163,184,0.22)",
                background: "rgba(15,23,42,0.55)",
                padding: "20px 10px 6px",
                display: "grid",
                gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
                gap: 4,
                alignItems: "end",
                overflowX: "auto",
                overflowY: "hidden",
              }}
            >
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  left: 12,
                  right: 12,
                  bottom: 34,
                  height: 1,
                  background: "rgba(148,163,184,0.18)",
                  pointerEvents: "none",
                }}
              />
              {scorecardHasBars && hoveredCommandMonth ? (
                <div
                  style={{
                    position: "absolute",
                    top: 14,
                    left: `${Math.min(
                      88,
                      Math.max(12, ((hoveredCommandMonth.index + 0.5) / 12) * 100)
                    )}%`,
                    transform: "translateX(-50%)",
                    zIndex: 5,
                    minWidth: 210,
                    border: "1px solid rgba(148,163,184,0.28)",
                    borderRadius: 8,
                    background: "rgba(15,23,42,0.97)",
                    boxShadow: "0 12px 28px rgba(0,0,0,0.35)",
                    padding: "12px 14px",
                    pointerEvents: "none",
                  }}
                >
                  <div
                    style={{
                      color: "#e2e8f0",
                      fontSize: 13,
                      marginBottom: 10,
                      fontWeight: 700,
                      borderBottom: "1px solid rgba(148,163,184,0.2)",
                      paddingBottom: 8,
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
                    ["True Cash", trueCashValues[hoveredCommandMonth.index], "#94a3b8"],
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
                        gap: 18,
                        color: "#cbd5e1",
                        fontSize: 13,
                        fontWeight: 600,
                        marginTop: 6,
                      }}
                    >
                      <span style={{ color: "#94a3b8" }}>{label}</span>
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

              {!scorecardHasBars ? (
                <div
                  style={{
                    gridColumn: "1 / -1",
                    alignSelf: "center",
                    justifySelf: "center",
                    maxWidth: 420,
                    margin: "32px 12px",
                    padding: "20px 22px",
                    borderRadius: 10,
                    border: "1px dashed rgba(148,163,184,0.35)",
                    color: "#94a3b8",
                    fontSize: 14,
                    lineHeight: 1.55,
                    textAlign: "center",
                  }}
                >
                  No scorecard amounts for {activePlanningYear} yet (planned income, budget, spending, or
                  positive deposits). Add income streams and budget rows for this year, or sync
                  transactions—empty preview environments often look blank until data exists.
                </div>
              ) : null}

              {scorecardHasBars
                ? dynamicYearlyOpsData.map((month, index) => (
                    <div
                      key={month.month}
                      onMouseEnter={() => setHoveredCommandMonth({ data: month, index })}
                      style={{
                        height: "100%",
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
                          height: 248,
                          width: "100%",
                          minWidth: 0,
                          maxWidth: "100%",
                          display: "flex",
                          alignItems: "end",
                          justifyContent: "center",
                          gap: 5,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "end",
                            justifyContent: "center",
                            gap: 2,
                          }}
                        >
                          <div
                            title={`Planned income ${money(month.plannedIncome ?? month.income)}`}
                            style={{
                              width: 8,
                              height: scorecardBarHeightPercent(
                                month.plannedIncome ?? month.income,
                                maxValue
                              ),
                              borderRadius: "3px 3px 1px 1px",
                              background: "linear-gradient(180deg,#7fffd4,#34d399)",
                              border: "1px solid rgba(167,255,230,0.35)",
                              boxShadow: "0 -2px 12px rgba(52,211,153,0.35)",
                            }}
                          />
                          <div
                            title={`Actual income ${money(month.actualIncome)}`}
                            style={{
                              width: 8,
                              height: scorecardBarHeightPercent(month.actualIncome, maxValue),
                              borderRadius: "3px 3px 1px 1px",
                              background: "linear-gradient(180deg,#0f766e,#064e3b)",
                              border: "1px solid rgba(45,120,110,0.6)",
                              boxShadow: "inset 0 1px 0 rgba(110,255,210,0.12)",
                            }}
                          />
                        </div>
                        <div
                          aria-hidden
                          style={{
                            width: 1,
                            height: 200,
                            flexShrink: 0,
                            alignSelf: "flex-end",
                            marginBottom: 0,
                            background: "rgba(148,163,184,0.22)",
                            borderRadius: 1,
                          }}
                        />
                        <div
                          style={{
                            display: "flex",
                            alignItems: "end",
                            justifyContent: "center",
                            gap: 2,
                          }}
                        >
                          <div
                            title={`Budget ${money(month.budget)}`}
                            style={{
                              width: 8,
                              height: scorecardBarHeightPercent(month.budget, maxValue),
                              borderRadius: "3px 3px 1px 1px",
                              background: "linear-gradient(180deg,#fdba74,#fb923c)",
                              border: "1px solid rgba(255,220,180,0.35)",
                              boxShadow: "0 -2px 10px rgba(251,146,60,0.28)",
                            }}
                          />
                          <div
                            title={`Spent ${money(month.spent)}`}
                            style={{
                              width: 8,
                              height: scorecardBarHeightPercent(month.spent, maxValue),
                              borderRadius: "3px 3px 1px 1px",
                              background: "linear-gradient(180deg,#9a3412,#7c2d12)",
                              border: "1px solid rgba(120,45,25,0.55)",
                              boxShadow: "inset 0 1px 0 rgba(253,186,116,0.1)",
                            }}
                          />
                        </div>
                      </div>
                      <div
                        style={{
                          color: "#64748b",
                          fontSize: 12,
                          fontWeight: 600,
                          marginTop: 4,
                        }}
                      >
                        {month.month}
                      </div>
                    </div>
                  ))
                : null}
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
