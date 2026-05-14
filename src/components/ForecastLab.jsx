import { useState } from "react";
import { budgetMonths } from "../data/constants.jsx";
import { styles } from "../styles.js";
import { getCurrentBudgetPeriod } from "../utils/date.js";
import { buildLinePath, buildAreaPath, money, parseMoney, wholeDollars } from "../utils/format.js";
import { buildSubscriptionOverview } from "../utils/subscriptions.js";
import { buildForwardTrueCashProjection } from "../utils/trueCashProjection.js";

const CHART_W = 940;
const CHART_H = 280;

const MONTH_X = {
  Jan: 0,
  Feb: 78,
  Mar: 157,
  Apr: 235,
  May: 314,
  Jun: 392,
  Jul: 470,
  Aug: 549,
  Sep: 627,
  Oct: 706,
  Nov: 784,
  Dec: 862,
};

function buildProjection(
  trueCash,
  incomeStreams,
  budgetRows,
  projectionAdjustments,
  extraIncome,
  savedSpending,
  startMonth,
  startYear
) {
  const modifiedStreams =
    extraIncome === 0
      ? incomeStreams
      : incomeStreams.map((s) => ({ ...s, amount: money(parseMoney(s.amount) + extraIncome) }));

  const modifiedRows =
    savedSpending === 0
      ? budgetRows
      : budgetRows.map((r) => ({
          ...r,
          budget: Math.max(0, Number(r.budget || 0) - savedSpending),
        }));

  return buildForwardTrueCashProjection({
    openingBalance: trueCash,
    incomeStreams: modifiedStreams,
    budgetRows: modifiedRows,
    projectionAdjustments,
    startMonth,
    startYear,
  });
}

function chartRange(baseline, scenario, openingBalance) {
  const all = [openingBalance, ...baseline.map((p) => p.value), ...scenario.map((p) => p.value)];
  const hi = Math.max(...all, 1);
  const lo = Math.min(...all, 0);
  const pad = (hi - lo) * 0.18;
  return {
    max: Math.ceil((hi + pad) / 1000) * 1000,
    min: Math.floor((lo - pad) / 1000) * 1000,
  };
}

function toY(value, max, min) {
  const range = Math.max(max - min, 1);
  return Math.max(0, Math.min(CHART_H, CHART_H - ((value - min) / range) * CHART_H));
}

function yLabels(max, min, count = 6) {
  return Array.from({ length: count }, (_, i) => {
    const v = max - ((max - min) / (count - 1)) * i;
    return Math.abs(v) >= 1000 ? `$${Math.round(v / 1000)}K` : wholeDollars(v);
  });
}

