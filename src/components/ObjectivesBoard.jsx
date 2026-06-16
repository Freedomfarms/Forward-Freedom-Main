import { useMemo, useState } from "react";
import { styles } from "../styles.js";
import { isUncategorizedCategoryName } from "../data/constants.jsx";
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
  completed: { label: "Complete", color: "#8f7dff", glow: "rgba(143,125,255,.45)" },
  on_track: { label: "On Track", color: "#00f59b", glow: "rgba(0,245,155,.4)" },
  at_risk: { label: "At Risk", color: "#ffb65d", glow: "rgba(255,182,93,.4)" },
  off_track: { label: "Needs Focus", color: "#ff5d7a", glow: "rgba(255,93,122,.4)" },
};

function ProgressRing({ progress, color, size = 64, stroke = 6, track = "rgba(120,180,255,.14)", children }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, Number(progress) || 0));
  const dash = (clamped / 100) * circumference;
  const center = size / 2;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)", display: "block" }}>
        <circle cx={center} cy={center} r={radius} fill="none" stroke={track} strokeWidth={stroke} />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          style={{
            filter: `drop-shadow(0 0 5px ${color})`,
            transition: "stroke-dasharray .7s cubic-bezier(.4,0,.2,1)",
          }}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 1,
        }}
      >
        {children}
      </div>
    </div>
  );
}

const METRIC_LOOKUP = Object.fromEntries(
  GOAL_METRIC_LIBRARY.map((metric) => [metric.key, metric])
);

const FIELD_INPUT = {
  color: "#eaf3ff",
  background: "rgba(0,136,255,.08)",
  border: "1px solid rgba(120,180,255,.22)",
  borderRadius: 10,
  padding: "11px 12px",
  fontWeight: 600,
  fontSize: 14,
  width: "100%",
  boxSizing: "border-box",
  outline: "none",
};

