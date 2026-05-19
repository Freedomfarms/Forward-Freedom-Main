import { useState } from "react";
import { styles } from "../styles.js";
import { buildBudgetMonthlySpendSeries } from "../utils/budgetReview.js";
import { getCurrentBudgetPeriod } from "../utils/date.js";
import { cleanMoneyInput, money, parseMoney, wholeDollars } from "../utils/format.js";
import { budgetMonths, yearlyOpsData } from "../data/constants.jsx";
import { buildProjectedTrueCashSeries } from "../utils/planning.js";
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
  plansByYear,
  currentPlanBaseData,
  getPlanningAnchorForYear,
  setPlanningAnchorForYear,
}) {
  const [hoveredCommandMonth, setHoveredCommandMonth] = useState(null);
  const currentBudgetPeriod = getCurrentBudgetPeriod();
  const [activePlanningYear, setActivePlanningYear] = useState(currentPlanYear);
  const activePlanningMonth = budgetMonths[currentBudgetPeriod.monthIndex];
  const planningBudgetRows = getBudgetRowsForYear(activePlanningYear);
  const planningIncomeStreams = getIncomeStreamsForYear(activePlanningYear);
  const planningProjectionAdjustments = getProjectionAdjustmentsForYear(activePlanningYear);
  const planningAnchor = getPlanningAnchorForYear(activePlanningYear);
  const monthlySpendSeries = buildBudgetMonthlySpendSeries(
    transactions,
    planningBudgetRows,
    activePlanningYear
  );
  const updatePlanningYear = (value) => {
    const nextValue = Number(value);
    ensurePlanningYear(nextValue);
    setActivePlanningYear(nextValue);
  };
  const updatePlanningAnchor = (field, value) => {
    const nextValue = field === "startingTrueCash" ? cleanMoneyInput(value) : value;
    setPlanningAnchorForYear(activePlanningYear, {
      [field]: nextValue,
    });
  };

  const dynamicYearlyOpsData = yearlyOpsData.map((month) => {
    const activeStreams = planningIncomeStreams.filter((stream) =>
      (stream.months || budgetMonths).includes(month.month)
    );
    const income = activeStreams.reduce((sum, stream) => sum + parseMoney(stream.amount), 0);
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

    return {
      ...month,
      income,
      budget,
      spent,
      baseBudget: budget,
      profit: income - budget,
      recurringIncome: income - oneTimeIncome,
      oneTimeIncome,
    };
  });

  const yearlyIncome = dynamicYearlyOpsData.reduce((sum, month) => sum + month.income, 0);
  const yearlyBudget = dynamicYearlyOpsData.reduce((sum, month) => sum + month.budget, 0);
  const yearlySurplus = yearlyIncome - yearlyBudget;
  const subscriptionOverview = buildSubscriptionOverview(subscriptions);
  const maxValue = Math.max(
    ...dynamicYearlyOpsData.flatMap((month) => [month.income, month.budget, month.spent]),
    1
  );
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
  const anchorStartingMonth = planningAnchor.startingMonth || activePlanningMonth;
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
  const anchorMonthIndex = Math.max(0, budgetMonths.indexOf(anchorStartingMonth));
  const currentMonthIndex = currentBudgetPeriod.monthIndex;
  const currentYearResidual =
    activePlanningYear === currentBudgetPeriod.year
      ? trueCash - (baseTrueCashSeries[currentMonthIndex] ?? anchorStartingTrueCash)
      : 0;
  const trueCashValues = baseTrueCashSeries.map((value, index) => {
    if (value === null) return null;
    if (activePlanningYear === currentBudgetPeriod.year && index > currentMonthIndex) return null;

    const progress =
      activePlanningYear === currentBudgetPeriod.year && currentMonthIndex > anchorMonthIndex
        ? Math.max(0, (index - anchorMonthIndex) / (currentMonthIndex - anchorMonthIndex))
        : activePlanningYear === currentBudgetPeriod.year && index >= anchorMonthIndex
          ? 1
          : 0;
    const reconciledValue =
      activePlanningYear === currentBudgetPeriod.year ? value + currentYearResidual * progress : value;
    return reconciledValue + adjustmentValues[index];
  });
  const projectedTrueCashValues = baseTrueCashSeries.map((value, index) => {
    if (value === null) return null;
    if (activePlanningYear === currentBudgetPeriod.year && index <= currentMonthIndex) return null;
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
                Starting Month
              </span>
              <select
                value={planningAnchor.startingMonth || activePlanningMonth}
                onChange={(event) => updatePlanningAnchor("startingMonth", event.target.value)}
                style={{
                  color: "#eaf3ff",
                  background: "rgba(0,136,255,.08)",
                  border: "1px solid rgba(0,216,255,.22)",
                  borderRadius: 9,
                  padding: "10px 12px",
                  fontWeight: 800,
                  outline: "none",
                }}
              >
                {budgetMonths.map((month) => (
                  <option key={month} value={month} style={{ background: "#061224" }}>
                    {month}
                  </option>
                ))}
              </select>
            </label>
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
              Choose the month where this yearly projection should start, then enter the true-cash
              balance for that anchor month. The annual row and Command Center projection will both
              follow this same anchor.
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
                <div style={{ color: "#8ea8ca", marginTop: 8, fontSize: 16 }}>
                  Income pulls from Income Hub. Budget and spent pull from the same
                  monthly transaction logic used in Budget Strategy Lab.
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 16,
                  color: "#b8d3f3",
                  fontSize: 15,
                  fontWeight: 700,
                  flexWrap: "wrap",
                  justifyContent: "flex-end",
                }}
              >
                <span>
                  <b
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      borderRadius: 99,
                      background: "#00f59b",
                      marginRight: 8,
                    }}
                  />
                  Total Income
                </span>
                <span>
                  <b
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      borderRadius: 99,
                      background: "#00d8ff",
                      marginRight: 8,
                    }}
                  />
                  Budget
                </span>
                <span>
                  <b
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      borderRadius: 99,
                      background: "#ff8f3d",
                      marginRight: 8,
                    }}
                  />
                  Spent
                </span>
              </div>
            </div>

            <div
              onMouseLeave={() => setHoveredCommandMonth(null)}
              style={{
                position: "relative",
                height: 360,
                display: "grid",
                gridTemplateColumns: "repeat(12, 1fr)",
                gap: 8,
                alignItems: "end",
                borderLeft: "1px solid rgba(0,136,255,.18)",
                borderBottom: "1px solid rgba(0,136,255,.18)",
                padding: "18px 8px 0",
              }}
            >
              {hoveredCommandMonth ? (
                <div
                  style={{
                    position: "absolute",
                    top: 14,
                    left: `${Math.min(
                      86,
                      Math.max(14, ((hoveredCommandMonth.index + 0.5) / 12) * 100)
                    )}%`,
                    transform: "translateX(-50%)",
                    zIndex: 5,
                    minWidth: 190,
                    border: "1px solid rgba(0,216,255,.55)",
                    borderRadius: 12,
                    background: "linear-gradient(180deg, rgba(5,23,45,.98), rgba(2,10,23,.96))",
                    boxShadow: "0 0 28px rgba(0,136,255,.32), inset 0 0 18px rgba(0,216,255,.08)",
                    padding: "12px 14px",
                    pointerEvents: "none",
                  }}
                >
                  <div
                    style={{
                      color: "#8feaff",
                      fontSize: 12,
                      textTransform: "uppercase",
                      letterSpacing: 1,
                      marginBottom: 9,
                    }}
                  >
                    {hoveredCommandMonth.data.month} Values
                  </div>
                  {[
                    ["Income", hoveredCommandMonth.data.income, "#00f59b"],
                    ["Budget", hoveredCommandMonth.data.budget, "#00d8ff"],
                    ["Spent", hoveredCommandMonth.data.spent, "#ff8f3d"],
                    ["True Cash", trueCashValues[hoveredCommandMonth.index], "#8feaff"],
                    [
                      "Profit",
                      hoveredCommandMonth.data.income - hoveredCommandMonth.data.budget,
                      hoveredCommandMonth.data.income - hoveredCommandMonth.data.budget >= 0
                        ? "#00f59b"
                        : "#ff5d7a",
                    ],
                    [
                      "Adjustments",
                      adjustmentValues[hoveredCommandMonth.index],
                      adjustmentValues[hoveredCommandMonth.index] >= 0 ? "#ffb347" : "#ff7a45",
                    ],
                    [
                      "Projected Cash",
                      projectedTrueCashValues[hoveredCommandMonth.index],
                      "#ff9f1c",
                    ],
                  ].map(([label, value, color]) => (
                    <div
                      key={label}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 18,
                        color: "#d7ecff",
                        fontSize: 14,
                        fontWeight: 800,
                        marginTop: 6,
                      }}
                    >
                      <span style={{ color: "#8fb1d9" }}>{label}</span>
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

              {dynamicYearlyOpsData.map((month, index) => (
                <div
                  key={month.month}
                  onMouseEnter={() => setHoveredCommandMonth({ data: month, index })}
                  style={{
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "flex-end",
                    alignItems: "center",
                    gap: 10,
                    cursor: "crosshair",
                  }}
                >
                  <div
                    style={{
                      height: 255,
                      width: "100%",
                      display: "flex",
                      alignItems: "end",
                      justifyContent: "center",
                      gap: 3,
                    }}
                  >
                    <div
                      title={`Income ${money(month.income)}`}
                      style={{
                        width: 14,
                        height: `${(month.income / maxValue) * 100}%`,
                        borderRadius: "8px 8px 0 0",
                        background: "linear-gradient(180deg,#00f59b,#006d4a)",
                        boxShadow: "0 0 14px rgba(0,245,155,.35)",
                      }}
                    />
                    <div
                      title={`Spent ${money(month.spent)}`}
                      style={{
                        width: 14,
                        height: `${(month.spent / maxValue) * 100}%`,
                        borderRadius: "8px 8px 0 0",
                        background: "linear-gradient(180deg,#ffb65d,#ff6b1c)",
                        boxShadow: "0 0 14px rgba(255,159,28,.35)",
                      }}
                    />
                    <div
                      title={`Budget ${money(month.budget)}`}
                      style={{
                        width: 14,
                        height: `${(month.budget / maxValue) * 100}%`,
                        borderRadius: "8px 8px 0 0",
                        background: "linear-gradient(180deg,#00d8ff,#005dff)",
                        boxShadow: "0 0 14px rgba(0,216,255,.35)",
                      }}
                    />
                  </div>
                  <div style={{ color: "#9fb0c9", fontSize: 16, fontWeight: 800 }}>
                    {month.month}
                  </div>
                </div>
              ))}
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
