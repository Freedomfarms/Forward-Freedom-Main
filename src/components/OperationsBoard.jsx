import { useState } from "react";
import { styles } from "../styles.js";
import { buildYearlyPlanningMetrics } from "../utils/yearlyPlanningMetrics.js";
import { getCurrentBudgetPeriod } from "../utils/date.js";
import {
  buildAreaPath,
  buildLinePath,
  cleanMoneyInput,
  money,
  parseMoney,
  wholeDollars,
} from "../utils/format.js";
import { budgetMonths, yearlyOpsData } from "../data/constants.jsx";
import { buildProjectedTrueCashSeries, buildReconciledTrueCashSeries } from "../utils/planning.js";
import { HouseholdProfilesControl } from "./Common.jsx";

function getLastNonNullValue(values, fallback = 0) {
  const lastValue = [...values].reverse().find((value) => value !== null && value !== undefined);
  return lastValue ?? fallback;
}

const SCORECARD_CHART_W = 940;
const SCORECARD_CHART_H = 300;
const SCORECARD_PADDING_LEFT = 56;
const SCORECARD_PADDING_RIGHT = 24;
const SCORECARD_MONTH_SPACING =
  (SCORECARD_CHART_W - SCORECARD_PADDING_LEFT - SCORECARD_PADDING_RIGHT) /
  (budgetMonths.length - 1);
const SCORECARD_BAR_WIDTH = SCORECARD_MONTH_SPACING * 0.58;
const SCORECARD_MONTH_X = Object.fromEntries(
  budgetMonths.map((month, index) => [
    month,
    SCORECARD_PADDING_LEFT + index * SCORECARD_MONTH_SPACING,
  ])
);
const OPS_SCORECARD_CHART_TYPE_STORAGE_KEY = "fff-ops-scorecard-chart-type";

function readStoredOpsScorecardChartType(storageKey = OPS_SCORECARD_CHART_TYPE_STORAGE_KEY) {
  if (typeof window === "undefined") return "line";
  const stored = window.localStorage.getItem(storageKey);
  return stored === "bar" ? "bar" : "line";
}

function persistOpsScorecardChartType(
  chartType,
  storageKey = OPS_SCORECARD_CHART_TYPE_STORAGE_KEY
) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(storageKey, chartType);
}

function finiteMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function buildScorecardRange(values) {
  const highestValue = Math.max(...values, 1);
  const paddedMaximum = highestValue < 1000 ? 1000 : Math.ceil((highestValue * 1.14) / 500) * 500;
  return {
    max: paddedMaximum,
    min: 0,
  };
}

function scorecardToY(value, max, min) {
  const range = Math.max(max - min, 1);
  return Math.max(0, Math.min(SCORECARD_CHART_H, SCORECARD_CHART_H - ((value - min) / range) * SCORECARD_CHART_H));
}

function buildScorecardYLabels(max, min, count = 5) {
  return Array.from({ length: count }, (_, index) => {
    const value = max - ((max - min) / (count - 1)) * index;
    return wholeDollars(value);
  });
}

