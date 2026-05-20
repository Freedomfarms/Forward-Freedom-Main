import { useState } from "react";
import { APP_TABS, budgetMonthNames, budgetMonths, chartSets } from "../data/constants.jsx";
import { buildMonthlyBudgetReview } from "../utils/budgetReview.js";
import { styles } from "../styles.js";
import { buildAreaPath, buildLinePath, money, parseMoney, wholeDollars } from "../utils/format.js";
import { buildSubscriptionOverview } from "../utils/subscriptions.js";
import { buildReconciledTrueCashSeries } from "../utils/planning.js";
import {
  parseChartDate,
  buildSyncedTrueCashChart,
  buildTrueCashProjectionSchedule,
} from "../utils/trueCashProjection.js";
import { HouseholdProfilesControl, InfoDot, MetricCard } from "./Common.jsx";

const CHART_HEIGHT = 300;
const NET_WORTH_HISTORY_W = 620;
const NET_WORTH_HISTORY_H = 180;
const MONTH_END_X = {
  Jan: 80,
  Feb: 147,
  Mar: 238,
  Apr: 318,
  May: 401,
  Jun: 481,
  Jul: 563,
  Aug: 646,
  Sep: 726,
  Oct: 809,
  Nov: 889,
  Dec: 972,
};

function getMonthStartX(month) {
  const monthIndex = budgetMonths.indexOf(month);
  if (monthIndex <= 0) return 0;
  const previousMonth = budgetMonths[monthIndex - 1];
  return MONTH_END_X[previousMonth] || 0;
}

function shouldUseExtendedProjectionChart(baseChart, anchorMonth, anchorYear) {
  const firstDate = baseChart?.dates?.[0];
  if (!firstDate) return true;

  const parsed = parseChartDate(firstDate);
  const firstMonthIndex = budgetMonths.indexOf(parsed.month);
  const anchorMonthIndex = budgetMonths.indexOf(anchorMonth);
  if (parsed.year !== anchorYear) return parsed.year > anchorYear;
  if (firstMonthIndex < 0 || anchorMonthIndex < 0) return true;
  return anchorMonthIndex < firstMonthIndex;
}

function trueCashToChartY(value, chartMax) {
  const safeMax = Math.max(Number(chartMax) || 1, 1);
  return Math.max(0, Math.min(CHART_HEIGHT, CHART_HEIGHT - (value / safeMax) * CHART_HEIGHT));
}

function buildChartMax(values) {
  const highestValue = values.reduce((max, value) => Math.max(max, Number(value) || 0), 1);
  return Math.ceil((highestValue * 1.4) / 1000) * 1000;
}

function buildYAxisLabels(chartMax) {
  return Array.from({ length: 6 }, (_, index) => {
    const value = chartMax - (chartMax / 5) * index;
    if (value >= 1000) return `$${Math.round(value / 1000)}K`;
    return wholeDollars(value);
  });
}

function buildProjectionAreaPath(points) {
  if (points.length === 0) return "";

  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  return (
    buildLinePath(points) +
    ` L ${lastPoint[0]} ${CHART_HEIGHT} L ${firstPoint[0]} ${CHART_HEIGHT} Z`
  );
}

function buildAllocationGradient(dynamicAllocations) {
  const positiveAllocations = dynamicAllocations.filter((item) => Number(item.valueNumber) > 0);
  if (positiveAllocations.length === 0) {
    return "conic-gradient(#12355f 0 100%)";
  }

  const total = positiveAllocations.reduce((sum, item) => sum + Number(item.valueNumber || 0), 0);
  let currentPercent = 0;

  return `conic-gradient(${positiveAllocations
    .map((item) => {
      const start = currentPercent;
      currentPercent += (Number(item.valueNumber || 0) / total) * 100;
      return `${item.color} ${start.toFixed(2)}% ${currentPercent.toFixed(2)}%`;
    })
    .join(", ")})`;
}

function buildFilledAreaPath(points, chartHeight) {
  if (points.length === 0) return "";

  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  return (
    buildLinePath(points) + ` L ${lastPoint[0]} ${chartHeight} L ${firstPoint[0]} ${chartHeight} Z`
  );
}

