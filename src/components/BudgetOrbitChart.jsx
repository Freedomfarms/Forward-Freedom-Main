import { useEffect, useMemo, useState } from "react";
import { budgetMonthNames, budgetMonths } from "../data/constants.jsx";
import { buildMonthlySpendSnapshot } from "../utils/budgetReview.js";
import { money, wholeDollars } from "../utils/format.js";

const SIZE = 240;
const CENTER = SIZE / 2;
const ARC_RADIUS = 96;
const ARC_STROKE = 14;
const TRACK_INNER_RADIUS = 72;
const LABEL_RADIUS = 118;
const SEGMENT_GAP_DEG = 2.6;

const STATUS_LEVELS = [
  { key: "on", label: "On Track", range: "0–50%", color: "#22e7a6" },
  { key: "moderate", label: "Caution", range: "50–80%", color: "#ffd23f" },
  { key: "high", label: "High Risk", range: "80–100%", color: "#ff8c42" },
  { key: "over", label: "Over Budget", range: ">100%", color: "#ff4d6d" },
];

function getStatus(percentUsed, isOverspent) {
  if (isOverspent || percentUsed > 100) return STATUS_LEVELS[3];
  if (percentUsed >= 80) return STATUS_LEVELS[2];
  if (percentUsed >= 50) return STATUS_LEVELS[1];
  return STATUS_LEVELS[0];
}

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

  const monthStatuses = useMemo(
    () =>
      budgetMonths.map((month) => {
        const snapshot = buildMonthlySpendSnapshot(transactions, budgetRows, { month, year });
        const percentUsed =
          snapshot.monthlyBudget > 0
            ? (snapshot.monthlySpend / snapshot.monthlyBudget) * 100
            : 0;
        return {
          month,
          isOverspent: snapshot.remaining < 0,
          budget: snapshot.monthlyBudget,
          spent: snapshot.monthlySpend,
          remaining: snapshot.remaining,
          percentUsed,
          status: getStatus(percentUsed, snapshot.remaining < 0),
        };
      }),
    [transactions, budgetRows, year]
  );

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
  const activeStatus = activeMonthData?.status || STATUS_LEVELS[0];

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

  const activeCenterAngle = activeIndex * 30 + 15;
  const pointer = polar(activeCenterAngle, ARC_RADIUS - ARC_STROKE / 2 - 9);
  const pointerOuter = polar(activeCenterAngle, ARC_RADIUS - ARC_STROKE / 2 - 1);

  return (
    <div style={{ width: "100%" }} className="budget-orbit-chart">
      <div
        style={{
          width: "100%",
          border: "1px solid rgba(0,136,255,.22)",
          borderRadius: 18,
          background:
            "radial-gradient(circle at 50% 0%, rgba(0,136,255,.10), rgba(3,17,32,.85) 60%)",
          padding: "16px 18px 14px",
          boxShadow: "inset 0 0 60px rgba(0,136,255,.05)",
        }}
        onMouseLeave={resetMonth}
      >
        <div style={{ marginBottom: 14 }}>
          <div
            style={{
              color: "#8feaff",
              fontSize: 11,
              fontWeight: 900,
              textTransform: "uppercase",
              letterSpacing: 1.2,
            }}
          >
            Budget Orbit
          </div>
          <div style={{ color: "#7fa1ca", fontSize: 12, marginTop: 4 }}>
            Progress around the budget circle
          </div>
        </div>

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
                  <stop offset="0%" stopColor="rgba(0,216,255,.18)" />
                  <stop offset="55%" stopColor="rgba(3,16,31,.92)" />
                  <stop offset="100%" stopColor="rgba(3,16,31,1)" />
                </radialGradient>
                <radialGradient id="orbit-ambient" cx="50%" cy="50%" r="50%">
                  <stop offset="60%" stopColor="rgba(0,216,255,0)" />
                  <stop offset="100%" stopColor="rgba(0,216,255,.10)" />
                </radialGradient>
                {STATUS_LEVELS.map((level) => (
                  <filter
                    key={level.key}
                    id={`glow-${level.key}`}
                    x="-50%"
                    y="-50%"
                    width="200%"
                    height="200%"
                  >
                    <feGaussianBlur stdDeviation="3.5" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                ))}
                <filter id="pointer-glow" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="2.4" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>

              <circle
                cx={CENTER}
                cy={CENTER}
                r={ARC_RADIUS + 14}
                fill="url(#orbit-ambient)"
              />

              <circle
                cx={CENTER}
                cy={CENTER}
                r={ARC_RADIUS}
                fill="none"
                stroke="rgba(0,136,255,.10)"
                strokeWidth={ARC_STROKE + 4}
              />

              <circle
                cx={CENTER}
                cy={CENTER}
                r={ARC_RADIUS}
                fill="none"
                stroke="rgba(0,136,255,.18)"
                strokeWidth={1}
                strokeDasharray="2 4"
              />

              {monthStatuses.map((entry, index) => {
                const startDeg = index * 30 + SEGMENT_GAP_DEG / 2;
                const endDeg = (index + 1) * 30 - SEGMENT_GAP_DEG / 2;
                const isActive = entry.month === activeMonth;
                const color = entry.status.color;
                return (
                  <path
                    key={entry.month}
                    d={describeArc(startDeg, endDeg, ARC_RADIUS)}
                    stroke={color}
                    strokeWidth={isActive ? ARC_STROKE + 2 : ARC_STROKE}
                    strokeLinecap="round"
                    fill="none"
                    opacity={isActive ? 1 : 0.78}
                    filter={isActive ? `url(#glow-${entry.status.key})` : undefined}
                    style={{ transition: "stroke-width 180ms ease, opacity 180ms ease" }}
                  />
                );
              })}

              <circle
                cx={CENTER}
                cy={CENTER}
                r={TRACK_INNER_RADIUS}
                fill="url(#orbit-core)"
                stroke="rgba(0,216,255,.28)"
                strokeWidth={1}
              />
              <circle
                cx={CENTER}
                cy={CENTER}
                r={TRACK_INNER_RADIUS - 6}
                fill="none"
                stroke="rgba(0,216,255,.10)"
                strokeWidth={1}
              />

              <line
                x1={pointer.x}
                y1={pointer.y}
                x2={pointerOuter.x}
                y2={pointerOuter.y}
                stroke="#ffffff"
                strokeWidth={2}
                strokeLinecap="round"
                filter="url(#pointer-glow)"
              />
              <circle
                cx={pointer.x}
                cy={pointer.y}
                r={3.5}
                fill="#ffffff"
                filter="url(#pointer-glow)"
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
                    color: isActive ? "#ffffff" : "#7fa1ca",
                    fontSize: 10,
                    fontWeight: 900,
                    letterSpacing: 0.9,
                    cursor: "pointer",
                    padding: "4px 7px",
                    borderRadius: 7,
                    border: isActive
                      ? `1px solid ${entry.status.color}aa`
                      : "1px solid transparent",
                    background: isActive
                      ? `${entry.status.color}26`
                      : "transparent",
                    boxShadow: isActive
                      ? `0 0 14px ${entry.status.color}55`
                      : "none",
                    textShadow: isActive ? `0 0 8px ${entry.status.color}` : "none",
                    transition: "all 160ms ease",
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
                  textShadow: `0 0 10px ${activeStatus.color}88`,
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
                  textShadow: `0 0 18px ${activeStatus.color}66`,
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
                  background: `${activeStatus.color}18`,
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
            gap: 14,
            width: "100%",
            marginTop: 14,
            paddingTop: 12,
            borderTop: "1px solid rgba(30,144,255,.12)",
          }}
        >
          {STATUS_LEVELS.map((level) => (
            <div
              key={level.key}
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
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: level.color,
                  boxShadow: `0 0 10px ${level.color}`,
                }}
              />
              <span style={{ fontWeight: 800, color: "#cfe2ff" }}>{level.label}</span>
              <span style={{ color: "#7fa1ca" }}>{level.range}</span>
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
