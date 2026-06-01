export const GOAL_CADENCE_OPTIONS = ["Daily", "Weekly", "Monthly", "Yearly"];

export const GOAL_METRIC_LIBRARY = [
  {
    key: "daily_true_cash_floor",
    label: "Daily True Cash Floor",
    unit: "$",
    direction: "max",
    defaultTarget: 40000,
    description: "Keep true cash above a minimum floor each day.",
  },
  {
    key: "daily_review_rate",
    label: "Daily Transaction Review",
    unit: "%",
    direction: "max",
    defaultTarget: 100,
    description: "Keep each day's transactions categorized and reviewed.",
  },
  {
    key: "weekly_no_spend_days",
    label: "Weekly No-Spend Days",
    unit: "days",
    direction: "max",
    defaultTarget: 3,
    description: "Hit focused no-spend days every week.",
  },
  {
    key: "weekly_spend_cap",
    label: "Weekly Spend Cap",
    unit: "$",
    direction: "min",
    defaultTarget: 1250,
    description: "Stay under a weekly discretionary spend cap.",
  },
  {
    key: "monthly_budget_utilization",
    label: "Monthly Budget Utilization",
    unit: "%",
    direction: "min",
    defaultTarget: 90,
    description: "Keep monthly spend under a percentage of budget.",
  },
  {
    key: "monthly_income_collected",
    label: "Monthly Income Collected",
    unit: "$",
    direction: "max",
    defaultTarget: 10000,
    description: "Collect planned monthly income deposits.",
  },
  {
    key: "monthly_cashflow",
    label: "Monthly Net Cash Flow",
    unit: "$",
    direction: "max",
    defaultTarget: 1800,
    description: "Maintain positive monthly cash flow.",
  },
  {
    key: "monthly_positive_days",
    label: "Monthly Positive Cashflow Days",
    unit: "days",
    direction: "max",
    defaultTarget: 15,
    description: "Maximize days where daily net flow is positive.",
  },
  {
    key: "monthly_subscription_load",
    label: "Subscription Load",
    unit: "%",
    direction: "min",
    defaultTarget: 18,
    description: "Keep active recurring load below income threshold.",
  },
  {
    key: "yearly_networth_growth",
    label: "Yearly Net Worth Growth",
    unit: "$",
    direction: "max",
    defaultTarget: 12000,
    description: "Grow total net worth across the year.",
  },
  {
    key: "yearly_true_cash_growth",
    label: "Yearly True Cash Growth",
    unit: "$",
    direction: "max",
    defaultTarget: 9000,
    description: "Grow true cash across the year.",
  },
];

function metricDefault(metricKey) {
  return (
    GOAL_METRIC_LIBRARY.find((metric) => metric.key === metricKey) || GOAL_METRIC_LIBRARY[0]
  );
}

function buildGoal(seed, index) {
  const metric = metricDefault(seed.metricKey);
  return {
    id: seed.id || `objective-seed-${index + 1}`,
    title: seed.title,
    description: seed.description || metric.description,
    cadence: seed.cadence || "Monthly",
    metricKey: metric.key,
    unit: seed.unit || metric.unit,
    targetValue: Number(seed.targetValue ?? metric.defaultTarget) || 0,
    aiSuggested: Boolean(seed.aiSuggested),
    isActive: seed.isActive !== false,
    createdAt: seed.createdAt || new Date().toISOString(),
  };
}

export function buildSeedObjectives() {
  return [
    {
      id: "objective-01",
      title: "Cash Shield: Never Drop Below $40K",
      cadence: "Daily",
      metricKey: "daily_true_cash_floor",
      targetValue: 40000,
      aiSuggested: true,
    },
    {
      id: "objective-02",
      title: "Zero-Confusion Ledger",
      cadence: "Daily",
      metricKey: "daily_review_rate",
      targetValue: 100,
      aiSuggested: true,
    },
    {
      id: "objective-03",
      title: "No-Spend Streak",
      cadence: "Weekly",
      metricKey: "weekly_no_spend_days",
      targetValue: 3,
      aiSuggested: false,
    },
    {
      id: "objective-04",
      title: "Weekly Spend Guardrail",
      cadence: "Weekly",
      metricKey: "weekly_spend_cap",
      targetValue: 1250,
      aiSuggested: false,
    },
    {
      id: "objective-05",
      title: "Budget Precision Run",
      cadence: "Monthly",
      metricKey: "monthly_budget_utilization",
      targetValue: 90,
      aiSuggested: true,
    },
    {
      id: "objective-06",
      title: "Income Capture Mission",
      cadence: "Monthly",
      metricKey: "monthly_income_collected",
      targetValue: 10000,
      aiSuggested: false,
    },
    {
      id: "objective-07",
      title: "Positive Cashflow Champion",
      cadence: "Monthly",
      metricKey: "monthly_cashflow",
      targetValue: 1800,
      aiSuggested: false,
    },
    {
      id: "objective-08",
      title: "Momentum Days",
      cadence: "Monthly",
      metricKey: "monthly_positive_days",
      targetValue: 15,
      aiSuggested: false,
    },
    {
      id: "objective-09",
      title: "Lean Subscription Stack",
      cadence: "Monthly",
      metricKey: "monthly_subscription_load",
      targetValue: 18,
      aiSuggested: true,
    },
    {
      id: "objective-10",
      title: "Net Worth Boss Level",
      cadence: "Yearly",
      metricKey: "yearly_networth_growth",
      targetValue: 12000,
      aiSuggested: true,
    },
  ].map(buildGoal);
}

export function normalizeObjectives(rawObjectives, fallbackObjectives = buildSeedObjectives()) {
  if (!Array.isArray(rawObjectives)) {
    return fallbackObjectives.map((goal, index) => buildGoal(goal, index));
  }

  return rawObjectives.map((goal, index) => buildGoal(goal || {}, index));
}

export function buildObjectiveFromInput(input) {
  const metric = metricDefault(input.metricKey);
  return buildGoal(
    {
      ...input,
      metricKey: metric.key,
      cadence: GOAL_CADENCE_OPTIONS.includes(input.cadence) ? input.cadence : "Monthly",
      unit: input.unit || metric.unit,
      targetValue: Number(input.targetValue ?? metric.defaultTarget) || metric.defaultTarget,
    },
    0
  );
}
