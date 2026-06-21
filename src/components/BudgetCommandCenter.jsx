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

function TypePill({ value, onChange }) {
  const isReserve = value === BUDGET_CATEGORY_TYPES.RESERVE;
  return (
    <button
      type="button"
      title={
        isReserve
          ? "Reserve fund — click to switch to Operating"
          : "Operating budget — click to switch to Reserve"
      }
      onClick={(event) => {
        event.stopPropagation();
        onChange(isReserve ? BUDGET_CATEGORY_TYPES.OPERATING : BUDGET_CATEGORY_TYPES.RESERVE);
      }}
      style={{
        flexShrink: 0,
        width: 22,
        height: 22,
        borderRadius: 7,
        fontSize: 12,
        fontWeight: 900,
        lineHeight: 1,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: `1px solid ${isReserve ? "rgba(232,121,249,.6)" : "rgba(0,216,255,.45)"}`,
        background: isReserve ? "rgba(232,121,249,.16)" : "rgba(0,136,255,.14)",
        color: isReserve ? "#f3c4ff" : "#8feaff",
      }}
    >
      {isReserve ? "R" : "O"}
    </button>
  );
}

const QUIET_INPUT_STYLE = {
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: 7,
  color: "#e6efff",
  outline: "none",
  padding: "4px 6px",
  width: "100%",
};

function applyQuietFocus(event, accent = "rgba(0,216,255,.5)") {
  event.currentTarget.style.border = `1px solid ${accent}`;
  event.currentTarget.style.background = "rgba(0,136,255,.10)";
}

