import { useState } from "react";
import { APP_TABS, budgetMonths, chartSets } from "../data/constants.jsx";
import { buildMonthlyBudgetReview } from "../utils/budgetReview.js";
import { getCurrentBudgetPeriod } from "../utils/date.js";
import { styles } from "../styles.js";
import { buildAreaPath, buildLinePath, money, parseMoney, wholeDollars } from "../utils/format.js";
import { buildReconciledTrueCashSeries } from "../utils/planning.js";
import {
  parseChartDate,
  buildSyncedTrueCashChart,
  buildTrueCashProjectionSchedule,
} from "../utils/trueCashProjection.js";
import { HouseholdProfilesControl, InfoDot, MetricCard } from "./Common.jsx";
import { BudgetOrbitChart } from "./BudgetOrbitChart.jsx";
import { NetWorthOrbitChart } from "./NetWorthOrbitChart.jsx";
import { NetWorthHistoryChart } from "./NetWorthHistoryChart.jsx";

const CHART_HEIGHT = 300;
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

const headerMenuButtonStyle = {
  borderRadius: 10,
  border: "1px solid rgba(0,216,255,.24)",
  background: "rgba(0,136,255,.08)",
  color: "#eef6ff",
  padding: "9px 11px",
  fontSize: 12,
  fontWeight: 700,
  textAlign: "left",
  cursor: "pointer",
};

const TRUE_CASH_TITLE_ICON = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
    <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
    <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.8" />
    <path d="M3.5 9.2h17M3.5 14.8h17" stroke="currentColor" strokeWidth="1.4" opacity="0.85" />
  </svg>
);

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


