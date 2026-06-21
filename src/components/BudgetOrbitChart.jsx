import { useEffect, useMemo, useState } from "react";
import { budgetMonthNames, budgetMonths } from "../data/constants.jsx";
import { buildMonthlySpendSnapshot } from "../utils/budgetReview.js";
import { money, wholeDollars } from "../utils/format.js";

const ON_BUDGET_COLOR = "#00d8ff";
const OVERSPENT_COLOR = "#ff5d7a";
const ORBIT_SIZE = 220;
const ORBIT_CENTER = ORBIT_SIZE / 2;
const LABEL_RADIUS = 122;
const DOT_RADIUS = 100;

function buildOrbitGradient(monthStatuses, activeMonth) {
  const segmentPercent = 100 / monthStatuses.length;
  let current = 0;

  return `conic-gradient(${monthStatuses
    .map((entry) => {
      const start = current;
      current += segmentPercent;
      let color = entry.isOverspent ? OVERSPENT_COLOR : ON_BUDGET_COLOR;
      if (entry.month === activeMonth) {
        color = entry.isOverspent ? "#ff8aa0" : "#66e8ff";
      }
      return `${color} ${start.toFixed(2)}% ${current.toFixed(2)}%`;
    })
    .join(", ")})`;
}

function getOrbitAngle(index) {
  return ((index * 30 + 15 - 90) * Math.PI) / 180;
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
  const orbitGradient = buildOrbitGradient(monthStatuses, activeMonth);

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
    <div style={{ width: "100%" }} className="budget-orbit-chart">
      <div
        style={{
          width: "100%",
          border: "1px solid rgba(0,136,255,.18)",
          borderRadius: 18,
          background: "rgba(3,17,32,.58)",
          padding: "16px 18px 14px",
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
              width: ORBIT_SIZE,
              height: ORBIT_SIZE,
            }}
          >
            <div
              style={{
                width: ORBIT_SIZE,
                height: ORBIT_SIZE,
                borderRadius: "50%",
                background: orbitGradient,
                boxShadow: "0 0 34px rgba(0,216,255,.18), inset 0 0 42px rgba(0,216,255,.08)",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  inset: 34,
                  borderRadius: "50%",
                  background:
                    "radial-gradient(circle at 30% 25%, rgba(255,255,255,.08), rgba(3,16,31,.98) 62%)",
                  border: "1px solid rgba(0,216,255,.24)",
                }}
              />
            </div>

            {monthStatuses.map((entry, index) => {
              const angle = getOrbitAngle(index);
              const dotX = ORBIT_CENTER + DOT_RADIUS * Math.cos(angle);
              const dotY = ORBIT_CENTER + DOT_RADIUS * Math.sin(angle);
              const labelX = ORBIT_CENTER + LABEL_RADIUS * Math.cos(angle);
              const labelY = ORBIT_CENTER + LABEL_RADIUS * Math.sin(angle);
              const dotColor = entry.isOverspent ? OVERSPENT_COLOR : ON_BUDGET_COLOR;
              const isActive = entry.month === activeMonth;

              return (
                <div key={entry.month}>
                  <button
                    type="button"
                    aria-label={`${budgetMonthNames[entry.month]} ${year}`}
                    onMouseEnter={() => focusMonth(entry.month)}
                    onFocus={() => focusMonth(entry.month)}
                    onClick={() => focusMonth(entry.month)}
                    style={{
                      position: "absolute",
                      left: dotX,
                      top: dotY,
                      width: 18,
                      height: 18,
                      borderRadius: "50%",
                      transform: "translate(-50%, -50%)",
                      background: dotColor,
                      boxShadow: isActive
                        ? `0 0 16px ${dotColor}, 0 0 28px ${dotColor}`
                        : `0 0 10px ${dotColor}`,
                      border: isActive ? "2px solid #ffffff" : "none",
                      cursor: "pointer",
                      padding: 0,
                    }}
                  />
                  <button
                    type="button"
                    onMouseEnter={() => focusMonth(entry.month)}
                    onFocus={() => focusMonth(entry.month)}
                    onClick={() => focusMonth(entry.month)}
                    style={{
                      position: "absolute",
                      left: labelX,
                      top: labelY,
                      transform: "translate(-50%, -50%)",
                      color: isActive ? "#ffffff" : "#7fa1ca",
                      fontSize: 10,
                      fontWeight: 900,
                      letterSpacing: 0.7,
                      cursor: "pointer",
                      padding: "4px 6px",
                      borderRadius: 6,
                      border: isActive ? "1px solid rgba(0,216,255,.45)" : "1px solid transparent",
                      background: isActive ? "rgba(0,136,255,.16)" : "transparent",
                    }}
                  >
                    {entry.month.toUpperCase()}
                  </button>
                </div>
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
              <div style={{ color: "#8feaff", fontSize: 10, fontWeight: 800, letterSpacing: 0.6 }}>
                {budgetMonthNames[activeMonth]?.slice(0, 3).toUpperCase()} {year}
              </div>
              <div
                style={{ color: "white", fontSize: 28, fontWeight: 900, lineHeight: 1, marginTop: 6 }}
              >
                {activeUsedPercent}%
              </div>
              <div
                style={{
                  color: "#8feaff",
                  fontSize: 9,
                  fontWeight: 900,
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                  marginTop: 6,
                }}
              >
                Of Budget Used
              </div>
              <div style={{ color: "#9fb6d6", fontSize: 11, fontWeight: 700, marginTop: 8 }}>
                {wholeDollars(activeSpent)} / {wholeDollars(activeBudget)}
              </div>
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 28,
            width: "100%",
            marginTop: 14,
            paddingTop: 12,
            borderTop: "1px solid rgba(30,144,255,.12)",
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
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: color,
                  boxShadow: `0 0 8px ${color}`,
                }}
              />
              {label}
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
