import { useCallback, useEffect, useRef, useState } from "react";
import { styles } from "../styles.js";
import { money, wholeDollars, cleanMoneyInput, parseMoney } from "../utils/format.js";
import { buildMonthlySpendSnapshot } from "../utils/budgetReview.js";
import { getCurrentBudgetPeriod } from "../utils/date.js";
import {
  budgetMonths,
  budgetMonthNames,
  isUncategorizedCategoryName,
} from "../data/constants.jsx";
import { HouseholdProfilesControl, MonthCoverageEditor } from "./Common.jsx";

function buildHeatBarWidth(value, maxValue) {
  const safeValue = Math.abs(Number(value) || 0);
  const safeMax = Math.max(Number(maxValue) || 1, 1);
  if (safeValue === 0) return "0%";
  return `${Math.max(12, (safeValue / safeMax) * 100)}%`;
}

const BUDGET_SORT_OPTIONS = [
  {
    value: "manual",
    label: "Manual Order",
    description: "Keep the category order you set by dragging rows.",
  },
  {
    value: "budget_desc",
    label: "Largest Budget",
    description: "Highest assigned budget first.",
  },
  {
    value: "budget_asc",
    label: "Smallest Budget",
    description: "Lowest assigned budget first.",
  },
  {
    value: "spent_desc",
    label: "Most Spent",
    description: "Highest spending activity first.",
  },
  {
    value: "remaining_asc",
    label: "Most Over Budget",
    description: "Most overspent categories first.",
  },
  {
    value: "remaining_desc",
    label: "Most Remaining",
    description: "Most dollars still available first.",
  },
];

function sortBudgetRows(rows, sortMode) {
  if (!Array.isArray(rows) || sortMode === "manual") return rows;

  const comparators = {
    budget_desc: (left, right) => (Number(right.budget) || 0) - (Number(left.budget) || 0),
    budget_asc: (left, right) => (Number(left.budget) || 0) - (Number(right.budget) || 0),
    spent_desc: (left, right) => (Number(right.spent) || 0) - (Number(left.spent) || 0),
    remaining_asc: (left, right) => (Number(left.remaining) || 0) - (Number(right.remaining) || 0),
    remaining_desc: (left, right) => (Number(right.remaining) || 0) - (Number(left.remaining) || 0),
  };
  const compare = comparators[sortMode];
  if (!compare) return rows;

  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const sorted = compare(left.row, right.row);
      return sorted !== 0 ? sorted : left.index - right.index;
    })
    .map((entry) => entry.row);
}

function moveBudgetRowById(rows, draggedId, targetId) {
  if (!Array.isArray(rows) || !draggedId || !targetId || draggedId === targetId) return rows;

  const fromIndex = rows.findIndex((row) => row.id === draggedId);
  const toIndex = rows.findIndex((row) => row.id === targetId);
  if (fromIndex < 0 || toIndex < 0) return rows;

  const nextRows = [...rows];
  const [draggedRow] = nextRows.splice(fromIndex, 1);
  nextRows.splice(toIndex, 0, draggedRow);
  return nextRows;
}

function buildBudgetWorkflowStatus(row) {
  const budget = Number(row?.budget) || 0;
  const available = Number(row?.remaining) || 0;

  if (available < 0) {
    return {
      label: "Overspent",
      color: "#ffd9df",
      background: "rgba(255,61,103,.12)",
      border: "1px solid rgba(255,93,122,.28)",
    };
  }

  if (budget <= 0) {
    return {
      label: "Unassigned",
      color: "#ffe4a8",
      background: "rgba(255,159,28,.12)",
      border: "1px solid rgba(255,159,28,.24)",
    };
  }

  return null;
}

