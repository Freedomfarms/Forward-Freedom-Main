import { useEffect, useMemo, useState } from "react";
import { budgetMonthNames, budgetMonths } from "../data/constants.jsx";
import { buildMonthlySpendSnapshot } from "../utils/budgetReview.js";
import { money, wholeDollars } from "../utils/format.js";

const ON_BUDGET_COLOR = "#00d8ff";
const OVERSPENT_COLOR = "#ff5d7a";
const VIEW_SIZE = 248;
const CHART_CENTER = VIEW_SIZE / 2;
const OUTER_RADIUS = 86;
const INNER_RADIUS = 56;
const LABEL_RADIUS = 108;
const SEGMENT_GAP = 2.4;

function polarToCartesian(cx, cy, radius, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  };
}

function describeDonutSegment(cx, cy, outerR, innerR, startAngle, endAngle) {
  const outerStart = polarToCartesian(cx, cy, outerR, startAngle);
  const outerEnd = polarToCartesian(cx, cy, outerR, endAngle);
  const innerStart = polarToCartesian(cx, cy, innerR, endAngle);
  const innerEnd = polarToCartesian(cx, cy, innerR, startAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerStart.x} ${innerStart.y}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${innerEnd.x} ${innerEnd.y}`,
    "Z",
  ].join(" ");
}

function getMonthSegmentAngles(index) {
  const start = index * 30 - 90 + SEGMENT_GAP / 2;
  const end = (index + 1) * 30 - 90 - SEGMENT_GAP / 2;
  return { start, end };
}

function getMonthLabelAngle(index) {
  return index * 30 + 15 - 90;
}

function getSegmentColor(entry, activeMonth) {
  const isActive = entry.month === activeMonth;
  if (entry.isOverspent) {
    return isActive ? "#ff8aa0" : OVERSPENT_COLOR;
  }
  return isActive ? "#66e8ff" : ON_BUDGET_COLOR;
}

export function BudgetOrbitChart({ transactions, budgetRows, year, currentMonth }) {
  const [activeMonth, setActiveMonth] = useState(currentMonth);
  const [flashToken, setFlashToken] = useState(0);

  useEffect(() => {
    setActiveMonth(currentMonth);
  }, [currentMonth]);

  const monthStatuses = useMemo(
    () =>
      budgetMonths.map((month) => {
        const snapshot = buildMonthlySpendSnapshot(transactions, budgetRows, { month, year });
        return {
          month,
          isOverspent: snapshot.remaining < 0,
          budget: snapshot.monthlyBudget,
          spent: snapshot.monthlySpend,
          remaining: snapshot.remaining,
        };
      }),
    [transactions, budgetRows, year]
  );

  const activeMonthData =
    monthStatuses.find((entry) => entry.month === activeMonth) || monthStatuses[0];
  const activeBudget = activeMonthData?.budget || 0;
  const activeSpent = activeMonthData?.spent || 0;
  const activeRemaining = activeMonthData?.remaining || 0;
  const activeUsedPercent =
    activeBudget > 0 ? Math.round((activeSpent / activeBudget) * 100) : 0;
  const activeIsOverspent = activeRemaining < 0;

  const focusMonth = (month) => {
    setActiveMonth(month);
    setFlashToken((token) => token + 1);
  };

  const resetMonth = () => {
    if (activeMonth === currentMonth) return;
    setActiveMonth(currentMonth);
    setFlashToken((token) => token + 1);
  };

  const metricCards = [
    ["Budget", money(activeBudget), "#8feaff"],
    ["Spent", money(activeSpent), "#ffb65d"],
    [
      activeRemaining >= 0 ? "Remaining" : "Over Budget",
      `${activeRemaining >= 0 ? "" : "-"}${money(Math.abs(activeRemaining))}`,
      activeRemaining >= 0 ? "#00f59b" : "#ff5d7a",
    ],
  ];

  return (
    <div style={{ width: "100%" }} className="budget-orbit-chart" onMouseLeave={resetMonth}>
      <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
        <div className="budget-orbit-stage">
          <div
            className="budget-orbit-halo"
            style={{
              boxShadow: activeIsOverspent
                ? "0 0 35px rgba(255,93,122,.38), 0 0 70px rgba(255,93,122,.12)"
                : "0 0 35px rgba(0,174,255,.45), 0 0 70px rgba(0,174,255,.14)",
            }}
          />

          <svg
            className="budget-orbit-svg"
            viewBox={`0 0 ${VIEW_SIZE} ${VIEW_SIZE}`}
            aria-hidden="true"
          >
            <defs>
              <filter id="budget-orbit-glow" x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="3.2" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            <circle
              cx={CHART_CENTER}
              cy={CHART_CENTER}
              r={(OUTER_RADIUS + INNER_RADIUS) / 2}
              fill="none"
              stroke="rgba(120,180,255,.12)"
              strokeWidth={OUTER_RADIUS - INNER_RADIUS}
            />

            {monthStatuses.map((entry, index) => {
              const { start, end } = getMonthSegmentAngles(index);
              const color = getSegmentColor(entry, activeMonth);
              const isActive = entry.month === activeMonth;

              return (
                <path
                  key={entry.month}
                  d={describeDonutSegment(
                    CHART_CENTER,
                    CHART_CENTER,
                    OUTER_RADIUS,
                    INNER_RADIUS,
                    start,
                    end
                  )}
                  fill={color}
                  stroke={isActive ? "rgba(255,255,255,.55)" : "rgba(3,16,31,.65)"}
                  strokeWidth={isActive ? 1.4 : 0.8}
                  filter="url(#budget-orbit-glow)"
                  style={{
                    cursor: "pointer",
                    opacity: isActive ? 1 : 0.92,
                    transition: "opacity .2s ease, fill .2s ease",
                  }}
                  onMouseEnter={() => focusMonth(entry.month)}
                  onFocus={() => focusMonth(entry.month)}
                  onClick={() => focusMonth(entry.month)}
                />
              );
            })}
          </svg>

          <div
            className="budget-orbit-core"
            style={{
              border: activeIsOverspent
                ? "1px solid rgba(255,93,122,.28)"
                : "1px solid rgba(0,216,255,.24)",
            }}
          >
            <div
              style={{
                color: activeIsOverspent ? "#ffb3c1" : "#8feaff",
                fontSize: 11,
                fontWeight: 900,
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
            >
              Budget Used
            </div>
            <div style={{ color: "white", fontSize: 26, fontWeight: 900, lineHeight: 1, marginTop: 8 }}>
              {activeUsedPercent}%
            </div>
            <div
              style={{
                color: activeIsOverspent ? "#ffd9df" : "#dff7ff",
                fontSize: 18,
                fontWeight: 900,
                lineHeight: 1.1,
                marginTop: 8,
              }}
            >
              {wholeDollars(activeSpent)}
            </div>
            <div style={{ color: "#7fa1ca", fontSize: 11, lineHeight: 1.4, marginTop: 6 }}>
              {budgetMonthNames[activeMonth]?.slice(0, 3)} {year}
              {activeIsOverspent ? " · over budget" : " · of " + wholeDollars(activeBudget)}
            </div>
          </div>

          {monthStatuses.map((entry, index) => {
            const angle = (getMonthLabelAngle(index) * Math.PI) / 180;
            const labelX = 50 + (LABEL_RADIUS / (VIEW_SIZE / 2)) * 50 * Math.cos(angle);
            const labelY = 50 + (LABEL_RADIUS / (VIEW_SIZE / 2)) * 50 * Math.sin(angle);
            const isActive = entry.month === activeMonth;

            return (
              <button
                key={`${entry.month}-label`}
                type="button"
                aria-label={`${budgetMonthNames[entry.month]} ${year}`}
                onMouseEnter={() => focusMonth(entry.month)}
                onFocus={() => focusMonth(entry.month)}
                onClick={() => focusMonth(entry.month)}
                className="budget-orbit-month-label"
                style={{
                  left: `${labelX}%`,
                  top: `${labelY}%`,
                  color: isActive ? "#ffffff" : "#7fa1ca",
                  border: isActive ? "1px solid rgba(0,216,255,.45)" : "1px solid transparent",
                  background: isActive ? "rgba(0,136,255,.16)" : "transparent",
                  textShadow: isActive ? "0 0 10px rgba(0,216,255,.55)" : "none",
                }}
              >
                {entry.month.toUpperCase()}
              </button>
            );
          })}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 28,
          width: "100%",
          marginTop: 18,
        }}
      >
        {[
          ["On Budget", ON_BUDGET_COLOR],
          ["Overspent", OVERSPENT_COLOR],
        ].map(([label, color]) => (
          <div
            key={label}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              color: "#9fb6d6",
              fontSize: 11,
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                borderRadius: 99,
                background: color,
                boxShadow: `0 0 10px ${color}`,
              }}
            />
            {label}
          </div>
        ))}
      </div>

      <div
        className="responsive-grid-3"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 14,
          marginTop: 16,
        }}
      >
        {metricCards.map(([label, value, color]) => (
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
              key={`${label}-${flashToken}`}
              className="budget-orbit-metric-flash budget-orbit-metric-value"
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
  );
}