function parseDollar(v) {
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function ForecastLab({
  trueCash,
  subscriptions,
  incomeStreams,
  budgetRows,
  projectionAdjustments,
}) {
  const [extraIncomeRaw, setExtraIncomeRaw] = useState("0");
  const [savedSpendingRaw, setSavedSpendingRaw] = useState("0");
  const [scenarioName, setScenarioName] = useState("My Scenario");
  const [hoveredMonth, setHoveredMonth] = useState(null);
  const currentBudgetPeriod = getCurrentBudgetPeriod();
  const subscriptionOverview = buildSubscriptionOverview(subscriptions);

  const extraIncome = parseDollar(extraIncomeRaw);
  const savedSpending = parseDollar(savedSpendingRaw);
  const hasScenario = extraIncome !== 0 || savedSpending !== 0;

  const baseline = buildProjection(
    trueCash,
    incomeStreams,
    budgetRows,
    projectionAdjustments,
    0,
    0,
    currentBudgetPeriod.month,
    currentBudgetPeriod.year
  );
  const scenario = buildProjection(
    trueCash,
    incomeStreams,
    budgetRows,
    projectionAdjustments,
    extraIncome,
    savedSpending,
    currentBudgetPeriod.month,
    currentBudgetPeriod.year
  );

  const baselineEnd = baseline.at(-1)?.value ?? trueCash;
  const scenarioEnd = scenario.at(-1)?.value ?? trueCash;
  const totalDiff = scenarioEnd - baselineEnd;
  const diffPct = baselineEnd ? (totalDiff / Math.abs(baselineEnd)) * 100 : 0;
  const projectionMonthsRemaining = baseline.length;

  const { max, min } = chartRange(baseline, scenario, trueCash);
  const labels = yLabels(max, min);
  const py = (v) => toY(v, max, min);

  const startCoord = [MONTH_X[currentBudgetPeriod.month], py(trueCash)];

  const bPoints = [
    startCoord,
    ...baseline
      .filter((p) => MONTH_X[p.month] !== undefined)
      .map((p) => [MONTH_X[p.month], py(p.value)]),
  ];
  const sPoints = [
    startCoord,
    ...scenario
      .filter((p) => MONTH_X[p.month] !== undefined)
      .map((p) => [MONTH_X[p.month], py(p.value)]),
  ];

  const bPath = buildLinePath(bPoints);
  const bArea = buildAreaPath(bPoints);
  const sPath = buildLinePath(sPoints);
  const sArea = buildAreaPath(sPoints);

  const fieldStyle = {
    color: "#eaf3ff",
    background: "rgba(0,136,255,.08)",
    border: "1px solid rgba(0,216,255,.18)",
    borderRadius: 8,
    padding: "10px 12px",
    outline: "none",
    fontWeight: 800,
    colorScheme: "dark",
    width: "100%",
  };

  return (
    <div>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 24,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 32, color: "white", fontWeight: 800 }}>Forecast Lab</h1>
          <p style={{ marginTop: 8, color: "#8ea8ca" }}>
            Model &ldquo;what-if&rdquo; scenarios to project the long-range impact of income or
            spending changes.
          </p>
        </div>
      </header>

      {/* Controls */}
      <div
        style={{
          ...styles.panel,
          padding: 22,
          marginBottom: 20,
          border: "1px solid rgba(0,216,255,.22)",
          boxShadow: "inset 0 0 22px rgba(0,136,255,.06)",
        }}
      >
        <div
          style={{
            color: "white",
            fontSize: 18,
            fontWeight: 900,
            marginBottom: 18,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span style={{ color: "#00d8ff" }}>◈</span> Scenario Builder
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.8fr 1fr 1fr auto",
            gap: 18,
            alignItems: "end",
          }}
        >
          <label style={{ display: "grid", gap: 7 }}>
            <span
              style={{
                color: "#8fb1d9",
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: 0.8,
                fontWeight: 900,
              }}
            >
              Scenario Name
            </span>
            <input
              type="text"
              value={scenarioName}
              onChange={(e) => setScenarioName(e.target.value)}
              style={fieldStyle}
            />
          </label>
          <label style={{ display: "grid", gap: 7 }}>
            <span
              style={{
                color: "#8fb1d9",
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: 0.8,
                fontWeight: 900,
              }}
            >
              Extra Monthly Income ($)
            </span>
            <input
              type="text"
              value={extraIncomeRaw}
              onChange={(e) => setExtraIncomeRaw(e.target.value)}
              style={fieldStyle}
            />
          </label>
          <label style={{ display: "grid", gap: 7 }}>
            <span
              style={{
                color: "#8fb1d9",
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: 0.8,
                fontWeight: 900,
              }}
            >
              Monthly Spending Reduction ($)
            </span>
            <input
              type="text"
              value={savedSpendingRaw}
              onChange={(e) => setSavedSpendingRaw(e.target.value)}
              style={fieldStyle}
            />
          </label>
          <button
            onClick={() => {
              setExtraIncomeRaw("0");
              setSavedSpendingRaw("0");
              setScenarioName("My Scenario");
            }}
            style={{
              background: "rgba(0,136,255,.10)",
              border: "1px solid rgba(0,216,255,.28)",
              borderRadius: 10,
              color: "#d7ebff",
              padding: "11px 22px",
              cursor: "pointer",
              fontWeight: 800,
              marginBottom: 2,
            }}
          >
            Reset
          </button>
        </div>
        <div style={{ marginTop: 12, color: "#7294bb", fontSize: 12 }}>
          Forecasts are anchored to your live Dashboard true-cash balance, then projected forward
          through the remaining months in the year. Adjustments use your existing Operations Board
          income streams and budget as the base.
        </div>
        {subscriptionOverview.activeCount > 0 ? (
          <div style={{ marginTop: 12, color: "#8feaff", fontSize: 12 }}>
            Active recurring commitments: {money(subscriptionOverview.activeMonthly)}/month (
            {money(subscriptionOverview.yearlyCommitment)} annualized) across{" "}
            {subscriptionOverview.activeCount} subscriptions.
          </div>
        ) : null}
      </div>

      {/* Summary Tiles */}
      <div
        style={{
          ...styles.panel,
          padding: 24,
          marginBottom: 20,
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "radial-gradient(circle at top right, rgba(0,216,255,.1), transparent 40%)",
          }}
        />
        <div
          style={{
            position: "relative",
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 18,
          }}
        >
          {[
            ["Current True Cash", wholeDollars(trueCash), "#00d8ff"],
            ["Baseline Year-End", wholeDollars(baselineEnd), "#8feaff"],
            [
              `${scenarioName} Year-End`,
              wholeDollars(scenarioEnd),
              !hasScenario ? "#00d8ff" : totalDiff >= 0 ? "#00f59b" : "#ff5d7a",
            ],
            [
              "Year-End Difference",
              `${totalDiff >= 0 ? "+" : ""}${wholeDollars(totalDiff)}`,
              totalDiff >= 0 ? "#00f59b" : "#ff5d7a",
            ],
          ].map(([label, val, color]) => (
            <div
              key={label}
              style={{
                border: "1px solid rgba(0,136,255,.22)",
                borderRadius: 14,
                background: "rgba(3,17,32,.72)",
                padding: 20,
              }}
            >
              <div
                style={{
                  color: "#8fb1d9",
                  fontSize: 13,
                  textTransform: "uppercase",
                  marginBottom: 12,
                }}
              >
                {label}
              </div>
              <div style={{ color, fontSize: 26, fontWeight: 900 }}>{val}</div>
              {label === "Year-End Difference" && hasScenario ? (
                <div style={{ color, fontSize: 12, marginTop: 6, fontWeight: 700 }}>
                  {diffPct >= 0 ? "+" : ""}
                  {diffPct.toFixed(1)}% vs baseline
                </div>
              ) : label === "Current True Cash" ? (
                <div style={{ color: "#8fb1d9", fontSize: 12, marginTop: 6, fontWeight: 700 }}>
                  Dashboard anchor for the remaining {projectionMonthsRemaining} month
                  {projectionMonthsRemaining === 1 ? "" : "s"}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div style={{ ...styles.panel, padding: "24px 24px 0", marginBottom: 20 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 22,
          }}
        >
          <div style={{ color: "white", fontSize: 20, fontWeight: 800 }}>
            True Cash Projection — Remaining {currentBudgetPeriod.year}
          </div>
          <div style={{ display: "flex", gap: 20, alignItems: "center", fontSize: 13 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 24, height: 3, background: "#138bff", borderRadius: 2 }} />
              <span style={{ color: "#8fb1d9" }}>Baseline</span>
            </div>
            {hasScenario ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 24, height: 3, background: "#00f59b", borderRadius: 2 }} />
                <span style={{ color: "#8fb1d9" }}>{scenarioName}</span>
              </div>
            ) : null}
          </div>
        </div>

        <div style={{ display: "flex", gap: 0 }}>
          <div
            style={{
              width: 52,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              paddingBottom: 40,
            }}
          >
            {labels.map((l) => (
              <span key={l} style={{ color: "#5e7da0", fontSize: 11, textAlign: "right" }}>
                {l}
              </span>
            ))}
          </div>

          <div style={{ flex: 1, position: "relative" }}>
            <svg
              viewBox={`0 0 ${CHART_W} ${CHART_H + 36}`}
              style={{ width: "100%", overflow: "visible" }}
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const svgX = ((e.clientX - rect.left) / rect.width) * CHART_W;
                const months = [
                  currentBudgetPeriod.month,
                  ...baseline.map((point) => point.month),
                ].filter((month, index, allMonths) => {
                  return MONTH_X[month] !== undefined && allMonths.indexOf(month) === index;
                });
                const closest = months.reduce(
                  (best, m) => {
                    const dist = Math.abs(MONTH_X[m] - svgX);
                    return dist < best.dist ? { m, dist } : best;
                  },
                  { m: null, dist: Infinity }
                );
                setHoveredMonth(closest.m);
              }}
              onMouseLeave={() => setHoveredMonth(null)}
            >
              <defs>
                <linearGradient id="fcBG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#138bff" stopOpacity="0.22" />
                  <stop offset="100%" stopColor="#138bff" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="fcSG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#00f59b" stopOpacity="0.16" />
                  <stop offset="100%" stopColor="#00f59b" stopOpacity="0" />
                </linearGradient>
              </defs>

              {labels.map((_, i) => {
                const y = (i / (labels.length - 1)) * CHART_H;
                return (
                  <line
                    key={i}
                    x1={0}
                    y1={y}
                    x2={CHART_W}
                    y2={y}
                    stroke="rgba(0,136,255,.1)"
                    strokeWidth={1}
                  />
                );
              })}

              {budgetMonths.map((m) => (
                <line
                  key={m}
                  x1={MONTH_X[m]}
                  y1={0}
                  x2={MONTH_X[m]}
                  y2={CHART_H}
                  stroke="rgba(0,136,255,.06)"
                  strokeWidth={1}
                />
              ))}

              {bArea ? <path d={bArea} fill="url(#fcBG)" /> : null}
              {hasScenario && sArea ? <path d={sArea} fill="url(#fcSG)" /> : null}

              {bPath ? (
                <path
                  d={bPath}
                  fill="none"
                  stroke="#138bff"
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ) : null}
              {hasScenario && sPath ? (
                <path
                  d={sPath}
                  fill="none"
                  stroke="#00f59b"
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ) : null}

              {/* Hover overlay */}
              {hoveredMonth && MONTH_X[hoveredMonth] !== undefined
                ? (() => {
                    const bRow = baseline.find((p) => p.month === hoveredMonth);
                    const sRow = scenario.find((p) => p.month === hoveredMonth);
                    const isCurrentMonth = hoveredMonth === currentBudgetPeriod.month;
                    const baselineValue = isCurrentMonth ? trueCash : bRow?.value;
                    const scenarioValue = isCurrentMonth ? trueCash : sRow?.value;
                    if (baselineValue === undefined) return null;
                    const hx = MONTH_X[hoveredMonth];
                    const by = py(baselineValue);
                    const sy = scenarioValue !== undefined ? py(scenarioValue) : null;
                    const diff = scenarioValue !== undefined ? scenarioValue - baselineValue : 0;
                    const tipX = hx > CHART_W * 0.7 ? hx - 178 : hx + 12;
                    const tipH = hasScenario ? 118 : 76;
                    const tipY = Math.min(by, sy ?? by) - tipH / 2;
                    return (
                      <g>
                        <line
                          x1={hx}
                          y1={0}
                          x2={hx}
                          y2={CHART_H}
                          stroke="rgba(0,216,255,.45)"
                          strokeWidth={1}
                          strokeDasharray="3 3"
                        />
                        <circle
                          cx={hx}
                          cy={by}
                          r={5}
                          fill="#138bff"
                          stroke="white"
                          strokeWidth={1.5}
                        />
                        {hasScenario && sy !== null ? (
                          <circle
                            cx={hx}
                            cy={sy}
                            r={5}
                            fill="#00f59b"
                            stroke="white"
                            strokeWidth={1.5}
                          />
                        ) : null}
                        <foreignObject
                          x={tipX}
                          y={Math.max(4, tipY)}
                          width={168}
                          height={tipH + 10}
                        >
                          <div
                            style={{
                              background: "rgba(4,18,38,.95)",
                              border: "1px solid rgba(0,216,255,.3)",
                              borderRadius: 8,
                              padding: "10px 12px",
                              color: "white",
                              fontSize: 13,
                            }}
                          >
                            <div
                              style={{
                                color: "#8feaff",
                                fontSize: 11,
                                marginBottom: 7,
                                fontWeight: 700,
                              }}
                            >
                              {hoveredMonth} {currentBudgetPeriod.year}
                            </div>
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                marginBottom: 4,
                              }}
                            >
                              <span style={{ color: "#8fb1d9" }}>Baseline</span>
                              <span style={{ color: "#138bff", fontWeight: 800 }}>
                                {isCurrentMonth ? wholeDollars(trueCash) : bRow?.formattedValue}
                              </span>
                            </div>
                            {hasScenario && scenarioValue !== undefined ? (
                              <>
                                <div
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    marginBottom: 4,
                                  }}
                                >
                                  <span style={{ color: "#8fb1d9" }}>Scenario</span>
                                  <span style={{ color: "#00f59b", fontWeight: 800 }}>
                                    {isCurrentMonth ? wholeDollars(trueCash) : sRow?.formattedValue}
                                  </span>
                                </div>
                                <div
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    paddingTop: 6,
                                    borderTop: "1px solid rgba(0,136,255,.2)",
                                    fontSize: 12,
                                  }}
                                >
                                  <span style={{ color: "#8fb1d9" }}>Diff</span>
                                  <span
                                    style={{
                                      fontWeight: 800,
                                      color: diff >= 0 ? "#00f59b" : "#ff5d7a",
                                    }}
                                  >
                                    {diff >= 0 ? "+" : ""}
                                    {wholeDollars(diff)}
                                  </span>
                                </div>
                              </>
                            ) : null}
                          </div>
                        </foreignObject>
                      </g>
                    );
                  })()
                : null}

              {budgetMonths.map((m) => (
                <text
                  key={m}
                  x={MONTH_X[m]}
                  y={CHART_H + 22}
                  textAnchor="middle"
                  style={{ fill: "#5e7da0", fontSize: 11 }}
                >
                  {m}
                </text>
              ))}
            </svg>
          </div>
        </div>
      </div>

      {/* Monthly Table */}
      <div style={{ ...styles.panel, padding: 24 }}>
        <div style={{ color: "white", fontSize: 20, fontWeight: 800, marginBottom: 18 }}>
          Monthly Breakdown
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: hasScenario ? "100px 1fr 1fr 1fr 1fr" : "100px 1fr 1fr 1fr",
            padding: "0 16px 12px",
            color: "#7294bb",
            fontSize: 12,
            textTransform: "uppercase",
            letterSpacing: 1,
            borderBottom: "1px solid rgba(0,136,255,.14)",
          }}
        >
          <div>Month</div>
          <div style={{ textAlign: "right" }}>Monthly Profit</div>
          <div style={{ textAlign: "right" }}>Adjustment</div>
          <div style={{ textAlign: "right" }}>Baseline</div>
          {hasScenario ? <div style={{ textAlign: "right" }}>{scenarioName}</div> : null}
        </div>

        <div style={{ maxHeight: "52vh", overflowY: "auto" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: hasScenario ? "100px 1fr 1fr 1fr 1fr" : "100px 1fr 1fr 1fr",
              alignItems: "center",
              padding: "11px 16px",
              borderBottom: "1px solid rgba(0,136,255,.08)",
              background:
                hoveredMonth === currentBudgetPeriod.month
                  ? "rgba(0,136,255,.07)"
                  : "rgba(255,255,255,.01)",
              borderLeft:
                hoveredMonth === currentBudgetPeriod.month
                  ? "2px solid rgba(0,216,255,.4)"
                  : "2px solid transparent",
              transition: "background .12s",
            }}
            onMouseEnter={() => setHoveredMonth(currentBudgetPeriod.month)}
            onMouseLeave={() => setHoveredMonth(null)}
          >
            <div style={{ color: "white", fontWeight: 700 }}>{currentBudgetPeriod.month} Start</div>
            <div style={{ textAlign: "right", color: "#5e7da0", fontSize: 14 }}>—</div>
            <div style={{ textAlign: "right", color: "#5e7da0", fontSize: 14 }}>—</div>
            <div style={{ color: "#138bff", textAlign: "right", fontWeight: 800, fontSize: 15 }}>
              {wholeDollars(trueCash)}
            </div>
            {hasScenario ? (
              <div style={{ color: "#00f59b", textAlign: "right", fontWeight: 800, fontSize: 15 }}>
                {wholeDollars(trueCash)}
              </div>
            ) : null}
          </div>

          {baseline.map((bRow, i) => {
            const sRow = scenario[i];
            const diff = sRow ? sRow.value - bRow.value : 0;
            const isHov = hoveredMonth === bRow.month;
            return (
              <div
                key={bRow.month}
                onMouseEnter={() => setHoveredMonth(bRow.month)}
                onMouseLeave={() => setHoveredMonth(null)}
                style={{
                  display: "grid",
                  gridTemplateColumns: hasScenario ? "100px 1fr 1fr 1fr 1fr" : "100px 1fr 1fr 1fr",
                  alignItems: "center",
                  padding: "11px 16px",
                  borderBottom: "1px solid rgba(0,136,255,.08)",
                  background: isHov
                    ? "rgba(0,136,255,.07)"
                    : i % 2 === 0
                      ? "rgba(255,255,255,.01)"
                      : "transparent",
                  borderLeft: isHov ? "2px solid rgba(0,216,255,.4)" : "2px solid transparent",
                  transition: "background .12s",
                }}
              >
                <div style={{ color: "white", fontWeight: 700 }}>
                  {bRow.month} {currentBudgetPeriod.year}
                </div>
                <div
                  style={{
                    textAlign: "right",
                    fontWeight: 700,
                    color: bRow.profit >= 0 ? "#00f59b" : "#ff5d7a",
                    fontSize: 14,
                  }}
                >
                  {bRow.profit >= 0 ? "+" : ""}
                  {wholeDollars(bRow.profit)}
                </div>
                <div
                  style={{
                    textAlign: "right",
                    color: bRow.adjustment !== 0 ? "#ffb65d" : "#5e7da0",
                    fontSize: 14,
                  }}
                >
                  {bRow.adjustment !== 0
                    ? `${bRow.adjustment >= 0 ? "+" : ""}${wholeDollars(bRow.adjustment)}`
                    : "—"}
                </div>
                <div
                  style={{ color: "#138bff", textAlign: "right", fontWeight: 800, fontSize: 15 }}
                >
                  {bRow.formattedValue}
                </div>
                {hasScenario && sRow ? (
                  <div
                    style={{
                      color: diff >= 0 ? "#00f59b" : "#ff5d7a",
                      textAlign: "right",
                      fontWeight: 800,
                      fontSize: 15,
                    }}
                  >
                    {sRow.formattedValue}
                    {diff !== 0 ? (
                      <span style={{ fontSize: 11, marginLeft: 5, opacity: 0.75 }}>
                        ({diff >= 0 ? "+" : ""}
                        {wholeDollars(diff)})
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: hasScenario ? "100px 1fr 1fr 1fr 1fr" : "100px 1fr 1fr 1fr",
            padding: "14px 16px",
            borderTop: "1px solid rgba(0,136,255,.2)",
            background: "rgba(0,136,255,.06)",
          }}
        >
          <div
            style={{ color: "#8feaff", fontWeight: 800, fontSize: 13, textTransform: "uppercase" }}
          >
            Year-End
          </div>
          <div />
          <div />
          <div style={{ color: "#138bff", textAlign: "right", fontWeight: 900, fontSize: 16 }}>
            {wholeDollars(baselineEnd)}
          </div>
          {hasScenario ? (
            <div
              style={{
                color: totalDiff >= 0 ? "#00f59b" : "#ff5d7a",
                textAlign: "right",
                fontWeight: 900,
                fontSize: 16,
              }}
            >
              {wholeDollars(scenarioEnd)}
              {totalDiff !== 0 ? (
                <span style={{ fontSize: 12, marginLeft: 6, opacity: 0.8 }}>
                  ({totalDiff >= 0 ? "+" : ""}
                  {wholeDollars(totalDiff)})
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
