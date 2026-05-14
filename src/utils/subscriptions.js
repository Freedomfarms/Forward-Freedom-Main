import { budgetMonthNames, budgetMonths } from "../data/constants.jsx";

export const SUBSCRIPTION_FREQUENCIES = ["Monthly", "Annual", "Quarterly", "Weekly"];
export const SUBSCRIPTION_STATUSES = ["Active", "Paused", "Cancelled"];

export function monthlyEquivalent(amount, frequency) {
  const numericAmount = Number(amount) || 0;
  if (frequency === "Annual") return numericAmount / 12;
  if (frequency === "Quarterly") return numericAmount / 3;
  if (frequency === "Weekly") return numericAmount * (52 / 12);
  return numericAmount;
}

export function nextBillingDate(billingDay, frequency = "Monthly", fromDate = new Date()) {
  const safeBillingDay = Math.max(1, Math.min(31, Number(billingDay) || 1));
  const nextDate = new Date(fromDate);

  if (frequency === "Weekly") {
    nextDate.setDate(fromDate.getDate() + 7);
    return nextDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  if (fromDate.getDate() > safeBillingDay) {
    const monthStep = frequency === "Quarterly" ? 3 : frequency === "Annual" ? 12 : 1;
    nextDate.setMonth(nextDate.getMonth() + monthStep);
  }

  nextDate.setDate(safeBillingDay);
  return nextDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function buildSubscriptionMonthlySeries(subscriptions) {
  return budgetMonths.map((month) => {
    const total = subscriptions
      .filter((subscription) => subscription.status === "Active")
      .reduce(
        (sum, subscription) => sum + monthlyEquivalent(subscription.amount, subscription.frequency),
        0
      );

    return {
      month,
      label: budgetMonthNames[month],
      total,
    };
  });
}

export function buildSubscriptionOverview(subscriptions) {
  const activeSubscriptions = subscriptions.filter(
    (subscription) => subscription.status === "Active"
  );
  const activeMonthly = activeSubscriptions.reduce(
    (sum, subscription) => sum + monthlyEquivalent(subscription.amount, subscription.frequency),
    0
  );
  const byAccount = activeSubscriptions.reduce((groups, subscription) => {
    const account = subscription.account || "Unassigned";
    groups[account] =
      (groups[account] || 0) + monthlyEquivalent(subscription.amount, subscription.frequency);
    return groups;
  }, {});

  const topAccounts = Object.entries(byAccount)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([account, total]) => ({ account, total }));

  const upcoming = activeSubscriptions
    .map((subscription) => ({
      ...subscription,
      nextBillLabel: nextBillingDate(subscription.billing, subscription.frequency),
    }))
    .slice(0, 4);

  return {
    activeCount: activeSubscriptions.length,
    activeMonthly,
    yearlyCommitment: activeMonthly * 12,
    topAccounts,
    upcoming,
  };
}
