import { getCurrentTimestamp } from "./date.js";

const DEFAULT_INCLUDE_CATEGORIES = [];
const DEFAULT_EXCLUDE_CATEGORIES = ["Income", "Transfers"];

export const DEFAULT_RECURRING_PREFERENCES = Object.freeze({
  autoDetectEnabled: true,
  includeCategories: DEFAULT_INCLUDE_CATEGORIES,
  excludeCategories: DEFAULT_EXCLUDE_CATEGORIES,
  dismissedSuggestionKeys: [],
});

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeList(values, fallback = []) {
  const source = Array.isArray(values) ? values : fallback;
  return [...new Set(source.map((value) => String(value || "").trim()).filter(Boolean))];
}

function parseTransactionDate(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [year, month, day] = String(value).split("-").map(Number);
    const parsed = new Date(year, month - 1, day);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dayDifference(later, earlier) {
  const deltaMs = later.getTime() - earlier.getTime();
  return Math.abs(deltaMs / (1000 * 60 * 60 * 24));
}

function detectFrequencyFromHistory(groupedTransactions) {
  if (groupedTransactions.length < 2) return null;
  const sorted = [...groupedTransactions]
    .map((transaction) => parseTransactionDate(transaction.date))
    .filter(Boolean)
    .sort((a, b) => b - a);
  if (sorted.length < 2) return null;

  const intervals = [];
  for (let index = 1; index < sorted.length; index += 1) {
    intervals.push(dayDifference(sorted[index - 1], sorted[index]));
    if (intervals.length >= 3) break;
  }
  if (intervals.length === 0) return null;

  const averageInterval = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  if (averageInterval >= 320) return "Annual";
  if (averageInterval >= 70 && averageInterval <= 115) return "Quarterly";
  if (averageInterval >= 20 && averageInterval <= 40) return "Monthly";
  if (averageInterval >= 5 && averageInterval <= 10) return "Weekly";
  return null;
}

function inferIcon(category) {
  const normalizedCategory = normalizeToken(category);
  if (normalizedCategory.includes("hous") || normalizedCategory.includes("mortgage")) return "🏠";
  if (normalizedCategory.includes("util") || normalizedCategory.includes("phone")) return "📱";
  if (normalizedCategory.includes("insur")) return "🛡️";
  if (normalizedCategory.includes("stream") || normalizedCategory.includes("subscription")) return "🎬";
  if (normalizedCategory.includes("health")) return "⚕️";
  return "💳";
}

function buildSuggestionKey(transaction) {
  const absoluteAmount = Math.abs(Number(transaction?.amount) || 0);
  return [
    normalizeToken(transaction?.merchant),
    Number.isFinite(absoluteAmount) ? absoluteAmount.toFixed(2) : "",
  ].join("|");
}

function buildExistingSubscriptionKey(subscription) {
  return `${normalizeToken(subscription?.name)}|${normalizeToken(subscription?.account)}`;
}

function parseBillingDay(dateValue) {
  const parsed = parseTransactionDate(dateValue);
  return parsed ? parsed.getDate() : 1;
}

export function normalizeRecurringPreferences(value) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    autoDetectEnabled: true,
    // Auto-detect now scans all expense categories by default.
    includeCategories: [],
    excludeCategories: normalizeList(
      raw.excludeCategories,
      DEFAULT_RECURRING_PREFERENCES.excludeCategories
    ),
    dismissedSuggestionKeys: normalizeList(raw.dismissedSuggestionKeys, []),
  };
}

export function buildRecurringSubscriptionFromTransaction(transaction, options = {}) {
  const amount = Math.abs(Number(transaction?.amount) || 0);
  if (!amount) return null;

  const merchant = String(transaction?.merchant || "").trim();
  const fallbackName = String(transaction?.category || "Recurring Expense").trim();
  return {
    id: `sub-custom-${Date.now()}`,
    name: merchant || fallbackName,
    amount: Number(amount.toFixed(2)),
    frequency: options.frequency || transaction?.frequency || "Monthly",
    category: String(transaction?.category || "Other").trim() || "Other",
    billing: Math.max(1, Math.min(31, Number(options.billing || parseBillingDay(transaction?.date)) || 1)),
    account: String(transaction?.account || "").trim(),
    icon: options.icon || inferIcon(transaction?.category),
    status: options.status || "Active",
    sourceTransactionId: transaction?.id || null,
    suggestionKey: options.suggestionKey || null,
    createdAt: getCurrentTimestamp(),
  };
}

export function buildRecurringSuggestions(transactions, subscriptions, recurringPreferences) {
  const normalizedPreferences = normalizeRecurringPreferences(recurringPreferences);
  if (!normalizedPreferences.autoDetectEnabled) return [];

  const excludeCategorySet = new Set(
    normalizedPreferences.excludeCategories.map((category) => normalizeToken(category))
  );
  const dismissedKeys = new Set(
    normalizedPreferences.dismissedSuggestionKeys.map((key) => normalizeToken(key))
  );
  const existingSubscriptionKeys = new Set(
    (Array.isArray(subscriptions) ? subscriptions : [])
      .filter((subscription) => !subscription?.autoDetected && subscription?.status !== "Cancelled")
      .map(buildExistingSubscriptionKey)
  );

  const grouped = new Map();
  (Array.isArray(transactions) ? transactions : [])
    .filter((transaction) => Number(transaction?.amount) < 0)
    .forEach((transaction) => {
      const categoryToken = normalizeToken(transaction?.category);
      if (excludeCategorySet.has(categoryToken)) return;
      const key = buildSuggestionKey(transaction);
      if (!key.replace(/\|/g, "")) return;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(transaction);
    });

  const suggestions = [];
  grouped.forEach((rows, suggestionKey) => {
    if (!rows.length || dismissedKeys.has(normalizeToken(suggestionKey))) return;
    if (rows.length < 2) return;
    const sorted = [...rows].sort((a, b) => {
      const dateA = parseTransactionDate(a.date)?.getTime() || 0;
      const dateB = parseTransactionDate(b.date)?.getTime() || 0;
      return dateB - dateA;
    });
    const latest = sorted[0];
    const detectedFrequency = detectFrequencyFromHistory(sorted);
    if (!detectedFrequency) return;

    const sample = sorted.slice(0, 3);
    const averageAmount =
      sample.reduce((sum, row) => sum + Math.abs(Number(row.amount) || 0), 0) / sample.length;
    const name = String(latest.merchant || latest.category || "Recurring Expense").trim();
    const account = String(latest.account || "").trim();
    const existingKey = `${normalizeToken(name)}|${normalizeToken(account)}`;
    if (existingSubscriptionKeys.has(existingKey)) return;

    suggestions.push({
      id: `suggested-${suggestionKey}`,
      suggestionKey,
      reason: "Recurring candidate detected from repeated same-amount merchant charges.",
      txCount: sorted.length,
      merchant: latest.merchant,
      account: latest.account,
      category: latest.category,
      date: latest.date,
      amount: Number(averageAmount.toFixed(2)),
      frequency: detectedFrequency || "Monthly",
      billing: parseBillingDay(latest.date),
      icon: inferIcon(latest.category),
    });
  });

  return suggestions
    .sort((a, b) => {
      if (b.txCount !== a.txCount) return b.txCount - a.txCount;
      return b.amount - a.amount;
    })
    .slice(0, 120);
}