function formatSnapshotLabel(dateKey) {
  const [year, month, day] = String(dateKey || "")
    .split("-")
    .map(Number);
  if (!year || !month || !day) return dateKey;

  return new Date(year, month - 1, day).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function parseSnapshotDate(dateKey) {
  const [year, month, day] = String(dateKey || "")
    .split("-")
    .map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function buildNetWorthHistory(metricSnapshots, range) {
  const now = new Date();
  const rangeStart = new Date(now);
  if (range === "90D") rangeStart.setDate(now.getDate() - 89);
  if (range === "1Y") rangeStart.setFullYear(now.getFullYear() - 1);
  const rangeEntries = Object.entries(metricSnapshots || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([, snapshot]) => typeof snapshot?.totalNetWorth === "number")
    .filter(([dateKey]) => {
      const date = parseSnapshotDate(dateKey);
      if (!date) return false;
      if (range === "30D")
        return date >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
      if (range === "90D") return date >= rangeStart;
      if (range === "YTD") return date >= new Date(now.getFullYear(), 0, 1);
      if (range === "1Y") return date >= rangeStart;
      return true;
    });
  const entries = rangeEntries;

  if (entries.length === 0) {
    return {
      entries: [],
      points: [],
      linePath: "",
      areaPath: "",
      change: 0,
      latestValue: 0,
      labels: [],
    };
  }

  const values = entries.map(([, snapshot]) => Number(snapshot.totalNetWorth) || 0);
  const maxValue = Math.max(...values, 1);
  const minValue = Math.min(...values, 0);
  const paddedRange = Math.max((maxValue - minValue) * 0.18, 1);
  const upper = maxValue + paddedRange;
  const lower = minValue - paddedRange;
  const chartRange = Math.max(upper - lower, 1);

  const points = entries.map(([, snapshot], index) => {
    const x =
      entries.length === 1
        ? NET_WORTH_HISTORY_W / 2
        : (index / (entries.length - 1)) * NET_WORTH_HISTORY_W;
    const value = Number(snapshot.totalNetWorth) || 0;
    const y = NET_WORTH_HISTORY_H - ((value - lower) / chartRange) * NET_WORTH_HISTORY_H;
    return [x, y];
  });

  const latestValue = values[values.length - 1] || 0;
  const startValue = values[0] || 0;
  const change = latestValue - startValue;
  const labels =
    entries.length >= 3
      ? [entries[0][0], entries[Math.floor(entries.length / 2)][0], entries[entries.length - 1][0]]
      : entries.map(([dateKey]) => dateKey);

  return {
    entries,
    points,
    linePath: buildLinePath(points),
    areaPath: buildFilledAreaPath(points, NET_WORTH_HISTORY_H),
    change,
    latestValue,
    labels,
  };
}

export function DashboardView({
  activeRange,
  setActiveRange,
  setActiveTab,
  trueCash,
  transactions,
  subscriptions,
  incomeStreams,
  budgetRows,
  projectionAdjustments,
  dynamicMetrics,
  dynamicAllocations,
  metricSnapshots,
  householdProfilesProps,
  planningAnchor,
}) {
  const [hoverState, setHoverState] = useState(null);
  const [netWorthHistoryRange, setNetWorthHistoryRange] = useState("30D");
  const allocationGradient = buildAllocationGradient(dynamicAllocations);
  const allocationTotal = dynamicAllocations.reduce(
    (sum, item) => sum + Number(item.valueNumber || 0),
    0
  );
  const monthlyBudgetReview = buildMonthlyBudgetReview(transactions, budgetRows);
  const subscriptionOverview = buildSubscriptionOverview(subscriptions);
  const netWorthHistory = buildNetWorthHistory(metricSnapshots, netWorthHistoryRange);
  const projectionStartMonth = planningAnchor?.startingMonth || budgetMonths[0];
  const initialChartValues = buildSyncedTrueCashChart(chartSets[activeRange], trueCash);
  const initialProjectionYear = parseChartDate(initialChartValues.date).year;
  const chartValues =
    initialChartValues.supportsProjection &&
    shouldUseExtendedProjectionChart(initialChartValues, projectionStartMonth, initialProjectionYear) &&
    activeRange !== "ALL"
      ? buildSyncedTrueCashChart(chartSets.ALL, trueCash)
      : initialChartValues;
  const projectionStartingTrueCash =
    planningAnchor?.startingTrueCash !== undefined && planningAnchor?.startingTrueCash !== null
      ? Number(planningAnchor.startingTrueCash) || 0
      : parseMoney(chartValues.values[0] || chartValues.value);
  const projectionSchedule = buildTrueCashProjectionSchedule({
    chart: chartValues,
    incomeStreams,
    budgetRows,
    projectionAdjustments: {},
    startingMonth: projectionStartMonth,
    startingTrueCash: projectionStartingTrueCash,
  });
  const projectionYear = projectionSchedule[0]?.year || parseChartDate(chartValues.date).year;
  const reconciledTrueCashSeries = chartValues.supportsProjection
    ? buildReconciledTrueCashSeries({
        targetYear: projectionYear,
        incomeStreams,
        budgetRows,
        projectionAdjustments,
        startingMonth: projectionStartMonth,
        startingTrueCash: projectionStartingTrueCash,
        liveCurrentTrueCash: trueCash,
      })
    : [];
  const anchoredActualValues = chartValues.supportsProjection
    ? reconciledTrueCashSeries.map((entry) => entry.value).filter((value) => value !== null)
    : chartValues.values.map((value) => parseMoney(value));
  const anchoredActualDates = chartValues.supportsProjection
    ? reconciledTrueCashSeries
        .filter((entry) => entry.value !== null)
        .map((entry) => `${entry.month} ${entry.year} True Cash`)
    : chartValues.dates;
  const actualOpeningPoint =
    chartValues.supportsProjection
      ? {
          x: getMonthStartX(projectionStartMonth),
          y: 0,
          date: `${projectionStartMonth} ${projectionYear} Opening Balance`,
          value: wholeDollars(projectionStartingTrueCash),
          type: "actual",
        }
      : null;
  const chartMax = buildChartMax([
    ...anchoredActualValues,
    ...projectionSchedule.map((point) => point.value),
    projectionStartingTrueCash,
  ]);
  const yAxisLabels = buildYAxisLabels(chartMax);
  const actualChartPoints = chartValues.supportsProjection
    ? reconciledTrueCashSeries
        .filter((entry) => entry.value !== null && MONTH_END_X[entry.month])
        .map((entry) => [MONTH_END_X[entry.month], trueCashToChartY(entry.value, chartMax)])
    : chartValues.points.map((point, index) => [
        point[0],
        trueCashToChartY(parseMoney(chartValues.values[index]), chartMax),
      ]);
  const normalizedActualOpeningPoint = actualOpeningPoint
    ? {
        ...actualOpeningPoint,
        y: trueCashToChartY(projectionStartingTrueCash, chartMax),
      }
    : null;
  const chart = {
    ...chartValues,
    points: normalizedActualOpeningPoint
      ? [[normalizedActualOpeningPoint.x, normalizedActualOpeningPoint.y], ...actualChartPoints]
      : actualChartPoints,
    dates: normalizedActualOpeningPoint
      ? [normalizedActualOpeningPoint.date, ...anchoredActualDates]
      : anchoredActualDates,
    values: normalizedActualOpeningPoint
      ? [normalizedActualOpeningPoint.value, ...anchoredActualValues.map((value) => money(value))]
      : anchoredActualValues.map((value) => money(value)),
  };
  const linePath = chart.points.length ? buildLinePath(chart.points) : "";
  const areaPath = chart.points.length > 1 ? buildAreaPath(chart.points) : "";
  const projectionStartPoint =
    projectionSchedule.length
      ? {
          x: getMonthStartX(projectionStartMonth),
          y: trueCashToChartY(projectionStartingTrueCash, chartMax),
          date: `${projectionStartMonth} ${projectionSchedule[0]?.year || ""} Opening Balance`.trim(),
          value: wholeDollars(projectionStartingTrueCash),
          profit: 0,
          adjustment: 0,
          type: "projected",
        }
      : null;
  const projectedTrueCashPoints = projectionSchedule
    .filter((point) => point.type === "projected" && MONTH_END_X[point.month])
    .map((point) => ({
      ...point,
      x: MONTH_END_X[point.month],
      y: trueCashToChartY(point.value, chartMax),
      value: point.formattedValue,
    }));
  const projectionLinePoints = projectionStartPoint
    ? [projectionStartPoint, ...projectedTrueCashPoints]
    : projectedTrueCashPoints;
  const projectionPath =
    projectedTrueCashPoints.length > 0
      ? buildLinePath(projectionLinePoints.map((point) => [point.x, point.y]))
      : "";
  const projectionAreaPath =
    projectedTrueCashPoints.length > 0
      ? buildProjectionAreaPath(projectionLinePoints.map((point) => [point.x, point.y]))
      : "";
  const chartHoverPoints = chart.points.map((point, index) => {
    const labelIndex =
      chart.dates.length === chart.points.length
        ? index
        : Math.round((index / Math.max(chart.points.length - 1, 1)) * (chart.dates.length - 1));

    return {
      x: point[0],
      y: point[1],
      date: chart.dates[labelIndex] || chart.xAxis[labelIndex] || chart.date,
      value: chart.values[labelIndex] || chart.value,
      type: "actual",
    };
  });
  const combinedHoverPoints = [
    ...chartHoverPoints,
    ...(projectionStartPoint ? [projectionStartPoint] : []),
    ...projectedTrueCashPoints.map((point) => ({
      x: point.x,
      y: point.y,
      date: point.date,
      value: point.value,
      profit: point.profit,
      adjustment: point.adjustment,
      type: point.type,
    })),
  ];
  const isProjectionHover = hoverState?.point.type === "projected";

  return (
    <>
      <header style={{ ...styles.pageHeader, marginBottom: 20 }}>
        <div>
          <h1 style={styles.pageTitle}>Command Center</h1>
          <p style={styles.pageSubtitle}>Real-time overview of your financial position</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <HouseholdProfilesControl {...householdProfilesProps} />
          <div style={{ display: "flex", alignItems: "center", gap: 28, fontSize: 20 }}>
            <span>⌕</span>
            <span>♧</span>
            <div
              style={{
                position: "relative",
                width: 48,
                height: 48,
                borderRadius: 999,
                border: "1px solid #148cff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#19d5ff",
                fontSize: 16,
                boxShadow: "0 0 22px rgba(0,120,255,.45)",
              }}
            >
              KP
              <span
                style={{
                  position: "absolute",
                  right: 0,
                  bottom: 0,
                  width: 11,
                  height: 11,
                  borderRadius: 99,
                  background: "#00de86",
                }}
              />
            </div>
          </div>
        </div>
      </header>

      <section style={{ ...styles.panel, padding: 20, width: "100%", overflow: "hidden" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 34,
          }}
        >
          <div
            style={{ display: "flex", alignItems: "center", gap: 12, textTransform: "uppercase" }}
          >
            <span style={{ color: "#00d8ff", fontSize: 24 }}>▧</span> TRUE CASH <InfoDot />
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <button
              style={{
                color: "#f2f7ff",
                background: "rgba(1,10,24,.55)",
                border: "1px solid rgba(54,126,220,.38)",
                borderRadius: 7,
                padding: "10px 16px",
              }}
            >
              ▣ &nbsp; {chart.dateRange}⌄
            </button>
            <button
              style={{
                color: "#f2f7ff",
                background: "rgba(1,10,24,.55)",
                border: "1px solid rgba(54,126,220,.38)",
                borderRadius: 7,
                padding: "10px 16px",
              }}
            >
              ⇩ &nbsp; Export Report
            </button>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            marginBottom: 24,
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-end", gap: 12 }}>
            <div style={{ color: "white", fontSize: 38, fontWeight: 720, letterSpacing: 0.4 }}>
              {money(trueCash)}
            </div>
            <div style={{ color: "#00f59b", fontSize: 14, fontWeight: 800, paddingBottom: 8 }}>
              ↑ {chart.change}
            </div>
            <div
              style={{
                color: "#cbd8ef",
                background: "rgba(9,31,61,.7)",
                borderRadius: 5,
                padding: "7px 10px",
                fontSize: 14,
                marginBottom: 1,
              }}
            >
              {chart.label}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 26,
              color: "#c9d8ee",
              fontSize: 14,
            }}
          >
            {["1M", "3M", "6M", "YTD", "1Y", "ALL"].map((range) => (
              <button
                key={range}
                onClick={() => {
                  setActiveRange(range);
                  setHoverState(null);
                }}
                style={{
                  color: activeRange === range ? "#00d8ff" : "#c9d8ee",
                  border:
                    activeRange === range
                      ? "1px solid rgba(0,136,255,.55)"
                      : "1px solid transparent",
                  background: activeRange === range ? "rgba(0,104,255,.18)" : "transparent",
                  borderRadius: 7,
                  padding: activeRange === range ? "12px 16px" : "12px 0",
                  cursor: "pointer",
                  fontSize: 14,
                  boxShadow: activeRange === range ? "0 0 18px rgba(0,136,255,.22)" : "none",
                }}
              >
                {range}
              </button>
            ))}
            <span
              style={{
                border: "1px solid rgba(54,126,220,.28)",
                borderRadius: 7,
                padding: "11px 13px",
              }}
            >
              ↗
            </span>
          </div>
        </div>

        <div style={{ position: "relative", height: 330, paddingLeft: 56, width: "100%" }}>
          {yAxisLabels.map((label, index) => (
            <div
              key={label}
              style={{
                position: "absolute",
                top: (index / Math.max(yAxisLabels.length - 1, 1)) * CHART_HEIGHT,
                left: 0,
                right: 0,
                display: "flex",
                alignItems: "center",
                color: "#b5c7e0",
                fontSize: 14,
              }}
            >
              <span style={{ width: 48, textAlign: "right" }}>{label}</span>
              <div
                style={{ marginLeft: 16, height: 1, flex: 1, background: "rgba(110,168,255,.12)" }}
              />
            </div>
          ))}

          <svg
            style={{
              position: "absolute",
              left: 64,
              top: 0,
              height: 300,
              width: "calc(100% - 64px)",
              overflow: "visible",
            }}
            viewBox="0 0 972 300"
            preserveAspectRatio="none"
          >
            <defs>
              <linearGradient id="netWorthFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#0077ff" stopOpacity="0.65" />
                <stop offset="1" stopColor="#001b3d" stopOpacity="0.05" />
              </linearGradient>
              <linearGradient id="projectedTrueCashFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#ff9f1c" stopOpacity="0.65" />
                <stop offset="1" stopColor="#3a1700" stopOpacity="0.05" />
              </linearGradient>
              <filter id="netWorthGlow">
                <feGaussianBlur stdDeviation="4" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <filter id="projectedTrueCashGlow">
                <feGaussianBlur stdDeviation="4" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <path d={areaPath} fill="url(#netWorthFill)" />
            <path
              d={linePath}
              fill="none"
              stroke="#04c8ff"
              strokeWidth="3"
              filter="url(#netWorthGlow)"
            />
            {projectedTrueCashPoints.length > 0 ? (
              <>
                <path d={projectionAreaPath} fill="url(#projectedTrueCashFill)" />
                <path
                  d={projectionPath}
                  fill="none"
                  stroke="#ff9f1c"
                  strokeWidth="3"
                  filter="url(#projectedTrueCashGlow)"
                />
              </>
            ) : null}
            <rect
              x="0"
              y="0"
              width="972"
              height="300"
              fill="transparent"
              style={{ cursor: "crosshair" }}
              onMouseMove={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                const cursorX = Math.min(Math.max(event.clientX - box.left, 0), box.width);
                const cursorY = Math.min(Math.max(event.clientY - box.top, 0), box.height);
                const x = (cursorX / box.width) * 972;
                const y = (cursorY / box.height) * CHART_HEIGHT;
                let closest = combinedHoverPoints[0];
                if (!closest) return;

                combinedHoverPoints.forEach((point) => {
                  const pointDistance = Math.hypot(
                    (point.x - x) / 972,
                    (point.y - y) / CHART_HEIGHT
                  );
                  const closestDistance = Math.hypot(
                    (closest.x - x) / 972,
                    (closest.y - y) / CHART_HEIGHT
                  );
                  if (pointDistance < closestDistance) closest = point;
                });
                setHoverState({
                  cursorX: cursorX + 64,
                  pointX: (closest.x / 972) * box.width + 64,
                  pointY: closest.y,
                  point: closest,
                });
              }}
              onMouseLeave={() => setHoverState(null)}
            />
          </svg>

          {hoverState ? (
            <div
              style={{
                position: "absolute",
                left: hoverState.cursorX,
                top: 0,
                height: 300,
                width: 1,
                background: isProjectionHover
                  ? "linear-gradient(to bottom, rgba(255,159,28,.08), rgba(255,159,28,.95), rgba(255,159,28,.08))"
                  : "linear-gradient(to bottom, rgba(0,216,255,.08), rgba(0,216,255,.95), rgba(0,216,255,.08))",
                boxShadow: isProjectionHover
                  ? "0 0 18px rgba(255,159,28,.85)"
                  : "0 0 18px rgba(0,216,255,.85)",
                pointerEvents: "none",
              }}
            />
          ) : null}

          {hoverState ? (
            <div
              style={{
                position: "absolute",
                left: `min(max(${hoverState.cursorX - 92}px, 64px), calc(100% - 184px))`,
                top: Math.max(12, Math.min(210, hoverState.pointY - 76)),
                border: isProjectionHover
                  ? "1px solid rgba(255,159,28,.62)"
                  : "1px solid rgba(0,216,255,.55)",
                background: "linear-gradient(180deg, rgba(6,22,43,.98), rgba(2,9,22,.96))",
                borderRadius: 10,
                padding: "12px 14px",
                minWidth: 184,
                boxShadow: isProjectionHover
                  ? "0 0 28px rgba(255,159,28,.24), inset 0 0 18px rgba(255,159,28,.08)"
                  : "0 0 28px rgba(0,136,255,.28), inset 0 0 18px rgba(0,216,255,.08)",
                pointerEvents: "none",
                zIndex: 5,
              }}
            >
              <div
                style={{
                  color: isProjectionHover ? "#ffd08a" : "#8feaff",
                  fontSize: 12,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                }}
              >
                {hoverState.point.type === "projected" ? "Projected True Cash" : "True Cash"}
              </div>
              <div style={{ color: "white", fontSize: 15, fontWeight: 800, marginTop: 7 }}>
                {hoverState.point.date}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 9,
                  color: "#d7ecff",
                  fontSize: 14,
                }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 999,
                    background: isProjectionHover ? "#ff9f1c" : "#00d8ff",
                    boxShadow: isProjectionHover
                      ? "0 0 12px rgba(255,159,28,.9)"
                      : "0 0 12px rgba(0,216,255,.9)",
                  }}
                />
                {hoverState.point.value}
              </div>
              {hoverState.point.type === "projected" ? (
                <div style={{ color: "#a8bfdc", fontSize: 12, marginTop: 7 }}>
                  Monthly profit: {hoverState.point.profit >= 0 ? "+" : ""}
                  {money(hoverState.point.profit)}
                  <br />
                  Adjustment: {hoverState.point.adjustment >= 0 ? "+" : ""}
                  {wholeDollars(hoverState.point.adjustment)}
                </div>
              ) : null}
            </div>
          ) : null}

          {hoverState ? (
            <div
              style={{
                position: "absolute",
                left: hoverState.pointX - 6,
                top: hoverState.pointY - 6,
                width: 12,
                height: 12,
                borderRadius: 999,
                background: isProjectionHover ? "#ffd08a" : "#d9f7ff",
                boxShadow: isProjectionHover
                  ? "0 0 18px rgba(255,159,28,1)"
                  : "0 0 18px rgba(0,216,255,1)",
                pointerEvents: "none",
                zIndex: 4,
              }}
            />
          ) : null}

          <div
            style={{
              position: "absolute",
              left: 64,
              right: 0,
              bottom: 0,
              display: "flex",
              justifyContent: "space-between",
              color: "#c9d8ee",
              fontSize: 14,
            }}
          >
            {chart.xAxis.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
          {projectedTrueCashPoints.length > 0 ? (
            <div
              style={{
                position: "absolute",
                right: 0,
                top: -4,
                display: "flex",
                gap: 18,
                color: "#a8bfdc",
                fontSize: 12,
                fontWeight: 800,
                textTransform: "uppercase",
                letterSpacing: 0.7,
              }}
            >
              <span>
                <b
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    borderRadius: 99,
                    background: "#00d8ff",
                    boxShadow: "0 0 10px rgba(0,216,255,.8)",
                    marginRight: 8,
                  }}
                />
                Actual
              </span>
              <span>
                <b
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    borderRadius: 99,
                    background: "#ff9f1c",
                    boxShadow: "0 0 10px rgba(255,159,28,.8)",
                    marginRight: 8,
                  }}
                />
                Projected
              </span>
            </div>
          ) : null}
        </div>
      </section>

      <section
        style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginTop: 16 }}
      >
        {dynamicMetrics.map((metric) => (
          <MetricCard key={metric.title} metric={metric} />
        ))}
      </section>

      <section
        style={{ display: "grid", gridTemplateColumns: "1fr 1.08fr", gap: 16, marginTop: 16 }}
      >
        <div style={{ ...styles.panel, padding: 20 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              textTransform: "uppercase",
              marginBottom: 18,
            }}
          >
            Monthly Budget Review <InfoDot />
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 18,
              marginBottom: 16,
            }}
          >
            <div>
              <div style={{ color: "white", fontSize: 22, fontWeight: 900 }}>
                {budgetMonthNames[monthlyBudgetReview.month]} {monthlyBudgetReview.year}
              </div>
              <div style={{ color: "#8ea8ca", fontSize: 13, marginTop: 6 }}>
                Budgeted plan vs actual spending across your highest-impact categories.
              </div>
              {subscriptionOverview.activeCount > 0 ? (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                  <span
                    style={{
                      border: "1px solid rgba(0,216,255,.18)",
                      borderRadius: 999,
                      padding: "6px 10px",
                      color: "#8feaff",
                      fontSize: 12,
                    }}
                  >
                    Auto-pay commitments {money(subscriptionOverview.activeMonthly)}/mo
                  </span>
                  {subscriptionOverview.topAccounts[0] ? (
                    <span
                      style={{
                        border: "1px solid rgba(0,216,255,.18)",
                        borderRadius: 999,
                        padding: "6px 10px",
                        color: "#b8d3f3",
                        fontSize: 12,
                      }}
                    >
                      Highest billed account: {subscriptionOverview.topAccounts[0].account}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => setActiveTab(APP_TABS.RECURRING_SUBSCRIPTIONS)}
                style={{
                  background: "rgba(0,136,255,.08)",
                  border: "1px solid rgba(0,216,255,.18)",
                  color: "#d7ebff",
                  borderRadius: 8,
                  padding: "10px 14px",
                  cursor: "pointer",
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                }}
              >
                Open Subscriptions
              </button>
              <button
                onClick={() => setActiveTab(APP_TABS.BUDGET_COMMAND_CENTER)}
                style={{
                  background: "rgba(0,136,255,.12)",
                  border: "1px solid rgba(0,216,255,.28)",
                  color: "#d7ebff",
                  borderRadius: 8,
                  padding: "10px 14px",
                  cursor: "pointer",
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                }}
              >
                Open Budget Center
              </button>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
            {[
              ["Budget", money(monthlyBudgetReview.monthlyBudget), "#8feaff"],
              ["Spent", money(monthlyBudgetReview.monthlySpent), "#ffb65d"],
              [
                monthlyBudgetReview.remaining >= 0 ? "Remaining" : "Over Budget",
                `${monthlyBudgetReview.remaining >= 0 ? "" : "-"}${money(
                  Math.abs(monthlyBudgetReview.remaining)
                )}`,
                monthlyBudgetReview.remaining >= 0 ? "#00f59b" : "#ff5d7a",
              ],
            ].map(([label, value, color]) => (
              <div
                key={label}
                style={{
                  border: "1px solid rgba(0,136,255,.18)",
                  borderRadius: 14,
                  background: "rgba(3,17,32,.58)",
                  padding: "16px 18px 18px",
                }}
              >
                <div
                  style={{
                    color: "#8fb1d9",
                    fontSize: 12,
                    textTransform: "uppercase",
                    letterSpacing: 0.9,
                    marginBottom: 10,
                  }}
                >
                  {label}
                </div>
                <div
                  style={{
                    color,
                    fontSize: 22,
                    fontWeight: 900,
                    lineHeight: 1.2,
                  }}
                >
                  {value}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ ...styles.panel, padding: 20 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              textTransform: "uppercase",
              marginBottom: 20,
            }}
          >
            Net Worth Breakdown <InfoDot />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 30 }}>
            <div
              style={{
                position: "relative",
                width: 182,
                height: 182,
                borderRadius: 999,
                background: allocationGradient,
                padding: 30,
                boxShadow: "0 0 35px rgba(0,174,255,.45)",
                flexShrink: 0,
              }}
            >
              <div
                style={{ width: "100%", height: "100%", borderRadius: 999, background: "#031120" }}
              />
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  textAlign: "center",
                  pointerEvents: "none",
                }}
              >
                <div
                  style={{
                    color: "white",
                    fontSize: 24,
                    fontWeight: 900,
                    lineHeight: 1.15,
                    maxWidth: 112,
                  }}
                >
                  {wholeDollars(allocationTotal)}
                </div>
              </div>
            </div>
            <div style={{ flex: 1, fontSize: 14 }}>
              {dynamicAllocations.map((item) => (
                <div
                  key={item.name}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) 126px 64px",
                    gap: 16,
                    marginBottom: 16,
                    alignItems: "center",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <span style={{ minWidth: 0 }}>
                    <b
                      style={{
                        display: "inline-block",
                        width: 10,
                        height: 10,
                        borderRadius: 999,
                        background: item.color,
                        marginRight: 12,
                      }}
                    />
                    {item.name}
                  </span>
                  <span style={{ textAlign: "right", whiteSpace: "nowrap" }}>{item.amount}</span>
                  <span style={{ textAlign: "right", whiteSpace: "nowrap" }}>{item.percent}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section style={{ ...styles.panel, padding: 20, marginTop: 16 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 18,
            marginBottom: 18,
          }}
        >
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                textTransform: "uppercase",
                marginBottom: 10,
              }}
            >
              Net Worth History <InfoDot />
            </div>
            <div style={{ color: "white", fontSize: 26, fontWeight: 900 }}>
              {wholeDollars(netWorthHistory.latestValue)}
            </div>
            <div
              style={{
                color: netWorthHistory.change >= 0 ? "#00f59b" : "#ff5d7a",
                fontSize: 13,
                fontWeight: 800,
                marginTop: 6,
              }}
            >
              {netWorthHistory.entries.length > 1
                ? `${netWorthHistory.change >= 0 ? "+" : "-"}${wholeDollars(
                    Math.abs(netWorthHistory.change)
                  )} over tracked period`
                : "Daily history is building"}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ display: "flex", gap: 8 }}>
              {["30D", "90D", "YTD", "1Y"].map((range) => (
                <button
                  key={range}
                  onClick={() => setNetWorthHistoryRange(range)}
                  style={{
                    background:
                      netWorthHistoryRange === range
                        ? "rgba(0,136,255,.18)"
                        : "rgba(0,136,255,.08)",
                    border:
                      netWorthHistoryRange === range
                        ? "1px solid rgba(0,216,255,.42)"
                        : "1px solid rgba(0,216,255,.18)",
                    color: netWorthHistoryRange === range ? "#eaf7ff" : "#9fbddb",
                    borderRadius: 8,
                    padding: "8px 10px",
                    cursor: "pointer",
                    fontWeight: 800,
                    fontSize: 12,
                  }}
                >
                  {range}
                </button>
              ))}
            </div>
            <button
              onClick={() => setActiveTab(APP_TABS.ADD_ACCOUNTS)}
              style={{
                background: "rgba(0,136,255,.12)",
                border: "1px solid rgba(0,216,255,.28)",
                color: "#d7ebff",
                borderRadius: 8,
                padding: "10px 14px",
                cursor: "pointer",
                fontWeight: 700,
                whiteSpace: "nowrap",
              }}
            >
              View Accounts
            </button>
          </div>
        </div>

        {netWorthHistory.points.length > 1 ? (
          <div style={{ position: "relative", padding: "8px 0 24px" }}>
            <svg
              viewBox={`0 0 ${NET_WORTH_HISTORY_W} ${NET_WORTH_HISTORY_H}`}
              style={{ width: "100%", overflow: "visible" }}
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id="net-worth-history-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#00d8ff" stopOpacity="0.22" />
                  <stop offset="100%" stopColor="#00d8ff" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
                <line
                  key={ratio}
                  x1={0}
                  y1={ratio * NET_WORTH_HISTORY_H}
                  x2={NET_WORTH_HISTORY_W}
                  y2={ratio * NET_WORTH_HISTORY_H}
                  stroke="rgba(0,136,255,.10)"
                  strokeWidth={1}
                />
              ))}
              <path d={netWorthHistory.areaPath} fill="url(#net-worth-history-fill)" />
              <path
                d={netWorthHistory.linePath}
                fill="none"
                stroke="#00d8ff"
                strokeWidth="3"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <circle
                cx={netWorthHistory.points[netWorthHistory.points.length - 1][0]}
                cy={netWorthHistory.points[netWorthHistory.points.length - 1][1]}
                r="4"
                fill="#8feaff"
              />
            </svg>

            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                display: "flex",
                justifyContent: "space-between",
                color: "#8fb1d9",
                fontSize: 12,
              }}
            >
              {netWorthHistory.labels.map((label) => (
                <span key={label}>{formatSnapshotLabel(label)}</span>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ color: "#8ea8ca", fontSize: 14, paddingTop: 8 }}>
            Keep using the app daily to build a net worth trendline from tracked snapshots.
          </div>
        )}
      </section>
    </>
  );
}
