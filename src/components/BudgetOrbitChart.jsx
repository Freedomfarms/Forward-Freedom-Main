import { budgetMonths } from "../data/constants.jsx";
import { buildMonthlySpendSnapshot } from "../utils/budgetReview.js";
import { money, wholeDollars } from "../utils/format.js";

const ON_BUDGET_COLOR = "#00d8ff";
const OVERSPENT_COLOR = "#ff5d7a";
const ORBIT_SIZE = 188;
const ORBIT_CENTER = ORBIT_SIZE / 2;
const LABEL_RADIUS = 104;
const DOT_RADIUS = 86;

function buildOrbitGradient(monthStatuses) {
  const segmentPercent = 100 / monthStatuses.length;
  let current = 0;

  return `conic-gradient(${monthStatuses
    .map((entry) => {
      const start = current;
      current += segmentPercent;
      const color = entry.isOverspent ? OVERSPENT_COLOR : ON_BUDGET_COLOR;
      return `${color} ${start.toFixed(2)}% ${current.toFixed(2)}%`;
    })
    .join(", ")})`;
}

function getOrbitAngle(index) {
  return ((index * 30 + 15 - 90) * Math.PI) / 180;
}

export function BudgetOrbitChart({ transactions, budgetRows, year, currentMonth }) {
  const monthStatuses = budgetMonths.map((month) => {
    const snapshot = buildMonthlySpendSnapshot(transactions, budgetRows, { month, year });
    return {
      month,
      isOverspent: snapshot.remaining < 0,
      budget: snapshot.monthlyBudget,
      spent: snapshot.monthlySpend,
    };
  });

  const totalBudget = monthStatuses.reduce((sum, entry) => sum + entry.budget, 0);
  const totalSpent = monthStatuses.reduce((sum, entry) => sum + entry.spent, 0);
  const totalRemaining = totalBudget - totalSpent;
  const budgetUsedPercent =
    totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;
  const orbitGradient = buildOrbitGradient(monthStatuses);

  return (
    <div
      style={{
        minWidth: 0,
        width: "min(100%, 360px)",
        border: "1px solid rgba(0,136,255,.18)",
        borderRadius: 18,
        background: "rgba(3,17,32,.58)",
        padding: "14px 16px 12px",
      }}
    >
      <div style={{ marginBottom: 12 }}>
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

      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div
          style={{
            position: "relative",
            width: ORBIT_SIZE,
            height: ORBIT_SIZE,
            flexShrink: 0,
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
                inset: 30,
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
            const isCurrent = entry.month === currentMonth;

            return (
              <div key={entry.month}>
                <div
                  style={{
                    position: "absolute",
                    left: dotX,
                    top: dotY,
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    transform: "translate(-50%, -50%)",
                    background: dotColor,
                    boxShadow: `0 0 10px ${dotColor}`,
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: labelX,
                    top: labelY,
                    transform: "translate(-50%, -50%)",
                    color: isCurrent ? "#ffffff" : "#7fa1ca",
                    fontSize: 9,
                    fontWeight: 900,
                    letterSpacing: 0.6,
                  }}
                >
                  {entry.month.toUpperCase()}
                </div>
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
              padding: "0 24px",
            }}
          >
            <div style={{ color: "white", fontSize: 24, fontWeight: 900, lineHeight: 1 }}>
              {budgetUsedPercent}%
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
              {wholeDollars(totalSpent)} / {wholeDollars(totalBudget)}
            </div>
          </div>
        </div>

        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "grid",
            gap: 10,
            borderLeft: "1px solid rgba(30,144,255,.16)",
            paddingLeft: 14,
          }}
        >
          {[
            ["Budget", money(totalBudget), "#8feaff"],
            ["Spent", money(totalSpent), "#ffb65d"],
            [
              totalRemaining >= 0 ? "Remaining" : "Over Budget",
              `${totalRemaining >= 0 ? "" : "-"}${money(Math.abs(totalRemaining))}`,
              totalRemaining >= 0 ? "#00f59b" : "#ff5d7a",
            ],
          ].map(([label, value, color]) => (
            <div key={label}>
              <div
                style={{
                  color: "#8fb1d9",
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                  marginBottom: 4,
                }}
              >
                {label}
              </div>
              <div style={{ color, fontSize: 16, fontWeight: 900, lineHeight: 1.2 }}>{value}</div>
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 16,
          marginTop: 12,
          paddingTop: 10,
          borderTop: "1px solid rgba(30,144,255,.12)",
        }}
      >
        {[
          ["On Budget", ON_BUDGET_COLOR],
          ["Overspent", OVERSPENT_COLOR],
        ].map(([label, color]) => (
          <div
            key={label}
            style={{ display: "flex", alignItems: "center", gap: 7, color: "#9fb6d6", fontSize: 11 }}
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
  );
}