function ScorecardChartInteraction({
  chartId,
  chartType,
  months,
  yLabels,
  chartMax,
  chartMin,
  primarySeriesPoints,
  referenceSeriesPoints,
  strokeColor,
  getBarValue,
  getTooltipRows,
}) {
  const [chartValueMonth, setChartValueMonth] = useState(null);
  const chartValueEntry = chartValueMonth
    ? months.find((entry) => entry.month.month === chartValueMonth) || null
    : null;
  const focusX = chartValueEntry ? SCORECARD_MONTH_X[chartValueEntry.month.month] : null;
  const chartValueIndex = chartValueEntry?.index ?? -1;
  const chartValueY =
    chartValueIndex >= 0 && primarySeriesPoints[chartValueIndex]
      ? primarySeriesPoints[chartValueIndex][1]
      : null;

  const selectChartMonth = (entry, event) => {
    event?.stopPropagation?.();
    setChartValueMonth(entry.month.month);
  };

  return (
    <div style={{ flex: 1, position: "relative" }}>
      {chartValueEntry && chartValueY != null ? (
        <div
          style={{
            position: "absolute",
            left: `${(SCORECARD_MONTH_X[chartValueEntry.month.month] / SCORECARD_CHART_W) * 100}%`,
            top: `${(chartValueY / (SCORECARD_CHART_H + 40)) * 100}%`,
            transform: "translate(-50%, calc(-100% - 10px))",
            pointerEvents: "none",
            zIndex: 6,
            minWidth: 168,
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid rgba(0,216,255,.28)",
            background: "rgba(4,18,34,.96)",
            boxShadow: "0 10px 28px rgba(0,0,0,.35)",
          }}
        >
          <div
            style={{
              color: "#8feaff",
              fontSize: 11,
              fontWeight: 800,
              textTransform: "uppercase",
              letterSpacing: 0.6,
              marginBottom: 8,
            }}
          >
            {chartValueEntry.month.month}
          </div>
          {getTooltipRows(chartValueEntry).map(([label, value, color]) => (
            <div
              key={label}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 16,
                fontSize: 12,
                marginTop: 6,
              }}
            >
              <span style={{ color: "#9fb0c9" }}>{label}</span>
              <span style={{ color, fontWeight: 800 }}>{value}</span>
            </div>
          ))}
        </div>
      ) : null}
      <svg
        className="ops-scorecard-svg"
        viewBox={`0 0 ${SCORECARD_CHART_W} ${SCORECARD_CHART_H + 40}`}
        style={{ width: "100%" }}
        onClick={() => setChartValueMonth(null)}
      >
        <defs>
          <linearGradient id={`${chartId}AreaGradient`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity="0.4" />
            <stop offset="100%" stopColor={strokeColor} stopOpacity="0.06" />
          </linearGradient>
        </defs>

        {yLabels.map((_, index) => {
          const y = (index / (yLabels.length - 1)) * SCORECARD_CHART_H;
          return (
            <line
              key={index}
              x1={0}
              y1={y}
              x2={SCORECARD_CHART_W}
              y2={y}
              stroke="rgba(0,136,255,.1)"
              strokeWidth={1}
            />
          );
        })}

        {months.map((entry) => (
          <line
            key={`v-${entry.month.month}`}
            x1={SCORECARD_MONTH_X[entry.month.month]}
            y1={0}
            x2={SCORECARD_MONTH_X[entry.month.month]}
            y2={SCORECARD_CHART_H}
            stroke="rgba(0,136,255,.06)"
            strokeWidth={1}
          />
        ))}

        {chartType === "line" && primarySeriesPoints.length > 1 ? (
          <path d={buildAreaPath(primarySeriesPoints)} fill={`url(#${chartId}AreaGradient)`} />
        ) : null}
        {referenceSeriesPoints.length > 1 ? (
          <path
            d={buildLinePath(referenceSeriesPoints)}
            fill="none"
            stroke={strokeColor}
            strokeWidth={2}
            strokeDasharray="7 5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
        {chartType === "line" && primarySeriesPoints.length > 1 ? (
          <path
            d={buildLinePath(primarySeriesPoints)}
            fill="none"
            stroke={strokeColor}
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
        {chartType === "bar"
          ? months.map((entry) => {
              const x = SCORECARD_MONTH_X[entry.month.month];
              const barValue = getBarValue(entry);
              const y = scorecardToY(barValue, chartMax, chartMin);
              const height = Math.max(0, SCORECARD_CHART_H - y);
              const isSelected = chartValueMonth === entry.month.month;
              return (
                <rect
                  key={`bar-${entry.month.month}`}
                  x={x - SCORECARD_BAR_WIDTH / 2}
                  y={y}
                  width={SCORECARD_BAR_WIDTH}
                  height={height}
                  fill={strokeColor}
                  fillOpacity={isSelected ? 0.95 : 0.72}
                  stroke={isSelected ? "white" : "none"}
                  strokeWidth={isSelected ? 1.5 : 0}
                  rx={4}
                  style={{ cursor: "pointer" }}
                  onClick={(event) => selectChartMonth(entry, event)}
                />
              );
            })
          : null}

        {focusX != null ? (
          <line
            x1={focusX}
            y1={0}
            x2={focusX}
            y2={SCORECARD_CHART_H}
            stroke="rgba(0,216,255,.42)"
            strokeWidth={1}
            strokeDasharray="3 4"
          />
        ) : null}

        {months.map((entry, index) => {
          const [x, y] = primarySeriesPoints[index];
          const isSelected = chartValueMonth === entry.month.month;

          return (
            <g key={entry.month.month}>
              {chartType === "line" ? (
                <>
                  <circle
                    cx={x}
                    cy={y}
                    r={12}
                    fill="transparent"
                    style={{ cursor: "pointer" }}
                    onClick={(event) => selectChartMonth(entry, event)}
                  />
                  <circle
                    cx={x}
                    cy={y}
                    r={isSelected ? 6.2 : 4.8}
                    fill={strokeColor}
                    stroke="rgba(255,255,255,.9)"
                    strokeWidth={isSelected ? 1.6 : 1.2}
                    style={{ cursor: "pointer", pointerEvents: "none" }}
                  />
                </>
              ) : null}
              <text
                x={x}
                y={SCORECARD_CHART_H + 24}
                textAnchor="middle"
                style={{
                  fill: isSelected ? "#eaf3ff" : "#5e7da0",
                  fontSize: 11,
                  fontWeight: isSelected ? 800 : 500,
                  cursor: "pointer",
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  setChartValueMonth(null);
                }}
              >
                {entry.month.month}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ScorecardChart({
  chartId,
  title,
  note,
  legend,
  months,
  yLabels,
  chartMax,
  chartMin,
  primarySeriesPoints,
  referenceSeriesPoints,
  strokeColor,
  getBarValue,
  getTooltipRows,
  resetKey,
  chartTypeStorageKey = OPS_SCORECARD_CHART_TYPE_STORAGE_KEY,
}) {
  const [chartType, setChartType] = useState(() => readStoredOpsScorecardChartType(chartTypeStorageKey));

  const handleChartTypeChange = (nextChartType) => {
    setChartType(nextChartType);
    persistOpsScorecardChartType(nextChartType, chartTypeStorageKey);
  };

  return (
    <section
      className="ops-scorecard"
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
          background: "radial-gradient(circle at top right, rgba(0,216,255,.13), transparent 36%)",
        }}
      />
      <div style={{ position: "relative", display: "grid", gap: 22 }}>
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 18,
              flexWrap: "wrap",
              marginBottom: 18,
            }}
          >
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ color: "white", fontSize: 22, fontWeight: 900 }}>{title}</div>
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: 3,
                    borderRadius: 8,
                    border: "1px solid rgba(0,136,255,.22)",
                    background: "rgba(0,136,255,.06)",
                  }}
                >
                  {[
                    ["line", "Line"],
                    ["bar", "Bar"],
                  ].map(([type, label]) => {
                    const isActive = chartType === type;
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => handleChartTypeChange(type)}
                        style={{
                          color: isActive ? "#00d8ff" : "#9fb0c9",
                          border: isActive
                            ? "1px solid rgba(0,136,255,.55)"
                            : "1px solid transparent",
                          background: isActive ? "rgba(0,104,255,.18)" : "transparent",
                          borderRadius: 6,
                          padding: "6px 12px",
                          cursor: "pointer",
                          fontSize: 12,
                          fontWeight: 800,
                          letterSpacing: 0.4,
                          boxShadow: isActive ? "0 0 14px rgba(0,136,255,.18)" : "none",
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div style={{ color: "#9fb0c9", marginTop: 6, lineHeight: 1.5 }}>{note}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              {legend.map(([label, color, type, glow]) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, color: "#9fb0c9" }}>
                  <div
                    style={{
                      width: 24,
                      borderTop: `2px ${type === "dashed" ? "dashed" : "solid"} ${color}`,
                      boxShadow: `0 0 10px ${glow}`,
                    }}
                  />
                  {label}
                </div>
              ))}
            </div>
          </div>

          <div
            className="ops-scorecard-chart"
            style={{
              position: "relative",
              borderRadius: 14,
              border: "1px solid rgba(0,216,255,.2)",
              background: "rgba(2,16,34,.7)",
              boxShadow: "inset 0 0 28px rgba(0,136,255,.08)",
              padding: "18px 16px 6px",
            }}
          >
            <div style={{ display: "flex", gap: 0 }}>
              <div
                style={{
                  width: 80,
                  flexShrink: 0,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  paddingBottom: 44,
                  paddingRight: 8,
                }}
              >
                {yLabels.map((label) => (
                  <span key={label} style={{ color: "#5e7da0", fontSize: 11, textAlign: "right" }}>
                    {label}
                  </span>
                ))}
              </div>

              <ScorecardChartInteraction
                key={resetKey}
                chartId={chartId}
                chartType={chartType}
                months={months}
                yLabels={yLabels}
                chartMax={chartMax}
                chartMin={chartMin}
                primarySeriesPoints={primarySeriesPoints}
                referenceSeriesPoints={referenceSeriesPoints}
                strokeColor={strokeColor}
                getBarValue={getBarValue}
                getTooltipRows={getTooltipRows}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const CALENDAR_WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatCompactMoney(value) {
  const amount = Number(value) || 0;
  const absolute = Math.abs(amount);
  if (absolute >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  return `$${Math.round(amount)}`;
}

function formatCompactSignedMoney(value) {
  const amount = Number(value) || 0;
  if (amount === 0) return "$0";
  const prefix = amount > 0 ? "+" : "-";
  return `${prefix}${formatCompactMoney(Math.abs(amount))}`;
}

function getCashFlowHeatStyle(value, maxAbsValue) {
  const numericValue = Number(value) || 0;
  const intensity = clampNumber(Math.abs(numericValue) / Math.max(maxAbsValue || 1, 1), 0, 1);

  if (numericValue > 0) {
    return {
      background: `linear-gradient(155deg, rgba(0,82,122,.72), rgba(0,245,155,${0.3 + intensity * 0.34}))`,
      border: `1px solid rgba(72,255,207,${0.18 + intensity * 0.34})`,
      boxShadow: `0 0 ${8 + intensity * 14}px rgba(0,245,155,${0.2 + intensity * 0.4})`,
      valueColor: "#7dffd5",
    };
  }

  if (numericValue < 0) {
    return {
      background: `linear-gradient(155deg, rgba(48,20,92,.74), rgba(255,88,173,${0.24 + intensity * 0.3}))`,
      border: `1px solid rgba(255,126,205,${0.18 + intensity * 0.3})`,
      boxShadow: `0 0 ${8 + intensity * 14}px rgba(221,88,255,${0.16 + intensity * 0.34})`,
      valueColor: "#ffb2e8",
    };
  }

  return {
    background: "linear-gradient(155deg, rgba(0,86,134,.62), rgba(0,216,255,.30))",
    border: "1px solid rgba(0,216,255,.34)",
    boxShadow: "0 0 8px rgba(0,216,255,.20)",
    valueColor: "#9fe9ff",
  };
}

function getStabilityBand(score) {
  const value = Number(score) || 0;
  if (value >= 80) return { label: "Elite", color: "#00f59b", range: "80–100" };
  if (value >= 60) return { label: "Solid", color: "#38e0c0", range: "60–79" };
  if (value >= 40) return { label: "Steady", color: "#ffb65d", range: "40–59" };
  return { label: "At Risk", color: "#ff5d7a", range: "0–39" };
}

function parseTransactionDateParts(value) {
  const rawValue = String(value || "");
  const isoDateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rawValue);
  if (isoDateMatch) {
    const [, yearText, monthText, dayText] = isoDateMatch;
    return {
      year: Number(yearText),
      monthIndex: Number(monthText) - 1,
      day: Number(dayText),
    };
  }

  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.getTime())) return null;
  return {
    year: parsed.getFullYear(),
    monthIndex: parsed.getMonth(),
    day: parsed.getDate(),
  };
}

function buildCashFlowCalendarModel({
  year,
  monthIndex,
  transactions,
  plannedIncome,
  plannedBudget,
  openingTrueCash,
  currentDate = new Date(),
}) {
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const firstWeekday = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const monthNetPlan = finiteMoney(plannedIncome) - finiteMoney(plannedBudget);
  const dailyPlanPulse = daysInMonth > 0 ? monthNetPlan / daysInMonth : 0;
  const dailyActualNet = Array.from({ length: daysInMonth }, () => 0);
  const dailyTransactions = Array.from({ length: daysInMonth }, () => []);

  transactions.forEach((tx) => {
    const parsedDate = parseTransactionDateParts(tx.date);
    if (!parsedDate) return;
    if (parsedDate.year !== year || parsedDate.monthIndex !== monthIndex) return;
    const dayIndex = parsedDate.day - 1;
    if (dayIndex < 0 || dayIndex >= daysInMonth) return;
    dailyActualNet[dayIndex] += finiteMoney(tx.amount);
    dailyTransactions[dayIndex].push(tx);
  });

  let cumulativeActual = 0;
  let strongestInflow = { day: null, value: 0 };
  let strongestOutflow = { day: null, value: 0 };
  let lowestForecast = { day: 1, value: openingTrueCash + monthNetPlan };
  let totalInflow = 0;
  let totalOutflow = 0;
  let sustainabilityTotal = 0;
  let sustainabilityCount = 0;
  let riskDays = 0;

  const days = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const actualNet = dailyActualNet[index];
    const dayOpeningBalance = openingTrueCash + cumulativeActual;
    cumulativeActual += actualNet;
    const planToDate = dailyPlanPulse * day;
    const varianceToPlan = cumulativeActual - planToDate;
    const runningBalance = dayOpeningBalance + actualNet;
    const monthEndForecast = runningBalance + dailyPlanPulse * (daysInMonth - day);
    const varianceScoreBase = Math.max(Math.abs(planToDate), 90);
    const variancePenalty = clampNumber((Math.abs(varianceToPlan) / varianceScoreBase) * 28, 0, 35);
    const outflowPenalty = actualNet < 0 ? clampNumber(Math.abs(actualNet) / 160, 0, 20) : 0;
    const riskPenalty = monthEndForecast < 0 ? 26 : monthEndForecast < openingTrueCash * 0.55 ? 12 : 0;
    const sustainabilityScore = clampNumber(
      Math.round(100 - variancePenalty - outflowPenalty - riskPenalty),
      18,
      100
    );

    if (actualNet > 0) totalInflow += actualNet;
    if (actualNet < 0) totalOutflow += Math.abs(actualNet);
    if (monthEndForecast < openingTrueCash * 0.55) riskDays += 1;
    sustainabilityTotal += sustainabilityScore;
    sustainabilityCount += 1;

    if (actualNet > strongestInflow.value) strongestInflow = { day, value: actualNet };
    if (actualNet < strongestOutflow.value) strongestOutflow = { day, value: actualNet };
    if (monthEndForecast < lowestForecast.value) {
      lowestForecast = { day, value: monthEndForecast };
    }

    const isToday =
      currentDate.getFullYear() === year &&
      currentDate.getMonth() === monthIndex &&
      currentDate.getDate() === day;

    return {
      day,
      actualNet,
      cumulativeActual,
      varianceToPlan,
      runningBalance,
      monthEndForecast,
      sustainabilityScore,
      isToday,
      transactions: dailyTransactions[index],
    };
  });

  const paddedDays = [...Array(firstWeekday).fill(null), ...days];
  while (paddedDays.length % 7 !== 0) paddedDays.push(null);

  const weeks = [];
  for (let index = 0; index < paddedDays.length; index += 7) {
    weeks.push(paddedDays.slice(index, index + 7));
  }

  return {
    weeks,
    days,
    dailyPlanPulse,
    monthNetPlan,
    monthNetActual: cumulativeActual,
    totalInflow,
    totalOutflow,
    sustainabilityAverage:
      sustainabilityCount > 0 ? Math.round(sustainabilityTotal / sustainabilityCount) : 0,
    riskDays,
    strongestInflow,
    strongestOutflow,
    lowestForecast,
  };
}