const FIELD_CAPTION = {
  color: "#7fa1ca",
  fontSize: 11,
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: 0.7,
};

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
    context.currentMonthSnapshot.rows.some((row) => isUncategorizedCategoryName(row.name))
      ? Number(
          context.currentMonthSnapshot.rows.find((row) => isUncategorizedCategoryName(row.name))
            ?.spent > 0
            ? 1
            : 0
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

  const context = useMemo(
    () => ({
      now,
      transactionRows,
      currentMonthSnapshot,
      monthlyFlow,
      metricSnapshots,
      trueCash,
      totalNetWorth,
      currentMonthIncome,
      activeMonthlySubscriptions,
    }),
    [
      now,
      transactionRows,
      currentMonthSnapshot,
      monthlyFlow,
      metricSnapshots,
      trueCash,
      totalNetWorth,
      currentMonthIncome,
      activeMonthlySubscriptions,
    ]
  );

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
          <h1 style={styles.pageTitle}>Goals</h1>
          <p style={styles.pageSubtitle}>
            The metrics that move your money — tracked automatically, live from your data.
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
              borderRadius: 12,
              color: "white",
              padding: "12px 18px",
              fontWeight: 800,
              fontSize: 14,
              cursor: "pointer",
              boxShadow: "0 8px 22px rgba(0,136,255,.32)",
            }}
          >
            + New Goal
          </button>
        </div>
      </header>

      <section
        style={{
          ...styles.panel,
          padding: 24,
          marginBottom: 16,
          position: "relative",
          overflow: "hidden",
          background:
            "radial-gradient(circle at 85% 0%, rgba(0,216,255,.16), transparent 45%), linear-gradient(180deg, rgba(4,16,34,.95), rgba(1,8,20,.98))",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 30,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <ProgressRing progress={summary.avgProgress} color="#00d8ff" size={128} stroke={11}>
              <div style={{ color: "#eaf6ff", fontSize: 30, fontWeight: 900, lineHeight: 1 }}>
                {summary.avgProgress}%
              </div>
              <div style={{ color: "#7fa1ca", fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>
                Avg
              </div>
            </ProgressRing>
            <div>
              <div style={{ color: "white", fontSize: 20, fontWeight: 900 }}>
                {summary.completed} of {summary.total} hit
              </div>
              <div style={{ color: "#9fb0c9", fontSize: 13, marginTop: 4, maxWidth: 200, lineHeight: 1.45 }}>
                {summary.total === 0
                  ? "Create your first goal to start tracking."
                  : summary.atRisk + summary.offTrack > 0
                    ? `${summary.atRisk + summary.offTrack} goal${summary.atRisk + summary.offTrack === 1 ? "" : "s"} need attention.`
                    : "Everything is trending the right way."}
              </div>
            </div>
          </div>
          <div
            style={{
              flex: 1,
              minWidth: 280,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
              gap: 12,
            }}
          >
            {[
              ["Active", summary.total, "#00d8ff"],
              ["On Track", summary.onTrack, "#00f59b"],
              ["Needs Focus", summary.atRisk + summary.offTrack, "#ffb65d"],
              ["Complete", summary.completed, "#8f7dff"],
            ].map(([label, value, color]) => (
              <div
                key={label}
                style={{
                  border: "1px solid rgba(120,180,255,.16)",
                  borderRadius: 14,
                  padding: "14px 16px",
                  background: "rgba(3,18,36,.55)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: color,
                      boxShadow: `0 0 8px ${color}`,
                    }}
                  />
                  <span style={{ color: "#84a8d5", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.8 }}>
                    {label}
                  </span>
                </div>
                <div style={{ color: "#eaf6ff", fontSize: 28, fontWeight: 900, marginTop: 8 }}>
                  {value}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {isFormOpen ? (
        <section style={{ ...styles.panel, padding: 22, marginBottom: 16 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ color: "white", fontWeight: 900, fontSize: 18 }}>
              {editingId ? "Edit goal" : "New goal"}
            </div>
            <span
              style={{
                ...FIELD_CAPTION,
                color: "#8feaff",
                border: "1px solid rgba(0,216,255,.28)",
                borderRadius: 999,
                padding: "5px 11px",
                background: "rgba(0,216,255,.08)",
              }}
            >
              Tracks {selectedMetric.label}
            </span>
          </div>

          <div style={{ display: "grid", gap: 14 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={FIELD_CAPTION}>Goal name</span>
              <input
                value={form.title}
                onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                placeholder="e.g. Cash shield — never drop below $40k"
                style={FIELD_INPUT}
              />
            </label>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 14,
              }}
            >
              <label style={{ display: "grid", gap: 6 }}>
                <span style={FIELD_CAPTION}>Timeframe</span>
                <select
                  value={form.cadence}
                  onChange={(event) => setForm((current) => ({ ...current, cadence: event.target.value }))}
                  style={FIELD_INPUT}
                >
                  {GOAL_CADENCE_OPTIONS.map((cadence) => (
                    <option key={cadence} value={cadence} style={{ background: "#051326", color: "#eaf3ff" }}>
                      {cadence}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: "grid", gap: 6 }}>
                <span style={FIELD_CAPTION}>Metric</span>
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
                  style={FIELD_INPUT}
                >
                  {GOAL_METRIC_LIBRARY.map((metric) => (
                    <option key={metric.key} value={metric.key} style={{ background: "#051326", color: "#eaf3ff" }}>
                      {metric.label}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: "grid", gap: 6 }}>
                <span style={FIELD_CAPTION}>Target ({selectedMetric.unit})</span>
                <input
                  type="number"
                  value={form.targetValue}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      targetValue: Number(event.target.value),
                    }))
                  }
                  style={FIELD_INPUT}
                />
              </label>
            </div>

            <label style={{ display: "grid", gap: 6 }}>
              <span style={FIELD_CAPTION}>Note (optional)</span>
              <textarea
                value={form.description}
                onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                placeholder="Why this goal matters to you..."
                rows={2}
                style={{ ...FIELD_INPUT, resize: "vertical" }}
              />
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: 8, color: "#9ec2eb", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={form.aiSuggested}
                onChange={(event) =>
                  setForm((current) => ({ ...current, aiSuggested: event.target.checked }))
                }
              />
              Mark as an AI-suggested goal
            </label>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
            <button
              type="button"
              onClick={resetForm}
              style={{
                background: "rgba(0,136,255,.1)",
                border: "1px solid rgba(120,180,255,.22)",
                borderRadius: 10,
                color: "#d8ebff",
                padding: "11px 16px",
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
                borderRadius: 10,
                color: "white",
                padding: "11px 18px",
                cursor: "pointer",
                fontWeight: 800,
                boxShadow: "0 8px 22px rgba(0,136,255,.3)",
              }}
            >
              {editingId ? "Save goal" : "Add goal"}
            </button>
          </div>
        </section>
      ) : null}

      {aiRecommendations.length > 0 ? (
        <section style={{ ...styles.panel, padding: 18, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 15 }}>✨</span>
            <div style={{ color: "white", fontWeight: 800, fontSize: 15 }}>Smart suggestions</div>
            <span style={{ color: "#7fa1ca", fontSize: 12 }}>from your live budget & cash flow</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
            {aiRecommendations.map((recommendation) => (
              <button
                key={recommendation.title}
                type="button"
                onClick={() => addAiRecommendation(recommendation)}
                style={{
                  textAlign: "left",
                  border: "1px solid rgba(143,125,255,.3)",
                  borderRadius: 12,
                  padding: "12px 14px",
                  background: "rgba(143,125,255,.08)",
                  cursor: "pointer",
                  display: "grid",
                  gap: 5,
                }}
              >
                <div style={{ color: "#cbbcff", fontWeight: 800, fontSize: 13 }}>
                  + {recommendation.objective.title}
                </div>
                <div style={{ color: "#9fb0c9", fontSize: 12, lineHeight: 1.45 }}>
                  {recommendation.reason}
                </div>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {evaluatedObjectives.length === 0 ? (
        <section style={{ ...styles.panel, padding: "56px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🎯</div>
          <div style={{ color: "white", fontSize: 20, fontWeight: 900 }}>No goals yet</div>
          <div style={{ color: "#9fb0c9", fontSize: 14, marginTop: 8, maxWidth: 360, marginInline: "auto", lineHeight: 1.5 }}>
            Pick a metric, set a target, and Forward Freedom tracks your progress automatically.
          </div>
          <button
            type="button"
            onClick={openCreateForm}
            style={{
              marginTop: 18,
              background: "linear-gradient(90deg,#0077ff,#00d8ff)",
              border: "1px solid rgba(0,216,255,.45)",
              borderRadius: 12,
              color: "white",
              padding: "12px 18px",
              fontWeight: 800,
              cursor: "pointer",
              boxShadow: "0 8px 22px rgba(0,136,255,.32)",
            }}
          >
            + Create your first goal
          </button>
        </section>
      ) : (
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
            gap: 14,
          }}
        >
          {evaluatedObjectives.map((goal) => {
            const theme = STATUS_THEME[goal.status] || STATUS_THEME.off_track;
            return (
              <div
                key={goal.id}
                style={{
                  position: "relative",
                  border: `1px solid ${theme.color}38`,
                  borderRadius: 16,
                  padding: 18,
                  background:
                    "linear-gradient(180deg, rgba(5,20,40,.92), rgba(2,11,24,.96))",
                  boxShadow: `0 10px 30px rgba(0,8,20,.45), inset 0 0 0 1px rgba(255,255,255,.02)`,
                  display: "grid",
                  gap: 16,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <ProgressRing progress={goal.progressForBar} color={theme.color} size={74} stroke={7}>
                    <div style={{ color: "#eaf6ff", fontSize: 15, fontWeight: 900, lineHeight: 1 }}>
                      {Math.round(goal.progress)}%
                    </div>
                  </ProgressRing>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      title={goal.title}
                      style={{
                        color: "#f4f9ff",
                        fontSize: 16,
                        fontWeight: 800,
                        lineHeight: 1.25,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                      }}
                    >
                      {goal.title}
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 800,
                          textTransform: "uppercase",
                          letterSpacing: 0.6,
                          color: theme.color,
                          border: `1px solid ${theme.color}55`,
                          background: `${theme.color}12`,
                          borderRadius: 999,
                          padding: "3px 8px",
                        }}
                      >
                        {theme.label}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: "uppercase",
                          letterSpacing: 0.6,
                          color: "#8db0dd",
                          border: "1px solid rgba(120,180,255,.2)",
                          borderRadius: 999,
                          padding: "3px 8px",
                        }}
                      >
                        {goal.cadence}
                      </span>
                      {goal.aiSuggested ? (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 800,
                            textTransform: "uppercase",
                            letterSpacing: 0.6,
                            color: "#cbbcff",
                            border: "1px solid rgba(143,125,255,.4)",
                            background: "rgba(143,125,255,.1)",
                            borderRadius: 999,
                            padding: "3px 8px",
                          }}
                        >
                          AI
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <button
                      type="button"
                      aria-label="Edit goal"
                      title="Edit goal"
                      onClick={() => openEditForm(goal)}
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 8,
                        border: "1px solid rgba(120,180,255,.22)",
                        background: "rgba(0,136,255,.1)",
                        color: "#d9edff",
                        cursor: "pointer",
                        fontWeight: 700,
                        lineHeight: 1,
                      }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      aria-label="Delete goal"
                      title="Delete goal"
                      onClick={() => handleDelete(goal.id)}
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 8,
                        border: "1px solid rgba(255,93,122,.3)",
                        background: "rgba(255,93,122,.1)",
                        color: "#ffd6df",
                        cursor: "pointer",
                        fontWeight: 700,
                        lineHeight: 1,
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1fr",
                    gap: 10,
                    paddingTop: 14,
                    borderTop: "1px solid rgba(120,180,255,.12)",
                  }}
                >
                  {[
                    ["Now", formatMetricValue(goal.currentValue, goal.metric.unit), theme.color],
                    ["Target", formatMetricValue(goal.targetValue, goal.metric.unit), "#e6f2ff"],
                    ["Due", goal.dueLabel, "#e6f2ff"],
                  ].map(([label, value]) => (
                    <div key={label} style={{ minWidth: 0 }}>
                      <div style={{ ...FIELD_CAPTION, color: "#6f8fbc" }}>{label}</div>
                      <div
                        style={{
                          color: label === "Now" ? theme.color : "#e6f2ff",
                          fontSize: 15,
                          fontWeight: 800,
                          marginTop: 4,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {value}
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ color: "#7f9bc2", fontSize: 11, marginTop: -4 }}>
                  Tracking: {goal.metric.label}
                </div>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
