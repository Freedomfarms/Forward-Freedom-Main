import { useState } from "react";
import { styles } from "../styles.js";
import { money, cleanMoneyInput } from "../utils/format.js";
import { buildBudgetRowsWithSpend } from "../utils/budgetReview.js";
import { getCurrentBudgetPeriod } from "../utils/date.js";
import { budgetMonths, budgetMonthNames } from "../data/constants.jsx";
import { MonthCoverageEditor } from "./Common.jsx";

export function BudgetCommandCenter({ transactions, budgetRows, setBudgetRows }) {
  const currentBudgetPeriod = getCurrentBudgetPeriod();
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [activeBudgetDate, setActiveBudgetDate] = useState(() => ({
    monthIndex: currentBudgetPeriod.monthIndex,
    year: currentBudgetPeriod.year,
  }));
  const activeBudgetMonth = budgetMonths[activeBudgetDate.monthIndex];
  const activeBudgetLabel = `${budgetMonthNames[activeBudgetMonth]} ${activeBudgetDate.year}`;
  const changeBudgetMonth = (direction) => {
    setActiveBudgetDate((current) => {
      const rawMonth = current.monthIndex + direction;
      if (rawMonth < 0) return { monthIndex: 11, year: current.year - 1 };
      if (rawMonth > 11) return { monthIndex: 0, year: current.year + 1 };
      return { ...current, monthIndex: rawMonth };
    });
  };

  const budgetRowsWithSpend = buildBudgetRowsWithSpend(
    transactions,
    budgetRows,
    activeBudgetMonth,
    activeBudgetDate.year
  );

  const spentTotal = budgetRowsWithSpend.reduce((sum, item) => sum + item.spent, 0);
  const budgetTotal = budgetRowsWithSpend.reduce((sum, item) => sum + item.budget, 0);
  const updateBudgetRow = (id, field, value) => {
    setBudgetRows((rows) =>
      rows.map((row) => {
        if (row.id !== id) return row;
        if (field === "name") {
          return { ...row, name: value, transactionCategories: [value] };
        }
        return { ...row, [field]: cleanMoneyInput(value) };
      })
    );
  };

  const setBudgetRowMonths = (id, nextMonths) => {
    const normalizedMonths = budgetMonths.filter((month) => nextMonths.includes(month));
    const safeMonths = normalizedMonths.length ? normalizedMonths : [activeBudgetMonth];

    setBudgetRows((rows) =>
      rows.map((row) => (row.id === id ? { ...row, months: safeMonths } : row))
    );
  };

  const toggleBudgetMonth = (id, month) => {
    setBudgetRows((rows) =>
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
    setBudgetRows((rows) => {
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
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 20,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 30, lineHeight: 1.1, color: "white", fontWeight: 700 }}>
            Budget Command Center
          </h1>
          <p style={{ margin: "6px 0 0", color: "#9fb0c9" }}>
            Mission-control view of monthly spending, budget pressure, and category risk.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            onClick={() => changeBudgetMonth(-1)}
            style={{
              color: "#c9d8ee",
              background: "rgba(1,10,24,.55)",
              border: "1px solid rgba(54,126,220,.28)",
              borderRadius: 7,
              padding: "10px 13px",
              cursor: "pointer",
              fontWeight: 900,
              boxShadow: "0 0 14px rgba(0,136,255,.12)",
            }}
          >
            ←
          </button>

          <div
            style={{
              minWidth: 180,
              textAlign: "center",
              color: "#00d8ff",
              background: "rgba(0,104,255,.18)",
              border: "1px solid rgba(0,216,255,.55)",
              borderRadius: 7,
              padding: "10px 16px",
              fontWeight: 900,
              boxShadow: "0 0 18px rgba(0,136,255,.22)",
            }}
          >
            {activeBudgetLabel}
          </div>

          <button
            onClick={() => changeBudgetMonth(1)}
            style={{
              color: "#c9d8ee",
              background: "rgba(1,10,24,.55)",
              border: "1px solid rgba(54,126,220,.28)",
              borderRadius: 7,
              padding: "10px 13px",
              cursor: "pointer",
              fontWeight: 900,
              boxShadow: "0 0 14px rgba(0,136,255,.12)",
            }}
          >
            →
          </button>
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
          <div style={{ color: "#e9f3ff", fontSize: 38, fontWeight: 800 }}>{money(spentTotal)}</div>
          <div style={{ color: "#668ab9", fontSize: 26, fontWeight: 700, marginTop: 16 }}>
            spent in {activeBudgetMonth}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div
            style={{
              width: 150,
              height: 150,
              borderRadius: 999,
              padding: 18,
              background:
                "conic-gradient(#ef6b3b 0 70%, #f0559a 70% 82%, #e650df 82% 90%, #20bfc7 90% 95%, #4aa5ff 95% 100%)",
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
              }}
            />
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ color: "#e9f3ff", fontSize: 38, fontWeight: 800 }}>
            {money(budgetTotal)}
          </div>
          <div style={{ color: "#668ab9", fontSize: 26, fontWeight: 700, marginTop: 16 }}>
            total budget
          </div>
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
                    event.preventDefault();
                    event.stopPropagation();
                    setDeleteTarget({ id: item.id, name: item.name });
                  }}
                  title="Double click to delete category"
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
                    cursor: "pointer",
                    boxShadow: "inset 0 0 14px rgba(0,80,160,.05)",
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
              This removes the category from Budget Command Center. Transactions stay safe and will
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
                  setBudgetRows((rows) => rows.filter((row) => row.id !== deleteTarget.id));
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