function guessBudgetCategoryIcon(name) {
  const normalized = String(name || "").trim().toLowerCase();
  if (!normalized) return "🧩";

  const iconRules = [
    [/housing|rent|mortgage|home|property|utilities/, "🏠"],
    [/grocer|food|dining|restaurant|coffee|meal/, "🍽️"],
    [/transport|car|fuel|gas|travel|uber|lyft|parking/, "🚗"],
    [/health|medical|doctor|pharmacy|fitness|gym/, "🩺"],
    [/shopping|clothes|retail|amazon|target|walmart/, "🛍️"],
    [/debt|loan|credit card|payment/, "💳"],
    [/saving|emergency|reserve|goal|future/, "🛡️"],
    [/income|paycheck|salary|bonus/, "💼"],
    [/kid|child|school|education|tuition/, "🎓"],
    [/entertainment|fun|movies|games|streaming|subscription/, "🎬"],
    [/giving|donation|church|charity|tithe/, "🤝"],
    [/pets?|dog|cat|vet/, "🐾"],
    [/insurance/, "🧾"],
    [/tax/, "🧮"],
    [/other|misc|miscellaneous/, "🧩"],
  ];

  const match = iconRules.find(([pattern]) => pattern.test(normalized));
  return match ? match[1] : "🧩";
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
  const [activeBudgetRowId, setActiveBudgetRowId] = useState(null);
  const [pointerDragBudgetRowId, setPointerDragBudgetRowId] = useState(null);
  const [isSortModalOpen, setIsSortModalOpen] = useState(false);
  const [activeSortMode, setActiveSortMode] = useState("manual");
  const [pendingSortMode, setPendingSortMode] = useState("manual");
  const overspentScrollRef = useRef(null);
  const [activeBudgetDate, setActiveBudgetDate] = useState(() => ({
    monthIndex: currentBudgetPeriod.monthIndex,
    year: currentPlanYear,
  }));
  const activeBudgetMonth = budgetMonths[activeBudgetDate.monthIndex];
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
  const sortedBudgetRowsWithSpend = sortBudgetRows(budgetRowsWithSpend, activeSortMode);
  const budgetTotal = activeBudgetSnapshot.monthlyBudget;
  const planningIncomeStreams = getIncomeStreamsForYear(activeBudgetDate.year);
  const monthIncomeTotal = planningIncomeStreams
    .filter((stream) => (stream.months || budgetMonths).includes(activeBudgetMonth))
    .reduce((sum, stream) => sum + parseMoney(stream.amount), 0);
  // Assume every category lands at budget; only categories that run over budget
  // reduce projected cash flow by their overage.
  const projectedOutflow = budgetRowsWithSpend.reduce(
    (sum, row) => sum + Math.max(Number(row.budget) || 0, Number(row.spent) || 0),
    0
  );
  const monthCashFlow = monthIncomeTotal - projectedOutflow;
  const monthRemaining = budgetTotal - activeBudgetSnapshot.monthlySpend;
  const budgetUsedPercent = budgetTotal > 0 ? (activeBudgetSnapshot.monthlySpend / budgetTotal) * 100 : 0;
  const normalizedBudgetUsedPercent = Math.max(0, Math.min(100, budgetUsedPercent));
  const budgetUsageGradient =
    monthRemaining >= 0
      ? `conic-gradient(#00d8ff 0 ${normalizedBudgetUsedPercent.toFixed(
          2
        )}%, rgba(255,255,255,.08) ${normalizedBudgetUsedPercent.toFixed(2)}% 100%)`
      : "conic-gradient(#ff5d7a 0 100%)";
  const overspentRows = budgetRowsWithSpend
    .filter((row) => (Number(row.remaining) || 0) < 0)
    .sort((left, right) => (Number(left.remaining) || 0) - (Number(right.remaining) || 0));
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
            icon: guessBudgetCategoryIcon(value),
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

  const activateBudgetRow = useCallback((rowId) => {
    if (!rowId) return;
    setActiveBudgetRowId(rowId);
  }, []);

  const reorderBudgetRows = useCallback(
    (draggedId, targetId) => {
      if (!draggedId || !targetId || draggedId === targetId) return;
      setBudgetRowsForYear(activeBudgetDate.year, (rows) =>
        moveBudgetRowById(rows, draggedId, targetId)
      );
    },
    [activeBudgetDate.year, setBudgetRowsForYear]
  );

  const handleBudgetRowPointerDown = (event, rowId) => {
    if (event.button !== 0) return;
    const interactiveTarget = event.target.closest("input, button, select, textarea, [contenteditable='true']");
    if (interactiveTarget) {
      return;
    }

    event.preventDefault();
    activateBudgetRow(rowId);
    setPointerDragBudgetRowId(rowId);
  };

  useEffect(() => {
    if (!pointerDragBudgetRowId) return;

    const handlePointerMove = (event) => {
      if ((event.buttons & 1) !== 1) return;
      const rowElement = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest("[data-budget-row-id]");
      const targetRowId = rowElement?.getAttribute("data-budget-row-id");
      if (!targetRowId || targetRowId === pointerDragBudgetRowId) return;

      reorderBudgetRows(pointerDragBudgetRowId, targetRowId);
      activateBudgetRow(pointerDragBudgetRowId);
    };

    const handleGlobalPointerRelease = () => {
      setPointerDragBudgetRowId(null);
    };

    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseup", handleGlobalPointerRelease);
    window.addEventListener("blur", handleGlobalPointerRelease);
    return () => {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", handleGlobalPointerRelease);
      window.removeEventListener("blur", handleGlobalPointerRelease);
    };
  }, [activateBudgetRow, pointerDragBudgetRowId, reorderBudgetRows]);

  const openSortModal = () => {
    setPendingSortMode(activeSortMode);
    setIsSortModalOpen(true);
  };

  const applySortSelection = () => {
    setActiveSortMode(pendingSortMode);
    setIsSortModalOpen(false);
  };

  const scrollOverspent = (direction) => {
    const container = overspentScrollRef.current;
    if (!container) return;
    const amount = Math.max(container.clientWidth * 0.8, 240);
    container.scrollBy({ left: direction * amount, behavior: "smooth" });
  };

  return (
    <div style={{ fontFamily: styles.page.fontFamily }}>
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
              background: budgetUsageGradient,
              boxShadow:
                monthRemaining >= 0
                  ? "0 0 34px rgba(0,216,255,.18), inset 0 0 42px rgba(0,216,255,.08)"
                  : "0 0 34px rgba(255,93,122,.2), inset 0 0 42px rgba(255,93,122,.1)",
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
                  monthRemaining >= 0
                    ? "1px solid rgba(0,216,255,.24)"
                    : "1px solid rgba(255,93,122,.28)",
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
                  color: monthRemaining >= 0 ? "#8feaff" : "#ffb3c1",
                  fontSize: 11,
                  fontWeight: 900,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                }}
              >
                Budget Used
              </div>
              <div
                style={{
                  color: "white",
                  fontSize: 26,
                  fontWeight: 900,
                  lineHeight: 1,
                }}
              >
                {Math.round(monthRemaining >= 0 ? normalizedBudgetUsedPercent : budgetUsedPercent)}%
              </div>
              <div
                style={{
                  color: monthRemaining >= 0 ? "#dff7ff" : "#ffd9df",
                  fontSize: 20,
                  fontWeight: 900,
                  lineHeight: 1.1,
                }}
              >
                {wholeDollars(monthRemaining)}
              </div>
              <div style={{ color: "#7fa1ca", fontSize: 11, lineHeight: 1.4 }}>
                {monthRemaining >= 0 ? "remaining this month" : "over budget this month"}
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
              {money(monthIncomeTotal)}
            </div>
            <div style={{ color: "#668ab9", fontSize: 16, fontWeight: 700, marginTop: 8 }}>
              {budgetMonthNames[activeBudgetMonth]} Income
            </div>
            <button
              type="button"
              onClick={() => shiftBudgetMonth(-1)}
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
              {money(budgetTotal)}
            </div>
            <div style={{ color: "#668ab9", fontSize: 16, fontWeight: 700, marginTop: 8 }}>
              {budgetMonthNames[activeBudgetMonth]} Budget
            </div>
            <button
              type="button"
              onClick={() => shiftBudgetMonth(1)}
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
              justifyContent: "center",
              alignItems: "center",
              gap: 10,
              alignSelf: "end",
            }}
          >
            <button
              type="button"
              onClick={openSortModal}
              style={{
                border: "1px solid rgba(0,216,255,.26)",
                borderRadius: 10,
                background: "rgba(0,136,255,.12)",
                color: "#dff7ff",
                padding: "8px 14px",
                fontSize: 13,
                fontWeight: 800,
                letterSpacing: 0.4,
                cursor: "pointer",
              }}
            >
              Sort
            </button>
            <select
              value={activeBudgetDate.year}
              onChange={(event) => updateBudgetDate("year", event.target.value)}
              aria-label="Select budget planning year"
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

      {overspentRows.length > 0 ? (
        <section
          style={{
            ...styles.panel,
            padding: "12px 14px",
            marginBottom: 22,
            borderRadius: 18,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              color: "#ffd9df",
              fontSize: 11,
              fontWeight: 900,
              textTransform: "uppercase",
              letterSpacing: 0.9,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            Overspent ({overspentRows.length})
          </div>
          {overspentRows.length > 1 ? (
            <button
              type="button"
              aria-label="Scroll overspent categories left"
              onClick={() => scrollOverspent(-1)}
              style={{
                flexShrink: 0,
                width: 30,
                height: 30,
                borderRadius: 999,
                border: "1px solid rgba(0,216,255,.26)",
                background: "rgba(0,136,255,.12)",
                color: "#dff7ff",
                cursor: "pointer",
                fontWeight: 900,
                lineHeight: 1,
              }}
            >
              ‹
            </button>
          ) : null}
          <div
            ref={overspentScrollRef}
            style={{
              display: "flex",
              gap: 10,
              overflowX: "auto",
              flex: 1,
              scrollbarWidth: "none",
              padding: "2px 0",
            }}
          >
            {overspentRows.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => activateBudgetRow(row.id)}
                title={`${row.name} • Activity ${money(row.spent)} • Available ${money(
                  row.remaining
                )}`}
                style={{
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  textAlign: "left",
                  border: "1px solid rgba(255,93,122,.28)",
                  borderRadius: 12,
                  background: "rgba(255,61,103,.10)",
                  padding: "8px 12px",
                  cursor: "pointer",
                  color: "#eef6ff",
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{ fontWeight: 800, fontSize: 13 }}>{row.name}</span>
                <span style={{ color: "#ff9fb0", fontSize: 12, fontWeight: 800 }}>
                  {money(row.remaining)}
                </span>
              </button>
            ))}
          </div>
          {overspentRows.length > 1 ? (
            <button
              type="button"
              aria-label="Scroll overspent categories right"
              onClick={() => scrollOverspent(1)}
              style={{
                flexShrink: 0,
                width: 30,
                height: 30,
                borderRadius: 999,
                border: "1px solid rgba(0,216,255,.26)",
                background: "rgba(0,136,255,.12)",
                color: "#dff7ff",
                cursor: "pointer",
                fontWeight: 900,
                lineHeight: 1,
              }}
            >
              ›
            </button>
          ) : null}
        </section>
      ) : null}

      <section style={{ padding: "0 8px" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.15fr 110px 1fr 120px",
            alignItems: "center",
            columnGap: 20,
            color: "#6d92c2",
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: 1,
            textTransform: "uppercase",
            marginBottom: 14,
          }}
        >
          <div aria-hidden="true" />
          <div style={{ textAlign: "right", padding: "8px 10px" }}>Activity</div>
          <div style={{ textAlign: "center", padding: "8px 10px" }}>Progress</div>
          <div style={{ textAlign: "center", padding: "8px 10px" }}>Assigned</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {sortedBudgetRowsWithSpend.map((item) => (
            <div
              key={item.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1.15fr 110px 1fr 120px",
                alignItems: "center",
                columnGap: 20,
                borderRadius: 14,
                border:
                  activeBudgetRowId === item.id
                    ? pointerDragBudgetRowId === item.id
                      ? "1px solid rgba(0,216,255,.78)"
                      : "1px solid rgba(0,216,255,.54)"
                    : "1px solid rgba(0,136,255,.10)",
                background:
                  activeBudgetRowId === item.id
                    ? pointerDragBudgetRowId === item.id
                      ? "linear-gradient(95deg, rgba(0,136,255,.30), rgba(0,216,255,.19) 52%, rgba(4,20,40,.9))"
                      : "linear-gradient(95deg, rgba(0,136,255,.20), rgba(0,216,255,.11) 52%, rgba(4,18,36,.85))"
                    : "rgba(3,14,28,.42)",
                boxShadow:
                  activeBudgetRowId === item.id
                    ? pointerDragBudgetRowId === item.id
                      ? "0 0 30px rgba(0,136,255,.38), inset 0 0 28px rgba(0,216,255,.24)"
                      : "0 0 24px rgba(0,136,255,.28), inset 0 0 26px rgba(0,216,255,.17)"
                    : "inset 0 0 0 1px rgba(0,136,255,.04)",
                padding: "10px 12px",
                cursor: pointerDragBudgetRowId === item.id ? "grabbing" : "grab",
                opacity: 1,
                userSelect: "none",
                transition: "border-color 120ms ease, box-shadow 160ms ease, background 160ms ease",
              }}
              onClick={() => activateBudgetRow(item.id)}
              onMouseDown={(event) => handleBudgetRowPointerDown(event, item.id)}
              data-budget-row-id={item.id}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto auto 1fr",
                  alignItems: "center",
                  gap: 14,
                  color: "#e6efff",
                  fontSize: 20,
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
                    if (isUncategorizedCategoryName(item.name)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setDeleteTarget({ id: item.id, name: item.name });
                  }}
                  title={
                    isUncategorizedCategoryName(item.name)
                      ? `${item.name} is required`
                      : "Double click to delete category"
                  }
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#e6efff",
                    fontSize: 18,
                    background: "rgba(0,136,255,.08)",
                    border: "1px solid rgba(0,216,255,.14)",
                    cursor: isUncategorizedCategoryName(item.name) ? "default" : "pointer",
                    boxShadow: "inset 0 0 14px rgba(0,80,160,.05)",
                    opacity: isUncategorizedCategoryName(item.name) ? 0.68 : 1,
                  }}
                >
                  {item.icon}
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: 14, width: "100%" }}>
                  <input
                    value={item.name}
                    onChange={(event) => updateBudgetRow(item.id, "name", event.target.value)}
                    onFocus={() => activateBudgetRow(item.id)}
                    style={{
                      color: "#e6efff",
                      fontSize: 20,
                      fontWeight: 700,
                      background: "transparent",
                      border: "1px solid transparent",
                      borderRadius: 8,
                      padding: "4px 6px",
                      width: 240,
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
                  fontSize: 20,
                  fontWeight: 800,
                  textAlign: "right",
                  padding: "6px 8px",
                  width: "100%",
                }}
              >
                {money(item.spent)}
              </div>
              <div
                style={{
                  display: "grid",
                  justifyItems: "center",
                  gap: 6,
                }}
              >
                <div
                  style={{
                    color: (Number(item.remaining) || 0) < 0 ? "#ffd9df" : "#dffcf1",
                    fontSize: 18,
                    fontWeight: 900,
                    textAlign: "center",
                  }}
                >
                  {money(item.remaining)}
                </div>
                <div
                  style={{
                    width: "100%",
                    height: 10,
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
                {buildBudgetWorkflowStatus(item) ? (
                  <div
                    style={{
                      borderRadius: 999,
                      padding: "4px 9px",
                      fontSize: 10,
                      fontWeight: 900,
                      letterSpacing: 0.4,
                      color: buildBudgetWorkflowStatus(item).color,
                      background: buildBudgetWorkflowStatus(item).background,
                      border: buildBudgetWorkflowStatus(item).border,
                    }}
                  >
                    {buildBudgetWorkflowStatus(item).label}
                  </div>
                ) : null}
              </div>
              <input
                value={money(item.budget)}
                onChange={(event) => updateBudgetRow(item.id, "budget", event.target.value)}
                onFocus={() => activateBudgetRow(item.id)}
                style={{
                  color: "#e6efff",
                  fontSize: 20,
                  fontWeight: 800,
                  textAlign: "center",
                  background: "transparent",
                  border: "1px solid transparent",
                  borderRadius: 10,
                  padding: "6px 8px",
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

      {isSortModalOpen ? (
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
              width: 520,
              maxWidth: "calc(100vw - 32px)",
              padding: 24,
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
                fontWeight: 900,
              }}
            >
              Sort Budget Categories
            </div>
            <div style={{ color: "white", fontSize: 24, fontWeight: 900, lineHeight: 1.2 }}>
              Choose how to sort the category list
            </div>
            <div style={{ display: "grid", gap: 10, marginTop: 18 }}>
              {BUDGET_SORT_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr",
                    alignItems: "start",
                    gap: 12,
                    border: "1px solid rgba(0,216,255,.20)",
                    borderRadius: 10,
                    padding: "12px 14px",
                    cursor: "pointer",
                    background:
                      pendingSortMode === option.value
                        ? "rgba(0,136,255,.18)"
                        : "rgba(0,136,255,.06)",
                  }}
                >
                  <input
                    type="radio"
                    name="budget-sort-mode"
                    checked={pendingSortMode === option.value}
                    onChange={() => setPendingSortMode(option.value)}
                    style={{ marginTop: 3 }}
                  />
                  <span>
                    <span style={{ color: "white", fontWeight: 800, display: "block" }}>
                      {option.label}
                    </span>
                    <span style={{ color: "#9fb0c9", fontSize: 13 }}>{option.description}</span>
                  </span>
                </label>
              ))}
            </div>
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 24 }}>
              <button
                type="button"
                onClick={() => setIsSortModalOpen(false)}
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
                type="button"
                onClick={applySortSelection}
                style={{
                  background: "linear-gradient(90deg,#0077ff,#00d8ff)",
                  border: "1px solid rgba(120,220,255,.45)",
                  color: "white",
                  borderRadius: 8,
                  padding: "11px 16px",
                  cursor: "pointer",
                  fontWeight: 900,
                  boxShadow: "0 0 18px rgba(0,136,255,.28)",
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
