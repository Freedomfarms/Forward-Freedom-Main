import { useState } from "react";
import { styles } from "../styles.js";
import { buildBudgetMonthlySpendSeries } from "../utils/budgetReview.js";
import { getCurrentBudgetPeriod } from "../utils/date.js";
import { money, parseMoney, wholeDollars } from "../utils/format.js";
import { budgetMonths, yearlyOpsData } from "../data/constants.jsx";
import { buildSubscriptionOverview } from "../utils/subscriptions.js";
import { HouseholdProfilesControl, MonthCoverageEditor } from "./Common.jsx";
import { buildForwardTrueCashProjection } from "../utils/trueCashProjection.js";

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
  setIncomeStreamsForYear,
  setProjectionAdjustmentsForYear,
  ensurePlanningYear,
}) {
  const [incomeDeleteTarget, setIncomeDeleteTarget] = useState(null);
  const [hoveredCommandMonth, setHoveredCommandMonth] = useState(null);
  const currentBudgetPeriod = getCurrentBudgetPeriod();
  const [activePlanningDate, setActivePlanningDate] = useState(() => ({
    monthIndex: currentBudgetPeriod.monthIndex,
    year: currentPlanYear,
  }));
  const activePlanningMonth = budgetMonths[activePlanningDate.monthIndex];
  const currentBudgetMonthIndex = activePlanningDate.monthIndex;
  const planningBudgetRows = getBudgetRowsForYear(activePlanningDate.year);
  const planningIncomeStreams = getIncomeStreamsForYear(activePlanningDate.year);
  const planningProjectionAdjustments = getProjectionAdjustmentsForYear(activePlanningDate.year);
  const monthlySpendSeries = buildBudgetMonthlySpendSeries(
    transactions,
    planningBudgetRows,
    activePlanningDate.year
  );
  const updatePlanningDate = (field, value) => {
    const nextValue = Number(value);
    if (field === "year") {
      ensurePlanningYear(nextValue);
    }

    setActivePlanningDate((current) => ({
      ...current,
      [field]: nextValue,
    }));
  };

  const addIncomeStream = () => {
    setIncomeStreamsForYear(activePlanningDate.year, (streams) => {
      const nextNumber = streams.length + 1;
      return [
        ...streams,
        {
          id: `income-custom-${Date.now()}-${nextNumber}`,
          name: `New Income ${nextNumber}`,
          description: "New Source",
          amount: "$0",
          type: "Recurring",
          color: "#00f59b",
          icon: "✦",
          months: budgetMonths,
        },
      ];
    });
  };

  const toggleIncomeMonth = (index, month) => {
    setIncomeStreamsForYear(activePlanningDate.year, (streams) =>
      streams.map((stream, streamIndex) => {
        if (streamIndex !== index) return stream;

        const currentMonths = stream.months || budgetMonths;
        const nextMonths = currentMonths.includes(month)
          ? currentMonths.filter((item) => item !== month)
          : [...currentMonths, month];

        return {
          ...stream,
          months: nextMonths.length ? nextMonths : [month],
        };
      })
    );
  };

  const setIncomeMonths = (index, nextMonths) => {
    const normalizedMonths = budgetMonths.filter((month) => nextMonths.includes(month));
    const safeMonths = normalizedMonths.length ? normalizedMonths : [activePlanningMonth];

    setIncomeStreamsForYear(activePlanningDate.year, (streams) =>
      streams.map((stream, streamIndex) =>
        streamIndex === index ? { ...stream, months: safeMonths } : stream
      )
    );
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
  const trueCashProjectionSchedule = buildForwardTrueCashProjection({
    openingBalance: trueCash,
    incomeStreams: planningIncomeStreams,
    budgetRows: planningBudgetRows,
    projectionAdjustments: planningProjectionAdjustments,
    startMonth: activePlanningMonth,
    startYear: activePlanningDate.year,
  });
  const adjustmentValues = budgetMonths.map((month) =>
    parseMoney(planningProjectionAdjustments[month])
  );
  const projectedTrueCashValues = budgetMonths.map((month, index) => {
    if (index < currentBudgetMonthIndex) return null;
    if (index === currentBudgetMonthIndex) return trueCash;
    return trueCashProjectionSchedule.find((point) => point.month === month)?.value ?? null;
  });
  const projectedYearEndTrueCash = projectedTrueCashValues.at(-1) ?? trueCash;

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
            value={activePlanningDate.monthIndex}
            onChange={(event) => updatePlanningDate("monthIndex", event.target.value)}
            style={{
              color: "#f2f7ff",
              background: "rgba(1,10,24,.55)",
              border: "1px solid rgba(54,126,220,.38)",
              borderRadius: 7,
              padding: "10px 12px",
              minWidth: 124,
            }}
          >
            {budgetMonths.map((month, index) => (
              <option key={month} value={index} style={{ background: "#061224" }}>
                {month}
              </option>
            ))}
          </select>
          <select
            value={activePlanningDate.year}
            onChange={(event) => updatePlanningDate("year", event.target.value)}
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
            Current True Cash
          </div>

          <div
            style={{
              marginTop: 12,
              display: "grid",
              gap: 12,
            }}
          >
            <div
              style={{
                color: "#eaf3ff",
                fontSize: 30,
                fontWeight: 900,
              }}
            >
              {wholeDollars(trueCash)}
            </div>
            <div
              style={{
                background: "rgba(0,136,255,.08)",
                border: "1px solid rgba(0,216,255,.22)",
                borderRadius: 10,
                padding: "10px 14px",
                color: "#cfe7ff",
                fontSize: 13,
                fontWeight: 800,
                boxShadow: "0 0 18px rgba(0,216,255,.12)",
              }}
            >
              Anchored to the live dashboard baseline
            </div>
            <div style={{ color: "#8ea8ca", fontSize: 12, lineHeight: 1.5 }}>
              Uses the same live true-cash balance that powers Dashboard and Forecast Lab before
              projecting the remaining months in the selected planning period ({activePlanningMonth}{" "}
              {activePlanningDate.year} onward).
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
            gridTemplateColumns: ".8fr 1.2fr",
            gap: 22,
            alignItems: "stretch",
          }}
        >
          <div
            style={{
              border: "1px solid rgba(0,136,255,.18)",
              borderRadius: 12,
              background: "rgba(0,30,70,.08)",
              minHeight: 360,
              padding: 22,
              display: "flex",
              flexDirection: "column",
              position: "relative",
              zIndex: 3,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 24,
              }}
            >
              <div>
                <div style={{ color: "white", fontSize: 22, fontWeight: 800 }}>
                  Monthly Income Streams
                </div>
                <div style={{ color: "#8ea8ca", marginTop: 8, fontSize: 16 }}>
                  Track recurring and variable income sources.
                </div>
              </div>
              <div style={{ color: "#00f59b", fontSize: 14, fontWeight: 800 }}>
                + Stable Cashflow
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 18, marginTop: 4 }}>
              {planningIncomeStreams.map((income, index) => (
                <div
                  key={income.id}
                  style={{
                    border: "1px solid rgba(0,136,255,.16)",
                    borderRadius: 14,
                    background: "rgba(2,14,28,.72)",
                    padding: "16px 18px",
                    display: "grid",
                    gridTemplateColumns: "auto 1fr auto",
                    alignItems: "center",
                    gap: 16,
                    boxShadow: "inset 0 0 18px rgba(0,80,160,.06)",
                  }}
                >
                  <div
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setIncomeDeleteTarget({ id: income.id, name: income.name });
                    }}
                    title="Double click to delete income stream"
                    style={{
                      width: 42,
                      height: 42,
                      borderRadius: 12,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: `${income.color}22`,
                      border: `1px solid ${income.color}55`,
                      fontSize: 20,
                      boxShadow: `0 0 16px ${income.color}22`,
                      cursor: "pointer",
                    }}
                  >
                    {income.icon}
                  </div>

                  <div>
                    <div
                      style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}
                    >
                      <input
                        value={income.name}
                        onChange={(event) =>
                          setIncomeStreamsForYear(activePlanningDate.year, (streams) =>
                            streams.map((stream, streamIndex) =>
                              streamIndex === index
                                ? { ...stream, name: event.target.value }
                                : stream
                            )
                          )
                        }
                        style={{
                          color: "white",
                          fontSize: 17,
                          fontWeight: 800,
                          background: "transparent",
                          border: "1px solid transparent",
                          borderRadius: 8,
                          padding: "4px 8px",
                          outline: "none",
                          width: 150,
                        }}
                        onFocus={(event) => {
                          event.currentTarget.style.border = "1px solid rgba(0,216,255,.38)";
                          event.currentTarget.style.background = "rgba(0,136,255,.08)";
                        }}
                        onBlur={(event) => {
                          event.currentTarget.style.border = "1px solid transparent";
                          event.currentTarget.style.background = "transparent";
                        }}
                      />
                      <input
                        value={income.description}
                        onChange={(event) =>
                          setIncomeStreamsForYear(activePlanningDate.year, (streams) =>
                            streams.map((stream, streamIndex) =>
                              streamIndex === index
                                ? { ...stream, description: event.target.value }
                                : stream
                            )
                          )
                        }
                        style={{
                          color: "#b7d7ff",
                          fontSize: 16,
                          fontWeight: 700,
                          background: "transparent",
                          border: "1px solid transparent",
                          borderRadius: 8,
                          padding: "4px 8px",
                          outline: "none",
                          minWidth: 180,
                        }}
                        onFocus={(event) => {
                          event.currentTarget.style.border = "1px solid rgba(0,216,255,.38)";
                          event.currentTarget.style.background = "rgba(0,136,255,.08)";
                        }}
                        onBlur={(event) => {
                          event.currentTarget.style.border = "1px solid transparent";
                          event.currentTarget.style.background = "transparent";
                        }}
                      />
                    </div>
                    <div
                      style={{
                        display: "grid",
                        marginTop: 6,
                        minWidth: 0,
                      }}
                    >
                      <div style={{ color: "#00f59b", fontSize: 13, fontWeight: 800 }}>
                        {income.type}
                      </div>
                      <MonthCoverageEditor
                        allMonths={budgetMonths}
                        selectedMonths={income.months || budgetMonths}
                        onToggleMonth={(month) => toggleIncomeMonth(index, month)}
                        quickActions={[
                          { label: "All", onClick: () => setIncomeMonths(index, budgetMonths) },
                          {
                            label: `Only ${activePlanningMonth}`,
                            onClick: () => setIncomeMonths(index, [activePlanningMonth]),
                          },
                        ]}
                      />
                    </div>
                  </div>

                  <input
                    value={income.amount}
                    onChange={(event) =>
                      setIncomeStreamsForYear(activePlanningDate.year, (streams) =>
                        streams.map((stream, streamIndex) =>
                          streamIndex === index ? { ...stream, amount: event.target.value } : stream
                        )
                      )
                    }
                    style={{
                      color: "#eaf3ff",
                      fontSize: 22,
                      fontWeight: 900,
                      background: "transparent",
                      border: "1px solid transparent",
                      borderRadius: 8,
                      padding: "6px 10px",
                      width: 120,
                      textAlign: "right",
                      outline: "none",
                    }}
                    onFocus={(event) => {
                      event.currentTarget.style.border = "1px solid rgba(0,216,255,.38)";
                      event.currentTarget.style.background = "rgba(0,136,255,.08)";
                      event.currentTarget.style.boxShadow = "inset 0 0 18px rgba(0,136,255,.10)";
                    }}
                    onBlur={(event) => {
                      event.currentTarget.style.border = "1px solid transparent";
                      event.currentTarget.style.background = "transparent";
                      event.currentTarget.style.boxShadow = "none";
                    }}
                  />
                </div>
              ))}
            </div>

            <button
              onClick={addIncomeStream}
              style={{
                marginTop: 20,
                background: "linear-gradient(90deg,#0077ff,#00d8ff)",
                border: "1px solid rgba(120,220,255,.45)",
                borderRadius: 10,
                color: "white",
                padding: "12px 18px",
                fontWeight: 800,
                cursor: "pointer",
                boxShadow: "0 0 24px rgba(0,136,255,.28)",
                letterSpacing: 0.4,
                alignSelf: "center",
              }}
            >
              + Add Income Stream
            </button>
          </div>

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
                <div style={{ color: "white", fontSize: 22, fontWeight: 800 }}>
                  Income Command Center
                </div>
                <div style={{ color: "#8ea8ca", marginTop: 8, fontSize: 16 }}>
                  Income pulls from Monthly Income Streams. Budget and spent pull from the same
                  monthly transaction logic used in Budget Command Center.
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
                        {label === "Projected Cash" && value === null
                          ? "—"
                          : label === "Adjustments"
                            ? formatAdjustmentValue(value)
                            : label === "Projected Cash"
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
                    setProjectionAdjustmentsForYear(activePlanningDate.year, (current) => ({
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
                        ? "#5e7da0"
                        : index === currentBudgetMonthIndex
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

      {incomeDeleteTarget ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,5,14,.72)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              ...styles.panel,
              width: 420,
              padding: 26,
              boxShadow: "0 0 55px rgba(0,136,255,.34)",
            }}
          >
            <div
              style={{
                color: "#8feaff",
                fontSize: 12,
                textTransform: "uppercase",
                letterSpacing: 1.2,
                marginBottom: 10,
              }}
            >
              Confirm Delete
            </div>
            <div style={{ color: "white", fontSize: 26, fontWeight: 900, lineHeight: 1.15 }}>
              Delete {incomeDeleteTarget.name}?
            </div>
            <p style={{ color: "#a8bfdc", lineHeight: 1.55, marginTop: 14 }}>
              This removes the income stream from Monthly Income Streams. You can add a new income
              stream anytime.
            </p>
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 24 }}>
              <button
                onClick={() => setIncomeDeleteTarget(null)}
                style={{
                  background: "rgba(0,136,255,.10)",
                  border: "1px solid rgba(0,216,255,.28)",
                  color: "#d7ebff",
                  borderRadius: 8,
                  padding: "11px 16px",
                  cursor: "pointer",
                  fontWeight: 800,
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setIncomeStreamsForYear(activePlanningDate.year, (streams) =>
                    streams.filter((stream) => stream.id !== incomeDeleteTarget.id)
                  );
                  setIncomeDeleteTarget(null);
                }}
                style={{
                  background: "linear-gradient(90deg,#ff244d,#ff5d7a)",
                  border: "1px solid rgba(255,93,122,.55)",
                  color: "white",
                  borderRadius: 8,
                  padding: "11px 16px",
                  cursor: "pointer",
                  fontWeight: 900,
                  boxShadow: "0 0 22px rgba(255,36,77,.32)",
                }}
              >
                Delete Income
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