export function OperationsBoard({
  transactions,
  trueCash,
  householdProfilesProps,
  currentPlanYear,
  availablePlanningYears,
  getBudgetRowsForYear,
  getIncomeStreamsForYear,
  ensurePlanningYear,
  getPlanningAnchorForYear,
  setPlanningAnchorForYear,
  isDemoMode = false,
}) {
  const [hoveredCalendarDay, setHoveredCalendarDay] = useState(null);
  const [showStabilityInfo, setShowStabilityInfo] = useState(false);
  const [calendarMonthIndex, setCalendarMonthIndex] = useState(() =>
    currentPlanYear === getCurrentBudgetPeriod().year ? getCurrentBudgetPeriod().monthIndex : 0
  );
  const currentBudgetPeriod = getCurrentBudgetPeriod();
  const [activePlanningYear, setActivePlanningYear] = useState(currentPlanYear);
  const safeTransactions = Array.isArray(transactions) ? transactions : [];
  const planningBudgetRows = getBudgetRowsForYear(activePlanningYear);
  const planningIncomeStreams = getIncomeStreamsForYear(activePlanningYear);
  const planningAnchor = getPlanningAnchorForYear(activePlanningYear);
  const updatePlanningYear = (value) => {
    const nextValue = Number(value);
    ensurePlanningYear(nextValue);
    setHoveredCalendarDay(null);
    setActivePlanningYear(nextValue);
  };
  const updatePlanningAnchor = (field, value) => {
    if (field !== "startingTrueCash") return;
    setPlanningAnchorForYear(activePlanningYear, {
      startingTrueCash: cleanMoneyInput(value),
    });
  };

  const planConfigured =
    planningIncomeStreams.length > 0 ||
    planningBudgetRows.some((row) => finiteMoney(row.budget) > 0);
  const dynamicYearlyOpsData = buildYearlyPlanningMetrics({
    transactions: safeTransactions,
    budgetRows: planningBudgetRows,
    incomeStreams: planningIncomeStreams,
    yearlyOpsSeed: isDemoMode ? yearlyOpsData : [],
    useSeedFallback: isDemoMode,
    year: activePlanningYear,
  });

  const yearlyIncome = dynamicYearlyOpsData.reduce((sum, month) => sum + month.income, 0);
  const yearlyBudget = dynamicYearlyOpsData.reduce((sum, month) => sum + month.budget, 0);
  const yearlyActualIncome = dynamicYearlyOpsData.reduce(
    (sum, month) => sum + finiteMoney(month.actualIncome),
    0
  );
  const yearlySpent = dynamicYearlyOpsData.reduce(
    (sum, month) => sum + finiteMoney(month.spent),
    0
  );
  const yearlySurplus = yearlyIncome - yearlyBudget;
  const ytdCashFlow = yearlyActualIncome - yearlySpent;
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
  const anchorStartingMonth = planningAnchor.startingMonth || currentBudgetPeriod.month;
  const isCurrentPlanYear = activePlanningYear === currentBudgetPeriod.year;
  // Infer the year's starting True Cash from the accounts the user already
  // connected: today's live True Cash minus the cash flow realized so far this
  // year (todayTrueCash - ytdCashFlow) gives the balance the year began with. A
  // manual override below always takes precedence when set.
  const derivedStartingTrueCash = isCurrentPlanYear ? trueCash - ytdCashFlow : trueCash;
  const hasManualStartingTrueCash =
    planningAnchor.startingTrueCash !== undefined && planningAnchor.startingTrueCash !== null;
  const anchorStartingTrueCash = hasManualStartingTrueCash
    ? Number(planningAnchor.startingTrueCash) || 0
    : derivedStartingTrueCash;
  const currentMonthOps = dynamicYearlyOpsData[currentBudgetPeriod.monthIndex];
  const currentMonthRemainingNet = currentMonthOps
    ? Math.max(
        0,
        finiteMoney(currentMonthOps.income) - finiteMoney(currentMonthOps.actualIncome)
      ) - Math.max(0, finiteMoney(currentMonthOps.budget) - finiteMoney(currentMonthOps.spent))
    : 0;
  const remainingMonthsProjectedNet = dynamicYearlyOpsData
    .slice(currentBudgetPeriod.monthIndex + 1)
    .reduce((sum, month) => sum + (finiteMoney(month.income) - finiteMoney(month.budget)), 0);
  // Projected year-end cash flow: realized cash flow so far (actual income minus
  // actual spend) plus the projected net for the rest of the year. The current
  // month is assumed to finish at budget, matching the Command Center cash-flow
  // logic. Non-current years have no actuals yet, so they fall back to the
  // planned income-minus-budget total.
  const projectedYearEndCashFlow = isCurrentPlanYear
    ? ytdCashFlow + currentMonthRemainingNet + remainingMonthsProjectedNet
    : yearlySurplus;
  const baseTrueCashSeries = buildProjectedTrueCashSeries({
    targetYear: activePlanningYear,
    incomeStreams: planningIncomeStreams,
    budgetRows: planningBudgetRows,
    startingMonth: anchorStartingMonth,
    startingTrueCash: anchorStartingTrueCash,
  }).map((entry) => entry.value);
  const trueCashValues = buildReconciledTrueCashSeries({
    targetYear: activePlanningYear,
    incomeStreams: planningIncomeStreams,
    budgetRows: planningBudgetRows,
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
  const safeCalendarMonthIndex = Math.max(0, Math.min(budgetMonths.length - 1, calendarMonthIndex));
  const calendarMonthData = dynamicYearlyOpsData[safeCalendarMonthIndex] || dynamicYearlyOpsData[0];
  const priorActualTrueCash = getLastNonNullValue(
    trueCashValues.slice(0, safeCalendarMonthIndex),
    null
  );
  const priorProjectedTrueCash = getLastNonNullValue(
    projectedTrueCashValues.slice(0, safeCalendarMonthIndex),
    null
  );
  const calendarOpeningTrueCash =
    priorActualTrueCash ?? priorProjectedTrueCash ?? anchorStartingTrueCash;
  const cashFlowCalendar = buildCashFlowCalendarModel({
    year: activePlanningYear,
    monthIndex: safeCalendarMonthIndex,
    transactions: safeTransactions,
    plannedIncome: calendarMonthData?.plannedIncome ?? 0,
    plannedBudget: calendarMonthData?.budget ?? 0,
    openingTrueCash: calendarOpeningTrueCash,
  });
  const shiftCalendarMonth = (delta) => {
    setHoveredCalendarDay(null);
    setCalendarMonthIndex((current) =>
      (current + Number(delta || 0) + budgetMonths.length) % budgetMonths.length
    );
  };
  const focusedCalendarDay =
    cashFlowCalendar.days.find((day) => day.day === hoveredCalendarDay) ||
    cashFlowCalendar.days.find((day) => day.isToday) ||
    cashFlowCalendar.days[0] ||
    null;
  const cashFlowHeatMax = Math.max(
    ...cashFlowCalendar.days.map((day) => Math.abs(day.actualNet)),
    Math.abs(cashFlowCalendar.dailyPlanPulse),
    1
  );
  const sustainabilityRing = clampNumber(cashFlowCalendar.sustainabilityAverage, 0, 100);
  const stabilityBand = getStabilityBand(sustainabilityRing);
  const scorecardMonths = dynamicYearlyOpsData.map((month, index) => {
    const plannedIncome = finiteMoney(month.plannedIncome ?? month.income);
    const actualIncome = finiteMoney(month.actualIncome);
    const budget = finiteMoney(month.budget);
    const spent = finiteMoney(month.spent);
    const profit = plannedIncome - budget;
    return {
      month,
      index,
      plannedIncome,
      actualIncome,
      budget,
      spent,
      profit,
      trueCash: trueCashValues[index],
    };
  });
  const scorecardBudgetValues = scorecardMonths.flatMap((entry) => [entry.budget, entry.spent]);
  const { max: budgetChartMax, min: budgetChartMin } = buildScorecardRange(scorecardBudgetValues);
  const budgetChartYLabels = buildScorecardYLabels(budgetChartMax, budgetChartMin);
  const budgetLinePoints = scorecardMonths.map((entry) => [
    SCORECARD_MONTH_X[entry.month.month],
    scorecardToY(entry.budget, budgetChartMax, budgetChartMin),
  ]);
  const spentLinePoints = scorecardMonths.map((entry) => [
    SCORECARD_MONTH_X[entry.month.month],
    scorecardToY(entry.spent, budgetChartMax, budgetChartMin),
  ]);

  const scorecardIncomeValues = scorecardMonths.flatMap((entry) => [
    entry.plannedIncome,
    entry.actualIncome,
  ]);
  const { max: incomeChartMax, min: incomeChartMin } = buildScorecardRange(scorecardIncomeValues);
  const incomeChartYLabels = buildScorecardYLabels(incomeChartMax, incomeChartMin);
  const plannedLinePoints = scorecardMonths.map((entry) => [
    SCORECARD_MONTH_X[entry.month.month],
    scorecardToY(entry.plannedIncome, incomeChartMax, incomeChartMin),
  ]);
  const actualLinePoints = scorecardMonths.map((entry) => [
    SCORECARD_MONTH_X[entry.month.month],
    scorecardToY(entry.actualIncome, incomeChartMax, incomeChartMin),
  ]);

  const scorecardNote = (
    <>
      Spending Intelligence-style trend surface for plan vs actual execution.
      {!planConfigured && isDemoMode ? (
        <span style={{ display: "block", marginTop: 8, color: "#94a3b8", fontSize: 13 }}>
          No plan data set for {activePlanningYear}; sample planned/budget/spent values are shown
          while actual income remains live from transactions.
        </span>
      ) : null}
    </>
  );

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
        className="ops-kpi-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 16,
          marginBottom: 18,
        }}
      >
        {[
          ["Total Income Earned", wholeDollars(yearlyActualIncome), "#00f59b"],
          ["Total Spent", wholeDollars(yearlySpent), "#00d8ff"],
          ["YTD Cash Flow", wholeDollars(ytdCashFlow), ytdCashFlow >= 0 ? "#00f59b" : "#ff5d7a"],
          ["Projected Year-End Cash Flow", wholeDollars(projectedYearEndCashFlow), projectedYearEndCashFlow >= 0 ? "#00f59b" : "#ff5d7a"],
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
                value={money(hasManualStartingTrueCash ? planningAnchor.startingTrueCash : derivedStartingTrueCash)}
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
              {hasManualStartingTrueCash
                ? "Manual override for this year's starting true-cash balance."
                : "Auto-derived from your accounts (today's True Cash minus this year's cash flow). Type a value to override."}
            </div>
          </div>
        </div>
      </section>

      <ScorecardChart
        chartId="opsScorecardBudget"
        title="Monthly Scorecard - Budget"
        note={scorecardNote}
        legend={[
          ["Budget", "rgba(0,216,255,.95)", "dashed", "rgba(0,216,255,.3)"],
          ["Spent", "rgba(0,216,255,.95)", "solid", "rgba(0,216,255,.3)"],
        ]}
        months={scorecardMonths}
        yLabels={budgetChartYLabels}
        chartMax={budgetChartMax}
        chartMin={budgetChartMin}
        primarySeriesPoints={spentLinePoints}
        referenceSeriesPoints={budgetLinePoints}
        strokeColor="#00d8ff"
        getBarValue={(entry) => entry.spent}
        getTooltipRows={(entry) => [
          ["Budget", money(entry.budget), "#00d8ff"],
          ["Spent", money(entry.spent), "#00d8ff"],
        ]}
        resetKey={activePlanningYear}
        chartTypeStorageKey="fff-ops-scorecard-budget-chart-type"
      />

      <ScorecardChart
        chartId="opsScorecardIncome"
        title="Monthly Scorecard - Income"
        note={scorecardNote}
        legend={[
          ["Planned Income", "rgba(0,245,155,.9)", "dashed", "rgba(0,245,155,.24)"],
          ["Earned Income", "rgba(0,245,155,.9)", "solid", "rgba(0,245,155,.24)"],
        ]}
        months={scorecardMonths}
        yLabels={incomeChartYLabels}
        chartMax={incomeChartMax}
        chartMin={incomeChartMin}
        primarySeriesPoints={actualLinePoints}
        referenceSeriesPoints={plannedLinePoints}
        strokeColor="#00f59b"
        getBarValue={(entry) => entry.actualIncome}
        getTooltipRows={(entry) => [
          ["Planned Income", money(entry.plannedIncome), "#00f59b"],
          ["Earned Income", money(entry.actualIncome), "#00f59b"],
        ]}
        resetKey={activePlanningYear}
        chartTypeStorageKey="fff-ops-scorecard-income-chart-type"
      />

      <section
        className="ops-calendar-panel"
        style={{
          ...styles.panel,
          padding: 22,
          marginBottom: 18,
          background:
            "radial-gradient(circle at 15% 12%, rgba(0,216,255,.18), rgba(2,11,24,.96) 44%), linear-gradient(180deg, rgba(2,11,26,.96), rgba(1,7,18,.98))",
          boxShadow:
            "0 0 45px rgba(0,136,255,.18), inset 0 0 40px rgba(0,216,255,.06), inset 0 0 0 1px rgba(0,216,255,.13)",
        }}
      >
        <div
          className="ops-calendar-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "220px minmax(0, 1fr) 190px",
            gap: 16,
            alignItems: "start",
          }}
        >
          <div>
            <div
              style={{
                color: "white",
                fontSize: 22,
                fontWeight: 900,
              }}
            >
              Calendar Cash Flow
            </div>
            <div style={{ color: "#eaf6ff", fontSize: 14, lineHeight: 1.55, marginTop: 10 }}>
              Cash-flow heatmap that blends posted activity, live plan pulse, and daily forecast
              stability.
            </div>
            {focusedCalendarDay ? (
              <div
                style={{
                  marginTop: 16,
                  border: "1px solid rgba(0,216,255,.24)",
                  borderRadius: 12,
                  background: "rgba(3,18,36,.72)",
                  padding: "10px 12px",
                }}
              >
                <div
                  style={{
                    color: "#8ea8ca",
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: 0.8,
                  }}
                >
                  Focus Day
                </div>
                <div style={{ color: "white", fontWeight: 900, marginTop: 6 }}>
                  {budgetMonths[safeCalendarMonthIndex]} {focusedCalendarDay.day}
                </div>
                <div
                  style={{
                    color:
                      focusedCalendarDay.actualNet < 0
                        ? "#ff4f8a"
                        : focusedCalendarDay.actualNet > 0
                          ? "#7dffd5"
                          : "#8feaff",
                    marginTop: 4,
                    fontWeight: 800,
                    textShadow:
                      focusedCalendarDay.actualNet < 0
                        ? "0 0 14px rgba(255,79,138,.65)"
                        : focusedCalendarDay.actualNet > 0
                          ? "0 0 14px rgba(125,255,213,.55)"
                          : "none",
                  }}
                >
                  {formatCompactSignedMoney(focusedCalendarDay.actualNet)} posted
                </div>
                <div style={{ color: "#9fb0c9", fontSize: 12, marginTop: 4 }}>
                  TC {wholeDollars(focusedCalendarDay.runningBalance)} · Forecast{" "}
                  {wholeDollars(focusedCalendarDay.monthEndForecast)}
                </div>
                <div
                  style={{
                    marginTop: 10,
                    paddingTop: 10,
                    borderTop: "1px solid rgba(0,216,255,.16)",
                  }}
                >
                  <div
                    style={{
                      color: "#8ea8ca",
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: 0.8,
                      marginBottom: 8,
                    }}
                  >
                    Transactions
                  </div>
                  {focusedCalendarDay.transactions && focusedCalendarDay.transactions.length > 0 ? (
                    <div style={{ display: "grid", gap: 8, maxHeight: 196, overflowY: "auto" }}>
                      {focusedCalendarDay.transactions.map((tx, txIndex) => {
                        const amount = Number(tx.amount) || 0;
                        return (
                          <div
                            key={tx.id || `${tx.merchant || "tx"}-${txIndex}`}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 10,
                              alignItems: "baseline",
                            }}
                          >
                            <div style={{ minWidth: 0 }}>
                              <div
                                style={{
                                  color: "#eaf6ff",
                                  fontSize: 12,
                                  fontWeight: 700,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {tx.merchant || tx.category || "Transaction"}
                              </div>
                              <div style={{ color: "#8ea8ca", fontSize: 10 }}>
                                {tx.category || "Uncategorized"}
                              </div>
                            </div>
                            <div
                              style={{
                                color: amount < 0 ? "#ff8ccc" : "#7dffd5",
                                fontSize: 12,
                                fontWeight: 800,
                                whiteSpace: "nowrap",
                              }}
                            >
                              {amount < 0 ? "-" : "+"}
                              {money(Math.abs(amount))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ color: "#8ea8ca", fontSize: 12 }}>No transactions</div>
                  )}
                </div>
              </div>
            ) : null}
          </div>

          <div>
            <div
              style={{
                border: "1px solid rgba(0,216,255,.28)",
                borderRadius: 16,
                overflow: "hidden",
                background:
                  "linear-gradient(180deg, rgba(0,80,130,.20), rgba(2,15,34,.92) 12%, rgba(1,8,20,.96) 100%)",
                boxShadow: "0 0 28px rgba(0,136,255,.24), inset 0 0 24px rgba(0,216,255,.08)",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "58px 1fr 58px",
                  alignItems: "center",
                  borderBottom: "1px solid rgba(0,216,255,.18)",
                  minHeight: 48,
                }}
              >
                <button
                  type="button"
                  onClick={() => shiftCalendarMonth(-1)}
                  style={{
                    background:
                      "radial-gradient(circle at 30% 20%, rgba(0,216,255,.34), rgba(0,75,126,.2) 48%, rgba(0,24,48,.14) 100%)",
                    border: "1px solid rgba(0,216,255,.42)",
                    color: "#93ecff",
                    fontSize: 24,
                    fontWeight: 900,
                    lineHeight: 1,
                    cursor: "pointer",
                    padding: 0,
                    width: 38,
                    height: 38,
                    borderRadius: "50%",
                    display: "grid",
                    placeItems: "center",
                    margin: "0 auto",
                    boxShadow:
                      "0 0 16px rgba(0,216,255,.26), inset 0 0 9px rgba(143,234,255,.26)",
                  }}
                  aria-label="Previous calendar month"
                >
                  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
                    <path
                      d="M10.5 2.5L5 8l5.5 5.5"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <div
                  style={{
                    color: "#eaf7ff",
                    textAlign: "center",
                    fontWeight: 900,
                    fontSize: 30,
                    letterSpacing: 0.8,
                    textTransform: "uppercase",
                  }}
                >
                  {budgetMonths[safeCalendarMonthIndex]} {activePlanningYear}
                </div>
                <button
                  type="button"
                  onClick={() => shiftCalendarMonth(1)}
                  style={{
                    background:
                      "radial-gradient(circle at 30% 20%, rgba(0,216,255,.34), rgba(0,75,126,.2) 48%, rgba(0,24,48,.14) 100%)",
                    border: "1px solid rgba(0,216,255,.42)",
                    color: "#93ecff",
                    fontSize: 24,
                    fontWeight: 900,
                    lineHeight: 1,
                    cursor: "pointer",
                    padding: 0,
                    width: 38,
                    height: 38,
                    borderRadius: "50%",
                    display: "grid",
                    placeItems: "center",
                    margin: "0 auto",
                    boxShadow:
                      "0 0 16px rgba(0,216,255,.26), inset 0 0 9px rgba(143,234,255,.26)",
                  }}
                  aria-label="Next calendar month"
                >
                  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
                    <path
                      d="M5.5 2.5L11 8l-5.5 5.5"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
                  borderBottom: "1px solid rgba(0,216,255,.12)",
                }}
              >
                {CALENDAR_WEEKDAY_LABELS.map((weekday) => (
                  <div
                    key={weekday}
                    style={{
                      color: "#8fb9ea",
                      fontSize: 11,
                      fontWeight: 900,
                      letterSpacing: 0.8,
                      textTransform: "uppercase",
                      textAlign: "center",
                      padding: "9px 4px",
                      borderRight: "1px solid rgba(0,216,255,.08)",
                    }}
                  >
                    {weekday}
                  </div>
                ))}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 0 }}>
                {cashFlowCalendar.weeks.map((week, weekIndex) => (
                  <div
                    key={`week-${weekIndex}`}
                    style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))" }}
                  >
                    {week.map((day, dayIndex) => {
                      const heat = day
                        ? getCashFlowHeatStyle(day.actualNet, cashFlowHeatMax)
                        : {
                            background: "rgba(2,12,28,.45)",
                            border: "1px solid transparent",
                            boxShadow: "none",
                            valueColor: "#6c88b1",
                          };
                      const isFocused = day && focusedCalendarDay && focusedCalendarDay.day === day.day;
                      return (
                        <div
                          key={`${weekIndex}-${dayIndex}-${day?.day || "blank"}`}
                          onMouseEnter={() => setHoveredCalendarDay(day?.day || null)}
                          style={{
                            minHeight: 80,
                            padding: "7px 8px",
                            borderRight: "1px solid rgba(0,216,255,.07)",
                            borderBottom: "1px solid rgba(0,216,255,.07)",
                            background: day ? heat.background : "rgba(2,12,28,.45)",
                            boxShadow: day ? heat.boxShadow : "none",
                            border: isFocused ? "1px solid rgba(124,255,223,.52)" : heat.border,
                            cursor: day ? "pointer" : "default",
                            transition: "box-shadow 140ms ease, transform 140ms ease, border-color 140ms ease",
                            transform: isFocused ? "translateY(-2px)" : "none",
                          }}
                        >
                          {day ? (
                            <div style={{ display: "grid", gap: 5 }}>
                              <div
                                style={{
                                  color: day.isToday ? "#eaf7ff" : "#9bb6dc",
                                  fontSize: 12,
                                  fontWeight: 900,
                                }}
                              >
                                {day.day}
                              </div>
                              <div style={{ color: heat.valueColor, fontSize: 15, fontWeight: 900 }}>
                                {formatCompactSignedMoney(day.actualNet)}
                              </div>
                              <div style={{ color: "#8fb1d9", fontSize: 10 }}>
                                F {formatCompactMoney(day.monthEndForecast)}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            <div
              style={{
                marginTop: 12,
                border: "1px solid rgba(0,216,255,.22)",
                borderRadius: 12,
                display: "grid",
                gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                overflow: "hidden",
                background: "rgba(2,12,28,.68)",
              }}
            >
              {[
                ["Total Inflow", formatCompactMoney(cashFlowCalendar.totalInflow), "#7dffd5"],
                ["Total Outflow", formatCompactMoney(-cashFlowCalendar.totalOutflow), "#ff8ccc"],
                ["Net Cash Flow", formatCompactSignedMoney(cashFlowCalendar.monthNetActual), cashFlowCalendar.monthNetActual >= 0 ? "#7dffd5" : "#ff8ccc"],
                ["Sustainability Avg", `${cashFlowCalendar.sustainabilityAverage}/100`, "#8feaff"],
              ].map(([label, value, color]) => (
                <div
                  key={label}
                  style={{
                    padding: "11px 12px",
                    borderRight: "1px solid rgba(0,216,255,.08)",
                  }}
                >
                  <div style={{ color: "#7ea6d8", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.7 }}>
                    {label}
                  </div>
                  <div style={{ color, fontSize: 20, fontWeight: 900, marginTop: 6 }}>{value}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: "grid", gap: 12 }}>
            <div
              style={{
                border: "1px solid rgba(0,216,255,.22)",
                borderRadius: 14,
                background: "rgba(2,15,32,.72)",
                padding: "14px 14px 16px",
              }}
            >
              <div
                style={{
                  color: "#dff7ff",
                  fontWeight: 900,
                  fontSize: 12,
                  textTransform: "uppercase",
                  letterSpacing: 0.9,
                }}
              >
                Cash Flow
              </div>
              <div style={{ marginTop: 10, color: "#8ea8ca", fontSize: 12, textAlign: "center" }}>
                High Inflow
              </div>
              <div
                style={{
                  margin: "10px auto",
                  height: 170,
                  width: 18,
                  borderRadius: 999,
                  background:
                    "linear-gradient(180deg, rgba(125,255,213,1) 0%, rgba(74,180,255,.92) 50%, rgba(255,98,196,.92) 100%)",
                  boxShadow: "0 0 18px rgba(0,216,255,.26)",
                }}
              />
              <div style={{ color: "#8ea8ca", fontSize: 12, textAlign: "center" }}>High Outflow</div>
            </div>

            <div
              style={{
                border: "1px solid rgba(0,216,255,.22)",
                borderRadius: 14,
                background: "rgba(2,15,32,.72)",
                padding: "14px 14px 16px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 10,
                }}
              >
                <div
                  style={{
                    color: "#dff7ff",
                    fontWeight: 900,
                    fontSize: 12,
                    textTransform: "uppercase",
                    letterSpacing: 0.9,
                  }}
                >
                  Stability Score
                </div>
                <div
                  onMouseEnter={() => setShowStabilityInfo(true)}
                  onMouseLeave={() => setShowStabilityInfo(false)}
                  style={{ position: "relative", cursor: "help", lineHeight: 0 }}
                >
                  <span
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      border: "1px solid rgba(0,216,255,.55)",
                      color: "#8feaff",
                      fontSize: 11,
                      fontWeight: 900,
                      fontStyle: "italic",
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    i
                  </span>
                  {showStabilityInfo ? (
                    <div
                      style={{
                        position: "absolute",
                        top: "calc(100% + 8px)",
                        right: 0,
                        width: 244,
                        zIndex: 30,
                        background: "rgba(3,16,34,.98)",
                        border: "1px solid rgba(0,216,255,.32)",
                        borderRadius: 10,
                        padding: "10px 12px",
                        color: "#cfe6ff",
                        fontSize: 11,
                        fontWeight: 500,
                        lineHeight: 1.5,
                        letterSpacing: 0,
                        textTransform: "none",
                        boxShadow: "0 12px 30px rgba(0,0,0,.55)",
                      }}
                    >
                      Daily average of how steady your cash flow is. Each day starts at 100 and
                      loses points when actual cash flow drifts from your planned daily pace, when a
                      day has heavy net outflow, and when the projected month-end balance risks
                      dropping too low. Higher is steadier.
                    </div>
                  ) : null}
                </div>
              </div>
              <div
                style={{
                  width: 122,
                  height: 122,
                  borderRadius: "50%",
                  margin: "0 auto",
                  background: `conic-gradient(#00f59b 0 ${sustainabilityRing}%, rgba(255,255,255,.08) ${sustainabilityRing}% 100%)`,
                  display: "grid",
                  placeItems: "center",
                  boxShadow: "0 0 25px rgba(0,216,255,.22)",
                }}
              >
                <div
                  style={{
                    width: 88,
                    height: 88,
                    borderRadius: "50%",
                    background: "rgba(2,12,28,.92)",
                    display: "grid",
                    placeItems: "center",
                    color: "#eaf7ff",
                    fontWeight: 900,
                    fontSize: 34,
                  }}
                >
                  {sustainabilityRing}
                </div>
              </div>
              <div style={{ textAlign: "center", marginTop: 10 }}>
                <span
                  style={{
                    color: stabilityBand.color,
                    fontWeight: 950,
                    fontSize: 15,
                    letterSpacing: 0.5,
                    textShadow: `0 0 14px ${stabilityBand.color}55`,
                  }}
                >
                  {stabilityBand.label}
                </span>
                <span style={{ color: "#8ea8ca", fontSize: 11, marginLeft: 6 }}>
                  {stabilityBand.range}
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "center",
                  gap: "2px 8px",
                  marginTop: 8,
                }}
              >
                {[
                  { label: "Elite", color: "#00f59b", range: "80–100" },
                  { label: "Solid", color: "#38e0c0", range: "60–79" },
                  { label: "Steady", color: "#ffb65d", range: "40–59" },
                  { label: "At Risk", color: "#ff5d7a", range: "0–39" },
                ].map((tier) => (
                  <span
                    key={tier.label}
                    style={{
                      color: tier.label === stabilityBand.label ? tier.color : "#6f88aa",
                      fontSize: 10,
                      fontWeight: tier.label === stabilityBand.label ? 900 : 600,
                    }}
                  >
                    {tier.label} {tier.range}
                  </span>
                ))}
              </div>
              <div style={{ color: "#8ea8ca", fontSize: 12, textAlign: "center", marginTop: 8 }}>
                {cashFlowCalendar.riskDays} risk days · pulse {formatCompactSignedMoney(cashFlowCalendar.dailyPlanPulse)}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="ops-yearly-panel" style={{ ...styles.panel, padding: 24, marginTop: 8 }}>
        <div
          className="ops-yearly-header"
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
          className="ops-yearly-scroll"
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
