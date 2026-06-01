import { useState } from "react";
import { styles } from "../styles.js";
import { budgetMonths, budgetMonthNames } from "../data/constants.jsx";
import { getCurrentBudgetPeriod } from "../utils/date.js";
import { money, parseMoney, wholeDollars } from "../utils/format.js";
import { buildIncomeStreamsWithReceived, sumActualIncomeForMonth } from "../utils/budgetReview.js";
import { HouseholdProfilesControl, MonthCoverageEditor } from "./Common.jsx";

function buildHeatBarWidth(value, maxValue) {
  const safeValue = Math.abs(Number(value) || 0);
  const safeMax = Math.max(Number(maxValue) || 1, 1);
  if (safeValue === 0) return "0%";
  return `${Math.max(12, (safeValue / safeMax) * 100)}%`;
}

export function IncomeHub({
  transactions = [],
  householdProfilesProps,
  currentPlanYear,
  availablePlanningYears,
  getBudgetRowsForYear,
  getIncomeStreamsForYear,
  setIncomeStreamsForYear,
  ensurePlanningYear,
}) {
  const [incomeDeleteTarget, setIncomeDeleteTarget] = useState(null);
  const currentBudgetPeriod = getCurrentBudgetPeriod();
  const [activeIncomeDate, setActiveIncomeDate] = useState(() => ({
    monthIndex: currentBudgetPeriod.monthIndex,
    year: currentPlanYear,
  }));

  const activeIncomeMonth = budgetMonths[activeIncomeDate.monthIndex];
  const activeIncomeLabel = `${budgetMonthNames[activeIncomeMonth]} ${activeIncomeDate.year}`;
  const planningBudgetRows = getBudgetRowsForYear(activeIncomeDate.year);
  const planningIncomeStreams = getIncomeStreamsForYear(activeIncomeDate.year);
  const incomeStreamsWithReceived = buildIncomeStreamsWithReceived(
    transactions,
    planningIncomeStreams,
    activeIncomeMonth,
    activeIncomeDate.year
  );
  const incomeReceivedById = new Map(incomeStreamsWithReceived.map((entry) => [entry.id, entry]));

  const updateIncomeDate = (field, value) => {
    const nextValue = Number(value);
    if (field === "year") {
      ensurePlanningYear(nextValue);
    }

    setActiveIncomeDate((current) => ({
      ...current,
      [field]: nextValue,
    }));
  };

  const shiftIncomeMonth = (delta) => {
    const nextDate = new Date(
      activeIncomeDate.year,
      activeIncomeDate.monthIndex + Number(delta || 0),
      1
    );
    const nextYear = nextDate.getFullYear();
    ensurePlanningYear(nextYear);
    setActiveIncomeDate({
      monthIndex: nextDate.getMonth(),
      year: nextYear,
    });
  };

  const addIncomeStream = () => {
    setIncomeStreamsForYear(activeIncomeDate.year, (streams) => {
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
          transactionMerchants: [],
        },
      ];
    });
  };

  const toggleIncomeMonth = (index, month) => {
    setIncomeStreamsForYear(activeIncomeDate.year, (streams) =>
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
    const safeMonths = normalizedMonths.length ? normalizedMonths : [activeIncomeMonth];

    setIncomeStreamsForYear(activeIncomeDate.year, (streams) =>
      streams.map((stream, streamIndex) =>
        streamIndex === index ? { ...stream, months: safeMonths } : stream
      )
    );
  };

  const monthIncomeTotal = planningIncomeStreams
    .filter((stream) => (stream.months || budgetMonths).includes(activeIncomeMonth))
    .reduce((sum, stream) => sum + parseMoney(stream.amount), 0);
  const monthIncomeEarned = sumActualIncomeForMonth(
    transactions,
    activeIncomeMonth,
    activeIncomeDate.year
  );
  const incomeRemainingToGoal = monthIncomeTotal - monthIncomeEarned;
  const incomeEarnedPercent = monthIncomeTotal > 0 ? (monthIncomeEarned / monthIncomeTotal) * 100 : 0;
  const normalizedIncomeEarnedPercent = Math.max(0, Math.min(100, incomeEarnedPercent));
  const incomeEarnedGradient =
    monthIncomeTotal <= 0
      ? "conic-gradient(rgba(255,255,255,.10) 0 100%)"
      : `conic-gradient(#00f59b 0 ${normalizedIncomeEarnedPercent.toFixed(
          2
        )}%, rgba(255,255,255,.08) ${normalizedIncomeEarnedPercent.toFixed(2)}% 100%)`;
  const monthBudgetTotal = planningBudgetRows
    .filter((category) => (category.months || budgetMonths).includes(activeIncomeMonth))
    .reduce((sum, category) => sum + Number(category.budget || 0), 0);
  const monthCashFlow = monthIncomeTotal - monthBudgetTotal;
  const scorecardBarMax = Math.max(
    Math.abs(monthIncomeTotal),
    Math.abs(monthBudgetTotal),
    Math.abs(monthCashFlow),
    1
  );
  const heatBars = [
    {
      label: "Income",
      value: monthIncomeTotal,
      accent: "#20c8ff",
      glow: "rgba(32,200,255,.55)",
      gradient: "linear-gradient(90deg,#14b8ff 0%, #00d8ff 52%, #7ef4ff 100%)",
    },
    {
      label: "Budget",
      value: monthBudgetTotal,
      accent: "#4aa5ff",
      glow: "rgba(74,165,255,.48)",
      gradient: "linear-gradient(90deg,#1e87ff 0%, #3cbcff 50%, #9ceaff 100%)",
    },
    {
      label: "Cash Flow",
      value: monthCashFlow,
      accent: monthCashFlow >= 0 ? "#00f59b" : "#ff5d7a",
      glow: monthCashFlow >= 0 ? "rgba(0,245,155,.52)" : "rgba(255,93,122,.48)",
      gradient:
        monthCashFlow >= 0
          ? "linear-gradient(90deg,#00c96f 0%, #00f59b 48%, #86ffd2 100%)"
          : "linear-gradient(90deg,#ff3d67 0%, #ff5d7a 50%, #ffb3c1 100%)",
    },
  ];

  return (
    <div style={{ fontFamily: styles.page.fontFamily }}>
      <header style={{ ...styles.pageHeader, marginBottom: 20 }}>
        <div>
          <h1 style={styles.pageTitle}>Income Hub</h1>
          <p style={styles.pageSubtitle}>
            Monthly income planning, source editing, and budget-to-income alignment.
          </p>
        </div>
        <HouseholdProfilesControl {...householdProfilesProps} />
      </header>

      <section
        style={{
          ...styles.panel,
          minHeight: 0,
          padding: "20px 26px 22px",
          borderRadius: 32,
          display: "grid",
          gridTemplateColumns: "1fr minmax(280px, 340px) 1fr",
          alignItems: "center",
          marginBottom: 38,
          position: "relative",
        }}
      >
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div
            style={{
              width: 192,
              height: 192,
              borderRadius: "50%",
              position: "relative",
              display: "grid",
              placeItems: "center",
              background: incomeEarnedGradient,
              boxShadow:
                incomeRemainingToGoal > 0
                  ? "0 0 34px rgba(0,216,255,.18), inset 0 0 42px rgba(0,216,255,.08)"
                  : "0 0 34px rgba(0,245,155,.2), inset 0 0 42px rgba(0,245,155,.1)",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: 12,
                borderRadius: "50%",
                background:
                  "radial-gradient(circle at 30% 25%, rgba(255,255,255,.08), rgba(3,16,31,.98) 62%)",
                border:
                  incomeRemainingToGoal > 0
                    ? "1px solid rgba(0,216,255,.24)"
                    : "1px solid rgba(0,245,155,.28)",
              }}
            />
            <div
              style={{
                position: "relative",
                zIndex: 1,
                display: "grid",
                justifyItems: "center",
                textAlign: "center",
                gap: 8,
                width: 128,
              }}
            >
              <div
                style={{
                  color: incomeRemainingToGoal > 0 ? "#8feaff" : "#a7ffd9",
                  fontSize: 11,
                  fontWeight: 900,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                }}
              >
                Income Earned
              </div>
              <div
                style={{
                  color: "white",
                  fontSize: 26,
                  fontWeight: 900,
                  lineHeight: 1,
                }}
              >
                {Math.round(monthIncomeTotal > 0 ? normalizedIncomeEarnedPercent : 0)}%
              </div>
              <div
                style={{
                  color: incomeRemainingToGoal > 0 ? "#dff7ff" : "#a7ffd9",
                  fontSize: 20,
                  fontWeight: 900,
                  lineHeight: 1.1,
                }}
              >
                {incomeRemainingToGoal > 0
                  ? wholeDollars(incomeRemainingToGoal)
                  : `+${wholeDollars(Math.abs(incomeRemainingToGoal))}`}
              </div>
              <div style={{ color: "#7fa1ca", fontSize: 11, lineHeight: 1.4 }}>
                {incomeRemainingToGoal > 0 ? "remaining to plan" : "above plan this month"}
              </div>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div
            style={{
              width: "100%",
              maxWidth: 300,
              borderRadius: 24,
              padding: "12px",
              border: "1px solid rgba(0,216,255,.22)",
              background:
                "linear-gradient(180deg, rgba(4,22,43,.96), rgba(2,11,24,.94))",
              boxShadow:
                "0 0 28px rgba(0,136,255,.18), inset 0 0 22px rgba(0,216,255,.05)",
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                background:
                  "radial-gradient(circle at top center, rgba(0,216,255,.12), transparent 42%)",
                pointerEvents: "none",
              }}
            />
            <div
              style={{
                position: "relative",
                display: "grid",
                gap: 8,
              }}
            >
              <div
                style={{
                  position: "relative",
                  borderRadius: 18,
                  border: "1px solid rgba(0,216,255,.18)",
                  background:
                    "linear-gradient(180deg, rgba(8,31,58,.95), rgba(3,18,36,.92))",
                  boxShadow: "inset 0 0 18px rgba(0,216,255,.05)",
                  padding: "8px 10px 7px",
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    color: "white",
                    fontSize: 18,
                    fontWeight: 700,
                    letterSpacing: 0.2,
                    textShadow: "0 0 14px rgba(0,216,255,.16)",
                  }}
                >
                  {budgetMonthNames[activeIncomeMonth]}
                </div>
              </div>
              <div style={{ position: "relative", display: "grid", gap: 10 }}>
              {heatBars.map((bar) => (
                <div key={bar.label} style={{ display: "grid", gap: 5 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <span
                      style={{
                        color: bar.accent,
                        fontSize: 10,
                        fontWeight: 800,
                        textTransform: "uppercase",
                        letterSpacing: 0.75,
                      }}
                    >
                      {bar.label}
                    </span>
                    <span
                      style={{
                        color: "white",
                        fontSize: 12,
                        fontWeight: 800,
                        textShadow: `0 0 10px ${bar.glow}`,
                      }}
                    >
                      {bar.label === "Cash Flow" && bar.value > 0 ? "+" : ""}
                      {money(bar.value)}
                    </span>
                  </div>
                  <div
                    style={{
                      height: 11,
                      borderRadius: 999,
                      background: "rgba(6,22,40,.96)",
                      border: "1px solid rgba(74,126,220,.18)",
                      boxShadow: "inset 0 0 16px rgba(0,0,0,.45)",
                      overflow: "hidden",
                      position: "relative",
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        background:
                          "linear-gradient(90deg, rgba(255,255,255,.04), rgba(255,255,255,0))",
                        pointerEvents: "none",
                      }}
                    />
                    <div
                      style={{
                        height: "100%",
                        width: buildHeatBarWidth(bar.value, scorecardBarMax),
                        minWidth: bar.value === 0 ? 0 : 10,
                        borderRadius: 999,
                        background: bar.gradient,
                        boxShadow: `0 0 18px ${bar.glow}`,
                        position: "relative",
                      }}
                    >
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          background:
                            "linear-gradient(180deg, rgba(255,255,255,.38), rgba(255,255,255,0))",
                          mixBlendMode: "screen",
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
              </div>
            </div>
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 12,
            alignItems: "start",
            alignSelf: "stretch",
          }}
        >
          <div style={{ textAlign: "center", display: "grid", justifyItems: "center" }}>
            <div style={{ color: "#e9f3ff", fontSize: 26, fontWeight: 800 }}>
              {money(monthIncomeEarned)}
            </div>
            <div style={{ color: "#668ab9", fontSize: 16, fontWeight: 700, marginTop: 8 }}>
              {budgetMonthNames[activeIncomeMonth]} Earned
            </div>
            <button
              type="button"
              onClick={() => shiftIncomeMonth(-1)}
              aria-label="Go to previous month"
              style={{
                marginTop: 10,
                height: 36,
                minWidth: 100,
                borderRadius: 999,
                border: "1px solid rgba(0,216,255,.28)",
                background: "linear-gradient(180deg, rgba(0,136,255,.18), rgba(0,43,87,.28))",
                color: "#dff7ff",
                cursor: "pointer",
                fontSize: 14,
                fontWeight: 700,
                letterSpacing: 0.35,
                boxShadow:
                  "0 0 18px rgba(0,136,255,.18), inset 0 0 16px rgba(143,234,255,.08)",
              }}
            >
              ← Prev
            </button>
          </div>
          <div style={{ textAlign: "center", display: "grid", justifyItems: "center" }}>
            <div style={{ color: "#e9f3ff", fontSize: 26, fontWeight: 800 }}>
              {money(monthIncomeTotal)}
            </div>
            <div style={{ color: "#668ab9", fontSize: 16, fontWeight: 700, marginTop: 8 }}>
              {budgetMonthNames[activeIncomeMonth]} Planned
            </div>
            <button
              type="button"
              onClick={() => shiftIncomeMonth(1)}
              aria-label="Go to next month"
              style={{
                marginTop: 10,
                height: 36,
                minWidth: 100,
                borderRadius: 999,
                border: "1px solid rgba(0,216,255,.28)",
                background: "linear-gradient(180deg, rgba(0,136,255,.18), rgba(0,43,87,.28))",
                color: "#dff7ff",
                cursor: "pointer",
                fontSize: 14,
                fontWeight: 700,
                letterSpacing: 0.35,
                boxShadow:
                  "0 0 18px rgba(0,136,255,.18), inset 0 0 16px rgba(143,234,255,.08)",
              }}
            >
              Next →
            </button>
          </div>
          <div
            style={{
              gridColumn: "1 / -1",
              display: "flex",
              justifyContent: "flex-end",
              alignItems: "center",
              alignSelf: "end",
            }}
          >
            <select
              value={activeIncomeDate.year}
              onChange={(event) => updateIncomeDate("year", event.target.value)}
              aria-label="Select income planning year"
              style={{
                color: "#8feaff",
                background: "rgba(0,136,255,.12)",
                border: "1px solid rgba(0,216,255,.32)",
                borderRadius: 999,
                padding: "8px 14px",
                cursor: "pointer",
                fontWeight: 900,
                boxShadow: "0 0 14px rgba(0,136,255,.14)",
                minWidth: 96,
                height: 36,
                textAlign: "center",
              }}
            >
              {availablePlanningYears.map((year) => (
                <option key={year} value={year} style={{ background: "#061224", color: "#eaf3ff" }}>
                  {year}
                </option>
              ))}
            </select>
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
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "radial-gradient(circle at top right, rgba(0,216,255,.13), transparent 36%)",
          }}
        />
        <div style={{ position: "relative", zIndex: 1 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 24,
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ color: "white", fontSize: 22, fontWeight: 800 }}>Monthly Income Streams</div>
              <div style={{ color: "#8ea8ca", marginTop: 8, fontSize: 16 }}>
                Manage recurring and variable income sources for {activeIncomeLabel}.
              </div>
            </div>
            <div style={{ color: "#00f59b", fontSize: 14, fontWeight: 800 }}>+ Stable Cashflow</div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 18, marginTop: 4 }}>
            {planningIncomeStreams.map((income, index) => {
              const inMonth = (income.months || budgetMonths).includes(activeIncomeMonth);
              const tracked = incomeReceivedById.get(income.id);
              const received = tracked?.received ?? 0;
              const expected = tracked?.expected ?? parseMoney(income.amount);
              const fillPercent =
                expected > 0
                  ? Math.min(100, Math.round((received / expected) * 100))
                  : received > 0
                    ? 100
                    : 0;

              return (
                <div
                  key={income.id}
                  style={{
                    border: "1px solid rgba(0,136,255,.16)",
                    borderRadius: 14,
                    background: "rgba(2,14,28,.72)",
                    padding: "16px 18px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 14,
                    boxShadow: "inset 0 0 18px rgba(0,80,160,.06)",
                  }}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "auto 1fr auto",
                      alignItems: "center",
                      gap: 16,
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
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                        <input
                          value={income.name}
                          onChange={(event) =>
                            setIncomeStreamsForYear(activeIncomeDate.year, (streams) =>
                              streams.map((stream, streamIndex) =>
                                streamIndex === index ? { ...stream, name: event.target.value } : stream
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
                            setIncomeStreamsForYear(activeIncomeDate.year, (streams) =>
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
                      <div style={{ display: "grid", marginTop: 6, minWidth: 0 }}>
                        <div style={{ color: "#00f59b", fontSize: 13, fontWeight: 800 }}>{income.type}</div>
                        <MonthCoverageEditor
                          allMonths={budgetMonths}
                          selectedMonths={income.months || budgetMonths}
                          onToggleMonth={(month) => toggleIncomeMonth(index, month)}
                          quickActions={[
                            { label: "All", onClick: () => setIncomeMonths(index, budgetMonths) },
                            {
                              label: `Only ${activeIncomeMonth}`,
                              onClick: () => setIncomeMonths(index, [activeIncomeMonth]),
                            },
                          ]}
                        />
                      </div>
                    </div>

                    <input
                      value={income.amount}
                      onChange={(event) =>
                        setIncomeStreamsForYear(activeIncomeDate.year, (streams) =>
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

                  {inMonth ? (
                    <div
                      style={{
                        display: "grid",
                        gap: 8,
                        paddingTop: 4,
                        borderTop: "1px solid rgba(0,136,255,.14)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          flexWrap: "wrap",
                          gap: 10,
                        }}
                      >
                        <span
                          style={{
                            color: "#8fb1d9",
                            fontSize: 11,
                            fontWeight: 800,
                            textTransform: "uppercase",
                            letterSpacing: 0.75,
                          }}
                        >
                          Received vs planned ({activeIncomeMonth})
                        </span>
                        <span style={{ color: "#eaf3ff", fontSize: 14, fontWeight: 800 }}>
                          {money(received)} / {money(expected)}
                        </span>
                      </div>
                      <div
                        style={{
                          height: 11,
                          borderRadius: 999,
                          background: "rgba(8,28,49,.95)",
                          position: "relative",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${fillPercent}%`,
                            height: "100%",
                            borderRadius: 999,
                            background: income.color || "#00f59b",
                            boxShadow: `0 0 14px ${income.color || "#00f59b"}`,
                          }}
                        />
                        {expected > 0 && received > expected ? (
                          <div
                            style={{
                              position: "absolute",
                              inset: 0,
                              border: "2px solid rgba(255,58,68,.95)",
                              borderRadius: 999,
                            }}
                          />
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{
                        color: "#5f7394",
                        fontSize: 12,
                        paddingTop: 4,
                        borderTop: "1px solid rgba(0,136,255,.14)",
                      }}
                    >
                      Not scheduled for {activeIncomeMonth}; switch month coverage or pick another month
                      above.
                    </div>
                  )}
                </div>
              );
            })}
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
              This removes the income stream from Income Hub. You can add a new income stream anytime.
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
                  setIncomeStreamsForYear(activeIncomeDate.year, (streams) =>
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
