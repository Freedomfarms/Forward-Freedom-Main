import { useMemo, useState } from "react";
import { styles } from "../styles.js";
import { money } from "../utils/format.js";
import {
  GOAL_CADENCE_OPTIONS,
  GOAL_METRIC_LIBRARY,
  buildObjectiveFromInput,
  buildSeedObjectives,
  normalizeObjectives,
} from "../utils/objectives.js";
import { monthlyEquivalent } from "../utils/subscriptions.js";
import { HouseholdProfilesControl } from "./Common.jsx";

const STATUS_THEME = {
  completed: { label: "Completed", color: "#8f7dff", glow: "rgba(143,125,255,.38)" },
  on_track: { label: "On Track", color: "#00f59b", glow: "rgba(0,245,155,.35)" },
  at_risk: { label: "At Risk", color: "#ffb65d", glow: "rgba(255,182,93,.35)" },
  off_track: { label: "Off Track", color: "#ff5d7a", glow: "rgba(255,93,122,.35)" },
};

const METRIC_LOOKUP = Object.fromEntries(
  GOAL_METRIC_LIBRARY.map((metric) => [metric.key, metric])
);

const EMPTY_FORM = {
  title: "",
  description: "",
  cadence: "Monthly",
  metricKey: GOAL_METRIC_LIBRARY[0].key,
  targetValue: GOAL_METRIC_LIBRARY[0].defaultTarget,
  aiSuggested: false,
};

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseGoalDate(value) {
  const rawValue = String(value || "");
  const isoDateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rawValue);
  if (isoDateMatch) {
    const [, yearText, monthText, dayText] = isoDateMatch;
    return new Date(Number(yearText), Number(monthText) - 1, Number(dayText));
  }
  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function buildDateRange(cadence, now = new Date()) {
  const current = new Date(now);
  const year = current.getFullYear();
  const month = current.getMonth();
  const day = current.getDate();

  if (cadence === "Daily") {
    return { start: startOfDay(current), end: endOfDay(current) };
  }

  if (cadence === "Weekly") {
    const dayOfWeek = (current.getDay() + 6) % 7;
    const start = new Date(year, month, day - dayOfWeek);
    const end = new Date(year, month, day - dayOfWeek + 6, 23, 59, 59, 999);
    return { start, end };
  }

  if (cadence === "Yearly") {
    return {
      start: new Date(year, 0, 1),
      end: new Date(year, 11, 31, 23, 59, 59, 999),
    };
  }

  return {
    start: new Date(year, month, 1),
    end: new Date(year, month + 1, 0, 23, 59, 59, 999),
  };
}

