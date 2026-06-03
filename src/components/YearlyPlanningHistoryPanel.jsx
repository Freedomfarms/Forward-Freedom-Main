import { useMemo, useState } from "react";
import { styles } from "../styles.js";
import { budgetMonths } from "../data/constants.jsx";
import { buildLinePath, money, wholeDollars } from "../utils/format.js";
import { buildYearlyPlanningMetrics } from "../utils/yearlyPlanningMetrics.js";

const CHART_W = 940;
const CHART_H = 220;
const MONTH_X = Object.fromEntries(
  budgetMonths.map((month, index) => [
    month,
    24 + index * ((CHART_W - 48) / (budgetMonths.length - 1)),
  ])
);

function finiteMoney(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function buildRange(values) {
  const highest = Math.max(...values, 1);
  const paddedMaximum = highest < 1000 ? 1000 : Math.ceil((highest * 1.14) / 500) * 500;
  return { max: paddedMaximum, min: 0 };
}

function toY(value, max, min) {
  const range = Math.max(max - min, 1);
  return Math.max(0, Math.min(CHART_H, CHART_H - ((value - min) / range) * CHART_H));
}

export function YearlyPlanningHistoryPanel({
  title = "Year History",
  subtitle = "Planned vs actual income and budget execution by month.",
  transactions = [],
  budgetRows = [],
  incomeStreams = [],
  yearlyOpsSeed = [],
  year,
  historyEndMonth = "Jun",
  onSelectMonth,
}) {
  const [hoveredMonth, setHoveredMonth] = useState(null);
  const metrics = useMemo(
    () =>
      buildYearlyPlanningMetrics({
        transactions,
        budgetRows,
        incomeStreams,
        yearlyOpsSeed,
        year,
      }),
    [transactions, budgetRows, incomeStreams, yearlyOpsSeed, year]
  );

  const historyEndIndex = Math.max(0, budgetMonths.indexOf(historyEndMonth));
  const chartValues = metrics.flatMap((month) => [
    finiteMoney(month.plannedIncome),
    finiteMoney(month.actualIncome),
    finiteMoney(month.budget),
    finiteMoney(month.spent),
  ]);
  const { max, min } = buildRange(chartValues);
  const yLabels = Array.from({ length: 5 }, (_, index) => {
    const value = max - ((max - min) / 4) * index;
    return wholeDollars(value);
  });

  const pointSeries = (key) =>
    metrics.map((entry) => [MONTH_X[entry.month], toY(finiteMoney(entry[key]), max, min)]);

  const plannedPath = buildLinePath(pointSeries("plannedIncome"));
  const actualPath = buildLinePath(pointSeries("actualIncome"));
  const budgetPath = buildLinePath(pointSeries("budget"));
  const spentPath = buildLinePath(pointSeries("spent"));
  const focus = hoveredMonth ? metrics.find((entry) => entry.month === hoveredMonth) : null;

  return (
    <section style={{ ...styles.panel, padding: 22, marginBottom: 24 }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ color: "white", fontSize: 22, fontWeight: 900 }}>{title}</div>
        <div style={{ color: "#9fb0c9", marginTop: 6, lineHeight: 1.5 }}>{subtitle}</div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          marginBottom: 14,
          color: "#9fb0c9",
          fontSize: 13,
        }}
      >
        {[
          ["Planned Income", "rgba(0,245,155,.9)", "dashed"],
          ["Earned Income", "rgba(0,245,155,.9)", "solid"],
          ["Budget", "rgba(0,216,255,.95)", "dashed"],
          ["Spent", "rgba(0,216,255,.95)", "solid"],
        ].map(([label, color, lineType]) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              style={{
                width: 22,
                borderTop: `2px ${lineType === "dashed" ? "dashed" : "solid"} ${color}`,
              }}
            />
            {label}
          </div>
        ))}
      </div>

      <div style={{ position: "relative", height: CHART_H + 48 }}>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 28,
            display: "grid",
            alignContent: "space-between",
            color: "#6f8eb8",
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {yLabels.map((label) => (
            <div key={label}>{label}</div>
          ))}
        </div>
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          style={{ width: "100%", height: CHART_H, marginLeft: 48 }}
          role="img"
          aria-label={`${title} chart`}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
            <line
              key={ratio}
              x1={0}
              x2={CHART_W}
              y1={CHART_H * ratio}
              y2={CHART_H * ratio}
              stroke="rgba(0,136,255,.12)"
              strokeWidth={1}
            />
          ))}
          {metrics.map((entry, index) => {
            const x = MONTH_X[entry.month];
            const isHistory = index <= historyEndIndex;
            return (
              <line
                key={`grid-${entry.month}`}
                x1={x}
                x2={x}
                y1={0}
                y2={CHART_H}
                stroke={isHistory ? "rgba(0,216,255,.16)" : "rgba(0,136,255,.06)"}
                strokeWidth={1}
              />
            );
          })}
          <path d={budgetPath} fill="none" stroke="rgba(0,216,255,.55)" strokeWidth={2} strokeDasharray="7 6" />
          <path d={spentPath} fill="none" stroke="rgba(0,216,255,.95)" strokeWidth={2.5} />
          <path
            d={plannedPath}
            fill="none"
            stroke="rgba(0,245,155,.55)"
            strokeWidth={2}
            strokeDasharray="7 6"
          />
          <path d={actualPath} fill="none" stroke="rgba(0,245,155,.95)" strokeWidth={2.5} />
          {metrics.map((entry) => {
            const x = MONTH_X[entry.month];
            const isHistory = budgetMonths.indexOf(entry.month) <= historyEndIndex;
            return (
              <g key={entry.month}>
                <rect
                  x={x - 18}
                  y={0}
                  width={36}
                  height={CHART_H}
                  fill="transparent"
                  onMouseEnter={() => setHoveredMonth(entry.month)}
                  onMouseLeave={() => setHoveredMonth(null)}
                  onClick={() => {
                    if (typeof onSelectMonth === "function") onSelectMonth(entry.month);
                  }}
                  style={{ cursor: onSelectMonth ? "pointer" : "default" }}
                />
                <circle
                  cx={x}
                  cy={toY(finiteMoney(entry.actualIncome), max, min)}
                  r={5}
                  fill={isHistory ? "#00f59b" : "rgba(0,245,155,.35)"}
                />
                <circle
                  cx={x}
                  cy={toY(finiteMoney(entry.spent), max, min)}
                  r={5}
                  fill={isHistory ? "#00d8ff" : "rgba(0,216,255,.35)"}
                />
              </g>
            );
          })}
        </svg>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${budgetMonths.length}, 1fr)`,
            marginLeft: 48,
            marginTop: 8,
            color: "#8ea8ca",
            fontSize: 12,
            fontWeight: 800,
          }}
        >
          {metrics.map((entry) => {
            const isHistory = budgetMonths.indexOf(entry.month) <= historyEndIndex;
            return (
              <div
                key={`label-${entry.month}`}
                style={{
                  textAlign: "center",
                  color: isHistory ? "#dff7ff" : "#6f8eb8",
                }}
              >
                {entry.month}
              </div>
            );
          })}
        </div>
      </div>

      {focus ? (
        <div
          style={{
            marginTop: 14,
            border: "1px solid rgba(0,216,255,.22)",
            borderRadius: 12,
            background: "rgba(0,136,255,.08)",
            padding: "12px 14px",
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: 12,
            color: "#eaf3ff",
            fontSize: 13,
          }}
        >
          <div>
            <div style={{ color: "#8feaff", fontSize: 11, fontWeight: 800 }}>PLANNED</div>
            <div style={{ fontWeight: 900 }}>{money(focus.plannedIncome)}</div>
          </div>
          <div>
            <div style={{ color: "#8feaff", fontSize: 11, fontWeight: 800 }}>EARNED</div>
            <div style={{ fontWeight: 900 }}>{money(focus.actualIncome)}</div>
          </div>
          <div>
            <div style={{ color: "#8feaff", fontSize: 11, fontWeight: 800 }}>BUDGET</div>
            <div style={{ fontWeight: 900 }}>{money(focus.budget)}</div>
          </div>
          <div>
            <div style={{ color: "#8feaff", fontSize: 11, fontWeight: 800 }}>SPENT</div>
            <div style={{ fontWeight: 900 }}>{money(focus.spent)}</div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
