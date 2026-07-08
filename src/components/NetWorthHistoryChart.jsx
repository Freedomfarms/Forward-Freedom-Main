import { useEffect, useMemo, useState } from "react";
import { buildLinePath, wholeDollars } from "../utils/format.js";

const CHART_W = 620;
const CHART_H = 180;
const Y_AXIS_WIDTH = 56;

function parseSnapshotDate(dateKey) {
  const [year, month, day] = String(dateKey || "")
    .split("-")
    .map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
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

function formatSnapshotListLabel(dateKey) {
  const [year, month, day] = String(dateKey || "")
    .split("-")
    .map(Number);
  if (!year || !month || !day) return dateKey;

  return new Date(year, month - 1, day).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function buildFilledAreaPath(points, chartHeight) {
  if (points.length === 0) return "";

  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  return (
    buildLinePath(points) + ` L ${lastPoint[0]} ${chartHeight} L ${firstPoint[0]} ${chartHeight} Z`
  );
}

function buildYAxisLabels(lower, upper, count = 5) {
  return Array.from({ length: count }, (_, index) => {
    const value = upper - ((upper - lower) / Math.max(count - 1, 1)) * index;
    return wholeDollars(value);
  });
}

function buildNetWorthHistory(metricSnapshots, range) {
  const now = new Date();
  const rangeStart = new Date(now);
  if (range === "90D") rangeStart.setDate(now.getDate() - 89);
  if (range === "1Y") rangeStart.setFullYear(now.getFullYear() - 1);

  const entries = Object.entries(metricSnapshots || {})
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

  if (entries.length === 0) {
    return {
      entries: [],
      points: [],
      hoverPoints: [],
      linePath: "",
      areaPath: "",
      change: 0,
      latestValue: 0,
      labels: [],
      yAxisLabels: [],
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
      entries.length === 1 ? CHART_W / 2 : (index / (entries.length - 1)) * CHART_W;
    const value = Number(snapshot.totalNetWorth) || 0;
    const y = CHART_H - ((value - lower) / chartRange) * CHART_H;
    return [x, y];
  });

  const hoverPoints = entries.map(([dateKey, snapshot], index) => {
    const value = Number(snapshot.totalNetWorth) || 0;
    const [x, y] = points[index];
    const previousValue = index > 0 ? values[index - 1] : null;
    return {
      dateKey,
      label: formatSnapshotLabel(dateKey),
      listLabel: formatSnapshotListLabel(dateKey),
      value,
      delta: previousValue === null ? null : value - previousValue,
      x,
      y,
      index,
    };
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
    hoverPoints,
    linePath: buildLinePath(points),
    areaPath: buildFilledAreaPath(points, CHART_H),
    change,
    latestValue,
    labels,
    yAxisLabels: buildYAxisLabels(lower, upper),
  };
}

export function NetWorthHistoryChart({ metricSnapshots, range }) {
  const history = useMemo(
    () => buildNetWorthHistory(metricSnapshots, range),
    [metricSnapshots, range]
  );
  const defaultActiveIndex = Math.max(0, history.hoverPoints.length - 1);
  const [activeIndex, setActiveIndex] = useState(defaultActiveIndex);
  const [flashToken, setFlashToken] = useState(0);

  useEffect(() => {
    setActiveIndex(defaultActiveIndex);
  }, [defaultActiveIndex, range]);

  const activePoint = history.hoverPoints[activeIndex] || history.hoverPoints[defaultActiveIndex];
  const displayValue = activePoint?.value ?? history.latestValue;
  const displayDelta =
    activePoint?.delta ??
    (history.hoverPoints.length > 1 ? history.change : null);

  const focusPoint = (index) => {
    if (index < 0 || index >= history.hoverPoints.length) return;
    setActiveIndex((current) => {
      if (current === index) return current;
      setFlashToken((token) => token + 1);
      return index;
    });
  };

  const resetPoint = () => {
    if (activeIndex === defaultActiveIndex) return;
    setActiveIndex(defaultActiveIndex);
    setFlashToken((token) => token + 1);
  };

  if (history.points.length <= 1) {
    return (
      <div style={{ color: "#8ea8ca", fontSize: 14, paddingTop: 8 }}>
        Keep using the app daily to build a net worth trendline from tracked snapshots.
      </div>
    );
  }

  return (
    <div className="net-worth-history-chart" onMouseLeave={resetPoint}>
      <div className="net-worth-history-layout">
        <div className="net-worth-history-value-list">
          {[...history.hoverPoints].reverse().map((point) => {
            const isActive = point.index === activeIndex;
            return (
              <button
                key={point.dateKey}
                type="button"
                onMouseEnter={() => focusPoint(point.index)}
                onFocus={() => focusPoint(point.index)}
                onClick={() => focusPoint(point.index)}
                className={`net-worth-history-value-item${isActive ? " is-active" : ""}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  textAlign: "left",
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: isActive
                    ? "1px solid rgba(0,216,255,.55)"
                    : "1px solid rgba(0,136,255,.12)",
                  background: isActive ? "rgba(0,136,255,.18)" : "rgba(3,17,32,.42)",
                  cursor: "pointer",
                  transition: "all 140ms ease",
                }}
              >
                <span
                  style={{
                    minWidth: 0,
                    color: isActive ? "#ffffff" : "#cfe2ff",
                    fontSize: 12,
                    fontWeight: 800,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {point.listLabel}
                </span>
                <span
                  style={{
                    color: isActive ? "#ffffff" : "#8feaff",
                    fontSize: 12,
                    fontWeight: 900,
                    flexShrink: 0,
                  }}
                >
                  {wholeDollars(point.value)}
                </span>
              </button>
            );
          })}
        </div>

        <div className="net-worth-history-chart-cell">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-end",
              gap: 12,
              marginBottom: 12,
            }}
          >
            <div>
              <div
                key={`value-${flashToken}`}
                className="budget-orbit-metric-flash"
                style={{ color: "white", fontSize: 24, fontWeight: 900, lineHeight: 1 }}
              >
                {wholeDollars(displayValue)}
              </div>
              {displayDelta !== null ? (
                <div
                  style={{
                    color: displayDelta >= 0 ? "#00f59b" : "#ff5d7a",
                    fontSize: 12,
                    fontWeight: 800,
                    marginTop: 6,
                  }}
                >
                  {displayDelta >= 0 ? "+" : "-"}
                  {wholeDollars(Math.abs(displayDelta))}
                  {activePoint?.delta !== null && activePoint?.delta !== undefined
                    ? " vs prior snapshot"
                    : " over tracked period"}
                </div>
              ) : (
                <div style={{ color: "#8ea8ca", fontSize: 12, fontWeight: 700, marginTop: 6 }}>
                  Daily history is building
                </div>
              )}
            </div>
            <div style={{ color: "#8fb1d9", fontSize: 11, fontWeight: 700, textAlign: "right" }}>
              Hover a date or chart point
            </div>
          </div>

          <div style={{ position: "relative", padding: `0 0 24px ${Y_AXIS_WIDTH}px` }}>
            {history.yAxisLabels.map((label, index) => (
              <div
                key={label}
                style={{
                  position: "absolute",
                  top: (index / Math.max(history.yAxisLabels.length - 1, 1)) * CHART_H,
                  left: 0,
                  right: 0,
                  display: "flex",
                  alignItems: "center",
                  color: "#8fb1d9",
                  fontSize: 11,
                  fontWeight: 700,
                  transform: "translateY(-50%)",
                }}
              >
                <span style={{ width: Y_AXIS_WIDTH - 8, textAlign: "right", paddingRight: 8 }}>
                  {label}
                </span>
                <div
                  style={{
                    marginLeft: 8,
                    height: 1,
                    flex: 1,
                    background: "rgba(0,136,255,.10)",
                  }}
                />
              </div>
            ))}

            <svg
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              style={{
                position: "relative",
                width: "100%",
                overflow: "visible",
                display: "block",
              }}
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id="net-worth-history-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#00d8ff" stopOpacity="0.22" />
                  <stop offset="100%" stopColor="#00d8ff" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <path d={history.areaPath} fill="url(#net-worth-history-fill)" />
              <path
                d={history.linePath}
                fill="none"
                stroke="#00d8ff"
                strokeWidth="3"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {activePoint ? (
                <line
                  x1={activePoint.x}
                  y1={0}
                  x2={activePoint.x}
                  y2={CHART_H}
                  stroke="rgba(0,216,255,.85)"
                  strokeWidth={1}
                  pointerEvents="none"
                />
              ) : null}
              {history.hoverPoints.map((point) => {
                const isActive = point.index === activeIndex;
                return (
                  <g key={point.dateKey}>
                    <circle
                      cx={point.x}
                      cy={point.y}
                      r={isActive ? 7 : 5}
                      fill={isActive ? "#8feaff" : "#00d8ff"}
                      stroke={isActive ? "#ffffff" : "rgba(143,234,255,.55)"}
                      strokeWidth={isActive ? 2 : 1}
                      style={{ transition: "all 140ms ease" }}
                      pointerEvents="none"
                    />
                    <circle
                      cx={point.x}
                      cy={point.y}
                      r={14}
                      fill="transparent"
                      style={{ cursor: "pointer" }}
                      onMouseEnter={() => focusPoint(point.index)}
                      onClick={() => focusPoint(point.index)}
                    />
                  </g>
                );
              })}
              <rect
                x={0}
                y={0}
                width={CHART_W}
                height={CHART_H}
                fill="transparent"
                style={{ cursor: "crosshair" }}
                onMouseMove={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  const cursorX = Math.min(Math.max(event.clientX - box.left, 0), box.width);
                  const x = (cursorX / box.width) * CHART_W;
                  let closest = history.hoverPoints[0];
                  if (!closest) return;

                  history.hoverPoints.forEach((point) => {
                    const pointDistance = Math.abs(point.x - x);
                    const closestDistance = Math.abs(closest.x - x);
                    if (pointDistance < closestDistance) closest = point;
                  });
                  focusPoint(closest.index);
                }}
              />
            </svg>

            <div
              style={{
                position: "absolute",
                left: Y_AXIS_WIDTH,
                right: 0,
                bottom: 0,
                display: "flex",
                justifyContent: "space-between",
                color: "#8fb1d9",
                fontSize: 12,
              }}
            >
              {history.labels.map((label) => (
                <span key={label}>{formatSnapshotLabel(label)}</span>
              ))}
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
