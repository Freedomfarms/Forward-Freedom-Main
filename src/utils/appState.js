import {
  APP_TAB_VALUES,
  APP_TABS,
  incomeStreamSeed,
  initialAccounts,
  initialBudgetCategories,
  initialSubscriptions,
  mockTransactions,
} from "../data/constants.jsx";
import { normalizeAccount } from "./accounts.js";

export const APP_STATE_STORAGE_KEY = "fff-app-state-v1";
export const LEGACY_METRIC_SNAPSHOT_STORAGE_KEY = "fff-dashboard-metric-snapshots-v1";

function cloneSeed(value) {
  return JSON.parse(JSON.stringify(value));
}

function readLegacyMetricSnapshots() {
  if (typeof window === "undefined") return {};

  try {
    const stored = window.localStorage.getItem(LEGACY_METRIC_SNAPSHOT_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function buildDefaultAppState() {
  return {
    accounts: cloneSeed(initialAccounts).map((account, index) => normalizeAccount(account, index)),
    transactions: cloneSeed(mockTransactions),
    budgetRows: cloneSeed(initialBudgetCategories),
    incomeStreams: cloneSeed(incomeStreamSeed),
    projectionAdjustments: {},
    subscriptions: cloneSeed(initialSubscriptions),
    activeTab: APP_TABS.DASHBOARD,
    activeRange: "ALL",
    metricSnapshots: {},
  };
}

export function loadPersistedAppState() {
  const defaults = buildDefaultAppState();
  if (typeof window === "undefined") return defaults;

  try {
    const stored = window.localStorage.getItem(APP_STATE_STORAGE_KEY);
    if (!stored) {
      return {
        ...defaults,
        metricSnapshots: readLegacyMetricSnapshots(),
      };
    }

    const parsed = JSON.parse(stored);
    return {
      accounts: Array.isArray(parsed?.accounts)
        ? parsed.accounts.map((account, index) => normalizeAccount(account, index))
        : defaults.accounts,
      transactions: Array.isArray(parsed?.transactions)
        ? parsed.transactions
        : defaults.transactions,
      budgetRows: Array.isArray(parsed?.budgetRows) ? parsed.budgetRows : defaults.budgetRows,
      incomeStreams: Array.isArray(parsed?.incomeStreams)
        ? parsed.incomeStreams
        : defaults.incomeStreams,
      projectionAdjustments:
        parsed?.projectionAdjustments && typeof parsed.projectionAdjustments === "object"
          ? parsed.projectionAdjustments
          : defaults.projectionAdjustments,
      subscriptions: Array.isArray(parsed?.subscriptions)
        ? parsed.subscriptions
        : defaults.subscriptions,
      activeTab:
        typeof parsed?.activeTab === "string" && APP_TAB_VALUES.includes(parsed.activeTab)
          ? parsed.activeTab
          : defaults.activeTab,
      activeRange:
        typeof parsed?.activeRange === "string" ? parsed.activeRange : defaults.activeRange,
      metricSnapshots:
        parsed?.metricSnapshots && typeof parsed.metricSnapshots === "object"
          ? parsed.metricSnapshots
          : readLegacyMetricSnapshots(),
    };
  } catch {
    return {
      ...defaults,
      metricSnapshots: readLegacyMetricSnapshots(),
    };
  }
}

export function persistAppState(state) {
  if (typeof window === "undefined") return;

  const payload = {
    accounts: state.accounts,
    transactions: state.transactions,
    budgetRows: state.budgetRows,
    incomeStreams: state.incomeStreams,
    projectionAdjustments: state.projectionAdjustments,
    subscriptions: state.subscriptions,
    activeTab: state.activeTab,
    activeRange: state.activeRange,
    metricSnapshots: state.metricSnapshots,
  };

  window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(payload));
}