function parseSnapshotDate(dateKey) {
  const [year, month, day] = String(dateKey || "")
    .split("-")
    .map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function buildMonthlyTrueCashActuals(metricSnapshots, targetYear, liveCurrentTrueCash, currentMonthIndex) {
  const monthlyValues = Array.from({ length: budgetMonths.length }, () => null);
  Object.entries(metricSnapshots || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([dateKey, snapshot]) => {
      if (!snapshot || typeof snapshot.trueCash !== "number") return;
      const date = parseSnapshotDate(dateKey);
      if (!date || date.getFullYear() !== targetYear) return;
      monthlyValues[date.getMonth()] = Number(snapshot.trueCash);
    });

  if (targetYear === getCurrentBudgetPeriod().year) {
    monthlyValues[currentMonthIndex] = Number(liveCurrentTrueCash) || 0;
  }

  return monthlyValues;
}

export function DashboardView({
  activeRange,
  setActiveRange,
  setActiveTab,
  sessionControls,
  trueCash,
  transactions,
  incomeStreams,
  budgetRows,
  dynamicMetrics,
  dynamicAllocations,
  metricSnapshots,
  householdProfilesProps,
  planningAnchor,
  currentMonthSnapshot,
}) {
  const [hoverState, setHoverState] = useState(null);
  const [netWorthHistoryRange, setNetWorthHistoryRange] = useState("30D");
  const [isAccountPanelOpen, setIsAccountPanelOpen] = useState(false);
  const [isEditingProfileName, setIsEditingProfileName] = useState(false);
  const [isEditingEmail, setIsEditingEmail] = useState(false);
  const [profileNameDraft, setProfileNameDraft] = useState("");
  const [emailDraft, setEmailDraft] = useState("");
  const [accountPanelError, setAccountPanelError] = useState("");
  const sessionUser = sessionControls?.user || null;
  const sessionLabel = sessionUser?.displayName?.trim() || sessionUser?.email || "Account";
  const sessionEmail = sessionUser?.email || "";
  const profileChipLabel = (() => {
    const normalizedLabel = String(sessionLabel).replace(/[^a-zA-Z0-9 ]/g, " ").trim();
    if (!normalizedLabel) return "KP";
    const parts = normalizedLabel.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "KP";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
  })();
  const toggleAccountPanel = () => {
    setIsAccountPanelOpen((current) => {
      const nextOpen = !current;
      if (nextOpen) {
        setProfileNameDraft(sessionUser?.displayName || "");
        setEmailDraft(sessionEmail || "");
        setIsEditingProfileName(false);
        setIsEditingEmail(false);
        setAccountPanelError("");
      }
      return nextOpen;
    });
  };
  const handleProfileNameSave = async () => {
    if (typeof sessionControls?.onUpdateProfileName !== "function") return;
    setAccountPanelError("");
    try {
      await sessionControls.onUpdateProfileName({ displayName: profileNameDraft });
      setIsEditingProfileName(false);
    } catch (error) {
      setAccountPanelError(error?.message || "Unable to update profile name right now.");
    }
  };
  const handleEmailSave = async () => {
    if (typeof sessionControls?.onRequestEmailChange !== "function") return;
    setAccountPanelError("");
    try {
      await sessionControls.onRequestEmailChange({ nextEmail: emailDraft });
      setIsEditingEmail(false);
    } catch (error) {
      setAccountPanelError(error?.message || "Unable to request email change right now.");
    }
  };
  const monthlyBudgetReview =
    currentMonthSnapshot ||
    buildMonthlyBudgetReview(transactions, budgetRows, {
      month: getCurrentBudgetPeriod().month,
      year: getCurrentBudgetPeriod().year,
    });
  const currentBudgetPeriod = getCurrentBudgetPeriod();
  const projectionStartMonth = planningAnchor?.startingMonth || currentBudgetPeriod.month;
  const projectionStartMonthIndex = Math.max(0, budgetMonths.indexOf(projectionStartMonth));
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
    startingMonth: projectionStartMonth,
    startingTrueCash: projectionStartingTrueCash,
  });
  const projectionYear = projectionSchedule[0]?.year || parseChartDate(chartValues.date).year;
  const monthlyTrueCashActuals = buildMonthlyTrueCashActuals(
    metricSnapshots,
    projectionYear,
    trueCash,
    currentBudgetPeriod.monthIndex
  );
  const reconciledTrueCashSeries = chartValues.supportsProjection
    ? buildReconciledTrueCashSeries({
        targetYear: projectionYear,
        incomeStreams,
        budgetRows,
        startingMonth: projectionStartMonth,
        startingTrueCash: projectionStartingTrueCash,
        liveCurrentTrueCash: trueCash,
      })
    : [];
  const anchoredTrueCashSeries = chartValues.supportsProjection
    ? reconciledTrueCashSeries.map((entry, index) => {
        if (entry.value === null) return entry;
        if (projectionYear !== currentBudgetPeriod.year) return entry;
        if (index < projectionStartMonthIndex || index > currentBudgetPeriod.monthIndex) return entry;
        const recordedValue = monthlyTrueCashActuals[index];
        if (recordedValue === null || recordedValue === undefined) return entry;
        return {
          ...entry,
          value: recordedValue,
        };
      })
    : [];
  const anchoredActualValues = chartValues.supportsProjection
    ? anchoredTrueCashSeries.map((entry) => entry.value).filter((value) => value !== null)
    : chartValues.values.map((value) => parseMoney(value));
  const anchoredActualDates = chartValues.supportsProjection
    ? anchoredTrueCashSeries
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
    ? anchoredTrueCashSeries
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
      type: point.type,
    })),
  ];
  const isProjectionHover = hoverState?.point.type === "projected";

  return (
    <div className="dashboard-view">
      <header style={{ ...styles.pageHeader, marginBottom: 20 }}>
        <div>
          <h1 style={styles.pageTitle}>Command Center</h1>
          <p style={styles.pageSubtitle}>Real-time overview of your financial position</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <HouseholdProfilesControl {...householdProfilesProps} />
          <div style={{ position: "relative" }}>
            <button
              type="button"
              onClick={toggleAccountPanel}
              aria-label="Open account menu"
              style={{
                border: "1px solid #148cff",
                background: "rgba(2,16,36,.72)",
                cursor: "pointer",
                width: 48,
                height: 48,
                borderRadius: 999,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#19d5ff",
                fontSize: 16,
                fontWeight: 800,
                boxShadow: "0 0 22px rgba(0,120,255,.45)",
              }}
            >
              {profileChipLabel}
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
            </button>
            {isAccountPanelOpen ? (
              <div
                style={{
                  position: "absolute",
                  top: 58,
                  right: 0,
                  width: 290,
                  borderRadius: 14,
                  border: "1px solid rgba(0,216,255,.24)",
                  background: "rgba(4,16,31,.96)",
                  boxShadow: "0 10px 32px rgba(0,70,170,.3)",
                  padding: 14,
                  zIndex: 30,
                }}
              >
                <div
                  style={{
                    color: "#8feaff",
                    fontSize: 11,
                    letterSpacing: 1,
                    textTransform: "uppercase",
                    fontWeight: 900,
                  }}
                >
                  Account hub
                </div>
                <div style={{ color: "#9fb0c9", fontSize: 11, marginTop: 8, textTransform: "uppercase" }}>
                  Profile name
                </div>
                {isEditingProfileName ? (
                  <div style={{ marginTop: 6 }}>
                    <input
                      type="text"
                      value={profileNameDraft}
                      onChange={(event) => setProfileNameDraft(event.target.value)}
                      placeholder="Your profile name"
                      style={accountEditInputStyle}
                    />
                    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                      <button
                        type="button"
                        onClick={handleProfileNameSave}
                        disabled={sessionControls?.isBusy}
                        style={headerMenuButtonStyle}
                      >
                        Save name
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsEditingProfileName(false);
                          setProfileNameDraft(sessionUser?.displayName || "");
                        }}
                        style={headerMenuButtonStyle}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginTop: 4 }}>
                    <div style={{ color: "white", fontWeight: 800 }}>{sessionLabel}</div>
                    {typeof sessionControls?.onUpdateProfileName === "function" ? (
                      <button
                        type="button"
                        onClick={() => setIsEditingProfileName(true)}
                        style={headerInlineActionStyle}
                      >
                        Edit
                      </button>
                    ) : null}
                  </div>
                )}
                <div style={{ color: "#9fb0c9", fontSize: 11, marginTop: 10, textTransform: "uppercase" }}>
                  Email
                </div>
                {isEditingEmail ? (
                  <div style={{ marginTop: 6 }}>
                    <input
                      type="email"
                      value={emailDraft}
                      onChange={(event) => setEmailDraft(event.target.value)}
                      placeholder="name@email.com"
                      style={accountEditInputStyle}
                    />
                    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                      <button
                        type="button"
                        onClick={handleEmailSave}
                        disabled={sessionControls?.isBusy}
                        style={headerMenuButtonStyle}
                      >
                        Save email
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsEditingEmail(false);
                          setEmailDraft(sessionEmail || "");
                        }}
                        style={headerMenuButtonStyle}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginTop: 4 }}>
                    <div style={{ color: "#d9eaff", fontSize: 12, wordBreak: "break-all" }}>
                      {sessionEmail || "No email on file"}
                    </div>
                    {typeof sessionControls?.onRequestEmailChange === "function" ? (
                      <button
                        type="button"
                        onClick={() => setIsEditingEmail(true)}
                        style={headerInlineActionStyle}
                      >
                        Edit
                      </button>
                    ) : null}
                  </div>
                )}
                <div style={{ color: "#9fb0c9", fontSize: 12, marginTop: 4 }}>
                  {sessionControls?.isEmailVerified ? "Verified account" : "Email verification pending"}
                </div>
                <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab(APP_TABS.ADD_ACCOUNTS);
                      setIsAccountPanelOpen(false);
                    }}
                    style={headerMenuButtonStyle}
                  >
                    Manage accounts
                  </button>
                  {typeof sessionControls?.onRequestPasswordReset === "function" ? (
                    <button
                      type="button"
                      onClick={sessionControls.onRequestPasswordReset}
                      disabled={sessionControls?.isBusy}
                      style={headerMenuButtonStyle}
                    >
                      {sessionControls?.isBusy ? "Sending reset..." : "Send password reset email"}
                    </button>
                  ) : null}
                  {!sessionControls?.isEmailVerified &&
                  typeof sessionControls?.onResendVerification === "function" ? (
                    <button
                      type="button"
                      onClick={sessionControls.onResendVerification}
                      disabled={sessionControls?.isBusy}
                      style={headerMenuButtonStyle}
                    >
                      {sessionControls?.isBusy ? "Sending..." : "Resend verification email"}
                    </button>
                  ) : null}
                  {sessionControls?.workspaceStatus ? (
                    <div style={{ color: "#8feaff", fontSize: 12, lineHeight: 1.4 }}>
                      {sessionControls.workspaceStatus}
                    </div>
                  ) : null}
                  {sessionControls?.notice ? (
                    <div style={{ color: "#dff7ff", fontSize: 12, lineHeight: 1.4 }}>
                      {sessionControls.notice}
                    </div>
                  ) : null}
                  {sessionControls?.error ? (
                    <div style={{ color: "#ffd0d6", fontSize: 12, lineHeight: 1.4 }}>
                      {sessionControls.error}
                    </div>
                  ) : null}
                  {accountPanelError ? (
                    <div style={{ color: "#ffd0d6", fontSize: 12, lineHeight: 1.4 }}>
                      {accountPanelError}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onClick={sessionControls?.onSignOut}
                    disabled={sessionControls?.isBusy}
                    style={headerMenuButtonStyle}
                  >
                    {sessionControls?.isBusy ? "Signing out..." : "Sign out"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <section
        className="dashboard-chart-panel"
        style={{ ...styles.panel, padding: 20, width: "100%", overflow: "hidden" }}
      >
        <div
          className="dashboard-chart-toolbar"
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
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                border: "1px solid rgba(0,216,255,.34)",
                background: "rgba(0,104,255,.14)",
                color: "#00d8ff",
                display: "grid",
                placeItems: "center",
                lineHeight: 0,
                boxShadow: "0 0 16px rgba(0,136,255,.2)",
              }}
            >
              {TRUE_CASH_TITLE_ICON}
            </span>
            TRUE CASH <InfoDot tooltip="True Cash chart tracks liquid cash minus credit card debt over time." />
          </div>
          <div className="dashboard-chart-actions" style={{ display: "flex", gap: 12 }}>
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
          className="dashboard-chart-summary"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            marginBottom: 24,
          }}
        >
          <div className="dashboard-cash-value" style={{ display: "flex", alignItems: "flex-end", gap: 12 }}>
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
            className="dashboard-range-controls"
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

        <div
          className="dashboard-chart-frame"
          style={{ position: "relative", height: 330, paddingLeft: 56, width: "100%" }}
        >
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
            className="dashboard-chart-xaxis"
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
        className="responsive-grid-4 dashboard-metrics-grid"
        style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 12, marginTop: 16 }}
      >
        {dynamicMetrics.map((metric) => (
          <MetricCard key={metric.title} metric={metric} />
        ))}
      </section>

      <section
        className="responsive-two-column dashboard-overview-grid"
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
          <BudgetOrbitChart
            transactions={transactions}
            budgetRows={budgetRows}
            year={monthlyBudgetReview.year}
            currentMonth={monthlyBudgetReview.month}
          />
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
          <NetWorthOrbitChart allocations={dynamicAllocations} />
        </div>
      </section>

      <section style={{ ...styles.panel, padding: 20, marginTop: 16 }}>
        <div
          className="dashboard-chart-toolbar"
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
              }}
            >
              Net Worth History <InfoDot />
            </div>
          </div>
          <div className="dashboard-chart-actions" style={{ display: "flex", alignItems: "center", gap: 12 }}>
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

        <NetWorthHistoryChart metricSnapshots={metricSnapshots} range={netWorthHistoryRange} />
      </section>
    </div>
  );
}

const accountEditInputStyle = {
  width: "100%",
  borderRadius: 10,
  border: "1px solid rgba(0,216,255,.24)",
  background: "rgba(2,16,36,.9)",
  color: "#eff8ff",
  padding: "8px 10px",
  fontSize: 12,
};

const headerInlineActionStyle = {
  border: "1px solid rgba(0,216,255,.24)",
  borderRadius: 999,
  background: "rgba(0,136,255,.08)",
  color: "#9fdaff",
  fontSize: 11,
  lineHeight: 1,
  padding: "5px 10px",
  cursor: "pointer",
  fontWeight: 700,
  height: "fit-content",
};
