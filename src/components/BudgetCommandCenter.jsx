import { useCallback, useEffect, useRef, useState } from "react";
import { styles } from "../styles.js";
import { money, wholeDollars, cleanMoneyInput, parseMoney } from "../utils/format.js";
import { buildMonthlySpendSnapshot } from "../utils/budgetReview.js";
import { getCurrentBudgetPeriod } from "../utils/date.js";
import {
  budgetMonths,
  budgetMonthNames,
  isUncategorizedCategoryName,
  BUDGET_CATEGORY_TYPES,
  DEFAULT_RESERVE_TARGET_MONTHS,
} from "../data/constants.jsx";
import { buildReserveReadiness, isReserveRow } from "../utils/reserves.js";
import { HouseholdProfilesControl, MonthCoverageEditor } from "./Common.jsx";

function CategoryTypeToggle({ value, onChange }) {
  const options = [
    { key: BUDGET_CATEGORY_TYPES.OPERATING, label: "Operating", activeBg: "linear-gradient(90deg,#0077ff,#00d8ff)" },
    { key: BUDGET_CATEGORY_TYPES.RESERVE, label: "Reserve", activeBg: "linear-gradient(90deg,#00f59b,#38bdf8)" },
  ];

  return (
    <div
      style={{
        display: "inline-flex",
        borderRadius: 999,
        border: "1px solid rgba(0,216,255,.22)",
        background: "rgba(2,12,26,.6)",
        padding: 2,
        flexShrink: 0,
      }}
    >
      {options.map((option) => {
        const active = value === option.key;
        return (
          <button
            key={option.key}
            type="button"
            title={`${option.label} category`}
            onClick={(event) => {
              event.stopPropagation();
              onChange(option.key);
            }}
            style={{
              border: "none",
              cursor: "pointer",
              borderRadius: 999,
              padding: "3px 10px",
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 0.3,
              color: active ? "#04101f" : "#7fa1ca",
              background: active ? option.activeBg : "transparent",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

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
  const reserveScrollRef = useRef(null);
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
  // Operating categories keep the traditional monthly budget behavior. Reserve
  // categories are preparedness funds and are computed/rendered separately.
  const operatingRowsWithSpend = budgetRowsWithSpend.filter((row) => !isReserveRow(row));
  const sortedBudgetRowsWithSpend = sortBudgetRows(operatingRowsWithSpend, activeSortMode);

  const reserveSourceRows = planningBudgetRows.filter(isReserveRow);
  const reserveReadiness = buildReserveReadiness(reserveSourceRows, transactions, {
    asOfMonth: activeBudgetMonth,
    asOfYear: activeBudgetDate.year,
  });
  const reserveSnapshots = reserveReadiness.reserves;
  const reserveDeployedThisMonth = reserveSnapshots.reduce(
    (sum, reserve) => sum + (Number(reserve.deployedThisMonth) || 0),
    0
  );

  const budgetTotal = operatingRowsWithSpend.reduce(
    (sum, row) => sum + (Number(row.budget) || 0),
    0
  );
  const operatingSpend = operatingRowsWithSpend.reduce(
    (sum, row) => sum + (Number(row.spent) || 0),
    0
  );
  const planningIncomeStreams = getIncomeStreamsForYear(activeBudgetDate.year);
  const monthIncomeTotal = planningIncomeStreams
    .filter((stream) => (stream.months || budgetMonths).includes(activeBudgetMonth))
    .reduce((sum, stream) => sum + parseMoney(stream.amount), 0);
  // Operating categories: assume each lands at budget; only overages reduce cash flow.
  // Reserve contributions are virtual envelope transfers (no cash leaves the account),
  // so only realized reserve deployments count against projected cash flow.
  const projectedOutflow =
    operatingRowsWithSpend.reduce(
      (sum, row) => sum + Math.max(Number(row.budget) || 0, Number(row.spent) || 0),
      0
    ) + reserveDeployedThisMonth;
  const monthCashFlow = monthIncomeTotal - projectedOutflow;
  const monthRemaining = budgetTotal - operatingSpend;
  const budgetUsedPercent = budgetTotal > 0 ? (operatingSpend / budgetTotal) * 100 : 0;
  const normalizedBudgetUsedPercent = Math.max(0, Math.min(100, budgetUsedPercent));
  const budgetUsageGradient =
    monthRemaining >= 0
      ? `conic-gradient(#00d8ff 0 ${normalizedBudgetUsedPercent.toFixed(
          2
        )}%, rgba(255,255,255,.08) ${normalizedBudgetUsedPercent.toFixed(2)}% 100%)`
      : "conic-gradient(#ff5d7a 0 100%)";
  const overspentRows = operatingRowsWithSpend
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
          type: BUDGET_CATEGORY_TYPES.OPERATING,
        },
      ];
    });
  };

  const addReserveCategory = () => {
    setBudgetRowsForYear(activeBudgetDate.year, (rows) => {
      const nextNumber = rows.length + 1;
      const newName = `New Reserve ${nextNumber}`;
      const newId = `reserve-custom-${Date.now()}-${nextNumber}`;
      return [
        ...rows,
        {
          id: newId,
          dot: "#00f59b",
          icon: "🛡️",
          name: newName,
          budget: 0,
          color: "#00f59b",
          transactionCategories: [newName],
          months: budgetMonths,
          type: BUDGET_CATEGORY_TYPES.RESERVE,
          reserveTargetMonths: DEFAULT_RESERVE_TARGET_MONTHS,
          reserveAnchor: { month: activeBudgetMonth, year: activeBudgetDate.year },
        },
      ];
    });
  };

  const setBudgetRowType = (id, nextType) => {
    setBudgetRowsForYear(activeBudgetDate.year, (rows) =>
      rows.map((row) => {
        if (row.id !== id) return row;
        if (nextType === BUDGET_CATEGORY_TYPES.RESERVE) {
          const hasAnchor =
            row.reserveAnchor && budgetMonths.includes(row.reserveAnchor.month);
          return {
            ...row,
            type: BUDGET_CATEGORY_TYPES.RESERVE,
            reserveTargetMonths: Number(row.reserveTargetMonths) || DEFAULT_RESERVE_TARGET_MONTHS,
            // Fresh-start anchor: tracking begins the month the category becomes a Reserve.
            reserveAnchor: hasAnchor
              ? row.reserveAnchor
              : { month: activeBudgetMonth, year: activeBudgetDate.year },
          };
        }
        return { ...row, type: BUDGET_CATEGORY_TYPES.OPERATING };
      })
    );
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

  const scrollReserves = (direction) => {
    const container = reserveScrollRef.current;
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
        className="budget-summary-card"
        style={{
          ...styles.panel,
          minHeight: 0,
          padding: "16px 20px",
          borderRadius: 24,
          marginBottom: 24,
          position: "relative",
          display: "grid",
          gridTemplateColumns: "minmax(150px, 0.85fr) minmax(150px, 0.85fr) auto auto",
          gridTemplateAreas: '"frc over mid right"',
          columnGap: 18,
          alignItems: "stretch",
        }}
      >
        <div
          className="budget-hero-mid"
          style={{
            gridArea: "mid",
            display: "flex",
            alignItems: "center",
            gap: 18,
            paddingLeft: 18,
            borderLeft: "1px solid rgba(30,144,255,.16)",
          }}
        >
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div
            style={{
              width: 132,
              height: 132,
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
              width: 244,
              flexShrink: 0,
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
        </div>

        <div
          className="budget-hero-stats"
          style={{
            gridArea: "right",
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 12,
            alignItems: "center",
            alignSelf: "center",
            paddingLeft: 18,
            borderLeft: "1px solid rgba(30,144,255,.16)",
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
              justifyContent: "flex-end",
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
        <div
          className="frc-row"
          style={{
            gridArea: "frc",
            minWidth: 0,
          }}
        >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div>
            <div
              style={{
                color: "#8feaff",
                fontSize: 11,
                fontWeight: 900,
                textTransform: "uppercase",
                letterSpacing: 1.4,
              }}
            >
              Financial Readiness Condition
            </div>
            <div style={{ color: "#9fb6d6", fontSize: 12, marginTop: 4 }}>
              Funded vs. a 1-year target
            </div>
          </div>
          {reserveSnapshots.length ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ textAlign: "left" }}>
                <div
                  style={{
                    color: reserveReadiness.band.color,
                    fontSize: 30,
                    fontWeight: 900,
                    lineHeight: 1,
                  }}
                >
                  {reserveReadiness.overallPercent}%
                </div>
                <div
                  style={{
                    color: "#9fb6d6",
                    fontSize: 12,
                    fontWeight: 700,
                    marginTop: 2,
                  }}
                >
                  {wholeDollars(reserveReadiness.totalBalance)} / {wholeDollars(reserveReadiness.totalTarget)}
                </div>
              </div>
              <div
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 900,
                  letterSpacing: 0.5,
                  color: reserveReadiness.band.color,
                  background: `${reserveReadiness.band.color}1f`,
                  border: `1px solid ${reserveReadiness.band.color}66`,
                }}
              >
                {reserveReadiness.band.label}
              </div>
            </div>
          ) : null}
        </div>

        {reserveSnapshots.length ? (
          <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
            {reserveSnapshots.length > 1 ? (
              <button
                type="button"
                aria-label="Scroll reserves left"
                onClick={() => scrollReserves(-1)}
                style={{
                  flexShrink: 0,
                  width: 30,
                  height: 30,
                  borderRadius: 999,
                  border: "1px solid rgba(94,234,212,.3)",
                  background: "rgba(0,245,155,.1)",
                  color: "#9ff7e0",
                  cursor: "pointer",
                  fontWeight: 900,
                  lineHeight: 1,
                }}
              >
                ‹
              </button>
            ) : null}
            <div
              ref={reserveScrollRef}
              style={{
                display: "flex",
                gap: 10,
                overflowX: "auto",
                flex: 1,
                scrollbarWidth: "none",
                padding: "2px 0",
              }}
            >
              {reserveSnapshots.map((reserve) => (
                <button
                  key={reserve.id}
                  type="button"
                  onClick={() => activateBudgetRow(reserve.id)}
                  title={`${reserve.name} • ${reserve.readinessPercent}% • ${wholeDollars(
                    reserve.balance
                  )} of ${wholeDollars(reserve.target)}`}
                  style={{
                    flexShrink: 0,
                    width: 158,
                    textAlign: "left",
                    border: `1px solid ${reserve.status.color}44`,
                    background: "linear-gradient(180deg, rgba(8,24,46,.6), rgba(3,14,28,.5))",
                    borderRadius: 12,
                    padding: "9px 12px",
                    cursor: "pointer",
                    color: "#e6efff",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        fontWeight: 800,
                        fontSize: 13,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      <span
                        style={{
                          flexShrink: 0,
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          background: reserve.status.color,
                          boxShadow: `0 0 8px ${reserve.status.color}`,
                        }}
                      />
                      {reserve.name}
                    </span>
                    <span style={{ color: reserve.status.color, fontWeight: 900, fontSize: 13 }}>
                      {reserve.readinessPercent}%
                    </span>
                  </div>
                  <div
                    style={{
                      marginTop: 7,
                      height: 7,
                      borderRadius: 999,
                      background: "rgba(8,28,49,.95)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${reserve.readinessPercent}%`,
                        borderRadius: 999,
                        background: reserve.status.color,
                        boxShadow: `0 0 10px ${reserve.status.color}`,
                      }}
                    />
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginTop: 7,
                      color: "#9fb6d6",
                      fontSize: 10,
                      fontWeight: 700,
                    }}
                  >
                    <span>{reserve.status.label}</span>
                    <span>
                      {wholeDollars(reserve.balance)} / {wholeDollars(reserve.target)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
            {reserveSnapshots.length > 1 ? (
              <button
                type="button"
                aria-label="Scroll reserves right"
                onClick={() => scrollReserves(1)}
                style={{
                  flexShrink: 0,
                  width: 30,
                  height: 30,
                  borderRadius: 999,
                  border: "1px solid rgba(94,234,212,.3)",
                  background: "rgba(0,245,155,.1)",
                  color: "#9ff7e0",
                  cursor: "pointer",
                  fontWeight: 900,
                  lineHeight: 1,
                }}
              >
                ›
              </button>
            ) : null}
          </div>
        ) : (
          <div
            style={{
              marginTop: 12,
              color: "#7fa1ca",
              fontSize: 13,
              fontWeight: 700,
              lineHeight: 1.5,
            }}
          >
            No reserve categories
          </div>
        )}
        </div>

        <div
          className="overspent-region"
          style={{
            gridArea: "over",
            minWidth: 0,
            paddingLeft: 18,
            borderLeft: "1px solid rgba(30,144,255,.16)",
            display: "flex",
            flexDirection: "column",
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
            }}
          >
            Overspent{overspentRows.length ? ` (${overspentRows.length})` : ""}
          </div>
          {overspentRows.length > 0 ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {overspentRows.length > 1 ? (
                <button
                  type="button"
                  aria-label="Scroll overspent categories left"
                  onClick={() => scrollOverspent(-1)}
                  style={{
                    flexShrink: 0,
                    width: 28,
                    height: 28,
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
                    title={`${row.name} • Spent ${money(row.spent)} • Remaining ${money(
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
                    width: 28,
                    height: 28,
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
            </div>
          ) : (
            <div style={{ color: "#7fa1ca", fontSize: 13, fontWeight: 700 }}>
              Nothing overspent
            </div>
          )}
        </div>
      </section>

      <section className="budget-table-section" style={{ padding: "0 8px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 12,
            marginBottom: 14,
          }}
        >
          <span
            style={{
              color: "#dff7ff",
              fontSize: 16,
              fontWeight: 900,
              letterSpacing: 0.4,
            }}
          >
            Operating Categories
          </span>
          <span style={{ color: "#6d92c2", fontSize: 12, fontWeight: 700 }}>
            Monthly budgets that reset each month
          </span>
        </div>
        <div
          className="budget-table-header"
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
          <div style={{ textAlign: "right", padding: "8px 10px" }}>Spent</div>
          <div style={{ textAlign: "center", padding: "8px 10px" }}>Remaining</div>
          <div style={{ textAlign: "center", padding: "8px 10px" }}>Assigned</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {sortedBudgetRowsWithSpend.map((item) => (
            <div
              key={item.id}
              className="budget-row-card"
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
                className="budget-row-title"
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
                <div
                  className="budget-row-name-controls"
                  style={{ display: "flex", alignItems: "center", gap: 14, width: "100%" }}
                >
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
                  {isUncategorizedCategoryName(item.name) ? null : (
                    <CategoryTypeToggle
                      value={item.type || BUDGET_CATEGORY_TYPES.OPERATING}
                      onChange={(nextType) => setBudgetRowType(item.id, nextType)}
                    />
                  )}
                </div>
              </div>

              <div
                className="budget-row-activity"
                style={{
                  color: (Number(item.remaining) || 0) < 0 ? "#ff5d7a" : "#e6efff",
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
                className="budget-row-progress"
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
                className="budget-row-assigned"
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

        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 12,
            margin: "34px 0 14px",
            paddingTop: 22,
            borderTop: "1px solid rgba(94,234,212,.16)",
          }}
        >
          <span
            style={{
              color: "#9ff7e0",
              fontSize: 16,
              fontWeight: 900,
              letterSpacing: 0.4,
            }}
          >
            🛡️ Reserve Funds
          </span>
          <span style={{ color: "#6d92c2", fontSize: 12, fontWeight: 700 }}>
            The monthly amount is a contribution, not a spending limit · target = 12 months of
            contributions
          </span>
        </div>

        {reserveSnapshots.length ? (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1.4fr 130px 1fr 140px",
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
              <div style={{ textAlign: "right", padding: "8px 10px" }}>Balance</div>
              <div
                style={{ textAlign: "center", padding: "8px 10px", cursor: "help" }}
                title="Readiness = current balance vs. a 1-year reserve target"
              >
                Readiness
              </div>
              <div
                style={{ textAlign: "center", padding: "8px 10px", cursor: "help" }}
                title="Monthly contribution into the reserve — not a spending limit"
              >
                Monthly
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {reserveSnapshots.map((item) => (
                <div
                  key={item.id}
                  className="reserve-row-card"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1.4fr 130px 1fr 140px",
                    alignItems: "center",
                    columnGap: 20,
                    borderRadius: 16,
                    border:
                      activeBudgetRowId === item.id
                        ? `1px solid ${item.status.color}aa`
                        : `1px solid ${item.status.color}33`,
                    background:
                      activeBudgetRowId === item.id
                        ? "linear-gradient(95deg, rgba(0,245,155,.14), rgba(56,189,248,.10) 55%, rgba(4,18,36,.85))"
                        : "linear-gradient(180deg, rgba(8,26,46,.5), rgba(3,14,28,.45))",
                    boxShadow:
                      activeBudgetRowId === item.id
                        ? `0 0 24px ${item.status.color}3a, inset 0 0 26px ${item.status.color}1f`
                        : "inset 0 0 0 1px rgba(94,234,212,.04)",
                    padding: "10px 12px",
                    transition: "border-color 120ms ease, box-shadow 160ms ease, background 160ms ease",
                  }}
                  onClick={() => activateBudgetRow(item.id)}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "auto auto 1fr",
                      alignItems: "center",
                      gap: 14,
                    }}
                  >
                    <span
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 999,
                        background: item.status.color,
                        boxShadow: `0 0 12px ${item.status.color}`,
                      }}
                    />
                    <button
                      type="button"
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setDeleteTarget({ id: item.id, name: item.name });
                      }}
                      title="Double click to delete reserve"
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 10,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#e6efff",
                        fontSize: 18,
                        background: "rgba(0,245,155,.08)",
                        border: "1px solid rgba(94,234,212,.18)",
                        cursor: "pointer",
                      }}
                    >
                      {item.icon}
                    </button>
                    <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                        <input
                          value={item.name}
                          onChange={(event) => updateBudgetRow(item.id, "name", event.target.value)}
                          onFocus={() => activateBudgetRow(item.id)}
                          style={{
                            color: "#e6efff",
                            fontSize: 19,
                            fontWeight: 700,
                            background: "transparent",
                            border: "1px solid transparent",
                            borderRadius: 8,
                            padding: "4px 6px",
                            width: 210,
                            outline: "none",
                          }}
                        />
                        <CategoryTypeToggle
                          value={item.type || BUDGET_CATEGORY_TYPES.OPERATING}
                          onChange={(nextType) => setBudgetRowType(item.id, nextType)}
                        />
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
                      <span style={{ color: "#6d92c2", fontSize: 11, fontWeight: 600 }}>
                        {item.started
                          ? `Tracking since ${budgetMonthNames[item.anchor.month]} ${item.anchor.year}`
                          : "Set a monthly contribution to start this reserve"}
                      </span>
                    </div>
                  </div>

                  <div style={{ textAlign: "right", padding: "6px 8px" }}>
                    <div style={{ color: "#e6efff", fontSize: 20, fontWeight: 800 }}>
                      {money(item.balance)}
                    </div>
                    <div style={{ color: "#7fa1ca", fontSize: 12, fontWeight: 700, marginTop: 2 }}>
                      Target {money(item.target)}
                    </div>
                  </div>

                  <div style={{ display: "grid", justifyItems: "center", gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ color: item.status.color, fontSize: 18, fontWeight: 900 }}>
                        {item.readinessPercent}%
                      </span>
                      <span
                        style={{
                          color: item.status.color,
                          fontSize: 10,
                          fontWeight: 900,
                          letterSpacing: 0.4,
                          textTransform: "uppercase",
                          background: `${item.status.color}1f`,
                          border: `1px solid ${item.status.color}55`,
                          borderRadius: 999,
                          padding: "3px 8px",
                        }}
                      >
                        {item.status.label}
                      </span>
                    </div>
                    <div
                      style={{
                        width: "100%",
                        height: 10,
                        borderRadius: 999,
                        background: "rgba(8,28,49,.95)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${item.readinessPercent}%`,
                          height: "100%",
                          borderRadius: 999,
                          background: item.status.color,
                          boxShadow: `0 0 14px ${item.status.color}`,
                        }}
                      />
                    </div>
                    {item.deployedThisMonth > 0 ? (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 1,
                          marginTop: 2,
                        }}
                      >
                        <span style={{ color: "#7ef4d2", fontSize: 11, fontWeight: 900, letterSpacing: 0.3 }}>
                          Reserve Deployed {money(item.deployedThisMonth)}
                        </span>
                        <span style={{ color: "#7fa1ca", fontSize: 10, fontWeight: 600 }}>
                          Covered by {item.name}
                        </span>
                      </div>
                    ) : null}
                  </div>

                  <div style={{ display: "grid", gap: 3, justifyItems: "center" }}>
                    <input
                      value={money(item.budget)}
                      onChange={(event) => updateBudgetRow(item.id, "budget", event.target.value)}
                      onFocus={() => activateBudgetRow(item.id)}
                      title="Monthly reserve contribution — not a spending limit"
                      style={{
                        color: "#e6efff",
                        fontSize: 18,
                        fontWeight: 800,
                        textAlign: "center",
                        background: "rgba(0,245,155,.06)",
                        border: "1px solid rgba(94,234,212,.20)",
                        borderRadius: 10,
                        padding: "8px",
                        width: "100%",
                        outline: "none",
                      }}
                    />
                    <span style={{ color: "#6d92c2", fontSize: 10, fontWeight: 600 }}>
                      contribution / mo
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}

        <div style={{ marginTop: 20, display: "flex", justifyContent: "center" }}>
          <button
            onClick={addReserveCategory}
            style={{
              background: "linear-gradient(90deg,#00c96f,#38bdf8)",
              border: "1px solid rgba(126,244,210,.45)",
              borderRadius: 12,
              color: "#04141a",
              padding: "13px 22px",
              fontWeight: 900,
              cursor: "pointer",
              boxShadow: "0 0 26px rgba(0,201,111,.32)",
              letterSpacing: 0.4,
            }}
          >
            🛡️ Add Reserve Fund
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
