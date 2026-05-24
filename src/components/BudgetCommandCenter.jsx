import { useState } from "react";
import { styles } from "../styles.js";
import { money, cleanMoneyInput, parseMoney } from "../utils/format.js";
import { buildMonthlySpendSnapshot } from "../utils/budgetReview.js";
import { getCurrentBudgetPeriod } from "../utils/date.js";
import { budgetMonths, budgetMonthNames } from "../data/constants.jsx";
import { HouseholdProfilesControl, MonthCoverageEditor } from "./Common.jsx";

function buildHeatBarWidth(value, maxValue) {
  const safeValue = Math.abs(Number(value) || 0);
  const safeMax = Math.max(Number(maxValue) || 1, 1);
  if (safeValue === 0) return "0%";
  return `${Math.max(12, (safeValue / safeMax) * 100)}%`;
}

export function BudgetCommandCenter({
  transactions,
  householdProfilesProps,
  currentPlanYear,
  availablePlanningYears,
  getBudgetRowsForYear,
  getIncomeStreamsForYear,
  setBudgetRowsForYear,
  ensurePlanningYear,
}) {
  const currentBudgetPeriod = getCurrentBudgetPeriod();
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [activeBudgetDate, setActiveBudgetDate] = useState(() => ({
    monthIndex: currentBudgetPeriod.monthIndex,
    year: currentPlanYear,
  }));
  const activeBudgetMonth = budgetMonths[activeBudgetDate.monthIndex];
  const activeBudgetLabel = `${budgetMonthNames[activeBudgetMonth]} ${activeBudgetDate.year}`;
  const planningBudgetRows = getBudgetRowsForYear(activeBudgetDate.year);
  const updateBudgetDate = (field, value) => {
    const nextValue = Number(value);
    if (field === "year") {
      ensurePlanningYear(nextValue);
    }

    setActiveBudgetDate((current) => ({
      ...current,
      [field]: nextValue,
    }));
  };

  const shiftBudgetMonth = (delta) => {
    const nextDate = new Date(
      activeBudgetDate.year,
      activeBudgetDate.monthIndex + Number(delta || 0),
      1
    );
    const nextYear = nextDate.getFullYear();
    ensurePlanningYear(nextYear);
    setActiveBudgetDate({
      monthIndex: nextDate.getMonth(),
      year: nextYear,
    });
  };

  const activeBudgetSnapshot = buildMonthlySpendSnapshot(
    transactions,
    planningBudgetRows,
    {
      month: activeBudgetMonth,
      year: activeBudgetDate.year,
    }
  );
  const budgetRowsWithSpend = activeBudgetSnapshot.rows;
  const budgetTotal = activeBudgetSnapshot.monthlyBudget;
  const planningIncomeStreams = getIncomeStreamsForYear(activeBudgetDate.year);
  const monthIncomeTotal = planningIncomeStreams
    .filter((stream) => (stream.months || budgetMonths).includes(activeBudgetMonth))
    .reduce((sum, stream) => sum + parseMoney(stream.amount), 0);
  const monthCashFlow = monthIncomeTotal - budgetTotal;
  const scorecardBarMax = Math.max(
    Math.abs(monthIncomeTotal),
    Math.abs(budgetTotal),
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
      value: budgetTotal,
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

  const updateBudgetRow = (id, field, value) => {
    setBudgetRowsForYear(activeBudgetDate.year, (rows) =>
      rows.map((row) => {
        if (row.id !== id) return row;
        if (field === "name") {
          return {
            ...row,
            name: value,
            transactionCategories: Array.from(
              new Set([value, ...(row.transactionCategories || [])].filter(Boolean))
            ),
          };
        }
        return { ...row, [field]: cleanMoneyInput(value) };
      })
    );
  };

  const setBudgetRowMonths = (id, nextMonths) => {
    const normalizedMonths = budgetMonths.filter((month) => nextMonths.includes(month));
    const safeMonths = normalizedMonths.length ? normalizedMonths : [activeBudgetMonth];

    setBudgetRowsForYear(activeBudgetDate.year, (rows) =>
      rows.map((row) => (row.id === id ? { ...row, months: safeMonths } : row))
    );
  };

  const toggleBudgetMonth = (id, month) => {
    setBudgetRowsForYear(activeBudgetDate.year, (rows) =>
      rows.map((row) => {
        if (row.id !== id) return row;
        const currentMonths = row.months || budgetMonths;
        const nextMonths = currentMonths.includes(month)
          ? currentMonths.filter((item) => item !== month)
          : [...currentMonths, month];
        return { ...row, months: nextMonths.length ? nextMonths : [month] };
      })
    );
  };

  const addBudgetCategory = () => {
    setBudgetRowsForYear(activeBudgetDate.year, (rows) => {
      const nextNumber = rows.length + 1;
      const newName = `New Category ${nextNumber}`;
      const newId = `budget-custom-${Date.now()}-${nextNumber}`;
      return [
        ...rows,
        {
          id: newId,
          dot: "#00d8ff",
          icon: "✦",
          name: newName,
          budget: 0,
          color: "#00d8ff",
          transactionCategories: [newName],
          months: budgetMonths,
        },
      ];
    });
  };

  return (
    <>
      <header style={{ ...styles.pageHeader, marginBottom: 20 }}>
        <div>
          <h1 style={styles.pageTitle}>Budget Strategy Lab</h1>
          <p style={styles.pageSubtitle}>
            Mission-control view of monthly spending, budget pressure, and category risk.
          </p>
        </div>
        <HouseholdProfilesControl {...householdProfilesProps} />
      </header>

      <section
        style={{
          ...styles.panel,
          minHeight: 165,
          padding: "26px 40px",
          borderRadius: 32,
          display: "grid",
          gridTemplateColumns: "1fr minmax(280px, 340px) 1fr",
          alignItems: "center",
          marginBottom: 38,
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 18,
            right: 24,
            zIndex: 1,
          }}
        >
          <select
            value={activeBudgetDate.year}
            onChange={(event) => updateBudgetDate("year", event.target.value)}
            aria-label="Select budget planning year"
            style={{
              color: "#8feaff",
              background: "rgba(0,136,255,.12)",
              border: "1px solid rgba(0,216,255,.32)",
              borderRadius: 999,
              padding: "10px 16px",
              cursor: "pointer",
              fontWeight: 900,
              boxShadow: "0 0 14px rgba(0,136,255,.14)",
              minWidth: 96,
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
        <div style={{ textAlign: "center", display: "grid", justifyItems: "center" }}>
          <div style={{ color: "#e9f3ff", fontSize: 38, fontWeight: 800 }}>{money(monthIncomeTotal)}</div>
          <div style={{ color: "#668ab9", fontSize: 26, fontWeight: 700, marginTop: 16 }}>
            income in {activeBudgetLabel}
          </div>
          <button
            type="button"
            onClick={() => shiftBudgetMonth(-1)}
            aria-label="Go to previous month"
            style={{
              marginTop: 12,
              height: 40,
              minWidth: 108,
              borderRadius: 999,
              border: "1px solid rgba(0,216,255,.28)",
              background: "linear-gradient(180deg, rgba(0,136,255,.18), rgba(0,43,87,.28))",
              color: "#dff7ff",
              cursor: "pointer",
              fontSize: 15,
              fontWeight: 700,
              letterSpacing: 0.35,
              boxShadow:
                "0 0 18px rgba(0,136,255,.18), inset 0 0 16px rgba(143,234,255,.08)",
            }}
          >
            ← Prev
          </button>
        </div>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div
            style={{
              width: "100%",
              maxWidth: 320,
              borderRadius: 24,
              padding: "14px 14px 14px",
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
                  padding: "10px 10px 8px",
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    color: "white",
                    fontSize: 20,
                    fontWeight: 700,
                    letterSpacing: 0.2,
                    textShadow: "0 0 14px rgba(0,216,255,.16)",
                  }}
                >
                  {budgetMonthNames[activeBudgetMonth]}
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
        <div style={{ textAlign: "center", display: "grid", justifyItems: "center" }}>
          <div style={{ color: "#e9f3ff", fontSize: 38, fontWeight: 800 }}>
            {money(budgetTotal)}
          </div>
          <div style={{ color: "#668ab9", fontSize: 26, fontWeight: 700, marginTop: 16 }}>
            budget in {activeBudgetLabel}
          </div>
          <button
            type="button"
            onClick={() => shiftBudgetMonth(1)}
            aria-label="Go to next month"
            style={{
              marginTop: 12,
              height: 40,
              minWidth: 108,
              borderRadius: 999,
              border: "1px solid rgba(0,216,255,.28)",
              background: "linear-gradient(180deg, rgba(0,136,255,.18), rgba(0,43,87,.28))",
              color: "#dff7ff",
              cursor: "pointer",
              fontSize: 15,
              fontWeight: 700,
              letterSpacing: 0.35,
              boxShadow:
                "0 0 18px rgba(0,136,255,.18), inset 0 0 16px rgba(143,234,255,.08)",
            }}
          >
            Next →
          </button>
        </div>
      </section>

      <section style={{ padding: "0 8px" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.15fr 120px 1fr 120px",
            alignItems: "center",
            color: "#6d92c2",
            fontSize: 20,
            fontWeight: 800,
            marginBottom: 22,
          }}
        >
          <div
            style={{
              color: "#e6efff",
              fontSize: 30,
              display: "flex",
              alignItems: "center",
              gap: 18,
            }}
          >
            <span style={{ color: "#395d83", fontSize: 22 }}>▾</span>Regular categories
          </div>
          <div style={{ textAlign: "right" }}>SPENT</div>
          <div />
          <div style={{ textAlign: "center" }}>BUDGET</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          {budgetRowsWithSpend.map((item) => (
            <div
              key={item.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1.15fr 120px 1fr 120px",
                alignItems: "center",
                columnGap: 32,
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto auto 1fr",
                  alignItems: "center",
                  gap: 20,
                  color: "#e6efff",
                  fontSize: 23,
                  fontWeight: 700,
                }}
              >
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 999,
                    background: item.dot,
                    boxShadow: `0 0 12px ${item.dot}`,
                  }}
                />
                <button
                  type="button"
                  onDoubleClick={(event) => {
                    if (item.name === "Other") return;
                    event.preventDefault();
                    event.stopPropagation();
                    setDeleteTarget({ id: item.id, name: item.name });
                  }}
                  title={item.name === "Other" ? "Other is required" : "Double click to delete category"}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#e6efff",
                    fontSize: 20,
                    background: "rgba(0,136,255,.08)",
                    border: "1px solid rgba(0,216,255,.14)",
                    cursor: item.name === "Other" ? "default" : "pointer",
                    boxShadow: "inset 0 0 14px rgba(0,80,160,.05)",
                    opacity: item.name === "Other" ? 0.68 : 1,
                  }}
                >
                  {item.icon}
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: 14, width: "100%" }}>
                  <input
                    value={item.name}
                    onChange={(event) => updateBudgetRow(item.id, "name", event.target.value)}
                    style={{
                      color: "#e6efff",
                      fontSize: 23,
                      fontWeight: 700,
                      background: "transparent",
                      border: "1px solid transparent",
                      borderRadius: 8,
                      padding: "6px 8px",
                      width: 260,
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

                  <div
                    style={{
                      display: "grid",
                      marginLeft: 6,
                      minWidth: 0,
                    }}
                  >
                    <MonthCoverageEditor
                      allMonths={budgetMonths}
                      selectedMonths={item.months || budgetMonths}
                      onToggleMonth={(month) => toggleBudgetMonth(item.id, month)}
                      quickActions={[
                        { label: "All", onClick: () => setBudgetRowMonths(item.id, budgetMonths) },
                        {
                          label: `Only ${activeBudgetMonth}`,
                          onClick: () => setBudgetRowMonths(item.id, [activeBudgetMonth]),
                        },
                      ]}
                    />
                  </div>
                </div>
              </div>

              <div
                style={{
                  color: "#e6efff",
                  fontSize: 22,
                  fontWeight: 800,
                  textAlign: "right",
                  padding: "8px 10px",
                  width: "100%",
                }}
              >
                {money(item.spent)}
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
                    width:
                      Math.min(
                        100,
                        item.budget > 0 ? Math.round((item.spent / item.budget) * 100) : 0
                      ) + "%",
                    height: "100%",
                    borderRadius: 999,
                    background: item.color,
                    boxShadow: `0 0 14px ${item.color}`,
                  }}
                />
                {item.spent > item.budget ? (
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
              <input
                value={money(item.budget)}
                onChange={(event) => updateBudgetRow(item.id, "budget", event.target.value)}
                style={{
                  color: "#e6efff",
                  fontSize: 22,
                  fontWeight: 800,
                  textAlign: "center",
                  background: "transparent",
                  border: "1px solid transparent",
                  borderRadius: 10,
                  padding: "8px 10px",
                  width: "100%",
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

        <div style={{ marginTop: 28, display: "flex", justifyContent: "center" }}>
          <button
            onClick={addBudgetCategory}
            style={{
              background: "linear-gradient(90deg,#0077ff,#00d8ff)",
              border: "1px solid rgba(120,220,255,.45)",
              borderRadius: 10,
              color: "white",
              padding: "14px 24px",
              fontWeight: 800,
              cursor: "pointer",
              boxShadow: "0 0 28px rgba(0,136,255,.35)",
              letterSpacing: 0.4,
            }}
          >
            + Add Budget Category
          </button>
        </div>
      </section>

      {deleteTarget ? (
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
              Delete {deleteTarget.name}?
            </div>
            <p style={{ color: "#a8bfdc", lineHeight: 1.55, marginTop: 14 }}>
              This removes the category from Budget Strategy Lab. Transactions stay safe and will
              roll into Other if they no longer match a category.
            </p>
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 24 }}>
              <button
                onClick={() => setDeleteTarget(null)}
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
                  setBudgetRowsForYear(activeBudgetDate.year, (rows) =>
                    rows.filter((row) => row.id !== deleteTarget.id)
                  );
                  setDeleteTarget(null);
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
                Delete Category
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
