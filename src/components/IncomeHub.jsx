import { useState } from "react";
import { styles } from "../styles.js";
import { budgetMonths, budgetMonthNames } from "../data/constants.jsx";
import { getCurrentBudgetPeriod } from "../utils/date.js";
import { money, parseMoney } from "../utils/format.js";
import { HouseholdProfilesControl, MonthCoverageEditor } from "./Common.jsx";

function buildIncomeDonutGradient(incomeTotal, budgetTotal) {
  const safeIncome = Math.max(Number(incomeTotal) || 0, 0);
  const safeBudget = Math.max(Number(budgetTotal) || 0, 0);
  const total = safeIncome + safeBudget;
  if (total <= 0) {
    return "conic-gradient(rgba(18,53,95,.92) 0 100%)";
  }

  const incomePercent = (safeIncome / total) * 100;
  return `conic-gradient(#00f59b 0 ${incomePercent.toFixed(2)}%, #00d8ff ${incomePercent.toFixed(2)}% 100%)`;
}

export function IncomeHub({
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
  const monthBudgetTotal = planningBudgetRows
    .filter((category) => (category.months || budgetMonths).includes(activeIncomeMonth))
    .reduce((sum, category) => sum + Number(category.budget || 0), 0);
  const donutGradient = buildIncomeDonutGradient(monthIncomeTotal, monthBudgetTotal);

  return (
    <div>
      <header style={{ ...styles.pageHeader, marginBottom: 20 }}>
        <div>
          <h1 style={styles.pageTitle}>Income Hub</h1>
          <p style={styles.pageSubtitle}>
            Monthly income planning, source editing, and budget-to-income alignment.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <HouseholdProfilesControl {...householdProfilesProps} />
          <select
            value={activeIncomeDate.monthIndex}
            onChange={(event) => updateIncomeDate("monthIndex", event.target.value)}
            style={{
              color: "#c9d8ee",
              background: "rgba(1,10,24,.55)",
              border: "1px solid rgba(54,126,220,.28)",
              borderRadius: 7,
              padding: "10px 12px",
              cursor: "pointer",
              fontWeight: 900,
              boxShadow: "0 0 14px rgba(0,136,255,.12)",
              minWidth: 124,
            }}
          >
            {budgetMonths.map((month, index) => (
              <option key={month} value={index} style={{ background: "#061224" }}>
                {budgetMonthNames[month]}
              </option>
            ))}
          </select>
          <select
            value={activeIncomeDate.year}
            onChange={(event) => updateIncomeDate("year", event.target.value)}
            style={{
              color: "#00d8ff",
              background: "rgba(0,104,255,.18)",
              border: "1px solid rgba(0,216,255,.55)",
              borderRadius: 7,
              padding: "10px 12px",
              cursor: "pointer",
              fontWeight: 900,
              boxShadow: "0 0 18px rgba(0,136,255,.22)",
              minWidth: 96,
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
          ...styles.panel,
          minHeight: 190,
          padding: "32px 46px",
          borderRadius: 32,
          display: "grid",
          gridTemplateColumns: "1fr 190px 1fr",
          alignItems: "center",
          marginBottom: 38,
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div style={{ color: "#e9f3ff", fontSize: 38, fontWeight: 800 }}>{money(monthIncomeTotal)}</div>
          <div style={{ color: "#668ab9", fontSize: 26, fontWeight: 700, marginTop: 16 }}>
            income in {activeIncomeLabel}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div
            style={{
              width: 150,
              height: 150,
              borderRadius: 999,
              padding: 18,
              background: donutGradient,
              boxShadow: "0 0 38px rgba(0,136,255,.26)",
            }}
          >
            <div
              style={{
                width: "100%",
                height: "100%",
                borderRadius: 999,
                background: "#031120",
                boxShadow: "inset 0 0 28px rgba(0,0,0,.65)",
                display: "grid",
                placeItems: "center",
                color: "#8fb1d9",
                fontSize: 12,
                fontWeight: 900,
                textTransform: "uppercase",
                letterSpacing: 1,
                textAlign: "center",
                padding: 16,
              }}
            >
              {activeIncomeLabel}
            </div>
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ color: "#e9f3ff", fontSize: 38, fontWeight: 800 }}>
            {money(monthBudgetTotal)}
          </div>
          <div style={{ color: "#668ab9", fontSize: 26, fontWeight: 700, marginTop: 16 }}>
            budget in {activeIncomeLabel}
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