function applyQuietBlur(event) {
  event.currentTarget.style.border = "1px solid transparent";
  event.currentTarget.style.background = "transparent";
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

const CATEGORY_GRID_COLUMNS = "minmax(190px, 1.6fr) 96px 96px 96px minmax(120px, 1.1fr) 132px";

const BUDGET_VIEW_OPTIONS = [
  { value: "category", label: "Category" },
  { value: "status", label: "Status" },
];

function getOperatingStatus(row) {
  const budget = Number(row?.budget) || 0;
  const spent = Number(row?.spent) || 0;
  if (budget <= 0) {
    return { key: "unassigned", label: "Unassigned", color: "#ffb65d", icon: "—" };
  }
  if (spent > budget) {
    return { key: "over", label: "Over Budget", color: "#ff5d7a", icon: "!" };
  }
  return { key: "ontrack", label: "On Track", color: "#00f59b", icon: "✓" };
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
  const [viewBy, setViewBy] = useState("status");
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

  // Planned monthly cash flow (income - budgeted outflow) across the plan year,
  // used for the Cash Flow value, its month-over-month delta, and the sparkline.
  const cashFlowSeries = budgetMonths.map((month) => {
    const income = planningIncomeStreams
      .filter((stream) => (stream.months || budgetMonths).includes(month))
      .reduce((sum, stream) => sum + parseMoney(stream.amount), 0);
    const outflow = planningBudgetRows
      .filter((row) => (row.months || budgetMonths).includes(month))
      .reduce((sum, row) => sum + (Number(row.budget) || 0), 0);
    return income - outflow;
  });
  const activeMonthIndex = Math.max(0, budgetMonths.indexOf(activeBudgetMonth));
  const monthCashFlow = cashFlowSeries[activeMonthIndex] || 0;
  const previousMonthCashFlow =
    activeMonthIndex > 0 ? cashFlowSeries[activeMonthIndex - 1] : null;
  const cashFlowDelta =
    previousMonthCashFlow === null ? null : monthCashFlow - previousMonthCashFlow;

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
    const amount = container.clientWidth + 10;
    container.scrollBy({ left: direction * amount, behavior: "smooth" });
  };

  const summaryNavButtonStyle = {
    height: 34,
    borderRadius: 999,
    border: "1px solid rgba(0,216,255,.28)",
    background: "linear-gradient(180deg, rgba(0,136,255,.18), rgba(0,43,87,.28))",
    color: "#dff7ff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: 0.3,
    padding: "0 14px",
  };
  const summaryStatLabelStyle = {
    color: "#668ab9",
    fontSize: 11,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  };
  const summaryIconBox = (background, color) => ({
    width: 34,
    height: 34,
    borderRadius: 10,
    display: "grid",
    placeItems: "center",
    background,
    color,
    fontSize: 16,
    fontWeight: 900,
    flexShrink: 0,
  });

  const renderMonthNav = () => (
    <>
      <button
        type="button"
        onClick={() => shiftBudgetMonth(-1)}
        aria-label="Go to previous month"
        style={summaryNavButtonStyle}
      >
        ‹ Prev
      </button>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 34,
          padding: "0 12px",
          borderRadius: 999,
          border: "1px solid rgba(0,216,255,.32)",
          background: "rgba(0,136,255,.12)",
          color: "#dff7ff",
          fontWeight: 800,
          fontSize: 13,
        }}
      >
        <span aria-hidden="true">🗓️</span>
        <span>{budgetMonthNames[activeBudgetMonth]}</span>
        <select
          value={activeBudgetDate.year}
          onChange={(event) => updateBudgetDate("year", event.target.value)}
          aria-label="Select budget planning year"
          style={{
            background: "transparent",
            border: "none",
            color: "#8feaff",
            fontWeight: 900,
            fontSize: 13,
            cursor: "pointer",
            outline: "none",
          }}
        >
          {availablePlanningYears.map((year) => (
            <option key={year} value={year} style={{ background: "#061224", color: "#eaf3ff" }}>
              {year}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        onClick={() => shiftBudgetMonth(1)}
        aria-label="Go to next month"
        style={summaryNavButtonStyle}
      >
        Next ›
      </button>
    </>
  );

  const renderIncomeBudget = () => (
    <div style={{ display: "grid", gap: 16, flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={summaryIconBox("rgba(0,245,155,.14)", "#00f59b")}>$</span>
        <div>
          <div style={summaryStatLabelStyle}>Income</div>
          <div style={{ color: "#7ef4d2", fontSize: 20, fontWeight: 800 }}>
            {money(monthIncomeTotal)}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={summaryIconBox("rgba(0,136,255,.16)", "#38bdf8")}>▦</span>
        <div>
          <div style={summaryStatLabelStyle}>Budget</div>
          <div style={{ color: "#9fd8ff", fontSize: 20, fontWeight: 800 }}>
            {money(budgetTotal)}
          </div>
        </div>
      </div>
    </div>
  );

  const renderCashFlow = () => {
    const positive = monthCashFlow >= 0;
    const accent = positive ? "#00f59b" : "#ff5d7a";
    return (
      <div style={{ flex: 1, minWidth: 110, display: "grid", gap: 8, alignContent: "center" }}>
        <div style={summaryStatLabelStyle}>Cash Flow</div>
        <div style={{ color: accent, fontSize: 26, fontWeight: 900, lineHeight: 1 }}>
          {positive ? "+" : ""}
          {money(monthCashFlow)}
        </div>
        {cashFlowDelta !== null ? (
          <div style={{ color: "#7fa1ca", fontSize: 12, fontWeight: 700 }}>
            vs last month{" "}
            <span style={{ color: cashFlowDelta >= 0 ? "#00f59b" : "#ff5d7a" }}>
              {cashFlowDelta >= 0 ? "+" : ""}
              {money(cashFlowDelta)}
            </span>
          </div>
        ) : null}
      </div>
    );
  };

  const renderOperatingRow = (item) => {
    const isActive = activeBudgetRowId === item.id;
    const isDragging = pointerDragBudgetRowId === item.id;
    const budget = Number(item.budget) || 0;
    const spent = Number(item.spent) || 0;
    const remaining = Number(item.remaining) || 0;
    const usedPct = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
    const over = budget > 0 && spent > budget;
    const status = getOperatingStatus(item);
    const isUncat = isUncategorizedCategoryName(item.name);
    return (
      <div
        key={item.id}
        className="budget-row-card"
        style={{
          display: "grid",
          gridTemplateColumns: CATEGORY_GRID_COLUMNS,
          alignItems: "center",
          columnGap: 14,
          borderRadius: 10,
          border: isActive ? "1px solid rgba(0,216,255,.5)" : "1px solid rgba(0,136,255,.08)",
          background: isActive
            ? "linear-gradient(95deg, rgba(0,136,255,.16), rgba(4,18,36,.6))"
            : "transparent",
          padding: "7px 10px",
          cursor: isDragging ? "grabbing" : "grab",
          userSelect: "none",
          transition: "background 140ms ease, border-color 140ms ease",
        }}
        onClick={() => activateBudgetRow(item.id)}
        onMouseDown={(event) => handleBudgetRowPointerDown(event, item.id)}
        data-budget-row-id={item.id}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {isUncat ? (
            <span style={{ width: 22, flexShrink: 0 }} />
          ) : (
            <TypePill
              value={item.type || BUDGET_CATEGORY_TYPES.OPERATING}
              onChange={(nextType) => setBudgetRowType(item.id, nextType)}
            />
          )}
          <button
            type="button"
            onDoubleClick={(event) => {
              if (isUncat) return;
              event.preventDefault();
              event.stopPropagation();
              setDeleteTarget({ id: item.id, name: item.name });
            }}
            title={isUncat ? `${item.name} is required` : "Double click to delete category"}
            style={{
              flexShrink: 0,
              width: 30,
              height: 30,
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#e6efff",
              fontSize: 16,
              background: "rgba(0,136,255,.08)",
              border: "1px solid rgba(0,216,255,.14)",
              cursor: isUncat ? "default" : "pointer",
            }}
          >
            {item.icon}
          </button>
          <input
            value={item.name}
            onChange={(event) => updateBudgetRow(item.id, "name", event.target.value)}
            style={{ ...QUIET_INPUT_STYLE, fontSize: 14, fontWeight: 700, maxWidth: 150 }}
            onFocus={(event) => {
              activateBudgetRow(item.id);
              applyQuietFocus(event);
            }}
            onBlur={applyQuietBlur}
          />
          <span style={{ display: "inline-flex", marginTop: -10, flexShrink: 0 }}>
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
          </span>
        </div>

        <input
          value={money(item.budget)}
          onChange={(event) => updateBudgetRow(item.id, "budget", event.target.value)}
          style={{ ...QUIET_INPUT_STYLE, fontSize: 14, fontWeight: 700, textAlign: "right" }}
          onFocus={(event) => {
            activateBudgetRow(item.id);
            applyQuietFocus(event);
          }}
          onBlur={applyQuietBlur}
        />

        <div style={{ textAlign: "right", color: "#cfe0f5", fontSize: 14, fontWeight: 700 }}>
          {money(spent)}
        </div>

        <div
          style={{
            textAlign: "right",
            color: remaining < 0 ? "#ff6b8a" : "#cfe0f5",
            fontSize: 14,
            fontWeight: 700,
          }}
        >
          {money(remaining)}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              flex: 1,
              height: 8,
              borderRadius: 999,
              background: "rgba(8,28,49,.95)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${usedPct}%`,
                height: "100%",
                borderRadius: 999,
                background: over ? "#ff5d7a" : item.color,
                boxShadow: `0 0 10px ${over ? "#ff5d7a" : item.color}`,
              }}
            />
          </div>
          <span
            style={{
              minWidth: 34,
              textAlign: "right",
              color: "#9fb6d6",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {usedPct}%
          </span>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-start" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              color: status.color,
              fontSize: 12,
              fontWeight: 800,
              whiteSpace: "nowrap",
            }}
          >
            <span
              style={{
                width: 16,
                height: 16,
                borderRadius: 999,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                fontWeight: 900,
                color: status.color,
                background: `${status.color}1f`,
                border: `1px solid ${status.color}66`,
              }}
            >
              {status.icon}
            </span>
            {status.label}
          </span>
        </div>
      </div>
    );
  };

  const renderReserveRow = (item) => {
    const isActive = activeBudgetRowId === item.id;
    return (
      <div
        key={item.id}
        className="reserve-row-card"
        style={{
          display: "grid",
          gridTemplateColumns: CATEGORY_GRID_COLUMNS,
          alignItems: "center",
          columnGap: 14,
          borderRadius: 10,
          border: isActive ? `1px solid ${item.status.color}aa` : `1px solid ${item.status.color}26`,
          background: isActive
            ? "linear-gradient(95deg, rgba(232,121,249,.12), rgba(4,18,36,.6))"
            : "transparent",
          padding: "7px 10px",
          transition: "background 140ms ease, border-color 140ms ease",
        }}
        onClick={() => activateBudgetRow(item.id)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <TypePill
            value={item.type || BUDGET_CATEGORY_TYPES.RESERVE}
            onChange={(nextType) => setBudgetRowType(item.id, nextType)}
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
              flexShrink: 0,
              width: 30,
              height: 30,
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#e6efff",
              fontSize: 16,
              background: "rgba(232,121,249,.1)",
              border: "1px solid rgba(232,121,249,.22)",
              cursor: "pointer",
            }}
          >
            {item.icon}
          </button>
          <div style={{ display: "grid", minWidth: 0 }}>
            <input
              value={item.name}
              onChange={(event) => updateBudgetRow(item.id, "name", event.target.value)}
              style={{ ...QUIET_INPUT_STYLE, fontSize: 14, fontWeight: 700, maxWidth: 150 }}
              onFocus={(event) => {
                activateBudgetRow(item.id);
                applyQuietFocus(event, "rgba(232,121,249,.6)");
              }}
              onBlur={applyQuietBlur}
            />
            <span style={{ color: "#6d92c2", fontSize: 10, fontWeight: 600, paddingLeft: 6 }}>
              {item.started
                ? `Since ${budgetMonthNames[item.anchor.month]} ${item.anchor.year}`
                : "Set a contribution to start"}
            </span>
          </div>
          <span style={{ display: "inline-flex", marginTop: -10, flexShrink: 0 }}>
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
          </span>
        </div>

        <input
          value={money(item.budget)}
          onChange={(event) => updateBudgetRow(item.id, "budget", event.target.value)}
          title="Monthly reserve contribution — not a spending limit"
          style={{ ...QUIET_INPUT_STYLE, fontSize: 14, fontWeight: 700, textAlign: "right" }}
          onFocus={(event) => {
            activateBudgetRow(item.id);
            applyQuietFocus(event, "rgba(232,121,249,.6)");
          }}
          onBlur={applyQuietBlur}
        />

        <div style={{ textAlign: "right", color: "#cfe0f5", fontSize: 14, fontWeight: 700 }}>
          {money(item.balance)}
        </div>

        <div style={{ textAlign: "right", color: "#cfe0f5", fontSize: 14, fontWeight: 700 }}>
          {money(item.target)}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              flex: 1,
              height: 8,
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
                boxShadow: `0 0 10px ${item.status.color}`,
              }}
            />
          </div>
          <span
            style={{
              minWidth: 34,
              textAlign: "right",
              color: item.status.color,
              fontSize: 12,
              fontWeight: 800,
            }}
          >
            {item.readinessPercent}%
          </span>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-start" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              color: item.status.color,
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 0.3,
              textTransform: "uppercase",
              background: `${item.status.color}1f`,
              border: `1px solid ${item.status.color}55`,
              borderRadius: 999,
              padding: "3px 9px",
              whiteSpace: "nowrap",
            }}
          >
            {item.status.label}
          </span>
        </div>
      </div>
    );
  };

  const operatingStatusMeta = {
    over: { label: "Over Budget", color: "#ff5d7a" },
    unassigned: { label: "Unassigned", color: "#ffb65d" },
    ontrack: { label: "On Track", color: "#00f59b" },
  };
  const operatingGroups =
    viewBy === "status"
      ? ["over", "unassigned", "ontrack"]
          .map((key) => ({
            key,
            label: operatingStatusMeta[key].label,
            color: operatingStatusMeta[key].color,
            rows: sortedBudgetRowsWithSpend.filter((row) => getOperatingStatus(row).key === key),
          }))
          .filter((group) => group.rows.length)
      : [{ key: "all", label: null, color: null, rows: sortedBudgetRowsWithSpend }];
  const operatingUsedPct = budgetTotal > 0 ? Math.round((operatingSpend / budgetTotal) * 100) : 0;

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

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        {renderMonthNav()}
      </div>

      <div
        className="budget-summary-row"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 0.88fr) minmax(0, 1.12fr)",
          gap: 16,
          marginBottom: 16,
        }}
      >
        <section
          className="budget-summary-card"
          style={{
            ...styles.panel,
            padding: "16px 18px",
            borderRadius: 20,
            display: "flex",
            alignItems: "center",
            gap: 18,
            minWidth: 0,
          }}
        >
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div
            style={{
              width: 188,
              height: 188,
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
        {renderIncomeBudget()}
        {renderCashFlow()}

      </section>

      <section
        className="readiness-card"
        style={{
          ...styles.panel,
          padding: "16px 18px",
          borderRadius: 20,
          minWidth: 0,
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.05fr) minmax(0, 0.85fr)",
          columnGap: 18,
          alignItems: "stretch",
        }}
      >
        <div
          className="frc-row"
          style={{
            minWidth: 0,
          }}
        >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
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
              <div style={{ textAlign: "right" }}>
                <div
                  style={{
                    color: reserveReadiness.band.color,
                    fontSize: 34,
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
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 16,
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
              ref={reserveScrollRef}
              style={{
                display: "flex",
                gap: 10,
                overflowX: "auto",
                flex: 1,
                minWidth: 0,
                scrollbarWidth: "none",
                padding: "2px 0",
                scrollSnapType: "x mandatory",
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
                    flex: "0 0 100%",
                    boxSizing: "border-box",
                    scrollSnapAlign: "start",
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
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 16,
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
            minWidth: 0,
            paddingLeft: 28,
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
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 16,
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
                  scrollSnapType: "x mandatory",
                  scrollPadding: "0 2px",
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
                      scrollSnapAlign: "start",
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
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 16,
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
          {overspentRows.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setViewBy("status");
                if (typeof document !== "undefined") {
                  document
                    .querySelector(".budget-table-section")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }
              }}
              style={{
                alignSelf: "flex-start",
                marginTop: 2,
                background: "none",
                border: "none",
                color: "#9fd8ff",
                fontSize: 12,
                fontWeight: 800,
                cursor: "pointer",
                padding: 0,
              }}
            >
              View all overspent →
            </button>
          ) : null}
        </div>
      </section>
      </div>

      <section className="budget-table-section" style={{ padding: "0 8px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 16,
            flexWrap: "wrap",
          }}
        >
          <span style={{ color: "#dff7ff", fontSize: 16, fontWeight: 900, letterSpacing: 0.4 }}>
            Categories
          </span>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={openSortModal}
              style={{
                border: "1px solid rgba(0,216,255,.26)",
                borderRadius: 999,
                background: "rgba(0,136,255,.12)",
                color: "#dff7ff",
                padding: "7px 14px",
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: 0.4,
                cursor: "pointer",
              }}
            >
              Sort
            </button>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "#6d92c2", fontSize: 12, fontWeight: 700 }}>View by</span>
              <select
                value={viewBy}
                onChange={(event) => setViewBy(event.target.value)}
                aria-label="View categories by"
                style={{
                  color: "#8feaff",
                  background: "rgba(0,136,255,.12)",
                  border: "1px solid rgba(0,216,255,.32)",
                  borderRadius: 999,
                  padding: "7px 12px",
                  cursor: "pointer",
                  fontWeight: 800,
                  fontSize: 12,
                }}
              >
                {BUDGET_VIEW_OPTIONS.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                    style={{ background: "#061224", color: "#eaf3ff" }}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 10 }}>
          <span style={{ color: "#dff7ff", fontSize: 14, fontWeight: 900, letterSpacing: 0.4 }}>
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
            gridTemplateColumns: CATEGORY_GRID_COLUMNS,
            alignItems: "center",
            columnGap: 14,
            color: "#6d92c2",
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 1,
            textTransform: "uppercase",
            marginBottom: 8,
            padding: "0 10px",
          }}
        >
          <div>Category</div>
          <div style={{ textAlign: "right" }}>Budget</div>
          <div style={{ textAlign: "right" }}>Actual</div>
          <div style={{ textAlign: "right" }}>Remaining</div>
          <div aria-hidden="true" />
          <div>Status</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {operatingGroups.map((group) => (
            <div key={group.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {group.label ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    margin: "6px 10px 2px",
                    color: group.color,
                    fontSize: 11,
                    fontWeight: 900,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: group.color,
                      boxShadow: `0 0 8px ${group.color}`,
                    }}
                  />
                  {group.label} ({group.rows.length})
                </div>
              ) : null}
              {group.rows.map(renderOperatingRow)}
            </div>
          ))}
        </div>

        {sortedBudgetRowsWithSpend.length ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: CATEGORY_GRID_COLUMNS,
              alignItems: "center",
              columnGap: 14,
              marginTop: 10,
              padding: "12px 10px 4px",
              borderTop: "1px solid rgba(0,136,255,.18)",
            }}
          >
            <div style={{ color: "#e6efff", fontSize: 14, fontWeight: 900 }}>Total</div>
            <div style={{ textAlign: "right", color: "#e6efff", fontSize: 14, fontWeight: 900 }}>
              {money(budgetTotal)}
            </div>
            <div style={{ textAlign: "right", color: "#e6efff", fontSize: 14, fontWeight: 900 }}>
              {money(operatingSpend)}
            </div>
            <div
              style={{
                textAlign: "right",
                color: monthRemaining < 0 ? "#ff6b8a" : "#e6efff",
                fontSize: 14,
                fontWeight: 900,
              }}
            >
              {money(monthRemaining)}
            </div>
            <div style={{ color: "#9fb6d6", fontSize: 12, fontWeight: 700 }}>
              {operatingUsedPct}% of budget
            </div>
            <div aria-hidden="true" />
          </div>
        ) : null}

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
                gridTemplateColumns: CATEGORY_GRID_COLUMNS,
                alignItems: "center",
                columnGap: 14,
                color: "#6d92c2",
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: 1,
                textTransform: "uppercase",
                marginBottom: 8,
                padding: "0 10px",
              }}
            >
              <div>Category</div>
              <div style={{ textAlign: "right" }}>Monthly</div>
              <div style={{ textAlign: "right" }}>Balance</div>
              <div style={{ textAlign: "right" }}>Target</div>
              <div>Readiness</div>
              <div>Status</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {reserveSnapshots.map(renderReserveRow)}
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
