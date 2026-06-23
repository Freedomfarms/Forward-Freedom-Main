import { useEffect, useMemo, useState } from "react";
import { budgetMonthNames, budgetMonths } from "../data/constants.jsx";
import { buildMonthlySpendSnapshot } from "../utils/budgetReview.js";
import { money, wholeDollars } from "../utils/format.js";

const SIZE = 240;
const CENTER = SIZE / 2;
const ARC_RADIUS = 96;
const ARC_STROKE = 16;
const TRACK_INNER_RADIUS = 70;
const LABEL_RADIUS = 118;
const SEGMENT_GAP_DEG = 7;
const TICK_INNER = ARC_RADIUS + ARC_STROKE / 2 + 2;
const TICK_OUTER = ARC_RADIUS + ARC_STROKE / 2 + 7;

const STATUS = {
  met: { key: "met", label: "Budget Met", color: "#00f59b" },
  over: { key: "over", label: "Over Budget", color: "#ff4d7a" },
  future: { key: "future", label: "Upcoming", color: "#3a5474" },
};

const STATUS_LEGEND = [STATUS.met, STATUS.over, STATUS.future];

function polar(deg, radius) {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: CENTER + radius * Math.cos(a), y: CENTER + radius * Math.sin(a) };
}

function describeArc(startDeg, endDeg, radius) {
  const start = polar(startDeg, radius);
  const end = polar(endDeg, radius);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

export function BudgetOrbitChart({ transactions, budgetRows, year, currentMonth }) {
  const [activeMonth, setActiveMonth] = useState(currentMonth);
  const [flashToken, setFlashToken] = useState(0);

  useEffect(() => {
    setActiveMonth(currentMonth);
  }, [currentMonth]);

  const monthStatuses = useMemo(() => {
    const today = new Date();
    const todayYear = today.getFullYear();
    const todayMonth = today.getMonth();
    return budgetMonths.map((month, index) => {
      const snapshot = buildMonthlySpendSnapshot(transactions, budgetRows, { month, year });
      const percentUsed =
        snapshot.monthlyBudget > 0
          ? (snapshot.monthlySpend / snapshot.monthlyBudget) * 100
          : 0;
      const isFuture =
        year > todayYear || (year === todayYear && index > todayMonth);
      const status = isFuture
        ? STATUS.future
        : snapshot.remaining < 0
        ? STATUS.over
        : STATUS.met;
      return {
        month,
        index,
        isFuture,
        isOverspent: snapshot.remaining < 0,
        budget: snapshot.monthlyBudget,
        spent: snapshot.monthlySpend,
        remaining: snapshot.remaining,
        percentUsed,
        status,
      };
    });
  }, [transactions, budgetRows, year]);

  const activeIndex = Math.max(
    0,
    monthStatuses.findIndex((entry) => entry.month === activeMonth)
  );
  const activeMonthData = monthStatuses[activeIndex] || monthStatuses[0];
  const activeBudget = activeMonthData?.budget || 0;
  const activeSpent = activeMonthData?.spent || 0;
  const activeRemaining = activeMonthData?.remaining || 0;
  const activeUsedPercent =
    activeBudget > 0 ? Math.round((activeSpent / activeBudget) * 100) : 0;
  const activeStatus = activeMonthData?.status || STATUS.met;
  const activeIsFuture = activeMonthData?.isFuture;

  const focusMonth = (month) => {
    setActiveMonth(month);
    setFlashToken((token) => token + 1);
  };

  const resetMonth = () => {
    if (activeMonth === currentMonth) return;
    setActiveMonth(currentMonth);
    setFlashToken((token) => token + 1);
  };

  const remainingLabel = activeIsFuture
    ? "Upcoming"
    : activeRemaining >= 0
    ? "Remaining"
    : "Over Budget";
  const remainingColor = activeIsFuture
    ? STATUS.future.color
    : activeRemaining >= 0
    ? STATUS.met.color
    : STATUS.over.color;

  const metricCards = [
    ["Budget", money(activeBudget), "#8feaff"],
    ["Spent", money(activeSpent), "#ffb65d"],
    [
      remainingLabel,
      `${activeRemaining >= 0 ? "" : "-"}${money(Math.abs(activeRemaining))}`,
      remainingColor,
    ],
  ];

  return (
    <div style={{ width: "100%" }} className="budget-orbit-chart">
      <div onMouseLeave={resetMonth}>
        <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
          <div
            style={{
              position: "relative",
              width: SIZE,
              height: SIZE,
            }}
          >
            <svg
              width={SIZE}
              height={SIZE}
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              style={{ position: "absolute", inset: 0, overflow: "visible" }}
            >
              <defs>
                <radialGradient id="orbit-core" cx="35%" cy="30%" r="75%">
                  <stop offset="0%" stopColor="rgba(0,216,255,.10)" />
                  <stop offset="55%" stopColor="rgba(3,16,31,.92)" />
                  <stop offset="100%" stopColor="rgba(3,16,31,1)" />
                </radialGradient>
              </defs>

              <circle
                cx={CENTER}
                cy={CENTER}
                r={ARC_RADIUS}
                fill="none"
                stroke="rgba(0,136,255,.08)"
                strokeWidth={ARC_STROKE + 4}
              />

              {Array.from({ length: 12 }).map((_, i) => {
                const angle = i * 30;
                const inner = polar(angle, TICK_INNER);
                const outer = polar(angle, TICK_OUTER);
                return (
                  <line
                    key={`tick-${i}`}
                    x1={inner.x}
                    y1={inner.y}
                    x2={outer.x}
                    y2={outer.y}
                    stroke="rgba(120,160,210,.35)"
                    strokeWidth={1}
                  />
                );
              })}

              {monthStatuses.map((entry, index) => {
                const startDeg = index * 30 + SEGMENT_GAP_DEG / 2;
                const endDeg = (index + 1) * 30 - SEGMENT_GAP_DEG / 2;
                const isActive = entry.month === activeMonth;
                const d = describeArc(startDeg, endDeg, ARC_RADIUS);
                return (
                  <g
                    key={entry.month}
                    onMouseEnter={() => focusMonth(entry.month)}
                    onClick={() => focusMonth(entry.month)}
                    style={{ cursor: "pointer" }}
                  >
                    <path
                      d={d}
                      stroke="transparent"
                      strokeWidth={ARC_STROKE + 14}
                      strokeLinecap="butt"
                      fill="none"
                      pointerEvents="stroke"
                    />
                    <path
                      d={d}
                      stroke={entry.status.color}
                      strokeWidth={isActive ? ARC_STROKE + 4 : ARC_STROKE}
                      strokeLinecap="butt"
                      fill="none"
                      opacity={entry.isFuture ? 0.55 : 1}
                      pointerEvents="none"
                      style={{ transition: "stroke-width 160ms ease" }}
                    />
                    {isActive ? (
                      <path
                        d={d}
                        stroke="rgba(255,255,255,.85)"
                        strokeWidth={1.5}
                        strokeLinecap="butt"
                        fill="none"
                        pointerEvents="none"
                      />
                    ) : null}
                  </g>
                );
              })}

              <circle
                cx={CENTER}
                cy={CENTER}
                r={TRACK_INNER_RADIUS}
                fill="url(#orbit-core)"
                stroke="rgba(120,160,210,.30)"
                strokeWidth={1}
              />
            </svg>

            {monthStatuses.map((entry, index) => {
              const angle = index * 30 + 15;
              const labelPos = polar(angle, LABEL_RADIUS);
              const isActive = entry.month === activeMonth;
              return (
                <button
                  key={entry.month}
                  type="button"
                  onMouseEnter={() => focusMonth(entry.month)}
                  onFocus={() => focusMonth(entry.month)}
                  onClick={() => focusMonth(entry.month)}
                  aria-label={`${budgetMonthNames[entry.month]} ${year}`}
                  style={{
                    position: "absolute",
                    left: labelPos.x,
                    top: labelPos.y,
                    transform: "translate(-50%, -50%)",
                    color: isActive
                      ? "#ffffff"
                      : entry.isFuture
                      ? "#5e7997"
                      : "#9fb6d6",
                    fontSize: 10,
                    fontWeight: 900,
                    letterSpacing: 0.9,
                    cursor: "pointer",
                    padding: "4px 7px",
                    borderRadius: 7,
                    border: isActive
                      ? `1px solid ${entry.status.color}`
                      : "1px solid transparent",
                    background: isActive ? `${entry.status.color}1f` : "transparent",
                    transition: "all 140ms ease",
                  }}
                >
                  {entry.month.toUpperCase()}
                </button>
              );
            })}

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
                padding: "0 28px",
              }}
            >
              <div
                style={{
                  color: activeStatus.color,
                  fontSize: 10,
                  fontWeight: 900,
                  letterSpacing: 1.2,
                }}
              >
                {budgetMonthNames[activeMonth]?.slice(0, 3).toUpperCase()} {year}
              </div>
              <div
                key={`pct-${flashToken}`}
                className="budget-orbit-metric-flash"
                style={{
                  color: "#ffffff",
                  fontSize: 32,
                  fontWeight: 900,
                  lineHeight: 1,
                  marginTop: 6,
                }}
              >
                {activeUsedPercent}%
              </div>
              <div
                style={{
                  color: "#8feaff",
                  fontSize: 9,
                  fontWeight: 900,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                  marginTop: 6,
                }}
              >
                Of Budget Used
              </div>
              <div style={{ color: "#9fb6d6", fontSize: 11, fontWeight: 700, marginTop: 6 }}>
                {wholeDollars(activeSpent)} / {wholeDollars(activeBudget)}
              </div>
              <div
                style={{
                  marginTop: 8,
                  fontSize: 9,
                  fontWeight: 900,
                  letterSpacing: 0.8,
                  textTransform: "uppercase",
                  color: activeStatus.color,
                  border: `1px solid ${activeStatus.color}66`,
                  background: `${activeStatus.color}14`,
                  borderRadius: 999,
                  padding: "3px 9px",
                }}
              >
                {activeStatus.label}
              </div>
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "center",
            flexWrap: "wrap",
            gap: 22,
            width: "100%",
            marginTop: 14,
            paddingTop: 12,
            borderTop: "1px solid rgba(30,144,255,.12)",
          }}
        >
          {STATUS_LEGEND.map((level) => (
            <div
              key={level.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: "#9fb6d6",
                fontSize: 11,
              }}
            >
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: "50%",
                  background: level.color,
                }}
              />
              <span style={{ fontWeight: 800, color: "#cfe2ff" }}>{level.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div
        className="responsive-grid-3"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 14,
          marginTop: 14,
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