function inDateRange(date, range) {
  return date >= range.start && date <= range.end;
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDueDate(cadence, now = new Date()) {
  const range = buildDateRange(cadence, now);
  return range.end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatMetricValue(value, unit) {
  const numericValue = Number(value) || 0;
  if (unit === "$") return money(numericValue);
  if (unit === "%") return `${numericValue.toFixed(1)}%`;
  if (unit === "days") return `${Math.round(numericValue)} days`;
  return `${Math.round(numericValue)}`;
}

function getSnapshotBaseline(metricSnapshots, field, cadence, now, fallbackValue) {
  const snapshots = Object.entries(metricSnapshots || {})
    .filter(([, snapshot]) => snapshot && typeof snapshot[field] === "number")
    .sort(([a], [b]) => a.localeCompare(b));

  if (snapshots.length === 0) return Number(fallbackValue) || 0;

  const range = buildDateRange(cadence, now);
  const snapshotAtRangeStart = snapshots.find(([dateKey]) => dateKey >= toDateKey(range.start));
  if (snapshotAtRangeStart) return Number(snapshotAtRangeStart[1][field]) || 0;

  const latestBeforeStart = [...snapshots]
    .reverse()
    .find(([dateKey]) => dateKey < toDateKey(range.start));
  if (latestBeforeStart) return Number(latestBeforeStart[1][field]) || 0;

  return Number(snapshots[0][1][field]) || Number(fallbackValue) || 0;
}

function evaluateObjective(goal, context) {
  const metric = METRIC_LOOKUP[goal.metricKey] || GOAL_METRIC_LIBRARY[0];
  const target = Number(goal.targetValue) || 0;
  const now = context.now;
  const range = buildDateRange(goal.cadence, now);
  const txInRange = context.transactionRows.filter((tx) => inDateRange(tx.date, range));
  const spendInRange = txInRange.reduce((sum, tx) => {
    const amount = Number(tx.amount) || 0;
    return amount < 0 ? sum + Math.abs(amount) : sum;
  }, 0);
  const categorizedRate =
    txInRange.length > 0
      ? (txInRange.filter((tx) => {
          const category = String(tx.category || "").trim().toLowerCase();
          return Boolean(category) && category !== "uncategorized";
        }).length /
          txInRange.length) *
        100
      : 100;

  const dayBuckets = txInRange.reduce((groups, tx) => {
    const key = toDateKey(tx.date);
    groups[key] = (groups[key] || 0) + (Number(tx.amount) || 0);
    return groups;
  }, {});
  const positiveDays = Object.values(dayBuckets).filter((value) => value > 0).length;
  const spendDaySet = new Set(
    txInRange.filter((tx) => (Number(tx.amount) || 0) < 0).map((tx) => toDateKey(tx.date))
  );
  const daySpan = Math.max(
    1,
    Math.floor((startOfDay(range.end).getTime() - startOfDay(range.start).getTime()) / 86_400_000) + 1
  );
  const noSpendDays = daySpan - spendDaySet.size;
  const monthBudget = Number(context.currentMonthSnapshot?.monthlyBudget) || 0;
  const monthSpend = Number(context.currentMonthSnapshot?.monthlySpent) || 0;
  const monthIncome = Number(context.currentMonthIncome) || 0;
  const monthFlow = Number(context.monthlyFlow) || 0;
  const monthlySubscriptionLoad =
    monthIncome > 0 ? (Number(context.activeMonthlySubscriptions) / monthIncome) * 100 : 0;
  const yearlyNetWorthBaseline = getSnapshotBaseline(
    context.metricSnapshots,
    "totalNetWorth",
    "Yearly",
    now,
    context.totalNetWorth
  );
  const yearlyTrueCashBaseline = getSnapshotBaseline(
    context.metricSnapshots,
    "trueCash",
    "Yearly",
    now,
    context.trueCash
  );

  let currentValue = 0;
  if (metric.key === "daily_true_cash_floor") currentValue = Number(context.trueCash) || 0;
  if (metric.key === "daily_review_rate") currentValue = categorizedRate;
  if (metric.key === "weekly_no_spend_days") currentValue = noSpendDays;
  if (metric.key === "weekly_spend_cap") currentValue = spendInRange;
  if (metric.key === "monthly_budget_utilization") {
    currentValue = monthBudget > 0 ? (monthSpend / monthBudget) * 100 : 0;
  }
  if (metric.key === "monthly_income_collected") currentValue = monthIncome;
  if (metric.key === "monthly_cashflow") currentValue = monthFlow;
  if (metric.key === "monthly_positive_days") currentValue = positiveDays;
  if (metric.key === "monthly_subscription_load") currentValue = monthlySubscriptionLoad;
  if (metric.key === "yearly_networth_growth") {
    currentValue = (Number(context.totalNetWorth) || 0) - yearlyNetWorthBaseline;
  }
  if (metric.key === "yearly_true_cash_growth") {
    currentValue = (Number(context.trueCash) || 0) - yearlyTrueCashBaseline;
  }

  const safeTarget = Math.abs(target) > 0 ? Math.abs(target) : 1;
  const direction = metric.direction;
  const achieved = direction === "min" ? currentValue <= target : currentValue >= target;
  const rawProgress =
    direction === "min"
      ? currentValue <= target
        ? 100
        : 100 - ((currentValue - target) / safeTarget) * 100
      : (currentValue / safeTarget) * 100;
  const progress = clampNumber(rawProgress, 0, 140);

  let status = "off_track";
  if (achieved) status = "completed";
  else if (progress >= 75) status = "on_track";
  else if (progress >= 45) status = "at_risk";

  return {
    ...goal,
    metric,
    targetValue: target,
    currentValue,
    progress,
    progressForBar: clampNumber(progress, 0, 100),
    achieved,
    status,
    dueLabel: formatDueDate(goal.cadence, now),
  };
}

function buildAiRecommendations(context, evaluatedObjectives) {
  const existingMetricKeys = new Set(evaluatedObjectives.map((goal) => goal.metricKey));
  const recommendations = [];

  const monthlySpent = Number(context.currentMonthSnapshot?.monthlySpent) || 0;
  const monthlyBudget = Number(context.currentMonthSnapshot?.monthlyBudget) || 0;
  const uncategorizedCount =
    Array.isArray(context.currentMonthSnapshot?.rows) &&
    context.currentMonthSnapshot.rows.some((row) => row.name === "Other")
      ? Number(
          context.currentMonthSnapshot.rows.find((row) => row.name === "Other")?.spent > 0 ? 1 : 0
        )
      : 0;

  if (monthlyBudget > 0 && monthlySpent > monthlyBudget * 0.92) {
    recommendations.push({
      title: "AI: Budget Rescue Sprint",
      reason: "Spending is running hot against this month's budget cap.",
      objective: buildObjectiveFromInput({
        id: `objective-ai-budget-${Date.now()}`,
        title: "Budget Rescue Sprint",
        cadence: "Monthly",
        metricKey: "monthly_budget_utilization",
        targetValue: 88,
        aiSuggested: true,
      }),
    });
  }

  if (Number(context.monthlyFlow) < 0 && !existingMetricKeys.has("monthly_cashflow")) {
    recommendations.push({
      title: "AI: Cashflow Recovery Mission",
      reason: "Net monthly flow is negative. Shift to positive momentum.",
      objective: buildObjectiveFromInput({
        id: `objective-ai-flow-${Date.now()}`,
        title: "Cashflow Recovery Mission",
        cadence: "Monthly",
        metricKey: "monthly_cashflow",
        targetValue: 1200,
        aiSuggested: true,
      }),
    });
  }

  if (uncategorizedCount > 0 && !existingMetricKeys.has("daily_review_rate")) {
    recommendations.push({
      title: "AI: Daily Clarity Protocol",
      reason: "Unmapped spend was detected. Close the loop daily.",
      objective: buildObjectiveFromInput({
        id: `objective-ai-review-${Date.now()}`,
        title: "Daily Clarity Protocol",
        cadence: "Daily",
        metricKey: "daily_review_rate",
        targetValue: 100,
        aiSuggested: true,
      }),
    });
  }

  if (
    Number(context.currentMonthIncome) > 0 &&
    Number(context.activeMonthlySubscriptions) / Number(context.currentMonthIncome) > 0.2 &&
    !existingMetricKeys.has("monthly_subscription_load")
  ) {
    recommendations.push({
      title: "AI: Subscription Defrag",
      reason: "Recurring commitments are consuming more than 20% of monthly income.",
      objective: buildObjectiveFromInput({
        id: `objective-ai-subscriptions-${Date.now()}`,
        title: "Subscription Defrag",
        cadence: "Monthly",
        metricKey: "monthly_subscription_load",
        targetValue: 16,
        aiSuggested: true,
      }),
    });
  }

  return recommendations.slice(0, 3);
}

export function ObjectivesBoard({
  objectives,
  setObjectives,
  transactions,
  subscriptions,
  trueCash,
  totalNetWorth,
  currentMonthSnapshot,
  monthlyFlow,
  metricSnapshots,
  currentMonthIncome,
  householdProfilesProps,
}) {
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const normalizedObjectives = useMemo(
    () => normalizeObjectives(objectives, buildSeedObjectives()),
    [objectives]
  );
  const now = useMemo(() => new Date(), []);
  const activeMonthlySubscriptions = useMemo(
    () =>
      (Array.isArray(subscriptions) ? subscriptions : [])
        .filter((item) => item.status === "Active")
        .reduce((sum, item) => sum + monthlyEquivalent(item.amount, item.frequency), 0),
    [subscriptions]
  );
  const transactionRows = useMemo(
    () =>
      (Array.isArray(transactions) ? transactions : [])
        .map((tx) => ({ ...tx, date: parseGoalDate(tx.date) }))
        .filter((tx) => tx.date),
    [transactions]
  );

  const context = {
    now,
    transactionRows,
    currentMonthSnapshot,
    monthlyFlow,
    metricSnapshots,
    trueCash,
    totalNetWorth,
    currentMonthIncome,
    activeMonthlySubscriptions,
  };

  const evaluatedObjectives = useMemo(
    () => normalizedObjectives.map((goal) => evaluateObjective(goal, context)),
    [normalizedObjectives, context]
  );
  const aiRecommendations = useMemo(
    () => buildAiRecommendations(context, evaluatedObjectives),
    [context, evaluatedObjectives]
  );

  const summary = useMemo(() => {
    const total = evaluatedObjectives.length;
    const completed = evaluatedObjectives.filter((goal) => goal.status === "completed").length;
    const onTrack = evaluatedObjectives.filter((goal) => goal.status === "on_track").length;
    const atRisk = evaluatedObjectives.filter((goal) => goal.status === "at_risk").length;
    const offTrack = evaluatedObjectives.filter((goal) => goal.status === "off_track").length;
    const aiGoals = evaluatedObjectives.filter((goal) => goal.aiSuggested).length;
    const avgProgress =
      total > 0
        ? Math.round(
            evaluatedObjectives.reduce((sum, goal) => sum + goal.progressForBar, 0) / total
          )
        : 0;
    const xp = Math.round(evaluatedObjectives.reduce((sum, goal) => sum + goal.progress, 0));
    return { total, completed, onTrack, atRisk, offTrack, aiGoals, avgProgress, xp };
  }, [evaluatedObjectives]);

  const selectedMetric = METRIC_LOOKUP[form.metricKey] || GOAL_METRIC_LIBRARY[0];

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setIsFormOpen(false);
  };

  const openCreateForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setIsFormOpen(true);
  };

  const openEditForm = (goal) => {
    setForm({
      title: goal.title,
      description: goal.description || "",
      cadence: goal.cadence,
      metricKey: goal.metricKey,
      targetValue: goal.targetValue,
      aiSuggested: Boolean(goal.aiSuggested),
    });
    setEditingId(goal.id);
    setIsFormOpen(true);
  };

  const handleSave = () => {
    if (!form.title.trim()) return;
    const objectivePayload = buildObjectiveFromInput({
      ...form,
      id: editingId || `objective-custom-${Date.now()}`,
      unit: selectedMetric.unit,
      createdAt: editingId
        ? normalizedObjectives.find((goal) => goal.id === editingId)?.createdAt
        : new Date().toISOString(),
      isActive: true,
    });

    setObjectives((current) => {
      const normalizedCurrent = normalizeObjectives(current, buildSeedObjectives());
      if (editingId) {
        return normalizedCurrent.map((goal) => (goal.id === editingId ? objectivePayload : goal));
      }
      return [...normalizedCurrent, objectivePayload];
    });
    resetForm();
  };

  const handleDelete = (goalId) => {
    setObjectives((current) => {
      const normalizedCurrent = normalizeObjectives(current, buildSeedObjectives());
      return normalizedCurrent.filter((goal) => goal.id !== goalId);
    });
    if (editingId === goalId) resetForm();
  };

  const addAiRecommendation = (recommendation) => {
    setObjectives((current) => {
      const normalizedCurrent = normalizeObjectives(current, buildSeedObjectives());
      if (normalizedCurrent.some((goal) => goal.title === recommendation.objective.title)) {
        return normalizedCurrent;
      }
      return [...normalizedCurrent, recommendation.objective];
    });
  };

  return (
    <div>
      <header style={styles.pageHeader}>
        <div>
          <h1 style={styles.pageTitle}>Objectives</h1>
          <p style={styles.pageSubtitle}>
            Turn budget data into missions, streaks, and clear wins you can track automatically.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <HouseholdProfilesControl {...householdProfilesProps} />
          <button
            type="button"
            onClick={openCreateForm}
            style={{
              background: "linear-gradient(90deg,#0077ff,#00d8ff)",
              border: "1px solid rgba(0,216,255,.45)",
              borderRadius: 10,
              color: "white",
              padding: "13px 18px",
              fontWeight: 900,
              cursor: "pointer",
              boxShadow: "0 0 22px rgba(0,136,255,.35)",
            }}
          >
            + Create Objective
          </button>
        </div>
      </header>

      <section
        style={{
          ...styles.panel,
          padding: 20,
          marginBottom: 16,
          background:
            "radial-gradient(circle at top right, rgba(0,216,255,.14), rgba(2,10,26,.95) 40%), linear-gradient(180deg, rgba(2,12,28,.95), rgba(1,8,20,.98))",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
            gap: 10,
          }}
        >
          {[
            ["Total Objectives", summary.total, "#8feaff"],
            ["Completed", summary.completed, "#8f7dff"],
            ["On Track", summary.onTrack, "#00f59b"],
            ["At Risk", summary.atRisk + summary.offTrack, "#ffb65d"],
            ["Average Progress", `${summary.avgProgress}%`, "#00d8ff"],
            ["Mission XP", summary.xp, "#ffd66b"],
          ].map(([label, value, color]) => (
            <div
              key={label}
              style={{
                border: "1px solid rgba(0,216,255,.2)",
                borderRadius: 12,
                padding: "12px 13px",
                background: "rgba(3,18,36,.66)",
              }}
            >
              <div
                style={{
                  color: "#84a8d5",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                }}
              >
                {label}
              </div>
              <div
                style={{
                  color,
                  marginTop: 8,
                  fontSize: 26,
                  fontWeight: 900,
                  textShadow: `0 0 14px ${color}55`,
                }}
              >
                {value}
              </div>
            </div>
          ))}
        </div>
      </section>

      {isFormOpen ? (
        <section style={{ ...styles.panel, padding: 18, marginBottom: 16 }}>
          <div style={{ color: "white", fontWeight: 900, fontSize: 18, marginBottom: 12 }}>
            {editingId ? "Edit Objective" : "Create Objective"}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.1fr 1fr 1fr 1fr",
              gap: 10,
            }}
          >
            <input
              value={form.title}
              onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
              placeholder="Objective title"
              style={{
                color: "#eaf3ff",
                background: "rgba(0,136,255,.08)",
                border: "1px solid rgba(0,216,255,.2)",
                borderRadius: 8,
                padding: "10px 11px",
                fontWeight: 700,
              }}
            />
            <select
              value={form.cadence}
              onChange={(event) => setForm((current) => ({ ...current, cadence: event.target.value }))}
              style={{
                color: "#eaf3ff",
                background: "rgba(0,136,255,.08)",
                border: "1px solid rgba(0,216,255,.2)",
                borderRadius: 8,
                padding: "10px 11px",
                fontWeight: 700,
              }}
            >
              {GOAL_CADENCE_OPTIONS.map((cadence) => (
                <option key={cadence} value={cadence} style={{ background: "#051326", color: "#eaf3ff" }}>
                  {cadence}
                </option>
              ))}
            </select>
            <select
              value={form.metricKey}
              onChange={(event) => {
                const metric = METRIC_LOOKUP[event.target.value] || GOAL_METRIC_LIBRARY[0];
                setForm((current) => ({
                  ...current,
                  metricKey: metric.key,
                  targetValue: metric.defaultTarget,
                }));
              }}
              style={{
                color: "#eaf3ff",
                background: "rgba(0,136,255,.08)",
                border: "1px solid rgba(0,216,255,.2)",
                borderRadius: 8,
                padding: "10px 11px",
                fontWeight: 700,
              }}
            >
              {GOAL_METRIC_LIBRARY.map((metric) => (
                <option key={metric.key} value={metric.key} style={{ background: "#051326", color: "#eaf3ff" }}>
                  {metric.label}
                </option>
              ))}
            </select>
            <input
              type="number"
              value={form.targetValue}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  targetValue: Number(event.target.value),
                }))
              }
              style={{
                color: "#eaf3ff",
                background: "rgba(0,136,255,.08)",
                border: "1px solid rgba(0,216,255,.2)",
                borderRadius: 8,
                padding: "10px 11px",
                fontWeight: 700,
              }}
            />
          </div>
          <textarea
            value={form.description}
            onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
            placeholder="Why this objective matters..."
            rows={2}
            style={{
              marginTop: 10,
              width: "100%",
              color: "#eaf3ff",
              background: "rgba(0,136,255,.08)",
              border: "1px solid rgba(0,216,255,.2)",
              borderRadius: 8,
              padding: "10px 11px",
              fontWeight: 700,
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: "#9ec2eb",
              fontSize: 12,
              marginTop: 8,
            }}
          >
            <input
              type="checkbox"
              checked={form.aiSuggested}
              onChange={(event) =>
                setForm((current) => ({ ...current, aiSuggested: event.target.checked }))
              }
            />
            Mark as AI objective
          </label>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12 }}>
            <div style={{ color: "#8fb1d9", fontSize: 12 }}>
              Auto metric: {selectedMetric.label} ({selectedMetric.unit})
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={resetForm}
                style={{
                  background: "rgba(0,136,255,.12)",
                  border: "1px solid rgba(0,216,255,.22)",
                  borderRadius: 8,
                  color: "#d8ebff",
                  padding: "9px 12px",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                style={{
                  background: "linear-gradient(90deg,#0077ff,#00d8ff)",
                  border: "1px solid rgba(0,216,255,.45)",
                  borderRadius: 8,
                  color: "white",
                  padding: "9px 12px",
                  cursor: "pointer",
                  fontWeight: 800,
                }}
              >
                {editingId ? "Save Objective" : "Add Objective"}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <section style={{ ...styles.panel, padding: 18, marginBottom: 16 }}>
        <div style={{ color: "white", fontWeight: 900, fontSize: 18, marginBottom: 10 }}>
          AI Goal Suggestions
        </div>
        <div style={{ color: "#9fb0c9", fontSize: 13, marginBottom: 12 }}>
          Suggestions adapt to live budget and cash-flow signals.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
          {aiRecommendations.length === 0 ? (
            <div
              style={{
                gridColumn: "1 / -1",
                color: "#8fb1d9",
                fontSize: 13,
                border: "1px solid rgba(0,216,255,.14)",
                borderRadius: 10,
                padding: "11px 12px",
                background: "rgba(0,136,255,.08)",
              }}
            >
              AI does not see urgent new objectives right now. Current objective stack looks healthy.
            </div>
          ) : (
            aiRecommendations.map((recommendation) => (
              <div
                key={recommendation.title}
                style={{
                  border: "1px solid rgba(0,216,255,.2)",
                  borderRadius: 10,
                  padding: "11px 12px",
                  background: "rgba(0,136,255,.08)",
                }}
              >
                <div style={{ color: "#8feaff", fontWeight: 900, fontSize: 13 }}>
                  {recommendation.title}
                </div>
                <div style={{ color: "#9fb0c9", fontSize: 12, marginTop: 6, lineHeight: 1.45 }}>
                  {recommendation.reason}
                </div>
                <button
                  type="button"
                  onClick={() => addAiRecommendation(recommendation)}
                  style={{
                    marginTop: 8,
                    borderRadius: 8,
                    border: "1px solid rgba(0,216,255,.32)",
                    background: "rgba(0,216,255,.14)",
                    color: "#eaf6ff",
                    padding: "8px 10px",
                    cursor: "pointer",
                    fontWeight: 800,
                  }}
                >
                  Add Objective
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      <section
        style={{
          ...styles.panel,
          padding: 16,
          background:
            "radial-gradient(circle at 18% 10%, rgba(0,216,255,.14), rgba(3,12,26,.96) 40%), linear-gradient(180deg, rgba(2,12,28,.97), rgba(1,8,20,.99))",
        }}
      >
        <div style={{ display: "grid", gap: 10 }}>
          {evaluatedObjectives.map((goal) => {
            const theme = STATUS_THEME[goal.status] || STATUS_THEME.off_track;
            return (
              <div
                key={goal.id}
                style={{
                  border: "1px solid rgba(0,216,255,.18)",
                  borderRadius: 12,
                  padding: "12px 14px",
                  background: "rgba(2,15,32,.74)",
                  boxShadow: `0 0 20px ${theme.glow}`,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <div style={{ color: "#f4f9ff", fontSize: 16, fontWeight: 900 }}>{goal.title}</div>
                      <span
                        style={{
                          fontSize: 10,
                          textTransform: "uppercase",
                          letterSpacing: 0.8,
                          color: "#8db0dd",
                          border: "1px solid rgba(0,216,255,.22)",
                          borderRadius: 999,
                          padding: "3px 7px",
                        }}
                      >
                        {goal.cadence}
                      </span>
                      {goal.aiSuggested ? (
                        <span
                          style={{
                            fontSize: 10,
                            textTransform: "uppercase",
                            letterSpacing: 0.8,
                            color: "#8f7dff",
                            border: "1px solid rgba(143,125,255,.32)",
                            borderRadius: 999,
                            padding: "3px 7px",
                          }}
                        >
                          AI
                        </span>
                      ) : null}
                    </div>
                    <div style={{ color: "#9db5d5", fontSize: 12, marginTop: 4, lineHeight: 1.4 }}>
                      {goal.description || goal.metric.description}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      style={{
                        fontSize: 11,
                        color: theme.color,
                        border: `1px solid ${theme.color}66`,
                        borderRadius: 999,
                        padding: "4px 9px",
                        fontWeight: 800,
                      }}
                    >
                      {theme.label}
                    </span>
                    <button
                      type="button"
                      onClick={() => openEditForm(goal)}
                      style={{
                        borderRadius: 7,
                        border: "1px solid rgba(0,216,255,.24)",
                        background: "rgba(0,136,255,.10)",
                        color: "#d9edff",
                        padding: "6px 8px",
                        cursor: "pointer",
                        fontWeight: 700,
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(goal.id)}
                      style={{
                        borderRadius: 7,
                        border: "1px solid rgba(255,93,122,.3)",
                        background: "rgba(255,93,122,.1)",
                        color: "#ffd6df",
                        padding: "6px 8px",
                        cursor: "pointer",
                        fontWeight: 700,
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>

                <div style={{ marginTop: 10 }}>
                  <div
                    style={{
                      height: 10,
                      borderRadius: 999,
                      background: "rgba(20,60,110,.45)",
                      border: "1px solid rgba(0,216,255,.18)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${goal.progressForBar}%`,
                        height: "100%",
                        background: `linear-gradient(90deg, ${theme.color}, #00d8ff)`,
                        boxShadow: `0 0 16px ${theme.glow}`,
                      }}
                    />
                  </div>
                </div>

                <div
                  style={{
                    marginTop: 8,
                    display: "grid",
                    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                    gap: 8,
                    color: "#9db5d5",
                    fontSize: 12,
                  }}
                >
                  <div>
                    <span style={{ color: "#7397c8" }}>Metric</span>
                    <div style={{ color: "#e6f2ff", marginTop: 2 }}>{goal.metric.label}</div>
                  </div>
                  <div>
                    <span style={{ color: "#7397c8" }}>Current</span>
                    <div style={{ color: "#e6f2ff", marginTop: 2 }}>
                      {formatMetricValue(goal.currentValue, goal.metric.unit)}
                    </div>
                  </div>
                  <div>
                    <span style={{ color: "#7397c8" }}>Target</span>
                    <div style={{ color: "#e6f2ff", marginTop: 2 }}>
                      {formatMetricValue(goal.targetValue, goal.metric.unit)}
                    </div>
                  </div>
                  <div>
                    <span style={{ color: "#7397c8" }}>Due</span>
                    <div style={{ color: "#e6f2ff", marginTop: 2 }}>{goal.dueLabel}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
